import { describe, expect, test } from 'vitest';
import { HealthMonitor } from '../src/core/health-monitor';

const MINUTE = 60 * 1000;

function setup(overrides: { dailyReportHour?: number | null; start?: Date } = {}) {
  let now = overrides.start ?? new Date(2026, 9, 5, 12, 0, 0);
  const messages: string[] = [];
  const problems: Array<string | null> = [];
  const monitor = new HealthMonitor({
    alertAfterMs: 15 * MINUTE,
    stallAfterMs: 30 * MINUTE,
    dailyReportHour: overrides.dailyReportHour ?? null,
    notify: async (html) => {
      messages.push(html);
    },
    describeWatchlist: () => '3 tweet accounts (2 with replies), 0 Spaces',
    onProblemChange: (problem) => problems.push(problem),
    now: () => now,
  });
  monitor.start();
  monitor.stop(); // tests drive check() by hand instead of waiting for the timer
  return {
    monitor,
    messages,
    problems,
    advance(minutes: number) {
      now = new Date(now.getTime() + minutes * MINUTE);
    },
  };
}

describe('HealthMonitor', () => {
  test('a sustained outage raises one alert, and recovery one more', () => {
    const { monitor, messages, problems, advance } = setup();
    monitor.ok('x-api');

    for (let i = 0; i < 12; i += 1) {
      advance(2);
      monitor.fail('x-api', 'Request failed with status code 401');
      monitor.beat();
      monitor.check();
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Watcher problem: X API');
    expect(messages[0]).toContain('status code 401');
    expect(problems.at(-1)).toBe('Failing: X API');

    advance(2);
    monitor.ok('x-api');
    monitor.check();

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('Recovered: X API');
    expect(problems.at(-1)).toBeNull();
  });

  test('a short blip does not alert', () => {
    const { monitor, messages, advance } = setup();
    monitor.fail('x-api', 'timeout');
    monitor.fail('x-api', 'timeout');
    advance(20); // long ago, but only two failures
    monitor.check();
    monitor.fail('x-api', 'timeout');
    monitor.ok('x-api'); // success in between resets the streak
    advance(20);
    monitor.beat();
    monitor.check();

    expect(messages).toHaveLength(0);
  });

  test('Telegram failures are counted but never alerted on', () => {
    const { monitor, messages, advance } = setup();
    for (let i = 0; i < 10; i += 1) {
      advance(3);
      monitor.fail('telegram', 'Telegram request failed');
      monitor.beat();
      monitor.check();
    }
    expect(messages).toHaveLength(0);
  });

  test('a polling loop that stops completing cycles is reported as stuck', () => {
    const { monitor, messages, advance } = setup();
    monitor.beat();
    advance(29);
    monitor.check();
    expect(messages).toHaveLength(0);

    advance(2);
    monitor.check();
    monitor.check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('tweet polling');

    monitor.beat();
    expect(messages[1]).toContain('Recovered: tweet polling');
  });

  test('sends one "still alive" report per day at the configured hour', () => {
    const { monitor, messages, advance } = setup({ dailyReportHour: 9, start: new Date(2026, 9, 5, 7, 0, 0) });
    monitor.ok('x-api');
    monitor.count('tweets');

    advance(60); // 08:00
    monitor.beat();
    monitor.check();
    expect(messages).toHaveLength(0);

    advance(61); // 09:01
    monitor.beat();
    monitor.check();
    monitor.check();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('X Watcher is alive');
    expect(messages[0]).toContain('1 tweets posted');
    expect(messages[0]).toContain('X API: 1 ok, 0 failed');

    advance(24 * 60); // next day 09:01, with regular beats in between in real life
    monitor.beat();
    monitor.check();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('0 tweets posted');
  });

  test('starting after the report hour waits until tomorrow', () => {
    const { monitor, messages } = setup({ dailyReportHour: 9, start: new Date(2026, 9, 5, 22, 0, 0) });
    monitor.check();
    expect(messages).toHaveLength(0);
  });
});
