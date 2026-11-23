import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  dropMissingChunks,
  GAPS_ALLOWED_FROM_ATTEMPT,
  RecordingWatcher,
  remoteChunkName,
  retryDelayMs,
  SpaceJobStore,
  STREAM_RECHECK_EVERY,
  writePlaylistFromChunks,
} from '../src/adapters/space-recording';
import { TwspaceSpacesProvider } from '../src/adapters/spaces-provider';
import { rootLogger } from '../src/runtime/logger';
import { buildSpaceRecordedMessage, buildSpaceRecordingFailedMessage } from '../src/services/telegram-messages';
import { createTestConfig, makeTempDir } from './helpers';

const { SpaceDownloader } = require('twspace-crawler/dist/modules/space-downloader');
const { api } = require('twspace-crawler/dist/api/twitter.api');

const SPACE_ID = '1abcDEFghiJKL';
const UUID = '9ea17969-36e2-4369-9511-2ae97f1ec140';

function chunk(index: number): string {
  return `chunk_17930712734259548${index}_${index}_a.aac`;
}

/** The name twspace-crawler (1.20.1+) saves a replay chunk under. */
function local(index: number): string {
  return `chunk_${index}.aac`;
}

function playlistText(names: string[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4'];
  for (const name of names) {
    lines.push('#EXTINF:3.111,', name);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function writePlaylist(dir: string, count: number): void {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4'];
  for (let i = 0; i < count; i += 1) {
    lines.push('#EXTINF:3.111,', chunk(i));
  }
  lines.push('#EXT-X-ENDLIST');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playlist.m3u8'), lines.join('\n'));
}

function httpError(status: number): Error {
  const error: any = new Error(`Request failed with status code ${status}`);
  error.response = { status };
  return error;
}

/**
 * A watcher whose downloader works on local files only: `download()` runs the
 * chunk step and ffmpeg step against the leftover folder, ffmpeg is faked.
 */
function makeWatcher(options: { chunkError: (name: string) => Error | null; ffmpegCode?: number }) {
  const tmpRoot = makeTempDir('space-rec-');
  const jobs = new SpaceJobStore(tmpRoot);
  const leftover = path.join(tmpRoot, `${SPACE_ID}_${UUID}`);
  writePlaylist(leftover, 3);
  fs.writeFileSync(path.join(leftover, local(0)), 'audio0');
  fs.writeFileSync(path.join(leftover, local(2)), 'audio2');

  const fetched: string[] = [];
  vi.spyOn(SpaceDownloader.prototype, 'downloadChunk').mockImplementation(async function (this: any, _base: unknown, name: unknown) {
    fetched.push(String(name));
    const error = options.chunkError(String(name));
    if (error) throw error;
    fs.writeFileSync(path.join(this.tmpDir, String(name)), 'fetched');
  });
  vi.spyOn(SpaceDownloader.prototype, 'spawnFfmpeg').mockImplementation(async function (this: any) {
    const code = options.ffmpegCode ?? 0;
    if (code === 0) fs.writeFileSync(this.resultFile, 'm4a');
    return code;
  });
  // Runs upstream's real downloadChunks (local names, candidate URLs) over a 3-chunk replay.
  vi.spyOn(SpaceDownloader.prototype, 'download').mockImplementation(async function (this: any) {
    const uris = [0, 1, 2].map(chunk);
    await this.downloadChunks('https://example.invalid/audio-space/playlist_1.m3u8', playlistText(uris), uris);
    await this.spawnFfmpeg(this.tmpPlaylistFile);
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  });

  const watcher: any = new RecordingWatcher(SPACE_ID, jobs, rootLogger.child('test'), 1);
  watcher.space = { title: 'Test', creator: { username: 'alice' }, startedAt: Date.now() };
  watcher.dynamicPlaylistUrl = 'https://example.invalid/audio-space/dynamic_playlist.m3u8';
  const downloader = watcher.ensureDownloader();
  downloader.playlistUrl = 'https://example.invalid/audio-space/playlist_1.m3u8';
  downloader.resultFile = path.join(tmpRoot, 'out', 'result.m4a');
  fs.mkdirSync(path.dirname(downloader.resultFile), { recursive: true });

  return { watcher, downloader, jobs, leftover, fetched, tmpRoot };
}

function settled(watcher: any): Promise<{ event: string; payload?: any }> {
  return new Promise((resolve) => {
    watcher.once('complete', () => resolve({ event: 'complete' }));
    watcher.once('failed', (payload: any) => resolve({ event: 'failed', payload }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Space recording download', () => {
  test('reuses the chunks an earlier run left and only fetches the missing one', async () => {
    const { watcher, downloader, leftover, fetched } = makeWatcher({ chunkError: () => null });
    expect(path.resolve(downloader.tmpDir)).toBe(leftover);

    const done = settled(watcher);
    await watcher.downloadAudio();

    expect(await done).toEqual({ event: 'complete' });
    expect(fetched).toEqual([local(1)]);
    expect(fs.existsSync(downloader.resultFile)).toBe(true);
    expect(watcher.outcome.gaps).toBeNull();
  });

  test('a chunk X keeps answering 404 is left out after a few attempts', async () => {
    const { watcher, downloader } = makeWatcher({ chunkError: (name) => (name === local(1) ? httpError(404) : null) });
    let playlistSeenByFfmpeg = '';
    const fake = SpaceDownloader.prototype.spawnFfmpeg as any;
    fake.mockImplementation(async function (this: any) {
      playlistSeenByFfmpeg = fs.readFileSync(path.join(this.tmpDir, 'playlist.m3u8'), 'utf8');
      fs.writeFileSync(this.resultFile, 'm4a');
      return 0;
    });

    const done = settled(watcher);
    await watcher.downloadAudio();

    expect(await done).toEqual({ event: 'complete' });
    expect(watcher.downloadAttempts).toBe(GAPS_ALLOWED_FROM_ATTEMPT - 1);
    expect(watcher.outcome.gaps).toMatchObject({ total: 3, missing: 1 });
    expect(watcher.outcome.gaps.missingSeconds).toBeCloseTo(3.111);
    expect(playlistSeenByFfmpeg).not.toContain(local(1));
    expect(playlistSeenByFfmpeg).toContain(local(2));
    expect(fs.existsSync(downloader.resultFile)).toBe(true);
  });

  test('a chunk saved while the Space was live fills a hole in the replay', async () => {
    const { watcher, leftover } = makeWatcher({ chunkError: () => httpError(404) });
    fs.mkdirSync(watcher.liveDir, { recursive: true });
    // Live copies keep X's chunk name; the replay saves it as chunk_1.aac.
    fs.writeFileSync(path.join(watcher.liveDir, chunk(1)), 'live1');
    let copied = '';
    (SpaceDownloader.prototype.spawnFfmpeg as any).mockImplementation(async function (this: any) {
      copied = fs.readFileSync(path.join(leftover, local(1)), 'utf8');
      fs.writeFileSync(this.resultFile, 'm4a');
      return 0;
    });

    const done = settled(watcher);
    await watcher.downloadAudio();

    expect(await done).toEqual({ event: 'complete' });
    expect(copied).toBe('live1');
    expect(watcher.outcome.gaps).toBeNull();
    expect(fs.existsSync(watcher.liveDir)).toBe(false);
  });

  test('a replay that cannot be fetched again is built from a nearly complete leftover', async () => {
    const { watcher, downloader } = makeWatcher({ chunkError: () => null });
    // 19 of 20 chunks on disk, and X no longer serves the replay playlist.
    writePlaylist(path.resolve(downloader.tmpDir), 20);
    for (let i = 0; i < 20; i += 1) {
      if (i !== 1) fs.writeFileSync(path.join(downloader.tmpDir, chunk(i)), `audio${i}`);
    }
    (SpaceDownloader.prototype.download as any).mockImplementation(async () => {
      throw httpError(404);
    });

    const done = settled(watcher);
    await watcher.downloadAudio();

    expect(await done).toEqual({ event: 'complete' });
    expect(watcher.downloadAttempts).toBe(GAPS_ALLOWED_FROM_ATTEMPT);
    expect(watcher.outcome.fallbackReason).toContain('could not be downloaded again');
    expect(watcher.outcome.gaps).toMatchObject({ total: 20, missing: 1 });
    expect(fs.existsSync(downloader.resultFile)).toBe(true);
  });

  test('a failed ffmpeg run keeps the chunks and counts as a failed attempt', async () => {
    const { watcher, leftover } = makeWatcher({ chunkError: () => null, ffmpegCode: 1 });
    const complete = vi.fn();
    watcher.on('complete', complete);
    await watcher.downloadAudio();
    // Stop the scheduled retry from doing anything.
    watcher.finished = true;

    expect(complete).not.toHaveBeenCalled();
    expect(watcher.downloadAttempts).toBe(1);
    expect(fs.existsSync(path.join(leftover, local(0)))).toBe(true);
  });

  test('with nothing saved, giving up reports a failure instead of staying silent', async () => {
    const tmpRoot = makeTempDir('space-rec-empty-');
    const watcher: any = new RecordingWatcher(SPACE_ID, new SpaceJobStore(tmpRoot), rootLogger.child('test'), 1);
    watcher.space = { title: 'Test', creator: { username: 'alice' } };
    const downloader = watcher.ensureDownloader();
    downloader.tmpDir = path.relative(process.cwd(), path.join(tmpRoot, `${SPACE_ID}_${UUID}`));

    const done = settled(watcher);
    await watcher.buildFromSavedChunks('X keeps no replay of this Space');

    const result = await done;
    expect(result.event).toBe('failed');
    expect(result.payload.reason).toContain('no audio was saved');
  });

  test('without a replay the file is built from the live chunks', async () => {
    const tmpRoot = makeTempDir('space-rec-live-');
    vi.spyOn(SpaceDownloader.prototype, 'spawnFfmpeg').mockImplementation(async function (this: any) {
      fs.writeFileSync(this.resultFile, 'm4a');
      return 0;
    });
    const watcher: any = new RecordingWatcher(SPACE_ID, new SpaceJobStore(tmpRoot), rootLogger.child('test'), 1);
    watcher.space = { title: 'Test', creator: { username: 'alice' } };
    fs.mkdirSync(watcher.liveDir, { recursive: true });
    for (const index of [2, 0, 1]) {
      fs.writeFileSync(path.join(watcher.liveDir, chunk(index)), `live${index}`);
    }
    const downloader = watcher.ensureDownloader();
    downloader.tmpDir = path.relative(process.cwd(), path.join(tmpRoot, `${SPACE_ID}_${UUID}`));
    downloader.resultFile = path.join(tmpRoot, 'out', 'result.m4a');

    const done = settled(watcher);
    await watcher.buildFromSavedChunks('X keeps no replay of this Space');

    expect(await done).toEqual({ event: 'complete' });
    expect(watcher.outcome.fallbackReason).toBe('X keeps no replay of this Space');
    expect(fs.existsSync(downloader.resultFile)).toBe(true);
  });

  test('when twspace-crawler gives up on the replay playlist, the replay download is still tried', async () => {
    const { watcher, downloader } = makeWatcher({ chunkError: () => null });
    watcher.space.state = 'ended';
    watcher.space.isAvailableForReplay = true;

    const done = settled(watcher);
    // What upstream emits after APP_PLAYLIST_MASTER_RETRY_MAX failed playlist checks.
    watcher.emit('failed');

    expect(await done).toEqual({ event: 'complete' });
    expect(fs.existsSync(downloader.resultFile)).toBe(true);
  });

  test('a Space X flags as having no replay is built from the live chunks after a few attempts', async () => {
    const { watcher, downloader } = makeWatcher({ chunkError: () => null });
    watcher.space.state = 'ended';
    watcher.space.isAvailableForReplay = false;
    fs.mkdirSync(watcher.liveDir, { recursive: true });
    fs.writeFileSync(path.join(watcher.liveDir, chunk(1)), 'live1');
    (SpaceDownloader.prototype.download as any).mockImplementation(async () => {
      throw httpError(404);
    });

    const done = settled(watcher);
    watcher.emit('failed');

    expect(await done).toEqual({ event: 'complete' });
    expect(watcher.downloadAttempts).toBe(GAPS_ALLOWED_FROM_ATTEMPT);
    expect(watcher.outcome.fallbackReason).toContain('no replay');
    expect(fs.existsSync(downloader.resultFile)).toBe(true);
  });

  test('a resumed Space uses the playlist url saved while it was live', async () => {
    const tmpRoot = makeTempDir('space-rec-resume-');
    const jobs = new SpaceJobStore(tmpRoot);
    const url = 'https://example.invalid/x-media-live-stream-pdxa/audio-space/dynamic_playlist.m3u8?type=live';
    jobs.update({ spaceId: SPACE_ID, user: 'alice', title: 'Test', playlistUrl: url });
    // A restart saves the job again without knowing the user or the url.
    jobs.update({ spaceId: SPACE_ID, user: null, title: null });
    expect(jobs.get(SPACE_ID)).toMatchObject({ user: 'alice', title: 'Test', playlistUrl: url });

    const watcher: any = new RecordingWatcher(SPACE_ID, jobs, rootLogger.child('test'), 1);
    watcher.audioSpace = { metadata: { media_key: 'k' } };
    watcher.space = { title: 'Test', creator: { username: 'alice' }, state: 'ended' };
    const SpaceWatcherBase = Object.getPrototypeOf(RecordingWatcher.prototype);
    vi.spyOn(SpaceWatcherBase, 'getLiveStreamStatus').mockRejectedValue(httpError(404));

    await watcher.getLiveStreamStatus();
    expect(watcher.loadPlaylist()).toBe(true);
    expect(watcher.dynamicPlaylistUrl).toBe(url);

    jobs.markFailed(SPACE_ID);
    expect(jobs.get(SPACE_ID)).toMatchObject({ playlistUrl: url, failedAt: expect.any(String) });
  });
});

describe('Space stream refused by X', () => {
  function refusedWatcher(tmpRoot: string): any {
    const watcher: any = new RecordingWatcher(SPACE_ID, new SpaceJobStore(tmpRoot), rootLogger.child('test'), 1);
    watcher.audioSpace = { metadata: { media_key: 'k' } };
    watcher.space = { title: 'obese', creator: { username: 'alice' }, state: 'live' };
    const SpaceWatcherBase = Object.getPrototypeOf(RecordingWatcher.prototype);
    vi.spyOn(SpaceWatcherBase, 'getLiveStreamStatus').mockRejectedValue(httpError(404));
    // The logged-out retry is refused too (a protected host).
    vi.spyOn(api.liveVideoStream, 'getGuestHeaders').mockResolvedValue({});
    vi.spyOn(api.liveVideoStream.client, 'get').mockRejectedValue(httpError(404));
    return watcher;
  }

  async function refuse(watcher: any, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await expect(watcher.getLiveStreamStatus()).rejects.toThrow('404');
    }
  }

  test('a refused stream the logged-out request cannot get either is retried, then failed with a reason once the Space is over', async () => {
    const watcher = refusedWatcher(makeTempDir('space-rec-refused-'));
    const getSpaceData = vi.spyOn(watcher, 'getSpaceData').mockImplementation(async () => undefined);
    vi.spyOn(api.graphql, 'UserByScreenName').mockResolvedValue({
      data: { data: { user: { result: { legacy: { protected: true, following: false } } } } },
    });
    const failed = vi.fn();
    watcher.on('failed', failed);

    // Still live: keeps waiting, re-reading the Space every STREAM_RECHECK_EVERY refusals.
    await refuse(watcher, STREAM_RECHECK_EVERY);
    expect(getSpaceData).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();

    watcher.space.state = 'ended';
    await refuse(watcher, STREAM_RECHECK_EVERY);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].reason).toContain("refused this Space's audio to the watcher's logged-in X account");
    expect(failed.mock.calls[0][0].reason).toContain("@alice's account is protected");
    expect(failed.mock.calls[0][0].keptAt).toBeNull();

    // Upstream schedules another watch() after the error; it must do nothing now.
    const initData = vi.spyOn(watcher, 'initData');
    await watcher.watch();
    expect(initData).not.toHaveBeenCalled();
  });

  test('without a known cause the reason still names the refused stream', async () => {
    const watcher = refusedWatcher(makeTempDir('space-rec-refused2-'));
    watcher.space.state = 'ended';
    vi.spyOn(watcher, 'getSpaceData').mockImplementation(async () => undefined);
    vi.spyOn(api.graphql, 'UserByScreenName').mockRejectedValue(new Error('offline'));
    const done = settled(watcher);

    await refuse(watcher, STREAM_RECHECK_EVERY);

    const result = await done;
    expect(result.event).toBe('failed');
    expect(result.payload.reason).toContain('HTTP 404');
    expect(result.payload.reason).toContain('logged-out request was refused too');
  });

  test('when X refuses the logged-in request, the logged-out one is used', async () => {
    const watcher = refusedWatcher(makeTempDir('space-rec-guest-'));
    const location = 'https://example.invalid/audio-space/dynamic_playlist.m3u8?type=live';
    (api.liveVideoStream.client.get as any).mockResolvedValue({ data: { source: { location } } });
    const failed = vi.fn();
    watcher.on('failed', failed);

    await watcher.getLiveStreamStatus();

    expect(api.liveVideoStream.client.get).toHaveBeenCalledWith('status/k', { headers: {} });
    expect(watcher.liveStreamStatus.source.location).toBe(location);
    expect(watcher.streamRefusals).toBe(0);
    expect(failed).not.toHaveBeenCalled();
  });

  test('resuming an ended Space with no replay names the refused stream as the reason', async () => {
    const watcher = refusedWatcher(makeTempDir('space-rec-refused4-'));
    watcher.space.state = 'ended';
    watcher.space.isAvailableForReplay = false;
    vi.spyOn(api.graphql, 'UserByScreenName').mockResolvedValue({
      data: { data: { user: { result: { legacy: { protected: true, following: false } } } } },
    });
    const done = settled(watcher);

    // What upstream emits for an ended Space flagged "no replay".
    watcher.emit('failed');

    const result = await done;
    expect(result.event).toBe('failed');
    expect(result.payload.reason).toContain("@alice's account is protected");
    expect(result.payload.reason).toContain('no audio was saved');
  });

  test('a cancelled Space is dropped instead of failing', async () => {
    const watcher = refusedWatcher(makeTempDir('space-rec-refused3-'));
    vi.spyOn(watcher, 'getSpaceData').mockImplementation(async () => {
      watcher.space.state = 'canceled';
    });
    const dropped = vi.fn();
    watcher.on('dropped', dropped);

    await refuse(watcher, STREAM_RECHECK_EVERY);

    expect(dropped).toHaveBeenCalledTimes(1);
  });
});

describe('Space recording helpers', () => {
  test('X chunk names are taken from the playlist uri', () => {
    expect(remoteChunkName('chunk_1793_7_b.aac')).toBe('chunk_1793_7_b.aac');
    expect(remoteChunkName('https://example.invalid/a/b/chunk_1793_7_b.aac?type=replay')).toBe('chunk_1793_7_b.aac');
  });

  test('a playlist written from upstream-named chunks keeps their order', () => {
    const dir = makeTempDir('space-rec-local-');
    for (const index of [10, 2, 0]) {
      fs.writeFileSync(path.join(dir, local(index)), 'a');
    }
    writePlaylistFromChunks(dir);
    const entries = fs.readFileSync(path.join(dir, 'playlist.m3u8'), 'utf8').split('\n').filter((line) => line.startsWith('chunk_'));
    expect(entries).toEqual([local(0), local(2), local(10)]);
  });

  test('playlist from chunk files is in chunk order', () => {
    const dir = makeTempDir('space-pl-');
    for (const index of [10, 2, 1]) fs.writeFileSync(path.join(dir, chunk(index)), 'x');
    expect(writePlaylistFromChunks(dir)).toBe(3);
    const entries = fs.readFileSync(path.join(dir, 'playlist.m3u8'), 'utf8').split('\n').filter((line) => line.startsWith('chunk_'));
    expect(entries).toEqual([chunk(1), chunk(2), chunk(10)]);
    expect(dropMissingChunks(dir)).toEqual({ total: 3, missing: 0, missingSeconds: 0 });
  });

  test('retry delays back off and stay bounded', () => {
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(2)).toBe(20_000);
    expect(retryDelayMs(50)).toBe(5 * 60 * 1000);
  });

  test('pending jobs include saved jobs and leftover folders, not stale ones', () => {
    const tmpRoot = makeTempDir('space-jobs-');
    const jobs = new SpaceJobStore(tmpRoot);
    jobs.save({ spaceId: 'jobA', user: 'alice', title: 't', createdAt: new Date().toISOString() });
    jobs.save({ spaceId: 'jobOld', user: 'alice', title: 't', createdAt: new Date(Date.now() - 30 * 86400_000).toISOString() });
    writePlaylist(path.join(tmpRoot, `leftB_${UUID}`), 1);
    fs.mkdirSync(path.join(tmpRoot, 'liveC_live'));
    fs.mkdirSync(path.join(tmpRoot, 'not-a-space-dir'));
    fs.mkdirSync(path.join(tmpRoot, 'gaveUp_live'));
    jobs.markFailed('gaveUp');

    expect(jobs.pending().sort()).toEqual(['jobA', 'leftB', 'liveC']);
    expect(fs.existsSync(path.join(tmpRoot, 'space-jobs', 'jobOld.json'))).toBe(false);
    expect(jobs.leftoverDir('leftB')).toBe(path.join(tmpRoot, `leftB_${UUID}`));
    expect(jobs.leftoverDir('jobA')).toBeNull();
  });

  test('the provider resumes unfinished Spaces at startup', async () => {
    const tmpRoot = makeTempDir('space-resume-');
    new SpaceJobStore(tmpRoot).save({ spaceId: 'resumeMe', user: 'alice', title: 't', createdAt: new Date().toISOString() });
    const provider: any = new TwspaceSpacesProvider(createTestConfig(makeTempDir('space-resume-cfg-')), undefined, undefined, tmpRoot);
    provider.startWatcher = vi.fn();
    provider.pollOnce = vi.fn(async () => undefined);

    await provider.start([]);
    await provider.stop();

    expect(provider.startWatcher).toHaveBeenCalledWith('resumeMe');
  });
});

describe('Spaces poll', () => {
  test('the host comes from the watchlist when X leaves out owner_screen_name', async () => {
    const { TwitterApi } = require('twspace-crawler/dist/apis/twitter-api');
    vi.spyOn(TwitterApi, 'getSpacesByFleetsAvatarContent').mockResolvedValue({
      users: {
        '111': { spaces: { live_content: { audiospace: { broadcast_id: '1abc', title: 'Live', start: 1 } } } },
        '222': { spaces: { live_content: { audiospace: { broadcast_id: '1def', title: 'Other', owner_screen_name: 'Named' } } } },
        '333': { spaces: {} },
      },
    });
    const config = { ...createTestConfig(makeTempDir('space-poll-cfg-')), twitterAuthToken: 'test-token' };
    const provider: any = new TwspaceSpacesProvider(config, undefined, undefined, makeTempDir('space-poll-'));
    provider.watchedUsers.set('alice', '111');
    provider.watchedUsers.set('named', '222');

    const spaces = await provider.getLiveSpaces(['111', '222', '333']);

    expect(spaces.map((space: any) => [space.id, space.creator.username])).toEqual([
      ['1abc', 'alice'],
      ['1def', 'Named'],
    ]);
  });
});

describe('Space messages', () => {
  const base = { spaceId: SPACE_ID, title: 'Talk', user: 'alice' };

  test('a recording with a gap says so', () => {
    const text = buildSpaceRecordedMessage({
      ...base,
      duration: '03:07:12',
      filePath: '/x/a.m4a',
      metadataPath: null,
      recordedAt: new Date().toISOString(),
      missingSeconds: 3,
    });
    expect(text).toContain('About 3 s of audio is missing');
    expect(buildSpaceRecordedMessage({ ...base, duration: '1', filePath: 'a', metadataPath: null, recordedAt: '' })).not.toContain('missing');
  });

  test('a failed recording names the reason and where the audio is', () => {
    const text = buildSpaceRecordingFailedMessage({ ...base, reason: 'no <replay>', keptAt: '/srv/.tmp/x_live' });
    expect(text).toContain('Space recording failed');
    expect(text).toContain('no &lt;replay&gt;');
    expect(text).toContain('/srv/.tmp/x_live');
  });
});
