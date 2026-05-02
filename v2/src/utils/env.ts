import fs from 'node:fs';

export function readEnv(envPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(envPath)) {
    return env;
  }
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        env[match[1].trim()] = match[2].trim();
      }
    }
  } catch {
    // Ignore read errors
  }
  return env;
}

export function updateEnvKey(envPath: string, key: string, value: string): void {
  let lines: string[] = [];
  try {
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, 'utf8').split('\n');
    }
  } catch {
    // Ignore read errors
  }

  let found = false;
  const newLines = lines.map((line) => {
    if (line.match(new RegExp(`^\\s*${key}=`))) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${key}=${value}`);
  }

  // Trim trailing empty lines, then add exactly one empty line
  while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
    newLines.pop();
  }
  newLines.push('');

  fs.writeFileSync(envPath, newLines.join('\n'));
}
