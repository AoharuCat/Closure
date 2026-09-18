/**
 * Story 4.3 Step 4（design §3.6 / §5）：ChapterReviewPanel 渲染 + 三动作转发测。
 * Story 7.1 B1（design §4.2）：选区指挥精修扩展（selection → compile → confirm wiring）测。
 *
 * 覆盖：
 * - null guard（pausedReview=null → 渲染空）。
 * - draft stage：渲染 draftContent（TipTap mock 显示 text）+ wordcount + redo feedback textarea + 三按钮。
 * - brief stage：渲染 briefContent（不崩，design §5 brief 软门 = Step 5）。
 * - verdict stage：轻提示（verdict review = 4.6 PatchReview，本面板不重复）。
 * - 三按钮点击 → forward 到 slice actions（mock vi.fn 断言转发，不测 slice 语义——slice 语义在
 *   chapterReviewSlice.test.ts 覆盖，PatchReviewPanel.test.tsx 同约定）。
 * - reviewResuming / intentCompiling 禁用相关按钮 + textarea（防重入）。
 * - 项目隔离 reset（pausedReview 清空，panel 卸载）。
 * - Story 7.1 B1：选区非空 → 显示「指挥这段」面板 + 编译按钮 → compileIntent 调用参数；
 *   compiledIntent set → 确认卡片渲染 + 确认按钮 → confirmRedoWithIntent 调用；
 *   intentCompileError 显示；edit mode JSON parse 失败 / 成功；clear/dismiss 流程。
 * - Story 3.7 WP5（design D6/D7）：revision-guard stage guard findings 换 InsightCard
 *   （纯展示降级卡：无 per-finding 应用/忽略；evidence before→after + explanation 仅展开态）；
 *   卡级三档（forceAcceptGuard/reviewAbort）行为回归；#6 Intent 确认卡 insight-* 视觉对齐断言
 *   （badge 位 / 共用按钮 class；内容与操作断言由上方 7.1 B1 既有用例守恒）。
 *
 * 测试照 ui/testing.md：直接 useAppStore.setState 注入 pausedReview + mock actions。
 * TiptapEditor mock 成简单 `<pre>`（jsdom 不支持 ProseMirror；选区直接经 store 注入，bypass editor）。
 */
import { cleanup, screen, render, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterReviewPanel } from '../src/features/writing/ChapterReviewPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import type { ChapterReviewMetadata, RevisionIntent } from '@orison/shared-contracts';

// Mock TiptapEditor——jsdom 不支持 ProseMirror；测试经 store 注入 reviewSelection bypass editor。
vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '' }: { content?: string }) => (
    <pre data-testid="mock-tiptap">{content}</pre>
  ),
}));

const draftMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'draft',
  chapterId: 'ch_001',
  draftContent: '第一章草稿正文。这是测试内容。',
  resumeOptions: ['continue', 'redo', 'abort'],
};

const briefMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'brief',
  briefContent: { goal: ' Establish stakes' },
  resumeOptions: ['continue', 'redo', 'abort'],
};

const verdictMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'verdict',
  resumeOptions: ['continue', 'redo', 'abort'],
};

// 链流程重排 W2 + CR-18 interim：终稿 checkpoint 载荷（write-chapter.ts:3234 产
// resumeOptions=['accept','redo','abort']；draftContent 正文全文 + reviewSummary/lintReport 终态）。
const finalMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'final',
  chapterId: 'ch_001',
  draftContent: '终稿正文。AI 自审收敛后的版本。',
  resumeOptions: ['accept', 'redo', 'abort'],
  reviewSummary: { verdict: 'pass', reasons: ['去味干净'], loopCount: 1, capExhausted: false },
  lintReport: '去味终态：0 命中（干净）。',
};

