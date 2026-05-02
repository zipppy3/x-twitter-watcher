import fs from 'node:fs';
import path from 'node:path';
import { Camoufox } from 'camoufox-js';
import { AppConfig, ScreenshotService } from '../types';
import { rootLogger } from '../runtime/logger';
import { ensureFileDir } from '../utils/files';
import { withTimeout } from '../utils/async';
import { ProxyRotator } from '../utils/proxy-rotator';
import { NitterApiClient } from './nitter-client';

export class CamoufoxScreenshotService implements ScreenshotService {
  private readonly logger = rootLogger.child('screenshot');

  private browser: any | null = null;

  private queue: Promise<void> = Promise.resolve();

  private available = true;

  constructor(
    private readonly config: AppConfig,
    private readonly proxyRotator?: ProxyRotator,
    private readonly nitterClient?: NitterApiClient,
  ) {}

  async captureTweet(username: string, tweetId: string, outputPath: string, isReply = false): Promise<string | null> {
    const nitterBase = this.nitterClient
      ? this.nitterClient.getActiveNitterUrl()
      : (this.config.nitterUrl || 'https://nitter.net');
    const url = this.config.dataSource === 'nitter'
      ? `${nitterBase}/${username}/status/${tweetId}`
      : `https://x.com/${username}/status/${tweetId}`;
    return this.enqueue(() => this.captureUrl(url, outputPath, false, isReply), `tweet ${username}/${tweetId}`);
  }

  async captureThread(username: string, tweetId: string, outputPath: string): Promise<string | null> {
    const nitterBase = this.nitterClient
      ? this.nitterClient.getActiveNitterUrl()
      : (this.config.nitterUrl || 'https://nitter.net');
    const url = this.config.dataSource === 'nitter'
      ? `${nitterBase}/${username}/status/${tweetId}`
      : `https://x.com/${username}/status/${tweetId}`;
    return this.enqueue(() => this.captureUrl(url, outputPath, true, false), `thread ${username}/${tweetId}`);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  private enqueue(task: () => Promise<string | null>, label: string): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      this.logger.info(`Starting screenshot capture: ${label}`);
      const result = await withTimeout(task(), this.config.screenshotTimeoutMs, null);
      if (result) {
        this.logger.info(`Screenshot captured successfully: ${label}`, { path: result });
      } else {
        this.logger.warn(`Screenshot capture returned null (timeout or error): ${label}`);
      }
      return result;
    };

    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async ensureBrowser(): Promise<any | null> {
    if (!this.available) {
      return null;
    }

    if (!this.browser) {
      try {
        this.browser = await Camoufox({ headless: true });
      } catch (error) {
        this.available = false;
        this.logger.error('Failed to start Camoufox', { message: (error as Error).message });
        return null;
      }
    }

    return this.browser;
  }

