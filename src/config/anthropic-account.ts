import { join } from 'node:path';
import type { ClaudeLoginChecker, ClaudeLoginStatus } from '../agent/claude/login-status';
import type { ClaudeWebLogin, ClaudeWebLoginStarter } from '../agent/claude/web-login';
import { botUserFor, ensureBotUser, type BotUser } from '../runtime/bot-user';
import { validateAnthropicApiKey, type AnthropicKeyValidation } from '../utils/anthropic-auth';
import { resolveAppPaths, type AppPaths } from './app-paths';
import { getSecret, removeSecret, setSecret, type KeystorePaths } from './keystore';
import type { AnthropicAccountConfig, AnthropicAuthMode, ProfileConfig } from './profile-schema';
import { loadRootConfig, saveRootConfig, withConfigFileLock } from './profile-store';
import type { AppConfig } from './schema';
import { resolveSecret } from './secret-resolver';

/** Keystore entry holding a bot's Anthropic key (each profile has its own keystore). */
export const ANTHROPIC_API_KEY_SECRET_ID = 'anthropic-api-key';

const MAX_KEY_LENGTH = 512;

/** A user-facing refusal (bad input, wrong profile, key rejected); the console answers 400. */
export class AnthropicAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicAccountError';
  }
}

export type AnthropicKeyInput = { ok: true; apiKey: string } | { ok: false; reason: string };

export interface AnthropicAccountView {
  connected: boolean;
  /** Set for the Claude-login mode; absent = API key. */
  mode?: AnthropicAuthMode;
  keyHint?: string;
  accountHint?: string;
  connectedAt?: string;
  /** Console only: the command that signs this bot's own Claude Code dir in. */
  loginCommand?: string;
}

export type AnthropicKeyValidator = (apiKey: string) => Promise<AnthropicKeyValidation>;

/**
 * Trim a pasted key and turn away the credentials people confuse with a
 * Console API key. Subscription OAuth tokens are refused on purpose: a bot
 * service must not collect or store Claude.ai credentials.
 */
export function normalizeAnthropicApiKeyInput(raw: unknown): AnthropicKeyInput {
  const apiKey = typeof raw === 'string' ? raw.trim() : '';
  if (!apiKey) return { ok: false, reason: '请填写 Anthropic API key' };
  if (/\s/.test(apiKey)) return { ok: false, reason: 'API key 不能包含空白字符' };
  if (apiKey.length > MAX_KEY_LENGTH) return { ok: false, reason: 'API key 长度异常，请检查是否复制完整' };
  if (apiKey.startsWith('sk-ant-oat')) {
    return {
      ok: false,
      reason: '这是 Claude 订阅的 OAuth token，不是 API key。请到 Claude Console（platform.claude.com）创建 API key',
    };
  }
  if (apiKey.startsWith('sk-ant-admin')) {
    return { ok: false, reason: '这是 Admin API key，不能用来调用模型，请创建普通 API key' };
  }
  return { ok: true, apiKey };
}

