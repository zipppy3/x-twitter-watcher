import fs from 'node:fs';

/** How often the daemon refreshes its pid file and looks for a stop request. */
export const HEARTBEAT_INTERVAL_MS = 2000;

/** A pid file not refreshed for this long does not belong to a live daemon. */
const HEARTBEAT_STALE_MS = 20000;

export type StopResult = 'not-running' | 'stopped' | 'killed';

export function writePidFile(pidPath: string, pid: number): void {
  fs.writeFileSync(pidPath, String(pid), 'utf8');
}

export function readPidFile(pidPath: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function removePidFile(pidPath: string): void {
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

export function isProcessRunning(pid: number | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Heartbeat: called by the daemon so others can tell its pid file is current. */
export function touchPidFile(pidPath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(pidPath, now, now);
  } catch {
    // The file may have been removed by a stop/cleanup; nothing to refresh.
  }
}

/**
 * Whether the daemon that wrote the pid file is alive.
 *
 * A pid alone is not enough: after an unclean exit the number can be reused by an
 * unrelated process. The daemon keeps the file's mtime fresh, so a stale file
 * means the pid no longer refers to the watcher.
 */
export function isDaemonRunning(pidPath: string): boolean {
  if (!isProcessRunning(readPidFile(pidPath))) {
    return false;
  }
  try {
    return Date.now() - fs.statSync(pidPath).mtimeMs < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

function stopRequestPath(pidPath: string): string {
  return `${pidPath}.stop`;
}

export function clearStopRequest(pidPath: string): void {
  try {
    fs.rmSync(stopRequestPath(pidPath), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

/** Called by the daemon on its heartbeat. */
export function hasStopRequest(pidPath: string): boolean {
  return fs.existsSync(stopRequestPath(pidPath));
}

/**
 * Ask the daemon to shut down and wait for it to exit.
 *
 * The request is a marker file the daemon polls for, because signals cannot
 * trigger a graceful shutdown on Windows (process.kill terminates outright).
 * If the daemon does not exit in time it is killed, but only after the
 * heartbeat confirmed the pid really is the watcher.
 */
export async function stopDaemon(pidPath: string, timeoutMs = 45000): Promise<StopResult> {
  const pid = readPidFile(pidPath);
  if (!pid || !isDaemonRunning(pidPath)) {
    removePidFile(pidPath);
    clearStopRequest(pidPath);
    return 'not-running';
  }

  fs.writeFileSync(stopRequestPath(pidPath), String(Date.now()), 'utf8');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      removePidFile(pidPath);
      clearStopRequest(pidPath);
      return 'stopped';
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  removePidFile(pidPath);
  clearStopRequest(pidPath);
  return 'killed';
}

function manualStopPath(pidPath: string): string {
  return `${pidPath}.manual-stop`;
}

/**
 * Remember that the watcher was stopped on purpose. `ensure-running` (the
 * auto-restart watchdog) only brings the watcher back when it went away without
 * this marker, i.e. after a crash or a reboot.
 */
export function markStoppedOnPurpose(pidPath: string): void {
  fs.writeFileSync(manualStopPath(pidPath), new Date().toISOString(), 'utf8');
}

export function clearStoppedOnPurpose(pidPath: string): void {
  try {
    fs.rmSync(manualStopPath(pidPath), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

export function wasStoppedOnPurpose(pidPath: string): boolean {
  return fs.existsSync(manualStopPath(pidPath));
}
