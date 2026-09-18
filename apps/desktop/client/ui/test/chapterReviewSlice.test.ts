/**
 * Story 4.3 Step 4（design §3.6 / §5）：chapterReviewSlice 行为测。
 * Story 7.1 B1（design §4.2）：选区指挥精修扩展（compileIntent / confirmRedoWithIntent / B1 state）测。
 * 09-13 子3 W4（design §5.3/F2）：五本地态 BySession 键控 + 七动作 sessionId 尾参测
 * （写作页审批迁移——后台会话直审不切走，两会话本地态不互串）+ metadataFromPausedSummary
 * final 扩展（reviewSummary/lintReport/'accept' 注入）。
 *
 * 覆盖：
 * - setPausedReview：metadata 落 state。
 * - 三动作（continue/redo/abort）调 shared/api resumeChapterChain（→ closure:resume-chapter-chain IPC）
 *   + 据返回 summary 和解 pausedReview（completed/aborted → clear；paused → 更新下一 checkpoint 载荷；error → clear + 不静默）。
 * - registerProjectReset：项目切换清无归属键（跨项目不泄漏，[[state-management]] 硬约束）。
 * - Story 7.1 B1：compileIntent 调 compileRevisionIntent IPC + 和解（intent 非空 → compiledIntent；
 *   null/error → intentCompileError）；confirmRedoWithIntent 调 resume redo + revisionIntent 透传 + 清 B1 state；
 *   setReviewSelection / clearCompiledIntent；项目隔离 reset 清 B1 state。
 * - W4：双会话键控隔离（A 在途 reviewResuming 不挡 B 动作 / B 动作按 B 的 pausedReview 键）。
 *
 * 范式判据：slice 只路由 metadata + 派发机械控制信号；resume 结果和解除纯代码确定性。
 *
 * 测试照 ui/testing.md seam-mock 约定：只组合被测 slice + 必要 deps + vi.mock shared/api/agent
 * （slice 经分层约束不直连 window，照 writeChapterTrigger 模式 vi.mock）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { createChapterReviewSlice, metadataFromPausedSummary } from '../src/shared/store/chapterReviewSlice';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import { __clearAgentEventTracks, rememberSessionProject } from '../src/shared/store/agentEvents';
import { useToastStore } from '../src/shared/store/toastStore';
import type {
  ChapterReviewMetadata,
  CompileRevisionIntentResult,
  RevisionIntent,
  RunChapterChainSummary,
} from '@orison/shared-contracts';

// Mock the agent api module（slice 经 shared/api 分层约束，不直连 window——照 writeChapterTrigger 模式 vi.mock）。
const apiMocks = vi.hoisted(() => ({
  resumeChapterChain: vi.fn(async () => ({ status: 'completed', errors: [] }) as RunChapterChainSummary),
  compileRevisionIntent: vi.fn(async () => ({ intent: null }) as CompileRevisionIntentResult),
}));
vi.mock('../src/shared/api/agent', () => apiMocks);

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

type TestState = import('../src/shared/store/chapterReviewSlice').ChapterReviewSlice & {
  currentProject: { path?: string } | null;
  agentSessionId: string | null;
  resolvedLocale: string;
  /** dogfood T1 CR-T1-027：busy 拒绝 toast 的一键跳转（占用者会话）。 */
  switchAgentSession: (sessionId: string) => Promise<void>;
  setPendingPatch: (sessionId: string, patch: import('@orison/shared-contracts').ProjectFieldPatch | null) => void;
  /** CR-3：escalate 裁决卡失效清键的读写面（Deps 可选面——测试持真键验证消费失效）。 */
  escalateFindingsBySession: Record<string, import('../src/shared/store/chainTimeline').EscalateFindingsEntry>;
};

const pendingPatchSpy = vi.fn();
const switchAgentSessionSpy = vi.fn(async () => {});

const useTestStore = create<TestState>()((...a) => ({
  ...createChapterReviewSlice(...a),
  currentProject: { path: '/proj' },
  agentSessionId: 'session-1',
  resolvedLocale: 'en-US',
  switchAgentSession: switchAgentSessionSpy,
  setPendingPatch: pendingPatchSpy,
  escalateFindingsBySession: {},
}));

// 文件级单 spy（vitest 4 `vi.spyOn` 对已挂 mock 直接复用 × zustand 快照血缘传播——
// task 08-29-vitest4-ui-migration design §3.1 范式）：showToast 恒挂一次，no-op stub
// 一次设定（全文件用例均为 stub 断言调用形态，无真实 toast 渲染断言），计数由
// beforeEach mockClear 按测清；测试体内不再 spyOn / mockRestore。
const toastSpy = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

const draftMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'draft',
  chapterId: 'ch_001',
  draftContent: '第一章草稿正文…',
  resumeOptions: ['continue', 'redo', 'abort'],
};

function makeSummary(overrides: Partial<RunChapterChainSummary> = {}): RunChapterChainSummary {
  return { status: 'completed', errors: [], ...overrides };
}

const SAMPLE_INTENT: RevisionIntent = {
  change: { summary: '把战斗节奏改紧张' },
  lockedItems: [
    { field: '角色性格', authority: 'hard', evidence: '别动角色性格' },
    { field: '结论', authority: 'soft' },
  ],
  rationale: { source: 'user-directive', note: '用户选段指挥精修' },
  provenance: {
    rawUserInstruction: '这段战斗改紧张点，别动角色性格',
    compilerNote: '锁定角色性格',
  },
  scope: {
    anchor: { quote: '战斗开始了', prefix: '前文。', suffix: '。后文', rangeHint: { from: 3, to: 8 } },
    chapterId: 'ch_001',
  },
};

// ── W4 键控读 helper（五本地态键缺席 = 缺省态） ──
const resuming = (sid = 'session-1') => useTestStore.getState().reviewResumingBySession[sid] === true;
const selection = (sid = 'session-1') => useTestStore.getState().reviewSelectionBySession[sid] ?? null;
const compiled = (sid = 'session-1') => useTestStore.getState().compiledIntentBySession[sid] ?? null;
const compiling = (sid = 'session-1') => useTestStore.getState().intentCompilingBySession[sid] === true;
const compileError = (sid = 'session-1') => useTestStore.getState().intentCompileErrorBySession[sid] ?? null;

beforeEach(() => {
  __clearAgentEventTracks(); // CR-T1-025 用例间隔离（rememberSessionProject 模块级 Map）
  toastSpy.mockClear(); // 文件级 spy 计数按测清
  apiMocks.resumeChapterChain.mockReset();
  apiMocks.resumeChapterChain.mockResolvedValue({ status: 'completed', errors: [] });
  apiMocks.compileRevisionIntent.mockReset();
  apiMocks.compileRevisionIntent.mockResolvedValue({ intent: null });
  pendingPatchSpy.mockReset();
  switchAgentSessionSpy.mockReset();
  useToastStore.setState({ toasts: [] });
  useTestStore.setState({
    pausedReviewBySession: {},
    reviewResumingBySession: {},
    reviewSelectionBySession: {},
    compiledIntentBySession: {},
    intentCompilingBySession: {},
    intentCompileErrorBySession: {},
    escalateFindingsBySession: {},
    currentProject: { path: '/proj' },
    agentSessionId: 'session-1',
    resolvedLocale: 'en-US',
  });
});

