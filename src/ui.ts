import readline from "node:readline";

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  inverse: (s: string) => `\x1b[7m${s}\x1b[0m`,
};

export function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

export function width(): number {
  return Math.max(40, (process.stdout.columns ?? 100) - 2);
}

/** Wrap plain text to the terminal width with an indent. */
export function wrap(text: string, indent = "", w = width()): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if ((indent + line + word).length > w && line.trim()) {
        out.push(indent + line.trimEnd());
        line = word.trimStart();
      } else line += word;
    }
    out.push(indent + line.trimEnd());
  }
  return out;
}

export type Key = { name: string; ctrl?: boolean; sequence?: string };

/** Resolve with the next keypress (raw mode). */
export function nextKey(): Promise<Key> {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const on = (_s: string, key: Key) => {
      process.stdin.off("keypress", on);
      resolve(key ?? { name: _s });
    };
    process.stdin.on("keypress", on);
  });
}

/** Read one line of text (cooked mode). Empty string if the user just presses Enter. */
export async function askLine(prompt: string, initial = ""): Promise<string> {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
    if (initial) rl.write(initial);
  });
  rl.close();
  return answer;
}

export function done(code = 0): never {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?25h");
  process.exit(code);
}
