import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import {
  type ReindexDeps,
  floatArrayToBuffer,
  shouldSkipForModelMismatch,
  getCurrentVecDim,
  ensureEntryVecDim,
} from './closureIndexer';
import { getProject } from './projectRepository';
import { reindexRelationGraph } from './relationIndexer';
import { reindexForeshadowRegistry } from './foreshadowIndexer';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

/**
 * Asset-cards derived reindex indexer (ADR-3 / Story 2.7). Mirrors `closureIndexer`
 * (project_assets) + `closureCraftIndexer` (craft docs) for the per-project
 * `asset_cards` creative field (Story 2.4 typed card model). Source of truth =
 * `<project>/project.yaml` `asset_cards` field; `closure_entry` / `entry_fts` /
 * `entry_vec` are a DERIVED query/retrieval face that can be dropped + rebuilt from
 * the yaml at any time.
 *
 * Differences from closureIndexer (project_assets): source is a project.yaml
 * creative field (NOT a `project_assets` SQLite row); projectId is the REGISTRY
 * project_id (5-digit, resolved via `getProject(path)` — the SAME namespace
 * `reindexAsset` / `query_story` use, NOT `project.yaml meta.id` which is a UUID
 * in a different namespace and would hide cards from query_story); body is
 * materialized by flattening the 8-class typed card fields (KB §4.2 one-card-one-
 * chunk); source_kind = `'setting_card'` distinguishes these rows from
 * project_assets' `'asset_card'` (same closure_entry table, single-lib JOIN
 * preserved). The crash-consistency contract (gate G3) is identical to the sibling
 * indexers: embed runs OUTSIDE any txn, only the closure_* writes are wrapped in a
 * single WAL transaction.
 */

/** AssetCard union type (8 typed variants, Story 2.4). Structural shape mirroring
 *  `assetCardSchema`'s base (id/type/name/summary/details/tags); the per-type
 *  field groups are iterated generically via the `Record<string, unknown>` cast in
 *  `materializeAssetCardBody`, so a discriminated-union import is unnecessary (and
 *  avoids a direct zod dep in the shell package). Source of truth = shared-contracts
 *  `assetCardSchema`; `loadProject` already validates before this layer sees a card. */
type AssetCard = {
  id: string;
  type: string;
  name: string;
  summary?: string;
  details?: Record<string, unknown> | null;
  tags?: string[];
  /** Lifecycle status (Story 8.7 §1.2 materialization; schema-defaulted
   *  'draft' — creative-fields.ts assetCardStatusSchema, always present on a
   *  loadProject-validated doc). Structural mirror — not re-validated here. */
  status?: string;
  [key: string]: unknown;
};

/**
 * `source_kind` value for asset_cards rows. Distinguishes them from project_assets
 * rows (`'asset_card'`) in the shared `closure_entry` / `entry_vec` tables. The
 * retrieval funnel does NOT filter by source_kind (VS1 design §8 reserves it as a
 * provenance mechanism); it exists so the KB index management page (B段) can count
 * the two populations separately and so a future chapter-text source (`'chapter'`)
 * does not collide. Naming collision with `'asset_card'` is intentional-but-named:
 * `asset_card` = OrisonSpace file asset (image etc.), `setting_card` = Closure
 * setting card (character/location/.../golden_finger).
 */
export const ASSET_CARD_SOURCE_KIND = 'setting_card';

/** Keys already emitted as headline lines or handled as structural refs (not
 *  flattened into the generic typed-field body). */
const STRUCTURAL_SKIP = new Set([
  'id', // PK, not prose
  'type', // entry_type filter dimension, not body prose
  'name', // headline (emitted first)
  'summary', // headline (emitted second)
  'tags', // free-text tail (emitted last as a labeled line)
  'details', // customFields — flattened separately after typed fields
  'status', // lifecycle, not prose
  'firstAppearance', // structural ref, not prose
  'sourceRefs', // structural refs, not prose
  'relationships', // → relationship_graph (ADR-1 separate concern), not body prose
]);

