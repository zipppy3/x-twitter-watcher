import { describe, expect, test } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite-storage';
import { createTestConfig, makeTempDir } from './helpers';

describe('SqliteStorage', () => {
  test('prunes seen tweets to the last 500 ids', () => {
    const baseDir = makeTempDir('watcher-v2-storage-');
    const config = createTestConfig(baseDir);
    const storage = new SqliteStorage(config.dbPath);
    storage.init();

    storage.markTweetsSeen(
      'alice',
      Array.from({ length: 501 }, (_, index) => `tweet-${index + 1}`)
    );

    const ids = storage.getSeenTweetIds('alice');
    expect(ids).toHaveLength(500);
    expect(ids.includes('tweet-1')).toBe(false);
    expect(ids.includes('tweet-501')).toBe(true);

    storage.updateRuntimeState({
      status: 'watching',
      pollCount: 12,
      activeSpaces: [{ id: 'space-1', title: 'Alpha', user: 'alice', startedAt: new Date().toISOString() }],
    });
    const runtime = storage.getRuntimeState();
    expect(runtime.pollCount).toBe(12);
    expect(runtime.activeSpaces).toHaveLength(1);

    storage.close();
  });
});