describe('chapterReviewSlice — setPausedReview', () => {
  it('落 metadata 到 pausedReview', () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toEqual(draftMeta);
  });

  it('null 清空 pausedReview', () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.getState().setPausedReview('session-1', null);
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });
});

describe('chapterReviewSlice — reviewContinue', () => {
  it('调 resumeChapterChain IPC（action=continue + projectPath + sessionId + chapterId 透传）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue();

    expect(apiMocks.resumeChapterChain).toHaveBeenCalledTimes(1);
    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      projectPath: '/proj',
      sessionId: 'session-1',
      chapterId: 'ch_001',
      action: 'continue',
    });
    // completed → 清 pausedReview。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(resuming()).toBe(false);
  });

  it('completed summary → 清 pausedReview（panel 卸载）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue();

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  it('aborted summary（continue 被动中断）→ 保留 pausedReview + 中断 toast（R2 #105 缓①）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewContinue();

    // 被动中断不清场（chainSnapshot 滞留可再续）——mirror busy 分支「原样保留」哲学。
    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(resuming()).toBe(false);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    // toast 文案注明重跑起点语义（保留载荷 = 上次审阅快照）。
    expect(String(toastSpy.mock.calls[0][0])).toContain('snapshot from your last review');
  });

  it('paused summary → 更新 pausedReview 渲染下一 checkpoint 载荷（chapterId 保留透传）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    // continue 后链段跑 review→route→verdict checkpoint 又停（半自动 verdict pause）。
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'verdict' }),
    );

    await useTestStore.getState().reviewContinue();

    const next = (useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null);
    expect(next).not.toBeNull();
    expect(next?.stage).toBe('verdict');
    // chapterId 保留透传（resume summary 不回传；前一轮的避免丢失追踪）。
    expect(next?.chapterId).toBe('ch_001');
    expect(next?.resumeOptions).toEqual(['continue', 'redo', 'abort']);
  });

  it('error summary（continue 链段跑崩）→ 保留 pausedReview + toast 透传原因（R2 #105 缓①，不静默不抛）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'error', errors: ['loadProject failed: boom'] }),
    );

    await useTestStore.getState().reviewContinue();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(resuming()).toBe(false);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('loadProject failed: boom');
  });

  it('IPC throw（continue）→ 保留 pausedReview + 中断 toast（不抛，R2 #105 缓①）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockRejectedValue(new Error('IPC 下线'));

    await expect(useTestStore.getState().reviewContinue()).resolves.toBeUndefined();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(resuming()).toBe(false);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('IPC 下线');
  });

  it('无 project / sessionId → no-op（不调 IPC）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({ currentProject: null });

    await useTestStore.getState().reviewContinue();

    expect(apiMocks.resumeChapterChain).not.toHaveBeenCalled();
  });
});

describe('chapterReviewSlice — reviewRedo', () => {
  it('调 IPC（action=redo + feedback 透传，仅 redo 带 feedback）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'paused', pausedStage: 'draft' }));

    await useTestStore.getState().reviewRedo('把开头改得更紧张');

    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      action: 'redo',
      feedback: '把开头改得更紧张',
    });
  });

  it('空 feedback → 不传 feedback 字段（redo 无指令重跑合法）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);

    await useTestStore.getState().reviewRedo(undefined);

    const call = apiMocks.resumeChapterChain.mock.calls[0][0];
    expect(call.action).toBe('redo');
    expect(call.feedback).toBeUndefined();
  });

  it('redo 后再 paused（draft 重跑完又停 draft checkpoint）→ 更新 pausedReview', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'draft', draftContent: '改后的草稿…' }),
    );

    await useTestStore.getState().reviewRedo('改');

    const next = (useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null);
    expect(next?.stage).toBe('draft');
    expect(next?.draftContent).toBe('改后的草稿…');
  });
});

