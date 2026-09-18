import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import type { ChainNodeArtifactSummary, ChainRunState } from '../../shared/store/chainStreamBuffer';
import type { ChainTimelineState, TimelineNodeEntry } from '../../shared/store/chainTimeline';
import { extractChainDraftView } from '../agent-panel/chainEnvelope';
import { nodeCatalogEntry, type ChainNodeSegment } from './nodeCatalog';
import {
  artifactChipView,
  countChars,
  entryDurationMs,
  findingToneOf,
  formatCharCount,
  formatElapsed,
  formatNodeDuration,
  groupReasoningByPhase,
  nodeDisplayName,
  projectTimelineFeed,
  projectTimelineFeedMeta,
  severityLabel,
  type ModelChipView,
  type ReasoningPhaseGroup,
  type TimelineFeedBlock,
  type TimelineLap,
} from './chainTimelineView';

// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子3 W3（design §3）：写作页运行时间线渲染组件。
//
// 数据面（全部只读消费——W2 store 产物）：
// - `chainTimelineBySession[sid].entries`：append-only 节点段（思考/工具/产出快照）；
// - `chainRunBySession[sid]`：run 级状态 + streamText（正文流单源——历史圈只显产出摘要，
//   终稿全文在审阅卡，量控不双存）。
//
// 组件分区：
// - `ChainRunMetaBar`：运行摘要条（章名 fallback「写章链」/状态与圈数/时长=首个 entry.at/
//   模型 chip + 回退标注；无余量条——context-usage 是 leader 车道专属事件，链车道无数据）。
// - `ChainTimelineFeed`：段结构（规划环/自审环/提取段标题行 + 未跑灰预览）+ 圈分组
//   （route-decision 帧为圈边界；历史圈折叠一行点开回看）+ 四档节点模板
//   （writer=思考 phase 分层+调查工具行+宽幅正文流 / analysis=思考+五 kind 产出卡 /
//   quick=单行摘要；brief-compiler 的 brief-card 紧凑展开）。
//
// 呈现纪律：
// - 正文流经 `extractChainDraftView` 解 JSON 信封（ChainRunCard 同款——streamText 是原始
//   累积，锚点前与闭合后的信封语法一概不渲）；**无停滞标记**（链车道无 stalled 机制，
//   design 定谳 defer）。
// - 折叠块用受控 state（非原生 details——测试可确定性驱动）；running 态默认展开、done 收口
//   自动收起（用户手动操作优先——不被后续渲染翻回）。
// - 思考流实时层（活跃 running entry 的末层）body 自动滚底；jsdom 零布局恒 0 无害。
// ─────────────────────────────────────────────────────────────────────────────

function renderMarkdown(content: string): string {
  // Sanitize（mirror ChainRunCard.renderMarkdown——链正文是模型原始输出，renderer 持 IPC 面）。
  const html = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** 受控折叠块（summary 点击翻转；defaultOpen 变化时跟随——用户手动操作后不再跟随）。 */
function Fold({ defaultOpen, summary, children }: { defaultOpen: boolean; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const [userTouched, setUserTouched] = useState(false);
  useEffect(() => {
    if (!userTouched) setOpen(defaultOpen);
  }, [defaultOpen, userTouched]);
  return (
    <div className="writing-fold" data-fold-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="writing-fold-summary"
        aria-expanded={open}
        onClick={() => {
          setUserTouched(true);
          setOpen((prev) => !prev);
        }}
      >
        <span className="writing-fold-tw" aria-hidden="true">▶</span>
        <span className="writing-fold-summary-text">{summary}</span>
      </button>
      {open ? <div className="writing-fold-body">{children}</div> : null}
    </div>
  );
}

// ── 产出卡（五 kind） ──

function formatArtifactValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(value);
  }
}

