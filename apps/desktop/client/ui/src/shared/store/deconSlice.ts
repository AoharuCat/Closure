/**
 * 「拆书」页 slice（E10.3b W6，design §8）——拆解会话清单/详情/进度/产物阅读的数据面。
 *
 * 数据面（机器级——closure_decon_* 表住 ~/.orison 引擎，跨项目存续）：job 清单（decon:list）
 * + 选中 job 详情（decon:get：passStates + canon + 词典/实体 + reviews + reportCounts）+
 * progress 进度图（decon:progress 事件）+ product/report 读面（闸门卡/产出阅读取数）。
 * IPC 全经 shared/api/decon（module-structure invariant）。
 *
 * **机器级资产：无 registerProjectReset**（mirror craftSlice 全局库语义——拆解 job 不随项目
 * 切换清；风格导出的目标项目绑定 = 操作时 currentProject 上下文，非持久归属）。
 *
 * 事件刷新三件套（spec/ui/state-management，mirror materialsSlice/craftSlice 全套）：
 * 1. **可见性门控**：decon:progress 事件入口先查 `activePage === 'decon'`，页面不可见即丢。
 * 2. **debounce 聚合窗**：终态事件（running 之外——done/paused/capped/stale/failed/cancelled）
 *    进固定 150ms 窗，到期 force 重拉清单 + 选中详情 + 报告 meta；运行中事件只 patch 进度图
 *    （廉价内存面——当前 pass/unit/elapsedMs 的徽章源）不开窗。
 * 3. **打开 force 补偿**：onDeconPageVisibility 只在关→开边沿 force 重拉（事件 best-effort
 *    可丢的读侧兜底）；App.tsx 按 activePage 接线。
 *
 * 进度图（deconProgress）持运行中事件；终态事件到达即删该 jobId 条目（状态/错误面回落
 * job 行——capped/failed 的 error 在 job 行，防双源分歧，mirror craftDistillProgress）。
 * **例外（CR-10 note 面）**：带非空 `note` 的终态事件（闸门暂停的「待人工确认」软提示）在图内
 * 留存供横幅消费——事件 best-effort 可丢，丢则回落 review 行判定的既有文案；续跑 running 事件
 * 自然覆盖。
 *
 * **闸门确认即续跑**（design §6 拍板①）：shell 的 decon:approve-review handler 是**唯一
 * start 所有者**（approve 成功即壳内自动 start + spawn 管线续跑——CR-3 单所有者纪律：正确性
 * 不靠幂等兜底）。slice 只做成功后刷新 detail（job 行翻 running 的可见反馈），**不再二次
 * invoke start**。
 */
import type { StateCreator } from 'zustand';
import type {
  DeconApproveReviewResult,
  DeconConfirmRerunResult,
  DeconCreateInput,
  DeconCreateResult,
  DeconDeleteResult,
  DeconExportStyleResult,
  DeconJob,
  DeconJobDetail,
  DeconProductRow,
  DeconProgressEvent,
  DeconReportKind,
  DeconReportMeta,
  DeconReportRow,
  DeconReviewCheckpoint,
  DeconStartResult,
  DeconTransitionResult,
} from '@orison/shared-contracts';
import type { DeconBudgetInput } from '@orison/shared-contracts';
import {
  approveDeconReview as approveDeconReviewApi,
  confirmRerunDecon as confirmRerunDeconApi,
  createDecon as createDeconApi,
  deleteDecon as deleteDeconApi,
  exportDeconStyle as exportDeconStyleApi,
  fetchDeconProducts as fetchDeconProductsApi,
  fetchDeconReports as fetchDeconReportsApi,
  getDecon as getDeconApi,
  listDeconJobs,
  pauseDecon as pauseDeconApi,
  cancelDecon as cancelDeconApi,
  startDecon as startDeconApi,
  subscribeDeconProgress,
} from '../api/decon';

/** 「拆书」页产出阅读五 tab（design §8 ⑤——读法/章评/细批/风格/canon）。 */
export type DeconOutputTab = 'reading' | 'chapters' | 'scenes' | 'style' | 'canon';

/** decon:progress 终态事件聚合窗时长（导出供测试对表，勿内联字面量）。 */
export const DECON_EVENT_DEBOUNCE_MS = 150;

