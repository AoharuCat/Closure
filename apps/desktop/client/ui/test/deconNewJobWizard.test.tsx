/**
 * 新建拆解向导组件测试（CR-18——AC7 向导面补测；jsdom + mock IPC，谱系 mirror deconPage.test.tsx）。
 *
 * 覆盖：
 * - F7 点即关 belt：点击「启动拆解」→ onClose **同步**（await 之前）调用——慢 resolve /
 *   失败路径模态均不留守（失败面归 job 面板横幅/红点，toast 经全局 store 不随卸载丢）；
 * - U8 维度可见性：coarse 档「N 个手艺维解锁」提示 + 展开预览 12 行 + chip title 走 i18n
 *   键（CR-14——granularity 不再裸中文契约注记）；
 * - CR-17 预估说明行：每 pass 行下 muted 说明（estimateNote 键路由——p3a 直键 / p1a 注记行）。
 *
 * mock 形态照 spec/ui/testing.md：useI18n mock（t 返回键名 + 变量拼接）+ hand-made vi.fn 挂桥 +
 * 真实 useAppStore 两步落种。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    // 插值形 mock：键名 + 变量值拼接（实体名/书名/节名等插值面可断言）。
    t: (key: string, vars?: Record<string, string | number>) =>
      key + (vars !== undefined ? `:${Object.values(vars).join(',')}` : ''),
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { DeconNewJobWizard } from '../src/features/decon/DeconNewJobWizard';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type { DeconCreateInput, DeconJob, MaterialSummary } from '@orison/shared-contracts';

// ── fixtures ──

function jobFixture(over: Partial<DeconJob> = {}): DeconJob {
  return {
    jobId: 'decon-cccccccccccc',
    materialRef: 'global:mat-aaaaaaaaaaaa',
    tier: 'coarse',
    dimensions: [],
    status: 'paused',
    budget: { totalTokens: null, perPass: {} },
    cost: { totalTokens: 0, calls: 0, byPass: {}, estimated: true },
    materialContentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    error: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

function materialFixture(over: Partial<MaterialSummary> = {}): MaterialSummary {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '小说一',
    format: 'txt',
    medium: 'novel',
    tier: 'unspecified',
    author: null,
    lang: null,
    originDate: null,
    sourcePath: 'materials/novel.txt',
    status: 'ready',
    charCount: 120000,
    chapterCount: 40,
    chapterMethod: 'regex',
    chapterConfidence: 'high',
    scanned: false,
    nonUtf8: false,
    parseNotes: [],
    ingestedAt: '2026-09-05T08:00:00.000Z',
    ...over,
  };
}

// ── 桥 mock（文件级单 mock）──

const createSpy = vi.fn(async (_input: DeconCreateInput) => ({
  ok: true as const,
  job: jobFixture(),
  // 真实数据形态（CR-18）：继承 pass（p1a）不在 byPass——UI 按旗标合成 tokens=0 注记行。
  inheritedP1: { p1a: true, p1b: false, p1c: false },
  estimate: { totalTokens: 999999, byPass: { p1b: 300000, p3a: 699999 } },
}));
const startSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'running' }), noop: false }));
const listMaterialsSpy = vi.fn(async (): Promise<MaterialSummary[]> => [materialFixture()]);

function installBridge() {
  (window as any).orisonDesktop = {
    deconCreate: createSpy,
    deconStart: startSpy,
    listMaterials: listMaterialsSpy,
  };
}

function seedState() {
  useAppStore.setState({
    currentProject: null,
    resolvedLocale: 'zh-CN',
  } as any);
  useAppStore.setState({
    deconWizardOpen: false,
    deconSelectedJobId: null,
    deconOutputTab: 'reading',
    deconJobsLoaded: false,
    deconJobs: [],
    deconJobsLoading: false,
    deconJobsError: null,
    deconDetail: null,
    deconDetailLoading: false,
    deconDetailError: null,
    deconProgress: {},
    deconProducts: {},
    deconProductsLoading: false,
    deconReportMetas: [],
    deconReportMetasLoadedFor: null,
    deconReportsLoading: false,
    deconReportContent: null,
    deconReportContentKey: null,
    deconReportContentLoading: false,
  } as any);
}

function lastToast(): { message: string; level: string } | undefined {
  const toasts = useToastStore.getState().toasts;
  return toasts.length > 0 ? toasts[toasts.length - 1] : undefined;
}

function query(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
});

/** 渲染向导并走到成本预估卡（选材料 → create 回执）。 */
async function renderAtEstimate() {
  const onClose = vi.fn();
  await act(async () => {
    render(<DeconNewJobWizard onClose={onClose} />);
  });
  await waitFor(() => {
    expect(query('[data-decon-wizard]')).toBeTruthy();
  });
  // 选材料（coarse 默认档 + 空维度合法——拍板②）。
  await waitFor(() => {
    expect(query('[data-decon-field="material"] option[value="mat-aaaaaaaaaaaa"]')).toBeTruthy();
  });
  fireEvent.change(query('[data-decon-field="material"]'), { target: { value: 'mat-aaaaaaaaaaaa' } });
  fireEvent.click(query('[data-decon-action="create"]'));
  await waitFor(() => {
    expect(query('[data-decon-estimate]')).toBeTruthy();
  });
  return onClose;
}

