import type {
  DeconArc,
  DeconChapterLabels,
  DeconJob,
  DeconProgressEvent,
  DeconSpan,
  DeconStatsPayload,
  DeconStylePayload,
  Material,
} from '@orison/shared-contracts';
import {
  deconArcsPayloadSchema,
  deconChapterLabelsSchema,
  deconStylePayloadSchema,
  deconStatsPayloadSchema,
} from '@orison/shared-contracts';
import { getDb } from '../db/index';
import {
  getDeconPassState,
  getDeconProduct,
  listDeconProducts,
  upsertDeconProduct,
  upsertDeconReport,
} from '../db/closure-decon';
import { listDeconCanonEntries } from '../db/closure-canon';
import { getMaterialRow } from '../db/materialIndexer';
import { getLogger } from '../logger';
import { splitParagraphBlocks, type MaterialParagraphBlock } from '../ipc/toolHandlers/materialIngest';
import {
  DECON_STALE_NOTE,
  capDeconUnit,
  checkDeconRunBoundary,
  failDeconUnit,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  runDeconLlmCall,
  sha256DeconContent,
  writeDeconPassState,
  type DeconBoundaryStop,
} from './deconRun';
import { buildChapterHeadings as buildDeconChapterHeadings, chapterShortLabel as deconChapterShortLabel } from '../db/chapterHeadings';
import { getDeconLlmCore, type DeconGenerateText } from './deconLlmCore';
import { decideDeconPassReentry, extractMaterialId, transitionDeconJob } from './deconJob';
import { hashDeconProductOutput } from './p3Label';
import type { DeconStyleSectionKey } from '@orison/shared-contracts';

// ── E10.3b（task 09-05）W3b：P4 风格维特化（child B design §3.3——4.7 完整风格学习落点）──
//
// 输入 = p3b style_stats（② 机械统计——纯代码直落，LLM 不编数字）+ canon tone 域条目 +
// 抽样段（每弧首/中/尾 + 高潮段〔highlightSpans 峰值章〕对照——覆盖不同叙事模式）。
// 输出双落：**14 节结构化 payload**（product 表 pass='p4:style'、unit='all'——语义键对齐
// agent style-card.ts 的 StyleSectionKey）+ **md 渲染报告**（report 表 kind='style_report'）。
// slot = writer-draft（温 0.3——风格分析性叙事面，parent design §4 / F-17）。
//
// 节分工（范式判据）：
// - LLM 产 11 节（voice/syntax/…/prohibitions——模仿指令语义面）；
// - 纯代码产 3 节：② 机械统计（style_stats 渲染）/ ⑬ 节选（纯代码选 800-2000 字代表原文，
//   fenced ```text 包裹——4.7 分析者契约形态）/ ⑭ 附录（材料来源注记非全文复制——版权姿势，
//   本地私用节选级引用）。
// - 标准 14 节标题串钉死在本文件常量（出处 = agent prompts/style-analyzer-agent.yaml:78-101
//   ——yaml 是数据文件不可导入，值对齐由 DECON_STYLE_SECTION_KEYS 测试对拍防漂移）。
//
// expected_downstream_consumers:
// - deconIpc phases（dims 含 style 时挂 p4:style，排手艺维后）。
// - W5 decon:export-style（payload → parseStyleSections 合并写目标项目风格卡）。
// - W6 拆书页风格 tab（report md 阅读面）。

// ── 常量（推测值起步——dogfood 首本标定）──

/** 风格 LLM 输出 token 预算（11 节 × 每节 2-6 句模仿指令）。 */
export const DECON_P4_STYLE_MAX_TOKENS = 10_240;

/** 单抽样段字符上限（输入体量闸）。 */
export const DECON_P4_STYLE_SAMPLE_CHAR_CAP = 1_200;

/** 抽样段总字符上限（超限按序丢弃后续弧的抽样段——确定性，弃段计数留痕）。 */
export const DECON_P4_STYLE_SAMPLES_TOTAL_CAP = 15_000;

/** 节选目标字数带（4.7 分析者契约：800-2000 字连续原文；材料不足 800 时全选）。 */
export const DECON_P4_STYLE_EXCERPT_MIN_CHARS = 800;
export const DECON_P4_STYLE_EXCERPT_MAX_CHARS = 2_000;

