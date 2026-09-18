/**
 * 09-13 子3 W6（design §6.2）：终态产物区测试——completed/error/aborted 三态卡。
 *
 * 覆盖：
 * - completed 落盘清单投影（**按实际获得字段投影缺不造数**）：正文行（chapter_accept
 *   envelope chapterId → 章查表 → sections[0].contentFile；envelope 缺席回落
 *   pausedReview）/ 世界事件五轴 items.total 求和 / 伏笔计数 / 章摘要·弧节拍·反哺·
 *   反馈台账 line 帧透传；帧缺席行缺省（noRows 兜底文案）。
 * - 跳转：打开稿件 openWriting / 世界面板 setActiveSidebarPanel('world') / 设定卡审阅
 *   setAgentPanelOpen(true)。
 * - error：errorNodeId 定位 + 通用终态行明细 + 复制诊断（navigator.clipboard.writeText
 *   机械组装——session/status/errorNode/completedNodes/errors）+ 回对话栏；**无断点重跑钮**
 *   （快照存活性未核实不承诺）。
 * - aborted：neutral 中断文案（用户放弃/被动中断无可靠数据面区分——不造判定）+ 保留说明。
 * - 非终态：只渲染 children 槽（W4 chapter_candidate 挂载位迁此——链在跑窗口承接）。
 *
 * 谱：chainSessionBar.test.tsx（真实 useAppStore + 两步落种 + i18n mock t=键名）。
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

import { ChainOutcome } from '../src/features/writing/ChainOutcome';
import { useAppStore } from '../src/shared/store/appStore';
import { __clearAgentEventTracks, rememberSessionProject } from '../src/shared/store/agentEvents';
import type { ChainRunState } from '../src/shared/store/chainStreamBuffer';
import type { TimelineNodeEntry } from '../src/shared/store/chainTimeline';

const RUN_BASE = {
  sessionId: 'chain-1',
  completedNodes: ['route-agent'],
  currentNodeId: 'route-agent',
  errorNodeId: null,
  streamNodeId: null,
  streamRole: null,
  streamPhase: null,
  streamText: '',
  streaming: false,
  updatedAt: 1_700_000_772_000,
};

const runOf = (status: string, over: Record<string, unknown> = {}): ChainRunState =>
  ({ ...RUN_BASE, status, ...over } as ChainRunState);

const CHAPTERS = [
  {
    id: 'ch-12',
    title: '雨夜追凶',
    sortOrder: 11,
    status: 'draft',
    sections: [{ id: 'sec-12', sortOrder: 0, contentFile: 'chapters/第12章.md' }],
  },
];

/** E 段产出帧 fixture（append-only 到达序）。 */
function entryOf(nodeId: string, summary: TimelineNodeEntry['summary'], status: TimelineNodeEntry['status'] = 'done'): TimelineNodeEntry {
  return { nodeId, seq: -1, status, summary, tools: [], reasoning: [], at: 1_700_000_700_000 };
}

