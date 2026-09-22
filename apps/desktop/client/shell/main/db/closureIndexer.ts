import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

/**
 * Closure KB on-save reindex indexer (ADR-3 / VS1 R3/AC3).
 *
 * Materializes the derived retrieval index (`closure_entry` + `entry_fts` +
 * `entry_vec`) from a `project_assets` row. The closure-* tables are a DERIVED
 * query/retrieval face — `project_assets` / `project.yaml` remain source of
 * truth — so this whole module can be disabled / its tables dropped and fully
 * rebuilt at any time (design §7 rollback).
 *
 * Layering (design §1): the reindex hook lives at the IPC handler layer
 * (`assetIpc.ts`), NOT inside `assetRepository`. `assetRepository` is a pure
 * SYNC db writer; embedding is ASYNC (HTTP). Keeping the embed/transaction
 * orchestration here keeps assetRepository synchronous and lets the IPC handler
 * `await` the reindex so the asset is queryable the moment the handler returns
 * (deterministic for tests/e2e).
 *
 * Crash-consistency (gate G3 "崩溃不分叉"): the embed call (network, ~1s) runs
 * OUTSIDE any SQLite transaction. Only the closure_* writes are wrapped in a
 * single WAL transaction. So a crash mid-embed writes nothing (the old entry is
 * intact); a crash mid-txn atomically rolls back. closure_entry + entry_fts +
 * entry_vec stay consistent WITH EACH OTHER — not with project_assets, which is
 * a separate, rebuildable concern.
 */

/** Embedding dimensionality matched by the entry_vec vec0 schema (float[1024]). */
export const EMBED_DIM = 1024;

/**
 * Parse the vec0 embedding dimension from an `entry_vec` CREATE statement.
 *
 * vec0 dims are fixed at CREATE time (`embedding float[N]`) and have no ALTER
 * path (research `embedding-model-swap-compatibility-2026-07-23.md` §1). Path B
 * (R7/AC7) DROPs + reCREATEs `entry_vec` at a new dim on a model swap, so the
 * "current" dim is whatever the live CREATE statement says - not a hardcoded
 * constant. This pure helper is split out so it is unit-testable without a DB.
 *
 * @returns the parsed dim, or `null` when the statement is absent / has no
 *   `float[N]` column (e.g. the table does not exist, or uses a non-float col).
 */
