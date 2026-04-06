#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { sendTelegram } = require('./notify');

// ═══════════════════════════════════════════════════════════════
//  CLI Options (must happen before requiring twspace-crawler
//  because SpaceWatcher reads commander options in its constructor)
// ═══════════════════════════════════════════════════════════════
program
  .option('--user <USER>', 'Username(s) to watch, comma-separated')
  .option('--id <SPACE_ID>', 'Download a specific Space by ID')
  .option('--env <ENV_PATH>', 'Path to .env file', '.env')
  .option('--log', 'Enable file logging')
  .option('--minimal', 'Minimal output mode (for background/PM2)')
  .option('--force', 'Force download (use with --id)')
  .option('--force-open')
  .option('--url <URL>')
  .option('--skip-download')
  .option('--skip-download-audio')
  .option('--skip-download-caption')
  .option('--notification');

program.parse();
const opts = program.opts();
const IS_MINIMAL = !!opts.minimal;

// ═══════════════════════════════════════════════════════════════
//  Load Environment
// ═══════════════════════════════════════════════════════════════
dotenv.config({ path: opts.env });

// ═══════════════════════════════════════════════════════════════
//  State File Management
// ═══════════════════════════════════════════════════════════════
const STATE_FILE = path.join(__dirname, '.watcher-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function writeState(updates) {
  const current = readState();
  const state = { ...current, ...updates, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch { /* ignore write errors */ }
}

// ═══════════════════════════════════════════════════════════════
//  Output Abstraction — adapts to minimal vs interactive mode
// ═══════════════════════════════════════════════════════════════
let chalk;
try { chalk = require('chalk'); } catch { chalk = null; }

const print = IS_MINIMAL
  ? {
      // Minimal mode: plain timestamped logs (for PM2 log files)
      info: (msg) => console.log(`[${ts()}] ${stripAnsi(msg)}`),
      success: (msg) => console.log(`[${ts()}] ✅ ${stripAnsi(msg)}`),
      warn: (msg) => console.log(`[${ts()}] ⚠ ${stripAnsi(msg)}`),
      error: (msg) => console.error(`[${ts()}] ✖ ${stripAnsi(msg)}`),
      live: (msg) => console.log(`[${ts()}] 🔴 ${stripAnsi(msg)}`),
      watch: () => { /* silent in minimal mode */ },
      download: (msg) => console.log(`[${ts()}] 📥 ${stripAnsi(msg)}`),
      speaker: (msg) => console.log(`[${ts()}] 📋 ${stripAnsi(msg)}`),
      timer: () => { /* no timer display in minimal mode */ },
      newline: () => {},
    }
  : {
      // Interactive mode: colorful output
      info: (msg) => console.log((chalk ? chalk.cyan('ℹ ') : 'ℹ ') + msg),
      success: (msg) => console.log((chalk ? chalk.green('✅ ') : '✅ ') + msg),
      warn: (msg) => console.log((chalk ? chalk.yellow('⚠ ') : '⚠ ') + msg),
      error: (msg) => console.log((chalk ? chalk.red('✖ ') : '✖ ') + msg),
      live: (msg) => console.log((chalk ? chalk.redBright('🔴 ') + chalk.bold(msg) : '🔴 ' + msg)),
      watch: (msg) => process.stdout.write('\r' + (chalk ? chalk.gray('🔍 ' + msg) : '🔍 ' + msg) + '   '),
      download: (msg) => console.log((chalk ? chalk.magenta('📥 ') : '📥 ') + msg),
      speaker: (msg) => console.log((chalk ? chalk.blue('📋 ') : '📋 ') + msg),
      timer: (msg) => process.stdout.write('\r' + (chalk ? chalk.yellow('⏱  ') + chalk.bold(msg) : '⏱  ' + msg) + '   '),
      newline: () => console.log(),
    };

function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function stripAnsi(str) {
  return str.replace(/\u001b\[\d+m/g, '');
}

// ═══════════════════════════════════════════════════════════════
//  Patch Logger — suppress internal logging, no file logs
// ═══════════════════════════════════════════════════════════════
const loggerModule = require('twspace-crawler/dist/logger');
const winston = require('winston');

loggerModule.logger.clear();
loggerModule.spaceLogger.clear();
loggerModule.spaceRawLogger.clear();

loggerModule.logger.add(new winston.transports.Console({
  level: 'error',
  silent: true,
  format: winston.format.simple(),
}));

if (opts.log) {
  const DailyRotateFile = require('winston-daily-rotate-file');
  loggerModule.logger.clear();
  loggerModule.logger.add(new winston.transports.Console({ level: 'error', silent: true }));
  loggerModule.logger.add(new DailyRotateFile({
    level: 'silly',
    dirname: './logs',
    filename: 'dev.%DATE%_all.log',
    datePattern: 'YYMMDD',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.metadata({ fillExcept: ['timestamp', 'level', 'message'] }),
      winston.format.printf((info) => `${info.timestamp} | [${info.level}] ${info.message}`)
    ),
  }));
  print.info('File logging enabled → ./logs/');
}

// ═══════════════════════════════════════════════════════════════
//  Patch SpaceWatcher — filename, metadata, lifecycle hooks
// ═══════════════════════════════════════════════════════════════
const { SpaceWatcher } = require('twspace-crawler/dist/modules/SpaceWatcher');
const { Util } = require('twspace-crawler/dist/utils/Util');
const { SpaceState } = require('twspace-crawler/dist/enums/Twitter.enum');

// --- Override filename: just the space title ---
Object.defineProperty(SpaceWatcher.prototype, 'filename', {
  get() {
    let title = Util.getCleanFileName(this.space?.title) || 'Untitled Space';
    title = title.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!title) title = 'Untitled Space';

    const dir = Util.getMediaDir(this.space?.creator?.username);
    let name = title;
    let counter = 2;
    try {
      while (fs.existsSync(path.join(dir, `${name}.m4a`))) {
        name = `${title} (${counter})`;
        counter++;
      }
    } catch (_) {}
    return name;
  }
});

