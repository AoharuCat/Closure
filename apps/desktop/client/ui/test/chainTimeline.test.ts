/**
 * 09-13 子3 W2（design §2 / §8）：写作页运行时间线 store（chainTimeline）。
 *
 * 覆盖（design §8 timeline 面全项）：
 * - append-only 累积（同 nodeId 多 attempt——环重跑各持 entry，到达序即圈序）。
 * - 同 attempt 覆写重发（through verdict）取末帧 / resume done 帧重放 absorb（累积无洞）。
 * - 新 run 重置（终态后首条链事件；text delta 也参与边界但不积累）+ 终态保留 entries。
 * - reasoning 分段（messageId 换轮）与双 cap（per-segment REASONING_TAIL_CAP 保尾弃头 +
 *   会话总量 cap LRU 丢最旧段）。
 * - paused 窗口跳过（CR-21 口径）。
 * - tool 累积 / done-only 兜底 entry / 节流 flush（fake timers，含等值跳过）。
 * - 清理（forgetChainTimeline + 哨兵/finalize 的 pending 尾巴 force 落）。
 * - dispatcher 接线（chain-node-artifact / chain-tool case + chain-delta·done 双写 +
 *   done 兜底 finalizeChainTimeline）+ escalate findings 路由（metadata.findings →
 *   escalateFindingsBySession，条目级防御投影）+ CR-3① 新 run 重置同点失效。
 * - CR-19 全局 reasoning 预算分层保留（清旧终态链文本 → 仍超限丢最旧链；活跃/观察链不降级）。
 * - nodeCatalog 对拍 gate（键集 === CHAIN_NODE_ORDER）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent } from '../src/shared/api/agent';

const apiMocks = vi.hoisted(() => ({
  fetchAgentSession: vi.fn(async () => null),
}));

vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});

import { handleAgentStreamEvent, __clearAgentEventTracks, type AgentDispatchState, type AgentStreamWireEvent } from '../src/shared/store/agentEvents';
import {
  __clearChainTimelineState,
  applyTimelineArtifact,
  applyTimelineChainDelta,
  applyTimelineNodeDone,
  applyTimelineTool,
  finalizeChainTimeline,
  forgetChainTimeline,
  projectEscalateFindingItems,
  SESSION_REASONING_TOTAL_CAP,
  type ChainTimelineState,
  type EscalateFindingsEntry,
  type TimelineNodeEntry,
} from '../src/shared/store/chainTimeline';
import {
  CHAIN_RUN_SENTINEL_NODE_ID,
  CHAIN_NODE_ORDER,
  REASONING_TAIL_CAP,
  type ChainNodeArtifactSummary,
  type ChainRunState,
  type ChainRunStatus,
} from '../src/shared/store/chainStreamBuffer';
import { CHAIN_NODE_CATALOG, CHAIN_NODE_SEGMENTS } from '../src/features/writing/nodeCatalog';

// ── 测试 store（直接满足 AgentDispatchState + 时间线三键——dispatcher 集成与直apply 共用） ──

type TestState = AgentDispatchState & {
  chainTimelineBySession: Record<string, ChainTimelineState>;
  escalateFindingsBySession: Record<string, EscalateFindingsEntry>;
  pausedReviewBySession: Record<string, unknown>;
  /** CR-19：写作页观察链指针（保护面——观察链不降级）。 */
  selectedChainSessionId?: string | null;
};

const useTestStore = create<TestState>()((set) => ({
  agentSessionId: 'sess-a',
  agentMessages: [],
  activeSessionRunning: false,
  agentError: null,
  currentProject: { path: '/proj-a' },
  agentRunStates: {},
  chainRunBySession: {},
  chainRunAnchorByProject: {},
  chainTimelineBySession: {},
  escalateFindingsBySession: {},
  setAgentRunState: (sessionId, patch) => set((s) => ({
    agentRunStates: { ...s.agentRunStates, [sessionId]: { sessionId, phase: patch.phase ?? 'idle', updatedAt: Date.now() } },
  })),
  setPendingToolConfirm: () => {},
  pushPendingDiff: () => {},
  setPausedReview: () => {},
  setPendingPatch: () => {},
  fieldMetadata: {},
  resolvedLocale: 'zh-CN',
  pausedReviewBySession: {},
}));

function tl(sid = 'sess-a'): ChainTimelineState | undefined {
  return useTestStore.getState().chainTimelineBySession[sid];
}

function entries(sid = 'sess-a'): TimelineNodeEntry[] {
  return tl(sid)?.entries ?? [];
}

