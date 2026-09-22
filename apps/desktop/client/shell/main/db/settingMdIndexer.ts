import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import {
  floatArrayToBuffer,
  shouldSkipForModelMismatch,
  getCurrentVecDim,
  ensureEntryVecDim,
} from './closureIndexer';
import {
  defaultGenerateSummary,
  buildIdentityText,
  resolveDocSummary,
} from './docSummary';
import { getProject } from './projectRepository';
import { resolveEmbeddingModel, resolveSummaryModel } from '../ipc/modelGatewayIpc';
import { parseSettingMd, extractSettingName, deriveSettingId } from './settingMd';
import { listSettingMdFiles } from './settingMdPaths';
import { getLogger } from '../logger';

/**
 * Per-project long-form setting-prose derived reindex indexer (ADR-3 / Story
 * 2.3, design §3.1). Mirrors `closureCraftIndexer` (markdown file source +
 * frontmatter + content-hash) + `assetCardsIndexer` (project-scoped, registry
 * projectId, per-project serialization, F9 clobber guard, force-path dim probe),
 * but writes to the SHARED `closure_entry` / `entry_fts` / `entry_vec` tables
 * (NOT `closure_craft_*`) so `query_story` retrieves setting prose alongside
 * asset_cards in one JOIN.
 *
 * Source of truth = `<project>/settings/*.md` (markdown + frontmatter); the
 * closure_* rows are a DERIVED query/retrieval face that can be dropped + rebuilt
 * from the docs at any time.
 *
 * 🔑 entry_id namespace: `${projectId}:${settingId}` (NOT the raw settingId).
 * Story 2.7's asset_cards indexer uses raw `card.id` as entry_id, which risks a
 * cross-project PK collision when two projects have a card with the same id.
 * setting_md namespaces by the registry projectId so two projects' `magic-system`
 * docs never collide (design §6 tradeoff). projectId is the REGISTRY project_id
 * (5-digit, `getProject(path).projectId`) - the SAME namespace `query_story` /
 * `reindexAsset` / `reindexAssetCards` use (mirror 2.7 as-built, NOT meta.id).
 *
 * source_kind='setting_md' distinguishes these rows from project_assets'
 * 'asset_card' + asset_cards' 'setting_card' in the shared closure_entry table.
 * The retrieval funnel does NOT filter by source_kind (design §3.1: query_story
 * auto-queries setting_md); source_kind is for orphan-cleanup scoping + the
 * management-page count (Step 4). The crash-consistency contract (gate G3) is
 * identical to the sibling indexers: the embed call AND the Story 8.7 summary
 * generate run OUTSIDE any txn; only the closure_* writes (entry + vec + the
 * doc's setting_link relation edges) are wrapped in a single WAL transaction.
 *
 * Story 8.7 (S4): long doc → summary layer (curated / generated one-liner +
 * body-hash fingerprint cache, `docSummary.ts`) + dual vector (#body full text
 * + #identity name+type+summary, design §1.3) + linked_entities materialized
 * into closure_relation as source='setting_link' edges (design §1.4).
 */

/**
 * `source_kind` for setting_md rows. Distinguishes them from project_assets
 * (`'asset_card'`) + asset_cards (`'setting_card'`) in the shared closure_entry
 * table. Naming follows the existing convention (asset_card / setting_card /
 * setting_md). The retrieval funnel does NOT filter by source_kind; it exists so
 * orphan cleanup scopes to setting_md rows only + a future management-page count
 * can split the populations (mirror ASSET_CARD_SOURCE_KIND).
 */
export const SETTING_MD_SOURCE_KIND = 'setting_md';

/** Default entry_type when frontmatter `type` is absent (mirror craft's
 *  'uncategorized' default; open string, not a closed enum - ADR-3). */
const DEFAULT_SETTING_TYPE = 'uncategorized';

/**
 * Dependency-injection seam (mirrors closureIndexer.ReindexDeps / craft
 * CraftReindexDeps). Tests pass stubs so the DB-integration suite runs (under
 * the Electron ABI) with ZERO network - no real embed / summary endpoint is hit.
 */
export type SettingReindexDeps = {
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
  /** Bypass the content-hash skip (reindexAllSettingMd on a model/dim swap). Default false. */
  force?: boolean;
};

