import fs from 'node:fs';
import path from 'node:path';
import { AppConfig, HealthReporter, ScreenshotService } from '../types';
import { rootLogger } from '../runtime/logger';
import { ensureFileDir } from '../utils/files';
import { withTimeout, Semaphore } from '../utils/async';
import { ProxyRotator } from '../utils/proxy-rotator';
import { NitterApiClient } from './nitter-client';
import { CamoufoxBrowser } from './camoufox-browser';

export class CamoufoxScreenshotService implements ScreenshotService {
  private readonly logger = rootLogger.child('screenshot');

  private semaphore = new Semaphore(4);

  constructor(
    private readonly config: AppConfig,
    private readonly camoufox: CamoufoxBrowser,
    private readonly proxyRotator?: ProxyRotator,
    private readonly nitterClient?: NitterApiClient,
    private readonly health?: HealthReporter,
  ) {}

  async captureTweet(username: string, tweetId: string, outputPath: string, isReply = false): Promise<string | null> {
    const nitterBase = this.nitterClient
      ? this.nitterClient.getActiveNitterUrl()
      : (this.config.nitterUrl || 'https://nitter.net');
    const url = this.config.dataSource === 'nitter'
      ? `${nitterBase}/${username}/status/${tweetId}`
      : `https://x.com/${username}/status/${tweetId}`;
      
    return this.enqueue(async () => {
      if (!this.config.proxyFallbackOnBan || !this.proxyRotator?.enabled) {
        return this.captureUrl(url, outputPath, false, isReply, true);
      }
      const result = await this.captureUrl(url, outputPath, false, isReply, false);
      if (result) return result;
      this.logger.warn('Screenshot failed without proxy, falling back to proxy...', { url });
      return this.captureUrl(url, outputPath, false, isReply, true);
    }, `tweet ${username}/${tweetId}`);
  }

  async captureThread(username: string, tweetId: string, outputPath: string): Promise<string | null> {
    const nitterBase = this.nitterClient
      ? this.nitterClient.getActiveNitterUrl()
      : (this.config.nitterUrl || 'https://nitter.net');
    const url = this.config.dataSource === 'nitter'
      ? `${nitterBase}/${username}/status/${tweetId}`
      : `https://x.com/${username}/status/${tweetId}`;
      
    return this.enqueue(async () => {
      if (!this.config.proxyFallbackOnBan || !this.proxyRotator?.enabled) {
        return this.captureUrl(url, outputPath, true, false, true);
      }
      const result = await this.captureUrl(url, outputPath, true, false, false);
      if (result) return result;
      this.logger.warn('Screenshot failed without proxy, falling back to proxy...', { url });
      return this.captureUrl(url, outputPath, true, false, true);
    }, `thread ${username}/${tweetId}`);
  }

  async close(): Promise<void> {
    // The shared Camoufox browser is owned and closed by the daemon.
  }