// ── 标准 14 节标题（值对齐 agent style-analyzer 契约；渲染序 = 卡内序 ①→⑭）──

/** 语义键 → 标准 14 节标题（「无卡新建」的标准节标题串单源——export 复用）。 */
export const DECON_STYLE_SECTION_HEADINGS: Readonly<Record<DeconStyleSectionKey, string>> = {
  voice: '## ① 声音画像',
  stats: '## ② 机械统计',
  syntax: '## ③ 句法与文字节奏',
  narrative: '## ④ 叙事节奏',
  dialogue: '## ⑤ 对话',
  description: '## ⑥ 描写的取舍',
  imagery: '## ⑦ 意象与比喻思维',
  emotion: '## ⑧ 情绪手法',
  info: '## ⑨ 信息处理',
  character: '## ⑩ 人物呈现法',
  expectation: '## ⑪ 期待管理',
  prohibitions: '## ⑫ 禁则',
  excerpt: '## ⑬ 节选（few-shot）',
  appendix: '## ⑭ 原文附录',
};

// ── ② 机械统计渲染（纯函数——prompt 注入与卡内 ② 节同源）──

function fmtDist(label: string, d: { count: number; min: number; avg: number; max: number; sigma: number }): string {
  return `- ${label}：均值 ${d.avg.toFixed(1)} 字（最短 ${d.min} / 最长 ${d.max}，离散度 ${d.sigma.toFixed(1)}，样本数 ${d.count}）`;
}

/** style_stats → 文本（prompt 注入面与 ② 节内容单源——数字只经此处进产物）。 */
export function renderDeconStyleStats(stats: DeconStatsPayload['styleStats']): string {
  return [
    fmtDist('句子长度', stats.sentenceChars),
    fmtDist('段落长度', stats.paragraphChars),
    `- 对话行占比：${(stats.dialogueLineRatio * 100).toFixed(1)}%`,
  ].join('\n');
}

// ── 抽样段收集（纯函数——每弧首/中/尾 + 高潮段对照）──

export interface DeconStyleSample {
  label: string;
  text: string;
}

/** 章内最长块（确定性 tie-break 取先）。 */
function longestBlockInChapter(
  chapter: { charStart: number; charEnd: number },
  blocks: readonly MaterialParagraphBlock[],
): number {
  let best = -1;
  let bestLen = -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.end > chapter.charStart && b.start < chapter.charEnd && b.end - b.start > bestLen) {
      bestLen = b.end - b.start;
      best = i;
    }
  }
  return best;
}

/**
 * 风格抽样段（纯函数）：每弧首/中/尾章各取章内最长块 + 高潮对照段（highlightSpans 峰值章的
 * 最长爽点段）。超总上限按序丢后续弧段（弃段计数留痕——spec 溢出计数纪律）。
 * `chapterLabel` = chapterIndex → 真实章标短标签（C5——样本标签章号不再 index 算术，F19）。
 */
