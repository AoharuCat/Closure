/**
 * CR-016：description 生成 in-flight 门（≤2，模块级计数）。
 *
 * 动机：Promise.race 超时**不取消**底层 generateText invoke——provider 挂起时串行链
 * 每 ~10s 放行下一个生成而挂起的调用仍占线，无门则线性堆积。门语义：
 * - 底层 invoke 在途计数 ≥2 时新调用顺延（槽位空出才发起）；
 * - 槽位在底层 invoke **settle**（成功/最终失败）时归还——race 超时不算 settle；
 * - never-throws 语义不变（失败/超时返回 null）。
 *
 * 直测 api 层 generateAttachmentDescription（导出函数 + __attachmentDescriptionInflightForTest
 * 计数探针）；经 window.orisonDesktop 惰性取桥，per-test 安装 deferred mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_DESCRIPTION_TIMEOUT_MS,
  __attachmentDescriptionInflightForTest,
  generateAttachmentDescription,
} from '../src/shared/api/inboxAttachments';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MODEL_REF = { keyId: 'default', modelId: 'default' } as const;
const CONTENT = '北境设定正文'.repeat(20);

function installGenerateText(generateText: ReturnType<typeof vi.fn>): void {
  (window as any).orisonDesktop = { generateText };
}

async function drain(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

beforeEach(() => {
  installGenerateText(vi.fn(async () => ({ model: 'm', text: 'desc' })));
});

describe('description generation in-flight gate (CR-016)', () => {
  it('third call waits for a slot while two underlying invokes are in flight; release happens on settle', async () => {
    const gate1 = deferred<{ text?: string }>();
    const gate2 = deferred<{ text?: string }>();
    const gate3 = deferred<{ text?: string }>();
    const generateText = vi.fn()
      .mockImplementationOnce(() => gate1.promise)
      .mockImplementationOnce(() => gate2.promise)
      .mockImplementationOnce(() => gate3.promise);
    installGenerateText(generateText);

    const p1 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
    const p2 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
    const p3 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });

    // 前两发即时占满双槽；第三发排队（底层 invoke 零发起）。
    await vi.waitFor(() => { expect(generateText).toHaveBeenCalledTimes(2); });
    expect(__attachmentDescriptionInflightForTest()).toBe(2);

    gate1.resolve({ text: 'desc1' });
    expect(await p1).toBe('desc1');
    // gate1 settle 归还槽位 → 排队中的第三发此刻才发起底层 invoke。
    await vi.waitFor(() => { expect(generateText).toHaveBeenCalledTimes(3); });

    gate2.resolve({ text: 'desc2' });
    gate3.resolve({ text: 'desc3' });
    expect(await p2).toBe('desc2');
    expect(await p3).toBe('desc3');
    // 全部 settle → 计数归零。
    await vi.waitFor(() => { expect(__attachmentDescriptionInflightForTest()).toBe(0); });
  });

  it('a rejected underlying invoke also releases its slot (never-throws still holds)', async () => {
    const gate1 = deferred<{ text?: string }>();
    const gate2 = deferred<{ text?: string }>();
    const gate3 = deferred<{ text?: string }>();
    const generateText = vi.fn()
      .mockImplementationOnce(() => gate1.promise)
      .mockImplementationOnce(() => gate2.promise)
      .mockImplementationOnce(() => gate3.promise);
    installGenerateText(generateText);

    const p1 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
    const p2 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
    const p3 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
    await vi.waitFor(() => { expect(generateText).toHaveBeenCalledTimes(2); });

    gate1.reject(new Error('provider down'));
    await expect(p1).resolves.toBeNull(); // never-throws：底层失败静默降级
    await vi.waitFor(() => { expect(generateText).toHaveBeenCalledTimes(3); });

    gate2.resolve({ text: 'ok' });
    gate3.resolve({ text: 'ok' });
    await expect(p2).resolves.toBe('ok');
    await expect(p3).resolves.toBe('ok');
    await vi.waitFor(() => { expect(__attachmentDescriptionInflightForTest()).toBe(0); });
  });

  it('race timeout gives up waiting but the hanging invoke keeps holding its slot', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<{ text?: string }>();
      const generateText = vi.fn(() => gate.promise);
      installGenerateText(generateText);

      const p1 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
      const p2 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
      await drain();
      expect(generateText).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(ATTACHMENT_DESCRIPTION_TIMEOUT_MS);
      // 两发均超时静默降级（null）——但挂起中的 invoke 未 settle，槽位仍被占。
      expect(await p1).toBeNull();
      expect(await p2).toBeNull();
      expect(__attachmentDescriptionInflightForTest()).toBe(2);

      const p3 = generateAttachmentDescription({ modelRef: MODEL_REF, content: CONTENT });
      await drain();
      // 双槽仍被挂起 invoke 占据 → 第三发排队，底层零发起（正是本门要防的堆积点）。
      expect(generateText).toHaveBeenCalledTimes(2);

      gate.resolve({ text: 'late' });
      await drain();
      await vi.waitFor(() => { expect(generateText).toHaveBeenCalledTimes(3); });
      await vi.waitFor(() => { expect(__attachmentDescriptionInflightForTest()).toBe(0); });
    } finally {
      vi.useRealTimers();
    }
  });
});
