/**
 * craft 人审页来源徽章测试（E10.3b W6——craft feature additive）。
 *
 * 覆盖：
 * - 来源徽章：originKind='decon_instance' 讲法 → 「拆书实例《书名》」chip（data-craft-origin）
 *   + 书名缺省回落无书名形；教程主张（absent / doc_claim）不显徽章（10.2 既有视觉零 churn）。
 *   （CR-26：openCraftForCard 死接线已删——拆书页跳转统一走 material 级
 *   openCraftForMaterial，归 deconPage.test 手艺卡跳转区用例。）
 *
 * mock 形态照 spec/ui/testing.md + craftPage.test.tsx 谱。
 */
import { act, cleanup, render } from '@testing-library/react';
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

import { CraftPage } from '../src/features/craft/CraftPage';
import { useAppStore } from '../src/shared/store/appStore';
import type { CraftCard } from '@orison/shared-contracts';

function deconCardFixture(teachings: CraftCard['teachings']): CraftCard {
  return {
    cardId: 'card-aaaaaaaaaaaa',
    category: 'qingxu',
    termId: 'term-aaaaaaaa',
    title: '先抑后扬',
    claim: { condensed: '压低再抬高的回报模式', points: [], scenarios: [], counterexamples: [] },
    tags: [],
    teachings,
    dispute: false,
    status: 'pending_review',
    rejectReason: null,
    confidence: 0.9,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

function teachingFixture(over: Partial<CraftCard['teachings'][number]> = {}): CraftCard['teachings'][number] {
  return {
    teachingId: 'tea-aaaaaaaaaaaa',
    materialId: 'mat-aaaaaaaaaaaa',
    materialContentHash: `sha256:${'a'.repeat(64)}`,
    author: null,
    quote: '原文引文内容',
    anchor: { chapterIndex: 0, charStart: 0, charEnd: 10, paraStart: 2, paraEnd: 3 },
    rank: 'normal',
    note: null,
    stale: false,
    ...over,
  };
}

const getCardSpy = vi.fn(async (): Promise<CraftCard | null> => deconCardFixture([teachingFixture()]));
const listCardsSpy = vi.fn(async () => []);
const listTermsSpy = vi.fn(async () => []);
const listMergeReviewsSpy = vi.fn(async () => []);
const distillStatusSpy = vi.fn(async () => []);
const listMaterialsSpy = vi.fn(async () => []);

function installBridge() {
  (window as any).orisonDesktop = {
    craftCardList: listCardsSpy,
    craftCardGet: getCardSpy,
    craftMergeReviewList: listMergeReviewsSpy,
    craftTermList: listTermsSpy,
    craftDistillStatus: distillStatusSpy,
    onCraftDistillProgress: () => () => {},
    listMaterials: listMaterialsSpy,
  };
}

function query(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
});

afterEach(() => {
  cleanup();
});

describe('来源徽章（originKind additive）', () => {
  it('decon_instance + 书名 → 「拆书实例《书名》」chip；书名缺省回落无书名形', async () => {
    getCardSpy.mockResolvedValue(
      deconCardFixture([
        teachingFixture({
          teachingId: 'tea-decon1111111',
          originKind: 'decon_instance',
          bookTitle: '灵气复苏',
        }),
        teachingFixture({
          teachingId: 'tea-decon2222222',
          originKind: 'decon_instance',
          bookTitle: null,
        }),
      ]),
    );
    useAppStore.setState({
      currentProject: { projectId: '00001', name: 'P1', path: '/proj-1', type: 'novel' },
      resolvedLocale: 'zh-CN',
      mainView: 'page',
      activePage: 'craft',
      agentPanelOpen: false,
      craftCardDetailId: 'card-aaaaaaaaaaaa',
    } as any);
    await act(async () => {
      render(<CraftPage />);
    });
    const badge = query('[data-craft-teaching="tea-decon1111111"] [data-craft-origin="decon_instance"]');
    expect(badge.textContent).toBe('craft.card.originDecon');
    expect(badge.getAttribute('data-craft-origin-book')).toBe('灵气复苏');
    // 书名缺省：无书名形（data-craft-origin-book 不带）。
    const noTitle = query('[data-craft-teaching="tea-decon2222222"] [data-craft-origin="decon_instance"]');
    expect(noTitle.textContent).toBe('craft.card.originDeconNoTitle');
    expect(noTitle.getAttribute('data-craft-origin-book')).toBeNull();
  });

  it('教程主张（absent / doc_claim）不显徽章——10.2 既有讲法视觉零 churn', async () => {
    getCardSpy.mockResolvedValue(
      deconCardFixture([
        teachingFixture({ teachingId: 'tea-legacy111111' }), // absent（旧行）
        teachingFixture({ teachingId: 'tea-doc111111111', originKind: 'doc_claim' }),
      ]),
    );
    useAppStore.setState({
      currentProject: null,
      resolvedLocale: 'zh-CN',
      mainView: 'page',
      activePage: 'craft',
      agentPanelOpen: false,
      craftCardDetailId: 'card-aaaaaaaaaaaa',
      // 清上一测遗留详情（真 store 跨测试存续——不清则 loadCraftCard 守卫短路不重拉）。
      craftCardDetail: null,
      craftCardDetailLoading: false,
      craftCardDetailError: null,
    } as any);
    await act(async () => {
      render(<CraftPage />);
    });
    expect(document.querySelector('[data-craft-origin]')).toBeNull();
  });
});
