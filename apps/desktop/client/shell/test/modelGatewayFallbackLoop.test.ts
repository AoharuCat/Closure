/**
 * 09-12 子2 fallback chains W3：网关层回退环（modelGatewayIpc runFallbackLoop）。
 *
 * mock 面 mirror modelGatewayIpc.test.ts（electron + configIpc 种子配置 + fetch 级 mock）
 * ——本文件钉的是环自身的职责：链推进判据（classifyGenerationFailure 单源消费）、
 * per-attempt 请求从原始载荷重建、图片按目标模型重解（resolveImageParts 调用姿势）、
 * producedDelta 双保险门、响应注记（modelRef 真实身份 + fallbackTrace 二态）、
 * 链尽聚合错误、零默认链快径字节级不变。
 *
 * ⚠️ attempt 内自愈（withRetry 快速重试 / 流式失败回落非流式）跑在环**之下**——每个
 * attempt 的 fetch 次数 > 1 是协议层既有行为（分层：per-model 自愈在内、跨模型环在外）。
 * 本文件断言环语义（B 恰一次成功出站 / trace / 注记），不钉协议层内部次数。
 *
 * 图片重解用例 vi.mock agentImageParts（mirror agentImagePartsGatewayWiring.test.ts 先例）
 * ——mock 面只替 resolveImageParts 一个导出。
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';
import { rmBestEffort } from './rmBestEffort';

const { handle, safeStorage, resolveImagePartsMock } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  resolveImagePartsMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

vi.mock('../main/ipc/agentImageParts', () => ({ resolveImageParts: resolveImagePartsMock }));

import { _setModelConfigDirForTest, registerConfigIpc } from '../main/ipc/configIpc';
import {
  handleGenerateText,
  handleGenerateTextStream,
  _resetAntigravityCliUsedForTest,
} from '../main/ipc/modelGatewayIpc';
import {
  FallbackChainExhaustedError,
  ProtocolContextOverflowError,
  ProtocolHttpError,
  setAntigravityCliGenerateForTest,
} from '@orison/model-protocols';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-gateway-fallback');
const ORIGINAL_FETCH = globalThis.fetch;

/** 双 HTTP 键配置：A/B 各自独立 baseUrl（fetch mock 按 URL 分流）+ 同款 glm 思考模型。 */
const TWO_KEY_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_a',
      name: 'A relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1',
      models: [
        { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
        { id: 'glm-5.3', alias: 'GLM 5.3', capability: 'text', enabled: true },
      ],
    },
    {
      id: 'key_b',
      name: 'B relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1',
      models: [
        { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
        { id: 'glm-5.3', alias: 'GLM 5.3', capability: 'text', enabled: true },
      ],
    },
  ],
};

async function seedConfig(config: ModelConfig = TWO_KEY_CONFIG) {
  registerConfigIpc();
  const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
  await saveCall![1]({}, config);
}

/** OpenAI 兼容非流式成功响应。 */
function openAiTextResponse(text: string): Response {
  const body = JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: new Headers(),
  });
}

/** 按目标 baseUrl 分流的 fetch mock：每 URL 一个响应工厂。 */
function urlRoutingFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [prefix, factory] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return factory();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