describe('chapterReviewSlice — reviewAbort', () => {
  it('调 IPC（action=abort，不带 feedback）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewAbort();

    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      action: 'abort',
    });
    expect(apiMocks.resumeChapterChain.mock.calls[0][0].feedback).toBeUndefined();
    // aborted → 清 pausedReview。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 09-13 子3 W5（design §4.1）：终稿 accept slice 化（CR-18 interim 面板 handler 迁入——
// editedDraft 条件携带 + 和解分支 mirror 三动作 + 完成收尾 i18n 文案 agent.reviewFinalAccepted*）。
// ═══════════════════════════════════════════════════════════════════════════

describe('chapterReviewSlice — reviewAcceptFinal（W5 终稿 accept slice 化）', () => {
  const finalMeta: ChapterReviewMetadata = {
    type: 'chapter_review',
    stage: 'final',
    chapterId: 'ch_001',
    draftContent: '终稿正文。',
    resumeOptions: ['accept', 'redo', 'abort'],
  };
  const ACCEPT = {
    chapterId: 'ch_001',
    candidate: { title: '第八章', content: '正文…', wordCount: 2800 },
    runId: 'run_mock',
  };

  it('携 editedDraft → IPC action=accept + editedDraft 透传；无手改调用 → 不带 editedDraft 字段', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);

    await useTestStore.getState().reviewAcceptFinal('手改后的全文。');
    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      projectPath: '/proj',
      sessionId: 'session-1',
      chapterId: 'ch_001',
      action: 'accept',
      editedDraft: '手改后的全文。',
    });

    apiMocks.resumeChapterChain.mockClear();
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    await useTestStore.getState().reviewAcceptFinal();
    expect(apiMocks.resumeChapterChain.mock.calls[0][0].editedDraft).toBeUndefined();
  });

  it('accept 置 reviewResuming flight 键（#105 done-probe 守卫同享——interim 本地 inFlight 无此覆盖）', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    let release!: (v: RunChapterChainSummary) => void;
    apiMocks.resumeChapterChain.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const p = useTestStore.getState().reviewAcceptFinal();
    expect(resuming()).toBe(true);
    release(makeSummary({ status: 'completed' }));
    await p;
    expect(resuming()).toBe(false);
  });

  it('completed + chapterPersisted（F1a 直落）→ 清面板 + agent.reviewFinalAccepted 文案（en locale 真翻译）', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'completed',
      chapterPersisted: true,
      draftTitle: '第八章',
      chapter_accept: ACCEPT,
    }));

    await useTestStore.getState().reviewAcceptFinal();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeUndefined();
    expect(pendingPatchSpy).not.toHaveBeenCalled();
    const toastText = String(toastSpy.mock.calls[0][0]);
    expect(toastText).toContain('第八章');
    expect(toastText).toContain('chapters/');
  });

  it('completed + chapter_accept 未直落 → envelope 进 setPendingPatch（chapter_candidate）+ 待审阅文案', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'completed',
      draftTitle: '第八章',
      chapter_accept: { ...ACCEPT, storyDecisions: [{ id: 'd1', summary: 's' }] as never },
    }));

    await useTestStore.getState().reviewAcceptFinal();

    expect(pendingPatchSpy).toHaveBeenCalledTimes(1);
    const [sid, patch] = pendingPatchSpy.mock.calls[0] as [string, import('@orison/shared-contracts').ProjectFieldPatch];
    expect(sid).toBe('session-1');
    expect(patch.patches[0].field).toBe('chapter_candidate');
    expect((patch.patches[0].data as { storyDecisions?: unknown[] }).storyDecisions).toHaveLength(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('第八章');
  });

  it('aborted/error（accept 被动中断）→ 保留面板可重试 + 中断 toast（mirror continue/redo 分流）', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewAcceptFinal();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(String(toastSpy.mock.calls[0][0])).toContain('snapshot from your last review');
  });

  it('IPC throw（accept）→ 保留面板 + 失败 toast（不清场）', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    apiMocks.resumeChapterChain.mockRejectedValue(new Error('IPC 下线'));

    await expect(useTestStore.getState().reviewAcceptFinal()).resolves.toBeUndefined();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(String(toastSpy.mock.calls[0][0])).toContain('IPC 下线');
  });

  it('B1 trigger 态清理（选区/intent 卡不残留到下一 checkpoint）+ 重入 guard', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    useTestStore.setState({
      reviewSelectionBySession: { 'session-1': { text: '选区', from: 1, to: 3 } },
      compiledIntentBySession: { 'session-1': SAMPLE_INTENT },
    });
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewAcceptFinal();

    expect(selection()).toBeNull();
    expect(compiled()).toBeNull();

    // 重入 guard：flight 在途再调 → no-op（mirror confirmRedoWithIntent 哲学）。
    apiMocks.resumeChapterChain.mockClear();
    useTestStore.setState({ reviewResumingBySession: { 'session-1': true } });
    await useTestStore.getState().reviewAcceptFinal('再改');
    expect(apiMocks.resumeChapterChain).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 09-18 CR 批 A：escalate 裁决卡失效（CR-3② 消费清键）+ resume fallback source/route
// 透传（CR-13，去 reader-audit 硬编码）+ accept 终态静默路径兜底（CR-8 警示 toast）。
// ═══════════════════════════════════════════════════════════════════════════

describe('chapterReviewSlice — CR-3/CR-13/CR-8（escalate 失效 + fallback 透传 + accept 兜底）', () => {
  const escalateEntry = () => ({
    source: 'reader-audit' as const,
    route: 'escalate_user',
    chapterId: 'ch_001',
    items: [{ severity: 'block' as const, quote: 'q', location: 'l', explanation: 'e' }],
    at: 1,
  });
  const finalMeta: ChapterReviewMetadata = {
    type: 'chapter_review',
    stage: 'final',
    chapterId: 'ch_001',
    draftContent: '终稿正文。',
    resumeOptions: ['accept', 'redo', 'abort'],
  };

  it('CR-3②：escalate 裁决卡在位 + reviewAcceptFinal 返 completed → 键清（裁决消费失效）', async () => {
    useTestStore.setState({ escalateFindingsBySession: { 'session-1': escalateEntry() } });
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed', chapterPersisted: true }));

    await useTestStore.getState().reviewAcceptFinal();

    expect(useTestStore.getState().escalateFindingsBySession['session-1']).toBeUndefined();
  });

  it('CR-3②：escalate 在位 + reviewRedo 返 aborted（被动中断，裁决未消费）→ 键保留（重试时卡还在）', async () => {
    useTestStore.setState({ escalateFindingsBySession: { 'session-1': escalateEntry() } });
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewRedo('改', 'session-1');

    expect(useTestStore.getState().escalateFindingsBySession['session-1']).toBeDefined();
    // busy / IPC throw 同口径不清（未消费）——catch 路径抽验。
    useTestStore.setState({ escalateFindingsBySession: { 'session-1': escalateEntry() } });
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockRejectedValue(new Error('IPC 下线'));
    await useTestStore.getState().reviewRedo('改', 'session-1');
    expect(useTestStore.getState().escalateFindingsBySession['session-1']).toBeDefined();
  });

  it('CR-3②+CR-13：redo → 又 paused 且 summary 带 escalateFindings + planEscalate → 清旧写新（source=plan-review 不误标）', async () => {
    useTestStore.setState({ escalateFindingsBySession: { 'session-1': escalateEntry() } });
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue({
      ...makeSummary({
        status: 'paused',
        pausedStage: 'draft',
        escalateFindings: [{ severity: 'warn', quote: 'q2', location: 'l2', explanation: 'e2' }],
      }),
      planEscalate: { verdict: 'escalate', loopLabel: '第 2 圈', summary: 's', findings: [] },
    } as RunChapterChainSummary);

    await useTestStore.getState().reviewRedo('改', 'session-1');

    const entry = useTestStore.getState().escalateFindingsBySession['session-1'];
    expect(entry?.source).toBe('plan-review');
    expect(entry?.route).toBe('escalate');
    expect(entry?.items.map((i) => i.quote)).toEqual(['q2']); // 清旧后重写新载荷
  });

  it('CR-13：fallback + routeDecision 在场 → source=reader-audit / route=decision（mirror metadata 通道取值）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'paused',
      pausedStage: 'draft',
      routeDecision: { decision: 'escalate_user', reason: '灰区' },
      escalateFindings: [{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }],
    }));

    await useTestStore.getState().reviewContinue();

    const entry = useTestStore.getState().escalateFindingsBySession['session-1'];
    expect(entry?.source).toBe('reader-audit');
    expect(entry?.route).toBe('escalate_user');
  });

  it('CR-13：fallback 两推断字段都缺 → source/route 省略（可选字段不造数据），items 照写', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'paused',
      pausedStage: 'draft',
      escalateFindings: [{ severity: 'warn', quote: 'q', location: 'l', explanation: 'e' }],
    }));

    await useTestStore.getState().reviewContinue();

    const entry = useTestStore.getState().escalateFindingsBySession['session-1'];
    expect(entry?.source).toBeUndefined();
    expect(entry?.route).toBeUndefined();
    expect(entry?.items).toHaveLength(1);
  });

  it('CR-8：accept 完成、无 envelope、未持久化、非 skip 文案路径 → 面板清场 + 警示 toast（不静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewAcceptFinal();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeUndefined();
    expect(pendingPatchSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    // store locale = en-US（文件级 fixture）——断言英文文案关键片段。
    expect(String(toastSpy.mock.calls[0][0])).toContain('no chapter candidate');
  });

  it('CR-5：reviewAcceptFinal 第三参 feedback → IPC action=accept 载荷透传；缺省不带字段', async () => {
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed', chapterPersisted: true }));

    // escalate 全接受裁决的勾选意见随 accept 透传（feedback 通道无 action 限制）。
    await useTestStore.getState().reviewAcceptFinal(undefined, 'session-1', '#1 [q] 接受为真相\n补充说明：以正文为准');
    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      action: 'accept',
      feedback: '#1 [q] 接受为真相\n补充说明：以正文为准',
    });

    // 缺省（终稿卡 accept）→ 载荷不带 feedback 字段（零回归）。
    apiMocks.resumeChapterChain.mockClear();
    useTestStore.getState().setPausedReview('session-1', finalMeta);
    await useTestStore.getState().reviewAcceptFinal();
    expect(apiMocks.resumeChapterChain.mock.calls[0][0].feedback).toBeUndefined();
  });

  it('CR-18b：accept toast 标题全链缺名 → i18n 兜底键（不落空串标题）', async () => {
    const anonMeta: ChapterReviewMetadata = {
      type: 'chapter_review',
      stage: 'final',
      draftContent: '终稿正文。',
      resumeOptions: ['accept', 'redo', 'abort'],
    };
    useTestStore.getState().setPausedReview('session-1', anonMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed', chapterPersisted: true }));

    await useTestStore.getState().reviewAcceptFinal();

    // draftTitle / chapter_accept.chapterId / meta.chapterId 全缺 → agent.reviewFinalFallback（en: this chapter）。
    expect(String(toastSpy.mock.calls[0][0])).toContain('this chapter');
  });
});

