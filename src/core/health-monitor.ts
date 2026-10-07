import { HealthReporter, HealthSource } from '../types';
import { rootLogger } from '../runtime/logger';
import { escapeHtml } from '../utils/html';

const CHECK_INTERVAL_MS = 60 * 1000;

/** One failure is noise; an outage is several in a row over a stretch of time. */
const MIN_CONSECUTIVE_FAILURES = 3;

const SOURCE_LABELS: Record<HealthSource, string> = {
  'x-api': 'X API',
  nitter: 'Nitter',
  spaces: 'Spaces polling',
  screenshot: 'Screenshots',
  telegram: 'Telegram',
};

/**
 * Sources whose outage is worth a Telegram alert. Telegram itself is left out:
 * when it is the thing that is failing, an alert could not be delivered anyway.
 */
const ALERTABLE: HealthSource[] = ['x-api', 'nitter', 'spaces', 'screenshot'];

interface SourceState {
  /** Counters since the last daily report. */
  ok: number;
  failed: number;
  lastOkAt: number | null;
  lastError: string | null;
  /** Time of the first failure after the last success. */
  failingSince: number | null;
  consecutiveFailures: number;
  alerted: boolean;
}

export interface HealthMonitorOptions {
  /** How long a source may keep failing before an alert is sent. */
  alertAfterMs: number;
  /** How long the tweet loop may go without finishing a cycle. */
  stallAfterMs: number;
  /** Local hour (0-23) of the daily "still alive" report, or null to disable it. */
  dailyReportHour: number | null;
  notify: (html: string) => Promise<unknown>;
  describeWatchlist?: () => string;
  /** Called with the current problem summary, or null once everything is healthy again. */
  onProblemChange?: (problem: string | null) => void;
  now?: () => Date;
}

function minutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60000));
  if (total < 60) {
    return `${total} min`;
  }
  const hours = Math.floor(total / 60);
  return hours < 48 ? `${hours}h ${total % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Turns "is it actually working?" into something visible.
 *
 * The fetchers report every success and failure here. A source that keeps
 * failing with no success in between raises one Telegram alert (and one more
 * when it recovers), a tweet loop that stops completing cycles is reported as
 * stuck, and once a day a short "still alive" summary is sent.
 */
export class HealthMonitor implements HealthReporter {
  private readonly logger = rootLogger.child('health');

  private readonly sources = new Map<HealthSource, SourceState>();

  private readonly delivered = { tweets: 0, spaces: 0, deleted: 0 };

  private timer: NodeJS.Timeout | null = null;

  private startedAt = 0;

  private lastBeatAt = 0;

  private stallAlerted = false;

  private lastReportDay: string | null = null;

  constructor(private readonly options: HealthMonitorOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const now = this.now();
    this.startedAt = now.getTime();
    this.lastBeatAt = now.getTime();
    // Started after today's report time: the next one is tomorrow's.
    if (this.options.dailyReportHour !== null && now.getHours() >= this.options.dailyReportHour) {
      this.lastReportDay = dayKey(now);
    }
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  ok(source: HealthSource): void {
    const state = this.state(source);
    const now = this.now().getTime();
    state.ok += 1;
    state.lastOkAt = now;
    state.consecutiveFailures = 0;

    if (state.alerted && state.failingSince) {
      this.send(`<b>✅ Recovered: ${SOURCE_LABELS[source]}</b>\nWorking again after ${minutes(now - state.failingSince)}.`);
    }
    const wasAlerted = state.alerted;
    state.alerted = false;
    state.failingSince = null;
    if (wasAlerted) {
      this.publishProblems();
    }
  }

  fail(source: HealthSource, message: string): void {
    const state = this.state(source);
    state.failed += 1;
    state.consecutiveFailures += 1;
    state.lastError = message;
    state.failingSince ??= this.now().getTime();
  }

  beat(): void {
    const now = this.now().getTime();
    if (this.stallAlerted) {
      this.stallAlerted = false;
      this.send(`<b>✅ Recovered: tweet polling</b>\nA polling cycle completed again after ${minutes(now - this.lastBeatAt)}.`);
      this.publishProblems();
    }
    this.lastBeatAt = now;
  }

  count(what: 'tweets' | 'spaces' | 'deleted'): void {
    this.delivered[what] += 1;
  }

  /** Evaluate outages, a stuck loop and the daily report. Runs once a minute. */
  check(): void {
    const date = this.now();
    const now = date.getTime();
    let changed = false;

    for (const source of ALERTABLE) {
      const state = this.sources.get(source);
      if (
        !state ||
        state.alerted ||
        !state.failingSince ||
        state.consecutiveFailures < MIN_CONSECUTIVE_FAILURES ||
        now - state.failingSince < this.options.alertAfterMs
      ) {
        continue;
      }

      state.alerted = true;
      changed = true;
      const lastOk = state.lastOkAt ? `${minutes(now - state.lastOkAt)} ago` : 'never since the watcher started';
      this.logger.error('Source is failing', { source, failures: state.consecutiveFailures, lastError: state.lastError });
      this.send(
        `<b>⚠ Watcher problem: ${SOURCE_LABELS[source]}</b>\n\n` +
          `Failing for ${minutes(now - state.failingSince)} (${state.consecutiveFailures} failures in a row).\n` +
          `Last success: ${lastOk}\n` +
          `Last error: <code>${escapeHtml(state.lastError ?? 'unknown')}</code>`
      );
    }

    if (!this.stallAlerted && now - this.lastBeatAt >= this.options.stallAfterMs) {
      this.stallAlerted = true;
      changed = true;
      this.logger.error('Tweet polling loop looks stuck', { minutesSinceLastCycle: Math.round((now - this.lastBeatAt) / 60000) });
      this.send(
        `<b>⚠ Watcher problem: tweet polling</b>\n\n` +
          `No polling cycle has completed for ${minutes(now - this.lastBeatAt)}; the loop may be stuck.\n` +
          `Restarting the watcher usually clears it.`
      );
    }

    if (changed) {
      this.publishProblems();
    }

    const hour = this.options.dailyReportHour;
    if (hour !== null && date.getHours() >= hour && this.lastReportDay !== dayKey(date)) {
      this.lastReportDay = dayKey(date);
      this.send(this.buildReport(now));
      for (const state of this.sources.values()) {
        state.ok = 0;
        state.failed = 0;
      }
      this.delivered.tweets = 0;
      this.delivered.spaces = 0;
      this.delivered.deleted = 0;
    }
  }

  /** Current problems, for `status` and the daily report. */
  problems(): string[] {
    const list = ALERTABLE.filter((source) => this.sources.get(source)?.alerted).map((source) => SOURCE_LABELS[source]);
    if (this.stallAlerted) {
      list.push('tweet polling stuck');
    }
    return list;
  }

  private buildReport(now: number): string {
    const lines = [`<b>💚 X Watcher is alive</b>`, '', `Uptime: ${minutes(now - this.startedAt)}`];
    const watchlist = this.options.describeWatchlist?.();
    if (watchlist) {
      lines.push(`Watching: ${escapeHtml(watchlist)}`);
    }
    const deleted = this.delivered.deleted ? `, ${this.delivered.deleted} deleted tweets found` : '';
    lines.push(`Since last report: ${this.delivered.tweets} tweets posted, ${this.delivered.spaces} Spaces recorded${deleted}`);

    for (const [source, state] of this.sources) {
      if (!state.ok && !state.failed) {
        continue;
      }
      const lastOk = state.lastOkAt ? ` · last ok ${minutes(now - state.lastOkAt)} ago` : '';
      lines.push(`${SOURCE_LABELS[source]}: ${state.ok} ok, ${state.failed} failed${lastOk}`);
    }

    const problems = this.problems();
    if (problems.length) {
      lines.push('', `⚠ Open problems: ${problems.join(', ')}`);
    }
    return lines.join('\n');
  }

  private publishProblems(): void {
    const problems = this.problems();
    try {
      this.options.onProblemChange?.(problems.length ? `Failing: ${problems.join(', ')}` : null);
    } catch {
      // Reporting must never disturb the thing being reported on.
    }
  }

  private send(html: string): void {
    this.options.notify(html).catch((error) => {
      this.logger.warn('Could not deliver health message', { message: (error as Error).message });
    });
  }

  private state(source: HealthSource): SourceState {
    let state = this.sources.get(source);
    if (!state) {
      state = { ok: 0, failed: 0, lastOkAt: null, lastError: null, failingSince: null, consecutiveFailures: 0, alerted: false };
      this.sources.set(source, state);
    }
    return state;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
