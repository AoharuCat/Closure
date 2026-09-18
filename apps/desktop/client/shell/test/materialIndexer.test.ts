/**
 * Story 10.1 Wave C：materialIndexer（closure_material 登记 + 双车道 chunk 索引）测试。
 *
 *   - registerMaterial 全链（项目车道）：登记行全字段 / closure_entry 取值表钉死〔F-15〕/
 *     chunk_spans 回填与登记更新同事务〔F-02〕/ FTS / 实体目录排除。
 *   - 幂等：hash-skip（未变零重嵌）/ **只改 marker 标题重索引**〔F-14〕/ provenance
 *     COALESCE（F-05 用户后补字段防清）。
 *   - F-09：零章挂起材料 = 全文单伪章照索引（章界与检索解耦），status 保留 low-confidence。
 *   - pending_embed 降级 + 模型恢复补嵌；orphan 清扫（删原件 → 登记行 + 双车道 chunk 行全清）。
 *   - F-01 反向：craft orphan 清扫收窄——material_chunk 行存活，ghost craft_md 行照删。
 *   - 全局车道 INSERT 钉死（closure_craft_entry / craft_vec / craft FTS）+ backfill
 *     mtime 快路幂等（第二遍零解析）+ kind 无策略诚实跳过（D6 seam）。
 *   - BMad CR 2026-09-02 组 2：CR-006 删光标记回自动分章 / CR-007 无模型 backfill 零重写 /
 *     CR-008 project 枚举无 projectId throw / CR-014 symlink 收录 / CR-018 per-item 容错 /
 *     CR-019 空 path 项目守卫 / CR-030 failed 落库+退避+reingest 转正 / CR-033 摘要投影。
 *   - E10.2a Wave 3：FAILED_FORMAT_BY_EXT 字幕三扩展映射（durable 失败行 format + medium=
 *     'video'〔CR-17〕）+ 旧行 provenance_json 无 description 键回读容忍（schema
 *     default(null) 兜底）+ AC2 字幕降级拼合 chunk/FTS db 真跑（CR-18——拒收来自真
 *     parseSubtitle 非 deps.parse stub，CR-21）。
 *
 * 全部 fixtures 自制样文（AC11 版权红线）。REAL parseDocumentToMarkdown（txt 直读零依赖）；
 * embed 经 DI stub 零网络。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import { materialSchema } from '@orison/shared-contracts';

const TEST_HOME = path.join(process.cwd(), 'test-tmp-material-indexer');
const PROJECT_DIR = path.join(TEST_HOME, 'my-project');

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
  ipcMain: { handle: () => undefined },
}));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

import {
  MATERIAL_CHUNK_SOURCE_KIND,
  MATERIAL_EMBED_BATCH_SIZE,
  MATERIAL_SOURCE_KIND,
  decodeMaterialChunkCraftId,
  getMaterialRow,
  listMaterialRows,
  listMaterialRowsForLane,
  listMaterialSummaries,
  lookupMaterialChunkSpans,
  materialChapterRef,
  materialChunkCraftId,
  materialEntryId,
  reindexMaterial,
  registerMaterial,
  relInMaterialsOfSourcePath,
  backfillGlobalMaterials,
  backfillProjectMaterials,
  deleteMaterialRows,
  upsertMaterialRow,
} from '../main/db/materialIndexer';
import { scanAndReindexCraftKb } from '../main/db/closureCraftIndexer';
import { listCatalogEntries } from '../main/db/catalogRepository';
import { EMBED_DIM } from '../main/db/closureIndexer';
import { closeDb, getDb } from '../main/db/index';
import { ensureProject, getProject } from '../main/db/projectRepository';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import {
  __clearMaterialLLMCoreForTest,
  MATERIAL_ALLOWED_EXTENSIONS,
  materialIdFor,
  stripChapterMarkerLines,
} from '../main/ipc/toolHandlers/materialIngest';
import { parseDocumentToMarkdown } from '../main/ipc/toolHandlers/parseDocumentHandlers';
import type { Material } from '@orison/shared-contracts';
import { buildEpubFixture } from './fixtures/documentFixtures';
import { rmBestEffort } from './rmBestEffort';

// better-sqlite3 ABI gate（mirror chapterChunkIndexer.test.ts）：plain-Node vitest 下 skip。
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

/** 4 章等长样文（章标 + 双段正文——正则 high 置信形态；mirror materialIngest.test）。 */
function chapteredNovel(chapters = 4, bodyLen = 120): string {
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return Array.from({ length: chapters }, (_, i) => {
    const heading = `第${numerals[i]}章 风起之${i}`;
    const body = `${'墨'.repeat(bodyLen)}。\n\n${'雨'.repeat(bodyLen)}。`;
    return `${heading}\n\n${body}`;
  }).join('\n\n');
}

/** ≥2 万字无章标样文（低置信 → LLM 兜底；无内核 → 挂起零章形态，F-09）。 */
function lowConfidenceLongText(blockCount = 86, bodyLen = 240): string {
  return Array.from({ length: blockCount }, (_, i) => `小节之${i}\n\n${'砚'.repeat(bodyLen)}。`).join('\n\n');
}

