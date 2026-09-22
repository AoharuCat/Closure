import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { enrichSlotAssignment, handleGenerateText, handleGenerateTextStream, registerModelGatewayIpc, resolveEmbeddingModel, resolveModel, wasAntigravityCliUsed, _resetAntigravityCliUsedForTest, _resetLaneWarnForTest } from '../main/ipc/modelGatewayIpc';
import { _resetBreakerForTest } from '../main/ipc/circuitBreaker';
import { ProtocolTimeoutError, setAntigravityCliGenerateForTest } from '@orison/model-protocols';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-gateway');
const ORIGINAL_FETCH = globalThis.fetch;

// C3.2 W1：熔断进程内态跨用例复位——本文件多处故意打 eligible 失败（超时/5xx），
// 不复位会在套件 <60s 窗口内跨用例累计中途 open，制造顺序依赖红（顶层兜住全部 describe）。
beforeEach(() => {
  _resetBreakerForTest();
});

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

// 09-12 agy provider：resolveModel 的第三形态装配（mirror thinkingKind/limits、vision
// 两轮的 conditional-spread 写法）。CLI 键：cliExecutable 挂上 + HTTP 凭据填 ''（字段
// 非可选保形）；HTTP 键：cliExecutable 键 ABSENT、凭据原值直通（?? 永不触发）；CLI 键
// 缺 cliExecutable（手改盘文件——读盘路径不经 refine）在解析点响亮报错。
describe('resolveModel CLI form assembly (09-12 agy provider)', () => {
  const AGY_KEY: ApiKeyEntry = {
    id: 'key_agy',
    name: 'Antigravity CLI',
    protocol: 'antigravity-cli',
    cliExecutable: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe',
    models: [
      { id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (high)', capability: 'text', enabled: true },
    ],
  };
  const HTTP_KEY: ApiKeyEntry = {
    id: 'key_http',
    name: 'HTTP relay',
    protocol: 'openai-compatible',
    apiKey: 'sk-http',
    baseUrl: 'https://relay.example.com/v1',
    models: [
      { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
    ],
  };
  const CONFIG: ModelConfig = { keys: [AGY_KEY, HTTP_KEY] };

  it('CLI 键 → cliExecutable 挂上 + baseUrl/apiKey 填 \'\'（协议层 CLI 驱动器消费面）', () => {
    const resolved = resolveModel({ keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' }, CONFIG);
    expect(resolved.protocol).toBe('antigravity-cli');
    expect(resolved.cliExecutable).toBe('C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe');
    expect(resolved.baseUrl).toBe('');
    expect(resolved.apiKey).toBe('');
  });

  it('CLI 键的 vision 标记形态感知省略（09-12 子2 W6——gemini-* registry 标 vision 但 CLI 通道不收 b64 图片，转述安全路径判据）', () => {
    const cliResolved = resolveModel({ keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' }, CONFIG);
    expect('vision' in cliResolved).toBe(false);
    // 对照：同族模型挂 HTTP 键 vision 照标（HTTP 行为零变化）。
    const AGY_MODEL_ON_HTTP: ApiKeyEntry = {
      id: 'key_gemini_http',
      name: 'Gemini HTTP relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-g',
      baseUrl: 'https://gemini.example.com/v1',
      models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro', capability: 'text', enabled: true }],
    };
    const httpResolved = resolveModel(
      { keyId: 'key_gemini_http', modelId: 'gemini-3.8-pro-high' },
      { keys: [AGY_MODEL_ON_HTTP] },
    );
    expect(httpResolved.vision).toBe(true);
  });

  it('HTTP 键 → cliExecutable 键 ABSENT + 凭据原值直通（零回归门）', () => {
    const resolved = resolveModel({ keyId: 'key_http', modelId: 'gpt-4o-mini' }, CONFIG);
    expect('cliExecutable' in resolved).toBe(false);
    expect(resolved.baseUrl).toBe('https://relay.example.com/v1');
    expect(resolved.apiKey).toBe('sk-http');
  });

  it('CLI 键缺 cliExecutable（病态盘文件）→ 解析点响亮报错（不静默降级 HTTP）', () => {
    const broken: ModelConfig = {
      keys: [{ ...AGY_KEY, cliExecutable: undefined }],
    };
    expect(() => resolveModel({ keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' }, broken))
      .toThrow(/cliExecutable/);
  });

  // ── CR-19（09-12 agy provider CR 批）：HTTP 键缺凭据响亮化 ──
  // 盘上手编坏配置（读盘路径不经 entry refine）此前被 `?? ''` 静默化成空凭据 →
  // 神秘网络失败；现在在 resolveModel 报配置错误（对齐 CLI 面）。
  it('HTTP 键缺 baseUrl → 解析点响亮报错（配置错误非神秘网络失败，CR-19）', () => {
    const broken: ModelConfig = { keys: [{ ...HTTP_KEY, baseUrl: undefined }] };
    expect(() => resolveModel({ keyId: 'key_http', modelId: 'gpt-4o-mini' }, broken))
      .toThrow(/baseUrl/);
  });

  it('HTTP 键缺 apiKey（含空串/空白串）→ 解析点响亮报错（CR-19）', () => {
    const noKey: ModelConfig = { keys: [{ ...HTTP_KEY, apiKey: undefined }] };
    expect(() => resolveModel({ keyId: 'key_http', modelId: 'gpt-4o-mini' }, noKey))
      .toThrow(/apiKey/);
    const blankKey: ModelConfig = { keys: [{ ...HTTP_KEY, apiKey: '   ' }] };
    expect(() => resolveModel({ keyId: 'key_http', modelId: 'gpt-4o-mini' }, blankKey))
      .toThrow(/apiKey/);
  });

  it('坏 HTTP 键不拖垮 embedding 自动探测（resolver catch → 跳过继续扫，CR-19 兼容面）', () => {
    const config: ModelConfig = {
      keys: [
        { ...HTTP_KEY, apiKey: undefined }, // 坏键（capability text）在扫描序首位
        {
          id: 'key_emb_ok',
          name: 'Emb OK',
          protocol: 'openai-compatible',
          apiKey: 'sk-emb',
          baseUrl: 'https://emb.example.com/v1',
          models: [{ id: 'bge-m3', alias: 'BGE M3', capability: 'embedding', enabled: true }],
        },
      ],
    };
    const resolved = resolveEmbeddingModel(config);
    expect(resolved?.keyId).toBe('key_emb_ok');
  });
});

// ── CR-20 + CR-15（09-12 agy provider CR 批）──
// CLI 形态豁免 CR-34 的 600s 非流式背景顶（driver 自带 print-timeout + belt 是唯一
// 时长闸）；handleGenerateText 的 CLI 解析同时置 CR-15 的 quit 守卫旗。
describe('CLI dispatch — ceiling exemption (CR-20) + quit-guard flag (CR-15)', () => {
  const CLI_TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-gateway-cli');
  const CLI_CONFIG: ModelConfig = {
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
    ],
  };

  beforeEach(async () => {
    _resetAntigravityCliUsedForTest();
    handle.mockReset();
    _setModelConfigDirForTest(CLI_TEST_MODEL_DIR);
    rmBestEffort(CLI_TEST_MODEL_DIR);
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1]({}, CLI_CONFIG);
  });

  afterEach(() => {
    setAntigravityCliGenerateForTest(undefined);
    _resetAntigravityCliUsedForTest();
    _setModelConfigDirForTest(null);
    rmBestEffort(CLI_TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('CLI background lane: 不套 600s 非流式顶（700s 仍挂；signal 原样直通）且置 quit 旗', async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined | null = null;
      // 挂死 CLI 驱动器（死进程形态）：只在所持 signal 中止时 reject——上限豁免只有在
      // 「永不自行结算」的调用上才可观察（mirror CR-34 hangingFetchMock 套路）。
      setAntigravityCliGenerateForTest((_model, _request, ctx) =>
        new Promise((_resolve, reject) => {
          seenSignal = ctx?.signal ?? null;
          const signal = ctx?.signal;
          const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }));

      const controller = new AbortController();
      const generating = handleGenerateText({
        ref: { keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' },
        request: {
          model: 'gemini-3.8-pro-high',
          messages: [{ role: 'user', content: 'hi' }],
          lane: 'background',
        },
      }, controller.signal);
      let settled = false;
      generating.then(() => { settled = true; }, () => { settled = true; });

      // 600s 顶（+100s 余量）不裁 CLI——print-timeout/belt 在 driver 内是唯一时长闸。
      await vi.advanceTimersByTimeAsync(700_000);
      expect(settled).toBe(false);
      // ceiling 包装会换 signal 对象（signalWithCeiling 返回 controller.signal）；
      // 豁免路径 signal 引用原样直通。
      expect(seenSignal).toBe(controller.signal);
      // CR-15：CLI 生成路径置 quit 守卫旗。
      expect(wasAntigravityCliUsed()).toBe(true);

      controller.abort(new DOMException('Aborted', 'AbortError'));
      await expect(generating).rejects.toThrow(/abort/i);
    } finally {
      vi.useRealTimers();
    }
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

// ── 09-12 子3 W3（design §4.1/§2#4）：resolveModel 的 per-model defaults limits 合成 + 九投影字段 ──
describe('resolveModel per-model defaults synthesis + projection fields (09-12 子3)', () => {
  const PARAMS_KEY: ApiKeyEntry = {
    id: 'key_p3',
    name: 'Params relay',
    protocol: 'openai-compatible',
    apiKey: 'sk-p3',
    baseUrl: 'https://relay.example.com/v1',
    models: [
      // registry-known（glm-5.3 全量 limits）+ 只填 contextWindow → 逐字段覆盖。
      { id: 'glm-5.3', alias: 'GLM 5.3', capability: 'text', enabled: true, defaults: { contextWindow: 8_000 } },
      // registry-unknown + 只填 maxOutputTokens → 单键 limits（未知模型显式覆盖形态）。
      { id: 'totally-unknown-model', alias: 'Unknown', capability: 'text', enabled: true, defaults: { maxOutputTokens: 4_096 } },
      // registry-unknown 无 defaults → limits ABSENT（既有语义回归锚）。
      { id: 'mystery-model', alias: 'Mystery', capability: 'text', enabled: true },
    ],
  };
  const CONFIG: ModelConfig = { keys: [PARAMS_KEY] };

  it('registry 有 × defaults 只填 contextWindow → 逐字段覆盖（sibling maxOutputTokens 保留）', () => {
    const resolved = resolveModel({ keyId: 'key_p3', modelId: 'glm-5.3' }, CONFIG);
    expect(resolved.limits).toEqual({ contextWindow: 8_000, maxOutputTokens: 131_072 });
    expect(resolved.thinkingKind).toBe('glm-forced-effort'); // 非 limits 派生字段不受合成影响
  });

  it('registry 无 × defaults 只填 maxOutputTokens → 单键 limits（contextWindow 不伪造）', () => {
    const resolved = resolveModel({ keyId: 'key_p3', modelId: 'totally-unknown-model' }, CONFIG);
    expect(resolved.limits).toEqual({ maxOutputTokens: 4_096 });
  });

  it('registry 无 × 无 defaults → limits 保持 ABSENT（协议层兜底语义零变化）', () => {
    const resolved = resolveModel({ keyId: 'key_p3', modelId: 'mystery-model' }, CONFIG);
    expect('limits' in resolved).toBe(false);
  });

  it('九投影字段条件展开（ABSENT 语义——零配置键全 ABSENT）', () => {
    const FULL_KEY: ApiKeyEntry = {
      id: 'key_full',
      name: 'Full face',
      protocol: 'openai-compatible',
      apiKey: 'sk-full',
      baseUrl: 'https://relay.example.com/v1',
      customHeaders: { 'X-Route-Tag': 'closure' },
      timeoutSeconds: 120,
      streamingDisabled: true,
      verifySsl: true,
      models: [
        {
          id: 'm-full',
          alias: 'Full',
          capability: 'text',
          enabled: true,
          defaults: { temperature: 0.7, topP: 0.9, frequencyPenalty: -0.2, presencePenalty: 0.3 },
          extraBody: { safe_prompt: true },
        },
        { id: 'm-plain', alias: 'Plain', capability: 'text', enabled: true },
      ],
    };
    const fullConfig: ModelConfig = { keys: [FULL_KEY] };
    const full = resolveModel({ keyId: 'key_full', modelId: 'm-full' }, fullConfig);
    expect(full.customHeaders).toEqual({ 'X-Route-Tag': 'closure' });
    expect(full.extraBody).toEqual({ safe_prompt: true });
    expect(full.defaultTemperature).toBe(0.7);
    expect(full.defaultTopP).toBe(0.9);
    expect(full.defaultFrequencyPenalty).toBe(-0.2);
    expect(full.defaultPresencePenalty).toBe(0.3);
    expect(full.timeoutSeconds).toBe(120);
    expect(full.verifySsl).toBe(true);
    expect(full.streamingDisabled).toBe(true);

    const plain = resolveModel({ keyId: 'key_p3', modelId: 'mystery-model' }, CONFIG);
    for (const absentKey of [
      'customHeaders', 'extraBody', 'defaultTemperature', 'defaultTopP',
      'defaultFrequencyPenalty', 'defaultPresencePenalty', 'timeoutSeconds', 'verifySsl', 'streamingDisabled',
    ] as const) {
      expect(absentKey in plain).toBe(false);
    }
  });
});

// ── 09-12 子3 W3（design §4.4）：slot assignment 的 contextWindow enrichment（runtime-only）──
describe('enrichSlotAssignment (09-12 子3 §4.4)', () => {
  const KEY: ApiKeyEntry = {
    id: 'key_e',
    name: 'Enrich relay',
    protocol: 'openai-compatible',
    apiKey: 'sk-e',
    baseUrl: 'https://relay.example.com/v1',
    models: [
      { id: 'unknown-m', alias: 'Unknown', capability: 'text', enabled: true, defaults: { contextWindow: 131_072 } },
      { id: 'plain-m', alias: 'Plain', capability: 'text', enabled: true },
    ],
  };
  const CONFIG: ModelConfig = { keys: [KEY] };

  it('key defaults.contextWindow → 注入 contextWindowTokens', () => {
    expect(enrichSlotAssignment({ keyId: 'key_e', modelId: 'unknown-m' }, CONFIG)).toEqual({
      keyId: 'key_e',
      modelId: 'unknown-m',
      contextWindowTokens: 131_072,
    });
  });

  it('模型无 defaults → 原样返回同一引用（恒等回退，零配置零行为变化）', () => {
    const assignment = { keyId: 'key_e', modelId: 'plain-m' };
    expect(enrichSlotAssignment(assignment, CONFIG)).toBe(assignment);
  });

  it('stale ref（键已删 / 模型不在键内）→ 原样返回同一引用（容错不抛）', () => {
    const gone = { keyId: 'key_gone', modelId: 'unknown-m' };
    expect(enrichSlotAssignment(gone, CONFIG)).toBe(gone);
    const wrongModel = { keyId: 'key_e', modelId: 'not-in-key' };
    expect(enrichSlotAssignment(wrongModel, CONFIG)).toBe(wrongModel);
  });

  it('assignment 缺席 → undefined；fallbacks 原样透传不碰（链上条目不获 enrichment）', () => {
    expect(enrichSlotAssignment(undefined, CONFIG)).toBeUndefined();
    const fallbacks = [{ keyId: 'key_e', modelId: 'plain-m' }];
    const withChain = { keyId: 'key_e', modelId: 'unknown-m', fallbacks };
    const enriched = enrichSlotAssignment(withChain, CONFIG);
    expect(enriched?.contextWindowTokens).toBe(131_072);
    expect(enriched?.fallbacks).toBe(fallbacks); // 同一引用——enrichment 的 spread 不碰链
    expect(enriched?.fallbacks?.[0]).toEqual({ keyId: 'key_e', modelId: 'plain-m' }); // 条目自身无 contextWindowTokens
  });

  // ── CR-4（09-12 子3 CR 批）注入侧 belt：非正整数 override 不注入 ──
  it('CR-4: 非正整数 override（0/负/小数）→ 原样返回同一引用（预算/压缩红线数学不被毒化到 0）', () => {
    for (const bad of [0, -5, 1.5]) {
      const KEY: ApiKeyEntry = {
        id: 'key_bad',
        name: 'Bad override',
        protocol: 'openai-compatible',
        apiKey: 'sk-bad',
        baseUrl: 'https://relay.example.com/v1',
        models: [{ id: 'unknown-m', alias: 'Unknown', capability: 'text', enabled: true, defaults: { contextWindow: bad } }],
      };
      const assignment = { keyId: 'key_bad', modelId: 'unknown-m' };
      expect(enrichSlotAssignment(assignment, { keys: [KEY] })).toBe(assignment);
    }
  });

  // ── CR-1（09-12 子3 CR 批）：缺省参数先评估的洞——assignment 缺席仍全量读盘 ──
  it('CR-1: assignment 缺席 → 零读盘（config 读移进守卫后——毒化 dir 若被读必抛）', () => {
    // 毒化 config dir：keys 路径被普通文件占用 → existsSync 真 + readdirSync 抛 ENOTDIR
    // → readModelConfigFromDisk 必抛。enrichSlotAssignment(undefined) 不抛即证零读盘。
    const LAZY_DIR = path.join(process.cwd(), 'test-tmp-model-gateway-lazy');
    _setModelConfigDirForTest(LAZY_DIR);
    rmBestEffort(LAZY_DIR);
    mkdirSync(LAZY_DIR, { recursive: true });
    writeFileSync(path.join(LAZY_DIR, 'keys'), 'not-a-dir', 'utf8');
    try {
      expect(enrichSlotAssignment(undefined)).toBeUndefined();
    } finally {
      _setModelConfigDirForTest(null);
      rmBestEffort(LAZY_DIR);
    }
  });
});

// ── 09-12 子3 W3（design §3 ⑩）：键级 streamingDisabled 保险丝——流式入口短路回非流式 ──
describe('streamingDisabled fuse (09-12 子3 §3 ⑩)', () => {
  const FUSE_CONFIG: ModelConfig = {
    keys: [
      {
        id: 'key_fuse',
        name: 'Broken SSE gateway',
        protocol: 'openai-compatible',
        apiKey: 'sk-fuse',
        baseUrl: 'https://relay.example.com/v1',
        streamingDisabled: true,
        models: [{ id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true }],
      },
    ],
  };

  async function seedFuseConfig() {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1]({}, FUSE_CONFIG);
  }

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

  it('禁流式键 → handleGenerateTextStream 走非流式：onDelta 不触发、body 无 stream 键、终帧直达', async () => {
    await seedFuseConfig();
    const responseBody = JSON.stringify({
      id: 'chatcmpl-fuse',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'complete frame' }, finish_reason: 'stop' }],
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

    const onDelta = vi.fn();
    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_fuse', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      },
      undefined,
      onDelta,
    );
    expect(result.text).toBe('complete frame'); // 终帧直达（功能完整）
    expect(onDelta).not.toHaveBeenCalled(); // 流式相位放弃
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fuseArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse((fuseArgs[1]?.body as string) ?? '{}');
    expect('stream' in body).toBe(false); // 非流式请求形态（流式 body 携带 stream:true）
  });

  it('未禁用键（回归锚）→ 流式路径照常（stream:true 在 body、onDelta 收帧）', async () => {
    await seedConfig();
    const fetchMock = vi.fn(async () => {
      const encoder = new TextEncoder();
      const frame = (payload: Record<string, unknown>) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', ...payload })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })));
          controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const onDelta = vi.fn();
    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_text', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      },
      undefined,
      onDelta,
    );
    expect(result.text).toBe('ok');
    expect(onDelta).toHaveBeenCalled();
    const streamArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse((streamArgs[1]?.body as string) ?? '{}');
    expect(body.stream).toBe(true);
  });

  // ── CR-14（09-12 子3 CR 批）：streamingDisabled per-attempt 混合 case ──
  // 主 key 禁流式 + 回退家在别的键（未禁）——链上每 attempt 各自按键判定：主 attempt
  // 走非流式（body 无 stream 键），回退 attempt 保留流式（stream:true + onDelta 收帧）。
  it('CR-14: 禁流式主 key + 可流式 fallback key 混合链——主 attempt 非流式 body、回退 attempt 流式 body + onDelta', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1](
      {},
      {
        keys: [
          {
            id: 'key_fuse',
            name: 'Broken SSE gateway',
            protocol: 'openai-compatible',
            apiKey: 'sk-fuse',
            baseUrl: 'https://fuse.example.com/v1',
            streamingDisabled: true,
            models: [{ id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true }],
          },
          {
            id: 'key_ok',
            name: 'SSE OK relay',
            protocol: 'openai-compatible',
            apiKey: 'sk-ok',
            baseUrl: 'https://ok.example.com/v1',
            models: [{ id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true }],
          },
        ],
      } satisfies ModelConfig,
    );

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://fuse.example.com')) {
        // 主 attempt（非流式）：502 → eligible 失败 → 链推进。
        return new Response(JSON.stringify({ error: { message: 'bad gateway' } }), {
          status: 502,
          headers: new Headers(),
        });
      }
      // 回退 attempt（流式）：OpenAI SSE 成功。
      const encoder = new TextEncoder();
      const frame = (payload: Record<string, unknown>) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', ...payload })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'rescued' }, finish_reason: null }] })));
          controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const onDelta = vi.fn();
    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_fuse', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_ok', modelId: 'gpt-4o-mini' } }],
      },
      undefined,
      onDelta,
    );

    expect(result.text).toBe('rescued');
    expect(result.modelRef).toEqual({ keyId: 'key_ok', modelId: 'gpt-4o-mini' });
    expect(onDelta).toHaveBeenCalled(); // 回退家的流式相位保留

    // 主 attempt：全部出站为非流式 body（无 stream 键；含协议层重试次数）。
    const fuseCalls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(
      ([url]) => String(url).startsWith('https://fuse.example.com'),
    );
    expect(fuseCalls.length).toBeGreaterThan(0);
    for (const call of fuseCalls) {
      const body = JSON.parse((call[1]?.body as string) ?? '{}');
      expect('stream' in body).toBe(false);
    }
    // 回退 attempt：流式 body（stream:true）恰一次成功出站。
    const okCalls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(
      ([url]) => String(url).startsWith('https://ok.example.com'),
    );
    expect(okCalls).toHaveLength(1);
    const okBody = JSON.parse((okCalls[0]![1]?.body as string) ?? '{}');
    expect(okBody.stream).toBe(true);
  });
});
