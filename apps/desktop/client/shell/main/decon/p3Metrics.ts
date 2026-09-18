import type {
  DeconArc,
  DeconArcsPayload,
  DeconChapterLabels,
  DeconDistribution,
  DeconFacts,
  DeconJob,
  DeconProgressEvent,
  DeconStatsPayload,
  Material,
} from '@orison/shared-contracts';
import {
  DECON_EMOTIONAL_BEATS,
  DECON_HOOK_TYPES,
  DECON_INFO_GAP_TYPES,
  DECON_PLOT_PHASES,
  DECON_TRANSITION_TYPES,
  deconArcsPayloadSchema,
  deconChapterLabelsSchema,
  deconStatsPayloadSchema,
} from '@orison/shared-contracts';
import { getDb } from '../db/index';
import {
  getDeconPassState,
  getDeconProduct,
  listDeconChapterFacts,
  listDeconProducts,
  upsertDeconProduct,
} from '../db/closure-decon';
import { splitParagraphBlocks, stripChapterMarkerLines, type MaterialParagraphBlock } from '../ipc/toolHandlers/materialIngest';
import {
  DECON_STALE_NOTE,
  checkDeconRunBoundary,
  failDeconUnit,
  loadExtractableMaterial,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  sha256DeconContent,
  writeDeconPassState,
  type DeconBoundaryStop,
} from './deconRun';
import { decideDeconPassReentry, extractMaterialId, transitionDeconJob } from './deconJob';
import { hashDeconProductOutput } from './p3Label';

// ── E10.3b（task 09-05）W2：P3b 纯代码算数（child B design §2——打标的手 / 算数的账之账）──
//
// 两 unit（product 表 p3b 两行）：
// - **unit='arcs' 弧切分定稿**（弧 = P4/P5 的通读单元）：卷界优先（纯代码扫章 title 的
//   「卷/篇/部」分界词）→ 无卷界退化 P3a arcBoundary 候选聚合（置信阈值 + 相邻合并）→
//   守卫（弧字数目标带 30K-100K——过小并弧 / 过大在候选点拆弧）。
// - **unit='stats' 统计族**（全部可纯代码复算——AC2 同输入两跑同输出）：章字数分布 /
//   爽点段计数+字数分布+间隔 / 钩子 by 11 型 / 转折 by 9 型 / 情绪拍分布 / **infoGap 计数
//   by 6 型（消费 P1b——F-08 不重打）** / 伏笔埋点密度 / 设定段字数分布（维 5 证据 F-09）/
//   铺垫-高潮跨度（钩子 → 其后首个 kernel 事件章距）/ **style_stats**（句长分布 / 对话行
//   占比 / 段落长度分布——纯代码 stylometry，ADR-3 四块之一最小落地，风格维原料）。
//
// **零 LLM**（范式判据 parent design §9 P3 行——打标 LLM / 算数纯代码）：无 LLM 内核依赖、
// 无预算门、无 cost 记账。断点语义同族：done+hash 一致 skip（重算免费但保持幂等面统一——
// 读侧 hash 同基 hashDeconProductOutput）。
//
// expected_downstream_consumers:
// - W3b p4Craft（弧级问题单输入=弧 synopsis 序列+弧计量统计）、p4Style（style_stats 原料）。
// - W4 p5Output（book_reading 骨架/节奏公式输入=弧聚合+统计；scene_annotation 候选=
//   爽点/高潮密度峰）。
// - W6 拆书页（计量面板呈现——stats payload 直读）。

// ── 常量（推测值起步——dogfood 首本标定回调，B design §11 风险②）──

/** 弧字数守卫带下限（R2 计量化：211 万字 ≈ 35-40 段 → ~5-6 万字/段；30K 为并弧阈值推测值）。 */
export const DECON_ARC_MIN_CHARS = 30_000;

/** 弧字数守卫带上限（过大拆弧阈值——推测值，与 DECON_ARC_CHARS=60k 预估中值成带）。 */
export const DECON_ARC_MAX_CHARS = 100_000;

/** arcBoundary 候选置信阈值（切点只认强候选——推测值）。 */
export const DECON_ARC_BOUNDARY_CONFIDENCE = 0.6;

/** 拆弧候选置信阈值（拆点接受弱候选——推测值，低于切点阈值）。 */
export const DECON_ARC_SPLIT_CONFIDENCE = 0.3;

