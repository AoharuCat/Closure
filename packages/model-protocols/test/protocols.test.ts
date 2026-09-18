import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import {
  generateText,
  generateTextStream,
  generateImage,
  generateEmbeddings,
  ProtocolHttpError,
  setAntigravityCliGenerateForTest,
} from '../src';

const ORIGINAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init?: RequestInit };

function buildMock(captured: CapturedCall[], body: unknown, status = 200) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
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

describe('unified protocol', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  describe('generateText', () => {
    it('posts to /chat/completions with Bearer auth', async () => {
      globalThis.fetch = buildMock(captured, {
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });

      const result = await generateText(model(), {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        maxTokens: 256,
      });

      expect(captured[0].url).toBe('https://api.openai.com/v1/chat/completions');
      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body.model).toBe('gpt-4o');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(result.text).toBe('hello');
      expect(result.finishReason).toBe('stop');
      expect(result.usage?.totalTokens).toBe(30);
    });

    it('throws ProtocolHttpError on non-2xx', async () => {
      globalThis.fetch = buildMock(captured, { error: { message: 'bad key' } }, 401);
      await expect(
        generateText(model(), { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
      ).rejects.toBeInstanceOf(ProtocolHttpError);
    });

    it('posts Anthropic-compatible text requests to /messages with x-api-key auth', async () => {
      globalThis.fetch = buildMock(captured, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-latest',
        content: [{ type: 'text', text: 'hello from claude' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 7 },
      });

      const result = await generateText(
        model({
          protocol: 'anthropic-compatible',
          modelId: 'claude-3-5-sonnet-latest',
          baseUrl: 'https://api.anthropic.com',
        }),
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [
            { role: 'system', content: 'You are concise.' },
            { role: 'user', content: 'hi' },
          ],
          maxTokens: 256,
        },
      );

      expect(captured[0].url).toBe('https://api.anthropic.com/v1/messages');
      const headers = captured[0].init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-test');
      expect(headers['anthropic-version']).toBeTruthy();
      expect(headers.authorization).toBeUndefined();
      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body).toMatchObject({
        model: 'claude-3-5-sonnet-latest',
        system: 'You are concise.',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result).toEqual({
        model: 'claude-3-5-sonnet-latest',
        text: 'hello from claude',
        finishReason: 'stop',
        usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      });
    });

    it('defaults anthropic max_tokens to the 32768 guardrail when omitted (dogfood T1 D2)', async () => {
      globalThis.fetch = buildMock(captured, {
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-latest',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      await generateText(
        model({
          protocol: 'anthropic-compatible',
          modelId: 'claude-3-5-sonnet-latest',
          baseUrl: 'https://api.anthropic.com',
        }),
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'write a chapter' }],
        },
      );

      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body.max_tokens).toBe(32768);
    });
  });

  describe('generateImage', () => {
    it('posts to /images/generations for prompt-only requests', async () => {
      globalThis.fetch = buildMock(captured, {
        data: [{ b64_json: 'AAAA' }],
      });

      const result = await generateImage(
        model({ modelId: 'dall-e-3', capability: 'image' }),
        { model: 'dall-e-3', prompt: 'a cat' },
      );

      expect(captured[0].url).toBe('https://api.openai.com/v1/images/generations');
      expect(result.images[0].b64Json).toBe('AAAA');
    });

    it('posts to /images/edits when image is provided', async () => {
      globalThis.fetch = buildMock(captured, {
        data: [{ b64_json: 'BBBB' }],
      });

      await generateImage(
        model({ modelId: 'gpt-image-1', capability: 'image' }),
        { model: 'gpt-image-1', prompt: 'edit', image: { b64Json: 'YWJj', mimeType: 'image/png' } },
      );

      expect(captured[0].url).toBe('https://api.openai.com/v1/images/edits');
    });
  });

  describe('generateEmbeddings', () => {
    it('posts to /embeddings with Bearer auth and maps data[] in input order', async () => {
      globalThis.fetch = buildMock(captured, {
        model: 'text-embedding-3-small',
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      });

      const result = await generateEmbeddings(
        model({ modelId: 'text-embedding-3-small' }),
        { input: ['first text', 'second text'] },
      );

      expect(captured[0].url).toBe('https://api.openai.com/v1/embeddings');
      const headers = captured[0].init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-test');
      const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
      expect(body).toEqual({ model: 'text-embedding-3-small', input: ['first text', 'second text'] });
      expect(result.model).toBe('text-embedding-3-small');
      expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
      expect(result.usage).toEqual({ promptTokens: 7, totalTokens: 7 });
    });

    it('throws ProtocolHttpError on non-2xx', async () => {
      globalThis.fetch = buildMock(captured, { error: { message: 'bad key' } }, 401);
      await expect(
        generateEmbeddings(model(), { input: ['x'] }),
      ).rejects.toBeInstanceOf(ProtocolHttpError);
    });
  });

});

