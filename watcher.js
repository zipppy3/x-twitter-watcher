#!/usr/bin/env node
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════
const CORE_SCRIPT = path.join(__dirname, 'watcher-core.js');
const STATE_FILE = path.join(__dirname, '.watcher-state.json');
const ENV_FILE = path.join(__dirname, '.env');
const PM2_NAME = 'space-watcher';

let chalk;
try { chalk = require('chalk'); } catch { chalk = null; }

const c = {
  bold: (s) => chalk ? chalk.bold(s) : s,
  cyan: (s) => chalk ? chalk.cyan(s) : s,
  green: (s) => chalk ? chalk.green(s) : s,
  red: (s) => chalk ? chalk.red(s) : s,
  yellow: (s) => chalk ? chalk.yellow(s) : s,
  gray: (s) => chalk ? chalk.gray(s) : s,
  magenta: (s) => chalk ? chalk.magenta(s) : s,
  cyanBold: (s) => chalk ? chalk.cyan.bold(s) : s,
};

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function pm2Installed() {
  try {
    execSync('pm2 --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

function readEnv() {
  const env = {};
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) env[match[1].trim()] = match[2].trim();
    }
  } catch {}
  return env;
}

function writeEnvKey(key, value) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n'); } catch {}

  let found = false;
  const newLines = lines.map(line => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) newLines.push(`${key}=${value}`);

  // Remove trailing empty lines, then add one
  while (newLines.length && newLines[newLines.length - 1].trim() === '') newLines.pop();
  newLines.push('');

  fs.writeFileSync(ENV_FILE, newLines.join('\n'));
}