function runStateOf(sid: string, status: ChainRunStatus): ChainRunState {
  return {
    sessionId: sid,
    status,
    completedNodes: [],
    currentNodeId: null,
    errorNodeId: null,
    streamNodeId: null,
    streamRole: null,
    streamPhase: null,
    streamText: '',
    streaming: false,
    updatedAt: Date.now(),
  };
}

/** seed 链运行态（paused 窗口跳过 / 终态边界判定的 peer 面——时间线只读它判 paused）。 */
function seedRun(sid = 'sess-a', status: ChainRunStatus = 'running'): void {
  useTestStore.setState((s) => ({ chainRunBySession: { ...s.chainRunBySession, [sid]: runStateOf(sid, status) } }));
}

function reasoningDelta(over: Partial<{ nodeId: string; messageId: string; delta: string; seq: number; phase?: string }> = {}) {
  return {
    nodeId: over.nodeId ?? 'brief-reviewer-node',
    role: 'brief-reviewer-agent',
    ...(over.phase !== undefined ? { phase: over.phase } : {}),
    messageId: over.messageId ?? 'rm1',
    delta: over.delta ?? '',
    seq: over.seq ?? 0,
    channel: 'reasoning' as const,
  };
}

function textDelta(over: Partial<{ nodeId: string; messageId: string; delta: string; seq: number }> = {}) {
  return {
    nodeId: over.nodeId ?? 'draft-writer-agent',
    role: 'draft-writer-agent',
    phase: 'writing',
    messageId: over.messageId ?? 'm1',
    delta: over.delta ?? '',
    seq: over.seq ?? 0,
  };
}

function chainNodeDone(nodeId: string, status: string) {
  return { nodeId, status };
}

function artifactOf(nodeId: string, summary: ChainNodeArtifactSummary, seq = -1) {
  return { nodeId, role: nodeId, seq, summary };
}

function toolOf(nodeId: string, toolName: string) {
  return { nodeId, toolName, inputSummary: `{"q":"${toolName}"}`, status: 'ok' as const, ...(toolName === 'with-count' ? { resultCount: 12 } : {}) };
}

function ev(event: AgentStreamEvent, sessionId = 'sess-a'): AgentStreamWireEvent {
  return { ...event, sessionId, projectPath: '/proj-a' };
}

beforeEach(() => {
  vi.useFakeTimers();
  __clearChainTimelineState();
  __clearAgentEventTracks();
  useTestStore.setState({
    agentRunStates: {},
    chainRunBySession: {},
    chainTimelineBySession: {},
    escalateFindingsBySession: {},
    pausedReviewBySession: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  __clearChainTimelineState();
});

// ════════════════════════════════════════════════════════════════════════════
// append-only 与 attempt 语义（design §2.1——到达序 = attempt 锚；seq 只辨新 run）
// ════════════════════════════════════════════════════════════════════════════

describe('append-only 累积（同 nodeId 多 attempt）', () => {
  it('环重跑：artifact→done×2 圈各持 entry（seq 同 run 不变——不作 attempt 锚）；第二圈 tool 归第二圈 entry', () => {
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('route-agent', { kind: 'line', line: '第1圈判决' }, 2));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('route-agent', 'done'));
    // 环回圈：同 nodeId 重跑（seq 不变——同 run 内环重跑）。
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('route-agent', { kind: 'line', line: '第2圈判决' }, 2));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('route-agent', 'done'));

    expect(entries()).toHaveLength(2);
    expect(entries()[0]).toMatchObject({ nodeId: 'route-agent', seq: 2, status: 'done' });
    expect(entries()[0].summary).toEqual({ kind: 'line', line: '第1圈判决' });
    expect(entries()[1].summary).toEqual({ kind: 'line', line: '第2圈判决' });
  });

  it('同 attempt 覆写重发（through verdict）取末帧：无 done 间隔的第二次 artifact 覆写 summary', () => {
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('route-agent', { kind: 'line', line: 'v1' }));
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('route-agent', { kind: 'line', line: 'v2（覆写）' }));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].summary).toEqual({ kind: 'line', line: 'v2（覆写）' });
  });

  it('resume done 帧重放 absorb：closed entry 后重放 done 不建重复 entry（累积无洞契约）', () => {
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('brief-compiler-node', { kind: 'brief-card', brief: {} }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    // resume 后的前缀 done 帧重放（artifact 帧不重放）。
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].status).toBe('done');
  });

  it('done-only 路径（无先导事件）建终态 entry（seq -1）', () => {
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('world-merge-node', 'done'));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ nodeId: 'world-merge-node', seq: -1, status: 'done' });
  });

  it('error/blocked 终态映射', () => {
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('world-extractor-physical', 'error'));
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('emotion-verify-node', { kind: 'line', line: 'x' }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('emotion-verify-node', 'blocked'));
    expect(entries()[0].status).toBe('error');
    expect(entries()[1].status).toBe('blocked');
  });
});

