/**
 * 「材料」页 slice（Story 10.1 Wave D，design §5.2）。
 *
 * 数据面：材料清单（scope 车道键控）+ 全行详情（provenance 表单数据源）+ 批量导入进度/
 * 回报。IPC 全经 shared/api/materials（module-structure invariant）。
 *
 * 事件刷新三件套（spec/ui/state-management，mirror worldStateSlice 全套）：
 * 1. **可见性门控**：material:changed 事件入口先查 `activePage === 'materials'`（经 merged
 *    store get()，不绑组件 state），页面不可见即丢——批量导入逐份广播不炸 IPC 面板。
 * 2. **debounce 聚合窗**：事件进固定 150ms 窗（首条开窗、窗内并入不重置），到期按并集
 *    判定重拉（当前 scope 命中即拉；detail 命中 materialId 同步重拉）。
 * 3. **打开 force 补偿**：onMaterialsPageVisibility 只在关→开边沿 force 重拉——事件可丢
 *    （best-effort 契约）的读侧兜底；App.tsx 按 activePage 接线通知。
 *
 * 事件过滤：scope 匹配当前车道；project 车道事件带 projectId 时须与当前项目一致（多窗/
 * 后台写入不进当前视图，mirror worldStateSlice projectId 过滤）。
 *
 * 导入进度：importMaterialFiles 置 importing + {done, total}；期间 reason='imported' 且
 * scope 命中的 material:changed 事件递增 done（广播逐份发，进度可见——AC7）；事件可丢时
 * 进度跳变到最终结果（诚实，不假装逐份精确）。**终局 reconcile（CR-010）**：拒收/失败项
 * 不产 imported 事件——事件计数永不走满，resolve 时 done 对齐 total（诚实走满）再按既有
 * 节律清空。**导入互斥（CR-025）**：在途批次未完成时新批直接拒（V1 不排队——进度态混批
 * 无解，最小级拒收）。resolve 后 force 重拉清单兜底。
 *
 * 项目隔离（state-management spec）：清单/详情/导入态均 project-scoped 数据，切项目一律
 * 清（registerProjectReset 自注册）。materialsScope 是车道选择器（跨项目存续，同
 * activeSidebarPanel 语义——切项目后 project 车道自动重拉新项目清单）。
 */
import type { StateCreator } from 'zustand';
import type {
  MaterialChangedEvent,
  MaterialDetail,
  MaterialSummary,
  MaterialsImportResult,
  MaterialProvenancePatchInput,
  MaterialProvenancePatchResult,
  MaterialUpdateNameResult,
} from '@orison/shared-contracts';
import { registerProjectReset } from './resetRegistry';
import {
  deleteMaterial,
  getMaterialDetail,
  importMaterials,
  listMaterials,
  reingestMaterial,
  updateMaterialName as updateMaterialNameApi,
  updateMaterialProvenance,
} from '../api/materials';

type MaterialScope = 'project' | 'global';

/** material:changed 增量事件聚合窗时长（导出供测试对表，勿内联字面量）。 */
export const MATERIALS_EVENT_DEBOUNCE_MS = 150;

/** 最近一次导入成功回报（反馈区呈现——三档拒收分类 + failed）。 */
export type MaterialsImportFeedback = Extract<MaterialsImportResult, { ok: true }>;

