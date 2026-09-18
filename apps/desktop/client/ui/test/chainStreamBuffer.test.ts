/**
 * dogfood T1 Stage 6（design §4/§6.2）：链运行态缓冲与状态机。
 *
 * 覆盖（implement.md Stage 6 测试清单）：
 * - (nodeId, seq) 拼接不混旧流：同流拼接 / 新 seq 重开段 / 同流换 messageId 轮另起。
 * - flush 节流（fake-timer）：delta 不即写 store，250ms flush；>20K 自适应 500ms。
 * - chain-node-done 状态机：节点步进 / error·blocked 标注 / 哨兵终态映射（completed /
 *   paused / aborted / error / blocked→error；legacy auto_revise_pending→completed——CR-22 白名单）。
 * - 终态后再收事件 = 新 run 重置；finalizeChainRun 兜底（done→aborted / error；paused 保持）。
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

import { handleAgentStreamEvent, type AgentStreamWireEvent } from '../src/shared/store/agentEvents';
import {
  __clearChainStreamState,
  applyChainDelta,
  applyChainNodeDone,
  finalizeChainRun,
  CHAIN_RUN_SENTINEL_NODE_ID,
  CHAIN_NODE_ORDER,
  type ChainBufferState,
  type ChainRunState,
} from '../src/shared/store/chainStreamBuffer';

// ════════════════════════════════════════════════════════════════════════════
// 链序镜像对照（链流程重排 W1d）：CHAIN_NODE_ORDER 是 agent 包 CHAPTER_CHAIN_NODE_IDS
// （chapter-chain.ts 链装配权威序）的本地镜像——UI 包不依赖 agent 包，跨包一致性靠此字面快照
// 钉死（agent 侧改链序 → 此测试红 → 强制同步镜像）。
// ════════════════════════════════════════════════════════════════════════════

describe('CHAIN_NODE_ORDER 镜像对照（agent 包 CHAPTER_CHAIN_NODE_IDS 权威序）', () => {
  it('链序字面快照（W1d 新链：规划环 → 自审环 7 节点（含写手）→ 提取段 E1-E10）', () => {
    expect(CHAIN_NODE_ORDER).toEqual([
      // ── A 规划环 ──
      'brief-compiler-node',
      'brief-reviewer-node',
      // ── 自审环（环体 7 节点，写手单位置在 optimizer 紧后）──
      'revision-optimizer-node',
      'draft-writer-agent',
      'revision-guard-agent',
      'lint-node',
      'multi-review-agent',
      'completeness-verify-node',
      'route-agent',
      // ── E 提取段（对最终稿一次）──
      'world-extractor-physical',
      'world-extractor-cognitive',
      'world-extractor-emotional',
      'world-extractor-relational',
      'world-extractor-factional',
      'world-merge-node',
      'emotion-verify-node',
      'promise-emergence-node',
      'arc-emergence-node',
      'chapter-summary-node',
      'storytime-drift-node',
      'mention-ledger-node',
      'story-sync-agent',
      'feedback-ledger-node',
    ]);
    // 结构不变式：targeted-revision 已退役；无重复 id；23 节点。
    expect(CHAIN_NODE_ORDER).not.toContain('targeted-revision-agent');
    expect(new Set(CHAIN_NODE_ORDER).size).toBe(CHAIN_NODE_ORDER.length);
    expect(CHAIN_NODE_ORDER).toHaveLength(23);
  });
});

type TestState = ChainBufferState & {
  agentSessionId: string | null;
  agentMessages: never[];
  activeSessionRunning: boolean;
  agentError: string | null;
  currentProject: { path?: string } | null;
  agentRunStates: Record<string, { sessionId: string; phase: string; updatedAt: number }>;
  setAgentRunState: (sessionId: string, patch: { phase?: string; projectPath?: string; activity?: string }) => void;
  setPendingToolConfirm: () => void;
  pushPendingDiff: () => void;
  setPausedReview: () => void;
  setPendingPatch: () => void;
  fieldMetadata: Record<string, unknown>;
  /** dogfood R2 #105 假中断守卫：resume 在途判据（chapterReviewSlice 面——dispatcher 结构读）。
   * 09-13 子3 W4：reviewResuming 单槽 → BySession 键控（done-probe 同批改读）。 */
  reviewResumingBySession: Record<string, boolean>;
  pausedReviewBySession: Record<string, unknown>;
};

