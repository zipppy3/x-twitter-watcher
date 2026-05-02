import path from 'node:path';
import fs from 'node:fs';

export const packageRoot = path.resolve(__dirname, '..', '..');
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
  if (fs.existsSync(localEnv)) {
    return localEnv;
  }
  return path.join(projectRoot, '.env');
}

export function resolveDownloadRoot(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const envPath = process.env.DOWNLOAD_ROOT;
  if (envPath) {
    return path.resolve(envPath);
  }

  // Prioritize local 'download' folder in v2, fallback to legacy parent location
  const localDownload = path.join(packageRoot, 'download');
  if (fs.existsSync(localDownload)) {
    return localDownload;
  }

  return path.join(projectRoot, 'download');
}
