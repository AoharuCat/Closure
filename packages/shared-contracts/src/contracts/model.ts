import { z } from 'zod';
import { modelRefSchema } from './generation';

// `rerank` is the cross-encoder rerank capability (Story 2.1 KB retrieval stage).
// A model whose capability === 'rerank' is auto-detected by resolveRerankModel
// (mirror of embedding auto-detect). Adding the value is backward-compatible:
// existing configs (text/image/video/embedding) still parse unchanged.
export const modelCapabilitySchema = z.enum(['text', 'image', 'video', 'embedding', 'rerank']);
/**
 * Third member `antigravity-cli` (09-12 agy provider, design §2): the key is a
 * CLI-form provider — no baseUrl/apiKey, `cliExecutable` instead. Existing
 * HTTP keys parse unchanged (enum addition is backward-compatible); the
 * form-mutual-exclusion lives on the entry/save faces (see apiKeyEntrySchema).
 */
export const modelProtocolSchema = z.enum(['openai-compatible', 'anthropic-compatible', 'antigravity-cli']);

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
 *
 * 09-13 chain-flow restructure R1b — review-lineage fine slots: the coarse
 * `review-judge` is refined into four audit stages (`plan-review` = brief
 * reviewer / `multi-review` = the multi-dimension readthrough family /
 * `route-judge` = chain-tail route decision + gray-zone adjudicator /
 * `revision-guard` = meaning-preservation gate). Rationale (user decision
 * 2026-09-13): heterogeneous review — different models carry training- and
 * post-training-correlated blind spots, so letting each audit stage run on a
 * DIFFERENT model cross-examines the text from uncorrelated perspectives and
 * finds more gaps. `review-judge` stays as the COMPAT FALLBACK slot: a fine
 * slot left unconfigured resolves through it before the provider auto-pick
 * (the single fallback chain lives in the agent runtime's taskModelRouting).
 * Pure enum-member addition — old sidecar configs parse unchanged, and the
 * disk read side iterates these options, so the new members' keys are picked
 * up with zero read-path changes.
 */
export const taskModelSlotSchema = z.enum([
  'writer-selfcheck',
  'writer-draft',
  'review-judge',
  // ── review-lineage fine slots (09-13 R1b; unconfigured → review-judge) ──
  'plan-review',
  'multi-review',
  'route-judge',
  'revision-guard',
  'extraction',
  'dispatch',
  'dialogue',
]);
export type TaskModelSlot = z.infer<typeof taskModelSlotSchema>;

/**
 * ONE fallback-chain entry (task-model fallback chains, 09-12 子2 design §2):
 * the slot-assignment shape minus `fallbacks` itself — a model ref plus its own
 * optional thinking policy. Deliberately NON-recursive (a chain entry never
 * carries its own chain). Exported because it is the element schema of
 * `slotAssignmentSchema.fallbacks` and the shared-contract single source for
 * the UI chain editor + the configIpc sidecar read/write of
 * `slot.fallbacks.N.*` keys.
 */
export const slotFallbackEntrySchema = modelRefSchema.extend({
  thinking: z.enum(['auto', 'off', 'low', 'medium', 'high', 'max']).optional(),
  thinkingCustom: z.string().min(1).optional(),
});

/**
 * Task-slot assignment (thinking adapters task): the model ref PLUS the
 * optional thinking policy for the slot. The policy follows the assignment as
 * a whole — the selfcheck soft-fallback (`selfcheck ?? draft`) takes the
 * complete assignment, never a selfcheck-model + draft-policy hybrid.
 * `thinking` deliberately has no `custom` member: a non-empty `thinkingCustom`
 * string means level=custom (vendor-native tier name or numeric budget,
 * validated against THINKING_PROFILES before anything is sent). Both fields
 * are optional, so existing ref-only sidecar values parse unchanged.
 *
 * `fallbacks` (09-12 子2): ordered user-configured fallback chain behind the
 * slot's primary model. Two-state contract (interface-contracts): ABSENT = no
 * chain / length ≥ 1 = chain — an empty `[]` belongs to neither state and is
 * REJECTED (`.min(1)`). Zero default chains, zero injection: a chain exists
 * only when the user wrote one. NO refine/superRefine may ever sit on this
 * schema — ZodEffects would sever the `.extend` derivation chain and break
 * configIpc's `slotAssignmentSchema.shape.thinking` read; duplicate entries
 * are tolerated read-side (warn + drop) instead.
 */
export const slotAssignmentSchema = slotFallbackEntrySchema.extend({
  fallbacks: z.array(slotFallbackEntrySchema).min(1).optional(),
  /**
   * RUNTIME-ONLY derived field (09-12 子3, design §2 #5): the shell injection
   * seam's slot-resolver enrichment product — the key-level
   * `models[].defaults.contextWindow` override for this assignment's model,
   * unconditionally written by `enrichSlotAssignment` when present. It is
   * NEVER persisted (writeTaskModels's projection excludes it — the single
   * source is the key's defaults; a hand-added value on disk is non-source and
   * gets overwritten, i.e. ignored). Naming aligns with the agent-side
   * `LoopOptions.contextWindowTokens` consumer rather than contracts'
   * `contextWindow` — the later-added field yields to the existing consumer's
   * name (same-source note: value derives from discovered defaults.contextWindow).
   */
  contextWindowTokens: z.number().int().positive().optional(),
});

/**
 * Recursive JSON value (09-12 子3, design §2 #2): string / number / boolean /
 * null / array / record. Backs `extraBody` — an arbitrary JSON attachment
 * payload whose keys/values come from disk (YAML/JSON), so the lazy recursion
 * cannot cycle (no function/undefined shapes exist there; zod rejects them).
 */
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

/**
 * Per-model default call parameters (09-12 子3, design §2 #2): the sampling
 * family + window family, all optional. Numeric domains follow OpenAI's
 * official ranges (top_p 0-1, both penalties -2..2, temperature 0-2) — the
 * widest documented superset for OpenAI-compatible endpoints. The domains
 * below are THE single source (CR-7 09-12 子3 CR 批): the schema constraints,
 * the settings-page preflight (findKeyDraftIssue) and the lenient disk read
 * all derive from MODEL_DEFAULT_RANGES — hand-copying range literals anywhere
 * else is forbidden. An EMPTY object
 * is REJECTED (refine): `defaults` is a two-state field (ABSENT = no defaults /
 * ≥1 key = defaults) and `{}` belongs to neither state (same discipline as the
 * optional-array `.min(1)` contract). `contextWindow`/`maxOutputTokens`
 * override the registry limits per-field (see resolveModelInfoWithDefaults).
 */
export const MODEL_DEFAULT_RANGES = {
  temperature: { min: 0, max: 2, integer: false },
  topP: { min: 0, max: 1, integer: false },
  frequencyPenalty: { min: -2, max: 2, integer: false },
  presencePenalty: { min: -2, max: 2, integer: false },
  contextWindow: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  maxOutputTokens: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
} as const satisfies Record<string, { min: number; max: number; integer: boolean }>;

export const modelDefaultsSchema = z
  .object({
    temperature: z.number().min(MODEL_DEFAULT_RANGES.temperature.min).max(MODEL_DEFAULT_RANGES.temperature.max).optional(),
    topP: z.number().min(MODEL_DEFAULT_RANGES.topP.min).max(MODEL_DEFAULT_RANGES.topP.max).optional(),
    frequencyPenalty: z.number().min(MODEL_DEFAULT_RANGES.frequencyPenalty.min).max(MODEL_DEFAULT_RANGES.frequencyPenalty.max).optional(),
    presencePenalty: z.number().min(MODEL_DEFAULT_RANGES.presencePenalty.min).max(MODEL_DEFAULT_RANGES.presencePenalty.max).optional(),
    contextWindow: z.number().int().min(MODEL_DEFAULT_RANGES.contextWindow.min).optional(),
    maxOutputTokens: z.number().int().min(MODEL_DEFAULT_RANGES.maxOutputTokens.min).optional(),
  })
  .refine((defaults) => Object.keys(defaults).length > 0, {
    message: 'defaults must carry at least one field — an empty object has no semantics (ABSENT = no defaults)',
  });

/**
 * Per-model pricing (09-12 子3, design §2 #2): pure numbers per 1M tokens.
 * Currency is deliberately not enforced — the user knows what their numbers
 * mean. Metadata only: zero protocol-layer consumption; the reader is the
 * usage panel (子5) via the renderer-side modelConfig. Domain single source
 * (CR-7): min 0 (a negative unit price has no semantics), finite.
 */
export const MODEL_PRICING_RANGE = { min: 0, max: Number.MAX_SAFE_INTEGER } as const;

/**
 * Per-key timeout window bounds (CR-7 09-12 子3 CR 批), single source for the
 * schema constraint, the settings-page preflight and the lenient disk read.
 * Upper bound 86400 (one day): the timeout is an abort window for a hung
 * first event — an unbounded value turns into a multi-day dead wait, never a
 * feature.
 */
export const KEY_TIMEOUT_SECONDS_RANGE = { min: 1, max: 86_400 } as const;

export const pricingSchema = z.object({
  inputPerMillion: z.number().min(MODEL_PRICING_RANGE.min).finite().optional(),
  outputPerMillion: z.number().min(MODEL_PRICING_RANGE.min).finite().optional(),
  cachedInputPerMillion: z.number().min(MODEL_PRICING_RANGE.min).finite().optional(),
});

export const discoveredModelSchema = z.object({
  id: z.string().min(1),
  capability: modelCapabilitySchema,
  alias: z.string().min(1),
  enabled: z.boolean(),
  /**
   * Per-model default call parameters (09-12 子3) — see modelDefaultsSchema.
   * Priority chain: request-level explicit > per-model defaults > protocol-layer
   * fallback. CLI keys may carry ONLY `defaults.contextWindow` (form refine).
   */
  defaults: modelDefaultsSchema.optional(),
  /**
   * Arbitrary JSON request-body attachment (09-12 子3): vendor long-tail
   * parameter escape hatch (safe_prompt / min_p / gateway-private params),
   * deep-merged at both protocol body-assembly tails — same-named extraBody
   * values override the protocol-layer defaults (user-explicit wins). Forms
   * the "headers + body" dual escape hatch with the key-level customHeaders.
   */
  extraBody: z.record(z.string(), jsonValueSchema).optional(),
  /** Per-model pricing metadata (09-12 子3) — see pricingSchema. Not consumed by the protocol layer. */
  pricing: pricingSchema.optional(),
});

/**
 * Custom-header NAME vocabulary (09-12 子3 HTTP provider params, design §2 #1):
 * the HTTP header token subset `[A-Za-z0-9-_]+` (CR-17: `_` is RFC 7230-legal
 * token syntax — real-world names like `X-Ivado_Tenant` use it). The dot/space
 * exclusion is not cosmetic — the per-key config file is flat YAML with dotted
 * keys, so a name containing `.` would make `headers.<Name>` ambiguous to
 * re-parse; actual gateway header names (HTTP-Referer, X-Route-*, X-Api-Token …)
 * all fit the token charset. Wire-serialization-critical headers (content-type /
 * content-length / accept / host) are banned separately on the form refine —
 * by VALUE comparison after lowercasing, not by this regex.
 */
export const customHeaderNameSchema = z.string().regex(/^[A-Za-z0-9-_]+$/);

/**
 * Custom-header VALUE face (09-12 子3 review CR-17): a value carrying CR/LF
 * (or any C0/DEL control char) makes undici's Headers.set THROW at request
 * time — the whole key's every request dies on the wire. Reject at save/parse
 * time instead. The 8192-char cap mirrors common server header-size limits
 * (a runaway paste should fail loudly here, not as a 431 on every request).
 */
export const customHeaderValueSchema = z
  .string()
  .max(8192, { message: 'custom header values are capped at 8192 characters' })
  // 控制字符本身就是这里的拒收对象（C0+DEL）；转义形式书写避免源文件夹带原始控制字节。
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), {
    message: 'custom header values must not contain control characters (CR/LF corrupt the wire format)',
  });

