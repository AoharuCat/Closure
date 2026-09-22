import type { EntryHit, ResolvedModel } from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { getCurrentVecDim, floatArrayToBuffer } from './closureIndexer';
import { rerankCandidates } from './closureRerank';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

/**
 * Closure KB hybrid retrieval (ADR-3 / VS1 R4/AC4).
 *
 * Fuses a structured pre-filter + FTS5 bm25 + vec0 KNN via Reciprocal Rank
 * Fusion (RRF, k=60) in a single SQL query (Alex Garcia CTE pattern, research
 * `hybrid-retrieval-sqlite-vec-research.md` §1/§3), then returns parent-doc
 * entries (name + body_text from closure_entry).
 *
 * KEY ADAPTATION vs the research template: the canonical pattern JOINs FTS and
 * vec by `rowid`. That does NOT apply here - closure_entry has a TEXT PRIMARY
 * KEY (its implicit rowid is the FTS external-content linkage key, not a stable
 * join id). All three tables are JOINed by `entry_id` (TEXT): entry_fts.entry_id
 * (UNINDEXED but SELECTable), entry_vec.entry_id (PK), closure_entry.entry_id
 * (PK). FULL OUTER JOIN (SQLite 3.39+, bundled by better-sqlite3 3.53+) keeps
 * FTS-only and vec-only matches alive through fusion.
 *
 * Offline / best-effort degradation (design §2): no embedding model, embed
 * endpoint failure, dim mismatch, or sqlite-vec not loaded -> the vector arm is
 * skipped ENTIRELY and the query degrades to FTS5 + structured pre-filter + RRF
 * (single-arm). An empty/unsanitizable query + no vector -> structured-only
 * fallback (closure_entry by project/type, score 0). This graceful degradation
 * is the default-robust path, never an afterthought.
 *
 * Story 8.7 dual-vector retrieval (design §3.2): the vec arm runs KNN over ALL
 * entry_vec rows (#body full-text vectors + #identity name/type/summary vectors
 * live in the same table — kind is NEVER filtered, 双臂齐搜 is the user's call).
 * The KNN pool is deduped to each entry's BEST (nearest) row, and that row's
 * vector_kind becomes the hit's `vectorKind` ('identity' = "what it is" match /
 * 'body' = content-semantic match — the consumer LLM triages). One entry = one
 * vec rank, so the RRF fusion stays per-doc.
 *
 * Story 8.3: (a) chunk vectors (`vector_kind='chunk'`, one row per chapter
 * chunk entry — the indexer writes vector_id = entry_id) join the same KNN
 * pool. Each chunk entry owns exactly ONE vector row, so the per-entry dedupe
 * keeps chunks ranked PER CHUNK (same-chapter multi-chunk hits each hold a
 * result slot — paragraph-level provenance, not a merged chapter slot; the
 * body/identity/chunk kinds coexist without conflict). Chapter-source hits
 * carry chapterId + span fields for 段级出处 (8.4 调查简报消费). (b) CR-005
 * structural fix: `status`/`visibility` are now entry_vec METADATA columns
 * (S1 DDL) — they pre-prune the KNN candidates exactly like entry_type, and
 * the final closure_entry WHERE belt stays as double insurance. The 8.7
 * vecK-x2/x4 compensation is retired (see buildRrfQuery).
 *
 * The module is the shared retrieval core for both the human command bar and
 * the AI `query_story` function call (design §8 downstream interface). The IPC
 * channel + agent tool are wired in VS1 阶段5 (scope fence: this module adds
 * neither).
 */

/** RRF fusion constant (industry standard, research §3). */
export const RRF_K = 60;

/**
 * Dependency-injection seam (ADR-2 "全注入", mirrors closureIndexer's
 * ReindexDeps). Tests pass stubs so the DB-integration suite runs (under the
 * Electron ABI) with ZERO network - no real embed/rerank endpoint is hit.
 * Production callers omit `deps` and get the real resolveEmbeddingModel +
 * generateEmbeddings + resolveRerankModel + rerank cloud API.
 */