  /**
   * Wait until the target Nitter element has rendered at a reasonable width.
   * This prevents capturing tiny/broken screenshots when the page hasn't finished
   * rendering (e.g. during the Nitter browser-verification challenge).
   */
  private async waitForNitterElementReady(page: any, selector: string, maxRetries = 10): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      const dims = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }, selector);

      if (dims && dims.width >= 200 && dims.height >= 50) {
        this.logger.info(`Nitter element ready: ${selector}`, { width: dims.width, height: dims.height });
        return true;
      }

      this.logger.info(`Waiting for Nitter element to render: ${selector} (attempt ${i + 1}/${maxRetries})`, { dims });
      await page.waitForTimeout(1000);
    }

    this.logger.warn(`Nitter element did not reach expected dimensions: ${selector}`);
    return false;
  }

  private async captureUrl(url: string, outputPath: string, fullPage: boolean, isReply: boolean): Promise<string | null> {
    const browser = await this.ensureBrowser();
    if (!browser) {
      return null;
    }

    let context: any;
    let page: any;

    try {
      const isNitter = this.config.dataSource === 'nitter';

      context = await browser.newContext({
        viewport: { width: 800, height: 4000 },
        colorScheme: 'dark',
        locale: 'en-US',
        ...(this.proxyRotator?.enabled ? { proxy: this.proxyRotator.next() ?? undefined } : {}),
      });
      page = await context.newPage();

      const tweetSelector = isNitter ? '.main-tweet' : 'article[data-testid="tweet"]';

      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector(tweetSelector, { timeout: 15000 });

      await page.waitForTimeout(fullPage ? 3000 : 2000);

      ensureFileDir(outputPath);

      // ── Nitter path: element-level screenshots ──
      if (isNitter) {
        // Hide navbar, replies below the main tweet, and any other noise
        await page.addStyleTag({ content: `
          nav.inner-nav,
          .conversation > .reply-thread,
          .replies,
          #r,
          .show-more
          { display: none !important; }
        `});

        await page.waitForTimeout(300);

        // Determine the screenshot target:
        // 1. If this is a reply by the watched user, use .main-thread to capture
        //    the full conversation chain (all parent tweets + the reply).
        // 2. If .before-tweet exists (reply context), use .main-thread for context.
        // 3. Otherwise just screenshot .main-tweet.
        const hasParent = await page.locator('.before-tweet').count() > 0;
        let targetSelector: string;

        if (isReply || hasParent) {
          // .main-thread includes all parent tweets + the main tweet in the thread
          const hasMainThread = await page.locator('.main-thread').count() > 0;
          targetSelector = hasMainThread ? '.main-thread' : '.conversation';
        } else {
          targetSelector = '.main-tweet';
        }

        this.logger.info(`Nitter screenshot target: ${targetSelector}`, { hasParent, isReply });

        // Wait for the element to render at a proper width to avoid broken aspect ratio
        const ready = await this.waitForNitterElementReady(page, targetSelector);
        if (!ready) {
          this.logger.warn('Nitter element not ready, attempting screenshot anyway');
        }

        await page.locator(targetSelector).first().screenshot({
          path: outputPath,
          type: 'jpeg',
          quality: 85,
        });

        return outputPath;
      }

      // ── X/Twitter path: clip-based screenshots (unchanged) ──
      if (!isNitter) {
        try {
          const showMore = page.locator('span:has-text("Show more"), [data-testid="tweetText"] div[role="button"]');
          if (await showMore.first().isVisible({ timeout: 1000 })) {
            await showMore.first().click();
            await page.waitForTimeout(1000);
          }
        } catch {
          // Ignore missing "Show more".
        }
      }

      if (!isNitter) {
        try {
          const closeButton = page.locator('[data-testid="xMigrationBottomBar"] button, [role="button"][aria-label="Close"]');
          if (await closeButton.first().isVisible({ timeout: 1000 })) {
            await closeButton.first().click();
            await page.waitForTimeout(500);
          }
        } catch {
          // Ignore missing overlays.
        }
      }

      await page.evaluate(() => {
        const selectors = [
          '[data-testid="xMigrationBottomBar"]',
          '[data-testid="BottomBar"]',
          'header[role="banner"]',
          '#credential_picker_container',
          'iframe[src*="smartlock.google.com"]',
          'iframe[src*="accounts.google.com"]',
          'iframe[title*="Sign in with Google"]'
        ].join(', ');
        document
          .querySelectorAll(selectors)
          .forEach((element) => ((element as HTMLElement).style.display = 'none'));
      });

      if (fullPage) {
        await page.screenshot({ path: outputPath, type: 'jpeg', quality: 85, fullPage: true });
        return outputPath;
      }

      const clip = await page.evaluate(() => {
        const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).filter(
          (element) => (element as HTMLElement).offsetHeight > 0
        );
        if (!tweets.length) {
          return null;
        }

        let top = Number.POSITIVE_INFINITY;
        let left = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;

        for (const tweet of tweets) {
          const cell = tweet.closest('[data-testid="cellInnerDiv"]') || tweet;
          const rect = cell.getBoundingClientRect();
          top = Math.min(top, rect.top);
          left = Math.min(left, rect.left);
          bottom = Math.max(bottom, rect.bottom);
          right = Math.max(right, rect.right);
        }

        let finalHeight = bottom - top;
        if (finalHeight > 8000) {
          finalHeight = 8000;
        }

        return {
          x: left + window.scrollX,
          y: top + window.scrollY > 0 ? top + window.scrollY : 0,
          width: right - left,
          height: finalHeight,
        };
      });

      if (clip && clip.width > 0 && clip.height > 0) {
        await page.screenshot({ path: outputPath, type: 'jpeg', quality: 85, clip });
      } else {
        await page.locator(tweetSelector).first().screenshot({ path: outputPath, type: 'jpeg', quality: 85 });
      }

      return outputPath;
    } catch (error) {
      this.logger.warn('Failed to capture screenshot', { url, message: (error as Error).message });
      return null;
    } finally {
      if (page) {
        await page.close().catch(() => undefined);
      }
      if (context) {
        await context.close().catch(() => undefined);
      }
    }
  }
}