/**
 * Provider key shape (09-12 agy provider, design §2): baseUrl/apiKey are
 * optional at the BASE level so the CLI form (`antigravity-cli` ⇒
 * cliExecutable only) can parse — the HTTP requirement is enforced by the
 * form-mutual-exclusion refine on the entry/save faces (apiKeyEntrySchema /
 * modelConfigSaveSchema), NOT here (a superRefine on this base would produce
 * ZodEffects and sever the `.extend` derivation chain below).
 *
 * Transport-face fields (09-12 子3, design §2 #1) sit additively after
 * `cliExecutable`, all optional WITHOUT `.default()` — an old config parses to
 * the field ABSENT (never a materialized default), and every consumer treats
 * ABSENT as "off/inherit the lane default" (registry-derived-fields ABSENT
 * discipline). `streamingDisabled`/`verifySsl`: ABSENT = false (streaming
 * allowed / certificate verification ON). CLI keys may not carry
 * customHeaders/timeoutSeconds/streamingDisabled (form refine rejects — no
 * HTTP request face); verifySsl is tolerated as meaningless-but-harmless.
 */
export const apiKeyConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: modelProtocolSchema.default('openai-compatible'),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  /** Executable path — required iff protocol === 'antigravity-cli' (refine-enforced). */
  cliExecutable: z.string().min(1).optional(),
  /** Custom request headers sent with EVERY request of this key (both protocol paths). Same-name overrides built-ins. Value face rejects control chars + oversize (CR-17 — Headers.set would throw on the wire). */
  customHeaders: z.record(customHeaderNameSchema, customHeaderValueSchema).optional(),
  /** Per-key first-event/connect window override in SECONDS — replaces the lane default (60s/240s); disposition logic unchanged. Bounded above by KEY_TIMEOUT_SECONDS_RANGE (CR-7: an unbounded timeout is a multi-day abort window). */
  timeoutSeconds: z
    .number()
    .int()
    .min(KEY_TIMEOUT_SECONDS_RANGE.min)
    .max(KEY_TIMEOUT_SECONDS_RANGE.max)
    .optional(),
  /** SSE fuse for broken gateways: when true the shell gateway short-circuits to the non-streaming path. */
  streamingDisabled: z.boolean().optional(),
  /** Skip TLS certificate verification for this key's requests (per-key undici dispatcher; default off = verify ON). */
  verifySsl: z.boolean().optional(),
});

