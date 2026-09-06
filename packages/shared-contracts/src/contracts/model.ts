import { z } from 'zod';
import { modelRefSchema } from './generation';

// `rerank` is the cross-encoder rerank capability (Story 2.1 KB retrieval stage).
// A model whose capability === 'rerank' is auto-detected by resolveRerankModel
// (mirror of embedding auto-detect). Adding the value is backward-compatible:
// existing configs (text/image/video/embedding) still parse unchanged.
export const modelCapabilitySchema = z.enum(['text', 'image', 'video', 'embedding', 'rerank']);
export const modelProtocolSchema = z.enum(['openai-compatible', 'anthropic-compatible']);

/**
 * Vendor thinking-control capability kinds (thinking adapters task,
 * 2026-08-25). The kind fixes WHAT request-side controls a model family
 * accepts (off legality, effort tiers vs bare switch, numeric budget) — it is
 * derived from the modelId via the registry pattern table. The per-slot
 * POLICY (which level a pipeline stage uses) is user state in the taskModels
 * sidecar (slotAssignmentSchema), never here. The unified-level → vendor
 * parameter translation per kind lives in model-thinking-profiles.ts (single
 * source shared by both protocol paths).
 */
export const thinkingKindSchema = z.enum([
  // GLM (research A §1)
  'glm-forced-effort', // 5.3: thinking always on (off → error); reasoning_effort low/high/max (medium→high)
  'glm-forced-basic',  // 4.7 / 4.5V: thinking always on; no effort field
  'glm-dynamic-effort',// 5.2: on/off; full effort set with vendor mapping (none/minimal→stop, medium→high, xhigh→max)
  'glm-dynamic-basic', // 5.1 / 5 / 5-Turbo / 4.6 + older fallback: on/off switch only
  // Kimi (research A §2)
  'kimi-k3',           // always-on + effort low/high/max; max_completion_tokens param name; temperature not modifiable
  'kimi-k2',           // k2.5/k2.6: on/off; no effort; temperature not modifiable
  'kimi-k27-forced',   // CR-009: k2.7 (incl. -code/-code-highspeed): thinking.type 'enabled' ONLY (disabled errors); no effort; Preserved always on (keep defaults to 'all') → round-trip required; temperature not modifiable
  // DeepSeek (research A §4)
  'deepseek-v4',       // on/off; effort low/high/max (medium→high); sampling params silently ignored
  // Claude (research A §5)
  'claude-forced',     // Fable/Mythos 5: adaptive only, off → 400; effort low~max
  'claude-5',          // Opus/Sonnet 5: adaptive; off legal
  'claude-4x',         // 4.6/4.7/4.8: adaptive; omitting thinking = off
  'claude-budget',     // 4.5/3.7: legacy enabled + budget_tokens
  // Gemini (research A §3)
  'gemini',            // compat-endpoint passthrough unverified — v1 injects nothing, expectation management only
  // OpenAI-compatible reference (research A §6)
  'openai-o',          // o-series: always thinks, off illegal, Chat returns no reasoning content
  'gpt5',              // gpt-5 family: off→effort 'none' (5.1+; gpt-5 may 400 → param-strip retry backstop)
]);

/**
 * Official per-model context window / output ceiling (research C theme 2,
 * 2026-08-25 vendor docs). Optional everywhere it appears: unknown models
 * fall back to the protocol-layer guardrail instead of this table. Unit
 * convention: exact decimals where the vendor publishes them (OpenAI), binary
 * K/M shorthand otherwise (Gemini/Kimi publish binary figures) — a slight
 * over-shoot on the cap is covered by the existing cap-rejection retry.
 */
export const modelLimitsSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});

