import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { AppConfig, FailedScreenshotInput, HealthReporter, ScreenshotService, Storage, TelegramClient, TelegramMediaItem, TelegramReceipt, Tweet, TwitterClient, WatchTarget } from '../types';
import { FIRST_DELETION_CHECK_DELAY_MS, MIN_RECHECK_GAP_MS } from './deletion-check-worker';
import { rootLogger } from '../runtime/logger';
import { ensureFileDir, sanitizeFilename } from '../utils/files';
import { sleep, randomSleep } from '../utils/async';
import { getTopicId } from '../services/topic-routing';
import { ScreenshotRetryService } from '../services/screenshot-retry';
import { buildThreadMessage, buildTweetMessage, MEDIA_MISSING_NOTE } from '../services/telegram-messages';

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

  /** After this many failed deliveries a tweet is given up on, so one bad tweet cannot block the rest forever. */
  private static readonly MAX_DELIVERY_ATTEMPTS = 5;

  private readonly deliveryAttempts = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly twitterClient: TwitterClient,
    private readonly telegramClient: TelegramClient,
    private readonly screenshotService: ScreenshotService,
    private readonly health?: HealthReporter,
    private readonly screenshotRetry?: ScreenshotRetryService
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
      this.health?.beat();
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
    // The cycle finished (with or without errors): the loop itself is not stuck.
    this.health?.beat();
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

    this.flagTweetsMissingFromTimeline(target.username, tweets);

    const seenIds = new Set(this.storage.getSeenTweetIds(target.username));
    if (!seenIds.size) {
      // Retweets are remembered too: a timeline made only of retweets would otherwise
      // never count as initialised, and the user's next real tweet would be swallowed.
      this.storage.markTweetsSeen(
        target.username,
        tweets.map((tweet) => tweet.id)
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

    const byId = (left: string, right: string): number => {
      const diff = BigInt(left) - BigInt(right);
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    };
    const watched = target;

    // One unit = one notification (a tweet, or a thread posted in one go).
    const units: Array<{ ids: string[]; deliver: () => Promise<boolean> }> = [];

    for (const tweet of standaloneTweets) {
      units.push({
        ids: [tweet.id],
        deliver: async () => {
          await this.enrichWithParentTweet(tweet);
          return this.processNewTweet(tweet, watched);
        },
      });
    }

    for (const threadTweets of Object.values(threadConversations)) {
      const sorted = [...threadTweets].sort((left, right) => byId(left.id, right.id));

      if (sorted.length >= 2) {
        units.push({
          ids: sorted.map((tweet) => tweet.id),
          deliver: async () => {
            for (let i = 0; i < sorted.length; i++) {
              if (i > 0 && sorted[i].inReplyToStatusId === sorted[i - 1].id) {
                sorted[i].inReplyToTweet = sorted[i - 1];
              } else {
                await this.enrichWithParentTweet(sorted[i]);
              }
            }
            return this.processThread(sorted, watched);
          },
        });
      } else {
        units.push({
          ids: [sorted[0].id],
          deliver: async () => {
            await this.enrichWithParentTweet(sorted[0]);
            return this.processNewTweet(sorted[0], watched);
          },
        });
      }
    }

    // Oldest first, so the chat reads in the order things were posted.
    units.sort((left, right) => byId(left.ids[0], right.ids[0]));

    for (const unit of units) {
      const finished = await this.deliverUnit(unit.ids[0], unit.deliver);
      if (!finished) {
        // Not marked as seen, so the next poll picks it up again. Stop here to keep
        // the order: everything newer waits behind it.
        break;
      }
      // Marked only now. A crash or a Telegram outage in the middle of a batch
      // delays the remaining tweets instead of silently dropping them.
      this.storage.markTweetsSeen(watched.username, unit.ids);
      await randomSleep(3000, 6000);
    }
  }

  private get tracksDeletions(): boolean {
    return this.config.deletedTweetCheckDays > 0 && this.config.dataSource !== 'nitter';
  }

  /**
   * A free hint for the deletion check: a posted tweet that should be on this
   * page of the timeline but is not gets looked up soon instead of at its next
   * regular check. Only a hint (timelines collapse threads and skip posts), so
   * nothing is reported from here.
   */
  private flagTweetsMissingFromTimeline(username: string, timeline: Tweet[]): void {
    // A short page says too little about what "should" be on it.
    if (!this.tracksDeletions || timeline.length < 5) {
      return;
    }

    try {
      const present = new Set(timeline.map((tweet) => tweet.id));
      const ids = [...present].map((id) => BigInt(id)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      // The oldest entry may be a pinned tweet from long ago, so the page is taken to start at the second oldest.
      const oldestOnPage = ids[1];
      const recheckBefore = Date.now() - MIN_RECHECK_GAP_MS;

      const missing = this.storage
        .getTrackedTweets(username)
        .filter(
          (tracked) =>
            !present.has(tracked.tweetId) &&
            BigInt(tracked.tweetId) > oldestOnPage &&
            (!tracked.lastCheckedAt || new Date(tracked.lastCheckedAt).getTime() < recheckBefore)
        )
        .map((tracked) => tracked.tweetId);

      if (missing.length) {
        this.storage.requestDeletionCheck(username, missing, new Date().toISOString());
      }
    } catch (error) {
      this.logger.warn('Could not compare the timeline with posted tweets', { username, message: (error as Error).message });
    }
  }

  /** Remember what was posted, so the deletion check can come back to it. */
  private trackDelivered(tweets: Tweet[], target: WatchTarget, messageId: number | undefined): void {
    if (!this.tracksDeletions) {
      return;
    }

    try {
      const nextCheckAt = new Date(Date.now() + FIRST_DELETION_CHECK_DELAY_MS).toISOString();
      this.storage.trackDeliveredTweets(
        target.username,
        tweets.map((tweet) => {
          const postedAt = new Date(tweet.createdAt);
          return {
            tweetId: tweet.id,
            text: tweet.text.slice(0, 1000),
            postedAt: Number.isNaN(postedAt.getTime()) ? null : postedAt.toISOString(),
            telegramMessageId: messageId ?? null,
            nextCheckAt,
          };
        })
      );
    } catch (error) {
      // Tracking is an extra; the tweet itself was delivered.
      this.logger.warn('Could not record a posted tweet for the deletion check', { message: (error as Error).message });
    }
  }

  /** Returns true once a unit is finished: delivered, or given up on after repeated failures. */
  private async deliverUnit(key: string, deliver: () => Promise<boolean>): Promise<boolean> {
    let delivered = false;
    try {
      delivered = await deliver();
    } catch (error) {
      this.logger.error('Processing a tweet failed', { tweetId: key, message: (error as Error).message });
    }

    if (delivered) {
      this.deliveryAttempts.delete(key);
      return true;
    }

    const attempts = (this.deliveryAttempts.get(key) ?? 0) + 1;
    if (attempts >= TweetMonitorWorker.MAX_DELIVERY_ATTEMPTS) {
      this.deliveryAttempts.delete(key);
      this.logger.error('Giving up on a tweet after repeated delivery failures', { tweetId: key, attempts });
      return true;
    }

    this.deliveryAttempts.set(key, attempts);
    this.logger.warn('Tweet not delivered, will retry on the next poll', { tweetId: key, attempt: attempts });
    return false;
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

  private saveTweet(tweet: Tweet, username: string): { jsonPath: string; baseDir: string; baseName: string } {
    const baseDir = path.join(this.config.downloadRoot, username, 'tweets');
    const baseName = `[${username}][${getTimestamp(tweet.createdAt)}] ${truncateForFilename(tweet.text)}`;
    const jsonPath = path.join(baseDir, 'json', `${baseName}.json`);
    ensureFileDir(jsonPath);
    fs.writeFileSync(jsonPath, JSON.stringify(tweet, null, 2), 'utf8');
    return { jsonPath, baseDir, baseName };
  }

  private saveThread(tweets: Tweet[], username: string): { jsonPath: string; baseDir: string; baseName: string } {
    const baseDir = path.join(this.config.downloadRoot, username, 'tweets');
    const baseName = `[${username}][${getTimestamp(tweets[0].createdAt)}] THREAD - ${truncateForFilename(tweets[0].text)}`;
    const jsonPath = path.join(baseDir, 'json', `${baseName}.json`);
    ensureFileDir(jsonPath);
    fs.writeFileSync(jsonPath, JSON.stringify({ thread: tweets, count: tweets.length }, null, 2), 'utf8');
    return { jsonPath, baseDir, baseName };
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

      // pipeline() rejects if either side fails; a bare pipe() would leave this
      // promise (and with it the whole poll loop) hanging on a broken download.
      await pipeline(response.data, fs.createWriteStream(outputPath));

      return outputPath;
    } catch (error) {
      this.logger.warn('Media download failed', { url, message: (error as Error).message });
      return null;
    }
  }

  private async downloadTweetMedia(tweet: Tweet, baseDir: string, baseName: string): Promise<TelegramMediaItem[]> {
    const downloadedMedia: TelegramMediaItem[] = [];
    const mediaDir = path.join(baseDir, 'media');

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
        // pbs.twimg.com serves the original only when `format` matches the real
        // file type; asking for a .png as jpg returns 404.
        const match = item.url.replace(/\?.*$/, '').match(/^(https:\/\/pbs\.twimg\.com\/.+)\.(jpe?g|png|webp)$/i);
        if (match) {
          const format = match[2].toLowerCase();
          extension = `.${format === 'jpeg' ? 'jpg' : format}`;
          mediaUrl = `${match[1]}?format=${format}&name=orig`;
        }
      }

      const filePath = path.join(mediaDir, `${baseName}_media${index + 1}${extension}`);
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

  /** Returns whether the notification was delivered (false = try again later). */
  private async processNewTweet(tweet: Tweet, target: WatchTarget): Promise<boolean> {
    // Save metadata JSON to disk (if enabled)
    let jsonPath: string | null = null;
    let baseDir: string;
    let baseName: string;

    if (target.saveMetadata) {
      const saved = this.saveTweet(tweet, target.username);
      jsonPath = saved.jsonPath;
      baseDir = saved.baseDir;
      baseName = saved.baseName;
    } else {
      // Still need baseDir/baseName for media and screenshots
      baseDir = path.join(this.config.downloadRoot, target.username, 'tweets');
      baseName = `[${target.username}][${getTimestamp(tweet.createdAt)}] ${truncateForFilename(tweet.text)}`;
    }

    // Download media (if enabled)
    const media = target.saveMedia ? await this.downloadTweetMedia(tweet, baseDir, baseName) : [];

    // Capture screenshot (if enabled)
    const failedScreenshots: FailedScreenshotInput[] = [];
    const topicId = getTopicId(this.config, target, 'tweet');
    let screenshotResult: string | null = null;
    if (target.saveScreenshots) {
      const screenshotPath = path.join(baseDir, 'screenshots', `${baseName}.jpg`);

      // Detect if this is a reply made BY the watched user
      const isReplyByWatchedUser = !!(tweet.inReplyToUsername && tweet.author.username?.toLowerCase() === target.username);
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

      if (!screenshotResult) {
        failedScreenshots.push({
          postId: tweet.id,
          kind: 'tweet',
          username: target.username,
          captureUsername: target.username,
          captureTweetId: tweet.id,
          isReply: isReplyByWatchedUser,
          outputPath: screenshotPath,
          telegramMessageId: null,
          topicId,
        });
      }
    }

    const isReplyByWatchedUser = !!(tweet.inReplyToUsername && tweet.author.username?.toLowerCase() === target.username);

    const message = buildTweetMessage(tweet, target.username);

    // When isReplyByWatchedUser is true, the main screenshot already includes the
    // full conversation (parent tweets + reply), so skip the separate parent screenshot.
    let parentScreenshotResult: string | null = null;
    if (target.saveScreenshots && tweet.inReplyToTweet && !isReplyByWatchedUser) {
      const parentScreenshotPath = path.join(baseDir, 'screenshots', `${baseName}_parent.jpg`);
      parentScreenshotResult = await this.screenshotService.captureTweet(
        tweet.inReplyToTweet.author.username || target.username, 
        tweet.inReplyToTweet.id, 
        parentScreenshotPath
      );
      if (!parentScreenshotResult && fs.existsSync(parentScreenshotPath)) {
        const stat = fs.statSync(parentScreenshotPath);
        if (stat.size > 0) parentScreenshotResult = parentScreenshotPath;
      }
      if (!parentScreenshotResult) {
        failedScreenshots.push({
          postId: tweet.id,
          kind: 'parent',
          username: target.username,
          captureUsername: tweet.inReplyToTweet.author.username || target.username,
          captureTweetId: tweet.inReplyToTweet.id,
          isReply: false,
          outputPath: parentScreenshotPath,
          telegramMessageId: null,
          topicId,
        });
      }
    }

    const allFiles: string[] = [];
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

    const { delivered, mediaSent, messageId } = await this.sendNotification(mediaItems, message, topicId);
    if (!delivered) {
      return false;
    }
    this.trackDelivered([tweet], target, messageId);
    await this.reportFailedScreenshots(failedScreenshots, messageId, topicId);

    // Only files that really reached Telegram may be auto-deleted.
    const uploaded = mediaSent ? [...allFiles] : [];
    const metadataThreadId = getTopicId(this.config, target, 'tweetMetadata');
    if (metadataThreadId && jsonPath && target.saveMetadata) {
      // Without a metadata topic the JSON is never uploaded, so it stays on disk.
      if (await this.telegramClient.sendDocument(jsonPath, metadataThreadId)) {
        uploaded.push(jsonPath);
      }
    }

    this.autoDeleteFiles(uploaded, true);
    this.health?.count('tweets');
    return true;
  }

  /** Returns whether the notification was delivered (false = try again later). */
  private async processThread(tweets: Tweet[], target: WatchTarget): Promise<boolean> {
    let jsonPath: string | null = null;
    let baseDir: string;
    let baseName: string;

    if (target.saveMetadata) {
      const saved = this.saveThread(tweets, target.username);
      jsonPath = saved.jsonPath;
      baseDir = saved.baseDir;
      baseName = saved.baseName;
    } else {
      baseDir = path.join(this.config.downloadRoot, target.username, 'tweets');
      baseName = `[${target.username}][${getTimestamp(tweets[0].createdAt)}] THREAD - ${truncateForFilename(tweets[0].text)}`;
    }

    const mediaItems: TelegramMediaItem[] = [];
    const allFiles: string[] = [];

    if (target.saveMedia) {
      for (const [index, tweet] of tweets.entries()) {
        // Per-tweet prefix: with a shared name the second tweet's media overwrote the first's.
        const downloaded = await this.downloadTweetMedia(tweet, baseDir, `${baseName}_t${index + 1}`);
        for (const item of downloaded) {
          mediaItems.push(item);
          allFiles.push(item.path);
        }
      }
    }

    const failedScreenshots: FailedScreenshotInput[] = [];
    const topicId = getTopicId(this.config, target, 'tweet');
    let screenshotResult: string | null = null;
    if (target.saveScreenshots) {
      const lastTweet = tweets[tweets.length - 1];
      const screenshotPath = path.join(baseDir, 'screenshots', `${baseName}.jpg`);
      screenshotResult = await this.screenshotService.captureThread(target.username, lastTweet.id, screenshotPath);

      // Fallback: if the screenshot timed out but the file was written to disk, use it
      if (!screenshotResult && fs.existsSync(screenshotPath)) {
        const stat = fs.statSync(screenshotPath);
        if (stat.size > 0) {
          this.logger.info('Thread screenshot timed out but file exists on disk, using it', { screenshotPath, size: stat.size });
          screenshotResult = screenshotPath;
        }
      }

      if (!screenshotResult) {
        failedScreenshots.push({
          postId: tweets[0].id,
          kind: 'thread',
          username: target.username,
          captureUsername: target.username,
          captureTweetId: lastTweet.id,
          isReply: false,
          outputPath: screenshotPath,
          telegramMessageId: null,
          topicId,
        });
      }
    }

    let parentScreenshotResult: string | null = null;
    if (target.saveScreenshots && tweets[0].inReplyToTweet) {
      const parentScreenshotPath = path.join(baseDir, 'screenshots', `${baseName}_parent.jpg`);
      parentScreenshotResult = await this.screenshotService.captureTweet(
        tweets[0].inReplyToTweet.author.username || target.username, 
        tweets[0].inReplyToTweet.id, 
        parentScreenshotPath
      );
      if (!parentScreenshotResult && fs.existsSync(parentScreenshotPath)) {
        const stat = fs.statSync(parentScreenshotPath);
        if (stat.size > 0) parentScreenshotResult = parentScreenshotPath;
      }
      if (!parentScreenshotResult) {
        failedScreenshots.push({
          postId: tweets[0].id,
          kind: 'parent',
          username: target.username,
          captureUsername: tweets[0].inReplyToTweet.author.username || target.username,
          captureTweetId: tweets[0].inReplyToTweet.id,
          isReply: false,
          outputPath: parentScreenshotPath,
          telegramMessageId: null,
          topicId,
        });
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

    const message = buildThreadMessage(tweets, target.username);

    const { delivered, mediaSent, messageId } = await this.sendNotification(mediaItems, message, topicId);
    if (!delivered) {
      return false;
    }
    this.trackDelivered(tweets, target, messageId);
    await this.reportFailedScreenshots(failedScreenshots, messageId, topicId);

    // Only files that really reached Telegram may be auto-deleted.
    const uploaded = mediaSent ? [...allFiles] : [];
    const metadataThreadId = getTopicId(this.config, target, 'tweetMetadata');
    if (metadataThreadId && jsonPath && target.saveMetadata) {
      // Without a metadata topic the JSON is never uploaded, so it stays on disk.
      if (await this.telegramClient.sendDocument(jsonPath, metadataThreadId)) {
        uploaded.push(jsonPath);
      }
    }

    this.autoDeleteFiles(uploaded, true);
    this.health?.count('tweets');
    return true;
  }

  /** Remember screenshots that are missing from a delivered post and tell the chat which post it was. */
  private async reportFailedScreenshots(
    failed: FailedScreenshotInput[],
    messageId: number | undefined,
    topicId: string | null
  ): Promise<void> {
    if (!failed.length || !this.screenshotRetry || !this.telegramClient.isConfigured()) {
      return;
    }
    await this.screenshotRetry.report(
      failed.map((item) => ({ ...item, telegramMessageId: messageId ?? null })),
      topicId
    );
  }

  /**
   * Send the notification. If the media cannot be uploaded, fall back to text
   * only, so a broken screenshot or an oversized video never costs the whole post.
   */
  private async sendNotification(
    mediaItems: TelegramMediaItem[],
    message: string,
    topicId: string | null
  ): Promise<{ delivered: boolean; mediaSent: boolean; messageId?: number }> {
    if (!this.telegramClient.isConfigured()) {
      // Nothing to deliver to: the files saved on disk are the result.
      return { delivered: true, mediaSent: false };
    }

    // Filled in by whichever send succeeds; a deletion notice links back to it.
    const receipt: TelegramReceipt = {};

    if (!mediaItems.length) {
      const delivered = await this.telegramClient.sendMessage(message, topicId, receipt);
      return { delivered, mediaSent: false, messageId: receipt.messageId };
    }

    let mediaSent: boolean;
    if (mediaItems.length >= 2) {
      mediaSent = await this.telegramClient.sendMediaGroup(mediaItems, message, topicId, receipt);
    } else {
      mediaSent =
        mediaItems[0].type === 'video'
          ? await this.telegramClient.sendVideo(mediaItems[0].path, message, topicId, receipt)
          : await this.telegramClient.sendPhoto(mediaItems[0].path, message, topicId, receipt);
    }
    if (mediaSent) {
      return { delivered: true, mediaSent: true, messageId: receipt.messageId };
    }

    this.logger.warn('Media upload failed, sending the notification as text only');
    const delivered = await this.telegramClient.sendMessage(message + MEDIA_MISSING_NOTE, topicId, receipt);
    return { delivered, mediaSent: false, messageId: receipt.messageId };
  }
}