/**
 * Default embed: one generateEmbeddings call, return the first vector. 30s
 * `AbortSignal.timeout` (mirror closureIndexer.defaultEmbed CR-06) so a hung
 * embed endpoint never hangs a save / backfill forever.
 */
async function defaultEmbed(model: ResolvedModel, body: string): Promise<number[]> {
  // C3.1 计量台账：story KB 设定 md 索引重嵌标签（同族 kb-index-embed）。
  const res = await generateEmbeddings(model, { input: [body] }, { signal: AbortSignal.timeout(30_000), taskType: 'kb-index-embed' });
  return res.embeddings[0] ?? [];
}

/** Build the namespaced entry_id (`${projectId}:${settingId}`). Exported for the
 *  watcher / tests + to document the namespace convention in one place. */
export function settingEntryId(projectId: string, settingId: string): string {
  return `${projectId}:${settingId}`;
}

/**
 * Build the asset-card lookup index for linked_entities resolution (Story 8.7
 * §1.4): card id / card name / card alias -> card id (= the card's entry_id —
 * the raw `card.id` namespace assetCardsIndexer writes, so relation edges JOIN
 * closure_entry directly). Tolerant resolution: a linked_entities entry may be
 * any of the three spellings. Best-effort: missing/corrupt project.yaml -> an
 * empty index (every link then warns + skips; never throws). Structural shape
 * only (mirror assetCardsIndexer's AssetCard cast — loadProject already
 * validated the doc).
 */
async function buildCardLookup(projectDir: string): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    const doc = loadProject(projectDir);
    const cards = (doc?.asset_cards ?? []) as Array<{
      id: string;
      name?: string;
      basics?: { aliases?: string[] };
    }>;
    for (const card of cards) {
      lookup.set(card.id, card.id);
      if (card.name?.trim()) lookup.set(card.name.trim(), card.id);
      for (const alias of card.basics?.aliases ?? []) {
        if (alias.trim()) lookup.set(alias.trim(), card.id);
      }
    }
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectDir },
      'setting_md reindex: cannot load project.yaml for linked_entities resolution - links left unresolved',
    );
  }
  return lookup;
}

/**
 * Resolve frontmatter linked_entities refs to card entry_ids. Unresolvable
 * refs warn + skip (a typo'd name must not炸 the doc's whole reindex); the
 * returned ids are deduped (a name + an id spelling of the same card yield one
 * edge). Pure + exported for unit testing.
 */
export function resolveSettingLinks(
  linked: string[] | undefined,
  lookup: Map<string, string>,
  logCtx: { projectId: string; entryId: string },
): string[] {
  if (!linked || linked.length === 0) return [];
  const resolved: string[] = [];
  for (const raw of linked) {
    const target = lookup.get(raw);
    if (target) {
      if (!resolved.includes(target)) resolved.push(target);
    } else {
      getLogger().warn(
        { ...logCtx, ref: raw },
        'setting_md reindex: linked_entities entry unresolved (not a card id/name/alias) - skipped',
      );
    }
  }
  return resolved;
}

/** Deterministic relation_id for a setting_link edge (`setting_link:<src>:<tgt>`).
 *  src already contains the projectId prefix, so the id is globally unique +
 *  stable across reindexes (delete-then-insert idempotency). */
function settingLinkRelationId(srcEntryId: string, tgtEntryId: string): string {
  return `setting_link:${srcEntryId}:${tgtEntryId}`;
}

/**
 * Delete a setting doc's setting_link edges (per-doc scope: source='setting_link'
 * AND src=this entry — the graph indexer's rows are NEVER touched, mirror
 * relationIndexer's source-scoped replacement). Used by reindexSettingMd (full
 * replacement before insert) + reindexSettingMdDelete (doc removed from disk).
 */
function deleteSettingLinks(db: ReturnType<typeof getDb>, projectId: string, entryId: string): void {
  db.prepare(
    "DELETE FROM closure_relation WHERE project_id=? AND src_entry_id=? AND source='setting_link'",
  ).run(projectId, entryId);
}

