import type {
  DeconArc,
  DeconChapterLabels,
  DeconCraftDimensionId,
  DeconFacts,
  DeconFindings,
  DeconJob,
  DeconProgressEvent,
  DeconSpan,
  DeconStatsPayload,
  Material,
} from '@orison/shared-contracts';
import {
  craftCardCategorySchema,
  deconArcsPayloadSchema,
  deconChapterLabelsSchema,
  deconFindingsSchema,
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
import { getMaterialRow } from '../db/materialIndexer';
import { getLogger } from '../logger';
import { splitParagraphBlocks, type MaterialParagraphBlock } from '../ipc/toolHandlers/materialIngest';
import {
  DECON_STALE_NOTE,
  capDeconUnit,
  checkDeconRunBoundary,
  deconErrMsg,
  estimateDeconCallTokens,
  failDeconUnit,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  resolveDeconActualTokens,
  sha256DeconContent,
  writeDeconCost,
  writeDeconPassState,
  type DeconBoundaryStop,
} from './deconRun';
import { getDeconLlmCore, type DeconGenerateText } from './deconLlmCore';
import {
  DECON_HUOKE_CHAPTER_WINDOW,
  accumulateDeconCost,
  wouldExceedDeconBudget,
} from './deconBudget';
import { decideDeconPassReentry, extractMaterialId, transitionDeconJob } from './deconJob';
import { buildDeconAnchor, isQuoteInSpan, type DeconParaRange } from './p1Extract';
import { hashDeconProductOutput } from './p3Label';
import { DECON_P4_GRANULARITY, buildDeconP4SystemPrompt } from './p4Questionnaires';

// 单源在 deconBudget（CR-1——预估与章级 unit 集共消费；此处再导出保既有 import 面不破）。
export { DECON_HUOKE_CHAPTER_WINDOW };

// ── E10.3b（task 09-05）W3b：P4 手艺层 runner（child B design §3.2 问题单协议的执行面）──
//
// 按 job.dimensions（手艺维，style 走 p4Style.ts）× 粒度 unit（W3a 的 DECON_P4_GRANULARITY
// 登记）循环：章级维逐章 unit='ch:N'（huoke = 开篇子集前 min(12, 章数) 章）；弧级维逐弧
// unit='arc:N'。slot = review-judge（温 0.2——问题单应答是语义裁判面，parent design §4）。
//
// - **章级输入**：章全文【P段号】+ 该章 facts 预注 + P3a labels 预注（省重推导 + 增 grounding，
//   F-08 同族——只解读既有标注不重打）。
// - **弧级输入**：弧内 synopsis 序列 + 弧计量统计 + facts 聚合（出场退场表/核心事件与伏笔的
//   逐字引文窗口）+ duizhao 的同类场景聚类预注（纯代码，R4-H）。**抽样段限 wenbi 细读维**
//   （design §3.2——当前粒度登记 wenbi 无弧面，builder 参数保留登记演进位）。弧输入超 80K 字
//   按 sansheng 分组纪律拆 3-5 组组内串行、跨组矛盾保留分歧不抹平（findings 直接拼接不做
//   跨组裁决）。
// - **findings 锚定核验（R7/R8 无锚即丢）**：弧级可引用的 paraRange 集合 = 实际展示的原文窗口
//   （章级 = 章块范围；弧级 = 引文窗口 + 抽样段）——集外/引文不匹配丢该条 evidence + 计数，
//   evidence 全灭的 finding 整条丢。
// - 断点/预算/capped/cost/notify 全链 mirror p3Label（A 的 runner 样本）。
//
// 范式判据（parent design §9 P4 行）：问题单应答 = LLM；呼应证据锚定验证 / 名场面候选选择 /
// 弧分组 / 出场退场表 / 聚类 = 纯代码。
//
// expected_downstream_consumers:
// - deconIpc phases 动态化（design §9：P4 按 job.dimensions 序 [p4:<dim>…]——per-dim 调用；
//   省略 dimensionId 直调 = 全手艺维循环）。
// - W5 p6Craft（findings 中 craftHint≠null 者的落卡候选源）+ p5Output（章评的各维 findings 注入）。

// ── 常量（推测值起步——dogfood 首本标定）──

/** 每单元 findings 输出 token 预算（独立核算——E10.2a CR-2 纪律）：~40 条 × 150-200 tokens。 */
export const DECON_P4_FINDINGS_MAX_TOKENS = 8_192;

/** 每单元条目数上限（幻觉闸门族——超限 unit 失败诚实挂起，不静默截断）。 */
export const DECON_P4_MAX_FINDINGS_PER_UNIT = 40;

/** 弧级输入字符上限（sansheng 分组纪律——超限拆组）。 */
export const DECON_P4_ARC_INPUT_CHAR_LIMIT = 80_000;

/** 弧分组数量钳制带（sansheng：3-5 组 ≤80K 字组内蒸馏）。 */
export const DECON_P4_ARC_GROUP_MIN = 3;
export const DECON_P4_ARC_GROUP_MAX = 5;

/** 弧聚合引文单条字符上限（事实 span 切原文的截断——硬切不加省略号，保引文子串可核验）。 */
export const DECON_P4_ARC_QUOTE_CHAR_CAP = 80;

/** 出场退场表行数上限（弧注入体量闸——超出截断计数留痕）。 */
export const DECON_P4_APPEARANCE_CAP = 40;

/** 同类场景聚类的实体集 Jaccard 阈值（纯代码候选——变奏判断归 LLM）。 */
export const DECON_SCENE_CLUSTER_JACCARD = 0.6;

// ── 锚定窗口（可引用的原文段落区间——findings 证据的合法性域）──

/** 一个可引用窗口：全局块号半开区间 + 所属章（span 映射的 chapterIndex 来源）。 */
export interface DeconP4AnchorWindow {
  blockStart: number;
  blockEnd: number;
  chapterIndex: number;
}

// ── LLM 输出契约解析（W3a DECON_P4_*_OUTPUT_CONTRACT 的对侧——条目级容错）──

/** findings 条目（锚定核验前的 LLM 原始形态——paraRange+quote）。 */
export interface DeconRawFindingItem {
  insight: string;
  elaboration: string;
  evidence: Array<{ paraRange: DeconParaRange; quote: string }>;
  craftHint: { category?: string; termHint?: string; tags?: string[] } | null;
}

export interface DeconP4FindingsResponse {
  findings: DeconRawFindingItem[];
  synthesis: string;
}

/**
 * 解析问题单应答（条目级容错，mirror p3Label parseDeconLabelsSegmentResponse）：顶层坏
 * （无 JSON 对象 / findings 非数组且 synthesis 缺失）→ null 整体拒收；条目坏形状（缺
 * insight/elaboration / evidence 全坏 / 坏 paraRange 缺 quote）→ 丢条 + 计数；craftHint 坏
 * 形状或 category 越出 13 大类受控词表 → **hint 置 null 保条**（证据已合法——路由提示坏不
 * 连坐发现本体）+ 计数。
 */
export function parseDeconFindingsResponse(
  raw: string,
): { output: DeconP4FindingsResponse; droppedMalformed: number; itemCount: number } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.findings) && typeof o.synthesis !== 'string') return null;

  let dropped = 0;
  const takeStr = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);
  const takeParaRange = (v: unknown): DeconParaRange | null => {
    if (v === null || typeof v !== 'object') return null;
    const pr = v as Record<string, unknown>;
    if (typeof pr.start !== 'number' || !Number.isInteger(pr.start) || pr.start < 0) return null;
    if (typeof pr.end !== 'number' || !Number.isInteger(pr.end) || pr.end < 0) return null;
    return { start: pr.start, end: pr.end };
  };

  const findings: DeconRawFindingItem[] = [];
  if (Array.isArray(o.findings)) {
    for (const el of o.findings) {
      if (el === null || typeof el !== 'object') {
        dropped += 1;
        continue;
      }
      const r = el as Record<string, unknown>;
      const insight = takeStr(r.insight);
      const elaboration = takeStr(r.elaboration);
      if (insight === null || elaboration === null) {
        dropped += 1;
        continue;
      }
      const evidence: DeconRawFindingItem['evidence'] = [];
      if (Array.isArray(r.evidence)) {
        for (const ev of r.evidence) {
          if (ev === null || typeof ev !== 'object') {
            dropped += 1;
            continue;
          }
          const e = ev as Record<string, unknown>;
          const paraRange = takeParaRange(e.paraRange);
          const quote = takeStr(e.quote);
          if (paraRange === null || quote === null) {
            dropped += 1;
            continue;
          }
          evidence.push({ paraRange, quote });
        }
      }
      if (evidence.length === 0) {
        dropped += 1; // 无可用证据条——整条丢（输出契约 evidence ≥1）
        continue;
      }
      let craftHint: DeconRawFindingItem['craftHint'] = null;
      if (r.craftHint !== null && r.craftHint !== undefined) {
        if (typeof r.craftHint !== 'object') {
          dropped += 1;
        } else {
          const h = r.craftHint as Record<string, unknown>;
          const category = takeStr(h.category);
          const termHint = takeStr(h.termHint);
          const tags = Array.isArray(h.tags)
            ? h.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
            : undefined;
          const hasTags = tags !== undefined && tags.length > 0;
          if (category === null && termHint === null && !hasTags) {
            dropped += 1; // 空壳 hint = 坏形状
          } else if (category !== null && !craftCardCategorySchema.safeParse(category).success) {
            dropped += 1; // category 越出 13 大类受控词表——hint 作废保条
          } else {
            craftHint = {
              ...(category !== null ? { category } : {}),
              ...(termHint !== null ? { termHint } : {}),
              ...(hasTags ? { tags } : {}),
            };
          }
        }
      }
      findings.push({ insight, elaboration, evidence, craftHint });
    }
  }

  const synthesis = typeof o.synthesis === 'string' ? o.synthesis : '';
  return { output: { findings, synthesis }, droppedMalformed: dropped, itemCount: findings.length };
}

