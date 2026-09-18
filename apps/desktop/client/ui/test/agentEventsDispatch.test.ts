/**
 * dogfood T1 Stage 3（design §5.2/§5.3/§5.4，r7/r8/D3/D4）：store 级全局事件分发器 +
 * per-session 键控 + 切换解耦 + 同项目单 run 的 UI 面。
 *
 * 覆盖（implement.md Stage 3 测试清单）：
 * - initAgentEvents 单例（重复 init 无双订阅——preload 并存 listener = 静默双写）。
 * - 项目隔离：其他项目的事件不动当前视图（写后台态）。
 * - 键控隔离：A 会话 confirm 事件不写 B 会话槽；后台会话事件落自己的键（徽标数据源）。
 * - 切换不 abort：run 继续产事件进后台 run 态（agentRunStates）；切回视图恢复。
 * - delta 事件只驱动 run 态计数（不写消息内容——正文流式渲染是 S4 红线）。
 * - compaction toast 仅活跃会话。
 * - 徽标状态机派生（running/awaiting_confirm/awaiting_review/idle 优先级）。
 * - D3：switchAgentSession / newAgentSession 不 abort；cancelAgent = 停当前视图会话 run。
 * - D4 UI 面：本地预检 busyRun → 不发 invoke + toast；shell 结构化拒绝 → toast + run 态复位。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent } from '../src/shared/api/agent';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'sess-a', messages: [] })),
  fetchAgentSession: vi.fn(async () => ({ id: 'sess-a', status: 'idle', messages: [] })),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionParticipationGear: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => []),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import {
  handleAgentStreamEvent,
  initAgentEvents,
  deriveSessionBadge,
  rememberSessionProject,
  rememberSessionMode,
  rememberDeletedSession,
  forgetSessionTrack,
  getSessionProject,
  getSessionMode,
  __clearAgentEventTracks,
  type AgentDispatchState,
  type AgentStreamWireEvent,
} from '../src/shared/store/agentEvents';
import { __clearAgentStreamBuffers } from '../src/shared/store/agentStreamBuffer';
import { useToastStore } from '../src/shared/store/toastStore';
import { sameProjectPath } from '../src/shared/store/projectRunBusy';
import { createAgentSessionSlice, type AgentSessionSlice } from '../src/shared/store/agentSessionSlice';

type SliceState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  resolvedLocale?: string;
  clearSessionPending: (sessionId: string) => void;
  clearPausedReviewFor: (sessionId: string) => void;
  clearPendingPatchFor: (sessionId: string) => void;
  /** 09-13 子3 W4：五审阅本地态键随会话消亡清理（deleteAgentSession 调用面）。 */
  clearReviewLocalStateFor: (sessionId: string) => void;
};

type TestState = AgentDispatchState & {
  clearSessionPending: (sessionId: string) => void;
  clearPausedReviewFor: (sessionId: string) => void;
  clearPendingPatchFor: (sessionId: string) => void;
  clearAgentRunState: (sessionId: string) => void;
  sessionSwitching: boolean;
  pendingAttachments: unknown[];
  newAgentSession: () => Promise<void>;
  switchAgentSession: (sessionId: string) => Promise<void>;
  /** dogfood R2 #105 假中断守卫：resume 在途判据（chapterReviewSlice 面——dispatcher 结构读）。
   * 09-13 子3 W4：reviewResuming 单槽 → BySession 键控（done-probe 同批改读）。
   * CR-9：escalate 车道第二载荷键（escalate 暂停无 pausedReview——resume fallback 落本键）。 */
  reviewResumingBySession: Record<string, boolean>;
  pausedReviewBySession: Record<string, unknown>;
  escalateFindingsBySession: Record<string, unknown>;
};

// 最小可跑 store：真 agentSessionSlice 的 run 态 + 视图字段，diff/patch/review 槽用结构面
// 真实现会引入更多 deps——分发器只依赖结构面，测试直接用可观测的 setPendingToolConfirm 等
// （agentDiffSlice 真行为在 agentPassageDiff / 键控测试文件覆盖；此处测分发谓词与写点归属）。
let confirmWrites: Array<{ sid: string; value: unknown }> = [];
let patchWrites: Array<{ sid: string; value: unknown }> = [];
let reviewWrites: Array<{ sid: string; value: unknown }> = [];
let diffWrites: Array<{ sid: string; value: unknown }> = [];

const useTestStore = create<TestState & { agentRunStates: TestState['agentRunStates'] }>()((set, get) => ({
  agentSessionId: null,
  agentMessages: [],
  activeSessionRunning: false,
  agentError: null,
  currentProject: null,
  agentRunStates: {},
  chainRunBySession: {},
  chainRunAnchorByProject: {},
  sessionSwitching: false,
  pendingAttachments: [],
  setAgentRunState: (sessionId, patch) => set((s) => {
    const prev = s.agentRunStates[sessionId];
    const next = {
      sessionId,
      phase: patch.phase ?? prev?.phase ?? 'idle',
      projectPath: 'projectPath' in patch ? patch.projectPath : prev?.projectPath,
      activity: 'activity' in patch ? patch.activity : prev?.activity,
      updatedAt: Date.now(),
    };
    if (prev && prev.phase === next.phase && prev.activity === next.activity && prev.projectPath === next.projectPath) return s;
    return { agentRunStates: { ...s.agentRunStates, [sessionId]: next } };
  }),
  clearAgentRunState: (sessionId) => set((s) => {
    if (!(sessionId in s.agentRunStates)) return s;
    const next = { ...s.agentRunStates };
    delete next[sessionId];
    return { agentRunStates: next };
  }),
  setPendingToolConfirm: (sessionId, value) => { confirmWrites.push({ sid: sessionId, value }); },
  pushPendingDiff: (sessionId, diff) => { diffWrites.push({ sid: sessionId, value: diff }); },
  setPausedReview: (sessionId, meta) => { reviewWrites.push({ sid: sessionId, value: meta }); },
  setPendingPatch: (sessionId, patch) => { patchWrites.push({ sid: sessionId, value: patch }); },
  fieldMetadata: {},
  resolvedLocale: 'zh-CN',
  reviewResumingBySession: {},
  pausedReviewBySession: {},
  escalateFindingsBySession: {},
  clearSessionPending: vi.fn(),
  clearPausedReviewFor: vi.fn(),
  clearPendingPatchFor: vi.fn(),
  newAgentSession: vi.fn(async () => { set({ agentSessionId: null, agentMessages: [], activeSessionRunning: false }); }),
  switchAgentSession: vi.fn(async (sessionId: string) => { set({ agentSessionId: sessionId }); }),
}));

