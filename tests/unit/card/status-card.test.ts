import { describe, expect, it } from 'vitest';
import { statusCard, type StatusInfo } from '../../../src/card/templates';

const base: StatusInfo = {
  profileName: 'claude',
  sessionStale: false,
  agentName: 'Claude Code',
  runtimeAccess: { label: '权限', value: 'full' },
  activeRun: false,
  ownerState: 'ok owner=present',
  scope: 'oc_test',
  chatMode: 'p2p',
};

describe('statusCard Anthropic account line', () => {
  it('shows which Anthropic account the bot runs on', () => {
    const card = JSON.stringify(statusCard({ ...base, anthropicAccount: '已连接 sk-ant-…WXYZ' }));
    expect(card).toContain('🔑 **Anthropic**: 已连接 sk-ant-…WXYZ');
  });

  it('omits the line for agents that do not use Anthropic', () => {
    expect(JSON.stringify(statusCard(base))).not.toContain('**Anthropic**');
  });
});