  private enqueue(task: () => Promise<string | null>, label: string): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      this.logger.info(`Starting screenshot capture: ${label}`);
      const result = await withTimeout(task(), this.config.screenshotTimeoutMs, null);
      if (result) {
        this.logger.info(`Screenshot captured successfully: ${label}`, { path: result });
        this.health?.ok('screenshot');
      } else {
        this.logger.warn(`Screenshot capture returned null (timeout or error): ${label}`);
        this.health?.fail('screenshot', `No screenshot for ${label}`);
      }
      return result;
    };

    return this.semaphore.run(run);
  }

  private ensureBrowser(): Promise<any | null> {
    return this.camoufox.get();
  }

  /**
   * Wait until the target Nitter element has rendered at a reasonable width.
   * This prevents capturing tiny/broken screenshots when the page hasn't finished
   * rendering (e.g. during the Nitter browser-verification challenge).
   */
  private async waitForNitterElementReady(page: any, selector: string, maxRetries = 25): Promise<boolean> {
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
      await page.waitForTimeout(200);
    }

    this.logger.warn(`Nitter element did not reach expected dimensions: ${selector}`);
    return false;
  }

  /**
   * Wait until every image inside the posts being captured has really loaded.
   *
   * Avatars and media are inserted after the post's text appears, so checking the
   * images present at one moment is not enough: that is how screenshots ended up
   * with grey "@na..." placeholders instead of profile pictures. An image that
   * failed outright is requested once more before giving up.
   */
  private async waitForPostImages(page: any, url: string): Promise<void> {
    const allLoaded = () => {
      const posts = Array.from(document.querySelectorAll('article[data-watcher-capture]'));
      const images = posts.flatMap((post) => Array.from(post.querySelectorAll('img')));
      // Every post has at least an avatar; none yet means they are still being inserted.
      return images.length >= posts.length && images.every((img) => img.complete && img.naturalWidth > 0);
    };

    const waitFor = (timeout: number): Promise<boolean> =>
      page.waitForFunction(allLoaded, undefined, { timeout, polling: 200 }).then(() => true, () => false);

    if (await waitFor(8000)) {
      return;
    }

    const retried = await page.evaluate(() => {
      let count = 0;
      for (const img of Array.from(document.querySelectorAll('article[data-watcher-capture] img')) as HTMLImageElement[]) {
        if (img.complete && img.naturalWidth === 0 && img.src) {
          const src = img.src;
          img.src = '';
          img.src = src;
          count += 1;
        }
      }
      return count;
    });

    if (!(await waitFor(6000))) {
      this.logger.warn('Some images in the post did not load before the screenshot', { url, retried });
    }
  }

  private async captureUrl(url: string, outputPath: string, fullPage: boolean, isReply: boolean, useProxy: boolean): Promise<string | null> {
    const browser = await this.ensureBrowser();
    if (!browser) {
      return null;
    }

    let context: any;
    let page: any;

    let proxyConfig: any = null;

    try {
      const isNitter = this.config.dataSource === 'nitter';
      proxyConfig = useProxy && this.proxyRotator?.enabled ? this.proxyRotator.next() : null;

      context = await browser.newContext({
        viewport: { width: 800, height: 4000 },
        colorScheme: 'dark',
        locale: 'en-US',
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
      });
      page = await context.newPage();

      // Logged-out visitors get X's newer web app, whose posts are plain <article>
      // elements; the logged-in app still uses article[data-testid="tweet"].
      const tweetSelector = isNitter ? '.main-tweet' : 'article';

      if (!isNitter && this.config.screenshotLoggedIn && this.config.twitterAuthToken && this.config.twitterCsrfToken) {
        await context.addCookies([
          { name: 'auth_token', value: this.config.twitterAuthToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
          { name: 'ct0', value: this.config.twitterCsrfToken, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
        ]);
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector(tweetSelector, { timeout: 15000 });

      if (isNitter) {
        // Wait for images to load (prevents gray circle profile pictures)
        await Promise.race([
          page.evaluate(() => {
            return Promise.all(
              Array.from(document.images)
                .filter(img => !img.complete)
                .map(img => new Promise(resolve => {
                  img.onload = img.onerror = resolve;
                }))
            );
          }),
          page.waitForTimeout(5000)
        ]).catch(() => undefined);

        await page.waitForTimeout(500);
      }

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

        await page.waitForTimeout(100);

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

        if (proxyConfig && this.proxyRotator) {
          this.proxyRotator.markSuccess(proxyConfig.server);
        }

        return outputPath;
      }

      // ── X/Twitter path: clip from the top of the conversation to the captured post ──
      try {
        const showMore = page.locator('span:has-text("Show more"), [data-testid="tweetText"] div[role="button"]');
        if (await showMore.first().isVisible({ timeout: 1000 })) {
          await showMore.first().click();
          await page.waitForTimeout(500);
        }
      } catch {
        // Ignore missing "Show more".
      }

      await page.evaluate(() => {
        const selectors = [
          '[data-testid="xMigrationBottomBar"]',
          '[data-testid="BottomBar"]',
          '#credential_picker_container',
          'iframe[src*="smartlock.google.com"]',
          'iframe[src*="accounts.google.com"]',
          'iframe[title*="Sign in with Google"]'
        ].join(', ');
        document
          .querySelectorAll(selectors)
          .forEach((element) => ((element as HTMLElement).style.display = 'none'));
        // The page may have scrolled to the post; measure from the top so the
        // posts it replies to are included and the sticky header is not in the way.
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(300);

      const tweetId = url.match(/\/status\/(\d+)/)?.[1] ?? '';

      // Mark the posts that belong in the picture: the captured post and what it
      // replies to. Posts below it are other people's replies and are left out.
      const marked = await page.evaluate((focalId: string) => {
        const articles = (Array.from(document.querySelectorAll('article')) as HTMLElement[]).filter(
          (element) => element.offsetHeight > 0
        );
        if (!articles.length) {
          return 0;
        }

        // The captured post is the one that links to its own status URL (or, when
        // logged in, the one with tabindex -1).
        const ownLink = new RegExp(`/status/${focalId}(?:[/?#]|$)`);
        let focalIndex = articles.findIndex((article) => article.getAttribute('tabindex') === '-1');
        if (focalIndex === -1 && focalId) {
          focalIndex = articles.findIndex((article) =>
            Array.from(article.querySelectorAll('a[href]')).some((link) => ownLink.test(link.getAttribute('href') || ''))
          );
        }
        if (focalIndex === -1) {
          focalIndex = 0;
        }

        const selected = articles.slice(0, focalIndex + 1);
        selected.forEach((article) => article.setAttribute('data-watcher-capture', '1'));
        return selected.length;
      }, tweetId);

      if (marked > 0) {
        await this.waitForPostImages(page, url);
      }

      const clip = await page.evaluate(() => {
        const articles = Array.from(document.querySelectorAll('article[data-watcher-capture]')) as HTMLElement[];
        if (!articles.length) {
          return null;
        }

        let top = Number.POSITIVE_INFINITY;
        let left = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;

        for (const article of articles) {
          // The article itself, not its timeline cell: when logged in, the cell of the
          // captured post also holds the reply box with the account's own avatar.
          const rect = article.getBoundingClientRect();
          top = Math.min(top, rect.top);
          left = Math.min(left, rect.left);
          bottom = Math.max(bottom, rect.bottom);
          right = Math.max(right, rect.right);
        }

        const padding = 8;
        const x = Math.max(0, left + window.scrollX - padding);
        const y = Math.max(0, top + window.scrollY - padding);
        return {
          x,
          y,
          width: right - left + padding * 2,
          height: Math.min(bottom - top + padding * 2, 8000),
        };
      });

      if (clip && clip.width > 0 && clip.height > 0) {
        // fullPage makes the clip relative to the document, so a long conversation
        // is not cut off at the viewport edge.
        await page.screenshot({ path: outputPath, type: 'jpeg', quality: 85, clip, fullPage: true });
      } else {
        await page.locator(tweetSelector).first().screenshot({ path: outputPath, type: 'jpeg', quality: 85 });
      }

      if (proxyConfig && this.proxyRotator) {
        this.proxyRotator.markSuccess(proxyConfig.server);
      }

      return outputPath;
    } catch (error) {
      if (proxyConfig && this.proxyRotator) {
        this.proxyRotator.markFailed(proxyConfig.server);
      }
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
