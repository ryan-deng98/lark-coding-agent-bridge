import { chmod, chown, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths } from '../config/app-paths';
import { KEYSTORE_SECRET_ENV } from '../config/keystore';
import type { AppConfig, ProviderConfig, SecretRef, SecretsConfig } from '../config/schema';
import { isSecretRef } from '../config/schema';
import { ensureSecretsGetterWrapper } from '../config/store';
import { botUserFor, shareWithBotUser, type BotUser } from '../runtime/bot-user';
import { writeFileAtomic } from '../platform/atomic-write';

export async function writeLarkCliSourceProjection(
  cfg: AppConfig,
  appPaths: Pick<
    AppPaths,
    | 'rootDir'
    | 'profile'
    | 'larkCliSourceDir'
    | 'larkCliSourceConfigFile'
    | 'secretsGetterScript'
  >,
): Promise<string> {
  // Multi-user mode: the bot's own lark-cli, running as its bot user, reads this.
  const botUser = botUserFor(appPaths.rootDir, appPaths.profile);
  const dirMode = botUser ? 0o750 : 0o700;
  await mkdir(appPaths.larkCliSourceDir, { recursive: true, mode: dirMode });
  await chmod(appPaths.larkCliSourceDir, dirMode).catch(() => {});

  const secrets = await buildProjectionSecrets(cfg, appPaths, botUser);
  const projection = {
    accounts: {
      app: {
        id: cfg.accounts.app.id,
        secret: cfg.accounts.app.secret,
        tenant: cfg.accounts.app.tenant,
      },
    },
    ...(secrets ? { secrets } : {}),
  };

  await writeFileAtomic(appPaths.larkCliSourceConfigFile, `${JSON.stringify(projection, null, 2)}\n`, {
    mode: 0o600,
  });
  if (botUser) await shareWithBotUser(appPaths.larkCliSourceConfigFile, botUser);
  return appPaths.larkCliSourceConfigFile;
}

async function buildProjectionSecrets(
  cfg: AppConfig,
  appPaths: Pick<AppPaths, 'rootDir' | 'profile' | 'secretsGetterScript' | 'larkCliSourceDir'>,
  botUser: BotUser | undefined,
): Promise<SecretsConfig | undefined> {
  const providers: Record<string, ProviderConfig> = {
    ...(cfg.secrets?.providers ?? {}),
  };
  const providerName = bridgeProviderName(cfg.accounts.app.secret);
  if (providerName) {
    const wrapperPath = botUser
      ? await ensureBotSecretsGetter(appPaths, botUser)
      : await ensureSecretsGetterWrapper(appPaths);
    const existing = providers[providerName];
    providers[providerName] = {
      ...(existing ?? {}),
      source: 'exec',
      command: wrapperPath,
      args: [],
      env: {
        ...(existing?.env ?? {}),
        LARK_CHANNEL_HOME: appPaths.rootDir,
        LARK_CHANNEL_PROFILE: appPaths.profile,
      },
      // Exec providers run with a clean env. Where the keystore key comes from
      // this variable (a container), the getter needs it to decrypt; pass it by
      // name so the secret itself is never written into this file.
      passEnv: [...new Set([...(existing?.passEnv ?? []), KEYSTORE_SECRET_ENV])],
    };
  }

  if (Object.keys(providers).length === 0 && !cfg.secrets?.defaults) return undefined;
  return {
    ...(cfg.secrets?.defaults ? { defaults: cfg.secrets.defaults } : {}),
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
  };
}

/**
 * lark-cli only runs an exec provider owned by its own user, so each bot user
 * gets its own copy of the secrets getter. It sits in the bridge-written source
 * dir, which the bot can't write, so the bot can't swap it for a link; owning
 * the file only lets it change what its own lark-cli runs as itself. The bridge
 * never runs this copy.
 */
async function ensureBotSecretsGetter(
  appPaths: Pick<AppPaths, 'rootDir' | 'larkCliSourceDir'>,
  botUser: BotUser,
): Promise<string> {
  const path = join(appPaths.larkCliSourceDir, 'secrets-getter');
  await ensureSecretsGetterWrapper({ secretsGetterScript: path, rootDir: appPaths.rootDir });
  await chown(path, botUser.uid, botUser.gid);
  await chmod(path, 0o700);
  return path;
}

function bridgeProviderName(secret: AppConfig['accounts']['app']['secret']): string | undefined {
  if (!isSecretRef(secret)) return undefined;
  if (secret.source !== 'exec') return undefined;
  const ref = secret as SecretRef;
  return ref.provider ?? 'default';
}
