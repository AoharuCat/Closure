import { z } from 'zod';

/**
 * Image input for multimodal requests: base64 bytes + declared MIME type.
 * Shared by image generation (`image`/`mask`) and user-message image parts
 * (Story 3.6 vision seam).
 */
export const imageInputSchema = z.object({
  b64Json: z.string().min(1),
  mimeType: z.string().min(1),
});

/**
 * Normalized multimodal content part for USER messages (Story 3.6 vision seam,
 * design D2). This is the INTERNAL shape only — each protocol layer maps it
 * onto its own wire format at request-construction time:
 *   openai-compatible:  `{type:'image_url', image_url:{url:'data:<mime>;base64,<b64>'}}`
 *   anthropic-compatible: `{type:'image', source:{type:'base64', media_type, data}}`
 * Text parts map to `{type:'text', text}` in both protocols.
 */
// P15 (CR 2026-08-15): the parts array is `.min(1)` and text parts carry
// `.min(1)` — an empty parts array / empty text part is a caller bug, never a
// meaningful multimodal message (an empty text part would survive to the wire
// and some strict providers 400 on it).
export const generationPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({ type: z.literal('image'), image: imageInputSchema }),
]);

export const generationMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({
    role: z.literal('user'),
    // Story 3.6 vision seam (D2): ONLY user messages accept multimodal parts —
    // both protocols' system messages do not support images, and assistant
    // messages remain text+toolCalls. The union is additive: every existing
    // string-content message parses unchanged (zero migration). The parts
    // array is `.min(1)` (P15): an empty array is not a message.
    content: z.union([z.string(), z.array(generationPartSchema).min(1)]),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.string(),
    })).optional(),
    // Thinking adapters task (B block, design §5.2): historical reasoning
    // round-trip on REQUEST messages. `reasoning_content` keeps the
    // GLM/Kimi/DeepSeek ecosystem wire name (DeepSeek+tools and Kimi K3/k2.7
    // hard-require it back; GLM standard API ignores it — harmless);
    // `reasoningSignature` carries Anthropic's thinking-block signature, which
    // must round-trip verbatim in tool loops (missing signature → the protocol
    // layer skips the thinking block rather than forging one). Purely additive:
    // messages without them parse unchanged.
    reasoning_content: z.string().optional(),
    reasoningSignature: z.string().optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    content: z.string(),
  }),
]);

/**
 * Normalized usage counters across providers.
 *
 * thinkingTokens / cacheReadTokens (09-12 agy provider, design §2): surfaced
 * by providers that report them (the Antigravity CLI event stream — per-turn
 * thinking + cache_read are signals even the HTTP paths do not return).
 * Purely additive optional fields; responses without them parse unchanged.
 */
export const generationUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  thinkingTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
}).partial();

export const generationFinishReasonSchema = z.enum([
  'stop', 'length', 'content_filter', 'tool_use', 'other',
]);

export const toolFunctionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown(),
  }),
});

export const toolCallResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

/**
 * Unified thinking-control vocabulary (thinking adapters task, 2026-08-25).
 * `auto` = no injection (vendor default — byte-identical to pre-feature
 * behavior); the five fixed tiers map per-vendor via THINKING_PROFILES;
 * `custom` = a vendor-native tier name (enum-effort models) or a token-budget
 * number string (numeric-budget models), validated against the model's
 * profile before anything is sent.
 */
export const thinkingLevelSchema = z.enum([
  'auto', 'off', 'low', 'medium', 'high', 'max', 'custom',
]);

export const thinkingControlSchema = z.object({
  level: thinkingLevelSchema,
  /** Required iff level === 'custom': vendor-native tier name or numeric budget string. */
  custom: z.string().min(1).optional(),
}).superRefine((control, ctx) => {
  if (control.level === 'custom' && !control.custom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['custom'],
      message: "thinking.custom is required when thinking.level is 'custom'",
    });
  }
});

/**
 * Dispatch lane for streaming liveness policy (dogfood R2 #7).
 * `dialogue` = interactive leader conversation (60s first-event window — the
 * T1 D2 default); `background` = child agents / chapter chains, where top-spec
 * thinking tasks legitimately produce no first SSE event for minutes (measured:
 * d4-pro + thinking max + ~10K-token prompt, 60s zero events; same-shaped
 * leader request streamed its first event at 13.5s). The protocol layer widens
 * the first-event window and allows ONE bounded non-streaming fallback on the
 * background lane only. Absent = `dialogue` semantics — byte-level zero
 * regression for every existing payload.
 */
export const generationLaneSchema = z.enum(['dialogue', 'background']);
export type GenerationLane = z.infer<typeof generationLaneSchema>;

/** {keyId, modelId} pointer to a configured key + model. */
export const modelRefSchema = z.object({
  keyId: z.string().min(1),
  modelId: z.string().min(1),
});

