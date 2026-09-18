import type {
  DeconArc,
  DeconChapterLabels,
  DeconCost,
  DeconFacts,
  DeconFindings,
  DeconJob,
  DeconProgressEvent,
  DeconReportKind,
  DeconSpan,
  DeconStatsPayload,
  Material,
} from '@orison/shared-contracts';
import {
  DECON_DIMENSIONS,
  deconArcsPayloadSchema,
  deconChapterLabelsSchema,
  deconFindingsSchema,
  deconStatsPayloadSchema,
} from '@orison/shared-contracts';
import { getDb } from '../db/index';
import {
  CHAPTER_HEADING_NUM_RE,
  CHAPTER_HEADING_NUMERALS,
  buildChapterHeadings,
  chapterRangeLabel,
  parseChapterHeadingNumber,
  type ChapterHeadingInfo,
} from '../db/chapterHeadings';
import {
  getDeconJob,
  getDeconPassState,
  getDeconProduct,
  getDeconReport,
  listDeconChapterFacts,
  listDeconProducts,
  upsertDeconReport,
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
import { getDeconLlmCore, type DeconGenerateText } from './deconLlmCore';
import { decideDeconPassReentry, extractMaterialId, transitionDeconJob } from './deconJob';
import { hashDeconProductOutput } from './p3Label';
import { chapterCharCounts } from './p3Metrics';
import { splitDeconArcGroups } from './p4Craft';
import { DECON_P4_STANCE_PROMPT, buildDeconP4BookQuestionnaire, type DeconP4BookDimensionId } from './p4Questionnaires';

// ── E10.3b（task 09-05）W4：P5 输出装配（child B design §4——三层输出，writer-draft 温 0.3）──
//
// 三 kind 一文件：
// - **book_reading**（coarse+，unit='all'）：输入=弧级 synopsis 聚合（两级摘要范式之书级——
//   非全书原文）+ P3b 统计摘要面 + W3a 书级问题单（维 1/3/5，DECON_P4_STANCE_PROMPT 前置）
//   → markdown：整体结构判定 / 全书骨架 / 核心节奏公式独立小节 / 换地图逻辑 / 获客漏斗与
//   受众 / 四因总分解 / 主题。
// - **chapter_review**（fine+，unit='ch:N' 逐章）：输入=章 synopsis + facts 摘要 + P3a 标签 +
//   该章各维 findings（product 表 pass='p4:<dim>' AND unit='ch:N' 读回聚合）→ markdown：章导读
//   （六步法环节定位）+ 章收束（这章做对了什么——各维发现聚合）。job.dimensions 无手艺维时
//   findings 预注自然为空，章评基于 facts+labels 照跑。
// - **scene_annotation**（deep，unit='scene:N'）：**候选=纯代码**（爽点字数密度 + 核心事件数 +
//   情绪拍强度评分 → top N=max(1, round(章数×0.3))，非相邻章去重——同输入同选择）→ 每场
//   拉片子细批 prompt（切入点/信息密度/场景结构/镜头语言与缝合/断章钩子/对话三层/逐词细读
//   ——协议全部操作化白话，网文语境纪律）。
//
// runner 合同 mirror p3Label（W2 最新形态）：断点 output_hash 门控（skip 零重付）/ 预算门前置
// （超限 capped 不烧 token）/ finishReason='length' 权威挂起（capped——报告重生成廉价不落半程）/
// report 写侧 sanitize（upsertDeconReport zod 门）+ hash 同基（hashDeconReportOutput——product 族
// hashDeconProductOutput 的 report 版单源）/ report + pass_state done 同事务 / 逐 unit running
// 事件（CR-8）/ 章边界感知 pause/cancel（CR-7 如实映射）/ LLM 内核惰性判定（CR-10——重入全
// skip 的 job 不因内核未装配误 fail）。
//
// 范式判据（parent design §9 P5 行）：读法/章评/细批**生成** = LLM（writer-draft 0.3——分析性
// 叙事报告非创作文本，deconLlmCore 自钉温度）；候选选择 / 输入装配 / 断点 / 预算 = 纯代码。
//
// tier 门（design §9）：runDeconP5 伞面按 job.tier 分派（coarse=只 book_reading；fine=+章评；
// deep=+细批）；三个子 runner 各带 tier belt（编排骨架错配时跳过 + warn，不空烧）。
//
// expected_downstream_consumers:
// - W5 deconIpc（phases 动态化——三子 runner 或伞面任一形态挂接；本文件不接 deconIpc）。
// - W6 拆书页（产出阅读 tab：report meta 列表 + 单取经 decon:reports）。
// - W7 deconGoldenEval（scenes 断言面：selectDeconSceneCandidates 候选 + report 行）。

// ── 常量（token 预算独立核算——E10.2a CR-2 配套纪律；权重为推测值注记，dogfood 首本标定）──

/** 书级读法输出 token 预算（长 markdown 报告 ~3000-6000 字 ≈ 2000-4000 tokens，8192 含余量）。
 *
 * 8192 → 16384（dogfood R3 F15 实证）：98 章/49.5 万字实书的书级读法在 8192 帽下
 * finishReason=length 截断（capped 挂起）——大书分组纪律下读法体量随章节数增长，
 * 8192 只够中等书；对齐预算侧 DECON_P5_BOOK_READING_TOKENS(20_000) 口径内抬帽。
 */
export const DECON_P5_BOOK_READING_MAX_TOKENS = 16_384;

/** 每章章评输出 token 预算（~800-2000 字 markdown，4096 含余量）。 */
export const DECON_P5_CHAPTER_REVIEW_MAX_TOKENS = 4_096;

/** 每场细批输出 token 预算（逐项协议 ~1500-3000 字 markdown，6144 含余量）。 */
export const DECON_P5_SCENE_ANNOTATION_MAX_TOKENS = 6_144;

/**
 * 书级读法输入装配上限（字符——synopsis 聚合 + 统计 + 三问题单）。**CR-7**：超限不再硬失败
 * ——对齐 P4 弧级分组纪律，按弧拆 3-5 组（splitDeconArcGroups，本值为分组配额线）组内串行
 * 产分组草稿 + 一次汇总合成；零弧可分时才诚实挂起。推测值：正常大书弧级聚合 ~30-60K 字符。
 */
export const DECON_P5_BOOK_INPUT_CHAR_LIMIT = 150_000;

/** 名场面配比（top N = max(1, round(章数 × 0.3))——design §4 / deconBudget DECON_P5_SCENES_PER_CHAPTER 同值）。 */
export const DECON_P5_SCENES_RATIO = 0.3;

/** 细批窗口字符上限（超限章取峰值扩展窗——块粒度不劈段；推测值）。 */
export const DECON_P5_SCENE_MAX_WINDOW_CHARS = 6_000;

/** 高唤起情绪拍（评分加权面——上行/层层递进/持续动态；推测值注记）。 */
export const DECON_P5_SCENE_INTENSE_BEATS: readonly string[] = ['上行', '层层递进', '持续动态'];

/** 爽点字数密度权重（评分公式推测值——密度 0-1 归一后计权）。 */
export const DECON_P5_SCENE_DENSITY_WEIGHT = 3;

/** 核心事件数权重（每 kernel 事件计权——推测值）。 */
export const DECON_P5_SCENE_KERNEL_WEIGHT = 2;

/** 高唤起情绪拍权重（每拍计权——推测值）。 */
export const DECON_P5_SCENE_INTENSE_BEAT_WEIGHT = 1.5;

/** 其余情绪拍权重（每拍计权——推测值）。 */
export const DECON_P5_SCENE_BEAT_WEIGHT = 0.5;

/**
 * 截断升帽重试倍数常量已退役（CR-4）：callDeconP5Generate 收口 deconRun.runDeconLlmCall 共享
 * 脚手架——帽倍率单源 DECON_LLM_RETRY_ESCALATE（deconRun.ts）。
 */

// ── report 产物 hash 单源（product 族 hashDeconProductOutput 的 report 版——键序自控防重入漂移）──

/**
 * report 产物 hash（contentMd + anchors 的固定键序序列化面——与读侧重入比对同基）。
 * 🔑 构造纪律同 hashDeconProductOutput：hash 取调用方自建对象，不得取 zod parse 产物。
 */
export function hashDeconReportOutput(contentMd: string, anchors: readonly DeconSpan[]): string {
  return hashDeconProductOutput({ contentMd, anchors });
}

// ── 章标真值与引用回查（R1/F19——dogfood R3 实证：chapters[0] 可能是简介伪章〔title null、
//    index 0〕，真章「第N章」的 index ≈ N，index+1 渲染族整体偏移 1。章引用一律锚定**真实
//    章标行原词**（章号从章标行解析），无章标章语义回落——零序号算术。范式判据：确定性装配面
//    直接修；LLM 散文引用只核验标注不改写）──

/** 散文「第N章」类引用提取（含区间形「第M-N章」与可选标题尾——书名号/引号/裸词三形态）。 */
const DECON_CHAPTER_REF_NUM = `[0-9０-９]+|[${CHAPTER_HEADING_NUMERALS}]{1,8}`;
const DECON_CHAPTER_REF_TAIL = "[^\\s，。；：、！？…—·（）()《》〈〉「」『』【】\\[\\]\"“”‘\\'#*|/\\\\-]{1,30}";
/** 区间连接符（CR-10：补全角减号与「到」——「第3章到第5章」不再吞成伪标题尾致末号失验）。 */
const DECON_CHAPTER_REF_RANGE_CONN = '[-–—~－至到]';
/**
 * 区间尾形态（CR-10，单捕获组两分支）：「第M-N章」族（连接符在两号之间）与「第M章到第N章」
 * 族（首号自带章尾再接连接符——旧 regex 不认 → 「到第5章」被吞进首号的标题尾、末号失验）。
 */
const DECON_CHAPTER_REF_RANGE_TAIL = `\\s*(?:${DECON_CHAPTER_REF_RANGE_CONN}\\s*(?:第\\s*)?|章\\s*${DECON_CHAPTER_REF_RANGE_CONN}\\s*(?:第\\s*)?)`;
const DECON_CHAPTER_REF_RE = new RegExp(
  `[【\\[]?第\\s*(${DECON_CHAPTER_REF_NUM})(?:${DECON_CHAPTER_REF_RANGE_TAIL}(${DECON_CHAPTER_REF_NUM}))?\\s*章(?:\\s*[《「『“]([^《」『”]{1,50})[》」』”]|\\s*(${DECON_CHAPTER_REF_TAIL}))?`,
  'g',
);

/** 章标真值类型（单源 db/chapterHeadings——prompt 对照表 / 渲染标签 / 引用回查三方共用）。 */
export type DeconChapterHeadingInfo = ChapterHeadingInfo;

/** 章节章标对照表块（全量/分组/汇总三 prompt 共用——LLM 章引用的唯一权威来源，R1/F19）。 */
function renderDeconChapterHeadingTable(headings: ReadonlyMap<number, DeconChapterHeadingInfo>): string {
  const lines = ['【章节章标对照表（提到任何一章时，引用必须照抄此表里的章标原词；禁止按内部序号自行推算章号）】'];
  for (const info of headings.values()) lines.push(`- ${info.label}`);
  return lines.join('\n');
}

export type DeconChapterRefMismatchKind = 'number-missing' | 'title-mismatch';

/** 单条章引用错位（纯代码核验产物——只标注不改写）。 */
export interface DeconChapterRefMismatch {
  kind: DeconChapterRefMismatchKind;
  /** 引用原文（含可选标题尾——match 截尾 trim）。 */
  refText: string;
  /** 引用章号（解析值）。 */
  refNumber: number | null;
  /** 引用携带的标题（书名号/引号/裸词捕获 trim；无 = null）。 */
  refTitle: string | null;
  /** 错位可定位的实际材料章（title-mismatch 必有；number-missing = null）。 */
  actualChapterIndex: number | null;
  /** 实际章标签签（label 形态）。 */
  actualLabel: string | null;
}

export interface DeconChapterRefCheckResult {
  /** 原文（无错位）或末尾附「章引用校验」注记后的文本。 */
  contentMd: string;
  /** 可定位错位章的材料 span（commit anchors 承载——纯标注）。 */
  anchors: DeconSpan[];
  mismatches: readonly DeconChapterRefMismatch[];
}

/**
 * 章引用回查（纯函数——R1/F19 后半，范式判据：只标注不改写 LLM 散文）：从 contentMd 提取
 * 「第N章」类引用（含区间形与可选标题尾）→ 对照真实章标行核验——(a) 引用标题命中他章
 * （title-mismatch，可定位实际章）；(b) 章号在章标集中不存在（number-missing——含简介伪章
 * 书的「第0章」与越界章号）。错位者进 anchors（可定位章的材料 span）+ contentMd 末尾附
 * 「章引用校验」注记段；无错位零改动。材料无「第N章」族章标时核验面不成立，整体跳过。
 */
export function checkDeconChapterReferences(
  contentMd: string,
  chapters: ReadonlyArray<
    Pick<Material['chapters'][number], 'index' | 'title' | 'charStart' | 'charEnd' | 'paraStart' | 'paraEnd'>
  >,
  headings: ReadonlyMap<number, DeconChapterHeadingInfo>,
): DeconChapterRefCheckResult {
  // 章号存在集（「第N章」是否在材料章标号域——纯存在性判定，无归因语义，天然免疫重复键）。
  const chapterNumbers = new Set<number>();
  // 标题 → 章映射（title-mismatch 定位用）：重复键即弃（CR-9）——同标题被多章持有时该标题
  // 退出核验，不 last-write-wins 归错章（否则引用被误定位到末次持有章 → 误报 + 错锚）。
  const indexByTitle = new Map<string, number>();
  const ambiguousTitles = new Set<string>();
  const setUniqueTitle = (title: string, chapterIndex: number): void => {
    if (ambiguousTitles.has(title)) return;
    const existing = indexByTitle.get(title);
    if (existing === undefined) {
      indexByTitle.set(title, chapterIndex);
      return;
    }
    if (existing === chapterIndex) return; // 同章重复登记（title 与章标行尾同词）非冲突
    indexByTitle.delete(title);
    ambiguousTitles.add(title);
  };
  for (const chapter of chapters) {
    const info = headings.get(chapter.index);
    if (info !== undefined && info.number !== null) chapterNumbers.add(info.number);
    if (chapter.title !== null && chapter.title.length > 0) setUniqueTitle(chapter.title, chapter.index);
    if (info !== undefined && info.headingLine !== null) {
      const numMatch = CHAPTER_HEADING_NUM_RE.exec(info.headingLine);
      if (numMatch !== null) {
        const tail = info.headingLine
          .slice(numMatch[0].length)
          .replace(/^[】\]]?[ \t\u3000:：，,、·．.\-—]+/, '')
          .trim();
        if (tail.length > 0) setUniqueTitle(tail, chapter.index);
      }
    }
  }
  if (chapterNumbers.size === 0) {
    return { contentMd, anchors: [], mismatches: [] };
  }
  const raw: DeconChapterRefMismatch[] = [];
  for (const match of contentMd.matchAll(DECON_CHAPTER_REF_RE)) {
    const refNumber = parseChapterHeadingNumber(match[1]!);
    if (refNumber === null) continue;
    const rangeEndRaw = match[2];
    const refTitleRaw = match[3] ?? match[4];
    const refTitle = refTitleRaw === undefined ? null : refTitleRaw.trim();
    const resolved = refTitle !== null && refTitle.length > 0 ? indexByTitle.get(refTitle) : undefined;
    const actualInfo = resolved === undefined ? undefined : headings.get(resolved);
    if (
      resolved !== undefined &&
      actualInfo !== undefined &&
      actualInfo.number !== null &&
      actualInfo.number !== refNumber
    ) {
      raw.push({
        kind: 'title-mismatch',
        refText: match[0].trim(),
        refNumber,
        refTitle,
        actualChapterIndex: resolved,
        actualLabel: actualInfo.label,
      });
      continue;
    }
    const rangeEnd = rangeEndRaw === undefined ? null : parseChapterHeadingNumber(rangeEndRaw);
    const numbers = rangeEnd === null ? [refNumber] : [refNumber, rangeEnd];
    for (const n of numbers) {
      if (!chapterNumbers.has(n)) {
        raw.push({ kind: 'number-missing', refText: match[0].trim(), refNumber: n, refTitle, actualChapterIndex: null, actualLabel: null });
      }
    }
  }
  const seen = new Set<string>();
  const mismatches: DeconChapterRefMismatch[] = [];
  for (const m of raw) {
    const key = `${m.kind}|${m.refNumber}|${m.refTitle ?? ''}|${m.actualChapterIndex ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mismatches.push(m);
  }
  if (mismatches.length === 0) return { contentMd, anchors: [], mismatches };
  const anchors: DeconSpan[] = [];
  const anchorSeen = new Set<number>();
  for (const m of mismatches) {
    if (m.actualChapterIndex === null || anchorSeen.has(m.actualChapterIndex)) continue;
    const chapter = chapters.find((c) => c.index === m.actualChapterIndex);
    if (chapter === undefined) continue;
    anchorSeen.add(chapter.index);
    anchors.push({
      chapterIndex: chapter.index,
      charStart: chapter.charStart,
      charEnd: chapter.charEnd,
      paraStart: chapter.paraStart,
      paraEnd: chapter.paraEnd,
    });
  }
  const numbers = [...chapterNumbers].sort((a, b) => a - b);
  const rangeNote =
    numbers.length > 0 ? `（材料「第N章」族章号 ${numbers[0]}-${numbers[numbers.length - 1]}）` : '';
  const lines = mismatches.map((m) =>
    m.kind === 'title-mismatch' && m.actualChapterIndex !== null
      ? `- 引用「${m.refText}」与材料章标不符：该标题的实际章标是「${m.actualLabel}」。`
      : `- 引用「${m.refText}」在材料章标中不存在${rangeNote}。`,
  );
  const annotation = `\n\n---\n\n【章引用校验】（自动核对材料章标——只标注，不改写正文）\n${lines.join('\n')}`;
  return { contentMd: contentMd + annotation, anchors, mismatches };
}

// ── scene 候选评分与选择（纯代码——确定性：同输入同选择）──

/** 单章名场面评分（观测面——分量留审计）。 */
export interface DeconSceneChapterScore {
  chapterIndex: number;
  /** 爽点段字数密度（0-1，章内占比）。 */
  highlightDensity: number;
  /** 核心事件数（P1b events.kernel=true）。 */
  kernelEvents: number;
  /** 高唤起情绪拍数。 */
  intenseBeats: number;
  /** 其余情绪拍数。 */
  otherBeats: number;
  /** 综合分 = 密度×W密度 + kernel×W核心 + 高唤起×W强拍 + 其余×W拍（权重推测值，dogfood 标定）。 */
  score: number;
}

/**
 * 逐章名场面评分（纯函数）：score = 爽点字数密度×DECON_P5_SCENE_DENSITY_WEIGHT +
 * 核心事件数×KERNEL_WEIGHT + 高唤起拍×INTENSE_BEAT_WEIGHT + 其余拍×BEAT_WEIGHT。
 * 全部分量来自 P3a labels + P1b facts（既有产物——候选选择零 LLM，design §4）。
 */
export function scoreDeconSceneChapters(
  chapters: readonly { index: number }[],
  chapterChars: readonly number[],
  labelsByChapter: ReadonlyMap<number, DeconChapterLabels>,
  factsByChapter: ReadonlyMap<number, DeconFacts>,
): DeconSceneChapterScore[] {
  return chapters.map((chapter, p) => {
    const chars = chapterChars[p] ?? 0;
    const labels = labelsByChapter.get(chapter.index);
    let highlightChars = 0;
    if (labels !== undefined) {
      for (const s of labels.highlightSpans) highlightChars += Math.max(0, s.charEnd - s.charStart);
    }
    const density = chars > 0 ? Math.min(1, highlightChars / chars) : 0;
    let kernels = 0;
    const facts = factsByChapter.get(chapter.index);
    if (facts !== undefined) {
      for (const e of facts.events) if (e.kernel === true) kernels += 1;
    }
    let intense = 0;
    let other = 0;
    if (labels !== undefined) {
      for (const b of labels.emotionalBeats) {
        if ((DECON_P5_SCENE_INTENSE_BEATS as readonly string[]).includes(b.beat)) intense += 1;
        else other += 1;
      }
    }
    return {
      chapterIndex: chapter.index,
      highlightDensity: density,
      kernelEvents: kernels,
      intenseBeats: intense,
      otherBeats: other,
      score:
        density * DECON_P5_SCENE_DENSITY_WEIGHT +
        kernels * DECON_P5_SCENE_KERNEL_WEIGHT +
        intense * DECON_P5_SCENE_INTENSE_BEAT_WEIGHT +
        other * DECON_P5_SCENE_BEAT_WEIGHT,
    };
  });
}

/**
 * 名场面候选选择（纯函数——确定性钉死：同输入两跑同选择）：
 * - 池 = score>0 的章（零分量章无可细批的密度峰，诚实不选）。
 * - 排序 = 分数降序、同分章号升序（tie-break 确定）。
 * - top N = max(1, round(章数 × DECON_P5_SCENES_RATIO))；**非相邻章去重**（与已选章距 ≤1 跳过）。
 * - 返回选择序（分数降序）——unit=`scene:<rank>` 按此序编（scene:0 = 最强场面）。
 */
export function selectDeconSceneCandidates(
  chapters: readonly { index: number }[],
  chapterChars: readonly number[],
  labelsByChapter: ReadonlyMap<number, DeconChapterLabels>,
  factsByChapter: ReadonlyMap<number, DeconFacts>,
): number[] {
  const scored = scoreDeconSceneChapters(chapters, chapterChars, labelsByChapter, factsByChapter)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.chapterIndex - b.chapterIndex);
  const target = Math.max(1, Math.round(chapters.length * DECON_P5_SCENES_RATIO));
  const picked: number[] = [];
  for (const s of scored) {
    if (picked.length >= target) break;
    if (picked.every((p) => Math.abs(p - s.chapterIndex) > 1)) picked.push(s.chapterIndex);
  }
  return picked;
}

// ── scene 窗口（纯代码——峰值扩展，块粒度不劈段）──

/** 名场面窗口：块区间 [from, to)（全局段落号）+ 同面 span（report 行 anchors 消费）。 */
export interface DeconSceneWindow {
  from: number;
  to: number;
  span: DeconSpan;
}

/**
 * 场景窗口选择（纯函数——确定性）：章字符量 ≤ 上限 → 整章；超限 → 峰值锚（最大爽点段 →
 * 最大核心事件段 → 章中位块兜底）起，右先左右交替扩展至预算（块粒度——单块超限保持整块
 * 不硬截，截断防御在输出侧 finishReason）。章无相交块 → null（调用方跳过计数）。
 */
export function pickDeconSceneWindow(
  blocks: readonly MaterialParagraphBlock[],
  chapter: { index: number; charStart: number; charEnd: number },
  labels: DeconChapterLabels | undefined,
  facts: DeconFacts | undefined,
): DeconSceneWindow | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.end > chapter.charStart && blocks[i]!.start < chapter.charEnd) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  const windowOf = (from: number, to: number): DeconSceneWindow => ({
    from,
    to,
    span: {
      chapterIndex: chapter.index,
      charStart: blocks[from]!.start,
      charEnd: blocks[to - 1]!.end,
      paraStart: from,
      paraEnd: to,
    },
  });
  const charLen = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i < to; i++) {
      const s = Math.max(blocks[i]!.start, chapter.charStart);
      const e = Math.min(blocks[i]!.end, chapter.charEnd);
      if (e > s) sum += e - s;
    }
    return sum;
  };
  if (charLen(first, last + 1) <= DECON_P5_SCENE_MAX_WINDOW_CHARS) return windowOf(first, last + 1);

  // 峰值锚：最大爽点段（字数）→ 最大核心事件段 → 章中位块。
  let peakChar: number | null = null;
  let bestLen = -1;
  for (const s of labels?.highlightSpans ?? []) {
    const len = s.charEnd - s.charStart;
    if (len > bestLen) {
      bestLen = len;
      peakChar = s.charStart;
    }
  }
  if (peakChar === null) {
    for (const e of facts?.events ?? []) {
      if (e.kernel !== true) continue;
      const len = e.span.charEnd - e.span.charStart;
      if (len > bestLen) {
        bestLen = len;
        peakChar = e.span.charStart;
      }
    }
  }
  let peakBlock = first + Math.floor((last - first) / 2);
  if (peakChar !== null) {
    for (let i = first; i <= last; i++) {
      if (blocks[i]!.start <= peakChar && peakChar < blocks[i]!.end) {
        peakBlock = i;
        break;
      }
    }
  }
  let lo = peakBlock;
  let hi = peakBlock + 1;
  let side: 'right' | 'left' = 'right';
  while ((lo > first || hi <= last) && charLen(lo, hi) < DECON_P5_SCENE_MAX_WINDOW_CHARS) {
    if (side === 'right' && hi <= last) {
      hi += 1;
      side = 'left';
    } else if (side === 'left' && lo > first) {
      lo -= 1;
      side = 'right';
    } else if (hi <= last) {
      hi += 1;
      side = 'left';
    } else if (lo > first) {
      lo -= 1;
      side = 'right';
    } else {
      break;
    }
  }
  return windowOf(lo, hi);
}

/** 窗口内标签过滤（章级标量〔plotPhase/arcBoundary〕保留；span 条目按与窗口相交过滤）。 */
function labelsWithinWindow(labels: DeconChapterLabels, win: DeconSceneWindow): DeconChapterLabels {
  const hit = (s: DeconSpan): boolean => s.charStart < win.span.charEnd && s.charEnd > win.span.charStart;
  return {
    hooks: labels.hooks.filter((h) => hit(h.span)),
    transitions: labels.transitions.filter((t) => hit(t.span)),
    emotionalBeats: labels.emotionalBeats.filter((b) => hit(b.span)),
    plotPhase: labels.plotPhase,
    highlightSpans: labels.highlightSpans.filter(hit),
    expositionSpans: labels.expositionSpans.filter(hit),
    arcBoundary: labels.arcBoundary,
  };
}

// ── prompt 装配（纯函数——渲染面只读 para/char 字段，不校验锚定）──

/** 段号引用渲染（半开区间 → P单 或 P起-P止）。 */
function paraRefOfSpan(span: DeconSpan): string {
  return span.paraEnd - span.paraStart > 1 ? `P${span.paraStart}-P${span.paraEnd - 1}` : `P${span.paraStart}`;
}

/** findings 证据 paraRange（半开区间段号——F-16 全局段号形态）渲染。 */
function paraRefOfRange(pr: { start: number; end: number }): string {
  return pr.end - pr.start > 1 ? `P${pr.start}-P${pr.end - 1}` : `P${pr.start}`;
}

/** 章级标签块渲染（null/空 → 无记录占位——章评/细批输入面）。 */
function renderDeconLabelsForPrompt(labels: DeconChapterLabels | null | undefined): string {
  if (labels === null || labels === undefined) return '（无打标记录。）';
  const lines: string[] = [];
  if (labels.hooks.length > 0) {
    lines.push(`钩子：${labels.hooks.map((h) => `${h.type}（${paraRefOfSpan(h.span)}）`).join('、')}`);
  }
  if (labels.transitions.length > 0) {
    lines.push(`转折：${labels.transitions.map((t) => `${t.type}（${paraRefOfSpan(t.span)}）`).join('、')}`);
  }
  if (labels.emotionalBeats.length > 0) {
    lines.push(`情绪拍：${labels.emotionalBeats.map((b) => `${b.beat}（${paraRefOfSpan(b.span)}）`).join('、')}`);
  }
  if (labels.plotPhase !== null) lines.push(`章主导相位：${labels.plotPhase}`);
  if (labels.highlightSpans.length > 0) {
    lines.push(`爽点段：${labels.highlightSpans.map((s) => paraRefOfSpan(s)).join('、')}`);
  }
  if (labels.expositionSpans.length > 0) {
    lines.push(`设定说明段：${labels.expositionSpans.map((s) => paraRefOfSpan(s)).join('、')}`);
  }
  return lines.length > 0 ? lines.join('\n') : '（本章无打标条目。）';
}

/** 章级 facts 摘要渲染（概要 + 事件〔核心标记〕+ 伏笔埋点 + 信息差——章评输入面）。 */
function renderDeconFactsForPrompt(facts: DeconFacts): string {
  const lines: string[] = [`概要：${facts.synopsis}`];
  if (facts.events.length > 0) {
    lines.push(
      `事件：${facts.events
        .map((e) => `${e.what}（${paraRefOfSpan(e.span)}${e.kernel === true ? '，核心事件' : ''}）`)
        .join('；')}`,
    );
  }
  if (facts.foreshadowPlanted.length > 0) {
    lines.push(`伏笔埋点：${facts.foreshadowPlanted.map((f) => `${f.hint}（${paraRefOfSpan(f.span)}）`).join('、')}`);
  }
  if (facts.infoGap.length > 0) {
    lines.push(`信息差标注：${facts.infoGap.map((g) => `${g.type}（${paraRefOfSpan(g.span)}）`).join('、')}`);
  }
  return lines.join('\n');
}

/** 数值渲染（整数原样、小数一位——统计面确定性格式）。 */
function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 分布渲染。 */
function fmtDist(d: { count: number; min: number; avg: number; max: number; sigma: number }): string {
  return d.count === 0
    ? '无'
    : `${d.count} 处｜均值 ${fmtNum(d.avg)}｜最小 ${fmtNum(d.min)}｜最大 ${fmtNum(d.max)}｜σ ${fmtNum(d.sigma)}`;
}

/** by 型计数渲染（只列非零项——全零记「无」）。 */
function fmtCounts(rec: Record<string, number>): string {
  const entries = Object.entries(rec).filter(([, v]) => v > 0);
  return entries.length === 0 ? '无' : entries.map(([k, v]) => `${k}×${v}`).join('、');
}

/** 书级统计摘要渲染（book_reading 输入——报告里的数字以此为准，LLM 不编数字）。 */
function renderDeconStatsForPrompt(
  stats: DeconStatsPayload,
  chapterHeadings: ReadonlyMap<number, DeconChapterHeadingInfo>,
): string {
  const b = stats.book;
  const lines: string[] = [
    '【全书计量统计（纯代码复算——报告里的数字以此为准）】',
    `章字数分布：${fmtDist(b.chapterChars)}`,
    `爽点段：${b.highlightCount} 处｜字数分布 ${fmtDist(b.highlightChars)}｜相邻间隔（章距）${fmtDist(b.highlightIntervalChapters)}`,
    `钩子计数：${fmtCounts(b.hooksByType)}`,
    `转折计数：${fmtCounts(b.transitionsByType)}`,
    `情绪拍分布：${fmtCounts(b.emotionalBeatsByType)}`,
    `信息差标注计数：${fmtCounts(b.infoGapByType)}`,
    `伏笔埋点：${b.foreshadowPlantedCount} 处（每万字 ${fmtNum(b.foreshadowDensityPer10k)} 处）`,
    `设定说明段字数分布：${fmtDist(b.expositionChars)}`,
    `铺垫-高潮跨度（钩子到其后首个核心事件的章距）：${fmtDist(b.hookToKernelChapterSpan)}`,
  ];
  if (stats.arcs.length > 0) {
    lines.push('弧级统计：');
    for (const a of stats.arcs) {
      // R1/F19：章区间标签锚定真实章标（章号从章标行解析，零序号算术）。
      lines.push(
        `- 弧 ${a.index}（${chapterRangeLabel(chapterHeadings, a.fromChapter, a.toChapter)}）：钩子 ${a.hookCount}｜转折 ${a.transitionCount}｜爽点 ${a.highlightCount}｜情绪拍 ${a.emotionalBeatCount}｜信息差 ${a.infoGapCount}｜伏笔 ${a.foreshadowPlantedCount}｜相位 ${fmtCounts(a.plotPhaseCounts)}`,
      );
    }
  }
  return lines.join('\n');
}

/** 章级 findings 聚合渲染（维分组——章评「章收束」输入面）。 */
function renderDeconFindingsForPrompt(entries: ReadonlyArray<{ pass: string; findings: DeconFindings }>): string {
  if (entries.length === 0) {
    return '（本章无手艺层发现——本会话未选手艺维，或所选维无章级面。）';
  }
  const blocks: string[] = [];
  for (const entry of entries) {
    const label = DECON_DIMENSIONS.find((d) => `p4:${d.id}` === entry.pass)?.label ?? entry.pass;
    const lines = [`【${label}】`];
    if (entry.findings.synthesis.trim().length > 0) lines.push(`小结：${entry.findings.synthesis.trim()}`);
    for (const f of entry.findings.findings) {
      lines.push(`- ${f.insight}`);
      lines.push(`  证据：${f.evidence.map((e) => `${paraRefOfRange(e.paraRange)}「${e.quote}」`).join('；')}`);
      lines.push(`  ${f.elaboration}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** 书级读法注入的书级问题单维度（维 1/3/5——design §3.2 书级面住 P5 读法）。 */
const DECON_P5_BOOK_QUESTIONNAIRE_DIMS: readonly DeconP4BookDimensionId[] = ['huoke', 'jiegou', 'shijieguan'];

/** 材料信息块（全量/分组/汇总三 prompt 共用）。 */
function bookMaterialInfoLines(input: { bookTitle: string; chapterCount: number; charCount: number }): string[] {
  return [
    '【材料信息】',
    `书名：${input.bookTitle}`,
    `规模：共 ${input.chapterCount} 章 / ${input.charCount >= 10_000 ? `约 ${(input.charCount / 10_000).toFixed(1)} 万字` : `${input.charCount} 字`}`,
  ];
}

/**
 * 单弧概要块渲染（全量/分组 prompt 共用；**章引用 = 真实章标原词**——R1/F19：chapters[0]
 * 可能是简介伪章使 index+1 整体偏移 1，章号一律从章标行解析、无章标章语义回落，零序号算术）。
 */
function renderDeconArcSynopsisBlock(
  arc: DeconArc,
  synopsesByChapter: ReadonlyMap<number, string>,
  chapterHeadings: ReadonlyMap<number, DeconChapterHeadingInfo>,
): string {
  const range = chapterRangeLabel(chapterHeadings, arc.fromChapter, arc.toChapter);
  const lines: string[] = [
    arc.title === null
      ? `【弧 ${arc.index}｜${range}｜${arc.chapterCount} 章】`
      : `【弧 ${arc.index}｜${range}｜${arc.chapterCount} 章｜${arc.title}】`,
  ];
  for (let ci = arc.fromChapter; ci <= arc.toChapter; ci++) {
    const syn = synopsesByChapter.get(ci);
    if (syn !== undefined) lines.push(`- ${chapterHeadings.get(ci)?.label ?? `材料章 ${ci}`}：${syn}`);
  }
  return lines.join('\n');
}

/**
 * 弧级贡献量（分组输入——每弧渲染块实长；与 prompt 装配同基非估算公式）。纯函数，供
 * splitDeconArcGroups（sansheng 分组纪律）消费。
 */
export function deconBookArcContributions(
  arcs: readonly DeconArc[],
  synopsesByChapter: ReadonlyMap<number, string>,
  chapterHeadings: ReadonlyMap<number, DeconChapterHeadingInfo>,
): number[] {
  return arcs.map((arc) => renderDeconArcSynopsisBlock(arc, synopsesByChapter, chapterHeadings).length);
}

export interface DeconP5BookPromptInput {
  bookTitle: string;
  chapterCount: number;
  charCount: number;
  arcs: readonly DeconArc[];
  synopsesByChapter: ReadonlyMap<number, string>;
  stats: DeconStatsPayload | null;
  /** 章标对照（R1/F19——对照表注入 + 章区间/概要行真实章标渲染）。 */
  chapterHeadings: ReadonlyMap<number, DeconChapterHeadingInfo>;
}

/** 书级读法 user prompt（材料信息 + 章标对照表 + 弧级概要聚合 + 统计摘要 + 维 1/3/5 书级问题单末置）。 */
export function buildDeconBookReadingUserPrompt(input: DeconP5BookPromptInput): string {
  const parts: string[] = [];
  parts.push(bookMaterialInfoLines(input).join('\n'));
  parts.push(renderDeconChapterHeadingTable(input.chapterHeadings));
  if (input.arcs.length > 0) {
    parts.push(
      ['【弧级概要（两级摘要——各章概要按剧情段分组）】', ...input.arcs.map((a) => renderDeconArcSynopsisBlock(a, input.synopsesByChapter, input.chapterHeadings))].join(
        '\n',
      ),
    );
  }
  if (input.stats !== null) parts.push(renderDeconStatsForPrompt(input.stats, input.chapterHeadings));
  parts.push(
    [
      '【书级问题单（读法的问题面——作答融进报告对应小节）】',
      ...DECON_P5_BOOK_QUESTIONNAIRE_DIMS.map((dim) => buildDeconP4BookQuestionnaire(dim)),
    ].join('\n\n'),
  );
  return parts.join('\n\n');
}

// ── 大书分组（CR-7——对齐 P4 弧级 sansheng 分组纪律：>150K 按弧拆 3-5 组）──

export interface DeconP5BookGroupPromptInput {
  bookTitle: string;
  chapterCount: number;
  charCount: number;
  /** 本组弧子集（splitDeconArcGroups 产出的组内弧序）。 */
  arcs: readonly DeconArc[];
  /** 组序（1 起）/ 总组数。 */
  groupIndex: number;
  groupTotal: number;
  synopsesByChapter: ReadonlyMap<number, string>;
  stats: DeconStatsPayload | null;
  /** 章标对照（R1/F19）。 */
  chapterHeadings: ReadonlyMap<number, DeconChapterHeadingInfo>;
}

/** 大书分组草稿 user prompt（材料信息 + 章标对照表 + 本组弧级概要 + 统计——书级问题单住汇总调用）。 */
export function buildDeconBookGroupUserPrompt(input: DeconP5BookGroupPromptInput): string {
  const parts: string[] = [];
  parts.push(
    [
      ...bookMaterialInfoLines(input),
      `分组说明：全书篇幅过大，已按剧情段分 ${input.groupTotal} 组分析——本组为第 ${input.groupIndex} 组，只覆盖输入给出的以下剧情段；跨组结论如有出入，保留分歧如实写。`,
    ].join('\n'),
  );
  parts.push(renderDeconChapterHeadingTable(input.chapterHeadings));
  parts.push(
    ['【本组弧级概要（两级摘要——各章概要按剧情段分组）】', ...input.arcs.map((a) => renderDeconArcSynopsisBlock(a, input.synopsesByChapter, input.chapterHeadings))].join(
      '\n',
    ),
  );
  if (input.stats !== null) parts.push(renderDeconStatsForPrompt(input.stats, input.chapterHeadings));
  return parts.join('\n\n');
}

export interface DeconP5BookSynthesisPromptInput {
  bookTitle: string;
  chapterCount: number;
  charCount: number;
  stats: DeconStatsPayload | null;
  /** 各组草稿（组序升序）。 */
  groupDrafts: readonly string[];
  /** 章标对照（R1/F19——汇总合成保留真实章标原词的真值源）。 */
  chapterHeadings: ReadonlyMap<number, DeconChapterHeadingInfo>;
}

/** 大书汇总合成 user prompt（材料信息 + 章标对照表 + 统计 + 各组草稿 + 维 1/3/5 书级问题单末置）。 */
export function buildDeconBookSynthesisUserPrompt(input: DeconP5BookSynthesisPromptInput): string {
  const parts: string[] = [];
  parts.push(bookMaterialInfoLines(input).join('\n'));
  parts.push(renderDeconChapterHeadingTable(input.chapterHeadings));
  if (input.stats !== null) parts.push(renderDeconStatsForPrompt(input.stats, input.chapterHeadings));
  parts.push(
    [
      '【分组草稿（大书按剧情段分组分析的各组产出——跨组结论如有出入保留分歧如实写，数字以上方统计为准；引用章节时保留草稿与章标对照表里的真实章标原词，不要按序号推算章号）】',
      ...input.groupDrafts.map((d, i) => `### 第 ${i + 1} 组草稿\n${d}`),
    ].join('\n'),
  );
  parts.push(
    [
      '【书级问题单（读法的问题面——作答融进报告对应小节）】',
      ...DECON_P5_BOOK_QUESTIONNAIRE_DIMS.map((dim) => buildDeconP4BookQuestionnaire(dim)),
    ].join('\n\n'),
  );
  return parts.join('\n\n');
}

export interface DeconP5ChapterPromptInput {
  bookTitle: string;
  chapterIndex: number;
  /** 本章章标签签（章标行原词或语义回落——R1/F19，替代 chapterTitle + 序号算术）。 */
  chapterLabel: string;
  facts: DeconFacts | null;
  labels: DeconChapterLabels | null;
  /** 该章各维章级 findings（pass='p4:<dim>'、unit='ch:N' 读回——聚合面）。 */
  findings: ReadonlyArray<{ pass: string; findings: DeconFindings }>;
}

/** 章评 user prompt（材料信息 + 本章概要/事实 + 本章打标 + 本章各维手艺发现）。 */
export function buildDeconChapterReviewUserPrompt(input: DeconP5ChapterPromptInput): string {
  const parts: string[] = [];
  parts.push(
    [
      '【材料信息】',
      `书名：${input.bookTitle}`,
      // R1/F19：本章定位用真实章标原词（章号从章标行解析，零序号算术）。
      `本章：${input.chapterLabel}`,
    ].join('\n'),
  );
  parts.push(['【本章概要与事实提取】', input.facts === null ? '（本章无事实提取记录。）' : renderDeconFactsForPrompt(input.facts)].join('\n'));
  parts.push(['【本章打标（P3a 计量）】', renderDeconLabelsForPrompt(input.labels)].join('\n'));
  parts.push(['【本章各维手艺发现（P4 章级）】', renderDeconFindingsForPrompt(input.findings)].join('\n'));
  return parts.join('\n\n');
}

export interface DeconP5ScenePromptInput {
  bookTitle: string;
  /** 选定序（0 起——分数降序）。 */
  sceneRank: number;
  sceneTotal: number;
  chapterIndex: number;
  /** 本章章标签签（章标行原词或语义回落——R1/F19，替代 chapterTitle + 序号算术）。 */
  chapterLabel: string;
  derived: string;
  blocks: readonly MaterialParagraphBlock[];
  window: DeconSceneWindow;
  /** 窗口内过滤后的本章标签（null = 无打标）。 */
  labels: DeconChapterLabels | null;
}

/** 细批 user prompt（场景定位 + 【P段号】正文 + 窗口内打标——mirror P1b/P3a 注入形态）。 */
export function buildDeconSceneAnnotationUserPrompt(input: DeconP5ScenePromptInput): string {
  const numbered: string[] = [];
  for (let i = input.window.from; i < input.window.to; i++) {
    numbered.push(`【P${i}】${input.derived.slice(input.blocks[i]!.start, input.blocks[i]!.end)}`);
  }
  return [
    [
      '【材料信息】',
      `书名：${input.bookTitle}`,
      // R1/F19：章定位用真实章标原词（零序号算术）；选定序 sceneRank 是候选自枚举（0 起 → 呈现 +1）。
      `本场：${input.chapterLabel} · 选定名场面第 ${input.sceneRank + 1} 场（共 ${input.sceneTotal} 场）`,
    ].join('\n'),
    [
      '【本场正文（【P段落号】标记每段开始；段落号是全文档全局编号）】',
      numbered.join('\n\n'),
      `（本场景段落号范围 P${input.window.from}–P${input.window.to - 1}；引用时只用该范围内实际出现的段落号）`,
    ].join('\n'),
    ['【本场打标（P3a 计量——仅落在本场窗口内的条目）】', renderDeconLabelsForPrompt(input.labels)].join('\n'),
  ].join('\n\n');
}

// ── system prompt（立场段前置共用 + 各 kind 输出契约——网文语境：操作化白话零学院名号）──

/** 书级读法输出骨架（问题单作答融进对应小节）。 */
const DECON_P5_BOOK_KIND_PROMPT = [
  '本次任务：把输入材料组织成一篇面向作者的书级读法报告（markdown）。按下面的骨架写，问题单的作答融进对应小节：',
  '# 《书名》拆书读法',
  '## 整体结构判定 —— 判定全书属于哪种结构式（总分总莲花式/递进阶梯式/并列无限式）；混合的话说明各占多少、怎么拼接；',
  '## 全书骨架 —— 起结框架（全书从什么起、到什么结）；冷热分半（前后半的节奏对比、大概在第几章换挡）；固定调度（贯穿全书反复出现的调度安排盘点）；',
  '## 核心节奏公式 —— 把全书反复的标准循环写成公式（例如 危机→试错→重开→布局→收网），标注各环节的典型章数与全书循环轮数；',
  '## 换地图逻辑 —— 全书换地图盘点：换了几次、每次主动还是被动、换之前的前兆（资源枯竭/战力崩坏/追杀）、换完怎么重新立规矩；',
  '## 获客漏斗与受众 —— 书名简介向读者承诺了什么、开篇怎么接住、留存设计复盘；类型三栏（类型特点/类型禁忌/惯用套路）；受众画像；',
  '## 四因总分解 —— 材料因（拿什么当材料）/形式因（组织成什么形态）/动力因（靠什么推着读者往下读）→ 目的因（最终为了给读者什么）；',
  '## 主题 —— 这本书最终讲什么、跟开篇承诺怎么呼应。',
  '写作要求：',
  '- 数字（章数/字数/间隔）以输入的计量统计为准，不要自己编数字；',
  '- 提到具体章节时，引用必须照抄输入「章节章标对照表」里的章标原词（含章号与标题）；禁止按材料内部序号自行推算章号；',
  '- 直接输出 markdown 正文，不要代码块包裹、不要任何前后缀解释。',
].join('\n');

/** 章评输出骨架（两级摘要之章级阅读面——导读 + 收束）。 */
const DECON_P5_CHAPTER_KIND_PROMPT = [
  '本次任务：为指定的一章写章评（markdown），两个小节：',
  '## 章导读 —— 这章在干什么：这章落在情节六步法的哪一环（情绪事件/欲望目标/困境阻碍/解决方法/行动解决/解决反馈）、在这一环上作者做了什么；章内节奏怎么走（结合打标的情绪拍与章主导相位）；',
  '## 章收束 —— 这章做对了什么：把输入里各维手艺发现聚合成一段有层次的收束——每条发现保留结论与关键证据（段落号+原文引文），按重要度排布；没有手艺发现时，基于打标与事实提取写这章值得学的两三处。',
  '写作要求：',
  '- 只依据输入材料，不编造正文里没有的内容；引用原文时用输入里带的原文引文并标注段落号；',
  '- 直接输出 markdown 正文，不要代码块包裹、不要任何前后缀解释。',
].join('\n');

/** 细批输出骨架（拉片子协议——场景结构/镜头缝合/对话三层/逐词全部操作化白话）。 */
const DECON_P5_SCENE_KIND_PROMPT = [
  '本次任务：对给定的名场面文本做细批（markdown，逐项分析）：',
  '## 场景定位 —— 这场戏在第几章、什么场合、在整章里承担什么功能；',
  '## 切入点 —— 这场戏从哪个时刻进入（不从最早的时刻讲起）、为什么从这里切；进入前读者只知道什么；',
  '## 信息密度控制 —— 这场给了多少新信息、给多快；哪些信息压住了没给、压住的在行文里怎么留存在感；',
  '## 场景结构 —— 主角这场想要什么、什么在拦着；开场时主角处境是好是坏；把这场按攻防转换切成几个节拍（每次一方压过另一方算一个节拍）逐拍标出；收场时处境比开场好了还是坏了（没变说明这场没推动）；转折落在哪个节拍；',
  '## 镜头语言 —— 转场怎么做的：直接跳，还是用动作/视线/一句话带过；切换叙述对象时镜头怎么交棒；',
  '## 场景缝合 —— 这场跟前后场的衔接是硬切（直接跳切）还是软切（过渡衔接）：用了什么缝法、为什么这里硬切不突兀/软切要缓一口气；',
  '## 视角游移 —— 叙述有没有为展示主角的强或惨临时切到旁边人物的视角：切在哪、切出去多久、效果是什么；没切则说明本场视角为什么稳；',
  '## 断章钩子 —— 本场若收在章尾：断章用了什么手法（悬念/反转/新信息/情绪高点）、为什么在这里断；不在章尾则说明本场怎么为章尾的断章蓄力；',
  '## 对话三层 —— 挑本场最重要的一组对话：说出口的（台词字面说了什么）/没说出口的（人物心里想但没说的）/说不出口的（连想都不能直说、只能靠动作和沉默带出来的）各是什么；',
  '## 逐词细读 —— 挑两三个最见功力的关键句，逐词问：为什么用这个词、换一个更省事的近义词会损失什么。',
  '写作要求：',
  '- 只依据给定正文与标注，不编造不存在的内容；引用原文逐字摘录并标注段落号；',
  '- 直接输出 markdown 正文，不要代码块包裹、不要任何前后缀解释。',
].join('\n');

/** 书级读法 system prompt（立场段 + 输出骨架）。 */
export const DECON_P5_BOOK_SYSTEM_PROMPT = [DECON_P4_STANCE_PROMPT, DECON_P5_BOOK_KIND_PROMPT].join('\n\n');

/** 大书分组草稿输出骨架（CR-7——只覆盖本组剧情段；终稿由汇总调用在各组草稿之上合成）。 */
const DECON_P5_BOOK_GROUP_KIND_PROMPT = [
  '本次任务：为一本篇幅过大的书写书级读法的分组草稿（markdown）。全书已按剧情段分成几组，你只分析输入给出的本组剧情段；终稿稍后会在各组草稿之上汇总合成。',
  '按下面的骨架写本组草稿：',
  '## 本组各段概览 —— 逐段一小段话：这段在全书里承担什么、段内节奏怎么走、段末把读者带向哪里；',
  '## 本组结构与节奏观察 —— 本组内反复出现的调度安排、标准循环、换地图事件；跨段的铺垫与回收怎么衔接；',
  '## 本组值得学的手艺点 —— 作者在这几段里做对了什么（提到具体章节时照抄输入章标对照表里的章标原词，从输入概要与统计里能确认的才写）。',
  '写作要求：',
  '- 数字（章数/字数/间隔）以输入的计量统计为准，不要自己编数字；',
  '- 只依据输入材料，不编造概要里没有的情节；',
  '- 直接输出 markdown 正文，不要代码块包裹、不要任何前后缀解释。',
].join('\n');

/** 大书分组草稿 system prompt（立场段 + 分组骨架——问题单与终稿骨架住汇总调用）。 */
export const DECON_P5_BOOK_GROUP_SYSTEM_PROMPT = [DECON_P4_STANCE_PROMPT, DECON_P5_BOOK_GROUP_KIND_PROMPT].join('\n\n');

/** 章评 system prompt（立场段 + 输出骨架）。 */
export const DECON_P5_CHAPTER_SYSTEM_PROMPT = [DECON_P4_STANCE_PROMPT, DECON_P5_CHAPTER_KIND_PROMPT].join('\n\n');

/** 细批 system prompt（立场段 + 拉片子协议骨架）。 */
export const DECON_P5_SCENE_SYSTEM_PROMPT = [DECON_P4_STANCE_PROMPT, DECON_P5_SCENE_KIND_PROMPT].join('\n\n');

// ── runner 结果与 deps ──

/** P5 运行统计（观测面——三 kind 共用形状）。 */
export interface DeconP5Stats {
  /** 材料章数。 */
  chapters: number;
  /** 断点 skip 的 unit 数（重入零重付面）。 */
  skipped: number;
  /** 本次新生成落库的 unit 数。 */
  generated: number;
  /** 零输入跳过章（章评无 facts/labels/findings、细批无相交块——CR-15 同款不 fail）。 */
  skippedNoInput: number;
  /** 名场面候选数（scene_annotation 观测面；其余 runner 恒 0）。 */
  sceneCandidates: number;
}

export type DeconP5Result =
  | { status: 'done'; stats: DeconP5Stats }
  | { status: 'paused'; stats: DeconP5Stats }
  | { status: 'cancelled'; stats: DeconP5Stats }
  | { status: 'capped'; message: string; stats: DeconP5Stats }
  | { status: 'failed'; message: string; stats: DeconP5Stats }
  | { status: 'stale'; message: string };

export interface DeconP5Deps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  /** 逐 unit running 进度事件注入（CR-8——runDeconPassSequence 传 stamped notify；直调测试缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
  /** 材料读点重试 sleep 注入（C4/F12——测试绕过真实等待）。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function emptyStats(chapters: number): DeconP5Stats {
  return { chapters, skipped: 0, generated: 0, skippedNoInput: 0, sceneCandidates: 0 };
}

/** 边界/门停走映射（CR-7——paused/cancelled/stale 如实，其余 failed）。 */
function boundaryToP5Result(stop: DeconBoundaryStop, stats: DeconP5Stats): DeconP5Result {
  if (stop.status === 'paused') return { status: 'paused', stats };
  if (stop.status === 'cancelled') return { status: 'cancelled', stats };
  return { status: stop.status, message: stop.message, stats };
}

// ── 输入读侧（惰性装载 + 容错——product 族坏行跳过，mirror p3Metrics 读回面）──

/** p3a labels 读回（product 表——坏行跳过；key = 章号）。 */
function loadDeconLabelsByChapter(jobId: string): Map<number, DeconChapterLabels> {
  const map = new Map<number, DeconChapterLabels>();
  for (const row of listDeconProducts(jobId, 'p3a')) {
    const parsed = deconChapterLabelsSchema.safeParse(row.payload);
    if (parsed.success) map.set(Number(row.unit), parsed.data);
  }
  return map;
}

/** P1b facts 读回（材料级键控——key = 章号）。 */
function loadDeconFactsByChapter(materialRef: string, derivedHash: string): Map<number, DeconFacts> {
  const map = new Map<number, DeconFacts>();
  for (const row of listDeconChapterFacts(materialRef, derivedHash)) map.set(row.chapterIndex, row.facts);
  return map;
}

/**
 * P4 章级 findings 读回聚合（product 表 pass='p4:<dim>'〔style 排除〕AND unit='ch:N'——
 * 章评「章收束」输入面；unit 内按 pass 升序确定序）。
 */
function loadDeconChapterFindingsByUnit(jobId: string): Map<string, Array<{ pass: string; findings: DeconFindings }>> {
  const byUnit = new Map<string, Array<{ pass: string; findings: DeconFindings }>>();
  for (const row of listDeconProducts(jobId)) {
    if (!row.pass.startsWith('p4:') || row.pass === 'p4:style') continue;
    if (!row.unit.startsWith('ch:')) continue;
    const parsed = deconFindingsSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const list = byUnit.get(row.unit) ?? [];
    list.push({ pass: row.pass, findings: parsed.data });
    byUnit.set(row.unit, list);
  }
  for (const list of byUnit.values()) {
    list.sort((a, b) => (a.pass < b.pass ? -1 : a.pass > b.pass ? 1 : 0));
  }
  return byUnit;
}

/** p3b 弧切分读回（缺席/坏行 → 单伪弧容错——两级摘要书级面照常装配）。 */
function loadDeconArcs(jobId: string, material: Material): DeconArc[] {
  const row = getDeconProduct(jobId, 'p3b', 'arcs');
  if (row !== null) {
    const parsed = deconArcsPayloadSchema.safeParse(row.payload);
    if (parsed.success) return parsed.data.arcs;
    getLogger().warn({ jobId }, 'decon p5: p3b arcs product malformed - falling back to single pseudo arc');
  }
  const first = material.chapters[0]!.index;
  const last = material.chapters[material.chapters.length - 1]!.index;
  return [
    {
      index: 0,
      title: null,
      fromChapter: first,
      toChapter: last,
      chapterCount: material.chapters.length,
      charCount: 0,
      origin: 'single',
    },
  ];
}

/** p3b 统计读回（缺席/坏行 → null——统计块省略，读法照跑）。 */
function loadDeconStats(jobId: string): DeconStatsPayload | null {
  const row = getDeconProduct(jobId, 'p3b', 'stats');
  if (row === null) return null;
  const parsed = deconStatsPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    getLogger().warn({ jobId }, 'decon p5: p3b stats product malformed - omitting stats block');
    return null;
  }
  return parsed.data;
}

// ── LLM 调用脚手架（三 kind 共用：预算门前置 → 调用 → cost 单源回写 → finishReason 权威停因）──

type DeconP5CallOutcome =
  | { ok: true; text: string }
  | { ok: false; kind: 'capped' | 'failed'; message: string };

/**
 * 单次报告生成调用（writer-draft 温 0.3）：预算门前置（超限 capped **不烧 token**）→ 调用 →
 * 实际记账（CR-13 usage 真值优先）并经 writeDeconCost 单源落 job 行 → finishReason='length'
 * 权威截断判定 → 升帽自动重试一次（重试 est 照样过预算门、actual 各记各的、每 attempt notify
 * note——相位可见）→ 仍截断按 P5 capped 语义诚实挂起（报告重生成廉价不落半程报告）→ 空回复
 * failed。**CR-4**：手写重试环退役，语义收口 deconRun.runDeconLlmCall 共享脚手架（帽倍率
 * DECON_LLM_RETRY_ESCALATE 单源）；本包装只剩 P5 语义映射（length→capped、error/empty→failed）。
 * capped/failed 的 pass_state 落库归调用方（capDeconUnit/failDeconUnit 需要 unit 串）。
 */
async function callDeconP5Generate(args: {
  generate: DeconGenerateText;
  jobId: string;
  job: DeconJob;
  costRef: { cost: DeconCost };
  pass: string;
  unit: string;
  system: string;
  user: string;
  maxTokens: number;
  unitLabel: string;
  nowIso: () => string;
  /** 逐 attempt note 事件注入（升帽重试相位可见——R2；缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
}): Promise<DeconP5CallOutcome> {
  const call = await runDeconLlmCall({
    jobId: args.jobId,
    pass: args.pass,
    unit: args.unit,
    slot: 'writer-draft',
    system: args.system,
    user: args.user,
    maxTokens: args.maxTokens,
    budget: args.job.budget,
    cost: args.costRef.cost,
    job: args.job,
    generate: args.generate,
    ...(args.notify !== undefined ? { notify: args.notify } : {}),
    nowIso: args.nowIso,
    label: args.unitLabel,
  });
  args.costRef.cost = call.cost;
  if (call.ok) return { ok: true, text: call.text };
  if (call.kind === 'budget-capped') return { ok: false, kind: 'capped', message: call.note };
  if (call.kind === 'length') {
    return { ok: false, kind: 'capped', message: `${call.note}——已挂起（不落半程报告），调整预算后续跑` };
  }
  return { ok: false, kind: 'failed', message: call.note }; // error / empty
}

/**
 * 报告落库（sanitize → report + pass_state done **同事务**——崩溃不留半状态）：contentMd
 * trim 后落库（空白回复已被调用脚手架拦）；hash 取落库面（trim 后 contentMd + anchors——
 * 与读侧重入比对同基）。成功递增 stats.generated。
 */
function commitDeconP5Report(args: {
  jobId: string;
  pass: string;
  kind: DeconReportKind;
  unit: string;
  contentMd: string;
  anchors: DeconSpan[];
  dimension: string | null;
  stats: DeconP5Stats;
  unitLabel: string;
  nowIso: () => string;
}): { ok: true } | { ok: false; result: DeconP5Result } {
  const contentMd = args.contentMd.trim();
  if (contentMd.length === 0) {
    const message = `${args.unitLabel}生成结果为空——已挂起（不落空报告）`;
    failDeconUnit(args.jobId, args.pass, args.unit, message, args.nowIso());
    return { ok: false, result: { status: 'failed', message, stats: args.stats } };
  }
  const outputHash = hashDeconReportOutput(contentMd, args.anchors);
  const wrote = getDb().transaction(() => {
    const ok = upsertDeconReport({
      jobId: args.jobId,
      kind: args.kind,
      unit: args.unit,
      contentMd,
      anchors: args.anchors,
      dimension: args.dimension,
      updatedAt: args.nowIso(),
    });
    if (ok) {
      writeDeconPassState(
        args.jobId,
        args.pass,
        args.unit,
        'done',
        { outputRef: `report:${args.kind}:${args.unit}`, outputHash },
        args.nowIso(),
      );
    }
    return ok;
  })();
  if (!wrote) {
    const message = `${args.unitLabel}报告落库被写侧门拒收（内部错误——payload 与契约漂移，请报告）`;
    failDeconUnit(args.jobId, args.pass, args.unit, message, args.nowIso());
    return { ok: false, result: { status: 'failed', message, stats: args.stats } };
  }
  args.stats.generated += 1;
  return { ok: true };
}

// ── 运行准备（共用前置——mirror p3Label 前置面）──

type DeconP5Prepare =
  | { ok: true; job: DeconJob; material: Material; derived: string; blocks: MaterialParagraphBlock[] }
  | { ok: false; result: DeconP5Result };

/**
 * 材料读点（C4/F12 读侧）：**CR-4 收口 deconRun.loadExtractableMaterial 共享 helper**（本文件
 * ~30 行平行实现退役）——行缺/零章中间态（pending/failed——reingest/watcher upsert 与本读点的
 * 竞态窗口）→ 有限重试窗口（~1s×10，常量单源 DECON_MATERIAL_LOAD_*）等收敛；真零章稳定态
 * （ready/low-confidence——章界判定已落）立即诚实失败；durable failed 快败（CR-5）同helper。
 * 测试经 deps.sleep 注入绕过真实等待（映射 helper 的 waitMs）。
 */
async function loadDeconP5Material(materialId: string, deps: DeconP5Deps): Promise<
  { ok: true; material: Material } | { ok: false; message: string }
> {
  return loadExtractableMaterial(materialId, deps.sleep !== undefined ? { waitMs: deps.sleep } : {});
}

async function prepareDeconP5(jobId: string, deps: DeconP5Deps, pass: string): Promise<DeconP5Prepare> {
  const nowIso = (): string => (deps.now ?? (() => new Date()))().toISOString();
  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) {
    if (gate.stop === 'paused') return { ok: false, result: { status: 'paused', stats: emptyStats(0) } };
    if (gate.stop === 'cancelled' || gate.stop === 'not-found') {
      return { ok: false, result: { status: 'cancelled', stats: emptyStats(0) } };
    }
    if (gate.stop === 'stale') return { ok: false, result: { status: 'stale', message: gate.message } };
    return { ok: false, result: { status: 'failed', message: gate.message, stats: emptyStats(0) } };
  }
  const job = gate.job;
  // C4-F16 写侧：材料级前置失败只 transitionDeconJob（job 行 error 承载错误面）——'all' 仅是
  // p5:book_reading 的合法 unit（单 unit pass），chapter_review（ch:N）/scene_annotation（scene:N）
  // 写 (pass,'all',failed) 是化石形态（清理谓词同判定，不新产）。
  const failPrepare = (message: string, chapters: number): DeconP5Prepare => {
    if (pass === 'p5:book_reading') failDeconUnit(jobId, pass, 'all', message, nowIso());
    else transitionDeconJob(jobId, 'fail', message);
    return { ok: false, result: { status: 'failed', message, stats: emptyStats(chapters) } };
  };
  const materialLoad = await loadDeconP5Material(extractMaterialId(job.materialRef), deps);
  if (!materialLoad.ok) {
    return failPrepare(materialLoad.message, 0);
  }
  const material = materialLoad.material;
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    return failPrepare('派生 .md 读取失败（缺失或车道不可解析）——无法装配输出基面', material.chapters.length);
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { ok: false, result: { status: 'stale', message: DECON_STALE_NOTE } };
  }
  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    return failPrepare('材料无有效段落（派生 .md 全空白）——无可产出面', material.chapters.length);
  }
  return { ok: true, job, material, derived, blocks };
}

