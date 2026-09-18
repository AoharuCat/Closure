import { describe, expect, it, vi } from 'vitest';
import type { ReusableAgentNodeContract } from '@orison/shared-contracts';
import {
  runChain,
  summarizeRunSnapshot,
  resolveCheckpointStage,
  FINAL_CHECKPOINT_SUPPLEMENTED_KEY,
} from '../src/runtime/chainRunner';
import { ChainAbortedError, decideCheckpointPause, deriveCheckpointPolicy } from '../src/contracts/run';
import type {
  ChainNodeDef,
  CheckpointPolicy,
  CheckpointStage,
  RunChainDeps,
  RunChainOptions,
  RunSnapshot,
} from '../src/contracts/run';
import type { AgentNode, NodeResult } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.1/§4.3 / implement.md 4.4：runChain 驱动器（纯逻辑测，mock 节点 run()）。
//
// 核心断言（dispatch 4.4 列表）：
// 1. artifact 流转顺序（initial → 各节点 producedKey）
// 2. DAG 依赖缺失（requiredArtifactKeys 缺）→ blocked/error
// 3. revision 闭环（auto_revise → 重跑 from→through 切片；计数；cap 超限 → escalate）
// 4. accept_as_truth / escalate_user → 结束
// 5. 三 checkpoint stage 设点（onCheckpoint 被调，正确 stage）
// 6. error artifact（节点 mock 返 {artifact:{error:true}}）→ status='error' + break
// 7. abort（signal 已 abort）→ 抛 ChainAbortedError / checkpoint 保存
//
// 不涉真 generate/LLM——节点 run() 全 mock。GenerateFn 占位（mock 节点不调）。
// ─────────────────────────────────────────────────────────────────────────────

