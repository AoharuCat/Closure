import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';

// Story 4.0 §4.8 / implement.md 6.3：leader `write_chapter` tool 单测。
// mock skillExecutor.runChapterChain → 验：input 解析 + initialArtifacts 组装（scene_graph /
// settings_context / chapter_brief_input / promise_registry 四 artifact 齐）+ summary 透传。
// mirror skill.resourceTool.test.ts 的 ToolContext mock 模式。

describe('write_chapter tool（Story 4.0 §4.8）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-'));
    runChapterChain = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
      },
    };
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** 写一份含链段所需字段的 project.yaml fixture。 */
  function writeProjectYaml(overrides: Record<string, unknown> = {}): void {
    const doc = {
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市', '奇幻'] },
      world_setting: { premise: '灵气复苏的现代都市' },
      asset_cards: [
        {
          id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年',
          narrative: { storyFunction: '主角' },
          desireAndBottomline: { coreDesire: '变强守护家族' },
          personality: { coreTraits: ['坚韧'] },
        },
      ],
      scene_graph: {
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }],
        edges: [],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
      ...overrides,
    };
    writeFileSync(path.join(projectPath, 'project.yaml'), YAML_STRINGIFY(doc), 'utf8');
  }

  /** js-yaml 在 SUT 内使用；fixture 用结构化 YAML 手写（避开 yaml 包依赖）。 */
  function YAML_STRINGIFY(doc: Record<string, unknown>): string {
    // 极简手写：信任 js-yaml 能解析（本测试只验 tool 行为，不验 YAML 序列化）。
    // 用 JSON（js-yaml 是 JSON 超集，project.yaml 含 JSON 子集可解析）。
    return JSON.stringify(doc);
  }

  const SUMMARY_OK: RunSnapshotSummary = {
    status: 'completed',
    routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
    reviewVerdict: 'pass',
    draftTitle: '第二章 B 城',
    draftWordCount: 2800,
    errors: [],
    // 4.1 Step 4：chapter_accept（onAccept 产；mock runChapterChain 直接返，绕过 onAccept 闭包）。
    chapter_accept: {
      chapterId: 'ch_001',
      candidate: { title: '第二章 B 城', content: '正文…', wordCount: 2800 },
      runId: 'run_mock',
    },
  };

  // ════════════════════════════════════════════════════════════════════════════
  // 1. 组 initialArtifacts + 调 runChapterChain（四 artifact key 齐）
  // ════════════════════════════════════════════════════════════════════════════

  it('读 project.yaml → 组四 artifact → 调 runChapterChain（sessionId + requirement=episodeId）', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY', tone: '紧张' } },
      ctx,
    );

    // runChapterChain 被调一次，parentSessionId = leader sessionId
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [sessionId, artifacts, options] = runChapterChain.mock.calls[0];
    expect(sessionId).toBe('leader-session-1');
    expect(options.requirement).toBe('ep1');
    expect(options.abort).toBe(ctx.abort);
    // 4.1 Step 4：onAccept 闭包传入（accept 分支产 chapter_accept）
    expect(typeof options.onAccept).toBe('function');

    // 四 artifact key 齐
    expect(artifacts['scene_graph']).toBeDefined();
    expect(artifacts['settings_context']).toBeDefined();
    expect(artifacts['chapter_brief_input']).toEqual({
      episodeId: 'ep1',
      brief: { goal: 'REACH_B_CITY', tone: '紧张' },
    });
    expect(artifacts['promise_registry']).toBeDefined();
    // episode_outlines 注入（fixture 含）
    expect(artifacts['episode_outlines']).toBeDefined();

    // settings_context 含设定（2.3 prefix 编译）
    expect(artifacts['settings_context']).toContain('林动');
    expect(artifacts['settings_context']).toContain('都市奇幻');

    // result 透传 summary
    expect(result.title).toBe('write_chapter: ep1');
    expect(result.output).toContain('completed');
    expect(result.output).toContain('第二章 B 城');
    expect(result.output).toContain('accept_as_truth');
    expect(result.metadata?.summary).toEqual(SUMMARY_OK);
    // 4.1 Step 4：chapter_accept → field_patch metadata（chapter_candidate 类型，复用 patch review 流）
    expect(result.metadata?.type).toBe('field_patch');
    expect(result.metadata?.field).toBe('chapter_candidate');
    expect(result.metadata?.action).toBe('set');
    expect((result.metadata?.data as { chapterId: string }).chapterId).toBe('ch_001');
    expect(result.output).toContain('等待你在工作台审阅后落盘');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Story 6.5 B3（CR-B3）：agent 直读 project.yaml foreshadow→promise fallback 迁移。
  //
  // agent loadChainProjectInput 不经 local-bff loadProject（layering），legacy disk 含 foreshadow_registry
  // （无 promise_registry）时须 fallback 迁移（mirror localProjectRepository 迁移块），否则 chain 无
  // promise_registry（brief#7/Reader-Audit graceful 降级但失数据）。shell/dogfood IPC 路径经 loadProject
  // （已迁移），agent 路径补齐 → 两路径一致。
  // ════════════════════════════════════════════════════════════════════════════

  it('B3：legacy project.yaml 含 foreshadow_registry（无 promise_registry）→ fallback 迁移 promise_registry artifact', async () => {
    // 模拟 legacy disk（Phase A 前持久化）：含已退役的 foreshadow_registry，无 promise_registry。
    // loadChainProjectInput 须 fallback transformForeshadowToPromise 产 promise_registry artifact。
    writeProjectYaml({
      promise_registry: undefined, // 移除新 field
      foreshadow_registry: {
        items: [
          {
            id: 'fs_kings_gun',
            title: '国王的佩剑',
            content: '壁上佩剑将在终章出鞘。',
            status: 'planted',
            plant_ref: 's1',
            category: 'item',
            tags: ['武器'],
          },
        ],
        version: 0,
      },
    });
    // 移除 promise_registry key（writeProjectYaml 默认含空 promise_registry，此处覆盖为 undefined 后
    // JSON.stringify 会保留 null——改用 delete 路径：直接写一份不含 promise_registry 的 yaml）。
    const fs = await import('node:fs');
    const doc = JSON.parse(fs.readFileSync(path.join(projectPath, 'project.yaml'), 'utf8'));
    delete doc.promise_registry;
    fs.writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
    // 确认 fixture：有 foreshadow_registry，无 promise_registry（legacy 形态）。
    expect(doc.foreshadow_registry).toBeDefined();
    expect(doc.promise_registry).toBeUndefined();

    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');
    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } },
      ctx,
    );

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [, artifacts] = runChapterChain.mock.calls[0];
    // B3 核心：foreshadow_registry → promise_registry 迁移（loadChainProjectInput fallback）。
    expect(artifacts['promise_registry']).toBeDefined();
    const registry = artifacts['promise_registry'] as { promises: unknown[]; beats: unknown[] };
    expect(registry.promises).toHaveLength(1);
    expect((registry.promises[0] as { id: string; source_type: string }).id).toBe('fs_kings_gun');
    // 迁移标记：source_type=migrated_foreshadow + foreshadow 是 setup_payoff 子类（Phase A 保证）。
    expect((registry.promises[0] as { source_type: string }).source_type).toBe('migrated_foreshadow');
    // status planted → plant beat（sceneRef=plant_ref=s1，Phase A 迁移映射）。
    expect(registry.beats).toHaveLength(1);
    expect((registry.beats[0] as { kind: string; sceneRef: string }).kind).toBe('plant');
    expect((registry.beats[0] as { sceneRef: string }).sceneRef).toBe('s1');
  });

  it('B3：新 project.yaml 含 promise_registry → 直读不覆盖（不走 foreshadow fallback）', async () => {
    // 新项目（Phase A 后持久化）：含 promise_registry（无 foreshadow_registry）→ 直读，不走 fallback。
    writeProjectYaml({
      promise_registry: {
        promises: [{ id: 'existing_p', title: '既有 Promise', summary: '已登记' }],
        beats: [],
        version: 0,
      },
    });
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');
    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } },
      ctx,
    );

    const [, artifacts] = runChapterChain.mock.calls[0];
    const registry = artifacts['promise_registry'] as { promises: { id: string }[] };
    // 直读既有 promise_registry，不被任何 fallback 覆盖。
    expect(registry.promises).toHaveLength(1);
    expect(registry.promises[0].id).toBe('existing_p');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. 4.1 §3.2 gate：chapterBrief 缺省（goal 空）→ 阻断 needs_world_context（不跑链段）
  // ════════════════════════════════════════════════════════════════════════════

  it('chapterBrief 缺省 → gate 阻断 needs_world_context（不调 runChapterChain）', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1' }, ctx);

    // gate 阻断：链段不跑
    expect(runChapterChain).not.toHaveBeenCalled();
    // output 含 readiness 阶段 + 缺什么提示
    expect(result.output).toContain('needs_world_context');
    expect(result.output).toContain('goal');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. project.yaml 缺/不可读 → 报错给 leader（不调 runChapterChain）
  // ════════════════════════════════════════════════════════════════════════════

  it('project.yaml 缺 → output 报错 + 不调 runChapterChain', async () => {
    // 不写 project.yaml
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1' }, ctx);

    expect(runChapterChain).not.toHaveBeenCalled();
    expect(result.output).toContain('missing or unreadable');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. 无 runtime（skillExecutor 缺）→ 报「unavailable」
  // ════════════════════════════════════════════════════════════════════════════

  it('skillExecutor.runChapterChain 缺 → 报 unavailable（mirror spawn_agent）', async () => {
    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const noRuntimeCtx: ToolContext = {
      sessionId: 's1',
      projectPath,
      abort: new AbortController().signal,
      // skillExecutor 缺
    };

    const result = await writeChapterTool.execute({ episodeId: 'ep1' }, noRuntimeCtx);

    expect(result.output).toContain('unavailable');
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. runChapterChain 抛错 → tool 不崩，返失败 output（mirror spawn_agent catch）
  // ════════════════════════════════════════════════════════════════════════════

  it('runChapterChain 抛错 → output 含失败信息（不抛出 tool）', async () => {
    writeProjectYaml();
    runChapterChain.mockRejectedValue(new Error('LLM provider timeout'));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } },
      ctx,
    );

    expect(result.output).toContain('Chapter chain failed');
    expect(result.output).toContain('LLM provider timeout');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. summary 含 errors → output 含 errors 行
  // ════════════════════════════════════════════════════════════════════════════

  it('summary 含 errors → output 含 errors 行', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue({
      status: 'blocked',
      errors: ['DAG 依赖缺失', 'cap 超限'],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } },
      ctx,
    );

    expect(result.output).toContain('DAG 依赖缺失');
    expect(result.output).toContain('cap 超限');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Story 8.4 B2/B3（design §2.2 L3）：复杂场景标记——summary.compileReport.overloaded=true →
  // leader 一行「建议拆章」人审文案（B 段唯一 leader 侧改动）；非 overloaded 零痕迹。
  // ═══════════════════════════════════════════════════════════════════════════

  it('Story 8.4：compileReport.overloaded → output 含「复杂场景信号」建议拆章行（人裁不拦截）', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      errors: [],
      compileReport: {
        segments: [{ name: 'goal', token_estimate: 135_000 }],
        total: 135_012,
        degraded: [{ segment: 'plot_points_state', action: 'L2 移出热层' }],
        overloaded: true,
      },
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } },
      ctx,
    );

    expect(result.output).toContain('复杂场景信号');
    expect(result.output).toContain('拆章');
    expect(result.output).toContain('135012');
    expect(result.output).toContain('由人裁决');
  });

  it('Story 8.4：compileReport 在但非 overloaded（正常 L0）→ 零痕迹（不刷降级噪声）', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      errors: [],
      compileReport: {
        segments: [{ name: 'goal', token_estimate: 60 }],
        total: 420,
        overloaded: false,
      },
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } },
      ctx,
    );

    expect(result.output).not.toContain('复杂场景信号');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.1 §3.2：write_chapter tool 运行时 gate（computeReadiness + assertBriefReady）
