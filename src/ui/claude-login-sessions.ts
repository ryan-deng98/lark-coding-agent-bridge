import { randomBytes } from 'node:crypto';
import type { ClaudeWebLogin } from '../agent/claude/web-login';
import { HttpError } from './http';

// More sign-ins in flight than this is someone hammering the button.
const MAX_PENDING = 20;

interface Pending {
  profile: string;
  startedBy: string;
  login: ClaudeWebLogin;
}

/**
 * Claude sign-ins in progress from the console, each bound to its bot and to
 * whoever started it: only they may hand it the code, and only once. One per
 * bot — starting again replaces the previous attempt.
 */
export class ClaudeLoginSessions {
  private readonly pending = new Map<string, Pending>();
  // Bots whose `claude auth login` is still starting. They hold a slot from
  // before the process is spawned, or a burst of starts would each spawn one.
  private readonly opening = new Set<string>();

  async start(
    profile: string,
    startedBy: string,
    open: () => Promise<ClaudeWebLogin>,
  ): Promise<{ sessionId: string; url: string }> {
    if (this.opening.has(profile)) throw new HttpError(429, '上一次 Claude 登录还在准备，请稍等几秒再试');
    this.dropProfile(profile);
    if (this.pending.size + this.opening.size >= MAX_PENDING) {
      throw new HttpError(429, '同时进行的 Claude 登录太多了，请稍后再试');
    }
    this.opening.add(profile);
    let login: ClaudeWebLogin;
    try {
      login = await open();
    } finally {
      this.opening.delete(profile);
    }
    const sessionId = randomBytes(16).toString('base64url');
    this.pending.set(sessionId, { profile, startedBy, login });
    // Expired and cancelled attempts leave by themselves.
    void login.closed.then(() => {
      if (this.pending.get(sessionId)?.login === login) this.pending.delete(sessionId);
    });
    return { sessionId, url: login.url };
  }

  /** Take the attempt for its one code; unknown, someone else's or used-up attempts are a 404. */
  claim(sessionId: string, profile: string, startedBy: string): ClaudeWebLogin {
    const attempt = this.pending.get(sessionId);
    if (!attempt || attempt.profile !== profile || attempt.startedBy !== startedBy) {
      throw new HttpError(404, '这次 Claude 登录已失效，请重新点「连接我的 Claude 账号」');
    }
    this.pending.delete(sessionId);
    return attempt.login;
  }

  cancel(sessionId: string, profile: string, startedBy: string): void {
    this.claim(sessionId, profile, startedBy).cancel();
  }

  private dropProfile(profile: string): void {
    for (const [id, attempt] of this.pending) {
      if (attempt.profile !== profile) continue;
      this.pending.delete(id);
      attempt.login.cancel();
    }
  }
}