export type DeconSlice = {
  // ── 视图态 ──
  /** 新建拆解向导开合。 */
  deconWizardOpen: boolean;
  setDeconWizardOpen: (open: boolean) => void;
  deconSelectedJobId: string | null;
  /** 选中 job（null = 清选——联动清详情/报告面）。 */
  selectDeconJob: (jobId: string | null) => void;
  deconOutputTab: DeconOutputTab;
  setDeconOutputTab: (tab: DeconOutputTab) => void;

  // ── job 清单 ──
  deconJobsLoaded: boolean;
  deconJobs: DeconJob[];
  deconJobsLoading: boolean;
  deconJobsError: string | null;

  // ── 选中 job 详情（decon:get 聚合面）──
  deconDetail: DeconJobDetail | null;
  deconDetailLoading: boolean;
  deconDetailError: string | null;

  // ── 进度图（jobId → 最新运行中事件；终态事件即删条目）──
  deconProgress: Record<string, DeconProgressEvent>;

  // ── product 读面（闸门卡 findings / 产出阅读取数——`${jobId}:${pass ?? '*'}` 键控）──
  deconProducts: Record<string, DeconProductRow[]>;
  deconProductsLoading: boolean;

  // ── report 读面（列表 meta 只回 meta——内容经单取，design §8）──
  deconReportMetas: DeconReportMeta[];
  deconReportMetasLoadedFor: string | null;
  deconReportsLoading: boolean;
  /** 单取全文（kind:unit 键控展示——null = 未取/清空）。 */
  deconReportContent: DeconReportRow | null;
  deconReportContentKey: string | null;
  deconReportContentLoading: boolean;

  deconEventsSubscribed: boolean;
  deconPageVisible: boolean;

  loadDeconJobs: (force?: boolean) => Promise<void>;
  loadDeconJobDetail: (jobId: string, force?: boolean) => Promise<void>;
  createDeconJob: (input: DeconCreateInput) => Promise<DeconCreateResult>;
  startDeconJob: (jobId: string, budget?: DeconBudgetInput) => Promise<DeconStartResult>;
  pauseDeconJob: (jobId: string) => Promise<DeconTransitionResult>;
  cancelDeconJob: (jobId: string) => Promise<DeconTransitionResult>;
  deleteDeconJob: (jobId: string) => Promise<DeconDeleteResult>;
  /**
   * 闸门确认（approve-review ok → **壳内自动 start 续跑**——CR-3 壳 handler 唯一 start
   * 所有者；slice 只刷新 detail，零二次 start）。返 approve 结果原样。
   */
  approveDeconReview: (
    jobId: string,
    checkpoint: DeconReviewCheckpoint,
  ) => Promise<DeconApproveReviewResult | { ok: false; error: 'operation-failed'; message: string }>;
  /** stale 确认重跑（W7 小补③——shell 侧 confirm+start 一体；成功后刷新清单/详情）。 */
  confirmRerunDecon: (jobId: string) => Promise<DeconConfirmRerunResult>;
  /**
   * product 行拉取（CR-8：`filter.pass` 全值精确 / `filter.passStem` pass 前缀——'p4' 匹配全部
   * p4:<dim> 含 p4:style，维内裁剪归 UI 消费面；缺省 = 全部）。成功回填缓存（键 =
   * `${jobId}:${pass ?? passStem ?? '*'}`——不同过滤面互不覆写）。
   */
  fetchDeconProducts: (
    jobId: string,
    filter?: { pass?: string; passStem?: string },
  ) => Promise<DeconProductRow[]>;
  loadDeconReportMetas: (jobId: string, force?: boolean) => Promise<void>;
  /** 报告单取全文（kind:unit 键控——切换即替）。 */
  fetchDeconReport: (jobId: string, kind: DeconReportKind, unit: string) => Promise<void>;
  clearDeconReportContent: () => void;
  exportDeconStyle: (jobId: string, projectId: string) => Promise<DeconExportStyleResult>;

  subscribeDeconEvents: () => void;
  /** 事件处理（订阅回调入口；独立暴露供测试直调）。 */
  handleDeconProgress: (event: DeconProgressEvent) => void;
  /** 页面可见性通知（App 按 activePage 接线；关→开边沿 force 重拉）。 */
  onDeconPageVisibility: (visible: boolean) => void;
};

type Deps = DeconSlice & {
  /** panelsSlice 状态（事件可见性门控单源；最小组合测试 store 须随附本字段）。 */
  activePage: string;
};

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 终态刷新族（清单 + 选中详情 + 报告 meta——capped/stale 状态面都在 job 行/detail）。
 * **products 缓存一并清空**（CR-9）：confirm-rerun 等变更路径产物面已被 shell 复位——旧缓存
 * 不清则旧指纹 findings 无限期滞留闸门卡；闸门/导出重开时按过滤键重拉。
 */
function refreshAfterJobMutation(
  set: (partial: Partial<DeconSlice>) => void,
  get: () => DeconSlice,
): void {
  set({ deconProducts: {} });
  void get().loadDeconJobs(true);
  const id = get().deconSelectedJobId;
  if (id !== null) {
    void get().loadDeconJobDetail(id, true);
    void get().loadDeconReportMetas(id, true);
  }
}