const useTestStore = create<TestState>()((set) => ({
  agentSessionId: 'sess-a',
  agentMessages: [],
  activeSessionRunning: false,
  agentError: null,
  currentProject: { path: '/proj-a' },
  agentRunStates: {},
  chainRunBySession: {},
  setAgentRunState: (sessionId, patch) => set((s) => ({
    agentRunStates: {
      ...s.agentRunStates,
      [sessionId]: { sessionId, phase: patch.phase ?? 'idle', updatedAt: Date.now() },
    },
  })),
  setPendingToolConfirm: () => {},
  pushPendingDiff: () => {},
  setPausedReview: () => {},
  setPendingPatch: () => {},
  fieldMetadata: {},
  reviewResumingBySession: {},
  pausedReviewBySession: {},
}));

function run(sid = 'sess-a'): ChainRunState | undefined {
  return useTestStore.getState().chainRunBySession[sid];
}

function chainDelta(over: Partial<{ nodeId: string; messageId: string; delta: string; seq: number }> = {}) {
  return {
    nodeId: over.nodeId ?? 'draft-writer-agent',
    role: 'draft-writer-agent',
    phase: 'writing',
    messageId: over.messageId ?? 'm1',
    delta: over.delta ?? '',
    seq: over.seq ?? 0,
  };
}

/** 09-13 子2 W1（R5）：reasoning 通道 delta（缺省 brief-reviewer 形态——独立缓冲键面）。 */
function reasoningDelta(over: Partial<{ nodeId: string; messageId: string; delta: string; seq: number }> = {}) {
  return {
    nodeId: over.nodeId ?? 'brief-reviewer-node',
    role: 'brief-reviewer-agent',
    messageId: over.messageId ?? 'rm1',
    delta: over.delta ?? '',
    seq: over.seq ?? 0,
    channel: 'reasoning' as const,
  };
}

function chainNodeDone(nodeId: string, status: string) {
  return { nodeId, status };
}

beforeEach(() => {
  vi.useFakeTimers();
  __clearChainStreamState();
  useTestStore.setState({
    agentSessionId: 'sess-a',
    activeSessionRunning: false,
    agentError: null,
    agentRunStates: {},
    chainRunBySession: {},
    reviewResumingBySession: {},
    pausedReviewBySession: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  __clearChainStreamState();
});

describe('applyChainDelta — (nodeId, seq) 拼接', () => {
  it('同流 delta 拼接 + 250ms flush 节流（不即写 store）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '黄昏' }));
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '的荒野' }));
    // 建档即时（status running + streaming），正文等 flush。
    expect(run()?.status).toBe('running');
    expect(run()?.streaming).toBe(true);
    expect(run()?.streamText).toBe('');
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('黄昏的荒野');
    // 再无新 delta → 下一 flush 窗不写（内容不变）。
    vi.advanceTimersByTime(500);
    expect(run()?.streamText).toBe('黄昏的荒野');
  });

  it('新 seq（redo 重跑）重开段：旧流不混入；同流换 messageId 轮另起', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm1', delta: '旧流文本', seq: 0 }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('旧流文本');
    // redo：同 nodeId 新 seq —— 新段，旧流整体替换。
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm2', delta: '新流', seq: 1 }));
    expect(run()?.streamText).toBe(''); // 新段开段即重置（meta 先行）
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm2', delta: '开头', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('新流开头');
    // 同流内换轮（阶段二查询轮后另起写作轮）——文本另起不拼接。
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm3', delta: '第二轮', seq: 1 }));
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm3', delta: '正文', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('第二轮正文');
  });

  it('>20K 字符自适应：flush 间隔拉长到 500ms（250ms 不写，500ms 写）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '长'.repeat(21000) }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe(''); // 基准窗不 flush
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('长'.repeat(21000));
  });
});