export function parseVecDimFromSql(sql: string | null | undefined): number | null {
  if (!sql) return null;
  const m = sql.match(/float\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

/**
 * Read the current `entry_vec` embedding dimension from the live schema
 * (`sqlite_master.sql` contains the `CREATE VIRTUAL TABLE ... float[N]`).
 *
 * @returns the current dim, or `null` when `entry_vec` does not exist (the vec
 *   extension did not load, or the table has not been created yet). Callers use
 *   `null` to mean "no vector arm" - a re-created `float[newDim]` table is
 *   respected without restarting the process. Cheap (`sqlite_master` is an
 *   in-memory system table, single row) and called rarely relative to the embed
 *   API cost, so no caching.
 */
export function getCurrentVecDim(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_vec'")
    .get() as { sql: string | null } | undefined;
  return parseVecDimFromSql(row?.sql);
}

/**
 * Ensure the `entry_vec` vec0 table exists at `newDim` (idempotent, Story 2.7 F2
 * / BLIND-3=ACCEPT-3). Extracted from `reindexAll`'s inline DROP+reCREATE so the
 * asset_cards indexer can share it: a pure-card project (no project_assets) makes
 * `reindexAll` early-return before its dim probe, so a dim-change model swap would
 * leave `entry_vec` at the OLD dim and degrade every card re-embed to FTS-only
 * (the dim-mismatch guard in `reindexAssetCard`). `reindexAssetCards` probes the
 * resolved model's dim and calls this helper before its per-card loop so the
 * table is rebuilt at the new dim.
 *
 * - `currentDim === newDim` -> no-op (already at the right dim).
 * - `currentDim !== newDim` (different, INCLUDING `currentDim===null` = table
 *   absent while sqlite-vec IS loaded) -> DROP + reCREATE at `newDim`. Mirrors
 *   `closureCraftIndexer.reindexAllCraft`'s `vecMissing` path: a missing vec
 *   table under a loaded extension is rebuilt, not left FTS-only.
 *
 * vec0 dim is TABLE-LEVEL (not per-partition), so a recreate is a GLOBAL event:
 * ALL projects' vectors are dropped (VS1 is single-project; other projects need
 * their own `reindexAll`). Idempotent so the GAP2 sweep (`reindexAll` then
 * `reindexAssetCards` on the same project) does NOT double-DROP.
 *
 * @returns true when `entry_vec` was (re)created at `newDim`; false when it was
 *   already at `newDim` (no-op) or sqlite-vec is unavailable (no vec arm).
 */
export function ensureEntryVecDim(db: Database.Database, newDim: number): boolean {
  if (!isSqliteVecAvailable()) return false;
  const currentDim = getCurrentVecDim(db);
  if (currentDim === newDim) return false;
  db.exec('DROP TABLE IF EXISTS entry_vec');
  // ⚠️ 三处同步纪律（8.7 S10 flip-flop 教训）：this inline CREATE MUST stay field-identical
  // to initSchema's entry_vec DDL — as of Story 8.3 that is: vector_id PK / project_id
  // partition / entry_id / entry_type / source_kind / vector_kind / status / visibility
  // (CR-005 metadata columns) / embedding float[N]. A stale CREATE here (e.g. missing the
  // metadata columns) would flip-flop with the initSchema old-structure detection (which
  // drops tables lacking `status TEXT`) and silently drop all vectors on every rebuild.
  // `getCurrentVecDim`'s float[N] parsing is structure-agnostic (unchanged).
  // NOTE: closure_craft_vec deliberately does NOT gain status/visibility (craft has no
  // status concept + no such filter face) — its two CREATE sites stay at the 8.7 shape.
  db.exec(
    `CREATE VIRTUAL TABLE entry_vec USING vec0(
      vector_id TEXT PRIMARY KEY,
      project_id TEXT partition key,
      entry_id TEXT,
      entry_type TEXT,
      source_kind TEXT,
      vector_kind TEXT,
      status TEXT,
      visibility TEXT,
      embedding float[${newDim}] distance_metric=cosine
    )`,
  );
  // E1（CR 2026-08-20）：dim 重建同样是「全部既有向量丢失」事件（vec0 dim 是表级——**全项目**
  // 向量一并 DROP，不只本 reindexAll 的项目）。同步清 model 行 content_hash（NULL = pending_embed
  // 语义，下次 reindex 重嵌补回）——不清则 hash-skip 永久阻断重嵌，未参与本次 rebuild 的项目
  // 向量静默丢失。⚠️ 与 initSchema 的旧结构迁移点同款 UPDATE——两处同步纪律。
  db.exec('UPDATE closure_entry SET content_hash = NULL WHERE model IS NOT NULL');
  getLogger().info(
    { oldDim: currentDim, newDim },
    "closure entry_vec (re)created at new dim (all projects' vectors dropped)",
  );
  return true;
}

/**
 * Materialize the queryable/embeddable body text from a project_assets row.
 *
 * project_assets has NO `details` column — design §3's "summary+details" is, in
 * the fork's actual schema, name+summary. Body = name + '\n' + summary, skipping
 * empty parts. Exported for unit testing.
 */
export function materializeBody(name: string | null, summary: string | null): string {
  return [name, summary].filter((s): s is string => Boolean(s)).join('\n');
}

/**
 * Encode a float array as a little-endian Buffer of 32-bit floats — the vec0
 * embedding column encoding (mirrors the closureSchema vec0 insert + the
 * phase-0 spike's `f32Blob`). Exported for unit testing (round-trip).
 */
export function floatArrayToBuffer(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
  return buf;
}

/**
 * Dependency-injection seam (ADR-2 "全注入"). Tests pass stubs so the DB
 * integration suite runs (under the Electron ABI) with ZERO network — no real
 * embed endpoint is hit. Production callers omit `deps` and get the real
 * `resolveEmbeddingModel` + `generateEmbeddings`.
 */
export type ReindexDeps = {
  /** Resolve the embedding model; null → FTS-only (pending_embed). Defaults to resolveEmbeddingModel. */
  resolveModel?: () => ResolvedModel | null;
  /** Embed a single body string → vector. Defaults to a generateEmbeddings wrapper. */
  embed?: (model: ResolvedModel, body: string) => Promise<number[]>;
  /**
   * Bypass the content-hash skip so the asset is re-embedded + re-written even
   * when the body is unchanged. Used by `reindexAll` on a (model,dim) swap
   * (R7/AC7): the body text is identical but the vectors must be regenerated
   * under the new embedding model, so the hash-skip must NOT fire. Default
   * `false` - the on-save reindex path stays hash-skipping (avoids re-embedding
   * unchanged assets on every save).
   */
  force?: boolean;
};

/**
 * Pure predicate (CR-02): should the on-save reindex skip embedding because the
 * resolved model differs from the project's prevailing vector-space model?
 * Extracted from `reindexAsset` so the gate decision is unit-testable without a
 * DB. Returns true ONLY when there IS a prevailing model AND it differs from the
 * resolved one — a project with no embedded entries yet has no prevailing model,
 * so the first embed is always allowed. `reindexAll` bypasses this gate entirely
 * via `deps.force` (it IS the authorized migration that flips the prevailing).
 *
 * @param prevailingModel  the project's first embedded entry's model (its vector
 *   space), or null when no entry has been embedded yet.
 * @param resolvedModelId  the model the current reindexAsset would embed under.
 */
export function shouldSkipForModelMismatch(
  prevailingModel: string | null,
  resolvedModelId: string,
): boolean {
  return prevailingModel !== null && prevailingModel !== resolvedModelId;
}

/**
 * Default embed: one generateEmbeddings call, return the first vector.
 *
 * CR-06: a 30s AbortSignal.timeout guards the call. A hung embed endpoint must
 * not hang the asset save forever — the timeout rejection lands in reindexAsset's
 * existing try/catch (logs + FTS-only degradation). 30s is generous for a single
 * short body embed. AbortSignal.timeout is available in Node 18+ / Electron.
 */
async function defaultEmbed(model: ResolvedModel, body: string): Promise<number[]> {
  // C3.1 计量台账：taskType 走 ctx 通道（embed wrapper 落列）——story KB 索引重嵌标签。
  const res = await generateEmbeddings(model, { input: [body] }, { signal: AbortSignal.timeout(30_000), taskType: 'kb-index-embed' });
  return res.embeddings[0] ?? [];
}

/**
 * Reindex a single asset into the derived closure_* index. Idempotent and
 * content-hash aware: an unchanged body is a no-op (FTS already fresh, vec
 * state preserved). Best-effort embedding: no model / failure / dim-mismatch →
 * FTS-only (pending_embed). Never throws on embed failure (logs + degrades);
 * db write errors propagate.
 */
export async function reindexAsset(
  projectId: string,
  assetId: string,
  deps: ReindexDeps = {},
): Promise<void> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const db = getDb();
  // Current entry_vec dim (null when the table is absent - vec extension not
  // loaded, or not yet created). Read once per call so a re-created
  // float[newDim] table (reindexAll, R7/AC7) is respected without restarting
  // the process; replaces the hardcoded EMBED_DIM in the runtime dim check.
  const vecDim = getCurrentVecDim(db);

  // 1. Read canonical row from project_assets (source of truth).
  const row = db
    .prepare(
      'SELECT asset_name, summary, asset_type FROM project_assets WHERE project_id=? AND asset_id=?',
    )
    .get(projectId, assetId) as
    | { asset_name: string; summary: string | null; asset_type: string }
    | undefined;

  // If the asset row is gone, it was deleted before reindex ran — delegate to
  // the delete path so the derived index has no orphan closure_entry.
  if (!row) {
    await reindexAssetDelete(projectId, assetId);
    return;
  }

  // 2. Materialize body (name + summary; project_assets has no details column).
  const body = materializeBody(row.asset_name, row.summary);
  // 3. Content hash for diff/skip. Story 8.3 hashPayload 核实：body-only 仍然完备——
  //    asset_card 行物化进 entry_vec 的 metadata 里没有源数据派生字段（status 在
  //    closure_entry 侧就是 NULL——project_assets 不物化卡状态，vec 侧写 '' sentinel；
  //    visibility 是硬编码 'known' 常量非源数据），无可 stale 的维度，无需扩 hash。
  const hash = createHash('sha256').update(body).digest('hex');

  // 4. Content-hash skip: body unchanged AND a vector landed → FTS already
  //    fresh, vec preserved. A pending_embed entry (CR-03) has content_hash
  //    NULL, so NULL !== hash → no skip → the embed is retried (e.g. after a
  //    model becomes available via reindexAll, or a later on-save). `deps.force`
  //    (reindexAll, R7/AC7) bypasses the skip: the body is unchanged on a
  //    model/dim swap, but the vectors MUST regenerate under the new model.
  const existing = db
    .prepare('SELECT content_hash FROM closure_entry WHERE entry_id=?')
    .get(assetId) as { content_hash: string | null } | undefined;
  if (!deps.force && existing?.content_hash === hash) return;

  // 5. Embed — ASYNC, OUTSIDE any transaction, best-effort. vec stays null on
  //    no-model / failure / dim-mismatch / model-mismatch → FTS-only
  //    (pending_embed). A future reindex-all (阶段7) backfills the vector when a
  //    model becomes available.
  let vec: number[] | null = null;
  let modelId: string | null = null;
  const model = resolveModel();

  // CR-02 model-consistency gate (defense-in-depth): refuse to embed under a
  // model that differs from the project's prevailing vector-space model — mixing
  // models in one vec0 table corrupts similarity (research
  // `embedding-model-swap-compatibility-2026-07-23.md` §2.4: different models
  // live in different geometric spaces even at the same dim). The prevailing
  // model is the first embedded entry's model (the project's vector space).
  // Bypassed by `deps.force`: reindexAll (R7/AC7) is the AUTHORIZED migration
  // that re-embeds everything under the new model and flips the prevailing model
  // — the gate must not block it (else the first migrated asset would see the
  // old prevailing model and refuse, stalling the whole rebuild).
  let modelMismatch = false;
  if (model && body.trim() && !deps.force) {
    const prevailingRow = db
      .prepare('SELECT model FROM closure_entry WHERE project_id=? AND model IS NOT NULL LIMIT 1')
      .get(projectId) as { model: string } | undefined;
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { assetId, prevailingModel, resolvedModel: model.modelId },
        'closure reindex: model mismatch (prevailing vs resolved) — FTS-only; run reindexAll to migrate',
      );
    }
  }

  if (model && body.trim() && !modelMismatch) {
    try {
      const vecArr = await embed(model, body);
      if (vecDim !== null && vecArr.length === vecDim) {
        vec = vecArr;
        modelId = model.modelId;
      } else {
        getLogger().warn(
          { assetId, expected: vecDim, got: vecArr.length, model: model.modelId },
          'closure reindex: embedding dim mismatch — FTS-only',
        );
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), assetId },
        'closure reindex: embed failed — FTS-only',
      );
    }
  }

  // 6. Single WAL transaction: closure_entry upsert (trigger syncs entry_fts) +
  //    entry_vec delete-then-insert (vec0 has no clean ON CONFLICT upsert). vec0
  //    is also gated on the sqlite-vec extension actually being loaded.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, content_hash, model, dim, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(entry_id) DO UPDATE SET
         entry_type=excluded.entry_type,
         name=excluded.name,
         body_text=excluded.body_text,
         content_hash=excluded.content_hash,
         model=excluded.model,
         dim=excluded.dim,
         updated_at=datetime('now')`,
    ).run(
      assetId,
      projectId,
      row.asset_type,
      'asset_card',
      row.asset_name,
      body,
      'known',
      // CR-03: write the body content_hash ONLY when a vector landed. A null
      // hash (vec null: no model / embed failed / dim or model mismatch) marks
      // the entry pending_embed — the next reindexAsset sees
      // existing.content_hash (NULL) !== hash and retries the embed. The body
      // text + FTS index are still written (trigger fires), so FTS search works
      // immediately; only the hash is withheld until a vector succeeds. An asset
      // that DID embed keeps its hash and is skipped on an unchanged body
      // (complete). `deps.force` bypasses the skip regardless (reindexAll always
      // re-runs).
      vec ? hash : null,
      modelId,
      vec ? vec.length : null,
    );

    if (vec && isSqliteVecAvailable()) {
      const vecBuf = floatArrayToBuffer(vec);
      // vec0 has no ON CONFLICT upsert; delete-then-insert keeps it idempotent.
      // Story 8.7 §1.3: asset_card rows are CARD-type entries — single #body
      // vector only (the materialized body already contains name+summary, an
      // identity vector would be pure redundancy). vector_id is the multi-vector
      // PK; the entry_id column is the reverse-lookup JOIN key.
      // Story 8.3 CR-005: status/visibility are now vec0 metadata columns (KNN
      // pre-pruning, design §4) and MUST mirror the values this row writes to
      // closure_entry — the KNN filter and the final closure_entry WHERE belt
      // (c.status = ?) must agree or pre-pruning would drop hits the belt keeps
      // (or surface rows the belt drops). asset_card rows write NO closure_entry
      // status (NULL — project_assets file assets carry no closure card-status
      // materialization, Story 8.7 §1.2 "cards only"), so the vec metadata gets
      // the EMPTY-STRING sentinel: vec0 TEXT metadata columns REJECT NULL
      // (probe-proven), and '' behaves like SQL NULL under `= 'value'` (never
      // matches a concrete filter). visibility is the same 'known' literal the
      // closure_entry INSERT writes.
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(assetId);
      db.prepare(
        `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        // S10 fix: S4 multi-vector rewrite had swapped these two binds (project_id received
        // assetId and vice versa) — masked until the FK-fixture repair let KNN assertions
        // actually run. Correct order: vector_id, project_id, entry_id, ...
      ).run(`${assetId}#body`, projectId, assetId, row.asset_type, 'asset_card', 'body', '', 'known', vecBuf);
    }
  })();
}

