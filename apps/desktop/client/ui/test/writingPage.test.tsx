/**
 * 「写作」页 W1 骨架测试（task 09-13-writing-page-ui）。
 *
 * 覆盖：
 * - 三区骨架：章节列 + chainbar 挂载门（W6 起真实多会话条——无链零 chip 整条不渲染，
 *   chip 态详测见 chainSessionBar.test.tsx）+ 相位容器；W3 起 runmeta 位由真实摘要条
 *   接管（无链不渲染）+ 观察链解析接线（显式选择 → 项目锚；章名派生 fallback「写章链」）；
 * - 章节列渲染：章行（ordinal = sortOrder+1 派生，mirror ChapterListPanel CR-4.1-18 口径）
 *   + 点章 → openWriting 流（readFile 桥 + openFile 落 tab：activeFilePath/mainView）；
 * - 零章空态；无 currentProject 守卫卡；
 * - 导航接线：setActivePage('writing') → WorkspaceLayout switch 渲染 WritingPage（lazy）
 *   + icon-rail「写作」钮（navItems.writingItem——原 openWriting 按钮已替换为页面路由）。
 *
 * mock 形态照 spec/ui/testing.md + settingPage.test.tsx 谱：真实 useAppStore + 两步落种
 * （先 currentProject 触发 projectSubscription reset、后落数据）+ useI18n mock（t 返回
 * 键名）+ mock window.orisonDesktop 桥（openWriting 走 readFile）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import { WritingPage } from '../src/features/writing/WritingPage';
import { WorkspaceLayout } from '../src/widgets/layout/WorkspaceLayout';
import { useAppStore } from '../src/shared/store/appStore';

const CHAPTERS = [
  {
    id: 'ch-9',
    title: '雨夜来客',
    sortOrder: 8,
    status: 'final',
    sections: [{ id: 'sec-9', sortOrder: 0, contentFile: 'chapters/第09章.md' }],
  },
  {
    id: 'ch-12',
    title: '雨夜追凶',
    sortOrder: 11,
    status: 'draft',
    sections: [{ id: 'sec-12', sortOrder: 0, contentFile: 'chapters/第12章.md' }],
  },
];

/** 两步落种：先 currentProject（null→path 触发 projectSubscription reset——同步清项目态，
 *  一步合落会被订阅 reset 把 novelChapters 当场抹掉），后落数据。 */
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
    readFile: vi.fn(async () => '# 第12章\n\n正文……'),
    // W6：衍生状态查询（章卡徽标/按钮数据面——挂载 effect 拉取；返空防 unhandled）。
    chapterDerivationStatus: vi.fn(async () => ({ chapters: [] })),
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
    openFiles: [],
    activeFilePath: null,
    // W3：观察链数据面 + 指针（数据面模块不注册项目重置——测试显式清）。
    chainRunBySession: {},
    chainTimelineBySession: {},
    chainRunAnchorByProject: {},
    selectedChainSessionId: null,
    pausedReviewBySession: {},
    pendingPatchBySession: {},
    // W5：审阅相位面（相位态 + escalate findings 键）。
    escalateFindingsBySession: {},
    writingPhase: 'run',
    // W6：章卡衍生状态面。
    chapterDerivationByChapter: {},
    chapterReExtracting: {},
  } as any);
  delete (window as any).orisonDesktop;
});

