import { describe, expect, test } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite-storage';
import { WatchlistService } from '../src/services/watchlist-service';
import { createTestConfig, makeTempDir } from './helpers';

describe('WatchlistService', () => {
  test('adds, updates, and removes watch targets', () => {
    const baseDir = makeTempDir('watcher-v2-watchlist-');
    const config = createTestConfig(baseDir);
    const storage = new SqliteStorage(config.dbPath);
    storage.init();

    const service = new WatchlistService(storage);
    const added = service.add('@ExampleUser', 'tweets', true);
    expect(added.username).toBe('exampleuser');
    expect(added.watchSpaces).toBe(false);
    expect(added.watchTweets).toBe(true);
    expect(added.watchReplies).toBe(true);

    const updated = service.update('exampleuser', { watchSpaces: true });
    expect(updated.watchSpaces).toBe(true);

    expect(service.remove('exampleuser')).toBe(true);
    expect(service.get('exampleuser')).toBeNull();

    storage.close();
  });
});
