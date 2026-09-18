/**
 * 09-13 子3 W6（design §1.2/§6.1）：多会话条测试。
 *
 * 覆盖：
 * - chip 列表 = `chainRunBySession` 全键 × 项目归属过滤（模块级 sessionProjectPaths——
 *   rememberSessionProject 登记；归属未知 / 他项目会话排除——chainRunAnchorByProject
 *   每项目只存最新 sid 不能当全集，design §1.2）。
 * - chip 四态（running 呼吸 / paused 待审 / completed / aborted）+ **badge 判据 =
 *   `status==='paused'`**——paused 但无 pausedReview 条目（escalate/stub 链，F5 连带）
 *   也计待审；主标签 = pausedReview.chapterId 查表命中 → 章号键，缺省 fallback「写章链」。
 * - 当前观察链高亮（data-chain-active / aria-pressed——CR-15 tablist 半实现降级为 group+pressed）
 *   + 点 chip = setSelectedChainSessionId 切观察目标（组件零相位写入——相位切换归 W5 相位机
 *   沿效应器）。
 * - 无 chip（本项目无链 / 无项目）→ 整条不渲染。
 *
 * 谱：writingPage.test.tsx（真实 useAppStore + 两步落种 + i18n mock t=键名，断言走 data 锚）。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
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

import { ChainSessionBar } from '../src/features/writing/ChainSessionBar';
import { useAppStore } from '../src/shared/store/appStore';
import { __clearAgentEventTracks, rememberSessionProject } from '../src/shared/store/agentEvents';

const RUN_BASE = {
  completedNodes: [],
  currentNodeId: null,
  errorNodeId: null,
  streamNodeId: null,
  streamRole: null,
  streamPhase: null,
  streamText: '',
  streaming: false,
};

const CHAPTERS = [
  { id: 'ch-9', title: '雨夜来客', sortOrder: 8, status: 'final', sections: [] },
  { id: 'ch-12', title: '雨夜追凶', sortOrder: 11, status: 'draft', sections: [] },
];

/** 两步落种（projectSubscription reset 先行——writingPage.test.tsx 同谱）。 */
function seedState(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
  } as any);
  useAppStore.setState({ mainView: 'page', ...overrides } as any);
}

beforeEach(() => {
  localStorage.clear();
  __clearAgentEventTracks();
});

afterEach(() => {
  cleanup();
  useAppStore.setState({
    currentProject: null,
    novelChapters: [],
    chainRunBySession: {},
    chainRunAnchorByProject: {},
    selectedChainSessionId: null,
    pausedReviewBySession: {},
  } as any);
  __clearAgentEventTracks();
});

describe('chip 列表 = 全键 × 项目归属过滤（design §1.2/§6.1）', () => {
  it('本项目会话全列 chip；他项目 / 归属未知会话排除；updatedAt 降序（最近链在前）', () => {
    rememberSessionProject('c-old', '/proj-1');
    rememberSessionProject('c-new', '/proj-1');
    rememberSessionProject('c-other', '/other-proj');
    seedState({
      chainRunBySession: {
        'c-old': { ...RUN_BASE, sessionId: 'c-old', status: 'completed', updatedAt: 100 },
        'c-new': { ...RUN_BASE, sessionId: 'c-new', status: 'running', updatedAt: 200 },
        'c-other': { ...RUN_BASE, sessionId: 'c-other', status: 'running', updatedAt: 300 },
        'c-unknown': { ...RUN_BASE, sessionId: 'c-unknown', status: 'running', updatedAt: 400 },
      },
    });

    const { container } = render(<ChainSessionBar observedChainId="c-new" />);
    const chips = container.querySelectorAll('.writing-chain-chip');
    expect(chips).toHaveLength(2); // 他项目 + 归属未知排除
    expect(chips[0].getAttribute('data-chain-status')).toBe('running'); // updatedAt 200 > 100
    expect(chips[1].getAttribute('data-chain-status')).toBe('completed');
  });

  it('无本项目链 / 无 currentProject → 整条不渲染（无物可切）', () => {
    seedState({ chainRunBySession: {} });
    const empty = render(<ChainSessionBar observedChainId={null} />);
    expect(empty.container.querySelector('[data-writing-chainbar]')).toBeNull();
    empty.unmount();

    rememberSessionProject('c-1', '/proj-1');
    useAppStore.setState({
      currentProject: null,
      chainRunBySession: { 'c-1': { ...RUN_BASE, sessionId: 'c-1', status: 'running', updatedAt: 1 } },
    } as any);
    const noProject = render(<ChainSessionBar observedChainId={null} />);
    expect(noProject.container.querySelector('[data-writing-chainbar]')).toBeNull();
  });
});

