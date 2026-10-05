import { AppConfig, Storage, TwitterClient } from '../types';

export interface CatchUpResult {
  username: string;
  fetched: number;
  newlyMarked: number;
}

/**
 * Mark everything currently on each watched timeline as seen, so the next poll
 * only reports tweets posted from now on ("start clean" after downtime).
 */
export async function markTimelinesSeen(
  config: AppConfig,
  storage: Storage,
  client: TwitterClient
): Promise<CatchUpResult[]> {
  const results: CatchUpResult[] = [];

  for (const target of storage.getWatchTargets().filter((item) => item.watchTweets)) {
    let userId: string | null = target.username;
    if (config.dataSource !== 'nitter') {
      userId = target.userId ?? (await client.resolveUserId(target.username));
      if (userId && !target.userId) {
        storage.upsertWatchTarget({ username: target.username, userId });
      }
    }

    if (!userId) {
      results.push({ username: target.username, fetched: 0, newlyMarked: 0 });
      continue;
    }

    const tweets = target.watchReplies
      ? await client.getUserTweetsAndReplies(userId)
      : await client.getUserTweets(userId);

    const seen = new Set(storage.getSeenTweetIds(target.username));
    const ids = tweets.map((tweet) => tweet.id);
    storage.markTweetsSeen(target.username, ids);

    results.push({
      username: target.username,
      fetched: ids.length,
      newlyMarked: ids.filter((id) => !seen.has(id)).length,
    });
  }

  return results;
}
