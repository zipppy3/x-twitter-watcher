'use strict';

const https = require('https');
const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const PUBLIC_API = 'https://api.telegram.org';

/**
 * Get the Telegram API URL (allows overriding to a local Bot API server)
 */
function getTelegramApiUrl() {
  let url = process.env.TELEGRAM_API_URL || PUBLIC_API;
  if (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * Check if a local server URL is configured.
 */
function isLocalServer() {
  const url = getTelegramApiUrl();
  return url !== PUBLIC_API && url.startsWith('http://');
}

/**
 * Check if the configured chat is a supergroup (supports Topics).
 * Supergroup IDs are negative and start with -100.
 * Personal DMs are positive numbers and don't support Topics.
 */
function isSupergroup() {
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  return chatId.startsWith('-100');
}

/**
 * Only return the thread ID if the chat supports Topics (supergroup).
 * Passing message_thread_id to a personal DM chat causes a 400 error.
 */
function safeThreadId(threadId) {
  if (!threadId) return undefined;
  return isSupergroup() ? threadId : undefined;
}

/**
 * Send a Telegram bot notification.
 * Falls back to the public API if the local server is unreachable.
 * 
 * @param {string} message - HTML-formatted message
 * @param {string|null} threadId - Optional Topic thread ID for group routing
 */
async function sendTelegram(message, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) return false;

  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  const safe = safeThreadId(threadId);
  if (safe) payload.message_thread_id = safe;

  const apiUrl = getTelegramApiUrl();
  const url = `${apiUrl}/bot${botToken}/sendMessage`;

  try {
    const res = await axios.post(url, payload, { timeout: 10000 });
    return res.status === 200;
  } catch (err) {
    // If local server failed, fall back to public API
    if (isLocalServer() && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
      console.log('[Telegram] Local server down, falling back to public API');
      try {
        const res = await axios.post(`${PUBLIC_API}/bot${botToken}/sendMessage`, payload, { timeout: 10000 });
        return res.status === 200;
      } catch (fallbackErr) {
        console.error('[Telegram] Fallback failed:', fallbackErr.message);
      }
    } else {
      console.error('[Telegram] sendMessage error:', err.message);
    }
    return false;
  }
}

/**
 * Send a test message to verify Telegram config.
 */
async function testTelegram() {
  return sendTelegram('🔔 <b>Test notification</b>\nYour X Watcher is connected!');
}

/**
 * Upload a Photo (PNG screenshot) to a Telegram Topic.
 * Falls back to public API if local server is down.
 * 
 * @param {string} filePath - Path to the PNG file
 * @param {string} caption - HTML caption
 * @param {string|null} threadId - Topic thread ID
 */
async function sendTelegramPhoto(filePath, caption, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId || !fs.existsSync(filePath)) return false;

  async function doUpload(baseUrl) {
    const url = `${baseUrl}/bot${botToken}/sendPhoto`;
    const form = new FormData();
    form.append('chat_id', chatId);
    const safe = safeThreadId(threadId);
    if (safe) form.append('message_thread_id', safe);
    form.append('photo', fs.createReadStream(filePath));
    if (caption) {
      form.append('caption', caption.substring(0, 1024));
      form.append('parse_mode', 'HTML');
    }
    return axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 30000,
    });
  }

  try {
    const res = await doUpload(getTelegramApiUrl());
    return res.status === 200;
  } catch (err) {
    if (isLocalServer() && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
      console.log('[Telegram] Local server down, falling back to public API for photo');
      try {
        const res = await doUpload(PUBLIC_API);
        return res.status === 200;
      } catch (fallbackErr) {
        console.error('Telegram Photo Upload Error (fallback):', fallbackErr.message);
      }
    } else {
      console.error('Telegram Photo Upload Error:', err.message);
    }
    return false;
  }
}

/**
 * Upload an Audio file to a Telegram Topic.
 * Falls back to public API if local server is down (note: 50MB limit applies on public API).
 * 
 * @param {string} filePath
 * @param {string} title
 * @param {string} performer
 * @param {number} durationSec
 * @param {string|null} threadId
 */
async function uploadTelegramAudio(filePath, title, performer, durationSec, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = threadId || process.env.TELEGRAM_AUDIO_THREAD_ID;

  if (!botToken || !chatId || !fs.existsSync(filePath)) return false;

  async function doUpload(baseUrl) {
    const url = `${baseUrl}/bot${botToken}/sendAudio`;
    const form = new FormData();
    form.append('chat_id', chatId);
    const safe = safeThreadId(topicId);
    if (safe) form.append('message_thread_id', safe);
    form.append('audio', fs.createReadStream(filePath));
    if (title) form.append('title', title);
    if (performer) form.append('performer', performer);
    if (durationSec) form.append('duration', durationSec);
    return axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    });
  }

  try {
    const res = await doUpload(getTelegramApiUrl());
    return res.status === 200;
  } catch (err) {
    if (isLocalServer() && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
      console.log('[Telegram] Local server down, falling back to public API for audio (50MB limit applies)');
      try {
        const res = await doUpload(PUBLIC_API);
        return res.status === 200;
      } catch (fallbackErr) {
        if (fallbackErr.response?.status === 413) {
          await sendTelegram(
            `⚠️ <b>Upload Failed</b>\n\nFile <code>${path.basename(filePath)}</code> is too large (>50MB).\nLocal Bot API server is down. Start it with: <code>docker compose up -d</code>`
          );
        } else {
          console.error('Telegram Audio Upload Error (fallback):', fallbackErr.message);
        }
      }
    } else if (err.response?.status === 413) {
      await sendTelegram(
        `⚠️ <b>Upload Failed</b>\n\nFile <code>${path.basename(filePath)}</code> is too large for the Telegram Bot API.\nPlease setup a Local Telegram Bot API Server to bypass the 50MB limit.`
      );
    } else {
      console.error('Telegram Audio Upload Error:', err.message);
    }
    return false;
  }
}

/**
 * Upload a Document (metadata JSON/TXT) to a Telegram Topic.
 * Falls back to public API if local server is down.
 * 
 * @param {string} filePath
 * @param {string|null} threadId
 */
async function uploadTelegramDocument(filePath, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = threadId || process.env.TELEGRAM_METADATA_THREAD_ID;

  if (!botToken || !chatId || !fs.existsSync(filePath)) return false;

  async function doUpload(baseUrl) {
    const url = `${baseUrl}/bot${botToken}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', chatId);
    const safe = safeThreadId(topicId);
    if (safe) form.append('message_thread_id', safe);
    form.append('document', fs.createReadStream(filePath));
    return axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 30000,
    });
  }

  try {
    const res = await doUpload(getTelegramApiUrl());
    return res.status === 200;
  } catch (err) {
    if (isLocalServer() && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
      console.log('[Telegram] Local server down, falling back to public API for document');
      try {
        const res = await doUpload(PUBLIC_API);
        return res.status === 200;
      } catch (fallbackErr) {
        console.error('Telegram Document Upload Error (fallback):', fallbackErr.message);
      }
    } else {
      console.error('Telegram Document Upload Error:', err.message);
    }
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
