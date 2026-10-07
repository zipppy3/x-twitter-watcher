import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/utils/async', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/async')>();
  return {
    ...mod,
    randomSleep: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});
import { DeletionCheckWorker, recheckIntervalMs } from '../src/core/deletion-check-worker';
import { TweetMonitorWorker } from '../src/core/tweet-monitor-worker';
import { TwitterApiClient, classifyTweetDetail, classifyUserByScreenName } from '../src/adapters/twitter-client';
import { SqliteStorage } from '../src/storage/sqlite-storage';
import { buildTweetDeletedMessage, telegramMessageLink } from '../src/services/telegram-messages';
import {
  AccountStatus,
  AppConfig,
  ScreenshotService,
  TelegramClient,
  TelegramReceipt,
  Tweet,
  TweetStatus,
  TweetStatusSource,
  TwitterClient,
} from '../src/types';
import { createTestConfig, makeTempDir } from './helpers';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The shapes X returned on 2026-10-07 for a live tweet and for a deleted one. */
function tweetDetail(tweetId: string, tweetResults: unknown): any {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          { type: 'TimelineClearCache' },
          {
            type: 'TimelineAddEntries',
            entries: [
              {
                entryId: `tweet-${tweetId}`,
                content: { itemContent: { __typename: 'TimelineTweet', tweet_results: tweetResults } },
              },
              { entryId: 'cursor-bottom-1', content: { __typename: 'TimelineTimelineCursor' } },
            ],
          },
        ],
      },
    },
  };
}

class RecordingTelegram implements TelegramClient {
  up = true;

  sent: Array<{ message: string; threadId: string | null }> = [];

  nextMessageId = 500;

  isConfigured(): boolean {
    return true;
  }

  async sendMessage(message: string, threadId?: string | null, receipt?: TelegramReceipt): Promise<boolean> {
    if (!this.up) return false;
    this.sent.push({ message, threadId: threadId ?? null });
    if (receipt) receipt.messageId = this.nextMessageId++;
    return true;
  }

  async sendPhoto(): Promise<boolean> {
    return this.up;
  }

  async sendVideo(): Promise<boolean> {
    return this.up;
  }

  async sendDocument(): Promise<boolean> {
    return this.up;
  }

  async sendAudio(): Promise<boolean> {
    return this.up;
  }

  async sendMediaGroup(): Promise<boolean> {
    return this.up;
  }
}

class FakeSource implements TweetStatusSource {
  tweets = new Map<string, TweetStatus>();

  account: AccountStatus = 'visible';

  lookups: string[] = [];

  async getTweetStatus(tweetId: string): Promise<TweetStatus> {
    this.lookups.push(tweetId);
    return this.tweets.get(tweetId) ?? 'exists';
  }

  async getAccountStatus(): Promise<AccountStatus> {
    return this.account;
  }
}

function setup(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = {
    ...createTestConfig(makeTempDir('watcher-v2-deletion-')),
    telegramChatId: '-1001234567890',
    telegramDeletedThreadId: '77',
    ...overrides,
  };
  const storage = new SqliteStorage(config.dbPath);
  storage.init();
  storage.upsertWatchTarget({ username: 'alice', userId: 'u1', watchSpaces: false, watchTweets: true });

  const source = new FakeSource();
  const telegram = new RecordingTelegram();
  const worker = new DeletionCheckWorker(config, storage, source, telegram);
  // Drive cycles by hand; start() would also schedule its own.
  (worker as any).running = true;

  let clock = Date.now();
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const track = (tweetId: string, text = `tweet ${tweetId}`) =>
    storage.trackDeliveredTweets('alice', [
      { tweetId, text, postedAt: '2026-10-05T20:51:28.000Z', telegramMessageId: 321, nextCheckAt: new Date(clock).toISOString() },
    ]);

  return { config, storage, source, telegram, worker, now, advance, track };
}

