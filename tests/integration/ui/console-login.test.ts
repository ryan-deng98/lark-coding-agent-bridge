import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeLoginChecker } from '../../../src/agent/claude/login-status';
import type { ClaudeWebLoginStarter } from '../../../src/agent/claude/web-login';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import {
  loadConsoleSessionKey,
  resolveLoginConfig,
  type LarkFetch,
  type LoginConfig,
} from '../../../src/ui/console-auth';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const DOMAIN = 'bridge.up.railway.app';
const TOKEN = 't'.repeat(64);
const KEYSTORE_SECRET = 'k'.repeat(64);
const LOGIN_ENV = {
  LARK_CHANNEL_LOGIN_APP_ID: 'cli_login',
  LARK_CHANNEL_LOGIN_APP_SECRET: 's'.repeat(32),
  LARK_CHANNEL_LOGIN_TENANT: 'lark',
  LARK_CHANNEL_ADMINS: 'on_carol',
  LARK_CHANNEL_KEYSTORE_SECRET: KEYSTORE_SECRET,
};
const app = (id: string) => ({ id, secret: '${APP_SECRET}', tenant: 'lark' as const });
// Lark people, by the authorization code the fake Lark hands out for them.
const PEOPLE: Record<string, { union_id: string; name: string }> = {
  'code-alice': { union_id: 'on_alice', name: 'Alice' },
  'code-carol': { union_id: 'on_carol', name: 'Carol' },
};

// Lark documents only v2; its accounts.larksuite.com/oauth/v3/token turns real Lark codes down (invalid_grant).
const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/authen/v2/oauth/token';

let rootDir: string;
let handle: UiServerHandle;
let login: LoginConfig;
let larkCalls: string[];
let tokenRequests: { contentType: string; body: Record<string, string> }[];

const fakeLark: LarkFetch = async (url, init) => {
  larkCalls.push(url);
  const headers = init.headers as Record<string, string>;
  if (url === LARK_TOKEN_URL) {
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    tokenRequests.push({ contentType: headers['content-type'] ?? '', body });
    const code = body.code ?? '';
    return Response.json(
      PEOPLE[code]
        ? { code: 0, access_token: `at-${code}` }
        : { code: 20003, error: 'invalid_grant', error_description: 'The authorization code is not found.' },
    );
  }
  const token = String(headers.authorization).replace('Bearer at-', '');
  return Response.json({ code: 0, data: PEOPLE[token] });
};

// Stand-in for `claude auth login`: each attempt, and which config dirs it signed in.
interface ClaudeAttempt {
  dir: string;
  submitted: string[];
  cancelled: boolean;
}
let claudeAttempts: ClaudeAttempt[];
let signedInDirs: Set<string>;

const fakeClaudeWebLogin: ClaudeWebLoginStarter = async (dir) => {
  const attempt: ClaudeAttempt = { dir, submitted: [], cancelled: false };
  claudeAttempts.push(attempt);
  let settle = () => {};
  const closed = new Promise<void>((resolve) => (settle = resolve));
  return {
    url: 'https://claude.com/cai/oauth/authorize?code=true&state=s1',
    closed,
    cancel: () => {
      attempt.cancelled = true;
      settle();
    },
    submit: async (code) => {
      attempt.submitted.push(code);
      settle();
      if (code !== 'good-code#state') throw new Error('Login failed: Request failed with status code 400');
      signedInDirs.add(dir);
    },
  };
};

