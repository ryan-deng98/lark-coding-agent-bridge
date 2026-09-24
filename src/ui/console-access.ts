import { resolveAppPaths } from '../config/app-paths';
import type { ConsoleOwner } from '../config/profile-schema';
import { loadRootConfig, readActiveProfile } from '../config/profile-store';
import { isAdmin, type Principal } from './console-auth';
import { HttpError } from './http';

/**
 * Which bots a console caller may see and act on. Admins (the console token or
 * a signed-in admin) reach every profile; everyone else only the ones they
 * created. Someone else's bot answers exactly like a missing one, so the
 * console can't be used to learn who else has a bot.
 */

export type VisibleProfiles = ReadonlySet<string> | 'all';

export async function visibleProfiles(principal: Principal, rootDir?: string): Promise<VisibleProfiles> {
  if (isAdmin(principal) || principal.kind !== 'user') return 'all';
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  return new Set(
    Object.entries(root?.profiles ?? {})
      .filter(([, profile]) => profile.consoleOwner?.id === principal.id)
      .map(([name]) => name),
  );
}

export function canSee(visible: VisibleProfiles, profile: string): boolean {
  return visible === 'all' || visible.has(profile);
}

/**
 * The profile a request acts on. Admins may leave it out (the active profile);
 * everyone else must name one of their own.
 */
export async function authorizedProfile(
  principal: Principal,
  requested: string | null | undefined,
  rootDir?: string,
): Promise<string> {
  const name = requested?.trim();
  if (isAdmin(principal)) {
    const profile = name || (await readActiveProfile(rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    return profile;
  }
  if (!name || !canSee(await visibleProfiles(principal, rootDir), name)) {
    throw new HttpError(404, 'profile not found');
  }
  return name;
}

export function requireAdmin(principal: Principal): void {
  if (!isAdmin(principal)) throw new HttpError(403, '需要管理员权限');
}

/** Who owns a bot a signed-in person creates (the console token records nobody). */
export function ownerFor(principal: Principal): ConsoleOwner | undefined {
  return principal.kind === 'user' ? { id: principal.id, name: principal.name } : undefined;
}
