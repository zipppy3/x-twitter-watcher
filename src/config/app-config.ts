import path from 'node:path';
import dotenv from 'dotenv';
import { AppConfig } from '../types';
import { dataDir, ensureDir, packageRoot, projectRoot, resolveDownloadRoot, resolveEnvPath } from '../runtime/paths';

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readNullableEnv(key: string): string | null {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return null;
  }
  return value;
}

/** Empty means the default (09:00); "off" or anything that is not an hour disables the report. */
function parseReportHour(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return 9;
  }
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

export interface AppConfigOptions {
  envPath?: string;
  dbPath?: string;
  downloadRoot?: string;
}

export function loadAppConfig(options: AppConfigOptions = {}): AppConfig {
  const envPath = resolveEnvPath(options.envPath);
  dotenv.config({ path: envPath, override: true, quiet: true } as any);

  const resolvedDataDir = ensureDir(dataDir);
  const dbPath = options.dbPath ? path.resolve(options.dbPath) : path.join(resolvedDataDir, 'watcher.db');
  const pidPath = path.join(resolvedDataDir, 'watcher.pid');
  const logPath = path.join(resolvedDataDir, 'daemon.log');

  return {
    envPath,
    packageRoot,
    projectRoot,
    dataDir: resolvedDataDir,
    dbPath,
    pidPath,
    logPath,
    downloadRoot: resolveDownloadRoot(options.downloadRoot),
    twitterAuthToken: readNullableEnv('TWITTER_AUTH_TOKEN'),
    twitterCsrfToken: readNullableEnv('TWITTER_CSRF_TOKEN'),
    dataSource: (readNullableEnv('DATA_SOURCE') as 'twitter' | 'nitter') || 'twitter',
    nitterUrl: readNullableEnv('NITTER_URL'),
    nitterFallbackUrls: (readNullableEnv('NITTER_FALLBACK_URLS') || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    proxyEnabled: parseBoolean(process.env.PROXY_ENABLED, false),
    proxyIsRotatingEndpoint: parseBoolean(process.env.PROXY_IS_ROTATING_ENDPOINT, false),
    proxyFallbackOnBan: parseBoolean(process.env.PROXY_FALLBACK_ON_BAN, false),
    proxyList: (readNullableEnv('PROXY_LIST') || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    telegramBotToken: readNullableEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: readNullableEnv('TELEGRAM_CHAT_ID'),
    telegramApiUrl: readNullableEnv('TELEGRAM_API_URL') ?? 'https://api.telegram.org',
    telegramApiId: readNullableEnv('TELEGRAM_API_ID'),
    telegramApiHash: readNullableEnv('TELEGRAM_API_HASH'),
    telegramAudioThreadId: readNullableEnv('TELEGRAM_AUDIO_THREAD_ID'),
    telegramMetadataThreadId: readNullableEnv('TELEGRAM_METADATA_THREAD_ID'),
    telegramTweetThreadId: readNullableEnv('TELEGRAM_TWEET_THREAD_ID'),
    telegramTweetMetadataThreadId: readNullableEnv('TELEGRAM_TWEET_METADATA_THREAD_ID'),
    telegramStatusThreadId: readNullableEnv('TELEGRAM_STATUS_THREAD_ID'),
    autoDeleteUploaded: parseBoolean(process.env.AUTO_DELETE_UPLOADED, false),
    screenshotLoggedIn: parseBoolean(process.env.SCREENSHOT_LOGGED_IN, false),
    healthAlertAfterMs: (Number(process.env.HEALTH_ALERT_AFTER_MINUTES) || 15) * 60 * 1000,
    healthDailyReportHour: parseReportHour(process.env.HEALTH_DAILY_REPORT_HOUR),
    tweetPollIntervalsMs: [60000, 120000],
    tweetBootstrapDelayMs: 5000,
    screenshotTimeoutMs: 60000,
    watchlistReloadIntervalMs: 5000,
    spacePollIntervalMs: 30000,
  };
}
