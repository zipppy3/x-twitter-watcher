import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { rootLogger } from '../src/runtime/logger';
import { SqliteStorage } from '../src/storage/sqlite-storage';
import { migrateFromV1 } from '../src/storage/migrate-v1';
import { createTestConfig, makeTempDir } from './helpers';

describe('migrateFromV1', () => {
  test('imports watchlist, seen tweets, and runtime state', () => {
    const sourceRoot = makeTempDir('watcher-v2-source-');
    fs.writeFileSync(
      path.join(sourceRoot, 'watchlist.json'),
      JSON.stringify(
        {
          users: {
            alice: {
              watchSpaces: true,
              watchTweets: true,
              watchReplies: true,
              userId: 'u1',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'seen-tweets.json'),
      JSON.stringify({ alice: ['t1', 't2'] }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(sourceRoot, '.watcher-state.json'),
      JSON.stringify(
        {
          status: 'WATCHING',
          mode: 'minimal',
          pollCount: 5,
          activeSpaces: [{ id: 'space-1', title: 'Alpha', user: 'alice', startedAt: new Date().toISOString() }],
          recordings: [
            {
              title: 'Space Alpha',
              user: 'alice',
              duration: '00:05:00',
              file: '/tmp/alpha.m4a',
              recordedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const baseDir = makeTempDir('watcher-v2-migrate-');
    const config = createTestConfig(baseDir);
    const storage = new SqliteStorage(config.dbPath);
    storage.init();

    const result = migrateFromV1({
      storage,
      sourceRoot,
      logger: rootLogger.child('test-migrate'),
    });

    expect(result.importedUsers).toBe(1);
    expect(result.importedSeenTweets).toBe(2);
    expect(result.importedRecordings).toBe(1);
    expect(storage.getWatchTarget('alice')?.userId).toBe('u1');
    expect(storage.getSeenTweetIds('alice')).toHaveLength(2);
    expect(storage.getRecordingCount()).toBe(1);
    expect(storage.getRuntimeState().pollCount).toBe(5);

    storage.close();
  });
});
