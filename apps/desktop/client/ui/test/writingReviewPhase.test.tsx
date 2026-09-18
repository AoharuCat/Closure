/**
 * 09-13 子3 W5（design §1.3/§4）：写作页审阅相位测试——相位状态机 + 卡片路由 + 侧抽屉 +
 * ReviewPendingNotice 跳转接线。
 *
 * 覆盖：
 * - 相位三条件触发：观察链 paused 上升沿（running→paused 哨兵帧沿）+ 挂载即 paused（回页
 *   自动进审阅）→ 自动切 review；aborted/error/completed 终态恒不切（终态产物区是 W6 面）。
 * - 手动优先：用户「收起审阅」后链仍 paused → 不反复强切（paused 布尔不翻转效应器不触发）。
 * - 下降沿：审阅相位中链离 paused → 自动回 run。
 * - 卡片路由（resolveReviewPauseKind 分派）：final → FinalReviewCard / escalate → 裁决卡 /
 *   stub（paused 无两键）→ 降级卡 / brief → ChapterReviewPanel。
 * - 时间线侧抽屉开关（复用 ChainTimelineFeed——只读消费）。
 * - ReviewPendingNotice 跳转 = setActivePage('writing') + setSelectedChainSessionId + 进 review
 *  （chapter-patch kind 不切相位）。
 * - 章节列链状态点：观察链 paused 且 pausedReview.chapterId 命中 → paused 点亮。
 *
 * TiptapEditor mock（final 卡渲染面——jsdom 无 ProseMirror）；i18n mock t 返回键名（断言走
 * data 锚，writingPage.test.tsx 同谱）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

// TiptapEditor mock——final 卡渲染面（jsdom 无 ProseMirror；本套件只断言路由/相位，不测编辑）。
vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '' }: { content?: string }) => (
    <pre data-testid="mock-tiptap">{content}</pre>
  ),
}));

import { WritingPage } from '../src/features/writing/WritingPage';
import { ReviewPendingNotice } from '../src/features/agent-panel/ReviewPendingNotice';
import { useAppStore } from '../src/shared/store/appStore';

const RUN_BASE = {
  sessionId: 'chain-1',
  completedNodes: ['brief-compiler-node'],
  currentNodeId: 'route-agent',
  errorNodeId: null,
  streamNodeId: null,
  streamRole: null,
  streamPhase: null,
  streamText: '',
  streaming: false,
  updatedAt: 1_700_000_000_000,
};

const runOf = (status: string) => ({ ...RUN_BASE, status });

const TIMELINE = {
  'chain-1': {
    sessionId: 'chain-1',
    entries: [{
      nodeId: 'brief-compiler-node', seq: -1, status: 'done',
      summary: { kind: 'line', line: '任务卡已编译' }, tools: [], reasoning: [], at: 1_700_000_000_000,
    }],
    updatedAt: 1_700_000_000_000,
  },
};

/** 两步落种（projectSubscription reset 先行——writingPage.test.tsx 同谱）。 */
function seedState(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
  } as any);
  useAppStore.setState({
    mainView: 'page',
    agentPanelOpen: false,
    ...overrides,
  } as any);
}

beforeEach(() => {
  localStorage.clear();
  (window as any).orisonDesktop = {
    readFile: vi.fn(async () => '# 章节\n\n正文'),
    // stub 降级卡裸动作钮走真实 slice → resume IPC（mock 桥兜 completed，防 unhandled rejection）。
    resumeChapterChain: vi.fn(async () => ({ status: 'completed', errors: [] })),
  };
});

afterEach(() => {
  cleanup();
  useAppStore.setState({
    activePage: 'overview',
    mainView: 'page',
    agentPanelOpen: false,
    currentProject: null,
    novelChapters: [],
    chainRunBySession: {},
    chainTimelineBySession: {},
    chainRunAnchorByProject: {},
    selectedChainSessionId: null,
    pausedReviewBySession: {},
    pendingPatchBySession: {},
    escalateFindingsBySession: {},
    writingPhase: 'run',
  } as any);
  delete (window as any).orisonDesktop;
});

