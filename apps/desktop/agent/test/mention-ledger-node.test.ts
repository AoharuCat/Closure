import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SceneGraph, SceneNode } from '@orison/shared-contracts';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S8（design §2.2/§2.3）：mention-ledger-node 节点测试。
//
// 覆盖（dispatch 清单）：正常申报路径（artifact 投影断言：declaration/draftText/plannedAssetRefs）/
// 无申报保守账（degraded 形态 + 缺 artifact）/ 坏 declaration 字段 safeParse 拒收 / synopsis 透传 /
// graceful 三态（episodeId 缺 / 工具未注册 / execute 抛 / handler ok:false）+ 修订降档包装
// （skip 不降档 / 落盘降档 / error artifact 不降档 / 降档工具缺 graceful）。
// registry mock 用 vi.doMock + fresh import（mirror chapter-summary-node.test——registry 是模块级
// 单例，doMock 后重 import 节点模块才拿到 mock registry）。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_mention',
    status: 'running',
    currentNodeId: 'mention-ledger-node',
    projectPath: '/test-project',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
  };
}

function scene(id: string, episodeId: string, assetRefs?: string[]): SceneNode {
  return {
    id,
    storyTime: 100,
    presentationOrder: { chapter: 0, pos: 0 },
    role: 'normal',
    lineTags: [],
    episodeId,
    ...(assetRefs !== undefined ? { assetRefs } : {}),
  } as SceneNode;
}

