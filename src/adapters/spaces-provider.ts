import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AppConfig, SpacesProvider, SpacesProviderEvents, SpaceRecordedEvent, WatchTarget } from '../types';
import { rootLogger } from '../runtime/logger';
import { formatDuration } from '../utils/time';
import { sanitizeFilename } from '../utils/files';

// twspace-crawler is intentionally isolated to this adapter.
const { SpaceWatcher } = require('twspace-crawler/dist/modules/SpaceWatcher');
const { Util } = require('twspace-crawler/dist/utils/Util');
const { SpaceState } = require('twspace-crawler/dist/enums/Twitter.enum');
const { TwitterApi } = require('twspace-crawler/dist/apis/TwitterApi');
const { api } = require('twspace-crawler/dist/api/twitter.api');
const { TWITTER_PUBLIC_AUTHORIZATION } = require('twspace-crawler/dist/constants/twitter.constant');

type SpaceWatcherInstance = InstanceType<typeof SpaceWatcher>;

function writeSpeakersMetadata(watcher: SpaceWatcherInstance): string | null {
  const username = watcher.space?.creator?.username;
  if (!username) {
    return null;
  }

  const dir = Util.getMediaDir(username);
  Util.createMediaDir(username);
  const filePath = path.join(dir, `${sanitizeFilename(watcher.filename)} - speakers.txt`);
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

  private consecutiveEmptyPolls = 0;

  private static readonly AUTH_FAILURE_THRESHOLD = 3;

  constructor(
    private readonly config: AppConfig,
    private readonly refreshAuth?: (reason: string) => Promise<boolean>
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

    const userId = target.userId ?? (await this.resolveUserId(target.username));
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

    const liveSpaces = await this.getLiveSpaces(resolvedIds);

    // Track consecutive empty polls to detect potential auth issues
    if (liveSpaces.length === 0 && resolvedIds.length > 0) {
      this.consecutiveEmptyPolls += 1;
      if (this.consecutiveEmptyPolls >= TwspaceSpacesProvider.AUTH_FAILURE_THRESHOLD) {
        this.logger.warn('Multiple consecutive empty Space polls — auth may be expired', {
          consecutiveEmpty: this.consecutiveEmptyPolls,
        });
        if (this.refreshAuth) {
          const refreshed = await this.refreshAuth('spaces_consecutive_empty_polls');
          if (refreshed) {
            this.logger.info('Auth refresh triggered from Spaces provider');
            this.consecutiveEmptyPolls = 0;
          }
        } else {
          this.emit('error', new Error(
            `Spaces: ${this.consecutiveEmptyPolls} consecutive empty polls. Auth tokens may be expired.`
          ));
        }
      }
    } else if (liveSpaces.length > 0) {
      this.consecutiveEmptyPolls = 0;
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

    if (this.config.twitterAuthToken) {
      const data = await TwitterApi.getSpacesByFleetsAvatarContent(userIds, {
        authorization: TWITTER_PUBLIC_AUTHORIZATION,
        cookie: `auth_token=${this.config.twitterAuthToken}`,
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
    const filePath = watcher.downloader?.resultFile;
    const username = watcher.space?.creator?.username || 'unknown';
    if (!filePath) {
      return null;
    }

    const durationMs =
      watcher.space?.endedAt && watcher.space?.startedAt
        ? Number(watcher.space.endedAt) - Number(watcher.space.startedAt)
        : 0;

    const metadataPath = writeSpeakersMetadata(watcher);

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