describe('reading X answers', () => {
  test('a tweet with a result exists; an empty result means it is gone', () => {
    expect(classifyTweetDetail(tweetDetail('20', { result: { __typename: 'Tweet', rest_id: '20' } }), '20')).toBe('exists');
    expect(
      classifyTweetDetail(tweetDetail('20', { result: { __typename: 'TweetWithVisibilityResults', tweet: {} } }), '20')
    ).toBe('exists');
    expect(classifyTweetDetail(tweetDetail('20', {}), '20')).toBe('gone');
  });

  test('a tombstone is only a deletion when it says so', () => {
    const tombstone = (text: string) =>
      tweetDetail('20', { result: { __typename: 'TweetTombstone', tombstone: { text: { text } } } });
    expect(classifyTweetDetail(tombstone('This Post was deleted by the Post author.'), '20')).toBe('gone');
    expect(classifyTweetDetail(tombstone('This Post is from a suspended account.'), '20')).toBe('unavailable');
  });

  test('anything that is not a clear answer about this tweet is unknown', () => {
    expect(classifyTweetDetail(undefined, '20')).toBe('unknown');
    expect(classifyTweetDetail({ errors: [{ message: 'Rate limit exceeded' }] }, '20')).toBe('unknown');
    expect(classifyTweetDetail({ data: {} }, '20')).toBe('unknown');
    // The answer is about another tweet.
    expect(classifyTweetDetail(tweetDetail('21', {}), '20')).toBe('unknown');
    // The entry is there but has lost its tweet_results field (a changed response shape).
    expect(classifyTweetDetail(tweetDetail('20', undefined), '20')).toBe('unknown');
    expect(classifyTweetDetail(tweetDetail('20', { result: { __typename: 'SomethingNew' } }), '20')).toBe('unknown');
  });

  test('account answers', () => {
    expect(classifyUserByScreenName({ data: { user: { result: { __typename: 'User', rest_id: '1' } } } })).toBe('visible');
    expect(classifyUserByScreenName({ data: { user: { result: { __typename: 'UserUnavailable' } } } })).toBe('unavailable');
    expect(classifyUserByScreenName({ data: {} })).toBe('unavailable');
    expect(
      classifyUserByScreenName({ data: { user: { result: { __typename: 'User', rest_id: '1', legacy: { protected: true } } } } })
    ).toBe('unavailable');
    expect(classifyUserByScreenName({ errors: [{ message: 'nope' }] })).toBe('unknown');
    expect(classifyUserByScreenName(undefined)).toBe('unknown');
  });

  test('a failed request is unknown, never gone', async () => {
    const config = createTestConfig(makeTempDir('watcher-v2-twitter-'));
    const fail = vi.fn();
    const httpClient = {
      get: vi.fn(async () => {
        const error: any = new Error('Too Many Requests');
        error.response = { status: 429 };
        throw error;
      }),
      post: vi.fn(),
    };
    const client = new TwitterApiClient(config, {
      httpClient: httpClient as any,
      refreshHandler: async () => false,
      health: { ok: vi.fn(), fail, beat: vi.fn(), count: vi.fn() },
    });

    await expect(client.getTweetStatus('20')).resolves.toBe('unknown');
    await expect(client.getAccountStatus('alice')).resolves.toBe('unknown');
    // The outage is visible to the health monitor.
    expect(fail).toHaveBeenCalledWith('x-api', 'Too Many Requests');
  });

  test('the client reads a deleted tweet from a real-shaped response', async () => {
    const config = createTestConfig(makeTempDir('watcher-v2-twitter-'));
    const httpClient = { get: vi.fn(async () => ({ data: tweetDetail('20', {}) })), post: vi.fn() };
    const client = new TwitterApiClient(config, { httpClient: httpClient as any });
    await expect(client.getTweetStatus('20')).resolves.toBe('gone');
  });
});

