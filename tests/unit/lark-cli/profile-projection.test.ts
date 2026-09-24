import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import type { AppConfig } from '../../../src/config/schema';
import { writeLarkCliSourceProjection } from '../../../src/lark-cli/profile-projection';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-lark-cli-projection-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('writeLarkCliSourceProjection', () => {
  it('writes a profile-scoped legacy lark-channel source config', async () => {
    const root = await tempRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex-dev' });
    const cfg: AppConfig = {
      accounts: {
        app: {
          id: 'cli_codex',
          tenant: 'feishu',
          secret: {
            source: 'exec',
            provider: 'bridge',
            id: 'app-cli_codex',
          },
        },
      },
      secrets: {
        providers: {
          bridge: {
            source: 'exec',
            command: '/stale/secrets-getter',
            args: ['old'],
          },
        },
      },
    };

    const path = await writeLarkCliSourceProjection(cfg, appPaths);

    expect(path).toBe(appPaths.larkCliSourceConfigFile);
    const source = JSON.parse(await readFile(path, 'utf8')) as {
      accounts: {
        app: {
          id: string;
          tenant: string;
          secret: unknown;
        };
      };
      secrets: {
        providers: {
          bridge: {
            source: string;
            command: string;
            args: string[];
            env: Record<string, string>;
          };
        };
      };
    };
    expect(source).toEqual({
      accounts: {
        app: {
          id: 'cli_codex',
          tenant: 'feishu',
          secret: {
            source: 'exec',
            provider: 'bridge',
            id: 'app-cli_codex',
          },
        },
      },
      secrets: {
        providers: {
          bridge: {
            source: 'exec',
            command: expectedSecretsGetterWrapper(appPaths.secretsGetterScript),
            args: [],
            env: {
              LARK_CHANNEL_HOME: root,
              LARK_CHANNEL_PROFILE: 'codex-dev',
            },
            passEnv: ['LARK_CHANNEL_KEYSTORE_SECRET'],
          },
        },
      },
    });
    const mode = (await stat(path)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('hands the keystore secret to the getter by name, never writing its value', async () => {
    const secret = 'z'.repeat(64);
    vi.stubEnv('LARK_CHANNEL_KEYSTORE_SECRET', secret);
    try {
      const root = await tempRoot();
      const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
      const cfg: AppConfig = {
        accounts: {
          app: {
            id: 'cli_claude',
            tenant: 'lark',
            secret: { source: 'exec', provider: 'bridge', id: 'app-cli_claude' },
          },
        },
        secrets: {
          providers: {
            bridge: { source: 'exec', command: '/stale/getter', passEnv: ['LARK_CHANNEL_KEYSTORE_SECRET'] },
          },
        },
      };

      const text = await readFile(await writeLarkCliSourceProjection(cfg, appPaths), 'utf8');

      expect(JSON.parse(text).secrets.providers.bridge.passEnv).toEqual(['LARK_CHANNEL_KEYSTORE_SECRET']);
      expect(text).not.toContain(secret);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function expectedSecretsGetterWrapper(script: string): string {
  return process.platform === 'win32' ? `${script}.cmd` : script;
}
