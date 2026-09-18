import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import {
  generateText,
  generateTextStream,
  generateImage,
  generateEmbeddings,
  rerank,
  listModels,
  streamWindowMs,
} from '../src';
import { getInsecureDispatcher, postJson, postSse, getJson, postMultipart } from '../src/http';

// 09-12 子3 W2：HTTP provider 调用参数面协议层注入——customHeaders（双协议 + 五个
// 直调请求面）/ verifySsl dispatcher / per-key 超时窗口值源 / per-model 采样缺省
// 补位（topP + 双 penalty，含 Anthropic drop）/ extraBody 深合并。零配置键的字节级
// 不变回归锚同场钉死。

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };

/** One OpenAI chat.completions SSE chunk line. */
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

/** One Anthropic SSE frame. */
function anthEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}
const ANTHROPIC_HAPPY = [
  anthEvent('message_start', { message: { usage: { input_tokens: 11 } } }),
  anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  anthEvent('content_block_stop', { index: 0 }),
  anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
  anthEvent('message_stop'),
];

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
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!signal) controller.close();
    },
    pull(controller) {
      if (index >= chunks.length && signal) {
        // hang open until abort when a signal is wired (mirrors streaming.test.ts)
        return;
      }
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function openaiModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'totally-unknown-model', // registry-miss: no implicit limits/kinds interfere
    protocol: 'openai-compatible',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

function anthropicModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'totally-unknown-model',
    protocol: 'anthropic-compatible',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

function headersOf(init: RequestInit | undefined): Headers {
  return init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
}

const OPENAI_COMPLETION = {
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};
const ANTHROPIC_COMPLETION = {
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 11, output_tokens: 7 },
};

