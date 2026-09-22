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
  _resetBreakerForTest,
  _setBreakerClockForTest,
  peekBreakerState,
} from '../main/ipc/circuitBreaker';
import {
  classifyCliError,
  classifyGenerationFailure,
  CircuitOpenError,
  BudgetExceededError,
  FallbackChainExhaustedError,
  ProtocolContextOverflowError,
  ProtocolHttpError,
  setAntigravityCliGenerateForTest,
  setBudgetGate,
  setGenerationUsageSink,
} from '@orison/model-protocols';
import type { GenerationCallRecord } from '@orison/model-protocols';
import { BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD } from '../main/ipc/circuitBreaker';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-gateway-fallback');
const ORIGINAL_FETCH = globalThis.fetch;

// C3.2 W1：熔断进程内态跨用例复位（must-add）——既有用例故意打 eligible 失败（429/503/
// timeout），不复位会在套件 <60s 窗口内跨用例累计到阈值中途 open，制造顺序依赖红。
// 顶层 beforeEach 先于各 describe 级 beforeEach 执行，全文件统一兜住。
beforeEach(() => {
  _resetBreakerForTest();
});

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

  it('跨形态链：A CLI 的 MCP 预授权软拒 → 直抛不烧链（B 零出站——会话授权事实与模型无关）', async () => {
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
    // CLI 驱动器 mock：抛**真实分类产物**——MCP 主体软拒 stderr → 合成 412（other/ineligible）。
    setAntigravityCliGenerateForTest(async () => {
      throw classifyCliError(
        'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
        'jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.',
      );
    });
    const fetchMock = urlRoutingFetch({
      'https://b.example.com/v1': () => openAiTextResponse('should not be reached'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const err = await handleGenerateText({
      ref: { keyId: 'key_agy', modelId: 'gemini-3.8-pro-high' },
      request: { model: 'gemini-3.8-pro-high', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    // 原错误原样上抛（412 合成状态 → 回退分类 other/ineligible，链不推进）；文案指预授权出路。
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(412);
    expect((err as ProtocolHttpError).message).toContain('pre-authorization');
    // B 零出站（同一条桥/同一套预授权，换模型撞同一堵墙——烧一轮纯浪费）。
    expect(fetchMock).toHaveBeenCalledTimes(0);
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

// ═════════════════════════════════════════════════════════════════════════════
// C3.1 计量台账 W3 装配：网关 callId 贯穿——callId 在回退环**外**恰生成一次，
// 每 attempt（含跨模型回退推进 / streamingDisabled 短路）共享同一 call_id；sessionId
// 三跳的网关面（wire 字段经环的原始载荷重建逐 attempt 不丢）。真协议层 + fetch 桩 +
// sink 捕获（列级落库归 usageLedgerWiring 钉）。删 executeNonStreamingAttempt /
// generateTextStream ctx 上的 callId 透传即红（接线钉法 mirror CR-001）。
// ═════════════════════════════════════════════════════════════════════════════
describe('gateway callId 贯穿（C3.1 W3 装配）', () => {
  const records: GenerationCallRecord[] = [];

  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    resolveImagePartsMock.mockImplementation(async (messages: unknown[]) => messages);
    records.length = 0;
    setGenerationUsageSink((r) => records.push(r));
  });

  afterEach(async () => {
    setGenerationUsageSink(undefined);
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    resolveImagePartsMock.mockReset();
    vi.restoreAllMocks();
  });

  it('非流式回退环 A 429 → B 成功（跨模型）：恰两 attempt 行共享同一 callId、model_id 互异（AC5 证据）；sessionId 逐 attempt 到达', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-gw-1' },
      // CR-8 复核（AC5 钉死）：链上 B 用不同 modelId——「两行同 call_id、model_id 各异」
      // 的验收证据由此 fixture 直接承载（同模型不同键只证 key 互异，不证跨模型）。
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'glm-5.3' } }],
    });

    expect(result.text).toBe('from B');
    expect(records).toHaveLength(2);
    const [attemptA, attemptB] = records;
    expect(attemptA!.keyId).toBe('key_a');
    expect(attemptA!.success).toBe(false);
    expect(attemptB!.keyId).toBe('key_b');
    expect(attemptB!.success).toBe(true);
    // 共享 callId：一次逻辑调用（含跨模型回退推进）在 ledger 侧恰一组。
    expect(attemptA!.callId).toBeTruthy();
    expect(attemptA!.callId).toBe(attemptB!.callId);
    // model_id 各异（AC5 第二半——行级可区分两 attempt 的模型身份）。
    expect(attemptA!.modelId).toBe('gpt-4o-mini');
    expect(attemptB!.modelId).toBe('glm-5.3');
    // sessionId 三跳：wire 字段经环的原始载荷重建逐 attempt 不丢（模型各异、会话同源）。
    expect(attemptA!.sessionId).toBe('sess-gw-1');
    expect(attemptB!.sessionId).toBe('sess-gw-1');
  });

  it('流式回退环 A 503 → B SSE 成功：两行共享同一 callId（stream=true 面同样贯穿）', async () => {
    await seedConfig(ANTH_TWO_KEY_CONFIG);
    const fetchMock = urlRoutingFetch({
      'https://anth-a.example.com': () => errorResponse(503, 'upstream dead'),
      'https://anth-b.example.com': () => sseResponse(completeAnthStream('B答案')),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_a', modelId: 'claude-3-5-sonnet-latest' },
        request: { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
        fallbacks: [{ ref: { keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' } }],
      },
      undefined,
      () => {},
    );

    expect(result.text).toBe('B答案');
    expect(records).toHaveLength(2);
    expect(records[0]!.callId).toBeTruthy();
    expect(records[0]!.callId).toBe(records[1]!.callId);
    expect(records[1]!.stream).toBe(true);
    expect(records[1]!.success).toBe(true);
  });

  it('零默认链快径（非流式 + 流式各一逻辑调用）：每调用一行、callId 非空且互不相同', async () => {
    // 本地双键配置（key id 去重——ANTH_TWO_KEY_CONFIG 的 key_a 与 openai 键撞 id，
    // save-model 按 id 折叠；流式键独立命名）。流式键复用 anth-a 路由。
    await seedConfig({
      keys: [
        ...TWO_KEY_CONFIG.keys,
        {
          id: 'key_stream',
          name: 'A anthropic',
          protocol: 'anthropic-compatible',
          apiKey: 'sk-ant-a',
          baseUrl: 'https://anth-a.example.com',
          models: [{ id: 'claude-3-5-sonnet-latest', alias: 'Claude A', capability: 'text', enabled: true }],
        },
      ],
    });
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => openAiTextResponse('solo'),
      'https://anth-a.example.com': () => sseResponse(completeAnthStream('solo stream')),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
    await handleGenerateTextStream(
      {
        ref: { keyId: 'key_stream', modelId: 'claude-3-5-sonnet-latest' },
        request: { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
      },
      undefined,
      () => {},
    );

    expect(records).toHaveLength(2);
    expect(records[0]!.callId).toBeTruthy();
    expect(records[1]!.callId).toBeTruthy();
    expect(records[0]!.callId).not.toBe(records[1]!.callId); // 每逻辑调用恰一组
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C3.2 W1 熔断网关接线：条目前置门（resolved 身份键，open → trace circuit-open +
// 切换事件 + continue，含 primary）/ 直通快径快败 CircuitOpenError / attempt 成败
// 回写（eligible 计数、成功关断、overflow·schema·producedDelta 不计数）。
// 时钟经 _setBreakerClockForTest 注入（mirror ModelCliProbeDeps DI now() 形态），
// 不用 fake timers——协议层快速重试的真实 sleep 与熔断窗互不干扰。
// 纯函数族全态迁移归 circuitBreaker.test.ts。
// ═════════════════════════════════════════════════════════════════════════════

describe('gateway circuit breaker (C3.2 W1)', () => {
  let t = 1_000_000;

  /** A 槽无链失败一次（快径 catch-classify-record-rethrow 各记 1 次 eligible 失败）。 */
  async function failOnceNoChain(): Promise<void> {
    t += 1_000;
    await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    }).catch(() => undefined);
  }

  /** 驱动 key_a/gpt-4o-mini 达阈值开断（T 次无链 eligible 失败）。 */
  async function driveOpen(): Promise<void> {
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await failOnceNoChain();
  }

  function aCallsOf(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
    return (fetchMock.mock.calls as unknown as unknown[][]).filter(([url]) =>
      String(url).startsWith('https://a.example.com'),
    );
  }

  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    resolveImagePartsMock.mockImplementation(async (messages: unknown[]) => messages);
    t = 1_000_000;
    _setBreakerClockForTest(() => t);
  });

  afterEach(async () => {
    _setBreakerClockForTest(undefined);
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    resolveImagePartsMock.mockReset();
    vi.restoreAllMocks();
  });

  it(`${BREAKER_THRESHOLD} 次 eligible 失败后：链式调用跳过该条目（trace circuit-open + 切换事件，直达下一条目）`, async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await driveOpen();
    expect(peekBreakerState('key_a', 'gpt-4o-mini').openedAt).toBeDefined();

    const switches: Array<{ from: { keyId: string }; to: { keyId: string }; reason: string; attempt: number }> = [];
    const callsBefore = fetchMock.mock.calls.length;
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
    expect(result.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
    expect(result.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('circuit-open') },
    ]);
    // 复用既有 model-fallback 事件族 = 运行期可见（切换通知白捡）。
    expect(switches).toHaveLength(1);
    expect(switches[0]!.from).toEqual({ keyId: 'key_a', modelId: 'gpt-4o-mini' });
    expect(switches[0]!.to).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
    expect(switches[0]!.reason).toContain('circuit-open');
    // A 零出站（被跳条目未发起任何请求）：出站数恰 +1（B 承接那一次）。
    expect(fetchMock.mock.calls.length - callsBefore).toBe(1);
  });

  it('primary open 后无链直通快败 CircuitOpenError（消息含模型名 + 剩余冷却秒 + 零出站；流式同）', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await driveOpen();

    // 换新 fetch 桩：快败必须零出站。
    const freshMock = vi.fn(async () => openAiTextResponse('should not be reached'));
    globalThis.fetch = freshMock as unknown as typeof globalThis.fetch;
    t += 1_000;

    const err: unknown = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).keyId).toBe('key_a');
    expect((err as CircuitOpenError).modelId).toBe('gpt-4o-mini');
    expect((err as Error).message).toContain('[key_a/gpt-4o-mini]');
    expect((err as Error).message).toMatch(/cooldown \d+s left/);
    // 错误本体若被上游再分类 → ineligible（链不烧）。
    expect(classifyGenerationFailure(err)).toMatchObject({ eligible: false, kind: 'circuit-open' });
    expect(freshMock).toHaveBeenCalledTimes(0);

    // 流式快径同语义（同 executeFastPathAttempt 包装）。
    const streamErr: unknown = await handleGenerateTextStream(
      {
        ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      },
      undefined,
      () => {},
    ).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );
    expect(streamErr).toBeInstanceOf(CircuitOpenError);
    expect(freshMock).toHaveBeenCalledTimes(0);
  });

  it('冷却期满 → half-open 探针放行；探针成功 → 关断（后续 eligible 失败回到滚动计数，不再跳条目）', async () => {
    await seedConfig();
    let aFail = true;
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () =>
        aFail ? errorResponse(429, 'rate limited') : openAiTextResponse('from A recovered'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await driveOpen();
    t += BREAKER_COOLDOWN_MS + 1; // 冷却期满

    aFail = false; // 探针（放行的那次调用）成功
    const probed = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(probed.text).toBe('from A recovered');
    expect(probed.fallbackTrace).toBeUndefined(); // 无回退发生
    // 探针成功 → 关断。
    expect(peekBreakerState('key_a', 'gpt-4o-mini')).toEqual({ failures: [] });

    // 关断后 eligible 失败回到 closed 滚动计数（1 < 阈值 → 下一次仍正常尝试 A，不跳）。
    aFail = true;
    const after = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });
    expect(after.text).toBe('from B');
    expect(after.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('quota') },
    ]);
    expect(peekBreakerState('key_a', 'gpt-4o-mini').openedAt).toBeUndefined(); // 计数中，未开断
    expect(peekBreakerState('key_a', 'gpt-4o-mini').failures).toHaveLength(1);
  });

  it('half-open 探针 eligible 失败 → 直接重开（不经计数；新冷却内下一次调用照跳）', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await driveOpen();
    t += BREAKER_COOLDOWN_MS + 1; // 冷却期满 → 下一调用即探针

    // 探针失败：A 被真实尝试（429），B 承接。
    const probed = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });
    expect(probed.modelRef).toEqual({ keyId: 'key_b', modelId: 'gpt-4o-mini' });
    // trace 记的是探针失败本体（quota），不是 circuit-open——探针确实放行了。
    expect(probed.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('quota') },
    ]);
    // 重开：openedAt = 探针失败时刻。
    expect(peekBreakerState('key_a', 'gpt-4o-mini').openedAt).toBe(t);
    const aCallsAfterProbe = aCallsOf(fetchMock).length;
    expect(aCallsAfterProbe).toBeGreaterThanOrEqual(1);

    // 新冷却未满 → 下一次链式调用 A 被跳（若误回半开放行，A 会再次真实出站）。
    t += 1_000;
    const skipped = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });
    expect(skipped.text).toBe('from B');
    expect(skipped.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('circuit-open') },
    ]);
    expect(aCallsOf(fetchMock)).toHaveLength(aCallsAfterProbe); // A 零新出站
  });

  it('overflow / schema(4xx other) 族不计数：4 次 eligible + 溢出 + 4xx 仍 closed，第 5 次 eligible 才开断', async () => {
    await seedConfig();
    let aMode: 'quota' | 'overflow' | 'badshape' = 'quota';
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => {
        if (aMode === 'overflow') {
          return errorResponse(400, "This model's maximum context length is 8192 tokens. code: context_length_exceeded");
        }
        if (aMode === 'badshape') return errorResponse(400, 'invalid request shape');
        return errorResponse(429, 'rate limited');
      },
      'https://b.example.com/v1': () => openAiTextResponse('from B'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) await failOnceNoChain();

    // 溢出：直抛保标记，不计数。
    aMode = 'overflow';
    await expect(
      handleGenerateText({
        ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      }),
    ).rejects.toBeInstanceOf(ProtocolContextOverflowError);
    // 请求内禀 4xx（other）：同样不计数。
    aMode = 'badshape';
    await expect(
      handleGenerateText({
        ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      }),
    ).rejects.satisfy((e: unknown) => e instanceof ProtocolHttpError && (e as ProtocolHttpError).status === 400);

    expect(peekBreakerState('key_a', 'gpt-4o-mini').openedAt).toBeUndefined();
    expect(peekBreakerState('key_a', 'gpt-4o-mini').failures).toHaveLength(BREAKER_THRESHOLD - 1);

    // 第 5 次 eligible（quota）→ 开断；下一次链式调用跳 A。
    aMode = 'quota';
    await failOnceNoChain();
    expect(peekBreakerState('key_a', 'gpt-4o-mini').openedAt).toBe(t);
    const skipped = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    });
    expect(skipped.text).toBe('from B');
    expect(skipped.fallbackTrace).toEqual([
      { keyId: 'key_a', modelId: 'gpt-4o-mini', reason: expect.stringContaining('circuit-open') },
    ]);
  });

  it('producedDelta 直抛不计数（流式）：已产 delta 的中断失败烧不 open 断路器，A 照常被尝试', async () => {
    await seedConfig(ANTH_TWO_KEY_CONFIG);
    // A 每次流吐一个 delta 后断流（premature close → producedDelta 门 → 原样直抛）。
    const partialChunks = [
      anthEvent('message_start', { message: { usage: { input_tokens: 3 } } }),
      anthEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      anthEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial' } }),
      // message_stop deliberately absent
    ];
    const fetchMock = urlRoutingFetch({
      'https://anth-a.example.com': () => sseResponse(partialChunks),
      'https://anth-b.example.com': () => sseResponse(completeAnthStream('should not be reached')),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    for (let i = 0; i < BREAKER_THRESHOLD + 1; i += 1) {
      t += 1_000;
      await expect(
        handleGenerateTextStream(
          {
            ref: { keyId: 'key_a', modelId: 'claude-3-5-sonnet-latest' },
            request: { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] },
            fallbacks: [{ ref: { keyId: 'key_b', modelId: 'claude-3-5-sonnet-latest' } }],
          },
          undefined,
          () => {},
        ),
      ).rejects.satisfy((e: unknown) => (e as Error).name === 'StreamInterruptedError');
    }

    // 阈值 +1 次中断后仍 closed、零计数——内容已流出的失败不是 provider 健康信号。
    expect(peekBreakerState('key_a', 'claude-3-5-sonnet-latest').openedAt).toBeUndefined();
    expect(peekBreakerState('key_a', 'claude-3-5-sonnet-latest').failures).toHaveLength(0);
    // A 每次都被真实尝试（未被跳；anth-a 前缀——本 describe 的 aCallsOf 过滤 openai 面）。
    const anthACalls = (fetchMock.mock.calls as unknown as unknown[][]).filter(([url]) =>
      String(url).startsWith('https://anth-a.example.com'),
    );
    expect(anthACalls.length).toBeGreaterThanOrEqual(BREAKER_THRESHOLD + 1);
  });

  it('per-(keyId, modelId) 隔离：key_a/gpt-4o-mini 开断不影响 key_b 出站（不同身份各态各记）', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => openAiTextResponse('from B solo'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await driveOpen();
    expect(peekBreakerState('key_a', 'gpt-4o-mini').openedAt).toBeDefined();

    // key_b 直通照常出站（B 的身份无失败记录）。
    const solo = await handleGenerateText({
      ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(solo.text).toBe('from B solo');
    expect(peekBreakerState('key_b', 'gpt-4o-mini').openedAt).toBeUndefined();
    // B 成功关断 no-op：状态键不残留失败计数。
    expect(peekBreakerState('key_b', 'gpt-4o-mini').failures).toHaveLength(0);
  });

  it('CR-16：全条目 circuit-open → 尽链抛 FallbackChainExhaustedError 且 trace 全为 circuit-open 行（零出站）', async () => {
    await seedConfig();
    // 先用全败 mock 打满双身份阈值（429/503 均 eligible）。
    const failing = urlRoutingFetch({
      'https://a.example.com/v1': () => errorResponse(429, 'rate limited'),
      'https://b.example.com/v1': () => errorResponse(503, 'upstream dead'),
    });
    globalThis.fetch = failing as unknown as typeof globalThis.fetch;

    await driveOpen(); // key_a/gpt-4o-mini 开断
    expect(peekBreakerState('key_a', 'gpt-4o-mini').openedAt).toBeDefined();
    // key_b 同模型不同键——身份隔离，须单独打满阈值（镜像 driveOpen，键名不同）。
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      t += 1_000;
      await handleGenerateText({
        ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' },
        request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      }).catch(() => undefined);
    }
    expect(peekBreakerState('key_b', 'gpt-4o-mini').openedAt).toBeDefined();

    // 换零出站桩：链式调用须全条目被跳，验证「零出站」。
    const fetchMock = vi.fn(async () => openAiTextResponse('should not be reached'));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const err: unknown = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    // 链尽（含全部条目被跳）→ 环尾聚合错误，trace 逐条目 circuit-open 行。
    expect(err).toBeInstanceOf(FallbackChainExhaustedError);
    const exhausted = err as FallbackChainExhaustedError;
    expect(exhausted.attempts.map((a) => [a.keyId, a.modelId])).toEqual([
      ['key_a', 'gpt-4o-mini'],
      ['key_b', 'gpt-4o-mini'],
    ]);
    for (const attempt of exhausted.attempts) {
      expect(attempt.reason).toContain('circuit-open');
    }
    expect(exhausted.message).toContain('circuit-open');
    // 全条目被跳——零出站。
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C3.2 W3 预算硬线 × 回退环（CR-17，AC6 证据）：stub gate 返 blocked → 环首条目即抛
// 不换家（'budget' ineligible——账户级问题换模型不救，链不烧）、A/B 双零出站、被拦
// 调用如实落 budget 失败行（token NULL）。
// ═════════════════════════════════════════════════════════════════════════════
describe('budget gate blocked → fallback loop（CR-17 / AC6）', () => {
  const records: GenerationCallRecord[] = [];

  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    resolveImagePartsMock.mockImplementation(async (messages: unknown[]) => messages);
    records.length = 0;
    setGenerationUsageSink((r) => records.push(r));
    setBudgetGate(() => ({ allowed: false, spentCny: 25, hardCapCny: 20 }));
  });

  afterEach(async () => {
    setBudgetGate(undefined);
    setGenerationUsageSink(undefined);
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    resolveImagePartsMock.mockReset();
    vi.restoreAllMocks();
  });

  it('gate 已拦：环首条目即抛 BudgetExceededError 不换家（B 零出站、链不烧）+ 恰一行 budget 失败账', async () => {
    await seedConfig();
    const fetchMock = urlRoutingFetch({
      'https://a.example.com/v1': () => openAiTextResponse('blocked before request'),
      'https://b.example.com/v1': () => openAiTextResponse('should not be reached'),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const err: unknown = await handleGenerateText({
      ref: { keyId: 'key_a', modelId: 'gpt-4o-mini' },
      request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      fallbacks: [{ ref: { keyId: 'key_b', modelId: 'gpt-4o-mini' } }],
    }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).spentCny).toBe(25);
    expect((err as BudgetExceededError).hardCapCny).toBe(20);
    // A 零出站（门在请求发起前）、B 零出站（ineligible 直抛，链不推进）。
    expect(fetchMock).not.toHaveBeenCalled();
    // 被拦调用如实落账（失败不黑洞）：恰一行 budget 失败行，token 列全 ABSENT。
    expect(records).toHaveLength(1);
    expect(records[0]!.success).toBe(false);
    expect(records[0]!.errorKind).toBe('budget');
    expect('inputTokens' in records[0]!).toBe(false);
    expect('totalTokens' in records[0]!).toBe(false);
  });
});