function makeSession(): SessionState {
  return {
    id: 'sess_test',
    agentName: 'test',
    projectPath: '/test/project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeDeps(signal: AbortSignal = new AbortController().signal): RunChainDeps {
  return {
    generate: vi.fn(async () => ({ content: '', finishReason: 'stop' })),
    sessionContext: makeSession(),
    signal,
  };
}

/** mock 节点：run() 返固定 artifact（或 fn(run) 动态产）。记录调用次数到 calls[id]。 */
function makeNode(
  id: string,
  stateKey: string,
  artifactOrFn: unknown | ((run: RunSnapshot) => unknown),
  calls: Record<string, number>,
  requiredArtifactKeys: string[] = [],
  checkpointStage?: CheckpointStage,
): ChainNodeDef {
  const contract: ReusableAgentNodeContract | null = {
    nodeId: id,
    displayName: id,
    inputSchemaName: `${id}_in`,
    outputSchemaName: `${id}_out`,
    requiredArtifactKeys,
    producedArtifactKeys: [stateKey],
    sideEffects: [],
  };
  const node: AgentNode = {
    contract,
    async run({ run }): Promise<NodeResult> {
      calls[id] = (calls[id] ?? 0) + 1;
      const artifact =
        typeof artifactOrFn === 'function'
          ? (artifactOrFn as (r: RunSnapshot) => unknown)(run)
          : artifactOrFn;
      return { stateKey, artifact };
    },
  };
  return { id, node, ...(checkpointStage ? { checkpointStage } : {}) };
}

/** route 节点 mock：按 decision 序列依次返（第 n 次调用返 decisions[n-1]）。 */
function makeRouteNode(
  id: string,
  decisions: string[],
  calls: Record<string, number>,
  requiredArtifactKeys: string[] = [],
  checkpointStage?: CheckpointStage,
): ChainNodeDef {
  const contract: ReusableAgentNodeContract | null = {
    nodeId: id,
    displayName: id,
    inputSchemaName: `${id}_in`,
    outputSchemaName: 'routeDecisionSchema',
    requiredArtifactKeys,
    producedArtifactKeys: ['route_decision'],
    sideEffects: ['call_model'],
  };
  let callIdx = 0;
  const node: AgentNode = {
    contract,
    async run() {
      calls[id] = (calls[id] ?? 0) + 1;
      const decision = decisions[Math.min(callIdx, decisions.length - 1)];
      callIdx += 1;
      return { stateKey: 'route_decision', artifact: { decision, reason: `mock ${decision}` } };
    },
  };
  return { id, node, ...(checkpointStage ? { checkpointStage } : {}) };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. artifact 流转顺序
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — artifact 流转', () => {
  it('initial artifacts → 各节点按序产出 producedKey，下游可读上游 artifact', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', (run) => ({ from: run.artifacts['scene_graph'] }), calls),
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        (run) => ({ title: 't', text: '正文', wordCount: 100, brief: run.artifacts['chapter_brief'] }),
        calls,
      ),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: { scene_graph: { nodes: ['s1'] } },
      requirement: 'ep1',
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
    expect((snapshot.artifacts['chapter_brief'] as { from: unknown }).from).toEqual({ nodes: ['s1'] });
    expect((snapshot.artifacts['draft.initial'] as { brief: unknown }).brief).toEqual({ from: { nodes: ['s1'] } });
    expect(snapshot.pendingNodes).toEqual([]);
  });

  it('initialArtifacts 浅拷贝（runChain 不改 opts.initialArtifacts 引用对象）', async () => {
    const initial = { scene_graph: { nodes: ['s1'] } };
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { ok: true }, calls),
    ];
    await runChain({ chain, initialArtifacts: initial, requirement: '' }, makeDeps());
    expect(initial.chapter_brief).toBeUndefined(); // 产物不回流到 opts.initialArtifacts
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. DAG 依赖缺失 → blocked
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — DAG 依赖缺失', () => {
  it('requiredArtifactKeys 缺失 → status=blocked + errors 记录 + break（后续节点不跑）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { ok: true }, calls),
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        { title: 't' },
        calls,
        ['chapter_brief', 'nonexistent_key'], // chapter_brief 有，nonexistent_key 缺
      ),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls), // 不应跑
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('blocked');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']); // draft-writer 未完成
    expect(snapshot.errors?.some((e) => e.includes('draft-writer-agent') && e.includes('nonexistent_key'))).toBe(true);
    expect(calls['multi-review-agent']).toBeUndefined(); // break 后不跑
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. revision 闭环
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — 链内回环（链流程重排 W1a：翻 7.4 候选④，不再 break 交 leader）', () => {
  // 链布局：brief(0) → targeted-revision(1, from) → multi-review(2) → route(3, through)
  // 切片 [from..through] = [1..3]，from<=through ✓（design §4.1 约束）
  function buildRevisionChain(
    routeDecisions: string[],
    calls: Record<string, number>,
  ): ChainNodeDef[] {
    return [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('targeted-revision-agent', 'revision.output', { title: '修订稿' }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeRouteNode('route-agent', routeDecisions, calls),
    ];
  }

  it('W1a：auto_revise → 链内回环（pointer 跳回 from 重跑环体）→ 第二判 accept 终态（无 auto_revise_pending）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'accept_as_truth'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
    };

    const snapshot = await runChain(opts, makeDeps());

    // 链内回环：环体各节点重跑 2 次（首轮 + 1 次回环），route 二判 accept → completed（不 break 交 leader）。
    expect(snapshot.status).toBe('completed');
    expect(calls['targeted-revision-agent']).toBe(2);
    expect(calls['multi-review-agent']).toBe(2);
    expect(calls['route-agent']).toBe(2);
    // brief 只跑一次（在环外——W1d 双环后归规划环 cap 管辖）
    expect(calls['brief-compiler-node']).toBe(1);
    // routeDecision 终态（第二判 accept——链内收敛后终态直达）
    expect(snapshot.artifacts['route_decision']).toEqual({ decision: 'accept_as_truth', reason: 'mock accept_as_truth' });
    // 完成态 currentNodeId null
    expect(snapshot.currentNodeId).toBeNull();
  });

  it('W1a：cap=0 → auto_revise 立即强制 escalate-pause（status=paused + escalatePause 标记 + errors 记 cap）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'auto_revise', 'auto_revise'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 0 }],
    };

    const snapshot = await runChain(opts, makeDeps());

    // cap=0：count(0) < cap(0) = false → 立即强制 escalate → escalate-pause（status='paused' + 标记）
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(calls['route-agent']).toBe(1);
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    expect(snapshot.errors?.some((e) => e.includes('cap') && e.includes('0'))).toBe(true);
    // currentNodeId 停 through 节点（paused 形态）
    expect(snapshot.currentNodeId).toBe('route-agent');
  });

  it('Story 4.6 D4（CR-Edge-1）：cap=0 强制 escalate + onAccept → 也调 onAccept 产 chapter_accept（对称 route-LLM escalate）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'auto_revise', 'auto_revise'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: 'cap 后稿' }, runId: snap.runId }),
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 0 }],
      onAccept,
    };

    const snapshot = await runChain(opts, makeDeps());

    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    // CR-Edge-1：cap-exceeded escalate 也调 onAccept（修与 route-LLM escalate 不对称）——escalate-pause 前产候选
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
  });

  it('环计数 cap 语义：cap=2 恰两次回环后第三判仍 auto_revise → 强制 escalate-pause', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise'], calls); // 恒 auto_revise
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 2 }],
    };

    const snapshot = await runChain(opts, makeDeps());

    // 首判 + 2 次回环重判 = route 3 次；第 3 次 auto_revise 时 count(2) == cap(2) → 强制 escalate-pause
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(calls['route-agent']).toBe(3);
    expect(calls['targeted-revision-agent']).toBe(3);
  });

  it('W1a M3：人审 redo 重入（resume 移除环体首节点）→ 环计数重置（新一轮 cap 预算）', async () => {
    // 第一轮：cap=1，route 恒 auto_revise → 1 次回环后第二判仍 auto_revise → cap 耗尽 escalate-pause。
    const callsA: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise'], callsA);
    const loops = [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 1 }];
    const first = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops },
      makeDeps(),
    );
    expect(first.status).toBe('paused');
    expect(first.escalatePause).toBe(true);
    expect(callsA['route-agent']).toBe(2); // 首判 + 1 回环重判

    // 模拟人审 redo 重入：移除环体节点出 completedNodes（prefix 断在环体首节点）→ 新 runChain 调用
    // → 环计数从 0 重新起算（M3：人已花注意力，重启预算——不跨人审累计）。
    const callsB: Record<string, number> = {};
    const chainB = buildRevisionChain(['auto_revise', 'accept_as_truth'], callsB);
    const resumed = await runChain(
      {
        chain: chainB,
        initialArtifacts: first.artifacts,
        requirement: '',
        loops,
        resumedCompletedNodes: ['brief-compiler-node'], // 人审 redo：环体节点全部移除重跑
      },
      makeDeps(),
    );
    // 新 runChain 调用 → cap 预算全新：1 次回环内二判 accept → completed（若计数未重置会被 cap=1 卡死）
    expect(resumed.status).toBe('completed');
    expect((resumed.artifacts['route_decision'] as { decision: string }).decision).toBe('accept_as_truth');
  });

  it('loops.from index > through index → 启动抛 config error', async () => {
    const calls: Record<string, number> = {};
    // from='route-agent'(3) > through='targeted-revision-agent'(1) → 违反切片约束
    const chain = buildRevisionChain(['auto_revise'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'route-agent', through: 'targeted-revision-agent', cap: 3 }],
    };

    await expect(runChain(opts, makeDeps())).rejects.toThrow(/must be <= through index/);
  });

  it('W1c 契约：optimizer_failed 信号在 → 失败圈 through 判决强制升级 escalate-pause（即使 route 判 accept）', async () => {
    const calls: Record<string, number> = {};
    // C1 位节点（环 from）：首圈成功编译；回环圈写 optimizer_failed 信号（模拟编译失败）。
    let c1Idx = 0;
    const optimizerNode: ChainNodeDef = {
      id: 'revision-optimizer-node',
      node: {
        contract: null,
        async run({ run }) {
          calls['revision-optimizer-node'] = (calls['revision-optimizer-node'] ?? 0) + 1;
          c1Idx += 1;
          if (c1Idx === 1) {
            return { stateKey: 'revision_intent', artifact: { change: { summary: 's' } } };
          }
          // 第二圈（route auto_revise 回环后）编译失败 → W1c 信号形态
          run.artifacts['optimizer_failed'] = { optimizer_failed: true, nodeId: 'revision-optimizer-node', message: 'LLM failed' };
          return { stateKey: 'optimizer_failed', artifact: { optimizer_failed: true, nodeId: 'revision-optimizer-node', message: 'LLM failed' } };
        },
      },
    };
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls),
      optimizerNode,
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeRouteNode('route-agent', ['auto_revise', 'accept_as_truth'], calls),
    ];

    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 3 }],
      },
      makeDeps(),
    );

    // 第一圈 route 判 auto_revise → 回环；第二圈 C1 编译失败 → route 判 accept 也不可信 → 强制
    // escalate-pause（R6① 永不假 pass）。
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.artifacts['route_decision']).toMatchObject({ decision: 'escalate_user' });
    expect(snapshot.errors?.some((e) => e.includes('optimizer_failed'))).toBe(true);
  });

  it('W1c 契约：圈作用域信号清理——resume-redo 重入后 C1 成功编译 → 陈旧 optimizer_failed 不误升级', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls),
      makeNode('revision-optimizer-node', 'revision_intent', { change: { summary: 's' } }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];

    // 模拟上一 run 的失败圈残留：artifacts 带陈旧 optimizer_failed（redo resume 读回）。
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {
          chapter_brief: { goal: 'g' },
          'draft.initial': { title: 't' },
          'review.latest': { verdict: 'revise' },
          optimizer_failed: { optimizer_failed: true, nodeId: 'revision-optimizer-node', message: 'stale' },
        },
        requirement: '',
        loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 3 }],
        // redo：draft-writer + C1 重跑（环 from 开跑时清陈旧信号）
        resumedCompletedNodes: ['brief-compiler-node'],
      },
      makeDeps(),
    );

    // C1 开跑清了陈旧信号 → route 判 accept 正常终态（不误升级）
    expect(snapshot.status).toBe('completed');
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('accept_as_truth');
    expect(snapshot.artifacts['optimizer_failed']).toBeUndefined();
  });

  it('loops.from / .through 不在 chain → 启动抛 config error', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['accept_as_truth'], calls);
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'nonexistent-from', through: 'route-agent', cap: 3 }],
    };

    await expect(runChain(opts, makeDeps())).rejects.toThrow(/not found in chain/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3b. 链流程重排 W1a：双环状态机（规划环 + 自审环并存）+ escalate-pause 双形态区分
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — 双环状态机（W1d 装配目标形态：loops 数组多环并存）', () => {
  /**
   * mock 双环链（W1d 新链骨架的最小机制子集——只测 chainRunner 环机制：计数 / escalate-pause /
   * 双环衔接；写手位为普通 mock 节点，生产装配写手在环体内 optimizer 紧后〔chapter-chain.ts 权威序〕，
   * 此处简化为 [optimizer(3) → multi-review(4) → route(5)] 三节点环体）：
   * A1 brief-compiler(0) → A2 brief-reviewer(1, 规划环 through，checkpointStage='brief') →
   * B draft-writer(2) → C1 revision-optimizer(3, 自审环 from) → multi-review(4)（环体中段占位）→
   * C7 route(5, 自审环 through) → E1 world-extractor(6)（提取段占位——route 后节点）。
   */
  function buildDualLoopChain(args: {
    planVerdicts: string[];
    routeDecisions: string[];
    calls: Record<string, number>;
  }): ChainNodeDef[] {
    const { planVerdicts, routeDecisions, calls } = args;
    const makeVerdictNode = (id: string, stateKey: string, verdicts: string[], field: 'verdict' | 'decision', stage?: 'brief') => {
      let idx = 0;
      const contract: ReusableAgentNodeContract = {
        nodeId: id,
        displayName: id,
        inputSchemaName: `${id}_in`,
        outputSchemaName: `${id}_out`,
        requiredArtifactKeys: [],
        producedArtifactKeys: [stateKey],
        sideEffects: ['call_model'],
      };
      const node: AgentNode = {
        contract,
        async run() {
          calls[id] = (calls[id] ?? 0) + 1;
          const v = verdicts[Math.min(idx, verdicts.length - 1)];
          idx += 1;
          return { stateKey, artifact: { [field]: v, reason: `mock ${v}` } };
        },
      };
      return { id, node, ...(stage ? { checkpointStage: stage } : {}) } as ChainNodeDef;
    };
    return [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeVerdictNode('brief-reviewer-node', 'plan_review', planVerdicts, 'verdict', 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls),
      makeNode('revision-optimizer-node', 'revision_intent', { change: { summary: 's' } }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeVerdictNode('route-agent', 'route_decision', routeDecisions, 'decision'),
      makeNode('world-extractor-physical', 'world_events.physical', { patches: [] }, calls),
    ];
  }

  const DUAL_LOOPS = [
    { from: 'brief-compiler-node', through: 'brief-reviewer-node', cap: 2 },
    { from: 'revision-optimizer-node', through: 'route-agent', cap: 3 },
  ];

  it('规划环 revise → 回 A1 重编（cap 内）；两环衔接：规划 pass 后进自审环，自审环照常回环', async () => {
    const calls: Record<string, number> = {};
    const chain = buildDualLoopChain({
      planVerdicts: ['revise', 'pass'], // 首审 revise → 回 A1；重编后再审 pass → 进 B
      routeDecisions: ['auto_revise', 'accept_as_truth'], // 自审环 1 次回环后 accept
      calls,
    });

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: DUAL_LOOPS },
      makeDeps(),
    );

    expect(snapshot.status).toBe('completed');
    // 规划环：brief-compiler 跑 2 次（首编 + revise 回环重编）、brief-reviewer 判 2 次
    expect(calls['brief-compiler-node']).toBe(2);
    expect(calls['brief-reviewer-node']).toBe(2);
    // 自审环：环体各跑 2 次（首轮 + 1 回环）
    expect(calls['revision-optimizer-node']).toBe(2);
    expect(calls['route-agent']).toBe(2);
    // 提取段（route 后节点）跑 1 次——accept 后自然前进
    expect(calls['world-extractor-physical']).toBe(1);
  });

  it('规划环 cap 耗尽 → 强制 escalate（plan_review 词表 verdict=escalate）→ escalate-pause（无 chapter_accept——非 route 词表）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildDualLoopChain({
      planVerdicts: ['revise'], // 恒 revise → cap 2 耗尽
      routeDecisions: ['accept_as_truth'],
      calls,
    });
    const onAccept = vi.fn();

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: DUAL_LOOPS, onAccept },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    // 强制 escalate 覆写 plan_review（plan 词表，非 route 词表）
    expect(snapshot.artifacts['plan_review']).toMatchObject({ verdict: 'escalate' });
    expect(snapshot.errors?.some((e) => e.includes('cap') && e.includes('brief-reviewer-node'))).toBe(true);
    // 规划环灰区不产 chapter_accept（route 词表专属，D4 语义）——onAccept 不调
    expect(onAccept).not.toHaveBeenCalled();
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
    // 停在规划环 through
    expect(snapshot.currentNodeId).toBe('brief-reviewer-node');
  });

  it('规划环 LLM 判 escalate（灰区，非 cap）→ 同 escalate-pause 形态', async () => {
    const calls: Record<string, number> = {};
    const chain = buildDualLoopChain({
      planVerdicts: ['escalate'],
      routeDecisions: ['accept_as_truth'],
      calls,
    });

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: DUAL_LOOPS },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.artifacts['plan_review']).toMatchObject({ verdict: 'escalate' });
    expect(calls['draft-writer-agent']).toBeUndefined(); // B 未跑（规划灰区先行）
  });

  it('escalate-pause 与 stage 暂停可区分：summarize 只对 stage 暂停抽 pausedStage（escalate-pause 不抽）', async () => {
    // escalate-pause：route 判 escalate_user → paused + escalatePause=true + pausedStage 缺省
    const calls: Record<string, number> = {};
    const chain = buildDualLoopChain({
      planVerdicts: ['pass'],
      routeDecisions: ['escalate_user'],
      calls,
    });
    const escalateSnap = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: DUAL_LOOPS },
      makeDeps(),
    );
    expect(escalateSnap.status).toBe('paused');
    expect(escalateSnap.escalatePause).toBe(true);
    const escalateSummary = summarizeRunSnapshot(escalateSnap, { pausedStage: undefined });
    expect(escalateSummary.escalatePause).toBe(true);
    expect(escalateSummary.pausedStage).toBeUndefined();
    expect(escalateSummary.draftContent).toBeUndefined(); // stage 载荷不抽（裁决路径非审阅卡）

    // stage 暂停（brief checkpoint pause）：paused + 无 escalatePause + pausedStage='brief' + briefContent 抽
    const calls2: Record<string, number> = {};
    const chain2 = buildDualLoopChain({
      planVerdicts: ['pass'],
      routeDecisions: ['accept_as_truth'],
      calls: calls2,
    });
    const onCheckpoint = vi.fn(
      async (stage: CheckpointStage) => (stage === 'brief' ? { action: 'pause' as const } : { action: 'continue' as const }),
    );
    const stageSnap = await runChain(
      { chain: chain2, initialArtifacts: {}, requirement: '', loops: DUAL_LOOPS, onCheckpoint },
      makeDeps(),
    );
    expect(stageSnap.status).toBe('paused');
    expect(stageSnap.escalatePause).toBeUndefined();
    const stageSummary = summarizeRunSnapshot(stageSnap, { pausedStage: 'brief' });
    expect(stageSummary.escalatePause).toBeUndefined();
    expect(stageSummary.pausedStage).toBe('brief');
    expect(stageSummary.briefContent).toEqual({ goal: 'g' });
  });

  it('W1a M3 redo 移除边界：redo 移除 draft-writer（自审环 + B），规划环节点保留 completed', async () => {
    // 第一轮跑到 route accept 终态（completedNodes 含规划环 + 环体 + 提取段）
    const callsA: Record<string, number> = {};
    const chain = buildDualLoopChain({
      planVerdicts: ['pass'],
      routeDecisions: ['accept_as_truth'],
      calls: callsA,
    });
    const first = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: DUAL_LOOPS },
      makeDeps(),
    );
    expect(first.status).toBe('completed');

    // 人审 redo：移除集合 = 自审环节点 + draft-writer（B）——规划环 A1/A2 保留 completed（M3：
    // 人审反馈针对正文非任务卡）。runChain resume 只跳连续 completed 前缀 → 指针停在 B 重跑环体到链尾。
    const callsB: Record<string, number> = {};
    const chainB = buildDualLoopChain({
      planVerdicts: ['pass'],
      routeDecisions: ['accept_as_truth'],
      calls: callsB,
    });
    const redoResumed = first.completedNodes.filter(
      (id) => id !== 'draft-writer-agent' && id !== 'revision-optimizer-node' && id !== 'multi-review-agent' && id !== 'route-agent' && id !== 'world-extractor-physical',
    );
    expect(redoResumed).toEqual(['brief-compiler-node', 'brief-reviewer-node']); // 规划环保留
    const second = await runChain(
      {
        chain: chainB,
        initialArtifacts: first.artifacts,
        requirement: '',
        loops: DUAL_LOOPS,
        resumedCompletedNodes: redoResumed,
      },
      makeDeps(),
    );
    expect(second.status).toBe('completed');
    // 规划环节点 skip（保留 completed——不重编任务卡）
    expect(callsB['brief-compiler-node']).toBeUndefined();
    expect(callsB['brief-reviewer-node']).toBeUndefined();
    // 自审环 + B + 提取段全重跑（prefix 断在 B → 环体到链尾）
    expect(callsB['draft-writer-agent']).toBe(1);
    expect(callsB['revision-optimizer-node']).toBe(1);
    expect(callsB['route-agent']).toBe(1);
    expect(callsB['world-extractor-physical']).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. accept_as_truth / escalate_user → 链段结束
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — route 终止判定', () => {
  it('accept_as_truth → status=completed + 链段结束（无 revisionLoop 时也能正常跑完）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: 'x', wordCount: 1 }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }],
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('accept_as_truth');
  });

  it('无 revisionLoop：跑完所有节点 → status=completed', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls),
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 三 checkpoint stage 设点
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — 三类 checkpoint 设点', () => {
  it('brief-compiler→brief / draft-writer→draft / route-agent→verdict（onCheckpoint 被调 3 次正确 stage）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'),
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      onCheckpoint,
    };

    await runChain(opts, makeDeps());

    expect(onCheckpoint).toHaveBeenCalledTimes(3);
    expect(onCheckpoint.mock.calls[0][0]).toBe('brief');
    expect(onCheckpoint.mock.calls[1][0]).toBe('draft');
    expect(onCheckpoint.mock.calls[2][0]).toBe('verdict');
  });

  it('非 checkpoint 节点（未声明 checkpointStage）不触发 onCheckpoint（CR-13：显式声明取代子串推断）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', {}, calls, [], 'brief'), // brief
      makeNode('story-sync-agent', 'story.sync', { patches: [] }, calls), // 无 stage（即使 id 不含 checkpoint 关键字）
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'), // verdict
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    // 只 brief + verdict（story-sync 未声明 checkpointStage）
    expect(onCheckpoint).toHaveBeenCalledTimes(2);
    expect(onCheckpoint.mock.calls.map((c) => c[0])).toEqual(['brief', 'verdict']);
  });

  it('CR-13：id 含子串但未声明 checkpointStage → 不触发（显式声明取代旧 includes 推断，防假触发）', async () => {
    const calls: Record<string, number> = {};
    // 'draft-refiner-node' id 含 'draft' 子串，但未声明 checkpointStage → 不应触发（旧 includes 逻辑会误触发）
    const chain: ChainNodeDef[] = [
      makeNode('draft-refiner-node', 'draft.refined', { ok: true }, calls),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('onCheckpoint 收到当前 RunSnapshot（含已写 artifact，供 Step 5 持久 chainSnapshot）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'G' }, calls, [], 'brief'),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    const snapshotArg = onCheckpoint.mock.calls[0][1] as RunSnapshot;
    expect(snapshotArg.artifacts['chapter_brief']).toEqual({ goal: 'G' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. error artifact → status=error + break
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — error artifact 检测', () => {
  it('节点返 {artifact:{error:true,...}} → status=error + errors 记录 + break（链段不崩）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        { error: true, nodeId: 'draft-writer-agent', message: 'LLM failed after 2 attempts' },
        calls,
      ),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls), // 不应跑
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('error');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']);
    expect(snapshot.artifacts['draft.initial']).toMatchObject({ error: true });
    expect(snapshot.errors?.some((e) => e.includes('draft-writer-agent') && e.includes('LLM failed'))).toBe(true);
    expect(calls['multi-review-agent']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6b. CR-6：节点 sync throw（非 abort）→ error artifact + status=error（链段不崩）
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — 节点 throw 防御（CR-6）', () => {
  it('节点 run() throw 非 abort 错 → synthesize error artifact + status=error + break（链段不崩）', async () => {
    const calls: Record<string, number> = {};
    const throwingContract: ReusableAgentNodeContract = {
      nodeId: 'draft-writer-agent',
      displayName: 'draft-writer-agent',
      inputSchemaName: 'in',
      outputSchemaName: 'out',
      requiredArtifactKeys: [],
      producedArtifactKeys: ['draft.initial'],
      sideEffects: [],
    };
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      {
        id: 'draft-writer-agent',
        node: {
          contract: throwingContract,
          async run() {
            throw new Error('sync blow up (e.g. safeParse miss / unexpected)');
          },
        },
      },
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls), // 不应跑
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' },
      makeDeps(),
    );

    expect(snapshot.status).toBe('error');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']);
    // synthesize error artifact 写到 producedArtifactKeys[0]='draft.initial'
    expect((snapshot.artifacts['draft.initial'] as { error?: boolean }).error).toBe(true);
    expect(snapshot.errors?.some((e) => e.includes('draft-writer-agent') && e.includes('sync blow up'))).toBe(true);
    expect(calls['multi-review-agent']).toBeUndefined(); // break 后不跑
  });

  it('节点 run() throw AbortError → 传播（走 abort 路径，不吞成 error artifact）', async () => {
    const calls: Record<string, number> = {};
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    const chain: ChainNodeDef[] = [
      {
        id: 'brief-compiler-node',
        node: {
          contract: null,
          async run() {
            throw abortErr;
          },
        },
      },
    ];
    await expect(
      runChain({ chain, initialArtifacts: {}, requirement: '' }, makeDeps()),
    ).rejects.toBeInstanceOf(ChainAbortedError);
    // 注：ChainAbortedError.name='AbortError'，runChain 的 isAbortError 判定传播
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. abort → ChainAbortedError + checkpoint 保存
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — abort / resume', () => {
  it('signal 已 abort（预检）→ 抛 ChainAbortedError + status=aborted', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', {}, calls),
    ];
    const controller = new AbortController();
    controller.abort();
    const opts: RunChainOptions = { chain, initialArtifacts: {}, requirement: '' };

    await expect(runChain(opts, makeDeps(controller.signal))).rejects.toBeInstanceOf(ChainAbortedError);
    expect(calls['brief-compiler-node']).toBeUndefined(); // 预检在前，节点未跑
  });

  it('中途 abort（节点触发 controller.abort）→ 下个节点前抛 ChainAbortedError + onCheckpoint 持久', async () => {
    const calls: Record<string, number> = {};
    const controller = new AbortController();
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', {}, calls, [], 'brief'), // 跑完 → brief checkpoint
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        () => {
          controller.abort(); // draft 跑完时触发 abort
          return { title: 't' };
        },
        calls,
        [],
        'draft',
      ),
      makeNode('route-agent', 'route_decision', { decision: 'accept_as_truth' }, calls, [], 'verdict'), // 不应跑
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      onCheckpoint,
    };

    await expect(runChain(opts, makeDeps(controller.signal))).rejects.toBeInstanceOf(ChainAbortedError);
    // draft 跑完→draft checkpoint 触发；abort 在下个节点前检测 → 抛时 lastStage='draft' → onCheckpoint 再调一次（持久）
    expect(calls['route-agent']).toBeUndefined();
    const stages = onCheckpoint.mock.calls.map((c) => c[0]);
    expect(stages).toContain('brief');
    expect(stages[stages.length - 1]).toBe('draft'); // abort 时用 lastCheckpointStage 持久
  });

  it('resumedCompletedNodes：跳过已完成节点（resume 恢复 artifacts+completedNodes）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 'resumed-draft' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {
        chapter_brief: { goal: 'prior' }, // resume：brief 已跑过，artifact 已在
      },
      requirement: '',
      resumedCompletedNodes: ['brief-compiler-node'],
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect(calls['brief-compiler-node']).toBeUndefined(); // 跳过
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent', 'route-agent']);
  });

  // Story 4.3 Step 1 / CR-2（implement.md 1.4）：resumedCompletedNodes 扩展——多节点 skip + artifact 恢复
  // （runChapterChain resume 读回 chainSnapshot 后喂本参数的生产路径佐证）。resume 跳过 brief+draft 两个节点，
  // initialArtifacts 含其产出（chapter_brief + draft.initial），后续节点（review/targeted/route）续跑。
  it('resumedCompletedNodes：跳过多个已完成节点 + initialArtifacts 恢复其产出（CR-2 多节点 skip）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 'resumed-draft' }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'pass' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      // resume：brief + draft 已跑过，其产出 artifact 已在（mirror runChapterChain resume 读回 snap.artifacts）
      initialArtifacts: {
        chapter_brief: { goal: 'prior' },
        'draft.initial': { title: 'resumed-draft', text: '正文', wordCount: 100 },
      },
      requirement: '',
      resumedCompletedNodes: ['brief-compiler-node', 'draft-writer-agent'],
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('completed');
    expect(calls['brief-compiler-node']).toBeUndefined(); // 跳过
    expect(calls['draft-writer-agent']).toBeUndefined(); // 跳过
    expect(calls['multi-review-agent']).toBe(1); // 续跑
    expect(calls['route-agent']).toBe(1); // 续跑
    // completedNodes 含 resumed（前缀）+ 续跑节点
    expect(snapshot.completedNodes).toEqual([
      'brief-compiler-node',
      'draft-writer-agent',
      'multi-review-agent',
      'route-agent',
    ]);
    // artifact 恢复：brief/draft 产出从 initialArtifacts 恢复（未被重跑覆盖）
    expect((snapshot.artifacts['chapter_brief'] as { goal: string }).goal).toBe('prior');
    expect((snapshot.artifacts['draft.initial'] as { title: string }).title).toBe('resumed-draft');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// summarizeRunSnapshot — context isolation
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeRunSnapshot — context isolation（不抽内部 trace）', () => {
  it('抽 status / routeDecision / reviewVerdict / draftTitle/wordCount/text / errors', () => {
    const snapshot: RunSnapshot = {
      runId: 'r1',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'accept_as_truth', reason: '正文升级' },
        'review.latest': { verdict: 'revise', summary: 's', reasons: ['r'] },
        'draft.initial': { title: '第二章', text: '正文内容……', wordCount: 2800 },
        'scene_graph': { nodes: ['s1', 's2'] }, // 内部 trace，不应进 summary
        'chapter_brief': { goal: 'g' }, // 内部 trace
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: ['some warning'],
    };

    const summary = summarizeRunSnapshot(snapshot);

    expect(summary.status).toBe('completed');
    expect(summary.routeDecision).toEqual({ decision: 'accept_as_truth', reason: '正文升级' });
    expect(summary.reviewVerdict).toBe('revise');
    expect(summary.draftTitle).toBe('第二章');
    expect(summary.draftWordCount).toBe(2800);
    // CR-15a：draftText 抽出（prose 是 deliverable，豁免 context isolation）
    expect(summary.draftText).toBe('正文内容……');
    expect(summary.errors).toEqual(['some warning']);
  });

  it('#107 R1.1c：route_decision.deviation=true → summary.routeDecision.deviation=true 投影（补产 storyDecisions 数据源）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-dev',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'accept_as_truth', reason: '角色突然硬气', deviation: true },
        'draft.initial': { text: '正文。' },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(summary.routeDecision).toEqual({
      decision: 'accept_as_truth',
      reason: '角色突然硬气',
      deviation: true,
    });
  });

  it('#107 R1.1c：deviation=false / 缺省 → 投影省略（零噪音，routeDecision 形态与修前一致）', () => {
    for (const deviation of [false, undefined]) {
      const summary = summarizeRunSnapshot({
        runId: 'r-nodev',
        status: 'completed',
        currentNodeId: null,
        projectPath: '/p',
        completedNodes: [],
        pendingNodes: [],
        artifacts: {
          'route_decision': { decision: 'accept_as_truth', reason: '通过', ...(deviation !== undefined ? { deviation } : {}) },
        },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
      });
      expect(summary.routeDecision).toEqual({ decision: 'accept_as_truth', reason: '通过' });
    }
  });

  it('Story 8.4 Step 3：research_brief.verdict.archive_issues 抽 archiveIssues（坏条目丢好条目留；空/缺零痕迹）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-ammo',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'research_brief': {
          brief: { plan: 'p' },
          briefHash: 'sha256:x',
          verdict: {
            checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
            pass: true,
            gaps: [],
            suggestions: [],
            archive_issues: [
              { card_ref: 'char-lin', problem: '卡片记录的伤臂与第 3 章正文矛盾' },
              { problem: '坏条目（缺 card_ref）' }, // per-element safeParse 拒
            ],
          },
        },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(summary.archiveIssues).toEqual([
      { card_ref: 'char-lin', problem: '卡片记录的伤臂与第 3 章正文矛盾' },
    ]);

    // 无 verdict / 空数组 → 零痕迹（不带空载荷）。
    const empty = summarizeRunSnapshot({
      runId: 'r-ammo2',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: { 'research_brief': { brief: { plan: 'p' }, briefHash: 'sha256:x' } },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(empty.archiveIssues).toBeUndefined();
  });

  it('CR-3：draft.initial 缺 → draftTitle/draftText undefined（revision.output 死 fallback 已删）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r2',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        // 链段不再产 revision.output（targeted-revision overwrite draft.initial，design §4 决断）；
        // 旧 revision.output fallback 已删 → 无 draft artifact 时 draftTitle/draftText 均 undefined。
        'revision.output': { title: '修订版', text: '...', wordCount: 3000 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    expect(summary.draftTitle).toBeUndefined();
    expect(summary.draftText).toBeUndefined();
    expect(summary.draftWordCount).toBeUndefined();
  });

  it('空 artifacts → summary 只剩 status + 空 errors（不抛）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r3',
      status: 'blocked',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {},
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.status).toBe('blocked');
    expect(summary.routeDecision).toBeUndefined();
    expect(summary.reviewVerdict).toBeUndefined();
    expect(summary.draftTitle).toBeUndefined();
    expect(summary.errors).toEqual([]);
  });

  it('不抽内部 trace artifacts（context isolation）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r4',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'scene_graph': { big: 'internal' },
        'settings_context': 'long prefix text',
        'chapter_brief': { goal: 'g' },
        'story.sync': { patches: [] },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    // summary 不含内部 artifact 字段（只有 status/routeDecision/reviewVerdict/draft*/errors）
    const keys = Object.keys(summary);
    expect(keys).not.toContain('scene_graph');
    expect(keys).not.toContain('settings_context');
    expect(summary.draftTitle).toBeUndefined();
    expect(summary.routeDecision).toBeUndefined();
  });

  it('4.1 Step 4：chapter_accept artifact 抽进 summary（deliverable，同 CR-15a draftText 豁免）', () => {
    const chapterAccept = {
      chapterId: 'ch_001',
      candidate: { content: '正文' },
      storyDecisions: [],
      runId: 'r1',
    };
    const summary = summarizeRunSnapshot({
      runId: 'r-ca',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'chapter_accept': chapterAccept,
        'draft.initial': { title: 't', text: '正文', wordCount: 1 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.chapter_accept).toEqual(chapterAccept);
  });

  it('4.1 Step 4：无 chapter_accept artifact → summary.chapter_accept 缺省（key 不出现）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-no-ca',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {},
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.chapter_accept).toBeUndefined();
    expect(Object.keys(summary)).not.toContain('chapter_accept');
  });

  it('Story 4.6：route=escalate_user 时抽 review.latest findings（block+warn，drop info）填 escalateFindings', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-esc',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'escalate_user', reason: '灰区' },
        'review.latest': {
          verdict: 'escalate',
          dimensions: [
            { name: 'consistency', findings: [
              { severity: 'block', quote: '硬气', location: '段1句2', explanation: 'OOC 嫌疑', subClass: 'Characterization.memory' },
              { severity: 'info', quote: '噪声', location: '段1句3', explanation: '可忽略' }, // drop（info 非灰区）
            ] },
            { name: 'narrative-feature', findings: [
              { severity: 'warn', quote: '意象陈腐', location: '段2句1', explanation: '骨架偏 AI' },
            ] },
          ],
        },
        'draft.initial': { title: 't', text: '正文', wordCount: 1 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.escalateFindings).toEqual([
      { severity: 'block', quote: '硬气', location: '段1句2', explanation: 'OOC 嫌疑', subClass: 'Characterization.memory' },
      { severity: 'warn', quote: '意象陈腐', location: '段2句1', explanation: '骨架偏 AI' },
    ]);
  });

  it('Story 8.4 Step 6：findings attribution 三态随 escalateFindings 机械透传（值外字面量丢弃）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-attr',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'escalate_user', reason: '灰区' },
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'consistency',
              findings: [
                {
                  severity: 'block',
                  quote: '守门人对峙没写',
                  location: '段1',
                  explanation: '执行案安排了对峙但正文直接进城',
                  attribution: 'execution_gap',
                },
                {
                  severity: 'warn',
                  quote: '配角行踪矛盾',
                  location: '段2',
                  explanation: '任务卡层就没安排这条线',
                  attribution: 'plan_level',
                },
                {
                  severity: 'warn',
                  quote: '非法归因值',
                  location: '段3',
                  explanation: 'LLM 产了值外字面量',
                  attribution: 'writer_fault',
                },
                {
                  severity: 'warn',
                  quote: '无归因 finding',
                  location: '段4',
                  explanation: '与计划无关不标',
                },
              ],
            },
          ],
        },
        'draft.initial': { title: 't', text: '正文', wordCount: 1 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    // 合法三态透传（裁决器/用户判「正文 vs 计划哪个好」需知问题在哪层）；值外字面量丢弃；无 attribution 保持缺省。
    expect(summary.escalateFindings).toEqual([
      { severity: 'block', quote: '守门人对峙没写', location: '段1', explanation: '执行案安排了对峙但正文直接进城', attribution: 'execution_gap' },
      { severity: 'warn', quote: '配角行踪矛盾', location: '段2', explanation: '任务卡层就没安排这条线', attribution: 'plan_level' },
      { severity: 'warn', quote: '非法归因值', location: '段3', explanation: 'LLM 产了值外字面量' },
      { severity: 'warn', quote: '无归因 finding', location: '段4', explanation: '与计划无关不标' },
    ]);
  });

  it('Story 4.6：非 escalate route → escalateFindings 缺省（即便 review 有 findings 也不抽）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-no-esc',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'route_decision': { decision: 'accept_as_truth', reason: '升级' },
        'review.latest': {
          verdict: 'pass',
          dimensions: [{ name: 'consistency', findings: [{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }] }],
        },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });
    expect(summary.escalateFindings).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. onAccept — accept 分支产 chapter_accept artifact（4.1 Step 4 / CR-15b）
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — onAccept（accept 分支产 chapter_accept，不写盘）', () => {
  it('route=accept_as_truth → 调 onAccept + chapter_accept 写入 artifacts + ctx.nowISO 透传', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(
      (snap: RunSnapshot, ctx: { nowISO: string }) => ({
        chapterId: 'ch_001',
        candidate: { content: String(snap.artifacts['draft.initial']) },
        runId: snap.runId,
        _ctxNowISO: ctx.nowISO,
      }),
    );
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文', wordCount: 1 }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }],
      onAccept,
      nowISO: '2026-08-01T00:00:00.000Z',
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(onAccept).toHaveBeenCalledTimes(1);
    // ctx.nowISO 从 opts.nowISO 透传
    const ctxArg = onAccept.mock.calls[0][1] as { nowISO: string };
    expect(ctxArg.nowISO).toBe('2026-08-01T00:00:00.000Z');
    // chapter_accept 写入 run.artifacts
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({
      chapterId: 'ch_001',
      _ctxNowISO: '2026-08-01T00:00:00.000Z',
    });
  });

  it('Story 4.6 D4 v2：route=escalate_user 无 draft → 仍调 onAccept（去 hasDraftText 门，buildChapterAccept 单源判 draft，CR-Edge-2 修误诊）', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(); // 返 undefined（mock 无返）→ 不产 chapter_accept（模拟 buildChapterAccept 返 skipReason）
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeRouteNode('route-agent', ['escalate_user'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        loops: [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }],
        onAccept,
      },
      makeDeps(),
    );
    // D4 v2：escalate 总调 onAccept（去 hasDraftText 门）——入口层 buildChapterAccept 单源判 draft
    expect(onAccept).toHaveBeenCalledTimes(1);
    // onAccept 返 undefined / skipReason → 不写 chapter_accept
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
  });

  it('Story 4.6 D4：route=escalate_user 有 draft → 调 onAccept 产 chapter_accept（候选载荷，PatchReview 作裁决 UI）', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '正文' }, runId: snap.runId }),
    );
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文', wordCount: 1 }, calls),
      makeRouteNode('route-agent', ['escalate_user'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        loops: [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }],
        onAccept,
      },
      makeDeps(),
    );
    // D4：escalate 有 draft → 调 onAccept 产 chapter_accept（候选载荷，PatchReview accept 才落盘/登记）
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
  });

  it('W1a：route=auto_revise → 链内回环收敛（非终态不产候选）；accept 终态才调 onAccept', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: 'x' }, runId: snap.runId }),
    );
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('targeted-revision-agent', 'draft.initial', { title: 't', text: '正文' }, calls),
      makeRouteNode('route-agent', ['auto_revise', 'accept_as_truth'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
        onAccept,
      },
      makeDeps(),
    );
    // W1a：auto_revise 链内回环（不再 break 交 leader）→ 二判 accept 终态 → onAccept 在终态调一次
    expect(snapshot.status).toBe('completed');
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('onAccept 返 undefined（chapterId 映射失败） → 不写 chapter_accept（accept 持久化阻断）', async () => {
    const calls: Record<string, number> = {};
    const onAccept = vi.fn(() => undefined);
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        loops: [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }],
        onAccept,
      },
      makeDeps(),
    );
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
  });

  it('onAccept 缺省（4.0 既有链段） → accept 分支正常结束，无 chapter_accept（向后兼容）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文' }, calls),
      makeRouteNode('route-agent', ['accept_as_truth'], calls),
    ];
    const snapshot = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        loops: [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }],
      },
      makeDeps(),
    );
    expect(snapshot.status).toBe('completed');
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Story 4.3 Step 2 — pause 机制（onCheckpoint async 返 {action:'pause'}）
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — Story 4.3 Step 2 pause 机制', () => {
  it('onCheckpoint 返 {action:"pause"} → status=paused + currentNodeId 停该 checkpoint 节点 + break（后续不跑）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文', wordCount: 2 }, calls, [], 'draft'),
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'), // 不应跑（pause 在 draft 后 break）
    ];
    // draft checkpoint 返 pause（半自动 suggest 模式行为模拟）
    const onCheckpoint = vi.fn(
      async (stage: CheckpointStage) =>
        stage === 'draft' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = { chain, initialArtifacts: {}, requirement: '', onCheckpoint };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('paused');
    // currentNodeId 停在 draft checkpoint 节点（不 null，区分 completed/aborted）
    expect(snapshot.currentNodeId).toBe('draft-writer-agent');
    // brief + draft 完成（draft artifact 已写）；route 未跑（pause 后 break）
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
    expect(calls['route-agent']).toBeUndefined();
    // draft artifact 已写（pause 在 checkpoint staging 时触发，artifact 先写后 checkpoint）
    expect((snapshot.artifacts['draft.initial'] as { text: string }).text).toBe('正文');
  });

  it('onCheckpoint 返 {action:"continue"} 全程 → 链段连续跑完（全自动零回归 = 4.0 行为）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'),
      makeRouteNode('route-agent', ['accept_as_truth'], calls, [], 'verdict'),
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    // 全程 continue → 跑完（route accept 终止）status=completed，无 pause
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentNodeId).toBeNull();
    expect(onCheckpoint).toHaveBeenCalledTimes(3); // brief + draft + verdict 三 checkpoint 都触
  });

  it('brief checkpoint pause（微操 readonly 模式：第一个 checkpoint 就停）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'), // 不应跑
    ];
    const onCheckpoint = vi.fn(async () => ({ action: 'pause' as const }));
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.currentNodeId).toBe('brief-compiler-node');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node']);
    expect(calls['draft-writer-agent']).toBeUndefined();
  });

  it('无 onCheckpoint（缺省）→ 不 pause，连续跑完（向后兼容 4.0 链段无 onCheckpoint 场景）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't' }, calls, [], 'draft'),
    ];
    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '' }, // 无 onCheckpoint
      makeDeps(),
    );
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedNodes).toEqual(['brief-compiler-node', 'draft-writer-agent']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Story 4.3 Step 2 — paused summary（summarizeRunSnapshot + pauseHint）
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeRunSnapshot — Story 4.3 Step 2 paused payload', () => {
  it('status=paused + pauseHint → 抽 pausedStage + draftContent（draft checkpoint）', () => {
    const summary = summarizeRunSnapshot(
      {
        runId: 'r-pause',
        status: 'paused',
        currentNodeId: 'draft-writer-agent',
        projectPath: '/p',
        completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
        pendingNodes: ['route-agent'],
        artifacts: {
          'chapter_brief': { goal: 'g' },
          'draft.initial': { title: '第二章', text: '黄昏的荒野上。', wordCount: 100 },
        },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
        errors: [],
      },
      { pausedStage: 'draft' },
    );

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('draft');
    // draftContent 抽正文（review payload，同 CR-15a 豁免 isolation）
    expect(summary.draftContent).toBe('黄昏的荒野上。');
  });

  it('status=paused + pauseHint → 抽 briefContent（brief checkpoint）', () => {
    const brief = { goal: 'G', episodeId: 'ep1', tone: '紧张' };
    const summary = summarizeRunSnapshot(
      {
        runId: 'r-pause-brief',
        status: 'paused',
        currentNodeId: 'brief-compiler-node',
        projectPath: '/p',
        completedNodes: ['brief-compiler-node'],
        pendingNodes: ['draft-writer-agent'],
        artifacts: { chapter_brief: brief },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
        errors: [],
      },
      { pausedStage: 'brief' },
    );

    expect(summary.pausedStage).toBe('brief');
    expect(summary.briefContent).toEqual(brief);
    // brief checkpoint 时 draft 未产 → draftContent 缺省
    expect(summary.draftContent).toBeUndefined();
  });

  it('pauseHint 缺省（runChapterChain 未传）→ pausedStage undefined（仍抽 draft/brief content 若在）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-pause-nohint',
      status: 'paused',
      currentNodeId: 'draft-writer-agent',
      projectPath: '/p',
      completedNodes: ['draft-writer-agent'],
      pendingNodes: [],
      artifacts: { 'draft.initial': { title: 't', text: '稿', wordCount: 1 } },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    }); // 无 pauseHint

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBeUndefined();
    expect(summary.draftContent).toBe('稿');
  });

  it('非 paused 状态（completed/aborted 等）→ 不抽 paused payload（零回归）', () => {
    const summary = summarizeRunSnapshot({
      runId: 'r-completed',
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        'draft.initial': { title: 't', text: '稿', wordCount: 1 },
        chapter_brief: { goal: 'g' },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });

    expect(summary.status).toBe('completed');
    expect(summary.pausedStage).toBeUndefined();
    expect(summary.draftContent).toBeUndefined();
    expect(summary.briefContent).toBeUndefined();
    // draftText 仍抽（CR-15a 不变）
    expect(summary.draftText).toBe('稿');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. resolveCheckpointStage（runChapterChain 据 currentNodeId 解析 pausedStage 用）
// ════════════════════════════════════════════════════════════════════════════

describe('resolveCheckpointStage — Story 4.3 Step 2', () => {
  it('nodeId 命中 chain 中带 checkpointStage 的节点 → 返其 stage', () => {
    const chain: ChainNodeDef[] = [
      { id: 'brief-compiler-node', node: null as any, checkpointStage: 'brief' },
      { id: 'draft-writer-agent', node: null as any, checkpointStage: 'draft' },
      { id: 'story-sync-agent', node: null as any }, // 无 checkpointStage
      { id: 'route-agent', node: null as any, checkpointStage: 'verdict' },
    ];
    expect(resolveCheckpointStage(chain, 'draft-writer-agent')).toBe('draft');
    expect(resolveCheckpointStage(chain, 'brief-compiler-node')).toBe('brief');
    expect(resolveCheckpointStage(chain, 'route-agent')).toBe('verdict');
  });

  it('nodeId 命中但节点无 checkpointStage → undefined', () => {
    const chain: ChainNodeDef[] = [{ id: 'story-sync-agent', node: null as any }];
    expect(resolveCheckpointStage(chain, 'story-sync-agent')).toBeUndefined();
  });

  it('nodeId 不在 chain / nodeId=null → undefined（defensive）', () => {
    const chain: ChainNodeDef[] = [{ id: 'brief-compiler-node', node: null as any, checkpointStage: 'brief' }];
    expect(resolveCheckpointStage(chain, 'nonexistent')).toBeUndefined();
    expect(resolveCheckpointStage(chain, null)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. deriveCheckpointPolicy（§4 permissionMode → CheckpointPolicy 映射）
// ════════════════════════════════════════════════════════════════════════════

describe('deriveCheckpointPolicy — Story 4.3 §4 映射表', () => {
  it('auto（全权/全自动）→ 无 scheduled pause + auto-trust escalate', () => {
    const policy: CheckpointPolicy = deriveCheckpointPolicy('auto');
    expect(policy.pauseStages).toEqual([]);
    expect(policy.escalateMode).toBe('auto-trust');
  });

  it('suggest（半自动）→ final（终稿人审一次）checkpoint pause + ask escalate（链流程重排 W2）', () => {
    const policy: CheckpointPolicy = deriveCheckpointPolicy('suggest');
    expect(policy.pauseStages).toEqual(['final']);
    expect(policy.escalateMode).toBe('ask');
  });

  it('readonly（微操）→ brief+final checkpoint pause + ask escalate（链流程重排 W2：旧 draft/verdict 停点退役）', () => {
    const policy: CheckpointPolicy = deriveCheckpointPolicy('readonly');
    expect(policy.pauseStages).toEqual(['brief', 'final']);
    expect(policy.escalateMode).toBe('ask');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. CR-08-02-autonomy-modes-001（critical，三 reviewer 独立确认）：verdict checkpoint 时序
//     readonly（微操）模式 verdict pause 抢断 route 终态处理 → silent data loss（accept 候选丢 /
//     revision 改稿丢 / escalate 裁决丢）。修后：through 节点 verdict checkpoint 在「终态处理后」fire；
//     auto_revise loop 不 pause（非终态）；accept/escalate/cap-escalate 先 onAccept 产 chapter_accept 再 pause。
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — CR-08-02-autonomy-modes-001 verdict checkpoint 时序', () => {
  // 链布局：brief(0) → targeted-revision(1, from) → multi-review(2) → route(3, through, verdict)
  function buildRevisionChain(
    routeDecisions: string[],
    calls: Record<string, number>,
  ): ChainNodeDef[] {
    return [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('targeted-revision-agent', 'draft.initial', { title: '修订稿' }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeRouteNode('route-agent', routeDecisions, calls, [], 'verdict'),
    ];
  }

  it('链流程重排 W2：route=accept + final/verdict pauseStages → 终稿 checkpoint fire（accept 终态处理后）；onAccept 不在 pause 前（移 E 段完成后——pause 时刻无 chapter_accept）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['accept_as_truth'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '正文' }, runId: snap.runId }),
    );
    // verdict pause（mock 链沿用 'verdict' stage 声明——chainRunner accept 路径 final/verdict 同 fire）
    const checkpointSnapshots: { stage: CheckpointStage; hasChapterAccept: boolean }[] = [];
    const onCheckpoint = vi.fn(async (stage: CheckpointStage, snap: RunSnapshot) => {
      checkpointSnapshots.push({ stage, hasChapterAccept: !!snap.artifacts['chapter_accept'] });
      return stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const };
    });
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
      onAccept,
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    // 终稿 pause 抢断 complete（status='paused'，currentNodeId 停 route）；onAccept 未调（W2 落盘拆两步
    // F1b：candidate 须含人改后正文——resume 腿跑完 E 段由完成时 onAccept 统一产出）。
    expect(snapshot.status).toBe('paused');
    expect(snapshot.currentNodeId).toBe('route-agent');
    expect(onAccept).not.toHaveBeenCalled();
    expect(snapshot.artifacts['chapter_accept']).toBeUndefined();
    // 关键时序断言：终稿 checkpoint 在 accept 终态处理后 fire（route_decision 已产——pause 不抢断终态）
    const finalCheckpoint = checkpointSnapshots.find((c) => c.stage === 'verdict');
    expect(finalCheckpoint).toBeDefined();
    expect((snapshot.artifacts['route_decision'] as { decision?: string }).decision).toBe('accept_as_truth');
    expect(finalCheckpoint!.hasChapterAccept).toBe(false);
  });

  it('链流程重排 W2（plan-review L7 防 silent data loss 锚）：final pause → resume-continue → 续跑无剩节点 → complete + onAccept 完成时补产 chapter_accept（候选不丢）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['accept_as_truth'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '正文' }, runId: snap.runId }),
    );
    // 第一腿：final（verdict 声明）pause。
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const first = await runChain(
      {
        chain,
        initialArtifacts: {},
        requirement: '',
        loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
        onAccept,
        onCheckpoint,
      },
      makeDeps(),
    );
    expect(first.status).toBe('paused');
    expect(onAccept).not.toHaveBeenCalled();

    // 第二腿：resume-continue（route 在 completedNodes 前缀跳过）→ 无剩节点 → complete。
    const second = await runChain(
      {
        chain,
        initialArtifacts: first.artifacts,
        requirement: '',
        loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
        onAccept,
        resumedCompletedNodes: ['brief-compiler-node', 'targeted-revision-agent', 'multi-review-agent', 'route-agent'],
      },
      makeDeps(),
    );
    expect(second.status).toBe('completed');
    // F1b：完成时 onAccept 补产 chapter_accept（无 silent data loss——final pause 未产候选由完成腿补齐）。
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(second.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
    expect(calls['route-agent']).toBe(1);
  });

  it('W1a：route=auto_revise + verdict pauseStages → 链内回环（回环中不 fire verdict checkpoint）；二判 accept 后终态处理 + verdict pause', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'accept_as_truth'], calls);
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    // W1a：auto_revise 链内回环（不 break 交 leader）→ 环体重跑 → route 二判 accept → onAccept 后
    // verdict checkpoint pause 抢断 complete（CR-08-02-autonomy-modes-001 终态处理后 fire 语义保持）。
    expect(snapshot.status).toBe('paused');
    expect(snapshot.currentNodeId).toBe('route-agent');
    expect(snapshot.artifacts['route_decision']).toMatchObject({ decision: 'accept_as_truth' });
    expect(calls['route-agent']).toBe(2); // 2 次 route 判决（auto_revise 回环 + accept 终态）
    expect(calls['targeted-revision-agent']).toBe(2); // 环体重跑
    // verdict checkpoint 只 fire 一次（accept 终态处理后的那次——回环跳步不 fire，非暂停形态）
    const verdictCalls = onCheckpoint.mock.calls.filter((c) => c[0] === 'verdict');
    expect(verdictCalls).toHaveLength(1);
  });

  it('W1a：cap=0 → 强制 escalate-pause → onAccept 对称（cap-escalate 与 LLM escalate 同形，不 silent drop）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'auto_revise', 'auto_revise'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_cap', candidate: { content: 'cap 后稿' }, runId: snap.runId }),
    );
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 0 }],
      onAccept,
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    // cap=0：auto_revise 立即 cap-exceeded → 强制 escalate → escalate-pause（status='paused' +
    // escalatePause 标记；onAccept 对称产候选——D4/CR-Edge-1）。
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_cap' });
    // cap=0 → route 只调 1 次（立即 escalate，无回环重跑）
    expect(calls['route-agent']).toBe(1);
  });

  it('route=escalate_user + verdict pauseStages → verdict checkpoint 在 escalate 处理后 fire（D4 v2：onAccept 对称调）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['escalate_user'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '灰区稿' }, runId: snap.runId }),
    );
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
      onAccept,
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    expect(snapshot.status).toBe('paused');
    expect(snapshot.artifacts['route_decision']).toMatchObject({ decision: 'escalate_user' });
    // D4 v2：escalate 也调 onAccept（候选给 PatchReview 裁决），在 verdict pause 前
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
  });

  it('Story 7.4：cap=0 → 强制 escalate → onAccept + verdict checkpoint 对称（cap-escalate 终态处理完整，不 silent drop）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['auto_revise', 'auto_revise', 'auto_revise'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_cap', candidate: { content: 'cap 后稿' }, runId: snap.runId }),
    );
    const onCheckpoint = vi.fn(async (stage: CheckpointStage) =>
      stage === 'verdict' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {},
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 0 }],
      onAccept,
      onCheckpoint,
    };

    const snapshot = await runChain(opts, makeDeps());

    // cap=0：auto_revise 立即 cap-exceeded → escalate → onAccept 对称（D4）+ verdict checkpoint（终态处理后）
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    expect(snapshot.status).toBe('paused'); // verdict pause（pauseStages 含 verdict）
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_cap' });
    // cap=0 → route 只调 1 次（立即 escalate，无 loop 重跑）
    expect(calls['route-agent']).toBe(1);
  });

  it('resume 正确性：verdict pause（chapter_accept 已产）→ resumedCompletedNodes 含 route → 续跑无剩节点 → complete（候选在）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildRevisionChain(['accept_as_truth'], calls);
    const onAccept = vi.fn(
      (snap: RunSnapshot) => ({ chapterId: 'ch_001', candidate: { content: '正文' }, runId: snap.runId }),
    );
    const opts: RunChainOptions = {
      chain,
      initialArtifacts: {
        chapter_brief: { goal: 'g' },
        'draft.initial': { title: '修订稿' },
        'review.latest': { verdict: 'pass' },
        route_decision: { decision: 'accept_as_truth', reason: 'mock' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文' }, runId: 'r-prior' },
      },
      requirement: '',
      loops: [{ from: 'targeted-revision-agent', through: 'route-agent', cap: 3 }],
      onAccept,
      resumedCompletedNodes: [
        'brief-compiler-node',
        'targeted-revision-agent',
        'multi-review-agent',
        'route-agent',
      ],
    };

    const snapshot = await runChain(opts, makeDeps());

    // resume-continue：route 在 completedNodes → 前缀跳过 → 链段无剩节点 → complete
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentNodeId).toBeNull();
    // W2 F1b：完成时 onAccept 补产/覆盖 chapter_accept（route_decision=accept 在 artifacts → 完成
    // 腿统一产出候选；旧快照候选被同内容新候选覆盖——runId 为本腿 runId）。
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(snapshot.artifacts['chapter_accept']).toMatchObject({ chapterId: 'ch_001' });
    expect(calls['route-agent']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. Story 8.4 Step 4（A7/A8）：出发核查挂起 → pause（decideCheckpointPause 单源 + summarize 投影）
//
// 挂起 ≠ 错误：节点产非 error 的 research_brief 结果（携 suspended）→ chainRunner 记 completedNodes +
// fire draft checkpoint → decideCheckpointPause（workflow onCheckpoint 闭包单源调用的纯函数，此处直测
// 同一函数）读 suspended → **全档位 pause（含 auto——结构性矛盾不带病开写）**。恢复 = redo。
// ════════════════════════════════════════════════════════════════════════════

describe('decideCheckpointPause — Story 8.4 Step 4（pause 判定单源）', () => {
  const suspendedSnapshot = (): RunSnapshot => ({
    runId: 'r1',
    status: 'running',
    currentNodeId: 'draft-writer-agent',
    projectPath: '/p',
    completedNodes: [],
    pendingNodes: [],
    artifacts: {
      research_brief: {
        briefHash: 'sha256:x',
        suspended: {
          kind: 'research_contradiction',
          rounds: 1,
          evidence: {
            contradictions: [{ desc: '矛盾', severity: 'contradiction' }],
            deviations: [],
          },
        },
      },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  });

  it('挂起 + auto（pauseStages=[]）→ pause（全档位无例外——A8 核心断言）', () => {
    expect(decideCheckpointPause('draft', suspendedSnapshot(), deriveCheckpointPolicy('auto'))).toEqual({ action: 'pause' });
  });

  it('挂起 + suggest / readonly → pause（与 mode 驱动 pause 同为 pause）', () => {
    expect(decideCheckpointPause('draft', suspendedSnapshot(), deriveCheckpointPolicy('suggest'))).toEqual({ action: 'pause' });
    expect(decideCheckpointPause('draft', suspendedSnapshot(), deriveCheckpointPolicy('readonly'))).toEqual({ action: 'pause' });
  });

  it('挂起 + policy 缺省（4.0 既有 / 无 mode 消费方）→ 仍 pause（suspension 驱动不受 policy 缺省豁免）', () => {
    expect(decideCheckpointPause('draft', suspendedSnapshot(), undefined)).toEqual({ action: 'pause' });
  });

  it('无挂起 + auto → continue（正常 draft checkpoint 全自动零回归）', () => {
    const snap = suspendedSnapshot();
    delete (snap.artifacts['research_brief'] as Record<string, unknown>).suspended;
    expect(decideCheckpointPause('draft', snap, deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
  });

  it('无挂起 + suggest（pauseStages 含 final）→ pause（mode 驱动路径零回归）；draft 已退役不停（链流程重排 W2）', () => {
    const snap = suspendedSnapshot();
    delete (snap.artifacts['research_brief'] as Record<string, unknown>).suspended;
    expect(decideCheckpointPause('final', snap, deriveCheckpointPolicy('suggest'))).toEqual({ action: 'pause' });
    expect(decideCheckpointPause('draft', snap, deriveCheckpointPolicy('suggest'))).toEqual({ action: 'continue' });
  });

  it('挂起只作用 draft stage（brief/verdict 载荷在场不触发——挂起节点位在 draft）', () => {
    expect(decideCheckpointPause('brief', suspendedSnapshot(), deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
    expect(decideCheckpointPause('verdict', suspendedSnapshot(), deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
  });

  it('链流程重排 W2（R4 翻 7.2 全档位 pause）：soft-violation + suggest/readonly/无 policy → pause（art-mode 卡）；+ auto → continue（自动回退改前稿——splice 不发生即回退）；clean → continue', () => {
    const guardSnap = (verdict: string): RunSnapshot => ({
      ...suspendedSnapshot(),
      artifacts: { revision_guard: { verdict } },
    });
    expect(decideCheckpointPause('revision-guard', guardSnap('soft-violation'), deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
    expect(decideCheckpointPause('revision-guard', guardSnap('soft-violation'), deriveCheckpointPolicy('suggest'))).toEqual({ action: 'pause' });
    expect(decideCheckpointPause('revision-guard', guardSnap('soft-violation'), deriveCheckpointPolicy('readonly'))).toEqual({ action: 'pause' });
    expect(decideCheckpointPause('revision-guard', guardSnap('soft-violation'), undefined)).toEqual({ action: 'pause' });
    expect(decideCheckpointPause('revision-guard', guardSnap('clean'), deriveCheckpointPolicy('auto'))).toEqual({ action: 'continue' });
  });
});

describe('summarizeRunSnapshot — Story 8.4 Step 4 挂起载荷投影', () => {
  const suspendedRun = (): RunSnapshot => ({
    runId: 'r1',
    status: 'paused',
    currentNodeId: 'draft-writer-agent',
    projectPath: '/p',
    completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
    pendingNodes: [],
    artifacts: {
      chapter_brief: { goal: 'g' },
      research_brief: {
        briefHash: 'sha256:x',
        suspended: {
          kind: 'research_contradiction',
          rounds: 2,
          evidence: {
            contradictions: [{ desc: '任务卡与第 3 章矛盾', severity: 'contradiction' }],
            deviations: [{ scene_ref: 's1', plan_says: 'P', brief_says: 'B', reason: 'R' }],
          },
        },
      },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  });

  it('paused + research_brief.suspended → summary.researchSuspension（deliverable 豁免 isolation）', () => {
    const summary = summarizeRunSnapshot(suspendedRun(), { pausedStage: 'draft' });
    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('draft');
    expect(summary.researchSuspension).toMatchObject({
      kind: 'research_contradiction',
      rounds: 2,
      evidence: {
        contradictions: [{ desc: '任务卡与第 3 章矛盾', severity: 'contradiction' }],
        deviations: [{ scene_ref: 's1', plan_says: 'P', brief_says: 'B', reason: 'R' }],
      },
    });
  });

  it('verify_exhausted 形态（gaps）照常投影', () => {
    const run = suspendedRun();
    (run.artifacts['research_brief'] as Record<string, unknown>).suspended = {
      kind: 'verify_exhausted',
      rounds: 3,
      gaps: [{ desc: '未核查王五', source_hint: 'query_story 搜「王五」' }],
    };
    const summary = summarizeRunSnapshot(run, { pausedStage: 'draft' });
    expect(summary.researchSuspension).toMatchObject({
      kind: 'verify_exhausted',
      rounds: 3,
      gaps: [{ desc: '未核查王五', source_hint: 'query_story 搜「王五」' }],
    });
  });

  it('非 paused（completed）→ 不抽挂起载荷（零回归）', () => {
    const summary = summarizeRunSnapshot({ ...suspendedRun(), status: 'completed' });
    expect(summary.researchSuspension).toBeUndefined();
  });

  it('paused 但 suspended 形态坏（防御）→ 不设字段，status 仍 paused', () => {
    const run = suspendedRun();
    (run.artifacts['research_brief'] as Record<string, unknown>).suspended = { kind: 'bogus' };
    const summary = summarizeRunSnapshot(run, { pausedStage: 'draft' });
    expect(summary.researchSuspension).toBeUndefined();
    expect(summary.status).toBe('paused');
  });
});

describe('runChain — 出发核查挂起 pause 型节点结果（真链段驱动语义）', () => {
  it('writer 返 research_brief 挂起结果 → 非 error → completedNodes 记录 + draft checkpoint pause（onCheckpoint 用 decideCheckpointPause 单源）+ errors 零计', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      {
        id: 'draft-writer-agent',
        node: {
          contract: null,
          async run({ run }) {
            calls['draft-writer-agent'] = (calls['draft-writer-agent'] ?? 0) + 1;
            // Step 4 形态：pause 型结果（stateKey=research_brief 携 suspended，非 error）。
            run.artifacts['research_brief'] = {
              briefHash: 'sha256:x',
              suspended: { kind: 'research_contradiction', rounds: 1 },
            };
            return { stateKey: 'research_brief', artifact: run.artifacts['research_brief'] };
          },
        },
        checkpointStage: 'draft',
      },
      makeNode('revision-guard-agent', 'draft.initial', { title: '不应到达' }, calls, ['draft.initial']),
    ];
    const onCheckpoint = vi.fn(
      async (stage: CheckpointStage, snap: RunSnapshot) =>
        decideCheckpointPause(stage, snap, deriveCheckpointPolicy('auto')),
    );

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', onCheckpoint },
      makeDeps(),
    );

    // 全档位（auto）pause：挂起 ≠ 错误（status=paused 非 error；errors 零计——挂起不进错误账）。
    expect(snapshot.status).toBe('paused');
    expect(snapshot.currentNodeId).toBe('draft-writer-agent');
    expect(snapshot.errors ?? []).toEqual([]);
    expect(snapshot.completedNodes).toContain('draft-writer-agent'); // resume-redo 移除它的前提
    // 下游节点不跑（挂起停链）。
    expect(calls['revision-guard-agent']).toBeUndefined();
    // 摘要投影（pauseHint 经 resolveCheckpointStage 解析，同 runChapterChain 生产路径）。
    const summary = summarizeRunSnapshot(snapshot, {
      pausedStage: resolveCheckpointStage(chain, snapshot.currentNodeId),
    });
    expect(summary.pausedStage).toBe('draft');
    expect(summary.researchSuspension).toMatchObject({ kind: 'research_contradiction', rounds: 1 });
  });
});


// ════════════════════════════════════════════════════════════════════════════
// 链流程重排 W2：终稿 checkpoint 载荷（reviewSummary / lintReport）+ 去味门禁机械信号
// （lintUnresolved）+ E 段失败章标（derivationStale）——summarizeRunSnapshot 投影单测。
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeRunSnapshot — W2 终稿 checkpoint 载荷 + 章标投影', () => {
  const baseRun = (over: Partial<RunSnapshot>): RunSnapshot => ({
    runId: 'r1',
    status: 'paused',
    currentNodeId: 'route-agent',
    projectPath: '/p',
    completedNodes: ['route-agent'],
    pendingNodes: [],
    artifacts: {},
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
    ...over,
  });

  it('final pause → reviewSummary（verdict/reasons/loopCount/capExhausted）+ lintReport digest 投影', () => {
    const run = baseRun({
      artifacts: {
        'draft.initial': { title: '终稿', text: '正文', wordCount: 2 },
        'review.latest': { verdict: 'pass', summary: '整体可过', dimensions: [] },
        route_decision: { decision: 'accept_as_truth', reason: '终稿可接受' },
        lint_report: {
          chapterId: 'ep1',
          issues: [
            { level: 'high', title: 'not-is-comparison', match: '不再是…而是', detail: '计数 3' },
            { level: 'low', title: 'some-low-rule', match: '仿佛', detail: '' },
          ],
          densityIssues: [],
          summary: { total: 2, high: 1, medium: 0, low: 1, visibleChars: 100 },
        },
      },
      revisionCount: 2,
    });
    const summary = summarizeRunSnapshot(run, { pausedStage: 'final' });
    expect(summary.reviewSummary).toEqual({
      verdict: 'pass',
      reasons: ['终稿可接受', '整体可过'],
      loopCount: 2,
      capExhausted: false,
    });
    expect(summary.lintReport).toContain('2 条命中');
    expect(summary.lintReport).toContain('[high] not-is-comparison');
    // W3 真判决：raw lint 命中（机械代理信号已退役）不再是 lintUnresolved 判据——判真伪归
    // multi-review L2，review 无 source=lint 确认条目（dimensions 空）→ 门禁过（命中可能是误报）。
    expect(summary.lintUnresolved).toBeUndefined();
  });

  it('W3 真判决：review.latest 含 source=lint block/warn 确认条目 → lintUnresolved=true（AC2d 判源不判义）', () => {
    const run = baseRun({
      artifacts: {
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [
                // L2 对 lintReport 清单判真的确认条目（source 标记）——机器确认 AI 味未清。
                { severity: 'block', quote: '不是怯懦，而是清醒', location: '句1', explanation: '套话', source: 'lint' },
              ],
            },
          ],
        },
        // CR-5：source 标记须过机械交叉核对（quote 与 lint_report issue 命中文本互含）才计入门禁——
        // LLM 自报标签单凭自身不再直通（mirror chapter-nodes isLintSourceMechanicallyConfirmed 单源）。
        lint_report: {
          summary: { total: 1, high: 1, medium: 0, low: 0 },
          issues: [{ level: 'high', ruleId: 'not-is-comparison', match: '不是怯懦，而是清醒' }],
        },
        route_decision: { decision: 'escalate_user', reason: '环未收敛' },
      },
      errors: ['loop cap (3) reached at "route-agent"; forced escalate'],
    });
    const summary = summarizeRunSnapshot(run);
    expect(summary.lintUnresolved).toBe(true);
  });

  it('CR-5：source=lint 声明但机械核对不过（quote 与 lint_report 零匹配）→ 按agent来源处理，不设 lintUnresolved', () => {
    const run = baseRun({
      artifacts: {
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [
                // LLM 误标 source:'lint'（quote 与 lint_report 任何 issue 均不匹配）——豁免面不认自报。
                { severity: 'block', quote: '与 lint 清单毫无关系的句子', location: '句1', explanation: '语义判定', source: 'lint' },
              ],
            },
          ],
        },
        lint_report: {
          summary: { total: 1, high: 1, medium: 0, low: 0 },
          issues: [{ level: 'high', ruleId: 'not-is-comparison', match: '完全不同的命中文本' }],
        },
        route_decision: { decision: 'escalate_user', reason: '环未收敛' },
      },
      errors: ['loop cap (3) reached at "route-agent"; forced escalate'],
    });
    const summary = summarizeRunSnapshot(run);
    expect(summary.lintUnresolved).toBeUndefined();
  });

  it('W3 真判决：source=lint 仅 info 级（观察非缺陷）或非 lint 来源 → 不设（保守采信语义）', () => {
    const run = baseRun({
      artifacts: {
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [
                { severity: 'info', quote: 'q', location: '句1', explanation: 'e', source: 'lint' },
                { severity: 'block', quote: '意象陈腐', location: '句2', explanation: '语义判定（无 source）' },
              ],
            },
          ],
        },
        route_decision: { decision: 'escalate_user', reason: 'r' },
      },
    });
    const summary = summarizeRunSnapshot(run);
    expect(summary.lintUnresolved).toBeUndefined();
  });

  it('final pause + lint degraded（引擎缺位）→ lintReport 占位说明 + 无 lintUnresolved（诚实标注不假零）', () => {
    const run = baseRun({
      artifacts: {
        'review.latest': { verdict: 'pass', dimensions: [] },
        route_decision: { decision: 'accept_as_truth', reason: 'r' },
        lint_report: {
          chapterId: 'ep1',
          issues: [],
          densityIssues: [],
          summary: { total: 0, high: 0, medium: 0, low: 0, visibleChars: 0 },
          degraded: true,
        },
      },
    });
    const summary = summarizeRunSnapshot(run, { pausedStage: 'final' });
    expect(summary.lintReport).toContain('lint 引擎缺位');
    expect(summary.lintUnresolved).toBeUndefined();
  });

  it('非 final pause（draft 挂起形态）→ reviewSummary/lintReport 缺省（仅终稿卡载荷）', () => {
    const run = baseRun({
      currentNodeId: 'draft-writer-agent',
      artifacts: {
        'review.latest': { verdict: 'pass', dimensions: [] },
        route_decision: { decision: 'accept_as_truth', reason: 'r' },
      },
    });
    const summary = summarizeRunSnapshot(run, { pausedStage: 'draft' });
    expect(summary.reviewSummary).toBeUndefined();
    expect(summary.lintReport).toBeUndefined();
  });

  it('E 段失败（error + route accept 已过 + route-agent completed）→ derivationStale 章标', () => {
    const run = baseRun({
      status: 'error',
      artifacts: {
        'draft.initial': { title: '终稿', text: '正文', wordCount: 2 },
        route_decision: { decision: 'accept_as_truth', reason: '终稿已定' },
      },
      errors: ['node "world-merge-node" error: mock'],
    });
    const summary = summarizeRunSnapshot(run);
    expect(summary.derivationStale).toBe(true);
  });

  it('error 但 route 未过（redo 腿 / 环内失败）→ 不误报 derivationStale', () => {
    const run = baseRun({
      status: 'error',
      completedNodes: ['brief-compiler-node'], // route-agent 不在（重跑中）
      artifacts: {
        'draft.initial': { title: 't', text: 'x', wordCount: 1 },
        route_decision: { decision: 'accept_as_truth', reason: 'stale 旧值（route 移除重跑中）' },
      },
      errors: ['node "draft-writer-agent" error: mock'],
    });
    const summary = summarizeRunSnapshot(run);
    expect(summary.derivationStale).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CR 批（09-13 chain-flow-restructure review findings）——环入口机械断路器（CR-1）/
// 未知 verdict 响错（CR-10）/ 规划环灰区裁决材料（CR-2a）/ escalate-accept 续跑补发终稿
// checkpoint（CR-3a）/ plan-review skipped 投影（CR-11）/ completedNodes 去重锚（CR-17）。
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — CR-1 环入口机械断路器（确定性空转短路，纯代码判据零 LLM）', () => {
  /**
   * 自审环 mock 链（mirror 生产环体序的机制子集）：brief(0) → optimizer(1, from) → writer(2) →
   * guard(3) → multi-review(4) → route(5, through)。writer/guard 按序列返（超出复用末项）。
   */
  function buildStallChain(args: {
    draftTexts: string[];
    guardVerdicts: string[];
    routeDecisions: string[];
    calls: Record<string, number>;
  }): ChainNodeDef[] {
    const seq = (values: string[]) => {
      let i = 0;
      return () => values[Math.min(i++, values.length - 1)];
    };
    const nextDraft = seq(args.draftTexts);
    const nextGuard = seq(args.guardVerdicts);
    return [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, args.calls),
      makeNode('revision-optimizer-node', 'revision_intent', { change: { summary: 's' } }, args.calls),
      makeNode(
        'draft-writer-agent',
        'draft.initial',
        () => ({ title: 't', text: nextDraft(), wordCount: 10 }),
        args.calls,
      ),
      makeNode('revision-guard-agent', 'revision_guard', () => ({ verdict: nextGuard() }), args.calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, args.calls),
      makeRouteNode('route-agent', args.routeDecisions, args.calls),
    ];
  }
  const STALL_LOOPS = [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 3 }];

  it('soft-violation 回退（草稿未变）+ guard 同判 → 连续两圈同指纹 → 环入口短路 escalate（不烧满 cap）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildStallChain({
      draftTexts: ['正文'], // 恒定——guard soft-violation 不 splice，draft.initial 每圈不变
      guardVerdicts: ['soft-violation'],
      routeDecisions: ['auto_revise'],
      calls,
    });

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: STALL_LOOPS },
      makeDeps(),
    );

    // 确定性空转：圈 1 产稿（soft-violation 回退不改稿）→ route auto_revise 回环；圈 2 同判零进展 →
    // 圈 3 入口机械短路（圈 3 环体零调用），按 cap 超限同矩阵 escalate-pause。
    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.currentNodeId).toBe('route-agent');
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    // 错误信息含 'loop cap'（入口层 capExhausted 子串判定兼容）+ through 节点 id（精确环判定兼容）。
    expect(snapshot.errors?.some((e) => e.includes('loop cap') && e.includes('route-agent'))).toBe(true);
    expect(snapshot.errors?.some((e) => e.includes('short-circuit'))).toBe(true);
    // 只烧 2 圈（cap 3 未烧满）：写手 / route / optimizer 各 2 次（圈 3 入口即短路）。
    expect(calls['draft-writer-agent']).toBe(2);
    expect(calls['route-agent']).toBe(2);
    expect(calls['revision-optimizer-node']).toBe(2);
  });

  it('对照：草稿每圈真实变化 → 断路器不触发（正常烧到 cap 超限，非短路文案）', async () => {
    const calls: Record<string, number> = {};
    const chain = buildStallChain({
      draftTexts: ['正文一稿', '正文二稿', '正文三稿'],
      guardVerdicts: ['clean'],
      routeDecisions: ['auto_revise'],
      calls,
    });

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: STALL_LOOPS },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    // 烧满 cap 3（首判 + 3 次回环 = route 4 次判决；三圈草稿各异非空转）→ cap 超限错误（非短路文案）。
    expect(calls['route-agent']).toBe(4);
    expect(snapshot.errors?.some((e) => e.includes('loop cap (3) reached'))).toBe(true);
    expect(snapshot.errors?.some((e) => e.includes('short-circuit'))).toBe(false);
  });

  it('对照：草稿未变但 guard 判定圈间变化（clean→soft-violation）= 有进展信号 → 不短路', async () => {
    const calls: Record<string, number> = {};
    const chain = buildStallChain({
      draftTexts: ['正文'],
      guardVerdicts: ['clean', 'soft-violation', 'soft-violation'],
      routeDecisions: ['auto_revise', 'auto_revise', 'accept_as_truth'],
      calls,
    });

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: STALL_LOOPS },
      makeDeps(),
    );

    // 圈 2 guard 判定变化（指纹 guard 分量不同）→ 圈 3 入口不短路；route 三判 accept 正常终态。
    expect(snapshot.status).toBe('completed');
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('accept_as_truth');
    expect(calls['route-agent']).toBe(3);
  });
});