export type RetrievalDeps = {
  /** Resolve the embedding model; null -> skip the vector arm. Defaults to resolveEmbeddingModel. */
  resolveModel?: () => ResolvedModel | null;
  /** Embed the query string -> vector. Defaults to a generateEmbeddings wrapper. */
  embed?: (model: ResolvedModel, text: string) => Promise<number[]>;
  /**
   * Resolve the rerank model; null -> skip the rerank stage (Story 2.1 shared
   * stage). Defaults to resolveRerankModel. Tests stub `() => null` to keep the
   * RRF-only path hermetic (no disk read).
   */
  resolveRerankModel?: () => ResolvedModel | null;
  /** Score docs against a query -> per-doc relevance. Defaults to a rerank wrapper. */
  rerank?: (model: ResolvedModel, query: string, docs: string[]) => Promise<number[]>;
};

/**
 * Default embed: one generateEmbeddings call, return the first vector.
 *
 * CR-04 follow-up: a 30s AbortSignal.timeout guards the call (mirrors the CR-06
 * fix on the on-save path in closureIndexer.defaultEmbed). A hung embed endpoint
 * must not stall a `query_story` call until the runLoop abort signal fires - the
 * timeout rejection lands in searchClosure's existing try/catch (logs + degrades
 * to FTS-only). 30s is generous for a single short query embed. AbortSignal.timeout
 * is available in Node 18+ / Electron.
 */
async function defaultEmbed(model: ResolvedModel, text: string): Promise<number[]> {
  // C3.1 计量台账：story KB 查询臂标签（与索引臂 kb-index-embed 区分——「检索 vs 重嵌」可分账）。
  const res = await generateEmbeddings(
    model,
    { input: [text] },
    { signal: AbortSignal.timeout(30_000), taskType: 'kb-query-embed' },
  );
  return res.embeddings[0] ?? [];
}

/**
 * Sanitize a free-text query into an FTS5 MATCH term, or `null` to skip the FTS
 * arm. Strips FTS5-special characters (`"` phrase delimiter, `*` prefix glob,
 * `:` column filter) so user input can never inject FTS5 query syntax (AND /
 * OR / NOT / NEAR / column filters), collapses whitespace, and wraps the
 * remainder as a single phrase (double-quoted). The trigram tokenizer matches
 * phrases as substrings, so this is substring search over name + body_text.
 * Returns null when the query is empty or sanitizes to empty (e.g. a query of
 * only special chars). Exported for unit testing.
 */
