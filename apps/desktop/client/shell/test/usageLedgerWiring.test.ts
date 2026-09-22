import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import type { GenerationCallRecord } from '@orison/model-protocols';
import { generateText, generateTextStream, setGenerationUsageSink } from '@orison/model-protocols';

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 usage-panel W3 装配测试（mirror deconLlmWiring / agentImagePartsGatewayWiring
// 的「生产装配真跑」形态）：协议层 wrapper（先行批）→ installUsageMeteringProduction
// 的 sink 适配 → insertUsageLog 落 closure_llm_log → repository 聚合 → usage:overview
// handler 端点返回——**行级端到端**（dispatch #4）。
//
// - 漏装 = 红：sink 未装配时协议层缺省 no-op（先行批回归锚）——0 行落账。
// - 装配后：成功行（taskType/sessionKey/usage 映射）+ 失败行（errorKind）真实落表。
// - configIpc 真跑（不 mock——throwaway home 的空配置面 → ¥ ABSENT 路径）。
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-usage-ledger-wiring');

const { handle, safeStorage } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  dialog: {},
  app: { getPath: (_: string) => TEST_HOME, isPackaged: false },
}));

import { closeDb, getDb } from '../main/db/index';
import { clearLedger, recentUsageLogs, usageByTaskSince } from '../main/db/llmUsageLedgerRepository';
import { installUsageMeteringProduction, registerUsageIpc } from '../main/ipc/usageIpc';
import { registerConfigIpc } from '../main/ipc/configIpc';
import { handleGenerateImage } from '../main/ipc/modelGatewayIpc';
// C3.1 W2b（B1 桥车道第 4 计量面）：真跑 agent 包桥 executor（fake bridge turn fn——
// 零 agy / 零网络），钉 usageIpc 装配行 + 桥行落表端到端。
import {
  __clearBridgeSeamsForTest,
  __getBridgeUsageSinkForTest,
  runBridgeExecutor,
  setBridgeTurnFn,
} from '@orison/desktop-agent';
import type { ModelConfig } from '@orison/shared-contracts';

// better-sqlite3 ABI gate（mirror llmUsageLedgerRepository.test.ts）：plain-Node 下
// skip 而非假红；Electron 真跑：
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/usageLedgerWiring.test.ts
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** SSE 响应（mirror usageSink.test sseResponse——流式调用路径的 fetch 桩形态）。 */
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

const STREAM_CHUNKS = [
  openaiChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }] }),
  openaiChunk({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  }),
  OPENAI_DONE,
];

const OPENAI_COMPLETION = {
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function openaiModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'totally-unknown-model', // registry-miss：无隐式 limits/kinds 干扰
    protocol: 'openai-compatible',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-test',
    capability: 'text',
  };
}

const BASE_REQUEST: TextGenerationRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

type OverviewHandler = () => import('@orison/shared-contracts').UsageOverview;

function overviewHandler(): OverviewHandler {
  const fn = handle.mock.calls.find(([ch]) => ch === 'usage:overview')?.[1] as
    | OverviewHandler
    | undefined;
  if (!fn) throw new Error('usage:overview handler not registered');
  return fn;
}

