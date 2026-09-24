import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

const roots: string[] = [];
let handle: UiServerHandle;
let rootDir: string;
let configPath: string;
let base: string;
// profile -> controls (a MutableProfileState/Controls-ish object)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let online: Map<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeControls(profile: string): Promise<any> {
  const root = (await loadRootConfig(configPath))!;
  return {
    configPath,
    profile,
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
    ownerRefreshState: 'unknown',
    processId: 'test',
    refreshOwner: async () => {},
    restart: async () => {},
  };
}

function stubSupervisor(): UiSupervisor {
  return {
    isOnline: (p) => online.has(p),
    controlsFor: (p) => online.get(p),
    channelFor: () => undefined,
    list: () =>
      [...online.keys()].map((p) => ({
        profile: p,
        agentKind: 'claude' as const,
        online: true,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        botName: `bot-${p}`,
      })),
    startProfile: async (p) => {
      online.set(p, await makeControls(p));
    },
    stopProfile: async (p) => {
      online.delete(p);
    },
    restartProfile: async () => {},
  };
}

function get(path: string, token?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers: { ...(token ? { 'x-ui-token': token } : {}), ...headers } });
}
function post(path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-ui-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-ui-'));
  roots.push(rootDir);
  configPath = join(rootDir, 'config.json');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } })),
    configPath,
  );
  // second profile 'work' on disk (offline)
  const rc = (await loadRootConfig(configPath))!;
  await mkdir(join(rootDir, 'profiles', 'work'), { recursive: true });
  rc.profiles.work = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { ...app, id: 'cli_work' } } });
  await saveRootConfig(rc, configPath);
  await writeActiveProfile(rootDir, 'claude');

  online = new Map();
  online.set('claude', await makeControls('claude')); // claude online, work offline

  handle = await startUiServer({ supervisor: stubSupervisor(), version: 'test', rootDir });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('ui server (supervisor-backed)', () => {
  it('rejects API calls without the token', async () => {
    expect((await get('/api/status')).status).toBe(401);
    expect((await get('/api/config', 'wrong-token-value')).status).toBe(401);
  });

  it('rejects cross-origin requests', async () => {
    const res = await get('/api/status', handle.token, { origin: 'http://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('serves the console shell without a token', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('控制台');
  });

  it('returns status and config for the active (online) profile', async () => {
    const status = await json(await get('/api/status', handle.token));
    expect(status).toMatchObject({ hosted: true, version: 'test', activeProfile: 'claude', online: 1 });

    const config = await json(await get('/api/config', handle.token));
    expect(config.mode).toBe('personal');
    expect(config.live).toBe(true);
  });

  it('applies a config change live to an online profile and persists it', async () => {
    const view = await json(
      await post('/api/config', handle.token, { mode: 'team', maxConcurrentRuns: 7, requireMentionInGroup: false }),
    );
    expect(view.mode).toBe('team');
    expect(view.live).toBe(true);
    expect(online.get('claude').profileConfig.mode).toBe('team'); // in-memory controls updated

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.claude.mode).toBe('team');
  });

  it('reads and writes an offline profile on disk (deferred, live=false)', async () => {
    const view = await json(await get('/api/config?profile=work', handle.token));
    expect(view.live).toBe(false);

    const saved = await json(
      await post('/api/config?profile=work', handle.token, { mode: 'team' }),
    );
    expect(saved.live).toBe(false);
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    expect(disk.profiles.work.mode).toBe('team');
    expect(disk.profiles.claude.mode).toBe('personal');
  });

  it('adds and removes access entries', async () => {
    const added = await json(await post('/api/access', handle.token, { action: 'add', kind: 'user', id: 'ou_alice' }));
    expect(added.allowedUsers).toContain('ou_alice');
    const removed = await json(await post('/api/access', handle.token, { action: 'remove', kind: 'user', id: 'ou_alice' }));
    expect(removed.allowedUsers).not.toContain('ou_alice');
  });

  it('sets and clears a per-chat @-mention override, and drops it when the chat is removed', async () => {
    await json(await post('/api/access', handle.token, { action: 'add', kind: 'chat', id: 'oc_grp' }));

    // Set an override (respond to all — no @ needed).
    const set = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: false }),
    );
    expect(set.chatRequireMention).toEqual({ oc_grp: false });
    expect(online.get('claude').profileConfig.access.chatRequireMention).toEqual({ oc_grp: false });

    // Clear it (follow global) with null.
    const cleared = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: null }),
    );
    expect(cleared.chatRequireMention).toEqual({});

    // Re-set then remove the chat → override is dropped too.
    await json(await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: true }));
    const afterRemove = await json(
      await post('/api/access', handle.token, { action: 'remove', kind: 'chat', id: 'oc_grp' }),
    );
    expect(afterRemove.allowedChats).not.toContain('oc_grp');
    expect(afterRemove.chatRequireMention).toEqual({});
  });

  it('lists profiles with online flag from the supervisor', async () => {
    const { profiles } = await json(await get('/api/profiles', handle.token));
    const byName = Object.fromEntries(profiles.map((p: { name: string }) => [p.name, p]));
    expect(byName.claude.running).toBe(true);
    expect(byName.work.running).toBe(false);
  });

  it('lists online channels from the supervisor', async () => {
    const { bots } = await json(await get('/api/bots', handle.token));
    expect(bots.map((b: { profileName: string }) => b.profileName)).toEqual(['claude']);
  });

  it('starts and stops a profile via the supervisor', async () => {
    expect((await post('/api/profiles/start', handle.token, { profile: 'work' })).status).toBe(200);
    expect(online.has('work')).toBe(true);
    expect((await post('/api/profiles/stop', handle.token, { profile: 'claude' })).status).toBe(200);
    expect(online.has('claude')).toBe(false);
  });

  it('returns 404 for an unknown QR registration session', async () => {
    const res = await get('/api/profiles/qr/status?sessionId=nope', handle.token);
    expect(res.status).toBe(404);
  });
});