/** 相邻候选合并距离（章距 ≤1 视为同一弧界——留先者）。 */
export const DECON_ARC_ADJACENT_MERGE_CHAPTERS = 1;

/**
 * 卷界章题探测（材料 schema 无显式卷字段——title 正则；「第X卷/X卷/卷X/上下篇」三族词序 +
 * 篇/部同族）。启发式推测值：误命中（如章题恰以「卷宗」起头）由守卫带兜底，dogfood 标定。
 */
const VOL_NUM = '[0-9一二三四五六七八九十百千万零两]+';
export const DECON_VOLUME_TITLE_RE = new RegExp(`^(?:第?${VOL_NUM}[卷篇部]|[卷篇部]${VOL_NUM}|[上下][卷篇部])`);

/** 对话行探测（style_stats 启发式——含中文引号起的行；推测值 dogfood 标定）。 */
export const DECON_DIALOGUE_MARK_RE = /[「『“]/;

// ── 章字数（干净文本口径——章区间与段落块交集，标记行/空白不计数）──

/**
 * 逐章干净字数（两指针——块与章区间相交长度合计；基面与 buildChapterSegments 同一交集
 * 判定，章字数/分段口径一致）。纯函数。
 */
export function chapterCharCounts(
  blocks: readonly MaterialParagraphBlock[],
  chapters: readonly { charStart: number; charEnd: number }[],
): number[] {
  const counts = new Array<number>(chapters.length).fill(0);
  let base = 0;
  for (let ci = 0; ci < chapters.length; ci++) {
    const { charStart, charEnd } = chapters[ci]!;
    while (base < blocks.length && blocks[base]!.end <= charStart) base += 1;
    let sum = 0;
    for (let j = base; j < blocks.length && blocks[j]!.start < charEnd; j++) {
      const s = Math.max(blocks[j]!.start, charStart);
      const e = Math.min(blocks[j]!.end, charEnd);
      if (e > s) sum += e - s;
    }
    counts[ci] = sum;
  }
  return counts;
}

// ── 弧切分（纯函数——卷界探测 / 候选聚合 / 守卫带）──

/** 弧切分的章最小面（title 参与 title 探测；charStart/charEnd 参与字数）。 */
export interface DeconArcChapterInput {
  index: number;
  title: string | null;
}

/** 卷界切点探测（index>0 的卷题章——首章是书起点非切点；弧 0 卷名经 arcTitleAt 另取）。 */
export function detectVolumeBoundaries(
  chapters: readonly DeconArcChapterInput[],
): Array<{ chapterIndex: number; title: string }> {
  const out: Array<{ chapterIndex: number; title: string }> = [];
  for (const ch of chapters) {
    if (ch.index === 0 || ch.title === null) continue;
    const title = ch.title.trim();
    if (DECON_VOLUME_TITLE_RE.test(title)) out.push({ chapterIndex: ch.index, title });
  }
  return out;
}

interface DeconArcWorkSeg {
  /** 起位置（含——chapters 数组序）。 */
  from: number;
  /** 止位置（不含）。 */
  to: number;
  origin: 'volume' | 'boundary' | 'single';
}

/**
 * 拆弧切点选择：段内（开区间）候选点（置信 ≥ SPLIT 阈值）中选累计字数最接近段半量者；
 * 无候选退而取最接近半量的普通章（确定性 tie-break：位置序取先者）。
 */