function ev(event: AgentStreamEvent, sessionId: string, projectPath?: string): AgentStreamWireEvent {
  return { ...event, sessionId, ...(projectPath !== undefined ? { projectPath } : {}) };
}

beforeEach(() => {
  __clearAgentEventTracks();
  __clearAgentStreamBuffers();
  confirmWrites = [];
  patchWrites = [];
  reviewWrites = [];
  diffWrites = [];
  apiMocks.streamAgentMessage.mockClear();
  apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
  apiMocks.createAgentSession.mockClear();
  apiMocks.createAgentSession.mockResolvedValue({ id: 'sess-a', messages: [] });
  apiMocks.fetchAgentSession.mockClear();
  apiMocks.fetchAgentSession.mockResolvedValue({ id: 'sess-a', status: 'idle', messages: [] });
  (globalThis as any).window = globalThis.window ?? {};
  (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
  useToastStore.setState({ toasts: [] });
  useTestStore.setState({
    agentSessionId: 'sess-a',
    agentMessages: [],
    activeSessionRunning: false,
    agentError: null,
    currentProject: { path: '/proj-a' },
    agentRunStates: {},
    chainRunBySession: {},
    chainRunAnchorByProject: {},
    resolvedLocale: 'zh-CN',
    reviewResumingBySession: {},
    pausedReviewBySession: {},
    escalateFindingsBySession: {},
  });
});

describe('r7 全局监听单例（重复 init 无双订阅）', () => {
  it('同一 store 重复 init 只注册一次订阅（事件单次到达）', () => {
    const listeners: Array<(e: unknown) => void> = [];
    (window as any).orisonDesktop = {
      onAgentStreamEvent: (cb: (e: unknown) => void) => { listeners.push(cb); return () => {}; },
    };
    initAgentEvents(useTestStore);
    initAgentEvents(useTestStore);
    initAgentEvents(useTestStore);
    expect(listeners).toHaveLength(1);

    listeners[0](ev({ type: 'assistant', data: { id: 'm1', content: 'hi' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().agentMessages).toHaveLength(1);
  });

  it('无 onAgentStreamEvent 面（纯单测环境）→ init no-op 不抛', () => {
    (window as any).orisonDesktop = {};
    expect(() => initAgentEvents(useTestStore)).not.toThrow();
  });

  it('CR-T1-034：新 store init 先退订旧 listener（window token 最新 wins——HMR 模块重执行防重复 toast）', () => {
    const listeners: Array<(e: unknown) => void> = [];
    const unsub = vi.fn();
    (window as any).orisonDesktop = {
      onAgentStreamEvent: (cb: (e: unknown) => void) => { listeners.push(cb); return unsub; },
    };
    (window as any).__agentEventsUnsubscribe = undefined;
    const storeA = { getState: useTestStore.getState, setState: useTestStore.setState } as typeof useTestStore;
    const storeB = { getState: useTestStore.getState, setState: useTestStore.setState } as typeof useTestStore;
    initAgentEvents(storeA);
    initAgentEvents(storeB);
    // 旧模块实例的 listener 被退订（HMR 下旧 listener 永不清退会重复处理/toast）。
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(2);
    (window as any).__agentEventsUnsubscribe = undefined; // 复位，不污染后续用例
  });
});

describe('r7 分发谓词：活跃视图 / 后台双分支 + 项目隔离', () => {
  it('活跃视图（sessionId + projectPath 双匹配）→ assistant 消息进 agentMessages', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'assistant', data: { id: 'm1', content: 'hi' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().agentMessages.map((m) => m.id)).toEqual(['m1']);
  });

  it('项目隔离：其他项目的事件不动当前视图消息（只更新后台 run 态）', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'assistant', data: { id: 'm-other', content: 'x' } }, 'sess-a', '/proj-B'));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  it('后台会话（同项目他 session）assistant 事件不进视图消息，run 态保持 running', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'assistant', data: { id: 'm-bg' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  it('后台会话 done → run 态归 idle（徽标熄灭），视图 loading 不动', () => {
    useTestStore.getState().setAgentRunState('sess-b', { phase: 'running', projectPath: '/proj-a' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('idle');
  });

  it('活跃会话 done → 视图 loading 翻 false', () => {
    useTestStore.setState({ activeSessionRunning: true });
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().activeSessionRunning).toBe(false);
  });

  it('delta 事件驱动 run 态 + 活跃会话建流式占位（S4 起正文流式；后台会话不写消息）', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm1', channel: 'text', delta: '半句' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');
    // dogfood T1 Stage 4：活跃会话 delta 首条即建 streaming 占位（250ms flush 才更 content）。
    expect(useTestStore.getState().agentMessages).toHaveLength(1);
    expect(useTestStore.getState().agentMessages[0]).toMatchObject({ id: 'm1', role: 'assistant', streaming: true, content: '' });
    // 后台会话 delta 同样只驱动 run 态（徽标「仍在跑」；消息切回 fetch 对账）。
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm2', channel: 'text', delta: 'x' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('running');
    expect(useTestStore.getState().agentMessages).toHaveLength(1);
  });

  it('compaction toast 仅活跃会话弹（后台静默）', () => {
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev({ type: 'compaction', data: { compactedCount: 5 } }, 'sess-b', '/proj-a'));
    expect(showToast).not.toHaveBeenCalled();
    handleAgentStreamEvent(useTestStore, ev({ type: 'compaction', data: { compactedCount: 5 } }, 'sess-a', '/proj-a'));
    expect(showToast).toHaveBeenCalledTimes(1);
    showToast.mockRestore();
  });

  it('chain-node-done（普通节点）→ run 态 running + 链卡步进', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: { nodeId: 'brief-compiler-node', status: 'done' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('running');
    expect(useTestStore.getState().chainRunBySession['sess-b']?.completedNodes).toContain('brief-compiler-node');
  });

  it('chain-node-done 哨兵终态（completed/paused/aborted → idle；error → error）——resume/dogfood 链车道无 done 事件兜底，sentinel 后 running 不清会永久占住生成闸', () => {
    // 先把 run 态置 running（resume 车道链事件曾置位）。
    useTestStore.getState().setAgentRunState('sess-b', { phase: 'running', projectPath: '/proj-a' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: { nodeId: '__chain_run__', status: 'completed' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('idle');
    expect(useTestStore.getState().chainRunBySession['sess-b']?.status).toBe('completed');

    // paused：run 本身结束（审阅等待由键控槽承载）→ idle。
    useTestStore.getState().setAgentRunState('sess-b', { phase: 'running' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: { nodeId: '__chain_run__', status: 'paused' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('idle');

    // aborted：idle（链卡标「已中断」，非 run 态 error）。
    useTestStore.getState().setAgentRunState('sess-b', { phase: 'running' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: { nodeId: '__chain_run__', status: 'aborted' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('idle');

    // error / blocked / 未知终态 → error 相位（mirror error 事件处理）。
    useTestStore.getState().setAgentRunState('sess-b', { phase: 'running' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: { nodeId: '__chain_run__', status: 'error' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('error');

    // CR-22（W-CR 批）：legacy 'auto_revise_pending'（W1a 前哨兵终态值——dev 热重载/持久化时间线
    // 回放会重放旧帧）→ idle 非 error（健康复跑卡不被错标失败；生产链已不再产该值）。
    useTestStore.getState().setAgentRunState('sess-b', { phase: 'running' });
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: { nodeId: '__chain_run__', status: 'auto_revise_pending' } }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.phase).toBe('idle');
    expect(useTestStore.getState().chainRunBySession['sess-b']?.status).toBe('completed');
  });
});

describe('r8 键控隔离（后台确认卡不漏前台 + 各写各键）', () => {
  it('A 会话 confirm 事件落 A 键——不写视图消息，视图 loading 不动（B 是视图时）', () => {
    useTestStore.setState({ activeSessionRunning: true });
    handleAgentStreamEvent(useTestStore, ev({
      type: 'confirm_required',
      data: { callId: 'call-1', name: 'write_file', input: {} },
    }, 'sess-a', '/proj-a'));
    expect(confirmWrites).toHaveLength(1);
    expect(confirmWrites[0].sid).toBe('sess-a');
    // 视图会话即 A → loading 翻 false（等人）。
    expect(useTestStore.getState().activeSessionRunning).toBe(false);
  });

  it('后台会话（sess-b）confirm 事件落 sess-b 键——视图（sess-a）loading 不动', () => {
    useTestStore.setState({ activeSessionRunning: true });
    handleAgentStreamEvent(useTestStore, ev({
      type: 'confirm_required',
      data: { callId: 'call-2', name: 'write_file', input: {} },
    }, 'sess-b', '/proj-a'));
    expect(confirmWrites).toHaveLength(1);
    expect(confirmWrites[0].sid).toBe('sess-b');
    expect(useTestStore.getState().activeSessionRunning).toBe(true);
  });

  it('后台会话 write_chapter paused → chapter_review 落该会话键（切回再现的数据源）', () => {
    rememberSessionProject('sess-b', '/proj-a');
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 't1',
        results: [{
          toolCallId: 'c1',
          toolName: 'write_chapter',
          output: 'paused',
          metadata: { type: 'chapter_review', stage: 'draft', chapterId: 'ch_1', draftContent: '正文' },
        }],
      },
    }, 'sess-b', '/proj-a'));
    expect(reviewWrites).toHaveLength(1);
    expect(reviewWrites[0].sid).toBe('sess-b');
    expect((reviewWrites[0].value as { stage: string }).stage).toBe('draft');
    // 后台消息不进视图。
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
  });

  it('活跃视图 tool 消息 + suggest 档 field_patch 落视图会话键（runId = sessionId）', () => {
    rememberSessionProject('sess-a', '/proj-a');
    // sendAgentMessage 会记 mode；此处直接模拟「发送时已捕获 suggest」。
    rememberSessionMode('sess-a', 'suggest');
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 't2',
        results: [{
          toolCallId: 'c2',
          toolName: 'outline_update',
          output: 'ok',
          metadata: { type: 'field_patch', field: 'outline', action: 'set', data: {} },
        }],
      },
    }, 'sess-a', '/proj-a'));
    // 消息进视图 + patch 落 sess-a 键。
    expect(useTestStore.getState().agentMessages.map((m) => m.id)).toEqual(['t2']);
    expect(patchWrites).toHaveLength(1);
    expect(patchWrites[0].sid).toBe('sess-a');
    expect((patchWrites[0].value as { runId: string }).runId).toBe('sess-a');
  });
});

// ── dogfood R2 #18-A/#18-B：child tool 事件路由 leader 审核面 + 审核卡到达 toast ──

/** #18-A 测试用 child tool 事件构造（field_patch metadata 形态 mirror 子代理真调 outline_update）。 */
function childToolEvent(
  toolId: string,
  field: string,
  opts: { role?: string; id?: string } = {},
): AgentStreamEvent {
  return {
    type: 'child',
    data: {
      source: 'subagent',
      role: opts.role ?? 'story-planner-agent',
      sessionId: 'child-1',
      depth: 1,
      event: {
        type: 'tool',
        data: {
          id: opts.id ?? 'ct1',
          results: [{
            toolCallId: `c-${opts.id ?? 'ct1'}`,
            toolName: toolId,
            output: 'ok',
            metadata: { type: 'field_patch', field, action: 'set', data: {} },
          }],
        },
      },
    },
  };
}

describe('dogfood R2 #18-A：child tool 事件复用 leader tool 路由（field_patch envelope 不再哑弹）', () => {
  it('子代理 outline_update 的 field_patch → pendingPatch 落 leader 键 + generatedBy 子代理标注 + tool 消息单条携分组前缀', () => {
    rememberSessionMode('sess-a', 'suggest');
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev(childToolEvent('outline_update', 'outline'), 'sess-a', '/proj-a'));
    // field_patch 落 leader 会话键（child 冒泡目标 = sid）——审核卡数据源（旧实现永不写）。
    expect(patchWrites).toHaveLength(1);
    expect(patchWrites[0].sid).toBe('sess-a');
    const patch = patchWrites[0].value as {
      runId: string;
      patches: Array<{ field: string; generatedBy: string }>;
    };
    expect(patch.runId).toBe('sess-a');
    expect(patch.patches[0].field).toBe('outline');
    // generatedBy 呈现真实出处（子代理自己调的写工具）。
    expect(patch.patches[0].generatedBy).toBe('outline_update（story-planner-agent 子代理）');
    // 消息面单条（handleToolEvent 统一 append——child 分支不再自己 append，不双条）+ content
    // 携分组前缀（groupChildTags 按 content 前缀分组，丢 tag 则掉出 ChildExecutionGroup 组）。
    const messages = useTestStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'ct1',
      role: 'tool',
      content: '[subagent:story-planner-agent]',
      toolResults: [{ toolName: 'outline_update' }],
    });
    showToast.mockRestore();
  });

  it('leader 路径零变化：顶层 tool 事件的 generatedBy 原样 toolId（无子代理标注）', () => {
    rememberSessionMode('sess-a', 'suggest');
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 't9',
        results: [{
          toolCallId: 'c9',
          toolName: 'outline_update',
          output: 'ok',
          metadata: { type: 'field_patch', field: 'outline', action: 'set', data: {} },
        }],
      },
    }, 'sess-a', '/proj-a'));
    expect(patchWrites).toHaveLength(1);
    const patch = patchWrites[0].value as { patches: Array<{ generatedBy: string }> };
    expect(patch.patches[0].generatedBy).toBe('outline_update');
    showToast.mockRestore();
  });

  it('后台 leader 会话（视图在 sess-a，事件属 sess-b）：child field_patch 照落键控槽 + 不进视图消息 + 不 toast', () => {
    rememberSessionMode('sess-b', 'suggest');
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev(childToolEvent('scene_graph_update', 'scene_graph', { id: 'ct2' }), 'sess-b', '/proj-a'));
    // 键控落 sess-b（切回时徽标 awaiting_review 再现——mirror 后台 leader tool 事件语义）。
    expect(patchWrites).toHaveLength(1);
    expect(patchWrites[0].sid).toBe('sess-b');
    // 后台不进视图消息 + 不 toast；run 态 activity 摘要照旧（后台分支既有行为不动）。
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
    expect(useTestStore.getState().agentRunStates['sess-b']).toMatchObject({
      phase: 'running',
      activity: 'subagent:story-planner-agent',
    });
    showToast.mockRestore();
  });

  it('mode gate：leader 发送时捕获 readonly → 子代理 patch 不写 + 不 toast（消息面照旧不受 mode 拦）', () => {
    rememberSessionMode('sess-a', 'readonly');
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev(childToolEvent('episode_outlines_update', 'episode_outlines', { id: 'ct3' }), 'sess-a', '/proj-a'));
    expect(patchWrites).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
    // 消息 append 在 mode gate 之前（同 leader 工具语义——组内消息不受权限档拦截）。
    expect(useTestStore.getState().agentMessages.map((m) => m.id)).toEqual(['ct3']);
    showToast.mockRestore();
  });
});

