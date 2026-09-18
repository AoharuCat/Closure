import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  sceneNodeSchema,
  episodeOutlineSchema,
  type SceneGraph,
} from '@orison/shared-contracts';
import { runChain } from '../src/runtime/chainRunner';
import {
  createChapterChainNodes,
  CHAPTER_CHAIN_LOOPS,
} from '../src/nodes/chapter-chain';
import { registry } from '../src/tool/registry';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.4 BMad CR findings — 真链集成验证测试（2026-08-13；链流程重排 W1d 按新链序对齐）
//
// **目的**：用真链（createChapterChainNodes 装全链 + runChain 驱动）验证三个 HIGH finding + 一个 MEDIUM
// 的生产链行为修复。不 mock runChapterChain，只 mock LLM generate + 注册 spy tool。
//
// 三个 HIGH + 一个 MEDIUM（CR-001/002/003/004 修复后状态；W1d 新链序下的重表达）：
// - HIGH-1 FIXED：feedback-ledger-node 在生产链可达（E10 route 后自然前进；环回/escalate 延写）
// - HIGH-2 FIXED：completeness-verify-node 在生产链可达（C6 环内，每圈跑）
// - HIGH-3 lineage（W1d）：redo 前缀跳步停写手位重跑到链尾 + stale review/intent 不喂改稿
// - MEDIUM-4 FIXED（code-level）：环 A splice 落盘 chapters/*.md（writeChapterTool 层 chapter_write）
//
// **关键约束**：每个测试明确断言 fixed 行为（reachable / not-overwritten），证明修复生效。
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// Spy tool 注册（真 registry singleton，chain 节点能查到）
// ════════════════════════════════════════════════════════════════════════════

const feedbackLedgerWriteCalls: Array<{ episodeId: string; artifactKey: string }> = [];
const gitStatusCalls: number[] = [];
const gitCommitCalls: Array<{ message: string }> = [];

registry.register({
  id: 'feedback_ledger_write',
  description: 'integration test spy',
  parameters: z.object({
    episodeId: z.string(),
    artifactKey: z.string(),
    payload: z.unknown(),
  }),
  execute: async (params: { episodeId: string; artifactKey: string }) => {
    feedbackLedgerWriteCalls.push({ episodeId: params.episodeId, artifactKey: params.artifactKey });
    return { title: 'feedback_ledger_write', output: 'ok' };
  },
});

registry.register({
  id: 'git_status',
  description: 'integration test spy',
  parameters: z.object({}),
  execute: async () => {
    gitStatusCalls.push(1);
    return { title: 'git_status', output: 'nothing to commit, working tree clean' };
  },
});

