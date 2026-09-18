import { Agent } from 'undici';
import { ProtocolHttpError } from './errors';

export type JsonRequestOptions = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * undici dispatcher for this request (09-12 子3 verifySsl): `dispatcher` is a
   * NON-STANDARD fetch init field (absent from lib.dom's RequestInit — callers
   * pass the undici Agent from getInsecureDispatcher, local cast at the fetch
   * call). ABSENT = default verification, and the init object is left
   * byte-identical to the pre-子3 shape (zero passthrough when unused).
   */
  dispatcher?: unknown;
};

/**
 * Lazy process-singleton undici Agent with certificate verification OFF
 * (09-12 子3, design §3 ⑧). NEVER installed globally (setGlobalDispatcher would
 * affect every key and every fetch face of the process) — it reaches the wire
 * only as the per-request `dispatcher` init field of keys that explicitly set
 * verifySsl / requests that pass insecure. Pure JS (no native rebuild face).
 */
let insecureAgent: Agent | undefined;

export function getInsecureDispatcher(): Agent {
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureAgent;
}

/** Attach the non-standard `dispatcher` field onto a fetch init (mutates; no-op for undefined). */
function applyDispatcher(init: RequestInit, dispatcher: unknown): void {
  if (dispatcher === undefined) return;
  (init as { dispatcher?: unknown }).dispatcher = dispatcher;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Normalize baseUrl: ensure it ends with /v1 (user may or may not include it). */
export function normalizeBaseUrl(value: string): string {
  const base = trimTrailingSlash(value);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

/**
 * Internal helper for protocol adapters: POSTs JSON, parses JSON, and maps
 * non-2xx responses to `ProtocolHttpError` with a body excerpt for triage.
 */
export async function postJson<T>({
  url,
  method = 'POST',
  headers = {},
  body,
  signal,
  dispatcher,
}: JsonRequestOptions): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  };
  applyDispatcher(init, dispatcher);
  const response = await fetch(url, init);

  const text = await response.text();
  const parsed = text ? safeParseJson(text) : null;

  if (!response.ok) {
    throw new ProtocolHttpError(httpErrorMessage(parsed, response.status), response.status, text.slice(0, 500));
  }

  return parsed as T;
}

export async function getJson<T>({
  url,
  headers = {},
  signal,
  dispatcher,
}: { url: string; headers?: Record<string, string>; signal?: AbortSignal; dispatcher?: unknown }): Promise<T> {
  const init: RequestInit = { method: 'GET', headers, signal };
  applyDispatcher(init, dispatcher);
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? safeParseJson(text) : null;

  if (!response.ok) {
    throw new ProtocolHttpError(
      `Provider request failed with ${response.status}`,
      response.status,
      text.slice(0, 500),
    );
  }

  return parsed as T;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Shared non-2xx message extraction: prefer the OpenAI-style
 * `error.message` field from the body, fall back to a bare status line.
 */
function httpErrorMessage(parsed: unknown, status: number): string {
  const looksLikeError =
    typeof parsed === 'object' && parsed !== null && 'error' in parsed && (parsed as any).error &&
    typeof (parsed as any).error === 'object';
  if (looksLikeError && typeof (parsed as any).error.message === 'string') {
    return (parsed as any).error.message;
  }
  return `Provider request failed with ${status}`;
}

/**
 * Internal helper for protocol adapters that need multipart/form-data (e.g.
 * OpenAI `/images/edits`). Callers pass a fully-built FormData; we do NOT
 * set `content-type` manually — `fetch` will attach the correct boundary.
 */
export async function postMultipart<T>({
  url,
  headers = {},
  formData,
  signal,
  dispatcher,
}: {
  url: string;
  headers?: Record<string, string>;
  formData: FormData;
  signal?: AbortSignal;
  dispatcher?: unknown;
}): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: formData,
    signal,
  };
  applyDispatcher(init, dispatcher);
  const response = await fetch(url, init);

  const text = await response.text();
  const parsed = text ? safeParseJson(text) : null;

  if (!response.ok) {
    throw new ProtocolHttpError(httpErrorMessage(parsed, response.status), response.status, text.slice(0, 500));
  }

  return parsed as T;
}

/**
 * Convert a base64 payload to a Blob suitable for FormData uploads.
 * The input must be raw base64 (no `data:...;base64,` prefix) — the UI
 * strips that in `dataUrlToBase64` before reaching the gateway.
 */