export const textGenerationRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(generationMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  tools: z.array(toolFunctionSchema).optional(),
  // Thinking controls (thinking adapters task): absent = `auto` semantics —
  // nothing injected, vendor default applies. Purely additive, so every
  // existing request payload parses unchanged (zero behavior change).
  thinking: thinkingControlSchema.optional(),
  // Dispatch lane (dogfood R2 #7): see generationLaneSchema. Purely additive
  // optional field — payloads without it parse unchanged.
  lane: generationLaneSchema.optional(),
  /**
   * Session key (09-12 agy provider, design §2): identifies the LOGICAL
   * conversation this call belongs to, so session-capable providers (the
   * Antigravity CLI resident-session driver) can reuse a warm process and
   * send incremental turns instead of resending the full history. Absent
   * = single-shot cold path — per-call spawn, no resident state.
   * CR-13 (09-12 agy provider review batch): two-state discipline — '' is
   * normalized to ABSENT at parse (an assembly point leaking an empty string
   * must not be hard-rejected by min(1); same absent semantics as
   * lane/thinking above). Purely additive; payloads without it parse
   * unchanged.
   */
  sessionKey: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.length === 0 ? undefined : v)),
  /**
   * Task-model slot / pipeline label (09-12 usage-panel): which logical lane
   * this call belongs to for usage aggregation ('writer-draft' / 'decon' /
   * 'vision-relay' / 'doc-summary'…). Free value — no enum (the vocabulary
   * evolves with call sites; the ledger's task_type column is CHECK-free for
   * the same reason). Two-state discipline mirrors sessionKey (CR-13): '' from
   * a hand-built body normalizes to ABSENT, never hard-rejected. Purely
   * additive; payloads without it parse unchanged.
   */
  taskType: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.length === 0 ? undefined : v)),
  /**
   * Prompt-cache breakpoint flag (09-12 system stabilization, C batch / C3.4):
   * request-level directive for the protocol layer to attach explicit
   * Anthropic-style `cache_control: {type:'ephemeral'}` breakpoints — the
   * system tail block + the conversation-tail block (2 ≤ the official cap of
   * 4). Named same-root with the wire field (`cache_control`). Purely
   * additive optional boolean: absent/false keeps the wire body
   * byte-identical (zero regression). The OpenAI-compatible path reads it but
   * never acts (implicit prefix caching has no protocol field) and the
   * Antigravity CLI path carries its own mirror-based caching (flag inert
   * there).
   */
  cacheControl: z.boolean().optional(),
});

/**
 * ONE fallback-trace record (09-12 子2 fallback chains, design §4): the model a
 * failed attempt targeted plus the classified failure reason. Carried on
 * responses ONLY when a fallback actually happened (two-state `.min(1)`).
 */
export const fallbackTraceEntrySchema = modelRefSchema.extend({
  reason: z.string(),
});

export const textGenerationResponseSchema = z.object({
  model: z.string(),
  text: z.string(),
  // Dogfood T1 #27②: aggregated reasoning / chain-of-thought text when the
  // provider surfaces one (Anthropic thinking blocks; OpenAI-compatible
  // `<think>` sections). Purely additive — responses without it parse
  // unchanged, and non-reasoning providers simply never populate it.
  reasoning: z.string().optional(),
  // Thinking adapters task (B block): Anthropic attaches a `signature` to
  // thinking blocks (streaming `signature_delta`) that MUST round-trip
  // verbatim in tool loops. Captured here alongside `reasoning` — purely
  // additive; non-Anthropic providers never populate it.
  reasoningSignature: z.string().optional(),
  finishReason: generationFinishReasonSchema.optional(),
  usage: generationUsageSchema.optional(),
  toolCalls: z.array(toolCallResultSchema).optional(),
  /**
   * The model that actually served this response (09-12 子2 fallback chains):
   * the gateway annotates the RESOLVED identity ({keyId, modelId} of whichever
   * chain entry succeeded — never the request ref, which is the {default,
   * default} sentinel under auto-pick), so the terminal state can label the
   * real model after a fallback switch. ABSENT = no fallback machinery ran.
   */
  modelRef: modelRefSchema.optional(),
  /**
   * Per-failed-attempt records, present ONLY when at least one fallback switch
   * happened (two-state `.min(1)` — an empty array is rejected). Purely
   * additive: responses without it parse unchanged.
   */
  fallbackTrace: z.array(fallbackTraceEntrySchema).min(1).optional(),
});

export const imageGenerationRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  n: z.number().int().positive().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  image: imageInputSchema.optional(),
  mask: imageInputSchema.optional(),
  background: z.string().optional(),
  outputFormat: z.string().optional(),
});

export const imageGenerationResponseSchema = z.object({
  model: z.string(),
  images: z.array(z.object({
    b64Json: z.string().optional(),
    url: z.string().optional(),
    mimeType: z.string().optional(),
    dataUrl: z.string().optional(),
    revisedPrompt: z.string().optional(),
  })),
});

/**
 * ONE wire-form fallback entry (09-12 子2 fallback chains, design §4): the
 * next chain candidate as `{ref, thinking}` — `thinking` here is the
 * NORMALIZED ThinkingControl (the agent-side assignmentThinkingControl
 * projection of the slot entry's thinking/thinkingCustom pair), not the raw
 * slot fields. Single source for the gateway loop's per-attempt model/thinking
 * overwrite.
 */