/** `sk-ant-…WXYZ` — enough to tell keys apart, never enough to use one. */
export function maskAnthropicApiKey(apiKey: string): string {
  if (apiKey.length < 16) return '••••';
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`;
}

export function anthropicAccountView(profile: Pick<ProfileConfig, 'anthropic'>): AnthropicAccountView {
  const account = profile.anthropic;
  if (!account) return { connected: false };
  const connectedAt = account.connectedAt ? { connectedAt: account.connectedAt } : {};
  if (account.mode === 'claude-login') {
    return {
      connected: true,
      mode: 'claude-login',
      ...(account.accountHint ? { accountHint: account.accountHint } : {}),
      ...connectedAt,
    };
  }
  return { connected: true, ...(account.keyHint ? { keyHint: account.keyHint } : {}), ...connectedAt };
}

/** The on-disk account state of one profile (the console's source of truth). */
export async function readAnthropicAccount(profile: string, rootDir?: string): Promise<AnthropicAccountView> {
  const appPaths = profilePaths(profile, rootDir);
  const root = await loadRootConfig(appPaths.configFile);
  const current = root?.profiles[appPaths.profile];
  if (!current) throw new AnthropicAccountError(`profile 不存在：${appPaths.profile}`);
  const botUser = botUserFor(appPaths.rootDir, appPaths.profile) ?? (await ensureBotUser(appPaths));
  return {
    ...anthropicAccountView(current),
    loginCommand: claudeLoginCommand(claudeLoginDir(appPaths), botUser),
  };
}

/** The bot's own Claude Code config dir: its login, sessions and settings. */
export function claudeLoginDir(appPaths: Pick<AppPaths, 'profileDir'>): string {
  return join(appPaths.profileDir, 'claude-code');
}

/**
 * What the user runs to sign the bot in — Anthropic's own flow, never the
 * bridge's. In multi-user mode it runs as the bot's user with a clean env, so
 * the credentials it writes are the bot's and no bridge secret leaks into it.
 */
export function claudeLoginCommand(claudeConfigDir: string, botUser?: BotUser): string {
  const login = `CLAUDE_CONFIG_DIR=${shellQuote(claudeConfigDir)} claude auth login`;
  if (!botUser) return login;
  return `setpriv --reuid=${botUser.uid} --regid=${botUser.gid} --clear-groups --reset-env env ${login}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start signing a Claude profile's own Claude Code dir in from the console
 * (Anthropic's `claude auth login`, see startClaudeWebLogin), as the bot's own
 * user in multi-user mode. Finish with {@link connectClaudeLogin}.
 */
export async function openClaudeWebLogin(
  input: { profile: string },
  rootDir: string | undefined,
  start: ClaudeWebLoginStarter,
): Promise<ClaudeWebLogin> {
  const appPaths = profilePaths(input.profile, rootDir);
  const root = await loadRootConfig(appPaths.configFile);
  assertClaudeProfile(root?.profiles[appPaths.profile], appPaths.profile);
  // The dir must be the bot's before the bot's login writes into it.
  const botUser = await ensureBotUser(appPaths);
  try {
    return await start(claudeLoginDir(appPaths), { botUser });
  } catch (err) {
    throw new AnthropicAccountError(`无法开始 Claude 登录：${errorMessage(err)}`);
  }
}

export interface ConnectClaudeLoginDeps {
  checkLogin: ClaudeLoginChecker;
  now?: () => Date;
}

/**
 * Connect a Claude profile to the user's own Claude account through the bot's
 * own Claude Code config dir, once the user has signed it in with
 * `claude auth login`. The credential stays with Claude Code (its own Keychain
 * entry for that dir); config.json only records the dir and an audit-safe label.
 */
export async function connectClaudeLogin(
  input: { profile: string },
  rootDir: string | undefined,
  deps: ConnectClaudeLoginDeps,
): Promise<AnthropicAccountView> {
  const appPaths = profilePaths(input.profile, rootDir);
  const root = await loadRootConfig(appPaths.configFile);
  assertClaudeProfile(root?.profiles[appPaths.profile], appPaths.profile);
  const claudeConfigDir = claudeLoginDir(appPaths);
  // Multi-user mode: hand the dir back to the bot first (a login run as plain
  // root leaves root-owned credentials), then check as the bot itself.
  const botUser = await ensureBotUser(appPaths);
  let status: ClaudeLoginStatus;
  try {
    status = await deps.checkLogin(claudeConfigDir, { botUser });
  } catch (err) {
    throw new AnthropicAccountError(`无法检查 Claude 登录状态：${errorMessage(err)}`);
  }
  if (!status.loggedIn) {
    throw new AnthropicAccountError('这个 bot 还没登录 Claude 账号：请点「连接我的 Claude 账号」，按页面提示登录');
  }
  const anthropic: AnthropicAccountConfig = {
    mode: 'claude-login',
    claudeConfigDir,
    accountHint: describeClaudeAccount(status),
    connectedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  return withConfigFileLock(appPaths.configFile, async () => {
    const latest = await loadRootConfig(appPaths.configFile);
    if (!latest) throw new AnthropicAccountError(`profile 不存在：${appPaths.profile}`);
    const current = latest.profiles[appPaths.profile];
    assertClaudeProfile(current, appPaths.profile);
    latest.profiles[appPaths.profile] = { ...current, anthropic };
    await saveRootConfig(latest, appPaths.configFile);
    // A key kept for the previous API-key mode would otherwise linger unused.
    await removeSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths);
    return anthropicAccountView({ anthropic });
  });
}

/** `Acme · team`; without an org, a masked email — Lark's message audit blocks raw addresses. */
function describeClaudeAccount(status: ClaudeLoginStatus): string {
  const who = status.orgName ?? (status.email ? maskEmailForDisplay(status.email) : 'Claude 账号');
  return status.subscriptionType ? `${who} · ${status.subscriptionType}` : who;
}

function maskEmailForDisplay(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, Math.min(2, at))}***[at]${email.slice(at + 1)}`;
}

/** Normalize + validate a user-entered key; throws {@link AnthropicAccountError} with the reason. */
export async function checkAnthropicApiKey(
  raw: unknown,
  validate: AnthropicKeyValidator = validateAnthropicApiKey,
): Promise<string> {
  const apiKey = normalizedOrThrow(raw);
  await assertAccepted(apiKey, validate);
  return apiKey;
}

export interface ConnectAnthropicDeps {
  validate?: AnthropicKeyValidator;
  now?: () => Date;
}

/**
 * Connect a Claude profile to the user's own Anthropic account: check the key
 * with Anthropic, then keep it only in that profile's encrypted keystore —
 * config.json records just that the account is connected, plus a masked hint.
 * Runs pick it up the next time the profile (re)starts.
 */
export async function connectAnthropicAccount(
  input: { profile: string; apiKey: unknown },
  rootDir?: string,
  deps: ConnectAnthropicDeps = {},
): Promise<AnthropicAccountView> {
  const apiKey = normalizedOrThrow(input.apiKey);
  const appPaths = profilePaths(input.profile, rootDir);
  // Refuse unknown / Codex profiles before spending a call on the key.
  const root = await loadRootConfig(appPaths.configFile);
  assertClaudeProfile(root?.profiles[appPaths.profile], appPaths.profile);
  await assertAccepted(apiKey, deps.validate ?? validateAnthropicApiKey);
  return writeAccount(appPaths, apiKey, (deps.now ?? (() => new Date()))());
}

/** Persist a key that was already validated (QR onboarding checks it before creating the profile). */
export async function storeAnthropicApiKey(
  profile: string,
  apiKey: string,
  rootDir?: string,
  now: Date = new Date(),
): Promise<AnthropicAccountView> {
  return writeAccount(profilePaths(profile, rootDir), apiKey, now);
}

export async function disconnectAnthropicAccount(
  input: { profile: string },
  rootDir?: string,
): Promise<AnthropicAccountView> {
  const appPaths = profilePaths(input.profile, rootDir);
  await withConfigFileLock(appPaths.configFile, async () => {
    const root = await loadRootConfig(appPaths.configFile);
    const current = root?.profiles[appPaths.profile];
    if (!root || !current) throw new AnthropicAccountError(`profile 不存在：${appPaths.profile}`);
    const { anthropic: _removed, ...rest } = current;
    root.profiles[appPaths.profile] = rest;
    await saveRootConfig(root, appPaths.configFile);
    // Inside the lock so a concurrent connect can't have its fresh key deleted.
    await removeSecret(ANTHROPIC_API_KEY_SECRET_ID, appPaths);
  });
  return { connected: false };
}

/**
 * The key a Claude run should use, or undefined when the profile has no
 * Anthropic account (runs keep the host's `claude` login). A connected profile
 * whose key can't be read throws rather than silently running — and billing —
 * on the host's login instead.
 */
export async function resolveAnthropicApiKey(
  profile: Pick<ProfileConfig, 'agentKind' | 'anthropic'>,
  opts: { secrets?: AppConfig['secrets']; secretPaths: KeystorePaths },
): Promise<string | undefined> {
  const account = profile.anthropic;
  if (profile.agentKind !== 'claude' || !account || account.mode === 'claude-login') return undefined;
  let apiKey: string | undefined;
  try {
    apiKey =
      account.apiKey !== undefined
        ? await resolveSecret(account.apiKey, opts.secrets, opts.secretPaths)
        : await getSecret(ANTHROPIC_API_KEY_SECRET_ID, opts.secretPaths);
  } catch (err) {
    throw new Error(`读取 Anthropic API key 失败：${errorMessage(err)}，请在控制台重新连接`);
  }
  if (!apiKey) throw new Error('已连接 Anthropic 账号，但找不到 API key，请在控制台重新连接');
  return apiKey;
}

async function writeAccount(appPaths: AppPaths, apiKey: string, now: Date): Promise<AnthropicAccountView> {
  return withConfigFileLock(appPaths.configFile, async () => {
    const root = await loadRootConfig(appPaths.configFile);
    if (!root) throw new AnthropicAccountError(`profile 不存在：${appPaths.profile}`);
    const current = root.profiles[appPaths.profile];
    assertClaudeProfile(current, appPaths.profile);
    await setSecret(ANTHROPIC_API_KEY_SECRET_ID, apiKey, appPaths);
    const anthropic: AnthropicAccountConfig = {
      keyHint: maskAnthropicApiKey(apiKey),
      connectedAt: now.toISOString(),
    };
    root.profiles[appPaths.profile] = { ...current, anthropic };
    await saveRootConfig(root, appPaths.configFile);
    return anthropicAccountView({ anthropic });
  });
}

function normalizedOrThrow(raw: unknown): string {
  const key = normalizeAnthropicApiKeyInput(raw);
  if (!key.ok) throw new AnthropicAccountError(key.reason);
  return key.apiKey;
}

async function assertAccepted(apiKey: string, validate: AnthropicKeyValidator): Promise<void> {
  const result = await validate(apiKey);
  if (!result.ok) throw new AnthropicAccountError(`Anthropic API key 校验失败：${result.reason}`);
}

function assertClaudeProfile(
  profile: ProfileConfig | undefined,
  name: string,
): asserts profile is ProfileConfig {
  if (!profile) throw new AnthropicAccountError(`profile 不存在：${name}`);
  if (profile.agentKind !== 'claude') {
    throw new AnthropicAccountError(`「${name}」是 Codex profile，不使用 Anthropic API key`);
  }
}

function profilePaths(profile: string, rootDir?: string): AppPaths {
  try {
    return resolveAppPaths({ rootDir, profile });
  } catch (err) {
    throw new AnthropicAccountError(`profile 名称无效：${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
