import { describe, expect, it } from 'vitest';
import { consolePublicUrl, resolveUiExposure } from '../../../src/ui/exposure';

describe('consolePublicUrl', () => {
  it("names the console's public address, and nothing when there is none", () => {
    expect(consolePublicUrl({ LARK_CHANNEL_UI_ALLOWED_HOSTS: 'bridge.up.railway.app' })).toBe(
      'https://bridge.up.railway.app/',
    );
    expect(consolePublicUrl({})).toBeUndefined();
    expect(consolePublicUrl({ LARK_CHANNEL_UI_ALLOWED_HOSTS: 'https://not-a-bare-host/' })).toBeUndefined();
  });
});

const TOKEN = 't'.repeat(64);

describe('resolveUiExposure', () => {
  it('defaults to a loopback-only console with a random token', () => {
    expect(resolveUiExposure({})).toEqual({ host: '127.0.0.1', allowedHosts: [] });
  });

  it('reads a cloud deployment: public bind, fixed port, pinned token, public domain', () => {
    const exposure = resolveUiExposure({
      LARK_CHANNEL_UI_HOST: '0.0.0.0',
      LARK_CHANNEL_UI_PORT: '8080',
      LARK_CHANNEL_UI_TOKEN: TOKEN,
      LARK_CHANNEL_UI_ALLOWED_HOSTS: ' Bridge.up.railway.app , bridge.example.com,,bridge.up.railway.app',
    });

    expect(exposure).toEqual({
      host: '0.0.0.0',
      port: 8080,
      token: TOKEN,
      allowedHosts: ['bridge.up.railway.app', 'bridge.example.com'],
      publicUrl: 'https://bridge.up.railway.app/',
    });
  });

  it('drops the trailing newline a pasted token often carries', () => {
    expect(resolveUiExposure({ LARK_CHANNEL_UI_TOKEN: `${TOKEN}\n` }).token).toBe(TOKEN);
  });

  it('refuses a public bind without a pinned token', () => {
    expect(() => resolveUiExposure({ LARK_CHANNEL_UI_HOST: '0.0.0.0' })).toThrow(
      /LARK_CHANNEL_UI_HOST=0\.0\.0\.0 exposes the console.*set LARK_CHANNEL_UI_TOKEN/,
    );
  });

  it.each([
    ['short', /at least 32 characters/],
    [`${'t'.repeat(40)} with space`, /no whitespace/],
  ])('rejects a weak token %#', (token, message) => {
    expect(() => resolveUiExposure({ LARK_CHANNEL_UI_TOKEN: token })).toThrow(message);
  });

  it.each(['0', '65536', '80a', '-1'])('rejects port %s', (port) => {
    expect(() => resolveUiExposure({ LARK_CHANNEL_UI_PORT: port })).toThrow(/must be a port number/);
  });

  it.each(['https://bridge.up.railway.app', 'bridge.up.railway.app:443', 'bridge/x'])(
    'rejects allowed host %s that is not a bare hostname',
    (host) => {
      expect(() => resolveUiExposure({ LARK_CHANNEL_UI_ALLOWED_HOSTS: host })).toThrow(
        /takes bare hostnames/,
      );
    },
  );
});
