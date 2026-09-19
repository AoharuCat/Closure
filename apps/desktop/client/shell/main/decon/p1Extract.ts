import type {
  DeconDictionary,
  DeconDictionaryEntry,
  DeconEntityType,
  DeconFacts,
  DeconInfoGapType,
  DeconJob,
  DeconProgressEvent,
  DeconSpan,
  Material,
} from '@orison/shared-contracts';
import { DECON_ENTITY_TYPES, DECON_INFO_GAP_TYPES, deconFactsSchema } from '@orison/shared-contracts';
import { getDb } from '../db/index';
import {
  getDeconChapterFacts,
  getDeconDictionary,
  getDeconPassState,
  listDeconChapterFacts,
  upsertDeconChapterFacts,
  upsertDeconPassState,
} from '../db/closure-decon';
import { getLogger } from '../logger';
import { splitParagraphBlocks, type MaterialParagraphBlock } from '../ipc/toolHandlers/materialIngest';
import {
  DECON_STALE_NOTE,
  capDeconUnit,
  checkDeconRunBoundary,
  failDeconUnit,
  loadExtractableMaterial,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  runDeconLlmCall,
  sha256DeconContent,
  writeDeconPassState,
  type DeconBoundaryStop,
} from './deconRun';
import { buildChapterHeadings as buildDeconChapterHeadings, chapterShortLabel as deconChapterShortLabel } from '../db/chapterHeadings';
import { getDeconLlmCore, type DeconGenerateText } from './deconLlmCore';
import { decideDeconPassReentry, extractMaterialId, hashDeconFactsOutput, transitionDeconJob } from './deconJob';

// ── E10.3a（task 09-05）W4：P1b 逐章提取（parent design §2.1 P1b / child A design §P1b 契约）──
//
// 逐章循环产出 deconFactsSchema 六段（synopsis / entities / events / relationshipEdges /
// foreshadowPlanted / infoGap）——提取目标 = **作者需要的素材**（伏笔埋点/信息差标注/事件分级
// kernel），非读者事实（R2 §6.5a）。
//
// - **上下文注入**（AI-Reader-V2 ContextSummaryBuilder 模式）：词典全量注入做共指锚定 +
//   前章 synopsis 滑窗（最近 3 章——已 done 章从 facts 表读，重入/继承章同样供窗）。
// - **无锚即丢双保险（F-15）**：schema 必填（W1）+ 校验层做 span 在章内派生 .md 的存在性比对
//   （镜像 10.2 双核验：paraRange 集外核验——编造 span 整体丢该条；引文子串匹配（空白归一
//   容忍）——编造引文丢该条；丢弃计数审计）。
// - **分批**：章自然 unit；超长章按段落块边界切 ≤18k 字段段内串行（10.2 buildExtractSegments
//   同款预算自治——单块超限保持整段不硬截）。
// - **capped 诚实挂起**：每段 LLM 调用**前**过 wouldExceedDeconBudget——超限 state=capped +
//   job=capped，不烧 token；不落半程产物（段全部完成才落章 facts）。
// - **中断韧性**：任意章边界查 job 状态（pause/异常翻态后本循环在下一章边界优雅停）；重入经
//   decideDeconPassReentry 跳过 done 章（AC8 断点生效——mock 计数验证 0 重复）。
//
// 范式判据（parent design §9 P1b 行）：synopsis/事件/关系/伏笔/信息差标注 = LLM（extraction
// 温 0）；分批调度 / span 定位 / 锚定核验 / 断点 / 预算 = 纯代码。
//
// expected_downstream_consumers:
// - W5 p1Aggregate / p2Canon（facts 行消费——listDeconChapterFacts 读侧）。
// - child B P3 计量（info_gap 统计纯代码消费 F-08 / kernels 名场面候选）。

// ── 常量（推测值起步——dogfood 首本标定）──

/** 段字符预算（mirror CRAFT_DISTILL_SEGMENT_CHAR_LIMIT=18000——10.2 同款预算自治，单侧改动须同步彼侧注记）。 */
export const DECON_P1B_SEGMENT_CHAR_LIMIT = 18_000;

