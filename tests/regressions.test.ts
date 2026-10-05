import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TwitterApiClient } from '../src/adapters/twitter-client';
import { TwspaceSpacesProvider } from '../src/adapters/spaces-provider';
import { isDaemonRunning, writePidFile } from '../src/runtime/pid-file';
import { createTestConfig, makeTempDir } from './helpers';

function httpError(status: number): Error {
  const error: any = new Error(`Request failed with status code ${status}`);
  error.response = { status };
  return error;
}

describe('spaces provider auth handling', () => {
  test('polls with nobody live never trigger an auth refresh', async () => {
    const refreshAuth = vi.fn(async () => true);
    const provider: any = new TwspaceSpacesProvider(createTestConfig(makeTempDir('watcher-v2-spaces-')), refreshAuth);
    provider.on('error', () => undefined);
    provider.watchedUsers.set('alice', '123');
    provider.getLiveSpaces = async () => [];

    for (let i = 0; i < 20; i += 1) {
      await provider.pollOnce();
    }

    expect(refreshAuth).not.toHaveBeenCalled();
  });

  test('a rejected poll requests an auth refresh', async () => {
    const refreshAuth = vi.fn(async () => false);
    const provider: any = new TwspaceSpacesProvider(createTestConfig(makeTempDir('watcher-v2-spaces-')), refreshAuth);
    provider.watchedUsers.set('alice', '123');
    provider.getLiveSpaces = async () => {
      throw httpError(401);
    };

    await expect(provider.pollOnce()).rejects.toThrow('401');
    expect(refreshAuth).toHaveBeenCalledWith('spaces_http_401');
  });

  test('watchlist sync does not look users up or forget known ids', async () => {
    const provider: any = new TwspaceSpacesProvider(createTestConfig(makeTempDir('watcher-v2-spaces-')));
    provider.resolveUserId = vi.fn(async () => null);
    provider.watchedUsers.set('alice', '123');

    await provider.addUser({ username: 'alice', userId: null, watchSpaces: true });

    expect(provider.resolveUserId).not.toHaveBeenCalled();
    expect(provider.watchedUsers.get('alice')).toBe('123');
  });
});

describe('twitter client auth refresh', () => {
  test('a burst of 401s shares one refresh attempt and then backs off', async () => {
    const config = createTestConfig(makeTempDir('watcher-v2-twitter-'));
    const refreshHandler = vi.fn(async () => false);
    const httpClient = {
      get: vi.fn(async () => {
        throw httpError(401);
      }),
      post: vi.fn(),
    };
    const client = new TwitterApiClient(config, { httpClient: httpClient as any, refreshHandler });

    await Promise.all([client.resolveUserId('alice'), client.resolveUserId('bob'), client.resolveUserId('carol')]);
    await client.resolveUserId('dave');

    expect(refreshHandler).toHaveBeenCalledTimes(1);
  });

  test('replies still load when query ids cannot be scraped', async () => {
    const config = createTestConfig(makeTempDir('watcher-v2-twitter-'));
    const httpClient = {
      // The logged-out web app: no bundles that contain query ids.
      get: vi.fn(async () => ({ data: '<html></html>' })),
      post: vi.fn(async () => ({ data: { data: { user: { result: { timeline_v2: { timeline: { instructions: [] } } } } } } })),
    };
    const client = new TwitterApiClient(config, { httpClient: httpClient as any, refreshHandler: async () => false });

    await expect(client.getUserTweetsAndReplies('1')).resolves.toEqual([]);
    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(String(httpClient.post.mock.calls[0][0])).toMatch(/\/graphql\/[^/]+\/UserTweetsAndReplies$/);
  });
});

describe('pid file', () => {
  test('a live pid with a stale pid file is not treated as a running daemon', () => {
    const pidPath = path.join(makeTempDir('watcher-v2-pid-'), 'watcher.pid');
    // This test process is certainly alive, so only the heartbeat can tell the difference.
    writePidFile(pidPath, process.pid);
    expect(isDaemonRunning(pidPath)).toBe(true);

    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(pidPath, longAgo, longAgo);
    expect(isDaemonRunning(pidPath)).toBe(false);
  });
});

describe('telegram notices in a forum whose General topic is closed', () => {
  test('falls back to an open topic and keeps using it', async () => {
    const { TelegramBotApiClient } = await import('../src/adapters/telegram-client');
    const config = { ...createTestConfig(makeTempDir('watcher-v2-telegram-')), telegramMetadataThreadId: '17', telegramAudioThreadId: '15' };
    const threads: Array<string | undefined> = [];
    const http = {
      post: vi.fn(async (_url: string, payload: any) => {
        threads.push(payload.message_thread_id);
        if (!payload.message_thread_id) {
          const error: any = new Error('Request failed with status code 400');
          error.response = { status: 400, data: { description: 'Bad Request: TOPIC_CLOSED' } };
          throw error;
        }
        return { status: 200 };
      }),
    };
    const client = new TelegramBotApiClient(config, http as any);

    await expect(client.sendMessage('started')).resolves.toBe(true);
    await expect(client.sendMessage('health alert')).resolves.toBe(true);
    await expect(client.sendMessage('explicit topic', '15')).resolves.toBe(true);

    // First notice: General (rejected) then topic 17; afterwards straight to 17.
    expect(threads).toEqual([undefined, '17', '17', '15']);
  });

  test('a configured status topic is used directly', async () => {
    const { TelegramBotApiClient } = await import('../src/adapters/telegram-client');
    const config = { ...createTestConfig(makeTempDir('watcher-v2-telegram-')), telegramStatusThreadId: '42' };
    const threads: Array<string | undefined> = [];
    const http = { post: vi.fn(async (_url: string, payload: any) => { threads.push(payload.message_thread_id); return { status: 200 }; }) };
    const client = new TelegramBotApiClient(config, http as any);

    await client.sendMessage('started');
    expect(threads).toEqual(['42']);
  });
});
