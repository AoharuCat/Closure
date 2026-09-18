// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子3 W3（design §3）：写作页运行时间线的纯投影层。
//
// timeline store（chainTimeline.ts，W2 产物）持有 append-only entries（到达序即圈序）；
// 本模块把 entries 投影成渲染结构（段块/圈分组/灰预览/摘要元数据），组件与测试共用同一
// 实现（零复制粘贴）。纯函数、无 store 依赖——组件侧接 store，测试侧喂 fixture。
//
// 核心规则（design §3 + consumption-surface.md）：
// - **段结构**：entry 段归属 = nodeCatalog.segment（表外节点继承前游标——ChainRunCard 尾部
//   追加先例的 feed 版）；三段按目录序恒出块（未达段 = 空块 + 全量灰预览全貌）。
// - **圈分组**：route-agent 的 route-decision artifact 帧为圈边界——帧后 entries 属下一圈；
//   历史圈（已闭合）折叠回看，活跃圈（未闭合）展开。环重跑 append-only：同 nodeId 多 entry
//   各归各圈（到达序即圈序，F6 定谳——seq 不作 attempt 锚）。
// - **灰预览**：段内 nodeCatalog 序中尚未出现在「本段当前一轮」的节点（plan/extract 单轮 =
//   全量差集；loop = 活跃圈差集）。
// - **章名/时长/圈数**（runmeta）：时长自时间线首个 entry.at 计时（ChainRunState 无 startedAt）；
//   章名 fallback「写章链」（链→章映射弱承诺，pausedReview.chapterId 仅 leader 路径可判）。
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelConfig } from '@orison/shared-contracts';
import { CHAIN_NODE_ORDER, chainNodeLabel, type ChainNodeArtifactSummary, type ChainRunState } from '../../shared/store/chainStreamBuffer';
import type { TimelineNodeEntry } from '../../shared/store/chainTimeline';
import type { PendingPatchEntry } from '../../shared/store/creativeFieldsSlice';
import { normalizeProjectPathForCompare, sameProjectPath } from '../../shared/store/projectRunBusy';
import { modelDisplayName } from '../../shared/model/modelDisplay';
import { CHAIN_NODE_SEGMENTS, nodeCatalogEntry, type ChainNodeSegment } from './nodeCatalog';

/** 译者形态（useI18n 的 t / 测试 identity mock 同构）。 */
export type Translator = (key: string, vars?: Record<string, string | number>) => string;

// ── 圈与段块（feed 投影） ──

/** 自审环内一圈（route-decision 帧闭圈；未闭合 = 活跃圈）。 */
export type TimelineLap = {
  /** 1-based 圈号。 */
  index: number;
  entries: TimelineNodeEntry[];
  /** 圈边界帧的判决（decision + reason——历史圈折叠行的回看锚）。 */
  routeDecision?: { decision: string; reason: string };
  closed: boolean;
};

/** feed 块：plan/extract 段是平铺块；loop 段是圈列表。 */
export type TimelineFeedBlock =
  | { kind: 'plain'; segment: ChainNodeSegment; entries: TimelineNodeEntry[]; pendingNodeIds: string[] }
  | { kind: 'loop'; laps: TimelineLap[]; pendingNodeIds: string[] };

/** route-agent 的 route-decision 帧判定（圈边界唯一判据——error/line 降级帧不闭圈）。 */
function routeDecisionOf(entry: TimelineNodeEntry): { decision: string; reason: string } | undefined {
  if (entry.nodeId !== 'route-agent') return undefined;
  return entry.summary?.kind === 'route-decision' ? { decision: entry.summary.decision, reason: entry.summary.reason } : undefined;
}

/**
 * entries → 渲染块序列。三段恒出块（CHAIN_NODE_SEGMENTS 目录序：规划环→自审环→提取段）——
 * 未达段以空 entries + 全量灰预览呈现（「跑到哪亮到哪」的全貌，mockup S1 提取段标题 +
 * 灰预览在环内运行时已可见）。未知 nodeId（未来节点/mock）继承前游标段——不丢步。
 */
