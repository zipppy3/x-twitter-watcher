import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/utils/async', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/async')>();
  return {
    ...mod,
    randomSleep: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});
import { TweetMonitorWorker } from '../src/core/tweet-monitor-worker';
import { SqliteStorage } from '../src/storage/sqlite-storage';
import { buildTweetMessage, buildThreadMessage } from '../src/services/telegram-messages';
import { ScreenshotService, TelegramClient, Tweet, TwitterClient } from '../src/types';
import { createTestConfig, makeTempDir } from './helpers';

function makeTweet(id: string, text: string, overrides: Partial<Tweet> = {}): Tweet {
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
    ...overrides,
  };
}

class FlakyTelegram implements TelegramClient {
  up = true;

  photosWork = true;

  messages: string[] = [];

  attempts = 0;

  isConfigured(): boolean {
    return true;
  }

  async sendMessage(message: string): Promise<boolean> {
    this.attempts += 1;
    if (!this.up) return false;
    this.messages.push(message);
    return true;
  }

  async sendPhoto(_path: string, caption?: string): Promise<boolean> {
    this.attempts += 1;
    if (!this.up || !this.photosWork) return false;
    this.messages.push(`[photo] ${caption}`);
    return true;
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

function setup(screenshot: ScreenshotService, timeline: () => Tweet[]) {
  const config = createTestConfig(makeTempDir('watcher-v2-delivery-'));
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
  const telegram = new FlakyTelegram();
  const worker = new TweetMonitorWorker(config, storage, twitterClient, telegram, screenshot);
  // Drive polls by hand; start() would also schedule its own.
  (worker as any).running = true;
  return { config, storage, telegram, worker };
}

const noScreenshots: ScreenshotService = {
  captureTweet: async () => null,
  captureThread: async () => null,
  close: async () => undefined,
};

describe('tweet delivery', () => {
  test('a tweet that could not be delivered is retried, not dropped', async () => {
    const { storage, telegram, worker } = setup(noScreenshots, () => [makeTweet('3', 'newer'), makeTweet('2', 'older')]);

    telegram.up = false;
    await worker.pollOnce();
    expect(telegram.messages).toHaveLength(0);
    expect(storage.getSeenTweetIds('alice')).not.toContain('2');
    expect(storage.getSeenTweetIds('alice')).not.toContain('3');

    telegram.up = true;
    await worker.pollOnce();
    // Both arrive, oldest first.
    expect(telegram.messages).toHaveLength(2);
    expect(telegram.messages[0]).toContain('older');
    expect(telegram.messages[1]).toContain('newer');
    expect(storage.getSeenTweetIds('alice')).toEqual(expect.arrayContaining(['2', '3']));

    await worker.pollOnce();
    expect(telegram.messages).toHaveLength(2); // nothing is sent twice
    storage.close();
  });

  test('gives up on a tweet after repeated failures so later tweets are not blocked forever', async () => {
    const { storage, telegram, worker } = setup(noScreenshots, () => [makeTweet('2', 'never arrives')]);
    telegram.up = false;

    for (let i = 0; i < 5; i += 1) {
      await worker.pollOnce();
    }

    expect(storage.getSeenTweetIds('alice')).toContain('2');
    storage.close();
  });

  test('falls back to a text notification when the screenshot cannot be uploaded', async () => {
    const shotDir = makeTempDir('watcher-v2-shot-');
    const withScreenshot: ScreenshotService = {
      captureTweet: async (_username, _id, outputPath) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, 'jpeg');
        return outputPath;
      },
      captureThread: async () => null,
      close: async () => undefined,
    };
    const { storage, telegram, worker } = setup(withScreenshot, () => [makeTweet('2', 'hello')]);
    telegram.photosWork = false;

    await worker.pollOnce();

    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]).toContain('hello');
    expect(telegram.messages[0]).toContain('could not be uploaded');
    expect(storage.getSeenTweetIds('alice')).toContain('2');
    storage.close();
    fs.rmSync(shotDir, { recursive: true, force: true });
  });
});

describe('telegram messages', () => {
  test('a reply shows who it answers and what it quotes', () => {
    const parent = makeTweet('10', 'the original take', { author: { username: 'Bob', displayName: 'Bob' } });
    const quoted = makeTweet('11', 'the quoted post', { author: { username: 'Carol', displayName: 'Carol' } });
    const message = buildTweetMessage(
      makeTweet('12', 'Tom & Jerry <3', { inReplyToUsername: 'Bob', inReplyToTweet: parent, quotedTweet: quoted, media: [{ type: 'photo', url: 'x' }, { type: 'photo', url: 'y' }] }),
      'alice'
    );

    expect(message).toContain('💬 <b>New reply</b>');
    expect(message).toContain('<b>Alice A.</b> (@Alice)');
    expect(message).toContain('↪️ to @Bob: <i>“the original take”</i>');
    expect(message).toContain('<blockquote>Tom &amp; Jerry &lt;3</blockquote>');
    expect(message).toContain('🔁 Quoting @Carol');
    expect(message).toContain('📎 2 photos');
    expect(message).toContain('🕐 5 Oct 2026, 20:51 UTC');
    expect(message).toContain('<a href="https://x.com/alice/status/12">Open on X</a>');
    expect(message).toContain('<a href="https://archive.ph/?run=1&amp;url=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F12">Save to archive.ph</a>');
  });

  test('a thread is archived from its last tweet, so the whole thread is on the page', () => {
    const thread = buildThreadMessage([makeTweet('1', 'first'), makeTweet('2', 'second'), makeTweet('3', 'third')], 'alice');
    expect(thread).toContain('url=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F3">Save to archive.ph</a>');
  });

  test('never exceeds the caption limit, even when escaping inflates the text', () => {
    const noisy = '<&>'.repeat(3000);
    const message = buildTweetMessage(
      makeTweet('12', noisy, { inReplyToUsername: 'Bob', inReplyToTweet: makeTweet('10', noisy), quotedTweet: makeTweet('11', noisy) }),
      'alice'
    );
    expect(message.length).toBeLessThanOrEqual(1000);
    expect(message).toContain('Save to archive.ph</a>'); // the end of the message survived

    const thread = buildThreadMessage([makeTweet('1', noisy), makeTweet('2', noisy)], 'alice');
    expect(thread.length).toBeLessThanOrEqual(1000);
    expect(thread).toContain('Save to archive.ph</a>');
    expect(thread).toContain('🧵 <b>New thread</b>');
  });
});
