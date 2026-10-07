import { AccountStatus, AppConfig, DeliveredTweet, HealthReporter, Storage, TelegramClient, TweetStatusSource } from '../types';
import { rootLogger } from '../runtime/logger';
import { randomSleep } from '../utils/async';
import { getTopicId } from '../services/topic-routing';
import {
  buildAccountUnavailableMessage,
  buildTweetDeletedMessage,
  telegramMessageLink,
} from '../services/telegram-messages';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A new tweet gets its first check this long after it was posted to Telegram. */
export const FIRST_DELETION_CHECK_DELAY_MS = 15 * MINUTE_MS;

/** How long a tweet that was just checked is left alone, even when a timeline poll misses it again. */
export const MIN_RECHECK_GAP_MS = 30 * MINUTE_MS;

/**
 * Most deletions happen soon after posting, so fresh tweets are checked often
 * and old ones rarely. That keeps the number of lookups (and the load on the X
 * rate limit) roughly constant however many tweets are being tracked.
 */
export function recheckIntervalMs(ageMs: number): number {
  if (ageMs < DAY_MS) {
    return HOUR_MS;
  }
  if (ageMs < 7 * DAY_MS) {
    return 12 * HOUR_MS;
  }
  return 48 * HOUR_MS;
}

/**
 * Checks tweets that were posted to Telegram for deletion.
 *
 * A tweet is reported only after X said twice, on separate cycles, that it is
 * gone, and only while the account itself is still visible: a suspended or
 * private account hides every tweet at once, which is not a deletion. A failed
 * lookup proves nothing, so it ends the cycle and the tweet is tried again later.
 */
export class DeletionCheckWorker {
  private readonly logger = rootLogger.child('deletion-check');

  private timer: NodeJS.Timeout | null = null;

  private running = false;

  /** Lookups that must find a tweet gone before it is reported. */
  private static readonly CONFIRMATIONS = 2;

  private static readonly CONFIRM_DELAY_MS = 10 * MINUTE_MS;

  private static readonly BOOTSTRAP_DELAY_MS = MINUTE_MS;