describe('runChain — CR-10 未知 verdict 响错（永不假 pass）', () => {
  it('route through 产出未知 decision 值 → escalate-pause（错误标注未知值；E 节点零调用不假 pass 前进）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: 'x', wordCount: 1 }, calls),
      makeRouteNode('route-agent', ['bogus_decision'], calls, [], 'final'),
      makeNode('world-extractor-physical', 'world_events.physical', { patches: [] }, calls),
    ];

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }] },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.errors?.some((e) => e.includes('unknown loop verdict') && e.includes('bogus_decision'))).toBe(true);
    // 词汇归属按 .decision 字段在场定 → route 词表覆写 escalate_user。
    expect((snapshot.artifacts['route_decision'] as { decision: string }).decision).toBe('escalate_user');
    // 修前「防御透传正常前进」会把未知判决当 pass 跑完 E 段——现在 E 节点零调用。
    expect(calls['world-extractor-physical']).toBeUndefined();
  });

  it('plan through 产出未知 verdict 值（.verdict 字段）→ plan 词表 escalate 覆写 + 写手不跑', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('brief-reviewer-node', 'plan_review', { verdict: 'wat', summary: '坏值', findings: [] }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: 'x', wordCount: 1 }, calls),
    ];

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: [{ from: 'brief-compiler-node', through: 'brief-reviewer-node', cap: 2 }] },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(snapshot.errors?.some((e) => e.includes('unknown loop verdict "wat"'))).toBe(true);
    expect((snapshot.artifacts['plan_review'] as { verdict: string }).verdict).toBe('escalate');
    expect(calls['draft-writer-agent']).toBeUndefined(); // 不前进进写手
  });
});