describe('dogfood R2 #18-B：审核卡到达 toast（写入成功 + 活跃视图）', () => {
  it('leader field_patch 写入 → 3s info toast（i18n agent.patchArrived，resolvedLocale 生效）', () => {
    rememberSessionMode('sess-a', 'suggest');
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 't10',
        results: [{
          toolCallId: 'c10',
          toolName: 'outline_update',
          output: 'ok',
          metadata: { type: 'field_patch', field: 'outline', action: 'set', data: {} },
        }],
      },
    }, 'sess-a', '/proj-a'));
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('AI 产出了字段改动，待你审阅（面板底部）', 'info', 3000);
    showToast.mockRestore();
  });

  it('child 路由的 field_patch 到达（活跃视图）同弹 toast', () => {
    rememberSessionMode('sess-a', 'suggest');
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev(childToolEvent('outline_update', 'outline'), 'sess-a', '/proj-a'));
    expect(showToast).toHaveBeenCalledWith('AI 产出了字段改动，待你审阅（面板底部）', 'info', 3000);
    showToast.mockRestore();
  });

  it('无 field_patch 的普通写工具（chapter_review 路径）不弹 toast', () => {
    rememberSessionMode('sess-a', 'suggest');
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});
    handleAgentStreamEvent(useTestStore, ev({
      type: 'tool',
      data: {
        id: 't11',
        results: [{
          toolCallId: 'c11',
          toolName: 'write_chapter',
          output: 'paused',
          metadata: { type: 'chapter_review', stage: 'draft', chapterId: 'ch_1', draftContent: '正文' },
        }],
      },
    }, 'sess-a', '/proj-a'));
    expect(patchWrites).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
    showToast.mockRestore();
  });
});