export function collectDeconStyleSamples(
  derived: string,
  blocks: readonly MaterialParagraphBlock[],
  chapters: ReadonlyArray<{ index: number; charStart: number; charEnd: number }>,
  arcs: readonly DeconArc[],
  labelsByChapter: ReadonlyMap<number, DeconChapterLabels>,
  chapterLabel: (chapterIndex: number) => string,
): { samples: DeconStyleSample[]; droppedForCap: number } {
  const scope: Array<Pick<DeconArc, 'fromChapter' | 'toChapter'>> =
    arcs.length > 0
      ? arcs.map((a) => ({ fromChapter: a.fromChapter, toChapter: a.toChapter }))
      : [{ fromChapter: chapters[0]?.index ?? 0, toChapter: chapters.at(-1)?.index ?? 0 }];
  const picked: DeconStyleSample[] = [];
  let droppedForCap = 0;
  let total = 0;
  const push = (label: string, text: string): void => {
    const clipped = text.slice(0, DECON_P4_STYLE_SAMPLE_CHAR_CAP);
    if (total + clipped.length > DECON_P4_STYLE_SAMPLES_TOTAL_CAP) {
      droppedForCap += 1; // 超总上限弃段计数留痕（不静默）
      return;
    }
    total += clipped.length;
    picked.push({ label, text: clipped });
  };
  for (const arc of scope) {
    const inArc = chapters.filter((c) => c.index >= arc.fromChapter && c.index <= arc.toChapter);
    if (inArc.length === 0) continue;
    const picks = [inArc[0]!, inArc[Math.floor((inArc.length - 1) / 2)]!, inArc[inArc.length - 1]!];
    const seen = new Set<number>();
    for (const ch of picks) {
      if (seen.has(ch.index)) continue;
      seen.add(ch.index);
      const bi = longestBlockInChapter(ch, blocks);
      if (bi < 0) continue;
      push(
        `弧 ${arc.fromChapter}-${arc.toChapter} 章 · ${chapterLabel(ch.index)}（${ch === inArc[0] ? '弧首' : ch === inArc.at(-1) ? '弧尾' : '弧中'}）`,
        derived.slice(blocks[bi]!.start, blocks[bi]!.end),
      );
    }
  }
  // 高潮对照段：爽点段数峰值章的最长爽点 span 文本。**峰值须非零**（W7 集成验收发现：
  // 全书零爽点段打标是合法 P3a 输入，仅按 climaxChapter >= 0 判定会在空数组上 reduce
  // 崩 pass——mirror selectDeconStyleExcerpt 的 length>0 守卫，无峰值诚实跳过）。
  let climaxChapter = -1;
  let climaxCount = -1;
  for (const [chapterIndex, labels] of labelsByChapter) {
    if (labels.highlightSpans.length > climaxCount) {
      climaxCount = labels.highlightSpans.length;
      climaxChapter = chapterIndex;
    }
  }
  if (climaxChapter >= 0 && climaxCount > 0) {
    const spans = labelsByChapter.get(climaxChapter)!.highlightSpans;
    const longest = spans.reduce((a, b) => (b.charEnd - b.charStart > a.charEnd - a.charStart ? b : a));
    push(`高潮对照 · ${chapterLabel(climaxChapter)}（爽点段峰值章）`, derived.slice(longest.charStart, longest.charEnd));
  }
  return { samples: picked, droppedForCap };
}

// ── ⑬ 节选（纯代码选段——800-2000 字连续原文）──

export interface DeconStyleExcerpt {
  text: string;
  anchor: DeconSpan;
}

/**
 * 代表性节选（纯函数，确定性）：种子 = 爽点字数覆盖峰值章的最长爽点段（无打标回退中位章
 * 最长块）；从覆盖种子的块向两侧整块扩展至 ≥800 字，超 2000 硬截（连续原文，逐字）。
 */