describe('applyChainNodeDone — 状态机', () => {
  it('普通节点步进：completedNodes 累积 + 当前锚点推进 + error/blocked 标注', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('draft-writer-agent', 'done'));
    expect(run()?.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
    expect(run()?.currentNodeId).toBe('draft-writer-agent');
    expect(run()?.errorNodeId).toBeNull();

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('multi-review-agent', 'error'));
    expect(run()?.errorNodeId).toBe('multi-review-agent');
    // run 级仍 running（终态等哨兵帧）。
    expect(run()?.status).toBe('running');
  });

  it('哨兵终态映射：completed / paused / aborted / error / blocked→error + legacy auto_revise_pending→completed（CR-22 白名单——防升级后旧帧/回放把健康复跑卡标 error）', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    expect(run()?.status).toBe('completed');
    expect(run()?.streaming).toBe(false);

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    expect(run()?.status).toBe('paused');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'aborted'));
    expect(run()?.status).toBe('aborted');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'error'));
    expect(run()?.status).toBe('error');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'blocked'));
    expect(run()?.status).toBe('error');

    // CR-22：legacy 值（W1a 前的哨兵终态——dev 热重载/持久化时间线回放路径会重放旧帧）按
    // 退役前语义映射 completed（健康复跑卡不被错标失败）。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'auto_revise_pending'));
    expect(run()?.status).toBe('completed');
  });

  it('终态后再收普通节点事件 = 新 run：completedNodes 重置从头累积', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    expect(run()?.completedNodes).toEqual(['brief-compiler-node']);
    // 下一章 / redo：新 run。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    expect(run()?.status).toBe('running');
    expect(run()?.completedNodes).toEqual(['brief-compiler-node']);
    expect(run()?.errorNodeId).toBeNull();
  });

  it('paused 后 resume/redo 事件到达 → 回 running（精简态只属等审阅窗口；redo 重跑正文照流）', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    expect(run()?.status).toBe('paused');
    // resume 续跑的下一节点事件 → 回 running。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('revision-guard-agent', 'done'));
    expect(run()?.status).toBe('running');
    // 再 paused 后 redo delta 到达（draft-writer 重跑新流）→ 同样回 running + 开新段。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm-redo', delta: '改稿正文', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.status).toBe('running');
    expect(run()?.streamText).toBe('改稿正文');
  });
});

describe('finalizeChainRun — done/error 兜底', () => {
  it('链仍 running 时 done 兜底 → aborted（中断标数据源）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '已流出部分' }));
    vi.advanceTimersByTime(250);
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.status).toBe('aborted');
    // 已流出文本保留（中断态呈现）。
    expect(run()?.streamText).toBe('已流出部分');
    expect(run()?.streaming).toBe(false);
  });

  it('哨兵已定终态 / paused → 兜底不改写', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.status).toBe('completed');

    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.status).toBe('paused');
  });
});

describe('handleAgentStreamEvent — chain 事件分发（dispatcher 集成）', () => {
  function ev(event: AgentStreamEvent, sessionId = 'sess-a'): AgentStreamWireEvent {
    return { ...event, sessionId, projectPath: '/proj-a' };
  }

  it('chain-delta / chain-node-done 事件驱动链态 + done 兜底中断', () => {
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: chainDelta({ delta: '正文' }),
    }));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-node-done',
      data: chainNodeDone('brief-compiler-node', 'done'),
    }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('正文');
    expect(run()?.completedNodes).toEqual(['brief-compiler-node']);
    // run 态徽标同款驱动（S3 既有行为不回归）。
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('running');

    // leader run 结束而链无终态帧 → 兜底中断。
    handleAgentStreamEvent(useTestStore, ev({ type: 'done', data: { status: 'aborted' } }));
    expect(run()?.status).toBe('aborted');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood R2 #105 假中断根治（2026-08-30）：resume 链跑在 leader turn 生命周期外——done 兜底
