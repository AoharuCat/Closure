/**
 * 材料页 ↔ 手艺页蒸馏联动测试（E10.2b W5.4/W5.6）。
 *
 * 覆盖：
 * - MaterialRow 蒸馏徽章六态渲染（idle/pending/running·相位/done·N 卡/failed/material-
 *   deleted——data-distill-badge 锚；合成单源 craftView.materialDistillBadge 的渲染面）；
 * - 「蒸馏」按钮：可蒸材料点击入队（craftDistillRun 单材料）+ 排队 toast；跳过项按
 *   原因分文案（hash-unchanged）；运行中/pending/failed 材料禁用（not-ready/already-
 *   running 契约语义的客户端前置）；
 * - N 卡跳转：done 徽章点击 → 手艺页该材料过滤（craftMaterialFilter + 队列 tab +
 *   setActivePage('craft')）；
 * - 失败徽章点击 = 重试入队。
 *
 * mock 形态照 spec/ui/testing.md + materialsPage.test.tsx 谱。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { MaterialRow } from '../src/features/materials/MaterialRow';
import { MaterialsPage } from '../src/features/materials/MaterialsPage';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type { CraftDistillLedger, CraftDistillRunInput, CraftDistillRunResult, MaterialSummary } from '@orison/shared-contracts';
import type { CraftDistillBadge } from '../src/features/craft/craftView';

function summaryFixture(over: Partial<MaterialSummary> = {}): MaterialSummary {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '讲义一',
    format: 'txt',
    medium: 'lecture',
    tier: 'unspecified',
    author: null,
    lang: null,
    originDate: null,
    sourcePath: 'materials/lecture.txt',
    status: 'ready',
    charCount: 12000,
    chapterCount: 4,
    chapterMethod: 'regex',
    chapterConfidence: 'high',
    scanned: false,
    nonUtf8: false,
    parseNotes: [],
    ingestedAt: '2026-09-02T08:00:00.000Z',
    ...over,
  };
}

const runDistillSpy = vi.fn(
  async (_input: CraftDistillRunInput): Promise<CraftDistillRunResult> => ({
    ok: true,
    queued: ['mat-aaaaaaaaaaaa'],
    skipped: [],
  }),
);

function installBridge() {
  (window as any).orisonDesktop = {
    listMaterials: vi.fn(async () => [summaryFixture()]),
    getMaterial: vi.fn(async () => null),
    deleteMaterial: vi.fn(async () => ({ ok: true })),
    reingestMaterial: vi.fn(async () => ({ ok: true, outcome: 'reused', materialId: 'm' })),
    importMaterials: vi.fn(),
    updateMaterialProvenance: vi.fn(),
    updateMaterialName: vi.fn(),
    onMaterialChanged: () => () => {},
    pathForFile: vi.fn(() => ''),
    readFile: vi.fn(async () => null),
    showItemInFolder: vi.fn(),
    craftDistillRun: runDistillSpy,
    craftDistillStatus: vi.fn(async () => []),
    onCraftDistillProgress: () => () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({
    currentProject: { projectId: '00001', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
    mainView: 'page',
    activePage: 'materials',
    agentPanelOpen: false,
  } as any);
});

afterEach(() => {
  cleanup();
});

function lastToast(): { message: string; level: string } | undefined {
  const toasts = useToastStore.getState().toasts;
  return toasts.length > 0 ? toasts[toasts.length - 1] : undefined;
}

/** done 徽章 stats 全量 fixture（CR-2b-10——done 态携带台账 stats + error note）。 */
const doneStats = {
  claims: 5,
  anchored: 5,
  droppedNoAnchor: 0,
  droppedMalformed: 0,
  droppedNoCategory: 0,
  mergedAuto: 2,
  mergeReviews: 0,
  newCards: 3,
  disputes: 0,
};

function renderRow(distill: CraftDistillBadge | null, row: Partial<MaterialSummary> = {}) {
  const onDistill = vi.fn();
  const onOpenCraft = vi.fn();
  render(
    <MaterialRow
      row={summaryFixture(row)}
      expanded={false}
      onToggleProvenance={() => {}}
      onReingest={() => {}}
      onDelete={() => {}}
      onOpenDerived={() => {}}
      onReveal={() => {}}
      distill={distill}
      onDistill={onDistill}
      onOpenCraft={onOpenCraft}
    />,
  );
  return { onDistill, onOpenCraft };
}