describe('tool 累积（调查层）', () => {
  it('tool 事件累积进当前 attempt entry；环重跑后归新 entry；resultCount 透传', () => {
    applyTimelineTool(useTestStore, 'sess-a', { ...toolOf('draft-writer-agent', 'query_story'), resultCount: 12 });
    applyTimelineTool(useTestStore, 'sess-a', toolOf('draft-writer-agent', 'web_search'));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].tools).toHaveLength(2);
    expect(entries()[0].tools[0]).toMatchObject({ toolName: 'query_story', resultCount: 12, status: 'ok' });
    expect(entries()[0].tools[1].resultCount).toBeUndefined();

    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('draft-writer-agent', 'done'));
    // 环回圈：tool 归新 attempt entry。
    applyTimelineTool(useTestStore, 'sess-a', toolOf('draft-writer-agent', 'query_world'));
    expect(entries()).toHaveLength(2);
    expect(entries()[1].tools).toEqual([expect.objectContaining({ toolName: 'query_world' })]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 新 run 重置与终态保留（design §2.1——终态保留 entries；ended 后首条链事件重置）
// ════════════════════════════════════════════════════════════════════════════

describe('新 run 重置与终态保留', () => {
  it('哨兵终态：runEnded 标记 + entries 保留（回看）；finalizeChainTimeline 兜底同款', () => {
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('brief-compiler-node', { kind: 'brief-card', brief: {} }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    expect(tl()?.runEnded).toBe(true);
    expect(entries()).toHaveLength(1); // 终态保留

    // finalize 兜底（无哨兵路径）：runEnded 标记不重复写。
    finalizeChainTimeline(useTestStore, 'sess-a');
    expect(tl()?.runEnded).toBe(true);
    expect(entries()).toHaveLength(1);
  });

  it('终态后首条链事件（artifact）= 新 run：entries 重置从头累积', () => {
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('brief-compiler-node', { kind: 'brief-card', brief: { a: 1 } }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('brief-compiler-node', { kind: 'brief-card', brief: { b: 2 } }));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].summary).toEqual({ kind: 'brief-card', brief: { b: 2 } });
    expect(tl()?.runEnded).toBeUndefined(); // 重置消费终态记忆
  });

  it('text delta 也参与新 run 边界判定（但不积累——正文流 streamText 单源）', () => {
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('brief-compiler-node', { kind: 'line', line: '旧' }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'aborted'));
    applyTimelineChainDelta(useTestStore, 'sess-a', textDelta({ delta: '新 run 首帧' }));
    expect(entries()).toHaveLength(0); // 重置发生，text 不积累
  });

  it('哨兵 paused 非终态：不标 runEnded——resume 续同链跨 pause/resume 累积无洞', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', delta: '改稿前思考' }));
    vi.advanceTimersByTime(250);
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    expect(tl()?.runEnded).toBeUndefined();
    // resume：同节点新轮思考 + node-done 收口。
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r2', delta: '改稿后思考' }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].reasoning.map((s) => s.text)).toEqual(['改稿前思考', '改稿后思考']);
    expect(entries()[0].status).toBe('done');
  });

  it('reasoning-first 新 run 不被反复重置（终态记忆自持——peer chainRunBySession 仍终态时旧实现会反复 wipe）', () => {
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('brief-compiler-node', { kind: 'line', line: '旧 run' }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    // 注意：不 seed 新 run 的 chainRunBySession（reasoning 车道不翻 run 态——正是边界记忆
    // 必须自持的原因：读 peer status 会在第二条 delta 时再次误判终态反复重置）。
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ nodeId: 'brief-reviewer-node', messageId: 'r1', delta: '第一段' }));
    vi.advanceTimersByTime(250);
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ nodeId: 'brief-reviewer-node', messageId: 'r2', delta: '第二段' }));
    vi.advanceTimersByTime(250);
    const entry = entries().find((e) => e.nodeId === 'brief-reviewer-node');
    expect(entry?.reasoning.map((s) => s.text)).toEqual(['第一段', '第二段']); // 第一段没被第二条 delta 的假重置抹掉
  });
});

// ════════════════════════════════════════════════════════════════════════════
// reasoning 分段与双 cap + paused 窗口跳过（design §2.1 量控 / CR-21 口径）
// ════════════════════════════════════════════════════════════════════════════

