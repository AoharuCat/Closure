import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateFn } from '../src/nodes/llm-node';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4（C-A1 backfill 接线）：WorkflowRuntime.runBackfill 测试。
//
// 测四块（task B2 验证门）：
// 1. generate/writer 组装：mock generate（返合法 AxisExtraction）→ registry write_world_events 被调。
// 2. disk→episode→prose 解析：project.yaml episode_outlines + novel.chapters + chapters/*.md prose 对齐。
// 3. 幂等（per-slice idempotency 透传 backfillWorldState）+ graceful（session 缺 / 无旧章 / 读盘失败）。
// 4. context isolation：返摘要（ok/counts/reason），不灌全 writes。
//
// mock registry：write_world_events 注册 spy（记写表调用）。
// 真实磁盘 project.yaml + chapters/*.md（mkdtempSync）。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// mock registry：write_world_events tool spy + materialize_chapter_summary tool spy（Story 8.1 Step 6
// summary 重建 pass）。
let mockTool: { execute: ReturnType<typeof vi.fn> } | undefined;
let mockMaterializeTool: { execute: ReturnType<typeof vi.fn> } | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) =>
      id === 'write_world_events'
        ? mockTool
        : id === 'materialize_chapter_summary'
          ? mockMaterializeTool
          : undefined,
  },
}));

/** mock generate：对任何轴 prompt 返合法 AxisExtraction（含 1 subject + 1 patch，足够 merge 产 1 write）。 */
function makeBackfillGenerate(storyTime = 5): ReturnType<typeof vi.fn<GenerateFn>> {
  return vi.fn<GenerateFn>(async () => {
    const content = JSON.stringify({
      storyTime,
      title: 'backfill-extract',
      subjects: [{ id: 'erina', type: 'character', name: '艾莉娜', sourceCardId: 'char_erina' }],
      patches: [
        { subjectId: 'erina', path: '/hp', op: 'increment', value: -10, summary: '受伤', axis: 'physical' },
      ],
    });
    return { content, toolCalls: [], usage: null };
  }) as unknown as ReturnType<typeof vi.fn<GenerateFn>>;
}

