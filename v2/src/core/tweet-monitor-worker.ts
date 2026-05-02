import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { AppConfig, ScreenshotService, Storage, TelegramClient, TelegramMediaItem, Tweet, TwitterClient, WatchTarget } from '../types';
import { rootLogger } from '../runtime/logger';
import { escapeHtml } from '../utils/html';
import { ensureFileDir, sanitizeFilename } from '../utils/files';
import { sleep, randomSleep } from '../utils/async';
import { getTopicId } from '../services/topic-routing';

function getTimestamp(dateStr: string): string {
  return new Date(dateStr).toISOString().replace(/[^0-9]/g, '').substring(2, 14);
}

function truncateForFilename(text: string): string {
  return sanitizeFilename(
    text
      .replace(/\n/g, ' ')
      .replace(/https?:\/\/\S+/g, '')
      .trim()
      .substring(0, 50),
    'tweet'
  );
}

export class TweetMonitorWorker {
  private readonly logger = rootLogger.child('tweet-worker');

  private readonly mediaHttp = axios.create();

  private timer: NodeJS.Timeout | null = null;

  private running = false;

  private trackedUsernames: string[] = [];

  private consecutiveErrors = 0;

  private static readonly MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

  private static readonly CONCURRENCY_LIMIT = 3;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly twitterClient: TwitterClient,
    private readonly telegramClient: TelegramClient,
    private readonly screenshotService: ScreenshotService
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.schedule(this.config.tweetBootstrapDelayMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): { trackedUsernames: string[]; replyUsers: number } {
    const targets = this.storage.getWatchTargets().filter((target) => target.watchTweets);
    return {
      trackedUsernames: [...this.trackedUsernames],
      replyUsers: targets.filter((target) => target.watchReplies).length,
    };
  }

  async pollOnce(): Promise<void> {
    if (!this.running) {
      return;
    }

    const targets = this.storage.getWatchTargets().filter((target) => target.watchTweets);
    this.trackedUsernames = targets.map((target) => target.username);

    if (!targets.length) {
      this.schedule(this.config.watchlistReloadIntervalMs);
      return;
    }

    let hadError = false;

    // Process users concurrently with a limit
    const queue = [...targets];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(TweetMonitorWorker.CONCURRENCY_LIMIT, queue.length); i += 1) {
      workers.push(this.processQueue(queue));
    }
    const results = await Promise.allSettled(workers);
    for (const result of results) {
      if (result.status === 'rejected') {
        hadError = true;
      }
    }

    // Exponential backoff on errors
    if (hadError) {
      this.consecutiveErrors += 1;
      const backoff = Math.min(
        this.config.tweetPollIntervalsMs[1] * Math.pow(2, this.consecutiveErrors - 1),
        TweetMonitorWorker.MAX_BACKOFF_MS
      );
      this.logger.warn('Backing off due to errors', {
        consecutiveErrors: this.consecutiveErrors,
        nextPollMs: backoff,
      });
      this.schedule(backoff);
      return;
    }

