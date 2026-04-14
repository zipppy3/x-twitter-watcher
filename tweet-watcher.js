'use strict';

/**
 * Tweet Watcher — Polls Twitter for new tweets from watched users.
 * 
 * Saves tweets as JSON + TXT, downloads media, takes screenshots,
 * sends grouped media albums to Telegram, and supports auto-delete.
 * Alternates poll interval between 60s and 120s to appear more human-like.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getUserTweets, getUserTweetsAndReplies, getTweetById, getUserId } = require('./twitter-api');
const { getTweetUsers, getReplyUsers, getTopicId, getUserConfig, updateUser } = require('./watchlist-manager');
const { sendTelegram, sendTelegramPhoto, sendTelegramMediaGroup, uploadTelegramDocument } = require('./notify');
const { screenshotTweet, screenshotThread } = require('./screenshot');

const SEEN_FILE = path.join(__dirname, 'seen-tweets.json');
const DOWNLOAD_DIR = path.join(__dirname, 'download');
const MAX_THREAD_DEPTH = 20;

// User ID cache: username -> userId
const userIdCache = {};

// Seen tweets tracker: username -> Set of tweet IDs
let seenTweets = {};

/**
 * Load previously seen tweet IDs from disk.
 */
function loadSeenTweets() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      // Convert arrays back to Sets
      for (const [user, ids] of Object.entries(data)) {
        seenTweets[user] = new Set(ids);
      }
    }
  } catch { seenTweets = {}; }
}

/**
 * Save seen tweet IDs to disk.
 */
function saveSeenTweets() {
  const serializable = {};
  for (const [user, ids] of Object.entries(seenTweets)) {
    // Only keep the last 500 IDs per user to prevent unbounded growth
    const arr = [...ids];
    serializable[user] = arr.slice(-500);
  }
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(serializable, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/**
 * Ensure user ID is cached and stored in watchlist.
 */
async function ensureUserId(username) {
  if (userIdCache[username]) return userIdCache[username];

  // Check watchlist for stored userId first
  const cfg = getUserConfig(username);
  if (cfg?.userId) {
    userIdCache[username] = cfg.userId;
    return cfg.userId;
  }

  const id = await getUserId(username);
  if (id) {
    userIdCache[username] = id;
    // Persist the userId in the watchlist for handle-change resilience
    updateUser(username, { userId: id });
  }
  return id;
}

/**
 * Generate a clean timestamp string for filenames.
 */
function getTimestamp(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return d.toISOString().replace(/[^0-9]/g, '').substring(2, 14); // YYMMDDHHMMSS
}

/**
 * Truncate text for use in filenames (max 50 chars).
 */
function truncateForFilename(text) {
  return (text || 'tweet')
    .replace(/\n/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .substring(0, 50)
    .trim() || 'tweet';
}

/**
 * Download a single media file (image or video) to disk.
 * @param {string} url - URL to download from
 * @param {string} outputPath - Where to save the file
 * @returns {string|null} Path on success, null on failure
 */
async function downloadMedia(url, outputPath) {
  try {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve) => {
      writer.on('finish', () => resolve(outputPath));
      writer.on('error', () => resolve(null));
    });
  } catch (err) {
    console.error(`[TweetWatcher] Media download failed: ${err.message}`);
    return null;
  }
}

/**
 * Download all media from a tweet to disk.
 * @param {object} tweet - Parsed tweet object
 * @param {string} dir - Base directory for downloads
 * @param {string} baseName - Base filename prefix
 * @returns {Array<{type: string, path: string}>} Downloaded media items
 */
async function downloadTweetMedia(tweet, dir, baseName) {
  const downloadedMedia = [];

  if (!tweet.media?.length) return downloadedMedia;

  for (let i = 0; i < tweet.media.length; i++) {
    const m = tweet.media[i];
    let ext = '.jpg';
    let mediaUrl = m.url;

    if (m.type === 'video' || m.type === 'animated_gif') {
      ext = '.mp4';
    } else if (m.type === 'photo') {
      // Get highest quality by appending ?format=jpg&name=orig
      const origUrl = m.url.replace(/\?.*$/, '');
      mediaUrl = origUrl.includes('?') ? origUrl : `${origUrl}?format=jpg&name=orig`;
      ext = '.jpg';
    }

    const filename = `${baseName}_media${i + 1}${ext}`;
    const filePath = path.join(dir, filename);

    const result = await downloadMedia(mediaUrl, filePath);
    if (result) {
      downloadedMedia.push({
        type: (m.type === 'video' || m.type === 'animated_gif') ? 'video' : 'photo',
        path: result,
      });
    }
  }

  return downloadedMedia;
}

/**
 * Save a tweet to disk in JSON and TXT formats.
 * @returns {{ jsonPath: string, txtPath: string, dir: string, baseName: string }}
 */
function saveTweet(tweet, username) {
  const dir = path.join(DOWNLOAD_DIR, username, 'tweets');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = getTimestamp(tweet.createdAt);
  const preview = truncateForFilename(tweet.text);
  const baseName = `[${username}][${ts}] ${preview}`;

  // Save JSON (full data)
  const jsonPath = path.join(dir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(tweet, null, 2), 'utf8');

  return { jsonPath, dir, baseName };
}

/**
 * Save a thread (array of tweets) as a combined file.
 */
function saveThread(tweets, username) {
  const dir = path.join(DOWNLOAD_DIR, username, 'tweets');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const firstTweet = tweets[0];
  const ts = getTimestamp(firstTweet.createdAt);
  const preview = truncateForFilename(firstTweet.text);
  const baseName = `[${username}][${ts}] THREAD - ${preview}`;

  // Save JSON (all tweets in thread)
  const jsonPath = path.join(dir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ thread: tweets, count: tweets.length }, null, 2), 'utf8');

  return { jsonPath, dir, baseName };
}

