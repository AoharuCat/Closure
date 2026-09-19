import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, UserPreferencesConfig } from '@orison/shared-contracts';
import type { GenerationCallRecord } from '@orison/model-protocols';

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 usage-panel W3：usageIpc overview 载荷组装 + ¥ 换算矩阵 + clear 模式 A
// （design §3/§9.5）。真 db（throwaway home）+ configIpc mock（pricing/retention
// 可控——¥ 矩阵的取数面）；repository 部分包装（clearLedger 可注入失败）。
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-usage-ipc');

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
const configMocks = vi.hoisted(() => ({
  modelConfig: { keys: [] } as ModelConfig,
  preferences: {} as Partial<UserPreferencesConfig>,
  clearShouldThrow: false,
}));

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  ipcMain: { handle },
  app: { getPath: (_: string) => TEST_HOME, isPackaged: false },
}));

// configIpc 只 mock 本文件消费的两个读面（usageIpc 依赖面仅此二者）。
vi.mock('../main/ipc/configIpc', () => ({
  readModelConfigFromDisk: () => configMocks.modelConfig,
  readUserPreferencesFromDisk: () => configMocks.preferences,
}));

// repository 包装 clearLedger（失败注入——模式 A catch 分支）；其余真跑 throwaway db。
vi.mock('../main/db/llmUsageLedgerRepository', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../main/db/llmUsageLedgerRepository')
  >();
  return {
    ...actual,
    clearLedger: () => {
      if (configMocks.clearShouldThrow) throw new Error('ledger boom');
      return actual.clearLedger();
    },
  };
});

import { closeDb, getDb } from '../main/db/index';
import { clearLedger, insertUsageLog, recentUsageLogs } from '../main/db/llmUsageLedgerRepository';
import {
  USAGE_RECENT_LIMIT,
  buildUsageOverview,
  foldModelRows,
  foldWindowTotals,
  localMidnightMs,
  registerUsageIpc,
  usageWindowBoundaries,
} from '../main/ipc/usageIpc';

// better-sqlite3 ABI gate（mirror llmUsageLedgerRepository.test.ts）：plain-Node 下
// native 加载失败时 skip 而非假红；Electron 真跑命令见该文件头注释。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  closeDb();
  rmBestEffort(TEST_HOME);
}

function rec(over: Partial<GenerationCallRecord> = {}): GenerationCallRecord {
  return {
    ts: Date.now(),
    protocol: 'openai-compatible',
    keyId: 'k1',
    modelId: 'model-a',
    stream: false,
    success: true,
    latencyMs: 100,
    ...over,
  };
}

type OverviewHandler = () => import('@orison/shared-contracts').UsageOverview;
type ClearHandler = () => import('@orison/shared-contracts').UsageClearResult;

function capturedHandlers(): { overview: OverviewHandler; clear: ClearHandler } {
  const overview = handle.mock.calls.find(([ch]) => ch === 'usage:overview')?.[1] as
    | OverviewHandler
    | undefined;
  const clear = handle.mock.calls.find(([ch]) => ch === 'usage:clear')?.[1] as
    | ClearHandler
    | undefined;
  if (!overview || !clear) throw new Error('usage handlers not registered');
  return { overview, clear };
}

