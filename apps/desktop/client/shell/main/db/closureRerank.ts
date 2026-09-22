import type { ResolvedModel } from '@orison/shared-contracts';
import { rerank } from '@orison/model-protocols';
import { resolveRerankModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

/**
 * Shared cross-encoder rerank stage for the KB retrieval core (Story 2.1).
 *
 * "永远 rerank" (rerank-embedding-commandbar-research.md §1C RAG-paradox): rerank
 * compresses the LLM context (50 -> 5) with a cross-encoder, and the net latency
 * often DECREASES (smaller downstream context). So the retrieval core ALWAYS
 * attempts rerank when a rerank model is available - it is never an afterthought.
 *
 * AGENT-001 / 范式判据 (ADR-3): rerank = cross-encoder scoring = retrieval =
 * pure-code, NOT LLM generation. It consumes no LLM budget. The rerank cloud API
 * is a scoring call, not a generation call.
 *
 * Offline / best-effort degradation (mirror of searchClosure's vec-arm degrade):
 * no rerank model, endpoint failure, timeout, or a score-count mismatch -> the
 * stage is SKIPPED and the input RRF-ordered hits are returned (sliced to k).
 * Rerank never blocks retrieval - it only refines when it can.
 *
 * Shared by BOTH `searchClosure` (project closure_* index) and `searchCraft`
 * (global closure_craft_* index). `searchClosure` calling this is ADDITIVE: it
 * fetches RRF topN candidates, reranks to top-k, and does NOT change EntryHit
 * shape (only adds optional `rerankScore`). Existing query_story tests stay green
 * via the degrade path (no rerank model -> RRF top-k = current behavior).
 */

/**
 * Dependency-injection seam (mirrors RetrievalDeps / ReindexDeps). Tests pass
 * stubs so the DB-integration suite runs (under the Electron ABI) with ZERO
 * network - no real rerank endpoint is hit. Production callers omit `deps` and
 * get the real resolveRerankModel + rerank cloud API.
 */
export type RerankDeps = {
  /** Resolve the rerank model; null -> skip the rerank stage. Defaults to resolveRerankModel. */
  resolveModel?: () => ResolvedModel | null;
  /** Score `docs` against `query` -> per-doc relevance (aligned to input order). Defaults to a rerank wrapper. */
  rerank?: (model: ResolvedModel, query: string, docs: string[]) => Promise<number[]>;
  /**
   * C3.1 计量台账：调用方标签透传（'kb-rerank' / 'craft-rerank'）——本模块被 searchClosure
   * 与 searchCraft 双消费，物理点（defaultRerank）读透传值不硬编码，ledger byTask 才能把
   * KB 检索与 craft 检索的 rerank 成本分开。缺省 undefined = 未标注（NULL 组）。
   */
  taskType?: string;
};

/**
 * Default rerank: one cloud API call, return scores aligned to input order.
 *
 * 30s `AbortSignal.timeout` (mirrors defaultEmbed CR-06 / closureRetrieval
 * defaultEmbed): a hung rerank endpoint must not stall a `query_story` /
 * `query_craft` call. The timeout rejection lands in rerankCandidates' try/catch
 * (logs + degrades to RRF top-k). 30s is generous for a single rerank batch.
 *
 * C3.1：taskType 经 ctx 透传给协议层 rerank wrapper（调用方标签，物理点不硬编码）。
 */
async function defaultRerank(
  model: ResolvedModel,
  query: string,
  docs: string[],
  taskType: string | undefined,
): Promise<number[]> {
  const res = await rerank(
    model,
    { query, documents: docs },
    { signal: AbortSignal.timeout(30_000), taskType },
  );
  return res.scores;
}

/**
 * Build the plain-text doc the cross-encoder scores (Story 8.7 rerank doc 前缀,
 * design §3.2): `【name】summary\nbody`.
 *
 * Why the prefix: the rerank input is a plain text array — the cross-encoder
 * only sees the blob it is handed. A long doc's body opening may not identify
 * the entry at all, so an identity-relevant query ("who guards the tower?")
 * scores poorly against a body that never names its subject early. Prefixing
 * the name + one-line summary gives the reranker the entry's identity cheaply
 * (a few dozen chars, cost ≈ 0 vs the body). Falls back gracefully: no name /
 * no summary -> the bare body (pre-8.7 behavior).
 *
 * Exported for unit testing (mirror sanitizeFtsTerm / computeRrfScore).
 */
export function buildRerankDoc(h: {
  name?: string;
  summaryText?: string;
  bodyText: string;
}): string {
  const head = `${h.name ? `【${h.name}】` : ''}${h.summaryText ?? ''}`.trim();
  return head ? `${head}\n${h.bodyText}` : h.bodyText;
}

/**
 * RRF top-N -> cross-encoder rerank -> top-k. Pure orchestration over the
 * `rerank` cloud API (pure-code, AGENT-001 compliant).
 *
 * @param query  the user query (cross-encoder scores each doc against this).
 * @param hits   RRF-ordered candidates (already carrying bodyText). MUST have
 *   `bodyText` + optional `name`/`summaryText` (Story 8.7: composed into the
 *   rerank doc header via `buildRerankDoc`) + optional `rerankScore` (attached
 *   on return).
 * @param k      final result count.
 * @param deps   DI seam for tests (stubbed rerank/resolveModel -> zero network).
 * @returns reranked top-k hits (with `rerankScore` set), or RRF top-k on degrade.
 *   Never throws - a rerank failure degrades to the input order.
 */
export async function rerankCandidates<T extends {
  bodyText: string;
  rerankScore?: number;
  name?: string;
  summaryText?: string;
}>(
  query: string,
  hits: T[],
  k: number,
  deps?: RerankDeps,
): Promise<T[]> {
  // Trivial cases: nothing to rerank. slice(0, k) preserves the RRF order.
  if (hits.length <= 1) return hits.slice(0, k);
  // No query text -> cross-encoder has nothing to score against -> degrade.
  if (!query.trim()) return hits.slice(0, k);

  const resolveModel = deps?.resolveModel ?? resolveRerankModel;
  const rerankFn = deps?.rerank ?? ((model, query, docs) => defaultRerank(model, query, docs, deps?.taskType));

  let model: ResolvedModel | null;
  try {
    model = resolveModel();
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'rerank: resolveModel threw - skipping rerank stage',
    );
    return hits.slice(0, k);
  }
  if (!model) return hits.slice(0, k); // no rerank model configured -> degrade

  try {
    // Story 8.7: each doc is the body prefixed with the entry's name+summary
    // header (identity aid for the cross-encoder, see buildRerankDoc).
    const docs = hits.map((h) => buildRerankDoc(h));
    const scores = await rerankFn(model, query, docs);
    // Defensive: a malformed response (wrong score count) must not reorder hits
    // by garbage - degrade to the RRF order.
    if (scores.length !== hits.length) {
      getLogger().warn(
        { expected: hits.length, got: scores.length, model: model.modelId },
        'rerank: score count mismatch - skipping rerank stage',
      );
      return hits.slice(0, k);
    }
    const scored = hits.map((h, i) => ({ ...h, rerankScore: scores[i] }));
    scored.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
    return scored.slice(0, k);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), model: model.modelId },
      'rerank: endpoint failed - skipping rerank stage (RRF top-k)',
    );
    return hits.slice(0, k);
  }
}