/** tier belt（子 runner 被错档调用——编排错配防护：跳过 + warn 不空烧；job 缺行交由后续 gate 如实处理）。 */
function requireDeconP5Tier(jobId: string, pass: string, allowed: ReadonlySet<string>): DeconP5Result | null {
  const job = getDeconJob(jobId);
  if (job === null || allowed.has(job.tier)) return null;
  getLogger().warn({ jobId, tier: job.tier, pass }, 'decon p5: tier gate skipped this kind (wiring belt)');
  return { status: 'done', stats: emptyStats(0) };
}

/** 断点重入判定（report 面——hash 取读回行现值）。 */
function decideDeconReportReentry(
  jobId: string,
  pass: string,
  unit: string,
  kind: DeconReportKind,
): 'skip' | 'rerun' | 'capped-hold' {
  const state = getDeconPassState(jobId, pass, unit);
  const existing = getDeconReport(jobId, kind, unit);
  return decideDeconPassReentry(
    state,
    existing === null ? null : hashDeconReportOutput(existing.contentMd, existing.anchors),
  );
}

// ── runner 1/3：book_reading（coarse+，unit='all'）──

/**
 * 跑书级读法（pass='p5:book_reading'，unit='all'）。输入 = 弧级 synopsis 聚合 + p3b 统计 +
 * 维 1/3/5 书级问题单；断点重入（done+hash 一致 skip 零重付）；产物落 report 表
 * （kind='book_reading'；anchors 承载 R1/F19 章引用回查的可定位错位章 span——LLM 散文只核验
 * 标注不改写）。**CR-7 大书分组**：输入超限时不再硬失败——对齐 P4 弧级 sansheng 分组纪律，按弧
 * 贡献量拆 3-5 组组内串行多次 writer-draft 产**分组草稿**，再一次汇总调用（标准读法骨架 +
 * 问题单）合成终稿；断点粒度维持 unit='all'（组内串行非独立断点——中断后重入整 unit 重跑）。
 */