describe('CR-T1-026 路径归一比较（渲染层与 shell normalizeProjectKey 同规则子集）', () => {
  it('事件 projectPath 漂移形态（反斜杠/尾斜杠/盘符大小写）仍判活跃视图；真跨项目仍隔离', () => {
    useTestStore.setState({ currentProject: { path: 'C:/proj/a' } as never });
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    // 漂移形态（链 IPC 不归一透传的典型形态）→ 活跃视图（compaction toast 弹 = isActiveView 证）。
    handleAgentStreamEvent(useTestStore, ev({ type: 'compaction', data: { compactedCount: 1 } }, 'sess-a', 'c:\\PROJ\\A\\'));
    expect(showToast).toHaveBeenCalledTimes(1);

    // 真跨项目（不同路径）→ 后台隔离，不再弹。
    handleAgentStreamEvent(useTestStore, ev({ type: 'compaction', data: { compactedCount: 1 } }, 'sess-a', 'D:/other'));
    expect(showToast).toHaveBeenCalledTimes(1);

    showToast.mockRestore();
  });

  it('sameProjectPath 单元：分隔符/尾斜杠/盘符大小写归一；空值维持恒等真值表', () => {
    expect(sameProjectPath('C:\\Proj\\A/', 'c:/proj/a')).toBe(true);
    expect(sameProjectPath('/proj/a/', '/proj/a')).toBe(true);
    expect(sameProjectPath('/proj/a', '/proj/b')).toBe(false);
    expect(sameProjectPath(undefined, undefined)).toBe(true); // 两者皆空恒等（兼容旧真值表）
    expect(sameProjectPath('/proj/a', undefined)).toBe(false);
  });
});

