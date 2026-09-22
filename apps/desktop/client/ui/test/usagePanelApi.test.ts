/**
 * 09-12 子5 CR-15：saveUsageRetentionDays 的 IPC 永挂兜底——5s 竞速超时按失败
 * 返回 null（调用方 toast + 输入解禁），阻 retention 输入永久禁用。api 层单测
 * （fake timers 推进 5s；成功路径真 timers 对照）。
 *
 * CR-14（c3-2 CR 批）：偏好保存写链串行化——retention/budget 两条读改写并发时不丢
 * 首写者的键（模块级 promise 链把读改写段排成串行）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBudgetCaps, saveUsageRetentionDays } from '../src/shared/api/usagePanel';

describe('saveUsageRetentionDays 超时兜底（CR-15）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loadUserPreferences 永挂 → 5s 超时返 null，不触发 save', async () => {
    const saveMock = vi.fn();
    (window as any).orisonDesktop = {
      loadUserPreferences: () => new Promise(() => {}), // 永挂
      saveUserPreferences: saveMock,
    };
    const pending = saveUsageRetentionDays(30);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBeNull();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('saveUserPreferences 永挂 → 5s 超时返 null（load 已完成，save 未确认）', async () => {
    (window as any).orisonDesktop = {
      loadUserPreferences: () => Promise.resolve({ theme: 'dark' }),
      saveUserPreferences: () => new Promise(() => {}), // 永挂
    };
    const pending = saveUsageRetentionDays(30);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBeNull();
  });

  it('正常路径不受竞速影响（即时 resolve，返回钳制值）', async () => {
    const saveMock = vi.fn(async () => undefined);
    (window as any).orisonDesktop = {
      loadUserPreferences: () => Promise.resolve({ theme: 'dark' }),
      saveUserPreferences: saveMock,
    };
    const pending = saveUsageRetentionDays(30);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe(30);
    expect(saveMock).toHaveBeenCalledWith({ theme: 'dark', usageRetentionDays: 30 });
  });
});

// ── CR-14：写链串行化（真 timers 微延迟模拟 IPC 延迟；有链 = 两键俱存，无链 =
// 后写者整体覆盖先写者）。─────────────────────────────────────────────────────
describe('偏好保存写链串行化（CR-14）', () => {
  afterEach(() => {
    delete (window as any).orisonDesktop;
  });

  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

  it('retention 与 budget 两保存并发：读改写段串行执行，两键俱存互不覆盖', async () => {
    let store: Record<string, unknown> = { theme: 'dark' };
    const saveCalls: Array<Record<string, unknown>> = [];
    (window as any).orisonDesktop = {
      loadUserPreferences: async () => {
        await tick();
        return { ...store };
      },
      saveUserPreferences: async (payload: Record<string, unknown>) => {
        await tick();
        saveCalls.push(payload);
        store = { ...payload };
        return undefined;
      },
    };

    // 并发发起（同一 tick 内两条读改写都先读盘面基线 {theme}——无写链时后落盘者
    // 会用基线整体覆盖先落盘者的键）。
    const [retention, budget] = await Promise.all([
      saveUsageRetentionDays(30),
      saveBudgetCaps(5, 20),
    ]);
    expect(retention).toBe(30);
    expect(budget).toEqual({ softCny: 5, hardCny: 20 });

    // 两次 save 的载荷各自含前一段已落的键（串行读改写）。
    expect(saveCalls).toHaveLength(2);
    const savedStore = store;
    expect(savedStore.usageRetentionDays).toBe(30);
    expect(savedStore.budgetSoftCny).toBe(5);
    expect(savedStore.budgetHardCny).toBe(20);
    // 第二段读到的盘面必含第一段已落的键（丢首写者的直接证据面）。
    const secondPayload = saveCalls[1]!;
    expect(
      secondPayload.usageRetentionDays === 30 || secondPayload.budgetSoftCny !== undefined,
    ).toBe(true);
    expect(Object.keys(secondPayload)).toEqual(
      expect.arrayContaining(['theme', 'usageRetentionDays', 'budgetSoftCny', 'budgetHardCny']),
    );
  });

  it('前段失败不阻断本段（写链容错——错误归调用方 promise，链继续）', async () => {
    let store: Record<string, unknown> = { theme: 'dark' };
    let failLoad = true;
    (window as any).orisonDesktop = {
      loadUserPreferences: async () => {
        await tick();
        if (failLoad) throw new Error('bridge boom');
        return { ...store };
      },
      saveUserPreferences: async (payload: Record<string, unknown>) => {
        await tick();
        store = { ...payload };
        return undefined;
      },
    };

    const failed = await saveUsageRetentionDays(30); // 读失败 → null（不 throw 出链外）
    expect(failed).toBeNull();
    failLoad = false;
    const budget = await saveBudgetCaps(5, 20);
    expect(budget).toEqual({ softCny: 5, hardCny: 20 });
    expect(store.budgetSoftCny).toBe(5);
  });
});