// --- Override downloadCaptions: save speakers only ---
SpaceWatcher.prototype.downloadCaptions = async function () {
  if (!this.audioSpace?.participants) return;

  const username = this.space?.creator?.username;
  const dir = Util.getMediaDir(username);
  Util.createMediaDir(username);

  const outFile = path.join(dir, `${this.filename} — speakers.txt`);
  const participants = this.audioSpace.participants;
  const lines = [];

  lines.push(`Space: "${this.space?.title || 'Untitled'}"`);
  lines.push(`Host: ${this.space?.creator?.name || 'Unknown'} (@${username})`);

  const startDate = this.space?.startedAt ? new Date(this.space.startedAt) : null;
  if (startDate) {
    lines.push(`Date: ${startDate.toISOString().replace('T', ' ').substring(0, 16)} UTC`);
  }

  if (this.space?.endedAt && this.space?.startedAt) {
    const ms = Number(this.space.endedAt) - this.space.startedAt;
    lines.push(`Duration: ${Util.getDisplayTime(ms)}`);
  }

  lines.push('');
  lines.push('Speakers:');

  if (participants.admins) {
    for (const admin of participants.admins) {
      const name = admin.display_name || admin.user_results?.result?.legacy?.name || 'Unknown';
      const handle = admin.twitter_screen_name || admin.user_results?.result?.legacy?.screen_name || '?';
      lines.push(`  - ${name} (@${handle}) [Host]`);
    }
  }

  if (participants.speakers) {
    for (const speaker of participants.speakers) {
      const name = speaker.display_name || speaker.user_results?.result?.legacy?.name || 'Unknown';
      const handle = speaker.twitter_screen_name || speaker.user_results?.result?.legacy?.screen_name || '?';
      lines.push(`  - ${name} (@${handle})`);
    }
  }

  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  print.speaker(`Speakers saved: ${path.basename(outFile)}`);
};

// --- Wrap watch() ---
const _originalWatch = SpaceWatcher.prototype.watch;
SpaceWatcher.prototype.watch = async function () {
  print.info(`Watching Space ${this.spaceId}...`);
  return _originalWatch.call(this);
};

