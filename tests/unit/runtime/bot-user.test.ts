import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLarkChannelEnv } from '../../../src/agent/lark-channel-env';
import { resolveAppPaths, type AppPaths } from '../../../src/config/app-paths';
import { mergeProcessEnv } from '../../../src/platform/spawn';
import {
  BOT_USERS_ENV,
  botSpawnOptions,
  botUserEnv,
  clearBotUsersForTests,
  ensureBotProcess,
  ensureBotUser,
  type BotUserSystem,
} from '../../../src/runtime/bot-user';

interface Call {
  op: 'chown' | 'chmod' | 'chownTree';
  path: string;
  args: number[];
}

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-bot-user-'));
  roots.push(root);
  return root;
}

async function setup(profiles: string[] = ['alice']): Promise<{
  base: string;
  paths: AppPaths[];
  system: BotUserSystem & { calls: Call[] };
}> {
  const base = await tempRoot();
  const rootDir = join(base, 'lark-channel');
  const calls: Call[] = [];
  const system = {
    calls,
    passwdFile: join(base, 'passwd'),
    groupFile: join(base, 'group'),
    chown: async (path: string, uid: number, gid: number) => void calls.push({ op: 'chown', path, args: [uid, gid] }),
    chmod: async (path: string, mode: number) => void calls.push({ op: 'chmod', path, args: [mode] }),
    chownTree: async (path: string, uid: number, gid: number) =>
      void calls.push({ op: 'chownTree', path, args: [uid, gid] }),
    hardlinksProtected: async () => true,
  };
  await writeFile(system.passwdFile, 'root:x:0:0:root:/root:/bin/bash\n');
  await writeFile(system.groupFile, 'root:x:0:\n');
  return { base, paths: profiles.map((profile) => resolveAppPaths({ rootDir, profile })), system };
}

function enableMultiUserMode(): void {
  vi.stubEnv(BOT_USERS_ENV, '1');
  vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(0);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearBotUsersForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ensureBotUser', () => {
  it('gives each profile its own uid, stable across restarts', async () => {
    const { paths, system } = await setup(['alice', 'bob']);
    const [alice, bob] = paths as [AppPaths, AppPaths];

    expect((await ensureBotUser(alice, { enabled: true, system }))?.uid).toBe(20001);
    expect((await ensureBotUser(bob, { enabled: true, system }))?.uid).toBe(20002);
    clearBotUsersForTests(); // a restart: nothing in memory, the registry on disk
    expect((await ensureBotUser(alice, { enabled: true, system }))?.uid).toBe(20001);

    const registry = JSON.parse(await readFile(join(alice.rootDir, 'bot-users.json'), 'utf8'));
    expect(registry).toEqual({ version: 1, uids: { alice: 20001, bob: 20002 } });
  });

  it('registers the account once in passwd and group', async () => {
    const { paths, system } = await setup();
    const alice = paths[0] as AppPaths;

    await ensureBotUser(alice, { enabled: true, system });
    await ensureBotUser(alice, { enabled: true, system });

    const passwd = await readFile(system.passwdFile, 'utf8');
    expect(passwd.split('\n').filter((l) => l.startsWith('lcb20001:'))).toEqual([
      `lcb20001:x:20001:20001:lark-channel bot:${join(alice.profileDir, 'home')}:/bin/sh`,
    ]);
    expect(await readFile(system.groupFile, 'utf8')).toBe('root:x:0:\nlcb20001:x:20001:\n');
  });

  it('lets the bot reach only its own subtree', async () => {
    const { paths, system } = await setup();
    const p = paths[0] as AppPaths;
    await mkdir(p.profileDir, { recursive: true });
    await writeFile(p.secretsFile, '{}');
    await writeFile(p.keystoreSaltFile, 'salt');

    const user = await ensureBotUser(p, { enabled: true, system });

    const chmodOf = (path: string) => system.calls.find((c) => c.op === 'chmod' && c.path === path)?.args[0];
    const chownOf = (path: string) => system.calls.find((c) => c.op === 'chown' && c.path === path)?.args;
    const treeOwned = system.calls.filter((c) => c.op === 'chownTree').map((c) => c.path);
    // Shared parents: pass through, no listing.
    for (const dir of [p.rootDir, join(p.rootDir, 'profiles'), `${p.rootDir}-workspaces`]) {
      expect(chmodOf(dir)).toBe(0o711);
    }
    // Its profile dir: only it may pass; the bridge's files in there stay root's.
    expect(chownOf(p.profileDir)).toEqual([0, 20001]);
    expect(chmodOf(p.profileDir)).toBe(0o710);
    // Its own state and workspace.
    const owned = [user!.home, join(p.profileDir, 'claude-code'), join(p.profileDir, 'codex-home'), p.larkCliConfigDir, dirname(p.defaultWorkspaceDir)];
    expect(treeOwned.sort()).toEqual([...owned].sort());
    for (const dir of owned) expect(chmodOf(dir)).toBe(0o700);
    // Written by the bridge, read by the bot: never the bot's to plant symlinks in.
    for (const dir of [p.larkCliSourceDir, p.mediaDir]) {
      expect(chownOf(dir)).toEqual([0, 20001]);
      expect(chmodOf(dir)).toBe(0o750);
    }
    for (const file of [p.secretsFile, p.keystoreSaltFile]) {
      expect(chownOf(file)).toEqual([0, 20001]);
      expect(chmodOf(file)).toBe(0o640);
    }
  });

  it('refuses to hand a symlinked directory to a bot user', async () => {
    const { base, paths, system } = await setup();
    const p = paths[0] as AppPaths;
    await mkdir(p.profileDir, { recursive: true });
    await symlink(base, join(p.profileDir, 'claude-code'));

    await expect(ensureBotUser(p, { enabled: true, system })).rejects.toThrow(/not a directory/);
    expect(system.calls.some((c) => c.path.startsWith(join(p.profileDir, 'claude-code')) && c.op !== 'chmod')).toBe(false);
  });

  it('refuses multi-user mode where the kernel allows hardlinking foreign files', async () => {
    const { paths, system } = await setup();

    await expect(
      ensureBotUser(paths[0] as AppPaths, { enabled: true, system: { ...system, hardlinksProtected: async () => false } }),
    ).rejects.toThrow(/protected_hardlinks/);
    expect(system.calls).toEqual([]);
  });

  it('does nothing unless multi-user mode is on', async () => {
    const { paths, system } = await setup();

    await expect(ensureBotUser(paths[0] as AppPaths, { enabled: false, system })).resolves.toBeUndefined();

    expect(system.calls).toEqual([]);
  });
});

