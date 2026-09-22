import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { getProjectsRoot } from '../main/ipc/pathGuard';
import { MAX_BG_PER_PROJECT } from '@orison/desktop-agent';
import { rmBestEffort } from './rmBestEffort';

const {
  handle, warn, info, error, send,
  updateSessionStatus, listProjects, loadProject, acceptChapterCandidate,
  executeSkillByName, createSession, abortRun,
  runtimeState,
} = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  send: vi.fn(),
  updateSessionStatus: vi.fn(),
  listProjects: vi.fn(() => [] as unknown[]),
  loadProject: vi.fn(),
  acceptChapterCandidate: vi.fn(),
  executeSkillByName: vi.fn(async () => ({ ok: true })),
  createSession: vi.fn(() => ({ id: 'stub' })),
  abortRun: vi.fn(async () => true),
  runtimeState: {
    sessions: [] as Array<{ id: string; projectPath: string; status: string }>,
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
      streamMessage: vi.fn(async () => { throw new Error('session not found'); }),
      createSession,
      executeSkillByName,
      abortRun,
    })),
  };
});

vi.mock('../main/db/projectRepository', () => ({
  listProjects,
  getProject: vi.fn(() => undefined),
}));

vi.mock('@orison/desktop-local-bff', () => ({ loadProject, acceptChapterCandidate }));

vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  handleGenerateText: vi.fn(),
  handleGenerateTextStream: vi.fn(),
  resolveModel: vi.fn(),
}));
vi.mock('../main/ipc/configIpc', () => ({
  readTaskModelSlots: vi.fn(() => undefined),
  readModelConfigFromDisk: vi.fn(() => ({ keys: [] })),
  readUserPreferencesFromDisk: vi.fn(() => ({})),
}));

import {
  registerAgentIpc,
  acquireProjectRun,
  acquireBgRun,
  releaseBgRun,
  getProjectActiveRuns,
  reconcileStaleProjectRuns,
  noteBgChildRuntimeEvent,
  _resetBgChildBookkeepingForTest,
  _unregisterBgChildControllerForTest,
  CHAIN_RUN_LEASE_ID,
} from '../main/ipc/agentIpc';
import { getBgTaskRegistry, cancelBgTasksForProject } from '@orison/desktop-agent';
import { normalizeProjectKey } from '../main/ipc/pathGuard';
import { randomUUID } from 'node:crypto';

// Production registers once for the app lifetime（mirror projectRunGate.test 形态——reconcile
// 依赖 registerAgentIpc 装配的 runtime 单例）。
registerAgentIpc(() => ({ webContents: { send } } as unknown as BrowserWindow));

const PROJ = `${getProjectsRoot().replace(/\\/g, '/')}/bg-lane-proj`;

// CR-16：本文件在真实 projects root 下建过目录——afterAll 统一清理（rmBestEffort 纪律，
// 并行负载下 rmSync EPERM 兜底），不留测试垃圾。
const createdDirs: string[] = [];
afterAll(() => {
  for (const dir of createdDirs) rmBestEffort(dir);
});

