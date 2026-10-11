import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { TelegramControlBot } from '../src/bot/telegram-bot';
import { ScreenshotRetryService } from '../src/services/screenshot-retry';
import { WatchlistService } from '../src/services/watchlist-service';
import { WatcherStatus } from '../src/types';
import { createTestConfig, makeTempDir } from './helpers';

interface Call {
  method: string;
  body: any;
}

/** A stand-in Bot API server that hands out `updates` once and records what it is asked. */
async function startBotApi(updates: unknown[]) {
  const calls: Call[] = [];
  let pending = [...updates];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop()!.split('?')[0];
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        // Not JSON: the library sent the fields as a form.
        const multipart = [...raw.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)];
        body = multipart.length
          ? Object.fromEntries(multipart.map((match) => [match[1], match[2]]))
          : Object.fromEntries(new URLSearchParams(raw));
      }
      calls.push({ method, body });

      let result: unknown = true;
      if (method === 'getUpdates') {
        result = pending;
        pending = [];
      } else if (method === 'getMe') {
        result = { id: 1, is_bot: true, first_name: 'Watcher', username: 'watcher_bot' };
      } else if (method === 'sendMessage') {
        result = { message_id: 900, date: 0, chat: { id: 12345, type: 'supergroup' }, text: body.text };
      }
      const answer = () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result }));
      };
      // An empty long poll must not turn into a busy loop.
      if (method === 'getUpdates' && !(result as unknown[]).length) {
        setTimeout(answer, 50);
      } else {
        answer();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    calls,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function command(text: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 500,
      date: 0,
      chat: { id: 12345, type: 'supergroup' },
      from: { id: 7, is_bot: false, first_name: 'Owner' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
      ...extra,
    },
  };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function startBot(updates: unknown[], retry: Partial<ScreenshotRetryService>) {
  const api = await startBotApi(updates);
  const config = { ...createTestConfig(makeTempDir('watcher-v2-bot-')), telegramApiUrl: api.url };
  const bot = new TelegramControlBot(
    config,
    {} as WatchlistService,
    () => ({}) as WatcherStatus,
    retry as ScreenshotRetryService
  );
  await bot.start();
  cleanup.push(() => bot.stop(), api.close);
  return api;
}

test('commands are read from the configured Bot API server, and /retry starts a retry', async () => {
  const retry = {
    isBusy: false,
    find: vi.fn(() => ['222222']),
    pending: vi.fn(() => []),
    retry: vi.fn(async () => [{ postId: '222222', username: 'alice', ok: true, remaining: 0 }]),
  };
  const api = await startBot([command('/retry@watcher_bot 222222', { is_topic_message: true, message_thread_id: 7 })], retry);

  await vi.waitFor(() => expect(api.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2), { timeout: 5000 });

  expect(api.calls.some((call) => call.method === 'getUpdates')).toBe(true);
  expect(retry.retry).toHaveBeenCalledWith(['222222']);
  const replies = api.calls.filter((call) => call.method === 'sendMessage').map((call) => call.body);
  expect(replies[0].text).toContain('Retrying 1 post');
  expect(replies[1].text).toContain('1 of 1 done');
  // Answers land in the topic the command came from.
  expect(replies.map((reply) => Number(reply.message_thread_id))).toEqual([7, 7]);
});

test('/retry as a reply to the failure notice retries that post; on its own it lists what is waiting', async () => {
  const retry = {
    isBusy: false,
    find: vi.fn(({ messageId }: { messageId?: number }) => (messageId === 61 ? ['333333'] : [])),
    pending: vi.fn(() => []),
    retry: vi.fn(async () => []),
  };
  const api = await startBot(
    [
      // In a forum topic a plain message "replies" to the topic itself.
      { ...command('/retry', { is_topic_message: true, message_thread_id: 7, reply_to_message: { message_id: 7, date: 0, chat: { id: 12345, type: 'supergroup' } } }), update_id: 1 },
      { ...command('/retry', { reply_to_message: { message_id: 61, date: 0, chat: { id: 12345, type: 'supergroup' } } }), update_id: 2 },
    ],
    retry
  );

  await vi.waitFor(() => expect(retry.retry).toHaveBeenCalledTimes(1), { timeout: 5000 });

  expect(retry.retry).toHaveBeenCalledWith(['333333']);
  const first = api.calls.find((call) => call.method === 'sendMessage')!.body;
  expect(first.text).toContain('No screenshots are waiting');
});