describe('CR-T1-023 事件创建 run 态带 projectPath（后台分支）', () => {
  it('confirm_required 后台分支 → run 态落 event.projectPath（非 undefined 通配）', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'confirm_required',
      data: { callId: 'c-bg', name: 'write_file', input: {} },
    }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']).toMatchObject({
      phase: 'running',
      projectPath: '/proj-a',
    });
  });

  it('child 后台分支 → run 态落 event.projectPath + activity 摘要', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'child',
      data: {
        source: 'subagent',
        role: 'researcher',
        sessionId: 'child-1',
        depth: 1,
        event: { type: 'assistant', data: { id: 'mc', content: 'x' } },
      },
    }, 'sess-b', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-b']).toMatchObject({
      phase: 'running',
      projectPath: '/proj-a',
      activity: 'subagent:researcher',
    });
  });

  it('缺 projectPath 载荷（旧事件形态）→ 维持既有通配语义（不写 undefined 键）', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'confirm_required',
      data: { callId: 'c-np', name: 'write_file', input: {} },
    }, 'sess-b'));
    expect(useTestStore.getState().agentRunStates['sess-b']?.projectPath).toBeUndefined();
  });
});

describe('CR-T1-048 项目级链锚（decision 2A：dogfood stub 会话的链卡可见面）', () => {
  it('chain-delta / chain-node-done 事件登记项目锚（归一 key → 链持有会话）', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', phase: 'writing', messageId: 'm1', delta: '正文', seq: 0 },
    }, 'stub-parent-1', '/proj-a'));
    expect(useTestStore.getState().chainRunAnchorByProject?.['/proj-a']).toBe('stub-parent-1');

    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-node-done',
      data: { nodeId: 'brief-compiler-node', status: 'done' },
    }, 'stub-parent-1', '/proj-a'));
    expect(useTestStore.getState().chainRunAnchorByProject?.['/proj-a']).toBe('stub-parent-1');
  });

  it('projectPath 漂移形态归一到同一锚键（反斜杠/尾斜杠/盘符大小写——CR-T1-026 同源）', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-node-done',
      data: { nodeId: 'brief-compiler-node', status: 'done' },
    }, 'stub-parent-1', 'c:\\PROJ\\A\\'));
    const anchors = useTestStore.getState().chainRunAnchorByProject;
    expect(Object.keys(anchors ?? {})).toEqual(['c:/proj/a']);
    expect(anchors?.['c:/proj/a']).toBe('stub-parent-1');
  });

  it('值守卫：同链后续高频 delta 不重复写锚（引用稳定，r7「勿每 delta 一次 set」）', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', messageId: 'm1', delta: 'a', seq: 0 },
    }, 'stub-parent-1', '/proj-a'));
    const first = useTestStore.getState().chainRunAnchorByProject;
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', messageId: 'm1', delta: 'b', seq: 0 },
    }, 'stub-parent-1', '/proj-a'));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', messageId: 'm1', delta: 'c', seq: 0 },
    }, 'stub-parent-1', '/proj-a'));
    expect(useTestStore.getState().chainRunAnchorByProject).toBe(first);
  });

  it('跨项目隔离：他项目链事件只登他项目锚键，不碰当前项目', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-node-done',
      data: { nodeId: 'brief-compiler-node', status: 'done' },
    }, 'stub-other', '/proj-B'));
    expect(useTestStore.getState().chainRunAnchorByProject?.['/proj-a']).toBeUndefined();
    // 非盘符路径不归大小写（normalizeProjectPathForCompare 仅盘符小写）——键保原样。
    expect(useTestStore.getState().chainRunAnchorByProject?.['/proj-B']).toBe('stub-other');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dogfood R2 #105 假中断根治（2026-08-30）：resume 链事件按同一 leader sessionId 广播、跑在