describe('F7 点即关 belt（CR-18——乐观 onClose 前置，启动结果归 job 面板承载）', () => {
  it('点击「启动拆解」→ onClose 在 await 之前同步调用（慢 resolve 不留守模态）；成功后 toast started', async () => {
    const onClose = await renderAtEstimate();
    // 慢 resolve：start 挂起——点击瞬间 onClose 已被调用（同步路径，不等 IPC 回包）。
    let resolveStart!: (value: { ok: boolean; job: DeconJob; noop: boolean }) => void;
    startSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    fireEvent.click(query('[data-decon-action="start"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({ jobId: 'decon-cccccccccccc' });
    // 回包 ok → 成功 toast（全局 store，不随模态卸载丢）。
    await act(async () => {
      resolveStart({ ok: true, job: jobFixture({ status: 'running' }), noop: false });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('decon.toast.started');
    });
  });

  it('启动失败 → 失败 toast（模态已乐观关——失败面归 job 面板横幅/红点承载）', async () => {
    const onClose = await renderAtEstimate();
    startSpy.mockResolvedValueOnce({ ok: false as const, error: 'stale-fingerprints' as const, message: '材料已变更' });
    fireEvent.click(query('[data-decon-action="start"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(lastToast()?.message).toBe('decon.toast.startFailed:材料已变更');
      expect(lastToast()?.level).toBe('error');
    });
  });
});

describe('U8 维度可见性（coarse 档提示 + 展开预览 + chip title i18n——CR-14）', () => {
  it('coarse 默认档：解锁提示在位 + 展开预览 12 手艺维行 + granularity 行走 i18n 键（不裸中文契约注记）', async () => {
    await act(async () => {
      render(<DeconNewJobWizard onClose={vi.fn()} />);
    });
    // 默认 coarse：维度区只有 style chip + 预览区（折叠态）提示。
    await waitFor(() => {
      expect(document.querySelectorAll('[data-decon-dim]').length).toBe(1);
    });
    expect(query('[data-decon-dim="style"]')).toBeTruthy();
    // CR-14：chip title = i18n 键（mock t 返回键名——裸契约 granularity 不再出现）。
    expect(query('[data-decon-dim="style"]').getAttribute('title')).toBe('decon.dimGranularity.style');
    const preview = query('[data-decon-dim-preview="closed"]');
    expect(preview.textContent).toContain('decon.wizard.dimCoarseMore:12');
    // 展开：12 手艺维预览行，每行 label + granularity i18n 键。
    fireEvent.click(query('[data-decon-action="dim-preview"]'));
    expect(query('[data-decon-dim-preview="open"]')).toBeTruthy();
    const items = document.querySelectorAll('[data-decon-dim-preview-item]');
    expect(items.length).toBe(12);
    expect(items[0]!.textContent).toContain('decon.dimGranularity.huoke');
    expect(items[0]!.textContent).toContain('decon.dim.huoke');
    // 契约 granularity 原文（开发注记）不出现在预览面。
    expect(items[0]!.textContent).not.toContain('unit=ch:N');
  });
});

describe('CR-17 预估说明行（每 pass 一句通俗说明）', () => {
  it('预估卡每 pass 行下渲染 estimateNote 说明（p1b/p3a 直键 + p1a 继承注记行同有说明）', async () => {
    await renderAtEstimate();
    // p3a 直键（byPass 行）。
    expect(query('[data-decon-estimate-note="p3a"]').textContent).toContain('decon.wizard.estimateNote.p3a');
    // p1a 继承注记行（旗标合成 tokens=0）也带说明。
    expect(query('[data-decon-estimate-note="p1a"]').textContent).toContain('decon.wizard.estimateNote.p1a');
    // p1b 按章计费说明（最贵项告知）。
    expect(query('[data-decon-estimate-note="p1b"]').textContent).toContain('decon.wizard.estimateNote.p1b');
  });
});