function pickArcSplitPosition(
  seg: DeconArcWorkSeg,
  chapterChars: readonly number[],
  candidates: readonly { pos: number; confidence: number }[],
): number {
  const rangeChars = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += chapterChars[i] ?? 0;
    return sum;
  };
  const total = rangeChars(seg.from, seg.to);
  const target = total / 2;
  const pool = candidates
    .filter((c) => c.pos > seg.from && c.pos < seg.to && c.confidence >= DECON_ARC_SPLIT_CONFIDENCE)
    .map((c) => c.pos);
  const positions = pool.length > 0 ? pool : Array.from({ length: seg.to - seg.from - 1 }, (_, k) => seg.from + 1 + k);
  let best = seg.from + 1;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const p of positions) {
    const diff = Math.abs(rangeChars(seg.from, p) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best;
}

/**
 * 弧切分定稿（纯函数——B design §2「弧切分定稿」全算法）：
 * ①卷界优先（title 探测切点）→ ②无卷界退化候选聚合（置信 ≥ 阈值 + 相邻合并留先者）→
 * ③守卫过小并弧（< MIN 并邻，并前优先、弧 0 并后；全书一段不并）→ ④守卫过大拆弧
 * （> MAX 在候选点拆，无候选退半量章）。审计留痕（volumeBoundaries/候选数/并拆计数）——
 * 守卫参数是推测值，dogfood 标定面。
 */
export function segmentDeconArcs(
  chapters: readonly DeconArcChapterInput[],
  chapterChars: readonly number[],
  labels: ReadonlyMap<number, DeconChapterLabels>,
): DeconArcsPayload {
  const n = chapters.length;
  const posByIndex = new Map<number, number>();
  chapters.forEach((c, p) => posByIndex.set(c.index, p));

  const volumeBoundaries = detectVolumeBoundaries(chapters);

  // 全量候选（阈值前——审计 candidatesTotal + 拆点池共用）。
  const allCandidates: Array<{ pos: number; confidence: number }> = [];
  for (const [chapterIndex, l] of labels) {
    const ab = l.arcBoundary;
    if (ab === null || !ab.isCandidate) continue;
    const pos = posByIndex.get(chapterIndex);
    if (pos === undefined || pos === 0) continue; // 章 0 是书起点非切点
    allCandidates.push({ pos, confidence: ab.confidence });
  }
  allCandidates.sort((a, b) => a.pos - b.pos);

  const rangeChars = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += chapterChars[i] ?? 0;
    return sum;
  };

  // ①② 切点：卷界优先 → 候选聚合。
  let cutPositions: number[] = [];
  let source: DeconArcsPayload['audit']['source'] = 'single';
  if (volumeBoundaries.length > 0) {
    cutPositions = volumeBoundaries
      .map((b) => posByIndex.get(b.chapterIndex))
      .filter((p): p is number => p !== undefined)
      .sort((a, b) => a - b);
    source = 'volume';
  } else {
    const strong = allCandidates.filter((c) => c.confidence >= DECON_ARC_BOUNDARY_CONFIDENCE);
    const mergedCuts: number[] = [];
    for (const c of strong) {
      const last = mergedCuts[mergedCuts.length - 1];
      if (last !== undefined && c.pos - last <= DECON_ARC_ADJACENT_MERGE_CHAPTERS) continue; // 相邻合并——留先者
      mergedCuts.push(c.pos);
    }
    cutPositions = mergedCuts;
    if (cutPositions.length > 0) source = 'boundary';
  }

  // 初始段。
  const segs: DeconArcWorkSeg[] = [];
  {
    let start = 0;
    for (const p of cutPositions) {
      if (p <= start || p >= n) continue;
      segs.push({ from: start, to: p, origin: source });
      start = p;
    }
    segs.push({ from: start, to: n, origin: source });
  }

  // ③ 守卫过小并弧（并前优先，弧 0 并后；全书一段不并）。
  let arcsMerged = 0;
  for (let i = 0; i < segs.length; ) {
    if (segs.length > 1 && rangeChars(segs[i]!.from, segs[i]!.to) < DECON_ARC_MIN_CHARS) {
      if (i > 0) {
        segs[i - 1]!.to = segs[i]!.to;
        segs.splice(i, 1);
        i -= 1; // 并入后重检（链式小段）
      } else {
        segs[1]!.from = 0;
        segs.splice(0, 1);
      }
      arcsMerged += 1;
    } else {
      i += 1;
    }
  }

  // ④ 守卫过大拆弧（> MAX 在候选点拆；单章段不拆——无可再分位置）。
  let arcsSplit = 0;
  for (let i = 0; i < segs.length; i++) {
    while (rangeChars(segs[i]!.from, segs[i]!.to) > DECON_ARC_MAX_CHARS && segs[i]!.to - segs[i]!.from > 1) {
      const cut = pickArcSplitPosition(segs[i]!, chapterChars, allCandidates);
      const head: DeconArcWorkSeg = { from: segs[i]!.from, to: cut, origin: segs[i]!.origin };
      segs.splice(i, 0, head);
      segs[i + 1]!.from = cut;
      arcsSplit += 1;
    }
  }

  const arcTitleAt = (pos: number): string | null => {
    const t = chapters[pos]?.title;
    if (t === null || t === undefined) return null;
    const trimmed = t.trim();
    return DECON_VOLUME_TITLE_RE.test(trimmed) ? trimmed : null;
  };

  const arcs: DeconArc[] = segs.map((s, idx) => ({
    index: idx,
    title: arcTitleAt(s.from),
    fromChapter: chapters[s.from]!.index,
    toChapter: chapters[s.to - 1]!.index,
    chapterCount: s.to - s.from,
    charCount: rangeChars(s.from, s.to),
    origin: s.origin,
  }));

  return {
    arcs,
    audit: {
      source,
      volumeBoundaries,
      candidatesTotal: allCandidates.length,
      candidatesUsed: cutPositions.length,
      arcsMerged,
      arcsSplit,
    },
  };
}