describe('chapterReviewSlice — CR-004 store guard（程序化双触发单 IPC）', () => {
  it('reviewResuming=true 时再调 reviewContinue → no-op（不二次调 IPC，防快捷键/双 Enter 竞态）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    // 模拟首 IPC 在 flight：store guard 读该会话 flight 键直接 return。
    useTestStore.setState({ reviewResumingBySession: { 'session-1': true } });
    apiMocks.resumeChapterChain.mockClear();

    await useTestStore.getState().reviewContinue();

    // guard 挡住：不调 IPC，不改 flight 键（保持 true，由首 IPC 释放）。
    expect(apiMocks.resumeChapterChain).not.toHaveBeenCalled();
    expect(resuming()).toBe(true);
  });

  it('两动作并发触发（reviewContinue + reviewRedo 同步连调，首 IPC 未 set 重渲染前）→ 仅首调 IPC', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    // 同步连调两次（不经 await），模拟快捷键/双 Enter 在 React 重渲染前竞态。
    const p1 = useTestStore.getState().reviewContinue();
    const p2 = useTestStore.getState().reviewRedo('改');
    await Promise.all([p1, p2]);

    // store guard：第二次调用时 reviewResuming 已被首次 set=true → return → 单 IPC。
    expect(apiMocks.resumeChapterChain).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 09-13 子3 W4（design §5.3/F2）：五本地态 BySession 键控——双会话隔离 + 动作 sessionId 尾参
//（写作页后台会话直审：A 会话在途/意图态不顶掉 B 会话；动作按目标会话键读写）。
// ═══════════════════════════════════════════════════════════════════════════
describe('chapterReviewSlice — W4 双会话键控隔离', () => {
  it('A 会话 reviewResuming 在途不挡 B 会话动作（guard 按目标会话键判）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.getState().setPausedReview('session-2', { ...draftMeta, chapterId: 'ch_002' });
    // A 的 resume IPC 在 flight。
    useTestStore.setState({ reviewResumingBySession: { 'session-1': true } });
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue('session-2');

    // B 会话动作照发（不被 A 的 flight 键挡）。
    expect(apiMocks.resumeChapterChain).toHaveBeenCalledTimes(1);
    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-2',
      chapterId: 'ch_002',
      action: 'continue',
    });
    // B 的 flight 键已释放，A 的仍在途（各会话各键）。
    expect(resuming('session-2')).toBe(false);
    expect(resuming('session-1')).toBe(true);
  });

  it('动作尾参 sessionId → 按目标会话的 pausedReview 键读写（B 的 continue 清 B 键、A 键不动）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.getState().setPausedReview('session-2', { ...draftMeta, chapterId: 'ch_002' });
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue('session-2');

    expect(useTestStore.getState().pausedReviewBySession['session-2']).toBeUndefined();
    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
  });

  it('B1 本地态分键隔离：A 的 compiledIntent/selection/error 不影响 B（写作页多卡并存）', () => {
    useTestStore.setState({
      compiledIntentBySession: { 'session-1': SAMPLE_INTENT },
      reviewSelectionBySession: { 'session-1': { text: '战斗开始了', from: 0, to: 5 } },
      intentCompileErrorBySession: { 'session-1': 'boom' },
    });

    // B 会话读各自的键（键缺席 = 缺省态）。
    expect(compiled('session-2')).toBeNull();
    expect(selection('session-2')).toBeNull();
    expect(compileError('session-2')).toBeNull();
    // A 会话原位。
    expect(compiled('session-1')).toEqual(SAMPLE_INTENT);
    expect(selection('session-1')).toEqual({ text: '战斗开始了', from: 0, to: 5 });
    expect(compileError('session-1')).toBe('boom');

    // clearCompiledIntent 尾参只清目标会话。
    useTestStore.getState().clearCompiledIntent('session-2');
    expect(compiled('session-1')).toEqual(SAMPLE_INTENT);
    useTestStore.getState().clearCompiledIntent('session-1');
    expect(compiled('session-1')).toBeNull();
    expect(compileError('session-1')).toBeNull();
  });

  it('compileIntent 尾参 sessionId → intent 态落目标会话键', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: SAMPLE_INTENT });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。', undefined, 'session-2');

    expect(apiMocks.compileRevisionIntent.mock.calls[0][0]).toMatchObject({ sessionId: 'session-2' });
    expect(compiled('session-2')).toEqual(SAMPLE_INTENT);
    expect(compiling('session-2')).toBe(false);
    expect(compiled('session-1')).toBeNull();
  });

  it('clearReviewLocalStateFor 清目标会话五键（deleteAgentSession 清理链）', () => {
    useTestStore.setState({
      reviewResumingBySession: { 'session-1': true, 'session-9': true },
      reviewSelectionBySession: { 'session-1': { text: 'x', from: 0, to: 1 } },
      compiledIntentBySession: { 'session-1': SAMPLE_INTENT },
      intentCompilingBySession: { 'session-1': true },
      intentCompileErrorBySession: { 'session-1': 'e' },
    });

    useTestStore.getState().clearReviewLocalStateFor('session-1');

    expect(resuming('session-1')).toBe(false);
    expect(selection('session-1')).toBeNull();
    expect(compiled('session-1')).toBeNull();
    expect(compiling('session-1')).toBe(false);
    expect(compileError('session-1')).toBeNull();
    // 他会话键不动。
    expect(resuming('session-9')).toBe(true);
  });
});

