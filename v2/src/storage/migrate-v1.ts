import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../runtime/logger';
import { Storage } from '../types';

interface V1WatchlistFile {
  users?: Record<
    string,
    {
      watchSpaces?: boolean;
      watchTweets?: boolean;
      watchReplies?: boolean;
      userId?: string | null;
      telegramAudioTopicId?: string | null;
      telegramMetadataTopicId?: string | null;
      telegramTweetTopicId?: string | null;
      telegramTweetMetadataTopicId?: string | null;
      addedAt?: string;
    }
  >;
}

interface V1StateFile {
  status?: string;
  mode?: string;
  startedAt?: string;
  lastPoll?: string;
  pollCount?: number;
  lastError?: string | null;
  activeSpaces?: Array<{ id: string; title: string; user: string; startedAt: string }>;
  recordings?: Array<{
    title: string;
    user: string;
    duration: string;
    file: string;
    recordedAt: string;
  }>;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export interface MigrateV1Options {
  storage: Storage;
  sourceRoot: string;
  logger: Logger;
}

export interface MigrateV1Result {
  importedUsers: number;
  importedSeenTweets: number;
  importedRecordings: number;
}

export function migrateFromV1(options: MigrateV1Options): MigrateV1Result {
  const sourceRoot = path.resolve(options.sourceRoot);
  const watchlist = readJsonFile<V1WatchlistFile>(path.join(sourceRoot, 'watchlist.json'));
  const seenTweets = readJsonFile<Record<string, string[]>>(path.join(sourceRoot, 'seen-tweets.json'));
  const state = readJsonFile<V1StateFile>(path.join(sourceRoot, '.watcher-state.json'));

  let importedUsers = 0;
  let importedSeenTweets = 0;
  let importedRecordings = 0;

  for (const [username, config] of Object.entries(watchlist?.users ?? {})) {
    const target = options.storage.upsertWatchTarget({
      username,
      userId: config.userId ?? null,
      watchSpaces: config.watchSpaces !== false,
      watchTweets: config.watchTweets !== false,
      watchReplies: config.watchReplies === true,
      telegramAudioTopicId: config.telegramAudioTopicId ?? null,
      telegramMetadataTopicId: config.telegramMetadataTopicId ?? null,
      telegramTweetTopicId: config.telegramTweetTopicId ?? null,
      telegramTweetMetadataTopicId: config.telegramTweetMetadataTopicId ?? null,
    });
    // Preserve original addedAt if v1 had it
    if (config.addedAt && target.addedAt !== config.addedAt) {
      options.storage.upsertWatchTarget({ username, userId: target.userId });
      // Direct update to preserve the original timestamp
      (options.storage as any).overwriteAddedAt?.(username, config.addedAt);
    }
    importedUsers += 1;
  }

  for (const [username, ids] of Object.entries(seenTweets ?? {})) {
    options.storage.markTweetsSeen(username, ids);
    importedSeenTweets += ids.length;
  }

  for (const recording of state?.recordings ?? []) {
    options.storage.addRecording({
      spaceId: null,
      title: recording.title,
      user: recording.user,
      duration: recording.duration,
      filePath: recording.file,
      metadataPath: null,
      recordedAt: recording.recordedAt,
    });
    importedRecordings += 1;
  }

  options.storage.updateRuntimeState({
    status: (state?.status?.toLowerCase() as any) ?? 'stopped',
    mode: state?.mode ?? 'daemon',
    startedAt: state?.startedAt ?? null,
    lastPollAt: state?.lastPoll ?? null,
    pollCount: state?.pollCount ?? 0,
    lastError: state?.lastError ?? null,
    activeSpaces: state?.activeSpaces ?? [],
  });

  options.logger.info('Migration completed', {
    sourceRoot,
    importedUsers,
    importedSeenTweets,
    importedRecordings,
  });

  return {
    importedUsers,
    importedSeenTweets,
    importedRecordings,
  };
}
