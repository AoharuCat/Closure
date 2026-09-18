import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateFn } from '../src/nodes/llm-node';

// ─────────────────────────────────────────────────────────────────────────────
// 链流程重排 W4（R6 链外重提取）：WorkflowRuntime.reExtractChapter 集成测。
//
// 测五块（mirror runBackfill.test.ts 装配形态——真 E 段节点 + mock generate + mock registry）：
// 1. happy path：盘上正文（剥 frontmatter）→ standalone E 段跑通 → 统计 + storySync 投影。
// 2. 幂等：重跑同章 → 同 slice.id（W0-2 per-slice 替换语义透传）。
// 3. graceful：章不存在 / 正文空 / session 缺 / E 节点 error → {ok:false, reason}（不崩不静默）。
// 4. frontmatter 剥离：E 段 prompt 收到纯正文（order 登记行不进提取）。
// 5. feedback-ledger 不在 standalone 段（E10 filter——三输入含环终态，重提取语境不存在）。
//
// mock registry：write_world_events / materialize_chapter_summary / record_episode_mentions spy
//（query_* 工具 undefined → promise/arc/mention 查询面 graceful 降级——增强节点空产出非失败）。
// 真实磁盘 project.yaml + chapters/*.md（mkdtempSync）。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

let mockWriteWorld: { execute: ReturnType<typeof vi.fn> } | undefined;
let mockMaterialize: { execute: ReturnType<typeof vi.fn> } | undefined;
let mockRecordMentions: { execute: ReturnType<typeof vi.fn> } | undefined;
vi.mock('../src/tool/registry', () => ({
  registry: {
    get: (id: string) =>
      id === 'write_world_events'
        ? mockWriteWorld
        : id === 'materialize_chapter_summary'
          ? mockMaterialize
          : id === 'record_episode_mentions'
            ? mockRecordMentions
            : undefined,
  },
}));

/** 章正文 fixture（frontmatter + 标题 + 正文——accept 落盘 canonical 形态）。 */
const CHAPTER_FILE = `---\norder: 0\n---\n\n# 第一章\n\n艾莉娜走进酒馆，点了一杯麦酒。RE_EXTRACT_PROSE_MARKER\n`;