/**
 * Collect all tweets in a self-thread (user replying to themselves).
 * Walks backward from the conversation, collecting up to MAX_THREAD_DEPTH tweets.
 */
async function collectThread(tweets, userId) {
  // Filter tweets that are self-replies (same conversation)
  const threadTweets = tweets
    .filter(t => t.isThread || (!t.inReplyToStatusId && t.conversationId === tweets[0]?.conversationId))
    .slice(0, MAX_THREAD_DEPTH);

  // Sort chronologically
  threadTweets.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return threadTweets;
}

/**
 * Try to clean up local files after successful upload.
 * Only deletes if AUTO_DELETE_UPLOADED=true.
 * 
 * @param {string[]} filePaths - Array of file paths to delete
 * @param {function} log - Logger
 */
function autoDeleteFiles(filePaths, log) {
  if (process.env.AUTO_DELETE_UPLOADED !== 'true') return;

  for (const fp of filePaths) {
    try {
      if (fs.existsSync(fp)) {
        fs.rmSync(fp);
        log(`🗑 Auto-deleted: ${path.basename(fp)}`);
      }
    } catch (err) {
      console.error(`[TweetWatcher] Auto-delete failed for ${fp}: ${err.message}`);
    }
  }
}

/**
 * Process a single new tweet: save it, download media, screenshot it, notify Telegram.
 */
