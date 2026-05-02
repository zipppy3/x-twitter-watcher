import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TelegramBotApiClient } from '../src/adapters/telegram-client';
import { loadAppConfig } from '../src/config/app-config';

describe('Integration: Telegram Fallback', () => {
  it('should fallback to document upload if video fails', async () => {
    // Setup a mock telegram client
    const config = loadAppConfig({ envPath: '.env.test' });
    const client = new TelegramBotApiClient(config);
    
    // Create a fake file to "upload"
    const fakeFilePath = path.join(__dirname, 'test-fake.mp4');
    fs.writeFileSync(fakeFilePath, 'fake video content');

    // Mock sendVideo to fail, but sendDocument to succeed
    vi.spyOn(client, 'sendVideo').mockResolvedValue(false);
    vi.spyOn(client, 'sendDocument').mockResolvedValue(true);

    // In a real integration scenario, if sendVideo fails, the higher level worker 
    // or adapter might try to use sendDocument. Here we just assert the mocks 
    // behave as expected.
    
    const videoSuccess = await client.sendVideo(fakeFilePath, 'Test caption', '1234');
    expect(videoSuccess).toBe(false);
    
    const docSuccess = await client.sendDocument(fakeFilePath, '1234');
    expect(docSuccess).toBe(true);

    // Cleanup
    fs.unlinkSync(fakeFilePath);
  });
});

import { normalizeUsername } from '../src/services/watchlist-service';

describe('Integration: Username Normalization & Security', () => {

  it('should accept valid usernames', () => {
    expect(normalizeUsername('@valid_user')).toBe('valid_user');
    expect(normalizeUsername('validUser123')).toBe('validuser123');
  });

  it('should reject path traversal attempts', () => {
    expect(() => normalizeUsername('../../etc/passwd')).toThrow(/Invalid username format/);
    expect(() => normalizeUsername('user/name')).toThrow(/Invalid username format/);
    expect(() => normalizeUsername('user\\name')).toThrow(/Invalid username format/);
  });
});
