import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import type { ApiKeyEntry, ModelConfig } from '@orison/shared-contracts';

const { handle, safeStorage } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  // 08-25 背景：registerConfigIpc 注册期 allowPath(userData/wallpaper) → mock getPath。
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

import { _setModelConfigDirForTest, registerConfigIpc } from '../main/ipc/configIpc';
import { handleGenerateText, handleGenerateTextStream, registerModelGatewayIpc, resolveEmbeddingModel, resolveModel, _resetLaneWarnForTest } from '../main/ipc/modelGatewayIpc';
import { ProtocolTimeoutError } from '@orison/model-protocols';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-gateway');
const ORIGINAL_FETCH = globalThis.fetch;

/**
 * 挂死 fetch（死端点形态）：只在所持 signal 中止时 reject。CR-34/CR-35 各用例共用——
 * 上限/看门狗语义只有在「永不自行结算」的 fetch 上才可观察。
 */
function hangingFetchMock() {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    }));
}

const SAMPLE_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_text',
      name: 'Text',
      protocol: 'openai-compatible',
      apiKey: 'sk-text',
      baseUrl: 'https://relay.example.com/v1',
      models: [
        { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
        { id: 'dall-e-3', alias: 'DALL-E 3', capability: 'image', enabled: true },
        { id: 'sora-1', alias: 'Sora 1', capability: 'video', enabled: true },
      ],
    },
  ],
};

async function seedConfig() {
  registerConfigIpc();
  const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
  await saveCall![1]({}, SAMPLE_CONFIG);
}

function pickHandler(channel: string) {
  const call = handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`handler not registered: ${channel}`);
  return call[1] as (event: unknown, payload: unknown) => Promise<unknown>;
}