const fakeCheckClaudeLogin: ClaudeLoginChecker = async (dir) =>
  signedInDirs.has(dir)
    ? { loggedIn: true, authMethod: 'claude.ai', orgName: 'LibrAI', subscriptionType: 'team' }
    : { loggedIn: false };

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
  tokenRequests = [];
  claudeAttempts = [];
  signedInDirs = new Set();
  login = resolveLoginConfig({
    env: LOGIN_ENV,
    publicUrl: `https://${DOMAIN}/`,
    sessionKey: await loadConsoleSessionKey(rootDir),
    multiUser: true,
  })!;
  handle = await startUiServer({
    supervisor: supervisor(),
    version: 'test',
    rootDir,
    token: TOKEN,
    allowedHosts: [DOMAIN],
    login,
    larkFetch: fakeLark,
    claudeWebLogin: fakeClaudeWebLogin,
    checkClaudeLogin: fakeCheckClaudeLogin,
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
    expect(larkCalls).toEqual([LARK_TOKEN_URL, 'https://open.larksuite.com/open-apis/authen/v1/user_info']);
  });

  it('trades the code as JSON, with the redirect and the PKCE verifier the authorize request promised', async () => {
    const start = await call('/auth/lark/login');
    const authorize = new URL(start.location!);

    await call(`/auth/lark/callback?code=code-alice&state=${authorize.searchParams.get('state')}`, {
      cookie: start.cookies.join('; '),
    });

    expect(tokenRequests).toHaveLength(1);
    const [exchange] = tokenRequests;
    expect(exchange!.contentType).toBe('application/json; charset=utf-8');
    expect(exchange!.body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'cli_login',
      client_secret: LOGIN_ENV.LARK_CHANNEL_LOGIN_APP_SECRET,
      code: 'code-alice',
      redirect_uri: authorize.searchParams.get('redirect_uri'),
    });
    const challenge = createHash('sha256').update(exchange!.body.code_verifier ?? '').digest('base64url');
    expect(challenge).toBe(authorize.searchParams.get('code_challenge'));
  });

  it('sends the browser back with a failure when Lark turns the code down', async () => {
    const start = await call('/auth/lark/login');
    const state = new URL(start.location!).searchParams.get('state')!;

    const done = await call(`/auth/lark/callback?code=code-unknown&state=${state}`, { cookie: start.cookies.join('; ') });

    expect(done.location).toBe('/?login_error=failed');
    expect(done.cookies.some((c) => c.startsWith('lcb_session=') && c.length > 'lcb_session='.length)).toBe(false);
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

  it("won't take a session signed with the keystore secret an agent can see", async () => {
    // What a colleague's bot could compute from its own env before the fix.
    const key = createHmac('sha256', KEYSTORE_SECRET).update('lark-channel console session v1').digest();
    const body = Buffer.from(JSON.stringify({ sub: 'on_carol', name: 'Carol', exp: 4102444800 })).toString('base64url');
    const forged = `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;

    expect((await call('/api/me', { cookie: `lcb_session=${forged}` })).status).toBe(401);
  });

  it('keeps the session key in a root-only file that survives restarts', async () => {
    const again = await loadConsoleSessionKey(rootDir);

    expect(again.equals(login.sessionKey)).toBe(true);
    expect((await stat(join(rootDir, 'console-session.key'))).mode & 0o777).toBe(0o600);
  });

  it('refuses sign-in unless each bot runs as its own OS user', () => {
    expect(() =>
      resolveLoginConfig({ env: LOGIN_ENV, publicUrl: `https://${DOMAIN}/`, sessionKey: login.sessionKey, multiUser: false }),
    ).toThrow(/multi-user mode/);
  });

  it('turns away people of another tenant when the tenant is pinned', async () => {
    await handle.close();
    handle = await startUiServer({
      supervisor: supervisor(),
      version: 'test',
      rootDir,
      token: TOKEN,
      allowedHosts: [DOMAIN],
      login: { ...login, tenantKey: 'tenant-librai' },
      larkFetch: async (url, init) => {
        const res = await fakeLark(url, init);
        if (!url.endsWith('/user_info')) return res;
        const json = (await res.json()) as { code: number; data: object };
        return Response.json({ ...json, data: { ...json.data, tenant_key: 'tenant-elsewhere' } });
      },
    });
    const start = await call('/auth/lark/login');
    const state = new URL(start.location!).searchParams.get('state')!;

    const done = await call(`/auth/lark/callback?code=code-alice&state=${state}`, { cookie: start.cookies.join('; ') });

    expect(done.location).toBe('/?login_error=failed');
  });

  it('rejects a session cookie that was tampered with', async () => {
    const cookie = await signIn('code-alice');
    const [body, mac] = cookie.slice('lcb_session='.length).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'on_carol', name: 'Carol', exp: 4102444800 })).toString('base64url');

    expect((await call('/api/me', { cookie: `lcb_session=${forged}.${mac}` })).status).toBe(401);
    expect((await call('/api/me', { cookie: `lcb_session=${body}.${mac}x` })).status).toBe(401);
  });
});

