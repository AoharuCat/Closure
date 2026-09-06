/**
 * 「手艺」页组件测试（E10.2b W5.6）。
 *
 * 覆盖：
 * - 队列渲染：四 tab + 统计头 + 并排待决段 + 按材料分组组头 + 状态徽章 + 置信三档 chip
 *   （data-craft-confidence）+ tags chips 点击过滤；
 * - 卡编辑表单：**blur 落盘 + 回声抑制**（编辑中 detail 服务器刷新不覆写草稿）+
 *   **Pattern 3b 跨字段草稿保留**（title blur 保存 → points 未 blur 草稿存活）+
 *   **编辑即降级可见反馈**（verified 卡编辑成功 → savedDowngraded toast + 状态徽章翻
 *   pending_review）+ rank 三档控件（teachingRank 走 card-review、不动卡状态语义）+
 *   驳回带理由 + 标记已核；
 * - 并排对比：两栏（newClaim/既有卡）渲染 + 三动作（merge → resolve + toast + 回列表）；
 * - 废弃区：rejected 卡救回（card-review recover）；
 * - 词表管理：pending 词目核准 + 归并（目标选择器 + movedCards toast）。
 *
 * mock 形态照 spec/ui/testing.md + materialsPage.test.tsx 谱：useI18n mock（t 返回键名）
 * + hand-made vi.fn 挂桥 + data-* 锚 + 真实 useAppStore 两步落种。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { useToastStore } from '../src/shared/store/toastStore';
import type {
  CraftCard,
  CraftCardPatchInput,
  CraftCardSummary,
  CraftDistillLedger,
  CraftDistillRunInput,
  CraftDistillRunResult,
  CraftMergeReview,
  CraftTerm,
  MaterialSummary,
} from '@orison/shared-contracts';

// ── fixtures ──

function summaryFixture(over: Partial<CraftCardSummary> = {}): CraftCardSummary {
  return {
    cardId: 'card-aaaaaaaaaaaa',
    category: 'qingxu',
    termId: 'term-aaaaaaaa',
    termName: '先抑后扬',
    title: '先抑后扬',
    condensed: '压低再抬高的回报模式',
    tags: ['都市'],
    status: 'pending_review',
    dispute: false,
    confidence: 0.3,
    teachingCount: 1,
    staleTeachingCount: 0,
    materialIds: ['mat-aaaaaaaaaaaa'],
    rejectReason: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

function fullCardFixture(over: Partial<CraftCard> = {}): CraftCard {
  return {
    cardId: 'card-aaaaaaaaaaaa',
    category: 'qingxu',
    termId: 'term-aaaaaaaa',
    title: '先抑后扬',
    claim: { condensed: '压低再抬高的回报模式', points: ['要点一'], scenarios: [], counterexamples: [] },
    tags: ['都市'],
    teachings: [
      {
        teachingId: 'tea-aaaaaaaaaaaa',
        materialId: 'mat-aaaaaaaaaaaa',
        materialContentHash: `sha256:${'a'.repeat(64)}`,
        author: '作者甲',
        quote: '原文引文内容',
        anchor: { chapterIndex: 0, charStart: 0, charEnd: 10, paraStart: 2, paraEnd: 3 },
        rank: 'normal',
        note: null,
        stale: false,
      },
    ],
    dispute: false,
    status: 'pending_review',
    rejectReason: null,
    confidence: 0.3,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

function termFixtures(): CraftTerm[] {
  return [
    { termId: 'term-aaaaaaaa', category: 'qingxu', name: '先抑后扬', status: 'active', mergedInto: null, note: null },
    { termId: 'term-bbbbbbbb', category: 'qingxu', name: '情绪反差', status: 'active', mergedInto: null, note: null },
    { termId: 'term-cccccccc', category: 'renshe', name: '新提案词目', status: 'pending', mergedInto: null, note: null },
  ];
}

/** 材料摘要 fixture（批量蒸馏入口材料池——CR-2b-20 测试驱动 listMaterials 两车道）。 */
function materialFixture(over: Partial<MaterialSummary> = {}): MaterialSummary {
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

function reviewFixture(reviewId = 'mrev-aaaaaaaaaaaa'): CraftMergeReview {
  return {
    reviewId,
    newClaim: {
      claim: { condensed: '新主张：压抑越久回报越爽', points: ['铺垫期'], scenarios: [], counterexamples: [] },
      quote: '新主张引文',
      anchor: { chapterIndex: 0, charStart: 0, charEnd: 8, paraStart: 1, paraEnd: 1 },
      materialId: 'mat-bbbbbbbbbbbb',
      materialContentHash: `sha256:${'c'.repeat(64)}`,
      author: '作者乙',
      category: 'qingxu',
      termId: 'term-aaaaaaaa',
      tags: ['仙侠'],
      confidence: 0.6,
    },
    existingCardId: 'card-aaaaaaaaaaaa',
    similarity: 0.91,
    resolution: null,
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

/** 台账行 fixture（批量蒸馏入口台账过滤测试）。 */
function ledgerFixture(
  materialId: string,
  status: 'done' | 'failed' | 'running' | 'pending',
): CraftDistillLedger {
  return {
    materialId,
    contentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    status,
    stats: {
      claims: 5,
      anchored: 4,
      droppedNoAnchor: 1,
      droppedMalformed: 0,
      droppedNoCategory: 0,
      mergedAuto: 1,
      mergeReviews: 1,
      newCards: 3,
      disputes: 0,
    },
    phase: null,
    error: null,
    distilledAt: '2026-09-05T00:00:00.000Z',
  };
}

// ── 桥 mock（文件级单 mock）──

const listCardsSpy = vi.fn(async (): Promise<CraftCardSummary[]> => []);
const getCardSpy = vi.fn(async (): Promise<CraftCard | null> => fullCardFixture());
const patchCardSpy = vi.fn(async (_input: CraftCardPatchInput) => ({ ok: true as const, card: fullCardFixture() }));
const reviewCardSpy = vi.fn(async () => ({ ok: true as const, card: fullCardFixture() }));
const listMergeReviewsSpy = vi.fn(async (): Promise<CraftMergeReview[]> => []);
const resolveMergeReviewSpy = vi.fn(async () => ({
  ok: true as const,
  review: reviewFixture(),
  mergedIntoCardId: 'card-aaaaaaaaaaaa',
}));
const listTermsSpy = vi.fn(async (): Promise<CraftTerm[]> => termFixtures());
const approveTermSpy = vi.fn(async () => ({ ok: true as const, term: termFixtures()[2] }));
const mergeTermSpy = vi.fn(async () => ({
  ok: true as const,
  term: termFixtures()[2],
  movedCardCount: 3,
}));
const distillStatusSpy = vi.fn(async () => []);
/** 批量蒸馏入队 spy（CR-2b-20 断言面——craftDistillRun 载荷）。 */
const distillRunSpy = vi.fn(
  async (_input: CraftDistillRunInput): Promise<CraftDistillRunResult> => ({
    ok: true,
    queued: [],
    skipped: [],
  }),
);
const listMaterialsSpy = vi.fn(async (): Promise<MaterialSummary[]> => [materialFixture()]);

function installBridge() {
  (window as any).orisonDesktop = {
    craftCardList: listCardsSpy,
    craftCardGet: getCardSpy,
    craftCardPatch: patchCardSpy,
    craftCardReview: reviewCardSpy,
    craftMergeReviewList: listMergeReviewsSpy,
    craftMergeReviewResolve: resolveMergeReviewSpy,
    craftTermList: listTermsSpy,
    craftTermApprove: approveTermSpy,
    craftTermMerge: mergeTermSpy,
    craftDistillRun: distillRunSpy,
    craftDistillStatus: distillStatusSpy,
    onCraftDistillProgress: () => () => {},
    listMaterials: listMaterialsSpy,
  };
}

/** 两步落种（mirror materialsPage.test.tsx）：先项目态，后 craft 数据面。 */
function seedState(craft: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { projectId: '00001', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
    mainView: 'page',
    activePage: 'craft',
    agentPanelOpen: false,
  } as any);
  useAppStore.setState({
    craftTab: 'queue',
    craftTagFilter: [],
    craftMaterialFilter: null,
    craftActiveReviewId: null,
    craftCardsLoaded: true,
    craftCards: [],
    craftCardsLoading: false,
    craftCardsError: null,
    craftCardDetail: null,
    craftCardDetailId: null,
    craftCardDetailLoading: false,
    craftCardDetailError: null,
    craftTermsLoaded: true,
    craftTerms: termFixtures(),
    craftTermsLoading: false,
    craftMergeReviewsLoaded: true,
    craftMergeReviews: [],
    craftMergeReviewsLoading: false,
    craftDistillLedgersLoaded: true,
    craftDistillLedgers: [],
    craftDistillProgress: {},
    craftMaterialNamesLoaded: true,
    craftMaterialNames: { 'mat-aaaaaaaaaaaa': '讲义一', 'mat-bbbbbbbbbbbb': '讲义二' },
    ...craft,
  } as any);
}

function lastToast(): { message: string; level: string } | undefined {
  const toasts = useToastStore.getState().toasts;
  return toasts.length > 0 ? toasts[toasts.length - 1] : undefined;
}

function query<K extends keyof HTMLElementTagNameMap>(selector: string): HTMLElement {
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

describe('队列渲染（视图 1）', () => {
  it('统计头 + 按材料分组组头 + 状态徽章 + 置信三档 chip', async () => {
    seedState({
      craftCards: [
        // verified + 分歧——纯 verified 不进队列，dispute 卡进（成员判定归 craftView 测试）。
        summaryFixture({ cardId: 'card-000000000001', status: 'verified', dispute: true, confidence: 0.95, materialIds: ['mat-aaaaaaaaaaaa'] }),
        summaryFixture({ cardId: 'card-000000000002', confidence: 0.3, materialIds: ['mat-bbbbbbbbbbbb'], tags: ['都市'] }),
      ],
    });
    await act(async () => {
      render(<CraftPage />);
    });

    // 统计头（card-list + term-list 聚合）。
    expect(query('[data-craft-stats]')).toBeTruthy();
    // 组头按材料（讲义一/讲义二两组）。
    expect(query('[data-craft-group-material="mat-aaaaaaaaaaaa"]')).toBeTruthy();
    expect(query('[data-craft-group-material="mat-bbbbbbbbbbbb"]')).toBeTruthy();
    // 状态徽章 + 置信三档 chip（0.95 → high；0.3 → low）。
    expect(query('[data-craft-card="card-000000000001"] [data-craft-status="verified"]')).toBeTruthy();
    expect(query('[data-craft-card="card-000000000002"] [data-craft-status="pending_review"]')).toBeTruthy();
    expect(query('[data-craft-card="card-000000000001"] [data-craft-confidence="high"]')).toBeTruthy();
    expect(query('[data-craft-card="card-000000000002"] [data-craft-confidence="low"]')).toBeTruthy();
  });

  it('并排待决段置顶（重复候选行 + 相似度原值）', async () => {
    seedState({
      craftCards: [summaryFixture()],
      craftMergeReviews: [reviewFixture()],
    });
    await act(async () => {
      render(<CraftPage />);
    });
    expect(query('[data-craft-review-count="1"]')).toBeTruthy();
    const row = query('[data-craft-review="mrev-aaaaaaaaaaaa"]');
    expect(row.querySelector('[data-craft-similarity="0.91"]')).toBeTruthy();
  });

  it('tags chips 点击过滤（R10 人审侧标签面——过滤后只剩命中卡 + 过滤 chip 可清除）', async () => {
    seedState({
      craftCards: [
        summaryFixture({ cardId: 'card-000000000001', tags: ['都市'] }),
        summaryFixture({ cardId: 'card-000000000002', tags: ['仙侠'] }),
      ],
    });
    await act(async () => {
      render(<CraftPage />);
    });
    fireEvent.click(query('[data-craft-card="card-000000000001"] [data-craft-tag="都市"]'));
    await waitFor(() => {
      expect(document.querySelector('[data-craft-card="card-000000000001"]')).not.toBeNull();
      expect(document.querySelector('[data-craft-card="card-000000000002"]')).toBeNull();
    });
    expect(query('[data-craft-filter-tag="都市"]')).toBeTruthy();
    fireEvent.click(query('[data-craft-filter-tag="都市"]'));
    await waitFor(() => {
      expect(document.querySelector('[data-craft-card="card-000000000002"]')).not.toBeNull();
    });
  });
});

describe('卡编辑表单（视图 2——blur 落盘/回声抑制/Pattern 3b/降级反馈）', () => {
  async function openCard(card: CraftCard = fullCardFixture()) {
    getCardSpy.mockResolvedValue(card);
    seedState({
      craftCards: [summaryFixture({ cardId: card.cardId, status: card.status, dispute: card.dispute })],
    });
    await act(async () => {
      render(<CraftPage />);
    });
    fireEvent.click(query('[data-craft-card="' + card.cardId + '"]'));
    // 等表单落场（detail 容器在 detailId 置位即渲染——card 异步回读晚一拍，勿只等容器）。
    await waitFor(() => {
      expect(document.querySelector(`[data-craft-detail="${card.cardId}"] [data-craft-field="title"]`)).not.toBeNull();
    });
  }

  it('title blur 落盘（partial patch 只发改动字段）+ 正常保存 toast', async () => {
    await openCard();
    const titleInput = query('[data-craft-field="title"]') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '新招式名' } });
    fireEvent.blur(titleInput);
    await waitFor(() => {
      expect(patchCardSpy).toHaveBeenCalledWith({
        cardId: 'card-aaaaaaaaaaaa',
        patch: { title: '新招式名' },
      });
    });
    expect(lastToast()?.message).toBe('craft.toast.saved');
  });

  it('回声抑制：编辑中 detail 服务器刷新不覆写草稿', async () => {
    await openCard();
    const titleInput = query('[data-craft-field="title"]') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '打字中草稿' } });
    // 服务器刷新（他处 verify / 事件 force 重拉回读——slice 直写 detail）。
    await act(async () => {
      useAppStore.setState({
        craftCardDetail: fullCardFixture({ title: '服务器新名', status: 'verified' }),
      } as any);
    });
    expect((query('[data-craft-field="title"]') as HTMLInputElement).value).toBe('打字中草稿');
  });

  it('Pattern 3b：title blur 保存后 points 未 blur 草稿存活（单 dirty 旗按字段分歧重算）', async () => {
    await openCard();
    // 两字段同时打字（都 dirty）。
    const titleInput = query('[data-craft-field="title"]') as HTMLInputElement;
    const pointsArea = query('[data-craft-field="points"]') as HTMLTextAreaElement;
    fireEvent.change(titleInput, { target: { value: '新招式名' } });
    fireEvent.change(pointsArea, { target: { value: '要点一\n要点二（未 blur 草稿）' } });
    // 只 blur title（points 留草稿）。
    patchCardSpy.mockResolvedValue({
      ok: true as const,
      card: fullCardFixture({ title: '新招式名' }),
    });
    fireEvent.blur(titleInput);
    await waitFor(() => {
      expect(patchCardSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      // slice 直写 result.card（detail 翻新）——points 草稿不被基线重置吞掉。
      expect((query('[data-craft-field="points"]') as HTMLTextAreaElement).value).toContain('要点二（未 blur 草稿）');
    });
  });

  it('编辑即降级可见反馈：verified 卡内容编辑成功 → savedDowngraded toast + 徽章翻 pending_review', async () => {
    // verified + 分歧（纯 verified 不进队列——dispute 卡留在待阅面）。
    await openCard(fullCardFixture({ status: 'verified', dispute: true }));
    const titleInput = query('[data-craft-field="title"]') as HTMLInputElement;
    patchCardSpy.mockResolvedValue({
      ok: true as const,
      card: fullCardFixture({ title: '新招式名', status: 'pending_review' }),
    });
    fireEvent.change(titleInput, { target: { value: '新招式名' } });
    fireEvent.blur(titleInput);
    await waitFor(() => {
      expect(lastToast()?.message).toBe('craft.toast.savedDowngraded');
    });
    await waitFor(() => {
      expect(query('[data-craft-status="pending_review"]')).toBeTruthy();
    });
  });

  it('空 title blur = 拒绝回显存量（零 IPC）', async () => {
    await openCard();
    const titleInput = query('[data-craft-field="title"]') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '   ' } });
    fireEvent.blur(titleInput);
    await new Promise((r) => setTimeout(r, 30));
    expect(patchCardSpy).not.toHaveBeenCalled();
    expect((query('[data-craft-field="title"]') as HTMLInputElement).value).toBe('先抑后扬');
  });

  it('rank 三档控件 → card-review teachingRank（不改卡状态的独立通道）', async () => {
    await openCard();
    fireEvent.click(query('[data-craft-rank="tea-aaaaaaaaaaaa:approved"]'));
    await waitFor(() => {
      expect(reviewCardSpy).toHaveBeenCalledWith({
        cardId: 'card-aaaaaaaaaaaa',
        teachingRank: { teachingId: 'tea-aaaaaaaaaaaa', rank: 'approved' },
      });
    });
    expect(lastToast()?.message).toBe('craft.toast.rankSaved');
  });

  it('标记已核 / 驳回带理由', async () => {
    await openCard();
    fireEvent.click(query('[data-craft-action="verify"]'));
    await waitFor(() => {
      expect(reviewCardSpy).toHaveBeenCalledWith({ cardId: 'card-aaaaaaaaaaaa', action: 'verify' });
    });
    fireEvent.click(query('[data-craft-action="reject"]'));
    fireEvent.change(query('[data-craft-field="rejectReason"]'), { target: { value: '主张不成立' } });
    fireEvent.click(query('[data-craft-action="reject-confirm"]'));
    await waitFor(() => {
      expect(reviewCardSpy).toHaveBeenCalledWith({
        cardId: 'card-aaaaaaaaaaaa',
        action: 'reject',
        rejectReason: '主张不成立',
      });
    });
  });

  it('tags chips 增删（整组替换）+ 词目改选（termId patch）', async () => {
    await openCard();
    // 增。
    fireEvent.change(query('[data-craft-field="tag-input"]'), { target: { value: '爽点' } });
    fireEvent.click(query('[data-craft-action="tag-add"]'));
    await waitFor(() => {
      expect(patchCardSpy).toHaveBeenCalledWith({
        cardId: 'card-aaaaaaaaaaaa',
        patch: { tags: ['都市', '爽点'] },
      });
    });
    // 词目改选（change 即存——离散类）。
    fireEvent.change(query('[data-craft-field="term"]'), { target: { value: 'term-bbbbbbbb' } });
    await waitFor(() => {
      expect(patchCardSpy).toHaveBeenCalledWith({
        cardId: 'card-aaaaaaaaaaaa',
        patch: { termId: 'term-bbbbbbbb' },
      });
    });
  });

  it('CR-2b-14：两次快速 tags 操作第二次基面含第一次在途改动（本地基面非 store 远照）', async () => {
    await openCard(); // fixture tags: ['都市']
    // 手动控制第一次 resolve——未回读前发第二次；第二次挂起（不回读）。
    let resolveFirst: ((v: { ok: true; card: CraftCard }) => void) | undefined;
    patchCardSpy.mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    patchCardSpy.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(query('[data-craft-action="tag-remove"]')); // 移除 '都市'
    await waitFor(() => {
      expect(patchCardSpy).toHaveBeenCalledTimes(1);
    });
    expect(patchCardSpy.mock.calls[0][0].patch).toEqual({ tags: [] });
    fireEvent.change(query('[data-craft-field="tag-input"]'), { target: { value: '爽点' } });
    fireEvent.click(query('[data-craft-action="tag-add"]'));
    await waitFor(() => {
      expect(patchCardSpy).toHaveBeenCalledTimes(2);
    });
    // 基面 = 本地最新草稿 []（含第一次在途改动）——非 store 远照 ['都市']（旧实现会发
    // ['都市','爽点'] 覆写第一次的移除）。
    expect(patchCardSpy.mock.calls[1][0].patch).toEqual({ tags: ['爽点'] });
    resolveFirst!({ ok: true, card: fullCardFixture({ tags: [] }) });
  });
});