export function projectTimelineFeed(entries: TimelineNodeEntry[]): TimelineFeedBlock[] {
  const bySegment: Record<ChainNodeSegment, TimelineNodeEntry[]> = { plan: [], loop: [], extract: [] };
  let cursor: ChainNodeSegment = 'plan';
  for (const entry of entries) {
    const segment: ChainNodeSegment = nodeCatalogEntry(entry.nodeId)?.segment ?? cursor;
    cursor = segment;
    bySegment[segment].push(entry);
  }

  const blocks: TimelineFeedBlock[] = [];
  for (const { id } of CHAIN_NODE_SEGMENTS) {
    const segmentEntries = bySegment[id];
    const catalogNodes = CHAIN_NODE_ORDER.filter((nid) => nodeCatalogEntry(nid)?.segment === id);
    if (id === 'loop') {
      const laps: TimelineLap[] = [];
      let current: TimelineLap = { index: 1, entries: [], closed: false };
      for (const segEntry of segmentEntries) {
        current.entries.push(segEntry);
        const rd = routeDecisionOf(segEntry);
        if (rd) {
          current.routeDecision = rd;
          current.closed = true;
          laps.push(current);
          current = { index: laps.length + 1, entries: [], closed: false };
        }
      }
      if (current.entries.length > 0) laps.push(current);
      // 灰预览 = 活跃圈（末圈）差集：末圈闭合（accept 后）时其成员全在 → 预览空。
      const activeSeen = new Set(laps[laps.length - 1]?.entries.map((e) => e.nodeId) ?? []);
      blocks.push({ kind: 'loop', laps, pendingNodeIds: catalogNodes.filter((id2) => !activeSeen.has(id2)) });
    } else {
      const seen = new Set(segmentEntries.map((e) => e.nodeId));
      blocks.push({ kind: 'plain', segment: id, entries: segmentEntries, pendingNodeIds: catalogNodes.filter((nid) => !seen.has(nid)) });
    }
  }
  return blocks;
}

// ── 摘要元数据（runmeta 派生） ──

export type TimelineFeedMeta = {
  /** 时间线首个 entry.at（时长计时零点；无条目 = null）。 */
  startedAt: number | null;
  /** 末条 entry 所属段（feed 的「现在在哪」）。 */
  activeSegment: ChainNodeSegment | null;
  /** 当前圈号（活跃圈；全闭合时 = 末圈号——显示连续性）。 */
  currentLap: number | null;
  /** 已闭合圈数（route-decision 帧计数）。 */
  completedLaps: number;
};

export function projectTimelineFeedMeta(entries: TimelineNodeEntry[]): TimelineFeedMeta {
  if (entries.length === 0) return { startedAt: null, activeSegment: null, currentLap: null, completedLaps: 0 };
  let activeSegment: ChainNodeSegment | null = null;
  let currentLap: number | null = null;
  let completedLaps = 0;
  for (const block of projectTimelineFeed(entries)) {
    if (block.kind === 'loop') {
      completedLaps += block.laps.filter((l) => l.closed).length;
      const lastLap = block.laps[block.laps.length - 1];
      if (lastLap) {
        currentLap = lastLap.index;
        activeSegment = 'loop';
      }
      continue;
    }
    // 三段恒出块（未达段空 entries）——只有实跑过的段才推进「现在在哪」。
    if (block.entries.length > 0) activeSegment = block.segment;
  }
  return { startedAt: entries[0]?.at ?? null, activeSegment, currentLap, completedLaps };
}

// ── 观察链解析（W3 占位：显式选择 → 项目锚；W6 多会话条切换写入显式选择） ──

/**
 * 写作页观察链 session 解析。优先级：显式选择（selectedChainSessionId，W6 chip 切换）→
 * 项目锚（chainRunAnchorByProject——每链事件都登记，单项目当前链）。选择失效（会话删除）
 * 或无链 → null（空态卡）。纯函数——键存在性判定，不读链状态值。
 */
export function resolveObservedChainSession(input: {
  selectedChainSessionId: string | null;
  chainRunBySession: Record<string, unknown> | undefined;
  chainRunAnchorByProject: Record<string, string> | undefined;
  projectPath: string | undefined;
}): string | null {
  const runs = input.chainRunBySession;
  const selected = input.selectedChainSessionId;
  if (selected && runs !== undefined && selected in runs) return selected;
  if (input.projectPath === undefined || input.chainRunAnchorByProject === undefined) return null;
  const anchor = input.chainRunAnchorByProject[normalizeProjectPathForCompare(input.projectPath)];
  return anchor !== undefined && runs !== undefined && anchor in runs ? anchor : null;
}

// ── 产出卡/节点行的呈现投影 ──

/**
 * severity 已知集单源（CR-16b：severityLabel 判定与 i18n 守卫测试共用——新增词表值只改这里）。
 */