// 前置守卫（reviewResuming + 该会话 pausedReview = 在途 resume IPC）命中时不 finalize 不删缓冲。
// ════════════════════════════════════════════════════════════════════════════
describe('dogfood R2 #105 假中断根治（done 兜底守卫——缓冲不删）', () => {
  it('resume 在途 → leader turn done 不误标 aborted 不删缓冲：后续 flush 窗照写 streamText', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文' }));
    // resume IPC 在途（ChapterReviewPanel 三动作已发出、长跑 IPC 未返回）。
    useTestStore.setState({
      reviewResumingBySession: { 'sess-a': true },
      pausedReviewBySession: { 'sess-a': { type: 'chapter_review', stage: 'draft' } },
    });

    // leader turn 结束（resume 跑在 turn 外——done 不构成链被掐证据）。
    handleAgentStreamEvent(useTestStore, { type: 'done', data: { status: 'completed' }, sessionId: 'sess-a', projectPath: '/proj-a' });

    // 链不被误终态化（finalize 会标 aborted + force flush + 删缓冲——三者都没发生）。
    expect(run()?.status).toBe('running');
    // 缓冲未删：flush 窗到 → streamText 照写（增量续流能力保留）。
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('正文');
    expect(run()?.streaming).toBe(true);
  });

  it('resume 不在途 → done 兜底照旧（force flush + 删缓冲 + 标 aborted——既有语义不回归）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文' }));

    handleAgentStreamEvent(useTestStore, { type: 'done', data: { status: 'completed' }, sessionId: 'sess-a', projectPath: '/proj-a' });

    expect(run()?.status).toBe('aborted');
    expect(run()?.streamText).toBe('正文'); // force flush 兜住尾巴
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood T1 CR 批4/批5：finalize 同步 run 态（CR-T1-049）/ node-done 收口 streaming
// （CR-T1-050）/ 终帧先 flush + per-session 降频（CR-T1-051）
// ════════════════════════════════════════════════════════════════════════════

describe('CR-T1-049 finalizeChainRun 同步 run 态（dogfood stub 幽灵 running 徽标）', () => {
  it('finalize aborted → run 态归 idle；error → 归 error（终态漏斗不再只动链态）', () => {
    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running', projectPath: '/proj-a' });
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文' }));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');

    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running' });
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: 'x', seq: 1 }));
    finalizeChainRun(useTestStore, 'sess-a', 'error');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('error');
  });

  it('paused 早退（链态保持）时 run 态同样归位——paused 的 run 本身已结束', () => {
    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running', projectPath: '/proj-a' });
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    useTestStore.getState().setAgentRunState('sess-a', { phase: 'running' });
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(useTestStore.getState().agentRunStates['sess-a']?.phase).toBe('idle');
    expect(run()?.status).toBe('paused'); // 链态不被兜底改写（审阅面板在等）
  });
});

describe('CR-T1-050 普通 node-done 命中流节点 → streaming 收口', () => {
  it('draft-writer done → streaming:false（auto 档链尾 JSON 节点期不再假「正在写作」+ caret 残留）；streamText 保留', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '已流出的正文' }));
    expect(run()?.streaming).toBe(true);
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('draft-writer-agent', 'done'));
    expect(run()?.streaming).toBe(false);
    // 正文保留（终态/中断呈现「已流出部分」）——flush 照写（streaming 只控 caret/占位判定）。
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('已流出的正文');
  });

  it('非流节点的 node-done 不动 streaming（他节点步进不打断在途流）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '流中' }));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-compiler-node', 'done'));
    expect(run()?.streaming).toBe(true);
  });
});