describe('并排对比（视图 3——三动作）', () => {
  it('两栏渲染 + 并入动作（resolve + toast + 回列表）', async () => {
    seedState({
      craftCards: [summaryFixture()],
      craftMergeReviews: [reviewFixture()],
    });
    await act(async () => {
      render(<CraftPage />);
    });
    fireEvent.click(query('[data-craft-review="mrev-aaaaaaaaaaaa"]'));
    await waitFor(() => {
      expect(document.querySelector('[data-craft-review-view="mrev-aaaaaaaaaaaa"]')).not.toBeNull();
    });
    // 两栏 + 相似度原值 + 既有卡取数（craftCardGet）。
    expect(query('[data-craft-compare-side="new"]')).toBeTruthy();
    expect(query('[data-craft-compare-side="existing"]')).toBeTruthy();
    expect(query('[data-craft-similarity="0.91"]')).toBeTruthy();
    await waitFor(() => {
      expect(getCardSpy).toHaveBeenCalledWith({ cardId: 'card-aaaaaaaaaaaa' });
    });
    fireEvent.click(query('[data-craft-action="merge"]'));
    await waitFor(() => {
      expect(resolveMergeReviewSpy).toHaveBeenCalledWith({
        reviewId: 'mrev-aaaaaaaaaaaa',
        action: 'merge',
      });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('craft.toast.mergeMerged');
      expect(document.querySelector('[data-craft-review-view]')).toBeNull();
    });
  });

  it('分立/驳回动作走同一 resolve 通道', async () => {
    seedState({
      craftCards: [summaryFixture()],
      craftMergeReviews: [reviewFixture()],
    });
    await act(async () => {
      render(<CraftPage />);
    });
    fireEvent.click(query('[data-craft-review="mrev-aaaaaaaaaaaa"]'));
    await waitFor(() => {
      expect(document.querySelector('[data-craft-review-view]')).not.toBeNull();
    });
    fireEvent.click(query('[data-craft-action="independent"]'));
    await waitFor(() => {
      expect(resolveMergeReviewSpy).toHaveBeenCalledWith({
        reviewId: 'mrev-aaaaaaaaaaaa',
        action: 'independent',
      });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('craft.toast.mergeIndependent');
    });
    // slice 重拉清了并排队列（mock 返回空）——再置回 fixture 后走驳回动作。
    await act(async () => {
      useAppStore.setState({ craftMergeReviews: [reviewFixture()] } as any);
    });
    fireEvent.click(query('[data-craft-review="mrev-aaaaaaaaaaaa"]'));
    await waitFor(() => {
      expect(document.querySelector('[data-craft-review-view]')).not.toBeNull();
    });
    fireEvent.click(query('[data-craft-action="dismiss"]'));
    await waitFor(() => {
      expect(resolveMergeReviewSpy).toHaveBeenCalledWith({
        reviewId: 'mrev-aaaaaaaaaaaa',
        action: 'dismiss',
      });
    });
  });
});