describe('running processes as bot users', () => {
  it("gives a bot user's processes their own HOME and temp dir, and never the console token", async () => {
    const { paths, system } = await setup();
    const user = (await ensureBotUser(paths[0] as AppPaths, { enabled: true, system }))!;

    const env = botUserEnv(user);

    expect(env).toMatchObject({ HOME: user.home, TMPDIR: join(user.home, 'tmp'), USER: 'lcb20001' });
    expect(Object.hasOwn(env, 'LARK_CHANNEL_UI_TOKEN') && env.LARK_CHANNEL_UI_TOKEN === undefined).toBe(true);
  });

  it('keeps the console token out of every profile process, multi-user mode or not', () => {
    vi.stubEnv('LARK_CHANNEL_UI_TOKEN', 't'.repeat(64));

    const env = mergeProcessEnv(process.env, buildLarkChannelEnv({ rootDir: '/data/lark-channel', profile: 'alice' }));

    expect(env.LARK_CHANNEL_UI_TOKEN).toBeUndefined();
  });

  it('is a no-op outside multi-user mode', async () => {
    expect(botSpawnOptions({ LARK_CHANNEL_HOME: '/data/lark-channel', LARK_CHANNEL_PROFILE: 'alice' })).toEqual({});
    await expect(ensureBotProcess({ LARK_CHANNEL_PROFILE: 'alice' })).resolves.toEqual({ spawn: {}, env: {} });
  });

  it('in multi-user mode runs a profile process as its bot user, and never falls back to root', async () => {
    const { paths, system } = await setup();
    const p = paths[0] as AppPaths;
    enableMultiUserMode();

    expect(() => botSpawnOptions(buildLarkChannelEnv({ rootDir: p.rootDir, profile: p.profile }))).toThrow(
      /refusing to run it as root/,
    );
    const user = (await ensureBotUser(p, { system }))!;
    const env = buildLarkChannelEnv({ rootDir: p.rootDir, profile: p.profile });

    expect(botSpawnOptions(env)).toEqual({ uid: user.uid, gid: user.gid });
    expect(env.HOME).toBe(user.home);
    await expect(ensureBotProcess(env)).resolves.toMatchObject({
      spawn: { uid: user.uid, gid: user.gid },
      env: { HOME: user.home },
    });
  });
});
