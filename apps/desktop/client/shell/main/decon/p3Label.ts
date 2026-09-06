import type {
  DeconChapterLabels,
  DeconDictionaryEntry,
  DeconEmotionalBeat,
  DeconHookType,
  DeconJob,
  DeconPlotPhase,
  DeconProgressEvent,
  DeconSpan,
  DeconTransitionType,
  Material,
} from '@orison/shared-contracts';
import {
  DECON_EMOTIONAL_BEATS,
  DECON_HOOK_TYPES,
  DECON_PLOT_PHASES,
  DECON_TRANSITION_TYPES,
  deconChapterLabelsSchema,
} from '@orison/shared-contracts';
import { getDb } from '../db/index';
import { getDeconDictionary, getDeconPassState, getDeconProduct, upsertDeconProduct } from '../db/closure-decon';
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
import { accumulateDeconCost, wouldExceedDeconBudget } from './deconBudget';
import { decideDeconPassReentry, extractMaterialId, transitionDeconJob } from './deconJob';
import { buildChapterSegments, buildDeconAnchor, isQuoteInSpan, type DeconParaRange, type DeconP1bSegment } from './p1Extract';

// ── E10.3b（task 09-05）W2：P3a LLM 打标（child B design §2——打标的手 / 算数的账之手）──
//
// 逐章循环产出 deconChapterLabelsSchema（钩子 11 型 / 转折 9 型 / 情绪 7 拍 / 四相位 /
// 爽点段 / 设定段 / 弧界候选）——**span 级轻枚举事实标记**；归因型判断（转折深归类 /
// 埋-收配对 / 变奏对）归 P4 问题单。信息差**不重打**（F-08——P3b 统计直接消费 P1b
// infoGap）。slot = extraction 温 0（打标是判别面非创作，parent design §4）。
//
// 结构 mirror p1Extract（A 的 runner 样本）：章循环 / 断点 output_hash 门控（skip 零重付）/
// 预算门前置（超限 capped 不烧 token）/ finishReason='length' 权威挂起（P3a 走 capped——
// 输出预算型截断，调预算可续；p1b 同信号走 failed 因其含 synopsis 语义面，本处纯枚举
// 重打廉价）/ 锚定双核验（buildDeconAnchor paraRange 集外 + isQuoteInSpan 引文匹配，
// 无锚即丢+计数）/ 逐章 running 事件（CR-8）。
//
// 产物落 closure_decon_product（pass='p3a'，unit=章号字符串）+ pass_state done 同事务
// （写侧 zod 门在 upsertDeconProduct——hash 同基纪律：output_hash 取落库 payload 的
// JSON 序列化面，与读侧重入比对同基，防「章永久重烧」）。
//
// 范式判据（parent design §9 P3 行）：打标 = LLM；分段调度 / span 定位 / 锚定核验 /
// 断点 / 预算 = 纯代码。
//
// expected_downstream_consumers:
// - W2 p3Metrics（labels 读回 product 表——弧切分候选聚合 + 统计族输入）。
// - W3b p4Craft（章级问题单预注——省重推导 + 增 grounding）/ W4 p5Output（章评标签注入）。

// ── 常量（推测值起步——dogfood 首本标定）──

/**
 * 每章打标输出 token 预算（**独立核算**——E10.2a CR-2 配套纪律）：span 级轻枚举
 * ~40-80 条 × 30-50 tokens（type + paraRange + 短引文）≈ 1.6-4k，6144 含余量。截断由
 * finishReason='length' 权威挂起（capped——不落半程产物）。
 */
export const DECON_P3A_LABELS_MAX_TOKENS = 6_144;