describe('并排对比边界（CR-2b-8 既有卡已删 / CR-2b-D1 分歧预判三态）', () => {
  async function openReview(review: CraftMergeReview) {
    seedState({
      craftCards: [summaryFixture()],
      craftMergeReviews: [review],
    });
    await act(async () => {
      render(<CraftPage />);
    });
    fireEvent.click(query('[data-craft-review="' + review.reviewId + '"]'));
    await waitFor(() => {
      expect(document.querySelector(`[data-craft-review-view="${review.reviewId}"]`)).not.toBeNull();
    });
  }

  it('CR-2b-8：getCraftCard null → 右栏错误态 + 并入禁用（不再永久转圈）', async () => {
    getCardSpy.mockResolvedValue(null);
    await openReview(reviewFixture());
    await waitFor(() => {
      expect(query('[data-craft-existing-gone="true"]')).toBeTruthy();
    });
    // null ≠ 加载中——转圈态不复现。
    expect(document.querySelector('.materials-form-loading')).toBeNull();
    // 并入需既有卡在位（服务端必返 not-found）——禁用；分立/驳回保持可用（引导路径）。
    expect((query('[data-craft-action="merge"]') as HTMLButtonElement).disabled).toBe(true);
    expect((query('[data-craft-action="independent"]') as HTMLButtonElement).disabled).toBe(false);
    expect((query('[data-craft-action="dismiss"]') as HTMLButtonElement).disabled).toBe(false);
    // 还原默认实现（vi.clearAllMocks 不清 implementation——防泄漏到后续测试）。
    getCardSpy.mockResolvedValue(fullCardFixture());
  });

  it('CR-2b-D1：disputeHint 在场 dispute=true → 置顶警示块（含 reason）', async () => {
    await openReview({
      ...reviewFixture(),
      disputeHint: { dispute: true, reason: '一方主张压抑铺垫，一方主张开门见山' },
    });
    expect(query('[data-craft-dispute-hint="disputed"]')).toBeTruthy();
  });

  it('CR-2b-D1：disputeHint 在场 dispute=false → 次要行（LLM 判定无分歧）', async () => {
    await openReview({
      ...reviewFixture('mrev-bbbbbbbbbbbb'),
      disputeHint: { dispute: false, reason: '同一主张的两路讲法' },
    });
    expect(query('[data-craft-dispute-hint="no-dispute"]')).toBeTruthy();
  });

  it('CR-2b-D1：disputeHint 缺席 → 灰色小字（判定不可用——不暗示已检查）', async () => {
    await openReview(reviewFixture('mrev-cccccccccccc'));
    expect(query('[data-craft-dispute-hint="unavailable"]')).toBeTruthy();
  });
});