export function selectDeconStyleExcerpt(
  derived: string,
  blocks: readonly MaterialParagraphBlock[],
  chapters: ReadonlyArray<{ index: number; charStart: number; charEnd: number }>,
  labelsByChapter: ReadonlyMap<number, DeconChapterLabels>,
): DeconStyleExcerpt | null {
  // 种子定位：峰值章（爽点字符覆盖合计，tie 取先）→ 该章最长爽点段；回退 = 中位章最长块。
  let seedChapterIndex = -1;
  let seedCover = -1;
  for (const [chapterIndex, labels] of labelsByChapter) {
    const cover = labels.highlightSpans.reduce((s, x) => s + (x.charEnd - x.charStart), 0);
    if (cover > seedCover) {
      seedCover = cover;
      seedChapterIndex = chapterIndex;
    }
  }
  let seedCharStart: number | null = null;
  let seedCharEnd: number | null = null;
  let chapter = chapters.find((c) => c.index === seedChapterIndex);
  if (chapter !== undefined && (labelsByChapter.get(chapter.index)?.highlightSpans.length ?? 0) > 0) {
    const longest = labelsByChapter
      .get(chapter.index)!
      .highlightSpans.reduce((a, b) => (b.charEnd - b.charStart > a.charEnd - a.charStart ? b : a));
    seedCharStart = longest.charStart;
    seedCharEnd = longest.charEnd;
  } else {
    chapter = chapters[Math.floor((chapters.length - 1) / 2)];
    if (chapter === undefined) return null;
    const bi = longestBlockInChapter(chapter, blocks);
    if (bi < 0) return null;
    seedCharStart = blocks[bi]!.start;
    seedCharEnd = blocks[bi]!.end;
  }
  // 覆盖种子的连续块区间 [i, j]，向两侧整块扩展至 ≥800，封顶 2000 硬截。
  let i = -1;
  let j = -1;
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k]!;
    if (b.end > seedCharStart! && b.start < seedCharEnd!) {
      if (i === -1) i = k;
      j = k;
    }
  }
  if (i === -1) return null;
  const chapterOfBlock = (k: number): number => {
    const owner = chapters.find((c) => blocks[k]!.end > c.charStart && blocks[k]!.start < c.charEnd);
    return owner?.index ?? seedChapterIndex;
  };
  const chapterIndex = chapterOfBlock(i);
  while (derived.slice(blocks[i]!.start, blocks[j]!.end).length < DECON_P4_STYLE_EXCERPT_MIN_CHARS) {
    const leftCandidate = i - 1 >= 0 && chapterOfBlock(i - 1) === chapterIndex ? blocks[i - 1]!.start : null;
    const rightCandidate = j + 1 < blocks.length && chapterOfBlock(j + 1) === chapterIndex ? blocks[j + 1]!.end : null;
    if (leftCandidate === null && rightCandidate === null) break;
    // 两侧都可扩时取增量小侧（贴近种子的代表性优先）。
    const leftGain = leftCandidate !== null ? blocks[i]!.start - leftCandidate : Number.POSITIVE_INFINITY;
    const rightGain = rightCandidate !== null ? rightCandidate - blocks[j]!.end : Number.POSITIVE_INFINITY;
    if (rightGain <= leftGain && rightCandidate !== null) j += 1;
    else i -= 1;
  }
  const start = blocks[i]!.start;
  const rawEnd = blocks[j]!.end;
  const end = Math.min(rawEnd, start + DECON_P4_STYLE_EXCERPT_MAX_CHARS);
  const text = derived.slice(start, end);
  if (text.trim().length === 0) return null;
  return {
    text,
    anchor: { chapterIndex, charStart: start, charEnd: end, paraStart: i, paraEnd: j + 1 },
  };
}

// ── LLM 输出契约解析（11 节 JSON——键受控）──

const DECON_STYLE_LLM_KEY_SET: ReadonlySet<string> = new Set<string>([
  'voice',
  'syntax',
  'narrative',
  'dialogue',
  'description',
  'imagery',
  'emotion',
  'info',
  'character',
  'expectation',
  'prohibitions',
]);

/**
 * 解析风格节响应：顶层坏（无 JSON / sections 非对象）→ null 整体拒收；坏节（键集外 / 空
 * 串 / 非串）丢弃 + 计数；零可用节 → null（宁缺毋滥的失败半边——不产空壳卡）。
 */
export function parseDeconStyleSectionsResponse(
  raw: string,
): { sections: Partial<Record<DeconStyleSectionKey, string>>; dropped: number } | null {
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
  const sectionsRaw = (obj as Record<string, unknown>).sections;
  if (sectionsRaw === null || typeof sectionsRaw !== 'object') return null;
  let dropped = 0;
  const sections: Partial<Record<DeconStyleSectionKey, string>> = {};
  for (const [key, value] of Object.entries(sectionsRaw as Record<string, unknown>)) {
    if (!(DECON_STYLE_LLM_KEY_SET as ReadonlySet<string>).has(key) || typeof value !== 'string' || value.trim().length === 0) {
      dropped += 1;
      continue;
    }
    sections[key as DeconStyleSectionKey] = value;
  }
  if (Object.keys(sections).length === 0) return null;
  return { sections, dropped };
}

// ── md 渲染（report 表 kind='style_report' 的内容面）──

/** 风格报告 md（标准 14 节标题序渲染——存在的节才出；export/阅读共用形态）。 */
export function renderDeconStyleReportMd(bookTitle: string, payload: DeconStylePayload): string {
  const keys = Object.keys(DECON_STYLE_SECTION_HEADINGS) as DeconStyleSectionKey[];
  const parts: string[] = [`# 《${bookTitle}》风格拆解报告`];
  for (const key of keys) {
    const content = payload.sections[key];
    if (content === undefined) continue;
    parts.push(DECON_STYLE_SECTION_HEADINGS[key], '', content, '');
  }
  return parts.join('\n').trim() + '\n';
}

// ── system prompt（网文语境——平实白话）──

