import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  fetchAgentSession: vi.fn(),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
  // W4（09-21-subagent-bg-decouple）：slice 新增 IPC 依赖（部分 mock 工厂同步；缺导出 =
  // 访问即抛的 vitest mock getter 假红）。isPrimaryListableSession 住 projectRunBusy（不 mock，
  // 无需在此列）。
  listAgentBgTasks: vi.fn(async () => ({ tasks: [] })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import { createAgentSessionSlice, type AgentSessionSlice } from '../src/shared/store/agentSessionSlice';

type TestState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  pendingDiffs: any[];
  pendingToolConfirm: any;
  pendingPassageResolve: unknown | null;
  fieldMetadata: Record<string, { version: number } | undefined>;
  setPendingPatch: ReturnType<typeof vi.fn>;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activeChapterId: null,
  pendingDiffsBySession: {},
  pendingToolConfirmBySession: {},
  pendingPassageResolveBySession: {},
  fieldMetadata: {},
  setPendingPatch: vi.fn(),
  ...createAgentSessionSlice(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('agent session project isolation', () => {
  beforeEach(() => {
    apiMocks.createAgentSession.mockReset();
    apiMocks.fetchAgentSession.mockReset();
    apiMocks.listAgentSessions.mockReset();
    apiMocks.setAgentSessionMode.mockReset();
    apiMocks.setAgentSessionMode.mockResolvedValue({ ok: true });
    apiMocks.setAgentSessionBehaviorMode.mockReset();
    apiMocks.setAgentSessionBehaviorMode.mockResolvedValue({ ok: true });
    apiMocks.streamAgentMessage.mockClear();
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    useTestStore.setState({
      currentProject: null,
      agentSessionId: null,
      agentMessages: [],
      agentSessions: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      pendingDiffsBySession: {},
      pendingToolConfirmBySession: {},
    });
  });

  it('does not attach a session created for a project that has already changed', async () => {
    const created = deferred<any>();
    apiMocks.createAgentSession.mockReturnValue(created.promise);
    useTestStore.setState({ currentProject: { path: 'I:/project-a' } });

    const sending = useTestStore.getState().sendAgentMessage('hello');
    useTestStore.setState({ currentProject: { path: 'I:/project-b' } });
    useTestStore.getState().resetAgentForProjectSwitch();
    created.resolve({ id: 'session-a', messages: [] });
    await sending;

    expect(useTestStore.getState().agentSessionId).toBeNull();
    expect(useTestStore.getState().agentMessages).toEqual([]);
    expect(apiMocks.streamAgentMessage).not.toHaveBeenCalled();
  });

  it('prevents duplicate session creation while the first send is still creating a session', async () => {
    const created = deferred<any>();
    apiMocks.createAgentSession.mockReturnValue(created.promise);
    useTestStore.setState({ currentProject: { path: 'I:/project-a' } });

    const firstSend = useTestStore.getState().sendAgentMessage('first');
    const secondSend = useTestStore.getState().sendAgentMessage('second');

    expect(useTestStore.getState().activeSessionRunning).toBe(true);
    expect(apiMocks.createAgentSession).toHaveBeenCalledTimes(1);

    created.resolve({ id: 'session-a', messages: [] });
    await Promise.all([firstSend, secondSend]);

    expect(apiMocks.streamAgentMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the session creation configuration stable until creation finishes', async () => {
    const created = deferred<any>();
    apiMocks.createAgentSession.mockReturnValue(created.promise);
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentMode: 'suggest',
      agentBehaviorMode: 'normal',
    });

    const sending = useTestStore.getState().sendAgentMessage('hello');
    useTestStore.getState().setAgentMode('auto');

    expect(useTestStore.getState().agentMode).toBe('suggest');

    created.resolve({ id: 'session-a', messages: [] });
    await sending;

    // Story 3.1: createAgentSession now takes a 3rd behaviorMode arg (default
    // 'normal'); the snapshot at send time is what's used, like mode.
    // Story 3.5: 4th participationGear arg (default 'smart'), same semantics.
    expect(apiMocks.createAgentSession).toHaveBeenCalledWith(
      'I:/project-a',
      'suggest',
      'normal',
      'smart',
    );
  });

  it('keeps the latest project session list when older loads resolve later', async () => {
    const listA = deferred<any[]>();
    // dogfood R2 #5：reset 现在会触发自动接续加载（占一个 mock 队列位）——空列表 = 不选中，
    // 且其 token（2）会被随后的显式加载（3）压过，晚到的旧加载（1）照旧被拒。
    const autoList = deferred<any[]>();
    const listB = deferred<any[]>();
    apiMocks.listAgentSessions
      .mockImplementationOnce(() => listA.promise)
      .mockImplementationOnce(() => autoList.promise)
      .mockImplementationOnce(() => listB.promise);

    useTestStore.setState({ currentProject: { path: 'I:/project-a' } });
    const loadingA = useTestStore.getState().loadAgentSessions();
    useTestStore.setState({ currentProject: { path: 'I:/project-b' } });
    useTestStore.getState().resetAgentForProjectSwitch();
    autoList.resolve([]);
    // CR-37④（并发去重）：loadAgentSessions 同窗并发调用共享 in-flight fetch——与在途接续
    // load 同 tick 的调用会共享其结果（不再发自己的 IPC）。此处先让接续 load 落定（in-flight
    // 清空）再发显式加载，模拟「列表已落、用户随后打开历史面板」的时序（真·新拉一路）。
    await new Promise((r) => setTimeout(r, 0));
    const loadingB = useTestStore.getState().loadAgentSessions();

    listB.resolve([{ id: 'session-b', projectPath: 'I:/project-b' }]);
    await loadingB;
    listA.resolve([{ id: 'session-a', projectPath: 'I:/project-a' }]);
    await loadingA;

    expect(useTestStore.getState().agentSessions.map((session) => session.id)).toEqual(['session-b']);
  });

  it('reopens the most recent session after a project reset (dogfood R2 #5 auto-resume)', async () => {
    // updated_at DESC 首个 = 最近活跃会话——重开项目自动接续，不再落到空白新会话视图。
    apiMocks.listAgentSessions.mockResolvedValue([
      { id: 'latest', projectPath: 'I:/project-b', permissionMode: 'auto' },
      { id: 'older', projectPath: 'I:/project-b' },
    ]);
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'latest',
      projectPath: 'I:/project-b',
      messages: [],
      permissionMode: 'auto',
      behaviorMode: 'normal',
    });

    useTestStore.setState({ currentProject: { path: 'I:/project-b' } });
    useTestStore.getState().resetAgentForProjectSwitch();

    await vi.waitFor(() => {
      expect(useTestStore.getState().agentSessionId).toBe('latest');
    });
    // 用户在自动接续的加载窗口内先手选择（列表在途、切换未发）→ 让位（agentSessionId 非空守卫）。
    const slowList = deferred<any[]>();
    apiMocks.listAgentSessions.mockReset();
    apiMocks.listAgentSessions.mockImplementationOnce(() => slowList.promise);
    apiMocks.fetchAgentSession.mockClear();
    useTestStore.getState().resetAgentForProjectSwitch();
    useTestStore.setState({ agentSessionId: 'picked-manually' });
    slowList.resolve([{ id: 'latest', projectPath: 'I:/project-b' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(useTestStore.getState().agentSessionId).toBe('picked-manually');
    expect(apiMocks.fetchAgentSession).not.toHaveBeenCalled();
  });

  it('clears the cached session list during a project reset', () => {
    useTestStore.setState({
      agentSessions: [{ id: 'session-a', projectPath: 'I:/project-a' } as any],
    });

    useTestStore.getState().resetAgentForProjectSwitch();

    expect(useTestStore.getState().agentSessions).toEqual([]);
  });

  it('rolls back the displayed permission mode when session persistence fails', async () => {
    apiMocks.setAgentSessionMode.mockResolvedValue({ ok: false });
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentSessionId: 'session-a',
      agentMode: 'suggest',
    });

    useTestStore.getState().setAgentMode('readonly');

    await vi.waitFor(() => {
      expect(useTestStore.getState().agentMode).toBe('suggest');
    });
    expect(useTestStore.getState().agentError).toBe('agent.modeSwitchFailed');
  });

  it('uses the persisted permission mode when switching sessions', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'session-auto',
      permissionMode: 'auto',
      messages: [],
    });
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentMode: 'readonly',
    });

    await useTestStore.getState().switchAgentSession('session-auto');

    expect(useTestStore.getState().agentMode).toBe('auto');
    expect(localStorage.getItem('orison_agentMode')).toBe('auto');
  });

  it('连续模式切换都失败时回滚到最后确认模式', async () => {
    const first = deferred<{ ok: boolean }>();
    const second = deferred<{ ok: boolean }>();
    apiMocks.setAgentSessionMode
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentSessionId: 'session-a',
      agentMode: 'suggest',
    });

    useTestStore.getState().setAgentMode('readonly');
    useTestStore.getState().setAgentMode('auto');
    first.resolve({ ok: false });
    await vi.waitFor(() => expect(apiMocks.setAgentSessionMode).toHaveBeenCalledTimes(2));
    second.resolve({ ok: false });

    await vi.waitFor(() => expect(useTestStore.getState().agentMode).toBe('suggest'));
  });

  it('删除后端拒绝的历史会话时保留列表项', async () => {
    apiMocks.deleteAgentSession.mockResolvedValueOnce(false);
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentSessions: [{ id: 'session-a', projectPath: 'I:/project-a' } as any],
    });

    await useTestStore.getState().deleteAgentSession('session-a');

    expect(apiMocks.deleteAgentSession).toHaveBeenCalledWith('session-a', 'I:/project-a');
    expect(useTestStore.getState().agentSessions.map((session) => session.id)).toEqual(['session-a']);
  });

  // ── Story 3.1: behavior-mode axis (normal/discuss/plan), orthogonal to the
  // permission mode above. Mirrors its rollback + hydration semantics. ──

  it('rolls back the displayed behavior mode when session persistence fails', async () => {
    apiMocks.setAgentSessionBehaviorMode.mockResolvedValue({ ok: false });
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentSessionId: 'session-a',
      agentBehaviorMode: 'normal',
    });

    useTestStore.getState().setAgentBehaviorMode('plan');

    await vi.waitFor(() => {
      expect(useTestStore.getState().agentBehaviorMode).toBe('normal');
    });
    expect(useTestStore.getState().agentError).toBe('agent.behaviorSwitchFailed');
  });

  it('uses the persisted behavior mode when switching sessions', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'session-plan',
      permissionMode: 'suggest',
      behaviorMode: 'plan',
      messages: [],
    });
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentBehaviorMode: 'normal',
    });

    await useTestStore.getState().switchAgentSession('session-plan');

    expect(useTestStore.getState().agentBehaviorMode).toBe('plan');
    expect(localStorage.getItem('orison_agentBehaviorMode')).toBe('plan');
  });

  it('behavior-mode switch is independent of permission-mode switch (orthogonal axes)', async () => {
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentSessionId: 'session-a',
      agentMode: 'suggest',
      agentBehaviorMode: 'normal',
    });

    useTestStore.getState().setAgentMode('auto');
    useTestStore.getState().setAgentBehaviorMode('discuss');

    await vi.waitFor(() => expect(apiMocks.setAgentSessionMode).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(apiMocks.setAgentSessionBehaviorMode).toHaveBeenCalledTimes(1));

    // Both switches succeeded → both selections stick; neither clobbers the other.
    expect(useTestStore.getState().agentMode).toBe('auto');
    expect(useTestStore.getState().agentBehaviorMode).toBe('discuss');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #14（2026-08-25）：「新会话」草稿行 + 列表实时刷新。