// ── Story 3.6 vision seam: user-message parts → dual-protocol wire shapes ──
describe('vision seam parts mapping (Story 3.6)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('openai-compatible: image part serializes as image_url data URL, text part stays text', async () => {
    globalThis.fetch = buildMock(captured, {
      choices: [{ index: 0, message: { role: 'assistant', content: '一只猫' }, finish_reason: 'stop' }],
    });

    const result = await generateText(model(), {
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么？' },
          { type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/png' } },
        ],
      }],
    });

    expect(result.text).toBe('一只猫');
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
      ],
    }]);
  });

  it('openai-compatible: pure string messages serialize byte-identically (zero regression)', async () => {
    globalThis.fetch = buildMock(captured, {
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });

    await generateText(model(), {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'hi' },
      ],
    });

    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    // The AI SDK re-injects the hoisted system message into the wire messages
    // array (OpenAI has no top-level system param). The user message stays a
    // plain string — exactly the pre-parts wire body.
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('anthropic-compatible: image part serializes as base64 image block', async () => {
    globalThis.fetch = buildMock(captured, {
      content: [{ type: 'text', text: '一只猫' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await generateText(
      model({ protocol: 'anthropic-compatible', modelId: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com' }),
      {
        model: 'claude-3-5-sonnet-latest',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/jpeg' } },
            { type: 'text', text: '这张图里是什么？' },
          ],
        }],
        maxTokens: 128,
      },
    );

    expect(result.text).toBe('一只猫');
    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJj' } },
        { type: 'text', text: '这张图里是什么？' },
      ],
    }]);
  });

  it('anthropic-compatible: pure string messages serialize byte-identically (zero regression)', async () => {
    globalThis.fetch = buildMock(captured, {
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });

    await generateText(
      model({ protocol: 'anthropic-compatible', modelId: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com' }),
      {
        model: 'claude-3-5-sonnet-latest',
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'hi' },
        ],
        maxTokens: 128,
      },
    );

    const body = JSON.parse((captured[0].init?.body as string) ?? '{}');
    // String user content stays a plain string (not wrapped in a blocks array)
    // — exactly the pre-parts wire body.
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.system).toBe('You are concise.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 system stabilization C 批（W_c1）：Anthropic prompt caching 显式断点。
// cacheControl 缺省/显式 false → wire body 与现行形态逐字节一致（system 保持
// join 字符串、消息 string 内容保持 string——零回归门）；置位 → ① system 数组
// 块形 + 尾块 cache_control ② 对话尾（最后一条消息的最后内容块）cache_control
// ——共 2 断点 ≤ 官方 4 上限。OpenAI 路径读 flag 零动作（隐式前缀缓存无协议
// 字段，AC7）。
// ─────────────────────────────────────────────────────────────────────────────

describe('anthropic cache_control wiring (09-12 system stabilization C batch)', () => {
  let captured: CapturedCall[];

  beforeEach(() => { captured = []; });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  const anthropicModel = () =>
    model({ protocol: 'anthropic-compatible', modelId: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com' });

  const ANTHROPIC_OK = {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  const bodyAt = (index: number) => JSON.parse((captured[index]?.init?.body as string) ?? '{}');

  it('flag 缺省与显式 false：wire body 原始 JSON 串全等（CR P14 字节级门）', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'hi' },
      ],
      maxTokens: 128,
    });
    // CR P14：原始实发 body 串全等——parse 后 toEqual 归一键序/序列化差异，
    // 「字节不变」措辞须钉字节（harness 捕获的 init.body 即 postJson 实发串）。
    const absentRaw = (captured[0]?.init?.body as string) ?? '';

    captured = [];
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'hi' },
      ],
      maxTokens: 128,
      cacheControl: false,
    });
    const falseRaw = (captured[0]?.init?.body as string) ?? '';

    expect(falseRaw).toBe(absentRaw);
    const absentBody = JSON.parse(absentRaw);
    expect(absentBody.system).toBe('You are concise.');
    expect(absentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('flag 置位：system 数组块形 + 尾块断点；string user 尾升格为单 text 块', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'hi' },
      ],
      maxTokens: 128,
      cacheControl: true,
    });
    const body = bodyAt(0);
    expect(body.system).toEqual([
      { type: 'text', text: 'You are concise.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
    ]);
  });

  it('多形态 ①：assistant blocks 尾——marker 落在最后 tool_use 块；非尾消息零触碰', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'user', content: '写第一章' },
        { role: 'assistant', content: '开写', toolCalls: [{ id: 'toolu_1', name: 'write_chapter', arguments: '{"title":"一"}' }] },
      ],
      maxTokens: 128,
      cacheControl: true,
    });
    const body = bodyAt(0);
    expect(body.system).toBeUndefined();
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '开写' },
        { type: 'tool_use', id: 'toolu_1', name: 'write_chapter', input: { title: '一' }, cache_control: { type: 'ephemeral' } },
      ],
    });
    // 非尾消息保持现行形态（string 内容不被升格、无 marker）。
    expect(body.messages[0]).toEqual({ role: 'user', content: '写第一章' });
  });

  it('多形态 ②：tool 消息尾——marker 落在 tool_result 块', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'user', content: '写第一章' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'write_chapter', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'toolu_1', content: '章节已落盘' },
      ],
      maxTokens: 128,
      cacheControl: true,
    });
    const body = bodyAt(0);
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '章节已落盘', cache_control: { type: 'ephemeral' } }],
    });
    // 非尾 assistant（空 content + toolCalls → 纯 tool_use 数组）零触碰。
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_chapter', input: {} }],
    });
  });

  it('多形态 ③：user parts 尾——marker 落在最后 image 块（vision seam 交互）', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么？' },
          { type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/png' } },
        ],
      }],
      maxTokens: 128,
      cacheControl: true,
    });
    const body = bodyAt(0);
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' }, cache_control: { type: 'ephemeral' } },
      ],
    });
  });

  // C 批 CR P11：空串防升格——升格会产出 `{type:'text',text:''}` 空 text 块（Anthropic
  // 400）；旧 '' string 形态可发，两边界（尾消息 / system）flag-on 时保原形态。
  it('C 批 CR P11：空串尾消息保 string 形态 + join 空串 system 保 "" 原形态', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: '' },
      ],
      maxTokens: 128,
      cacheControl: true,
    });
    const body = bodyAt(0);
    expect(body.system).toBe('');
    expect(body.messages).toEqual([{ role: 'user', content: '' }]);
  });

  // C 批 CR P10：Anthropic usage cache 桶透出——input_tokens 不含 cache 桶，真实输入量
  // = 三桶求和（校准环/压缩阈值口径）；cacheReadTokens 透出（agy driver 同形）。
  it('C 批 CR P10：三桶 usage——cache_read=100 / creation=50 / input=200 → promptTokens=350 + cacheReadTokens=100', async () => {
    globalThis.fetch = buildMock(captured, {
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    });
    const result = await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 128,
    });
    expect(result.usage?.promptTokens).toBe(350);
    expect(result.usage?.cacheReadTokens).toBe(100);
    expect(result.usage?.totalTokens).toBe(355);
  });

  it('C 批 CR P10：cache 桶全缺席 → cacheReadTokens 键 ABSENT + 既有口径不变', async () => {
    globalThis.fetch = buildMock(captured, ANTHROPIC_OK);
    const result = await generateText(anthropicModel(), {
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 128,
    });
    expect('cacheReadTokens' in (result.usage ?? {})).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('AC7：OpenAI 路径读 flag 零动作——置位时 body 与缺省 deep-equal', async () => {
    const OPENAI_OK = {
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(model(), {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'hi' },
      ],
    });
    const absentBody = bodyAt(0);

    captured = [];
    globalThis.fetch = buildMock(captured, OPENAI_OK);
    await generateText(model(), {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'hi' },
      ],
      cacheControl: true,
    });
    const flaggedBody = bodyAt(0);

    expect(flaggedBody).toEqual(absentBody);
    // 形态钉面：OpenAI 无顶层 system 参数（system 消息回注 messages 数组）。
    expect(absentBody.system).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 agy provider W3：CLI 形态分派（generateText/generateTextStream 顶部早退）
// + 流式韧性层旁路（复核 H2：CLI 502 后驱动器恰被调一次——不被快速重试/非流式回退
// 重发 = 静默冷重启全量重发）+ HTTP 双形态零变化回归（既有 fetch-mock 用例即回归门，
// 此处另钉「CLI 形态绝不出 HTTP 请求」）。
// ─────────────────────────────────────────────────────────────────────────────

describe('antigravity-cli dispatch（generate.ts 顶部早退）', () => {
  let driverCalls: Array<{ model: ResolvedModel; request: Record<string, unknown>; ctx: unknown }>;

  beforeEach(() => {
    driverCalls = [];
    setAntigravityCliGenerateForTest(async (model, request, ctx) => {
      driverCalls.push({ model, request: request as unknown as Record<string, unknown>, ctx });
      return { model: model.modelId, text: 'cli-ok', finishReason: 'stop' };
    });
  });
  afterEach(() => {
    setAntigravityCliGenerateForTest(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function cliModel(): ResolvedModel {
    return {
      keyId: 'agy',
      modelId: 'gemini-3.8-pro-high',
      protocol: 'antigravity-cli',
      baseUrl: '',
      apiKey: '',
      capability: 'text',
      // Windows 路径反斜杠双写（`\b` 单写 = 0x08 控制字节——testing-discipline 字面坑）。
      cliExecutable: 'C:\\agy\\bin\\agy.exe',
    };
  }

  it('generateText：CLI 形态 → 驱动器收全套（含 sessionKey），零 HTTP fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await generateText(cliModel(), {
      model: 'gemini-3.8-pro-high',
      messages: [{ role: 'user', content: '写一章' }],
      sessionKey: 'chain:sess-1',
      lane: 'background',
    });

    expect(result.text).toBe('cli-ok');
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0]!.model.cliExecutable).toBe('C:\\agy\\bin\\agy.exe');
    expect(driverCalls[0]!.request.sessionKey).toBe('chain:sess-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('generateTextStream：CLI 形态 → 驱动器收 onDelta，零 HTTP fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const deltas: string[] = [];

    const result = await generateTextStream(
      cliModel(),
      { model: 'gemini-3.8-pro-high', messages: [{ role: 'user', content: 'x' }] },
      undefined,
      (d) => deltas.push(d.delta),
    );

    expect(result.text).toBe('cli-ok');
    expect(driverCalls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('流式韧性层旁路（复核 H2）：CLI 驱动器 502 → 恰一次调用 + 原错误上抛（不被回退重发）', async () => {
    let calls = 0;
    setAntigravityCliGenerateForTest(async () => {
      calls += 1;
      throw new ProtocolHttpError('antigravity-cli process exited before the turn result', 502);
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    // 流式入口的 pre-delta 502 正是既有韧性层会吞去「回退非流式重发」的形态——
    // CLI 早退必须先于它（spawn 调用次数 = 1；非流式回退/快速重试都算第二次）。
    await expect(
      generateTextStream(
        cliModel(),
        { model: 'gemini-3.8-pro-high', messages: [{ role: 'user', content: 'x' }], lane: 'background' },
        undefined,
        () => {},
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('HTTP 双形态不受 CLI 覆写缝影响（分派旁路回归门）', async () => {
    globalThis.fetch = buildMock([], {
      choices: [{ index: 0, message: { role: 'assistant', content: 'http-ok' }, finish_reason: 'stop' }],
    });
    const result = await generateText(
      model(),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(result.text).toBe('http-ok');
    expect(driverCalls).toHaveLength(0); // CLI 驱动器零调用
  });
});
