import fs from 'node:fs';
import path from 'node:path';

export function ensureFileDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function getDirSize(dirPath: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;

  function walk(currentPath: string): void {
    if (!fs.existsSync(currentPath)) {
      return;
    }

    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      files += 1;
      try {
        bytes += fs.statSync(fullPath).size;
      } catch {
        // Ignore files that disappear mid-scan.
      }
    }
  }

  walk(dirPath);
  return { files, bytes };
}

export function sanitizeFilename(value: string, fallback = 'untitled'): string {
  const clean = value.replace(/[<>:"/\\|?*]/g, '').trim();
  return clean || fallback;
}
