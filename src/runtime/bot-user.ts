import { appendFile, chmod, chown, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import { writeFileAtomic } from '../platform/atomic-write';
import { spawnProcessSync } from '../platform/spawn';
import { withoutBridgeOnlyEnv } from './bridge-env';

/**
 * Multi-user mode for a shared container: every bot's agent and tools run as
 * the bot's own OS user, so one person's bot can't read another's workspace,
 * Claude login or App Secret — nor the bridge's config, console token or env
 * (another uid's /proc/<pid>/environ is unreadable). Opt-in, and only when the
 * bridge runs as root, since it has to setuid its children.
 */
export const BOT_USERS_ENV = 'LARK_CHANNEL_BOT_USERS';

const FIRST_UID = 20001;
const ACCOUNT_PREFIX = 'lcb';
const REGISTRY_FILE = 'bot-users.json';
const REGISTRY_VERSION = 1;

export interface BotUser {
  uid: number;
  gid: number;
  /** Account name in /etc/passwd, e.g. `lcb20001`. */
  name: string;
  /** The bot's own HOME (its TMPDIR lives inside). */
  home: string;
}

export type BotUserPaths = Pick<
  AppPaths,
  | 'rootDir'
  | 'profile'
  | 'profileDir'
  | 'defaultWorkspaceDir'
  | 'larkCliConfigDir'
  | 'larkCliSourceDir'
  | 'mediaDir'
  | 'secretsFile'
  | 'keystoreSaltFile'
>;

/** The OS operations multi-user mode needs; replaced in tests. */
export interface BotUserSystem {
  passwdFile: string;
  groupFile: string;
  chown(path: string, uid: number, gid: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Recursive ownership change that never follows symlinks. */
  chownTree(path: string, uid: number, gid: number): Promise<void>;
}

export interface EnsureBotUserOptions {
  /** Defaults to {@link botUsersEnabled}. */
  enabled?: boolean;
  system?: BotUserSystem;
}

const defaultSystem: BotUserSystem = {
  passwdFile: '/etc/passwd',
  groupFile: '/etc/group',
  chown: (path, uid, gid) => chown(path, uid, gid),
  chmod: (path, mode) => chmod(path, mode),
  async chownTree(path, uid, gid) {
    // GNU chown -R never follows symlinks while traversing (-P is the default)
    // and -h changes a link itself: a bot can't point the bridge's root chown
    // at files outside its own tree.
    const r = spawnProcessSync('chown', ['-R', '-h', `${uid}:${gid}`, path], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (r.status !== 0) {
      throw new Error(`chown -R ${path} failed: ${String(r.stderr ?? '').trim() || `exit ${r.status}`}`);
    }
  },
};

const users = new Map<string, BotUser>();
let registryQueue: Promise<unknown> = Promise.resolve();

export function botUsersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BOT_USERS_ENV] === '1' && process.getuid?.() === 0;
}

/**
 * Give the profile its own OS user and lay its files out so that only it (and
 * the bridge) can reach them. Idempotent: run on every start, so ownership
 * left behind by root — a Claude login over SSH, files from before multi-user
 * mode — is repaired. Returns undefined when multi-user mode is off.
 */
export async function ensureBotUser(
  paths: BotUserPaths,
  opts: EnsureBotUserOptions = {},
): Promise<BotUser | undefined> {
  if (!(opts.enabled ?? botUsersEnabled())) return undefined;
  const system = opts.system ?? defaultSystem;
  const uid = await allocateUid(paths.rootDir, paths.profile);
  const name = `${ACCOUNT_PREFIX}${uid}`;
  const user: BotUser = { uid, gid: uid, name, home: join(paths.profileDir, 'home') };
  await appendIfMissing(system.passwdFile, uid, `${name}:x:${uid}:${uid}:lark-channel bot:${user.home}:/bin/sh`);
  await appendIfMissing(system.groupFile, uid, `${name}:x:${uid}:`);
  await layOutFiles(paths, user, system);
  users.set(userKey(paths.rootDir, paths.profile), user);
  return user;
}

/** The bot user set up for this profile in this process, if any. */
export function botUserFor(rootDir: string | undefined, profile: string | undefined): BotUser | undefined {
  return rootDir && profile ? users.get(userKey(rootDir, profile)) : undefined;
}

/**
 * Spawn options running a process that carries a profile's lark-channel env
 * (LARK_CHANNEL_HOME + LARK_CHANNEL_PROFILE) as that profile's bot user.
 * Empty when multi-user mode is off. When it is on, never falls back to root:
 * a profile whose bot user isn't set up yet is an error.
 */
export function botSpawnOptions(env: NodeJS.ProcessEnv): { uid?: number; gid?: number } {
  if (!botUsersEnabled()) return {};
  const user = botUserFor(env.LARK_CHANNEL_HOME, env.LARK_CHANNEL_PROFILE);
  if (!user) {
    throw new Error(
      `no bot user set up for profile ${env.LARK_CHANNEL_PROFILE ?? '(none)'}; refusing to run it as root`,
    );
  }
  return { uid: user.uid, gid: user.gid };
}

/**
 * Env for the bot user's processes: its own HOME and temp dir (not root's, not
 * a shared /tmp), and none of the bridge's own secrets.
 */
export function botUserEnv(user: BotUser): NodeJS.ProcessEnv {
  return {
    ...withoutBridgeOnlyEnv(),
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    TMPDIR: join(user.home, 'tmp'),
  };
}

export interface BotProcess {
  /** uid/gid for spawn(); empty when multi-user mode is off. */
  spawn: { uid?: number; gid?: number };
  /** HOME/USER/TMPDIR overrides; empty when multi-user mode is off. */
  env: NodeJS.ProcessEnv;
}

/**
 * How to run a process that carries a profile's lark-channel env, setting the
 * profile's bot user up first when this process hasn't yet (the console
 * working on a bot that isn't running). Never falls back to root.
 */
export async function ensureBotProcess(env: NodeJS.ProcessEnv): Promise<BotProcess> {
  if (!botUsersEnabled()) return { spawn: {}, env: {} };
  const rootDir = env.LARK_CHANNEL_HOME;
  const profile = env.LARK_CHANNEL_PROFILE;
  let user = botUserFor(rootDir, profile);
  if (!user && rootDir && profile) user = await ensureBotUser(resolveAppPaths({ rootDir, profile }));
  if (!user) throw new Error(`no bot user for profile ${profile ?? '(none)'}; refusing to run it as root`);
  return { spawn: { uid: user.uid, gid: user.gid }, env: botUserEnv(user) };
}

/** Test hook: forget the bot users set up in this process. */
export function clearBotUsersForTests(): void {
  users.clear();
}

function userKey(rootDir: string, profile: string): string {
  return `${rootDir}\0${profile}`;
}

async function allocateUid(rootDir: string, profile: string): Promise<number> {
  const run = registryQueue.then(async () => {
    const file = join(rootDir, REGISTRY_FILE);
    const uids = await readRegistry(file);
    const existing = uids[profile];
    if (existing !== undefined) return existing;
    const taken = Object.values(uids);
    const uid = taken.length > 0 ? Math.max(...taken) + 1 : FIRST_UID;
    await mkdir(rootDir, { recursive: true });
    await writeFileAtomic(
      file,
      `${JSON.stringify({ version: REGISTRY_VERSION, uids: { ...uids, [profile]: uid } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return uid;
  });
  registryQueue = run.catch(() => undefined);
  return run;
}

async function readRegistry(file: string): Promise<Record<string, number>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = JSON.parse(text) as { version?: unknown; uids?: unknown };
  if (parsed.version !== REGISTRY_VERSION || !parsed.uids || typeof parsed.uids !== 'object') {
    throw new Error(`${file}: unrecognized bot user registry`);
  }
  const uids: Record<string, number> = {};
  for (const [profile, uid] of Object.entries(parsed.uids as Record<string, unknown>)) {
    if (!Number.isInteger(uid) || (uid as number) < FIRST_UID) {
      throw new Error(`${file}: invalid uid for profile ${profile}`);
    }
    uids[profile] = uid as number;
  }
  return uids;
}

async function appendIfMissing(file: string, id: number, line: string): Promise<void> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (text.split('\n').some((entry) => entry.split(':')[2] === String(id))) return;
  await appendFile(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
}

async function layOutFiles(paths: BotUserPaths, user: BotUser, system: BotUserSystem): Promise<void> {
  // Shared parents: traversable, not listable — a bot reaches its own subtree only.
  for (const dir of [paths.rootDir, join(paths.rootDir, 'profiles'), `${paths.rootDir}-workspaces`]) {
    await mkdir(dir, { recursive: true });
    await system.chmod(dir, 0o711);
  }
  // The bridge's own state (logs, process registry) stays root-only.
  for (const dir of [join(paths.rootDir, 'logs'), join(paths.rootDir, 'registry')]) {
    if (await isRealDir(dir)) await system.chmod(dir, 0o700);
  }

  // The profile dir holds the bridge's files for this bot (sessions, logs,
  // keystore): only this bot may pass through it, to its own subdirectories.
  await mkdir(paths.profileDir, { recursive: true });
  await system.chown(paths.profileDir, 0, user.gid);
  await system.chmod(paths.profileDir, 0o710);

  // Everything here sits directly in a root-owned parent, so the bot can't swap
  // one for a symlink before the chmod below.
  const workspaceRoot = dirname(paths.defaultWorkspaceDir);
  for (const dir of [...botOwnedDirs(paths, user), workspaceRoot]) {
    await mkdir(dir, { recursive: true });
    if (!(await isRealDir(dir))) throw new Error(`${dir} is not a directory; refusing to hand it to a bot user`);
    if (dir === user.home) await mkdir(join(dir, 'tmp'), { recursive: true });
    // Small state dirs are re-owned every start; a workspace can be large, so
    // only when it isn't the bot's yet (first start in multi-user mode).
    if (dir !== workspaceRoot || (await ownerOf(dir)) !== user.uid) {
      await system.chownTree(dir, user.uid, user.gid);
    }
    await system.chmod(dir, 0o700);
  }

  // Written by the bridge (as root), read by the bot. Root keeps them so the
  // bot can't plant a symlink for the bridge to write through.
  for (const dir of bridgeWrittenDirs(paths)) {
    await mkdir(dir, { recursive: true });
    if (!(await isRealDir(dir))) throw new Error(`${dir} is not a directory; refusing to share it with a bot user`);
    await system.chown(dir, 0, user.gid);
    await system.chmod(dir, 0o750);
  }

  // Its keystore: the bot's lark-cli reads the App Secret through the secrets
  // getter, which runs as the bot; only the bridge writes it.
  for (const file of [paths.secretsFile, paths.keystoreSaltFile]) {
    if (!(await isRealFile(file))) continue;
    await shareWithBotUser(file, user, system);
  }
}

/**
 * Let a bot user read a file the bridge wrote (0640, group = the bot).
 * Only for files in a directory the bot can't write, e.g. its keystore or
 * the lark-cli source config.
 */
export async function shareWithBotUser(
  file: string,
  user: BotUser,
  system: Pick<BotUserSystem, 'chown' | 'chmod'> = defaultSystem,
): Promise<void> {
  await system.chown(file, 0, user.gid);
  await system.chmod(file, 0o640);
}

function botOwnedDirs(paths: BotUserPaths, user: BotUser): string[] {
  return [
    user.home,
    join(paths.profileDir, 'claude-code'),
    join(paths.profileDir, 'codex-home'),
    paths.larkCliConfigDir,
  ];
}

function bridgeWrittenDirs(paths: BotUserPaths): string[] {
  return [paths.larkCliSourceDir, paths.mediaDir];
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function isRealFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function ownerOf(path: string): Promise<number> {
  return (await lstat(path)).uid;
}
