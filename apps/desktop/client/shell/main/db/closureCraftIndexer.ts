import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import {
  EMBED_DIM,
  floatArrayToBuffer,
  shouldSkipForModelMismatch,
} from './closureIndexer';
import {
  defaultGenerateSummary,
  buildIdentityText,
  resolveDocSummary,
} from './docSummary';
import { resolveEmbeddingModel, resolveSummaryModel } from '../ipc/modelGatewayIpc';
import { parseCraftMd, extractCraftName, deriveCraftId } from './craftMd';
import { listCraftMdFiles } from './craftKbPaths';
// E10.2b Wave 2（F-05）：reindexAllCraft 末尾串接卡 sweep。单向依赖（卡 repository 不 import
// 本模块——dim 读取走 craftVecDim leaf，见该文件头注记）。
import { firstCraftCardCondensed, reindexAllCards } from './closureCraftCardRepository';
import { getLogger } from '../logger';

/**
 * Global craft KB reindex indexer (ADR-3 / Story 2.1). Mirrors `closureIndexer`
 * for the GLOBAL craft reference library. Source of truth = markdown docs under
 * `~/.orison/craft-kb/` (+ bundled seeds); `closure_craft_*` is a DERIVED
 * query/retrieval face that can be dropped + rebuilt from the docs at any time.
 *
 * Differences from closureIndexer: source is a markdown FILE (frontmatter +
 * body), not a `project_assets` row; no `projectId` (global); `craft_type`
 * instead of `entry_type`; no `visibility` (craft docs are all public). The
 * crash-consistency contract (gate G3) is identical: the embed call AND the
 * Story 8.7 summary generate run OUTSIDE any txn, only the closure_craft_*
 * writes are wrapped in a single WAL transaction.
 *
 * Story 8.7 (S4): craft docs are long docs → summary layer (curated /
 * generated one-liner + body-hash fingerprint cache, `docSummary.ts`) + dual
 * vector (#body full text + #identity name+type+summary, design §1.3).
 */

/**
 * Read the current `closure_craft_vec` embedding dimension from the live schema
 * (mirror of `getCurrentVecDim` for the craft table). null when the table is
 * absent (vec extension not loaded, or not yet created).
 *
 * E10.2b Wave 2: implementation moved to the `craftVecDim.ts` leaf (breaks the
 * indexer ↔ card-repository cycle — see that file). Re-exported here so the
 * existing import points (materialIndexer / retrieval side) stay untouched.
 */
import { getCurrentCraftVecDim } from './craftVecDim';
export { getCurrentCraftVecDim };

/**
 * Dependency-injection seam (mirrors closureIndexer.ReindexDeps). Tests pass
 * stubs so the DB-integration suite runs (under the Electron ABI) with ZERO
 * network - no real embed / summary endpoint is hit.
 */
export type CraftReindexDeps = {
  /** Resolve the embedding model; null -> FTS-only (pending_embed). Defaults to resolveEmbeddingModel. */
  resolveModel?: () => ResolvedModel | null;
  /** Embed a single body string -> vector. Defaults to a generateEmbeddings wrapper. */
  embed?: (model: ResolvedModel, body: string) => Promise<number[]>;
  /** Resolve the summary model (Story 8.7 §3.1); null -> no LLM summary (graceful).
   *  Defaults to resolveSummaryModel. */
  resolveSummaryModel?: () => ResolvedModel | null;
  /** Generate a one-line summary for a body (Story 8.7 §3.1). Defaults to a
   *  generateText wrapper. */
  generateSummary?: (model: ResolvedModel, body: string) => Promise<string>;
  /** Bypass the content-hash skip (reindexAllCraft on a model/dim swap). Default false. */
  force?: boolean;
};

/**
 * Default embed: one generateEmbeddings call, return the first vector. 30s
 * `AbortSignal.timeout` (mirror closureIndexer.defaultEmbed CR-06).
 */
async function defaultEmbed(model: ResolvedModel, body: string): Promise<number[]> {
  // C3.1 计量台账：craft KB 索引重嵌标签。
  const res = await generateEmbeddings(model, { input: [body] }, { signal: AbortSignal.timeout(30_000), taskType: 'craft-index-embed' });
  return res.embeddings[0] ?? [];
}