export const DECON_P4_STYLE_SYSTEM_PROMPT = [
  '你是小说拆解的风格分析师，为这本书提炼一份「风格画像」——给想模仿这本书文风的写手当范本说明。',
  '输入里给你三样东西：机械统计（代码算好的数字，直接采信，别重算）、基调参考（来自设定整理）、以及原文抽样段（覆盖弧首/弧中/弧尾与高潮段的写法）。',
  '输出纯 JSON 对象，不要任何解释或前后缀：',
  '{"sections":{"voice":"…","syntax":"…","narrative":"…","dialogue":"…","description":"…","imagery":"…","emotion":"…","info":"…","character":"…","expectation":"…","prohibitions":"…"}}',
  '各节写什么（键固定，证据不足的节整节省略，宁缺毋滥）：',
  '- voice 声音画像：叙述者的口吻人格——对笔下人物什么态度、对读者什么姿态，一两句定调加展开（此节以材料为据尽量产出）；',
  '- syntax 句法与文字节奏：句子长短怎么配、标点习惯、句子节奏跟情绪怎么配合（用机械统计佐证）；',
  '- narrative 叙事节奏：快慢怎么换挡、哪里铺陈哪里一笔带过；',
  '- dialogue 对话：对白什么味道——长短、口癖、潜台词密度、交锋感；',
  '- description 描写的取舍：选什么写、跳过什么，外貌/环境/动作各给多长、出现在什么时机；',
  '- imagery 意象与比喻思维：比喻密度、喻体从哪类东西里取、取喻的逻辑；',
  '- emotion 情绪手法：情绪怎么给——直陈、身体反应、行为暗示各占多少，落点放哪；',
  '- info 信息处理：信息什么时候给、给多少，留白用在哪；',
  '- character 人物呈现法：人物靠什么立起来（行动/心理/对话/他人侧写），出场怎么写；',
  '- expectation 期待管理：章头章尾怎么勾人、承诺兑现的节奏；',
  '- prohibitions 禁则：学这个声音不该做什么——从正面观察反推（他从不用的手法、从不出现的句式）；',
  '每节两到六句，写手视角口吻（「多用…」「在…时机做…」「避免…」），观察要引抽样段原文作依据；只依据给定材料，不编造原文里没有的内容。',
  '机械统计、节选、附录三节由系统生成，你不要输出。',
].join('\n');

// ── P4 风格维编排（unit='all' 单发——product + report 双落同事务）──

export interface DeconP4StyleStats {
  llmSections: number;
  droppedSections: number;
  excerptChars: number;
  samples: number;
  droppedSamples: number;
}

export type DeconP4StyleResult =
  | { status: 'done'; stats: DeconP4StyleStats }
  | { status: 'paused'; stats: DeconP4StyleStats }
  | { status: 'cancelled'; stats: DeconP4StyleStats }
  | { status: 'capped'; message: string; stats: DeconP4StyleStats }
  | { status: 'failed'; message: string; stats: DeconP4StyleStats }
  | { status: 'stale'; message: string };

export interface DeconP4StyleDeps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  notify?: (event: DeconProgressEvent) => void;
  now?: () => Date;
}

function emptyStats(): DeconP4StyleStats {
  return { llmSections: 0, droppedSections: 0, excerptChars: 0, samples: 0, droppedSamples: 0 };
}

/** 边界/门停走映射（CR-7——paused/cancelled/stale 如实，其余 failed）。 */
function boundaryToP4StyleResult(stop: DeconBoundaryStop, stats: DeconP4StyleStats): DeconP4StyleResult {
  if (stop.status === 'paused') return { status: 'paused', stats };
  if (stop.status === 'cancelled') return { status: 'cancelled', stats };
  return { status: stop.status, message: stop.message, stats };
}

/**
 * 跑 P4 风格维（pass='p4:style'、unit='all'）：抽样段 + style_stats + tone 注入 → LLM 产
 * 11 节（writer-draft）→ 纯代码补 stats/excerpt/appendix 三节 → 14 节 payload 落 product +
 * md 渲染落 report（kind='style_report'）同事务。断点重入 / 预算门 / finishReason='length'
 * failed（语义面）/ cost 记账 / unit 级进度事件，全链 mirror p3Label。
 */