async function processNewTweet(tweet, username, log) {
  // Skip retweets (we only care about original content)
  if (tweet.isRetweet) return;

  log(`📝 New tweet from @${username}: "${tweet.text.substring(0, 60)}..."`);

  // Save tweet data
  const { baseName, dir, jsonPath } = saveTweet(tweet, username);

  // Download associated media (images/videos)
  const downloadedMedia = await downloadTweetMedia(tweet, dir, baseName);

  // Take screenshot
  const screenshotPath = path.join(dir, `${baseName}.png`);
  const screenshotResult = await screenshotTweet(username, tweet.id, screenshotPath);

  // Get the correct Telegram Topic ID for this user
  const topicId = getTopicId(username, 'tweet');

  // Build notification message
  const msg =
    `📝 <b>New Tweet</b>\n\n` +
    `From: @${tweet.author?.username || username}\n` +
    `<blockquote>${tweet.text.substring(0, 300)}${tweet.text.length > 300 ? '...' : ''}</blockquote>\n` +
    `❤ ${tweet.metrics?.likes || 0}  🔁 ${tweet.metrics?.retweets || 0}\n` +
    `🔗 https://x.com/${username}/status/${tweet.id}`;

  // Track all files for potential auto-delete
  const allFiles = [jsonPath];
  if (screenshotResult) allFiles.push(screenshotResult);
  downloadedMedia.forEach(m => allFiles.push(m.path));

  let uploadSuccess = false;

  // Build media items: screenshot first, then downloaded media
  if (screenshotResult || downloadedMedia.length) {
    const mediaItems = [];

    // Add screenshot as the first photo
    if (screenshotResult) {
      mediaItems.push({ type: 'photo', path: screenshotResult });
    }

    // Add downloaded tweet media
    mediaItems.push(...downloadedMedia);

    if (mediaItems.length >= 2) {
      // Send as grouped album
      uploadSuccess = await sendTelegramMediaGroup(mediaItems, msg, topicId);
    } else if (mediaItems.length === 1) {
      // Single item
      if (mediaItems[0].type === 'video') {
        const { sendTelegramVideo } = require('./notify');
        uploadSuccess = await sendTelegramVideo(mediaItems[0].path, msg, topicId);
      } else {
        uploadSuccess = await sendTelegramPhoto(mediaItems[0].path, msg, topicId);
      }
    }
  } else {
    // No media at all — text-only
    uploadSuccess = await sendTelegram(msg, topicId);
  }

  // Upload metadata JSON
  const tweetMetaTopicId = getTopicId(username, 'tweetMetadata');
  if (jsonPath && tweetMetaTopicId) {
    const metaOk = await uploadTelegramDocument(jsonPath, tweetMetaTopicId);
    if (!metaOk) uploadSuccess = false; // Don't auto-delete if metadata upload failed
  }

  // Auto-delete if everything uploaded successfully
  if (uploadSuccess) {
    autoDeleteFiles(allFiles, log);
  }
}

/**
 * Process a detected thread.
 */
async function processThread(threadTweets, username, log) {
  log(`🧵 Thread detected from @${username} (${threadTweets.length} tweets)`);

  const { baseName, dir, jsonPath } = saveThread(threadTweets, username);

  // Download media from all thread tweets
  const allDownloadedMedia = [];
  for (const tweet of threadTweets) {
    const media = await downloadTweetMedia(tweet, dir, baseName);
    allDownloadedMedia.push(...media);
  }

  // Screenshot the full thread
  const lastTweet = threadTweets[threadTweets.length - 1];
  const screenshotPath = path.join(dir, `${baseName}.png`);
  const screenshotResult = await screenshotThread(username, lastTweet.id, screenshotPath);

  const topicId = getTopicId(username, 'tweet');

  const msg =
    `🧵 <b>New Thread</b>\n\n` +
    `From: @${username}\n` +
    `Tweets: ${threadTweets.length}\n` +
    `<blockquote>${threadTweets[0].text.substring(0, 200)}${threadTweets[0].text.length > 200 ? '...' : ''}</blockquote>\n` +
    `🔗 https://x.com/${username}/status/${lastTweet.id}`;

  const allFiles = [jsonPath];
  if (screenshotResult) allFiles.push(screenshotResult);
  allDownloadedMedia.forEach(m => allFiles.push(m.path));

  let uploadSuccess = false;

  if (screenshotResult || allDownloadedMedia.length) {
    const mediaItems = [];
    if (screenshotResult) mediaItems.push({ type: 'photo', path: screenshotResult });
    mediaItems.push(...allDownloadedMedia);

    if (mediaItems.length >= 2) {
      uploadSuccess = await sendTelegramMediaGroup(mediaItems, msg, topicId);
    } else {
      uploadSuccess = await sendTelegramPhoto(mediaItems[0].path, msg, topicId);
    }
  } else {
    uploadSuccess = await sendTelegram(msg, topicId);
  }

  // Upload metadata JSON
  const tweetMetaTopicId = getTopicId(username, 'tweetMetadata');
  if (jsonPath && tweetMetaTopicId) {
    const metaOk = await uploadTelegramDocument(jsonPath, tweetMetaTopicId);
    if (!metaOk) uploadSuccess = false;
  }

  if (uploadSuccess) {
    autoDeleteFiles(allFiles, log);
  }
}