/**
 * 每章条目数上限（幻觉闸门族）：五段条目**合计**超限 → unit 失败诚实挂起（不静默截断条目，
 * mirror p1b DECON_P1B_MAX_ITEMS_PER_SEGMENT 哲学；打标密度低于 facts，同一量级保守值）。
 * 🔑 CR-5：检查面在**段合并后的章总量**（对齐契约注释「段合计超限→unit 失败」+ P4 合并检查
 * 同语义）——长章分段各 ≤ 帽不再落 2-N 倍帽；段内单发超限仍提前拦（省后续段 LLM 费）。
 */
export const DECON_P3A_MAX_ITEMS_PER_CHAPTER = 300;

// ── LLM 输出契约（段级 paraRange+quote 形态——纯代码映射成 span 后才进 labels）──

/** 打标条目（段级——锚定核验前的 LLM 原始形态）。 */
export interface DeconRawLabelItem {
  paraRange: DeconParaRange;
  quote: string;
}

export interface DeconLabelsSegmentOutput {
  hooks: Array<{ type: DeconHookType | 'other' } & DeconRawLabelItem>;
  transitions: Array<{ type: DeconTransitionType | 'other' } & DeconRawLabelItem>;
  emotionalBeats: Array<{ beat: DeconEmotionalBeat } & DeconRawLabelItem>;
  plotPhase: DeconPlotPhase | null;
  highlightSpans: DeconRawLabelItem[];
  expositionSpans: DeconRawLabelItem[];
  arcBoundary: { isCandidate: boolean; confidence: number; signal?: string } | null;
}

const DECON_HOOK_LABEL_SET: ReadonlySet<string> = new Set([...DECON_HOOK_TYPES, 'other']);
const DECON_TRANSITION_LABEL_SET: ReadonlySet<string> = new Set([...DECON_TRANSITION_TYPES, 'other']);
const DECON_EMOTIONAL_BEAT_SET: ReadonlySet<string> = new Set(DECON_EMOTIONAL_BEATS);
const DECON_PLOT_PHASE_SET: ReadonlySet<string> = new Set(DECON_PLOT_PHASES);

/**
 * 解析段级打标响应（**条目级容错**，mirror p1Extract parseDeconFactsSegmentResponse）：
 * 顶层坏（无 JSON 对象 / 七字段全缺——模型无视输出契约）→ null 整体拒收；条目坏形状
 * （坏 paraRange / 缺 quote / 枚举集外 type·beat / 坏 arcBoundary）→ 丢该条 + 计数
 * droppedMalformed（坏形状 ≠ 无锚，锚定通过率不失真）。
 */