describe('chapterReviewSlice — CR-002 项目切换 mid-resume 丢弃老结果', () => {
  /** deferred：控制 IPC resolve/reject 时序，模拟 await 期间切项目。 */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('await 期间切项目 → IPC 返 paused summary 不写回新项目 pausedReview（丢弃 + 释放 guard）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const { promise, resolve } = deferred<RunChapterChainSummary>();
    apiMocks.resumeChapterChain.mockReturnValue(promise);

    const inflight = useTestStore.getState().reviewContinue();
    // IPC 在 flight 时切项目（registerProjectReset 清了 pausedReview + currentProject 变更）。
    useTestStore.setState({ pausedReviewBySession: {}, currentProject: { path: '/other-proj' } });

    // resolve 老 IPC（返 paused summary——若不复核会写回新项目 pausedReview）。
    resolve(makeSummary({ status: 'paused', pausedStage: 'verdict' }));
    await inflight;

    // CR-002：老结果丢弃——新项目不该见老链段 pausedReview。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    // guard 释放。
    expect(resuming()).toBe(false);
  });

  it('await 期间切项目 → IPC 返 error summary 不 toast 老 project 错误到新项目', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const { promise, resolve } = deferred<RunChapterChainSummary>();
    apiMocks.resumeChapterChain.mockReturnValue(promise);

    const inflight = useTestStore.getState().reviewContinue();
    useTestStore.setState({ pausedReviewBySession: {}, currentProject: { path: '/other-proj' } });
    resolve(makeSummary({ status: 'error', errors: ['老项目崩了'] }));
    await inflight;

    // CR-002：error 也不 toast 到新项目（静默丢弃）。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(resuming()).toBe(false);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('await 期间切项目 → IPC throw 也不 toast（静默丢弃，不污染新项目）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    const { promise, reject } = deferred<RunChapterChainSummary>();
    apiMocks.resumeChapterChain.mockReturnValue(promise);

    const inflight = useTestStore.getState().reviewContinue();
    useTestStore.setState({ pausedReviewBySession: {}, currentProject: { path: '/other-proj' } });
    reject(new Error('IPC 下线'));
    await inflight;

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(resuming()).toBe(false);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('未切项目（await 前后同 path）→ paused summary 正常写回（CR-002 不误伤 happy path）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'paused', pausedStage: 'verdict' }));

    await useTestStore.getState().reviewContinue();

    // 同项目 → paused summary 正常更新 pausedReview（happy path 不丢）。
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).not.toBeNull();
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)?.stage).toBe('verdict');
  });
});

describe('chapterReviewSlice — 项目隔离 reset', () => {
  it('runProjectResets 清无归属的 pausedReview 残键（跨项目不泄漏）', () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).not.toBeNull();

    runProjectResets();

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    expect(resuming()).toBe(false);
  });

  // dogfood T1 CR-T1-025：「等待用户」挂起键按定义不再产事件——项目重置销毁 = 切回后审阅面板
  // 永久丢（主进程 run 死等只能 abort 救）。有归属（agentEvents 登记）的键跨项目存活；
  // 渲染面按 sessionId 键控隔离（ChapterReviewPanel 只读传入会话的键），不靠删除。
  it('CR-T1-025：有归属的挂起键跨项目存活（切回再现）——离开项目不再销毁', () => {
    rememberSessionProject('session-attr', '/proj-a');
    useTestStore.getState().setPausedReview('session-attr', draftMeta);

    // 切到别的项目（reset 时 currentProject 已是新项目）。
    useTestStore.setState({ currentProject: { path: '/proj-b' } });
    runProjectResets();

    expect(useTestStore.getState().pausedReviewBySession['session-attr']).toBeDefined();
    // 渲染面按 sessionId 键控隔离（ChapterReviewPanel 只读传入会话的键），不靠删除。
  });

  it('W4：五本地态同 owner 过滤——有归属键跨项目存活、无归属键清（mirror pausedReview）', () => {
    rememberSessionProject('session-attr', '/proj-a');
    useTestStore.setState({
      reviewResumingBySession: { 'session-attr': true, 'session-orphan': true },
      compiledIntentBySession: { 'session-orphan': SAMPLE_INTENT },
      reviewSelectionBySession: { 'session-orphan': { text: 'x', from: 0, to: 1 } },
    });
    useTestStore.setState({ currentProject: { path: '/proj-b' } });

    runProjectResets();

    // 有归属（在途 resume 键存活——CR-002 丢弃守卫兜结果侧）；无归属残键清。
    expect(resuming('session-attr')).toBe(true);
    expect(resuming('session-orphan')).toBe(false);
    expect(compiled('session-orphan')).toBeNull();
    expect(selection('session-orphan')).toBeNull();
  });

  it('runProjectResets 清 Story 7.1 B1 state（reviewSelection / compiledIntent / compileError）', () => {
    useTestStore.setState({
      reviewSelectionBySession: { 'session-1': { text: '战斗开始了', from: 0, to: 5 } },
      compiledIntentBySession: { 'session-1': SAMPLE_INTENT },
      intentCompileErrorBySession: { 'session-1': 'boom' },
      intentCompilingBySession: { 'session-1': true },
    });
    runProjectResets();

    expect(selection()).toBeNull();
    expect(compiled()).toBeNull();
    expect(compileError()).toBeNull();
    expect(compiling()).toBe(false);
  });
});

// ── Story 7.1 B1：compileIntent / confirmRedoWithIntent / B1 state ──

describe('chapterReviewSlice — setReviewSelection', () => {
  it('落 SelectionInfo 到 reviewSelection（键控会话）', () => {
    useTestStore.getState().setReviewSelection('session-1', { text: '战斗开始了', from: 0, to: 5 });
    expect(selection()).toEqual({ text: '战斗开始了', from: 0, to: 5 });
    // 分键：他会话不受影响。
    expect(selection('session-2')).toBeNull();
  });

  it('null 清空 reviewSelection', () => {
    useTestStore.getState().setReviewSelection('session-1', { text: '战斗开始了', from: 0, to: 5 });
    useTestStore.getState().setReviewSelection('session-1', null);
    expect(selection()).toBeNull();
  });
});