/**
 * 每段 facts 输出 token 预算（**独立核算**——E10.2a CR-2 配套纪律）：18k 字段按密度上限估
 * ~40-60 条 × 80-150 tokens/条（what/hint/kind + 引文 + paraRange）≈ 6-9k，10240 含余量。
 * 截断由 finishReason='length' 权威挂起（不落半程产物——保义红线）。
 */
export const DECON_P1B_FACTS_MAX_TOKENS = 10_240;

/** 前章 synopsis 滑窗宽度（AI-Reader ContextSummaryBuilder 模式的窗口参数——推测值 dogfood 标定）。 */
export const DECON_P1B_PREV_SYNOPSIS_WINDOW = 3;

/**
 * 每段条目数上限（幻觉闸门族—— runaway 输出防护）：六段条目合计超限 → unit 失败诚实挂起
 * （不静默截断条目，mirror 10.2 MAX_CLAIMS_PER_MATERIAL=200 哲学；阈值按密度换算放宽）。
 */
export const DECON_P1B_MAX_ITEMS_PER_SEGMENT = 300;

/**
 * 章级 synopsis 句数上限（CR-14b——「一句-三句」契约）：多段章的段 synopsis 合并后超 3 句
 * 截断（丢弃句计数入 stats.synopsisSentencesDropped），不静默破坏两级摘要范式的章级输入形状。
 */
export const DECON_P1B_SYNOPSIS_MAX_SENTENCES = 3;

/**
 * 段 synopsis 合并压回「一句-三句」契约（纯函数——句末标点切分保留标点，取前 N 句；无标点
 * 尾段并作一句）。返回合并 synopsis + 被截掉的句数（0 = 未截）。
 */
export function capDeconSynopsisToContract(parts: readonly string[]): { synopsis: string; droppedSentences: number } {
  const sentences = parts
    .join('\n')
    .split(/(?<=[。！？!?])|\n/) // 句末标点后切段；段间换行也切段（无标点段不粘连）
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const kept = sentences.slice(0, DECON_P1B_SYNOPSIS_MAX_SENTENCES);
  return {
    synopsis: kept.join(''),
    droppedSentences: Math.max(0, sentences.length - kept.length),
  };
}

// ── 章分段（纯代码——mirror 10.2 buildExtractSegments 单章版）──

export interface DeconP1bSegment {
  blockStart: number;
  blockEnd: number;
}

/**
 * 章内分段：与章 [charStart, charEnd) 相交的段落块范围内，按块边界装箱 ≤ 段字符预算（单块超限
 * 保持整段不硬截——LLM 输入大但截断防御在输出侧 finishReason）。章无相交块 → 空数组（调用方
 * 诚实挂起）。块基面 = 全文档 splitParagraphBlocks（mat-chapter 标记行不占号——章界与段号
 * 跨层对齐，10.1 纪律）。
 */
export function buildChapterSegments(
  blocks: readonly MaterialParagraphBlock[],
  chapter: { charStart: number; charEnd: number },
): DeconP1bSegment[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.end > chapter.charStart && blocks[i]!.start < chapter.charEnd) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return [];
  const segments: DeconP1bSegment[] = [];
  let start = first;
  let len = 0;
  for (let i = first; i <= last; i++) {
    const blockLen = blocks[i]!.end - blocks[i]!.start;
    if (len > 0 && len + blockLen > DECON_P1B_SEGMENT_CHAR_LIMIT) {
      segments.push({ blockStart: start, blockEnd: i });
      start = i;
      len = 0;
    }
    len += blockLen;
  }
  segments.push({ blockStart: start, blockEnd: last + 1 });
  return segments;
}

// ── LLM 输出契约（段级 paraRange+quote 形态——纯代码映射成 span 后才进 facts）──

/** LLM 引用段落区间（半开区间，全局段号——【P 段号】标记即全档坐标，F-16 零偏移换算）。 */
export interface DeconParaRange {
  start: number;
  end: number;
}

interface DeconRawAnchored {
  paraRange: DeconParaRange;
  quote: string;
}

export interface DeconFactsSegmentOutput {
  synopsis: string;
  entities: Array<{ name: string; type: DeconEntityType } & DeconRawAnchored>;
  events: Array<{ what: string; kernel?: boolean } & DeconRawAnchored>;
  relationshipEdges: Array<{ from: string; to: string; kind: string } & DeconRawAnchored>;
  foreshadowPlanted: Array<{ hint: string } & DeconRawAnchored>;
  infoGap: Array<{ type: DeconInfoGapType } & DeconRawAnchored>;
}