export async function runDeconP5BookReading(jobId: string, deps: DeconP5Deps = {}): Promise<DeconP5Result> {
  const nowIso = (): string => (deps.now ?? (() => new Date()))().toISOString();
  const prep = await prepareDeconP5(jobId, deps, 'p5:book_reading');
  if (!prep.ok) return prep.result;
  const { job, material } = prep;
  // 章标真值（R1/F19——prompt 对照表 / 弧概要渲染 / 引用回查三方共用的单源映射）。
  const chapterHeadings = buildChapterHeadings(prep.derived, material.chapters);

  const stats = emptyStats(material.chapters.length);
  const stop = checkDeconRunBoundary(jobId);
  if (stop !== null) return boundaryToP5Result(stop, stats);
  const unit = 'all';
  deps.notify?.({ jobId, status: 'running', pass: 'p5:book_reading', unit });

  const decision = decideDeconReportReentry(jobId, 'p5:book_reading', unit, 'book_reading');
  if (decision === 'skip') {
    stats.skipped = 1;
    return { status: 'done', stats };
  }

  // 输入装配（两级摘要书级面——弧级聚合非全书原文）。
  const synopsesByChapter = new Map<number, string>();
  for (const [ci, facts] of loadDeconFactsByChapter(job.materialRef, job.derivedHash)) {
    synopsesByChapter.set(ci, facts.synopsis);
  }
  const arcs = loadDeconArcs(jobId, material);
  const statsPayload = loadDeconStats(jobId);
  const user = buildDeconBookReadingUserPrompt({
    bookTitle: material.name,
    chapterCount: material.chapters.length,
    charCount: material.quality.charCount,
    arcs,
    synopsesByChapter,
    stats: statsPayload,
    chapterHeadings,
  });

  const generate = deps.generateText ?? getDeconLlmCore()?.generateText;
  if (generate === undefined) {
    const message = '拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试';
    failDeconUnit(jobId, 'p5:book_reading', unit, message, nowIso());
    return { status: 'failed', message, stats };
  }

  writeDeconPassState(jobId, 'p5:book_reading', unit, 'running', null, nowIso());
  const costRef = { cost: job.cost };
  const cappedOrFail = (outcome: { ok: false; kind: 'capped' | 'failed'; message: string }): DeconP5Result => {
    if (outcome.kind === 'capped') {
      capDeconUnit(jobId, 'p5:book_reading', unit, outcome.message, nowIso());
      return { status: 'capped', message: outcome.message, stats };
    }
    failDeconUnit(jobId, 'p5:book_reading', unit, outcome.message, nowIso());
    return { status: 'failed', message: outcome.message, stats };
  };

  let finalText: string;
  if (user.length <= DECON_P5_BOOK_INPUT_CHAR_LIMIT) {
    const call = await callDeconP5Generate({
      generate,
      jobId,
      job,
      costRef,
      pass: 'p5:book_reading',
      unit,
      system: DECON_P5_BOOK_SYSTEM_PROMPT,
      user,
      maxTokens: DECON_P5_BOOK_READING_MAX_TOKENS,
      unitLabel: '书级读法',
      nowIso,
      notify: deps.notify,
    });
    if (!call.ok) return cappedOrFail(call);
    finalText = call.text;
  } else {
    // CR-7：按弧分组（贡献量 = 渲染块实长）拆 3-5 组——组内串行产分组草稿，再汇总合成。
    const contributions = deconBookArcContributions(arcs, synopsesByChapter, chapterHeadings);
    const groups = splitDeconArcGroups(contributions, DECON_P5_BOOK_INPUT_CHAR_LIMIT);
    if (groups.length === 0) {
      const message = `书级读法输入装配超限（${user.length} 字符 > 上限 ${DECON_P5_BOOK_INPUT_CHAR_LIMIT}）且无弧级概要可分组（零 facts/零弧）——已诚实挂起（不静默截断）`;
      failDeconUnit(jobId, 'p5:book_reading', unit, message, nowIso());
      return { status: 'failed', message, stats };
    }
    const drafts: string[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const groupUser = buildDeconBookGroupUserPrompt({
        bookTitle: material.name,
        chapterCount: material.chapters.length,
        charCount: material.quality.charCount,
        arcs: groups[gi]!.map((i) => arcs[i]!),
        groupIndex: gi + 1,
        groupTotal: groups.length,
        synopsesByChapter,
        stats: statsPayload,
        chapterHeadings,
      });
      const call = await callDeconP5Generate({
        generate,
        jobId,
        job,
        costRef,
        pass: 'p5:book_reading',
        unit,
        system: DECON_P5_BOOK_GROUP_SYSTEM_PROMPT,
        user: groupUser,
        maxTokens: DECON_P5_BOOK_READING_MAX_TOKENS,
        unitLabel: `书级读法分组草稿（第 ${gi + 1}/${groups.length} 组）`,
        nowIso,
        notify: deps.notify,
      });
      if (!call.ok) return cappedOrFail(call);
      drafts.push(call.text);
    }
    const synthUser = buildDeconBookSynthesisUserPrompt({
      bookTitle: material.name,
      chapterCount: material.chapters.length,
      charCount: material.quality.charCount,
      stats: statsPayload,
      groupDrafts: drafts,
      chapterHeadings,
    });
    const call = await callDeconP5Generate({
      generate,
      jobId,
      job,
      costRef,
      pass: 'p5:book_reading',
      unit,
      system: DECON_P5_BOOK_SYSTEM_PROMPT,
      user: synthUser,
      maxTokens: DECON_P5_BOOK_READING_MAX_TOKENS,
      unitLabel: '书级读法汇总合成',
      nowIso,
      notify: deps.notify,
    });
    if (!call.ok) return cappedOrFail(call);
    finalText = call.text;
  }
  // R1/F19 章引用回查（单缝——全量/分组/汇总三路 finalText 唯一出口，commit 之前）：
  // 「第N章」类引用对照真实章标核验，错位只标注不改写——(a) 可定位错位章进 anchors；
  // (b) contentMd 末尾附「章引用校验」注记段；无错位零改动。
  const refCheck = checkDeconChapterReferences(finalText, material.chapters, chapterHeadings);
  const commit = commitDeconP5Report({
    jobId,
    pass: 'p5:book_reading',
    kind: 'book_reading',
    unit,
    contentMd: refCheck.contentMd,
    anchors: refCheck.anchors,
    dimension: null,
    stats,
    unitLabel: '书级读法',
    nowIso,
  });
  if (!commit.ok) return commit.result;
  return { status: 'done', stats };
}

