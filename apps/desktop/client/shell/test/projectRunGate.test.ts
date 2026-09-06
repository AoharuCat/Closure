import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { getProjectsRoot } from '../main/ipc/pathGuard';

const {
  handle, warn, info, error, send,
  updateSessionStatus, listProjects, loadProject, acceptChapterCandidate,
  executeSkillByName, runChainChain: runChapterChain, createSession,
  runtimeState,
} = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  send: vi.fn(),
  updateSessionStatus: vi.fn(),
  listProjects: vi.fn(() => []),
  // CR-T1-035：真 chain handler 驱动——local-bff / runtime 链面全 mock（占住→拒→释放链）。
  loadProject: vi.fn(),
  acceptChapterCandidate: vi.fn(),
  executeSkillByName: vi.fn(async () => ({ ok: true })),
  runChainChain: vi.fn(),
  createSession: vi.fn(() => ({ id: 'stub-chain-parent' })),
  runtimeState: {
    sessions: [] as Array<{ id: string; projectPath: string; status: string }>,
    streamMessageImpl: null as null | ((input: { sendEvent: (event: unknown) => void }) => Promise<void>),
    runChainImpl: null as null | (() => Promise<unknown>),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info, error }) }));

vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return {
    ...actual,
    updateSessionStatus,
    createWorkflowRuntime: vi.fn(() => ({
      getSession: vi.fn((id: string) => {
        const meta = runtimeState.sessions.find((s) => s.id === id);
        return meta ? { id: meta.id, projectPath: meta.projectPath, status: meta.status } : undefined;
      }),
      listSessions: vi.fn(() => ({ sessions: runtimeState.sessions })),
      streamMessage: vi.fn(async (input: { sessionId: string; sendEvent: (event: unknown) => void }) => {
        // mirror 真 runtime：会话不在内存 → 'session not found' throw（error 路径）。
        if (!runtimeState.sessions.some((s) => s.id === input.sessionId)) {
          throw new Error('session not found');
        }
        if (runtimeState.streamMessageImpl) return runtimeState.streamMessageImpl(input);
        input.sendEvent({ type: 'done', data: { status: 'completed' } });
      }),
      // CR-T1-035 / CR-T1-032：链入口与 execute-skill 闸集成所需的 runtime 面。
      createSession,
      runChapterChain: vi.fn(async () => {
        if (runtimeState.runChainImpl) return runtimeState.runChainImpl();
        return { status: 'completed', errors: [] };
      }),
      executeSkillByName,
      abortRun: vi.fn(async () => true),
    })),
  };
});

vi.mock('../main/db/projectRepository', () => ({
  listProjects,
  // closureChainIpc 直调 getProject 取 world/cognition snapshot——mock 缺省会 TypeError，
  // handler 内 try/catch graceful（mirror 生产「项目未注册 → undefined」路径）。
  getProject: vi.fn(() => undefined),
}));

vi.mock('@orison/desktop-local-bff', () => ({ loadProject, acceptChapterCandidate }));

vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  handleGenerateText: vi.fn(),
  handleGenerateTextStream: vi.fn(),
  // 09-01 附件 B3：agentIpc 现额外 import resolveModel（agentImageParts 内核装配）——
  // 工厂 mock 同步被引出的全部导出（缺即 vitest 假红）。
  resolveModel: vi.fn(),
}));
vi.mock('../main/ipc/configIpc', () => ({
  readTaskModelSlots: vi.fn(() => undefined),
  // visionAnalysis/agentImageParts 经 agentIpc 入图（readModelConfigFromDisk 被 import）。
  readModelConfigFromDisk: vi.fn(() => ({ keys: [] })),
}));

import { registerAgentIpc, acquireProjectRun, getProjectActiveRuns, reconcileStaleProjectRuns, CHAIN_RUN_LEASE_ID } from '../main/ipc/agentIpc';
import { normalizeProjectKey } from '../main/ipc/pathGuard';

// Production registers once for the app lifetime（mirror agentIpcStreamEventPayload 形态）。
registerAgentIpc(() => ({ webContents: { send } } as unknown as BrowserWindow));

function getHandler(channel: string) {
  const registration = handle.mock.calls.find(([c]) => c === channel);
  expect(registration).toBeDefined();
  return registration![1] as (
    _event: unknown,
    ...args: never[]
  ) => Promise<{ status: string; message?: string; code?: string; heldBySessionId?: string; projectPath?: string; errors?: string[] }>;
}

function getStreamMessageHandler() {
  return getHandler('agent:stream-message') as unknown as (
    _event: unknown,
    input: { sessionId: string; content: string },
  ) => Promise<{ status: string; message?: string; code?: string; heldBySessionId?: string; projectPath?: string }>;
}

function getAbortRunHandler() {
  return getHandler('agent:abort-run') as unknown as (_event: unknown, sessionId: string) => Promise<boolean>;
}