export function sanitizeFtsTerm(query: string): string | null {
  const stripped = query.replace(/["*:]/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  // All `"` have been stripped, so the closing quote is always well-formed.
  return `"${collapsed}"`;
}

/**
 * Pure RRF score computation - mirrors the SQL expression exactly so the
 * formula is auditable and unit-testable in plain vitest (no DB). `rank` is
 * 1-based (1 = best match in that arm); a null rank means the arm did not
 * surface the doc (contributes 0). Weights default to 1.0 (VS1 hardcodes equal
 * weight; per-intent weights are a downstream knob, design §8).
 */
export function computeRrfScore(
  ftsRank: number | null,
  vecRank: number | null,
  k: number = RRF_K,
  wFts: number = 1.0,
  wVec: number = 1.0,
): number {
  const f = ftsRank != null ? wFts / (k + ftsRank) : 0;
  const v = vecRank != null ? wVec / (k + vecRank) : 0;
  return f + v;
}

type ClosureRow = {
  entry_id: string;
  project_id: string;
  entry_type: string;
  source_kind: string;
  name: string;
  body_text: string;
  visibility: string;
  /** Story 8.7: entry-level one-liner summary (curated / generated; NULL = none). */
  summary_text: string | null;
  /** Story 8.7: vector_kind of the hit row ('body' | 'identity'; NULL = vec arm did not surface this hit). */
  vector_kind: string | null;
  /**
   * Story 8.3 chapter-source provenance: only source_kind='chapter' rows (body
   * chunks) carry these; every other source kind leaves them NULL (二态 — the
   * hit object omits the keys entirely). chapter_index may be NULL even on a
   * chunk row when the episode mapping failed at index time.
   */
  chapter_id: string | null;
  chapter_index: number | null;
  char_start: number | null;
  char_end: number | null;
  para_start: number | null;
  para_end: number | null;
  score: number;
  fts_rank: number | null;
  vec_distance: number | null;
};

function rowToHit(r: ClosureRow): EntryHit {
  return {
    entryId: r.entry_id,
    projectId: r.project_id,
    entryType: r.entry_type,
    sourceKind: r.source_kind,
    name: r.name,
    bodyText: r.body_text,
    visibility: r.visibility,
    score: r.score,
    ftsRank: r.fts_rank ?? undefined,
    vecDistance: r.vec_distance ?? undefined,
    // Story 8.7: summary is entry-level (present on every arm's SELECT); the
    // vector kind is only set when the vec arm surfaced this hit.
    summaryText: r.summary_text ?? undefined,
    vectorKind: r.vector_kind ?? undefined,
    // Story 8.3: span fields ride along ONLY on chapter rows (chapter_id is the
    // gate — chunk rows always write it, non-chapter rows never do). Keys are
    // absent on non-chapter hits AND absent-when-NULL on chapter hits (二态字段
    // 纪律, entryHitSchema JSDoc — B7：`?? undefined` 会留下显式 undefined 键，
    // Object.keys 可见差；条件展开让「无值 = 键不出现」半边契约也兑现).
    ...(r.chapter_id !== null
      ? {
          chapterId: r.chapter_id,
          ...(r.chapter_index !== null ? { chapterIndex: r.chapter_index } : {}),
          ...(r.char_start !== null ? { charStart: r.char_start } : {}),
          ...(r.char_end !== null ? { charEnd: r.char_end } : {}),
          ...(r.para_start !== null ? { paraStart: r.para_start } : {}),
          ...(r.para_end !== null ? { paraEnd: r.para_end } : {}),
        }
      : {}),
  };
}

type QueryPlan = {
  /** Which arms are active, recorded so the build branches stay in sync. */
  hasVec: boolean;
  hasFts: boolean;
};

/**
 * Assemble the RRF SQL + positional params for the four arm-combinations.
 *
 * - vec0 metadata `WHERE` supports ONLY `= != > >= < <=` (research §1/§6 - no
 *   `IN`/`LIKE`), so `project_id = ?` (partition key), `entry_type = ?`, and
 *   (Story 8.3) `status = ?` / `visibility = ?` are pushed inside vec0; tag-set
 *   / relation filters would need a SQL candidate set first (downstream).
 * - entry_type / status / visibility are applied in BOTH arms when provided:
 *   inside vec0 (prunes KNN candidates so k counts only matching rows — the
 *   Story 8.3 CR-005 structural fix: on a majority-deprecated project a
 *   status:'active' search no longer starves the vec pool, because rows the
 *   filter drops never consume k) AND in the final closure_entry WHERE
 *   (belt-and-suspenders for the FTS arm, which has no vec0 metadata).
 * - NULL-vs-sentinel alignment (S1 Electron probe): the vec0 metadata columns
 *   are NOT NULL, so rows without a card status (setting_md / chapter /
 *   chapter_summary sources) write the '' sentinel — which NEVER matches a
 *   concrete `= ?` filter, the exact semantics of SQL `=` against a NULL
 *   closure_entry.status. KNN pre-prune and final belt can never disagree.
 * - FTS5 `row_number() OVER (ORDER BY rank)` assigns rn over ALL matches before
 *   `LIMIT`; the statement-level `ORDER BY rank LIMIT ?` makes the limit
 *   deterministic and consistent with rn (best topN -> rn 1..topN).
 * - vec0 `k = ?` caps the vec candidates to the nearest rows. Story 8.7
 *   dual-vector: k counts VECTOR ROWS and a long doc occupies two (#body +
 *   #identity), so the row budget is doubled to hold the distinct-entry pool at
 *   topN after the per-entry dedupe below (recall parity with the single-vector
 *   era; vec0 brute-force makes a larger k ~zero marginal cost). Chapter chunk
 *   entries hold exactly ONE vector row each, so the same budget holds topN
 *   chunks (per-chunk ranking preserved through the dedupe).
 */
function buildRrfQuery(args: {
  projectId: string;
  entryType?: string;
  status?: string;
  visibility?: string;
  k: number;
  topN: number;
  qVec: Buffer | null;
  ftsTerm: string | null;
  vecArm: boolean;
}): { sql: string; params: unknown[]; plan: QueryPlan } {
  const { projectId, entryType, status, visibility, k, topN, qVec, ftsTerm, vecArm } = args;
  const hasVec = qVec !== null && vecArm;
  const hasFts = ftsTerm !== null;

  // Final closure_entry filter (always enforced so cross-project rows never leak,
  // even though the vec0 partition already isolates by project_id). Built as a
  // fragment + param list so entry_type / status / visibility compose without
  // positional-param drift (Story 8.7 extends the single-filter etFilter shape).
  const whereFrags: string[] = [];
  const whereParams: unknown[] = [];
  if (entryType) {
    whereFrags.push('c.entry_type = ?');
    whereParams.push(entryType);
  }
  if (status) {
    whereFrags.push('c.status = ?');
    whereParams.push(status);
  }
  if (visibility) {
    whereFrags.push('c.visibility = ?');
    whereParams.push(visibility);
  }
  const entryFilter = whereFrags.length ? ` AND ${whereFrags.join(' AND ')}` : '';

  // vec0 internal metadata pre-prune (Story 8.3 CR-005 structural fix):
  // entry_type / status / visibility compose as fragment + param pairs so the
  // positional params can never drift from the WHERE text (mirrors the
  // whereFrags shape below).
  const vecMetaFrags: string[] = [];
  const vecMetaParams: unknown[] = [];
  if (entryType) {
    vecMetaFrags.push(' AND entry_type = ?');
    vecMetaParams.push(entryType);
  }
  if (status) {
    vecMetaFrags.push(' AND status = ?');
    vecMetaParams.push(status);
  }
  if (visibility) {
    vecMetaFrags.push(' AND visibility = ?');
    vecMetaParams.push(visibility);
  }
  const vecMeta = vecMetaFrags.join('');
  // vecK counts VECTOR ROWS: a long doc occupies two (#body + #identity), so
  // the row budget is doubled to hold the distinct-entry pool at topN after the
  // per-entry dedupe below. Story 8.3 RETIRES the 8.7 CR-005 x2/x4
  // compensation entirely: status/visibility now pre-prune INSIDE the KNN
  // (vec0 metadata columns, S1 DDL; the '' sentinel for a NULL closure_entry
  // status never matches a concrete filter — S1 Electron probe conclusion, so
  // the pre-prune and the closure_entry SQL-NULL belt agree), meaning k counts
  // only net candidates again. Chunk entries hold one vector row each.
  const vecK = topN * 2;

  // Story 8.7 dual-vector KNN CTE chain, shared by the vec-only and both-arms
  // cases. KNN runs over ALL vector rows (#body + #identity, kind NEVER
  // filtered - 双臂齐搜; which kind won is decided by this board).
  // - `vec_rows` is MATERIALIZED to isolate the vec0 KNN scan: vec0 rejects a
  //   KNN query with more than one ORDER BY or an ORDER BY on a non-distance
  //   column ("Only a single 'ORDER BY distance' clause is allowed on vec0 KNN
  //   queries"), and without the materialization barrier SQLite's subquery
  //   flattening would push the dedupe's GROUP BY / window ORDER BY into the
  //   vtab scan and trip that limit.
  // - `vec_best` dedupes to each entry's BEST (nearest) row. The min()
  //   bare-column rule (SQLite documented quirk: with exactly ONE min()/max()
  //   aggregate, bare columns take values from the row holding the min) carries
  //   THAT row's vector_kind as the hit's kind - ties between a doc's equally-
  //   near rows resolve to an arbitrary one of them (both kinds matched equally
  //   well, so either label is honest).
  // - `vec_matches` assigns rn over the DEDUPED set: one entry = one vec rank,
  //   so RRF fusion stays per-doc (an FTS match joined against two vec rows
  //   would double-count the fts contribution and burn result slots on
  //   duplicates). Story 8.3: a chapter chunk entry has a single 'chunk' vector
  //   row, so chunks survive the dedupe as independent entries — same-chapter
  //   multi-chunk hits each keep their own slot (per-chunk ranking by design,
  //   §2.4 dedupe semantics check: zero behavioural change needed, the GROUP BY
  //   already does the right thing for all three kinds).
  const vecCtes = `
          vec_rows AS MATERIALIZED (
            SELECT entry_id, vector_kind, distance
            FROM entry_vec
            WHERE embedding MATCH ? AND k = ? AND project_id = ?${vecMeta}
          ),
          vec_best AS (
            SELECT entry_id, vector_kind, min(distance) AS distance
            FROM vec_rows
            GROUP BY entry_id
          ),
          vec_matches AS (
            SELECT entry_id, vector_kind, distance,
                   row_number() OVER (ORDER BY distance) AS rn
            FROM vec_best
          )`;

  // Case 4: structured-only (no vector + empty/unsanitizable query). Returns
  // recent entries by project/type with score 0 - "nothing to search, here is
  // the registry". No FTS/vec dependency, so this also serves as the last-ditch
  // fallback when both arms are unavailable.
  if (!hasVec && !hasFts) {
    return {
      sql: `SELECT c.entry_id AS entry_id, c.project_id AS project_id, c.entry_type AS entry_type,
                   c.source_kind AS source_kind, c.name AS name, c.body_text AS body_text,
                   c.visibility AS visibility, c.summary_text AS summary_text,
                   c.chapter_id AS chapter_id, c.chapter_index AS chapter_index,
                   c.char_start AS char_start, c.char_end AS char_end,
                   c.para_start AS para_start, c.para_end AS para_end,
                   NULL AS vector_kind, 0 AS score, NULL AS fts_rank, NULL AS vec_distance
            FROM closure_entry c
            WHERE c.project_id = ?${entryFilter}
            ORDER BY c.updated_at DESC
            LIMIT ?`,
      params: [projectId, ...whereParams, k],
      plan: { hasVec: false, hasFts: false },
    };
  }

  // Case 2: FTS-only (vector arm skipped - offline / no model / vec unloaded).
  if (hasFts && !hasVec) {
    return {
      sql: `WITH fts_matches AS (
              SELECT entry_id, row_number() OVER (ORDER BY rank) AS rn, rank
              FROM entry_fts
              WHERE entry_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            )
            SELECT c.entry_id AS entry_id, c.project_id AS project_id, c.entry_type AS entry_type,
                   c.source_kind AS source_kind, c.name AS name, c.body_text AS body_text,
                   c.visibility AS visibility, c.summary_text AS summary_text,
                   c.chapter_id AS chapter_id, c.chapter_index AS chapter_index,
                   c.char_start AS char_start, c.char_end AS char_end,
                   c.para_start AS para_start, c.para_end AS para_end,
                   NULL AS vector_kind,
                   coalesce(1.0 / (${RRF_K} + f.rn), 0) AS score,
                   f.rank AS fts_rank, NULL AS vec_distance
            FROM fts_matches f
            JOIN closure_entry c ON c.entry_id = f.entry_id
            WHERE c.project_id = ?${entryFilter}
            ORDER BY score DESC
            LIMIT ?`,
      params: [ftsTerm, topN, projectId, ...whereParams, k],
      plan: { hasVec: false, hasFts: true },
    };
  }

  // Case 3: vec-only (query had non-whitespace content for embedding but
  // sanitized to an empty FTS term - e.g. a query of only `*"":` special chars).
  if (hasVec && !hasFts) {
    return {
      sql: `WITH${vecCtes}
            SELECT c.entry_id AS entry_id, c.project_id AS project_id, c.entry_type AS entry_type,
                   c.source_kind AS source_kind, c.name AS name, c.body_text AS body_text,
                   c.visibility AS visibility, c.summary_text AS summary_text,
                   c.chapter_id AS chapter_id, c.chapter_index AS chapter_index,
                   c.char_start AS char_start, c.char_end AS char_end,
                   c.para_start AS para_start, c.para_end AS para_end,
                   v.vector_kind AS vector_kind,
                   coalesce(1.0 / (${RRF_K} + v.rn), 0) AS score,
                   NULL AS fts_rank, v.distance AS vec_distance
            FROM vec_matches v
            JOIN closure_entry c ON c.entry_id = v.entry_id
            WHERE c.project_id = ?${entryFilter}
            ORDER BY score DESC
            LIMIT ?`,
      params: [qVec, vecK, projectId, ...vecMetaParams, projectId, ...whereParams, k],
      plan: { hasVec: true, hasFts: false },
    };
  }

  // Case 1: both arms - FULL OUTER JOIN fusion (the canonical RRF shape).
  return {
    sql: `WITH${vecCtes},
          fts_matches AS (
            SELECT entry_id, row_number() OVER (ORDER BY rank) AS rn, rank
            FROM entry_fts
            WHERE entry_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          )
          SELECT c.entry_id AS entry_id, c.project_id AS project_id, c.entry_type AS entry_type,
                 c.source_kind AS source_kind, c.name AS name, c.body_text AS body_text,
                 c.visibility AS visibility, c.summary_text AS summary_text,
                 c.chapter_id AS chapter_id, c.chapter_index AS chapter_index,
                 c.char_start AS char_start, c.char_end AS char_end,
                 c.para_start AS para_start, c.para_end AS para_end,
                 v.vector_kind AS vector_kind,
                 (coalesce(1.0 / (${RRF_K} + f.rn), 0) + coalesce(1.0 / (${RRF_K} + v.rn), 0)) AS score,
                 f.rank AS fts_rank, v.distance AS vec_distance
          FROM fts_matches f
          FULL OUTER JOIN vec_matches v ON v.entry_id = f.entry_id
          JOIN closure_entry c ON c.entry_id = coalesce(f.entry_id, v.entry_id)
          WHERE c.project_id = ?${entryFilter}
          ORDER BY score DESC
          LIMIT ?`,
    params: [
      qVec,
      vecK,
      projectId,
      ...vecMetaParams,
      ftsTerm,
      topN,
      projectId,
      ...whereParams,
      k,
    ],
    plan: { hasVec: true, hasFts: true },
  };
}

/**
 * Pure predicate (CR-04): should the hybrid query be retried FTS-only after the
 * first attempt threw at RUNTIME?
 *
 * `buildRrfQuery` picks Case 1 (both arms, a single SELECT with a `vec_matches`
 * CTE + `fts_matches` CTE) whenever a query vector is available at BUILD time
 * (`qVec !== null`). But vec0 can THROW at RUNTIME - corrupt vec index, a
 * zero/degenerate query vector, a dim race with a concurrent reindexAll, an
 * internal MATCH edge. When that happens the whole `.all()` rejects, including
 * the FTS CTE that would have surfaced hits on its own. The retry rebuilds the
 * query with `qVec=null` (-> Case 2, FTS-only + RRF single-arm) so the FTS hits
 * that WOULD have surfaced are not lost along with the vec failure. This makes
 * the module's "vec unavailable -> degrade to FTS + structured + RRF" promise
 * (docstring above) hold at RUNTIME, not just at BUILD time (qVec=null -> Case 2).
 *
 * Returns true ONLY when the failed query had BOTH a vec arm AND an FTS arm:
 * - vec + fts (Case 1 failed) -> retry FTS-only (Case 2). TRUE.
 * - vec-only (Case 3, no FTS arm) -> an FTS-only retry has nothing to run. FALSE.
 * - fts-only already (Case 2 failed) -> retrying the SAME query throws identically. FALSE.
 * - structured-only (Case 4, no arms) -> no FTS arm. FALSE.
 *
 * Extracted from `searchClosure` so the retry DECISION is unit-testable in plain
 * vitest (the DB-execution path itself skips under plain vitest on ABI mismatch).
 */
export function shouldRetryFtsOnly(
  failedQueryHadVec: boolean,
  ftsTerm: string | null,
): boolean {
  return failedQueryHadVec && ftsTerm !== null;
}

/**
 * Run a hybrid retrieval against the closure derived index.
 *
 * @param projectId scope (vec0 partition key + closure_entry filter).
 * @param query free-text query (embedded for the vector arm; sanitized + phrase-
 *   quoted for the FTS arm).
 * @param opts entryType / status / visibility (structured pre-filters, applied
 *   inside the vec0 KNN metadata AND in the final closure_entry WHERE — Story
 *   8.3 CR-005 structural fix; a NULL status row never matches a status filter,
 *   and the vec0 '' sentinel behaves identically), k (final result count,
 *   default 10), topN (per-arm candidate depth fed into RRF, default 20 -
 *   research §3).
 * @param deps DI seam for tests (stubbed embed/resolveModel -> zero network).
 * @returns ranked EntryHit[] (empty on best-effort failure - never throws).
 */
export async function searchClosure(
  projectId: string,
  query: string,
  opts?: { entryType?: string; status?: string; visibility?: string; k?: number; topN?: number },
  deps?: RetrievalDeps,
): Promise<EntryHit[]> {
  const k = opts?.k ?? 10;
  const topN = opts?.topN ?? 20;
  // RRF fetches `candidateLimit` candidates so the shared rerank stage has a
  // pool to re-order (rerank topN -> top-k). When rerank is unavailable the stage
  // degrades to `slice(0, k)`, so fetching `max(k, topN)` is correct in both
  // paths: rerank-on  -> rerank topN candidates down to k; rerank-off -> slice
  // the RRF-ordered pool to k. (Story 2.1 additive: previously LIMIT was `k`.)
  const candidateLimit = Math.max(k, topN);
  const entryType = opts?.entryType;
  const status = opts?.status;
  const visibility = opts?.visibility;
  const resolveModel = deps?.resolveModel ?? resolveEmbeddingModel;
  const embed = deps?.embed ?? defaultEmbed;
  // getDb() is a singleton getter; hoist it so the embed dim check can read the
  // live entry_vec dim (a re-created float[newDim] table from reindexAll R7 must
  // be respected - the query vec has to match the stored vecs' current dim).
  const db = getDb();
  const vecDim = getCurrentVecDim(db);

  // 1. Embed the query (async, best-effort). qVec stays null when there is no
  //    model, the vec extension is not loaded (skip the network call too - no
  //    point embedding a query vec0 cannot match), the query is blank, the
  //    endpoint fails, or the returned dim does not match the live vec0 schema
  //    (float[N], read dynamically so a reindexAll dim swap is respected). Any
  //    of these -> vector arm skipped, query degrades.
  let qVec: Buffer | null = null;
  const vecArm = isSqliteVecAvailable();
  const model = resolveModel();
  if (model && vecArm && query.trim()) {
    try {
      const vecArr = await embed(model, query);
      if (vecDim !== null && vecArr.length === vecDim) {
        qVec = floatArrayToBuffer(vecArr);
      } else {
        getLogger().warn(
          { expected: vecDim, got: vecArr.length, model: model.modelId },
          'closure retrieval: query embedding dim mismatch - skipping vector arm',
        );
      }
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'closure retrieval: query embed failed - skipping vector arm',
      );
    }
  }

  // 2. Sanitize the FTS query (independent of the embed check: a query of only
  //    special chars has non-blank content for embedding but sanitizes to empty
  //    for FTS -> vec-only path).
  const ftsTerm = sanitizeFtsTerm(query);

  // 3. Build + run the conditional RRF query. The build is a pure function of
  //    `qVec`; the run is the part that can throw at RUNTIME (vec0 / FTS5 /
  //    MATCH edges). Extracting `runQuery(qVecOverride)` lets the catch path
  //    re-run with `qVec=null` (Case 2, FTS-only) when the both-arms query threw
  //    - so a vec0 runtime failure does not take the FTS hits down with it (CR-04).
  const runQuery = (qVecOverride: Buffer | null): EntryHit[] => {
    const { sql, params } = buildRrfQuery({
      projectId,
      entryType,
      status,
      visibility,
      k: candidateLimit,
      // CR-craft-kb-006: the per-arm CTE LIMIT (FTS `LIMIT ?`) AND vec0 `k=?`
      // take `topN`. Bumping `topN` to `candidateLimit` means k in [21, 50] is
      // satisfiable in single-arm mode too (previously hard-capped at 20: the
      // outer LIMIT was candidateLimit=50 but the FTS CTE only ever surfaced 20
      // rows). vec0's KNN count grows accordingly, which is correct - more
      // candidates feed both rerank and the final slice.
      topN: candidateLimit,
      qVec: qVecOverride,
      ftsTerm,
      vecArm,
    });
    const rows = db.prepare(sql).all(...params) as ClosureRow[];
    return rows.map(rowToHit);
  };

  try {
    const hits = runQuery(qVec);
    // Shared cross-encoder rerank stage (Story 2.1): RRF topN -> rerank -> top-k.
    // Additive + best-effort: no rerank model / endpoint fail / timeout -> degrades
    // to RRF top-k (slice(0, k)), i.e. the pre-2.1 behavior. Does NOT change
    // EntryHit shape (only attaches optional rerankScore). query_story benefits
    // transparently - its handler + tests are unchanged.
    return await rerankCandidates(query, hits, k, {
      resolveModel: deps?.resolveRerankModel,
      rerank: deps?.rerank,
      taskType: 'kb-rerank', // C3.1 计量台账：story KB 检索的 rerank 标签（craft 检索标 craft-rerank）
    });
  } catch (err) {
    // Best-effort: a sanitized FTS term should never produce a syntax error,
    // but a vec0/FTS5 internal failure or an unexpected MATCH edge must not
    // crash the caller (Writer function call). CR-04: if the failed query had
    // BOTH arms (Case 1), the vec arm may be the only thing broken - retry as
    // Case 2 (FTS-only, qVec=null) so the FTS hits that would have surfaced are
    // not lost along with the vec failure. This holds the module's "vec failure
    // -> degrade to FTS + structured + RRF" promise at RUNTIME, not just BUILD time.
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectId, entryType, status, visibility },
      'closure retrieval: hybrid query failed',
    );
    if (shouldRetryFtsOnly(qVec !== null && vecArm, ftsTerm)) {
      try {
        getLogger().warn(
          { projectId, entryType },
          'closure retrieval: retrying FTS-only (vec arm dropped)',
        );
        const retryHits = runQuery(null); // -> Case 2 (FTS-only + RRF single-arm)
        // The rerank stage applies to the retry path too (rerank is
        // arm-agnostic - it re-orders whatever RRF surfaced).
        return await rerankCandidates(query, retryHits, k, {
          resolveModel: deps?.resolveRerankModel,
          rerank: deps?.rerank,
          taskType: 'kb-rerank',
        });
      } catch (err2) {
        getLogger().warn(
          { err: err2 instanceof Error ? err2.message : String(err2), projectId, entryType },
          'closure retrieval: FTS-only retry also failed - returning empty',
        );
      }
    }
    return [];
  }
}