/**
 * Recursively flatten a value into non-empty scalar leaf lines. Strings are
 * trimmed; empty strings / null / undefined are dropped; numbers + booleans are
 * stringified; arrays + plain objects are descended into. Used to turn a typed
 * card's nested field groups (personality / mechanics / truth / ... + the 4 public
 * sub-schemas + customFields) into one searchable body blob (KB §4.2).
 */
function flattenNonEmptyScalars(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? [t] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((v) => flattenNonEmptyScalars(v));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) => flattenNonEmptyScalars(v));
  }
  return [];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim());
}

/**
 * Materialize the queryable / embeddable body text from a setting card (KB §4.2
 * one-card-one-chunk: name + summary + typed fields + customFields + aliases + tags).
 *
 * Composition (R3):
 * 1. `name` (always) + `summary` (if present) — the headline.
 * 2. All typed field groups (per-type fields + the 4 public sub-schemas
 *    narrative / writingCheatSheet / secrets / worldAndCanon) — recursively
 *    flattened non-empty scalar leaves. `basics.aliases` (character / location /
 *    prop / organization / golden_finger) lands here as flattened strings, so an
 *    alias is FTS/embedding-discoverable (entity search "德狗子" hits the card).
 * 3. `details` (customFields first-class edit freedom, Story 2.4) — flattened.
 * 4. `tags` — joined into one labeled free-text line (searchable via FTS; NOT a
 *    structured filter dimension — card.tags has no design / no consumer, KB §3
 *    entry_tag M2M has no story claiming it, so a tag-as-body FTS path satisfies
 *    "搜得到" with zero schema).
 *
 * Pure + exported for unit testing (8-class flatten + missing-field tolerance).
 */
export function materializeAssetCardBody(card: AssetCard): string {
  const lines: string[] = [];
  if (card.name?.trim()) lines.push(card.name.trim());
  if (card.summary?.trim()) lines.push(card.summary.trim());

  const record = card as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (STRUCTURAL_SKIP.has(key)) continue;
    lines.push(...flattenNonEmptyScalars(record[key]));
  }
  if (card.details) lines.push(...flattenNonEmptyScalars(card.details));

  const tags = readStringArray(card.tags);
  if (tags.length) lines.push(`标签：${tags.join(' / ')}`);

  return lines.join('\n');
}

/**
 * Default embed: one generateEmbeddings call, return the first vector. 30s
 * `AbortSignal.timeout` (mirror closureIndexer.defaultEmbed CR-06) so a hung embed
 * endpoint never hangs a save / backfill forever.
 */
async function defaultEmbed(model: ResolvedModel, body: string): Promise<number[]> {
  // C3.1 计量台账：story KB 资产卡索引重嵌标签（同族 kb-index-embed）。
  const res = await generateEmbeddings(model, { input: [body] }, { signal: AbortSignal.timeout(30_000), taskType: 'kb-index-embed' });
  return res.embeddings[0] ?? [];
}

/**
 * Reindex a single setting card into the derived `closure_*` index. Idempotent +
 * content-hash aware (unchanged body → no-op). Best-effort embedding: no model /
 * failure / dim-mismatch / model-mismatch → FTS-only (pending_embed). Never throws
 * on embed failure (logs + degrades); db write errors propagate to the per-card
 * caller which logs + continues.
 *
 * Mirror closureIndexer.reindexAsset (project_assets) + closureCraftIndexer.reindexCraftDoc
 * (craft), adapted for a yaml-sourced card. The content-hash payload includes
 * `card.type` (→ entry_type, a structured pre-filter dimension) so a type-only
 * reclassify on a minimal card (name+summary unchanged) still reindexes instead of
 * leaving a stale entry_type — same philosophy as the craft frontmatter-in-hash
 * convention (data-model.md spec).
 *
 * @returns true when the card was actually (re)written / re-embedded (the caller
 *   counts it as `reindexed`); false for a hash-skip no-op (unchanged body, vec
 *   preserved) or an F9 collision skip (card.id撞 project_assets row). `force`
 *   bypasses the hash-skip, so a forced reindex returns true for every card - the
 *   rebuild toast thus shows the full count (F1 / BLIND-1=EDGE-1).
 */