/**
 * Pure object shape of an api-key entry (the extend base for the strict/save
 * parse faces). Kept refinement-free on purpose — see apiKeyConfigSchema.
 */
const apiKeyEntryObjectSchema = apiKeyConfigSchema.extend({
  models: z.array(discoveredModelSchema),
});

type ApiKeyFormShape = {
  protocol: ModelProtocol;
  baseUrl?: unknown;
  apiKey?: unknown;
  cliExecutable?: unknown;
  /** 子3 transport face (form-narrowed manually — superRefine sees the already-parsed object). */
  customHeaders?: unknown;
  timeoutSeconds?: unknown;
  streamingDisabled?: unknown;
  verifySsl?: unknown;
  models?: unknown;
};

/**
 * Wire-serialization-critical headers (09-12 子3, design §2 #3 ①): overriding
 * any of these breaks the request itself (postJson/postSse set content-type/
 * accept; fetch derives content-length/host) — reject loudly at save time
 * instead of silently corrupting every request of the key. Compared lowercase
 * (header names are case-insensitive). EXPORTED (CR-3 09-12 子3 CR 批) so the
 * lenient configIpc disk-read face judges blocked names against the SAME
 * constant set as the save face (a hand-edited `headers.Authorization:` must
 * not ride into every request with zero filtering and zero logging).
 */