/**
 * Reindex a single setting md doc into the derived `closure_*` index. Idempotent
 * + content-hash aware (unchanged body/frontmatter -> no-op). Best-effort
 * embedding: no model / failure / dim-mismatch / model-mismatch -> FTS-only
 * (pending_embed). Never throws on embed failure (logs + degrades); db write
 * errors propagate to the per-doc caller which logs + continues.
 *
 * Mirror closureCraftIndexer.reindexCraftDoc (file source + frontmatter-in-hash)
 * + assetCardsIndexer.reindexAssetCard (registry projectId + F9 clobber guard +
 * reindexed boolean). The content-hash payload covers every frontmatter/body
 * field that affects the STORED derived state (id / type / body / summary /
 * linked_entities — see step 3 below; tags / source are parsed but unstored and
 * deliberately excluded): a frontmatter-only edit (e.g. reclassifying `type`,
 * curating `summary`, editing `linked_entities`) triggers a reindex instead of
 * leaving a stale derived row (mirror craft CR-craft-kb-005 convention).
 *
 * @returns true when the doc was actually (re)written / re-embedded (the caller
 *   counts it as `reindexed`); false for a hash-skip no-op or an F9 collision
 *   skip (entry_id collides with a non-setting_md row). `force` bypasses the
 *   hash-skip, so a forced reindex returns true for every doc.
 */