async function reindexAssetCard(
  card: AssetCard,
  projectId: string,
  deps: ReindexDeps,
): Promise<boolean> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const db = getDb();
  const vecDim = getCurrentVecDim(db);

  const body = materializeAssetCardBody(card);
  // Hash covers type (entry_type) + status (Story 8.7 §1.2 filter dimension —
  // a status-only edit like draft→deprecated must reindex or the materialized
  // status goes stale) + the full materialized body so any retrieval-affecting
  // edit (reclassify, field change, alias, tag, customField) flips it.
  const materializedStatus = card.status ?? 'draft';
  const hash = createHash('sha256')
    .update(JSON.stringify({ type: card.type, status: materializedStatus, body }))
    .digest('hex');

  // Content-hash skip: body unchanged AND a vector landed → FTS fresh, vec
  // preserved. A pending_embed entry (null hash) is retried. `force` (model swap
  // via reindexAllForChangedModel) bypasses the skip.
  const existing = db
    .prepare('SELECT content_hash, source_kind FROM closure_entry WHERE entry_id=?')
    .get(card.id) as { content_hash: string | null; source_kind: string } | undefined;
  // F9 (EDGE-5): if entry_id collides with an existing project_assets-derived row
  // (source_kind='asset_card'), do NOT clobber it. The card upsert's ON CONFLICT
  // DO UPDATE would flip source_kind to 'setting_card', and project_assets'
  // reindexAsset (which does NOT update source_kind) would not restore it,
  // leaving the file-asset row mislabeled + vulnerable to the setting_card orphan
  // cleanup (which could delete it). IDs are normally generated (collision is
  // ignorable), but normalize the asymmetry: warn + skip so a file-asset row is
  // never clobbered by a card.
  if (existing?.source_kind === 'asset_card') {
    getLogger().warn(
      { cardId: card.id, projectId },
      'asset_cards reindex: card.id collides with a project_assets row (source_kind=asset_card) - skipping to avoid clobbering the file-asset row',
    );
    return false;
  }
  if (!deps.force && existing?.content_hash === hash) return false;

  // Embed — ASYNC, OUTSIDE any transaction, best-effort. Mirror the
  // model-consistency gate (CR-02): refuse to embed under a model that differs
  // from the project's prevailing vector-space model. `force` bypasses (it IS the
  // authorized migration).
  let vec: number[] | null = null;
  let modelId: string | null = null;
  const model = resolveModel();

  let modelMismatch = false;
  if (model && body.trim() && !deps.force) {
    const prevailingRow = db
      .prepare('SELECT model FROM closure_entry WHERE project_id=? AND model IS NOT NULL LIMIT 1')
      .get(projectId) as { model: string } | undefined;
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { cardId: card.id, projectId, prevailingModel, resolvedModel: model.modelId },
        'asset_cards reindex: model mismatch (prevailing vs resolved) — FTS-only; run rebuild to migrate',
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
          { cardId: card.id, expected: vecDim, got: vecArr.length, model: model.modelId },
          'asset_cards reindex: embedding dim mismatch — FTS-only',
        );
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), cardId: card.id },
        'asset_cards reindex: embed failed — FTS-only',
      );
    }
  }

  // Single WAL transaction: closure_entry upsert (trigger syncs entry_fts) +
  // entry_vec delete-then-insert. CR-craft-kb-009 pattern: ALWAYS delete the
  // existing entry_vec row for this card.id (even when vec===null from a failed /
  // mismatched embed), THEN insert only when a fresh vector landed — without the
  // unconditional delete, a transient embed failure on an EDITED card would leave
  // a stale vector that KNN-matches OLD content JOINed to the NEW body_text.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status, content_hash, model, dim, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(entry_id) DO UPDATE SET
         entry_type=excluded.entry_type,
         source_kind=excluded.source_kind,
         name=excluded.name,
         body_text=excluded.body_text,
         status=excluded.status,
         content_hash=excluded.content_hash,
         model=excluded.model,
         dim=excluded.dim,
         updated_at=datetime('now')`,
    ).run(
      card.id,
      projectId,
      card.type,
      ASSET_CARD_SOURCE_KIND,
      card.name,
      body,
      'known',
      // Story 8.7 §1.2: materialized card status ('draft' default mirror
      // assetCardStatusSchema; setting_md/craft rows keep NULL — cards only).
      materializedStatus,
      // pending_embed: write the hash ONLY when a vector landed (mirror CR-03).
      vec ? hash : null,
      modelId,
      vec ? vec.length : null,
    );

    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(card.id);
      if (vec) {
        // Story 8.7 §1.3: card-type entries write a single #body vector (the
        // materialized body already contains name+summary — an identity vector
        // would be pure redundancy). vector_id is the multi-vector PK; the
        // entry_id column is the reverse-lookup JOIN key.
        //
        // Story 8.3 CR-005: status/visibility vec0 metadata columns mirror the
        // values the closure_entry INSERT writes for this row — the KNN pre-filter
        // (design §4, wired in S4) and the final closure_entry WHERE belt must
        // agree. setting_card rows are the ONLY source with a real status
        // (materializedStatus, 8.7 §1.2); visibility is the same 'known' literal.
        // Both are already in the hash payload (status since 8.7; visibility is a
        // hardcoded constant, not source-derived — nothing can go stale).
        db.prepare(
          `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(`${card.id}#body`, projectId, card.id, card.type, ASSET_CARD_SOURCE_KIND, 'body', materializedStatus, 'known', floatArrayToBuffer(vec));
      }
    }
  })();
  return true;
}