// ── 统计族（纯函数——AC2 可复算）──

/** 数值分布摘要（总体 σ；count=0 全 0——空集约定）。 */
export function deconDistribution(values: readonly number[]): DeconDistribution {
  const n = values.length;
  if (n === 0) return { count: 0, min: 0, avg: 0, max: 0, sigma: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const avg = sum / n;
  let variance = 0;
  for (const v of values) variance += (v - avg) * (v - avg);
  return { count: n, min, avg, max, sigma: Math.sqrt(variance / n) };
}

/** 全键列齐零计记录（by 型明细分键面——消费者免补键判断）。 */
function zeroRecord(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = 0;
  return out;
}

/** 统计族计算输入（chapters 序 = 登记序；chapterChars 与 chapters 平行）。 */
export interface DeconStatsComputeInput {
  chapters: readonly { index: number }[];
  chapterChars: readonly number[];
  labelsByChapter: ReadonlyMap<number, DeconChapterLabels>;
  factsByChapter: ReadonlyMap<number, DeconFacts>;
  arcs: readonly DeconArc[];
  /** 派生 .md 全文（style_stats 基面——内部剥章标记行）。 */
  derivedText: string;
}

/**
 * 统计族计算（纯函数——design §2 统计族全项）。by 型明细住书级（全键列齐）；弧级 = 聚合
 * 计数面 + 章字数分布 + 相位分布。infoGap/伏笔/kernel 消费 P1b facts（F-08）；铺垫-高潮
 * 跨度 = 各钩子章 → 其后首个 kernel 事件章（同章兑现 = 0；无后续 kernel 的钩子不计）。
 */
export function computeDeconStats(input: DeconStatsComputeInput): DeconStatsPayload {
  const { chapters, chapterChars, labelsByChapter, factsByChapter, arcs, derivedText } = input;

  const hooksByType = zeroRecord([...DECON_HOOK_TYPES, 'other']);
  const transitionsByType = zeroRecord([...DECON_TRANSITION_TYPES, 'other']);
  const emotionalBeatsByType = zeroRecord(DECON_EMOTIONAL_BEATS);
  const infoGapByType = zeroRecord(DECON_INFO_GAP_TYPES);

  let highlightCount = 0;
  const highlightCharLens: number[] = [];
  const highlightOrder: Array<{ chapterIndex: number; charStart: number }> = [];
  const expositionCharLens: number[] = [];
  let foreshadowCount = 0;
  const kernelChapters: number[] = [];
  const hookChapters: number[] = [];

  for (let p = 0; p < chapters.length; p++) {
    const ch = chapters[p]!;
    const labels = labelsByChapter.get(ch.index);
    if (labels !== undefined) {
      for (const h of labels.hooks) {
        hooksByType[h.type] = (hooksByType[h.type] ?? 0) + 1;
        hookChapters.push(ch.index);
      }
      for (const t of labels.transitions) transitionsByType[t.type] = (transitionsByType[t.type] ?? 0) + 1;
      for (const b of labels.emotionalBeats) emotionalBeatsByType[b.beat] = (emotionalBeatsByType[b.beat] ?? 0) + 1;
      highlightCount += labels.highlightSpans.length;
      for (const s of labels.highlightSpans) {
        highlightCharLens.push(s.charEnd - s.charStart);
        highlightOrder.push({ chapterIndex: ch.index, charStart: s.charStart });
      }
      for (const s of labels.expositionSpans) expositionCharLens.push(s.charEnd - s.charStart);
    }
    const facts = factsByChapter.get(ch.index);
    if (facts !== undefined) {
      for (const g of facts.infoGap) infoGapByType[g.type] = (infoGapByType[g.type] ?? 0) + 1;
      foreshadowCount += facts.foreshadowPlanted.length;
      if (facts.events.some((e) => e.kernel === true)) kernelChapters.push(ch.index);
    }
  }

  // 爽点间隔（阅读序——章内按 charStart 稳定排序；间隔 = 章距，同章 = 0）。
  highlightOrder.sort((a, b) => a.chapterIndex - b.chapterIndex || a.charStart - b.charStart);
  const highlightIntervals: number[] = [];
  for (let i = 1; i < highlightOrder.length; i++) {
    highlightIntervals.push(highlightOrder[i]!.chapterIndex - highlightOrder[i - 1]!.chapterIndex);
  }

  // 铺垫-高潮跨度：各钩子章 → 其后首个 kernel 事件章（二分下界）。
  kernelChapters.sort((a, b) => a - b);
  const hookToKernelSpans: number[] = [];
  for (const hc of hookChapters) {
    let lo = 0;
    let hi = kernelChapters.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kernelChapters[mid]! < hc) lo = mid + 1;
      else hi = mid;
    }
    if (lo < kernelChapters.length) hookToKernelSpans.push(kernelChapters[lo]! - hc);
  }

  const charCount = chapterChars.reduce((sum, v) => sum + v, 0);

  // 弧级统计（聚合计数面——弧区间按章 index 闭区间过滤）。
  const arcStats = arcs.map((arc) => {
    const positions: number[] = [];
    for (let p = 0; p < chapters.length; p++) {
      const idx = chapters[p]!.index;
      if (idx >= arc.fromChapter && idx <= arc.toChapter) positions.push(p);
    }
    const plotPhaseCounts = zeroRecord(DECON_PLOT_PHASES);
    let hookCount = 0;
    let transitionCount = 0;
    let arcHighlightCount = 0;
    let beatCount = 0;
    let infoGapCount = 0;
    let arcForeshadowCount = 0;
    for (const p of positions) {
      const idx = chapters[p]!.index;
      const labels = labelsByChapter.get(idx);
      if (labels !== undefined) {
        hookCount += labels.hooks.length;
        transitionCount += labels.transitions.length;
        arcHighlightCount += labels.highlightSpans.length;
        beatCount += labels.emotionalBeats.length;
        if (labels.plotPhase !== null) plotPhaseCounts[labels.plotPhase] = (plotPhaseCounts[labels.plotPhase] ?? 0) + 1;
      }
      const facts = factsByChapter.get(idx);
      if (facts !== undefined) {
        infoGapCount += facts.infoGap.length;
        arcForeshadowCount += facts.foreshadowPlanted.length;
      }
    }
    return {
      index: arc.index,
      fromChapter: arc.fromChapter,
      toChapter: arc.toChapter,
      chapterCount: positions.length,
      charCount: positions.reduce((sum, p) => sum + (chapterChars[p] ?? 0), 0),
      chapterChars: deconDistribution(positions.map((p) => chapterChars[p] ?? 0)),
      hookCount,
      transitionCount,
      highlightCount: arcHighlightCount,
      emotionalBeatCount: beatCount,
      infoGapCount,
      foreshadowPlantedCount: arcForeshadowCount,
      plotPhaseCounts,
    };
  });

  // style_stats（纯代码 stylometry——基面 = 剥章标记行的派生 .md）。
  const clean = stripChapterMarkerLines(derivedText);
  const sentences = clean
    .split(/(?<=[。！？!?…])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const paragraphs = splitParagraphBlocks(clean);
  const nonEmptyLines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const dialogueLines = nonEmptyLines.filter((l) => DECON_DIALOGUE_MARK_RE.test(l)).length;

  return {
    book: {
      chapterCount: chapters.length,
      charCount,
      chapterChars: deconDistribution(chapterChars),
      highlightCount,
      highlightChars: deconDistribution(highlightCharLens),
      highlightIntervalChapters: deconDistribution(highlightIntervals),
      hooksByType,
      transitionsByType,
      emotionalBeatsByType,
      infoGapByType,
      foreshadowPlantedCount: foreshadowCount,
      foreshadowDensityPer10k: charCount > 0 ? foreshadowCount / (charCount / 10_000) : 0,
      expositionChars: deconDistribution(expositionCharLens),
      hookToKernelChapterSpan: deconDistribution(hookToKernelSpans),
    },
    arcs: arcStats,
    styleStats: {
      sentenceChars: deconDistribution(sentences.map((s) => s.length)),
      paragraphChars: deconDistribution(paragraphs.map((b) => b.end - b.start)),
      dialogueLineRatio: nonEmptyLines.length === 0 ? 0 : dialogueLines / nonEmptyLines.length,
    },
  };
}