export function parseDeconLabelsSegmentResponse(
  raw: string,
): { output: DeconLabelsSegmentOutput; droppedMalformed: number; itemCount: number } | null {
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
  const KNOWN_KEYS = [
    'hooks',
    'transitions',
    'emotionalBeats',
    'plotPhase',
    'highlightSpans',
    'expositionSpans',
    'arcBoundary',
  ] as const;
  if (!KNOWN_KEYS.some((k) => k in o)) return null;

  let dropped = 0;
  const takeStr = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);
  const takeParaRange = (v: unknown): DeconParaRange | null => {
    if (v === null || typeof v !== 'object') return null;
    const pr = v as Record<string, unknown>;
    if (typeof pr.start !== 'number' || !Number.isInteger(pr.start) || pr.start < 0) return null;
    if (typeof pr.end !== 'number' || !Number.isInteger(pr.end) || pr.end < 0) return null;
    return { start: pr.start, end: pr.end };
  };
  const takeAnchored = (v: unknown): DeconRawLabelItem | null => {
    if (v === null || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    const paraRange = takeParaRange(r.paraRange);
    const quote = takeStr(r.quote);
    if (paraRange === null || quote === null) return null;
    return { paraRange, quote };
  };

  const hooks: DeconLabelsSegmentOutput['hooks'] = [];
  const transitions: DeconLabelsSegmentOutput['transitions'] = [];
  const emotionalBeats: DeconLabelsSegmentOutput['emotionalBeats'] = [];
  const highlightSpans: DeconRawLabelItem[] = [];
  const expositionSpans: DeconRawLabelItem[] = [];

  if (Array.isArray(o.hooks)) {
    for (const el of o.hooks) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const anchored = r === null ? null : takeAnchored(r);
      const type = r === null ? null : takeStr(r.type);
      if (anchored === null || type === null || !(DECON_HOOK_LABEL_SET as ReadonlySet<string>).has(type)) {
        dropped += 1;
        continue;
      }
      hooks.push({ type: type as DeconHookType | 'other', ...anchored });
    }
  }
  if (Array.isArray(o.transitions)) {
    for (const el of o.transitions) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const anchored = r === null ? null : takeAnchored(r);
      const type = r === null ? null : takeStr(r.type);
      if (anchored === null || type === null || !(DECON_TRANSITION_LABEL_SET as ReadonlySet<string>).has(type)) {
        dropped += 1;
        continue;
      }
      transitions.push({ type: type as DeconTransitionType | 'other', ...anchored });
    }
  }
  if (Array.isArray(o.emotionalBeats)) {
    for (const el of o.emotionalBeats) {
      const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
      const anchored = r === null ? null : takeAnchored(r);
      const beat = r === null ? null : takeStr(r.beat);
      if (anchored === null || beat === null || !(DECON_EMOTIONAL_BEAT_SET as ReadonlySet<string>).has(beat)) {
        dropped += 1;
        continue;
      }
      emotionalBeats.push({ beat: beat as DeconEmotionalBeat, ...anchored });
    }
  }
  if (Array.isArray(o.highlightSpans)) {
    for (const el of o.highlightSpans) {
      const anchored = takeAnchored(el);
      if (anchored === null) {
        dropped += 1;
        continue;
      }
      highlightSpans.push(anchored);
    }
  }
  if (Array.isArray(o.expositionSpans)) {
    for (const el of o.expositionSpans) {
      const anchored = takeAnchored(el);
      if (anchored === null) {
        dropped += 1;
        continue;
      }
      expositionSpans.push(anchored);
    }
  }

  let plotPhase: DeconPlotPhase | null = null;
  if ('plotPhase' in o) {
    if (o.plotPhase === null) {
      plotPhase = null;
    } else {
      const phase = takeStr(o.plotPhase);
      if (phase === null || !(DECON_PLOT_PHASE_SET as ReadonlySet<string>).has(phase)) {
        dropped += 1;
      } else {
        plotPhase = phase as DeconPlotPhase;
      }
    }
  }

  let arcBoundary: DeconLabelsSegmentOutput['arcBoundary'] = null;
  if ('arcBoundary' in o && o.arcBoundary !== null) {
    const ab = typeof o.arcBoundary === 'object' ? (o.arcBoundary as Record<string, unknown>) : null;
    const isCandidate = ab?.isCandidate;
    const confidence = ab?.confidence;
    const signal = ab === undefined || ab === null ? null : takeStr(ab.signal);
    if (
      ab === null ||
      typeof isCandidate !== 'boolean' ||
      typeof confidence !== 'number' ||
      confidence < 0 ||
      confidence > 1
    ) {
      dropped += 1;
    } else {
      arcBoundary = { isCandidate, confidence, ...(signal !== null ? { signal } : {}) };
    }
  }

  return {
    output: { hooks, transitions, emotionalBeats, plotPhase, highlightSpans, expositionSpans, arcBoundary },
    droppedMalformed: dropped,
    itemCount: hooks.length + transitions.length + emotionalBeats.length + highlightSpans.length + expositionSpans.length,
  };
}

