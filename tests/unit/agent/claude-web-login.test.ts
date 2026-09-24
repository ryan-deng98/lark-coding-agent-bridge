import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeClaudeLoginCode, startClaudeWebLogin } from '../../../src/agent/claude/web-login';

const SIGN_IN_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz';
const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in `claude` that records how it was called, then runs `body`. */
async function fakeClaude(body: string): Promise<{ bin: string; record: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-web-login-'));
  dirs.push(dir);
  const bin = join(dir, 'fake-claude.mjs');
  const record = join(dir, 'record.json');
  await writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({`,
      '  argv: process.argv.slice(2),',
      '  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,',
      '  apiKey: process.env.ANTHROPIC_API_KEY ?? null,',
      '}));',
      body,
    ].join('\n'),
    'utf8',
  );
  await chmod(bin, 0o755);
  return { bin, record };
}

/** What `claude auth login` 2.1 prints without a terminal, then how it takes the pasted code. */
function signInFlow(url = SIGN_IN_URL): string {
  return [
    `process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: ${url}\\nPaste code here if prompted > ");`,
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; if (input.includes("\\n")) finish(); });',
    'process.stdin.on("end", finish);',
    'function finish() {',
    '  if (input.trim() === "good-code#state") { console.log("Login successful."); process.exit(0); }',
    '  console.log("Login failed: Request failed with status code 400");',
    '  process.exit(1);',
    '}',
  ].join('\n');
}

describe('startClaudeWebLogin', () => {
  it('hands back the sign-in address and signs the dir in with the pasted code', async () => {
    const fake = await fakeClaude(signInFlow());
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-host');

    const login = await startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin });
    await login.submit('good-code#state');

    expect(login.url).toBe(SIGN_IN_URL);
    // The deployment's own key must not end up signing the bot in.
    expect(JSON.parse(await readFile(fake.record, 'utf8'))).toEqual({
      argv: ['auth', 'login'],
      configDir: '/state/bot/claude-code',
      apiKey: null,
    });
  });

  it('says why Claude Code turned the code down', async () => {
    const fake = await fakeClaude(signInFlow());
    const login = await startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin });

    await expect(login.submit('stale-code#state')).rejects.toThrow(/status code 400/);
  });

  it("won't show a sign-in address that isn't Anthropic's", async () => {
    const fake = await fakeClaude(signInFlow('https://claude.com.evil.example/oauth/authorize?code=true'));

    await expect(startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin })).rejects.toThrow(
      /不是 Anthropic 的/,
    );
  });

  it('gives up when Claude Code exits without a sign-in address', async () => {
    const fake = await fakeClaude('console.error("Error: cannot reach claude.com"); process.exit(1);');

    await expect(startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin })).rejects.toThrow(
      /cannot reach claude\.com/,
    );
  });

  it('gives up when no sign-in address shows up in time', async () => {
    const fake = await fakeClaude('setInterval(() => {}, 1000);');

    await expect(
      startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin, urlTimeoutMs: 300 }),
    ).rejects.toThrow(/没有给出登录地址/);
  });

  it('ends an attempt that is cancelled, or left unfinished too long', async () => {
    const fake = await fakeClaude(signInFlow());
    const cancelled = await startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin });
    const forgotten = await startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin, lifetimeMs: 200 });

    cancelled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 400));

    await expect(cancelled.submit('good-code#state')).rejects.toThrow(/已结束/);
    await expect(forgotten.submit('good-code#state')).rejects.toThrow(/已结束/);
  });

  it("refuses to sign a bot's dir in as root in multi-user mode", async () => {
    const fake = await fakeClaude(signInFlow());
    vi.stubEnv('LARK_CHANNEL_BOT_USERS', '1');
    vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(0);

    await expect(startClaudeWebLogin('/state/bot/claude-code', { binary: fake.bin })).rejects.toThrow(/root/);
  });
});

describe('normalizeClaudeLoginCode', () => {
  it('takes the code as copied, or out of a pasted callback address', () => {
    expect(normalizeClaudeLoginCode('  abc_DEF-123#st.ate~  ')).toEqual({ ok: true, code: 'abc_DEF-123#st.ate~' });
    expect(
      normalizeClaudeLoginCode('https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz'),
    ).toEqual({ ok: true, code: 'abc123#xyz' });
  });

  it('turns away anything that could not be a code', () => {
    for (const raw of ['', '   ', 'abc def', 'abc\n/logout', 'abc;rm', 'x'.repeat(2049), 42]) {
      expect(normalizeClaudeLoginCode(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });
});