    this.consecutiveErrors = 0;
    const minMs = Math.min(...this.config.tweetPollIntervalsMs);
    const maxMs = Math.max(...this.config.tweetPollIntervalsMs);
    const interval = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    this.schedule(interval);
  }

  private async processQueue(queue: WatchTarget[]): Promise<void> {
    while (this.running) {
      const target = queue.shift();
      if (!target) {
        return;
      }
      try {
        if (process.env.DEBUG === 'true' || process.stdout.isTTY) {
          this.logger.info(`Polling tweets for @${target.username}...`);
        }
        await this.checkUserTweets(target);
      } catch (error) {
        this.logger.error('Tweet poll failed for user', {
          username: target.username,
          message: (error as Error).message,
        });
        throw error; // Signal to pollOnce that an error occurred
      }
    }
  }

  private schedule(ms: number): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.pollOnce().catch((error) => {
        this.logger.error('Tweet worker loop crashed', { message: (error as Error).message });
        this.schedule(this.config.watchlistReloadIntervalMs);
      });
    }, ms);
  }


  private async checkUserTweets(target: WatchTarget): Promise<void> {
    let userIdToUse = target.userId;
    if (this.config.dataSource === 'nitter') {
      userIdToUse = target.username;
    } else {
      if (!userIdToUse) {
        userIdToUse = await this.twitterClient.resolveUserId(target.username);
        if (!userIdToUse) {
          return;
        }
        this.storage.upsertWatchTarget({
          username: target.username,
          userId: userIdToUse,
        });
        target = this.storage.getWatchTarget(target.username)!;
      }
    }

    const tweets = target.watchReplies
      ? await this.twitterClient.getUserTweetsAndReplies(userIdToUse)
      : await this.twitterClient.getUserTweets(userIdToUse);

    if (!tweets.length) {
      return;
    }

    // Auto-heal username changes if using Twitter API
    if (this.config.dataSource !== 'nitter' && userIdToUse) {
      const authoredTweet = tweets.find(t => t.authorId === userIdToUse);
      if (authoredTweet && authoredTweet.author?.username && authoredTweet.author.username.toLowerCase() !== target.username.toLowerCase()) {
        const newUsername = authoredTweet.author.username;
        this.logger.info('Detected username change, updating target', {
          oldUsername: target.username,
          newUsername,
          userId: userIdToUse
        });
        
        if (this.storage.renameWatchTarget(target.username, newUsername)) {
          const oldUsername = target.username;
          target = this.storage.getWatchTarget(newUsername) || target;
          
          const index = this.trackedUsernames.indexOf(oldUsername);
          if (index !== -1) {
            this.trackedUsernames[index] = newUsername;
          }
        }
      }
    }

    const seenIds = new Set(this.storage.getSeenTweetIds(target.username));
    if (!seenIds.size) {
      this.storage.markTweetsSeen(
        target.username,
        tweets.filter((tweet) => !tweet.isRetweet).map((tweet) => tweet.id)
      );
      this.logger.info('Initialized seen tweets for user', {
        username: target.username,
        count: tweets.length,
      });
      return;
    }

    const newTweets = tweets.filter((tweet) => !seenIds.has(tweet.id) && !tweet.isRetweet);
    if (!newTweets.length) {
      return;
    }

    this.storage.markTweetsSeen(
      target.username,
      newTweets.map((tweet) => tweet.id)
    );

    const threadConversations: Record<string, Tweet[]> = {};
    const standaloneTweets: Tweet[] = [];

    for (const tweet of newTweets) {
      if (tweet.isThread) {
        const conversationId = tweet.conversationId;
        if (!threadConversations[conversationId]) {
          threadConversations[conversationId] = [];
        }
        threadConversations[conversationId].push(tweet);
      } else {
        standaloneTweets.push(tweet);
      }
    }

    for (const tweet of standaloneTweets) {
      await this.enrichWithParentTweet(tweet);
      await this.processNewTweet(tweet, target);
      await randomSleep(3000, 6000);
    }

    for (const threadTweets of Object.values(threadConversations)) {
      const sorted = [...threadTweets].sort((left, right) => {
        const diff = BigInt(left.id) - BigInt(right.id);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      });

      if (sorted.length >= 2) {
        for (let i = 0; i < sorted.length; i++) {
          if (i > 0 && sorted[i].inReplyToStatusId === sorted[i - 1].id) {
            sorted[i].inReplyToTweet = sorted[i - 1];
          } else {
            await this.enrichWithParentTweet(sorted[i]);
          }
        }
        await this.processThread(sorted, target);
        await randomSleep(5000, 10000);
      } else {
        await this.enrichWithParentTweet(sorted[0]);
        await this.processNewTweet(sorted[0], target);
        await randomSleep(3000, 6000);
      }
    }
  }

  private async enrichWithParentTweet(tweet: Tweet): Promise<void> {
    if (!tweet.inReplyToStatusId && !tweet.inReplyToTweet) return;
    
    if (tweet.inReplyToStatusId === 'fetch_me') {
      const detail = await this.twitterClient.getTweetById(tweet.id);
      if (detail && detail.inReplyToStatusId && detail.inReplyToStatusId !== 'fetch_me') {
        tweet.inReplyToStatusId = detail.inReplyToStatusId;
        // Also pick up the parent username if available from the detail
        if (!tweet.inReplyToUsername && detail.inReplyToUsername) {
          tweet.inReplyToUsername = detail.inReplyToUsername;
        }
      } else {
        tweet.inReplyToStatusId = null;
      }
    }

    if (tweet.inReplyToStatusId) {
      const parentTweet = await this.twitterClient.getTweetById(tweet.inReplyToStatusId);
      if (parentTweet) {
        // TweetDetail sometimes returns empty author data — patch from what we know
        if (!parentTweet.author.username && tweet.inReplyToUsername) {
          parentTweet.author.username = tweet.inReplyToUsername;
        }
        tweet.inReplyToTweet = parentTweet;
      }
    }
  }

  private saveTweet(tweet: Tweet, username: string): { jsonPath: string; dir: string; baseName: string } {
    const dir = path.join(this.config.downloadRoot, username, 'tweets');
    const baseName = `[${username}][${getTimestamp(tweet.createdAt)}] ${truncateForFilename(tweet.text)}`;
    const jsonPath = path.join(dir, `${baseName}.json`);
    ensureFileDir(jsonPath);
    fs.writeFileSync(jsonPath, JSON.stringify(tweet, null, 2), 'utf8');
    return { jsonPath, dir, baseName };
  }

  private saveThread(tweets: Tweet[], username: string): { jsonPath: string; dir: string; baseName: string } {
    const dir = path.join(this.config.downloadRoot, username, 'tweets');
    const baseName = `[${username}][${getTimestamp(tweets[0].createdAt)}] THREAD - ${truncateForFilename(tweets[0].text)}`;
    const jsonPath = path.join(dir, `${baseName}.json`);
    ensureFileDir(jsonPath);
    fs.writeFileSync(jsonPath, JSON.stringify({ thread: tweets, count: tweets.length }, null, 2), 'utf8');
    return { jsonPath, dir, baseName };
  }

  private async downloadMedia(url: string, outputPath: string): Promise<string | null> {
    try {
      ensureFileDir(outputPath);
      const response = await this.mediaHttp.get(url, {
        responseType: 'stream',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      await new Promise<void>((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      return outputPath;
    } catch (error) {
      this.logger.warn('Media download failed', { url, message: (error as Error).message });
      return null;
    }
  }

  private async downloadTweetMedia(tweet: Tweet, dir: string, baseName: string): Promise<TelegramMediaItem[]> {
    const downloadedMedia: TelegramMediaItem[] = [];

    const allMedia = [...(tweet.media || [])];
    if (tweet.quotedTweet && tweet.quotedTweet.media) {
      allMedia.push(...tweet.quotedTweet.media);
    }

    for (let index = 0; index < allMedia.length; index += 1) {
      const item = allMedia[index];
      let extension = '.jpg';
      let mediaUrl = item.url;

      if (item.type === 'video' || item.type === 'animated_gif') {
        extension = '.mp4';
      } else if (item.type === 'photo') {
        const normalized = item.url.replace(/\?.*$/, '');
        mediaUrl = `${normalized}?format=jpg&name=orig`;
      }

      const filePath = path.join(dir, `${baseName}_media${index + 1}${extension}`);
      const saved = await this.downloadMedia(mediaUrl, filePath);
      if (saved) {
        downloadedMedia.push({
          type: item.type === 'video' || item.type === 'animated_gif' ? 'video' : 'photo',
          path: saved,
        });
      }
    }

    return downloadedMedia;
  }

  private autoDeleteFiles(filePaths: string[], uploadSuccess: boolean): void {
    if (!uploadSuccess || !this.config.autoDeleteUploaded) {
      return;
    }

    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true });
        }
      } catch (error) {
        this.logger.warn('Auto-delete failed', { filePath, message: (error as Error).message });
      }
    }
  }

  private async processNewTweet(tweet: Tweet, target: WatchTarget): Promise<void> {
    // Save metadata JSON to disk (if enabled)
    let jsonPath: string | null = null;
    let dir: string;
    let baseName: string;

    if (target.saveMetadata) {
      const saved = this.saveTweet(tweet, target.username);
      jsonPath = saved.jsonPath;
      dir = saved.dir;
      baseName = saved.baseName;
    } else {
      // Still need dir/baseName for media and screenshots
      dir = path.join(this.config.downloadRoot, target.username, 'tweets');
      baseName = `[${target.username}][${getTimestamp(tweet.createdAt)}] ${truncateForFilename(tweet.text)}`;
    }

    // Download media (if enabled)
    const media = target.saveMedia ? await this.downloadTweetMedia(tweet, dir, baseName) : [];

    // Capture screenshot (if enabled)
    let screenshotResult: string | null = null;
    if (target.saveScreenshots) {
      const screenshotPath = path.join(dir, `${baseName}.jpg`);

      // Detect if this is a reply made BY the watched user
      const isReplyByWatchedUser = !!(tweet.inReplyToUsername && tweet.author.username === target.username);
      if (isReplyByWatchedUser) {
        this.logger.info('Tweet is a reply by the watched user, will capture full conversation', {
          username: target.username,
          inReplyTo: tweet.inReplyToUsername,
        });
      }

      screenshotResult = await this.screenshotService.captureTweet(target.username, tweet.id, screenshotPath, isReplyByWatchedUser);

      // Fallback: if the screenshot timed out but the file was written to disk, use it
      if (!screenshotResult && fs.existsSync(screenshotPath)) {
        const stat = fs.statSync(screenshotPath);
        if (stat.size > 0) {
          this.logger.info('Screenshot timed out but file exists on disk, using it', { screenshotPath, size: stat.size });
          screenshotResult = screenshotPath;
        }
      }
    }

    const isReplyByWatchedUser = !!(tweet.inReplyToUsername && tweet.author.username === target.username);

    const textPreview = escapeHtml(
      `${tweet.text.substring(0, 300)}${tweet.text.length > 300 ? '...' : ''}`
    );
    const message =
      `<b>New Tweet</b>\n\n` +
      `From: @${escapeHtml(tweet.author.username || target.username)}\n` +
      `<blockquote>${textPreview}</blockquote>\n` +
      `Likes: ${tweet.metrics.likes}  Retweets: ${tweet.metrics.retweets}\n` +
      `Link: https://x.com/${target.username}/status/${tweet.id}`;

    const topicId = getTopicId(this.config, target, 'tweet');
    // When isReplyByWatchedUser is true, the main screenshot already includes the
    // full conversation (parent tweets + reply), so skip the separate parent screenshot.
    let parentScreenshotResult: string | null = null;
    if (target.saveScreenshots && tweet.inReplyToTweet && !isReplyByWatchedUser) {
      const parentScreenshotPath = path.join(dir, `${baseName}_parent.jpg`);
      parentScreenshotResult = await this.screenshotService.captureTweet(
        tweet.inReplyToTweet.author.username || target.username, 
        tweet.inReplyToTweet.id, 
        parentScreenshotPath
      );
      if (!parentScreenshotResult && fs.existsSync(parentScreenshotPath)) {
        const stat = fs.statSync(parentScreenshotPath);
        if (stat.size > 0) parentScreenshotResult = parentScreenshotPath;
      }
    }

    const allFiles: string[] = [];
    if (jsonPath) allFiles.push(jsonPath);
    const mediaItems: TelegramMediaItem[] = [];

    if (parentScreenshotResult) {
      mediaItems.push({ type: 'photo', path: parentScreenshotResult });
      allFiles.push(parentScreenshotResult);
    }

    if (screenshotResult) {
      mediaItems.push({ type: 'photo', path: screenshotResult });
      allFiles.push(screenshotResult);
    }

    for (const item of media) {
      mediaItems.push(item);
      allFiles.push(item.path);
    }

    let uploadSuccess = false;
    if (mediaItems.length >= 2) {
      uploadSuccess = await this.telegramClient.sendMediaGroup(mediaItems, message, topicId);
    } else if (mediaItems.length === 1) {
      uploadSuccess =
        mediaItems[0].type === 'video'
          ? await this.telegramClient.sendVideo(mediaItems[0].path, message, topicId)
          : await this.telegramClient.sendPhoto(mediaItems[0].path, message, topicId);
    } else {
      uploadSuccess = await this.telegramClient.sendMessage(message, topicId);
    }

    const metadataThreadId = getTopicId(this.config, target, 'tweetMetadata');
    if (metadataThreadId && jsonPath && target.saveMetadata) {
      const metaUploaded = await this.telegramClient.sendDocument(jsonPath, metadataThreadId);
      if (!metaUploaded) {
        uploadSuccess = false;
      }
    }

    this.autoDeleteFiles(allFiles, uploadSuccess);
  }

  private async processThread(tweets: Tweet[], target: WatchTarget): Promise<void> {
    let jsonPath: string | null = null;
    let dir: string;
    let baseName: string;

    if (target.saveMetadata) {
      const saved = this.saveThread(tweets, target.username);
      jsonPath = saved.jsonPath;
      dir = saved.dir;
      baseName = saved.baseName;
    } else {
      dir = path.join(this.config.downloadRoot, target.username, 'tweets');
      baseName = `[${target.username}][${getTimestamp(tweets[0].createdAt)}] THREAD - ${truncateForFilename(tweets[0].text)}`;
    }

    const mediaItems: TelegramMediaItem[] = [];
    const allFiles: string[] = [];
    if (jsonPath) allFiles.push(jsonPath);

    if (target.saveMedia) {
      for (const tweet of tweets) {
        const downloaded = await this.downloadTweetMedia(tweet, dir, baseName);
        for (const item of downloaded) {
          mediaItems.push(item);
          allFiles.push(item.path);
        }
      }
    }

    let screenshotResult: string | null = null;
    if (target.saveScreenshots) {
      const lastTweet = tweets[tweets.length - 1];
      const screenshotPath = path.join(dir, `${baseName}.jpg`);
      screenshotResult = await this.screenshotService.captureThread(target.username, lastTweet.id, screenshotPath);

      // Fallback: if the screenshot timed out but the file was written to disk, use it
      if (!screenshotResult && fs.existsSync(screenshotPath)) {
        const stat = fs.statSync(screenshotPath);
        if (stat.size > 0) {
          this.logger.info('Thread screenshot timed out but file exists on disk, using it', { screenshotPath, size: stat.size });
          screenshotResult = screenshotPath;
        }
      }
    }

    let parentScreenshotResult: string | null = null;
    if (target.saveScreenshots && tweets[0].inReplyToTweet) {
      const parentScreenshotPath = path.join(dir, `${baseName}_parent.jpg`);
      parentScreenshotResult = await this.screenshotService.captureTweet(
        tweets[0].inReplyToTweet.author.username || target.username, 
        tweets[0].inReplyToTweet.id, 
        parentScreenshotPath
      );
      if (!parentScreenshotResult && fs.existsSync(parentScreenshotPath)) {
        const stat = fs.statSync(parentScreenshotPath);
        if (stat.size > 0) parentScreenshotResult = parentScreenshotPath;
      }
    }

    if (parentScreenshotResult) {
      mediaItems.unshift({ type: 'photo', path: parentScreenshotResult });
      allFiles.push(parentScreenshotResult);
    }

    if (screenshotResult) {
      mediaItems.unshift({ type: 'photo', path: screenshotResult });
      allFiles.push(screenshotResult);
    }

    const preview = escapeHtml(
      `${tweets[0].text.substring(0, 200)}${tweets[0].text.length > 200 ? '...' : ''}`
    );
    const message =
      `<b>New Thread</b>\n\n` +
      `From: @${escapeHtml(target.username)}\n` +
      `Tweets: ${tweets.length}\n` +
      `<blockquote>${preview}</blockquote>\n` +
      `Link: https://x.com/${target.username}/status/${tweets[tweets.length - 1].id}`;

    const topicId = getTopicId(this.config, target, 'tweet');
    let uploadSuccess = false;
    if (mediaItems.length >= 2) {
      uploadSuccess = await this.telegramClient.sendMediaGroup(mediaItems, message, topicId);
    } else if (mediaItems.length === 1) {
      uploadSuccess =
        mediaItems[0].type === 'video'
          ? await this.telegramClient.sendVideo(mediaItems[0].path, message, topicId)
          : await this.telegramClient.sendPhoto(mediaItems[0].path, message, topicId);
    } else {
      uploadSuccess = await this.telegramClient.sendMessage(message, topicId);
    }

    const metadataThreadId = getTopicId(this.config, target, 'tweetMetadata');
    if (metadataThreadId && jsonPath && target.saveMetadata) {
      const metaUploaded = await this.telegramClient.sendDocument(jsonPath, metadataThreadId);
      if (!metaUploaded) {
        uploadSuccess = false;
      }
    }

    this.autoDeleteFiles(allFiles, uploadSuccess);
  }
}