function writeProjectSource(rel: string, content: string): void {
  const full = path.join(PROJECT_DIR, 'materials', rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

/** 全局车道根 = ~/.orison/materials（design §4.4——craft-kb 同级；app.getPath mock → TEST_HOME/.orison/materials）。 */
const GLOBAL_MATERIALS = path.join(TEST_HOME, '.orison', 'materials');

function writeGlobalSource(rel: string, content: string): void {
  const full = path.join(GLOBAL_MATERIALS, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

function embedCountingDeps() {
  const calls: number[] = [];
  const deps = {
    resolveModel: () => stubModel(),
    embedBatch: async (_m: ResolvedModel, texts: string[]) => {
      calls.push(texts.length);
      return texts.map((_, i) => vec1024(i));
    },
  };
  return { deps, calls };
}

function materialRowsRaw(materialId: string) {
  return getDb()
    .prepare("SELECT * FROM closure_entry WHERE source_kind='material' AND chapter_id LIKE ? ESCAPE '\\'")
    .all(`${materialId}.ch%`) as Array<Record<string, unknown>>;
}

function craftRowsRaw(materialId: string) {
  return getDb()
    .prepare("SELECT * FROM closure_craft_entry WHERE source_kind='material_chunk' AND craft_id LIKE ? ESCAPE '\\'")
    .all(`mat:${materialId}.ch%`) as Array<Record<string, unknown>>;
}

function vecRows(entryPrefix: string) {
  const all = getDb()
    .prepare('SELECT vector_id, entry_id, vector_kind, status, visibility FROM entry_vec')
    .all() as Array<{ vector_id: string; entry_id: string; vector_kind: string; status: string; visibility: string }>;
  return all.filter((r) => r.entry_id.startsWith(entryPrefix));
}

function craftVecRows(craftIdPrefix: string) {
  const all = getDb()
    .prepare('SELECT vector_id, craft_id, vector_kind FROM closure_craft_vec')
    .all() as Array<{ vector_id: string; craft_id: string; vector_kind: string }>;
  return all.filter((r) => r.craft_id.startsWith(craftIdPrefix));
}

/** 读派生 .md 测试基面（BOM strip + CRLF→LF——mirror materialIndexer readDerivedText 读取侧归一）。 */
function readDerivedForTest(abs: string): string {
  const raw = readFileSync(abs, 'utf-8');
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return stripped.replace(/\r\n?/g, '\n');
}

/** 手工构造合法 Material（no-strategy 等用例直接 upsert 登记）。 */
interface MakeMaterialInput {
  materialId: string;
  scope?: 'project' | 'global';
  projectId?: string | null;
  kind?: string;
  name?: string;
  /** provenance.sourcePath 简写。 */
  sourcePath?: string;
  charCount?: number;
  chapterDetection?: Material['quality']['chapterDetection'];
  status?: Material['status'];
}

function makeMaterial(over: MakeMaterialInput): Material {
  return materialSchema.parse({
    materialId: over.materialId,
    scope: over.scope ?? 'global',
    projectId: over.projectId ?? null,
    kind: over.kind ?? 'prose',
    name: over.name ?? '手工材料',
    format: 'txt',
    provenance: {
      medium: 'other',
      tier: 'unspecified',
      sourcePath: over.sourcePath ?? 'manual.txt',
      via: 'direct-read',
      extractor: 'builtin-text',
      ingestedAt: new Date().toISOString(),
      author: null,
      lang: null,
      originDate: null,
    },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: over.charCount ?? 10,
      chapterDetection: over.chapterDetection ?? { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters: [],
    chunkSpans: [],
    contentHash: `sha256:${'a'.repeat(64)}`,
    status: over.status ?? 'ready',
  });
}

let PID: string | undefined;

// ── 纯函数面（plain-Node 即跑，无 db）──

describe('id/路径 helpers（纯函数）', () => {
  const mat = makeMaterial({
    materialId: materialIdFor('project', 'materials/novel.txt'),
    scope: 'project',
    projectId: '00042',
    sourcePath: 'materials/novel.txt',
  });

  it('relInMaterialsOfSourcePath：project 剥 materials/ 前缀；global 恒等；非法 null', () => {
    expect(relInMaterialsOfSourcePath(mat)).toBe('novel.txt');
    const g = makeMaterial({
      materialId: materialIdFor('global', 'notes.txt'),
      scope: 'global',
      sourcePath: 'notes.txt',
    });
    expect(relInMaterialsOfSourcePath(g)).toBe('notes.txt');
    const bad = makeMaterial({
      materialId: materialIdFor('project', 'materials/evil.txt'),
      scope: 'project',
      sourcePath: 'evil.txt', // project 车道无 materials/ 前缀 → 不可解析
    });
    expect(relInMaterialsOfSourcePath(bad)).toBeNull();
  });

  it('双车道 id 取值表（F-15）：chapter_ref / entry_id / craft_id 格式', () => {
    const id = 'mat-0123456789ab';
    expect(materialChapterRef(id, 3)).toBe('mat-0123456789ab.ch3');
    expect(materialEntryId('00042', id, 3, 2)).toBe('00042:mat-0123456789ab.ch3#c2');
    expect(materialChunkCraftId(id, 3, 2)).toBe('mat:mat-0123456789ab.ch3#c2');
    expect(MATERIAL_SOURCE_KIND).toBe('material');
    expect(MATERIAL_CHUNK_SOURCE_KIND).toBe('material_chunk');
    expect(MATERIAL_EMBED_BATCH_SIZE).toBe(32);
  });

  it('decodeMaterialChunkCraftId：materialChunkCraftId 的逆（F-02 解码侧）；非材料行/坏形态 → null', () => {
    const id = 'mat-0123456789ab';
    expect(decodeMaterialChunkCraftId(materialChunkCraftId(id, 3, 2))).toEqual({
      materialId: id,
      chapterIndex: 3,
      chunkIndex: 2,
    });
    expect(decodeMaterialChunkCraftId('shuangdian-catalog')).toBeNull(); // 非 mat: 前缀
    expect(decodeMaterialChunkCraftId('mat:mat-0123456789ab.chX#c1')).toBeNull(); // 非数字章号
    expect(decodeMaterialChunkCraftId('mat:not-a-material.ch0#c0')).toBeNull(); // materialId 形态坏
  });
});

describe.skipIf(!sqliteUsable)('materialIndexer DB integration (Story 10.1 Wave C)', () => {
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
    __clearMaterialLLMCoreForTest();
    getDb().exec('DELETE FROM closure_material');
    getDb().exec("DELETE FROM closure_entry WHERE source_kind='material'");
    getDb().exec("DELETE FROM closure_craft_entry WHERE source_kind='material_chunk'");
    rmSync(path.join(PROJECT_DIR, 'materials'), { recursive: true, force: true });
    rmSync(GLOBAL_MATERIALS, { recursive: true, force: true });
    // 清孤儿 vec 行（vec0 点删按 PK——canonical 支持面；测试库全量清，mirror
    // chapterChunkIndexer.test clearVecRows 形态）。
    if (isSqliteVecAvailable()) {
      for (const t of ['entry_vec', 'closure_craft_vec']) {
        const ids = getDb().prepare(`SELECT vector_id AS id FROM ${t}`).all() as Array<{ id: string }>;
        const del = getDb().prepare(`DELETE FROM ${t} WHERE vector_id=?`);
        for (const { id } of ids) del.run(id);
      }
    }
    getDb().exec("DELETE FROM closure_craft_entry WHERE source_kind != 'material_chunk'");
    getDb().exec(`DELETE FROM closure_entry WHERE project_id='${PID ?? ''}' AND source_kind != 'material'`);
  });

  it('registerMaterial 项目车道全链：登记行全字段 + closure_entry 取值表钉死 + chunk_spans 同事务回填', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps, calls } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    expect(res.outcome).toBe('registered');
    const materialId = res.materialId!;
    expect(materialId).toBe(materialIdFor('project', 'materials/novel.txt'));

    // 登记行全字段（materialSchema round-trip + 关键值）。
    const row = getMaterialRow(materialId)!;
    expect(row).not.toBeNull();
    expect(row.scope).toBe('project');
    expect(row.projectId).toBe(PID);
    expect(row.kind).toBe('prose');
    expect(row.name).toBe('novel');
    expect(row.format).toBe('txt');
    expect(row.status).toBe('ready');
    expect(row.chapters).toHaveLength(4);
    expect(row.chapters.every((c) => c.method === 'regex' && c.confidence === 'high')).toBe(true);
    expect(row.provenance.sourcePath).toBe('materials/novel.txt');
    expect(row.provenance.via).toBe('direct-read');

    // 派生 .md 已落盘（markers 存在）。
    const derivedAbs = path.join(PROJECT_DIR, 'materials', '.derived', 'novel.md');
    expect(existsSync(derivedAbs)).toBe(true);

    // 项目车道 closure_entry 取值表〔F-15〕。
    const rows = materialRowsRaw(materialId);
    expect(rows.length).toBeGreaterThanOrEqual(4); // ≥4 章，每章 ≥1 chunk
    const derived = readFileSync(derivedAbs, 'utf-8');
    for (const r of rows) {
      expect(r.entry_type).toBe('material');
      expect(r.source_kind).toBe('material');
      expect(r.visibility).toBe('known');
      expect(r.status).toBeNull(); // 材料无卡状态
      expect(r.summary_text).toBeNull(); // 无简述层
      expect(r.model).toBe('text-embedding-3-test');
      expect(r.dim).toBe(EMBED_DIM);
      expect(r.content_hash).toHaveLength(64);
      // 章源七列：chapter_id/chapter_index/char/para + index_text（无梗概退化 = 正文）。
      expect(String(r.chapter_id)).toMatch(new RegExp(`^${materialId}\\.ch\\d+$`));
      expect(typeof r.chapter_index).toBe('number');
      expect(r.index_text).toBe(r.body_text);
      // 🔑 全局 span 锚定：派生文本切片 == body（char 基面 = 派生 .md）。
      expect(derived.slice(r.char_start as number, r.char_end as number)).toBe(r.body_text);
    }
    const firstChapterRows = rows.filter((r) => r.chapter_index === 0);
    expect(firstChapterRows[0]!.name).toBe('novel·第 1 章');
    expect(firstChapterRows[0]!.entry_id).toBe(materialEntryId(PID!, materialId, 0, 0));

    // 批量 embed 单调用断言（整材料一次，非逐 chunk）。
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(rows.length);

    // vec 行：vector_id = entry_id / vector_kind='chunk' / status '' sentinel / visibility known。
    if (isSqliteVecAvailable()) {
      const vecs = vecRows(`${PID}:${materialId}`);
      expect(vecs).toHaveLength(rows.length);
      for (const v of vecs) {
        expect(v.vector_id).toBe(v.entry_id);
        expect(v.vector_kind).toBe('chunk');
        expect(v.status).toBe('');
        expect(v.visibility).toBe('known');
      }
    }

    // 🔑 F-02：chunk_spans 回填与登记同事务——span 与 chunk 行逐条对齐（chapterIndex/chunkNo）。
    expect(row.chunkSpans).toHaveLength(rows.length);
    const sortedRows = [...rows].sort((a, b) => String(a.entry_id).localeCompare(String(b.entry_id)));
    row.chunkSpans.forEach((span, i) => {
      const r = sortedRows[i]!;
      expect(span.charStart).toBe(r.char_start);
      expect(span.charEnd).toBe(r.char_end);
      expect(span.paraStart).toBe(r.para_start);
      expect(span.paraEnd).toBe(r.para_end);
    });

    // FTS：正文命中（trigram）。
    const ftsHit = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('墨墨墨') as Array<{ entry_id: string }>;
    expect(ftsHit.map((h) => h.entry_id)).toContain(materialEntryId(PID!, materialId, 0, 0));

    // 实体目录排除（catalogRepository 'material' 加值）：材料 chunk 行不进目录。
    const catalog = listCatalogEntries(PID!, { offset: 0, limit: 50 });
    expect(catalog.total).toBe(0); // 本项目只有材料行
    expect(catalog.rows).toHaveLength(0);
  });

  it('幂等 hash-skip：未变原件重登记 → outcome reused + 零重嵌', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps, calls } = embedCountingDeps();
    await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    expect(calls).toHaveLength(1);
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    expect(res.outcome).toBe('reused');
    expect(calls).toHaveLength(1); // hash-skip 吸收
  });

  it('F-14：只改派生 .md 章标记标题 → 重索引（重嵌 + name/chapters 刷新）', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps, calls } = embedCountingDeps();
    const first = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    const materialId = first.materialId!;
    expect(calls).toHaveLength(1);

    // 校对：只改首章 marker 标题（正文不动）。
    const derivedAbs = path.join(PROJECT_DIR, 'materials', '.derived', 'novel.md');
    const { readFileSync, writeFileSync: wf } = await import('node:fs');
    const derived = readFileSync(derivedAbs, 'utf-8');
    const edited = derived.replace(/title="[^"]*"/, 'title="人工改名之章"');
    expect(edited).not.toBe(derived);
    wf(derivedAbs, edited, 'utf-8');

    const res = await reindexMaterial(materialId, deps);
    expect(res.outcome).toBe('written'); // 章标题集入 hash → 不 skip
    expect(calls).toHaveLength(2); // 重嵌
    const row = getMaterialRow(materialId)!;
    expect(row.chapters[0]!.title).toBe('人工改名之章'); // chapters_json 刷新（AC4）
    const rows = materialRowsRaw(materialId).filter((r) => r.chapter_index === 0);
    expect(rows[0]!.name).toBe('novel·第 1 章'); // name = 材料名+章标真值短标签（C5——章号从章标行解析非序号算术）；标题在 chapters_json
  });

  it('CR-001 生产装配：派生正文被人工编辑 + 原件未变 → 重摄取不覆写（getRegisteredContentHash 闭包激活）', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps } = embedCountingDeps();
    const first = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    const materialId = first.materialId!;
    expect(first.outcome).toBe('registered');

    // 用户经派生 .md 编辑**正文**（非标记）：append 一段人工文字。
    const derivedAbs = path.join(PROJECT_DIR, 'materials', '.derived', 'novel.md');
    const { readFileSync, writeFileSync: wf } = await import('node:fs');
    const derived = readFileSync(derivedAbs, 'utf-8');
    const edited = `${derived}\n\n这是用户在派生稿里手写的批注段，重摄取不得覆写。\n`;
    wf(derivedAbs, edited, 'utf-8');

    // 原件未动、登记 content hash 与本次解析一致 → 生产闭包（runRegisterMaterial 装配
    // getRegisteredContentHash）判定差异全部来自派生人工编辑 → 跳过覆写。
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    expect(res.outcome).toBe('registered'); // reingest-skipped-manual 映射 registered（人工内容落库）
    expect(res.materialId).toBe(materialId);
    const after = readFileSync(derivedAbs, 'utf-8');
    expect(after).toBe(edited); // 🔑 派生逐字保留（未被自动重分覆写）
    const row = getMaterialRow(materialId)!;
    expect(row.quality.parseNotes.some((n) => n.includes('人工编辑'))).toBe(true); // 诚实 note
  });

  it('C2 防清 belt：markers=0 重摄取（CR-001 生产装配）→ 0 章中间行不存在 + 相 B autoResplit 收敛真实值', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps } = embedCountingDeps();
    const first = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    const materialId = first.materialId!;
    expect(getMaterialRow(materialId)!.chapters).toHaveLength(4);

    // R10 剥离形态：标记全失 + 一处人工正文改动（内容变更 → CR-001；markers=0 → 标记重建零章）。
    const derivedAbs = path.join(PROJECT_DIR, 'materials', '.derived', 'novel.md');
    const stripped = `${stripChapterMarkerLines(readFileSync(derivedAbs, 'utf-8'))}\n\n人工补记：伏笔在第三章回收。`;
    writeFileSync(derivedAbs, stripped, 'utf-8');

    // 拦截相 B embed 窗口观察中间行态（最终 UPDATE 前）——belt 应已保留 4 章（旧形态此处行是
    // 0 章 ready 假态，UI 显「0 章|章界待校对」1-3 分钟直至相 B 事务回填）。
    let midWindowRow: Material | null = null;
    const beltDeps = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        midWindowRow = getMaterialRow(materialId);
        return texts.map((_, i) => vec1024(i));
      },
    };
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', beltDeps);
    expect(res.outcome).toBe('registered'); // reingest-skipped-manual → registered
    expect(midWindowRow).not.toBeNull();
    expect(midWindowRow!.chapters).toHaveLength(4); // 🔑 belt 生效：embed 窗口行仍 4 章（0 章中间行不存在）
    expect(readFileSync(derivedAbs, 'utf-8')).toBe(stripped); // 派生人工内容不覆写

    // 相 B 收敛（belt 不拦）：autoResplit 读磁盘派生 .md 重切——最终行 span 基面 = 当前裸文本
    // （与 belt 保留的旧标记基面 span 必不同）+ regex 真实值 + 诚实 note 存续。
    const row = getMaterialRow(materialId)!;
    expect(row.chapters).toHaveLength(4);
    expect(row.chapters.every((c) => c.method === 'regex')).toBe(true);
    expect(row.status).toBe('ready');
    expect(row.quality.parseNotes.some((n) => n.includes('章标记缺失'))).toBe(true);
    expect(JSON.stringify(row.chapters)).not.toBe(JSON.stringify(midWindowRow!.chapters)); // 覆写证明
    const strippedText = readDerivedForTest(derivedAbs);
    for (const c of row.chapters) {
      expect(strippedText.slice(c.charStart, c.charEnd).trim().length).toBeGreaterThan(0); // span 落裸文本基面
    }
  });

  it('C5：chunk 展示名 = 章标真值（简介伪章书不再 +1 错位；简介语义回落；伪章「全文」不变）', async () => {
    // 简介伪章形态：首章标前的卷首简介自成 index 0（title null）——旧 `第${index+1}章` 序号
    // 算术把真「第一章」（index 1）渲染成「第2章」整体错位（F19）。
    const introBook = [
      '卷首简介：一个闭环的故事。',
      '第一章 风起', `${'墨'.repeat(160)}。`,
      '第二章 云涌', `${'雨'.repeat(160)}。`,
      '第三章 潮生', `${'潮'.repeat(160)}。`,
    ].join('\n\n');
    writeProjectSource('intro-book.txt', introBook);
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'intro-book.txt', deps);
    const materialId = res.materialId!;
    const row = getMaterialRow(materialId)!;
    expect(row.chapters).toHaveLength(4); // 简介伪章 + 三真章
    expect(row.chapters[0]!.title).toBeNull();

    const rows = materialRowsRaw(materialId);
    const nameOf = (chapterIndex: number): string => {
      const hit = rows.find((r) => r.chapter_index === chapterIndex);
      expect(hit).toBeDefined();
      return String(hit!.name);
    };
    expect(nameOf(0)).toBe('intro-book·简介（卷首）'); // 简介伪章语义回落（非「第1章」谎言）
    expect(nameOf(1)).toBe('intro-book·第 1 章'); // 🔑 真「第一章」标 1（旧 = 「第2章」错位）
    expect(nameOf(2)).toBe('intro-book·第 2 章');
    expect(nameOf(3)).toBe('intro-book·第 3 章');
  });

  it('F-09：≥2 万字低置信挂起（无 LLM 内核）→ 零章 + 全文单伪章照索引 + status 保留 low-confidence', async () => {
    writeProjectSource('讲义.txt', lowConfidenceLongText());
    const { deps, calls } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, '讲义.txt', deps);
    expect(res.outcome).toBe('registered');
    const materialId = res.materialId!;

    const row = getMaterialRow(materialId)!;
    expect(row.status).toBe('low-confidence'); // 挂起（llm-fallback 零章界）
    expect(row.chapters).toHaveLength(0);
    expect(row.quality.chapterDetection.method).toBe('llm-fallback');
    expect(row.quality.parseNotes.some((n) => n.includes('LLM'))).toBe(true);

    // 检索照常：伪章 chunk 行已落（章界与检索解耦）。
    const rows = materialRowsRaw(materialId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.chapter_id).toBe(materialChapterRef(materialId, 0));
    expect(rows[0]!.name).toBe('讲义·全文'); // 伪章诚实标注
    expect(calls).toHaveLength(1);

    // 重索引不翻转挂起态（零标记 → 登记元数据保留，不产 ready 假象）。
    const re = await reindexMaterial(materialId, deps);
    expect(re.outcome).toBe('hash-skip'); // 同内容重跑 skip
    const rowAfter = getMaterialRow(materialId)!;
    expect(rowAfter.status).toBe('low-confidence');
    expect(rowAfter.chapters).toHaveLength(0);
  });

  it('pending_embed：无模型 → FTS-only（content_hash NULL）+ 模型恢复补嵌', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', {
      resolveModel: () => null,
    });
    const materialId = res.materialId!;
    const rows = materialRowsRaw(materialId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.content_hash).toBeNull();
      expect(r.model).toBeNull();
    }
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:${materialId}`)).toHaveLength(0);
    }
    const ftsHit = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('雨雨雨') as Array<{ entry_id: string }>;
    expect(ftsHit.length).toBeGreaterThan(0);

    // 模型恢复：NULL !== hash → 重嵌补回。
    const { deps } = embedCountingDeps();
    const re = await reindexMaterial(materialId, deps);
    expect(re.outcome).toBe('written');
    for (const r of materialRowsRaw(materialId)) {
      expect(r.content_hash).toHaveLength(64);
      expect(r.model).toBe('text-embedding-3-test');
    }
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:${materialId}`)).toHaveLength(materialRowsRaw(materialId).length);
    }
  });

  it('orphan：删原件 → backfill 清登记 + chunk 行；registerMaterial 对 missing → outcome orphaned', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    const materialId = res.materialId!;
    expect(getMaterialRow(materialId)).not.toBeNull();
    expect(materialRowsRaw(materialId).length).toBeGreaterThan(0);

    // 外部删除原件 → registerMaterial(missing) → orphan 清扫。
    rmSync(path.join(PROJECT_DIR, 'materials', 'novel.txt'));
    const r2 = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    expect(r2.outcome).toBe('orphaned');
    expect(getMaterialRow(materialId)).toBeNull();
    expect(materialRowsRaw(materialId)).toHaveLength(0);
    if (isSqliteVecAvailable()) {
      expect(vecRows(`${PID}:${materialId}`)).toHaveLength(0);
    }

    // backfill 路径同语义（app 未运行时删文件的场景）。
    writeProjectSource('another.txt', chapteredNovel(3));
    const r3 = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'another.txt', deps);
    const id3 = r3.materialId!;
    rmSync(path.join(PROJECT_DIR, 'materials', 'another.txt'));
    const report = await backfillProjectMaterials(PROJECT_DIR, deps);
    expect(report.orphaned).toBe(1);
    expect(getMaterialRow(id3)).toBeNull();
    expect(materialRowsRaw(id3)).toHaveLength(0);
  });

  it('F-01 反向：craft orphan 清扫收窄——material_chunk 行存活，ghost craft_md 行照删', async () => {
    // 全局车道材料入库。
    writeGlobalSource('craft-lecture.txt', chapteredNovel(3));
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'global' }, 'craft-lecture.txt', deps);
    const materialId = res.materialId!;
    const matCraftRows = craftRowsRaw(materialId);
    expect(matCraftRows.length).toBeGreaterThan(0);
    if (isSqliteVecAvailable()) {
      expect(craftVecRows(`mat:${materialId}`).length).toBe(matCraftRows.length);
    }

    // ghost craft_md 行（bundled|user 值域——盘上无对应文档，应被清扫）。
    getDb()
      .prepare(
        `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text, content_hash)
         VALUES (?,?,?,?,?,?)`,
      )
      .run('ghost-craft', 'plot', 'user', '幽灵卡', '盘上已删的手艺卡正文', 'sha256:deadbeef');

    // craft KB 目录为空（TEST_HOME/.orison/craft-kb 不存在）→ 扫描集空。
    await scanAndReindexCraftKb({ resolveModel: () => null });

    // 🔑 F-01：material_chunk 行存活（收窄谓词），ghost craft_md 行删除（craft 扫描照常管理自家行）。
    expect(craftRowsRaw(materialId)).toHaveLength(matCraftRows.length);
    const ghost = getDb().prepare('SELECT COUNT(*) AS n FROM closure_craft_entry WHERE craft_id=?').get('ghost-craft') as { n: number };
    expect(ghost.n).toBe(0);
    if (isSqliteVecAvailable()) {
      expect(craftVecRows(`mat:${materialId}`).length).toBe(matCraftRows.length);
    }
  });

  it('全局车道 INSERT 钉死（closure_craft_entry / craft_vec / craft FTS）', async () => {
    writeGlobalSource('craft-lecture.txt', chapteredNovel(3));
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'global' }, 'craft-lecture.txt', deps);
    expect(res.outcome).toBe('registered');
    const materialId = res.materialId!;

    const row = getMaterialRow(materialId)!;
    expect(row.scope).toBe('global');
    expect(row.projectId).toBeNull();
    expect(listMaterialRows('global').map((m) => m.materialId)).toContain(materialId);

    const rows = craftRowsRaw(materialId);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.craft_type).toBe('material');
      expect(r.source_kind).toBe('material_chunk');
      expect(r.tags).toBeNull();
      expect(r.source).toBe('craft-lecture'); // source = 材料名
      expect(r.model).toBe('text-embedding-3-test');
      expect(String(r.craft_id).startsWith(`mat:${materialId}.ch`)).toBe(true);
      expect(String(r.name)).toMatch(/^craft-lecture·第 \d+ 章·c\d+$/);
    }
    if (isSqliteVecAvailable()) {
      const vecs = craftVecRows(`mat:${materialId}`);
      expect(vecs).toHaveLength(rows.length);
      for (const v of vecs) {
        expect(v.vector_id).toBe(v.craft_id); // craft_vec vector_id = craft_id
        expect(v.vector_kind).toBe('chunk');
      }
    }
    // craft FTS 命中（增强不另建——searchCraft/query_craft 管线零改动含它）。
    const ftsHit = getDb()
      .prepare('SELECT craft_id FROM closure_craft_fts WHERE closure_craft_fts MATCH ?')
      .all('墨墨墨') as Array<{ craft_id: string }>;
    expect(ftsHit.length).toBeGreaterThan(0);
    expect(ftsHit.every((h) => h.craft_id.startsWith(`mat:${materialId}.ch`))).toBe(true);

    // 全局车道登记行的 chunk_spans 回填（F-02 全局车道 span 唯一落点）。
    expect(row.chunkSpans).toHaveLength(rows.length);
  });

  it('backfill mtime 快路幂等：全局扫描第二遍零解析（parse spy 计数不变）+ skipped 计数', async () => {
    writeGlobalSource('a.txt', chapteredNovel(2));
    writeGlobalSource('b.txt', chapteredNovel(2));
    const parse = vi.fn((root: string, rel: string) => parseDocumentToMarkdown(root, rel));
    const { deps } = embedCountingDeps();

    const r1 = await backfillGlobalMaterials({ ...deps, parse });
    expect(r1.registered).toBe(2);
    expect(r1.skipped).toBe(0);
    expect(parse).toHaveBeenCalledTimes(2);
    const rowsAfterFirst = getDb().prepare('SELECT COUNT(*) AS n FROM closure_material').get() as { n: number };
    expect(rowsAfterFirst.n).toBe(2);

    // 第二遍：未变原件 → mtime 快路（零解析），仅重索引（hash-skip 零 embed）。
    const embedCalls: number[] = [];
    const deps2 = {
      resolveModel: () => stubModel(),
      embedBatch: async (_m: ResolvedModel, texts: string[]) => {
        embedCalls.push(texts.length);
        return texts.map((_, i) => vec1024(i));
      },
      parse,
    };
    const r2 = await backfillGlobalMaterials(deps2);
    expect(r2.skipped).toBe(2);
    expect(r2.registered).toBe(0);
    expect(parse).toHaveBeenCalledTimes(2); // 🔑 零新增解析
    expect(embedCalls).toHaveLength(0); // hash-skip 吸收（未变材料零重嵌）
    const rowsAfterSecond = getDb().prepare('SELECT COUNT(*) AS n FROM closure_material').get() as { n: number };
    expect(rowsAfterSecond.n).toBe(2); // 零重复行
  });

  it('kind 无分块策略（event_stream 预留）→ 诚实跳过不硬编码 prose（D6 seam）', async () => {
    const materialId = materialIdFor('global', 'future-game.txt');
    upsertMaterialRow(
      makeMaterial({
        materialId,
        scope: 'global',
        kind: 'event_stream',
        sourcePath: 'future-game.txt',
      }),
    );
    // 对应原件/派生文件存在与否不影响——策略检查在文件检查之后但先于任何分块。
    writeGlobalSource('future-game.txt', chapteredNovel(2));
    const { deps } = embedCountingDeps();
    const res = await reindexMaterial(materialId, deps);
    expect(res.outcome).toBe('no-strategy');
    expect(craftRowsRaw(materialId)).toHaveLength(0);
    expect(deps.embedBatch).toBeDefined(); // deps 形态完整（未被消费）
  });

  it('F-05 COALESCE：用户后补 provenance（author/medium）跨重摄取保留', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    const materialId = res.materialId!;

    // 模拟 Wave D UI 后补（单行表单写 provenance）。
    const cur = getMaterialRow(materialId)!;
    getDb()
      .prepare('UPDATE closure_material SET provenance_json=? WHERE material_id=?')
      .run(
        JSON.stringify({ ...cur.provenance, author: '某讲师', medium: 'lecture', tier: 'community' }),
        materialId,
      );

    // 未变原件重摄取（watcher/backfill 场景）→ 后补字段不清。
    const r2 = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    expect(r2.outcome).toBe('reused');
    const after = getMaterialRow(materialId)!;
    expect(after.provenance.author).toBe('某讲师');
    expect(after.provenance.medium).toBe('lecture');
    expect(after.provenance.tier).toBe('community');
    expect(after.provenance.extractor).toBe('builtin-text'); // 管线事实字段照常刷新
  });

  it('deleteMaterialRows：db-only 四清之 db 侧（登记 + 双车道 chunk 行；不动文件）', async () => {
    writeGlobalSource('del.txt', chapteredNovel(2));
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'global' }, 'del.txt', deps);
    const materialId = res.materialId!;
    expect(craftRowsRaw(materialId).length).toBeGreaterThan(0);

    deleteMaterialRows(materialId);
    expect(getMaterialRow(materialId)).toBeNull();
    expect(craftRowsRaw(materialId)).toHaveLength(0);
    if (isSqliteVecAvailable()) {
      expect(craftVecRows(`mat:${materialId}`)).toHaveLength(0);
    }
    // 不动文件（Wave D delete IPC 负责原件/派生四清）。
    expect(existsSync(path.join(GLOBAL_MATERIALS, 'del.txt'))).toBe(true);
    expect(existsSync(path.join(GLOBAL_MATERIALS, '.derived', 'del.md'))).toBe(true);

    // 兜底分支：登记行已不在（双删竞态/坏行形态）→ projectId-agnostic 前缀删仍清项目车道行。
    const ghostId = materialIdFor('project', 'materials/ghost.txt');
    getDb()
      .prepare(
        `INSERT INTO closure_entry
           (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, chapter_id, chapter_index)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(`${PID}:${ghostId}.ch0#c0`, PID, 'material', 'material', 'ghost·全文', '幽灵正文', 'known', `${ghostId}.ch0`, 0);
    deleteMaterialRows(ghostId);
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM closure_entry WHERE chapter_id LIKE ?").get(`${ghostId}.ch%`),
    ).toMatchObject({ n: 0 });
  });

  it('并发 registerMaterial（同车道）经串行队列全部收敛（无死锁/无 unhandled rejection）', async () => {
    writeProjectSource('p1.txt', chapteredNovel(2));
    writeProjectSource('p2.txt', chapteredNovel(2));
    const { deps } = embedCountingDeps();
    const results = await Promise.all([
      registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'p1.txt', deps),
      registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'p2.txt', deps),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['registered', 'registered']);
    expect(listMaterialRows('project', PID!).length).toBe(2);
  });

  it('content_hash 一致性：登记行 hash = 归一化原文 sha256（路径身份 F-19）', async () => {
    writeProjectSource('novel.txt', chapteredNovel(2));
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    const row = getMaterialRow(res.materialId!)!;
    const normalized = chapteredNovel(2); // 原文已是归一形态（LF/无 BOM）
    expect(row.contentHash).toBe(`sha256:${createHash('sha256').update(normalized, 'utf-8').digest('hex')}`);
  });

  it('F-02 消费缝：lookupMaterialChunkSpans——craft_id 集 → closure_material chunk_spans 回查（非材料行/未知材料 best-effort 缺席）', async () => {
    writeGlobalSource('lecture.txt', chapteredNovel(3));
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'global' }, 'lecture.txt', deps);
    const materialId = res.materialId!;
    const rows = craftRowsRaw(materialId);
    expect(rows.length).toBeGreaterThan(0);
    const craftIds = rows.map((r) => String(r.craft_id));

    // 混入非材料 craft_id 与未知材料行（登记缺失）——不炸、缺席。
    const reg = getMaterialRow(materialId)!;
    expect(reg.chunkSpans.length).toBe(rows.length);
    const spans = lookupMaterialChunkSpans([...craftIds, 'shuangdian-catalog', 'mat:mat-000000000000.ch0#c0']);
    expect(spans.size).toBe(craftIds.length);
    // 🔑 craft_id（编码侧）↔ chunk_spans（索引事务回填侧）解码回查逐条对齐——锚定四元组取数面。
    for (const span of reg.chunkSpans) {
      const key = materialChunkCraftId(materialId, span.chapterIndex, span.chunkIndex);
      expect(spans.get(key)).toEqual(span);
    }
  });

  it('防御带：project 车道坏行（projectId 缺失）deleteMaterialRows → projectId 无关前缀扫清 chunk 行', () => {
    const badId = materialIdFor('project', 'materials/broken.txt');
    upsertMaterialRow(
      makeMaterial({ materialId: badId, scope: 'project', projectId: null, sourcePath: 'materials/broken.txt' }),
    );
    getDb()
      .prepare(
        `INSERT INTO closure_entry
           (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, chapter_id, chapter_index)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(`${PID}:${badId}.ch0#c0`, PID, 'material', 'material', 'broken·全文', '正文', 'known', `${badId}.ch0`, 0);

    deleteMaterialRows(badId);

    expect(getMaterialRow(badId)).toBeNull();
    expect(materialRowsRaw(badId)).toHaveLength(0); // chunk 行同清（不因 projectId 缺失漏删成永久孤儿）
  });

  // ── BMad CR 2026-09-02 修复批（组 2：db/indexer/watcher 线）──

  it('CR-006：章标记全删 → 回自动分章（章列表=自动重分结果，span 一致；二轮 reindex 收敛 hash-skip）', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const { deps } = embedCountingDeps();
    const first = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt', deps);
    const materialId = first.materialId!;
    expect(getMaterialRow(materialId)!.chapters).toHaveLength(4);

    // 校对面「注释全删」：剥光派生 .md 的章标记（design §2.3 → 回自动分章）。
    const derivedAbs = path.join(PROJECT_DIR, 'materials', '.derived', 'novel.md');
    writeFileSync(derivedAbs, stripChapterMarkerLines(readFileSync(derivedAbs, 'utf-8')), 'utf-8');

    const res = await reindexMaterial(materialId, deps);
    expect(res.outcome).toBe('written'); // chunk texts 同文本，但登记 span 基面漂移 → 收敛 belt 不 skip
    const row = getMaterialRow(materialId)!;
    expect(row.chapters).toHaveLength(4); // 自动重分结果（非保留旧 span、非伪章）
    expect(row.chapters.every((c) => c.method === 'regex' && (c.confidence === 'high' || c.confidence === 'medium'))).toBe(true);
    expect(row.quality.chapterDetection.method).toBe('regex');
    expect(row.quality.chapterDetection.matchedFormats.length).toBeGreaterThan(0);
    expect(row.status).toBe('ready');

    // 🔑 span 一致：章切片与 chunk 行 body 均落在**当前裸文本**基面上（切片==body 逐条对齐）。
    const stripped = readDerivedForTest(derivedAbs);
    for (const r of materialRowsRaw(materialId)) {
      expect(stripped.slice(r.char_start as number, r.char_end as number)).toBe(r.body_text);
    }
    const chapterSlices = row.chapters.map((c) => stripped.slice(c.charStart, c.charEnd));
    expect(chapterSlices.every((s) => s.trim().length > 0)).toBe(true);

    // 二轮 reindex：登记已收敛 + 同文本 hash → hash-skip（不反复重写）。
    const res2 = await reindexMaterial(materialId, deps);
    expect(res2.outcome).toBe('hash-skip');
  });

  it('CR-007：无模型 backfill 两遍 → 第二遍零重写（FTS-only pending 行文本面一致即跳过；pending 保留可补嵌）', async () => {
    writeGlobalSource('a.txt', chapteredNovel(2));
    const noModel = { resolveModel: () => null };
    const r1 = await backfillGlobalMaterials(noModel);
    expect(r1.registered).toBe(1);
    const materialId = materialIdFor('global', 'a.txt');
    const rowsAfterFirst = craftRowsRaw(materialId);
    expect(rowsAfterFirst.length).toBeGreaterThan(0);
    for (const r of rowsAfterFirst) expect(r.content_hash).toBeNull(); // pending（无模型）

    // 哨兵：固定 updated_at——重写会刷 datetime('now')，哨兵保持即零重写。
    getDb().exec("UPDATE closure_craft_entry SET updated_at='2000-01-01 00:00:00' WHERE source_kind='material_chunk'");
    getDb().exec("UPDATE closure_material SET updated_at='2000-01-01 00:00:00'");

    const r2 = await backfillGlobalMaterials(noModel);
    expect(r2.registered).toBe(0);
    expect(r2.skipped).toBe(1);
    const craftTs = getDb()
      .prepare("SELECT updated_at FROM closure_craft_entry WHERE source_kind='material_chunk'")
      .all() as Array<{ updated_at: string }>;
    expect(craftTs.length).toBe(rowsAfterFirst.length);
    expect(craftTs.every((t) => t.updated_at === '2000-01-01 00:00:00')).toBe(true);
    const matTs = getDb()
      .prepare('SELECT updated_at FROM closure_material')
      .all() as Array<{ updated_at: string }>;
    expect(matTs.every((t) => t.updated_at === '2000-01-01 00:00:00')).toBe(true);

    // 直接 reindex 路径同样跳过（非仅 backfill mtime 快路）。
    const re = await reindexMaterial(materialId, noModel);
    expect(re.outcome).toBe('hash-skip');

    // pending 保留：模型恢复后照常补嵌（hash NULL ≠ hash → 重写带向量）。
    const { deps, calls } = embedCountingDeps();
    const re2 = await reindexMaterial(materialId, deps);
    expect(re2.outcome).toBe('written');
    expect(calls).toHaveLength(1);
    for (const r of craftRowsRaw(materialId)) expect(r.content_hash).toHaveLength(64);
  });

  it('CR-008：project 车道无 projectId 的枚举 → throw（undefined/null 两形——防跨项目全量静默）', () => {
    expect(() => listMaterialRows('project')).toThrow(/CR-008/);
    expect(() => listMaterialRows('project', undefined)).toThrow(/CR-008/);
    // @ts-expect-error null 形（运行时坏参防御镜像）
    expect(() => listMaterialRows('project', null)).toThrow(/CR-008/);
    expect(() => listMaterialSummaries('project')).toThrow(/CR-008/);
    // 合法调用面不受影响。
    expect(listMaterialRows('project', PID!)).toEqual([]);
    expect(listMaterialSummaries('global')).toEqual([]);
  });

  it('CR-014：symlink 材料被收录（跟随链接；环境无 symlink 特权则 skip）', async (ctx) => {
    mkdirSync(GLOBAL_MATERIALS, { recursive: true });
    // 目标放车道内 dot stash（walk 剪枝不收录本体，只收录链接）——指向车道外的链会被
    // assertWithinProject 的 realResolve 逃逸闸拒（pathGuard 安全不变式，非本 CR 面）。
    const stash = path.join(GLOBAL_MATERIALS, '.stash');
    mkdirSync(stash, { recursive: true });
    writeFileSync(path.join(stash, 'real-novel.txt'), chapteredNovel(2), 'utf-8');
    const link = path.join(GLOBAL_MATERIALS, 'linked.txt');
    try {
      symlinkSync(path.join(stash, 'real-novel.txt'), link);
    } catch {
      // Windows 无开发者模式/管理员特权时 symlink 创建 EPERM——环境限制非代码失败。
      ctx.skip();
      return;
    }
    const { deps } = embedCountingDeps();
    const report = await backfillGlobalMaterials(deps);
    expect(report.registered).toBe(1); // 只链接一份（.stash 本体被 dot 剪枝）
    const id = materialIdFor('global', 'linked.txt');
    expect(getMaterialRow(id)).not.toBeNull(); // Dirent isFile() 对 symlink 恒 false——跟随 statSync 才收录
    expect(craftRowsRaw(id).length).toBeGreaterThan(0);
  });

  it('CR-018：backfill per-item 容错——单材料抛错不中断车道（其余照常登记）', async () => {
    writeGlobalSource('a.txt', chapteredNovel(2));
    writeGlobalSource('b.txt', chapteredNovel(2));
    writeGlobalSource('c.txt', chapteredNovel(2));
    const parse = vi.fn((root: string, rel: string) => {
      if (path.basename(rel) === 'b.txt') throw new Error('simulated out-of-contract parse crash');
      return parseDocumentToMarkdown(root, rel);
    });
    const { deps } = embedCountingDeps();
    const report = await backfillGlobalMaterials({ ...deps, parse });
    expect(report.registered).toBe(2); // a + c；b 抛错被 per-item 吞
    expect(getMaterialRow(materialIdFor('global', 'a.txt'))).not.toBeNull();
    expect(getMaterialRow(materialIdFor('global', 'c.txt'))).not.toBeNull();
    expect(getMaterialRow(materialIdFor('global', 'b.txt'))).toBeNull(); // 抛错路径不产登记行
  });

  it('CR-019：空 path 项目记录 → reindex unresolvable（不落 cwd/materials 误 orphan 删活行）', async () => {
    const emptyDir = path.join(TEST_HOME, 'empty-path-project');
    mkdirSync(emptyDir, { recursive: true });
    ensureProject({
      name: 'EmptyPath',
      type: 'novel',
      localFingerprint: path.resolve(emptyDir),
      path: path.resolve(emptyDir),
    });
    const pid2 = getProject(path.resolve(emptyDir))!.projectId;
    const materialId = materialIdFor('project', 'materials/ghost-empty.txt');
    try {
      // 坏登记形态：registry 行 project_path=''（CR-019 原发现——空串绕过 null 守卫 → cwd/materials）。
      getDb().prepare("UPDATE projects SET project_path='' WHERE project_id=?").run(pid2);
      upsertMaterialRow(
        makeMaterial({
          materialId,
          scope: 'project',
          projectId: pid2,
          sourcePath: 'materials/ghost-empty.txt',
          status: 'ready',
        }),
      );
      getDb()
        .prepare(
          `INSERT INTO closure_entry
             (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, chapter_id, chapter_index)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(`${pid2}:${materialId}.ch0#c0`, pid2, 'material', 'material', 'ghost·全文', '正文', 'known', `${materialId}.ch0`, 0);

      const res = await reindexMaterial(materialId);
      expect(res.outcome).toBe('unresolvable');
      // 🔑 不误删：守卫失效时 materialsRoot=cwd/materials → orphan 判定会连登记带 chunk 行删光。
      expect(getMaterialRow(materialId)).not.toBeNull();
      expect(materialRowsRaw(materialId)).toHaveLength(1);
    } finally {
      deleteMaterialRows(materialId);
      getDb().prepare('DELETE FROM projects WHERE project_id=?').run(pid2);
      rmBestEffort(emptyDir);
    }
  });

  it('CR-030：durable 失败落 failed 登记行 + backfill 两遍零重解析 + 显式 reingest 成功转 ready', async () => {
    // 坏 epub（zip 结构损坏）→ parse-failed（durable——不换文件不自愈）。
    writeGlobalSource('broken.epub', 'definitely not a zip archive');
    const parse = vi.fn((root: string, rel: string) => parseDocumentToMarkdown(root, rel));
    const { deps } = embedCountingDeps();
    const spyDeps = { ...deps, parse };
    const res = await registerMaterial({ scope: 'global' }, 'broken.epub', spyDeps);
    expect(res.outcome).toBe('rejected');
    expect(res.reason).toBe('parse-failed');
    const materialId = res.materialId!;
    expect(materialId).toBe(materialIdFor('global', 'broken.epub'));

    const row = getMaterialRow(materialId)!;
    expect(row).not.toBeNull();
    expect(row.status).toBe('failed');
    expect(row.quality.ok).toBe(false);
    expect(row.quality.parseNotes.some((n) => n.includes('parse-failed'))).toBe(true);
    expect(row.chapters).toHaveLength(0);
    expect(craftRowsRaw(materialId)).toHaveLength(0); // 无 chunk 行（失败不索引）

    // backfill 退避：failed 行在案 → 跳过不重解析（parse 计数不动）。
    expect(parse).toHaveBeenCalledTimes(1);
    const r1 = await backfillGlobalMaterials(spyDeps);
    expect(r1.registered).toBe(0);
    expect(r1.skipped).toBe(1);
    expect(parse).toHaveBeenCalledTimes(1);
    const r2 = await backfillGlobalMaterials(spyDeps);
    expect(r2.skipped).toBe(1);
    expect(parse).toHaveBeenCalledTimes(1);

    // 显式 reingest：换上合法 epub → 重试成功 → status 转 ready。
    writeFileSync(
      path.join(GLOBAL_MATERIALS, 'broken.epub'),
      buildEpubFixture({ documents: [{ href: 'c1.xhtml', body: '<p>修复后的正文段落。</p>' }] }),
    );
    const res2 = await registerMaterial({ scope: 'global' }, 'broken.epub', spyDeps);
    expect(res2.outcome).toBe('registered');
    const row2 = getMaterialRow(materialId)!;
    expect(row2.status).toBe('ready');
    expect(row2.contentHash).not.toBe(row.contentHash); // 失败指纹被真内容 hash 覆盖
    expect(craftRowsRaw(materialId).length).toBeGreaterThan(0);
  });

  it('CR-033：摘要投影不取 chapters/chunk_spans 大数组（毒化列证明零消费）', async () => {
    writeGlobalSource('sum.txt', chapteredNovel(2));
    const { deps } = embedCountingDeps();
    await registerMaterial({ scope: 'global' }, 'sum.txt', deps);
    const id = materialIdFor('global', 'sum.txt');

    // 毒化两大数组列：若摘要查询取列并 parse，坏 JSON 会让该行被 tolerant parse 丢弃。
    getDb()
      .prepare('UPDATE closure_material SET chapters_json=?, chunk_spans_json=? WHERE material_id=?')
      .run('{poison', '[poison', id);
    const summaries = listMaterialSummaries('global');
    const hit = summaries.find((s) => s.materialId === id);
    expect(hit).toBeDefined(); // 摘要面零消费两列 → 行存活
    expect(hit!.status).toBe('ready');
    expect(hit!.name).toBe('sum');
    expect(hit!.provenance.sourcePath).toBe('sum.txt');
    expect(hit!.quality.charCount).toBeGreaterThan(0);
    expect('chapters' in hit!).toBe(false); // 类型面即无该字段
    // 全列面照旧 tolerant 丢行（对照组——毒化确实会被 parse 消费到）。
    expect(listMaterialRows('global').map((m) => m.materialId)).not.toContain(id);
    // lane 便捷面 = 摘要投影（watcher derived 路由 / backfill 取数面）。
    const laneSummaries = listMaterialRowsForLane({ scope: 'global' });
    expect(laneSummaries.map((s) => s.materialId)).toContain(id);
    expect(laneSummaries.every((s) => !('chapters' in s))).toBe(true);
  });

  // ── E10.2a Wave 3：FAILED_FORMAT_BY_EXT + description 旧行回读 ──

  it('E10.2a：字幕三扩展 durable 失败行 format/medium 映射（FAILED_FORMAT_BY_EXT）+ failed 行 description=null', async (ctx) => {
    // 白名单回归 tripwire（mirror CR-014 环境条件 skip 形态）：三扩展若从白名单回退，本测
    // 跳过而非假红——白名单本体由 materialIngest 测试钉住（W2.1 已落地）。
    if (!(MATERIAL_ALLOWED_EXTENSIONS as readonly string[]).includes('.srt')) {
      ctx.skip();
      return;
    }
    const cases = [
      ['broken.srt', 'srt'],
      ['broken.ass', 'ass'],
      ['broken.vtt', 'vtt'],
    ] as const;
    // CR-21：字幕分支**不走 deps.parse**（materialIngest 文本获取分支直调真 parseSubtitle
    // ——原 parse stub 是死代码已删），拒收来自真解析器判「无可提取文本」（AC7 坏结构字幕
    // → durable parse-failed 既有路径）。
    const { deps } = embedCountingDeps();
    for (const [rel, wantFormat] of cases) {
      writeGlobalSource(rel, '非字幕内容（AC7 坏结构形态——真 parseSubtitle 判无可提取文本）');
      const res = await registerMaterial({ scope: 'global' }, rel, deps);
      expect(res.outcome).toBe('rejected');
      expect(res.reason).toBe('parse-failed');
      const row = getMaterialRow(res.materialId!)!;
      expect(row.format).toBe(wantFormat); // FAILED_FORMAT_BY_EXT 三扩展映射
      expect(row.status).toBe('failed');
      expect(row.provenance.medium).toBe('video'); // CR-17：失败行 medium 镜像 per-format 默认（非恒 'other'）
      expect(row.provenance.description).toBeNull(); // E10.2a failed 行装配含 description 键
    }
  });

  it('E10.2a：旧行 provenance_json 无 description 键回读容忍（schema default(null) 兜底——零迁移）', async () => {
    writeGlobalSource('legacy.txt', chapteredNovel(2));
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'global' }, 'legacy.txt', deps);
    const id = res.materialId!;
    // 模拟 10.1 旧行落库形态：provenance_json 无 description 键（E10.2a 契约之前写入的行）。
    const legacy = { ...(getMaterialRow(id)!.provenance) } as Record<string, unknown>;
    delete legacy.description;
    getDb()
      .prepare('UPDATE closure_material SET provenance_json=? WHERE material_id=?')
      .run(JSON.stringify(legacy), id);
    // 全行面（materialSchema.parse）+ 摘要面（materialProvenanceSchema.parse——CR-033 投影
    // provenance 随行携带）回读均容忍：default(null) 填充，不丢行不抛（design §2.1 关键项）。
    expect(getMaterialRow(id)!.provenance.description).toBeNull();
    const summary = listMaterialSummaries('global').find((s) => s.materialId === id);
    expect(summary).toBeDefined();
    expect(summary!.provenance.description).toBeNull();
  });

  it('E10.2a AC2（CR-18）：字幕摄取（无 LLM 降级拼合）→ chunk 行 + FTS 可检回（db 真跑）', async () => {
    // beforeEach 已清 LLM 内核（__clearMaterialLLMCoreForTest）→ 书面化整理降级纯拼合 +
    // parseNote 诚实标注（AC3 降级面）；锚定/分章/双车道 chunk 索引照常（AC2 后半——本测
    // 钉 db 真跑链路：chunk 行带拼合稿内容 + FTS trigram 检回）。
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      '大家好今天讲节奏控制',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,000',
      '先说张力的三个来源',
      '',
      '3',
      '00:00:12,000 --> 00:00:14,000',
      '再讲讲情绪弧的走向',
    ].join('\n');
    writeProjectSource('节奏讲义.srt', srt);
    const { deps } = embedCountingDeps();
    const res = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, '节奏讲义.srt', deps);
    expect(res.outcome).toBe('registered');
    const materialId = res.materialId!;

    // 登记面：字幕 per-format 默认值 + 降级诚实标注（不冒充整理稿）。
    const row = getMaterialRow(materialId)!;
    expect(row.format).toBe('srt');
    expect(row.provenance.medium).toBe('video');
    expect(row.provenance.via).toBe('builtin-subtitle');
    expect(row.status).toBe('ready');
    expect(row.quality.parseNotes.some((n) => n.includes('字幕未经书面化整理'))).toBe(true);

    // chunk 行存在且 body = 拼合稿内容（停顿分段：cue1+2 同段直拼、cue3 跨 6s 间隔成新段）。
    const rows = materialRowsRaw(materialId);
    expect(rows.length).toBeGreaterThan(0);
    const bodies = rows.map((r) => String(r.body_text)).join('\n');
    expect(bodies).toContain('大家好今天讲节奏控制');
    expect(bodies).toContain('再讲讲情绪弧的走向');

    // 🔑 FTS trigram 检回拼合稿内容（AC2「FTS 可检回」——mirror 既有材料 FTS 断言形态）。
    const ftsHit = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('节奏控制') as Array<{ entry_id: string }>;
    expect(ftsHit.map((h) => h.entry_id)).toContain(materialEntryId(PID!, materialId, 0, 0));
  });
});
