import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadAppConfig } from '../src/config/app-config';
import { makeTempDir } from './helpers';

describe('loadAppConfig', () => {
  test('loads the shared env contract and resolves paths', () => {
    const tempDir = makeTempDir('watcher-v2-config-');
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(
      envPath,
      ['TWITTER_AUTH_TOKEN=auth', 'TWITTER_CSRF_TOKEN=csrf', 'AUTO_DELETE_UPLOADED=true', 'TELEGRAM_BOT_TOKEN=bot'].join(
        '\n'
      ),
      'utf8'
    );

    const config = loadAppConfig({
      envPath,
      dbPath: path.join(tempDir, 'custom.db'),
      downloadRoot: path.join(tempDir, 'downloads'),
    });

    expect(config.envPath).toBe(envPath);
    expect(config.dbPath).toBe(path.join(tempDir, 'custom.db'));
    expect(config.downloadRoot).toBe(path.join(tempDir, 'downloads'));
    expect(config.twitterAuthToken).toBe('auth');
    expect(config.twitterCsrfToken).toBe('csrf');
    expect(config.telegramBotToken).toBe('bot');
    expect(config.autoDeleteUploaded).toBe(true);
  });
});