describe('MaterialRow 蒸馏徽章六态', () => {
  it.each([
    ['idle', { state: 'idle' } as CraftDistillBadge, 'craft.distill.idleBadge'],
    ['pending', { state: 'pending' } as CraftDistillBadge, 'craft.distill.pendingBadge'],
    [
      'running',
      { state: 'running', phase: 'dedup', elapsedMs: 63000 } as CraftDistillBadge,
      'craft.distill.runningBadge',
    ],
    [
      'done',
      {
        state: 'done',
        cardCount: 5,
        newCards: 3,
        mergedAuto: 2,
        stats: doneStats,
        error: null,
      } as CraftDistillBadge,
      'craft.distill.doneBadge',
    ],
    ['failed', { state: 'failed', error: 'x' } as CraftDistillBadge, 'craft.distill.failedBadge'],
    [
      'material-deleted',
      { state: 'material-deleted' } as CraftDistillBadge,
      'craft.distill.deletedBadge',
    ],
  ])('%s 态渲染（data-distill-badge 锚）', (_name, badge, _labelKey) => {
    renderRow(badge);
    expect(document.querySelector(`[data-distill-badge="${badge.state}"]`)).not.toBeNull();
  });

  it('running 相位进锚（data-distill-phase）', () => {
    renderRow({ state: 'running', phase: 'extracting', elapsedMs: 1000 });
    expect(document.querySelector('[data-distill-phase="extracting"]')).not.toBeNull();
  });

  it('done 徽章点击 → N 卡跳转回调；failed 徽章点击 → 重试回调', () => {
    const done = renderRow({
      state: 'done',
      cardCount: 5,
      newCards: 3,
      mergedAuto: 2,
      stats: doneStats,
      error: null,
    });
    fireEvent.click(document.querySelector('[data-distill-badge="done"]') as HTMLElement);
    expect(done.onOpenCraft).toHaveBeenCalledTimes(1);
    expect(done.onDistill).not.toHaveBeenCalled();

    cleanup();
    const failed = renderRow({ state: 'failed', error: 'LLM 不可用' });
    fireEvent.click(document.querySelector('[data-distill-badge="failed"]') as HTMLElement);
    expect(failed.onDistill).toHaveBeenCalledTimes(1);
    expect(failed.onOpenCraft).not.toHaveBeenCalled();
  });
});

describe('蒸馏按钮门控', () => {
  it('ready 材料 + 未蒸馏 = 可点；运行中/pending/failed 材料禁用', () => {
    const idle = renderRow({ state: 'idle' });
    expect(document.querySelector('[data-distill-run]')?.hasAttribute('disabled')).toBeFalsy();
    cleanup();

    const running = renderRow({ state: 'running', phase: 'dedup', elapsedMs: 1 });
    expect(document.querySelector('[data-distill-run]')?.hasAttribute('disabled')).toBeTruthy();
    cleanup();

    const pending = renderRow({ state: 'pending' });
    expect(document.querySelector('[data-distill-run]')?.hasAttribute('disabled')).toBeTruthy();
    cleanup();

    // 材料未就绪（failed 材料——not-ready 契约客户端面）。
    const notReady = renderRow(null, { status: 'failed' });
    expect(document.querySelector('[data-distill-run]')?.hasAttribute('disabled')).toBeTruthy();
    expect(notReady.onDistill).not.toHaveBeenCalled();
  });
});

describe('MaterialsPage 联动编排', () => {
  function seedMaterialsPage(craft: Record<string, unknown> = {}) {
    useAppStore.setState({
      materialsScope: 'global',
      materialsListLoadedFor: 'global:',
      materialsList: [summaryFixture()],
      materialsListLoading: false,
      materialsListError: null,
      materialDetail: null,
      materialDetailId: null,
      materialDetailLoading: false,
      materialDetailError: null,
      materialsImporting: false,
      materialsImportProgress: null,
      materialsImportFeedback: null,
      craftDistillLedgersLoaded: true,
      craftDistillLedgers: [],
      craftDistillProgress: {},
      craftMaterialNamesLoaded: true,
      craftMaterialNames: {},
      craftMaterialFilter: null,
      craftTab: 'all',
      ...craft,
    } as any);
  }

  it('蒸馏按钮 → craftDistillRun 单材料 + 排队 toast', async () => {
    seedMaterialsPage();
    await act(async () => {
      render(<MaterialsPage />);
    });
    fireEvent.click(document.querySelector('[data-distill-run]') as HTMLElement);
    await waitFor(() => {
      expect(runDistillSpy).toHaveBeenCalledWith({ materialIds: ['mat-aaaaaaaaaaaa'] });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('craft.distill.queuedToast');
    });
  });

  it('跳过项按原因分文案（hash-unchanged）', async () => {
    runDistillSpy.mockResolvedValueOnce({
      ok: true as const,
      queued: [],
      skipped: [{ materialId: 'mat-aaaaaaaaaaaa', reason: 'hash-unchanged' as const }],
    });
    seedMaterialsPage();
    await act(async () => {
      render(<MaterialsPage />);
    });
    fireEvent.click(document.querySelector('[data-distill-run]') as HTMLElement);
    await waitFor(() => {
      expect(lastToast()?.message).toBe('craft.distill.skip.hash-unchanged');
    });
  });

  it('台账徽章源 → done 徽章点击跳手艺页（materialFilter + 队列 tab + activePage）', async () => {
    const ledger: CraftDistillLedger = {
      materialId: 'mat-aaaaaaaaaaaa',
      contentHash: `sha256:${'a'.repeat(64)}`,
      derivedHash: `sha256:${'b'.repeat(64)}`,
      status: 'done',
      stats: doneStats,
      phase: null,
      error: null,
      distilledAt: '2026-09-05T00:00:00.000Z',
    };
    seedMaterialsPage({ craftDistillLedgers: [ledger] });
    await act(async () => {
      render(<MaterialsPage />);
    });
    const badge = document.querySelector('[data-distill-badge="done"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('data-distill-card-count')).toBe('5');
    fireEvent.click(badge);
    const s = useAppStore.getState();
    expect(s.craftMaterialFilter).toBe('mat-aaaaaaaaaaaa');
    expect(s.craftTab).toBe('queue');
    expect((s as unknown as { activePage: string }).activePage).toBe('craft');
  });
});
