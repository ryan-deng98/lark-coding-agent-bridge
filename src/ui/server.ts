import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { log } from '../core/logger';
import { readActiveProfile } from '../config/profile-store';
import type { MutableProfileState } from '../config/config-ops';
import { checkClaudeLogin } from '../agent/claude/login-status';
import { normalizeClaudeLoginCode, startClaudeWebLogin } from '../agent/claude/web-login';
import {
  AnthropicAccountError,
  connectAnthropicAccount,
  connectClaudeLogin,
  disconnectAnthropicAccount,
  openClaudeWebLogin,
  readAnthropicAccount,
} from '../config/anthropic-account';
import { ClaudeLoginSessions } from './claude-login-sessions';
import consoleHtml from './generated/index.html';
import {
  addBotToChatView,
  meetingJoin,
  meetingPreflight,
  meetingLeave,
  meetingsView,
  applyConfig,
  applyConfigToDisk,
  buildConfigView,
  listChats,
  loadProfileState,
  mutateAccess,
  userAuthStatus,
  userChatsView,
  userLoginComplete,
  userLoginStart,
} from './api';
import { activateProfile, listBots, listProfiles } from './fleet';
import { onboardCreate, onboardState, onboardValidate } from './onboard';
import { finishQrRegistration, qrStatus, startQrRegistration } from './qr-register';
import {
  HttpError,
  isAllowedHostRequest,
  readJsonBody,
  sendHtml,
  sendJson,
} from './http';
import {
  CALLBACK_PATH,
  finishLogin,
  isAdmin,
  LOGIN_PATH,
  LOGOUT_PATH,
  logout,
  principalFor,
  startLogin,
  type Principal,
} from './console-auth';
import { authorizedProfile, canSee, ownerFor, requireAdmin, visibleProfiles } from './console-access';
import { setAutostart } from '../runtime/autostart';
import { resolveAppPaths } from '../config/app-paths';
import type { Controls } from '../commands';
import type { UiServerDeps, UiServerHandle, UiSupervisor } from './types';

const DEFAULT_HOST = '127.0.0.1';

/**
 * Start the supervisor's single management console. Binds 127.0.0.1, mints a
 * random per-process token gating every `/api/*` call, rejects non-localhost /
 * cross-origin. A cloud deployment passes its bind host, a pinned token and its
 * public domain instead (see `resolveUiExposure`). Backed by the supervisor: it
 * can list/start/stop/configure any profile in-process (online → live; offline
 * → written to disk).
 */