describe('runChain — CR-2a② 规划环 cap 耗尽 findings 保真（非两字段 stub 覆写）', () => {
  it('cap 2 耗尽 → plan_review 保留 findings[] 等字段，cap 原因并入 summary，verdict 归一 escalate', async () => {
    const calls: Record<string, number> = {};
    const findings = [
      { dimension: 'red-line', severity: 'hard', grounding: 'chapterBrief.doNotWrite', note: '红线冲突须重编' },
      { dimension: 'pacing', severity: 'soft', grounding: 'episode_outlines[0]', note: '节奏偏慢（软维度）' },
    ];
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('brief-reviewer-node', 'plan_review', { verdict: 'revise', summary: '两处发现', findings }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: 'x', wordCount: 1 }, calls),
    ];

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: [{ from: 'brief-compiler-node', through: 'brief-reviewer-node', cap: 2 }] },
      makeDeps(),
    );

    expect(snapshot.status).toBe('paused');
    expect(snapshot.escalatePause).toBe(true);
    expect(calls['brief-reviewer-node']).toBe(3); // 两圈 revise 后第三判 cap 耗尽
    const planReview = snapshot.artifacts['plan_review'] as {
      verdict: string;
      summary: string;
      findings: typeof findings;
    };
    expect(planReview.verdict).toBe('escalate');
    // findings 全量保留（裁决材料保真——修前 stub 覆写会毁掉证据）。
    expect(planReview.findings).toEqual(findings);
    expect(planReview.summary).toContain('两处发现');
    expect(planReview.summary).toContain('规划环回环上限');
  });
});