export const createDeconSlice: StateCreator<Deps, [], [], DeconSlice> = (set, get) => {
  // 清单/详情装载 seq（作废在途 stale resolve，mirror materialsSlice）。
  let jobsReqSeq = 0;
  let detailReqSeq = 0;

  // decon:progress 终态事件聚合窗（固定窗：首条开窗、窗内并入不重置）。
  let burstTimer: ReturnType<typeof setTimeout> | null = null;
  let burstTerminal = false;

  const fireBurst = () => {
    burstTimer = null;
    if (!burstTerminal) return;
    burstTerminal = false;
    // 窗口期内页面可能已切走——执行时二次门控（重新打开由 visibility force 补偿兜底）。
    if ((get() as Deps).activePage !== 'decon') return;
    refreshAfterJobMutation(set, get);
  };

  // 注：机器级资产跨项目——**无 registerProjectReset**（文件头注记）。

  return {
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

    deconEventsSubscribed: false,
    deconPageVisible: false,

    setDeconWizardOpen: (open) => {
      set({ deconWizardOpen: open });
    },

    selectDeconJob: (jobId) => {
      if (jobId === null) {
        detailReqSeq += 1;
        set({
          deconSelectedJobId: null,
          deconDetail: null,
          deconDetailError: null,
          deconReportMetas: [],
          deconReportMetasLoadedFor: null,
          deconReportContent: null,
          deconReportContentKey: null,
        });
        return;
      }
      set({ deconSelectedJobId: jobId, deconReportContent: null, deconReportContentKey: null });
      void get().loadDeconJobDetail(jobId, false);
      void get().loadDeconReportMetas(jobId, false);
    },

    setDeconOutputTab: (tab) => {
      set({ deconOutputTab: tab });
    },

    loadDeconJobs: async (force = false) => {
      if (!force && (get().deconJobsLoaded || get().deconJobsLoading)) return;
      const seq = ++jobsReqSeq;
      set({ deconJobsLoading: true, deconJobsError: null });
      try {
        const rows = await listDeconJobs({});
        if (seq !== jobsReqSeq) return;
        set({ deconJobs: rows, deconJobsLoading: false, deconJobsLoaded: true });
      } catch (err) {
        if (seq !== jobsReqSeq) return;
        set({ deconJobsLoading: false, deconJobsError: errorReason(err) });
      }
    },

    loadDeconJobDetail: async (jobId, force = false) => {
      const s = get();
      if (!force && s.deconSelectedJobId === jobId && s.deconDetail !== null) return;
      const seq = ++detailReqSeq;
      set({ deconDetailLoading: true, deconDetailError: null });
      try {
        const detail = await getDeconApi(jobId);
        if (seq !== detailReqSeq) return;
        set({ deconDetail: detail, deconDetailLoading: false });
      } catch (err) {
        if (seq !== detailReqSeq) return;
        set({ deconDetail: null, deconDetailLoading: false, deconDetailError: errorReason(err) });
      }
    },

    createDeconJob: async (input) => {
      const result = await createDeconApi(input);
      if (result.ok) {
        // 新 job 即选 + 清单重拉（向导随create 回执进预估卡，选面切到新会话）。
        set({ deconSelectedJobId: result.job.jobId, deconReportContent: null, deconReportContentKey: null });
        void get().loadDeconJobs(true);
        void get().loadDeconJobDetail(result.job.jobId, true);
      }
      return result;
    },

    startDeconJob: async (jobId, budget) => {
      const result = await startDeconApi({ jobId, ...(budget !== undefined ? { budget } : {}) });
      if (result.ok) refreshAfterJobMutation(set, get);
      return result;
    },

    pauseDeconJob: async (jobId) => {
      const result = await pauseDeconApi(jobId);
      if (result.ok) refreshAfterJobMutation(set, get);
      return result;
    },

    cancelDeconJob: async (jobId) => {
      const result = await cancelDeconApi(jobId);
      if (result.ok) refreshAfterJobMutation(set, get);
      return result;
    },

    deleteDeconJob: async (jobId) => {
      const result = await deleteDeconApi(jobId);
      if (result.ok) {
        if (get().deconSelectedJobId === jobId) get().selectDeconJob(null);
        void get().loadDeconJobs(true);
      }
      return result;
    },

    approveDeconReview: async (jobId, checkpoint) => {
      let approve: DeconApproveReviewResult;
      try {
        approve = await approveDeconReviewApi({ jobId, checkpoint });
      } catch (err) {
        return { ok: false, error: 'operation-failed', message: errorReason(err) };
      }
      // CR-3：壳 handler 是唯一 start 所有者——approve 成功即壳内自动 start + spawn 管线
      // 续跑（paused→running，台账 skip 已 done pass 零重付）。UI 零二次 start，只刷新
      // detail（job 行翻 running 的可见反馈）。note 面清场（CR-10）：「待人工确认」注记
      // 不挂在续跑后的 running 横幅下（首个 running 事件前窗口）。
      if (approve.ok) {
        const nextProgress = { ...get().deconProgress };
        delete nextProgress[jobId];
        set({ deconProgress: nextProgress });
        refreshAfterJobMutation(set, get);
      }
      return approve;
    },

    confirmRerunDecon: async (jobId) => {
      const result = await confirmRerunDeconApi({ jobId });
      if (result.ok) refreshAfterJobMutation(set, get);
      return result;
    },

    fetchDeconProducts: async (jobId, filter) => {
      set({ deconProductsLoading: true });
      try {
        const result = await fetchDeconProductsApi({
          jobId,
          ...(filter?.pass !== undefined ? { pass: filter.pass } : {}),
          ...(filter?.passStem !== undefined ? { passStem: filter.passStem } : {}),
        });
        const key = `${jobId}:${filter?.pass ?? filter?.passStem ?? '*'}`;
        set({
          deconProductsLoading: false,
          deconProducts: { ...get().deconProducts, [key]: result.products },
        });
        return result.products;
      } catch (err) {
        set({ deconProductsLoading: false });
        throw err;
      }
    },

    loadDeconReportMetas: async (jobId, force = false) => {
      if (!force && get().deconReportMetasLoadedFor === jobId) return;
      set({ deconReportsLoading: true });
      try {
        const result = await fetchDeconReportsApi({ jobId });
        set({
          deconReportMetas: result.list,
          deconReportMetasLoadedFor: jobId,
          deconReportsLoading: false,
        });
      } catch {
        // meta 失败不阻塞页面（产出 tab 空态）——静默降级（mirror craftTerms 形态）。
        set({ deconReportsLoading: false });
      }
    },

    fetchDeconReport: async (jobId, kind, unit) => {
      const key = `${kind}:${unit}`;
      set({ deconReportContentLoading: true, deconReportContentKey: key });
      try {
        const result = await fetchDeconReportsApi({ jobId, kind, unit });
        // 竞态守卫：迟 resolve 不覆写更新键（切章/切 tab 后的 stale 回包）。
        if (get().deconReportContentKey !== key) return;
        set({ deconReportContent: result.report, deconReportContentLoading: false });
      } catch (err) {
        if (get().deconReportContentKey !== key) return;
        set({ deconReportContent: null, deconReportContentLoading: false });
        // 单取失败上浮 toast 由组件 catch——slice 不引 toast 面（mirror materialsListError）。
        throw err;
      }
    },

    clearDeconReportContent: () => {
      set({ deconReportContent: null, deconReportContentKey: null, deconReportContentLoading: false });
    },

    exportDeconStyle: async (jobId, projectId) => exportDeconStyleApi({ jobId, projectId }),

    subscribeDeconEvents: () => {
      if (get().deconEventsSubscribed) return;
      const unsubscribe = subscribeDeconProgress((event) => {
        get().handleDeconProgress(event);
      });
      if (unsubscribe === null) return; // 桥缺面（旧 preload）——静默，打开 force 补偿兜底
      set({ deconEventsSubscribed: true });
    },

    handleDeconProgress: (event) => {
      // 可见性门控：页面不可见不响应（管线逐 pass/逐章广播不触发面板外重拉）。
      if ((get() as Deps).activePage !== 'decon') return;
      if (event.status === 'running') {
        // 运行态：进度图 patch（当前 pass/unit + elapsedMs——廉价内存面）。
        set({ deconProgress: { ...get().deconProgress, [event.jobId]: event } });
        return;
      }
      // 终态：进度图删条目（状态/错误面回落 job 行）+ 聚合窗重拉。带非空 note 的事件例外
      // 留存（CR-10：闸门暂停软提示——横幅消费面；running 续跑事件自然覆盖）。
      const next = { ...get().deconProgress };
      if (event.note !== undefined && event.note !== '') {
        next[event.jobId] = event;
      } else {
        delete next[event.jobId];
      }
      set({ deconProgress: next });
      burstTerminal = true;
      if (burstTimer === null) {
        burstTimer = setTimeout(fireBurst, DECON_EVENT_DEBOUNCE_MS);
      }
    },

    onDeconPageVisibility: (visible) => {
      if (visible === get().deconPageVisible) return; // 边沿触发（重复通知无动作）
      set({ deconPageVisible: visible });
      if (!visible) return; // 开→关无动作
      // 关→开补偿：事件可丢的读侧兜底——force 重拉清单 + 选中详情 + 报告 meta。
      void get().loadDeconJobs(true);
      const id = get().deconSelectedJobId;
      if (id !== null) {
        void get().loadDeconJobDetail(id, true);
        void get().loadDeconReportMetas(id, true);
      }
    },
  };
};