/**
 * Remove a setting card's derived index rows (closure_entry delete fires the AFTER
 * DELETE trigger clearing entry_fts; entry_vec delete gated on the vec extension).
 * Single transaction keeps the derived faces consistent. Used by orphan cleanup.
 */
function reindexAssetCardDelete(cardId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM closure_entry WHERE entry_id=?').run(cardId);
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(cardId);
    }
  })();
}

/**
 * Reindex EVERY setting card for a project into the derived `closure_*` index.
 * Mirror closureCraftIndexer.scanAndReindexCraftKb (scan + orphan cleanup + per-doc
 * reindex), adapted for a project.yaml source.
 *
 * Flow:
 * 1. Resolve the REGISTRY project_id via `getProject(path.resolve(projectPath))`
 *    (same namespace `query_story` / `reindexAsset` use — NOT `meta.id`), then
 *    `loadProject(projectPath)` → cards = `asset_cards`.
 * 2. Orphan cleanup: closure_entry rows with (project_id, source_kind='setting_card')
 *    whose entry_id is no longer in the yaml → delete (a deleted/reclassified card
 *    leaves no stale derived row). Only `'setting_card'` rows are touched —
 *    project_assets' `'asset_card'` rows are owned by `reindexAsset`.
 * 3. Per-card reindex (hash skip + best-effort embed + single WAL txn).
 *
 * Best-effort: a missing/corrupt project.yaml (loadProject null) returns zero
 * counts without touching the index (the watcher will retry on the next save; a
 * null doc cannot yield a trustworthy projectId for orphan cleanup). Per-card
 * failures are logged + skipped so one bad card never aborts the scan.
 *
 * @returns `reindexed` (cards actually (re)written / re-embedded; hash-skip no-ops
 *   are NOT counted - F1 / BLIND-1=EDGE-1) + `orphaned` (stale derived rows deleted).
 */