  /** Accounts already reported as unavailable, so the notice is sent once per outage. */
  private readonly unavailableAccounts = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly source: TweetStatusSource,
    private readonly telegramClient: TelegramClient,
    private readonly health?: HealthReporter
  ) {}

  async start(): Promise<void> {
    if (this.running || this.config.deletedTweetCheckDays <= 0) {
      return;
    }
    this.running = true;
    this.schedule(Math.min(DeletionCheckWorker.BOOTSTRAP_DELAY_MS, this.config.deletionCheckIntervalMs));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.runOnce()
        .catch((error) => {
          this.logger.error('Deletion check cycle crashed', { message: (error as Error).message });
        })
        .finally(() => this.schedule(this.config.deletionCheckIntervalMs));
    }, ms);
  }

  /** One cycle: look up the tweets whose check is due, up to the batch size. */
  async runOnce(now: () => number = Date.now): Promise<void> {
    const retentionMs = this.config.deletedTweetCheckDays * DAY_MS;
    this.storage.pruneDeliveredTweets(new Date(now() - retentionMs).toISOString());

    const due = this.storage.getDueDeletionChecks(new Date(now()).toISOString(), this.config.deletionCheckBatchSize);
    const accountStatus = new Map<string, AccountStatus>();
    let first = true;

    for (const tweet of due) {
      if (!this.running) {
        return;
      }

      const target = this.storage.getWatchTarget(tweet.username);
      if (!target || !target.watchTweets) {
        // No longer watched: nobody is waiting for news about its tweets.
        this.storage.forgetDeliveredTweets(tweet.username);
        continue;
      }

      if (!first) {
        await randomSleep(1000, 2500);
      }
      first = false;

      const status = await this.source.getTweetStatus(tweet.tweetId);
      const checkedAt = now();

      if (status === 'unknown') {
        // X is failing or rate limiting (the client reports that to the health
        // monitor). Everything stays due and is tried again next cycle.
        this.logger.warn('Tweet lookup failed, ending this deletion check cycle early', { tweetId: tweet.tweetId });
        return;
      }

      if (status === 'exists' || status === 'unavailable') {
        if (status === 'exists') {
          this.unavailableAccounts.delete(tweet.username);
        }
        this.reschedule(tweet, checkedAt, 0, this.nextRegularCheck(tweet, checkedAt));
        continue;
      }

      const missingCount = tweet.missingCount + 1;
      if (missingCount < DeletionCheckWorker.CONFIRMATIONS) {
        this.logger.info('Tweet looks deleted, confirming on a later cycle', {
          username: tweet.username,
          tweetId: tweet.tweetId,
        });
        this.reschedule(tweet, checkedAt, missingCount, checkedAt + DeletionCheckWorker.CONFIRM_DELAY_MS);
        continue;
      }

      let account = accountStatus.get(tweet.username);
      if (!account) {
        account = await this.source.getAccountStatus(tweet.username);
        accountStatus.set(tweet.username, account);
      }

      if (account === 'unknown') {
        return;
      }

      if (account === 'unavailable') {
        await this.reportUnavailableAccount(tweet);
        this.reschedule(tweet, checkedAt, missingCount, checkedAt + DAY_MS);
        continue;
      }

      this.unavailableAccounts.delete(tweet.username);
      if (await this.reportDeleted(tweet, checkedAt)) {
        this.storage.markTweetDeleted(tweet.username, tweet.tweetId, new Date(checkedAt).toISOString());
        this.health?.count('deleted');
      } else {
        // Telegram did not take the notice. The tweet stays due, so it is announced
        // on a later cycle instead of being dropped.
        this.storage.recordDeletionCheck(tweet.username, tweet.tweetId, {
          checkedAt: new Date(checkedAt).toISOString(),
          missingCount,
          nextCheckAt: tweet.nextCheckAt,
        });
      }
    }
  }

  private nextRegularCheck(tweet: DeliveredTweet, checkedAt: number): number {
    const age = checkedAt - new Date(tweet.deliveredAt).getTime();
    return checkedAt + recheckIntervalMs(Number.isFinite(age) ? age : 0);
  }

  private reschedule(tweet: DeliveredTweet, checkedAt: number, missingCount: number, nextCheckAt: number): void {
    this.storage.recordDeletionCheck(tweet.username, tweet.tweetId, {
      checkedAt: new Date(checkedAt).toISOString(),
      missingCount,
      nextCheckAt: new Date(nextCheckAt).toISOString(),
    });
  }

  private noticeTopic(tweet: DeliveredTweet): string | null {
    return (
      this.config.telegramDeletedThreadId ??
      getTopicId(this.config, this.storage.getWatchTarget(tweet.username), 'tweet')
    );
  }

  private async reportDeleted(tweet: DeliveredTweet, noticedAt: number): Promise<boolean> {
    this.logger.info('Tweet was deleted', { username: tweet.username, tweetId: tweet.tweetId });
    if (!this.telegramClient.isConfigured()) {
      return true;
    }
    const savedCopy = telegramMessageLink(this.config.telegramChatId, tweet.telegramMessageId);
    return this.telegramClient.sendMessage(
      buildTweetDeletedMessage(tweet, new Date(noticedAt), savedCopy),
      this.noticeTopic(tweet)
    );
  }

  private async reportUnavailableAccount(tweet: DeliveredTweet): Promise<void> {
    if (this.unavailableAccounts.has(tweet.username)) {
      return;
    }
    this.logger.warn('Account is unavailable; its missing tweets are not reported as deleted', {
      username: tweet.username,
    });
    if (
      !this.telegramClient.isConfigured() ||
      (await this.telegramClient.sendMessage(buildAccountUnavailableMessage(tweet.username), this.noticeTopic(tweet)))
    ) {
      this.unavailableAccounts.add(tweet.username);
    }
  }
}
