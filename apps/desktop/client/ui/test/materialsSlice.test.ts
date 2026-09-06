/**
 * materialsSlice 状态机测试（Story 10.1 Wave D）。
 *
 * 覆盖：
 * - 清单装载：project 车道带 projectId / global 车道 / **无打开项目返回不动**（不拉 IPC
 *   不落假态，mirror worldStateSlice #101）；scope 切换重拉；同 scope 去重（loadedFor）。
 * - material:changed 事件刷新三件套：可见性门控（activePage !== 'materials' 零重拉）+
 *   scope/projectId 过滤（他车道/他项目事件不进当前清单）+ 150ms 聚合窗（连发合并一次）。
 * - 打开补偿：onMaterialsPageVisibility 关→开边沿 force 重拉；重复通知幂等。
 * - 批量导入：进度 {done,total} 初始化 + reason='imported' 事件递增 + resolve 后反馈
 *   （三档拒收回报入 materialsImportFeedback）+ 终局 force 重拉 + **在途互斥**（CR-025
 *   新批拒不排队）+ **终局 reconcile**（CR-010 拒收项不产事件——resolve 时 done 对齐
 *   total 诚实走满）。
 * - 删除：ok → detail 命中清空 + force 重拉；详情装载错误落 materialDetailError。
 * - 项目隔离：runProjectResets 清清单/详情/导入态。
 * - 订阅：subscribeMaterialEvents 注册成功才置旗标（半残桥可重试，mirror #12）。
 *
 * mock 形态照 spec/ui/testing.md：最小组合 store（被测 slice + currentProject +
 * activePage——事件门控读 panelsSlice 状态）+ hand-made vi.fn 挂桥（文件级单 mock）。
 * 计时口径：真实定时器（聚合窗 = MATERIALS_EVENT_DEBOUNCE_MS）——窗后断言用
 * sleepPastDebounce，beforeEach 排干上一测遗留窗口。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { MaterialSummary, MaterialsImportResult } from '@orison/shared-contracts';
import {
  createMaterialsSlice,
  MATERIALS_EVENT_DEBOUNCE_MS,
  type MaterialsSlice,
} from '../src/shared/store/materialsSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';

type TestState = MaterialsSlice & {
  currentProject: { projectId?: string; path: string } | null;
  activePage: string;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activePage: 'materials',
  ...createMaterialsSlice(...args),
}));

// ── 文件级单 mock（spec/ui/testing.md 纪律：hand-made vi.fn 挂桥，beforeEach 清计数）──

function summaryFixture(over: Partial<MaterialSummary> = {}): MaterialSummary {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    scope: 'project',
    projectId: '00001',
    kind: 'prose',
    name: 'novel',
    format: 'txt',
    medium: 'other',
    tier: 'unspecified',
    author: null,
    lang: null,
    originDate: null,
    sourcePath: 'materials/novel.txt',
    status: 'ready',
    charCount: 1000,
    chapterCount: 4,
    chapterMethod: 'regex',
    chapterConfidence: 'high',
    scanned: false,
    nonUtf8: false,
    parseNotes: [],
    ingestedAt: '2026-09-02T00:00:00.000Z',
    ...over,
  };
}

const listMaterialsSpy = vi.fn(async (): Promise<MaterialSummary[]> => [summaryFixture()]);
const getMaterialSpy = vi.fn(async () => null);
const deleteMaterialSpy = vi.fn(async () => ({ ok: true, removedSourceFile: true, removedDerivedFile: true }));
const reingestSpy = vi.fn(async () => ({ ok: true, outcome: 'reused' as const, materialId: 'mat-aaaaaaaaaaaa' }));
const importSpy = vi.fn(async (): Promise<MaterialsImportResult> => ({
  ok: true,
  imported: [{ name: 'a.txt', relPath: 'a.txt', materialId: 'mat-bbbbbbbbbbbb', outcome: 'registered' }],
  rejected: [{ name: 'b.mp4', kind: 'unsupported-format' }],
  failed: [],
}));
const patchProvenanceSpy = vi.fn(async () => ({
  ok: true,
  material: { materialId: 'mat-aaaaaaaaaaaa' },
}));
const updateNameSpy = vi.fn(async () => ({
  ok: true,
  material: { materialId: 'mat-aaaaaaaaaaaa', name: '新标题' },
}));

let materialChangedListener: ((event: { scope: string; projectId?: string | null; materialId?: string; reason: string }) => void) | null = null;

function installBridge() {
  materialChangedListener = null;
  (window as any).orisonDesktop = {
    listMaterials: listMaterialsSpy,
    getMaterial: getMaterialSpy,
    deleteMaterial: deleteMaterialSpy,
    reingestMaterial: reingestSpy,
    importMaterials: importSpy,
    updateMaterialProvenance: patchProvenanceSpy,
    updateMaterialName: updateNameSpy,
    onMaterialChanged: (cb: (event: never) => void) => {
      materialChangedListener = cb as typeof materialChangedListener;
      return () => { materialChangedListener = null; };
    },
  };
}

/** 真实定时器下等过聚合窗 + 余量（窗后断言与 beforeEach 跨测排干共用）。 */
async function sleepPastDebounce() {
  await new Promise((resolve) => setTimeout(resolve, MATERIALS_EVENT_DEBOUNCE_MS + 80));
}