export const generateFallbackEntrySchema = z.object({
  ref: modelRefSchema,
  thinking: thinkingControlSchema.optional(),
});

/**
 * ONE model switch on a fallback chain (09-12 子2 fallback chains, design §7;
 * CR-15 形态单源). The gateway loop surfaces this via onFallback every time the
 * chain advances off a failed attempt; agent assembly points turn it into the
 * additive 'model-fallback' runtime / child / chain events (agent-side
 * `ModelFallbackEventData` extends this with the chain-lane nodeId/role), and
 * the gateway always mirrors a logger.warn (shell direct-call faces with no
 * onFallback rely on the log line). `reason` carries the SAME string the
 * terminal fallbackTrace records: a `kind: detail` summary from
 * classifyGenerationFailure, or a `config:` / `image:` prefixed pre-flight
 * failure summary.
 */
export interface ModelFallbackSwitchEvent {
  /**
   * The model that failed. Resolved identity when resolution succeeded; the
   * requested entry ref when it did not (config: failures — under auto-pick
   * this may be the {default,default} sentinel).
   */
  from: { keyId: string; modelId: string };
  /** The chain entry taking over (its configured ref). */
  to: { keyId: string; modelId: string };
  /** Classified failure summary (`kind: detail` / `config: …` / `image: …`). */
  reason: string;
  /** 1-based index of the FAILED attempt. */
  attempt: number;
}

export const generateTextPayloadSchema = z.object({
  ref: modelRefSchema,
  request: textGenerationRequestSchema,
  /**
   * Ordered fallback chain behind `ref` (09-12 子2): zero default — ABSENT
   * means the gateway's single-model fast path runs byte-identical to the
   * pre-fallback behavior; length ≥ 1 means the gateway loop advances through
   * these entries when the primary model fails with a fallback-eligible
   * error. Two-state contract: empty `[]` is rejected (`.min(1)`).
   */
  fallbacks: z.array(generateFallbackEntrySchema).min(1).optional(),
});

export const generateImagePayloadSchema = z.object({
  ref: modelRefSchema,
  request: imageGenerationRequestSchema,
});

// ── Embeddings (OpenAI /v1/embeddings compatible) ──
//
// Embeddings are ALWAYS served in OpenAI /v1/embeddings format (Anthropic has no
// embeddings endpoint; every embed endpoint — including self-hosted/localhost —
// serves this shape). So unlike generateText (which forks for
// anthropic-compatible), embed is single-path and does NOT branch on
// model.protocol. `model` is injected from the resolved ModelRef at the protocol
// layer, so the request only carries `input`.
//
// `input` is the batch (an array) — one call embeds many texts; OpenAI returns
// `data[]` in input order, which the protocol layer preserves.
//
// VS1 deviation note: design §3 sketched generateEmbedding returning bare
// number[][]. We return the richer EmbeddingResponse instead (strict superset —
// the 阶段3 indexer just reads .embeddings). Rationale: ADR-12 cost ledger needs
// usage + model provenance; mirrors generateText's rich TextGenerationResponse.
//
// Forward-compat NOT in VS1: MRL models accept a `dimensions` param for shorter
// embeddings. Intentionally omitted — truncation requires renormalization under
// cosine distance (research/embedding-model-swap-compatibility-2026-07-23.md
// §2.5), out of scope for VS1's Path B (native dim, no truncation).
export const embeddingRequestSchema = z.object({
  input: z.array(z.string().min(1)).min(1),
});

export const embeddingResponseSchema = z.object({
  model: z.string(),
  embeddings: z.array(z.array(z.number())),
  usage: z.object({
    promptTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }).partial().optional(),
});

export const generateEmbeddingPayloadSchema = z.object({
  ref: modelRefSchema,
  request: embeddingRequestSchema,
});

export type GenerationMessage = z.infer<typeof generationMessageSchema>;
export type GenerationPart = z.infer<typeof generationPartSchema>;
export type GenerationUsage = z.infer<typeof generationUsageSchema>;
export type GenerationFinishReason = z.infer<typeof generationFinishReasonSchema>;
export type ImageInput = z.infer<typeof imageInputSchema>;
export type TextGenerationRequest = z.infer<typeof textGenerationRequestSchema>;
export type TextGenerationResponse = z.infer<typeof textGenerationResponseSchema>;
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export type ImageGenerationResponse = z.infer<typeof imageGenerationResponseSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof embeddingResponseSchema>;
export type ToolFunction = z.infer<typeof toolFunctionSchema>;
export type ToolCallResult = z.infer<typeof toolCallResultSchema>;
export type GenerateFallbackEntry = z.infer<typeof generateFallbackEntrySchema>;
export type FallbackTraceEntry = z.infer<typeof fallbackTraceEntrySchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ThinkingControl = z.infer<typeof thinkingControlSchema>;
/**
 * The selectable unified tiers — the full level vocabulary minus `auto`
 * (a non-policy) and `custom` (free-form, carried in `custom`). This is what
 * THINKING_PROFILES.levels and mapLevel operate on.
 */
export type UnifiedLevel = Exclude<ThinkingLevel, 'auto' | 'custom'>;