export async function runDeconP4Style(jobId: string, deps: DeconP4StyleDeps = {}): Promise<DeconP4StyleResult> {
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  const pass = 'p4:style';
  const unit = 'all';
  const failUnit = (message: string): { status: 'failed'; message: string; stats: DeconP4StyleStats } => {
    failDeconUnit(jobId, pass, unit, message, nowIso());
    return { status: 'failed', message, stats: emptyStats() };
  };

  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) {
    if (gate.stop === 'paused') return { status: 'paused', stats: emptyStats() };
    if (gate.stop === 'cancelled' || gate.stop === 'not-found') return { status: 'cancelled', stats: emptyStats() };
    if (gate.stop === 'stale') return { status: 'stale', message: gate.message };
    return { status: 'failed', message: gate.message, stats: emptyStats() };
  }
  const job: DeconJob = gate.job;

  const stop = checkDeconRunBoundary(jobId);
  if (stop !== null) return boundaryToP4StyleResult(stop, emptyStats());
  deps.notify?.({ jobId, status: 'running', pass, unit });

  const state = getDeconPassState(jobId, pass, unit);
  const product = getDeconProduct(jobId, pass, unit);
  const decision = decideDeconPassReentry(state, product === null ? null : hashDeconProductOutput(product.payload));
  if (decision === 'skip') {
    return { status: 'done', stats: emptyStats() }; // 重入零重付
  }

  const material = getMaterialRow(extractMaterialId(job.materialRef));
  if (material === null) {
    return failUnit(`材料 ${job.materialRef} 不存在——风格维无分析基面`);
  }
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    return failUnit('派生 .md 读取失败（缺失或车道不可解析）——无法锚定风格基面');
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }
  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    return failUnit('材料无有效段落（派生 .md 全空白）——不可分析');
  }

  // C5：chapterIndex → 真实章标行映射（抽样段标签章号——F19）。
  const headings = buildDeconChapterHeadings(derived, material.chapters);
  const chShort = (chapterIndex: number): string => deconChapterShortLabel(headings.get(chapterIndex), chapterIndex);

  // style_stats 原料（p3b 先行——缺失诚实挂起，不编数字）。
  const statsProduct = getDeconProduct(jobId, 'p3b', 'stats');
  const statsParsed = statsProduct === null ? null : deconStatsPayloadSchema.safeParse(statsProduct.payload);
  if (statsParsed === null || !statsParsed.success) {
    return failUnit('p3b 统计族产物缺失（或形状坏）——风格维的机械统计原料依赖 p3b 先行');
  }
  const styleStatsText = renderDeconStyleStats(statsParsed.data.styleStats);

  // 抽样段（弧切分可用时按弧；缺失退全书单段）+ tone 域条目。
  const arcsProduct = getDeconProduct(jobId, 'p3b', 'arcs');
  const arcsParsed = arcsProduct === null ? null : deconArcsPayloadSchema.safeParse(arcsProduct.payload);
  const arcs = arcsParsed !== null && arcsParsed.success ? arcsParsed.data.arcs : [];
  const labelsByChapter = new Map<number, DeconChapterLabels>();
  for (const row of listDeconProducts(jobId, 'p3a')) {
    const parsed = deconChapterLabelsSchema.safeParse(row.payload);
    if (parsed.success) labelsByChapter.set(Number(row.unit), parsed.data);
  }
  const collected = collectDeconStyleSamples(derived, blocks, material.chapters, arcs, labelsByChapter, chShort);
  const toneEntries = listDeconCanonEntries(jobId, 'tone');
  const toneLines =
    toneEntries.length > 0
      ? toneEntries.map((e) => `- ${e.name}：${String((e.payload as Record<string, unknown>).baseline ?? '')}`.trimEnd())
      : ['（无基调条目——照常分析，仅参考抽样段）'];

  const generate = deps.generateText ?? getDeconLlmCore()?.generateText;
  if (generate === undefined) {
    return failUnit('拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试');
  }

  writeDeconPassState(jobId, pass, unit, 'running', null, nowIso());

  const user = [
    '【机械统计（代码预计算——客观数字直接采信）】',
    styleStatsText,
    '',
    '【基调参考（来自设定整理）】',
    ...toneLines,
    '',
    '【原文抽样段（覆盖弧首/弧中/弧尾与高潮段——风格证据的来源）】',
    ...collected.samples.map((s) => `〔${s.label}〕${s.text}`),
    ...(collected.droppedForCap > 0 ? [`（抽样段超体量上限，其余 ${collected.droppedForCap} 段略）`] : []),
  ].join('\n');

  const stats: DeconP4StyleStats = {
    ...emptyStats(),
    samples: collected.samples.length,
    droppedSamples: collected.droppedForCap,
  };

  // C3 脚手架单源（预算门→调用→记账→length 升帽重试一次）；截断仍挂 = failed
  // （风格节语义面——半程产物不可续，旧语义）。
  const call = await runDeconLlmCall({
    jobId,
    pass,
    unit,
    slot: 'writer-draft',
    system: DECON_P4_STYLE_SYSTEM_PROMPT,
    user,
    maxTokens: DECON_P4_STYLE_MAX_TOKENS,
    budget: job.budget,
    cost: job.cost,
    job,
    generate,
    notify: deps.notify,
    nowIso,
    label: '风格分析',
  });
  if (!call.ok) {
    if (call.kind === 'budget-capped') {
      capDeconUnit(jobId, pass, unit, call.note, nowIso());
      return { status: 'capped', message: call.note, stats };
    }
    if (call.kind === 'length') {
      return failUnit(`${call.note}——已挂起（不落半程产物）`);
    }
    return failUnit(call.note); // error / empty
  }
  const text = call.text;
  const parsedSections = parseDeconStyleSectionsResponse(text);
  if (parsedSections === null) {
    return failUnit('风格分析输出不可解析为可用节 JSON——整体拒收（不硬给风格卡）');
  }
  stats.llmSections = Object.keys(parsedSections.sections).length;
  stats.droppedSections = parsedSections.dropped;

  // 纯代码三节：② 机械统计 / ⑬ 节选（fenced——4.7 分析者契约形态）/ ⑭ 附录来源注记。
  const excerpt = selectDeconStyleExcerpt(derived, blocks, material.chapters, labelsByChapter);
  if (excerpt === null) {
    return failUnit('节选选段失败（材料无可用原文段）——风格卡无 few-shot 范本，不产空壳卡');
  }
  stats.excerptChars = excerpt.text.length;
  const sections: DeconStylePayload['sections'] = { ...parsedSections.sections };
  sections.stats = styleStatsText;
  sections.excerpt = ['```text', excerpt.text, '```'].join('\n');
  sections.appendix = `来源：《${material.name}》（材料 ${extractMaterialId(job.materialRef)}）。本报告为本地拆书私用的节选级引用，不复制全文。`;

  const payload: DeconStylePayload = {
    sections,
    excerptAnchors: [excerpt.anchor],
    bookTitle: material.name,
    materialId: extractMaterialId(job.materialRef),
  };
  if (!deconStylePayloadSchema.safeParse(payload).success) {
    return failUnit('风格 payload 未过契约校验（内部错误——装配与契约漂移，请报告）');
  }
  const outputHash = hashDeconProductOutput(payload);
  const reportMd = renderDeconStyleReportMd(material.name, payload);

  const wrote = getDb().transaction(() => {
    const ok = upsertDeconProduct({ jobId, pass, unit, payload, updatedAt: nowIso() });
    if (!ok) return false;
    const reportOk = upsertDeconReport({
      jobId,
      kind: 'style_report',
      unit: 'all',
      contentMd: reportMd,
      anchors: [excerpt.anchor],
      dimension: 'style',
      updatedAt: nowIso(),
    });
    if (!reportOk) return false;
    writeDeconPassState(jobId, pass, unit, 'done', { outputRef: `product:${pass}:${unit}`, outputHash }, nowIso());
    return true;
  })();
  if (!wrote) {
    return failUnit('风格产物落库被写侧门拒收（内部错误——payload/report 与契约漂移，请报告）');
  }
  if (stats.droppedSections > 0 || stats.droppedSamples > 0) {
    getLogger().warn(
      { jobId, droppedSections: stats.droppedSections, droppedSamples: stats.droppedSamples },
      'decon p4 style: dropped malformed sections / over-cap samples (counted, not silent)',
    );
  }
  return { status: 'done', stats };
}
