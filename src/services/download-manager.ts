import fs from 'node:fs';
import path from 'node:path';
import { getDirSize } from '../utils/files';
import { normalizeUsername } from './watchlist-service';

export type DeleteTarget = 'tweets' | 'spaces' | 'all';

export interface DeleteResult {
  deletedCount: number;
  freedBytes: number;
}

/**
 * Delete downloaded files for a user.
 *
 * Directory structure (per-user):
 *   {downloadRoot}/{username}/
 *     tweets/
 *       json/          – tweet metadata JSON files
 *       screenshots/   – tweet screenshot images
 *       media/         – downloaded images & videos
 *     spaces/
 *       audio/         – space recordings (.m4a)
 *       metadata/      – speaker lists (.txt)
 */
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

    // Delete the new structured spaces/ directory
    const spacesDir = path.join(userDir, 'spaces');
    if (fs.existsSync(spacesDir)) {
      const stats = getDirSize(spacesDir);
      deletedCount += stats.files;
      freedBytes += stats.bytes;
      fs.rmSync(spacesDir, { recursive: true, force: true });
    }

    // Also clean up any legacy files at the user root (non-tweets directories and loose files)
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (entry.name === 'tweets' || entry.name === 'spaces') {
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
    }

    return { deletedCount, freedBytes };
  }

  const stats = getDirSize(userDir);
  fs.rmSync(userDir, { recursive: true, force: true });
  return { deletedCount: stats.files, freedBytes: stats.bytes };
}
