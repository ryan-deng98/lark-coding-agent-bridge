import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  validateAnthropicApiKey,
  type AnthropicClientFactory,
} from '../../../src/utils/anthropic-auth';

const KEY = 'sk-ant-api03-test';

function rejectingWith(err: unknown): AnthropicClientFactory {
  return () => ({ models: { list: () => Promise.reject(err) } });
}

function apiErrorBody(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

describe('validateAnthropicApiKey', () => {
  it('accepts a key when the free models listing succeeds', async () => {
    const keys: string[] = [];
    const list = vi.fn(async () => ({ data: [] }));
    const result = await validateAnthropicApiKey(KEY, (apiKey) => {
      keys.push(apiKey);
      return { models: { list } };
    });

    expect(result).toEqual({ ok: true });
    expect(keys).toEqual([KEY]);
    expect(list).toHaveBeenCalledWith({ limit: 1 });
  });

  it('reports an invalid or revoked key on 401', async () => {
    const err = new Anthropic.AuthenticationError(
      401,
      apiErrorBody('authentication_error', 'invalid x-api-key'),
      'invalid x-api-key',
      new Headers(),
    );
    expect(await validateAnthropicApiKey(KEY, rejectingWith(err))).toEqual({
      ok: false,
      reason: expect.stringContaining('无效'),
    });
  });

  it('reports a missing permission on 403', async () => {
    const err = new Anthropic.PermissionDeniedError(
      403,
      apiErrorBody('permission_error', 'forbidden'),
      'forbidden',
      new Headers(),
    );
    expect(await validateAnthropicApiKey(KEY, rejectingWith(err))).toEqual({
      ok: false,
      reason: expect.stringContaining('权限'),
    });
  });

  it('treats a rate-limited key as valid because it authenticated', async () => {
    const err = new Anthropic.RateLimitError(
      429,
      apiErrorBody('rate_limit_error', 'slow down'),
      'slow down',
      new Headers(),
    );
    expect(await validateAnthropicApiKey(KEY, rejectingWith(err))).toEqual({ ok: true });
  });

  it('reports a timeout separately from other network failures', async () => {
    const timeout = await validateAnthropicApiKey(
      KEY,
      rejectingWith(new Anthropic.APIConnectionTimeoutError()),
    );
    expect(timeout).toEqual({ ok: false, reason: expect.stringContaining('超时') });

    const offline = await validateAnthropicApiKey(
      KEY,
      rejectingWith(new Anthropic.APIConnectionError({ message: 'Connection error.' })),
    );
    expect(offline).toEqual({ ok: false, reason: expect.stringContaining('网络') });
  });

  it('never throws, even when the client cannot be built', async () => {
    const result = await validateAnthropicApiKey(KEY, () => {
      throw new Error('boom');
    });
    expect(result).toEqual({ ok: false, reason: 'boom' });
  });
});