export async function startUiServer(deps: UiServerDeps): Promise<UiServerHandle> {
  const host = deps.host ?? DEFAULT_HOST;
  const token = deps.token ?? randomBytes(32).toString('hex');
  const allowedHosts: ReadonlySet<string> = new Set(deps.allowedHosts?.map((h) => h.toLowerCase()));

  const server = createServer((req, res) => {
    handle(req, res, deps, token, allowedHosts).catch((err) => {
      log.warn('ui', 'request-failed', { err: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? 0, host, () => resolve((server.address() as AddressInfo).port));
  });

  const url = `http://${host}:${port}/?token=${token}`;
  log.info('ui', 'listening', { url: `http://${host}:${port}` });

  return {
    url,
    token,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiServerDeps,
  token: string,
  allowedHosts: ReadonlySet<string>,
): Promise<void> {
  if (!isAllowedHostRequest(req, allowedHosts)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Sign-in with Lark (a shared console); ahead of the API gate.
  if ((path === LOGIN_PATH || path === CALLBACK_PATH) && method === 'GET') {
    if (!deps.login) sendJson(res, 404, { error: 'not found' });
    else if (path === LOGIN_PATH) startLogin(res, deps.login);
    else await finishLogin(req, res, url, deps.login, deps.larkFetch);
    return;
  }
  if (path === LOGOUT_PATH && method === 'POST') {
    logout(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!path.startsWith('/api/')) {
    if (path === '/' || path === '/index.html') sendHtml(res, consoleHtml);
    else sendJson(res, 404, { error: 'not found' });
    return;
  }

  const principal = principalFor(req, url, token, deps.login);
  if (!principal) {
    sendJson(res, 401, { error: 'unauthorized', ...(deps.login ? { login: LOGIN_PATH } : {}) });
    return;
  }
  // A signed-in browser's writes must carry our Origin: SameSite=Lax already
  // keeps other sites' requests cookie-less, this is the second lock.
  if (principal.kind === 'user' && method !== 'GET' && !req.headers.origin) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  try {
    await route(req, res, deps, url, principal);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }
}

// Who started each QR registration: only they may poll or finish it.
const qrStartedBy = new Map<string, string>();
// Claude sign-ins started from the page, likewise bound to whoever started them.
const claudeLogins = new ClaudeLoginSessions();

function principalKey(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.id}` : 'token';
}

function assertOwnQrSession(sessionId: string, principal: Principal): void {
  const startedBy = qrStartedBy.get(sessionId);
  if (startedBy !== undefined && startedBy !== principalKey(principal) && !isAdmin(principal)) {
    throw new HttpError(404, 'qr session not found or expired');
  }
}

/** Surface account refusals (bad key, wrong profile) as a 400 with their reason. */
async function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AnthropicAccountError) throw new HttpError(400, err.message);
    throw err;
  }
}

function requireProfile(value: unknown): string {
  const profile = typeof value === 'string' ? value.trim() : '';
  if (!profile) throw new HttpError(400, 'profile is required');
  return profile;
}

/**
 * Apply an account change to a running bot — credentials are resolved only when
 * a profile (re)starts. A failed restart is reported, not fatal: the change is
 * already saved and applies on the next start.
 */
async function restartIfOnline(
  sup: UiSupervisor,
  profile: string,
): Promise<{ restarted: boolean; restartError?: string }> {
  if (!sup.isOnline(profile)) return { restarted: false };
  try {
    await sup.restartProfile(profile);
    return { restarted: true };
  } catch (err) {
    log.warn('ui', 'anthropic-restart-failed', { profile, err: String(err) });
    return { restarted: false, restartError: err instanceof Error ? err.message : String(err) };
  }
}

/** Resolve the target profile's state + whether edits apply live (online). */
async function resolveTargetState(
  deps: UiServerDeps,
  url: URL,
  principal: Principal,
): Promise<{ state: MutableProfileState; live: boolean; controls?: Controls }> {
  const profile = await authorizedProfile(principal, url.searchParams.get('profile'), deps.rootDir);
  const controls = deps.supervisor.controlsFor(profile);
  if (controls) return { state: controls, live: true, controls };
  return { state: await loadProfileState(profile, deps.rootDir), live: false };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiServerDeps,
  url: URL,
  principal: Principal,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const g = method === 'GET';
  const p = method === 'POST';
  const sup = deps.supervisor;
  const rootDir = resolveAppPaths({ rootDir: deps.rootDir }).rootDir;
  const own = (profile: string | null | undefined) => authorizedProfile(principal, profile, deps.rootDir);

  if (path === '/api/me' && g) {
    sendJson(
      res,
      200,
      principal.kind === 'user'
        ? { kind: 'user', id: principal.id, name: principal.name, admin: principal.admin }
        : { kind: 'token', admin: true },
    );
    return;
  }

  if (path === '/api/status' && g) {
    const visible = await visibleProfiles(principal, deps.rootDir);
    const activeProfile = await readActiveProfile(deps.rootDir);
    sendJson(res, 200, {
      hosted: true,
      version: deps.version,
      ...(activeProfile && canSee(visible, activeProfile) ? { activeProfile } : {}),
      online: sup.list().filter((m) => canSee(visible, m.profile)).length,
    });
    return;
  }

  // --- online channels ---
  if (path === '/api/bots' && g) {
    const visible = await visibleProfiles(principal, deps.rootDir);
    sendJson(res, 200, {
      bots: listBots(sup, deps.version, Date.now()).filter((b) => canSee(visible, b.profileName)),
    });
    return;
  }

  // --- profiles ---
  if (path === '/api/profiles' && g) {
    const visible = await visibleProfiles(principal, deps.rootDir);
    sendJson(res, 200, {
      profiles: (await listProfiles(sup, deps.rootDir)).filter((pr) => canSee(visible, pr.name)),
    });
    return;
  }
  if (path === '/api/profiles/start' && p) {
    const body = (await readJsonBody(req)) as { profile?: string };
    if (!body.profile) throw new HttpError(400, 'profile is required');
    const profile = await own(body.profile);
    try {
      await sup.startProfile(profile);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    // Brought back after a restart until someone stops it.
    await setAutostart(rootDir, profile, true);
    sendJson(res, 200, { ok: true, profile });
    return;
  }
  if (path === '/api/profiles/stop' && p) {
    const body = (await readJsonBody(req)) as { profile?: string };
    if (!body.profile) throw new HttpError(400, 'profile is required');
    const profile = await own(body.profile);
    await sup.stopProfile(profile);
    await setAutostart(rootDir, profile, false);
    sendJson(res, 200, { ok: true, profile });
    return;
  }
  if (path === '/api/profiles/activate' && p) {
    // The deployment's active profile is the admin's to pick.
    requireAdmin(principal);
    const body = (await readJsonBody(req)) as { profile?: string };
    if (!body.profile) throw new HttpError(400, 'profile is required');
    sendJson(res, 200, await activateProfile(body.profile, deps.rootDir));
    return;
  }
  if (path === '/api/profiles/validate' && p) {
    sendJson(res, 200, await onboardValidate(await readJsonBody(req)));
    return;
  }
  if (path === '/api/profiles/qr/start' && p) {
    const started = await startQrRegistration(deps.rootDir);
    qrStartedBy.set(started.sessionId, principalKey(principal));
    sendJson(res, 200, started);
    return;
  }
  if (path === '/api/profiles/qr/status' && g) {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) throw new HttpError(400, 'sessionId is required');
    assertOwnQrSession(sessionId, principal);
    sendJson(res, 200, qrStatus(sessionId));
    return;
  }
  if (path === '/api/profiles/qr/finish' && p) {
    const body = await readJsonBody(req);
    assertOwnQrSession(String((body as { sessionId?: unknown })?.sessionId ?? ''), principal);
    const owner = ownerFor(principal);
    sendJson(
      res,
      200,
      await finishQrRegistration(body, deps.rootDir, {
        validateAnthropicApiKey: deps.validateAnthropicApiKey,
        ...(owner ? { owner } : {}),
      }),
    );
    return;
  }
  if (path === '/api/profiles' && p) {
    const owner = ownerFor(principal);
    sendJson(res, 200, await onboardCreate(await readJsonBody(req), deps.rootDir, owner ? { owner } : {}));
    return;
  }
  if (path === '/api/onboard/state' && g) {
    const state = await onboardState(deps.rootDir);
    if (isAdmin(principal)) {
      sendJson(res, 200, state);
      return;
    }
    // Someone with no bot of their own yet gets the first-bot wizard.
    const visible = await visibleProfiles(principal, deps.rootDir);
    const profiles = state.profiles.filter((name) => canSee(visible, name));
    sendJson(res, 200, { ...state, hasConfig: profiles.length > 0, profiles, activeProfile: undefined });
    return;
  }

  // --- the bot's own Anthropic account (Claude profiles) ---
  if (path === '/api/anthropic' && g) {
    const profile = await own(url.searchParams.get('profile'));
    const view = await asBadRequest(() => readAnthropicAccount(profile, deps.rootDir));
    // Bots without their own account run on the deployment's key, when there is one.
    sendJson(res, 200, { ...view, companyKey: Boolean(process.env.ANTHROPIC_API_KEY) });
    return;
  }
  if (path === '/api/anthropic/connect' && p) {
    const body = (await readJsonBody(req)) as { profile?: unknown; apiKey?: unknown };
    const profile = await own(requireProfile(body.profile));
    const view = await asBadRequest(() =>
      connectAnthropicAccount({ profile, apiKey: body.apiKey }, deps.rootDir, {
        validate: deps.validateAnthropicApiKey,
      }),
    );
    sendJson(res, 200, { ...view, ...(await restartIfOnline(sup, profile)) });
    return;
  }
  // Checks as the bot's own user (the second argument), never as root.
  const checkLogin = deps.checkClaudeLogin ?? checkClaudeLogin;
  if (path === '/api/anthropic/connect-login' && p) {
    const body = (await readJsonBody(req)) as { profile?: unknown };
    const profile = await own(requireProfile(body.profile));
    const view = await asBadRequest(() => connectClaudeLogin({ profile }, deps.rootDir, { checkLogin }));
    sendJson(res, 200, { ...view, ...(await restartIfOnline(sup, profile)) });
    return;
  }
  // Signing the bot in from the page: the sign-in address goes to the browser,
  // the code from Anthropic's page comes back and is typed into Claude Code.
  if (path === '/api/anthropic/claude-login/start' && p) {
    const body = (await readJsonBody(req)) as { profile?: unknown };
    const profile = await own(requireProfile(body.profile));
    const start = deps.claudeWebLogin ?? startClaudeWebLogin;
    sendJson(
      res,
      200,
      await claudeLogins.start(profile, principalKey(principal), () =>
        asBadRequest(() => openClaudeWebLogin({ profile }, deps.rootDir, start)),
      ),
    );
    return;
  }
  if (path === '/api/anthropic/claude-login/finish' && p) {
    const body = (await readJsonBody(req)) as { profile?: unknown; sessionId?: unknown; code?: unknown };
    const profile = await own(requireProfile(body.profile));
    const code = normalizeClaudeLoginCode(body.code);
    // 422: the attempt is still open, the person can paste again.
    if (!code.ok) throw new HttpError(422, code.reason);
    const login = claudeLogins.claim(String(body.sessionId ?? ''), profile, principalKey(principal));
    try {
      await login.submit(code.code);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('ui', 'claude-web-login-failed', { profile, err: reason });
      throw new HttpError(400, `Claude 登录没有成功（${reason}）。请重新点「连接我的 Claude 账号」`);
    }
    const view = await asBadRequest(() => connectClaudeLogin({ profile }, deps.rootDir, { checkLogin }));
    sendJson(res, 200, { ...view, ...(await restartIfOnline(sup, profile)) });
    return;
  }
  if (path === '/api/anthropic/claude-login/cancel' && p) {
    const body = (await readJsonBody(req)) as { profile?: unknown; sessionId?: unknown };
    const profile = await own(requireProfile(body.profile));
    claudeLogins.cancel(String(body.sessionId ?? ''), profile, principalKey(principal));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/anthropic/disconnect' && p) {
    const body = (await readJsonBody(req)) as { profile?: unknown };
    const profile = await own(requireProfile(body.profile));
    const view = await asBadRequest(() => disconnectAnthropicAccount({ profile }, deps.rootDir));
    sendJson(res, 200, { ...view, ...(await restartIfOnline(sup, profile)) });
    return;
  }

  // --- per-profile config ---
  if (path === '/api/config' && g) {
    const { state, live } = await resolveTargetState(deps, url, principal);
    sendJson(res, 200, buildConfigView(state, live));
    return;
  }
  if (path === '/api/config' && p) {
    const { state, live, controls } = await resolveTargetState(deps, url, principal);
    const body = await readJsonBody(req);
    sendJson(res, 200, live && controls ? await applyConfig(controls, body) : await applyConfigToDisk(state, body));
    return;
  }
  if (path === '/api/access' && p) {
    const { state } = await resolveTargetState(deps, url, principal);
    sendJson(res, 200, await mutateAccess(state, await readJsonBody(req)));
    return;
  }
  if (path === '/api/chats' && g) {
    const profile = await own(url.searchParams.get('profile'));
    sendJson(res, 200, await listChats(sup.channelFor(profile)));
    return;
  }

  // --- "我的群": owner's groups via user identity (lark-cli device-flow auth) ---
  if (path === '/api/auth/status' && g) {
    const profile = await own(url.searchParams.get('profile'));
    sendJson(res, 200, await userAuthStatus(profile, deps.rootDir));
    return;
  }
  if (path === '/api/auth/login/start' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; scopes?: unknown };
    const profile = await own(body.profile);
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === 'string')
      : undefined;
    sendJson(res, 200, await userLoginStart(profile, deps.rootDir, scopes));
    return;
  }
  if (path === '/api/auth/login/complete' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; deviceCode?: string };
    const profile = await own(body.profile);
    sendJson(res, 200, await userLoginComplete(profile, deps.rootDir, body));
    return;
  }
  if (path === '/api/user-chats' && g) {
    const profile = await own(url.searchParams.get('profile'));
    const query = url.searchParams.get('query') ?? undefined;
    const pageToken = url.searchParams.get('pageToken') ?? undefined;
    sendJson(res, 200, await userChatsView(profile, deps.rootDir, sup.channelFor(profile), { query, pageToken }));
    return;
  }
  if (path === '/api/chats/add-bot' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; chatId?: string };
    const profile = await own(body.profile);
    sendJson(res, 200, await addBotToChatView(profile, deps.rootDir, body));
    return;
  }

  // --- in-meeting agent (智能体入会) ---
  if (path === '/api/meetings' && g) {
    const profile = await own(url.searchParams.get('profile'));
    const controls = sup.controlsFor(profile);
    // Falls back to disk config so a stopped profile still reports why it's
    // unavailable rather than looking broken.
    const enabled = controls
      ? controls.profileConfig.meeting.enabled
      : (await loadProfileState(profile, deps.rootDir)).profileConfig.meeting.enabled;
    sendJson(res, 200, meetingsView(controls?.meeting, enabled));
    return;
  }
  if (path === '/api/meetings/preflight' && g) {
    const profile = await own(url.searchParams.get('profile'));
    // The probe needs some user open_id; the bot owner is the natural choice.
    const probeUserId = sup.controlsFor(profile)?.botOwnerId;
    sendJson(res, 200, await meetingPreflight(profile, deps.rootDir, probeUserId));
    return;
  }
  if (path === '/api/meetings/join' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; meetingNo?: string };
    const profile = await own(body.profile);
    sendJson(res, 200, await meetingJoin(sup.controlsFor(profile)?.meeting, body));
    return;
  }
  if (path === '/api/meetings/leave' && p) {
    const body = (await readJsonBody(req)) as { profile?: string; meetingId?: string };
    const profile = await own(body.profile);
    sendJson(res, 200, await meetingLeave(sup.controlsFor(profile)?.meeting, body));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
