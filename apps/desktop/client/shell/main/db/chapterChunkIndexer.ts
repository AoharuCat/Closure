import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedModel } from '@orison/shared-contracts';
import {
  buildChunkIndexText,
  chapterChunkSchema,
  chunkChapter,
  resolveChapterIdForEpisode,
  resolveEpisodeIdForChapter,
} from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { listChapterSummaries } from './worldStateRepository';
import {
  floatArrayToBuffer,
  getCurrentVecDim,
  shouldSkipForModelMismatch,
} from './closureIndexer';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

// ── Story 8.3 S3：章正文 chunk 索引器（design §2.2/§2.3 / prd Requirement 2）──
//
// 把 `chapters/{chapterId}.md` 经 S2 分块器（chunkChapter，语义分块红线）切成 chunk，物化进共享
// `closure_entry` / `entry_fts` / `entry_vec` 表（增强不另建，ADR-3）：**chunk = closure_entry 的
// source_kind='chapter' 行，一行一 chunk**——检索管线（searchClosure 四 Case + RRF JOIN）零改动天然
// 含 chunk，FTS trigger 天然同步。
//
// Mirror 家族：`settingMdIndexer`（文件源 + entry_id 跨项目命名空间 + pending_embed/prevailing-model/
// crash-consistency 惯例）+ `closureIndexer`（hash skip + DI seam）。Source of truth = chapters/*.md
// 文件；closure_* 行是 DERIVED 检索面，可 drop 重建（rebuildChapterChunks 即回滚路径）。
//
// 🔑 entry_id 命名空间：`${projectId}:${chapterId}#c${n}`（registry 5 位 projectId 前缀，mirror
// setting_md；`#c<n>` 是 8.7 vec0 多向量注释预留的 chunk 形态）。vec0 行 vector_id = entry_id 本身
// （`#c<n>` 后缀已承担 kind 标记，不再叠 `#body`），vector_kind='chunk'（EntryHit 开放第三类兑现）。
//
// crash-consistency（gate G3 同款）：embed 批量调用（网络）跑在事务**外**；单 WAL 事务内 DELETE 旧章
// 行 + INSERT 新行（closure_entry + entry_vec）。embed 失败 → FTS-only（pending_embed，content_hash
// NULL）——下次 reindex 重试补嵌。
//
// 触发面（design §2.3 watcher 模式）：chapters/ 目录 watcher（chapterChunkWatcher，本模块的消费者）
// + 项目打开 backfill（projectIpc）+ 章摘要物化点 synopsis 联动（chapterSummaryIndexer）。写盘路径
// 无关——accept（local-bff）/ chapter_write 修订 / 编辑器保存 / 外部编辑器改删全由 watcher 覆盖。
//
// 范式判据（ADR-3）：分块（S2 纯函数）+ 章序/摘要取数 + 哈希 + 落表 = 全纯代码机械；零语义判断
// （synopsis 是 LLM 申报产物，缺失退化零编造）。

/** 章正文 chunk 行的 source_kind（与既有 asset_card/setting_card/setting_md 同表共存）。 */
export const CHAPTER_SOURCE_KIND = 'chapter';

/**
 * chunk 行 entry_id（= entry_vec 行 vector_id）。`${projectId}:${chapterId}#c${n}`——projectId
 * 前缀防跨项目 PK 碰撞（mirror setting_md 惯例），`#c${n}` 是 8.7 vec0 预留的 chunk 向量形态。
 */
export function chapterEntryId(projectId: string, chapterId: string, chunkIndex: number): string {
  return `${projectId}:${chapterId}#c${chunkIndex}`;
}

/**
 * 检索分诊三级变焦的摘要层文本（design §2.2「chunk 行 = 章 synopsis 截断」）：给 chunk/摘要行
 * summary_text 列的截断梗概。160 字硬帽是「一行简述」量级的工程锚点（dogfood 校准点，同 S2 尺寸
 * 常量族）——synopsis 本体（写手申报，median ~1310 token 摘要中的一句话级字段）不受影响。
 */
export function truncateSynopsisForSummary(synopsis: string | undefined): string | null {
  const trimmed = synopsis?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 160) return trimmed;
  // E7（CR 2026-08-20）：160 位若落在高代理对（0xD800-0xDBFF）首位，切它会留下孤立代理
  // （呈现层乱码）——边界回退一字（159），surrogate pair 整对让给「…」前的末字符。
  const boundary = trimmed.charCodeAt(159);
  const cut = boundary >= 0xd800 && boundary <= 0xdbff ? 159 : 160;
  return `${trimmed.slice(0, cut)}…`;
}

