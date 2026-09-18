import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import {
  generateText,
  generateTextStream,
  ProtocolContextOverflowError,
  ProtocolHttpError,
  ProtocolTimeoutError,
  StreamInterruptedError,
} from '../src';
import type { GenerationDelta } from '../src';
import { postSse } from '../src/http';
import type { SseEvent } from '../src/http';
import { withRetry } from '../src/retry';

// Dogfood T1 Stage 0 — streaming + D2 resilience (design §1 / implement.md S0):
// postSse framing, dual-protocol delta mapping, retry-window split, first-event
// timeout, maxTokens guardrail + its compat degradations, and the streaming→
// non-streaming fallback.

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };
type Responder = (call: CapturedCall) => Response;

function anthropicModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'claude-3-5-sonnet-latest',
    protocol: 'anthropic-compatible',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

function openaiModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'gpt-4o',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

/** Mock fetch with a per-call responder queue (last responder repeats). */
function queuedFetch(captured: CapturedCall[], responders: Responder[]) {
  let call = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = { url: String(input), init };
    captured.push(entry);
    const responder = responders[Math.min(call, responders.length - 1)];
    call += 1;
    return responder(entry);
  });
}

/**
 * SSE-shaped Response. Chunks are enqueued one per pull (each read() drains a
 * single chunk, so cross-chunk framing is exercised; pull-based enqueue is
 * also what makes `error` deliverable AFTER the chunks — erroring from start()
 * would discard the queued chunks). `hang` leaves the stream open forever
 * (dead-gateway simulation, observable only via its signal). When `signal`
 * aborts, the body errors with the abort reason — mirroring undici.
 */
function sseResponse(
  chunks: string[],
  opts: { error?: Error; hang?: boolean } = {},
  signal?: AbortSignal | null,
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => controller.error(signal?.reason ?? new TypeError('fetch failed'));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      if (opts.error) {
        controller.error(opts.error);
        return;
      }
      if (!opts.hang) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A 200 JSON response whose body never arrives — only `signal`'s abort ends
 * it. Simulates the bounded non-streaming fallback sitting in flight while
 * the user cancels (CR-33).
 */
function hangingJsonResponse(signal?: AbortSignal | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => controller.error(signal?.reason ?? new TypeError('fetch failed'));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // never enqueues, never closes — pending forever
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

function errorBody(message: string): unknown {
  return { error: { message, type: 'invalid_request_error' } };
}

// ── postSse framing ──

describe('postSse (SSE framing)', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  async function collectEvents(chunks: string[]): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    globalThis.fetch = vi.fn(async () => sseResponse(chunks));
    await postSse({ url: 'https://x.test/sse', body: {}, onEvent: (e) => { events.push(e); } });
    return events;
  }

  it('reassembles data lines split across chunk boundaries', async () => {
    const events = await collectEvents(['data: {"a":', '1}\n\n', 'data: {"b', '":2}\n', '\n']);
    expect(events).toEqual([{ data: '{"a":1}' }, { data: '{"b":2}' }]);
  });

  it('joins multi-line data with newline and captures the event field', async () => {
    const events = await collectEvents(['event: message_start\ndata: line1\n', 'data: line2\n\n']);
    expect(events).toEqual([{ event: 'message_start', data: 'line1\nline2' }]);
  });

  it('ignores comments and frames without data lines', async () => {
    const events = await collectEvents([': keepalive\n\n', 'event: ping\n\n', 'data: x\n\n']);
    expect(events).toEqual([{ data: 'x' }]);
  });

  it('handles CRLF and lone CR terminators', async () => {
    const events = await collectEvents(['data: a\r\n\r\ndata: b\r\ndata: c\r\n\r\n']);
    expect(events).toEqual([{ data: 'a' }, { data: 'b\nc' }]);
  });

  it('normalizes non-2xx to ProtocolHttpError with the provider message', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(errorBody('bad key'), 401));
    await expect(
      postSse({ url: 'https://x.test/sse', body: {}, onEvent: () => {} }),
    ).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 401,
      message: 'bad key',
    });
  });

  it('propagates abort as AbortError, never as ProtocolHttpError', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(
      async (_input, init) => sseResponse(['data: partial\n\n'], { hang: true }, init?.signal),
    );
    const promise = postSse({ url: 'https://x.test/sse', body: {}, signal: controller.signal, onEvent: () => {} });
    setTimeout(() => controller.abort(), 10);
    const err = await promise.then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(ProtocolHttpError);
  });

  // CR-T1-003: message_stop received but the connection never closes
  // (keep-alive) — the read loop must stop gracefully once onEvent says stop.
  it("resolves when onEvent returns 'stop' even on a never-closing stream", async () => {
    const events: SseEvent[] = [];
    globalThis.fetch = vi.fn(
      async (_input, init) => sseResponse(['data: terminal\n\n', ': keepalive\n\n'], { hang: true }, init?.signal),
    );
    await postSse({ url: 'https://x.test/sse', body: {}, onEvent: (e) => { events.push(e); return 'stop'; } });
    expect(events).toEqual([{ data: 'terminal' }]);
  });

  it("does not dispatch frames buffered after the 'stop' frame in the same chunk", async () => {
    const events: SseEvent[] = [];
    // Both frames arrive in ONE chunk — the framer must not dispatch 'b' after
    // the callback stopped on 'a'.
    globalThis.fetch = vi.fn(async () => sseResponse(['data: a\n\ndata: b\n\n']));
    await postSse({
      url: 'https://x.test/sse',
      body: {},
      onEvent: (e) => { events.push(e); return e.data === 'a' ? 'stop' : undefined; },
    });
    expect(events).toEqual([{ data: 'a' }]);
  });
});

