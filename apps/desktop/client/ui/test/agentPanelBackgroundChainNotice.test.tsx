/**
 * 09-13 子3 CR-7（09-18 CR 批 B）：对话栏后台链待审卡。
 *
 * design §1.3「暂停的是后台链：不抢——chip badge「待审」+ 对话栏提示卡」的后半承诺补全：
 * 本项目内**非视图会话**的 paused 链（chainRunBySession × 项目归属过滤 × sid !== agentSessionId）
 * 在对话栏渲染 ReviewPendingNotice 轻量卡（跳写作页 + 选链 + 进审阅——W5 接口已在）。
 *
 * 覆盖：
 * - 后台 paused 链（stub 车道 sid ≠ 视图会话）→ 卡渲染 + 跳转三联动（setActivePage('writing')
 *   + setSelectedChainSessionId + setWritingPhase('review')）。
 * - 去重：视图会话自身的 paused 链（chainRun 键 = agentSessionId）不重复渲染（既有
 *   hasPausedReview 位承载）。
 * - 项目归属过滤：他项目 paused 链不渲染（sameProjectPath 单源）；running/终态链不渲染。
 *
 * mirror agentPanelManualCompact.test：mock IPC 边界，slice/组件真实跑；en locale 真实 i18n。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { __clearAgentEventTracks, rememberSessionProject } from '../src/shared/store/agentEvents';

const RUN_BASE = {
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

function seedStore(overrides: Record<string, unknown> = {}) {
  // 两段式 seed（先 currentProject 触发项目切换重置，尘埃落定再补会话态——gear 测试同款）。
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'en-US',
    activePage: 'overview',
    writingPhase: 'run',
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
    chainRunBySession: {},
    chainTimelineBySession: {},
    chainRunAnchorByProject: {},
    selectedChainSessionId: null,
    pausedReviewBySession: {},
    pendingPatchBySession: {},
    escalateFindingsBySession: {},
    ...overrides,
  } as any);
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __clearAgentEventTracks();
  (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
});

afterEach(() => {
  cleanup();
  __clearAgentEventTracks();
});

const chapterReviewNotices = () => document.querySelectorAll('[data-review-pending-kind="chapter-review"]');

describe('AgentPanel 后台链待审卡（CR-7）', () => {
  it('后台 paused 链（非视图会话）→ 轻量卡渲染；跳转 = 写作页 + 选链 + 进审阅', async () => {
    rememberSessionProject('chain-stub', 'I:/echo/project');
    seedStore({
      chainRunBySession: {
        'chain-stub': { ...RUN_BASE, sessionId: 'chain-stub', status: 'paused' },
      },
    });
    render(<AgentPanel />);

    expect(chapterReviewNotices()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Open Writing page' }));

    const s = useAppStore.getState();
    expect(s.activePage).toBe('writing');
    expect(s.selectedChainSessionId).toBe('chain-stub');
    expect(s.writingPhase).toBe('review');
  });

  it('去重：视图会话自身的 paused 链只出既有卡一张（sid = agentSessionId 不进后台列表）', () => {
    rememberSessionProject('session-1', 'I:/echo/project');
    seedStore({
      chainRunBySession: {
        'session-1': { ...RUN_BASE, sessionId: 'session-1', status: 'paused' },
      },
      pausedReviewBySession: {
        'session-1': { type: 'chapter_review', stage: 'final', draftContent: '终稿。', resumeOptions: ['accept', 'redo', 'abort'] },
      },
    });
    render(<AgentPanel />);

    expect(chapterReviewNotices()).toHaveLength(1);
  });

  it('项目过滤 + 状态过滤：他项目 paused 链 / 本项目 running 链 → 不渲染', () => {
    rememberSessionProject('chain-other', 'I:/other/project');
    rememberSessionProject('chain-running', 'I:/echo/project');
    seedStore({
      chainRunBySession: {
        'chain-other': { ...RUN_BASE, sessionId: 'chain-other', status: 'paused' },
        'chain-running': { ...RUN_BASE, sessionId: 'chain-running', status: 'running' },
        'chain-done': { ...RUN_BASE, sessionId: 'chain-done', status: 'completed' },
      },
    });
    render(<AgentPanel />);

    expect(chapterReviewNotices()).toHaveLength(0);
  });

  it('无后台 paused 链 → 零卡（通知区不占位）', () => {
    seedStore();
    render(<AgentPanel />);
    expect(chapterReviewNotices()).toHaveLength(0);
  });
});
