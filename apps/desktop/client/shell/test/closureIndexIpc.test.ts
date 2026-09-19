import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-closure-index-ipc');

const {
  handle,
  reindexAll,
  reindexAssetCards,
  reindexAllSettingMd,
  rebuildChapterChunks,
  reindexChapterSummaryEntry,
  listChapterSummaries,
  getProjectById,
  resolveEmbeddingModel,
  isEmbeddingSweepInflight,
  warn,
  info,
} = vi.hoisted(() => ({
  handle: vi.fn(),
  reindexAll: vi.fn(),
  reindexAssetCards: vi.fn(),
  reindexAllSettingMd: vi.fn(),
  rebuildChapterChunks: vi.fn(),
  reindexChapterSummaryEntry: vi.fn(),
  listChapterSummaries: vi.fn(),
  getProjectById: vi.fn(),
  // dogfood #39 (T2 C2): the index-status handler now resolves the configured
  // embedding model (degraded 判定的配置面输入)。Mocked so the DB-counting suite
  // is deterministic regardless of the dev machine's real ~/.orison/model config.
  resolveEmbeddingModel: vi.fn(),
  // CR-T2-005: 手动重建与在途扫互斥（闸查询面）。
  isEmbeddingSweepInflight: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

// CR-T2-004：status handler 的 sqlite-vec 可用性短路需要可控注入（真模块状态由
// loadSqliteVec 副作用维护，测试无法直接翻转）。partial mock：默认透传真实现，测试可
// 经 vecOverride 强制 true/false（loadSqliteVec/resetSqliteVecState 保真——db/index 的
// initSchema 还依赖它们管理真状态）。
const { vecOverride } = vi.hoisted(() => ({ vecOverride: { value: null as boolean | null } }));
vi.mock('../main/db/sqliteVecLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/db/sqliteVecLoader')>();
  return {
    ...actual,
    isSqliteVecAvailable: () =>
      vecOverride.value !== null ? vecOverride.value : actual.isSqliteVecAvailable(),
  };
});
vi.mock('../main/db/embeddingSweepGate', () => ({ isEmbeddingSweepInflight }));

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
  ipcMain: { handle },
}));