function timeAgo(isoString) {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m ago`;
  return `${Math.floor(diff / 86400000)}d ${Math.floor((diff % 86400000) / 3600000)}h ago`;
}

function banner() {
  console.log(c.cyanBold('\n  ╔══════════════════════════════════════╗'));
  console.log(c.cyanBold('  ║     X Watcher  v3.0                 ║'));
  console.log(c.cyanBold('  ╚══════════════════════════════════════╝\n'));
}

// ═══════════════════════════════════════════════════════════════
//  Command: start
// ═══════════════════════════════════════════════════════════════
async function cmdStart(args) {
  // Extract --user from args
  const userIdx = args.indexOf('--user');
  const user = userIdx !== -1 ? args[userIdx + 1] : null;
  const idIdx = args.indexOf('--id');
  const id = idIdx !== -1 ? args[idIdx + 1] : null;

  if (!user && !id) {
    console.log(c.red('  ✖ No target specified. Use --user <username> or --id <space_id>\n'));
    return;
  }

  const isMinimal = args.includes('--minimal');
  const isInteractive = args.includes('--interactive');

  let mode;
  if (isMinimal) {
    mode = '1';
  } else if (isInteractive) {
    mode = '2';
  } else {
    // Prompt user
    banner();
    console.log('  Select mode:\n');
    console.log(`    ${c.bold('[1]')} Minimalistic — runs silently in background`);
    console.log(`    ${c.bold('[2]')} Interactive  — full terminal experience\n`);
    mode = await ask(`  Choice ${c.gray('(1/2)')}: `);
  }

  if (mode === '1') {
    // --- Minimalistic: launch via PM2 ---
    if (!pm2Installed()) {
      console.log(c.red('\n  ✖ PM2 is not installed.'));
      console.log(c.yellow('  Install it globally: npm install -g pm2'));
      console.log(c.yellow('  Then run: pm2 startup  (to persist across reboots)\n'));
      return;
    }

    // Build args for watcher-core.js
    const coreArgs = [];
    if (user) coreArgs.push('--user', user);
    if (id) coreArgs.push('--id', id);
    coreArgs.push('--minimal');

    const envIdx = args.indexOf('--env');
    const envPath = envIdx !== -1 ? args[envIdx + 1] : '.env';
    coreArgs.push('--env', envPath);

    if (args.includes('--log')) coreArgs.push('--log');
    if (args.includes('--force')) coreArgs.push('--force');

    // Stop existing instance if any
    try { execSync(`pm2 delete ${PM2_NAME}`, { stdio: 'pipe' }); } catch {}

    // Start via PM2
    const pm2Args = [
      'start', CORE_SCRIPT,
      '--name', PM2_NAME,
      '--', ...coreArgs,
    ];

    try {
      execSync(`pm2 ${pm2Args.join(' ')}`, { stdio: 'inherit', cwd: __dirname });
      execSync('pm2 save', { stdio: 'pipe' });

      console.log(c.green('\n  ✅ Watcher started in background\n'));
      console.log(`  ${c.cyan('Check status:')}  node watcher.js status`);
      console.log(`  ${c.cyan('View logs:')}     pm2 logs ${PM2_NAME}`);
      console.log(`  ${c.cyan('Stop:')}          node watcher.js stop\n`);
    } catch (err) {
      console.log(c.red(`\n  ✖ Failed to start: ${err.message}\n`));
    }

  } else if (mode === '2') {
    // --- Interactive: run watcher-core.js in foreground ---
    const coreArgs = [];
    if (user) coreArgs.push('--user', user);
    if (id) coreArgs.push('--id', id);

    const envIdx = args.indexOf('--env');
    const envPath = envIdx !== -1 ? args[envIdx + 1] : '.env';
    coreArgs.push('--env', envPath);

    if (args.includes('--log')) coreArgs.push('--log');
    if (args.includes('--force')) coreArgs.push('--force');

    const child = spawn('node', [CORE_SCRIPT, ...coreArgs], {
      stdio: 'inherit',
      cwd: __dirname,
    });

    child.on('close', (code) => process.exit(code || 0));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));

  } else {
    console.log(c.red('  ✖ Invalid choice. Enter 1 or 2.\n'));
  }
}

// ═══════════════════════════════════════════════════════════════
//  Command: stop
// ═══════════════════════════════════════════════════════════════
function cmdStop() {
  if (!pm2Installed()) {
    console.log(c.red('  ✖ PM2 is not installed.\n'));
    return;
  }

  try {
    execSync(`pm2 stop ${PM2_NAME}`, { stdio: 'pipe' });
    execSync(`pm2 delete ${PM2_NAME}`, { stdio: 'pipe' });
    execSync('pm2 save', { stdio: 'pipe' });
    console.log(c.green('  ✅ Watcher stopped.\n'));
  } catch {
    console.log(c.yellow('  ⚠ No running watcher found.\n'));
  }
}

// ═══════════════════════════════════════════════════════════════
//  Command: status
// ═══════════════════════════════════════════════════════════════
function cmdStatus() {
  const state = readState();

  // Check PM2
  let pm2Running = false;
  let pm2Info = null;
  if (pm2Installed()) {
    try {
      const raw = execSync('pm2 jlist', { stdio: 'pipe' }).toString();
      const processes = JSON.parse(raw);
      pm2Info = processes.find(p => p.name === PM2_NAME);
      pm2Running = pm2Info && pm2Info.pm2_env?.status === 'online';
    } catch {}
  }

  console.log();
  console.log('  ┌───────────────────────────────────────────┐');
  console.log('  │  ' + c.bold('X Watcher v3.0      ') + '                    │');
  console.log('  ├───────────────────────────────────────────┤');

  if (!state && !pm2Running) {
    console.log('  │  Status:     ' + c.gray('NOT RUNNING') + '                  │');
    console.log('  └───────────────────────────────────────────┘\n');
    return;
  }

  // Status line
  const st = state?.status || 'UNKNOWN';
  let statusDisplay;
  switch (st) {
    case 'WATCHING':    statusDisplay = c.green('🟢 WATCHING'); break;
    case 'RECORDING':   statusDisplay = c.red('🔴 RECORDING'); break;
    case 'DOWNLOADING': statusDisplay = c.magenta('📥 DOWNLOADING'); break;
    case 'STOPPED':     statusDisplay = c.gray('⏹  STOPPED'); break;
    case 'ERROR':       statusDisplay = c.red('🔴 ERROR'); break;
    default:            statusDisplay = c.yellow(st);
  }

  const mode = state?.mode === 'minimal' ? 'Minimalistic' : 'Interactive';
  const allUsersCount = (state?.users || []).length;
  const spaceUsersCount = (state?.spaceUsers || []).length;
  const tweetUsersCount = (state?.tweetUsers || []).length;
  const uptime = state?.startedAt ? timeAgo(state.startedAt) : '—';
  const lastPoll = state?.lastPoll ? timeAgo(state.lastPoll) : '—';
  const checks = state?.pollCount || 0;
  const recordings = (state?.recordings || []).length;
  const seenTweets = state?.totalSeenTweets || 0;

  const pad = (label, value, width = 41) => {
    const line = `  │  ${label}${value}`;
    return line + ' '.repeat(Math.max(0, width - line.length + 4)) + '│';
  };

  console.log(pad('Status:     ', statusDisplay));

  if (pm2Running) {
    console.log(pad('Process:    ', c.green('PM2 online')));
  } else if (pm2Info) {
    console.log(pad('Process:    ', c.red('PM2 ' + (pm2Info.pm2_env?.status || 'offline'))));
  }

  console.log(pad('Mode:       ', mode));
  console.log(pad('Users:      ', `${allUsersCount} total`));
  console.log(pad('Started:    ', uptime));

  console.log('  ├───────────────────────────────────────────┤');
  console.log(pad('🎙 Spaces:   ', `${spaceUsersCount} watched`));
  console.log(pad('  Polls:    ', String(checks)));
  console.log(pad('  Recorded: ', `${recordings} total`));

  console.log('  ├───────────────────────────────────────────┤');
  console.log(pad('📝 Tweets:   ', `${tweetUsersCount} watched`));
  console.log(pad('  Captured: ', `${seenTweets} total`));

  // Show active spaces
  if (state?.activeSpaces?.length) {
    console.log('  ├───────────────────────────────────────────┤');
    for (const sp of state.activeSpaces) {
      console.log(pad('  Space:    ', `"${sp.title}"`));
      console.log(pad('  By:       ', `@${sp.user}`));
      console.log(pad('  Since:    ', timeAgo(sp.startedAt)));
    }
  }

  // Show last error
  if (state?.lastError) {
    console.log('  ├───────────────────────────────────────────┤');
    console.log(pad('Error:      ', c.red(state.lastError)));
  }

  console.log('  └───────────────────────────────────────────┘\n');

  // Show recent recordings
  if (state?.recordings?.length) {
    const recent = state.recordings.slice(-5).reverse();
    console.log('  ' + c.bold('Recent recordings:'));
    for (const rec of recent) {
      console.log(`    ${c.gray('•')} ${rec.title} by @${rec.user} (${rec.duration}) — ${timeAgo(rec.recordedAt)}`);
    }
    console.log();
  }
}

// ═══════════════════════════════════════════════════════════════
//  Command: logs
// ═══════════════════════════════════════════════════════════════
function cmdLogs() {
  if (!pm2Installed()) {
    console.log(c.red('  ✖ PM2 is not installed.\n'));
    return;
  }
  console.log(c.cyan(`  Tailing logs for ${PM2_NAME}... (Press Ctrl+C to exit)\n`));
  try {
    execSync(`pm2 logs ${PM2_NAME}`, { stdio: 'inherit' });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
//  Command: switch
// ═══════════════════════════════════════════════════════════════
async function cmdSwitch() {
  const state = readState();
  let pm2Running = false;
  if (pm2Installed()) {
    try {
      const raw = execSync('pm2 jlist', { stdio: 'pipe' }).toString();
      const processes = JSON.parse(raw);
      const pm2Info = processes.find(p => p.name === PM2_NAME);
      pm2Running = pm2Info && pm2Info.pm2_env?.status === 'online';
    } catch {}
  }

  if (!state || (!pm2Running && state.status === 'STOPPED')) {
    console.log(c.yellow('  ⚠ Watcher is not running. Use "node watcher.js start" to start it.\n'));
    return;
  }

  const users = (state.users || []).join(',');
  if (!users) {
     console.log(c.red('  ✖ Cannot determine monitored users from state.\n'));
     return;
  }

  if (state.mode === 'minimal') {
    // Switch Minimal -> Interactive
    console.log(c.cyan('  Current mode: ') + c.bold('Minimal (Background)'));
    const confirm = await ask(`  Switch to Interactive (Foreground)? ${c.gray('(y/N)')}: `);
    if (confirm.toLowerCase() !== 'y') {
       console.log('  Canceled.\n');
       return;
    }

    cmdStop();

    console.log(c.green('\n  Starting interactive watcher in foreground...\n'));
    const coreArgs = ['--user', users];
    const child = spawn('node', [CORE_SCRIPT, ...coreArgs], {
      stdio: 'inherit',
      cwd: __dirname,
    });
    child.on('close', (code) => process.exit(code || 0));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));

  } else {
    // Switch Interactive -> Minimal
    console.log(c.cyan('  Current mode: ') + c.bold('Interactive (Foreground)'));
    console.log(c.gray('  To switch to Minimal mode (background):'));
    console.log(c.gray('  1. Go to the terminal where the watcher is currently running.'));
    console.log(c.gray('  2. Press ') + c.bold('Ctrl+C') + c.gray(' to stop it.'));
    console.log(c.gray('  3. Run this command:\n'));
    console.log(c.bold(`       node watcher.js start --user ${users} --minimal\n`));
  }
}

// ═══════════════════════════════════════════════════════════════
//  Command: setup
// ═══════════════════════════════════════════════════════════════
async function cmdSetup() {
  banner();
  console.log('  ' + c.bold('First-time setup wizard\n'));

  // 1. Twitter tokens
  console.log(c.cyan('  ── Twitter Tokens ──────────────────────────'));
  console.log(c.gray('  Get these from browser DevTools → Application → Cookies\n'));

  const currentEnv = readEnv();
  const currentAuth = currentEnv.TWITTER_AUTH_TOKEN;
  const currentCsrf = currentEnv.TWITTER_CSRF_TOKEN;

  if (currentAuth) {
    console.log(c.gray(`  Current auth_token: ${currentAuth.substring(0, 8)}****`));
  }

  const authToken = await ask(`  auth_token ${c.gray('(press Enter to keep current)')}: `);
  if (authToken) writeEnvKey('TWITTER_AUTH_TOKEN', authToken);

  const csrfToken = await ask(`  ct0 (csrf) ${c.gray('(press Enter to keep current)')}: `);
  if (csrfToken) writeEnvKey('TWITTER_CSRF_TOKEN', csrfToken);

  // 2. Telegram
  console.log(c.cyan('\n  ── Telegram Notifications ──────────────────'));
  console.log(c.gray('  1. Message @BotFather on Telegram → /newbot'));
  console.log(c.gray('  2. Add the bot to your group'));
  console.log(c.gray('  3. Send a message in the group'));
  console.log(c.gray('  4. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates'));
  console.log(c.gray('  5. Look for "chat":{"id": ... }  (should start with -100 for groups)\n'));

  const botToken = await ask(`  Bot token ${c.gray('(press Enter to skip)')}: `);
  if (botToken) writeEnvKey('TELEGRAM_BOT_TOKEN', botToken);

  const chatId = await ask(`  Chat ID ${c.gray('(starts with -100 for groups)')}: `);
  if (chatId) writeEnvKey('TELEGRAM_CHAT_ID', chatId);
  
  if (botToken && chatId) {
    console.log(c.cyan('\n  ── Topic Thread IDs ────────────────────────'));
    console.log(c.gray('  These route uploads to specific Topics in your group.\n'));

    const audioId = await ask(`  Audio Topic Thread ID ${c.gray('(press Enter to skip)')}: `);
    if (audioId) writeEnvKey('TELEGRAM_AUDIO_THREAD_ID', audioId);

    const metaId = await ask(`  Metadata Topic Thread ID ${c.gray('(press Enter to skip)')}: `);
    if (metaId) writeEnvKey('TELEGRAM_METADATA_THREAD_ID', metaId);

    const tweetId = await ask(`  Tweet Screenshot Topic Thread ID ${c.gray('(press Enter to skip)')}: `);
    if (tweetId) writeEnvKey('TELEGRAM_TWEET_THREAD_ID', tweetId);

    console.log(c.cyan('\n  ── 50MB Upload Bypass (Docker) ─────────────'));
    console.log(c.gray('  To upload large files, we run a Local Telegram Bot API Server via Docker.'));
    console.log(c.gray('  Get your API ID and Hash from https://my.telegram.org\n'));

    const apiId = await ask(`  API ID ${c.gray('(press Enter to skip)')}: `);
    if (apiId) writeEnvKey('TELEGRAM_API_ID', apiId);

    const apiHash = await ask(`  API Hash ${c.gray('(press Enter to skip)')}: `);
    if (apiHash) writeEnvKey('TELEGRAM_API_HASH', apiHash);

    if (apiId && apiHash) {
      writeEnvKey('TELEGRAM_API_URL', 'http://127.0.0.1:8081');
      console.log(c.gray('\n  To start the local server, run:'));
      console.log(c.bold('    docker compose up -d\n'));
    }
  }

  // Test Telegram
  if (botToken && chatId) {
    process.env.TELEGRAM_BOT_TOKEN = botToken;
    process.env.TELEGRAM_CHAT_ID = chatId;
    const { testTelegram } = require('./notify');
    const ok = await testTelegram();
    if (ok) {
      console.log(c.green('\n  ✅ Telegram test message sent!'));
    } else {
      console.log(c.yellow('\n  ⚠ Could not send test message. Check your token and chat ID.'));
    }
  }

  console.log(c.green('\n  ✅ Setup complete! Config saved to .env\n'));
  console.log(`  Start watching: ${c.bold('node watcher.js start --user <username>')}\n`);
}

// ═══════════════════════════════════════════════════════════════
//  Command: update-tokens
// ═══════════════════════════════════════════════════════════════
async function cmdUpdateTokens() {
  banner();
  console.log('  ' + c.bold('Update Twitter Tokens\n'));
  console.log(c.gray('  Get these from browser DevTools → Application → Cookies\n'));

  const authToken = await ask('  auth_token: ');
  if (!authToken) {
    console.log(c.red('  ✖ auth_token is required.\n'));
    return;
  }

  const csrfToken = await ask('  ct0 (csrf): ');
  if (!csrfToken) {
    console.log(c.red('  ✖ ct0 is required.\n'));
    return;
  }

  writeEnvKey('TWITTER_AUTH_TOKEN', authToken);
  writeEnvKey('TWITTER_CSRF_TOKEN', csrfToken);

  console.log(c.green('\n  ✅ Tokens updated in .env\n'));

  // Restart PM2 if running
  if (pm2Installed()) {
    try {
      const raw = execSync('pm2 jlist', { stdio: 'pipe' }).toString();
      const processes = JSON.parse(raw);
      const proc = processes.find(p => p.name === PM2_NAME);
      if (proc && proc.pm2_env?.status === 'online') {
        execSync(`pm2 restart ${PM2_NAME}`, { stdio: 'pipe' });
        console.log(c.green('  ✅ Watcher restarted with new tokens.\n'));
      }
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
//  Command Router
// ═══════════════════════════════════════════════════════════════
const args = process.argv.slice(2);
const command = args[0];

async function run() {
  switch (command) {
    case 'start':
      await cmdStart(args.slice(1));
      break;

    case 'stop':
      cmdStop();
      break;

    case 'status':
      cmdStatus();
      break;

    case 'logs':
      cmdLogs();
      break;

    case 'switch':
      await cmdSwitch();
      break;

    case 'setup':
      await cmdSetup();
      break;

    case 'update-tokens':
      await cmdUpdateTokens();
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      banner();
      console.log('  ' + c.bold('Commands:\n'));
      console.log(`    ${c.cyan('start')}           Start the watcher`);
      console.log(`      --user <USER>   Username(s) to watch (comma-separated)`);
      console.log(`      --id <ID>       Download specific Space by ID`);
      console.log(`      --minimal       Run in background (PM2 daemon)`);
      console.log(`      --interactive   Run in foreground with full output`);
      console.log(`      --env <PATH>    Path to .env file (default: .env)`);
      console.log(`      --log           Enable file logging`);
      console.log(`      --force         Force download (with --id)`);
      console.log();
      console.log(`    ${c.cyan('stop')}            Stop the background watcher`);
      console.log(`    ${c.cyan('status')}          Show current watcher status`);
      console.log(`    ${c.cyan('logs')}            View live logs of background watcher`);
      console.log(`    ${c.cyan('switch')}          Switch between Background and Foreground mode`);
      console.log(`    ${c.cyan('setup')}           First-time setup wizard`);
      console.log(`    ${c.cyan('update-tokens')}   Update Twitter tokens manually`);
      console.log(`    ${c.cyan('help')}            Show this help\n`);
      break;

    default:
      console.log(c.red(`\n  ✖ Unknown command: ${command}`));
      console.log(c.gray('  Run "node watcher.js help" to see available commands.\n'));
  }
}

run().catch((err) => {
  console.error(c.red(`  ✖ ${err.message}`));
  process.exit(1);
});
