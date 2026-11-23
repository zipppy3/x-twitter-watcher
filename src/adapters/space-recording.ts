import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import type { Logger } from '../runtime/logger';

// twspace-crawler internals, as in spaces-provider.ts.
const { SpaceWatcher } = require('twspace-crawler/dist/modules/space-watcher');
const { SpaceDownloader } = require('twspace-crawler/dist/modules/space-downloader');
const { SpaceState } = require('twspace-crawler/dist/enums/twitter.enum');
const { api } = require('twspace-crawler/dist/api/twitter.api');

/**
 * Whole-download attempts after which chunks that X answers with 404 are left
 * out instead of failing the recording (seen 2026-10-27: one chunk of 3,705 was
 * never served, and the upstream downloader retried the whole Space for 26 min).
 */
export const GAPS_ALLOWED_FROM_ATTEMPT = 3;
/** After this many failed attempts the recording is built from what was saved. */
export const MAX_DOWNLOAD_ATTEMPTS = 30;
/**
 * Share of the replay's chunks already on disk from which, once gaps are allowed,
 * a failing replay download is not waited for any longer.
 */
const ENOUGH_SAVED_SHARE = 0.95;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
/** Leftovers older than this are not picked up again at startup. */
const RESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * X answers the stream-status request with 404 when this account may not listen
 * (2026-11-23: the host had made their account protected, and the watcher's
 * account does not follow it). Upstream retries that every 10 s forever, so the
 * Space's state is re-read every this many refusals, and the job ends with a
 * reason once the Space is over.
 */
export const STREAM_RECHECK_EVERY = 6;
/** Refusals (about 10 s apart) after which the recording is given up even if X still says live. */
const MAX_STREAM_REFUSALS = 6 * 60 * 24;
/** Rough length of one chunk, for "about N s missing" when a playlist has no durations. */
const CHUNK_SECONDS = 3;

const PLAYLIST_FILE = 'playlist.m3u8';
const LEFTOVER_DIR = /^([A-Za-z0-9]+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIVE_DIR = /^([A-Za-z0-9]+)_live$/;
/** Same ID3 header the upstream downloader trims chunks to. */
const ID3_PRIV = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3f, 0x50, 0x52, 0x49, 0x56]);

export function retryDelayMs(attempt: number, baseMs = 10_000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

function hasContent(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function httpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

function chunkIndex(name: string): number {
  // X's names (chunk_<time>_<index>_b.aac) or upstream's local ones (chunk_<index>.aac, since 1.20.1).
  const match = /chunk_\d+_(\d+)_/.exec(name) ?? /^chunk_(\d+)\.aac$/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

const CHUNK_NAMES_FILE = 'chunk-names.json';

/** File name of a chunk as X serves it (what the live copies are saved as). */
export function remoteChunkName(uri: string): string {
  return path.posix.basename(uri.split(/[?#]/)[0]);
}

/**
 * twspace-crawler 1.20.1 saves replay chunks as chunk_<n>.aac; this remembers
 * which X chunk each one is, so the live copies can fill in for missing ones.
 */
function writeChunkNames(dir: string, names: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CHUNK_NAMES_FILE), JSON.stringify(names), 'utf8');
}

/** Local chunk name -> X chunk name, as saved by the download (empty when unknown). */
export function readChunkNames(dir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CHUNK_NAMES_FILE), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export interface PlaylistGaps {
  total: number;
  missing: number;
  missingSeconds: number;
}

/**
 * Drops the entries whose chunk file is not in `dir` (with their #EXTINF line),
 * so ffmpeg builds the file from what is there instead of stopping at a hole.
 */
export function dropMissingChunks(dir: string, playlistFile = PLAYLIST_FILE): PlaylistGaps {
  const playlistPath = path.join(dir, playlistFile);
  const lines = fs.readFileSync(playlistPath, 'utf8').split(/\r?\n/);
  const kept: string[] = [];
  const gaps: PlaylistGaps = { total: 0, missing: 0, missingSeconds: 0 };
  let pendingInf: string | null = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      pendingInf = line;
      continue;
    }
    if (line && !line.startsWith('#')) {
      gaps.total += 1;
      if (hasContent(path.join(dir, path.basename(line)))) {
        if (pendingInf) kept.push(pendingInf);
        kept.push(line);
      } else {
        gaps.missing += 1;
        const seconds = pendingInf ? Number.parseFloat(pendingInf.slice('#EXTINF:'.length)) : Number.NaN;
        gaps.missingSeconds += Number.isFinite(seconds) ? seconds : CHUNK_SECONDS;
      }
      pendingInf = null;
      continue;
    }
    if (pendingInf) {
      kept.push(pendingInf);
      pendingInf = null;
    }
    kept.push(line);
  }

  if (gaps.missing) {
    fs.writeFileSync(playlistPath, kept.join('\n'), 'utf8');
  }
  return gaps;
}

/** Share of the playlist's chunks that are in `dir` (0 without a playlist). */
export function savedChunkShare(dir: string, playlistFile = PLAYLIST_FILE): number {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(dir, playlistFile), 'utf8').split(/\r?\n/);
  } catch {
    return 0;
  }
  const entries = lines.filter((line) => line && !line.startsWith('#'));
  if (!entries.length) {
    return 0;
  }
  return entries.filter((line) => hasContent(path.join(dir, path.basename(line)))).length / entries.length;
}