/** 多段章合并（纯函数）：数组拼接；plotPhase 取最末非空段；arcBoundary 取置信最高的候选。 */
export function mergeDeconLabelsSegments(parts: readonly DeconLabelsSegmentOutput[]): DeconLabelsSegmentOutput {
  const merged: DeconLabelsSegmentOutput = {
    hooks: [],
    transitions: [],
    emotionalBeats: [],
    plotPhase: null,
    highlightSpans: [],
    expositionSpans: [],
    arcBoundary: null,
  };
  let bestConfidence = -1;
  for (const part of parts) {
    merged.hooks.push(...part.hooks);
    merged.transitions.push(...part.transitions);
    merged.emotionalBeats.push(...part.emotionalBeats);
    merged.highlightSpans.push(...part.highlightSpans);
    merged.expositionSpans.push(...part.expositionSpans);
    if (part.plotPhase !== null) merged.plotPhase = part.plotPhase;
    const ab = part.arcBoundary;
    if (ab !== null && ab.isCandidate && ab.confidence > bestConfidence) {
      bestConfidence = ab.confidence;
      merged.arcBoundary = ab;
    }
  }
  return merged;
}

// ── prompt 装配（纯函数，导出供直测/断言）──

export const DECON_P3A_SYSTEM_PROMPT = [
  '你是小说拆解的计量打标器，为一本小说逐章做段落级的手艺标记（供后续统计与拆书分析用）。',
  '只依据给定正文，禁止编造正文中不存在的内容。每章输出一个 JSON 对象，字段：',
  '- hooks：期待感钩子段落，元素 {"type","paraRange","quote"}——type 只能取以下 11 型之一：被迫压力钩/排行贪欲钩/人物情感钩/人前显圣钩/全村希望钩/解决能力钩/外挂神器钩/未知悬疑钩/方法掌控钩/信息前置钩/信息预期钩；识别为钩子但类型存疑用 "other"；',
  '- transitions：转折段落，元素同上——type 只能取以下 9 型之一：阻碍转折/方法转折/误导转折/偏差转折/反差转折/规则转折/目的转折/人物转折/动态转折；存疑用 "other"；',
  '- emotionalBeats：情绪动态拍，元素 {"beat","paraRange","quote"}——beat 只能取 7 拍之一：拉扯/推动/上行/下行/起伏/持续动态/层层递进；',
  '- plotPhase：本章主导相位，只能取 拉仇恨/积蓄/释放/落袋为安 之一；无明确主导相位用 null；',
  '- highlightSpans：爽点段落，元素 {"paraRange","quote"}；',
  '- expositionSpans：设定说明段落（世界观/规则/能力体系的讲解段），元素同上；',
  '- arcBoundary：本章是否像新剧情段（一大段完整故事弧）的起点，值 {"isCandidate":true/false,"confidence":0到1的小数,"signal":"简短理由"}；不像用 null。',
  'paraRange = {"start":段号,"end":段号}（半开区间），段号只能引用输入中实际出现的段落号；quote = 该段落区间内的原文逐字摘录（可截取有代表性的一句，不得改写、不得拼接不同位置的文字）。',
  '每条都必须给出 paraRange 和 quote——给不出正文位置的条目会被直接丢弃，宁缺毋滥。',
  '只标记正文确证的段落，不猜测作者意图、不脑补。',
  '输出纯 JSON 对象，不要任何解释或前后缀。',
].join('\n');

export interface DeconP3aUserPromptInput {
  /** 词典条目（可选注入——null = 无词典不注入块；打标不强依赖实体名，缺词典照常）。 */
  dictionaryEntries: readonly DeconDictionaryEntry[] | null;
  derived: string;
  blocks: readonly MaterialParagraphBlock[];
  segment: DeconP1bSegment;
}