function resetStore(over: Partial<TestState> = {}) {
  useTestStore.setState({
    currentProject: { projectId: '00001', path: '/proj-1' },
    activePage: 'materials',
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
    ...over,
  } as any);
}

beforeEach(async () => {
  vi.clearAllMocks();
  installBridge();
  // 排干上一测遗留聚合窗（真实定时器防跨测串扰）。
  await sleepPastDebounce();
  resetStore();
});

describe('清单装载（scope 车道 + 无项目不动）', () => {
  it('project 车道带 registry projectId 拉取并落清单', async () => {
    await useTestStore.getState().loadMaterialsList(false);
    expect(listMaterialsSpy).toHaveBeenCalledWith({ scope: 'project', projectId: '00001' });
    expect(useTestStore.getState().materialsList).toHaveLength(1);
    expect(useTestStore.getState().materialsListLoadedFor).toBe('project:00001');
  });

  it('global 车道无 projectId；scope 切换清单重拉', async () => {
    useTestStore.getState().setMaterialsScope('global');
    expect(useTestStore.getState().materialsList).toHaveLength(0);
    await sleepPastDebounce(); // setMaterialsScope 内 void 装载
    expect(listMaterialsSpy).toHaveBeenCalledWith({ scope: 'global' });
    expect(useTestStore.getState().materialsListLoadedFor).toBe('global:');
  });

  it('无打开项目（project 车道）：不拉 IPC 不落假态', async () => {
    resetStore({ currentProject: null });
    await useTestStore.getState().loadMaterialsList(false);
    expect(listMaterialsSpy).not.toHaveBeenCalled();
    expect(useTestStore.getState().materialsList).toEqual([]);
    expect(useTestStore.getState().materialsListLoading).toBe(false);
  });

  it('同 scope 非 force 去重（loadedFor 命中零重复 IPC）', async () => {
    await useTestStore.getState().loadMaterialsList(false);
    await useTestStore.getState().loadMaterialsList(false);
    expect(listMaterialsSpy).toHaveBeenCalledTimes(1);
    await useTestStore.getState().loadMaterialsList(true); // force 接管重拉
    expect(listMaterialsSpy).toHaveBeenCalledTimes(2);
  });
});

describe('material:changed 事件刷新三件套', () => {
  it('可见性门控：页面不可见零重拉', async () => {
    useTestStore.setState({ activePage: 'overview' } as any);
    useTestStore.getState().handleMaterialChanged({ scope: 'project', projectId: '00001', reason: 'reingested' });
    await sleepPastDebounce();
    expect(listMaterialsSpy).not.toHaveBeenCalled();
  });

  it('scope 过滤：他车道事件不进当前清单', async () => {
    useTestStore.getState().handleMaterialChanged({ scope: 'global', reason: 'reingested' });
    await sleepPastDebounce();
    expect(listMaterialsSpy).not.toHaveBeenCalled();
  });

  it('projectId 过滤：他项目事件不进当前清单', async () => {
    useTestStore.getState().handleMaterialChanged({ scope: 'project', projectId: '99999', reason: 'reingested' });
    await sleepPastDebounce();
    expect(listMaterialsSpy).not.toHaveBeenCalled();
  });

  it('命中事件 150ms 聚合窗合并重拉一次（连发不风暴）', async () => {
    const s = useTestStore.getState();
    s.handleMaterialChanged({ scope: 'project', projectId: '00001', reason: 'reingested' });
    s.handleMaterialChanged({ scope: 'project', projectId: '00001', materialId: 'mat-aaaaaaaaaaaa', reason: 'reingested' });
    s.handleMaterialChanged({ scope: 'project', projectId: '00001', reason: 'deleted' });
    await sleepPastDebounce();
    expect(listMaterialsSpy).toHaveBeenCalledTimes(1);
  });

  it('detail 命中 materialId 时同窗重拉详情', async () => {
    useTestStore.setState({ materialDetailId: 'mat-aaaaaaaaaaaa' } as any);
    useTestStore.getState().handleMaterialChanged({
      scope: 'project',
      projectId: '00001',
      materialId: 'mat-aaaaaaaaaaaa',
      reason: 'provenance-updated',
    });
    await sleepPastDebounce();
    expect(listMaterialsSpy).toHaveBeenCalledTimes(1);
    expect(getMaterialSpy).toHaveBeenCalledWith({ materialId: 'mat-aaaaaaaaaaaa' });
  });

  it('name-updated 事件（10.2a）走既有刷新链：命中 scope → 聚合窗后重拉清单', async () => {
    useTestStore.getState().handleMaterialChanged({
      scope: 'project',
      projectId: '00001',
      materialId: 'mat-aaaaaaaaaaaa',
      reason: 'name-updated',
    });
    await sleepPastDebounce();
    expect(listMaterialsSpy).toHaveBeenCalledTimes(1);
  });

  it('打开补偿：关→开边沿 force 重拉；重复通知幂等', async () => {
    const s = useTestStore.getState();
    s.onMaterialsPageVisibility(true); // false→true 边沿
    await sleepPastDebounce();
    expect(listMaterialsSpy).toHaveBeenCalledTimes(1);
    listMaterialsSpy.mockClear();
    s.onMaterialsPageVisibility(true); // true→true 无动作
    await sleepPastDebounce();
    expect(listMaterialsSpy).not.toHaveBeenCalled();
    s.onMaterialsPageVisibility(false); // 开→关无动作
    await sleepPastDebounce();
    expect(listMaterialsSpy).not.toHaveBeenCalled();
  });
});

