import { z } from 'zod';
import { modelRefSchema } from './generation';

// ── Global craft KB hybrid retrieval (ADR-3 / Story 2.1) ──
//
// Mirror of `closure-retrieval.ts` for the GLOBAL craft reference library. The
// craft KB is cross-project (no project_id): source of truth is markdown docs
// under `~/.orison/craft-kb/` (+ bundled read-only seeds), materialized into the
// `closure_craft_*` derived index (same projects.db engine, single getDb()
// singleton - db spec). `query_craft` is the AI-side front (agent tool ->
// remoteToolProxy -> unified toolExecution channel -> shell handler -> searchCraft),
// mirroring `query_story` exactly EXCEPT it carries no projectId (global scope).
//
// craft_type is an OPEN string (z.string()), not a closed enum - the 8-class
// taxonomy + uncategorized catch-all live in `craft-type-vocab.ts` as a prior
// (curation vocabulary for prompt injection / UI completion), mirroring Story 1.9
// `narrative-enums.ts` (非封闭枚举: 自由值 + 策展词表先验). A user writing a new
// craft_type in a doc's frontmatter self-registers a new class with zero
// migration (avoids ADR-3 假信心门 + 写作思维原理 :474 过度解构).

/**
 * A single craft-KB retrieval hit. `score` is the RRF combined score (higher =
 * better); `ftsRank`/`vecDistance` expose which arm matched; `rerankScore` is
 * present when the cross-encoder rerank stage ran (Story 2.1 shared rerank stage).
 *
 * Mirrors `EntryHit` with these differences: `craftId` (not entryId), no
 * `projectId` (global), `craftType` (not entryType), no `visibility` (craft docs
 * are all public).
 *
 * - `summaryText`: 一段话简述（Story 8.7 additive optional，mirror EntryHit）——undefined =
 *   该文档未生成简述。
 * - `vectorKind`: 向量命中类别（Story 8.7 双向量分型，mirror EntryHit）：'identity' = 身份向量
 *   命中（名字+类型+简述——「它是干什么的」相关）/ 'body' = 全文向量命中（内容语义相关）。
 *   undefined = vec 臂未参与该 hit（FTS-only 降级）。开放 string 非 enum——8.3 chunk 向量将扩第三类。
 */
export const craftHitSchema = z.object({
  craftId: z.string(),
  craftType: z.string(),
  sourceKind: z.string(),
  name: z.string(),
  bodyText: z.string(),
  score: z.number(),
  ftsRank: z.number().optional(),
  vecDistance: z.number().optional(),
  rerankScore: z.number().optional(),
  summaryText: z.string().optional(),
  vectorKind: z.string().optional(),
});

export type CraftHit = z.infer<typeof craftHitSchema>;

/**
 * `query_craft` agent tool input (Story 2.1; mirrors `closureStoryQuerySchema`).
 *
 * Deliberately has NO `projectId`: the craft KB is global. The shell handler
 * calls `searchCraft(query, {craftType, tags, k})` directly with no project scope.
 *
 * `k` is CLAMPED to [1, 50] (same rationale as closureStoryQuerySchema): a bad
 * LLM param can never produce an unbounded SQLite `LIMIT` or an empty result,
 * and never crashes the tool call (handler "never throws" contract).
 *
 * `tags`（E10.2b W4.2 / R10 自由标签检索）：手艺卡自由标签过滤——**任一命中即召回**
 * （OR 语义），可与 query/craft_type 组合；query 为空 + tags 在场 = 纯标签浏览（handler
 * 放行、searchCraft 走结构化过滤路径）。可用标签来自命中渲染的「标签: #…」行（标签
 * 发现机制）。与 craft_type 刻意同形：open string 数组非封闭枚举——标签是自由 facet
 * （R10 红线：只约束类目不约束标签）。
 */
export const closureCraftQuerySchema = z.object({
  query: z.string().default(''),
  craft_type: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  k: z.number().int().default(10).transform((v) => Math.max(1, Math.min(50, v))),
});

export type ClosureCraftQuery = z.infer<typeof closureCraftQuerySchema>;

// ── Rerank endpoint contract (Story 2.1; mirrors embedding schemas) ──
//
// Cross-encoder rerank is a retrieval-stage pure-code call (ADR-3 范式判据:
// rerank = cross-encoder scoring = retrieval, NOT LLM generation - AGENT-001
// compliant, consumes no LLM budget). The cloud API is Cohere/Jina-style
// `POST /v1/rerank` with `{model, query, documents, top_n}` returning per-document
// relevance scores. `model` is injected from the resolved ModelRef at the
// protocol layer, so the request only carries `query` + `documents`.
//
// `documents` is the batch (one call scores many docs); the response returns
// `scores` ALIGNED TO INPUT ORDER (the protocol layer re-orders the provider's
// relevance-sorted `results[]` back to input index), so callers can zip scores
// back to their source docs by index (mirrors how generateEmbeddings preserves
// `data[]` order).

export const rerankRequestSchema = z.object({
  query: z.string(),
  documents: z.array(z.string()).min(1),
  top_n: z.number().int().positive().optional(),
});

export const rerankResponseSchema = z.object({
  model: z.string(),
  scores: z.array(z.number()),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
    })
    .partial()
    .optional(),
});

export const rerankPayloadSchema = z.object({
  ref: modelRefSchema,
  request: rerankRequestSchema,
});

export type RerankRequest = z.infer<typeof rerankRequestSchema>;
export type RerankResponse = z.infer<typeof rerankResponseSchema>;
export type RerankPayload = z.infer<typeof rerankPayloadSchema>;

// ── Manual craft KB rebuild IPC (Story 2.1 CR-craft-kb-011, design §4) ──
//
// `closure:rebuild-craft-kb` triggers a full `reindexAllCraft` (DROP+reCREATE the
// vec0 table on a dim change + re-embed every craft doc under the resolved
// embedding model). The watcher handles incremental edits; this is the escape
// hatch for a model swap, a corrupted index, or a UI "Rebuild" button (Epic 3).
// Returns a typed result so the renderer can surface a friendly "no embedding
// model configured" message instead of a thrown IPC rejection (模式 A — the
// missing-embedding-model state is an expected user condition, not an invariant
// violation; ipc-handlers spec).

export type CraftRebuildResult =
  | { ok: true; reindexed: number; dimChanged: boolean; newDim: number | null }
  | { ok: false; error: 'no-embedding-model' | 'operation-failed' };
