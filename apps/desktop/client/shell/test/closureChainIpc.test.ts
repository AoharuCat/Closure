import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { allowPath } from '../main/ipc/pathGuard';

// Story 4.0 §4.8 / implement.md 6.3：closure:run-chapter-chain IPC handler 单测。
// mock getAgentRuntime（返 mock runtime）+ local-bff loadProject → 验：handler 组 initialArtifacts +
// 建 stub parent session + 调 runtime.runChapterChain + 返 summary。mirror closureIndexIpc.test.ts 模式。
//
// CR-7（IPC 入口 Zod 校验）/ CR-10（assertSafePath 路径守卫）：handler 入口先 safeParse 再 assertSafePath，
// 故测试 allowPath(TEST_DIR) 授权测试目录（mirror pathGuard.test.ts 模式），并加 Zod reject + 路径越界用例。

const TEST_DIR = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-closure-chain-ipc');

const { handle, runChapterChain, runAgentWithExplicitSystem, createSession, loadProject, acceptChapterCandidate, onFieldEdited, clearChainSnapshot, getChainSnapshot, getSession, acquireProjectRun, releaseProjectRun, releaseLease, error: logError, info: logInfo, warn: logWarn, notifyLeaderChainCompleted, chapterWriteHandler, reExtractChapter, deleteSession, listChapterSummaries, runtimeShape } = vi.hoisted(() => ({
  handle: vi.fn(),
  runChapterChain: vi.fn(),
  runAgentWithExplicitSystem: vi.fn(),
  createSession: vi.fn(),
  loadProject: vi.fn(),
  acceptChapterCandidate: vi.fn(),
  onFieldEdited: vi.fn(),
  clearChainSnapshot: vi.fn(),
  getChainSnapshot: vi.fn(),
  getSession: vi.fn(),
  // dogfood R2 #93 追加拍板：resume completed 终态的 leader 回注调用（fire-and-forget 断言面）。
  notifyLeaderChainCompleted: vi.fn(),
  // dogfood R2 #107 / R1.1：persistChapterAcceptIfNeeded 自动建章直调的 chapter_write handler
  // （partial mock——同模块其余 handler 保持真实现，防 toolExecution 等同图消费方断链）。
  chapterWriteHandler: vi.fn(),
  // 链流程重排 W4（R6）：re-extract-chapter 的 runtime 方法 mock + derivation-status 的
  // listChapterSummaries 读侧 mock（partial——worldStateRepository 其余导出保真实现）。
  reExtractChapter: vi.fn(),
  // 链流程重排 CR 修复批（09-13 CR-19②）：re-extract stub 会话 finally 删除的断言面。
  deleteSession: vi.fn(),
  listChapterSummaries: vi.fn(),
  // dogfood T1-S3 D4 闸 + CR 批3：默认放行（{ok:true, release}——handle 式），闸自身的
  // 行为在 projectRunGate.test.ts 单测；此处 mock 只为让 handler 的 import 可解析 +
  // 用例可覆写拒发/断言 finally 经 handle 释放（CR-T1-020 唯一租约 id / CR-T1-021 句柄）。
  acquireProjectRun: vi.fn(),
  releaseProjectRun: vi.fn(),
  releaseLease: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  // dogfood R2 #90：warn 提升为 hoisted mock（parse 失败观测断言用——旧匿名 vi.fn() 测试摸不到）。
  warn: vi.fn(),
  // dogfood R2 #90：mock runtime 形态开关——true 时 getAgentRuntime 返的对象删掉
  // runAgentWithExplicitSystem（测「旧 runtime 无此方法」的 optimizer 不可用分因；默认 false 零影响）。
  runtimeShape: { noExplicitSystem: false },
}));

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_DIR（worldStateRepository /
// projectRepository 保真实现直碰真 db，路径须留在 throwaway home）——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_DIR };
  return { ...withHome, default: withHome };
});

vi.mock('electron', () => ({
  app: { getPath: (_: string) => TEST_DIR, isPackaged: false },
  ipcMain: { handle },
}));

// mock agentIpc 的 getAgentRuntime → 返 mock runtime（runChapterChain + createSession + runAgentWithExplicitSystem
// + Story 4.3 Step 3：clearChainSnapshot + getChainSnapshot + getSession for resume-chapter-chain handler）
// runAgentWithExplicitSystem 默认返空 content（裁决器/revision-optimizer parse 失败 → graceful 降级用）。
vi.mock('../main/ipc/agentIpc', () => ({
  getAgentRuntime: () => {
    const rt: Record<string, unknown> = {
      runChapterChain,
      createSession,
      runAgentWithExplicitSystem,
      clearChainSnapshot,
      getChainSnapshot,
      getSession,
      // dogfood R2 #93：leader 回注 API（handler 的 defensive typeof 检查目标）。
      notifyLeaderChainCompleted,
      // 链流程重排 W4（R6）：链外重提取 runtime 方法（closure:re-extract-chapter 消费）。
      reExtractChapter,
      // 链流程重排 CR 修复批（09-13 CR-19②）：stub 会话 finally 删除（handler 防御式 typeof 调用）。
      deleteSession,
    };
    // #90 分因：删方法模拟旧 runtime（dispatchRevisionOptimizerForIpc 的 typeof 检查路径）。
    if (runtimeShape.noExplicitSystem) delete rt.runAgentWithExplicitSystem;
    return rt;
  },
  // T1-S3 D4 + CR 批3：闸经 hoisted mock（默认值在各 describe beforeEach 设——handle 式
  // `{ok:true, release}`；真实实现是每 invoke 唯一租约 id + 引用计账，见 agentIpc.ts）。
  acquireProjectRun,
  releaseProjectRun,
  CHAIN_RUN_LEASE_ID: 'chain-run:closure',
  // CR 修复批（09-13 CR-19①）：重提取 abort 注册线（handler 调用；测试侧 no-op 即可——
  // 真实注册语义由 agentIpc 自身测试面覆盖）。
  registerStreamAbortController: () => {},
  unregisterStreamAbortController: () => {},
}));

// mock local-bff loadProject + acceptChapterCandidate（4.1 Step 4：IPC 入口持久化经此调；dynamic import）
// + onFieldEdited（Story 2.2 CR-08-16-201：resume 终态 story-sync 消费经 storySyncApplyHandler auto 档调用）
vi.mock('@orison/desktop-local-bff', () => ({ loadProject, acceptChapterCandidate, onFieldEdited }));

// dogfood R2 #107 / R1.1：persistChapterAcceptIfNeeded 自动建章直调的 chapter_write handler——partial
// mock（importOriginal 保留同模块其余导出，防同图消费方断链；真 handler 会 touch db + BrowserWindow，
// 测试里不可直跑）。
vi.mock('../main/ipc/toolHandlers/chapterHandlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/toolHandlers/chapterHandlers')>();
  return { ...actual, chapterWriteHandler };
});

// 链流程重排 W4（R6）：derivation-status 查询的 listChapterSummaries 读侧 partial mock
//（同模块 buildWorldSnapshotCheckpointed/listWorldPatches 保真实现——run handler 的 snapshot
// fetch helpers 消费，不受影响；worldStateRepository 直碰真 db，测试不可直跑）。
vi.mock('../main/db/worldStateRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/db/worldStateRepository')>();
  return { ...actual, listChapterSummaries };
});

// W4：derivation-status「有摘要行」路径需 projectId 命中——projectRepository getProject partial mock
//（**factory 内设默认委托真实现**——既有 describe 的 snapshot fetch helpers 行为零变化；仅本文件尾部
// W4 describe 的用例内 mockReturnValue 覆写，且 W4 describe 排最后无后续泄漏面）。
const { getProjectDb } = vi.hoisted(() => ({ getProjectDb: vi.fn() }));
vi.mock('../main/db/projectRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/db/projectRepository')>();
  getProjectDb.mockImplementation((p: string) => actual.getProject(p));
  return { ...actual, getProject: getProjectDb };
});

vi.mock('../main/logger', () => ({
  getLogger: () => ({ error: logError, info: logInfo, warn: logWarn, debug: vi.fn() }),
}));

import { registerClosureChainIpc } from '../main/ipc/closureChainIpc';
import * as projectWriteLock from '../main/fs/projectWriteLock';

const DOC_FIXTURE = {
  meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
  creative_brief: { genre: '都市奇幻' },
  world_setting: { premise: '灵气复苏都市' },
  asset_cards: [
    {
      id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年',
      narrative: { storyFunction: '主角' },
      desireAndBottomline: { coreDesire: '变强' },
      personality: { coreTraits: ['坚韧'] },
    },
  ],
  scene_graph: {
    nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }],
    edges: [],
    lines: [],
  },
  // Story 6.5：foreshadow_registry → promise_registry（creative field 改名 + 泛化为读者债生命周期账本）。
  promise_registry: { promises: [], beats: [], version: 0 },
};

const SUMMARY_OK = {
  status: 'completed',
  routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
  reviewVerdict: 'pass',
  draftTitle: '第二章 B 城',
  draftWordCount: 2800,
  errors: [],
  // 4.1 Step 4：chapter_accept（onAccept 产；mock runChapterChain 直接返，绕过 onAccept 闭包）。
  chapter_accept: {
    chapterId: 'ch_001',
    candidate: { title: '第二章 B 城', content: '正文…', wordCount: 2800 },
    runId: 'run_mock',
  },
};

