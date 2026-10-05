import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AppConfig, HealthReporter, SpacesProvider, SpacesProviderEvents, SpaceRecordedEvent, WatchTarget } from '../types';
import { rootLogger } from '../runtime/logger';
import { formatDuration } from '../utils/time';
import { ensureFileDir, sanitizeFilename } from '../utils/files';

// twspace-crawler is intentionally isolated to this adapter.
const { SpaceWatcher } = require('twspace-crawler/dist/modules/SpaceWatcher');
const { Util } = require('twspace-crawler/dist/utils/Util');
const { SpaceState } = require('twspace-crawler/dist/enums/Twitter.enum');
const { TwitterApi } = require('twspace-crawler/dist/apis/TwitterApi');
const { api } = require('twspace-crawler/dist/api/twitter.api');
const { TWITTER_PUBLIC_AUTHORIZATION } = require('twspace-crawler/dist/constants/twitter.constant');

type SpaceWatcherInstance = InstanceType<typeof SpaceWatcher>;

function writeSpeakersMetadata(watcher: SpaceWatcherInstance, downloadRoot: string): string | null {
  const username = watcher.space?.creator?.username;
  if (!username) {
    return null;
  }

  const metadataDir = path.join(downloadRoot, username.toLowerCase(), 'spaces', 'metadata');
  const filePath = path.join(metadataDir, `${sanitizeFilename(watcher.filename)} - speakers.txt`);
  ensureFileDir(filePath);
  const participants = watcher.audioSpace?.participants;

  const lines = [
    `Space: "${watcher.space?.title || 'Untitled'}"`,
    `Host: ${watcher.space?.creator?.name || 'Unknown'} (@${username})`,
  ];

  if (watcher.space?.startedAt) {
    lines.push(`Started: ${new Date(watcher.space.startedAt).toISOString()}`);
  }

  lines.push('');
  lines.push('Speakers:');

  for (const admin of participants?.admins || []) {
    const name = admin.display_name || admin.user_results?.result?.legacy?.name || 'Unknown';
    const handle = admin.twitter_screen_name || admin.user_results?.result?.legacy?.screen_name || '?';
    lines.push(`- ${name} (@${handle}) [Host]`);
  }

  for (const speaker of participants?.speakers || []) {
    const name = speaker.display_name || speaker.user_results?.result?.legacy?.name || 'Unknown';
    const handle = speaker.twitter_screen_name || speaker.user_results?.result?.legacy?.screen_name || '?';
    lines.push(`- ${name} (@${handle})`);
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

export class TwspaceSpacesProvider extends EventEmitter implements SpacesProvider {
  private readonly logger = rootLogger.child('spaces');

  private readonly watchedUsers = new Map<string, string | null>();

  private readonly activeWatchers = new Map<string, SpaceWatcherInstance>();

  private pollTimer: NodeJS.Timeout | null = null;

  private pollCount = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly refreshAuth?: (reason: string) => Promise<boolean>,
    private readonly health?: HealthReporter
  ) {
    super();
  }

  async start(initialTargets: WatchTarget[]): Promise<void> {
    for (const target of initialTargets.filter((item) => item.watchSpaces)) {
      await this.addUser(target);
    }
    this.schedulePoll(0);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.activeWatchers.clear();
    this.watchedUsers.clear();
  }

  async addUser(target: WatchTarget): Promise<void> {
    if (!target.watchSpaces) {
      return;
    }

    // Called on every watchlist sync, so it must stay cheap: keep an id we already
    // know and leave unknown ones for pollOnce to resolve.
    const userId = target.userId ?? this.watchedUsers.get(target.username) ?? null;
    this.watchedUsers.set(target.username, userId);
  }

  async removeUser(username: string): Promise<void> {
    this.watchedUsers.delete(username.toLowerCase());
  }

  override on<EventName extends keyof SpacesProviderEvents>(
    event: EventName,
    handler: (payload: SpacesProviderEvents[EventName]) => void
  ): this {
    return super.on(event, handler);
  }

  override off<EventName extends keyof SpacesProviderEvents>(
    event: EventName,
    handler: (payload: SpacesProviderEvents[EventName]) => void
  ): this {
    return super.off(event, handler);
  }

  private schedulePoll(ms = this.config.spacePollIntervalMs): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollOnce()
        .catch((error) => this.emit('error', error as Error))
        .finally(() => this.schedulePoll());
    }, ms);
  }

  private async pollOnce(): Promise<void> {
    const entries = Array.from(this.watchedUsers.entries());
    if (!entries.length) {
      this.pollCount += 1;
      this.emit('poll', {
        usernames: [],
        pollCount: this.pollCount,
        polledAt: new Date().toISOString(),
      });
      return;
    }

    const resolvedIds: string[] = [];
    const usernames: string[] = [];

    for (const [username, currentId] of entries) {
      let userId = currentId;
      if (!userId) {
        userId = await this.resolveUserId(username);
        this.watchedUsers.set(username, userId);
      }
      if (userId) {
        usernames.push(username);
        resolvedIds.push(userId);
      }
    }

    this.pollCount += 1;
    this.emit('poll', {
      usernames,
      pollCount: this.pollCount,
      polledAt: new Date().toISOString(),
    });

    if (!resolvedIds.length) {
      return;
    }

    let liveSpaces: any[];
    try {
      liveSpaces = await this.getLiveSpaces(resolvedIds);
      this.health?.ok('spaces');
    } catch (error) {
      this.health?.fail('spaces', (error as Error).message);
      // Nobody being live is the normal case; only a rejected request points at dead tokens.
      const status = (error as { response?: { status?: number } }).response?.status;
      if ((status === 401 || status === 403) && this.refreshAuth) {
        this.logger.warn('Spaces poll was rejected, requesting an auth refresh', { status });
        await this.refreshAuth(`spaces_http_${status}`);
      }
      throw error;
    }

    for (const liveSpace of liveSpaces) {
      if (this.activeWatchers.has(liveSpace.id)) {
        continue;
      }
      this.emit('live', {
        spaceId: liveSpace.id,
        title: liveSpace.title || 'Untitled Space',
        user: liveSpace.creator?.username || 'unknown',
        startedAt: new Date(liveSpace.started_at || Date.now()).toISOString(),
      });
      this.startWatcher(liveSpace.id);
    }
  }

  private async getLiveSpaces(userIds: string[]): Promise<any[]> {
    if (process.env.TWITTER_AUTHORIZATION) {
      const { data } = await TwitterApi.getSpacesByCreatorIds(userIds, {
        authorization: process.env.TWITTER_AUTHORIZATION,
      });
      return (data || []).filter((space: any) => space.state === SpaceState.LIVE);
    }

    // Read the token from the environment first: a token refresh updates it there,
    // while the config object still holds the value from startup.
    const authToken = process.env.TWITTER_AUTH_TOKEN || this.config.twitterAuthToken;
    if (authToken) {
      const data = await TwitterApi.getSpacesByFleetsAvatarContent(userIds, {
        authorization: TWITTER_PUBLIC_AUTHORIZATION,
        cookie: `auth_token=${authToken}`,
      });
      return Object.values(data.users || {})
        .map((item: any) => item.spaces?.live_content?.audiospace)
        .filter(Boolean)
        .map((item: any) => ({
          id: item.broadcast_id,
          title: item.title,
          creator: { username: item.owner_screen_name },
          started_at: item.start,
          state: SpaceState.LIVE,
        }));
    }

    return [];
  }

  private async resolveUserId(username: string): Promise<string | null> {
    try {
      const { data } = await api.graphql.UserByScreenName(username);
      return data?.data?.user?.result?.rest_id || null;
    } catch (error) {
      this.logger.warn('Failed to resolve user id for spaces provider', {
        username,
        message: (error as Error).message,
      });
      return null;
    }
  }

  private startWatcher(spaceId: string): void {
    const watcher = new SpaceWatcher(spaceId) as SpaceWatcherInstance;
    this.activeWatchers.set(spaceId, watcher);
    watcher.watch();

    watcher.once('complete', () => {
      this.activeWatchers.delete(spaceId);
      const event = this.buildRecordedEvent(spaceId, watcher);
      if (event) {
        this.emit('recorded', event);
      }
    });
  }

  private buildRecordedEvent(spaceId: string, watcher: SpaceWatcherInstance): SpaceRecordedEvent | null {
    const originalFilePath = watcher.downloader?.resultFile;
    const username = watcher.space?.creator?.username || 'unknown';
    if (!originalFilePath) {
      return null;
    }

    // Move the recorded audio file into the per-user directory structure
    // Lower-case like the tweet folders, so Linux does not end up with two folders per user.
    const audioDir = path.join(this.config.downloadRoot, username.toLowerCase(), 'spaces', 'audio');
    const audioFileName = path.basename(originalFilePath);
    const finalFilePath = path.join(audioDir, audioFileName);
    try {
      ensureFileDir(finalFilePath);
      fs.renameSync(originalFilePath, finalFilePath);
    } catch {
      // If rename fails (cross-device), try copy + delete
      try {
        fs.copyFileSync(originalFilePath, finalFilePath);
        fs.rmSync(originalFilePath, { force: true });
      } catch {
        // Fall back to original path if move fails entirely
        return this.buildRecordedEventFallback(spaceId, watcher, originalFilePath);
      }
    }

    const durationMs =
      watcher.space?.endedAt && watcher.space?.startedAt
        ? Number(watcher.space.endedAt) - Number(watcher.space.startedAt)
        : 0;

    const metadataPath = writeSpeakersMetadata(watcher, this.config.downloadRoot);

    return {
      spaceId,
      title: watcher.space?.title || 'Untitled Space',
      user: username,
      duration: formatDuration(durationMs),
      filePath: finalFilePath,
      metadataPath,
      recordedAt: new Date().toISOString(),
    };
  }

  private buildRecordedEventFallback(spaceId: string, watcher: SpaceWatcherInstance, filePath: string): SpaceRecordedEvent {
    const username = watcher.space?.creator?.username || 'unknown';
    const durationMs =
      watcher.space?.endedAt && watcher.space?.startedAt
        ? Number(watcher.space.endedAt) - Number(watcher.space.startedAt)
        : 0;

    const metadataPath = writeSpeakersMetadata(watcher, this.config.downloadRoot);

    return {
      spaceId,
      title: watcher.space?.title || 'Untitled Space',
      user: username,
      duration: formatDuration(durationMs),
      filePath,
      metadataPath,
      recordedAt: new Date().toISOString(),
    };
  }
}
