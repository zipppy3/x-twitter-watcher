'use strict';

/**
 * Watchlist Manager — Persistent, dynamic user watchlist with per-user Telegram routing.
 * 
 * Manages watchlist.json which maps usernames to their watch settings and
 * optional per-user Telegram Topic IDs.
 */

const fs = require('fs');
const path = require('path');

const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');

/**
 * Default config for a newly added user.
 */
function defaultUserConfig() {
  return {
    watchSpaces: true,
    watchTweets: true,
    watchReplies: false,
    userId: null,
    telegramAudioTopicId: null,
    telegramMetadataTopicId: null,
    telegramTweetTopicId: null,
    addedAt: new Date().toISOString(),
  };
}

/**
 * Read the entire watchlist from disk.
 */
function readWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
    }
  } catch { /* corrupted file, start fresh */ }
  return { users: {} };
}

/**
 * Write the watchlist to disk.
 */
function writeWatchlist(data) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Get all usernames in the watchlist.
 */
function getUsers() {
  const wl = readWatchlist();
  return Object.keys(wl.users || {});
}

/**
 * Get users filtered by what they're watching.
 */
function getSpaceUsers() {
  const wl = readWatchlist();
  return Object.entries(wl.users || {})
    .filter(([, cfg]) => cfg.watchSpaces !== false)
    .map(([username]) => username);
}

function getTweetUsers() {
  const wl = readWatchlist();
  return Object.entries(wl.users || {})
    .filter(([, cfg]) => cfg.watchTweets !== false)
    .map(([username]) => username);
}

/**
 * Get users who have reply-watching enabled.
 */
function getReplyUsers() {
  const wl = readWatchlist();
  return Object.entries(wl.users || {})
    .filter(([, cfg]) => cfg.watchReplies === true)
    .map(([username]) => username);
}

/**
 * Lookup a username by their stored userId (rest_id).
 * Used to detect handle changes.
 */
function getUsernameByRestId(restId) {
  const wl = readWatchlist();
  for (const [username, cfg] of Object.entries(wl.users || {})) {
    if (cfg.userId === restId) return username;
  }
  return null;
}

/**
 * Get config for a specific user.
 */
function getUserConfig(username) {
  const wl = readWatchlist();
  return wl.users?.[username.toLowerCase()] || null;
}

/**
 * Add a user to the watchlist.
 * @param {string} username
 * @param {object} options - { watchSpaces, watchTweets, userId }
 * @returns {boolean} true if added, false if already exists
 */
function addUser(username, options = {}) {
  const wl = readWatchlist();
  const key = username.toLowerCase().replace('@', '');

  if (wl.users[key]) return false; // already exists

  wl.users[key] = {
    ...defaultUserConfig(),
    ...options,
  };
  writeWatchlist(wl);
  return true;
}

/**
 * Remove a user from the watchlist.
 * @returns {boolean} true if removed, false if not found
 */
function removeUser(username) {
  const wl = readWatchlist();
  const key = username.toLowerCase().replace('@', '');

  if (!wl.users[key]) return false;

  delete wl.users[key];
  writeWatchlist(wl);
  return true;
}

/**
 * Update config for an existing user.
 */
function updateUser(username, updates) {
  const wl = readWatchlist();
  const key = username.toLowerCase().replace('@', '');

  if (!wl.users[key]) return false;

  wl.users[key] = { ...wl.users[key], ...updates };
  writeWatchlist(wl);
  return true;
}

/**
 * Get the correct Telegram Topic ID for a user + type.
 * Falls back to the global .env value if no per-user override exists.
 * 
 * @param {string} username
 * @param {'audio'|'metadata'|'tweet'} type
 * @returns {string|null}
 */
function getTopicId(username, type) {
  const cfg = getUserConfig(username);

  const perUserKey = {
    audio: 'telegramAudioTopicId',
    metadata: 'telegramMetadataTopicId',
    tweet: 'telegramTweetTopicId',
    tweetMetadata: 'telegramTweetMetadataTopicId',
  }[type];

  // Per-user override takes priority
  if (cfg?.[perUserKey]) return cfg[perUserKey];

  // Fall back to global .env
  const envKey = {
    audio: 'TELEGRAM_AUDIO_THREAD_ID',
    metadata: 'TELEGRAM_METADATA_THREAD_ID',
    tweet: 'TELEGRAM_TWEET_THREAD_ID',
    tweetMetadata: 'TELEGRAM_TWEET_METADATA_THREAD_ID',
  }[type];

  return process.env[envKey] || null;
}

/**
 * Initialize the watchlist from CLI --user args (migration from v2).
 * Only runs if watchlist.json doesn't exist yet.
 */
function initFromCliUsers(usernames) {
  if (fs.existsSync(WATCHLIST_FILE)) return; // don't overwrite

  const wl = { users: {} };
  for (const u of usernames) {
    const key = u.toLowerCase().replace('@', '');
    wl.users[key] = defaultUserConfig();
  }
  writeWatchlist(wl);
}

module.exports = {
  readWatchlist,
  getUsers,
  getSpaceUsers,
  getTweetUsers,
  getReplyUsers,
  getUsernameByRestId,
  getUserConfig,
  addUser,
  removeUser,
  updateUser,
  getTopicId,
  initFromCliUsers,
  WATCHLIST_FILE,
};
