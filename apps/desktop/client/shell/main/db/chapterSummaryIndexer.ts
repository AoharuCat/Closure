import { createHash } from 'node:crypto';
import type { ResolvedModel, ChapterStateSummary } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { listChapterSummaries } from './worldStateRepository';
import {
  floatArrayToBuffer,
  getCurrentVecDim,
  shouldSkipForModelMismatch,
} from './closureIndexer';
import {
  reindexChapter,
  resolveChapterIdForEpisodeInProject,
  truncateSynopsisForSummary,
  type ChapterReindexDeps,
} from './chapterChunkIndexer';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

// ── Story 8.3 S3：章摘要检索行索引器（design §3 / prd Requirement 3）──
//
// closure_chapter_summary（8.1 六字段状态账）物化一行进共享 closure_entry/entry_vec：
// source_kind='chapter_summary'，body = synopsis + 六字段名词性拼料（语义正文以 synopsis 为主——
// LLM 申报产物；状态账提供实体名词召回面：角色终态名/关系对/伏笔/承诺名），单 #body 向量。
// 目录/摘要/正文三层召回互补（NWM + Anthropic contextual retrieval 双证据，research §6.9）。
//
// 挂点 = 章摘要物化点（worldStateMaterialize.materializeChapterSummaryCore 成功路径——rebuild
// 路径经其内部调用同点覆盖）+ rebuildChapterSummaries 尾部 orphan 清扫。**synopsis 联动**：摘要行
// 重索引后顺路触发该章 chunk 重索引（episodeId 反解 chapterId 走 resolveChapterIdForEpisodeInProject
// 单源）——chunk 组料 hash 含 synopsis，幂等防重嵌（只有梗概真变才重嵌，design 复审缺漏 #3）。
//
// hash 覆盖「影响存储态的字段」（mirror setting_md 惯例）：episodeIndex（name/排序）+ 拼料 body
// （synopsis + 六字段名词面）。**语义化哈希而非 raw JSON 字符串哈希**：synopsis 经 json_set 回填
// （mentionLedgerMaterialize）后键序与 assemble 全量重写不同，raw 字符串哈希会对逻辑等价内容虚假
// 重嵌；拼料哈希对键序免疫。
//
// 范式判据（ADR-3）：取数（summary 行）+ 名词拼料 + 哈希 + 落表 = 纯代码机械；synopsis/六字段本体
// 是 LLM 已产结构化数据。

/** 章摘要检索行的 source_kind（目录面排除 + orphan 清扫 scope，S4 消费）。 */
export const CHAPTER_SUMMARY_SOURCE_KIND = 'chapter_summary';

/** 摘要行 entry_id：`${projectId}:${episodeId}#summary`（跨项目命名空间，mirror chunk 行惯例）。 */
export function chapterSummaryEntryId(projectId: string, episodeId: string): string {
  return `${projectId}:${episodeId}#summary`;
}

/**
 * 摘要行 body 拼料（纯函数，导出供单测）：synopsis 领衔（语义主体）+ 六字段名词性内容（实体名词
 * 召回面）。**oracleDormant 不进拼料**——dormant 是「谁没出场」的否定性标记且 cap 高达 50000
 * （8.2 回填的防爆上限），塞进检索正文是召回噪音 + 体量炸弹；dormant 角色的召回走 chunk/目录面。
 * 空字段跳过；空摘要 → 空串（调用方按 orphan 语义处理——物化链恒产非空 body，空 = 数据面异常）。
 */