/** A plain VOD playlist over the chunk files in `dir`, in chunk order. */
export function writePlaylistFromChunks(dir: string, playlistFile = PLAYLIST_FILE): number {
  const chunks = fs.readdirSync(dir).filter((name) => /^chunk_.*\.aac$/.test(name) && hasContent(path.join(dir, name)));
  chunks.sort((a, b) => chunkIndex(a) - chunkIndex(b));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${CHUNK_SECONDS + 1}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  for (const chunk of chunks) {
    lines.push(`#EXTINF:${CHUNK_SECONDS}.0,`, chunk);
  }
  lines.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(dir, playlistFile), lines.join('\n'), 'utf8');
  return chunks.length;
}

export interface SpaceJob {
  spaceId: string;
  user: string | null;
  title: string | null;
  createdAt: string;
  /** Set once the recording failed for good: the folders it left stay, but are not retried. */
  failedAt?: string;
  /** The live playlist URL, so a resumed job can still find the replay when X no longer hands it out. */
  playlistUrl?: string;
}

/**
 * Remembers Spaces that are being recorded, on disk, so a restart (a deploy, an
 * unattended upgrade restarting the service) picks them up again instead of
 * losing them. Also finds chunk folders a previous run left behind.
 */
export class SpaceJobStore {
  constructor(readonly tmpRoot: string) {}

  private get jobsDir(): string {
    return path.join(this.tmpRoot, 'space-jobs');
  }

  save(job: SpaceJob): void {
    fs.mkdirSync(this.jobsDir, { recursive: true });
    fs.writeFileSync(path.join(this.jobsDir, `${job.spaceId}.json`), JSON.stringify(job), 'utf8');
  }

