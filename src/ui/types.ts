import type { LarkChannel } from '@larksuite/channel';
import type { KnownChat } from '../bot/lark-info';
import type { ClaudeLoginChecker } from '../agent/claude/login-status';
import type { LarkFetch, LoginConfig } from './console-auth';
import type { AnthropicKeyValidator } from '../config/anthropic-account';
import type { MutableProfileState } from '../config/config-ops';
import type { Controls } from '../commands';
import type { ManagedStatus } from '../runtime/supervisor';

/**
 * The live per-profile runtime the console edits. The supervisor's `Controls`
 * for an online profile structurally satisfies this, so the console reads/writes
 * config through the same `config-ops` logic the chat `/config` form uses, and
 * changes apply live for any online profile.
 */
export interface UiRuntime extends MutableProfileState {
  botOwnerId?: string;
  knownChats?: KnownChat[];
  refreshOwner(channel?: LarkChannel): Promise<void>;
  restart(opts?: { wait?: boolean }): Promise<void>;
}

/** The subset of the supervisor the console needs (structurally satisfied). */
export interface UiSupervisor {
  isOnline(profile: string): boolean;
  controlsFor(profile: string): Controls | undefined;
  channelFor(profile: string): LarkChannel | undefined;
  list(): ManagedStatus[];
  startProfile(profile: string): Promise<void>;
  stopProfile(profile: string): Promise<void>;
  restartProfile(profile: string): Promise<void>;
}

/** Everything the console server needs from the supervisor host. */
export interface UiServerDeps {
  supervisor: UiSupervisor;
  /** Bridge version string (for the status endpoint). */
  version: string;
  /** Config root dir (LARK_CHANNEL_HOME); undefined = default. */
  rootDir?: string;
  /** Bind host; defaults to 127.0.0.1. */
  host?: string;
  /** Bind port; 0 (default) picks an ephemeral port. */
  port?: number;
  /** Pinned console token; default is a random per-process token. */
  token?: string;
  /** Hostnames accepted in Host/Origin besides localhost (a deployment's public domain). */
  allowedHosts?: string[];
  /** Per-person "Sign in with Lark" for a shared console; off when undefined. */
  login?: LoginConfig;
  /** Calls to Lark's OAuth endpoints; defaults to fetch. Injected by tests. */
  larkFetch?: LarkFetch;
  /** Anthropic key check; defaults to a live `GET /v1/models`. Injected by tests. */
  validateAnthropicApiKey?: AnthropicKeyValidator;
  /** Claude login check; defaults to `claude auth status`. Injected by tests. */
  checkClaudeLogin?: ClaudeLoginChecker;
}

export interface UiServerHandle {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}
