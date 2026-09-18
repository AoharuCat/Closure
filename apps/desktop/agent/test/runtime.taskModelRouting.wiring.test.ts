import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  episodeOutlineSchema,
  type ResearchBrief,
  type TaskModelSlot,
} from '@orison/shared-contracts';
import { runChain } from '../src/runtime/chainRunner';
import {
  createChapterChainNodes,
  type ChainSlotResolver,
} from '../src/nodes/chapter-chain';
import { resolveTaskModel, setTaskSlotResolver } from '../src/runtime/taskModelRouting';
import { registry } from '../src/tool/registry';
// CR-24（09-12 agy provider CR 批）：setExecuteToolFn 的还原句柄——三个注入它的
// describe（writer 双档 ×2 + sessionKey）afterEach 配对还原，stub 不跨 describe 残留。
import { setExecuteToolFn } from '../src/tool/remote';
// CR-002 factory spies（module mock 包装的透传工厂——见文件头 mock 段）。
import {
  createReaderAuditNode,
  createRevisionGuardNode,
  createRouteNode,
} from '../src/nodes/chapter-nodes';
import { createCompletenessVerifyNode } from '../src/nodes/completeness-verify-node';
import { createBriefReviewerNode } from '../src/nodes/brief-reviewer-node';
import { createRevisionOptimizerNode } from '../src/nodes/revision-optimizer-node';
import { createPromiseEmergenceNode } from '../src/nodes/promise-emergence-node';
import { createArcEmergenceNode } from '../src/nodes/arc-emergence-node';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// C3.2 任务路由 S4 接线测试（R4 红线：断言钉 mock generate 实收的 opts.modelRef）。
//
// 「接线漏了」与「用户没配」在回退语义下不可观测区分（taskModelRouting.ts 头注释）——
// 唯一防线是逐锚点断言 generate 第 5 参的 modelRef。六档锚点映射（design §2 档位表 canonical）：
// - writer-selfcheck：writer Phase1 自查 + 资料员核实子循环（生产装配形态，双档分离验证）
// - writer-draft：writer Phase2 写作 + 2.5 申报 + legacy 降级直写（链 e2e）
// - review-judge：multi-review / completeness-verify / route（链 e2e 三锚点）
// - extraction：world-extractor ×5 + story-sync（链 e2e 六锚点）
// - dispatch：workflow.ts yaml 派发单点按 agentName 查表（runtime 级，director→dispatch、
//   adjudicator→route-judge〔09-13 R1b 迁档，细档未配回落 review-judge〕、未知名→undefined
//   自动选择）
// - dialogue：leader runLoop（runtime 级 sendMessage；turn 入口解析一次，CR-003）
// 回归门：未配置任何档 → 全锚点收 undefined → provider default 哨兵 → shell 自动选择
// （= 会话模型机制退役〔拍板 #5〕后「选择器为空」的现状路径）。
//
// describe 顺序无约定（CR-010）：每个 describe 自带隔离——链 e2e 在 beforeEach 清空 tool
// registry（draft-writer 走「工具环境不可用 → legacy 降级直写」单发路径，generate 单发），
// writer 双档 describe 在 beforeEach 清空后重注册 builtin（两阶段路径），runtime 级 describe
// 在 afterEach 重置静态 taskModelRouting resolver + vi.resetModules。任一执行序均确定性。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// CR-002 + 链流程重排 W1d：装配行档位钉死——包装（透传 + 记录）各 LLM 装配行工厂，直接断言
// createChapterChainNodes 传给各工厂的 deps.modelRef = 档位表（R1b 细档：revision-guard /
// multi-review / route-judge / plan-review；optimizer=review-judge 现状档；writer-draft / extraction）。
// vi.fn(actual) 生产行为零变化（describe 1/2 的链装配照常），只新增调用记录——装配行写错档位在
// 链 e2e 里与「共用同一 llmDepsFor 表达式的正确档位」表象相同，只有工厂实收参数能抓。
vi.mock('../src/nodes/chapter-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nodes/chapter-nodes')>();
  return {
    ...actual,
    createRevisionGuardNode: vi.fn(actual.createRevisionGuardNode),
    createReaderAuditNode: vi.fn(actual.createReaderAuditNode),
    createRouteNode: vi.fn(actual.createRouteNode),
  };
});
vi.mock('../src/nodes/completeness-verify-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nodes/completeness-verify-node')>();
  return { ...actual, createCompletenessVerifyNode: vi.fn(actual.createCompletenessVerifyNode) };
});
vi.mock('../src/nodes/brief-reviewer-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nodes/brief-reviewer-node')>();
  return { ...actual, createBriefReviewerNode: vi.fn(actual.createBriefReviewerNode) };
});
vi.mock('../src/nodes/revision-optimizer-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nodes/revision-optimizer-node')>();
  return { ...actual, createRevisionOptimizerNode: vi.fn(actual.createRevisionOptimizerNode) };
});
vi.mock('../src/nodes/promise-emergence-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nodes/promise-emergence-node')>();
  return { ...actual, createPromiseEmergenceNode: vi.fn(actual.createPromiseEmergenceNode) };
});
vi.mock('../src/nodes/arc-emergence-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nodes/arc-emergence-node')>();
  return { ...actual, createArcEmergenceNode: vi.fn(actual.createArcEmergenceNode) };
});

/** slot 回声 resolver：每档返回 modelId=slot-<slot> 的 ref——断言按 modelId 反查档位。 */
const echoResolver: ChainSlotResolver = (slot) => ({ keyId: 'wire', modelId: `slot-${slot}` });

/** 取第 i 次 generate 调用实收的 opts.modelRef（R4 红线：单捕获参数）。 */
function modelRefAt(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  i: number,
): { keyId: string; modelId: string } | undefined {
  return generate.mock.calls[i]?.[4]?.modelRef;
}

