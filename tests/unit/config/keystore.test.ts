import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths, type AppPaths } from '../../../src/config/app-paths';
import {
  KEYSTORE_SECRET_ENV,
  clearKeystoreDerivedKeyCache,
  getSecret,
  setSecret,
} from '../../../src/config/keystore';

// A container redeploy = same volume, new hostname. Mock it to simulate one.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: vi.fn(() => 'host-a') };
});

const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);
const roots: string[] = [];

async function keystorePaths(): Promise<AppPaths> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-keystore-'));
  roots.push(root);
  return resolveAppPaths({ rootDir: root, profile: 'claude' });
}

function redeployOnNewHost(): void {
  clearKeystoreDerivedKeyCache();
  vi.mocked(hostname).mockReturnValue('host-b');
}

beforeEach(() => {
  vi.mocked(hostname).mockReturnValue('host-a');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('keystore key seed', () => {
  it('keeps secrets readable across a hostname change when the keystore secret is set', async () => {
    vi.stubEnv(KEYSTORE_SECRET_ENV, SECRET_A);
    const paths = await keystorePaths();
    await setSecret('app-cli_x', 'app-secret-value', paths);

    redeployOnNewHost();

    await expect(getSecret('app-cli_x', paths)).resolves.toBe('app-secret-value');
  });

  it('without it, a hostname change leaves stored secrets undecryptable, with a clear error', async () => {
    vi.stubEnv(KEYSTORE_SECRET_ENV, '');
    const paths = await keystorePaths();
    await setSecret('app-cli_x', 'app-secret-value', paths);

    redeployOnNewHost();

    await expect(getSecret('app-cli_x', paths)).rejects.toThrow(
      /cannot decrypt keystore entry "app-cli_x".*LARK_CHANNEL_KEYSTORE_SECRET/,
    );
  });

  it('never reuses a cached key after the secret changes', async () => {
    vi.stubEnv(KEYSTORE_SECRET_ENV, SECRET_A);
    const paths = await keystorePaths();
    await setSecret('app-cli_x', 'app-secret-value', paths);

    vi.stubEnv(KEYSTORE_SECRET_ENV, SECRET_B);

    await expect(getSecret('app-cli_x', paths)).rejects.toThrow(/cannot decrypt keystore entry/);
  });

  it('ignores surrounding whitespace in the secret, so a pasted newline keeps the same key', async () => {
    vi.stubEnv(KEYSTORE_SECRET_ENV, `${SECRET_A}\n`);
    const paths = await keystorePaths();
    await setSecret('app-cli_x', 'app-secret-value', paths);

    vi.stubEnv(KEYSTORE_SECRET_ENV, SECRET_A);

    await expect(getSecret('app-cli_x', paths)).resolves.toBe('app-secret-value');
  });

  it('rejects a keystore secret too short to be a real key', async () => {
    vi.stubEnv(KEYSTORE_SECRET_ENV, 'short-secret');
    const paths = await keystorePaths();

    await expect(setSecret('app-cli_x', 'app-secret-value', paths)).rejects.toThrow(
      /LARK_CHANNEL_KEYSTORE_SECRET must be at least 32 characters/,
    );
  });
});