/**
 * DI seam（mirror closureIndexer.ReindexDeps / settingMdIndexer.SettingReindexDeps）。测试注入
 * stub 使 db 集成 suite 零网络；生产缺省走 resolveEmbeddingModel + generateEmbeddings。
 */
export type ChapterReindexDeps = {
  /** Resolve the embedding model; null → FTS-only（pending_embed）。缺省 resolveEmbeddingModel。 */
  resolveModel?: () => ResolvedModel | null;
  /**
   * 批量 embed（**一章一次调用**，input = 全部 chunk 组料，design §2.3「批量 embed 单调用」——
   * 非逐 chunk）。缺省 generateEmbeddings 包装（60s 超时，mirror defaultEmbed CR-06；批量比单条
   * 慢，放宽到 60s）。
   */
  embedBatch?: (model: ResolvedModel, texts: string[]) => Promise<number[][]>;
  /**
   * 绕过 content-hash skip（模型/维度迁移的 reindexAll 家族授权路径）。日常 watcher/backfill 路径
   * 不传（hash skip 让未变章零成本）。
   */
  force?: boolean;
};

/** 缺省批量 embed：单次 generateEmbeddings 调用，embeddings 按 input 序返回（zip by index）。 */
async function defaultEmbedBatch(model: ResolvedModel, texts: string[]): Promise<number[][]> {
  // C3.1 计量台账：章块批量重嵌标签（8.3 批量重嵌大消耗面的可分账标签；批量调用 = 一行如实）。
  const res = await generateEmbeddings(model, { input: texts }, { signal: AbortSignal.timeout(60_000), taskType: 'chapter-chunk-embed' });
  return res.embeddings;
}

/**
 * 读章正文源文件（`chapters/{chapterId}.md`）。BOM strip + CRLF→LF 归一（mirror setting-md 读取
 * 惯例 CR-08-16-104——S2 分块器的偏移与归一后字符串一一对应）。文件不存在/不可读 → undefined
 * （调用方按 orphan 语义清行）。
 */
