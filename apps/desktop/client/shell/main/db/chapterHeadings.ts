// 章标真值单源（材料域）：chapterIndex → 真实章标行 / 渲染标签 / 章号。
//
// 消费方：decon 各 pass 的渲染与引用核验（F19——index+1 章号算术在简介伪章/漏检章形态下整体
// 错位，展示一律用真实章标行）、材料索引展示名。零序号算术：无章标行章走语义回落标签，
// 数字回落从章标行解析，绝不按 chapterIndex 推算。
//
// 章标行判定复用 shared-contracts CHAPTER_HEADING_PATTERNS 分章正则库（同源防漂移）。

import { CHAPTER_HEADING_PATTERNS } from '@orison/shared-contracts';

/** 章号域汉字数字字符集（含大写变体——万级以内）。 */
export const CHAPTER_HEADING_NUMERALS = '一二三四五六七八九十百千万亿零〇两壹贰叁肆伍陆柒捌玖拾佰仟萬';

/** 章标行长度帽（超帽首行视为正文不判章标——防 prose 误命中弱格式族）。 */
const HEADING_LINE_MAX_CHARS = 40;

/**
 * title 含字 belt 最短长度（CR-9）：title trim 后少于此字数不起 includes belt——防「上」「下」
 * 类单字 title 把任意含该字的 prose 行抬升为章标行。
 */
const HEADING_TITLE_BELT_MIN_CHARS = 2;

const ATX_PREFIX_RE = /^#{1,6}[ \t]+/;

/** 单章章标信息（buildChapterHeadings 产物——渲染标签 / 引用核验 / 展示名三方共用）。 */
export interface ChapterHeadingInfo {
  /** 材料章 index（material.chapters[].index 同空间）。 */
  chapterIndex: number;
  /** 完整章标行原词（trim + 剥 ATX 前缀——含「第N章」前缀与标题尾）；无章标行 = null。 */
  headingLine: string | null;
  /** 章题（material.chapters[].title 同源 trim）；无 = null。 */
  title: string | null;
  /** 渲染标签：章标行原词；无章标行语义回落（《title》/简介（卷首）/正文（无章标））——零序号算术。 */
  label: string;
  /** 章标行解析的十进制章号（「第N<量词>」族：阿拉伯含全角/汉字万级以内/Chapter N）；其他格式族或无章标行 = null。 */
  number: number | null;
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNITS: Readonly<Record<string, number>> = {
  十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10_000, 萬: 10_000,
};

/**
 * 章号数字解析（纯函数）：阿拉伯（含全角归一）与汉字数字（万级以内）；解析失败 = null。
 * 阿拉伯 0 保留（可参与核验——简介伪章书里「第0章」是不存在的章号）；汉字「零」解析为 null。
 */
export function parseChapterHeadingNumber(raw: string): number | null {
  const normalized = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/^[0-9]+$/.test(normalized)) {
    const n = Number(normalized);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of normalized) {
    const d = CN_DIGITS[ch];
    if (d !== undefined) {
      digit = d;
      continue;
    }
    const unit = CN_UNITS[ch];
    if (unit === undefined) return null;
    if (unit === 10_000) {
      section = (section + digit) * unit;
      total += section;
      section = 0;
    } else {
      section += (digit || 1) * unit;
    }
    digit = 0;
  }
  const value = total + section + digit;
  return value > 0 ? value : null;
}

/** 章标行「第N<量词>」族章号提取（行首锚定，容【】/[] 包裹与词间空格；其他格式族不命中）。 */
export const CHAPTER_HEADING_NUM_RE = new RegExp(
  `^[【\\[]?第\\s*([0-9０-９]+|[${CHAPTER_HEADING_NUMERALS}]{1,8})\\s*[卷部章回节集话幕场篇辑册]`,
);
const HEADING_NUM_EN_RE = /^(?:[Cc]hapter|CHAPTER)[ \t]+([0-9０-９]+)/;

/** 章标行形态判定（复用分章正则库单源——与 splitChapters 同表同序；ATX 前缀已由调用方剥）。 */
function matchHeadingLine(line: string): boolean {
  for (const pattern of CHAPTER_HEADING_PATTERNS) {
    if (pattern.regex.test(line)) return true;
  }
  return false;
}

/** 章区间首行（trim；charStart 起第一条物理行，剥 ATX 前缀）。 */
function firstLineOf(derived: string, charStart: number, charEnd: number): string {
  const nl = derived.indexOf('\n', charStart);
  const end = nl === -1 || nl >= charEnd ? charEnd : nl;
  return derived.slice(charStart, end).trim().replace(ATX_PREFIX_RE, '');
}