// ── P3b 编排（两 unit 顺序跑——arcs → stats；零 LLM 无预算门）──

export interface DeconP3bStats {
  chapters: number;
  arcs: number;
  arcSource: DeconArcsPayload['audit']['source'];
  /** 消费的 p3a product 行数 / P1b facts 行数（观测面）。 */
  labelRows: number;
  factsRows: number;
}

export type DeconP3bResult =
  | { status: 'done'; stats: DeconP3bStats }
  | { status: 'paused'; stats: DeconP3bStats }
  | { status: 'cancelled'; stats: DeconP3bStats }
  | { status: 'capped'; message: string; stats: DeconP3bStats }
  | { status: 'failed'; message: string; stats: DeconP3bStats }
  | { status: 'stale'; message: string };

export interface DeconP3bDeps {
  /** 派生 .md 读取注入（style_stats 基面——缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  /** 逐 unit running 进度事件注入（CR-8）。 */
  notify?: (event: DeconProgressEvent) => void;
  /** 材料读重试等待注入（C4-F12——测试零延迟；缺省 ~1s×10 实时钟）。 */
  waitMs?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function emptyStats(chapters: number): DeconP3bStats {
  return { chapters, arcs: 0, arcSource: 'single', labelRows: 0, factsRows: 0 };
}

/** 边界/门停走映射（CR-7——paused/cancelled/stale 如实，其余 failed）。 */
function boundaryToP3bResult(stop: DeconBoundaryStop, stats: DeconP3bStats): DeconP3bResult {
  if (stop.status === 'paused') return { status: 'paused', stats };
  if (stop.status === 'cancelled') return { status: 'cancelled', stats };
  return { status: stop.status, message: stop.message, stats };
}

/**
 * 跑 P3b（pass='p3b'，unit='arcs'|'stats' 两行）。零 LLM：无预算门 / 无 cost 记账。
 * 输入读取：labels 从 product 表读回（p3a 产物——相位序保证先行）、facts 按材料指纹逐章、
 * 章界/字数从 material 行 + 派生 .md。断点重入 per unit（done+hash 一致 skip；重算免费但
 * 保持幂等面统一）；unit 边界感知 pause/cancel（CR-7）；产物 + pass_state done 同事务。
 */
export async function runDeconP3b(jobId: string, deps: DeconP3bDeps = {}): Promise<DeconP3bResult> {
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();

  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) {
    if (gate.stop === 'paused') return { status: 'paused', stats: emptyStats(0) };
    if (gate.stop === 'cancelled' || gate.stop === 'not-found') return { status: 'cancelled', stats: emptyStats(0) };
    if (gate.stop === 'stale') return { status: 'stale', message: gate.message };
    return { status: 'failed', message: gate.message, stats: emptyStats(0) };
  }
  const job: DeconJob = gate.job;

