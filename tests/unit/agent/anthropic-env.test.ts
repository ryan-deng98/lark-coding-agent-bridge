import { describe, expect, it } from 'vitest';
import { buildAnthropicAuthEnv, buildClaudeLoginEnv } from '../../../src/agent/claude/anthropic-env';
import { mergeProcessEnv } from '../../../src/platform/spawn';

describe('buildAnthropicAuthEnv', () => {
  it('pins the profile key and clears credentials Claude Code would rank above it', () => {
    const merged = mergeProcessEnv(
      {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-host',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_USE_FOUNDRY: '1',
      },
      buildAnthropicAuthEnv('sk-ant-api03-profile'),
    );

    expect(merged.ANTHROPIC_API_KEY).toBe('sk-ant-api03-profile');
    expect(merged.PATH).toBe('/usr/bin');
    for (const key of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]) {
      expect(merged).not.toHaveProperty(key);
    }
  });
});

describe('buildClaudeLoginEnv', () => {
  it("points claude at the bot's own login dir and clears every credential that outranks it", () => {
    const merged = mergeProcessEnv(
      {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/Users/me/.claude',
        ANTHROPIC_API_KEY: 'sk-ant-host',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-host',
        ANTHROPIC_PROFILE: 'work',
        CLAUDE_CODE_USE_VERTEX: '1',
      },
      buildClaudeLoginEnv('/state/bot/claude-code'),
    );

    expect(merged.CLAUDE_CONFIG_DIR).toBe('/state/bot/claude-code');
    expect(merged.PATH).toBe('/usr/bin');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_PROFILE',
      'CLAUDE_CODE_USE_VERTEX',
    ]) {
      expect(merged).not.toHaveProperty(key);
    }
  });
});
