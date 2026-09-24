// Someone who messages a bot that isn't theirs gets pointed at the console
// (on a shared deployment) instead of silence — at most once per chat per
// interval, so the hint can't be used to make a bot spam.
const DEFAULT_INTERVAL_MS = 12 * 3600_000;
const DEFAULT_MAX_KEYS = 1000;

export function nonAllowedDmHint(consoleUrl: string): string {
  return (
    '这是别人的私人 AI 助手，只回复它的主人。\n' +
    `想要你自己的 AI 助手：用电脑打开 ${consoleUrl} ，点「用 Lark 登录」，按提示扫码创建。`
  );
}

export class HintThrottle {
  // Insertion order doubles as recency: a key is re-inserted when it is hinted.
  private readonly sentAt = new Map<string, number>();

  constructor(
    private readonly opts: { intervalMs: number; maxKeys: number } = {
      intervalMs: DEFAULT_INTERVAL_MS,
      maxKeys: DEFAULT_MAX_KEYS,
    },
  ) {}

  get size(): number {
    return this.sentAt.size;
  }

  /** True, and remembered, when `key` has not been hinted within the interval. */
  take(key: string, now: number = Date.now()): boolean {
    const last = this.sentAt.get(key);
    if (last !== undefined && now - last < this.opts.intervalMs) return false;
    this.sentAt.delete(key);
    this.sentAt.set(key, now);
    for (const oldest of this.sentAt.keys()) {
      if (this.sentAt.size <= this.opts.maxKeys) break;
      this.sentAt.delete(oldest);
    }
    return true;
  }
}