/**
 * 解析段级 facts 响应（**条目级容错**，mirror 10.2 切条口径拆分）：顶层坏（无 JSON 对象 /
 * synopsis 缺失空白）→ null 整体拒收；条目坏形状（缺 name/quote、坏 paraRange、枚举集外 type）
 * → 丢该条 + droppedMalformed 计数（坏形状 ≠ 无锚，锚定通过率不失真）。键名与持久契约同形
 * （camelCase——W1 deconFactsSchema 单源命名）。
 */
export function parseDeconFactsSegmentResponse(
  raw: string,
): { output: DeconFactsSegmentOutput; droppedMalformed: number; itemCount: number } | null {
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
  if (typeof o.synopsis !== 'string' || o.synopsis.trim().length === 0) return null;

  let dropped = 0;
  const takeStr = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);
  const takeParaRange = (v: unknown): DeconParaRange | null => {
    if (v === null || typeof v !== 'object') return null;
    const pr = v as Record<string, unknown>;
    if (typeof pr.start !== 'number' || !Number.isInteger(pr.start) || pr.start < 0) return null;
    if (typeof pr.end !== 'number' || !Number.isInteger(pr.end) || pr.end < 0) return null;
    return { start: pr.start, end: pr.end };
  };

  const entities: DeconFactsSegmentOutput['entities'] = [];
  const events: DeconFactsSegmentOutput['events'] = [];
  const relationshipEdges: DeconFactsSegmentOutput['relationshipEdges'] = [];
  const foreshadowPlanted: DeconFactsSegmentOutput['foreshadowPlanted'] = [];
  const infoGap: DeconFactsSegmentOutput['infoGap'] = [];

  if (Array.isArray(o.entities)) {
    for (const el of o.entities) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const name = r === null ? null : takeStr(r.name);
      const type = r === null ? null : takeStr(r.type);
      const paraRange = r === null ? null : takeParaRange(r.paraRange);
      const quote = r === null ? null : takeStr(r.quote);
      if (
        name === null ||
        paraRange === null ||
        quote === null ||
        type === null ||
        !(DECON_ENTITY_TYPE_SET as ReadonlySet<string>).has(type)
      ) {
        dropped += 1;
        continue;
      }
      entities.push({ name, type: type as DeconEntityType, paraRange, quote });
    }
  }
  if (Array.isArray(o.events)) {
    for (const el of o.events) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const what = r === null ? null : takeStr(r.what);
      const paraRange = r === null ? null : takeParaRange(r.paraRange);
      const quote = r === null ? null : takeStr(r.quote);
      const kernel = r !== null && r.kernel === true;
      if (what === null || paraRange === null || quote === null) {
        dropped += 1;
        continue;
      }
      events.push({ what, ...(kernel ? { kernel: true } : {}), paraRange, quote });
    }
  }
  if (Array.isArray(o.relationshipEdges)) {
    for (const el of o.relationshipEdges) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const from = r === null ? null : takeStr(r.from);
      const to = r === null ? null : takeStr(r.to);
      const kind = r === null ? null : takeStr(r.kind);
      const paraRange = r === null ? null : takeParaRange(r.paraRange);
      const quote = r === null ? null : takeStr(r.quote);
      if (from === null || to === null || kind === null || paraRange === null || quote === null) {
        dropped += 1;
        continue;
      }
      relationshipEdges.push({ from, to, kind, paraRange, quote });
    }
  }
  if (Array.isArray(o.foreshadowPlanted)) {
    for (const el of o.foreshadowPlanted) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const hint = r === null ? null : takeStr(r.hint);
      const paraRange = r === null ? null : takeParaRange(r.paraRange);
      const quote = r === null ? null : takeStr(r.quote);
      if (hint === null || paraRange === null || quote === null) {
        dropped += 1;
        continue;
      }
      foreshadowPlanted.push({ hint, paraRange, quote });
    }
  }
  if (Array.isArray(o.infoGap)) {
    for (const el of o.infoGap) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const type = r === null ? null : takeStr(r.type);
      const paraRange = r === null ? null : takeParaRange(r.paraRange);
      const quote = r === null ? null : takeStr(r.quote);
      if (type === null || paraRange === null || quote === null || !(DECON_INFO_GAP_SET as ReadonlySet<string>).has(type)) {
        dropped += 1;
        continue;
      }
      infoGap.push({ type: type as DeconInfoGapType, paraRange, quote });
    }
  }

  return {
    output: { synopsis: o.synopsis, entities, events, relationshipEdges, foreshadowPlanted, infoGap },
    droppedMalformed: dropped,
    itemCount: entities.length + events.length + relationshipEdges.length + foreshadowPlanted.length + infoGap.length,
  };
}

