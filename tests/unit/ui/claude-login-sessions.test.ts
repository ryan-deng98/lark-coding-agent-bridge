import { describe, expect, it } from 'vitest';
import type { ClaudeWebLogin } from '../../../src/agent/claude/web-login';
import { ClaudeLoginSessions } from '../../../src/ui/claude-login-sessions';

function fakeLogin(): ClaudeWebLogin {
  return {
    url: 'https://claude.com/cai/oauth/authorize?code=true',
    submit: async () => {},
    cancel: () => {},
    closed: new Promise<void>(() => {}),
  };
}

const neverOpens = () => new Promise<ClaudeWebLogin>(() => {});

describe('ClaudeLoginSessions', () => {
  it('prepares one sign-in per bot at a time, so a burst of clicks starts one process', async () => {
    const sessions = new ClaudeLoginSessions();
    let opened = 0;
    let release: (login: ClaudeWebLogin) => void = () => {};
    const open = () => {
      opened += 1;
      return new Promise<ClaudeWebLogin>((resolve) => (release = resolve));
    };

    const first = sessions.start('alice-bot', 'user:on_alice', open);
    const burst = await Promise.allSettled([1, 2, 3].map(() => sessions.start('alice-bot', 'user:on_alice', open)));
    release(fakeLogin());

    expect(opened).toBe(1);
    expect(burst.map((r) => r.status === 'rejected' && (r.reason as { status?: number }).status)).toEqual([429, 429, 429]);
    await expect(first).resolves.toMatchObject({ url: 'https://claude.com/cai/oauth/authorize?code=true' });
  });

  it('counts sign-ins still being prepared against the cap', async () => {
    const sessions = new ClaudeLoginSessions();
    for (let i = 0; i < 20; i++) void sessions.start(`bot-${i}`, 'user:on_alice', neverOpens);

    await expect(sessions.start('bot-20', 'user:on_alice', async () => fakeLogin())).rejects.toMatchObject({
      status: 429,
    });
  });
});
