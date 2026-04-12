'use strict';

const https = require('https');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

/**
 * Get the Telegram API URL (allows overriding to a local Bot API server)
 */
function getTelegramApiUrl() {
  let url = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
  if (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * Send a Telegram bot notification.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in process.env.
 * Silently does nothing if not configured.
 * 
 * @param {string} message - HTML-formatted message
 * @param {string|null} threadId - Optional Topic thread ID for group routing
 */
function sendTelegram(message, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) return Promise.resolve(false);

  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  // Add thread ID if provided (for Topic routing)
  if (threadId) payload.message_thread_id = threadId;

  const data = JSON.stringify(payload);

  return new Promise((resolve) => {
    const apiUrl = getTelegramApiUrl();
    const isLocal = apiUrl.startsWith('http://');
    const requestModule = isLocal ? require('http') : https;
    
    const urlObj = new URL(apiUrl);

    const req = requestModule.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: `${urlObj.pathname === '/' ? '' : urlObj.pathname}/bot${botToken}/sendMessage`,
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

/**
 * Upload a Photo (PNG screenshot) to a Telegram Topic.
 * 
 * @param {string} filePath - Path to the PNG file
 * @param {string} caption - HTML caption
 * @param {string|null} threadId - Topic thread ID
 */
async function sendTelegramPhoto(filePath, caption, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId || !fs.existsSync(filePath)) return false;

  const url = `${getTelegramApiUrl()}/bot${botToken}/sendPhoto`;

  const form = new FormData();
  form.append('chat_id', chatId);
  if (threadId) form.append('message_thread_id', threadId);
  form.append('photo', fs.createReadStream(filePath));
  if (caption) {
    form.append('caption', caption.substring(0, 1024)); // Telegram caption limit
    form.append('parse_mode', 'HTML');
  }

  try {
    const res = await axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return res.status === 200;
  } catch (error) {
    console.error('Telegram Photo Upload Error:', error.message);
    return false;
  }
}

/**
 * Upload an Audio file to a Telegram Topic.
 * 
 * @param {string} filePath
 * @param {string} title
 * @param {string} performer
 * @param {number} durationSec
 * @param {string|null} threadId - Optional per-user Topic override
 */
async function uploadTelegramAudio(filePath, title, performer, durationSec, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = threadId || process.env.TELEGRAM_AUDIO_THREAD_ID;

  if (!botToken || !chatId || !fs.existsSync(filePath)) return false;

  const url = `${getTelegramApiUrl()}/bot${botToken}/sendAudio`;
  
  const form = new FormData();
  form.append('chat_id', chatId);
  if (topicId) form.append('message_thread_id', topicId);
  form.append('audio', fs.createReadStream(filePath));
  
  if (title) form.append('title', title);
  if (performer) form.append('performer', performer);
  if (durationSec) form.append('duration', durationSec);

  try {
    const res = await axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return res.status === 200;
  } catch (error) {
    if (error.response?.status === 413) {
      sendTelegram(`⚠️ <b>Upload Failed</b>\n\nFile <code>${path.basename(filePath)}</code> is too large for the Telegram Bot API.\n(Please setup a Local Telegram Bot API Server to bypass the 50MB limit)`);
    } else {
      console.error('Telegram Audio Upload Error:', error.message);
    }
    return false;
  }
}

/**
 * Upload a Document (Metadata TXT) to a Telegram Topic.
 * 
 * @param {string} filePath
 * @param {string|null} threadId - Optional per-user Topic override
 */
async function uploadTelegramDocument(filePath, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = threadId || process.env.TELEGRAM_METADATA_THREAD_ID;

  if (!botToken || !chatId || !fs.existsSync(filePath)) return false;

  const url = `${getTelegramApiUrl()}/bot${botToken}/sendDocument`;
  
  const form = new FormData();
  form.append('chat_id', chatId);
  if (topicId) form.append('message_thread_id', topicId);
  form.append('document', fs.createReadStream(filePath));

  try {
    const res = await axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return res.status === 200;
  } catch (error) {
    console.error('Telegram Document Upload Error:', error.message);
    return false;
  }
}

module.exports = { 
  sendTelegram, 
  testTelegram,
  sendTelegramPhoto,
  uploadTelegramAudio, 
  uploadTelegramDocument,
};
