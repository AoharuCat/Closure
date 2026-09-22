import type {
  RerankRequest,
  RerankResponse,
  ResolvedModel,
} from '@orison/shared-contracts';
import { normalizeBaseUrl, postJson, getInsecureDispatcher } from './http';
import { withRetry } from './retry';
// C3.1：失败行分类单源复用子2 判据（rerank 在 errors↔generate 既有 documented cycle
// 环外——errors 的 import 闭包不含 rerank，本边不成环）。
import { classifyGenerationFailure } from './errors';
// C3.1：计量 wrapper 共享宿（usageSink 零项目模块运行时依赖——引它不进任何环）。
import { withEntryUsageMetering } from './usageSink';
import type { ProtocolCallContext } from './types';

// ── Rerank (direct HTTP POST /rerank) ──
//
// Cross-encoder rerank for the KB retrieval stage (Story 2.1). Kept as direct
// HTTP - same as embeddings / image generation - the Vercel AI SDK has no rerank
// helper. Single-path Cohere/Jina-style `POST /v1/rerank` shape: every rerank
// endpoint (Cohere, Jina, Voyage, ZeroEntropy, self-hosted TEI via localhost)
// serves `{model, query, documents, top_n}` -> `{results: [{index, relevance_score}]}`.
// Anthropic offers no rerank API, so - like embeddings - we do NOT branch on
// model.protocol. `model` is injected from the resolved ModelRef at the protocol
// layer, so the request only carries `query` + `documents` + optional `top_n`.
//
// `normalizeBaseUrl` appends `/v1` (user may omit it), so the call lands on
// `${baseUrl}/rerank` - Jina's `/v1/rerank` and Cohere's compatibility path. A
// self-hosted Text Embeddings Inference (TEI) rerank endpoint is reachable by
// pointing baseUrl at localhost (KB README §5.1).
//
// Response re-ordering: providers return `results[]` sorted by relevance DESC,
// each carrying the ORIGINAL `index` of the document it scores. We re-order back
// to INPUT order so callers can zip `scores[i]` to `documents[i]` by index
// (mirrors how generateEmbeddings preserves `data[]` input order). Missing
// indices (a provider omitted a doc) default to score 0.
//
// CR-craft-kb-008: provider response shapes vary. Besides `relevance_score`
// (Cohere/Jina), some providers (TEI localhost, ZeroEntropy variants) use a
// `score` key. And some omit `index` entirely, returning one result per input
// document IN INPUT ORDER (not relevance-sorted) - when `index` is absent we
// fall back to positional alignment (results[i] -> documents[i]). A response
// where every score is the default 0 is suspicious (likely a shape mismatch /
// silent no-op) - warn so the operator notices (the retrieval core degrades to
// RRF top-k on all-zero scores, which is correct but invisible without this).

type RerankResult = { index?: number; relevance_score?: number; score?: number };
type RerankApiResponse = {
  results?: RerankResult[];
  // Some providers use `data[]` instead of `results[]` (OpenAI-style shape).
  data?: RerankResult[];
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

export async function rerank(
  model: ResolvedModel,
  request: RerankRequest,
  ctx?: ProtocolCallContext,
): Promise<RerankResponse> {
  // C3.1：计量 wrapper（design §1）——usage {promptTokens,totalTokens} 有则记、
  // outputTokens 端点不报恒 ABSENT（CR-18）。taskType 走 ctx 通道、物理点读 ctx 不
  // 硬编码（'kb-rerank' / 'craft-rerank' 由调用方闭包透传，M2 修正）。
  return withEntryUsageMetering(
    { model, ctx, usageOf: (r) => r.usage },
    (err) => classifyGenerationFailure(err).kind,
    () => rerankViaHttp(model, request, ctx),
  );
}

async function rerankViaHttp(
  model: ResolvedModel,
  request: RerankRequest,
  ctx?: ProtocolCallContext,
): Promise<RerankResponse> {
  const baseUrl = normalizeBaseUrl(model.baseUrl);
  const body: Record<string, unknown> = {
    model: model.modelId,
    query: request.query,
    documents: request.documents,
  };
  if (request.top_n !== undefined) body.top_n = request.top_n;

  const raw = await withRetry(
    () =>
      postJson<RerankApiResponse>({
        url: `${baseUrl}/rerank`,
        // 09-12 子3 §3 ⑥：customHeaders 随该 key 全部请求发出 + per-key 证书校验跳过。
        headers: { authorization: `Bearer ${model.apiKey}`, ...model.customHeaders },
        body,
        signal: ctx?.signal,
        dispatcher: model.verifySsl === true ? getInsecureDispatcher() : undefined,
      }),
    { signal: ctx?.signal },
  );

  const results = raw.results ?? raw.data ?? [];
  // Re-order provider's results back to INPUT document order. CR-craft-kb-008:
  // accept `score` as an alias for `relevance_score`, and fall back to POSITIONAL
  // alignment when `index` is absent (provider returned one result per doc in
  // input order).
  const scores = new Array<number>(request.documents.length).fill(0);
  let anyNonZero = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const hasIndex = typeof r.index === 'number' && r.index >= 0 && r.index < scores.length;
    const idx = hasIndex ? (r.index as number) : i;
    if (idx >= scores.length) continue; // out-of-range index, skip defensively
    const score = r.relevance_score ?? r.score ?? 0;
    scores[idx] = score;
    if (score !== 0) anyNonZero = true;
  }

  // CR-craft-kb-008: all-zero scores after a non-empty results array likely mean
  // a response-shape mismatch (the provider put scores under a key we don't
// read, so every doc defaulted to 0). The retrieval core degrades correctly
// (RRF top-k), but the operator should notice the silent no-op.
  if (!anyNonZero && results.length > 0) {
    console.warn(
      '[model-protocols] rerank: all scores are 0 - likely a provider response-shape mismatch',
      { model: model.modelId, resultCount: results.length },
    );
  }

  return {
    model: raw.model ?? model.modelId,
    scores,
    usage: raw.usage
      ? {
          promptTokens: raw.usage.prompt_tokens,
          totalTokens: raw.usage.total_tokens,
        }
      : undefined,
  };
}