export async function reindexSettingMd(
  projectDir: string,
  filePath: string,
  deps: SettingReindexDeps = {},
): Promise<boolean> {
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const resolveSummary = deps.resolveSummaryModel ?? resolveSummaryModel;
  const generateSummary = deps.generateSummary ?? defaultGenerateSummary;
  const db = getDb();
  const vecDim = getCurrentVecDim(db);

  // 1. Resolve the REGISTRY project_id (mirror 2.7 as-built: getProject(path)
  //    ?.projectId, the namespace query_story / reindexAsset / reindexAssetCards
  //    use - NOT project.yaml meta.id which is a UUID in a different namespace).
  //    Without it, the row would be unqueryable (query_story's project_id filter
  //    would never match); the watcher + post-registration open backfill reconcile.
  const projectId = getProject(path.resolve(projectDir))?.projectId;
  if (!projectId) {
    getLogger().warn(
      { projectDir, filePath },
      'setting_md reindex: project not registered - skipping (no registry projectId)',
    );
    return false;
  }

  // 2. Read + parse the setting md doc (source of truth).
  const fileName = path.basename(filePath);
  const content = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseSettingMd(content);
  const settingId = deriveSettingId(fileName, frontmatter);
  // CR-craft-kb-007 (mirrored): an empty settingId (`.md` filename + no
  // frontmatter id) namespaces to `${projectId}:` with an empty suffix, colliding
  // with every other empty-id doc in the project. The scan path filters these,
  // but a direct reindexSettingMd call must also skip + warn, never index.
  if (!settingId) {
    getLogger().warn(
      { filePath },
      'setting_md reindex: doc derives to an empty settingId - skipping (no stable PK suffix)',
    );
    return false;
  }
  const entryId = settingEntryId(projectId, settingId);
  const entryType = frontmatter.type ?? DEFAULT_SETTING_TYPE;
  const name = extractSettingName(body) ?? settingId;
  const bodyText = body;

  // 3. Content hash for diff/skip (BMad CR B2). Includes ONLY fields that affect
  //    the STORED derived state: id (entry_id PK suffix), type (entry_type,
  //    query_story entry_type filter), body (body_text + FTS + vec) — plus, as
  //    of Story 8.7 §3.1, summary (stored summary_text / identity vector) and
  //    linked_entities (materialized closure_relation setting_link edges), so a
  //    curated-summary or link edit triggers a reindex instead of leaving stale
  //    derived rows (mirror craft CR-craft-kb-005 intent). tags / source remain
  //    parsed-but-unstored (no columns / no consumers) and stay OUT of the hash —
  //    including them would spurious-re-embed on an edit that changes nothing
  //    indexed (wasted API call).
  //    Story 8.3 hashPayload 核实：无需为 vec0 metadata 列扩 hash——setting_md 行物化进
  //    entry_vec 的 metadata 无源数据派生字段（status 恒 '' sentinel——entry 侧本就 NULL；
  //    visibility 硬编码 'known' 常量），无可 stale 维度。
  const hashPayload = JSON.stringify({
    id: settingId,
    type: entryType,
    body: bodyText,
    summary: frontmatter.summary ?? null,
    linked_entities: frontmatter.linked_entities ?? [],
  });
  const hash = createHash('sha256').update(hashPayload).digest('hex');

  // 4. Content-hash skip + F9 clobber guard. The entry_id namespace
  //    (`${projectId}:${settingId}`) makes a collision with a raw card.id /
  //    asset_id unlikely, but normalize the asymmetry (mirror assetCardsIndexer
  //    F9): if an existing row at this entry_id is NOT a setting_md row, skip +
  //    warn so a project_assets / asset_card row is never clobbered by a setting
  //    doc upsert.
  const existing = db
    .prepare(
      'SELECT content_hash, source_kind, summary_text, summary_source, summary_hash FROM closure_entry WHERE entry_id=?',
    )
    .get(entryId) as
    | {
        content_hash: string | null;
        source_kind: string;
        summary_text: string | null;
        summary_source: string | null;
        summary_hash: string | null;
      }
    | undefined;
  if (existing && existing.source_kind !== SETTING_MD_SOURCE_KIND) {
    getLogger().warn(
      { entryId, projectId, sourceKind: existing.source_kind },
      'setting_md reindex: entry_id collides with a non-setting_md row - skipping to avoid clobbering',
    );
    return false;
  }
  if (!deps.force && existing?.content_hash === hash) return false;

  // 5. Summary resolution (Story 8.7 §3.1) — ASYNC, OUTSIDE any transaction,
  //    best-effort (mirror the embed call): curated frontmatter value → cached
  //    generated value (body-hash fingerprint) → one LLM generate. No model /
  //    failure → columns empty (retrieval unaffected).
  const summary = await resolveDocSummary({
    curated: frontmatter.summary,
    body: bodyText,
    existing,
    resolveModel: resolveSummary,
    generateSummary,
    logLabel: 'setting_md reindex',
  });

  // 6. linked_entities resolution (Story 8.7 §1.4) — card id/name/alias →
  //    card entry_id. The project.yaml lookup is built lazily (only when the
  //    doc actually declares links) so link-less docs pay zero yaml-parse cost.
  const linkTargets =
    frontmatter.linked_entities && frontmatter.linked_entities.length > 0
      ? resolveSettingLinks(
          frontmatter.linked_entities,
          await buildCardLookup(projectDir),
          { projectId, entryId },
        )
      : [];

  // 7. Embeds — body + identity dual vector (Story 8.7 §3.2 / design §1.3),
  //    ASYNC, OUTSIDE any transaction, best-effort. Mirror the
  //    model-consistency gate (CR-02): refuse to embed under a model that differs
  //    from the project's prevailing vector-space model (setting_md shares the
  //    project's entry_vec, so it must share the project's model space). `force`
  //    bypasses (it IS the authorized migration).
  //
  //    两向量同生共死: the body embed must land BEFORE the identity embed is
  //    attempted, and a failure of EITHER clears both (pending_embed semantics
  //    unchanged — content_hash is written only when the full vector set
  //    landed). Without this, a half-landed entry would KNN-match via one stale
  //    vector JOINed to NEW content.
  let bodyVec: number[] | null = null;
  let identityVec: number[] | null = null;
  let modelId: string | null = null;
  const model = resolveModel();
  const identityText = buildIdentityText(name, entryType, summary.text);

  let modelMismatch = false;
  if (model && bodyText.trim() && !deps.force) {
    const prevailingRow = db
      .prepare('SELECT model FROM closure_entry WHERE project_id=? AND model IS NOT NULL LIMIT 1')
      .get(projectId) as { model: string } | undefined;
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { entryId, projectId, prevailingModel, resolvedModel: model.modelId },
        'setting_md reindex: model mismatch (prevailing vs resolved) - FTS-only; run rebuild to migrate',
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
          { entryId, expected: vecDim, got: bodyArr.length, model: model.modelId },
          'setting_md reindex: body embedding dim mismatch - FTS-only',
        );
      }
      if (bodyVec && identityText.trim()) {
        const idArr = await embed(model, identityText);
        if (vecDim !== null && idArr.length === vecDim) {
          identityVec = idArr;
        } else {
          getLogger().warn(
            { entryId, expected: vecDim, got: idArr.length, model: model.modelId },
            'setting_md reindex: identity embedding dim mismatch - FTS-only',
          );
          bodyVec = null; // all-or-nothing (同生共死)
        }
      }
      if (bodyVec && identityVec) modelId = model.modelId;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), entryId },
        'setting_md reindex: embed failed - FTS-only',
      );
      bodyVec = null;
      identityVec = null;
    }
  }

  // 8. Single WAL transaction: closure_entry upsert (trigger syncs entry_fts) +
  //    entry_vec delete-then-insert (both vector kinds) + closure_relation
  //    setting_link replacement. CR-craft-kb-009 pattern: ALWAYS delete the
  //    existing entry_vec rows for this entry_id (even when the vectors failed /
  //    mismatched), THEN insert only when fresh vectors landed - without the
  //    unconditional delete, a transient embed failure on an EDITED doc would
  //    leave a stale vector that KNN-matches OLD content JOINed to the NEW
  //    body_text just written above. The setting_link delete-then-insert is the
  //    doc's self-managed orphan cleanup (targets no longer listed are dropped);
  //    it is scoped to source='setting_link' so the graph indexer's rows are
  //    never touched.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility,
          summary_text, summary_source, summary_hash, content_hash, model, dim, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(entry_id) DO UPDATE SET
         entry_type=excluded.entry_type,
         source_kind=excluded.source_kind,
         name=excluded.name,
         body_text=excluded.body_text,
         summary_text=excluded.summary_text,
         summary_source=excluded.summary_source,
         summary_hash=excluded.summary_hash,
         content_hash=excluded.content_hash,
         model=excluded.model,
         dim=excluded.dim,
         updated_at=datetime('now')`,
    ).run(
      entryId,
      projectId,
      entryType,
      SETTING_MD_SOURCE_KIND,
      name,
      bodyText,
      'known',
      summary.text,
      summary.source,
      summary.hash,
      // pending_embed: write the hash ONLY when the full vector set landed
      // (mirror CR-03; dual-vector = both vectors, all-or-nothing).
      bodyVec && identityVec ? hash : null,
      modelId,
      bodyVec && identityVec ? bodyVec.length : null,
    );

    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(entryId);
      if (bodyVec && identityVec) {
        // Story 8.3 CR-005: status/visibility vec0 metadata columns mirror the
        // closure_entry values for this row. setting_md rows carry NO closure
        // status (NULL on the entry side — no card-status materialization, 8.7
        // §1.2 "cards only"), so the vec metadata gets the EMPTY-STRING sentinel:
        // vec0 TEXT metadata columns REJECT NULL (probe-proven), and '' behaves
        // like SQL NULL under `= 'value'` (never matches a concrete filter — same
        // rows the closure_entry belt's `c.status = ?` drops). visibility is the
        // same 'known' literal the closure_entry INSERT writes. Both vectors of
        // the doc carry identical metadata (kind differs only in vector_kind).
        const insertVec = db.prepare(
          `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        );
        insertVec.run(
          `${entryId}#body`,
          projectId,
          entryId,
          entryType,
          SETTING_MD_SOURCE_KIND,
          'body',
          '',
          'known',
          floatArrayToBuffer(bodyVec),
        );
        insertVec.run(
          `${entryId}#identity`,
          projectId,
          entryId,
          entryType,
          SETTING_MD_SOURCE_KIND,
          'identity',
          '',
          'known',
          floatArrayToBuffer(identityVec),
        );
      }
    }

    // setting_link edges: per-doc full replacement (self-managed orphan cleanup).
    deleteSettingLinks(db, projectId, entryId);
    const insertLink = db.prepare(
      `INSERT INTO closure_relation
         (relation_id, project_id, src_entry_id, tgt_entry_id, relation_type, source, updated_at)
       VALUES (?,?,?,?,?,'setting_link',datetime('now'))`,
    );
    for (const tgt of linkTargets) {
      insertLink.run(settingLinkRelationId(entryId, tgt), projectId, entryId, tgt, 'setting_link');
    }
  })();
  return true;
}

