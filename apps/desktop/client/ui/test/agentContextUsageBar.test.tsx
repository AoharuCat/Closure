/**
 * 09-12 子5 R6（design §11）：leader 上下文余量条——UI 消费面。
 *
 * 覆盖：
 * - agentEvents `context-usage` case：per-session last 值写入 / 值等跳过重复写 /
 *   store 无字段（最小测试 store）不写不炸（mirror modelFallbackNotices 守卫）。
 * - AgentPanel 条三态：有快照 + 有窗口 → 条 + 百分比；≥红线 → is-redline 变色；
 *   windowTokens null（注入原值无窗口信息——不得显示假数）/ 无快照 → 条隐藏。
 *   「估算」小标 + title 千分位格式化 token 数。
 *
 * agent 侧事件源（loop.ts onContextUsage → streamMessage 接线）已落地（W3b）——
 * 本文件直接驱动 wire 事件（handleAgentStreamEvent / store seed），端到端行为由
 * 同型载荷保证（agent 侧发射面见 loop.contextUsage.test.ts）。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  handleAgentStreamEvent,
  __clearAgentEventTracks,
  type AgentDispatchState,
  type AgentStreamWireEvent,
  type ContextUsageSnapshot,
} from '../src/shared/store/agentEvents';
import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { useAppStore } from '../src/shared/store/appStore';

// ── Part 1：dispatcher case（最小 store，mirror agentEventsDispatch 先例）──

type CtxTestState = AgentDispatchState & Record<string, unknown>;

const useCtxStore = create<CtxTestState>()((set) => ({
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
  contextUsageBySession: {},
  set,
}));

function dispatchContextUsage(
  data: { usedTokens: number; windowTokens: number | null; redlinePercent: number },
  sessionId = 's1',
): void {
  handleAgentStreamEvent(useCtxStore, {
    type: 'context-usage',
    data,
    sessionId,
    projectPath: 'I:/p',
  } as AgentStreamWireEvent);
}

beforeEach(() => {
  __clearAgentEventTracks();
  useCtxStore.setState({ agentSessionId: 's1', contextUsageBySession: {} });
});

describe('agentEvents context-usage case（R6 数据通道）', () => {
  it('事件 → per-session last 值写入', () => {
    dispatchContextUsage({ usedTokens: 5000, windowTokens: 200000, redlinePercent: 95 });
    const snap = useCtxStore.getState().contextUsageBySession!['s1'];
    expect(snap).toBeDefined();
    expect(snap!.usedTokens).toBe(5000);
    expect(snap!.windowTokens).toBe(200000);
    expect(snap!.redlinePercent).toBe(95);
  });

  it('值等重复事件跳过 store 写（同快照引用，无重复渲染源）', () => {
    dispatchContextUsage({ usedTokens: 5000, windowTokens: 200000, redlinePercent: 95 });
    const first = useCtxStore.getState().contextUsageBySession!['s1'];
    dispatchContextUsage({ usedTokens: 5000, windowTokens: 200000, redlinePercent: 95 });
    expect(useCtxStore.getState().contextUsageBySession!['s1']).toBe(first);
  });

  it('值变化 → 快照更新（每 generate 步刷新语义）', () => {
    dispatchContextUsage({ usedTokens: 5000, windowTokens: 200000, redlinePercent: 95 });
    dispatchContextUsage({ usedTokens: 9000, windowTokens: 200000, redlinePercent: 95 });
    expect(useCtxStore.getState().contextUsageBySession!['s1']!.usedTokens).toBe(9000);
  });

  it('store 无 contextUsageBySession 字段（最小测试 store）→ 不写不炸', () => {
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
        type: 'context-usage',
        data: { usedTokens: 1, windowTokens: null, redlinePercent: 95 },
        sessionId: 's1',
      } as AgentStreamWireEvent),
    ).not.toThrow();
    expect('contextUsageBySession' in (bare.getState() as Record<string, unknown>)).toBe(false);
  });
});

// ── Part 2：AgentPanel 条渲染（真 appStore，mirror agentRelayProgress seed 模式）──

function seedStore(contextUsage: Record<string, ContextUsageSnapshot> = {}): void {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'en-US',
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
    contextUsageBySession: contextUsage,
  } as any);
}

function contextBar(): HTMLElement | null {
  return document.querySelector('.agent-context-usage');
}

afterEach(() => cleanup());

describe('AgentPanel 上下文余量条（R6 UI 三态）', () => {
  it('无快照（会话重载后事件未到）→ 条隐藏', () => {
    seedStore();
    render(<AgentPanel />);
    expect(contextBar()).toBeNull();
  });

  it('有快照 + 有窗口 → 条 + 百分比 + 「估算」小标 + title 千分位 token 数', () => {
    seedStore({
      'session-1': { usedTokens: 50000, windowTokens: 200000, redlinePercent: 95, updatedAt: 1 },
    });
    render(<AgentPanel />);
    const bar = contextBar();
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('25%');
    expect(bar!.textContent).toContain('est.');
    expect(bar!.getAttribute('title')).toBe('50,000 / 200,000 tokens');
    expect(bar!.className).not.toContain('is-redline');
  });

  it('占用 ≥ redlinePercent → is-redline 变色', () => {
    seedStore({
      'session-1': { usedTokens: 192000, windowTokens: 200000, redlinePercent: 95, updatedAt: 1 },
    });
    render(<AgentPanel />);
    expect(contextBar()!.className).toContain('is-redline');
    expect(contextBar()!.textContent).toContain('96%');
  });

  it('windowTokens null（assignment 无窗口信息）→ 条隐藏，不显示假数', () => {
    seedStore({
      'session-1': { usedTokens: 10000, windowTokens: null, redlinePercent: 95, updatedAt: 1 },
    });
    render(<AgentPanel />);
    expect(contextBar()).toBeNull();
  });

  it('其他会话的快照不进当前视图（sessionId 键控隔离）', () => {
    seedStore({
      'session-other': { usedTokens: 10, windowTokens: 100, redlinePercent: 95, updatedAt: 1 },
    });
    render(<AgentPanel />);
    expect(contextBar()).toBeNull();
  });
});