/**
 * Reindex a single craft md doc into the derived `closure_craft_*` index.
 * Idempotent + content-hash aware (unchanged body -> no-op). Best-effort
 * embedding: no model / failure / dim-mismatch -> FTS-only (pending_embed). Never
 * throws on embed failure (logs + degrades); db write errors propagate.
 *
 * @param filePath  absolute path to the craft md doc.
 * @param sourceKind 'bundled' (read-only seed) or 'user' (writable override).
 */
export async function reindexCraftDoc(
  filePath: string,
  sourceKind: 'bundled' | 'user',
  deps: CraftReindexDeps = {},
): Promise<void> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const resolveSummary = deps.resolveSummaryModel ?? resolveSummaryModel;
  const generateSummary = deps.generateSummary ?? defaultGenerateSummary;
  const db = getDb();
  const vecDim = getCurrentCraftVecDim(db);

  // 1. Read + parse the craft md doc (source of truth).
  const fileName = path.basename(filePath);
  const content = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseCraftMd(content);
  const craftId = deriveCraftId(fileName, frontmatter);
  // CR-craft-kb-007: an empty craft_id (`.md` filename + no frontmatter id) is
  // a legal TEXT PK and would collide with every other empty-id doc. The scan
  // path (listCraftMdFiles) already filters these, but a direct reindexCraftDoc
  // call (e.g. a targeted watcher event) must also skip + warn, never index.
  if (!craftId) {
    getLogger().warn(
      { filePath },
      'craft reindex: doc derives to an empty craft_id - skipping (no stable PK)',
    );
    return;
  }
  const craftType = frontmatter.craft_type ?? 'uncategorized';
  const name = extractCraftName(body) ?? craftId;
  const bodyText = body;
  // CR-craft-kb-012: persist frontmatter tags (JSON array) + source (provenance).
  const tagsJson = frontmatter.tags ? JSON.stringify(frontmatter.tags) : null;
  const sourceText = frontmatter.source ?? null;

  // 2. Content hash for diff/skip. CR-craft-kb-005: the hash includes the
  //    FRONTMATTER (id / craft_type / source / tags), not just bodyText, so a
  //    frontmatter-only edit (e.g. reclassifying craft_type) triggers a reindex
  //    instead of silently leaving a stale craft_type in closure_craft_entry.
  //    ⚠️ Story 8.7 S1 correction (design §3.1): this payload is a FIXED field
  //    list (NOT the whole frontmatter), so `summary` must be added EXPLICITLY —
  //    a curated-summary-only edit now reindexes too (the stored summary_text +
  //    identity vector must not go stale).
  const hashPayload = JSON.stringify({
    id: craftId,
    craft_type: craftType,
    source: sourceText,
    tags: frontmatter.tags ?? [],
    summary: frontmatter.summary ?? null,
    body: bodyText,
  });
  const hash = createHash('sha256').update(hashPayload).digest('hex');

  // 3. Content-hash skip: body unchanged AND a vector landed -> FTS fresh, vec
  //    preserved. A pending_embed entry (null hash) is retried. `force`
  //    (reindexAllCraft) bypasses the skip on a model/dim swap.
  const existing = db
    .prepare(
      'SELECT content_hash, summary_text, summary_source, summary_hash FROM closure_craft_entry WHERE craft_id=?',
    )
    .get(craftId) as
    | {
        content_hash: string | null;
        summary_text: string | null;
        summary_source: string | null;
        summary_hash: string | null;
      }
    | undefined;
  if (!deps.force && existing?.content_hash === hash) return;

  // 4. Summary resolution (Story 8.7 §3.1) — ASYNC, OUTSIDE any transaction,
  //    best-effort (mirror the embed call): curated frontmatter value → cached
  //    generated value (body-hash fingerprint) → one LLM generate. No model /
  //    failure → columns empty (retrieval unaffected).
  const summary = await resolveDocSummary({
    curated: frontmatter.summary,
    body: bodyText,
    existing,
    resolveModel: resolveSummary,
    generateSummary,
    logLabel: 'craft reindex',
  });

  // 5. Embeds — body + identity dual vector (Story 8.7 §3.2 / design §1.3; craft
  //    docs are all long docs), ASYNC, OUTSIDE any transaction, best-effort.
  //    Mirror closureIndexer model-consistency gate (CR-02): refuse to embed
  //    under a model that differs from the craft KB's prevailing vector-space
  //    model. 两向量同生共死: a failure of EITHER clears both (pending_embed
  //    semantics unchanged).
  let bodyVec: number[] | null = null;
  let identityVec: number[] | null = null;
  let modelId: string | null = null;
  const model = resolveModel();
  const identityText = buildIdentityText(name, craftType, summary.text);

  let modelMismatch = false;
  if (model && bodyText.trim() && !deps.force) {
    const prevailingRow = db
      .prepare('SELECT model FROM closure_craft_entry WHERE model IS NOT NULL LIMIT 1')
      .get() as { model: string } | undefined;
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { craftId, prevailingModel, resolvedModel: model.modelId },
        'craft reindex: model mismatch (prevailing vs resolved) - FTS-only; run reindexAllCraft to migrate',
      );
    }
  }

  if (model && bodyText.trim() && !modelMismatch) {
    try {
      const bodyArr = await embed(model, bodyText);
      if (vecDim !== null && bodyArr.length === vecDim) {
        bodyVec = bodyArr;
      } else {
        getLogger().warn(
          { craftId, expected: vecDim, got: bodyArr.length, model: model.modelId },
          'craft reindex: body embedding dim mismatch - FTS-only',
        );
      }
      if (bodyVec && identityText.trim()) {
        const idArr = await embed(model, identityText);
        if (vecDim !== null && idArr.length === vecDim) {
          identityVec = idArr;
        } else {
          getLogger().warn(
            { craftId, expected: vecDim, got: idArr.length, model: model.modelId },
            'craft reindex: identity embedding dim mismatch - FTS-only',
          );
          bodyVec = null; // all-or-nothing (同生共死)
        }
      }
      if (bodyVec && identityVec) modelId = model.modelId;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), craftId },
        'craft reindex: embed failed - FTS-only',
      );
      bodyVec = null;
      identityVec = null;
    }
  }

  // 6. Single WAL transaction: closure_craft_entry upsert (trigger syncs
  //    closure_craft_fts) + closure_craft_vec delete-then-insert (both vector
  //    kinds). vec0 gated on the sqlite-vec extension being loaded.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO closure_craft_entry
         (craft_id, craft_type, source_kind, name, body_text, tags, source,
          summary_text, summary_source, summary_hash, content_hash, model, dim, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(craft_id) DO UPDATE SET
         craft_type=excluded.craft_type,
         source_kind=excluded.source_kind,
         name=excluded.name,
         body_text=excluded.body_text,
         tags=excluded.tags,
         source=excluded.source,
         summary_text=excluded.summary_text,
         summary_source=excluded.summary_source,
         summary_hash=excluded.summary_hash,
         content_hash=excluded.content_hash,
         model=excluded.model,
         dim=excluded.dim,
         updated_at=datetime('now')`,
    ).run(
      craftId,
      craftType,
      sourceKind,
      name,
      bodyText,
      tagsJson,
      sourceText,
      summary.text,
      summary.source,
      summary.hash,
      // pending_embed: write the hash ONLY when the full vector set landed
      // (mirror CR-03; dual-vector = both vectors, all-or-nothing).
      bodyVec && identityVec ? hash : null,
      modelId,
      bodyVec && identityVec ? bodyVec.length : null,
    );

    // CR-craft-kb-009: ALWAYS delete the existing closure_craft_vec rows for
    // this craft_id (even when the vectors failed / mismatched), THEN insert
    // only when fresh vectors landed. Without the unconditional delete, a
    // transient embed failure on an EDITED doc would leave a stale vector that
    // KNN-matches OLD content JOINed to the NEW body_text just written above.
    // Story 8.7 §1.3: the delete is by craft_id (ALL vector kinds — #body +
    // #identity), the multi-vector PK is vector_id. Gated on the vec extension
    // so a no-vec build skips cleanly.
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(craftId);
      if (bodyVec && identityVec) {
        const insertVec = db.prepare(
          `INSERT INTO closure_craft_vec (vector_id, craft_id, craft_type, source_kind, vector_kind, embedding)
           VALUES (?,?,?,?,?,?)`,
        );
        insertVec.run(
          `${craftId}#body`,
          craftId,
          craftType,
          sourceKind,
          'body',
          floatArrayToBuffer(bodyVec),
        );
        insertVec.run(
          `${craftId}#identity`,
          craftId,
          craftType,
          sourceKind,
          'identity',
          floatArrayToBuffer(identityVec),
        );
      }
    }
  })();
}