// leader turn 生命周期外——leader turn 结束（done）不构成「链被掐」证据。在途 resume IPC 判据
// （reviewResuming + 该会话 pausedReview 键）命中 → done 兜底不 finalize（不误标 aborted 不删
// 缓冲）不归位 run 态；未命中 → 兜底行为照旧。
// ═══════════════════════════════════════════════════════════════════════════
describe('dogfood R2 #105 假中断根治（done 兜底前置守卫）', () => {
  /** 起一条在跑链（resume 车道事件形态——chain-delta + node-done 置 running）。 */
  function startRunningChain(sid = 'sess-a') {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: { nodeId: 'brief-compiler-node', role: 'brief-compiler-node', phase: 'compiling', messageId: 'm1', delta: 'x', seq: 0 },
    }, sid, '/proj-a'));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-node-done',
      data: { nodeId: 'brief-compiler-node', status: 'done' },
    }, sid, '/proj-a'));
  }

  it('resume IPC 在途（reviewResuming + 该会话 pausedReview 在）→ leader turn done 不误标 aborted、run 态不清', () => {
    startRunningChain('sess-a');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');
    // resume IPC 在途（ChapterReviewPanel 三动作已发出、长跑 IPC 未返回）。
    useTestStore.setState({
      reviewResumingBySession: { 'sess-a': true },
      pausedReviewBySession: { 'sess-a': { type: 'chapter_review', stage: 'draft' } },
    });

    // leader turn 结束（resume 跑在 turn 外——done 不构成链被掐证据）。
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-a', '/proj-a'));

    // 链不被误终态化（终态由哨兵帧 / resume summary 和解定）+ run 态维持 running。
    expect(useTestStore.getState().chainRunBySession['sess-a']?.status).toBe('running');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');
  });

  it('resume 不在途（reviewResuming=false）→ done 兜底照旧：链 running 标 aborted + run 态归 idle', () => {
    startRunningChain('sess-a');
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().chainRunBySession['sess-a']?.status).toBe('aborted');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');
  });

  it('reviewResuming 在途但该会话无 pausedReview 键（双条件防残值误放行）→ 兜底照旧', () => {
    startRunningChain('sess-a');
    useTestStore.setState({ reviewResumingBySession: { 'sess-a': true }, pausedReviewBySession: { 'sess-other': { type: 'chapter_review' } } });
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().chainRunBySession['sess-a']?.status).toBe('aborted');
  });

  // 09-13 子3 W4：键控后两线交叉场景——链事件流键 = 事件 sid（stub 链会话）≠ 审阅动作键控的
  // agentSessionId。resume 在途键挂在审阅会话（sess-a）时，stub 链 sid 的 done 事件守卫不命中
  // （键空差）→ 该链照旧兜底 aborted——守卫只放行「自己会话」的在途 resume，不误放行他链。
  it('W4 两线交叉：reviewResumingBySession 挂 sess-a，done 事件 sid = stub 链 → 守卫不命中照旧 aborted', () => {
    startRunningChain('stub-chain-1');
    useTestStore.setState({
      reviewResumingBySession: { 'sess-a': true },
      pausedReviewBySession: { 'sess-a': { type: 'chapter_review', stage: 'draft' } },
    });
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'stub-chain-1', '/proj-a'));
    expect(useTestStore.getState().chainRunBySession['stub-chain-1']?.status).toBe('aborted');
  });

  it('pausedReview 在但 reviewResuming=false（IPC 已返回）→ 兜底照旧（守卫只在真在途窗口放行）', () => {
    startRunningChain('sess-a');
    useTestStore.setState({
      reviewResumingBySession: {},
      pausedReviewBySession: { 'sess-a': { type: 'chapter_review', stage: 'draft' } },
    });
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().chainRunBySession['sess-a']?.status).toBe('aborted');
  });

  // CR-9：escalate 暂停不产 pausedReview（resume 载荷落 escalateFindingsBySession）——
  // escalate 车道的 accept/redo flight 窗口同享守卫：resuming=true + escalate 键在（pausedReview
  // 缺席）→ leader done 不误标 aborted。
  it('CR-9 escalate 变体：resuming 在途 + escalate 键在（无 pausedReview）→ done 兜底不误终态化', () => {
    startRunningChain('sess-a');
    useTestStore.setState({
      reviewResumingBySession: { 'sess-a': true },
      pausedReviewBySession: {},
      escalateFindingsBySession: { 'sess-a': { source: 'reader-audit', route: 'escalate_user', items: [], at: 1 } },
    });
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().chainRunBySession['sess-a']?.status).toBe('running');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');
  });

  it('CR-9 反向：resuming=true 但两载荷键都缺（残值）→ 兜底照旧 aborted（双条件防误放行不放松）', () => {
    startRunningChain('sess-a');
    useTestStore.setState({
      reviewResumingBySession: { 'sess-a': true },
      pausedReviewBySession: {},
      escalateFindingsBySession: {},
    });
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().chainRunBySession['sess-a']?.status).toBe('aborted');
  });
});

describe('CR-T1-029/033 已删会话：tombstone 丢事件 + 模块 Map 修剪', () => {
  it('rememberDeletedSession 后该 id 事件整体丢弃——run 态/键控槽不重建（僵尸不复活）', () => {
    rememberDeletedSession('sess-del');
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm1', channel: 'text', delta: 'x' } }, 'sess-del', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-del']).toBeUndefined();
    handleAgentStreamEvent(useTestStore, ev({
      type: 'confirm_required',
      data: { callId: 'c', name: 'write_file', input: {} },
    }, 'sess-del', '/proj-a'));
    expect(confirmWrites).toHaveLength(0);
  });

  it('forgetSessionTrack 修剪模块级 Map + 登记 tombstone（后续事件丢弃）', () => {
    rememberSessionProject('sess-x', '/proj-x');
    rememberSessionMode('sess-x', 'auto');
    forgetSessionTrack('sess-x');
    expect(getSessionProject('sess-x')).toBeUndefined();
    expect(getSessionMode('sess-x')).toBeUndefined();
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm2', channel: 'text', delta: 'x' } }, 'sess-x', '/proj-x'));
    expect(useTestStore.getState().agentRunStates['sess-x']).toBeUndefined();
  });
});

