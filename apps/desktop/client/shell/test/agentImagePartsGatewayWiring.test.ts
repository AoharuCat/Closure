/**
 * B3 generate 缝 wiring 测试（task 09-01 / design §2.3）：handleGenerateText 与
 * handleGenerateTextStream（流式/非流式双路径）都在 resolveModel 之后调
 * resolveImageParts，且改写后的 messages 真正流到协议层出站请求。
 *
 * mock 面：electron（ipcMain/safeStorage/app——configIpc 种子配置，mirror
 * modelGatewayIpc.test.ts）+ agentImageParts（resolveImageParts spy——本文件钉的是
 * gateway 的调用姿势与改写穿透，resolveImageParts 自身行为在 agentImageParts.test.ts）。
 * 真实面：configIpc + modelGatewayIpc + model-protocols（fetch 级 mock 断言出站 body）。
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

// 只替 resolveImageParts——modelGatewayIpc 对该模块的依赖面就这一个导出。
vi.mock('../main/ipc/agentImageParts', () => ({ resolveImageParts: resolveImagePartsMock }));

import { _setModelConfigDirForTest, registerConfigIpc } from '../main/ipc/configIpc';
import { handleGenerateText, handleGenerateTextStream } from '../main/ipc/modelGatewayIpc';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-agent-image-parts-wiring');
const ORIGINAL_FETCH = globalThis.fetch;

const OPENAI_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_text',
      name: 'Text',
      protocol: 'openai-compatible',
      apiKey: 'sk-text',
      baseUrl: 'https://relay.example.com/v1',
      models: [{ id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true }],
    },
  ],
};

const ANTHROPIC_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_ant',
      name: 'Anthropic',
      protocol: 'anthropic-compatible',
      apiKey: 'sk-ant',
      baseUrl: 'https://anthropic.example.com',
      models: [{ id: 'claude-3-5-sonnet-latest', alias: 'Claude', capability: 'text', enabled: true }],
    },
  ],
};

async function seedConfig(config: ModelConfig) {
  registerConfigIpc();
  const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
  if (!saveCall) throw new Error('config:save-model handler not registered');
  await saveCall[1]({}, config);
}

/** spy 默认实现：指针 part → 文本 part（模拟转述/降级替换），可断言改写穿透到出站。 */
function installRewriteImpl() {
  resolveImagePartsMock.mockImplementation(async (messages: unknown[]) =>
    messages.map((m) => {
      if (typeof m !== 'object' || m === null) return m;
      const msg = m as { content?: unknown };
      if (!Array.isArray(msg.content)) return m;
      return {
        ...msg,
        content: msg.content.map((p) =>
          typeof p === 'object' && p !== null && (p as { type?: string }).type === 'image'
            ? { type: 'text', text: 'REWRITTEN-FROM-IMAGE-PART' }
            : p,
        ),
      };
    }),
  );
}

// 指针形态是 agent 缝的可信入参（agentIpc 直调不经 zod parse；渲染端直调从不带图）——
// 对契约类型（GenerationMessage 只认 b64 image part）以 as 过缝，语义即「线上指针」。
const IMAGE_MESSAGES: unknown[] = [
  { role: 'user', content: '开场' },
  { role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image', image: { path: 'inbox/images/cat.png', b64hash: 'deadbeef' } }] },
];

type GatewayMessages = Parameters<typeof handleGenerateText>[0]['request']['messages'];

function openAiCompletionBody(): string {
  return JSON.stringify({
    id: 'chatcmpl-wiring',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

/** Anthropic SSE wire event → framed chunk。 */
function anthEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function requestBodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(callArgs[1].body as string);
}

beforeEach(() => {
  handle.mockReset();
  resolveImagePartsMock.mockReset();
  installRewriteImpl();
  _setModelConfigDirForTest(TEST_MODEL_DIR);
  rmBestEffort(TEST_MODEL_DIR);
});

afterEach(() => {
  _setModelConfigDirForTest(null);
  rmBestEffort(TEST_MODEL_DIR);
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('B3 generate 缝 wiring（双 handler 同罩）', () => {
  it('handleGenerateText：resolveModel 之后先调 resolveImageParts，改写流到出站 body', async () => {
    await seedConfig(OPENAI_CONFIG);
    const fetchMock = vi.fn(async () => textResponse(openAiCompletionBody()));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const signal = new AbortController().signal;

    const result = await handleGenerateText(
      {
        ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: IMAGE_MESSAGES as GatewayMessages },
      },
      signal,
    );

    expect(result.text).toBe('ok');
    expect(resolveImagePartsMock).toHaveBeenCalledTimes(1);
    const [messagesArg, resolvedArg, depsArg] = resolveImagePartsMock.mock.calls[0] as unknown as [
      unknown[],
      { modelId: string; vision?: boolean },
      { signal?: AbortSignal },
    ];
    expect(messagesArg).toBe(IMAGE_MESSAGES); // 原数组引用直通
    expect(resolvedArg.modelId).toBe('gpt-4o-mini');
    expect(resolvedArg.vision).toBe(true); // resolveModel 已跑完（registry vision 标记随行）
    expect(depsArg.signal).toBe(signal); // CR-007：既有 signal 经 deps 贯穿（转述取消通道同源）

    // 改写穿透：出站 messages 不再含 image part，含替换文本。
    const body = requestBodyOf(fetchMock);
    expect(JSON.stringify(body.messages)).not.toContain('deadbeef');
    expect(JSON.stringify(body.messages)).toContain('REWRITTEN-FROM-IMAGE-PART');
  });

  it('handleGenerateTextStream：同一处理层同罩（流式路径改写亦穿透 + delta/终帧不受影响）', async () => {
    await seedConfig(ANTHROPIC_CONFIG);
    const chunks = [
      anthEvent('message_start', { message: { usage: { input_tokens: 5 } } }),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '好' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      anthEvent('message_stop'),
    ];
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const deltas: string[] = [];
    const signal = new AbortController().signal;
    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_ant', modelId: 'claude-3-5-sonnet-latest' },
        request: { model: 'claude-3-5-sonnet-latest', messages: IMAGE_MESSAGES as GatewayMessages },
      },
      signal,
      (d) => {
        if (d.type === 'text') deltas.push(d.delta);
      },
    );

    expect(result.text).toBe('好');
    expect(deltas).toEqual(['好']);
    expect(resolveImagePartsMock).toHaveBeenCalledTimes(1);
    const [messagesArg, resolvedArg, depsArg] = resolveImagePartsMock.mock.calls[0] as unknown as [
      unknown[],
      { modelId: string },
      { signal?: AbortSignal },
    ];
    expect(messagesArg).toBe(IMAGE_MESSAGES);
    expect(resolvedArg.modelId).toBe('claude-3-5-sonnet-latest');
    expect(depsArg.signal).toBe(signal); // CR-007：流式路径 signal 同样贯穿
    const body = requestBodyOf(fetchMock);
    expect(JSON.stringify(body.messages)).not.toContain('deadbeef');
    expect(JSON.stringify(body.messages)).toContain('REWRITTEN-FROM-IMAGE-PART');
  });
});