export function base64ToBlob(b64Json: string, mimeType: string): Blob {
  const binary = globalThis.atob(b64Json);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// ── SSE (text/event-stream) ──
//
// Dogfood T1 #50: Anthropic-compatible streaming needs a hand-written SSE
// reader — `postJson` awaits `response.text()` (full-buffer), which defeats
// streaming entirely. This is the repo's first SSE parser; notes:
//   - events are separated by a blank line; `data:` lines are joined with \n
//   - Anthropic terminates with a `message_stop` EVENT, not `data: [DONE]`
//     (the parser here stays provider-agnostic — `[DONE]` passes through as a
//     plain data string and callers ignore what they don't know)
//   - abort errors propagate as-is (AbortError), never swallowed into a
//     ProtocolHttpError

/** One parsed SSE frame: the `event:` field (if any) plus joined `data:` lines. */
export type SseEvent = { event?: string; data: string };

export type SseRequestOptions = {
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** undici dispatcher passthrough (09-12 子3 verifySsl) — see JsonRequestOptions.dispatcher. */
  dispatcher?: unknown;
  /**
   * Called for every complete frame. Return `'stop'` to gracefully end the
   * read loop early (CR-T1-003): terminal frames like Anthropic's
   * `message_stop` mean the full payload is in hand, and keep-alive comment
   * bytes can reset the transport's idle timeout on a connection that will
   * otherwise never close — awaiting `reader.done` would hang forever. The
   * reader is cancelled (releasing the connection) on early exit.
   */
  onEvent: (event: SseEvent) => 'stop' | void;
};

/**
 * POSTs JSON and consumes the response as an SSE stream, invoking `onEvent`
 * for every complete frame. Resolves when the stream ends (reader done) or
 * when `onEvent` returns `'stop'`. Non-2xx responses are normalized exactly
 * like `postJson`.
 */
export async function postSse({
  url,
  headers = {},
  body,
  signal,
  dispatcher,
  onEvent,
}: SseRequestOptions): Promise<void> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  };
  applyDispatcher(init, dispatcher);
  const response = await fetch(url, init);

  if (!response.ok) {
    const text = await response.text();
    const parsed = text ? safeParseJson(text) : null;
    throw new ProtocolHttpError(httpErrorMessage(parsed, response.status), response.status, text.slice(0, 500));
  }
  if (!response.body) {
    throw new ProtocolHttpError('Provider returned an empty SSE body', 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const framer = new SseFramer();
  let stopped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (framer.push(decoder.decode(value, { stream: true }), onEvent) === 'stop') {
        stopped = true; // CR-T1-003: terminal frame seen — stop reading; cancel releases the connection
        break;
      }
    }
    // Flush any final decoder bytes; per SSE spec an unterminated trailing
    // frame is NOT dispatched, so this only drains the decoder, not a frame.
    // Skipped after an early stop — everything past the terminal frame is
    // irrelevant by definition.
    if (!stopped) framer.push(decoder.decode(), onEvent);
  } finally {
    // Best-effort cleanup when we exit early (callback throw / abort / stop);
    // a failed cancel on an already-dead stream is irrelevant.
    void reader.cancel().catch(() => {});
  }
}

/**
 * Incremental SSE line framer. Handles the classic hand-written-parser bug
 * points: cross-chunk half lines (partial line held until its terminator
 * arrives), `\r\n` / `\n` / lone `\r` terminators (a trailing lone `\r` is
 * held back — it may be the first half of a `\r\n` pair), multi-line `data:`
 * (joined with `\n`), comment lines (`:`-prefixed), and data-less frames
 * (dispatched as nothing — callers never see empty events).
 */
class SseFramer {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | undefined;

  /** Returns `'stop'` when `onEvent` asked to stop — buffered lines after the stop frame are NOT dispatched. */
  push(chunk: string, onEvent: (event: SseEvent) => 'stop' | void): 'stop' | void {
    this.buffer += chunk;
    for (;;) {
      const terminator = findLineTerminator(this.buffer);
      if (terminator === null) break;
      const line = this.buffer.slice(0, terminator.end);
      this.buffer = this.buffer.slice(terminator.next);
      if (this.handleLine(line, onEvent) === 'stop') return 'stop';
    }
  }

  private handleLine(line: string, onEvent: (event: SseEvent) => 'stop' | void): 'stop' | void {
    if (line === '') {
      // Blank line = frame boundary. Only frames carrying data dispatch.
      const hasData = this.dataLines.length > 0;
      const event: SseEvent | undefined = hasData
        ? { event: this.eventName, data: this.dataLines.join('\n') }
        : undefined;
      this.dataLines = [];
      this.eventName = undefined;
      if (event && onEvent(event) === 'stop') return 'stop'; // CR-T1-003
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataLines.push(value);
    } else if (field === 'event') {
      this.eventName = value;
    }
    // `id:` / `retry:` / unknown fields: ignored.
  }
}

/**
 * Find the earliest line terminator in the buffer. Returns null when the
 * buffer holds no complete terminator (a trailing lone `\r` is deliberately
 * treated as incomplete — see SseFramer).
 */
function findLineTerminator(buffer: string): { end: number; next: number } | null {
  const nl = buffer.indexOf('\n');
  const cr = buffer.indexOf('\r');
  let earliest: { end: number; next: number } | null =
    nl === -1 ? null : { end: nl, next: nl + 1 };
  if (cr !== -1 && (earliest === null || cr < earliest.end)) {
    if (cr === buffer.length - 1) return null; // possible `\r\n` split across chunks
    earliest = buffer[cr + 1] === '\n' ? { end: cr, next: cr + 2 } : { end: cr, next: cr + 1 };
  }
  return earliest;
}