/**
 * Task-oriented routing slots (C3.2): which pipeline stage a model override
 * targets (writer self-check / writer draft / review judges / extraction /
 * dispatch / dialogue). One record (`ModelConfig.taskModels`) covers all
 * slots — adding a slot later (e.g. multi-reader fan-out once built) is an
 * enum-member change that keeps existing configs parsing unchanged. Naming
 * deliberately avoids `routeKey` (collides with the chain-tail route-agent /
 * route_decision review semantics).
 */
export const taskModelSlotSchema = z.enum([
  'writer-selfcheck',
  'writer-draft',
  'review-judge',
  'extraction',
  'dispatch',
  'dialogue',
]);
export type TaskModelSlot = z.infer<typeof taskModelSlotSchema>;

/**
 * Task-slot assignment (thinking adapters task): the model ref PLUS the
 * optional thinking policy for the slot. The policy follows the assignment as
 * a whole — the selfcheck soft-fallback (`selfcheck ?? draft`) takes the
 * complete assignment, never a selfcheck-model + draft-policy hybrid.
 * `thinking` deliberately has no `custom` member: a non-empty `thinkingCustom`
 * string means level=custom (vendor-native tier name or numeric budget,
 * validated against THINKING_PROFILES before anything is sent). Both fields
 * are optional, so existing ref-only sidecar values parse unchanged.
 */
export const slotAssignmentSchema = modelRefSchema.extend({
  thinking: z.enum(['auto', 'off', 'low', 'medium', 'high', 'max']).optional(),
  thinkingCustom: z.string().min(1).optional(),
});

export const discoveredModelSchema = z.object({
  id: z.string().min(1),
  capability: modelCapabilitySchema,
  alias: z.string().min(1),
  enabled: z.boolean(),
});

export const apiKeyConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: modelProtocolSchema.default('openai-compatible'),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
});

export const apiKeyEntrySchema = apiKeyConfigSchema.extend({
  models: z.array(discoveredModelSchema),
});

export const modelConfigSchema = z.object({
  keys: z.array(apiKeyEntrySchema),
  /**
   * Optional user-named embedding model used for KB indexing (VS1). When set,
   * the indexer uses this exact `{keyId, modelId}` regardless of pattern
   * auto-detection. Absent (`undefined`) → resolveEmbeddingModel falls back to
   * the first enabled model whose capability === 'embedding' (pattern detect).
   * Persisted in a sidecar file (see configIpc); `.optional()` means existing
   * configs without the field parse unchanged (no data migration).
   */
  embeddingModel: modelRefSchema.optional(),
  /**
   * Optional user-named rerank model used for the KB retrieval rerank stage
   * (Story 2.1). When set, the retrieval core uses this exact `{keyId, modelId}`
   * for cross-encoder reranking regardless of capability auto-detection. Absent
   * (`undefined`) -> resolveRerankModel falls back to the first enabled model
   * whose capability === 'rerank' (auto-detect). Persisted in a sidecar file
   * (mirror of embeddingModel); `.optional()` means existing configs without the
   * field parse unchanged (no data migration).
   */
  rerankModel: modelRefSchema.optional(),
  /**
   * Optional user-named vision model used for image analysis (Story 3.6 R9b).
   * When set, `runVisionAnalysis` sends multimodal parts messages to this exact
   * `{keyId, modelId}`. Absent (`undefined`) -> the vision path degrades to the
   * MANUAL export protocol (image saved + copied to clipboard + suggested
   * prompt) — the main text model is NEVER blind-tried with images (a middleman
   * that silently strips them would turn analysis into hallucination).
   * Persisted in a sidecar file (mirror of embeddingModel/rerankModel);
   * `.optional()` means existing configs without the field parse unchanged
   * (no data migration).
   */
  visionModel: modelRefSchema.optional(),
  /**
   * Task-oriented model routing (C3.2 + thinking policy): per-slot assignments
   * (model ref + optional thinking policy, see slotAssignmentSchema) for the
   * writing pipeline stages (see taskModelSlotSchema). A slot absent from the
   * record → resolveTaskModel yields undefined → the provider default
   * sentinel → shell resolveModel auto-picks (the pre-routing behavior).
   * Persisted in a sidecar file (mirror of embeddingModel/rerankModel/
   * visionModel); `.optional()` means existing configs without the field parse
   * unchanged (no data migration), and ref-only slot values keep parsing
   * unchanged too (the policy fields are optional).
   */
  taskModels: z.record(taskModelSlotSchema, slotAssignmentSchema).optional(),
});