describe('model gateway IPC', () => {
  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('generate-text dispatches to /chat/completions with Bearer apiKey', async () => {
    await seedConfig();
    registerModelGatewayIpc();

    const responseBody = JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => JSON.parse(responseBody),
      text: async () => responseBody,
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const handler = pickHandler('model:generate-text');
    const result = (await handler({}, {
      ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
      request: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })) as { text: string };

    expect(result.text).toBe('hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[0]).toBe('https://relay.example.com/v1/chat/completions');
    const init = callArgs[1];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-text');
  });

  it('does not leak apiKey in the IPC return value', async () => {
    await seedConfig();
    registerModelGatewayIpc();

    const body = JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => JSON.parse(body),
      text: async () => body,
    } as unknown as Response)) as unknown as typeof globalThis.fetch;

    const handler = pickHandler('model:generate-text');
    const result = await handler({}, {
      ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
      request: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(JSON.stringify(result)).not.toContain('sk-text');
  });

  it('passes an abort signal through to the provider request', async () => {
    await seedConfig();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      receivedSignal = input instanceof Request ? input.signal : init?.signal;
      receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const generating = handleGenerateText({
      ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
      request: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      },
    }, controller.signal);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(receivedSignal).toBe(controller.signal);
    controller.abort(new DOMException('Aborted', 'AbortError'));

    await expect(generating).rejects.toThrow(/aborted/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── dogfood R2 CR-34（#50 关严）：非流式 background 路径 600s 硬上限 ──
  // bounded 回落此前只在 generateTextStream 里；无 onDelta 的 background 调用走
  // handleGenerateText 无任何时长界。三条用例钉：上限生效（超时形态 ProtocolTimeoutError）、
  // interactive 零回归（无上限 + 取消穿透）、调用方取消优先于超时映射（CR-33 同序）。

  it('non-streaming background lane: 600s hard ceiling fires as ProtocolTimeoutError (CR-34)', async () => {
    await seedConfig();
    vi.useFakeTimers();
    try {
      const fetchMock = hangingFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const generating = handleGenerateText({
        ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
        request: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          lane: 'background',
        },
      });
      const rejection = generating.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );
      let settled = false;
      generating.then(() => { settled = true; }, () => { settled = true; });

      // 上限之前：仍在挂（一次 fetch、无重试风暴、无提前失败）。
      await vi.advanceTimersByTimeAsync(599_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      // 过 600s 硬上限 → 按现有超时错误形态上抛。
      await vi.advanceTimersByTimeAsync(2_000);
      const err = await rejection;
      expect(err).toBeInstanceOf(ProtocolTimeoutError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-streaming interactive (no lane): no ceiling — still hanging at 700s; caller abort still propagates (CR-34)', async () => {
    await seedConfig();
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchMock = hangingFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const generating = handleGenerateText({
        ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
        request: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
        },
      }, controller.signal);
      let settled = false;
      generating.then(() => { settled = true; }, () => { settled = true; });

      // interactive 语义零改动：无 600s 上限，700s 仍挂起（对照上一用例的 background 600s）。
      await vi.advanceTimersByTimeAsync(700_000);
      expect(settled).toBe(false);

      controller.abort(new DOMException('Aborted', 'AbortError'));
      await expect(generating).rejects.toThrow(/abort/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-streaming background lane: caller cancel before the ceiling stays an abort, never flattened into timeout (CR-34)', async () => {
    await seedConfig();
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchMock = hangingFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const generating = handleGenerateText({
        ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
        request: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          lane: 'background',
        },
      }, controller.signal);
      const rejection = generating.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );

      await vi.advanceTimersByTimeAsync(120_000); // 远在 600s 上限内
      controller.abort(new DOMException('Aborted', 'AbortError'));
      const err = await rejection;
      // CR-33 同序保护：主动取消优先于超时映射——不是 ProtocolTimeoutError，是 abort。
      expect(err).not.toBeInstanceOf(ProtocolTimeoutError);
      expect(/abort/i.test(String((err as Error).message))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when the key does not exist', async () => {
    await seedConfig();
    registerModelGatewayIpc();

    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not be called');
    }) as unknown as typeof globalThis.fetch;

    const handler = pickHandler('model:generate-text');
    await expect(
      handler({}, {
        ref: { keyId: 'unknown', modelId: 'gpt-4o-mini' },
        request: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      }),
    ).rejects.toThrow();
  });

  it('rejects an explicitly-referenced disabled model and never calls the provider', async () => {
    // Disabling a model in settings must actually stop calls that reference it.
    // A session bound to a now-disabled model must error, not silently dispatch.
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1]({}, {
      keys: [
        {
          id: 'key_text',
          name: 'Text',
          protocol: 'openai-compatible',
          apiKey: 'sk-text',
          baseUrl: 'https://relay.example.com/v1',
          models: [
            { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: false },
          ],
        },
      ],
    } satisfies ModelConfig);
    registerModelGatewayIpc();

    const fetchMock = vi.fn(async () => {
      throw new Error('should not be called');
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const handler = pickHandler('model:generate-text');
    await expect(
      handler({}, {
        ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      }),
    ).rejects.toThrow(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renderer direct-call payload carrying request.thinking passes the IPC boundary (08-25)', async () => {
    // generateTextPayloadSchema embeds textGenerationRequestSchema directly
    // (no independent shell-side schema), and S1 added `thinking` there — so the
    // renderer-facing model:generate-text channel accepts thinking-bearing
    // payloads with zero shell changes. This pins that boundary acceptance: a
    // thinking payload parses and dispatches (whether the protocol layer ACTS
    // on it is model-protocols/S2 territory, out of scope here).
    await seedConfig();
    registerModelGatewayIpc();

    const responseBody = JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'thoughtful' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => JSON.parse(responseBody),
      text: async () => responseBody,
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const handler = pickHandler('model:generate-text');
    const result = (await handler({}, {
      ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
      request: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { level: 'high' },
      },
    })) as { text: string };

    expect(result.text).toBe('thoughtful');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('generate-embedding dispatches to /embeddings and maps data[] in input order', async () => {
    await seedConfig();
    registerModelGatewayIpc();

    const responseBody = JSON.stringify({
      model: 'gpt-4o-mini',
      data: [
        { embedding: [0.1, 0.2] },
        { embedding: [0.3, 0.4] },
      ],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => JSON.parse(responseBody),
      text: async () => responseBody,
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const handler = pickHandler('model:generate-embedding');
    const result = (await handler({}, {
      ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
      request: { input: ['a', 'b'] },
    })) as { model: string; embeddings: number[][]; usage?: { promptTokens?: number; totalTokens?: number } };

    expect(result.embeddings).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.usage?.totalTokens).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[0]).toBe('https://relay.example.com/v1/embeddings');
    expect((callArgs[1].headers as Record<string, string>).authorization).toBe('Bearer sk-text');
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.input).toEqual(['a', 'b']);
  });

});

// resolveModel assembly of registry-derived thinking kind + limits (08-25 S3):
// resolveModelInfo carries both (incl. the basename second-pass), and
// resolveModel attaches them to ResolvedModel with keys ABSENT for unknown
// models — the protocol layer's fallback semantics key off that absence.
// Explicit-config calls only; no disk seeding needed.
describe('resolveModel thinking/limits assembly (08-25)', () => {
  const KEY: ApiKeyEntry = {
    id: 'key_kind',
    name: 'Kind relay',
    protocol: 'openai-compatible',
    apiKey: 'sk-kind',
    baseUrl: 'https://relay.example.com/v1',
    models: [
      { id: 'glm-5.3', alias: 'GLM 5.3', capability: 'text', enabled: true },
      { id: 'Pro/GLM/glm-5.2', alias: 'GLM 5.2', capability: 'text', enabled: true },
      { id: 'qwen-max', alias: 'Qwen Max', capability: 'text', enabled: true },
    ],
  };
  const CONFIG: ModelConfig = { keys: [KEY] };

  it('known model → thinkingKind + limits attached', () => {
    const resolved = resolveModel({ keyId: 'key_kind', modelId: 'glm-5.3' }, CONFIG);
    expect(resolved.thinkingKind).toBe('glm-forced-effort');
    expect(resolved.limits).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 131_072 });
  });

  it('aggregator-prefixed id → basename second-pass carries the kind', () => {
    const resolved = resolveModel({ keyId: 'key_kind', modelId: 'Pro/GLM/glm-5.2' }, CONFIG);
    expect(resolved.thinkingKind).toBe('glm-dynamic-effort');
    expect(resolved.limits).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 131_072 });
  });

  it('registry family without thinking data → keys ABSENT (guardrail fallback semantics)', () => {
    const resolved = resolveModel({ keyId: 'key_kind', modelId: 'qwen-max' }, CONFIG);
    expect('thinkingKind' in resolved).toBe(false);
    expect('limits' in resolved).toBe(false);
  });
});