/**
 * Remove a craft doc's derived index rows. closure_craft_entry delete fires the
 * AFTER DELETE trigger (clears closure_craft_fts); closure_craft_vec delete is
 * gated on the vec extension and removes ALL of the doc's vector kinds (#body +
 * #identity — Story 8.7 multi-vector, WHERE craft_id covers both rows). Single
 * transaction keeps the three faces consistent.
 */
export function reindexCraftDelete(craftId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=?').run(craftId);
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(craftId);
    }
  })();
}

/**
 * Rebuild the ENTIRE craft vector index under the resolved embedding model
 * (mirror of `reindexAll` - Path B model swap). vec0 dim is fixed at CREATE time;
 * a dim change DROPs + reCREATEs `closure_craft_vec`. Re-embeds every craft doc
 * (force=true bypasses the hash skip). Unlike single-doc `reindexCraftDoc`, this
 * REQUIRES a configured embedding model (the user explicitly asked to switch).
 *
 * E10.2b Wave 2（F-05）：末尾串接 **reindexAllCards sweep**——手艺卡 #claim 向量路在同一
 * DROP+清 hash 点位之后重嵌全部卡（含 pending/rejected——去重面常驻全卡），entry 检索行按卡
 * 状态重建。卡行不能两条路都没有（8.7/10.1 同款教训）：上方结构重建的 `UPDATE ... SET
 * content_hash = NULL WHERE model IS NOT NULL` 天然连带卡 entry 行（同表），sweep 必须在同一次
 * 调用内把重嵌补回。craft KB 零文档但有卡的形态（两百份语料先行蒸馏、未挂任何 doc）：探针
 * 体回退到首个卡 condensed，避免早退把卡 sweep 一并跳过。
 *
 * F1：结构自愈段（探维度 + 缺表/维度不符 → DROP+reCREATE + 清 hash 联动）在「无文件无卡」
 * 早退**之前**跑——craft KB 零文档零卡时 closure_craft_entry 里仍可能住着材料 chunk 行
 * （全局材料车道同表共栖），早退会把整表锁死在旧维度：材料行重嵌全被维度门拒收，「重建
 * Craft KB」永远修不好降级横幅。维度一致且表在 → 零重建零写零清（不做每次空轮 DROP）；
 * 迁移完成后零文件零卡 → 原样早退。代价：空库也走一次探测 embed——维度一致性只能实测。
 *
 * @returns `reindexed` (success count), `dimChanged`, `newDim` (null when no docs and
 *   no structural repair happened), `cardsReembedded` (E10.2b additive — card sweep success count).
 */