async function runReindexAssetCards(
  projectPath: string,
  deps: ReindexDeps = {},
): Promise<{ reindexed: number; orphaned: number }> {
  const db = getDb();

  // 1. Resolve the db project_id + source-of-truth cards.
  //
  // projectId is the REGISTRY project_id (5-digit `projects.project_id`), resolved
  // via `getProject(path.resolve(projectPath))?.projectId` — the SAME lookup
  // `query_story` (closureHandlers) and `reindexAsset` (project_assets) use. The
  // design's `loadProject().meta.id` (UUID) is a DIFFERENT namespace: project_assets
  // rows + the retrieval funnel live on the registry id, so asset_cards MUST share
  // it or query_story's project_id filter would never match them (AC2 would break).
  // This overrides design.md's `meta.id` constraint after fresh code verification
  // (the task's "fresh-read-code when design conflicts code" guidance).
  const projectId = getProject(path.resolve(projectPath))?.projectId;
  if (!projectId) {
    // Project not registered yet (brand-new, pre ensure-registration). Card rows
    // would be unqueryable without a registry id; the watcher + the post-
    // registration open-project backfill will reconcile.
    getLogger().warn(
      { projectPath },
      'asset_cards reindex: project not registered — skipping (no registry projectId)',
    );
    return { reindexed: 0, orphaned: 0 };
  }

  let cards: AssetCard[];
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    const doc = loadProject(projectPath);
    if (!doc) {
      // project.yaml missing/corrupt — keep the existing derived rows (the watcher
      // + next valid save reconcile); do not orphan-clean on a null doc.
      return { reindexed: 0, orphaned: 0 };
    }
    // loadProject returns a projectDocumentSchema-validated doc, so the cast to
    // the structural AssetCard is safe (avoids a discriminated-union import).
    cards = (doc.asset_cards ?? []) as AssetCard[];
    // Story 6.4 D2：relationship_graph → closure_relation 物化（复用 doc load，on-save 触发——
    // asset_cards watcher 监 project.yaml 变化，relationship_graph 同源，顺带 reindex，一处管两索引）。
    try {
      reindexRelationGraph(doc.relationship_graph, projectId);
    } catch (relErr) {
      getLogger().warn(
        { err: relErr instanceof Error ? relErr.message : String(relErr), projectId },
        'relationship_graph reindex failed — continuing (asset_cards indexing unaffected)',
      );
    }
    // Story 6.4 D3：promise_registry → closure_foreshadow 物化（mirror relation 触发，on-save 复用 doc load）。
    try {
      reindexForeshadowRegistry(doc.promise_registry, projectId);
    } catch (foreshadowErr) {
      getLogger().warn(
        { err: foreshadowErr instanceof Error ? foreshadowErr.message : String(foreshadowErr), projectId },
        'promise_registry reindex failed — continuing (asset_cards indexing unaffected)',
      );
    }
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'asset_cards reindex: loadProject threw — skipping (nothing to index)',
    );
    return { reindexed: 0, orphaned: 0 };
  }
  // F8 (EDGE-4): detect duplicate card ids in the yaml (schema uniqueness is 2.4
  // scope - not changed here). ON CONFLICT makes last-wins the silent default;
  // warn so the collision is visible (list the duplicated ids) rather than
  // silently clobbering the earlier card.
  const cardIdCounts = new Map<string, number>();
  for (const c of cards) {
    cardIdCounts.set(c.id, (cardIdCounts.get(c.id) ?? 0) + 1);
  }
  const dupCardIds = [...cardIdCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dupCardIds.length > 0) {
    getLogger().warn(
      { projectId, duplicateIds: dupCardIds },
      'asset_cards reindex: duplicate card ids in project.yaml - last-wins (earlier card overwritten)',
    );
  }
  const cardIds = new Set(cards.map((c) => c.id));

  // 2. Orphan cleanup (project + setting_card scope only).
  let orphaned = 0;
  let indexed: Array<{ entry_id: string }>;
  try {
    indexed = db
      .prepare(
        "SELECT entry_id FROM closure_entry WHERE project_id=? AND source_kind='setting_card'",
      )
      .all(projectId) as Array<{ entry_id: string }>;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectId },
      'asset_cards reindex: cannot enumerate indexed cards — skipping orphan cleanup',
    );
    indexed = [];
  }
  for (const { entry_id } of indexed) {
    if (!cardIds.has(entry_id)) {
      try {
        reindexAssetCardDelete(entry_id);
        orphaned++;
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), cardId: entry_id },
          'asset_cards reindex: orphan delete failed — continuing',
        );
      }
    }
  }

  // 3. Per-card reindex (hash skip makes unchanged cards a cheap no-op).
  // F2 (BLIND-3=ACCEPT-3): on a dim-change model swap, ensure entry_vec is rebuilt
  // at the new dim BEFORE per-card embedding. A pure-card project (no
  // project_assets) makes `reindexAll` early-return before its dim probe, so
  // without this the stale-dim entry_vec degrades every card re-embed to FTS-only
  // (the dim-mismatch guard). Only on `force` (the authorized model-swap migration
  // path): a normal save keeps the same model, so the dim is unchanged and a probe
  // would be a wasted embed on every save. Idempotent `ensureEntryVecDim` no-ops
  // when the dim already matches, so the GAP2 sweep (reindexAll then
  // reindexAssetCards) does not double-DROP.
  if (deps.force && cards.length > 0) {
    const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
    const embed = deps.embed ?? defaultEmbed;
    const model = resolveModel();
    if (model) {
      const sampleBody =
        cards.map((c) => materializeAssetCardBody(c)).find((b) => b.trim()) ?? 'probe';
      try {
        const probeVec = await embed(model, sampleBody);
        ensureEntryVecDim(db, probeVec.length);
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectPath },
          'asset_cards reindex: dim probe failed - entry_vec left as-is',
        );
      }
    }
  }

  let reindexed = 0;
  for (const card of cards) {
    try {
      if (await reindexAssetCard(card, projectId, deps)) reindexed++;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), cardId: card.id },
        'asset_cards reindex: per-card reindex failed — continuing',
      );
    }
  }

  return { reindexed, orphaned };
}