describe('批量导入（进度 + 回报 + 终局重拉）', () => {
  it('进度初始化 → imported 事件递增 → resolve 后反馈入槽 + force 重拉', async () => {
    // 桥导入慢（事件先到）：捕获 import promise 手动推进。
    let resolveImport: (v: MaterialsImportResult) => void = () => {};
    importSpy.mockImplementationOnce(
      () => new Promise<MaterialsImportResult>((resolve) => { resolveImport = resolve; }),
    );
    const promise = useTestStore.getState().importMaterialFiles(['C:/a.txt', 'C:/b.txt']);
    expect(useTestStore.getState().materialsImportProgress).toEqual({ done: 0, total: 2 });

    useTestStore.getState().handleMaterialChanged({ scope: 'project', projectId: '00001', reason: 'imported' });
    expect(useTestStore.getState().materialsImportProgress).toEqual({ done: 1, total: 2 });
    useTestStore.getState().handleMaterialChanged({ scope: 'project', projectId: '00001', reason: 'imported' });
    expect(useTestStore.getState().materialsImportProgress).toEqual({ done: 2, total: 2 }); // 封顶

    resolveImport({ ok: true, imported: [], rejected: [{ name: 'b.mp4', kind: 'unsupported-format' }], failed: [] });
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(useTestStore.getState().materialsImporting).toBe(false);
    expect(useTestStore.getState().materialsImportProgress).toBeNull();
    const feedback = useTestStore.getState().materialsImportFeedback;
    expect(feedback).not.toBeNull();
    expect(feedback!.rejected).toHaveLength(1);
    await sleepPastDebounce(); // 终局 force 重拉（+ 聚合窗排干）
    expect(listMaterialsSpy).toHaveBeenCalled();
  });

  it('无打开项目（project 车道）拒导入不置进度', async () => {
    resetStore({ currentProject: null });
    const result = await useTestStore.getState().importMaterialFiles(['C:/a.txt']);
    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'invalid-input' }));
    expect(useTestStore.getState().materialsImporting).toBe(false);
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('导入互斥：在途批次新批拒（CR-025）——不排队不触 IPC', async () => {
    let resolveImport: (v: MaterialsImportResult) => void = () => {};
    importSpy.mockImplementationOnce(
      () => new Promise<MaterialsImportResult>((resolve) => { resolveImport = resolve; }),
    );
    const first = useTestStore.getState().importMaterialFiles(['C:/a.txt']);
    expect(useTestStore.getState().materialsImporting).toBe(true);
    // 在途时第二批：客户端拒（零 IPC）——进度态混批无解，V1 不排队。
    const second = await useTestStore.getState().importMaterialFiles(['C:/b.txt']);
    expect(second).toEqual(expect.objectContaining({ ok: false }));
    expect(importSpy).toHaveBeenCalledTimes(1);
    // 首批完成后互斥解除。
    resolveImport({ ok: true, imported: [], rejected: [], failed: [] });
    await first;
    expect(useTestStore.getState().materialsImporting).toBe(false);
  });

  it('终局 reconcile：拒收项不产事件——resolve 时 done 对齐 total（CR-010）', async () => {
    const seen: Array<{ done: number; total: number } | null> = [];
    const unsub = useTestStore.subscribe((s) => { seen.push(s.materialsImportProgress); });
    let resolveImport: (v: MaterialsImportResult) => void = () => {};
    importSpy.mockImplementationOnce(
      () => new Promise<MaterialsImportResult>((resolve) => { resolveImport = resolve; }),
    );
    const promise = useTestStore.getState().importMaterialFiles(['C:/a.txt', 'C:/b.txt']);
    // 全拒收（零 reason='imported' 事件）——事件计数停在 0/2。
    resolveImport({
      ok: true,
      imported: [],
      rejected: [
        { name: 'a.txt', kind: 'unsupported-format' },
        { name: 'b.txt', kind: 'missing' },
      ],
      failed: [],
    });
    await promise;
    unsub();
    // reconcile：{done:2,total:2} 在终局可见（订阅序），再按既有节律清空。
    expect(seen).toContainEqual({ done: 2, total: 2 });
    expect(useTestStore.getState().materialsImportProgress).toBeNull();
  });
});

