import fs from 'node:fs';
import path from 'node:path';
import { getDirSize } from '../utils/files';
import { normalizeUsername } from './watchlist-service';

export type DeleteTarget = 'tweets' | 'spaces' | 'all';

export interface DeleteResult {
  deletedCount: number;
  freedBytes: number;
}

export function deleteUserDownloads(downloadRoot: string, username: string, target: DeleteTarget): DeleteResult {
  const normalized = normalizeUsername(username);
  const userDir = path.join(downloadRoot, normalized);

  if (!fs.existsSync(userDir)) {
    return { deletedCount: 0, freedBytes: 0 };
  }

  if (target === 'tweets') {
    const tweetsDir = path.join(userDir, 'tweets');
    const stats = getDirSize(tweetsDir);
    fs.rmSync(tweetsDir, { recursive: true, force: true });
    return { deletedCount: stats.files, freedBytes: stats.bytes };
  }

  if (target === 'spaces') {
    let deletedCount = 0;
    let freedBytes = 0;
    for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
      // Skip the tweets subdirectory — that belongs to the tweets target
      if (entry.isDirectory() && entry.name === 'tweets') {
        continue;
      }
      const fullPath = path.join(userDir, entry.name);
      if (entry.isDirectory()) {
        const stats = getDirSize(fullPath);
        deletedCount += stats.files;
        freedBytes += stats.bytes;
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        freedBytes += fs.statSync(fullPath).size;
        fs.rmSync(fullPath, { force: true });
        deletedCount += 1;
      }
    }
    return { deletedCount, freedBytes };
  }

  const stats = getDirSize(userDir);
  fs.rmSync(userDir, { recursive: true, force: true });
  return { deletedCount: stats.files, freedBytes: stats.bytes };
}
