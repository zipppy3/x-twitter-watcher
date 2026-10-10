import { Command } from 'commander';
import { loadAppConfig } from './config/app-config';
import { SqliteStorage } from './storage/sqlite-storage';
import { WatchlistService } from './services/watchlist-service';
import { TelegramBotApiClient } from './adapters/telegram-client';
import { TwitterApiClient } from './adapters/twitter-client';
import { NitterApiClient } from './adapters/nitter-client';
import { CamoufoxBrowser } from './adapters/camoufox-browser';
import { CamoufoxScreenshotService } from './adapters/screenshot-service';
import { TwspaceSpacesProvider } from './adapters/spaces-provider';
import { TweetMonitorWorker } from './core/tweet-monitor-worker';
import { SpaceMonitorWorker } from './core/space-monitor-worker';
import { DeletionCheckWorker } from './core/deletion-check-worker';
import { TelegramControlBot } from './bot/telegram-bot';
import { ScreenshotRetryService } from './services/screenshot-retry';
import { WatcherSupervisor } from './core/supervisor';
import { HealthMonitor } from './core/health-monitor';
import {
  HEARTBEAT_INTERVAL_MS,
  clearStopRequest,
  hasStopRequest,
  removePidFile,
  touchPidFile,
  writePidFile,
} from './runtime/pid-file';
import { closeFileLogging, enableFileLogging, rootLogger } from './runtime/logger';
import { buildFailedScreenshotList } from './services/telegram-messages';
import { createProxyRotator } from './utils/proxy-rotator';

export interface DaemonOptions {
  env?: string;
  db?: string;
  downloadRoot?: string;
  mode?: string;
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const logger = rootLogger.child('daemon');
  const config = loadAppConfig({
    envPath: options.env,
    dbPath: options.db,
    downloadRoot: options.downloadRoot,
  });
  const storage = new SqliteStorage(config.dbPath);
  storage.init();

  // Enable persistent file logging for daemon mode
  if (options.mode !== 'foreground') {
    enableFileLogging(config.logPath);
    logger.info('File logging enabled', { path: config.logPath });
  }

  const watchlistService = new WatchlistService(storage);
  let telegramClient: TelegramBotApiClient;
  const health = new HealthMonitor({
    alertAfterMs: config.healthAlertAfterMs,
    // Longer than the worst-case backoff (10 min) plus a slow batch of screenshots.
    stallAfterMs: 30 * 60 * 1000,
    dailyReportHour: config.healthDailyReportHour,
    notify: (html) => telegramClient.sendMessage(html),
    describeWatchlist: () => {
      const targets = storage.getWatchTargets();
      const tweets = targets.filter((target) => target.watchTweets);
      const replies = tweets.filter((target) => target.watchReplies).length;
      const spaces = targets.filter((target) => target.watchSpaces).length;
      return `${tweets.length} tweet accounts (${replies} with replies), ${spaces} Spaces`;
    },
    describePending: () => {
      const pending = screenshotRetry.pending();
      return pending.length ? buildFailedScreenshotList(pending) : null;
    },
    onProblemChange: (problem) => {
      storage.updateRuntimeState({ lastError: problem });
    },
  });
  telegramClient = new TelegramBotApiClient(config, undefined, health);
  const proxyRotator = createProxyRotator(config.proxyEnabled, config.proxyList, config.proxyIsRotatingEndpoint);
  const twitterClient = new TwitterApiClient(config, {
    proxyRotator,
    health,
    onRefreshFailure: async (reason, error) => {
      await telegramClient.sendMessage(
        `<b>⚠ Twitter Auth Failure</b>\n\n` +
        `Failed to automatically refresh tokens.\n` +
        `Reason: <code>${reason}</code>\n` +
        `Error: <code>${error.message}</code>\n\n` +
        `Run <code>npm run login</code> (or <code>npm run dev -- update-tokens</code>) and restart the watcher.`
      );
    }
  });
  const camoufox = new CamoufoxBrowser(config.packageRoot);
  const nitterClient = config.dataSource === 'nitter' ? new NitterApiClient(config, camoufox, proxyRotator, health) : null;
  const tweetWorkerClient = nitterClient || twitterClient;
  const screenshotService = new CamoufoxScreenshotService(config, camoufox, proxyRotator, nitterClient ?? undefined, health);
  const spacesProvider = new TwspaceSpacesProvider(config, (reason) => twitterClient.refreshAuth(reason), health);
  const screenshotRetry = new ScreenshotRetryService(config, storage, telegramClient, screenshotService);
  const tweetWorker = new TweetMonitorWorker(config, storage, tweetWorkerClient, telegramClient, screenshotService, health, screenshotRetry);
  const spaceWorker = new SpaceMonitorWorker(config, storage, spacesProvider, telegramClient, health);
  // Tweet ids from Nitter are the same ids, but only the X API can say whether one still exists.
  const deletionWorker =
    config.dataSource === 'nitter' ? undefined : new DeletionCheckWorker(config, storage, twitterClient, telegramClient, health);
  let supervisor: WatcherSupervisor;
  const controlBot = new TelegramControlBot(config, watchlistService, () => supervisor.getStatus(), screenshotRetry);

