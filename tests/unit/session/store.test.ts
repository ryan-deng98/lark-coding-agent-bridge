import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SessionStore Claude login dir', () => {
  it('resumes only sessions recorded under the same Claude config dir, across reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-store-'));
    dirs.push(dir);
    const path = join(dir, 'sessions.json');
    const store = new SessionStore(path);

    store.set('host-chat', 'sess-host', '/repo');
    store.set('bot-chat', 'sess-bot', '/repo', '/state/bot/claude-code');

    expect(store.resumeFor('host-chat', '/repo')).toBe('sess-host');
    expect(store.resumeFor('host-chat', '/repo', '/state/bot/claude-code')).toBeUndefined();
    expect(store.resumeFor('bot-chat', '/repo', '/state/bot/claude-code')).toBe('sess-bot');
    expect(store.resumeFor('bot-chat', '/repo')).toBeUndefined();

    await store.flush();
    const reloaded = new SessionStore(path);
    await reloaded.load();

    expect(reloaded.resumeFor('bot-chat', '/repo', '/state/bot/claude-code')).toBe('sess-bot');
    expect(reloaded.getRaw('host-chat')).not.toHaveProperty('claudeConfigDir');
  });
});