describe('chapterReviewSlice — compileIntent', () => {
  it('调 compileRevisionIntent IPC（selectedPassage + userInstruction + chapterContext 透传）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: SAMPLE_INTENT });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。', '{"goal":"x"}');

    expect(apiMocks.compileRevisionIntent).toHaveBeenCalledTimes(1);
    expect(apiMocks.compileRevisionIntent.mock.calls[0][0]).toMatchObject({
      projectPath: '/proj',
      sessionId: 'session-1',
      selectedPassage: '战斗开始了',
      userInstruction: '改紧张点',
      chapterContext: '{"goal":"x"}',
    });
  });

  it('IPC 不传 chapterContext（缺省 undefined）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: SAMPLE_INTENT });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    const call = apiMocks.compileRevisionIntent.mock.calls[0][0];
    expect(call.chapterContext).toBeUndefined();
  });

  it('返 intent 非空 → 落 compiledIntent + 清 error + intentCompiling=false', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: SAMPLE_INTENT });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(compiled()).toEqual(SAMPLE_INTENT);
    expect(compileError()).toBeNull();
    expect(compiling()).toBe(false);
  });

  it('返 intent=null + error → 落 intentCompileError（graceful，不假信心不静默）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: null, error: 'optimizer timeout' });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(compiled()).toBeNull();
    expect(compileError()).toBe('optimizer timeout');
    expect(compiling()).toBe(false);
  });

  it('返 intent=null 无 error → 用默认兜底文案（不静默）', async () => {
    apiMocks.compileRevisionIntent.mockResolvedValue({ intent: null });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(compiled()).toBeNull();
    expect(compileError()).toBeTruthy();
    expect(compileError()).not.toBe('');
  });

  it('IPC throw → 落 intentCompileError（graceful，不抛）', async () => {
    apiMocks.compileRevisionIntent.mockRejectedValue(new Error('IPC 下线'));

    await expect(
      useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。'),
    ).resolves.toBeUndefined();

    expect(compiled()).toBeNull();
    expect(compileError()).toBe('IPC 下线');
    expect(compiling()).toBe(false);
  });

  it('intentCompiling=true 时再调 → no-op（防双触发）', async () => {
    useTestStore.setState({ intentCompilingBySession: { 'session-1': true } });
    apiMocks.compileRevisionIntent.mockClear();

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(apiMocks.compileRevisionIntent).not.toHaveBeenCalled();
  });

  it('无 project / sessionId → no-op', async () => {
    useTestStore.setState({ currentProject: null });

    await useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');

    expect(apiMocks.compileRevisionIntent).not.toHaveBeenCalled();
  });

  it('await 期间切项目 → IPC 返 intent 不写回新项目 compiledIntent（丢弃 + 释放 guard）', async () => {
    /** deferred：控制 IPC resolve 时序，模拟 await 期间切项目。 */
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }
    const { promise, resolve } = deferred<CompileRevisionIntentResult>();
    apiMocks.compileRevisionIntent.mockReturnValue(promise);

    const inflight = useTestStore.getState().compileIntent('战斗开始了', '改紧张点', 0, 5, '前文。战斗开始了。后文。');
    useTestStore.setState({ currentProject: { path: '/other-proj' } });
    resolve({ intent: SAMPLE_INTENT });
    await inflight;

    // CR-002 同款：老结果丢弃——新项目不该见老 compiledIntent。
    expect(compiled()).toBeNull();
    expect(compiling()).toBe(false);
  });
});

describe('chapterReviewSlice — confirmRedoWithIntent', () => {
  it('调 resumeChapterChain IPC（action=redo + revisionIntent 透传 + 清 B1 state）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({
      reviewSelectionBySession: { 'session-1': { text: '战斗开始了', from: 0, to: 5 } },
      compiledIntentBySession: { 'session-1': SAMPLE_INTENT },
      intentCompileErrorBySession: { 'session-1': 'stale error' },
    });
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect(apiMocks.resumeChapterChain).toHaveBeenCalledTimes(1);
    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({
      projectPath: '/proj',
      sessionId: 'session-1',
      chapterId: 'ch_001',
      action: 'redo',
      revisionIntent: SAMPLE_INTENT,
    });
    // B1 state 清空。
    expect(compiled()).toBeNull();
    expect(selection()).toBeNull();
    expect(compileError()).toBeNull();
  });

  it('不传 feedback（intent 单独触发，C-trigger feedback 路径不混）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect(apiMocks.resumeChapterChain.mock.calls[0][0].feedback).toBeUndefined();
    expect(apiMocks.resumeChapterChain.mock.calls[0][0].revisionIntent).toEqual(SAMPLE_INTENT);
  });

  it('paused summary → 更新 pausedReview（链段在下一 checkpoint 又停，B1 state 已清）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({
      compiledIntentBySession: { 'session-1': SAMPLE_INTENT },
    });
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'draft', draftContent: '改后正文…' }),
    );

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    const next = (useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null);
    expect(next?.stage).toBe('draft');
    expect(next?.draftContent).toBe('改后正文…');
    // B1 state 已清（避免下一 checkpoint 残留旧 intent card）。
    expect(compiled()).toBeNull();
    expect(resuming()).toBe(false);
  });

  it('completed summary → 清 pausedReview', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect((useTestStore.getState().pausedReviewBySession[useTestStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  it('reviewResuming=true 时再调 → no-op（防重入）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    useTestStore.setState({ reviewResumingBySession: { 'session-1': true } });
    apiMocks.resumeChapterChain.mockClear();

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT);

    expect(apiMocks.resumeChapterChain).not.toHaveBeenCalled();
  });

  it('W4 尾参 sessionId：confirmRedoWithIntent(intent, sid) → 目标会话的 intent 键清理 + IPC sid', async () => {
    useTestStore.getState().setPausedReview('session-2', { ...draftMeta, chapterId: 'ch_002' });
    useTestStore.setState({ compiledIntentBySession: { 'session-2': SAMPLE_INTENT } });
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().confirmRedoWithIntent(SAMPLE_INTENT, 'session-2');

    expect(apiMocks.resumeChapterChain.mock.calls[0][0]).toMatchObject({ sessionId: 'session-2', chapterId: 'ch_002' });
    expect(compiled('session-2')).toBeNull();
  });
});