describe('updateMaterialName（10.2a 显示名编辑——materials:update-name）', () => {
  it('调 IPC + ok 后 force 重拉详情/清单（mirror patchMaterialProvenance）', async () => {
    useTestStore.setState({ materialDetailId: 'mat-aaaaaaaaaaaa', materialDetail: {} as any } as any);
    const result = await useTestStore.getState().updateMaterialName('mat-aaaaaaaaaaaa', '新标题');
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(updateNameSpy).toHaveBeenCalledWith({ materialId: 'mat-aaaaaaaaaaaa', name: '新标题' });
    await sleepPastDebounce();
    expect(getMaterialSpy).toHaveBeenCalledWith({ materialId: 'mat-aaaaaaaaaaaa' });
    expect(listMaterialsSpy).toHaveBeenCalled();
  });

  it('失败不重拉（错误回报由表单层 toast）', async () => {
    updateNameSpy.mockImplementationOnce(async () => ({ ok: false, error: 'invalid-input' }));
    const result = await useTestStore.getState().updateMaterialName('mat-aaaaaaaaaaaa', '');
    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'invalid-input' }));
    expect(listMaterialsSpy).not.toHaveBeenCalled();
    expect(getMaterialSpy).not.toHaveBeenCalled();
  });
});

describe('删除 / 订阅 / 项目隔离', () => {
  it('删除 ok 清命中详情 + force 重拉', async () => {
    useTestStore.setState({ materialDetailId: 'mat-aaaaaaaaaaaa', materialDetail: {} as any } as any);
    await useTestStore.getState().deleteMaterialById('mat-aaaaaaaaaaaa');
    expect(deleteMaterialSpy).toHaveBeenCalledWith({ materialId: 'mat-aaaaaaaaaaaa' });
    expect(useTestStore.getState().materialDetailId).toBeNull();
    expect(listMaterialsSpy).toHaveBeenCalled();
  });

  it('subscribeMaterialEvents 注册成功置旗标；桥缺面静默不置', () => {
    useTestStore.getState().subscribeMaterialEvents();
    expect(useTestStore.getState().materialsEventsSubscribed).toBe(true);
    expect(materialChangedListener).not.toBeNull();
    // 半残桥（onMaterialChanged 抛错）→ 旗标保持 false 可重试。
    (window as any).orisonDesktop = {
      ...(window as any).orisonDesktop,
      onMaterialChanged: () => { throw new Error('half-bridged'); },
    };
    const fresh = create<TestState>()((...args) => ({
      currentProject: null,
      activePage: 'materials',
      ...createMaterialsSlice(...args),
    }));
    fresh.getState().subscribeMaterialEvents();
    expect(fresh.getState().materialsEventsSubscribed).toBe(false);
  });

  it('项目重置清清单/详情/导入态（registerProjectReset 自注册）', () => {
    useTestStore.setState({
      materialsList: [summaryFixture()],
      materialsListLoadedFor: 'project:00001',
      materialDetailId: 'mat-aaaaaaaaaaaa',
      materialsImportFeedback: { ok: true, imported: [], rejected: [], failed: [] },
    } as any);
    runProjectResets();
    const s = useTestStore.getState();
    expect(s.materialsList).toEqual([]);
    expect(s.materialsListLoadedFor).toBeNull();
    expect(s.materialDetailId).toBeNull();
    expect(s.materialsImportFeedback).toBeNull();
  });
});
