import { MATERIAL_CHAPTER_CONFIDENCE, MATERIAL_CHAPTER_METHODS } from './material';
import type { MaterialChapterConfidence, MaterialChapterMethod } from './material';

// ── Story 10.1：文档级智能分章器（纯函数，design §2.2/§2.3）──
//
// 定位：整本外部材料（小说/讲义）→ 章切分的**文档级**边界识别。与 8.3 语义分块红线（章内检索
// 分块 `chunkChapter`）是两个粒度：本模块只找「章从哪开始」，**绝不切章内正文**——章内切分
// 永远归 chunkChapter（段落原子/无 overlap/禁固定窗口硬切，红线复用、禁另写切分器）。
//
// 两段式分章（D2 拍板）：本模块是第一段（正则表驱动 + 置信分级，纯代码可解释）；低置信分流
// （≥2 万字 LLM 兜底一次 / <2 万字伪章直进）归摄取编排（shell materialIngest，B 波）——语义
// 边界判别按范式判据归 LLM，本模块零 LLM、零网络、零 Date/random（同输入同输出）。
//
// 章标记协议（design §2.3，派生 .md 人工校对面）：独立行 HTML 注释
// `<!-- mat-chapter index=N title="…" method=… -->`，置于该章首段之前；method 属性判别裁决来源
// （manual = 人工裁决最高优先，重摄取保留不重分章——往返序列化必须保留 method，F-03）。
//
// expected_downstream_consumers:
// - 10.1 摄取编排 materialIngest（shell，B 波）：splitChapters 正则段 + 置信分流入口。
// - 10.3 小说拆解管线：章可寻址（read_file 读派生 .md + parseChapterMarkers 取章界）。
// - 10.2 经验文档管线：锚定上游（「无锚即丢」的锚供给——段落号+字符区间由摄取时保存）。
// - C5 已有作品导入：splitChapters 直调（分章复用面——正则 50+ 格式覆盖先行，C5.1「80% 自动
//   分章」的 20% 兜底走人工校对，同 §2.3 标记）。
// - 同1.1：提取器接口（ADR-10）小说文本提取器路径复用本分章器（medium=community_data 特例）。

/**
 * 章标格式表条目。`format` 是格式族标签（人读 + matchedFormats 回报——「按什么格式切的」
 * 可解释）；`regex` 一律首尾锚定、对**单行 trim 后文本**（markdown ATX 前缀已剥）整行匹配。
 */
export interface ChapterHeadingPattern {
  id: string;
  regex: RegExp;
  format: string;
}

/** 汉字数字字族（含大写数字：壹贰叁…；零〇两均在——「第两百零三章」类全兼容）。 */
const HANZI_NUMERAL_CLASS = '一二三四五六七八九十百千万亿零〇两壹贰叁肆伍陆柒捌玖拾佰仟萬';

/**
 * 标题尾（需分隔符族）：标题必须在「数+量词」头之后，且以空白或显式分隔符起始——
 * 「第一章的手稿不见了」这类正文行（量词后直接跟字）不会误命中。分隔符+标题整体可选
 * （裸章标「第一章」无尾同样命中，title = null）。
 */
const TITLED_TAIL = '(?:(?:[ \\t　]+|[：:、，,·・.．（][ \\t　]*)(?<title>\\S.*))?$';

/**
 * 标题尾（直接衔接族）：分隔符自身已闭合（）】），标题可直接衔接，也容忍其后的空白。
 */
const DIRECT_TAIL = '(?:[ \\t　]*(?<title>\\S.*))?$';

/** 第X量词族的量词字表（卷部章回节集话幕场篇辑册——中文主族全覆盖）。 */
const UNIT_CHARS = ['卷', '部', '章', '回', '节', '集', '话', '幕', '场', '篇', '辑', '册'] as const;

/** 数字系统 × 量词的交叉表（格式族计数主来源）。 */
const NUMERAL_SYSTEMS = [
  { key: 'hanzi', label: '汉字数字', cls: HANZI_NUMERAL_CLASS },
  { key: 'arabic', label: '阿拉伯数字', cls: '0-9' },
  { key: 'fullwidth', label: '全角数字', cls: '０-９' },
] as const;