function setChainStatus(status: string) {
  act(() => {
    const prev = useAppStore.getState().chainRunBySession;
    useAppStore.setState({
      chainRunBySession: { 'chain-1': { ...(prev['chain-1'] ?? runOf(status)), status } },
    } as any);
  });
}

describe('相位状态机（design §1.3）', () => {
  it('运行中 → run 相位（时间线在，审阅容器不在）', () => {
    seedState({ chainRunBySession: { 'chain-1': runOf('running') }, chainRunAnchorByProject: { '/proj-1': 'chain-1' }, chainTimelineBySession: TIMELINE });
    const { container } = render(<WritingPage />);

    const phase = container.querySelector('.writing-phase');
    expect(phase?.getAttribute('data-writing-phase')).toBe('run');
    expect(container.querySelector('[data-writing-timeline]')).not.toBeNull();
    expect(container.querySelector('[data-writing-review]')).toBeNull();
  });

  it('上升沿：running→paused → 自动切审阅相位（final 载荷 → 终稿卡）', () => {
    seedState({ chainRunBySession: { 'chain-1': runOf('running') }, chainRunAnchorByProject: { '/proj-1': 'chain-1' }, chainTimelineBySession: TIMELINE });
    const { container } = render(<WritingPage />);
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('run');

    act(() => {
      useAppStore.setState({
        pausedReviewBySession: {
          'chain-1': { type: 'chapter_review', stage: 'final', chapterId: 'ch-12', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
        },
      } as any);
    });
    setChainStatus('paused');

    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('review');
    const review = container.querySelector('[data-writing-review]');
    expect(review).not.toBeNull();
    expect(review?.getAttribute('data-review-kind')).toBe('final');
    expect(container.querySelector('[data-final-review]')).not.toBeNull();
  });

  it('挂载即 paused（回页自动进审阅）→ review 直入', () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'final', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('review');
  });

  it('手动优先：收起审阅后链仍 paused → 保持 run 不反复强切', async () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'final', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('review');

    await userEvent.click(screen.getByRole('button', { name: 'writing.review.collapse' }));
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('run');

    // 链仍 paused 的再渲染（updatedAt 变化触发 re-render）→ 效应器不重触发（paused 布尔未翻转）。
    act(() => {
      const prev = useAppStore.getState().chainRunBySession;
      useAppStore.setState({ chainRunBySession: { 'chain-1': { ...prev['chain-1'], updatedAt: 2 } } } as any);
    });
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('run');
  });

  it('下降沿：审阅相位中链离 paused（resume 续跑）→ 自动回 run', () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'final', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('review');

    // resume 续跑事件到达（首条 delta 翻 running）+ pausedReview 清（完成收尾）。
    act(() => {
      useAppStore.setState({ pausedReviewBySession: {} } as any);
    });
    setChainStatus('running');

    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('run');
    expect(container.querySelector('[data-writing-review]')).toBeNull();
  });

  it('终态（completed/error/aborted）恒不切审阅——终态产物区归 W6', () => {
    for (const status of ['completed', 'error', 'aborted']) {
      seedState({ chainRunBySession: { 'chain-1': runOf('running') }, chainRunAnchorByProject: { '/proj-1': 'chain-1' }, chainTimelineBySession: TIMELINE });
      const { container, unmount } = render(<WritingPage />);
      setChainStatus(status);
      expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('run');
      unmount();
    }
  });

  // CR-4①（09-18 CR 批 B）：观察目标切换 = 新沿机会——沿记忆按链身份重置。原实现只看 paused
  // 布尔：A 链 paused（已收起审阅）下切到 B paused 链，布尔不翻转 → 永不进审阅。
  it('CR-4① 观察链切换重置上升沿：A paused 收起审阅后切到 B paused 链 → B 自动进审阅', async () => {
    seedState({
      chainRunBySession: {
        'chain-1': { ...RUN_BASE, sessionId: 'chain-1', status: 'paused', updatedAt: 1_700_000_000_000 },
        'chain-2': { ...RUN_BASE, sessionId: 'chain-2', status: 'paused', updatedAt: 1_700_000_000_100 },
      },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'final', draftContent: '终稿一。', resumeOptions: ['accept', 'redo', 'abort'] },
        'chain-2': { type: 'chapter_review', stage: 'final', chapterId: 'ch-12', draftContent: '终稿二。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('review');

    // 手动收起（链仍 paused → 不反复强切）。
    await userEvent.click(screen.getByRole('button', { name: 'writing.review.collapse' }));
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('run');

    // 切观察目标到另一条 paused 链（paused 布尔全程 true——链身份变化即新上升沿）。
    act(() => { useAppStore.setState({ selectedChainSessionId: 'chain-2' } as any); });
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('review');
  });

  // CR-4②（09-18 CR 批 B）：单链收起审阅后 run 相位摘要条提供「进审阅」手动再入口。
  it('CR-4② 收起审阅后 run 相位显「进审阅」钮 → 点击再入审阅；审阅相位内钮退场', async () => {
    seedState({
      chainRunBySession: { 'chain-1': { ...RUN_BASE, status: 'paused' } },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'final', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);
    // 审阅相位内无再入钮（顶部条已有「收起审阅」出口）。
    expect(container.querySelector('[data-run-enter-review]')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'writing.review.collapse' }));
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('run');

    // run 相位 + 观察链 paused → 摘要条「进审阅」入口钮；点击回审阅。
    const enter = container.querySelector('[data-run-enter-review]') as HTMLButtonElement;
    expect(enter).not.toBeNull();
    expect(enter.textContent).toBe('writing.run.enterReview');
    await userEvent.click(enter);
    expect(container.querySelector('.writing-phase')?.getAttribute('data-writing-phase')).toBe('review');
    expect(container.querySelector('[data-run-enter-review]')).toBeNull();
  });
});