describe('customHeaders injection (09-12 子3 §3 ①②③④⑤⑥⑦)', () => {
  let captured: CapturedCall[];
  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('OpenAI 非流式：custom header 随请求发出，同名覆盖内建鉴权头（网关替代鉴权语义）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(
      openaiModel({ customHeaders: { 'HTTP-Referer': 'https://closure.dev', authorization: 'Bearer gw-token' } }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    );
    const headers = headersOf(captured[0].init);
    expect(headers.get('HTTP-Referer')).toBe('https://closure.dev');
    expect(headers.get('authorization')).toBe('Bearer gw-token'); // 同名覆盖生效
  });

  it('OpenAI 流式：custom header 同样随请求发出（createProvider 链罩住流式路径）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return sseResponse([
        openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }),
        openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        OPENAI_DONE,
      ]);
    });
    const result = await generateTextStream(
      openaiModel({ customHeaders: { 'X-Route-Pool': 'b' } }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    expect(result.text).toBe('ok');
    expect(headersOf(captured[0].init).get('X-Route-Pool')).toBe('b');
  });

  it('Anthropic 非流式：customHeaders 在内建头之后展开（x-api-key 同名可覆盖）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(ANTHROPIC_COMPLETION);
    });
    await generateText(
      anthropicModel({ customHeaders: { 'X-Gateway-Auth': 'tok', 'x-api-key': 'gw-override' } }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
    );
    const headers = headersOf(captured[0].init);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('X-Gateway-Auth')).toBe('tok');
    expect(headers.get('x-api-key')).toBe('gw-override'); // 后展开覆盖
  });

  it('Anthropic 流式（postSse）：customHeaders 同样并入', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return sseResponse(ANTHROPIC_HAPPY, init?.signal);
    });
    const result = await generateTextStream(
      anthropicModel({ customHeaders: { 'X-Route': 'a' } }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
      undefined,
      () => {},
    );
    expect(result.text).toBe('hi');
    expect(headersOf(captured[0].init).get('X-Route')).toBe('a');
    expect(headersOf(captured[0].init).get('x-api-key')).toBe('sk-test');
  });

  it('同 key 其余请求面：image 生成/编辑、embeddings、rerank、listModels 全带 custom headers', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      const url = String(input);
      if (url.includes('/images/edits')) return jsonResponse({ data: [{ b64_json: 'eHg=' }] });
      if (url.includes('/rerank')) return jsonResponse({ results: [{ index: 0, relevance_score: 0.9 }] });
      if (url.includes('/embeddings')) return jsonResponse({ data: [{ embedding: [0.1] }] });
      if (url.includes('/models')) return jsonResponse({ data: [{ id: 'm1' }] });
      return jsonResponse({ data: [{ b64_json: 'eHg=' }] });
    });
    const key = openaiModel({ customHeaders: { 'X-Gateway-Auth': 'tok' }, modelId: 'dall-e-3' });
    await generateImage(key, { model: 'dall-e-3', prompt: 'a city' });
    await generateImage(key, { model: 'dall-e-3', prompt: 'a city', image: { b64Json: 'eHg=', mimeType: 'image/png' } });
    await generateEmbeddings(openaiModel({ customHeaders: { 'X-Gateway-Auth': 'tok' } }), { input: ['hello'] });
    await rerank(openaiModel({ customHeaders: { 'X-Gateway-Auth': 'tok' } }), { query: 'q', documents: ['a'] });
    await listModels({ baseUrl: 'https://gw.example.com', apiKey: 'sk-test', headers: { 'X-Gateway-Auth': 'tok' } });

    expect(captured).toHaveLength(5);
    for (const call of captured) {
      expect(headersOf(call.init).get('X-Gateway-Auth'), call.url).toBe('tok');
      expect(headersOf(call.init).get('authorization'), call.url).toBe('Bearer sk-test'); // 内建头不被剥
    }
  });

  it('listModels anthropic 协议 + fallback 重试同样携带 headers', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      call += 1;
      return call === 1 ? jsonResponse({ error: { message: 'nope' } }, 404) : jsonResponse({ data: [{ id: 'm1' }] });
    });
    const models = await listModels({
      protocol: 'anthropic-compatible',
      baseUrl: 'https://gw.example.com/anthropic',
      apiKey: 'sk',
      headers: { 'X-Gateway-Auth': 'tok' },
    });
    expect(models).toEqual([{ id: 'm1', capability: 'text', alias: 'm1' }]);
    expect(captured).toHaveLength(2);
    for (const c of captured) {
      expect(headersOf(c.init).get('X-Gateway-Auth')).toBe('tok');
    }
  });

  it('回归锚：无 customHeaders 时 init 无 dispatcher 字段、无自定义头（零包装零透传）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(openaiModel(), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect('dispatcher' in (captured[0].init ?? {})).toBe(false);
    expect(headersOf(captured[0].init).get('X-Gateway-Auth')).toBeNull();
  });
});

describe('verifySsl dispatcher (09-12 子3 §3 ⑧)', () => {
  let captured: CapturedCall[];
  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('OpenAI 路径（createProvider 包装）：verifySsl=true 时 fetch init 携带 insecure Agent 单例', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(
      openaiModel({ verifySsl: true }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    );
    const init = captured[0].init as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBe(getInsecureDispatcher()); // 同一懒单例引用
  });

  it('Anthropic 非流式 postJson：dispatcher 透传', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(ANTHROPIC_COMPLETION);
    });
    await generateText(
      anthropicModel({ verifySsl: true }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
    );
    expect((captured[0].init as { dispatcher?: unknown }).dispatcher).toBe(getInsecureDispatcher());
  });

  it('http.ts 四函数 dispatcher 透传（postJson/getJson/postMultipart/postSse）+ ABSENT 不落字段', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(_input), init });
      return sseResponse([anthEvent('message_stop')], init?.signal);
    });
    await postJson({ url: 'https://x.test/a', body: {}, dispatcher: 'D1' });
    await getJson({ url: 'https://x.test/a', dispatcher: 'D2' });
    await postMultipart({ url: 'https://x.test/a', formData: new FormData(), dispatcher: 'D3' });
    await postSse({ url: 'https://x.test/a', body: {}, dispatcher: 'D4', onEvent: () => {} });
    await postJson({ url: 'https://x.test/b', body: {} }); // 无 dispatcher

    expect((captured[0].init as { dispatcher?: unknown }).dispatcher).toBe('D1');
    expect((captured[1].init as { dispatcher?: unknown }).dispatcher).toBe('D2');
    expect((captured[2].init as { dispatcher?: unknown }).dispatcher).toBe('D3');
    expect((captured[3].init as { dispatcher?: unknown }).dispatcher).toBe('D4');
    expect('dispatcher' in (captured[4].init ?? {})).toBe(false); // ABSENT = init 形态不变
  });
});

