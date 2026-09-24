import { describe, expect, it } from 'vitest';
import { HintThrottle, nonAllowedDmHint } from '../../../src/bot/dm-hint';

describe('nonAllowedDmHint', () => {
  it('points someone messaging a bot that is not theirs at the console', () => {
    const text = nonAllowedDmHint('https://bridge.up.railway.app/');

    expect(text).toContain('https://bridge.up.railway.app/');
    expect(text).toContain('用 Lark 登录');
  });
});

describe('HintThrottle', () => {
  it('hints each chat at most once per interval', () => {
    const throttle = new HintThrottle({ intervalMs: 1000, maxKeys: 10 });

    expect(throttle.take('oc_a', 0)).toBe(true);
    expect(throttle.take('oc_a', 500)).toBe(false);
    expect(throttle.take('oc_b', 500)).toBe(true);
    expect(throttle.take('oc_a', 1500)).toBe(true);
  });

  it('forgets the oldest chats rather than growing without bound', () => {
    const throttle = new HintThrottle({ intervalMs: 1000, maxKeys: 2 });

    throttle.take('oc_a', 0);
    throttle.take('oc_b', 1);
    throttle.take('oc_c', 2);

    expect(throttle.size).toBe(2);
    expect(throttle.take('oc_a', 3)).toBe(true);
  });
});
