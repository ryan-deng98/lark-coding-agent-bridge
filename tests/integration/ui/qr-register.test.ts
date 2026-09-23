import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_API_KEY_SECRET_ID } from '../../../src/config/anthropic-account';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret } from '../../../src/config/keystore';
import { loadRootConfig } from '../../../src/config/profile-store';
import { finishQrRegistration, qrStatus, startQrRegistration } from '../../../src/ui/qr-register';

vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@larksuite/channel')>()),
  registerApp: vi.fn(async (opts: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
    opts.onQRCodeReady({ url: 'https://example.test/qr', expireIn: 600 });
    return {
      client_id: 'cli_qr',
      client_secret: 'qr-app-secret',
      user_info: { tenant_brand: 'lark', open_id: 'ou_owner' },
    };
  }),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'QR Bot' })),
}));

const KEY = `sk-ant-api03-${'q'.repeat(40)}QRQR`;
const roots: string[] = [];

afterEach(async () => {
  const dirs = roots.splice(0).flatMap((root) => [root, `${root}-workspaces`]);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scannedSession(): Promise<{ root: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-qr-'));
  roots.push(root);
  const { sessionId } = await startQrRegistration(root);
  await vi.waitFor(() => expect(qrStatus(sessionId).status).toBe('scanned'));
  return { root, sessionId };
}

describe('finishQrRegistration with an Anthropic key', () => {
  it("creates the bot already connected to the user's Anthropic account", async () => {
    const { root, sessionId } = await scannedSession();
    const validate = vi.fn(async () => ({ ok: true as const }));

    const result = await finishQrRegistration(
      { sessionId, agentKind: 'claude', profile: 'qr', anthropicApiKey: `  ${KEY} ` },
      root,
      { validateAnthropicApiKey: validate },
    );

    expect(result).toMatchObject({ profile: 'qr', anthropic: { connected: true, keyHint: 'sk-ant-…QRQR' } });
    expect(validate).toHaveBeenCalledWith(KEY);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'qr' });
    expect(await getSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths)).toBe(KEY);
    expect(await readFile(appPaths.configFile, 'utf8')).not.toContain(KEY);
  });

  it('refuses a bad key before creating anything, so the scan can be finished again', async () => {
    const { root, sessionId } = await scannedSession();

    await expect(
      finishQrRegistration({ sessionId, agentKind: 'claude', profile: 'qr', anthropicApiKey: KEY }, root, {
        validateAnthropicApiKey: async () => ({ ok: false, reason: 'API key 无效或已被吊销（401）' }),
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('无效') });

    expect(await loadRootConfig(join(root, 'config.json'))).toBeUndefined();
    expect(qrStatus(sessionId).status).toBe('scanned');
  });

  it('keeps a bot without a key on the local claude login', async () => {
    const { root, sessionId } = await scannedSession();
    const validate = vi.fn(async () => ({ ok: true as const }));

    const result = await finishQrRegistration({ sessionId, agentKind: 'claude', profile: 'qr' }, root, {
      validateAnthropicApiKey: validate,
    });

    expect(result).toEqual({ profile: 'qr' });
    expect(validate).not.toHaveBeenCalled();
    const cfg = await loadRootConfig(join(root, 'config.json'));
    expect(cfg?.profiles.qr).not.toHaveProperty('anthropic');
  });
});
