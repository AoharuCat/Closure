/**
 * deconSlice 状态机测试（E10.3b W6）。
 *
 * 覆盖：
 * - 装载去重（loaded 旗——非 force 二连零 IPC）+ 竞态作废（迟 resolve 丢弃）；
 * - decon:progress 事件三件套（spec/ui/state-management）：
 *   · 可见性门控（activePage !== 'decon' 零响应——进度图不更新不开窗）；
 *   · 运行态事件 → 进度图 patch（零重拉——当前相位/耗时徽章源）；
 *   · 终态事件 → 进度图删条目 + 150ms 聚合窗后 force 重拉（清单 + 选中详情 + 报告 meta）；
 *     窗内连发合并一次；窗口期内切走页面二次门控丢弃；
 *   · 关→开 force 补偿（onDeconPageVisibility 边沿触发 + 重复通知幂等）；
 * - selectDeconJob 联动（详情 + 报告 meta 拉取；null 清场）；
 * - createDeconJob 成功 → 选中新 job + 清单/详情重拉；失败原样上抛 result；
 * - approveDeconReview：approve ok → 壳内自动续跑（**UI 零二次 start——CR-3 壳 handler 唯一
 *   start 所有者**）+ detail 刷新；approve 失败短路；
 * - deleteDeconJob 成功 → 清选中 + 清单重拉；
 * - fetchDeconProducts 过滤面（pass 精确 / passStem 前缀——CR-8）缓存键控 + job 变更后缓存
 *   清空（CR-9——confirm-rerun 路径）；
 * - 终态事件带 note → 进度图留存（CR-10 横幅软提示消费面）。
 *
 * mock 形态照 spec/ui/testing.md：最小组合 store（被测 slice + activePage）+ hand-made
 * vi.fn 挂桥（文件级单 mock）。真实定时器（窗后断言用 sleepPastDebounce，beforeEach 排干
 * 上一测遗留窗口）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type {
  DeconCreateInput,
  DeconJob,
  DeconJobDetail,
} from '@orison/shared-contracts';
import {
  createDeconSlice,
  DECON_EVENT_DEBOUNCE_MS,
  type DeconSlice,
} from '../src/shared/store/deconSlice';

type TestState = DeconSlice & {
  activePage: string;
};

const useTestStore = create<TestState>()((...args) => ({
  activePage: 'decon',
  ...createDeconSlice(...args),
}));

// ── 文件级单 mock（spec/ui/testing.md 纪律：hand-made vi.fn 挂桥，beforeEach 清计数）──

function jobFixture(over: Partial<DeconJob> = {}): DeconJob {
  return {
    jobId: 'decon-aaaaaaaaaaaa',
    materialRef: 'global:mat-aaaaaaaaaaaa',
    tier: 'fine',
    dimensions: ['qingxu'],
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

function detailFixture(over: Partial<DeconJobDetail> = {}): DeconJobDetail {
  return {
    job: jobFixture(),
    passStates: [],
    fresh: true,
    canon: [],
    dictionary: null,
    entities: [],
    reviews: [],
    reportCounts: {},
    ...over,
  };
}

const listJobsSpy = vi.fn(async (): Promise<DeconJob[]> => [jobFixture()]);
const getJobSpy = vi.fn(async (): Promise<DeconJobDetail | null> => detailFixture());
const createSpy = vi.fn(async (_input: DeconCreateInput) => ({
  ok: true as const,
  job: jobFixture({ jobId: 'decon-cccccccccccc', status: 'paused' }),
  inheritedP1: { p1a: false, p1b: false, p1c: false },
  estimate: { totalTokens: 12345, byPass: { p1a: 100 } },
}));
const startSpy = vi.fn(async () => ({
  ok: true as const,
  job: jobFixture({ status: 'running' }),
  noop: false,
}));
const pauseSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'paused' }) }));
const cancelSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'cancelled' }) }));
const deleteSpy = vi.fn(async () => ({ ok: true as const }));
const approveReviewSpy = vi.fn(async () => ({
  ok: true as const,
  review: {
    jobId: 'decon-aaaaaaaaaaaa',
    checkpoint: 'dictionary' as const,
    status: 'approved' as const,
    note: null,
    updatedAt: '2026-09-05T00:00:00.000Z',
  },
}));
// E10.3b W7 小补③：stale 确认重跑（shell 侧 confirm+start 一体——单次 invoke）。
const confirmRerunSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'running' }) }));
const productsSpy = vi.fn(async () => ({ fresh: true, products: [] }));
const reportsSpy = vi.fn(async () => ({ fresh: true, list: [], report: null }));
const exportStyleSpy = vi.fn(async () => ({ ok: true as const, writtenSections: ['voice'] }));
let progressCallback: ((event: unknown) => void) | null = null;

function installBridge() {
  (window as any).orisonDesktop = {
    deconList: listJobsSpy,
    deconGet: getJobSpy,
    deconCreate: createSpy,
    deconStart: startSpy,
    deconPause: pauseSpy,
    deconCancel: cancelSpy,
    deconDelete: deleteSpy,
    deconApproveReview: approveReviewSpy,
    deconConfirmRerun: confirmRerunSpy,
    deconProducts: productsSpy,
    deconReports: reportsSpy,
    deconExportStyle: exportStyleSpy,
    onDeconProgress: (callback: (event: unknown) => void) => {
      progressCallback = callback;
      return () => { progressCallback = null; };
    },
  };
}

function sleepPastDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, DECON_EVENT_DEBOUNCE_MS + 30));
}

/** 直调事件入口（不经订阅——订阅链由 subscribeDeconEvents 覆盖测试）。 */
function emitProgress(event: Record<string, unknown>): void {
  useTestStore.getState().handleDeconProgress(event as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  progressCallback = null;
  useTestStore.setState({
    activePage: 'decon',
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
  } as any);
});

