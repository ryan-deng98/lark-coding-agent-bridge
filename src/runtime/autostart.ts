import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * The bots a deployment brings back after a restart: every profile someone
 * started from the console and hasn't stopped since — not only the active
 * one, since in a shared deployment each person's bot matters.
 */

const FILE = 'autostart.json';
const VERSION = 1;
let queue: Promise<unknown> = Promise.resolve();

export async function readAutostart(rootDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(rootDir, FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text) as { version?: unknown; profiles?: unknown };
  if (parsed.version !== VERSION || !Array.isArray(parsed.profiles)) return [];
  return parsed.profiles.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/** Remember (or forget) that a profile should come back after a restart. */
export function setAutostart(rootDir: string, profile: string, on: boolean): Promise<void> {
  const run = queue.then(async () => {
    const current = await readAutostart(rootDir);
    const next = on ? [...new Set([...current, profile])] : current.filter((p) => p !== profile);
    if (next.length === current.length && next.every((p, i) => p === current[i])) return;
    await writeFileAtomic(join(rootDir, FILE), `${JSON.stringify({ version: VERSION, profiles: next }, null, 2)}\n`, {
      mode: 0o600,
    });
  });
  queue = run.catch(() => undefined);
  return run;
}