describe('卡片路由（resolveReviewPauseKind 分派）', () => {
  it('escalate：paused 无 pausedReview + escalateFindings → 裁决卡（勿读 chapter_review metadata）', () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      escalateFindingsBySession: {
        'chain-1': {
          source: 'reader-audit', route: 'escalate_user', at: 1,
          items: [{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }],
        },
      },
    });
    const { container } = render(<WritingPage />);

    expect(container.querySelector('[data-writing-review]')?.getAttribute('data-review-kind')).toBe('escalate');
    expect(container.querySelector('[data-escalate-review]')).not.toBeNull();
  });

  it('stub：paused 无两键（dogfood 直跑链）→ 降级卡（继续/放弃裸动作钮）', () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
    });
    const { container } = render(<WritingPage />);

    expect(container.querySelector('[data-writing-review]')?.getAttribute('data-review-kind')).toBe('stub');
    const stub = container.querySelector('[data-stub-review]');
    expect(stub).not.toBeNull();
    // 裸动作钮 → 真实 slice 动作（IPC mock 桥兜 error 也无害——断言按钮在场 + 点击不炸）。
    const buttons = stub?.querySelectorAll('button') ?? [];
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[0]!);
  });

  // CR-10（09-18 CR 批 B）：两键皆缺但链刚从 running 转 paused（updatedAt 距今 < 8s 窗）→
  // 临时 pending 占位卡（无动作钮——chapter_review metadata 在途，stub 卡瞬闪防）。
  it('CR-10 pending 窗：刚转 paused 且无两键 → 占位卡「正在准备审阅」（非 stub 裸动作卡）', () => {
    seedState({
      chainRunBySession: { 'chain-1': { ...RUN_BASE, status: 'paused', updatedAt: Date.now() - 500 } },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
    });
    const { container } = render(<WritingPage />);

    expect(container.querySelector('[data-writing-review]')?.getAttribute('data-review-kind')).toBe('pending');
    const placeholder = container.querySelector('[data-stub-review="pending"]');
    expect(placeholder).not.toBeNull();
    // 占位无动作钮（与 stub 降级卡的继续/放弃两钮相区分）。
    expect(placeholder?.querySelectorAll('button')).toHaveLength(0);
    expect(placeholder?.textContent).toContain('writing.review.pauseKind.pending');
    expect(placeholder?.textContent).toContain('writing.review.pending.body');
  });

  it('brief：pausedReview stage=brief → ChapterReviewPanel 既有形态', () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'brief', briefContent: { goal: 'G' }, resumeOptions: ['continue', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);

    expect(container.querySelector('[data-writing-review]')?.getAttribute('data-review-kind')).toBe('brief');
    expect(container.querySelector('.chapter-review')).not.toBeNull();
  });
});

