import path from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import { buildChunkIndexText, chunkChapter } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is never
// touched (mirror settingMdIndexer.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-chapter-chunk-indexer');
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
// loadProject mock（mirror mentionLedgerDegrade.test.ts）：episode↔chapter 映射的 canonical 单源
// 在合成 DOC 上锚定（免写盘整档 project.yaml）；映射失败路径经改 mock 返回值覆盖。
const { loadProject } = vi.hoisted(() => ({ loadProject: vi.fn() }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import {
  CHAPTER_SOURCE_KIND,
  chapterEntryId,
  reindexChapter,
  rebuildChapterChunks,
  truncateSynopsisForSummary,
} from '../main/db/chapterChunkIndexer';
import { chapterReadHandler } from '../main/ipc/toolHandlers/chapterHandlers';
import { searchClosure } from '../main/db/closureRetrieval';
import { EMBED_DIM } from '../main/db/closureIndexer';
import { closeDb, getDb } from '../main/db/index';
import { ensureProject, getProject } from '../main/db/projectRepository';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { upsertChapterSummary } from '../main/db/worldStateRepository';

// better-sqlite3 ABI gate（mirror settingMdIndexer.test.ts）：plain-Node vitest 下 skip。Electron
// 真跑：cd apps/desktop/client/shell && ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe
//   ./node_modules/vitest/vitest.mjs run test/chapterChunkIndexer.test.ts
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
  const v = new Array(EMBED_DIM).fill(0);
  v[slot] = 1.0;
  return v;
}

/** canonical 链最小 doc：ep-1(index 0) ↔ ch_001(sort_order 0, content_file chapters/ch_001.md)。 */
const DOC = {
  episode_outlines: [{ id: 'ep-1', index: 0 }, { id: 'ep-2', index: 1 }],
  novel: {
    chapters: [
      { id: 'ch_001', sort_order: 0, sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
      { id: 'ch_002', sort_order: 1, sections: [{ id: 's2', sort_order: 0, content_file: 'chapters/ch_002.md' }] },
    ],
  },
};

const SYNOPSIS = '雨夜来客抱着祖传铁盒进当铺，掌柜认出她看死人的眼神。';

// 合成章文（S2 集成样本形态：标题段 / 短段 / 对话段 / 转场标记 / >500 超长段〔句读递归〕/ 短尾段）。
const LONG_PARA =
  '老周打开铁盒的手停在半空。'.padEnd(24, '补') +
  '盒底躺着半枚玉珏。'.padEnd(60, '句。') +
  Array.from({ length: 14 }, (_, i) => `他想起${i}年前那个同样下雨的夜晚，同样的铁盒，同样的半个玉珏。`).join('');
const CHAPTER_TEXT = [
  '# 第一章 雨夜',
  '',
  '雨下了整夜，当铺的木门被敲响三下。',
  '',
  '「这么晚，谁还会来。」老周从柜台后抬起头，眯着眼看向门缝里渗进来的水光。他在这条街上当了三十年掌柜，听过各种敲门声，却没有听过这么急的。',
  '',
  '---',
  '',
  '来客是个年轻女人，浑身湿透，怀里抱着一只铁盒。她把铁盒放在柜台上，说里面是一件祖传的东西，当期三个月，死当。老周问她为什么不选活当，她没有回答，只是看着他，像是在看一个已经死去的名字。',
  '',
  LONG_PARA,
  '',
  '「盒底有字。」',
].join('\n');

/** 期望 chunk 单源：直接跑 S2 分块器（索引器必须与之一致）。 */
function expectedChunks(text: string) {
  return chunkChapter(text);
}

function writeChapter(chapterId: string, content: string): void {
  const dir = path.join(PROJECT_DIR, 'chapters');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${chapterId}.md`), content, 'utf-8');
}

function seedSummary(episodeId: string, synopsis: string): void {
  upsertChapterSummary(PID!, {
    episodeId,
    episodeIndex: 0,
    storyTimeEnd: 100,
    summary: {
      episodeId,
      episodeIndex: 0,
      storyTimeStart: 100,
      storyTimeEnd: 100,
      characterEndStates: [],
      oracleDormant: [],
      relationshipChanges: [],
      foreshadowChanges: [],
      newEntities: [],
      openPromises: [],
      nextChapterPayoffs: [],
      truncated: false,
      synopsis,
    },
    tokenEstimate: 100,
    truncated: false,
    patchRowidHigh: 0,
  });
}

function chapterRows(chapterId?: string) {
  const db = getDb();
  const sql = chapterId
    ? "SELECT * FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND chapter_id=? ORDER BY entry_id"
    : "SELECT * FROM closure_entry WHERE project_id=? AND source_kind='chapter' ORDER BY entry_id";
  return (chapterId ? db.prepare(sql).all(PID, chapterId) : db.prepare(sql).all(PID)) as Array<{
    entry_id: string;
    entry_type: string;
    source_kind: string;
    name: string;
    body_text: string;
    summary_text: string | null;
    content_hash: string | null;
    model: string | null;
    dim: number | null;
    chapter_id: string | null;
    chapter_index: number | null;
    char_start: number | null;
    char_end: number | null;
    para_start: number | null;
    para_end: number | null;
    index_text: string | null;
  }>;
}

function vecRows(entryPrefix: string) {
  // vec0 非 KNN 查询用全量 SELECT（测试库只含本项目行）+ JS 前缀过滤——LIKE 在 vec0 上未验证，
  // mirror closureSchema.test 的全量 SELECT 形态。
  const all = getDb()
    .prepare('SELECT vector_id, entry_id, vector_kind, status, visibility FROM entry_vec')
    .all() as Array<{
    vector_id: string;
    entry_id: string;
    vector_kind: string;
    status: string;
    visibility: string;
  }>;
  return all.filter((r) => r.entry_id.startsWith(entryPrefix));
}

/** 清 entry_vec（vec0 点删按 vector_id PK——canonical 支持面；测试库全量清）。 */
function clearVecRows(): void {
  if (!isSqliteVecAvailable()) return;
  const ids = getDb().prepare('SELECT vector_id FROM entry_vec').all() as Array<{
    vector_id: string;
  }>;
  const del = getDb().prepare('DELETE FROM entry_vec WHERE vector_id=?');
  for (const { vector_id } of ids) del.run(vector_id);
}

let PID: string | undefined;

// ── 纯函数（plain-Node 即跑，无 db）──

describe('truncateSynopsisForSummary（E7：160 边界不切 surrogate pair）', () => {
  it('undefined/空白 → null；≤160 原样；>160 截断加省略号', () => {
    expect(truncateSynopsisForSummary(undefined)).toBeNull();
    expect(truncateSynopsisForSummary('   ')).toBeNull();
    expect(truncateSynopsisForSummary('短梗概')).toBe('短梗概');
    expect(truncateSynopsisForSummary('A'.repeat(160))).toBe('A'.repeat(160));
    expect(truncateSynopsisForSummary('A'.repeat(161))).toBe(`${'A'.repeat(160)}…`);
  });

  it('160 位落高代理对首位 → 回退 159（不留孤立代理）', () => {
    // index 0-158 是 'A'（159 个），index 159 起是 😀（每对 2 code unit）——160 位恰是高代理。
    const synopsis = `${'A'.repeat(159)}${'😀'.repeat(8)}`;
    expect(synopsis.length).toBeGreaterThan(160);
    expect(truncateSynopsisForSummary(synopsis)).toBe(`${'A'.repeat(159)}…`);
    // BMP 边界（160 位是低代理的搭档场景不存在——高代理在前；正常 BMP 字照切 160）。
    expect(truncateSynopsisForSummary(`${'A'.repeat(159)}中`)).toBe(`${'A'.repeat(159)}中`);
  });
});

describe.skipIf(!sqliteUsable)('chapterChunkIndexer DB integration (Story 8.3 S3)', () => {
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
    // 清章源行（本 suite 独立 project id；FTS 行随触发器清）+ chapters/ 文件。
    getDb()
      .prepare("DELETE FROM closure_entry WHERE project_id=? AND source_kind='chapter'")
      .run(PID);
    getDb().prepare('DELETE FROM closure_chapter_summary WHERE project_id=?').run(PID);
    clearVecRows();
    const chaptersDir = path.join(PROJECT_DIR, 'chapters');
    rmBestEffort(chaptersDir);
  });

  it('reindexChapter：行/span/index_text/vec 全链 + 批量 embed 单调用（input=chunk 数）', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    seedSummary('ep-1', SYNOPSIS);
    const chunks = expectedChunks(CHAPTER_TEXT);
    expect(chunks.length).toBeGreaterThanOrEqual(4); // 标题段聚合 + 对话段 + 转场后段 + 超长段句读块 + 尾段

    const batchCalls: number[] = [];
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => {
        batchCalls.push(texts.length);
        return texts.map((_, i) => vec1024(i));
      },
    });
    expect(res.outcome).toBe('written');
    expect(res.chunkCount).toBe(chunks.length);
    // 🔑 批量 embed 单调用断言：一章一次调用、input 数 = chunk 数（design §2.3，非逐 chunk）。
    expect(batchCalls).toEqual([chunks.length]);

    const rows = chapterRows('ch_001');
    expect(rows).toHaveLength(chunks.length);
    for (const chunk of chunks) {
      const row = rows.find((r) => r.entry_id === chapterEntryId(PID!, 'ch_001', chunk.index))!;
      expect(row.entry_type).toBe('chapter');
      expect(row.source_kind).toBe(CHAPTER_SOURCE_KIND);
      // 章序名：ep-1 index 0 → 第1章；段号 1 起。
      expect(row.name).toBe(`第1章·段${chunk.index + 1}`);
      // body_text = 原文正文（呈现/返回消费原文，mirror「回答 LLM 看原文」）。
      expect(row.body_text).toBe(chunk.text);
      expect(row.char_start).toBe(chunk.charStart);
      expect(row.char_end).toBe(chunk.charEnd);
      expect(row.para_start).toBe(chunk.paraStart);
      expect(row.para_end).toBe(chunk.paraEnd);
      expect(row.chapter_id).toBe('ch_001');
      expect(row.chapter_index).toBe(0);
      // index_text = contextual prefix（梗概+正文）组料——embed/FTS 双臂看 context+chunk。
      expect(row.index_text).toBe(buildChunkIndexText(chunk.text, SYNOPSIS));
      expect(row.content_hash).toHaveLength(64);
      expect(row.model).toBe('text-embedding-3-test');
      expect(row.dim).toBe(EMBED_DIM);
      // 摘要层三级变焦：chunk 行 summary_text = synopsis 截断。
      expect(row.summary_text).toBe(SYNOPSIS);
    }

    if (isSqliteVecAvailable()) {
      const vecs = vecRows(`${PID}:ch_001`);
      expect(vecs).toHaveLength(chunks.length);
      for (const v of vecs) {
        expect(v.vector_id).toBe(v.entry_id); // chunk 向量 vector_id = entry_id（#c<n> 即 kind 标记）
        expect(v.vector_kind).toBe('chunk');
        expect(v.status).toBe(''); // vec0 TEXT 拒 NULL → '' sentinel（S1 探针）
        expect(v.visibility).toBe('known');
      }
    }

    // FTS：正文原句命中 + 梗概语义词经 prefix 命中正文段（contextual prefix 的 FTS 路径）。
    const bodyHit = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('三十年掌柜') as Array<{ entry_id: string }>;
    expect(bodyHit.map((h) => h.entry_id)).toContain(chapterEntryId(PID!, 'ch_001', 0));
    const prefixHit = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('祖传铁盒') as Array<{ entry_id: string }>;
    expect(prefixHit.length).toBeGreaterThanOrEqual(chunks.length); // 每章 chunk 组料都带梗概 prefix
  });

  it('幂等 hash skip：同内容 + 同 synopsis 重跑 → no-op（零 embed）', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    seedSummary('ep-1', SYNOPSIS);
    let calls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(calls).toBe(1);
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(res.outcome).toBe('hash-skip');
    expect(calls).toBe(1); // 零重嵌
  });

  it('synopsis 变更 → 重嵌（组料 hash 含 synopsis）：embed 恢复 + index_text 换 prefix', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    seedSummary('ep-1', SYNOPSIS);
    let calls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    // 梗概重写（物化 synopsis 变更——正文未动）。
    const newSynopsis = '铁盒里是半枚玉珏，牵出旧年悬案。';
    seedSummary('ep-1', newSynopsis);
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(res.outcome).toBe('written'); // 正文未变但组料变 → 重嵌（design 复审缺漏 #3）
    expect(calls).toBe(2);
    const first = chapterRows('ch_001')[0]!;
    expect(first.index_text).toBe(buildChunkIndexText(first.body_text, newSynopsis));
    expect(first.index_text).not.toContain(SYNOPSIS);
  });

  it('正文变更 → 重分块（chunk 数/span 随新文）', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    const newText = ['# 别章', '', '短段。', '', '另一段，也短。', '', '第三段，同样短。'].join('\n');
    writeChapter('ch_001', newText);
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    const expected = expectedChunks(newText);
    expect(res.outcome).toBe('written');
    expect(res.chunkCount).toBe(expected.length);
    const rows = chapterRows('ch_001');
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((r) => r.body_text)).toEqual(expected.map((c) => c.text));
  });

  it('章删除（文件不存在）→ outcome missing + 行清（entry + vec）', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(chapterRows('ch_001')).not.toHaveLength(0);
    rmSync(path.join(PROJECT_DIR, 'chapters', 'ch_001.md'));
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(res.outcome).toBe('missing');
    expect(chapterRows('ch_001')).toHaveLength(0);
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(0);
    }
  });

  it('rebuildChapterChunks：orphan 清理（db 有文件无的章）+ 未变章 hash skip 保留', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    let calls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(calls).toBe(1);
    // ghost 章：db 有行、盘上无文件（外部删除章遗留）。
    getDb()
      .prepare(
        `INSERT INTO closure_entry
           (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, chapter_id, chapter_index)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(`${PID}:ghost#c0`, PID, 'chapter', 'chapter', 'ghost·段1', '幽灵章正文', 'known', 'ghost', 7);

    const report = await rebuildChapterChunks(PID!, PROJECT_DIR, deps);
    expect(report.orphaned).toBe(1);
    expect(report.reindexed).toBe(0); // ch_001 hash skip（未重嵌）
    expect(calls).toBe(1);
    expect(chapterRows('ghost')).toHaveLength(0);
    expect(chapterRows('ch_001')).toHaveLength(expectedChunks(CHAPTER_TEXT).length);
  });

  it('pending_embed：无模型 → FTS-only（content_hash NULL）+ 模型恢复补嵌', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => null,
    });
    expect(res.outcome).toBe('written');
    const rows = chapterRows('ch_001');
    expect(rows).toHaveLength(expectedChunks(CHAPTER_TEXT).length);
    for (const row of rows) {
      expect(row.content_hash).toBeNull(); // pending_embed：向量未落不写 hash
      expect(row.model).toBeNull();
    }
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(0);
    }
    // FTS 仍可用（body 落 FTS——trigram 3+ 字查询）。
    const ftsHit = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('当期三个月') as Array<{ entry_id: string }>;
    expect(ftsHit.length).toBeGreaterThan(0);
    // 模型恢复（hash NULL ≠ 新 hash → 不 skip → 补嵌）。
    const res2 = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(res2.outcome).toBe('written');
    for (const row of chapterRows('ch_001')) {
      expect(row.content_hash).toHaveLength(64);
      expect(row.model).toBe('text-embedding-3-test');
    }
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(expectedChunks(CHAPTER_TEXT).length);
    }
  });

  it('空章（纯空白）→ outcome empty 清行（零 chunk 合法）', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(chapterRows('ch_001')).not.toHaveLength(0);
    writeChapter('ch_001', '\n\n  \n');
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(res.outcome).toBe('empty');
    expect(chapterRows('ch_001')).toHaveLength(0);
  });

  it('BOM + CRLF 归一：分块基准 = 归一后文本（span 与归一串一一对应）', async () => {
    const raw = `${String.fromCharCode(0xfeff)}# 第一章 CRLF\r\n\r\n第一段，带行尾归一。\r\n\r\n第二段，也带。\r\n`;
    writeChapter('ch_002', raw);
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_002', {
      resolveModel: () => null,
    });
    const normalized = raw.replace(String.fromCharCode(0xfeff), '').replace(/\r\n/g, '\n');
    const expected = expectedChunks(normalized);
    expect(res.chunkCount).toBe(expected.length);
    expect(chapterRows('ch_002').map((r) => r.body_text)).toEqual(expected.map((c) => c.text));
    // 归一后串是 body 的切片基准（span 语义锚定）。
    for (const row of chapterRows('ch_002')) {
      expect(normalized.slice(row.char_start!, row.char_end!)).toBe(row.body_text);
    }
  });

  it('episode 映射失败 graceful：loadProject null → name 回退 chapterId、prefix 退化零编造', async () => {
    loadProject.mockReturnValue(null);
    writeChapter('ch_001', '# 章\n\n一段正文，足以成块的内容长度需要超过五十个字符的长度要求，这里补足长度的填充文字继续补足。');
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    expect(res.outcome).toBe('written');
    const row = chapterRows('ch_001')[0]!;
    expect(row.name).toBe('ch_001·段1'); // 无章序 → chapterId 回退
    expect(row.chapter_index).toBeNull();
    expect(row.index_text).toBe(row.body_text); // 无 synopsis → prefix 退化（不含 [梗概：）
    expect(row.index_text).not.toContain('梗概');
    expect(row.summary_text).toBeNull();
  });

  it('prevailing-model mismatch → FTS-only（content_hash NULL 防混空间向量）', async () => {
    // 项目里已有他模型向量行（prevailing）。
    getDb()
      .prepare(
        `INSERT INTO closure_entry
           (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, model, dim)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(`${PID}:prevail`, PID, 'character', 'asset_card', '占位', '占位', 'known', 'other-model', EMBED_DIM);
    writeChapter('ch_001', '# 章\n\n一段正文，足以成块的内容长度需要超过五十个字符的长度要求，这里补足长度的填充文字继续补足。');
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(), // 与 prevailing 不同
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    const row = chapterRows('ch_001')[0]!;
    expect(row.content_hash).toBeNull();
    expect(row.model).toBeNull();
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(0);
    }
  });

  // ── Story 8.3 S4 检索臂端到端：索引器灌库 → searchClosure 查正文（chunk 命中携全字段）──
  it('端到端：reindexChapter 落的 chunk 行经 searchClosure 查回（vec 臂 vectorKind=chunk + span/chapterId 透传 + FTS 正文命中 + status 过滤排除）', async () => {
    // 清 prevailing-mismatch 测试遗留的他模型行（suite beforeEach 只清章源行——该行是本项目
    // prevailing model，会让本测试的 reindex 走 model-mismatch FTS-only 降级、向量不落）。
    getDb()
      .prepare('DELETE FROM closure_entry WHERE project_id=? AND entry_id=?')
      .run(PID, `${PID}:prevail`);
    writeChapter('ch_001', CHAPTER_TEXT);
    seedSummary('ep-1', SYNOPSIS);
    // 每块向量 = 独立 slot（chunk i → vec1024(i)）——查询 embed 到 slot 0 即定向命中 c0。
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map((_, i) => vec1024(i)),
    });
    const chunkCount = chapterRows('ch_001').length;
    expect(chunkCount).toBeGreaterThanOrEqual(4);

    // 1. vec 臂（'*' → vec-only）：query embed slot 0 → 命中 c0，全字段透传。
    const vecHit = await searchClosure(PID!, '*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(0),
    });
    const c0 = vecHit.find((h) => h.entryId === chapterEntryId(PID!, 'ch_001', 0));
    expect(c0).toBeDefined();
    expect(c0!.vectorKind).toBe('chunk');
    expect(c0!.sourceKind).toBe('chapter');
    expect(c0!.entryType).toBe('chapter');
    expect(c0!.chapterId).toBe('ch_001');
    expect(c0!.chapterIndex).toBe(0); // ep-1 index 0
    const dbRow = chapterRows('ch_001').find((r) => r.entry_id === c0!.entryId)!;
    expect(c0!.charStart).toBe(dbRow.char_start);
    expect(c0!.charEnd).toBe(dbRow.char_end);
    expect(c0!.paraStart).toBe(dbRow.para_start);
    expect(c0!.paraEnd).toBe(dbRow.para_end);
    // 同章多 chunk 各占席（per-chunk 独立——dedupe 双语义）：slot 1 定向命中 c1。
    const c1 = vecHit.find((h) => h.entryId === chapterEntryId(PID!, 'ch_001', 1));
    expect(c1).toBeDefined();
    expect(c1!.vectorKind).toBe('chunk');

    // 2. FTS 臂：正文原句命中（无模型 → FTS-only）。
    const ftsHit = await searchClosure(PID!, '当期三个月', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => vec1024(0),
    });
    expect(ftsHit.length).toBeGreaterThan(0);
    expect(ftsHit.every((h) => h.sourceKind === 'chapter')).toBe(true);
    expect(ftsHit[0].bodyText).not.toContain('梗概'); // 返回原文非组料

    // 3. status:'active' 不返正文段（chunk 行 closure status NULL / vec0 '' sentinel
    //    ——「查定稿卡」的过滤语义不含正文段落，S4 CR-005 对齐断言）。
    const activeOnly = await searchClosure(PID!, '*', { k: 10, status: 'active' }, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(0), // 与 c0 最近——过滤必须仍排除它
    });
    expect(activeOnly).toEqual([]);
  });

  // ── CR 2026-08-20 修复批 ──

  it('E5：entry 行已删但 vec 行残留（vec 扩展不可用窗口形态）→ reindex 前缀删自愈，不撞 PK', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    seedSummary('ep-1', SYNOPSIS);
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map((_, i) => vec1024(i)),
    });
    const chunkCount = chapterRows('ch_001').length;
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(chunkCount);
      // 模拟病理残留：entry 行被清而 vec 行存活（旧实现的清理门控扩展可用性 + 依赖
      // closure_entry 旧行查询的形态）——同 vector_id 重索引 INSERT 即 PK 冲突死循环。
      getDb()
        .prepare("DELETE FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND chapter_id=?")
        .run(PID, 'ch_001');
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(chunkCount); // 残留在

      const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
        resolveModel: () => stubModel(),
        embedBatch: async (_m, texts) => texts.map((_, i) => vec1024(i)),
      });
      expect(res.outcome).toBe('written'); // 不抛 PK 冲突
      expect(chapterRows('ch_001')).toHaveLength(chunkCount);
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(chunkCount); // 残留被前缀删清后重落
    }
  });

  it('E5 转义：chapterId 含 `_` 的前缀删不误伤 `chX…` 同形异章（LIKE ESCAPE）', async () => {
    // `ch_1` 的前缀模式若不转义 `_` 会匹配 `chX1` 的向量行（探针实证形态）。
    const mk = (chapterId: string) => reindexChapter(PID!, PROJECT_DIR, chapterId, {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    writeChapter('ch_1', '# 章\n\n' + '段落甲。'.repeat(20));
    writeChapter('chX1', '# 章\n\n' + '段落乙。'.repeat(20));
    await mk('ch_1');
    await mk('chX1');
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:ch_1`).length).toBeGreaterThan(0);
      expect(vecRows(`${PID}:chX1`).length).toBeGreaterThan(0);
      // 触发 ch_1 的重索引（重写文件 → 非 hash-skip → 事务内前缀删）。
      writeChapter('ch_1', '# 章\n\n' + '段落丙，改写。'.repeat(20));
      await mk('ch_1');
      expect(vecRows(`${PID}:ch_1`).length).toBeGreaterThan(0);
      expect(vecRows(`${PID}:chX1`).length).toBeGreaterThan(0); // 未被 `_` 通配误删
      expect(chapterRows('chX1').length).toBeGreaterThan(0);
    }
  });

  it('B3E3：episodeIndex（重排）变更 → hash 维度变化触发重嵌 + name/chapter_index 更新', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    seedSummary('ep-1', SYNOPSIS);
    let calls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(calls).toBe(1);
    expect(chapterRows('ch_001')[0]!.name).toBe('第1章·段1'); // index 0

    // 大纲重排（插章）：ch_001 前插入 ch_000 → ch_001 的 sort_order 0→1 → 归属 ep-2（index 1）。
    // synopsis 维度保持恒定（ep-2 预置同一梗概）——hash 变化唯一归因 chapterIndex 维度。
    seedSummary('ep-2', SYNOPSIS);
    loadProject.mockReturnValue({
      episode_outlines: DOC.episode_outlines,
      novel: {
        chapters: [
          { id: 'ch_000', sort_order: 0, sections: [{ id: 's0', sort_order: 0, content_file: 'chapters/ch_000.md' }] },
          { id: 'ch_001', sort_order: 1, sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
        ],
      },
    });
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(res.outcome).toBe('written'); // 章序维度入 hash → 不再 stale
    expect(calls).toBe(2); // 重嵌
    const row = chapterRows('ch_001')[0]!;
    expect(row.name).toBe('第2章·段1'); // 归属 ep-2（index 1）→ 第2章
    expect(row.chapter_index).toBe(1);
  });

  it('E1：entry_vec 旧结构 DROP 迁移清 content_hash → reindexChapter 补回向量（drop 后重索引能恢复）', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    seedSummary('ep-1', SYNOPSIS);
    let calls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        calls++;
        return texts.map(() => vec1024());
      },
    };
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(calls).toBe(1);
    for (const row of chapterRows('ch_001')) expect(row.content_hash).toHaveLength(64);

    // 模拟 pre-8.3 旧结构（无 status/visibility metadata 列）→ 重启走 initSchema 迁移。
    const db = getDb();
    db.exec('DROP TABLE entry_vec');
    db.exec(`CREATE VIRTUAL TABLE entry_vec USING vec0(
      vector_id TEXT PRIMARY KEY,
      project_id TEXT partition key,
      entry_id TEXT,
      entry_type TEXT,
      source_kind TEXT,
      vector_kind TEXT,
      embedding float[1024] distance_metric=cosine
    )`);
    closeDb();
    resetSqliteVecState();
    getDb(); // 重启：initSchema 检测旧结构 → DROP + reCREATE + content_hash 清 NULL（E1）

    // 迁移点清 hash：model 行全部 pending_embed 语义（修复前 = hash-skip 永久阻断重嵌）。
    for (const row of chapterRows('ch_001')) expect(row.content_hash).toBeNull();
    if (isSqliteVecAvailable()) {
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM entry_vec').get()).toMatchObject({ n: 0 });
    }

    // 重索引（无 force）→ NULL !== hash → 重嵌补回。
    const res = await reindexChapter(PID!, PROJECT_DIR, 'ch_001', deps);
    expect(res.outcome).toBe('written');
    expect(calls).toBe(2);
    for (const row of chapterRows('ch_001')) {
      expect(row.content_hash).toHaveLength(64);
      expect(row.model).toBe('text-embedding-3-test');
    }
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:ch_001`)).toHaveLength(chapterRows('ch_001').length);
    }
  });

  it('E6：chapter_read 走同款归一（BOM strip + CRLF→LF）——输出与 chunk charSpan 基准同一字符串', async () => {
    const raw = `${String.fromCharCode(0xfeff)}# 第一章 CRLF\r\n\r\n第一段，带行尾归一，补足长度到五十个字符以上的填充内容继续补足。\r\n\r\n第二段，也带，同样补足到足够的长度要求不再额外补充。\r\n`;
    writeChapter('ch_003', raw);
    await reindexChapter(PID!, PROJECT_DIR, 'ch_003', { resolveModel: () => null });

    const res = await chapterReadHandler(
      { params: { chapterId: 'ch_003' }, projectDir: PROJECT_DIR, sessionId: 's', abort: new AbortController().signal },
    );
    expect(res.title).toBe('chapter: ch_003');
    // 归一：无 BOM、LF 行尾（裸 readFileSync 会原样带回两者 → span 与 LLM 看到的文本错位）。
    expect(res.output.startsWith('# 第一章 CRLF\n')).toBe(true);
    expect(res.output).not.toContain('\r');
    expect(String.fromCharCode(0xfeff)).not.toBe(res.output[0]);

    // span 锚定对齐：chapter_read 输出的 [char_start, char_end) 切片 == chunk body 原文。
    for (const row of chapterRows('ch_003')) {
      expect(res.output.slice(row.char_start!, row.char_end!)).toBe(row.body_text);
    }
  });

  it('B7：章源 hit 的 NULL 章序字段键不出现（二态全兑现：有值键在 / 无值键不在）', async () => {
    loadProject.mockReturnValue(null); // 映射失败 → chapter_index NULL
    writeChapter('ch_001', '# 章\n\n一段正文，足以成块的内容长度需要超过五十个字符的长度要求，这里补足长度的填充文字继续补足。');
    await reindexChapter(PID!, PROJECT_DIR, 'ch_001', {
      resolveModel: () => stubModel(),
      embedBatch: async (_m, texts) => texts.map(() => vec1024()),
    });
    const hits = await searchClosure(PID!, '足以成块', { k: 5 }, {
      resolveModel: () => null, // FTS-only
    });
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h) => h.sourceKind === 'chapter')!;
    expect(hit.chapterId).toBe('ch_001');
    expect('chapterIndex' in hit).toBe(false); // NULL → 键不出现（B7：非 undefined 键）
    expect(Object.keys(hit)).not.toContain('chapterIndex');
    expect(hit.charStart).toBeGreaterThanOrEqual(0); // 有值字段照常
    expect('charStart' in hit).toBe(true);
  });

  it('B1：并发 rebuild 经 in-flight 链串行收敛（chained 派生 promise 无 unhandled rejection）', async () => {
    writeChapter('ch_001', CHAPTER_TEXT);
    const deps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => texts.map(() => vec1024()),
    };
    // 双并发 rebuild：第二个链到第一个之后（settle 后重扫）；两者都 resolve、清理后第三次照常。
    const [r1, r2] = await Promise.all([
      rebuildChapterChunks(PID!, PROJECT_DIR, deps),
      rebuildChapterChunks(PID!, PROJECT_DIR, deps),
    ]);
    expect(r1.orphaned).toBe(0);
    expect(r2.orphaned).toBe(0);
    const r3 = await rebuildChapterChunks(PID!, PROJECT_DIR, deps);
    expect(r3.orphaned).toBe(0); // in-flight 清理生效（第三次非 chained 残留路径）
  });
});
