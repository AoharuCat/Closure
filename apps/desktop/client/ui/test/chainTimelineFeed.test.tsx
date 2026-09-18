/**
 * 09-13 子3 W3（design §3 / §8）：时间线渲染组件（ChainTimelineFeed / ChainRunMetaBar）。
 *
 * 覆盖（fixture 驱动——props 直喂 timeline/run，不经事件链）：
 * - 五 kind 产出卡渲染（brief-card 键值 / items 截断可观测 / findings severity 行 /
 *   route-decision / line）。
 * - 圈分组与历史圈折叠：route-decision 闭圈 → 历史圈折叠一行（entries 不渲染）；点开回看；
 *   活跃圈恒展开。
 * - 灰预览序：段内 nodeCatalog 序（loop 活跃圈差集）。
 * - append-only 多 attempt：同 nodeId 两圈两条节点行。
 * - writer 三档：思考 phase 分层（research/writing）+ 调查工具行 + 宽幅正文流（JSON 信封
 *   解包——信封语法不渲）。
 * - 空时间线：全目录灰预览（23 pending）。
 * - 运行摘要条：章名 fallback / 状态 / 相位圈数 / 时长（now 注时钟）/ 模型 chip 回退标注。
 *
 * mock 形态照 writingPage.test.tsx 谱（useI18n → 键名）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import { ChainRunMetaBar, ChainTimelineFeed } from '../src/features/writing/ChainTimeline';
import type { ChainRunState } from '../src/shared/store/chainStreamBuffer';
import type { ChainTimelineState, TimelineNodeEntry } from '../src/shared/store/chainTimeline';
import { CHAIN_NODE_ORDER } from '../src/shared/store/chainStreamBuffer';

let at = 1_000_000;
function entry(nodeId: string, over: Partial<TimelineNodeEntry> = {}): TimelineNodeEntry {
  at += 1_000;
  return { nodeId, seq: -1, status: 'done', tools: [], reasoning: [], at, ...over };
}

function routeDone(decision: string, reason = ''): TimelineNodeEntry {
  return entry('route-agent', { summary: { kind: 'route-decision', decision, reason } });
}

function fullLap(routeDecision: TimelineNodeEntry = routeDone('auto_revise', '节奏后半偏快')): TimelineNodeEntry[] {
  return [
    entry('revision-optimizer-node', { summary: { kind: 'line', line: '首圈 no-op 直通' } }),
    entry('draft-writer-agent', { summary: { kind: 'line', line: '整章交付：3,012 字' } }),
    entry('revision-guard-agent'),
    entry('lint-node', { summary: { kind: 'line', line: '去味扫描：2 命中' } }),
    entry('multi-review-agent'),
    entry('completeness-verify-node'),
    routeDecision,
  ];
}

function timelineOf(entries: TimelineNodeEntry[]): ChainTimelineState {
  return { sessionId: 'chain-1', entries, updatedAt: at };
}

function runOf(over: Partial<ChainRunState> = {}): ChainRunState {
  return {
    sessionId: 'chain-1', status: 'running', completedNodes: [], currentNodeId: null, errorNodeId: null,
    streamNodeId: null, streamRole: null, streamPhase: null, streamText: '', streaming: false,
    updatedAt: at, ...over,
  };
}

beforeEach(() => {
  at = 1_000_000;
});

afterEach(() => {
  cleanup();
});

/** done 态节点 fold 默认收起——迭代点开全部折叠块（历史圈层内含节点 fold：外层挂载后
 *  内层才可寻，循环至无闭合层）。 */
