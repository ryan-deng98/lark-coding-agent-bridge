import { join } from 'node:path';
import { botUserEnv, botUserFor, botUsersEnabled } from '../runtime/bot-user';
import { withoutBridgeOnlyEnv } from '../runtime/bridge-env';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

/**
 * Env overrides for a process that works on behalf of one profile (its agent,
 * its lark-cli). Never carries the console token: agents run with broad
 * permissions, and the token controls every bot. In multi-user mode the
 * process also gets its bot user's own HOME and temp dir.
 */
export function buildLarkChannelEnv(context?: LarkChannelEnvContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
    ...withoutBridgeOnlyEnv(),
  };
  const botUser = botUsersEnabled() ? botUserFor(context?.rootDir, context?.profile) : undefined;
  if (botUser) Object.assign(env, botUserEnv(botUser));
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  const configPath =
    nonEmpty(context?.larkCliSourceConfigFile) ??
    nonEmpty(context?.configPath) ??
    (rootDir ? join(rootDir, 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