describe('badge 判据 = status paused（非 pausedReview 存在——escalate/stub 链也计）', () => {
  it('paused 无 pausedReview 条目 → badge 仍在 + fallback 主标签', () => {
    rememberSessionProject('c-esc', '/proj-1');
    seedState({
      chainRunBySession: { 'c-esc': { ...RUN_BASE, sessionId: 'c-esc', status: 'paused', updatedAt: 1 } },
      pausedReviewBySession: {}, // escalate-pause 不产 pausedReview（F5）
    });

    const { container } = render(<ChainSessionBar observedChainId={null} />);
    const chip = container.querySelector('.writing-chain-chip') as HTMLElement;
    expect(chip.getAttribute('data-chain-status')).toBe('paused');
    expect(chip.querySelector('.writing-chain-chip-badge')?.textContent).toBe('writing.chip.badge');
    // 章号不可判（无 pausedReview.chapterId）→ fallback「写章链」。
    expect(chip.querySelector('.writing-chain-chip-label')?.textContent).toBe('writing.run.fallbackTitle');
  });

  it('paused + pausedReview.chapterId 命中 → 章号主标签；completed 无 badge 显状态文案', () => {
    rememberSessionProject('c-paused', '/proj-1');
    rememberSessionProject('c-done', '/proj-1');
    seedState({
      novelChapters: CHAPTERS,
      chainRunBySession: {
        'c-paused': { ...RUN_BASE, sessionId: 'c-paused', status: 'paused', updatedAt: 1 },
        'c-done': { ...RUN_BASE, sessionId: 'c-done', status: 'completed', updatedAt: 2 },
      },
      pausedReviewBySession: { 'c-paused': { type: 'chapter_review', stage: 'final', chapterId: 'ch-12' } as any },
    });

    const { container } = render(<ChainSessionBar observedChainId="c-paused" />);
    const chips = container.querySelectorAll('.writing-chain-chip');
    const pausedChip = chips[1]; // updatedAt 2 的 completed 在前
    const doneChip = chips[0];
    expect(pausedChip.querySelector('.writing-chain-chip-label')?.textContent).toBe('writing.chip.chapter');
    expect(doneChip.querySelector('.writing-chain-chip-badge')).toBeNull();
    expect(doneChip.querySelector('.writing-chain-chip-state')?.textContent).toBe('writing.run.status.completed');
  });

  it('pausedReview.chapterId 未命中章表（stub/挂起）→ fallback 标签（弱承诺不造数）', () => {
    rememberSessionProject('c-1', '/proj-1');
    seedState({
      novelChapters: CHAPTERS,
      chainRunBySession: { 'c-1': { ...RUN_BASE, sessionId: 'c-1', status: 'paused', updatedAt: 1 } },
      pausedReviewBySession: { 'c-1': { type: 'chapter_review', stage: 'draft', chapterId: 'ch-nope' } as any },
    });

    const { container } = render(<ChainSessionBar observedChainId="c-1" />);
    const chip = container.querySelector('.writing-chain-chip') as HTMLElement;
    expect(chip.querySelector('.writing-chain-chip-label')?.textContent).toBe('writing.run.fallbackTitle');
  });
});

describe('观察切换（点 chip = setSelectedChainSessionId）', () => {
  it('当前观察链高亮（data-chain-active / aria-pressed——CR-15 tablist 半实现降级为 group+pressed）；点他链 chip 写显式选择', () => {
    rememberSessionProject('c-a', '/proj-1');
    rememberSessionProject('c-b', '/proj-1');
    seedState({
      chainRunBySession: {
        'c-a': { ...RUN_BASE, sessionId: 'c-a', status: 'running', updatedAt: 2 },
        'c-b': { ...RUN_BASE, sessionId: 'c-b', status: 'paused', updatedAt: 1 },
      },
    });

    const { container } = render(<ChainSessionBar observedChainId="c-a" />);
    const chips = container.querySelectorAll('.writing-chain-chip');
    expect(chips[0].getAttribute('data-chain-active')).toBe('true');
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
    expect(chips[1].getAttribute('data-chain-active')).toBe('false');
    expect(chips[1].getAttribute('aria-pressed')).toBe('false');
    // tablist 半实现已退役：容器 role=group、chip 无 tab 角色（误导读屏为标签页控件）。
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="group"]')).not.toBeNull();
    expect(container.querySelector('[role="tab"]')).toBeNull();

    fireEvent.click(chips[1]);
    expect(useAppStore.getState().selectedChainSessionId).toBe('c-b');
  });
});