/**
 * Remove a setting doc's derived index rows (closure_entry delete fires the AFTER
 * DELETE trigger clearing entry_fts; entry_vec delete gated on the vec
 * extension; setting_link relation delete clears the doc's materialized
 * linked_entities edges — Story 8.7 §1.4, scoped to source='setting_link' so
 * graph-indexer rows are untouched). Single transaction keeps the derived faces
 * consistent. Used by orphan cleanup.
 *
 * @param projectId  the registry project_id (entry_id namespace prefix).
 * @param settingId  the doc's stable id (entry_id namespace suffix).
 */
export function reindexSettingMdDelete(projectId: string, settingId: string): void {
  const entryId = settingEntryId(projectId, settingId);
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM closure_entry WHERE entry_id=?').run(entryId);
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM entry_vec WHERE entry_id=?').run(entryId);
    }
    deleteSettingLinks(db, projectId, entryId);
  })();
}

/**
 * Reindex EVERY setting md doc for a project into the derived `closure_*` index.
 * Mirror closureCraftIndexer.scanAndReindexCraftKb + assetCardsIndexer.reindexAssetCards
 * (scan + orphan cleanup + per-doc reindex + per-project serialization +
 * force-path dim probe), adapted for a project-scoped `settings/` source.
 *
 * Flow:
 * 1. Resolve the REGISTRY project_id via `getProject(path.resolve(projectDir))`
 *    (same namespace `query_story` / `reindexAssetCards` use - NOT `meta.id`),
 *    then `listSettingMdFiles(projectDir)` -> docs.
 * 2. Orphan cleanup: closure_entry rows with (project_id, source_kind='setting_md')
 *    whose entry_id is no longer on disk -> delete. Only `'setting_md'` rows are
 *    touched - project_assets' `'asset_card'` + asset_cards' `'setting_card'`
 *    rows are owned by their own indexers.
 * 3. Per-doc reindex (hash skip + best-effort embed + single WAL txn).
 *
 * Best-effort: a project not yet registered (no registry projectId) returns zero
 * counts without touching the index (the watcher + post-registration open backfill
 * reconcile). Per-doc failures are logged + skipped so one bad doc never aborts
 * the scan. No embedding model -> FTS-only for every doc (does NOT throw - mirror
 * reindexAssetCards; the manual rebuild IPC's `reindexAll` throws first on a
 * no-model state, so this path is only reached when a model IS configured).
 *
 * @returns `reindexed` (docs actually (re)written / re-embedded; hash-skip no-ops
 *   are NOT counted - mirror assetCardsIndexer F1) + `orphaned` (stale derived
 *   rows deleted).
 */
