'use strict';

/**
 * Tweet Watcher — Polls Twitter for new tweets from watched users.
 * 
 * Saves tweets as JSON + TXT, takes screenshots, and sends notifications.
 * Alternates poll interval between 60s and 120s to appear more human-like.
 */

const fs = require('fs');
const path = require('path');
const { getUserTweets, getTweetById, getUserId } = require('./twitter-api');
const { getTweetUsers, getTopicId } = require('./watchlist-manager');
const { sendTelegram, sendTelegramPhoto, uploadTelegramDocument } = require('./notify');
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
 * Ensure user ID is cached.
 */
async function ensureUserId(username) {
  if (userIdCache[username]) return userIdCache[username];

  const id = await getUserId(username);
  if (id) userIdCache[username] = id;
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
 * Save a tweet to disk in JSON and TXT formats.
 * @returns {{ jsonPath: string, txtPath: string, dir: string }}
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

  // Save TXT (human-readable)
  const txtPath = path.join(dir, `${baseName}.txt`);
  const lines = [
    `Tweet by @${tweet.author?.username || username}`,
    `Date: ${tweet.createdAt}`,
    `URL: https://x.com/${tweet.author?.username || username}/status/${tweet.id}`,
    '',
    tweet.text,
    '',
    `❤ ${tweet.metrics?.likes || 0}  🔁 ${tweet.metrics?.retweets || 0}  💬 ${tweet.metrics?.replies || 0}  👁 ${tweet.metrics?.views || 0}`,
  ];

  if (tweet.media?.length) {
    lines.push('', 'Media:');
    tweet.media.forEach(m => lines.push(`  - [${m.type}] ${m.url}`));
  }

  if (tweet.quotedTweet) {
    lines.push('', `Quoting @${tweet.quotedTweet.author?.username}:`, `  "${tweet.quotedTweet.text}"`);
  }

  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');

  return { jsonPath, txtPath, dir, baseName };
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

  // Save TXT
  const txtPath = path.join(dir, `${baseName}.txt`);
  const lines = [
    `Thread by @${username} (${tweets.length} tweets)`,
    `Date: ${firstTweet.createdAt}`,
    `URL: https://x.com/${username}/status/${tweets[tweets.length - 1].id}`,
    '',
    '═'.repeat(50),
  ];

  tweets.forEach((t, i) => {
    lines.push(``, `[${i + 1}/${tweets.length}]`, t.text);
    if (t.media?.length) {
      t.media.forEach(m => lines.push(`  📎 [${m.type}] ${m.url}`));
    }
    lines.push('─'.repeat(50));
  });

  const lastTweet = tweets[tweets.length - 1];
  lines.push('', `❤ ${lastTweet.metrics?.likes || 0}  🔁 ${lastTweet.metrics?.retweets || 0}  💬 ${lastTweet.metrics?.replies || 0}`);

  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');

  return { jsonPath, txtPath, dir, baseName };
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
 * Process a single new tweet: save it, screenshot it, notify Telegram.
 */
async function processNewTweet(tweet, username, log) {
  // Skip retweets (we only care about original content)
  if (tweet.isRetweet) return;

  log(`📝 New tweet from @${username}: "${tweet.text.substring(0, 60)}..."`);

  // Save tweet data
  const { baseName, dir, jsonPath } = saveTweet(tweet, username);

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

  // Send screenshot if available, otherwise text-only
  if (screenshotResult) {
    await sendTelegramPhoto(screenshotResult, msg, topicId);
  } else {
    await sendTelegram(msg, topicId);
  }

  // Upload metadata JSON
  const tweetMetaTopicId = getTopicId(username, 'tweetMetadata');
  if (jsonPath && tweetMetaTopicId) {
    await uploadTelegramDocument(jsonPath, tweetMetaTopicId);
  }
}

/**
 * Process a detected thread.
 */
async function processThread(threadTweets, username, log) {
  log(`🧵 Thread detected from @${username} (${threadTweets.length} tweets)`);

  const { baseName, dir, jsonPath } = saveThread(threadTweets, username);

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

  if (screenshotResult) {
    await sendTelegramPhoto(screenshotResult, msg, topicId);
  } else {
    await sendTelegram(msg, topicId);
  }

  // Upload metadata JSON
  const tweetMetaTopicId = getTopicId(username, 'tweetMetadata');
  if (jsonPath && tweetMetaTopicId) {
    await uploadTelegramDocument(jsonPath, tweetMetaTopicId);
  }
}

/**
 * Check a single user for new tweets.
 */
async function checkUserTweets(username, log) {
  const userId = await ensureUserId(username);
  if (!userId) {
    log(`⚠ Could not resolve user ID for @${username}`);
    return;
  }

  const tweets = await getUserTweets(userId);
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
  }

  // Process threads
  for (const [, threadTweets] of Object.entries(threadConversations)) {
    if (threadTweets.length >= 2) {
      // Collect the full thread from what we have
      const sorted = threadTweets.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      await processThread(sorted, username, log);
    } else {
      // Single self-reply — treat as standalone for now
      await processNewTweet(threadTweets[0], username, log);
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
  const totalSeen = Object.values(seenTweets).reduce((sum, set) => sum + set.size, 0);
  return {
    running: isRunning,
    watchingUsers: users.length,
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
