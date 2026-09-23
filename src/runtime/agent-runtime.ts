import { ClaudeAdapter } from '../agent/claude/adapter';
import { buildAnthropicAuthEnv, buildClaudeLoginEnv } from '../agent/claude/anthropic-env';
import { CodexAdapter } from '../agent/codex/adapter';
import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import type { AgentAdapter } from '../agent/types';
import { resolveAnthropicApiKey } from '../config/anthropic-account';
import type { AppPaths } from '../config/app-paths';
import type { KeystorePaths } from '../config/keystore';
import { claudeLoginConfigDir, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import type { AcquiredRuntimeLock } from './locks';

export interface RuntimeAgentOptions {
  /** Claude only: env that pins the bot's own Anthropic key (see {@link resolveRuntimeAgentAuthEnv}). */
  claudeAuthEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
  opts: RuntimeAgentOptions = {},
): AgentAdapter {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const larkChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  if (profileConfig.agentKind === 'codex') {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: appPaths.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
    });
  }
  return new ClaudeAdapter({ larkChannel, ...(opts.claudeAuthEnv ? { authEnv: opts.claudeAuthEnv } : {}) });
}

/**
 * Resolve the env a profile's Claude runs need for its own Anthropic account;
 * undefined keeps the host's `claude` login. Throws when a connected account's
 * key can't be read, so the profile fails to start instead of quietly running
 * on someone else's login.
 */
export async function resolveRuntimeAgentAuthEnv(
  profileConfig: ProfileConfig,
  cfg: Pick<AppConfig, 'secrets'>,
  secretPaths: KeystorePaths,
): Promise<NodeJS.ProcessEnv | undefined> {
  const loginDir = claudeLoginConfigDir(profileConfig);
  if (loginDir) return buildClaudeLoginEnv(loginDir);
  const apiKey = await resolveAnthropicApiKey(profileConfig, { secrets: cfg.secrets, secretPaths });
  return apiKey ? buildAnthropicAuthEnv(apiKey) : undefined;
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId: agent.id === 'codex' ? ('codex' as const) : ('claude' as const),
    agentName: agent.displayName,
    command: agent.id === 'codex' ? 'codex' : 'claude',
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