describe('时间线侧抽屉（审阅相位内回看）', () => {
  it('「▤ 时间线」开关 → 320px 抽屉渲染 ChainTimelineFeed（节点行只读）', async () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'final', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);
    expect(container.querySelector('[data-review-drawer]')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'writing.review.tlToggle' }));
    const drawer = container.querySelector('[data-review-drawer]');
    expect(drawer).not.toBeNull();
    // 抽屉内时间线复用（entry 节点行在场——chainTimelineView 投影只读消费）。
    expect(drawer?.querySelector('[data-node-id="brief-compiler-node"]')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'writing.review.tlToggle' }));
    expect(container.querySelector('[data-review-drawer]')).toBeNull();
  });
});

describe('ReviewPendingNotice 跳转接线（W5 补全）', () => {
  it('chapter-review kind → 切写作页 + 选中该链 + 进审阅相位', async () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
    });
    render(<ReviewPendingNotice kind="chapter-review" sessionId="chain-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'agent.reviewPendingJump' }));

    const s = useAppStore.getState();
    expect(s.activePage).toBe('writing');
    expect(s.selectedChainSessionId).toBe('chain-1');
    expect(s.writingPhase).toBe('review');
  });

  it('chapter-patch kind → 切写作页 + 选中该链，不切相位（待落盘审阅两相位均可见）', async () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('completed') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      writingPhase: 'run',
    });
    render(<ReviewPendingNotice kind="chapter-patch" sessionId="chain-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'agent.reviewPendingJump' }));

    const s = useAppStore.getState();
    expect(s.activePage).toBe('writing');
    expect(s.selectedChainSessionId).toBe('chain-1');
    expect(s.writingPhase).toBe('run');
  });

  it('目标链无 chainRun 键（链已清）→ 不写失效指针', async () => {
    seedState({});
    render(<ReviewPendingNotice kind="chapter-review" sessionId="gone-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'agent.reviewPendingJump' }));

    const s = useAppStore.getState();
    expect(s.activePage).toBe('writing');
    expect(s.selectedChainSessionId).toBeNull();
  });
});

describe('章节列链状态点（W5 接通 pausedReview.chapterId）', () => {
  it('观察链 paused 且 chapterId 命中 → 该章 paused 点亮；运行中/未命中 → none', () => {
    seedState({
      novelChapters: [
        { id: 'ch-11', title: '断线', sortOrder: 10 },
        { id: 'ch-12', title: '雨夜追凶', sortOrder: 11 },
      ],
      chainRunBySession: { 'chain-1': runOf('paused') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
      pausedReviewBySession: {
        'chain-1': { type: 'chapter_review', stage: 'final', chapterId: 'ch-12', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    const { container } = render(<WritingPage />);

    expect(container.querySelector('[data-writing-chapter-id="ch-12"]')?.getAttribute('data-chain-dot')).toBe('paused');
    expect(container.querySelector('[data-writing-chapter-id="ch-11"]')?.getAttribute('data-chain-dot')).toBe('none');
  });

  it('运行中不高亮具体章（链→章映射弱承诺）', () => {
    seedState({
      novelChapters: [{ id: 'ch-12', title: '雨夜追凶', sortOrder: 11 }],
      chainRunBySession: { 'chain-1': runOf('running') },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: TIMELINE,
    });
    const { container } = render(<WritingPage />);
    expect(container.querySelector('[data-writing-chapter-id="ch-12"]')?.getAttribute('data-chain-dot')).toBe('none');
  });
});