// dogfood R2 #83/#84（2026-08-28）：写前挂起 pause（出发核查矛盾/偏离，无草稿）——resumeOptions=
// ['redo','abort']（write_chapter 挂起分支产）+ researchSuspension 载荷（矛盾 + 偏离明细各一）。
const suspensionMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'draft',
  chapterId: 'ch_001',
  researchSuspension: {
    kind: 'research_contradiction',
    rounds: 1,
    evidence: {
      contradictions: [{ desc: '爽点底线 vs 女主第一章未登场', severity: 'contradiction' }],
      deviations: [
        { scene_ref: 's1', plan_says: '按大纲登场', brief_says: '延后登场', reason: 'pacing' },
      ],
    },
  },
  resumeOptions: ['redo', 'abort'],
};

// Story 7.2 + 3.7 #4：revision-guard soft-violation art-mode 卡载荷（findings：词表内 pattern +
// 词表外 pattern + 空 evidence——三者覆盖 InsightCard 降级分支；evidence 字符串与 beforeText/
// afterText 无子串重叠，避 SideBySideDiff 词级 diff 渲染串测试查询歧义）。
const guardMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'revision-guard',
  chapterId: 'ch_001',
  revisionGuard: {
    verdict: 'soft-violation',
    summary: 'AI 改稿疑似越界 2 处',
    beforeText: '他把杯子放下，转身离开。',
    afterText: '他把杯子放下了，转身走了。',
    findings: [
      {
        pattern: 'semantic-retreat',
        violatedScope: '角色性格',
        authority: 'hard',
        evidence: {
          before: '指尖发白（攥紧）',
          after: '指尖放松',
          explanation: '紧张的动作外化被删，角色状态倒退。',
        },
      },
      {
        pattern: 'brand-new-drift',
        violatedScope: 'tone',
        authority: 'soft',
        evidence: { before: '', after: '', explanation: '词表外新模式（显原文不编标签）。' },
      },
    ],
  },
  resumeOptions: ['continue', 'redo', 'abort'],
};

const SAMPLE_INTENT: RevisionIntent = {
  change: { summary: '把战斗节奏改紧张' },
  lockedItems: [
    { field: '角色性格', authority: 'hard', evidence: '别动角色性格' },
    { field: '结论', authority: 'soft' },
  ],
  rationale: { source: 'user-directive', note: '用户选段指挥精修' },
  provenance: {
    rawUserInstruction: '这段战斗改紧张点，别动角色性格',
    compilerNote: '锁定角色性格；推断也别动结论',
  },
};