/** 本章 ep-1 两场（s_a 挂 card-a/card-b；s_b 无 refs）+ 他章一场（s_other 也挂 card-a——不应计入）。 */
function makeGraph(): SceneGraph {
  return {
    nodes: [
      scene('s_a', 'ep-1', ['card-a', 'card-b', 'card-a']), // 重复 ref 去重
      scene('s_b', 'ep-1'),
      scene('s_other', 'ep-2', ['card-a']),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

const VALID_DECLARATION = {
  synopsis: '林昭与江白各自遇袭。',
  present: [{ name: '三师叔', card: '李玄' }],
  mentioned: [{ name: '青锋剑' }],
};

/** 造 fake record_episode_mentions registry（捕获入参 + 可控行为）。 */
function mockRecordTool(options?: {
  metadata?: Record<string, unknown>;
  throwErr?: Error;
}) {
  const calls: Array<{ params: Record<string, unknown>; projectPath: string }> = [];
  vi.doMock('../src/tool/registry', () => ({
    registry: {
      get: (id: string) => {
        if (id !== 'record_episode_mentions') return undefined;
        return {
          id,
          description: '',
          parameters: {},
          execute: async (params: Record<string, unknown>, ctx: { projectPath: string }) => {
            calls.push({ params, projectPath: ctx.projectPath });
            if (options?.throwErr) throw options.throwErr;
            return {
              title: 'record_episode_mentions',
              output: '',
              metadata:
                options?.metadata ?? {
                  ok: true,
                  episodeId: 'ep-1',
                  rowCount: 2,
                  signals: [
                    { kind: 'alias_suggestion', episodeId: 'ep-1', name: '三师叔', entryId: 'card-li' },
                  ],
                  synopsis: 'applied',
                  degradedReasons: [],
                },
            };
          },
        };
      },
    },
  }));
  return calls;
}

async function freshNode() {
  const { createMentionLedgerNode } = await import('../src/nodes/mention-ledger-node');
  return createMentionLedgerNode();
}

describe('mention-ledger-node (Story 8.7 design §2.2)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ── graceful：episodeId 缺 ──

  it('episodeId 缺（chapter_brief_input 无）→ 跳过记账（ok:false + no_episodeId，链不破）', async () => {
    const node = await freshNode();
    const result = await node.run({
      run: makeRun({ 'draft.initial': { text: 'x' }, scene_graph: makeGraph() }),
      requirement: '',
    });
    expect(result.stateKey).toBe('mention_signals');
    const artifact = result.artifact as { episodeId: null; ok: boolean; reason: string; signals: unknown[] };
    expect(artifact.episodeId).toBeNull();
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toBe('no_episodeId');
    expect(artifact.signals).toEqual([]);
  });

  // ── graceful：工具未注册（测试环境 registry 空）──

  it('record_episode_mentions 未注册 → 跳过记账（ok:false + tool_not_registered）', async () => {
    const node = await freshNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: makeGraph(),
      }),
      requirement: '',
    });
    const artifact = result.artifact as { ok: boolean; reason: string; summary: string };
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toBe('tool_not_registered');
    expect(artifact.summary).toContain('tool not registered');
  });

  // ── 正常申报路径：artifact 投影断言 ──

  it('正常申报 → 工具收 {episodeId, declaration, draftText, plannedAssetRefs}（本章场 assetRefs 展开去重排序，他章不计）；metadata 落 artifact', async () => {
    const calls = mockRecordTool();
    const node = await freshNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { title: 't', text: '李玄提剑出城。', wordCount: 7 },
        scene_graph: makeGraph(),
        cast_declaration: { declaration: VALID_DECLARATION, source: 'declared' },
      }),
      requirement: '',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].projectPath).toBe('/test-project');
    expect(calls[0].params).toEqual({
      episodeId: 'ep-1',
      declaration: VALID_DECLARATION,
      draftText: '李玄提剑出城。',
      plannedAssetRefs: ['card-a', 'card-b'], // 去重 + 排序；s_other（ep-2）的 card-a 不计入
    });

    expect(result.stateKey).toBe('mention_signals');
    const artifact = result.artifact as {
      runId: string;
      episodeId: string;
      ok: boolean;
      rowCount: number;
      signals: Array<{ kind: string }>;
      synopsis: string;
      degradedReasons?: string[];
      summary: string;
    };
    expect(artifact.runId).toBe('run_mention');
    expect(artifact.episodeId).toBe('ep-1');
    expect(artifact.ok).toBe(true);
    expect(artifact.rowCount).toBe(2);
    expect(artifact.signals).toEqual([
      { kind: 'alias_suggestion', episodeId: 'ep-1', name: '三师叔', entryId: 'card-li' },
    ]);
    expect(artifact.synopsis).toBe('applied');
    expect(artifact.degradedReasons).toBeUndefined(); // 空数组不占字段（二态纪律）
    expect(artifact.summary).toContain('recorded ep-1');
  });

  // ── 无申报保守账（两种形态：degraded 标注 / artifact 缺）──

  it('cast_declaration degraded 形态（无 declaration 字段）→ 参数省略 declaration（保守账，非失败）', async () => {
    const calls = mockRecordTool();
    const node = await freshNode();
    await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: makeGraph(),
        cast_declaration: { degraded: true, reason: 'cast_declaration_parse_failed' },
      }),
      requirement: '',
    });
    expect(calls[0].params).not.toHaveProperty('declaration');
    expect(calls[0].params).toMatchObject({ episodeId: 'ep-1', draftText: 'x' });
  });

  it('cast_declaration artifact 缺 → 参数省略 declaration', async () => {
    const calls = mockRecordTool();
    const node = await freshNode();
    await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: makeGraph(),
      }),
      requirement: '',
    });
    expect(calls[0].params).not.toHaveProperty('declaration');
  });

  it('declaration 字段坏形态（safeParse 拒收）→ 当无申报（保守账），不把垃圾送 IPC', async () => {
    const calls = mockRecordTool();
    const node = await freshNode();
    await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: makeGraph(),
        cast_declaration: { declaration: { synopsis: '   ', present: 'not-an-array' }, source: 'declared' },
      }),
      requirement: '',
    });
    expect(calls[0].params).not.toHaveProperty('declaration');
  });

  // ── 缺各输入 graceful：scene_graph 无 assetRefs / draft.initial 无 text ──

  it('本章场零 assetRefs → plannedAssetRefs 省略（计划通道全零，非报错）', async () => {
    const calls = mockRecordTool();
    const node = await freshNode();
    const graph = makeGraph();
    graph.nodes = [scene('s_b', 'ep-1')];
    await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: graph,
      }),
      requirement: '',
    });
    expect(calls[0].params).not.toHaveProperty('plannedAssetRefs');
  });

  it('draft.initial 无 text 字段 → draftText 空串（粗筛通道全零，非报错）', async () => {
    const calls = mockRecordTool();
    const node = await freshNode();
    await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { title: 't' },
        scene_graph: makeGraph(),
      }),
      requirement: '',
    });
    expect(calls[0].params).toMatchObject({ draftText: '' });
  });

  // ── synopsis 三态透传 ──

  it('handler 返 synopsis=no_declaration（无申报保守账）→ artifact 透传 no_declaration + degradedReasons 透传', async () => {
    mockRecordTool({
      metadata: {
        ok: true,
        episodeId: 'ep-1',
        rowCount: 1,
        signals: [],
        synopsis: 'no_declaration',
        degradedReasons: ['summary_row_missing'],
      },
    });
    const node = await freshNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: makeGraph(),
      }),
      requirement: '',
    });
    const artifact = result.artifact as { ok: boolean; synopsis: string; degradedReasons: string[] };
    expect(artifact.ok).toBe(true);
    expect(artifact.synopsis).toBe('no_declaration');
    expect(artifact.degradedReasons).toEqual(['summary_row_missing']);
  });

  // ── graceful：execute 抛错 / handler ok:false（不产 {error:true}，链不破）──

  it('execute 抛错 → ok:false + execute_failed（非 chainRunner isErrorArtifact 终态形态）', async () => {
    mockRecordTool({ throwErr: new Error('IPC failure simulated') });
    const node = await freshNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: makeGraph(),
      }),
      requirement: '',
    });
    const artifact = result.artifact as { ok: boolean; reason: string; error?: unknown };
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toContain('execute_failed');
    expect(artifact.error).toBeUndefined();
  });

  it('handler 返 ok:false（project 未注册等）→ ok:false + handler_rejected', async () => {
    mockRecordTool({ metadata: { ok: false, reason: 'project_not_registered' } });
    const node = await freshNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep-1' },
        'draft.initial': { text: 'x' },
        scene_graph: makeGraph(),
      }),
      requirement: '',
    });
    const artifact = result.artifact as { ok: boolean; reason: string };
    expect(artifact.ok).toBe(false);
    expect(artifact.reason).toBe('handler_rejected');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BMad CR-002（2026-08-19）：两链内写工具的 toolPolicy 写类收录——readonly/suggest 档 LLM 直调被拦
