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
import { ScreenshotRetryService } from '../src/services/screenshot-retry';
import { buildFailedScreenshotList } from '../src/services/telegram-messages';
import { SqliteStorage } from '../src/storage/sqlite-storage';
import { FailedScreenshotInput, ScreenshotService, TelegramClient, TelegramReceipt, Tweet, TwitterClient } from '../src/types';
import { createTestConfig, makeTempDir } from './helpers';

function makeTweet(id: string, text: string): Tweet {
  return {
    id,
    text,
    createdAt: 'Mon Oct 05 20:51:28 +0000 2026',
    authorId: 'u1',
    author: { username: 'alice', displayName: 'Alice A.' },
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

interface Sent {
  kind: 'message' | 'photo';
  text: string;
  replyTo: number | null | undefined;
}

class RecordingTelegram implements TelegramClient {
  sent: Sent[] = [];

  private nextId = 100;

  isConfigured(): boolean {
    return true;
  }

  async sendMessage(text: string, _thread?: string | null, receipt?: TelegramReceipt, replyTo?: number | null): Promise<boolean> {
    this.sent.push({ kind: 'message', text, replyTo });
    if (receipt) receipt.messageId = this.nextId++;
    return true;
  }

  async sendPhoto(
    _path: string,
    caption?: string,
    _thread?: string | null,
    receipt?: TelegramReceipt,
    replyTo?: number | null
  ): Promise<boolean> {
    this.sent.push({ kind: 'photo', text: caption ?? '', replyTo });
    if (receipt) receipt.messageId = this.nextId++;
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

/** Takes screenshots only while `works` is true. */
class SwitchableScreenshots implements ScreenshotService {
  works = false;

  calls: string[] = [];

  private shoot(outputPath: string): string | null {
    if (!this.works) return null;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, 'jpeg');
    return outputPath;
  }

  async captureTweet(_username: string, tweetId: string, outputPath: string): Promise<string | null> {
    this.calls.push(tweetId);
    return this.shoot(outputPath);
  }

  async captureThread(_username: string, tweetId: string, outputPath: string): Promise<string | null> {
    this.calls.push(tweetId);
    return this.shoot(outputPath);
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function setup(timeline: () => Tweet[] = () => []) {
  const config = createTestConfig(makeTempDir('watcher-v2-retry-'));
  const storage = new SqliteStorage(config.dbPath);
  storage.init();
  storage.upsertWatchTarget({ username: 'alice', userId: 'u1', watchSpaces: false, watchTweets: true });
  storage.markTweetsSeen('alice', ['1']);

  const telegram = new RecordingTelegram();
  const screenshots = new SwitchableScreenshots();
  const retry = new ScreenshotRetryService(config, storage, telegram, screenshots);
  const twitterClient: TwitterClient = {
    resolveUserId: vi.fn(async () => 'u1'),
    getUserTweets: vi.fn(async () => timeline()),
    getUserTweetsAndReplies: vi.fn(async () => []),
    getTweetById: vi.fn(async () => null),
    refreshAuth: vi.fn(async () => true),
  };
  const worker = new TweetMonitorWorker(config, storage, twitterClient, telegram, screenshots, undefined, retry);
  (worker as any).running = true;
  return { config, storage, telegram, screenshots, retry, worker };
}

function failure(postId: string, overrides: Partial<FailedScreenshotInput> = {}): FailedScreenshotInput {
  return {
    postId,
    kind: 'tweet',
    username: 'alice',
    captureUsername: 'alice',
    captureTweetId: postId,
    isReply: false,
    outputPath: path.join(makeTempDir('watcher-v2-shot-'), `${postId}.jpg`),
    telegramMessageId: 50,
    topicId: null,
    ...overrides,
  };
}

describe('failed screenshots', () => {
  test('a post delivered without its screenshot is announced and remembered', async () => {
    const { storage, telegram, worker } = setup(() => [makeTweet('222222', 'hello')]);

    await worker.pollOnce();

    const [post, notice] = telegram.sent;
    expect(post.text).toContain('hello');
    expect(notice.text).toContain('/retry 222222');
    expect(notice.replyTo).toBe(100); // answers the post itself
    expect(storage.getFailedScreenshots()).toMatchObject([
      { postId: '222222', kind: 'tweet', username: 'alice', telegramMessageId: 100, noticeMessageId: 101 },
    ]);
    storage.close();
  });

  test('a post whose screenshot worked leaves nothing to retry', async () => {
    const { storage, screenshots, worker } = setup(() => [makeTweet('222222', 'hello')]);
    screenshots.works = true;

    await worker.pollOnce();

    expect(storage.getFailedScreenshots()).toHaveLength(0);
    storage.close();
  });

  test('retrying keeps the post listed until the screenshot works, then replies to the post', async () => {
    const { storage, telegram, screenshots, retry } = setup();
    storage.recordFailedScreenshots([failure('222222')]);

    const first = await retry.retry(['222222']);
    expect(first).toEqual([{ postId: '222222', username: 'alice', ok: false, remaining: 1 }]);
    expect(storage.getFailedScreenshots()).toMatchObject([{ attempts: 2 }]);
    expect(telegram.sent).toHaveLength(0);

    screenshots.works = true;
    const second = await retry.retry(['222222']);
    expect(second).toEqual([{ postId: '222222', username: 'alice', ok: true, remaining: 0 }]);
    expect(storage.getFailedScreenshots()).toHaveLength(0);
    expect(telegram.sent).toMatchObject([{ kind: 'photo', replyTo: 50 }]);
    storage.close();
  });

  test('a batch retries every pending post, and a post can be found from the messages around it', async () => {
    const { storage, screenshots, retry } = setup();
    storage.recordFailedScreenshots([
      failure('222222'),
      failure('333333', { telegramMessageId: 60 }),
      failure('333333', { kind: 'parent', captureTweetId: '111111', telegramMessageId: 60 }),
    ]);
    storage.setFailedScreenshotNotice('333333', 61);

    expect(retry.find({ postId: '333333' })).toEqual(['333333']);
    expect(retry.find({ postId: '999999' })).toEqual([]);
    expect(retry.find({ messageId: 61 })).toEqual(['333333']); // the notice
    expect(retry.find({ messageId: 60 })).toEqual(['333333']); // the post

    screenshots.works = true;
    const outcomes = await retry.retry(null);
    expect(outcomes?.map((outcome) => outcome.postId)).toEqual(['222222', '333333']);
    expect([...screenshots.calls].sort()).toEqual(['111111', '222222', '333333']);
    expect(storage.getFailedScreenshots()).toHaveLength(0);
    storage.close();
  });

  test('only one retry runs at a time', async () => {
    const { storage, screenshots, retry } = setup();
    storage.recordFailedScreenshots([failure('222222')]);
    screenshots.works = true;

    const running = retry.retry(null);
    expect(await retry.retry(null)).toBeNull();
    await running;
    storage.close();
  });

  test('the list names each post once, with the command to retry it', () => {
    const { storage } = setup();
    storage.recordFailedScreenshots([failure('222222'), failure('222222', { kind: 'parent' })]);

    const list = buildFailedScreenshotList(storage.getFailedScreenshots());
    expect(list).toContain('(1)');
    expect(list).toContain('/retry 222222');
    expect(list).toContain('/retry all');
    storage.close();
  });
});
