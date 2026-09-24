import { ADMINS_ENV, LOGIN_APP_SECRET_ENV } from '../ui/console-auth';
import { UI_TOKEN_ENV } from '../ui/exposure';

/**
 * Env the bridge itself uses that must never reach an agent or its tools:
 * agents run with broad permissions (bypassPermissions in a container), and
 * these grant control over every bot (the console token), let anyone sign
 * people into the console (the login app's secret) or say whom to impersonate
 * (the admin list).
 */
export const BRIDGE_ONLY_ENV: readonly string[] = [UI_TOKEN_ENV, LOGIN_APP_SECRET_ENV, ADMINS_ENV];

/** Env overrides that drop {@link BRIDGE_ONLY_ENV} (for mergeProcessEnv). */
export function withoutBridgeOnlyEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(BRIDGE_ONLY_ENV.map((key) => [key, undefined]));
}
