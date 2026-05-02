import * as readline from 'node:readline/promises';
export const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyanBold: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
};

export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

export function banner(): void {
  console.log(c.cyanBold('\n  ╔══════════════════════════════════════╗'));
  console.log(c.cyanBold('  ║          X Watcher  v2.0           ║'));
  console.log(c.cyanBold('  ╚══════════════════════════════════════╝\n'));
}