// --- Wrap initData() — live detection + recording timer + state ---
const _originalInitData = SpaceWatcher.prototype.initData;
SpaceWatcher.prototype.initData = async function () {
  await _originalInitData.call(this);

  if (this.space) {
    const title = this.space?.title || 'Untitled';
    const user = this.space?.creator?.username || '?';

    if (this.space.state === SpaceState.LIVE) {
      print.live(`LIVE! "${title}" by @${user}`);

      // Update state
      const state = readState();
      const activeSpaces = state.activeSpaces || [];
      if (!activeSpaces.find(s => s.id === this.spaceId)) {
        activeSpaces.push({
          id: this.spaceId,
          title,
          user,
          startedAt: new Date(this.space.startedAt || Date.now()).toISOString(),
        });
      }
      writeState({ status: 'RECORDING', activeSpaces });

      // Telegram notification
      sendTelegram(`🔴 <b>Space Live!</b>\n\nTitle: "${title}"\nHost: @${user}\nID: ${this.spaceId}`);

      // Recording timer (interactive mode only)
      if (!IS_MINIMAL && !this._timerInterval) {
        const startedAt = this.space.startedAt || Date.now();
        this._timerInterval = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
          const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
          const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
          print.timer(`Recording... ${h}:${m}:${s}`);
        }, 1000);
      }
    } else if (this.space.state === SpaceState.ENDED) {
      if (this.space.endedAt && this.space.startedAt) {
        const duration = Util.getDisplayTime(Number(this.space.endedAt) - this.space.startedAt);
        print.info(`Space "${title}" by @${user} — ended (${duration})`);
      }
    }
  }
};

// --- Wrap processDownload() — stop timer, update state ---
const _originalProcessDownload = SpaceWatcher.prototype.processDownload;
SpaceWatcher.prototype.processDownload = async function () {
  if (this._timerInterval) {
    clearInterval(this._timerInterval);
    this._timerInterval = null;
    print.newline();
  }

  const title = this.space?.title || 'Untitled';
  const user = this.space?.creator?.username || '?';
  print.download(`Downloading "${title}" by @${user}...`);

  writeState({ status: 'DOWNLOADING' });

  return _originalProcessDownload.call(this);
};

// --- Wrap downloadAudio() — send notification on completion ---
const _originalDownloadAudio = SpaceWatcher.prototype.downloadAudio;
SpaceWatcher.prototype.downloadAudio = async function () {
  try {
    await _originalDownloadAudio.call(this);
  } catch (error) {
    return; // internal retry handles it
  }

  if (this.downloader?.resultFile && fs.existsSync(this.downloader.resultFile)) {
    const title = this.space?.title || 'Untitled';
    const user = this.space?.creator?.username || '?';
    const duration = (this.space?.endedAt && this.space?.startedAt)
      ? Util.getDisplayTime(Number(this.space.endedAt) - this.space.startedAt)
      : '?';

    print.success(`Saved: ${this.downloader.resultFile} (${duration})`);

    // Update state — remove from active, add to recordings
    const state = readState();
    const activeSpaces = (state.activeSpaces || []).filter(s => s.id !== this.spaceId);
    const recordings = state.recordings || [];
    recordings.push({
      title,
      user,
      duration,
      file: this.downloader.resultFile,
      recordedAt: new Date().toISOString(),
    });
    writeState({
      status: activeSpaces.length > 0 ? 'RECORDING' : 'WATCHING',
      activeSpaces,
      recordings,
    });

    // Telegram notification
    sendTelegram(
      `✅ <b>Space Recorded</b>\n\n` +
      `Title: "${title}"\n` +
      `Host: @${user}\n` +
      `Duration: ${duration}\n` +
      `File: ${path.basename(this.downloader.resultFile)}`
    );
  }
};

// ═══════════════════════════════════════════════════════════════
//  Patch UserListWatcher — clean polling + state updates
// ═══════════════════════════════════════════════════════════════
const { UserListWatcher } = require('twspace-crawler/dist/modules/UserListWatcher');