// ── Anthropic streaming path ──

function anthEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const ANTHROPIC_HAPPY = [
  anthEvent('message_start', { message: { usage: { input_tokens: 11 } } }),
  anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '好' } }),
  anthEvent('content_block_stop', { index: 0 }),
  anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
  anthEvent('message_stop'),
];

describe('generateTextStream (anthropic-compatible)', () => {
  let captured: CapturedCall[];
  let deltas: GenerationDelta[];

  beforeEach(() => {
    captured = [];
    deltas = [];
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function bodyOf(index: number): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  it('streams text deltas and maps the terminal frame', async () => {
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal)]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(captured[0].url).toBe('https://api.anthropic.com/v1/messages');
    const headers = captured[0].init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(bodyOf(0).stream).toBe(true);
    expect(bodyOf(0).max_tokens).toBe(32768); // D2 guardrail when caller sets none

    expect(deltas).toEqual([
      { type: 'text', delta: '你' },
      { type: 'text', delta: '好' },
    ]);
    expect(result.text).toBe('你好');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect('cacheReadTokens' in (result.usage ?? {})).toBe(false); // C 批 CR P10：全缺席键 ABSENT
  });

  it('streams thinking deltas and aggregates reasoning onto the terminal frame', async () => {
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '推' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '理' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '答案' } }),
      anthEvent('content_block_stop', { index: 1 }),
      anthEvent('message_delta', { delta: { stop_reason: 'end_turn' } }),
      anthEvent('message_stop'),
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual([
      { type: 'reasoning', delta: '推' },
      { type: 'reasoning', delta: '理' },
      { type: 'text', delta: '答案' },
    ]);
    expect(result.text).toBe('答案');
    expect(result.reasoning).toBe('推理');
  });

  it('aggregates tool_use JSON at block stop — half JSON is never streamed', async () => {
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'query_story' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: ' "伏笔"}' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('message_delta', { delta: { stop_reason: 'tool_use' } }),
      anthEvent('message_stop'),
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual([
      // R2 #30：工具参数流也外发活性信号（块首带工具名，参数逐块外发）——旧态「JSON
      // accumulation is invisible」的静默窗正是 UI 死寂的根因（正文毕、参数仍在流）。
      { type: 'tool', delta: '', toolName: 'query_story' },
      { type: 'tool', delta: '{"query":' },
      { type: 'tool', delta: ' "伏笔"}' },
    ]);
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'query_story', arguments: '{"query": "伏笔"}' },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('wraps mid-stream death into StreamInterruptedError carrying accumulated text', async () => {
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '半篇' } }),
    ];
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(chunks, { error: new TypeError('fetch failed: socket hang up') }, call.init?.signal),
    ]);

    const err = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StreamInterruptedError);
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as StreamInterruptedError).accumulatedText).toBe('半篇');
    expect(captured.length).toBe(1); // post-delta interruption is never retried
  });

  it('throws StreamInterruptedError when the reader closes without message_stop', async () => {
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '尾声' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('message_delta', { delta: { stop_reason: 'end_turn' } }),
      // message_stop deliberately absent — stream just ends
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    await expect(
      generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        () => {},
      ),
    ).rejects.toMatchObject({
      name: 'StreamInterruptedError',
      accumulatedText: '尾声',
    });
  });

  it('retries a pre-establishment 503 once and succeeds (retry window ≤2)', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('upstream overloaded'), 503),
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(2);
    expect(result.text).toBe('你好');
  });

  it('guardrail compat: a 4xx naming a max_tokens ceiling retries the stream once at that ceiling', async () => {
    // CR-T1-009: the compat cap is parsed from the rejection message (8192
    // here), not the fixed 16384 guess — a lower real ceiling would just
    // fail again on the fixed value.
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens must be less than or equal to 8192'), 400),
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(2);
    expect(bodyOf(0).max_tokens).toBe(32768);
    expect(bodyOf(1).max_tokens).toBe(8192);
    expect(result.text).toBe('你好');
  });

  it('guardrail compat: an unparseable max_tokens rejection falls back to 16384', async () => {
    // CR-T1-009: no ceiling in the message → pre-guardrail default.
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens exceeds the maximum allowed for this model'), 400),
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(2);
    expect(bodyOf(1).max_tokens).toBe(16384);
    expect(result.text).toBe('你好');
  });

  // CR-T1-002: an in-stream error event before any content delta is a
  // connection-window failure — classified by its mapped status (503 here),
  // quick-retried as a stream, never wrapped into an empty StreamInterruptedError.
  it('retries an in-stream overloaded_error before any content delta', async () => {
    const overloadedStart = [
      anthEvent('message_start'),
      anthEvent('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ];
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(overloadedStart, {}, call.init?.signal),
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(2); // pre-content in-stream error → retryable stream window
    expect(result.text).toBe('你好');
  });

  // CR-T1-002: after content was produced, an in-stream error keeps its mapped
  // status but becomes an interruption carrying the accumulation.
  it('wraps an in-stream error after content into StreamInterruptedError with the mapped status', async () => {
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '半篇' } }),
      anthEvent('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ];
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(chunks, {}, call.init?.signal),
    ]);

    const err = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StreamInterruptedError);
    expect((err as StreamInterruptedError).accumulatedText).toBe('半篇');
    expect((err as StreamInterruptedError).status).toBe(503); // ANTHROPIC_STREAM_ERROR_STATUS mapping
    expect(captured.length).toBe(1); // post-content: never retried
  });

  // CR-T1-004: a socket death after message_start but BEFORE any content delta
  // is an empty-accumulation interruption — retryable in the stream window,
  // not silently degraded to an unbounded non-streaming call.
  it('retries an empty-accumulation stream death before any content delta', async () => {
    const startOnly = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ];
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(startOnly, { error: new TypeError('fetch failed: socket hang up') }, call.init?.signal),
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(2);
    expect(result.text).toBe('你好');
  });

  // CR-T1-003 end-to-end: the full payload arrived (message_stop seen) but the
  // connection stays open — must still resolve.
  it('resolves after message_stop even when the connection never closes', async () => {
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(ANTHROPIC_HAPPY, { hang: true }, call.init?.signal),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(result.text).toBe('你好');
    expect(deltas.length).toBe(2);
  });

  // CR-T1-005: a throwing onDelta consumer is a program error — it must
  // surface as-is (same instance), never masked as a stream interruption.
  it('propagates an onDelta callback error as-is, unwrapped (anthropic)', async () => {
    const boom = new Error('webContents destroyed');
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
    ]);

    const err = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => { throw boom; },
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(StreamInterruptedError);
  });

  // CR-T1-010: a user abort inside the first-event window classifies as an
  // abort, never as a ProtocolTimeoutError — even at the timer boundary.
  it('user abort just before the first-event timeout wins over timeout classification', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse([], { hang: true }, call.init?.signal),
      ]);

      const promise = generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        { signal: controller.signal },
        () => {},
      );
      const errPromise = promise.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );

      await vi.advanceTimersByTimeAsync(59_999); // still inside the window
      controller.abort(); // user cancels 1ms before the timer would fire
      await vi.advanceTimersByTimeAsync(1_000); // timer window elapses after the abort
      const err = await errPromise;

      expect((err as Error).name).toBe('AbortError');
      expect(err).not.toBeInstanceOf(ProtocolTimeoutError);
      expect(captured.length).toBe(1); // deliberate abort: no retry, no fallback
    } finally {
      vi.useRealTimers();
    }
  });

  // CR-T1-038 (residual belt): an abort-shaped transport death AFTER content
  // deltas must surface as StreamInterruptedError carrying the accumulations —
  // not a bare rethrow that lets the UI purge what the user already saw.
  it('wraps a post-content abort-like stream death with accumulations (anthropic)', async () => {
    const externalAbort = new Error('connection reset');
    externalAbort.name = 'AbortError';
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } }),
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, { error: externalAbort }, call.init?.signal)]);

    const err = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StreamInterruptedError);
    expect((err as StreamInterruptedError).accumulatedText).toBe('你好');
    expect(err).not.toBeInstanceOf(ProtocolTimeoutError);
    expect(captured.length).toBe(1); // content was streamed: no retry, no fallback
  });

  it('degrades to non-streaming when the endpoint rejects stream:true (single attempt)', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('streaming is not supported by this model'), 400),
      () => jsonResponse(
        {
          type: 'message',
          model: 'claude-3-5-sonnet-latest',
          content: [{ type: 'text', text: '降级成功' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 4 },
        },
        200,
      ),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(captured.length).toBe(2);
    expect('stream' in bodyOf(1)).toBe(false); // fallback went through non-streaming postJson
    expect(bodyOf(1).max_tokens).toBe(32768);
    expect(result.text).toBe('降级成功');
    expect(result.finishReason).toBe('stop');
    expect(deltas).toEqual([]); // no deltas on the degraded path
  });

  // CR-T1-008 + CR-T1-009: the degraded non-streaming call inherits the
  // ceiling the stream layer parsed from the rejection (8192), instead of
  // re-deriving the 32K guardrail and tripping the same rejection again.
  it('degradation inherits the parsed cap learned by the stream attempts', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens must be less than or equal to 8192'), 400),
      () => jsonResponse(errorBody('stream is not supported'), 400),
      () => jsonResponse(
        {
          type: 'message',
          model: 'claude-3-5-sonnet-latest',
          content: [{ type: 'text', text: '降级成功' }],
          stop_reason: 'end_turn',
        },
        200,
      ),
    ]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(3);
    expect(bodyOf(1).max_tokens).toBe(8192); // parsed stream retry
    expect('stream' in bodyOf(2)).toBe(false);
    expect(bodyOf(2).max_tokens).toBe(8192); // learned cap, guardrail NOT re-applied
    expect(result.text).toBe('降级成功');
  });

  it('first-event timeout: 2 hanging attempts then ProtocolTimeoutError, never a non-streaming fallback', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse([], { hang: true }, call.init?.signal),
      ]);

      const promise = generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        () => {},
      );
      const assertion = expect(promise).rejects.toBeInstanceOf(ProtocolTimeoutError);

      await vi.advanceTimersByTimeAsync(60_000); // attempt 1 times out, backoff scheduled
      await vi.advanceTimersByTimeAsync(1_000); // backoff released, attempt 2 starts
      await vi.advanceTimersByTimeAsync(60_000); // attempt 2 times out
      await assertion;

      // Exactly the 2 streaming attempts — timeouts must NOT fall back to an
      // unbounded non-streaming call (#50 would come right back).
      expect(captured.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caller abort propagates as AbortError without retry', async () => {
    const controller = new AbortController();
    const chunks = [
      anthEvent('message_start'),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '开头' } }),
    ];
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(chunks, { hang: true }, call.init?.signal),
    ]);
    setTimeout(() => controller.abort(), 10);

    const err = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      { signal: controller.signal },
      () => {},
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect((err as Error).name).toBe('AbortError');
    expect(captured.length).toBe(1);
  });

  // 09-12 system stabilization C 批（W_c1）：stream 路径与非流式同源
  // buildAnthropicBody——断点形态随流式载荷（{...body, stream:true}）同样携带；
  // flag 缺省时流式 body 同样字节不变。
  it('cacheControl：缺省流式 body 不变 / 置位 → system 数组块 + 对话尾断点随流式载荷携带', async () => {
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
      (call) => sseResponse(ANTHROPIC_HAPPY, {}, call.init?.signal),
    ]);

    await generateTextStream(
      anthropicModel(),
      {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'system', content: 'You are concise.' }, { role: 'user', content: 'hi' }],
      },
      undefined,
      () => {},
    );
    expect(typeof bodyOf(0).system).toBe('string');
    expect(bodyOf(0).messages).toEqual([{ role: 'user', content: 'hi' }]);

    await generateTextStream(
      anthropicModel(),
      {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'system', content: 'You are concise.' }, { role: 'user', content: 'hi' }],
        cacheControl: true,
      },
      undefined,
      () => {},
    );
    const flagged = bodyOf(1);
    expect(flagged.stream).toBe(true);
    expect(flagged.system).toEqual([
      { type: 'text', text: 'You are concise.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(flagged.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
    ]);
  });

  // C 批 CR P10：流式三桶 usage——message_start 的 message.usage 是官方 cache 桶协议位
  // （message_delta.usage 只承诺累计 output_tokens，输入侧不读）；promptTokens 三桶求和
  // 与非流式路径同源，cacheReadTokens 透出（ABSENT ≠ 0 纪律）。
  it('C 批 CR P10：流式三桶 usage——promptTokens=input+read+creation + cacheReadTokens 透出', async () => {
    const chunks = [
      anthEvent('message_start', { message: { usage: { input_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } }),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '好' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
      anthEvent('message_stop'),
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    const result = await generateTextStream(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(result.usage).toEqual({ promptTokens: 350, completionTokens: 7, cacheReadTokens: 100, totalTokens: 357 });
  });
});

// ── OpenAI-compatible streaming path ──

function openaiChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o',
    ...payload,
  })}\n\n`;
}

const OPENAI_DONE = 'data: [DONE]\n\n';

describe('generateTextStream (openai-compatible)', () => {
  let captured: CapturedCall[];
  let deltas: GenerationDelta[];

  beforeEach(() => {
    captured = [];
    deltas = [];
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function bodyOf(index: number): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  it('streams text deltas and maps the terminal frame', async () => {
    const chunks = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: null }] }),
      openaiChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      }),
      OPENAI_DONE,
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    const result = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(captured[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(bodyOf(0).stream).toBe(true);
    expect(bodyOf(0).max_tokens).toBe(32768); // D2 guardrail on the OpenAI path too

    expect(deltas).toEqual([
      { type: 'text', delta: 'He' },
      { type: 'text', delta: 'llo' },
    ]);
    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage?.totalTokens).toBe(8);
  });

  // CR-T1-038 (residual belt): abort-shaped transport death after content
  // deltas must carry the accumulations — not a bare first-delta
  // ProtocolTimeoutError that discards the streamed prefix.
  it('wraps a post-content abort-like stream death with accumulations (openai)', async () => {
    const externalAbort = new Error('connection reset');
    externalAbort.name = 'AbortError';
    const chunks = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: null }] }),
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, { error: externalAbort }, call.init?.signal)]);

    const err = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StreamInterruptedError);
    expect((err as StreamInterruptedError).accumulatedText).toBe('Hello');
    expect(err).not.toBeInstanceOf(ProtocolTimeoutError);
    expect(captured.length).toBe(1); // content was streamed: no quick retry, no degradation
  });

  it('extracts <think> reasoning into reasoning deltas and the aggregated field', async () => {
    const chunks = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '<think>planning</think>' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      OPENAI_DONE,
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    const result = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(result.text).toBe('answer');
    expect(result.reasoning).toBe('planning');
    expect(deltas.some((d) => d.type === 'reasoning' && d.delta === 'planning')).toBe(true);
    expect(deltas.some((d) => d.type === 'text' && d.delta === 'answer')).toBe(true);
  });

  it('aggregates streamed tool_calls without leaking argument deltas', async () => {
    const chunks = [
      openaiChunk({
        choices: [{
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'query_story', arguments: '' } }] },
          finish_reason: null,
        }],
      }),
      openaiChunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"' } }] }, finish_reason: null }],
      }),
      openaiChunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '伏笔"}' } }] }, finish_reason: null }],
      }),
      openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      OPENAI_DONE,
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    const result = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual([
      // R2 #30：工具参数流外发 tool 通道活性信号（半流 JSON 仍不进终帧聚合，但 UI
      // 指示需要它——旧「tool JSON never streams」的静默窗即 UI 死寂根因）。
      { type: 'tool', delta: '', toolName: 'query_story' },
      { type: 'tool', delta: '{"query":"' },
      { type: 'tool', delta: '伏笔"}' },
    ]);
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'query_story', arguments: '{"query":"伏笔"}' },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('wraps mid-stream death into StreamInterruptedError carrying accumulated text', async () => {
    // Several deltas before the death: the SDK pipeline may drop the final
    // in-flight part on abrupt stream errors, so the assertion is on class +
    // non-empty accumulation rather than an exact tail.
    const chunks = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] }),
    ];
    globalThis.fetch = queuedFetch(captured, [
      (call) => sseResponse(chunks, { error: new TypeError('fetch failed: socket hang up') }, call.init?.signal),
    ]);

    const err = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StreamInterruptedError);
    expect((err as StreamInterruptedError).accumulatedText.length).toBeGreaterThan(0);
    expect(captured.length).toBe(1); // mid-stream: no retry, no fallback
  });

  it('maxRetries 0: stream 500 → CR-T1-007 quick retry → single degradation → exactly 3 calls', async () => {
    // CR-T1-007 updated semantics: the pre-delta 500 now gets ONE self-managed
    // streaming quick retry (mirroring the Anthropic path), then the single
    // non-streaming degradation. The degraded call itself does NOT withRetry
    // (skipQuickRetry — no double retry), so: stream, stream, non-stream = 3.
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('internal error'), 500),
      () => jsonResponse(errorBody('internal error'), 500),
      () => jsonResponse(errorBody('internal error'), 500),
    ]);

    await expect(
      generateTextStream(
        openaiModel(),
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 500 });

    // Call 1 = streaming (SDK would have retried internally pre-D2), call 2 =
    // the CR-T1-007 connection-window quick retry, call 3 = the single
    // non-streaming degradation — nothing beyond that.
    expect(captured.length).toBe(3);
    expect(bodyOf(0).stream).toBe(true);
    expect(bodyOf(1).stream).toBe(true);
    expect('stream' in bodyOf(2)).toBe(false);
  });

  // CR-T1-001: 200+headers with no content delta must not hang forever — the
  // watchdog owns the pre-content window at the consumption-loop layer (the
  // fetch-level connect timeout only covers headers). A role-only chunk
  // proves bytes flow WITHOUT proving content: the timer must keep running.
  it('first-delta watchdog: 2 attempts of headers+role-chunk-then-silence time out, never degrade', async () => {
    vi.useFakeTimers();
    try {
      const roleOnlyThenSilence = [
        openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
      ];
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse(roleOnlyThenSilence, { hang: true }, call.init?.signal),
      ]);

      const promise = generateTextStream(
        openaiModel(),
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        () => {},
      );
      const assertion = expect(promise).rejects.toBeInstanceOf(ProtocolTimeoutError);

      await vi.advanceTimersByTimeAsync(60_000); // attempt 1 watchdog fires, backoff scheduled
      await vi.advanceTimersByTimeAsync(1_000); // backoff released, attempt 2 starts
      await vi.advanceTimersByTimeAsync(60_000); // attempt 2 watchdog fires
      await assertion;

      // Exactly the 2 streaming attempts — timeouts never degrade to an
      // unbounded non-streaming call (#50 would come right back).
      expect(captured.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // CR-T1-005: consumer-side exceptions surface as-is on the OpenAI path too.
  it('propagates an onDelta callback error as-is, unwrapped (openai)', async () => {
    const boom = new Error('renderer bridge gone');
    const chunks = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      OPENAI_DONE,
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    const err = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => { throw boom; },
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(StreamInterruptedError);
  });

  it('guardrail compat: a 4xx mentioning max_tokens retries the stream once without cap', async () => {
    const happy = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      OPENAI_DONE,
    ];
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens must be less than or equal to 8192'), 400),
      (call) => sseResponse(happy, {}, call.init?.signal),
    ]);

    const result = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(2);
    expect(bodyOf(0).max_tokens).toBe(32768);
    expect(bodyOf(1).max_tokens).toBeUndefined(); // cap stripped on the retry
    expect(result.text).toBe('ok');
  });

  // CR-T1-008: the cap disposition the streaming layer learned (guardrail
  // rejected → cap stripped) rides along to the degraded non-streaming call —
  // re-deriving the 32K guardrail there would re-trip the same rejection.
  it('degradation inherits the stripped cap learned by the stream attempts', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens must be less than or equal to 8192'), 400),
      () => jsonResponse(errorBody('stream is not supported'), 400),
      () => jsonResponse(
        { choices: [{ index: 0, message: { role: 'assistant', content: '降级成功' }, finish_reason: 'stop' }] },
        200,
      ),
    ]);

    const result = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );

    expect(captured.length).toBe(3);
    expect(bodyOf(1).max_tokens).toBeUndefined(); // stripped stream retry
    expect('stream' in bodyOf(2)).toBe(false); // degraded non-streaming call
    expect(bodyOf(2).max_tokens).toBeUndefined(); // learned "uncapped", guardrail NOT re-applied
    expect(result.text).toBe('降级成功');
  });

  // CR-T1-007: the degraded non-streaming call skips its own withRetry —
  // exactly one attempt after the streaming layer already quick-retried.
  it('degradation does not stack a second retry loop on the non-streaming call', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('stream is not supported'), 400),
      () => jsonResponse(errorBody('internal error'), 500),
    ]);

    await expect(
      generateTextStream(
        openaiModel(),
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 500 });

    expect(captured.length).toBe(2); // stream attempt + single degraded attempt (no withRetry)
  });

  it('degrades to non-streaming when the endpoint rejects streaming', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('stream is not supported'), 400),
      () => jsonResponse(
        { choices: [{ index: 0, message: { role: 'assistant', content: '降级成功' }, finish_reason: 'stop' }] },
        200,
      ),
    ]);

    const result = await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      (d) => deltas.push(d),
    );

    expect(captured.length).toBe(2);
    expect('stream' in bodyOf(1)).toBe(false);
    expect(result.text).toBe('降级成功');
    expect(deltas).toEqual([]);
  });
});

// ── maxTokens guardrail (non-streaming generateText) ──

describe('maxTokens guardrail (generateText)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  function bodyOf(index: number): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  it('anthropic: 4xx max_tokens rejection degrades once to the parsed ceiling (8192), not the fixed 16384', async () => {
    // CR-T1-009: the message names the endpoint's real ceiling — parse it.
    // A fixed 16384 would fail again on endpoints whose ceiling is lower.
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens must be less than or equal to 8192'), 400),
      () => jsonResponse(
        { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
        200,
      ),
    ]);

    const result = await generateText(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(captured.length).toBe(2);
    expect(bodyOf(0).max_tokens).toBe(32768);
    expect(bodyOf(1).max_tokens).toBe(8192);
    expect(result.text).toBe('ok');
  });

  it('anthropic: an unparseable max_tokens rejection degrades once to the fixed 16384', async () => {
    // CR-T1-009: no ceiling in the message → pre-guardrail default.
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens exceeds the maximum allowed for this model'), 400),
      () => jsonResponse(
        { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
        200,
      ),
    ]);

    const result = await generateText(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(captured.length).toBe(2);
    expect(bodyOf(1).max_tokens).toBe(16384);
    expect(result.text).toBe('ok');
  });

  // CR-T1-007: non-streaming consumers (summarizer / chain JSON nodes /
  // renderer direct calls) regain fail-fast retry after maxRetries went 0.
  it('openai non-streaming: a retryable 500 is retried once by withRetry', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('internal error'), 500),
      () => jsonResponse(
        { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
        200,
      ),
    ]);

    const result = await generateText(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(captured.length).toBe(2);
    expect(result.text).toBe('ok');
  });

  it('openai non-streaming: a non-retryable 401 is not retried', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('bad key'), 401),
    ]);

    await expect(
      generateText(
        openaiModel(),
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      ),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 401 });
    expect(captured.length).toBe(1);
  });

  // CR-T1-006: the non-streaming path extracts <think> reasoning just like
  // the streaming path — degradation must not change the output contract.
  it('openai non-streaming: <think> reasoning is split out of the text', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(
        { choices: [{ index: 0, message: { role: 'assistant', content: '<think>planning</think>answer' }, finish_reason: 'stop' }] },
        200,
      ),
    ]);

    const result = await generateText(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(result.text).toBe('answer');
    expect(result.reasoning).toBe('planning');
  });

  // CR-T1-006: the non-streaming Anthropic path maps thinking blocks to
  // reasoning, mirroring generateAnthropicTextStream.
  it('anthropic non-streaming: thinking blocks map to reasoning, text stays clean', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(
        {
          content: [
            { type: 'thinking', thinking: '推理' },
            { type: 'text', text: '答案' },
          ],
          stop_reason: 'end_turn',
        },
        200,
      ),
    ]);

    const result = await generateText(
      anthropicModel(),
      { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(result.text).toBe('答案');
    expect(result.reasoning).toBe('推理');
  });

  it('openai: 4xx max_tokens rejection retries once with the cap removed', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens must be less than or equal to 8192'), 400),
      () => jsonResponse(
        { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
        200,
      ),
    ]);

    const result = await generateText(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(captured.length).toBe(2);
    expect(bodyOf(0).max_tokens).toBe(32768);
    expect(bodyOf(1).max_tokens).toBeUndefined();
    expect(result.text).toBe('ok');
  });

  it('an explicit caller maxTokens is never stripped on degradation', async () => {
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('max_tokens must be less than or equal to 8192'), 400),
    ]);

    await expect(
      generateText(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 },
      ),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 400 });
    expect(captured.length).toBe(1); // explicit cap → no silent strip-retry
    expect(bodyOf(0).max_tokens).toBe(256);
  });
});

// ── retry.ts defaults (D2) ──

describe('withRetry defaults (D2 fail-fast)', () => {
  it('retries retryable failures at most twice by default', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      throw new ProtocolHttpError('overloaded', 503, undefined);
    });
    await expect(withRetry(fn)).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(2);
  });

  it('does not retry non-retryable failures', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      throw new ProtocolHttpError('bad key', 401, undefined);
    });
    await expect(withRetry(fn)).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });
});

// ── Dispatch-lane windows (dogfood R2 #7) ──
//
// Background lanes (child agents / chapter chains on top-spec thinking) get a
// 240s first-event window + EXACTLY ONE bounded non-streaming fallback
// (600s cap) after both streaming attempts time out; interactive lanes
// (absent lane, or explicit 'dialogue') keep the T1 D2 red line verbatim —
// timeout throws, never degrades (#50 would come right back).

describe('generateTextStream lane windows (dogfood R2 #7, anthropic-compatible)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  function bodyOf(index: number): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  it('background lane: window is 240s (still 1 attempt at 61s) → after 2 timeouts ONE bounded non-streaming fallback succeeds', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        () => jsonResponse(
          {
            type: 'message',
            model: 'claude-3-5-sonnet-latest',
            content: [{ type: 'text', text: '回退成功' }],
            stop_reason: 'end_turn',
          },
          200,
        ),
      ]);

      const promise = generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        { lane: 'background' },
        () => {},
      );

      // 60s (the interactive window) elapses + the retry backoff slot — the
      // background watchdog has NOT fired: still inside attempt 1.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(captured.length).toBe(1);

      // Rest of the 240s window → attempt 1 times out → quick retry → attempt 2
      // → times out → the ONE bounded non-streaming fallback.
      await vi.advanceTimersByTimeAsync(240_000 - 61_000); // attempt 1 watchdog fires at t=240s
      await vi.advanceTimersByTimeAsync(1_000); // backoff released, attempt 2 starts
      await vi.advanceTimersByTimeAsync(240_000); // attempt 2 watchdog fires
      const result = await promise;

      expect(captured.length).toBe(3); // exactly 2 streaming attempts + 1 fallback — never more
      expect('stream' in bodyOf(2)).toBe(false); // fallback went through non-streaming postJson
      expect(result.text).toBe('回退成功');
    } finally {
      vi.useRealTimers();
    }
  });

  it('background lane: fallback failure rethrows the ORIGINAL timeout (preserve order), no second fallback attempt', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        () => jsonResponse(errorBody('internal error'), 500),
      ]);

      const promise = generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        { lane: 'background' },
        () => {},
      );
      const assertion = expect(promise).rejects.toBeInstanceOf(ProtocolTimeoutError);

      await vi.advanceTimersByTimeAsync(240_000); // attempt 1 timeout
      await vi.advanceTimersByTimeAsync(1_000); // backoff
      await vi.advanceTimersByTimeAsync(240_000); // attempt 2 timeout → fallback fires → 500
      await assertion;

      // 2 streaming attempts + the single failed fallback (no withRetry stacking
      // — skipQuickRetry) — and the surfaced error is the timeout, not the 500.
      expect(captured.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // CR-33 (dogfood R2): the bounded fallback's bare catch used to flatten
  // EVERY failure into the original ProtocolTimeoutError — user aborts and
  // context-overflow 400s included. Both classifications must survive the
  // fallback (abort stays an abort; overflow keeps its CONTEXT_OVERFLOW
  // marker for the hardCut compaction retry chain).
  it('background fallback: a user abort DURING the fallback stays an abort, never the flattened timeout (CR-33)', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        (call) => hangingJsonResponse(call.init?.signal), // fallback pending forever
      ]);

      const promise = generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        { lane: 'background', signal: controller.signal },
        () => {},
      );
      const errPromise = promise.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );

      await vi.advanceTimersByTimeAsync(240_000); // attempt 1 timeout
      await vi.advanceTimersByTimeAsync(1_000); // backoff → attempt 2
      await vi.advanceTimersByTimeAsync(240_000); // attempt 2 timeout → fallback in flight
      expect(captured.length).toBe(3);
      controller.abort(); // user cancels while the non-streaming fallback is pending

      const err = await errPromise;
      expect((err as Error).name).toBe('AbortError');
      expect(err).not.toBeInstanceOf(ProtocolTimeoutError);
      expect(captured.length).toBe(3); // no retry past the single fallback
    } finally {
      vi.useRealTimers();
    }
  });

  it('background fallback: a context-overflow 400 DURING the fallback keeps the CONTEXT_OVERFLOW marker (CR-33)', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        (call) => sseResponse([], { hang: true }, call.init?.signal),
        () => jsonResponse(
          errorBody("This model's maximum context length is 65536 tokens. However, your messages resulted in 90000 tokens"),
          400,
        ),
      ]);

      const promise = generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        { lane: 'background' },
        () => {},
      );
      const errPromise = promise.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );

      await vi.advanceTimersByTimeAsync(240_000); // attempt 1 timeout
      await vi.advanceTimersByTimeAsync(1_000); // backoff → attempt 2
      await vi.advanceTimersByTimeAsync(240_000); // attempt 2 timeout → fallback → 400 overflow

      const err = await errPromise;
      expect(err).toBeInstanceOf(ProtocolContextOverflowError);
      expect((err as ProtocolContextOverflowError).code).toBe('CONTEXT_OVERFLOW');
      expect(err).not.toBeInstanceOf(ProtocolTimeoutError);
      expect(captured.length).toBe(3); // exactly 2 streams + the one fallback
    } finally {
      vi.useRealTimers();
    }
  });

  it('interactive red line: explicit lane "dialogue" keeps the 60s window and NEVER falls back (2 attempts then throw)', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse([], { hang: true }, call.init?.signal),
      ]);

      const promise = generateTextStream(
        anthropicModel(),
        { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        { lane: 'dialogue' },
        () => {},
      );
      const assertion = expect(promise).rejects.toBeInstanceOf(ProtocolTimeoutError);

      await vi.advanceTimersByTimeAsync(60_000); // attempt 1 times out at the interactive window
      expect(captured.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000); // backoff released, attempt 2 starts
      await vi.advanceTimersByTimeAsync(60_000); // attempt 2 times out
      await assertion;

      // Exactly the 2 streaming attempts — an explicit dialogue lane gets no
      // fallback (byte-identical to the absent-lane behavior above).
      expect(captured.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('generateTextStream lane windows (dogfood R2 #7, openai-compatible)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  function bodyOf(index: number): Record<string, unknown> {
    return JSON.parse((captured[index]?.init?.body as string) ?? '{}');
  }

  it('background lane: headers+role-chunk-then-silence survives past 60s, then the bounded fallback serves the terminal frame', async () => {
    vi.useFakeTimers();
    try {
      const roleOnlyThenSilence = [
        openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
      ];
      globalThis.fetch = queuedFetch(captured, [
        (call) => sseResponse(roleOnlyThenSilence, { hang: true }, call.init?.signal),
        (call) => sseResponse(roleOnlyThenSilence, { hang: true }, call.init?.signal),
        () => jsonResponse(
          { choices: [{ index: 0, message: { role: 'assistant', content: '回退成功' }, finish_reason: 'stop' }] },
          200,
        ),
      ]);

      const promise = generateTextStream(
        openaiModel(),
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        { lane: 'background' },
        () => {},
      );

      // The interactive watchdog would have fired here and moved to retry #2.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(captured.length).toBe(1);

      await vi.advanceTimersByTimeAsync(240_000 - 61_000); // attempt 1 watchdog at t=240s
      await vi.advanceTimersByTimeAsync(1_000); // backoff → attempt 2
      await vi.advanceTimersByTimeAsync(240_000); // attempt 2 watchdog → bounded fallback
      const result = await promise;

      expect(captured.length).toBe(3);
      expect('stream' in bodyOf(2)).toBe(false); // non-streaming fallback shape
      expect(bodyOf(2).max_tokens).toBe(32768); // degraded cap clamped to the 32K guardrail
      expect(result.text).toBe('回退成功');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Instrumentation log hygiene (dogfood R2 CR-36) ──
//
// The failure-path warn used to dump the FULL request body (system + every
// message + tool schemas, untruncated) on every retry; the per-request info
// logs were production-always-on and carried the endpoint baseUrl. Now: the
// warn's request dump is bounded (2000-char fields, first 2 messages + an
// omitted marker, tool names only), the info logs sit behind
// ORISON_PROTOCOL_DEBUG, and endpoint domains never enter a log line.

describe('stream attempt instrumentation hygiene (dogfood R2 CR-36)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('failure warn: request dump is bounded (2 messages + omitted, 2000-char fields, tool names) and carries no endpoint', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // upstream-error path redacts the origin too
    const long = 'x'.repeat(3_000);
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse(errorBody('internal error'), 500),
      () => jsonResponse(errorBody('internal error'), 500),
      () => jsonResponse(errorBody('internal error'), 500),
    ]);

    await expect(
      generateTextStream(
        openaiModel(),
        {
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: `sys-${long}` },
            { role: 'user', content: `u1-${long}` },
            { role: 'user', content: 'u2-second' },
            { role: 'user', content: 'u3-third' },
          ],
          tools: [{
            type: 'function',
            function: { name: 'query_story', description: 'd'.repeat(3_000), parameters: { type: 'object' } },
          }],
        },
        undefined,
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 500 });

    const dumpCall = warnSpy.mock.calls.find((c) => String(c[0]).includes('stream attempt failed'));
    expect(dumpCall).toBeDefined();
    const dumpRaw = String(dumpCall![1]);
    const dump = JSON.parse(dumpRaw) as {
      baseUrl?: unknown;
      request: { system?: string; messages: Array<{ content: string } & Record<string, unknown>>; tools?: unknown };
    };

    // Endpoint identity never enters the log (#10 direction: domain redaction)
    expect(dumpRaw).not.toContain('api.openai.com');
    expect(dump.baseUrl).toBeUndefined();

    // System prompt truncated to the field cap (2000 + truncation marker)
    expect(dump.request.system!.length).toBeGreaterThan(2_000);
    expect(dump.request.system!.length).toBeLessThanOrEqual(2_100);

    // Messages: system hoisted by the SDK → 3 ModelMessages → first 2 kept + omitted marker
    expect(dump.request.messages).toHaveLength(3);
    expect(dump.request.messages[2]).toEqual({ omitted: 1 });
    for (const m of dump.request.messages.slice(0, 2)) {
      expect(m.content.length).toBeGreaterThan(0);
      expect(m.content.length).toBeLessThanOrEqual(2_100);
    }

    // Tools summarized to names — descriptions/schemas never enter the log
    expect(dump.request.tools).toEqual(['query_story']);
    expect(dumpRaw).not.toContain('d'.repeat(50));
    expect(dumpRaw).not.toContain('u3-third'); // dropped message content stays out entirely

    // CR-36 (#10 direction): the upstream-error log keeps the request path but
    // never the endpoint domain
    const upstreamCall = errorSpy.mock.calls.find((c) => String(c[0]).includes('upstream error'));
    expect(upstreamCall).toBeDefined();
    expect(JSON.stringify(upstreamCall![1])).not.toContain('api.openai.com');
    expect(String((upstreamCall![1] as { path?: string }).path)).toBe('/v1/chat/completions');
  });

  it('per-request info logs: silent by default, ORISON_PROTOCOL_DEBUG-gated without baseUrl when enabled', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const chunks = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }),
      openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      OPENAI_DONE,
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, {}, call.init?.signal)]);

    vi.stubEnv('ORISON_PROTOCOL_DEBUG', ''); // hermetic: explicitly off for the first call
    await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    expect(infoSpy).not.toHaveBeenCalled(); // production default: no per-request noise

    vi.stubEnv('ORISON_PROTOCOL_DEBUG', '1');
    await generateTextStream(
      openaiModel(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    expect(captured.length).toBe(2); // both calls served

    const requestLog = infoSpy.mock.calls.find((c) => String(c[0]).includes('stream request'));
    expect(requestLog).toBeDefined();
    const requestRaw = String(requestLog![1]);
    const parsed = JSON.parse(requestRaw) as { baseUrl?: string; model?: string };
    expect('baseUrl' in parsed).toBe(false); // endpoint domain redacted
    expect(requestRaw).not.toContain('api.openai.com');
    expect(parsed.model).toBe('gpt-4o');

    const doneLog = infoSpy.mock.calls.find((c) => String(c[0]).includes('stream done'));
    expect(doneLog).toBeDefined(); // the done summary joins the same debug gate
  });
});