export function buildChapterSummaryBodyText(summary: ChapterStateSummary): string {
  const parts: string[] = [];
  const synopsis = summary.synopsis?.trim();
  if (synopsis) parts.push(synopsis);

  const cast = summary.characterEndStates.map((c) => c.name ?? c.subjectId);
  if (cast.length > 0) parts.push(`出场角色：${cast.join('、')}`);

  const rels = summary.relationshipChanges.map((r) =>
    r.summary?.trim() ? `${r.subjectId}：${r.summary.trim()}` : `${r.subjectId}${r.path}`,
  );
  if (rels.length > 0) parts.push(`关系变化：${rels.join('；')}`);

  const foreshadow = summary.foreshadowChanges.map(
    (f) => `${f.title}（${f.stageChange.from}→${f.stageChange.to}）`,
  );
  if (foreshadow.length > 0) parts.push(`伏笔进展：${foreshadow.join('；')}`);

  const fresh = summary.newEntities.map((n) => `${n.name ?? n.subjectId}（${n.type}）`);
  if (fresh.length > 0) parts.push(`新登场：${fresh.join('、')}`);

  const open = summary.openPromises.map((o) => o.title);
  if (open.length > 0) parts.push(`未决承诺：${open.join('、')}`);

  const next = summary.nextChapterPayoffs.map((n) => n.title);
  if (next.length > 0) parts.push(`下章回收：${next.join('、')}`);

  return parts.join('\n');
}

/**
 * DI seam（与 chapterChunkIndexer.ChapterReindexDeps 同形——embedBatch 批量面让 synopsis 联动的
 * chunk 重索引可以原样透传 deps，测试零网络）。摘要行只 embed 一条 body。
 */
export type ChapterSummaryReindexDeps = ChapterReindexDeps;

/** 缺省批量 embed（mirror chapterChunkIndexer.defaultEmbedBatch，独立定义避免跨模块私有耦合）。 */
async function defaultEmbedBatch(model: ResolvedModel, texts: string[]): Promise<number[][]> {
  // C3.1 计量台账：章摘要重嵌标签（批量调用 = 一行如实）。
  const res = await generateEmbeddings(model, { input: texts }, { signal: AbortSignal.timeout(60_000), taskType: 'chapter-summary-embed' });
  return res.embeddings;
}

/** 删除一章摘要检索行（closure_entry 触发器清 FTS）+ entry_vec 行。单事务。非 chapter_summary
 *  行占据同 entry_id（病理态）→ warn 跳过不 clobber（mirror setting_md F9 不对称 guard）。 */
function deleteChapterSummaryEntry(projectId: string, episodeId: string): void {
  const entryId = chapterSummaryEntryId(projectId, episodeId);
  const db = getDb();
  db.transaction(() => {
    const existing = db
      .prepare('SELECT source_kind FROM closure_entry WHERE entry_id=?')
      .get(entryId) as { source_kind: string } | undefined;
    if (existing && existing.source_kind !== CHAPTER_SUMMARY_SOURCE_KIND) {
      getLogger().warn(
        { entryId, projectId, sourceKind: existing.source_kind },
        'chapter summary reindex: entry_id collides with a non-chapter_summary row - skipping delete',
      );
      return;
    }
    db.prepare('DELETE FROM closure_entry WHERE entry_id=?').run(entryId);
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(entryId);
    }
  })();
}

/**
 * 重索引一章摘要检索行（物化点 hook 入口）+ synopsis 联动 chunk 重索引。
 *
 * - 无摘要行 / 摘要 JSON 损坏（listChapterSummaries 容错跳过）→ orphan 清行返回。
 * - hash skip（episodeIndex + 拼料未变 **且存量模型 == resolved**，CR-T2-001）→ no-op
 *   **且不触发联动**：chunk 组料只依赖 synopsis + 正文，而 synopsis 变更必改拼料（拼料以
 *   synopsis 领衔）→ hash-skip 时联动必是 no-op，省一次 loadProject + 全文重读。同维换模型
 *   下 hash 相等但存量模型是旧模型 → **不 skip**（重嵌到新几何空间，见函数体内 CR-T2-001 注）。
 * - embed 单条（best-effort 家族惯例：无模型/失败/维度/prevailing-model 不匹配 → pending_embed
 *   FTS-only，hash NULL 下次重试）。
 * - 联动失败只 warn（摘要行已落，chunk 重索引由下次 watcher/backfill 兜底）。
 */
