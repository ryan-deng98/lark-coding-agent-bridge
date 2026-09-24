import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { resolveLoginConfig, type LarkFetch, type LoginConfig } from '../../../src/ui/console-auth';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const DOMAIN = 'bridge.up.railway.app';
const TOKEN = 't'.repeat(64);
const app = (id: string) => ({ id, secret: '${APP_SECRET}', tenant: 'lark' as const });
// Lark people, by the authorization code the fake Lark hands out for them.
const PEOPLE: Record<string, { union_id: string; name: string }> = {
  'code-alice': { union_id: 'on_alice', name: 'Alice' },
  'code-carol': { union_id: 'on_carol', name: 'Carol' },
};

let rootDir: string;
let handle: UiServerHandle;
let login: LoginConfig;
let larkCalls: string[];

const fakeLark: LarkFetch = async (url, init) => {
  larkCalls.push(url);
  if (url.endsWith('/oauth/v3/token')) {
    const code = new URLSearchParams(String(init.body)).get('code') ?? '';
    return Response.json(PEOPLE[code] ? { code: 0, access_token: `at-${code}` } : { code: 20003, error: 'invalid_grant' });
  }
  const token = String((init.headers as Record<string, string>).authorization).replace('Bearer at-', '');
  return Response.json({ code: 0, data: PEOPLE[token] });
};

function supervisor(): UiSupervisor {
  const online = new Set<string>();
  return {
    isOnline: (p: string) => online.has(p),
    controlsFor: () => undefined,
    channelFor: () => undefined,
    list: () => [...online].map((profile) => ({ profile, agentKind: 'claude' as const, online: true, pid: 1, startedAt: '' })),
    startProfile: async (p: string) => void online.add(p),
    stopProfile: async (p: string) => void online.delete(p),
    restartProfile: async () => {},
  } as unknown as UiSupervisor;
}

interface Reply {
  status: number;
  location?: string;
  cookies: string[];
  body: string;
}

