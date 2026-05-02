import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { SpaceMonitorWorker } from '../src/core/space-monitor-worker';
import { TweetMonitorWorker } from '../src/core/tweet-monitor-worker';
import { SqliteStorage } from '../src/storage/sqlite-storage';
import { AppConfig, ScreenshotService, SpacesProvider, SpacesProviderEvents, TelegramClient, Tweet, TwitterClient, WatchTarget } from '../src/types';
import { createTestConfig, makeTempDir } from './helpers';

class FakeSpacesProvider extends EventEmitter implements SpacesProvider {
  addCalls: string[] = [];

  removeCalls: string[] = [];

  initialTargets: string[] = [];

  async start(initialTargets: WatchTarget[]): Promise<void> {
    this.initialTargets = initialTargets.map((target) => target.username);
  }

  async stop(): Promise<void> {}

  async addUser(target: WatchTarget): Promise<void> {
    this.addCalls.push(target.username);
  }

  async removeUser(username: string): Promise<void> {
    this.removeCalls.push(username);
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
}

class FakeTelegramClient implements TelegramClient {
  messages: string[] = [];

  isConfigured(): boolean {
    return true;
  }

  async sendMessage(message: string): Promise<boolean> {
    this.messages.push(message);
    return true;
  }

  async sendPhoto(): Promise<boolean> {
    return true;
  }

  async sendVideo(): Promise<boolean> {
    return true;
  }

  async sendDocument(): Promise<boolean> {
    return true;
  }

  async sendAudio(): Promise<boolean> {
    return true;
  }

  async sendMediaGroup(): Promise<boolean> {
    return true;
  }
}

class FakeScreenshotService implements ScreenshotService {
  async captureTweet(): Promise<string | null> {
    return null;
  }

  async captureThread(): Promise<string | null> {
    return null;
  }

  async close(): Promise<void> {}
}

describe('runtime workers', () => {
  test('space worker supports empty start then live add and remove sync', async () => {
    const baseDir = makeTempDir('watcher-v2-space-worker-');
    const config = createTestConfig(baseDir);
    const storage = new SqliteStorage(config.dbPath);
    storage.init();

    const provider = new FakeSpacesProvider();
    const telegram = new FakeTelegramClient();
    const worker = new SpaceMonitorWorker(config, storage, provider, telegram);

    await worker.start();
    expect(provider.initialTargets).toEqual([]);

    storage.upsertWatchTarget({ username: 'alice', watchSpaces: true, watchTweets: false });
    await worker.syncTargets();
    expect(provider.addCalls).toContain('alice');

    storage.removeWatchTarget('alice');
    await worker.syncTargets();
    expect(provider.removeCalls).toContain('alice');

    await worker.stop();
    storage.close();
  });

  test('tweet worker keeps polling when screenshots fail', async () => {
    const baseDir = makeTempDir('watcher-v2-tweet-worker-');
    const config = createTestConfig(baseDir);
    const storage = new SqliteStorage(config.dbPath);
    storage.init();
    storage.upsertWatchTarget({ username: 'alice', userId: 'u1', watchSpaces: false, watchTweets: true });
    storage.markTweetsSeen('alice', ['old']);

    let callCount = 0;
    const makeTweet = (id: string, text: string): Tweet => ({
      id,
      text,
      createdAt: new Date().toISOString(),
      authorId: 'u1',
      author: { username: 'alice', displayName: 'Alice' },
      metrics: { likes: 1, retweets: 1, replies: 0, bookmarks: 0, views: 1 },
      conversationId: id,
      inReplyToStatusId: null,
      inReplyToUserId: null,
      inReplyToUsername: null,
      isRetweet: false,
      isThread: false,
      media: [],
      urls: [],
      quotedTweet: null,
    });

    const twitterClient: TwitterClient = {
      resolveUserId: vi.fn(async () => 'u1'),
      getUserTweets: vi.fn(async () => {
        callCount += 1;
        return callCount === 1
          ? [makeTweet('tweet-1', 'first tweet')]
          : [makeTweet('tweet-2', 'second tweet'), makeTweet('tweet-1', 'first tweet')];
      }),
      getUserTweetsAndReplies: vi.fn(async () => []),
      getTweetById: vi.fn(async () => null),
      refreshAuth: vi.fn(async () => true),
    };

    const telegram = new FakeTelegramClient();
    const worker = new TweetMonitorWorker(
      config,
      storage,
      twitterClient,
      telegram,
      new FakeScreenshotService()
    );

    await worker.start();
    await worker.pollOnce();
    await worker.pollOnce();
    await worker.stop();

    expect(telegram.messages).toHaveLength(2);
    expect(telegram.messages[0]).toContain('first tweet');
    expect(telegram.messages[1]).toContain('second tweet');

    storage.close();
  });
});
