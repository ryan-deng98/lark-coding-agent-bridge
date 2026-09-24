import type { Readable, Writable } from 'node:stream';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { botUserEnv, botUsersEnabled, type BotUser } from '../../runtime/bot-user';
import { withoutBridgeOnlyEnv } from '../../runtime/bridge-env';
import { buildClaudeLoginEnv } from './anthropic-env';

const URL_TIMEOUT_MS = 30_000;
// Anthropic's codes are short-lived too; an attempt nobody finishes isn't kept.
const LIFETIME_MS = 10 * 60_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024;
const MAX_CODE_LENGTH = 2048;
const ANTHROPIC_DOMAINS = ['claude.com', 'claude.ai', 'anthropic.com'];
const SIGN_IN_URL = /https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/;

/**
 * One sign-in of a bot's Claude Code dir from the console: Anthropic's own
 * `claude auth login`, run as the bot, its sign-in address shown in the
 * browser and the code from Anthropic's page typed back into it. Claude Code
 * trades the code for the credential and keeps that in the dir; the bridge
 * only relays the one-time code.
 */
export interface ClaudeWebLogin {
  /** Anthropic's sign-in page for this attempt. */
  readonly url: string;
  /** Type the code into Claude Code; resolves once it has signed the dir in. */
  submit(code: string): Promise<void>;
  /** Abandon the attempt. */
  cancel(): void;
  /** Settles once the login process is gone (signed in, failed, cancelled or expired). */
  readonly closed: Promise<void>;
}

export type ClaudeWebLoginStarter = (
  claudeConfigDir: string,
  opts?: { botUser?: BotUser },
) => Promise<ClaudeWebLogin>;

export interface StartClaudeWebLoginOptions {
  binary?: string;
  botUser?: BotUser;
  urlTimeoutMs?: number;
  lifetimeMs?: number;
  submitTimeoutMs?: number;
}

export type ClaudeLoginCodeInput = { ok: true; code: string } | { ok: false; reason: string };