describe('chapterReviewSlice — clearCompiledIntent', () => {
  it('清 compiledIntent + intentCompileError', () => {
    useTestStore.setState({
      compiledIntentBySession: { 'session-1': SAMPLE_INTENT },
      intentCompileErrorBySession: { 'session-1': 'stale' },
    });

    useTestStore.getState().clearCompiledIntent();

    expect(compiled()).toBeNull();
    expect(compileError()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 09-13 子3 W4（design §4.3）：metadataFromPausedSummary final 扩展——stage='final' →
// reviewSummary + lintReport + resumeOptions 注入 'accept'（interim 版缺 accept 注入，单源收敛）。
// ═══════════════════════════════════════════════════════════════════════════
describe('chapterReviewSlice — metadataFromPausedSummary final 扩展（W4）', () => {
  it('paused final summary → stage=final + reviewSummary + lintReport + resumeOptions 含 accept', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'paused',
      pausedStage: 'final',
      draftContent: '终稿正文…',
      reviewSummary: { verdict: 'pass', reasons: ['去味干净'], loopCount: 2, capExhausted: false },
      lintReport: '去味终态：0 命中（干净）。',
    }));

    await useTestStore.getState().reviewContinue();

    const next = useTestStore.getState().pausedReviewBySession['session-1'];
    expect(next?.stage).toBe('final');
    expect(next?.reviewSummary).toEqual({ verdict: 'pass', reasons: ['去味干净'], loopCount: 2, capExhausted: false });
    expect(next?.lintReport).toBe('去味终态：0 命中（干净）。');
    // accept 注入（终稿审阅卡动作依赖——interim 版缺，本版补）。
    expect(next?.resumeOptions).toEqual(['accept', 'redo', 'abort']);
    // chapterId 保留透传。
    expect(next?.chapterId).toBe('ch_001');
  });

  it('final 但 reviewSummary/lintReport 缺席 → 字段不造数据（缺省不写）', () => {
    const meta = metadataFromPausedSummary(makeSummary({ status: 'paused', pausedStage: 'final' }));
    expect(meta.stage).toBe('final');
    expect(meta.reviewSummary).toBeUndefined();
    expect(meta.lintReport).toBeUndefined();
    expect(meta.resumeOptions).toEqual(['accept', 'redo', 'abort']);
  });

  it('非 final paused（draft/verdict）→ resumeOptions 照旧三钮（零回归）', () => {
    expect(metadataFromPausedSummary(makeSummary({ status: 'paused', pausedStage: 'draft' })).resumeOptions)
      .toEqual(['continue', 'redo', 'abort']);
    expect(metadataFromPausedSummary(makeSummary({ status: 'paused', pausedStage: 'verdict' })).resumeOptions)
      .toEqual(['continue', 'redo', 'abort']);
  });

  it('挂起（researchSuspension）→ resumeOptions 无 continue 无 accept（#83/#84 语义保持）', () => {
    const meta = metadataFromPausedSummary(makeSummary({
      status: 'paused',
      pausedStage: 'draft',
      researchSuspension: {
        kind: 'research_contradiction',
        rounds: 1,
        evidence: { contradictions: [], deviations: [] },
      },
    }));
    expect(meta.resumeOptions).toEqual(['redo', 'abort']);
    expect(meta.researchSuspension?.kind).toBe('research_contradiction');
  });
});

// ── Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺路由（shell applyStorySyncOnResume 产出消费）──

// ═══════════════════════════════════════════════════════════════════════════
// dogfood R2 #93（P0-2/P0-3，2026-08-28）：resume 终态 chapter_accept envelope 路由 + 完成回报。
// resume 车道跑在 leader 工具调用生命周期外——write_chapter 的 metadata field_patch 通道走不到，
// envelope 只能经 resume summary 返 UI（shell review 档不直落）。此处 mirror agentEvents 的
// field_patch 路由形态（field/action/data 与 write-chapter.ts metadata 组装逐字段对齐）。
// ═══════════════════════════════════════════════════════════════════════════

describe('chapterReviewSlice — #93 P0-2/P0-3 resume 终态 chapter_accept envelope 路由', () => {
  const ACCEPT = {
    chapterId: 'ch_001',
    candidate: { title: '第二章 B 城', content: '正文…', wordCount: 2800 },
    runId: 'run_mock',
  };

  it('completed + chapter_accept + 未直落 → setPendingPatch（chapter_candidate entry，mirror leader metadata 形态）+ 完成 toast', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      draftTitle: '第二章 B 城',
      draftWordCount: 2800,
      routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
      chapter_accept: ACCEPT,
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).toHaveBeenCalledTimes(1);
    const [sid, patch] = pendingPatchSpy.mock.calls[0] as [string, import('@orison/shared-contracts').ProjectFieldPatch];
    expect(sid).toBe('session-1');
    expect(patch.runId).toBe('session-1');
    expect(patch.patches).toHaveLength(1);
    expect(patch.patches[0].field).toBe('chapter_candidate');
    expect(patch.patches[0].action).toBe('set');
    expect(patch.patches[0].generatedBy).toBe('write_chapter');
    expect(patch.patches[0].data).toMatchObject({ chapterId: 'ch_001', runId: 'run_mock' });
    // P0-3 完成回报：toast 含标题 + 字数 + 下一步动作（去审阅）。
    const toastText = String(toastSpy.mock.calls[0][0]);
    expect(toastText).toContain('写章完成');
    expect(toastText).toContain('第二章 B 城');
    expect(toastText).toContain('2800');
    expect(toastText).toContain('待审阅');
  });

  it('completed + escalate 路由 + chapter_accept → 同样 stage + 灰区裁决 toast（PatchReview accept=接受为真相）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      routeDecision: { decision: 'escalate_user', reason: '灰区' },
      chapter_accept: ACCEPT,
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('灰区裁决');
  });

  it('completed + chapterPersisted（auto 档 shell 已直落）→ 不 stage（防双写）+ 落盘 toast', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      draftTitle: '第二章 B 城',
      routeDecision: { decision: 'accept_as_truth', reason: 'r' },
      chapter_accept: ACCEPT,
      chapterPersisted: true,
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    const toastText = String(toastSpy.mock.calls[0][0]);
    expect(toastText).toContain('写章完成');
    expect(toastText).toContain('已直接落盘');
  });

  it('completed + accept 路由但无 envelope（章映射失败 skip）→ 不 stage + error toast 透传 errors（不静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      routeDecision: { decision: 'accept_as_truth', reason: 'r' },
      errors: ['accept 未持久化——章未在 project.yaml 注册或映射歧义'],
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    const toastText = String(toastSpy.mock.calls[0][0]);
    expect(toastText).toContain('未生成章节候选');
    expect(toastText).toContain('accept 未持久化');
  });

  it('completed + escalate 路由但无 envelope（灰区无候选——shell review 档 errors 文案）→ 不 stage + error toast 消费（check 补：escalate 分支不静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      routeDecision: { decision: 'escalate_user', reason: '灰区' },
      errors: ['灰区上发：无章节候选（章未在 project.yaml 注册或映射歧义）——无法落盘，请在对话中裁决处理'],
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    const toastText = String(toastSpy.mock.calls[0][0]);
    expect(toastText).toContain('未生成章节候选');
    expect(toastText).toContain('灰区上发');
    expect(toastText).toContain('请在对话中裁决处理');
  });

  it('aborted（continue 被动中断）→ 不 stage envelope + 面板保留 + 中断 toast（弃链段无候选可审，不静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    // R2 #105 缓①：被动中断保留面板（旧实现清场 + 零告知）。
    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('kept');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dogfood R2 #83/#84（2026-08-28）：挂起 pause 载荷透传——resume 后再挂起时 metadataFromPausedSummary
// 须带 researchSuspension + resumeOptions=['redo','abort']（无 continue：挂起无正文可续，continue 是
// 死循环入口）。
// ═══════════════════════════════════════════════════════════════════════════

describe('chapterReviewSlice — #83/#84 挂起 pause 载荷透传（metadataFromPausedSummary）', () => {
  it('paused summary 带 researchSuspension → meta 透传挂起载荷 + resumeOptions 无 continue', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'paused',
      pausedStage: 'draft',
      researchSuspension: {
        kind: 'research_contradiction',
        rounds: 1,
        evidence: {
          contradictions: [{ desc: '爽点底线 vs 女主第一章未登场', severity: 'contradiction' }],
          deviations: [],
        },
      },
    }));

    await useTestStore.getState().reviewContinue();

    const next = useTestStore.getState().pausedReviewBySession['session-1'];
    expect(next).not.toBeNull();
    expect(next?.researchSuspension?.kind).toBe('research_contradiction');
    expect(next?.researchSuspension?.evidence?.contradictions).toHaveLength(1);
    // 挂起恢复只有 redo（无 continue）——#84 死循环入口封死。
    expect(next?.resumeOptions).toEqual(['redo', 'abort']);
  });

  it('paused summary 无挂起载荷（真 draft checkpoint）→ 三钮照旧（零回归）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(
      makeSummary({ status: 'paused', pausedStage: 'draft', draftContent: '改后的草稿…' }),
    );

    await useTestStore.getState().reviewContinue();

    const next = useTestStore.getState().pausedReviewBySession['session-1'];
    expect(next?.researchSuspension).toBeUndefined();
    expect(next?.resumeOptions).toEqual(['continue', 'redo', 'abort']);
  });
});

