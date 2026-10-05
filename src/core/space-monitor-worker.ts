import fs from 'node:fs';
import { AppConfig, HealthReporter, SpacesProvider, Storage, TelegramClient, WatchTarget } from '../types';
import { rootLogger } from '../runtime/logger';
import { getTopicId } from '../services/topic-routing';
import {
  buildSpaceLiveMessage,
  buildSpaceRecordedMessage,
  buildSpaceUploadFailedMessage,
} from '../services/telegram-messages';

export class SpaceMonitorWorker {
  private readonly logger = rootLogger.child('space-worker');

  private syncTimer: NodeJS.Timeout | null = null;

  private running = false;

  private trackedTargets = new Map<string, WatchTarget>();

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly spacesProvider: SpacesProvider,
    private readonly telegramClient: TelegramClient,
    private readonly health?: HealthReporter
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.spacesProvider.on('poll', (event) => {
      this.storage.updateRuntimeState({
        lastPollAt: event.polledAt,
        pollCount: event.pollCount,
      });
    });
    this.spacesProvider.on('live', async (event) => {
      const state = this.storage.getRuntimeState();
      const nextActiveSpaces = [...state.activeSpaces.filter((space) => space.id !== event.spaceId), {
        id: event.spaceId,
        title: event.title,
        user: event.user,
        startedAt: event.startedAt,
      }];

      this.storage.updateRuntimeState({
        status: 'recording',
        activeSpaces: nextActiveSpaces,
        lastError: null,
      });

      await this.telegramClient.sendMessage(buildSpaceLiveMessage(event));
    });
    this.spacesProvider.on('recorded', async (event) => {
      const state = this.storage.getRuntimeState();
      const nextActiveSpaces = state.activeSpaces.filter((space) => space.id !== event.spaceId);
      this.health?.count('spaces');
      this.storage.addRecording({
        spaceId: event.spaceId,
        title: event.title,
        user: event.user,
        duration: event.duration,
        filePath: event.filePath,
        metadataPath: event.metadataPath,
        recordedAt: event.recordedAt,
      });
      this.storage.updateRuntimeState({
        status: nextActiveSpaces.length ? 'recording' : 'watching',
        activeSpaces: nextActiveSpaces,
      });

      await this.telegramClient.sendMessage(buildSpaceRecordedMessage(event));

      const target = this.storage.getWatchTarget(event.user);
      const audioTopicId = getTopicId(this.config, target, 'audio');
      const metadataTopicId = getTopicId(this.config, target, 'metadata');
      const durationParts = event.duration.split(':').map((part) => Number.parseInt(part, 10) || 0);
      const durationSeconds = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];

      // Only files that actually reached Telegram are eligible for auto-delete.
      const uploadedFiles: string[] = [];
      if (audioTopicId) {
        const audioUploaded = await this.telegramClient.sendAudio(event.filePath, {
          title: event.title,
          performer: event.user,
          durationSec: durationSeconds,
          threadId: audioTopicId,
        });
        if (audioUploaded) {
          uploadedFiles.push(event.filePath);
        } else {
          // The recording cannot be made again, so say clearly that it is still on disk.
          this.logger.error('Space audio upload failed; recording kept on disk', { filePath: event.filePath });
          await this.telegramClient.sendMessage(buildSpaceUploadFailedMessage(event));
        }
      }

      if (metadataTopicId && event.metadataPath) {
        const metaUploaded = await this.telegramClient.sendDocument(event.metadataPath, metadataTopicId);
        if (metaUploaded) uploadedFiles.push(event.metadataPath);
      }

      this.autoDeleteFiles(uploadedFiles, true);
    });
    this.spacesProvider.on('error', (error) => {
      this.logger.error('Spaces provider error', { message: error.message });
      this.storage.updateRuntimeState({
        status: 'error',
        lastError: error.message,
      });
    });

    await this.spacesProvider.start(this.getCurrentTargets());
    await this.syncTargets();
    this.scheduleSync();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    await this.spacesProvider.stop();
  }

  getSnapshot(): { trackedUsernames: string[] } {
    return {
      trackedUsernames: [...this.trackedTargets.keys()],
    };
  }

  async syncTargets(): Promise<void> {
    const nextTargets = new Map(this.getCurrentTargets().map((target) => [target.username, target]));

    for (const [username, target] of nextTargets.entries()) {
      await this.spacesProvider.addUser(target);
    }

    for (const username of this.trackedTargets.keys()) {
      if (!nextTargets.has(username)) {
        await this.spacesProvider.removeUser(username);
      }
    }

    this.trackedTargets = nextTargets;
  }

  private getCurrentTargets(): WatchTarget[] {
    return this.storage.getWatchTargets().filter((target) => target.watchSpaces);
  }

  private scheduleSync(): void {
    if (!this.running) {
      return;
    }
    this.syncTimer = setTimeout(() => {
      this.syncTargets()
        .catch((error) => {
          this.logger.error('Failed to sync space targets', { message: (error as Error).message });
        })
        .finally(() => this.scheduleSync());
    }, this.config.watchlistReloadIntervalMs);
  }

  private autoDeleteFiles(filePaths: string[], uploadSuccess: boolean): void {
    if (!uploadSuccess || !this.config.autoDeleteUploaded) {
      return;
    }

    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true });
        }
      } catch (error) {
        this.logger.warn('Auto-delete failed', { filePath, message: (error as Error).message });
      }
    }
  }
}