describe('CR-T1-051 终帧先 flush 后删 + per-session 降频', () => {
  it('哨兵终态帧到达时同步 force flush——中断尾巴不丢（旧实现只兑现到上个 flush 点）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '已流出部分' }));
    // 未到任何 flush 窗（0ms）——哨兵终帧先 force flush 再删缓冲。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'aborted'));
    expect(run()?.status).toBe('aborted');
    expect(run()?.streamText).toBe('已流出部分');
  });

  it('finalizeChainRun（done/error 兜底）同款 force flush', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '尾巴' }));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.streamText).toBe('尾巴');
  });

  it('per-session 降频：A 会话 >20K 长文不再拖慢 B 会话的 250ms flush（块5 附注跨会话耦合）', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '长'.repeat(21000) }));
    applyChainDelta(useTestStore, 'sess-b', chainDelta({ delta: '短文本' }));

    vi.advanceTimersByTime(250);
    // B 会话基准窗照 flush（旧全局 nextFlushDelayMs 会因 A >20K 把 B 也拖到 500ms）。
    expect(useTestStore.getState().chainRunBySession['sess-b']?.streamText).toBe('短文本');
    expect(useTestStore.getState().chainRunBySession['sess-a']?.streamText).toBe('');

    // A 会话降频窗（500ms）到——写。
    vi.advanceTimersByTime(250);
    expect(useTestStore.getState().chainRunBySession['sess-a']?.streamText).toBe('长'.repeat(21000));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 09-13 子2 W1（R5 / plan-review H1 定案）：channel 守卫 + reasoning 独立缓冲键。
// - text 车道行为零变化（channel 缺省 = text）；reasoning 不进正文 entry 生命周期。
// - AC5 守卫：streamText 不含 reasoning 增量（正文流不被思考文本污染）。
// - H1(c) 消解：abort 于 E 段时后续节点 reasoning 不清空正文预览。
// - M3 重置语义：同流换 messageId 轮重置；新流（nodeId#seq）重开段。尾窗 20K 保尾弃头。
// ════════════════════════════════════════════════════════════════════════════