function getExecuteSkillHandler() {
  return getHandler('agent:execute-skill') as unknown as (
    _event: unknown,
    sessionId: string,
    skillName: string,
    request?: unknown,
  ) => Promise<unknown>;
}

const PROJ = `${getProjectsRoot().replace(/\\/g, '/')}/gate-proj`;

/** CR-T1-035：链 handler 走真实 assembleChapterChainArtifacts + readiness gate 的最小 doc。 */
const DOC_FIXTURE = {
  meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
  creative_brief: { genre: '都市奇幻' },
  world_setting: { premise: '灵气复苏都市' },
  asset_cards: [],
  scene_graph: {
    nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }],
    edges: [],
    lines: [],
  },
  promise_registry: { promises: [], beats: [], version: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  send.mockReset();
  runtimeState.sessions = [
    { id: 'sess-a', projectPath: PROJ, status: 'idle' },
    { id: 'sess-b', projectPath: PROJ, status: 'idle' },
  ];
  runtimeState.streamMessageImpl = null;
  runtimeState.runChainImpl = null;
  loadProject.mockReset();
  loadProject.mockReturnValue(DOC_FIXTURE);
  acceptChapterCandidate.mockReset();
  acceptChapterCandidate.mockImplementation(() => undefined);
  createSession.mockClear();
  runChapterChain.mockClear();
  executeSkillByName.mockClear();
  // 每测前清注册表（生产只在启动空表——测试直驱各入口需复位）。
  for (const key of [...getProjectActiveRuns().keys()]) {
    (getProjectActiveRuns() as Map<string, unknown>).delete(key);
  }
});

