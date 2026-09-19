import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChapterStateSummary, ResolvedModel } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home（mirror chapterChunkIndexer.test.ts）。
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-chapter-summary-indexer');
const PROJECT_DIR = path.join(TEST_HOME, 'my-project');

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
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));
const { loadProject } = vi.hoisted(() => ({ loadProject: vi.fn() }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import {
  CHAPTER_SUMMARY_SOURCE_KIND,
  buildChapterSummaryBodyText,
  chapterSummaryEntryId,
  pruneOrphanChapterSummaryEntries,
  reindexChapterSummaryEntry,
} from '../main/db/chapterSummaryIndexer';
import { closeDb, getDb } from '../main/db/index';
import { ensureProject, getProject } from '../main/db/projectRepository';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import {
  insertWorldSlice,
  listChapterSummaries,
  resetWorldState,
  upsertChapterSummary,
} from '../main/db/worldStateRepository';
import { searchClosure } from '../main/db/closureRetrieval';

// better-sqlite3 ABI gate（mirror chapterChunkIndexer.test.ts）。Electron 真跑：
//   cd apps/desktop/client/shell && ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/chapterSummaryIndexer.test.ts
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
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

function stubModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'text-embedding-3-test',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:0',
    apiKey: 'stub',
    capability: 'embedding',
  };
}

function vec1024(slot = 0): number[] {
  const v = new Array(1024).fill(0);
  v[slot] = 1.0;
  return v;
}

