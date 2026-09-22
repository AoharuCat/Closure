import type {
  EmbeddingRequest,
  EmbeddingResponse,
  GenerationFinishReason,
  GenerationMessage,
  GenerationPart,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelProtocol,
  ResolvedModel,
  TextGenerationRequest,
  TextGenerationResponse,
  ThinkingControl,
  ThinkingKind,
} from '@orison/shared-contracts';
import { THINKING_PROFILES, mapLevel, validateCustom } from '@orison/shared-contracts';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import {
  generateText as aiGenerateText,
  streamText,
  jsonSchema,
  tool,
  APICallError,
  wrapLanguageModel,
  extractReasoningMiddleware,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { randomUUID } from 'node:crypto';
import { base64ToBlob, getInsecureDispatcher, normalizeBaseUrl, postJson, postMultipart, postSse } from './http';
import { normalizeImageResponse } from './imageNormalize';
import {
  ProtocolContextOverflowError,
  ProtocolHttpError,
  ProtocolTimeoutError,
  StreamInterruptedError,
  classifyGenerationFailure,
  isContextOverflowError,
} from './errors';
import { withRetry, isRetryableProtocolError } from './retry';
import type { GenerationDelta, ProtocolCallContext } from './types';
import { antigravityCliGenerateText, readCliAttemptUsage } from './antigravityCli/driver';
import {
  dispatchGenerationCallRecord,
  enforceBudgetGateOrThrow,
  truncateForLedger,
  usageToLedgerTokenFields,
  withEntryUsageMetering,
  type AttemptMeteringRecord,
} from './usageSink';

// 09-12 agy provider：GenerationDelta 已迁至 types.ts（driver 同型消费免环）；此处
// 再导出保既有 `from './generate'` / 包入口导入路径零变化。
export type { GenerationDelta };

// ── Dogfood T1 D2 resilience constants ──
//
// #50: zen-go-style gateways hang minute-long uncapped generations. Fail-fast
// + a 32K default cap keep requests bounded; see design.md §1.2.

/** Default maxTokens guardrail when the caller sets none (both protocol paths). */
const MAX_TOKENS_GUARDRAIL = 32_768;
/**
 * Degraded cap for the guardrail-compat fallback on Anthropic-compatible
 * endpoints: `max_tokens` is a hard-required field there, so "remove the cap"
 * degrades to the pre-guardrail default instead of being omitted entirely.
 */
const ANTHROPIC_FALLBACK_MAX_TOKENS = 16_384;
/** First-event liveness window for streaming attempts (design: 60s). */
const FIRST_EVENT_TIMEOUT_MS = 60_000;
/**
 * dogfood R2 #7: background-lane first-event window. Child agents / chapter
 * chains run top-spec thinking tasks whose first SSE event legitimately
 * arrives after minutes (measured: d4-pro + thinking max + ~10K-token prompt
 * → 60s with ZERO events, hard-killed by the interactive guard). Background
 * lanes get 240s instead; interactive lanes keep 60s verbatim.
 */
const BACKGROUND_FIRST_EVENT_TIMEOUT_MS = 240_000;
/**
 * dogfood R2 #7: hard total-duration ceiling on the background lane's
 * non-streaming timeout fallback. The fallback exists because "no event in
 * 240s" proves the endpoint slow-not-dead — but the non-streaming path has no
 * timeout of its own (#50's exact shape), so this cap keeps the fallback a
 * bounded wait rather than reintroducing an unbounded hang.
 */
const BACKGROUND_FALLBACK_TOTAL_TIMEOUT_MS = 600_000;
/**
 * dogfood R2 #7: lane-selected first-event window for one streaming attempt.
 * Every createFirstEventGuard / connectTimeoutMs call site resolves through
 * this — the quick-retry attempt rebuilds its guard from the same ctx, so the
 * retry window follows the lane automatically. Non-streaming paths never
 * consult it (their duration bound is the maxTokens guardrail, unchanged).
 */
function firstEventWindowMs(ctx: ProtocolCallContext | undefined): number {
  return ctx?.lane === 'background' ? BACKGROUND_FIRST_EVENT_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS;
}

/**
 * 09-12 子3 §3 ⑨（窗口值源覆盖）: a per-key `timeoutSeconds` REPLACES the lane
 * default as the window VALUE — it feeds every firstEventWindowMs consumer
 * (the OpenAI stream's connectTimeoutMs + first-event guard, the Anthropic
 * stream's guard; the quick-retry attempt rebuilds through here too, so the
 * override stays source-identical across retries). The window's DISPOSITION is
 * untouched: dialogue still throws on timeout, background still gets the
 * bounded 600s non-streaming fallback. Non-streaming paths never consult it
 * (unchanged — their duration bound is the maxTokens guardrail). Exported for
 * unit tests (pure value-source selection).
 */
export function streamWindowMs(model: ResolvedModel, ctx: ProtocolCallContext | undefined): number {
  return model.timeoutSeconds !== undefined ? model.timeoutSeconds * 1000 : firstEventWindowMs(ctx);
}
/**
 * Compose `outer` with a hard `ms` ceiling (dogfood R2 #7). Caller-cancel
 * passthrough AND a total-duration timer are both wired in, so the composed
 * signal aborts on whichever comes first. Prefers AbortSignal.any (Node ≥20.3
 * / Electron ≥31); the manual controller below is the belt for older
 * runtimes where the static is missing.
 */
function signalWithTimeout(outer: AbortSignal | undefined, ms: number): AbortSignal {
  const ceiling = AbortSignal.timeout(ms);
  if (outer === undefined) return ceiling;
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([outer, ceiling]);
  const controller = new AbortController();
  const adopt = (reason: unknown) => controller.abort(reason);
  if (outer.aborted) controller.abort(outer.reason);
  else outer.addEventListener('abort', () => adopt(outer.reason), { once: true });
  if (ceiling.aborted) controller.abort(ceiling.reason);
  else ceiling.addEventListener('abort', () => adopt(ceiling.reason), { once: true });
  return controller.signal;
}
/** Backoff between connection-window retries inside the streaming path — mirrors retry.ts defaults. */
const STREAM_RETRY_BASE_DELAY_MS = 800;
/**
 * Kimi K3 streaming cap carve-out (thinking adapters design §2.2): K3's
 * official output ceiling equals its 1M context window, so a default top-out
 * there means hour-level generations. The DEFAULT streaming cap for kimi-k3
 * clamps to 4×128K; an explicit request.maxTokens still rides at its value
 * (design: "custom can go higher").
 */
const KIMI_K3_STREAM_CAP_CLAMP = 262_144;
/**
 * claude-budget max_tokens headroom (thinking adapters design §2.1): legacy
 * extended thinking requires budget_tokens < max_tokens, so the total lifts to
 * budget + 8192 of answer room whenever the caller's cap sits below that.
 */
const CLAUDE_BUDGET_MAX_TOKENS_HEADROOM = 8_192;

// ── Provider factory ──

export function createProvider(
  model: ResolvedModel,
  opts?: {
    connectTimeoutMs?: number;
    /**
     * Request-level JSON body patch (thinking adapters design §2.1): the
     * OpenAI-compatible body is assembled inside @ai-sdk/openai, which has no
     * parameter slot for vendor thinking fields (research B §1.3) — the fetch
     * wrapper is the only injection seam on this path.
     */
    bodyPatch?: (body: Record<string, unknown>) => void;
  },
): LanguageModelV3 {
  // dogfood R2 #7: REASONING_CONTENT_KINDS vendors get the reasoning surfacing
  // wrapper (see withReasoningContentSurfacing) — every other model keeps the
  // byte-identical fetch chain. The connect-timeout wrapper sits OUTSIDE it:
  // the surfacing transform resolves the fetch promise at headers (the SSE
  // rewrite is lazy), so the connect-window semantics are unchanged.
  const surfacingBase =
    model.thinkingKind !== undefined && REASONING_CONTENT_KINDS.has(model.thinkingKind)
      ? withReasoningContentSurfacing(patchNullContentFetch)
      : patchNullContentFetch;
  const base = opts?.connectTimeoutMs
    ? withConnectTimeout(surfacingBase, opts.connectTimeoutMs)
    : surfacingBase;
  const patched = opts?.bodyPatch ? withBodyPatch(base, opts.bodyPatch) : base;
  // 09-12 子3：customHeaders 挂最外层（同名覆盖内建头）；verifySsl dispatcher 同位。
  // 零配置键零包装——无这两个字段时 fetch 链与子3 前字节级一致。
  const withHeaders =
    model.customHeaders !== undefined && Object.keys(model.customHeaders).length > 0
      ? withCustomHeaders(patched, model.customHeaders)
      : patched;
  const fetchFn = model.verifySsl === true ? withVerifySsl(withHeaders) : withHeaders;
  const openai = createOpenAI({
    baseURL: normalizeBaseUrl(model.baseUrl),
    apiKey: model.apiKey,
    fetch: fetchFn,
  });
  return openai.chat(model.modelId);
}

/**
 * Wraps a fetch so a request-level JSON body patch runs before the inner fetch
 * (same parse → mutate → reserialize pattern as `patchNullContentFetch`, which
 * it chains OUTSIDE — independent concerns, order irrelevant). Non-JSON or
 * non-object bodies pass through untouched.
 */
function withBodyPatch(
  inner: typeof globalThis.fetch,
  patch: (body: Record<string, unknown>) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const json: unknown = JSON.parse(init.body);
        if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
          patch(json as Record<string, unknown>);
          init = { ...init, body: JSON.stringify(json) };
        }
      } catch { /* not JSON, pass through */ }
    }
    return inner(input, init);
  };
}

/**
 * 09-12 子3 §3 ①: per-key custom headers on the OpenAI-path fetch chain —
 * the SDK builds its headers internally, so the OUTERMOST wrapper is the only
 * seam where a same-name override can win (documented gateway semantics:
 * HTTP-Referer / X-Route-* / replacement auth). `new Headers(init?.headers)`
 * tolerates all three init.headers shapes (Headers instance / [string,string][]
 * / plain object). Independent of withBodyPatch (headers vs body) — order
 * irrelevant, same as patchNullContentFetch's pairing.
 */
function withCustomHeaders(
  inner: typeof globalThis.fetch,
  customHeaders: Record<string, string>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(customHeaders)) {
      headers.set(name, value);
    }
    return inner(input, init === undefined ? { headers } : { ...init, headers });
  };
}

/**
 * 09-12 子3 §3 ⑧: per-key TLS skip. `dispatcher` is a non-standard fetch init
 * field consumed by undici's fetch (Node's global fetch is undici-backed;
 * lib.dom's RequestInit doesn't carry it — local cast). The insecure Agent is
 * the lazy process singleton from http.ts (getInsecureDispatcher) — never
 * globally installed; only keys that explicitly set verifySsl route through it.
 */
function withVerifySsl(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const next: RequestInit = init === undefined ? {} : { ...init };
    (next as { dispatcher?: unknown }).dispatcher = getInsecureDispatcher();
    return inner(input, next);
  };
}

// Some OpenAI-compatible APIs (e.g. DashScope) reject `content: null` on
// assistant messages.
const patchNullContentFetch: typeof globalThis.fetch = async (input, init) => {
  if (init?.body && typeof init.body === 'string') {
    try {
      const json = JSON.parse(init.body);
      if (Array.isArray(json.messages)) {
        for (const msg of json.messages) {
          if (msg.role === 'assistant' && msg.content === null) {
            msg.content = '';
          }
        }
        init = { ...init, body: JSON.stringify(json) };
      }
    } catch { /* not JSON, pass through */ }
  }
  const res = await globalThis.fetch(input, init);
  if (!res.ok) {
    const cloned = res.clone();
    const body = await cloned.text().catch(() => '');
    // CR-36 (#10 direction): endpoint domains stay out of logs — keep the
    // request PATH for triage, drop the origin.
    let path: string;
    try {
      path = new URL(typeof input === 'string' ? input : (input as Request).url).pathname;
    } catch {
      path = '/unknown';
    }
    console.error('[model-protocols] upstream error', {
      status: res.status,
      path,
      body: body.slice(0, 500),
    });
  }
  return res;
};

// ── `reasoning_content` surfacing (dogfood R2 #7, 2026-08-25) ──
//
// ROOT CAUSE this fixes: the GLM/Kimi/DeepSeek ecosystem streams vendor
// reasoning as a separate `reasoning_content` field on each SSE chunk
// (`delta: {content: null, reasoning_content: "…"}`). @ai-sdk/openai's chunk
// zod boundary strips that unknown field, so a chunk carrying only reasoning
// maps to ZERO stream parts — during the vendor's whole reasoning phase the
// SDK emits nothing. With top-spec thinking on a long task (measured:
// deepseek-v4-pro + thinking max + 25K-char dispatch prompt) that phase runs
// past the first-event watchdog: the guard kills a HEALTHY stream at 240s,
// quick-retries into another minutes-long silent reasoning phase, kills again,
// and the degraded non-streaming call drowns with it. Differential replay
// (in-app probe, 2026-08-25): the byte-identical body over raw fetch streams
// fine (1.4MB of reasoning_content SSE in 75s) while the SDK path emits zero
// deltas — the wire is healthy, the field is dropped client-side.
//
// FIX: a fetch-level response transform for the REASONING_CONTENT_KINDS
// vendors (verified set — unknown kinds keep byte-identical passthrough).
// Streaming responses are rewritten line-by-line: `reasoning_content` deltas
// become `<think>`-wrapped `content` deltas, which the already-installed
// extractReasoningMiddleware converts into proper reasoning-delta parts
// (liveness for the watchdog + reasoning for the UI/aggregation). Non-stream
// JSON responses get `message.reasoning_content` folded into
// `<think>…</think>`-prefixed `content` the same way.

/** Tag used by the reasoning surfacing below — MUST match REASONING_TAG / the middleware's tagName. */
const REASONING_SURFACING_TAG = 'think';

type ReasoningSurfacingState = { insideThink: boolean };

/** Rewrite one SSE line (without its newline). Returns null for verbatim passthrough. */
function rewriteSseLine(rawLine: string, state: ReasoningSurfacingState): string | null {
  if (!rawLine.startsWith('data:')) return null; // event:/comment/blank lines pass through untouched
  const payload = rawLine.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null; // multi-line data / non-JSON frames: never mangle
  }
  const choice = (parsed as { choices?: unknown[] })?.choices?.[0] as
    | { delta?: Record<string, unknown>; finish_reason?: unknown }
    | undefined;
  const delta = choice?.delta;
  if (!delta || typeof delta !== 'object') return null;

  const reasoning = delta.reasoning_content;
  const content = delta.content;
  // CR-41①: some gateways open the reasoning phase with an EMPTY
  // reasoning_content field before the real text arrives. An empty chunk must
  // not open the think block — fall through so it passes through verbatim
  // (and, when reasoning is already flowing, leaves the open block alone).
  if (
    typeof reasoning === 'string' &&
    reasoning.length > 0 &&
    (content === null || content === undefined || content === '')
  ) {
    // Reasoning-phase chunk: fold into the think block.
    const opening = state.insideThink ? '' : `<${REASONING_SURFACING_TAG}>`;
    state.insideThink = true;
    delta.content = `${opening}${reasoning}`;
    delete delta.reasoning_content;
    return `data: ${JSON.stringify(parsed)}`;
  }
  if (
    state.insideThink &&
    (typeof content === 'string' || Array.isArray(delta.tool_calls) || choice.finish_reason != null)
  ) {
    // First non-reasoning chunk after reasoning: close the block BEFORE it
    // flows (own synthetic chunk — content/tool_calls stay in their original,
    // schema-verified shapes). Interleaved reasoning+content in one chunk is
    // not a shape the ecosystem emits; the content wins, reasoning drops.
    state.insideThink = false;
    const closing = {
      choices: [
        { index: 0, delta: { content: `</${REASONING_SURFACING_TAG}>` }, finish_reason: null },
      ],
    };
    if (typeof reasoning === 'string') delete delta.reasoning_content;
    // Two events — the blank line terminates the synthetic closing event before
    // the original chunk (SSE joins consecutive data: lines into ONE event,
    // which would break the downstream JSON parser).
    return `data: ${JSON.stringify(closing)}\n\ndata: ${JSON.stringify(parsed)}`;
  }
  return null;
}

