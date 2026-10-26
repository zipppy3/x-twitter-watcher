import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { CamoufoxScreenshotService } from '../src/adapters/screenshot-service';
import { createTestConfig, makeTempDir } from './helpers';

interface PageBehaviour {
  goto?: () => Promise<unknown>;
  waitForSelector?: () => Promise<unknown>;
  title?: string;
}

function makeBrowser(behaviour: PageBehaviour) {
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const browser = {
    newContext: vi.fn(async () => {
      const page = {
        goto: vi.fn(behaviour.goto ?? (async () => ({ status: () => 200 }))),
        waitForSelector: vi.fn(behaviour.waitForSelector ?? (async () => undefined)),
        title: vi.fn(async () => behaviour.title ?? 'X'),
        close: vi.fn(async () => undefined),
      };
      const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
      contexts.push(context);
      return context;
    }),
  };
  return { browser, contexts };
}

function makeService(browser: unknown, timeoutMs = 60000) {
  const config = { ...createTestConfig(makeTempDir('shot-')), dataSource: 'x', screenshotTimeoutMs: timeoutMs, proxyFallbackOnBan: false } as any;
  const camoufox = { get: vi.fn(async () => browser), recycle: vi.fn(async () => undefined) };
  const health = { ok: vi.fn(), fail: vi.fn() };
  const service = new CamoufoxScreenshotService(config, camoufox as any, undefined, undefined, health as any);
  const output = path.join(makeTempDir('shot-out-'), 'shot.jpg');
  return { service, camoufox, health, output };
}

describe('CamoufoxScreenshotService failures', () => {
  test('a capture that times out has its context closed', async () => {
    const { browser, contexts } = makeBrowser({ goto: () => new Promise(() => undefined) });
    const { service, health, output } = makeService(browser, 50);

    await expect(service.captureTweet('alice', '1', output)).resolves.toBeNull();

    expect(contexts).toHaveLength(1);
    expect(contexts[0].close).toHaveBeenCalled();
    expect(health.fail).toHaveBeenCalledWith('screenshot', expect.stringContaining('alice/1'));
  });

  test('failures in a row restart the browser once', async () => {
    const { browser } = makeBrowser({ goto: async () => { throw new Error('page.goto: Timeout 30000ms exceeded.'); } });
    const { service, camoufox, output } = makeService(browser);

    await service.captureTweet('alice', '1', output);
    expect(camoufox.recycle).not.toHaveBeenCalled();
    await service.captureTweet('alice', '2', output);
    expect(camoufox.recycle).toHaveBeenCalledTimes(1);
    expect(camoufox.recycle).toHaveBeenCalledWith(browser, expect.any(String));

    // Within the cooldown a further failure does not restart it again.
    await service.captureTweet('alice', '3', output);
    await service.captureTweet('alice', '4', output);
    expect(camoufox.recycle).toHaveBeenCalledTimes(1);
  });

  test('a deleted post is neither a health failure nor a reason to restart', async () => {
    const { browser } = makeBrowser({
      waitForSelector: async () => { throw new Error("page.waitForSelector: Timeout 15000ms exceeded."); },
      title: 'Post Not Found - X | 404 Error',
    });
    const { service, camoufox, health, output } = makeService(browser);

    for (const id of ['1', '2', '3']) {
      await expect(service.captureTweet('alice', id, output)).resolves.toBeNull();
    }
    expect(health.fail).not.toHaveBeenCalled();
    expect(camoufox.recycle).not.toHaveBeenCalled();
  });
});
