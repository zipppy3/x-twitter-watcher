import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConfig } from '../src/types';

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function createTestConfig(baseDir: string): AppConfig {
  const dataDir = path.join(baseDir, 'data');
  const downloadRoot = path.join(baseDir, 'download');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(downloadRoot, { recursive: true });

  return {
    envPath: path.join(baseDir, '.env'),
    packageRoot: baseDir,
    projectRoot: path.resolve(baseDir, '..'),
    dataDir,
    dbPath: path.join(dataDir, 'watcher.db'),
    pidPath: path.join(dataDir, 'watcher.pid'),
    logPath: path.join(dataDir, 'daemon.log'),
    downloadRoot,
    twitterAuthToken: 'auth-token',
    twitterCsrfToken: 'csrf-token',
    telegramBotToken: 'bot-token',
    telegramChatId: '12345',
    telegramApiUrl: 'https://api.telegram.org',
    telegramApiId: null,
    telegramApiHash: null,
    telegramAudioThreadId: null,
    telegramMetadataThreadId: null,
    telegramTweetThreadId: null,
    telegramTweetMetadataThreadId: null,
    autoDeleteUploaded: false,
    tweetPollIntervalsMs: [10, 20],
    tweetBootstrapDelayMs: 1,
    screenshotTimeoutMs: 100,
    watchlistReloadIntervalMs: 10,
    spacePollIntervalMs: 10,
  };
}