describe('ui server anthropic account routes', () => {
  const KEY = `sk-ant-api03-${'b'.repeat(40)}LAST`;
  type Validation = { ok: true } | { ok: false; reason: string };

  async function restartWith(validate: (apiKey: string) => Promise<Validation>, restarted: string[] = []) {
    await handle.close();
    const supervisor = stubSupervisor();
    supervisor.restartProfile = async (p) => {
      restarted.push(p);
    };
    handle = await startUiServer({ supervisor, version: 'test', rootDir, validateAnthropicApiKey: validate });
    base = `http://127.0.0.1:${handle.port}`;
  }

  it('connects, reports and disconnects a key, restarting the bot only when it is online', async () => {
    const restarted: string[] = [];
    const seen: string[] = [];
    await restartWith(async (apiKey) => {
      seen.push(apiKey);
      return { ok: true };
    }, restarted);

    expect(await json(await get('/api/anthropic?profile=claude', handle.token))).toMatchObject({ connected: false });

    const res = await post('/api/anthropic/connect', handle.token, { profile: 'claude', apiKey: KEY });
    expect(res.status).toBe(200);
    const connected = await json(res);
    expect(connected).toMatchObject({ connected: true, keyHint: 'sk-ant-…LAST', restarted: true });
    expect(JSON.stringify(connected)).not.toContain(KEY);
    expect(seen).toEqual([KEY]);
    expect(restarted).toEqual(['claude']);

    const offline = await json(await post('/api/anthropic/connect', handle.token, { profile: 'work', apiKey: KEY }));
    expect(offline).toMatchObject({ connected: true, restarted: false });
    expect(restarted).toEqual(['claude']);

    expect(await json(await get('/api/anthropic?profile=claude', handle.token))).toMatchObject({
      connected: true,
      keyHint: 'sk-ant-…LAST',
    });

    const disconnected = await json(await post('/api/anthropic/disconnect', handle.token, { profile: 'claude' }));
    expect(disconnected).toEqual({ connected: false, restarted: true });
    expect(restarted).toEqual(['claude', 'claude']);
  });

  it('keeps a saved key and reports why the running bot could not restart onto it', async () => {
    await handle.close();
    const supervisor = stubSupervisor();
    supervisor.restartProfile = async () => {
      throw new Error('claude binary not found');
    };
    handle = await startUiServer({
      supervisor,
      version: 'test',
      rootDir,
      validateAnthropicApiKey: async () => ({ ok: true }),
    });
    base = `http://127.0.0.1:${handle.port}`;

    const res = await post('/api/anthropic/connect', handle.token, { profile: 'claude', apiKey: KEY });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      connected: true,
      restarted: false,
      restartError: 'claude binary not found',
    });
    expect(await json(await get('/api/anthropic?profile=claude', handle.token))).toMatchObject({ connected: true });
  });

  it("connects the bot's own Claude login and shows how to sign in first", async () => {
    await handle.close();
    const restarted: string[] = [];
    const checked: string[] = [];
    const supervisor = stubSupervisor();
    supervisor.restartProfile = async (p) => {
      restarted.push(p);
    };
    handle = await startUiServer({
      supervisor,
      version: 'test',
      rootDir,
      checkClaudeLogin: async (dir) => {
        checked.push(dir);
        return { loggedIn: true, orgName: 'Acme', subscriptionType: 'team' };
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const loginDir = join(rootDir, 'profiles', 'claude', 'claude-code');

    expect(await json(await get('/api/anthropic?profile=claude', handle.token))).toEqual({
      connected: false,
      loginCommand: `CLAUDE_CONFIG_DIR='${loginDir}' claude auth login`,
      companyKey: Boolean(process.env.ANTHROPIC_API_KEY),
    });

    const res = await post('/api/anthropic/connect-login', handle.token, { profile: 'claude' });

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      connected: true,
      mode: 'claude-login',
      accountHint: 'Acme · team',
      restarted: true,
    });
    expect(checked).toEqual([loginDir]);
    expect(restarted).toEqual(['claude']);
  });

  it('answers 400 with the reason when the key is refused', async () => {
    await restartWith(async () => ({ ok: false, reason: 'API key 无效或已被吊销（401）' }));

    const res = await post('/api/anthropic/connect', handle.token, { profile: 'claude', apiKey: KEY });

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/无效/);
  });

  it('requires an explicit profile to change the account', async () => {
    await restartWith(async () => ({ ok: true }));

    expect((await post('/api/anthropic/connect', handle.token, { apiKey: KEY })).status).toBe(400);
    expect((await post('/api/anthropic/disconnect', handle.token, {})).status).toBe(400);
  });
});