const ENVELOPE_PATCH = {
  'leader-1': {
    patch: {
      runId: 'leader-1',
      createdAt: '2026-09-18T00:00:00.000Z',
      patches: [
        {
          field: 'chapter_candidate',
          action: 'set',
          data: { chapterId: 'ch-12', runId: 'run-9', candidate: { chapterId: 'ch-12', title: '雨夜追凶', content: '正文', wordCount: 3000 } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    },
    selections: {},
  },
};

/** 两步落种（projectSubscription reset 先行）。 */
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
  (window as any).orisonDesktop = {
    readFile: vi.fn(async () => '# 第12章\n\n正文'),
  };
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(() => {
  cleanup();
  __clearAgentEventTracks();
  useAppStore.setState({
    currentProject: null,
    novelChapters: [],
    chainRunBySession: {},
    chainTimelineBySession: {},
    pausedReviewBySession: {},
    pendingPatchBySession: {},
    activeSidebarPanel: 'explorer',
    agentPanelOpen: false,
    openFiles: [],
    activeFilePath: null,
    mainView: 'page',
  } as any);
  delete (window as any).orisonDesktop;
});

describe('completed 落盘清单（按实际获得字段投影，缺不造数）', () => {
  function seedCompleted(entries: TimelineNodeEntry[], over: Record<string, unknown> = {}) {
    seedState({
      novelChapters: CHAPTERS,
      chainRunBySession: { 'chain-1': runOf('completed') },
      chainTimelineBySession: { 'chain-1': { sessionId: 'chain-1', entries, updatedAt: 1 } },
      ...over,
    });
    return render(
      <ChainOutcome sessionId="chain-1" run={runOf('completed')} timeline={useAppStore.getState().chainTimelineBySession['chain-1']} />,
    );
  }

  it('正文行（envelope chapterId → 章查表）+ 世界事件五轴合计 + 伏笔计数 + line 帧透传 + 跳转三钮', async () => {
    // CR-2：envelope 挂载会话需有项目归属（归属未知保守排除——projectChainChips 先例同口径）。
    rememberSessionProject('leader-1', '/proj-1');
    const entries = [
      entryOf('world-extractor-physical', { kind: 'items', label: 'physical 轴提取：5 条状态变化 · 3 主体', items: ['a'], total: 5 }),
      entryOf('world-extractor-cognitive', { kind: 'items', label: 'cognitive 轴提取：7 条状态变化 · 2 主体', items: ['b'], total: 7 }),
      entryOf('promise-emergence-node', { kind: 'items', label: 'Promise 涌现登记：2 项', items: ['x'], total: 2 }),
      entryOf('chapter-summary-node', { kind: 'line', line: '章摘要已物化：~1200 tokens——林晚雨夜交出钥匙。' }),
      entryOf('arc-emergence-node', { kind: 'line', line: '弧节拍声明：2 条（候选 线 1 / 卷 1 / 成长 0）' }),
      entryOf('story-sync-agent', { kind: 'line', line: 'story-sync：3 条设定补丁——保险柜知情圈更新' }),
      entryOf('feedback-ledger-node', { kind: 'line', line: '反馈台账：3/3 项已写（chapter、review、craft）' }),
    ];
    const { container } = seedCompleted(entries, { pendingPatchBySession: ENVELOPE_PATCH });

    const zone = container.querySelector('[data-outcome-kind="completed"]');
    expect(zone).not.toBeNull();

    // 正文行：envelope chapterId 命中 ch-12 → contentFile 路径 + 打开稿件钮。
    const prose = zone!.querySelector('[data-disk-metric="prose"]');
    expect(prose).not.toBeNull();
    expect(prose!.textContent).toContain('chapters/第12章.md');
    fireEvent.click(prose!.querySelector('.writing-disk-link')!);
    await Promise.resolve();
    expect((window as any).orisonDesktop.readFile).toHaveBeenCalledWith('/proj-1/chapters/第12章.md');
    expect(useAppStore.getState().activeFilePath).toBe('/proj-1/chapters/第12章.md');

    // 世界事件 = 五轴 items.total 求和（5+7，缺席三轴不造数不报错）。
    const world = zone!.querySelector('[data-disk-metric="worldEvents"]');
    expect(world?.querySelector('.writing-disk-cnt')?.textContent).toContain('12');

    // 伏笔计数 + line 帧透传（章摘要/反哺——预渲染串 verbatim）。
    expect(zone!.querySelector('[data-disk-metric="promises"]')?.querySelector('.writing-disk-cnt')?.textContent).toContain('2');
    expect(zone!.querySelector('[data-disk-metric="chapterSummary"]')?.textContent).toContain('章摘要已物化');
    expect(zone!.querySelector('[data-disk-metric="storySync"]')?.textContent).toContain('story-sync：3 条设定补丁');

    // 跳转：世界面板（sidebar panel 切换）+ 设定卡审阅（对话栏打开）。
    fireEvent.click(world!.querySelector('.writing-disk-link')!);
    expect(useAppStore.getState().activeSidebarPanel).toBe('world');
    fireEvent.click(zone!.querySelector('[data-disk-metric="storySync"]')!.querySelector('.writing-disk-link')!);
    expect(useAppStore.getState().agentPanelOpen).toBe(true);
  });

  it('envelope 缺席回落 pausedReview.chapterId；两者皆缺 → 无正文行不造数', () => {
    const entries = [
      entryOf('world-extractor-physical', { kind: 'items', label: 'l', items: [], total: 3 }),
    ];
    // 先验：envelope 与 pausedReview 皆缺 → 无正文行（缺不造数）。
    const first = seedCompleted(entries, { pausedReviewBySession: {} });
    const firstZone = first.container.querySelector('[data-outcome-kind="completed"]');
    expect(firstZone!.querySelector('[data-disk-metric="prose"]')).toBeNull();
    expect(firstZone!.querySelector('[data-disk-metric="worldEvents"]')?.querySelector('.writing-disk-cnt')?.textContent).toContain('3');

    // 回落源：pausedReview.chapterId（leader 路径 pause 记录——envelope 之外的可判面）。
    first.unmount();
    const second = seedCompleted(entries, {
      pausedReviewBySession: { 'chain-1': { type: 'chapter_review', stage: 'final', chapterId: 'ch-12' } as any },
    });
    const secondZone = second.container.querySelector('[data-outcome-kind="completed"]');
    expect(secondZone?.querySelector('[data-disk-metric="prose"]')?.textContent).toContain('chapters/第12章.md');
  });

  // CR-2（09-18 CR 批 B）：pendingPatchBySession 全局扫描加项目归属过滤——他项目 envelope 的
  // chapterId 不串进本链产物区（注水挂载键无归属 / 归属他项目皆排除）。
  it('CR-2 他项目 / 归属未知的 envelope 排除：正文行不串章（pausedReview 回落仍可用）', () => {
    const entries = [
      entryOf('world-extractor-physical', { kind: 'items', label: 'l', items: [], total: 1 }),
    ];
    // 归属他项目的 envelope（chapterId 指向本项目的 ch-12——若无过滤会串出正文行）。
    rememberSessionProject('leader-other-proj', '/other-proj');
    const heProject = seedCompleted(entries, {
      pendingPatchBySession: {
        'leader-other-proj': {
          patch: {
            runId: 'leader-other-proj',
            createdAt: '2026-09-18T00:00:00.000Z',
            patches: [{
              field: 'chapter_candidate',
              action: 'set',
              data: { chapterId: 'ch-12', runId: 'run-x', candidate: { chapterId: 'ch-12', title: '别章', content: 'x', wordCount: 1 } },
              fieldVersion: 1,
              generatedBy: 'write_chapter',
            }],
          },
          selections: {},
        },
      },
      pausedReviewBySession: {},
    });
    const heZone = heProject.container.querySelector('[data-outcome-kind="completed"]');
    expect(heZone!.querySelector('[data-disk-metric="prose"]')).toBeNull();
    heProject.unmount();

    // 归属未知（无事件面会话）同样排除。
    const unknown = seedCompleted(entries, {
      pendingPatchBySession: ENVELOPE_PATCH,
      pausedReviewBySession: {},
    });
    expect(unknown.container.querySelector('[data-outcome-kind="completed"]')!.querySelector('[data-disk-metric="prose"]')).toBeNull();
  });

  it('零产出帧 → noRows 兜底文案，零行不造数', () => {
    const { container } = seedCompleted([]);
    const zone = container.querySelector('[data-outcome-kind="completed"]');
    expect(zone?.querySelectorAll('.writing-disk-item').length).toBe(0);
    expect(zone?.textContent).toContain('writing.outcome.noRows');
  });
});

describe('error 失败卡（无断点重跑承诺）', () => {
  it('errorNodeId 定位 + 终态行明细 + 复制诊断（clipboard 机械组装）+ 回对话栏；无重跑钮', async () => {
    const entries = [
      entryOf('multi-review-agent', { kind: 'line', line: '节点失败：provider 429 · retry×3 exhausted' }, 'error'),
      entryOf('route-agent', { kind: 'line', line: '节点受阻：requiredArtifactKeys 缺失' }, 'blocked'),
    ];
    seedState({
      chainRunBySession: { 'chain-1': runOf('error', { errorNodeId: 'multi-review-agent', currentNodeId: 'multi-review-agent' }) },
      chainTimelineBySession: { 'chain-1': { sessionId: 'chain-1', entries, updatedAt: 1 } },
    });

    const { container, getByText } = render(
      <ChainOutcome
        sessionId="chain-1"
        run={runOf('error', { errorNodeId: 'multi-review-agent', currentNodeId: 'multi-review-agent' })}
        timeline={useAppStore.getState().chainTimelineBySession['chain-1']}
      />,
    );

    const zone = container.querySelector('[data-outcome-kind="error"]');
    expect(zone).not.toBeNull();
    expect(zone!.textContent).toContain('writing.outcome.errorAt');
    expect(zone!.querySelectorAll('.writing-outcome-errline')).toHaveLength(2);

    // 复制诊断：机械组装（session/status/errorNode/completedNodes/error 行）。
    fireEvent.click(getByText('writing.outcome.copyDiagnostics'));
    await Promise.resolve();
    const written = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(written).toContain('chain session: chain-1');
    expect(written).toContain('errorNode: multi-review-agent');
    expect(written).toContain('节点失败：provider 429');

    // 回对话栏 + 无断点重跑钮（actions 只两钮：复制诊断 / 回对话栏）。
    fireEvent.click(getByText('writing.outcome.backToChat'));
    expect(useAppStore.getState().agentPanelOpen).toBe(true);
    expect(zone!.querySelectorAll('.writing-outcome-actions button')).toHaveLength(2);
  });

  it('error 无 errorNodeId（终帧未达）→ unknown 文案；无明细帧 → noErrorDetail 兜底', () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('error', { errorNodeId: null, currentNodeId: null }) },
      chainTimelineBySession: { 'chain-1': { sessionId: 'chain-1', entries: [], updatedAt: 1 } },
    });
    const { container } = render(
      <ChainOutcome
        sessionId="chain-1"
        run={runOf('error', { errorNodeId: null, currentNodeId: null })}
        timeline={useAppStore.getState().chainTimelineBySession['chain-1']}
      />,
    );
    const zone = container.querySelector('[data-outcome-kind="error"]');
    expect(zone?.textContent).toContain('writing.outcome.errorAtUnknown');
    expect(zone?.textContent).toContain('writing.outcome.noErrorDetail');
  });
});