export const KNOWN_SEVERITY_VALUES: readonly string[] = ['hard', 'soft', 'block', 'warn', 'info', 'missing', 'under-developed'];

/** findings severity 软硬归一（源值透传域：block|warn|info / hard|soft / missing|under-developed）。 */
export type FindingTone = 'hard' | 'soft' | 'neutral';

export function findingToneOf(severity: string): FindingTone {
  if (severity === 'hard' || severity === 'block' || severity === 'missing' || severity === 'under-developed') return 'hard';
  if (severity === 'soft' || severity === 'warn') return 'soft';
  return 'neutral';
}

/** severity 显示名（策展词表 i18n；未知原值回显——未来新增不炸 UI）。词表单源 KNOWN_SEVERITY_VALUES。 */
export function severityLabel(severity: string, t: Translator): string {
  return KNOWN_SEVERITY_VALUES.includes(severity) ? t(`chain.sev.${severity}`) : severity;
}

export type ArtifactChipTone = 'ok' | 'warn' | 'err' | 'loop';

/** 节点行右侧 verdict chip（findings 计数 / route 判决；brief-card·items·line 无 chip）。 */
export function artifactChipView(
  summary: ChainNodeArtifactSummary | undefined,
  t: Translator,
): { text: string; tone: ArtifactChipTone } | null {
  if (!summary) return null;
  if (summary.kind === 'route-decision') {
    const tone: ArtifactChipTone = routeDecisionTone(summary.decision);
    return { text: summary.decision, tone };
  }
  if (summary.kind === 'findings') {
    let hard = 0;
    let soft = 0;
    for (const f of summary.findings) {
      const tone = findingToneOf(f.severity);
      if (tone === 'hard') hard += 1;
      else if (tone === 'soft') soft += 1;
    }
    if (summary.findings.length === 0) return { text: summary.verdict || t('chain.chip.pass'), tone: 'ok' };
    if (hard > 0 && soft > 0) return { text: t('chain.chip.findings', { hard, soft }), tone: 'err' };
    if (hard > 0) return { text: t('chain.chip.findingsHard', { hard }), tone: 'err' };
    return { text: t('chain.chip.findingsSoft', { soft }), tone: 'warn' };
  }
  return null;
}

/** route 判决词 → chip 色调（accept 族绿 / escalate 族警示 / 其余〔auto_revise 等〕蓝）。 */
export function routeDecisionTone(decision: string): ArtifactChipTone {
  const d = decision.toLowerCase();
  if (d.startsWith('accept')) return 'ok';
  if (d.includes('escalate')) return 'warn';
  return 'loop';
}

/** 节点显示名（nodeCatalog i18nKey 优先；表外节点机械去后缀——ChainRunCard 先例）。 */
export function nodeDisplayName(nodeId: string, t: Translator): string {
  const catalog = nodeCatalogEntry(nodeId);
  return catalog ? t(catalog.i18nKey) : chainNodeLabel(nodeId);
}

// ── 思考流 phase 分层（writer 三层；analysis 无 phase 归一层） ──

export type ReasoningPhaseGroup = {
  /** delta phase 原值（research/writing/declaration；缺省 null = 通用层）。 */
  phase: string | null;
  texts: string[];
  chars: number;
};

/**
 * 连续同 phase 段聚合（按 phase 字段分层——勿按工具轮次推断，design §3 writer 档红线）。
 */
export function groupReasoningByPhase(reasoning: Array<{ messageId: string; phase?: string; text: string }>): ReasoningPhaseGroup[] {
  const groups: ReasoningPhaseGroup[] = [];
  for (const seg of reasoning) {
    const last = groups[groups.length - 1];
    if (last && (last.phase ?? null) === (seg.phase ?? null)) {
      last.texts.push(seg.text);
      last.chars += seg.text.length;
    } else {
      groups.push({ phase: seg.phase ?? null, texts: [seg.text], chars: seg.text.length });
    }
  }
  return groups;
}

// ── 数值格式化 ──

/**
 * 字数口径：非空白字符计数（mirror agent recountDraftWordCount——CJK 习惯口径）。
 */
export function countChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/** 思考字数紧凑格式（≥1000 → "1.1K"）。 */
export function formatCharCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** runmeta 时长（m:ss / h:mm:ss 时钟形态）。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 节点行耗时（"45s" / "4m10s" / "1h02m"）。 */
export function formatNodeDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return s > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
}

/**
 * entry 耗时区间终点：下一 entry.at（到达序近似——下一节点首事件即本节点收口后）；末条
 * entry 用调用方给的活动/终态参照（运行中 = now 活计时；终态 = run.updatedAt 停表）。
 */
