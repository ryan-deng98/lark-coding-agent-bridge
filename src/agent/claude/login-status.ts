import type { Readable } from 'node:stream';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildClaudeLoginEnv } from './anthropic-env';

const STATUS_TIMEOUT_MS = 15_000;

/** The parts of `claude auth status` the console shows. */
export interface ClaudeLoginStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

export type ClaudeLoginChecker = (claudeConfigDir: string) => Promise<ClaudeLoginStatus>;

/**
 * Ask Claude Code whether a config dir is signed in (`claude auth status`,
 * JSON; exit 1 = signed out). Runs with the same env the bot's runs get, so an
 * API key in the bridge's own env can't make a signed-out dir look signed in.
 */
export async function checkClaudeLogin(
  claudeConfigDir: string,
  opts: { binary?: string; timeoutMs?: number } = {},
): Promise<ClaudeLoginStatus> {
  const stdout = await runAuthStatus(claudeConfigDir, opts.binary ?? 'claude', opts.timeoutMs ?? STATUS_TIMEOUT_MS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude auth status 没有返回登录状态：${stdout.trim().slice(0, 200) || '(空输出)'}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { loggedIn?: unknown }).loggedIn !== 'boolean') {
    throw new Error('claude auth status 返回的内容无法识别，请升级 Claude Code');
  }
  const raw = parsed as Record<string, unknown>;
  return {
    loggedIn: raw.loggedIn as boolean,
    ...stringField(raw, 'authMethod'),
    ...stringField(raw, 'email'),
    ...stringField(raw, 'orgName'),
    ...stringField(raw, 'subscriptionType'),
  };
}

function runAuthStatus(claudeConfigDir: string, binary: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: SpawnedProcessByStdio<null, Readable, Readable>;
    try {
      child = spawnProcess(binary, ['auth', 'status'], {
        env: mergeProcessEnv(process.env, buildClaudeLoginEnv(claudeConfigDir)),
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as SpawnedProcessByStdio<null, Readable, Readable>;
    } catch (err) {
      reject(new Error(`无法运行 claude auth status：${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude auth status 超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`无法运行 claude auth status：${err.message}`));
    });
    // Exit code 1 just means "signed out" — the JSON on stdout says so.
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

function stringField(raw: Record<string, unknown>, key: keyof ClaudeLoginStatus): Partial<ClaudeLoginStatus> {
  const value = raw[key];
  return typeof value === 'string' && value ? { [key]: value } : {};
}
