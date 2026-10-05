import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { firefox, Browser } from 'playwright-core';
import { rootLogger } from '../runtime/logger';

const SERVER_SCRIPT = path.join('scripts', 'camoufox_server.py');
/** Browser start can take a while on small machines; override with CAMOUFOX_STARTUP_TIMEOUT_MS. */
const STARTUP_TIMEOUT_MS = Number(process.env.CAMOUFOX_STARTUP_TIMEOUT_MS) || 90000;
/** After a failed launch, wait this long before trying again. */
const RETRY_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * Find the Python interpreter that has the `camoufox` package installed:
 * CAMOUFOX_PYTHON, then the project's .venv, then whatever is on PATH.
 */
export function resolvePythonExecutable(packageRoot: string): string {
  const explicit = process.env.CAMOUFOX_PYTHON;
  if (explicit) {
    return explicit;
  }

  const venvPython =
    process.platform === 'win32'
      ? path.join(packageRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(packageRoot, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Owns the Camoufox browser used by the screenshot service and the Nitter client.
 *
 * Camoufox itself is launched by the official Python package as a Playwright
 * server; this class manages that process and hands out a connected Browser.
 * If the browser or the server dies, the next `get()` starts a fresh one.
 */
export class CamoufoxBrowser {
  private readonly logger = rootLogger.child('camoufox');

  private server: ChildProcess | null = null;

  private browser: Browser | null = null;

  private launching: Promise<Browser | null> | null = null;

  private lastFailureAt = 0;

  private closed = false;

  constructor(private readonly packageRoot: string) {}

  async get(): Promise<Browser | null> {
    if (this.closed) {
      return null;
    }
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (this.launching) {
      return this.launching;
    }
    if (Date.now() - this.lastFailureAt < RETRY_COOLDOWN_MS) {
      return null;
    }

    this.launching = this.launch()
      .catch((error) => {
        this.lastFailureAt = Date.now();
        this.logger.error('Failed to start Camoufox', { message: (error as Error).message });
        this.stopServer();
        return null;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.launching) {
      await this.launching.catch(() => null);
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }

    // Give the launcher a moment to shut the browser down cleanly (it removes
    // its temporary profile), then make sure nothing is left behind.
    const server = this.server;
    if (server && server.exitCode === null) {
      server.removeAllListeners('exit');
      const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
      server.stdin?.end();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 8000))]);
    }
    this.stopServer();
  }

  private async launch(): Promise<Browser> {
    this.stopServer();

    const python = resolvePythonExecutable(this.packageRoot);
    const script = path.join(this.packageRoot, SERVER_SCRIPT);
    const server = spawn(python, ['-u', script], {
      cwd: this.packageRoot,
      // stdin stays open on purpose: the script exits when this pipe closes.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.server = server;

    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        reject(new Error(`Camoufox server did not start within ${STARTUP_TIMEOUT_MS / 1000}s`));
      }, STARTUP_TIMEOUT_MS);

      const onData = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        const match = output.match(/wss?:\/\/[^\s\x1b]+(?=[\s\x1b])/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };

      server.stdout?.on('data', onData);
      server.stderr?.on('data', onData);
      server.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not run "${python}": ${error.message}. Install the Python side with: pip install -r requirements.txt`));
      });
      server.once('exit', (code) => {
        clearTimeout(timer);
        const tail = output.trim().split(/\r?\n/).slice(-3).join(' | ');
        reject(new Error(`Camoufox server exited with code ${code}${tail ? `: ${tail}` : ''}`));
      });
    });

    const browser = await firefox.connect(wsEndpoint, { timeout: 30000 });
    browser.on('disconnected', () => {
      if (this.browser === browser) {
        this.browser = null;
        if (!this.closed) {
          this.logger.warn('Camoufox browser disconnected; it will be restarted on the next use');
        }
      }
    });

    this.browser = browser;
    this.logger.info('Camoufox browser ready', { version: browser.version() });
    return browser;
  }

  private stopServer(): void {
    const server = this.server;
    this.server = null;
    if (!server || server.exitCode !== null || !server.pid) {
      return;
    }

    server.removeAllListeners('exit');
    // Closing stdin asks the Python launcher to exit, which shuts the browser down.
    server.stdin?.end();
    if (process.platform === 'win32') {
      // child.kill() would leave the browser's own child processes behind on Windows.
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      server.kill('SIGTERM');
    }
  }
}
