import { describe, expect, it, vi } from 'vitest';
import {
  createChapterChainNodes,
  CHAPTER_CHAIN_NODE_IDS,
  CHAPTER_CHAIN_LOOPS,
} from '../src/nodes/chapter-chain';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// 链流程重排（09-13 W1d）：createChapterChainNodes 装配测试。
//
// 核心断言：
// 1. 返回正确链序（23 节点 = A1/A2 + 自审环 7 节点 + 提取段 14 节点）。
// 2. 双环配置（规划环 [brief-compiler→brief-reviewer] cap 2 + 自审环
//    [revision-optimizer→route] cap 3）；两环切片约束（from<=through）。
// 3. **写手单位置进环体**（M3）：draft-writer 在 [revision-optimizer..route] 切片内——环回
//    pointer 跳回 C1 后写手重跑（环内改稿执行者，AC5「环体 7 节点」）。
// 4. checkpointStage 标注：brief→brief-reviewer（A2 后）/ draft→draft-writer /
//    revision-guard 动态 / verdict→route；brief-compiler 无 stage。
// 5. 每节点 contract 形态正确（requiredArtifactKeys / producedArtifactKeys）。
// 6. multi-review requiredArtifactKeys 无 story.sync（W0-3 断链级适配）。
// 7. targeted-revision 不在链上（退役）。
// ─────────────────────────────────────────────────────────────────────────────

const noopGenerate = vi.fn<GenerateFn>(async () => ({ content: '{}', finishReason: 'stop' }));