describe.skipIf(!sqliteUsable)('usageIpc（09-12 usage-panel W3）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
    registerUsageIpc();
    capturedHandlers(); // 注册面在位（缺一即红）
  });
  afterAll(clean);

  beforeEach(() => {
    clearLedger();
    configMocks.modelConfig = { keys: [] };
    configMocks.preferences = {};
    configMocks.clearShouldThrow = false;
  });

  // ── 窗口边界纯函数（本地时区自然日单源）──

  it('localMidnightMs/usageWindowBoundaries：今日=本地午夜，近7日=日历 6 天前午夜（含今日；CR-7 DST 安全）', () => {
    const now = new Date(2026, 8, 13, 15, 42, 11, 500).getTime();
    const midnight = new Date(2026, 8, 13, 0, 0, 0, 0).getTime();
    expect(localMidnightMs(now)).toBe(midnight);
    const { today, last7d } = usageWindowBoundaries(now);
    expect(today).toBe(midnight);
    // CR-7：边界 = 日历 6 天前的**午夜**（setDate 算术）——DST 切日区段内固定毫秒减法
    // 会偏一小时（窗口收放一天），日历形式钉住「自然日」语义。
    expect(last7d).toBe(new Date(2026, 8, 7, 0, 0, 0, 0).getTime());
  });

  // ── 三窗聚合 + byModel（折叠）+ byTask + recent ──

  it('三窗聚合：今日/近7日/累计 各按边界收行 + byModel(7日) + byTask(7日) + recent 倒序', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    // 按时间正序插入（recent 按 id DESC = 插入序倒序——两序对齐，断言即时间倒序）。
    insertUsageLog(rec({ ts: today - 10 * 24 * 3_600_000, taskType: 'writer-draft', keyId: 'k-old', success: false, errorKind: 'quota', inputTokens: 1, outputTokens: 1, totalTokens: 2 }));
    insertUsageLog(rec({ ts: today - 26 * 3_600_000, taskType: 'writer-draft', inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
    insertUsageLog(rec({ ts: today + 3_600_000, taskType: 'dialogue', inputTokens: 10, outputTokens: 5, totalTokens: 15 }));

    const overview = buildUsageOverview();
    expect(overview.today.calls).toBe(1);
    expect(overview.today.totalTokens).toBe(15);
    expect(overview.last7d.calls).toBe(2);
    expect(overview.last7d.inputTokens).toBe(110);
    expect(overview.total.calls).toBe(3);
    expect(overview.total.failedCalls).toBe(1);
    // byModel = 近 7 日窗行组按 (modelId, protocol) 折叠（CR-3；k-old 的 10 天前行不进）。
    expect(overview.byModel).toHaveLength(1);
    expect(overview.byModel[0]!.modelId).toBe('model-a');
    expect(overview.byModel[0]!.keyIds).toEqual(['k1']);
    expect(overview.byModel[0]!.calls).toBe(2);
    // byTask = 近 7 日（dialogue + writer-draft 各一；10 天前行不进）。
    const byTaskTypes = overview.byTask.map((t) => t.taskType).sort();
    expect(byTaskTypes).toEqual(['dialogue', 'writer-draft']);
    // recent = 全表最近 N 条倒序（最新在前）。
    expect(overview.recent).toHaveLength(3);
    expect(overview.recent[0]!.taskType).toBe('dialogue');
    expect(overview.recent[2]!.keyId).toBe('k-old');
    // 未配 pricing：estimatedCost 全 ABSENT（不硬造 0）。
    expect(overview.today.estimatedCost).toBeUndefined();
    expect(overview.byModel[0]!.estimatedCost).toBeUndefined();
    // retention 缺省 90（preferences 键缺席 → clamp 默认）。
    expect(overview.retentionDays).toBe(90);
  });

  it('懒 prune：retention 带内收紧后，overview 读取即裁掉过期行（R5 读侧形态）', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    configMocks.preferences = { usageRetentionDays: 7 };
    insertUsageLog(rec({ ts: today - 10 * 24 * 3_600_000, inputTokens: 1 }));
    insertUsageLog(rec({ ts: today, inputTokens: 2 }));
    const overview = buildUsageOverview();
    expect(overview.retentionDays).toBe(7);
    expect(overview.total.calls).toBe(1); // 10 天前行被 prune
    expect(recentUsageLogs(10)).toHaveLength(1);
  });

  it('retention clamp：带外值归位（5 → 7；9999 → 730）', () => {
    configMocks.preferences = { usageRetentionDays: 5 };
    expect(buildUsageOverview().retentionDays).toBe(7);
    configMocks.preferences = { usageRetentionDays: 9999 };
    expect(buildUsageOverview().retentionDays).toBe(730);
  });

  // ── ¥ 换算矩阵（pricing 单源 readModelConfigFromDisk；折算单源 estimateUsageCost）──

  it('¥：有价行组换算（input×input + output×output + thinking×output + cacheRead×cachedInput）÷1M', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    configMocks.modelConfig = {
      keys: [
        {
          id: 'k-priced',
          name: 'Priced',
          protocol: 'openai-compatible',
          models: [
            {
              id: 'm-priced',
              alias: 'Priced model',
              capability: 'text' as const,
              enabled: true,
              pricing: { inputPerMillion: 3, outputPerMillion: 6, cachedInputPerMillion: 0.5 },
            },
          ],
        },
      ],
    };
    insertUsageLog(
      rec({
        ts: today,
        keyId: 'k-priced',
        modelId: 'm-priced',
        taskType: 'dialogue',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        thinkingTokens: 500_000,
        cacheReadTokens: 2_000_000,
        totalTokens: 4_500_000,
      }),
    );
    const overview = buildUsageOverview();
    // 3 + 6 + 0.5×6(thinking 按输出价) + 2×0.5 = 13
    expect(overview.today.estimatedCost).toBeCloseTo(13, 9);
    expect(overview.byModel[0]!.estimatedCost).toBeCloseTo(13, 9);
  });

  it('¥：无专门价回退（thinking→output 价 / cacheRead→input 价）+ NULL 分量不计', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    configMocks.modelConfig = {
      keys: [
        {
          id: 'k2',
          name: 'NoCached',
          protocol: 'openai-compatible',
          models: [
            {
              id: 'm2',
              alias: 'M2',
              capability: 'text' as const,
              enabled: true,
              pricing: { inputPerMillion: 2, outputPerMillion: 4 },
            },
          ],
        },
      ],
    };
    insertUsageLog(
      rec({
        ts: today,
        keyId: 'k2',
        modelId: 'm2',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        thinkingTokens: 250_000,
        cacheReadTokens: 1_000_000,
        // totalTokens 缺席（NULL）——不可知分量不计（也不由 input+output 合成）。
      }),
    );
    const overview = buildUsageOverview();
    // 2(input) + 2(output) + 1(0.25M×4 thinking→output 价) + 2(1M×2 cacheRead→input 价) = 7；
    // total NULL 不参与计价（也不由 input+output 合成）。
    expect(overview.today.estimatedCost).toBeCloseTo(7, 9);
    // CR-2：全 NULL 窗口聚合 totalTokens = null（未上报 ≠ 0——瓦片「?」形态）。
    expect(overview.today.totalTokens).toBeNull();
  });

  it('¥：同窗混合有价/无价行组——窗口金额只含有价（无价不硬造 0 行）', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    configMocks.modelConfig = {
      keys: [
        {
          id: 'k-priced',
          name: 'Priced',
          protocol: 'openai-compatible',
          models: [
            {
              id: 'm-priced',
              alias: 'P',
              capability: 'text' as const,
              enabled: true,
              pricing: { inputPerMillion: 1 },
            },
          ],
        },
      ],
    };
    insertUsageLog(rec({ ts: today, keyId: 'k-priced', modelId: 'm-priced', inputTokens: 2_000_000, totalTokens: 2_000_000 }));
    insertUsageLog(rec({ ts: today, keyId: 'k-bare', modelId: 'm-bare', inputTokens: 9_000_000, totalTokens: 9_000_000 }));
    const overview = buildUsageOverview();
    expect(overview.byModel).toHaveLength(2);
    const bare = overview.byModel.find((r) => r.keyIds.includes('k-bare'))!;
    expect(bare.estimatedCost).toBeUndefined(); // 无价行组 ABSENT
    // 窗口金额 = 有价行组精确求和（2M × 1 / 1M = 2），无价行组贡献 0 但不掩没有价。
    expect(overview.today.estimatedCost).toBeCloseTo(2, 9);
    expect(overview.today.inputTokens).toBe(11_000_000); // tokens 全行计入（金额不等于 tokens 面）
  });

  it('foldWindowTotals：空集零值 + 全无价 estimatedCost ABSENT', () => {
    const empty = foldWindowTotals([]);
    expect(empty).toEqual({
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    });
    expect('estimatedCost' in empty).toBe(false);
  });

  it('CR-2：全 NULL token 窗口（calls>0、分量全程未上报）→ 聚合 null（非 0）；部分上报 → 非空和', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    // 失败行 token 全 NULL——窗口唯一行：未知 ≠ 0。
    insertUsageLog(rec({ ts: today, success: false, errorKind: 'abort' }));
    const overview = buildUsageOverview();
    expect(overview.today.calls).toBe(1);
    expect(overview.today.totalTokens).toBeNull();
    expect(overview.today.inputTokens).toBeNull();
    expect(overview.byModel[0]!.totalTokens).toBeNull();
    // 混合：NULL 行不贡献，有报值即 number。
    insertUsageLog(rec({ ts: today, inputTokens: 10, totalTokens: 12 }));
    const mixed = buildUsageOverview();
    expect(mixed.today.totalTokens).toBe(12);
    expect(mixed.today.inputTokens).toBe(10);
  });

  it('CR-3：byModel 按 (modelId, protocol) 折叠——同模型多键一行、tokens/calls 相加、金额各自计价求和、异协议分行', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    configMocks.modelConfig = {
      keys: [
        {
          id: 'k1', name: 'A', protocol: 'openai-compatible',
          models: [{ id: 'm-a', alias: 'MA', capability: 'text' as const, enabled: true, pricing: { inputPerMillion: 1 } }],
        },
        {
          id: 'k2', name: 'B', protocol: 'openai-compatible',
          models: [{ id: 'm-a', alias: 'MA', capability: 'text' as const, enabled: true, pricing: { inputPerMillion: 3 } }],
        },
        {
          id: 'k3', name: 'C', protocol: 'anthropic-compatible',
          models: [{ id: 'm-a', alias: 'MA', capability: 'text' as const, enabled: true }],
        },
      ],
    };
    insertUsageLog(rec({ ts: today, keyId: 'k1', modelId: 'm-a', inputTokens: 1_000_000, totalTokens: 1_000_000 }));
    insertUsageLog(rec({ ts: today, keyId: 'k2', modelId: 'm-a', inputTokens: 1_000_000, totalTokens: 1_000_000 }));
    insertUsageLog(rec({ ts: today, keyId: 'k3', modelId: 'm-a', protocol: 'anthropic-compatible', inputTokens: 7, totalTokens: 7 }));

    const overview = buildUsageOverview();
    // (m-a, openai) 折叠一行（k1+k2）；(m-a, anthropic) 另一行。
    expect(overview.byModel).toHaveLength(2);
    const openaiRow = overview.byModel.find((r) => r.protocol === 'openai-compatible')!;
    expect(openaiRow.keyIds).toEqual(['k1', 'k2']); // repository ORDER BY 的键序
    expect(openaiRow.calls).toBe(2);
    expect(openaiRow.inputTokens).toBe(2_000_000);
    // 金额各自计价后求和：1M×1 + 1M×3 = 4。
    expect(openaiRow.estimatedCost).toBeCloseTo(4, 9);
    const anthropicRow = overview.byModel.find((r) => r.protocol === 'anthropic-compatible')!;
    expect(anthropicRow.keyIds).toEqual(['k3']);
    expect(anthropicRow.estimatedCost).toBeUndefined(); // 无价 ABSENT
    // 窗口合计不受折叠影响。
    expect(overview.today.calls).toBe(3);
    expect(overview.today.inputTokens).toBe(2_000_007);
  });

  it('CR-6：手改 pricing 非有限值（YAML 1e999/.inf → Infinity）→ 该行不计成本（ABSENT，不渲染 Infinity）', () => {
    const now = Date.now();
    const today = localMidnightMs(now);
    configMocks.modelConfig = {
      keys: [
        {
          id: 'k-inf', name: 'Inf', protocol: 'openai-compatible',
          models: [{ id: 'm-inf', alias: 'MI', capability: 'text' as const, enabled: true, pricing: { inputPerMillion: Infinity } }],
        },
        {
          id: 'k-ok', name: 'Ok', protocol: 'openai-compatible',
          models: [{ id: 'm-ok', alias: 'MO', capability: 'text' as const, enabled: true, pricing: { inputPerMillion: 1 } }],
        },
      ],
    };
    insertUsageLog(rec({ ts: today, keyId: 'k-inf', modelId: 'm-inf', inputTokens: 1_000_000, totalTokens: 1_000_000 }));
    insertUsageLog(rec({ ts: today, keyId: 'k-ok', modelId: 'm-ok', inputTokens: 2_000_000, totalTokens: 2_000_000 }));

    const overview = buildUsageOverview();
    const infRow = overview.byModel.find((r) => r.modelId === 'm-inf')!;
    expect(infRow.estimatedCost).toBeUndefined(); // 非有限 → ABSENT
    const okRow = overview.byModel.find((r) => r.modelId === 'm-ok')!;
    expect(okRow.estimatedCost).toBeCloseTo(2, 9); // 有限价行照常计
    // 窗口金额只含有价有限行（2），非 Infinity。
    expect(overview.today.estimatedCost).toBeCloseTo(2, 9);
  });

  it('CR-13：金额累加取整（分位）——浮点噪声归位', () => {
    const rows = [
      { keyId: 'a', modelId: 'm', protocol: 'openai-compatible' as const, calls: 1, failedCalls: 0, inputTokens: 1, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 1, estimatedCost: 0.1 },
      { keyId: 'b', modelId: 'm', protocol: 'openai-compatible' as const, calls: 1, failedCalls: 0, inputTokens: 1, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 1, estimatedCost: 0.2 },
    ];
    const totals = foldWindowTotals(rows);
    expect(totals.estimatedCost).toBe(0.3); // 0.1+0.2 的浮点噪声在 fold 层取整归位
    const folded = foldModelRows(rows);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.keyIds).toEqual(['a', 'b']);
    expect(folded[0]!.estimatedCost).toBe(0.3);
  });

  // ── recent 上限 + clear 模式 A ──

  it(`recent 上限 = ${USAGE_RECENT_LIMIT}（LIMIT 截断，不拉全表）`, () => {
    const now = Date.now();
    for (let i = 0; i < USAGE_RECENT_LIMIT + 5; i += 1) {
      insertUsageLog(rec({ ts: now - i }));
    }
    const overview = buildUsageOverview();
    expect(overview.recent).toHaveLength(USAGE_RECENT_LIMIT);
    expect(overview.total.calls).toBe(USAGE_RECENT_LIMIT + 5); // 窗口合计不受 LIMIT 影响
  });

  it('usage:clear 模式 A：成功返删除数；db 错误 operation-failed（不上抛）', () => {
    const { clear } = capturedHandlers();
    insertUsageLog(rec({}));
    insertUsageLog(rec({}));
    const okResult = clear();
    expect(okResult).toEqual({ ok: true, deleted: 2 });

    insertUsageLog(rec({}));
    configMocks.clearShouldThrow = true;
    const failResult = clear();
    expect(failResult).toEqual({ ok: false, error: 'operation-failed' });
    configMocks.clearShouldThrow = false;
  });

  it('清空后 overview 归位：recent 空 + 窗口零值（真零，非 null）', () => {
    const { overview, clear } = capturedHandlers();
    insertUsageLog(rec({}));
    expect(clear()).toEqual({ ok: true, deleted: 1 });
    const after = overview();
    expect(after.recent).toEqual([]);
    expect(after.total.calls).toBe(0);
    expect(after.total.totalTokens).toBe(0); // 空窗 = 真零 0（CR-2 与「有调用未上报」的 null 区分）
    expect(after.byModel).toEqual([]);
    expect(after.byTask).toEqual([]);
  });
});