describe('装载', () => {
  it('loaded 旗去重——非 force 二连零 IPC', async () => {
    await useTestStore.getState().loadDeconJobs(false);
    await useTestStore.getState().loadDeconJobs(false);
    expect(listJobsSpy).toHaveBeenCalledTimes(1);
    // force 强拉。
    await useTestStore.getState().loadDeconJobs(true);
    expect(listJobsSpy).toHaveBeenCalledTimes(2);
  });

  it('竞态作废：在途装载中再发 force，迟 resolve 丢弃', async () => {
    let resolveFirst: (v: DeconJob[]) => void = () => {};
    listJobsSpy.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    const first = useTestStore.getState().loadDeconJobs(true);
    const second = useTestStore.getState().loadDeconJobs(true);
    await second;
    resolveFirst([jobFixture({ jobId: 'decon-deadbeefdead' })]);
    await first;
    expect(useTestStore.getState().deconJobs.map((j) => j.jobId)).toEqual(['decon-aaaaaaaaaaaa']);
  });

  it('selectDeconJob 联动详情 + 报告 meta；null 清场', async () => {
    useTestStore.getState().selectDeconJob('decon-aaaaaaaaaaaa');
    await vi.waitFor(() => {
      expect(useTestStore.getState().deconDetail).not.toBeNull();
    });
    expect(getJobSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    expect(reportsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    useTestStore.getState().selectDeconJob(null);
    expect(useTestStore.getState().deconDetail).toBeNull();
    expect(useTestStore.getState().deconSelectedJobId).toBeNull();
  });
});

describe('decon:progress 事件三件套', () => {
  it('可见性门控：activePage 非 decon 零响应', async () => {
    useTestStore.setState({ activePage: 'craft' } as any);
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p1b', unit: '3', elapsedMs: 5000 });
    expect(useTestStore.getState().deconProgress).toEqual({});
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'done', pass: null });
    await sleepPastDebounce();
    expect(listJobsSpy).not.toHaveBeenCalled();
  });

  it('运行态事件 → 进度图 patch（零重拉）', async () => {
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p3a', unit: '12', elapsedMs: 62000 });
    expect(useTestStore.getState().deconProgress['decon-aaaaaaaaaaaa']).toMatchObject({ pass: 'p3a', unit: '12' });
    await sleepPastDebounce();
    expect(listJobsSpy).not.toHaveBeenCalled();
    expect(getJobSpy).not.toHaveBeenCalled();
  });

  it('终态事件 → 进度图删条目 + 150ms 聚合窗重拉（选中面三连：清单/详情/meta）', async () => {
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p1b', unit: '3' });
    useTestStore.setState({
      deconSelectedJobId: 'decon-aaaaaaaaaaaa',
      deconReportMetasLoadedFor: 'decon-aaaaaaaaaaaa',
      deconJobsLoaded: true,
    } as any);
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'paused', pass: null });
    expect(useTestStore.getState().deconProgress['decon-aaaaaaaaaaaa']).toBeUndefined();
    // 窗内连发（capped + failed 两事件）合并一次。
    emitProgress({ jobId: 'decon-bbbbbbbbbbbb', status: 'done', pass: null });
    await sleepPastDebounce();
    expect(listJobsSpy).toHaveBeenCalledTimes(1);
    expect(getJobSpy).toHaveBeenCalledTimes(1);
    expect(reportsSpy).toHaveBeenCalledTimes(1);
  });

  it('终态事件带 note → 进度图留存（CR-10 横幅软提示消费面）；续跑 running 覆盖；无 note 照删', async () => {
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'paused', pass: null, note: '待人工确认：词典与实体（P1c 产物）' });
    expect(useTestStore.getState().deconProgress['decon-aaaaaaaaaaaa']).toMatchObject({
      status: 'paused',
      note: '待人工确认：词典与实体（P1c 产物）',
    });
    // 续跑 running 事件自然覆盖（note 面随之消失）。
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p2', unit: 'world', elapsedMs: 1000 });
    expect(useTestStore.getState().deconProgress['decon-aaaaaaaaaaaa']).toMatchObject({ pass: 'p2' });
    expect(useTestStore.getState().deconProgress['decon-aaaaaaaaaaaa']?.note).toBeUndefined();
    // 无 note 终态照删（既有不变量——状态/错误面回落 job 行）。
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'done', pass: null });
    expect(useTestStore.getState().deconProgress['decon-aaaaaaaaaaaa']).toBeUndefined();
    await sleepPastDebounce(); // 聚合窗排干（防泄漏到下一测）
  });

  it('窗口期内切走页面——二次门控丢弃本窗', async () => {
    useTestStore.setState({ deconJobsLoaded: true } as any);
    emitProgress({ jobId: 'decon-aaaaaaaaaaaa', status: 'done', pass: null });
    useTestStore.setState({ activePage: 'overview' } as any);
    await sleepPastDebounce();
    expect(listJobsSpy).not.toHaveBeenCalled();
  });

  it('关→开 force 补偿（边沿触发 + 重复通知幂等 + 开→关无动作）', async () => {
    const onVisibility = useTestStore.getState().onDeconPageVisibility;
    await useTestStore.getState().loadDeconJobs(false); // 装载归位（后续 force 计数从此起算）
    useTestStore.setState({ deconJobsLoaded: true, deconSelectedJobId: null } as any);
    listJobsSpy.mockClear();
    getJobSpy.mockClear();
    onVisibility(true);
    onVisibility(true); // 重复通知幂等
    await vi.waitFor(() => {
      expect(listJobsSpy).toHaveBeenCalledTimes(1);
    });
    onVisibility(false);
    onVisibility(false);
    expect(listJobsSpy).toHaveBeenCalledTimes(1);
  });

  it('subscribeDeconEvents：成功置旗标 + 桥缺面静默可重试', async () => {
    useTestStore.getState().subscribeDeconEvents();
    expect(useTestStore.getState().deconEventsSubscribed).toBe(true);
    expect(progressCallback).not.toBeNull();
    // 重复订阅 no-op。
    useTestStore.getState().subscribeDeconEvents();
    // 桥缺面（旧 preload）。
    (window as any).orisonDesktop = {};
    useTestStore.setState({ deconEventsSubscribed: false } as any);
    useTestStore.getState().subscribeDeconEvents();
    expect(useTestStore.getState().deconEventsSubscribed).toBe(false);
  });
});