describe('reasoning 分段与双 cap', () => {
  it('messageId 换轮分段 + phase 透传', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', phase: 'research', delta: '调查思考' }));
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', phase: 'research', delta: '（续）' }));
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r2', phase: 'writing', delta: '写作思考' }));
    vi.advanceTimersByTime(250);
    expect(entries()).toHaveLength(1);
    expect(entries()[0].reasoning).toEqual([
      { messageId: 'r1', phase: 'research', text: '调查思考（续）' },
      { messageId: 'r2', phase: 'writing', text: '写作思考' },
    ]);
  });

  it('per-segment cap = REASONING_TAIL_CAP 数值复用（保尾弃头）', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: 'A'.repeat(REASONING_TAIL_CAP + 5000) }));
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: 'B' }));
    vi.advanceTimersByTime(250);
    const seg = entries()[0]?.reasoning[0];
    expect(seg?.text.length).toBe(REASONING_TAIL_CAP);
    expect(seg?.text.endsWith('B')).toBe(true);
  });

  it('会话总量 cap：超 SESSION_REASONING_TOTAL_CAP 丢最旧 segment（LRU）', () => {
    // 14 段 × 20K = 280K > 256K——最旧 1 段被丢（260K ≤ cap）。
    for (let i = 1; i <= 14; i++) {
      applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: `r${i}`, delta: `${i % 10}`.repeat(REASONING_TAIL_CAP) }));
    }
    vi.advanceTimersByTime(250);
    const segs = entries()[0]?.reasoning ?? [];
    expect(segs.length).toBe(13); // 最旧 r1 被丢
    expect(segs[0].messageId).toBe('r2');
    const total = segs.reduce((n, s) => n + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(SESSION_REASONING_TOTAL_CAP);
  });

  it('paused 窗口跳过（CR-21 口径）：run paused 期间 reasoning 不积累；resume 后照常', () => {
    seedRun('sess-a', 'running');
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', delta: 'pause 前思考' }));
    vi.advanceTimersByTime(250);
    seedRun('sess-a', 'paused');
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r2', delta: '审阅等待期尾帧（丢弃）' }));
    vi.advanceTimersByTime(500);
    expect(entries()[0]?.reasoning.map((s) => s.text)).toEqual(['pause 前思考']);
    // resume（peer 翻 running）后照常入缓冲。
    seedRun('sess-a', 'running');
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r2', delta: '新轮思考' }));
    vi.advanceTimersByTime(250);
    expect(entries()[0]?.reasoning.map((s) => s.text)).toEqual(['pause 前思考', '新轮思考']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 节流 flush 与清理（mirror chainStreamBuffer flushTimer 模式）
// ════════════════════════════════════════════════════════════════════════════

describe('节流 flush 与清理', () => {
  it('reasoning delta 不即写 store——250ms flush 落段；空转窗等值跳过（引用稳定）', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '第一帧' }));
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '第二帧' }));
    expect(entries()).toHaveLength(0); // 未到 flush 窗
    vi.advanceTimersByTime(250);
    expect(entries()[0]?.reasoning[0]?.text).toBe('第一帧第二帧');
    // 空转窗：无新 delta → 不产 store 写（时间线 map 引用稳定）。
    const firstRef = useTestStore.getState().chainTimelineBySession['sess-a'];
    vi.advanceTimersByTime(500);
    expect(useTestStore.getState().chainTimelineBySession['sess-a']).toBe(firstRef);
  });

  it('node-done 命中流节点：pending 尾巴 force 落（未到 flush 窗不丢 ≤250ms 尾巴）', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ nodeId: 'brief-reviewer-node', delta: '末窗思考' }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    expect(entries()[0]?.reasoning[0]?.text).toBe('末窗思考');
  });

  it('哨兵终态帧：pending 尾巴 force 落 + 清缓冲（跨 run 不泄漏）', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '终局思考' }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    expect(entries()[0]?.reasoning[0]?.text).toBe('终局思考');
    // 新 run 的 reasoning 不受旧 pending 影响（已清——同 messageId 也从空段另起）。
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ nodeId: 'brief-reviewer-node', delta: '新 run 思考' }));
    vi.advanceTimersByTime(250);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]?.reasoning[0]?.text).toBe('新 run 思考');
  });

  it('finalizeChainTimeline（done/error 兜底）：pending 落 + runEnded 标记', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '中断前思考' }));
    finalizeChainTimeline(useTestStore, 'sess-a');
    expect(entries()[0]?.reasoning[0]?.text).toBe('中断前思考');
    expect(tl()?.runEnded).toBe(true);
  });

  it('finalize paused 早退（mirror finalizeChainRun）：链停 checkpoint 等审阅时 leader done 不标终态——resume 续同链不重置', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: 'pause 前思考' }));
    vi.advanceTimersByTime(250);
    seedRun('sess-a', 'paused'); // peer 面由先行的 finalizeChainRun 写定 paused
    finalizeChainTimeline(useTestStore, 'sess-a');
    expect(tl()?.runEnded).toBeUndefined();
    // resume：peer 翻 running 后续事件照常累积（无重置 wiping；paused 窗口跳过是另一语义）。
    seedRun('sess-a', 'running');
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r2', delta: 'resume 后思考' }));
    vi.advanceTimersByTime(250);
    expect(entries()[0]?.reasoning.map((s) => s.text)).toEqual(['pause 前思考', 'resume 后思考']);
  });

  it('forgetChainTimeline：模块缓冲清——后续 flush 窗不写 store', () => {
    applyTimelineChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '将被遗忘的思考' }));
    forgetChainTimeline('sess-a');
    vi.advanceTimersByTime(500);
    expect(entries()).toHaveLength(0);
  });

  it('最小测试 store 缺省面（chainTimelineBySession undefined）：事件不炸不写', () => {
    const bareStore = create<{ chainRunBySession: Record<string, { status: string }> }>()(() => ({
      chainRunBySession: {},
    }));
    applyTimelineChainDelta(bareStore, 'sess-a', reasoningDelta({ delta: 'x' }));
    applyTimelineArtifact(bareStore, 'sess-a', artifactOf('route-agent', { kind: 'line', line: 'x' }));
    applyTimelineTool(bareStore, 'sess-a', toolOf('draft-writer-agent', 'query_story'));
    applyTimelineNodeDone(bareStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    finalizeChainTimeline(bareStore, 'sess-a');
    expect(Object.keys(bareStore.getState())).toEqual(['chainRunBySession']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dispatcher 接线（agentEvents——chain-node-artifact / chain-tool 新 case +
// chain-delta·chain-node-done 双写 + done 兜底 finalizeChainTimeline）
// ════════════════════════════════════════════════════════════════════════════

describe('dispatcher 接线（handleAgentStreamEvent 集成）', () => {
  it('chain-node-artifact / chain-tool 事件 → timeline 写入（首个消费者接线）+ 项目锚登记', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-tool',
      data: { nodeId: 'draft-writer-agent', toolName: 'query_story', inputSummary: '{"query":"林昭"}', resultCount: 12, status: 'ok' },
    }));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-node-artifact',
      data: { nodeId: 'route-agent', role: 'route-agent', seq: -1, summary: { kind: 'route-decision', decision: 'accept_as_truth', reason: '质量达标' } },
    }));
    expect(entries()).toHaveLength(2);
    expect(entries()[0].tools[0]).toMatchObject({ toolName: 'query_story', resultCount: 12 });
    expect(entries()[1].summary).toEqual({ kind: 'route-decision', decision: 'accept_as_truth', reason: '质量达标' });
    expect(useTestStore.getState().chainRunAnchorByProject?.['/proj-a']).toBe('sess-a');
  });

  it('chain-delta 双写：reasoning 通道喂时间线（text 不喂）；chainRunBySession 正文车道零扰动', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-delta', data: reasoningDelta({ nodeId: 'brief-reviewer-node', delta: '规划思考' }) }));
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-delta', data: textDelta({ delta: '正文' }) }));
    vi.advanceTimersByTime(250);
    const timelineEntry = entries().find((e) => e.nodeId === 'brief-reviewer-node');
    expect(timelineEntry?.reasoning[0]?.text).toBe('规划思考');
    expect(entries().find((e) => e.nodeId === 'draft-writer-agent')).toBeUndefined(); // text 不进时间线
    // 既有链缓冲行为不回归：text 车道照写 streamText，reasoning 走尾窗。
    const run = useTestStore.getState().chainRunBySession['sess-a'];
    expect(run?.streamNodeId).toBe('draft-writer-agent');
    expect(run?.streamText).toBe('正文');
    expect(run?.reasoningPreview).toBe('规划思考');
  });

  it('chain-node-done 双写：attempt 收口 + 哨兵终态 runEnded', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-artifact', data: artifactOf('brief-compiler-node', { kind: 'brief-card', brief: {} }) }));
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: chainNodeDone('brief-compiler-node', 'done') }));
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-node-done', data: chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed') }));
    expect(entries()[0].status).toBe('done');
    expect(tl()?.runEnded).toBe(true);
  });

  it('done 兜底（leader turn 结束、链无哨兵）→ finalizeChainTimeline 接线：runEnded + pending 落', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'chain-delta', data: reasoningDelta({ delta: '兜底前思考' }) }));
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'completed' } }));
    expect(tl()?.runEnded).toBe(true);
    expect(entries()[0]?.reasoning[0]?.text).toBe('兜底前思考');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// escalate findings 路由（design §2.2/F5——metadata.findings → escalateFindingsBySession）