describe('r8 徽标状态机派生', () => {
  it('awaiting_confirm > awaiting_review > running > idle 优先级', () => {
    const state = {
      agentRunStates: { s1: { sessionId: 's1', phase: 'running', updatedAt: 1 } },
      pendingToolConfirmBySession: { s1: { callId: 'c' } },
      pendingDiffsBySession: { s1: [{ id: 'd' }] },
      pendingPatchBySession: {},
      pausedReviewBySession: {},
    };
    expect(deriveSessionBadge(state, 's1')).toBe('awaiting_confirm');

    const noConfirm = { ...state, pendingToolConfirmBySession: {} };
    expect(deriveSessionBadge(noConfirm, 's1')).toBe('awaiting_review');

    const noPending = { ...noConfirm, pendingDiffsBySession: {} };
    expect(deriveSessionBadge(noPending, 's1')).toBe('running');

    const idle = { ...noPending, agentRunStates: {} };
    expect(deriveSessionBadge(idle, 's1')).toBe('idle');
  });
});

describe('D3 切换解耦（UI 面）', () => {
  it('切换不 abort：后台 run 继续产事件进后台 run 态（跨项目切换存活）', () => {
    // 会话 A（proj-a）在跑 → 切到空视图（newAgentSession——D3 不 abort）。
    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running', projectPath: '/proj-a' });
    void useTestStore.getState().newAgentSession();
    expect((window as any).orisonDesktop.abortAgentRun).not.toHaveBeenCalled();

    // A 的后续事件（视图已切走）→ 只更新后台 run 态。
    handleAgentStreamEvent(useTestStore, ev({ type: 'child', data: { source: 'subagent', role: 'researcher', sessionId: 'child-1', depth: 1, event: { type: 'assistant', data: { id: 'mc', content: 'x' } } } }, 'sess-a', '/proj-a'));
    expect(useTestStore.getState().agentMessages).toHaveLength(0);
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');
    expect(useTestStore.getState().agentRunStates['sess-a']?.activity).toBe('subagent:researcher');

    // 切回 A → 视图恢复（fetch 对账由 switchAgentSession 真 slice 路径覆盖，此处验证视图会话指针）。
    void useTestStore.getState().switchAgentSession('sess-a');
    expect(useTestStore.getState().agentSessionId).toBe('sess-a');
    expect((window as any).orisonDesktop.abortAgentRun).not.toHaveBeenCalled();
  });
});