describe('变更面 thunk', () => {
  it('createDeconJob 成功 → 选中新 job + 清单/详情重拉', async () => {
    const result = await useTestStore.getState().createDeconJob({
      materialId: 'mat-aaaaaaaaaaaa',
      tier: 'fine',
      dimensions: ['qingxu'],
    });
    expect(result.ok).toBe(true);
    expect(useTestStore.getState().deconSelectedJobId).toBe('decon-cccccccccccc');
    await vi.waitFor(() => {
      expect(getJobSpy).toHaveBeenCalledWith({ jobId: 'decon-cccccccccccc' });
    });
    expect(listJobsSpy).toHaveBeenCalled();
  });

  it('approveDeconReview：approve ok → detail 刷新 + 零二次 start（CR-3——壳 handler 唯一 start 所有者，approve 即壳内自动续跑）+ note 面清场（CR-10）', async () => {
    useTestStore.setState({
      deconJobsLoaded: true,
      deconSelectedJobId: 'decon-aaaaaaaaaaaa',
      deconProgress: {
        'decon-aaaaaaaaaaaa': { jobId: 'decon-aaaaaaaaaaaa', status: 'paused', pass: null, note: '待人工确认' },
      },
    } as any);
    getJobSpy.mockClear();
    const result = await useTestStore.getState().approveDeconReview('decon-aaaaaaaaaaaa', 'dictionary');
    expect(approveReviewSpy).toHaveBeenCalledWith({
      jobId: 'decon-aaaaaaaaaaaa',
      checkpoint: 'dictionary',
    });
    expect(startSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(useTestStore.getState().deconProgress['decon-aaaaaaaaaaaa']).toBeUndefined();
    await vi.waitFor(() => {
      expect(getJobSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    });
  });

  it('approveDeconReview approve 失败短路（不 start）', async () => {
    approveReviewSpy.mockResolvedValueOnce({
      ok: false as const,
      error: 'invalid-state',
      message: '闸门行非 pending',
    });
    const result = await useTestStore.getState().approveDeconReview('decon-aaaaaaaaaaaa', 'canon');
    expect(result).toMatchObject({ ok: false, error: 'invalid-state' });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('confirmRerunDecon（W7 小补③）：stale 确认重跑单 invoke（shell 侧一体续跑）+ 成功刷新清单', async () => {
    useTestStore.setState({ deconJobsLoaded: true } as any);
    const result = await useTestStore.getState().confirmRerunDecon('decon-aaaaaaaaaaaa');
    expect(confirmRerunSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(listJobsSpy).toHaveBeenCalled();
    });
  });

  it('confirmRerunDecon 失败原样上浮（不刷清单）', async () => {
    confirmRerunSpy.mockResolvedValueOnce({
      ok: false as const,
      error: 'material-not-found',
      message: '材料已不存在',
    });
    useTestStore.setState({ deconJobsLoaded: true } as any);
    const result = await useTestStore.getState().confirmRerunDecon('decon-aaaaaaaaaaaa');
    expect(result).toMatchObject({ ok: false, error: 'material-not-found' });
    expect(listJobsSpy).not.toHaveBeenCalled();
  });

  it('deleteDeconJob 成功 → 清选中 + 清单重拉', async () => {
    useTestStore.setState({
      deconSelectedJobId: 'decon-aaaaaaaaaaaa',
      deconDetail: detailFixture(),
      deconJobsLoaded: true,
    } as any);
    const result = await useTestStore.getState().deleteDeconJob('decon-aaaaaaaaaaaa');
    expect(result.ok).toBe(true);
    expect(useTestStore.getState().deconSelectedJobId).toBeNull();
    expect(useTestStore.getState().deconDetail).toBeNull();
    expect(listJobsSpy).toHaveBeenCalled();
  });

  it('startDeconJob 携带 budget（capped 续跑调预算面）', async () => {
    await useTestStore.getState().startDeconJob('decon-aaaaaaaaaaaa', { totalTokens: 999999 });
    expect(startSpy).toHaveBeenCalledWith({
      jobId: 'decon-aaaaaaaaaaaa',
      budget: { totalTokens: 999999 },
    });
  });
});

describe('product/report 读面', () => {
  it('fetchDeconProducts 过滤面缓存键控（缺省 "*" / passStem 前缀「p4」 / pass 精确——CR-8）', async () => {
    productsSpy.mockResolvedValueOnce({
      fresh: true,
      products: [
        { jobId: 'decon-aaaaaaaaaaaa', pass: 'p4:qingxu', unit: 'ch:1', payload: {}, updatedAt: '2026-09-05T00:00:00.000Z' },
      ],
    });
    const rows = await useTestStore.getState().fetchDeconProducts('decon-aaaaaaaaaaaa');
    expect(productsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    expect(rows.length).toBe(1);
    expect(useTestStore.getState().deconProducts['decon-aaaaaaaaaaaa:*'].length).toBe(1);

    // passStem 前缀（craft 闸门卡——通道侧 p4:<dim> 全匹配，含 p4:style）。
    await useTestStore.getState().fetchDeconProducts('decon-aaaaaaaaaaaa', { passStem: 'p4' });
    expect(productsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', passStem: 'p4' });
    expect(useTestStore.getState().deconProducts['decon-aaaaaaaaaaaa:p4']).toEqual([]);

    // pass 全值精确（风格导出面）。
    await useTestStore.getState().fetchDeconProducts('decon-aaaaaaaaaaaa', { pass: 'p4:style' });
    expect(productsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', pass: 'p4:style' });
    expect(useTestStore.getState().deconProducts['decon-aaaaaaaaaaaa:p4:style']).toEqual([]);
  });

  it('job 变更后 products 缓存清空（CR-9——confirm-rerun 旧指纹 findings 不滞留闸门卡）', async () => {
    useTestStore.setState({
      deconSelectedJobId: 'decon-aaaaaaaaaaaa',
      deconJobsLoaded: true,
      deconProducts: {
        'decon-aaaaaaaaaaaa:p4': [
          { jobId: 'decon-aaaaaaaaaaaa', pass: 'p4:qingxu', unit: 'ch:1', payload: {}, updatedAt: '2026-09-05T00:00:00.000Z' },
        ],
        'decon-aaaaaaaaaaaa:*': [],
      },
    } as any);
    await useTestStore.getState().confirmRerunDecon('decon-aaaaaaaaaaaa');
    expect(useTestStore.getState().deconProducts).toEqual({});
  });

  it('fetchDeconReport 单取全文（kind:unit 键控 + 迟回包竞态守卫）', async () => {
    const report = {
      jobId: 'decon-aaaaaaaaaaaa',
      kind: 'chapter_review' as const,
      unit: 'ch:3',
      contentMd: '# 章评',
      anchors: [],
      dimension: null,
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    reportsSpy.mockResolvedValueOnce({ fresh: true, list: [], report });
    await useTestStore.getState().fetchDeconReport('decon-aaaaaaaaaaaa', 'chapter_review', 'ch:3');
    expect(reportsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', kind: 'chapter_review', unit: 'ch:3' });
    expect(useTestStore.getState().deconReportContent).toEqual(report);
    expect(useTestStore.getState().deconReportContentKey).toBe('chapter_review:ch:3');

    // 迟回包竞态：键已切走（clearDeconReportContent）→ 回包不落。
    let resolveLate: (v: unknown) => void = () => {};
    reportsSpy.mockImplementationOnce(() => new Promise((r) => { resolveLate = r; }));
    const pending = useTestStore.getState().fetchDeconReport('decon-aaaaaaaaaaaa', 'chapter_review', 'ch:4');
    useTestStore.getState().clearDeconReportContent();
    resolveLate({ fresh: true, list: [], report: { ...report, unit: 'ch:4' } });
    await pending;
    expect(useTestStore.getState().deconReportContent).toBeNull();
  });
});