// ── 章级输入装配（纯函数——章全文 + facts/labels 预注）──

export interface DeconP4ChapterPromptInput {
  derived: string;
  blocks: readonly MaterialParagraphBlock[];
  chapterIndex: number;
  /** 章块范围（buildChapterSegments 的首末段并集——含首不含尾）。 */
  blockStart: number;
  blockEnd: number;
  facts: DeconFacts | null;
  labels: DeconChapterLabels | null;
}

/** 章级 user prompt（章全文【P段号】+ 事实/打标预注——窗口 = 章块范围整体）。 */
export function buildDeconP4ChapterUserPrompt(input: DeconP4ChapterPromptInput): {
  prompt: string;
  windows: readonly DeconP4AnchorWindow[];
} {
  const numbered: string[] = [];
  for (let i = input.blockStart; i < input.blockEnd; i++) {
    numbered.push(`【P${i}】${input.derived.slice(input.blocks[i]!.start, input.blocks[i]!.end)}`);
  }
  const factLines: string[] = [];
  if (input.facts !== null) {
    factLines.push(`- 章概要：${input.facts.synopsis}`);
    for (const e of input.facts.events) {
      factLines.push(`- 事件：${e.what}${e.kernel === true ? '〔核心事件〕' : ''}（段落 P${e.span.paraStart}–P${e.span.paraEnd - 1}）`);
    }
    for (const f of input.facts.foreshadowPlanted) {
      factLines.push(`- 伏笔埋点：${f.hint}（段落 P${f.span.paraStart}–P${f.span.paraEnd - 1}）`);
    }
    for (const g of input.facts.infoGap) {
      factLines.push(`- 信息差标注：${g.type}（段落 P${g.span.paraStart}–P${g.span.paraEnd - 1}）`);
    }
  }
  const labelLines: string[] = [];
  if (input.labels !== null) {
    for (const h of input.labels.hooks) {
      labelLines.push(`- 钩子：${h.type}（段落 P${h.span.paraStart}–P${h.span.paraEnd - 1}）`);
    }
    for (const t of input.labels.transitions) {
      labelLines.push(`- 转折：${t.type}（段落 P${t.span.paraStart}–P${t.span.paraEnd - 1}）`);
    }
    for (const b of input.labels.emotionalBeats) {
      labelLines.push(`- 情绪拍：${b.beat}（段落 P${b.span.paraStart}–P${b.span.paraEnd - 1}）`);
    }
    if (input.labels.plotPhase !== null) labelLines.push(`- 本章主导相位：${input.labels.plotPhase}`);
    for (const s of input.labels.highlightSpans) {
      labelLines.push(`- 爽点段：段落 P${s.paraStart}–P${s.paraEnd - 1}`);
    }
    for (const s of input.labels.expositionSpans) {
      labelLines.push(`- 设定说明段：段落 P${s.paraStart}–P${s.paraEnd - 1}`);
    }
  }
  const prompt = [
    '【本章正文（【P段落号】标记每段开始；段落号是全文档全局编号）】',
    numbered.join('\n\n'),
    ...(factLines.length > 0 ? ['', '【本章事实提取（上游产物预注——只解读不重打）】', ...factLines] : []),
    ...(labelLines.length > 0 ? ['', '【本章打标（上游产物预注——只解读不重打）】', ...labelLines] : []),
    `（本片段段落号范围 P${input.blockStart}–P${input.blockEnd - 1}；结论的 paraRange 只能引用该范围内实际出现的段落号）`,
  ].join('\n');
  return { prompt, windows: [{ blockStart: input.blockStart, blockEnd: input.blockEnd, chapterIndex: input.chapterIndex }] };
}