describe('closure:run-chapter-chain handler（Story 4.0 §4.8）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined); // 默认成功 no-op
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined); // 默认无 session → mode 兜底 suggest
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    // 子 agent（裁决器/revision-optimizer）默认返空 content（parse 失败 → graceful 降级），保持既有测试行为。
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    // T1-S3 D4 + CR 批3：每用例闸默认放行（handle 式）+ 清释放调用计数（finally 释放断言用）。
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    releaseProjectRun.mockClear();
    // CR-10：授权测试目录进 pathGuard allowedRoots（assertSafePath 否则会拒 TEST_DIR）。
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. 正常路径：loadProject → 组 artifacts → stub session → runChapterChain → summary
  // ════════════════════════════════════════════════════════════════════════════

  it('loadProject → 组四 artifact → runChapterChain → 返 summary', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    // loadProject 被调
    expect(loadProject).toHaveBeenCalledWith(TEST_DIR);

    // stub parent session 创建（dogfood 无 leader session）
    expect(createSession).toHaveBeenCalledTimes(1);
    const sessionInput = createSession.mock.calls[0][0];
    expect(sessionInput.agentName).toBe('chapter-chain-dogfood');
    expect(sessionInput.projectPath).toBe(TEST_DIR);

    // runChapterChain 被调，parentSessionId = stub session id
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [parentId, artifacts, options] = runChapterChain.mock.calls[0];
    expect(parentId).toBe('stub-parent-session-1');
    expect(options.requirement).toBe('ep1');
    // 4.1 Step 4：onAccept 闭包传入（accept 分支产 chapter_accept）
    expect(typeof options.onAccept).toBe('function');

    // 四 artifact key 齐（assembleChapterChainArtifacts 产出）
    expect(artifacts['scene_graph']).toBeDefined();
    expect(artifacts['settings_context']).toBeDefined();
    expect(artifacts['chapter_brief_input']).toEqual({ episodeId: 'ep1', brief: { goal: 'REACH_B_CITY' } });
    // Story 6.5：artifact key 改名 promise_registry（assembleChapterChainArtifacts 产出）。
    expect(artifacts['promise_registry']).toBeDefined();

    // 4.1 Step 4（CR-15b）：summary.chapter_accept → 调 acceptChapterCandidate 持久化（IPC 直接写盘）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    const [persistPath, persistChapterId, persistRunId, persistCandidate] = acceptChapterCandidate.mock.calls[0];
    expect(persistPath).toBe(TEST_DIR);
    expect(persistChapterId).toBe('ch_001');
    expect(persistRunId).toBe('run_mock');
    expect(persistCandidate).toEqual({ title: '第二章 B 城', content: '正文…', wordCount: 2800 });

    // summary 透传 + dogfood R2 #93 P0-2：direct 档直落成功置 chapterPersisted=true（UI 据此免二次 stage）。
    expect(summary).toEqual({ ...SUMMARY_OK, chapterPersisted: true });

    // T1-S3 D4 + CR-T1-020：闸经 acquire（每 invoke 唯一租约 id `chain-run:closure:<uuid>`），
    // 成功路径 finally 经 handle.release 释放（CR-T1-021 句柄式——不再按 sessionId 二次释放）。
    expect(acquireProjectRun).toHaveBeenCalledWith(TEST_DIR, expect.stringMatching(/^chain-run:closure:/));
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1b. T1-S3 D4 同项目单 run 闸：拒发结构化 summary（机器可读前缀）+ 不跑链；throw 路径 finally 仍释放
  // （闸自身的注册/对账/归一行为在 projectRunGate.test.ts 单测——此处只钉 handler 集成面）
  // ════════════════════════════════════════════════════════════════════════════

  it('T1-S3 D4：同项目占用 → status=error summary 含 project_run_active|heldBy= 前缀 + 不调 loadProject/runChapterChain', async () => {
    acquireProjectRun.mockImplementation(() => ({ ok: false, held: { sessionId: 'sess-other', projectPath: TEST_DIR } }));
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    expect(summary).toMatchObject({ status: 'error' });
    expect((summary as { errors: string[] }).errors[0]).toBe(`project_run_active|heldBy=sess-other|project=${TEST_DIR}`);
    expect(loadProject).not.toHaveBeenCalled();
    expect(runChapterChain).not.toHaveBeenCalled();
    // 拒发不入闸，无租可释
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it('T1-S3 D4：runChapterChain 抛错（handler catch 路径）→ finally 仍释放闸', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('boom'));
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    expect(summary).toMatchObject({ status: 'error' });
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. CR-7：Zod 校验拒（缺 episodeId / 坏 chapterBrief 类型）→ status=error summary（不抛、不调 loadProject）
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-7：缺 episodeId → Zod safeParse 拒 → status=error summary + 不调 loadProject/runChapterChain', async () => {
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('episodeId'))).toBe(true);
    expect(loadProject).not.toHaveBeenCalled(); // Zod 拒在 loadProject 前
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('CR-7：chapterBrief 坏类型（string 非 object）→ Zod 拒 → status=error summary', async () => {
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: 'not-an-object' as unknown,
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('chapterBrief'))).toBe(true);
    expect(loadProject).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. CR-10：projectPath 越界（非 allowedRoots）→ assertSafePath 拒 → status=error summary
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-10：projectPath 越界（非 allowedRoots）→ status=error summary + 不调 loadProject', async () => {
    const handler = chainHandler();
    // 选一个确定不在 allowedRoots 的路径（系统临时目录的随机子目录，非 OrisonSpace 根下）
    const outsidePath = path.join(process.cwd(), 'definitely-not-allowed-' + Date.now());

    const summary = await handler({}, { projectPath: outsidePath, episodeId: 'ep1' });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('projectPath rejected'))).toBe(true);
    expect(loadProject).not.toHaveBeenCalled(); // assertSafePath 在 loadProject 前
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. loadProject 返 null（corrupt/missing）→ status=error summary
  // ════════════════════════════════════════════════════════════════════════════

  it('loadProject 返 null → status=error summary + 不调 runChapterChain', async () => {
    loadProject.mockReturnValue(null);
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1' });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors[0]).toContain('could not be loaded');
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. runChapterChain 抛错 → status=error summary（不抛 IPC rejection）
  // ════════════════════════════════════════════════════════════════════════════

  it('runChapterChain 抛错 → status=error summary（handler catch）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('LLM provider timeout'));
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'REACH_B_CITY' },
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors[0]).toContain('LLM provider timeout');
    expect(logError).toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. 4.1 §3.2 readiness gate：non-ready brief → status=error summary（不调 runChapterChain）
  // ════════════════════════════════════════════════════════════════════════════

  it('4.1 gate：brief 缺 goal → status=error summary 含 needs_world_context（不调 runChapterChain）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      // chapterBrief 缺 → goal 空 → needs_world_context
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('needs_world_context'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('4.1 gate：scene_graph 空且无设定 → status=error summary 含 needs_plot（判定序：plot 优先）', async () => {
    const emptyDoc = {
      meta: DOC_FIXTURE.meta,
      scene_graph: { nodes: [], edges: [], lines: [] },
    };
    loadProject.mockReturnValue(emptyDoc);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      episodeId: 'ep1',
      chapterBrief: { goal: 'g' },
    });

    expect((summary as { status: string }).status).toBe('error');
    expect((summary as { errors: string[] }).errors.some((e) => e.includes('needs_plot'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. 4.1 Step 4（CR-15b）：accept 持久化路径
  // ════════════════════════════════════════════════════════════════════════════

  it('4.1 Step 4：chapter_accept 含 storyDecisions → acceptChapterCandidate 第 5 参传 storyDecisions', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    const decision = {
      id: 'accept-run_d', summary: '偏离', reason: '角色硬气', alternatives: [],
      risk: '须校正', status: 'decided' as const, source: 'accept_as_truth' as const,
      relatedEpisodeId: 'ep1', createdAt: '2026-08-01T00:00:00.000Z',
    };
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文' }, runId: 'run_d', storyDecisions: [decision] },
    });
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    const persistCall = acceptChapterCandidate.mock.calls[0];
    const storyDecisionsArg = persistCall?.[4];
    expect(storyDecisionsArg).toEqual([decision]);
  });

  it('4.1 Step 4：route=accept 但 chapter_accept 缺省（映射失败）→ 不调 acceptChapterCandidate + errors 告知章未注册', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      errors: [],
      // chapter_accept 缺省
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(summary.errors.some((e) => e.includes('章未在 project.yaml 注册'))).toBe(true);
  });

  it('4.1 Step 4：route=escalate_user → 不调 acceptChapterCandidate（escalate 不持久化）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      errors: [],
    });
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    expect(acceptChapterCandidate).not.toHaveBeenCalled();
  });

  it('Story 4.6 D4：route=escalate_user 有 chapter_accept（chain D4 产候选）+ findings → IPC 仍不落盘（dogfood 无裁决 UI）+ summary 返 findings', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      draftText: '正文……',
      escalateFindings: [
        { severity: 'block', quote: '硬气', location: '段1', explanation: 'OOC 嫌疑' },
      ],
      // D4：chain 在 escalate 有 draft 时产 chapter_accept（候选载荷，PatchReview 作裁决 UI——但 dogfood IPC 无 UI）
      chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文' }, runId: 'run_esc' },
      errors: [],
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { escalateFindings?: unknown[] };

    // IPC 不落盘 chapter_accept（dogfood 无裁决 UI；裁决器仅 leader write_chapter 路径派）
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    // escalateFindings 在 summary 返回（供调用方/测试断言）
    expect(summary.escalateFindings).toHaveLength(1);
  });

  it('4.1 Step 4：acceptChapterCandidate 抛错 → summary 附加 persist failed error（不吞错）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    acceptChapterCandidate.mockImplementation(() => { throw new Error('disk full'); });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    expect(summary.errors.some((e) => e.includes('chapter persist failed') && e.includes('disk full'))).toBe(true);
    expect(logError).toHaveBeenCalled();
  });

  it('4.1 Step 4：chapterId 直传 → onAccept 闭包用 directChapterId（绕过映射）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    // mock runChapterChain 调 options.onAccept（模拟链段 accept），验 directChapterId 进 chapter_accept
    runChapterChain.mockImplementation(async (_sid: string, _arts: unknown, opts: { onAccept?: (s: unknown, c: { nowISO: string }) => unknown }) => {
      const ca = opts.onAccept?.(
        { runId: 'run_direct', artifacts: { 'draft.initial': { text: '正文' }, 'route_decision': { decision: 'accept_as_truth' } } },
        { nowISO: '2026-08-01T00:00:00.000Z' },
      );
      return { status: 'completed', routeDecision: { decision: 'accept_as_truth', reason: '通过' }, errors: [], chapter_accept: ca as { chapterId: string } };
    });
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterId: 'ch_direct', chapterBrief: { goal: 'g' } });

    const persistChapterId = acceptChapterCandidate.mock.calls[0]?.[1];
    expect(persistChapterId).toBe('ch_direct');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. CR-4.1-03：acceptChapterCandidate 经 withProjectLock 串行化（防 dogfood 链 + 工作台 accept 并发丢更新）
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-4.1-03：chapter_accept 持久化经 withProjectLock（与 field:apply-agent-patch 同锁协调）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    // spy 不改真实行为（withProjectLock passthrough），仅观测是否被调用 + projectPath 入参。
    const lockSpy = vi.spyOn(projectWriteLock, 'withProjectLock');
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    // withProjectLock 被调，且第一参 = projectPath（与 field:apply-agent-patch / field:sync 共享 projectDir 键）。
    expect(lockSpy).toHaveBeenCalled();
    const lockCall = lockSpy.mock.calls.find(([dir]) => dir === TEST_DIR);
    expect(lockCall).toBeTruthy();
    // 第二参是 op 回调；执行它应触发 acceptChapterCandidate（验证锁包的是持久化调用）。
    const op = lockCall![1] as () => unknown;
    acceptChapterCandidate.mockClear();
    op();
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    lockSpy.mockRestore();
  });

  it('CR-4.1-03：route=escalate_user（无 chapter_accept）→ withProjectLock 不被持久化路径触发', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
      errors: [],
    });
    const lockSpy = vi.spyOn(projectWriteLock, 'withProjectLock');
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    // 非持久化路径不应触发 withProjectLock（accept 未发生）。
    expect(lockSpy).not.toHaveBeenCalled();
    lockSpy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 8.4 A10（design §1.8）：#9 建议读取退役回归（IPC 入口）。
// 验：ready run 零 retrieval-agent 派发 + chapter_brief_input.brief 原样直通（无 #9 合并）；
//     gate-first 保留——brief 未就绪零子 agent 派发 + 不跑链段。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain handler 无 #9 路径（Story 8.4 A10）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('ready run → 零 retrieval-agent 派发 + chapter_brief_input.brief 原样直通（无 suggestedReads）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runAgentWithExplicitSystem.mockResolvedValue({ content: '{}' });
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    // retrieval-agent 零派发（#9 退役——写手自查取代，资料员走 writer 节点内子循环非本入口）
    const retrievalCalls = runAgentWithExplicitSystem.mock.calls.filter((c) => c[1] === 'retrieval-agent');
    expect(retrievalCalls).toHaveLength(0);
    // 链段照跑
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    // chapter_brief_input.brief = IPC 传入 brief 原样（无 #9 合并步骤）
    const [, artifacts] = runChapterChain.mock.calls[0];
    const briefInput = artifacts['chapter_brief_input'] as { brief: Record<string, unknown> };
    expect(briefInput.brief.goal).toBe('g');
    expect('suggestedReads' in briefInput.brief).toBe(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // P1（BMad CR Blind+Edge medium）：gate-first 顺序回归。
  // 子 agent 派发是多步 LLM 调用，non-ready brief 时 gate 阻断会把派发结果整个弃掉，白烧算力。
  // 故 gate 须在派发之前——brief 未就绪时不派任何子 agent。readiness 只看结构信号，gate-first 安全。
  // ════════════════════════════════════════════════════════════════════════════

  it('P1 gate-first：brief 未就绪（缺 goal → needs_world_context）→ 零子 agent 派发 + 不跑链段', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runAgentWithExplicitSystem.mockResolvedValue({ content: '{}' });
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    // 缺 chapterBrief → 缺 goal → needs_world_context（DOC_FIXTURE 有 scene_graph 1 node + settings 非空）
    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('needs_world_context'))).toBe(true);
    // 子 agent 零派发（gate 在前）
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled();
    // 链段不跑
    expect(runChapterChain).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.3 Step 3：closure:run-chapter-chain mode wiring + closure:resume-chapter-chain handler。
