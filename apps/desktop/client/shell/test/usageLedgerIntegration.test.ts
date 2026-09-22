import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';
import { ProtocolHttpError, setAntigravityCliGenerateForTest, setGenerationUsageSink } from '@orison/model-protocols';

// ─────────────────────────────────────────────────────────────────────────────
// C3.1 W4 集成断言（implement.md W4 首项）：计量台账端到端全链——生产装配 + 真 db 落行。
//
// - KB 检索一次（searchClosure **零 deps** = 生产默认路径：resolveEmbeddingModel /
//   resolveRerankModel 读盘配置 + defaultEmbed / defaultRerank 生产闭包，仅 fetch 桩）
//   → embed + rerank 各恰一行，task_type 可区分（'kb-query-embed' / 'kb-rerank'）。
// - dialogue 一轮（网关 handler 全链）→ 行带 session_id（wire 三跳端到端到列）。
// - agy CLI 车道经网关 → 网关 callId（回退环外一次生成）到达 CLI 早退分支 wrapper 行
//   ——与 model-protocols usageLedgerAttemptMetering（driver 两 attempt 行共享 callId，
//   fakePoolEnv 全链）拼成 AC「空 SUCCESS 注入 → 两行共享 call_id」的完整链路证据。
// - 生图行（image_count + token NULL）与桥行面归 usageLedgerWiring（同 harness）。
//
// harness mirror usageLedgerWiring.test.ts（throwaway home + electron mock + ABI gate）。
// better-sqlite3 是 Electron ABI 重建的 native addon——plain-Node 下 skip 非假红；Electron 真跑：
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/usageLedgerIntegration.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-usage-ledger-integration');

const { handle, safeStorage } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

// home 单源 = os.homedir()（testing-discipline 缝）：真 ~/.orison 零触碰。
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
import { clearLedger, recentUsageLogs } from '../main/db/llmUsageLedgerRepository';
import { installUsageMeteringProduction, registerUsageIpc } from '../main/ipc/usageIpc';
import { registerConfigIpc } from '../main/ipc/configIpc';
import {
  _resetAntigravityCliUsedForTest,
  handleGenerateText,
} from '../main/ipc/modelGatewayIpc';
import { _resetBreakerForTest } from '../main/ipc/circuitBreaker';
import { searchClosure } from '../main/db/closureRetrieval';

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