describe('summarizeRunSnapshot — CR-2a① planEscalate 载荷 + CR-11 planReviewSkipped 投影', () => {
  const planEscalateRun = (over: Partial<RunSnapshot>): RunSnapshot => ({
    runId: 'r-plan-esc',
    status: 'paused',
    currentNodeId: 'brief-reviewer-node',
    projectPath: '/p',
    completedNodes: ['brief-compiler-node', 'brief-reviewer-node'],
    pendingNodes: [],
    artifacts: {
      plan_review: {
        verdict: 'escalate',
        summary: '红线与可写性冲突，灰区上报',
        findings: [
          { dimension: 'red-line', severity: 'hard', grounding: 'chapterBrief.doNotWrite', note: '红线冲突' },
          { dimension: 'writability', severity: 'hard', grounding: 'scene_graph.s_direct', note: '场内无可写冲突解决路径' },
        ],
      },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
    escalatePause: true,
    ...over,
  });

  it('规划环灰区（escalate-pause + plan_review.verdict=escalate + route 未跑）→ planEscalate {verdict, loopLabel, summary, findings 保真}', () => {
    const summary = summarizeRunSnapshot(planEscalateRun({}));
    expect(summary.planEscalate).toEqual({
      verdict: 'escalate',
      loopLabel: 'plan',
      summary: '红线与可写性冲突，灰区上报',
      findings: [
        { dimension: 'red-line', severity: 'hard', grounding: 'chapterBrief.doNotWrite', note: '红线冲突' },
        { dimension: 'writability', severity: 'hard', grounding: 'scene_graph.s_direct', note: '场内无可写冲突解决路径' },
      ],
    });
    // 自审环灰区载荷（escalateFindings）不重复报（route 未跑无 review 抽取）。
    expect(summary.escalateFindings).toBeUndefined();
  });

  it('自审环灰区（route_decision=escalate_user）→ 不产 planEscalate（走既有 escalateFindings 载荷）', () => {
    const summary = summarizeRunSnapshot(
      planEscalateRun({
        currentNodeId: 'route-agent',
        completedNodes: ['route-agent'],
        artifacts: {
          route_decision: { decision: 'escalate_user', reason: '灰区' },
          'review.latest': { verdict: 'escalate', dimensions: [{ name: 'consistency', findings: [{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }] }] },
        },
      }),
    );
    expect(summary.planEscalate).toBeUndefined();
    expect(summary.escalateFindings).toHaveLength(1);
  });

  it('plan_review.skipped=true（graceful 跳过）→ planReviewSkipped=true 投影（任意 status）', () => {
    const summary = summarizeRunSnapshot(
      planEscalateRun({
        status: 'completed',
        currentNodeId: null,
        escalatePause: undefined,
        artifacts: { plan_review: { verdict: 'pass', summary: '规划审核失败跳过', findings: [], skipped: true } },
      }),
    );
    expect(summary.planReviewSkipped).toBe(true);
  });

  it('plan_review 无 skipped → planReviewSkipped 缺省（零噪音）', () => {
    const summary = summarizeRunSnapshot(
      planEscalateRun({
        status: 'completed',
        currentNodeId: null,
        escalatePause: undefined,
        artifacts: { plan_review: { verdict: 'pass', summary: '卡可写', findings: [] } },
      }),
    );
    expect(summary.planReviewSkipped).toBeUndefined();
  });
});

describe('runChain — CR-3a escalate-pause 裁决 accept 续跑补发终稿 checkpoint', () => {
  /** 单环链：brief(0,brief) → writer(1) → route(2, through, final) → E1(3)。 */
  function buildFinalChain(routeDecisions: string[], calls: Record<string, number>): ChainNodeDef[] {
    return [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls, [], 'brief'),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: '正文', wordCount: 2 }, calls),
      makeRouteNode('route-agent', routeDecisions, calls, [], 'final'),
      makeNode('world-extractor-physical', 'world_events.physical', { patches: [] }, calls),
    ];
  }
  const LOOPS = [{ from: 'brief-compiler-node', through: 'route-agent', cap: 3 }];

  it('第一腿 escalate-pause → 裁决 accept 续跑（suggest 档）→ 补发 stage=final pause（AC2b「C7 的进 D」）', async () => {
    // 第一腿：route 判 escalate_user → escalate-pause（route 已进 completedNodes）。
    const callsA: Record<string, number> = {};
    const first = await runChain(
      { chain: buildFinalChain(['escalate_user'], callsA), initialArtifacts: {}, requirement: '', loops: LOOPS },
      makeDeps(),
    );
    expect(first.status).toBe('paused');
    expect(first.escalatePause).toBe(true);
    expect(first.completedNodes).toContain('route-agent');

    // 第二腿：裁决 accept → resume 续跑（mirror 生产：runChapterChain resume fromSnapshot）。
    // suggest 档 policy → 补发的终稿 checkpoint pause（终稿卡可达）。
    const callsB: Record<string, number> = {};
    const onCheckpoint = vi.fn(
      async (stage: CheckpointStage) =>
        stage === 'final' ? { action: 'pause' as const } : { action: 'continue' as const },
    );
    const second = await runChain(
      {
        chain: buildFinalChain(['escalate_user'], callsB),
        initialArtifacts: first.artifacts,
        requirement: '',
        loops: LOOPS,
        resumedCompletedNodes: first.completedNodes,
        onCheckpoint,
      },
      makeDeps(),
    );

    // 补发：stage='final' checkpoint fire（route 在 completed 前缀被跳过，不补发则终稿卡结构性不可达）。
    expect(second.status).toBe('paused');
    expect(second.escalatePause).toBeUndefined(); // 新 run 非 escalate-pause 形态（终稿审阅卡路由）
    expect(second.currentNodeId).toBe('route-agent');
    expect(onCheckpoint.mock.calls.some((c) => c[0] === 'final')).toBe(true);
    // 标记 artifact 先置（persist 随 onCheckpoint 闭包持久——防补发死环）。
    expect(second.artifacts[FINAL_CHECKPOINT_SUPPLEMENTED_KEY]).toBe(true);
    // E 段未跑（pause 抢断）。
    expect(callsB['world-extractor-physical']).toBeUndefined();
    // pausedStage 解析（mirror runChapterChain pauseHint 生产路径）→ 终稿卡载荷。
    const pauseHint = { pausedStage: resolveCheckpointStage(buildFinalChain([], {}), second.currentNodeId) };
    const summary = summarizeRunSnapshot(second, pauseHint);
    expect(summary.pausedStage).toBe('final');
    expect(summary.draftContent).toBe('正文');
  });

  it('终稿卡 accept 再续跑（标记在）→ 不再补发 → E 段跑完 completed', async () => {
    // 接上例形态：补发 pause 后的 snapshot（标记 + route completed + escalate route_decision）。
    const calls: Record<string, number> = {};
    const artifacts: Record<string, unknown> = {
      chapter_brief: { goal: 'g' },
      'draft.initial': { title: 't', text: '正文', wordCount: 2 },
      route_decision: { decision: 'escalate_user', reason: '灰区（已裁决 accept）' },
      [FINAL_CHECKPOINT_SUPPLEMENTED_KEY]: true,
    };
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const snapshot = await runChain(
      {
        chain: buildFinalChain(['escalate_user'], calls),
        initialArtifacts: artifacts,
        requirement: '',
        loops: LOOPS,
        resumedCompletedNodes: ['brief-compiler-node', 'draft-writer-agent', 'route-agent'],
        onCheckpoint,
      },
      makeDeps(),
    );

    // 标记在 → 不再补发 final（onCheckpoint 零 'final' 调用）→ E 段跑完。
    expect(onCheckpoint.mock.calls.filter((c) => c[0] === 'final')).toHaveLength(0);
    expect(snapshot.status).toBe('completed');
    expect(calls['world-extractor-physical']).toBe(1);
  });

  it('auto 档（policy 无 final）→ 补发 fire 但 continue（零行为差，E 段照常）', async () => {
    const calls: Record<string, number> = {};
    const artifacts: Record<string, unknown> = {
      chapter_brief: { goal: 'g' },
      'draft.initial': { title: 't', text: '正文', wordCount: 2 },
      route_decision: { decision: 'escalate_user', reason: '灰区（auto-trust 采信）' },
    };
    const onCheckpoint = vi.fn(async () => ({ action: 'continue' as const }));
    const snapshot = await runChain(
      {
        chain: buildFinalChain(['escalate_user'], calls),
        initialArtifacts: artifacts,
        requirement: '',
        loops: LOOPS,
        resumedCompletedNodes: ['brief-compiler-node', 'draft-writer-agent', 'route-agent'],
        onCheckpoint,
      },
      makeDeps(),
    );

    // 补发 fire 一次（continue）→ E 段跑完 completed（auto 档终稿不停）。
    expect(onCheckpoint.mock.calls.filter((c) => c[0] === 'final')).toHaveLength(1);
    expect(snapshot.status).toBe('completed');
    expect(calls['world-extractor-physical']).toBe(1);
  });

  it('不补发的两形态：自然终稿 pause 续跑（decision=accept_as_truth）与 redo 腿（pointer 停更早）', async () => {
    // 自然终稿 pause 续跑：route_decision=accept_as_truth → 非 escalate-accept 指纹，不补发。
    const callsA: Record<string, number> = {};
    const onCheckpointA = vi.fn(async () => ({ action: 'continue' as const }));
    const natural = await runChain(
      {
        chain: buildFinalChain(['accept_as_truth'], callsA),
        initialArtifacts: {
          chapter_brief: { goal: 'g' },
          'draft.initial': { title: 't', text: '正文', wordCount: 2 },
          route_decision: { decision: 'accept_as_truth', reason: '终稿可接受' },
        },
        requirement: '',
        loops: LOOPS,
        resumedCompletedNodes: ['brief-compiler-node', 'draft-writer-agent', 'route-agent'],
        onCheckpoint: onCheckpointA,
      },
      makeDeps(),
    );
    expect(onCheckpointA.mock.calls.filter((c) => c[0] === 'final')).toHaveLength(0);
    expect(natural.status).toBe('completed');

    // 裁决 revise redo：draft-writer 移除 → pointer 停 index1（finalDef 在其后）→ 不补发。
    const callsB: Record<string, number> = {};
    const onCheckpointB = vi.fn(async () => ({ action: 'continue' as const }));
    const redo = await runChain(
      {
        chain: buildFinalChain(['accept_as_truth'], callsB),
        initialArtifacts: {
          chapter_brief: { goal: 'g' },
          'draft.initial': { title: 't', text: '正文', wordCount: 2 },
          route_decision: { decision: 'escalate_user', reason: '灰区（裁决 revise 回环）' },
        },
        requirement: '',
        loops: LOOPS,
        resumedCompletedNodes: ['brief-compiler-node'], // redo：draft-writer 移除 → 前缀断在 idx1
        onCheckpoint: onCheckpointB,
      },
      makeDeps(),
    );
    // redo 腿不补发：唯一的 'final' fire 是 route 重跑 accept 终态处理的自然 checkpoint（若入口
    // 补发误触发会是 2 次——入口 1 次先于任何节点 + 自然 1 次）。
    expect(onCheckpointB.mock.calls.filter((c) => c[0] === 'final')).toHaveLength(1);
    expect(callsB['draft-writer-agent']).toBe(1); // 前缀断在写手位重跑
    expect(redo.status).toBe('completed'); // writer/route 重跑后 accept 终态
  });
});

