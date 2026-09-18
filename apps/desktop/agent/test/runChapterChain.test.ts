import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateFn } from '../src/nodes/llm-node';
import { deriveCheckpointPolicy, type RunSnapshot } from '../src/contracts/run';

// Story 4.0 §4.7 / implement.md 5.5：runChapterChain runtime 方法测试。
// mock generate（按 system 内容返 fixture）+ 真 dispatchSubagent（建 child session 跑 complete 回调内 runChain）。

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// 按 prompts/*.yaml system 段标记区分节点（路由判决 / Reader-Audit 双层审核 / 写作者 / 5 轴状态提取）。
// Story 4.2：multi-review 节点换为 Reader-Audit composite，yaml system 段含「Reader-Audit 双层审核员」。
// Story 6.6 Phase C1/C2：5 轴 world-extractor 提取器（physical/cognitive/emotional/relational/factional），
// 各轴 yaml system 段含「<轴>状态提取专家」——共同子串「状态提取」路由到同一 extractor fixture（空 patches）。
function makeChainGenerate(
  overrides: Partial<{ draft: object; review: object; route: object; extractor: object; completeness: object; storySync: object; planReview: object }> = {},
): ReturnType<typeof vi.fn<GenerateFn>> {
  const draft = overrides.draft ?? { title: '第二章 B 城', text: '黄昏的荒野上，主角深吸一口气。', wordCount: 2800, chapterId: 'ep1' };
  const review = overrides.review ?? { verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] };
  const route = overrides.route ?? { decision: 'accept_as_truth', reason: '正文把动机写实了，是升级' };
  // 提取器输出（AxisExtraction 根 shape：storyTime + title + subjects + patches；空 patches 走 merge 无 write）
  const extractor = overrides.extractor ?? { storyTime: 5, title: '状态切面', subjects: [], patches: [] };
  // Story 4.4 + BMad CR-002 fix：completeness-verify 移 route 前后 always 跑（原 route 后 through-break 不可达）。
  // 「完整性审核」matcher 须在 generic「审核」前（completeness-verify system 含「审核」子串）。
  const completeness = overrides.completeness ?? { findings: [], summary: '无缺漏', degraded: false };
  // Story 2.2 WP-E：story-sync 真跑 LLM 提取（system 首句「你是 story-sync-agent」）。默认空 patches
  // （NovelStorySyncPayload 形态；parseStorySyncResponse 强制 runId/chapterId）。
  const storySync = overrides.storySync ?? { runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' };
  // 链流程重排 W1d：brief-reviewer（A2 规划审核，system「规划审核」）——pass 直通（规划环零回环）。
  const planReview = overrides.planReview ?? { verdict: 'pass', summary: '卡可写', findings: [] };
  return vi.fn<GenerateFn>(async (_msgs, sys) => {
    const s = sys ?? '';
    if (s.includes('规划审核')) return { content: JSON.stringify(planReview), finishReason: 'stop' };
    if (s.includes('路由判决')) return { content: JSON.stringify(route), finishReason: 'stop' };
    // completeness-verify L2（「完整性审核」——须在 generic「审核」前匹配）
    if (s.includes('完整性审核')) return { content: JSON.stringify(completeness), finishReason: 'stop' };
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) return { content: JSON.stringify(review), finishReason: 'stop' };
    // 5 轴提取器共同标记「状态提取」（physical/cognitive/emotional/relational/factional 各含）
    if (s.includes('状态提取')) return { content: JSON.stringify(extractor), finishReason: 'stop' };
    // Story 2.2 WP-E：story-sync-agent 提取节点（真跑 LLM）
    if (s.includes('story-sync-agent')) return { content: JSON.stringify(storySync), finishReason: 'stop' };
    return { content: JSON.stringify(draft), finishReason: 'stop' };
  });
}

/** draftCall 匹配谓词：system 不含其他节点标记（路由/审核/修订/状态提取/完整性审核）→ 是 draft-writer 调用。 */
function isDraftSystem(sys: unknown): boolean {
  const s = typeof sys === 'string' ? sys : '';
  return (
    !s.includes('规划审核') &&
    !s.includes('路由判决') &&
    !s.includes('Reader-Audit') &&
    !s.includes('多维度') &&
    !s.includes('审核') &&
    !s.includes('完整性审核') &&
    !s.includes('改稿意图编译器') &&
    !s.includes('修订编辑') &&
    !s.includes('状态提取') &&
    !s.includes('story-sync-agent')
  );
}