/**
 * Remove an asset's derived index rows. closure_entry delete fires the AFTER
 * DELETE trigger (clears entry_fts); entry_vec delete is gated on the vec
 * extension. Wrapped in a single transaction so the three derived faces stay
 * consistent. entry_id is the PK of both closure_entry and entry_vec, so it
 * uniquely identifies the rows (projectId is unused by the DELETEs but kept in
 * the signature for symmetry with reindexAsset).
 */
export async function reindexAssetDelete(projectId: string, assetId: string): Promise<void> {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM closure_entry WHERE entry_id=?').run(assetId);
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(assetId);
    }
  })();
}

/**
 * Rebuild the ENTIRE derived vector index for a project under the resolved
 * embedding model (ADR-3 / VS1 R7/AC7 - Path B model swap).
 *
 * Path B (research `embedding-model-swap-compatibility-2026-07-23.md`): vec0 dim
 * is fixed at CREATE time and has no ALTER path; a different model's vectors
 * live in a different geometric space even at the same dim. So a model swap
 * ALWAYS requires a full re-embed, and a dim change ADDITIONALLY requires DROP +
 * reCREATE of `entry_vec` at the new dim. Because vec0 is brute-force (no ANN
 * graph to rebuild) and a model swap already forces a full re-embed, the
 * drop+recreate is ~zero marginal cost (dominated by the embed API calls).
 * Source of truth (`project_assets` / `project.yaml`) is never touched - the
 * derived index is fully rebuildable from it.
 *
 * Unlike single-asset `reindexAsset`, reindexAll REQUIRES a configured embedding
 * model: its whole purpose is re-embedding, so FTS-only degradation is NOT an
 * acceptable outcome here (the user explicitly asked to switch models). Callers
 * (smoke / future IPC, design §8 scope fence) catch + surface the thrown Error.
 *
 * VS1 is single-project. NOTE: a dim change DROPs `entry_vec` GLOBALLY (vec0 dim
 * is table-level, not per-partition), so OTHER projects' vectors are lost and
 * would need their own `reindexAll`. The per-dim vec0 table + indexer routing is
 * a downstream interface (design §8); VS1 ships a single table.
 *
 * @returns `reindexed` (success count), `dimChanged` (entry_vec was recreated at
 *   a new dim), and `newDim` (the probed model dim; null only when the project
 *   has no assets to probe).
 */