  get(spaceId: string): SpaceJob | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.jobsDir, `${spaceId}.json`), 'utf8')) as SpaceJob;
    } catch {
      return null;
    }
  }

  /** Saves the job, keeping what an earlier save knew (a resumed job knows less than the first run). */
  update(job: Partial<SpaceJob> & { spaceId: string }): void {
    const previous = this.get(job.spaceId);
    const merged = { ...previous, ...job } as SpaceJob;
    for (const key of ['user', 'title', 'playlistUrl'] as const) {
      if (merged[key] == null && previous?.[key] != null) {
        (merged as any)[key] = previous[key];
      }
    }
    merged.user ??= null;
    merged.title ??= null;
    merged.createdAt ??= new Date().toISOString();
    this.save(merged);
  }

  remove(spaceId: string): void {
    fs.rmSync(path.join(this.jobsDir, `${spaceId}.json`), { force: true });
  }

  /** Keeps the job as "failed" so a restart does not retry and announce it again. */
  markFailed(spaceId: string): void {
    this.update({ spaceId, failedAt: new Date().toISOString() });
  }

  /** Space ids to resume: saved jobs plus recent leftover chunk folders. */
  pending(now = Date.now()): string[] {
    const ids = new Set<string>();
    const failed = new Set<string>();
    for (const name of safeReaddir(this.jobsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.jobsDir, name), 'utf8')) as SpaceJob;
        if (now - Date.parse(job.createdAt) >= RESUME_WINDOW_MS) {
          this.remove(job.spaceId);
        } else if (job.failedAt) {
          failed.add(job.spaceId);
        } else {
          ids.add(job.spaceId);
        }
      } catch {
        fs.rmSync(path.join(this.jobsDir, name), { force: true });
      }
    }
    for (const name of safeReaddir(this.tmpRoot)) {
      const match = LEFTOVER_DIR.exec(name) ?? LIVE_DIR.exec(name);
      if (match && !failed.has(match[1]) && now - modifiedAt(path.join(this.tmpRoot, name)) < RESUME_WINDOW_MS) {
        ids.add(match[1]);
      }
    }
    return [...ids];
  }

  /** The newest download folder an earlier run left for this Space. */
  leftoverDir(spaceId: string): string | null {
    const dirs = safeReaddir(this.tmpRoot)
      .filter((name) => LEFTOVER_DIR.exec(name)?.[1] === spaceId)
      .map((name) => path.join(this.tmpRoot, name))
      .filter((dir) => fs.existsSync(path.join(dir, PLAYLIST_FILE)))
      .sort((a, b) => modifiedAt(b) - modifiedAt(a));
    return dirs[0] ?? null;
  }

  liveDir(spaceId: string): string {
    return path.join(this.tmpRoot, `${spaceId}_live`);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function modifiedAt(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export interface RecordingOutcome {
  /** Audio left out because X no longer served it. */
  gaps: PlaylistGaps | null;
  /** Set when the file was built from saved chunks rather than X's replay. */
  fallbackReason: string | null;
}

/**
 * twspace-crawler's SpaceWatcher with a sturdier download step:
 *
 * - chunks already on disk are not downloaded again (each upstream retry
 *   re-downloaded the whole Space);
 * - while the Space is live its chunks are also saved as they appear, so a chunk
 *   missing from the replay (or a Space with no replay) can still be filled in;
 * - after a few attempts, chunks X answers with 404 are left out;
 * - a failed ffmpeg run is an error (upstream ignored its exit code and then
 *   deleted the chunks);
 * - retries back off and end: after MAX_DOWNLOAD_ATTEMPTS the file is built
 *   from what was saved, or a `failed` event says why there is none.
 *
 * - when upstream gives up (it emits a bare `failed`: no replay flagged, no
 *   playlist, or the replay playlist kept failing) the replay is still tried
 *   and the saved chunks are the last resort (2026-10-30/31: X moved replays to
 *   `periscope-replays-public`, upstream 1.18 retried the old URL for days and
 *   nothing was ever posted; one of those Spaces was flagged "no replay" but had one).
 *
 * Emits `complete` (same as upstream), `failed` with `{ reason, keptAt }`, or
 * `dropped` for a cancelled Space.
 */
export class RecordingWatcher extends SpaceWatcher {
  outcome: RecordingOutcome = { gaps: null, fallbackReason: null };

  private downloadAttempts = 0;

  private downloading = false;

  private finished = false;

  private recovering = false;

  /** X said there is no replay: do not wait long for one before using the saved chunks. */
  private replayDoubtful = false;

  private capturingLive = false;

  private readonly liveSeen = new Set<string>();

  private readonly savedPlaylistUrl: string | null;

  /** Stream-status requests X refused in a row (see STREAM_RECHECK_EVERY). */
  private streamRefusals = 0;

  constructor(
    spaceId: string,
    private readonly jobs: SpaceJobStore,
    private readonly log: Logger,
    private readonly retryBaseMs = 10_000
  ) {
    super(spaceId);
    this.savedPlaylistUrl = jobs.get(spaceId)?.playlistUrl ?? null;
  }

  get liveDir(): string {
    return this.jobs.liveDir(this.spaceId);
  }

  emit(event: string | symbol, ...args: any[]): boolean {
    if (event === 'failed' && !args.length) {
      // Upstream's own "failed" carries no reason; ours always does.
      this.recoverFromUpstreamFailure().catch((error) => {
        this.fail(`recovering the Space failed (${(error as Error).message})`, null);
      });
      return true;
    }
    return super.emit(event, ...args);
  }

  async watch(): Promise<void> {
    // Upstream re-schedules watch() after every error; stop once the job is settled.
    if (this.finished) {
      return;
    }
    return super.watch();
  }

  async initData(): Promise<void> {
    await super.initData();
    if (this.finished || this.downloader || this.recovering) {
      return;
    }
    if (this.space?.state === SpaceState.CANCELED) {
      this.finished = true;
      this.emit('dropped');
    }
  }

  async getLiveStreamStatus(): Promise<void> {
    try {
      await super.getLiveStreamStatus();
      this.streamRefusals = 0;
    } catch (error) {
      if (!this.savedPlaylistUrl) {
        await this.onStreamRefused(error);
        throw error;
      }
      this.log.info('X gave no stream status; using the playlist saved while the Space was live', {
        spaceId: this.spaceId,
        message: (error as Error).message,
      });
    }
  }

  loadPlaylist(): boolean {
    if (!this.dynamicPlaylistUrl && !this.liveStreamStatus?.source?.location && this.savedPlaylistUrl) {
      this.dynamicPlaylistUrl = this.savedPlaylistUrl;
    }
    const loaded = super.loadPlaylist();
    if (loaded && this.dynamicPlaylistUrl && this.dynamicPlaylistUrl !== this.savedPlaylistUrl) {
      try {
        this.jobs.update({ spaceId: this.spaceId, playlistUrl: this.dynamicPlaylistUrl });
      } catch (error) {
        this.log.debug('Could not save the playlist url', { spaceId: this.spaceId, message: (error as Error).message });
      }
    }
    return loaded;
  }

  /**
   * X would not give this account the Space's stream. Nothing can be recorded
   * then, so instead of retrying forever: re-read the Space now and then, and
   * once it is over (or after a day), fail with a reason that says why.
   */
  private async onStreamRefused(error: unknown): Promise<void> {
    const status = httpStatus(error);
    if (this.finished || (status !== 404 && status !== 403)) {
      return;
    }
    this.streamRefusals += 1;
    if (this.streamRefusals === 1) {
      this.log.warn('X refused the Space stream to this account; it cannot be recorded while that lasts', {
        spaceId: this.spaceId,
        status,
      });
    }
    if (this.streamRefusals % STREAM_RECHECK_EVERY !== 0) {
      return;
    }
    await this.getSpaceData();
    const state = this.space?.state;
    if (state === SpaceState.CANCELED) {
      this.finished = true;
      this.emit('dropped');
      return;
    }
    if (state !== SpaceState.ENDED && this.streamRefusals < MAX_STREAM_REFUSALS) {
      return;
    }
    this.fail(await this.describeStreamRefusal(status), null);
  }

  private async describeStreamRefusal(status: number): Promise<string> {
    const refused = `X would not give it this Space's audio (HTTP ${status})`;
    const username = this.space?.creator?.username;
    if (username) {
      try {
        const { data } = await api.graphql.UserByScreenName(username, true);
        const legacy = data?.data?.user?.result?.legacy;
        if (legacy?.protected && !legacy?.following) {
          return `@${username}'s account is protected and the watcher's X account does not follow it, so ${refused}`;
        }
        if (legacy?.blocked_by) {
          return `@${username} has blocked the watcher's X account, so ${refused}`;
        }
      } catch (error) {
        this.log.debug('Could not look up the Space host', { spaceId: this.spaceId, message: (error as Error).message });
      }
    }
    return `X would not give the watcher's X account this Space's audio (HTTP ${status})`;
  }

  /** Upstream stopped without a recording: try the replay anyway, then the saved chunks. */
  private async recoverFromUpstreamFailure(): Promise<void> {
    if (this.finished || this.recovering) {
      return;
    }
    this.recovering = true;
    if (this.space?.state === SpaceState.ENDED && !this.space?.isAvailableForReplay) {
      this.replayDoubtful = true;
    }
    let refusedStatus: number | undefined;
    if (!this.dynamicPlaylistUrl) {
      try {
        await super.getLiveStreamStatus();
      } catch (error) {
        // The saved playlist url (if any) is used below.
        const status = httpStatus(error);
        refusedStatus = status === 404 || status === 403 ? status : undefined;
      }
      this.dynamicPlaylistUrl = this.liveStreamStatus?.source?.location || this.savedPlaylistUrl || undefined;
    }
    if (!this.dynamicPlaylistUrl) {
      const reason = refusedStatus ? await this.describeStreamRefusal(refusedStatus) : 'X gave no playlist for this Space';
      await this.buildFromSavedChunks(reason);
      return;
    }
    this.log.warn('twspace-crawler gave up on this Space; trying the replay download anyway', {
      spaceId: this.spaceId,
      state: this.space?.state,
      replayFlagged: this.space?.isAvailableForReplay,
    });
    await this.downloadAudio();
  }

  async checkDynamicPlaylist(): Promise<void> {
    this.captureLiveChunks().catch((error) => {
      this.log.debug('Saving live Space chunks failed', { spaceId: this.spaceId, message: (error as Error).message });
    });
    return super.checkDynamicPlaylist();
  }

  async downloadAudio(): Promise<void> {
    if (this.finished || this.downloading) {
      return;
    }
    this.downloading = true;
    try {
      const downloader = this.ensureDownloader();
      await downloader.download();
      this.finish();
    } catch (error) {
      this.downloadAttempts += 1;
      const message = (error as Error).message;
      if (this.downloadAttempts >= MAX_DOWNLOAD_ATTEMPTS) {
        this.log.error('Space replay download kept failing; building from saved chunks', {
          spaceId: this.spaceId,
          attempts: this.downloadAttempts,
          message,
        });
        await this.buildFromSavedChunks(`the replay download failed ${this.downloadAttempts} times (${message})`);
        return;
      }
      if (this.replayDoubtful && this.downloadAttempts >= GAPS_ALLOWED_FROM_ATTEMPT) {
        this.log.warn('X keeps no replay of this Space; building from saved chunks', { spaceId: this.spaceId, message });
        await this.buildFromSavedChunks(`X keeps no replay of this Space (${message})`);
        return;
      }
      if (this.downloadAttempts >= GAPS_ALLOWED_FROM_ATTEMPT && savedChunkShare(this.downloader.tmpDir) >= ENOUGH_SAVED_SHARE) {
        // Nearly everything is on disk already (typically left by an earlier run).
        this.log.warn('Space replay download keeps failing; building from the chunks already saved', {
          spaceId: this.spaceId,
          attempts: this.downloadAttempts,
          message,
        });
        await this.buildFromSavedChunks(`the replay could not be downloaded again (${message})`);
        return;
      }
      const ms = retryDelayMs(this.downloadAttempts, this.retryBaseMs);
      this.log.warn('Space audio download failed, retrying', {
        spaceId: this.spaceId,
        attempt: this.downloadAttempts,
        retryInMs: ms,
        message,
      });
      setTimeout(() => this.downloadAudio(), ms);
    } finally {
      this.downloading = false;
    }
  }

  /** Builds the recording from the chunks on disk (replay download folder and live copies). */
  async buildFromSavedChunks(reason: string): Promise<void> {
    if (this.finished) {
      return;
    }
    const downloader = this.ensureDownloader();
    const tmpDir = path.resolve(downloader.tmpDir);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      this.copyLiveChunks(tmpDir);
      if (!fs.existsSync(path.join(tmpDir, PLAYLIST_FILE))) {
        writePlaylistFromChunks(tmpDir);
      }
      const gaps = dropMissingChunks(tmpDir);
      if (gaps.missing) {
        this.outcome.gaps = gaps;
      }
      if (gaps.total - gaps.missing <= 0) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        this.fail(`${reason}, and no audio was saved`, null);
        return;
      }
      fs.mkdirSync(path.dirname(downloader.resultFile), { recursive: true });
      await downloader.spawnFfmpeg(downloader.tmpPlaylistFile);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      this.outcome.fallbackReason = reason;
      this.finish();
    } catch (error) {
      this.fail(`${reason}; building from saved chunks failed too (${(error as Error).message})`, tmpDir);
    }
  }

  private ensureDownloader(): any {
    if (this.downloader) {
      return this.downloader;
    }
    const username = this.space?.creator?.username;
    const metadata = {
      title: this.space?.title,
      author: username,
      artist: username,
      episode_id: this.spaceId,
    };
    const downloader = new SpaceDownloader(this.dynamicPlaylistUrl, this.filename, this.downloadDir ?? username, metadata, this.spaceId);
    const leftover = this.jobs.leftoverDir(this.spaceId);
    if (leftover) {
      // Upstream resolves tmpDir against the working directory.
      downloader.tmpDir = path.relative(process.cwd(), leftover);
      this.log.info('Reusing chunks saved by an earlier run', { spaceId: this.spaceId, dir: leftover });
    }
    this.patchDownloader(downloader);
    this.downloader = downloader;
    return downloader;
  }

  private patchDownloader(downloader: any): void {
    const downloadChunks = downloader.downloadChunks.bind(downloader);
    downloader.downloadChunks = async (playlistUrl: string, data: string, segmentUris: string[], ...rest: unknown[]): Promise<void> => {
      if (Array.isArray(segmentUris)) {
        // Same numbering as upstream's downloadChunks.
        const names: Record<string, string> = {};
        [...new Set(segmentUris)].forEach((uri, i) => {
          names[`chunk_${i}.aac`] = remoteChunkName(uri);
        });
        writeChunkNames(downloader.tmpDir, names);
      }
      return downloadChunks(playlistUrl, data, segmentUris, ...rest);
    };

    // Upstream passes the candidate URLs and uses the returned one to pick the
    // archive path for the next chunks, so a URL must always come back.
    const downloadChunk = downloader.downloadChunk.bind(downloader);
    downloader.downloadChunk = async (urls: string[] | string, chunkName: string, ...rest: unknown[]): Promise<string | undefined> => {
      const first = Array.isArray(urls) ? urls[0] : urls;
      const target = path.join(downloader.tmpDir, chunkName);
      if (hasContent(target)) {
        return first;
      }
      try {
        return (await downloadChunk(urls, chunkName, ...rest)) ?? first;
      } catch (error) {
        const remote = readChunkNames(downloader.tmpDir)[chunkName];
        const live = [remote, chunkName]
          .filter((name): name is string => Boolean(name))
          .map((name) => path.join(this.liveDir, name))
          .find((file) => hasContent(file));
        if (live) {
          fs.copyFileSync(live, target);
          return first;
        }
        if (httpStatus(error) === 404 && this.downloadAttempts + 1 >= GAPS_ALLOWED_FROM_ATTEMPT) {
          // Left out of the playlist before ffmpeg runs.
          return first;
        }
        throw error;
      }
    };

    const spawnFfmpeg = downloader.spawnFfmpeg.bind(downloader);
    downloader.spawnFfmpeg = async (input: string): Promise<number> => {
      if (!downloader.isVideo) {
        const gaps = dropMissingChunks(downloader.tmpDir, downloader.tmpPlaylistFile);
        if (gaps.missing) {
          this.outcome.gaps = gaps;
          this.log.warn('Space recording has gaps: X no longer had some chunks', { spaceId: this.spaceId, ...gaps });
        }
      }
      const code = await spawnFfmpeg(input);
      if (code !== 0 || !hasContent(downloader.resultFile)) {
        throw new Error(`ffmpeg exited with code ${code}`);
      }
      return code;
    };
  }

  /** Saves the chunks the live playlist lists, as a backup for the replay download. */
  private async captureLiveChunks(): Promise<void> {
    if (this.capturingLive || this.finished || !this.dynamicPlaylistUrl) {
      return;
    }
    this.capturingLive = true;
    try {
      const { data } = await axios.get<string>(this.dynamicPlaylistUrl, { responseType: 'text', timeout: 15_000 });
      const entries = String(data).split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('chunk_'));
      fs.mkdirSync(this.liveDir, { recursive: true });
      for (const entry of entries) {
        const url = new URL(entry, this.dynamicPlaylistUrl);
        const name = path.basename(url.pathname);
        const target = path.join(this.liveDir, name);
        if (this.liveSeen.has(name) || hasContent(target)) {
          continue;
        }
        const response = await axios.get<ArrayBuffer>(url.href, { responseType: 'arraybuffer', timeout: 15_000 });
        let buffer = Buffer.from(response.data);
        const start = buffer.indexOf(ID3_PRIV);
        if (start !== -1) {
          buffer = buffer.subarray(start);
        }
        fs.writeFileSync(target, buffer);
        this.liveSeen.add(name);
      }
    } finally {
      this.capturingLive = false;
    }
  }

  private copyLiveChunks(tmpDir: string): void {
    const localByRemote = new Map(Object.entries(readChunkNames(tmpDir)).map(([local, remote]) => [remote, local]));
    for (const name of safeReaddir(this.liveDir)) {
      const target = path.join(tmpDir, localByRemote.get(name) ?? name);
      if (!hasContent(target) && hasContent(path.join(this.liveDir, name))) {
        fs.copyFileSync(path.join(this.liveDir, name), target);
      }
    }
  }

  private finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    fs.rmSync(this.liveDir, { recursive: true, force: true });
    this.emit('complete');
  }

  private fail(reason: string, keptAt: string | null): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    // Live chunks stay when nothing could be built, so the audio is not lost.
    this.emit('failed', { reason, keptAt: keptAt ?? (fs.existsSync(this.liveDir) ? this.liveDir : null) });
  }
}
