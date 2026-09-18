/**
 * 09-12 子5 CR-15：saveUsageRetentionDays 的 IPC 永挂兜底——5s 竞速超时按失败
 * 返回 null（调用方 toast + 输入解禁），阻 retention 输入永久禁用。api 层单测
 * （fake timers 推进 5s；成功路径真 timers 对照）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveUsageRetentionDays } from '../src/shared/api/usagePanel';

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