export async function reindexAll(
  projectId: string,
  deps: ReindexDeps = {},
): Promise<{ reindexed: number; dimChanged: boolean; newDim: number | null }> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const db = getDb();

  // 1. A model swap requires a model. Unlike single-asset reindex, FTS-only
  //    degradation is NOT acceptable here - the user explicitly asked to switch.
  const model = resolveModel();
  if (!model) {
    throw new Error('reindexAll: no embedding model configured - cannot rebuild vector index');
  }

  // 2. Read every asset for the project (source of truth). FKs are not enforced
  //    in this engine, but project_id scoping is still correct for the rebuild.
  const rows = db
    .prepare('SELECT asset_id, asset_name, summary FROM project_assets WHERE project_id=?')
    .all(projectId) as Array<{ asset_id: string; asset_name: string; summary: string | null }>;

  if (rows.length === 0) {
    return { reindexed: 0, dimChanged: false, newDim: null };
  }

  // 3. Probe the new model's output dim by embedding the first non-empty body.
  //    The content is irrelevant - any non-empty text yields the model's native
  //    dim, which is all we need to detect a dim change.
  const probeBody =
    rows.map((r) => materializeBody(r.asset_name, r.summary)).find((b) => b.trim()) ?? 'probe';
  let newDim: number;
  try {
    const probeVec = await embed(model, probeBody);
    newDim = probeVec.length;
  } catch (err) {
    throw new Error(
      `reindexAll: embedding probe failed - cannot determine new model dim: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 4. Ensure entry_vec exists at the probed dim (idempotent). vec0 dim is
  //    table-level (not per-partition), so a recreate is a GLOBAL event: ALL
  //    projects' vectors are dropped. VS1 is single-project; other projects
  //    would need their own reindexAll (downstream per-dim routing, design §8).
  //    Extracted to `ensureEntryVecDim` (Story 2.7 F2) so the asset_cards indexer
  //    shares it - a pure-card project never reaches this point (rows.length===0
  //    early-return above), so reindexAssetCards does its own dim probe + calls
  //    the same helper. Idempotent: no-op when the dim already matches.
  const dimChanged = ensureEntryVecDim(db, newDim);

  // 5. Re-embed every asset. `force` (default true — the model-swap migration
  //    semantics this function was built for) bypasses the content-hash skip
  //    (body unchanged but vectors must regenerate under the new model).
  //    dogfood #39 (T2 C1): `deps.force === false` opts into a backfill pass —
  //    the startup reconcile uses it when ONLY a pending backlog exists (models
  //    already match): healthy rows hash-skip at zero cost, pending rows retry.
  //    reindexAsset uses the dynamic dim check (getCurrentVecDim), so it accepts
  //    the new dim and writes closure_entry.model/dim + entry_vec at the new dim.
  //    A per-asset failure (rare: db write error) is logged + skipped so one bad
  //    row never aborts the whole rebuild; successes are counted.
  let reindexed = 0;
  for (const { asset_id } of rows) {
    try {
      await reindexAsset(projectId, asset_id, {
        resolveModel: () => model,
        embed,
        force: deps.force !== false,
      });
      reindexed++;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectId, assetId: asset_id },
        'closure reindexAll: per-asset reindex failed - continuing',
      );
    }
  }

  return { reindexed, dimChanged, newDim };
}