describe('批量蒸馏入口（CR-2b-20——distill-status 清单驱动）', () => {
  it('就绪未蒸馏材料入队（材料未就绪排除）+ 批量排队 toast', async () => {
    distillRunSpy.mockResolvedValueOnce({
      ok: true as const,
      queued: ['mat-aaaaaaaaaaaa'],
      skipped: [],
    });
    listMaterialsSpy.mockResolvedValue([
      materialFixture(), // ready 未蒸馏 → 目标
      materialFixture({ materialId: 'mat-bbbbbbbbbbbb', name: '讲义二', status: 'failed' }), // 材料未就绪 → 排除
    ]);
    seedState();
    await act(async () => {
      render(<CraftPage />);
    });
    const btn = query('[data-craft-action="batch-distill"]') as HTMLButtonElement;
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(distillRunSpy).toHaveBeenCalledWith({ materialIds: ['mat-aaaaaaaaaaaa'] });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('craft.distill.batchQueuedToast');
    });
  });

  it('台账过滤：done/running 不算目标——全部已蒸馏 → 按钮置灰', async () => {
    seedState({
      craftDistillLedgers: [
        ledgerFixture('mat-aaaaaaaaaaaa', 'done'),
        ledgerFixture('mat-bbbbbbbbbbbb', 'running'),
      ],
    });
    await act(async () => {
      render(<CraftPage />);
    });
    // 材料池加载完成（默认 mock = ready 材料 mat-a，被 done 台账过滤）→ 恒置灰。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const btn = query('[data-craft-action="batch-distill"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // 置灰仍点击（handler 空目标守卫）→ 零入队。
    fireEvent.click(btn);
    expect(distillRunSpy).not.toHaveBeenCalled();
  });
});