/** 第X量词族：12 量词 × 3 数字系统 = 36 条（第X卷/第X部/…/第X册，汉字/阿拉伯/全角各一）。 */
const UNIT_PATTERNS: ChapterHeadingPattern[] = [];
for (const unit of UNIT_CHARS) {
  for (const sys of NUMERAL_SYSTEMS) {
    UNIT_PATTERNS.push({
      id: `di-${unit}-${sys.key}`,
      format: `第X${unit}·${sys.label}`,
      regex: new RegExp(`^第[${sys.cls}]+${unit}${TITLED_TAIL}`),
    });
  }
}

/**
 * 章标正则库（表驱动，69 格式）。中文主族全覆盖：第X卷/章/回/节/集/话（汉字数字含零两百、
 * 阿拉伯、全角）、量词前置（卷一）、【第X章】/（一）/N. 独立行、Chapter/CHAPTER、序章/楔子/
 * 引子/尾声/终章/番外篇、日期体/日记体、汉字数字独立行、上/中/下、罗马数字。**覆盖优先**
 * （C5 复用面：80% 自动分章的格式面）——误命中由置信启发式（大段游离→low）与 LLM 兜底/
 * 人工校对兜住，宁多认不漏认。
 */
export const CHAPTER_HEADING_PATTERNS: readonly ChapterHeadingPattern[] = [
  ...UNIT_PATTERNS,
  { id: 'unit-first', format: '卷一·量词前置', regex: new RegExp(`^[卷部册集辑][0-9０-９${HANZI_NUMERAL_CLASS}]+${TITLED_TAIL}`) },
  { id: 'bracket-cn', format: '【第X章】', regex: new RegExp(`^【第[${HANZI_NUMERAL_CLASS}0-9０-９]+[卷部章回节]】${DIRECT_TAIL}`) },
  { id: 'bracket-ascii', format: '[第X章]', regex: new RegExp(`^\\[第[${HANZI_NUMERAL_CLASS}0-9０-９]+[卷部章回节]\\]${DIRECT_TAIL}`) },
  // ── 特殊章名族（独立词 + 可选标题尾）──
  { id: 'xuzhang', format: '序章', regex: new RegExp(`^序章${TITLED_TAIL}`) },
  { id: 'xuyan', format: '序言', regex: new RegExp(`^序言${TITLED_TAIL}`) },
  { id: 'qianyan', format: '前言', regex: new RegExp(`^前言${TITLED_TAIL}`) },
  { id: 'xiemu', format: '楔子', regex: new RegExp(`^楔子${TITLED_TAIL}`) },
  { id: 'yinzi', format: '引子', regex: new RegExp(`^引子${TITLED_TAIL}`) },
  { id: 'yinyan', format: '引言', regex: new RegExp(`^引言${TITLED_TAIL}`) },
  { id: 'xumu', format: '序幕', regex: new RegExp(`^序幕${TITLED_TAIL}`) },
  { id: 'kaipian', format: '开篇', regex: new RegExp(`^开篇${TITLED_TAIL}`) },
  { id: 'weisheng', format: '尾声', regex: new RegExp(`^尾声${TITLED_TAIL}`) },
  { id: 'houji', format: '后记', regex: new RegExp(`^后记${TITLED_TAIL}`) },
  { id: 'zhongzhang', format: '终章', regex: new RegExp(`^终章${TITLED_TAIL}`) },
  { id: 'zuizhongzhang', format: '最终章', regex: new RegExp(`^最终章${TITLED_TAIL}`) },
  { id: 'fanwai', format: '番外（含番外N/番外篇）', regex: new RegExp(`^番外(?:[0-9０-９一二三四五六七八九十百]*(?:篇|章)?)?${TITLED_TAIL}`) },
  { id: 'waizhuan', format: '外传', regex: new RegExp(`^外传(?:[0-9０-９一二三四五六七八九十百]*(?:篇|章)?)?${TITLED_TAIL}`) },
  { id: 'fulu', format: '附录（含附录A/附录三）', regex: new RegExp(`^附录[0-9A-Za-z０-９一二三四五六七八九十]*${TITLED_TAIL}`) },
  { id: 'zhengwen', format: '正文（正文起卷标记）', regex: new RegExp(`^正文${TITLED_TAIL}`) },
  // ── 拉丁/序号族 ──
  { id: 'chapter-en', format: 'Chapter N', regex: new RegExp(`^(?:[Cc]hapter|CHAPTER)[ \\t]+[0-9０-９IVXivx]+${TITLED_TAIL}`) },
  { id: 'paren-hanzi', format: '（一）标题', regex: new RegExp(`^[（(][${HANZI_NUMERAL_CLASS}]+[)）]${DIRECT_TAIL}`) },
  { id: 'paren-arabic', format: '（1）标题', regex: new RegExp(`^[（(][0-9０-９]+[)）]${DIRECT_TAIL}`) },
  { id: 'cn-dunhao', format: '一、标题（汉字数字加顿号）', regex: new RegExp(`^[一二三四五六七八九十百]+、${DIRECT_TAIL}`) },
  { id: 'cn-standalone', format: '汉字数字独立行', regex: /^[一二三四五六七八九十百千零〇两]{1,6}$/ },
  { id: 'num-standalone', format: '纯数字独立行', regex: /^[0-9０-９]{1,4}$/ },
  { id: 'shang-zhong-xia', format: '上/中/下', regex: /^[上中下]$/ },
  { id: 'shang-pian', format: '上篇/中篇/下篇', regex: new RegExp(`^[上中下][篇部卷册集辑]${TITLED_TAIL}`) },
  // ── 日期体/日记体（先于数字加点：dotted 日期「1998.12.1」归日期族，不落 1. 序号族）──
  { id: 'date-cn', format: '2024年3月5日', regex: new RegExp(`^[0-9０-９]{4}年[0-9０-９]{1,2}月[0-9０-９]{1,2}日${TITLED_TAIL}`) },
  { id: 'date-iso', format: '2024-03-05', regex: /^[0-9０-９]{4}[-/／．.][0-9０-９]{1,2}[-/／．.][0-9０-９]{1,2}$/ },
  { id: 'date-diary', format: '3月5日（日记体）', regex: new RegExp(`^[0-9０-９]{1,2}月[0-9０-９]{1,2}日(?:[ \\t\u3000]*(?:星期|周|礼拜)[一二三四五六日天])?${TITLED_TAIL}`) },
  { id: 'num-dot', format: '1. 标题（数字加点/顿号独立行）', regex: new RegExp(`^[0-9０-９]+[．.、]${DIRECT_TAIL}`) },
  // ── 罗马数字 ──
  { id: 'roman-latin', format: '罗马数字 I/II/III', regex: /^[IVXLCDM]{1,6}$/ },
  { id: 'roman-unicode', format: '罗马数字 Ⅰ/Ⅱ/Ⅲ', regex: /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]{1,3}$/ },
];