const DECON_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(DECON_ENTITY_TYPES);
const DECON_INFO_GAP_SET: ReadonlySet<string> = new Set(DECON_INFO_GAP_TYPES);

// ── 锚定核验（无锚即丢第二道保险——纯代码）──

/** 空白归一（10.2 stripWhitespace 同式——LLM 引文空白抖动不误杀）。 */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 引文子串判定（空白归一后包含即命中；空引文不命中——mirror 10.2 isQuoteInSpan）。
 * E10.3b W1 导出——B 的 P3a/P4/P6 锚定双核验复用（私有→导出，零行为变更）。
 */
export function isQuoteInSpan(quote: string, spanText: string): boolean {
  const q = stripWhitespace(quote);
  return q.length > 0 && stripWhitespace(spanText).includes(q);
}

/**
 * paraRange → span 映射 + 集内核验（镜像 10.2 双核验第一道）：引用段号须落在注入段的
 * 全局段号范围内且 start<end（集外/退化 = 编造 span）→ null。charStart/charEnd = 块区间
 * 全文档坐标（与 10.2 craftTeachingAnchor 同基同形）。
 */
export function buildDeconAnchor(
  paraRange: DeconParaRange,
  segment: DeconP1bSegment,
  blocks: readonly MaterialParagraphBlock[],
  chapterIndex: number,
): DeconSpan | null {
  const s = paraRange.start;
  const e = paraRange.end;
  if (!(s >= segment.blockStart && e <= segment.blockEnd && s < e)) return null;
  return {
    chapterIndex,
    charStart: blocks[s]!.start,
    charEnd: blocks[e - 1]!.end,
    paraStart: s,
    paraEnd: e,
  };
}

// ── prompt 装配（纯函数，导出供直测/断言）──

export const DECON_P1B_SYSTEM_PROMPT = [
  '你是小说拆解的事实层提取器，为一本小说逐章提取「作者需要的素材」（供后续拆书分析用，非读者向摘要）。',
  '仅基于提供的文本作答；不要使用任何工具（联网搜索、命令执行、浏览器等）——本环境不提供工具，调用工具会导致失败。',
  '只依据给定正文，禁止编造正文中不存在的内容。每章输出一个 JSON 对象，字段：',
  '- synopsis：本章情节概要，一到三句话；',
  '- entities：本章出现的实体，数组元素 {"name","type","paraRange","quote"}——type ∈ person/place/item/organization/concept；name 优先使用【实体词典】中的名字写法（跨章保持一致，便于归并）；词典没有的新实体也提取；',
  '- events：事件，元素 {"what","paraRange","quote","kernel"}——what 一句话；kernel=true 表示核心事件（判据：删掉该事件，故事主线是否断裂），非核心事件省略 kernel 字段；',
  '- relationshipEdges：实体间关系，元素 {"from","to","kind","paraRange","quote"}——from/to 用实体名，kind 一个短词（如 师徒/敌对/同盟）；',
  '- foreshadowPlanted：伏笔埋点，元素 {"hint","paraRange","quote"}——只记本章埋下的伏笔，不记回收；',
  '- infoGap：信息差标注，元素 {"type","paraRange","quote"}——type 只能取以下六型之一：爽感预期/信息前置/悬疑未知/方法预期/全知巧合/主观误导。',
  'paraRange = {"start":段号,"end":段号}（半开区间），段号只能引用输入中实际出现的段落号；quote = 该段落区间内的原文逐字摘录（不得改写、不得拼接不同位置的文字）。',
  '每条都必须给出 paraRange 和 quote——给不出正文位置的条目会被直接丢弃，宁缺毋滥。',
  '输出纯 JSON 对象，不要任何解释或前后缀。',
].join('\n');