// ═════════════════════════════════════════════════════════════════════════════
// 0b. S4b 思考策略接线（task 08-25 design §1.2/§2）：assignment 整体随档——
//     generate 实收 thinking（assignmentThinkingControl 归一：custom 优先 / 非 auto
//     档位 {level} / 都无 undefined=auto 不注入）。R4 红线同款：钉 mock generate 第 5 参
//     实收值；「接线漏了」与「用户没配思考」同样不可观测区分。
// ═════════════════════════════════════════════════════════════════════════════

/** 取第 i 次 generate 调用实收的 opts.thinking。 */
function thinkingAt(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  i: number,
): { level: string; custom?: string } | undefined {
  return generate.mock.calls[i]?.[4]?.thinking;
}

describe('S4b 接线 — 思考策略随档（chapter-chain llmDepsFor.thinking，design §1.2/§2）', () => {
  beforeEach(() => {
    registry.__clearForTest();
  });

  it('各档配 thinking:high → 全部 generate 实收 {level:"high"}；配 thinkingCustom → {level:"custom",custom}', async () => {
    // 档位差异化：extraction=custom（数值型预算字串）、审核族全档（粗 review-judge + R1b 细档
    // plan-review/multi-review/route-judge/revision-guard）=high、writer-draft=low。
    const REVIEW_LINEAGE: TaskModelSlot[] = ['review-judge', 'plan-review', 'multi-review', 'route-judge', 'revision-guard'];
    const resolver: ChainSlotResolver = (slot) => {
      const base = { keyId: 'wire', modelId: `slot-${slot}` };
      if (slot === 'extraction') return { ...base, thinkingCustom: '8192' };
      if (REVIEW_LINEAGE.includes(slot)) return { ...base, thinking: 'high' as const };
      if (slot === 'writer-draft') return { ...base, thinking: 'low' as const };
      return base;
    };
    const generate = makeE2eGenerate();
    const session = makeSession();
    const snapshot = await runChain(
      { chain: createChapterChainNodes(generate, resolver, session), initialArtifacts: makeInitialArtifacts(), requirement: '' },
      { generate, sessionContext: session, signal: new AbortController().signal },
    );

    expect(snapshot.status).toBe('completed');
    for (let i = 0; i < generate.mock.calls.length; i += 1) {
      const sys = generate.mock.calls[i][1] ?? '';
      const slot = expectedSlotForSystem(sys);
      if (slot === 'extraction') {
        expect(thinkingAt(generate, i), `call#${i}（extraction 档）`).toEqual({ level: 'custom', custom: '8192' });
      } else if (REVIEW_LINEAGE.includes(slot as TaskModelSlot)) {
        expect(thinkingAt(generate, i), `call#${i}（${slot} 档）`).toEqual({ level: 'high' });
      } else {
        expect(thinkingAt(generate, i), `call#${i}（writer-draft 档）`).toEqual({ level: 'low' });
      }
    }
  });

  it('thinking 未配 / 显式 auto → 实收 undefined（零行为变化回归门）', async () => {
    // 档位显式 'auto'（= 不注入，与缺省同义）+ 无任何 thinking 字段的档混排。
    const resolver: ChainSlotResolver = (slot) =>
      slot === 'review-judge'
        ? { keyId: 'wire', modelId: `slot-${slot}`, thinking: 'auto' as const }
        : { keyId: 'wire', modelId: `slot-${slot}` };
    const generate = makeE2eGenerate();
    const session = makeSession();
    await runChain(
      { chain: createChapterChainNodes(generate, resolver, session), initialArtifacts: makeInitialArtifacts(), requirement: '' },
      { generate, sessionContext: session, signal: new AbortController().signal },
    );

    for (let i = 0; i < generate.mock.calls.length; i += 1) {
      expect(thinkingAt(generate, i), `call#${i}`).toBeUndefined();
    }
  });
});