// B1 附件（R2.4，09-01）：resolveModel 的 registry 派生 vision 布尔——第三轮同型 additive
//（mirror thinkingKind/limits 两轮验证的写法）。true = 确定性多模态（图片 b64 直传）；
// ABSENT = 未验证（≠不支持），B3 的 generate 缝按 ABSENT 走 visionModel 转述安全路径。
describe('resolveModel vision assembly (B1)', () => {
  const KEY: ApiKeyEntry = {
    id: 'key_vision',
    name: 'Vision relay',
    protocol: 'openai-compatible',
    apiKey: 'sk-vision',
    baseUrl: 'https://relay.example.com/v1',
    models: [
      { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
      { id: 'qwen2.5-vl-72b-instruct', alias: 'Qwen VL', capability: 'text', enabled: true },
      { id: 'Pro/GLM/glm-4.5v', alias: 'GLM 4.5V', capability: 'text', enabled: true },
      { id: 'qwen-max', alias: 'Qwen Max', capability: 'text', enabled: true },
    ],
  };
  const CONFIG: ModelConfig = { keys: [KEY] };

  it('vision 家族条目 → vision: true 挂到 ResolvedModel', () => {
    const resolved = resolveModel({ keyId: 'key_vision', modelId: 'gpt-4o-mini' }, CONFIG);
    expect(resolved.vision).toBe(true);
    // qwen*vl* 新模式（置于 qwen-* 之前的 specific entry）。
    expect(resolveModel({ keyId: 'key_vision', modelId: 'qwen2.5-vl-72b-instruct' }, CONFIG).vision).toBe(true);
  });

  it('vision 与 thinking 双标记家族 + basename 二轮匹配携带 vision（glm-4.5v）', () => {
    const resolved = resolveModel({ keyId: 'key_vision', modelId: 'Pro/GLM/glm-4.5v' }, CONFIG);
    expect(resolved.vision).toBe(true);
    expect(resolved.thinkingKind).toBe('glm-forced-basic');
  });

  it('未标家族 → vision 键 ABSENT（≠undefined 值；转述安全路径语义）', () => {
    const resolved = resolveModel({ keyId: 'key_vision', modelId: 'qwen-max' }, CONFIG);
    expect('vision' in resolved).toBe(false);
  });
});

// resolveEmbeddingModel takes an optional ModelConfig so it is unit-testable
// without disk I/O — these tests pass configs directly and never seed the keys
// dir, so they run under plain vitest (no better-sqlite3 ABI concern).
describe('resolveEmbeddingModel', () => {
  const EMB_KEY: ApiKeyEntry = {
    id: 'key_emb',
    name: 'Embeddings',
    protocol: 'openai-compatible',
    apiKey: 'sk-emb',
    baseUrl: 'https://embed.example.com/v1',
    models: [
      { id: 'bge-m3', alias: 'BGE M3', capability: 'embedding', enabled: true },
      { id: 'text-embedding-3-small', alias: 'Text Embed 3 Small', capability: 'embedding', enabled: true },
    ],
  };
  const TEXT_KEY: ApiKeyEntry = {
    id: 'key_text2',
    name: 'Text',
    protocol: 'openai-compatible',
    apiKey: 'sk-text2',
    baseUrl: 'https://text.example.com/v1',
    models: [
      { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
    ],
  };

  it('(a) explicit embeddingModel valid → returns it', () => {
    const config: ModelConfig = {
      keys: [EMB_KEY, TEXT_KEY],
      embeddingModel: { keyId: 'key_emb', modelId: 'bge-m3' },
    };
    const resolved = resolveEmbeddingModel(config);
    expect(resolved).not.toBeNull();
    expect(resolved!.keyId).toBe('key_emb');
    expect(resolved!.modelId).toBe('bge-m3');
    expect(resolved!.capability).toBe('embedding');
    expect(resolved!.apiKey).toBe('sk-emb');
  });

  it('(e) explicit embeddingModel wins over an also-present embedding-capable model', () => {
    // Path 2 alone would pick bge-m3 (first in iteration). Explicit must win.
    const config: ModelConfig = {
      keys: [EMB_KEY],
      embeddingModel: { keyId: 'key_emb', modelId: 'text-embedding-3-small' },
    };
    expect(resolveEmbeddingModel(config)!.modelId).toBe('text-embedding-3-small');
  });

  it('(b) explicit embeddingModel stale (unknown key) → falls back to auto candidate, never throws', () => {
    const config: ModelConfig = {
      keys: [EMB_KEY],
      embeddingModel: { keyId: 'unknown-key', modelId: 'whatever' },
    };
    const resolved = resolveEmbeddingModel(config);
    expect(resolved).not.toBeNull();
    expect(resolved!.modelId).toBe('bge-m3'); // auto-detected first embedding model
  });

  it('(b2) explicit embeddingModel disabled → falls back to another enabled embedding model', () => {
    const disabledFirst: ApiKeyEntry = {
      ...EMB_KEY,
      models: [
        { id: 'bge-m3', alias: 'BGE M3', capability: 'embedding', enabled: false },
        { id: 'text-embedding-3-small', alias: 'TE3S', capability: 'embedding', enabled: true },
      ],
    };
    const config: ModelConfig = {
      keys: [disabledFirst],
      embeddingModel: { keyId: 'key_emb', modelId: 'bge-m3' }, // disabled → fall through
    };
    expect(resolveEmbeddingModel(config)!.modelId).toBe('text-embedding-3-small');
  });

  it('(b3) explicit stale ref + no embedding-capable model → null (no throw)', () => {
    const config: ModelConfig = {
      keys: [TEXT_KEY],
      embeddingModel: { keyId: 'unknown-key', modelId: 'whatever' },
    };
    expect(resolveEmbeddingModel(config)).toBeNull();
  });

  it('(c) no explicit field + one enabled embedding-capable model → auto-picks it', () => {
    const config: ModelConfig = { keys: [TEXT_KEY, EMB_KEY] };
    const resolved = resolveEmbeddingModel(config);
    expect(resolved!.modelId).toBe('bge-m3');
    expect(resolved!.capability).toBe('embedding');
  });

  it('(d) no explicit field + no embedding-capable model → null', () => {
    const config: ModelConfig = { keys: [TEXT_KEY] };
    expect(resolveEmbeddingModel(config)).toBeNull();
  });

  it('explicit override honors a non-embedding-capability model (self-hosted, unusual id)', () => {
    // resolveEmbeddingModel uses the explicit ref even when its capability is
    // not 'embedding' — e.g. a self-hosted model whose id matches no registry
    // pattern. The user's explicit choice is authoritative.
    const config: ModelConfig = {
      keys: [TEXT_KEY],
      embeddingModel: { keyId: 'key_text2', modelId: 'gpt-4o-mini' },
    };
    const resolved = resolveEmbeddingModel(config);
    expect(resolved!.modelId).toBe('gpt-4o-mini');
    expect(resolved!.capability).toBe('text');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 1: handleGenerateTextStream — same resolveModel + request
// as handleGenerateText, but deltas surface via onDelta before the terminal
// frame (design §2). Exercised through the REAL protocol stack
// (model-protocols generateTextStream, anthropic SSE path) with a fetch-level
// mock, so the assertions pin the gateway's own responsibilities: model
// resolution, request/signal/onDelta forwarding, delta passthrough, terminal
// frame return. Framing edge cases live in model-protocols' streaming tests.
// ─────────────────────────────────────────────────────────────────────────────

const STREAM_TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-gateway-stream');

const ANTHROPIC_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_ant',
      name: 'Anthropic',
      protocol: 'anthropic-compatible',
      apiKey: 'sk-ant',
      baseUrl: 'https://anthropic.example.com',
      models: [
        { id: 'claude-3-5-sonnet-latest', alias: 'Claude', capability: 'text', enabled: true },
      ],
    },
  ],
};

/** Anthropic SSE wire event → framed chunk (`event:` + `data:` + blank line). */
function anthEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** SSE-shaped Response (all chunks enqueued up front, then close). */
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

describe('model gateway streaming (handleGenerateTextStream)', () => {
  beforeEach(async () => {
    handle.mockReset();
    _setModelConfigDirForTest(STREAM_TEST_MODEL_DIR);
    rmBestEffort(STREAM_TEST_MODEL_DIR);
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1]({}, ANTHROPIC_CONFIG);
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(STREAM_TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('forwards reasoning + text deltas through onDelta and returns the terminal frame', async () => {
    const chunks = [
      anthEvent('message_start', { message: { usage: { input_tokens: 11 } } }),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '推理' } }),
      anthEvent('content_block_stop', { index: 0 }),
      anthEvent('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '你' } }),
      anthEvent('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '好' } }),
      anthEvent('content_block_stop', { index: 1 }),
      anthEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
      anthEvent('message_stop'),
    ];
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const deltas: Array<{ type: string; delta: string }> = [];
    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_ant', modelId: 'claude-3-5-sonnet-latest' },
        request: {
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
      undefined,
      (d) => deltas.push(d),
    );

    // Deltas pass through the gateway unmodified, in wire order.
    expect(deltas).toEqual([
      { type: 'reasoning', delta: '推理' },
      { type: 'text', delta: '你' },
      { type: 'text', delta: '好' },
    ]);

    // Terminal frame (single source of truth for the caller).
    expect(result.text).toBe('你好');
    expect(result.reasoning).toBe('推理');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });

    // Wire shape: resolved key's baseUrl (+/v1), decrypted apiKey header,
    // streaming request body with the D2 maxTokens guardrail.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[0]).toBe('https://anthropic.example.com/v1/messages');
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(32768);
  });

  it('rejects when the key does not exist (resolveModel stays in the stream path)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not be called');
    }) as unknown as typeof globalThis.fetch;

    await expect(
      handleGenerateTextStream(
        {
          ref: { keyId: 'unknown', modelId: 'claude-3-5-sonnet-latest' },
          request: {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
          },
        },
        undefined,
        () => {},
      ),
    ).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // dogfood R2 #7: request.lane threads through the gateway into the REAL
  // protocol context — a background lane widens the first-event window to 240s
  // (at the interactive 61s mark the stream is still inside attempt 1: exactly
  // one fetch, no quick retry), while the caller's own signal still aborts
  // through the composed guard.
  it('request.lane:"background" → protocol ctx uses the 240s window (still 1 fetch at 61s); caller abort still propagates', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const promise = handleGenerateTextStream(
        {
          ref: { keyId: 'key_ant', modelId: 'claude-3-5-sonnet-latest' },
          request: {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
            lane: 'background',
          },
        },
        controller.signal,
        () => {},
      );
      const rejection = promise.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );

      // Interactive lanes would have fired the 60s watchdog → quick retry → a
      // second fetch by now. Background window: still attempt 1.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      controller.abort();
      const err = await rejection;
      expect((err as Error).name).toBe('AbortError');
      expect(fetchMock).toHaveBeenCalledTimes(1); // deliberate abort: no retry, no fallback
    } finally {
      vi.useRealTimers();
    }
  });

  // dogfood R2 CR-35：lane 越界值穿 IPC——枚举外值（陈旧/typo）经 safeParse 归一
  // undefined（= interactive 语义：60s 窗 + 连接窗快速重试），warn 只打一次。对照上一
  // 用例（合法 'background' 在 61s 仍是第 1 次 fetch、240s 窗）。
  it('invalid lane value → normalized to undefined (interactive 60s window + quick retry); warn logged once (CR-35)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      _resetLaneWarnForTest();
      const fetchMock = hangingFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const generating = handleGenerateTextStream(
        {
          ref: { keyId: 'key_ant', modelId: 'claude-3-5-sonnet-latest' },
          request: {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
            lane: 'backgrounds', // typo：渲染端陈旧/拼写错误形态
          },
        } as unknown as Parameters<typeof handleGenerateTextStream>[0],
        undefined,
        () => {},
      );
      const rejection = generating.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );

      // 归一成 interactive：61s 时 60s 看门狗已触发 + 快速重试 → 第 2 次 fetch
      //（合法 background 车道此刻仍是第 1 次——见上一用例）。
      await vi.advanceTimersByTimeAsync(61_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const laneWarns = warnSpy.mock.calls.filter((c) => String(c[0] ?? '').includes('not a valid GenerationLane'));
      expect(laneWarns).toHaveLength(1);
      expect(String(laneWarns[0][0])).toContain('backgrounds'); // 日志带原值可查

      // 跑完第二窗（~121s）→ interactive 红线：超时直抛，无 background 回落。
      await vi.advanceTimersByTimeAsync(65_000);
      const err = await rejection;
      expect(err).toBeInstanceOf(ProtocolTimeoutError);

      // 同会话第二次非法值（不同形态）：warn-once 门保持，不再刷。
      const second = handleGenerateTextStream(
        {
          ref: { keyId: 'key_ant', modelId: 'claude-3-5-sonnet-latest' },
          request: {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
            lane: 42,
          },
        } as unknown as Parameters<typeof handleGenerateTextStream>[0],
        undefined,
        () => {},
      );
      const secondRejection = second.then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(130_000);
      await secondRejection;
      expect(warnSpy.mock.calls.filter((c) => String(c[0] ?? '').includes('not a valid GenerationLane'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});