/** 逐段 user prompt（可选词典块 + 【P 全局段号】标记正文 + 范围注记）。 */
export function buildDeconP3aUserPrompt(input: DeconP3aUserPromptInput): string {
  const dictLines = input.dictionaryEntries?.map((e) => `${e.name} | ${e.type}`) ?? [];
  const numbered: string[] = [];
  for (let i = input.segment.blockStart; i < input.segment.blockEnd; i++) {
    numbered.push(`【P${i}】${input.derived.slice(input.blocks[i]!.start, input.blocks[i]!.end)}`);
  }
  return [
    ...(dictLines.length > 0
      ? ['【实体词典（name | type）——识别段落涉及的实体时参考（跨章一致）】', ...dictLines, '']
      : []),
    '【本章正文（【P段落号】标记每段开始；段落号是全文档全局编号）】',
    numbered.join('\n\n'),
    `（本片段段落号范围 P${input.segment.blockStart}–P${input.segment.blockEnd - 1}；paraRange 只能引用该范围内实际出现的段落号）`,
  ].join('\n');
}

// ── 产物 hash 单源（E10.3b product 族——p3a/p3b/P4 写 output_hash 必须经本函数）──

/**
 * product 产物 hash（落库 payload 的 JSON 序列化面——与读侧重入比对同基）。
 * 🔑 构造纪律：hash 必须取**调用方自建对象**（固定键序字面量），不得取 zod parse 产物
 * （zod 键序非契约面——若与 JSON round-trip 序不同，重入 hash 永不匹配 = 该 unit 永久
 * 重烧，spec long-running-pipeline「断点产物完整性」Pattern）。
 */
export function hashDeconProductOutput(payload: unknown): string {
  return sha256DeconContent(JSON.stringify(payload));
}

// ── P3a 编排（逐章循环——断点/预算/锚定核验/同事务落库）──

export interface DeconP3aStats {
  chapters: number;
  skipped: number;
  labeled: number;
  droppedNoAnchor: number;
  droppedMalformed: number;
  /** 纯标记/空白章跳过数（CR-15 同款——章区间与段落块不相交，不 fail 整 pass）。 */
  emptySegmentChapters: number;
}

export type DeconP3aResult =
  | { status: 'done'; stats: DeconP3aStats }
  | { status: 'paused'; stats: DeconP3aStats }
  | { status: 'cancelled'; stats: DeconP3aStats }
  | { status: 'capped'; message: string; stats: DeconP3aStats }
  | { status: 'failed'; message: string; stats: DeconP3aStats }
  | { status: 'stale'; message: string };

export interface DeconP3aDeps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  /** 逐章 running 进度事件注入（CR-8——runDeconPassSequence 传 stamped notify；直调测试缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
  now?: () => Date;
}

function emptyStats(chapters: number): DeconP3aStats {
  return {
    chapters,
    skipped: 0,
    labeled: 0,
    droppedNoAnchor: 0,
    droppedMalformed: 0,
    emptySegmentChapters: 0,
  };
}

/** 边界/门停走映射（CR-7——paused/cancelled/stale 如实，其余 failed）。 */
function boundaryToP3aResult(stop: DeconBoundaryStop, stats: DeconP3aStats): DeconP3aResult {
  if (stop.status === 'paused') return { status: 'paused', stats };
  if (stop.status === 'cancelled') return { status: 'cancelled', stats };
  return { status: stop.status, message: stop.message, stats };
}

/**
 * 跑 P3a（pass='p3a'，unit=章号）。章序 = material.chapters 登记序；每章：断点重入
 * （done+hash 一致 skip——零 LLM 重付）→ 分段（超长章段内串行）→ 段内预算门前置（超限
 * capped 不烧 token）→ finishReason='length' 权威挂起（capped——不落半程产物）→ 锚定
 * 核验（集外/引文不匹配丢条计数）→ 多段合并 → 写侧 zod 门 + product + pass_state done
 * 同事务落库。任意章边界感知 pause/cancel（CR-7 如实映射）；每章发 running 进度事件。
 * LLM 内核**惰性判定**（CR-10——重入全 skip 的 job 不因内核未装配误 fail）；词典**可选**
 * （无词典不注入块照常打标——与 P1b 的强依赖不同）。
 */