describe('applyChainDelta — channel 分流（09-13 子2 W1）', () => {
  it('reasoning 不污染正文车道：streamText/streaming/streamNodeId 零触碰（AC5 守卫）；flush 写独立 reasoningPreview', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文段' }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('正文段');

    // 后续节点 reasoning 到达（不同 nodeId）——正文车道零触碰。
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ nodeId: 'brief-reviewer-node', delta: '规划思考' }));
    expect(run()?.streamText).toBe('正文段'); // AC5：正文流不混入思考增量
    expect(run()?.streamNodeId).toBe('draft-writer-agent'); // 正文锚点不动（不重建 entry）
    expect(run()?.streaming).toBe(true); // streaming 不翻

    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('正文段');
    expect(run()?.streamText).not.toContain('规划思考');
    expect(run()?.reasoningPreview).toBe('规划思考'); // 独立尾窗字段（ChainRunCard 零消费）
  });

  it('reasoning-only 到达不建卡（正文 entry 生命周期零触发——不建 run 态不抢跑空卡）', () => {
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '规划思考' }));
    expect(run()).toBeUndefined();
    vi.advanceTimersByTime(250);
    // flush 也不建卡（mirror applyChainModelFallback 不建卡形态）。
    expect(run()).toBeUndefined();
  });

  it('abort-于-E-段中断预览回归（H1(c) 消解）：draft 全文 flush 后 E 节点 reasoning 到达 → 哨兵 aborted 后 streamText 仍持 draft 全文', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ messageId: 'm-draft', delta: 'draft 全文' }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('draft 全文');

    // E 段节点 reasoning 到达——若误进正文 entry 生命周期，会重建 entry 清空 streamText。
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ nodeId: 'world-extractor-physical', delta: '提取思考', seq: 0 }));
    vi.advanceTimersByTime(250);
    expect(run()?.streamText).toBe('draft 全文');

    // abort 终态——中断正文预览可见（ChainRunCard interrupted 分支要求 streamText 非空）。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'aborted'));
    expect(run()?.status).toBe('aborted');
    expect(run()?.streamText).toBe('draft 全文');
  });

  it('同流换轮重置（M3）+ 新流（nodeId#seq）重开段', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', delta: '第一轮思考' }));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', delta: '（续）' }));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r2', delta: '第二轮' })); // 换轮 → 重置
    vi.advanceTimersByTime(250);
    expect(run()?.reasoningPreview).toBe('第二轮');

    // 新流（同 nodeId 新 seq——redo 重跑）——重开段。
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r3', delta: '新流', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.reasoningPreview).toBe('新流');
  });

  it('尾窗 cap 20K 保尾弃头（design §6 量控）', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', delta: 'A'.repeat(25000) }));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ messageId: 'r1', delta: 'B' }));
    vi.advanceTimersByTime(250);
    const preview = run()?.reasoningPreview ?? '';
    expect(preview.length).toBe(20000);
    expect(preview.endsWith('B')).toBe(true); // 保尾
    expect(preview.startsWith('A')).toBe(true); // 弃头（截到 19999 个 A + B）
  });

  it('哨兵终态：reasoning 尾窗最后 flush + 缓冲清理（跨 run 不泄漏）', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '末窗思考' }));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'completed'));
    expect(run()?.reasoningPreview).toBe('末窗思考'); // 终帧 force flush 落尾（mirror 正文 CR-T1-051）

    // 同 session 新 run 的 reasoning——不受旧缓冲影响（已清）。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '新 run 思考', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.reasoningPreview).toBe('新 run 思考');
  });

  it('finalizeChainRun 兜底同点清 reasoning 缓冲', () => {
    applyChainDelta(useTestStore, 'sess-a', chainDelta({ delta: '正文' }));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '思考' }));
    finalizeChainRun(useTestStore, 'sess-a', 'aborted');
    expect(run()?.status).toBe('aborted');
    expect(run()?.reasoningPreview).toBe('思考'); // force flush 落尾
    // 兜底后新 run reasoning 从头累积（旧缓冲已清）。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '新窗', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.reasoningPreview).toBe('新窗');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CR-21（W-CR 批）：run paused 后 reasoning 增量跳过缓冲——审阅等待窗内「当前思考」尾窗
  // 不再被在途尾帧突变（与 text 车道 paused 语义对齐）；resume（node-done/text delta 翻回
  // running）后 reasoning 照常入缓冲。
  // ══════════════════════════════════════════════════════════════════════════

  it('CR-21：paused 后 reasoning delta 跳过缓冲——reasoningPreview 停在 pause 时的尾窗（flush 窗后不变）', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '审读思考前半' }));
    vi.advanceTimersByTime(250);
    expect(run()?.reasoningPreview).toBe('审读思考前半');

    // run paused（checkpoint 等审阅）——此后到达的 reasoning 在途尾帧。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    expect(run()?.status).toBe('paused');
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '审读思考后半' }));
    vi.advanceTimersByTime(500);
    // 尾窗不突变（旧实现：缓冲续写 → flush 继续写 reasoningPreview = 审阅等待期假滚动）。
    expect(run()?.reasoningPreview).toBe('审读思考前半');
  });

  it('CR-21：resume 后（node-done 翻回 running）reasoning 增量照常入缓冲——redo 重跑思考可见', () => {
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('brief-reviewer-node', 'done'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: '旧思考' }));
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone(CHAIN_RUN_SENTINEL_NODE_ID, 'paused'));
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ delta: 'paused 尾帧（丢弃）' }));

    // resume：普通节点事件到达 → status 回 running → 后续 reasoning 正常缓冲。
    applyChainNodeDone(useTestStore, 'sess-a', chainNodeDone('revision-optimizer-node', 'done'));
    expect(run()?.status).toBe('running');
    applyChainDelta(useTestStore, 'sess-a', reasoningDelta({ nodeId: 'revision-optimizer-node', delta: '编译思考', seq: 1 }));
    vi.advanceTimersByTime(250);
    expect(run()?.reasoningPreview).toBe('编译思考');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 09-13 子2 W4：chain-tool 事件 + 哨兵 pauseKind——dispatcher 接线后的 additive 底线 + 字段
// 透传容错。W2 起两变体已有 case（时间线写入面 chainTimeline）；本最小测试 store 缺省
// chainTimelineBySession → 时间线守卫不写——此处钉死「事件不炸不建链卡不翻 run 态」底线。
// ════════════════════════════════════════════════════════════════════════════

