import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAppPaths, type AppPaths } from '../../src/config/app-paths';
import { setSecret } from '../../src/config/keystore';
import { clearBotUsersForTests, ensureBotUser, type BotUser } from '../../src/runtime/bot-user';

// Real uids, chown and /etc/passwd: only as root inside a throwaway container,
// e.g. `docker run --rm -e LARK_CHANNEL_ISOLATION_TEST=1 ... npx vitest run tests/process/bot-user-isolation.test.ts`.
const RUN = process.getuid?.() === 0 && process.env.LARK_CHANNEL_ISOLATION_TEST === '1';
const SEED = 'k'.repeat(64);

describe.skipIf(!RUN)('bot user isolation (as root, in a container)', () => {
  let base: string;
  let alice: AppPaths;
  let bob: AppPaths;
  let a: BotUser;
  let b: BotUser;

  beforeAll(async () => {
    process.env.LARK_CHANNEL_KEYSTORE_SECRET = SEED;
    base = await mkdtemp(join(tmpdir(), 'iso-'));
    await chmod(base, 0o755); // mkdtemp makes it 0700; the bots must reach the root inside
    const rootDir = join(base, 'lark-channel');
    alice = resolveAppPaths({ rootDir, profile: 'alice' });
    bob = resolveAppPaths({ rootDir, profile: 'bob' });
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, 'config.json'), '{"bridge":"config"}', { mode: 0o600 });
    for (const p of [alice, bob]) {
      await setSecret(`app-${p.profile}`, `secret-of-${p.profile}`, p);
      await mkdir(join(p.profileDir, 'claude-code'), { recursive: true });
      await writeFile(join(p.profileDir, 'claude-code', '.credentials.json'), `creds-of-${p.profile}`, { mode: 0o600 });
      await mkdir(p.defaultWorkspaceDir, { recursive: true });
      await writeFile(join(p.defaultWorkspaceDir, 'notes.txt'), `work-of-${p.profile}`);
      await mkdir(p.mediaDir, { recursive: true });
      await writeFile(join(p.mediaDir, 'photo.png'), `media-of-${p.profile}`);
    }
    a = (await ensureBotUser(alice, { enabled: true }))!;
    b = (await ensureBotUser(bob, { enabled: true }))!;
  });

  afterAll(async () => {
    clearBotUsersForTests();
    delete process.env.LARK_CHANNEL_KEYSTORE_SECRET;
    await rm(base, { recursive: true, force: true });
  });

  function asUser(user: BotUser, script: string, env: NodeJS.ProcessEnv = {}): { ok: boolean; out: string } {
    const r = spawnSync('sh', ['-c', script], {
      uid: user.uid,
      gid: user.gid,
      env: { PATH: process.env.PATH, HOME: user.home, ...env },
      encoding: 'utf8',
    });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
  }

  it('a bot reads and writes its own files', () => {
    expect(asUser(a, `cat '${join(alice.profileDir, 'claude-code', '.credentials.json')}'`)).toEqual({
      ok: true,
      out: 'creds-of-alice',
    });
    expect(asUser(a, `cat '${join(alice.defaultWorkspaceDir, 'notes.txt')}'`).out).toBe('work-of-alice');
    expect(asUser(a, `echo hi > '${join(alice.defaultWorkspaceDir, 'new.txt')}'`).ok).toBe(true);
    expect(asUser(a, `cat '${join(alice.mediaDir, 'photo.png')}'`).out).toBe('media-of-alice');
  });

  it("a bot can't read another bot's login, workspace, media or keystore", () => {
    for (const path of [
      join(bob.profileDir, 'claude-code', '.credentials.json'),
      join(bob.defaultWorkspaceDir, 'notes.txt'),
      join(bob.mediaDir, 'photo.png'),
      bob.secretsFile,
    ]) {
      expect(asUser(a, `cat '${path}'`).ok, path).toBe(false);
    }
  });

  it("a bot can't read the bridge's config, list the shared dirs, or read the bridge's env", () => {
    expect(asUser(a, `cat '${join(alice.rootDir, 'config.json')}'`).ok).toBe(false);
    expect(asUser(a, `ls '${alice.rootDir}'`).ok).toBe(false);
    expect(asUser(a, `ls '${join(alice.rootDir, 'profiles')}'`).ok).toBe(false);
    expect(asUser(a, `cat /proc/${process.pid}/environ`).ok).toBe(false);
  });

  it("a bot can't write where the bridge writes on its behalf (no symlink planting)", () => {
    expect(asUser(a, `ln -s /etc/passwd '${join(alice.mediaDir, 'next.png')}'`).ok).toBe(false);
    expect(asUser(a, `touch '${join(alice.larkCliSourceDir, 'config.json')}'`).ok).toBe(false);
    expect(asUser(a, `touch '${join(alice.profileDir, 'sessions.json')}'`).ok).toBe(false);
  });

  it("re-owning a bot's files on start doesn't follow symlinks it planted", async () => {
    expect(asUser(a, `ln -s '${bob.defaultWorkspaceDir}' '${join(a.home, 'bob-work')}'`).ok).toBe(true);

    await ensureBotUser(alice, { enabled: true });

    expect(asUser(b, `cat '${join(bob.defaultWorkspaceDir, 'notes.txt')}'`).out).toBe('work-of-bob');
    expect(asUser(a, `cat '${join(bob.defaultWorkspaceDir, 'notes.txt')}'`).ok).toBe(false);
  });

  it("a bot's lark-cli secret getter decrypts only that bot's App Secret", () => {
    const getter = (profile: string) =>
      asUser(
        a,
        `printf '%s' '{"protocolVersion":1,"provider":"bridge","ids":["app-${profile}"]}' | ` +
          `node '${join(process.cwd(), 'bin', 'lark-channel-bridge.mjs')}' secrets get`,
        { LARK_CHANNEL_HOME: alice.rootDir, LARK_CHANNEL_PROFILE: profile, LARK_CHANNEL_KEYSTORE_SECRET: SEED },
      );

    expect(getter('alice').out).toContain('"app-alice":"secret-of-alice"');
    expect(getter('bob').out).not.toContain('secret-of-bob');
  });
});