/**
 * Check a single user for new tweets (and optionally replies).
 */
async function checkUserTweets(username, log) {
  const userId = await ensureUserId(username);
  if (!userId) {
    log(`⚠ Could not resolve user ID for @${username}`);
    return;
  }

  // Determine which endpoint to use based on per-user config
  const cfg = getUserConfig(username);
  const useReplies = cfg?.watchReplies === true;

  const tweets = useReplies
    ? await getUserTweetsAndReplies(userId)
    : await getUserTweets(userId);

  if (!tweets.length) return;

  // Initialize seen set for this user
  if (!seenTweets[username]) {
    // First run: mark all current tweets as seen (don't flood notifications)
    seenTweets[username] = new Set(tweets.map(t => t.id));
    saveSeenTweets();
    log(`📋 Initialized @${username} with ${tweets.length} existing tweets`);
    return;
  }

  // Find new tweets (not in seen set, not retweets)
  const newTweets = tweets.filter(t => !seenTweets[username].has(t.id) && !t.isRetweet);
  if (!newTweets.length) return;

  // Mark as seen immediately to prevent duplicates
  newTweets.forEach(t => seenTweets[username].add(t.id));
  saveSeenTweets();

  // Group threads: find tweets that are self-replies
  const threadConversations = {};
  const standaloneTweets = [];

  for (const tweet of newTweets) {
    if (tweet.isThread) {
      const convId = tweet.conversationId;
      if (!threadConversations[convId]) threadConversations[convId] = [];
      threadConversations[convId].push(tweet);
    } else {
      standaloneTweets.push(tweet);
    }
  }

  // Process standalone tweets
  for (const tweet of standaloneTweets) {
    await processNewTweet(tweet, username, log);
    await new Promise(r => setTimeout(r, 4000)); // Respect Telegram Media upload rate-limits
  }

  // Process threads
  for (const [, threadTweets] of Object.entries(threadConversations)) {
    if (threadTweets.length >= 2) {
      // Collect the full thread from what we have
      const sorted = threadTweets.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      await processThread(sorted, username, log);
      await new Promise(r => setTimeout(r, 6000));
    } else {
      // Single self-reply — treat as standalone for now
      await processNewTweet(threadTweets[0], username, log);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Tweet Watcher Loop
// ═══════════════════════════════════════════════════════════════
let isRunning = false;
let pollTimeout = null;

/**
 * Start the tweet watching loop.
 * Alternates between 60s and 120s poll intervals.
 * 
 * @param {function} log - Logging function (print.info style)
 */
function startTweetWatcher(log = console.log) {
  if (isRunning) return;
  isRunning = true;

  loadSeenTweets();
  log('📝 Tweet watcher started');

  let useShortInterval = true;

  async function poll() {
    if (!isRunning) return;

    const users = getTweetUsers();
    if (users.length === 0) {
      // No users to watch, check again later
      pollTimeout = setTimeout(poll, 30000);
      return;
    }

    for (const username of users) {
      if (!isRunning) break;
      try {
        await checkUserTweets(username, log);
      } catch (err) {
        console.error(`[TweetWatcher] Error checking @${username}:`, err.message);
      }
    }

    // Alternate between 60s and 120s
    const interval = useShortInterval ? 60000 : 120000;
    useShortInterval = !useShortInterval;

    pollTimeout = setTimeout(poll, interval);
  }

  // Start polling after a short initial delay
  pollTimeout = setTimeout(poll, 5000);
}

/**
 * Stop the tweet watching loop.
 */
function stopTweetWatcher() {
  isRunning = false;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

/**
 * Get current tweet watcher status info.
 */
function getTweetWatcherStatus() {
  const users = getTweetUsers();
  const replyUsers = getReplyUsers();
  const totalSeen = Object.values(seenTweets).reduce((sum, set) => sum + set.size, 0);
  return {
    running: isRunning,
    watchingUsers: users.length,
    replyUsers: replyUsers.length,
    users,
    totalSeenTweets: totalSeen,
  };
}

module.exports = {
  startTweetWatcher,
  stopTweetWatcher,
  getTweetWatcherStatus,
  checkUserTweets,
};