// ── runner 2/3：chapter_review（fine+，unit='ch:N' 逐章）──

/**
 * 跑章评（pass='p5:chapter_review'，unit='ch:N'）：逐章 synopsis+facts+P3a 标签+该章各维
 * findings → 章导读+章收束 markdown。零输入章（无 facts/labels/findings）跳过+计数不 fail
 * （CR-15 同款——不落状态行，重跑幂等廉价）；findings 预注为空时基于 facts+labels 照跑。
 */
export async function runDeconP5ChapterReview(jobId: string, deps: DeconP5Deps = {}): Promise<DeconP5Result> {
  const tierGate = requireDeconP5Tier(jobId, 'p5:chapter_review', new Set(['fine', 'deep']));
  if (tierGate !== null) return tierGate;
  const nowIso = (): string => (deps.now ?? (() => new Date()))().toISOString();
  const prep = await prepareDeconP5(jobId, deps, 'p5:chapter_review');
  if (!prep.ok) return prep.result;
  const { job, material } = prep;
  const chapterHeadings = buildChapterHeadings(prep.derived, material.chapters);

  const stats = emptyStats(material.chapters.length);
  const factsByChapter = loadDeconFactsByChapter(job.materialRef, job.derivedHash);
  const labelsByChapter = loadDeconLabelsByChapter(jobId);
  const findingsByUnit = loadDeconChapterFindingsByUnit(jobId);
  let generate: DeconGenerateText | undefined;
  const costRef = { cost: job.cost };

  for (const chapter of material.chapters) {
    const stop = checkDeconRunBoundary(jobId);
    if (stop !== null) return boundaryToP5Result(stop, stats);
    const unit = `ch:${chapter.index}`;
    deps.notify?.({ jobId, status: 'running', pass: 'p5:chapter_review', unit });

    const decision = decideDeconReportReentry(jobId, 'p5:chapter_review', unit, 'chapter_review');
    if (decision === 'skip') {
      stats.skipped += 1;
      continue;
    }

    const facts = factsByChapter.get(chapter.index) ?? null;
    const labels = labelsByChapter.get(chapter.index) ?? null;
    const findings = findingsByUnit.get(unit) ?? [];
    if (facts === null && labels === null && findings.length === 0) {
      stats.skippedNoInput += 1;
      getLogger().warn(
        { jobId, chapterIndex: chapter.index },
        'decon p5: chapter review skipped for zero input (no facts/labels/findings) - not failing the pass',
      );
      continue;
    }

    if (generate === undefined) {
      generate = deps.generateText ?? getDeconLlmCore()?.generateText;
      if (generate === undefined) {
        const message = '拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试';
        failDeconUnit(jobId, 'p5:chapter_review', unit, message, nowIso());
        return { status: 'failed', message, stats };
      }
    }

    // R1/F19：章定位标签 = 真实章标行原词（章号从章标行解析，零序号算术）。
    const chapterLabel = chapterHeadings.get(chapter.index)?.label ?? `材料章 ${chapter.index}`;
    writeDeconPassState(jobId, 'p5:chapter_review', unit, 'running', null, nowIso());
    const user = buildDeconChapterReviewUserPrompt({
      bookTitle: material.name,
      chapterIndex: chapter.index,
      chapterLabel,
      facts,
      labels,
      findings,
    });
    const call = await callDeconP5Generate({
      generate,
      jobId,
      job,
      costRef,
      pass: 'p5:chapter_review',
      unit,
      system: DECON_P5_CHAPTER_SYSTEM_PROMPT,
      user,
      maxTokens: DECON_P5_CHAPTER_REVIEW_MAX_TOKENS,
      unitLabel: `章评（${chapterLabel}）`,
      nowIso,
      notify: deps.notify,
    });
    if (!call.ok) {
      if (call.kind === 'capped') {
        capDeconUnit(jobId, 'p5:chapter_review', unit, call.message, nowIso());
        return { status: 'capped', message: call.message, stats };
      }
      failDeconUnit(jobId, 'p5:chapter_review', unit, call.message, nowIso());
      return { status: 'failed', message: call.message, stats };
    }
    const commit = commitDeconP5Report({
      jobId,
      pass: 'p5:chapter_review',
      kind: 'chapter_review',
      unit,
      contentMd: call.text,
      anchors: [],
      dimension: null,
      stats,
      unitLabel: `章评（${chapterLabel}）`,
      nowIso,
    });
    if (!commit.ok) return commit.result;
  }
  return { status: 'done', stats };
}

