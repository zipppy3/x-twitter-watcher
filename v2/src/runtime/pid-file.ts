import fs from 'node:fs';

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