export type MaterialsSlice = {
  /** 车道选择器（本项目 ↔ 全局库；project 车道无打开项目时页面呈现禁用态）。 */
  materialsScope: MaterialScope;
  /** 清单已装载的 scope 键（`${scope}:${projectId ?? ''}`）——非 force 去重 + 切换判定。 */
  materialsListLoadedFor: string | null;
  materialsList: MaterialSummary[];
  materialsListLoading: boolean;
  materialsListError: string | null;

  /** 全行详情（provenance 表单数据源；materialId 键控竞态守卫）。 */
  materialDetail: MaterialDetail | null;
  materialDetailId: string | null;
  materialDetailLoading: boolean;
  materialDetailError: string | null;

  materialsImporting: boolean;
  materialsImportProgress: { done: number; total: number } | null;
  /** 最近一次导入成功回报（失败走 toast，不占此槽）；null = 无（页面初装/新一轮开始）。 */
  materialsImportFeedback: MaterialsImportFeedback | null;

  /** 事件订阅已挂（App 引导期一次；桥缺失时保持 false 不重试报错）。 */
  materialsEventsSubscribed: boolean;
  /** 页面可见性（App 按 activePage 接线；关→开边沿 force 补偿的边沿检测用）。 */
  materialsPageVisible: boolean;

  setMaterialsScope: (scope: MaterialScope) => void;
  /** 清单装载（force = 事件/补偿/手动刷新；在途去重 + seq 作废）。 */
  loadMaterialsList: (force?: boolean) => Promise<void>;
  /** 全行详情装载（provenance 表单打开时；force 同上）。 */
  loadMaterialDetail: (materialId: string, force?: boolean) => Promise<void>;
  /** 关闭详情（表单收起）。 */
  clearMaterialDetail: () => void;
  /** 批量导入（进度可见；resolve 返回三档回报供组件呈现；失败 throw 由组件 toast）。
   * 在途互斥（CR-025）+ 终局 reconcile（CR-010）见方法体注。 */
  importMaterialFiles: (absolutePaths: string[]) => Promise<MaterialsImportResult>;
  deleteMaterialById: (materialId: string) => Promise<import('@orison/shared-contracts').MaterialDeleteResult>;
  reingestMaterialById: (materialId: string) => Promise<import('@orison/shared-contracts').MaterialReingestResult>;
  patchMaterialProvenance: (
    materialId: string,
    patch: MaterialProvenancePatchInput['patch'],
  ) => Promise<MaterialProvenancePatchResult>;
  /**
   * 材料显示名编辑（E10.2a，design §3.1——name 列，materialId 路径身份不变）。成功后
   * force 重拉详情 + 清单（mirror patchMaterialProvenance；shell 侧另有 material:changed
   * reason='name-updated' 广播走既有事件面刷新列表——belt 双保险，事件可丢时直拉兜底）。
   */
  updateMaterialName: (materialId: string, name: string) => Promise<MaterialUpdateNameResult>;
  /** App 引导期挂 material:changed 订阅（mirror subscribeWorldEvents）。 */
  subscribeMaterialEvents: () => void;
  /** 事件处理（订阅回调入口；独立暴露供测试直调）。 */
  handleMaterialChanged: (event: MaterialChangedEvent) => void;
  /** 页面可见性通知（App 按 activePage 变化调；关→开边沿 force 重拉）。 */
  onMaterialsPageVisibility: (visible: boolean) => void;
};

