/**
 * 「手艺」页 slice（E10.2b W5，design §3——手艺卡库 + 蒸馏人审面）。
 *
 * 数据面（全局库——craft 卡/词表/并排任务/台账四清单 + 卡详情表单数据源 + 蒸馏进度图）。
 * IPC 全经 shared/api/craft + shared/api/materials（材料名解析复用材料页清单面——零新 IPC）。
 *
 * **全局库跨项目：无 registerProjectReset**（mirror 材料全局车道语义，design §3 拍板——
 * craft 卡/词表/台账是机器级资产，切项目不清）。tab/过滤/详情是纯视图态随会话存续。
 *
 * 事件刷新三件套（spec/ui/state-management，mirror materialsSlice 全套——消费面 = 手艺页
 * + 材料页徽章两页）：
 * 1. **可见性门控**：craft:distill-progress 事件入口先查 `activePage ∈ {craft, materials}`
 *    （两消费面都在时才响应——手艺页队列/运行条 + 材料页蒸馏徽章；其他页面不重拉）。
 * 2. **debounce 聚合窗**：终态事件（done/failed/material-deleted——卡/词表/并排任务/台账
 *    都可能变化）进固定 150ms 窗，到期按可见面重拉（craft 页 → 四清单全拉；材料页 →
 *    台账拉取〔徽章 stats 取数〕）。运行中事件（pending/running）只更新进度图（廉价
 *    内存 patch，两页徽章共用）不开窗。
 * 3. **打开 force 补偿**：onCraftSurfacesVisibility 只在关→开边沿 force 重拉（事件
 *    best-effort 可丢的读侧兜底）；App.tsx 按 activePage 接线。
 *
 * 进度图（craftDistillProgress）只持有**运行前终态**事件（pending/running——运行中相位/
 * 耗时徽章源）；终态事件到达即删该 materialId 条目（徽章回落台账行——done 的 stats/
 * failed 的 error 都在台账侧），防双源分歧。
 *
 * 编辑即降级反馈：patchCraftCard/reviewCraftCard 成功把 result.card 直写详情槽（表单
 * 基线即时刷新——status 翻 pending_review 的可见降级反馈数据面）+ force 重拉清单。
 */
import type { StateCreator } from 'zustand';
import type {
  CraftCard,
  CraftCardPatchInput,
  CraftCardPatchResult,
  CraftCardReviewInput,
  CraftCardReviewResult,
  CraftCardSummary,
  CraftDistillLedger,
  CraftDistillProgressEvent,
  CraftDistillRunResult,
  CraftMergeReview,
  CraftMergeReviewResolveInput,
  CraftMergeReviewResolveResult,
  CraftTerm,
} from '@orison/shared-contracts';
import {
  approveCraftTermApi,
  getCraftCard,
  getCraftDistillStatus,
  listCraftCards,
  listCraftMergeReviews,
  listCraftTerms,
  mergeCraftTermApi,
  patchCraftCardApi,
  resolveCraftMergeReviewApi,
  reviewCraftCardApi,
  runCraftDistillApi,
  subscribeCraftDistillProgress,
} from '../api/craft';
import { listMaterials } from '../api/materials';

/** 手艺页四 tab（design §3 mockup 定稿：审阅队列/全部卡/废弃区/词表管理）。 */
export type CraftTab = 'queue' | 'all' | 'rejected' | 'terms';

/** craft:distill-progress 终态事件聚合窗时长（导出供测试对表，勿内联字面量）。 */
export const CRAFT_EVENT_DEBOUNCE_MS = 150;