describe('gateway fallback loop (09-12 子2 W3) — non-streaming', () => {
  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    // 图片重解默认透传（无图快径语义：同引用返回）——带图用例各自覆写实现。
    resolveImagePartsMock.mockImplementation(async (messages: unknown[]) => messages);
  });

  afterEach(async () => {
    setAntigravityCliGenerateForTest(undefined);
    _resetAntigravityCliUsedForTest();
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    resolveImagePartsMock.mockReset();
    vi.restoreAllMocks();
  });

  it('A 429 → B 成功：B 承接同一请求、响应注记真实身份 + trace、onFallback 收到切换事件', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const switches: Array<{ from: { keyId: string }; to: { keyId: string }; attempt: number; reason: string }> = [];
    const result = await handleGenerateText(
      {
        ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
      },
      undefined,
      (event) => switches.push(event),
    );

    expect(result.text).toBe('from B');
    // 注记：实际使用家 = B 的真实身份（非请求 ref）；trace 单条 429 摘要。
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
    expect(result.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('quota') },
    ]);
    // 切换事件：from=A 解析身份、to=B 条目、1-based attempt、分类 reason。
    expect(switches).toEqual([
      {
        from: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
        to: { keyId: 'key_b', modelId: 'gpt-4o-mini' },
        reason: expect.stringContaining('quota'),
        attempt: 1,
      },
    ]);
    // B 恰一次成功出站（A 侧协议层快速重试次数不在此钉——分层归协议层测试）。
    const bCalls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(
      ([url]) => String(url).startsWith('https://b.example.com'),
    );
    expect(bCalls).toHaveLength(1);
    const bCall = bCalls[0]!;
    expect(bCall[0]).toBe('https://b.example.com/v1/chat/completions');
    expect((bCall[1].headers as Record<string, string>).authorization).toBe('Bearer sk-b');
    // B 的出站 body：同一 messages（原始载荷重建，非 A 的改写产物）。
    expect(JSON.parse(bCall[1].body as string).messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('条目 thinking 覆盖：B 无 thinking → 主指派的 thinking 不渗入 B 的出站 body', async () => {
    await seedConfig();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      const url = String(input);
      if (url.startsWith('https://a.example.com')) return errorResponse(429, 'rate limited');
      return openAiTextResponse('from B');
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'glm-5.3' },
      request: {
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { level: 'high' },
      },
      // B 无 thinking 字段 = auto（design §4「条目 thinking 覆盖，undefined = auto」——非继承）。
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'glm-5.3' } }],
    });

    // A（含协议层快速重试）：主指派 thinking high → glm-forced-effort 注入 reasoning_effort。
    const aBodies = bodies.slice(0, bodies.length - 1);
    expect(aBodies.length).toBeGreaterThan(0);
    for (const body of aBodies) expect(body.reasoning_effort).toBe('high');
    // B（最后一次出站）：条目无 thinking → 不继承 A 的 high（覆盖语义）。
    expect('reasoning_effort' in bodies[bodies.length - 1]!).toBe(false);
  });

  it('A 上下文溢出 → 直抛保标记，不烧链（B 零出站）', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(400, "This model's maximum context length is 8192 tokens. code: context_length_exceeded"),
      'https://b.example.com/v1': () => openAiTextResponse('should not be reached'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const err = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    // 原错误原样上抛（保 CONTEXT_OVERFLOW 标记——runLoop 压缩链是正解，不烧链）。
    expect(err).toBeInstanceOf(ProtocolContextOverflowError);
    expect((err as ProtocolContextOverflowError).code).toBe('CONTEXT_OVERFLOW');
    // B 零出站。
    const bCalls = (fetchMock.mock.calls as unknown as [string][]).filter(([url]) =>
      String(url).startsWith('https://b.example.com'),
    );
    expect(bCalls).toHaveLength(0);
  });

  it('链尽 → FallbackChainExhaustedError 聚合逐家失败摘要', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'quota burned'),
      'https://b.example.com/v1': () => errorResponse(503, 'upstream dead'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const err = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FallbackChainExhaustedError);
    const exhausted = err as FallbackChainExhaustedError;
    expect(exhausted.attempts).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('quota') },
      { keyId: 'key_b', modelId: 'gpt-4o-mini', reason: expect.stringContaining('server') },
    ]);
    // message 聚合逐家摘要（UI 错误卡直出）。
    expect(exhausted.message).toContain('[key_a/gpt-4o-mini]');
    expect(exhausted.message).toContain('[key_b/gpt-4o-mini]');
  });

  it('resolveModel 失败（键删/禁用）→ 记 config 原因继续下家，不整链陪葬', async () => {
    // A 主指派指到已删除的键；B 正常。无链时该错误直抛（既有测试覆盖）；有链时跳家。
    const fetchMock = urlRoutingFetch({
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await seedConfig();

    const result = await handleGenerateText({
      ref: { keyId: 'key_gone', modelId: 'whatever' },
      request: { model: 'whatever', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });

    expect(result.text).toBe('from B');
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
    expect(result.fallbackTrace).toEqual([
      { keyId: 'key_gone', modelId: 'whatever', reason: expect.stringContaining('config:') },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('带图回退：每 attempt 从原始 messages 按目标模型重解（禁上一 attempt 改写产物）', async () => {
    await seedConfig();
    // resolveImageParts：per-resolved 返回不同改写数组（直传 vs 转述形态模拟）——追加的
    // 是合法 GenerationMessage 形态（协议层 zod 校验过路）。
    const seen: Array<{ keyId: string; messageRef: unknown }> = [];
    const originalMessages = [{ role: 'user' as const, content: 'hi' }];
    resolveImagePartsMock.mockImplementation(async (messages: unknown[], resolved: { keyId: string }) => {
      seen.push({ keyId: resolved.keyId, messageRef: messages });
      return [...(messages as unknown[]), { role: 'user', content: `processed-by-${resolved.keyId}` }];
    });
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: originalMessages },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });

    // 两次重解都吃同一原始 messages 引用（A 的 b64/转述改写绝不喂给 B——prd 红线）。
    expect(seen).toEqual([
      { keyId: 'key_a', messageRef: originalMessages },
      { keyId: 'key_b', messageRef: originalMessages },
    ]);
    // B 出站 body 携带按 B 重解的 messages（A 的改写产物不在场）。
    const bCalls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(
      ([url]) => String(url).startsWith('https://b.example.com'),
    );
    expect(bCalls).toHaveLength(1);
    const bBody = JSON.parse(bCalls[0]![1].body as string);
    expect(bBody.messages.map((m: { content: string }) => m.content)).toEqual(['hi', 'processed-by-key_b']);
    expect(result.text).toBe('from B');
  });

  it('非流式 background：A 的 600s ceiling 超时按 timeout 分类推进到 B（per-attempt 各自有界）', async () => {
    await seedConfig();
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://a.example.com')) {
          // 挂死 fetch（mirror modelGatewayIpc.test.ts hangingFetchMock）。
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
        return openAiTextResponse('from B');
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const generating = handleGenerateText({
        ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], lane: 'background' },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
      });

      // A 的 600s 顶到点 → timeout（可回退类）→ 环推进 B。
      await vi.advanceTimersByTimeAsync(601_000);
      const result = await generating;
      expect(result.text).toBe('from B');
      expect(result.fallbackTrace).toEqual([
        { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('timeout') },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('零默认链快径：无 fallbacks → 单次出站、响应零注记（回归锚——字节级现行为）', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => openAiTextResponse('plain'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('plain');
    // 无链 = 环机械零运行：注记键一律缺席（二态纪律）。
    expect('modelRef' in result).toBe(false);
    expect('fallbackTrace' in result).toBe(false);
    // 图片下沉层无图快径：同引用返回，零改写。
    expect(resolveImagePartsMock).toHaveBeenCalledTimes(1);
  });

  it('跨形态链（CLI → HTTP）：A CLI 终态 502 → B HTTP 承接（CLI 形态进链，子2 prd 开放项拍板）', async () => {
    await seedConfig({
      keys: [
        {
          id: 'key_agy',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          apiKey: '',
          cliExecutable: 'C:\\agy\\bin\\agy.exe',
          models: [
            { id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true },
          ],
        },
        ...TWO_KEY_CONFIG.keys.slice(1),
      ],
    });
    // CLI 驱动器 mock：终态 ERROR → 子1 §3.7 映射 ProtocolHttpError 502（server 可回退类）。
    setAntigravityCliGenerateForTest(async () => {
      throw new ProtocolHttpError('agy terminal state ERROR: stream failure', 502);
    });
    const fetchMock = urlRoutingFetch({
      'https://b.example.com/v1': () => openAiTextResponse('from B http'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' },
      request: { model: 'gemini-3.8-pro-high', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });

    expect(result.text).toBe('from B http');
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
    expect(result.fallbackTrace).toEqual([
      { keyId: 'key_agy', modelId: 'gemini-3.8-pro-high', reason: expect.stringContaining('server') },
    ]);
    // HTTP B 恰一次；CLI 走驱动器 mock 零 fetch。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 流式：anthropic SSE 形态（mirror modelGatewayIpc.test.ts streaming describe
// 的 anthEvent/sseResponse 套路；pull-based 流保证 delta 消费先于断流错误）。
// ─────────────────────────────────────────────────────────────────────────────

const ANTH_TWO_KEY_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_a',
      name: 'A anthropic',
      protocol: 'anthropic-compatible',
      apiKey: 'sk-ant-a',
      baseUrl: 'https://anth-a.example.com',
      models: [{ id: 'claude-3-5-sonnet-latest', alias: 'Claude A', capability: 'text', enabled: true }],
    },
    {
      id: 'key_b',
      name: 'B anthropic',
      protocol: 'anthropic-compatible',
      apiKey: 'sk-ant-b',
      baseUrl: 'https://anth-b.example.com',
      models: [{ id: 'claude-3-5-sonnet-latest', alias: 'Claude B', capability: 'text', enabled: true }],
    },
  ],
};

/** Anthropic SSE wire event → framed chunk。 */
function anthEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** Pull-based SSE Response（mirror streaming.test.ts sseResponse——chunk 逐 pull 消费）。 */
function sseResponse(chunks: string[], opts: { error?: Error } = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
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
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function completeAnthStream(text: string): string[] {
  return [
    anthEvent('message_start', { message: { usage: { input_tokens: 5 } } }),
    anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    anthEvent('content_block_stop', { index: 0 }),
    anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    anthEvent('message_stop'),
  ];
}

describe('gateway fallback loop (09-12 子2 W3) — streaming', () => {
  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    resolveImagePartsMock.mockImplementation(async (messages: unknown[]) => messages);
  });

  afterEach(async () => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    resolveImagePartsMock.mockReset();
    vi.restoreAllMocks();
  });

  it('A 已产 delta 后断流 → producedDelta 门拦截，不回退（B 零出站，错误保持中断语义）', async () => {
    await seedConfig(ANTH_TWO_KEY_CONFIG);
    // 流吐一个 text delta 后干净收尾但缺 message_stop（premature close——已见内容后中断
    // 的标准形态，streaming.test.ts 同款 fixture）。
    const aChunks = [
      anthEvent('message_start', { message: { usage: { input_tokens: 3 } } }),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial' } }),
      // message_stop deliberately absent
    ];
    const fetchMock = urlRoutingFetch({
      'https://anth-a.example.com': () => sseResponse(aChunks),
      'https://anth-b.example.com': () => sseResponse(completeAnthStream('should not be reached')),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const deltas: string[] = [];
    const err = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_a', modelId: 'claude-3-5-sonnet-latest' },
        request: { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' } }],
      },
      undefined,
      (d) => { if (d.type === 'text') deltas.push(d.delta); },
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    // UI 已见 'partial' → 任何失败不静默换模型重来（双保险门：interrupted 分类 + producedDelta）。
    expect(deltas).toEqual(['partial']);
    expect((err as Error).name).toBe('StreamInterruptedError');
    // B 零出站。
    const bCalls = (fetchMock.mock.calls as unknown as [string][]).filter(([url]) =>
      String(url).startsWith('https://anth-b.example.com'),
    );
    expect(bCalls).toHaveLength(0);
  });

  it('A 首 delta 前失败（自愈耗尽）→ B 从零接管，消费者只见 B 的 delta 流', async () => {
    await seedConfig(ANTH_TWO_KEY_CONFIG);
    // A 一律 503（stream 尝试 + 快速重试 + 首 delta 前非流式回落全部耗尽）→ server 可回退。
    const fetchMock = urlRoutingFetch({
      'https://anth-a.example.com': () => errorResponse(503, 'upstream dead'),
      'https://anth-b.example.com': () => sseResponse(completeAnthStream('B答案')),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const deltas: string[] = [];
    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_a', modelId: 'claude-3-5-sonnet-latest' },
        request: { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' } }],
      },
      undefined,
      (d) => { if (d.type === 'text') deltas.push(d.delta); },
    );

    // 占位仍空（A 零 delta）→ B 从零流起，接管干净。
    expect(deltas).toEqual(['B答案']);
    expect(result.text).toBe('B答案');
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' });
    expect(result.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'claude-3-5-sonnet-latest', reason: expect.stringContaining('server') },
    ]);
    // B 恰一次成功出站。
    const bCalls = (fetchMock.mock.calls as unknown as [string][]).filter(([url]) =>
      String(url).startsWith('https://anth-b.example.com'),
    );
    expect(bCalls).toHaveLength(1);
  });

  it('流式 onFallback 切换事件 + 终帧注记与 thinking/图片重解同非流式路径（同环共用）', async () => {
    await seedConfig(ANTH_TWO_KEY_CONFIG);
    const fetchMock = urlRoutingFetch({
      'https://anth-a.example.com': () => errorResponse(429, 'rate limited'),
      'https://anth-b.example.com': () => sseResponse(completeAnthStream('from B stream')),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const switches: Array<{ from: { keyId: string }; to: { keyId: string }; attempt: number }> = [];
    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_a', modelId: 'claude-3-5-sonnet-latest' },
        request: { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' } }],
      },
      undefined,
      () => {},
      (event) => switches.push(event),
    );

    expect(result.text).toBe('from B stream');
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' });
    expect(switches).toEqual([
      {
        from: { keyId: 'key_a', modelId: 'claude-3-5-sonnet-latest' },
        to: { keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' },
        reason: expect.any(String),
        attempt: 1,
      },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 09-12 子2 CR 批（批A 网关环加固）：CR-11 图片重解 throw 归类推进 / CR-12 onFallback
// 消费者隔离 / CR-13 config 跳家补发 model-fallback 事件。
// ═════════════════════════════════════════════════════════════════════════════

describe('gateway fallback loop — CR 批加固（CR-11/12/13）', () => {
  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    resolveImagePartsMock.mockImplementation(async (messages: unknown[]) => messages);
  });

  afterEach(async () => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    resolveImagePartsMock.mockReset();
    vi.restoreAllMocks();
  });

  it('CR-11：A 的图片重解 throw（转述模型配额等未分类错误）→ 记 `image:` trace 推进 B（vision 档条目有机会直传承接），不炸整链', async () => {
    await seedConfig();
    // A 的重解抛错（模拟转述 visionModel 429 / 读盘异常）；B（vision 直传）重解透传。
    resolveImagePartsMock.mockImplementation(async (messages: unknown[], resolved: { keyId: string }) => {
      if (resolved.keyId === 'key_a') {
        throw new Error('vision relay quota exhausted');
      }
      return messages;
    });
    const fetchMock = urlRoutingFetch({
      'https://b.example.com/v1': () => openAiTextResponse('from B direct'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });

    expect(result.text).toBe('from B direct');
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
    // trace 带 image: 前缀归类（与终态 trace 口径一致）。
    expect(result.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('image:') },
    ]);
    // A 零出站（失败发生在重解面，未达协议层）；B 恰一次。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('CR-12：onFallback 消费者 throw（UI 事件装配 bug）→ 生成照常成功（隔离不反向炸链）', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const seen: unknown[] = [];
    const result = await handleGenerateText(
      {
        ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
      },
      undefined,
      (event) => {
        seen.push(event);
        throw new Error('consumer UI bug');
      },
    );

    // 消费者确实收到事件且确实 throw——但生成不被反向炸掉。
    expect(seen).toHaveLength(1);
    expect(result.text).toBe('from B');
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
  });

  it('CR-13：resolveModel config 跳家补发 model-fallback 事件（from=请求身份，reason 带 config: 前缀对齐终态 trace）', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const switches: Array<{ from: { keyId: string; modelId: string }; to: { keyId: string; modelId: string }; reason: string; attempt: number }> = [];
    const result = await handleGenerateText(
      {
        ref: { keyId: 'key_gone', modelId: 'whatever' },
        request: { model: 'whatever', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
      },
      undefined,
      (event) => switches.push(event),
    );

    expect(result.text).toBe('from B');
    // config 跳家的切换事件：from 是请求身份（解析失败无 resolved 身份）、reason 与
    // trace 同串（config: 前缀）、attempt 1-based。
    expect(switches).toEqual([
      {
        from: { keyId: 'key_gone', modelId: 'whatever' },
        to: { keyId: 'key_b', modelId: 'gpt-4o-mini' },
        reason: expect.stringContaining('config:'),
        attempt: 1,
      },
    ]);
    expect(result.fallbackTrace).toEqual([
      { keyId: 'key_gone', modelId: 'whatever', reason: expect.stringContaining('config:') },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// W6 跨形态联调（implement.md W6）：CLI × HTTP 混合链 + sessionKey 交互 +
// 图片按目标模型跨形态重解。CLI 驱动器经 setAntigravityCliGenerateForTest 注入缝
//（spawn/进程池内部行为是子1 antigravitySessions/driver 测试面；此处钉环边界——
// per-attempt 透传与 per-attempt resolved 形态）。
// ═════════════════════════════════════════════════════════════════════════════

describe('gateway fallback loop — W6 跨形态联调', () => {
  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    resolveImagePartsMock.mockImplementation(async (messages: unknown[]) => messages);
  });

  afterEach(async () => {
    setAntigravityCliGenerateForTest(undefined);
    _resetAntigravityCliUsedForTest();
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    resolveImagePartsMock.mockReset();
    vi.restoreAllMocks();
  });

  it('带 sessionKey 的链：CLI attempt 的驱动器请求原样携带 sessionKey（回退切模型 = 新进程键，池侧零工程——环只须不丢字段）', async () => {
    await seedConfig({
      keys: [
        {
          id: 'key_agy',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          apiKey: '',
          cliExecutable: 'C:\\agy\\bin\\agy.exe',
          models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true }],
        },
        {
          id: 'key_b',
          name: 'B relay',
          protocol: 'openai-compatible',
          apiKey: 'sk-b',
          baseUrl: 'https://b.example.com/v1',
          models: [{ id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true }],
        },
      ],
    });
    const seenRequests: Array<Record<string, unknown>> = [];
    setAntigravityCliGenerateForTest(async (_model, request) => {
      seenRequests.push(request as Record<string, unknown>);
      throw new ProtocolHttpError('agy terminal state ERROR: crashed', 502);
    });
    const fetchMock = urlRoutingFetch({
      'https://b.example.com/v1': () => openAiTextResponse('from B http'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' },
      request: {
        model: 'gemini-3.8-pro-high',
        messages: [{ role: 'user', content: 'hi' }],
        sessionKey: 'chain:sess-1:writer',
      },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });

    // CLI attempt 的驱动器请求携带 sessionKey（池按 (sessionKey,keyId,modelId) 键控——
    // 切到 B 即新键冷启动，A 表项不受扰；环从原始 payload 重建请求不丢字段）。
    expect(seenRequests.length).toBeGreaterThanOrEqual(1);
    expect(seenRequests[0]!.sessionKey).toBe('chain:sess-1:writer');
    // B 承接成功 + 注记。
    expect(result.text).toBe('from B http');
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
  });

  it('图片跨形态重解：A CLI 键（vision ABSENT）→ B HTTP vision 键（vision: true）——resolveImageParts 每 attempt 收到各自形态的 resolved', async () => {
    await seedConfig({
      keys: [
        {
          id: 'key_agy',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          apiKey: '',
          cliExecutable: 'C:\\agy\\bin\\agy.exe',
          models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true }],
        },
        {
          id: 'key_b',
          name: 'B relay',
          protocol: 'openai-compatible',
          apiKey: 'sk-b',
          baseUrl: 'https://b.example.com/v1',
          // gpt-4o-mini：registry vision 家族 → resolved.vision === true（直传路径判据）。
          models: [{ id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true }],
        },
      ],
    });
    const seenResolved: Array<{ protocol: string; vision?: boolean; hasVisionKey: boolean }> = [];
    resolveImagePartsMock.mockImplementation(async (messages: unknown[], resolved: { protocol: string; vision?: boolean }) => {
      seenResolved.push({ protocol: resolved.protocol, vision: resolved.vision, hasVisionKey: 'vision' in resolved });
      return messages;
    });
    setAntigravityCliGenerateForTest(async () => {
      throw new ProtocolHttpError('agy terminal state ERROR: crashed', 502);
    });
    const fetchMock = urlRoutingFetch({
      'https://b.example.com/v1': () => openAiTextResponse('from B http'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' },
      request: { model: 'gemini-3.8-pro-high', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });

    expect(result.text).toBe('from B http');
    // attempt A = CLI 形态（vision 键 ABSENT——转述安全路径判据）；attempt B = HTTP vision
    // 键（vision: true——b64 直传判据）。环零特判：判据就是 resolved 本身。
    expect(seenResolved).toEqual([
      { protocol: 'antigravity-cli', hasVisionKey: false },
      { protocol: 'openai-compatible', vision: true, hasVisionKey: true },
    ]);
  });
});
