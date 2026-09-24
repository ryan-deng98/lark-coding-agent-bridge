import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../core/logger';
import { checkToken } from './http';

/**
 * Per-person sign-in for a shared console: "Sign in with Lark" (OAuth
 * authorization code + PKCE against a login app the admin creates). A signed,
 * HttpOnly session cookie then identifies the person, and the console shows
 * them only the bots they created. Holders of the console token stay admins.
 * Only the person's identity is kept — never their Lark token.
 */

export const LOGIN_APP_ID_ENV = 'LARK_CHANNEL_LOGIN_APP_ID';
export const LOGIN_APP_SECRET_ENV = 'LARK_CHANNEL_LOGIN_APP_SECRET';
export const LOGIN_TENANT_ENV = 'LARK_CHANNEL_LOGIN_TENANT';
export const ADMINS_ENV = 'LARK_CHANNEL_ADMINS';
export const LOGIN_PATH = '/auth/lark/login';
export const CALLBACK_PATH = '/auth/lark/callback';
export const LOGOUT_PATH = '/auth/logout';

const SESSION_COOKIE = 'lcb_session';
const STATE_COOKIE = 'lcb_oauth';
const SESSION_TTL_S = 7 * 24 * 3600;
const STATE_TTL_S = 10 * 60;
const LARK_TIMEOUT_MS = 10_000;

export type LoginTenant = 'lark' | 'feishu';

export interface LoginConfig {
  appId: string;
  appSecret: string;
  tenant: LoginTenant;
  /** Lark union_ids treated as admins when they sign in. */
  admins: ReadonlySet<string>;
  /** Signs session and OAuth-state cookies. */
  sessionKey: Buffer;
  /** Where Lark sends people back, e.g. https://bridge.up.railway.app/auth/lark/callback */
  redirectUri: string;
}

export type Principal =
  | { kind: 'token' }
  | { kind: 'user'; id: string; name: string; admin: boolean };

export function isAdmin(principal: Principal): boolean {
  return principal.kind === 'token' || principal.admin;
}

export interface LoginEnv {
  env?: NodeJS.ProcessEnv;
  /** The console's public base URL (sign-in only makes sense behind one). */
  publicUrl?: string;
}

/**
 * Sign-in config from the environment, or undefined when it isn't set up.
 * Half a config (an app id without its secret, no public URL, no keystore
 * secret to sign sessions with) is a startup error rather than a silent no.
 */
