/**
 * 09-12 子4 W6（design §4.3/§8）：agy MCP 工具桥运行期可见性——dispatcher 面测试。
 *
 * 覆盖：
 * - `parseAgyBridgeConsentError`：前缀三态解析（missing-consent / conflict+rules /
 *   declined）+ 非前缀错误不误吞。
 * - agentEvents `error` case 的桥同意拦截：前缀错误 → agyBridgeStore.ask 开（declined
 *   不开——AC6 不再征询）+ agentError 落人话键（前缀串不直出）；非前缀错误行为零变化。
 * - agentEvents `bridge-notice` case：三信号 per-session 写入（cap）/ 最小测试 store
 *   缺省字段不写不炸。
 * - AgentPanel 渲染面：soft-denied 通知条可见（运行阶段可见性纪律：不静默）。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent } from '../src/shared/api/agent';

import {
  handleAgentStreamEvent,
  __clearAgentEventTracks,
  BRIDGE_NOTICE_CAP,
  type AgentDispatchState,
  type AgentStreamWireEvent,
} from '../src/shared/store/agentEvents';
import {
  __resetAgyBridgeStoreForTest,
  parseAgyBridgeConsentError,
  useAgyBridgeStore,
} from '../src/shared/store/agyBridgeStore';
import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { useAppStore } from '../src/shared/store/appStore';

// ── Part 1：dispatcher case（最小 store，mirror agentContextUsageBar 先例）──

type BridgeTestState = AgentDispatchState & Record<string, unknown>;

const useBridgeStore = create<BridgeTestState>()((set) => ({
  agentSessionId: 's1',
  agentMessages: [],
  activeSessionRunning: false,
  agentError: null,
  currentProject: { path: 'I:/p' },
  agentRunStates: {},
  chainRunBySession: {},
  chainRunAnchorByProject: {},
  bridgeNoticesBySession: {},
  setAgentRunState: vi.fn(),
  setPendingToolConfirm: vi.fn(),
  pushPendingDiff: vi.fn(),
  setPausedReview: vi.fn(),
  setPendingPatch: vi.fn(),
  fieldMetadata: {},
  set,
}));

function dispatchError(message: string, sessionId = 's1'): void {
  handleAgentStreamEvent(useBridgeStore, {
    type: 'error',
    data: { message },
    sessionId,
    projectPath: 'I:/p',
  } as AgentStreamWireEvent);
}

function dispatchNotice(notice: 'sendback' | 'sendback-missed' | 'soft-denied', sessionId = 's1'): void {
  handleAgentStreamEvent(useBridgeStore, {
    type: 'bridge-notice',
    data: { notice },
    sessionId,
    projectPath: 'I:/p',
  } as AgentStreamWireEvent);
}

beforeEach(() => {
  __clearAgentEventTracks();
  __resetAgyBridgeStoreForTest();
  (window as unknown as { orisonDesktop: unknown }).orisonDesktop = { abortAgentRun: vi.fn() };
  useBridgeStore.setState({ agentSessionId: 's1', agentError: null, bridgeNoticesBySession: {} });
});

afterEach(() => cleanup());

describe('parseAgyBridgeConsentError（前缀解析）', () => {
  it('missing-consent 形态', () => {
    expect(parseAgyBridgeConsentError('agy_bridge_consent|state=missing-consent')).toEqual({
      state: 'missing-consent',
      conflicts: [],
    });
  });

  it('conflict 形态带 rules 原文', () => {
    expect(
      parseAgyBridgeConsentError('agy_bridge_consent|state=conflict|rules=mcp(novel-writing/*);mcp(*)'),
    ).toEqual({
      state: 'conflict',
      conflicts: ['mcp(novel-writing/*)', 'mcp(*)'],
    });
  });

  it('rules 编码 round-trip（CR-7）：用户规则含分隔符也不损坏 + 坏转义不炸', () => {
    // 生产侧（AgyBridgeConsentRequiredError）逐条 encodeURIComponent 后 join(';')。
    const nasty = ['mcp(novel-writing/write_chapter); rm -rf', 'mcp(a)|state=hacked'];
    const encoded = nasty.map((r) => encodeURIComponent(r)).join(';');
    expect(
      parseAgyBridgeConsentError(`agy_bridge_consent|state=conflict|rules=${encoded}`),
    ).toEqual({ state: 'conflict', conflicts: nasty });
    // 坏转义序列（畸形前缀串）按原文回退——分发面不炸。
    expect(
      parseAgyBridgeConsentError('agy_bridge_consent|state=conflict|rules=mcp(%ZZ)'),
    ).toEqual({ state: 'conflict', conflicts: ['mcp(%ZZ)'] });
  });

  it('declined 形态（turn 硬门 CR-27 三态全发）', () => {
    expect(parseAgyBridgeConsentError('agy_bridge_consent|state=declined')).toEqual({
      state: 'declined',
      conflicts: [],
    });
  });

  it('非前缀错误不误吞', () => {
    expect(parseAgyBridgeConsentError('some other failure')).toBeNull();
    expect(parseAgyBridgeConsentError('agy_bridge_consent|state=unknown-state')).toBeNull();
  });
});

describe('agentEvents error case 桥同意拦截', () => {
  it('missing-consent 前缀 → 同意对话框 ask 开 + agentError 人话键（前缀串不直出）', () => {
    dispatchError('agy_bridge_consent|state=missing-consent');
    expect(useAgyBridgeStore.getState().ask).toEqual({ state: 'missing-consent', conflicts: [] });
    expect(useBridgeStore.getState().agentError).toBe('agent.bridgeConsentNeeded');
  });

  it('conflict 前缀 → ask 带冲突规则原文', () => {
    dispatchError('agy_bridge_consent|state=conflict|rules=mcp(novel-writing/*)');
    expect(useAgyBridgeStore.getState().ask).toEqual({
      state: 'conflict',
      conflicts: ['mcp(novel-writing/*)'],
    });
    expect(useBridgeStore.getState().agentError).toBe('agent.bridgeConsentConflict');
  });

  it('declined 前缀 → 不开对话框（AC6：已拒绝不再征询）+ declined 人话键', () => {
    dispatchError('agy_bridge_consent|state=declined');
    expect(useAgyBridgeStore.getState().ask).toBeNull();
    expect(useBridgeStore.getState().agentError).toBe('agent.bridgeConsentDeclined');
  });

  it('非前缀错误 → agentError 原文照旧（零回归）', () => {
    dispatchError('generateText not initialized');
    expect(useAgyBridgeStore.getState().ask).toBeNull();
    expect(useBridgeStore.getState().agentError).toBe('generateText not initialized');
  });
});

describe('agentEvents bridge-notice case（三信号运行期可见性）', () => {
  it('三信号各写一条 per-session 通知（顺序保留）', () => {
    dispatchNotice('soft-denied');
    dispatchNotice('sendback');
    dispatchNotice('sendback-missed');
    const notices = useBridgeStore.getState().bridgeNoticesBySession!['s1'];
    expect(notices).toHaveLength(3);
    expect(notices!.map((n) => n.notice)).toEqual(['soft-denied', 'sendback', 'sendback-missed']);
  });

  it('cap 截断（BRIDGE_NOTICE_CAP）', () => {
    for (let i = 0; i < BRIDGE_NOTICE_CAP + 3; i++) dispatchNotice('soft-denied');
    expect(useBridgeStore.getState().bridgeNoticesBySession!['s1']).toHaveLength(BRIDGE_NOTICE_CAP);
  });

  it('最小测试 store 缺省字段 → 不写不炸', () => {
    const bare = create<Record<string, unknown>>((set) => ({
      agentSessionId: 's1',
      agentMessages: [],
      activeSessionRunning: false,
      agentError: null,
      currentProject: { path: 'I:/p' },
      agentRunStates: {},
      setAgentRunState: vi.fn(),
      setPendingToolConfirm: vi.fn(),
      pushPendingDiff: vi.fn(),
      setPausedReview: vi.fn(),
      setPendingPatch: vi.fn(),
      fieldMetadata: {},
      set,
    }));
    expect(() =>
      handleAgentStreamEvent(bare as unknown as Parameters<typeof handleAgentStreamEvent>[0], {
        type: 'bridge-notice',
        data: { notice: 'sendback' },
        sessionId: 's1',
      } as AgentStreamWireEvent),
    ).not.toThrow();
  });
});

// ── Part 2：AgentPanel 通知条渲染（真 appStore，mirror agentContextUsageBar seed 模式）──

function seedPanelStore(
  notices: Record<string, { id: string; notice: string; at: number }[]>,
): void {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    agentMessages: [],
    agentSkills: [],
    agentSkillError: null,
    loadAgentSkills: vi.fn().mockResolvedValue(undefined),
    skillPackages: [],
    skillPackagesLoading: false,
    loadSkillPackages: vi.fn().mockResolvedValue(undefined),
    toggleSkillPackage: vi.fn(),
    toggleSkill: vi.fn(),
    agentParticipationGear: 'smart',
    pendingAttachments: [],
    attachmentUploadStates: {},
    uploadInboxFiles: vi.fn().mockResolvedValue(undefined),
    uploadChatImages: vi.fn().mockResolvedValue(undefined),
    bridgeNoticesBySession: notices,
  } as any);
}

describe('AgentPanel 桥通知条渲染（W6 可见性）', () => {
  it('soft-denied → 通知条可见且指向授权机制（AC7）', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'soft-denied', at: 1 }],
    });
    render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice--warn');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('授权策略拦下');
    expect(strip!.textContent).toContain('MCP 工具桥');
  });

  it('sendback（中性）→ 可见；无通知 → 不渲染', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'sendback', at: 1 }],
    });
    const { unmount } = render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('打回重跑');
    unmount();

    seedPanelStore({});
    render(<AgentPanel />);
    expect(document.querySelector('.agent-bridge-notice')).toBeNull();
  });
});
