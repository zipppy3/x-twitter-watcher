'use strict';

const https = require('https');

/**
 * Send a Telegram bot notification.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in process.env.
 * Silently does nothing if not configured.
 */
function sendTelegram(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) return Promise.resolve(false);

  const data = JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(res.statusCode === 200));
    });

    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

/**
 * Send a test message to verify Telegram config.
 */
async function testTelegram() {
  return sendTelegram('🔔 <b>Test notification</b>\nYour Twitter Spaces Watcher is connected!');
}

module.exports = { sendTelegram, testTelegram };
