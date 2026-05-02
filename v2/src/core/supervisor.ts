import { AppConfig, ScreenshotService, Storage, TelegramClient, WatcherStatus } from '../types';
import { rootLogger } from '../runtime/logger';
import { isProcessRunning, readPidFile } from '../runtime/pid-file';
import { formatUptime } from '../utils/time';
import { WatchlistService } from '../services/watchlist-service';
import { TweetMonitorWorker } from './tweet-monitor-worker';
import { SpaceMonitorWorker } from './space-monitor-worker';
import { TelegramControlBot } from '../bot/telegram-bot';

export class WatcherSupervisor {
  private readonly logger = rootLogger.child('supervisor');

  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly watchlistService: WatchlistService,
    private readonly tweetWorker: TweetMonitorWorker,
    private readonly spaceWorker: SpaceMonitorWorker,
    private readonly screenshotService: ScreenshotService,
    private readonly notificationClient: TelegramClient,
    private readonly controlBot: TelegramControlBot
  ) {}

  async start(mode = 'daemon'): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.storage.updateRuntimeState({
      status: 'watching',
      mode,
      startedAt: new Date().toISOString(),
      lastError: null,
      activeSpaces: [],
      pollCount: 0,
      lastPollAt: null,
    });

    this.watchlistService.on('changed', () => {
      this.spaceWorker.syncTargets().catch((error) => {
        this.logger.error('Failed to sync targets after watchlist change', {
          message: (error as Error).message,
        });
      });
    });

    await this.spaceWorker.start();
    await this.tweetWorker.start();
    await this.controlBot.start();

    const targets = this.storage.getWatchTargets();
    const spacesCount = targets.filter((target) => target.watchSpaces).length;
    const tweetsCount = targets.filter((target) => target.watchTweets).length;

    this.logger.info('Supervisor started', { mode, spaces: spacesCount, tweets: tweetsCount });
    if (mode === 'foreground') {
      console.log(`\n  ✅ Watcher v2 is now running in the foreground.`);
      console.log(`  Press Ctrl+C to stop.\n`);
    }

    if (this.notificationClient.isConfigured()) {
      await this.notificationClient.sendMessage(
        `<b>X Watcher v2 started</b>\n\nMode: ${mode}\nSpaces: ${spacesCount}\nTweets: ${tweetsCount}`
      );
    }
  }

  async stop(reason = 'shutdown', exitStatus: 'stopped' | 'error' = 'stopped'): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.logger.info('Stopping supervisor', { reason });

    if (this.notificationClient.isConfigured()) {
      const emoji = exitStatus === 'error' ? '🔴' : '🟡';
      await this.notificationClient.sendMessage(
        `${emoji} <b>X Watcher v2 ${exitStatus === 'error' ? 'crashed' : 'stopped'}</b>\n\nReason: ${reason}`
      ).catch(() => {
        // Best-effort: don't let notification failure block shutdown.
      });
    }

    await this.controlBot.stop();
    await this.tweetWorker.stop();
    await this.spaceWorker.stop();
    await this.screenshotService.close();

    this.storage.updateRuntimeState({
      status: exitStatus,
      activeSpaces: [],
      lastError: exitStatus === 'error' ? reason : this.storage.getRuntimeState().lastError,
    });
  }

  getStatus(): WatcherStatus {
    const runtime = this.storage.getRuntimeState();
    const targets = this.storage.getWatchTargets();
    const pid = readPidFile(this.config.pidPath);
    const tweetSnapshot = this.tweetWorker.getSnapshot();

    return {
      running: isProcessRunning(pid),
      pid,
      state: runtime.status,
      mode: runtime.mode,
      uptime: formatUptime(runtime.startedAt),
      spaceUsers: targets.filter((target) => target.watchSpaces).length,
      tweetUsers: targets.filter((target) => target.watchTweets).length,
      replyUsers: tweetSnapshot.replyUsers,
      pollCount: runtime.pollCount,
      totalSeenTweets: this.storage.getSeenTweetCount(),
      totalRecordings: this.storage.getRecordingCount(),
      activeSpaces: runtime.activeSpaces,
      lastError: runtime.lastError,
    };
  }
}
