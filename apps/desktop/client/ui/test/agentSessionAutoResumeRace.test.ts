import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  fetchAgentSession: vi.fn(),
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

// ─────────────────────────────────────────────────────────────────────────────
// CR-37（dogfood R2 BMad CR）：重开项目自动接续（resetAgentForProjectSwitch 尾 IIFE）
// 三重竞态 + 双拉去重。
// ① 显式「新会话」点击不被接管踹掉（guard 补 draftSession 子句 + 在途切换完成帧弃权）；
// ② autoResumeToken 守卫——load 窗口内用户先手（发送/新会话/切换，均 bump）→ 接管弃权；
// ③ 损坏 latest 会话接续失败 → 静默回落空白草稿态（清 agentError，视同无会话；手动切换照旧报错）；
// ④ 接管 load 与面板 load 双拉去重（共享 in-flight promise）。
// ─────────────────────────────────────────────────────────────────────────────

type TestState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  clearSessionPending: ReturnType<typeof vi.fn>;
  clearPausedReviewFor: ReturnType<typeof vi.fn>;
  clearPendingPatchFor: ReturnType<typeof vi.fn>;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activeChapterId: null,
  clearSessionPending: vi.fn(),
  clearPausedReviewFor: vi.fn(),
  clearPendingPatchFor: vi.fn(),
  ...createAgentSessionSlice(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const CORRUPT_ERROR = new Error('JSONL corrupted (session unreadable)');

describe('CR-37：自动接续三重竞态 + 双拉去重', () => {
  beforeEach(() => {
    apiMocks.createAgentSession.mockReset();
    apiMocks.fetchAgentSession.mockReset();
    apiMocks.listAgentSessions.mockReset();
    apiMocks.streamAgentMessage.mockClear();
    (globalThis.window as any) = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    useTestStore.setState({
      currentProject: { path: 'I:/project-r2' },
      agentSessionId: null,
      agentMessages: [],
      agentSessions: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      sessionSwitching: false,
      draftSession: false,
    } as any);
  });

  it('① load 窗口内显式「新会话」点击不被接管踹掉（draftSession 守卫）', async () => {
    const list = deferred<any[]>();
    apiMocks.listAgentSessions.mockReturnValue(list.promise);

    useTestStore.getState().resetAgentForProjectSwitch();
    // 列表在途时用户点「新会话」——agentSessionId 置 null + draftSession:true（旧 guard 只查
    // agentSessionId 非空，恰被置空语义绕过 → 接管踹掉草稿）。
    await useTestStore.getState().newAgentSession();
    expect(useTestStore.getState().draftSession).toBe(true);

    list.resolve([{ id: 'latest', projectPath: 'I:/project-r2' }]);
    await new Promise((r) => setTimeout(r, 0));

    // 接管让位：不切换、草稿保留。
    expect(apiMocks.fetchAgentSession).not.toHaveBeenCalled();
    expect(useTestStore.getState().agentSessionId).toBeNull();
    expect(useTestStore.getState().draftSession).toBe(true);
    expect(useTestStore.getState().agentMessages).toEqual([]);
  });

  it('① switch fetch 窗口内显式「新会话」点击不被旧切换完成帧覆盖（token 弃权）', async () => {
    apiMocks.listAgentSessions.mockResolvedValue([{ id: 'latest', projectPath: 'I:/project-r2' }]);
    const fetchSession = deferred<any>();
    apiMocks.fetchAgentSession.mockReturnValue(fetchSession.promise);

    useTestStore.getState().resetAgentForProjectSwitch();
    // 接管切换已发出（fetch 在途，sessionSwitching 竖起）。
    await vi.waitFor(() => expect(useTestStore.getState().sessionSwitching).toBe(true));

    await useTestStore.getState().newAgentSession();
    expect(useTestStore.getState().draftSession).toBe(true);

    fetchSession.resolve({
      id: 'latest', projectPath: 'I:/project-r2', messages: [{ id: 'm1', role: 'user', content: '旧会话内容' }],
      permissionMode: 'suggest', behaviorMode: 'normal',
    });
    await new Promise((r) => setTimeout(r, 0));

    // 旧切换完成帧弃权：草稿视图不被旧会话内容覆盖，切换视觉不残留。
    expect(useTestStore.getState().agentSessionId).toBeNull();
    expect(useTestStore.getState().draftSession).toBe(true);
    expect(useTestStore.getState().agentMessages).toEqual([]);
    expect(useTestStore.getState().sessionSwitching).toBe(false);
  });

  it('② load 窗口内用户先手发送 → 接管弃权（本轮建会话不被旧接管帧覆盖）', async () => {
    const list = deferred<any[]>();
    apiMocks.listAgentSessions.mockReturnValue(list.promise);
    apiMocks.createAgentSession.mockResolvedValue({ id: 'session-new', messages: [] });
    apiMocks.streamAgentMessage.mockResolvedValue({ status: 'completed' });

    useTestStore.getState().resetAgentForProjectSwitch();
    await useTestStore.getState().sendAgentMessage('趁接续加载在途先发第一条');
    expect(useTestStore.getState().agentSessionId).toBe('session-new');

    list.resolve([{ id: 'latest', projectPath: 'I:/project-r2' }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(apiMocks.fetchAgentSession).not.toHaveBeenCalled();
    expect(useTestStore.getState().agentSessionId).toBe('session-new');
    expect(useTestStore.getState().agentMessages.some((m) => m.content === '趁接续加载在途先发第一条')).toBe(true);
  });

  it('③ 损坏 latest 会话接续失败 → 静默回落空白草稿态（清 agentError，视同无会话）', async () => {
    apiMocks.listAgentSessions.mockResolvedValue([{ id: 'corrupted-latest', projectPath: 'I:/project-r2' }]);
    apiMocks.fetchAgentSession.mockRejectedValue(CORRUPT_ERROR);

    useTestStore.getState().resetAgentForProjectSwitch();

    await vi.waitFor(() => expect(useTestStore.getState().sessionSwitching).toBe(false));
    // 无错误横幅、无半切换态——视同无会话的空白视图。
    expect(useTestStore.getState().agentError).toBeNull();
    expect(useTestStore.getState().agentSessionId).toBeNull();
    expect(useTestStore.getState().agentMessages).toEqual([]);
    expect(useTestStore.getState().draftSession).toBe(false);
  });

  it('③ 对照：手动切换损坏会话照旧报错（autoResume 档才静默——不吞用户显式操作的失败）', async () => {
    apiMocks.fetchAgentSession.mockRejectedValue(CORRUPT_ERROR);

    await useTestStore.getState().switchAgentSession('corrupted-manual');

    expect(useTestStore.getState().agentError).toBe(CORRUPT_ERROR.message);
    expect(useTestStore.getState().sessionSwitching).toBe(false);
  });

  it('④ 接管 load 与面板 load 双拉去重——共享 in-flight fetch（单次 IPC）', async () => {
    const list = deferred<any[]>();
    apiMocks.listAgentSessions.mockReturnValue(list.promise);
    apiMocks.fetchAgentSession.mockResolvedValue({
      id: 'latest', projectPath: 'I:/project-r2', messages: [], permissionMode: 'suggest', behaviorMode: 'normal',
    });

    useTestStore.getState().resetAgentForProjectSwitch();
    // 同窗并发第二路（历史面板 load）——共享在途 fetch，不再发第二个 IPC。
    const panelLoad = useTestStore.getState().loadAgentSessions();

    list.resolve([{ id: 'latest', projectPath: 'I:/project-r2' }]);
    await panelLoad;
    await new Promise((r) => setTimeout(r, 0));

    expect(apiMocks.listAgentSessions).toHaveBeenCalledTimes(1);
    expect(useTestStore.getState().agentSessions.map((s) => s.id)).toEqual(['latest']);
    // 共享的接续路径照常走完（fetchAgentSession 已由 IIFE 自动接续消费，非面板 load 职责）。
    await vi.waitFor(() => expect(useTestStore.getState().agentSessionId).toBe('latest'));
  });
});

describe('dogfood R2 #50：autoResume 盖章 settledHistory（重开项目不打字机回放）', () => {
  const SESSION = {
    id: 'latest', projectPath: 'I:/project-r2',
    messages: [
      { id: 'm1', role: 'user', content: '你好' },
      { id: 'm2', role: 'assistant', content: '上次会话的末条回答' },
    ],
    permissionMode: 'suggest', behaviorMode: 'normal',
  };

  beforeEach(() => {
    apiMocks.fetchAgentSession.mockReset();
    useTestStore.setState({
      currentProject: { path: 'I:/project-r2' },
      agentSessionId: null,
      agentMessages: [],
      sessionSwitching: false,
      agentError: null,
    } as any);
  });

  it('autoResume 接续：全部消息盖章 settledHistory（末条 assistant 不进打字机）', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue(SESSION);
    await useTestStore.getState().switchAgentSession('latest', { autoResume: true });
    const msgs = useTestStore.getState().agentMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.settledHistory === true)).toBe(true);
  });

  it('对照：手动切会话不盖章（AgentHistory 主动浏览——历史回放 + skip 钮语义保留）', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue(SESSION);
    await useTestStore.getState().switchAgentSession('latest');
    const msgs = useTestStore.getState().agentMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs.some((m) => m.settledHistory === true)).toBe(false);
  });

  // ── BMad CR 组4：running 会话恢复（fixture）——流式中尾部盖章不破坏 shouldAnimate
  // ── 豁免的显式锁定 ──
  // 重开项目自动接续到一个 **还在跑** 的会话（磁盘 status='running'，或事件面已登记
  // running）：末条 assistant 可能正是流式中途的那条。盖章必须照常覆盖末条——
  // AgentMessageItem.shouldAnimate 的豁免锁是**显式字段判定**
  // （`message.settledHistory !== true`，与 everStreamed/aborted_partial/isLatest 并列），
  // 尾条一旦缺章就会在恢复帧进打字机全量重放（把正在产出的 run 内容顶成重播噪音）。

  it('autoResume 接续 running 会话：视图运行态置真 + 全部消息（含流中末条）盖章 settledHistory', async () => {
    apiMocks.fetchAgentSession.mockResolvedValue({
      ...SESSION,
      status: 'running',
      messages: [
        { id: 'm1', role: 'user', content: '继续写' },
        { id: 'm2', role: 'assistant', content: '上次中断时的部分产出', kind: 'aborted_partial' },
        { id: 'm3', role: 'assistant', content: '恢复后正在流式的那条' },
      ],
    });
    await useTestStore.getState().switchAgentSession('latest', { autoResume: true });
    // 视图运行态跟随磁盘 status（run 继续的现场感）。
    expect(useTestStore.getState().activeSessionRunning).toBe(true);
    const msgs = useTestStore.getState().agentMessages;
    // 尾部盖章逐条覆盖——末条（shouldAnimate 的 isLatest 候选）也在内。
    expect(msgs.every((m) => m.settledHistory === true)).toBe(true);
    expect(msgs[msgs.length - 1]!.settledHistory).toBe(true);
    // 显式锁定可读：shouldAnimate 豁免条件之一的输入就是这一字段本身。
    for (const m of msgs) expect(m.settledHistory !== true).toBe(false);
  });

  it('autoResume 接续 running 会话（事件面 run 态优先于磁盘兜底）：盖章语义不变', async () => {
    useTestStore.setState({
      agentRunStates: { latest: { sessionId: 'latest', phase: 'running', updatedAt: 0 } } as any,
    } as any);
    apiMocks.fetchAgentSession.mockResolvedValue({ ...SESSION, status: 'completed' });
    await useTestStore.getState().switchAgentSession('latest', { autoResume: true });
    expect(useTestStore.getState().activeSessionRunning).toBe(true); // runningFromEvents || 磁盘兜底
    expect(useTestStore.getState().agentMessages.every((m) => m.settledHistory === true)).toBe(true);
  });
});