  supervisor = new WatcherSupervisor(
    config,
    storage,
    watchlistService,
    tweetWorker,
    spaceWorker,
    screenshotService,
    telegramClient,
    controlBot,
    deletionWorker
  );

  let shuttingDown = false;
  let heartbeat: NodeJS.Timeout | null = null;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    health.stop();
    try {
      await supervisor.stop(reason, exitCode === 0 ? 'stopped' : 'error');
      await camoufox.close();
    } catch (error) {
      logger.error('Shutdown did not complete cleanly', { message: (error as Error).message });
    } finally {
      try {
        storage.close();
      } catch {
        // Already closed.
      }
      closeFileLogging();
      removePidFile(config.pidPath);
      clearStopRequest(config.pidPath);
      process.exit(exitCode);
    }
  };

  // Registered before startup so an interrupt or a crash while starting still cleans up.
  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { message: error.message, stack: error.stack });
    void shutdown(`uncaughtException: ${error.message}`, 1);
  });
  process.on('unhandledRejection', (reason) => {
    // A stray rejection from one poll or one library call is not worth killing a
    // long-running watcher over; record it and keep going.
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error('Unhandled rejection', { message, stack: reason instanceof Error ? reason.stack : undefined });
    try {
      storage.updateRuntimeState({ lastError: `unhandledRejection: ${message}` });
    } catch {
      // Storage may already be closed during shutdown.
    }
  });

  clearStopRequest(config.pidPath);
  writePidFile(config.pidPath, process.pid);
  // Heartbeat: keeps the pid file fresh and picks up `stop` requests, which is the
  // only way to shut down gracefully on Windows.
  heartbeat = setInterval(() => {
    touchPidFile(config.pidPath);
    if (hasStopRequest(config.pidPath)) {
      void shutdown('stop requested', 0);
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    await supervisor.start(options.mode ?? 'daemon');
  } catch (error) {
    logger.error('Startup failed', { message: (error as Error).message, stack: (error as Error).stack });
    await shutdown(`startup failed: ${(error as Error).message}`, 1);
    return;
  }
  health.start();

  await new Promise<void>(() => {
    // Keep the daemon alive until a signal or fatal error arrives.
  });
}

if (require.main === module) {
  const program = new Command();
  program
    .option('--env <path>')
    .option('--db <path>')
    .option('--download-root <path>')
    .option('--mode <mode>', 'Runtime mode label', 'daemon');
  program.parse();
  const opts = program.opts();
  runDaemon(opts).catch((error) => {
    rootLogger.child('daemon').error('Daemon startup failed', { message: error.message, stack: error.stack });
    process.exit(1);
  });
}