export function entryDurationMs(
  entries: TimelineNodeEntry[],
  index: number,
  endFallback: number,
): number {
  const entry = entries[index];
  if (!entry) return 0;
  return Math.max(0, (entries[index + 1]?.at ?? endFallback) - entry.at);
}

// ── 多会话条 chip 投影（W6，design §6.1） ──

export type ChainChipStatus = 'running' | 'paused' | 'completed' | 'error' | 'aborted';

/** 单链 chip 视图（label 由组件层 i18n 格式化——投影只出机械数据）。 */
export type ChainChipView = {
  sessionId: string;
  status: ChainChipStatus;
  /** 待审 badge 判据 = `status==='paused'`（非 pausedReviewBySession 存在——escalate/stub 链无 pausedReview，F5 连带修正）。 */
  awaitingReview: boolean;
  /** pause 后章号（pausedReview.chapterId → novelChapters 命中 → sortOrder+1，mirror 章行 ordinal 口径）；null = fallback「写章链」。 */
  chapterNumber: number | null;
  updatedAt: number;
};

/**
 * `chainRunBySession` 全键 × 项目归属过滤 → chip 列表（updatedAt 降序——最近链靠前）。
 *
 * 项目归属 = 模块级 `sessionProjectPaths`（getSessionProduct/getSessionProject 映射——每链事件
 * 恒带 projectPath，handleAgentStreamEvent 逐条登记）；**chainRunAnchorByProject 每项目只存最新
 * sid 不能当全集**（design §1.2）。映射缺席（无事件面会话）保守排除——归属未知不猜。
 */
export function projectChainChips(input: {
  chainRunBySession: Record<string, { status: string; updatedAt: number }>;
  /** 项目归属查询（agentEvents.getSessionProject 直传）。 */
  sessionProjects: (sessionId: string) => string | undefined;
  projectPath: string | undefined;
  pausedReviewBySession: Record<string, { chapterId?: string } | undefined>;
  novelChapters: Array<{ id: string; sortOrder: number }>;
}): ChainChipView[] {
  const { projectPath, sessionProjects } = input;
  if (projectPath === undefined) return [];
  const chips: ChainChipView[] = [];
  for (const [sessionId, run] of Object.entries(input.chainRunBySession)) {
    if (!run) continue;
    if (!sameProjectPath(sessionProjects(sessionId), projectPath)) continue;
    const pausedChapterId = input.pausedReviewBySession[sessionId]?.chapterId;
    const chapter = pausedChapterId !== undefined
      ? input.novelChapters.find((ch) => ch.id === pausedChapterId)
      : undefined;
    const status: ChainChipStatus = run.status === 'running' || run.status === 'paused' || run.status === 'completed' || run.status === 'error' || run.status === 'aborted'
      ? run.status
      : 'running'; // 未知态保守归 running（哨兵映射已收敛五值，此为防御）
    chips.push({
      sessionId,
      status,
      awaitingReview: status === 'paused',
      chapterNumber: chapter && Number.isFinite(chapter.sortOrder) ? chapter.sortOrder + 1 : null,
      updatedAt: run.updatedAt,
    });
  }
  chips.sort((a, b) => b.updatedAt - a.updatedAt);
  return chips;
}

// ── chapter_candidate 待落盘审阅 envelope 扫描（CR-2，09-18 CR 批 B） ──

/** 项目内一条 chapter_candidate 待落盘审阅 envelope 的视图。 */
export type ChapterCandidateEnvelope = {
  /** 挂载键（setPendingPatch 的会话 id——PatchReviewPanel props sessionId 同源）。 */
  sessionId: string;
  /** envelope data.chapterId（缺席/形态坏 → null——不造数）。 */
  chapterId: string | null;
  /** envelope 与观察链关联（挂载键 = 观察链 sid，或 patch.runId = 观察链 sid——leader 路径单源）。 */
  chainMatched: boolean;
};

/**
 * `pendingPatchBySession` 全键扫描 chapter_candidate（链产物终稿 envelope——D-g 切分判据），
 * **项目归属过滤**（mirror projectChainChips 先例：模块级 sessionProjectPaths 归属映射注入，
 * 归属未知保守排除）+ **观察链关联优先**（CR-2：他链/他项目 envelope 不得串进本链产物区）。
 *
 * 排序：chainMatched 在前（同组保持插入序）——消费方取首个即「本链关联，否则项目内唯一」。
 */