/** 建测试项目目录并登记清理（CR-16）。 */
function ensureProjectDir(name: string): string {
  const dir = path.join(getProjectsRoot(), name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function bgBucket(key: string): Map<string, number> {
  const entry = getProjectActiveRuns().get(key);
  return entry ? entry.bgSessions : new Map<string, number>();
}

/** 注册一个真实 registry 的 pending 后台任务（outcome 挂起 = running 不落终态）。 */
function seedRunningBgTask(projectPath: string, childSessionId: string): string {
  return getBgTaskRegistry().dispatchBg({
    parentSessionId: 'leader-1',
    projectPath,
    role: 'researcher',
    prompt: '长跑研究任务',
    notify: 'silent',
    start: () => ({
      childSessionId,
      outcome: new Promise(() => { /* pending forever — 测试内任务恒 running */ }),
    }),
  }).taskId;
}

/** 造一个 abort 可观察的后台任务（cancel 后 outcome 收敛 aborted——级联测试断言用）。 */
function seedCancellableBgTask(projectPath: string, childSessionId: string): { taskId: string; settled: () => boolean } {
  let settled = false;
  const taskId = getBgTaskRegistry().dispatchBg({
    parentSessionId: 'leader-1',
    projectPath,
    role: 'researcher',
    prompt: '可取消任务',
    notify: 'silent',
    start: ({ signal }) => {
      const outcome = new Promise<{ status: 'aborted' }>((resolve) => {
        signal.addEventListener('abort', () => { settled = true; resolve({ status: 'aborted' }); });
      });
      return { childSessionId, outcome };
    },
  }).taskId;
  return { taskId, settled: () => settled };
}

beforeEach(() => {
  send.mockReset();
  warn.mockClear();
  info.mockClear();
  updateSessionStatus.mockClear();
  runtimeState.sessions = [];
  // 每测前清注册表（生产只在启动空表——测试直驱各入口需复位）。
  for (const key of [...getProjectActiveRuns().keys()]) {
    (getProjectActiveRuns() as Map<string, unknown>).delete(key);
  }
  _resetBgChildBookkeepingForTest();
  getBgTaskRegistry().__clearForTest();
});

describe('W3 bg 车道闸（design §4.1 车道化）', () => {
  it('leader+bg 双车道并存：bg 在场不拦 leader 车道；leader 车道全释放后 bg-only 键保留', () => {
    const key = normalizeProjectKey(PROJ);
    const leaderGate = acquireProjectRun(PROJ, 'sess-a');
    expect(leaderGate.ok).toBe(true);

    // leader 占用项目 —— bg 车道不受 leader 互斥影响。
    const bgGate = acquireBgRun(PROJ, 'bg-child-1');
    expect(bgGate.ok).toBe(true);
    expect(bgBucket(key).get('bg-child-1')).toBe(1);

    if (leaderGate.ok) leaderGate.release();
    // leader 车道全释放但 bg 仍在 —— 键保留（lease 摘除）。
    expect(getProjectActiveRuns().get(key)).toBeDefined();
    expect(getProjectActiveRuns().get(key)!.lease).toBeNull();

    // bg-only 键在场 —— 另一 leader 会话照常获 leader 车道（车道并存核心语义）。
    const leader2 = acquireProjectRun(PROJ, 'sess-b');
    expect(leader2.ok).toBe(true);
    if (leader2.ok) leader2.release();
    expect(getProjectActiveRuns().get(key)!.lease).toBeNull();
    expect(bgBucket(key).get('bg-child-1')).toBe(1);
  });

  it('leader 车道互斥回归：leader 租约在场第二 leader 会话仍拒（bg 桶不改变互斥语义）', () => {
    const bg = acquireBgRun(PROJ, 'bg-child-1');
    expect(bg.ok).toBe(true);
    const l1 = acquireProjectRun(PROJ, 'sess-a');
    expect(l1.ok).toBe(true);
    // 第二 leader 会话 → 拒（leader 车道互斥字节级不变——既有 projectRunGate 测试零红的语义核）。
    const l2 = acquireProjectRun(PROJ, 'sess-b');
    expect(l2.ok).toBe(false);
    if (!l2.ok) {
      expect(l2.held.sessionId).toBe('sess-a');
      expect(l2.held.projectPath).toBe(PROJ);
    }
    if (l1.ok) l1.release();
    if (bg.ok) bg.release();
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('链租约同理：链租约 id 占 leader 车道时 bg 仍可入（写章链与后台子 agent 并存语义）', () => {
    const chainLeaseId = `${CHAIN_RUN_LEASE_ID}:${randomUUID()}`;
    const chainGate = acquireProjectRun(PROJ, chainLeaseId);
    expect(chainGate.ok).toBe(true);
    const bg = acquireBgRun(PROJ, 'bg-child-1');
    expect(bg.ok).toBe(true);
    // leader 车道内互斥照旧：chat 会话被链租约拒。
    const chat = acquireProjectRun(PROJ, 'sess-a');
    expect(chat.ok).toBe(false);
    if (bg.ok) bg.release();
  });

  it(`bg 超帽：第 ${MAX_BG_PER_PROJECT + 1} 个 bg 会话结构化拒绝 bg_capacity（带 runningCount/cap/projectPath）`, () => {
    for (let i = 1; i <= MAX_BG_PER_PROJECT; i++) {
      const gate = acquireBgRun(PROJ, `bg-child-${i}`);
      expect(gate.ok).toBe(true);
    }
    const over = acquireBgRun(PROJ, 'bg-child-over');
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.code).toBe('bg_capacity');
      expect(over.runningCount).toBe(MAX_BG_PER_PROJECT);
      expect(over.cap).toBe(MAX_BG_PER_PROJECT);
      expect(over.projectPath).toBe(PROJ);
    }
    // 释放一个 → 空槽可复用。
    releaseBgRun(PROJ, 'bg-child-1');
    expect(acquireBgRun(PROJ, 'bg-child-over').ok).toBe(true);
  });

  it('bg 引用计数与幂等：同 child 重入计数、句柄 release 幂等、bg-only 键随最后释放删除', () => {
    const key = normalizeProjectKey(PROJ);
    const g1 = acquireBgRun(PROJ, 'bg-child-1');
    const g2 = acquireBgRun(PROJ, 'bg-child-1');
    expect(g1.ok).toBe(true);
    expect(g2.ok).toBe(true);
    expect(bgBucket(key).get('bg-child-1')).toBe(2);
    if (g1.ok) g1.release();
    if (g1.ok) g1.release(); // 幂等：双调不二次衰减（句柄 released 旗）。
    expect(bgBucket(key).get('bg-child-1')).toBe(1);
    if (g2.ok) g2.release();
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('跨项目 bg 各自计帽（项目隔离）', () => {
    const p2 = `${getProjectsRoot().replace(/\\/g, '/')}/bg-lane-proj-2`;
    for (let i = 1; i <= MAX_BG_PER_PROJECT; i++) {
      expect(acquireBgRun(PROJ, `bg-child-${i}`).ok).toBe(true);
    }
    expect(acquireBgRun(p2, 'bg-child-1').ok).toBe(true);
    expect(acquireBgRun(PROJ, 'bg-child-over').ok).toBe(false);
  });
});

describe('W3 bg 子会话运行时事件记账（onRuntimeEvent 泵挂接面）', () => {
  it('child 车道事件 → bg 桶登记 + shell abort 控制器注册（每会话恰一次）；bg-update 终态 → 释放', () => {
    const key = normalizeProjectKey(PROJ);
    const childSid = 'bg-child-evt-1';
    runtimeState.sessions = [{ id: childSid, projectPath: PROJ, status: 'running' }];
    const childSession = { sessionRole: 'child' as const, projectPath: PROJ };

    noteBgChildRuntimeEvent(childSid, { type: 'child', data: {} }, childSession);
    expect(bgBucket(key).get(childSid)).toBe(1);
    // 重复事件不重复计数。
    noteBgChildRuntimeEvent(childSid, { type: 'child', data: {} }, childSession);
    expect(bgBucket(key).get(childSid)).toBe(1);

    // 非 child 角色的 child 事件（同步子代理冒泡进 leader 流的形态不经本泵，防御性忽略）。
    noteBgChildRuntimeEvent('leader-1', { type: 'child', data: {} }, { sessionRole: 'primary', projectPath: PROJ });
    expect(bgBucket(key).has('leader-1')).toBe(false);

    // 终态：bg-update（载荷 parent sid + data.childSessionId）→ 释放 + 键清理。
    noteBgChildRuntimeEvent(
      'leader-1',
      { type: 'bg-update', data: { childSessionId: childSid, taskId: 't1', status: 'completed' } },
      { sessionRole: 'primary', projectPath: PROJ },
    );
    expect(bgBucket(key).has(childSid)).toBe(false);
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('登记过的 bg 子会话：reconcile 不误归位（streamAbortControllers「活跃流」判据承认活体 bg 子会话）', async () => {
    const childSid = 'bg-child-live';
    runtimeState.sessions = [
      { id: childSid, projectPath: PROJ, status: 'running' },
      { id: 'stale-other', projectPath: PROJ, status: 'running' },
    ];
    listProjects.mockReturnValue([{ projectId: '1', path: PROJ } as never]);
    noteBgChildRuntimeEvent(childSid, { type: 'child', data: {} }, { sessionRole: 'child', projectPath: PROJ });

    await reconcileStaleProjectRuns();

    // 活体 bg 子会话 running 态保留；无登记的 stale 会话归位 idle。
    expect(updateSessionStatus).toHaveBeenCalledWith('stale-other', 'idle');
    expect(updateSessionStatus).not.toHaveBeenCalledWith(childSid, 'idle');
  });

  it('终态释放后：reconcile 恢复对该会话的 stale 归位 + 注册表 bg 桶清扫', async () => {
    const childSid = 'bg-child-done';
    runtimeState.sessions = [{ id: childSid, projectPath: PROJ, status: 'running' }];
    listProjects.mockReturnValue([{ projectId: '1', path: PROJ } as never]);
    noteBgChildRuntimeEvent(childSid, { type: 'child', data: {} }, { sessionRole: 'child', projectPath: PROJ });
    noteBgChildRuntimeEvent(
      'leader-1',
      { type: 'bg-update', data: { childSessionId: childSid, taskId: 't2', status: 'completed' } },
      { sessionRole: 'primary', projectPath: PROJ },
    );

    await reconcileStaleProjectRuns();

    expect(updateSessionStatus).toHaveBeenCalledWith(childSid, 'idle');
    expect(getProjectActiveRuns().size).toBe(0);
  });
});

describe('W3 重启对账：bg-tasks.json running → interrupted（design §4.2 / D6/R7）', () => {
  it('reconcileStaleProjectRuns 逐项目对账注册表：running 行改 interrupted 回写 + hydrate 可查', async () => {
    const projDir = ensureProjectDir('bg-reconcile-proj');
    const childSid = 'bg-reconcile-child';
    seedRunningBgTask(projDir, childSid);

    // 磁盘有 running 行。
    const filePath = path.join(projDir, '.orison', 'bg-tasks.json');
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).some((r: { status: string }) => r.status === 'running')).toBe(true);

    listProjects.mockReturnValue([{ projectId: '2', path: projDir } as never]);
    runtimeState.sessions = [];
    await reconcileStaleProjectRuns();

    // 磁盘行已改 interrupted（不复活不谎报 running）。
    const after = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<{ status: string; error?: string }>;
    expect(after.some((r) => r.status === 'interrupted')).toBe(true);
    expect(after.some((r) => r.status === 'running')).toBe(false);
    // hydrate 进内存——completed/failed/aborted/interrupted 行照常可查（「历史可检视」）。
    const records = getBgTaskRegistry().listByProject(projDir);
    expect(records.some((r) => r.childSessionId === childSid && r.status === 'interrupted')).toBe(true);
  });

  it('无 bg-tasks.json 的项目对账零副作用（合法「从未派发」态）', async () => {
    const projDir = ensureProjectDir('bg-empty-proj');
    listProjects.mockReturnValue([{ projectId: '3', path: projDir } as never]);
    runtimeState.sessions = [];
    await expect(reconcileStaleProjectRuns()).resolves.toBeUndefined();
    expect(existsSync(path.join(projDir, '.orison', 'bg-tasks.json'))).toBe(false);
  });
});

describe('W3 项目生命周期级联（design §2 / prd R6：项目关闭/删除 → 杀后台子 agent）', () => {
  it('cancelBgTasksForProject：abort 该项目全部 running 后台任务（能力面语义锚——shell 挂接消费同一函数）', async () => {
    const projDir = ensureProjectDir('bg-cascade-proj');
    const otherDir = ensureProjectDir('bg-cascade-other');

    const a = seedCancellableBgTask(projDir, 'bg-cascade-a');
    const b = seedCancellableBgTask(projDir, 'bg-cascade-b');
    seedCancellableBgTask(otherDir, 'bg-cascade-c'); // 他项目不受波及。

    const cancelled = cancelBgTasksForProject(projDir);
    expect(cancelled).toBe(2);
    await vi.waitFor(() => {
      expect(a.settled()).toBe(true);
      expect(b.settled()).toBe(true);
    });
    expect(getBgTaskRegistry().get(a.taskId)?.status).toBe('aborted');
    expect(getBgTaskRegistry().get(b.taskId)?.status).toBe('aborted');
  });
});

describe('CR 批（09-22）：双簿记一致性 + AC14 反向', () => {
  it('CR-15 双簿记偏差：bg-update 丢失（controller 已消失而 bg 桶残留）→ 启动对账清扫收敛', async () => {
    const childSid = 'bg-child-drift';
    runtimeState.sessions = [{ id: childSid, projectPath: PROJ, status: 'running' }];
    noteBgChildRuntimeEvent(childSid, { type: 'child', data: {} }, { sessionRole: 'child', projectPath: PROJ });
    const key = normalizeProjectKey(PROJ);
    expect(bgBucket(key).get(childSid)).toBe(1);

    // 构造偏差：终态 bg-update 在到达 shell 前丢失（agent 侧 registry 已终态、槽位已释放；
    // shell 侧 controller 生命周期面消失而 bgSessions 桶残留）——注记：bg-update 是同进程
    // onRuntimeEvent 同步回调，丢失面仅存在于 try/catch 静默分支与异常时序；偏差必经
    // reconcileStaleProjectRuns 收敛（本进程不重复收敛——对账时序在启动，进程内不重扫）。
    _unregisterBgChildControllerForTest(childSid);
    expect(bgBucket(key).get(childSid)).toBe(1); // 桶残留（泄漏态成立）。

    listProjects.mockReturnValue([{ projectId: '9', path: PROJ } as never]);
    await reconcileStaleProjectRuns();

    // 收敛：桶条目以「无 controller 登记」清扫（键删除）——偏差经 reconcile 归零。
    expect(bgBucket(key).has(childSid)).toBe(false);
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('CR-21 AC14 反向：bg 在跑时发起写章链不被拒（bg 桶与链租约并存）', () => {
    const chainLeaseId = `${CHAIN_RUN_LEASE_ID}:${randomUUID()}`;
    // bg 先占满本项目 bg 车道。
    for (let i = 1; i <= MAX_BG_PER_PROJECT; i++) {
      expect(acquireBgRun(PROJ, `bg-child-ac14-${i}`).ok).toBe(true);
    }
    // bg 满载时链车道照常获取（bg 车道不占 leader 互斥——链租约 id 走 leader 车道）。
    const chainGate = acquireProjectRun(PROJ, chainLeaseId);
    expect(chainGate.ok).toBe(true);
    // 链在跑时 leader 对话会话仍被拒（对照：leader 车道互斥未被 bg/链并存破坏）。
    const chat = acquireProjectRun(PROJ, 'chat-sess');
    expect(chat.ok).toBe(false);
  });

  it('CR-4：bg-update 到达时父会话已删（现查无 projectPath）→ 登记映射兜底释放，防 bg 桶泄漏', () => {
    const childSid = 'bg-child-orphan';
    // 登记时 session 在场（projectPath 记入映射）。
    noteBgChildRuntimeEvent(childSid, { type: 'child', data: {} }, { sessionRole: 'child', projectPath: PROJ });
    const key = normalizeProjectKey(PROJ);
    expect(bgBucket(key).get(childSid)).toBe(1);

    // 终态到达时 session 缺省（父会话已删 / 现查失败）——bg-update 无 projectPath 可反查。
    noteBgChildRuntimeEvent('leader-gone', {
      type: 'bg-update',
      data: { childSessionId: childSid, taskId: 't4', status: 'completed' },
    });
    expect(bgBucket(key).has(childSid)).toBe(false);
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('CR-3 取消钮全链：agent:abort-run(childSid) IPC handler → store 链（runtime.abortRun）触发', async () => {
    const childSid = 'bg-child-cancel';
    runtimeState.sessions = [{ id: childSid, projectPath: PROJ, status: 'running' }];
    noteBgChildRuntimeEvent(childSid, { type: 'child', data: {} }, { sessionRole: 'child', projectPath: PROJ });
    const key = normalizeProjectKey(PROJ);
    expect(bgBucket(key).get(childSid)).toBe(1);

    // 走注册面真 handler（UI 取消钮 = abortAgentRun(childSid) → 本通道）。
    const registration = handle.mock.calls.find(([c]) => c === 'agent:abort-run');
    expect(registration).toBeDefined();
    await (registration![1] as (e: unknown, sid: string) => Promise<unknown>)(undefined as never, childSid);

    // 链路核实：handler 无条件触 runtime.abortRun(sessionId)（D2 store 链——子 runLoop 的
    // 真停止通道；agent 侧「信号 → runLoop 实停 → registry 终态 aborted」已由
    // runtime.bgDispatch.test.ts 通道②覆盖）+ shell controller 循环可达（同 handler 前段
    // abort 全 Set——bg 登记的 controller 在同一注册表）。bg 桶此时仍在：释放唯一入口 =
    // bg-update 终态（取消收尾经 outcome 链发终态后释放）。
    expect(abortRun).toHaveBeenCalledWith(childSid);
    expect(bgBucket(key).get(childSid)).toBe(1);
  });
});