export interface DeconFactsUserPromptInput {
  dictionaryEntries: readonly DeconDictionaryEntry[];
  prevSynopses: readonly string[];
  derived: string;
  blocks: readonly MaterialParagraphBlock[];
  segment: DeconP1bSegment;
}

/** 逐章 user prompt（词典全量 + 前章 synopsis 滑窗 + 【P 全局段号】标记正文）。 */
export function buildDeconFactsUserPrompt(input: DeconFactsUserPromptInput): string {
  const dictLines = input.dictionaryEntries.map((e) => `${e.name} | ${e.type}`);
  const numbered: string[] = [];
  for (let i = input.segment.blockStart; i < input.segment.blockEnd; i++) {
    numbered.push(`【P${i}】${input.derived.slice(input.blocks[i]!.start, input.blocks[i]!.end)}`);
  }
  return [
    ...(dictLines.length > 0
      ? ['【实体词典（name | type）——提取实体时优先使用词典内名字写法（跨章一致）】', ...dictLines, '']
      : ['【实体词典为空——照常提取实体，name 用正文原词】', '']),
    ...(input.prevSynopses.length > 0 ? ['【前情概要（最近各章 synopsis，仅供上下文理解，不是本章内容）】', ...input.prevSynopses, ''] : []),
    '【本章正文（【P段落号】标记每段开始；段落号是全文档全局编号）】',
    numbered.join('\n\n'),
    `（本片段段落号范围 P${input.segment.blockStart}–P${input.segment.blockEnd - 1}；paraRange 只能引用该范围内实际出现的段落号）`,
  ].join('\n');
}

// ── P1b 编排（逐章循环——断点/预算/锚定核验/同事务落库）──

export interface DeconP1bStats {
  chapters: number;
  skipped: number;
  extracted: number;
  droppedNoAnchor: number;
  droppedMalformed: number;
  /** 纯标记/空白章跳过数（CR-15——章区间与派生 .md 段落块不相交，不可提取不 fail 整 pass）。 */
  emptySegmentChapters: number;
  /** synopsis 压回「一句-三句」契约时截掉的句数（CR-14b——多段章合并超限）。 */
  synopsisSentencesDropped: number;
}

export type DeconP1bResult =
  | { status: 'done'; stats: DeconP1bStats }
  | { status: 'paused'; stats: DeconP1bStats }
  | { status: 'cancelled'; stats: DeconP1bStats }
  | { status: 'capped'; message: string; stats: DeconP1bStats }
  | { status: 'failed'; message: string; stats: DeconP1bStats }
  | { status: 'stale'; message: string };

export interface DeconP1bDeps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  /** 逐章 running 进度事件注入（CR-8——runDeconPassSequence 传 stamped notify；直调测试缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
  /** 材料读重试等待注入（C4-F12——测试零延迟；缺省 ~1s×10 实时钟）。 */
  waitMs?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function emptyStats(chapters: number): DeconP1bStats {
  return {
    chapters,
    skipped: 0,
    extracted: 0,
    droppedNoAnchor: 0,
    droppedMalformed: 0,
    emptySegmentChapters: 0,
    synopsisSentencesDropped: 0,
  };
}

/** 边界/门停走映射（CR-7——paused/cancelled/stale 如实，其余 failed）。 */
function boundaryToP1bResult(stop: DeconBoundaryStop, stats: DeconP1bStats): DeconP1bResult {
  if (stop.status === 'paused') return { status: 'paused', stats };
  if (stop.status === 'cancelled') return { status: 'cancelled', stats };
  return { status: stop.status, message: stop.message, stats };
}

/**
 * 跑 P1b（pass='p1b'，unit=章号）。章序 = material.chapters 登记序；每章：
 * 断点重入（done+hash 一致 skip）→ 分段 → 段内串行（预算门前置——超限 capped 不烧 token；
 * finishReason='length' 挂起不落半程产物）→ 锚定核验（集外/引文不匹配丢条计数）→ 六段合并
 * （synopsis 压回一句-三句契约 CR-14b）→ facts + pass_state done 同事务落库。任意章边界感知
 * pause/cancel（CR-7 如实映射）；每章发 running 进度事件（CR-8——千章级小时静默防线）。
 * 词典/LLM 内核为**惰性判定**（CR-10——重入检查之后：继承 facts 全 done 的 job 不因词典
 * 缺失/内核未装配误 fail）。
 */
