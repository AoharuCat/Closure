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

const TEST_HOME = path.join(process.cwd(), 'test-tmp-usage-ledger-wiring');

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
  dialog: {},
  app: { getPath: (_: string) => TEST_HOME, isPackaged: false },
}));

import { closeDb, getDb } from '../main/db/index';
import { clearLedger, recentUsageLogs, usageByTaskSince } from '../main/db/llmUsageLedgerRepository';
import { installUsageMeteringProduction, registerUsageIpc } from '../main/ipc/usageIpc';

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
});
