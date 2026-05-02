import { describe, expect, test, vi } from 'vitest';
import { TwitterApiClient } from '../src/adapters/twitter-client';
import { createTestConfig, makeTempDir } from './helpers';

describe('TwitterApiClient', () => {
  test('refreshes auth on 401 from a Twitter request and retries once', async () => {
    const config = createTestConfig(makeTempDir('watcher-v2-twitter-'));
    let refreshed = false;
    const refreshHandler = vi.fn(async () => {
      refreshed = true;
      return true;
    });

    const httpClient = {
      get: vi.fn(async () => {
        if (!refreshed) {
          const error: any = new Error('unauthorized');
          error.response = { status: 401 };
          throw error;
        }

        return {
          data: {
            data: {
              user: {
                result: {
                  rest_id: '123',
                },
              },
            },
          },
        };
      }),
      post: vi.fn(),
    };

    const client = new TwitterApiClient(config, {
      httpClient: httpClient as any,
      refreshHandler,
    });

    await expect(client.resolveUserId('alice')).resolves.toBe('123');
    expect(refreshHandler).toHaveBeenCalledTimes(1);
  });

  test('does not trigger refresh on non-auth failures', async () => {
    const config = createTestConfig(makeTempDir('watcher-v2-twitter-'));
    const refreshHandler = vi.fn(async () => true);
    const httpClient = {
      get: vi.fn(async () => {
        const error: any = new Error('server error');
        error.response = { status: 500 };
        throw error;
      }),
      post: vi.fn(),
    };

    const client = new TwitterApiClient(config, {
      httpClient: httpClient as any,
      refreshHandler,
    });

    await expect(client.resolveUserId('alice')).resolves.toBeNull();
    expect(refreshHandler).not.toHaveBeenCalled();
  });
});
