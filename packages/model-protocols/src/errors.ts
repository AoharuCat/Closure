/**
 * Errors raised by the model-protocols layer. Callers (desktop main IPC) map
 * these to renderer-friendly messages; agent maps them to run warnings.
 */

// 09-12 子2 fallback chains (W2 L1): classifyGenerationFailure reuses the
// generate.ts private-error predicates (program-error WeakSet tagging, abort
// shapes, cause-chain timeout scan) instead of duplicating them. This is a
// DELIBERATE intra-package cycle (generate.ts imports the error classes from
// here): every binding below is consumed lazily inside function bodies, and
// generate.ts never touches this module's exports at module-evaluation time,
// so both load orders resolve cleanly.
import { isAbortLikeError, isDeltaCallbackError, findTimeoutError, errorMessage } from './generate';

export class ProtocolHttpError extends Error {
  readonly status: number;
  readonly bodyExcerpt?: string;
  constructor(message: string, status: number, bodyExcerpt?: string) {
    super(message);
    this.name = 'ProtocolHttpError';
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export class ProtocolSchemaError extends Error {
  readonly issues: unknown;
  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = 'ProtocolSchemaError';
    this.issues = issues;
  }
}

export class ProtocolCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolCapabilityError';
  }
}

/**
 * Raised when a streaming request never produced its first event within the
 * first-event timeout window (dogfood T1 D2 hardening). Classified as a
 * connection-window failure: callers may retry it, but must NOT fall back to
 * an unbounded non-streaming call (that would reintroduce the #50 hang).
 */
export class ProtocolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolTimeoutError';
  }
}

/**
 * Raised when an established stream died after content had already been
 * produced (dogfood T1 design §1.3). Carries the accumulated text/reasoning so
 * the caller (runLoop) can persist partial output instead of silently losing
 * everything the user already saw streamed.
 */
export class StreamInterruptedError extends ProtocolHttpError {
  readonly accumulatedText: string;
  readonly accumulatedReasoning?: string;
  constructor(details: {
    message: string;
    accumulatedText: string;
    accumulatedReasoning?: string;
    status?: number;
    bodyExcerpt?: string;
  }) {
    super(details.message, details.status ?? 502, details.bodyExcerpt);
    this.name = 'StreamInterruptedError';
    this.accumulatedText = details.accumulatedText;
    this.accumulatedReasoning = details.accumulatedReasoning;
  }
}

/**
 * Context-window overflow (thinking adapters task, design §4.1): a 4xx whose
 * report names the context limit ("context length" / "context window" /
 * "prompt is too long" family — snake-case codes like `context_length_exceeded`
 * normalize to the same matches). Carries the stable `code` marker so the
 * agent layer can trigger one compaction retry instead of surfacing a raw 400;
 * subclasses ProtocolHttpError so existing status-based classification keeps
 * working.
 */
export class ProtocolContextOverflowError extends ProtocolHttpError {
  readonly code = 'CONTEXT_OVERFLOW' as const;
  constructor(message: string, status: number, bodyExcerpt?: string) {
    super(message, status, bodyExcerpt);
    this.name = 'ProtocolContextOverflowError';
  }
}

/**
 * Predicate form (belt to the class marking): recognizes both marked errors
 * AND raw ProtocolHttpErrors whose report matches the overflow family — the
 * compat-retry paths can surface the raw shape without re-marking.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof ProtocolContextOverflowError) return true;
  if (!(err instanceof ProtocolHttpError)) return false;
  const haystack = `${err.message}\n${err.bodyExcerpt ?? ''}`.toLowerCase().replace(/[_-]/g, ' ');
  return (
    haystack.includes('context length') ||
    haystack.includes('context window') ||
    haystack.includes('prompt is too long') ||
    haystack.includes('input is too long')
  );
}

export class ProtocolNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolNotImplementedError';
  }
}

// ── 09-12 子2 fallback chains：失败分类器 + 链尽错误 ──

/** Failure family for {@link classifyGenerationFailure} (design §3 table). */
export type FallbackFailureKind =
  // fallback-ELIGIBLE families — a different model may succeed
  | 'auth'       // ProtocolHttpError 401/403
  | 'quota'      // ProtocolHttpError 429/402 (quota/payment)
  | 'timeout'    // ProtocolHttpError 408 / ProtocolTimeoutError (incl. agy print-timeout, first-event windows)
  | 'server'     // ProtocolHttpError ≥500 (incl. agy crash / terminal ERROR mapped to 502 by 子1)
  | 'network'    // fetch TypeError family (fetch failed / ECONNREFUSED / ETIMEDOUT / ECONNRESET / EPROTO / EAI_AGAIN)
  // fallback-INELIGIBLE families — request-intrinsic or already-visible failures
  | 'overflow'   // context-window overflow — runLoop compaction is the remedy (never burn the chain)
  | 'schema'     // ProtocolSchemaError / ProtocolCapabilityError / ProtocolNotImplementedError (request/config malformation; agy invalid model lands here via 子1)
  | 'interrupted'// StreamInterruptedError — content already flowed, "never retried" red line
  | 'abort'      // user cancellation — not a failure
  | 'program'    // onDelta consumer throw (generate.ts WeakSet tagging)
  | 'other';     // unknown — conservative direct throw

export type GenerationFailureClassification = {
  /** True = the gateway fallback loop may advance to the next chain entry. */
  eligible: boolean;
  kind: FallbackFailureKind;
  /** Compact human-readable summary (`kind: HTTP <status>: <message>`), capped. */
  reason: string;
};

/** Cap for the reason excerpt — the full message lives on the original error. */
const FAILURE_REASON_CHAR_CAP = 300;

const NETWORK_ERROR_SIGNATURES = /fetch failed|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPROTO|EAI_AGAIN|connect timeout/i;