export function projectChapterCandidateEnvelopes(input: {
  pendingPatchBySession: Record<string, PendingPatchEntry | undefined>;
  /** 项目归属查询（agentEvents.getSessionProject 直传——chainSessionBar 同款注入）。 */
  sessionProjects: (sessionId: string) => string | undefined;
  projectPath: string | undefined;
  observedSessionId: string | null;
}): ChapterCandidateEnvelope[] {
  const { projectPath, sessionProjects, observedSessionId } = input;
  const out: ChapterCandidateEnvelope[] = [];
  for (const [sessionId, entry] of Object.entries(input.pendingPatchBySession)) {
    if (!entry) continue;
    // CR-2：他项目 / 归属未知 envelope 排除——跨项目扫描会让别章 chapterId 串进本链产物区。
    if (!sameProjectPath(sessionProjects(sessionId), projectPath)) continue;
    const patch = entry.patch?.patches.find((p) => (p.field as string) === 'chapter_candidate');
    if (!patch) continue;
    const dataChapterId = (patch.data as { chapterId?: unknown } | undefined)?.chapterId;
    out.push({
      sessionId,
      chapterId: typeof dataChapterId === 'string' && dataChapterId.length > 0 ? dataChapterId : null,
      chainMatched: sessionId === observedSessionId || entry.patch?.runId === observedSessionId,
    });
  }
  out.sort((a, b) => Number(b.chainMatched) - Number(a.chainMatched));
  return out;
}

// ── 终态产物区投影（W6，design §6.2） ──

/** 数值计数行（机械汇总——世界事件五轴合计 / 伏笔登记动作数）。 */
export type OutcomeCountRow = { metric: 'worldEvents' | 'promises'; count: number };

/**
 * 预渲染行透传（line kind 两 locale 同显——D-f 拍板；弧节拍/章摘要/反哺/反馈台账的 agent 侧
 * 产出是中文预渲染串，不解析不重排）。promiseNote = promise 涌现无动作时的 line 降级帧。
 */
export type OutcomeNoteRow = {
  metric: 'chapterSummary' | 'arcBeats' | 'storySync' | 'feedbackLedger' | 'promiseNote';
  line: string;
};

export type OutcomeRows = {
  /** 正文行（chapterId 可解析到章 + sections[0].contentFile 时；null = 映射缺省不造数）。 */
  prose: { chapterId: string; path: string } | null;
  counts: OutcomeCountRow[];
  notes: OutcomeNoteRow[];
};

/** 世界事件五轴提取节点 id（items.total 求和 = 世界状态变化条数）。 */
const OUTCOME_WORLD_EXTRACTOR_IDS = [
  'world-extractor-physical',
  'world-extractor-cognitive',
  'world-extractor-emotional',
  'world-extractor-relational',
  'world-extractor-factional',
] as const;

/** 该 nodeId 最后一个 entry（append-only 到达序——末者即当前 attempt）。 */
function lastEntryOfNode(entries: TimelineNodeEntry[], nodeId: string): TimelineNodeEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].nodeId === nodeId) return entries[i];
  }
  return undefined;
}

function noteRowOf(
  entries: TimelineNodeEntry[],
  nodeId: string,
  metric: OutcomeNoteRow['metric'],
): OutcomeNoteRow | null {
  const entry = lastEntryOfNode(entries, nodeId);
  if (entry?.summary?.kind !== 'line') return null; // 帧缺失/降级不造数——行缺省
  return { metric, line: entry.summary.line };
}

/**
 * completed 终态的落盘清单投影：**按实际获得字段投影，缺不造数**（design §6.2）——
 * E 段 artifact 帧是该数据面（章节路径 = chapter_accept envelope / pausedReview 的 chapterId
 * → novelChapters 查表 → sections[0].contentFile，元素级形状守卫）。帧缺席（事件丢失 / 降级 /
 * 环重跑前段）→ 对应行缺省。
 */