// ── 行扫描（确定性，无 Date/random）──

interface LineSpan {
  /** 物理行号（0 起）。 */
  index: number;
  /** 行首偏移（含行首缩进）。 */
  start: number;
  /** 行尾偏移（不含 \n）。 */
  end: number;
  /** trim 后行文本（BOM/空白/行尾 \r 均剥）。 */
  trimmed: string;
}

function scanLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  let index = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    lines.push({ index, start, end, trimmed: text.slice(start, end).trim() });
    if (nl === -1) break;
    start = nl + 1;
    index += 1;
  }
  return lines;
}

/** 剥 markdown ATX 标题前缀（`## 第一章` → `第一章`）——md/epub 来源材料的章标同样可识别。 */
function stripAtx(line: string): string {
  return line.replace(/^#{1,6}[ \t]+/, '');
}

/**
 * 整行章标匹配：对 trim + 剥 ATX 后的行按表序首个命中返回格式族与标题（标题尾命名组提取，
 * 无标题 = null）。表序即优先级——通用族在前，专形族在后。
 */
function matchHeadingLine(
  line: string,
): { format: string; title: string | null } | null {
  const stripped = stripAtx(line);
  for (const pattern of CHAPTER_HEADING_PATTERNS) {
    const m = pattern.regex.exec(stripped);
    if (m) {
      const title = m.groups?.title?.trim() ?? null;
      return { format: pattern.format, title: title === '' ? null : title };
    }
  }
  return null;
}

// ── splitChapters：正则分章 + 置信分级启发式 ──

/**
 * 高置信最小独立命中行数（design §2.2「命中 ≥3」）。≤2 命中 → low（情报不足，不足以下判）。
 */
export const SPLIT_HIGH_MIN_HITS = 3;

/**
 * 高置信覆盖率下限（design §2.2「覆盖率 ≥95%」）：首标题前游离正文（前言/封面/简介）占比
 * ≤5% 才算高——大段前置正文说明章界不覆盖全文。
 */
export const SPLIT_HIGH_COVERAGE = 0.95;

/**
 * 高置信间距均匀度上限：相邻章段长度的变异系数（stdev/mean，总体标准差）。启发式锚点非实测
 * ——dogfood 校准点：真实网文章长 2000-6000 字分布 CV 典型 ≤0.5，0.9 是宽容上限（容单章
 * 长短差但仍拦「间隔忽长忽短」的漏检形态）。
 */
export const SPLIT_HIGH_CV_MAX = 0.9;

/**
 * 大段游离判定倍数（design §2.2「大段游离 → low」）：任一章段长度 > 中位段长的 8 倍 → 疑似
 * 漏检标题（典型形态：目录页连续章标行 + 正文整段游离）→ low，交 LLM 兜底/伪章/人工校对。
 */
export const SPLIT_DRIFT_RATIO = 8;

/** 分章置信（机器三档；`manual` 是章标记层概念，不进本函数输出）。 */
export type SplitConfidence = 'high' | 'medium' | 'low';

/**
 * 单个材料章 span（文档级；**不含 para 区间**——para 编号的基面是派生 .md 归一化文本〔标记
 * 插入后布局不同〕，由摄取编排对最终文本计算，避免双基面漂移）。
 */
export interface SplitChapterSpan {
  /** 材料内章号（0 起，跳过纯空白段后顺序编号）。 */
  index: number;
  /** 章题（章标行尾提取；无标题 = null；段首非章标的前导段也是 null）。 */
  title: string | null;
  /** 章起点（该章标题行的**行首**偏移，含缩进；前导段的起点 0）。半开区间 [start, end)。 */
  charStart: number;
  /** 章终点（下一章标题行行首，或全文末）。UTF-16 code unit。 */
  charEnd: number;
}

export interface SplitChaptersResult {
  chapters: SplitChapterSpan[];
  confidence: SplitConfidence;
  /** 命中的格式族标签（首现序去重——「按什么格式切的」可解释回报）。 */
  matchedFormats: string[];
}

/**
 * 文档级正则分章（两段式的第一段，D2）。
 *
 * 章界规则：标题行**行首** = 章起点；章含自身标题行，到下一标题行行首（半开区间）；首标题前
 * 的前导正文（非纯空白时）自成一章（title null）；纯空白段不产章；无任何命中 → 全文单章
 * （title null）。空文本/纯空白 → `chapters: []`。
 *
 * 置信启发式（纯代码可解释，design §2.2）：
 * 1. 命中 < SPLIT_HIGH_MIN_HITS（≤2）→ **low**；
 * 2. 章段长度最大值 > 中位数 × SPLIT_DRIFT_RATIO（大段游离，漏检信号）→ **low**；
 * 3. 覆盖率（首标题前正文占比 ≤5%）不足 → **medium**；
 * 4. 章段长度变异系数 > SPLIT_HIGH_CV_MAX（间距忽长忽短）→ **medium**；
 * 5. 其余（≥3 命中 + 无游离 + 均匀 + 全覆盖）→ **high**。
 *
 * 消费约定：high/medium 直用（method='regex'）；low 的分流（≥2 万字 LLM 兜底 / <2 万字伪章）
 * 归摄取编排——本函数不调用 LLM、不编章界（AC2「不硬给、不编内容」）。
 */
export function splitChapters(text: string): SplitChaptersResult {
  if (text.trim() === '') {
    return { chapters: [], confidence: 'low', matchedFormats: [] };
  }
  const lines = scanLines(text);
  const headingStarts: number[] = [];
  const headingTitles = new Map<number, string | null>();
  const matchedFormats: string[] = [];
  for (const line of lines) {
    if (line.trimmed === '') continue;
    const hit = matchHeadingLine(line.trimmed);
    if (!hit) continue;
    headingStarts.push(line.start);
    headingTitles.set(line.start, hit.title);
    if (!matchedFormats.includes(hit.format)) matchedFormats.push(hit.format);
  }

  // 边界 = 全文首尾 + 各标题行行首；相邻段纯空白（前导空白/相邻标题已被行界切开的空档）不产章
  const bounds = [...new Set<number>([0, ...headingStarts, text.length])].sort((a, b) => a - b);
  const chapters: SplitChapterSpan[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const charStart = bounds[i];
    const charEnd = bounds[i + 1];
    if (text.slice(charStart, charEnd).trim() === '') continue;
    chapters.push({
      index: chapters.length,
      title: headingTitles.get(charStart) ?? null,
      charStart,
      charEnd,
    });
  }
  return { chapters, confidence: assessConfidence(text, headingStarts), matchedFormats };
}

/**
 * 置信分级（纯代码可解释启发式；章段 = 相邻标题行行首间距 + 末标题到全文末的尾段——尾段
 * 超长同样是漏检信号，纳入游离判定）。
 */
function assessConfidence(text: string, headingStarts: readonly number[]): SplitConfidence {
  const hits = headingStarts.length;
  if (hits < SPLIT_HIGH_MIN_HITS) return 'low';
  const gaps: number[] = [];
  for (let i = 1; i < headingStarts.length; i++) gaps.push(headingStarts[i] - headingStarts[i - 1]);
  gaps.push(text.length - headingStarts[hits - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = (sorted[Math.floor(sorted.length / 2)] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
  if (gaps.some((g) => g > median * SPLIT_DRIFT_RATIO)) return 'low'; // 大段游离（漏检信号）
  const coverage = 1 - headingStarts[0] / text.length; // 首标题前游离正文占比的补数
  if (coverage < SPLIT_HIGH_COVERAGE) return 'medium';
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  if (Math.sqrt(variance) / mean > SPLIT_HIGH_CV_MAX) return 'medium'; // 间距忽长忽短
  return 'high';
}

// ── extractHeadingCandidates：弱模式候选行（LLM 兜底约束消费）──

/** 弱候选行长上限（章标题行几乎不可能超过 30 字——超长行走正文，不进候选浪费预算）。 */
export const HEADING_CANDIDATE_MAX_CHARS = 30;

/** 行尾是这些字 = 叙述句/引文而非标题（「？」「！」允许——问句/感叹式章题常见，宁多留 LLM 裁）。 */
const NOT_TITLE_ENDINGS = new Set(['。', '；', '，', '、', '…', '—', '：', ':', ',', ';', '.', '）', ')', '」', '』', '】']);

/** 转场标记（mirror chapter-chunking THEMATIC_BREAK_RE——候选行排除，非章标）。 */
const THEMATIC_BREAK_RE = /^([-_*])(?:[ \t]*\1){2,}$/;

export interface HeadingCandidate {
  /** 物理行号（0 起）。 */
  lineIndex: number;
  /** 候选行文本（trim + 剥 ATX 后）。 */
  text: string;
}

/**
 * 章标候选行枚举（弱模式大网，供 LLM 兜底**约束式**消费——prompt 只允许 LLM 从候选行里
 * 选/拒，LLM 无法幻觉出不存在的位置，切点合法性天然可校验）。
 *
 * 收录规则（按行）：
 * 1. 强命中：任一 CHAPTER_HEADING_PATTERNS 命中（无论是否段首）；
 * 2. 弱补充：**段首行**（空行后首行/全文首行）+ 长度 ≤ HEADING_CANDIDATE_MAX_CHARS + 行尾
 *    非叙述句读/引文收尾；转场标记行与 HTML 注释行排除。
 *
 * ⚠ 候选预算 300（超限挂起不静默截断——截断即隐性丢候选 = 假信心，F-07）的判定归摄取编排
 * （B 波）：本函数**全量枚举绝不截断**，调用方计数超限直接判 low 挂起走人工。
 */
export function extractHeadingCandidates(text: string): HeadingCandidate[] {
  const lines = scanLines(text);
  const out: HeadingCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimmed === '') continue;
    const stripped = stripAtx(line.trimmed);
    if (stripped === '' || stripped.startsWith('<!--') || THEMATIC_BREAK_RE.test(stripped)) continue;
    if (matchHeadingLine(line.trimmed)) {
      out.push({ lineIndex: line.index, text: stripped });
      continue;
    }
    const isBlockStart = i === 0 || lines[i - 1].trimmed === '';
    if (!isBlockStart) continue;
    if (stripped.length > HEADING_CANDIDATE_MAX_CHARS) continue;
    if (NOT_TITLE_ENDINGS.has(stripped[stripped.length - 1])) continue;
    out.push({ lineIndex: line.index, text: stripped });
  }
  return out;
}

// ── 章标记协议（派生 .md ↔ 登记层，design §2.3）──

/**
 * 章标记（独立行 HTML 注释，置于该章首段之前；渲染不可见、用户可移动/改标题/增删）。
 *
 * - `method` 判别裁决来源（消解「任意注释→manual」矛盾，F-03）：manual = 人工裁决最高优先
 *   （重摄取保留不重分章）；regex|llm-fallback|none = 自动结果存档（content_hash 未变则原样
 *   保留；原件变更自动路径重跑）。**往返序列化必须保留 method**。
 * - `confidence`：可选随行置信（additive；缺失合法——老标记/人工标记不带）。
 */
export interface ChapterMarker {
  index: number;
  title: string | null;
  method: MaterialChapterMethod;
  confidence?: MaterialChapterConfidence;
}

/** parse 产物：标记的物理行位置（**行位置才是权威边界**——index 属性是元数据，乱序/失真不致命）。 */
export interface ParsedChapterMarker extends ChapterMarker {
  lineIndex: number;
}

const MARKER_LINE_RE = /^<!--\s*mat-chapter\s+(.*?)\s*-->$/;

/** 标题转义：引号实体化 + 注释终结符拆解 + 换行压平（标题是单行物）。 */
function escapeMarkerTitle(title: string): string {
  return title
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '&quot;')
    .replace(/-->/g, '--&gt;');
}

function unescapeMarkerTitle(title: string): string {
  return title.replace(/--&gt;/g, '-->').replace(/&quot;/g, '"');
}

/**
 * 章标记序列化（markers → 独立行注释，\n 连接）。title null 不出 title 属性；confidence 缺失
 * 不出属性（二态字段纪律）。摄取编排把它与章正文组装成派生 .md。
 */
export function serializeChapterMarkers(markers: readonly ChapterMarker[]): string {
  return markers
    .map((m) => {
      const parts = [`index=${m.index}`];
      if (m.title !== null) parts.push(`title="${escapeMarkerTitle(m.title)}"`);
      parts.push(`method=${m.method}`);
      if (m.confidence !== undefined) parts.push(`confidence=${m.confidence}`);
      return `<!-- mat-chapter ${parts.join(' ')} -->`;
    })
    .join('\n');
}

/**
 * 章标记解析（派生 .md → markers，**诚实返回**：按文档序返回物理行上的标记——index 乱序/
 * 重复/失真不炸不纠偏，裁决权在摄取编排按 lineIndex 重建边界）。
 *
 * 容忍用户手改（F-03 校对面现实）：多余空白 OK；title 缺失/空串 → null；method 缺失或非法值
 * → `manual`（用户手写标记 = 人工裁决意图，最高优先不翻转）；confidence 非法值丢弃；index 缺失
 * /非数 → 0（仅元数据，边界以行位置为准）。**只认独立行**注释——行内夹杂的 mat-chapter 字样
 * 不是标记。
 */
export function parseChapterMarkers(text: string): ParsedChapterMarker[] {
  const out: ParsedChapterMarker[] = [];
  for (const line of scanLines(text)) {
    if (line.trimmed === '') continue;
    const m = MARKER_LINE_RE.exec(line.trimmed);
    if (!m) continue;
    const attrs = new Map<string, string>();
    const attrRe = /([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|([^\s"=]+))/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[1])) !== null) attrs.set(am[1], am[2] ?? am[3] ?? '');
    const rawTitle = attrs.get('title');
    const title = rawTitle !== undefined && rawTitle !== '' ? unescapeMarkerTitle(rawTitle) : null;
    const parsedIndex = Number.parseInt(attrs.get('index') ?? '', 10);
    const method = parseMarkerMethod(attrs.get('method'));
    const confidence = parseMarkerConfidence(attrs.get('confidence'));
    const marker: ParsedChapterMarker = {
      lineIndex: line.index,
      index: Number.isFinite(parsedIndex) ? parsedIndex : 0,
      title,
      method,
    };
    if (confidence !== undefined) marker.confidence = confidence;
    out.push(marker);
  }
  return out;
}

/** method 缺失/非法 → 'manual'（手写标记 = 人工裁决意图）。 */
function parseMarkerMethod(raw: string | undefined): MaterialChapterMethod {
  return raw !== undefined && (MATERIAL_CHAPTER_METHODS as readonly string[]).includes(raw)
    ? (raw as MaterialChapterMethod)
    : 'manual';
}

/** confidence 非法/缺失 → undefined（可选随行置信，二态纪律）。 */
function parseMarkerConfidence(raw: string | undefined): MaterialChapterConfidence | undefined {
  return raw !== undefined && (MATERIAL_CHAPTER_CONFIDENCE as readonly string[]).includes(raw)
    ? (raw as MaterialChapterConfidence)
    : undefined;
}