export async function runDeconP3a(jobId: string, deps: DeconP3aDeps = {}): Promise<DeconP3aResult> {
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

  const material = getMaterialRow(extractMaterialId(job.materialRef));
  if (material === null || material.chapters.length === 0) {
    const message = `材料 ${job.materialRef} 不存在或零章——P3a 无可打标章`;
    failDeconUnit(jobId, 'p3a', 'all', message, nowIso());
    return { status: 'failed', message, stats: emptyStats(0) };
  }
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    const message = '派生 .md 读取失败（缺失或车道不可解析）——无法锚定打标基面';
    failDeconUnit(jobId, 'p3a', 'all', message, nowIso());
    return { status: 'failed', message, stats: emptyStats(material.chapters.length) };
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }
  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    const message = '材料无有效段落（派生 .md 全空白）——不可打标';
    failDeconUnit(jobId, 'p3a', 'all', message, nowIso());
    return { status: 'failed', message, stats: emptyStats(material.chapters.length) };
  }

  // 惰性资源面（CR-10）：LLM 内核只在确有章需要打标时判定加载；词典可选（null = 不注入）。
  let generate: DeconGenerateText | undefined;
  let dictionaryLazy: readonly DeconDictionaryEntry[] | null | undefined;
  const requireDictionaryEntries = (): readonly DeconDictionaryEntry[] | null => {
    if (dictionaryLazy === undefined) {
      dictionaryLazy = getDeconDictionary(job.materialRef, job.derivedHash)?.entries ?? null;
    }
    return dictionaryLazy;
  };

  const stats: DeconP3aStats = {
    chapters: material.chapters.length,
    skipped: 0,
    labeled: 0,
    droppedNoAnchor: 0,
    droppedMalformed: 0,
    emptySegmentChapters: 0,
  };
  let cost = job.cost;

  for (const chapter of material.chapters) {
    // 中断韧性（CR-7）：任意章边界如实判别 pause/cancel/外部翻态。
    const stop = checkDeconRunBoundary(jobId);
    if (stop !== null) return boundaryToP3aResult(stop, stats);

    const unit = String(chapter.index);
    // CR-8：逐章 running 事件（best-effort——notify 注入缺省不发）。
    deps.notify?.({ jobId, status: 'running', pass: 'p3a', unit });

    const state = getDeconPassState(jobId, 'p3a', unit);
    const product = getDeconProduct(jobId, 'p3a', unit);
    const decision = decideDeconPassReentry(
      state,
      product === null ? null : hashDeconProductOutput(product.payload),
    );
    if (decision === 'skip') {
      stats.skipped += 1;
      continue;
    }
    // rerun / capped-hold → 本次尝试（capped-hold 经下方预算门再判：预算已调大则放行，仍超则再 cap）。

    const failUnit = (message: string): { status: 'failed'; message: string; stats: DeconP3aStats } => {
      failDeconUnit(jobId, 'p3a', unit, message, nowIso());
      return { status: 'failed', message, stats };
    };

    if (generate === undefined) {
      generate = deps.generateText ?? getDeconLlmCore()?.generateText;
      if (generate === undefined) {
        return failUnit('拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试');
      }
    }
    const dictionaryEntries = requireDictionaryEntries();

    const segments = buildChapterSegments(blocks, chapter);
    if (segments.length === 0) {
      // CR-15 同款：纯标记章/空白章跳过 + 计数——不 fail 整个 p3a 与 job（重跑幂等廉价；
      // 不落 product 行——空标签对 P3b 是「零标签章」同形，不污染统计）。
      stats.emptySegmentChapters += 1;
      getLogger().warn(
        { jobId, chapterIndex: chapter.index },
        'decon p3a: chapter has no labelable segments (marker-only or blank) - skipped without failing the pass',
      );
      continue;
    }

    writeDeconPassState(jobId, 'p3a', unit, 'running', null, nowIso());

    const droppedBefore = stats.droppedNoAnchor; // 章级日志口径（delta——stats 本体是全章累计）
    const parts: DeconLabelsSegmentOutput[] = [];

    for (const segment of segments) {
      const user = buildDeconP3aUserPrompt({ dictionaryEntries, derived, blocks, segment });
      const est = estimateDeconCallTokens(DECON_P3A_SYSTEM_PROMPT, user, DECON_P3A_LABELS_MAX_TOKENS);
      if (wouldExceedDeconBudget(job.budget, cost, 'p3a', est)) {
        const note = `p3a 第 ${chapter.index} 章打标预算超限（本次预估 ${est} tokens，已累计 ${cost.totalTokens}）——已诚实挂起（不烧 token），调整预算后续跑`;
        capDeconUnit(jobId, 'p3a', unit, note, nowIso());
        return { status: 'capped', message: note, stats };
      }
      let text = '';
      let finishReason: string | undefined;
      let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
      try {
        const response = await generate({
          slot: 'extraction',
          system: DECON_P3A_SYSTEM_PROMPT,
          user,
          maxTokens: DECON_P3A_LABELS_MAX_TOKENS,
        });
        text = (response?.text ?? '').trim();
        finishReason = response?.finishReason;
        usage = response?.usage;
      } catch (err) {
        return failUnit(`第 ${chapter.index} 章打标调用失败：${deconErrMsg(err)}`);
      }
      // 实际记账（CR-13：provider usage 真值优先）并落 job 行——writeDeconCost 单源重读现值行
      // （await 窗口翻态不被旧快照复活；行已删抛 DeconJobGoneError 静默中止）。
      const actual = resolveDeconActualTokens(DECON_P3A_SYSTEM_PROMPT, user, text, usage);
      cost = accumulateDeconCost(cost, 'p3a', actual.tokens, 1, actual.estimated);
      writeDeconCost(jobId, job, cost, nowIso());
      if (finishReason === 'length') {
        // 输出预算型截断（权威停因）——capped 挂起：调预算/重试即可续（纯枚举重打廉价，
        // 与 p1b 的 failed 处理不同面——彼处 synopsis 语义面损坏不可续）。
        const note = `p3a 第 ${chapter.index} 章打标输出因 token 上限截断（finishReason=length）——已挂起（不落半程产物），调整预算后续跑`;
        capDeconUnit(jobId, 'p3a', unit, note, nowIso());
        return { status: 'capped', message: note, stats };
      }
      if (!text) {
        return failUnit(`第 ${chapter.index} 章打标返回空回复——已挂起`);
      }
      const parsed = parseDeconLabelsSegmentResponse(text);
      if (parsed === null) {
        return failUnit(`第 ${chapter.index} 章打标输出不可解析为 JSON 对象——整体拒收（不硬给标签）`);
      }
      stats.droppedMalformed += parsed.droppedMalformed;
      if (parsed.itemCount > DECON_P3A_MAX_ITEMS_PER_CHAPTER) {
        return failUnit(
          `第 ${chapter.index} 章打标条目数 ${parsed.itemCount} 超过上限 ${DECON_P3A_MAX_ITEMS_PER_CHAPTER}——为避免静默截断已挂起（材料可能异常，请人工检查）`,
        );
      }
      parts.push(parsed.output);
    }

    // 多段合并（plotPhase 最末非空 / arcBoundary 置信最高候选）。
    const merged = mergeDeconLabelsSegments(parts);

    // CR-5 合并帽：章条目帽在段合并后的总量上检查（段内各 ≤ 帽的长章不再落 2-N 倍帽——
    // mirror p4Craft「分组 findings 合计」同款第二道）。
    const mergedItemCount =
      merged.hooks.length +
      merged.transitions.length +
      merged.emotionalBeats.length +
      merged.highlightSpans.length +
      merged.expositionSpans.length;
    if (mergedItemCount > DECON_P3A_MAX_ITEMS_PER_CHAPTER) {
      return failUnit(
        `第 ${chapter.index} 章打标条目合并后共 ${mergedItemCount} 条超过上限 ${DECON_P3A_MAX_ITEMS_PER_CHAPTER}——为避免静默截断已挂起（材料可能异常，请人工检查）`,
      );
    }

    // 锚定核验（无锚即丢——F-15 双核验第二道）：paraRange 集外（编造 span）或引文不在
    // span 文本（编造引文）→ 丢该条 + 计数。核验基面 = 派生 .md 原文（章内段落块文本）。
    const verifiedHooks: DeconChapterLabels['hooks'] = [];
    const verifiedTransitions: DeconChapterLabels['transitions'] = [];
    const verifiedBeats: DeconChapterLabels['emotionalBeats'] = [];
    const verifiedHighlights: DeconSpan[] = [];
    const verifiedExposition: DeconSpan[] = [];
    let segIdx = 0;
    for (const segment of segments) {
      const part = parts[segIdx]!;
      segIdx += 1;
      const verify = (item: DeconRawLabelItem): DeconSpan | null => {
        const span = buildDeconAnchor(item.paraRange, segment, blocks, chapter.index);
        if (span === null || !isQuoteInSpan(item.quote, derived.slice(span.charStart, span.charEnd))) {
          stats.droppedNoAnchor += 1;
          return null;
        }
        return span;
      };
      for (const e of part.hooks) {
        const span = verify(e);
        if (span !== null) verifiedHooks.push({ type: e.type, span });
      }
      for (const e of part.transitions) {
        const span = verify(e);
        if (span !== null) verifiedTransitions.push({ type: e.type, span });
      }
      for (const e of part.emotionalBeats) {
        const span = verify(e);
        if (span !== null) verifiedBeats.push({ beat: e.beat, span });
      }
      for (const e of part.highlightSpans) {
        const span = verify(e);
        if (span !== null) verifiedHighlights.push(span);
      }
      for (const e of part.expositionSpans) {
        const span = verify(e);
        if (span !== null) verifiedExposition.push(span);
      }
    }

    // 写侧 zod 门预检（权威门在 upsertDeconProduct——此处先验给清晰错误；hash 取本对象非
    // zod parse 产物，键序自控防重入漂移）。
    const candidate: DeconChapterLabels = {
      hooks: verifiedHooks,
      transitions: verifiedTransitions,
      emotionalBeats: verifiedBeats,
      plotPhase: merged.plotPhase,
      highlightSpans: verifiedHighlights,
      expositionSpans: verifiedExposition,
      arcBoundary: merged.arcBoundary,
    };
    if (!deconChapterLabelsSchema.safeParse(candidate).success) {
      return failUnit(`第 ${chapter.index} 章合并标签未过契约校验（内部错误——锚定映射与契约漂移，请报告）`);
    }
    const outputHash = hashDeconProductOutput(candidate);

    // 落库（product + pass_state done 同事务——崩溃不留半状态）。
    const wrote = getDb().transaction(() => {
      const ok = upsertDeconProduct({
        jobId,
        pass: 'p3a',
        unit,
        payload: candidate,
        updatedAt: nowIso(),
      });
      if (ok) {
        writeDeconPassState(jobId, 'p3a', unit, 'done', { outputRef: `product:p3a:${unit}`, outputHash }, nowIso());
      }
      return ok;
    })();
    if (!wrote) {
      return failUnit(`第 ${chapter.index} 章标签落库被写侧门拒收（内部错误——payload 与契约漂移，请报告）`);
    }
    if (stats.droppedNoAnchor > droppedBefore) {
      getLogger().warn(
        { jobId, chapterIndex: chapter.index, droppedNoAnchor: stats.droppedNoAnchor - droppedBefore },
        'decon p3a: label items dropped for missing anchor (fabricated paraRange or quote) - no-anchor-no-keep discipline',
      );
    }
    stats.labeled += 1;
  }

  return { status: 'done', stats };
}