// 验：(a) run-chapter-chain 传 mode（deriveCheckpointPolicy from stub parent permissionMode）；
//     (b) 两入口 mode 一致（run + resume 都 derive from session.permissionMode）；
//     (c) resume continue → runChapterChain 收 resume+mode；
//     (d) resume redo → runChapterChain 收 redo:{nodeId:'draft-writer-agent', feedback}；
//     (e) resume abort → clearChainSnapshot + 不跑链段 + 返 aborted；
//     (f) Zod 校验 + 路径守卫。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain mode wiring + closure:resume-chapter-chain（Story 4.3 Step 3）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'suggest' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('run-chapter-chain 传 mode（deriveCheckpointPolicy from stub parent permissionMode=suggest → pauseStages=["final"]，链流程重排 W2）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    const options = runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[]; escalateMode: string } };
    // stub parent permissionMode='suggest'（createSession mockReturnValue）→ deriveCheckpointPolicy
    expect(options.mode).toBeDefined();
    expect(options.mode!.pauseStages).toEqual(['final']);
    expect(options.mode!.escalateMode).toBe('ask');
  });

  it('两入口一致：run + resume 都从 session.permissionMode 推 mode（同 deriveCheckpointPolicy）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    // session.permissionMode='readonly' → 两入口都应得 pauseStages=['brief','draft','verdict']
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'readonly' });
    getSession.mockReturnValue({ permissionMode: 'readonly' });

    const runH = chainHandler();
    await runH({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });
    const runMode = (runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[] } }).mode;

    runChapterChain.mockClear();
    const resumeH = resumeHandler();
    await resumeH({}, { projectPath: TEST_DIR, sessionId: 'stub-parent-session-1', action: 'continue' });
    const resumeMode = (runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[] } }).mode;

    expect(runMode!.pauseStages).toEqual(['brief', 'final']);
    expect(resumeMode!.pauseStages).toEqual(['brief', 'final']);
  });

  it('resume continue → runChapterChain 收 resume.fromSnapshot=true + mode（不传 redo）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' });

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [parentId, initialArtifacts, options] = runChapterChain.mock.calls[0];
    expect(parentId).toBe('sess-1');
    // resume 用 snapshot artifacts，caller 传 {} （runChapterChain 内 resumeArtifacts ?? initialArtifacts）
    expect(initialArtifacts).toEqual({});
    expect(options.resume).toEqual({ fromSnapshot: true });
    expect(options.redo).toBeUndefined();
    expect(options.mode).toBeDefined();
    // onAccept 闭包传入（resume-accept 持久化用）
    expect(typeof options.onAccept).toBe('function');
  });

  // ── 链流程重排 W2（R3 终稿 checkpoint / R4c 落盘拆两步）：终稿 accept 的 F1a 立即落正文 ──

  /** 终稿 pause 快照（route-agent 停 + route accept + draft.initial 在、无 chapter_accept——W2 onAccept 移 E 段完成后）。 */
  const FINAL_PAUSE_SNAPSHOT = {
    runId: 'r-final',
    status: 'paused',
    currentNodeId: 'route-agent',
    projectPath: TEST_DIR,
    completedNodes: ['brief-compiler-node', 'brief-reviewer-node', 'draft-writer-agent', 'route-agent'],
    pendingNodes: [],
    artifacts: {
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
      route_decision: { decision: 'accept_as_truth', reason: '终稿可接受' },
      'draft.initial': { title: '第二章', text: '终稿原正文', wordCount: 5 },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
  };

  /** F1a chapterId 映射可用 fixture（episode_outlines + novel.chapters ch_001 命中）。 */
  const DOC_FIXTURE_WITH_CHAPTERS = {
    ...DOC_FIXTURE,
    episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    novel: { chapters: [{ id: 'ch_001', sort_order: 0, title: '第一章', sections: [{ content_file: 'chapters/ch_001.md' }] }] },
  };

  it('W2 终稿 accept + editedDraft → F1a 立即落正文（候选=改后全文 + wordCount 重算）+ resume 腿携 editedDraft + post-persist 跳过（单次落盘）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE_WITH_CHAPTERS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue(FINAL_PAUSE_SNAPSHOT);
    const handler = resumeHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'accept',
      editedDraft: '手改 后 的 终稿正文',
    }) as { chapterPersisted?: boolean };

    // F1a：acceptChapterCandidate 恰一次（post-persist 跳过——防双写 + StoryDecision 双登记）。
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    const [f1aPath, f1aChapterId, , f1aCandidate] = acceptChapterCandidate.mock.calls[0];
    expect(f1aPath).toBe(TEST_DIR);
    expect(f1aChapterId).toBe('ch_001');
    // 候选正文 = editedDraft 覆写后全文（applyEditedDraft 单源）+ wordCount 机械重算（非空白字符口径）。
    expect(f1aCandidate.content).toBe('手改 后 的 终稿正文');
    expect(f1aCandidate.wordCount).toBe('手改 后 的 终稿正文'.replace(/\s+/g, '').length);
    // resume 续跑腿携 editedDraft（E 段对改后正文提取）。
    const options = runChapterChain.mock.calls[0][2] as { resume?: { fromSnapshot?: boolean; editedDraft?: string } };
    expect(options.resume).toEqual({ fromSnapshot: true, editedDraft: '手改 后 的 终稿正文' });
    // chapterPersisted 告知 UI（F1a 已落）。
    expect(summary.chapterPersisted).toBe(true);
  });

  it('W2 终稿 accept 无 editedDraft → F1a 落快照正文原样（零手改零回归）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE_WITH_CHAPTERS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue(FINAL_PAUSE_SNAPSHOT);
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'accept' });

    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    const [, , , candidate] = acceptChapterCandidate.mock.calls[0];
    expect(candidate.content).toBe('终稿原正文');
    const options = runChapterChain.mock.calls[0][2] as { resume?: { editedDraft?: string } };
    expect(options.resume?.editedDraft).toBeUndefined();
  });

  it('W2 F1a 落盘异常（acceptChapterCandidate throw）→ graceful 跳过 F1a 走 post-persist 兜底（正文仍落）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE_WITH_CHAPTERS);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue(FINAL_PAUSE_SNAPSHOT);
    // 首调（F1a）抛异常 → catch 跳过；resume 腿后 post-persist 兜底再调一次（成功）。
    acceptChapterCandidate.mockRejectedValueOnce(new Error('disk locked'));
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'accept' }) as { chapterPersisted?: boolean };

    // 两次调用 = F1a 尝试（失败）+ post-persist 兜底（成功——正文仍落盘，graceful 不丢稿）。
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(2);
    expect(summary.chapterPersisted).toBe(true);
  });

  it('resume redo → runChapterChain 收 redo:{nodeId:"draft-writer-agent", feedback} + resume + mode', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'redo',
      feedback: '请加强紧张感',
    });

    const options = runChapterChain.mock.calls[0][2] as {
      resume?: { fromSnapshot?: boolean; redoFrom?: string };
      redo?: { nodeId: string; feedback?: string };
      mode?: unknown;
    };
    expect(options.resume).toEqual({ fromSnapshot: true, redoFrom: 'draft-writer-agent' });
    expect(options.redo).toEqual({ nodeId: 'draft-writer-agent', feedback: '请加强紧张感' });
    expect(options.mode).toBeDefined();
  });

  it('resume redo 无 feedback → redo.nodeId 传，feedback 缺省（redo directive 仍生效重跑）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'redo' });

    const options = runChapterChain.mock.calls[0][2] as { redo?: { nodeId: string; feedback?: string } };
    expect(options.redo).toEqual({ nodeId: 'draft-writer-agent' });
    expect(options.redo!.feedback).toBeUndefined();
  });

  it('Story 7.2 art-mode：resume redo + guardOverride → redo.nodeId=revision-guard-agent + guardOverride 透传', async () => {
    // soft-violation pause 后作者「强行放行」：redo 重跑 revision-guard（它在 completedNodes），guardOverride
    // 注入 revision_guard_override → guard force-accept splice。redo.nodeId = revision-guard-agent（非 draft-writer）。
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      completedNodes: ['revision-guard-agent'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'redo',
      guardOverride: 'force-accept',
    });

    const options = runChapterChain.mock.calls[0][2] as {
      redo?: { nodeId: string; guardOverride?: string };
    };
    expect(options.redo).toEqual({ nodeId: 'revision-guard-agent', guardOverride: 'force-accept' });
  });

  it('resume abort → clearChainSnapshot 调 + 不跑链段 + 返 status=aborted', async () => {
    clearChainSnapshot.mockReturnValue(true);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'abort' }) as { status: string; errors: string[] };

    expect(clearChainSnapshot).toHaveBeenCalledWith('sess-1');
    expect(runChapterChain).not.toHaveBeenCalled();
    expect(summary.status).toBe('aborted');
  });

  it('resume abort 无既有 chainSnapshot → clearChainSnapshot 返 false + errors 告知', async () => {
    clearChainSnapshot.mockReturnValue(false);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'abort' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('aborted');
    expect(summary.errors.some((e) => e.includes('no paused chain'))).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CR-005（Edge+Blind major）：resume continue/redo 缺 chainSnapshot → 返明确 error
  // （不调 runChapterChain({})——空 initialArtifacts 致 brief-compiler requiredArtifactKeys 缺 →
  // status='blocked' 非 AC7 宣称的「从头跑」）。snapshot 缺/形态错两路径都覆盖。abort 既有处理不变。
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-005：resume continue 缺 chainSnapshot（getChainSnapshot 返 undefined）→ status=error + 不调 runChapterChain', async () => {
    getChainSnapshot.mockReturnValue(undefined);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('no paused chain to resume'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('CR-005：resume redo 缺 chainSnapshot → status=error + 不调 runChapterChain（redo 同需前置 snapshot）', async () => {
    getChainSnapshot.mockReturnValue(undefined);
    const handler = resumeHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'redo',
      feedback: '改',
    }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('no paused chain to resume'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('CR-005：resume continue snapshot 形态错（缺 completedNodes）→ status=error + 不调 runChapterChain', async () => {
    // 形态错：有 artifacts 但无 completedNodes（非数组）→ runChapterChain 内部会降级 from-head，IPC 层应先拦。
    getChainSnapshot.mockReturnValue({
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('no paused chain to resume'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('resume Zod 拒（缺 sessionId）→ status=error summary + 不调 runChapterChain/clearChainSnapshot', async () => {
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('sessionId'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
    expect(clearChainSnapshot).not.toHaveBeenCalled();
  });

  it('resume Zod 拒（坏 action）→ status=error summary', async () => {
    const handler = resumeHandler();

    const summary = await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      action: 'bogus',
    }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('action'))).toBe(true);
  });

  it('resume projectPath 越界 → assertSafePath 拒 → status=error summary', async () => {
    const handler = resumeHandler();
    const outsidePath = path.join(process.cwd(), 'definitely-not-allowed-resume-' + Date.now());

    const summary = await handler({}, { projectPath: outsidePath, sessionId: 'sess-1', action: 'continue' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('projectPath rejected'))).toBe(true);
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('resume continue 续跑返 paused summary（再次 pause）→ 透传（不持久化，无 chapter_accept）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'paused',
      pausedStage: 'verdict',
      errors: [],
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'continue' }) as { status: string; pausedStage?: string };

    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('verdict');
    // paused 无 chapter_accept → 不调 acceptChapterCandidate
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // dogfood R2 #93（P0-2，2026-08-28）：resume 终态 chapter_accept 落盘语义按会话档位分派——
  // suggest/readonly（leader 会话）不直落，envelope 返 UI 进 pendingPatch 人审（mirror write_chapter
  // metadata field_patch 路径）；auto（dogfood stub）保留直落 + chapterPersisted 标记。
  // ════════════════════════════════════════════════════════════════════════════

  /** #93 P0-2 用 fixture：clone 且**剥除 chapterPersisted**——direct 档用例经 handler mutate 共享
   * SUMMARY_OK（flag 粘在 fixture 上），不剥会随 spread 带进 review 档断言串测。 */
  function cleanAcceptSummary(): Record<string, unknown> {
    const { chapterPersisted: _polluted, ...rest } = SUMMARY_OK as Record<string, unknown> & { chapterPersisted?: true };
    void _polluted;
    return { ...rest, chapter_accept: { ...(SUMMARY_OK.chapter_accept as Record<string, unknown>) } };
  }

  it('#93 P0-2：resume 终态 accept + suggest 档（leader 会话）→ 不直落，envelope 返 UI 人审（chapterPersisted 缺省 + 零 degrade 文案）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-suggest', action: 'continue' }) as {
      chapter_accept?: unknown;
      chapterPersisted?: true;
      errors: string[];
    };

    // review 档：不直落（UI pendingPatch accept 后经既有 acceptChapterCandidateCore 收口）。
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    // envelope 仍在 summary（UI stage pendingPatch 的数据源）+ 未落盘标记缺省。
    expect(summary.chapter_accept).toBeDefined();
    expect(summary.chapterPersisted).toBeUndefined();
    // review 档不加「dogfood IPC 无裁决 UI」degrade 文案（UI PatchReview 就是裁决面）。
    expect(summary.errors.some((e) => e.includes('未落盘'))).toBe(false);
  });

  it('#93 P0-2：resume 终态 accept + auto 档（dogfood stub）→ 直落保留 + chapterPersisted=true（UI 免双 stage）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'auto' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-auto', action: 'continue' }) as {
      chapterPersisted?: true;
    };

    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.chapterPersisted).toBe(true);
  });

  it('#93 P0-2 check 补：dogfood stub 会话（agentName=chapter-chain-dogfood）+ suggest 档 → 仍 direct 直落（链卡 resume 钮无 envelope 消费面，review 档= 症状①换道复发）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    // run 入口手输 autonomy='suggest' 建的 stub 会话——链卡 resume 钮（CR-T1-048）走得到的 lane。
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'chapter-chain-dogfood' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-stub-suggest', action: 'continue' }) as {
      chapterPersisted?: true;
    };

    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.chapterPersisted).toBe(true);
  });

  it('#93 P0-2：resume 终态 accept 但无 chapter_accept（章映射失败）→ errors 附 skipReason 文案（review 档也告知，UI toast 消费）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: 'r' },
      errors: [],
    });
    getSession.mockReturnValue({ permissionMode: 'suggest' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-skip', action: 'continue' }) as {
      chapter_accept?: unknown;
      errors: string[];
    };

    expect(summary.chapter_accept).toBeUndefined();
    expect(summary.errors.some((e) => e.includes('accept 未持久化'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood R2 #93 追加拍板（2026-08-28）：resume 续链完成 → 链完成事件回注 leader。
// completed 终态 + leader 会话（非 dogfood stub）→ fire-and-forget 调
// runtime.notifyLeaderChainCompleted（失败不影响既有完成路径——resume summary 照常返 UI）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:resume-chapter-chain 链完成回注 leader（dogfood R2 #93）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    notifyLeaderChainCompleted.mockReset();
    // 默认 settled promise（fire-and-forget 的 Promise.resolve 包裹吃到任何返回形态）。
    notifyLeaderChainCompleted.mockResolvedValue(true);
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    allowPath(TEST_DIR);
  });

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function snapFixture() {
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
  }

  /** #93 P0-2 同款：clone 且剥除 chapterPersisted 污染。 */
  function cleanAcceptSummary(): Record<string, unknown> {
    const { chapterPersisted: _polluted, ...rest } = SUMMARY_OK as Record<string, unknown> & { chapterPersisted?: true };
    void _polluted;
    return { ...rest, chapter_accept: { ...(SUMMARY_OK.chapter_accept as Record<string, unknown>) } };
  }

  it('completed + leader 会话（suggest/review 档）→ 回注一次，payload 投影 summary（envelope 待审标记）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-1', action: 'continue' });

    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    const [notifySessionId, payload] = notifyLeaderChainCompleted.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(notifySessionId).toBe('sess-notify-1');
    expect(payload.runId).toBe('run_mock'); // chapter_accept.runId（稳定 run 标识）
    expect(payload.chapterTitle).toBe('第二章 B 城');
    expect(payload.chapterId).toBe('ch_001');
    expect(payload.wordCount).toBe(2800);
    expect(payload.routeDecision).toBe('accept_as_truth');
    expect(payload.routeReason).toBe('正文升级');
    expect(payload.reviewVerdict).toBe('pass');
    // review 档：envelope 在但未落盘 → 待人审标记（chapterPersisted 缺省）。
    expect(payload.acceptPendingReview).toBe(true);
    expect(payload.chapterPersisted).toBeUndefined();
  });

  it('completed + auto 档 leader 会话 → 直落后 payload.chapterPersisted=true；chapterId 直传优先', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'auto', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-2', action: 'continue', chapterId: 'ch_direct' });

    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    const payload = notifyLeaderChainCompleted.mock.calls[0][1] as Record<string, unknown>;
    // auto 档 handler 直落成功置 chapterPersisted（#93 P0-2）→ payload 如实携带。
    expect(payload.chapterPersisted).toBe(true);
    expect(payload.acceptPendingReview).toBeUndefined();
    // input chapterId 直传优先于 chapter_accept.chapterId。
    expect(payload.chapterId).toBe('ch_direct');
  });

  it('dogfood stub 会话（agentName=chapter-chain-dogfood）→ 不回注（无 leader 对话消费面）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'chapter-chain-dogfood' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-stub-notify', action: 'continue' });

    expect(notifyLeaderChainCompleted).not.toHaveBeenCalled();
  });

  it('非 completed 终态（再次 paused）→ 不回注（下一轮 resume 完成时才回注）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({ status: 'paused', pausedStage: 'draft', errors: [] });
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-paused-notify', action: 'continue' });

    expect(notifyLeaderChainCompleted).not.toHaveBeenCalled();
  });

  it('回注 payload 的 runId 回退：无 chapter_accept / storySync → 本次唯一 uuid（幂等守卫降级不炸）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: 'r' },
      errors: [],
    });
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-fallback', action: 'continue' });

    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    const payload = notifyLeaderChainCompleted.mock.calls[0][1] as { runId: string; errors?: string[] };
    expect(typeof payload.runId).toBe('string');
    expect(payload.runId.length).toBeGreaterThan(0);
    // escalate 无候选 review 档 → errors 转达（leader 汇报如实）。
    expect(payload.errors).toBeDefined();
  });

  it('回注调用失败（rejected）→ fire-and-forget 隔离：handler 照常返 completed summary', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(cleanAcceptSummary());
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    snapFixture();
    notifyLeaderChainCompleted.mockReset();
    notifyLeaderChainCompleted.mockRejectedValue(new Error('leader busy'));
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-notify-boom', action: 'continue' });

    // 失败不影响既有完成路径（summary 照常返回；error 哨兵不发）。
    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    expect((summary as { status: string }).status).toBe('completed');
    expect(logError).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.3 Step 6：closure:run-chapter-chain / resume-chapter-chain escalate mode-gating
// （auto-trust vs ask，design §3.8）。两入口一致（mirror write_chapter agent 路径）。
// auto-trust（全自动）→ 派裁决器 + 采信 recommendation（accept=落盘 / revise=redo / parse失败=degrade 不假 pass）。
// ask（半自动/微操）→ 4.6 既有 IPC 路径（不派裁决器，degrade 不落盘）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure-chain-ipc escalate mode-gating（Story 4.3 Step 6）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    // auto-trust 默认：stub parent permissionMode='auto' → escalateMode='auto-trust'
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'auto' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  const ESCALATE_SUMMARY = {
    status: 'completed',
    routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
    draftText: '正文内容……',
    escalateFindings: [
      { severity: 'block', quote: '林动突然硬气', location: '段1句2', explanation: 'OOC 嫌疑' },
    ],
    chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文…' }, runId: 'run_esc' },
    errors: [],
  };

  /** role-based mock：adjudicator 返 adjudication JSON。 */
  function mockAdjudicator(recommendation: 'accept' | 'revise'): void {
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'adjudicator-agent') {
        return {
          content: JSON.stringify({
            analysis: '硬气是角色弧推进',
            recommendation,
            recommendationReason: recommendation === 'accept' ? '倾向接受' : '倾向改稿',
            options: [
              { label: '改稿', reason: '破坏一致性' },
              { label: '接受为真相', reason: '角色弧推进' },
            ],
          }),
        };
      }
      return { content: '' };
    });
  }

  it('auto-trust + recommendation=accept → acceptChapterCandidate 落盘（复用 4.6 accept 路径真持久化）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { status: string; errors: string[] };

    // auto-trust accept → chapter_accept 真落盘（区别于 4.6 ask 模式 escalate 不落盘）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    const [persistPath, persistChapterId] = acceptChapterCandidate.mock.calls[0];
    expect(persistPath).toBe(TEST_DIR);
    expect(persistChapterId).toBe('ch_001');
    // 不含 escalate degrade 文案（auto-trust 复用 accept 路径，非 dogfood 无裁决 degrade）
    expect(summary.errors.some((e) => e.includes('chapter_accept 候选未落盘'))).toBe(false);
    // runChapterChain 只调一次（accept 不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('auto-trust + recommendation=revise → 触发改稿重跑（runChapterChain 二次调，resume+redo+feedback）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain
      .mockResolvedValueOnce(ESCALATE_SUMMARY)
      .mockResolvedValueOnce({
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '改稿后通过' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '改后正文…' }, runId: 'run_redo' },
        errors: [],
      });
    mockAdjudicator('revise');
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { status: string };

    // runChapterChain 二次调（redo，mirror write_chapter agent revise 路径）
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const redoOpts = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean };
      redo?: { nodeId: string; feedback?: string };
    };
    expect(redoOpts.resume?.fromSnapshot).toBe(true);
    expect(redoOpts.redo?.nodeId).toBe('draft-writer-agent');
    expect(redoOpts.redo?.feedback).toBe('硬气是角色弧推进'); // adjudication.analysis 作 feedback
    // redo 后 accept → acceptChapterCandidate 落盘（redo summary chapter_accept）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('completed');
  });

  it('W1a escalate-pause（status=paused）+ auto-trust accept → resume 链内继续（E 段跑，resume 二次调无 redo）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    // 链重排 W1a 形态：route escalate → 链内暂停（E 段未跑、快照未清），summary.status='paused'。
    const PAUSED_ESCALATE_SUMMARY = {
      ...ESCALATE_SUMMARY,
      status: 'paused',
      chapter_accept: undefined,
      errors: [],
    };
    runChapterChain
      .mockResolvedValueOnce(PAUSED_ESCALATE_SUMMARY)
      .mockResolvedValueOnce({
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '裁决采信' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文…' }, runId: 'run_resume' },
        errors: [],
      });
    mockAdjudicator('accept');
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { status: string };

    // accept 在暂停形态下 = resume 链内继续（非直接采信落盘）：二次调 runChapterChain，
    // resume.fromSnapshot 且无 redo（redo 是 revise 分支）。
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const resumeOpts = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean; redoFrom?: string };
      redo?: { nodeId: string };
    };
    expect(resumeOpts.resume?.fromSnapshot).toBe(true);
    expect(resumeOpts.redo).toBeUndefined();
    // 落盘走 resume 完成后的 chapter_accept（完成时 onAccept 补产候选）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('completed');
  });

  it('W1a escalate-pause + auto-trust accept 但 resume 失败 → degrade（链保持暂停，不假 pass 不落盘）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain
      .mockResolvedValueOnce({ ...ESCALATE_SUMMARY, status: 'paused', chapter_accept: undefined, errors: [] })
      .mockRejectedValueOnce(new Error('resume boom'));
    mockAdjudicator('accept');
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { status: string; errors: string[] };

    expect(runChapterChain).toHaveBeenCalledTimes(2);
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(summary.status).toBe('paused');
  });

  it('auto-trust + 裁决器 parse 失败 → degrade 不落盘（不假 pass，degrade 4.6 路径）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    // adjudicator 返无法 parse 的内容（parseAdjudication → null）
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'adjudicator-agent') return { content: ' 无法 parse 的裁决器内容 ' };
      return { content: '' };
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    // parse 失败 → 不 auto-trust，不落盘（degrade 4.6 路径，**不假 pass**）
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    // degrade 文案（dogfood 无裁决 UI）
    expect(summary.errors.some((e) => e.includes('chapter_accept 候选未落盘'))).toBe(true);
    // runChapterChain 只调一次（parse 失败不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('ask 模式（suggest）+ escalate → 4.6 既有 IPC 路径不动（不派裁决器，不落盘，degrade 文案）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    // ask 模式：stub parent permissionMode='suggest'
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'suggest' });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    // ask 模式：不派裁决器（adjudicator-agent 调用次数=0，其他子 agent 亦零派发）
    const adjudicatorCall = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'adjudicator-agent');
    expect(adjudicatorCall).toBeUndefined();
    // ask 模式：escalate 不落盘（4.6 既有 degrade，dogfood 无裁决 UI）
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(summary.errors.some((e) => e.includes('chapter_accept 候选未落盘'))).toBe(true);
    // runChapterChain 只调一次（ask 模式不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('两入口一致：resume-chapter-chain auto-trust accept 也落盘（mirror run-chapter-chain）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    // resume-chapter-chain 用 sessionId 会话 permissionMode='auto'
    getSession.mockReturnValue({ permissionMode: 'auto' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-auto', action: 'continue' });

    // resume 续跑 escalate + auto-trust accept → 落盘（两入口一致，design §3.8）
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    // mode 经 resume 入口也透传 escalateMode='auto-trust'（KD1 + Step 3 wiring）
    const redoOpts = runChapterChain.mock.calls[0][2] as { mode?: { escalateMode?: string } };
    expect(redoOpts.mode?.escalateMode).toBe('auto-trust');
  });

  // ── Story 2.2 WP-E（CR-08-16-201）：resume 终态 story-sync 反哺消费 ──
  // suggest 档链段必在 draft pause → 终态提取只经 resume IPC 回落盘点；不消费 = 缺省档补丁静默丢弃。

  it('resume 终态（accept + suggest 档）→ storySync patches 转 storySyncReview 返 UI（非静默丢弃）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      storySync: {
        runId: 'run_mock',
        chapterId: 'ch_001',
        summary: '提取新规则',
        patches: [
          { field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
        ],
      },
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    getSession.mockReturnValue({ permissionMode: 'suggest' });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-suggest', action: 'continue' }) as {
      storySyncReview?: { note: string; patches: Array<{ field: string; generatedBy: string }> };
      storySyncLanded?: unknown;
    };

    // suggest 档 → 投影 envelope 组挂 summary 返 UI 路由 PatchReview（非直落、非静默丢）。
    expect(summary.storySyncLanded).toBeUndefined();
    expect(summary.storySyncReview).toBeDefined();
    // CR-08-16-010：非数字 chapterId 不套「第 N 章」模板。
    expect(summary.storySyncReview!.note).toBe('章节 ch_001 story-sync 提取');
    expect(summary.storySyncReview!.patches).toHaveLength(1);
    expect(summary.storySyncReview!.patches[0].field).toBe('world_setting');
    expect(summary.storySyncReview!.patches[0].generatedBy).toBe('story-sync-agent');
  });

  it('resume 终态（accept + auto 档）→ story_sync_apply 直落 → storySyncLanded + onFieldEdited(source=agent)', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      storySync: {
        runId: 'run_mock',
        chapterId: 'ch_001',
        summary: '提取新规则',
        patches: [
          { field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
        ],
      },
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    getSession.mockReturnValue({ permissionMode: 'auto' });
    onFieldEdited.mockClear();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-auto2', action: 'continue' }) as {
      storySyncLanded?: { note: string; fields: string[] };
      storySyncReview?: unknown;
    };

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    expect(onFieldEdited.mock.calls[0][0]).toBe(TEST_DIR);
    expect(onFieldEdited.mock.calls[0][1]).toBe('world_setting');
    expect(summary.storySyncReview).toBeUndefined();
    expect(summary.storySyncLanded?.fields).toEqual(['world_setting']);
  });

  it('resume 再 pause（下一 checkpoint）→ 不消费（等下一轮 resume 终态）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue({
      status: 'paused',
      pausedStage: 'verdict',
      errors: [],
      storySync: {
        runId: 'run_mock',
        chapterId: 'ch_001',
        summary: '提取新规则',
        patches: [
          { field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
        ],
      },
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    getSession.mockReturnValue({ permissionMode: 'readonly' });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-ro', action: 'continue' }) as {
      storySyncReview?: unknown;
      storySyncLanded?: unknown;
    };

    expect(summary.storySyncReview).toBeUndefined();
    expect(summary.storySyncLanded).toBeUndefined();
    expect(onFieldEdited).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 7.1 Route 1：closure:compile-revision-intent handler（B trigger 选区指挥精修）
// ════════════════════════════════════════════════════════════════════════════

describe('closure:compile-revision-intent handler（Story 7.1 Route 1）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    // dogfood R2 #90：warn / runtime 形态开关复位（分因观测用例间不串扰）。
    logWarn.mockReset();
    runtimeShape.noExplicitSystem = false;
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    allowPath(TEST_DIR);
  });

  function compileHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:compile-revision-intent');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  // BMad CR F2：GOOD_INTENT 不含 scope（LLM 不产 anchor）——scope.anchor 由 IPC buildSelectionAnchor 构造。
  const GOOD_INTENT = {
    change: { summary: '战斗改紧张点' },
    lockedItems: [{ field: '角色性格', authority: 'hard' as const, evidence: '别动角色性格' }],
    rationale: { source: 'user-directive' as const, note: '用户选段指挥' },
    provenance: { rawUserInstruction: '这段战斗改紧张点，别动角色性格', compilerNote: '锁定角色性格' },
  };

  it('revision-optimizer 返合法 RevisionIntent → IPC 构 scope.anchor → 返 { intent }（F2）', async () => {
    runAgentWithExplicitSystem.mockResolvedValue({ content: JSON.stringify(GOOD_INTENT) });
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '这段战斗改紧张点，别动角色性格',
      selectionFrom: 3,
      selectionTo: 8,
      draftText: '前文。战斗开始了。后文。',
    })) as { intent: { change: { summary: string }; scope?: { anchor: { quote: string; prefix: string; suffix: string; rangeHint: { from: number; to: number } } } } | null };

    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const [, role, vars, opts] = runAgentWithExplicitSystem.mock.calls[0];
    expect(role).toBe('revision-optimizer-agent');
    // allowedTools 收窄 query_story（mirror retrieval 4.5 D1-c 反向约束）。
    expect(opts?.allowedTools).toEqual(['query_story']);
    // vars 渲染 selectedPassage + userInstruction。
    expect(vars).toMatchObject({ selectedPassage: '战斗开始了', userInstruction: '这段战斗改紧张点，别动角色性格' });
    expect(result.intent).not.toBeNull();
    expect(result.intent!.change.summary).toBe('战斗改紧张点');
    // F2：IPC 纯代码构 scope.anchor（quote + prefix/suffix 切片 + rangeHint from/to）。
    expect(result.intent!.scope?.anchor.quote).toBe('战斗开始了');
    expect(result.intent!.scope?.anchor.rangeHint).toEqual({ from: 3, to: 8 });
    expect(result.intent!.scope!.anchor.prefix).toContain('前文。'); // slice(3-N, 3)
    expect(result.intent!.scope!.anchor.suffix).toContain('。后文'); // slice(8, 8+N)
  });

  // ── dogfood R2 #90：编译失败分因观测（此前三因混一句「optimizer 不可用 / dispatch 失败 / parse 失败」
  //    + parse 失败 raw 无处可查——用户实碰后无法归因）。三分因 error 文本各一测 + parse 失败 warn 落截断 raw。 ──

  it('#90：runtime 无 runAgentWithExplicitSystem 方法 → 不可用分因文案（不混三因）', async () => {
    runtimeShape.noExplicitSystem = true;
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张',
      selectionFrom: 0,
      selectionTo: 5,
      draftText: '战斗开始了。后文。',
    })) as { intent: null; error?: string };

    expect(result.intent).toBeNull();
    expect(result.error).toContain('revision-optimizer 不可用');
    // 分因文案不含另两因（不再三因混一句）
    expect(result.error).not.toContain('派发失败');
    expect(result.error).not.toContain('RevisionIntent 结构');
    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled(); // 方法缺在 dispatch 前
  });

  it('#90：runAgentWithExplicitSystem 抛错 → dispatch 失败分因文案含 err.message 摘要', async () => {
    runAgentWithExplicitSystem.mockRejectedValue(new Error('LLM provider timeout'));
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张',
      selectionFrom: 0,
      selectionTo: 5,
      draftText: '战斗开始了。后文。',
    })) as { intent: null; error?: string };

    expect(result.intent).toBeNull();
    expect(result.error).toContain('派发失败');
    expect(result.error).toContain('LLM provider timeout'); // err.message 摘要进文案
    expect(result.error).not.toContain('RevisionIntent 结构'); // 分因不混
  });

  it('#90：optimizer 返超长不合法内容 → parse 失败分因文案（指向日志）+ warn 落截断 raw + contentLength', async () => {
    // 超截断上限（2000）的不合法内容——同测「分类文案」与「raw 截断记日志」两面。
    const badContent = `无法 parse 的内容 ${'x'.repeat(2600)}`;
    runAgentWithExplicitSystem.mockResolvedValue({ content: badContent });
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张',
      selectionFrom: 0,
      selectionTo: 5,
      draftText: '战斗开始了。后文。',
    })) as { intent: null; error?: string };

    expect(result.intent).toBeNull();
    // 分因文案：输出不符合结构 + 原文长度 + 指向日志（可自诊归因）
    expect(result.error).toContain('不符合 RevisionIntent 结构');
    expect(result.error).toContain(String(badContent.length));
    expect(result.error).toContain('日志');
    expect(result.error).not.toContain('派发失败');
    // 观测面：warn 落截断 raw（≤2000 字防日志分岔）+ contentLength 全长
    expect(logWarn).toHaveBeenCalledTimes(1);
    const payload = logWarn.mock.calls[0][0] as { contentLength: number; raw: string; sessionId: string };
    expect(payload.contentLength).toBe(badContent.length);
    expect(payload.raw).toHaveLength(2000);
    expect(payload.raw.startsWith('无法 parse 的内容 ')).toBe(true); // 截的是头部（保现场）
    expect(payload.sessionId).toBe('sess-1');
  });

  it('Zod 拒（缺 selectedPassage）→ { intent: null, error 含 path }', async () => {
    const handler = compileHandler();

    const result = (await handler({}, {
      projectPath: TEST_DIR,
      sessionId: 'sess-1',
      userInstruction: '改紧张',
    })) as { intent: null; error?: string };

    expect(runAgentWithExplicitSystem).not.toHaveBeenCalled(); // schema 拒前不派发
    expect(result.intent).toBeNull();
    expect(result.error).toContain('selectedPassage');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood T1 Stage 6（design §4）：链事件透传——registerClosureChainIpc(getWin) 后
// runChapterChain options.emitChainEvent 把 chain-delta / chain-node-done 经
// agent:stream-event 广播（载荷 {...event, sessionId, projectPath}，mirror agentIpc sendEvent）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain 链事件透传（dogfood T1 Stage 6）', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'suggest' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    allowPath(TEST_DIR);
    send = vi.fn();
  });

  function chainHandlerWithWin(getWin: (() => unknown) | undefined) {
    registerClosureChainIpc(getWin as never);
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function resumeHandlerWithWin(getWin: (() => unknown) | undefined) {
    registerClosureChainIpc(getWin as never);
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('getWin 在 → emitChainEvent 经 agent:stream-event 广播（chain-delta 载荷含 sessionId=stub parent + projectPath）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    // runChapterChain mock：捕获 options.emitChainEvent 并现场发射一条 chain-delta + 一条 node-done。
    runChapterChain.mockImplementation(async (_sid: string, _art: unknown, options: { emitChainEvent?: (e: unknown) => void }) => {
      options.emitChainEvent?.({
        type: 'chain-delta',
        data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', phase: 'writing', messageId: 'm1', delta: '正文片段', seq: 0 },
      });
      options.emitChainEvent?.({ type: 'chain-node-done', data: { nodeId: 'brief-compiler-node', status: 'done' } });
      return SUMMARY_OK;
    });
    const handler = chainHandlerWithWin(() => ({ webContents: { send } }));

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });
    // #93 P0-2：run 入口 direct 档直落成功 → summary 附 chapterPersisted=true。
    expect(summary).toEqual({ ...SUMMARY_OK, chapterPersisted: true });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', phase: 'writing', messageId: 'm1', delta: '正文片段', seq: 0 },
      sessionId: 'stub-parent-session-1',
      projectPath: TEST_DIR,
    });
    expect(send).toHaveBeenLastCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: 'brief-compiler-node', status: 'done' },
      sessionId: 'stub-parent-session-1',
      projectPath: TEST_DIR,
    });
  });

  it('getWin 缺省（旧调用形态）→ runChapterChain options 不含 emitChainEvent（零事件零回归）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandlerWithWin(undefined);

    await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    const options = runChapterChain.mock.calls[0][2] as { emitChainEvent?: unknown };
    expect(options.emitChainEvent).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('窗口已关（getWin 返 null）→ 发射不抛（handler 照常返 summary，mirror agentIpc 窗口关闭守卫）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockImplementation(async (_sid: string, _art: unknown, options: { emitChainEvent?: (e: unknown) => void }) => {
      options.emitChainEvent?.({ type: 'chain-delta', data: { nodeId: 'n', role: 'r', messageId: 'm', delta: 'd', seq: 0 } });
      return SUMMARY_OK;
    });
    const handler = chainHandlerWithWin(() => null);

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });
    expect(summary).toEqual({ ...SUMMARY_OK, chapterPersisted: true }); // 不抛——守卫吞掉（#93 直落标记照置）
  });

  it('resume 入口同样透传：emitChainEvent 广播 sessionId = 输入 sessionId（redo 重跑照流）', async () => {
    // resume handler loadProject（onAccept 闭包数据）——缺 doc 会 error 早退。
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockImplementation(async (_sid: string, _art: unknown, options: { emitChainEvent?: (e: unknown) => void }) => {
      options.emitChainEvent?.({ type: 'chain-delta', data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', messageId: 'm2', delta: '改稿片段', seq: 1 } });
      return { ...SUMMARY_OK, status: 'completed' };
    });
    getChainSnapshot.mockReturnValue({
      completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'redo', feedback: '改紧张' });

    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', messageId: 'm2', delta: '改稿片段', seq: 1 },
      sessionId: 'leader-session-9',
      projectPath: TEST_DIR,
    });
  });

  // dogfood T1 check：硬 throw 路径（runChain 外围 infra 失败，非 ChainAbortedError——
  // agent 侧 runChapterChain 只对 abort 补发哨兵）无终态帧且链车道无 done 事件兜底——
  // IPC catch 必须补发 error 哨兵，否则 UI 链卡 + agentRunStates 永久挂 running
  // （isProjectRunActive 全项目闸死）。
  it('run 入口 runChapterChain 硬 throw → 返 error + 补发 error 哨兵终态帧', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('dispatch infra failure'));
    const handler = chainHandlerWithWin(() => ({ webContents: { send } }));

    const result = (await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } })) as { status: string };
    expect(result.status).toBe('error');
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: '__chain_run__', status: 'error' },
      sessionId: 'stub-parent-session-1',
      projectPath: TEST_DIR,
    });
  });

  it('resume 入口 runChapterChain 硬 throw → 同款 error 哨兵（resume 车道无 done 兜底）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockRejectedValue(new Error('resume infra failure'));
    getChainSnapshot.mockReturnValue({
      completedNodes: ['brief-compiler-node'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    const result = (await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'continue' })) as { status: string };
    expect(result.status).toBe('error');
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: '__chain_run__', status: 'error' },
      sessionId: 'leader-session-9',
      projectPath: TEST_DIR,
    });
  });

  // dogfood T1 CR-T1-052：resume abort 分支在 emitChainEvent 构造前 return——零链事件会让
  // UI 链卡停在 paused 僵尸态（finalizeChainRun 见 paused 早退，永无终态）。补发 aborted 哨兵。
  it('resume abort（确有 paused 链被清）→ 补发 aborted 哨兵终态帧（UI 链卡出 paused 僵尸态）', async () => {
    clearChainSnapshot.mockReturnValue(true);
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    const result = await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'abort' });
    expect(result).toEqual({ status: 'aborted', errors: [] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'chain-node-done',
      data: { nodeId: '__chain_run__', status: 'aborted' },
      sessionId: 'leader-session-9',
      projectPath: TEST_DIR,
    });
  });

  it('resume abort 无 paused 链（cleared=false）→ 零链事件（不误翻既有链态）', async () => {
    clearChainSnapshot.mockReturnValue(false);
    const handler = resumeHandlerWithWin(() => ({ webContents: { send } }));

    const result = (await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-session-9', action: 'abort' })) as { status: string; errors: string[] };
    expect(result.status).toBe('aborted');
    expect(result.errors).toHaveLength(1); // 'no paused chain to abort' 告知
    expect(send).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 风格卡片 MVP CR-026（08-28 BMad CR auditor#3）：IPC 写章入口 style_context 注入。
// 验：有卡（settings/style.md 存在）→ initialArtifacts['style_context'] 含全量版编译
//     （① 声音画像 + ⑬ fenced 节选），与 leader write_chapter 路径同口径（agent 包
//     readStyleCardBody + buildStyleContext 单源真导入）；无卡 → 不注入该 key（零回归）。
// style_context_brief 恒不注入——planner 派发侧（dispatch-planners）现读现编非链内
// artifact（CR-006 同判）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure:run-chapter-chain style_context 注入（风格卡 CR-026）', () => {
  const WITH_STYLE_DIR = path.join(TEST_DIR, 'cr026-with-style');
  const NO_STYLE_DIR = path.join(TEST_DIR, 'cr026-no-style');

  beforeAll(() => {
    mkdirSync(path.join(WITH_STYLE_DIR, 'settings'), { recursive: true });
    writeFileSync(
      path.join(WITH_STYLE_DIR, 'settings', 'style.md'),
      [
        '# 风格卡片',
        '',
        '## ① 声音画像',
        '',
        '叙述者冷静克制，带一点温柔的讽刺；对读者像老友谈天。',
        '',
        '## ⑬ 节选（few-shot 原文范本）',
        '',
        '```text',
        '夜色压下来，他数着窗外的灯。一盏、两盏——第三盏灭了。',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
  });
  afterAll(() => {
    rmBestEffort(WITH_STYLE_DIR);
    rmBestEffort(NO_STYLE_DIR);
  });

  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('CR-026：有卡项目 → initialArtifacts 含 style_context（声音画像 + fenced 节选，同 leader 路径口径）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: WITH_STYLE_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [, artifacts] = runChapterChain.mock.calls[0];
    const styleContext = artifacts['style_context'];
    expect(typeof styleContext).toBe('string');
    expect(styleContext as string).toContain('声音画像');
    expect(styleContext as string).toContain('夜色压下来，他数着窗外的灯');
    // style_context_brief 恒不注入（planner 派发侧现读现编——CR-006）。
    expect('style_context_brief' in artifacts).toBe(false);
  });

  it('CR-026：无卡项目 → 不注入 style_context（IPC 输出与旧版一致，零回归）', async () => {
    loadProject.mockReturnValue(DOC_FIXTURE);
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const handler = chainHandler();

    await handler({}, { projectPath: NO_STYLE_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } });

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const [, artifacts] = runChapterChain.mock.calls[0];
    expect('style_context' in artifacts).toBe(false);
    expect('style_context_brief' in artifacts).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood R2 #107 / R1.1：no-chapter 链侧自动建章（run/resume 两车道 + 模式门 + direct 容忍注册滞后）。
//
// novel.chapters 出生源 = chapters/*.md 磁盘派生（renderer 闭环）——首章未建时链 accept 的
// chapterId 映射恒 no-chapter。修法 = persistChapterAcceptIfNeeded 前置判定（planAutoCreateChapter
// 单源）→ 经 chapterWriteHandler（partial mock）建文件 + 补产 chapter_accept envelope：
// - run 车道（恒 direct，#93 拍板）→ 全文（frontmatter order + 标题 + 正文=采信稿）；
// - resume 车道 review 档（suggest/readonly leader）→ 骨架（无正文——正文走 envelope 人审）；
// - direct 建后 acceptChapterCandidate 因注册滞后 throw → 容忍（文件即落点，chapterPersisted=true）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure-chain-ipc #107 no-chapter 自动建章（R1.1 两车道）', () => {
  /** #107 fixture：DOC_FIXTURE + episode_outlines + 空 novel.chapters（首章冷启动形态）。 */
  const DOC_NO_CHAPTER = {
    ...DOC_FIXTURE,
    episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    novel: { chapters: [] },
  };

  const DRAFT_TITLE = '挖出来的是什么';
  const DRAFT_TEXT = '正文内容……（采信稿全文）';
  const STEM = `第01章-${DRAFT_TITLE}`;
  const FULL_FILE = `---\norder: 0\n---\n\n# ${DRAFT_TITLE}\n\n${DRAFT_TEXT}`;
  const SKELETON_FILE = `---\norder: 0\n---\n\n# ${DRAFT_TITLE}\n`;

  /** runChapterChain mock：调 options.onAccept（novel.chapters 空 → no-chapter skip，闭包捕获）+ 返无 chapter_accept 的 summary。 */
  function mockChainNoChapterSkip(): void {
    runChapterChain.mockImplementation(async (
      _sid: string,
      _arts: unknown,
      opts: { onAccept?: (snap: { runId: string; artifacts: Record<string, unknown> }, c: { nowISO: string }) => unknown },
    ) => {
      opts.onAccept?.(
        {
          runId: 'run_107_shell',
          artifacts: {
            'draft.initial': { title: DRAFT_TITLE, text: DRAFT_TEXT, wordCount: 2876 },
            'route_decision': { decision: 'accept_as_truth', reason: '正文升级', deviation: true },
          },
        },
        { nowISO: '2026-08-30T00:00:00.000Z' },
      );
      return {
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '正文升级', deviation: true },
        draftTitle: DRAFT_TITLE,
        draftWordCount: 2876,
        draftText: DRAFT_TEXT,
        errors: [],
        // chapter_accept 缺省（onAccept skip 了 no-chapter）。
      };
    });
  }

  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    loadProject.mockReset();
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    logError.mockReset();
    logInfo.mockReset();
    logWarn.mockReset();
    chapterWriteHandler.mockReset();
    chapterWriteHandler.mockResolvedValue({ title: 'chapter_write', output: 'written' });
    createSession.mockReturnValue({ id: 'stub-parent-session-1' });
    runAgentWithExplicitSystem.mockResolvedValue({ content: '' });
    notifyLeaderChainCompleted.mockReset();
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    allowPath(TEST_DIR);
  });

  function chainHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:run-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('run 车道 direct：no-chapter + 空位 → chapterWriteHandler 建全文 + envelope 补产（含 storyDecisions）+ 落盘成功', async () => {
    loadProject.mockReturnValue(DOC_NO_CHAPTER);
    mockChainNoChapterSkip();
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as {
      chapter_accept?: { chapterId: string; runId: string; candidate: { content: string; storyDecisions?: unknown[] } & Record<string, unknown>; storyDecisions?: unknown[] };
      chapterPersisted?: true;
      errors: string[];
    };

    // 建文件：direct 全文形态（frontmatter order + 标题 + 正文）。
    expect(chapterWriteHandler).toHaveBeenCalledTimes(1);
    const writeCtx = chapterWriteHandler.mock.calls[0][0] as { params: { chapterId: string; content: string }; projectDir: string };
    expect(writeCtx.params.chapterId).toBe(STEM);
    expect(writeCtx.params.content).toBe(FULL_FILE);
    expect(writeCtx.projectDir).toBe(TEST_DIR);

    // envelope 补产：chapterId=stem + runId=闭包捕获链段 runId + 完整文件形态 candidate + storyDecisions。
    expect(summary.chapter_accept).toBeDefined();
    expect(summary.chapter_accept!.chapterId).toBe(STEM);
    expect(summary.chapter_accept!.runId).toBe('run_107_shell');
    expect((summary.chapter_accept!.candidate as { content: string }).content).toBe(FULL_FILE);
    expect(summary.chapter_accept!.storyDecisions).toHaveLength(1);
    expect((summary.chapter_accept!.storyDecisions![0] as { id: string }).id).toBe('accept-run_107_shell');

    // 落盘成功路径（acceptChapterCandidate mock 成功）→ chapterPersisted + 无 error。
    expect(acceptChapterCandidate).toHaveBeenCalledWith(
      TEST_DIR,
      STEM,
      'run_107_shell',
      expect.objectContaining({ title: DRAFT_TITLE, content: FULL_FILE }),
      expect.anything(),
    );
    expect(summary.chapterPersisted).toBe(true);
    expect(summary.errors).toHaveLength(0);
  });

  it('run 车道 direct：acceptChapterCandidate 因注册滞后 throw → 容忍（文件即落点，无 error，chapterPersisted=true）', async () => {
    loadProject.mockReturnValue(DOC_NO_CHAPTER);
    mockChainNoChapterSkip();
    acceptChapterCandidate.mockImplementation(() => {
      throw new Error('chapter not found: 第01章-挖出来的是什么（注册未至——renderer 派生 300ms debounce）');
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as {
      chapterPersisted?: true;
      errors: string[];
    };

    // 文件已建（全文）——meta 持久化 throw 被容忍，不进 errors。
    expect(chapterWriteHandler).toHaveBeenCalledTimes(1);
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1);
    expect(summary.errors).toHaveLength(0);
    expect(summary.errors.join('\n')).not.toContain('chapter persist failed');
    // 文件即落点语义：UI 据此免二次 stage。
    expect(summary.chapterPersisted).toBe(true);
  });

  it('resume 车道 review（suggest leader 会话）：骨架形态 + envelope 返 UI 人审（不调 acceptChapterCandidate）', async () => {
    loadProject.mockReturnValue(DOC_NO_CHAPTER);
    mockChainNoChapterSkip();
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    // suggest leader 会话（非 stub）→ persistMode review。
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'leader-agent' });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-sess-1', action: 'continue' }) as {
      chapter_accept?: { chapterId: string; candidate: { content: string } };
      chapterPersisted?: true;
      errors: string[];
    };

    // 建文件：review 骨架形态（frontmatter + 标题、无正文——「写内容须人批」不破）。
    expect(chapterWriteHandler).toHaveBeenCalledTimes(1);
    const writeCtx = chapterWriteHandler.mock.calls[0][0] as { params: { chapterId: string; content: string } };
    expect(writeCtx.params.chapterId).toBe(STEM);
    expect(writeCtx.params.content).toBe(SKELETON_FILE);

    // envelope 留 summary 返 UI（candidate = 完整文件形态，人审 accept 落盘时保 frontmatter）。
    expect(summary.chapter_accept).toBeDefined();
    expect(summary.chapter_accept!.chapterId).toBe(STEM);
    expect(summary.chapter_accept!.candidate.content).toBe(FULL_FILE);
    // review 档不直落。
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(summary.chapterPersisted).toBeUndefined();
    expect(summary.errors).toHaveLength(0);
  });

  it('resume 车道 direct（auto 档 leader）：全文形态 + 落盘', async () => {
    loadProject.mockReturnValue(DOC_NO_CHAPTER);
    mockChainNoChapterSkip();
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } } },
    });
    getSession.mockReturnValue({ permissionMode: 'auto', agentName: 'leader-agent' });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'leader-sess-2', action: 'continue' }) as { chapterPersisted?: true };

    const writeCtx = chapterWriteHandler.mock.calls[0][0] as { params: { content: string } };
    expect(writeCtx.params.content).toBe(FULL_FILE);
    expect(summary.chapterPersisted).toBe(true);
  });

  it('守卫不过（novel.chapters sort_order 有洞）→ 不自动建 + 维持现状告警（describeAcceptSkip 文案）', async () => {
    loadProject.mockReturnValue({
      ...DOC_NO_CHAPTER,
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
          { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 1, pos: 0 } },
        ],
        edges: [],
        lines: [],
      },
      episode_outlines: [
        { id: 'ep1', index: 0 },
        { id: 'ep2', index: 1 },
      ],
      novel: { chapters: [{ id: 'ch_jump', sort_order: 2 }] },
    });
    // 目标 ep2（index 1）：diskSim [order 2] + new order:1 → 排序 [1,2] → 落位 0 ≠ 1 → 守卫拒。
    runChapterChain.mockImplementation(async (
      _sid: string,
      _arts: unknown,
      opts: { onAccept?: (snap: { runId: string; artifacts: Record<string, unknown> }, c: { nowISO: string }) => unknown },
    ) => {
      opts.onAccept?.(
        {
          runId: 'run_guard',
          artifacts: {
            'draft.initial': { title: DRAFT_TITLE, text: DRAFT_TEXT },
            'route_decision': { decision: 'accept_as_truth', reason: '通过' },
          },
        },
        { nowISO: '2026-08-30T00:00:00.000Z' },
      );
      return {
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '通过' },
        draftTitle: DRAFT_TITLE,
        draftText: DRAFT_TEXT,
        errors: [],
      };
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep2', chapterBrief: { goal: 'g' } }) as {
      chapter_accept?: unknown;
      chapterPersisted?: true;
      errors: string[];
    };

    expect(chapterWriteHandler).not.toHaveBeenCalled();
    expect(summary.chapter_accept).toBeUndefined();
    expect(summary.chapterPersisted).toBeUndefined();
    // 维持现状告警：accept 未持久化 + describeAcceptSkip 新文案（说明为何没自动建）。
    expect(summary.errors.join('\n')).toContain('accept 未持久化');
    expect(summary.errors.join('\n')).toContain('落位守卫');
  });

  it('无 draftText（no-draft skip）→ 不自动建（无候选可组装，零回归）', async () => {
    loadProject.mockReturnValue(DOC_NO_CHAPTER);
    runChapterChain.mockImplementation(async (
      _sid: string,
      _arts: unknown,
      opts: { onAccept?: (snap: { runId: string; artifacts: Record<string, unknown> }, c: { nowISO: string }) => unknown },
    ) => {
      opts.onAccept?.(
        {
          runId: 'run_nodraft',
          artifacts: {
            // draft.initial 缺 → onAccept 返 no-draft skip。
            'route_decision': { decision: 'accept_as_truth', reason: '通过' },
          },
        },
        { nowISO: '2026-08-30T00:00:00.000Z' },
      );
      return {
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '通过' },
        errors: [],
      };
    });
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as { errors: string[] };

    expect(chapterWriteHandler).not.toHaveBeenCalled();
    expect(summary.errors.join('\n')).toContain('draft 产出为空');
  });

  it('建文件通道失败 → graceful（不 fail run，维持现状告警）', async () => {
    loadProject.mockReturnValue(DOC_NO_CHAPTER);
    mockChainNoChapterSkip();
    chapterWriteHandler.mockRejectedValue(new Error('EPERM: disk full'));
    const handler = chainHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, episodeId: 'ep1', chapterBrief: { goal: 'g' } }) as {
      chapter_accept?: unknown;
      errors: string[];
    };

    expect(chapterWriteHandler).toHaveBeenCalledTimes(1);
    expect(summary.chapter_accept).toBeUndefined();
    // run 本身不 fail（graceful）——告警走既有 describeAcceptSkip 通道。
    expect(summary.errors.join('\n')).toContain('accept 未持久化');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 链流程重排 W4（R6）：closure:re-extract-chapter（链外重提取）+ closure:chapter-derivation-status
