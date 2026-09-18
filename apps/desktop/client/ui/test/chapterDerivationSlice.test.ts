/**
 * 09-13 子3 W6（design §6.3）：章卡衍生状态 slice 测试。
 *
 * 覆盖（spec/ui/testing 最小组合 store + mock window.orisonDesktop 桥）：
 * - `loadChapterDerivationStatus`：无项目清空态 / 查询结果按 chapterId 键控落表 /
 *   stale resolve 丢弃（await 期间切项目——deferred 手控时序）。
 * - `reExtractChapterDerivation`：
 *   - busy 单飞守卫（在途期间二调 no-op，IPC 不双发）。
 *   - ok:false + 同项目占用机器串（`project_run_active|heldBy=…`）→ projectRunBusy 单源
 *     busy toast（链租约 id → chainRunBusy 文案）；普通 reason → error toast 透传。
 *   - ok:true 无补丁 → success toast + 衍生状态重查（stale 徽标摘除）。
 *   - ok:true + storySyncReview 人审 envelope → setPendingPatch（视图会话键——重提取无自然
 *     链会话，对话栏 PatchReview 承载）+ toast；storySyncLanded → 直落 toast。
 *   - await 期间切项目 → 零 toast 零状态写（隔离纪律）。
 * - 项目切换 reset：两 Record 清空（章 id 是项目内命名空间）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { ChapterDerivationStatusEntry } from '@orison/shared-contracts';
import { useToastStore } from '../src/shared/store/toastStore';
import { runProjectResets } from '../src/shared/store/resetRegistry';

// Mock the agent api module（slice 经 shared/api 分层约束不直连 window——照 chapterReviewSlice.test
// 同款 vi.mock hoisted 谱；const api = window.orisonDesktop 在模块加载期捕获，beforeEach 挂桥无效）。
const apiMocks = vi.hoisted(() => ({
  chapterDerivationStatus: vi.fn(async () => ({ chapters: [] as ChapterDerivationStatusEntry[] })),
  reExtractChapter: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/shared/api/agent', () => apiMocks);

import { createChapterDerivationSlice } from '../src/shared/store/chapterDerivationSlice';
import type { ChapterDerivationSlice } from '../src/shared/store/chapterDerivationSlice';

type TestState = ChapterDerivationSlice & {
  currentProject: { path?: string } | null;
  resolvedLocale: string;
  agentSessionId: string | null;
  setPendingPatch: ReturnType<typeof vi.fn>;
  switchAgentSession: ReturnType<typeof vi.fn>;
};

function makeStore() {
  return create<TestState>()((...a) => ({
    currentProject: null,
    resolvedLocale: 'zh-CN',
    agentSessionId: 'leader-1',
    setPendingPatch: vi.fn(),
    switchAgentSession: vi.fn(),
    ...createChapterDerivationSlice(...a),
  }));
}

/** deferred：手控异步 resolve（竞态时序——spec/ui/testing deferred 谱）。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const STATUS_ROWS: ChapterDerivationStatusEntry[] = [
  { chapterId: 'ch-1', episodeId: 'ep-1', summaryPresent: true, synopsisStale: true, stale: true },
  { chapterId: 'ch-2', episodeId: 'ep-2', summaryPresent: true, synopsisStale: false, stale: false },
  { chapterId: 'ch-3', summaryPresent: false, synopsisStale: false, stale: true },
];

function toastMessages(): string[] {
  return useToastStore.getState().toasts.map((t) => t.message);
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  apiMocks.chapterDerivationStatus.mockReset();
  apiMocks.chapterDerivationStatus.mockResolvedValue({ chapters: STATUS_ROWS });
  apiMocks.reExtractChapter.mockReset();
  apiMocks.reExtractChapter.mockResolvedValue({ ok: true });
});

afterEach(() => {
  // 清 toast 挂起计时器残留（duration 后的自动 dismiss setState）。
  useToastStore.setState({ toasts: [] });
});

describe('loadChapterDerivationStatus（查询面）', () => {
  it('无项目 → 清空态（不触 IPC）；有项目 → 行按 chapterId 键控落表', async () => {
    const store = makeStore();
    await store.getState().loadChapterDerivationStatus();
    expect(apiMocks.chapterDerivationStatus).not.toHaveBeenCalled();
    expect(store.getState().chapterDerivationByChapter).toEqual({});

    store.setState({ currentProject: { path: '/proj-1' } });
    await store.getState().loadChapterDerivationStatus();
    expect(apiMocks.chapterDerivationStatus).toHaveBeenCalledWith({ projectPath: '/proj-1' });
    expect(Object.keys(store.getState().chapterDerivationByChapter)).toEqual(['ch-1', 'ch-2', 'ch-3']);
    expect(store.getState().chapterDerivationByChapter['ch-1']?.stale).toBe(true);
    expect(store.getState().chapterDerivationByChapter['ch-2']?.stale).toBe(false);
  });

  it('stale resolve 丢弃：await 期间切项目 → 旧项目结果不灌新项目', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' }, chapterDerivationByChapter: { keep: STATUS_ROWS[0] } });
    const gate = deferred<{ chapters: ChapterDerivationStatusEntry[] }>();
    apiMocks.chapterDerivationStatus.mockImplementation(() => gate.promise);

    const pending = store.getState().loadChapterDerivationStatus();
    store.setState({ currentProject: { path: '/proj-2' } }); // 切项目
    gate.resolve({ chapters: [{ chapterId: 'x', summaryPresent: true, synopsisStale: false, stale: false }] });
    await pending;

    // 旧项目 resolve 被丢弃：既有表不被覆盖（新项目查询由下一轮挂载触发）。
    expect(Object.keys(store.getState().chapterDerivationByChapter)).toEqual(['keep']);
  });
});

describe('reExtractChapterDerivation（重提取动作面）', () => {
  it('busy 单飞守卫：在途期间二调 no-op（IPC 不双发）；结束归零可再调', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' } });
    const gate = deferred<{ ok: boolean }>();
    apiMocks.reExtractChapter.mockImplementation(() => gate.promise);

    const first = store.getState().reExtractChapterDerivation('ch-1');
    expect(store.getState().chapterReExtracting['ch-1']).toBe(true);
    await store.getState().reExtractChapterDerivation('ch-1'); // busy no-op
    expect(apiMocks.reExtractChapter).toHaveBeenCalledTimes(1);

    gate.resolve({ ok: true });
    await first;
    expect(store.getState().chapterReExtracting['ch-1']).toBeUndefined();
  });

  it('ok:true 无补丁 → success toast + 衍生状态重查（徽标数据刷新）', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' }, chapterDerivationByChapter: { 'ch-1': STATUS_ROWS[0] } });
    apiMocks.reExtractChapter.mockResolvedValue({ ok: true });
    apiMocks.chapterDerivationStatus.mockResolvedValue({
      chapters: [{ chapterId: 'ch-1', episodeId: 'ep-1', summaryPresent: true, synopsisStale: false, stale: false }],
    });

    await store.getState().reExtractChapterDerivation('ch-1');
    expect(apiMocks.reExtractChapter).toHaveBeenCalledWith({ projectPath: '/proj-1', chapterId: 'ch-1' });
    expect(store.getState().chapterDerivationByChapter['ch-1']?.stale).toBe(false); // 重查后摘标
    expect(toastMessages().some((m) => m.includes('重提取完成'))).toBe(true);
  });

  it('ok:true + storySyncReview → setPendingPatch（视图会话键）+ 待审 toast；landed → 直落 toast', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' } });
    apiMocks.reExtractChapter.mockResolvedValue({
      ok: true,
      chapterId: 'ch-1',
      storySyncReview: { note: 'ch-1 story-sync 提取', patches: [{ field: 'world_setting', action: 'set', data: {}, fieldVersion: 1, generatedBy: 'story-sync-agent' }] },
    });
    await store.getState().reExtractChapterDerivation('ch-1');
    expect(store.getState().setPendingPatch).toHaveBeenCalledTimes(1);
    const [sid, envelope] = store.getState().setPendingPatch.mock.calls[0] as [string, { patches: unknown[] }];
    expect(sid).toBe('leader-1'); // 重提取无自然链会话——envelope 落视图会话（对话栏 PatchReview）
    expect(envelope.patches).toHaveLength(1);
    expect(toastMessages().some((m) => m.includes('待审阅'))).toBe(true);

    // landed 直落档：无 setPendingPatch，toast 告知非静默。
    store.getState().setPendingPatch.mockClear();
    apiMocks.reExtractChapter.mockResolvedValue({
      ok: true,
      chapterId: 'ch-1',
      storySyncLanded: { note: 'n', fields: ['world_setting', 'promise_registry'] },
    });
    await store.getState().reExtractChapterDerivation('ch-1');
    expect(store.getState().setPendingPatch).not.toHaveBeenCalled();
    expect(toastMessages().some((m) => m.includes('已自动落盘'))).toBe(true);
  });

  it('CR-6①：已有异 runId 待审批批 → 不覆写 + 冲突警示 toast（不静默丢反哺补丁）；空键/同 runId → 照常 stage', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' } });
    apiMocks.reExtractChapter.mockResolvedValue({
      ok: true,
      chapterId: 'ch-1',
      storySyncReview: { note: 'n', patches: [{ field: 'world_setting', action: 'set', data: {}, fieldVersion: 1, generatedBy: 'story-sync-agent' }] },
    });

    // 异 runId 待审批批在位（他会话/他链落的批）——setPendingPatch 跨 run replace 会静默丢它。
    store.setState({
      pendingPatchBySession: {
        'leader-1': { patch: { runId: 'other-run', createdAt: 't0', patches: [{ field: 'outline', action: 'set', data: {}, fieldVersion: 1, generatedBy: 'x' }] } },
      },
    } as never);
    await store.getState().reExtractChapterDerivation('ch-1');
    expect(store.getState().setPendingPatch).not.toHaveBeenCalled(); // 不覆写
    expect(toastMessages().some((m) => m.includes('已有待审批补丁'))).toBe(true);

    // 空键 → 照常 stage + 待审 toast。
    useToastStore.setState({ toasts: [] });
    store.getState().setPendingPatch.mockClear();
    store.setState({ pendingPatchBySession: {} } as never);
    await store.getState().reExtractChapterDerivation('ch-1');
    expect(store.getState().setPendingPatch).toHaveBeenCalledTimes(1);
    expect(toastMessages().some((m) => m.includes('待审阅'))).toBe(true);

    // 同 runId（本会话此前的 envelope）→ setPendingPatch 同 run 合并语义照常走。
    useToastStore.setState({ toasts: [] });
    store.getState().setPendingPatch.mockClear();
    store.setState({
      pendingPatchBySession: {
        'leader-1': { patch: { runId: 'leader-1', createdAt: 't0', patches: [] } },
      },
    } as never);
    await store.getState().reExtractChapterDerivation('ch-1');
    expect(store.getState().setPendingPatch).toHaveBeenCalledTimes(1);
    expect(toastMessages().some((m) => m.includes('待审阅'))).toBe(true);
  });

  it('CR-6②：agentSessionId null → 补丁不 stage + 警示「无活跃会话承载审阅」（不假「待审」成功态）', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' }, agentSessionId: null });
    apiMocks.reExtractChapter.mockResolvedValue({
      ok: true,
      chapterId: 'ch-1',
      storySyncReview: { note: 'n', patches: [{ field: 'world_setting', action: 'set', data: {}, fieldVersion: 1, generatedBy: 'story-sync-agent' }] },
    });

    await store.getState().reExtractChapterDerivation('ch-1');
    expect(store.getState().setPendingPatch).not.toHaveBeenCalled();
    expect(toastMessages().some((m) => m.includes('无活跃会话承载审阅'))).toBe(true);
    expect(toastMessages().some((m) => m.includes('待审阅'))).toBe(false);
  });

  it('ok:false + project_run_active 机器串（链租约 id）→ chainRunBusy 文案；普通 reason → error toast 透传', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' } });
    apiMocks.reExtractChapter.mockResolvedValue({
      ok: false,
      reason: 'project_run_active|heldBy=chain-run:closure:abc|project=/proj-1',
      chapterId: 'ch-1',
    });
    await store.getState().reExtractChapterDerivation('ch-1');
    expect(toastMessages().some((m) => m.includes('写章链正在运行'))).toBe(true);

    useToastStore.setState({ toasts: [] });
    apiMocks.reExtractChapter.mockResolvedValue({
      ok: false,
      reason: '章 ch-9 未注册（novel.chapters 无此 id）——请先在工作台建章',
      chapterId: 'ch-9',
    });
    await store.getState().reExtractChapterDerivation('ch-9');
    expect(toastMessages().some((m) => m.includes('未注册'))).toBe(true);
    // busy 已归零（失败不卡按钮）。
    expect(store.getState().chapterReExtracting['ch-9']).toBeUndefined();
  });

  it('await 期间切项目 → 零 toast 零 envelope（隔离纪律）；busy 归零', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' } });
    const gate = deferred<{ ok: boolean }>();
    apiMocks.reExtractChapter.mockImplementation(() => gate.promise);

    const pending = store.getState().reExtractChapterDerivation('ch-1');
    store.setState({ currentProject: { path: '/proj-2' } });
    gate.resolve({ ok: true });
    await pending;

    expect(toastMessages()).toEqual([]);
    expect(store.getState().setPendingPatch).not.toHaveBeenCalled();
    expect(store.getState().chapterReExtracting['ch-1']).toBeUndefined();
  });
});

describe('项目切换 reset（章 id 项目内命名空间）', () => {
  it('registerProjectReset：reset 清两 Record', async () => {
    const store = makeStore();
    store.setState({ currentProject: { path: '/proj-1' } });
    await store.getState().loadChapterDerivationStatus();
    expect(Object.keys(store.getState().chapterDerivationByChapter).length).toBe(3);

    runProjectResets();
    expect(store.getState().chapterDerivationByChapter).toEqual({});
    expect(store.getState().chapterReExtracting).toEqual({});
  });
});
