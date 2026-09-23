/**
 * Where the console listens and who may reach it, from the environment.
 *
 * Unset (the default), the console is loopback-only with a random
 * per-process token — unchanged from a local install. A cloud deployment
 * (Railway, Docker) binds all interfaces, allows its public domain in the
 * Host/Origin check, and pins the token so the console link survives restarts.
 */

export const UI_HOST_ENV = 'LARK_CHANNEL_UI_HOST';
export const UI_PORT_ENV = 'LARK_CHANNEL_UI_PORT';
export const UI_TOKEN_ENV = 'LARK_CHANNEL_UI_TOKEN';
export const UI_ALLOWED_HOSTS_ENV = 'LARK_CHANNEL_UI_ALLOWED_HOSTS';

const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MIN_TOKEN_LEN = 32;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const TOKEN_HINT = '(generate one with `openssl rand -hex 32`)';

export interface UiExposure {
  host: string;
  /** Undefined → an ephemeral port. */
  port?: number;
  /** Pinned console token; undefined → random per process. */
  token?: string;
  /** Hostnames accepted besides localhost (e.g. the deployment's public domain). */
  allowedHosts: string[];
  /** The console's public base URL, when a public hostname is configured. */
  publicUrl?: string;
}

export function resolveUiExposure(env: NodeJS.ProcessEnv = process.env): UiExposure {
  const host = env[UI_HOST_ENV]?.trim() || DEFAULT_HOST;
  const port = parsePort(env[UI_PORT_ENV]);
  const token = parseToken(env[UI_TOKEN_ENV]);
  const allowedHosts = parseAllowedHosts(env[UI_ALLOWED_HOSTS_ENV]);

  if (!LOOPBACK_HOSTS.has(host) && !token) {
    throw new Error(
      `${UI_HOST_ENV}=${host} exposes the console beyond this machine; ` +
        `set ${UI_TOKEN_ENV} (at least ${MIN_TOKEN_LEN} characters) ${TOKEN_HINT}`,
    );
  }

  const publicHost = allowedHosts[0];
  return {
    host,
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
    allowedHosts,
    ...(publicHost ? { publicUrl: `https://${publicHost}/` } : {}),
  };
}

function parsePort(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`${UI_PORT_ENV} must be a port number (1-65535), got "${value}"`);
  }
  return port;
}

function parseToken(raw: string | undefined): string | undefined {
  // A pasted value often carries a trailing newline; that's not part of the token.
  const token = raw?.trim();
  if (!token) return undefined;
  if (token.length < MIN_TOKEN_LEN || /\s/.test(token)) {
    throw new Error(
      `${UI_TOKEN_ENV} must be at least ${MIN_TOKEN_LEN} characters with no whitespace ${TOKEN_HINT}`,
    );
  }
  return token;
}

function parseAllowedHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of hosts) {
    if (!HOSTNAME_RE.test(h)) {
      throw new Error(
        `${UI_ALLOWED_HOSTS_ENV} takes bare hostnames (e.g. my-bridge.up.railway.app), got "${h}"`,
      );
    }
  }
  return [...new Set(hosts)];
}
