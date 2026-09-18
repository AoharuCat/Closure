import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import {
  generateText,
  generateTextStream,
  ProtocolHttpError,
  setAntigravityCliGenerateForTest,
  setGenerationUsageSink,
} from '../src';
import type { AntigravityCliGenerateFn, GenerationCallRecord, GenerationDelta } from '../src';

// 09-12 usage-panel W2：两公共入口计量 wrapper 的 sink 触发矩阵（design §9.1）——
// 成功（非流式/流式 firstDelta）/ CLI 早退路径同落行 / CR-18 缺席计数器 ABSENT /
// 失败分类（classifyGenerationFailure 单源）+ 摘要截断 / abort / sink 抛错不阻调用方 /
// 缺省 no-op 回归锚 / 流式内部降级单行性。fetch 桩 + CLI 驱动测试覆写缝
// （setAntigravityCliGenerateForTest）mirror providerParams.test.ts / streaming.test.ts。

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };
type Responder = (call: CapturedCall) => Response;

function openaiModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'totally-unknown-model', // registry-miss：无隐式 limits/kinds 干扰
    protocol: 'openai-compatible',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

function cliModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'agy',
    modelId: 'gemini-3.8-flash-high',
    protocol: 'antigravity-cli',
    baseUrl: '',
    apiKey: '',
    capability: 'text',
    cliExecutable: 'C:/agy/bin/agy.exe',
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

