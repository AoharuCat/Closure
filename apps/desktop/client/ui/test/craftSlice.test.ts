/**
 * craftSlice 状态机测试（E10.2b W5.6）。
 *
 * 覆盖：
 * - 装载去重（loaded 旗——非 force 二连零 IPC）；
 * - craft:distill-progress 事件三件套：
 *   · 可见性门控（activePage 不在 {craft, materials} 零响应——进度图不更新不重拉）；
 *   · 运行态事件 → 进度图 patch（零 IPC 重拉——两页徽章共用廉价面）；
 *   · 终态事件 → 进度图删条目 + 150ms 聚合窗后按可见面重拉（craft 页四清单全拉 /
 *     仅材料页 → 只拉台账）；窗内连发合并一次；
 *   · 关→开 force 补偿（onCraftSurfacesVisibility 边沿触发 + 重复通知幂等）；
 * - patch/review 成功 → 详情槽直写 result.card + 卡清单 force 重拉（编辑即降级可见反馈
 *   的数据面）；
 * - merge-review resolve / term merge → 对应清单重拉；
 * - runCraftDistill 入队成功 → 台账重拉；
 * - 订阅：桥缺面静默（旗标保持 false 可重试）、成功置旗标；
 * - **全局库跨项目：runProjectResets 不清 craft 状态**（无 registerProjectReset——
 *   design §3 拍板，回归守卫防误加）。
 *
 * mock 形态照 spec/ui/testing.md：最小组合 store（被测 slice + currentProject +
 * activePage）+ hand-made vi.fn 挂桥（文件级单 mock）。真实定时器（窗后断言用
 * sleepPastDebounce，beforeEach 排干上一测遗留窗口）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type {
  CraftCard,
  CraftCardSummary,
  CraftTerm,
} from '@orison/shared-contracts';
import {
  CRAFT_EVENT_DEBOUNCE_MS,
  createCraftSlice,
  type CraftSlice,
} from '../src/shared/store/craftSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';

type TestState = CraftSlice & {
  currentProject: { projectId?: string; path: string } | null;
  activePage: string;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activePage: 'craft',
  ...createCraftSlice(...args),
}));

// ── 文件级单 mock（spec/ui/testing.md 纪律：hand-made vi.fn 挂桥，beforeEach 清计数）──

function cardFixture(over: Partial<CraftCardSummary> = {}): CraftCardSummary {
  return {
    cardId: 'card-aaaaaaaaaaaa',
    category: 'qingxu',
    termId: 'term-aaaaaaaa',
    termName: '先抑后扬',
    title: '先抑后扬',
    condensed: '压低再抬高的回报模式',
    tags: [],
    status: 'pending_review',
    dispute: false,
    confidence: 0.9,
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
    claim: { condensed: '压低再抬高的回报模式', points: [], scenarios: [], counterexamples: [] },
    tags: [],
    teachings: [
      {
        teachingId: 'tea-aaaaaaaaaaaa',
        materialId: 'mat-aaaaaaaaaaaa',
        materialContentHash: `sha256:${'a'.repeat(64)}`,
        author: null,
        quote: '原文引文',
        anchor: { chapterIndex: 0, charStart: 0, charEnd: 10, paraStart: 0, paraEnd: 0 },
        rank: 'normal',
        note: null,
        stale: false,
      },
    ],
    dispute: false,
    status: 'pending_review',
    rejectReason: null,
    confidence: 0.9,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

const listCardsSpy = vi.fn(async (): Promise<CraftCardSummary[]> => [cardFixture()]);
const getCardSpy = vi.fn(async (): Promise<CraftCard | null> => fullCardFixture());
const patchCardSpy = vi.fn(async () => ({ ok: true as const, card: fullCardFixture({ status: 'pending_review' }) }));
const reviewCardSpy = vi.fn(async () => ({ ok: true as const, card: fullCardFixture({ status: 'verified' }) }));
const listMergeReviewsSpy = vi.fn(async () => []);
const resolveMergeReviewSpy = vi.fn(async () => ({
  ok: true as const,
  review: {},
  mergedIntoCardId: 'card-aaaaaaaaaaaa',
}));
const listTermsSpy = vi.fn(async (): Promise<CraftTerm[]> => [
  { termId: 'term-aaaaaaaa', category: 'qingxu', name: '先抑后扬', status: 'active', mergedInto: null, note: null },
]);
const approveTermSpy = vi.fn(async () => ({
  ok: true as const,
  term: { termId: 'term-bbbbbbbb', category: 'qingxu', name: '提案', status: 'active', mergedInto: null, note: null },
}));
const mergeTermSpy = vi.fn(async () => ({
  ok: true as const,
  term: { termId: 'term-bbbbbbbb', category: 'qingxu', name: '提案', status: 'merged', mergedInto: 'term-aaaaaaaa', note: null },
  movedCardCount: 2,
}));
const distillRunSpy = vi.fn(async () => ({
  ok: true as const,
  queued: ['mat-aaaaaaaaaaaa'],
  skipped: [],
}));
const distillStatusSpy = vi.fn(async () => [
  {
    materialId: 'mat-aaaaaaaaaaaa',
    contentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    status: 'done',
    stats: {
      claims: 5,
      anchored: 5,
      droppedNoAnchor: 0,
      droppedMalformed: 0,
      droppedNoCategory: 0,
      mergedAuto: 1,
      mergeReviews: 0,
      newCards: 3,
      disputes: 0,
    },
    phase: null,
    error: null,
    distilledAt: '2026-09-05T00:00:00.000Z',
  },
]);
const listMaterialsSpy = vi.fn(async () => []);

let progressListener: ((event: never) => void) | null = null;

function installBridge(withProgress = true) {
  progressListener = null;
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
    ...(withProgress
      ? {
          onCraftDistillProgress: (cb: (event: never) => void) => {
            progressListener = cb as typeof progressListener;
            return () => {
              progressListener = null;
            };
          },
        }
      : {}),
    listMaterials: listMaterialsSpy,
  };
}

/** 真实定时器下等过聚合窗 + 余量（窗后断言与 beforeEach 跨测排干共用）。 */
async function sleepPastDebounce() {
  await new Promise((resolve) => setTimeout(resolve, CRAFT_EVENT_DEBOUNCE_MS + 80));
}