describe('09-13 子2 W4 — chain-tool / chain-node-artifact dispatcher 接线 + pauseKind 透传容错', () => {
  function ev4(event: AgentStreamEvent, sessionId = 'sess-a'): AgentStreamWireEvent {
    return { ...event, sessionId, projectPath: '/proj-a' };
  }

  it('chain-tool / chain-node-artifact 事件 dispatch → 不炸不建链卡不翻 run 态（时间线面缺省不写——最小测试 store additive 底线）', () => {
    handleAgentStreamEvent(useTestStore, ev4({
      type: 'chain-tool',
      data: { nodeId: 'draft-writer-agent', toolName: 'query_story', inputSummary: '{"query":"林昭"}', resultCount: 12, status: 'ok' },
    }));
    handleAgentStreamEvent(useTestStore, ev4({
      type: 'chain-node-artifact',
      data: { nodeId: 'route-agent', role: 'route-agent', seq: -1, summary: { kind: 'line', line: 'x' } },
    }));
    // 零状态副作用：不建卡（chainRunBySession 无条目）、不翻 run 态。
    expect(run()).toBeUndefined();
    expect(useTestStore.getState().agentRunStates['sess-a']).toBeUndefined();
  });

  it('哨兵 paused 帧携带 pauseKind（additive 字段）→ 状态机照常 paused（字段透传容错，渲染归子3）', () => {
    handleAgentStreamEvent(useTestStore, ev4({
      type: 'chain-node-done',
      data: { nodeId: CHAIN_RUN_SENTINEL_NODE_ID, status: 'paused', pauseKind: 'final' },
    }));
    expect(run()?.status).toBe('paused');
    // escalate 形态同款（五暂停面枚举皆可透传）。
    handleAgentStreamEvent(useTestStore, ev4({
      type: 'chain-node-done',
      data: { nodeId: CHAIN_RUN_SENTINEL_NODE_ID, status: 'paused', pauseKind: 'escalate' },
    }));
    expect(run()?.status).toBe('paused');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 09-13 子2 CR 批（CR-6）：UI 镜像漂移守卫——镜像 fixture 样本覆盖。
//
// 机制：src/shared/store/chainObservabilityMirror.samples.ts（本包镜像类型注解锚，ui tsconfig
// 含 src/** 即编译 gate）是 agent 侧 fixture（agent 类型注解锚）的逐字节副本；deep-equal 对拍
// 测试在 agent 侧 test/chain-observability-mirror.test.ts（agent vitest 跨包加载本包副本——
// UI 包不依赖 agent 包，跨包类型直连会拖 agent 类型图进 ui tsc）。此处运行时钉样本覆盖面
//（五 kind + 全五 pauseKind + tool ±resultCount——fixture 空转守卫）。
// ════════════════════════════════════════════════════════════════════════════

import {
  ARTIFACT_DATA_SAMPLES,
  ARTIFACT_SUMMARY_SAMPLES,
  PAUSE_KIND_SAMPLES,
  TOOL_EVENT_SAMPLES,
} from '../src/shared/store/chainObservabilityMirror.samples';

describe('09-13 子2 CR 批（CR-6）— 镜像 fixture 样本覆盖（编译锚在 src，对拍在 agent 侧）', () => {
  it('五 kind + artifact data 两档 seq + tool ±resultCount + 全五 pauseKind（fixture 空转守卫）', () => {
    expect(new Set(ARTIFACT_SUMMARY_SAMPLES.map((s) => s.kind))).toEqual(
      new Set(['brief-card', 'items', 'findings', 'route-decision', 'line']),
    );
    expect(ARTIFACT_DATA_SAMPLES.map((d) => d.seq)).toEqual([-1, 2]);
    expect(TOOL_EVENT_SAMPLES.filter((t) => t.resultCount !== undefined)).toHaveLength(1);
    expect(TOOL_EVENT_SAMPLES.filter((t) => t.resultCount === undefined)).toHaveLength(1);
    expect(new Set(PAUSE_KIND_SAMPLES)).toEqual(
      new Set(['final', 'escalate', 'brief', 'draft', 'revision-guard']),
    );
  });
});