describe('runChain — CR-17 completedNodes 去重锚（环重跑不重复入列）', () => {
  it('auto_revise 回环重跑 → completedNodes 各节点 id 仅出现一次（集合语义）', async () => {
    const calls: Record<string, number> = {};
    const chain: ChainNodeDef[] = [
      makeNode('brief-compiler-node', 'chapter_brief', { goal: 'g' }, calls),
      makeNode('revision-optimizer-node', 'revision_intent', { change: { summary: 's' } }, calls),
      makeNode('draft-writer-agent', 'draft.initial', { title: 't', text: 'x', wordCount: 1 }, calls),
      makeNode('multi-review-agent', 'review.latest', { verdict: 'revise' }, calls),
      makeRouteNode('route-agent', ['auto_revise', 'accept_as_truth'], calls),
    ];

    const snapshot = await runChain(
      { chain, initialArtifacts: {}, requirement: '', loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 3 }] },
      makeDeps(),
    );

    expect(snapshot.status).toBe('completed');
    expect(calls['route-agent']).toBe(2); // 环体重跑了一轮
    // 去重：环体节点重跑不重复 append（持久化快照 completedNodes 消费者按集合语义读）。
    expect(snapshot.completedNodes.length).toBe(new Set(snapshot.completedNodes).size);
    expect(snapshot.completedNodes).toEqual([
      'brief-compiler-node',
      'revision-optimizer-node',
      'draft-writer-agent',
      'multi-review-agent',
      'route-agent',
    ]);
  });
});