describe('D4 per-project run 闸（dogfood T1 Stage 3，design §5.4）', () => {
  it('normalizeProjectKey：尾斜杠归一（跨平台——path.resolve）', () => {
    expect(normalizeProjectKey(PROJ)).toBe(normalizeProjectKey(`${PROJ}/`));
  });

  // 大小写归一是 win32 专属行为（NTFS 不区分大小写；normalizeForCompare 平台条件化）。
  // posix 上 `C:\Proj\A` 与 `c:/proj/a` 是两个合法不同的路径，不相等才是正确行为
  // ——公仓 mac CI 首跑实录（08-28 release prep）此前把 Windows 断言写成了无条件。
  it.runIf(process.platform === 'win32')('normalizeProjectKey：win32 大小写/反斜杠归一（防双 key 漏闸）', () => {
    expect(normalizeProjectKey('C:\\Proj\\A/')).toBe(normalizeProjectKey('c:/proj/a'));
  });

  it('同项目两会话：第二个 stream-message 被结构化拒绝（含占用会话 id + 项目路径）', async () => {
    const gate = deferred<void>();
    runtimeState.streamMessageImpl = async (input) => {
      input.sendEvent({ type: 'done', data: { status: 'completed' } });
      await gate.promise; // 第一个 run 挂起（占住项目）。
    };

    const first = getStreamMessageHandler()({}, { sessionId: 'sess-a', content: '写第一章' });
    // 第二个会话同项目 → 拒绝（未启动即返回，含占用者）。
    const second = await getStreamMessageHandler()({}, { sessionId: 'sess-b', content: '写第二章' });
    expect(second.status).toBe('rejected');
    expect(second.code).toBe('project_run_active');
    expect(second.heldBySessionId).toBe('sess-a');
    expect(second.projectPath).toBe(PROJ);

    // 第一个 run 完成（finally 释放）→ 注册表空。
    gate.resolve();
    expect(await first).toEqual({ status: 'completed' });
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('CR-T1-012/021：租约引用计数——同 session 重叠 acquire 先退者只衰减自己那份（句柄幂等）', () => {
    const a1 = acquireProjectRun(PROJ, 'sess-a');
    expect(a1.ok).toBe(true);
    const a2 = acquireProjectRun(PROJ, 'sess-a');
    expect(a2.ok).toBe(true);
    if (!a1.ok || !a2.ok) return;

    a1.release();
    // 后者租约仍在（旧实现按 sessionId 整键删除——先退者会误删后者）。
    expect(getProjectActiveRuns().get(normalizeProjectKey(PROJ))?.refCount).toBe(1);
    a1.release(); // 幂等：双调不二次衰减。
    expect(getProjectActiveRuns().get(normalizeProjectKey(PROJ))?.refCount).toBe(1);

    a2.release();
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('CR-T1-021：同 session 重叠 invoke——先到者 beginRun 抛错（rejected）后 finally 不误删在途者租约', async () => {
    const gate = deferred<void>();
    // second 在途占住；first 撞 runState（mirror cancelAgent 后立刻重发的现实触发）。
    runtimeState.streamMessageImpl = async (input: { content?: string } & { sendEvent: (e: unknown) => void }) => {
      if ((input.content ?? '') === 'second') {
        input.sendEvent({ type: 'done', data: { status: 'completed' } });
        await gate.promise;
        return;
      }
      throw new Error('run already active for session "sess-a"');
    };

    const first = getStreamMessageHandler()({}, { sessionId: 'sess-a', content: 'first' });
    const second = getStreamMessageHandler()({}, { sessionId: 'sess-a', content: 'second' });

    expect(await first).toMatchObject({ status: 'rejected', code: 'session_run_active' });
    // first 的 finally 只衰减自己那份——second 的租约仍占住项目。
    expect(getProjectActiveRuns().get(normalizeProjectKey(PROJ))?.refCount).toBe(1);

    gate.resolve();
    expect(await second).toEqual({ status: 'completed' });
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('CR-T1-013：同 session 双 invoke 撞 runState → 结构化 busy 拒绝（无 error 事件——不误 purge 流占位）', async () => {
    runtimeState.streamMessageImpl = async () => {
      throw new Error('run already active for session "sess-a"');
    };
    const result = await getStreamMessageHandler()({}, { sessionId: 'sess-a', content: 'hi' });
    expect(result).toMatchObject({ status: 'rejected', code: 'session_run_active', heldBySessionId: 'sess-a' });
    expect(result.projectPath).toBe(PROJ);
    // 关键：不走通用 error 分支（sendEvent error 会误 purge 渲染层流占位 + 误显横幅）。
    expect(send).not.toHaveBeenCalled();
  });

  it('CR-T1-022：同 session 重叠 invoke 各持 abort 通道——abort-run 全 abort，先退者 delete 不杀幸存者', async () => {
    const gate = deferred<void>();
    const signals: AbortSignal[] = [];
    runtimeState.streamMessageImpl = async (input: { abortSignal?: AbortSignal } & { sendEvent: (e: unknown) => void }) => {
      if (input.abortSignal) signals.push(input.abortSignal);
      input.sendEvent({ type: 'done', data: { status: 'completed' } });
      await gate.promise;
    };

    const first = getStreamMessageHandler()({}, { sessionId: 'sess-a', content: '1' });
    const second = getStreamMessageHandler()({}, { sessionId: 'sess-a', content: '2' });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(getProjectActiveRuns().get(normalizeProjectKey(PROJ))?.refCount).toBe(2);

    // abort-run：两个 controller 一并 abort（旧单槽：第二个 set 覆盖第一个 → 只剩一个通道）。
    await getAbortRunHandler()({}, 'sess-a');
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(true);

    gate.resolve();
    expect(await first).toEqual({ status: 'completed' });
    expect(await second).toEqual({ status: 'completed' });
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('跨项目不互拦（D4 跨项目自由并行）', () => {
    const g1 = acquireProjectRun(`${getProjectsRoot()}/proj-1`, 'sess-a');
    const g2 = acquireProjectRun(`${getProjectsRoot()}/proj-2`, 'sess-b');
    expect(g1.ok).toBe(true);
    expect(g2.ok).toBe(true);
    if (g1.ok) g1.release();
    if (g2.ok) g2.release();
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('throw 路径也释放（finally——run 崩溃不留死锁）', async () => {
    runtimeState.streamMessageImpl = async () => {
      throw new Error('connection reset');
    };
    const result = await getStreamMessageHandler()({}, { sessionId: 'sess-a', content: 'hi' });
    expect(result.status).toBe('error');
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('会话不在内存：不闸（既有 session-not-found error 路径不变）', async () => {
    runtimeState.sessions = [];
    const result = await getStreamMessageHandler()({}, { sessionId: 'sess-missing', content: 'hi' });
    expect(result.status).toBe('error');
    expect(result.code).toBeUndefined();
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('CR-T1-032：agent:execute-skill 补 D4 闸——占用拒（结构化，不派发）+ 空闲放行 + finally 释放', async () => {
    const execHandler = getExecuteSkillHandler();
    const holder = acquireProjectRun(PROJ, 'sess-b');
    expect(holder.ok).toBe(true);

    const rejected = await execHandler({}, 'sess-a', 'some-skill', 'req');
    expect(rejected).toMatchObject({ status: 'rejected', code: 'project_run_active', heldBySessionId: 'sess-b' });
    expect(executeSkillByName).not.toHaveBeenCalled();

    if (holder.ok) holder.release();
    const ok = await execHandler({}, 'sess-a', 'some-skill', 'req');
    expect(executeSkillByName).toHaveBeenCalledWith('sess-a', 'some-skill', 'req');
    expect(ok).toEqual({ ok: true });
    expect(getProjectActiveRuns().size).toBe(0); // finally 释放
  });

  it('启动对账：stale running 会话归位 idle（persist 经 updateSessionStatus）+ 清非活跃注册表', async () => {
    runtimeState.sessions = [
      { id: 'sess-stale', projectPath: PROJ, status: 'running' },
      { id: 'sess-fine', projectPath: PROJ, status: 'idle' },
    ];
    listProjects.mockReturnValue([{ projectId: '1', path: PROJ } as never]);
    // 注册表残留一项（模拟异常未释放——非活跃流）。
    const ghost = acquireProjectRun(PROJ, 'sess-ghost');
    expect(ghost.ok).toBe(true);

    await reconcileStaleProjectRuns();

    expect(updateSessionStatus).toHaveBeenCalledWith('sess-stale', 'idle');
    expect(updateSessionStatus).toHaveBeenCalledTimes(1); // idle 会话不动。
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('D4 拒绝路径不注册 abort controller（泄漏 entry 会误导启动对账的「活跃流」判定）', async () => {
    // sess-a 在途占项目；sess-b 同项目发送被结构化拒绝（无流启动）。
    const gate = deferred<void>();
    runtimeState.streamMessageImpl = async () => { await gate.promise; };
    const first = getStreamMessageHandler()({}, { sessionId: 'sess-a', content: 'hi' });
    const rejected = await getStreamMessageHandler()({}, { sessionId: 'sess-b', content: 'hi' });
    expect(rejected.status).toBe('rejected');
    gate.resolve();
    expect(await first).toEqual({ status: 'completed' });

    // sess-b 磁盘 status='running'（崩溃残留 stale）→ 启动对账应归位 idle。旧实现拒绝路径
    // 早退 return 前已 set 且 finally 不覆盖 → streamAbortControllers.has('sess-b') 误判
    // 「本进程活跃流」跳过归位（徽标永久 running）。
    runtimeState.sessions = [
      { id: 'sess-a', projectPath: PROJ, status: 'idle' },
      { id: 'sess-b', projectPath: PROJ, status: 'running' },
    ];
    listProjects.mockReturnValue([{ projectId: '1', path: PROJ } as never]);
    updateSessionStatus.mockClear();
    await reconcileStaleProjectRuns();
    expect(updateSessionStatus).toHaveBeenCalledWith('sess-b', 'idle');
  });

  // ── CR-T1-035：链入口接入注册表——真 handler + 可控 mock 驱动完整链 ──
  // （旧用例只手动 acquire/release 注册表、未真调 chain handler——恰在 020/021 高危面留
  // 测试空洞。本用例走 zod→pathGuard→gate→loadProject→assemble→readiness→runChapterChain
  // 全链：占住 → 二路链互拒（020 唯一租约）→ chat 拒 → 释放 → chat 放行。）
  it('CR-T1-035+020：真 chain handler 占住项目——二路链互拒（唯一租约 id）→ chat 拒 → 释放后放行', async () => {
    const { registerClosureChainIpc } = await import('../main/ipc/closureChainIpc');
    registerClosureChainIpc();
    const chainRun = getHandler('closure:run-chapter-chain') as unknown as (
      _event: unknown,
      input: { projectPath: string; episodeId: string; chapterBrief: { goal: string } },
    ) => Promise<{ status: string; errors?: string[] }>;

    const chainGate = deferred<void>();
    runtimeState.runChainImpl = async () => {
      await chainGate.promise;
      return { status: 'completed', errors: [] };
    };

    const first = chainRun({}, { projectPath: PROJ, episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } });
    await vi.waitFor(() => expect(getProjectActiveRuns().size).toBe(1));

    // 二路链（同项目并发）：CR-T1-020——每 invoke 唯一租约 id，第二路必拒（旧常量 id 放行）。
    const second = await chainRun({}, { projectPath: PROJ, episodeId: 'ep1', chapterBrief: { goal: 'REACH_B_CITY' } });
    expect(second.status).toBe('error');
    expect(second.errors?.[0]).toMatch(new RegExp(`^project_run_active\\|heldBy=${CHAIN_RUN_LEASE_ID}:`));

    // chat 同项目 → 拒（占用者为链租约 id——UI 据前缀换文案不提供跳转，CR-T1-030）。
    const chat = await getStreamMessageHandler()({}, { sessionId: 'sess-a', content: 'hi' });
    expect(chat.status).toBe('rejected');
    expect(chat.heldBySessionId).toMatch(new RegExp(`^${CHAIN_RUN_LEASE_ID}:`));

    // 一路链完成（finally 经 handle 释放）→ 注册表空 → chat 放行。
    chainGate.resolve();
    expect(await first).toMatchObject({ status: 'completed' });
    expect(getProjectActiveRuns().size).toBe(0);
    const ok = await getStreamMessageHandler()({}, { sessionId: 'sess-a', content: 'hi' });
    expect(ok.status).toBe('completed');
  });
});