export const BLOCKED_CUSTOM_HEADER_NAMES = new Set(['content-type', 'content-length', 'accept', 'host']);

/** 子3 ① — applies to BOTH protocol forms: no overriding wire-serialization headers. */
function rejectBlockedCustomHeaders(entry: ApiKeyFormShape, ctx: z.RefinementCtx): void {
  if (typeof entry.customHeaders !== 'object' || entry.customHeaders === null) return;
  for (const name of Object.keys(entry.customHeaders)) {
    if (BLOCKED_CUSTOM_HEADER_NAMES.has(name.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customHeaders', name],
        message: `custom header '${name}' is a wire-serialization header and cannot be overridden`,
      });
    }
  }
}

/**
 * Per-model defaults keys with NO CLI parameter face (09-12 子3, design §2 #3 ②).
 * `contextWindow` is deliberately NOT here: the agent-side compaction red line
 * is computed before the CLI call, so a user-supplied window stays meaningful
 * for agy's real limits. `pricing` is metadata (never a call parameter) — allowed.
 */
const CLI_BANNED_DEFAULT_KEYS = ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens'] as const;

/** 子3 ② — CLI keys have no HTTP parameter face: reject the transport trio + sampling/cap/extraBody model fields. */
function rejectCliParamFace(entry: ApiKeyFormShape, ctx: z.RefinementCtx): void {
  if (entry.customHeaders !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customHeaders'],
      message: "customHeaders is not allowed on 'antigravity-cli' keys (no HTTP request face)",
    });
  }
  if (entry.timeoutSeconds !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timeoutSeconds'],
      message: "timeoutSeconds is not allowed on 'antigravity-cli' keys (print-timeout is the only duration gate)",
    });
  }
  if (entry.streamingDisabled !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['streamingDisabled'],
      message: "streamingDisabled is not allowed on 'antigravity-cli' keys (no SSE face)",
    });
  }
  if (!Array.isArray(entry.models)) return;
  for (let i = 0; i < entry.models.length; i++) {
    const model = entry.models[i];
    if (typeof model !== 'object' || model === null) continue;
    const record = model as Record<string, unknown>;
    const defaults = record.defaults;
    if (typeof defaults === 'object' && defaults !== null) {
      for (const key of CLI_BANNED_DEFAULT_KEYS) {
        if ((defaults as Record<string, unknown>)[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['models', i, 'defaults', key],
            message: `'${key}' has no CLI parameter face — agy exposes no sampling/output-cap controls (defaults.contextWindow IS allowed: it feeds the agent-side compaction red line)`,
          });
        }
      }
    }
    if (record.extraBody !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', i, 'extraBody'],
        message: "extraBody is not allowed on 'antigravity-cli' models (no HTTP request body)",
      });
    }
  }
}

