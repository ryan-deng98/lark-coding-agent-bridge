import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isAllowedHostRequest } from '../../../src/ui/http';

const DOMAIN = 'bridge.up.railway.app';
const PUBLIC: ReadonlySet<string> = new Set([DOMAIN]);

function req(headers: { host?: string; origin?: string }): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('isAllowedHostRequest', () => {
  it.each(['127.0.0.1:8080', 'localhost:8080', 'LOCALHOST', '[::1]:8080'])(
    'accepts the loopback Host %s',
    (host) => {
      expect(isAllowedHostRequest(req({ host }))).toBe(true);
    },
  );

  it('accepts an allowed public domain as Host and Origin', () => {
    expect(isAllowedHostRequest(req({ host: DOMAIN, origin: `https://${DOMAIN}` }), PUBLIC)).toBe(true);
    expect(isAllowedHostRequest(req({ host: `${DOMAIN}:443` }), PUBLIC)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['foreign', 'evil.example.com'],
    ['userinfo', `${DOMAIN}@evil.example.com`],
    ['path', 'localhost/evil'],
    ['whitespace', 'local host'],
  ])('refuses a %s Host', (_kind, host) => {
    expect(isAllowedHostRequest(req({ host }), PUBLIC)).toBe(false);
  });

  it.each(['https://evil.example.com', 'null'])(
    'refuses the Origin %s even with an allowed Host',
    (origin) => {
      expect(isAllowedHostRequest(req({ host: DOMAIN, origin }), PUBLIC)).toBe(false);
    },
  );

  it('does not accept a public domain unless it was allowed', () => {
    expect(isAllowedHostRequest(req({ host: DOMAIN }))).toBe(false);
  });
});