export async function reindexChapterSummaryEntry(
  projectId: string,
  projectDir: string,
  episodeId: string,
  deps: ChapterSummaryReindexDeps = {},
): Promise<void> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embedBatch = deps.embedBatch ?? defaultEmbedBatch;
  const db = getDb();

  // 1. 取摘要行（source of truth = closure_chapter_summary，8.1 物化产物）。
  const record = listChapterSummaries(projectId, { episodeIds: [episodeId] })[0];
  if (record === undefined) {
    deleteChapterSummaryEntry(projectId, episodeId);
    return;
  }

  // 2. 拼料 + 检索行形态。B4E8（CR 2026-08-20）：空 body（六字段全空 + 无 synopsis——schema 可达，
  //    物化链正常恒产非空，空 = 数据面异常）违 orphan 契约：落行会造成 content_hash 恒 NULL 的
  //    每次物化重写 churn + 空 FTS 行 + index-status pending 永久虚挂。走 orphan 删除路径（删不落空）。
  const bodyText = buildChapterSummaryBodyText(record.summary);
  if (!bodyText.trim()) {
    deleteChapterSummaryEntry(projectId, episodeId);
    return;
  }
  const name = record.episodeIndex !== null ? `第${record.episodeIndex + 1}章摘要` : `${episodeId} 摘要`;
  const hashPayload = JSON.stringify({ index: record.episodeIndex, body: bodyText });

  const entryId = chapterSummaryEntryId(projectId, episodeId);
  const existing = db
    .prepare('SELECT content_hash, model FROM closure_entry WHERE entry_id=?')
    .get(entryId) as { content_hash: string | null; model: string | null } | undefined;
  const hash = createHash('sha256').update(hashPayload).digest('hex');
  const model = resolveModel();
  // CR-T2-001（dogfood T2 patch，2026-08-25）：skip 谓词加**存量模型比对**。同维换模型时
  // entry_vec 不 DROP、hash 不清——摘要行 hash 相等但 provenance 是旧模型（几何空间已失效），
  // 只比 content_hash 会让它永留旧模型 → DISTINCT 永含旧模型 → degraded 永真 → 启动 sweep
  // 永不收敛（其余四源反复白重嵌）。无 resolved 模型时维持纯 hash-skip（不把健康行 churn 成
  // pending——无模型下重跑只会落 pending）。
  const storedModelStale =
    model !== null && existing?.model != null && existing.model !== model.modelId;
  if (!deps.force && !storedModelStale && existing?.content_hash === hash) return;

  // 3. embed 单条（事务外，best-effort）。
  const vecDim = getCurrentVecDim(db);
  let vec: number[] | null = null;
  let modelId: string | null = null;

  let modelMismatch = false;
  // CR-T2-001 配套：prevailing 门（防日常 on-save 路径意外混模型）在**迁移语义**下让位——
  // 本行存量模型 ≠ resolved 即调用方意图就是换模型（启动 sweep / 手动重建 / 物化 hook 兜新
  // 模型），prevailing 门若照拦会把它打成 FTS-only pending，永不收敛。
  if (model && bodyText.trim() && !deps.force && !storedModelStale) {
    const prevailingRow = db
      .prepare('SELECT model FROM closure_entry WHERE project_id=? AND model IS NOT NULL LIMIT 1')
      .get(projectId) as { model: string } | undefined;
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { projectId, episodeId, prevailingModel, resolvedModel: model.modelId },
        'chapter summary reindex: model mismatch (prevailing vs resolved) - FTS-only',
      );
    }
  }

  if (model && bodyText.trim() && !modelMismatch) {
    try {
      const arr = await embedBatch(model, [bodyText]);
      const first = arr[0];
      if (first && vecDim !== null && first.length === vecDim) {
        vec = first;
        modelId = model.modelId;
      } else {
        getLogger().warn(
          { projectId, episodeId, expected: vecDim, got: first?.length ?? 0, model: model.modelId },
          'chapter summary reindex: embedding dim mismatch - FTS-only',
        );
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectId, episodeId },
        'chapter summary reindex: embed failed - FTS-only',
      );
    }
  }

  // 4. 单 WAL 事务：closure_entry upsert（触发器同步 FTS）+ entry_vec delete-then-insert。
  db.transaction(() => {
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status,
          summary_text, content_hash, model, dim, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(entry_id) DO UPDATE SET
         entry_type=excluded.entry_type,
         source_kind=excluded.source_kind,
         name=excluded.name,
         body_text=excluded.body_text,
         summary_text=excluded.summary_text,
         content_hash=excluded.content_hash,
         model=excluded.model,
         dim=excluded.dim,
         updated_at=datetime('now')`,
    ).run(
      entryId,
      projectId,
      CHAPTER_SUMMARY_SOURCE_KIND, // entry_type = 'chapter_summary'（来源即类型，design §3）
      CHAPTER_SUMMARY_SOURCE_KIND,
      name,
      bodyText,
      'known',
      null, // 摘要行无卡状态（closure_entry.status NULL；vec 侧 '' sentinel）
      truncateSynopsisForSummary(record.summary.synopsis),
      vec ? hash : null, // pending_embed：向量落齐才写 hash
      modelId,
      vec ? vec.length : null,
    );

    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(entryId);
      if (vec) {
        // CR-005 metadata：status ''（closure_entry 侧 NULL 的 sentinel）+ visibility 'known'。
        db.prepare(
          `INSERT INTO entry_vec
             (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(`${entryId}#body`, projectId, entryId, CHAPTER_SUMMARY_SOURCE_KIND, CHAPTER_SUMMARY_SOURCE_KIND, 'body', '', 'known', floatArrayToBuffer(vec));
      }
    }
  })();

  // 5. synopsis 联动：该章 chunk 重索引（hash 幂等——组料含 synopsis，梗概未变零重嵌）。
  try {
    const chapterId = await resolveChapterIdForEpisodeInProject(projectDir, episodeId);
    if (chapterId !== undefined) {
      await reindexChapter(projectId, projectDir, chapterId, {
        resolveModel: deps.resolveModel,
        embedBatch: deps.embedBatch,
        force: deps.force,
      });
    }
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectId, episodeId },
      'chapter summary reindex: synopsis-linked chunk reindex failed - watcher/backfill will reconcile',
    );
  }
}