describe('deletion check', () => {
  test('a deleted tweet is reported once, after a second lookup confirms it', async () => {
    const { storage, source, telegram, worker, now, advance, track } = setup();
    track('100', 'Tom & Jerry <3');
    track('101');
    source.tweets.set('100', 'gone');

    await worker.runOnce(now);
    expect(telegram.sent).toHaveLength(0); // one "gone" is not enough

    advance(5 * MINUTE);
    await worker.runOnce(now);
    expect(telegram.sent).toHaveLength(0); // the confirmation is not due yet

    advance(6 * MINUTE);
    await worker.runOnce(now);
    expect(telegram.sent).toHaveLength(1);
    const notice = telegram.sent[0];
    expect(notice.threadId).toBe('77');
    expect(notice.message).toContain('🗑 <b>Tweet deleted</b> · <b>@alice</b>');
    expect(notice.message).toContain('<blockquote>Tom &amp; Jerry &lt;3</blockquote>');
    expect(notice.message).toContain('🕐 Posted: 5 Oct 2026, 20:51 UTC');
    expect(notice.message).toContain('<a href="https://t.me/c/1234567890/321">Saved copy in this group</a>');
    expect(notice.message).toContain('https://x.com/alice/status/100');

    // Reported tweets are done; the other one is still tracked.
    expect(storage.getTrackedTweets('alice').map((tweet) => tweet.tweetId)).toEqual(['101']);
    advance(3 * DAY);
    await worker.runOnce(now);
    expect(telegram.sent).toHaveLength(1);
    storage.close();
  });

  test('a tweet that comes back after one miss is not reported', async () => {
    const { storage, source, telegram, worker, now, advance, track } = setup();
    track('100');
    source.tweets.set('100', 'gone');
    await worker.runOnce(now);

    source.tweets.set('100', 'exists');
    advance(11 * MINUTE);
    await worker.runOnce(now);

    source.tweets.set('100', 'gone');
    advance(2 * HOUR);
    await worker.runOnce(now);

    // The earlier miss was wiped by the lookup that found the tweet.
    expect(telegram.sent).toHaveLength(0);
    expect(storage.getTrackedTweets('alice')[0].missingCount).toBe(1);
    storage.close();
  });

  test('an X outage reports nothing and ends the cycle early', async () => {
    const { storage, source, telegram, worker, now, advance, track } = setup();
    track('100');
    track('101');
    track('102');
    source.tweets.set('100', 'unknown');
    source.tweets.set('101', 'unknown');
    source.tweets.set('102', 'unknown');

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await worker.runOnce(now);
      advance(11 * MINUTE);
    }

    expect(telegram.sent).toHaveLength(0);
    expect(source.lookups).toHaveLength(5); // one lookup per cycle, not one per tweet
    expect(storage.getTrackedTweets('alice').every((tweet) => tweet.missingCount === 0)).toBe(true);
    storage.close();
  });

  test('a suspended or private account is one notice, not a deletion per tweet', async () => {
    const { storage, source, telegram, worker, now, advance, track } = setup();
    track('100');
    track('101');
    source.tweets.set('100', 'gone');
    source.tweets.set('101', 'gone');
    source.account = 'unavailable';

    await worker.runOnce(now);
    advance(11 * MINUTE);
    await worker.runOnce(now);

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].message).toContain('Account unavailable');
    expect(telegram.sent[0].message).not.toContain('Tweet deleted');
    expect(storage.getTrackedTweets('alice')).toHaveLength(2);

    // Back again, and the tweets really are gone: now they are reported.
    source.account = 'visible';
    advance(DAY + MINUTE);
    await worker.runOnce(now);
    expect(telegram.sent.filter((item) => item.message.includes('Tweet deleted'))).toHaveLength(2);
    storage.close();
  });

  test('a notice Telegram did not take is sent on a later cycle', async () => {
    const { storage, source, telegram, worker, now, advance, track } = setup();
    track('100');
    source.tweets.set('100', 'gone');
    await worker.runOnce(now);

    telegram.up = false;
    advance(11 * MINUTE);
    await worker.runOnce(now);
    expect(storage.getTrackedTweets('alice')).toHaveLength(1);

    telegram.up = true;
    advance(5 * MINUTE);
    await worker.runOnce(now);
    expect(telegram.sent).toHaveLength(1);
    expect(storage.getTrackedTweets('alice')).toHaveLength(0);
    storage.close();
  });

  test('without a topic of its own the notice goes where the tweet was posted', async () => {
    const { storage, source, telegram, worker, now, advance, track } = setup({
      telegramDeletedThreadId: null,
      telegramTweetThreadId: '12',
    });
    track('100');
    source.tweets.set('100', 'gone');
    await worker.runOnce(now);
    advance(11 * MINUTE);
    await worker.runOnce(now);

    expect(telegram.sent[0].threadId).toBe('12');
    storage.close();
  });

  test('looks up at most one batch per cycle and stops after the retention window', async () => {
    const { storage, source, worker, now, advance, track } = setup({ deletionCheckBatchSize: 3, deletedTweetCheckDays: 30 });
    for (let id = 100; id < 110; id += 1) {
      track(String(id));
    }

    await worker.runOnce(now);
    expect(source.lookups).toHaveLength(3);

    advance(31 * DAY);
    await worker.runOnce(now);
    expect(source.lookups).toHaveLength(3);
    expect(storage.getTrackedTweets('alice')).toHaveLength(0);
    storage.close();
  });

  test('tweets of an account that is no longer watched are forgotten', async () => {
    const { storage, source, worker, now, track } = setup();
    track('100');
    storage.removeWatchTarget('alice');

    await worker.runOnce(now);
    expect(source.lookups).toHaveLength(0);
    expect(storage.getTrackedTweets('alice')).toHaveLength(0);
    storage.close();
  });

  test('fresh tweets are checked more often than old ones', () => {
    expect(recheckIntervalMs(2 * HOUR)).toBe(HOUR);
    expect(recheckIntervalMs(3 * DAY)).toBe(12 * HOUR);
    expect(recheckIntervalMs(20 * DAY)).toBe(48 * HOUR);
  });

  test('message links exist only for supergroups', () => {
    expect(telegramMessageLink('-1001234567890', 5)).toBe('https://t.me/c/1234567890/5');
    expect(telegramMessageLink('12345', 5)).toBeNull();
    expect(telegramMessageLink('-1001234567890', null)).toBeNull();
  });

  test('the notice fits a Telegram message even when escaping inflates the text', () => {
    const message = buildTweetDeletedMessage(
      {
        username: 'alice',
        tweetId: '100',
        text: '<&>'.repeat(400),
        postedAt: '2026-10-05T20:51:28.000Z',
        deliveredAt: '2026-10-05T20:52:00.000Z',
        telegramMessageId: null,
        lastCheckedAt: null,
        nextCheckAt: '2026-10-05T21:00:00.000Z',
        missingCount: 2,
        deletedAt: null,
      },
      '2026-10-07T10:00:00.000Z',
      null
    );
    expect(message.length).toBeLessThanOrEqual(1000);
    expect(message).toContain('🔎 Found deleted: 7 Oct 2026, 10:00 UTC');
    expect(message).not.toContain('Saved copy');
  });
});