describe('ui server behind a public domain (cloud deployment)', () => {
  const PINNED = 'p'.repeat(64);
  const DOMAIN = 'bridge.up.railway.app';

  // fetch() won't set a custom Host header; a raw request can, like the platform proxy does.
  function statusFor(port: number, path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function restartExposed(): Promise<void> {
    await handle.close();
    handle = await startUiServer({
      supervisor: stubSupervisor(),
      version: 'test',
      rootDir,
      token: PINNED,
      allowedHosts: [DOMAIN.toUpperCase()],
    });
  }

  it('uses the pinned token instead of minting one', async () => {
    await restartExposed();

    expect(handle.token).toBe(PINNED);
    expect(
      await statusFor(handle.port, '/api/status', { host: DOMAIN, 'x-ui-token': PINNED }),
    ).toBe(200);
    expect(
      await statusFor(handle.port, '/api/status', { host: DOMAIN, 'x-ui-token': 'q'.repeat(64) }),
    ).toBe(401);
  });

  it('accepts its public domain as Host and Origin, and nothing else', async () => {
    await restartExposed();
    const ok = { host: DOMAIN, origin: `https://${DOMAIN}`, 'x-ui-token': PINNED };

    expect(await statusFor(handle.port, '/api/status', ok)).toBe(200);
    expect(await statusFor(handle.port, '/api/status', { ...ok, host: 'evil.example.com' })).toBe(403);
    expect(
      await statusFor(handle.port, '/api/status', { ...ok, origin: 'https://evil.example.com' }),
    ).toBe(403);
  });

  it('stays localhost-only when no public domain is configured', async () => {
    expect(
      await statusFor(handle.port, '/api/status', { host: DOMAIN, 'x-ui-token': handle.token }),
    ).toBe(403);
  });
});