/**
 * chapterIndex → 章标信息映射（纯函数，一次构建复用）。章标行 = 章正文首行（charStart = 正文
 * 起点，真章首行即章标行）命中分章正则库，或首行含章题（title 含字 belt）；首行落空而 title
 * 自身是章标形态时以 title 充当（合成/异常基面兜底）。全部落空（前导段/全书无章标）→ 语义回落标签。
 */
export function buildChapterHeadings(
  derived: string,
  chapters: ReadonlyArray<{ index: number; title: string | null; charStart: number; charEnd: number }>,
): Map<number, ChapterHeadingInfo> {
  const map = new Map<number, ChapterHeadingInfo>();
  for (const ch of chapters) {
    const title = typeof ch.title === 'string' && ch.title.trim().length > 0 ? ch.title.trim() : null;
    const firstLine = firstLineOf(derived, ch.charStart, ch.charEnd);
    let headingLine: string | null = null;
    if (firstLine.length > 0 && firstLine.length <= HEADING_LINE_MAX_CHARS) {
      // title 含字 belt 带 CR-9 最短长度守卫——单字 title 在 prose 行内子串命中过泛（「上」类）。
      if (matchHeadingLine(firstLine) || (title !== null && title.length >= HEADING_TITLE_BELT_MIN_CHARS && firstLine.includes(title)))
        headingLine = firstLine;
    }
    if (headingLine === null && title !== null && matchHeadingLine(title)) headingLine = title;
    const numMatch =
      headingLine === null ? null : (CHAPTER_HEADING_NUM_RE.exec(headingLine) ?? HEADING_NUM_EN_RE.exec(headingLine));
    const number = numMatch === null ? null : parseChapterHeadingNumber(numMatch[1]!);
    const label =
      headingLine ??
      (title !== null
        ? `《${title}》`
        : ch.index === 0 && chapters.length > 1
          ? '简介（卷首）'
          : '正文（无章标）');
    map.set(ch.index, { chapterIndex: ch.index, headingLine, title, label, number });
  }
  return map;
}

/** 短标签（紧凑列举/区间用）：章号可解析 → 「第 N 章」；无数字章标用原行；再回落 label。 */
export function chapterShortLabel(h: ChapterHeadingInfo | undefined, chapterIndex: number): string {
  if (h === undefined) return `材料章 ${chapterIndex}`; // 防御：登记外章号（不该发生）
  if (h.number !== null) return `第 ${h.number} 章`;
  return h.headingLine ?? h.label;
}

/** 全标签（单章引用用）：真实章标行原词；无章标行回落 label。 */
export function chapterFullLabel(h: ChapterHeadingInfo | undefined, chapterIndex: number): string {
  if (h === undefined) return `材料章 ${chapterIndex}`;
  return h.headingLine ?? h.label;
}

/** 短标签列举（「第 1、2、3 章」压缩形态——全可解析时数字并排，否则逐标签顿号连接；空集 → 空串）。 */
export function joinChapterShortLabels(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  const nums: number[] = [];
  for (const label of labels) {
    const m = /^第 (\d+) 章$/.exec(label);
    if (m === null) return labels.join('、');
    nums.push(Number(m[1]));
  }
  return `第 ${nums.join('、')} 章`;
}

/**
 * 章区间标签（弧头/统计行）：两端章号可解析 → 同号单章形「第 N 章」；「第 M-N 章」区间形仅当
 * 章号步进与索引步进一致（连续编号）时使用——数字跳档（如材料相邻章号 1/12）会让 M-N 读成
 * N-M+1 章跨度假象（CR-11），回落「从X到Y」语义链形；同号单章保留。
 */
export function chapterRangeLabel(
  headings: ReadonlyMap<number, ChapterHeadingInfo>,
  fromIndex: number,
  toIndex: number,
): string {
  const from = headings.get(fromIndex);
  const to = headings.get(toIndex);
  if (from !== undefined && to !== undefined && from.number !== null && to.number !== null) {
    if (from.number === to.number) return `第 ${from.number} 章`;
    if (to.number - from.number === toIndex - fromIndex) return `第 ${from.number}-${to.number} 章`;
  }
  return `从${from?.label ?? `材料章 ${fromIndex}`}到${to?.label ?? `材料章 ${toIndex}`}`;
}
