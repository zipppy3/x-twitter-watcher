import * as cheerio from 'cheerio';
import { Camoufox } from 'camoufox-js';
import { AppConfig, Tweet, TwitterClient, TweetMedia } from '../types';
import { rootLogger } from '../runtime/logger';
import { ProxyRotator, PlaywrightProxyConfig } from '../utils/proxy-rotator';

interface NitterInstance {
  url: string;
  failureCount: number;
  lastFailure: number | null;
  cooldownUntil: number | null;
}

export class NitterApiClient implements TwitterClient {
  private readonly logger = rootLogger.child('nitter');
  private readonly instances: NitterInstance[] = [];
  private activeIndex = 0;
  private browser: any | null = null;
  private browserAvailable = true;
  private readonly proxyRotator: ProxyRotator;

  /** After this many consecutive failures, start trying fallbacks */
  private static readonly FAILOVER_THRESHOLD = 3;
  /** How long to cool down a failed instance before retrying (ms) */
  private static readonly INSTANCE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    config: AppConfig,
    proxyRotator?: ProxyRotator,
  ) {
    const primary = config.nitterUrl?.replace(/\/$/, '') || 'https://nitter.net';
    this.instances.push({ url: primary, failureCount: 0, lastFailure: null, cooldownUntil: null });

    for (const fallbackUrl of config.nitterFallbackUrls) {
      const cleaned = fallbackUrl.replace(/\/$/, '');
      if (cleaned && cleaned !== primary) {
        this.instances.push({ url: cleaned, failureCount: 0, lastFailure: null, cooldownUntil: null });
      }
    }

    this.proxyRotator = proxyRotator ?? new ProxyRotator([]);

    if (this.instances.length > 1) {
      this.logger.info('Nitter instances configured', {
        primary: this.instances[0].url,
        fallbacks: this.instances.slice(1).map((i) => i.url),
      });
    }
  }

  /**
   * Returns the currently active Nitter instance URL.
   * Called by the screenshot service to use the same instance.
   */
  getActiveNitterUrl(): string {
    const instance = this.getActiveInstance();
    return instance.url;
  }

  private getActiveInstance(): NitterInstance {
    const now = Date.now();

    // First, try the primary (index 0) if it's not in cooldown
    if (!this.instances[0].cooldownUntil || now >= this.instances[0].cooldownUntil) {
      // Reset cooldown if expired
      if (this.instances[0].cooldownUntil && now >= this.instances[0].cooldownUntil) {
        this.instances[0].failureCount = 0;
        this.instances[0].cooldownUntil = null;
        this.instances[0].lastFailure = null;
        this.logger.info('Primary Nitter instance cooldown expired, retrying', { url: this.instances[0].url });
      }
      this.activeIndex = 0;
      return this.instances[0];
    }

    // Primary is in cooldown — find a working fallback
    for (let i = 1; i < this.instances.length; i++) {
      const inst = this.instances[i];
      if (!inst.cooldownUntil || now >= inst.cooldownUntil) {
        if (inst.cooldownUntil && now >= inst.cooldownUntil) {
          inst.failureCount = 0;
          inst.cooldownUntil = null;
          inst.lastFailure = null;
        }
        this.activeIndex = i;
        return inst;
      }
    }

    // All instances are in cooldown — use primary anyway (it might have recovered)
    this.activeIndex = 0;
    return this.instances[0];
  }

  private markInstanceFailed(instance: NitterInstance): void {
    instance.failureCount += 1;
    instance.lastFailure = Date.now();

    if (instance.failureCount >= NitterApiClient.FAILOVER_THRESHOLD) {
      instance.cooldownUntil = Date.now() + NitterApiClient.INSTANCE_COOLDOWN_MS;
      this.logger.warn('Nitter instance placed in cooldown', {
        url: instance.url,
        failures: instance.failureCount,
        cooldownMinutes: NitterApiClient.INSTANCE_COOLDOWN_MS / 60000,
      });
    }
  }

  private markInstanceSuccess(instance: NitterInstance): void {
    if (instance.failureCount > 0) {
      instance.failureCount = 0;
      instance.lastFailure = null;
      instance.cooldownUntil = null;
    }
  }

  private async ensureBrowser(): Promise<any | null> {
    if (!this.browserAvailable) return null;
    if (!this.browser) {
      try {
        this.browser = await Camoufox({ headless: true });
      } catch (error) {
        this.browserAvailable = false;
        this.logger.error('Failed to start Camoufox for nitter', { message: (error as Error).message });
        return null;
      }
    }
    return this.browser;
  }

  private async getHtml(url: string): Promise<string> {
    const browser = await this.ensureBrowser();
    if (!browser) throw new Error('Browser unavailable for nitter');

    // Build context options with optional proxy
    const contextOptions: any = {};
    const proxyConfig = this.proxyRotator.next();
    if (proxyConfig) {
      contextOptions.proxy = proxyConfig;
    }

    let context: any;
    let page: any;
    try {
      context = await browser.newContext(contextOptions);
      page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await page.waitForSelector('.timeline-item, .profile-card, .main-tweet', { timeout: 15000 });
      } catch (e) {
        // Continue and try to get content anyway
      }
      const html = await page.content();

      // Mark proxy success
      if (proxyConfig) {
        this.proxyRotator.markSuccess(proxyConfig.server);
      }

      return html;
    } catch (error) {
      // Mark proxy failure
      if (proxyConfig) {
        this.proxyRotator.markFailed(proxyConfig.server);
      }
      throw error;
    } finally {
      if (page) await page.close().catch(() => undefined);
      if (context) await context.close().catch(() => undefined);
    }
  }

  /**
   * Fetch HTML with automatic instance fallback.
   * Tries the active instance first, then falls back to others on failure.
   */
  private async getHtmlWithFallback(buildUrl: (baseUrl: string) => string): Promise<string> {
    const tried = new Set<string>();

    for (let attempt = 0; attempt < this.instances.length; attempt++) {
      const instance = this.getActiveInstance();
      if (tried.has(instance.url)) {
        // We've already tried this instance in this request cycle
        break;
      }
      tried.add(instance.url);

      const url = buildUrl(instance.url);
      try {
        const html = await this.getHtml(url);
        if (!html || html.trim() === '') {
          throw new Error('Nitter returned an empty response');
        }
        this.markInstanceSuccess(instance);
        return html;
      } catch (error) {
        this.logger.warn('Nitter instance failed, trying fallback', {
          url: instance.url,
          message: (error as Error).message,
          attempt: attempt + 1,
          totalInstances: this.instances.length,
        });
        this.markInstanceFailed(instance);
      }
    }

    throw new Error('All Nitter instances failed');
  }

  async resolveUserId(username: string): Promise<string | null> {
    return username;
  }

  async getUserTweets(userId: string, count?: number): Promise<Tweet[]> {
    return this.fetchTimeline(userId, '');
  }

  async getUserTweetsAndReplies(userId: string, count?: number): Promise<Tweet[]> {
    return this.fetchTimeline(userId, '/with_replies');
  }

  async getTweetById(tweetId: string): Promise<Tweet | null> {
    try {
      const data = await this.getHtmlWithFallback((base) => `${base}/i/status/${tweetId}`);
      const $ = cheerio.load(data);

      const mainTweetEl = $('.main-tweet').first();
      if (!mainTweetEl.length) {
        // Fallback to timeline item if not found
        const firstEl = $('.timeline-item').first();
        if (!firstEl.length) return null;
        return this.parseTweetEl($, firstEl);
      }
      
      const tweet = this.parseTweetEl($, mainTweetEl);
      if (tweet) {
        // Find the previous tweet in the thread, which is likely the parent
        const parentEl = mainTweetEl.prevAll('.timeline-item').first();
        if (parentEl.length) {
          const parentLink = parentEl.find('a.tweet-link').attr('href');
          const idMatch = parentLink?.match(/\/status\/(\d+)/);
          if (idMatch && idMatch[1]) {
            tweet.inReplyToStatusId = idMatch[1];
          }
        }
      }
      
      return tweet;
    } catch (error) {
      this.logger.error('Failed to fetch nitter tweet by id', { tweetId, message: (error as Error).message });
      return null;
    }
  }

  async refreshAuth(_reason: string): Promise<boolean> {
    return true;
  }

  private async fetchTimeline(username: string, suffix: string): Promise<Tweet[]> {
    try {
      const data = await this.getHtmlWithFallback((base) => `${base}/${username}${suffix}`);
      const $ = cheerio.load(data);
      
      const timelineItems = $('.timeline-item');
      if (timelineItems.length === 0 && !$('.profile-card').length) {
        throw new Error('Nitter returned an invalid response (no timeline or profile found)');
      }

      const tweets: Tweet[] = [];
      timelineItems.each((_, el) => {
        const tweet = this.parseTweetEl($, $(el));
        if (tweet) tweets.push(tweet);
      });
      return tweets;
    } catch (error) {
      this.logger.error('Failed to fetch nitter timeline', { username, message: (error as Error).message });
      throw error;
    }
  }

  private parseTweetEl($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): Tweet | null {
    const tweetLink = el.find('a.tweet-link').attr('href');
    if (!tweetLink) return null;

    const idMatch = tweetLink.match(/\/status\/(\d+)/);
    const id = idMatch ? idMatch[1] : '';
    if (!id) return null;

    const authorUrl = el.find('.tweet-header .username').attr('href');
    const authorUsername = authorUrl ? authorUrl.replace('/', '').replace('@', '') : '';
    const authorName = el.find('.tweet-header .fullname').text().trim();
    const profileImage = el.find('.tweet-avatar img').attr('src');

    // Use the active instance URL for resolving relative URLs
    const activeUrl = this.getActiveNitterUrl();
    
    const resolveMediaUrl = (src: string | undefined) => {
      if (!src) return '';
      if (src.startsWith('/')) return `${activeUrl}${src}`;
      return src;
    };

    const text = el.find('.tweet-content').text().trim();
    const dateStr = el.find('.tweet-date a').attr('title');
    let createdAt = new Date().toISOString();
    if (dateStr) {
      try {
        const cleanDate = dateStr.replace('·', '').trim();
        createdAt = new Date(cleanDate).toISOString();
      } catch (e) {}
    }

    const parseMetric = (selector: string) => {
      const text = el.find(selector).siblings('.tweet-stat').text().replace(/,/g, '').trim();
      if (text.includes('K')) return parseFloat(text) * 1000;
      if (text.includes('M')) return parseFloat(text) * 1000000;
      return parseInt(text || '0', 10);
    };

    const metrics = {
      likes: parseMetric('.icon-heart'),
      retweets: parseMetric('.icon-retweet'),
      replies: parseMetric('.icon-comment'),
      bookmarks: 0,
      views: 0
    };

    const media: TweetMedia[] = [];
    el.find('.attachments .attachment').each((_, att) => {
      const isVideo = $(att).find('video').length > 0;
      if (isVideo) {
        const videoSrc = $(att).find('video source').attr('src');
        const poster = $(att).find('video').attr('poster');
        media.push({
          type: 'video',
          url: resolveMediaUrl(videoSrc),
          preview: resolveMediaUrl(poster)
        });
      } else {
        const imgSrc = $(att).find('img').attr('src') || $(att).find('a.still-image').attr('href');
        if (imgSrc) {
          media.push({
            type: 'photo',
            url: resolveMediaUrl(imgSrc),
            preview: resolveMediaUrl(imgSrc)
          });
        }
      }
    });

    const isRetweet = el.find('.retweet-header').length > 0;
    const isReply = el.find('.replying-to').length > 0;
    
    // Attempt to extract inReplyToUsername from the text
    const replyingToText = el.find('.replying-to').text();
    const replyingToMatch = replyingToText.match(/@(\w+)/);
    const inReplyToUsername = replyingToMatch ? replyingToMatch[1] : null;

    let quotedTweet: Tweet | null = null;
    const quoteEl = el.find('.quote');
    if (quoteEl.length) {
      quotedTweet = this.parseTweetEl($, quoteEl) || null;
    }

    return {
      id,
      text,
      createdAt,
      authorId: authorUsername,
      author: {
        username: authorUsername,
        displayName: authorName,
        profileImage: resolveMediaUrl(profileImage)
      },
      metrics,
      conversationId: id,
      inReplyToStatusId: isReply ? 'fetch_me' : null, // Marker to indicate it's a reply and we need to fetch the detail to get the true ID
      inReplyToUserId: null,
      inReplyToUsername,
      isRetweet,
      isThread: false, // In timeline we can't easily tell, assume false
      media,
      urls: [],
      quotedTweet
    };
  }
}