async function runReindexAllSettingMd(
  projectDir: string,
  deps: SettingReindexDeps = {},
): Promise<{ reindexed: number; orphaned: number }> {
  const db = getDb();

  // 1. Resolve the db project_id + source-of-truth docs.
  const projectId = getProject(path.resolve(projectDir))?.projectId;
  if (!projectId) {
    getLogger().warn(
      { projectDir },
      'setting_md reindex: project not registered - skipping (no registry projectId)',
    );
    return { reindexed: 0, orphaned: 0 };
  }

  const files = listSettingMdFiles(projectDir);
  const scannedEntryIds = new Set(files.map((f) => settingEntryId(projectId, f.settingId)));

  // 2. Orphan cleanup (project + setting_md scope only). entry_id is namespaced
  //    `${projectId}:${settingId}`; recover the settingId suffix by slicing past
  //    the projectId prefix + ':' (projectId is a 5-digit registry id with no
  //    ':', so this is safe even if the settingId itself contains ':').
  let orphaned = 0;
  let indexed: Array<{ entry_id: string }>;
  try {
    indexed = db
      .prepare(
        "SELECT entry_id FROM closure_entry WHERE project_id=? AND source_kind='setting_md'",
      )
      .all(projectId) as Array<{ entry_id: string }>;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectId },
      'setting_md reindex: cannot enumerate indexed docs - skipping orphan cleanup',
    );
    indexed = [];
  }
  for (const { entry_id } of indexed) {
    if (!scannedEntryIds.has(entry_id)) {
      const settingId = entry_id.slice(projectId.length + 1);
      try {
        reindexSettingMdDelete(projectId, settingId);
        orphaned++;
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), entryId: entry_id },
          'setting_md reindex: orphan delete failed - continuing',
        );
      }
    }
  }

  // 3. Force-path dim probe (mirror assetCardsIndexer F2 / BLIND-3=ACCEPT-3): on
  //    a dim-change model swap, ensure entry_vec is rebuilt at the new dim BEFORE
  //    per-doc embedding. setting_md shares entry_vec with project_assets +
  //    asset_cards; a pure-setting_md project (no project_assets / cards) makes
  //    `reindexAll` early-return before its dim probe, so without this the stale
  //    entry_vec degrades every doc re-embed to FTS-only (dim-mismatch guard).
  //    Only on `force` (the authorized model-swap migration path): a normal save
  //    keeps the same model, so a probe would be a wasted embed on every save.
  //    Idempotent `ensureEntryVecDim` no-ops when the dim already matches, so the
  //    rebuild sweep (reindexAll -> reindexAssetCards -> reindexAllSettingMd)
  //    does not double-DROP.
  if (deps.force && files.length > 0) {
    const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
    const embed = deps.embed ?? defaultEmbed;
    const model = resolveModel();
    if (model) {
      const sampleBody =
        files.map((f) => readSettingBody(f.filePath)).find((b) => b.trim()) ?? 'probe';
      try {
        const probeVec = await embed(model, sampleBody);
        ensureEntryVecDim(db, probeVec.length);
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectDir },
          'setting_md reindex: dim probe failed - entry_vec left as-is',
        );
      }
    }
  }

  // 4. Per-doc reindex (hash skip makes unchanged docs a cheap no-op).
  let reindexed = 0;
  for (const { filePath } of files) {
    try {
      if (await reindexSettingMd(projectDir, filePath, deps)) reindexed++;
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'setting_md reindex: per-doc reindex failed - continuing',
      );
    }
  }

  return { reindexed, orphaned };
}

