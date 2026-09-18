/**
 * 09-13 子3 W4（design §5.2/§5.3 + 拍板 D-g/D2 修订）：审批迁移的对话栏/写作页切分接线。
 *
 * - ReviewPendingNotice：对话栏瘦身轻量卡（两 kind 文案 + 跳转 setActivePage('writing')；
 *   选中链 + 自动进审阅相位是 W5 相位状态机面——本波跳转先行）。
 * - AgentPanel 挂载位切分：纯 chapter_candidate（链产物）批 → 不渲染全尺寸 PatchReviewPanel，
 *   只挂轻量提示；混合批 → 过滤渲染非链行 + 提示；pausedReview → 轻量提示（ChapterReviewPanel
 *   已迁 features/writing，对话栏不再渲染全尺寸审阅卡）。
 * - WritingPage 产物区挂载：含 chapter_candidate 的会话挂 PatchReviewPanel（props sessionId =
 *   该链会话键）；非链批不挂。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { ReviewPendingNotice } from '../src/features/agent-panel/ReviewPendingNotice';
import { WritingPage } from '../src/features/writing/WritingPage';
import { useAppStore } from '../src/shared/store/appStore';
import { __clearAgentEventTracks, rememberSessionProject } from '../src/shared/store/agentEvents';
import type { ProjectFieldPatch } from '@orison/shared-contracts';

const chapterCandidatePatch: ProjectFieldPatch = {
  runId: 'run-cc',
  createdAt: '2026-08-01T00:00:00Z',
  patches: [
    {
      field: 'chapter_candidate' as any,
      action: 'set',
      data: { chapterId: 'ch_001', runId: 'run_mock', candidate: { content: '正文…' } },
      fieldVersion: 1,
      generatedBy: 'write_chapter',
    },
  ],
};

const mixedPatch: ProjectFieldPatch = {
  runId: 'run-mixed',
  createdAt: '2026-08-01T00:00:00Z',
  patches: [
    ...chapterCandidatePatch.patches,
    {
      field: 'outline',
      action: 'set',
      data: { phases: [{ id: 'p1', title: 'Volume One' }] },
      fieldVersion: 2,
      generatedBy: 'story-planner-agent',
    },
  ],
};

const nonChainPatch: ProjectFieldPatch = {
  runId: 'run-chat',
  createdAt: '2026-08-01T00:00:00Z',
  patches: [
    {
      field: 'outline',
      action: 'set',
      data: { phases: [{ id: 'p1', title: 'Volume One' }] },
      fieldVersion: 2,
      generatedBy: 'story-planner-agent',
    },
  ],
};

function seedStore(overrides: Record<string, unknown> = {}) {
  // 两段式 seed（agentPanelManualCompact.test 先例）：先落 currentProject（触发
  // projectSubscription 真切换重置），尘埃落定后再补会话态——一次性 setState 会被
  // 订阅内的重置同步清掉。
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: '/proj', type: 'novel' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'en-US',
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    agentMessages: [],
    agentSkills: [],
    agentSkillError: null,
    loadAgentSkills: vi.fn().mockResolvedValue(undefined),
    skillPackages: [],
    skillPackagesLoading: false,
    loadSkillPackages: vi.fn().mockResolvedValue(undefined),
    toggleSkillPackage: vi.fn(),
    toggleSkill: vi.fn(),
    agentParticipationGear: 'smart',
    pendingAttachments: [],
    attachmentUploadStates: {},
    uploadInboxFiles: vi.fn().mockResolvedValue(undefined),
    uploadChatImages: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any);
}

beforeEach(() => {
  localStorage.clear();
  __clearAgentEventTracks();
  (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
});

afterEach(() => {
  cleanup();
  __clearAgentEventTracks();
  useAppStore.setState({
    pendingPatchBySession: {},
    pausedReviewBySession: {},
    activePage: 'overview',
    // W6 迁位测试新增的观察链面（防文件内跨 describe 泄漏）。
    chainRunBySession: {},
    chainTimelineBySession: {},
    chainRunAnchorByProject: {},
  } as any);
});

describe('ReviewPendingNotice — 对话栏瘦身轻量卡', () => {
  it('kind=chapter-review 渲染审阅等待文案 + 跳转钮 → setActivePage("writing")', async () => {
    useAppStore.setState({ resolvedLocale: 'en-US', activePage: 'overview' } as any);

    const { container } = render(<ReviewPendingNotice kind="chapter-review" />);
    expect(container.querySelector('[data-review-pending-kind="chapter-review"]')).not.toBeNull();
    expect(screen.getByText('Chapter review waiting')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Open Writing page' }));
    expect(useAppStore.getState().activePage).toBe('writing');
  });

  it('kind=chapter-patch 渲染章节候选待落盘文案（两 kind 区分）', () => {
    useAppStore.setState({ resolvedLocale: 'en-US' } as any);

    const { container } = render(<ReviewPendingNotice kind="chapter-patch" />);
    expect(container.querySelector('[data-review-pending-kind="chapter-patch"]')).not.toBeNull();
    expect(screen.getByText('Chapter draft awaiting review')).toBeTruthy();
  });
});

describe('AgentPanel 挂载位切分（D-g）——chapter_candidate 不渲染全尺寸卡', () => {
  it('纯 chapter_candidate 批 → 无全尺寸 patch-review 卡，只有轻量提示', () => {
    seedStore({
      pendingPatchBySession: { 'session-1': { patch: chapterCandidatePatch, selections: { chapter_candidate: true } } },
    });

    const { container } = render(<AgentPanel />);

    expect(container.querySelector('.patch-review')).toBeNull();
    expect(container.querySelector('[data-review-pending-kind="chapter-patch"]')).not.toBeNull();
  });

  it('混合批 → 过滤渲染非链行（outline 可见 / chapter_candidate 行隐藏）+ 轻量提示并存', () => {
    seedStore({
      pendingPatchBySession: { 'session-1': { patch: mixedPatch, selections: { chapter_candidate: true, outline: true } } },
    });

    const { container } = render(<AgentPanel />);

    expect(container.querySelector('.patch-review')).not.toBeNull();
    expect(screen.getByText('Outline')).toBeTruthy();
    expect(screen.queryByText('Chapter Draft')).toBeNull();
    expect(container.querySelector('[data-review-pending-kind="chapter-patch"]')).not.toBeNull();
  });

  it('纯非链批（对话指挥产物）→ 全尺寸卡照常、无轻量提示（零回归）', () => {
    seedStore({
      pendingPatchBySession: { 'session-1': { patch: nonChainPatch, selections: { outline: true } } },
    });

    const { container } = render(<AgentPanel />);

    expect(container.querySelector('.patch-review')).not.toBeNull();
    expect(screen.getByText('Outline')).toBeTruthy();
    expect(container.querySelector('[data-review-pending-kind="chapter-patch"]')).toBeNull();
  });

  it('pausedReview → 不再渲染全尺寸审阅卡（ChapterReviewPanel 已迁写作页），只有轻量提示', () => {
    seedStore({
      pausedReviewBySession: {
        'session-1': { type: 'chapter_review', stage: 'draft', chapterId: 'ch_001', draftContent: '正文', resumeOptions: ['continue', 'redo', 'abort'] },
      },
    });

    const { container } = render(<AgentPanel />);

    // 全尺寸审阅卡（chapter-review class 族）不再挂对话栏。
    expect(container.querySelector('.chapter-review')).toBeNull();
    expect(container.querySelector('[data-review-pending-kind="chapter-review"]')).not.toBeNull();
  });
});

describe('WritingPage 产物区挂载（D-g）——chapter_candidate 待落盘审阅', () => {
  // W6 迁位（design §5.2/§6.2）：挂载点从 phase 容器下方迁入 ChainOutcome 槽（终态产物区顶部）。
  // 产物区只在观察链在位时渲染——真实时序里 envelope 由 resume IPC 完成时 stage，同刻
  // chainRunBySession[stub sid] 恒在（terminal）；seed 对齐该时序（completed 链 + 项目锚）。
  const TERMINAL_CHAIN_RUN = {
    sessionId: 'chain-stub',
    status: 'completed',
    completedNodes: ['route-agent'],
    currentNodeId: 'route-agent',
    errorNodeId: null,
    streamNodeId: null,
    streamRole: null,
    streamPhase: null,
    streamText: '',
    streaming: false,
    updatedAt: 1_700_000_000_000,
  };

  function seedWithTerminalChain(patchOverrides: Record<string, unknown> = {}) {
    seedStore({
      novelChapters: [],
      chainRunBySession: { 'chain-stub': TERMINAL_CHAIN_RUN },
      chainRunAnchorByProject: { '/proj': 'chain-stub' },
      chainTimelineBySession: { 'chain-stub': { sessionId: 'chain-stub', entries: [], updatedAt: 1 } },
      ...patchOverrides,
    });
  }

  it('含 chapter_candidate 的会话 → 挂 PatchReviewPanel（props sessionId = 该会话键）', () => {
    // CR-2（09-18 CR 批 B）：写作页挂载门加项目归属过滤——staging 会话需登记归属
    //（真实时序里 setPendingPatch 的会话恒有事件面归属；归属未知保守排除）。
    rememberSessionProject('session-chain', '/proj');
    seedWithTerminalChain({
      pendingPatchBySession: { 'session-chain': { patch: chapterCandidatePatch, selections: { chapter_candidate: true } } },
    });

    const { container } = render(<WritingPage />);

    // 终态产物区在位（completed 三态卡）+ 待落盘审阅挂其顶部。
    expect(container.querySelector('[data-outcome-kind="completed"]')).not.toBeNull();
    const panel = container.querySelector('.patch-review') as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(screen.getByText('Chapter Draft')).toBeTruthy();
  });

  it('纯非链批（对话指挥产物）→ 写作页不挂（对话栏已渲染）', () => {
    seedWithTerminalChain({
      pendingPatchBySession: { 'session-1': { patch: nonChainPatch, selections: { outline: true } } },
    });

    const { container } = render(<WritingPage />);

    expect(container.querySelector('.patch-review')).toBeNull();
  });

  it('无挂起 patch → 不挂（空态卡承载）', () => {
    seedStore({ novelChapters: [] });

    const { container } = render(<WritingPage />);

    expect(container.querySelector('.patch-review')).toBeNull();
  });
});
