/**
 * Ctrl+C safe readline helpers.
 * All functions return null on cancel (SIGINT or stream close).
 * Callers check null → propagate { cancelled: true }.
 */

import { createInterface } from 'readline';

/**
 * Prompt for text input. Returns null if cancelled.
 */
export async function promptText(question: string, defaultVal?: string): Promise<string | null> {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<string | null>((resolve) => {
    let answered = false;
    // BUG-7 fix: separate resolve guard from rl.close() to avoid recursive close.
    // rl.close() emits 'close' event synchronously — calling rl.close() inside done()
    // which is called from 'close' handler would recurse. Instead, only call rl.close()
    // from non-close paths; the 'close' handler just resolves.
    const settle = (val: string | null) => {
      if (answered) return;
      answered = true;
      resolve(val);
    };

    rl.on('SIGINT', () => { settle(null); rl.close(); });
    rl.on('close', () => settle(null));
    rl.question(`${question}${suffix}: `, (answer) => {
      settle(answer.trim() || defaultVal || '');
      rl.close();
    });
  });
}

/**
 * Prompt for yes/no confirmation. Returns null if cancelled.
 */
export async function promptConfirm(question: string): Promise<boolean | null> {
  const answer = await promptText(`${question} [y/N]`);
  if (answer === null) return null;
  return answer.toLowerCase() === 'y';
}

/**
 * Prompt user to select from numbered options. Returns 0-based index, or null if cancelled.
 */
export async function promptSelect(question: string, options: string[]): Promise<number | null> {
  console.log(`\n${question}\n`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  console.log();

  const answer = await promptText('Choice', '1');
  if (answer === null) return null;

  const num = parseInt(answer, 10);
  if (isNaN(num) || num < 1 || num > options.length) {
    console.error(`Invalid choice. Enter 1-${options.length}.`);
    return null;
  }
  return num - 1;
}
