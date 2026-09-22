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
  prefsShouldThrow: false,
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
  readUserPreferencesFromDisk: () => {
    if (configMocks.prefsShouldThrow) throw new Error('prefs boom');
    return configMocks.preferences;
  },
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
import { checkBudgetGate, setBudgetGate } from '@orison/model-protocols';
import {
  USAGE_RECENT_LIMIT,
  buildBudgetStatus,
  buildUsageOverview,
  foldModelRows,
  foldWindowTotals,
  installBudgetGateProduction,
  isMonthWindowTruncated,
  localMidnightMs,
  localMonthStartMs,
  monthSpentCny,
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
    configMocks.prefsShouldThrow = false;
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

  // ── C3.2 W3 月度预算：月界 / 截断守卫 / 月累计 / budget 状态 / gate 装配 ──

  /** 单价 k-priced/m-priced = input 1/1M 的配置（¥ 矩阵复用）。 */
  function withPricing() {
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
  }

  describe('C3.2 W3 月度预算', () => {
    /** 合成「now」：本地 2026-09-20 12:00（本月第 20 天——不依赖真实钟面，全天可跑）。 */
    const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

    // CR-8：installBudgetGateProduction 装的是协议层模块级 gate——用例收尾卸载，
    // 防闭包（引用本文件 mock 的偏好读面）泄漏到同文件后续用例。
    afterAll(() => setBudgetGate(undefined));

    it('localMonthStartMs：本地自然月一日零点（月中/月界当天/月末深夜/跨年一月）', () => {
      expect(localMonthStartMs(NOW)).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).getTime());
      // 月界当天零点即月界（恒等）；月界当天任意时刻同样归一日。
      expect(localMonthStartMs(new Date(2026, 8, 1, 17, 33).getTime())).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).getTime());
      // 月末 23:59 → 本月一日（跨月边界）。
      expect(localMonthStartMs(new Date(2026, 8, 30, 23, 59).getTime())).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).getTime());
      // 跨年：次年一月 → 一月一日（年份归位）。
      expect(localMonthStartMs(new Date(2027, 0, 15, 8, 0).getTime())).toBe(new Date(2027, 0, 1, 0, 0, 0, 0).getTime());
    });

    it('isMonthWindowTruncated：retention 裁剪口（mirror prune 同式）晚于月界才截断；= 边界不截断', () => {
      // 90 天窗覆盖整月 → 不截断；30 天窗裁剪口 8-21 早于月界 9-1 → 不截断。
      expect(isMonthWindowTruncated(90, NOW)).toBe(false);
      expect(isMonthWindowTruncated(30, NOW)).toBe(false);
      // 7 天窗裁剪口 9-13 12:00 晚于月界 9-1 → 截断（月初至 9-13 的行已删——假低）。
      expect(isMonthWindowTruncated(7, NOW)).toBe(true);
      // 边界：裁剪口恰等于月界（19.5 天前 = 9-1 00:00）→ 不截断（ts >= monthStart 全行在窗）。
      expect(isMonthWindowTruncated(19.5, NOW)).toBe(false);
      // 带外 retention clamp 单源（3 → 7）同判定。
      expect(isMonthWindowTruncated(3, NOW)).toBe(true);
    });

    it('monthSpentCny：月窗行组 ¥ 求和 + 上月行不进 + 无价行不计入（无价即不可估）', () => {
      withPricing();
      insertUsageLog(rec({ ts: new Date(2026, 7, 15).getTime(), keyId: 'k-priced', modelId: 'm-priced', inputTokens: 5_000_000, totalTokens: 5_000_000 })); // 上月
      insertUsageLog(rec({ ts: new Date(2026, 8, 10).getTime(), keyId: 'k-priced', modelId: 'm-priced', inputTokens: 2_000_000, totalTokens: 2_000_000 })); // 月窗 2 元
      insertUsageLog(rec({ ts: new Date(2026, 8, 11).getTime(), keyId: 'k-bare', modelId: 'm-bare', inputTokens: 9_000_000, totalTokens: 9_000_000 })); // 无价
      expect(monthSpentCny(NOW)).toBe(2);
    });

    it('buildBudgetStatus：无配置 undefined + soft/hard 三态（hard 优先）+ 仅软线合法 + 病态 soft>hard 钳平', () => {
      withPricing();
      insertUsageLog(rec({ ts: new Date(2026, 8, 10).getTime(), keyId: 'k-priced', modelId: 'm-priced', inputTokens: 2_000_000, totalTokens: 2_000_000 })); // spent = 2
      // 无双线配置 → undefined（旧渲染端零崩的 ABSENT 形态）。
      expect(buildBudgetStatus(NOW)).toBeUndefined();
      // spent 2：过软线 1.5 不过硬线 20 → soft。
      configMocks.preferences = { budgetSoftCny: 1.5, budgetHardCny: 20 };
      let status = buildBudgetStatus(NOW)!;
      expect(status.state).toBe('soft');
      expect(status.softCny).toBe(1.5);
      expect(status.hardCny).toBe(20);
      expect(status.monthSpentCny).toBe(2);
      expect(status.windowTruncated).toBeUndefined(); // retention 缺省 90 覆盖整月
      // spent ≥ hard → hard（同刻过双线只报最严态）。
      configMocks.preferences = { budgetSoftCny: 1.5, budgetHardCny: 2 };
      expect(buildBudgetStatus(NOW)!.state).toBe('hard');
      // 双线皆未过 → ok。
      configMocks.preferences = { budgetSoftCny: 5, budgetHardCny: 20 };
      expect(buildBudgetStatus(NOW)!.state).toBe('ok');
      // 仅软线（无 hard）合法。
      configMocks.preferences = { budgetSoftCny: 1.5 };
      status = buildBudgetStatus(NOW)!;
      expect(status.state).toBe('soft');
      expect('hardCny' in status).toBe(false);
      // 病态 soft>hard（手改直读绕过 readUserPreferences 的防御面）→ 以 hard 为准钳平。
      configMocks.preferences = { budgetSoftCny: 30, budgetHardCny: 2 };
      status = buildBudgetStatus(NOW)!;
      expect(status.softCny).toBe(2);
      expect(status.hardCny).toBe(2);
      expect(status.state).toBe('hard');
    });

    it('buildBudgetStatus：保留窗 × 月窗截断守卫——windowTruncated 标注（gate 与面板同源判定，不静默）', () => {
      withPricing();
      insertUsageLog(rec({ ts: new Date(2026, 8, 10).getTime(), keyId: 'k-priced', modelId: 'm-priced', inputTokens: 2_000_000, totalTokens: 2_000_000 }));
      configMocks.preferences = { budgetHardCny: 20, usageRetentionDays: 7 };
      expect(buildBudgetStatus(NOW)!.windowTruncated).toBe(true); // 裁剪口 9-13 > 月界 9-1
      configMocks.preferences = { budgetHardCny: 20, usageRetentionDays: 90 };
      expect('windowTruncated' in buildBudgetStatus(NOW)!).toBe(false); // 条件展开——不截断键不在
    });

    it('buildBudgetStatus：偏好读失败 = 不设（undefined——gate 侧同款放行语义）', () => {
      configMocks.prefsShouldThrow = true;
      expect(buildBudgetStatus(NOW)).toBeUndefined();
    });

    it('installBudgetGateProduction：hard 有值查月累计比对 + 闭包现读偏好即时生效 + 读失败降级放行', () => {
      withPricing();
      // CR-2：gate 闭包内部用真实 Date.now()（无 DI 缝）——插入行必须落在**真实当月**
      // 窗内才会被 monthSpentCny 计入。曾钉 2026-09-20 固定日期 = 十月起的定时炸弹；
      // ts=Date.now() 恒在当下月窗内（usageByKeyModelSince 只按 ts >= 月界收行）。
      insertUsageLog(rec({ ts: Date.now(), keyId: 'k-priced', modelId: 'm-priced', inputTokens: 25_000_000, totalTokens: 25_000_000 }));
      configMocks.preferences = { budgetHardCny: 20 };
      installBudgetGateProduction();
      // spent 25 ≥ hard 20 → 拦截（verdict 原样透传给协议层 checkBudgetGate）。
      expect(checkBudgetGate()).toEqual({ allowed: false, spentCny: 25, hardCapCny: 20 });
      // 上限调大即时生效（闭包 per-call 现读——mirror taskModelRouting fresh read）。
      configMocks.preferences = { budgetHardCny: 30 };
      expect(checkBudgetGate()).toEqual({ allowed: true });
      // 仅软线：gate 只认 hard（soft 只警不拦）。
      configMocks.preferences = { budgetSoftCny: 1 };
      expect(checkBudgetGate()).toEqual({ allowed: true });
      configMocks.preferences = { budgetHardCny: 20 };
      clearLedger();
      expect(checkBudgetGate()).toEqual({ allowed: true });
      // 偏好读失败 → gate 降级放行 + warn（best-effort——gate 故障不得杀生成）。
      configMocks.prefsShouldThrow = true;
      expect(checkBudgetGate()).toEqual({ allowed: true });
    });

    it('overview additive：month 窗就位 + 无配置 budget 键 ABSENT（旧渲染端零崩）+ 有配置 budget 就位', () => {
      const now = Date.now();
      const today = localMidnightMs(now);
      withPricing();
      insertUsageLog(rec({ ts: today, keyId: 'k-priced', modelId: 'm-priced', inputTokens: 2_000_000, totalTokens: 2_000_000 }));
      const bare = buildUsageOverview();
      expect(bare.month.calls).toBe(1);
      expect(bare.month.estimatedCost).toBe(2);
      expect('budget' in bare).toBe(false);
      configMocks.preferences = { budgetSoftCny: 1.5, budgetHardCny: 20 };
      const withBudget = buildUsageOverview();
      expect(withBudget.budget).toBeDefined();
      expect(withBudget.budget!.state).toBe('soft');
      expect(withBudget.budget!.monthSpentCny).toBe(2);
    });
  });
});