/** canonical 链最小 doc：ep-1(index 0) ↔ ch_001。 */
const DOC = {
  episode_outlines: [{ id: 'ep-1', index: 0 }],
  novel: {
    chapters: [
      { id: 'ch_001', sort_order: 0, sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
    ],
  },
};

const SYNOPSIS = '雨夜来客抱着祖传铁盒进当铺。';

function mkSummary(episodeId: string, synopsis?: string): ChapterStateSummary {
  return {
    episodeId,
    episodeIndex: 0,
    storyTimeStart: 100,
    storyTimeEnd: 200,
    characterEndStates: [
      { subjectId: 'hero', name: '老周', type: 'character', state: { hp: 100 } },
      { subjectId: 'guest', type: 'character', state: {} },
    ],
    oracleDormant: [{ subjectId: 'oracle-x' }],
    relationshipChanges: [{ subjectId: 'hero', path: '/rel/guest', summary: '由疑生惧', storyTime: 150 }],
    foreshadowChanges: [
      { promiseId: 'pm-1', title: '玉珏之谜', stageChange: { from: 'unplanted', to: 'planted' }, beatKind: 'plant', sceneRef: 'sc-1' },
    ],
    newEntities: [{ subjectId: 'guest', type: 'character', name: '来客' }],
    openPromises: [{ promiseId: 'pm-1', title: '玉珏之谜', stage: 'planted' }],
    nextChapterPayoffs: [{ promiseId: 'pm-1', title: '玉珏之谜' }],
    truncated: false,
    ...(synopsis !== undefined ? { synopsis } : {}),
  } as ChapterStateSummary;
}

let PID: string | undefined;

function seedSummaryRow(synopsis?: string): void {
  upsertChapterSummary(PID!, {
    episodeId: 'ep-1',
    episodeIndex: 0,
    storyTimeEnd: 200,
    summary: mkSummary('ep-1', synopsis),
    tokenEstimate: 200,
    truncated: false,
    patchRowidHigh: 0,
  });
}

function summaryEntryRow() {
  return getDb()
    .prepare('SELECT * FROM closure_entry WHERE entry_id=?')
    .get(chapterSummaryEntryId(PID!, 'ep-1')) as
    | {
        entry_id: string;
        entry_type: string;
        source_kind: string;
        name: string;
        body_text: string;
        summary_text: string | null;
        content_hash: string | null;
        model: string | null;
        chapter_id: string | null;
      }
    | undefined;
}

function summaryVecRow() {
  const all = getDb()
    .prepare('SELECT vector_id, entry_id, vector_kind, status, visibility FROM entry_vec')
    .all() as Array<{
    vector_id: string;
    entry_id: string;
    vector_kind: string;
    status: string;
    visibility: string;
  }>;
  return all.find((r) => r.entry_id === chapterSummaryEntryId(PID!, 'ep-1'));
}

describe.skipIf(!sqliteUsable)('chapterSummaryIndexer（Story 8.3 S3）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    mkdirSync(PROJECT_DIR, { recursive: true });
    ensureProject({
      name: 'Test',
      type: 'novel',
      localFingerprint: path.resolve(PROJECT_DIR),
      path: path.resolve(PROJECT_DIR),
    });
    PID = getProject(path.resolve(PROJECT_DIR))!.projectId;
    getDb();
  });
  afterAll(clean);

  beforeEach(() => {
    vi.clearAllMocks();
    loadProject.mockReturnValue(DOC);
    getDb().prepare('DELETE FROM closure_chapter_summary WHERE project_id=?').run(PID);
    getDb()
      .prepare("DELETE FROM closure_entry WHERE project_id=? AND source_kind IN ('chapter','chapter_summary')")
      .run(PID);
    getDb().prepare('DELETE FROM closure_mention WHERE project_id=?').run(PID);
    if (isSqliteVecAvailable()) {
      const ids = getDb().prepare('SELECT vector_id FROM entry_vec').all() as Array<{
        vector_id: string;
      }>;
      const del = getDb().prepare('DELETE FROM entry_vec WHERE vector_id=?');
      for (const { vector_id } of ids) del.run(vector_id);
    }
    const chaptersDir = path.join(PROJECT_DIR, 'chapters');
    rmBestEffort(chaptersDir);
  });

  // ── buildChapterSummaryBodyText（纯函数）──

  it('buildChapterSummaryBodyText：synopsis 领衔 + 六字段名词拼料；dormant 不进；空字段跳过', () => {
    const body = buildChapterSummaryBodyText(mkSummary('ep-1', SYNOPSIS));
    const lines = body.split('\n');
    expect(lines[0]).toBe(SYNOPSIS); // 语义主体在前（embed/FTS 摘要行主匹配面）
    expect(body).toContain('出场角色：老周、guest'); // 终态名优先、缺 name 回退 subjectId
    expect(body).toContain('关系变化：hero：由疑生惧');
    expect(body).toContain('伏笔进展：玉珏之谜（unplanted→planted）');
    expect(body).toContain('新登场：来客（character）');
    expect(body).toContain('未决承诺：玉珏之谜');
    expect(body).toContain('下章回收：玉珏之谜');
    expect(body).not.toContain('oracle-x'); // dormant 否定性标记不进检索正文

    // 空摘要（全字段空 + 无 synopsis）→ 空串。
    const empty = buildChapterSummaryBodyText({
      episodeId: 'e',
      episodeIndex: 0,
      storyTimeStart: null,
      storyTimeEnd: null,
      characterEndStates: [],
      oracleDormant: [],
      relationshipChanges: [],
      foreshadowChanges: [],
      newEntities: [],
      openPromises: [],
      nextChapterPayoffs: [],
      truncated: false,
    });
    expect(empty).toBe('');
  });

  // ── reindexChapterSummaryEntry（db round-trip）──

  it('摘要行 → 检索行落链（entry_id/name/body 拼料 + 单 #body 向量 + 批量面单调用）', async () => {
    seedSummaryRow(SYNOPSIS);
    const calls: number[] = [];
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => {
        calls.push(texts.length);
        return texts.map(() => vec1024());
      },
    });
    expect(calls).toEqual([1]); // 摘要行单条 body（联动无章文件 → 无第二次调用）
    const row = summaryEntryRow()!;
    expect(row.entry_id).toBe(`${PID}:ep-1#summary`);
    expect(row.entry_type).toBe(CHAPTER_SUMMARY_SOURCE_KIND);
    expect(row.source_kind).toBe(CHAPTER_SUMMARY_SOURCE_KIND);
    expect(row.name).toBe('第1章摘要'); // episodeIndex 0 → 第1章
    expect(row.body_text).toContain(SYNOPSIS);
    expect(row.body_text).toContain('出场角色：老周、guest');
    expect(row.content_hash).toHaveLength(64);
    expect(row.chapter_id).toBeNull(); // 摘要行 episode 键控，非章 span 行
    expect(row.summary_text).toBe(SYNOPSIS);

    if (isSqliteVecAvailable()) {
      const vec = summaryVecRow()!;
      expect(vec.vector_id).toBe(`${chapterSummaryEntryId(PID!, 'ep-1')}#body`);
      expect(vec.vector_kind).toBe('body');
      expect(vec.status).toBe(''); // '' sentinel（closure_entry 侧 status NULL）
      expect(vec.visibility).toBe('known');
    }
  });

  it('幂等 hash skip：拼料未变重跑 → no-op（零 embed）', async () => {
    seedSummaryRow(SYNOPSIS);
    let calls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    expect(calls).toBe(1);
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    expect(calls).toBe(1); // 拼料未变 → skip（含联动 skip：无第二次 embedBatch）
  });

  // CR-T2-001（dogfood T2 patch 批，2026-08-25）：同维换模型时 entry_vec 不 DROP、hash
  // 不清——skip 谓词若只比 content_hash，摘要行永留旧模型（DISTINCT 永含旧模型 → degraded
  // 永真 → 启动 sweep 永不收敛，其余四源反复白重嵌）。
  it('CR-T2-001：同维换模型（拼料未变、hash 相等）→ 存量模型比对命中 → 重嵌到新模型', async () => {
    seedSummaryRow(SYNOPSIS);
    let currentModel: ResolvedModel = stubModel(); // 'text-embedding-3-test'
    let calls = 0;
    const deps = {
      resolveModel: () => currentModel,
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    expect(calls).toBe(1);
    expect(summaryEntryRow()!.model).toBe('text-embedding-3-test');

    // 同维换模型：hash 相等但存量 provenance ≠ resolved → 不 skip（prevailing 门同步让位
    // ——迁移语义下照拦只会落 pending 永不收敛）→ 重嵌 + provenance 翻新。
    currentModel = { ...stubModel(), modelId: 'qwen3-embedding-8b' };
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    expect(calls).toBe(2);
    const row = summaryEntryRow()!;
    expect(row.model).toBe('qwen3-embedding-8b');
    expect(row.content_hash).toHaveLength(64);

    // 新模型下模型一致 + hash 一致 → 纯 hash-skip 恢复（零 embed）。
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    expect(calls).toBe(2);
  });

  it('synopsis 变更 → 拼料变 → 重嵌（json_set 回填键序差异不触发虚假重嵌：语义哈希）', async () => {
    seedSummaryRow(SYNOPSIS);
    let calls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    // 模拟 mentionLedgerMaterialize 的 json_set 回填（synopsis 键追加到 JSON 尾部——键序与
    // assemble 全量重写不同）：值相同 → 拼料相同 → hash skip（raw 字符串哈希会虚假重嵌）。
    getDb()
      .prepare("UPDATE closure_chapter_summary SET summary = json_set(summary, '$.synopsis', ?) WHERE project_id=? AND episode_id=?")
      .run(SYNOPSIS, PID, 'ep-1');
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    expect(calls).toBe(1);
    // 换新梗概（真变更）→ 重嵌。
    seedSummaryRow('铁盒里是半枚玉珏。');
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', deps);
    expect(calls).toBe(2);
    expect(summaryEntryRow()!.body_text).toContain('半枚玉珏');
  });

  it('无摘要行 → orphan 清行', async () => {
    seedSummaryRow(SYNOPSIS);
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(summaryEntryRow()).toBeDefined();
    // 摘要行被级联失效删除 → 调用 → orphan 清检索行。
    getDb().prepare('DELETE FROM closure_chapter_summary WHERE project_id=? AND episode_id=?').run(PID, 'ep-1');
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1');
    expect(summaryEntryRow()).toBeUndefined();
    expect(summaryVecRow()).toBeUndefined();
  });

  it('pending_embed：无模型 → FTS-only（hash NULL）；模型恢复补嵌', async () => {
    seedSummaryRow(SYNOPSIS);
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', { resolveModel: () => null });
    const row = summaryEntryRow()!;
    expect(row.content_hash).toBeNull();
    expect(row.model).toBeNull();
    if (isSqliteVecAvailable()) expect(summaryVecRow()).toBeUndefined();
    // FTS 行在（触发器）。
    const ftsHit = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('祖传铁盒') as Array<{ entry_id: string }>;
    expect(ftsHit.map((h) => h.entry_id)).toContain(chapterSummaryEntryId(PID!, 'ep-1'));
    // 模型恢复 → 补嵌。
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(summaryEntryRow()!.content_hash).toHaveLength(64);
    if (isSqliteVecAvailable()) expect(summaryVecRow()).toBeDefined();
  });

  // ── synopsis 联动（design §3：摘要重索引后顺路触发该章 chunk 重索引）──

  it('synopsis 联动：有章文件 → chunk 行随摘要物化出现（prefix 带新梗概）', async () => {
    const chaptersDir = path.join(PROJECT_DIR, 'chapters');
    mkdirSync(chaptersDir, { recursive: true });
    writeFileSync(
      path.join(chaptersDir, 'ch_001.md'),
      '# 第一章\n\n雨夜，当铺木门被敲响。老周抬头，看见门缝里的水光与一个抱着铁盒的影子。\n\n她把盒子放上柜台，说死当，三个月。\n',
      'utf-8',
    );
    seedSummaryRow(SYNOPSIS);
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    const chunkRows = getDb()
      .prepare("SELECT entry_id, index_text FROM closure_entry WHERE project_id=? AND source_kind='chapter'")
      .all(PID) as Array<{ entry_id: string; index_text: string }>;
    expect(chunkRows.length).toBeGreaterThan(0);
    expect(chunkRows[0]!.entry_id).toBe(`${PID}:ch_001#c0`);
    expect(chunkRows[0]!.index_text).toContain(`[梗概：${SYNOPSIS}]`); // 联动 chunk 组料带梗概 prefix
  });

  it('联动映射失败（episode 无对应章）→ no-op 不抛', async () => {
    loadProject.mockReturnValue({
      episode_outlines: [{ id: 'ep-9', index: 0 }],
      novel: { chapters: [] },
    });
    seedSummaryRow(SYNOPSIS);
    await expect(
      reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
        resolveModel: () => null,
      }),
    ).resolves.toBeUndefined();
    expect(summaryEntryRow()).toBeDefined(); // 摘要行照常
  });

  // ── pruneOrphanChapterSummaryEntries ──

  it('orphan 清扫：无摘要行的检索行删、有摘要行的保留', () => {
    seedSummaryRow(SYNOPSIS);
    const insertEntry = getDb().prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility)
       VALUES (?,?,?,?,?,?,?)`,
    );
    insertEntry.run(`${PID}:ep-1#summary`, PID, 'chapter_summary', 'chapter_summary', '第1章摘要', '活的', 'known');
    // 无摘要行的 orphan（ep-gone 无 closure_chapter_summary 行）。
    insertEntry.run(`${PID}:ep-gone#summary`, PID, 'chapter_summary', 'chapter_summary', '孤儿摘要', '死的', 'known');

    const pruned = pruneOrphanChapterSummaryEntries(PID!);
    expect(pruned).toBe(1);
    const remain = getDb()
      .prepare("SELECT entry_id FROM closure_entry WHERE project_id=? AND source_kind='chapter_summary'")
      .all(PID) as Array<{ entry_id: string }>;
    expect(remain.map((r) => r.entry_id)).toEqual([`${PID}:ep-1#summary`]);
  });

  // ── CR 2026-08-20 修复批 ──

  it('B4E8：空摘要 body（六字段全空 + 无 synopsis）→ orphan 删行，不落空行不虚挂 pending', async () => {
    const db = getDb();
    // 全空六字段摘要（schema 可达形态：物化链正常恒产非空，空 = 数据面异常）。
    upsertChapterSummary(PID!, {
      episodeId: 'ep-1',
      episodeIndex: 0,
      storyTimeEnd: 200,
      summary: {
        episodeId: 'ep-1',
        episodeIndex: 0,
        storyTimeStart: null,
        storyTimeEnd: null,
        characterEndStates: [],
        oracleDormant: [],
        relationshipChanges: [],
        foreshadowChanges: [],
        newEntities: [],
        openPromises: [],
        nextChapterPayoffs: [],
        truncated: false,
      },
      tokenEstimate: 0,
      truncated: false,
      patchRowidHigh: 0,
    });

    // 预置一行旧检索行（前次非空摘要的遗留）→ 本次空 body 走 orphan 删除路径（删不落空）。
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, content_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(`${PID}:ep-1#summary`, PID, 'chapter_summary', 'chapter_summary', '第1章摘要', '旧梗概正文', 'known', 'stale-hash');

    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });

    expect(summaryEntryRow()).toBeUndefined(); // 行删除（非空行 churn）
    if (isSqliteVecAvailable()) expect(summaryVecRow()).toBeUndefined();
    // index-status pending 不虚挂：无 content_hash IS NULL 的 chapter_summary 行（无行即无 pending）。
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM closure_entry WHERE project_id=? AND source_kind='chapter_summary' AND content_hash IS NULL")
      .get(PID) as { n: number };
    expect(pending.n).toBe(0);
  });

  it('E4A7：insertWorldSlice 级联失效删 summary 行 → 检索行同步清（旧 synopsis 不再被 query_story 搜到）', async () => {
    seedSummaryRow(SYNOPSIS);
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(summaryEntryRow()).toBeDefined();
    // 基线：synopsis 词 FTS 命中（有模型也行，用 FTS-only 断言命中面）。
    const before = await searchClosure(PID!, '祖传铁盒', { k: 5 }, { resolveModel: () => null });
    expect(before.some((h) => h.entryId === chapterSummaryEntryId(PID!, 'ep-1'))).toBe(true);

    // 重写本章 slice（derived）→ 级联失效 tier-1（episode_index >= 0 全删）。
    insertWorldSlice(
      PID!,
      { id: 'ep-1:100', storyTime: 100, title: '重写', episodeId: 'ep-1' },
      [{ subjectId: 'hero', path: '/hp', op: 'replace', value: 90, axis: 'physical' }],
      [{ id: 'hero', type: 'character', name: '主角', firstSeenStoryTime: 100 }],
      'derived',
    );

    expect(listChapterSummaries(PID!, { episodeIds: ['ep-1'] })).toEqual([]); // summary 行已级联删
    expect(summaryEntryRow()).toBeUndefined(); // 🔑 检索行同步清（修复前跨会话存活）
    if (isSqliteVecAvailable()) expect(summaryVecRow()).toBeUndefined();
    const after = await searchClosure(PID!, '祖传铁盒', { k: 5 }, { resolveModel: () => null });
    expect(after.some((h) => h.entryId === chapterSummaryEntryId(PID!, 'ep-1'))).toBe(false);
  });

  it('E4A7：resetWorldState 清 summary → 检索行同点位级联清', async () => {
    seedSummaryRow(SYNOPSIS);
    await reindexChapterSummaryEntry(PID!, PROJECT_DIR, 'ep-1', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(summaryEntryRow()).toBeDefined();
    resetWorldState(PID!);
    expect(summaryEntryRow()).toBeUndefined();
    if (isSqliteVecAvailable()) expect(summaryVecRow()).toBeUndefined();
  });
});