/** Read a setting md doc's body for the force-path dim probe (best-effort:
 *  unreadable -> empty string). */
function readSettingBody(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseSettingMd(content).body;
  } catch {
    return '';
  }
}

/**
 * Per-project serialization wrapper (mirror assetCardsIndexer F5 / EDGE-2). A
 * concurrent backfill + watcher reindex on the same project can race: the
 * backfill reads the doc list once, then slowly iterates embeds; a mid-scan
 * delete + save makes the watcher reindex see the deleted doc as an orphan
 * (correct) while the still-running backfill re-upserts it from its STALE list
 * (resurrects it) until the next save. Serialize same-project reindexes via a
 * module-level in-flight Map: a second call CHAINS onto the prior promise (runs
 * after it settles, re-reading the latest docs) so it never races. This also
 * honors the API-concurrency guard (no parallel embeds per project - memory
 * feedback-api-concurrency-no-parallel).
 *
 * The chain runs the second call AFTER the first settles (fulfilled OR rejected),
 * mirroring withProjectLock's `prev.then(() => op(), () => op())` pattern so a
 * failed prior reindex never dead-locks the queue. The in-flight slot is cleared
 * on settle so a later call starts fresh.
 */
const inflightReindexes = new Map<string, Promise<{ reindexed: number; orphaned: number }>>();

export async function reindexAllSettingMd(
  projectDir: string,
  deps: SettingReindexDeps = {},
): Promise<{ reindexed: number; orphaned: number }> {
  const resolved = path.resolve(projectDir);
  const prior = inflightReindexes.get(resolved);
  if (prior) {
    // Chain: run AGAIN after the in-flight one settles so this call re-reads the
    // latest docs (the caller's save may have changed them mid-prior-scan). Runs
    // on both fulfillment and rejection so a failed prior never blocks the queue.
    const chained = prior.then(
      () => runReindexAllSettingMd(resolved, deps),
      () => runReindexAllSettingMd(resolved, deps),
    );
    inflightReindexes.set(resolved, chained);
    chained.finally(() => {
      if (inflightReindexes.get(resolved) === chained) inflightReindexes.delete(resolved);
    });
    return chained;
  }
  const current = runReindexAllSettingMd(resolved, deps);
  inflightReindexes.set(resolved, current);
  current.finally(() => {
    if (inflightReindexes.get(resolved) === current) inflightReindexes.delete(resolved);
  });
  return current;
}