/**
 * Per-project serialization wrapper (F5 / EDGE-2). A concurrent backfill + watcher
 * reindex on the same project can race: the backfill reads the card list once,
 * then slowly iterates embeds; a mid-scan delete + save makes the watcher reindex
 * see the deleted card as an orphan (correct) while the still-running backfill
 * re-upserts it from its STALE list (resurrects it) until the next save. Serialize
 * same-project reindexes via a module-level in-flight Map: a second call CHAINS
 * onto the prior promise (runs after it settles, re-reading the latest yaml) so it
 * never races. This also honors the API-concurrency guard (no parallel embeds per
 * project - memory feedback-api-concurrency-no-parallel).
 *
 * The chain runs the second call AFTER the first settles (fulfilled OR rejected),
 * mirroring withProjectLock's `prev.then(() => op(), () => op())` pattern so a
 * failed prior reindex never dead-locks the queue. The in-flight slot is cleared
 * on settle so a later call starts fresh. `runReindexAssetCards` itself never
 * rejects on per-card / embed failures (all caught + logged), so rejection is
 * limited to a db-structural throw (e.g. ensureEntryVecDim's DROP/CREATE) - the
 * chain still runs the next call to recover.
 */
const inflightReindexes = new Map<string, Promise<{ reindexed: number; orphaned: number }>>();

export async function reindexAssetCards(
  projectPath: string,
  deps: ReindexDeps = {},
): Promise<{ reindexed: number; orphaned: number }> {
  const resolved = path.resolve(projectPath);
  const prior = inflightReindexes.get(resolved);
  if (prior) {
    // Chain: run AGAIN after the in-flight one settles so this call re-reads the
    // latest yaml (the caller's save may have changed it mid-prior-scan). Runs on
    // both fulfillment and rejection so a failed prior never blocks the queue.
    const chained = prior.then(
      () => runReindexAssetCards(resolved, deps),
      () => runReindexAssetCards(resolved, deps),
    );
    inflightReindexes.set(resolved, chained);
    chained.finally(() => {
      if (inflightReindexes.get(resolved) === chained) inflightReindexes.delete(resolved);
    });
    return chained;
  }
  const current = runReindexAssetCards(resolved, deps);
  inflightReindexes.set(resolved, current);
  current.finally(() => {
    if (inflightReindexes.get(resolved) === current) inflightReindexes.delete(resolved);
  });
  return current;
}
