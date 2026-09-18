import { describe, expect, it, vi } from 'vitest';
import {
  sceneNodeSchema,
  episodeOutlineSchema,
  type SceneGraph,
} from '@orison/shared-contracts';
import { runChain, summarizeRunSnapshot } from '../src/runtime/chainRunner';
import {
  createChapterChainNodes,
  CHAPTER_CHAIN_LOOPS,
} from '../src/nodes/chapter-chain';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { ChainLoopConfig, RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4 / implement.md 7.1：写章战术链段端到端集成测（4.0 dogfooding gate 的 mock-LLM 版）。
//
// **全链 runChain + mock generate（不调真 LLM）**：真节点（createChapterChainNodes 装配的 6 节点）+
// mock generate（按 system 标记返 fixture JSON）+ assembled initialArtifacts（scene_graph/设定/
// ChapterBrief/promise_registry）→ runChain 跑全链 → 验产出 + 全链 artifact 流转 + revision 闭环。
//
// 与 Step 4/5 单测的分工：
// - Step 4 chainRunner.test.ts：runChain 驱动器纯逻辑测（mock 节点 run()，不涉真 chapter-chain 节点）。
// - Step 5 runChapterChain.test.ts：runChapterChain 包装层（dispatchSubagent + context isolation + abort +
//   chainSnapshot 持久）+ 真 LLM 节点经包装层跑通。
// - **Step 7.1 本文件**：真 6 节点 + mock generate 跑 runChain 全链，重点验**全链 artifact 流转** +
//   **yaml `{{var}}` 被 renderTemplate 消费** + **brief #6 plotPoints 汇编** + **三档 route_decision** +
//   **revision 闭环 draft.initial overwrite** + **summarizeRunSnapshot context isolation**。
//
// 用 runChain 直调（非 runChapterChain）—— Step 5 已测包装层；e2e 重点在链内 artifact 流转，runChain 直调
// 给完整 snapshot 访问（chapter_brief / draft.initial / review.latest 等），context isolation 单独验。
//
// 三档 route 场景（额量）：
// 1. revision 闭环（auto_revise → targeted-revision 改稿 → accept_as_truth 终止）—— 主详测，7 断言全验。
// 2. happy-path（accept 首判，无闭环）。
// 3. escalate 路径（route 返 escalate_user → 链段立即结束）。
// 4. cap 超限（route 持续 auto_revise → cap 上限 → 强制 escalate_user）。
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// fixture：最小 demo 数据（scene_graph 含 M:N 跨章场 + episode_outlines + 设定 + brief + registry）
// ════════════════════════════════════════════════════════════════════════════

const EPISODES = [
  episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
  episodeOutlineSchema.parse({ id: 'ep2', index: 1, title: '第二章' }),
  episodeOutlineSchema.parse({ id: 'ep3', index: 2, title: '第三章' }),
];

const TARGET_EPISODE = 'ep2';

/** 构造 valid SceneNode（schema.parse 填默认 lineTags/role，避免漏 required 字段）。 */
function scene(partial: Record<string, unknown>) {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

/**
 * demo scene_graph：3 场覆盖 brief #6 汇编矩阵。
 * - s_direct：episodeId=ep2（单章场直挂，1.1 行为）→ 命中。
 * - s_cross：presentationSpans=[ep2,ep3]（跨章场 M:N，1.8）→ 命中（续到后章）。
 * - s_other：episodeId=ep1（他章场）→ 不命中（排除）。
 */
function buildSceneGraph(): SceneGraph {
  return {
    nodes: [
      scene({ id: 's_direct', episodeId: TARGET_EPISODE }),
      scene({
        id: 's_cross',
        presentationSpans: [
          { episodeId: TARGET_EPISODE, pos: 0 },
          { episodeId: 'ep3', pos: 0 },
        ],
      }),
      scene({ id: 's_other', episodeId: 'ep1' }),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

/** 链段 initialArtifacts（mirror write_chapter tool / dogfood IPC 组装产物）。 */
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
        emotionTarget: { emotion: '紧张', emotionEnd: '释然', vad: { v: -0.5, a: 0.8, d: 0.1 }, steer: '窒息感再松一口气' },
      },
    },
    promise_registry: { promises: [], beats: [], version: 0 },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// mock generate：按 system 标记路由 fixture（route 用计数器返决策序列）
// ════════════════════════════════════════════════════════════════════════════

const INITIAL_DRAFT = {
  title: '第二章 B 城',
  text: '黄昏的荒野上，主角深吸一口气，攥紧行囊向远方的城墙走去。INITIAL_DRAFT_MARKER',
  wordCount: 2800,
  chapterId: TARGET_EPISODE,
};

const REVISED_DRAFT = {
  title: '第二章 B 城（修订）',
  text: '主角攥紧拳头，目光投向远方巍峨的城壁，脚步不由自主地加快。REVISED_DRAFT_MARKER',
  wordCount: 2950,
  chapterId: TARGET_EPISODE,
  revisionNotes: ['补强主角动机：加入对家人的牵挂'],
};

const REVIEW_RESULT = {
  verdict: 'revise',
  summary: '一致性矛盾：主角动机铺垫不足（Reader-Audit 双层审核）',
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
    {
      name: 'narrative-feature',
      findings: [
        { severity: 'info', quote: '深吸一口气', location: '句1', explanation: 'cliché 微表情（语境尚可）' },
      ],
    },
  ],
  reasons: ['主角动机铺垫不足', 'L1 cliché hotspot 已回应（句1，降级 info）'],
};

/** brief-reviewer fixture（A2 规划审核——六维全过，规划环 pass 直通写手）。 */
const PLAN_REVIEW_PASS = {
  verdict: 'pass',
  summary: '任务卡可写，无硬维度缺陷',
  findings: [],
};

/**
 * revision-optimizer fixture（C1 环回圈编译产物——anchorless：optimizer yaml 契约「不产 scope」，
 * 选区锚点由系统构造；A-trigger 编译的意图是整章 directive 形态，写手走带指令的整章重写）。
 */
const OPTIMIZER_INTENT = {
  change: { summary: '补强主角动机（据 Reader-Audit findings 编译）', details: ['进城决策加铺垫'] },
  lockedItems: [{ field: '角色性格', authority: 'hard', evidence: '坚韧少年' }],
  rationale: { source: 'user-directive', note: 'auto_revise A-trigger 编译（source 由节点机械盖戳）' },
  provenance: { rawUserInstruction: '据 Reader-Audit 审核发现修订本章明确缺陷（auto_revise route decision）', compilerNote: '环内 C1 编译' },
};

interface GenerateOverrides {
  /** route 决策序列（按调用次序；超出长度时复用最后一项）。默认 ['auto_revise','accept_as_truth']。 */
  routeDecisions?: string[];
  /** route 每次返的 reason 文本。 */
  routeReason?: string;
}

/**
 * mock generate：按 yaml system 段标记区分节点返 fixture。
 * - system 含「规划审核」→ brief-reviewer-node（A2），返 PLAN_REVIEW_PASS（规划环 pass）。
 * - system 含「路由判决」→ route-agent，按 routeDecisions 序列返（计数器）。
 * - system 含「改稿意图编译器」→ revision-optimizer-node（C1 环回圈编译），返 OPTIMIZER_INTENT。
 * - system 含「完整性审核」→ completeness-verify L2（须在 generic「审核」前匹配）。
 * - system 含「Reader-Audit」/「审核」/「多维度」→ Reader-Audit（multi-review-agent），返 REVIEW_RESULT。
 * - system 含「状态提取」→ world-extractor（5 轴）。
 * - system 含「story-sync-agent」→ story-sync 提取节点（空 patches）。
 * - 其余（含「故事写作者」）→ draft-writer-agent：**首跑返 INITIAL_DRAFT（整章首写），后续返
 *   REVISED_DRAFT（环回圈带 revision_intent 的改稿轮）**——W1d 单位置写手 B/C2 双形态。
 */
function makeE2eGenerate(overrides: GenerateOverrides = {}) {
  const routeDecisions = overrides.routeDecisions ?? ['auto_revise', 'accept_as_truth'];
  const routeReason = overrides.routeReason ?? 'mock route reason';
  let routeIdx = 0;
  let writerRound = 0;
  return vi.fn<GenerateFn>(async (_msgs, sys) => {
    const s = sys ?? '';
    if (s.includes('规划审核')) {
      return { content: JSON.stringify(PLAN_REVIEW_PASS), finishReason: 'stop' };
    }
    if (s.includes('路由判决')) {
      const decision = routeDecisions[Math.min(routeIdx, routeDecisions.length - 1)];
      routeIdx += 1;
      return {
        content: JSON.stringify({ decision, reason: `${routeReason} (${decision})` }),
        finishReason: 'stop',
      };
    }
    if (s.includes('改稿意图编译器')) {
      return { content: JSON.stringify(OPTIMIZER_INTENT), finishReason: 'stop' };
    }
    // completeness-verify L2（「完整性审核」——须在 generic「审核」前匹配）
    if (s.includes('完整性审核')) {
      return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
    }
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
      return { content: JSON.stringify(REVIEW_RESULT), finishReason: 'stop' };
    }
    // world-extractor（5 轴提取器，6.6 Phase C1/C2）—— yaml system 含「<轴>状态提取专家」，共同子串「状态提取」
    if (s.includes('状态提取')) {
      return {
        content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }),
        finishReason: 'stop',
      };
    }
    // Story 2.2 WP-E：story-sync-agent 提取节点（system 首句「你是 story-sync-agent」）——默认空 patches
    if (s.includes('story-sync-agent')) {
      return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
    }
    // draft-writer（默认分支）：首跑整章初稿 / 环回圈改稿轮（revision_intent directive 在 prompt 里）。
    // CR-1 断路器对照：改稿轮 ≥3 在正文尾携轮次标记——每圈草稿真实变化，确定性空转断路器不触发
    //（cap 耗尽语义在下方 cap=3 用例独立锚定；空转短路行为在 chainRunner.test.ts CR-1 组专测）。
    writerRound += 1;
    if (writerRound >= 3) {
      return {
        content: JSON.stringify({
          ...REVISED_DRAFT,
          text: `${REVISED_DRAFT.text}（修订第${writerRound}轮）`,
        }),
        finishReason: 'stop',
      };
    }
    return {
      content: JSON.stringify(writerRound === 1 ? INITIAL_DRAFT : REVISED_DRAFT),
      finishReason: 'stop',
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// runChain e2e 驱动 helper
// ════════════════════════════════════════════════════════════════════════════

function makeSession(): SessionState {
  return {
    id: 'sess_e2e',
    agentName: 'chapter-chain',
    projectPath: '/test/e2e-project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 用真节点 + mock generate 跑 runChain 全链（design §4.1 数据流）。loops 缺省 = 生产双环（W1d 装配）。 */
async function runChainE2E(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  auditLoopOverrides: Partial<ChainLoopConfig> = {},
): Promise<RunSnapshot> {
  const session = makeSession();
  return runChain(
    {
      chain: createChapterChainNodes(generate, undefined, session),
      initialArtifacts: makeInitialArtifacts(),
      requirement: '',
      loops: CHAPTER_CHAIN_LOOPS.map((loop) =>
        loop.from === 'revision-optimizer-node' ? { ...loop, ...auditLoopOverrides } : loop,
      ),
    },
    {
      generate,
      sessionContext: session,
      signal: new AbortController().signal,
    },
  );
}

/** 收集 mock generate 收到的所有 user prompt（验 yaml `{{var}}` 渲染）。 */
function collectUserPrompts(generate: ReturnType<typeof vi.fn<GenerateFn>>): string[] {
  return generate.mock.calls.map(([msgs]) => {
    const msg = (msgs as Array<{ content?: string }> | undefined)?.[0];
    return msg?.content ?? '';
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 链内回环主场景（链流程重排 W1d：auto_revise → 环体 7 节点重跑 → 二判 accept 终态）— 7 断言全验
//    环内改稿执行者 = 单位置写手（optimizer 紧后）：首圈整章首写（INITIAL_DRAFT），环回圈带 C1 编译的
//    anchorless revision_intent 走 directive 整章重写（REVISED_DRAFT）；targeted-revision 已退役。
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — 链内回环（W1d：auto_revise 环内收敛，写手单位置改稿）', () => {
  it('全链跑通：规划环 pass + draft 产出 + auto_revise 回环重跑（optimizer→writer）+ 修订稿落定 + 提取段对终稿一次 + yaml 渲染 + brief #6 + summary isolation', async () => {
    const generate = makeE2eGenerate(); // route: auto_revise → accept_as_truth（回环一次后收敛）
    const snapshot = await runChainE2E(generate);

    // ── 断言 1：chapter draft 产出（draft.initial 含 title/text/wordCount，非空）──
    const draft = snapshot.artifacts['draft.initial'] as Record<string, unknown>;
    expect(draft).toBeDefined();
    expect(typeof draft.title).toBe('string');
    expect(typeof draft.text).toBe('string');
    expect(typeof draft.wordCount).toBe('number');

    // ── 断言 2：review.verdict 产出（review.latest 含 verdict + dimensions）+ plan_review pass
    //    （规划环 A2 独立审核过卡）+ revision_intent 编译产物（source 机械盖戳 audit-finding）──
    const review = snapshot.artifacts['review.latest'] as Record<string, unknown>;
    expect(review).toBeDefined();
    expect(review.verdict).toBe('revise');
    expect(Array.isArray(review.dimensions)).toBe(true);
    expect((snapshot.artifacts['plan_review'] as { verdict: string }).verdict).toBe('pass');
    expect(snapshot.artifacts['revision_intent']).toMatchObject({
      rationale: { source: 'audit-finding' },
    });

    // ── 断言 3：route 终态 = accept_as_truth（回环一次收敛后二判）+ status completed（无 auto_revise_pending）──
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string; reason: string };
    expect(routeDecision.decision).toBe('accept_as_truth');
    expect(typeof routeDecision.reason).toBe('string');
    expect(snapshot.status).toBe('completed');

    // ── 断言 4：链内回环（环体 7 节点重跑一次，LLM 面 5 节点）：首轮 11（brief-reviewer + draft-writer
    //    + 5 轴 world-extractor + multi-review + completeness + route + story-sync）+ 回环 5（revision-
    //    optimizer + draft-writer 改稿轮 + multi-review + completeness + route）= 16。提取段（world×5 +
    //    story-sync）在环外零重跑（AC5 环瘦身）。draft.initial 被环内改稿落定为修订稿（REVISED_DRAFT）。──
    expect(generate.mock.calls.length).toBe(16);
    expect(draft.text).toContain('REVISED_DRAFT_MARKER');
    expect(draft.title).toBe(REVISED_DRAFT.title);

    // ── 断言 5：yaml `{{var}}` 渲染（mock generate 收到的 userPrompt 不含字面 `{{...}}` 模板标记）──
    const userPrompts = collectUserPrompts(generate);
    expect(userPrompts.length).toBe(16);
    for (const content of userPrompts) {
      expect(content).not.toMatch(/\{\{[^{}]*\}\}/); // 无残留 `{{key}}` 模板标记
      expect(content).not.toContain('{{'); // JSON 不产 `{{` → 见到就是未渲染模板
    }
    // AC5 环瘦身（调用计数维度）：写手恰 2 次（首写 + 环回改稿轮）；world 提取器恰 5 次（环外零重跑）。
    const writerCalls = generate.mock.calls.filter(([, sys]) => {
      const s = sys ?? '';
      return (
        !s.includes('规划审核') &&
        !s.includes('路由判决') &&
        !s.includes('改稿意图编译器') &&
        !s.includes('Reader-Audit') &&
        !s.includes('多维度') &&
        !s.includes('审核') &&
        !s.includes('状态提取') &&
        !s.includes('story-sync-agent')
      );
    });
    expect(writerCalls.length).toBe(2);
    expect(generate.mock.calls.filter(([, sys]) => (sys ?? '').includes('状态提取')).length).toBe(5);
    // 额定：验具体 var 真的注入了（非空替换）—— draft-writer user prompt 含 chapter_brief goal + settings
    const draftCall = writerCalls[0];
    expect(draftCall).toBeDefined();
    const draftUserContent = (draftCall![0] as Array<{ content?: string }>)[0]?.content ?? '';
    expect(draftUserContent).toContain('主角抵达 B 城'); // chapter_brief.goal 经 brief-compiler 透传
    expect(draftUserContent).toContain('灵气复苏'); // settings_context 注入 {{projectContext}}

    // ── 断言 6：brief #6 汇编（chapter_brief artifact 含 plotPoints from scene_graph）──
    const chapterBrief = snapshot.artifacts['chapter_brief'] as { plotPoints?: Array<{ sceneId: string; continuity?: string }> };
    expect(chapterBrief).toBeDefined();
    expect(Array.isArray(chapterBrief.plotPoints)).toBe(true);
    // 命中 2 场（s_direct 单章场 + s_cross M:N 跨章场），排除 s_other（他章场）
    const sceneIds = chapterBrief.plotPoints!.map((p) => p.sceneId);
    expect(sceneIds).toEqual(['s_direct', 's_cross']);
    // 连续性标注：s_direct 单章场 → '本章内'；s_cross spans=[ep2,ep3] → '续到后章'
    const byId = Object.fromEntries(chapterBrief.plotPoints!.map((p) => [p.sceneId, p.continuity]));
    expect(byId.s_direct).toBe('本章内');
    expect(byId.s_cross).toBe('续到后章');
    // LLM 段透传（brief #1 goal / #5 doNotWrite / #10 emotionTarget）
    const briefRecord = chapterBrief as unknown as Record<string, unknown>;
    expect(briefRecord.goal).toBe('主角抵达 B 城');
    expect(briefRecord.doNotWrite).toBe('主角的过去回忆');
    expect(briefRecord.emotionTarget).toEqual({
      emotion: '紧张',
      emotionEnd: '释然',
      vad: { v: -0.5, a: 0.8, d: 0.1 },
      steer: '窒息感再松一口气',
    });

    // ── 断言 7：summarizeRunSnapshot 返回 summary（不含内部 trace；autoReviseFindings 已随 W1a 退役）──
    const summary = summarizeRunSnapshot(snapshot);
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision).toEqual({
      decision: 'accept_as_truth',
      reason: expect.stringContaining('accept_as_truth'),
    });
    expect(summary.reviewVerdict).toBe('revise');
    expect(summary.draftTitle).toBe(REVISED_DRAFT.title); // 修订稿标题（环内改稿落定后）
    expect(Array.isArray(summary.errors)).toBe(true);
    expect(summary.autoReviseFindings).toBeUndefined(); // W1a：leader redo 编排退役，字段删除
    // context isolation：summary 不含内部 trace / 全量 artifacts
    const summaryKeys = Object.keys(summary);
    expect(summaryKeys).not.toContain('artifacts');
    expect(summaryKeys).not.toContain('completedNodes');
    expect(summaryKeys).not.toContain('scene_graph');
    expect(summaryKeys).not.toContain('chapter_brief');
    expect(summaryKeys).not.toContain('draft');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. happy-path（accept 首判，无闭环）
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — happy-path（accept 首判，无回环）', () => {
  it('route 首判 accept_as_truth → 提取段跑完链完成（11 generate 调用，无回环）', async () => {
    const generate = makeE2eGenerate({
      routeDecisions: ['accept_as_truth'],
      routeReason: '正文达标',
    });
    const snapshot = await runChainE2E(generate);

    // route 首判 accept → onAccept + verdict checkpoint 后自然前进提取段 → 链完成
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string };
    expect(routeDecision.decision).toBe('accept_as_truth');
    expect(snapshot.status).toBe('completed');

    // 无回环：generate 调用 = brief-reviewer(1) + draft-writer(1) + 5 轴 world-extractor(5)
    // + multi-review(1) + completeness-verify(1) + route(1) + story-sync(1，2.2 WP-E) = 11
    //（revision-optimizer 首圈 no-op 不调 LLM——无 review.latest）
    expect(generate.mock.calls.length).toBe(11);
    // E 段可达（提取后移：route accept 后自然前进）
    expect(snapshot.completedNodes).toContain('world-merge-node');
    expect(snapshot.completedNodes).toContain('feedback-ledger-node');

    // draft.initial = 初稿（无回环无改稿轮）
    const draft = snapshot.artifacts['draft.initial'] as { text: string };
    expect(draft.text).toContain('INITIAL_DRAFT_MARKER');

    // yaml 渲染（无字面 {{）
    for (const content of collectUserPrompts(generate)) {
      expect(content).not.toContain('{{');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. escalate 路径（route 返 escalate_user → 链段立即结束）
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — escalate 路径（route 返 escalate_user → escalate-pause）', () => {
  it('route 首判 escalate_user → escalate-pause（11 generate 调用，无回环；提取段不可达）', async () => {
    const generate = makeE2eGenerate({
      routeDecisions: ['escalate_user'],
      routeReason: 'OOC 边界难断，需作者拍板',
    });
    const snapshot = await runChainE2E(generate);

    // route 首判 escalate_user → escalate-pause（W1a R4b：灰区链内暂停形态，裁决驱动 resume）
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string; reason: string };
    expect(routeDecision.decision).toBe('escalate_user');
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.currentNodeId).toBe('route-agent'); // 停 through 节点

    // 无回环：generate 调用 = brief-reviewer(1) + draft(1) + 5 轮 world-extractor... 提取段在 route 后
    // ——escalate-pause break 时 E 段未跑：brief-reviewer(1) + draft(1) + multi-review(1) +
    // completeness(1) + route(1) = 5（story-sync/world 不跑——提取后移）。
    expect(generate.mock.calls.length).toBe(5);
    expect(snapshot.completedNodes).not.toContain('world-merge-node');

    // summary 透传 escalate + escalatePause 标记（入口层据此派裁决器 + resume 分派）
    const summary = summarizeRunSnapshot(snapshot);
    expect(summary.routeDecision?.decision).toBe('escalate_user');
    expect(summary.status).toBe('paused');
    expect(summary.escalatePause).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. W1a：环 cap 超限 → 强制 escalate-pause（链内 cap 防御；leader 侧 AUTO_REVISE 兜底计数已退役）
// ════════════════════════════════════════════════════════════════════════════

describe('chain-e2e — W1a 环 cap 超限强制 escalate-pause', () => {
  it('cap=0：route auto_revise → 立即强制 escalate-pause（无回环重跑）', async () => {
    // W1a：cap=0 → count(0) < cap(0) = false → 立即强制 escalate → escalate-pause（链内 cap 防御）。
    const generate = makeE2eGenerate({
      routeDecisions: ['auto_revise'], // 永远 auto_revise
      routeReason: '仍有缺陷',
    });
    const snapshot = await runChainE2E(generate, { cap: 0 });

    // cap=0 → 强制 escalate_user（runChain 覆写 route_decision）
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string; reason: string };
    expect(routeDecision.decision).toBe('escalate_user');
    expect(routeDecision.reason).toContain('cap');

    // W1a：escalate-pause（status=paused + escalatePause 标记）+ errors 记 cap 超限
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.errors?.some((e) => e.includes('cap'))).toBe(true);

    // generate 调用：cap=0 在 route 首判即 escalate-pause——提取段（route 后）未跑：
    // brief-reviewer(1) + draft-writer(1) + multi-review(1) + completeness(1) + route(1) = 5
    expect(generate.mock.calls.length).toBe(5);
    expect(snapshot.completedNodes).not.toContain('world-merge-node');

    // draft.initial 未被 overwrite（cap=0 无回环改稿轮）
    const draft = snapshot.artifacts['draft.initial'] as { text: string };
    expect(draft.text).toContain('INITIAL_DRAFT_MARKER');

    // summary 透传强制 escalate + escalatePause 标记（入口层据此分派裁决 resume）
    const summary = summarizeRunSnapshot(snapshot);
    expect(summary.routeDecision?.decision).toBe('escalate_user');
    expect(summary.escalatePause).toBe(true);
    expect(summary.pausedStage).toBeUndefined(); // 非 stage 审阅卡形态
  });

  it('cap=3：持续 auto_revise → 3 次回环后 cap 耗尽 → 强制 escalate-pause（不再 break 交 leader）', async () => {
    // 对照（W1a 语义）：cap=3（生产配置）时 auto_revise 链内回环 3 次（环体重跑），第 4 判仍
    // auto_revise → cap 耗尽强制 escalate-pause——环内收敛失败信号直达入口层（裁决分派），
    // leader AUTO_REVISE 兜底循环已退役。
    const generate = makeE2eGenerate({
      routeDecisions: ['auto_revise'],
      routeReason: '仍有缺陷',
    });
    const snapshot = await runChainE2E(generate); // 默认自审环 cap=3

    // cap=3 → 3 次回环后强制 escalate → escalate-pause（routeDecision 已被覆写 escalate_user）
    const routeDecision = snapshot.artifacts['route_decision'] as { decision: string };
    expect(routeDecision.decision).toBe('escalate_user');
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);

    // generate 调用：cap 耗尽在 route 第 4 判 escalate-pause——提取段未跑：首轮 5（brief-reviewer +
    // draft + multi-review + completeness + route）+ 3 次回环 × 环体 LLM 5 节点（optimizer + writer
    // 改稿轮 + multi-review + completeness + route）= 5 + 15 = 20（提取段在环外零重跑——AC5 环瘦身）
    expect(generate.mock.calls.length).toBe(20);
  });
});
