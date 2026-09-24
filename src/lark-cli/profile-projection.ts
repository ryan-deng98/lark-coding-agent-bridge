import { chmod, mkdir } from 'node:fs/promises';
import type { AppPaths } from '../config/app-paths';
import { KEYSTORE_SECRET_ENV } from '../config/keystore';
import type { AppConfig, ProviderConfig, SecretRef, SecretsConfig } from '../config/schema';
import { isSecretRef } from '../config/schema';
import { ensureSecretsGetterWrapper } from '../config/store';
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
  await mkdir(appPaths.larkCliSourceDir, { recursive: true, mode: 0o700 });
  await chmod(appPaths.larkCliSourceDir, 0o700).catch(() => {});

  const secrets = await buildProjectionSecrets(cfg, appPaths);
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
  return appPaths.larkCliSourceConfigFile;
}

async function buildProjectionSecrets(
  cfg: AppConfig,
  appPaths: Pick<AppPaths, 'rootDir' | 'profile' | 'secretsGetterScript'>,
): Promise<SecretsConfig | undefined> {
  const providers: Record<string, ProviderConfig> = {
    ...(cfg.secrets?.providers ?? {}),
  };
  const providerName = bridgeProviderName(cfg.accounts.app.secret);
  if (providerName) {
    const wrapperPath = await ensureSecretsGetterWrapper(appPaths);
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

function bridgeProviderName(secret: AppConfig['accounts']['app']['secret']): string | undefined {
  if (!isSecretRef(secret)) return undefined;
  if (secret.source !== 'exec') return undefined;
  const ref = secret as SecretRef;
  return ref.provider ?? 'default';
}