const _originalGetUserSpaces = UserListWatcher.prototype.getUserSpaces;
let pollCount = 0;
UserListWatcher.prototype.getUserSpaces = async function () {
  const users = require('twspace-crawler/dist/modules/UserManager').userManager.getUsersWithId();
  const usernames = users.map((v) => v.username);
  pollCount++;

  if (pollCount === 1) {
    print.info(`Monitoring ${usernames.length} user(s): ${usernames.map(u => '@' + u).join(', ')}`);
    if (!IS_MINIMAL) print.info('Checking every 30s. Press Ctrl+C to stop.\n');
  }

  if (!IS_MINIMAL) {
    const now = new Date().toLocaleTimeString();
    print.watch(`Polling... (${now}) — check #${pollCount}`);
  }

  // Update state
  writeState({ lastPoll: new Date().toISOString(), pollCount });

  return _originalGetUserSpaces.call(this);
};

// ═══════════════════════════════════════════════════════════════
//  Token Refresh Logic
// ═══════════════════════════════════════════════════════════════
let tokenRefreshAttempts = 0;
const MAX_REFRESH_ATTEMPTS = 2;
const REFRESH_RETRY_DELAY_MS = 30 * 60 * 1000;

async function refreshTokens() {
  const scriptPath = path.join(__dirname, 'refresh_tokens.py');
  if (!fs.existsSync(scriptPath)) {
    print.error('refresh_tokens.py not found!');
    return false;
  }

  print.warn('Attempting to refresh tokens...');

  return new Promise((resolve) => {
    const py = spawn('python3', [scriptPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', () => {});

    py.on('close', (code) => {
      if (code === 0 && stdout.includes('SUCCESS')) {
        dotenv.config({ path: opts.env, override: true });
        print.success('Tokens refreshed successfully!');
        tokenRefreshAttempts = 0;
        resolve(true);
      } else {
        print.error('Token refresh failed.');
        resolve(false);
      }
    });

    py.on('error', () => {
      // Fallback: try 'python' instead of 'python3'
      const py2 = spawn('python', [scriptPath], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout2 = '';
      py2.stdout.on('data', (d) => { stdout2 += d.toString(); });
      py2.on('close', (code2) => {
        if (code2 === 0 && stdout2.includes('SUCCESS')) {
          dotenv.config({ path: opts.env, override: true });
          print.success('Tokens refreshed successfully!');
          tokenRefreshAttempts = 0;
          resolve(true);
        } else {
          resolve(false);
        }
      });
      py2.on('error', () => resolve(false));
    });
  });
}

// Global axios interceptor for 401/403
const axios = require('axios');
let isRefreshing = false;

axios.interceptors.response.use(null, async (error) => {
  const status = error.response?.status;
  if ((status === 401 || status === 403) && !isRefreshing) {
    isRefreshing = true;
    tokenRefreshAttempts++;

    print.warn(`Token error (HTTP ${status}). Attempt ${tokenRefreshAttempts}/${MAX_REFRESH_ATTEMPTS}`);
    writeState({ status: 'ERROR', lastError: `Token expired (HTTP ${status})` });

    // Notify via Telegram
    sendTelegram(
      `⚠️ <b>Tokens Expired!</b>\n\n` +
      `HTTP ${status} received.\n` +
      `Attempting auto-refresh (${tokenRefreshAttempts}/${MAX_REFRESH_ATTEMPTS})...\n\n` +
      `If this fails, update manually:\n<code>node watcher.js update-tokens</code>`
    );

    if (tokenRefreshAttempts > MAX_REFRESH_ATTEMPTS) {
      print.error('Max refresh attempts reached. Shutting down.');
      sendTelegram('🔴 <b>Watcher Stopped</b>\n\nToken refresh failed after 2 attempts.\nManual intervention required.');
      writeState({ status: 'STOPPED', lastError: 'Token refresh failed' });
      process.exit(1);
    }

    const success = await refreshTokens();
    if (!success) {
      print.warn(`Retrying in 30 minutes...`);
      await new Promise((r) => setTimeout(r, REFRESH_RETRY_DELAY_MS));
      const retrySuccess = await refreshTokens();
      if (!retrySuccess) {
        print.error('Token refresh failed. Shutting down.');
        sendTelegram('🔴 <b>Watcher Stopped</b>\n\nToken refresh failed after retries.\nManual intervention required.');
        writeState({ status: 'STOPPED', lastError: 'Token refresh failed' });
        process.exit(1);
      }
    }

    isRefreshing = false;
  }
  return Promise.reject(error);
});

// ═══════════════════════════════════════════════════════════════
//  Main Entry Point
// ═══════════════════════════════════════════════════════════════
const { mainManager } = require('twspace-crawler/dist/modules/MainManager');
const { userManager } = require('twspace-crawler/dist/modules/UserManager');
const { configManager } = require('twspace-crawler/dist/modules/ConfigManager');
const { SpaceDownloader } = require('twspace-crawler/dist/modules/SpaceDownloader');

async function main() {
  if (!IS_MINIMAL) {
    const c = chalk || { cyan: { bold: (s) => s } };
    console.log(c.cyan.bold('\n  ╔══════════════════════════════════════╗'));
    console.log(c.cyan.bold('  ║   Twitter Spaces Watcher  v2.0      ║'));
    console.log(c.cyan.bold('  ╚══════════════════════════════════════╝\n'));
  } else {
    print.info('Twitter Spaces Watcher v2.0 started (minimal mode)');
  }

  configManager.load();

  const { url, id, user } = opts;

  // Initialize state
  const usernames = [...new Set((user || '')
    .split(',')
    .concat((configManager.config.users || []).map((v) => (typeof v === 'string' ? v : v?.username)))
    .filter((v) => v))];

  writeState({
    status: 'WATCHING',
    mode: IS_MINIMAL ? 'minimal' : 'interactive',
    users: usernames,
    startedAt: new Date().toISOString(),
    pollCount: 0,
    activeSpaces: [],
    recordings: readState().recordings || [],
    lastError: null,
  });

  // Notify start
  if (usernames.length) {
    sendTelegram(`🟢 <b>Watcher Started</b>\n\nMode: ${IS_MINIMAL ? 'Minimal' : 'Interactive'}\nUsers: ${usernames.map(u => '@' + u).join(', ')}`);
  }

  // Mode 1: Download by playlist URL
  if (url && !id) {
    print.download('Downloading from playlist URL...');
    new SpaceDownloader(url, Util.getDateTimeString()).download();
    return;
  }

  // Mode 2: Download by Space ID
  if (id) {
    print.info(`Downloading Space ${id}...`);
    mainManager.addSpaceWatcher(id);
    return;
  }

  // Mode 3: Watch users
  if (!usernames.length) {
    print.error('No users specified. Use --user <username>');
    process.exit(1);
  }

  userManager.once('list_ready', () => {
    mainManager.runUserListWatcher();
  });

  await userManager.add(usernames);

  if (Util.getTwitterAuthorization() || Util.getTwitterAuthToken()) {
    mainManager.runUserListWatcher();
  } else {
    usernames.forEach((u) => mainManager.addUserWatcher(u));
  }
}

// ═══════════════════════════════════════════════════════════════
//  Graceful Shutdown
// ═══════════════════════════════════════════════════════════════
function shutdown(signal) {
  print.newline();
  print.info(`Shutting down (${signal})...`);
  writeState({ status: 'STOPPED' });
  sendTelegram(`⏹ <b>Watcher Stopped</b>\n\nSignal: ${signal}`).finally(() => {
    process.exit(0);
  });
  // Force exit after 3s if Telegram is slow
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  print.error(`Unexpected error: ${err.message}`);
  writeState({ status: 'ERROR', lastError: err.message });
  sendTelegram(`🔴 <b>Watcher Error</b>\n\n<code>${err.message}</code>`);
});

main().catch((err) => {
  print.error(`Fatal: ${err.message}`);
  writeState({ status: 'STOPPED', lastError: err.message });
  sendTelegram(`🔴 <b>Watcher Crashed</b>\n\n<code>${err.message}</code>`).finally(() => {
    process.exit(1);
  });
  setTimeout(() => process.exit(1), 3000);
});