describe('aborted 中断卡 + 非终态 children 槽', () => {
  it('aborted：neutral 文案（放弃/被动中断并陈——无可靠数据面区分）+ 保留说明 + 重发起引导', () => {
    seedState({
      chainRunBySession: { 'chain-1': runOf('aborted') },
      chainTimelineBySession: { 'chain-1': { sessionId: 'chain-1', entries: [], updatedAt: 1 } },
    });
    const { container, getByText } = render(
      <ChainOutcome sessionId="chain-1" run={runOf('aborted')} timeline={useAppStore.getState().chainTimelineBySession['chain-1']} />,
    );

    const zone = container.querySelector('[data-outcome-kind="aborted"]');
    expect(zone).not.toBeNull();
    expect(zone?.textContent).toContain('writing.outcome.abortedTitle');
    expect(zone?.textContent).toContain('writing.outcome.abortedBody');
    expect(zone?.textContent).toContain('writing.outcome.abortedKept');
    fireEvent.click(getByText('writing.outcome.backToChat'));
    expect(useAppStore.getState().agentPanelOpen).toBe(true);
  });

  it('非终态（running）：无 outcome 卡，children 槽（W4 chapter_candidate 迁位）在 --pending 槽渲染', () => {
    seedState({ chainRunBySession: { 'chain-1': runOf('running') } });
    const { container } = render(
      <ChainOutcome sessionId="chain-1" run={runOf('running')} timeline={undefined}>
        <div data-testid="candidate-slot">pending-review</div>
      </ChainOutcome>,
    );
    expect(container.querySelector('[data-outcome-kind]')).toBeNull();
    expect(container.querySelector('.writing-outcome--pending [data-testid="candidate-slot"]')).not.toBeNull();
  });

  it('children 槽随 completed 卡顶部渲染（产物区顶部——W4 挂载位迁入）', () => {
    seedState({ chainRunBySession: { 'chain-1': runOf('completed') } });
    const { container } = render(
      <ChainOutcome sessionId="chain-1" run={runOf('completed')} timeline={undefined}>
        <div data-testid="candidate-slot">pending-review</div>
      </ChainOutcome>,
    );
    const zone = container.querySelector('[data-outcome-kind="completed"]');
    expect(zone?.querySelector('[data-testid="candidate-slot"]')).not.toBeNull();
    // children 在标题前（顶部）。
    expect(zone!.firstElementChild!.getAttribute('data-testid')).toBe('candidate-slot');
  });
});