/** 直调事件处理入口（mirror materialsSlice 测试直调 handleMaterialChanged——不经桥订阅面）。 */
function emitProgress(event: Record<string, unknown>) {
  useTestStore.getState().handleCraftDistillProgress(event as never);
}

function resetStore(over: Partial<TestState> = {}) {
  useTestStore.setState({
    currentProject: { projectId: '00001', path: '/proj-1' },
    activePage: 'craft',
    craftTab: 'queue',
    craftTagFilter: [],
    craftMaterialFilter: null,
    craftActiveReviewId: null,
    craftCardsLoaded: false,
    craftCards: [],
    craftCardsLoading: false,
    craftCardsError: null,
    craftCardDetail: null,
    craftCardDetailId: null,
    craftCardDetailLoading: false,
    craftCardDetailError: null,
    craftTermsLoaded: false,
    craftTerms: [],
    craftTermsLoading: false,
    craftMergeReviewsLoaded: false,
    craftMergeReviews: [],
    craftMergeReviewsLoading: false,
    craftDistillLedgersLoaded: false,
    craftDistillLedgers: [],
    craftDistillProgress: {},
    craftMaterialNamesLoaded: false,
    craftMaterialNames: {},
    craftEventsSubscribed: false,
    craftSurfacesVisible: false,
    ...over,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  resetStore();
});

describe('装载', () => {
  it('五清单装载 + loaded 旗去重（非 force 二连零二次 IPC）', async () => {
    await useTestStore.getState().loadCraftCards(false);
    await useTestStore.getState().loadCraftCards(false);
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
    expect(useTestStore.getState().craftCards.length).toBe(1);

    await useTestStore.getState().loadCraftTerms(false);
    expect(useTestStore.getState().craftTermsLoaded).toBe(true);
    await useTestStore.getState().loadCraftMergeReviews(false);
    await useTestStore.getState().loadCraftDistillLedgers(false);
    expect(listTermsSpy).toHaveBeenCalledTimes(1);
    expect(listMergeReviewsSpy).toHaveBeenCalledTimes(1);
    expect(distillStatusSpy).toHaveBeenCalledTimes(1);
  });

  it('卡清单错误落 craftCardsError（不抛——页面错误态呈现）', async () => {
    listCardsSpy.mockRejectedValueOnce(new Error('boom'));
    await useTestStore.getState().loadCraftCards(true);
    expect(useTestStore.getState().craftCardsError).toBe('boom');
    expect(useTestStore.getState().craftCardsLoading).toBe(false);
  });
});

describe('craft:distill-progress 事件三件套', () => {
  it('可见性门控：两消费面外（overview）零响应', async () => {
    resetStore({ activePage: 'overview' });
    emitProgress({ materialId: 'mat-aaaaaaaaaaaa', status: 'running', phase: 'extracting', elapsedMs: 1000 });
    expect(useTestStore.getState().craftDistillProgress).toEqual({});
  });

  it('运行态事件 → 进度图 patch（零清单重拉）', () => {
    emitProgress({ materialId: 'mat-aaaaaaaaaaaa', status: 'running', phase: 'dedup', elapsedMs: 2000 });
    expect(useTestStore.getState().craftDistillProgress['mat-aaaaaaaaaaaa']).toMatchObject({
      status: 'running',
      phase: 'dedup',
      elapsedMs: 2000,
    });
    expect(listCardsSpy).not.toHaveBeenCalled();
    expect(distillStatusSpy).not.toHaveBeenCalled();
  });

  it('终态事件 → 进度图删条目 + 聚合窗后 craft 页四清单重拉；窗内连发合并', async () => {
    // 先装载（loaded 旗在——重拉必须是 force 生效）。
    await useTestStore.getState().loadCraftCards(false);
    await useTestStore.getState().loadCraftTerms(false);
    await useTestStore.getState().loadCraftMergeReviews(false);
    await useTestStore.getState().loadCraftDistillLedgers(false);
    vi.clearAllMocks();

    emitProgress({ materialId: 'mat-aaaaaaaaaaaa', status: 'running', phase: 'landing', elapsedMs: 3000 });
    emitProgress({ materialId: 'mat-aaaaaaaaaaaa', status: 'done', phase: null, elapsedMs: 5000 });
    emitProgress({ materialId: 'mat-bbbbbbbbbbbb', status: 'failed', phase: null, elapsedMs: 9000, error: 'x' });
    // 终态即删条目（徽章回落台账）。
    expect(useTestStore.getState().craftDistillProgress).toEqual({});
    await sleepPastDebounce();
    // craft 页可见 → 四清单全拉（cards/terms/mergeReviews/ledgers 各一次——连发合并）。
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
    expect(listTermsSpy).toHaveBeenCalledTimes(1);
    expect(listMergeReviewsSpy).toHaveBeenCalledTimes(1);
    expect(distillStatusSpy).toHaveBeenCalledTimes(1);
  });

  it('仅材料页可见（activePage=materials）→ 终态只拉台账不拉卡清单', async () => {
    await useTestStore.getState().loadCraftCards(false);
    vi.clearAllMocks();
    resetStore({ activePage: 'materials', craftCardsLoaded: true });
    emitProgress({ materialId: 'mat-aaaaaaaaaaaa', status: 'done', phase: null, elapsedMs: 5000 });
    await sleepPastDebounce();
    expect(distillStatusSpy).toHaveBeenCalledTimes(1);
    expect(listCardsSpy).not.toHaveBeenCalled();
  });

  it('窗内切走（craft→overview）→ 执行时二次门控丢弃', async () => {
    emitProgress({ materialId: 'mat-aaaaaaaaaaaa', status: 'done', phase: null, elapsedMs: 5000 });
    useTestStore.setState({ activePage: 'overview' } as any);
    await sleepPastDebounce();
    expect(distillStatusSpy).not.toHaveBeenCalled();
    expect(listCardsSpy).not.toHaveBeenCalled();
  });

  it('关→开 force 补偿：onCraftSurfacesVisibility 边沿触发 + 重复通知幂等', async () => {
    await useTestStore.getState().loadCraftCards(false);
    await useTestStore.getState().loadCraftTerms(false);
    vi.clearAllMocks();
    useTestStore.getState().onCraftSurfacesVisibility(true);
    useTestStore.getState().onCraftSurfacesVisibility(true); // 重复通知无动作
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
    expect(listTermsSpy).toHaveBeenCalledTimes(1);
    // 开→关无动作。
    useTestStore.getState().onCraftSurfacesVisibility(false);
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
  });
});

describe('写路径回读', () => {
  it('patchCraftCard 成功 → 详情槽直写 result.card + 卡清单 force 重拉', async () => {
    await useTestStore.getState().loadCraftCard('card-aaaaaaaaaaaa');
    vi.clearAllMocks();
    const result = await useTestStore.getState().patchCraftCard('card-aaaaaaaaaaaa', { title: '新名' });
    expect(result.ok).toBe(true);
    expect(useTestStore.getState().craftCardDetail?.cardId).toBe('card-aaaaaaaaaaaa');
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
  });

  it('reviewCraftCard 成功（rank-only）→ 详情直写 + 清单重拉', async () => {
    const result = await useTestStore
      .getState()
      .reviewCraftCard({ cardId: 'card-aaaaaaaaaaaa', teachingRank: { teachingId: 'tea-aaaaaaaaaaaa', rank: 'approved' } });
    expect(result.ok).toBe(true);
    expect(useTestStore.getState().craftCardDetail?.status).toBe('verified');
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
  });

  it('resolveCraftMergeReview 成功 → 并排 + 卡清单重拉', async () => {
    const result = await useTestStore
      .getState()
      .resolveCraftMergeReview({ reviewId: 'mrev-aaaaaaaaaaaa', action: 'merge' });
    expect(result.ok).toBe(true);
    expect(listMergeReviewsSpy).toHaveBeenCalledTimes(1);
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
  });

  it('term merge 成功 → 词表 + 卡清单都重拉（挂卡改挂目标）', async () => {
    const result = await useTestStore.getState().mergeCraftTerm('term-bbbbbbbb', 'term-aaaaaaaa');
    expect(result.ok).toBe(true);
    expect(listTermsSpy).toHaveBeenCalledTimes(1);
    expect(listCardsSpy).toHaveBeenCalledTimes(1);
  });

  it('term approve 成功 → 词表重拉（卡不动）', async () => {
    const result = await useTestStore.getState().approveCraftTerm('term-bbbbbbbb');
    expect(result.ok).toBe(true);
    expect(listTermsSpy).toHaveBeenCalledTimes(1);
    expect(listCardsSpy).not.toHaveBeenCalled();
  });

  it('runCraftDistill 入队成功 → 台账重拉（pending/running 行可见）', async () => {
    const result = await useTestStore.getState().runCraftDistill(['mat-aaaaaaaaaaaa']);
    expect(result.ok).toBe(true);
    expect(distillStatusSpy).toHaveBeenCalledTimes(1);
  });
});

describe('订阅', () => {
  it('subscribeCraftEvents 成功置旗标（App 引导一次挂）', () => {
    useTestStore.getState().subscribeCraftEvents();
    expect(useTestStore.getState().craftEventsSubscribed).toBe(true);
  });

  it('桥缺面（旧 preload）静默——旗标保持 false 可重试', () => {
    installBridge(false);
    useTestStore.getState().subscribeCraftEvents();
    expect(useTestStore.getState().craftEventsSubscribed).toBe(false);
  });
});

describe('全局库跨项目（无 registerProjectReset）', () => {
  it('runProjectResets 不清 craft 状态（design §3 拍板——回归守卫防误加）', async () => {
    await useTestStore.getState().loadCraftCards(false);
    emitProgress({ materialId: 'mat-aaaaaaaaaaaa', status: 'running', phase: 'extracting', elapsedMs: 1 });
    runProjectResets();
    const s = useTestStore.getState();
    expect(s.craftCards.length).toBe(1);
    expect(s.craftDistillProgress['mat-aaaaaaaaaaaa']).toBeDefined();
  });
});