// ── runner 3/3：scene_annotation（deep，unit='scene:N'）──

/**
 * 跑名场面细批（pass='p5:scene_annotation'）：候选纯代码（密度峰+核心事件+情绪拍评分 top N
 * 非相邻去重——同输入同选择）→ 每场窗口（整章或峰值扩展窗）拉片子细批 → markdown，anchors
 * = 窗口 span。零分量书（全章 score=0）零场景诚实完成（无可细批的密度峰）。
 */
export async function runDeconP5SceneAnnotation(jobId: string, deps: DeconP5Deps = {}): Promise<DeconP5Result> {
  const tierGate = requireDeconP5Tier(jobId, 'p5:scene_annotation', new Set(['deep']));
  if (tierGate !== null) return tierGate;
  const nowIso = (): string => (deps.now ?? (() => new Date()))().toISOString();
  const prep = await prepareDeconP5(jobId, deps, 'p5:scene_annotation');
  if (!prep.ok) return prep.result;
  const { job, material, derived, blocks } = prep;
  const chapterHeadings = buildChapterHeadings(derived, material.chapters);

  const stats = emptyStats(material.chapters.length);
  const factsByChapter = loadDeconFactsByChapter(job.materialRef, job.derivedHash);
  const labelsByChapter = loadDeconLabelsByChapter(jobId);
  const chapterChars = chapterCharCounts(blocks, material.chapters);
  const candidates = selectDeconSceneCandidates(material.chapters, chapterChars, labelsByChapter, factsByChapter);
  stats.sceneCandidates = candidates.length;
  let generate: DeconGenerateText | undefined;
  const costRef = { cost: job.cost };

  for (let rank = 0; rank < candidates.length; rank++) {
    const chapterIndex = candidates[rank]!;
    const stop = checkDeconRunBoundary(jobId);
    if (stop !== null) return boundaryToP5Result(stop, stats);
    const unit = `scene:${rank}`;
    deps.notify?.({ jobId, status: 'running', pass: 'p5:scene_annotation', unit });

    const decision = decideDeconReportReentry(jobId, 'p5:scene_annotation', unit, 'scene_annotation');
    if (decision === 'skip') {
      stats.skipped += 1;
      continue;
    }

    const chapter = material.chapters.find((c) => c.index === chapterIndex);
    const window =
      chapter === undefined
        ? null
        : pickDeconSceneWindow(blocks, chapter, labelsByChapter.get(chapterIndex), factsByChapter.get(chapterIndex));
    if (chapter === undefined || window === null) {
      stats.skippedNoInput += 1;
      getLogger().warn(
        { jobId, chapterIndex },
        'decon p5: scene candidate has no intersecting blocks - skipped without failing the pass',
      );
      continue;
    }

    if (generate === undefined) {
      generate = deps.generateText ?? getDeconLlmCore()?.generateText;
      if (generate === undefined) {
        const message = '拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试';
        failDeconUnit(jobId, 'p5:scene_annotation', unit, message, nowIso());
        return { status: 'failed', message, stats };
      }
    }

    // R1/F19：章定位 = 真实章标行原词（零序号算术）；rank 是候选选定序自枚举（0 起 → 呈现 +1）。
    const chapterLabel = chapterHeadings.get(chapterIndex)?.label ?? `材料章 ${chapterIndex}`;
    writeDeconPassState(jobId, 'p5:scene_annotation', unit, 'running', null, nowIso());
    const labels = labelsByChapter.get(chapterIndex);
    const user = buildDeconSceneAnnotationUserPrompt({
      bookTitle: material.name,
      sceneRank: rank,
      sceneTotal: candidates.length,
      chapterIndex,
      chapterLabel,
      derived,
      blocks,
      window,
      labels: labels === undefined ? null : labelsWithinWindow(labels, window),
    });
    const call = await callDeconP5Generate({
      generate,
      jobId,
      job,
      costRef,
      pass: 'p5:scene_annotation',
      unit,
      system: DECON_P5_SCENE_SYSTEM_PROMPT,
      user,
      maxTokens: DECON_P5_SCENE_ANNOTATION_MAX_TOKENS,
      unitLabel: `细批第 ${rank + 1} 场（${chapterLabel}）`,
      nowIso,
      notify: deps.notify,
    });
    if (!call.ok) {
      if (call.kind === 'capped') {
        capDeconUnit(jobId, 'p5:scene_annotation', unit, call.message, nowIso());
        return { status: 'capped', message: call.message, stats };
      }
      failDeconUnit(jobId, 'p5:scene_annotation', unit, call.message, nowIso());
      return { status: 'failed', message: call.message, stats };
    }
    const commit = commitDeconP5Report({
      jobId,
      pass: 'p5:scene_annotation',
      kind: 'scene_annotation',
      unit,
      contentMd: call.text,
      anchors: [window.span],
      dimension: null,
      stats,
      unitLabel: `细批第 ${rank + 1} 场（${chapterLabel}）`,
      nowIso,
    });
    if (!commit.ok) return commit.result;
  }
  return { status: 'done', stats };
}