describe('per-key timeout window value source (09-12 子3 §3 ⑨)', () => {
  it('streamWindowMs：key 值替换 lane 默认 / 无 key 值回 lane（dialogue 60s / background 240s）', () => {
    expect(streamWindowMs(openaiModel(), undefined)).toBe(60_000);
    expect(streamWindowMs(openaiModel(), { lane: 'background' })).toBe(240_000);
    expect(streamWindowMs(openaiModel({ timeoutSeconds: 30 }), undefined)).toBe(30_000);
    expect(streamWindowMs(openaiModel({ timeoutSeconds: 30 }), { lane: 'background' })).toBe(30_000); // 覆盖 lane
  });
});

describe('per-model sampling defaults (09-12 子3 §4.2)', () => {
  let captured: CapturedCall[];
  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; vi.restoreAllMocks(); });

  it('OpenAI 路径：topP/双 penalty 经 ai callSettings 进 wire body（top_p/frequency_penalty/presence_penalty）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(
      openaiModel({ defaultTopP: 0.9, defaultFrequencyPenalty: 0.3, defaultPresencePenalty: 0.4 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    );
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.top_p).toBe(0.9);
    expect(body.frequency_penalty).toBe(0.3);
    expect(body.presence_penalty).toBe(0.4);
  });

  it('OpenAI 流式路径：同三参数透传；无默认时字段不发（回归锚）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return sseResponse([
        openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }),
        openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        OPENAI_DONE,
      ]);
    });
    await generateTextStream(
      openaiModel({ defaultTopP: 0.5, defaultFrequencyPenalty: -1, defaultPresencePenalty: 1 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    const withDefaults = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(withDefaults.top_p).toBe(0.5);
    expect(withDefaults.frequency_penalty).toBe(-1);
    expect(withDefaults.presence_penalty).toBe(1);

    // 第二次调用（无默认）——同 mock 收集。
    await generateTextStream(
      openaiModel(),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    const withoutDefaults = JSON.parse((captured[1].init?.body as string) ?? '{}');
    expect('top_p' in withoutDefaults).toBe(false);
    expect('frequency_penalty' in withoutDefaults).toBe(false);
    expect('presence_penalty' in withoutDefaults).toBe(false);
  });

  it('Anthropic 路径：topP 直发（Messages API 原生 top_p）；无默认不发', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(ANTHROPIC_COMPLETION);
    });
    await generateText(
      anthropicModel({ defaultTopP: 0.85 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
    );
    const withTop = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(withTop.top_p).toBe(0.85);

    await generateText(
      anthropicModel(),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
    );
    const withoutTop = JSON.parse((captured[1].init?.body as string) ?? '{}');
    expect('top_p' in withoutTop).toBe(false);
  });

  it('Anthropic 双 penalty：drop + warn-once（每 keyId:modelId 一次）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(ANTHROPIC_COMPLETION);
    });
    const model = anthropicModel({ keyId: 'warn-key', defaultFrequencyPenalty: 0.2, defaultPresencePenalty: 0.3 });
    await generateText(model, { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 });
    await generateText(model, { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 });

    const firstBody = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect('frequency_penalty' in firstBody).toBe(false);
    expect('presence_penalty' in firstBody).toBe(false);
    const penaltyWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('penalty defaults are not accepted'),
    );
    expect(penaltyWarns).toHaveLength(1); // warn-once，第二次静默 drop
  });
});

