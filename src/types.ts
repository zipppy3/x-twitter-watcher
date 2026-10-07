export type WatchMode = 'all' | 'spaces' | 'tweets';
export type RuntimeStatus = 'idle' | 'watching' | 'recording' | 'downloading' | 'stopped' | 'error';

export interface AppConfig {
  envPath: string;
  packageRoot: string;
  projectRoot: string;
  dataDir: string;
  dbPath: string;
  pidPath: string;
  logPath: string;
  downloadRoot: string;
  twitterAuthToken: string | null;
  twitterCsrfToken: string | null;
  dataSource: 'twitter' | 'nitter';
  nitterUrl: string | null;
  nitterFallbackUrls: string[];
  proxyEnabled: boolean;
  proxyIsRotatingEndpoint: boolean;
  proxyFallbackOnBan: boolean;
  proxyList: string[];
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramApiUrl: string;
  telegramApiId: string | null;
  telegramApiHash: string | null;
  telegramAudioThreadId: string | null;
  telegramMetadataThreadId: string | null;
  telegramTweetThreadId: string | null;
  telegramTweetMetadataThreadId: string | null;
  /** Topic for watcher notices (started/stopped, Space live, health alerts). Empty = the group's General topic. */
  telegramStatusThreadId: string | null;
  /** Topic for "tweet deleted" notices. Empty = the topic the tweet itself was posted in. */
  telegramDeletedThreadId: string | null;
  /** How many days a posted tweet keeps being checked for deletion. 0 turns the check off. */
  deletedTweetCheckDays: number;
  deletionCheckIntervalMs: number;
  /** Most tweets looked up per deletion-check cycle, so the check cannot eat the X rate limit. */
  deletionCheckBatchSize: number;
  autoDeleteUploaded: boolean;
  /** Take X screenshots with the account's session (shows whole threads) instead of logged out. */
  screenshotLoggedIn: boolean;
  /** How long a data source may keep failing before a Telegram alert is sent. */
  healthAlertAfterMs: number;
  /** Local hour (0-23) of the daily "still alive" report, or null when disabled. */
  healthDailyReportHour: number | null;
  tweetPollIntervalsMs: [number, number];
  tweetBootstrapDelayMs: number;
  screenshotTimeoutMs: number;
  watchlistReloadIntervalMs: number;
  spacePollIntervalMs: number;
}

export type HealthSource = 'x-api' | 'nitter' | 'spaces' | 'screenshot' | 'telegram';

/** Where the fetchers report what happened, so outages do not go unnoticed. */
export interface HealthReporter {
  /** A request to `source` succeeded. */
  ok(source: HealthSource): void;
  /** A request to `source` failed for good (after any retries). */
  fail(source: HealthSource, message: string): void;
  /** The tweet polling loop finished a cycle. */
  beat(): void;
  /** Something was delivered (shown in the daily report). */
  count(what: 'tweets' | 'spaces' | 'deleted'): void;
}

export interface WatchTarget {
  username: string;
  userId: string | null;
  watchSpaces: boolean;
  watchTweets: boolean;
  watchReplies: boolean;
  saveMedia: boolean;
  saveScreenshots: boolean;
  saveMetadata: boolean;
  telegramAudioTopicId: string | null;
  telegramMetadataTopicId: string | null;
  telegramTweetTopicId: string | null;
  telegramTweetMetadataTopicId: string | null;
  addedAt: string;
  updatedAt: string;
}

export interface WatchTargetInput {
  username: string;
  userId?: string | null;
  watchSpaces?: boolean;
  watchTweets?: boolean;
  watchReplies?: boolean;
  saveMedia?: boolean;
  saveScreenshots?: boolean;
  saveMetadata?: boolean;
  telegramAudioTopicId?: string | null;
  telegramMetadataTopicId?: string | null;
  telegramTweetTopicId?: string | null;
  telegramTweetMetadataTopicId?: string | null;
}

export interface ActiveSpace {
  id: string;
  title: string;
  user: string;
  startedAt: string;
}

export interface RecordingRecord {
  id?: number;
  spaceId: string | null;
  title: string;
  user: string;
  duration: string;
  filePath: string;
  metadataPath: string | null;
  recordedAt: string;
}

export interface RuntimeState {
  status: RuntimeStatus;
  mode: string;
  startedAt: string | null;
  lastPollAt: string | null;
  pollCount: number;
  lastError: string | null;
  activeSpaces: ActiveSpace[];
  updatedAt: string | null;
}

export interface WatcherStatus {
  running: boolean;
  pid: number | null;
  state: RuntimeStatus;
  mode: string;
  uptime: string;
  spaceUsers: number;
  tweetUsers: number;
  replyUsers: number;
  pollCount: number;
  totalSeenTweets: number;
  totalRecordings: number;
  activeSpaces: ActiveSpace[];
  lastError: string | null;
}

export interface TweetMedia {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  preview?: string;
}

export interface TweetMetrics {
  likes: number;
  retweets: number;
  replies: number;
  bookmarks: number;
  views: number;
}

export interface TweetAuthor {
  username: string;
  displayName: string;
  profileImage?: string;
}

export interface Tweet {
  id: string;
  text: string;
  createdAt: string;
  authorId: string;
  author: TweetAuthor;
  metrics: TweetMetrics;
  conversationId: string;
  inReplyToStatusId: string | null;
  inReplyToUserId: string | null;
  inReplyToUsername: string | null;
  isRetweet: boolean;
  isThread: boolean;
  media: TweetMedia[];
  urls: Array<{ display: string; expanded: string }>;
  quotedTweet: Tweet | null;
  inReplyToTweet?: Tweet | null;
}

export interface TelegramMediaItem {
  type: 'photo' | 'video';
  path: string;
}