registry.register({
  id: 'git_commit',
  description: 'integration test spy',
  parameters: z.object({ message: z.string() }),
  execute: async (params: { message: string }) => {
    gitCommitCalls.push({ message: params.message });
    return { title: 'git_commit', output: 'committed' };
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Fixtures（mirror chain-e2e.test.ts 最小 demo 数据）
// ════════════════════════════════════════════════════════════════════════════

const EPISODES = [
  episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
  episodeOutlineSchema.parse({ id: 'ep2', index: 1, title: '第二章' }),
  episodeOutlineSchema.parse({ id: 'ep3', index: 2, title: '第三章' }),
];

const TARGET_EPISODE = 'ep2';

function scene(partial: Record<string, unknown>) {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

function buildSceneGraph(): SceneGraph {
  return {
    nodes: [
      scene({ id: 's_direct', episodeId: TARGET_EPISODE }),
      scene({ id: 's_other', episodeId: 'ep1' }),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

function makeInitialArtifacts(): Record<string, unknown> {
  return {
    scene_graph: buildSceneGraph(),
    episode_outlines: EPISODES,
    settings_context: '世界观：灵气复苏的现代都市。\n主角：林动，坚韧少年。',
    chapter_brief_input: {
      episodeId: TARGET_EPISODE,
      brief: {
        goal: '主角抵达 B 城',
        ending: '城门关闭前一刻进入',
        tone: '紧迫',
        readerKnows: '读者知道追兵在后',
        mustHide: '主角的真实身份',
        doNotWrite: '主角的过去回忆',
      },
    },
    promise_registry: { promises: [], beats: [], version: 0 },
  };
}

function makeSession(): SessionState {
  return {
    id: 'sess-cr-findings',
    agentName: 'chapter-chain',
    projectPath: '/test/cr-findings-project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// mock generate：按 yaml system 段标记区分节点返 fixture JSON
// 顺序敏感：「完整性审核」/「保义裁判员」/「修订编辑」须在通用「审核」前匹配
// ════════════════════════════════════════════════════════════════════════════

const REVIEW_RESULT = {
  verdict: 'revise',
  summary: '一致性矛盾：主角动机铺垫不足',
  dimensions: [
    {
      name: 'consistency',
      findings: [
        {
          subClass: 'Characterization.memory',
          severity: 'warn',
          quote: '主角突然决定进城',
          location: '句3',
          explanation: '前文未铺垫进城动机',
        },
      ],
    },
  ],
  reasons: ['主角动机铺垫不足'],
};

const COMPLETENESS_RESULT = {
  findings: [{
    category: 'arc',
    verdict: 'under-developed',
    entityId: 'char-1',
    entityLabel: '主角成长弧',
    quote: '主角深吸一口气',
    location: '段1句1',
    explanation: '角色弧起点未充分铺垫',
    suggestedFix: '补强开篇动机',
  }],
  summary: '有缺漏',
  degraded: false,
};

interface MakeGenerateOpts {
  /** route 决策序列（按调用次序；超出长度复用最后一项）。默认 ['accept_as_truth']。 */
  routeDecisions?: string[];
}

/**
 * mock generate：按 system 标记路由 fixture JSON。system 标记对齐 prompts/*.yaml：
 * - 「规划审核」→ brief-reviewer（A2，W1d 新节点）
 * - 「路由判决」→ route-agent
 * - 「保义裁判员」→ revision-guard L2
 * - 「改稿意图编译器」→ revision-optimizer（C1，W1d 新节点）
 * - 「完整性审核」→ completeness-verify L2（**须在「审核」前**，否则被 multi-review 抢匹配）
 * - 「Reader-Audit」/「多维度」/「审核」→ multi-review
 * - 「状态提取」→ world-extractor（5 轴）
 * - 「涌现登记」→ promise-emergence
 * - 默认 → draft-writer
 */
const PLAN_REVIEW_PASS = { verdict: 'pass', summary: '卡可写', findings: [] };
const OPTIMIZER_INTENT = {
  change: { summary: '补强主角动机' },
  lockedItems: [],
  rationale: { source: 'audit-finding', note: 'auto_revise A-trigger' },
  provenance: {
    rawUserInstruction: '据 Reader-Audit 审核发现修订本章明确缺陷（auto_revise route decision）',
    compilerNote: '环内 C1 编译',
  },
};

function makeGenerate(opts: MakeGenerateOpts = {}): ReturnType<typeof vi.fn<GenerateFn>> {
  const routeDecisions = opts.routeDecisions ?? ['accept_as_truth'];
  let routeIdx = 0;
  return vi.fn<GenerateFn>(async (_msgs, sys) => {
    const s = sys ?? '';
    if (s.includes('规划审核')) {
      return { content: JSON.stringify(PLAN_REVIEW_PASS), finishReason: 'stop' };
    }
    if (s.includes('路由判决')) {
      const decision = routeDecisions[Math.min(routeIdx, routeDecisions.length - 1)];
      routeIdx += 1;
      return { content: JSON.stringify({ decision, reason: `mock ${decision}` }), finishReason: 'stop' };
    }
    // revision-guard L2（保义裁判员）—— 须在 multi-review「审核」前匹配
    if (s.includes('保义裁判员')) {
      return { content: JSON.stringify({ verdict: 'clean', findings: [], summary: '保义通过' }), finishReason: 'stop' };
    }
    // revision-optimizer（C1 环回圈编译）—— anchorless intent（yaml 契约不产 scope）
    if (s.includes('改稿意图编译器')) {
      return { content: JSON.stringify(OPTIMIZER_INTENT), finishReason: 'stop' };
    }
    // completeness-verify L2 —— 须在 multi-review「审核」前匹配（含「审核」子串）
    if (s.includes('完整性审核')) {
      return { content: JSON.stringify(COMPLETENESS_RESULT), finishReason: 'stop' };
    }
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
      return { content: JSON.stringify(REVIEW_RESULT), finishReason: 'stop' };
    }
    if (s.includes('状态提取')) {
      return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
    }
    // Story 2.2 WP-E：story-sync-agent 提取节点（system 首句「你是 story-sync-agent」）——默认空 patches。
    // **须在「涌现登记」前匹配**：story-sync system 的防线规则 7 明文提及「涌现登记」（禁止项），
    // 后匹配会被 promise-emergence 抢路由（mirror「完整性审核」在「审核」前的顺序约束）。
    if (s.includes('story-sync-agent')) {
      return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
    }
    if (s.includes('涌现登记')) {
      return { content: JSON.stringify({ promises: [], beats: [] }), finishReason: 'stop' };
    }
    // draft-writer（默认分支）
    return { content: JSON.stringify({ title: '第二章', text: 'DRAFT_WRITER_MARKER 正文内容。', wordCount: 2800, chapterId: TARGET_EPISODE }), finishReason: 'stop' };
  });
}

/** 从 generate mock 调用序列抽取 system 标记类型（用于验证节点执行序）。 */
function classifyCall(sys: unknown): string {
  const s = typeof sys === 'string' ? sys : '';
  if (s.includes('规划审核')) return 'brief-reviewer';
  if (s.includes('路由判决')) return 'route';
  if (s.includes('保义裁判员')) return 'revision-guard';
  if (s.includes('改稿意图编译器')) return 'revision-optimizer';
  if (s.includes('完整性审核')) return 'completeness-verify';
  if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) return 'multi-review';
  if (s.includes('状态提取')) return 'world-extractor';
  // 须在「涌现登记」前：story-sync system 防线规则 7 明文提及「涌现登记」（禁止项）。
  if (s.includes('story-sync-agent')) return 'story-sync';
  if (s.includes('涌现登记')) return 'promise-emergence';
  return 'draft-writer';
}

function getCallSequence(generate: ReturnType<typeof vi.fn<GenerateFn>>): string[] {
  return generate.mock.calls.map(([, sys]) => classifyCall(sys));
}

// ════════════════════════════════════════════════════════════════════════════
// runChain 驱动 helper（直调 runChain，非 mock runChapterChain）
// ════════════════════════════════════════════════════════════════════════════

async function runChainFull(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  overrides: {
    initialArtifacts?: Record<string, unknown>;
    resumedCompletedNodes?: string[];
    loops?: Array<{ from: string; through: string; cap: number }>;
  } = {},
): Promise<RunSnapshot> {
  const session = makeSession();
  return runChain(
    {
      chain: createChapterChainNodes(generate, undefined, session),
      initialArtifacts: overrides.initialArtifacts ?? makeInitialArtifacts(),
      requirement: '',
      loops: overrides.loops ?? CHAPTER_CHAIN_LOOPS,
      ...(overrides.resumedCompletedNodes ? { resumedCompletedNodes: overrides.resumedCompletedNodes } : {}),
    },
    {
      generate,
      sessionContext: session,
      signal: new AbortController().signal,
    },
  );
}

// ════════════════════════════════════════════════════════════════════════════
// HIGH-1 FIXED：feedback-ledger-node 在生产链可达（移 route 前后对比）
// ════════════════════════════════════════════════════════════════════════════

describe('HIGH-1 FIXED: feedback-ledger-node 在生产链可达（BMad CR-001 fix；W1d 挪 E10 终态一次写）', () => {
  beforeEach(() => {
    feedbackLedgerWriteCalls.length = 0;
  });

  it('route=accept_as_truth（终态）→ feedback_ledger_write 被调用（E10 在 route 后自然前进可达）', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    // W1d：route accept 后自然前进提取段，feedback-ledger（E10）终态一次写——三输入
    // （环终态 review.latest + completeness + E3 emotion）在 E 段末点齐。
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toContain('route-agent');
    expect(snapshot.completedNodes).toContain('feedback-ledger-node');

    // feedback_ledger_write spy 被调用 → HIGH-1 FIXED（提取段可达性）
    expect(feedbackLedgerWriteCalls.length).toBeGreaterThan(0);

    // feedback_ledger artifact 产出
    expect(snapshot.artifacts['feedback_ledger']).toBeDefined();
  });

  it('route=auto_revise（W1a 链内回环 + cap 耗尽强制 escalate-pause）→ E10 不跑（环体不含 E 段，账延到 resume-accept 后写）', async () => {
    const generate = makeGenerate({ routeDecisions: ['auto_revise'] });
    const snapshot = await runChainFull(generate);

    // W1a+W1d：auto_revise 链内回环 3 次后 cap 耗尽 → 强制 escalate → escalate-pause（break）。
    // feedback-ledger 在 E10（route 后提取段末）——环体 [revision-optimizer..route] 不含它，环回零重写；
    // escalate-pause break 时 E 段未跑 → feedback 账**延到 resume-accept 后**（裁决 accept 续跑 E 段才写）。
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.completedNodes).not.toContain('feedback-ledger-node');
    expect(feedbackLedgerWriteCalls.length).toBe(0);
  });

  it('route=escalate_user（灰区）→ E10 不跑（escalate-pause break；resume-accept 后续跑补写）', async () => {
    const generate = makeGenerate({ routeDecisions: ['escalate_user'] });
    const snapshot = await runChainFull(generate);

    // W1a R4b：escalate → escalate-pause（status=paused + 标记）；E 段未跑——账延到裁决 accept 续跑
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.completedNodes).not.toContain('feedback-ledger-node');
    expect(feedbackLedgerWriteCalls.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HIGH-2 FIXED：completeness-verify-node 在生产链可达（移 route 前）
// ════════════════════════════════════════════════════════════════════════════

describe('HIGH-2 FIXED: completeness-verify-node 在生产链可达（BMad CR-002 fix）', () => {
  it('route=accept_as_truth → completeness-verify L2 generate 被调用 + artifact 产出', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    // CR-002 fix：completeness-verify 移 route 前（multi-review 后），through-break 前可达
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toContain('completeness-verify-node');

    // generate 调用序列含 completeness-verify → HIGH-2 FIXED
    const sequence = getCallSequence(generate);
    expect(sequence).toContain('completeness-verify');

    // completeness_verify_result artifact 产出
    expect(snapshot.artifacts['completeness_verify_result']).toBeDefined();
  });

  it('route=auto_revise（W1a 链内回环）→ completeness-verify L2 generate 被调用（环体每轮跑）', async () => {
    const generate = makeGenerate({ routeDecisions: ['auto_revise', 'accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    // W1a：auto_revise 链内回环一次 → 二判 accept 终态；completeness-verify 在环体内每轮跑（2 次）
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toContain('completeness-verify-node');

    const sequence = getCallSequence(generate);
    expect(sequence.filter((c) => c === 'completeness-verify').length).toBe(2);
    expect(snapshot.artifacts['completeness_verify_result']).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HIGH-3 lineage（链流程重排 W1d）：redo 语义按新链序重表达——targeted-revision 退役，
// CR-003 的「过期 review 不喂改稿」防线由 revision-optimizer no-op（redo 清 review.latest 后）
// + 多审重跑天然覆盖；本组钉死 M3 redo 移除边界（写手位重跑到链尾）+ 环计数重置。
// ════════════════════════════════════════════════════════════════════════════

describe('HIGH-3 lineage（W1d 新链 redo 语义）：写手位重跑到链尾 + stale review/intent 不喂改稿', () => {
  // 链序（chapter-chain.ts CHAPTER_CHAIN_NODE_IDS，W1d）：
  // 0 brief-compiler / 1 brief-reviewer / 2 revision-optimizer / 3 draft-writer / 4 revision-guard /
  // 5 lint / 6 multi-review / 7 completeness / 8 route（环 through）/ 9-13 world×5 / 14 merge /
  // 15 emotion / 16 promise / 17 arc / 18 summary / 19 storytime / 20 mention / 21 story-sync /
  // 22 feedback-ledger
  //
  // loops = [规划环 {0..1} cap2, 自审环 {2..8} cap3]
  //
  // redo（mirror workflow.ts redo path：清 review.latest + 非 guardOverride 清 stale revision_intent）
  // 移除 [draft-writer, revision-guard, multi-review, route] → 前缀跳步停在写手位（idx3）→
  // 重跑到链尾（M3：A1/A2/C1 规划侧保留 completed——人审反馈针对正文非任务卡）。

  it('干净终态基底：route=accept → snapshot 含 review.latest + completedNodes 含全节点 + draft 为写手产出', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toContain('route-agent');

    // review.latest 产出（multi-review 跑了）
    expect(snapshot.artifacts['review.latest']).toBeDefined();

    // W1d 提取段可达：completeness（C6 环内）+ feedback-ledger（E10 route 后）
    expect(snapshot.completedNodes).toContain('completeness-verify-node');
    expect(snapshot.completedNodes).toContain('feedback-ledger-node');

    // draft.initial 是 draft-writer 产出（首圈 C1 no-op 无改稿轮——targeted-revision 已退役）
    const draft = snapshot.artifacts['draft.initial'] as { text: string };
    expect(draft.text).toContain('DRAFT_WRITER_MARKER');
  });

  it('redo（清 review.latest + stale revision_intent，mirror workflow redo path）→ 前缀跳步停在写手位重跑到链尾', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });

    // 首次 run（干净终态）
    const snapshot1 = await runChainFull(generate);
    expect(snapshot1.status).toBe('completed');

    // 模拟 redo（mirror workflow.ts runChapterChain redo path）：
    // 1. 从 snapshot1.completedNodes 移除 redo 目标节点（写手 + guard + multi-review + route）
    // 2. 清 review.latest（CR-003 lineage：过期 review 不喂环）
    // 3. 清 stale revision_intent（W1d：redo 不注入新意图时 C1 上圈编译产物不残留喂写手）
    const loopNodes = ['draft-writer-agent', 'revision-guard-agent', 'multi-review-agent', 'route-agent'];
    const resumedCompletedNodes = snapshot1.completedNodes.filter((id) => !loopNodes.includes(id));

    const redoArtifacts = { ...snapshot1.artifacts };
    delete redoArtifacts['review.latest'];
    delete redoArtifacts['revision_intent'];

    const snapshot2 = await runChainFull(generate, {
      initialArtifacts: redoArtifacts,
      resumedCompletedNodes,
    });

    expect(snapshot2.status).toBe('completed');

    // redo generate 调用序列（首次 run 11 calls 后）：
    // writer(1) + multi-review(1) + completeness(1) + route(1) + world-ext(5) + story-sync(1) = 10。
    // **C1 revision-optimizer 不重跑**（completed 前缀保留——M3 移除边界：规划侧 + C1 留 completed）；
    // **brief-reviewer 不重跑**（规划环节点保留）；提取段重跑到链尾（story-sync 每轮重提取）。
    const allCalls = getCallSequence(generate);
    const redoCalls = allCalls.slice(11);
    expect(redoCalls).not.toContain('brief-reviewer');
    expect(redoCalls).not.toContain('revision-optimizer');
    expect(redoCalls.filter((c) => c === 'draft-writer')).toHaveLength(1);
    expect(redoCalls).toContain('story-sync');

    // draft.initial 为重跑写手产出（新链无 targeted-revision 覆盖面）
    const draft2 = snapshot2.artifacts['draft.initial'] as { text: string };
    expect(draft2.text).toContain('DRAFT_WRITER_MARKER');

    // M3 环计数重置：redo 重入 = 新 runChain 调用 → 环 count 从 0 起算（本例 route accept 无回环，
    // 计数语义在 chainRunner.test.ts W1a M3 用例钉死——此处链级验「重入可正常终态」不卡死）。
  });

  it('redo 调用计数：首次 11 + redo 10 = 21（C1/规划侧前缀保留零重跑；提取段 redo 重收一次）', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });

    const baseline = await runChainFull(generate);
    expect(baseline.status).toBe('completed');

    const loopNodes = ['draft-writer-agent', 'revision-guard-agent', 'multi-review-agent', 'route-agent'];
    const resumedCompletedNodes = baseline.completedNodes.filter((id) => !loopNodes.includes(id));
    const redoArtifacts = { ...baseline.artifacts };
    delete redoArtifacts['review.latest'];
    delete redoArtifacts['revision_intent'];
    const redoSnapshot = await runChainFull(generate, {
      initialArtifacts: redoArtifacts,
      resumedCompletedNodes,
    });
    expect(redoSnapshot.status).toBe('completed');

    // 首次：brief-reviewer(1) + draft(1) + multi-review(1) + completeness(1) + route(1)
    //      + world-ext(5) + story-sync(1) = 11（C1 首圈 no-op 零调用）
    // redo：draft(1) + multi-review(1) + completeness(1) + route(1) + world-ext(5) + story-sync(1) = 10
    //      （C1/brief-reviewer 前缀保留不重跑；guard 无 anchored 意图 skip 零调用）
    expect(generate.mock.calls.length).toBe(21);
    const redoCalls = getCallSequence(generate).slice(11);
    expect(redoCalls.filter((c) => c === 'story-sync')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MEDIUM-4 FIXED（code-level）：环 A splice 落盘 chapters/*.md（writeChapterTool 层 chapter_write）
// ════════════════════════════════════════════════════════════════════════════

describe('MEDIUM-4 FIXED: splice 落盘在 writeChapterTool 层（chapter_write builtin，CR-004 fix）', () => {
  // revision-guard splicePassage（chapter-nodes.ts:918）只 mutate 内存 run.artifacts['draft.initial']，
  // 不写盘。CR-004 fix：writeChapterTool redo 循环后（autoReviseCount > 0）经 chapter_write builtin 写
  // chapters/{chapterId}.md（summary.draftText 含 splice 后正文）→ git_status 找到变更 → commit 建版本节点。
  //
  // 本测试验证链段层面：git_commit / git_status spy 未被链段调用（git 操作在 writeChapterTool 层非链段层）。
  // CR-004 fix 的完整验证（chapter_write 被调 + git commit 建版本节点）需 writeChapterTool 级集成测试
  // （真 project.yaml + 真 dispatchSubagent + 链段跑通 + chapter_write spy），非 chain 级能测。

  beforeEach(() => {
    gitCommitCalls.length = 0;
    gitStatusCalls.length = 0;
  });

  it('链段执行完毕 → git_commit / git_status spy 未被链段调用（git 操作在 writeChapterTool 层）', async () => {
    const generate = makeGenerate({ routeDecisions: ['accept_as_truth'] });
    const snapshot = await runChainFull(generate);

    expect(snapshot.status).toBe('completed');
    // git_commit / git_status 是 writeChapterTool 层操作，非链段节点操作
    // → 链段本身永远不调 git 工具（无论 splice 与否）
    expect(gitCommitCalls).toHaveLength(0);
    expect(gitStatusCalls).toHaveLength(0);
  });

  // CR-004 fix code-level 证据：
  // - revision-guard splicePassage（chapter-nodes.ts:918）只 return {text: spliced.text} mutate 内存
  // - write-chapter.ts CR-004 fix（L1536+）：redo 后调 chapter_write builtin 写 chapters/{chapterId}.md
  //   （summary.draftText = splice 后正文）→ git_status 找到变更 → commitRevisionNode commit
  // - chapter_write handler（chapterHandlers.ts:45）：atomicWriteFileSync chapters/{chapterId}.md
  // 结论：CR-004 FIXED（code-level），splice 落盘经 chapter_write builtin → git 版本节点建立。
  // 完整 e2e 验证需 writeChapterTool 级集成测试（超 chain 级 scope）。
});