export async function reindexAllCraft(
  deps: CraftReindexDeps = {},
): Promise<{
  reindexed: number;
  dimChanged: boolean;
  newDim: number | null;
  cardsReembedded: number;
}> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const resolveSummary = deps.resolveSummaryModel ?? resolveSummaryModel;
  const generateSummary = deps.generateSummary ?? defaultGenerateSummary;
  const db = getDb();

  const model = resolveModel();
  if (!model) {
    throw new Error('reindexAllCraft: no embedding model configured - cannot rebuild vector index');
  }

  const files = listCraftMdFiles();
  const firstCardCondensed = firstCraftCardCondensed();
  const hasInputs = files.length > 0 || firstCardCondensed !== null;

  // Probe the new model's dim by embedding the first non-empty body (E10.2b:
  // fallback to the first card condensed when the craft KB has no docs but
  // cards exist — the sweep still needs a dim-true probe). F1：零文档零卡也照探
  //（'probe' 占位体）——维度自愈不依赖「有东西可重嵌」。
  let probeBody = 'probe';
  for (const f of files) {
    try {
      const content = readFileSync(f.filePath, 'utf-8');
      const { body } = parseCraftMd(content);
      if (body.trim()) {
        probeBody = body;
        break;
      }
    } catch {
      // skip unreadable file
    }
  }
  if (probeBody === 'probe' && firstCardCondensed !== null) {
    probeBody = firstCardCondensed;
  }
  let newDim: number;
  try {
    const probeVec = await embed(model, probeBody);
    newDim = probeVec.length;
  } catch (err) {
    throw new Error(
      `reindexAllCraft: embedding probe failed - cannot determine new model dim: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Dim change -> DROP + reCREATE closure_craft_vec at the new dim. CR-craft-kb-010:
  // ALSO recreate when the vec table is ABSENT while sqlite-vec IS loaded
  // (currentDim===null). Previously the DROP+CREATE branch only ran when
  // `currentDim !== null`, so a missing vec table (e.g. sqlite-vec loaded after
  // the table was never created, or a prior DROP without reCREATE) was never
  // rebuilt -> reindexAllCraft silently completed FTS-only. Recreate at the probe
  // dim so the subsequent per-doc reindex lands vectors.
  //
  // ⚠️ Story 8.7 S4 (implement.md S2 coordination note): the inline CREATE MUST
  // stay field-identical to initSchema's multi-vector DDL (vector_id PK /
  // craft_id / craft_type / source_kind / vector_kind). A stale single-vector
  // CREATE here would flip-flop with the initSchema migration and silently drop
  // all vectors on every rebuild. `getCurrentCraftVecDim`'s float[N] parsing is
  // structure-agnostic (unchanged).
  const currentDim = getCurrentCraftVecDim(db);
  const vecAvailable = isSqliteVecAvailable();
  const dimChanged = vecAvailable && currentDim !== null && newDim !== currentDim;
  const vecMissing = vecAvailable && currentDim === null;
  if (dimChanged || vecMissing) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS closure_craft_vec');
      db.exec(
        `CREATE VIRTUAL TABLE closure_craft_vec USING vec0(
          vector_id TEXT PRIMARY KEY,
          craft_id TEXT,
          craft_type TEXT,
          source_kind TEXT,
          vector_kind TEXT,
          embedding float[${newDim}] distance_metric=cosine
        )`,
      );
      // Story 10.1 Wave C（E1 同款教训）：结构 DROP 重建 = 全部既有向量丢失（vec0 无导出/
      // 导入路径）。同步把「有向量记账」的行（model IS NOT NULL）content_hash 清 NULL——
      // pending_embed 语义，下次 reindex NULL !== hash 即触发重嵌补回。不清则 hash-skip
      // 永久阻断重嵌：向量静默丢失（FTS-only 降质无提示）。⚠️ UPDATE 天然**连带材料行**
      // （source_kind='material_chunk'）——本函数只重灌 craft 文档，材料行不随 files 枚举
      // 重嵌，hash 不清则材料向量在 craft 模型迁移后永久丢失（materialIndexer 的重索引/
      // rebuild 路径以 NULL 语义重试补回）。mirror initSchema entry_vec 迁移点同款 UPDATE
      // （两处同步纪律）。成对事务包裹（mirror identity_backfill 多语句迁移先例）。
      db.exec('UPDATE closure_craft_entry SET content_hash = NULL WHERE model IS NOT NULL');
    })();
    getLogger().info(
      { oldDim: currentDim, newDim, reason: vecMissing ? 'missing-recreate' : 'dim-change' },
      'craft reindexAllCraft: closure_craft_vec recreated',
    );
  }

  // F1：无输入早退挪到结构自愈段之后。零文档零卡 + 结构段无事可做 → 原样返回（零写零清）；
  // 结构段刚修复（换维度重建/缺表补建）→ 如实回报结构事件。reindexed 恒 0——craft 文档一枚
  // 都没枚举到；材料 chunk / 卡行的补嵌走各自车道（backfill / 卡 sweep 触发点），不并入本计数。
  if (!hasInputs) {
    const repaired = dimChanged || vecMissing;
    return {
      reindexed: 0,
      dimChanged: repaired,
      newDim: repaired ? newDim : null,
      cardsReembedded: 0,
    };
  }

  // Re-embed every craft doc (force=true bypasses the hash skip — body unchanged
  // but the dual vectors must regenerate under the new model; the summary
  // fingerprint cache still suppresses redundant summary LLM calls).
  let reindexed = 0;
  for (const { filePath, sourceKind } of files) {
    try {
      await reindexCraftDoc(filePath, sourceKind, {
        resolveModel: () => model,
        embed,
        resolveSummaryModel: resolveSummary,
        generateSummary,
        force: true,
      });
      reindexed++;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'craft reindexAllCraft: per-doc reindex failed - continuing',
      );
    }
  }

  // E10.2b Wave 2（F-05）：卡 sweep 同点位收尾——DROP+清 hash 已连带卡 entry 行（同表
  // UPDATE），此处按 #claim 路重嵌全部卡 + entry 行按卡状态重建（verified 重写 / 其余
  // 清检索面）。恒 force 语义（sweep 即迁移本身）；per-card 容错 mirror 上方 per-doc 循环。
  let cardsReembedded = 0;
  try {
    cardsReembedded = await reindexAllCards({ resolveModel: () => model, embed });
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'craft reindexAllCraft: card sweep failed - continuing (docs rebuilt)',
    );
  }

  return { reindexed, dimChanged, newDim, cardsReembedded };
}

/**
 * Scan both craft KB dirs (bundled + user, user-priority merge), diff against the
 * indexed set, and incrementally reindex new/changed docs + delete orphans
 * (mirror of the on-save reindex hook, but for the global craft dir). Best-effort:
 * per-doc failures are logged + skipped so one bad doc never aborts the scan.
 * Called fire-and-forget on app startup (never block app launch on a reindex).
 */
export async function scanAndReindexCraftKb(deps?: CraftReindexDeps): Promise<void> {
  const db = getDb();
  const files = listCraftMdFiles();
  const scannedCraftIds = new Set(files.map((f) => f.craftId));

  // Delete orphans: indexed craft_ids no longer present on disk.
  // ⚠️ Story 10.1 Wave C（F-01）：closure_craft_entry 现与材料 chunk 行同表共存
  // （source_kind='material_chunk'，materialIndexer 写入，craft_id = `mat:...` 不在
  // craft KB 扫描集内）。orphan 枚举/删除谓词必须排除它们——否则每次启动扫描/重扫会把
  // 材料索引当 orphan 全删。**用 `!= 'material_chunk'` 而非 `= 'craft_md'`**：生产
  // source_kind 值域是 'bundled'|'user'（reindexCraftDoc 写入侧），'craft_md' 仅是 schema
  // DEFAULT 零行持有——`= 'craft_md'` 会清不掉任何行；`!=` 排除式对未来 craft kind 也稳
  // （新 craft kind 仍由本扫描管理）。
  // ⚠️ E10.2b Wave 2（F-01 三犯防御）：手艺卡 entry 行（source_kind='craft_card'，craft_id =
  // `card:...` 前缀，卡 repository 写入）同不在此扫描的领地——卡行生命周期归卡索引器（verify 写/
  // reject 删/降级删）。**排除式值域同步扩**：NOT IN ('material_chunk','craft_card')。卡行是
  // db 真相源的派生检索面（无盘上文件对应），按「不在扫描集」判 orphan 会把已核卡的检索行
  // 在每次启动时全删（8.7/10.1 同款教训第三犯防御，值域按生产写点核实在先）。
  let indexed: Array<{ craft_id: string }>;
  try {
    indexed = db
      .prepare(
        "SELECT craft_id FROM closure_craft_entry WHERE source_kind NOT IN ('material_chunk','craft_card')",
      )
      .all() as Array<{ craft_id: string }>;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'craft KB scan: cannot enumerate indexed docs - skipping orphan cleanup',
    );
    indexed = [];
  }
  for (const { craft_id } of indexed) {
    if (!scannedCraftIds.has(craft_id)) {
      try {
        reindexCraftDelete(craft_id);
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), craftId: craft_id },
          'craft KB scan: orphan delete failed - continuing',
        );
      }
    }
  }

  // Reindex new/changed docs (hash-skip makes unchanged docs a no-op).
  for (const { filePath, sourceKind } of files) {
    try {
      await reindexCraftDoc(filePath, sourceKind, deps);
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'craft KB scan: reindex failed - continuing',
      );
    }
  }
}

// Re-export EMBED_DIM for craft tests that build unit 1024-dim vectors (mirror
// closureIndexer.EMBED_DIM usage in closureRetrieval.test.ts).
export { EMBED_DIM };