export async function runDeconP1b(jobId: string, deps: DeconP1bDeps = {}): Promise<DeconP1bResult> {
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

  // C4-F12：材料读点有限重试（中间态零章等重索引收敛；真删除/终局零章诚实失败）。
  // C4-F16 写侧：材料级前置失败只 transitionDeconJob——job 行 error 已承载错误面，
  // 不写 ('p1b','all',failed) pass_state 化石行（'all' 非 p1b 合法 unit）。
  const loaded = await loadExtractableMaterial(extractMaterialId(job.materialRef), { waitMs: deps.waitMs });
  if (!loaded.ok) {
    transitionDeconJob(jobId, 'fail', loaded.message);
    return { status: 'failed', message: loaded.message, stats: emptyStats(0) };
  }
  const material = loaded.material;
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    const message = '派生 .md 读取失败（缺失或车道不可解析）——无法锚定 facts 基面';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: emptyStats(material.chapters.length) };
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }

  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    const message = '材料无有效段落（派生 .md 全空白）——不可提取';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: emptyStats(material.chapters.length) };
  }

  // C5：chapterIndex → 真实章标行映射（失败 note 的章号展示不再 index 算术——F19）。
  const headings = buildDeconChapterHeadings(derived, material.chapters);
  const chLabel = (chapterIndex: number): string => deconChapterShortLabel(headings.get(chapterIndex), chapterIndex);

  // synopsis 滑窗底座：既有 facts（继承/前次完成章）供窗；本章完成后回填。
  const synopses = new Map<number, string>();
  for (const row of listDeconChapterFacts(job.materialRef, job.derivedHash)) {
    synopses.set(row.chapterIndex, row.facts.synopsis);
  }

  // 惰性资源面（CR-10）：词典 / LLM 内核只在确有章需要提取时判定加载——继承 facts 全 done
  // 的重入不因资源缺失误 fail（原有前置检查让 IPC 面走不通）。
  let dictionaryLazy: DeconDictionary | null | undefined;
  const requireDictionary = (): DeconDictionary | null => {
    if (dictionaryLazy === undefined) dictionaryLazy = getDeconDictionary(job.materialRef, job.derivedHash);
    return dictionaryLazy;
  };
  let generate: DeconGenerateText | undefined;

  const stats: DeconP1bStats = {
    chapters: material.chapters.length,
    skipped: 0,
    extracted: 0,
    droppedNoAnchor: 0,
    droppedMalformed: 0,
    emptySegmentChapters: 0,
    synopsisSentencesDropped: 0,
  };
  let cost = job.cost;

  for (const chapter of material.chapters) {
    // 中断韧性（CR-7）：任意章边界如实判别 pause/cancel/外部翻态（旧实现一律误报 paused）。
    const stop = checkDeconRunBoundary(jobId);
    if (stop !== null) return boundaryToP1bResult(stop, stats);

    const unit = String(chapter.index);
    // CR-8：逐章 running 事件（best-effort——notify 注入缺省不发；成本一行对象可忽略）。
    deps.notify?.({ jobId, status: 'running', pass: 'p1b', unit });
    const existing = getDeconChapterFacts(job.materialRef, job.derivedHash, chapter.index);
    const state = getDeconPassState(jobId, 'p1b', unit);
    const decision = decideDeconPassReentry(
      state,
      existing === null ? null : hashDeconFactsOutput(existing.facts),
    );
    if (decision === 'skip') {
      stats.skipped += 1;
      continue;
    }
    // rerun / capped-hold → 本次尝试（capped-hold 经下方预算门再判：预算已调大则放行，仍超则再 cap）。

    const failUnit = (message: string): { status: 'failed'; message: string; stats: DeconP1bStats } => {
      failDeconUnit(jobId, 'p1b', unit, message, nowIso());
      return { status: 'failed', message, stats };
    };

    // 惰性资源判定（CR-10）——首章确需提取时才 fail（重入全 skip 的 job 零资源依赖）。
    if (generate === undefined) {
      generate = deps.generateText ?? getDeconLlmCore()?.generateText;
      if (generate === undefined) {
        return failUnit('拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试');
      }
    }
    const dictionary = requireDictionary();
    if (dictionary === null) {
      return failUnit('实体词典不存在（closure_decon_dictionary 无同指纹行）——先跑 P1a 再跑 P1b');
    }

    const segments = buildChapterSegments(blocks, chapter);
    if (segments.length === 0) {
      // CR-15：纯标记章/空白章跳过 + 计数——不 fail 整个 p1b 与 job（重跑此章零 LLM 调用，
      // 幂等廉价；不落 facts 行——空 synopsis 违契约会污染滑窗）。
      stats.emptySegmentChapters += 1;
      getLogger().warn(
        { jobId, chapterIndex: chapter.index },
        'decon p1b: chapter has no extractable segments (marker-only or blank) - skipped without failing the pass',
      );
      continue;
    }

    writeDeconPassState(jobId, 'p1b', unit, 'running', null, nowIso());

    const droppedBefore = stats.droppedNoAnchor; // 章级日志口径（delta——stats 本体是全章累计）
    const mergedSynopsis: string[] = [];
    const mergedEntities: DeconFacts['entities'] = [];
    const mergedEvents: DeconFacts['events'] = [];
    const mergedEdges: DeconFacts['relationshipEdges'] = [];
    const mergedForeshadow: DeconFacts['foreshadowPlanted'] = [];
    const mergedInfoGap: DeconFacts['infoGap'] = [];

    for (const segment of segments) {
      const user = buildDeconFactsUserPrompt({
        dictionaryEntries: dictionary.entries,
        prevSynopses: windowSynopses(synopses, chapter.index, chLabel),
        derived,
        blocks,
        segment,
      });
      // C3：预算门→调用→记账→length 判定→升帽重试一次（脚手架单源）；截断仍挂 = failed
      // （facts 含 synopsis 语义面——半程产物不可续，mirror 旧语义）。
      const call = await runDeconLlmCall({
        jobId,
        pass: 'p1b',
        unit,
        slot: 'extraction',
        system: DECON_P1B_SYSTEM_PROMPT,
        user,
        maxTokens: DECON_P1B_FACTS_MAX_TOKENS,
        budget: job.budget,
        cost,
        job,
        generate,
        notify: deps.notify,
        nowIso,
        label: `p1b ${chLabel(chapter.index)}提取`,
      });
      if (!call.ok) {
        if (call.kind === 'budget-capped') {
          capDeconUnit(jobId, 'p1b', unit, call.note, nowIso());
          return { status: 'capped', message: call.note, stats };
        }
        if (call.kind === 'length') {
          return failUnit(`${call.note}——已挂起，不落半程产物`);
        }
        return failUnit(call.note); // error / empty（脚手架已记账已判空）
      }
      const text = call.text;
      cost = call.cost;
      const parsed = parseDeconFactsSegmentResponse(text);
      if (parsed === null) {
        return failUnit(`${chLabel(chapter.index)}提取输出不可解析为 JSON 对象——整体拒收（不硬给 facts）`);
      }
      stats.droppedMalformed += parsed.droppedMalformed;
      if (parsed.itemCount > DECON_P1B_MAX_ITEMS_PER_SEGMENT) {
        return failUnit(
          `${chLabel(chapter.index)}提取条目数 ${parsed.itemCount} 超过上限 ${DECON_P1B_MAX_ITEMS_PER_SEGMENT}——为避免静默截断已挂起（材料可能异常，请人工检查）`,
        );
      }

      // 锚定核验（F-15 第二道保险）：paraRange 集外（编造 span）或引文不在 span 文本（编造引文）
      // → 丢该条 + 计数。核验基面 = 派生 .md 原文（章内段落块文本）。
      mergedSynopsis.push(parsed.output.synopsis);
      for (const e of parsed.output.entities) {
        const span = buildDeconAnchor(e.paraRange, segment, blocks, chapter.index);
        if (span === null || !isQuoteInSpan(e.quote, derived.slice(span.charStart, span.charEnd))) {
          stats.droppedNoAnchor += 1;
          continue;
        }
        mergedEntities.push({ name: e.name, type: e.type, span });
      }
      for (const e of parsed.output.events) {
        const span = buildDeconAnchor(e.paraRange, segment, blocks, chapter.index);
        if (span === null || !isQuoteInSpan(e.quote, derived.slice(span.charStart, span.charEnd))) {
          stats.droppedNoAnchor += 1;
          continue;
        }
        mergedEvents.push({ what: e.what, ...(e.kernel === true ? { kernel: true } : {}), span });
      }
      for (const e of parsed.output.relationshipEdges) {
        const span = buildDeconAnchor(e.paraRange, segment, blocks, chapter.index);
        if (span === null || !isQuoteInSpan(e.quote, derived.slice(span.charStart, span.charEnd))) {
          stats.droppedNoAnchor += 1;
          continue;
        }
        mergedEdges.push({ from: e.from, to: e.to, kind: e.kind, span });
      }
      for (const e of parsed.output.foreshadowPlanted) {
        const span = buildDeconAnchor(e.paraRange, segment, blocks, chapter.index);
        if (span === null || !isQuoteInSpan(e.quote, derived.slice(span.charStart, span.charEnd))) {
          stats.droppedNoAnchor += 1;
          continue;
        }
        mergedForeshadow.push({ hint: e.hint, span });
      }
      for (const e of parsed.output.infoGap) {
        const span = buildDeconAnchor(e.paraRange, segment, blocks, chapter.index);
        if (span === null || !isQuoteInSpan(e.quote, derived.slice(span.charStart, span.charEnd))) {
          stats.droppedNoAnchor += 1;
          continue;
        }
        mergedInfoGap.push({ type: e.type, span });
      }
    }

    // 多段章 synopsis 合并压回「一句-三句」契约（CR-14b——超限截断 + 计数）。
    const synopsisCapped = capDeconSynopsisToContract(mergedSynopsis);
    stats.synopsisSentencesDropped += synopsisCapped.droppedSentences;
    const candidateFacts = {
      synopsis: synopsisCapped.synopsis,
      entities: mergedEntities,
      events: mergedEvents,
      relationshipEdges: mergedEdges,
      foreshadowPlanted: mergedForeshadow,
      infoGap: mergedInfoGap,
    };
    const validated = deconFactsSchema.safeParse(candidateFacts);
    if (!validated.success) {
      return failUnit(`${chLabel(chapter.index)}合并 facts 未过契约校验（内部错误——锚定映射与契约漂移，请报告）`);
    }
    const facts = validated.data;

    // 落库（产物 + pass_state done 同事务——崩溃不留半状态）。
    const outputHash = hashDeconFactsOutput(facts);
    getDb().transaction(() => {
      upsertDeconChapterFacts({
        materialRef: job.materialRef,
        derivedHash: job.derivedHash,
        chapterIndex: chapter.index,
        facts,
      });
      upsertDeconPassState({
        jobId,
        pass: 'p1b',
        unit,
        status: 'done',
        outputRef: `facts:${chapter.index}`,
        outputHash,
        updatedAt: nowIso(),
      });
    })();
    if (stats.droppedNoAnchor > droppedBefore) {
      getLogger().warn(
        { jobId, chapterIndex: chapter.index, droppedNoAnchor: stats.droppedNoAnchor - droppedBefore },
        'decon p1b: items dropped for missing anchor (fabricated paraRange or quote) - no-anchor-no-keep discipline',
      );
    }
    synopses.set(chapter.index, facts.synopsis);
    stats.extracted += 1;
  }

  return { status: 'done', stats };
}

/**
 * 前章 synopsis 滑窗（最近 N 章——按章号顺序取 < 当前章的已有 synopsis）。行标签 = 真实章标
 * 短标签（C5/F19——滑窗行直接进 P1b prompt，零序号算术：无章标章语义回落标签）。
 */
function windowSynopses(
  synopses: ReadonlyMap<number, string>,
  chapterIndex: number,
  chapterLabel: (chapterIndex: number) => string,
): string[] {
  const out: string[] = [];
  for (let i = Math.max(0, chapterIndex - DECON_P1B_PREV_SYNOPSIS_WINDOW); i < chapterIndex; i++) {
    const s = synopses.get(i);
    if (s !== undefined) out.push(`${chapterLabel(i)}：${s}`);
  }
  return out;
}