describe.skipIf(!sqliteUsable)('usage ledger 装配 + 行级端到端（09-12 usage-panel W3）', () => {
  beforeAll(() => {
    closeDb();
    rmBestEffort(TEST_HOME);
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
    registerUsageIpc();
    overviewHandler(); // 注册面在位
  });
  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    setGenerationUsageSink(undefined);
    __clearBridgeSeamsForTest(); // C3.1 W2b：桥 seam（turn fn + usage sink）一并还原
    closeDb();
    rmBestEffort(TEST_HOME);
  });
  beforeEach(() => {
    clearLedger();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('漏装 = 红（先行批回归锚）：sink 未装配时协议层缺省 no-op——0 行落账', async () => {
    setGenerationUsageSink(undefined);
    globalThis.fetch = vi.fn(async () => jsonResponse(OPENAI_COMPLETION));
    const result = await generateText(openaiModel(), BASE_REQUEST);
    expect(result.text).toBe('hello'); // 调用方结果不受影响
    expect(recentUsageLogs(10)).toHaveLength(0); // 但零落账
  });

  it('sink 装配：generateText 成功行真实落表（taskType/sessionKey/usage 映射）', async () => {
    installUsageMeteringProduction();
    globalThis.fetch = vi.fn(async () => jsonResponse(OPENAI_COMPLETION));
    await generateText(
      openaiModel(),
      { ...BASE_REQUEST, taskType: 'writer-draft', sessionKey: 'chain:abc1:writer' },
      { lane: 'background' },
    );
    const rows = recentUsageLogs(10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.protocol).toBe('openai-compatible');
    expect(row.keyId).toBe('k1');
    expect(row.modelId).toBe('totally-unknown-model');
    expect(row.taskType).toBe('writer-draft');
    expect(row.sessionKey).toBe('chain:abc1:writer');
    // lane 列映射（请求 → ledger 列）经 SQL 直读断言——IPC recent 载荷已删 lane 字段
    // （CR-13 死字段清理），列级覆盖保留在此。
    expect(
      (getDb().prepare('SELECT lane FROM closure_llm_log LIMIT 1').get() as { lane: string | null }).lane,
    ).toBe('background');
    expect(row.stream).toBe(false);
    expect(row.success).toBe(true);
    expect(row.inputTokens).toBe(10);
    expect(row.outputTokens).toBe(5);
    expect(row.totalTokens).toBe(15);
    expect(row.errorKind).toBeNull();
    expect(row.firstDeltaMs).toBeNull(); // 非流式无 delta
  });

  it('失败行落账：HTTP 401 → errorKind auth（分类单源与回退环同判据）', async () => {
    installUsageMeteringProduction();
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
    await generateText(openaiModel(), { ...BASE_REQUEST, taskType: 'doc-summary' }).then(
      () => undefined,
      () => undefined,
    );
    const rows = recentUsageLogs(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.success).toBe(false);
    expect(rows[0]!.errorKind).toBe('auth');
    expect(rows[0]!.taskType).toBe('doc-summary');
    expect(rows[0]!.inputTokens).toBeNull(); // 失败行 token 恒 NULL（CR-18）
  });

  it('行级端到端：generate 调用 → sink 落账 → repository 聚合 → usage:overview 端点返回', async () => {
    installUsageMeteringProduction();
    // 前两次非流式（JSON 桩），第三次流式（SSE 桩——mirror usageSink.test 形态）。
    let call = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      return call <= 2 ? jsonResponse(OPENAI_COMPLETION) : sseResponse(STREAM_CHUNKS, init?.signal);
    });
    await generateText(openaiModel(), { ...BASE_REQUEST, taskType: 'vision-relay' });
    await generateText(openaiModel(), { ...BASE_REQUEST, taskType: 'vision-relay' });
    await generateTextStream(openaiModel(), { ...BASE_REQUEST, taskType: 'dialogue' }, undefined, () => {});

    // 端点返回（registerUsageIpc 捕获的 handler——与 renderer invoke 同一函数）。
    const overview = overviewHandler()();
    expect(overview.total.calls).toBe(3);
    expect(overview.today.calls).toBe(3);
    // 非流式 2 × (10 in / 5 out) + 流式 1 × (3 in / 5 out) = 23 in / 15 out。
    expect(overview.today.inputTokens).toBe(23);
    expect(overview.today.outputTokens).toBe(15);
    // byTask（近 7 日）：vision-relay 2 + dialogue 1。
    const byTask = new Map(usageByTaskSince(0).map((t) => [t.taskType, t.calls]));
    expect(byTask.get('vision-relay')).toBe(2);
    expect(byTask.get('dialogue')).toBe(1);
    expect(overview.byTask.map((t) => t.taskType).sort()).toEqual(['dialogue', 'vision-relay']);
    // recent 倒序：最新（stream 行）在前。
    expect(overview.recent).toHaveLength(3);
    expect(overview.recent[0]!.taskType).toBe('dialogue');
    expect(overview.recent[0]!.stream).toBe(true);
    // 空配置面（throwaway home 无模型配置）→ ¥ ABSENT。
    expect(overview.today.estimatedCost).toBeUndefined();
  });

  // ── C3.1 W3 装配扩断言：三新字段（callId/sessionId/imageCount）sink 已装时到达 record
  // 并落库（列级断言走 SQL 直读；M3 后 UsageRecentCall 载荷亦含 imageCount——生图用例
  // 末尾补 recent 载荷断言）。

  it('C3.1：text 行 call_id + session_id 落列（ctx.callId 透传 + wire sessionId 归一 → sink 直传 → INSERT）', async () => {
    installUsageMeteringProduction();
    globalThis.fetch = vi.fn(async () => jsonResponse(OPENAI_COMPLETION));
    await generateText(
      openaiModel(),
      { ...BASE_REQUEST, taskType: 'dialogue', sessionId: 'sess-ledger-e2e' },
      { callId: 'call-ledger-e2e' },
    );
    expect(recentUsageLogs(10)).toHaveLength(1); // sink 已装、行真实落账
    const row = getDb().prepare('SELECT call_id, session_id, task_type FROM closure_llm_log LIMIT 1').get() as {
      call_id: string | null;
      session_id: string | null;
      task_type: string | null;
    };
    expect(row.call_id).toBe('call-ledger-e2e'); // ctx.callId 原值落列（无自生成覆盖）
    expect(row.session_id).toBe('sess-ledger-e2e'); // wire sessionId 三跳贯通
    expect(row.task_type).toBe('dialogue');
  });

  it('C3.1：生图经生产网关 handler（image-gen 标签）→ image_count 落列 + token 列如实全 NULL + call_id 网关生成非空（CR-6）', async () => {
    installUsageMeteringProduction();
    // 种子一个 image 能力模型（resolveModel 走 config:save-model 盘面——mirror fallback loop
    // 测试的 seedConfig 形态）。
    const imageConfig: ModelConfig = {
      keys: [
        {
          id: 'k-img',
          name: 'Image relay',
          protocol: 'openai-compatible',
          apiKey: 'sk-img',
          baseUrl: 'https://img.example.com/v1',
          models: [{ id: 'img-model', alias: 'Image', capability: 'image', enabled: true }],
        },
      ],
    };
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1]({}, imageConfig);
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ data: [{ url: 'https://x/1.png' }, { url: 'https://x/2.png' }] }));

    const res = await handleGenerateImage({
      ref: { keyId: 'k-img', modelId: 'img-model' },
      request: { model: 'img-model', prompt: 'a cat', n: 2 },
    });
    expect(res.images).toHaveLength(2); // 调用结果零变化

    const row = getDb()
      .prepare(
        'SELECT task_type, image_count, input_tokens, output_tokens, total_tokens, call_id, success FROM closure_llm_log LIMIT 1',
      )
      .get() as {
      task_type: string | null;
      image_count: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      call_id: string | null;
      success: number;
    };
    expect(row.task_type).toBe('image-gen'); // 网关 handler 单点标注（W3 接线）
    expect(row.image_count).toBe(2); // D1 拍板：张数 = request.n ?? 1
    expect(row.input_tokens).toBeNull(); // 图像 API 无 token 信号——如实全 NULL（CR-18）
    expect(row.output_tokens).toBeNull();
    expect(row.total_tokens).toBeNull();
    expect(row.call_id).toBeTruthy(); // CR-6：网关 handler 回退环外生成 callId（mirror 文本两 handler 不变式，生成职责不在 wrapper 缺省分叉）
    expect(row.success).toBe(1);

    // C3.1 M3：张数三触点末端——recent 载荷（SELECT → rowToRecentCall →
    // UsageRecentCall）携带 imageCount，token 列在载荷面同样 NULL。
    const recentRow = recentUsageLogs(10)[0]!;
    expect(recentRow.imageCount).toBe(2);
    expect(recentRow.inputTokens).toBeNull();
    expect(recentRow.totalTokens).toBeNull();
  });

  // ── C3.1 W2b（B1 桥车道第 4 计量面）：agent 包桥 turn settle 发射缝经本装配点落表。
  // 真跑 runBridgeExecutor（fake bridge turn fn——零 agy / 零网络）；漏装 = 红（探针
  // undefined——删除 installUsageMeteringProduction 内 setBridgeUsageSink 装配行即红，
  // mirror agentIpcAgyBridgeWiring 的 CR-001 姿态）。

  const BRIDGE_ABORT = new AbortController().signal;

  type BridgeExecutorOpts = Parameters<typeof runBridgeExecutor>[0];

  function bridgeExecutorOpts(overrides: Partial<BridgeExecutorOpts> = {}): BridgeExecutorOpts {
    return {
      sessionId: 'sess-bridge-e2e',
      projectPath: 'C:/proj',
      messages: [],
      systemPrompt: 'SYSTEM',
      tools: [],
      modelRef: { keyId: 'k-cli', modelId: 'cli-model' },
      sessionKey: 'dialogue:sess-bridge-e2e',
      permissionMode: 'suggest',
      behaviorMode: undefined,
      taskType: 'bridge-dialogue',
      abort: BRIDGE_ABORT,
      onMessage: () => {},
      ...overrides,
    };
  }

  it('C3.1 W2b：桥车道装配（漏装=红探针）→ 桥 turn 成功行落表（protocol/taskType/sessionKey/sessionId/call_id/usage）', async () => {
    installUsageMeteringProduction();
    // 漏装 = 红：装配行删除 → 探针 undefined。
    expect(__getBridgeUsageSinkForTest()).toBeDefined();
    setBridgeTurnFn(async () => ({
      text: '终文。',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      presentResultCalled: true,
      presentResultAwaiting: false,
      sentBack: false,
      secondPassMissedPresentResult: false,
      mcpSoftDenied: false,
      bridgeToolCalls: 0,
    }));
    const messages = await runBridgeExecutor(bridgeExecutorOpts());
    expect(messages.map((m) => m.role)).toEqual(['assistant']); // turn 结果零变化

    const row = getDb()
      .prepare(
        `SELECT protocol, key_id, model_id, task_type, session_key, session_id, call_id,
                stream, success, input_tokens, output_tokens, total_tokens, error_kind, latency_ms
           FROM closure_llm_log`,
      )
      .get() as Record<string, unknown>;
    expect(row.protocol).toBe('antigravity-cli'); // 桥行恒 CLI 协议
    expect(row.key_id).toBe('k-cli');
    expect(row.model_id).toBe('cli-model');
    expect(row.task_type).toBe('bridge-dialogue'); // 装配点逐点标注（W2b 接线）
    expect(row.session_key).toBe('dialogue:sess-bridge-e2e'); // 桥车道归因键照实
    expect(row.session_id).toBe('sess-bridge-e2e');
    expect(typeof row.call_id).toBe('string');
    expect((row.call_id as string).length).toBeGreaterThan(0); // 每 turn 一枚
    expect(row.stream).toBe(0);
    expect(row.success).toBe(1);
    expect(row.input_tokens).toBe(11); // usage 从桥 turn 结果如实映射
    expect(row.output_tokens).toBe(7);
    expect(row.total_tokens).toBe(18);
    expect(row.error_kind).toBeNull();
    expect(typeof row.latency_ms).toBe('number');
  });

  it('C3.1 W2b：桥 turn 失败行落表（HTTP 502 形态 → error_kind server；usage 未知 token 全 NULL）', async () => {
    installUsageMeteringProduction();
    setBridgeTurnFn(async () => {
      throw Object.assign(new Error('agy bridge cycle failed'), { status: 502 });
    });
    await expect(runBridgeExecutor(bridgeExecutorOpts())).rejects.toThrow('agy bridge cycle failed');

    const row = getDb()
      .prepare(
        'SELECT success, error_kind, error_message, input_tokens, total_tokens, task_type FROM closure_llm_log',
      )
      .get() as Record<string, unknown>;
    expect(row.success).toBe(0);
    expect(row.error_kind).toBe('server'); // mirror classifyGenerationFailure 词表
    expect(row.error_message).toBe('agy bridge cycle failed');
    expect(row.input_tokens).toBeNull(); // 失败 usage 未知 → NULL（CR-18 v2）
    expect(row.total_tokens).toBeNull();
    expect(row.task_type).toBe('bridge-dialogue');
  });
});