/**
 * 清扫 orphan 摘要检索行：closure_entry 有 chapter_summary 行但 closure_chapter_summary 已无该
 * episode 行（级联失效删除 / resetWorldState 清库后未重物化的遗留）。挂 rebuildChapterSummaries
 * 尾部（rebuild 循环本身经 materializeChapterSummaryCore 内 hook 逐章重索引，本函数兜「物化集
 * 之外」的 stale 行）。返回删除数。
 */
export function pruneOrphanChapterSummaryEntries(projectId: string): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT entry_id FROM closure_entry WHERE project_id=? AND source_kind='chapter_summary'")
    .all(projectId) as Array<{ entry_id: string }>;
  if (rows.length === 0) return 0;

  const live = new Set(
    (
      db
        .prepare('SELECT episode_id FROM closure_chapter_summary WHERE project_id=?')
        .all(projectId) as Array<{ episode_id: string }>
    ).map((r) => r.episode_id),
  );

  const suffix = '#summary';
  let pruned = 0;
  db.transaction(() => {
    const delEntry = db.prepare('DELETE FROM closure_entry WHERE entry_id=?');
    const delVec = db.prepare('DELETE FROM entry_vec WHERE entry_id=?');
    for (const { entry_id } of rows) {
      // entry_id = `${projectId}:${episodeId}#summary`——projectId 5 位无 ':'，slice 安全
      //（mirror setting_md orphan 惯例）。
      const rest = entry_id.slice(projectId.length + 1);
      if (!rest.endsWith(suffix)) continue;
      const episodeId = rest.slice(0, -suffix.length);
      if (episodeId.length === 0 || live.has(episodeId)) continue;
      delEntry.run(entry_id);
      if (isSqliteVecAvailable()) delVec.run(entry_id);
      pruned++;
    }
  })();
  return pruned;
}