/**
 * Fetch wrapper surfacing `reasoning_content` (see the block comment above).
 * Streaming responses get a line-buffered SSE transform; non-streaming JSON
 * responses get a one-shot message rewrite. Everything else — other vendors,
 * error statuses, non-JSON bodies — passes through byte-identical.
 *
 * CR-40 hardening: the response's own content-type is the single shape
 * signal. The old request-body sniff (`JSON.parse(init.body).stream`) went
 * blind whenever the body was not a parseable string, and misrouted quirky
 * gateways that answer `stream:true` with JSON (or vice versa).
 */
export function withReasoningContentSurfacing(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (!res.ok || !res.body) return res;
    const contentType = res.headers?.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const state: ReasoningSurfacingState = { insideThink: false };
      let buffer = '';
      const transformed = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const rawLine = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              // Rewritten lines replace the original; everything else passes
              // through verbatim (blank separators, [DONE], non-data frames).
              const rewritten = rewriteSseLine(rawLine.replace(/\r$/, ''), state);
              controller.enqueue(encoder.encode(`${rewritten !== null ? rewritten : rawLine}\n`));
            }
          },
          flush(controller) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              const rewritten = rewriteSseLine(buffer.trim(), state);
              controller.enqueue(encoder.encode(`${rewritten !== null ? rewritten : buffer}\n`));
            }
            if (state.insideThink) {
              // Stream ended mid-reasoning (abort / truncation): close the
              // block so the middleware never sees an unterminated tag.
              // CR-41②: the terminal data line above may carry NO blank
              // terminator (truncated streams) — terminate it FIRST. SSE joins
              // consecutive data: lines into ONE event, so emitting the
              // closing right after a non-blank line would corrupt both
              // frames into one unparseable event.
              const closing = {
                choices: [
                  { index: 0, delta: { content: `</${REASONING_SURFACING_TAG}>` }, finish_reason: null },
                ],
              };
              controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(closing)}\n\n`));
            }
          },
        }),
      );
      // CR-40③: the transform rewrites body bytes — a buffered gateway's
      // content-length would be stale on the rebuilt Response. Drop it.
      const streamHeaders = new Headers(res.headers);
      streamHeaders.delete('content-length');
      return new Response(transformed, {
        status: res.status,
        statusText: res.statusText,
        headers: streamHeaders,
      });
    }
    if (contentType.includes('application/json')) {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as {
          choices?: Array<{ message?: { reasoning_content?: unknown; content?: unknown } }>;
        };
        const message = parsed.choices?.[0]?.message;
        const reasoning = message?.reasoning_content;
        const content = message?.content;
        // CR-40②: array-shaped message.content (multimodal parts) must never
        // be template-stringified into "[object Object]" — only
        // string/null/undefined content is rewritable; any other shape falls
        // through to the verbatim return below.
        if (
          message &&
          typeof reasoning === 'string' &&
          reasoning.length > 0 &&
          (content === null || content === undefined || typeof content === 'string')
        ) {
          message.content =
            `<${REASONING_SURFACING_TAG}>${reasoning}</${REASONING_SURFACING_TAG}>${content ?? ''}`;
          delete message.reasoning_content;
          // CR-40③: the folded body's length no longer matches the original
          // response's content-length — drop the stale header.
          const jsonHeaders = new Headers(res.headers);
          jsonHeaders.delete('content-length');
          return new Response(JSON.stringify(parsed), {
            status: res.status,
            statusText: res.statusText,
            headers: jsonHeaders,
          });
        }
      } catch { /* malformed JSON: fall through to verbatim */ }
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
}

/**
 * Wraps a fetch so it aborts if no response (headers) arrives within `ms`.
 * The timer only covers the connection window — once the fetch resolves it is
 * cleared, so slow-but-alive mid-stream generation is never killed (mid-stream
 * silence timeout is an explicit non-goal, design §10).
 *
 * CR-T1-001: the outer→controller abort chaining deliberately stays attached
 * for the body's lifetime. Removing it when the fetch promise resolves (i.e.
 * when headers arrive) would sever every later abort — the caller's cancel,
 * the first-delta watchdog — from the in-flight body read, leaving an
 * unbounded hang on streams whose gateway never closes.
 */
function withConnectTimeout(fetchFn: typeof globalThis.fetch, ms: number): typeof globalThis.fetch {
  return (input, init) => {
    const outer = init?.signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new ProtocolTimeoutError(`No response within ${ms}ms (streaming connect timeout)`));
    }, ms);
    return fetchFn(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      // NOT removing onOuterAbort here — see the doc comment above.
    });
  };
}

// ── Thinking control injection (thinking adapters task, design §2.1) ──
//
// One translation function serves BOTH protocol paths: `buildAnthropicBody`
// calls it on the body it assembles by hand, while the OpenAI-compatible path
// injects through a request-level fetch body patch (see createProvider). The
// unified-level → vendor-value mapping itself lives in shared-contracts
// (THINKING_PROFILES / mapLevel, single source) — this layer only dispatches
// wire shapes per (kind, protocol).

/** Effective thinking state after resolving a ThinkingControl against a kind. */
type EffectiveThinking = {
  /** Vendor effort value; claude-budget carries budget_tokens here as a numeric string. */
  effort?: string;
  /** Effective on/off state (forced models degrade illegal off to the weakest legal on state). */
  on: boolean;
  /** Whether any thinking parameter will be injected at all. */
  injected: boolean;
  /** Runtime guard: 'off' arrived on a forced model → degraded to the weakest legal on state. */
  offDegraded?: boolean;
  /** Runtime guard: a custom value failed re-validation → injection skipped. */
  invalidCustom?: string;
};

/**
 * Resolve a control into the effective vendor state. PURE — warnings for the
 * degraded/invalid cases are emitted by `applyThinkingControls` so repeated
 * reads (e.g. the zen probe arming check) never double-log. `limits` feeds the
 * limits-aware custom re-validation (CR-020).
 */
function resolveThinking(
  control: ThinkingControl,
  kind: ThinkingKind,
  limits?: ResolvedModel['limits'],
): EffectiveThinking {
  if (control.level === 'auto') return { on: false, injected: false };
  if (control.level === 'custom') {
    // Defense in depth: the schema + UI gate custom values, but this layer can
    // be reached with hand-built requests — re-validate, skip on failure.
    if (!control.custom) return { on: false, injected: false, invalidCustom: '' };
    const checked = validateCustom(kind, control.custom, limits);
    if (!checked.ok) return { on: false, injected: false, invalidCustom: control.custom };
    return { effort: checked.value, on: true, injected: true };
  }
  const mapped = mapLevel(kind, control.level);
  if (mapped.effort === undefined && mapped.on === undefined) {
    return { on: false, injected: false }; // gemini (v1 not injectable) and friends
  }
  if (mapped.on === false && !THINKING_PROFILES[kind].offLegal) {
    // Forced-thinking model + illegal off (the UI normally greys this out):
    // degrade to the weakest legal on state — GLM-5.3's own migration guidance
    // is enabled + reasoning_effort=low; Claude forced kinds degrade to
    // adaptive+low (design §2.1).
    const fallback = mapLevel(kind, 'low');
    return { effort: fallback.effort, on: true, injected: true, offDegraded: true };
  }
  return { effort: mapped.effort, on: mapped.on !== false, injected: true };
}

/**
 * Kinds with a verified Anthropic-format thinking wire shape.
 */
const ANTHROPIC_THINKING_KINDS = new Set<ThinkingKind>([
  'claude-forced',
  'claude-5',
  'claude-4x',
  'claude-budget',
  'deepseek-v4', // Anthropic-FORMAT endpoint, but with DeepSeek's own field names (research A §4)
]);

// CR-006: kind × protocol mismatch memory. A claude-* model behind an
// OpenAI-compatible relay (or a GLM/Kimi/OpenAI kind at an Anthropic-format
// endpoint) swallows the thinking policy silently today — the UI offered
// levels (the kind IS injectable, just on the other protocol), the wire body
// carries nothing, and the zen probe only watches the Anthropic path. Warn
// once per (keyId, kind), mirroring the zen probe's module-level form.
const kindProtocolSkipWarned = new Set<string>();

function warnKindProtocolSkipOnce(
  protocol: ModelProtocol,
  kind: ThinkingKind,
  skipWarnKey: string | undefined,
): void {
  const key = skipWarnKey ?? `${protocol}:${kind}`;
  if (kindProtocolSkipWarned.has(key)) return;
  kindProtocolSkipWarned.add(key);
  console.warn(
    `[model-protocols] thinking policy for a ${kind} model is not injectable on the ${protocol} path (kind × protocol mismatch); skipping injection — the selected thinking level will not reach the model`,
  );
}

// 09-12 子3 §4.2: Anthropic Messages API has no frequency/presence penalty
// fields — a per-model default for them cannot be delivered on this path.
// drop + warn-once per (keyId, modelId), mirroring the CR-006 form above
// (silent drop would leave the user believing the knobs are live).
const penaltySkipWarned = new Set<string>();

function warnPenaltySkipOnce(model: ResolvedModel): void {
  const key = `${model.keyId}:${model.modelId}`;
  if (penaltySkipWarned.has(key)) return;
  penaltySkipWarned.add(key);
  // 日志红线：只记模型名，不记任何 headers/extraBody 内容。
  console.warn(
    `[model-protocols] frequency/presence penalty defaults are not accepted by the Anthropic Messages API; dropping them (model ${model.modelId})`,
  );
}

/**
 * Translate thinking controls onto a request body (design §2.1 dispatch
 * table). Returns whether anything was injected — callers use it to tell
 * "asked on, got nothing back" apart for the zen probe. `auto`, absent
 * controls, unknown kinds, and gemini leave the body byte-identical
 * (zero-regression discipline). `context` is optional call-site metadata:
 * `skipWarnKey` dedupes the CR-006 kind×protocol warning per (keyId, kind),
 * and `limits` feeds the limits-aware custom re-validation (CR-020).
 */
export function applyThinkingControls(
  body: Record<string, unknown>,
  control: ThinkingControl | undefined,
  kind: ThinkingKind | undefined,
  protocol: ModelProtocol,
  context?: {
    /** Warn-once key for the CR-006 kind × protocol mismatch — `${keyId}:${kind}` from the live call sites. */
    skipWarnKey?: string;
    /** Model's official limits, for the limits-aware custom validation (CR-020). */
    limits?: ResolvedModel['limits'];
  },
): boolean {
  if (!control || !kind) return false;
  const effective = resolveThinking(control, kind, context?.limits);
  if (!effective.injected) {
    if (effective.invalidCustom !== undefined) {
      console.warn(
        `[model-protocols] thinking custom value '${effective.invalidCustom}' is not valid for ${kind}; skipping thinking injection`,
      );
    }
    return false;
  }
  if (effective.offDegraded) {
    console.warn(
      `[model-protocols] thinking 'off' is illegal on ${kind} (forced-thinking model); degrading to the weakest legal on state`,
    );
  }

  if (protocol === 'anthropic-compatible') {
    switch (kind) {
      case 'claude-forced':
      case 'claude-5':
      case 'claude-4x': {
        // Adaptive generations; display 'summarized' because the 'omitted'
        // default returns empty-text blocks and the user explicitly asked for
        // thinking (expectation management, design §2.1).
        body.thinking = effective.on
          ? { type: 'adaptive', display: 'summarized' }
          : { type: 'disabled' };
        if (effective.on && effective.effort !== undefined) {
          body.output_config = { effort: effective.effort };
        }
        break;
      }
      case 'claude-budget': {
        if (effective.on && effective.effort !== undefined) {
          const budget = Number(effective.effort);
          body.thinking = { type: 'enabled', budget_tokens: budget };
          // Legacy rule: budget_tokens must stay BELOW max_tokens — lift the
          // total so the request stays legal even when the caller's cap sits
          // under budget + answer room (design §2.1).
          const floor = budget + CLAUDE_BUDGET_MAX_TOKENS_HEADROOM;
          const current = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
          body.max_tokens = Math.max(current, floor);
        } else {
          body.thinking = { type: 'disabled' };
        }
        break;
      }
      case 'deepseek-v4': {
        // DeepSeek's Anthropic-format endpoint speaks DIFFERENT field names
        // than Claude's own (research A §4): the switch lives at
        // `reasoning.effort` ('none' = off), strength rides `output_config`.
        body.reasoning = { effort: effective.on ? (effective.effort ?? 'high') : 'none' };
        if (effective.on && effective.effort !== undefined) {
          body.output_config = { effort: effective.effort };
        }
        break;
      }
      default:
        // OpenAI-path kinds routed at an Anthropic-format endpoint (gemini
        // never reaches here — it early-returns as non-injectable): no
        // verified wire shape — leave the body alone, warn once (CR-006).
        warnKindProtocolSkipOnce(protocol, kind, context?.skipWarnKey);
        return false;
    }
  } else {
    switch (kind) {
      case 'glm-forced-effort':
      case 'glm-forced-basic':
      case 'glm-dynamic-effort':
      case 'glm-dynamic-basic':
      case 'kimi-k2':
      case 'kimi-k27-forced': // CR-009: same ecosystem switch — 'enabled' only ever lands here (offLegal=false)
      case 'deepseek-v4':
        // GLM / Kimi / DeepSeek ecosystem switch: top-level `thinking.type`
        // (sub-keys differ per vendor for preserved-thinking features, which
        // follow compaction semantics — v1 sends the switch only).
        body.thinking = { type: effective.on ? 'enabled' : 'disabled' };
        break;
      case 'kimi-k3':
        // K3's official guidance is to NOT send thinking at all (always on;
        // disabled errors) — only reasoning_effort applies (research A §2).
        break;
      case 'openai-o':
      case 'gpt5':
        // OpenAI first-party endpoints have no thinking switch parameter.
        break;
      default:
        // Claude kinds routed at an OpenAI-compatible relay (e.g. a claude-*
        // model behind a middleman gateway): nothing verified to inject —
        // leave the body alone, warn once (CR-006).
        warnKindProtocolSkipOnce(protocol, kind, context?.skipWarnKey);
        return false;
    }
    if (effective.effort !== undefined) body.reasoning_effort = effective.effort;
    else delete body.reasoning_effort; // this function owns the key — an off state must not carry a stale effort
  }

  const profile = THINKING_PROFILES[kind];
  if (profile.dropTemperature && effective.on) delete body.temperature;
  return true;
}

/**
 * Request-level body patch for the OpenAI-compatible path: thinking injection
 * + the kimi-k3 parameter rename. Undefined = nothing to inject
 * (auto/absent/unknown kind on any non-kimi-k3 model) — the fetch chain stays
 * untouched and the wire body byte-identical.
 */
function buildOpenAiThinkingPatch(
  model: ResolvedModel,
  request: TextGenerationRequest,
): ((body: Record<string, unknown>) => void) | undefined {
  const kind = model.thinkingKind;
  const control = request.thinking;
  const activeControl = control !== undefined && control.level !== 'auto' ? control : undefined;
  // CR-010: the kimi-k3 max_tokens → max_completion_tokens rename is NOT
  // gated on a non-auto thinking control. The cap top-out (resolveStreamingCap)
  // already breaks kimi-k3's byte-level zero-regression in auto mode — sending
  // the raised 262,144 cap under the OLD parameter name is not a request shape
  // the vendor documents (K3 switched to max_completion_tokens, research C
  // theme 2). Auto/absent controls on every OTHER kind keep the patch fully
  // absent (zero regression holds there).
  if (!activeControl && kind !== 'kimi-k3') return undefined;
  return (body) => {
    if (activeControl && kind) {
      applyThinkingControls(body, activeControl, kind, 'openai-compatible', {
        skipWarnKey: `${model.keyId}:${kind}`,
        limits: model.limits,
      });
    }
    if (kind === 'kimi-k3' && typeof body.max_tokens === 'number') {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
  };
}

/**
 * Thinking adapters task (B block, design §5.2): the `reasoning_content`
 * ecosystem — GLM / Kimi / DeepSeek. DeepSeek (with tools) and Kimi K3/k2.7
 * hard-require historical reasoning back; GLM's standard API ignores it
 * (harmless). OpenAI-first-party kinds are NOT here: unknown message fields
 * would 400 on strict endpoints.
 */
const REASONING_CONTENT_KINDS = new Set<NonNullable<ResolvedModel['thinkingKind']>>([
  'glm-forced-effort',
  'glm-forced-basic',
  'glm-dynamic-effort',
  'glm-dynamic-basic',
  'kimi-k3',
  'kimi-k2',
  'kimi-k27-forced', // CR-009: Preserved always on (keep default 'all') — round-trip hard-required
  'deepseek-v4',
]);

/**
 * Historical-reasoning round-trip for the OpenAI-compatible path (design
 * §5.2). `buildOpenAiArgs` rebuilds every message into @ai-sdk's ModelMessage
 * shape, which has no `reasoning_content` slot — the wire field would be
 * dropped at assembly. This patch re-attaches it onto the serialized body:
 * non-system request messages map 1:1 onto wire `messages` (the system prompt
 * is hoisted by the SDK into its own message, skipped during the zip). A count
 * mismatch aborts the whole injection — fail-open to the pre-feature body
 * rather than mis-attaching reasoning to the wrong turn.
 */
function buildOpenAiReasoningRoundTripPatch(
  model: ResolvedModel,
  request: TextGenerationRequest,
): ((body: Record<string, unknown>) => void) | undefined {
  if (!model.thinkingKind || !REASONING_CONTENT_KINDS.has(model.thinkingKind)) return undefined;
  const nonSystem = request.messages.filter((m) => m.role !== 'system');
  const pending = nonSystem.filter(
    (m): m is Extract<GenerationMessage, { role: 'assistant' }> =>
      m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0,
  );
  if (pending.length === 0) return undefined;
  return (body) => {
    const wireMessages = body.messages;
    if (!Array.isArray(wireMessages)) return;
    // Zip wire messages against the non-system request order, skipping the
    // SDK-hoisted system message; attach `reasoning_content` on matches.
    let requestIndex = 0;
    let attached = 0;
    for (const wire of wireMessages) {
      if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return; // unexpected shape → abort injection
      const role = (wire as { role?: unknown }).role;
      if (role === 'system') continue;
      const source = nonSystem[requestIndex];
      requestIndex += 1;
      if (source?.role === 'assistant' && source.reasoning_content) {
        (wire as Record<string, unknown>).reasoning_content = source.reasoning_content;
        attached += 1;
      }
    }
    if (requestIndex !== nonSystem.length || attached !== pending.length) {
      // Alignment drifted (unexpected SDK shape) — roll back so a mis-zip can
      // never reach the wire half-applied.
      for (const wire of wireMessages) {
        if (wire && typeof wire === 'object' && !Array.isArray(wire)) {
          delete (wire as Record<string, unknown>).reasoning_content;
        }
      }
    }
  };
}

/** Plain-object check for the extraBody deep merge (arrays/null/scalars are leaves). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 09-12 子3 §4.3: deep-merge a per-model extraBody into a request body — per
 * key: both sides plain objects → recurse; otherwise the extraBody value
 * REPLACES the protocol-layer value (user-explicit wins — the escape hatch's
 * whole point, consistent with the priority-chain direction).
 */
function mergeExtraBody(target: Record<string, unknown>, extra: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extra)) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeExtraBody(existing, value);
    } else {
      target[key] = value;
    }
  }
}

/** Per-model extraBody attachment as one OpenAI-path patch (design §4.3 — bodyPatch seam, thinking 注入同缝). */
function buildOpenAiExtraBodyPatch(
  model: ResolvedModel,
): ((body: Record<string, unknown>) => void) | undefined {
  const extra = model.extraBody;
  if (extra === undefined || Object.keys(extra).length === 0) return undefined;
  return (body) => mergeExtraBody(body, extra);
}

/** Combined request-level patch for one OpenAI-compatible call site. */
function buildOpenAiRequestPatch(
  model: ResolvedModel,
  request: TextGenerationRequest,
): ((body: Record<string, unknown>) => void) | undefined {
  const patches = [
    buildOpenAiThinkingPatch(model, request),
    buildOpenAiReasoningRoundTripPatch(model, request),
    buildOpenAiExtraBodyPatch(model), // 子3：extraBody 尾部合并（在 thinking/round-trip 之后 = 用户显式最优先）
  ].filter((p): p is (body: Record<string, unknown>) => void => p !== undefined);
  if (patches.length === 0) return undefined;
  return (body) => {
    for (const patch of patches) patch(body);
  };
}

// zen probe (design §2.3): a self-built Anthropic-compatible gateway may
// silently strip unknown fields — an injected ON-state thinking request whose
// response carries zero thinking blocks and zero reasoning means the control
// never reached the model. Warn once per (keyId, modelId), module-level memory.
const zenThinkingStripWarned = new Set<string>();

/** True when the request resolved to an ON-state thinking injection on the Anthropic path. */
function requestedAnthropicThinkingOn(model: ResolvedModel, request: TextGenerationRequest): boolean {
  if (model.protocol !== 'anthropic-compatible') return false;
  const control = request.thinking;
  if (!control || control.level === 'auto' || !model.thinkingKind) return false;
  if (!ANTHROPIC_THINKING_KINDS.has(model.thinkingKind)) return false;
  return resolveThinking(control, model.thinkingKind).on;
}

function warnZenThinkingStripOnce(model: ResolvedModel): void {
  const probeKey = `${model.keyId}:${model.modelId}`;
  if (zenThinkingStripWarned.has(probeKey)) return;
  zenThinkingStripWarned.add(probeKey);
  console.warn(
    `[model-protocols] thinking controls were injected for ${model.modelId} but the response carries no thinking blocks or reasoning — the gateway may be silently stripping the thinking field (research B §4)`,
  );
}

// ── Text generation (via Vercel AI SDK) ──

const ANTHROPIC_VERSION = '2023-06-01';

function mapFinishReason(raw: string | undefined): GenerationFinishReason | undefined {
  switch (raw) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'content-filter': return 'content_filter';
    case 'tool-calls': return 'tool_use';
    case undefined: return undefined;
    default: return 'other';
  }
}

function mapAnthropicFinishReason(raw: string | null | undefined): GenerationFinishReason | undefined {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case null:
    case undefined:
      return undefined;
    default:
      return 'other';
  }
}

// ── 09-12 usage-panel：两公共入口计量 wrapper（design §1）──────────────────────
//
// 插桩单源 = 两公共入口（generateText/generateTextStream）的最外层——CLI 早退三分派
// 在 wrapper **之内**（CLI 调用同落行）。wrapper 只观察：run 恰被调一次、失败原样重抛
// （计量绝不改变错误语义）、sink 分发 best-effort（dispatchGenerationCallRecord 内
// try/catch）——不是重试/韧性包装，「CLI 早退先于一切重试/韧性包装」的既有纪律不受
// 影响（早退仍先于 generateTextInternal/流式韧性层，只多一层单发观测）。
//
// 单行性：流式内部降级走 generateTextInternal（不回公共入口）——一条逻辑调用恒一行。
//
// CR-18 零伪造：usage 单源 = response.usage，缺的计数器落 ABSENT（≠0）、totalTokens
// 缺席不由 input+output 合成；失败行 token 恒 ABSENT（abort/中断的部分消耗不可知）。
// C3.1 v2 演进：CLI attempt 旁挂 usage 在场则如实落列（「未知才 ABSENT」，见 catch）。

// 截断常量/usage→token 字段映射已上收 usageSink.ts（C3.1：三新入口 wrapper 与 CLI
// attempt 收集器共用单源）——LEDGER_ERROR_MESSAGE_CHAR_CAP / truncateForLedger /
// usageToLedgerTokenFields。

/** 计量 wrapper 的 run 钩子：markFirstDelta 在首个 delta 抵达时调（流式 first_delta_ms）。 */
type UsageMeteringHooks = { markFirstDelta: () => void };

async function withUsageMetering(
  meta: {
    model: ResolvedModel;
    request: TextGenerationRequest;
    /** 入口归一后的 ctx（withLedgerCallContext 唯一装配）——callId 保证在场，CLI attempt 收集器与之同源。 */
    ctx: ProtocolCallContext;
    stream: boolean;
  },
  run: (hooks: UsageMeteringHooks) => Promise<TextGenerationResponse>,
): Promise<TextGenerationResponse> {
  // C3.2 W3：预算硬线前置门（wrapper 族五入口共享单源 enforceBudgetGateOrThrow）——
  // 被拦落 budget 失败行后抛 BudgetExceededError（'budget' ineligible 链不烧），run 与
  // CLI 早退分派都不发起。放行 → 零开销穿过（字节级无 gate 现行为）。
  enforceBudgetGateOrThrow({
    ts: Date.now(),
    protocol: meta.model.protocol,
    keyId: meta.model.keyId,
    modelId: meta.model.modelId,
    taskType: meta.request.taskType,
    lane: meta.ctx.lane,
    sessionKey: meta.request.sessionKey,
    callId: meta.ctx.callId,
    sessionId: meta.ctx.sessionId,
    stream: meta.stream,
  });
  const startedAt = Date.now();
  let firstDeltaAt: number | undefined;
  const identity = {
    ts: startedAt,
    protocol: meta.model.protocol,
    keyId: meta.model.keyId,
    modelId: meta.model.modelId,
    taskType: meta.request.taskType,
    lane: meta.ctx.lane,
    sessionKey: meta.request.sessionKey,
    // C3.1：callId/sessionId 由入口归一保证（withLedgerCallContext）——最终行与 CLI
    // attempt 收集器行共享同一 call_id。
    callId: meta.ctx.callId,
    sessionId: meta.ctx.sessionId,
    stream: meta.stream,
  };
  try {
    const response = await run({
      markFirstDelta: () => {
        if (firstDeltaAt === undefined) firstDeltaAt = Date.now();
      },
    });
    dispatchGenerationCallRecord({
      ...identity,
      success: true,
      // usage 单源映射（CR-18：缺席计数器 ABSENT ≠0，total 缺席不合成）。
      ...usageToLedgerTokenFields(response.usage),
      latencyMs: Date.now() - startedAt,
      firstDeltaMs: firstDeltaAt !== undefined ? firstDeltaAt - startedAt : undefined,
    });
    return response;
  } catch (err) {
    // 分类单源 = 子2 classifyGenerationFailure（errors.ts）——失败行 error_kind 与回退
    // 环 trace.reason 同一判据（行级可对账）。原样重抛：溢出标记/abort/中断语义全保。
    const classified = classifyGenerationFailure(err);
    // C3.1 M1（CR-18 v2「未知才 ABSENT」）：CLI 空 SUCCESS 错误对象旁挂的 attempt usage
    // （driver tagCliEmptySuccess 同点挂）在场则如实落列——失败行不再恒无计量；无旁挂时
    // token 位保持 ABSENT（原形态零变化）。
    const attemptUsage = readCliAttemptUsage(err);
    dispatchGenerationCallRecord({
      ...identity,
      success: false,
      errorKind: classified.kind,
      errorMessage: truncateForLedger(errorMessage(err)),
      ...(attemptUsage !== undefined ? usageToLedgerTokenFields(attemptUsage) : {}),
      latencyMs: Date.now() - startedAt,
      firstDeltaMs: firstDeltaAt !== undefined ? firstDeltaAt - startedAt : undefined,
    });
    throw err;
  }
}

/**
 * C3.1：sessionId 归一单源（CR-7 复核）：trim 后判空——'' 与 whitespace-only 同归
 * ABSENT（空白垃圾落列 = DB 非 NULL 脏值，违两态纪律）；有效值落 trim 后形态
 * （终端列不存首尾空白）。wire（agent 缝 as any 直调豁免 zod parse）与 ctx 两通道
 * 同防线（schema transform 兜不到直调缝）。
 */
function normalizeLedgerSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * C3.1：入口级 ctx 归一（generateText / generateTextStream 两入口唯一装配点）。
 * callId 缺省自生成——每入口调用恰一次，wrapper 最终行与 CLI attempt 收集器行共享同一
 * id；sessionId 从 wire request 归一（normalizeLedgerSessionId：'' / whitespace-only
 * 防线兜底）。无可补字段时返回原引用（既有调用方零分配快径）。
 */
function withLedgerCallContext(ctx: ProtocolCallContext | undefined, request: TextGenerationRequest): ProtocolCallContext {
  const wireSessionId = normalizeLedgerSessionId(request.sessionId);
  const ctxSessionId = normalizeLedgerSessionId(ctx?.sessionId);
  const needsRebuild =
    ctx?.callId === undefined ||
    (ctxSessionId === undefined && wireSessionId !== undefined) ||
    ctx?.sessionId !== ctxSessionId;
  if (!needsRebuild && ctx !== undefined) return ctx;
  return {
    ...ctx,
    callId: ctx?.callId ?? randomUUID(),
    sessionId: ctxSessionId ?? wireSessionId,
  };
}

// ── C3.1：CLI attempt 级记账收集器（design §4）────────────────────────────────
//
// driver 不直接 dispatch——被弃/失败 attempt 的计量事实经 ctx.onMeteringAttempt 上抛，
// 本收集器（CLI 早退分支内组装）统一 dispatch（发射面单点 = wrapper 族 + 本收集器，
// 零业务散点）。行身份取入口归一后的 ledgerCtx——callId 与外层 wrapper 最终行同源，
// 一次逻辑调用的全部行（attempts + final）共享 call_id。finally = 成败两路都落行
// （driver 抛错时 attempt 行先于 wrapper 最终失败行 dispatch——时间序即账序）。

async function runCliWithAttemptLedger(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ledgerCtx: ProtocolCallContext,
  /** 入口实际形态（CR-1 复核：generateText=false / generateTextStreamInner CLI 分支=true）——attempt 行如实落列，不恒标非流。 */
  stream: boolean,
  runDriver: (collectorCtx: ProtocolCallContext) => Promise<TextGenerationResponse>,
): Promise<TextGenerationResponse> {
  const collected: AttemptMeteringRecord[] = [];
  const collectorCtx: ProtocolCallContext = {
    ...ledgerCtx,
    // 本缝是 generate.ts↔driver 的内部约定（网关/业务调用方不传 onMeteringAttempt——
    // types.ts ctx 注释），此处覆写安全。
    onMeteringAttempt: (rec) => {
      collected.push(rec);
    },
  };
  try {
    return await runDriver(collectorCtx);
  } finally {
    for (const rec of collected) {
      dispatchGenerationCallRecord({
        ts: Date.now(),
        protocol: model.protocol,
        keyId: model.keyId,
        modelId: model.modelId,
        taskType: request.taskType,
        lane: ledgerCtx.lane,
        sessionKey: request.sessionKey,
        callId: ledgerCtx.callId,
        sessionId: ledgerCtx.sessionId,
        stream,
        success: rec.success,
        ...(rec.errorKind !== undefined ? { errorKind: rec.errorKind } : {}),
        ...(rec.errorMessage !== undefined ? { errorMessage: truncateForLedger(rec.errorMessage) } : {}),
        ...usageToLedgerTokenFields(rec.usage),
        latencyMs: rec.latencyMs,
      });
    }
  }
}

export async function generateText(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ctx?: ProtocolCallContext,
): Promise<TextGenerationResponse> {
  const ledgerCtx = withLedgerCallContext(ctx, request);
  return withUsageMetering({ model, request, ctx: ledgerCtx, stream: false }, () => {
    // 09-12 agy provider（design §1 复核 H2）：CLI 形态顶部早退——先于一切重试/降级包装。
    // 否则 CLI 502 会落进 generateTextInternal 的 catch（max_tokens 兼容重试 / thinking 剥离
    // 重试）甚至流式层的「回退非流式重发」= 静默冷重启全量重发一次，违反「driver 内不自动
    // 重试」（重试/回退归调用方与子2 链）。CLI 路径自身无超时/护栏包装（print-timeout 即
    // 唯一时长闸，外层兜底在 driver 内）。
    if (model.protocol === 'antigravity-cli') {
      // C3.1：attempt 收集器同罩（空 SUCCESS 重试 / 降级重跑两族每 attempt 落行，
      // design §4 时序）；入口形态 = 非流式（CR-1）。
      return runCliWithAttemptLedger(model, request, ledgerCtx, false, (collectorCtx) =>
        antigravityCliGenerateText(model, request, collectorCtx),
      );
    }
    return generateTextInternal(model, request, ledgerCtx, {});
  });
}

/**
 * Internal options used when the streaming layer degrades to a non-streaming
 * call (dogfood T1 CR-T1-007/008):
 *   - `degradedCap` carries the cap disposition the streaming attempts already
 *     learned (a reduced cap on Anthropic, `'uncapped'` on OpenAI) so the
 *     guardrail is not re-derived — and re-rejected — here;
 *   - `skipQuickRetry` suppresses the non-streaming quick retry: the streaming
 *     layer already quick-retried its connection window, and stacking a second
 *     retry loop would double the request count.
 */
type GenerateTextInternalOpts = {
  degradedCap?: number | 'uncapped';
  skipQuickRetry?: boolean;
};

/**
 * 09-12 子3 design §4.2：per-model defaultTemperature 缺省补位（fill-the-slot，
 * NOT an override——请求级显式值仍然优先；厂商思考约束在 body 组装后仍最高）。
 * 零分配快径：请求级已带值且模型无默认时返回**同一引用**（零配置键字节级不变）。
 * 幂等：流式降级重入（generateTextStreamInner → generateTextInternal）与本函数
 * 自身顶部的二次归一均为 no-op。
 */
function withDefaultTemperature(model: ResolvedModel, request: TextGenerationRequest): TextGenerationRequest {
  if (request.temperature !== undefined || model.defaultTemperature === undefined) return request;
  return { ...request, temperature: model.defaultTemperature };
}

async function generateTextInternal(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ctx: ProtocolCallContext | undefined,
  opts: GenerateTextInternalOpts,
): Promise<TextGenerationResponse> {
  // 09-12 子3 §4.2：非流式入口（含流式降级重入）顶部归一——per-model 默认补位。
  request = withDefaultTemperature(model, request);
  // D2 guardrail: an unset maxTokens used to mean "uncapped" on the OpenAI
  // path (minute-long hangs on #50) and 16384 on Anthropic. Both now default
  // to a 32K guardrail, with a one-shot compat degradation below for endpoints
  // that reject caps above the model's own limit. CR-T1-008: when the caller
  // (streaming degradation) already learned a cap disposition, honor it —
  // worst case without this is 4 full-billed requests:
  // stream(32K)→stream(reduced)→non-stream(32K)→non-stream(reduced).
  //
  // Thinking adapters design §2.2: the NON-STREAMING default deliberately stays
  // at the bounded 32K guardrail even for models with known limits — this path
  // has no timeout of its own, so the cap is the de-facto duration ceiling
  // (#50). Only an explicit request.maxTokens rides at its value, clamped to
  // the model's official output ceiling (prevents a guaranteed 400). The
  // top-out default lives on the streaming path (resolveStreamingCap).
  const capLearned = opts.degradedCap !== undefined;
  const guardrailApplied = !capLearned && request.maxTokens === undefined;
  let cap: number | undefined;
  if (opts.degradedCap === 'uncapped') {
    cap = undefined;
  } else if (opts.degradedCap !== undefined) {
    // CR-007: the streaming-degraded cap re-passes the thinking floor — the
    // degraded 32K clamp is an internal default, the vendor floor is hard.
    cap = applyThinkingMinTotalTokens(model, request, opts.degradedCap);
  } else {
    cap = applyThinkingMinTotalTokens(
      model,
      request,
      clampToModelCeiling(model, request.maxTokens ?? MAX_TOKENS_GUARDRAIL),
    );
  }
  try {
    return model.protocol === 'anthropic-compatible'
      ? await generateAnthropicText(model, request, cap ?? ANTHROPIC_FALLBACK_MAX_TOKENS, ctx, opts)
      : await generateOpenAiText(model, request, cap, ctx, opts);
  } catch (err) {
    // CR-011: overflow classification outranks the retries below — an
    // oversized-prompt 400 whose text also mentions thinking/reasoning must
    // surface as CONTEXT_OVERFLOW, not burn a strip/compat request first.
    if (isContextOverflowError(err)) throw markContextOverflowError(err);
    if (guardrailApplied && isMaxTokensCapRejection(err)) {
      console.warn(
        '[model-protocols] max_tokens guardrail rejected by endpoint (4xx mentioning max_tokens); retrying once with reduced cap',
        { protocol: model.protocol, status: err instanceof ProtocolHttpError ? err.status : undefined },
      );
      return model.protocol === 'anthropic-compatible'
        ? generateAnthropicText(model, request, anthropicFallbackCap(err), ctx, opts)
        : generateOpenAiText(model, request, undefined, ctx, opts);
    }
    // Thinking adapters design §2.3: backstop for every unverified
    // thinking-parameter combination (research A's 8 open items) — one retry
    // with the thinking parameters stripped, then the real error surfaces.
    if (request.thinking && isThinkingParamRejection(err)) {
      console.warn(
        '[model-protocols] endpoint rejected thinking parameters (4xx mentioning thinking/reasoning); retrying once without them',
        { protocol: model.protocol, status: err instanceof ProtocolHttpError ? err.status : undefined },
      );
      const strippedRequest: TextGenerationRequest = { ...request, thinking: undefined };
      return model.protocol === 'anthropic-compatible'
        ? generateAnthropicText(model, strippedRequest, cap ?? ANTHROPIC_FALLBACK_MAX_TOKENS, ctx, opts)
        : generateOpenAiText(model, strippedRequest, cap, ctx, opts);
    }
    throw markContextOverflowError(err);
  }
}

/**
 * True when a 4xx response body complains about the max-token cap ("max_tokens"
 * OpenAI-style, "max completion tokens" newer-OpenAI-style). Some OpenAI-
 * compatible endpoints hard-400 caps above the model's own ceiling, which the
 * 32K guardrail would otherwise trip on every call.
 */
function isMaxTokensCapRejection(err: unknown): boolean {
  if (!(err instanceof ProtocolHttpError)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  const haystack = `${err.message}\n${err.bodyExcerpt ?? ''}`.toLowerCase();
  return haystack.includes('max_tokens') || haystack.includes('max completion tokens');
}

/**
 * CR-T1-009: the compat retry cap for Anthropic-compatible endpoints. Their
 * rejections usually name the real ceiling ("max_tokens must be less than or
 * equal to 8192") — parse and use it instead of the fixed 16384 guess, which
 * fails again on endpoints whose ceiling is lower. Falls back to the
 * pre-guardrail default when the message is unparseable.
 */
function anthropicFallbackCap(err: unknown): number {
  return extractMaxTokensLimit(err) ?? ANTHROPIC_FALLBACK_MAX_TOKENS;
}

/** Extract the endpoint's real max-token ceiling from a rejection message, e.g. `max_tokens must be less than or equal to 8192` → 8192. */
function extractMaxTokensLimit(err: unknown): number | undefined {
  if (!(err instanceof ProtocolHttpError)) return undefined;
  const haystack = `${err.message}\n${err.bodyExcerpt ?? ''}`;
  const match = /max(?:imum)?[_ ]?(?:completion[_ ])?tokens[^\d]*(\d+)/i.exec(haystack);
  const parsed = match ? Number.parseInt(match[1]!, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Streaming cap resolution (thinking adapters design §2.2): streaming is the
 * primary path post-T1, so an unset maxTokens TOPS OUT at the model's official
 * output ceiling (unknown models keep the 32K guardrail); an explicit
 * request.maxTokens is always clamped to that ceiling so a stale caller value
 * cannot 400. Kimi K3 is the one carve-out — see KIMI_K3_STREAM_CAP_CLAMP.
 * The thinking floor (CR-007) folds in last.
 */
function resolveStreamingCap(model: ResolvedModel, request: TextGenerationRequest): number {
  const ceiling = model.limits?.maxOutputTokens;
  const cap =
    request.maxTokens !== undefined
      ? ceiling !== undefined
        ? Math.min(request.maxTokens, ceiling)
        : request.maxTokens
      : ceiling ?? MAX_TOKENS_GUARDRAIL;
  const clamped =
    request.maxTokens === undefined && model.thinkingKind === 'kimi-k3'
      ? Math.min(cap, KIMI_K3_STREAM_CAP_CLAMP)
      : cap;
  return applyThinkingMinTotalTokens(model, request, clamped);
}

/** Clamp a cap to the model's official output ceiling (unknown models pass through). */
function clampToModelCeiling(model: ResolvedModel, cap: number): number {
  const ceiling = model.limits?.maxOutputTokens;
  return ceiling !== undefined ? Math.min(cap, ceiling) : cap;
}

/**
 * CR-007: fold the profile's `minTotalTokens` floor into a resolved numeric cap
 * while thinking is ON. The floor is a HARD vendor constraint of the chosen
 * tier — reasoning + answer share the max_tokens budget (Kimi: sum ≤
 * max_tokens; Claude xhigh/max guidance ≥64K), so a cap below the floor
 * truncates INSIDE the thinking phase (zero prose, tokens still billed) or
 * 400s outright. This applies to EXPLICIT request.maxTokens too: an explicit
 * value below the floor is a self-contradictory umbrella — the user picked a
 * thinking tier, which includes its hard floor (e.g. lintIpc's hard-coded
 * maxTokens 8192 under a claude-5 effort tier) — so the cap is raised to the
 * floor with a warning instead of silently sending a doomed request. The same
 * rule covers streaming AND non-streaming: the floor outranks the
 * non-streaming 32K convention (that is an internal default; the vendor floor
 * is a hard 400). NOT applied to 'uncapped' (no numeric cap to raise) or to
 * the cap-rejection compat retries (the endpoint-demonstrated real ceiling
 * wins there — the 400 surfaces loudly if it cannot serve the floor).
 */
function applyThinkingMinTotalTokens(
  model: ResolvedModel,
  request: TextGenerationRequest,
  cap: number,
): number {
  const kind = model.thinkingKind;
  const floor = kind !== undefined ? THINKING_PROFILES[kind].minTotalTokens : undefined;
  const level = request.thinking?.level;
  if (floor === undefined || cap >= floor) return cap;
  if (!level || level === 'auto' || level === 'off') return cap;
  console.warn(
    `[model-protocols] request maxTokens ${cap} is below the ${kind} thinking floor ${floor} (reasoning + answer share the budget); raising the cap to ${floor} (CR-007)`,
  );
  return floor;
}

/**
 * CR-011: structured shape match for thinking-parameter rejections. The old
 * predicate fired on ANY text mentioning thinking/reasoning — quota / rate /
 * timeout / billing failures that merely reference reasoning tokens armed the
 * strip retry and burned a request. A genuine thinking-param rejection names
 * the target parameter (thinking / reasoning_effort), calls it rejected
 * (unknown / unsupported / unrecognized / invalid), and refers to it as a
 * parameter/field/argument ("argument" covers OpenAI's classic "Unrecognized
 * request argument supplied" phrasing). Texts naming quota/limit/timeout/
 * billing are excluded outright — those are never about the parameter being
 * unsupported.
 */
const THINKING_REJECTION_EXCLUDE = /quota|limit|timeout|billing/;
const THINKING_REJECTION_REJECT = /unknown|unsupported|unrecognized|invalid/;
const THINKING_REJECTION_PARAM = /parameter|field|argument/;
const THINKING_REJECTION_TARGET = /thinking|reasoning_effort/;

/**
 * True when a 4xx response body complains about the thinking parameters.
 * Gate for the one-shot strip retry, same shape as isMaxTokensCapRejection.
 * Ordering note (CR-011): every caller must test `isContextOverflowError`
 * FIRST — an overflow 400 whose text also mentions thinking/reasoning must
 * surface as CONTEXT_OVERFLOW, not burn a strip retry first.
 */
function isThinkingParamRejection(err: unknown): boolean {
  if (!(err instanceof ProtocolHttpError)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  const haystack = `${err.message}\n${err.bodyExcerpt ?? ''}`.toLowerCase();
  if (THINKING_REJECTION_EXCLUDE.test(haystack)) return false;
  return (
    THINKING_REJECTION_REJECT.test(haystack) &&
    THINKING_REJECTION_PARAM.test(haystack) &&
    THINKING_REJECTION_TARGET.test(haystack)
  );
}

/**
 * Attach the stable CONTEXT_OVERFLOW marker to a matching error (design §4.1):
 * the agent layer consumes it to trigger one compaction retry instead of
 * surfacing a raw 400. Idempotent — already-marked and non-matching errors
 * pass through unchanged.
 */
function markContextOverflowError(err: unknown): unknown {
  if (!(err instanceof ProtocolHttpError) || err instanceof ProtocolContextOverflowError) return err;
  if (!isContextOverflowError(err)) return err;
  return new ProtocolContextOverflowError(err.message, err.status, err.bodyExcerpt);
}

/** Shared OpenAI-path request assembly (tools hoist + system extraction + message mapping). */
function buildOpenAiArgs(request: TextGenerationRequest): {
  system: string | undefined;
  messages: ModelMessage[];
  tools: Record<string, ReturnType<typeof tool>> | undefined;
} {
  // Convert OpenAI-style tool definitions to Vercel AI SDK v6 tool format
  const tools: Record<string, ReturnType<typeof tool>> | undefined =
    request.tools?.length
      ? Object.fromEntries(
          request.tools.map((t) => [
            t.function.name,
            tool({
              description: t.function.description,
              inputSchema: jsonSchema(t.function.parameters as any),
            }),
          ]),
        )
      : undefined;

  // Extract system messages and convert the rest to Vercel AI SDK format
  const systemParts: string[] = [];
  const nonSystemMessages = request.messages.filter((m: any) => {
    if (m.role === 'system') { systemParts.push(m.content); return false; }
    return true;
  });

  // Build a toolCallId → toolName lookup from assistant messages
  const toolNameMap = new Map<string, string>();
  for (const m of nonSystemMessages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) toolNameMap.set(tc.id, tc.name);
    }
  }

  const messages: ModelMessage[] = nonSystemMessages.map((m: any) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((tc: any) => {
            let input: unknown = {};
            if (tc.arguments) {
              if (typeof tc.arguments === 'object') {
                input = tc.arguments;
              } else {
                try {
                  input = JSON.parse(tc.arguments);
                } catch {
                  const lastBrace = tc.arguments.lastIndexOf('{');
                  if (lastBrace > 0) {
                    try { input = JSON.parse(tc.arguments.slice(lastBrace)); } catch { /* keep {} */ }
                  }
                }
              }
            }
            return {
              type: 'tool-call' as const,
              toolCallId: tc.id,
              toolName: tc.name,
              input,
            };
          }),
        ],
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: [{
          type: 'tool-result' as const,
          toolCallId: m.toolCallId,
          toolName: m.toolName || toolNameMap.get(m.toolCallId) || '',
          output: { type: 'text' as const, value: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) },
        }],
      };
    }
    // Story 3.6 vision seam: user messages may carry normalized multimodal
    // parts. Map to AI SDK user-content parts — a file part with an image/*
    // mediaType is serialized by @ai-sdk/openai as
    // `{type:'image_url', image_url:{url:'data:<mime>;base64,<b64>'}}` (text
    // parts stay `{type:'text', text}`; a parts array with a single text part
    // collapses back to a plain string on the wire). Pure string user content
    // falls through to the branch below untouched (zero regression).
    if (m.role === 'user' && Array.isArray(m.content)) {
      return {
        role: 'user' as const,
        content: m.content.map((part: GenerationPart) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : { type: 'file' as const, data: part.image.b64Json, mediaType: part.image.mimeType },
        ),
      };
    }
    return { role: m.role, content: m.content };
  });

  return {
    system: systemParts.length ? systemParts.join('\n') : undefined,
    messages,
    tools,
  };
}

/** Non-streaming OpenAI-compatible generation. `maxOutputTokens` arrives guardrail-resolved. */
async function generateOpenAiText(
  model: ResolvedModel,
  request: TextGenerationRequest,
  maxOutputTokens: number | undefined,
  ctx: ProtocolCallContext | undefined,
  opts: { skipQuickRetry?: boolean },
): Promise<TextGenerationResponse> {
  // CR-T1-006: mirror the streaming path's reasoning extraction — without the
  // middleware a degraded call inlines `<think>…</think>` into the text
  // (polluting prose + llmlint), while the streaming path returned it split.
  const wrapped = wrapLanguageModel({
    model: createProvider(model, { bodyPatch: buildOpenAiRequestPatch(model, request) }),
    middleware: extractReasoningMiddleware({ tagName: REASONING_TAG }),
  });
  const { system, messages, tools } = buildOpenAiArgs(request);

  const attempt = async () => {
    try {
      return await aiGenerateText({
        model: wrapped,
        system,
        messages,
        temperature: request.temperature,
        // 09-12 子3 §4.2：per-model 采样缺省补位（非覆盖）——undefined 不占位 = 不发字段
        //（ai CallSettings 原生通道，镜像请求级 temperature 的形态）。
        topP: model.defaultTopP,
        frequencyPenalty: model.defaultFrequencyPenalty,
        presencePenalty: model.defaultPresencePenalty,
        maxOutputTokens,
        tools,
        abortSignal: ctx?.signal,
        maxRetries: 0, // D2 (#50): SDK-internal retries hung minutes per attempt
      });
    } catch (err) {
      throw normalizeApiCallError(err);
    }
  };
  // CR-T1-007: restore fail-fast retry parity for non-streaming consumers
  // (summarizer / chain JSON nodes / renderer direct calls), which silently
  // dropped from 3 SDK attempts to 1 when maxRetries went 0. Suppressed on the
  // streaming-degradation call — that layer already quick-retried its
  // connection window, and stacking loops would double the request count.
  const result = opts.skipQuickRetry ? await attempt() : await withRetry(attempt, { signal: ctx?.signal });

  const response = buildOpenAiResponse(model, result.text ?? '', mapFinishReason(result.finishReason), result.usage, result.toolCalls);
  return result.reasoningText ? { ...response, reasoning: result.reasoningText } : response;
}

/** Terminal-frame assembly shared by the streaming + non-streaming OpenAI paths. */
function buildOpenAiResponse(
  model: ResolvedModel,
  text: string,
  finishReason: GenerationFinishReason | undefined,
  usage: LanguageModelUsage | undefined,
  rawToolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> | undefined,
): TextGenerationResponse {
  const toolCalls = rawToolCalls?.length
    ? rawToolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
      }))
    : undefined;

  return {
    model: model.modelId,
    text,
    finishReason,
    usage: usage
      ? {
          promptTokens: usage.inputTokens ?? undefined,
          completionTokens: usage.outputTokens ?? undefined,
          totalTokens: usage.totalTokens ?? undefined,
        }
      : undefined,
    toolCalls,
  };
}

// ── Streaming text generation (dogfood T1 #50 / #27②) ──

/**
 * Streaming variant of `generateText` (design §1.1): same dual-protocol
 * dispatch, same terminal `TextGenerationResponse` frame, plus incremental
 * `onDelta` callbacks. `reasoning` (when the provider surfaces one) is both
 * streamed as `reasoning` deltas and aggregated onto the terminal frame.
 *
 * Resilience semantics (design §1.2) — see also `generateText`'s guardrail:
 *   - pre-delta retryable failures (429/5xx/timeout) get ONE self-managed
 *     streaming quick retry (sub-second backoff) inside each protocol path;
 *   - failures before the first delivered delta may then degrade once to
 *     non-streaming `generateText` (e.g. gateways that 400 `stream:true`),
 *     EXCEPT aborts and first-event timeouts (an unbounded non-streaming call
 *     would reintroduce the #50 hang); the degraded call inherits the cap
 *     disposition learned here (CR-T1-008) and skips its own retry loop;
 *   - failures after content has been produced throw `StreamInterruptedError`
 *     carrying the accumulated text/reasoning — never retried.
 */
export async function generateTextStream(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ctx: ProtocolCallContext | undefined,
  onDelta: (d: GenerationDelta) => void,
): Promise<TextGenerationResponse> {
  // 09-12 usage-panel（design §1）：计量 wrapper 最外层——CLI 早退在 wrapper 之内（CLI
  // 调用同落行）；首 delta 经 meteredOnDelta 打点（first_delta_ms），与内部
  // state.producedDelta 判定互不干扰（同一 onDelta 链，纯增量观察）。
  const ledgerCtx = withLedgerCallContext(ctx, request);
  return withUsageMetering({ model, request, ctx: ledgerCtx, stream: true }, ({ markFirstDelta }) => {
    const meteredOnDelta = (d: GenerationDelta) => {
      markFirstDelta();
      onDelta(d);
    };
    return generateTextStreamInner(model, request, ledgerCtx, meteredOnDelta);
  });
}

async function generateTextStreamInner(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ctx: ProtocolCallContext,
  onDelta: (d: GenerationDelta) => void,
): Promise<TextGenerationResponse> {
  // 09-12 agy provider（复核 H2）：CLI 形态顶部早退——不经本函数的流式韧性层（快速
  // 重试 / 首事件窗 / 非流式回退对 CLI 形态全部不适用——那是 SSE 语义；agy stream-json
  // 的事件活性由 driver 的外层兜底罩）。流式/非流式两态在 driver 内单实现消费。
  if (model.protocol === 'antigravity-cli') {
    // C3.1：attempt 收集器同罩流式车道（空 SUCCESS 重试 / 降级重跑两族在流式车道
    // 同样发生——driver 两态单实现消费）。ctx 已由入口归一（callId 保证在场）；
    // 入口形态 = 流式（CR-1：attempt 行如实落 stream=true）。
    return runCliWithAttemptLedger(model, request, ctx, true, (collectorCtx) =>
      antigravityCliGenerateText(model, request, collectorCtx, onDelta),
    );
  }
  // 09-12 子3 §4.2：流式入口顶部归一（CLI 早退之后——CLI 键无 defaultTemperature，
  // refine 拒收，归一对 CLI 是恒等）。降级重入 generateTextInternal 时二次归一 no-op。
  request = withDefaultTemperature(model, request);
  const state = { producedDelta: false };
  const trackedOnDelta = (d: GenerationDelta) => {
    state.producedDelta = true;
    onDelta(d);
  };
  // CR-T1-008: cap knowledge the streaming attempts learn (cap stripped on
  // OpenAI / reduced to the endpoint ceiling on Anthropic) rides along to the
  // degraded call so the guardrail is not re-derived — and re-rejected — there.
  const capLearning: { degradedCap?: number | 'uncapped' } = {};

  try {
    return model.protocol === 'anthropic-compatible'
      ? await anthropicStreamWithResilience(model, request, ctx, trackedOnDelta, capLearning)
      : await openAiStreamWithResilience(model, request, ctx, trackedOnDelta, capLearning);
  } catch (err) {
    // Degradation gates: only pre-delta, non-abort, non-timeout failures may
    // fall back to a single non-streaming attempt (errors passthrough).
    if (isDeltaCallbackError(err)) throw err; // CR-T1-005: program errors never degrade either
    if (state.producedDelta) throw err;
    // An oversized prompt fails identically on the non-streaming path — skip
    // the wasted degraded call and surface the marked error immediately
    // (thinking adapters design §4.1).
    if (isContextOverflowError(err)) throw markContextOverflowError(err);
    if (ctx?.signal?.aborted) throw err;
    // dogfood R2 #7: timeout disposition by lane. Interactive keeps the T1 D2
    // red line verbatim — a timeout throws, never degrades (the non-streaming
    // path has no time bound, so the #50 unbounded hang would come right
    // back). A background lane (child agents / chapter chains on top-spec
    // thinking) gets EXACTLY ONE bounded fallback instead: after 240s of zero
    // events the endpoint is proven slow-not-dead, so one non-streaming call
    // under a 600s total ceiling converts "hard kill" into "usable but slow"
    // without any unbounded wait. The fallback rethrows the ORIGINAL timeout
    // on failure — the first-event evidence outranks the fallback's own error
    // (preserve order). Cap learning rides along as on the normal degrade
    // path (CR-T1-008 semantics), and skipQuickRetry mirrors it: the
    // streaming layer already quick-retried its connection window.
    const timeout = err instanceof ProtocolTimeoutError ? err : findTimeoutError(err);
    if (timeout) {
      if (ctx?.lane !== 'background') throw timeout;
      console.warn(
        '[model-protocols] first-event timeout on background lane → bounded non-streaming fallback (600s cap)',
      );
      const learnedTimeout = capLearning.degradedCap;
      const fallbackCap: number | 'uncapped' =
        learnedTimeout === 'uncapped'
          ? 'uncapped'
          : Math.min(learnedTimeout ?? resolveStreamingCap(model, request), MAX_TOKENS_GUARDRAIL);
      try {
        return await generateTextInternal(model, request, {
          ...ctx,
          signal: signalWithTimeout(ctx?.signal, BACKGROUND_FALLBACK_TOTAL_TIMEOUT_MS),
        }, { degradedCap: fallbackCap, skipQuickRetry: true });
      } catch (err) {
        // CR-33 (dogfood R2): abort and overflow classification outrank the
        // preserve-order rethrow below — the same protection order as the
        // streaming attempt catches. A user cancel during the fallback is an
        // abort (flattening it into the timeout mislabels it for every
        // caller), and an oversized-prompt 400 must keep its CONTEXT_OVERFLOW
        // marker so the hardCut compaction retry chain
        // (spec/agent/context-management.md) still fires — the fallback
        // re-proves neither condition.
        if (ctx?.signal?.aborted) throw err;
        if (isContextOverflowError(err)) throw markContextOverflowError(err);
        throw timeout; // any other fallback failure surfaces the original timeout, never its own error
      }
    }
    if (isAbortLikeError(err)) throw err; // internal abort with outer signal alive = timeout-shaped
    console.warn(
      '[model-protocols] streaming attempt failed before first delta; falling back to non-streaming generateText',
      errorMessage(err),
    );
    // Thinking adapters design §2.2: the degraded non-streaming call is
    // UNCONDITIONALLY clamped to min(cap, 32K) — independent of
    // guardrailApplied, so an explicit request.maxTokens (or a known-limits
    // top-out) can no longer ride through at full size on the no-timeout
    // non-streaming path (the #50 unbounded-duration shape). The 'uncapped'
    // learning passes through verbatim: that endpoint demonstrably rejects any
    // numeric cap, and re-sending one would just re-trip the rejection.
    // Truncation recovery is the runLoop's existing length-continuation loop.
    const learned = capLearning.degradedCap;
    const degradedCap: number | 'uncapped' =
      learned === 'uncapped'
        ? 'uncapped'
        : Math.min(learned ?? resolveStreamingCap(model, request), MAX_TOKENS_GUARDRAIL);
    // CR-T1-007: skipQuickRetry — the streaming layer already quick-retried
    // its connection window; the degraded call must not stack a second loop.
    return generateTextInternal(model, request, ctx, {
      degradedCap,
      skipQuickRetry: true,
    });
  }
}

// ── OpenAI-compatible streaming path ──

// Reasoning extraction (#27②): many OpenAI-compatible endpoints (self-hosted
// Qwen/GLM via DashScope-style gateways) inline chain-of-thought in
// `<think>…</think>` sections of the content stream. The AI SDK middleware
// converts those into proper reasoning parts.
// dogfood R2 #7 (2026-08-25): for the REASONING_CONTENT_KINDS vendors the
// fetch-level surfacing wrapper (withReasoningContentSurfacing) rewrites the
// vendor's separate `reasoning_content` SSE field into `<think>`-wrapped
// content deltas FIRST — those then flow through this same middleware. See the
// root-cause block comment at withReasoningContentSurfacing for why the field
// must never be allowed to die at the SDK's zod boundary (240s watchdog
// false-kills of healthy reasoning streams).
const REASONING_TAG = 'think';

async function openAiStreamWithResilience(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ctx: ProtocolCallContext | undefined,
  onDelta: (d: GenerationDelta) => void,
  capLearning: { degradedCap?: number | 'uncapped' },
): Promise<TextGenerationResponse> {
  const guardrailApplied = request.maxTokens === undefined;
  // Thinking adapters design §2.2: streaming tops out at the model's official
  // output ceiling (unknown models keep the 32K guardrail).
  let cap: number | undefined = resolveStreamingCap(model, request);
  let stripped = false;
  let thinkingStripped = false;
  let effectiveRequest = request;
  for (let attempt = 1; ; attempt++) {
    try {
      return await openAiStreamAttempt(model, effectiveRequest, cap, ctx, onDelta);
    } catch (err) {
      if (err instanceof StreamInterruptedError) throw err; // mid-stream: never retried
      if (isDeltaCallbackError(err)) throw err; // CR-T1-005: program error, not a stream failure
      if (ctx?.signal?.aborted || isAbortLikeError(err)) throw err;
      // CR-T1-007: self-managed connection-window quick retry (≤2 attempts,
      // sub-second backoff), mirroring the Anthropic path — the OpenAI path
      // previously had zero retries and degraded straight to non-streaming on
      // any pre-delta 429/5xx. NOT withRetry-wrapped: whole-stream retries
      // would replay deltas.
      const canRetrySameCap =
        attempt < 2 && (err instanceof ProtocolTimeoutError || isRetryableProtocolError(err));
      if (!canRetrySameCap) {
        // CR-011: overflow classification first (see generateTextInternal).
        if (isContextOverflowError(err)) throw markContextOverflowError(err);
        if (!stripped && guardrailApplied && isMaxTokensCapRejection(err)) {
          console.warn('[model-protocols] max_tokens guardrail rejected by endpoint; retrying stream once without cap');
          stripped = true;
          cap = undefined;
          capLearning.degradedCap = 'uncapped'; // CR-T1-008: carry the learning to any degraded call
          continue;
        }
        // Thinking adapters design §2.3: unverified thinking-parameter
        // combinations backstop — one retry with the thinking params stripped.
        if (!thinkingStripped && effectiveRequest.thinking && isThinkingParamRejection(err)) {
          console.warn('[model-protocols] endpoint rejected thinking parameters (4xx mentioning thinking/reasoning); retrying stream once without them');
          thinkingStripped = true;
          effectiveRequest = { ...effectiveRequest, thinking: undefined };
          continue;
        }
        throw markContextOverflowError(err); // pre-delta failure → generateTextStream decides the non-streaming fallback
      }
      await sleepMs(STREAM_RETRY_BASE_DELAY_MS);
    }
  }
}

// ── Instrumentation log hygiene (dogfood R2 CR-36) ──
//
// The R2 #7 diagnostics originally logged the FULL request body on every
// failed attempt (comment claimed "bounded" — it was not): creative content
// leaked wholesale into server logs, repeated per retry. These helpers give
// the failure-path dump hard caps, and the per-request info logs a debug
// gate — plus endpoint domains stay out of logs entirely (#10 direction).

/** Per-field character cap for any request content entering a log line. */
const LOG_CHAR_CAP = 2_000;
/** How many leading messages a failure-path dump may carry (rest → omitted marker). */
const LOG_MESSAGE_COUNT_CAP = 2;

/** True when per-request instrumentation (the stream request/done info logs) is enabled. */
function protocolDebugEnabled(): boolean {
  return !!process.env.ORISON_PROTOCOL_DEBUG;
}

/** Cap a string for logging, marking the cut so the truncation is visible. */
function truncateForLog(value: string): string {
  return value.length > LOG_CHAR_CAP
    ? `${value.slice(0, LOG_CHAR_CAP)}…(+${value.length - LOG_CHAR_CAP} chars)`
    : value;
}

/** Bounded message dump: first LOG_MESSAGE_COUNT_CAP entries + an omitted count — never the whole conversation. */
function summarizeMessagesForLog(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const summary: Array<Record<string, unknown>> = messages
    .slice(0, LOG_MESSAGE_COUNT_CAP)
    .map((m) => {
      const content = (m as { content?: unknown }).content;
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      return { role: (m as { role?: unknown }).role, content: truncateForLog(text) };
    });
  if (messages.length > LOG_MESSAGE_COUNT_CAP) {
    summary.push({ omitted: messages.length - LOG_MESSAGE_COUNT_CAP });
  }
  return summary;
}

async function openAiStreamAttempt(
  model: ResolvedModel,
  request: TextGenerationRequest,
  maxOutputTokens: number | undefined,
  ctx: ProtocolCallContext | undefined,
  onDelta: (d: GenerationDelta) => void,
): Promise<TextGenerationResponse> {
  // dogfood R2 #7: lane-selected liveness window — background (child agents /
  // chapter chains) gets 240s, everything else keeps the 60s design default.
  // 09-12 子3: a per-key timeoutSeconds replaces the lane value (streamWindowMs).
  const windowMs = streamWindowMs(model, ctx);
  const wrapped = wrapLanguageModel({
    model: createProvider(model, {
      connectTimeoutMs: windowMs,
      bodyPatch: buildOpenAiRequestPatch(model, request),
    }),
    middleware: extractReasoningMiddleware({ tagName: REASONING_TAG }),
  });
  const { system, messages, tools } = buildOpenAiArgs(request);

  // dogfood R2 #7 观测（2026-08-25，CR-36 治理）：派发车道首事件超时排查仪器——
  // 请求形状 INFO + 首个内容部件耗时 + 超时/失败时有界请求体 WARN。
  // INFO 两处（request/done）均门控 ORISON_PROTOCOL_DEBUG；WARN 的请求体
  // 截断（每字段 2000 字符、前 2 条消息）；baseUrl 不入日志（endpoint 域名脱敏）。
  const requestStartedAt = Date.now();
  let firstContentAt: number | undefined;
  const messageChars = messages.reduce((n, m) => {
    const c = (m as { content?: unknown }).content;
    return n + (typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length);
  }, 0);
  if (protocolDebugEnabled()) {
    console.info(
      '[model-protocols] stream request →',
      JSON.stringify({
        model: model.modelId,
        // CR-36: baseUrl dropped — endpoint domains are redacted from logs (#10 direction)
        lane: ctx?.lane ?? 'dialogue', // dogfood R2 #7: lane tagging observability
        maxOutputTokens,
        temperature: request.temperature,
        thinking: request.thinking?.level ?? 'auto',
        tools: tools ? Object.keys(tools) : undefined, // names only — structural summary
        systemChars: typeof system === 'string' ? system.length : 0,
        messages: messages.length,
        messageChars,
      }),
    );
  }

  let text = '';
  let reasoning = '';
  let sawContent = false; // any content-bearing part delivered (stream proven productive)
  const rawToolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
  let finishReason: string | undefined;
  let usage: LanguageModelUsage | undefined;
  let sawFinish = false;

  // CR-T1-001: withConnectTimeout clears its timer the moment the fetch
  // resolves — i.e. when HEADERS arrive — and the SDK's fetch lives inside
  // streamText, so a gateway that answers 200+headers and then never sends a
  // first byte would hang unboundedly (#50's exact shape). The watchdog hangs
  // off this consumption loop instead: the composite signal aborts after `ms`
  // with no content-bearing part, and clears the moment one arrives (mid-
  // stream silence timeout remains an explicit non-goal, design §10).
  // dogfood R2 #7: `ms` is the lane-selected window (see firstEventWindowMs).
  const guard = createFirstEventGuard(ctx?.signal, windowMs);

  try {
    const stream = streamText({
      model: wrapped,
      system,
      messages,
      temperature: request.temperature,
      // 09-12 子3 §4.2：per-model 采样缺省补位（非覆盖）——undefined 不占位 = 不发字段。
      topP: model.defaultTopP,
      frequencyPenalty: model.defaultFrequencyPenalty,
      presencePenalty: model.defaultPresencePenalty,
      maxOutputTokens,
      tools,
      abortSignal: guard.signal,
      maxRetries: 0, // D2 (#50): no SDK-internal retries on the streaming path
    });
    for await (const part of stream.fullStream) {
      if (part.type === 'text-delta') {
        sawContent = true;
        if (firstContentAt === undefined) firstContentAt = Date.now();
        guard.clearTimer(); // CR-T1-001: first content proves the stream productive
        text += part.text;
        invokeOnDelta(onDelta, { type: 'text', delta: part.text });
      } else if (part.type === 'reasoning-delta') {
        sawContent = true;
        if (firstContentAt === undefined) firstContentAt = Date.now();
        guard.clearTimer();
        reasoning += part.text;
        invokeOnDelta(onDelta, { type: 'reasoning', delta: part.text });
      } else if (part.type === 'tool-input-start') {
        sawContent = true;
        if (firstContentAt === undefined) firstContentAt = Date.now();
        guard.clearTimer(); // streamed tool arguments are liveness too (long arg builds must not trip the watchdog)
        // R2 #30：调用首块外发工具名（UI「正在准备工具调用：X」指示的数据源）。
        invokeOnDelta(onDelta, { type: 'tool', delta: '', toolName: part.toolName });
      } else if (part.type === 'tool-input-delta') {
        sawContent = true;
        guard.clearTimer(); // streamed tool arguments are liveness too (long arg builds must not trip the watchdog)
        // ai-sdk 双变体：fullStream 的 TextStreamPart 是 { id, delta }，UIMessage chunk 是
        // { toolCallId, inputTextDelta }——两个字段名都接。
        const argDelta = (part as { inputTextDelta?: string; delta?: string }).inputTextDelta
          ?? (part as { delta?: string }).delta ?? '';
        invokeOnDelta(onDelta, { type: 'tool', delta: argDelta });
      } else if (part.type === 'tool-call') {
        sawContent = true;
        guard.clearTimer();
        // Tool calls aggregate at the stream tail — half-streamed JSON
        // arguments are never surfaced as deltas.
        rawToolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
      } else if (part.type === 'finish') {
        sawFinish = true;
        finishReason = part.finishReason;
        usage = part.totalUsage;
      } else if (part.type === 'abort') {
        if (guard.timedOut) throw guard.error; // CR-T1-001: watchdog → connection-window timeout (retryable)
        throw abortErrorFromContext(ctx);
      } else if (part.type === 'error') {
        throw part.error;
      }
    }
  } catch (err) {
    if (isDeltaCallbackError(err)) throw err; // CR-T1-005: rethrow as-is — never wrapped below
    // dogfood R2 #7 观测 + CR-36 治理：失败路径请求 dump 有界——每文本字段截
    // 2000 字符、至多前 2 条消息（余量记 omitted）、tools 只留名字；endpoint
    // 域名与全量创作内容不再随每次重试进日志。
    console.warn(
      '[model-protocols] stream attempt failed',
      JSON.stringify({
        firstContentMs: firstContentAt !== undefined ? firstContentAt - requestStartedAt : null,
        totalMs: Date.now() - requestStartedAt,
        sawContent,
        error: errorMessage(err),
        request: {
          system: typeof system === 'string' ? truncateForLog(system) : undefined,
          messages: summarizeMessagesForLog(messages),
          tools: tools ? Object.keys(tools) : undefined, // names only — schemas never enter logs
          maxOutputTokens,
          temperature: request.temperature,
          thinking: request.thinking,
        },
      }),
    );
    // CR-T1-010: a user abort racing the watchdog classifies as an abort,
    // never as a timeout.
    if (ctx?.signal?.aborted) throw normalizeApiCallError(err);
    if (guard.timedOut) throw guard.error;
    const normalized = normalizeApiCallError(err);
    const directTimeout = findTimeoutError(normalized);
    if (directTimeout) throw directTimeout;
    // `sawContent`, not just non-empty accumulations: the SDK pipeline may
    // drop parts still in flight when a stream dies abruptly, so the tail of
    // what the user saw can be missing — the stream still WAS productive and
    // must not be retried or silently regenerated non-streaming. This check
    // precedes the abort-like classification: an abort-shaped transport death
    // AFTER content must carry the accumulations, not masquerade as a
    // connection-window timeout (CR-T1-038 residual belt).
    if (sawContent || text || reasoning) {
      throw new StreamInterruptedError({
        message: `OpenAI-compatible stream interrupted: ${errorMessage(normalized)}`,
        accumulatedText: text,
        accumulatedReasoning: reasoning || undefined,
        status: normalized instanceof ProtocolHttpError ? normalized.status : undefined,
        bodyExcerpt: normalized instanceof ProtocolHttpError ? normalized.bodyExcerpt : undefined,
      });
    }
    if (isAbortLikeError(normalized)) {
      // The only internal aborters are the connect-timeout wrapper and the
      // first-delta watchdog — both mean "no content within the window".
      throw new ProtocolTimeoutError(`No generation content within ${windowMs}ms (first-delta timeout)`);
    }
    throw normalized;
  } finally {
    guard.dispose();
  }

  if (!sawFinish) {
    // Reader closed without a finish part — abnormal termination even if no
    // explicit error surfaced.
    throw new StreamInterruptedError({
      message: 'OpenAI-compatible stream ended without a finish part',
      accumulatedText: text,
      accumulatedReasoning: reasoning || undefined,
    });
  }

  const response = buildOpenAiResponse(model, text, mapFinishReason(finishReason), usage, rawToolCalls.length ? rawToolCalls : undefined);
  if (protocolDebugEnabled()) {
    // CR-36: the done summary joins the request info behind the debug gate —
    // timings/counts only, never content, never the endpoint.
    console.info(
      '[model-protocols] stream done',
      JSON.stringify({
        model: model.modelId,
        firstContentMs: firstContentAt !== undefined ? firstContentAt - requestStartedAt : null,
        totalMs: Date.now() - requestStartedAt,
        textChars: text.length,
        reasoningChars: reasoning.length,
        toolCalls: rawToolCalls.length,
      }),
    );
  }
  return reasoning ? { ...response, reasoning } : response;
}

// ── Anthropic-compatible streaming path (hand-written SSE, r6) ──

// C batch (09-12 system stabilization / C3.4): official prompt-caching marker.
// cache_control is legal on ANY content block, so it rides as an additive
// optional field on every union member (per-member intersection keeps the
// `type` discriminant intact for narrowing).
type CacheControlMarker = { cache_control?: { type: 'ephemeral' } };

type AnthropicContentBlock =
  | ({ type: 'text'; text: string } & CacheControlMarker)
  // Thinking adapters task (B block): thinking blocks carry a `signature`
  // that must round-trip verbatim in tool loops (captured onto the response
  // as `reasoningSignature`). Absent on older/non-thinking endpoints.
  | ({ type: 'thinking'; thinking: string; signature?: string } & CacheControlMarker)
  | ({ type: 'tool_use'; id: string; name: string; input: unknown } & CacheControlMarker)
  | ({ type: 'tool_result'; tool_use_id: string; content: string } & CacheControlMarker)
  // Story 3.6 vision seam: image block for multimodal user messages. Anthropic
  // strictly 400s when `media_type` does not match the actual image bytes — the
  // caller (shell visionAnalysis) is responsible for strict byte-level matching.
  | ({ type: 'image'; source: { type: 'base64'; media_type: string; data: string } } & CacheControlMarker);

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

// C 批 CR P10：Anthropic usage 的 cache 计数桶（非流式响应 / 流式 message_start /
// 流式 message_delta 三处同形）。官方语义：input_tokens **不含** cache 桶——真实输入
// 量 = input + cache_read + cache_creation 三桶求和，直接取 input_tokens 会低估
// （agent 校准环 / 压缩阈值随之漂移）。
type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type AnthropicResponse = {
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
};

/** Shared request-body assembly for the Anthropic non-streaming + streaming paths. */
function buildAnthropicBody(
  model: ResolvedModel,
  request: TextGenerationRequest,
  maxTokens: number,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      // Story 3.6 vision seam: parts content maps onto Anthropic content blocks
      // — text parts stay `{type:'text', text}` and image parts become
      // `{type:'image', source:{type:'base64', media_type, data}}`. A pure
      // string stays a plain string (byte-identical to the pre-parts wire body).
      if (typeof message.content !== 'string') {
        messages.push({
          role: 'user',
          content: message.content.map((part) =>
            part.type === 'text'
              ? { type: 'text' as const, text: part.text }
              : {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: part.image.mimeType,
                    data: part.image.b64Json,
                  },
                },
          ),
        });
        continue;
      }
      messages.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      // Thinking adapters task (B block, design §5.2): round-trip historical
      // thinking as a first-position thinking block. Requires BOTH the text and
      // the original signature — Anthropic validates the signature, so a
      // missing one (legacy sessions / interrupted messages) skips the block
      // entirely rather than forging a signature the endpoint would 400 on.
      if (message.reasoning_content && message.reasoningSignature) {
        content.push({
          type: 'thinking',
          thinking: message.reasoning_content,
          signature: message.reasoningSignature,
        });
      }
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const tc of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: parseToolArguments(tc.arguments),
        });
      }
      messages.push({ role: 'assistant', content: content.length === 1 && content[0]?.type === 'text' ? content[0].text : content });
      continue;
    }
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      }],
    });
  }

  // Anthropic requires max_tokens; the value arrives guardrail-resolved from
  // the callers (design §1.2).
  const body: Record<string, unknown> = {
    model: model.modelId,
    max_tokens: maxTokens,
    messages,
  };
  // C batch (09-12 system stabilization / C3.4): explicit cache_control wiring —
  // TWO breakpoints when request.cacheControl === true (≤ the official cap of 4):
  //   ① system tail block — system becomes an array block with the ephemeral
  //      marker; join('\n') preserves byte order.
  //   ② conversation tail — the LAST message's LAST content block (the official
  //      recommendation for growing conversations: the breakpoint follows the
  //      tail, each turn writes the fresh prefix, subsequent turns read it back).
  // Absent/false keeps both forms exactly as before — plain-string system and
  // string message content stay strings (byte-identical wire body, zero
  // regression).
  if (systemParts.length) {
    const systemText = systemParts.join('\n');
    // C 批 CR P11：join 产物空串时不进数组块形——Anthropic 拒空 text 块（400），
    // 旧 `body.system = ''` 字符串形态可发，保原形态。
    body.system = request.cacheControl === true && systemText !== ''
      ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
      : systemText;
  }
  if (request.cacheControl === true && messages.length > 0) {
    // Every entry in `messages` was freshly assembled in the loop above, so
    // upgrading the tail in place is side-effect-free. Content forms: string →
    // single text block; blocks array → the marker rides the last block
    // (text / tool_use / tool_result / image alike). A degenerate empty blocks
    // array (assistant with no content, no toolCalls) has nothing to mark — no-op.
    const last = messages[messages.length - 1];
    // C 批 CR P11：空串尾消息不升格——升格会产出 `{type:'text',text:''}` 空 text 块
    // （Anthropic 400）；旧 '' string 形态可发，保原形态。
    if (typeof last.content === 'string') {
      if (last.content !== '') {
        last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
      }
    } else if (last.content.length > 0) {
      const idx = last.content.length - 1;
      last.content[idx] = { ...last.content[idx], cache_control: { type: 'ephemeral' } };
    }
    // 20-block lookback window: when a turn appends >20 content blocks the tail
    // breakpoint drifts past the previous write's window — each such turn pays a
    // fresh cache write (1.25× once) instead of a read (0.1×). That is the
    // expected incremental cost of a tail-following breakpoint, not a defect.
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  // 09-12 子3 §4.2：topP 直发（Messages API 原生 top_p，drop 会砍掉 Anthropic 用户的
  // 第二旋钮）；双 penalty 协议不收——drop + warn-once（上方法氏）。
  if (model.defaultTopP !== undefined) body.top_p = model.defaultTopP;
  if (model.defaultFrequencyPenalty !== undefined || model.defaultPresencePenalty !== undefined) {
    warnPenaltySkipOnce(model);
  }
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  // Thinking adapters task (design §2.1): single injection point for the whole
  // Anthropic face — non-streaming, streaming, and degraded calls all assemble
  // their body through this function. No-op for auto/absent/unknown kinds, so
  // the pre-feature wire body stays byte-identical. The context carries the
  // CR-006 warn-once key and the CR-020 limits for custom re-validation.
  applyThinkingControls(body, request.thinking, model.thinkingKind, 'anthropic-compatible', {
    skipWarnKey: model.thinkingKind !== undefined ? `${model.keyId}:${model.thinkingKind}` : undefined,
    limits: model.limits,
  });
  // 09-12 子3 §4.3：extraBody 组装尾部深合并（同键覆盖协议层默认——用户显式最优先）。
  if (model.extraBody !== undefined && Object.keys(model.extraBody).length > 0) {
    mergeExtraBody(body, model.extraBody);
  }
  return body;
}

async function generateAnthropicText(
  model: ResolvedModel,
  request: TextGenerationRequest,
  maxTokens: number,
  ctx: ProtocolCallContext | undefined,
  opts: { skipQuickRetry?: boolean } = {},
): Promise<TextGenerationResponse> {
  const body = buildAnthropicBody(model, request, maxTokens);

  const attempt = () =>
    postJson<AnthropicResponse>({
      url: `${normalizeBaseUrl(model.baseUrl)}/messages`,
      headers: {
        'x-api-key': model.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // 09-12 子3 §3 ②：customHeaders 在内建头之后展开（同名覆盖生效）。
        ...model.customHeaders,
      },
      body,
      signal: ctx?.signal,
      // 09-12 子3 §3 ⑧：per-key 跳过证书校验（ABSENT = 默认校验，init 不变）。
      dispatcher: model.verifySsl === true ? getInsecureDispatcher() : undefined,
    });
  // CR-T1-007: withRetry suppressed on the streaming-degradation call — that
  // layer already quick-retried its connection window; stacking loops would
  // double the request count.
  const response = opts.skipQuickRetry ? await attempt() : await withRetry(attempt, { signal: ctx?.signal });

  const content = response.content ?? [];
  const text = content
    .filter((block): block is Extract<AnthropicContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
  // CR-T1-006: mirror generateAnthropicTextStream's thinking mapping — the
  // degraded non-streaming path used to silently drop thinking blocks, so the
  // same request returned different output shapes depending on which path
  // served it.
  const reasoning = content
    .filter((block): block is Extract<AnthropicContentBlock, { type: 'thinking' }> => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('');
  // Thinking adapters task (B block, design §5.1): capture the thinking
  // signature for verbatim round-trip in tool loops. Single-string contract
  // keeps the LAST non-empty signature — interleaved multi-block responses
  // would need a block list, and v1 round-trips exactly one thinking block.
  const reasoningSignature = content.reduce<string | undefined>(
    (acc, block) =>
      block.type === 'thinking' && typeof block.signature === 'string' && block.signature
        ? block.signature
        : acc,
    undefined,
  );
  // zen probe (design §2.3): injected ON-state thinking + zero thinking blocks
  // + zero reasoning = the control likely never reached the model (a gateway
  // silently stripping the `thinking` field). Warn once per (keyId, modelId).
  if (
    requestedAnthropicThinkingOn(model, request) &&
    !content.some((block) => block.type === 'thinking') &&
    !reasoning
  ) {
    warnZenThinkingStripOnce(model);
  }
  const toolCalls = content
    .filter((block): block is Extract<AnthropicContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
    }));
  // C 批 CR P10：三桶口径——input_tokens 不含 cache 桶，真实输入量 = 三桶求和；
  // 三桶全缺席时保持 undefined 语义（不造假 0）。cacheReadTokens 透出（mirror agy
  // driver 的 usage 形态，withUsageMetering 已有消费面）。
  const reported = response.usage;
  const completionTokens = reported?.output_tokens;
  const anyInputBucket =
    reported?.input_tokens !== undefined ||
    reported?.cache_read_input_tokens !== undefined ||
    reported?.cache_creation_input_tokens !== undefined;
  const promptTokens = anyInputBucket
    ? (reported?.input_tokens ?? 0) +
      (reported?.cache_read_input_tokens ?? 0) +
      (reported?.cache_creation_input_tokens ?? 0)
    : undefined;

  return {
    model: response.model ?? model.modelId,
    text,
    reasoning: reasoning || undefined,
    reasoningSignature,
    finishReason: mapAnthropicFinishReason(response.stop_reason),
    usage: reported
      ? {
          promptTokens,
          completionTokens,
          // ABSENT ≠ 0（CR-18 纪律）：端点没报就不挂键。
          ...(reported.cache_read_input_tokens !== undefined
            ? { cacheReadTokens: reported.cache_read_input_tokens }
            : {}),
          totalTokens: promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined,
        }
      : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

/** Structural view of an Anthropic SSE frame's JSON payload (field-level guards at use sites). */
type AnthropicStreamFrame = {
  type: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    // Thinking adapters task (B block): `signature_delta` frames accompany
    // thinking blocks; the signature must round-trip verbatim in tool loops.
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
};

// In-stream `error` events (e.g. overloaded_error) carry no HTTP status — map
// to statuses aligned with withRetry's retryable classes so the connection-
// window loop classifies them like the equivalent HTTP failure.
const ANTHROPIC_STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 503,
  rate_limit_error: 429,
  api_error: 500,
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
};

function anthropicStreamError(error: { type?: string; message?: string } | undefined): ProtocolHttpError {
  const kind = error?.type ?? 'stream_error';
  const status = ANTHROPIC_STREAM_ERROR_STATUS[kind] ?? 502;
  return new ProtocolHttpError(
    error?.message ? `${kind}: ${error.message}` : `Anthropic stream error: ${kind}`,
    status,
  );
}

async function anthropicStreamWithResilience(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ctx: ProtocolCallContext | undefined,
  onDelta: (d: GenerationDelta) => void,
  capLearning: { degradedCap?: number | 'uncapped' },
): Promise<TextGenerationResponse> {
  const guardrailApplied = request.maxTokens === undefined;
  // Thinking adapters design §2.2: streaming tops out at the model's official
  // output ceiling (unknown models keep the 32K guardrail); Anthropic requires
  // a numeric max_tokens, hence the non-optional type.
  let cap = resolveStreamingCap(model, request);
  let stripped = false;
  let thinkingStripped = false;
  let effectiveRequest = request;
  for (let attempt = 1; ; attempt++) {
    try {
      return await anthropicStreamAttempt(model, effectiveRequest, cap, ctx, onDelta);
    } catch (err) {
      if (err instanceof StreamInterruptedError) throw err; // mid-stream: never retried
      if (isDeltaCallbackError(err)) throw err; // CR-T1-005: program error, not a stream failure
      if (ctx?.signal?.aborted || isAbortLikeError(err)) throw err; // deliberate abort passthrough
      // Retry window (design §1.2): connection establishment + before any
      // content delta only — ≤2 attempts, sub-second backoff, self-managed
      // (NOT withRetry-wrapped: whole-stream retries would replay deltas).
      // CR-T1-002/004: "established" is now "produced a content delta" — an
      // in-stream error or socket death after message_start/ping but before
      // any content still lands here (retryable), instead of being wrapped
      // into an empty StreamInterruptedError that skipped the retry.
      const canRetrySameCap =
        attempt < 2 && (err instanceof ProtocolTimeoutError || isRetryableProtocolError(err));
      if (!canRetrySameCap) {
        // CR-011: overflow classification first (see generateTextInternal).
        if (isContextOverflowError(err)) throw markContextOverflowError(err);
        if (!stripped && guardrailApplied && isMaxTokensCapRejection(err)) {
          const fallback = anthropicFallbackCap(err); // CR-T1-009: real ceiling when the message names one
          console.warn(
            `[model-protocols] max_tokens guardrail rejected by Anthropic-compatible endpoint; retrying stream once with ${fallback}`,
          );
          stripped = true;
          cap = fallback;
          capLearning.degradedCap = fallback; // CR-T1-008: carry the learning to any degraded call
          continue;
        }
        // Thinking adapters design §2.3: unverified thinking-parameter
        // combinations backstop — one retry with the thinking params stripped.
        if (!thinkingStripped && effectiveRequest.thinking && isThinkingParamRejection(err)) {
          console.warn('[model-protocols] endpoint rejected thinking parameters (4xx mentioning thinking/reasoning); retrying stream once without them');
          thinkingStripped = true;
          effectiveRequest = { ...effectiveRequest, thinking: undefined };
          continue;
        }
        throw markContextOverflowError(err); // pre-establishment → generateTextStream decides the fallback
      }
      await sleepMs(STREAM_RETRY_BASE_DELAY_MS);
    }
  }
}

async function anthropicStreamAttempt(
  model: ResolvedModel,
  request: TextGenerationRequest,
  maxTokens: number,
  ctx: ProtocolCallContext | undefined,
  onDelta: (d: GenerationDelta) => void,
): Promise<TextGenerationResponse> {
  const body = { ...buildAnthropicBody(model, request, maxTokens), stream: true };

  let producedContent = false; // CR-T1-002: a content delta was seen (text/thinking/tool JSON) — message_start/ping prove liveness, not content
  let text = '';
  let reasoning = '';
  let reasoningSignature = ''; // thinking adapters task (B block): signature_delta accumulation
  let sawThinkingBlock = false; // zen probe: any thinking block started (blocks may carry empty text)
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let stopReason: string | null | undefined;
  let promptTokens: number | undefined; // raw input_tokens 桶（三桶求和在 return 处，CR P10）
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let completionTokens: number | undefined;
  let sawMessageStop = false;

  // First-event guard (design §1.2): composite abort signal — outer signal
  // passthrough + a 60s timer that is cleared the moment the first event
  // arrives (mid-stream silence timeout is an explicit non-goal).
  // dogfood R2 #7: the window is lane-selected (240s on background lanes).
  // 09-12 子3: a per-key timeoutSeconds replaces the lane value (streamWindowMs).
  const guard = createFirstEventGuard(ctx?.signal, streamWindowMs(model, ctx));

  try {
    await postSse({
      url: `${normalizeBaseUrl(model.baseUrl)}/messages`,
      headers: {
        'x-api-key': model.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // 09-12 子3 §3 ③：customHeaders 在内建头之后展开（同名覆盖生效）。
        ...model.customHeaders,
      },
      body,
      signal: guard.signal,
      dispatcher: model.verifySsl === true ? getInsecureDispatcher() : undefined,
      onEvent: (ev) => {
        const frame = parseSseJson(ev.data) as unknown as AnthropicStreamFrame | null;
        if (!frame || typeof frame.type !== 'string') return; // [DONE]-like / malformed frames ignored
        if (frame.type === 'error') {
          // CR-T1-002: classify by the ANTHROPIC_STREAM_ERROR_STATUS mapping
          // regardless of timing — whether content was already produced (the
          // catch below wraps it as an interruption) is a separate question
          // from what KIND of failure this is.
          throw anthropicStreamError(frame.error);
        }
        if (!producedContent) {
          // Any event proves liveness for the first-event timer.
          guard.clearTimer();
        }
        switch (frame.type) {
          case 'message_start': {
            // C 批 CR P10：message_start 的 message.usage 携带 cache 桶（官方协议位）；
            // message_delta.usage 只承诺累计 output_tokens，输入侧不读。
            const input = frame.message?.usage?.input_tokens;
            const output = frame.message?.usage?.output_tokens;
            const cacheRead = frame.message?.usage?.cache_read_input_tokens;
            const cacheCreation = frame.message?.usage?.cache_creation_input_tokens;
            if (typeof input === 'number') promptTokens = input;
            if (typeof output === 'number') completionTokens = output;
            if (typeof cacheRead === 'number') cacheReadTokens = cacheRead;
            if (typeof cacheCreation === 'number') cacheCreationTokens = cacheCreation;
            break;
          }
          case 'content_block_start': {
            const block = frame.content_block;
            if (block?.type === 'tool_use') {
              const index = typeof frame.index === 'number' ? frame.index : -1;
              toolBlocks.set(index, {
                id: typeof block.id === 'string' ? block.id : '',
                name: typeof block.name === 'string' ? block.name : '',
                json: '',
              });
              // R2 #30：调用首块外发工具名（mirror ai-sdk 路径 tool-input-start）。
              if (typeof block.name === 'string' && block.name) {
                invokeOnDelta(onDelta, { type: 'tool', delta: '', toolName: block.name });
              }
            } else if (block?.type === 'thinking') {
              // Thinking adapters task (B block): signature capture resets per
              // block — interleaved thinking blocks each carry their own
              // signature; the single-string contract keeps the latest (the
              // round-trip re-assembles exactly one thinking block).
              sawThinkingBlock = true;
              reasoningSignature = '';
            }
            break;
          }
          case 'content_block_delta': {
            const delta = frame.delta;
            const index = typeof frame.index === 'number' ? frame.index : -1;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              producedContent = true;
              text += delta.text;
              invokeOnDelta(onDelta, { type: 'text', delta: delta.text });
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              producedContent = true;
              reasoning += delta.thinking;
              invokeOnDelta(onDelta, { type: 'reasoning', delta: delta.thinking });
            } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
              reasoningSignature += delta.signature;
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              producedContent = true; // streamed tool arguments are content too
              // Accumulate per block; parse only at content_block_stop —
              // half-streamed JSON is never surfaced.
              const block = toolBlocks.get(index);
              if (block) block.json += delta.partial_json;
              // R2 #30：参数流外发活性信号（mirror ai-sdk 路径 tool-input-delta）。
              invokeOnDelta(onDelta, { type: 'tool', delta: delta.partial_json });
            }
            break;
          }
          case 'content_block_stop': {
            const index = typeof frame.index === 'number' ? frame.index : -1;
            const block = toolBlocks.get(index);
            if (block) {
              toolBlocks.delete(index);
              let args = '{}';
              if (block.json) {
                try {
                  JSON.parse(block.json);
                  args = block.json;
                } catch {
                  args = '{}';
                }
              }
              toolCalls.push({ id: block.id, name: block.name, arguments: args });
            }
            break;
          }
          case 'message_delta': {
            if (frame.delta?.stop_reason !== undefined) stopReason = frame.delta.stop_reason;
            const output = frame.usage?.output_tokens;
            if (typeof output === 'number') completionTokens = output;
            break;
          }
          case 'message_stop':
            sawMessageStop = true;
            // CR-T1-003: the full payload is in hand — stop reading. A
            // keep-alive connection that never closes would otherwise leave
            // the read loop pending forever even though every event arrived.
            return 'stop';
          default:
            // 'ping' and anything unrecognized: ignore.
            break;
        }
      },
    });
  } catch (err) {
    if (isDeltaCallbackError(err)) throw err; // CR-T1-005: rethrow as-is — never wrapped below
    // CR-T1-010: a user abort racing the first-event timer classifies as an
    // abort, never as a timeout.
    if (ctx?.signal?.aborted) throw err;
    if (guard.timedOut) throw guard.error; // first-event timeout → connection-window failure (retryable)
    if (producedContent) {
      // Content was already produced — surface what the caller saw streamed.
      // Abort-shaped errors reach here too (the user abort at the top of this
      // catch and the watchdog above are already handled): a remaining
      // abort-like death is an external transport abort and must keep the
      // accumulations (CR-T1-038 residual belt).
      throw new StreamInterruptedError({
        message: `Anthropic stream interrupted: ${errorMessage(err)}`,
        accumulatedText: text,
        accumulatedReasoning: reasoning || undefined,
        status: err instanceof ProtocolHttpError ? err.status : undefined,
        bodyExcerpt: err instanceof ProtocolHttpError ? err.bodyExcerpt : undefined,
      });
    }
    throw err;
  } finally {
    guard.dispose();
  }

  if (!sawMessageStop) {
    // Reader done without message_stop — the double-guarantee failed on the
    // reader side (Anthropic has no [DONE]; message_stop + reader-done are the
    // two terminators and both must agree).
    throw new StreamInterruptedError({
      message: 'Anthropic stream ended without message_stop',
      accumulatedText: text,
      accumulatedReasoning: reasoning || undefined,
    });
  }

  // zen probe (design §2.3): see generateAnthropicText.
  if (
    requestedAnthropicThinkingOn(model, request) &&
    !sawThinkingBlock &&
    !reasoning &&
    !reasoningSignature
  ) {
    warnZenThinkingStripOnce(model);
  }

  // C 批 CR P10：三桶口径（input + cache_read + cache_creation）与非流式路径同源；
  // 三桶全缺席 → promptTokens 保持 undefined（不造假 0）。
  const anyInputBucket =
    promptTokens !== undefined || cacheReadTokens !== undefined || cacheCreationTokens !== undefined;
  const summedPromptTokens = anyInputBucket
    ? (promptTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
    : undefined;

  return {
    model: model.modelId,
    text,
    reasoning: reasoning || undefined,
    reasoningSignature: reasoningSignature || undefined,
    finishReason: mapAnthropicFinishReason(stopReason),
    usage:
      anyInputBucket || completionTokens !== undefined
        ? {
            promptTokens: summedPromptTokens,
            completionTokens,
            // ABSENT ≠ 0（CR-18 纪律）：端点没报就不挂键。
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            totalTokens:
              summedPromptTokens !== undefined && completionTokens !== undefined
                ? summedPromptTokens + completionTokens
                : undefined,
          }
        : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

// ── Shared stream helpers ──

// CR-T1-005: onDelta callback failures (e.g. a webContents already destroyed
// on the consumer side) are PROGRAM errors, not stream failures. They are
// tagged on the way out so every wrapping catch (StreamInterruptedError,
// timeout classification, degradation gates) rethrows them as-is — wrapping
// would mask the real type/stack as a network interruption.
const deltaCallbackErrors = new WeakSet<object>();

function invokeOnDelta(onDelta: (d: GenerationDelta) => void, d: GenerationDelta): void {
  try {
    onDelta(d);
  } catch (err) {
    console.error('[model-protocols] onDelta callback threw (program error; rethrowing as-is)', err);
    if (err instanceof Object) deltaCallbackErrors.add(err);
    throw err;
  }
}

/**
 * Exported (09-12 子2 fallback chains, W2 L1): classifyGenerationFailure in
 * errors.ts consumes these program-error predicates — reusing the module's own
 * tagging instead of duplicating the classification. Additive export only;
 * behavior unchanged.
 */
export function isDeltaCallbackError(err: unknown): boolean {
  return err instanceof Object && deltaCallbackErrors.has(err);
}

/**
 * First-event liveness guard: `signal` is a composite of the caller's signal
 * and a `ms` timer. `clearTimer()` drops the timeout once the stream is
 * proven alive (first event / first content part, per the calling path);
 * `dispose()` cleans listeners either way. `timedOut` distinguishes timeout
 * aborts from caller aborts.
 */
function createFirstEventGuard(outer: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const error = new ProtocolTimeoutError(`No stream event received within ${ms}ms (first-event timeout)`);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort(error);
  }, ms);
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) {
    clearTimeout(timer);
    timer = undefined;
    controller.abort(outer.reason);
  } else {
    outer?.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    error,
    get timedOut() {
      return timedOut;
    },
    clearTimer() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    dispose() {
      this.clearTimer();
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}

function parseSseJson(data: string): Record<string, unknown> | null {
  if (!data || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Exported additively for classifyGenerationFailure (errors.ts, 09-12 子2) — see isDeltaCallbackError. */
export function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return signal !== undefined && err === signal.reason;
}

/**
 * Locate a `ProtocolTimeoutError` anywhere in an error's cause chain. The AI
 * SDK may wrap the fetch abort reason (our connect-timeout error) before it
 * reaches the consumer, and timeouts must never degrade to the unbounded
 * non-streaming fallback (#50).
 */
export function findTimeoutError(err: unknown): ProtocolTimeoutError | undefined {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current instanceof ProtocolTimeoutError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function abortErrorFromContext(ctx: ProtocolCallContext | undefined): Error {
  const reason = ctx?.signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * The AI SDK surfaces HTTP failures as AI_APICallError; normalize to the
 * ProtocolHttpError contract every other path in this package throws.
 */
function normalizeApiCallError(err: unknown): unknown {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 500;
    return new ProtocolHttpError(err.message, status, err.responseBody?.slice(0, 500));
  }
  return err;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseToolArguments(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// ── Image generation (POST /images/generations or /images/edits) ──
// Kept as direct HTTP — Vercel AI SDK does not cover image generation.

type OpenAiImageResponse = {
  data?: Array<{ url?: string; b64_json?: string; b64Json?: string; base64?: string }>;
};

export async function generateImage(
  model: ResolvedModel,
  request: ImageGenerationRequest,
  ctx?: ProtocolCallContext,
): Promise<ImageGenerationResponse> {
  // C3.1（D1 拍板）：记行 + image_count 张数列——图像 API 无 token 信号，token 列如实
  // 全 ABSENT（usageOf 缺省），张数是唯一可如实记的量纲。taskType 走 ctx 通道（网关
  // handler 标 'image-gen'，W3 接线）。分派 generateFromPrompt/editImage 两路罩在同一
  // 行内（一条逻辑调用恒一行）。
  return withEntryUsageMetering(
    { model, ctx, imageCount: request.n ?? 1 },
    (err) => classifyGenerationFailure(err).kind,
    () => (request.image ? editImage(model, request, ctx) : generateFromPrompt(model, request, ctx)),
  );
}

async function generateFromPrompt(
  model: ResolvedModel,
  request: ImageGenerationRequest,
  ctx?: ProtocolCallContext,
): Promise<ImageGenerationResponse> {
  const baseUrl = normalizeBaseUrl(model.baseUrl);
  const body: Record<string, unknown> = {
    model: model.modelId,
    prompt: request.prompt,
    n: request.n ?? 1,
    response_format: 'b64_json',
  };
  if (request.size) body.size = request.size;
  if (request.quality) body.quality = request.quality;
  if (request.background) body.background = request.background;
  if (request.outputFormat) body.output_format = request.outputFormat;

  const raw = await withRetry(
    () => postJson<OpenAiImageResponse>({
      url: `${baseUrl}/images/generations`,
      headers: { authorization: `Bearer ${model.apiKey}`, ...model.customHeaders },
      body,
      signal: ctx?.signal,
      dispatcher: model.verifySsl === true ? getInsecureDispatcher() : undefined,
    }),
    { signal: ctx?.signal },
  );
  return buildImageResponse(model, raw);
}

async function editImage(
  model: ResolvedModel,
  request: ImageGenerationRequest,
  ctx?: ProtocolCallContext,
): Promise<ImageGenerationResponse> {
  if (!request.image || !('b64Json' in request.image)) throw new ProtocolHttpError('editImage requires base64 image input', 500);
  const baseUrl = normalizeBaseUrl(model.baseUrl);

  const raw = await withRetry(
    () => {
      const form = new FormData();
      form.set('model', model.modelId);
      form.set('prompt', request.prompt);
      form.set('image', base64ToBlob(request.image!.b64Json, request.image!.mimeType), 'image.png');
      if (request.mask && 'b64Json' in request.mask) {
        form.set('mask', base64ToBlob(request.mask.b64Json, request.mask.mimeType), 'mask.png');
      }
      if (request.n !== undefined) form.set('n', String(request.n));
      if (request.size) form.set('size', request.size);

      return postMultipart<OpenAiImageResponse>({
        url: `${baseUrl}/images/edits`,
        headers: { authorization: `Bearer ${model.apiKey}`, ...model.customHeaders },
        formData: form,
        signal: ctx?.signal,
        dispatcher: model.verifySsl === true ? getInsecureDispatcher() : undefined,
      });
    },
    { signal: ctx?.signal },
  );
  return buildImageResponse(model, raw);
}

async function buildImageResponse(model: ResolvedModel, raw: OpenAiImageResponse): Promise<ImageGenerationResponse> {
  const response: ImageGenerationResponse = {
    model: model.modelId,
    images: (raw.data ?? []).map((img) => ({
      url: img.url,
      b64Json: img.b64_json ?? img.b64Json ?? img.base64,
    })),
  };
  return normalizeImageResponse(response);
}

// ── Embeddings (direct HTTP POST /embeddings) ──
// Kept as direct HTTP, same as image generation — the Vercel AI SDK has no
// embedding helper we route through. Single-path OpenAI /v1/embeddings format:
// every embed endpoint (including self-hosted/localhost) serves this shape, and
// Anthropic offers no embeddings API, so — unlike generateText — we do NOT
// branch on model.protocol.

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

export async function generateEmbeddings(
  model: ResolvedModel,
  request: EmbeddingRequest,
  ctx?: ProtocolCallContext,
): Promise<EmbeddingResponse> {
  // C3.1：计量 wrapper（design §1）——usage {promptTokens,totalTokens} 有则记，
  // outputTokens 端点不报恒 ABSENT（CR-18 缺席≠0）；taskType 走 ctx 通道（'kb-index-embed'
  // / 'kb-query-embed' 等由调用方透传，W3 接线）。
  return withEntryUsageMetering(
    { model, ctx, usageOf: (r) => r.usage },
    (err) => classifyGenerationFailure(err).kind,
    () => generateEmbeddingsInternal(model, request, ctx),
  );
}

async function generateEmbeddingsInternal(
  model: ResolvedModel,
  request: EmbeddingRequest,
  ctx?: ProtocolCallContext,
): Promise<EmbeddingResponse> {
  const baseUrl = normalizeBaseUrl(model.baseUrl);
  const raw = await withRetry(
    () => postJson<OpenAiEmbeddingResponse>({
      url: `${baseUrl}/embeddings`,
      headers: { authorization: `Bearer ${model.apiKey}`, ...model.customHeaders },
      body: { model: model.modelId, input: request.input },
      signal: ctx?.signal,
      dispatcher: model.verifySsl === true ? getInsecureDispatcher() : undefined,
    }),
    { signal: ctx?.signal },
  );
  // OpenAI returns data[] in input order — preserve it so callers can zip
  // embeddings back to their source texts by index.
  const embeddings = (raw.data ?? []).map((d) => d.embedding ?? []);
  return {
    model: raw.model ?? model.modelId,
    embeddings,
    usage: raw.usage
      ? {
          promptTokens: raw.usage.prompt_tokens,
          totalTokens: raw.usage.total_tokens,
        }
      : undefined,
  };
}