describe("connecting a bot to its owner's Claude account from the page", () => {
  const start = (cookie: string, profile: string) =>
    call('/api/anthropic/claude-login/start', { method: 'POST', cookie, origin: true, body: { profile } });
  const finish = (cookie: string, body: object) =>
    call('/api/anthropic/claude-login/finish', { method: 'POST', cookie, origin: true, body });

  it("signs a person's own bot in to their own Claude account", async () => {
    const alice = await signIn('code-alice');

    const started = await start(alice, 'alice-bot');
    const { sessionId, url } = JSON.parse(started.body);
    const done = await finish(alice, { profile: 'alice-bot', sessionId, code: 'good-code#state' });

    expect(url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=s1');
    expect(claudeAttempts.map((a) => a.dir)).toEqual([join(rootDir, 'profiles', 'alice-bot', 'claude-code')]);
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body)).toMatchObject({ connected: true, mode: 'claude-login', accountHint: 'LibrAI · team' });
    const account = JSON.parse((await call('/api/anthropic?profile=alice-bot', { cookie: alice })).body);
    expect(account).toMatchObject({ connected: true, mode: 'claude-login' });
  });

  it("won't start or finish a sign-in for someone else's bot", async () => {
    const alice = await signIn('code-alice');
    const carol = await signIn('code-carol');

    expect((await start(alice, 'bob-bot')).status).toBe(404);
    const { sessionId } = JSON.parse((await start(carol, 'alice-bot')).body);
    const taken = await finish(alice, { profile: 'alice-bot', sessionId, code: 'good-code#state' });

    expect(taken.status).toBe(404);
    expect(claudeAttempts[0]?.submitted).toEqual([]);
  });

  it("says why a code didn't work, and the attempt is used up", async () => {
    const alice = await signIn('code-alice');
    const { sessionId } = JSON.parse((await start(alice, 'alice-bot')).body);

    const first = await finish(alice, { profile: 'alice-bot', sessionId, code: 'stale-code#state' });
    const again = await finish(alice, { profile: 'alice-bot', sessionId, code: 'good-code#state' });

    expect(first.status).toBe(400);
    expect(JSON.parse(first.body).error).toMatch(/status code 400/);
    expect(again.status).toBe(404);
  });

  it("keeps a pasted code that can't be one away from Claude Code, and lets them paste again", async () => {
    const alice = await signIn('code-alice');
    const { sessionId } = JSON.parse((await start(alice, 'alice-bot')).body);

    const garbled = await finish(alice, { profile: 'alice-bot', sessionId, code: 'good-code#state\n/logout' });
    expect(garbled.status).toBe(422);
    expect(claudeAttempts[0]?.submitted).toEqual([]);

    const retried = await finish(alice, { profile: 'alice-bot', sessionId, code: 'good-code#state' });
    expect(retried.status).toBe(200);
  });

  it('drops an attempt that is cancelled, or replaced by a newer one', async () => {
    const alice = await signIn('code-alice');
    const first = JSON.parse((await start(alice, 'alice-bot')).body);
    const second = JSON.parse((await start(alice, 'alice-bot')).body);

    const cancelled = await call('/api/anthropic/claude-login/cancel', {
      method: 'POST',
      cookie: alice,
      origin: true,
      body: { profile: 'alice-bot', sessionId: second.sessionId },
    });

    expect(cancelled.status).toBe(200);
    expect(claudeAttempts.map((a) => a.cancelled)).toEqual([true, true]);
    const late = await finish(alice, { profile: 'alice-bot', sessionId: first.sessionId, code: 'good-code#state' });
    expect(late.status).toBe(404);
  });
});