describe('三区骨架（design §1.2）', () => {
  it('章节列 + chainbar 挂载门（无链 → 不渲染 chip 条）+ runmeta/时间线挂载门（空态卡）', () => {
    seedState({ novelChapters: CHAPTERS });
    const { container } = render(<WritingPage />);

    // 章节列（列标题 + 章行）。
    expect(screen.getByText('writing.chapters.title')).toBeInTheDocument();
    expect(container.querySelectorAll('.writing-chapter')).toHaveLength(2);

    // W6：chainbar 已由真实多会话条接管——无链零 chip 整条不渲染（无物可切）。
    expect(container.querySelector('[data-writing-chainbar]')).toBeNull();
    expect(container.querySelector('[data-writing-placeholder="chainbar"]')).toBeNull();
    expect(container.querySelector('[data-writing-phase="run"]')).not.toBeNull();

    // W3：runmeta 位已由真实摘要条接管——无观察链不渲染（无物可汇总）。
    expect(container.querySelector('[data-writing-placeholder="runmeta"]')).toBeNull();
    expect(container.querySelector('[data-writing-runmeta]')).toBeNull();

    // 无链引导卡（无链时时间线区内容）。
    expect(screen.getByText('writing.empty.title')).toBeInTheDocument();
    expect(screen.getByText('writing.empty.body')).toBeInTheDocument();
  });

  it('零章：章节列空态文案 + 引导卡照常', () => {
    seedState({ novelChapters: [] });
    render(<WritingPage />);

    expect(screen.getByText('writing.chapters.empty')).toBeInTheDocument();
    expect(screen.getByText('writing.empty.title')).toBeInTheDocument();
  });

  it('无 currentProject：守卫卡（materials/setting 先例守卫形态）', () => {
    useAppStore.setState({ currentProject: null, resolvedLocale: 'zh-CN' } as any);
    const { container } = render(<WritingPage />);

    expect(container.querySelector('[data-writing-guard="no-project"]')).not.toBeNull();
    expect(screen.getByText('writing.noProject.title')).toBeInTheDocument();
    // 守卫态不渲染章节列。
    expect(container.querySelector('.writing-chapters')).toBeNull();
  });
});

