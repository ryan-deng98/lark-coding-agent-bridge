import Anthropic from '@anthropic-ai/sdk';

/** Where a connected key is checked and used: Anthropic's own API, never an ambient proxy. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

const VALIDATE_TIMEOUT_MS = 15_000;

export type AnthropicKeyValidation = { ok: true } | { ok: false; reason: string };

/** The slice of the SDK client the check needs; injectable so tests stay offline. */
export interface AnthropicModelsClient {
  models: { list(params: { limit: number }): PromiseLike<unknown> };
}

export type AnthropicClientFactory = (apiKey: string) => AnthropicModelsClient;

const createClient: AnthropicClientFactory = (apiKey) =>
  new Anthropic({
    apiKey,
    // Pin the credential and endpoint: an ambient ANTHROPIC_AUTH_TOKEN or
    // ANTHROPIC_BASE_URL must not ride along with (or redirect) the user's key.
    authToken: null,
    baseURL: ANTHROPIC_API_BASE_URL,
    maxRetries: 1,
    timeout: VALIDATE_TIMEOUT_MS,
  });

/**
 * Check an Anthropic API key with a free `GET /v1/models` call — no tokens are
 * spent. Never throws; failures come back as a user-facing reason.
 */
export async function validateAnthropicApiKey(
  apiKey: string,
  factory: AnthropicClientFactory = createClient,
): Promise<AnthropicKeyValidation> {
  try {
    await factory(apiKey).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    // A 429 means the key authenticated and the org is just busy.
    if (err instanceof Anthropic.RateLimitError) return { ok: true };
    return { ok: false, reason: describeError(err) };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'API key 无效或已被吊销（401）';
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'API key 没有调用权限（403），请检查它所属 workspace 的设置';
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return '请求 Anthropic API 超时，请稍后重试';
  if (err instanceof Anthropic.APIConnectionError) return '连不上 Anthropic API，请检查网络或代理';
  if (err instanceof Anthropic.APIError) return `Anthropic API 返回 ${err.status ?? '错误'}：${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
