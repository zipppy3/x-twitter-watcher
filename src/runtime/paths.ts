import path from 'node:path';
import fs from 'node:fs';

export const packageRoot = path.resolve(__dirname, '..', '..');
/** Parent folder: where v1 kept its files when this code lived in a `v2/` subfolder. */
export const projectRoot = path.resolve(packageRoot, '..');
export const dataDir = path.join(packageRoot, 'data');

export function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function resolveEnvPath(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const localEnv = path.join(packageRoot, '.env');
  // Legacy layout only: fall back to the parent folder's .env if one is really there.
  const legacyEnv = path.join(projectRoot, '.env');
  if (!fs.existsSync(localEnv) && fs.existsSync(legacyEnv)) {
    return legacyEnv;
  }
  return localEnv;
}

export function resolveDownloadRoot(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const envPath = process.env.DOWNLOAD_ROOT;
  if (envPath) {
    return path.resolve(envPath);
  }

  // Downloads live inside the project. The parent folder is used only when an
  // old install already keeps its downloads there; a fresh clone must never
  // start writing outside its own directory.
  const localDownload = path.join(packageRoot, 'download');
  const legacyDownload = path.join(projectRoot, 'download');
  if (!fs.existsSync(localDownload) && fs.existsSync(legacyDownload)) {
    return legacyDownload;
  }

  return localDownload;
}