describe('S4b 接线 — writer 双档思考策略不杂交（selfcheck assignment 整体，design §1.2）', () => {
  let dir = '';

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orison-wire-writer-think-'));
    registry.__clearForTest();
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();
    setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
  });

  afterEach(() => {
    rmBestEffort(dir);
    setTaskSlotResolver(undefined);
    setExecuteToolFn(undefined);
  });

  it('selfcheck={low} / draft={high} → Phase1+核实器收 low、Phase2+2.5 收 high（不出现模型与策略错配）', async () => {
    setTaskSlotResolver((slot) => {
      if (slot === 'writer-selfcheck') return { keyId: 'wire', modelId: 'slot-writer-selfcheck', thinking: 'low' as const };
      if (slot === 'writer-draft') return { keyId: 'wire', modelId: 'slot-writer-draft', thinking: 'high' as const };
      return undefined;
    });
    const generate = twoPhaseGenerate();
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    const session: SessionState = {
      id: 'sess-wire-think', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const node = createChapterChainNodes(generate, (s) => resolveTaskModel(s), session)
      .find((c) => c.id === 'draft-writer-agent')!.node;

    const result = await node.run(writerRunInput(dir));
    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(4);
    // 模型锚（R4 红线不破）+ 思考锚同位：assignment 整体随档。
    expect(modelRefAt(generate, 0)).toEqual({ keyId: 'wire', modelId: 'slot-writer-selfcheck' });
    expect(modelRefAt(generate, 1)).toEqual({ keyId: 'wire', modelId: 'slot-writer-selfcheck' });
    expect(modelRefAt(generate, 2)).toEqual({ keyId: 'wire', modelId: 'slot-writer-draft' });
    expect(modelRefAt(generate, 3)).toEqual({ keyId: 'wire', modelId: 'slot-writer-draft' });
    expect(thinkingAt(generate, 0)).toEqual({ level: 'low' });
    expect(thinkingAt(generate, 1)).toEqual({ level: 'low' });
    expect(thinkingAt(generate, 2)).toEqual({ level: 'high' });
    expect(thinkingAt(generate, 3)).toEqual({ level: 'high' });
  });

  it('软回退取整 assignment：只配 draft={max} → 自查轮跟随 draft 思考策略（selfcheck ?? draft 不杂交）', async () => {
    setTaskSlotResolver((slot) =>
      slot === 'writer-draft'
        ? { keyId: 'wire', modelId: 'slot-writer-draft', thinking: 'max' as const }
        : undefined,
    );
    const generate = twoPhaseGenerate();
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    const session: SessionState = {
      id: 'sess-wire-think2', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const node = createChapterChainNodes(generate, (s) => resolveTaskModel(s), session)
      .find((c) => c.id === 'draft-writer-agent')!.node;

    await node.run(writerRunInput(dir));
    for (let i = 0; i < 4; i += 1) {
      expect(thinkingAt(generate, i), `call#${i}`).toEqual({ level: 'max' });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. 链 e2e：装配行 slot 映射（review-judge / extraction / writer-draft·legacy 路径）
//    —— mirror chain-e2e.test.ts happy-path fixture（route 首判 accept，10 generate 调用）。
// ═════════════════════════════════════════════════════════════════════════════

const TARGET_EPISODE = 'ep2';

function makeSession(): SessionState {
  return {
    id: 'sess_wire_e2e',
    agentName: 'chapter-chain',
    projectPath: '/test/wiring-e2e',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeInitialArtifacts(): Record<string, unknown> {
  return {
    scene_graph: {
      nodes: [],
      edges: [],
      lines: [],
      art_overrides: [],
      version: 0,
      updatedBy: 'agent',
    },
    episode_outlines: [
      episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
      episodeOutlineSchema.parse({ id: TARGET_EPISODE, index: 1, title: '第二章' }),
    ],
    settings_context: '世界观：灵气复苏的现代都市。',
    chapter_brief_input: {
      episodeId: TARGET_EPISODE,
      brief: { goal: '主角抵达 B 城', tone: '紧迫' },
    },
    promise_registry: { promises: [], beats: [], version: 0 },
  };
}

const INITIAL_DRAFT = {
  title: '第二章 B 城',
  text: '黄昏的荒野上，主角深吸一口气。INITIAL_DRAFT_MARKER',
  wordCount: 2800,
  chapterId: TARGET_EPISODE,
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
  ],
  reasons: ['主角动机铺垫不足'],
};

/** mock generate：按 yaml system 段标记区分节点返 fixture（mirror chain-e2e makeE2eGenerate）。 */
function makeE2eGenerate() {
  return vi.fn<GenerateFn>(async (_msgs, sys): Promise<GenerateResult> => {
    const s = sys ?? '';
    if (s.includes('规划审核')) {
      return { content: JSON.stringify({ verdict: 'pass', summary: '卡可写', findings: [] }), finishReason: 'stop' };
    }
    if (s.includes('路由判决')) {
      return { content: JSON.stringify({ decision: 'accept_as_truth', reason: '正文达标' }), finishReason: 'stop' };
    }
    if (s.includes('改稿意图编译器')) {
      return {
        content: JSON.stringify({
          change: { summary: '补动机' },
          lockedItems: [],
          rationale: { source: 'audit-finding', note: 'A-trigger' },
          provenance: { rawUserInstruction: '据 findings 修订', compilerNote: 'C1' },
        }),
        finishReason: 'stop',
      };
    }
    if (s.includes('完整性审核')) {
      return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
    }
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
      return { content: JSON.stringify(REVIEW_RESULT), finishReason: 'stop' };
    }
    if (s.includes('状态提取')) {
      return {
        content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }),
        finishReason: 'stop',
      };
    }
    if (s.includes('story-sync-agent')) {
      return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
    }
    return { content: JSON.stringify(INITIAL_DRAFT), finishReason: 'stop' };
  });
}

/**
 * system 标记 → 期望档位（design §2 表 + R1b 细档，逐节点核对）。e2e happy-path 的 11 调用分布：
 * brief-reviewer(1) → plan-review；draft-writer(legacy 降级直写,1) → writer-draft；
 * world-extractor(5) + story-sync(1) → extraction；multi-review(1) + completeness(1) → multi-review
 *（completeness 并 multi-review 档，同族不碎片化）；route(1) → route-judge。
 * （promise/arc-emergence 在本 fixture 无候选不触发 L2；revision-optimizer 首圈 no-op 零调用；
 *  revision-guard 整章路径 pass-through——它们的档位由 CR-002 describe 工厂捕获法钉死。）
 */
function expectedSlotForSystem(sys: string): string {
  if (sys.includes('规划审核')) return 'plan-review';
  if (sys.includes('改稿意图编译器')) return 'review-judge'; // optimizer 现状粗档（未细拆）
  if (sys.includes('路由判决')) return 'route-judge';
  if (sys.includes('完整性审核')) return 'multi-review';
  if (sys.includes('Reader-Audit') || sys.includes('多维度') || sys.includes('审核')) return 'multi-review';
  if (sys.includes('状态提取')) return 'extraction';
  if (sys.includes('story-sync-agent')) return 'extraction';
  return 'writer-draft'; // draft-writer legacy 降级直写（默认分支）
}

describe('S4 接线 — 链装配 slot 映射（chapter-chain llmDepsFor，design §2 表）', () => {
  beforeEach(() => {
    // CR-010：显式清空 registry——draft-writer 走「工具环境不可用 → legacy 降级直写」
    // 单发路径（generate 单发）。本 describe 不再依赖「先于 registerBuiltinTools 跑」的
    // 文件级顺序约定：任一执行序下装配形态均确定。
    registry.__clearForTest();
  });

  it('配齐档位 → 每个 generate 调用实收所属节点档位的 modelRef（锚点：plan-review×1 / writer-draft×1 / multi-review×2 / route-judge×1 / extraction×6）', async () => {
    const generate = makeE2eGenerate();
    const session = makeSession();
    const snapshot: RunSnapshot = await runChain(
      {
        chain: createChapterChainNodes(generate, echoResolver, session),
        initialArtifacts: makeInitialArtifacts(),
        requirement: '',
      },
      { generate, sessionContext: session, signal: new AbortController().signal },
    );

    // 链跑通（route 首判 accept → 提取段跑完）——档位路由零行为影响。
    expect(snapshot.status).toBe('completed');
    expect(generate.mock.calls.length).toBe(11);

    const slotCounts: Record<string, number> = {};
    for (let i = 0; i < generate.mock.calls.length; i += 1) {
      const sys = generate.mock.calls[i][1] ?? '';
      const slot = expectedSlotForSystem(sys);
      slotCounts[slot] = (slotCounts[slot] ?? 0) + 1;
      expect(
        modelRefAt(generate, i),
        `call#${i}（system 段判为 ${slot}）应收 ${`slot-${slot}`} 档 ref`,
      ).toEqual({ keyId: 'wire', modelId: `slot-${slot}` });
    }
    // 锚点覆盖计数（R4 红线：每档至少一个锚点在此钉死）。
    expect(slotCounts).toEqual({ 'plan-review': 1, 'writer-draft': 1, 'multi-review': 2, 'route-judge': 1, extraction: 6 });
  });

  it('未传 resolver（未配置任何档）→ 全部调用 modelRef=undefined（default 哨兵自动选择 = 现状回归门）', async () => {
    const generate = makeE2eGenerate();
    const session = makeSession();
    const snapshot = await runChain(
      {
        chain: createChapterChainNodes(generate, undefined, session),
        initialArtifacts: makeInitialArtifacts(),
        requirement: '',
      },
      { generate, sessionContext: session, signal: new AbortController().signal },
    );

    expect(snapshot.status).toBe('completed');
    expect(generate.mock.calls.length).toBe(11);
    for (let i = 0; i < generate.mock.calls.length; i += 1) {
      expect(modelRefAt(generate, i), `call#${i}`).toBeUndefined();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. writer 双档分离（生产装配形态：createChapterChainNodes + registerBuiltinTools，
//    mirror writer-node.test.ts CR-001 describe 的 harness）。
//    本 describe 在 beforeEach 清空后重注册 builtin（两阶段路径的自带隔离，CR-010——
//    与链 e2e describe 的执行先后无约定）。
// ═════════════════════════════════════════════════════════════════════════════

const VALID_BRIEF: ResearchBrief = {
  plan: '先城门对峙再入城收束，节奏前紧后松',
  entries: [
    {
      ref: 'char-lin',
      kind: 'asset',
      key_facts: [{ fact: '林昭左臂旧伤未愈', source: '人物卡 char-lin' }],
    },
  ],
  issues: [],
  execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙节拍', notes: '短句提速' }],
  deviations: [],
};

const VALID_DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' };

const VALID_DECLARATION = {
  synopsis: '林昭与江白在城门分手后各自遇袭，双双负伤入城。',
  present: [{ name: '林昭' }],
  mentioned: [{ name: '江白' }],
};

function textRound(content: string): GenerateResult {
  return { content, finishReason: 'stop' };
}

function passVerdictJson(): string {
  return `${JSON.stringify({
    checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
    pass: true,
    gaps: [],
    suggestions: [],
    archive_issues: [],
  })}\n<VERIFICATION_VERDICT_READY>`;
}

/** 标准两阶段脚本：① Phase1 简报 → ② 核实器 verdict → ③ Phase2 正文 → ④ 2.5 申报。 */
function twoPhaseGenerate(): ReturnType<typeof vi.fn<GenerateFn>> {
  return vi
    .fn<GenerateFn>()
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
    .mockResolvedValueOnce(textRound(passVerdictJson()))
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
}

function writerRunInput(projectPath: string) {
  return {
    run: {
      runId: 'run_wire_writer',
      status: 'running',
      currentNodeId: null,
      projectPath,
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        chapter_brief: { goal: '抵达 B 城' },
        chapter_brief_input: { episodeId: 'ep-wire', brief: { goal: '抵达 B 城' } },
        scene_graph: { nodes: [] },
        settings_context: '设定前缀文本',
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    } satisfies RunSnapshot,
    requirement: '',
  };
}

describe('S4 接线 — writer 双档分离（生产装配形态，writer-selfcheck vs writer-draft）', () => {
  let dir = '';

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orison-wire-writer-'));
    // CR-010：先清空再重注册（beforeEach 重建）——两阶段路径（工具环境可用）不依赖执行序。
    registry.__clearForTest();
    // 生产装配的写手/核实器用默认 resolveTool（builtin registry）——注册 + stub 执行 seam
    // （mirror writer-node.test.ts CR-001 beforeEach；afterEach 配对还原见 CR-24）。
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();
    setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
  });

  afterEach(() => {
    rmBestEffort(dir);
    setTaskSlotResolver(undefined);
    setExecuteToolFn(undefined);
  });

  /** 生产装配链的 draft-writer 节点（slot resolver 注入形态）。 */
  async function makeAssembledWriter(
    generate: ReturnType<typeof vi.fn<GenerateFn>>,
    resolveSlot: ChainSlotResolver | undefined,
  ): Promise<import('../src/contracts/run').AgentNode> {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    const session: SessionState = {
      id: 'sess-wire-writer', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const chain = createChapterChainNodes(generate, resolveSlot, session);
    return chain.find((c) => c.id === 'draft-writer-agent')!.node;
  }

  it('双档分离：Phase1 自查+补查与核实器收 writer-selfcheck 档，Phase2 写作与 2.5 申报收 writer-draft 档', async () => {
    const generate = twoPhaseGenerate();
    const node = await makeAssembledWriter(generate, echoResolver);

    const result = await node.run(writerRunInput(dir));
    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(4);
    // 四次 generate 的模型来源逐轮钉死（design §2：Phase1/核实 = selfcheck；Phase2/2.5 = draft）。
    expect(modelRefAt(generate, 0)).toEqual({ keyId: 'wire', modelId: 'slot-writer-selfcheck' }); // 写手阶段一自查
    expect(modelRefAt(generate, 1)).toEqual({ keyId: 'wire', modelId: 'slot-writer-selfcheck' }); // 资料员核实子循环
    expect(modelRefAt(generate, 2)).toEqual({ keyId: 'wire', modelId: 'slot-writer-draft' }); // 写手阶段二写作
    expect(modelRefAt(generate, 3)).toEqual({ keyId: 'wire', modelId: 'slot-writer-draft' }); // 写手 2.5 申报轮
  });

  it('生产闭包形态（(slot)=>resolveTaskModel(slot)）：selfcheck 配档生效、draft 空档回 undefined 自动选择', async () => {
    // 钉 workflow.ts 链装配注入的生产闭包语义（会话模型机制已退役，拍板 #5）：resolver 只配了
    // writer-selfcheck → Phase1/核实器收槽位 ref；writer-draft 空档 → Phase2/2.5 收 undefined
    // （provider default 哨兵 → shell 自动选择）。
    setTaskSlotResolver((slot) =>
      slot === 'writer-selfcheck' ? { keyId: 'wire', modelId: 'slot-writer-selfcheck' } : undefined,
    );
    const generate = twoPhaseGenerate();
    const node = await makeAssembledWriter(generate, (slot) => resolveTaskModel(slot));

    const result = await node.run(writerRunInput(dir));
    expect(result.stateKey).toBe('draft.initial');
    expect(modelRefAt(generate, 0)).toEqual({ keyId: 'wire', modelId: 'slot-writer-selfcheck' });
    expect(modelRefAt(generate, 1)).toEqual({ keyId: 'wire', modelId: 'slot-writer-selfcheck' });
    expect(modelRefAt(generate, 2)).toBeUndefined(); // draft 空档 → 自动选择
    expect(modelRefAt(generate, 3)).toBeUndefined();
  });

  it('软回退链（design §2）：只配 writer-draft 时自查跟随 draft（Phase1/核实器也收 draft 档 ref）', async () => {
    // design §2 writer-selfcheck 档注：空档回退链 = selfcheck 槽 → writer-draft 档 → 自动选择。
    // 只配 draft 时 selfcheckModelRef 落 ?? deps.modelRef（= draft 档 ref）——保「两阶段同模型」
    // 既有默认（S5 定案），配 draft 不配 selfcheck 时自查跟随。
    setTaskSlotResolver((slot) =>
      slot === 'writer-draft' ? { keyId: 'wire', modelId: 'slot-writer-draft' } : undefined,
    );
    const generate = twoPhaseGenerate();
    const node = await makeAssembledWriter(generate, (slot) => resolveTaskModel(slot));

    const result = await node.run(writerRunInput(dir));
    expect(result.stateKey).toBe('draft.initial');
    // 四轮全收 draft 档 ref（Phase1/核实器经回退链、Phase2/2.5 经本档）。
    for (let i = 0; i < 4; i += 1) {
      expect(modelRefAt(generate, i), `call#${i}`).toEqual({ keyId: 'wire', modelId: 'slot-writer-draft' });
    }
  });

  it('未配置任何档 → 四轮全收 undefined（provider 哨兵自动选择，现状回归门）', async () => {
    const generate = twoPhaseGenerate();
    const node = await makeAssembledWriter(generate, (slot) => resolveTaskModel(slot));

    await node.run(writerRunInput(dir));
    for (const ref of generate.mock.calls.map((_c, i) => modelRefAt(generate, i))) {
      expect(ref).toBeUndefined();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2b. CR-002 + W1d：装配行档位钉死（工厂捕获法）——revision-guard（revision-guard 细档）/
//     brief-reviewer（plan-review）/ revision-optimizer（review-judge 现状档）/ multi-review
//     （multi-review）/ completeness（multi-review 并档）/ route（route-judge）/ promise-emergence
//     （extraction）/ arc-emergence（extraction）。部分装配行在链 e2e fixture 里不触发 LLM（guard
//     整章路径 pass-through / optimizer 首圈 no-op / promise-arc 无候选不跑 L2），档位写错在 e2e
//     无表象。文件头 module mock 把各工厂包成透传 vi.fn——直接断言工厂**实收 deps.modelRef**。
// ═════════════════════════════════════════════════════════════════════════════

describe('S4 接线 — CR-002/W1d 装配行工厂实收档位（deps.modelRef 逐工厂钉死）', () => {
  const guardSpy = vi.mocked(createRevisionGuardNode);
  const briefReviewerSpy = vi.mocked(createBriefReviewerNode);
  const optimizerSpy = vi.mocked(createRevisionOptimizerNode);
  const readerAuditSpy = vi.mocked(createReaderAuditNode);
  const completenessSpy = vi.mocked(createCompletenessVerifyNode);
  const routeSpy = vi.mocked(createRouteNode);
  const promiseSpy = vi.mocked(createPromiseEmergenceNode);
  const arcSpy = vi.mocked(createArcEmergenceNode);

  beforeEach(() => {
    registry.__clearForTest();
    guardSpy.mockClear();
    briefReviewerSpy.mockClear();
    optimizerSpy.mockClear();
    readerAuditSpy.mockClear();
    completenessSpy.mockClear();
    routeSpy.mockClear();
    promiseSpy.mockClear();
    arcSpy.mockClear();
  });

  function makeFactorySession(): SessionState {
    return {
      id: 'sess-wire-factories', agentName: 'chapter-chain', projectPath: '/test/wiring-factories',
      status: 'idle', messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
  }

  it('配齐档位 → 各工厂各自实收所属档位的 modelRef（细档勾反可抓——echoResolver 直返 slot-<slot>）', () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '{}', finishReason: 'stop' }));
    createChapterChainNodes(generate, echoResolver, makeFactorySession());

    // 各工厂恰装配一次，实收 deps.modelRef = 所属档位 ref（R1b 细档 + optimizer 现状粗档）。
    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-revision-guard' });
    // 细档勾反（回落粗档 review-judge / 错挂 writer-draft）是链 e2e 抓不到的静默面——互斥断言钉死。
    expect(guardSpy.mock.calls[0][0].modelRef).not.toEqual({ keyId: 'wire', modelId: 'slot-review-judge' });

    expect(briefReviewerSpy).toHaveBeenCalledTimes(1);
    expect(briefReviewerSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-plan-review' });
    expect(briefReviewerSpy.mock.calls[0][0].modelRef).not.toEqual({ keyId: 'wire', modelId: 'slot-review-judge' });

    expect(optimizerSpy).toHaveBeenCalledTimes(1);
    // optimizer 维持现状粗档 review-judge（意图编译归审核族未细拆——回落 review-judge 语义）。
    expect(optimizerSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-review-judge' });

    expect(readerAuditSpy).toHaveBeenCalledTimes(1);
    expect(readerAuditSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-multi-review' });
    expect(readerAuditSpy.mock.calls[0][0].modelRef).not.toEqual({ keyId: 'wire', modelId: 'slot-review-judge' });

    // completeness 并 multi-review 档（审核族同族不碎片化，design §1）。
    expect(completenessSpy).toHaveBeenCalledTimes(1);
    expect(completenessSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-multi-review' });

    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(routeSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-route-judge' });
    expect(routeSpy.mock.calls[0][0].modelRef).not.toEqual({ keyId: 'wire', modelId: 'slot-review-judge' });

    expect(promiseSpy).toHaveBeenCalledTimes(1);
    expect(promiseSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-extraction' });

    expect(arcSpy).toHaveBeenCalledTimes(1);
    expect(arcSpy.mock.calls[0][0].modelRef).toEqual({ keyId: 'wire', modelId: 'slot-extraction' });
  });

  it('未传 resolver → 各工厂 deps.modelRef 全 undefined（自动选择回归门）', () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '{}', finishReason: 'stop' }));
    createChapterChainNodes(generate, undefined, makeFactorySession());

    for (const factory of [guardSpy, briefReviewerSpy, optimizerSpy, readerAuditSpy, completenessSpy, routeSpy, promiseSpy, arcSpy]) {
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0][0].modelRef).toBeUndefined();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. dispatch / dialogue / extraction(runBackfill) 三档（runtime 级：createWorkflowRuntime
//    闭包接线，mirror runAgentWithExplicitSystem.test.ts + batch-message-stamp.test.ts harness）。
// ═════════════════════════════════════════════════════════════════════════════

async function makeRuntimeAndResolver(generate: ReturnType<typeof vi.fn<GenerateFn>>, projectPath: string) {
  const { createWorkflowRuntime } = await import('../src/runtime/workflow');
  const { setTaskSlotResolver: inject } = await import('../src/runtime/taskModelRouting');
  const runtime = createWorkflowRuntime({ generate });
  const session = runtime.createSession({ agentName: 'writer', projectPath });
  return { runtime, inject, session };
}

describe('S4 接线 — dispatch 档（workflow.ts:491 派发单点按 agentName 查表）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-wire-dispatch-'));
  });

  afterEach(async () => {
    // CR-010：先重置静态 taskModelRouting resolver（本 describe 首 test 的动态 import 在
    // 任何 resetModules 之前与静态 import 同实例——注入不清会渗入 writer describe 的
    // 「未配置任何档」回归门），然后才 resetModules 换新模块图。
    setTaskSlotResolver(undefined);
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('director-agent（dispatch 族）→ generate 实收 dispatch 档 ref；adjudicator-agent → route-judge 档 ref（09-13 R1b 迁档）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '{"ok":true}', finishReason: 'stop' }));
    const { runtime, inject, session } = await makeRuntimeAndResolver(generate, projectPath);
    inject((slot) => (slot === 'dispatch' || slot === 'route-judge'
      ? { keyId: 'wire', modelId: `slot-${slot}` }
      : undefined));

    await runtime.runAgentWithExplicitSystem(session.id, 'director-agent', {}, {});
    expect(generate).toHaveBeenCalledTimes(1);
    expect(modelRefAt(generate, 0)).toEqual({ keyId: 'wire', modelId: 'slot-dispatch' });

    generate.mockClear();
    await runtime.runAgentWithExplicitSystem(session.id, 'adjudicator-agent', {}, {});
    expect(generate).toHaveBeenCalledTimes(1);
    expect(modelRefAt(generate, 0)).toEqual({ keyId: 'wire', modelId: 'slot-route-judge' });
  });

  it('adjudicator-agent 细档未配 → 回落 review-judge 档 ref（fine ?? review-judge 接线面，09-13 R1b）', async () => {
    // 只配 review-judge：adjudicator 映射 route-judge 细档未配 → 经 resolveTaskModel
    // 回落链落到 review-judge 档 assignment（镜像生产闭包 `(slot)=>resolveTaskModel(slot)`）。
    const generate = vi.fn<GenerateFn>(async () => ({ content: '{"ok":true}', finishReason: 'stop' }));
    const { runtime, inject, session } = await makeRuntimeAndResolver(generate, projectPath);
    inject((slot) => (slot === 'review-judge' ? { keyId: 'wire', modelId: 'slot-review-judge' } : undefined));

    await runtime.runAgentWithExplicitSystem(session.id, 'adjudicator-agent', {}, {});
    expect(generate).toHaveBeenCalledTimes(1);
    expect(modelRefAt(generate, 0)).toEqual({ keyId: 'wire', modelId: 'slot-review-judge' });
  });

  it('未知名（不在 YAML_AGENT_SLOT）→ undefined（自动选择；防新 yaml agent 静默落错档）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '{"ok":true}', finishReason: 'stop' }));
    const { runtime, inject, session } = await makeRuntimeAndResolver(generate, projectPath);
    inject(() => ({ keyId: 'wire', modelId: 'slot-dispatch' })); // 全档配置也不影响未知名

    await runtime.runAgentWithExplicitSystem(session.id, 'retrieval-agent', {}, {});
    expect(generate).toHaveBeenCalledTimes(1);
    expect(modelRefAt(generate, 0)).toBeUndefined(); // 未知名不路由 → provider default 哨兵自动选择
  });

  it('未配置任何档 → 派发收 undefined（自动选择，现状回归门）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '{"ok":true}', finishReason: 'stop' }));
    const { runtime, session } = await makeRuntimeAndResolver(generate, projectPath);

    await runtime.runAgentWithExplicitSystem(session.id, 'director-agent', {}, {});
    expect(modelRefAt(generate, 0)).toBeUndefined();
  });
});

describe('S4 接线 — dialogue 档（leader runLoop，sendMessage 车道）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-wire-dialogue-'));
  });

  afterEach(async () => {
    // CR-010：先重置静态 taskModelRouting resolver（本 describe 首 test 的动态 import 在
    // 任何 resetModules 之前与静态 import 同实例——注入不清会渗入 writer describe 的
    // 「未配置任何档」回归门），然后才 resetModules 换新模块图。
    setTaskSlotResolver(undefined);
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('配 dialogue 档 → leader 对话轮 generate 实收槽位 ref；未配 → undefined（自动选择）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: 'ok', finishReason: 'stop' }));
    const { runtime, inject, session } = await makeRuntimeAndResolver(generate, projectPath);

    // 未配置 → undefined（provider 哨兵自动选择，现状回归门）。
    await runtime.sendMessage({ sessionId: session.id, content: 'hi', abortSignal: new AbortController().signal });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(modelRefAt(generate, 0)).toBeUndefined();

    // 配 dialogue 档 → 槽位 ref。CR-003：turn 入口解析一次、const 捕获——下一 turn 生效；
    // 单轮内改档不渗入进行中的轮（mirror 退役前 pendingModelRef 的防 in-flight 语义）。
    generate.mockClear();
    inject((slot) => (slot === 'dialogue' ? { keyId: 'wire', modelId: 'slot-dialogue' } : undefined));
    await runtime.sendMessage({ sessionId: session.id, content: '再来一轮', abortSignal: new AbortController().signal });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(modelRefAt(generate, 0)).toEqual({ keyId: 'wire', modelId: 'slot-dialogue' });
  });
});

describe('S4 接线 — extraction 档（runBackfill 旧章 5 轴补提取）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-wire-backfill-'));
    // 最小可补提取项目：1 episode ↔ 1 已注册章 ↔ 1 prose 文件。
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, 'chapters', 'ch_001.md'), '第一章正文：城门对峙。', 'utf8');
    const projectYaml = [
      'episode_outlines:',
      '  - id: ep1',
      '    index: 0',
      '    title: 第一章',
      'novel:',
      '  chapters:',
      '    - id: ch_001',
      '      title: 第一章',
      '      sort_order: 0',
      '      sections:',
      '        - id: sec1',
      '          sort_order: 0',
      '          content_file: chapters/ch_001.md',
      '',
    ].join('\n');
    writeFileSync(path.join(projectPath, 'project.yaml'), projectYaml, 'utf8');
    // write_world_events 未注册 → writer per-write throw 记 writeErrors（graceful）——不影响
    // 5 轴 extractor 的 generate 调用与 modelRef 断言（CR Fix 1 语义）。
  });

  afterEach(async () => {
    // CR-010：先重置静态 taskModelRouting resolver（本 describe 首 test 的动态 import 在
    // 任何 resetModules 之前与静态 import 同实例——注入不清会渗入 writer describe 的
    // 「未配置任何档」回归门），然后才 resetModules 换新模块图。
    setTaskSlotResolver(undefined);
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('配 extraction 档 → 5 轴补提取全部 generate 调用实收槽位 ref；未配 → undefined（自动选择）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }),
      finishReason: 'stop',
    }));

    // 未配置 → undefined（provider 哨兵自动选择）。
    {
      const { runtime, session } = await makeRuntimeAndResolver(generate, projectPath);
      const result = await runtime.runBackfill(session.id);
      expect(result.episodesProcessed).toBe(1);
      expect(generate).toHaveBeenCalledTimes(5); // 5 轴串行
      for (let i = 0; i < 5; i += 1) {
        expect(modelRefAt(generate, i), `call#${i}`).toBeUndefined();
      }
    }

    // 配 extraction 档 → 槽位 ref。
    generate.mockClear();
    {
      const { runtime, inject, session } = await makeRuntimeAndResolver(generate, projectPath);
      inject((slot) => (slot === 'extraction' ? { keyId: 'wire', modelId: 'slot-extraction' } : undefined));
      await runtime.runBackfill(session.id);
      expect(generate).toHaveBeenCalledTimes(5);
      for (let i = 0; i < 5; i += 1) {
        expect(modelRefAt(generate, i), `call#${i}`).toEqual({ keyId: 'wire', modelId: 'slot-extraction' });
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 09-12 agy provider：会话键接线（design §3.1 装配点②③——writer agent 循环 + 链 run）。
// 断言钉 mock generate 实收的 opts.sessionKey（mirror modelRefAt/thinkingAt 红线形态：
// 「接线漏了」与「没配会话」不可观测区分，唯一防线是行为级断言）：
//   - 循环消费者按逻辑会话命名空间分键（CR-21）：writer 两阶段实收
//     `chain:<childSessionId>:writer`、核实子循环实收 `chain:<id>:verify`——两循环不同键；
//   - 单发 llm-node 族结构性忽略（LlmNodeDeps 无此字段——chain e2e 全部 undefined）；
//   - makeAgentLoop 无 sessionKey → undefined（缺省零回归门）。
// ═════════════════════════════════════════════════════════════════════════════

describe('agy provider 接线 — 链 run 会话键（chapter-chain sessionKey）', () => {
  describe('writer 两阶段 + 核实循环（agent 循环消费者带键）', () => {
    let dir = '';

    beforeEach(async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'orison-wire-skey-'));
      registry.__clearForTest();
      const { registerBuiltinTools } = await import('../src/tool/builtin');
      registerBuiltinTools();
      setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
    });

    afterEach(() => {
      rmBestEffort(dir);
      setTaskSlotResolver(undefined);
      setExecuteToolFn(undefined);
    });

    it('4 轮 generate 分键（CR-21）：Phase1/Phase2/2.5 实收 chain:<id>:writer、核实器实收 chain:<id>:verify', async () => {
      setTaskSlotResolver(() => undefined);
      const generate = twoPhaseGenerate();
      const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
      const session: SessionState = {
        id: 'sess-wire-skey', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
        messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      const node = createChapterChainNodes(generate, (s) => resolveTaskModel(s), session)
        .find((c) => c.id === 'draft-writer-agent')!.node;

      await node.run(writerRunInput(dir));

      expect(generate).toHaveBeenCalledTimes(4);
      // 调用序（twoPhaseGenerate fixture）：#0 Phase1 自查简报（writer 循环）、#1 核实
      // verdict（verifier 循环）、#2 Phase2 写作、#3 阶段 2.5 出场申报（均 writer 循环）。
      const expectedKeys = [
        'chain:sess-wire-skey:writer',
        'chain:sess-wire-skey:verify',
        'chain:sess-wire-skey:writer',
        'chain:sess-wire-skey:writer',
      ];
      for (let i = 0; i < 4; i += 1) {
        expect(generate.mock.calls[i]?.[4]?.sessionKey, `call#${i}`).toBe(expectedKeys[i]);
      }
      // CR-21 红线：两循环不同键（同模型交替不再互踢冷重启）。
      expect(new Set(expectedKeys).size).toBe(2);
    });
  });

  describe('单发 llm-node 族（结构性忽略 = 单发冷路径）', () => {
    beforeEach(() => {
      registry.__clearForTest();
    });

    it('链 e2e（legacy 降级直写路径）：全部 generate 调用 sessionKey === undefined', async () => {
      const generate = makeE2eGenerate();
      const session = makeSession();
      const snapshot = await runChain(
        { chain: createChapterChainNodes(generate, echoResolver, session), initialArtifacts: makeInitialArtifacts(), requirement: '' },
        { generate, sessionContext: session, signal: new AbortController().signal },
      );
      expect(snapshot.status).toBe('completed');
      for (let i = 0; i < generate.mock.calls.length; i += 1) {
        expect(generate.mock.calls[i]?.[4]?.sessionKey, `call#${i}`).toBeUndefined();
      }
    });
  });

  describe('makeAgentLoop（装配点②接收面）', () => {
    it('deps.sessionKey → 每轮 generate opts 实收；缺省 → undefined（零回归门）', async () => {
      const { makeAgentLoop } = await import('../src/nodes/agent-loop');
      const generate = vi.fn<GenerateFn>(async () => ({
        content: '好的<STOP>', finishReason: 'stop',
      }));
      const loop = makeAgentLoop(
        { generate, sessionKey: 'chain:sess-x', projectPath: '/tmp/x' },
        {
          toolIds: [],
          systemPrompt: 'SYS',
          stablePrefix: [],
          stopMarkers: ['<STOP>'],
          maxRounds: 3,
          projectPath: '/tmp/x',
        },
      );
      const result = await loop({ userPrompt: '去' });
      expect(result.status).toBe('stopped');
      expect(generate).toHaveBeenCalled();
      for (let i = 0; i < generate.mock.calls.length; i += 1) {
        expect(generate.mock.calls[i]?.[4]?.sessionKey, `call#${i}`).toBe('chain:sess-x');
      }

      // 缺省：不带键（单发冷路径，零回归）。
      generate.mockClear();
      const loopNoKey = makeAgentLoop(
        { generate, projectPath: '/tmp/x' },
        {
          toolIds: [],
          systemPrompt: 'SYS',
          stablePrefix: [],
          stopMarkers: ['<STOP>'],
          maxRounds: 3,
          projectPath: '/tmp/x',
        },
      );
      await loopNoKey({ userPrompt: '去' });
      for (let i = 0; i < generate.mock.calls.length; i += 1) {
        expect(generate.mock.calls[i]?.[4]?.sessionKey, `call#${i}`).toBeUndefined();
      }

      // CR-23（'' 与 undefined 语义一致化）：'' 视同缺席——不进 generate opts。
      generate.mockClear();
      const loopEmptyKey = makeAgentLoop(
        { generate, sessionKey: '', projectPath: '/tmp/x' },
        {
          toolIds: [],
          systemPrompt: 'SYS',
          stablePrefix: [],
          stopMarkers: ['<STOP>'],
          maxRounds: 3,
          projectPath: '/tmp/x',
        },
      );
      await loopEmptyKey({ userPrompt: '去' });
      for (let i = 0; i < generate.mock.calls.length; i += 1) {
        expect(generate.mock.calls[i]?.[4]?.sessionKey, `call#${i}`).toBeUndefined();
      }
    });
  });
});