function call(path: string, opts: { method?: string; cookie?: string; token?: string; origin?: boolean; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: handle.port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          host: DOMAIN,
          ...(opts.origin ? { origin: `https://${DOMAIN}` } : {}),
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(opts.token ? { 'x-ui-token': opts.token } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            cookies: (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0] ?? ''),
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Sign in through the fake Lark as the person behind `code`; returns their session cookie. */
async function signIn(code: string): Promise<string> {
  const start = await call('/auth/lark/login');
  const state = new URL(start.location!).searchParams.get('state')!;
  const done = await call(`/auth/lark/callback?code=${code}&state=${state}`, { cookie: start.cookies.join('; ') });
  expect(done.location).toBe('/');
  const session = done.cookies.find((c) => c.startsWith('lcb_session='));
  expect(session).toBeDefined();
  return session!;
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-console-login-'));
  const root = createRootConfig('admin-bot', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_admin') } }));
  root.profiles['alice-bot'] = {
    ...createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_alice') } }),
    consoleOwner: { id: 'on_alice', name: 'Alice' },
  };
  root.profiles['bob-bot'] = {
    ...createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_bob') } }),
    consoleOwner: { id: 'on_bob', name: 'Bob' },
  };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  for (const name of Object.keys(root.profiles)) await mkdir(join(rootDir, 'profiles', name), { recursive: true });
  await writeActiveProfile(rootDir, 'admin-bot');
  larkCalls = [];
  login = resolveLoginConfig({
    env: {
      LARK_CHANNEL_LOGIN_APP_ID: 'cli_login',
      LARK_CHANNEL_LOGIN_APP_SECRET: 's'.repeat(32),
      LARK_CHANNEL_LOGIN_TENANT: 'lark',
      LARK_CHANNEL_ADMINS: 'on_carol',
      LARK_CHANNEL_KEYSTORE_SECRET: 'k'.repeat(64),
    },
    publicUrl: `https://${DOMAIN}/`,
  })!;
  handle = await startUiServer({
    supervisor: supervisor(),
    version: 'test',
    rootDir,
    token: TOKEN,
    allowedHosts: [DOMAIN],
    login,
    larkFetch: fakeLark,
  });
});

afterEach(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

describe('console sign-in with Lark', () => {
  it('sends people to Lark with PKCE and our callback, then signs them in', async () => {
    const start = await call('/auth/lark/login');
    const to = new URL(start.location!);
    expect(`${to.origin}${to.pathname}`).toBe('https://accounts.larksuite.com/open-apis/authen/v1/authorize');
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: 'cli_login',
      response_type: 'code',
      redirect_uri: `https://${DOMAIN}/auth/lark/callback`,
      code_challenge_method: 'S256',
    });

    const cookie = await signIn('code-alice');
    const me = await call('/api/me', { cookie });

    expect(JSON.parse(me.body)).toEqual({ kind: 'user', id: 'on_alice', name: 'Alice', admin: false });
    expect(larkCalls).toEqual([
      'https://accounts.larksuite.com/oauth/v3/token',
      'https://open.larksuite.com/open-apis/authen/v1/user_info',
    ]);
  });

  it('refuses a callback whose state does not match the one it sent', async () => {
    const start = await call('/auth/lark/login');

    const done = await call('/auth/lark/callback?code=code-alice&state=forged', { cookie: start.cookies.join('; ') });

    expect(done.location).toBe('/?login_error=expired');
    expect(done.cookies.some((c) => c.startsWith('lcb_session=') && c.length > 'lcb_session='.length)).toBe(false);
  });

  it('asks the browser to sign in when there is no session', async () => {
    const res = await call('/api/profiles');

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ login: '/auth/lark/login' });
  });

  it('shows a person only their own bots, and answers for others like missing ones', async () => {
    const cookie = await signIn('code-alice');

    const list = JSON.parse((await call('/api/profiles', { cookie })).body);
    expect(list.profiles.map((p: { name: string }) => p.name)).toEqual(['alice-bot']);
    for (const path of ['/api/config?profile=bob-bot', '/api/config', '/api/anthropic?profile=bob-bot']) {
      expect((await call(path, { cookie })).status, path).toBe(404);
    }
    const startOthers = await call('/api/profiles/start', { method: 'POST', cookie, origin: true, body: { profile: 'bob-bot' } });
    expect(startOthers.status).toBe(404);
    const startOwn = await call('/api/profiles/start', { method: 'POST', cookie, origin: true, body: { profile: 'alice-bot' } });
    expect(startOwn.status).toBe(200);
  });

  it('keeps the deployment-wide settings to admins', async () => {
    const cookie = await signIn('code-alice');

    const res = await call('/api/profiles/activate', { method: 'POST', cookie, origin: true, body: { profile: 'alice-bot' } });

    expect(res.status).toBe(403);
  });

  it("refuses a signed-in browser's write that carries no Origin", async () => {
    const cookie = await signIn('code-alice');

    const res = await call('/api/profiles/start', { method: 'POST', cookie, body: { profile: 'alice-bot' } });

    expect(res.status).toBe(403);
  });

  it('lets listed admins and the console token see every bot', async () => {
    const carol = await signIn('code-carol');

    for (const auth of [{ cookie: carol }, { token: TOKEN }]) {
      const list = JSON.parse((await call('/api/profiles', auth)).body);
      expect(list.profiles.map((p: { name: string }) => p.name).sort()).toEqual(['admin-bot', 'alice-bot', 'bob-bot']);
    }
  });

  it('rejects a session cookie that was tampered with', async () => {
    const cookie = await signIn('code-alice');
    const [body, mac] = cookie.slice('lcb_session='.length).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'on_carol', name: 'Carol', exp: 4102444800 })).toString('base64url');

    expect((await call('/api/me', { cookie: `lcb_session=${forged}.${mac}` })).status).toBe(401);
    expect((await call('/api/me', { cookie: `lcb_session=${body}.${mac}x` })).status).toBe(401);
  });
});