describe('WorkflowRuntime.runChapterChain（Story 4.0 §4.7）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-run-chapter-chain-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  async function makeRuntime(generate: ReturnType<typeof vi.fn<GenerateFn>>, runState?: any) {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({ generate, ...(runState ? { runState } : {}) });
    return runtime;
  }

  async function makeParent(runtime: any) {
    return runtime.createSession({ agentName: 'creative-director', projectPath });
  }

  function makeInitialArtifacts(): Record<string, unknown> {
    return {
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1' }] },
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'REACH_B_CITY_GOAL', tone: '紧张' } },
      settings_context: 'PREFIX_SETTINGS_TEXT',
      promise_registry: { promises: [], beats: [], version: 0 },
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. context isolation：返 summary（非全 snapshot）
  // ════════════════════════════════════════════════════════════════════════════

  it('返 RunSnapshotSummary（context isolation：只 status/routeDecision/reviewVerdict/draft*/errors，无 artifacts/completedNodes）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts());

    // summary shape（RunSnapshotSummary 字段）
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision).toEqual({ decision: 'accept_as_truth', reason: '正文把动机写实了，是升级' });
    expect(summary.reviewVerdict).toBe('pass');
    expect(summary.draftTitle).toBe('第二章 B 城');
    expect(summary.draftWordCount).toBe(2800);
    expect(Array.isArray(summary.errors)).toBe(true);
    // context isolation：不含内部 trace / 全量 artifacts
    const keys = Object.keys(summary);
    expect(keys).not.toContain('artifacts');
    expect(keys).not.toContain('completedNodes');
    expect(keys).not.toContain('scene_graph');
    expect(keys).not.toContain('chapter_brief');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. initialArtifacts 透传 runChain（draft-writer 收到 scene_graph/settings_context）
  // ════════════════════════════════════════════════════════════════════════════

  it('initialArtifacts 透传到链段节点（draft-writer user prompt 含 chapter_brief goal + settings_context）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    await runtime.runChapterChain(parent.id, makeInitialArtifacts());

    // draft-writer 是第 1 次 generate 调用（brief-compiler/storySync/world-merge 不调 generate）
    const draftCall = generate.mock.calls.find(([_msgs, sys]: any) => isDraftSystem(sys));
    expect(draftCall).toBeDefined();
    const userContent = (draftCall![0] as any)[0]?.content ?? '';
    // chapter_brief 经 brief-compiler 透传 leader goal（chapter_brief_input.brief.goal）
    expect(userContent).toContain('REACH_B_CITY_GOAL');
    // settings_context 标量直注 draft-writer 的 {{projectContext}}
    expect(userContent).toContain('PREFIX_SETTINGS_TEXT');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. abort → ChainAbortedError → 返 aborted summary
  // ════════════════════════════════════════════════════════════════════════════

  it('abort（signal 已 abort）→ 返 status=aborted summary（ChainAbortedError 被 catch）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const controller = new AbortController();
    controller.abort();

    // dogfood R2 #105 R2.5（AC9）：链被掐的服务端收口日志——修前 abort 路径全线零日志
    //（「中断原因未上日志」诊断盲区）。断言 warn 携 sessionId + msg（真机排障的 join key）。
    const { logger } = await import('../src/logger');
    const abortLogSpy = vi.spyOn(logger, 'warn');

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      abort: controller.signal,
    });

    expect(summary.status).toBe('aborted');
    // abort 在任何节点前（预检）→ 未触 route，routeDecision 无
    expect(summary.routeDecision).toBeUndefined();
    // generate 不应被调（预检在首节点前抛）
    expect(generate).not.toHaveBeenCalled();
    // 服务端 abort 留痕（workflow.ts ChainAbortedError catch）——sessionId + reason 可诊断。
    expect(abortLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: parent.id }),
      'chapter chain aborted',
    );
    abortLogSpy.mockRestore();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. chainSnapshot 持久（persistChainSnapshot 经 onCheckpoint 写 RunStateStore）
  // ════════════════════════════════════════════════════════════════════════════

  it('chainSnapshot 持久到 RunStateStore（onCheckpoint brief/draft/verdict 三点 → setChainSnapshot 被调）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const setChainSpy = vi.spyOn(runState, 'setChainSnapshot');
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    await runtime.runChapterChain(parent.id, makeInitialArtifacts());

    // brief/draft/verdict 三 checkpoint → setChainSnapshot 至少 3 次
    expect(setChainSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    // 首 checkpoint（brief）后 snapshot 含 chapter_brief artifact
    const firstSnapshot = setChainSpy.mock.calls[0][1];
    expect(firstSnapshot.artifacts['chapter_brief']).toBeDefined();
    // 持久到 RunStateStore（getSnapshot 能查到 chainSnapshot——child session id 各异，遍历查任一）
    const sessionsWithChain = setChainSpy.mock.calls.map((c) => c[0]);
    const persisted = runState.getSnapshot(sessionsWithChain[0])?.chainSnapshot;
    expect(persisted).toBeDefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. 链内回环端到端（W1a：auto_revise → 环体重跑 → 二判 accept 终态——不 break 交 leader）
  // ════════════════════════════════════════════════════════════════════════════

  it('W1d：auto_revise → 链内回环（C1 编译 + 写手改稿轮重跑）→ route 二判 accept 终态（经 runChapterChain 包装层）', async () => {
    // route 第 1 次返 auto_revise（链内回环重跑环体），第 2 次返 accept（收敛终态）
    let routeCallIdx = 0;
    let writerRound = 0;
    const generate = vi.fn<GenerateFn>(async (_msgs, sys) => {
      const s = sys ?? '';
      if (s.includes('规划审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '卡可写', findings: [] }), finishReason: 'stop' };
      }
      if (s.includes('路由判决')) {
        routeCallIdx += 1;
        const decision = routeCallIdx === 1 ? 'auto_revise' : 'accept_as_truth';
        return { content: JSON.stringify({ decision, reason: `mock ${decision}` }), finishReason: 'stop' };
      }
      // C1 revision-optimizer 环回圈编译（system「改稿意图编译器」）——anchorless intent
      if (s.includes('改稿意图编译器')) {
        return {
          content: JSON.stringify({
            change: { summary: '补动机' },
            lockedItems: [],
            rationale: { source: 'audit-finding', note: 'A-trigger' },
            provenance: { rawUserInstruction: '据 Reader-Audit 审核发现修订', compilerNote: 'C1' },
          }),
          finishReason: 'stop',
        };
      }
      // completeness-verify L2（「完整性审核」——须在 generic「审核」前匹配）
      if (s.includes('完整性审核')) {
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        return { content: JSON.stringify({ verdict: 'revise', summary: '需改', dimensions: [], reasons: ['r'] }), finishReason: 'stop' };
      }
      // world-extractor（5 轴提取器，共同标记「状态提取」）—— 6.6 Phase C1/C2
      if (s.includes('状态提取')) {
        return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      }
      // story-sync（WP-E）——须在默认分支前
      if (s.includes('story-sync-agent')) {
        return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
      }
      // draft-writer（默认分支）：首圈整章首写 / 环回圈带 revision_intent 的改稿轮（写手单位置 B/C2）
      writerRound += 1;
      const draft = writerRound === 1
        ? { title: '章', text: '正文', wordCount: 100, chapterId: 'ep1' }
        : { title: '章', text: '修订正文', wordCount: 120, chapterId: 'ep1' };
      return { content: JSON.stringify(draft), finishReason: 'stop' };
    });
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts());

    // W1a+W1d：auto_revise 链内回环——环体（C1 编译 + 写手改稿轮 + 审读 + 完整性 + 路由）重跑后
    // route 二判 accept → completed（无 auto_revise_pending）。
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    // 调用计数：首轮 5（brief-reviewer + draft-writer + multi-review + completeness-verify + route）+
    // 回环 5（revision-optimizer 编译 + 写手改稿轮 + multi-review + completeness-verify + route）+
    // 提取段 6（5 轴 world-extractor + story-sync，route accept 后一次）= 16。
    expect(generate.mock.calls.length).toBe(16);
    // 修订稿落定（环内写手带 directive 改稿轮 overwrite draft.initial——targeted-revision 已退役）
    expect(summary.draftText).toBe('修订正文');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Story 4.3 Step 1 / CR-2：resume 读回（runChapterChain options.resume.fromSnapshot）
  //    预设 chainSnapshot（completedNodes=brief+draft）→ runChapterChain({resume}) → runChain 跳过已完成节点。
  // ════════════════════════════════════════════════════════════════════════════

  /** 构造 chainSnapshot（RunSnapshot）——mirror runChain 产出的形态，供 resume 读回。
   * W1d 新链序：draft checkpoint 停点的真实 completed 前缀 = [brief-compiler, brief-reviewer,
   * revision-optimizer, draft-writer]（A1→A2→C1 no-op→B 后停在写手位）。 */
  function makeChainSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
    return {
      runId: 'run-resume-1',
      status: 'paused',
      currentNodeId: 'draft-writer-agent',
      projectPath,
      completedNodes: ['brief-compiler-node', 'brief-reviewer-node', 'revision-optimizer-node', 'draft-writer-agent'],
      pendingNodes: ['revision-guard-agent', 'lint-node', 'multi-review-agent', 'completeness-verify-node', 'route-agent', 'story-sync-agent', 'feedback-ledger-node'],
      artifacts: {
        ...makeInitialArtifacts(),
        chapter_brief: { goal: 'REACH_B_CITY_GOAL', tone: '紧张', episodeId: 'ep1' },
        'draft.initial': { title: '第二章 B 城', text: '黄昏的荒野上，主角深吸一口气。', wordCount: 2800, chapterId: 'ep1' },
        'story.sync': { items: [], version: 0 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
      ...overrides,
    };
  }

  it('resume（fromSnapshot=true）：读回 chainSnapshot → 跳过 brief+draft（draft-writer generate 不调）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    // 预设 chainSnapshot（parent.id 下）——brief+draft 已完成
    runState.setChainSnapshot(parent.id, makeChainSnapshot());

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
    });

    // 链段续跑完成（route accept 终止）
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    // draft-writer 被跳过 → generate 调 9 次（5 轴 world-extractor + multi-review + completeness-verify +
    // route + story-sync（2.2 WP-E 激活 LLM 提取）），无 draft 调用
    expect(generate.mock.calls.length).toBe(9);
    // 无 draft-writer 调用（所有 generate 调用都是 review/route system）
    const hasDraftCall = generate.mock.calls.some(([_msgs, sys]: any) => isDraftSystem(sys));
    expect(hasDraftCall).toBe(false);
    // draft.initial 从 snapshot 恢复（未被重跑覆盖）——summary 抽 resume 时的稿
    expect(summary.draftTitle).toBe('第二章 B 城');
    expect(summary.draftWordCount).toBe(2800);
  });

  // dogfood T1 CR-T1-054：resume 跳过的节点不 fire onNodeDone + UI 侧 freshRun 清 completedNodes
  // → 步进条空心前缀。装配层对最终 skip 集补发重放 done（UI 点亮前缀后才见新节点步进）。
  it('resume + emitChainEvent → resumedCompletedNodes 重放 chain-node-done（brief+draft 先于任何新节点事件）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);
    runState.setChainSnapshot(parent.id, makeChainSnapshot()); // brief+draft completed, paused

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    // 重放前缀在事件流最前（runChain 首节点事件之前）：snapshot completedNodes 链序
    //（W1d 新链前缀：brief-compiler → brief-reviewer → revision-optimizer → draft-writer）。
    expect(events[0]).toEqual({ type: 'chain-node-done', data: { nodeId: 'brief-compiler-node', status: 'done' } });
    expect(events[1]).toEqual({ type: 'chain-node-done', data: { nodeId: 'brief-reviewer-node', status: 'done' } });
    expect(events[2]).toEqual({ type: 'chain-node-done', data: { nodeId: 'revision-optimizer-node', status: 'done' } });
    expect(events[3]).toEqual({ type: 'chain-node-done', data: { nodeId: 'draft-writer-agent', status: 'done' } });
    // 之后是真跑的新节点步进 + 哨兵终态帧（重放不吞新事件）。
    const dones = events.filter((e) => e.type === 'chain-node-done').map((e) => e.data);
    expect(dones[dones.length - 1]).toEqual({ nodeId: '__chain_run__', status: 'completed' });
    const prefixIds = ['brief-compiler-node', 'brief-reviewer-node', 'revision-optimizer-node', 'draft-writer-agent'];
    const newNodes = dones.filter((d) => !prefixIds.includes(d.nodeId as string) && d.nodeId !== '__chain_run__');
    expect(newNodes.length).toBeGreaterThan(0);
  });

  it('resume（fromSnapshot=true）但 chainSnapshot 缺 → graceful 降级从头跑（draft generate 调）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    // 不预设 chainSnapshot → resume 读回 undefined → 降级从头跑
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
    });

    expect(summary.status).toBe('completed');
    // 从头跑 → generate 11 次（brief-reviewer + draft-writer + 5 轴 world-extractor + multi-review +
    // completeness-verify + route + story-sync（2.2 WP-E）；C1 首圈 no-op 零调用）
    expect(generate.mock.calls.length).toBe(11);
    const hasDraftCall = generate.mock.calls.some(([_msgs, sys]: any) => isDraftSystem(sys));
    expect(hasDraftCall).toBe(true);
  });

  it('不传 resume（缺省）→ 从头跑（4.0 行为零回归，不读 chainSnapshot）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const getChainSpy = vi.spyOn(runState, 'getChainSnapshot');
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    // 预设 chainSnapshot 但不传 resume → 不应被读（从头跑）
    runState.setChainSnapshot(parent.id, makeChainSnapshot());

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts());

    expect(summary.status).toBe('completed');
    // 缺省 resume → getChainSnapshot 不被调（不读回）
    expect(getChainSpy).not.toHaveBeenCalled();
    // 从头跑 → draft 调（generate 10 次：draft + 5 轮 world-extractor + multi-review + completeness-verify
    // + route + story-sync（2.2 WP-E））
    expect(generate.mock.calls.length).toBe(11); // W1d：+brief-reviewer（规划审核 LLM）——C1 首圈 no-op 零调用
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. CR-2 key 对齐：onCheckpoint 真写路径用 parentSessionId（非 childSession.id）
  //    controller fresh-verify 纠 subagent Step 1 遗漏——写读 key 必须一致才闭合。
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-2 key 对齐：onCheckpoint 真写路径用 parentSessionId（非 childSession.id，resume 读同 key 命中）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const setChainSpy = vi.spyOn(runState, 'setChainSnapshot');
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    await runtime.runChapterChain(parent.id, makeInitialArtifacts());

    expect(setChainSpy.mock.calls.length).toBeGreaterThanOrEqual(3); // brief/draft/verdict
    // 所有点 checkpoint 写都在 parent.id 下——生产 resume 读 getChainSnapshot(parentSessionId) 须命中。
    // （修前：写 childSession.id ≠ parent.id → resume 永远读不到 → 降级从头跑，CR-2 不闭合）
    expect(setChainSpy.mock.calls.every((c) => c[0] === parent.id)).toBe(true);
    expect(runState.getChainSnapshot(parent.id)).toBeDefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. CR-2 跨 turn round-trip：pause 写 → turn 结束 completeRun → 新 turn beginRun → resume 读回命中
  //    controller fresh-verify 纠 subagent Step 1 遗漏——跨 turn 存活（beginRun 保留 chainSnapshot）。
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-2 跨 turn：pause 写 chainSnapshot → completeRun → 新 turn beginRun → resume 读回命中（不降级，跳 brief+draft）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const getChainSpy = vi.spyOn(runState, 'getChainSnapshot');
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    // 模拟 Turn 1 末链段在 draft checkpoint pause（Step 2 落地真 pause，本步用预设 snapshot 代）
    runState.setChainSnapshot(parent.id, makeChainSnapshot()); // completedNodes=brief+draft, paused
    runState.completeRun(parent.id); // Turn 1 leader runLoop 结束

    // 模拟 Turn 2 开始：leader sendMessage → beginRun(parent.id) 建 running snapshot
    runState.beginRun(parent.id);

    // chainSnapshot 跨 completeRun + beginRun 存活（CR-2 闭环跨 turn 关键）
    expect(runState.getChainSnapshot(parent.id)).toBeDefined();
    expect(runState.getChainSnapshot(parent.id)?.completedNodes).toContain('draft-writer-agent');

    // Turn 2：resume → 读回命中 → 跳 brief+draft
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
    });

    expect(getChainSpy).toHaveBeenCalledWith(parent.id);
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    // draft-writer 跳过 → generate 9 次（5 轮 world-extractor + multi-review + completeness-verify + route
    // + story-sync（2.2 WP-E））
    expect(generate.mock.calls.length).toBe(9);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 9. Story 4.3 Step 2：mode-driven pause（CheckpointPolicy.pauseStages → 链段在 checkpoint 中断）
  // ════════════════════════════════════════════════════════════════════════════

  it('mode.pauseStages=["draft"]：链段在 draft checkpoint pause（summary.status=paused + pausedStage + draftContent）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: { pauseStages: ['draft'], escalateMode: 'ask' },
    });

    // draft checkpoint pause → status='paused' + pausedStage='draft'
    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('draft');
    // draftContent = draft.initial.text（review payload，豁免 context isolation）
    expect(summary.draftContent).toBe('黄昏的荒野上，主角深吸一口气。');
    // draft checkpoint 后 pause → route 未跑（routeDecision 缺省，链段未到 verdict）
    expect(summary.routeDecision).toBeUndefined();
    // brief checkpoint 通过（continue，不在 pauseStages）→ brief-compiler + brief-reviewer + draft-writer
    // 跑了；generate 调 2 次（brief-reviewer + draft-writer；提取段在 route 后未达；multi-review 未到）
    expect(generate.mock.calls.length).toBe(2);
  });

  it('mode = deriveCheckpointPolicy("suggest")：pauseStages=["final"]（链流程重排 W2——终稿人审一次，route accept 后停）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('suggest'),
    });

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('final');
    // draftContent = 终稿正文（终稿卡可编辑源，豁免 context isolation）
    expect(summary.draftContent).toBe('黄昏的荒野上，主角深吸一口气。');
    // route accept 终态已处理（final pause 在终态后 fire）——onAccept 未调（W2 移 E 段完成后）
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    expect(summary.chapter_accept).toBeUndefined();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // dogfood R2 #93 P0-1（2026-08-28）：draft checkpoint 草稿即落章档案——
  // .orison/chapter-archive/<archiveDirName(episodeId)>/draft-v<N>.md（与 research-brief.json 同目录）。
  // 审阅卡只是视图：正文此前只在 UI 内存 + in-memory chainSnapshot，点「继续写」后随卡片清除
  //（实录两版 3126 字稿彻底丢失）。
  // ════════════════════════════════════════════════════════════════════════════

  /** 章档案目录路径 helper（episodeId 'ep1' 的 .orison/chapter-archive/<dir>）。 */
  async function archiveDirFor(episodeId: string): Promise<string> {
    const { archiveDirName } = await import('../src/nodes/writer-node');
    return path.join(projectPath, '.orison', 'chapter-archive', archiveDirName(episodeId));
  }

  it('#93 P0-1：draft checkpoint pause → draftText 即落 draft-v1.md（同目录 archiveDirName 单源）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      // W2：draft 已退出 deriveCheckpointPolicy 停点集——显式 draft policy 钉原场景（归档行为挂
      // draft checkpoint fire，与档位映射解耦）。
      mode: { pauseStages: ['draft'], escalateMode: 'ask' },
    });

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('draft');
    const dir = await archiveDirFor('ep1');
    // draft-v1.md 存在且内容 = draft.initial.text（readFileSync 缺文件即抛——落盘断言硬失败）。
    expect(readdirSync(dir)).toContain('draft-v1.md');
    expect(readFileSync(path.join(dir, 'draft-v1.md'), 'utf-8')).toBe('黄昏的荒野上，主角深吸一口气。');
  });

  it('#93 P0-1：redo 重跑写手 → 新版落 draft-v2.md（N = 写作轮次递增）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    // 轮 1：suggest 档 pause at draft → draft-v1.md。
    await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('suggest'),
    });

    // 轮 2：redo draft-writer（挂起恢复唯一合法动作 / 改稿重跑）→ 写手真跑 → checkpoint 再 fire → v2。
    const resumed = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      redo: { nodeId: 'draft-writer-agent' },
    });

    expect(resumed.status).toBe('completed');
    const dir = await archiveDirFor('ep1');
    const drafts = readdirSync(dir).filter((n) => /^draft-v\d+\.md$/.test(n)).sort();
    expect(drafts).toEqual(['draft-v1.md', 'draft-v2.md']);
  });

  it('#93 P0-1：resume-continue 跳过 draft-writer（checkpoint 不 refire）→ 不 bump 新版本', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('suggest'),
    });

    // continue：draft-writer 在 completedNodes 被跳过——draft checkpoint 只在节点真跑后 fire，无新版本。
    const resumed = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
    });

    expect(resumed.status).toBe('completed');
    const dir = await archiveDirFor('ep1');
    expect(readdirSync(dir).filter((n) => /^draft-v\d+\.md$/.test(n))).toEqual(['draft-v1.md']);
  });

  it('#93 P0-1 check：auto 档段落级 redo 中 abort（guard L2 期 lastStage=draft → emitAbortCheckpoint 重放 draft checkpoint）→ 同一稿不重复归档', async () => {
    // 复现窗（真链装配序 [0]brief → [1]draft-writer → [2]revision-guard → [3+]world-extractor）：
    // auto 档段落级 redo = draft-writer 产 passage → **draft checkpoint fire（归档 v2）** → revision-guard
    // L2「改稿保义裁判员」长跑 → 用户 abort → chainRunner emitAbortCheckpoint(run, lastStage='draft') 以
    // 同一 run **二次**进 onCheckpoint——修复前同一份 draft.initial 再写一版（v3 与 v2 同内容，N=写作
    // 轮次被污染）；修复按 artifact 引用去重（同一 runChain 调用内 draft.initial 同一对象）。
    let round = 1;
    const base = makeChainGenerate();
    const generate = vi.fn<GenerateFn>(async (...args: Parameters<GenerateFn>) => {
      const sys = args[1] ?? '';
      if (sys.includes('改稿保义裁判员')) {
        // round 2 的 revision-guard L2 判（段落级路径才走 L2）——draft checkpoint 已 fire，此处中止。
        throw Object.assign(new Error('user aborted'), { name: 'AbortError' });
      }
      if (round === 2) {
        // round 2 draft-writer 段落级：只产 passageText（text 由 parseDraftOutput 保前稿整章）。
        return {
          content: JSON.stringify({ title: '第二章 B 城', text: '', passageText: '改后段落', wordCount: 2800, chapterId: 'ep1' }),
          finishReason: 'stop',
        };
      }
      return base(...args);
    });
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    // 轮 1：suggest → draft checkpoint pause（归档 draft-v1 + chainSnapshot 含整章前稿）。
    const paused = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('suggest'),
    });
    expect(paused.status).toBe('paused');

    // 轮 2：redo 携 revisionIntent（段落级——draft-writer + revision-guard 都移除重跑）+ auto 档（draft
    // checkpoint 不 pause，链推进到 guard L2 才 abort——lastCheckpointStage='draft' 的重放窗口）。
    round = 2;
    const aborted = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('auto'),
      resume: { fromSnapshot: true },
      redo: {
        nodeId: 'draft-writer-agent',
        revisionIntent: {
          change: { summary: '改紧张点' },
          lockedItems: [],
          rationale: { source: 'user-directive', note: '用户选段指挥' },
          provenance: { rawUserInstruction: '改这段', compilerNote: '说明' },
          scope: { anchor: { quote: '主角深吸一口气', prefix: '黄昏的荒野上，', suffix: '。', rangeHint: { from: 7, to: 13 } } },
        },
      },
    });

    expect(aborted.status).toBe('aborted');
    // settle：emitAbortCheckpoint 是 fire-and-forget（void Promise）——若回归（去重失效），重放的归档
    // 写在后台 Promise 里，等它落地再断言（否则假绿）。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dir = await archiveDirFor('ep1');
    // 恰两版：轮 1 整章稿 + 轮 2 段落级 checkpoint 稿；abort 重放不产 v3。
    expect(readdirSync(dir).filter((n) => /^draft-v\d+\.md$/.test(n)).sort()).toEqual(['draft-v1.md', 'draft-v2.md']);
  });

  it('mode = deriveCheckpointPolicy("auto")：零回归（pauseStages=[] → 连续跑完，status=completed，无 pause）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('auto'),
    });

    // 全自动 policy → 无 scheduled pause → 连续跑完（= 4.0 行为零回归）
    expect(summary.status).toBe('completed');
    expect(summary.pausedStage).toBeUndefined();
    expect(summary.draftContent).toBeUndefined();
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    // 全跑：draft + 5 轮 world-extractor + multi-review + completeness-verify + route + story-sync（2.2 WP-E）
    // = 10 次 generate
    expect(generate.mock.calls.length).toBe(11); // W1d：+brief-reviewer（规划审核 LLM）——C1 首圈 no-op 零调用
  });

  it('mode = deriveCheckpointPolicy("readonly")：brief checkpoint 首停（pauseStages=["brief","draft","verdict"]）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('readonly'),
    });

    // 微操模式：第一个 checkpoint（brief）就 pause
    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('brief');
    // brief checkpoint 时 draft 未产 → draftContent 缺省；briefContent 抽 chapter_brief artifact
    expect(summary.draftContent).toBeUndefined();
    expect(summary.briefContent).toBeDefined();
    // W1d：brief 停点挪 A2（brief-reviewer）后——A1 纯代码 + A2 LLM 已跑 → generate 恰 1 次
    //（brief-reviewer 规划审核；写手/提取段未到）
    expect(generate).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 10. Story 4.3 Step 3：redo directive（design §3.4）。
  //    预设 chainSnapshot（completedNodes=brief+draft）→ runChapterChain({resume, redo:{nodeId:'draft-writer-agent', feedback}})
  //    → draft-writer 重跑（移除出 resumedCompletedNodes）+ feedback 进 user prompt（{{revisionFeedback}}）+ 后续续跑。
  // ════════════════════════════════════════════════════════════════════════════

  it('redo draft-writer + feedback → draft-writer 重跑（feedback 进 prompt）+ 后续续跑（review+route）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    // 预设 chainSnapshot（brief+draft 已完成，paused at draft checkpoint）
    runState.setChainSnapshot(parent.id, makeChainSnapshot());

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      redo: { nodeId: 'draft-writer-agent', feedback: '请加强紧张感，多用短句' },
    });

    // redo 移除 draft-writer 出 resumedCompletedNodes → 重跑；brief-compiler 跳过（纯代码不调 generate）。
    // generate 调用：draft-writer(重跑) + 5 轮 world-extractor + multi-review + completeness-verify + route
    // + story-sync（2.2 WP-E 激活 LLM 提取）= 10 次（targeted-revision 首跑 skip）。
    expect(generate.mock.calls.length).toBe(10);
    // draft-writer 重跑且收到 feedback（user prompt 含 feedback + 改稿反馈 directive 标签）
    const draftCall = generate.mock.calls.find(([_msgs, sys]: any) => isDraftSystem(sys));
    expect(draftCall).toBeDefined();
    const userContent = (draftCall![0] as any)[0]?.content ?? '';
    expect(userContent).toContain('请加强紧张感，多用短句');
    expect(userContent).toContain('改稿反馈');
    // 链段续跑完成（route accept）
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
  });

  it('redo 隐含 resume（只传 redo 不传 resume）→ 仍读 chainSnapshot + 重跑 draft-writer', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    runState.setChainSnapshot(parent.id, makeChainSnapshot());

    // 只传 redo（不传 resume）→ wantResume=true（redo 隐含）→ 读 snapshot
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      redo: { nodeId: 'draft-writer-agent', feedback: '改稿意见' },
    });

    expect(summary.status).toBe('completed');
    // draft-writer 重跑 → generate 10 次（draft + 5 轮 world-extractor + multi-review + completeness-verify
    // + route + story-sync（2.2 WP-E））
    expect(generate.mock.calls.length).toBe(10);
  });

  it('redo nodeId 不在 completedNodes（无效/pending）→ graceful 不移除（warn）+ feedback 仍注入', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    runState.setChainSnapshot(parent.id, makeChainSnapshot()); // brief+draft

    // redo 一个不在 completedNodes 的 nodeId（route-agent 未完成，pending）
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      redo: { nodeId: 'nonexistent-node', feedback: 'feedback' },
    });

    // graceful：snapshot 仍读（brief+draft 跳过）→ 续跑 5 轮 world-extractor + multi-review + completeness-verify
    // + route + story-sync（2.2 WP-E）= 9 次 generate（draft-writer 跳过，未移除）
    expect(summary.status).toBe('completed');
    expect(generate.mock.calls.length).toBe(9);
  });

  it('BMad CR-006：redo loopNodes 含未知 ID（不在 completedNodes）→ warn 不静默忽略', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const { logger } = await import('../src/logger');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    runState.setChainSnapshot(parent.id, makeChainSnapshot()); // completedNodes=brief+draft

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    // loopNodes 含一个合法 ID（draft-writer-agent 在 completedNodes）+ 一个未知 ID（typo）。
    await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      redo: {
        nodeId: 'brief-compiler-node', // 保留单节点 redo 接口（零回归）
        loopNodes: ['draft-writer-agent', 'typo-stale-id'],
      },
    });

    // 未知 ID 'typo-stale-id' → warn（mirror redo.nodeId unknown warn 模式）。
    const unknownWarn = warnSpy.mock.calls.find((c) =>
      JSON.stringify(c[1] ?? '').includes('unknown IDs'),
    );
    expect(unknownWarn).toBeDefined();
    // warn payload 含未知 ID + completedNodes 上下文。
    const warnPayload = unknownWarn![0] as Record<string, unknown>;
    expect(warnPayload.unknownLoopIds).toEqual(['typo-stale-id']);

    warnSpy.mockRestore();
  });

  it('redo 但 chainSnapshot 缺 → graceful 从头跑 + feedback 注入（从头跑的 draft-writer 收到）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    // 不预设 snapshot → redo 读 undefined → 降级从头跑 + feedback 注入
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      redo: { nodeId: 'draft-writer-agent', feedback: '重写指令' },
    });

    expect(summary.status).toBe('completed');
    // 从头跑：draft + 5 轮 world-extractor + multi-review + completeness-verify + route + story-sync（2.2 WP-E）
    // = 10 次 generate
    expect(generate.mock.calls.length).toBe(11); // W1d：+brief-reviewer（规划审核 LLM）——C1 首圈 no-op 零调用
    // feedback 仍注入到 draft-writer prompt
    const draftCall = generate.mock.calls.find(([_msgs, sys]: any) => isDraftSystem(sys));
    const userContent = (draftCall![0] as any)[0]?.content ?? '';
    expect(userContent).toContain('重写指令');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 11. CR-08-02-autonomy-modes-001（critical，三 reviewer 独立确认）：verdict checkpoint 时序 + resume
  //     readonly（微操）模式 verdict pause 抢断 route 终态处理 → silent data loss（accept 候选丢 / revision
  //     改稿丢 / escalate 裁决丢）。修后：verdict checkpoint 在终态处理后 fire；auto_revise loop 不 pause。
  //     用 pauseStages=['verdict'] 隔离 verdict 行为（跳过 brief/draft 让链段跑到 route 终态）。
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-001 accept（链流程重排 W2）：route=accept + final pause → 终稿 checkpoint 在终态处理后 fire；onAccept 不在 pause 前（移 E 段完成后——pause 时刻无候选，防 silent data loss 由完成腿兜底）', async () => {
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    const onAccept = vi.fn((snap: RunSnapshot) => ({
      chapterId: 'ep1',
      candidate: { content: '正文候选' },
      runId: snap.runId,
    }));

    // 只在 final pause（brief/draft 通过 → 链段跑到 route 终态）
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: { pauseStages: ['final'], escalateMode: 'ask' },
      onAccept,
    });

    // final pause 在 route accept 终态处理后（route_decision 已产）；W2 F1b：onAccept 移 E 段完成后
    // ——pause 时刻无 chapter_accept（候选须含人改后正文）。
    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('final');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    expect(onAccept).not.toHaveBeenCalled();
    expect(summary.chapter_accept).toBeUndefined();
  });

  it('CR-001 accept resume（W2 落盘拆两步）：final pause（无候选 + 持久 chainSnapshot）→ resume-continue → E 段跑完 → 完成时 onAccept 补产候选（无 silent drop——plan-review L7 锚）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);
    const onAccept = vi.fn((snap: RunSnapshot) => ({
      chapterId: 'ep1',
      candidate: { content: '正文候选' },
      runId: snap.runId,
    }));

    // Turn 1：跑到 final pause（W2：无 chapter_accept + persist chainSnapshot）
    const paused = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: { pauseStages: ['final'], escalateMode: 'ask' },
      onAccept,
    });
    expect(paused.status).toBe('paused');
    expect(paused.chapter_accept).toBeUndefined();
    // chainSnapshot 持久含 route accept + route-agent 在 completedNodes（resume 续跑依据）
    const snap = runState.getChainSnapshot(parent.id);
    expect((snap?.artifacts['route_decision'] as { decision?: string })?.decision).toBe('accept_as_truth');
    expect(snap?.completedNodes).toContain('route-agent');

    // Turn 2：resume-continue → route 在 completedNodes 前缀跳过 → E 段（提取段）跑完 → complete
    const resumed = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      onAccept,
    });
    expect(resumed.status).toBe('completed');
    // W2 F1b：完成时 onAccept 补产 chapter_accept → summary 有候选（无 silent drop）
    expect(resumed.chapter_accept).toMatchObject({ chapterId: 'ep1' });
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('W1d CR-001：route=auto_revise + verdict pause → 链内回环（回环中不 pause）；二判 accept 终态后 verdict pause', async () => {
    let routeCallIdx = 0;
    let writerRound = 0;
    const generate = vi.fn<GenerateFn>(async (_msgs, sys) => {
      const s = sys ?? '';
      if (s.includes('规划审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '卡可写', findings: [] }), finishReason: 'stop' };
      }
      if (s.includes('路由判决')) {
        routeCallIdx += 1;
        const decision = routeCallIdx === 1 ? 'auto_revise' : 'accept_as_truth';
        return { content: JSON.stringify({ decision, reason: `mock ${decision}` }), finishReason: 'stop' };
      }
      if (s.includes('改稿意图编译器')) {
        return {
          content: JSON.stringify({
            change: { summary: '补' },
            lockedItems: [],
            rationale: { source: 'audit-finding', note: 'A-trigger' },
            provenance: { rawUserInstruction: '据 Reader-Audit 审核发现修订', compilerNote: 'C1' },
          }),
          finishReason: 'stop',
        };
      }
      // completeness-verify L2（「完整性审核」——须在 generic「审核」前匹配）
      if (s.includes('完整性审核')) {
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        return { content: JSON.stringify({ verdict: 'revise', summary: '需改', dimensions: [], reasons: ['r'] }), finishReason: 'stop' };
      }
      // world-extractor（5 轴提取器，共同标记「状态提取」）—— 6.6 Phase C1/C2
      if (s.includes('状态提取')) {
        return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      }
      if (s.includes('story-sync-agent')) {
        return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
      }
      writerRound += 1;
      const draft = writerRound === 1
        ? { title: '章', text: '正文', wordCount: 100, chapterId: 'ep1' }
        : { title: '章', text: '修订正文', wordCount: 120, chapterId: 'ep1' };
      return { content: JSON.stringify(draft), finishReason: 'stop' };
    });
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    const onAccept = vi.fn((snap: RunSnapshot) => ({ chapterId: 'ep1', candidate: { content: 'x' }, runId: snap.runId }));

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: { pauseStages: ['final'], escalateMode: 'ask' },
      onAccept,
    });

    // W1a：auto_revise 链内回环（final pauseStages 不打断回环——回环非暂停形态）→ 二判 accept →
    // final checkpoint 在终态处理后 fire → pause 抢断 complete（W2：onAccept 移 E 段完成后，pause 时不调）。
    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('final');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    expect(onAccept).not.toHaveBeenCalled();
    // W1d 回环重跑：首轮 5（brief-reviewer + draft + multi-review + completeness + route）+ 回环 5
    //（C1 编译 + 写手改稿轮 + multi-review + completeness + route）= 10（final pause 抢断——提取段未跑）
    expect(generate.mock.calls.length).toBe(10);
  });

  it('W1a R4b：route=escalate_user → escalate-pause（status=paused + escalatePause，非 verdict stage 暂停）+ onAccept 对称调（D4）+ escalateFindings 在 summary', async () => {
    const generate = makeChainGenerate({
      review: {
        verdict: 'escalate',
        summary: '灰区',
        dimensions: [
          {
            name: 'consistency',
            findings: [
              { severity: 'block', quote: '硬气', location: '段1句2', explanation: 'OOC 嫌疑', subClass: 'Characterization.memory' },
            ],
          },
        ],
        reasons: [],
      },
      route: { decision: 'escalate_user', reason: '灰区裁决' },
    });
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    const onAccept = vi.fn((snap: RunSnapshot) => ({ chapterId: 'ep1', candidate: { content: '灰区稿' }, runId: snap.runId }));

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: { pauseStages: ['verdict'], escalateMode: 'ask' },
      onAccept,
    });

    // W1a：escalate → escalate-pause（与 verdict stage 暂停同 paused 形态但带 escalatePause 标记、
    // 不产 pausedStage——入口层据标记走裁决 resume 分派而非 ChapterReviewPanel 三动作）。
    expect(summary.status).toBe('paused');
    expect(summary.escalatePause).toBe(true);
    expect(summary.pausedStage).toBeUndefined();
    expect(summary.routeDecision?.decision).toBe('escalate_user');
    // escalate findings 在 summary（裁决器初审 + 用户裁决数据源）
    expect(summary.escalateFindings).toEqual([
      { severity: 'block', quote: '硬气', location: '段1句2', explanation: 'OOC 嫌疑', subClass: 'Characterization.memory' },
    ]);
    // D4 v2：escalate 也调 onAccept（候选给裁决流程），在 escalate-pause 前（修前：pause 抢断，不调）
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(summary.chapter_accept).toMatchObject({ chapterId: 'ep1' });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Story 8.4 Step 4（A7/A8）：出发核查挂起 → 全档位 pause（真链：真 writer 两阶段 + 真 verifier
  // 子循环 + 真 onCheckpoint 闭包〔decideCheckpointPause〕）+ 决断后 redo 恢复（重查语义）。
  //
  // 前置：registerBuiltinTools + setExecuteToolFn 通用 stub（mirror batch-integration 模式——writer/
  // verifier 十三件只读工具须 registry 可解析才进两阶段路径；工具执行返回通用 stub，取数侧 graceful 降级）。
  // ══════════════════════════════════════════════════════════════════════════

  describe('Story 8.4 Step 4 出发核查挂起（真链）', () => {
    const CLEAN_BRIEF = {
      plan: '按任务卡对峙收束',
      entries: [{ ref: 'char-lin', kind: 'asset', key_facts: [{ fact: '林昭左臂旧伤', source: '人物卡 char-lin' }] }],
      issues: [],
      execution_plan: [{ scene_ref: 's1', beat_coverage: '对峙' }],
      deviations: [],
    };
    const CONTRADICTORY_BRIEF = {
      ...CLEAN_BRIEF,
      issues: [{ desc: '任务卡说右臂伤，第 3 章正文是左臂', severity: 'contradiction' }],
    };
    const ESCALATE_VERDICT = {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: false },
      pass: false,
      // CR-004：pass=false ⇒ gaps 非空已由 schema refine 钉死（此 fixture 经真核实器 tryParseVerdict
      // parse + 挂起 evidence.verdict safeParse——空 gaps 两处都会拒）。矛盾本身记为一条 gap。
      gaps: [{ desc: '任务卡与第 3 章正文在林昭伤臂侧矛盾，须作者决断', source_hint: '读第 3 章正文' }],
      suggestions: [],
      archive_issues: [],
      escalate: true,
    };
    const PASS_VERDICT = {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
    };
    const DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上，主角深吸一口气。', wordCount: 2800, chapterId: 'ep1' };

    /**
     * 挂起→恢复双相 generate：第 1 次 writer 调用产矛盾简报（verdict escalate → 挂起）；redo 后
     * writer 产净简报 + verifier pass + 正文。其余节点路由 mirror makeChainGenerate（挂起/恢复各自完整链）。
     */
    function makeSuspensionGenerate(): ReturnType<typeof vi.fn<GenerateFn>> {
      let writerCall = 0;
      let verifierCall = 0;
      return vi.fn<GenerateFn>(async (_msgs, sys) => {
        const s = sys ?? '';
        // W1d：brief-reviewer（A2 规划审核）——pass 直通（挂起场景与规划环无关）
        if (s.includes('规划审核')) return { content: JSON.stringify({ verdict: 'pass', summary: '卡可写', findings: [] }), finishReason: 'stop' };
        if (s.includes('出发核查员')) {
          verifierCall += 1;
          const verdict = verifierCall === 1 ? ESCALATE_VERDICT : PASS_VERDICT;
          return { content: `${JSON.stringify(verdict)}\n<VERIFICATION_VERDICT_READY>`, finishReason: 'stop' };
        }
        if (s.includes('故事写作者')) {
          writerCall += 1;
          if (writerCall === 1) {
            return { content: `${JSON.stringify(CONTRADICTORY_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
          }
          if (writerCall === 2) {
            return { content: `${JSON.stringify(CLEAN_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
          }
          return { content: `${JSON.stringify(DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
        }
        if (s.includes('路由判决')) return { content: JSON.stringify({ decision: 'accept_as_truth', reason: '正文达标' }), finishReason: 'stop' };
        if (s.includes('完整性审核')) return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
        if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
          return { content: JSON.stringify({ verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] }), finishReason: 'stop' };
        }
        if (s.includes('状态提取')) return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
        if (s.includes('story-sync-agent')) return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
        return { content: JSON.stringify(DRAFT), finishReason: 'stop' };
      });
    }

    beforeEach(async () => {
      // writer/verifier 十三件只读工具可解析（否则节点降级单发直写，挂起结构性不可达）；工具执行通用 stub
      // （取数侧 graceful 降级——fetchWorldPatchesViaTool 等无 metadata → undefined）。
      const { registerBuiltinTools } = await import('../src/tool/builtin');
      registerBuiltinTools();
      const { setExecuteToolFn } = await import('../src/tool/remote');
      setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
    });

    it('矛盾简报 + auto 档 → 全档位 pause（status=paused + researchSuspension + errors 零计 + draft 未产）', async () => {
      const generate = makeSuspensionGenerate();
      const runtime = await makeRuntime(generate);
      const parent = await makeParent(runtime);

      const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('auto'), // 全自动：pauseStages=[] —— 挂起仍必停（A8 无例外）
      });

      expect(summary.status).toBe('paused');
      expect(summary.pausedStage).toBe('draft');
      // 挂起载荷（deliverable 豁免 isolation）：矛盾证据可呈 leader/用户。
      expect(summary.researchSuspension).toMatchObject({
        kind: 'research_contradiction',
        evidence: {
          contradictions: [{ desc: '任务卡说右臂伤，第 3 章正文是左臂', severity: 'contradiction' }],
        },
      });
      // 挂起 ≠ 错误：errors 零计；draft 未产（不带病开写）。
      expect(summary.errors ?? []).toEqual([]);
      expect(summary.draftText).toBeUndefined();
      expect(summary.draftContent).toBeUndefined();
    });

    it('suggest 档同挂起（挂起 pause 与 mode 驱动 draft pause 同停点，载荷照出）', async () => {
      const generate = makeSuspensionGenerate();
      const runtime = await makeRuntime(generate);
      const parent = await makeParent(runtime);

      const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('suggest'),
      });

      expect(summary.status).toBe('paused');
      expect(summary.pausedStage).toBe('draft');
      expect(summary.researchSuspension?.kind).toBe('research_contradiction');
    });

    it('决断后 redo 恢复：draft-writer 重跑重查（净简报过核实）→ 链段 completed + 章档案记决断（cardChanged=false）', async () => {
      const generate = makeSuspensionGenerate();
      const runtime = await makeRuntime(generate);
      const parent = await makeParent(runtime);

      const paused = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('auto'),
      });
      expect(paused.status).toBe('paused');

      // 决断「维持原案」→ redo draft-writer（挂起恢复唯一合法动作；resume-continue 会撞下游 DAG blocked）。
      const resumed = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('auto'),
        resume: { fromSnapshot: true },
        redo: { nodeId: 'draft-writer-agent' },
      });

      expect(resumed.status).toBe('completed');
      expect(resumed.routeDecision?.decision).toBe('accept_as_truth');
      expect(resumed.researchSuspension).toBeUndefined();
      expect(resumed.draftTitle).toBe('第二章 B 城');
      // 章档案：重入重查（净简报）核实过 → verified=true + 决断记录 cardChanged=false（维持原案）+ 挂起清除。
      // CR-003：档案目录名 = sanitize + hash 后缀（archiveDirName 单源，勿手拼）。
      const fs = await import('node:fs');
      const { archiveDirName } = await import('../src/nodes/writer-node');
      const archiveRaw = fs.readFileSync(
        `${projectPath}/.orison/chapter-archive/${archiveDirName('ep1')}/research-brief.json`,
        'utf-8',
      );
      const archived = JSON.parse(archiveRaw) as {
        verified: boolean;
        suspension?: unknown;
        decision?: { cardChanged: boolean };
      };
      expect(archived.verified).toBe(true);
      expect(archived.suspension).toBeUndefined();
      expect(archived.decision).toEqual({ cardChanged: false, decidedAt: expect.any(String) });
    });

    it('Step 4 belt：挂起 pause 后 resume-continue（无 redo）→ 强制按 redo draft-writer 处理（不撞 DAG blocked）', async () => {
      const generate = makeSuspensionGenerate();
      const runtime = await makeRuntime(generate);
      const parent = await makeParent(runtime);

      const paused = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('auto'),
      });
      expect(paused.status).toBe('paused');

      // 直调 resume continue（绕过 write_chapter resumeOptions 门——dogfood / 旧 UI 形态）：挂起时
      // draft.initial 不存在，跳过 draft-writer 会撞 revision-guard DAG blocked；belt 强制重跑。
      const resumed = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('auto'),
        resume: { fromSnapshot: true },
      });

      expect(resumed.status).toBe('completed'); // 非 blocked
      expect(resumed.routeDecision?.decision).toBe('accept_as_truth');
      expect(resumed.researchSuspension).toBeUndefined();
    });

    // ── CR-002（2026-08-19）：段落级 redo 不清 stale suspended → pause 成环死路 ──
    //
    // 场景：snapshot 带 stale research_brief.suspended（上轮挂起载荷）+ 段落级 revision_intent（用户已
    // 决断继续写——悬挂态与段落级修复互斥）+ 前稿。修复前：draft-writer legacy 直写不触碰 artifact →
    // decideCheckpointPause presence 判定在 draft checkpoint 用**旧**矛盾证据再次 pause → resume-continue
    // belt 强制重跑 → 又 legacy → 成环死路仅 abort 可解。修复后：legacy 入口清 suspended → 不再 pause，
    // 新稿成环（guard clean splice 落地）。真链直跑 runChain（真装配链 + 真 decideCheckpointPause）。
    it('CR-002：stale suspended + 段落级 intent → legacy 直写清 suspended → 不再 pause 且成环新稿', async () => {
      const generate = vi.fn<GenerateFn>(async (_msgs, sys) => {
        const s = sys ?? '';
        // W1d：brief-reviewer（A2 规划审核）——pass 直通
        if (s.includes('规划审核')) return { content: JSON.stringify({ verdict: 'pass', summary: '卡可写', findings: [] }), finishReason: 'stop' };
        // revision-guard L2（system「改稿保义裁判员」——须在 generic「审核」前匹配）→ clean 放行 splice。
        if (s.includes('改稿保义裁判员')) {
          return { content: JSON.stringify({ verdict: 'clean', findings: [], summary: '保义通过' }), finishReason: 'stop' };
        }
        if (s.includes('故事写作者')) {
          // legacy 直写：段落级输出（passageText；text 由 parseDraftOutput 保改前整章——7.2 单源逻辑）。
          return {
            content: JSON.stringify({ title: '第二章 B 城', text: '', passageText: '改后段落', wordCount: 2800, chapterId: 'ep1' }),
            finishReason: 'stop',
          };
        }
        if (s.includes('路由判决')) return { content: JSON.stringify({ decision: 'accept_as_truth', reason: '正文达标' }), finishReason: 'stop' };
        if (s.includes('完整性审核')) return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
        if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
          return { content: JSON.stringify({ verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] }), finishReason: 'stop' };
        }
        if (s.includes('状态提取')) return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
        if (s.includes('story-sync-agent')) return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
        return { content: JSON.stringify(DRAFT), finishReason: 'stop' };
      });
      const { runChain } = await import('../src/runtime/chainRunner');
      const { createChapterChainNodes, CHAPTER_CHAIN_LOOPS } = await import('../src/nodes/chapter-chain');
      const { decideCheckpointPause } = await import('../src/contracts/run');
      const session = {
        id: 'sess-cr002', agentName: 'chapter-chain', projectPath, status: 'idle' as const,
        messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      const snapshot = await runChain(
        {
          chain: createChapterChainNodes(generate, undefined, session),
          initialArtifacts: {
            ...makeInitialArtifacts(),
            chapter_brief: { goal: 'REACH_B_CITY_GOAL', tone: '紧张', episodeId: 'ep1' },
            // stale 挂起载荷（上一轮 research_contradiction——presence 判定的 pause 触发源）。
            research_brief: {
              brief: CLEAN_BRIEF,
              briefHash: 'sha256:stale',
              suspended: {
                kind: 'research_contradiction',
                rounds: 1,
                evidence: { contradictions: [{ desc: '旧矛盾证据', severity: 'contradiction' }], deviations: [] },
              },
            },
            // 段落级 intent（scope.anchor）→ draft-writer legacy 直写（修订轮不复走自查）。
            revision_intent: {
              change: { summary: '改紧张点' },
              lockedItems: [],
              rationale: { source: 'user-directive', note: '用户选段指挥' },
              provenance: { rawUserInstruction: '改这段', compilerNote: '说明' },
              scope: { anchor: { quote: '原句', prefix: '前', suffix: '后', rangeHint: { from: 0, to: 2 } } },
            },
            // 前稿（段落级 splice 的 previousText 源）。
            'draft.initial': { title: '第二章 B 城', text: '前文。原句。后文。', wordCount: 2800, chapterId: 'ep1' },
          },
          // redo 语义：brief-compiler 已完成、draft-writer 重跑。
          resumedCompletedNodes: ['brief-compiler-node'],
          loops: CHAPTER_CHAIN_LOOPS,
          onCheckpoint: async (stage, snap) => decideCheckpointPause(stage, snap, deriveCheckpointPolicy('auto')),
        },
        { generate, sessionContext: session, signal: new AbortController().signal },
      );

      // 修复断言：draft checkpoint 读不到 stale suspended → 全档位（auto）不再 pause，链走完。
      expect(snapshot.status).toBe('completed');
      expect((snapshot.artifacts['research_brief'] as { suspended?: unknown }).suspended).toBeUndefined();
      // 成环新稿：guard clean splice 落地（选区段「原句」→「改后段落」，前后文不动）。
      expect((snapshot.artifacts['draft.initial'] as { text: string }).text).toBe('前文。改后段落。后文。');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // BMad CR-T1-056：per-project 活动链守卫（「同项目至多一条活动链」不变式恢复）。
  //
  // 洞口：runLoop 工具执行 Promise.all 并行——单轮 LLM 同发两条 write_chapter → 两链并发跑同项目
  //（chainSnapshot 同 parentSessionId 互覆 + UI 链正文归零）；首链 paused 后台滞留期间再发第二条
  // 同理。守卫在链层级（shell D4 run 租约拦不住——leader invoke 自身已持租约）；paused 持有到
  // resume 终态 / clearChainSnapshot（abort 动作）。
  // ══════════════════════════════════════════════════════════════════════════
  describe('BMad CR-T1-056：per-project 活动链守卫', () => {
    it('paused 持有守卫：他 session 第二条链 → 结构化 busy（chain_run_active 前缀），generate 不跑', async () => {
      const generate = makeChainGenerate();
      const runtime = await makeRuntime(generate);
      const parentA = await makeParent(runtime);
      const parentB = await makeParent(runtime); // 同 projectPath 第二会话

      // 链 A：suggest 档 → draft checkpoint pause（守卫随 pause 持有）。
      const paused = await runtime.runChapterChain(parentA.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('suggest'),
      });
      expect(paused.status).toBe('paused');

      // 链 B（同项目他 session）：busy 拒绝（机器可读前缀 mirror D4 project_run_active）。
      const callsBefore = generate.mock.calls.length;
      const busy = await runtime.runChapterChain(parentB.id, makeInitialArtifacts());
      expect(busy.status).toBe('error');
      expect(busy.errors?.[0]).toBe(`chain_run_active|heldBy=${parentA.id}`);
      expect(generate.mock.calls.length).toBe(callsBefore); // 未跑任何链段节点
    });

    it('paused 持有守卫：同 session 非续跑（from-head 重发）→ 同样 busy（leader paused 期间再发 write_chapter 窗口）', async () => {
      const generate = makeChainGenerate();
      const runtime = await makeRuntime(generate);
      const parentA = await makeParent(runtime);

      const paused = await runtime.runChapterChain(parentA.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('suggest'),
      });
      expect(paused.status).toBe('paused');

      // 同 session 但不带 resume/redo → 不是自家 paused 链续跑 → busy（防新链覆写滞留 snapshot）。
      const busy = await runtime.runChapterChain(parentA.id, makeInitialArtifacts());
      expect(busy.status).toBe('error');
      expect(busy.errors?.[0]).toBe(`chain_run_active|heldBy=${parentA.id}`);
    });

    it('同 session resume（fromSnapshot）→ 放行续跑（completed）+ 守卫随终态释放（后续新链可跑）', async () => {
      const generate = makeChainGenerate();
      const runtime = await makeRuntime(generate);
      const parentA = await makeParent(runtime);
      const parentB = await makeParent(runtime);

      const paused = await runtime.runChapterChain(parentA.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('suggest'),
      });
      expect(paused.status).toBe('paused');

      // 自家 paused 链 resume（同 session + fromSnapshot）→ 放行（重入续跑，不被自己拒绝）。
      const resumed = await runtime.runChapterChain(parentA.id, makeInitialArtifacts(), {
        resume: { fromSnapshot: true },
      });
      expect(resumed.status).toBe('completed');

      // completed 终态 → 守卫释放 → 同项目另一 session 新链可跑。
      const next = await runtime.runChapterChain(parentB.id, makeInitialArtifacts());
      expect(next.status).toBe('completed');
    });

    it('clearChainSnapshot（resume-chapter-chain abort 动作）→ 释放守卫，第二条链可跑', async () => {
      const generate = makeChainGenerate();
      const runtime = await makeRuntime(generate);
      const parentA = await makeParent(runtime);
      const parentB = await makeParent(runtime);

      const paused = await runtime.runChapterChain(parentA.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('suggest'),
      });
      expect(paused.status).toBe('paused');
      const busy = await runtime.runChapterChain(parentB.id, makeInitialArtifacts());
      expect(busy.status).toBe('error');

      // 用户在审阅面板放弃（abort）→ clearChainSnapshot → 守卫释放。
      expect(runtime.clearChainSnapshot(parentA.id)).toBe(true);
      const next = await runtime.runChapterChain(parentB.id, makeInitialArtifacts());
      expect(next.status).toBe('completed');
    });
  });
  describe('W2 resume.editedDraft（终稿手改覆写单源）', () => {
    it('final pause → resume-continue + editedDraft → E 段跑完 + summary 载改后正文与重算 wordCount', async () => {
      const { RunStateStore } = await import('../src/runtime/runState');
      const runState = new RunStateStore();
      const generate = makeChainGenerate();
      const runtime = await makeRuntime(generate, runState);
      const parent = await makeParent(runtime);

      // Turn 1：suggest 档（=['final']）跑到终稿 pause。
      const paused = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('suggest'),
      });
      expect(paused.status).toBe('paused');
      expect(paused.pausedStage).toBe('final');
      expect(paused.draftText).toBe('黄昏的荒野上，主角深吸一口气。');

      // Turn 2：终稿 accept 携手改全文 → resume 续跑 E 段。
      const EDITED = '黄昏的荒野上，主角缓缓吐出一口气。（手改：删掉「深吸」改为「缓缓吐出」）';
      const resumed = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        resume: { fromSnapshot: true, editedDraft: EDITED },
      });
      expect(resumed.status).toBe('completed');
      // E 段对改后正文提取：summary.draftText = 改后全文（wordCount 机械重算——LLM 自报值被覆盖）。
      expect(resumed.draftText).toBe(EDITED);
      expect(resumed.draftWordCount).toBe(EDITED.replace(/\s+/g, '').length);
    });

    it('resume-continue 无 editedDraft → 正文原样（零回归）', async () => {
      const { RunStateStore } = await import('../src/runtime/runState');
      const runState = new RunStateStore();
      const generate = makeChainGenerate();
      const runtime = await makeRuntime(generate, runState);
      const parent = await makeParent(runtime);

      await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        mode: deriveCheckpointPolicy('suggest'),
      });
      const resumed = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
        resume: { fromSnapshot: true },
      });
      expect(resumed.status).toBe('completed');
      expect(resumed.draftText).toBe('黄昏的荒野上，主角深吸一口气。');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CR 批（09-13 review findings）：redo 清理集补 optimizer_failed（CR-7）/
  // resume.redoFrom 跨簇契约 / escalate-accept 续跑补发终稿 checkpoint（CR-3a）。
  // ══════════════════════════════════════════════════════════════════════════

  /** route 终态过的快照基底（redo / resume 消费）。 */
  function makeRouteDoneSnapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
    return {
      runId: 'run-route-done',
      status: 'paused',
      currentNodeId: 'route-agent',
      projectPath,
      completedNodes: [
        'brief-compiler-node',
        'brief-reviewer-node',
        'revision-optimizer-node',
        'draft-writer-agent',
        'revision-guard-agent',
        'lint-node',
        'multi-review-agent',
        'completeness-verify-node',
        'route-agent',
      ],
      pendingNodes: [],
      artifacts: {
        ...makeInitialArtifacts(),
        chapter_brief: { goal: 'REACH_B_CITY_GOAL', tone: '紧张', episodeId: 'ep1' },
        'draft.initial': { title: '第二章 B 城', text: '黄昏的荒野上，主角深吸一口气。', wordCount: 2800, chapterId: 'ep1' },
        'review.latest': { verdict: 'revise', summary: '需改', dimensions: [], reasons: [] },
        route_decision: { decision: 'escalate_user', reason: '灰区' },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
      ...over,
    };
  }

  it('CR-7：redo 边界不含 C1（multi-review 起点）+ 陈旧 optimizer_failed 残留 → redo 清理集清除，route 重判 accept 正常终态（修前 stale 信号每圈强制 escalate 死环）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    const base = makeRouteDoneSnapshot();
    runState.setChainSnapshot(parent.id, {
      ...base,
      artifacts: {
        ...base.artifacts,
        optimizer_failed: { optimizer_failed: true, nodeId: 'revision-optimizer-node', message: '上圈编译失败（stale 残留）' },
      },
    });

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      // redo 边界在 C1 之后（multi-review idx6）→ 前缀跳过 C1（圈作用域清理不触发）——修前唯一
      // 清理入口失效，route 读 stale 信号强制 escalate（裁决 revise 再 redo → 又拦 = 永久死环）。
      redo: { nodeId: 'multi-review-agent' },
    });

    // CR-7：redo 清理集清掉 stale optimizer_failed → multi-review/completeness/route 重跑后 route
    // 判 accept（mock 默认）→ E 段续跑 completed。
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    expect(summary.escalatePause).toBeUndefined();
    expect(summary.errors ?? []).toEqual([]);
  });

  it('resume.redoFrom（跨簇契约）：plan pause 裁决 revise → redoFrom=brief-compiler-node → 规划环整环重跑（brief-reviewer 重审）', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate();
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    runState.setChainSnapshot(parent.id, {
      runId: 'run-plan-pause',
      status: 'paused',
      currentNodeId: 'brief-reviewer-node',
      projectPath,
      completedNodes: ['brief-compiler-node', 'brief-reviewer-node'],
      pendingNodes: [],
      artifacts: {
        ...makeInitialArtifacts(),
        chapter_brief: { goal: 'REACH_B_CITY_GOAL', tone: '紧张', episodeId: 'ep1' },
        plan_review: {
          verdict: 'escalate',
          summary: '灰区',
          findings: [{ dimension: 'red-line', severity: 'hard', grounding: 'brief.goal', note: '红线冲突' }],
        },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
      escalatePause: true,
    });

    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true, redoFrom: 'brief-compiler-node' },
    });

    // redoFrom 移除 brief-compiler → 前缀断在 idx0 → A1 重编 → A2 重审（pass）→ B → 环 → route accept → completed。
    expect(summary.status).toBe('completed');
    expect(summary.routeDecision?.decision).toBe('accept_as_truth');
    // 规划环重跑证据：brief-reviewer 的 generate（规划审核 system）在本次 resume run 被调。
    const hasPlanReview = generate.mock.calls.some(
      ([_m, sys]: any) => typeof sys === 'string' && sys.includes('规划审核'),
    );
    expect(hasPlanReview).toBe(true);
  });

  it('CR-3a：escalate-pause → 裁决 accept resume（suggest 档）→ 补发终稿 checkpoint pause（AC2b「C7 的进 D」）→ 终稿 accept 再 resume → E 段跑完 completed', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const runState = new RunStateStore();
    const generate = makeChainGenerate({ route: { decision: 'escalate_user', reason: '灰区' } });
    const runtime = await makeRuntime(generate, runState);
    const parent = await makeParent(runtime);

    // 第一腿：route 判 escalate → escalate-pause（route 已进 completedNodes）。
    const first = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: deriveCheckpointPolicy('suggest'),
    });
    expect(first.status).toBe('paused');
    expect(first.escalatePause).toBe(true);

    // 第二腿：裁决 accept → resume 续跑 → CR-3a 补发终稿 checkpoint（suggest=['final'] → pause，
    // 不补发则 route 被 completed 前缀跳过、终稿卡结构性不可达）。
    const second = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      mode: deriveCheckpointPolicy('suggest'),
    });
    expect(second.status).toBe('paused');
    expect(second.escalatePause).toBeUndefined(); // 新 run 非 escalate-pause 形态（终稿审阅卡路由）
    expect(second.pausedStage).toBe('final');
    expect(second.draftContent).toBe('黄昏的荒野上，主角深吸一口气。');

    // 第三腿：终稿卡 accept（continue）→ 补发标记在（不再补发）→ E 段跑完 → completed。
    const third = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      mode: deriveCheckpointPolicy('suggest'),
    });
    expect(third.status).toBe('completed');
    expect(third.routeDecision?.decision).toBe('escalate_user'); // 裁决采信的终态决策保留
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.3 Step 3：RunStateStore.clearChainSnapshot（resume-chapter-chain abort 入口）。
// ════════════════════════════════════════════════════════════════════════════

describe('RunStateStore.clearChainSnapshot（Story 4.3 Step 3 resume abort）', () => {
  it('clearChainSnapshot 清除既有 chainSnapshot + 返 true；无则返 false', async () => {
    const { RunStateStore } = await import('../src/runtime/runState');
    const store = new RunStateStore();
    const sessionId = 'sess-clear-1';

    // 未写 → clear 返 false
    expect(store.clearChainSnapshot(sessionId)).toBe(false);

    // 写后 → clear 返 true + getChainSnapshot undefined
    store.setChainSnapshot(sessionId, {
      runId: 'r1', status: 'paused', currentNodeId: 'draft-writer-agent', projectPath: '/p',
      completedNodes: ['brief-compiler-node'], pendingNodes: [], artifacts: {}, review: null,
      archive: null, delivery: null, feedback: null, errors: [],
    });
    expect(store.getChainSnapshot(sessionId)).toBeDefined();
    expect(store.clearChainSnapshot(sessionId)).toBe(true);
    expect(store.getChainSnapshot(sessionId)).toBeUndefined();

    // 重复 clear → false（已清）
    expect(store.clearChainSnapshot(sessionId)).toBe(false);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// 链流程重排 W2（R3 终稿手改通道 / R4c 落盘拆两步）：resume.editedDraft——终稿 checkpoint
// 人审手改正文全文，resume 读回经 applyEditedDraft 单源覆写 draft.initial（text + wordCount
// 机械重算 + 申报类 stale 清理），E 段（随后的续跑腿）对改后正文提取。
// ════════════════════════════════════════════════════════════════════════════