/**
 * Network-family predicate (design §3): fetch surfaces transport failures as
 * `TypeError('fetch failed')` with the real syscall code nested in `cause`
 * (undici also names connect timeouts `ConnectTimeoutError`). Scans the error
 * and its cause chain (depth 5, mirroring findTimeoutError).
 */
function isNetworkFamilyError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.name === 'ConnectTimeoutError') return true;
    if (NETWORK_ERROR_SIGNATURES.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function failureReason(kind: FallbackFailureKind, err: unknown): string {
  const detail =
    err instanceof ProtocolHttpError ? `HTTP ${err.status}: ${errorMessage(err)}` : errorMessage(err);
  const capped = detail.length > FAILURE_REASON_CHAR_CAP
    ? `${detail.slice(0, FAILURE_REASON_CHAR_CAP)}…(+${detail.length - FAILURE_REASON_CHAR_CAP} chars)`
    : detail;
  return `${kind}: ${capped}`;
}

function classification(kind: FallbackFailureKind, eligible: boolean, err: unknown): GenerationFailureClassification {
  return { eligible, kind, reason: failureReason(kind, err) };
}

/**
 * Single-source failure classification for the task-model fallback chain
 * (09-12 子2 design §3). Principle: per-model failures (switching models may
 * help) advance the chain; request-intrinsic failures (any model dies the same
 * death) throw directly.
 *
 * Form-agnostic across provider kinds on purpose: the Antigravity CLI driver
 * (子1 §3.7) already maps its terminal states onto THIS error family, so no
 * CLI-specific logic is duplicated here — agy↔HTTP chains classify identically.
 *
 * NOTE the design §3 `config` row (resolveModel failures — deleted key /
 * disabled model / missing cliExecutable) is pre-classified by the gateway
 * loop itself (环内预分类, W3) and does not flow through this function; an
 * unknown shell-layer error landing here degrades to the conservative
 * `other` row.
 *
 * Ordering is load-bearing: program tags and the overflow predicate outrank
 * the generic HTTP rows (ProtocolContextOverflowError/StreamInterruptedError
 * are ProtocolHttpError subclasses — overflow must beat the 4xx row, interrupted
 * must beat the ≥500 row), and abort shapes never masquerade as server errors.
 */
export function classifyGenerationFailure(err: unknown): GenerationFailureClassification {
  // Program errors (onDelta consumer throw): consumer bugs, never stream
  // failures — classified ahead of everything (the WeakSet tag is authoritative).
  if (isDeltaCallbackError(err)) return classification('program', false, err);
  // Context overflow (marked class OR bare predicate family): keep the marker
  // path intact — runLoop's compaction retry is the remedy, cross-window rescue
  // deliberately does not burn the chain.
  if (isContextOverflowError(err)) return classification('overflow', false, err);
  // Interrupted stream: content already flowed to the user — never retried,
  // never silently regenerated on another model (double-insurance with the
  // gateway's producedDelta gate).
  if (err instanceof StreamInterruptedError) return classification('interrupted', false, err);
  // Abort family: user cancellation is not a failure.
  if (isAbortLikeError(err)) return classification('abort', false, err);
  // Schema / capability family: request or config malformation — same death on
  // any model (includes agy invalid-model mapped to ProtocolSchemaError).
  if (
    err instanceof ProtocolSchemaError ||
    err instanceof ProtocolCapabilityError ||
    err instanceof ProtocolNotImplementedError
  ) {
    return classification('schema', false, err);
  }
  // Timeouts (direct or wrapped in a cause chain by the AI SDK) — per-model
  // liveness facts, eligible on BOTH lanes (open item A verdict: each attempt
  // stays individually bounded, the no-unbounded-wait red line holds).
  if (err instanceof ProtocolTimeoutError || findTimeoutError(err) !== undefined) {
    return classification('timeout', true, err);
  }
  // HTTP statuses.
  if (err instanceof ProtocolHttpError) {
    if (err.status === 401 || err.status === 403) return classification('auth', true, err);
    if (err.status === 429 || err.status === 402) return classification('quota', true, err);
    if (err.status === 408) return classification('timeout', true, err);
    if (err.status >= 500) return classification('server', true, err);
    // Other 4xx: request-shaped — a different model dies the same death.
    return classification('other', false, err);
  }
  // Network family (raw fetch transport failures).
  if (isNetworkFamilyError(err)) return classification('network', true, err);
  // Unknown: conservative direct throw — unknown errors fail loudly exactly as
  // they do today, the chain is never burned on a guess.
  return classification('other', false, err);
}

/** ONE failed-attempt record on an exhausted fallback chain (design §4). */
export type FallbackAttemptRecord = {
  keyId: string;
  modelId: string;
  reason: string;
};

function formatFallbackChainMessage(attempts: FallbackAttemptRecord[]): string {
  const perAttempt = attempts.map((a) => `[${a.keyId}/${a.modelId}] ${a.reason}`).join('; ');
  return `Fallback chain exhausted: ${perAttempt || 'no attempt records'}`;
}

/**
 * Every entry on the fallback chain failed (09-12 子2 design §4): carries the
 * per-model failure records so the aggregated message (consumed verbatim by
 * the existing agentError card) names each model's failure reason. Only ever
 * raised when a chain existed — the no-chain path rethrows the ORIGINAL error
 * untouched (byte-level current behavior).
 */
export class FallbackChainExhaustedError extends Error {
  readonly attempts: FallbackAttemptRecord[];
  constructor(attempts: FallbackAttemptRecord[]) {
    super(formatFallbackChainMessage(attempts));
    this.name = 'FallbackChainExhaustedError';
    this.attempts = attempts;
  }
}