export function resolveLoginConfig({ env = process.env, publicUrl }: LoginEnv = {}): LoginConfig | undefined {
  const appId = env[LOGIN_APP_ID_ENV]?.trim();
  const appSecret = env[LOGIN_APP_SECRET_ENV]?.trim();
  if (!appId && !appSecret) return undefined;
  if (!appId || !appSecret) {
    throw new Error(`Lark sign-in needs both ${LOGIN_APP_ID_ENV} and ${LOGIN_APP_SECRET_ENV}`);
  }
  if (!publicUrl) throw new Error('Lark sign-in needs the console behind a public domain');
  const seed = env.LARK_CHANNEL_KEYSTORE_SECRET?.trim();
  if (!seed) throw new Error('Lark sign-in needs LARK_CHANNEL_KEYSTORE_SECRET to sign sessions');
  const tenantRaw = env[LOGIN_TENANT_ENV]?.trim() || 'feishu';
  if (tenantRaw !== 'lark' && tenantRaw !== 'feishu') {
    throw new Error(`${LOGIN_TENANT_ENV} must be lark or feishu, got "${tenantRaw}"`);
  }
  const admins = new Set(
    (env[ADMINS_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return {
    appId,
    appSecret,
    tenant: tenantRaw,
    admins,
    sessionKey: createHmac('sha256', seed).update('lark-channel console session v1').digest(),
    redirectUri: new URL(CALLBACK_PATH, publicUrl).toString(),
  };
}

/** Who is calling: the console token (admin), a signed-in person, or nobody. */
export function principalFor(
  req: IncomingMessage,
  url: URL,
  token: string,
  login: LoginConfig | undefined,
): Principal | undefined {
  if (checkToken(req, url, token)) return { kind: 'token' };
  if (!login) return undefined;
  const session = verify<{ sub: string; name: string }>(readCookie(req, SESSION_COOKIE), login.sessionKey);
  if (!session || typeof session.sub !== 'string' || !session.sub) return undefined;
  return { kind: 'user', id: session.sub, name: session.name || session.sub, admin: login.admins.has(session.sub) };
}

/** Send the browser to Lark's consent page, remembering state + PKCE verifier in a signed cookie. */
export function startLogin(res: ServerResponse, login: LoginConfig): void {
  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  setCookie(res, STATE_COOKIE, sign({ state, verifier }, login.sessionKey, STATE_TTL_S), STATE_TTL_S);
  const authorize = new URL(`https://${domains(login.tenant).accounts}/open-apis/authen/v1/authorize`);
  authorize.searchParams.set('client_id', login.appId);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', login.redirectUri);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  authorize.searchParams.set('code_challenge_method', 'S256');
  redirect(res, authorize.toString());
}

export type LarkFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Lark's redirect back: check the state, trade the code for a token, read
 * who the person is, and give them a session cookie. Failures land back on
 * the console with a short reason.
 */
export async function finishLogin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  login: LoginConfig,
  fetchImpl: LarkFetch = fetch,
): Promise<void> {
  const pending = verify<{ state: string; verifier: string }>(readCookie(req, STATE_COOKIE), login.sessionKey);
  clearCookie(res, STATE_COOKIE);
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) return redirect(res, '/?login_error=denied');
  if (!pending || !sameString(url.searchParams.get('state') ?? '', pending.state)) {
    return redirect(res, '/?login_error=expired');
  }
  try {
    const accessToken = await exchangeCode(login, code, pending.verifier, fetchImpl);
    const person = await fetchPerson(login, accessToken, fetchImpl);
    setCookie(
      res,
      SESSION_COOKIE,
      sign({ sub: person.unionId, name: person.name }, login.sessionKey, SESSION_TTL_S),
      SESSION_TTL_S,
    );
    log.info('ui', 'console-login', { user: person.unionId.slice(-6) });
    redirect(res, '/');
  } catch (err) {
    log.warn('ui', 'console-login-failed', { err: err instanceof Error ? err.message : String(err) });
    redirect(res, '/?login_error=failed');
  }
}

export function logout(res: ServerResponse): void {
  clearCookie(res, SESSION_COOKIE);
}

async function exchangeCode(login: LoginConfig, code: string, verifier: string, fetchImpl: LarkFetch): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: login.appId,
    client_secret: login.appSecret,
    code,
    redirect_uri: login.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetchImpl(`https://${domains(login.tenant).accounts}/oauth/v3/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: number; access_token?: string; error?: string };
  if (json.code !== 0 || !json.access_token) {
    throw new Error(`token exchange failed: ${json.error ?? `code ${json.code ?? res.status}`}`);
  }
  return json.access_token;
}

async function fetchPerson(
  login: LoginConfig,
  accessToken: string,
  fetchImpl: LarkFetch,
): Promise<{ unionId: string; name: string }> {
  const res = await fetchImpl(`https://${domains(login.tenant).open}/open-apis/authen/v1/user_info`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as {
    code?: number;
    data?: { union_id?: string; name?: string };
  };
  const unionId = json.data?.union_id;
  if (json.code !== 0 || !unionId) throw new Error(`user_info failed: code ${json.code ?? res.status}`);
  return { unionId, name: json.data?.name || unionId };
}

function domains(tenant: LoginTenant): { accounts: string; open: string } {
  return tenant === 'lark'
    ? { accounts: 'accounts.larksuite.com', open: 'open.larksuite.com' }
    : { accounts: 'accounts.feishu.cn', open: 'open.feishu.cn' };
}

function sign(payload: Record<string, unknown>, key: Buffer, ttlSeconds: number): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  ).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

function verify<T>(value: string | undefined, key: Buffer): (T & { exp: number }) | undefined {
  if (!value) return undefined;
  const [body, mac] = value.split('.');
  if (!body || !mac) return undefined;
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000 ? payload : undefined;
  } catch {
    return undefined;
  }
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function setCookie(res: ServerResponse, name: string, value: string, maxAgeSeconds: number): void {
  const cookie = `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  const existing = res.getHeader('set-cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('set-cookie', [...list, cookie]);
}

function clearCookie(res: ServerResponse, name: string): void {
  setCookie(res, name, '', 0);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}