// （record 是 per-episode 全量替换语义，一次误调即覆写真实账）；链内 registry.execute 直调不经
// filterToolsForPolicy 照旧可达（上面的节点测试即直调实证——fake registry execute 正常收到调用）。
// ════════════════════════════════════════════════════════════════════════════

describe('mention 写工具 toolPolicy 收录（BMad CR-002）', () => {
  it('record/degrade_episode_mentions classifyTool=write（非缺省 read——readonly 直调缺口封堵）', async () => {
    const { classifyTool } = await import('../src/runtime/toolPolicy');
    expect(classifyTool('record_episode_mentions')).toBe('write');
    expect(classifyTool('degrade_episode_mentions')).toBe('write');
  });

  it('readonly 档工具过滤后不含此二 id（LLM 不可见面）；auto 档照常含（链外 auto 直调合法）', async () => {
    const { filterToolsForPolicy } = await import('../src/runtime/toolPolicy');
    const toolOf = (id: string) => ({
      id,
      description: id,
      parameters: {},
      execute: async () => ({ title: id, output: '' }),
    });
    const tools = [toolOf('record_episode_mentions'), toolOf('degrade_episode_mentions'), toolOf('query_mentions')];
    const readonlyVisible = filterToolsForPolicy({ tools, sessionMode: 'readonly' }).map((t) => t.id);
    expect(readonlyVisible).toEqual(['query_mentions']); // 两写工具被滤，读工具照常
    const suggestVisible = filterToolsForPolicy({ tools, sessionMode: 'suggest' }).map((t) => t.id);
    expect(suggestVisible).toEqual(['query_mentions']); // write 类 suggest 亦拦（无 patch 人审面）
    const autoVisible = filterToolsForPolicy({ tools, sessionMode: 'auto' }).map((t) => t.id);
    expect(autoVisible.sort()).toEqual(['degrade_episode_mentions', 'query_mentions', 'record_episode_mentions']);
  });
});
