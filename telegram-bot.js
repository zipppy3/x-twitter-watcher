'use strict';

/**
 * Telegram Bot — Interactive command handler for remote management.
 * 
 * Listens for incoming messages via long polling and responds to commands
 * like /add, /remove, /list, /status, /help.
 * 
 * Only responds to messages from the configured TELEGRAM_CHAT_ID for security.
 */

const path = require('path');
const watchlist = require('./watchlist-manager');

let bot = null;
let isRunning = false;

// Callback for notifying the core engine about user list changes
let onWatchlistChange = null;

/**
 * Start the Telegram bot listener.
 * 
 * @param {object} options
 * @param {function} options.onWatchlistChange - Called when users are added/removed
 * @param {function} options.getStatus - Returns current watcher status info
 */
function startTelegramBot(options = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log('[TelegramBot] Not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    return;
  }

  if (isRunning) return;

  try {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(botToken, { polling: true });
    isRunning = true;
    onWatchlistChange = options.onWatchlistChange || null;

    console.log('[TelegramBot] Bot listener started');

    // ── Security: only respond to authorized chat ──
    bot.on('message', (msg) => {
      const incomingChatId = String(msg.chat.id);
      
      // Check if this is the authorized chat
      if (incomingChatId !== String(chatId)) {
        // Log the mismatch to help user find their correct chat ID
        console.log(`[TelegramBot] Message from unauthorized chat: ${incomingChatId} (configured: ${chatId})`);
        console.log(`[TelegramBot] If this is your group, update TELEGRAM_CHAT_ID=${incomingChatId} in .env`);
        // Don't reply to avoid "supergroup upgraded" errors
        return;
      }

      const text = (msg.text || '').trim();
      if (!text.startsWith('/')) return;

      const [cmd, ...args] = text.split(/\s+/);

      switch (cmd.toLowerCase().split('@')[0]) {
        case '/add':
          handleAdd(msg.chat.id, args);
          break;
        case '/remove':
          handleRemove(msg.chat.id, args);
          break;
        case '/list':
          handleList(msg.chat.id);
          break;
        case '/status':
          handleStatus(msg.chat.id, options.getStatus);
          break;
        case '/help':
        case '/start':
          handleHelp(msg.chat.id);
          break;
        default:
          bot.sendMessage(msg.chat.id, '❓ Unknown command. Type /help to see available commands.');
      }
    });

    // Handle polling errors silently
    bot.on('polling_error', (err) => {
      const errMsg = err.message || '';
      if (err.code === 'ETELEGRAM' && errMsg.includes('409')) {
        // Another bot instance is running, ignore
        return;
      }
      if (errMsg.includes('upgraded to a supergroup')) {
        // Chat was migrated — the chat ID changed
        console.error('[TelegramBot] Your group was upgraded to a supergroup. Your TELEGRAM_CHAT_ID needs updating.');
        console.error('[TelegramBot] Visit https://api.telegram.org/bot' + botToken + '/getUpdates to find the new ID');
        return;
      }
      console.error('[TelegramBot] Polling error:', errMsg);
    });

  } catch (err) {
    console.error('[TelegramBot] Failed to start:', err.message);
  }
}

/**
 * Stop the Telegram bot listener.
 */
function stopTelegramBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
  isRunning = false;
}

// ═══════════════════════════════════════════════════════════════
//  Command Handlers
// ═══════════════════════════════════════════════════════════════

/**
 * /add <username> [spaces|tweets|all]
 */
