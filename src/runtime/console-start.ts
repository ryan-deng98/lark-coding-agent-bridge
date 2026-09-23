import { access } from 'node:fs/promises';

export interface ConsoleStartInput {
  configPath: string;
  /** `--app-id` given: bootstrap from flags, as before. */
  appId?: string;
  /** stdin and stdout are a TTY, so the terminal QR flow can run. */
  interactive: boolean;
}

/**
 * Whether the supervisor console should start with no bot yet. With no config
 * and no terminal to scan a QR code in (a container), the terminal bootstrap
 * can't run; the console's onboarding wizard creates the first bot instead.
 */
export async function shouldStartConsoleEmpty(input: ConsoleStartInput): Promise<boolean> {
  if (input.appId || input.interactive) return false;
  return !(await pathExists(input.configPath));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    // Anything but "missing" (e.g. EACCES) is left for the normal startup to report.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