describe('tracking posted tweets', () => {
  function makeTweet(id: string, text: string): Tweet {
    return {
      id,
      text,
      createdAt: 'Mon Oct 05 20:51:28 +0000 2026',
      authorId: 'u1',
      author: { username: 'Alice', displayName: 'Alice A.' },
      metrics: { likes: 0, retweets: 0, replies: 0, bookmarks: 0, views: 0 },
      conversationId: id,
      inReplyToStatusId: null,
      inReplyToUserId: null,
      inReplyToUsername: null,
      isRetweet: false,
      isThread: false,
      media: [],
      urls: [],
      quotedTweet: null,
    };
  }

  const noScreenshots: ScreenshotService = {
    captureTweet: async () => null,
    captureThread: async () => null,
    close: async () => undefined,
  };

  function setupTweetWorker(timeline: () => Tweet[], overrides: Partial<AppConfig> = {}) {
    const config = { ...createTestConfig(makeTempDir('watcher-v2-tracking-')), ...overrides };
    const storage = new SqliteStorage(config.dbPath);
    storage.init();
    storage.upsertWatchTarget({ username: 'alice', userId: 'u1', watchSpaces: false, watchTweets: true });
    storage.markTweetsSeen('alice', ['1']);

    const twitterClient: TwitterClient = {
      resolveUserId: vi.fn(async () => 'u1'),
      getUserTweets: vi.fn(async () => timeline()),
      getUserTweetsAndReplies: vi.fn(async () => []),
      getTweetById: vi.fn(async () => null),
      refreshAuth: vi.fn(async () => true),
    };
    const telegram = new RecordingTelegram();
    const worker = new TweetMonitorWorker(config, storage, twitterClient, telegram, noScreenshots);
    (worker as any).running = true;
    return { storage, telegram, worker };
  }

  test('a posted tweet is remembered with its Telegram message; old and undelivered ones are not', async () => {
    const { storage, telegram, worker } = setupTweetWorker(() => [makeTweet('2', 'hello'), makeTweet('1', 'old')]);

    telegram.up = false;
    await worker.pollOnce();
    expect(storage.getTrackedTweets('alice')).toHaveLength(0);

    telegram.up = true;
    await worker.pollOnce();
    const tracked = storage.getTrackedTweets('alice');
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({
      tweetId: '2',
      text: 'hello',
      postedAt: '2026-10-05T20:51:28.000Z',
      telegramMessageId: 500,
      missingCount: 0,
    });
    // The first check is a little later, not at once.
    expect(new Date(tracked[0].nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 10 * MINUTE);
    storage.close();
  });

  test('nothing is tracked when the check is turned off', async () => {
    const { storage, worker } = setupTweetWorker(() => [makeTweet('2', 'hello')], { deletedTweetCheckDays: 0 });
    await worker.pollOnce();
    expect(storage.getSeenTweetIds('alice')).toContain('2');
    expect(storage.getTrackedTweets('alice')).toHaveLength(0);
    storage.close();
  });

  test('a posted tweet that vanished from the timeline is checked right away', async () => {
    let timeline = [10, 11, 12, 13, 14, 15].map((id) => makeTweet(String(id), `t${id}`));
    const { storage, worker } = setupTweetWorker(() => timeline);
    storage.markTweetsSeen('alice', ['10', '11', '12', '13', '14', '15']);
    const later = new Date(Date.now() + HOUR).toISOString();
    storage.trackDeliveredTweets('alice', [
      // Older than the page: its absence says nothing.
      { tweetId: '5', text: 'ancient', postedAt: null, telegramMessageId: null, nextCheckAt: later },
      { tweetId: '13', text: 't13', postedAt: null, telegramMessageId: null, nextCheckAt: later },
      { tweetId: '14', text: 't14', postedAt: null, telegramMessageId: null, nextCheckAt: later },
    ]);

    await worker.pollOnce();
    expect(storage.getDueDeletionChecks(new Date().toISOString(), 10)).toHaveLength(0);

    timeline = timeline.filter((tweet) => tweet.id !== '13');
    await worker.pollOnce();
    expect(storage.getDueDeletionChecks(new Date().toISOString(), 10).map((tweet) => tweet.tweetId)).toEqual(['13']);
    storage.close();
  });
});