  // C4-F12 材料读重试 + C4-F16 写侧（材料级前置失败只 transitionDeconJob——job 行 error 承载）。
  const loaded = await loadExtractableMaterial(extractMaterialId(job.materialRef), { waitMs: deps.waitMs });
  if (!loaded.ok) {
    transitionDeconJob(jobId, 'fail', loaded.message);
    return { status: 'failed', message: loaded.message, stats: emptyStats(0) };
  }
  const material = loaded.material;
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    const message = '派生 .md 读取失败（缺失或车道不可解析）——无法计算章字数与 style_stats';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: emptyStats(material.chapters.length) };
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }
  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    const message = '材料无有效段落（派生 .md 全空白）——不可统计';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: emptyStats(material.chapters.length) };
  }

  const chapterChars = chapterCharCounts(blocks, material.chapters);
  const labelsByChapter = new Map<number, DeconChapterLabels>();
  for (const row of listDeconProducts(jobId, 'p3a')) {
    const parsed = deconChapterLabelsSchema.safeParse(row.payload);
    if (parsed.success) labelsByChapter.set(Number(row.unit), parsed.data);
  }
  const factsByChapter = new Map<number, DeconFacts>();
  for (const row of listDeconChapterFacts(job.materialRef, job.derivedHash)) {
    factsByChapter.set(row.chapterIndex, row.facts);
  }

  const stats: DeconP3bStats = {
    chapters: material.chapters.length,
    arcs: 0,
    arcSource: 'single',
    labelRows: labelsByChapter.size,
    factsRows: factsByChapter.size,
  };

  // ── unit='arcs'：弧切分定稿 ──
  const stopArcs = checkDeconRunBoundary(jobId);
  if (stopArcs !== null) return boundaryToP3bResult(stopArcs, stats);
  deps.notify?.({ jobId, status: 'running', pass: 'p3b', unit: 'arcs' });

  const arcsState = getDeconPassState(jobId, 'p3b', 'arcs');
  const arcsProduct = getDeconProduct(jobId, 'p3b', 'arcs');
  const arcsDecision = decideDeconPassReentry(
    arcsState,
    arcsProduct === null ? null : hashDeconProductOutput(arcsProduct.payload),
  );

  let arcsPayload: DeconArcsPayload | null = null;
  if (arcsDecision === 'skip' && arcsProduct !== null) {
    const stored = deconArcsPayloadSchema.safeParse(arcsProduct.payload);
    if (stored.success) arcsPayload = stored.data;
    // 存量坏行 → 落回重算（DERIVED 可重算面——不 fail）。
  }
  if (arcsPayload === null) {
    writeDeconPassState(jobId, 'p3b', 'arcs', 'running', null, nowIso());
    const computed = segmentDeconArcs(material.chapters, chapterChars, labelsByChapter);
    if (!deconArcsPayloadSchema.safeParse(computed).success) {
      const message = '弧切分产物未过契约校验（内部错误——切分实现与契约漂移，请报告）';
      failDeconUnit(jobId, 'p3b', 'arcs', message, nowIso());
      return { status: 'failed', message, stats };
    }
    const outputHash = hashDeconProductOutput(computed);
    const wrote = getDb().transaction(() => {
      const ok = upsertDeconProduct({ jobId, pass: 'p3b', unit: 'arcs', payload: computed, updatedAt: nowIso() });
      if (ok) {
        writeDeconPassState(jobId, 'p3b', 'arcs', 'done', { outputRef: 'product:p3b:arcs', outputHash }, nowIso());
      }
      return ok;
    })();
    if (!wrote) {
      const message = '弧切分落库被写侧门拒收（内部错误——payload 与契约漂移，请报告）';
      failDeconUnit(jobId, 'p3b', 'arcs', message, nowIso());
      return { status: 'failed', message, stats };
    }
    arcsPayload = computed;
  }
  stats.arcs = arcsPayload.arcs.length;
  stats.arcSource = arcsPayload.audit.source;

  // ── unit='stats'：统计族 ──
  const stopStats = checkDeconRunBoundary(jobId);
  if (stopStats !== null) return boundaryToP3bResult(stopStats, stats);
  deps.notify?.({ jobId, status: 'running', pass: 'p3b', unit: 'stats' });

  const statsState = getDeconPassState(jobId, 'p3b', 'stats');
  const statsProduct = getDeconProduct(jobId, 'p3b', 'stats');
  const statsDecision = decideDeconPassReentry(
    statsState,
    statsProduct === null ? null : hashDeconProductOutput(statsProduct.payload),
  );
  if (statsDecision !== 'skip') {
    writeDeconPassState(jobId, 'p3b', 'stats', 'running', null, nowIso());
    const computed = computeDeconStats({
      chapters: material.chapters,
      chapterChars,
      labelsByChapter,
      factsByChapter,
      arcs: arcsPayload.arcs,
      derivedText: derived,
    });
    if (!deconStatsPayloadSchema.safeParse(computed).success) {
      const message = '统计族产物未过契约校验（内部错误——统计实现与契约漂移，请报告）';
      failDeconUnit(jobId, 'p3b', 'stats', message, nowIso());
      return { status: 'failed', message, stats };
    }
    const outputHash = hashDeconProductOutput(computed);
    const wrote = getDb().transaction(() => {
      const ok = upsertDeconProduct({ jobId, pass: 'p3b', unit: 'stats', payload: computed, updatedAt: nowIso() });
      if (ok) {
        writeDeconPassState(jobId, 'p3b', 'stats', 'done', { outputRef: 'product:p3b:stats', outputHash }, nowIso());
      }
      return ok;
    })();
    if (!wrote) {
      const message = '统计族落库被写侧门拒收（内部错误——payload 与契约漂移，请报告）';
      failDeconUnit(jobId, 'p3b', 'stats', message, nowIso());
      return { status: 'failed', message, stats };
    }
  }

  return { status: 'done', stats };
}
