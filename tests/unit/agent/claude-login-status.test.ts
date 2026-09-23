import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkClaudeLogin } from '../../../src/agent/claude/login-status';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in `claude` that records how it was called, then runs `body`. */
async function fakeClaude(body: string): Promise<{ bin: string; record: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-login-status-'));
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

describe('checkClaudeLogin', () => {
  it("reports the account signed in to the bot's login dir", async () => {
    const fake = await fakeClaude(
      'console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com", orgName: "Acme", subscriptionType: "team", orgId: "org-1" }));',
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-host');

    const status = await checkClaudeLogin('/state/bot/claude-code', { binary: fake.bin });

    expect(status).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'me@example.com',
      orgName: 'Acme',
      subscriptionType: 'team',
    });
    expect(JSON.parse(await readFile(fake.record, 'utf8'))).toEqual({
      argv: ['auth', 'status'],
      configDir: '/state/bot/claude-code',
      apiKey: null,
    });
  });

  it('treats the JSON printed with exit code 1 as logged out', async () => {
    const fake = await fakeClaude(
      'console.log(JSON.stringify({ loggedIn: false, authMethod: "none" })); process.exit(1);',
    );

    await expect(checkClaudeLogin('/state/bot/claude-code', { binary: fake.bin })).resolves.toEqual({
      loggedIn: false,
      authMethod: 'none',
    });
  });

  it('fails with a readable error when the output is not auth JSON', async () => {
    const fake = await fakeClaude('console.log("unknown command"); process.exit(2);');

    await expect(checkClaudeLogin('/state/bot/claude-code', { binary: fake.bin })).rejects.toThrow(
      /claude auth status/,
    );
  });

  it('fails with a readable error when claude cannot be started', async () => {
    await expect(
      checkClaudeLogin('/state/bot/claude-code', { binary: join(tmpdir(), 'no-such-claude-binary') }),
    ).rejects.toThrow(/claude auth status/);
  });
});