// ════════════════════════════════════════════════════════════════════════════

const RE_EXTRACT_OK = {
  ok: true,
  chapterId: 'ch_001',
  episodeId: 'ep1',
  wordCount: 2800,
  stats: {
    worldWrites: 1,
    worldPatches: 5,
    worldWriteErrors: 0,
    promiseGaps: 0,
    promiseActions: 0,
    arcBeats: 1,
    driftWarnings: 0,
  },
  storySync: {
    runId: 'run_reextract',
    chapterId: 'ch_001',
    summary: '提取新规则',
    patches: [
      { field: 'world_setting', action: 'merge', data: { newRule: '禁飞区' }, fieldVersion: 0, generatedBy: 'story-sync-agent' },
    ],
  },
};

describe('closure:re-extract-chapter handler（链流程重排 W4 / R6）', () => {
  beforeEach(() => {
    handle.mockReset();
    reExtractChapter.mockReset();
    createSession.mockReset();
    createSession.mockReturnValue({ id: 'stub-reextract-1' });
    loadProject.mockReset();
    loadProject.mockReturnValue(DOC_FIXTURE);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    logError.mockReset();
    logWarn.mockReset();
    allowPath(TEST_DIR);
  });

  function reExtractHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:re-extract-chapter');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('默认 suggest 档：stub session + runtime.reExtractChapter → storySync patches 转 storySyncReview 返 UI（人审）', async () => {
    // mockImplementation + structuredClone：handler 会 additive 挂 storySyncReview/Landed——共享
    // mockResolvedValue 同一对象会让挂载跨测试泄漏（suggest 测试污染 auto 测试）。
    reExtractChapter.mockImplementation(async () => structuredClone(RE_EXTRACT_OK));
    const handler = reExtractHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch_001' }) as {
      ok: boolean;
      storySyncReview?: { note: string; patches: Array<{ field: string; generatedBy: string }> };
      storySyncLanded?: unknown;
    };

    expect(result.ok).toBe(true);
    // stub parent session（agentName=chapter-reextract；mode=autonomy 缺省 suggest）。
    expect(createSession).toHaveBeenCalledTimes(1);
    const sessionInput = createSession.mock.calls[0][0];
    expect(sessionInput.agentName).toBe('chapter-reextract');
    expect(sessionInput.mode).toBe('suggest');
    // runtime.reExtractChapter 被调（stub session id + chapterId + CR-19 abort signal）。
    expect(reExtractChapter).toHaveBeenCalledTimes(1);
    const [reExtractSessionId, reExtractOpts] = reExtractChapter.mock.calls[0] as [string, { chapterId: string; abort?: AbortSignal }];
    expect(reExtractSessionId).toBe('stub-reextract-1');
    expect(reExtractOpts.chapterId).toBe('ch_001');
    expect(reExtractOpts.abort).toBeInstanceOf(AbortSignal);
    // suggest 档 → envelope PatchReview 人审（非直落非静默）。
    expect(result.storySyncLanded).toBeUndefined();
    expect(result.storySyncReview).toBeDefined();
    expect(result.storySyncReview!.patches[0]!.field).toBe('world_setting');
    expect(onFieldEdited).not.toHaveBeenCalled();
    // finally 经 handle 释放（CR-T1-020 唯一租约）。
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it('autonomy=auto：story_sync_apply 直落 → storySyncLanded + onFieldEdited(source=agent)', async () => {
    reExtractChapter.mockImplementation(async () => structuredClone(RE_EXTRACT_OK));
    const handler = reExtractHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch_001', autonomy: 'auto' }) as {
      storySyncLanded?: { fields: string[] };
      storySyncReview?: unknown;
    };

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    expect(onFieldEdited.mock.calls[0][0]).toBe(TEST_DIR);
    expect(onFieldEdited.mock.calls[0][1]).toBe('world_setting');
    expect(result.storySyncReview).toBeUndefined();
    expect(result.storySyncLanded?.fields).toEqual(['world_setting']);
  });

  it('runtime 返 ok:false → reason 原样透传 + 不做 story-sync 分流（永不静默）', async () => {
    reExtractChapter.mockResolvedValue({ ok: false, reason: '章 ch_001 未注册（novel.chapters 无此 id）——请先在工作台建章', chapterId: 'ch_001' });
    const handler = reExtractHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch_001', autonomy: 'auto' }) as {
      ok: boolean;
      reason?: string;
      storySyncReview?: unknown;
      storySyncLanded?: unknown;
    };

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('未注册');
    expect(result.storySyncReview).toBeUndefined();
    expect(result.storySyncLanded).toBeUndefined();
    expect(onFieldEdited).not.toHaveBeenCalled();
  });

  it('D4 闸占用 → 机器可读拒绝 + 不调 runtime + 不释放（未获得句柄）', async () => {
    acquireProjectRun.mockImplementation(() => ({
      ok: false,
      held: { sessionId: 'other-session', projectPath: TEST_DIR },
    }));
    const handler = reExtractHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch_001' }) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('project_run_active|heldBy=other-session');
    expect(reExtractChapter).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it('projectPath 越界 → assertSafePath 拒 → ok:false（不调 runtime）', async () => {
    const handler = reExtractHandler();
    const result = await handler({}, { projectPath: 'Z:\\definitely-not-allowed', chapterId: 'ch_001' }) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('projectPath rejected');
    expect(reExtractChapter).not.toHaveBeenCalled();
  });

  it('runtime throw → catch → ok:false reason 透传（不崩 IPC）+ finally 释放', async () => {
    reExtractChapter.mockRejectedValue(new Error('E-segment infra boom'));
    const handler = reExtractHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch_001' }) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('E-segment infra boom');
    // finally 释放仍发生（catch 路径不泄漏租约）。
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });
});

