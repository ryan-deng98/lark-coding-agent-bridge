import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const MAX_BODY_BYTES = 256 * 1024;

const NO_EXTRA_HOSTS: ReadonlySet<string> = new Set();

/** The hostname a Host header names (IPv6 keeps its brackets), or '' if missing or malformed. */
function hostnameOf(value: string | undefined): string {
  if (!value || /[\s@/\\?#]/.test(value)) return '';
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return '';
  }
}

/**
 * Reject anything not addressed to localhost or an explicitly allowed host (a
 * cloud deployment's public domain), and any request from another origin —
 * so a DNS-rebinding page can't reach the console under a hostname we didn't pick.
 * A missing or malformed Host is refused too, so the allow-list can't be skipped.
 */
export function isAllowedHostRequest(
  req: IncomingMessage,
  allowedHosts: ReadonlySet<string> = NO_EXTRA_HOSTS,
): boolean {
  const isAllowed = (h: string): boolean => LOCALHOST_HOSTS.has(h) || allowedHosts.has(h);
  const host = hostnameOf(req.headers.host);
  if (!host || !isAllowed(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!isAllowed(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Constant-time token check against `x-ui-token` header or `?token=`. */
export function checkToken(req: IncomingMessage, url: URL, token: string): boolean {
  const provided =
    (req.headers['x-ui-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
  if (provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, html: string): void {
  send(res, 200, 'text/html; charset=utf-8', html);
}

export function sendJs(res: ServerResponse, js: string): void {
  send(res, 200, 'application/javascript; charset=utf-8', js);
}

/** HTTP-shaped error the servers turn into a JSON error response. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