// ════════════════════════════════════════════════════════════════════════════

describe('escalate findings 路由', () => {
  function toolEventWithMetadata(metadata: unknown, sessionId = 'sess-a') {
    return ev({ type: 'tool', data: { id: `t-${Math.random()}`, results: [{ toolName: 'write_chapter', output: '', metadata }] } }, sessionId);
  }

  it('metadata.findings（reader-audit）→ escalateFindingsBySession[sid] 写入（活跃 + 后台会话都写）', () => {
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: {
        source: 'reader-audit',
        route: 'escalate_user',
        chapterId: 'ch-003',
        items: [
          { severity: 'block', quote: '「他知道真相」', location: '第2段', explanation: '信息差违规：读者尚未获知' },
          { severity: 'warn', quote: '「她冷笑」', location: '第5段', explanation: 'OOC 偏离锚点', subClass: '角色一致性', attribution: 'execution_gap' },
        ],
      },
    }));
    // 后台会话（≠ 视图会话）照写——键控，切回再现。
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: { source: 'plan-review', route: 'escalate', items: [{ severity: 'warn', quote: 'q', location: 'l', explanation: 'e' }] },
    }, 'sess-b'));

    const active = useTestStore.getState().escalateFindingsBySession['sess-a'];
    expect(active).toMatchObject({ source: 'reader-audit', route: 'escalate_user', chapterId: 'ch-003' });
    expect(active?.items).toHaveLength(2);
    expect(active?.items[1]).toMatchObject({ subClass: '角色一致性', attribution: 'execution_gap' });
    expect(useTestStore.getState().escalateFindingsBySession['sess-b']).toMatchObject({ source: 'plan-review', route: 'escalate' });
  });

  it('条目级防御投影：info severity / 缺 grounding / 非对象条目单独丢，好条目保留；items 空数组仍写（已审核锚点）', () => {
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: {
        source: 'reader-audit',
        route: 'escalate_user',
        items: [
          { severity: 'info', quote: 'q', location: 'l', explanation: 'e' }, // info 噪声丢
          { severity: 'block', quote: '', location: 'l', explanation: 'e' }, // 缺 quote 丢
          { severity: 'block', quote: 'q', location: 'l' }, // 缺 explanation 丢
          'garbage', // 非对象丢
          null, // 非对象丢
          { severity: 'warn', quote: 'q2', location: 'l2', explanation: 'e2', attribution: 'bogus' }, // 枚举外 attribution 丢（条目保留）
        ],
      },
    }));
    const entry = useTestStore.getState().escalateFindingsBySession['sess-a'];
    expect(entry?.items).toHaveLength(1);
    expect(entry?.items[0]).toEqual({ severity: 'warn', quote: 'q2', location: 'l2', explanation: 'e2' });

    // 空items（已审核锚点语义）。
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: { source: 'reader-audit', route: 'escalate_user', chapterId: 'ch-009', items: [] },
    }));
    expect(useTestStore.getState().escalateFindingsBySession['sess-a']?.items).toEqual([]);
    expect(useTestStore.getState().escalateFindingsBySession['sess-a']?.chapterId).toBe('ch-009');
  });

  it('非法 source / items 非数组 / 无 findings 字段 → 不写（键保持原值）', () => {
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: { source: 'reader-audit', route: 'r', items: [{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }] },
    }));
    const before = useTestStore.getState().escalateFindingsBySession['sess-a'];
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({ findings: { source: 'bogus', route: 'r', items: [] } }));
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({ findings: { source: 'reader-audit', route: 'r', items: 'not-array' } }));
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({ type: 'field_patch', field: 'outline', data: {} }));
    expect(useTestStore.getState().escalateFindingsBySession['sess-a']).toBe(before);
  });

  it('redo 后重发 findings → replace 语义（最新帧胜）', () => {
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: { source: 'reader-audit', route: 'escalate_user', items: [{ severity: 'block', quote: '旧', location: 'l', explanation: 'e' }] },
    }));
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: { source: 'reader-audit', route: 'auto_revise', items: [{ severity: 'warn', quote: '新', location: 'l', explanation: 'e' }] },
    }));
    const entry = useTestStore.getState().escalateFindingsBySession['sess-a'];
    expect(entry?.route).toBe('auto_revise');
    expect(entry?.items[0]?.quote).toBe('新');
  });

  it('projectEscalateFindingItems：非数组输入 → 空数组（resume fallback 路径防御）', () => {
    expect(projectEscalateFindingItems(undefined)).toEqual([]);
    expect(projectEscalateFindingItems('x')).toEqual([]);
    expect(projectEscalateFindingItems([{}])).toEqual([]);
  });

  it('CR-3①：新 run 首条链事件重置时间线时同点清 escalateFindingsBySession[sid]（跨 run 裁决卡残留失效）', () => {
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: { source: 'reader-audit', route: 'escalate_user', items: [{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }] },
    }));
    // run 1：有时间线条目 + 终态（runEnded 标记只在既有时间线上写）。
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('route-agent', { kind: 'line', line: 'run1 判决' }));
    applyTimelineNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'aborted'));
    expect(useTestStore.getState().escalateFindingsBySession['sess-a']).toBeDefined();
    expect(tl()?.runEnded).toBe(true);

    // 下一 run 首条链事件：时间线重置 + escalate 键同点失效（跨 run 残留的裁决卡不再渲染）。
    applyTimelineArtifact(useTestStore, 'sess-a', artifactOf('brief-compiler-node', { kind: 'brief-card', brief: {} }));
    expect(useTestStore.getState().escalateFindingsBySession['sess-a']).toBeUndefined();
    expect(tl()?.runEnded).toBeUndefined();
    expect(entries()).toHaveLength(1);
  });

  it('CR-3①：run 未到终态（无 runEnded）期间链事件不清 escalate 键（未消费不清）', () => {
    handleAgentStreamEvent(useTestStore, toolEventWithMetadata({
      findings: { source: 'reader-audit', route: 'escalate_user', items: [] },
    }));
    // 同 run 内继续有链事件（无哨兵终态）——键保持（裁决卡仍有效）。
    applyTimelineTool(useTestStore, 'sess-a', toolOf('draft-writer-agent', 'query_story'));
    expect(useTestStore.getState().escalateFindingsBySession['sess-a']).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// nodeCatalog 对拍 gate（design §2.3——键集 === CHAIN_NODE_ORDER 守门）
// ════════════════════════════════════════════════════════════════════════════

describe('nodeCatalog 对拍 gate', () => {
  it('键集 === CHAIN_NODE_ORDER（agent 侧改链序 / 本表漏节点即红）', () => {
    expect(Object.keys(CHAIN_NODE_CATALOG).sort()).toEqual([...CHAIN_NODE_ORDER].sort());
    expect(Object.keys(CHAIN_NODE_CATALOG)).toHaveLength(23);
  });

  it('档位分布：writer 唯一（draft-writer）/ quick 纯代码 8 位 / analysis 14 位（design §3 归档表）', () => {
    const tiers = Object.values(CHAIN_NODE_CATALOG).map((e) => e.tier);
    expect(tiers.filter((t) => t === 'writer')).toEqual(['writer']);
    expect(tiers.filter((t) => t === 'quick')).toHaveLength(8);
    expect(tiers.filter((t) => t === 'analysis')).toHaveLength(14);
    expect(CHAIN_NODE_CATALOG['brief-compiler-node']?.tier).toBe('quick'); // 纯代码编译器
    expect(CHAIN_NODE_CATALOG['draft-writer-agent']?.tier).toBe('writer');
  });

  it('段分布：plan 2 / loop 7 / extract 14；i18nKey 形态 chain.node.<id>', () => {
    const segs = Object.values(CHAIN_NODE_CATALOG).map((e) => e.segment);
    expect(segs.filter((s) => s === 'plan')).toHaveLength(2);
    expect(segs.filter((s) => s === 'loop')).toHaveLength(7);
    expect(segs.filter((s) => s === 'extract')).toHaveLength(14);
    for (const [id, entry] of Object.entries(CHAIN_NODE_CATALOG)) {
      expect(entry.i18nKey).toBe(`chain.node.${id}`);
      expect(entry.icon.length).toBeGreaterThan(0);
    }
    expect(CHAIN_NODE_SEGMENTS.map((s) => s.id)).toEqual(['plan', 'loop', 'extract']);
    expect(new Set(CHAIN_NODE_SEGMENTS.map((s) => s.i18nKey)).size).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CR-19：全局 reasoning 预算分层保留（终态链 timeline 每章永久滞留——第一层从旧终态链起
// 只清 reasoning 文本；清完仍超限丢最旧终态链整条；活跃链与当前观察链永不降级）
// ════════════════════════════════════════════════════════════════════════════

describe('CR-19 全局 reasoning 预算分层保留', () => {
  /** 直 seed 时间线态（绕过 apply 路径——量控按预置态触发，构造不受 per-session cap 干预）。 */
  function seedTimeline(sid: string, opts: { updatedAt: number; runEnded?: boolean; reasoningChars: number }) {
    useTestStore.setState((s) => ({
      chainTimelineBySession: {
        ...s.chainTimelineBySession,
        [sid]: {
          sessionId: sid,
          entries: [{
            nodeId: 'brief-compiler-node',
            seq: 0,
            status: 'done' as const,
            tools: [{ nodeId: 'brief-compiler-node', toolName: 'query_story', inputSummary: '{"q":1}', status: 'ok' as const }],
            summary: { kind: 'line', line: `${sid} 产出` } as ChainNodeArtifactSummary,
            reasoning: opts.reasoningChars > 0 ? [{ messageId: 'r1', text: 'x'.repeat(opts.reasoningChars) }] : [],
            at: opts.updatedAt,
          }],
          ...(opts.runEnded ? { runEnded: true } : {}),
          updatedAt: opts.updatedAt,
        },
      },
    }));
  }

  const reasoningTotal = (sid: string): number => {
    const t = useTestStore.getState().chainTimelineBySession[sid];
    return (t?.entries ?? []).reduce((n, e) => n + e.reasoning.reduce((m, seg) => m + seg.text.length, 0), 0);
  };

  it('超限 → 按终态时间旧→新逐链只清 reasoning 文本（entries/tools/summary 保留），清到限内即止；观察链不降级', () => {
    seedTimeline('old-1', { updatedAt: 1000, runEnded: true, reasoningChars: 1_200_000 });
    seedTimeline('old-2', { updatedAt: 2000, runEnded: true, reasoningChars: 900_000 });
    seedTimeline('obs', { updatedAt: 3000, runEnded: true, reasoningChars: 100_000 });
    useTestStore.setState({ selectedChainSessionId: 'obs' }); // 观察链保护面
    // 总量 2.2M chars > 2M cap——经任意 timeline 写入点触发（此处 tool 直写）。
    applyTimelineTool(useTestStore, 'live', toolOf('draft-writer-agent', 'query_story'));

    // 第一层只清最旧一条即回限内（2.2M − 1.2M = 1.0M ≤ 2M）——old-2 / obs 的 reasoning 不动。
    expect(reasoningTotal('old-1')).toBe(0);
    expect(reasoningTotal('old-2')).toBe(900_000);
    expect(reasoningTotal('obs')).toBe(100_000); // 观察链不降级
    // 结构保留：entries / tools / 产出 summary 原样（回看降级非丢失）。
    const stripped = useTestStore.getState().chainTimelineBySession['old-1'];
    expect(stripped?.entries).toHaveLength(1);
    expect(stripped?.entries[0]?.tools).toHaveLength(1);
    expect(stripped?.entries[0]?.summary).toEqual({ kind: 'line', line: 'old-1 产出' });
  });

  it('清完仍超限 → 丢最旧终态链整条 timeline；活跃链永不降级', () => {
    seedTimeline('a1', { updatedAt: 100, reasoningChars: 700_000 }); // 活跃（无 runEnded）
    seedTimeline('a2', { updatedAt: 200, reasoningChars: 700_000 });
    seedTimeline('a3', { updatedAt: 300, reasoningChars: 700_000 });
    seedTimeline('t-old', { updatedAt: 50, runEnded: true, reasoningChars: 300_000 });
    // 活跃合计 2.1M > 2M——第一层清光候选后仍超限 → 第二层丢最旧终态链整条。
    applyTimelineTool(useTestStore, 'trigger', toolOf('draft-writer-agent', 'query_story'));

    expect(useTestStore.getState().chainTimelineBySession['t-old']).toBeUndefined(); // 整条丢
    expect(reasoningTotal('a1')).toBe(700_000); // 活跃链不动（保护面）
    expect(reasoningTotal('a2')).toBe(700_000);
    expect(reasoningTotal('a3')).toBe(700_000);
  });

  it('预算内 → 零降级（reasoning / 结构全保留）', () => {
    seedTimeline('small', { updatedAt: 1000, runEnded: true, reasoningChars: 1000 });
    // 触发点用另一会话（同会话写链事件 = 新 run 重置语义，非量控触发）。
    applyTimelineTool(useTestStore, 'trigger', toolOf('draft-writer-agent', 'query_story'));
    expect(useTestStore.getState().chainTimelineBySession['small']?.runEnded).toBe(true);
    expect(reasoningTotal('small')).toBe(1000);
    expect(useTestStore.getState().chainTimelineBySession['small']?.entries[0]?.tools).toHaveLength(1);
  });
});