type Deps = MaterialsSlice & {
  currentProject: { projectId?: string; path: string } | null;
  /** panelsSlice 状态（事件可见性门控单源；最小组合测试 store 须随附本字段）。 */
  activePage: string;
};

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const createMaterialsSlice: StateCreator<Deps, [], [], MaterialsSlice> = (set, get) => {
  // 清单装载 seq（作废在途 stale resolve，mirror worldStateSlice overviewReqSeq）。
  let listReqSeq = 0;
  let listInFlightKey: string | null = null;
  let detailReqSeq = 0;

  // material:changed 聚合窗（固定窗：首条开窗、窗内并入不重置——批量导入连发不饿死）。
  let burstTimer: ReturnType<typeof setTimeout> | null = null;
  let burstHitScope = false;
  let burstDetailIds = new Set<string>();

  const cancelBurst = () => {
    if (burstTimer !== null) {
      clearTimeout(burstTimer);
      burstTimer = null;
    }
    burstHitScope = false;
    burstDetailIds = new Set();
  };

  const fireBurst = () => {
    burstTimer = null;
    const hitScope = burstHitScope;
    const detailIds = burstDetailIds;
    burstHitScope = false;
    burstDetailIds = new Set();
    if (!hitScope) return;
    // 窗口期内页面可能已切走——执行时二次门控（重新打开由 visibility force 补偿兜底）。
    if ((get() as Deps).activePage !== 'materials') return;
    void get().loadMaterialsList(true);
    const s = get();
    if (s.materialDetailId !== null && detailIds.has(s.materialDetailId)) {
      void get().loadMaterialDetail(s.materialDetailId, true);
    }
  };

  registerProjectReset(() => {
    cancelBurst();
    listReqSeq += 1; // 作废在途（项目已切）
    listInFlightKey = null;
    detailReqSeq += 1;
    set({
      materialsListLoadedFor: null,
      materialsList: [],
      materialsListLoading: false,
      materialsListError: null,
      materialDetail: null,
      materialDetailId: null,
      materialDetailLoading: false,
      materialDetailError: null,
      materialsImporting: false,
      materialsImportProgress: null,
      materialsImportFeedback: null,
    });
  });

  return {
    materialsScope: 'project',
    materialsListLoadedFor: null,
    materialsList: [],
    materialsListLoading: false,
    materialsListError: null,
    materialDetail: null,
    materialDetailId: null,
    materialDetailLoading: false,
    materialDetailError: null,
    materialsImporting: false,
    materialsImportProgress: null,
    materialsImportFeedback: null,
    materialsEventsSubscribed: false,
    materialsPageVisible: false,

    setMaterialsScope: (scope) => {
      if (get().materialsScope === scope) return;
      set({ materialsScope: scope, materialsListLoadedFor: null, materialsList: [], materialsListError: null });
      void get().loadMaterialsList(false);
    },

    loadMaterialsList: async (force = false) => {
      const scope = get().materialsScope;
      const projectId = (get() as Deps).currentProject?.projectId ?? null;
      if (scope === 'project' && !projectId) {
        // 无打开项目：project 车道无清单可拉（页面呈现禁用态，不拉 IPC 不染假态）。
        listReqSeq += 1;
        listInFlightKey = null;
        set({ materialsList: [], materialsListLoading: false, materialsListError: null, materialsListLoadedFor: null });
        return;
      }
      const key = scope === 'project' ? `project:${projectId ?? ''}` : 'global:';
      if (!force && get().materialsListLoadedFor === key) return;
      if (!force && listInFlightKey === key) return;
      const seq = ++listReqSeq;
      listInFlightKey = key;
      set({ materialsListLoading: true, materialsListError: null });
      try {
        // projectId 只随 project 车道（global 车道不携带——契约形参 optional 语义）。
        const rows = await listMaterials({ scope, ...(scope === 'project' && projectId !== null ? { projectId } : {}) });
        if (seq !== listReqSeq) return; // 作废（scope 切换/项目切换/新请求接管）
        set({ materialsList: rows, materialsListLoading: false, materialsListLoadedFor: key });
      } catch (err) {
        if (seq !== listReqSeq) return;
        set({ materialsListLoading: false, materialsListError: errorReason(err) });
      } finally {
        if (listInFlightKey === key) listInFlightKey = null;
      }
    },

    loadMaterialDetail: async (materialId, force = false) => {
      const s = get();
      if (!force && s.materialDetailId === materialId && s.materialDetail !== null) return;
      const seq = ++detailReqSeq;
      set({ materialDetailLoading: true, materialDetailId: materialId, materialDetailError: null });
      try {
        const detail = await getMaterialDetail(materialId);
        if (seq !== detailReqSeq) return;
        set({ materialDetail: detail, materialDetailLoading: false });
      } catch (err) {
        if (seq !== detailReqSeq) return;
        // 错误落 state 由表单区呈现（mirror materialsListError——slice 不引 toast 面）。
        set({ materialDetail: null, materialDetailLoading: false, materialDetailError: errorReason(err) });
      }
    },

    clearMaterialDetail: () => {
      detailReqSeq += 1;
      set({ materialDetail: null, materialDetailId: null, materialDetailLoading: false, materialDetailError: null });
    },

    importMaterialFiles: async (absolutePaths) => {
      const scope = get().materialsScope;
      const projectId = (get() as Deps).currentProject?.projectId ?? null;
      if (scope === 'project' && !projectId) {
        return { ok: false, error: 'invalid-input', message: '无打开项目（project 车道不可导入）' };
      }
      if (absolutePaths.length === 0) {
        return { ok: false, error: 'invalid-input', message: '空导入列表' };
      }
      // 导入互斥（CR-025）：在途批次未完成时新批直接拒（客户端守卫不触 IPC）——V1 不排队，
      // 两批并发会让 {done,total} 与逐份事件计数混批失真。
      if (get().materialsImporting) {
        return { ok: false, error: 'invalid-input', message: '导入进行中——请等当前批次完成再导入' };
      }
      const total = absolutePaths.length;
      set({ materialsImporting: true, materialsImportProgress: { done: 0, total } });
      try {
        const result = await importMaterials({
          scope,
          ...(scope === 'project' && projectId !== null ? { projectId } : {}),
          absolutePaths,
        });
        // 终局 reconcile（CR-010）：拒收/失败项不产 reason='imported' 事件——事件计数永不
        // 走满；resolve 时 done 对齐 total（诚实走满）再按既有节律清空 + 反馈入槽。
        set({ materialsImportProgress: { done: total, total } });
        set({
          materialsImporting: false,
          materialsImportProgress: null,
          ...(result.ok ? { materialsImportFeedback: result } : {}),
        });
        // 终局 force 重拉（事件 best-effort 可丢——读侧兜底同 trio 哲学）。
        void get().loadMaterialsList(true);
        return result;
      } catch (err) {
        set({ materialsImportProgress: { done: total, total } });
        set({ materialsImporting: false, materialsImportProgress: null });
        throw err;
      }
    },

    deleteMaterialById: async (materialId) => {
      const result = await deleteMaterial(materialId);
      if (result.ok && get().materialDetailId === materialId) {
        get().clearMaterialDetail();
      }
      void get().loadMaterialsList(true);
      return result;
    },

    reingestMaterialById: async (materialId) => {
      const result = await reingestMaterial(materialId);
      void get().loadMaterialsList(true);
      return result;
    },

    patchMaterialProvenance: async (materialId, patch) => {
      const result = await updateMaterialProvenance({ materialId, patch });
      if (result.ok) {
        void get().loadMaterialDetail(materialId, true);
        void get().loadMaterialsList(true);
      }
      return result;
    },

    updateMaterialName: async (materialId, name) => {
      const result = await updateMaterialNameApi({ materialId, name });
      if (result.ok) {
        void get().loadMaterialDetail(materialId, true);
        void get().loadMaterialsList(true);
      }
      return result;
    },

    subscribeMaterialEvents: () => {
      if (get().materialsEventsSubscribed) return;
      const bridge = window.orisonDesktop;
      if (!bridge?.onMaterialChanged) return; // 桥缺面（旧 preload）——静默，打开 force 补偿兜底
      try {
        bridge.onMaterialChanged((event) => {
          get().handleMaterialChanged(event);
        });
        set({ materialsEventsSubscribed: true });
      } catch {
        // 吞错不炸 App 引导 effect（半残桥可重试，mirror subscribeWorldEvents #12）。
      }
    },

    handleMaterialChanged: (event) => {
      // 可见性门控：页面不可见不响应（导入/删除/重摄取的逐份广播不触发面板外重拉）。
      if ((get() as Deps).activePage !== 'materials') return;
      // scope 过滤（project 车道事件另带 projectId 时须与当前项目一致）。
      const s = get();
      if (event.scope !== s.materialsScope) return;
      if (
        event.scope === 'project' &&
        event.projectId != null &&
        event.projectId !== (get() as Deps).currentProject?.projectId
      ) {
        return;
      }
      // 导入进度（reason='imported' 逐份递增——事件可丢时进度跳变到终局，诚实）。
      if (event.reason === 'imported' && s.materialsImportProgress !== null) {
        const { done, total } = s.materialsImportProgress;
        set({ materialsImportProgress: { done: Math.min(done + 1, total), total } });
      }
      // 聚合窗并入（并集判定：scope 命中或 detail materialId 命中）。
      burstHitScope = true;
      if (event.materialId !== undefined && s.materialDetailId === event.materialId) {
        burstDetailIds.add(event.materialId);
      }
      if (burstTimer === null) {
        burstTimer = setTimeout(fireBurst, MATERIALS_EVENT_DEBOUNCE_MS);
      }
    },

    onMaterialsPageVisibility: (visible) => {
      if (visible === get().materialsPageVisible) return; // 边沿触发（重复通知无动作）
      set({ materialsPageVisible: visible });
      if (!visible) return; // 开→关无动作
      // 关→开补偿：事件可丢的读侧兜底——force 重拉清单（+ 在开详情）。
      void get().loadMaterialsList(true);
      const id = get().materialDetailId;
      if (id !== null) void get().loadMaterialDetail(id, true);
    },
  };
};
