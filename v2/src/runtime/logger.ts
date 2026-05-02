import fs from 'node:fs';
import path from 'node:path';

let fileStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;

/**
 * Enable persistent file logging. Call once during daemon startup.
 * Creates a rotating-style log file at the given path.
 */
export function enableFileLogging(filePath: string): void {
  if (fileStream) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  logFilePath = filePath;

  // Rotate if existing log exceeds 10MB
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) {
      const rotated = `${filePath}.1`;
      fs.renameSync(filePath, rotated);
    }
  } catch {
    // File doesn't exist yet — that's fine.
  }

  fileStream = fs.createWriteStream(filePath, { flags: 'a' });
}

export function closeFileLogging(): void {
  if (fileStream) {
    fileStream.end();
    fileStream = null;
    logFilePath = null;
  }
}

export class Logger {
  constructor(private readonly label: string) {}

  child(label: string): Logger {
    return new Logger(`${this.label}:${label}`);
  }

  info(message: string, extra?: unknown): void {
    this.write('INFO', message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.write('WARN', message, extra);
  }

  error(message: string, extra?: unknown): void {
    this.write('ERROR', message, extra);
  }

  debug(message: string, extra?: unknown): void {
    if (process.env.DEBUG !== 'true') {
      return;
    }
    this.write('DEBUG', message, extra);
  }

  private write(level: string, message: string, extra?: unknown): void {
    const ts = new Date().toISOString();
    const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
    const line = `[${ts}] [${level}] [${this.label}] ${message}${suffix}`;

    // Always write to console
    if (level === 'ERROR') {
      console.error(line);
    } else {
      console.log(line);
    }

    // Persist to log file when enabled
    if (fileStream) {
      fileStream.write(line + '\n');
    }
  }
}

export const rootLogger = new Logger('v2');