// 根因两处：① newAgentSession 只重置视图（懒建语义——首条消息才真建会话），历史列表
// 对此零可见；② sendAgentMessage 懒建会话落地后不刷列表——开着的历史面板看不到新条目。
// ─────────────────────────────────────────────────────────────────────────────
describe('R2 #14：新会话草稿标记 + 建会话列表刷新', () => {
  beforeEach(() => {
    apiMocks.createAgentSession.mockReset();
    apiMocks.fetchAgentSession.mockReset();
    apiMocks.listAgentSessions.mockReset();
    apiMocks.streamAgentMessage.mockClear();
    (globalThis.window as any).window = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    useTestStore.setState({
      currentProject: { path: 'I:/project-a' },
      agentSessionId: null,
      agentMessages: [],
      agentSessions: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      draftSession: false,
    } as any);
  });

  it('newAgentSession：视图重置 + 草稿标记置位（懒建语义不变，列表据此渲染草稿行）', async () => {
    useTestStore.setState({ agentSessionId: 'session-a', draftSession: false });
    await useTestStore.getState().newAgentSession();
    expect(useTestStore.getState().agentSessionId).toBeNull();
    expect(useTestStore.getState().agentMessages).toEqual([]);
    expect(useTestStore.getState().draftSession).toBe(true);
  });

  it('懒建会话落地：草稿清 + 列表刷新（历史面板实时看到新条目）', async () => {
    useTestStore.setState({ draftSession: true });
    apiMocks.createAgentSession.mockResolvedValue({ id: 'session-new', messages: [] });
    apiMocks.listAgentSessions.mockResolvedValue([{ id: 'session-new', projectPath: 'I:/project-a' }]);
    apiMocks.streamAgentMessage.mockResolvedValue({ status: 'completed' });

    await useTestStore.getState().sendAgentMessage('第一条');

    expect(useTestStore.getState().agentSessionId).toBe('session-new');
    expect(useTestStore.getState().draftSession).toBe(false);
    // 建会话瞬间刷新列表（fire-and-forget → waitFor 兑现）。
    await vi.waitFor(() => expect(apiMocks.listAgentSessions).toHaveBeenCalled());
  });

  it('切到真会话：草稿清（点过「新会话」又改选历史的路径）', async () => {
    useTestStore.setState({ draftSession: true });
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'session-b', projectPath: 'I:/project-a', messages: [], permissionMode: 'suggest', behaviorMode: 'normal',
    });
    await useTestStore.getState().switchAgentSession('session-b');
    expect(useTestStore.getState().agentSessionId).toBe('session-b');
    expect(useTestStore.getState().draftSession).toBe(false);
  });

  it('项目重置：草稿清（新项目视图 ≠ 用户点了「新会话」）', () => {
    useTestStore.setState({ draftSession: true });
    useTestStore.getState().resetAgentForProjectSwitch();
    expect(useTestStore.getState().draftSession).toBe(false);
  });
});
