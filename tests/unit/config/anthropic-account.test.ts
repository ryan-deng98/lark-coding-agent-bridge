import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_API_KEY_SECRET_ID,
  AnthropicAccountError,
  anthropicAccountView,
  connectAnthropicAccount,
  connectClaudeLogin,
  disconnectAnthropicAccount,
  maskAnthropicApiKey,
  normalizeAnthropicApiKeyInput,
  readAnthropicAccount,
  resolveAnthropicApiKey,
} from '../../../src/config/anthropic-account';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, removeSecret } from '../../../src/config/keystore';
import {
  claudeLoginConfigDir,
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';
import { loadRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { writeNewProfile } from '../../../src/ui/onboard';

const GOOD_KEY = `sk-ant-api03-${'a'.repeat(40)}WXYZ`;
const validOk = async () => ({ ok: true as const });
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function claudeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-anthropic-'));
  roots.push(root);
  await writeNewProfile(
    {
      profile: 'claude',
      agentKind: 'claude',
      appId: 'cli_a',
      appSecret: 'lark-app-secret',
      tenant: 'feishu',
      workspace: root,
    },
    root,
  );
  return root;
}

async function runtimeFor(root: string, profile: string) {
  const appPaths = resolveAppPaths({ rootDir: root, profile });
  const rc = (await loadRootConfig(appPaths.configFile))!;
  return {
    appPaths,
    profileConfig: rc.profiles[profile]!,
    secrets: runtimeProfileConfig(rc, profile).secrets,
  };
}

describe('normalizeAnthropicApiKeyInput', () => {
  it('trims and accepts a Console API key', () => {
    expect(normalizeAnthropicApiKeyInput(`  ${GOOD_KEY}\n`)).toEqual({ ok: true, apiKey: GOOD_KEY });
  });

  it.each([
    ['', /填写/],
    ['   ', /填写/],
    [123, /填写/],
    ['sk-ant-api03 abc', /空白/],
    [`sk-ant-oat01-${'x'.repeat(40)}`, /OAuth token/],
    [`sk-ant-admin01-${'x'.repeat(40)}`, /Admin/],
    [`sk-ant-api03-${'x'.repeat(600)}`, /长度/],
  ])('rejects %j', (raw, reason) => {
    const result = normalizeAnthropicApiKeyInput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe('connectClaudeLogin', () => {
  const signedIn = async () => ({
    loggedIn: true as const,
    email: 'me@example.com',
    orgName: 'Acme',
    subscriptionType: 'team',
  });

  it("connects the bot's own signed-in Claude login and hides the email", async () => {
    const root = await claudeRoot();
    const checked: string[] = [];

    const view = await connectClaudeLogin({ profile: 'claude' }, root, {
      checkLogin: async (dir) => {
        checked.push(dir);
        return signedIn();
      },
      now: () => new Date('2026-09-23T00:00:00Z'),
    });

    const loginDir = join(root, 'profiles', 'claude', 'claude-code');
    expect(checked).toEqual([loginDir]);
    expect(view).toEqual({
      connected: true,
      mode: 'claude-login',
      accountHint: 'Acme · team',
      connectedAt: '2026-09-23T00:00:00.000Z',
    });
    const { appPaths, profileConfig, secrets } = await runtimeFor(root, 'claude');
    expect(claudeLoginConfigDir(profileConfig)).toBe(loginDir);
    expect(await readFile(appPaths.configFile, 'utf8')).not.toContain('me@example.com');
    await expect(resolveAnthropicApiKey(profileConfig, { secrets, secretPaths: appPaths })).resolves.toBeUndefined();
  });

  it('falls back to a masked, audit-safe email when the account has no org', async () => {
    const root = await claudeRoot();

    const view = await connectClaudeLogin({ profile: 'claude' }, root, {
      checkLogin: async () => ({ loggedIn: true, email: 'dengjie@example.com', subscriptionType: 'pro' }),
    });

    expect(view.accountHint).toBe('de***[at]example.com · pro');
  });

  it('refuses until the login dir is signed in, and says how to sign in', async () => {
    const root = await claudeRoot();

    await expect(
      connectClaudeLogin({ profile: 'claude' }, root, { checkLogin: async () => ({ loggedIn: false }) }),
    ).rejects.toThrow(/连接我的 Claude 账号/);
    const { profileConfig } = await runtimeFor(root, 'claude');
    expect(profileConfig).not.toHaveProperty('anthropic');
  });

  it('drops a previously stored API key when switching to the Claude login', async () => {
    const root = await claudeRoot();
    await connectAnthropicAccount({ profile: 'claude', apiKey: GOOD_KEY }, root, { validate: validOk });

    await connectClaudeLogin({ profile: 'claude' }, root, { checkLogin: signedIn });

    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    expect(await getSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths)).toBeUndefined();
  });
});

describe('maskAnthropicApiKey', () => {
  it('keeps only the prefix and the last four characters', () => {
    expect(maskAnthropicApiKey(GOOD_KEY)).toBe('sk-ant-…WXYZ');
  });

  it('hides short values entirely', () => {
    expect(maskAnthropicApiKey('short')).toBe('••••');
  });
});

describe('connectAnthropicAccount / disconnectAnthropicAccount', () => {
  it('stores the key only in the profile keystore and resolves it for runs', async () => {
    const root = await claudeRoot();

    const view = await connectAnthropicAccount({ profile: 'claude', apiKey: ` ${GOOD_KEY} ` }, root, {
      validate: validOk,
      now: () => new Date('2026-09-23T00:00:00Z'),
    });

    expect(view).toEqual({ connected: true, keyHint: 'sk-ant-…WXYZ', connectedAt: '2026-09-23T00:00:00.000Z' });
    const { appPaths, profileConfig, secrets } = await runtimeFor(root, 'claude');
    expect(await getSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths)).toBe(GOOD_KEY);
    expect(await readFile(appPaths.configFile, 'utf8')).not.toContain(GOOD_KEY);
    expect(anthropicAccountView(profileConfig)).toEqual(view);
    await expect(resolveAnthropicApiKey(profileConfig, { secrets, secretPaths: appPaths })).resolves.toBe(GOOD_KEY);
  });

  it('rejects a key the API refuses and leaves the profile untouched', async () => {
    const root = await claudeRoot();
    const before = await readFile(join(root, 'config.json'), 'utf8');

    await expect(
      connectAnthropicAccount({ profile: 'claude', apiKey: GOOD_KEY }, root, {
        validate: async () => ({ ok: false, reason: 'API key 无效或已被吊销（401）' }),
      }),
    ).rejects.toThrow(/无效/);

    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe(before);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    expect(await getSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths)).toBeUndefined();
  });

  it('refuses unknown and Codex profiles before spending a validation call', async () => {
    const root = await claudeRoot();
    const configFile = join(root, 'config.json');
    const rc = (await loadRootConfig(configFile))!;
    rc.profiles.cx = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_cx', secret: '${APP_SECRET}', tenant: 'feishu' } },
      codex: { binaryPath: '/usr/local/bin/codex' },
    });
    await saveRootConfig(rc, configFile);
    const validate = vi.fn(validOk);

    await expect(
      connectAnthropicAccount({ profile: 'nope', apiKey: GOOD_KEY }, root, { validate }),
    ).rejects.toBeInstanceOf(AnthropicAccountError);
    await expect(
      connectAnthropicAccount({ profile: 'cx', apiKey: GOOD_KEY }, root, { validate }),
    ).rejects.toThrow(/Codex/);
    expect(validate).not.toHaveBeenCalled();
  });

  it('disconnect removes the key so runs fall back to the local claude login', async () => {
    const root = await claudeRoot();
    await connectAnthropicAccount({ profile: 'claude', apiKey: GOOD_KEY }, root, { validate: validOk });

    const view = await disconnectAnthropicAccount({ profile: 'claude' }, root);

    expect(view).toEqual({ connected: false });
    const { appPaths, profileConfig, secrets } = await runtimeFor(root, 'claude');
    expect(profileConfig).not.toHaveProperty('anthropic');
    expect(await getSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths)).toBeUndefined();
    await expect(resolveAnthropicApiKey(profileConfig, { secrets, secretPaths: appPaths })).resolves.toBeUndefined();
  });

  it('fails loudly instead of borrowing the Lark App Secret when the stored key is gone', async () => {
    const root = await claudeRoot();
    await connectAnthropicAccount({ profile: 'claude', apiKey: GOOD_KEY }, root, { validate: validOk });
    const { appPaths, profileConfig, secrets } = await runtimeFor(root, 'claude');
    await removeSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths);

    await expect(resolveAnthropicApiKey(profileConfig, { secrets, secretPaths: appPaths })).rejects.toThrow(
      /重新连接/,
    );
  });

  it('resolves an injected key for headless deployments without touching the keystore', async () => {
    vi.stubEnv('TEST_LCB_ANTHROPIC_KEY', GOOD_KEY);
    const profileConfig = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app: { id: 'cli_env', secret: '${APP_SECRET}', tenant: 'feishu' } },
      anthropic: { apiKey: '${TEST_LCB_ANTHROPIC_KEY}' },
    });
    const secretPaths = resolveAppPaths({ rootDir: join(tmpdir(), 'bridge-never-created'), profile: 'claude' });

    await expect(resolveAnthropicApiKey(profileConfig, { secretPaths })).resolves.toBe(GOOD_KEY);
  });

  it('tells the console which command signs this bot in to Claude', async () => {
    const root = await claudeRoot();
    const loginDir = join(root, 'profiles', 'claude', 'claude-code');

    expect(await readAnthropicAccount('claude', root)).toEqual({
      connected: false,
      loginCommand: `CLAUDE_CONFIG_DIR='${loginDir}' claude auth login`,
    });
  });

  it('leaves profiles without an Anthropic account on the local claude login', async () => {
    const root = await claudeRoot();
    const { appPaths, profileConfig, secrets } = await runtimeFor(root, 'claude');

    expect(anthropicAccountView(profileConfig)).toEqual({ connected: false });
    await expect(resolveAnthropicApiKey(profileConfig, { secrets, secretPaths: appPaths })).resolves.toBeUndefined();
  });
});