export type CraftSlice = {
  // ── 视图态 ──
  craftTab: CraftTab;
  /** 自由标签 OR 过滤（R10 chips 点击过滤）。 */
  craftTagFilter: string[];
  /** 来源材料过滤（材料页 N 卡跳转 / 按材料分批）。null = 不过滤。 */
  craftMaterialFilter: string | null;
  /** 并排对比打开态（merge review id；null = 关）。 */
  craftActiveReviewId: string | null;

  // ── 卡清单（全量一次装载，tab/tag/material 过滤客户端做——零重拉）──
  craftCardsLoaded: boolean;
  craftCards: CraftCardSummary[];
  craftCardsLoading: boolean;
  craftCardsError: string | null;

  // ── 卡详情（编辑表单数据源；cardId 键控竞态守卫）──
  craftCardDetail: CraftCard | null;
  craftCardDetailId: string | null;
  craftCardDetailLoading: boolean;
  craftCardDetailError: string | null;

  // ── 词表（补全 chips + 词表管理 tab + 待并词表统计）──
  craftTermsLoaded: boolean;
  craftTerms: CraftTerm[];
  craftTermsLoading: boolean;

  // ── 并排任务 ──
  craftMergeReviewsLoaded: boolean;
  craftMergeReviews: CraftMergeReview[];
  craftMergeReviewsLoading: boolean;

  // ── 蒸馏台账 + 进度图（材料页徽章共用）──
  craftDistillLedgersLoaded: boolean;
  craftDistillLedgers: CraftDistillLedger[];
  craftDistillProgress: Record<string, CraftDistillProgressEvent>;

  /** 材料名解析（materialId → name；卡分批组头/并排作者语境——查无名回落 id 短形）。 */
  craftMaterialNamesLoaded: boolean;
  craftMaterialNames: Record<string, string>;

  craftEventsSubscribed: boolean;
  craftSurfacesVisible: boolean;

  setCraftTab: (tab: CraftTab) => void;
  /** 标签过滤切换（在过滤内 = 移除；不在 = 追加——OR 语义）。 */
  toggleCraftTagFilter: (tag: string) => void;
  clearCraftFilters: () => void;
  /** 材料页 N 卡跳转落点（过滤 + 队列 tab；页面导航 setActivePage 归调用方——slice 不跨 panels）。 */
  openCraftForMaterial: (materialId: string) => void;
  openCraftMergeReview: (reviewId: string) => void;
  closeCraftMergeReview: () => void;

  loadCraftCards: (force?: boolean) => Promise<void>;
  loadCraftCard: (cardId: string, force?: boolean) => Promise<void>;
  clearCraftCard: () => void;
  loadCraftTerms: (force?: boolean) => Promise<void>;
  loadCraftMergeReviews: (force?: boolean) => Promise<void>;
  loadCraftDistillLedgers: (force?: boolean) => Promise<void>;
  /** 材料名解析（全局 + 当前项目两车道清单合并——craft 卡可源自任一车道材料）。 */
  loadCraftMaterialNames: (force?: boolean) => Promise<void>;

  patchCraftCard: (
    cardId: string,
    patch: CraftCardPatchInput['patch'],
  ) => Promise<CraftCardPatchResult>;
  reviewCraftCard: (input: CraftCardReviewInput) => Promise<CraftCardReviewResult>;
  resolveCraftMergeReview: (
    input: CraftMergeReviewResolveInput,
  ) => Promise<CraftMergeReviewResolveResult>;
  approveCraftTerm: (termId: string) => Promise<import('@orison/shared-contracts').CraftTermApproveResult>;
  /** 词目归并（挂它的卡改挂目标 + category 跟随——成功后卡清单亦重拉）。 */
  mergeCraftTerm: (
    termId: string,
    mergeIntoTermId: string,
  ) => Promise<import('@orison/shared-contracts').CraftTermMergeResult>;
  /** 材料页「蒸馏」按钮（单/批量入队；相位经 progress 事件，台账回读兜底）。 */
  runCraftDistill: (materialIds: string[]) => Promise<CraftDistillRunResult>;

  subscribeCraftEvents: () => void;
  /** 事件处理（订阅回调入口；独立暴露供测试直调）。 */
  handleCraftDistillProgress: (event: CraftDistillProgressEvent) => void;
  /** 两消费面可见性通知（App 按 activePage 接线；关→开边沿 force 重拉）。 */
  onCraftSurfacesVisibility: (visible: boolean) => void;
};