describe('chapterReviewSlice — resume 终态反哺路由（storySyncReview / storySyncLanded）', () => {
  it('storySyncReview（suggest 人审档）→ setPendingPatch 进 PatchReview + info toast（非静默）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      storySyncReview: {
        note: '章节 ch_001 story-sync 提取',
        patches: [
          { field: 'world_setting', action: 'set', data: { premise: 'x' }, fieldVersion: 1, generatedBy: 'story-sync-agent' },
        ],
      },
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).toHaveBeenCalledTimes(1);
    const patch = pendingPatchSpy.mock.calls[0][1]!;
    expect(patch.patches).toHaveLength(1);
    expect(patch.patches[0].field).toBe('world_setting');
    expect(patch.patches[0].generatedBy).toBe('story-sync-agent');
    expect(String(toastSpy.mock.calls[0][0])).toContain('待审阅');
  });

  it('storySyncLanded（auto 直落档）→ success toast，不 stage patch', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      storySyncLanded: { note: '章节 ch_001 story-sync 提取', fields: ['world_setting', 'asset_cards'] },
    }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    expect(String(toastSpy.mock.calls[0][0])).toContain('已自动落盘');
    expect(String(toastSpy.mock.calls[0][0])).toContain('world_setting');
  });

  it('无反哺载荷（缺省）→ 零动作（无 stage 无 toast）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue();

    expect(pendingPatchSpy).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dogfood T1 CR-T1-027：链 IPC busy 拒绝（机器串）消费——project_run_active / chain_run_active
// 前缀解析为人话 + 跳转；pausedReview 保留（run 未启动，busy run 结束后可重试——旧实现
// join(';') 透出机器串 + 误清面板丢 resume 能力）。
// ═══════════════════════════════════════════════════════════════════════════
describe('chapterReviewSlice — CR-T1-027 busy 拒绝（机器串解析）', () => {
  it('project_run_active → pausedReview 保留 + reviewResuming 复位 + busy toast 带跳转（占用会话）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['project_run_active|heldBy=sess-other|project=/proj'],
    }));

    await useTestStore.getState().reviewContinue();

    // 面板保留（busy run 未动 chainSnapshot——结束后可重试），不透出机器串。
    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(resuming()).toBe(false);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).not.toContain('project_run_active');
    const action = toastSpy.mock.calls[0][3] as { label: string; onClick: () => void } | undefined;
    expect(action?.label).toBeTruthy(); // 一键跳转钮（与 chat 路径同款体验）
    action?.onClick();
    expect(switchAgentSessionSpy).toHaveBeenCalledWith('sess-other');
  });

  it('chain_run_active（agent 层链守卫，批2 前缀）→ pausedReview 保留 + 提示等待（无跳转钮）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['chain_run_active|heldBy=sess-leader'],
    }));

    await useTestStore.getState().reviewContinue();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(resuming()).toBe(false);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).not.toContain('chain_run_active');
    expect(toastSpy.mock.calls[0][3]).toBeUndefined(); // 链在跑——跳过去也只能等，无跳转钮
    expect(switchAgentSessionSpy).not.toHaveBeenCalled();
  });

  it('占用者为链租约 id（chain-run:closure:*）→ 换文案无跳转（CR-T1-030——stub 会话不可跳）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['project_run_active|heldBy=chain-run:closure:9f0e|project=/proj'],
    }));

    await useTestStore.getState().reviewContinue();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][3]).toBeUndefined(); // 无跳转
    expect(switchAgentSessionSpy).not.toHaveBeenCalled();
  });

  it('非 busy error（无前缀）→ 不走 busy 路径：被动中断分流保留面板 + 中断 toast 透传原因（无跳转钮）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['chapter chain failed: boom'],
    }));

    await useTestStore.getState().reviewContinue();

    // R2 #105 缓①改语义：非 busy 的 error 同为被动失败——面板保留，但 toast 是中断告知
    //（含原因）非 busy 跳转形态。
    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('boom');
    expect(toastSpy.mock.calls[0][3]).toBeUndefined(); // 非 busy——无跳转动作钮
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dogfood R2 #105 缓①（2026-08-30）：resume 终态和解按「中断是否用户主动」分流——
// continue/redo 返 aborted/error（被动中断/失败）保留 pausedReview（mirror busy 分支「原样
// 保留」哲学）+ reviewResuming 复位 + toast；abort（用户主动放弃）维持清场。catch 路径同款。
// ═══════════════════════════════════════════════════════════════════════════
describe('chapterReviewSlice — #105 缓① 被动中断保留审阅卡（action 分流）', () => {
  it('redo 返 aborted → 保留 pausedReview + 中断 toast（redo 同享分流，非 continue 专属）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewRedo('改开头');

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(resuming()).toBe(false);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('interrupted');
  });

  it('redo 返 error（带 errors）→ 保留 + toast 含原因（WithReason 键）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({
      status: 'error',
      errors: ['zen gateway timeout'],
    }));

    await useTestStore.getState().reviewRedo();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeDefined();
    expect(String(toastSpy.mock.calls[0][0])).toContain('zen gateway timeout');
  });

  it('abort 返 aborted → 维持清场（用户主动放弃——决策已做完，不留面板）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted' }));

    await useTestStore.getState().reviewAbort();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeUndefined();
    expect(resuming()).toBe(false);
  });

  it('continue 返 completed → 照旧清场（完成非中断，分流不误伤 happy path）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'completed' }));

    await useTestStore.getState().reviewContinue();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeUndefined();
  });

  it('IPC throw（abort）→ 维持清场 + 既有失败 toast（catch 路径 abort 分流）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockRejectedValue(new Error('IPC 下线'));

    await useTestStore.getState().reviewAbort();

    expect(useTestStore.getState().pausedReviewBySession['session-1']).toBeUndefined();
    expect(resuming()).toBe(false);
    expect(String(toastSpy.mock.calls[0][0])).toContain('IPC 下线');
  });

  it('aborted 无 errors → toast 用无原因键（不透出空括号机器串）', async () => {
    useTestStore.getState().setPausedReview('session-1', draftMeta);
    apiMocks.resumeChapterChain.mockResolvedValue(makeSummary({ status: 'aborted', errors: [] }));

    await useTestStore.getState().reviewContinue();

    const text = String(toastSpy.mock.calls[0][0]);
    expect(text).not.toContain('{reason}');
    expect(text).not.toContain('（）');
    expect(text).not.toContain('()');
  });
});