describe('键盘可达（CR-2b-29——卡行/审阅行 Enter/Space 打开）', () => {
  it('卡行 role=button + tabIndex + Enter 开详情', async () => {
    seedState({ craftCards: [summaryFixture()] });
    await act(async () => {
      render(<CraftPage />);
    });
    const row = query('[data-craft-card="card-aaaaaaaaaaaa"]');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => {
      expect(getCardSpy).toHaveBeenCalledWith({ cardId: 'card-aaaaaaaaaaaa' });
    });
  });

  it('审阅行 Space 开并排对比；行内元素键盘不串触发（e.target 守卫）', async () => {
    seedState({ craftCards: [summaryFixture()], craftMergeReviews: [reviewFixture()] });
    await act(async () => {
      render(<CraftPage />);
    });
    const row = query('[data-craft-review="mrev-aaaaaaaaaaaa"]');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.tabIndex).toBe(0);
    // 行内 chip（span 非 currentTarget）先试——不触发开对比。
    const chip = row.querySelector('[data-craft-similarity="0.91"]') as HTMLElement;
    fireEvent.keyDown(chip, { key: 'Enter' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.querySelector('[data-craft-review-view]')).toBeNull();
    // 行自身 Space → 开并排对比。
    fireEvent.keyDown(row, { key: ' ' });
    await waitFor(() => {
      expect(document.querySelector('[data-craft-review-view="mrev-aaaaaaaaaaaa"]')).not.toBeNull();
    });
  });
});