describe('per-model defaultTemperature 缺省补位 (09-12 子3 §4.2 W3)', () => {
  let captured: CapturedCall[];
  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; vi.restoreAllMocks(); });

  it('非流式双协议：请求无 temperature → defaultTemperature 补位进 wire body', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return input.toString().includes('/messages')
        ? jsonResponse(ANTHROPIC_COMPLETION)
        : jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(
      openaiModel({ defaultTemperature: 0.3 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    );
    await generateText(
      anthropicModel({ defaultTemperature: 0.4 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
    );
    expect(JSON.parse((captured[0].init?.body as string) ?? '{}').temperature).toBe(0.3);
    expect(JSON.parse((captured[1].init?.body as string) ?? '{}').temperature).toBe(0.4);
  });

  it('流式路径同补位（generateTextStreamInner 顶部归一）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return sseResponse([
        openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }),
        openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        OPENAI_DONE,
      ]);
    });
    await generateTextStream(
      openaiModel({ defaultTemperature: 0.6 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    expect(JSON.parse((captured[0].init?.body as string) ?? '{}').temperature).toBe(0.6);
  });

  it('请求级显式 temperature 覆盖默认（优先级链：请求级 > per-model 默认）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(
      openaiModel({ defaultTemperature: 0.9 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 },
    );
    expect(JSON.parse((captured[0].init?.body as string) ?? '{}').temperature).toBe(0.2);
  });

  it('dropTemperature 厂商约束仍最高：thinking on 的 openai-o 连默认温度一起删', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(
      openaiModel({ thinkingKind: 'openai-o', defaultTemperature: 0.8 }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], thinking: { level: 'medium' } },
    );
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect('temperature' in body).toBe(false); // 厂商拒 temperature 的模型不被默认补位破坏
    expect(body.reasoning_effort).toBe('medium'); // thinking 注入照常（区分「删温度」与「patch 未跑」）
  });

  it('回归锚：无默认无请求级 → temperature 字段不发（零配置键字节级不变）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(openaiModel(), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect('temperature' in JSON.parse((captured[0].init?.body as string) ?? '{}')).toBe(false);
  });
});

describe('per-model extraBody deep merge (09-12 子3 §4.3)', () => {
  let captured: CapturedCall[];
  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('OpenAI 路径：extraBody 深合并进 wire body——同键覆盖、嵌套对象递归合并', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(
      openaiModel({
        defaultTopP: 0.9,
        extraBody: {
          safe_prompt: true,
          top_p: 0.1, // 同键覆盖协议层值（用户显式最优先）
          vendor: { min_p: 0.05, nested: { deep: true } },
        },
      }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 },
    );
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.safe_prompt).toBe(true);
    expect(body.top_p).toBe(0.1); // 覆盖 defaultTopP 的 0.9
    expect(body.vendor).toEqual({ min_p: 0.05, nested: { deep: true } });
    expect(body.temperature).toBe(0.7); // 其余字段不受影响
  });

  it('Anthropic 路径：extraBody 组装尾部深合并——同键覆盖 max_tokens（用户显式最优先）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(ANTHROPIC_COMPLETION);
    });
    await generateText(
      anthropicModel({ extraBody: { max_tokens: 999, vendor_private: { flag: 1 } } }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
    );
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.max_tokens).toBe(999); // 覆盖 guardrail 值
    expect(body.vendor_private).toEqual({ flag: 1 });
    expect(body.messages).toBeDefined();
  });

  it('回归锚：无 extraBody 无 thinking 时 OpenAI bodyPatch 不安装——wire body 无注入痕迹', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return jsonResponse(OPENAI_COMPLETION);
    });
    await generateText(openaiModel(), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    // 非流式 32K guardrail（max_tokens）是既有行为；锚断言 = 无 extraBody 注入痕迹
    //（键集与子3 前完全一致）。
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model']);
  });
});

describe('user limits ride the existing caps chain (09-12 子3 §4.1 协议面锚)', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('registry-unknown 模型 + ResolvedModel.limits.maxOutputTokens（合成产物形态）→ 流式顶格按用户值', async () => {
    const captured: CapturedCall[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return sseResponse([
        openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }),
        openaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        OPENAI_DONE,
      ]);
    });
    // limits 形态 = resolveModelInfoWithDefaults 的单键合成产物（Partial）。
    await generateTextStream(
      openaiModel({ limits: { maxOutputTokens: 1234 } }),
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      () => {},
    );
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.max_tokens).toBe(1234);
  });
});