describe('章节列接线（openWriting 出口）', () => {
  it('章行 ordinal = sortOrder+1 派生；点章（开稿件钮）→ readFile + openFile 落 tab（mainView 切 files）', async () => {
    seedState({ novelChapters: CHAPTERS });
    const { container } = render(<WritingPage />);

    const row = container.querySelector('[data-writing-chapter-id="ch-12"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('雨夜追凶');
    // ordinal 派生（sortOrder=11 → 12；非数组位置——0-based sortOrder 口径）。
    expect(row.querySelector('.writing-chapter-num')?.textContent).toBe('12');
    // W1 链状态点占位：恒 none（链→章映射弱承诺，W5 接 pausedReview.chapterId）。
    expect(row.getAttribute('data-chain-dot')).toBe('none');

    // CR-15：行容器去 role=button 改 li 语义——「开稿件」是行内独立钮（交互不嵌套）。
    expect(row.tagName).toBe('LI');
    expect(row.getAttribute('role')).toBeNull();
    const openBtn = row.querySelector('.writing-chapter-open') as HTMLButtonElement;
    expect(openBtn).not.toBeNull();
    fireEvent.click(openBtn);
    await act(async () => { await Promise.resolve(); });

    // openWriting 流：readFile（拼接路径 = projectPath/contentFile）→ openFile 落 tab。
    expect((window as any).orisonDesktop.readFile).toHaveBeenCalledWith('/proj-1/chapters/第12章.md');
    const state = useAppStore.getState();
    expect(state.activeFilePath).toBe('/proj-1/chapters/第12章.md');
    expect(state.mainView).toBe('files');
    expect(state.openFiles).toHaveLength(1);
    expect(state.openFiles[0].name).toBe('第12章.md');
  });
});

describe('导航接线（design §1.1：types/navItems/SideNav/WorkspaceLayout 四文件）', () => {
  it('setActivePage("writing") → WorkspaceLayout 渲染 WritingPage（lazy）+ icon-rail 页面路由钮', async () => {
    seedState({ novelChapters: CHAPTERS, activePage: 'writing' });

    render(<WorkspaceLayout />);

    // lazy 加载后章行渲染（经 WorkspaceLayout switch case 'writing'）。
    expect(await screen.findByText('雨夜追凶')).toBeInTheDocument();

    // icon-rail「写作」钮（navItems.writingItem 经 NavButton 渲染——原 openWriting
    // 直调按钮已替换为页面路由；i18n mock 下 aria-label=键名）。
    expect(screen.getByRole('button', { name: 'nav.writing' })).toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// W3：观察链解析 + 摘要条/时间线挂载接线（resolveObservedChainSession——显式选择 → 项目锚）
// ════════════════════════════════════════════════════════════════════════════

describe('W3 观察链接线（runmeta + timeline 挂载门）', () => {
  const RUN = {
    sessionId: 'chain-1',
    status: 'running',
    completedNodes: ['brief-compiler-node'],
    currentNodeId: 'brief-reviewer-node',
    errorNodeId: null,
    streamNodeId: null,
    streamRole: null,
    streamPhase: null,
    streamText: '',
    streaming: false,
    updatedAt: 1_700_000_000_000,
  };

  function seedChain(over: Record<string, unknown> = {}) {
    seedState({
      novelChapters: CHAPTERS,
      chainRunBySession: { 'chain-1': RUN },
      chainRunAnchorByProject: { '/proj-1': 'chain-1' },
      chainTimelineBySession: {
        'chain-1': {
          sessionId: 'chain-1',
          entries: [{
            nodeId: 'brief-compiler-node', seq: -1, status: 'done',
            summary: { kind: 'line', line: '任务卡已编译' }, tools: [], reasoning: [], at: 1_700_000_000_000,
          }],
          updatedAt: 1_700_000_000_000,
        },
      },
      ...over,
    });
  }

  it('项目锚解析 → runmeta 条 + 时间线渲染（节点行在场，空态卡退场）', () => {
    seedChain();
    const { container } = render(<WritingPage />);

    expect(container.querySelector('[data-writing-runmeta]')).not.toBeNull();
    expect(container.querySelector('[data-writing-empty="no-chain"]')).toBeNull();
    // 时间线渲染锚链会话的 entry（i18n mock 下节点名=键名，断言走 data 锚）。
    const node = container.querySelector('[data-node-id="brief-compiler-node"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute('data-node-status')).toBe('done');
  });

  it('显式选择优先（selectedChainSessionId 胜项目锚）；失效选择（会话已删）回落锚', () => {
    seedChain({
      selectedChainSessionId: 'chain-2',
      chainRunBySession: {
        'chain-1': RUN,
        'chain-2': { ...RUN, sessionId: 'chain-2', currentNodeId: 'lint-node' },
      },
      chainTimelineBySession: {
        'chain-1': { sessionId: 'chain-1', entries: [], updatedAt: 1 },
        'chain-2': {
          sessionId: 'chain-2',
          entries: [{
            nodeId: 'lint-node', seq: -1, status: 'done',
            summary: { kind: 'line', line: '0 命中' }, tools: [], reasoning: [], at: 1,
          }],
          updatedAt: 1,
        },
      },
    });
    const first = render(<WritingPage />);
    expect(first.container.querySelector('[data-node-id="lint-node"]')).not.toBeNull();
    first.unmount();

    // 选择指向已删会话（chain-2 不在 chainRunBySession）→ 回落项目锚 chain-1
    //（时间线已清——灰预览形态，lint-node 只剩 pending 行，无 done entry）。
    useAppStore.setState({
      selectedChainSessionId: 'chain-2',
      chainRunBySession: { 'chain-1': RUN },
      chainTimelineBySession: {},
    } as any);
    const second = render(<WritingPage />);
    expect(second.container.querySelector('[data-writing-runmeta]')).not.toBeNull();
    expect(second.container.querySelector('[data-node-id="lint-node"][data-node-status="done"]')).toBeNull();
  });

  it('章名派生：pausedReview.chapterId 命中 novelChapters → 章名条；未命中/缺席 → fallback「写章链」', () => {
    seedChain({ pausedReviewBySession: { 'chain-1': { type: 'chapter_review', stage: 'final', chapterId: 'ch-12' } as any } });
    const withChapter = render(<WritingPage />);
    expect(withChapter.container.querySelector('.writing-runmeta-chapter')?.textContent)
      .toBe('writing.run.chapter');
    withChapter.unmount();

    // 同路径 seed 不触发项目切换 reset（按 path 比较）——pausedReview 显式清。
    seedChain({ pausedReviewBySession: {} });
    const fallback = render(<WritingPage />);
    expect(fallback.container.querySelector('.writing-runmeta-chapter')?.textContent)
      .toBe('writing.run.fallbackTitle');
  });
});