// ── 弧级聚合（纯函数——出场退场表 / 逐字引文窗口 / 同类场景聚类）──

/** 弧级单章块（概要 + 锚定引文——「@P段号」标记可引用窗口）。 */
export interface DeconP4ArcChapterBlock {
  chapterIndex: number;
  text: string;
  windows: readonly DeconP4AnchorWindow[];
}

function sliceQuote(derived: string, span: DeconSpan): string {
  return derived.slice(span.charStart, span.charEnd).slice(0, DECON_P4_ARC_QUOTE_CHAR_CAP).replace(/\s+/g, ' ').trim();
}

/** 弧级单章块装配（事件/伏笔的引文 = facts span 切原文硬截——可引用窗口随行）。纯函数。 */
export function buildDeconP4ArcChapterBlock(
  ch: { index: number; title: string | null; facts: DeconFacts | null },
  derived: string,
): DeconP4ArcChapterBlock {
  const windows: DeconP4AnchorWindow[] = [];
  const lines: string[] = [];
  const title = ch.title !== null ? `《${ch.title}》` : '';
  lines.push(`第${ch.index + 1}章${title}概要：${ch.facts?.synopsis ?? '（无概要——该章无事实提取行）'}`);
  if (ch.facts !== null) {
    for (const e of ch.facts.events) {
      lines.push(
        `  · 事件：${e.what}${e.kernel === true ? '〔核心〕' : ''}「${sliceQuote(derived, e.span)}」@P${e.span.paraStart}–P${e.span.paraEnd - 1}`,
      );
      windows.push({ blockStart: e.span.paraStart, blockEnd: e.span.paraEnd, chapterIndex: e.span.chapterIndex });
    }
    for (const f of ch.facts.foreshadowPlanted) {
      lines.push(`  · 伏笔埋点：${f.hint}「${sliceQuote(derived, f.span)}」@P${f.span.paraStart}–P${f.span.paraEnd - 1}`);
      windows.push({ blockStart: f.span.paraStart, blockEnd: f.span.paraEnd, chapterIndex: f.span.chapterIndex });
    }
    if (ch.facts.infoGap.length > 0) {
      const gaps = ch.facts.infoGap.map((g) => `${g.type}@P${g.span.paraStart}`).join('、');
      lines.push(`  · 信息差：${gaps}`);
    }
  }
  return { chapterIndex: ch.index, text: lines.join('\n'), windows };
}

/** 出场退场表（弧内实体 → 弧内出现章 + 全书首末章——renshe 等弧级维预注）。纯函数。 */
export function buildDeconP4Appearances(
  arc: Pick<DeconArc, 'fromChapter' | 'toChapter'>,
  factsByChapter: ReadonlyMap<number, DeconFacts>,
): { lines: string[]; droppedForCap: number } {
  const arcChapters: number[] = [];
  for (const [chapterIndex, facts] of factsByChapter) {
    if (chapterIndex >= arc.fromChapter && chapterIndex <= arc.toChapter && facts.entities.length > 0) {
      arcChapters.push(chapterIndex);
    }
  }
  arcChapters.sort((a, b) => a - b);
  const nameArcChapters = new Map<string, number[]>();
  for (const ci of arcChapters) {
    for (const e of factsByChapter.get(ci)!.entities) {
      const list = nameArcChapters.get(e.name) ?? [];
      if (!list.includes(ci)) list.push(ci);
      nameArcChapters.set(e.name, list);
    }
  }
  const nameBookWide = new Map<string, { first: number; last: number }>();
  for (const [ci, facts] of [...factsByChapter.entries()].sort((a, b) => a[0] - b[0])) {
    for (const e of facts.entities) {
      const rec = nameBookWide.get(e.name) ?? { first: ci, last: ci };
      nameBookWide.set(e.name, { first: Math.min(rec.first, ci), last: Math.max(rec.last, ci) });
    }
  }
  const rows = [...nameArcChapters.entries()]
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, chapters]) => {
      const wide = nameBookWide.get(name) ?? { first: chapters[0]!, last: chapters.at(-1)! };
      return `- ${name}：弧内出现第 ${chapters.map((c) => c + 1).join('、')} 章；全书首现第 ${wide.first + 1} 章、末现第 ${wide.last + 1} 章`;
    });
  const kept = rows.slice(0, DECON_P4_APPEARANCE_CAP);
  return { lines: kept, droppedForCap: rows.length - kept.length };
}