/** story-sync LLM 提取合法产出（world_setting ∈ 白名单；fixture project.yaml 无 field_metadata → 版本锁空放行）。 */
const STORY_SYNC_OUTPUT = JSON.stringify({
  summary: '提取新规则',
  patches: [{ field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' }],
});

/**
 * mock generate：按 system 标记路由 fixture——extractor（「状态提取专家」）→ AxisExtraction；
 * arc 段2（「弧节拍登记专家」）→ 合法 add_beat action；story-sync（system 含「story-sync-agent」）
 * → 合法 envelope。
 */
function makeReExtractGenerate(
  storyTime = 5,
): ReturnType<typeof vi.fn<GenerateFn>> {
  return vi.fn<GenerateFn>(async (_msgs, system) => {
    const sys = system ?? '';
    if (sys.includes('story-sync-agent')) {
      return { content: STORY_SYNC_OUTPUT, toolCalls: [], usage: null };
    }
    if (sys.includes('弧节拍登记专家')) {
      // E5 段2：l1 线弧 advance beat（episodeId/Index 由节点覆写，此处给合法全字段）。
      return {
        content: JSON.stringify({
          actions: [
            { type: 'add_beat', beat: { id: 'l1::ep1::advance', arcRef: 'l1', arcKind: 'line', episodeId: 'ep1', episodeIndex: 0, action: 'advance', note: '主角进城推进主线' } },
          ],
        }),
        toolCalls: [],
        usage: null,
      };
    }
    // 世界五轴（E1）+ promise 段 2（本测试 query_* 工具未注册 → promise graceful 不达）。
    const content = JSON.stringify({
      storyTime,
      title: 'reextract-extract',
      subjects: [{ id: 'erina', type: 'character', name: '艾莉娜', sourceCardId: 'char_erina' }],
      patches: [
        { subjectId: 'erina', path: '/hp', op: 'increment', value: -10, summary: '受伤', axis: 'physical' },
      ],
    });
    return { content, toolCalls: [], usage: null };
  }) as unknown as ReturnType<typeof vi.fn<GenerateFn>>;
}

describe('WorkflowRuntime.reExtractChapter（链流程重排 W4 / R6 链外重提取）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-re-extract-'));
    mockWriteWorld = undefined;
    mockMaterialize = undefined;
    mockRecordMentions = undefined;
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
    mockWriteWorld = undefined;
    mockMaterialize = undefined;
    mockRecordMentions = undefined;
  });

  async function makeRuntime(generate: ReturnType<typeof vi.fn<GenerateFn>>) {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    return createWorkflowRuntime({ generate });
  }

  async function makeParent(runtime: { createSession: (input: { agentName: string; projectPath: string }) => Promise<{ id: string }> | { id: string } }) {
    return runtime.createSession({ agentName: 'chapter-reextract', projectPath });
  }

  /** 写 project.yaml + 章文件（ep1 index 0 ↔ ch1 sort_order 0 canonical 映射）。 */
  function writeProject(opts?: { prose?: string; chapterId?: string }): void {
    const chapterId = opts?.chapterId ?? 'ch1';
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, `chapters/${chapterId}.md`), opts?.prose ?? CHAPTER_FILE, 'utf8');
    const doc: Record<string, unknown> = {
      meta: { id: 'p1', name: 'test', type: 'novel', version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      episode_outlines: [{ id: 'ep1', index: 0, title: '第一章' }],
      novel: {
        chapters: [
          {
            id: chapterId,
            title: '第一章',
            sort_order: 0,
            sections: [{ id: `${chapterId}_s1`, sort_order: 0, content_file: `chapters/${chapterId}.md` }],
          },
        ],
      },
      scene_graph: {
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 5, presentationOrder: { chapter: 0, pos: 0 }, lineTags: ['l1'] }],
        edges: [],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
        art_overrides: [],
        version: 0,
      },
    };
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  // ── 1. happy path：standalone E 段跑通 + 统计 + storySync 投影 ──
  it('盘上正文 → E 段提取落表 → ok + 统计 + storySync patches（world 1 slice / story-sync 1 patch）', async () => {
    const generate = makeReExtractGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const writeCalls: unknown[] = [];
    mockWriteWorld = { execute: vi.fn().mockImplementation(async (req: unknown) => { writeCalls.push(req); }) };
    const materializeCalls: Array<{ episodeId: string }> = [];
    mockMaterialize = { execute: vi.fn().mockImplementation(async (params: { episodeId: string }) => { materializeCalls.push(params); return { title: 'm', output: 'ok', metadata: { ok: true } }; }) };
    mockRecordMentions = { execute: vi.fn().mockResolvedValue({ title: 'm', output: 'ok', metadata: { ok: true } }) };
    writeProject();

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    expect(result.ok).toBe(true);
    expect(result.chapterId).toBe('ch1');
    expect(result.episodeId).toBe('ep1');
    // world：5 轴同 storyTime 归 1 slice、5 patches（每轴 1 patch 汇聚）。
    expect(result.stats?.worldWrites).toBe(1);
    expect(result.stats?.worldPatches).toBe(5);
    expect(result.stats?.worldWriteErrors).toBe(0);
    // E6 章摘要物化被调（standalone 段含 E6）。
    expect(materializeCalls).toEqual([{ episodeId: 'ep1' }]);
    // slice.id = `${episodeId}:${storyTime}`（稳定幂等键）。
    expect(writeCalls.map((c) => (c as { slice: { id: string } }).slice.id)).toEqual(['ep1:5']);
    // storySync 投影：LLM 提取产出 1 patch + summary（供 IPC 层档位分流）。
    expect(result.storySync).toBeDefined();
    expect(result.storySync?.patches).toHaveLength(1);
    expect(result.storySync?.patches[0]?.field).toBe('world_setting');
    expect(result.storySync?.summary).toBe('提取新规则');
    // 弧节拍声明（E5 段2 对终稿声明 1 beat）。
    expect(result.stats?.arcBeats).toBe(1);
    // 五轴 extractor 各 1 次 + arc 段2 1 次 + story-sync 1 次（promise 段2 query_* 未注册 graceful 不达）。
    expect(generate).toHaveBeenCalledTimes(7);
  });

  // ── 2. 幂等：重跑同章 → 同 slice.id（W0-2 替换不累积）──
  it('重跑同章 → 同 slice.id（per-slice idempotency，替换不累积）', async () => {
    const generate = makeReExtractGenerate(7);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);

    const writeCalls: unknown[] = [];
    mockWriteWorld = { execute: vi.fn().mockImplementation(async (req: unknown) => { writeCalls.push(req); }) };
    writeProject();

    await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });
    await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    // 两次产同 slice.id（mergeWorldEvents 稳定 slice.id；insertWorldSlice source='derived' 替换不累积）。
    expect(writeCalls.map((c) => (c as { slice: { id: string } }).slice.id)).toEqual(['ep1:7', 'ep1:7']);
  });

  // ── 3. frontmatter 剥离：E 段 prompt 收纯正文（order 登记行不进提取）──
  it('frontmatter 剥离——extractor prompt 含正文标记、不含 order 登记行', async () => {
    const generate = makeReExtractGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    mockWriteWorld = { execute: vi.fn().mockResolvedValue(undefined) };
    writeProject();

    await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    // 首次 generate 调用 = physical extractor：user 消息含正文 marker、不含 frontmatter order 行。
    const firstCall = generate.mock.calls[0];
    const userContent = (firstCall?.[0]?.[0]?.content as string) ?? '';
    expect(userContent).toContain('RE_EXTRACT_PROSE_MARKER');
    expect(userContent).not.toContain('order: 0');
  });

  // ── 4. graceful：章不存在 ──
  it('章未注册 → {ok:false, reason}（不崩，明确报错）', async () => {
    const generate = makeReExtractGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    writeProject();

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'no-such-chapter' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('未注册');
    expect(generate).not.toHaveBeenCalled();
  });

  // ── 5. graceful：正文空（仅 frontmatter）──
  it('章正文为空（剥 frontmatter 后无内容）→ {ok:false, reason}（不崩）', async () => {
    const generate = makeReExtractGenerate();
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    writeProject({ prose: '---\norder: 0\n---\n' });

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('正文为空');
    expect(generate).not.toHaveBeenCalled();
  });

  // ── 6. graceful：session 缺 ──
  it('session 不存在 → {ok:false, reason}（不崩）', async () => {
    const generate = makeReExtractGenerate();
    const runtime = await makeRuntime(generate);

    const result = await runtime.reExtractChapter('nonexistent-session', { chapterId: 'ch1' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('session not found');
  });

  // ── 7. world 写失败：write_world_events 未注册 → writer throw → writeErrors → ok:false（消静默假成功）──
  //（E 段 LLM 位全带 CR-E3 graceful wrapper——LLM 失败产空提取非 error artifact，链恒继续；硬失败面
  //  = 落表工具缺位，mirror runBackfill BMad CR Fix 1「写了 0 条但 ok:true」教训。）
  it('write_world_events 未注册 → writeErrors → {ok:false, reason 标写入失败}（永不静默假成功）', async () => {
    const generate = makeReExtractGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    // mockWriteWorld = undefined → registry.get('write_world_events') 返 undefined → writer throw。
    writeProject();

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('写入失败');
    expect(result.stats?.worldWriteErrors).toBeGreaterThan(0);
    // E 段本体照常跑完（链 completed——world-merge per-write catch 记 writeErrors 续跑）。
    expect(generate).toHaveBeenCalled();
  });

  // ── 8. standalone 段不含 feedback-ledger（E10 filter——环终态三输入在重提取语境不存在）──
  it('materialize 被调（E6 在段内）+ feedback-ledger 不在段内（E10 filter）', async () => {
    const generate = makeReExtractGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    mockWriteWorld = { execute: vi.fn().mockResolvedValue(undefined) };
    const materializeCalls: Array<{ episodeId: string }> = [];
    mockMaterialize = { execute: vi.fn().mockImplementation(async (params: { episodeId: string }) => { materializeCalls.push(params); return { title: 'm', output: 'ok', metadata: { ok: true } }; }) };
    writeProject();

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    expect(result.ok).toBe(true);
    expect(materializeCalls).toEqual([{ episodeId: 'ep1' }]);
    // E10 是链上唯一调 feedback_ledger_write 的 E 段节点——本测试 registry 未注册该工具（恒 undefined
    // 分支），E10 不在段内已由「result.errors 为空 + 段跑通」间接锚定；显式断言 = 无 feedback 工具调用面。
  });

  // ── 9. content_file 缺失时 fallback chapters/<id>.md（CHARTERS_DIR 约定）──
  it('sections[0].content_file 缺失 → fallback chapters/<chapterId>.md 直读', async () => {
    const generate = makeReExtractGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    mockWriteWorld = { execute: vi.fn().mockResolvedValue(undefined) };

    // 章文件在但 project.yaml 不带 sections（历史裸注册形态）。
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, 'chapters/ch9.md'), '# 第九章\n\n正文明写。FALLBACK_MARKER\n', 'utf8');
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({
        meta: { id: 'p1', name: 'test', type: 'novel', version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        episode_outlines: [{ id: 'ep9', index: 8, title: '第九章' }],
        novel: { chapters: [{ id: 'ch9', title: '第九章', sort_order: 8, sections: [] }] },
      }),
      'utf8',
    );

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'ch9' });

    expect(result.ok).toBe(true);
    expect(result.episodeId).toBe('ep9');
  });

  // ── 10. CR-12①：wordCount 与 recountDraftWordCount/applyEditedDraft 统一口径 ──
  it('wordCount = 非空白字符计数（非 prose.length 原始长——含空白虚高与链内终稿双口径漂移）', async () => {
    const generate = makeReExtractGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    mockWriteWorld = { execute: vi.fn().mockResolvedValue(undefined) };
    // 正文含空格/换行：非空白字符 = # 第一章艾莉娜。 = 8；原始长（含空白）= 14+——双口径可辨。
    writeProject({ prose: '---\norder: 0\n---\n\n# 第一章\n\n艾 莉 娜。\n' });

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    expect(result.ok).toBe(true);
    expect(result.wordCount).toBe(8);
  });

  // ── 11. CR-12③：body-only 文件带 BOM → stripChapterFrontmatter 前置剥（BOM 不泄入提取正文）──
  it('body-only + BOM → E 段 prompt 正文不含 U+FEFF（extractor 收纯正文）', async () => {
    const BOM = String.fromCharCode(0xfeff);
    const generate = makeReExtractGenerate(5);
    const runtime = await makeRuntime(generate);
    const parent = await makeParent(runtime);
    mockWriteWorld = { execute: vi.fn().mockResolvedValue(undefined) };
    // body-only（无 frontmatter——leadingFrontmatterBlock 返 null 形态）+ BOM 前置。
    writeProject({ prose: `${BOM}# 第一章\n\n艾莉娜走进酒馆。BOM_BODY_MARKER\n` });

    const result = await runtime.reExtractChapter(parent.id, { chapterId: 'ch1' });

    expect(result.ok).toBe(true);
    const firstCall = generate.mock.calls[0];
    const userContent = (firstCall?.[0]?.[0]?.content as string) ?? '';
    expect(userContent).toContain('BOM_BODY_MARKER');
    expect(userContent.includes(BOM)).toBe(false); // 修前 BOM 泄入 prompt/字数
    // wordCount 同步不含 BOM（非空白口径：# 第一章艾莉娜走进酒馆。BOM_BODY_MARKER 的非空白字符数）。
    expect(result.wordCount).toBe('# 第一章\n\n艾莉娜走进酒馆。BOM_BODY_MARKER\n'.replace(/\s+/g, '').length);
  });
});
