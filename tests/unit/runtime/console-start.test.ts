import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shouldStartConsoleEmpty } from '../../../src/runtime/console-start';

const roots: string[] = [];

async function configPathIn(opts: { exists: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-console-start-'));
  roots.push(root);
  const configPath = join(root, 'config.json');
  if (opts.exists) await writeFile(configPath, '{}\n');
  return configPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('shouldStartConsoleEmpty', () => {
  it('starts empty in a container: no config and no terminal for the QR flow', async () => {
    const configPath = await configPathIn({ exists: false });

    await expect(shouldStartConsoleEmpty({ configPath, interactive: false })).resolves.toBe(true);
  });

  it('runs the existing profile when a config is already there', async () => {
    const configPath = await configPathIn({ exists: true });

    await expect(shouldStartConsoleEmpty({ configPath, interactive: false })).resolves.toBe(false);
  });

  it('keeps the terminal QR bootstrap when a terminal is attached', async () => {
    const configPath = await configPathIn({ exists: false });

    await expect(shouldStartConsoleEmpty({ configPath, interactive: true })).resolves.toBe(false);
  });

  it('keeps the flag bootstrap when --app-id is given', async () => {
    const configPath = await configPathIn({ exists: false });

    await expect(
      shouldStartConsoleEmpty({ configPath, appId: 'cli_test', interactive: false }),
    ).resolves.toBe(false);
  });
});
