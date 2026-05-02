import { Command } from 'commander';
import { loadAppConfig } from './config/app-config';
import { SqliteStorage } from './storage/sqlite-storage';
import { WatchlistService } from './services/watchlist-service';
import { TelegramBotApiClient } from './adapters/telegram-client';
import { TwitterApiClient } from './adapters/twitter-client';
import { NitterApiClient } from './adapters/nitter-client';
import { CamoufoxScreenshotService } from './adapters/screenshot-service';
import { TwspaceSpacesProvider } from './adapters/spaces-provider';
import { TweetMonitorWorker } from './core/tweet-monitor-worker';
import { SpaceMonitorWorker } from './core/space-monitor-worker';
import { TelegramControlBot } from './bot/telegram-bot';
import { WatcherSupervisor } from './core/supervisor';
import { removePidFile, writePidFile } from './runtime/pid-file';
import { closeFileLogging, enableFileLogging, rootLogger } from './runtime/logger';
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
  const telegramClient = new TelegramBotApiClient(config);
  const twitterClient = new TwitterApiClient(config, {
    onRefreshFailure: async (reason, error) => {
      await telegramClient.sendMessage(
        `<b>⚠ Twitter Auth Failure</b>\n\n` +
        `Failed to automatically refresh tokens.\n` +
        `Reason: <code>${reason}</code>\n` +
        `Error: <code>${error.message}</code>\n\n` +
        `Please run <code>npm run login</code> manually to restore access.`
      );
    }
  });
  const proxyRotator = createProxyRotator(config.proxyEnabled, config.proxyList);
  const nitterClient = config.dataSource === 'nitter' ? new NitterApiClient(config, proxyRotator) : null;
  const tweetWorkerClient = nitterClient || twitterClient;
  const screenshotService = new CamoufoxScreenshotService(config, proxyRotator, nitterClient ?? undefined);
  const spacesProvider = new TwspaceSpacesProvider(config, (reason) => twitterClient.refreshAuth(reason));
  const tweetWorker = new TweetMonitorWorker(config, storage, tweetWorkerClient, telegramClient, screenshotService);
  const spaceWorker = new SpaceMonitorWorker(config, storage, spacesProvider, telegramClient);
  let supervisor: WatcherSupervisor;
  const controlBot = new TelegramControlBot(config, watchlistService, () => supervisor.getStatus());

  supervisor = new WatcherSupervisor(
    config,
    storage,
    watchlistService,
    tweetWorker,
    spaceWorker,
    screenshotService,
    telegramClient,
    controlBot
  );

  writePidFile(config.pidPath, process.pid);
  await supervisor.start(options.mode ?? 'daemon');

  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await supervisor.stop(reason, exitCode === 0 ? 'stopped' : 'error');
    } finally {
      storage.close();
      closeFileLogging();
      removePidFile(config.pidPath);
      process.exit(exitCode);
    }
  };

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
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error('Unhandled rejection', { message });
    void shutdown(`unhandledRejection: ${message}`, 1);
  });

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