function makeSession(): SessionState {
  return {
    id: 'sess_chain',
    agentName: 'chapter-chain',
    projectPath: '/test/project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_chain',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1-3. 链序 + 双环配置
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — 链序 + 双环（W1d 新序）', () => {
  it('返回 23 节点 = A1/A2（规划环）+ 自审环 7 节点 + 提取段 14 节点；id 序与 CHAPTER_CHAIN_NODE_IDS 一致', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    expect(chain.map((c) => c.id)).toEqual([...CHAPTER_CHAIN_NODE_IDS]);
    expect(chain).toHaveLength(23);
    const ids = chain.map((c) => c.id);

    // targeted-revision 退役：不在链上。
    expect(ids).not.toContain('targeted-revision-agent');

    // 规划环：brief-reviewer 在 brief-compiler 紧后。
    expect(ids.indexOf('brief-reviewer-node')).toBe(ids.indexOf('brief-compiler-node') + 1);
    // 写手在 revision-optimizer 紧后（C1→B/C2 单位置进环体——M3 落地形态）。
    expect(ids.indexOf('draft-writer-agent')).toBe(ids.indexOf('revision-optimizer-node') + 1);
    expect(ids.indexOf('revision-guard-agent')).toBe(ids.indexOf('draft-writer-agent') + 1);
    expect(ids[ids.indexOf('revision-guard-agent') + 1]).toBe('lint-node');
    expect(ids[ids.indexOf('lint-node') + 1]).toBe('multi-review-agent');
    expect(ids[ids.indexOf('multi-review-agent') + 1]).toBe('completeness-verify-node');
    // route 是环 through——其后进提取段（W1a accept 自然前进语义，不再是链尾）。
    expect(ids[ids.indexOf('completeness-verify-node') + 1]).toBe('route-agent');
    // 提取段顺序：world×5 → merge → emotion → promise → arc → summary → storytime → mention →
    // story-sync → feedback-ledger（E10 终态一次写——三输入在 E 段末点齐）。
    expect(ids.slice(ids.indexOf('route-agent') + 1)).toEqual([
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
  });

  it('双环配置 = 规划环 [brief-compiler→brief-reviewer] cap 2 + 自审环 [revision-optimizer→route] cap 3', () => {
    expect(CHAPTER_CHAIN_LOOPS).toEqual([
      { from: 'brief-compiler-node', through: 'brief-reviewer-node', cap: 2 },
      { from: 'revision-optimizer-node', through: 'route-agent', cap: 3 },
    ]);
  });

  it('两环切片约束（from<=through）+ 环体成员——自审环 7 节点含写手（AC5 环体成员钉死）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ids = chain.map((c) => c.id);
    for (const loop of CHAPTER_CHAIN_LOOPS) {
      const fromIdx = ids.indexOf(loop.from);
      const throughIdx = ids.indexOf(loop.through);
      expect(fromIdx).toBeGreaterThanOrEqual(0);
      expect(throughIdx).toBeGreaterThan(fromIdx);
    }
    // 自审环体 [revision-optimizer..route] = 7 节点（C1-C7 含写手——环回时写手重跑 = 环内改稿执行者）。
    const auditFrom = ids.indexOf('revision-optimizer-node');
    const auditThrough = ids.indexOf('route-agent');
    expect(ids.slice(auditFrom, auditThrough + 1)).toEqual([
      'revision-optimizer-node',
      'draft-writer-agent',
      'revision-guard-agent',
      'lint-node',
      'multi-review-agent',
      'completeness-verify-node',
      'route-agent',
    ]);
    // 规划环体 [brief-compiler..brief-reviewer] = 2 节点。
    const planFrom = ids.indexOf('brief-compiler-node');
    const planThrough = ids.indexOf('brief-reviewer-node');
    expect(ids.slice(planFrom, planThrough + 1)).toEqual(['brief-compiler-node', 'brief-reviewer-node']);
    // 提取段在自审环外（环回零重跑——AC5 环瘦身）。
    expect(ids.indexOf('world-extractor-physical')).toBeGreaterThan(auditThrough);
    expect(ids.indexOf('feedback-ledger-node')).toBeGreaterThan(auditThrough);
  });

  it('checkpointStage 标注：brief→brief-reviewer（A2 后）/ draft→draft-writer（挂起动态 pause 载体）/ revision-guard 动态 / final→route；brief-compiler 无 stage', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const stageOf = (id: string) => chain.find((c) => c.id === id)?.checkpointStage;
    expect(stageOf('brief-compiler-node')).toBeUndefined(); // brief 停点挪 A2（design §1）
    expect(stageOf('brief-reviewer-node')).toBe('brief');
    expect(stageOf('revision-optimizer-node')).toBeUndefined();
    // W2：draft 退役 scheduled 停点（deriveCheckpointPolicy 不含），但声明保留——挂起动态 pause +
    // #93 草稿档案落盘都挂本 stage fire。
    expect(stageOf('draft-writer-agent')).toBe('draft');
    expect(stageOf('revision-guard-agent')).toBe('revision-guard'); // 动态（soft-violation 才 pause）
    expect(stageOf('lint-node')).toBeUndefined();
    expect(stageOf('multi-review-agent')).toBeUndefined();
    expect(stageOf('completeness-verify-node')).toBeUndefined();
    // W2：route 重映射 'final'（终稿人审——route accept 后、E 段前；旧 'verdict' 停点退役）。
    expect(stageOf('route-agent')).toBe('final');
    for (const id of ['world-extractor-physical', 'world-merge-node', 'emotion-verify-node', 'promise-emergence-node', 'arc-emergence-node', 'chapter-summary-node', 'storytime-drift-node', 'mention-ledger-node', 'story-sync-agent', 'feedback-ledger-node']) {
      expect(stageOf(id), id).toBeUndefined(); // 提取段零 checkpoint（design §1）
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 节点契约形态
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — 节点契约', () => {
  it('每节点带 contract（非 null）+ 唯一 nodeId', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    for (const def of chain) {
      expect(def.node.contract).not.toBeNull();
    }
    // 唯一 nodeId（链内唯一标识——写手单位置无重复 id，M3 单位置形态）
    const nodeIds = chain.map((c) => c.node.contract?.nodeId);
    expect(new Set(nodeIds).size).toBe(23);
  });

  it('brief-compiler 读 chapter_brief_input+scene_graph → owns chapter_brief', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const brief = chain.find((c) => c.id === 'brief-compiler-node')!;
    expect(brief.node.contract?.producedArtifactKeys).toContain('chapter_brief');
    expect(brief.node.contract?.requiredArtifactKeys).toEqual(['chapter_brief_input', 'scene_graph']);
  });

  it('brief-reviewer 读 chapter_brief → owns plan_review（W1c 工厂接线）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const reviewer = chain.find((c) => c.id === 'brief-reviewer-node')!;
    expect(reviewer.node.contract?.nodeId).toBe('brief-reviewer-node');
    expect(reviewer.node.contract?.requiredArtifactKeys).toEqual(['chapter_brief']);
    expect(reviewer.node.contract?.producedArtifactKeys).toEqual(['plan_review']);
  });

  it('revision-optimizer requiredArtifactKeys=[]（写手前链位——首圈 no-op 不读稿不 blocked）→ may-produce revision_intent/optimizer_failed', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const optimizer = chain.find((c) => c.id === 'revision-optimizer-node')!;
    expect(optimizer.node.contract?.nodeId).toBe('revision-optimizer-node');
    // W1d 位调整：optimizer 在写手前，draft.initial 不进 required（进则首圈 DAG blocked）。
    expect(optimizer.node.contract?.requiredArtifactKeys).toEqual([]);
    expect(optimizer.node.contract?.producedArtifactKeys).toEqual(['revision_intent', 'optimizer_failed']);
  });

  it('draft-writer 读 chapter_brief+scene_graph+settings_context → owns draft.initial（+may-produce 简报/申报）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const dw = chain.find((c) => c.id === 'draft-writer-agent')!;
    // Story 8.4 A2/A9：createWriterNode 两阶段；research_brief/cast_declaration 是 may-produce
    //（mutate 写；降级路径写 degraded 形态——mirror revision_guard 先例）。
    expect(dw.node.contract?.producedArtifactKeys).toEqual(['draft.initial', 'research_brief', 'cast_declaration']);
  });

  it('Story 7.2：revision-guard 读 draft.initial → owns draft.initial + revision_guard + checkpointStage=revision-guard', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const guard = chain.find((c) => c.id === 'revision-guard-agent')!;
    expect(guard.checkpointStage).toBe('revision-guard');
    expect(guard.node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(guard.node.contract?.producedArtifactKeys).toEqual(['draft.initial', 'revision_guard']);
    expect(guard.node.contract?.sideEffects).toContain('call_model');
  });

  it('C1.2：lint-node 读 draft.initial → owns lint_report + 无 checkpointStage + 纯代码零副作用', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ln = chain.find((c) => c.id === 'lint-node')!;
    expect(ln).toBeDefined();
    expect(ln.checkpointStage).toBeUndefined();
    expect(ln.node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(ln.node.contract?.producedArtifactKeys).toEqual(['lint_report']);
    expect(ln.node.contract?.sideEffects).toEqual([]);
  });

  it('W0-3 断链级适配：multi-review requiredArtifactKeys 无 story.sync（story-sync 后移 E9）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const review = chain.find((c) => c.id === 'multi-review-agent')!;
    expect(review.node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph', 'chapter_brief']);
    expect(review.node.contract?.requiredArtifactKeys).not.toContain('story.sync');
    // story-sync 在 route 后（提取段 E9）——multi-review（C5）先跑。
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf('multi-review-agent')).toBeLessThan(ids.indexOf('story-sync-agent'));
  });

  it('world-extractor 读 draft.initial+scene_graph → owns world_events.<axis>（5 轴）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const axes = ['physical', 'cognitive', 'emotional', 'relational', 'factional'];
    for (const axis of axes) {
      const node = chain.find((c) => c.id === `world-extractor-${axis}`)!;
      expect(node).toBeDefined();
      expect(node.node.contract?.nodeId).toBe(`world-extractor-${axis}`);
      expect(node.node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
      expect(node.node.contract?.producedArtifactKeys).toEqual([`world_events.${axis}`]);
      expect(node.node.contract?.sideEffects).toContain('call_model');
    }
  });

  it('world-merge 读 5 轴 world_events → owns world_state.events', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const wm = chain.find((c) => c.id === 'world-merge-node')!;
    expect(wm.node.contract?.requiredArtifactKeys).toEqual([
      'world_events.physical',
      'world_events.cognitive',
      'world_events.emotional',
      'world_events.relational',
      'world_events.factional',
    ]);
    expect(wm.node.contract?.producedArtifactKeys).toEqual(['world_state.events']);
  });

  it('提取段家族契约（emotion/promise/arc/summary/storytime/mention/story-sync/feedback-ledger）无 checkpointStage', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const eNodes = ['emotion-verify-node', 'promise-emergence-node', 'arc-emergence-node', 'chapter-summary-node', 'storytime-drift-node', 'mention-ledger-node', 'story-sync-agent', 'feedback-ledger-node'];
    for (const id of eNodes) {
      expect(chain.find((c) => c.id === id)?.checkpointStage, id).toBeUndefined();
    }
    expect(chain.find((c) => c.id === 'emotion-verify-node')?.node.contract?.requiredArtifactKeys).toEqual([]);
    expect(chain.find((c) => c.id === 'chapter-summary-node')?.node.contract?.requiredArtifactKeys).toEqual([]);
    expect(chain.find((c) => c.id === 'storytime-drift-node')?.node.contract?.requiredArtifactKeys).toEqual([]);
  });

  it('mention-ledger 读 draft.initial+scene_graph → owns mention_signals + persist_artifact', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ml = chain.find((c) => c.id === 'mention-ledger-node')!;
    expect(ml.node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
    expect(ml.node.contract?.producedArtifactKeys).toEqual(['mention_signals']);
    expect(ml.node.contract?.sideEffects).toContain('persist_artifact');
  });

  it('storySync 读 draft.initial → owns story.sync', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ss = chain.find((c) => c.id === 'story-sync-agent')!;
    expect(ss.node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(ss.node.contract?.producedArtifactKeys).toEqual(['story.sync']);
  });

  it('route 读 review.latest+chapter_brief+draft.initial → owns route_decision', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const rt = chain.find((c) => c.id === 'route-agent')!;
    expect(rt.node.contract?.producedArtifactKeys).toEqual(['route_decision']);
    expect(rt.node.contract?.requiredArtifactKeys).toEqual(['review.latest', 'chapter_brief', 'draft.initial']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. storySync 新 key（5.1c 对齐）+ Story 6.5 收缩（foreshadow 提取移除）
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — storySync 读 draft.initial（6.5 收缩：foreshadow 提取移除）', () => {
  it('读 draft.initial.text → 产 story.sync（rules 现无提取，patches 空——CR-E7 防线）', async () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ss = chain.find((c) => c.id === 'story-sync-agent')!;

    const result = await ss.node.run({
      run: makeRun({
        'draft.initial': { chapterId: 'ch_1', text: '他取出一把铜钥匙。' },
      }),
      requirement: '',
    });

    expect(result.stateKey).toBe('story.sync');
    const artifact = result.artifact as { patches: unknown[] };
    expect(artifact.patches).toEqual([]);
  });
});
