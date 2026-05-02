import { EventEmitter } from 'node:events';
import { Storage, WatchMode, WatchTarget, WatchTargetInput } from '../types';

export interface WatchlistChangedEvent {
  action: 'add' | 'update' | 'remove';
  username: string;
}

export class WatchlistService extends EventEmitter {
  constructor(private readonly storage: Storage) {
    super();
  }

  list(): WatchTarget[] {
    return this.storage.getWatchTargets();
  }

  get(username: string): WatchTarget | null {
    return this.storage.getWatchTarget(normalizeUsername(username));
  }

  add(username: string, mode: WatchMode = 'all', watchReplies = false): WatchTarget {
    const normalized = normalizeUsername(username);
    const flags = modeToFlags(mode);
    const target = this.storage.upsertWatchTarget({
      username: normalized,
      ...flags,
      watchReplies,
    });
    this.emit('changed', { action: 'add', username: normalized } satisfies WatchlistChangedEvent);
    return target;
  }

  update(username: string, updates: Partial<WatchTargetInput>): WatchTarget {
    const normalized = normalizeUsername(username);
    const target = this.storage.upsertWatchTarget({
      username: normalized,
      ...updates,
    });
    this.emit('changed', { action: 'update', username: normalized } satisfies WatchlistChangedEvent);
    return target;
  }

  remove(username: string): boolean {
    const normalized = normalizeUsername(username);
    const removed = this.storage.removeWatchTarget(normalized);
    if (removed) {
      this.storage.deleteSeenTweets(normalized);
      this.emit('changed', { action: 'remove', username: normalized } satisfies WatchlistChangedEvent);
    }
    return removed;
  }

  count(): number {
    return this.list().length;
  }
}

export function normalizeUsername(username: string): string {
  const normalized = username.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(normalized)) {
    throw new Error(`Invalid username format: "${username}". Usernames can only contain letters, numbers, and underscores (max 15 characters).`);
  }
  return normalized;
}

export function modeToFlags(mode: WatchMode): Pick<WatchTargetInput, 'watchSpaces' | 'watchTweets'> {
  switch (mode) {
    case 'spaces':
      return { watchSpaces: true, watchTweets: false };
    case 'tweets':
      return { watchSpaces: false, watchTweets: true };
    default:
      return { watchSpaces: true, watchTweets: true };
  }
}
