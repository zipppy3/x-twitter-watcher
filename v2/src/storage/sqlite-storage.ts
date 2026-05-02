import Database from 'better-sqlite3';
import { ActiveSpace, RecordingRecord, RuntimeState, Storage, WatchTarget, WatchTargetInput } from '../types';
import { ensureFileDir } from '../utils/files';

const DEFAULT_RUNTIME_STATE: RuntimeState = {
  status: 'stopped',
  mode: 'daemon',
  startedAt: null,
  lastPollAt: null,
  pollCount: 0,
  lastError: null,
  activeSpaces: [],
  updatedAt: null,
};

function boolToInt(value: boolean | undefined, fallback: boolean): number {
  return value === undefined ? Number(fallback) : Number(value);
}

function rowToWatchTarget(row: any): WatchTarget {
  return {
    username: row.username,
    userId: row.user_id,
    watchSpaces: Boolean(row.watch_spaces),
    watchTweets: Boolean(row.watch_tweets),
    watchReplies: Boolean(row.watch_replies),
    saveMedia: row.save_media === undefined ? true : Boolean(row.save_media),
    saveScreenshots: row.save_screenshots === undefined ? true : Boolean(row.save_screenshots),
    saveMetadata: row.save_metadata === undefined ? true : Boolean(row.save_metadata),
    telegramAudioTopicId: row.telegram_audio_topic_id,
    telegramMetadataTopicId: row.telegram_metadata_topic_id,
    telegramTweetTopicId: row.telegram_tweet_topic_id,
    telegramTweetMetadataTopicId: row.telegram_tweet_metadata_topic_id,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRuntimeState(row: any): RuntimeState {
  if (!row) {
    return { ...DEFAULT_RUNTIME_STATE };
  }

  let activeSpaces: ActiveSpace[] = [];
  try {
    activeSpaces = JSON.parse(row.active_spaces_json || '[]');
  } catch {
    activeSpaces = [];
  }

  return {
    status: row.status,
    mode: row.mode,
    startedAt: row.started_at,
    lastPollAt: row.last_poll_at,
    pollCount: row.poll_count,
    lastError: row.last_error,
    activeSpaces,
    updatedAt: row.updated_at,
  };
}

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;

  constructor(private readonly dbPath: string) {
    ensureFileDir(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }

  init(): void {
    const currentVersion = this.db.pragma('user_version', { simple: true }) as number;

    if (currentVersion === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS watched_accounts (
          username TEXT PRIMARY KEY,
          user_id TEXT,
          watch_spaces INTEGER NOT NULL DEFAULT 1,
          watch_tweets INTEGER NOT NULL DEFAULT 1,
          watch_replies INTEGER NOT NULL DEFAULT 0,
          save_media INTEGER NOT NULL DEFAULT 1,
          save_screenshots INTEGER NOT NULL DEFAULT 1,
          save_metadata INTEGER NOT NULL DEFAULT 1,
          telegram_audio_topic_id TEXT,
          telegram_metadata_topic_id TEXT,
          telegram_tweet_topic_id TEXT,
          telegram_tweet_metadata_topic_id TEXT,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS seen_tweets (
          username TEXT NOT NULL,
          tweet_id TEXT NOT NULL,
          seen_at TEXT NOT NULL,
          PRIMARY KEY (username, tweet_id)
        );

        CREATE INDEX IF NOT EXISTS idx_seen_tweets_username_seen_at
          ON seen_tweets (username, seen_at DESC);

        CREATE TABLE IF NOT EXISTS recordings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          space_id TEXT,
          title TEXT NOT NULL,
          user TEXT NOT NULL,
          duration TEXT NOT NULL,
          file_path TEXT NOT NULL UNIQUE,
          metadata_path TEXT,
          recorded_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runtime_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          status TEXT NOT NULL,
          mode TEXT NOT NULL,
          started_at TEXT,
          last_poll_at TEXT,
          poll_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          active_spaces_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT
        );
      `);

      this.db
        .prepare(
          `
            INSERT INTO runtime_state (id, status, mode, active_spaces_json)
            VALUES (1, @status, @mode, @activeSpacesJson)
            ON CONFLICT(id) DO NOTHING
          `
        )
        .run({
          status: DEFAULT_RUNTIME_STATE.status,
          mode: DEFAULT_RUNTIME_STATE.mode,
          activeSpacesJson: JSON.stringify(DEFAULT_RUNTIME_STATE.activeSpaces),
        });

      // ── Migrate existing tables: add save preference columns if missing ──
      const cols = this.db.prepare("PRAGMA table_info('watched_accounts')").all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has('save_media')) {
        this.db.exec('ALTER TABLE watched_accounts ADD COLUMN save_media INTEGER NOT NULL DEFAULT 1');
      }
      if (!colNames.has('save_screenshots')) {
        this.db.exec('ALTER TABLE watched_accounts ADD COLUMN save_screenshots INTEGER NOT NULL DEFAULT 1');
      }
      if (!colNames.has('save_metadata')) {
        this.db.exec('ALTER TABLE watched_accounts ADD COLUMN save_metadata INTEGER NOT NULL DEFAULT 1');
      }
      
      this.db.pragma('user_version = 1');
    }
  }

  close(): void {
    this.db.close();
  }

  getWatchTargets(): WatchTarget[] {
    return this.db.prepare('SELECT * FROM watched_accounts ORDER BY username').all().map(rowToWatchTarget);
  }

  getWatchTarget(username: string): WatchTarget | null {
    const row = this.db
      .prepare('SELECT * FROM watched_accounts WHERE username = ?')
      .get(username.toLowerCase());
    return row ? rowToWatchTarget(row) : null;
  }

  upsertWatchTarget(input: WatchTargetInput): WatchTarget {
    const username = input.username.toLowerCase().replace('@', '');
    const existing = this.getWatchTarget(username);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          INSERT INTO watched_accounts (
            username,
            user_id,
            watch_spaces,
            watch_tweets,
            watch_replies,
            save_media,
            save_screenshots,
            save_metadata,
            telegram_audio_topic_id,
            telegram_metadata_topic_id,
            telegram_tweet_topic_id,
            telegram_tweet_metadata_topic_id,
            added_at,
            updated_at
          )
          VALUES (
            @username,
            @userId,
            @watchSpaces,
            @watchTweets,
            @watchReplies,
            @saveMedia,
            @saveScreenshots,
            @saveMetadata,
            @telegramAudioTopicId,
            @telegramMetadataTopicId,
            @telegramTweetTopicId,
            @telegramTweetMetadataTopicId,
            @addedAt,
            @updatedAt
          )
          ON CONFLICT(username) DO UPDATE SET
            user_id = excluded.user_id,
            watch_spaces = excluded.watch_spaces,
            watch_tweets = excluded.watch_tweets,
            watch_replies = excluded.watch_replies,
            save_media = excluded.save_media,
            save_screenshots = excluded.save_screenshots,
            save_metadata = excluded.save_metadata,
            telegram_audio_topic_id = excluded.telegram_audio_topic_id,
            telegram_metadata_topic_id = excluded.telegram_metadata_topic_id,
            telegram_tweet_topic_id = excluded.telegram_tweet_topic_id,
            telegram_tweet_metadata_topic_id = excluded.telegram_tweet_metadata_topic_id,
            updated_at = excluded.updated_at
        `
      )
      .run({
        username,
        userId: input.userId ?? existing?.userId ?? null,
        watchSpaces: boolToInt(input.watchSpaces, existing?.watchSpaces ?? true),
        watchTweets: boolToInt(input.watchTweets, existing?.watchTweets ?? true),
        watchReplies: boolToInt(input.watchReplies, existing?.watchReplies ?? false),
        saveMedia: boolToInt(input.saveMedia, existing?.saveMedia ?? true),
        saveScreenshots: boolToInt(input.saveScreenshots, existing?.saveScreenshots ?? true),
        saveMetadata: boolToInt(input.saveMetadata, existing?.saveMetadata ?? true),
        telegramAudioTopicId: input.telegramAudioTopicId ?? existing?.telegramAudioTopicId ?? null,
        telegramMetadataTopicId: input.telegramMetadataTopicId ?? existing?.telegramMetadataTopicId ?? null,
        telegramTweetTopicId: input.telegramTweetTopicId ?? existing?.telegramTweetTopicId ?? null,
        telegramTweetMetadataTopicId:
          input.telegramTweetMetadataTopicId ?? existing?.telegramTweetMetadataTopicId ?? null,
        addedAt: existing?.addedAt ?? now,
        updatedAt: now,
      });

    return this.getWatchTarget(username)!;
  }

  removeWatchTarget(username: string): boolean {
    const result = this.db
      .prepare('DELETE FROM watched_accounts WHERE username = ?')
      .run(username.toLowerCase().replace('@', ''));
    return result.changes > 0;
  }

  overwriteAddedAt(username: string, addedAt: string): void {
    this.db
      .prepare('UPDATE watched_accounts SET added_at = ? WHERE username = ?')
      .run(addedAt, username.toLowerCase().replace('@', ''));
  }

  renameWatchTarget(oldUsername: string, newUsername: string): boolean {
    const oldName = oldUsername.toLowerCase().replace('@', '');
    const newName = newUsername.toLowerCase().replace('@', '');

    if (oldName === newName) {
      return true;
    }

    try {
      this.db.transaction(() => {
        // Update watched_accounts
        this.db
          .prepare('UPDATE watched_accounts SET username = ?, updated_at = ? WHERE username = ?')
          .run(newName, new Date().toISOString(), oldName);

        // Update seen_tweets
        this.db
          .prepare('UPDATE seen_tweets SET username = ? WHERE username = ?')
          .run(newName, oldName);
      })();
      return true;
    } catch (error) {
      return false;
    }
  }

  getSeenTweetIds(username: string): string[] {
    return this.db
      .prepare(
        `
          SELECT tweet_id
          FROM seen_tweets
          WHERE username = ?
          ORDER BY seen_at DESC
        `
      )
      .all(username.toLowerCase())
      .map((row: any) => row.tweet_id);
  }

  markTweetsSeen(username: string, ids: string[]): void {
    if (!ids.length) {
      return;
    }

    const normalizedUsername = username.toLowerCase();
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `
        INSERT OR IGNORE INTO seen_tweets (username, tweet_id, seen_at)
        VALUES (?, ?, ?)
      `
    );
    const prune = this.db.prepare(
      `
        DELETE FROM seen_tweets
        WHERE username = ?
          AND tweet_id NOT IN (
            SELECT tweet_id
            FROM seen_tweets
            WHERE username = ?
            ORDER BY seen_at DESC, tweet_id DESC
            LIMIT 500
          )
      `
    );

    const tx = this.db.transaction((tweetIds: string[]) => {
      for (const id of tweetIds) {
        insert.run(normalizedUsername, id, now);
      }
      prune.run(normalizedUsername, normalizedUsername);
    });

    tx(ids);
  }

  deleteSeenTweets(username: string): void {
    this.db.prepare('DELETE FROM seen_tweets WHERE username = ?').run(username.toLowerCase());
  }

  getRuntimeState(): RuntimeState {
    const row = this.db.prepare('SELECT * FROM runtime_state WHERE id = 1').get();
    return normalizeRuntimeState(row);
  }

  updateRuntimeState(patch: Partial<RuntimeState>): RuntimeState {
    const current = this.getRuntimeState();
    const next: RuntimeState = {
      ...current,
      ...patch,
      activeSpaces: patch.activeSpaces ?? current.activeSpaces,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `
          UPDATE runtime_state
          SET
            status = @status,
            mode = @mode,
            started_at = @startedAt,
            last_poll_at = @lastPollAt,
            poll_count = @pollCount,
            last_error = @lastError,
            active_spaces_json = @activeSpacesJson,
            updated_at = @updatedAt
          WHERE id = 1
        `
      )
      .run({
        status: next.status,
        mode: next.mode,
        startedAt: next.startedAt,
        lastPollAt: next.lastPollAt,
        pollCount: next.pollCount,
        lastError: next.lastError,
        activeSpacesJson: JSON.stringify(next.activeSpaces),
        updatedAt: next.updatedAt,
      });

    return next;
  }

  setActiveSpaces(activeSpaces: ActiveSpace[]): RuntimeState {
    return this.updateRuntimeState({ activeSpaces });
  }

  addRecording(record: RecordingRecord): void {
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO recordings (
            space_id,
            title,
            user,
            duration,
            file_path,
            metadata_path,
            recorded_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.spaceId,
        record.title,
        record.user,
        record.duration,
        record.filePath,
        record.metadataPath,
        record.recordedAt
      );
  }

  getRecordings(limit = 20): RecordingRecord[] {
    return this.db
      .prepare(
        `
          SELECT
            id,
            space_id AS spaceId,
            title,
            user,
            duration,
            file_path AS filePath,
            metadata_path AS metadataPath,
            recorded_at AS recordedAt
          FROM recordings
          ORDER BY recorded_at DESC
          LIMIT ?
        `
      )
      .all(limit) as RecordingRecord[];
  }

  getRecordingCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM recordings').get() as { count: number }).count;
  }

  deleteOldRecordings(days: number): RecordingRecord[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const old = this.db.prepare('SELECT * FROM recordings WHERE recorded_at < ?').all(cutoff) as any[];
    this.db.prepare('DELETE FROM recordings WHERE recorded_at < ?').run(cutoff);
    return old.map((row) => ({
      id: row.id,
      spaceId: row.space_id,
      title: row.title,
      user: row.user,
      duration: row.duration,
      filePath: row.file_path,
      metadataPath: row.metadata_path,
      recordedAt: row.recorded_at,
    }));
  }

  getSeenTweetCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM seen_tweets').get() as { count: number }).count;
  }

  async backup(destinationPath: string): Promise<void> {
    await this.db.backup(destinationPath);
  }

  checkIntegrity(): boolean {
    const result = this.db.pragma('integrity_check', { simple: true });
    return result === 'ok';
  }
}