describe('closure:chapter-derivation-status handler（链流程重排 W4 / R6 查询面）', () => {
  /** 两章注册（ch1 ↔ ep1 index 0 / ch2 ↔ ep2 index 1）。 */
  const DOC_TWO_CHAPTERS = {
    ...DOC_FIXTURE,
    episode_outlines: [
      { id: 'ep1', index: 0, title: '第一章' },
      { id: 'ep2', index: 1, title: '第二章' },
    ],
    novel: {
      chapters: [
        { id: 'ch1', title: '第一章', sort_order: 0, sections: [] },
        { id: 'ch2', title: '第二章', sort_order: 1, sections: [] },
      ],
    },
  };

  beforeEach(() => {
    handle.mockReset();
    loadProject.mockReset();
    loadProject.mockReturnValue(DOC_TWO_CHAPTERS);
    listChapterSummaries.mockReset();
    listChapterSummaries.mockReturnValue([]);
    logWarn.mockReset();
    allowPath(TEST_DIR);
  });

  function derivationStatusHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:chapter-derivation-status');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  it('db 无摘要行（未提取/未注册）→ 全章 summaryPresent=false + stale=true（重提取候选如实标出）', async () => {
    // 未注册语义就地封闭（getProject → undefined）：文件级 mock 默认委托真实现，而真实现
    // 首调 getDb 才加载 better-sqlite3 原生模块（v12 lazy binding）——Electron-ABI 本地
    // vitest 下 dlopen 炸 → handler best-effort catch → 空 chapters 假红（ABI skip 门
    // 探不到这种 import 存活的文件）。in-test 覆写 mirror 下方「摘要行在」用例的惯例。
    getProjectDb.mockReturnValue(undefined);
    const handler = derivationStatusHandler();

    const result = await handler({}, { projectPath: TEST_DIR }) as {
      chapters: Array<{ chapterId: string; episodeId?: string; summaryPresent: boolean; synopsisStale: boolean; stale: boolean }>;
    };

    expect(result.chapters).toHaveLength(2);
    for (const entry of result.chapters) {
      expect(entry.summaryPresent).toBe(false);
      expect(entry.synopsisStale).toBe(false);
      expect(entry.stale).toBe(true);
    }
    expect(result.chapters[0]).toMatchObject({ chapterId: 'ch1', episodeId: 'ep1' });
    expect(result.chapters[1]).toMatchObject({ chapterId: 'ch2', episodeId: 'ep2' });
  });

  it('摘要行在 + degradedNote 含「正文已修订」→ synopsisStale=true；无注章 → stale=false', async () => {
    getProjectDb.mockReturnValue({ projectId: 'pj-1' });
    listChapterSummaries.mockReturnValue([
      // ch1/ep1：手改后降档标注（8.7 CR-001 持久信号）。
      { episodeId: 'ep1', episodeIndex: 0, storyTimeEnd: 5, summary: { degradedNote: '正文已修订：梗概与出场申报基于修订前版本' }, tokenEstimate: 10, truncated: false, patchRowidHigh: 1, updatedAt: '2026-09-13T00:00:00Z' },
      // ch2/ep2：新鲜行（无 stale 注）。
      { episodeId: 'ep2', episodeIndex: 1, storyTimeEnd: 6, summary: {}, tokenEstimate: 10, truncated: false, patchRowidHigh: 2, updatedAt: '2026-09-13T00:00:00Z' },
    ]);
    const handler = derivationStatusHandler();

    const result = await handler({}, { projectPath: TEST_DIR }) as {
      chapters: Array<{ chapterId: string; synopsisStale: boolean; summaryPresent: boolean; stale: boolean }>;
    };

    expect(result.chapters[0]).toMatchObject({ chapterId: 'ch1', summaryPresent: true, synopsisStale: true, stale: true });
    expect(result.chapters[1]).toMatchObject({ chapterId: 'ch2', summaryPresent: true, synopsisStale: false, stale: false });
  });

  it('chapterId 收窄 → 只返该章', async () => {
    const handler = derivationStatusHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch2' }) as {
      chapters: Array<{ chapterId: string }>;
    };

    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]!.chapterId).toBe('ch2');
  });

  it('loadProject 失败 → 空列表（best-effort 查询不崩）', async () => {
    loadProject.mockReturnValue(null);
    const handler = derivationStatusHandler();

    const result = await handler({}, { projectPath: TEST_DIR }) as { chapters: unknown[] };

    expect(result.chapters).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 链流程重排 CR 修复批（09-13，簇 3）：closureChainIpc 侧——CR-6（legacy verdict 停点废弃拦截）/
// CR-13（whitespace editedDraft 拒收）/ CR-14（loopUnconverged 接线）/ CR-19（re-extract abort
// 传参 + stub 会话 finally 删除）/ CR-2c（redo 按 pauseKind 分派 + resume.redoFrom）。
// ════════════════════════════════════════════════════════════════════════════

describe('closure-chain-ipc CR 修复批（09-13 簇 3）', () => {
  beforeEach(() => {
    handle.mockReset();
    runChapterChain.mockReset();
    runAgentWithExplicitSystem.mockReset();
    createSession.mockReset();
    createSession.mockReturnValue({ id: 'stub-parent-session-1', permissionMode: 'suggest' });
    loadProject.mockReset();
    loadProject.mockReturnValue(DOC_FIXTURE);
    acceptChapterCandidate.mockReset();
    acceptChapterCandidate.mockImplementation(() => undefined);
    onFieldEdited.mockReset();
    onFieldEdited.mockReturnValue({ syncEvent: {}, staleFields: [] });
    clearChainSnapshot.mockReset();
    getChainSnapshot.mockReset();
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    notifyLeaderChainCompleted.mockReset();
    notifyLeaderChainCompleted.mockResolvedValue(true);
    reExtractChapter.mockReset();
    deleteSession.mockReset();
    acquireProjectRun.mockClear();
    acquireProjectRun.mockImplementation(() => ({ ok: true, release: releaseLease }));
    releaseLease.mockClear();
    logError.mockReset();
    logWarn.mockReset();
    allowPath(TEST_DIR);
  });

  function resumeHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:resume-chapter-chain');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  function reExtractHandler() {
    registerClosureChainIpc();
    const call = handle.mock.calls.find(([channel]) => channel === 'closure:re-extract-chapter');
    expect(call).toBeTruthy();
    return call![1] as (e: unknown, input: Record<string, unknown>) => Promise<unknown>;
  }

  // ─── CR-6：legacy verdict 停点废弃拦截（mirror write-chapter isDiscardedLegacyPause）───

  /** legacy verdict 停点快照：route-agent 停 + 非 escalate-pause + artifacts 带 chapter_accept（旧 onAccept-先于-pause 产物）。 */
  const LEGACY_VERDICT_SNAPSHOT = {
    runId: 'r-legacy',
    status: 'paused',
    currentNodeId: 'route-agent',
    projectPath: TEST_DIR,
    completedNodes: ['brief-compiler-node', 'route-agent'],
    pendingNodes: [],
    artifacts: {
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
      chapter_accept: { chapterId: 'ch_001', candidate: { content: '旧候选' }, runId: 'r-legacy' },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
  };

  it('CR-6：旧 verdict 停点 + continue → 废弃拦截（clearChainSnapshot + error 提示重跑），不被当 final-accept F1a 直接落盘', async () => {
    getChainSnapshot.mockReturnValue(LEGACY_VERDICT_SNAPSHOT);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-legacy', action: 'continue' }) as { status: string; errors: string[] };

    // 废弃拦截：清快照 + 结构化 error 提示重跑 + 不跑链段不落盘（修前 action=continue 会当
    // final-accept 直接 F1a persistMode:'direct' 落盘——绕过 PatchReview 人审信封）。
    expect(clearChainSnapshot).toHaveBeenCalledWith('sess-legacy');
    expect(runChapterChain).not.toHaveBeenCalled();
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('旧 verdict 停点'))).toBe(true);
  });

  it('CR-6：action=accept 同样拦（旧候选不因 accept 动作绕过废弃）', async () => {
    getChainSnapshot.mockReturnValue(LEGACY_VERDICT_SNAPSHOT);
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-legacy', action: 'accept' }) as { status: string };

    expect(summary.status).toBe('error');
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  it('CR-6：escalate-pause（chapter_accept 是裁决材料）永不拦——照常续跑', async () => {
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({ ...LEGACY_VERDICT_SNAPSHOT, escalatePause: true, runId: 'r-esc' });
    const handler = resumeHandler();

    const summary2 = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-esc', action: 'continue' }) as { status: string };

    expect(clearChainSnapshot).not.toHaveBeenCalled();
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(summary2.status).toBe('completed');
  });

  it('CR-6 零回归：新终稿停点（route-agent 无 chapter_accept）+ continue → 不拦，F1a 照常（既有 final-continue 语义）', async () => {
    loadProject.mockReturnValue({
      ...DOC_FIXTURE,
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
      novel: { chapters: [{ id: 'ch_001', sort_order: 0, title: '第一章', sections: [{ content_file: 'chapters/ch_001.md' }] }] },
    });
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      ...LEGACY_VERDICT_SNAPSHOT,
      runId: 'r-final',
      artifacts: {
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
        route_decision: { decision: 'accept_as_truth', reason: '终稿' },
        'draft.initial': { title: '第二章', text: '终稿正文', wordCount: 5 },
      },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-final', action: 'continue' }) as { chapterPersisted?: boolean };

    expect(clearChainSnapshot).not.toHaveBeenCalled();
    expect(acceptChapterCandidate).toHaveBeenCalledTimes(1); // F1a 立即落正文
    expect(summary.chapterPersisted).toBe(true);
  });

  // ─── CR-13：whitespace-only editedDraft 拒收 ───

  it('CR-13：whitespace-only editedDraft（可过 schema min(1)）→ IPC 入口 trim 判拒（结构化 error，不静默丢编辑也不误写空白）', async () => {
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    const summary = await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-1', action: 'accept', editedDraft: ' \n\t ' }) as { status: string; errors: string[] };

    expect(summary.status).toBe('error');
    expect(summary.errors.some((e) => e.includes('editedDraft 不能为空白'))).toBe(true);
    // 不落盘不跑链（双口径对齐：F1a 不覆写空白正文 / resume 腿不静默丢编辑）。
    expect(acceptChapterCandidate).not.toHaveBeenCalled();
    expect(runChapterChain).not.toHaveBeenCalled();
  });

  // ─── CR-2c：redo 按 pauseKind 分派（plan pause 回 A1 + resume.redoFrom）───

  it('CR-2c：规划环停点（brief-reviewer-node）redo → redo.nodeId=brief-compiler-node + resume.redoFrom 同目标', async () => {
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      status: 'paused',
      currentNodeId: 'brief-reviewer-node',
      completedNodes: ['brief-compiler-node', 'brief-reviewer-node'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-plan', action: 'redo', feedback: '任务卡信息控制自相矛盾，重编' });

    const options = runChapterChain.mock.calls[0][2] as {
      resume?: { fromSnapshot?: boolean; redoFrom?: string };
      redo?: { nodeId: string; feedback?: string };
    };
    expect(options.resume).toEqual({ fromSnapshot: true, redoFrom: 'brief-compiler-node' });
    expect(options.redo).toEqual({ nodeId: 'brief-compiler-node', feedback: '任务卡信息控制自相矛盾，重编' });
  });

  it('CR-2c：guardOverride 微重跑不携 redoFrom（非环回环，nodeId 维持 revision-guard-agent）', async () => {
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    getChainSnapshot.mockReturnValue({
      status: 'paused',
      currentNodeId: 'revision-guard-agent',
      completedNodes: ['revision-guard-agent'],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-guard', action: 'redo', guardOverride: 'force-accept' });

    const options = runChapterChain.mock.calls[0][2] as {
      resume?: { fromSnapshot?: boolean; redoFrom?: string };
      redo?: { nodeId: string; guardOverride?: string };
    };
    expect(options.resume).toEqual({ fromSnapshot: true });
    expect(options.redo).toEqual({ nodeId: 'revision-guard-agent', guardOverride: 'force-accept' });
  });

  // ─── CR-14：leader-notify loopUnconverged 接线 ───

  it('CR-14：completed 且 errors 含自审环 cap 标记（route-agent）→ payload.loopUnconverged=true；规划环 cap 标记不误报', async () => {
    getSession.mockReturnValue({ permissionMode: 'suggest', agentName: 'writer' });
    getChainSnapshot.mockReturnValue({
      completedNodes: [],
      artifacts: { chapter_brief_input: { episodeId: 'ep1', brief: {} } },
    });
    const handler = resumeHandler();

    // 自审环 cap 标记（escalate-pause 期入 errors，人/裁决采信 resume 到 completed 携带至今）。
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      errors: ['loop cap (3) reached at "route-agent"; forced escalate'],
    });
    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-unconv', action: 'continue' });

    expect(notifyLeaderChainCompleted).toHaveBeenCalledTimes(1);
    const payload = notifyLeaderChainCompleted.mock.calls[0][1] as { loopUnconverged?: boolean };
    expect(payload.loopUnconverged).toBe(true);

    // 规划环 cap 标记（brief-reviewer-node）→ 不误报（精确匹配 loop 节点 id，CR-8 同判据）。
    notifyLeaderChainCompleted.mockClear();
    runChapterChain.mockResolvedValue({
      ...SUMMARY_OK,
      errors: ['loop cap (2) reached at "brief-reviewer-node"; forced escalate'],
    });
    await handler({}, { projectPath: TEST_DIR, sessionId: 'sess-unconv', action: 'continue' });
    const payload2 = notifyLeaderChainCompleted.mock.calls[0][1] as { loopUnconverged?: boolean };
    expect(payload2.loopUnconverged).toBeUndefined();
  });

  // ─── CR-19：re-extract abort 传参 + stub 会话 finally 删除 ───

  it('CR-19：reExtractChapter 收 abort signal（IPC 建 AbortController）+ stub 会话 finally 删除（成功路径）', async () => {
    reExtractChapter.mockResolvedValue({ ok: true, chapterId: 'ch_001' });
    const handler = reExtractHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch_001' }) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(reExtractChapter).toHaveBeenCalledTimes(1);
    const [stubSessionId, opts] = reExtractChapter.mock.calls[0] as [string, { chapterId: string; abort?: AbortSignal }];
    expect(stubSessionId).toBe('stub-parent-session-1');
    expect(opts.chapterId).toBe('ch_001');
    expect(opts.abort).toBeInstanceOf(AbortSignal); // 7+ LLM 调用持租约期间可取消的信号通道
    // finally 清理：stub 会话删除（注册表无界增长防线）。
    expect(deleteSession).toHaveBeenCalledWith('stub-parent-session-1');
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it('CR-19：runtime throw → catch ok:false + stub 会话清理仍走 + finally 释放租约', async () => {
    reExtractChapter.mockRejectedValue(new Error('E-segment boom'));
    const handler = reExtractHandler();

    const result = await handler({}, { projectPath: TEST_DIR, chapterId: 'ch_001' }) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('E-segment boom');
    expect(deleteSession).toHaveBeenCalledWith('stub-parent-session-1'); // throw 路径 finally 同样清理
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });
});
