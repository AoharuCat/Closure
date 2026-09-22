import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
// Direct module import (not the barrel) pins the errors→generate import cycle
// in its errors-first load order — the other order is exercised by every
// barrel-importing suite.
import {
  classifyGenerationFailure,
  CircuitOpenError,
  FallbackChainExhaustedError,
  ProtocolCapabilityError,
  ProtocolContextOverflowError,
  ProtocolHttpError,
  ProtocolNotImplementedError,
  ProtocolSchemaError,
  ProtocolTimeoutError,
  StreamInterruptedError,
} from '../src/errors';
import { generateTextStream } from '../src';
import { classifyCliError } from '../src/antigravityCli/driver';

// ── 09-12 子2 W2：classifyGenerationFailure 分类矩阵（design §3 表逐行）──
//
// 原则：per-model 失败（换模型可能好）→ eligible；request 内禀失败（换谁都得死）
// → 直抛。形态无感知——agy 终态已被子1 §3.7 映射到同一错误族，跨形态判据天然统一。

describe('classifyGenerationFailure (fallback chain, design §3)', () => {
  // ── 可回退行 ──

  it('auth: ProtocolHttpError 401/403 → eligible', () => {
    expect(classifyGenerationFailure(new ProtocolHttpError('Invalid API key', 401)))
      .toMatchObject({ eligible: true, kind: 'auth' });
    expect(classifyGenerationFailure(new ProtocolHttpError('Forbidden', 403)))
      .toMatchObject({ eligible: true, kind: 'auth' });
  });

  it('auth: CLI 车道认证错误（classifyCliError 产出）→ eligible（跨形态判据统一）', () => {
    // 空响应守卫文案 + stderr 认证信号 → 401 认证错误——链上换模型照常可行。
    const err = classifyCliError(
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
      'error: authentication failed or timed out',
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect(classifyGenerationFailure(err)).toMatchObject({ eligible: true, kind: 'auth' });
  });

  it('other: CLI 内置工具 headless 自动拒（classifyCliError 产出）→ ineligible（形态内禀，链不烧）', () => {
    // 内置工具在无头形态拿不到授权，换模型大概率同死——指令修复才是出路，不烧链。
    const err = classifyCliError(
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(412);
    expect(classifyGenerationFailure(err)).toMatchObject({ eligible: false, kind: 'other' });
  });

  it('other: CLI MCP 预授权软拒（classifyCliError 产出）→ ineligible（会话授权事实，链不烧）', () => {
    // MCP 主体软拒与模型无关（同一条桥、同一套预授权，换模型撞同一堵墙——烧链纯浪费）
    // → 与内置工具行同用合成 412 落 other/eligible=false；文案指向预授权出路（F9 反向的
    // 独立分支，与内置工具行各说各话）。
    const err = classifyCliError(
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
      'jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.',
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(412);
    expect((err as ProtocolHttpError).message).toContain('pre-authorization');
    expect((err as ProtocolHttpError).message).not.toContain('built-in agy tool');
    expect(classifyGenerationFailure(err)).toMatchObject({ eligible: false, kind: 'other' });
  });

  it('quota: ProtocolHttpError 429/402 → eligible', () => {
    expect(classifyGenerationFailure(new ProtocolHttpError('rate limited', 429)))
      .toMatchObject({ eligible: true, kind: 'quota' });
    expect(classifyGenerationFailure(new ProtocolHttpError('payment required', 402)))
      .toMatchObject({ eligible: true, kind: 'quota' });
  });

  it('timeout: ProtocolTimeoutError + HTTP 408 + cause-chain wrapped timeout → eligible', () => {
    expect(classifyGenerationFailure(new ProtocolTimeoutError('No stream event received within 60000ms')))
      .toMatchObject({ eligible: true, kind: 'timeout' });
    expect(classifyGenerationFailure(new ProtocolHttpError('Request timeout', 408)))
      .toMatchObject({ eligible: true, kind: 'timeout' });
    // The AI SDK wraps the fetch abort reason (our connect-timeout error) —
    // findTimeoutError must still locate it in the cause chain.
    const inner = new ProtocolTimeoutError('No response within 60000ms (streaming connect timeout)');
    const wrapped = new Error('API call failed');
    (wrapped as Error & { cause?: unknown }).cause = inner;
    expect(classifyGenerationFailure(wrapped)).toMatchObject({ eligible: true, kind: 'timeout' });
  });

  it('server: ProtocolHttpError ≥500 (incl. agy crash mapped to 502) → eligible', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyGenerationFailure(new ProtocolHttpError('upstream error', status)))
        .toMatchObject({ eligible: true, kind: 'server' });
    }
  });

  it('network: fetch TypeError family — direct, cause-chain, and ConnectTimeoutError → eligible', () => {
    expect(classifyGenerationFailure(new TypeError('fetch failed')))
      .toMatchObject({ eligible: true, kind: 'network' });
    // The real syscall code nests inside cause (undici shape) — chain scan hits it.
    const outer = new TypeError('request failed');
    (outer as Error & { cause?: unknown }).cause = new Error('connect ECONNREFUSED 127.0.0.1:443');
    expect(classifyGenerationFailure(outer)).toMatchObject({ eligible: true, kind: 'network' });
    const connectTimeout = new Error('Connect Timeout Error (attempted addresses: 1.2.3.4:443)');
    connectTimeout.name = 'ConnectTimeoutError';
    expect(classifyGenerationFailure(connectTimeout)).toMatchObject({ eligible: true, kind: 'network' });
  });

  // ── 不可回退行（直抛保语义）──

  it('overflow: MARKED ProtocolContextOverflowError → ineligible, marker row wins over 4xx', () => {
    const marked = new ProtocolContextOverflowError(
      "This model's maximum context length is 4096 tokens", 400, 'code: context_length_exceeded');
    expect(classifyGenerationFailure(marked)).toMatchObject({ eligible: false, kind: 'overflow' });
  });

  it('overflow: BARE predicate form (raw 400 whose report matches the family) → ineligible overflow, not other-4xx', () => {
    const bare = new ProtocolHttpError('prompt is too long: 4197 tokens > 4096 maximum', 400);
    expect(classifyGenerationFailure(bare)).toMatchObject({ eligible: false, kind: 'overflow' });
    // A NON-overflow 400 stays on the conservative row (predicate is not greedy).
    expect(classifyGenerationFailure(new ProtocolHttpError('bad request shape', 400)))
      .toMatchObject({ eligible: false, kind: 'other' });
  });

  it('interrupted: StreamInterruptedError (subclass of ProtocolHttpError, default 502) → ineligible, beats the ≥500 row', () => {
    const interrupted = new StreamInterruptedError({
      message: 'OpenAI-compatible stream interrupted: socket hang up',
      accumulatedText: 'partial prose the user already saw',
    });
    expect(classifyGenerationFailure(interrupted)).toMatchObject({ eligible: false, kind: 'interrupted' });
    // Even with an explicit 429 status carried over from the dead stream.
    const withStatus = new StreamInterruptedError({
      message: 'stream interrupted mid-generation',
      accumulatedText: 'x',
      status: 429,
    });
    expect(classifyGenerationFailure(withStatus)).toMatchObject({ eligible: false, kind: 'interrupted' });
  });

  it('abort: AbortError-shaped error → ineligible (user cancellation is not a failure)', () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    expect(classifyGenerationFailure(aborted)).toMatchObject({ eligible: false, kind: 'abort' });
  });

  it('schema: ProtocolSchemaError / ProtocolCapabilityError / ProtocolNotImplementedError → ineligible', () => {
    expect(classifyGenerationFailure(new ProtocolSchemaError('invalid model selection')))
      .toMatchObject({ eligible: false, kind: 'schema' });
    expect(classifyGenerationFailure(new ProtocolCapabilityError('model lacks capability')))
      .toMatchObject({ eligible: false, kind: 'schema' });
    expect(classifyGenerationFailure(new ProtocolNotImplementedError('path not implemented')))
      .toMatchObject({ eligible: false, kind: 'schema' });
  });

  it('circuit-open: CircuitOpenError → ineligible（C3.2 W1：网关自判的本地拒呼，链不烧、消息带剩余冷却秒）', () => {
    const err = new CircuitOpenError('key_a', 'gpt-4o-mini', 42_300);
    expect(err.name).toBe('CircuitOpenError');
    expect(err.message).toContain('[key_a/gpt-4o-mini]');
    expect(err.message).toContain('43s left'); // Math.ceil(42.3) — 面向人的向上取整
    expect(classifyGenerationFailure(err)).toMatchObject({ eligible: false, kind: 'circuit-open' });
    // 即便剩余冷却读作整数秒的形态也同归类。
    expect(classifyGenerationFailure(new CircuitOpenError('k', 'm', 60_000)))
      .toMatchObject({ eligible: false, kind: 'circuit-open' });
  });

  it('program row: an onDelta consumer throw survives the streaming catch chain tagged → ineligible program', async () => {
    // Drives the REAL Anthropic streaming path (hand-written SSE — no AI SDK in
    // the loop): the first text delta invokes onDelta, whose consumer throws;
    // invokeOnDelta tags the error (WeakSet) and every wrapping catch rethrows
    // it AS-IS. The classifier must read the tag — a UI-side crash is never a
    // fallback-eligible stream failure.
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    ].join('\n\n') + '\n\n';
    globalThis.fetch = vi.fn(async () =>
      new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ) as unknown as typeof fetch;

    const model: ResolvedModel = {
      keyId: 'k',
      modelId: 'claude-sonnet-5',
      protocol: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test',
      capability: 'text',
    };
    const consumerError = new TypeError('webContents already destroyed');
    let caught: unknown;
    try {
      await generateTextStream(
        model,
        { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        () => { throw consumerError; },
      );
    } catch (err) {
      caught = err;
    }
    // CR-T1-005: rethrown as-is — identity equality proves no wrapping happened.
    expect(caught).toBe(consumerError);
    expect(classifyGenerationFailure(caught)).toMatchObject({ eligible: false, kind: 'program' });
  });

  it('other: unknown errors are conservatively ineligible (never burn the chain on a guess)', () => {
    expect(classifyGenerationFailure(new Error('boom')))
      .toMatchObject({ eligible: false, kind: 'other' });
    expect(classifyGenerationFailure('a thrown string'))
      .toMatchObject({ eligible: false, kind: 'other' });
    // The exhausted-chain error itself re-entering classification stays terminal
    // (loop safety: it is an unknown Error, never fallback-eligible).
    const exhausted = new FallbackChainExhaustedError([
      { keyId: 'k1', modelId: 'm1', reason: 'quota: HTTP 429: rate limited' },
    ]);
    expect(classifyGenerationFailure(exhausted)).toMatchObject({ eligible: false, kind: 'other' });
  });

  // ── reason 摘要格式 ──

  it('reason summary format: kind + HTTP status + message; long messages cap', () => {
    const quota = classifyGenerationFailure(new ProtocolHttpError('rate limited', 429));
    expect(quota.reason).toBe('quota: HTTP 429: rate limited');

    const timeout = classifyGenerationFailure(new ProtocolTimeoutError('No stream event received within 240000ms'));
    expect(timeout.reason).toBe('timeout: No stream event received within 240000ms');

    const longMessage = 'x'.repeat(1000);
    const capped = classifyGenerationFailure(new Error(longMessage));
    expect(capped.reason.startsWith('other: ')).toBe(true);
    expect(capped.reason).toContain(`…(+${1000 - 300} chars)`);
    expect(capped.reason.length).toBeLessThan(400);
  });
});

describe('FallbackChainExhaustedError (design §4)', () => {
  it('aggregates per-model failure summaries into the message; attempts stay structured', () => {
    const attempts = [
      { keyId: 'k1', modelId: 'm1', reason: 'quota: HTTP 429: rate limited' },
      { keyId: 'k2', modelId: 'm2', reason: 'timeout: no first event' },
    ];
    const err = new FallbackChainExhaustedError(attempts);
    expect(err.name).toBe('FallbackChainExhaustedError');
    expect(err.attempts).toEqual(attempts);
    expect(err.message).toBe(
      'Fallback chain exhausted: [k1/m1] quota: HTTP 429: rate limited; [k2/m2] timeout: no first event',
    );
  });

  it('empty attempts still produce a readable message (defensive)', () => {
    expect(new FallbackChainExhaustedError([]).message).toBe('Fallback chain exhausted: no attempt records');
  });
});