function handleAdd(chatId, args) {
  if (!args.length) {
    bot.sendMessage(chatId,
      '📖 <b>Usage:</b>\n' +
      '<code>/add username</code> — Watch spaces + tweets\n' +
      '<code>/add username spaces</code> — Watch spaces only\n' +
      '<code>/add username tweets</code> — Watch tweets only',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const username = args[0].replace('@', '').toLowerCase();
  const mode = (args[1] || 'all').toLowerCase();

  const options = {
    watchSpaces: mode === 'all' || mode === 'spaces',
    watchTweets: mode === 'all' || mode === 'tweets',
  };

  const added = watchlist.addUser(username, options);

  if (added) {
    const watching = [];
    if (options.watchSpaces) watching.push('Spaces');
    if (options.watchTweets) watching.push('Tweets');

    bot.sendMessage(chatId,
      `✅ <b>Added @${username}</b>\n\nWatching: ${watching.join(' + ')}`,
      { parse_mode: 'HTML' }
    );

    // Notify the engine to reload
    if (onWatchlistChange) onWatchlistChange('add', username);
  } else {
    bot.sendMessage(chatId,
      `⚠️ @${username} is already in the watchlist.\nUse /remove first to re-add with different settings.`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * /remove <username>
 */
function handleRemove(chatId, args) {
  if (!args.length) {
    bot.sendMessage(chatId, '📖 <b>Usage:</b> <code>/remove username</code>', { parse_mode: 'HTML' });
    return;
  }

  const username = args[0].replace('@', '').toLowerCase();
  const removed = watchlist.removeUser(username);

  if (removed) {
    bot.sendMessage(chatId, `🗑 <b>Removed @${username}</b> from watchlist.`, { parse_mode: 'HTML' });
    if (onWatchlistChange) onWatchlistChange('remove', username);
  } else {
    bot.sendMessage(chatId, `⚠️ @${username} was not in the watchlist.`, { parse_mode: 'HTML' });
  }
}

/**
 * /list
 */
function handleList(chatId) {
  const users = watchlist.getUsers();

  if (!users.length) {
    bot.sendMessage(chatId, '📋 <b>Watchlist is empty.</b>\nUse /add to add users.', { parse_mode: 'HTML' });
    return;
  }

  const lines = users.map(u => {
    const cfg = watchlist.getUserConfig(u);
    const flags = [];
    if (cfg?.watchSpaces !== false) flags.push('🎙 Spaces');
    if (cfg?.watchTweets !== false) flags.push('📝 Tweets');
    return `• <b>@${u}</b> — ${flags.join(', ')}`;
  });

  bot.sendMessage(chatId,
    `📋 <b>Watchlist (${users.length} users)</b>\n\n${lines.join('\n')}`,
    { parse_mode: 'HTML' }
  );
}

/**
 * /status
 */
function handleStatus(chatId, getStatus) {
  let msg = '📊 <b>Watcher Status</b>\n\n';

  if (getStatus) {
    const status = getStatus();

    msg += `<b>State:</b> ${status.state || 'Unknown'}\n`;
    msg += `<b>Mode:</b> ${status.mode || 'Unknown'}\n`;
    msg += `<b>Uptime:</b> ${status.uptime || '?'}\n\n`;

    // Space watcher info
    msg += `<b>🎙 Spaces</b>\n`;
    msg += `  Monitoring: ${status.spaceUsers || 0} users\n`;
    msg += `  Polls: ${status.pollCount || 0}\n`;
    if (status.activeSpaces?.length) {
      msg += `  Active: ${status.activeSpaces.map(s => `"${s.title}"`).join(', ')}\n`;
    }
    msg += `  Recordings: ${status.totalRecordings || 0}\n\n`;

    // Tweet watcher info
    msg += `<b>📝 Tweets</b>\n`;
    msg += `  Monitoring: ${status.tweetUsers || 0} users\n`;
    msg += `  Tracked tweets: ${status.totalSeenTweets || 0}\n`;
  } else {
    msg += 'Status info unavailable.';
  }

  bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
}

/**
 * /help
 */
function handleHelp(chatId) {
  bot.sendMessage(chatId,
    `🤖 <b>X Watcher Bot Commands</b>\n\n` +
    `/add username — Add user (spaces + tweets)\n` +
    `/add username spaces — Watch spaces only\n` +
    `/add username tweets — Watch tweets only\n` +
    `/remove username — Remove user\n` +
    `/list — Show all watched users\n` +
    `/status — Show system status\n` +
    `/help — Show this message`,
    { parse_mode: 'HTML' }
  );
}

module.exports = {
  startTelegramBot,
  stopTelegramBot,
};