// ── 伞面（tier 门——design §9 序：book_reading〔coarse+〕→ chapter_review〔fine+〕→ scene_annotation〔deep〕）──

/** 伞面 stats 合并（skip/generated/零输入累加；候选面唯 scene runner 产出——直取）。 */
function mergeDeconP5Stats(into: DeconP5Stats, from: DeconP5Stats): void {
  into.skipped += from.skipped;
  into.generated += from.generated;
  into.skippedNoInput += from.skippedNoInput;
  into.sceneCandidates = from.sceneCandidates;
}

/**
 * 跑 P5 全 kind（tier 内判）：coarse=只书级读法；fine=+章评；deep=+名场面细批。逐 kind
 * 先跑先停（capped/failed/stale/paused 如实上抛——断点底座兜重入）；任一 kind 非 done 即停
 * 不续跑后续 kind；全 done 返回合并 stats（generated/skipped 跨 kind 累计）。W5 编排可挂
 * 本伞面（单相位）或三个子 runner（分相位——子 runner 自带 tier belt，错档调用跳过不空烧）。
 */
export async function runDeconP5(jobId: string, deps: DeconP5Deps = {}): Promise<DeconP5Result> {
  const book = await runDeconP5BookReading(jobId, deps);
  if (book.status !== 'done') return book;
  const merged: DeconP5Stats = { ...book.stats };
  let job = getDeconJob(jobId);
  if (job !== null && (job.tier === 'fine' || job.tier === 'deep')) {
    const chapters = await runDeconP5ChapterReview(jobId, deps);
    if (chapters.status !== 'done') return chapters;
    mergeDeconP5Stats(merged, chapters.stats);
    job = getDeconJob(jobId);
  }
  if (job !== null && job.tier === 'deep') {
    const scenes = await runDeconP5SceneAnnotation(jobId, deps);
    if (scenes.status !== 'done') return scenes;
    mergeDeconP5Stats(merged, scenes.stats);
  }
  return { status: 'done', stats: merged };
}