/**
 * Save-side variant: the renderer redacts apiKey to '' to mean "keep the
 * existing encrypted key" (see writeModelConfig). Validation must allow the
 * empty sentinel here, while modelConfigSchema keeps enforcing min(1) elsewhere.
 */
export const modelConfigSaveSchema = z.object({
  keys: z.array(apiKeyEntrySchema.extend({ apiKey: z.string() })),
  embeddingModel: modelRefSchema.optional(),
  /**
   * Optional user-named rerank model used for the KB retrieval rerank stage
   * (Story 2.1). When set, the retrieval core uses this exact `{keyId, modelId}`
   * for cross-encoder reranking regardless of capability auto-detection. Absent
   * (`undefined`) -> resolveRerankModel falls back to the first enabled model
   * whose capability === 'rerank' (auto-detect). Persisted in a sidecar file
   * (mirror of embeddingModel); `.optional()` means existing configs without the
   * field parse unchanged (no data migration).
   */
  rerankModel: modelRefSchema.optional(),
  /** Vision model (Story 3.6 R9b) — mirror of modelConfigSchema.visionModel. */
  visionModel: modelRefSchema.optional(),
  /** Task model routing slots (C3.2 + thinking policy) — mirror of modelConfigSchema.taskModels. */
  taskModels: z.record(taskModelSlotSchema, slotAssignmentSchema).optional(),
});

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;
export type ThinkingKind = z.infer<typeof thinkingKindSchema>;
export type ModelLimits = z.infer<typeof modelLimitsSchema>;
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;
export type ApiKeyConfig = z.infer<typeof apiKeyConfigSchema>;
export type ApiKeyEntry = z.infer<typeof apiKeyEntrySchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type SlotAssignment = z.infer<typeof slotAssignmentSchema>;

/**
 * Resolved model info passed within the desktop main process for generation.
 * Never serialised to the renderer or sent over the network.
 */
export type ResolvedModel = {
  keyId: string;
  modelId: string;
  protocol: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  capability: ModelCapability;
  /**
   * Registry-derived thinking capability kind (thinking adapters task).
   * Optional: unknown models resolve without it → thinking controls are not
   * injected (auto semantics) and caps fall back to the protocol guardrail.
   */
  thinkingKind?: ThinkingKind;
  /** Registry-derived official limits (thinking adapters task). Optional — see modelLimitsSchema. */
  limits?: ModelLimits;
  /**
   * Registry 派生的主模型图片输入能力（agent 附件 B1/R2.4，第三轮 registry 派生
   * additive，mirror thinkingKind/limits）。`true` = 该家族确定支持图片输入（b64
   * 直传）；ABSENT = 未验证（不等于不支持）——图片走 visionModel 转述安全路径，绝不
   * 盲发主模型（中转站静默剥 image part = 幻觉红线，见 visionModel 注释同哲学）。
   */
  vision?: boolean;
};

// ── Model registry types ──

export type ModelRegistryEntry = {
  pattern: string;
  capability: ModelCapability;
  alias: string;
  /** Thinking capability kind for this family — absent = no verified thinking data. */
  thinking?: ThinkingKind;
  /** Official limits for this family — absent = unknown (guardrail fallback). */
  limits?: ModelLimits;
  /** 图片输入能力 — `true` 仅限确定性多模态家族；ABSENT = 未验证（≠不支持），走 visionModel 转述安全路径。 */
  vision?: boolean;
};

export type ModelRegistry = {
  entries: ModelRegistryEntry[];
};