/** 同类场景聚类组（纯代码候选——按章实体集 Jaccard 归组；变奏判断归 LLM，R4-H）。 */
export interface DeconSceneClusterGroup {
  chapters: number[];
  sharedEntities: string[];
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 同类场景聚类（纯函数——duizhao 弧级预注）：贪心种子归组（章序扫描，种子与后续未归组章
 * Jaccard ≥ 阈值同组），组内实体交集为共同阵容（交集空 = 非真同阵容，弃组）。确定性
 * tie-break：章序。
 */
export function clusterDeconSameScenes(
  chapters: ReadonlyArray<{ index: number; entities: ReadonlyArray<{ name: string }> | undefined }>,
  threshold: number = DECON_SCENE_CLUSTER_JACCARD,
): DeconSceneClusterGroup[] {
  const sets = chapters.map((c) => new Set((c.entities ?? []).map((e) => e.name)));
  const assigned = new Array<boolean>(chapters.length).fill(false);
  const groups: DeconSceneClusterGroup[] = [];
  for (let i = 0; i < chapters.length; i++) {
    if (assigned[i] || sets[i]!.size === 0) continue;
    const members = [i];
    for (let j = i + 1; j < chapters.length; j++) {
      if (assigned[j] || sets[j]!.size === 0) continue;
      if (jaccard(sets[i]!, sets[j]!) >= threshold) {
        members.push(j);
      }
    }
    if (members.length < 2) continue;
    let shared = [...sets[i]!];
    for (const j of members) shared = shared.filter((n) => sets[j]!.has(n));
    if (shared.length === 0) continue;
    for (const j of members) assigned[j] = true;
    groups.push({ chapters: members.map((j) => chapters[j]!.index), sharedEntities: shared.sort() });
  }
  return groups;
}

// ── 弧分组（sansheng 纪律——>80K 拆 3-5 组）──

/**
 * 弧内章分组（纯函数，确定性）：总贡献 ≤ 上限 → 单组；超限 → 组数 = clamp(ceil(总/上限)，3，5)，
 * 贪心按目标配额连续装箱（贡献以渲染块实长计——非估算公式）。
 */
export function splitDeconArcGroups(
  contributions: readonly number[],
  limit: number = DECON_P4_ARC_INPUT_CHAR_LIMIT,
): number[][] {
  const n = contributions.length;
  if (n === 0) return [];
  const total = contributions.reduce((s, v) => s + v, 0);
  if (total <= limit) return [Array.from({ length: n }, (_, i) => i)];
  const groupCount = Math.min(
    DECON_P4_ARC_GROUP_MAX,
    Math.max(DECON_P4_ARC_GROUP_MIN, Math.ceil(total / limit)),
  );
  const target = total / groupCount;
  const groups: number[][] = [];
  let current: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const remainingGroups = groupCount - groups.length;
    if (
      remainingGroups > 1 &&
      current.length > 0 &&
      (acc >= target || i === n - remainingGroups) // 配额满或必须给剩余组留位
    ) {
      groups.push(current);
      current = [];
      acc = 0;
    }
    current.push(i);
    acc += contributions[i] ?? 0;
  }
  if (current.length > 0) groups.push(current);
  return groups.slice(0, groupCount);
}

// ── 弧级 user prompt 装配（纯函数）──

export interface DeconP4ArcPromptInput {
  derived: string;
  blocks: readonly MaterialParagraphBlock[];
  arc: DeconArc;
  arcStat: DeconStatsPayload['arcs'][number] | null;
  /** 本组章块（分组后子集——组内串行时各组独立 prompt）。 */
  chapterBlocks: readonly DeconP4ArcChapterBlock[];
  appearances: { lines: readonly string[]; droppedForCap: number };
  clusters: readonly DeconSceneClusterGroup[];
  /** 抽样段（限 wenbi 细读维——design §3.2；当前登记 wenbi 无弧面，参数保留演进位）。 */
  sampleBlocks: ReadonlyArray<{ chapterIndex: number; blockIndex: number }>;
}