/** The code as copied from Anthropic's page (`code#state`), or taken out of a pasted callback address. */
export function normalizeClaudeLoginCode(raw: unknown): ClaudeLoginCodeInput {
  let code = typeof raw === 'string' ? raw.trim() : '';
  if (!code) return { ok: false, reason: '请粘贴 Claude 页面上显示的授权码' };
  if (/^https?:\/\//i.test(code)) {
    try {
      const pasted = new URL(code);
      const value = pasted.searchParams.get('code');
      const state = pasted.searchParams.get('state');
      if (value) code = state ? `${value}#${state}` : value;
    } catch {
      // Not an address after all; the character check below turns it away.
    }
  }
  if (code.length > MAX_CODE_LENGTH) return { ok: false, reason: '授权码长度不对，请重新复制' };
  // One line of code characters only: it is typed into a process.
  if (!/^[\w.~#-]+$/.test(code)) {
    return { ok: false, reason: '授权码格式不对：请点 Claude 页面上的复制按钮，整段粘贴过来' };
  }
  return { ok: true, code };
}

/**
 * Start `claude auth login` for a Claude Code config dir and wait for the
 * sign-in address it prints (without a terminal it prints the address, then
 * reads the code from stdin). Runs with the same env the bot's runs get.
 */
export async function startClaudeWebLogin(
  claudeConfigDir: string,
  opts: StartClaudeWebLoginOptions = {},
): Promise<ClaudeWebLogin> {
  // Claude Code runs helpers from the config dir, and in multi-user mode that
  // dir is the bot's to write: never run it as root.
  if (botUsersEnabled() && !opts.botUser) {
    throw new Error('未准备好这个 bot 的系统用户，拒绝以 root 身份运行 claude auth login');
  }
  let child: SpawnedProcessByStdio<Writable, Readable, Readable>;
  try {
    child = spawnProcess(opts.binary ?? 'claude', ['auth', 'login'], {
      env: mergeProcessEnv(process.env, {
        ...buildClaudeLoginEnv(claudeConfigDir),
        ...(opts.botUser ? botUserEnv(opts.botUser) : withoutBridgeOnlyEnv()),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.botUser ? { uid: opts.botUser.uid, gid: opts.botUser.gid } : {}),
    }) as SpawnedProcessByStdio<Writable, Readable, Readable>;
  } catch (err) {
    throw new Error(`无法运行 claude auth login：${err instanceof Error ? err.message : String(err)}`);
  }
  const proc = new LoginProcess(child);
  const lifetime = setTimeout(() => proc.kill(), opts.lifetimeMs ?? LIFETIME_MS);
  void proc.closed.then(() => clearTimeout(lifetime));

  const urlTimeoutMs = opts.urlTimeoutMs ?? URL_TIMEOUT_MS;
  let url: string;
  try {
    url = await proc.until(
      () => {
        const found = SIGN_IN_URL.exec(proc.output)?.[0];
        if (found) return anthropicSignInUrl(found);
        if (!proc.running) throw new Error(`claude auth login 没有给出登录地址：${lastLine(proc.output)}`);
        return undefined;
      },
      urlTimeoutMs,
      () => new Error(`claude auth login 超过 ${Math.round(urlTimeoutMs / 1000)} 秒没有给出登录地址`),
    );
  } catch (err) {
    proc.kill();
    throw err;
  }

  const submitTimeoutMs = opts.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS;
  let submitted = false;
  return {
    url,
    closed: proc.closed,
    cancel: () => proc.kill(),
    async submit(code: string) {
      if (!proc.running) throw new Error('这次 Claude 登录已结束（取消或超时），请重新开始');
      if (submitted) throw new Error('授权码已经提交过了，请重新开始');
      submitted = true;
      proc.writeLine(code);
      await proc.until(
        () => (proc.running ? undefined : true),
        submitTimeoutMs,
        () => {
          proc.kill();
          return new Error(`Claude Code 超过 ${Math.round(submitTimeoutMs / 1000)} 秒没有完成登录`);
        },
      );
      if (!proc.succeeded) throw new Error(lastLine(proc.output));
    },
  };
}

/** A running `claude auth login`: its output so far, and whether it is still there. */
class LoginProcess {
  readonly closed: Promise<void>;
  private text = '';
  /** undefined while running; null when it died without an exit code. */
  private exitCode: number | null | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly child: SpawnedProcessByStdio<Writable, Readable, Readable>) {
    const collect = (chunk: Buffer) => {
      if (this.text.length < MAX_OUTPUT) this.text += chunk.toString('utf8');
      this.notify();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    // Writing to a process that already quit must not take the bridge down.
    child.stdin.on('error', () => {});
    this.closed = new Promise((resolve) => {
      const done = (code: number | null) => {
        if (this.exitCode !== undefined) return;
        this.exitCode = code;
        this.notify();
        resolve();
      };
      child.on('close', (code: number | null) => done(code));
      child.on('error', (err: Error) => {
        this.text += `\n${err.message}`;
        done(null);
      });
    });
  }

  get output(): string {
    return stripTerminalCodes(this.text);
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  get succeeded(): boolean {
    return this.exitCode === 0;
  }

  kill(): void {
    if (this.running) this.child.kill('SIGKILL');
  }

  writeLine(line: string): void {
    this.child.stdin.end(`${line}\n`);
  }

  /** Resolve with `test`'s first defined value, re-checked on each output and on exit. */
  until<T>(test: () => T | undefined, ms: number, onTimeout: () => Error): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const check = () => {
        try {
          const value = test();
          if (value === undefined) return;
          finish();
          resolve(value);
        } catch (err) {
          finish();
          reject(err);
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(onTimeout());
      }, ms);
      this.listeners.add(check);
      check();
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Only ever send people to Anthropic: the config dir is the bot's to write. */
function anthropicSignInUrl(raw: string): string {
  const host = new URL(raw).hostname.toLowerCase();
  if (!ANTHROPIC_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error(`claude auth login 给出的登录地址不是 Anthropic 的（${host}），已停止`);
  }
  return raw;
}

/** The last thing Claude Code said, minus the sign-in address (e.g. "Login failed: …"). */
function lastLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.replace(/^.*Paste code here if prompted >\s*/, '').trim())
    .filter((line) => line && !SIGN_IN_URL.test(line));
  return (lines.at(-1) ?? '(没有输出)').slice(0, 200);
}

function stripTerminalCodes(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '')
  );
}
