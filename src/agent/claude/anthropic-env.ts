/**
 * Host settings that outrank or redirect the credential a bot's own account
 * should use (Claude Code order: cloud-provider switches, ANTHROPIC_AUTH_TOKEN,
 * ANTHROPIC_API_KEY, apiKeyHelper, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_PROFILE,
 * then the `/login` credential). ANTHROPIC_BASE_URL would send the credential
 * to some other endpoint. `undefined` values delete the key in `mergeProcessEnv`.
 */
const OUTRANKING_CREDENTIALS: NodeJS.ProcessEnv = {
  ANTHROPIC_AUTH_TOKEN: undefined,
  ANTHROPIC_BASE_URL: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
  CLAUDE_CODE_USE_VERTEX: undefined,
  CLAUDE_CODE_USE_FOUNDRY: undefined,
};

/**
 * Env overrides that make a spawned `claude -p` authenticate with the bot's own
 * Anthropic API key. In `-p` mode Claude Code always uses ANTHROPIC_API_KEY when
 * set; only the settings above outrank or redirect it.
 */
export function buildAnthropicAuthEnv(apiKey: string): NodeJS.ProcessEnv {
  return { ...OUTRANKING_CREDENTIALS, ANTHROPIC_API_KEY: apiKey };
}

/**
 * Env overrides that make a spawned `claude` run on the bot's own Claude Code
 * config dir, so it uses the Claude account signed in there (`claude auth
 * login`) — its own Keychain entry, sessions and settings. Every env credential
 * would outrank that login, so all of them are cleared.
 */
export function buildClaudeLoginEnv(claudeConfigDir: string): NodeJS.ProcessEnv {
  return {
    ...OUTRANKING_CREDENTIALS,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_PROFILE: undefined,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}
