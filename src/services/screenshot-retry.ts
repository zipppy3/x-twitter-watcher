import fs from 'node:fs';
import { AppConfig, FailedScreenshot, FailedScreenshotInput, ScreenshotService, Storage, TelegramClient, TelegramReceipt } from '../types';
import { rootLogger } from '../runtime/logger';
import { buildScreenshotFailedMessage } from './telegram-messages';

/** A failure that was never retried is forgotten after this long. */
const KEEP_FAILURES_MS = 14 * 24 * 60 * 60 * 1000;

export interface RetryOutcome {
  postId: string;
  username: string;
  /** Every screenshot of the post was taken and sent. */
  ok: boolean;
  /** How many of the post's screenshots are still missing. */
  remaining: number;
}

/**
 * Keeps track of posts that went out without their screenshot and takes the
 * screenshot again on request. Retried images are sent as a reply to the
 * original post, in the same topic.
 */
export class ScreenshotRetryService {
  private readonly logger = rootLogger.child('screenshot-retry');

  private busy = false;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly telegram: TelegramClient,
    private readonly screenshots: ScreenshotService
  ) {}

  get isBusy(): boolean {
    return this.busy;
  }

  /** What is waiting for a retry. */
  pending(): FailedScreenshot[] {
    try {
      this.storage.pruneFailedScreenshots(new Date(Date.now() - KEEP_FAILURES_MS).toISOString());
    } catch (error) {
      this.logger.warn('Could not prune old screenshot failures', { message: (error as Error).message });
    }
    return this.storage.getFailedScreenshots();
  }

  /**
   * Called once a post has been delivered without some of its screenshots:
   * remembers them and tells the chat which post it was.
   */
  async report(failed: FailedScreenshotInput[], topicId: string | null): Promise<void> {
    if (!failed.length) {
      return;
    }

    try {
      this.storage.recordFailedScreenshots(failed);
      const stored = this.storage.getFailedScreenshots().filter((item) => item.postId === failed[0].postId);
      const receipt: TelegramReceipt = {};
      await this.telegram.sendMessage(buildScreenshotFailedMessage(stored), topicId, receipt, failed[0].telegramMessageId);
      if (receipt.messageId) {
        this.storage.setFailedScreenshotNotice(failed[0].postId, receipt.messageId);
      }
    } catch (error) {
      // The post itself was delivered; this is only the follow-up.
      this.logger.warn('Could not record or announce a failed screenshot', { message: (error as Error).message });
    }
  }

  /** Posts a `/retry` argument or a replied-to message refers to. */
  find(options: { postId?: string; messageId?: number }): string[] {
    const failed = this.pending();
    if (options.postId) {
      return failed.some((item) => item.postId === options.postId) ? [options.postId] : [];
    }
    if (options.messageId) {
      const hit = failed.find(
        (item) => item.noticeMessageId === options.messageId || item.telegramMessageId === options.messageId
      );
      return hit ? [hit.postId] : [];
    }
    return [];
  }

  /**
   * Retry the given posts (all pending ones when `postIds` is null), one after
   * the other so a batch does not hammer X. Returns null when a retry is
   * already running.
   */
  async retry(postIds: string[] | null): Promise<RetryOutcome[] | null> {
    if (this.busy) {
      return null;
    }
    this.busy = true;
    try {
      const failed = this.pending().filter((item) => !postIds || postIds.includes(item.postId));
      const outcomes = new Map<string, RetryOutcome>();

      for (const item of failed) {
        const outcome = outcomes.get(item.postId) ?? { postId: item.postId, username: item.username, ok: true, remaining: 0 };
        outcomes.set(item.postId, outcome);
        if (!(await this.retryOne(item))) {
          outcome.ok = false;
          outcome.remaining += 1;
        }
      }
      return [...outcomes.values()];
    } finally {
      this.busy = false;
    }
  }

  private async retryOne(item: FailedScreenshot): Promise<boolean> {
    try {
      const path =
        item.kind === 'thread'
          ? await this.screenshots.captureThread(item.captureUsername, item.captureTweetId, item.outputPath)
          : await this.screenshots.captureTweet(item.captureUsername, item.captureTweetId, item.outputPath, item.isReply);
      if (!path) {
        this.storage.noteFailedScreenshotAttempt(item.postId, item.kind);
        return false;
      }

      const caption = `📸 <a href="https://x.com/${encodeURIComponent(item.username)}/status/${item.postId}">Screenshot</a> · <b>@${item.username}</b>`;
      const sent = await this.telegram.sendPhoto(path, caption, item.topicId, undefined, item.telegramMessageId);
      if (!sent) {
        this.storage.noteFailedScreenshotAttempt(item.postId, item.kind);
        return false;
      }

      this.storage.removeFailedScreenshot(item.postId, item.kind);
      if (this.config.autoDeleteUploaded) {
        fs.rmSync(path, { force: true });
      }
      return true;
    } catch (error) {
      this.logger.warn('Screenshot retry failed', { postId: item.postId, message: (error as Error).message });
      return false;
    }
  }
}