function sseResponse(chunks: string[], signal?: AbortSignal | null): Response {
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
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

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

const OPENAI_COMPLETION = {
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const BASE_REQUEST: TextGenerationRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

describe('generation usage metering wrapper (09-12 usage-panel)', () => {
  const records: GenerationCallRecord[] = [];

  beforeEach(() => {
    records.length = 0;
    setGenerationUsageSink((r) => records.push(r));
  });
  afterEach(() => {
    setGenerationUsageSink(undefined);
    setAntigravityCliGenerateForTest(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('非流式成功：identity/taskType/lane/sessionKey 透传 + usage 映射 + 无 firstDelta', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(OPENAI_COMPLETION));
    await generateText(
      openaiModel(),
      {
        ...BASE_REQUEST,
        taskType: 'writer-draft',
        sessionKey: 'chain:abc1:writer',
      },
      { lane: 'background' },
    );
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect(rec.stream).toBe(false);
    expect(rec.protocol).toBe('openai-compatible');
    expect(rec.keyId).toBe('k1');
    expect(rec.modelId).toBe('totally-unknown-model');
    expect(rec.taskType).toBe('writer-draft');
    expect(rec.lane).toBe('background');
    expect(rec.sessionKey).toBe('chain:abc1:writer');
    expect(rec.inputTokens).toBe(10);
    expect(rec.outputTokens).toBe(5);
    expect(rec.totalTokens).toBe(15);
    expect(rec.errorKind).toBeUndefined();
    expect(rec.errorMessage).toBeUndefined();
    expect(rec.firstDeltaMs).toBeUndefined();
    expect(typeof rec.latencyMs).toBe('number');
    expect(typeof rec.ts).toBe('number');
  });

  it('流式成功：stream=true + first_delta_ms 打点 + 终帧 usage 映射', async () => {
    const captured: CapturedCall[] = [];
    const chunks = [
      openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }] }),
      openaiChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      }),
      OPENAI_DONE,
    ];
    globalThis.fetch = queuedFetch(captured, [(call) => sseResponse(chunks, call.init?.signal)]);
    const deltas: GenerationDelta[] = [];
    const result = await generateTextStream(
      openaiModel(),
      { ...BASE_REQUEST, taskType: 'leader-dialogue' },
      undefined,
      (d) => deltas.push(d),
    );
    expect(result.usage?.totalTokens).toBe(8);
    expect(deltas.length).toBe(1);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect(rec.stream).toBe(true);
    expect(rec.taskType).toBe('leader-dialogue');
    expect(rec.firstDeltaMs).toBeGreaterThanOrEqual(0);
    expect(rec.inputTokens).toBe(3);
    expect(rec.outputTokens).toBe(5);
    expect(rec.totalTokens).toBe(8);
  });

  it('CLI 早退在 wrapper 内（CLI 调用同落行）+ CR-18：缺席计数器 ABSENT 不补 0 不合成', async () => {
    const fake: AntigravityCliGenerateFn = async (_model, _request, _ctx, onDelta) => {
      onDelta?.({ type: 'text', delta: 'ok' });
      // driver mapCliUsage 形态：缺席计数器键 ABSENT（thinking/cache_read 是 driver
      // 唯一来源信号；completion/total 缺席 = provider 未上报）。
      return {
        model: 'gemini-3.8-flash-high',
        text: 'ok',
        finishReason: 'stop',
        usage: { promptTokens: 13105, thinkingTokens: 28, cacheReadTokens: 49043 },
      };
    };
    setAntigravityCliGenerateForTest(fake);
    await generateTextStream(cliModel(), { ...BASE_REQUEST, sessionKey: 'dialogue:s1' }, undefined, () => {});
    await generateText(cliModel(), BASE_REQUEST);
    expect(records).toHaveLength(2);
    const streamRec = records[0]!;
    expect(streamRec.protocol).toBe('antigravity-cli');
    expect(streamRec.keyId).toBe('agy');
    expect(streamRec.sessionKey).toBe('dialogue:s1');
    expect(streamRec.stream).toBe(true);
    expect(streamRec.inputTokens).toBe(13105);
    expect(streamRec.thinkingTokens).toBe(28);
    expect(streamRec.cacheReadTokens).toBe(49043);
    // CR-18：completion/total 缺席 → ABSENT（≠0，亦不由 input+thinking 合成）。
    expect(streamRec.outputTokens).toBeUndefined();
    expect(streamRec.totalTokens).toBeUndefined();
    expect(streamRec.firstDeltaMs).toBeGreaterThanOrEqual(0);
    const nonStreamRec = records[1]!;
    expect(nonStreamRec.stream).toBe(false);
    expect(nonStreamRec.sessionKey).toBeUndefined();
    expect(nonStreamRec.firstDeltaMs).toBeUndefined();
  });

  it('失败行：分类单源（quota）+ 摘要截断 ≤500 + token 恒 ABSENT + 原样重抛', async () => {
    setAntigravityCliGenerateForTest(async () => {
      throw new ProtocolHttpError('q'.repeat(600), 429);
    });
    const err = await generateText(cliModel(), BASE_REQUEST).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolHttpError); // 原样重抛（计量不改错误对象）
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(false);
    expect(rec.errorKind).toBe('quota');
    expect(rec.errorMessage).toBe('q'.repeat(500)); // 600 → 截断到 500
    expect(rec.inputTokens).toBeUndefined();
    expect(rec.totalTokens).toBeUndefined();
  });

  it('失败行：abort 形态照落（用户取消也是一次真实调用）', async () => {
    setAntigravityCliGenerateForTest(async () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    await generateText(cliModel(), BASE_REQUEST).then(
      () => undefined,
      () => undefined,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.errorKind).toBe('abort');
    expect(records[0]!.success).toBe(false);
  });

  it('HTTP 失败路径同落行（401 → auth）', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
    await generateText(openaiModel(), BASE_REQUEST).then(
      () => undefined,
      () => undefined,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.errorKind).toBe('auth');
    expect(typeof records[0]!.errorMessage).toBe('string');
  });

  it('sink 抛错不阻调用方（best-effort：结果照常返回）', async () => {
    setGenerationUsageSink(() => {
      throw new Error('sink boom');
    });
    globalThis.fetch = vi.fn(async () => jsonResponse(OPENAI_COMPLETION));
    const result = await generateText(openaiModel(), BASE_REQUEST);
    expect(result.text).toBe('hello');
  });

  it('缺省 no-op（未装配 sink）——回归锚：两入口行为零变化', async () => {
    setGenerationUsageSink(undefined);
    globalThis.fetch = vi.fn(async () => jsonResponse(OPENAI_COMPLETION));
    const result = await generateText(openaiModel(), BASE_REQUEST);
    expect(result.text).toBe('hello');
    expect(result.usage?.totalTokens).toBe(15);
  });

  it('流式内部降级单行性：降级重发在一条逻辑行内（pre-delta 400 → 非流式成功）', async () => {
    const captured: CapturedCall[] = [];
    globalThis.fetch = queuedFetch(captured, [
      () => jsonResponse({ error: { message: 'stream unsupported' } }, 400), // 流式尝试 pre-delta 失败（400 非重试类）
      () => jsonResponse(OPENAI_COMPLETION), // 降级非流式成功
    ]);
    const result = await generateTextStream(openaiModel(), BASE_REQUEST, undefined, () => {});
    expect(result.text).toBe('hello');
    expect(captured.length).toBe(2); // 流式一次 + 降级非流式一次
    expect(records).toHaveLength(1); // 但计量恰一行
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect(rec.stream).toBe(true); // 入口形态（逻辑调用的入口是流式）
    expect(rec.outputTokens).toBe(5);
    expect(rec.firstDeltaMs).toBeUndefined(); // 降级前无 delta 抵达
  });
});