function openAllFolds(container: HTMLElement): void {
  for (let round = 0; round < 3; round++) {
    const closed = Array.from(container.querySelectorAll('.writing-fold[data-fold-open="false"]'));
    if (closed.length === 0) break;
    for (const fold of closed) {
      fireEvent.click(fold.querySelector('.writing-fold-summary') as HTMLElement);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 五 kind 产出卡
// ════════════════════════════════════════════════════════════════════════════

describe('五 kind 产出卡渲染', () => {
  it('brief-card 键值表 / items 截断可观测 / findings severity 行 / route-decision / line', () => {
    const entries = [
      entry('brief-compiler-node', {
        summary: { kind: 'brief-card', brief: { 本章目标: '林晚秋交钥匙动机成立', 场景: '巷口 · 保险柜房' } },
      }),
      entry('world-extractor-physical', {
        summary: { kind: 'items', label: '物理事件', items: ['雨停', '路灯熄灭'], total: 7 },
      }),
      entry('multi-review-agent', {
        summary: {
          kind: 'findings', verdict: 'needs_revision', summary: '动机链单薄',
          findings: [
            { label: '动机链', severity: 'hard', quote: '「她在犹豫」', note: '缺一拍铺垫' },
            { label: '节奏', severity: 'soft', quote: '', note: '后半偏快' },
            { label: '用词', severity: 'info', quote: '', note: '两处重复' },
          ], total: 3,
        },
      }),
      routeDone('accept', '硬伤已闭合'),
      entry('lint-node', { summary: { kind: 'line', line: '去味扫描：2 命中（高优 1）' } }),
    ];
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={runOf()} />);

    // quick 档 brief-compiler 紧凑展开：折叠态不渲卡片，点开即见。
    const briefNode = container.querySelector('[data-node-id="brief-compiler-node"]') as HTMLElement;
    expect(briefNode.querySelector('.writing-fold-summary')).not.toBeNull();
    expect(briefNode.querySelector('[data-artifact-kind="brief-card"]')).toBeNull();
    fireEvent.click(briefNode.querySelector('.writing-fold-summary') as HTMLElement);
    const briefCard = briefNode.querySelector('[data-artifact-kind="brief-card"]');
    expect(briefCard).not.toBeNull();
    expect(briefCard?.querySelectorAll('.writing-kv-row')).toHaveLength(2);
    expect(briefCard?.textContent).toContain('林晚秋交钥匙动机成立');

    // analysis 档 fold 默认收起——统一点开后断言四 kind。
    openAllFolds(container);

    // items：2/7 截断可观测（count chip + truncated 注记）。
    const itemsCard = container.querySelector('[data-artifact-kind="items"]');
    expect(itemsCard?.querySelectorAll('.writing-itemline')).toHaveLength(2);
    expect(itemsCard?.querySelector('.writing-artifact-truncated')?.textContent).toBe('chain.artifact.truncated');

    // findings：severity 徽（i18n 键）+ label/note + quote 行。
    const findingsCard = container.querySelector('[data-artifact-kind="findings"]');
    expect(findingsCard?.querySelectorAll('.writing-finding')).toHaveLength(3);
    expect(findingsCard?.querySelector('.writing-finding-sev--hard')?.textContent).toBe('chain.sev.hard');
    expect(findingsCard?.querySelector('.writing-finding-sev--soft')?.textContent).toBe('chain.sev.soft');
    expect(findingsCard?.querySelector('.writing-finding-quote')?.textContent).toContain('她在犹豫');
    expect(findingsCard?.querySelector('.writing-artifact-verdict')?.textContent).toBe('needs_revision');

    // route-decision：decision + reason；行右侧 verdict chip（行面恒渲染）。
    const routeCard = container.querySelector('[data-artifact-kind="route-decision"]');
    expect(routeCard?.querySelector('.writing-route-d')?.textContent).toBe('accept');
    expect(routeCard?.querySelector('.writing-route-why')?.textContent).toBe('硬伤已闭合');
    const routeRow = container.querySelector('[data-node-id="route-agent"]');
    expect(routeRow?.querySelector('.writing-verdict--ok')?.textContent).toBe('accept');

    // line（quick 档）：行 meta 直出单行摘要。
    const lintRow = container.querySelector('[data-node-id="lint-node"]');
    expect(lintRow?.querySelector('.writing-node-meta')?.textContent).toContain('去味扫描：2 命中');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 圈分组与历史圈折叠 / 灰预览 / append-only
// ════════════════════════════════════════════════════════════════════════════

describe('圈分组与历史圈折叠', () => {
  it('第 1 圈闭合折叠（entries 不渲染）→ 点开回看；第 2 圈活跃展开', () => {
    const entries = [...fullLap(), entry('revision-optimizer-node'), entry('draft-writer-agent', { status: 'running' })];
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={runOf()} />);

    const lap1 = container.querySelector('[data-timeline-lap="1"]');
    const lap2 = container.querySelector('[data-timeline-lap="2"]');
    expect(lap1?.getAttribute('data-lap-state')).toBe('historical');
    expect(lap2?.getAttribute('data-lap-state')).toBe('active');

    // 历史圈折叠：圈内 entries 不在 DOM；折叠摘要含判决信息键。
    expect(lap1?.querySelector('[data-node-id="lint-node"]')).toBeNull();
    expect(lap1?.querySelector('.writing-lap-history-summary')?.textContent).toBe('chain.lap.summaryWithReason');

    // 活跃圈恒展开。
    expect(lap2?.querySelector('[data-node-id="draft-writer-agent"]')).not.toBeNull();

    // 点开历史圈回看。
    fireEvent.click(lap1?.querySelector('.writing-fold-summary') as HTMLElement);
    expect(container.querySelector('[data-timeline-lap="1"] [data-node-id="lint-node"]')).not.toBeNull();
  });

  it('灰预览序：loop 活跃圈差集按 nodeCatalog 序', () => {
    const entries = [
      entry('brief-compiler-node'),
      entry('brief-reviewer-node'),
      ...fullLap(),
      entry('revision-optimizer-node'),
      entry('draft-writer-agent', { status: 'running' }),
    ];
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={runOf()} />);

    const pending = Array.from(container.querySelectorAll('.writing-node--pending')).map((n) => n.getAttribute('data-node-id'));
    // plan 段已全跑 + loop 活跃圈跑到写手 → 灰 = [guard, lint, multi, completeness, route] + extract 全 14。
    expect(pending).toEqual([
      'revision-guard-agent', 'lint-node', 'multi-review-agent', 'completeness-verify-node', 'route-agent',
      ...CHAIN_NODE_ORDER.filter((id) => id.startsWith('world-extractor') || [
        'world-merge-node', 'emotion-verify-node', 'promise-emergence-node', 'arc-emergence-node',
        'chapter-summary-node', 'storytime-drift-node', 'mention-ledger-node', 'story-sync-agent', 'feedback-ledger-node',
      ].includes(id)),
    ]);
    // 段标题行三段在场（plan/loop/extract——extract 未达也有标题 + 灰预览）。
    expect(container.querySelectorAll('.writing-seg-head')).toHaveLength(3);
  });

  it('append-only 多 attempt：同 nodeId（写手）两圈两条节点行', () => {
    const entries = [...fullLap(), entry('revision-optimizer-node'), entry('draft-writer-agent', { status: 'running' })];
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={runOf()} />);
    fireEvent.click(container.querySelector('[data-timeline-lap="1"] .writing-fold-summary') as HTMLElement);
    const writerRows = container.querySelectorAll('[data-node-id="draft-writer-agent"]');
    expect(writerRows).toHaveLength(2);
  });

  it('节点状态图标：done/error/running/pending 四态类', () => {
    const entries = [
      entry('brief-compiler-node'),
      entry('brief-reviewer-node', { status: 'error' }),
      entry('revision-optimizer-node', { status: 'running' }),
    ];
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={runOf()} />);
    expect(container.querySelector('[data-node-id="brief-compiler-node"]')?.className).toContain('writing-node--done');
    expect(container.querySelector('[data-node-id="brief-reviewer-node"]')?.className).toContain('writing-node--error');
    expect(container.querySelector('[data-node-id="revision-optimizer-node"]')?.className).toContain('writing-node--running');
    expect(container.querySelector('[data-node-id="lint-node"]')?.className).toContain('writing-node--pending');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// writer 三档（phase 分层 + 工具行 + 正文流）
// ════════════════════════════════════════════════════════════════════════════

describe('writer 三档模板', () => {
  it('思考 phase 分层（research→writing）+ 调查工具行 + 正文流 JSON 信封解包', () => {
    const entries = [
      entry('brief-compiler-node'),
      entry('brief-reviewer-node'),
      entry('revision-optimizer-node', { summary: { kind: 'line', line: '3 findings → 定向修订' } }),
      entry('draft-writer-agent', {
        status: 'running',
        reasoning: [
          { messageId: 'r1', phase: 'research', text: '核对第 7 章知情圈表述……' },
          { messageId: 'r2', phase: 'writing', text: '钥匙推半寸的犹豫分两拍写……' },
        ],
        tools: [
          { nodeId: 'draft-writer-agent', toolName: 'kb_query', inputSummary: '林晚秋 知情圈', resultCount: 4, status: 'ok' },
          { nodeId: 'draft-writer-agent', toolName: 'web_search', inputSummary: '夜路步态特征', status: 'error' },
        ],
      }),
    ];
    const run = runOf({
      streamNodeId: 'draft-writer-agent',
      streamText: '{"title":"第3章 黄昏","text":"黄昏的荒野上，主角深吸一口气。","wordCount":1832}\n<DRAFT_READY>',
      streaming: true,
    });
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={run} />);

    const writerNode = container.querySelector('[data-node-id="draft-writer-agent"]') as HTMLElement;
    // running 态 fold 默认展开——三档细节直出。
    expect(writerNode.querySelector('.writing-fold')?.getAttribute('data-fold-open')).toBe('true');

    // phase 分层（按 phase 字段，勿按工具轮次）。
    const phases = Array.from(writerNode.querySelectorAll('.writing-think')).map((n) => n.getAttribute('data-think-phase'));
    expect(phases).toEqual(['research', 'writing']);
    expect(writerNode.querySelector('[data-think-phase="research"] .writing-think-body')?.textContent)
      .toContain('核对第 7 章知情圈表述');

    // 调查工具行：toolName + 状态色。
    const toolRows = writerNode.querySelectorAll('.writing-tool-row');
    expect(toolRows).toHaveLength(2);
    expect(toolRows[0].querySelector('.writing-tool-tn')?.textContent).toBe('kb_query');
    expect(toolRows[0].querySelector('.writing-tool-ts--ok')?.textContent).toContain('4');
    expect(toolRows[1].querySelector('.writing-tool-ts--error')).not.toBeNull();

    // 正文流：信封解包（text 值可读，title/信封语法/尾部标记不渲）。
    const prose = writerNode.querySelector('[data-prose-stream]');
    expect(prose).not.toBeNull();
    expect(screen.getByText('黄昏的荒野上，主角深吸一口气。')).toBeTruthy();
    expect(prose?.textContent).not.toContain('第3章 黄昏');
    expect(prose?.textContent).not.toContain('"text"');
    expect(prose?.textContent).not.toContain('DRAFT_READY');
    // 流式 caret 类在位（agent-msg-md--streaming 复用）。
    expect(prose?.querySelector('.agent-msg-md--streaming')).not.toBeNull();
  });

  it('正文流只在当前流归属的写手 entry：历史圈写手无 prose（产出摘要承载）', () => {
    const entries = [...fullLap(), entry('revision-optimizer-node'), entry('draft-writer-agent', { status: 'running' })];
    const run = runOf({
      streamNodeId: 'draft-writer-agent',
      streamText: '{"title":"t","text":"第二圈正文","wordCount":5}',
      streaming: true,
    });
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={run} />);
    fireEvent.click(container.querySelector('[data-timeline-lap="1"] .writing-fold-summary') as HTMLElement);

    const proseBlocks = container.querySelectorAll('[data-prose-stream]');
    expect(proseBlocks).toHaveLength(1); // 只活跃圈写手有
    expect(proseBlocks[0].textContent).toContain('第二圈正文');
  });

  it('写手 done（streaming 收口）→ 正文流退场（终稿全文归审阅卡，量控不双存）', () => {
    const entries = [
      entry('brief-compiler-node'),
      entry('brief-reviewer-node'),
      entry('revision-optimizer-node'),
      entry('draft-writer-agent', { status: 'done', summary: { kind: 'line', line: '整章交付：3,012 字' } }),
    ];
    const run = runOf({ streamNodeId: 'draft-writer-agent', streamText: '{"title":"t","text":"已写完","wordCount":4}', streaming: false, status: 'paused' });
    const { container } = render(<ChainTimelineFeed timeline={timelineOf(entries)} run={run} />);
    expect(container.querySelector('[data-prose-stream]')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 空时间线 + 运行摘要条
// ════════════════════════════════════════════════════════════════════════════

describe('空时间线与运行摘要条', () => {
  it('run 在但无 entries → 全目录灰预览（23 pending + 三段标题）', () => {
    const { container } = render(<ChainTimelineFeed timeline={undefined} run={runOf()} />);
    expect(container.querySelectorAll('.writing-node--pending')).toHaveLength(23);
    expect(container.querySelectorAll('.writing-seg-head')).toHaveLength(3);
  });

  // CR-12（09-18 CR 批 B）：空 entries 的 idle 行按 run 状态分文案（原实现恒显 generating——
  // paused / 终态被误标「正在生成」）。
  it('CR-12 空 entries idle 行按 run 状态分文案（running/paused/终态三态）', () => {
    const running = render(<ChainTimelineFeed timeline={undefined} run={runOf({ status: 'running' })} />);
    const idleRunning = running.container.querySelector('.writing-timeline-idle');
    expect(idleRunning?.textContent).toBe('writing.timeline.idleRunning');
    expect(idleRunning?.getAttribute('data-timeline-idle')).toBe('running');
    running.unmount();

    const paused = render(<ChainTimelineFeed timeline={undefined} run={runOf({ status: 'paused' })} />);
    expect(paused.container.querySelector('.writing-timeline-idle')?.textContent).toBe('writing.timeline.idlePaused');
    paused.unmount();

    const completed = render(<ChainTimelineFeed timeline={undefined} run={runOf({ status: 'completed' })} />);
    const idleDone = completed.container.querySelector('.writing-timeline-idle');
    expect(idleDone?.textContent).toBe('writing.timeline.idleEmpty');
    expect(idleDone?.getAttribute('data-timeline-idle')).toBe('completed');
    completed.unmount();

    const aborted = render(<ChainTimelineFeed timeline={undefined} run={runOf({ status: 'aborted' })} />);
    expect(aborted.container.querySelector('.writing-timeline-idle')?.textContent).toBe('writing.timeline.idleEmpty');
    aborted.unmount();

    // 有 entries → idle 行退场（正常 feed）。
    const withEntries = render(
      <ChainTimelineFeed timeline={timelineOf([entry('brief-compiler-node')])} run={runOf({ status: 'paused' })} />,
    );
    expect(withEntries.container.querySelector('.writing-timeline-idle')).toBeNull();
  });

  // CR-11（09-18 CR 批 B）：loop 完成后（extract 段起）摘要条常驻「自审收敛 N 圈」chip；
  // loop 段活跃时显当前圈号（chip 不出）；零圈不渲染。
  it('CR-11 摘要条「自审收敛 N 圈」chip：loop 完成后常驻；loop 活跃时不出；零圈不出', () => {
    // loop 活跃（第 2 圈未闭合）：phase 段显圈号，laps chip 不出。
    const active = render(
      <ChainRunMetaBar
        run={runOf({ status: 'running' })}
        timeline={timelineOf([...fullLap(), entry('revision-optimizer-node'), entry('draft-writer-agent', { status: 'running' })])}
        chapterTitle={null}
        modelChip={null}
      />,
    );
    expect(active.container.querySelector('.writing-runmeta-laps')).toBeNull();
    expect(active.container.querySelector('.writing-runmeta-lap')).not.toBeNull();
    active.unmount();

    // loop 完成（route=accept 闭圈 + extract 已跑）：laps chip 常驻（圈数 = 闭合圈数）。
    const done = render(
      <ChainRunMetaBar
        run={runOf({ status: 'running' })}
        timeline={timelineOf([...fullLap(routeDone('accept')), entry('world-extractor-physical')])}
        chapterTitle={null}
        modelChip={null}
      />,
    );
    const chip = done.container.querySelector('.writing-runmeta-laps');
    expect(chip?.textContent).toBe('writing.run.lapsDone');
    expect(chip?.getAttribute('data-run-laps')).toBe('1');
    done.unmount();

    // 两圈闭合 → N=2；终态（completed）chip 仍常驻（D-e「accept 后不消失」）。
    const terminalTwoLaps = timelineOf([
      ...fullLap(routeDone('auto_revise')),
      ...fullLap(routeDone('accept')),
      entry('world-extractor-physical'),
    ]);
    const finished = render(
      <ChainRunMetaBar
        run={runOf({ status: 'completed' })}
        timeline={terminalTwoLaps}
        chapterTitle={null}
        modelChip={null}
      />,
    );
    expect(finished.container.querySelector('.writing-runmeta-laps')?.getAttribute('data-run-laps')).toBe('2');
    finished.unmount();

    // 零圈（未进环 / 无 route-decision 闭圈帧）→ 不渲染。
    const noLaps = render(
      <ChainRunMetaBar
        run={runOf({ status: 'running' })}
        timeline={timelineOf([entry('brief-compiler-node')])}
        chapterTitle={null}
        modelChip={null}
      />,
    );
    expect(noLaps.container.querySelector('.writing-runmeta-laps')).toBeNull();
  });

  // CR-4②（09-18 CR 批 B）：enterReview 槽——null 不渲染；有值渲染「进审阅」钮。
  it('CR-4② 摘要条 enterReview 槽：null 缺席；有值渲染手动再入钮', () => {
    const none = render(
      <ChainRunMetaBar run={runOf({ status: 'running' })} timeline={undefined} chapterTitle={null} modelChip={null} />,
    );
    expect(none.container.querySelector('[data-run-enter-review]')).toBeNull();
    none.unmount();

    const onClick = vi.fn();
    const withBtn = render(
      <ChainRunMetaBar
        run={runOf({ status: 'paused' })}
        timeline={undefined}
        chapterTitle={null}
        modelChip={null}
        enterReview={{ label: 'writing.run.enterReview', onClick }}
      />,
    );
    const btn = withBtn.container.querySelector('[data-run-enter-review]') as HTMLButtonElement;
    expect(btn?.textContent).toBe('writing.run.enterReview');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('摘要条：fallback 章名 / 状态 / 相位圈数 / 时长（now 注时钟）/ 模型回退标注', () => {
    const timeline = timelineOf([...fullLap(), entry('revision-optimizer-node'), entry('draft-writer-agent', { status: 'running' })]);
    const { container } = render(
      <ChainRunMetaBar
        run={runOf({ status: 'paused' })}
        timeline={timeline}
        chapterTitle={null}
        modelChip={{ name: 'glm-5.3', fallbackFrom: 'glm-5.3-pro', reason: 'timeout: 网关超时' }}
        now={timeline.entries[0].at + 754_000}
      />,
    );

    const bar = container.querySelector('[data-writing-runmeta]') as HTMLElement;
    expect(bar.getAttribute('data-run-status')).toBe('paused');
    // fallback 章名（链→章映射弱承诺）。
    expect(bar.querySelector('.writing-runmeta-chapter')?.textContent).toBe('writing.run.fallbackTitle');
    // 相位圈数：loop · 第 2 圈（paused 停在环内）。
    expect(bar.querySelector('.writing-runmeta-phase')?.textContent).toContain('chain.segment.loop');
    expect(bar.querySelector('.writing-runmeta-lap')).not.toBeNull();
    // 状态词（i18n 键）。
    expect(bar.querySelector('.writing-runmeta-status--paused')?.textContent).toBe('writing.run.status.paused');
    // 时长 = now - 首个 entry.at → 12:34。
    expect(bar.querySelector('.writing-runmeta-elapsed')?.textContent).toContain('12:34');
    // 模型 chip + 回退标注。
    const model = bar.querySelector('.writing-runmeta-model');
    expect(model?.textContent).toContain('glm-5.3');
    expect(model?.querySelector('.writing-runmeta-model-fb')?.textContent).toBe('writing.run.modelFallback');
    expect(model?.querySelector('.writing-runmeta-model-fb')?.getAttribute('title')).toBe('timeout: 网关超时');
  });

  it('摘要条：章名 prop 直显；extract 段相位无圈号；无模型 chip 不渲染', () => {
    const timeline = timelineOf([
      ...fullLap(routeDone('accept')),
      entry('world-extractor-physical'),
    ]);
    const { container } = render(
      <ChainRunMetaBar
        run={runOf({ status: 'running' })}
        timeline={timeline}
        chapterTitle="第 12 章 · 雨夜追凶"
        modelChip={null}
        now={timeline.entries[0].at + 45_000}
      />,
    );
    const bar = container.querySelector('[data-writing-runmeta]') as HTMLElement;
    expect(bar.querySelector('.writing-runmeta-chapter')?.textContent).toBe('第 12 章 · 雨夜追凶');
    expect(bar.querySelector('.writing-runmeta-phase')?.textContent).toContain('chain.segment.extract');
    expect(bar.querySelector('.writing-runmeta-lap')).toBeNull();
    expect(bar.querySelector('.writing-runmeta-model')).toBeNull();
    expect(bar.querySelector('.writing-runmeta-elapsed')?.textContent).toContain('0:45');
  });
});