/**
 * Form mutual exclusion shared by the two persistence parse faces (strict
 * entry + renderer save), 09-12 agy provider design §2:
 *   - `antigravity-cli` ⇒ cliExecutable required; baseUrl forbidden; apiKey
 *     forbidden on the strict face (the save face tolerates the renderer's ''
 *     redaction sentinel / a leftover value — the field is ignored for CLI).
 *   - HTTP forms ⇒ baseUrl + apiKey required (the pre-CLI constraint, unchanged
 *     semantics; on the save face apiKey may be '' = keep-the-existing-key);
 *     cliExecutable forbidden (CR-14: a hand-edited disk config carrying the
 *     CLI discriminator payload on an HTTP key is a form error, not silently
 *     accepted-and-dropped).
 */
function apiKeyFormRefine(saveFace: boolean) {
  return (entry: ApiKeyFormShape, ctx: z.RefinementCtx): void => {
    // 子3 ①：wire 序列化语义头禁改——不分协议（CLI 分支同样先过这道）。
    rejectBlockedCustomHeaders(entry, ctx);
    if (entry.protocol === 'antigravity-cli') {
      if (typeof entry.cliExecutable !== 'string' || entry.cliExecutable.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cliExecutable'],
          message: "cliExecutable is required for 'antigravity-cli' keys",
        });
      }
      if (entry.baseUrl !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: "baseUrl is not allowed on 'antigravity-cli' keys",
        });
      }
      if (!saveFace && entry.apiKey !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apiKey'],
          message: "apiKey is not allowed on 'antigravity-cli' keys",
        });
      }
      // 子3 ②：CLI 键无 HTTP 参数面——传输三件 + 采样族/输出上限/extraBody 拒。
      rejectCliParamFace(entry, ctx);
      return;
    }
    // CR-14（09-12 agy provider CR 批）：反向互斥——HTTP 键带 cliExecutable 即报错
    //（镜像 CLI 面的 baseUrl 禁填；renderer 草稿面 HTTP 形态本就不构造该字段，此门
    // 针对盘上手编坏配置）。
    if (entry.cliExecutable !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cliExecutable'],
        message: `cliExecutable is not allowed on '${entry.protocol}' keys`,
      });
    }
    if (entry.baseUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: `baseUrl is required for '${entry.protocol}' keys`,
      });
    }
    if (saveFace) {
      if (entry.apiKey === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apiKey'],
          message: `apiKey is required for '${entry.protocol}' keys ('' keeps the existing key)`,
        });
      }
      return;
    }
    if (typeof entry.apiKey !== 'string' || entry.apiKey.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: `apiKey is required for '${entry.protocol}' keys`,
      });
    }
  };
}

