/**
 * W4（09-21-subagent-bg-decouple）：UI 面——后台任务条 / 子会话检视图 / 事件分流 / 列表过滤。
 *
 * 覆盖（implement.md W4 测试清单）：
 * - dispatcher bg 车道分流（wire sessionRole='child'）：run 态登记（isProjectRunActive 口径
 *   排除——W3 移交项①）+ 后台任务条 running 条目 + 活跃检视图原生渲染（无 tag 前缀）。
 * - 同步 child 路径回归锚：tag → childSessionId 映射登记（组卡钻取入口数据源）。
 * - bg-update 终态：条目终态 + 子会话 run 态归位 + toast 裁量（toast 通道 completed/failed
 *   出、silent/aborted 不出）。
 * - spawn_agent_bg 工具结果 metadata → 条目 running 补全 taskId/parent。
 * - 可选面守卫：store 缺 bgTasksByChildSession 时事件不炸。
 * - slice：检视态标记（switchAgentSession 从 sessionRole 推导）+ 输入守卫（readonly 拒发 /
 *   bg 子会话运行不拦发送 / leader 互斥回归）+ auto-resume 跳过 child/stub（W3 移交项②）+
 *   interrupted 首开提示一次 + deleteAgentSession 级联清条目。
 * - 组件：BgTaskBar 四态卡 + 取消钮（abort-run child sid）+ 钻取；检视图头部标注 + 返回键；
 *   AgentInput 只读横幅。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent } from '../src/shared/api/agent';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'leader-1', messages: [] })),
  fetchAgentSession: vi.fn(async () => ({ id: 'leader-1', status: 'idle', messages: [] })),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionParticipationGear: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => [] as any[]),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
  listAgentBgTasks: vi.fn(async () => ({ tasks: [] as any[] })),
  abortAgentRun: vi.fn(async () => true),
}));

vi.mock('../src/shared/api/agent', async (importOriginal) => {
  // 真模块展开（isPrimaryListableSession 等纯函数走真实现），仅 IPC 边界函数替换。
  const actual = await importOriginal<typeof import('../src/shared/api/agent')>();
  return {
    ...actual,
    createAgentSession: (...args: unknown[]) => apiMocks.createAgentSession(...(args as [any])),
    fetchAgentSession: (...args: unknown[]) => apiMocks.fetchAgentSession(...(args as [any])),
    setAgentSessionMode: (...args: unknown[]) => apiMocks.setAgentSessionMode(...(args as [any])),
    setAgentSessionBehaviorMode: (...args: unknown[]) => apiMocks.setAgentSessionBehaviorMode(...(args as [any])),
    setAgentSessionParticipationGear: (...args: unknown[]) => apiMocks.setAgentSessionParticipationGear(...(args as [any])),
    deleteAgentSession: (...args: unknown[]) => apiMocks.deleteAgentSession(...(args as [any])),
    listAgentSessions: (...args: unknown[]) => apiMocks.listAgentSessions(...(args as [any])),
    streamAgentMessage: (...args: unknown[]) => apiMocks.streamAgentMessage(...(args as [any])),
    listAgentBgTasks: (...args: unknown[]) => apiMocks.listAgentBgTasks(...(args as [any])),
    abortAgentRun: (...args: unknown[]) => apiMocks.abortAgentRun(...(args as [any])),
  };
});

import {
  handleAgentStreamEvent,
  getChildSessionIdForTag,
  forgetSessionTrack,
  __clearAgentEventTracks,
  type AgentBgTaskView,
  type AgentDispatchState,
  type AgentStreamWireEvent,
} from '../src/shared/store/agentEvents';
import { __clearAgentStreamBuffers } from '../src/shared/store/agentStreamBuffer';
import { useToastStore } from '../src/shared/store/toastStore';
import { createAgentSessionSlice, isProjectRunActive, type AgentSessionSlice } from '../src/shared/store/agentSessionSlice';

// ── Part A harness：最小分发 store（mirror agentEventsDispatch——run 态实现含 sessionRole 合并）──

type TestState = AgentDispatchState & {
  clearSessionPending: (sessionId: string) => void;
  clearPausedReviewFor: (sessionId: string) => void;
  clearPendingPatchFor: (sessionId: string) => void;
  sessionSwitching: boolean;
};

const useTestStore = create<TestState>()((set) => ({
  agentSessionId: null,
  agentMessages: [],
  activeSessionRunning: false,
  agentError: null,
  currentProject: null,
  agentRunStates: {},
  chainRunBySession: {},
  chainRunAnchorByProject: {},
  bgTasksByChildSession: {},
  sessionSwitching: false,
  setAgentRunState: (sessionId, patch) => set((s) => {
    const prev = s.agentRunStates[sessionId];
    const next = {
      sessionId,
      phase: patch.phase ?? prev?.phase ?? 'idle',
      projectPath: 'projectPath' in patch ? patch.projectPath : prev?.projectPath,
      activity: 'activity' in patch ? patch.activity : prev?.activity,
      sessionRole: 'sessionRole' in patch ? patch.sessionRole : prev?.sessionRole,
      updatedAt: Date.now(),
    };
    if (
      prev
      && prev.phase === next.phase
      && prev.activity === next.activity
      && prev.projectPath === next.projectPath
      && prev.sessionRole === next.sessionRole
    ) return s;
    return { agentRunStates: { ...s.agentRunStates, [sessionId]: next } };
  }),
  setPendingToolConfirm: vi.fn(),
  pushPendingDiff: vi.fn(),
  setPausedReview: vi.fn(),
  setPendingPatch: vi.fn(),
  fieldMetadata: {},
  resolvedLocale: 'zh-CN',
}));

function ev(event: AgentStreamEvent, sessionId: string, extra?: Partial<AgentStreamWireEvent>): AgentStreamWireEvent {
  return { ...event, sessionId, ...extra } as AgentStreamWireEvent;
}

function wireState(overrides: Record<string, unknown> = {}): void {
  useTestStore.setState({
    agentSessionId: null,
    agentMessages: [],
    activeSessionRunning: false,
    agentError: null,
    currentProject: { path: '/proj-a' },
    agentRunStates: {},
    chainRunBySession: {},
    chainRunAnchorByProject: {},
    bgTasksByChildSession: {},
    resolvedLocale: 'zh-CN',
    ...overrides,
  } as any);
}

beforeEach(() => {
  __clearAgentEventTracks();
  __clearAgentStreamBuffers();
  apiMocks.streamAgentMessage.mockClear();
  apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
  apiMocks.createAgentSession.mockClear();
  apiMocks.createAgentSession.mockResolvedValue({ id: 'leader-1', messages: [] });
  apiMocks.fetchAgentSession.mockClear();
  apiMocks.fetchAgentSession.mockResolvedValue({ id: 'leader-1', status: 'idle', messages: [] });
  apiMocks.listAgentBgTasks.mockClear();
  apiMocks.listAgentBgTasks.mockResolvedValue({ tasks: [] });
  apiMocks.listAgentSessions.mockReset();
  apiMocks.listAgentSessions.mockResolvedValue([]);
  apiMocks.deleteAgentSession.mockClear();
  (globalThis as any).window = globalThis.window ?? {};
  (window as any).orisonDesktop = { abortAgentRun: vi.fn(async () => true) };
  useToastStore.setState({ toasts: [] });
  localStorage.clear();
});

afterEach(() => cleanup());

const CHILD_LANE_EVENT = {
  source: 'subagent' as const,
  role: 'researcher-agent',
  depth: 1,
};

describe('W4 dispatcher：bg 车道分流（wire sessionRole=child）', () => {
  it('非活跃视图：run 态登记 sessionRole=child（isProjectRunActive 口径排除）+ 任务条 running 条目', () => {
    wireState({ agentSessionId: 'leader-1' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { ...CHILD_LANE_EVENT, sessionId: 'child-1', event: { type: 'started', data: {} } } }, 'child-1', { projectPath: '/proj-a', sessionRole: 'child' }));

    const run = useTestStore.getState().agentRunStates['child-1'];
    expect(run?.phase).toBe('running');
    expect(run?.sessionRole).toBe('child');
    expect(run?.activity).toBe('subagent:researcher-agent');

    const entry = useTestStore.getState().bgTasksByChildSession?.['child-1'];
    expect(entry?.status).toBe('running');
    expect(entry?.role).toBe('researcher-agent');

    // W3 移交项①：bg 子会话 running 不进「项目有活跃 run」。
    expect(isProjectRunActive(useTestStore.getState() as any)).toBe(false);
    // 对照：同形态无 sessionRole（leader 车道）进口径。
    useTestStore.setState({
      agentRunStates: {
        ...useTestStore.getState().agentRunStates,
        'leader-2': { sessionId: 'leader-2', phase: 'running', projectPath: '/proj-a', updatedAt: 1 },
      },
    });
    expect(isProjectRunActive(useTestStore.getState() as any)).toBe(true);
  });

  it('活跃检视图：assistant 终帧原生落视图（无 tag 前缀——与 child jsonl 落盘同形）', () => {
    wireState({ agentSessionId: 'child-1' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { ...CHILD_LANE_EVENT, sessionId: 'child-1', event: { type: 'assistant', data: { id: 'm1', content: '检索结论正文' } } } }, 'child-1', { projectPath: '/proj-a', sessionRole: 'child' }));

    const msgs = useTestStore.getState().agentMessages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('检索结论正文');
    expect(msgs[0]!.content).not.toContain('[subagent:');
    expect(msgs[0]!.streaming).toBe(false);
  });

  it('活跃检视图：delta 入正文流式轨（bufferStreamDelta 同族）', () => {
    vi.useFakeTimers();
    try {
      wireState({ agentSessionId: 'child-1' });
      handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { ...CHILD_LANE_EVENT, sessionId: 'child-1', event: { type: 'delta', data: { messageId: 'm-delta', channel: 'text', delta: '流式增量' } } } }, 'child-1', { projectPath: '/proj-a', sessionRole: 'child' }));
      vi.advanceTimersByTime(300);
      const msgs = useTestStore.getState().agentMessages;
      expect(msgs.some((m) => m.streaming === true && m.content.includes('流式增量'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同步 child 路径回归锚：tag → childSessionId 映射登记（组卡钻取数据源）', () => {
    wireState({ agentSessionId: 'leader-1' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { ...CHILD_LANE_EVENT, sessionId: 'sync-child-1', event: { type: 'started', data: {} } } }, 'leader-1', { projectPath: '/proj-a' }));
    expect(getChildSessionIdForTag('[subagent:researcher-agent]')).toBe('sync-child-1');
  });

  it('CR-12：同 tag 双派发仅缺席写入——首个子会话占位，后到不覆盖（防 last-wins 误钻取）', () => {
    wireState({ agentSessionId: 'leader-1' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { ...CHILD_LANE_EVENT, sessionId: 'sync-child-1', event: { type: 'started', data: {} } } }, 'leader-1', { projectPath: '/proj-a' }));
    handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { ...CHILD_LANE_EVENT, sessionId: 'sync-child-2', event: { type: 'started', data: {} } } }, 'leader-1', { projectPath: '/proj-a' }));
    expect(getChildSessionIdForTag('[subagent:researcher-agent]')).toBe('sync-child-1');
  });
});

describe('W4 dispatcher CR-9：条目项目归属（防 wildcard 跨项目误现）', () => {
  it('spawn 工具事件缺 projectPath → 回落 session→project 映射补全', () => {
    wireState({ agentSessionId: 'leader-1' });
    // 先发一个带 projectPath 的事件登记 session→project 映射（dispatcher 顶部 remember）。
    handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { ...CHILD_LANE_EVENT, sessionId: 'child-a', event: { type: 'started', data: {} } } }, 'leader-1', { projectPath: '/proj-a' }));
    // spawn_agent_bg 工具结果事件不带 projectPath。
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 'tool-9',
        results: [{
          toolName: 'spawn_agent_bg',
          output: '已启动',
          metadata: { taskId: 'bg_t9', childSessionId: 'child-9', role: 'researcher-agent', status: 'running', notify: 'toast' },
        }],
      },
    }, 'leader-1'));
    expect(useTestStore.getState().bgTasksByChildSession?.['child-9']?.projectPath).toBe('/proj-a');
  });

  it('两处皆无 projectPath → 不建条目（无 wildcard 条目）', () => {
    wireState({ agentSessionId: 'leader-1' });
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 'tool-10',
        results: [{
          toolName: 'spawn_agent_bg',
          output: '已启动',
          metadata: { taskId: 'bg_t10', childSessionId: 'child-10', role: 'researcher-agent', status: 'running', notify: 'toast' },
        }],
      },
    }, 'unknown-leader'));
    expect(useTestStore.getState().bgTasksByChildSession?.['child-10']).toBeUndefined();
  });
});

describe('W4 dispatcher：bg-update 终态', () => {
  const BG_UPDATE = {
    type: 'bg-update' as const,
    data: {
      taskId: 'bg_t1',
      childSessionId: 'child-1',
      role: 'researcher-agent',
      status: 'completed' as const,
      digest: '研究深度任务摘要',
      notify: 'toast' as const,
      startedAt: Date.now() - 60_000,
    },
  };

  it('条目终态 + 子会话 run 态归位 + toast 通道出通知 + startedAt 消费（CR-14）', () => {
    wireState({
      agentSessionId: 'leader-1',
      agentRunStates: { 'child-1': { sessionId: 'child-1', phase: 'running', sessionRole: 'child', projectPath: '/proj-a', updatedAt: 1 } },
      bgTasksByChildSession: {
        'child-1': { taskId: 'bg_t1', childSessionId: 'child-1', parentSessionId: 'leader-1', role: 'researcher-agent', status: 'running', notify: 'toast', projectPath: '/proj-a', startedAt: 1, updatedAt: 1 },
      },
    });
    handleAgentStreamEvent(useTestStore, ev(BG_UPDATE, 'leader-1', { projectPath: '/proj-a' }));

    const entry = useTestStore.getState().bgTasksByChildSession!['child-1'];
    expect(entry.status).toBe('completed');
    expect(entry.digest).toBe('研究深度任务摘要');
    // CR-14：终态载荷 startedAt 覆写条目起点（首知即终态场景耗时显示不塌缩 ~0s——原 running
    // 条目的 startedAt=1 被 registry 权威值替换）。
    expect(entry.startedAt).toBe(BG_UPDATE.data.startedAt);
    expect(useTestStore.getState().agentRunStates['child-1']?.phase).toBe('idle');
    const toasts = useToastStore.getState().toasts.map((t) => t.message);
    expect(toasts.some((m) => m.includes('后台任务完成') && m.includes('研究员'))).toBe(true);
  });

  it('CR-10：子会话已删（tombstone）的 bg-update 短路——不重建条目/不复活 run 态', () => {
    wireState({ agentSessionId: 'leader-1' });
    // 模拟子会话删除：deleteAgentSession 走 forgetSessionTrack 登记 tombstone。
    forgetSessionTrack('child-dead');
    handleAgentStreamEvent(useTestStore, ev({ ...BG_UPDATE, data: { ...BG_UPDATE.data, childSessionId: 'child-dead' } }, 'leader-1', { projectPath: '/proj-a' }));
    expect(useTestStore.getState().bgTasksByChildSession?.['child-dead']).toBeUndefined();
    expect(useTestStore.getState().agentRunStates['child-dead']).toBeUndefined();
  });

  it('notify=silent 不出 toast（只记账）；aborted 不出 toast（用户主动取消）', () => {
    wireState({ agentSessionId: 'leader-1' });
    handleAgentStreamEvent(useTestStore, ev({ ...BG_UPDATE, data: { ...BG_UPDATE.data, notify: 'silent' } }, 'leader-1', { projectPath: '/proj-a' }));
    handleAgentStreamEvent(useTestStore, ev({ ...BG_UPDATE, data: { ...BG_UPDATE.data, status: 'aborted' as const } }, 'leader-1', { projectPath: '/proj-a' }));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    // 终态照写（呈现面仍可见，只是不打扰）。
    expect(useTestStore.getState().bgTasksByChildSession!['child-1']?.status).toBe('aborted');
  });

  it('failed 终态：run 态归 error + warning toast；store 缺 bgTasksByChildSession（最小 store）不炸', () => {
    wireState({
      agentSessionId: 'leader-1',
      agentRunStates: { 'child-1': { sessionId: 'child-1', phase: 'running', sessionRole: 'child', updatedAt: 1 } },
    });
    handleAgentStreamEvent(useTestStore, ev({ ...BG_UPDATE, data: { ...BG_UPDATE.data, status: 'failed' as const, error: 'boom' } }, 'leader-1', { projectPath: '/proj-a' }));
    expect(useTestStore.getState().agentRunStates['child-1']?.phase).toBe('error');

    // 可选面守卫：字段整体缺席 → upsert 跳写不炸。
    useTestStore.setState({ bgTasksByChildSession: undefined } as any);
    expect(() => handleAgentStreamEvent(useTestStore, ev(BG_UPDATE, 'leader-1'))).not.toThrow();
  });
});

describe('W4 dispatcher：spawn_agent_bg 工具结果 metadata → 条目补全', () => {
  it('running metadata upsert（taskId/parentSessionId 权威源）', () => {
    wireState({ agentSessionId: 'leader-1' });
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 'tool-1',
        results: [{
          toolName: 'spawn_agent_bg',
          output: '后台任务已启动',
          metadata: { taskId: 'bg_t2', childSessionId: 'child-2', role: 'researcher-agent', status: 'running', notify: 'wake' },
        }],
      },
    }, 'leader-1', { projectPath: '/proj-a' }));

    const entry = useTestStore.getState().bgTasksByChildSession?.['child-2'];
    expect(entry?.status).toBe('running');
    expect(entry?.taskId).toBe('bg_t2');
    expect(entry?.parentSessionId).toBe('leader-1');
    expect(entry?.notify).toBe('wake');
  });
});

// ── Part B harness：真 slice（mirror agentSessionAutoResumeRace——api 局部 mock + 真纯函数）──

type SliceTestState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  clearSessionPending: ReturnType<typeof vi.fn>;
  clearPausedReviewFor: ReturnType<typeof vi.fn>;
  clearPendingPatchFor: (sessionId: string) => void;
  clearReviewLocalStateFor: (sessionId: string) => void;
};

const useSliceStore = create<SliceTestState>()((...args) => ({
  currentProject: null,
  activeChapterId: null,
  clearSessionPending: vi.fn(),
  clearPausedReviewFor: vi.fn(),
  clearPendingPatchFor: vi.fn(),
  clearReviewLocalStateFor: vi.fn(),
  ...createAgentSessionSlice(...args),
}));

const CHILD_SESSION = {
  id: 'child-1',
  projectPath: 'I:/p-bg',
  status: 'running' as const,
  sessionRole: 'child' as const,
  parentId: 'leader-1',
  messages: [{ id: 'cm1', role: 'assistant' as const, content: '子代理已产出' }],
  permissionMode: 'auto' as const,
  behaviorMode: 'normal' as const,
};

describe('W4 slice：检视态标记 + 输入守卫 + 自动接续守卫 + hydrate', () => {
  beforeEach(() => {
    useSliceStore.setState({
      currentProject: { path: 'I:/p-bg' },
      agentSessionId: null,
      agentMessages: [],
      agentSessions: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      sessionSwitching: false,
      draftSession: false,
      agentViewReadonly: false,
      agentViewSessionRole: null,
      agentParentSessionId: null,
      bgTasksByChildSession: {},
    } as any);
  });

  it('切进 child 会话：agentViewReadonly=true + role/parent 标记（fetch 回 sessionRole 推导）', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue(CHILD_SESSION);
    await useSliceStore.getState().switchAgentSession('child-1');
    const s = useSliceStore.getState();
    expect(s.agentSessionId).toBe('child-1');
    expect(s.agentViewReadonly).toBe(true);
    expect(s.agentViewSessionRole).toBe('child');
    expect(s.agentParentSessionId).toBe('leader-1');
  });

  it('切回 leader 会话：检视态清（readonly=false / parent=null）', async () => {
    apiMocks.fetchAgentSession.mockResolvedValueOnce(CHILD_SESSION);
    await useSliceStore.getState().switchAgentSession('child-1');
    apiMocks.fetchAgentSession.mockResolvedValueOnce({
      id: 'leader-1', projectPath: 'I:/p-bg', status: 'idle', sessionRole: 'primary', messages: [], permissionMode: 'suggest', behaviorMode: 'normal',
    });
    await useSliceStore.getState().switchAgentSession('leader-1');
    expect(useSliceStore.getState().agentViewReadonly).toBe(false);
    expect(useSliceStore.getState().agentViewSessionRole).toBe('primary');
    expect(useSliceStore.getState().agentParentSessionId).toBeNull();
  });

  it('returnToParentSession：回父会话；缺父回落新会话草稿态', async () => {
    apiMocks.fetchAgentSession.mockResolvedValueOnce(CHILD_SESSION);
    await useSliceStore.getState().switchAgentSession('child-1');
    apiMocks.fetchAgentSession.mockResolvedValueOnce({
      id: 'leader-1', projectPath: 'I:/p-bg', status: 'idle', messages: [], permissionMode: 'suggest', behaviorMode: 'normal',
    });
    useSliceStore.getState().returnToParentSession();
    await vi.waitFor(() => expect(useSliceStore.getState().agentSessionId).toBe('leader-1'));

    useSliceStore.setState({ agentParentSessionId: null });
    useSliceStore.getState().returnToParentSession();
    expect(useSliceStore.getState().draftSession).toBe(true);
  });

  it('CR-11：父会话已删（tombstone）→ returnToParentSession 回落新会话草稿，不切死会话', async () => {
    apiMocks.fetchAgentSession.mockResolvedValueOnce(CHILD_SESSION);
    await useSliceStore.getState().switchAgentSession('child-1');
    forgetSessionTrack('leader-1'); // 父会话已被删（agentEvents tombstone）

    useSliceStore.getState().returnToParentSession();

    // 不对死父发起 fetch（死胡同面），直接回落草稿态（newAgentSession 同步置位）。
    expect(apiMocks.fetchAgentSession).toHaveBeenCalledTimes(1);
    expect(useSliceStore.getState().draftSession).toBe(true);
    expect(useSliceStore.getState().agentSessionId).toBeNull();
  });

  it('检视态 sendAgentMessage 拒发（纵深防御——输入面已锁，通道直调兜底）', async () => {
    useSliceStore.setState({ agentViewReadonly: true } as any);
    const dispatched = await useSliceStore.getState().sendAgentMessage('不该发出去');
    expect(dispatched).toBe(false);
    expect(apiMocks.streamAgentMessage).not.toHaveBeenCalled();
  });

  it('bg 子会话运行不拦 leader 发送（W3 移交项①发送面）；对照：无 role 的他 session running 照拦', async () => {
    // 子会话 running（sessionRole='child'）→ 发送放行。
    useSliceStore.setState({
      agentSessionId: 'leader-1',
      agentRunStates: {
        'child-1': { sessionId: 'child-1', phase: 'running', sessionRole: 'child', projectPath: 'I:/p-bg', updatedAt: 1 },
      },
    } as any);
    expect(await useSliceStore.getState().sendAgentMessage('继续聊')).toBe(true);
    expect(apiMocks.streamAgentMessage).toHaveBeenCalledTimes(1);

    // 对照回归：无 sessionRole 的他 session running（leader 车道）→ 拒发 + 不 invoke。
    useSliceStore.setState({
      activeSessionRunning: false,
      agentRunStates: {
        'other-leader': { sessionId: 'other-leader', phase: 'running', projectPath: 'I:/p-bg', updatedAt: 2 },
      },
    } as any);
    expect(await useSliceStore.getState().sendAgentMessage('被拦')).toBe(false);
    expect(apiMocks.streamAgentMessage).toHaveBeenCalledTimes(1);
  });

  it('auto-resume 跳过 child/stub（客户端防御镜像——W3 移交项②）', async () => {
    apiMocks.listAgentSessions.mockResolvedValue([
      { id: 'stub-row', projectPath: 'I:/p-bg', agentName: 'chapter-chain-dogfood' },
      { id: 'child-row', projectPath: 'I:/p-bg', sessionRole: 'child' },
      { id: 'leader-row', projectPath: 'I:/p-bg' },
    ]);
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'leader-row', projectPath: 'I:/p-bg', status: 'idle', messages: [], permissionMode: 'suggest', behaviorMode: 'normal',
    });
    useSliceStore.getState().resetAgentForProjectSwitch();
    await vi.waitFor(() => expect(useSliceStore.getState().agentSessionId).toBe('leader-row'));
    // fetchAgentSession 只被接管目标调用（child/stub 未被接管）。
    expect(apiMocks.fetchAgentSession.mock.calls.map((c) => c[0])).toEqual(['leader-row']);
  });

  it('loadAgentBgTasks：hydrate 条目 + interrupted 首开提示一次（同项目去重）', async () => {
    apiMocks.listAgentBgTasks.mockResolvedValue({
      tasks: [
        { taskId: 'bg_i1', parentSessionId: 'leader-1', childSessionId: 'child-i1', role: 'researcher-agent', projectPath: 'I:/p-bg', promptDigest: '中断的任务', status: 'interrupted', startedAt: 1, updatedAt: 2, notify: 'toast' },
        { taskId: 'bg_c1', parentSessionId: 'leader-1', childSessionId: 'child-c1', role: 'style-analyzer-agent', projectPath: 'I:/p-bg', promptDigest: '完成历史', status: 'completed', startedAt: 1, updatedAt: 3, notify: 'toast' },
      ],
    });
    await useSliceStore.getState().loadAgentBgTasks();
    const entries = useSliceStore.getState().bgTasksByChildSession;
    expect(entries['child-i1']?.status).toBe('interrupted');
    expect(entries['child-c1']?.status).toBe('completed');
    expect(entries['child-c1']?.digest).toBe('完成历史');
    expect(useToastStore.getState().toasts.filter((t) => t.message.includes('中断'))).toHaveLength(1);

    // 第二次 hydrate（面板重复挂载）不重复提示。
    await useSliceStore.getState().loadAgentBgTasks();
    expect(useToastStore.getState().toasts.filter((t) => t.message.includes('中断'))).toHaveLength(1);
  });

  it('deleteAgentSession：被删会话名下（父/子）后台条目一并清', async () => {
    useSliceStore.setState({
      currentProject: { path: 'I:/p-bg' },
      bgTasksByChildSession: {
        'child-own': { taskId: 't1', childSessionId: 'child-own', parentSessionId: 'gone-leader', role: 'r', status: 'running', notify: 'toast', projectPath: 'I:/p-bg', startedAt: 1, updatedAt: 1 },
        'child-keep': { taskId: 't2', childSessionId: 'child-keep', parentSessionId: 'other-leader', role: 'r', status: 'running', notify: 'toast', projectPath: 'I:/p-bg', startedAt: 1, updatedAt: 1 },
      },
    } as any);
    await useSliceStore.getState().deleteAgentSession('gone-leader');
    const entries = useSliceStore.getState().bgTasksByChildSession;
    expect(entries['child-own']).toBeUndefined();
    expect(entries['child-keep']).toBeDefined();
  });
});

// ── Part C：组件面（真 appStore——mirror agentPanelManualCompact harness）──

import { AgentInput } from '../src/features/agent-panel/AgentInput';
import { BgTaskBar, ChildInspectHeader } from '../src/features/agent-panel/BgTaskBar';
import { useAppStore } from '../src/shared/store/appStore';

function runningEntry(partial: Partial<AgentBgTaskView>): AgentBgTaskView {
  return {
    taskId: 'bg_x',
    childSessionId: 'child-x',
    parentSessionId: 'leader-1',
    role: 'researcher-agent',
    status: 'running',
    notify: 'toast',
    projectPath: 'I:/p-bg',
    startedAt: Date.now() - 90_000,
    updatedAt: Date.now(),
    ...partial,
  };
}

describe('W4 组件：BgTaskBar 四态卡 + 取消 + 钻取', () => {
  function seedAppStore(overrides: Record<string, unknown> = {}): void {
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: 'I:/p-bg', type: 'novel' },
    } as any);
    useAppStore.getState().resetAgentForProjectSwitch();
    useAppStore.setState({
      resolvedLocale: 'zh-CN',
      agentSessionId: 'leader-1',
      activeSessionRunning: false,
      agentError: null,
      agentMessages: [],
      agentSkills: [],
      loadAgentSkills: vi.fn().mockResolvedValue(undefined),
      bgTasksByChildSession: {
        'child-run': runningEntry({ childSessionId: 'child-run' }),
        'child-done': runningEntry({ childSessionId: 'child-done', status: 'completed', updatedAt: Date.now() - 1000 }),
        'child-fail': runningEntry({ childSessionId: 'child-fail', status: 'failed', error: 'x', updatedAt: Date.now() - 2000 }),
        'child-cancelled': runningEntry({ childSessionId: 'child-cancelled', status: 'aborted', updatedAt: Date.now() - 3000 }),
        'child-interrupted': runningEntry({ childSessionId: 'child-interrupted', status: 'interrupted', updatedAt: Date.now() - 4000 }),
      },
      ...overrides,
    } as any);
  }

  it('五态卡渲染（running/completed/failed/已取消/已中断）+ 取消钮仅 running', () => {
    seedAppStore();
    render(<BgTaskBar />);
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
    expect(screen.getByText('已中断')).toBeTruthy();
    // 取消钮只在 running 条目（1 个）；钻取钮排除当前视图会话（leader-1 不在条目里，5 个全显）。
    expect(screen.getAllByRole('button', { name: '取消任务' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '查看该子代理' })).toHaveLength(5);
  });

  it('取消钮走 abort-run 既有通道（child sid 键控）；钻取钮切进子会话检视图', async () => {
    seedAppStore();
    const switchAgentSession = vi.fn(async () => {});
    useAppStore.setState({ switchAgentSession: switchAgentSession as any });
    render(<BgTaskBar />);
    await userEvent.click(screen.getAllByRole('button', { name: '取消任务' })[0]!);
    expect(apiMocks.abortAgentRun).toHaveBeenCalledWith('child-run');

    await userEvent.click(screen.getAllByRole('button', { name: '查看该子代理' })[0]!);
    expect(switchAgentSession).toHaveBeenCalledWith('child-run');
  });

  it('项目过滤：他项目条目不渲染（sameProjectPath 归一口径）', () => {
    seedAppStore({
      bgTasksByChildSession: {
        'child-other': runningEntry({ childSessionId: 'child-other', projectPath: 'I:/other-proj' }),
      },
    });
    render(<BgTaskBar />);
    expect(screen.queryByText('运行中')).toBeNull();
  });

  it('CR-20 渲染帽：终态卡无界堆积 → 最新 8 张 + 溢出注记（running 不隐藏）', () => {
    const many: Record<string, AgentBgTaskView> = {};
    for (let i = 0; i < 11; i++) {
      many[`child-many-${i}`] = runningEntry({
        childSessionId: `child-many-${i}`,
        status: 'completed',
        updatedAt: Date.now() - (i + 1) * 1000,
      });
    }
    seedAppStore({ bgTasksByChildSession: many });
    render(<BgTaskBar />);
    expect(screen.getAllByText('已完成')).toHaveLength(8);
    expect(screen.getByText('还有 3 条较早记录')).toBeTruthy();
  });
});

describe('W4 组件：子会话检视图头部 + AgentInput 只读横幅', () => {
  it('ChildInspectHeader：role/状态/耗时 + 返回键走 returnToParentSession（CR-11 统一导航）', async () => {
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: 'I:/p-bg', type: 'novel' },
      resolvedLocale: 'zh-CN',
      agentSessionId: 'child-run',
      agentViewReadonly: true,
      agentViewSessionRole: 'child',
      agentParentSessionId: 'leader-1',
      agentRunStates: { 'child-run': { sessionId: 'child-run', phase: 'running', sessionRole: 'child', updatedAt: 1 } },
      bgTasksByChildSession: { 'child-run': runningEntry({ childSessionId: 'child-run' }) },
    } as any);
    const returnToParentSession = vi.fn();
    useAppStore.setState({ returnToParentSession: returnToParentSession as any });
    render(<ChildInspectHeader />);
    expect(screen.getByText('只读检视')).toBeTruthy();
    expect(screen.getByText('研究员')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '返回主会话' }));
    expect(returnToParentSession).toHaveBeenCalledTimes(1);
  });

  it('AgentInput 检视态：只读横幅替代输入框（无 textarea/send）+ 横幅返回键', async () => {
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: 'I:/p-bg', type: 'novel' },
      resolvedLocale: 'zh-CN',
      agentSessionId: 'child-run',
      agentViewReadonly: true,
      agentViewSessionRole: 'child',
      agentParentSessionId: 'leader-1',
      agentRunStates: {},
      pendingToolConfirmBySession: {},
      pendingPassageResolveBySession: {},
      pendingAttachments: [],
      attachmentUploadStates: {},
      novelChapters: [],
      openFiles: [],
      draftPreset: null,
      consumeDraft: vi.fn(),
      returnToParentSession: vi.fn(),
      streamRevealTick: 0,
    } as any);
    render(<AgentInput />);
    expect(screen.getByText('子代理会话为只读检视——回到主会话才能继续对话')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: '返回主会话' })[0]!);
    expect(useAppStore.getState().returnToParentSession).toHaveBeenCalled();
  });

  it('AgentInput 常规态回归：输入框在位（readonly=false 零变化）', () => {
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: 'I:/p-bg', type: 'novel' },
      resolvedLocale: 'zh-CN',
      agentSessionId: 'leader-1',
      agentViewReadonly: false,
      agentRunStates: {},
      pendingToolConfirmBySession: {},
      pendingPassageResolveBySession: {},
      pendingAttachments: [],
      attachmentUploadStates: {},
      novelChapters: [],
      openFiles: [],
      draftPreset: null,
      consumeDraft: vi.fn(),
    } as any);
    render(<AgentInput />);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.queryByText('子代理会话为只读检视——回到主会话才能继续对话')).toBeNull();
  });
});