type Deps = CraftSlice & {
  currentProject: { projectId?: string; path: string } | null;
  /** panelsSlice 状态（事件可见性门控单源；最小组合测试 store 须随附本字段）。 */
  activePage: string;
};

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const createCraftSlice: StateCreator<Deps, [], [], CraftSlice> = (set, get) => {
  // 装载 seq（作废在途 stale resolve，mirror materialsSlice）。
  let cardsReqSeq = 0;
  let detailReqSeq = 0;

  // 终态事件聚合窗（固定窗：首条开窗、窗内并入不重置）。
  let burstTimer: ReturnType<typeof setTimeout> | null = null;
  let burstTerminal = false;

  const fireBurst = () => {
    burstTimer = null;
    if (!burstTerminal) return;
    burstTerminal = false;
    const page = (get() as Deps).activePage;
    // 窗口期内两消费面可能都已切走——执行时二次门控（重新打开由 visibility force 补偿兜底）。
    if (page !== 'craft' && page !== 'materials') return;
    void get().loadCraftDistillLedgers(true);
    if (page === 'craft') {
      // 终态蒸馏落卡/并排任务/pending 词目提案都可能出现——craft 页四清单全拉。
      void get().loadCraftCards(true);
      void get().loadCraftMergeReviews(true);
      void get().loadCraftTerms(true);
    }
  };

  // 注：全局库跨项目——**无 registerProjectReset**（文件头注记）。

  return {
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

    setCraftTab: (tab) => {
      set({ craftTab: tab });
    },

    toggleCraftTagFilter: (tag) => {
      const current = get().craftTagFilter;
      set({
        craftTagFilter: current.includes(tag)
          ? current.filter((t) => t !== tag)
          : [...current, tag],
      });
    },

    clearCraftFilters: () => {
      set({ craftTagFilter: [], craftMaterialFilter: null });
    },

    openCraftForMaterial: (materialId) => {
      set({ craftMaterialFilter: materialId, craftTagFilter: [], craftTab: 'queue' });
    },

    openCraftMergeReview: (reviewId) => {
      set({ craftActiveReviewId: reviewId });
    },

    closeCraftMergeReview: () => {
      set({ craftActiveReviewId: null });
    },

    loadCraftCards: async (force = false) => {
      if (!force && (get().craftCardsLoaded || get().craftCardsLoading)) return;
      const seq = ++cardsReqSeq;
      set({ craftCardsLoading: true, craftCardsError: null });
      try {
        const rows = await listCraftCards({ sort: 'updated-desc' });
        if (seq !== cardsReqSeq) return;
        set({ craftCards: rows, craftCardsLoading: false, craftCardsLoaded: true });
      } catch (err) {
        if (seq !== cardsReqSeq) return;
        set({ craftCardsLoading: false, craftCardsError: errorReason(err) });
      }
    },

    loadCraftCard: async (cardId, force = false) => {
      const s = get();
      if (!force && s.craftCardDetailId === cardId && s.craftCardDetail !== null) return;
      const seq = ++detailReqSeq;
      set({ craftCardDetailLoading: true, craftCardDetailId: cardId, craftCardDetailError: null });
      try {
        const card = await getCraftCard(cardId);
        if (seq !== detailReqSeq) return;
        set({ craftCardDetail: card, craftCardDetailLoading: false });
      } catch (err) {
        if (seq !== detailReqSeq) return;
        set({ craftCardDetail: null, craftCardDetailLoading: false, craftCardDetailError: errorReason(err) });
      }
    },

    clearCraftCard: () => {
      detailReqSeq += 1;
      set({ craftCardDetail: null, craftCardDetailId: null, craftCardDetailLoading: false, craftCardDetailError: null });
    },

    loadCraftTerms: async (force = false) => {
      if (!force && (get().craftTermsLoaded || get().craftTermsLoading)) return;
      set({ craftTermsLoading: true });
      try {
        // 全量（含 pending 待并词表——补全面 + 管理面 + 统计共用一次装载）。
        const terms = await listCraftTerms({});
        set({ craftTerms: terms, craftTermsLoading: false, craftTermsLoaded: true });
      } catch {
        // 词表失败不阻塞页面（补全回落 termId 短形 + 管理面空态）——静默降级。
        set({ craftTermsLoading: false });
      }
    },

    loadCraftMergeReviews: async (force = false) => {
      if (!force && (get().craftMergeReviewsLoaded || get().craftMergeReviewsLoading)) return;
      set({ craftMergeReviewsLoading: true });
      try {
        const reviews = await listCraftMergeReviews({});
        set({ craftMergeReviews: reviews, craftMergeReviewsLoading: false, craftMergeReviewsLoaded: true });
      } catch {
        set({ craftMergeReviewsLoading: false });
      }
    },

    loadCraftDistillLedgers: async (force = false) => {
      if (!force && get().craftDistillLedgersLoaded) return;
      try {
        // 省略 materialIds = 全部台账行（契约）。
        const ledgers = await getCraftDistillStatus({});
        set({ craftDistillLedgers: ledgers, craftDistillLedgersLoaded: true });
      } catch {
        // 台账失败不阻塞（徽章回落「未蒸馏」）——材料页主清单不受影响。
      }
    },

    loadCraftMaterialNames: async (force = false) => {
      if (!force && get().craftMaterialNamesLoaded) return;
      const projectId = (get() as Deps).currentProject?.projectId ?? null;
      const names: Record<string, string> = {};
      try {
        // craft 卡可源自任一车道材料——全局 + 当前项目（有打开项目时）两清单合并解析。
        const globalRows = await listMaterials({ scope: 'global' });
        for (const row of globalRows) names[row.materialId] = row.name;
        if (projectId !== null) {
          const projectRows = await listMaterials({ scope: 'project', projectId });
          for (const row of projectRows) names[row.materialId] = row.name;
        }
        set({ craftMaterialNames: names, craftMaterialNamesLoaded: true });
      } catch {
        // 名字解析是 cosmetic——失败静默（组头回落 materialId 短形）。
      }
    },

    patchCraftCard: async (cardId, patch) => {
      const result = await patchCraftCardApi({ cardId, patch });
      if (result.ok) {
        // 详情槽直写 result.card（表单基线即时刷新——降级可见反馈的数据面）+ 清单重拉。
        detailReqSeq += 1;
        set({ craftCardDetail: result.card, craftCardDetailId: result.card.cardId });
        void get().loadCraftCards(true);
      }
      return result;
    },

    reviewCraftCard: async (input) => {
      const result = await reviewCraftCardApi(input);
      if (result.ok) {
        detailReqSeq += 1;
        set({ craftCardDetail: result.card, craftCardDetailId: result.card.cardId });
        void get().loadCraftCards(true);
      }
      return result;
    },

    resolveCraftMergeReview: async (input) => {
      const result = await resolveCraftMergeReviewApi(input);
      if (result.ok) {
        // 并排队列 + 卡清单都变（merge 挂讲法 / independent 新建卡）。
        void get().loadCraftMergeReviews(true);
        void get().loadCraftCards(true);
      }
      return result;
    },

    approveCraftTerm: async (termId) => {
      const result = await approveCraftTermApi(termId);
      if (result.ok) void get().loadCraftTerms(true);
      return result;
    },

    mergeCraftTerm: async (termId, mergeIntoTermId) => {
      const result = await mergeCraftTermApi({ termId, mergeIntoTermId });
      if (result.ok) {
        // 词目归并迁移挂卡（termId/category 跟随）——词表 + 卡清单都重拉。
        void get().loadCraftTerms(true);
        void get().loadCraftCards(true);
      }
      return result;
    },

    runCraftDistill: async (materialIds) => {
      const result = await runCraftDistillApi({ materialIds });
      if (result.ok && result.queued.length > 0) {
        // 入队即回——台账拉取见 pending/running 行（相位/耗时后续走 progress 事件）。
        void get().loadCraftDistillLedgers(true);
      }
      return result;
    },

    subscribeCraftEvents: () => {
      if (get().craftEventsSubscribed) return;
      const unsubscribe = subscribeCraftDistillProgress((event) => {
        get().handleCraftDistillProgress(event);
      });
      if (unsubscribe === null) return; // 桥缺面（旧 preload）——静默，打开 force 补偿兜底
      set({ craftEventsSubscribed: true });
    },

    handleCraftDistillProgress: (event) => {
      // 可见性门控：两消费面（手艺页/材料页）都不可见不响应。
      const page = (get() as Deps).activePage;
      if (page !== 'craft' && page !== 'materials') return;
      if (event.status === 'running' || event.status === 'pending') {
        // 运行态：进度图 patch（廉价——两页徽章共用，无 IPC）。
        set({ craftDistillProgress: { ...get().craftDistillProgress, [event.materialId]: event } });
        return;
      }
      // 终态：进度图删条目（徽章回落台账行——stats/error 在台账侧）+ 聚合窗重拉。
      const next = { ...get().craftDistillProgress };
      delete next[event.materialId];
      set({ craftDistillProgress: next });
      burstTerminal = true;
      if (burstTimer === null) {
        burstTimer = setTimeout(fireBurst, CRAFT_EVENT_DEBOUNCE_MS);
      }
    },

    onCraftSurfacesVisibility: (visible) => {
      if (visible === get().craftSurfacesVisible) return; // 边沿触发（重复通知无动作）
      set({ craftSurfacesVisible: visible });
      if (!visible) return; // 开→关无动作
      // 关→开补偿：事件可丢的读侧兜底——force 重拉（craft 页四清单 + 台账）。
      void get().loadCraftCards(true);
      void get().loadCraftTerms(true);
      void get().loadCraftMergeReviews(true);
      void get().loadCraftDistillLedgers(true);
      void get().loadCraftMaterialNames(true);
    },
  };
};