function ArtifactCard({ summary }: { summary: ChainNodeArtifactSummary }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);

  if (summary.kind === 'brief-card') {
    const rows = Object.entries(summary.brief).slice(0, 30); // agent 侧超限已降级 line——防御截断
    return (
      <div className="writing-artifact" data-artifact-kind="brief-card">
        <div className="writing-artifact-title">{t('chain.artifact.briefTitle')}</div>
        {rows.length > 0 ? (
          <dl className="writing-kv">
            {rows.map(([k, v]) => (
              <div className="writing-kv-row" key={k}>
                <dt className="writing-kv-k">{k}</dt>
                <dd className="writing-kv-v">{formatArtifactValue(v)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="writing-artifact-note">{t('chain.artifact.empty')}</p>
        )}
      </div>
    );
  }

  if (summary.kind === 'items') {
    const truncated = summary.total > summary.items.length;
    return (
      <div className="writing-artifact" data-artifact-kind="items">
        <div className="writing-artifact-title">
          {summary.label || t('chain.artifact.lineTitle')}
          <span className="writing-artifact-count">
            {truncated
              ? t('chain.artifact.count', { n: `${summary.items.length}/${summary.total}` })
              : t('chain.artifact.count', { n: summary.total })}
          </span>
        </div>
        {summary.items.length > 0 ? (
          <ul className="writing-artifact-items">
            {summary.items.map((item, i) => (
              <li className="writing-itemline" key={`${i}-${item.slice(0, 24)}`}>{item}</li>
            ))}
          </ul>
        ) : null}
        {truncated ? <div className="writing-artifact-truncated">{t('chain.artifact.truncated', { total: summary.total })}</div> : null}
      </div>
    );
  }

  if (summary.kind === 'findings') {
    return (
      <div className="writing-artifact" data-artifact-kind="findings">
        <div className="writing-artifact-title">
          {t('chain.artifact.findingsTitle')}
          {summary.findings.length > 0 ? (
            <span className="writing-artifact-count">{t('chain.artifact.count', { n: summary.total })}</span>
          ) : null}
        </div>
        {summary.verdict ? <div className="writing-artifact-verdict">{summary.verdict}</div> : null}
        {summary.summary ? <p className="writing-artifact-note">{summary.summary}</p> : null}
        {summary.findings.map((f, i) => {
          const tone = findingToneOf(f.severity);
          return (
            <div className="writing-finding" key={`${i}-${f.label}`}>
              <span className={`writing-finding-sev writing-finding-sev--${tone}`}>{severityLabel(f.severity, t)}</span>
              <span className="writing-finding-fx">
                {f.label ? <b>{f.label}</b> : null}
                {f.label && f.note ? ' —— ' : ''}
                {f.note || ''}
                {f.quote ? <span className="writing-finding-quote">「{f.quote}」</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  if (summary.kind === 'route-decision') {
    return (
      <div className="writing-artifact" data-artifact-kind="route-decision">
        <div className="writing-route">
          <span className="writing-route-d">{summary.decision}</span>
        </div>
        {summary.reason ? <div className="writing-route-why">{summary.reason}</div> : null}
      </div>
    );
  }

  return (
    <div className="writing-artifact" data-artifact-kind="line">
      <p className="writing-artifact-line">{summary.line}</p>
    </div>
  );
}

// ── 思考流（phase 分层） ──

function phaseLabel(phase: string | null, t: (key: string) => string): string {
  if (phase === 'research' || phase === 'writing' || phase === 'declaration') return t(`chain.phase.${phase}`);
  return t('chain.phase.other');
}

function ReasoningGroup({ group, live }: { group: ReasoningPhaseGroup; live: boolean }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const text = group.texts.join('');
  // 实时层（live）滚底跟随：思考仍在生长时贴底；jsdom 无布局（scrollHeight 恒 0）无害。
  useEffect(() => {
    if (live && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, live]);
  return (
    <div className="writing-think" data-think-phase={group.phase ?? 'other'}>
      <div className="writing-think-head">
        <span className="writing-think-k">{phaseLabel(group.phase, t)}</span>
        <span className="writing-think-state">{live ? t('chain.phase.live') : t('chain.phase.doneReview')}</span>
      </div>
      <div ref={bodyRef} className={`writing-think-body${live ? '' : ' writing-think-body--dim'}`}>{text}</div>
    </div>
  );
}

// ── 调查工具行 + 正文流（writer 档） ──

function ToolRows({ tools }: { tools: TimelineNodeEntry['tools'] }) {
  if (tools.length === 0) return null;
  return (
    <div className="writing-tools">
      {tools.map((tool, i) => (
        <div className="writing-tool-row" key={`${i}-${tool.toolName}`}>
          <span className="writing-tool-tn">{tool.toolName}</span>
          {tool.inputSummary ? <span className="writing-tool-arg">{tool.inputSummary}</span> : null}
          <span className={`writing-tool-ts writing-tool-ts--${tool.status}`}>
            {tool.status === 'ok' ? (tool.resultCount !== undefined ? `✓ ${tool.resultCount}` : '✓') : '✗'}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProseStream({ streamText, streaming }: { streamText: string; streaming: boolean }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const proseText = useMemo(() => extractChainDraftView(streamText).text, [streamText]);
  const bodyHtml = useMemo(() => (proseText ? renderMarkdown(proseText) : ''), [proseText]);
  return (
    <div className="writing-prose" data-prose-stream>
      <div className="writing-prose-head">
        <span>{t('chain.prose.label')}</span>
        <span aria-hidden="true">·</span>
        <span className="writing-prose-words">{t('chain.prose.words', { n: countChars(proseText).toLocaleString() })}</span>
      </div>
      {bodyHtml ? (
        <div
          className={`agent-msg-md${streaming ? ' agent-msg-md--streaming' : ''} writing-prose-body`}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      ) : (
        <div className="writing-prose-body writing-prose-body--pending">{t('chain.prose.generating')}</div>
      )}
    </div>
  );
}

// ── 节点行（四档模板的行面） ──

type NodeRowProps = {
  entry: TimelineNodeEntry;
  /** 该 entry 的耗时参照（end fallback = 活动时钟或终态停表）。 */
  endFallback: number;
  tier: 'writer' | 'analysis' | 'quick';
  entries: TimelineNodeEntry[];
  entryIndex: number;
  /** writer 档：本 entry 是否当前流（streamText 展示归属）。 */
  liveProse: { text: string; streaming: boolean } | null;
};

function NodeRow({ entry, tier, entries, entryIndex, endFallback, liveProse }: NodeRowProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const catalog = nodeCatalogEntry(entry.nodeId);
  const statusClass = entry.status === 'blocked' ? 'error' : entry.status;
  const chip = artifactChipView(entry.summary, t);
  const duration = entryDurationMs(entries, entryIndex, endFallback);
  const reasoningGroups = useMemo(() => groupReasoningByPhase(entry.reasoning), [entry.reasoning]);
  const reasoningChars = entry.reasoning.reduce((n, seg) => n + seg.text.length, 0);
  const running = entry.status === 'running';

  // quick 档行中 meta：line 单行摘要（产出卡只在 brief-card 紧凑展开）。
  const inlineMeta =
    tier === 'quick' && entry.summary?.kind === 'line' ? entry.summary.line
    : tier === 'writer' && liveProse ? t('chain.prose.words', { n: countChars(liveProse.text).toLocaleString() })
    : null;

  // 折叠 summary 部件（writer：思考｜调查｜正文流；analysis：思考｜产出卡；brief-compiler：产出卡）。
  const summaryParts: string[] = [];
  if (tier !== 'quick' && reasoningChars > 0) {
    summaryParts.push(t('chain.thinking.summary', { n: formatCharCount(reasoningChars) }));
  }
  if (tier === 'writer' && entry.tools.length > 0) {
    summaryParts.push(t('chain.tools.summary', { n: entry.tools.length }));
  }
  if (tier === 'writer' && liveProse) {
    summaryParts.push(t('chain.prose.label'));
  }
  if (entry.summary) {
    const s = entry.summary;
    if (s.kind === 'findings') summaryParts.push(t('chain.artifact.findingsSummary', { n: s.total }));
    else if (s.kind === 'brief-card') summaryParts.push(t('chain.artifact.briefSummary'));
    else if (s.kind === 'route-decision') summaryParts.push(t('chain.artifact.routeSummary', { decision: s.decision }));
    else if (s.kind === 'items') summaryParts.push(t('chain.artifact.itemsSummary', { label: s.label, n: s.total }));
  }

  const hasDetail =
    (tier === 'writer' && (reasoningChars > 0 || entry.tools.length > 0 || liveProse !== null))
    || (tier === 'analysis' && (reasoningChars > 0 || entry.summary !== undefined))
    || (tier === 'quick' && entry.summary?.kind === 'brief-card');

  return (
    <div
      className={`writing-node writing-node--${statusClass}`}
      data-node-id={entry.nodeId}
      data-node-status={entry.status}
      data-node-tier={tier}
    >
      <span className="writing-node-pip" aria-hidden="true" />
      <div className="writing-node-row">
        {catalog ? <span className="material-symbols-outlined writing-node-icon" aria-hidden="true">{catalog.icon}</span> : null}
        <span className="writing-node-name">{nodeDisplayName(entry.nodeId, t)}</span>
        {inlineMeta ? <span className="writing-node-meta">{inlineMeta}</span> : null}
        <span className="writing-node-right">
          {chip ? <span className={`writing-verdict writing-verdict--${chip.tone}`}>{chip.text}</span> : null}
          {duration > 0 ? <span className="writing-node-time">{formatNodeDuration(duration)}</span> : null}
        </span>
      </div>
      {hasDetail ? (
        <Fold defaultOpen={running} summary={<span className="writing-fold-parts">{summaryParts.join(' ｜ ')}</span>}>
          <div className="writing-node-detail">
            {tier !== 'quick' && reasoningGroups.length > 0 ? (
              <div className="writing-sub-block">
                {reasoningGroups.map((group, gi) => (
                  <ReasoningGroup
                    key={`${group.phase ?? 'other'}-${gi}`}
                    group={group}
                    live={running && gi === reasoningGroups.length - 1}
                  />
                ))}
              </div>
            ) : null}
            {tier === 'writer' ? (
              <div className="writing-sub-block">
                <ToolRows tools={entry.tools} />
              </div>
            ) : null}
            {tier === 'writer' && liveProse ? (
              <ProseStream streamText={liveProse.text} streaming={liveProse.streaming} />
            ) : null}
            {tier === 'analysis' && entry.summary ? <ArtifactCard summary={entry.summary} /> : null}
            {tier === 'quick' && entry.summary?.kind === 'brief-card' ? <ArtifactCard summary={entry.summary} /> : null}
          </div>
        </Fold>
      ) : null}
    </div>
  );
}

function PendingNodeRow({ nodeId }: { nodeId: string }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const catalog = nodeCatalogEntry(nodeId);
  return (
    <div className="writing-node writing-node--pending" data-node-id={nodeId} data-node-status="pending">
      <span className="writing-node-pip" aria-hidden="true" />
      <div className="writing-node-row">
        {catalog ? <span className="material-symbols-outlined writing-node-icon" aria-hidden="true">{catalog.icon}</span> : null}
        <span className="writing-node-name">{nodeDisplayName(nodeId, t)}</span>
      </div>
    </div>
  );
}

// ── 段与圈结构 ──

function segmentInfoKey(segment: ChainNodeSegment): string {
  return `chain.segment.${segment}Info`;
}

function SegmentHead({ segment }: { segment: ChainNodeSegment }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  return (
    <div className="writing-seg-head" data-timeline-segment={segment}>
      <span className="writing-seg-name">{t(`chain.segment.${segment}`)}</span>
      <span className="writing-seg-line" aria-hidden="true" />
      <span className="writing-seg-info">{t(segmentInfoKey(segment))}</span>
    </div>
  );
}

function LapBlock({ lap, children }: { lap: TimelineLap; children: ReactNode }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const lapLabel = t('chain.lap.label', { n: lap.index });
  if (!lap.closed) {
    return (
      <div className="writing-lap" data-timeline-lap={lap.index} data-lap-state="active">
        <div className="writing-lap-head">
          <span className="writing-lap-tag writing-lap-tag--cur">{lapLabel}</span>
          <span className="writing-lap-line" aria-hidden="true" />
        </div>
        {children}
      </div>
    );
  }
  const rd = lap.routeDecision;
  const summary = rd
    ? rd.reason
      ? t('chain.lap.summaryWithReason', { count: lap.entries.length, decision: rd.decision, reason: rd.reason })
      : t('chain.lap.summary', { count: lap.entries.length, decision: rd.decision })
    : t('chain.lap.summary', { count: lap.entries.length, decision: '—' });
  return (
    <div className="writing-lap writing-lap--history" data-timeline-lap={lap.index} data-lap-state="historical">
      <Fold
        defaultOpen={false}
        summary={
          <span className="writing-fold-parts">
            <span className="writing-lap-tag">{lapLabel}</span>
            <span className="writing-lap-history-summary">{summary}</span>
          </span>
        }
      >
        {children}
      </Fold>
    </div>
  );
}

// ── 时间线 feed ──

/** 空时间线稳定引用（timeline 缺席时 ?? 兜底——数组字面量会每次渲染换 identity，
 *  打爆 entries 依赖的 useMemo 系列）。 */
const EMPTY_TIMELINE_ENTRIES: TimelineNodeEntry[] = [];

type FeedProps = {
  timeline: ChainTimelineState | undefined;
  run: ChainRunState | undefined;
  /** 测试注时钟（缺省 = 组件内真实 Date.now，运行态每秒滴答）。 */
  now?: number;
};

export function ChainTimelineFeed({ timeline, run, now: nowProp }: FeedProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  // CR-16b（09-18 CR 批 B）：Feed 不自跑 1s interval（耗时显示在 runmeta 条——Feed 的时长
  // chip 只在事件驱动的重渲间刷新即可，每秒全 feed 重渲是纯浪费；测试注时钟 prop 保留）。
  const now = nowProp ?? Date.now();
  const status = run?.status ?? 'running';

  const entries = timeline?.entries ?? EMPTY_TIMELINE_ENTRIES;
  // 三段恒出块（空 entries = 全目录灰预览——「跑到哪亮到哪」的全貌）。
  const blocks = useMemo<TimelineFeedBlock[]>(() => projectTimelineFeed(entries), [entries]);

  // 终态停表参照（末条 entry 耗时不随墙钟无限生长）。
  const terminal = run !== undefined && (run.status === 'completed' || run.status === 'error' || run.status === 'aborted');
  const endFallback = terminal ? run.updatedAt : now;

  // entry → 全 feed 下标（耗时区间投影用；引用同一数组元素，Map 键 = 对象恒等）。
  const entryIndex = useMemo(() => {
    const map = new Map<TimelineNodeEntry, number>();
    entries.forEach((e, i) => map.set(e, i));
    return map;
  }, [entries]);

  // writer 当前流归属：run.streamNodeId 指写手 + 流在途（或中断/失败保留态）→ 末条写手 entry。
  const lastWriterEntry = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].nodeId === 'draft-writer-agent') return entries[i];
    }
    return undefined;
  }, [entries]);
  const liveProseFor = (entry: TimelineNodeEntry): { text: string; streaming: boolean } | null => {
    if (
      run === undefined
      || entry !== lastWriterEntry
      || run.streamNodeId !== 'draft-writer-agent'
      || !(run.streaming || run.status === 'aborted' || run.status === 'error')
      || run.streamText === ''
    ) return null;
    return { text: run.streamText, streaming: run.streaming };
  };

  const renderEntries = (slice: TimelineNodeEntry[]) =>
    slice.map((entry) => (
      <NodeRow
        key={`${entry.nodeId}@${entry.at}`}
        entry={entry}
        entries={entries}
        entryIndex={entryIndex.get(entry) ?? 0}
        endFallback={endFallback}
        tier={nodeCatalogEntry(entry.nodeId)?.tier ?? 'analysis'}
        liveProse={entry.nodeId === 'draft-writer-agent' ? liveProseFor(entry) : null}
      />
    ));

  return (
    <div className="writing-timeline" data-writing-timeline>
      {blocks.map((block, bi) => (
        <div className="writing-seg" key={`${block.kind}-${bi}`}>
          <SegmentHead segment={block.kind === 'loop' ? 'loop' : block.segment} />
          {block.kind === 'plain'
            ? renderEntries(block.entries)
            : block.laps.map((lap) => (
                <LapBlock key={lap.index} lap={lap}>
                  {renderEntries(lap.entries)}
                </LapBlock>
              ))}
          {block.pendingNodeIds.map((nodeId) => (
            <PendingNodeRow key={`pending-${nodeId}`} nodeId={nodeId} />
          ))}
        </div>
      ))}
      {/* CR-12（09-18 CR 批 B）：空 entries 的 idle 行按 run 状态分文案（running=生成中 /
          paused=已暂停 / 终态=无时间线数据）——原实现恒显「生成中」，paused/终态被误标。 */}
      {entries.length === 0 ? (
        <p className="writing-timeline-idle" data-timeline-idle={status}>
          {status === 'paused'
            ? t('writing.timeline.idlePaused')
            : terminal
              ? t('writing.timeline.idleEmpty')
              : t('writing.timeline.idleRunning')}
        </p>
      ) : null}
    </div>
  );
}

// ── 运行摘要条 ──

type MetaBarProps = {
  run: ChainRunState | undefined;
  timeline: ChainTimelineState | undefined;
  /** 章名（WritingPage 派生：pausedReview.chapterId → novelChapters 查表；null = fallback）。 */
  chapterTitle: string | null;
  modelChip: ModelChipView | null;
  /** 测试注时钟。 */
  now?: number;
  /**
   * CR-4②（09-18 CR 批 B）：观察链 paused 但相位在 run（手动收起审阅后）时的「进审阅」入口。
   * null = 不渲染（非 paused / 已在审阅相位）。手动优先语义的对称出口——收起后页内仍可再入。
   */
  enterReview?: { label: string; onClick: () => void } | null;
};

export function ChainRunMetaBar({ run, timeline, chapterTitle, modelChip, now: nowProp, enterReview }: MetaBarProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const [tickNow, setTickNow] = useState(() => Date.now());
  const status = run?.status ?? 'running';
  const running = status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const now = nowProp ?? tickNow;

  const meta = useMemo(() => projectTimelineFeedMeta(timeline?.entries ?? []), [timeline]);
  const title = chapterTitle ?? t('writing.run.fallbackTitle');

  return (
    <div className="writing-runmeta" data-writing-runmeta data-run-status={status}>
      <span className="writing-runmeta-chapter">{title}</span>
      {meta.activeSegment !== null ? (
        <span className="writing-runmeta-phase">
          {t(`chain.segment.${meta.activeSegment}`)}
          {meta.activeSegment === 'loop' && meta.currentLap !== null ? (
            <em className="writing-runmeta-lap">· {t('chain.lap.label', { n: meta.currentLap })}</em>
          ) : null}
        </span>
      ) : null}
      {/* CR-11（09-18 CR 批 B）：loop 完成后（extract 段起）常驻「自审收敛 N 圈」chip——
          D-e 圈数三处可见之一；原实现 lap 号只在 loop 段活跃时渲染，accept 后圈数消失。 */}
      {meta.completedLaps > 0 && meta.activeSegment !== 'loop' ? (
        <span className="writing-runmeta-laps" data-run-laps={meta.completedLaps}>
          {t('writing.run.lapsDone', { n: meta.completedLaps })}
        </span>
      ) : null}
      <span className={`writing-runmeta-status writing-runmeta-status--${status}`}>{t(`writing.run.status.${status}`)}</span>
      {meta.startedAt !== null ? (
        <span className="writing-runmeta-elapsed">⏱ {formatElapsed(now - meta.startedAt)}</span>
      ) : null}
      {modelChip ? (
        <span className="writing-runmeta-model">
          {modelChip.name}
          {modelChip.fallbackFrom ? (
            <span className="writing-runmeta-model-fb" title={modelChip.reason ?? undefined}>
              {t('writing.run.modelFallback', { from: modelChip.fallbackFrom })}
            </span>
          ) : null}
        </span>
      ) : null}
      {/* CR-4②：手动再入审阅（paused 链在 run 相位时的页内唯一入口）。 */}
      {enterReview ? (
        <button
          type="button"
          className="writing-runmeta-enter-review"
          data-run-enter-review
          onClick={enterReview.onClick}
        >
          {enterReview.label}
        </button>
      ) : null}
    </div>
  );
}