describe('ChapterReviewPanel', () => {
  let reviewContinue: ReturnType<typeof vi.fn>;
  let reviewRedo: ReturnType<typeof vi.fn>;
  let reviewAbort: ReturnType<typeof vi.fn>;
  let setReviewSelection: ReturnType<typeof vi.fn>;
  let compileIntent: ReturnType<typeof vi.fn>;
  let confirmRedoWithIntent: ReturnType<typeof vi.fn>;
  let clearCompiledIntent: ReturnType<typeof vi.fn>;
  // Story 7.2 / 3.7 WP5：guard 卡三档之「强行放行」action（改指令/取消复用 reviewAbort）。
  let forceAcceptGuard: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reviewContinue = vi.fn().mockResolvedValue(undefined);
    reviewRedo = vi.fn().mockResolvedValue(undefined);
    reviewAbort = vi.fn().mockResolvedValue(undefined);
    setReviewSelection = vi.fn();
    compileIntent = vi.fn().mockResolvedValue(undefined);
    confirmRedoWithIntent = vi.fn().mockResolvedValue(undefined);
    clearCompiledIntent = vi.fn();
    forceAcceptGuard = vi.fn().mockResolvedValue(undefined);

    useAppStore.setState({
      resolvedLocale: 'en-US',
      pausedReviewBySession: {},
      // 09-13 子3 W4：五本地态 BySession 键控（键缺席 = 缺省态）。
      reviewResumingBySession: {},
      reviewContinue,
      reviewRedo,
      reviewAbort,
      // Story 7.1 B1 slice state defaults.
      reviewSelectionBySession: {},
      compiledIntentBySession: {},
      intentCompilingBySession: {},
      intentCompileErrorBySession: {},
      setReviewSelection,
      compileIntent,
      confirmRedoWithIntent,
      clearCompiledIntent,
      forceAcceptGuard,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when pausedReview is null', () => {
    render(<ChapterReviewPanel />);
    expect(screen.queryByRole('region', { name: 'Chapter review' })).toBeNull();
  });

  it('renders draft content + wordcount + three actions when pausedReview.stage=draft', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta } } as any);

    render(<ChapterReviewPanel />);

    // Title + draft checkpoint stage label.
    expect(screen.getByText('Chapter review')).toBeTruthy();
    expect(screen.getByText('Draft checkpoint')).toBeTruthy();
    // Draft prose payload (rendered via TiptapEditor mock as <pre>).
    expect(screen.getByTestId('mock-tiptap').textContent).toBe('第一章草稿正文。这是测试内容。');
    // Wordcount（draftContent.length 字符数）。
    expect(screen.getByText(/characters/)).toBeTruthy();
    // Three action buttons.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redo draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
  });

  it('forwards Continue to reviewContinue', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta } } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(reviewContinue).toHaveBeenCalledTimes(1);
  });

  it('forwards Redo draft to reviewRedo with typed feedback (then clears the textarea)', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta } } as any);

    render(<ChapterReviewPanel />);
    const textarea = screen.getByPlaceholderText('Revision feedback (optional)') as HTMLTextAreaElement;
    await userEvent.type(textarea, '把开头改紧张');
    await userEvent.click(screen.getByRole('button', { name: 'Redo draft' }));

    // W4：动作尾参携目标会话（props 缺席 → 视图会话 sid）。
    expect(reviewRedo).toHaveBeenCalledWith('把开头改紧张', 'sess-cr');
  });

  it('forwards Redo draft with undefined when feedback empty (no-instruction rerun合法)', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta } } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Redo draft' }));

    expect(reviewRedo).toHaveBeenCalledWith(undefined, 'sess-cr');
  });

  it('forwards Abort to reviewAbort', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta } } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Abort' }));

    expect(reviewAbort).toHaveBeenCalledTimes(1);
  });

  it('disables all action buttons + textarea while reviewResuming', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta }, reviewResumingBySession: { 'sess-cr': true } } as any);

    render(<ChapterReviewPanel />);

    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Redo draft' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Abort' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText('Revision feedback (optional)') as HTMLTextAreaElement).disabled).toBe(true);
    // Resuming hint surfaces.
    expect(screen.getByText('Resuming...')).toBeTruthy();
  });

  it('renders brief stage payload without crashing (Step 5 soft-gate is out of scope)', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': briefMeta } } as any);

    render(<ChapterReviewPanel />);

    expect(screen.getByText('Brief checkpoint')).toBeTruthy();
    // briefContent（object）→ JSON 序列化兜底显示（至少能看 + 不崩）。
    expect(screen.getByText(/Establish stakes/)).toBeTruthy();
    // brief stage 无 redo（redo 语义是改 draft；brief 无 draft 可改）。
    expect(screen.queryByRole('button', { name: 'Redo draft' })).toBeNull();
    // continue / abort 仍可用。
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
  });

  it('renders verdict stage hint (verdict review uses 4.6 PatchReview, not this panel)', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': verdictMeta } } as any);

    render(<ChapterReviewPanel />);

    expect(screen.getByText('Verdict checkpoint')).toBeTruthy();
    expect(screen.getByText('Verdict review is in the patch review above.')).toBeTruthy();
    // verdict stage 无 redo（无 draft 可改）。
    expect(screen.queryByRole('button', { name: 'Redo draft' })).toBeNull();
  });

  // ── dogfood R2 #83/#84（2026-08-28）：写前挂起说明卡（无草稿不弹审阅卡，redo/abort 无 continue）──

  it('#83/#84：挂起 pause 渲染挂起说明卡（矛盾/偏离明细 + redo/abort），无「继续写」/无草稿区', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': suspensionMeta } } as any);

    render(<ChapterReviewPanel />);

    // 挂起说明卡（region）+ 头部提示 + 明细（矛盾 + 偏离逐条）。
    expect(screen.getByRole('region', { name: 'Chapter suspended' })).toBeTruthy();
    expect(screen.getByText(/contradictions between the task brief/i)).toBeTruthy();
    expect(screen.getByText(/爽点底线 vs 女主第一章未登场/)).toBeTruthy();
    expect(screen.getByText(/s1/)).toBeTruthy();
    // 无草稿区（挂起未动笔——不再出现「本 checkpoint 无正文载荷」的误导空态）。
    expect(screen.queryByTestId('mock-tiptap')).toBeNull();
    expect(screen.queryByText('No content at this checkpoint.')).toBeNull();
    // 按钮矩阵由 resumeOptions 驱动：redo + abort，无「继续写」（死循环入口封死）。
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Redo draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
  });

  it('#83/#84 + W5 D-c：挂起卡 redo 意见必填——空意见禁用；填意见 → reviewRedo(feedback, sid)', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': suspensionMeta } } as any);

    render(<ChapterReviewPanel />);
    // D-c（design §4.2）：挂起重跑 = 携意见（文字必填）——空意见禁用提交（防 AI 瞎猜恢复方向）。
    const redo = screen.getByRole('button', { name: 'Redo draft' });
    expect(redo).toBeDisabled();
    expect(screen.getByText(/Empty notes cannot/)).toBeTruthy();

    await userEvent.type(screen.getByPlaceholderText(/how the contradiction/), '以正文为准：开场改雨渐停');
    expect(redo).toBeEnabled();
    await userEvent.click(redo);

    expect(reviewRedo).toHaveBeenCalledWith('以正文为准：开场改雨渐停', 'sess-cr');
  });

  it('W5 D-c：brief 打回规划环意见必填 + 键名 agent.briefRedo（redo 走 brief-compiler 重编）', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': briefMeta } } as any);

    render(<ChapterReviewPanel />);
    const redo = screen.getByRole('button', { name: 'Send plan loop back' });
    expect(redo).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/Hook swap/), '钩子换掉');
    expect(redo).toBeEnabled();
    await userEvent.click(redo);

    expect(reviewRedo).toHaveBeenCalledWith('钩子换掉', 'sess-cr');
  });

  it('#83/#84：真 draft checkpoint（resumeOptions 三钮）按钮照旧（零回归）', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': { ...draftMeta, resumeOptions: ['continue', 'redo', 'abort'] } } } as any);

    render(<ChapterReviewPanel />);

    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redo draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
  });

  it('#83/#84 check belt：挂起载荷 resumeOptions 带 continue（异常/旧回放载荷）→「继续写」仍结构性隐藏（渲染层封死死循环入口）', () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': { ...suspensionMeta, resumeOptions: ['continue', 'redo', 'abort'] } },
    } as any);

    render(<ChapterReviewPanel />);

    // 挂起卡无「继续写」不只靠上游载荷卫生——researchSuspension 在场即恒封 continue（双 belt）。
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Redo draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
  });

  it('project-switch reset clears pausedReview → panel unmounts', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta } } as any);
    const { unmount } = render(<ChapterReviewPanel />);
    expect(screen.getByText('Chapter review')).toBeTruthy();

    runProjectResets();

    expect((useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
    unmount();
    // 再渲染 panel 应为空（pausedReview 已清）。
    render(<ChapterReviewPanel />);
    expect(screen.queryByText('Chapter review')).toBeNull();
  });

  // ── Story 7.2 revision-guard stage + Story 3.7 #4（design D6）：guard findings 卡片化 ──

  it('renders guard findings as InsightCards (pattern label / vocab-outside raw / badges, no per-finding apply-ignore)', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': guardMeta } } as any);

    render(<ChapterReviewPanel />);

    // 卡级要素原位：stage 标签（header badge + guard 卡 h4 两处）+ findings 区标题。
    expect(screen.getAllByText('Meaning preservation').length).toBe(2);
    expect(screen.getByText('Violations')).toBeTruthy();
    // per-finding InsightCard title = pattern 标签（词表内 GUARD_DRIFT_PATTERN_LABELS_ZH）+ violatedScope。
    expect(screen.getByText('语义/动作倒退：角色性格')).toBeTruthy();
    // 词表外 pattern 显原文（不编造标签）。
    expect(screen.getByText('brand-new-drift：tone')).toBeTruthy();
    // 来源 badge（sourceRevisionGuard）per-finding 一枚 + 维度 badge = pattern 原文（与 title 不重复）。
    expect(screen.getAllByText('Meaning guard').length).toBe(2);
    expect(screen.getByText('semantic-retreat')).toBeTruthy();
    // 纯展示降级卡（D6）：per-finding 无应用/忽略按钮——per-finding 无执行语义，卡级三档才是决策单位。
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ignore' })).toBeNull();
    // 卡级三档原位（行为转发断言见下一用例）。
    expect(screen.getByRole('button', { name: 'Force accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revise instruction' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('guard finding evidence before→after + explanation only in expanded state (InsightCard grounding contract)', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': guardMeta } } as any);

    render(<ChapterReviewPanel />);

    // 折叠态：before/after（体积大仅展开态）+ explanation（children）不渲染；空 evidence 不造数据。
    expect(screen.queryByText('指尖发白（攥紧）')).toBeNull();
    expect(screen.queryByText('紧张的动作外化被删，角色状态倒退。')).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: 'Expand' })[0]);

    // 展开态：grounding before→after + explanation 全文。
    expect(screen.getByText('指尖发白（攥紧）')).toBeTruthy();
    expect(screen.getByText('指尖放松')).toBeTruthy();
    expect(screen.getByText('紧张的动作外化被删，角色状态倒退。')).toBeTruthy();
  });

  it('guard three actions forward unchanged: Force accept→forceAcceptGuard, Revise/Cancel→reviewAbort (behavior regression)', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': guardMeta } } as any);

    render(<ChapterReviewPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Force accept' }));
    expect(forceAcceptGuard).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Revise instruction' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(reviewAbort).toHaveBeenCalledTimes(2);
  });

  it('guard card with no findings renders empty hint + keeps three actions (branch regression)', () => {
    useAppStore.setState({
      pausedReviewBySession: { 'sess-cr': {
        ...guardMeta,
        revisionGuard: { verdict: 'clean', skipped: true, summary: 'pass-through' },
      } },
    } as any);

    render(<ChapterReviewPanel />);

    expect(screen.getByText(/No specific items listed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Force accept' })).toBeTruthy();
  });

  // ── Story 3.7 #6（design D7）：Intent 确认卡视觉对齐（内容/操作断言由 7.1 B1 既有用例守恒）──

  it('intent confirm card aligns to insight-* language: source badge in title row, authority badges, shared button classes', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr',
 pausedReviewBySession: { 'sess-cr': draftMeta }, compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT } } as any);

    const { container } = render(<ChapterReviewPanel />);

    // 来源 badge（修订指令）并入标题行（与 intentCardTitle 同文案，按 class 断言避二义）。
    const sourceBadges = container.querySelectorAll('.insight-card-badge--source');
    expect(sourceBadges.length).toBe(1);
    expect(sourceBadges[0].textContent).toBe('Revision intent');
    // authority 标签并入 badge 位：locked 硬/软锁 + provenance 用户原话/Agent 推断（各 2 枚）。
    expect(container.querySelectorAll('.insight-card-badge--hard').length).toBe(2);
    expect(container.querySelectorAll('.insight-card-badge--soft').length).toBe(2);
    // 旧 authority class 删净（删不留标记）。
    expect(container.querySelector('.chapter-review-intent-authority')).toBeNull();
    // 主操作与 InsightCard 按钮同语言（共用 insight-card-btn class 族；行为断言见既有用例）。
    const confirmBtn = screen.getByRole('button', { name: 'Confirm and redo' }) as HTMLButtonElement;
    expect(confirmBtn.className).toContain('insight-card-btn--apply');
    expect(screen.getByRole('button', { name: 'Revise intent' }).className).toContain('insight-card-btn--secondary');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('insight-card-btn--secondary');
  });

  // ── Story 7.1 B1：选区指挥精修 wiring ──

  it('hides selection box when reviewSelection is null', () => {
    useAppStore.setState({ agentSessionId: 'sess-cr',
 pausedReviewBySession: { 'sess-cr': draftMeta }, reviewSelectionBySession: {} } as any);

    render(<ChapterReviewPanel />);

    expect(screen.queryByPlaceholderText(/Describe how to revise/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compile revision intent' })).toBeNull();
  });

  it('shows selection box (quote + instruction input + compile button) when reviewSelection is set', () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      reviewSelectionBySession: { 'sess-cr': { text: '战斗开始了。', from: 5, to: 11 } },
    } as any);

    render(<ChapterReviewPanel />);

    // Selected passage quote 预览。
    expect(screen.getByText('战斗开始了。')).toBeTruthy();
    // Instruction input + compile / clear-selection buttons。
    expect(screen.getByPlaceholderText(/Describe how to revise/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compile revision intent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeTruthy();
  });

  it('compile button disabled until instruction has non-empty text', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      reviewSelectionBySession: { 'sess-cr': { text: '战斗开始了。', from: 5, to: 11 } },
    } as any);

    render(<ChapterReviewPanel />);

    // Empty instruction → disabled.
    expect((screen.getByRole('button', { name: 'Compile revision intent' }) as HTMLButtonElement).disabled).toBe(true);

    // Type something → enabled.
    await userEvent.type(screen.getByPlaceholderText(/Describe how to revise/), '改紧张');
    expect((screen.getByRole('button', { name: 'Compile revision intent' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('forwards Compile revision intent to compileIntent with passage + instruction (+brief context)', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': { ...draftMeta, briefContent: { goal: ' Establish stakes' } } },
      reviewSelectionBySession: { 'sess-cr': { text: '战斗开始了。', from: 5, to: 11 } },
    } as any);

    render(<ChapterReviewPanel />);
    await userEvent.type(screen.getByPlaceholderText(/Describe how to revise/), '改紧张点');
    await userEvent.click(screen.getByRole('button', { name: 'Compile revision intent' }));

    expect(compileIntent).toHaveBeenCalledTimes(1);
    // BMad CR F2：args = (selectedPassage, userInstruction, selectionFrom, selectionTo, draftText,
    // chapterContext, sessionId?)——W4 尾参携目标会话。
    // from/to 来自 reviewSelection（ProseMirror 位置），draftText 来自 pausedReview.draftContent，
    // chapterContext = stringified brief。IPC 层纯代码构 scope.anchor（非 LLM 产）。
    expect(compileIntent).toHaveBeenCalledWith(
      '战斗开始了。',
      '改紧张点',
      5, // selectionFrom
      11, // selectionTo
      expect.any(String), // draftText (pausedReview.draftContent)
      expect.any(String), // chapterContext (stringified brief)
      'sess-cr', // sessionId (W4 尾参)
    );
  });

  it('Clear selection forwards to setReviewSelection(null)', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      reviewSelectionBySession: { 'sess-cr': { text: '战斗开始了。', from: 5, to: 11 } },
    } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

    expect(setReviewSelection).toHaveBeenCalledWith('sess-cr', null);
  });

  it('renders intentCompileError hint when set (graceful, not silent)', () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      intentCompileErrorBySession: { 'sess-cr': 'optimizer timeout' },
    } as any);

    render(<ChapterReviewPanel />);

    expect(screen.getByText(/Intent compile failed: optimizer timeout/)).toBeTruthy();
  });

  it('shows intentCompiling hint + disables compile button while compiling', () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      reviewSelectionBySession: { 'sess-cr': { text: '战斗开始了。', from: 5, to: 11 } },
      intentCompilingBySession: { 'sess-cr': true },
    } as any);

    render(<ChapterReviewPanel />);

    expect(screen.getByText('Compiling intent...')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Compile revision intent' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // ── RevisionIntent 确认卡片 ──

  it('renders confirm card with change / locked (hard+soft) / rationale / provenance when compiledIntent is set', () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
    } as any);

    render(<ChapterReviewPanel />);

    // change.summary.
    expect(screen.getByText('把战斗节奏改紧张')).toBeTruthy();
    // Locked items: hard + soft authority badges.
    expect(screen.getByText('Hard lock')).toBeTruthy();
    expect(screen.getByText('Soft lock')).toBeTruthy();
    expect(screen.getByText('角色性格')).toBeTruthy();
    expect(screen.getByText('结论')).toBeTruthy();
    // Three buttons.
    expect(screen.getByRole('button', { name: 'Confirm and redo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revise intent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('Confirm and redo forwards to confirmRedoWithIntent with the compiled intent (view mode)', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
    } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and redo' }));

    expect(confirmRedoWithIntent).toHaveBeenCalledTimes(1);
    // Arg 0 = the compiled intent（shape equality——含 change/lockedItems/rationale/provenance）。
    const arg = (confirmRedoWithIntent as any).mock.calls[0][0];
    expect(arg.change.summary).toBe(SAMPLE_INTENT.change.summary);
    expect(arg.lockedItems).toEqual(SAMPLE_INTENT.lockedItems);
    expect(arg.rationale).toEqual(SAMPLE_INTENT.rationale);
    expect(arg.provenance).toEqual(SAMPLE_INTENT.provenance);
  });

  it('Cancel dismisses confirm card via clearCompiledIntent', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
    } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(clearCompiledIntent).toHaveBeenCalledTimes(1);
  });

  it('Revise button toggles edit mode (JSON textarea appears)', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
    } as any);

    render(<ChapterReviewPanel />);
    // Edit textarea hidden initially.
    expect(screen.queryByLabelText(/Edit intent JSON/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Revise intent' }));

    // JSON textarea visible.
    const jsonTextarea = screen.getByLabelText(/Edit intent JSON/) as HTMLTextAreaElement;
    expect(jsonTextarea).toBeTruthy();
    // Pre-filled with JSON.stringify(intent, null, 2).
    expect(JSON.parse(jsonTextarea.value)).toMatchObject({
      change: { summary: '把战斗节奏改紧张' },
    });
    // Button label toggles.
    expect(screen.getByRole('button', { name: 'Stop editing' })).toBeTruthy();
  });

  it('Confirm from edit mode parses edited JSON + forwards to confirmRedoWithIntent', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
    } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Revise intent' }));

    // Edit the summary in the JSON textarea. fireEvent.change avoids userEvent's
    // special interpretation of `{` `}` as keyboard modifier sequences.
    const jsonTextarea = screen.getByLabelText(/Edit intent JSON/) as HTMLTextAreaElement;
    const edited = JSON.parse(jsonTextarea.value);
    edited.change.summary = '改后意图：战斗更紧凑';
    fireEvent.change(jsonTextarea, { target: { value: JSON.stringify(edited) } });

    await userEvent.click(screen.getByRole('button', { name: 'Confirm and redo' }));

    expect(confirmRedoWithIntent).toHaveBeenCalledTimes(1);
    const arg = (confirmRedoWithIntent as any).mock.calls[0][0];
    expect(arg.change.summary).toBe('改后意图：战斗更紧凑');
  });

  it('Confirm from edit mode with invalid JSON shows parse error + does not call confirmRedoWithIntent', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
    } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Revise intent' }));

    const jsonTextarea = screen.getByLabelText(/Edit intent JSON/) as HTMLTextAreaElement;
    // JSON with unclosed brace → JSON.parse throws.
    fireEvent.change(jsonTextarea, { target: { value: '{ invalid json' } });

    await userEvent.click(screen.getByRole('button', { name: 'Confirm and redo' }));

    // Confirmation NOT dispatched; parse error surfaces.
    expect(confirmRedoWithIntent).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid JSON \/ schema/)).toBeTruthy();
  });

  it('Confirm from edit mode with schema-invalid JSON (missing required field) shows error', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
    } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Revise intent' }));

    const jsonTextarea = screen.getByLabelText(/Edit intent JSON/) as HTMLTextAreaElement;
    // Valid JSON but missing change.summary (required by schema).
    fireEvent.change(jsonTextarea, {
      target: { value: JSON.stringify({ ...SAMPLE_INTENT, change: {} }) },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Confirm and redo' }));

    expect(confirmRedoWithIntent).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid JSON \/ schema/)).toBeTruthy();
  });

  it('all intent + selection actions disabled while reviewResuming (chain in flight)', () => {
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': draftMeta },
      reviewSelectionBySession: { 'sess-cr': { text: '战斗开始了。', from: 5, to: 11 } },
      compiledIntentBySession: { 'sess-cr': SAMPLE_INTENT },
      reviewResumingBySession: { 'sess-cr': true },
    } as any);

    render(<ChapterReviewPanel />);

    expect((screen.getByRole('button', { name: 'Compile revision intent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Confirm and redo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Revise intent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // ── 链流程重排 W2 + CR-18 interim → 09-13 子3 W5：final 分支迁 FinalReviewCard ──

  it('W5：final stage 载荷 → 渲染空（终稿卡归 FinalReviewCard，ReviewPhaseView 路由分派）', () => {
    useAppStore.setState({ currentProject: { path: '/proj' } } as any);
    useAppStore.setState({
      agentSessionId: 'sess-cr',
      pausedReviewBySession: { 'sess-cr': finalMeta },
    } as any);

    const { container } = render(<ChapterReviewPanel />);
    expect(container.querySelector('.chapter-review')).toBeNull();
  });

  // ── 09-13 子3 W4：props sessionId 化（写作页挂载形态——后台会话直审不切走） ──

  it('W4：props sessionId → 读目标会话的 pausedReview 键 + 动作转发携该 sid（非视图会话）', async () => {
    useAppStore.setState({
      agentSessionId: 'sess-view',
      pausedReviewBySession: { 'sess-bg': draftMeta },
    } as any);

    render(<ChapterReviewPanel sessionId="sess-bg" />);

    // 读目标会话（后台链会话）的键——视图会话（sess-view）无键不渲染干扰。
    expect(screen.getByText('Chapter review')).toBeTruthy();
    expect(screen.getByTestId('mock-tiptap').textContent).toBe('第一章草稿正文。这是测试内容。');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(reviewContinue).toHaveBeenCalledWith('sess-bg');
  });

  it('W4：props sessionId 缺席 → 兜底视图会话（既有挂载形态零回归）', async () => {
    useAppStore.setState({ agentSessionId: 'sess-cr', pausedReviewBySession: { 'sess-cr': draftMeta } } as any);

    render(<ChapterReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(reviewContinue).toHaveBeenCalledWith('sess-cr');
  });
});