describe('废弃区（视图 3——救回）', () => {
  it('rejected 卡只读 + 救回动作（card-review recover）', async () => {
    getCardSpy.mockResolvedValue(fullCardFixture({ status: 'rejected', rejectReason: '重复主张' }));
    seedState({
      craftCards: [summaryFixture({ status: 'rejected', rejectReason: '重复主张' })],
      craftTab: 'rejected',
    });
    await act(async () => {
      render(<CraftPage />);
    });
    const row = query('[data-craft-card="card-aaaaaaaaaaaa"]');
    fireEvent.click(row);
    // 等表单落场（card 异步回读晚一拍）。
    await waitFor(() => {
      expect(document.querySelector('[data-craft-detail="card-aaaaaaaaaaaa"] [data-craft-field="title"]')).not.toBeNull();
    });
    // 理由回见 + 编辑禁用（rejected 编辑入口禁用——F-15）。
    expect(query('[data-craft-reject-reason="重复主张"]')).toBeTruthy();
    expect((query('[data-craft-field="title"]') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(query('[data-craft-action="recover"]'));
    await waitFor(() => {
      expect(reviewCardSpy).toHaveBeenCalledWith({ cardId: 'card-aaaaaaaaaaaa', action: 'recover' });
    });
  });
});

describe('词表管理（pending 词目核准/归并）', () => {
  it('核准 → term-approve；归并带目标 → term-merge + movedCards toast', async () => {
    seedState({ craftTab: 'terms' });
    await act(async () => {
      render(<CraftPage />);
    });
    fireEvent.click(query('[data-craft-pending-term="term-cccccccc"] [data-craft-action="term-approve"]'));
    await waitFor(() => {
      expect(approveTermSpy).toHaveBeenCalledWith({ termId: 'term-cccccccc' });
    });
    fireEvent.change(query('[data-craft-term-target="term-cccccccc"]'), { target: { value: 'term-aaaaaaaa' } });
    fireEvent.click(query('[data-craft-pending-term="term-cccccccc"] [data-craft-action="term-merge"]'));
    await waitFor(() => {
      expect(mergeTermSpy).toHaveBeenCalledWith({ termId: 'term-cccccccc', mergeIntoTermId: 'term-aaaaaaaa' });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('craft.toast.termMerged');
    });
  });
});