describe('D4 UI 面（同项目单 run）——真 agentSessionSlice 驱动', () => {
  const useSliceStore = create<SliceState>()((...args) => ({
    currentProject: null,
    activeChapterId: null,
    resolvedLocale: 'zh-CN',
    clearSessionPending: vi.fn(),
    clearPausedReviewFor: vi.fn(),
    clearPendingPatchFor: vi.fn(),
    clearReviewLocalStateFor: vi.fn(),
    ...createAgentSessionSlice(...args),
  }));

  beforeEach(() => {
    apiMocks.createAgentSession.mockClear();
    apiMocks.createAgentSession.mockResolvedValue({ id: 'sess-a', messages: [] });
    apiMocks.streamAgentMessage.mockClear();
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    useToastStore.setState({ toasts: [] });
    useSliceStore.setState({
      currentProject: { path: '/proj-a' },
      agentSessionId: 'sess-a',
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      chainRunBySession: {},
      chainRunAnchorByProject: {},
      agentError: null,
      agentMode: 'suggest',
      agentBehaviorMode: 'normal',
      pendingAttachments: [],
    } as any);
  });

  it('本地预检：该项目另一会话在跑 → 不发 invoke + toast（一键跳转到占用会话）', async () => {
    useSliceStore.setState({
      agentRunStates: { 'sess-b': { sessionId: 'sess-b', phase: 'running', projectPath: '/proj-a', updatedAt: 1 } },
    } as any);
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useSliceStore.getState().sendAgentMessage('写一章');

    expect(apiMocks.streamAgentMessage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const action = showToast.mock.calls[0][3];
    expect(action?.label).toBeTruthy();
    action?.onClick();
    // toast 动作 = switchAgentSession(占用会话)（一键跳转）。
    await vi.waitFor(() => {
      expect(useSliceStore.getState().agentSessionId).toBe('sess-b');
    });
    showToast.mockRestore();
  });

  it('跨项目 run 不拦（D4 跨项目自由并行）', async () => {
    useSliceStore.setState({
      agentRunStates: { 'sess-other': { sessionId: 'sess-other', phase: 'running', projectPath: '/proj-B', updatedAt: 1 } },
    } as any);
    await useSliceStore.getState().sendAgentMessage('写一章');
    expect(apiMocks.streamAgentMessage).toHaveBeenCalledWith('sess-a', '写一章', expect.anything());
  });

  it('shell 结构化拒绝（status=rejected）→ run 态复位 + toast + 视图 loading 复位（spinner 不永卡）', async () => {
    apiMocks.streamAgentMessage.mockImplementation(async () => ({
      status: 'rejected',
      code: 'project_run_active',
      heldBySessionId: 'sess-b',
      projectPath: '/proj-a',
    }));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useSliceStore.getState().sendAgentMessage('写一章');

    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(useSliceStore.getState().activeSessionRunning).toBe(false);
    });
    expect(useSliceStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');
    showToast.mockRestore();
  });

  it('CR-T1-013 UI 面：session_run_active 拒绝 → run 态保持 running（run 真的在跑）+ 视图 spinner 复位 + 无跳转 toast', async () => {
    apiMocks.streamAgentMessage.mockImplementation(async () => ({
      status: 'rejected',
      code: 'session_run_active',
      heldBySessionId: 'sess-a',
      projectPath: '/proj-a',
    }));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useSliceStore.getState().sendAgentMessage('写一章');

    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(useSliceStore.getState().activeSessionRunning).toBe(false);
    });
    // run 态保持 running（归 idle 会误开生成闸——invoke1 仍在跑）。
    expect(useSliceStore.getState().agentRunStates['sess-a']?.phase).toBe('running');
    // 无跳转钮（占用者就是本会话）。
    expect(showToast.mock.calls[0][3]).toBeUndefined();
    showToast.mockRestore();
  });

  it('CR-T1-030 UI 面：占用者为链租约 id（chain-run:closure:*）→ 换文案不提供跳转钮', async () => {
    apiMocks.streamAgentMessage.mockImplementation(async () => ({
      status: 'rejected',
      code: 'project_run_active',
      heldBySessionId: 'chain-run:closure:abc-123',
      projectPath: '/proj-a',
    }));
    const showToast = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

    await useSliceStore.getState().sendAgentMessage('写一章');

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast.mock.calls[0][3]).toBeUndefined(); // 无跳转（stub 会话不可跳）
    showToast.mockRestore();
  });

  it('CR-T1-029/033：删除 run 在途会话——先 best-effort abort、run 态/链态清理、tombstone 丢后续事件', async () => {
    useSliceStore.setState({
      agentRunStates: { 'sess-del': { sessionId: 'sess-del', phase: 'running', projectPath: '/proj-a', updatedAt: 1 } },
      chainRunBySession: { 'sess-del': { sessionId: 'sess-del', status: 'running', completedNodes: [], currentNodeId: null, errorNodeId: null, streamNodeId: null, streamRole: null, streamPhase: null, streamText: '', streaming: false, updatedAt: 1 } },
    } as any);
    apiMocks.deleteAgentSession.mockResolvedValue(true);

    await useSliceStore.getState().deleteAgentSession('sess-del');

    // best-effort 先停（runtime.deleteSession 不 abort 在途 run）。
    expect((window as any).orisonDesktop.abortAgentRun).toHaveBeenCalledWith('sess-del');
    // run 态 + 链运行态随会话消亡。
    expect(useSliceStore.getState().agentRunStates['sess-del']).toBeUndefined();
    expect(useSliceStore.getState().chainRunBySession['sess-del']).toBeUndefined();
    // tombstone：主进程残流事件整体丢弃（不重建条目——僵尸不复活）。
    handleAgentStreamEvent(useTestStore, ev({ type: 'delta', data: { messageId: 'm9', channel: 'text', delta: 'x' } }, 'sess-del', '/proj-a'));
    expect(useTestStore.getState().agentRunStates['sess-del']).toBeUndefined();
  });

  it('CR-T1-024：invoke 终态兜底对称清 agentRunStates——事件丢失竞态（无 done/error 事件）下 run 态不永挂 running', async () => {
    // 事件面丢失（窗口关闭期 sendEvent 被吞等）——mock invoke 直接返终态、零事件。
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));

    await useSliceStore.getState().sendAgentMessage('写一章');

    await vi.waitFor(() => {
      // 只清 activeSessionRunning（旧行为）的话 isProjectRunActive 永久假真（生成闸全禁）。
      expect(useSliceStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');
      expect(useSliceStore.getState().activeSessionRunning).toBe(false);
    });
  });

  it('CR-T1-024：invoke 终态 error → run 态落 error 相位（mirror error 事件）', async () => {
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'error' }));

    await useSliceStore.getState().sendAgentMessage('写一章');

    await vi.waitFor(() => {
      expect(useSliceStore.getState().agentRunStates['sess-a']?.phase).toBe('error');
    });
  });

  it('CR-T1-048：deleteAgentSession 清指向该会话的项目锚（防悬空锚），他会话的锚保留', async () => {
    useSliceStore.setState({
      chainRunAnchorByProject: { '/proj-a': 'sess-del', '/proj-other': 'sess-keep' },
    } as any);
    apiMocks.deleteAgentSession.mockResolvedValue(true);

    await useSliceStore.getState().deleteAgentSession('sess-del');

    expect(useSliceStore.getState().chainRunAnchorByProject).toEqual({ '/proj-other': 'sess-keep' });
  });
});

describe('r8 前台渲染门（组件只渲染当前视图会话的卡）', () => {
  it('AgentConfirmCard：后台会话（sess-b）的确认卡不渲染；视图会话的渲染', async () => {
    const { render, screen, cleanup, act } = await import('@testing-library/react');
    const { AgentConfirmCard } = await import('../src/features/agent-panel/AgentConfirmCard');
    const { useAppStore } = await import('../src/shared/store/appStore');

    useAppStore.setState({
      resolvedLocale: 'zh-CN',
      agentSessionId: 'sess-a',
      pendingToolConfirmBySession: {
        'sess-b': { callId: 'c-b', name: 'write_file', input: { x: 1 } },
      },
    } as any);
    const { createElement } = await import('react');
    const { container } = render(createElement(AgentConfirmCard));
    // 后台会话的卡不漏进前台。
    expect(container.querySelector('.agent-confirm-card')).toBeNull();

    await act(async () => {
      useAppStore.setState({
        pendingToolConfirmBySession: {
          'sess-a': { callId: 'c-a', name: 'write_file', input: { x: 1 } },
        },
      } as any);
    });
    expect(container.querySelector('.agent-confirm-card')).not.toBeNull();
    expect(screen.getByText('write_file')).toBeTruthy();
    cleanup();
  });
});