/** 弧级 user prompt（概要+统计+出场退场+引文窗口+聚类+可选抽样段）。 */
export function buildDeconP4ArcUserPrompt(input: DeconP4ArcPromptInput): {
  prompt: string;
  windows: readonly DeconP4AnchorWindow[];
} {
  const stat = input.arcStat;
  const statLines = [
    `- 章数 ${stat?.chapterCount ?? input.arc.chapterCount}、约 ${Math.round((stat?.charCount ?? input.arc.charCount) / 1000)}k 字`,
    `- 钩子 ${stat?.hookCount ?? 0} 次、转折 ${stat?.transitionCount ?? 0} 次、爽点段 ${stat?.highlightCount ?? 0} 处、情绪拍 ${stat?.emotionalBeatCount ?? 0} 拍`,
    `- 信息差标注 ${stat?.infoGapCount ?? 0} 处、伏笔埋点 ${stat?.foreshadowPlantedCount ?? 0} 处`,
    ...(stat !== null && Object.values(stat.plotPhaseCounts).some((v) => v > 0)
      ? [
          `- 章主导相位分布：${Object.entries(stat.plotPhaseCounts)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k}×${v}`)
            .join('、')}`,
        ]
      : []),
  ];
  const arcTitle = input.arc.title !== null ? `（${input.arc.title}）` : '';
  const sections: string[] = [
    `【本弧信息：弧 ${input.arc.index}${arcTitle}——第 ${input.arc.fromChapter + 1} 至 ${input.arc.toChapter + 1} 章${input.chapterBlocks.length < input.arc.chapterCount ? `（本组含第 ${(input.chapterBlocks[0]?.chapterIndex ?? 0) + 1}–${(input.chapterBlocks.at(-1)?.chapterIndex ?? 0) + 1} 章，弧输入过大分组分析——跨组结论如有出入保留分歧如实写）` : ''}）】`,
    '【弧计量统计（纯代码算数——数字直接采信，不重算）】',
    ...statLines,
    '',
    '【出场退场表（纯代码聚合自事实层）】',
    ...(input.appearances.lines.length > 0
      ? input.appearances.lines
      : ['（本弧无实体出场记录）']),
    ...(input.appearances.droppedForCap > 0 ? [`（出场人物过多，其余 ${input.appearances.droppedForCap} 位略）`] : []),
    '',
    '【弧内各章概要与锚定引文（「@P段号」标记的引文段落区间 = 结论可引用的原文窗口）】',
    ...input.chapterBlocks.map((b) => b.text),
  ];
  if (input.clusters.length > 0) {
    sections.push(
      '',
      '【同类场景聚类（纯代码候选——按人物阵容相似度归组；变奏判断归你）】',
      ...input.clusters.map(
        (g) => `- 组：第 ${g.chapters.map((c) => c + 1).join('、')} 章（共同人物：${g.sharedEntities.join('、')}）`,
      ),
    );
  }
  const windows: DeconP4AnchorWindow[] = [];
  for (const b of input.chapterBlocks) windows.push(...b.windows);
  if (input.sampleBlocks.length > 0) {
    const lines: string[] = [];
    for (const s of input.sampleBlocks) {
      const block = input.blocks[s.blockIndex]!;
      lines.push(`【P${s.blockIndex}】${input.derived.slice(block.start, block.end)}`);
      windows.push({ blockStart: s.blockIndex, blockEnd: s.blockIndex + 1, chapterIndex: s.chapterIndex });
    }
    sections.push('', '【带段落号的原文抽样段（文本细读用）】', ...lines);
  }
  sections.push(
    '',
    '（结论的 paraRange 只能引用上述输入里带段落号标记的原文——各章概要与统计数字不是原文，不能当证据引用；「@P段号」标记的引文所在段落区间可引用）',
  );
  return { prompt: sections.join('\n'), windows };
}

// ── 锚定核验（无锚即丢——paraRange 落窗 + 引文子串双核验）──

/**
 * findings 逐条锚定核验（纯函数）：evidence 的 paraRange 须落在某个展示窗口内且引文是窗口
 * 文本子串（buildDeconAnchor + isQuoteInSpan——与 P1b/P3a 同双核验）。evidence 全灭的
 * finding 整条丢 + 计数（R7/R8 红线——无呼应证据的结论不出现）。
 */
export function verifyDeconFindings(
  response: DeconP4FindingsResponse,
  windows: readonly DeconP4AnchorWindow[],
  blocks: readonly MaterialParagraphBlock[],
  derived: string,
): {
  findings: DeconFindings['findings'];
  droppedFindings: number;
  droppedEvidence: number;
} {
  const out: DeconFindings['findings'] = [];
  let droppedFindings = 0;
  let droppedEvidence = 0;
  for (const f of response.findings) {
    const evidence: DeconFindings['findings'][number]['evidence'] = [];
    for (const ev of f.evidence) {
      const ok = windows.some((w) => {
        const span = buildDeconAnchor(ev.paraRange, { blockStart: w.blockStart, blockEnd: w.blockEnd }, blocks, w.chapterIndex);
        return span !== null && isQuoteInSpan(ev.quote, derived.slice(span.charStart, span.charEnd));
      });
      if (ok) evidence.push({ paraRange: ev.paraRange, quote: ev.quote });
      else droppedEvidence += 1;
    }
    if (evidence.length === 0) {
      droppedFindings += 1;
      continue;
    }
    out.push({
      insight: f.insight,
      elaboration: f.elaboration,
      evidence,
      ...(f.craftHint !== null ? { craftHint: f.craftHint as DeconFindings['findings'][number]['craftHint'] } : { craftHint: null }),
    });
  }
  return { findings: out, droppedFindings, droppedEvidence };
}

// ── P4 编排（dim × unit 循环——断点/预算/锚定核验/同事务落库）──

export interface DeconP4CraftStats {
  dimensions: number;
  units: number;
  skipped: number;
  analyzed: number;
  droppedNoAnchorFindings: number;
  droppedEvidence: number;
  droppedMalformed: number;
  /** >80K 弧分组拆出的组数合计（未分组弧计 1）。 */
  arcGroups: number;
  /** 纯标记/空白章跳过数（CR-15 同款）。 */
  emptyUnits: number;
  /** 零可锚窗口弧跳过数（CR-16——无 facts/无抽样段的弧不烧 LLM）。 */
  emptyArcUnits: number;
}

export type DeconP4CraftResult =
  | { status: 'done'; stats: DeconP4CraftStats }
  | { status: 'paused'; stats: DeconP4CraftStats }
  | { status: 'cancelled'; stats: DeconP4CraftStats }
  | { status: 'capped'; message: string; stats: DeconP4CraftStats }
  | { status: 'failed'; message: string; stats: DeconP4CraftStats }
  | { status: 'stale'; message: string };

export interface DeconP4CraftDeps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  /** 逐 unit running 进度事件注入（CR-8——runDeconPassSequence 传 stamped notify）。 */
  notify?: (event: DeconProgressEvent) => void;
  now?: () => Date;
}

function emptyStats(): DeconP4CraftStats {
  return {
    dimensions: 0,
    units: 0,
    skipped: 0,
    analyzed: 0,
    droppedNoAnchorFindings: 0,
    droppedEvidence: 0,
    droppedMalformed: 0,
    arcGroups: 0,
    emptyUnits: 0,
    emptyArcUnits: 0,
  };
}

/** 边界/门停走映射（CR-7——paused/cancelled/stale 如实，其余 failed）。 */
function boundaryToP4Result(stop: DeconBoundaryStop, stats: DeconP4CraftStats): DeconP4CraftResult {
  if (stop.status === 'paused') return { status: 'paused', stats };
  if (stop.status === 'cancelled') return { status: 'cancelled', stats };
  return { status: stop.status, message: stop.message, stats };
}

/** 章级 unit 集（design §3.1 粒度面——huoke 开篇子集）。 */
export function deconP4ChapterUnits(dimensionId: DeconCraftDimensionId, chapterCount: number): number[] {
  const window = dimensionId === 'huoke' ? Math.min(DECON_HUOKE_CHAPTER_WINDOW, chapterCount) : chapterCount;
  return Array.from({ length: Math.max(0, window) }, (_, i) => i);
}

/** 弧级抽样段（每弧首/中/尾各 1 段——design §3.2 文本细读维；块取章内最长块，确定性 tie-break 取先）。 */
export function deconP4ArcSampleBlocks(
  arc: Pick<DeconArc, 'fromChapter' | 'toChapter'>,
  chapters: ReadonlyArray<{ index: number; charStart: number; charEnd: number }>,
  blocks: readonly MaterialParagraphBlock[],
): Array<{ chapterIndex: number; blockIndex: number }> {
  const inArc = chapters.filter((c) => c.index >= arc.fromChapter && c.index <= arc.toChapter);
  if (inArc.length === 0) return [];
  const picks: Array<{ index: number; charStart: number; charEnd: number }> = [];
  picks.push(inArc[0]!);
  picks.push(inArc[Math.floor((inArc.length - 1) / 2)]!);
  picks.push(inArc[inArc.length - 1]!);
  const seen = new Set<number>();
  const out: Array<{ chapterIndex: number; blockIndex: number }> = [];
  for (const ch of picks) {
    if (seen.has(ch.index)) continue;
    seen.add(ch.index);
    let best = -1;
    let bestLen = -1;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.end > ch.charStart && b.start < ch.charEnd && b.end - b.start > bestLen) {
        bestLen = b.end - b.start;
        best = i;
      }
    }
    if (best >= 0) out.push({ chapterIndex: ch.index, blockIndex: best });
  }
  return out;
}

/**
 * 跑 P4 手艺层（pass='p4:<dim>'）。`dimensionId` 省略 = 循环 job.dimensions 全手艺维
 * （直调/测试面）；deconIpc phases 按 dim 序逐维调（design §9 [p4:<dim>…]）。每 unit：
 * 断点重入（done+hash 一致 skip 零重付）→ 输入装配（章级=章文+预注 / 弧级=概要+统计+引文
 * 窗口，>80K 分组）→ 段内预算门前置（超限 capped 不烧 token）→ findings 解析 + 逐条锚定
 * 核验（无锚即丢+计数）→ 写侧 zod 门 + product + pass_state done 同事务。unit 边界感知
 * pause/cancel（CR-7）；finishReason='length' = failed（findings 语义面，mirror p1b——半程
 * findings 不可续）。LLM 内核惰性判定（CR-10）。
 */
export async function runDeconP4Craft(
  jobId: string,
  deps: DeconP4CraftDeps = {},
  dimensionId?: DeconCraftDimensionId,
): Promise<DeconP4CraftResult> {
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();

  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) {
    if (gate.stop === 'paused') return { status: 'paused', stats: emptyStats() };
    if (gate.stop === 'cancelled' || gate.stop === 'not-found') return { status: 'cancelled', stats: emptyStats() };
    if (gate.stop === 'stale') return { status: 'stale', message: gate.message };
    return { status: 'failed', message: gate.message, stats: emptyStats() };
  }
  const job: DeconJob = gate.job;

  const dimensions = (dimensionId !== undefined ? [dimensionId] : job.dimensions.filter((d): d is DeconCraftDimensionId => d !== 'style'));
  for (const dim of dimensions) {
    if (DECON_P4_GRANULARITY[dim] === undefined) {
      const message = `维度 ${dim} 不在手艺粒度登记（DECON_P4_GRANULARITY）——job 维度子集与目录漂移`;
      failDeconUnit(jobId, `p4:${dim}`, 'all', message, nowIso());
      return { status: 'failed', message, stats: emptyStats() };
    }
  }
  if (dimensions.length === 0) {
    return { status: 'done', stats: { ...emptyStats(), dimensions: 0 } }; // 零手艺维（coarse/coarse+style）——无 unit 直接 done
  }

  const material = getMaterialRow(extractMaterialId(job.materialRef));
  if (material === null || material.chapters.length === 0) {
    const message = `材料 ${job.materialRef} 不存在或零章——P4 无可分析章`;
    failDeconUnit(jobId, `p4:${dimensions[0]!}`, 'all', message, nowIso());
    return { status: 'failed', message, stats: emptyStats() };
  }
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    const message = '派生 .md 读取失败（缺失或车道不可解析）——无法锚定手艺层基面';
    failDeconUnit(jobId, `p4:${dimensions[0]!}`, 'all', message, nowIso());
    return { status: 'failed', message, stats: emptyStats() };
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }
  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    const message = '材料无有效段落（派生 .md 全空白）——不可分析';
    failDeconUnit(jobId, `p4:${dimensions[0]!}`, 'all', message, nowIso());
    return { status: 'failed', message, stats: emptyStats() };
  }

  // 惰性资源面（CR-10）：facts / labels / arcs / stats 只在首个消费 unit 前加载。
  let generate: DeconGenerateText | undefined;
  let factsLazy: ReadonlyMap<number, DeconFacts> | undefined;
  const requireFacts = (): ReadonlyMap<number, DeconFacts> => {
    if (factsLazy === undefined) {
      const map = new Map<number, DeconFacts>();
      for (const row of listDeconChapterFacts(job.materialRef, job.derivedHash)) map.set(row.chapterIndex, row.facts);
      factsLazy = map;
    }
    return factsLazy;
  };
  let labelsLazy: ReadonlyMap<number, DeconChapterLabels> | undefined;
  const requireLabels = (): ReadonlyMap<number, DeconChapterLabels> => {
    if (labelsLazy === undefined) {
      const map = new Map<number, DeconChapterLabels>();
      for (const row of listDeconProducts(jobId, 'p3a')) {
        const parsed = deconChapterLabelsSchema.safeParse(row.payload);
        if (parsed.success) map.set(Number(row.unit), parsed.data);
      }
      labelsLazy = map;
    }
    return labelsLazy;
  };
  let arcsLazy: DeconArc[] | null | undefined;
  const requireArcs = (): DeconArc[] | null => {
    if (arcsLazy === undefined) {
      const product = getDeconProduct(jobId, 'p3b', 'arcs');
      const parsed = product === null ? null : deconArcsPayloadSchema.safeParse(product.payload);
      arcsLazy = parsed !== null && parsed.success ? parsed.data.arcs : null;
    }
    return arcsLazy;
  };
  let arcStatsLazy: ReadonlyMap<number, DeconStatsPayload['arcs'][number]> | undefined;
  const requireArcStats = (): ReadonlyMap<number, DeconStatsPayload['arcs'][number]> => {
    if (arcStatsLazy === undefined) {
      const map = new Map<number, DeconStatsPayload['arcs'][number]>();
      const product = getDeconProduct(jobId, 'p3b', 'stats');
      const parsed = product === null ? null : deconStatsPayloadSchema.safeParse(product.payload);
      if (parsed !== null && parsed.success) for (const a of parsed.data.arcs) map.set(a.index, a);
      arcStatsLazy = map;
    }
    return arcStatsLazy;
  };

  const stats: DeconP4CraftStats = { ...emptyStats(), dimensions: dimensions.length };
  let cost = job.cost;

  for (const dim of dimensions) {
    const pass = `p4:${dim}`;
    for (const face of DECON_P4_GRANULARITY[dim]!) {
      const systemPrompt = buildDeconP4SystemPrompt({ dimensionId: dim, granularity: face });

      // unit 集（章级 = 章号子集〔huoke 开篇窗口〕；弧级 = p3b 弧切分序）。
      type UnitPlan =
        | { unit: string; chapterIndex: number }
        | { unit: string; arc: DeconArc };
      const unitPlans: UnitPlan[] = [];
      if (face === 'chapter') {
        const wanted = new Set(deconP4ChapterUnits(dim, material.chapters.length));
        for (const chapter of material.chapters) {
          if (wanted.has(chapter.index)) unitPlans.push({ unit: `ch:${chapter.index}`, chapterIndex: chapter.index });
        }
      } else {
        const arcs = requireArcs();
        if (arcs === null) {
          const message = 'p3b 弧切分产物缺失（或形状坏）——弧级问题单无通读单元，请先跑完 p3b';
          failDeconUnit(jobId, pass, 'arc:0', message, nowIso());
          return { status: 'failed', message, stats };
        }
        for (const arc of arcs) unitPlans.push({ unit: `arc:${arc.index}`, arc });
      }

      for (const plan of unitPlans) {
        // 中断韧性（CR-7）：unit 边界如实判别 pause/cancel/外部翻态。
        const stop = checkDeconRunBoundary(jobId);
        if (stop !== null) return boundaryToP4Result(stop, stats);

        const unit = plan.unit;
        deps.notify?.({ jobId, status: 'running', pass, unit });
        stats.units += 1;

        const state = getDeconPassState(jobId, pass, unit);
        const product = getDeconProduct(jobId, pass, unit);
        const decision = decideDeconPassReentry(
          state,
          product === null ? null : hashDeconProductOutput(product.payload),
        );
        if (decision === 'skip') {
          stats.skipped += 1;
          continue;
        }

        const failUnit = (message: string): { status: 'failed'; message: string; stats: DeconP4CraftStats } => {
          failDeconUnit(jobId, pass, unit, message, nowIso());
          return { status: 'failed', message, stats };
        };

        if (generate === undefined) {
          generate = deps.generateText ?? getDeconLlmCore()?.generateText;
          if (generate === undefined) {
            return failUnit('拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试');
          }
        }

        // 输入装配（一次或分组多次 LLM 调用；**核验窗口按组随行**——CR-15：组 k 的 findings
        // 只对组 k 的窗口集核验，跨组窗口不进组核验池）。空章跳过在 state 写 running 之前
        // （CR-15——跳过章不落 running 残留行 / 不落 product 行）。
        let prompts: string[] = [];
        let promptWindows: DeconP4AnchorWindow[][] = [];
        if ('chapterIndex' in plan) {
          const chapter = material.chapters.find((c) => c.index === plan.chapterIndex)!;
          let first = -1;
          let last = -1;
          for (let i = 0; i < blocks.length; i++) {
            if (blocks[i]!.end > chapter.charStart && blocks[i]!.start < chapter.charEnd) {
              if (first === -1) first = i;
              last = i;
            }
          }
          if (first === -1) {
            // CR-15 同款：纯标记/空白章跳过 + 计数，不 fail 整 pass。
            stats.emptyUnits += 1;
            getLogger().warn(
              { jobId, dimension: dim, chapterIndex: plan.chapterIndex },
              'decon p4: chapter has no analyzable blocks (marker-only or blank) - skipped without failing the pass',
            );
            continue;
          }
          const built = buildDeconP4ChapterUserPrompt({
            derived,
            blocks,
            chapterIndex: chapter.index,
            blockStart: first,
            blockEnd: last + 1,
            facts: requireFacts().get(chapter.index) ?? null,
            labels: requireLabels().get(chapter.index) ?? null,
          });
          prompts = [built.prompt];
          promptWindows = [[...built.windows]];
        } else {
          const arc = plan.arc;
          const facts = requireFacts();
          const arcChapters = material.chapters.filter((c) => c.index >= arc.fromChapter && c.index <= arc.toChapter);
          const chapterBlocks = arcChapters.map((c) =>
            buildDeconP4ArcChapterBlock({ index: c.index, title: c.title, facts: facts.get(c.index) ?? null }, derived),
          );
          const groups = splitDeconArcGroups(chapterBlocks.map((b) => b.text.length));
          stats.arcGroups += groups.length;
          const appearances = buildDeconP4Appearances(arc, facts);
          const clusters =
            dim === 'duizhao'
              ? clusterDeconSameScenes(
                  arcChapters.map((c) => ({ index: c.index, entities: facts.get(c.index)?.entities })),
                )
              : [];
          const sampleBlocks = dim === 'wenbi' ? deconP4ArcSampleBlocks(arc, material.chapters, blocks) : [];
          for (const group of groups) {
            const built = buildDeconP4ArcUserPrompt({
              derived,
              blocks,
              arc,
              arcStat: requireArcStats().get(arc.index) ?? null,
              chapterBlocks: group.map((i) => chapterBlocks[i]!),
              appearances,
              clusters,
              sampleBlocks,
            });
            prompts.push(built.prompt);
            promptWindows.push([...built.windows]);
          }
        }

        // CR-16 空弧守卫（CR-15 空章同款）：弧内零可锚窗口（无 facts 章的弧无引文窗口、
        // 非细读维无抽样段）→ 问题单照跑 findings 必全灭核验——纯烧 LLM。跳过 + 计数 +
        // note 不 fail 整 pass（重跑幂等廉价；不落 running 残留行 / 不落 product 行）。
        if (promptWindows.length > 0 && promptWindows.every((ws) => ws.length === 0)) {
          stats.emptyArcUnits += 1;
          getLogger().warn(
            { jobId, pass, unit },
            'decon p4: arc has no anchorable windows (no facts/sample blocks) - skipped without failing the pass',
          );
          continue;
        }

        writeDeconPassState(jobId, pass, unit, 'running', null, nowIso());

        // 组内串行（章级单发；弧级 = 分组数）——每调用独立预算门/记账/停因。
        const parts: DeconP4FindingsResponse[] = [];
        for (let gi = 0; gi < prompts.length; gi++) {
          const user = prompts[gi]!;
          const est = estimateDeconCallTokens(systemPrompt, user, DECON_P4_FINDINGS_MAX_TOKENS);
          if (wouldExceedDeconBudget(job.budget, cost, pass, est)) {
            const note = `${pass} ${unit} 问题单预算超限（本次预估 ${est} tokens，已累计 ${cost.totalTokens}）——已诚实挂起（不烧 token），调整预算后续跑`;
            capDeconUnit(jobId, pass, unit, note, nowIso());
            return { status: 'capped', message: note, stats };
          }
          let text = '';
          let finishReason: string | undefined;
          let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
          try {
            const response = await generate({
              slot: 'review-judge',
              system: systemPrompt,
              user,
              maxTokens: DECON_P4_FINDINGS_MAX_TOKENS,
            });
            text = (response?.text ?? '').trim();
            finishReason = response?.finishReason;
            usage = response?.usage;
          } catch (err) {
            return failUnit(`${pass} ${unit} 问题单调用失败：${deconErrMsg(err)}`);
          }
          const actual = resolveDeconActualTokens(systemPrompt, user, text, usage);
          cost = accumulateDeconCost(cost, pass, actual.tokens, 1, actual.estimated);
          writeDeconCost(jobId, job, cost, nowIso());
          if (finishReason === 'length') {
            // findings 语义面（mirror p1b）：截断的半程 findings 不可续——failed 诚实挂起。
            return failUnit(`${pass} ${unit} 问题单输出因 token 上限截断（finishReason=length）——已挂起（不落半程产物）`);
          }
          if (!text) {
            return failUnit(`${pass} ${unit} 问题单返回空回复——已挂起`);
          }
          const parsed = parseDeconFindingsResponse(text);
          if (parsed === null) {
            return failUnit(`${pass} ${unit} 问题单输出不可解析为 JSON 对象——整体拒收（不硬给 findings）`);
          }
          stats.droppedMalformed += parsed.droppedMalformed;
          if (parsed.itemCount > DECON_P4_MAX_FINDINGS_PER_UNIT) {
            return failUnit(
              `${pass} ${unit} findings 条数 ${parsed.itemCount} 超过上限 ${DECON_P4_MAX_FINDINGS_PER_UNIT}——为避免静默截断已挂起（材料或输出契约异常，请人工检查）`,
            );
          }
          parts.push(parsed.output);
        }

        // 分组合计帽（合并检查——段内单发帽之外的第二道，mirror p3a CR-5 合并帽）。
        const mergedCount = parts.reduce((sum, p) => sum + p.findings.length, 0);
        if (mergedCount > DECON_P4_MAX_FINDINGS_PER_UNIT) {
          return failUnit(
            `${pass} ${unit} 分组 findings 合计 ${mergedCount} 条超过上限 ${DECON_P4_MAX_FINDINGS_PER_UNIT}——为避免静默截断已挂起`,
          );
        }

        // 锚定核验（无锚即丢——R7/R8）**按组**（CR-15：组 k 的 findings 只对组 k 的窗口集
        // 核验——「证据在模型实际输入内」不变量，组 1 产的 finding 不得锚到仅组 3 展示的段落）
        // + 多组合并（findings 拼接、synthesis 分组保留分歧）。
        const mergedFindings: DeconFindings['findings'] = [];
        const synthesisParts: string[] = [];
        let droppedFindings = 0;
        let droppedEvidence = 0;
        for (let gi = 0; gi < parts.length; gi++) {
          const verified = verifyDeconFindings(parts[gi]!, promptWindows[gi]!, blocks, derived);
          mergedFindings.push(...verified.findings);
          droppedFindings += verified.droppedFindings;
          droppedEvidence += verified.droppedEvidence;
          if (parts[gi]!.synthesis.length > 0) synthesisParts.push(parts[gi]!.synthesis);
        }
        stats.droppedNoAnchorFindings += droppedFindings;
        stats.droppedEvidence += droppedEvidence;
        if (droppedFindings > 0) {
          getLogger().warn(
            { jobId, pass, unit, dropped: droppedFindings, droppedEvidence },
            'decon p4: findings dropped for missing anchor (fabricated paraRange or quote) - no-anchor-no-keep discipline',
          );
        }
        const candidate: DeconFindings = { findings: mergedFindings, synthesis: synthesisParts.join('\n\n') };
        if (!deconFindingsSchema.safeParse(candidate).success) {
          return failUnit(`${pass} ${unit} findings 未过契约校验（内部错误——核验与契约漂移，请报告）`);
        }
        const outputHash = hashDeconProductOutput(candidate);

        const wrote = getDb().transaction(() => {
          const ok = upsertDeconProduct({ jobId, pass, unit, payload: candidate, updatedAt: nowIso() });
          if (ok) {
            writeDeconPassState(jobId, pass, unit, 'done', { outputRef: `product:${pass}:${unit}`, outputHash }, nowIso());
          }
          return ok;
        })();
        if (!wrote) {
          return failUnit(`${pass} ${unit} findings 落库被写侧门拒收（内部错误——payload 与契约漂移，请报告）`);
        }
        stats.analyzed += 1;
      }
    }
  }

  return { status: 'done', stats };
}