/** Filled in by a send call that succeeded, for callers that need to link back to the message. */
export interface TelegramReceipt {
  messageId?: number;
}

/** A tweet that was posted to Telegram and is still being checked for deletion. */
export interface DeliveredTweet {
  username: string;
  tweetId: string;
  text: string;
  /** When the tweet was posted on X (ISO), or null when that could not be parsed. */
  postedAt: string | null;
  deliveredAt: string;
  telegramMessageId: number | null;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  /** Lookups in a row that found the tweet gone. */
  missingCount: number;
  deletedAt: string | null;
}

export interface DeliveredTweetInput {
  tweetId: string;
  text: string;
  postedAt: string | null;
  telegramMessageId: number | null;
  nextCheckAt: string;
}

/**
 * `gone`: X answered and has no such tweet. `unavailable`: X hides it for another
 * reason (suspended or protected account, withheld). `unknown`: the request failed
 * or the answer was not understood, which says nothing about the tweet.
 */
export type TweetStatus = 'exists' | 'gone' | 'unavailable' | 'unknown';

export type AccountStatus = 'visible' | 'unavailable' | 'unknown';

export interface TweetStatusSource {
  getTweetStatus(tweetId: string): Promise<TweetStatus>;
  getAccountStatus(username: string): Promise<AccountStatus>;
}

export interface SpaceLiveEvent {
  spaceId: string;
  title: string;
  user: string;
  startedAt: string;
}

export interface SpaceRecordedEvent {
  spaceId: string;
  title: string;
  user: string;
  duration: string;
  filePath: string;
  metadataPath: string | null;
  recordedAt: string;
}

export interface SpacePollEvent {
  usernames: string[];
  pollCount: number;
  polledAt: string;
}

export interface SpacesProviderEvents {
  poll: SpacePollEvent;
  live: SpaceLiveEvent;
  recorded: SpaceRecordedEvent;
  error: Error;
}

export interface Storage {
  init(): void;
  close(): void;
  getWatchTargets(): WatchTarget[];
  getWatchTarget(username: string): WatchTarget | null;
  upsertWatchTarget(input: WatchTargetInput): WatchTarget;
  removeWatchTarget(username: string): boolean;
  getSeenTweetIds(username: string): string[];
  markTweetsSeen(username: string, ids: string[]): void;
  deleteSeenTweets(username: string): void;
  renameWatchTarget(oldUsername: string, newUsername: string): boolean;
  trackDeliveredTweets(username: string, tweets: DeliveredTweetInput[]): void;
  /** Tweets of one account that are still being checked for deletion. */
  getTrackedTweets(username: string): DeliveredTweet[];
  getDueDeletionChecks(now: string, limit: number): DeliveredTweet[];
  /** Pull the next check of these tweets forward to `now`. */
  requestDeletionCheck(username: string, tweetIds: string[], now: string): void;
  recordDeletionCheck(
    username: string,
    tweetId: string,
    result: { checkedAt: string; missingCount: number; nextCheckAt: string }
  ): void;
  markTweetDeleted(username: string, tweetId: string, deletedAt: string): void;
  /** Forget tracked tweets delivered before `cutoff`; returns how many were dropped. */
  pruneDeliveredTweets(cutoff: string): number;
  forgetDeliveredTweets(username: string): void;
  getRuntimeState(): RuntimeState;
  updateRuntimeState(patch: Partial<RuntimeState>): RuntimeState;
  setActiveSpaces(activeSpaces: ActiveSpace[]): RuntimeState;
  addRecording(record: RecordingRecord): void;
  getRecordings(limit?: number): RecordingRecord[];
  getRecordingCount(): number;
  deleteOldRecordings(days: number): RecordingRecord[];
  getSeenTweetCount(): number;
  backup(destinationPath: string): Promise<void>;
  checkIntegrity(): boolean;
}

export interface TwitterClient {
  resolveUserId(username: string): Promise<string | null>;
  getUserTweets(userId: string, count?: number): Promise<Tweet[]>;
  getUserTweetsAndReplies(userId: string, count?: number): Promise<Tweet[]>;
  getTweetById(tweetId: string): Promise<Tweet | null>;
  refreshAuth(reason: string): Promise<boolean>;
}

export interface TelegramClient {
  isConfigured(): boolean;
  sendMessage(message: string, threadId?: string | null, receipt?: TelegramReceipt): Promise<boolean>;
  sendPhoto(filePath: string, caption?: string, threadId?: string | null, receipt?: TelegramReceipt): Promise<boolean>;
  sendVideo(filePath: string, caption?: string, threadId?: string | null, receipt?: TelegramReceipt): Promise<boolean>;
  sendDocument(filePath: string, threadId?: string | null): Promise<boolean>;
  sendAudio(
    filePath: string,
    options?: { title?: string; performer?: string; durationSec?: number; threadId?: string | null }
  ): Promise<boolean>;
  sendMediaGroup(
    items: TelegramMediaItem[],
    caption?: string,
    threadId?: string | null,
    receipt?: TelegramReceipt
  ): Promise<boolean>;
}

export interface ScreenshotService {
  captureTweet(username: string, tweetId: string, outputPath: string, isReply?: boolean): Promise<string | null>;
  captureThread(username: string, tweetId: string, outputPath: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface SpacesProvider {
  start(initialTargets: WatchTarget[]): Promise<void>;
  stop(): Promise<void>;
  addUser(target: WatchTarget): Promise<void>;
  removeUser(username: string): Promise<void>;
  on<EventName extends keyof SpacesProviderEvents>(
    event: EventName,
    handler: (payload: SpacesProviderEvents[EventName]) => void
  ): this;
  off<EventName extends keyof SpacesProviderEvents>(
    event: EventName,
    handler: (payload: SpacesProviderEvents[EventName]) => void
  ): this;
}