export function projectOutcomeRows(input: {
  entries: TimelineNodeEntry[];
  /** chapter_accept envelope 的 data.chapterId（pendingPatch 链产物待落盘审阅）。 */
  pendingChapterCandidateChapterId?: string | null;
  /** pausedReview.chapterId（leader 路径 pause 记录；accept completed 后被清——次选源）。 */
  pausedChapterId?: string;
  novelChapters: Array<{ id: string; sections?: Array<{ contentFile?: unknown }> | unknown }>;
}): OutcomeRows {
  const { entries } = input;
  // 正文行：chapterId（envelope 优先 → pausedReview）→ 章查表 → sections[0].contentFile
  //（sections 元素级守卫——注水 project.yaml 直达派生层，spec ui/layout-and-pages 数组形状纪律）。
  const chapterId = input.pendingChapterCandidateChapterId ?? input.pausedChapterId ?? null;
  let prose: OutcomeRows['prose'] = null;
  if (chapterId !== null) {
    const chapter = input.novelChapters.find((ch) => ch.id === chapterId);
    const sections = chapter?.sections;
    const first = Array.isArray(sections) ? sections[0] : undefined;
    const contentFile = first != null && typeof first === 'object' && typeof (first as { contentFile?: unknown }).contentFile === 'string'
      ? (first as { contentFile: string }).contentFile
      : undefined;
    if (contentFile !== undefined && contentFile.length > 0) prose = { chapterId, path: contentFile };
  }

  // 世界事件：五轴提取帧（items kind）total 求和；零帧 → 行缺省。
  let worldEvents = 0;
  let worldSeen = false;
  for (const nodeId of OUTCOME_WORLD_EXTRACTOR_IDS) {
    const summary = lastEntryOfNode(entries, nodeId)?.summary;
    if (summary?.kind === 'items') {
      worldSeen = true;
      worldEvents += summary.total;
    }
  }

  // 伏笔：items 帧计数；line 降级帧（gap 检出无动作）→ note 行透传。
  const promiseEntry = lastEntryOfNode(entries, 'promise-emergence-node');
  const promiseItems = promiseEntry?.summary?.kind === 'items' ? promiseEntry.summary : null;
  const promiseNote = promiseEntry?.summary?.kind === 'line'
    ? ({ metric: 'promiseNote', line: promiseEntry.summary.line } as OutcomeNoteRow)
    : null;

  const notes: OutcomeNoteRow[] = [];
  const summaryNote = noteRowOf(entries, 'chapter-summary-node', 'chapterSummary');
  if (summaryNote) notes.push(summaryNote);
  const arcNote = noteRowOf(entries, 'arc-emergence-node', 'arcBeats');
  if (arcNote) notes.push(arcNote);
  if (promiseNote) notes.push(promiseNote);
  const syncNote = noteRowOf(entries, 'story-sync-agent', 'storySync');
  if (syncNote) notes.push(syncNote);
  const feedbackNote = noteRowOf(entries, 'feedback-ledger-node', 'feedbackLedger');
  if (feedbackNote) notes.push(feedbackNote);

  const counts: OutcomeCountRow[] = [];
  if (worldSeen) counts.push({ metric: 'worldEvents', count: worldEvents });
  if (promiseItems) counts.push({ metric: 'promises', count: promiseItems.total });

  return { prose, counts, notes };
}

/**
 * error 终态的失败明细投影：error/blocked 终态 entry 的 line 帧（agent 侧通用终态行
 * 「节点失败/受阻：message 截断」——M4）按到达序透传。无帧 → 空数组（明细可查主进程日志）。
 */
export function projectOutcomeErrorLines(entries: TimelineNodeEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.status !== 'error' && entry.status !== 'blocked') continue;
    if (entry.summary?.kind === 'line') lines.push(entry.summary.line);
  }
  return lines;
}

// ── 模型 chip（runmeta） ──


export type ModelChipView = {
  name: string;
  /** 回退标注（modelSwitch 在时：「回退自 X」）。 */
  fallbackFrom: string | null;
  /** 回退原因（title 提示）。 */
  reason: string | null;
};

/**
 * 模型 chip 投影：modelSwitch（链内回退事件）优先 → 主指派 writer-draft 槽位。
 * 槽位未配置（ABSENT）→ null 不渲染（provider auto-pick 对 UI 不可知——ABSENT ≠ 0 纪律，
 * 不造数）。chainRunState 无模型字段——本投影是 runmeta 的唯一模型数据面。
 */
export function modelChipView(
  run: ChainRunState | undefined,
  modelConfig: ModelConfig | undefined,
): ModelChipView | null {
  if (run?.modelSwitch) {
    return {
      name: modelDisplayName(modelConfig, run.modelSwitch.to),
      fallbackFrom: modelDisplayName(modelConfig, run.modelSwitch.from),
      reason: run.modelSwitch.reason,
    };
  }
  const slot = modelConfig?.taskModels?.['writer-draft'];
  if (slot) return { name: modelDisplayName(modelConfig, slot), fallbackFrom: null, reason: null };
  return null;
}