// non-ready brief 阻断链段触发 + 返「缺什么」给 leader。5 档覆盖。
// ════════════════════════════════════════════════════════════════════════════

describe('write_chapter tool readiness gate（4.1 §3.2）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-gate-'));
    runChapterChain = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn() },
    };
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function writeProjectYaml(doc: Record<string, unknown>): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  const BASE_DOC = {
    meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
    creative_brief: { genre: '都市奇幻', genre_tags: ['都市', '奇幻'] },
    world_setting: { premise: '灵气复苏都市' },
    asset_cards: [
      {
        id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年',
        narrative: { storyFunction: '主角' },
        desireAndBottomline: { coreDesire: '变强' },
        personality: { coreTraits: ['坚韧'] },
      },
    ],
    scene_graph: {
      nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }],
      edges: [],
      lines: [],
    },
    promise_registry: { promises: [], beats: [], version: 0 },
  };

  it('needs_plot：scene_graph 空 → 阻断 + output 含 needs_plot（不调 runChapterChain）', async () => {
    writeProjectYaml({ ...BASE_DOC, scene_graph: { nodes: [], edges: [], lines: [] } });
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(runChapterChain).not.toHaveBeenCalled();
    expect(result.output).toContain('needs_plot');
    expect(result.output).toContain('未就绪');
  });

  it('needs_world_anchor：无设定（asset_cards/world_setting/creative_brief 全空）→ 阻断', async () => {
    writeProjectYaml({
      ...BASE_DOC,
      asset_cards: [],
      world_setting: {},
      creative_brief: {},
    });
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(runChapterChain).not.toHaveBeenCalled();
    expect(result.output).toContain('needs_world_anchor');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Story 2.2 WP-D（design §4 gate 消费）：needs_world_anchor 拦截消息附本章设定缺口
  // （findSettingCoverageGaps 单源 + episode 涉及场过滤 + dangling_ref warning 附注，不新增档位）。
  // ════════════════════════════════════════════════════════════════════════════

  it('Story 2.2：needs_world_anchor + 本章场 dangling refs → 拦截消息附具体缺卡（warning 附注）', async () => {
    writeProjectYaml({
      ...BASE_DOC,
      asset_cards: [],
      world_setting: {},
      creative_brief: {},
      scene_graph: {
        nodes: [{
          id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 },
          assetRefs: ['card-tianji', 'card-youming'],
        }],
        edges: [],
        lines: [],
      },
    });
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(runChapterChain).not.toHaveBeenCalled();
    expect(result.output).toContain('needs_world_anchor');
    // 「缺什么」从「设定全空」升级为具体缺卡。
    expect(result.output).toContain('本章设定缺口');
    expect(result.output).toContain('「card-tianji」不存在');
    expect(result.output).toContain('「card-youming」不存在');
  });

  it('Story 2.2 CR-08-16-109：缺口附注有条数上限（top-5 + 总数折叠，mirror leader 注入段截断）', async () => {
    writeProjectYaml({
      ...BASE_DOC,
      asset_cards: [],
      world_setting: {},
      creative_brief: {},
      scene_graph: {
        nodes: [{
          id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 },
          assetRefs: Array.from({ length: 9 }, (_, i) => `card-missing-${i + 1}`),
        }],
        edges: [],
        lines: [],
      },
    });
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(result.output).toContain('needs_world_anchor');
    expect(result.output).toContain('本章设定缺口');
    // 前 5 条 + 折叠行（不 9 行全刷拦截消息）。
    expect(result.output).toContain('「card-missing-5」不存在');
    expect(result.output).not.toContain('「card-missing-6」不存在');
    expect(result.output).toContain('等共 9 条缺口');
  });

  it('Story 2.2：needs_world_anchor 但本章场无 refs（无 dangling）→ 不附缺口附注', async () => {
    // BASE_DOC 默认 s1 无 assetRefs → 无 dangling → 拦截消息保持原样（零痕迹拼接）。
    writeProjectYaml({
      ...BASE_DOC,
      asset_cards: [],
      world_setting: {},
      creative_brief: {},
    });
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(result.output).toContain('needs_world_anchor');
    expect(result.output).not.toContain('本章设定缺口');
  });

  it('Story 2.2：非 anchor 档（needs_world_context）不附——仅 needs_world_anchor 分支消费', async () => {
    // 设定在（char-1 + premise + genre）+ goal 空 → needs_world_context；scene 悬空 ref 存在但不附。
    writeProjectYaml({
      ...BASE_DOC,
      scene_graph: {
        nodes: [{
          id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 },
          assetRefs: ['card-missing'],
        }],
        edges: [],
        lines: [],
      },
    });
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1' }, ctx);

    expect(result.output).toContain('needs_world_context');
    expect(result.output).not.toContain('本章设定缺口');
    expect(result.output).not.toContain('「card-missing」');
  });

  it('Story 2.2：缺口在他章场（ep2 的 s2）→ episode 过滤不附（只附本章涉及场）', async () => {
    writeProjectYaml({
      ...BASE_DOC,
      asset_cards: [],
      world_setting: {},
      creative_brief: {},
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
          {
            id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 1, pos: 0 },
            assetRefs: ['card-other-episode'],
          },
        ],
        edges: [],
        lines: [],
      },
    });
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(result.output).toContain('needs_world_anchor');
    // ep2 场的缺口被过滤（本章 ep1 只涉及 s1）。
    expect(result.output).not.toContain('本章设定缺口');
    expect(result.output).not.toContain('card-other-episode');
  });

  it('needs_chapter_brief：episode 无匹配场（场在 ep1，目标 ep_other）→ 阻断', async () => {
    writeProjectYaml(BASE_DOC);
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep_other', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(runChapterChain).not.toHaveBeenCalled();
    expect(result.output).toContain('needs_chapter_brief');
  });

  it('ready：全 populated → gate 通过，调 runChapterChain（不阻断）', async () => {
    writeProjectYaml(BASE_DOC);
    runChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.1 Step 4：write_chapter chapter_accept → field_patch metadata（CR-15b）。
// accept 持久化经 metadata 走既有 patch review 流（UI 接收/显示 defer Step 5；本 step 只产 metadata）。
// ════════════════════════════════════════════════════════════════════════════

describe('write_chapter tool chapter_accept metadata（4.1 Step 4 / CR-15b）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-accept-'));
    runChapterChain = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn() },
    };
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** 写一份 ready 的 project.yaml（含 novel.chapters 供 onAccept 闭包 chapterId 解析）。 */
  function writeReadyProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }], edges: [], lines: [] },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
      novel: { chapters: [{ id: 'ch_001', title: '第1章', sort_order: 0, sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }] }] },
    }), 'utf8');
  }

  it('chapter_accept 含 storyDecisions（deviation=true）→ metadata.data.storyDecisions 下发', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '角色硬气' },
      errors: [],
      chapter_accept: {
        chapterId: 'ch_001',
        candidate: { content: '正文' },
        runId: 'run_d1',
        storyDecisions: [{
          id: 'accept-run_d1', summary: '偏离', reason: '角色硬气', alternatives: [],
          risk: '须校正', status: 'decided', source: 'accept_as_truth', relatedEpisodeId: 'ep1',
          createdAt: '2026-08-01T00:00:00.000Z',
        }],
      },
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    const data = result.metadata?.data as { storyDecisions?: unknown[] };
    expect(data.storyDecisions).toBeDefined();
    expect(data.storyDecisions).toHaveLength(1);
  });

  it('Story 4.6：route=escalate_user 无 chapter_accept / 无 findings → 不派裁决器 + 不产 field_patch + 告知无候选', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      errors: [],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(result.metadata?.type).toBeUndefined();
    expect(result.metadata?.field).toBeUndefined();
    expect(result.metadata?.summary).toBeDefined();
    expect(result.output).toContain('无章节候选'); // D4：escalate 无候选告知
  });

  it('Story 4.6 D4：route=escalate_user 有 chapter_accept + findings → 派裁决器（allowedTools=[]）+ 产 field_patch + output 含裁决建议', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      reviewVerdict: 'escalate',
      draftText: '正文内容……',
      escalateFindings: [
        { severity: 'block', quote: '林动突然硬气', location: '段1句2', explanation: 'OOC 嫌疑', subClass: 'Characterization.memory' },
      ],
      chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文…' }, runId: 'run_mock' },
      errors: [],
    });
    const runAgentWithExplicitSystem = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        analysis: '硬气是角色弧推进',
        recommendation: 'accept',
        recommendationReason: '倾向接受为真相',
        options: [{ label: '改稿', reason: '破坏一致性' }, { label: '接受为真相', reason: '角色弧推进' }],
      }),
    });
    (ctx.skillExecutor as Record<string, unknown>).runAgentWithExplicitSystem = runAgentWithExplicitSystem;
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // 裁决器被派（adjudicator-agent，allowedTools=[] 纯判断）。此处只断言 adjudicator-agent 这一调用
    // 存在 + allowedTools=[]。
    const adjudicatorCall = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'adjudicator-agent');
    expect(adjudicatorCall).toBeDefined();
    const opts = adjudicatorCall![3] as { allowedTools?: string[] };
    expect(opts.allowedTools).toEqual([]);
    // output 含 findings grounding + 裁决建议
    expect(result.output).toContain('林动突然硬气');
    expect(result.output).toContain('灰区裁决器初审');
    expect(result.output).toContain('硬气是角色弧推进');
    // D4：chapter_accept 转 field_patch（PatchReview 作裁决 UI）
    expect(result.metadata?.type).toBe('field_patch');
    expect(result.metadata?.field).toBe('chapter_candidate');
  });

  it('Story 4.6 D5：裁决器派发失败（runAgentWithExplicitSystem 抛错）→ graceful 降级（output 仍带 findings，不抛，chapter_accept 照转）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      draftText: '正文……',
      escalateFindings: [
        { severity: 'block', quote: '硬气', location: '段1', explanation: 'OOC 嫌疑' },
      ],
      chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文…' }, runId: 'r' },
      errors: [],
    });
    const runAgentWithExplicitSystem = vi.fn().mockRejectedValue(new Error('agent down'));
    (ctx.skillExecutor as Record<string, unknown>).runAgentWithExplicitSystem = runAgentWithExplicitSystem;
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 裁决块跳过，但 findings 仍在（graceful 降级 D5）
    expect(result.output).not.toContain('灰区裁决器初审');
    expect(result.output).toContain('硬气'); // findings quote 仍在
    expect(result.metadata?.type).toBe('field_patch'); // chapter_accept 照转
  });

  it('route=accept 但 chapter_accept 缺省（映射失败） → 不产 field_patch + warning 告知章未注册', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      errors: [],
      // chapter_accept 缺省（onAccept 映射失败 / mock 不产）
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(result.metadata?.type).toBeUndefined();
    expect(result.output).toContain('章未在 project.yaml 注册');
  });

  it('onAccept 闭包从 project 数据解析 chapterId（ep1.index=0 → novel.chapters[sort_order=0]=ch_001）', async () => {
    writeReadyProject();
    // mock 让 runChapterChain 调用 options.onAccept（模拟链段 accept 分支），用真实 project 数据测闭包。
    runChapterChain.mockImplementation(async (_sid: string, _arts: unknown, opts: { onAccept?: (snap: unknown, ctx: { nowISO: string }) => unknown }) => {
      const fakeSnapshot = {
        runId: 'run_closure',
        artifacts: {
          'draft.initial': { title: '第1章', text: '正文内容', wordCount: 100 },
          'route_decision': { decision: 'accept_as_truth', reason: '通过', deviation: false },
        },
      };
      const ca = opts.onAccept?.(fakeSnapshot, { nowISO: '2026-08-01T00:00:00.000Z' });
      return {
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '通过' },
        errors: [],
        chapter_accept: ca as { chapterId: string; candidate: { content: string } },
      };
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // onAccept 闭包用 project.episode_outlines + novel.chapters 解析出 ch_001
    expect((result.metadata?.data as { chapterId: string }).chapterId).toBe('ch_001');
    expect((result.metadata?.data as { candidate: { content: string } }).candidate.content).toBe('正文内容');
  });

  it('chapterId 直传优先（绕过映射推断）', async () => {
    writeReadyProject();
    runChapterChain.mockImplementation(async (_sid: string, _arts: unknown, opts: { onAccept?: (snap: unknown, ctx: { nowISO: string }) => unknown }) => {
      const fakeSnapshot = {
        runId: 'run_direct',
        artifacts: {
          'draft.initial': { text: '正文' },
          'route_decision': { decision: 'accept_as_truth', reason: '通过' },
        },
      };
      const ca = opts.onAccept?.(fakeSnapshot, { nowISO: '2026-08-01T00:00:00.000Z' });
      return { status: 'completed', routeDecision: { decision: 'accept_as_truth', reason: '通过' }, errors: [], chapter_accept: ca as { chapterId: string } };
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterId: 'ch_custom_direct', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect((result.metadata?.data as { chapterId: string }).chapterId).toBe('ch_custom_direct');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BMad CR-T1-053：leader 路径硬抛错补发 error 链哨兵（mirror dogfood 路径 c2ee0b8 形态）。
  // 修前：catch 只返 tool result 不发哨兵 → leader done 事件兜底 finalizeChainRun('aborted')
  // ——infra 硬错误被误标成用户中断（UI 链卡「已中断」+ 重试钮语义错位）。
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-T1-053：runChapterChain 硬抛错 → catch 补发 error 链哨兵（__chain_run__）+ 既有失败 tool result', async () => {
    writeReadyProject();
    runChapterChain.mockRejectedValue(new Error('dispatch infra boom'));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const chainEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY', tone: '紧张' } },
      { ...ctx, emitChainEvent: (e: { type: string; data: Record<string, unknown> }) => chainEvents.push(e) },
    );

    // 既有行为不变：catch 不崩 tool，返结构化失败文案。
    expect(result.output).toContain('Chapter chain failed: dispatch infra boom');
    // 修复点：error 哨兵终态帧（mirror closureChainIpc catch 形态）——UI 链卡标「失败」而非被
    // leader done 兜底误标「已中断」。
    expect(chainEvents).toContainEqual({
      type: 'chain-node-done',
      data: { nodeId: '__chain_run__', status: 'error' },
    });
  });

  it('CR-T1-053 反例：链正常完成（非 throw）→ 不发 catch 哨兵（终态帧由 runChapterChain 哨兵负责）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
      reviewVerdict: 'pass',
      draftTitle: '第1章',
      draftWordCount: 2800,
      errors: [],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const chainEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY', tone: '紧张' } },
      { ...ctx, emitChainEvent: (e: { type: string; data: Record<string, unknown> }) => chainEvents.push(e) },
    );

    expect(chainEvents).toHaveLength(0); // catch 不触发 → 无 catch 哨兵
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BMad CR-T1-056 + dogfood R2 #105 缝①（R2.1）：per-project 活动链守卫 busy（workflow
  // runChapterChain 入口闸拒绝）的分派——
  // - 他 session 持有 → 早退提示（不进 auto_revise 循环 / post-settle）+ 不发链哨兵（另一条链
  //   不得被本次拒绝误终态化）；
  // - 自家租约（heldBy === ctx.sessionId）→ 按 chapterBrief 差异分派：有差异 → clearChainSnapshot +
  //   fresh；无差异/拿不到快照 → resume:{fromSnapshot:true} 裸 continue（维持原案，挂起 belt 自动
  //   转重查 + approvedDeviations 绑定）。
  // ════════════════════════════════════════════════════════════════════════════

  /** resume/fresh 重调成功后的终局 summary（chapterId=ch_001 对齐 writeReadyProject fixture）。 */
  const SUMMARY_RETRY_OK: RunSnapshotSummary = {
    status: 'completed',
    routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
    reviewVerdict: 'pass',
    draftTitle: '第二章 B 城',
    draftWordCount: 2800,
    errors: [],
    chapter_accept: {
      chapterId: 'ch_001',
      candidate: { title: '第二章 B 城', content: '正文…', wordCount: 2800 },
      runId: 'run_mock_retry',
    },
  };

  it('CR-T1-056：busy summary（chain_run_active，他 session 持有）→ 早退提示 + 无 chapter_accept metadata + 零链事件', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'error',
      errors: ['chain_run_active|heldBy=another-leader-9'],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const chainEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY', tone: '紧张' } },
      { ...ctx, emitChainEvent: (e: { type: string; data: Record<string, unknown> }) => chainEvents.push(e) },
    );

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    // 早退：busy 机器可读前缀 + 人读文案（leader 下轮自察告知用户）。
    expect(result.output).toContain('chain_run_active|heldBy=another-leader-9');
    expect(result.output).toContain('该项目已有一条活动写章链');
    // 无链产物——不落 chapter_candidate field_patch、不发任何链哨兵（另一条活动链不受干扰）。
    expect(result.metadata?.type).toBeUndefined();
    expect(chainEvents).toHaveLength(0);
  });

  it('#105 R2.1①：自家租约 + brief 与快照一致（维持原案）→ resume 裸 continue 重调（不 clear 不 redo）', async () => {
    writeReadyProject();
    // 首调 busy（自家持有）→ 重调成功（SUMMARY_OK）。
    runChapterChain
      .mockResolvedValueOnce({
        status: 'error',
        errors: ['chain_run_active|heldBy=leader-session-1'],
      })
      .mockResolvedValue(SUMMARY_RETRY_OK);
    const getChainSnapshot = vi.fn().mockReturnValue({
      runId: 'run_paused',
      status: 'paused',
      currentNodeId: 'draft-writer-agent',
      projectPath,
      completedNodes: ['brief-compiler-node'],
      pendingNodes: [],
      // 与本次 params.chapterBrief 同内容（key 序故意不同——验 stableStringify 稳定比对）。
      // W2：draft 位停的活形态 = 出发核查挂起（suspended 在）——纯 stage 停已退役会被拦截门废弃。
      artifacts: {
        chapter_brief_input: { brief: { tone: '紧张', goal: 'REACH_B_CITY' }, episodeId: 'ep1' },
        research_brief: {
          briefHash: 'sha256:x',
          suspended: { kind: 'research_contradiction', rounds: 1, evidence: { contradictions: [], deviations: [] } },
        },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    const clearChainSnapshot = vi.fn();
    ctx.skillExecutor = {
      ...ctx.skillExecutor,
      runChapterChain,
      getChainSnapshot,
      clearChainSnapshot,
    } as typeof ctx.skillExecutor;
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const chainEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY', tone: '紧张' } },
      { ...ctx, emitChainEvent: (e: { type: string; data: Record<string, unknown> }) => chainEvents.push(e) },
    );

    // 重调发生：首调 busy + resume 重调 = 2 次。
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    // 第二次调用带 resume:{fromSnapshot:true} 裸 continue（不显式 redo——挂起 belt 自动转重查）。
    const [, , retryOptions] = runChapterChain.mock.calls[1];
    expect(retryOptions.resume).toEqual({ fromSnapshot: true });
    expect(retryOptions.redo).toBeUndefined();
    expect(retryOptions.requirement).toBe('ep1');
    // 维持原案不清快照（snapshot 是 resume 数据源）。
    expect(clearChainSnapshot).not.toHaveBeenCalled();
    expect(getChainSnapshot).toHaveBeenCalledWith('leader-session-1');
    // 重调成功 → 正常走完 tool（summary 透传 + chapter_accept metadata 照产）。
    expect(result.metadata?.type).toBe('field_patch');
    expect((result.metadata?.data as { chapterId: string }).chapterId).toBe('ch_001');
  });

  it('#105 R2.1②：自家租约 + brief 与快照有差异（改卡）→ clearChainSnapshot + fresh 重调（无 resume）', async () => {
    writeReadyProject();
    runChapterChain
      .mockResolvedValueOnce({
        status: 'error',
        errors: ['chain_run_active|heldBy=leader-session-1'],
      })
      .mockResolvedValue(SUMMARY_RETRY_OK);
    const getChainSnapshot = vi.fn().mockReturnValue({
      runId: 'run_paused',
      status: 'paused',
      currentNodeId: 'draft-writer-agent',
      projectPath,
      completedNodes: ['brief-compiler-node'],
      pendingNodes: [],
      // 旧 brief（goal 不同）→ 差异命中 fresh 车道。
      artifacts: {
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'OLD_GOAL_SUSPENDED' } },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    });
    const clearChainSnapshot = vi.fn().mockReturnValue(true);
    ctx.skillExecutor = {
      ...ctx.skillExecutor,
      runChapterChain,
      getChainSnapshot,
      clearChainSnapshot,
    } as typeof ctx.skillExecutor;
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY', tone: '紧张' } },
      ctx,
    );

    expect(runChapterChain).toHaveBeenCalledTimes(2);
    // 改卡车道：先弃快照（释放租约）再 fresh 重调（不带 resume）。
    expect(clearChainSnapshot).toHaveBeenCalledTimes(1);
    expect(clearChainSnapshot).toHaveBeenCalledWith('leader-session-1');
    const [, retryArtifacts, retryOptions] = runChapterChain.mock.calls[1];
    expect(retryOptions.resume).toBeUndefined();
    // fresh 重调用本次装配的 initialArtifacts（含新 brief——briefHash 变 → cardChanged → 全量重查）。
    expect(retryArtifacts['chapter_brief_input']).toEqual({
      episodeId: 'ep1',
      brief: { goal: 'REACH_B_CITY', tone: '紧张' },
    });
    expect(result.metadata?.type).toBe('field_patch');
  });

  it('#105 R2.1③：自家租约 + 拿不到快照（seam 缺方法/无快照）→ 保守走 resume（维持原案默认语义）', async () => {
    writeReadyProject();
    runChapterChain
      .mockResolvedValueOnce({
        status: 'error',
        errors: ['chain_run_active|heldBy=leader-session-1'],
      })
      .mockResolvedValue(SUMMARY_RETRY_OK);
    // 不给 getChainSnapshot/clearChainSnapshot（mock skillExecutor 缺 seam 方法）。
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY', tone: '紧张' } },
      ctx,
    );

    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const [, , retryOptions] = runChapterChain.mock.calls[1];
    // 拿不到快照 brief → 不判差异 → 保守 resume（不 clear——无从 clear）。
    expect(retryOptions.resume).toEqual({ fromSnapshot: true });
    expect(result.metadata?.type).toBe('field_patch');
  });
});