describe('WorkflowRuntime.runBackfill（Story 3.4 C-A1 backfill 接线）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-run-backfill-'));
    mockTool = undefined;
    mockMaterializeTool = undefined;
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
    mockTool = undefined;
    mockMaterializeTool = undefined;
  });

  async function makeRuntime(generate: ReturnType<typeof vi.fn<GenerateFn>>) {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    return createWorkflowRuntime({ generate });
  }

  async function makeParent(runtime: any) {
    return runtime.createSession({ agentName: 'creative-director', projectPath });
  }

  /**
   * 写 project.yaml + chapter prose 文件。
   * chapters 按 episode.index → sort_order 映射（resolveChapterIdForEpisode 用）。
   */
  function writeProject(opts: {
    episodes: Array<{ id: string; index: number }>;
    chapters: Array<{ id: string; sort_order: number; contentFile: string; prose: string }>;
    sceneGraph?: Record<string, unknown>;
  }): void {
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    for (const ch of opts.chapters) {
      writeFileSync(path.join(projectPath, ch.contentFile), ch.prose, 'utf8');
    }

    const doc: Record<string, unknown> = {
      meta: { id: 'p1', name: 'test', type: 'novel', version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      episode_outlines: opts.episodes.map((ep) => ({ id: ep.id, index: ep.index, title: `第${ep.index + 1}章` })),
      novel: {
        chapters: opts.chapters.map((ch) => ({
          id: ch.id,
          title: `第${ch.sort_order + 1}章`,
          sort_order: ch.sort_order,
          sections: [{ id: `${ch.id}_s1`, sort_order: 0, content_file: ch.contentFile }],
        })),
      },
      ...(opts.sceneGraph ? { scene_graph: opts.sceneGraph } : {}),
    };
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  // ── 1. 正常路径：2 旧章 → backfill 跑 5 轴 × 2 章 → writer 被调 ──
  it('对旧章跑 5 轴提取 + writer 落表（mirror chapter-chain write_world_events 装配）', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const writeCalls: unknown[] = [];
    mockTool = { execute: vi.fn().mockImplementation(async (req: unknown) => { writeCalls.push(req); }) };

    writeProject({
      episodes: [{ id: 'ep1', index: 0 }, { id: 'ep2', index: 1 }],
      chapters: [
        { id: 'ch1', sort_order: 0, contentFile: 'chapters/ch1.md', prose: '艾莉娜走进酒馆。' },
        { id: 'ch2', sort_order: 1, contentFile: 'chapters/ch2.md', prose: '次日她离开小镇。' },
      ],
    });

    const result = await runtime.runBackfill(parent.id);

    expect(result.ok).toBe(true);
    expect(result.episodesProcessed).toBe(2);
    expect(result.episodesWritten).toBe(2);
    expect(result.totalPatches).toBeGreaterThan(0);
    // writer 被调 2 次（每 episode 1 write——5 轴同 storyTime 归同 slice）
    expect(mockTool.execute).toHaveBeenCalledTimes(2);
    // slice.id = `${episodeId}:${storyTime}`（稳定，幂等键）
    expect(writeCalls.map((c) => (c as { slice: { id: string } }).slice.id)).toEqual(['ep1:5', 'ep2:5']);
    // generate 被调 10 次（2 episode × 5 轴）
    expect(generate).toHaveBeenCalledTimes(10);
  });

  // ── 2. disk→episode→prose 解析：episode.index → sort_order 映射 ──
  it('episode.index → chapter.sort_order 映射正确（非 0-based 顺序也能对齐）', async () => {
    const generate = makeBackfillGenerate(3);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const writeCalls: unknown[] = [];
    mockTool = { execute: vi.fn().mockImplementation(async (req: unknown) => { writeCalls.push(req); }) };

    writeProject({
      // episode index 不连续（0, 2）——映射到 sort_order=0 和 sort_order=2
      episodes: [{ id: 'ep-a', index: 0 }, { id: 'ep-c', index: 2 }],
      chapters: [
        { id: 'ch-a', sort_order: 0, contentFile: 'chapters/ch-a.md', prose: '第一章。' },
        { id: 'ch-c', sort_order: 2, contentFile: 'chapters/ch-c.md', prose: '第三章。' },
      ],
    });

    const result = await runtime.runBackfill(parent.id);

    expect(result.ok).toBe(true);
    expect(result.episodesWritten).toBe(2);
    // slice.id 按 episodeId（ep-a / ep-c），不按章号
    expect(writeCalls.map((c) => (c as { slice: { id: string } }).slice.id)).toEqual(['ep-a:3', 'ep-c:3']);
  });

  // ── 3. 幂等：重跑同 episode → 同 slice.id（per-slice idempotency）──
  it('重跑同 episode → 同 slice.id（per-slice idempotency，替换不累积）', async () => {
    const generate = makeBackfillGenerate(7);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const writeCalls: unknown[] = [];
    mockTool = { execute: vi.fn().mockImplementation(async (req: unknown) => { writeCalls.push(req); }) };

    writeProject({
      episodes: [{ id: 'ep1', index: 0 }],
      chapters: [{ id: 'ch1', sort_order: 0, contentFile: 'chapters/ch1.md', prose: '艾莉娜走进酒馆。' }],
    });

    await runtime.runBackfill(parent.id);
    await runtime.runBackfill(parent.id);

    // 两次产同 slice.id（mergeWorldEvents 稳定 slice.id；insertWorldSlice source='derived' 替换不累积）
    expect(writeCalls.map((c) => (c as { slice: { id: string } }).slice.id)).toEqual(['ep1:7', 'ep1:7']);
  });

  // ── 4. graceful：session 不存在 ──
  it('session 不存在 → {ok:false, reason}（不崩）', async () => {
    const generate = makeBackfillGenerate();
    const runtime = await makeRuntime(generate);

    const result = await runtime.runBackfill('nonexistent-session');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('session not found');
  });

  // ── 5. graceful：project.yaml 不可读 ──
  it('project.yaml 不可读 → {ok:false, reason}（不崩）', async () => {
    const generate = makeBackfillGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    // 不写 project.yaml

    const result = await runtime.runBackfill(parent.id);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('不可读');
  });

  // ── 6. graceful：无旧章（无 episode / 无 chapter / 无 prose）──
  it('无旧章正文 → {ok:false, reason}（不崩，diagnose_impacts 继续 degrade）', async () => {
    const generate = makeBackfillGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    // 有 episode 但无 chapter（章未注册）
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({ episode_outlines: [{ id: 'ep1', index: 0 }] }),
      'utf8',
    );

    const result = await runtime.runBackfill(parent.id);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('无可补提取');
    expect(generate).not.toHaveBeenCalled();
  });

  // ── 7. graceful：chapter prose 文件不在磁盘 → 跳过该 episode ──
  it('chapter prose 文件缺失 → 跳过该 episode（不崩）', async () => {
    const generate = makeBackfillGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };

    // 2 episode 但只有 ep1 有 prose 文件（ep2 的 content_file 指向不存在文件）
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, 'chapters/ch1.md'), '第一章正文。', 'utf8');
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({
        episode_outlines: [{ id: 'ep1', index: 0, title: '第一章' }, { id: 'ep2', index: 1, title: '第二章' }],
        novel: {
          chapters: [
            { id: 'ch1', title: '第一章', sort_order: 0, sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/ch1.md' }] },
            { id: 'ch2', title: '第二章', sort_order: 1, sections: [{ id: 's2', sort_order: 0, content_file: 'chapters/ch2.md' }] }, // 文件不存在
          ],
        },
      }),
      'utf8',
    );

    const result = await runtime.runBackfill(parent.id);

    // 只处理了 ep1（ep2 prose 缺被跳过）
    expect(result.ok).toBe(true);
    expect(result.episodesProcessed).toBe(1);
    expect(result.episodesWritten).toBe(1);
  });

  // ── 8. BMad CR Fix 1（E1 静默假成功）：write_world_events 工具未注册 → throw → writeErrors → ok:false ──
  it('write_world_events 未注册 → throw → writeErrors → ok:false + degraded（BMad CR Fix 1，消静默假成功）', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    // mockTool = undefined → registry.get('write_world_events') 返 undefined → writeWorldEvents wrapper throw
    writeProject({
      episodes: [{ id: 'ep1', index: 0 }],
      chapters: [{ id: 'ch1', sort_order: 0, contentFile: 'chapters/ch1.md', prose: '正文。' }],
    });

    const result = await runtime.runBackfill(parent.id);

    // BMad CR Fix 1：tool 未注册 → writeWorldEvents throw → backfillWorldState per-write catch → writeErrors
    // → ok:false（非旧 ok:true 假成功）+ degraded:true + reason 标 write errors。
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('write errors');
    // backfillWorldState 仍跑（generate 被调，extractor 产数据），但写表全失败。
    expect(result.episodesWritten).toBe(1);
    expect(generate).toHaveBeenCalled();
  });

  // ── 9. context isolation：返摘要不灌全 writes ──
  it('返摘要（ok/episodesProcessed/episodesWritten/totalPatches），不含 writes 数组', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };
    writeProject({
      episodes: [{ id: 'ep1', index: 0 }],
      chapters: [{ id: 'ch1', sort_order: 0, contentFile: 'chapters/ch1.md', prose: '正文。' }],
    });

    const result = await runtime.runBackfill(parent.id);

    const keys = Object.keys(result);
    expect(keys).not.toContain('writes');
    expect(keys).not.toContain('episodes'); // 逐 episode 细节不灌
    expect(keys).toContain('ok');
    expect(keys).toContain('episodesProcessed');
    expect(keys).toContain('episodesWritten');
  });

  // ── 10. scene_graph 透传 extractor（可选）──
  it('有 scene_graph → 透传给 extractor（selectScenesForEpisode 按 episodeId 精选）', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };
    writeProject({
      episodes: [{ id: 'ep1', index: 0 }],
      chapters: [{ id: 'ch1', sort_order: 0, contentFile: 'chapters/ch1.md', prose: '正文。' }],
      sceneGraph: {
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 5, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] }],
        edges: [],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
        art_overrides: [],
        version: 0,
      },
    });

    const result = await runtime.runBackfill(parent.id);

    expect(result.ok).toBe(true);
    // extractor 正常跑（scene_graph 透传未致崩）
    expect(result.episodesWritten).toBe(1);
  });

  // ── 11. BMad CR Fix 2（E3 路径穿越）：content_file 含 `../` → skip episode ──
  it('content_file 逃逸 projectPath（../）→ skip episode + 不读盘（路径穿越 guard）', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, 'chapters/ch1.md'), '第一章正文。', 'utf8');
    // content_file 指向 project 外（`../secret.md`）——路径穿越 guard 应 skip。
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({
        episode_outlines: [{ id: 'ep1', index: 0, title: '第一章' }],
        novel: {
          chapters: [
            { id: 'ch1', title: '第一章', sort_order: 0, sections: [{ id: 's1', sort_order: 0, content_file: '../secret.md' }] },
          ],
        },
      }),
      'utf8',
    );

    const result = await runtime.runBackfill(parent.id);

    // 路径穿越 → skip episode → 无可补提取 → ok:false。
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('无可补提取');
    expect(generate).not.toHaveBeenCalled();
  });

  // ── 12. BMad CR Fix 6（E6 成本失控）：episodes > cap → 只处理前 cap 个 + degraded ──
  it('episodes 超过 cap（20）→ 只处理前 20 个 + degraded + reason 标 N/M', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };
    // 25 episode（超 cap 20）——每章独立 content_file。
    const episodes = Array.from({ length: 25 }, (_, i) => ({ id: `ep${i}`, index: i }));
    const chapters = episodes.map((ep, i) => ({
      id: `ch${ep.id}`,
      sort_order: i,
      contentFile: `chapters/ch${i}.md`,
      prose: `第${i + 1}章正文。`,
    }));
    writeProject({ episodes, chapters });

    const result = await runtime.runBackfill(parent.id);

    // cap 截断：ok:true（有落表）但 degraded:true + reason 标 N/M。
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('backfilled');
    expect(result.reason).toContain('of 25');
    expect(result.reason).toContain('remaining');
    // 只处理了 20 个（cap）。
    expect(result.episodesProcessed).toBe(20);
    expect(result.episodesWritten).toBe(20);
  });

  // ── 13. Story 8.1 Step 6：summary 重建 pass（重提取落表后逐 episode materialize）──
  it('materialize 工具已注册 → 逐落表 episode 物化（metadata.ok 判成功 + additive 字段透传，不翻 degraded）', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };
    const materializeCalls: Array<{ episodeId: string }> = [];
    mockMaterializeTool = {
      execute: vi.fn().mockImplementation(async (params: { episodeId: string }) => {
        materializeCalls.push(params);
        // mirror shell handler never-throws：失败进 metadata.ok:false 非异常（ep2 模拟失败路径）。
        return params.episodeId === 'ep2'
          ? { title: 'materialize', output: '物化失败', metadata: { ok: false, error: 'db locked' } }
          : { title: 'materialize', output: '已物化', metadata: { ok: true } };
      }),
    };

    writeProject({
      episodes: [{ id: 'ep1', index: 0 }, { id: 'ep2', index: 1 }],
      chapters: [
        { id: 'ch1', sort_order: 0, contentFile: 'chapters/ch1.md', prose: '正文一。' },
        { id: 'ch2', sort_order: 1, contentFile: 'chapters/ch2.md', prose: '正文二。' },
      ],
    });

    const result = await runtime.runBackfill(parent.id);

    // 重提取本体成功；pass 只对本次落表的 episodes（2 章均非 skipped）逐个 materialize。
    expect(result.ok).toBe(true);
    expect(materializeCalls).toEqual([{ episodeId: 'ep1' }, { episodeId: 'ep2' }]);
    // metadata.ok:false 不计成功（E1「静默假成功」教训）→ summariesMaterialized=1 + summaryFailed 含 ep2。
    expect(result.summariesMaterialized).toBe(1);
    expect(result.summaryFailed).toEqual([{ episodeId: 'ep2', error: 'db locked' }]);
    // summary 是二级 DERIVED 缓存：其失败不翻 degraded/reason（diagnose_impacts 成功门不被拖累）。
    expect(result.degraded).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  // ── 14. Story 8.1 Step 6：materialize 工具未注册 → pass 跳过 + 返回形状零变 ──
  it('materialize 工具未注册 → warn 跳过 pass + 不加 summariesMaterialized/summaryFailed 字段（零回归）', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };
    // mockMaterializeTool 保持 undefined → registry.get 返 undefined → pass 跳过。
    writeProject({
      episodes: [{ id: 'ep1', index: 0 }],
      chapters: [{ id: 'ch1', sort_order: 0, contentFile: 'chapters/ch1.md', prose: '正文。' }],
    });

    const result = await runtime.runBackfill(parent.id);

    expect(result.ok).toBe(true);
    expect(Object.keys(result)).not.toContain('summariesMaterialized');
    expect(Object.keys(result)).not.toContain('summaryFailed');
  });

  // ── 15. CRLF 章文读侧归一（多 OS R3 / FS#15 同类点）：外部编辑器 CRLF 存盘 → \r 不进 extractor prompt ──
  it('CRLF 章文 → \\r 不进 extractor prompt（读侧归一，提取照常落表）', async () => {
    const generate = makeBackfillGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    mockTool = { execute: vi.fn().mockResolvedValue(undefined) };

    writeProject({
      episodes: [{ id: 'ep1', index: 0 }],
      chapters: [
        {
          id: 'ch1',
          sort_order: 0,
          contentFile: 'chapters/ch1.md',
          prose: '艾莉娜走进酒馆。BACKFILL_PROSE_MARKER\r\n第二段。\r\n',
        },
      ],
    });

    const result = await runtime.runBackfill(parent.id);

    expect(result.ok).toBe(true);
    expect(result.episodesWritten).toBe(1);
    // 全部 generate 调用的全部消息零 \r（prose 已归一 LF），marker 证实 prose 确实进了 prompt。
    const allContent = generate.mock.calls
      .flatMap((call) => (call[0] as Array<{ content: string }>).map((m) => m.content))
      .join('\n');
    expect(allContent).toContain('BACKFILL_PROSE_MARKER');
    expect(allContent).not.toContain('\r');
  });
});