export function readChapterSource(projectDir: string, chapterId: string): string | undefined {
  try {
    const raw = readFileSync(path.join(projectDir, 'chapters', `${chapterId}.md`), 'utf-8');
    // BOM（U+FEFF）用码点判剥，不用字面字符（eslint no-irregular-whitespace）。
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return stripped.replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

// ── episode ↔ chapter 映射（canonical 单源取数，mirror mentionLedgerDegrade 抽取形态）──

/** loadProject 的防御性投影（direct 字段抽取 + 形状过滤——组装层不 coupling 全文档 schema）。 */
interface EpisodeChapterIndex {
  episodes: Array<{ id: string; index: number }>;
  chapters: Array<{ id: string; sort_order?: number }>;
}

async function loadEpisodeChapterIndex(projectDir: string): Promise<EpisodeChapterIndex | null> {
  const { loadProject } = await import('@orison/desktop-local-bff');
  const doc = loadProject(projectDir) as Record<string, unknown> | null;
  if (doc === null) return null;
  const rawEpisodes = doc.episode_outlines;
  const rawChapters = (doc.novel as { chapters?: unknown } | undefined)?.chapters;
  if (!Array.isArray(rawEpisodes) || !Array.isArray(rawChapters)) return null;
  const episodes = rawEpisodes
    .map((ep) => ep as { id?: unknown; index?: unknown })
    .filter(
      (ep): ep is { id: string; index: number } =>
        typeof ep.id === 'string' && typeof ep.index === 'number',
    );
  const chapters = rawChapters
    .map((ch) => ch as { id?: unknown; sort_order?: unknown })
    .filter((ch): ch is { id: string; sort_order?: number } => typeof ch.id === 'string');
  return { episodes, chapters };
}

/**
 * chapterId（文件 stem，= novel.chapters[].id 惯例）→ 所属 episode 元数据。episodeId 用
 * resolveEpisodeIdForChapter 单源（canonical 链反向 + 正向回代校验）；episodeIndex 供 name
 * （`第{N}章`，0-based index + 1）与 chapter_index 列。映射失败 → episodeId undefined + index
 * null（graceful 降级：name 回退 chapterId，synopsis 取不到 prefix 退化——零编造）。
 */
export async function resolveEpisodeMetaForChapter(
  projectDir: string,
  chapterId: string,
): Promise<{ episodeId?: string; episodeIndex: number | null }> {
  try {
    const idx = await loadEpisodeChapterIndex(projectDir);
    if (idx === null) return { episodeIndex: null };
    const episodeId = resolveEpisodeIdForChapter(idx.episodes, idx.chapters, chapterId);
    if (episodeId === undefined) return { episodeIndex: null };
    const episodeIndex = idx.episodes.find((ep) => ep.id === episodeId)?.index ?? null;
    return { episodeId, episodeIndex };
  } catch {
    return { episodeIndex: null };
  }
}

/**
 * episodeId → chapterId（synopsis 联动的反向映射，chapterSummaryIndexer 消费）。
 * resolveChapterIdForEpisode 单源；映射失败 → undefined（联动 no-op，不猜）。
 */
export async function resolveChapterIdForEpisodeInProject(
  projectDir: string,
  episodeId: string,
): Promise<string | undefined> {
  try {
    const idx = await loadEpisodeChapterIndex(projectDir);
    if (idx === null) return undefined;
    return resolveChapterIdForEpisode(idx.episodes, idx.chapters, episodeId);
  } catch {
    return undefined;
  }
}

/**
 * 读该章 synopsis（chunk contextual prefix 的来源，design §2.1）。closure_chapter_summary 经
 * listChapterSummaries（坏 JSON 行跳过——CR-E6 容错）→ summary.synopsis。无摘要行/无 synopsis/
 * 空白 → undefined（prefix 退化，纯代码不合成梗概——mirror degradedNote 哲学）。
 */
function readChapterSynopsis(
  projectId: string,
  episodeId: string | undefined,
): string | undefined {
  if (episodeId === undefined) return undefined;
  const rows = listChapterSummaries(projectId, { episodeIds: [episodeId] });
  const synopsis = rows[0]?.summary.synopsis;
  const trimmed = typeof synopsis === 'string' ? synopsis.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** reindexChapter 结果（watcher/backfill 观测 + 测试断言面）。 */
export type ChapterReindexOutcome = 'written' | 'hash-skip' | 'missing' | 'empty';

export interface ChapterReindexResult {
  outcome: ChapterReindexOutcome;
  /** 分块器产出的 chunk 数（missing 时 0）。 */
  chunkCount: number;
}

// ── E5（CR 2026-08-20）：vec 清理改 vector_id 前缀删 ──
//
// 旧实现先查 closure_entry 旧行 entry_id 再逐行点删 entry_vec——依赖「entry 行与 vec 行同生共死」。
// 该依赖在 vec 扩展不可用窗口期被打破：清理门控 isSqliteVecAvailable（扩展缺失时 entry_vec 表本身
// 不存在，跳过删除），entry 行照删 → 扩展恢复后同章 reindex INSERT 同 vector_id PK → **UNIQUE 冲突
// 使该章索引永久失败循环**。前缀删不依赖 closure_entry 查询：`LIKE '${projectId}:${chapterId}#c%'`
// 恰覆盖该章全部 chunk 向量（vector_id = entry_id = `${projectId}:${chapterId}#c${n}`），残留孤儿
// vec 行一并清掉。⚠️ LIKE 通配符转义：chapterId 约定 [\w-]+ 含 `_`（单字符通配符）——未转义的
// `ch_001` 会误删 `chX001` 的行（Electron 探针实证 + escapeLike 惯例，worldStateRepository CR-7）。
// ⚠️ 病理残留面：另一章 stem 字面以 `<本章stem>#c` 开头（如文件名 `ch_001#c5.md`）会被本前缀误删
// ——病理性文件名 + 下轮 rebuild 自愈，接受（dispatch 处方形态）。
function escapeVecPrefix(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 删该章全部 chunk 向量行（vector_id 前缀删，E5）。vec 扩展不可用 → no-op（表不存在）。 */
function deleteChapterVecRowsByPrefix(projectId: string, chapterId: string): void {
  if (!isSqliteVecAvailable()) return;
  const db = getDb();
  db.prepare("DELETE FROM entry_vec WHERE vector_id LIKE ? ESCAPE '\\'").run(
    `${escapeVecPrefix(projectId)}:${escapeVecPrefix(chapterId)}#c%`,
  );
}

/** 删除一章的全部 chunk 行（closure_entry 触发器同步清 entry_fts）+ 对应 entry_vec 行。单事务。 */
function deleteChapterChunkRows(projectId: string, chapterId: string): void {
  const db = getDb();
  db.transaction(() => {
    // E5：vec 清理走 vector_id 前缀删（不依赖 closure_entry 旧行查询——孤儿 vec 行也清）。
    deleteChapterVecRowsByPrefix(projectId, chapterId);
    db.prepare(
      "DELETE FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND chapter_id=?",
    ).run(projectId, chapterId);
  })();
}

/**
 * 重索引一章正文（watcher / backfill / synopsis 联动的公共入口）。幂等 + content-hash skip：
 * 组料（正文 + synopsis）未变 → no-op（`hash-skip`，零 embed 成本——synopsis 是组料维度，梗概
 * 变更同样触发重嵌，design §2.1 复审缺漏 #3）。
 * - outcome 语义：`written` = 行已（重）写；`hash-skip` = 组料未变 no-op；`missing` = 文件不存在
 * （orphan 清行，mirror reindexAssetDelete）；`empty` = 空章/纯标记章（零 chunk 合法，清行）。
 *
 * embed 批量单调用（整章组料一次 embedBatch）；无模型/失败/维度不符/prevailing-model 不匹配 →
 * FTS-only（pending_embed：content_hash NULL，下次调用重试）。永不因 embed 抛（log + 降级）；
 * db 写错误向上传播由调用方（watcher/backfill 的 per-chapter try/catch）容错。
 */
export async function reindexChapter(
  projectId: string,
  projectDir: string,
  chapterId: string,
  deps: ChapterReindexDeps = {},
): Promise<ChapterReindexResult> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embedBatch = deps.embedBatch ?? defaultEmbedBatch;
  const db = getDb();

  // 1. 读源文件（归一后全文——分块/hash 基准一致）。缺文件 → orphan 清行。
  const text = readChapterSource(projectDir, chapterId);
  if (text === undefined) {
    deleteChapterChunkRows(projectId, chapterId);
    return { outcome: 'missing', chunkCount: 0 };
  }

  // 2. 章元数据（episode 映射 + synopsis 组料维度）。
  const { episodeId, episodeIndex } = await resolveEpisodeMetaForChapter(projectDir, chapterId);
  const synopsis = readChapterSynopsis(projectId, episodeId);

  // 3. 分块（S2 纯函数）+ schema 校验。B5（CR 2026-08-20）：**fail-loud**——分块器自产恒过是本
  //    模块契约，safeParse 失败即契约破坏（未来分块器漂移），静默丢弃会让 indexTexts/vectors 按位
  //    zip 错位（写事务抛错或错位绑定），必须 throw 而非防御性吞掉。
  const chunks = chunkChapter(text, { synopsis }).map((c, i) => {
    const parsed = chapterChunkSchema.safeParse(c);
    if (!parsed.success) {
      throw new Error(
        `chapter chunk reindex: chunker produced a schema-invalid chunk (chapter=${chapterId}, position=${i}): ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  });
  if (chunks.length === 0) {
    // 空章/纯标记章：零 chunk 合法，但旧 chunk 行必须清（重写成空 = 旧段全 stale）。
    deleteChapterChunkRows(projectId, chapterId);
    return { outcome: 'empty', chunkCount: 0 };
  }

  // 4. 章级组料 hash（正文 + synopsis + 章序）。B3E3（CR 2026-08-20）：**chapterIndex 进 hash**——
  //    大纲重排/插章后 chapter_index 列与 name（`第N章·段M`）会 stale，rebuild 的 hash-skip 修不了
  //    （组料未变即跳过）——章序维度入 hash 让重排触发重嵌（mirror 摘要行 hashPayload 的 index
  //    维度，chapterSummaryIndexer）。hash 只在整章向量落齐时写，pending_embed NULL 语义 = 章级
  //    重试粒度。
  const hash = createHash('sha256')
    .update(JSON.stringify({ synopsis: synopsis ?? null, text, chapterIndex: episodeIndex ?? null }))
    .digest('hex');
  const existing = db
    .prepare(
      "SELECT content_hash FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND chapter_id=? LIMIT 1",
    )
    .get(projectId, chapterId) as { content_hash: string | null } | undefined;
  if (!deps.force && existing?.content_hash === hash) {
    return { outcome: 'hash-skip', chunkCount: chunks.length };
  }

  // 5. 批量 embed——事务外、best-effort（mirror 家族：模型门 + 维度门 + 全章 all-or-nothing）。
  const indexTexts = chunks.map((c) => buildChunkIndexText(c.text, synopsis));
  const vecDim = getCurrentVecDim(db);
  let vectors: number[][] | null = null;
  let modelId: string | null = null;
  const model = resolveModel();

  let modelMismatch = false;
  if (model && !deps.force) {
    const prevailingRow = db
      .prepare('SELECT model FROM closure_entry WHERE project_id=? AND model IS NOT NULL LIMIT 1')
      .get(projectId) as { model: string } | undefined;
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { projectId, chapterId, prevailingModel, resolvedModel: model.modelId },
        'chapter chunk reindex: model mismatch (prevailing vs resolved) - FTS-only; run rebuild to migrate',
      );
    }
  }

  if (model && !modelMismatch) {
    try {
      const arr = await embedBatch(model, indexTexts);
      if (
        arr.length === chunks.length &&
        vecDim !== null &&
        arr.every((v) => v.length === vecDim)
      ) {
        vectors = arr;
        modelId = model.modelId;
      } else {
        getLogger().warn(
          { projectId, chapterId, expected: vecDim, got: arr.length, model: model.modelId },
          'chapter chunk reindex: embedding count/dim mismatch - FTS-only',
        );
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectId, chapterId },
        'chapter chunk reindex: embed failed - FTS-only',
      );
    }
  }

  // 6. 单 WAL 事务：DELETE 旧章行（entry + vec）+ INSERT 新行。⚠️ S10 教训：INSERT 多列逐列点数
  //    ——closure_entry 现 20 列（本 INSERT 显式列 19 + updated_at），entry_vec 9 列，用显式列名
  //    清单常量核对。
  const namePrefix = episodeIndex !== null ? `第${episodeIndex + 1}章` : chapterId;
  const summaryZoom = truncateSynopsisForSummary(synopsis);
  db.transaction(() => {
    // E5：vec 清理走 vector_id 前缀删（同 deleteChapterChunkRows——孤儿 vec 行也清，防 PK 冲突
    // 死循环）。
    deleteChapterVecRowsByPrefix(projectId, chapterId);
    db.prepare(
      "DELETE FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND chapter_id=?",
    ).run(projectId, chapterId);

    // 列序：entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status,
    // summary_text, content_hash, model, dim, chapter_id, chapter_index, char_start, char_end,
    // para_start, para_end, index_text, updated_at（= 19 绑定 + datetime('now')）。
    const insertEntry = db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status,
          summary_text, content_hash, model, dim,
          chapter_id, chapter_index, char_start, char_end, para_start, para_end, index_text, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
    );
    // 列序：vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status,
    // visibility, embedding（= 9 绑定）。CR-005：status/visibility 物化 metadata——chunk 行
    // closure_entry 侧 status 为 NULL（正文无卡状态），vec0 TEXT 列拒 NULL → '' sentinel（S1
    // 探针定论：'' 在 `= '具体值'` 下与 SQL NULL 同为不匹配，belt 语义对齐）。
    const insertVec = db.prepare(
      `INSERT INTO entry_vec
         (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const [i, chunk] of chunks.entries()) {
      // B5：数组位 i 是唯一寻址键（chunks[i] → indexTexts[i] → vectors[i] 按位 zip；entry_id 也
      // 用位序）——上游 fail-loud schema 门保证 chunks 数组与组料/向量逐位对齐，不再消费
      // chunk.index 字段（错位面清零）。
      const entryId = chapterEntryId(projectId, chapterId, i);
      insertEntry.run(
        entryId,
        projectId,
        'chapter', // entry_type = 'chapter'（来源即类型，design §2.2）
        CHAPTER_SOURCE_KIND,
        `${namePrefix}·段${i + 1}`,
        chunk.text,
        'known',
        null,
        summaryZoom,
        vectors ? hash : null,
        modelId,
        vectors && vectors[i] ? vectors[i]!.length : null,
        chapterId,
        episodeIndex,
        chunk.charStart,
        chunk.charEnd,
        chunk.paraStart,
        chunk.paraEnd,
        indexTexts[i]!,
      );
      if (vectors && isSqliteVecAvailable()) {
        insertVec.run(
          entryId, // vector_id = entry_id（`#c<n>` 已是 kind 标记，design §2.2）
          projectId,
          entryId,
          'chapter',
          CHAPTER_SOURCE_KIND,
          'chunk',
          '',
          'known',
          floatArrayToBuffer(vectors[i]!),
        );
      }
    }
  })();
  return { outcome: 'written', chunkCount: chunks.length };
}

/**
 * 全量重建一章索引底座（项目打开 backfill / 手动 rebuild / 测试）：扫 chapters/*.md 逐章
 * reindexChapter + orphan 清理（db 有章行但文件不在）。hash skip 让未变章零成本——全量重扫的
 * 取舍：免 db 行 ↔ 文件 mtime/hash 预对照的复杂度（分块 + 哈希本身是纯内存快操作，贵的是 embed
 * 而 skip 已挡住）。
 */
async function runRebuildChapterChunks(
  projectId: string,
  projectDir: string,
  deps: ChapterReindexDeps = {},
): Promise<{ reindexed: number; orphaned: number }> {
  const db = getDb();
  const dir = path.join(projectDir, 'chapters');
  const stems = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.md') && f.length > 3)
        .map((f) => f.slice(0, -3))
        .sort()
    : [];
  const onDisk = new Set(stems);

  // orphan 清理：db 章行（chapter_id 列非 NULL）不在盘上 → 清行（含 entry_vec）。
  let orphaned = 0;
  const indexed = db
    .prepare(
      "SELECT DISTINCT chapter_id FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND chapter_id IS NOT NULL",
    )
    .all(projectId) as Array<{ chapter_id: string }>;
  for (const { chapter_id } of indexed) {
    if (onDisk.has(chapter_id)) continue;
    try {
      deleteChapterChunkRows(projectId, chapter_id);
      orphaned++;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectId, chapterId: chapter_id },
        'chapter chunk rebuild: orphan delete failed - continuing',
      );
    }
  }

  // 逐章重索引（hash skip 未变章 no-op；单章失败 warn 继续）。
  let reindexed = 0;
  for (const chapterId of stems) {
    try {
      if ((await reindexChapter(projectId, projectDir, chapterId, deps)).outcome === 'written') {
        reindexed++;
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectId, chapterId },
        'chapter chunk rebuild: per-chapter reindex failed - continuing',
      );
    }
  }
  return { reindexed, orphaned };
}

/**
 * Per-project 串行化包装（mirror reindexAllSettingMd F5/EDGE-2）：并发 **rebuild** 经 in-flight
 * Map 链到前一个 promise 后（settle 后重扫最新盘面），防 stale 复活（同 project 双 rebuild 并发
 * 时后者看到前者的落行）。
 *
 * 串行化范围如实声明（B2E2，2026-08-20 用户裁决重定性）：**仅 rebuild↔rebuild** 经本链串行。
 * watcher flush / 摘要物化 synopsis 联动的 reindexChapter 与 rebuild 可并行——产品不预设用户
 * API 并发限制（「串行化守 API 并发」的原声明撤回：那是开发过程的 subagent 纪律，非产品约束）。
 * 并发写同章的 stale 复活窗口（A 读旧 → B 读新 → B 写 → A 写旧）由 watcher 下轮文件事件收敛
 * （hash skip 幂等，同内容重写零成本）；Linux fs.watch 降级场景存活到下次项目打开 backfill
 * ——deferred 观察点（dogfood 数据驱动，真出问题再修）。
 */
const inflightRebuilds = new Map<string, Promise<{ reindexed: number; orphaned: number }>>();

export async function rebuildChapterChunks(
  projectId: string,
  projectDir: string,
  deps: ChapterReindexDeps = {},
): Promise<{ reindexed: number; orphaned: number }> {
  const resolved = path.resolve(projectDir);
  const prior = inflightRebuilds.get(resolved);
  if (prior) {
    const chained = prior.then(
      () => runRebuildChapterChunks(projectId, resolved, deps),
      () => runRebuildChapterChunks(projectId, resolved, deps),
    );
    inflightRebuilds.set(resolved, chained);
    // B1：清理由 `.then(clear, clear)` 承接（mirror enqueueWork 的 then(run,run) 模式）——
    // `.finally()` 的派生 promise 在外层 reject 时自身 reject 且无人 await = unhandled rejection。
    const clearChained = () => {
      if (inflightRebuilds.get(resolved) === chained) inflightRebuilds.delete(resolved);
    };
    chained.then(clearChained, clearChained);
    return chained;
  }
  const current = runRebuildChapterChunks(projectId, resolved, deps);
  inflightRebuilds.set(resolved, current);
  const clearCurrent = () => {
    if (inflightRebuilds.get(resolved) === current) inflightRebuilds.delete(resolved);
  };
  current.then(clearCurrent, clearCurrent);
  return current;
}