export const apiKeyEntrySchema = apiKeyEntryObjectSchema.superRefine(apiKeyFormRefine(false));

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
  // 09-12 agy provider: extends the refinement-free entry object (NOT the
  // strict apiKeyEntrySchema — that is a ZodEffects and has no .extend), then
  // applies the same form refine in its save-face variant (apiKey '' sentinel
  // allowed; CLI keys tolerate the renderer's redacted apiKey).
  keys: z.array(
    apiKeyEntryObjectSchema
      .extend({ apiKey: z.string() })
      .superRefine(apiKeyFormRefine(true)),
  ),
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
export type SlotFallbackEntry = z.infer<typeof slotFallbackEntrySchema>;
export type ModelDefaults = z.infer<typeof modelDefaultsSchema>;
export type ModelPricing = z.infer<typeof pricingSchema>;

/**
 * Resolved model info passed within the desktop main process for generation.
 * Never serialised to the renderer or sent over the network.
 */
export type ResolvedModel = {
  keyId: string;
  modelId: string;
  protocol: ModelProtocol;
  /**
   * HTTP forms: the endpoint base URL. CLI forms (`antigravity-cli`): '' —
   * the CLI driver never reads it; the form guarantees it is absent on the
   * key (resolveModel fills '' to keep this field non-optional).
   */
  baseUrl: string;
  /** HTTP forms: decrypted key. CLI forms: '' (see baseUrl). */
  apiKey: string;
  capability: ModelCapability;
  /**
   * Registry-derived thinking capability kind (thinking adapters task).
   * Optional: unknown models resolve without it → thinking controls are not
   * injected (auto semantics) and caps fall back to the protocol guardrail.
   */
  thinkingKind?: ThinkingKind;
  /**
   * Registry-derived official limits (thinking adapters task). Optional — see
   * modelLimitsSchema. 09-12 子3: per-field PARTIAL — resolveModel's synthesis
   * (resolveModelInfoWithDefaults) lets a user override fill only the named
   * field; a missing sibling means "unknown" (consumers read per-field with
   * optional chaining; unknown maxOutputTokens → protocol guardrail fallback).
   */
  limits?: Partial<ModelLimits>;
  /**
   * Registry 派生的主模型图片输入能力（agent 附件 B1/R2.4，第三轮 registry 派生
   * additive，mirror thinkingKind/limits）。`true` = 该家族确定支持图片输入（b64
   * 直传）；ABSENT = 未验证（不等于不支持）——图片走 visionModel 转述安全路径，绝不
   * 盲发主模型（中转站静默剥 image part = 幻觉红线，见 visionModel 注释同哲学）。
   */
  vision?: boolean;
  /**
   * CLI-form executable path (09-12 agy provider, design §2). Present iff the
   * key's protocol is 'antigravity-cli' (resolveModel conditional-spreads it,
   * mirroring vision/limits) — ABSENT for HTTP keys. The protocol-layer CLI
   * dispatch treats a CLI-protocol model without this field as a config error.
   */
  cliExecutable?: string;
  /**
   * ── HTTP provider params face (09-12 子3, design §2 #4) ──
   * Minimal explicit projections of the key/model params the protocol + gateway
   * layers actually consume (NOT a wholesale defaults passthrough). All
   * optional + resolveModel conditional-spreads them (ABSENT semantics,
   * mirroring limits/vision/cliExecutable). `defaults.contextWindow`/
   * `maxOutputTokens` do NOT ride here — they synthesize into `limits` via
   * resolveModelInfoWithDefaults; `pricing` has zero protocol consumption.
   */
  /** Per-key custom headers — protocol layer merges them into every request (same-name overrides built-ins). */
  customHeaders?: Record<string, string>;
  /** Per-model extraBody — deep-merged at both protocol body-assembly tails (user-explicit wins). */
  extraBody?: Record<string, unknown>;
  /** Per-model sampling default — fills the slot when the request carries no explicit value (缺省补位, not override). */
  defaultTemperature?: number;
  defaultTopP?: number;
  defaultFrequencyPenalty?: number;
  defaultPresencePenalty?: number;
  /** Per-key first-event window override (seconds). Value-source replacement of the lane default; disposition unchanged. */
  timeoutSeconds?: number;
  /** Skip TLS verification for this key (per-key undici dispatcher; ABSENT = verify ON). */
  verifySsl?: boolean;
  /** SSE fuse — shell gateway short-circuits streaming to the non-streaming path when true. */
  streamingDisabled?: boolean;
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