// Mock the indexers so rebuild-story-index never does network embeds / db
// reads; expose the real source-kind literals so the handler imports the same
// values. Story 8.3 E1: rebuild surface now also covers chapters —
// rebuildChapterChunks (chunk rows) + per-episode reindexChapterSummaryEntry
// (chapter_summary rows) + its listChapterSummaries feeder are mocked too.
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/assetCardsIndexer', () => ({
  reindexAssetCards,
  ASSET_CARD_SOURCE_KIND: 'setting_card',
}));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd, SETTING_MD_SOURCE_KIND: 'setting_md' }));
vi.mock('../main/db/chapterChunkIndexer', () => ({
  rebuildChapterChunks,
  CHAPTER_SOURCE_KIND: 'chapter',
}));
vi.mock('../main/db/chapterSummaryIndexer', () => ({
  reindexChapterSummaryEntry,
  CHAPTER_SUMMARY_SOURCE_KIND: 'chapter_summary',
}));
vi.mock('../main/db/worldStateRepository', () => ({ listChapterSummaries }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({ resolveEmbeddingModel }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import { registerClosureIndexIpc } from '../main/ipc/closureIndexIpc';
import { closeDb, getDb } from '../main/db';

let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  closeDb();
  rmBestEffort(TEST_HOME);
}

// The rebuild handler mocks every db dependency (projectRepository + both
// indexers), so its wiring tests run in plain node without the sqlite-vec ABI.
describe('closure:rebuild-story-index handler (模式 A error mapping)', () => {
  beforeEach(() => {
    handle.mockReset();
    reindexAll.mockReset();
    reindexAssetCards.mockReset();
    reindexAllSettingMd.mockReset();
    rebuildChapterChunks.mockReset();
    reindexChapterSummaryEntry.mockReset();
    listChapterSummaries.mockReset();
    getProjectById.mockReset();
    resolveEmbeddingModel.mockReset();
    isEmbeddingSweepInflight.mockReset();
    isEmbeddingSweepInflight.mockReturnValue(false);
    warn.mockReset();
    info.mockReset();
  });

  function rebuildHandler() {
    registerClosureIndexIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:rebuild-story-index');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: { projectId: string }) => Promise<unknown>;
  }

  it('returns no-project-path when the project is not registered', async () => {
    getProjectById.mockReturnValue(undefined);
    const h = rebuildHandler();
    const result = await h({}, { projectId: '00001' });
    expect(result).toEqual({ ok: false, error: 'no-project-path' });
    expect(reindexAll).not.toHaveBeenCalled();
  });

  it('maps a missing embedding model to no-embedding-model', async () => {
    getProjectById.mockReturnValue({ projectId: '00001', path: '/proj' });
    reindexAll.mockRejectedValue(new Error('reindexAll: no embedding model configured - cannot rebuild'));
    const h = rebuildHandler();
    const result = await h({}, { projectId: '00001' });
    expect(result).toEqual({ ok: false, error: 'no-embedding-model' });
  });

  it('sums project_assets + asset_cards + setting_md + chapters on success + force-reindexes cards', async () => {
    getProjectById.mockReturnValue({ projectId: '00001', path: '/proj' });
    reindexAll.mockResolvedValue({ reindexed: 3, dimChanged: true, newDim: 1024 });
    reindexAssetCards.mockResolvedValue({ reindexed: 5, orphaned: 1 });
    reindexAllSettingMd.mockResolvedValue({ reindexed: 2, orphaned: 0 });
    // Story 8.3 E1：章源恢复面——chunk 全量重建（force）+ 逐 live summary episode 重索引。
    rebuildChapterChunks.mockResolvedValue({ reindexed: 4, orphaned: 0 });
    listChapterSummaries.mockReturnValue([{ episodeId: 'ep-1' }, { episodeId: 'ep-2' }]);
    reindexChapterSummaryEntry.mockResolvedValue(undefined);
    const h = rebuildHandler();
    const result = (await h({}, { projectId: '00001' })) as {
      ok: boolean; reindexed: number; dimChanged: boolean; newDim: number | null;
    };
    expect(result.ok).toBe(true);
    expect(result.reindexed).toBe(16); // 3 project_assets + 5 asset_cards + 2 setting_md + 4 chunks + 2 summaries
    expect(result.dimChanged).toBe(true);
    expect(result.newDim).toBe(1024);
    expect(reindexAll).toHaveBeenCalledWith('00001');
    expect(reindexAssetCards).toHaveBeenCalledWith('/proj', { force: true });
    expect(reindexAllSettingMd).toHaveBeenCalledWith('/proj', { force: true });
    expect(rebuildChapterChunks).toHaveBeenCalledWith('00001', '/proj', { force: true });
    expect(reindexChapterSummaryEntry).toHaveBeenCalledTimes(2);
    expect(reindexChapterSummaryEntry).toHaveBeenCalledWith('00001', '/proj', 'ep-1');
  });

  it('chapter_summary per-episode 失败只 warn 继续（单章失败不中断整批）', async () => {
    getProjectById.mockReturnValue({ projectId: '00001', path: '/proj' });
    reindexAll.mockResolvedValue({ reindexed: 1, dimChanged: false, newDim: 1024 });
    reindexAssetCards.mockResolvedValue({ reindexed: 0, orphaned: 0 });
    reindexAllSettingMd.mockResolvedValue({ reindexed: 0, orphaned: 0 });
    rebuildChapterChunks.mockResolvedValue({ reindexed: 0, orphaned: 0 });
    listChapterSummaries.mockReturnValue([{ episodeId: 'ep-1' }, { episodeId: 'ep-2' }]);
    reindexChapterSummaryEntry
      .mockRejectedValueOnce(new Error('ep1 boom'))
      .mockResolvedValueOnce(undefined);
    const h = rebuildHandler();
    const result = (await h({}, { projectId: '00001' })) as { ok: boolean; reindexed: number };
    expect(result.ok).toBe(true);
    expect(result.reindexed).toBe(2); // 1 project_assets + 1 summary（ep-1 失败不计）
    expect(reindexChapterSummaryEntry).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it('maps any other throw to operation-failed', async () => {
    getProjectById.mockReturnValue({ projectId: '00001', path: '/proj' });
    reindexAll.mockRejectedValue(new Error('embedding probe failed'));
    const h = rebuildHandler();
    const result = await h({}, { projectId: '00001' });
    expect(result).toEqual({ ok: false, error: 'operation-failed' });
  });

  // CR-T2-005：启动/换模型迁移扫在途时，手动重建拒绝（并发重嵌竞争 entry_vec DROP/重建）。
  it('CR-T2-005: sweep 在途 → sweep-in-progress 拒绝（不碰任何 reindexer）', async () => {
    isEmbeddingSweepInflight.mockReturnValue(true);
    getProjectById.mockReturnValue({ projectId: '00001', path: '/proj' });
    const h = rebuildHandler();
    const result = await h({}, { projectId: '00001' });
    expect(result).toEqual({ ok: false, error: 'sweep-in-progress' });
    expect(reindexAll).not.toHaveBeenCalled();
    expect(reindexAssetCards).not.toHaveBeenCalled();
  });
});

// The index-status handler reads closure_entry / closure_craft_entry directly,
// so its count-split coverage needs the real derived-index schema — gated on the
// sqlite ABI like the other closure DB-integration suites (closureCraftIndexer).
describe.skipIf(!sqliteUsable)('closure:index-status DB counting', () => {
  beforeEach(() => {
    clean();
    handle.mockReset();
    warn.mockReset();
    info.mockReset();
    // dogfood #39 (T2 C2): default unconfigured → degraded 恒 false（预期 FTS-only），
    // 判定测试逐个显式配置。
    resolveEmbeddingModel.mockReset();
    resolveEmbeddingModel.mockReturnValue(null);
    // CR-T2-004：degraded 判定测试默认按「向量臂可用」跑，但 schema 创建须见**真**状态——
    // 顺序：null（透真）→ getDb() → true（handler 调用时可测）。强制 true 在 vec 二进制
    // 缺失的机器上会让 initSchema 去建 vec0 虚表而炸 schema。
    vecOverride.value = null;
    // Force schema creation on this test's TEST_HOME.
    getDb();
    vecOverride.value = true;
    isEmbeddingSweepInflight.mockReset();
    isEmbeddingSweepInflight.mockReturnValue(false);
  });

  afterEach(() => {
    vecOverride.value = null;
    clean();
  });

  function statusHandler() {
    registerClosureIndexIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:index-status');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: { projectId?: string }) => Promise<unknown>;
  }

  function insertEntry(row: Record<string, unknown>) {
    getDb()
      .prepare(
        `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text, content_hash, model)
         VALUES (@entry_id, @project_id, @entry_type, @source_kind, @name, @body_text, @content_hash, @model)`,
      )
      .run(row);
  }

  function insertCraft(row: Record<string, unknown>) {
    getDb()
      .prepare(
        `INSERT INTO closure_craft_entry (craft_id, craft_type, name, body_text, content_hash, model)
         VALUES (@craft_id, @craft_type, @name, @body_text, @content_hash, @model)`,
      )
      .run(row);
  }

  it('returns zero story counts + null projectId when no project open', async () => {
    const h = statusHandler();
    const status = (await h({}, {})) as {
      craft: { count: number };
      story: {
        projectId: null;
        projectAssets: number;
        assetCards: number;
        settingMd: number;
        chapterChunks: number;
        chapterSummaries: number;
      };
    };
    expect(status.story.projectId).toBeNull();
    expect(status.story.projectAssets).toBe(0);
    expect(status.story.assetCards).toBe(0);
    expect(status.story.settingMd).toBe(0);
    expect(status.story.chapterChunks).toBe(0);
    expect(status.story.chapterSummaries).toBe(0);
    expect(status.craft.count).toBe(0);
  });

  it('splits project_assets vs asset_cards vs setting_md counts + pending + model (no cross-project leak)', async () => {
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: 'h', model: 'embed-m',
    });
    insertEntry({
      entry_id: 'a2', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A2', body_text: 'b', content_hash: null, model: null,
    });
    insertEntry({
      entry_id: 'c1', project_id: '00001', entry_type: 'location',
      source_kind: 'setting_card', name: 'C1', body_text: 'b', content_hash: 'h', model: 'embed-m',
    });
    insertEntry({
      entry_id: 'c2', project_id: '00001', entry_type: 'location',
      source_kind: 'setting_card', name: 'C2', body_text: 'b', content_hash: null, model: null,
    });
    // Story 2.3: setting_md rows (long-form prose, namespaced entry_id `${projectId}:${id}`).
    insertEntry({
      entry_id: '00001:magic-system', project_id: '00001', entry_type: 'magic_system',
      source_kind: 'setting_md', name: 'Magic System', body_text: 'b', content_hash: 'h', model: 'embed-m',
    });
    insertEntry({
      entry_id: '00001:faction-a', project_id: '00001', entry_type: 'faction',
      source_kind: 'setting_md', name: 'Faction A', body_text: 'b', content_hash: null, model: null,
    });
    // Story 8.3: chapter chunk rows (one per chunk) + chapter_summary rows (one per chapter).
    for (let i = 0; i < 3; i += 1) {
      insertEntry({
        entry_id: `00001:ch_001#c${i}`, project_id: '00001', entry_type: 'chapter',
        source_kind: 'chapter', name: `第1章·段${i + 1}`, body_text: 'b', content_hash: 'h', model: 'embed-m',
      });
    }
    insertEntry({
      entry_id: '00001:ch_001#summary', project_id: '00001', entry_type: 'chapter_summary',
      source_kind: 'chapter_summary', name: '第1章摘要', body_text: 'b', content_hash: null, model: null,
    });
    // A different project's row must NOT leak into this project's counts.
    insertEntry({
      entry_id: 'x1', project_id: '99999', entry_type: 'character',
      source_kind: 'asset_card', name: 'X', body_text: 'b', content_hash: 'h', model: 'embed-m',
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      story: {
        projectAssets: number;
        assetCards: number;
        settingMd: number;
        chapterChunks: number;
        chapterSummaries: number;
        pending: number;
        model: string | null;
      };
    };

    expect(status.story.projectAssets).toBe(2);
    expect(status.story.assetCards).toBe(2);
    expect(status.story.settingMd).toBe(2);
    expect(status.story.chapterChunks).toBe(3);
    expect(status.story.chapterSummaries).toBe(1);
    // 1 pending asset_card + 1 pending setting_card + 1 pending setting_md
    // + 0 pending chapter + 1 pending chapter_summary = 4 story-level pending.
    expect(status.story.pending).toBe(4);
    expect(status.story.model).toBe('embed-m');
  });

  it('reports craft counts + pending + model', async () => {
    insertCraft({
      craft_id: 'k1', craft_type: 'shuangdian', name: 'K1', body_text: 'b',
      content_hash: 'h', model: 'craft-m',
    });
    insertCraft({
      craft_id: 'k2', craft_type: 'shuangdian', name: 'K2', body_text: 'b',
      content_hash: null, model: null,
    });

    const h = statusHandler();
    const status = (await h({}, {})) as {
      craft: { count: number; pending: number; model: string | null };
    };
    expect(status.craft.count).toBe(2);
    expect(status.craft.pending).toBe(1);
    expect(status.craft.model).toBe('craft-m');
  });

  // ── dogfood #39（T2 C2）：degraded 判定（isVectorArmDegraded，与启动 reconcile 同源）──

  it('配置了模型 + pending 积压 → story.degraded（配置面透出，craft 无行不降级）', async () => {
    resolveEmbeddingModel.mockReturnValue({ modelId: 'embed-m' });
    // #39 实录形态：重建失败后行被改写为 pending（hash NULL、provenance NULL）。
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: null, model: null,
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      embeddingConfiguredModelId: string | null;
      craft: { degraded: boolean };
      story: { degraded: boolean };
    };
    expect(status.embeddingConfiguredModelId).toBe('embed-m');
    expect(status.story.degraded).toBe(true);
    expect(status.craft.degraded).toBe(false);
  });

  it('存量模型与配置不符（零 pending）→ degraded（几何空间失效）', async () => {
    resolveEmbeddingModel.mockReturnValue({ modelId: 'embed-new' });
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: 'h', model: 'embed-old',
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as { story: { degraded: boolean } };
    expect(status.story.degraded).toBe(true);
  });

  it('未配置模型 → pending 也不算 degraded（FTS-only 预期态）+ configuredModelId null', async () => {
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: null, model: null,
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      embeddingConfiguredModelId: string | null;
      story: { degraded: boolean };
    };
    expect(status.embeddingConfiguredModelId).toBeNull();
    expect(status.story.degraded).toBe(false);
  });

  it('混合存量（部分已迁新模型、部分仍旧模型）→ degraded（DISTINCT 全量比对，非 LIMIT 1 首个）', async () => {
    resolveEmbeddingModel.mockReturnValue({ modelId: 'embed-new' });
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: 'h', model: 'embed-new',
    });
    insertEntry({
      entry_id: 'a2', project_id: '00001', entry_type: 'character',
      source_kind: 'setting_card', name: 'A2', body_text: 'b', content_hash: 'h', model: 'embed-old',
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      story: { degraded: boolean; model: string | null };
    };
    // story.model 的回退链只显首个（embed-new），但 degraded 看 DISTINCT 全量——混合态不漏。
    expect(status.story.model).toBe('embed-new');
    expect(status.story.degraded).toBe(true);
  });

  it('craft 侧存量模型不符 → craft.degraded（独立于 story scope）', async () => {
    resolveEmbeddingModel.mockReturnValue({ modelId: 'embed-new' });
    insertCraft({
      craft_id: 'k1', craft_type: 'shuangdian', name: 'K1', body_text: 'b',
      content_hash: 'h', model: 'embed-old',
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      craft: { degraded: boolean };
      story: { degraded: boolean };
    };
    expect(status.craft.degraded).toBe(true);
    expect(status.story.degraded).toBe(false);
  });

  // ── CR-T2-004/006/014（dogfood T2 patch 批，2026-08-25）──

  it('CR-T2-004: sqlite-vec 不可用 + 配置模型 + pending → degraded 恒 false（结构性无向量臂，重建不可治，不挂永久横幅）', async () => {
    vecOverride.value = false;
    resolveEmbeddingModel.mockReturnValue({ modelId: 'embed-m' });
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: null, model: null,
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      craft: { degraded: boolean };
      story: { degraded: boolean };
    };
    expect(status.story.degraded).toBe(false);
    expect(status.craft.degraded).toBe(false);
  });

  it('CR-T2-004: resolveEmbeddingModel 抛错（fs 异常）→ status 不 reject（NEVER-throws），按未配置上报', async () => {
    resolveEmbeddingModel.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: null, model: null,
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      embeddingConfiguredModelId: string | null;
      story: { degraded: boolean };
    };
    expect(status.embeddingConfiguredModelId).toBeNull();
    expect(status.story.degraded).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('CR-T2-006/014: storedModels 随状态面透出（DISTINCT 全量）+ sweepInflight 字段', async () => {
    resolveEmbeddingModel.mockReturnValue({ modelId: 'embed-new' });
    isEmbeddingSweepInflight.mockReturnValue(true);
    insertEntry({
      entry_id: 'a1', project_id: '00001', entry_type: 'character',
      source_kind: 'asset_card', name: 'A1', body_text: 'b', content_hash: 'h', model: 'embed-new',
    });
    insertEntry({
      entry_id: 'a2', project_id: '00001', entry_type: 'character',
      source_kind: 'setting_card', name: 'A2', body_text: 'b', content_hash: 'h', model: 'embed-old',
    });

    const h = statusHandler();
    const status = (await h({}, { projectId: '00001' })) as {
      sweepInflight: boolean;
      craft: { storedModels?: string[] };
      story: { storedModels?: string[] };
    };
    expect([...(status.story.storedModels ?? [])].sort()).toEqual(['embed-new', 'embed-old']);
    expect(Array.isArray(status.craft.storedModels)).toBe(true);
    // CR-T2-014：扫在途并入状态面（UI 并进「重建中」防横幅闪）。
    expect(status.sweepInflight).toBe(true);
  });
});
