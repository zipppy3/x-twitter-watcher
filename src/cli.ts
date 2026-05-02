#!/usr/bin/env node
import { Command } from 'commander';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadAppConfig } from './config/app-config';
import { SqliteStorage } from './storage/sqlite-storage';
import { isProcessRunning, readPidFile } from './runtime/pid-file';
import { migrateFromV1 } from './storage/migrate-v1';
import { rootLogger } from './runtime/logger';
import { modeToFlags, normalizeUsername } from './services/watchlist-service';
import { formatUptime } from './utils/time';
import { runDaemon } from './daemon';
import { TelegramBotApiClient } from './adapters/telegram-client';
import { deleteUserDownloads, DeleteTarget } from './services/download-manager';
import { ask, banner, c } from './utils/prompt';
import { readEnv, updateEnvKey } from './utils/env';
import { setupBrowserProfile } from './utils/refresh-tokens';


function createStorage(env?: string, db?: string, downloadRoot?: string) {
  const config = loadAppConfig({ envPath: env, dbPath: db, downloadRoot });
  const storage = new SqliteStorage(config.dbPath);
  storage.init();
  return { config, storage };
}

async function cmdStart(options: { env?: string; db?: string; downloadRoot?: string; foreground?: boolean }) {
  const { config, storage } = createStorage(options.env, options.db, options.downloadRoot);
  storage.close();

  const pid = readPidFile(config.pidPath);
  if (isProcessRunning(pid)) {
    console.log(`Watcher v2 is already running (pid ${pid}).`);
    return;
  }

  let isForeground = options.foreground;
  if (isForeground === undefined && process.stdin.isTTY) {
    banner();
    console.log('  Select mode:\n');
    console.log(`    ${c.bold('[1]')} Minimalistic — runs silently in background`);
    console.log(`    ${c.bold('[2]')} Interactive  — full terminal experience\n`);
    const mode = await ask(`  Choice ${c.gray('(1/2)')}: `);
    if (mode === '2') {
      isForeground = true;
    } else if (mode !== '1') {
      console.log(c.red('  ✖ Invalid choice. Enter 1 or 2.\n'));
      return;
    }
  }

  if (isForeground) {
    await runDaemon({ env: options.env, db: options.db, downloadRoot: options.downloadRoot, mode: 'foreground' });
    return;
  }

  const daemonEntry = path.join(config.packageRoot, 'dist', 'daemon.js');
  const child = spawn(process.execPath, [daemonEntry, '--mode', 'daemon', ...(options.env ? ['--env', options.env] : []), ...(options.db ? ['--db', options.db] : []), ...(options.downloadRoot ? ['--download-root', options.downloadRoot] : [])], {
    cwd: config.packageRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log(c.green(`\n  ✅ Watcher v2 started in the background (pid ${child.pid}).\n`));
}

function cmdStop(options: { env?: string; db?: string; downloadRoot?: string }) {
  const { config, storage } = createStorage(options.env, options.db, options.downloadRoot);
  storage.close();

  const pid = readPidFile(config.pidPath);
  if (!isProcessRunning(pid)) {
    console.log('Watcher v2 is not running.');
    return;
  }

  process.kill(pid!, 'SIGTERM');
  console.log(`Sent SIGTERM to watcher v2 (pid ${pid}).`);
}

function cmdStatus(options: { env?: string; db?: string; downloadRoot?: string }) {
  const { config, storage } = createStorage(options.env, options.db, options.downloadRoot);
  const runtime = storage.getRuntimeState();
  const targets = storage.getWatchTargets();
  const pid = readPidFile(config.pidPath);
  const running = isProcessRunning(pid);
  const replyUsers = targets.filter((target) => target.watchReplies).length;

  banner();
  console.log('  ' + c.bold('Watcher v2 Status\n'));

  console.log(`  ${c.cyan('Status:')}    ${running ? c.green('Running') : c.red('Stopped')}`);
  console.log(`  ${c.cyan('PID:')}       ${pid ?? 'n/a'}`);
  console.log(`  ${c.cyan('State:')}     ${runtime.status}`);
  console.log(`  ${c.cyan('Mode:')}      ${runtime.mode}`);
  console.log(`  ${c.cyan('Uptime:')}    ${formatUptime(runtime.startedAt)}`);
  console.log('');
  console.log(`  ${c.cyan('Watchlist:')} ${targets.filter((t) => t.watchSpaces).length} Spaces, ${targets.filter((t) => t.watchTweets).length} Tweets (${replyUsers} Replies)`);
  console.log(`  ${c.cyan('Activity:')}  ${runtime.pollCount} Polls, ${storage.getSeenTweetCount()} Tweets, ${storage.getRecordingCount()} Recordings`);
  
  const activeSpacesText = runtime.activeSpaces.length ? runtime.activeSpaces.map((space) => `"${space.title}"`).join(', ') : 'none';
  console.log(`  ${c.cyan('Spaces:')}    ${activeSpacesText}`);
  
  if (runtime.lastError) {
    console.log(`  ${c.red('Error:')}     ${runtime.lastError}`);
  }
  
  console.log('');
  storage.close();
}

function cmdAdd(username: string, options: { env?: string; db?: string; downloadRoot?: string; spaces?: boolean; tweets?: boolean; replies?: boolean; noMedia?: boolean; noScreenshots?: boolean; noMetadata?: boolean }) {
  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  const normalized = normalizeUsername(username);
  const mode = options.spaces && !options.tweets ? 'spaces' : options.tweets && !options.spaces ? 'tweets' : 'all';
  const flags = modeToFlags(mode);
  const target = storage.upsertWatchTarget({
    username: normalized,
    ...flags,
    watchReplies: Boolean(options.replies),
    saveMedia: options.noMedia ? false : undefined,
    saveScreenshots: options.noScreenshots ? false : undefined,
    saveMetadata: options.noMetadata ? false : undefined,
  });
  storage.close();

  const watching: string[] = [];
  if (target.watchSpaces) {
    watching.push('Spaces');
  }
  if (target.watchTweets) {
    watching.push('Tweets');
  }
  if (target.watchReplies) {
    watching.push('Replies');
  }
  const saveFlags = [
    target.saveMedia ? 'Media' : null,
    target.saveScreenshots ? 'Screenshots' : null,
    target.saveMetadata ? 'Metadata' : null,
  ].filter(Boolean);
  console.log(`Added @${normalized} to v2 watchlist.`);
  console.log(`Watching: ${watching.join(' + ')}`);
  console.log(`Saving: ${saveFlags.length ? saveFlags.join(' + ') : 'nothing (all disabled)'}`);
}

function cmdList(options: { env?: string; db?: string; downloadRoot?: string }) {
  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  const users = storage.getWatchTargets();
  storage.close();

  if (!users.length) {
    console.log('\n  Watchlist is empty.\n');
    return;
  }

  banner();
  console.log(`  ${c.bold(`Watchlist (${users.length} users)`)}\n`);
  for (const target of users) {
    const flags = [];
    if (target.watchSpaces) flags.push('Spaces');
    if (target.watchTweets) flags.push('Tweets');
    if (target.watchReplies) flags.push('Replies');
    
    const saveIcons = [
      target.saveMedia ? 'Media(ON)' : '',
      target.saveScreenshots ? 'Screenshots(ON)' : '',
      target.saveMetadata ? 'Metadata(ON)' : ''
    ].filter(Boolean).join(', ');

    console.log(`  - ${c.cyan('@' + target.username)}`);
    console.log(`    Watching: ${flags.join(', ')}`);
    console.log(`    Saving:   ${saveIcons || '(all disabled)'}`);
    console.log('');
  }
}

function cmdRemove(username: string, options: { env?: string; db?: string; downloadRoot?: string }) {
  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  const normalized = normalizeUsername(username);
  const removed = storage.removeWatchTarget(normalized);
  if (removed) {
    storage.deleteSeenTweets(normalized);
  }
  storage.close();

  if (removed) {
    console.log(c.green(`\n  ✅ Removed @${normalized} from watchlist.\n`));
  } else {
    console.log(c.yellow(`\n  ⚠ @${normalized} was not in the watchlist.\n`));
  }
}

function cmdDelete(username: string, target: DeleteTarget, options: { env?: string; db?: string; downloadRoot?: string }) {
  const { config } = createStorage(options.env, options.db, options.downloadRoot); // just to get config paths
  const normalized = normalizeUsername(username);
  const result = deleteUserDownloads(config.downloadRoot, normalized, target);
  
  const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
  if (result.deletedCount > 0) {
    console.log(c.green(`\n  ✅ Deleted ${target} data for @${normalized}`));
    console.log(`  Files removed: ${result.deletedCount}`);
    console.log(`  Space freed:   ${freedMb} MB\n`);
  } else {
    console.log(c.yellow(`\n  ⚠ No downloaded data found for @${normalized} (${target}).\n`));
  }
}

function cmdExport(exportPath: string, options: { env?: string; db?: string; downloadRoot?: string }) {
  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  const users = storage.getWatchTargets();
  storage.close();

  fs.writeFileSync(exportPath, JSON.stringify(users, null, 2), 'utf-8');
  console.log(c.green(`\n  ✅ Exported ${users.length} users to ${exportPath}\n`));
}

function cmdImport(importPath: string, options: { env?: string; db?: string; downloadRoot?: string }) {
  if (!fs.existsSync(importPath)) {
    console.log(c.red(`\n  ✖ File not found: ${importPath}\n`));
    return;
  }

  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  try {
    const data = JSON.parse(fs.readFileSync(importPath, 'utf-8'));
    if (!Array.isArray(data)) {
      throw new Error('Expected JSON array');
    }

    let count = 0;
    for (const item of data) {
      if (item.username) {
        storage.upsertWatchTarget({
          username: item.username,
          userId: item.userId,
          watchSpaces: item.watchSpaces,
          watchTweets: item.watchTweets,
          watchReplies: item.watchReplies,
          saveMedia: item.saveMedia,
          saveScreenshots: item.saveScreenshots,
          saveMetadata: item.saveMetadata,
        });
        count++;
      }
    }
    console.log(c.green(`\n  ✅ Imported ${count} users from ${importPath}\n`));
  } catch (err) {
    console.log(c.red(`\n  ✖ Failed to import: ${(err as Error).message}\n`));
  } finally {
    storage.close();
  }
}

async function cmdBackup(destinationPath: string, options: { env?: string; db?: string; downloadRoot?: string }) {
  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  try {
    await storage.backup(destinationPath);
    console.log(c.green(`\n  ✅ Database backed up to ${destinationPath}\n`));
  } catch (err) {
    console.log(c.red(`\n  ✖ Backup failed: ${(err as Error).message}\n`));
  } finally {
    storage.close();
  }
}

function cmdDoctor(options: { env?: string; db?: string; downloadRoot?: string }) {
  const { config, storage } = createStorage(options.env, options.db, options.downloadRoot);
  
  banner();
  console.log('  ' + c.bold('System Health Check\n'));

  // DB Integrity
  const isOk = storage.checkIntegrity();
  if (isOk) {
    console.log(`  ${c.cyan('Database Integrity:')} ${c.green('OK')}`);
  } else {
    console.log(`  ${c.cyan('Database Integrity:')} ${c.red('FAILED')}`);
  }

  // File System Access
  try {
    fs.mkdirSync(config.downloadRoot, { recursive: true });
    fs.accessSync(config.downloadRoot, fs.constants.R_OK | fs.constants.W_OK);
    console.log(`  ${c.cyan('Download Directory:')} ${c.green('Writable')} (${config.downloadRoot})`);
  } catch (err) {
    console.log(`  ${c.cyan('Download Directory:')} ${c.red('Not Writable')} (${(err as Error).message})`);
  }

  storage.close();
  console.log('');
}

function cmdCleanup(options: { env?: string; db?: string; downloadRoot?: string }) {
  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  const RETENTION_DAYS = 30; // Defaulting to 30 days as per user's approval
  
  const oldRecords = storage.deleteOldRecordings(RETENTION_DAYS);
  let filesDeleted = 0;
  
  for (const record of oldRecords) {
    try {
      if (fs.existsSync(record.filePath)) {
        fs.rmSync(record.filePath, { force: true });
        filesDeleted++;
      }
      if (record.metadataPath && fs.existsSync(record.metadataPath)) {
        fs.rmSync(record.metadataPath, { force: true });
        filesDeleted++;
      }
    } catch (err) {
      console.log(c.yellow(`  ⚠ Failed to delete files for recording ${record.id}: ${(err as Error).message}`));
    }
  }

  storage.close();
  console.log(c.green(`\n  ✅ Cleanup complete. Deleted ${oldRecords.length} old DB records and ${filesDeleted} files.\n`));
}

function cmdMigrate(options: { env?: string; db?: string; downloadRoot?: string; sourceRoot?: string }) {
  const { config, storage } = createStorage(options.env, options.db, options.downloadRoot);
  const result = migrateFromV1({
    storage,
    sourceRoot: options.sourceRoot ?? config.projectRoot,
    logger: rootLogger.child('migrate-v1'),
  });
  storage.close();
  console.log(`Imported users: ${result.importedUsers}`);
  console.log(`Imported seen tweets: ${result.importedSeenTweets}`);
  console.log(`Imported recordings: ${result.importedRecordings}`);
}

async function cmdSetup(options: { env?: string }) {
  const { config, storage } = createStorage(options.env);
  storage.close(); // Only needed to bootstrap config paths
  
  banner();
  console.log('  ' + c.bold('First-time setup wizard\n'));

  console.log(c.cyan('  ── Twitter Tokens ──────────────────────────'));
  console.log(c.gray('  Get these from browser DevTools → Application → Cookies\n'));

  const currentEnv = readEnv(config.envPath);
  const currentAuth = currentEnv.TWITTER_AUTH_TOKEN;

  if (currentAuth) {
    console.log(c.gray(`  Current auth_token: ${currentAuth.substring(0, 8)}****`));
  }

  const authToken = await ask(`  auth_token ${c.gray('(press Enter to keep current)')}: `);
  if (authToken) updateEnvKey(config.envPath, 'TWITTER_AUTH_TOKEN', authToken);

  const csrfToken = await ask(`  ct0 (csrf) ${c.gray('(press Enter to keep current)')}: `);
  if (csrfToken) updateEnvKey(config.envPath, 'TWITTER_CSRF_TOKEN', csrfToken);

  console.log(c.cyan('\n  ── Telegram Notifications ──────────────────'));
  console.log(c.gray('  1. Message @BotFather on Telegram → /newbot'));
  console.log(c.gray('  2. Add the bot to your group'));
  console.log(c.gray('  3. Send a message in the group'));
  console.log(c.gray('  4. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates'));
  console.log(c.gray('  5. Look for "chat":{"id": ... }  (should start with -100 for groups)\n'));

  const botToken = await ask(`  Bot token ${c.gray('(press Enter to skip)')}: `);
  if (botToken) updateEnvKey(config.envPath, 'TELEGRAM_BOT_TOKEN', botToken);

  const chatId = await ask(`  Chat ID ${c.gray('(starts with -100 for groups)')}: `);
  if (chatId) updateEnvKey(config.envPath, 'TELEGRAM_CHAT_ID', chatId);
  
  const activeBotToken = botToken || currentEnv.TELEGRAM_BOT_TOKEN;
  const activeChatId = chatId || currentEnv.TELEGRAM_CHAT_ID;

  if (activeBotToken && activeChatId) {
    console.log(c.cyan('\n  ── Topic Thread IDs ────────────────────────'));
    console.log(c.gray('  These route uploads to specific Topics in your group.\n'));

    const audioId = await ask(`  Audio Topic Thread ID ${c.gray('(press Enter to skip)')}: `);
    if (audioId) updateEnvKey(config.envPath, 'TELEGRAM_AUDIO_THREAD_ID', audioId);

    const metaId = await ask(`  Metadata Topic Thread ID ${c.gray('(press Enter to skip)')}: `);
    if (metaId) updateEnvKey(config.envPath, 'TELEGRAM_METADATA_THREAD_ID', metaId);

    const tweetId = await ask(`  Tweet Screenshot Topic Thread ID ${c.gray('(press Enter to skip)')}: `);
    if (tweetId) updateEnvKey(config.envPath, 'TELEGRAM_TWEET_THREAD_ID', tweetId);

    const tweetMetaId = await ask(`  Tweet JSON Metadata Topic Thread ID ${c.gray('(press Enter to skip)')}: `);
    if (tweetMetaId) updateEnvKey(config.envPath, 'TELEGRAM_TWEET_METADATA_THREAD_ID', tweetMetaId);

    console.log(c.cyan('\n  ── 50MB Upload Bypass (Docker) ─────────────'));
    console.log(c.gray('  To upload large files, we run a Local Telegram Bot API Server via Docker.'));
    console.log(c.gray('  Get your API ID and Hash from https://my.telegram.org\n'));

    const apiId = await ask(`  API ID ${c.gray('(press Enter to skip)')}: `);
    if (apiId) updateEnvKey(config.envPath, 'TELEGRAM_API_ID', apiId);

    const apiHash = await ask(`  API Hash ${c.gray('(press Enter to skip)')}: `);
    if (apiHash) updateEnvKey(config.envPath, 'TELEGRAM_API_HASH', apiHash);

    if (apiId && apiHash) {
      updateEnvKey(config.envPath, 'TELEGRAM_API_URL', 'http://127.0.0.1:8081');
      console.log(c.gray('\n  To start the local server, run:'));
      console.log(c.cyanBold('    docker compose up -d\n'));
    }

    // Test Telegram ping
    const testConfig = loadAppConfig({ envPath: options.env }); // Reload fresh config
    const testBot = new TelegramBotApiClient(testConfig);
    if (testBot.isConfigured()) {
      const ok = await testBot.sendMessage('<b>Test Message</b>\n\nV2 Setup Wizard complete!');
      if (ok) {
        console.log(c.green('\n  ✅ Telegram test message sent!'));
      } else {
        console.log(c.yellow('\n  ⚠ Could not send test message. Check your token and chat ID.'));
      }
    }
  }

  // Validate against .env.example for missing keys
  const examplePath = path.join(config.packageRoot, '.env.example');
  if (fs.existsSync(examplePath)) {
    const exampleEnv = readEnv(examplePath);
    const currentFinalEnv = readEnv(config.envPath);
    const missingKeys = Object.keys(exampleEnv).filter(
      (key) => !(key in currentFinalEnv) || currentFinalEnv[key] === ''
    );
    if (missingKeys.length > 0) {
      console.log(c.yellow(`\n  ⚠ Missing .env keys (compared to .env.example):`));
      for (const key of missingKeys) {
        console.log(c.gray(`    - ${key}`));
      }
    }
  }

  console.log(c.green('\n  ✅ Setup complete! Config saved to .env\n'));
  console.log(`  Start watching: ${c.bold('npm run dev')} or ${c.bold('npm run start')}\n`);
}

async function cmdUpdateTokens(options: { env?: string }) {
  const { config, storage } = createStorage(options.env);
  storage.close();

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

  updateEnvKey(config.envPath, 'TWITTER_AUTH_TOKEN', authToken);
  updateEnvKey(config.envPath, 'TWITTER_CSRF_TOKEN', csrfToken);

  console.log(c.green('\n  ✅ Tokens updated in .env\n'));
  console.log(c.gray('  If watcher is running, it will read new tokens upon next restart.'));
}

async function cmdLogin(options: { env?: string }) {
  const { config, storage } = createStorage(options.env);
  storage.close();

  const profileDir = path.join(config.packageRoot, '.browser-profile');
  const success = await setupBrowserProfile(profileDir, config.envPath);

  if (success) {
    console.log(c.green('\n  ✅ Browser login successful.'));
  } else {
    console.log(c.red('\n  ✖ Browser login failed.'));
    process.exit(1);
  }
}

async function cmdSwitch(options: { env?: string; db?: string; downloadRoot?: string }) {
  const { config, storage } = createStorage(options.env, options.db, options.downloadRoot);
  storage.close();

  const pid = readPidFile(config.pidPath);
  if (!isProcessRunning(pid)) {
    console.log(c.yellow('  ⚠ Watcher v2 is not running.\n'));
    return;
  }

  console.log(c.cyan('  Current mode: ') + c.bold('Minimal (Background)'));
  const confirm = await ask(`  Switch to Interactive (Foreground)? ${c.gray('(y/N)')}: `);
  if (confirm.toLowerCase() !== 'y') {
     console.log('  Canceled.\n');
     return;
  }

  process.kill(pid!, 'SIGTERM');
  console.log(c.green('\n  Stopped background service. Starting interactive watcher in foreground...\n'));
  
  // Wait a moment for graceful shutdown
  await new Promise(r => setTimeout(r, 1000));
  await runDaemon({ env: options.env, db: options.db, downloadRoot: options.downloadRoot, mode: 'foreground' });
}

function cmdUpdate() {
  banner();
  console.log('  ' + c.bold('Updating X Watcher v2...\n'));

  try {
    console.log(c.cyan('  [1/3] Pulling latest changes...'));
    try {
      execSync('git pull', { stdio: 'inherit', cwd: process.cwd() });
    } catch {
      console.log(c.yellow('  ⚠ Git pull failed (not a git repo or no remote). Skipping.'));
    }

    console.log(c.cyan('\n  [2/3] Updating npm packages...'));
    execSync('npm install', { stdio: 'inherit', cwd: process.cwd() });
    
    console.log(c.cyan('\n  [3/3] Playwright browser refresh...'));
    try {
      execSync('npx playwright install chromium', { stdio: 'inherit', cwd: process.cwd() });
    } catch {
      console.log(c.yellow('  ⚠ Playwright update skipped.'));
    }

    console.log(c.green('\n  ✅ Update complete!\n'));
    console.log(c.gray('  If PM2 is wrapping your daemon, or if running detached, restart manualy to apply changes.\n'));
  } catch (err) {
    console.log(c.red(`\n  ✖ Update failed: ${(err as Error).message}\n`));
  }
}

const program = new Command();

function parseBoolFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

function cmdConfig(username: string, options: { env?: string; db?: string; downloadRoot?: string; media?: string; screenshots?: string; metadata?: string }) {
  const { storage } = createStorage(options.env, options.db, options.downloadRoot);
  const normalized = normalizeUsername(username);
  const target = storage.getWatchTarget(normalized);

  if (!target) {
    console.log(c.red(`  ✖ @${normalized} is not in the watchlist.\n`));
    storage.close();
    return;
  }

  const mediaFlag = parseBoolFlag(options.media);
  const screenshotsFlag = parseBoolFlag(options.screenshots);
  const metadataFlag = parseBoolFlag(options.metadata);

  // If no flags specified, just show current settings
  if (mediaFlag === undefined && screenshotsFlag === undefined && metadataFlag === undefined) {
    banner();
    console.log(`  ${c.bold(`Save settings for @${normalized}`)}\n`);
    const icon = (v: boolean) => v ? c.green('✓ ON') : c.red('✗ OFF');
    console.log(`  ${c.cyan('Media:')}       ${icon(target.saveMedia)}`);
    console.log(`  ${c.cyan('Screenshots:')} ${icon(target.saveScreenshots)}`);
    console.log(`  ${c.cyan('Metadata:')}    ${icon(target.saveMetadata)}`);
    console.log('');
    storage.close();
    return;
  }

  // Apply changes
  const updates: { saveMedia?: boolean; saveScreenshots?: boolean; saveMetadata?: boolean } = {};
  if (mediaFlag !== undefined) updates.saveMedia = mediaFlag;
  if (screenshotsFlag !== undefined) updates.saveScreenshots = screenshotsFlag;
  if (metadataFlag !== undefined) updates.saveMetadata = metadataFlag;

  storage.upsertWatchTarget({ username: normalized, ...updates });
  const updated = storage.getWatchTarget(normalized)!;
  storage.close();

  const icon = (v: boolean) => v ? c.green('✓ ON') : c.red('✗ OFF');
  console.log(`  ${c.bold(`Updated @${normalized}`)}\n`);
  console.log(`  ${c.cyan('Media:')}       ${icon(updated.saveMedia)}`);
  console.log(`  ${c.cyan('Screenshots:')} ${icon(updated.saveScreenshots)}`);
  console.log(`  ${c.cyan('Metadata:')}    ${icon(updated.saveMetadata)}`);
  console.log('');
}

program
  .name('watcher-v2')
  .option('--env <path>')
  .option('--db <path>')
  .option('--download-root <path>')
  .option('-f, --foreground', 'Run in the foreground');

program
  .command('start')
  .description('Start the watcher daemon')
  .option('--foreground', 'Run in the foreground (alias for global -f)')
  .action(async (opts) => {
    const global = program.opts();
    await cmdStart({
      env: global.env,
      db: global.db,
      downloadRoot: global.downloadRoot,
      foreground: opts.foreground || global.foreground,
    });
  });

program.command('stop').action(() => {
  const global = program.opts();
  cmdStop(global);
});

program.command('status').action(() => {
  const global = program.opts();
  cmdStatus(global);
});

program
  .command('add <username>')
  .option('--spaces')
  .option('--tweets')
  .option('--replies')
  .option('--no-media', 'Disable media downloads for this user')
  .option('--no-screenshots', 'Disable screenshot captures for this user')
  .option('--no-metadata', 'Disable JSON metadata saving for this user')
  .action((username, opts) => {
    const global = program.opts();
    cmdAdd(username, { ...global, ...opts });
  });

program
  .command('migrate:v1')
  .option('--source-root <path>')
  .action((opts) => {
    const global = program.opts();
    cmdMigrate({ ...global, ...opts });
  });

program
  .command('setup')
  .action(async () => {
    const global = program.opts();
    await cmdSetup({ env: global.env });
  });

program
  .command('update-tokens')
  .action(async () => {
    const global = program.opts();
    await cmdUpdateTokens({ env: global.env });
  });

program
  .command('login')
  .description('Login to Twitter via a visible browser window to refresh tokens')
  .action(async () => {
    const global = program.opts();
    await cmdLogin({ env: global.env });
  });

program
  .command('switch')
  .action(async () => {
    const global = program.opts();
    await cmdSwitch({ env: global.env, db: global.db, downloadRoot: global.downloadRoot });
  });

program
  .command('update')
  .action(() => {
    cmdUpdate();
  });

program
  .command('config <username>')
  .option('--media <value>', 'Enable/disable media downloads (on/off)')
  .option('--screenshots <value>', 'Enable/disable screenshot captures (on/off)')
  .option('--metadata <value>', 'Enable/disable JSON metadata saving (on/off)')
  .action((username, opts) => {
    const global = program.opts();
    cmdConfig(username, { ...global, ...opts });
  });

program
  .command('list')
  .action(() => {
    const global = program.opts();
    cmdList(global);
  });

program
  .command('remove <username>')
  .action((username) => {
    const global = program.opts();
    cmdRemove(username, global);
  });

program
  .command('delete <username> <target>')
  .description('Delete downloaded files (target: spaces, tweets, or all)')
  .action((username, target) => {
    if (!['spaces', 'tweets', 'all'].includes(target)) {
      console.log(c.red('\n  ✖ Target must be spaces, tweets, or all\n'));
      return;
    }
    const global = program.opts();
    cmdDelete(username, target as DeleteTarget, global);
  });

program
  .command('export <path>')
  .action((exportPath) => {
    const global = program.opts();
    cmdExport(exportPath, global);
  });

program
  .command('import <path>')
  .action((importPath) => {
    const global = program.opts();
    cmdImport(importPath, global);
  });

program
  .command('backup <path>')
  .action(async (destinationPath) => {
    const global = program.opts();
    await cmdBackup(destinationPath, global);
  });

program
  .command('doctor')
  .action(() => {
    const global = program.opts();
    cmdDoctor(global);
  });

program
  .command('cleanup')
  .action(() => {
    const global = program.opts();
    cmdCleanup(global);
  });

program.parse();