/** 按 URL 前缀分流的 fetch 桩（mirror modelGatewayFallbackLoop urlRoutingFetch 形态）。 */
function urlRoutingFetch(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [prefix, factory] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return factory();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

async function seedConfig(config: ModelConfig): Promise<void> {
  registerConfigIpc();
  const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
  await saveCall![1]({}, config);
}

describe.skipIf(!sqliteUsable)('C3.1 W4 计量台账集成断言（生产装配 + 真 db 全链）', () => {
  beforeAll(() => {
    closeDb();
    rmBestEffort(TEST_HOME);
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
    registerUsageIpc();
    installUsageMeteringProduction();
  });
  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    setAntigravityCliGenerateForTest(undefined);
    _resetAntigravityCliUsedForTest();
    // CR-10（C3.1 复核）：先卸生产 sink 再关库删目录——beforeAll 装的
    // installUsageMeteringProduction（sink = insertUsageLog）若残留，同 worker 后续
    // 生成路径会向已关句柄/已删目录落行（mirror usageLedgerWiring 清理形态）。
    setGenerationUsageSink(undefined);
    closeDb();
    rmBestEffort(TEST_HOME);
  });
  beforeEach(() => {
    clearLedger();
    _resetBreakerForTest(); // C3.2 W1：CLI 车道失败用例的熔断态跨用例复位
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('KB 检索一次（searchClosure 零 deps = 生产默认路径）→ embed + rerank 各 +1 行且 task_type 可区分', async () => {
    // embedding / rerank 各一 key（resolveEmbeddingModel / resolveRerankModel 按
    // capability 自动侦测；双 baseUrl 供 fetch 桩分流）。
    await seedConfig({
      keys: [
        {
          id: 'k-kb-embed',
          name: 'Embed relay',
          protocol: 'openai-compatible',
          apiKey: 'sk-embed',
          baseUrl: 'https://embed.example.com/v1',
          models: [{ id: 'embed-model', alias: 'Embed', capability: 'embedding', enabled: true }],
        },
        {
          id: 'k-kb-rr',
          name: 'Rerank relay',
          protocol: 'openai-compatible',
          apiKey: 'sk-rr',
          baseUrl: 'https://rr.example.com/v1',
          // id 须匹配 model-registry rerank 族——读盘时 capability 按 registry 模式重算
          // （configIpc heal），非 rerank 形 id 会被静默归一 'text' → 侦测不到。
          models: [{ id: 'bge-reranker-test', alias: 'Rerank', capability: 'rerank', enabled: true }],
        },
      ],
    });
    // 两条 closure_entry：FTS 臂 ≥2 hits（rerankCandidates 对 hits.length <= 1 短路）。
    const insertEntry = getDb().prepare(
      'INSERT INTO closure_entry (entry_id, project_id, entry_type, name, body_text) VALUES (?, ?, ?, ?, ?)',
    );
    insertEntry.run('E1', 'pid-c31', 'character', 'Ranger', 'Ranger\ntexas ranger silent hunter');
    insertEntry.run('E2', 'pid-c31', 'character', 'Scout', 'Scout\ntexas scout tracker');
    globalThis.fetch = urlRoutingFetch({
      'https://embed.example.com/v1/embeddings': () =>
        jsonResponse({
          data: [{ embedding: [0.1, 0.2] }],
          model: 'embed-model',
          usage: { prompt_tokens: 111, total_tokens: 111 },
        }),
      'https://rr.example.com/v1/rerank': () =>
        jsonResponse({
          results: [{ index: 0, relevance_score: 0.9 }],
          usage: { prompt_tokens: 22, total_tokens: 22 },
        }),
    }) as unknown as typeof globalThis.fetch;

    const hits = await searchClosure('pid-c31', 'texas', { k: 5 }); // 无 deps = 生产闭包全链

    expect(hits).toHaveLength(2); // 检索结果零变化（FTS 臂两 hit；rerank 重排不钉名次——RRF 序决定 doc index）
    expect(hits.every((h) => typeof h.rerankScore === 'number')).toBe(true); // rerank 阶段真的跑过

    const rows = recentUsageLogs(10);
    expect(rows).toHaveLength(2); // 一次检索恰两行：embed + rerank
    expect(rows.every((r) => r.imageCount === null)).toBe(true);
    // callId 不在 recent 载荷（lane 列同先例）——SQL 直读列。
    const colRows = getDb()
      .prepare('SELECT task_type, call_id, input_tokens, total_tokens, output_tokens, image_count FROM closure_llm_log ORDER BY id')
      .all() as Array<{ task_type: string | null; call_id: string | null; input_tokens: number | null; total_tokens: number | null; output_tokens: number | null; image_count: number | null }>;
    const embedCol = colRows.find((r) => r.task_type === 'kb-query-embed');
    const rerankCol = colRows.find((r) => r.task_type === 'kb-rerank');
    expect(embedCol).toBeDefined(); // 查询臂标签（closureRetrieval defaultEmbed 单点）
    expect(rerankCol).toBeDefined(); // rerank 阶段标签（rerankCandidates deps.taskType 透传）
    expect(embedCol!.input_tokens).toBe(111);
    expect(embedCol!.total_tokens).toBe(111);
    expect(embedCol!.output_tokens).toBeNull(); // 端点不报 → NULL（CR-18 缺席 ≠ 0）
    expect(embedCol!.image_count).toBeNull();
    expect(embedCol!.call_id).toBeTruthy();
    expect(rerankCol!.input_tokens).toBe(22);
    expect(rerankCol!.total_tokens).toBe(22);
    expect(rerankCol!.call_id).toBeTruthy();
    // 两次独立逻辑调用 → 各自成组（call_id 互不相同）。
    expect(embedCol!.call_id).not.toBe(rerankCol!.call_id);
  });

  it('dialogue 一轮（网关 handler 全链）→ 行带 session_id（wire 三跳端到端到列）+ 网关 callId', async () => {
    await seedConfig({
      keys: [
        {
          id: 'k-txt',
          name: 'Text relay',
          protocol: 'openai-compatible',
          apiKey: 'sk-txt',
          baseUrl: 'https://txt.example.com/v1',
          models: [{ id: 'txt-model', alias: 'Text', capability: 'text', enabled: true }],
        },
      ],
    });
    globalThis.fetch = urlRoutingFetch({
      'https://txt.example.com/v1/chat/completions': () =>
        jsonResponse({
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    }) as unknown as typeof globalThis.fetch;

    const result = await handleGenerateText({
      ref: { keyId: 'k-txt', modelId: 'txt-model' },
      request: {
        model: 'txt-model',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'dialogue',
        sessionId: 'sess-c31-int',
      },
    });
    expect(result.text).toBe('hello'); // 调用结果零变化

    const row = recentUsageLogs(10)[0]!;
    expect(row.taskType).toBe('dialogue');
    expect(row.inputTokens).toBe(10);
    // session_id / call_id 列（recent 载荷无该字段——lane 列同先例）SQL 直读：wire
    // request.sessionId → 网关 wire → 入口归一 → sink → 列。
    const col = getDb()
      .prepare('SELECT session_id, call_id FROM closure_llm_log LIMIT 1')
      .get() as { session_id: string | null; call_id: string | null };
    expect(col.session_id).toBe('sess-c31-int');
    expect(col.call_id).toBeTruthy();
  });

  it('agy CLI 车道经网关：网关 callId（回退环外一次）到达 CLI 早退分支 wrapper 行', async () => {
    // AC「空 SUCCESS 注入 → 两行共享 call_id」的网关侧链路证据：driver 内部两 attempt
    // 行共享 callId 已由 model-protocols usageLedgerAttemptMetering（fakePoolEnv 全链）
    // 钉死；本用例补上「网关生成的 callId 确实进入 CLI 车道 ctx」一环。
    await seedConfig({
      keys: [
        {
          id: 'k-cli',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          apiKey: '',
          cliExecutable: 'C:\\agy\\bin\\agy.exe',
          models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true }],
        },
      ],
    });
    setAntigravityCliGenerateForTest(async () => {
      throw new ProtocolHttpError('agy terminal state ERROR: stream failure', 502);
    });

    await expect(
      handleGenerateText({
        ref: { keyId: 'k-cli', modelId: 'gemini-3.8-pro-high' },
        request: {
          model: 'gemini-3.8-pro-high',
          messages: [{ role: 'user', content: 'hi' }],
          taskType: 'writer-draft',
          sessionKey: 'dialogue:sess-c31-cli',
        },
      }),
    ).rejects.toThrow('agy terminal state ERROR');

    const row = recentUsageLogs(10)[0]!;
    expect(row.protocol).toBe('antigravity-cli');
    expect(row.success).toBe(false);
    expect(row.errorKind).toBe('server'); // 502 → classifyGenerationFailure 同判据
    expect(row.taskType).toBe('writer-draft');
    expect(row.sessionKey).toBe('dialogue:sess-c31-cli');
    // call_id 列 SQL 直读：网关生成 → CLI 分支 wrapper 行（与 driver attempt 收集器行
    // 同源——usageLedgerAttemptMetering 钉两行共享）。
    const col = getDb()
      .prepare('SELECT call_id FROM closure_llm_log LIMIT 1')
      .get() as { call_id: string | null };
    expect(col.call_id).toBeTruthy();
  });
});
