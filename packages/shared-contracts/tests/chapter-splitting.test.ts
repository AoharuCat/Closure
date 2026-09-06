import { describe, expect, it } from 'vitest';
import {
  CHAPTER_HEADING_PATTERNS,
  extractHeadingCandidates,
  parseChapterMarkers,
  serializeChapterMarkers,
  splitChapters,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 10.1 Wave A：文档级分章器（chapter-splitting，design §2.2/§2.3）。
// fixtures 全部自制样文（AC11 版权红线——禁用任何真实版权文本）。
// ─────────────────────────────────────────────────────────────────────────────

/** 自制正文段（非章标）。 */
const BODY = '他沿着河堤走了很久，直到路灯次第亮起来。';

/** 造一章：章标行 + n 字正文（独段）。 */
function chapterDoc(bodies: number[]): string {
  return bodies.map((n, i) => `第${i + 1}章\n${'墨'.repeat(n)}。`).join('\n\n');
}

// ── 格式表 fixture（69 格式全覆盖：每个表条目至少一行样文 + 期望标题 + 期望格式族）──

const FORMAT_FIXTURES: { line: string; title: string | null; format: string }[] = [
  // 第X量词族（12 量词 × 3 数字系统）
  { line: '第一卷', title: null, format: '第X卷·汉字数字' },
  { line: '第一卷　少年时代', title: '少年时代', format: '第X卷·汉字数字' },
  { line: '第2卷', title: null, format: '第X卷·阿拉伯数字' },
  { line: '第３卷', title: null, format: '第X卷·全角数字' },
  { line: '第一部', title: null, format: '第X部·汉字数字' },
  { line: '第12部', title: null, format: '第X部·阿拉伯数字' },
  { line: '第１２部', title: null, format: '第X部·全角数字' },
  { line: '第一章', title: null, format: '第X章·汉字数字' },
  { line: '第一章 风起', title: '风起', format: '第X章·汉字数字' },
  { line: '第一百零三章', title: null, format: '第X章·汉字数字' },
  { line: '第1章：风起', title: '风起', format: '第X章·阿拉伯数字' },
  { line: '第１章', title: null, format: '第X章·全角数字' },
  { line: '第一回', title: null, format: '第X回·汉字数字' },
  { line: '第99回', title: null, format: '第X回·阿拉伯数字' },
  { line: '第９９回', title: null, format: '第X回·全角数字' },
  { line: '第一节', title: null, format: '第X节·汉字数字' },
  { line: '第2节', title: null, format: '第X节·阿拉伯数字' },
  { line: '第２节', title: null, format: '第X节·全角数字' },
  { line: '第一集', title: null, format: '第X集·汉字数字' },
  { line: '第3集', title: null, format: '第X集·阿拉伯数字' },
  { line: '第３集', title: null, format: '第X集·全角数字' },
  { line: '第一话', title: null, format: '第X话·汉字数字' },
  { line: '第4话', title: null, format: '第X话·阿拉伯数字' },
  { line: '第４话', title: null, format: '第X话·全角数字' },
  { line: '第一幕', title: null, format: '第X幕·汉字数字' },
  { line: '第5幕', title: null, format: '第X幕·阿拉伯数字' },
  { line: '第５幕', title: null, format: '第X幕·全角数字' },
  { line: '第一场', title: null, format: '第X场·汉字数字' },
  { line: '第6场', title: null, format: '第X场·阿拉伯数字' },
  { line: '第６场', title: null, format: '第X场·全角数字' },
  { line: '第一篇', title: null, format: '第X篇·汉字数字' },
  { line: '第7篇', title: null, format: '第X篇·阿拉伯数字' },
  { line: '第７篇', title: null, format: '第X篇·全角数字' },
  { line: '第一辑', title: null, format: '第X辑·汉字数字' },
  { line: '第8辑', title: null, format: '第X辑·阿拉伯数字' },
  { line: '第８辑', title: null, format: '第X辑·全角数字' },
  { line: '第一册', title: null, format: '第X册·汉字数字' },
  { line: '第9册', title: null, format: '第X册·阿拉伯数字' },
  { line: '第９册', title: null, format: '第X册·全角数字' },
  // 量词前置 / 括号族
  { line: '卷一', title: null, format: '卷一·量词前置' },
  { line: '卷二　北境', title: '北境', format: '卷一·量词前置' },
  { line: '【第一章】', title: null, format: '【第X章】' },
  { line: '【第2章】旧事', title: '旧事', format: '【第X章】' },
  { line: '[第3章]', title: null, format: '[第X章]' },
  { line: '[第三章] 夜行', title: '夜行', format: '[第X章]' },
  // 特殊章名族
  { line: '序章', title: null, format: '序章' },
  { line: '序章　暗流', title: '暗流', format: '序章' },
  { line: '序言', title: null, format: '序言' },
  { line: '前言', title: null, format: '前言' },
  { line: '楔子', title: null, format: '楔子' },
  { line: '楔子：雨夜', title: '雨夜', format: '楔子' },
  { line: '引子', title: null, format: '引子' },
  { line: '引言', title: null, format: '引言' },
  { line: '序幕', title: null, format: '序幕' },
  { line: '开篇', title: null, format: '开篇' },
  { line: '尾声', title: null, format: '尾声' },
  { line: '尾声　十年后', title: '十年后', format: '尾声' },
  { line: '后记', title: null, format: '后记' },
  { line: '终章', title: null, format: '终章' },
  { line: '最终章', title: null, format: '最终章' },
  { line: '番外', title: null, format: '番外（含番外N/番外篇）' },
  { line: '番外篇', title: null, format: '番外（含番外N/番外篇）' },
  { line: '番外三　婚礼', title: '婚礼', format: '番外（含番外N/番外篇）' },
  { line: '外传', title: null, format: '外传' },
  { line: '外传二章', title: null, format: '外传' },
  { line: '附录', title: null, format: '附录（含附录A/附录三）' },
  { line: '附录A', title: null, format: '附录（含附录A/附录三）' },
  { line: '附录三　线索清单', title: '线索清单', format: '附录（含附录A/附录三）' },
  { line: '正文', title: null, format: '正文（正文起卷标记）' },
  { line: '正文　第一个故事', title: '第一个故事', format: '正文（正文起卷标记）' },
  // 拉丁/序号族
  { line: 'Chapter 1', title: null, format: 'Chapter N' },
  { line: 'CHAPTER 5', title: null, format: 'Chapter N' },
  { line: 'Chapter 12: The Beginning', title: 'The Beginning', format: 'Chapter N' },
  { line: '（一）', title: null, format: '（一）标题' },
  { line: '（二）双线并行', title: '双线并行', format: '（一）标题' },
  { line: '（1）', title: null, format: '（1）标题' },
  { line: '(3) 短兵相接', title: '短兵相接', format: '（1）标题' },
  { line: '1.', title: null, format: '1. 标题（数字加点/顿号独立行）' },
  { line: '２．装置与反装置', title: '装置与反装置', format: '1. 标题（数字加点/顿号独立行）' },
  { line: '3、开局', title: '开局', format: '1. 标题（数字加点/顿号独立行）' },
  { line: '一、', title: null, format: '一、标题（汉字数字加顿号）' },
  { line: '二、人物弧光', title: '人物弧光', format: '一、标题（汉字数字加顿号）' },
  { line: '一', title: null, format: '汉字数字独立行' },
  { line: '三千五百', title: null, format: '汉字数字独立行' },
  { line: '1', title: null, format: '纯数字独立行' },
  { line: '012', title: null, format: '纯数字独立行' },
  { line: '上', title: null, format: '上/中/下' },
  { line: '下', title: null, format: '上/中/下' },
  { line: '上篇', title: null, format: '上篇/中篇/下篇' },
  { line: '下篇　终局', title: '终局', format: '上篇/中篇/下篇' },
  // 日期体/日记体
  { line: '2024年3月5日', title: null, format: '2024年3月5日' },
  { line: '1998年12月1日　雪', title: '雪', format: '2024年3月5日' },
  { line: '2024-03-05', title: null, format: '2024-03-05' },
  { line: '1998.12.1', title: null, format: '2024-03-05' },
  { line: '3月5日', title: null, format: '3月5日（日记体）' },
  { line: '3月5日 星期五', title: null, format: '3月5日（日记体）' },
  { line: '3月5日　晴', title: '晴', format: '3月5日（日记体）' },
  // 罗马数字
  { line: 'I', title: null, format: '罗马数字 I/II/III' },
  { line: 'IV', title: null, format: '罗马数字 I/II/III' },
  { line: 'XII', title: null, format: '罗马数字 I/II/III' },
  { line: 'Ⅰ', title: null, format: '罗马数字 Ⅰ/Ⅱ/Ⅲ' },
  { line: 'Ⅻ', title: null, format: '罗马数字 Ⅰ/Ⅱ/Ⅲ' },
];

describe('CHAPTER_HEADING_PATTERNS — 正则表完整性', () => {
  it('≥50 格式（AC：50+ 格式覆盖，C5 复用面）', () => {
    expect(CHAPTER_HEADING_PATTERNS.length).toBeGreaterThanOrEqual(50);
  });

  it('id 与 format 标签唯一（matchedFormats 回报不歧义）', () => {
    const ids = new Set(CHAPTER_HEADING_PATTERNS.map((p) => p.id));
    const formats = new Set(CHAPTER_HEADING_PATTERNS.map((p) => p.format));
    expect(ids.size).toBe(CHAPTER_HEADING_PATTERNS.length);
    expect(formats.size).toBe(CHAPTER_HEADING_PATTERNS.length);
  });

  it('regex 全部首尾锚定（整行匹配，禁子串误命中）', () => {
    for (const p of CHAPTER_HEADING_PATTERNS) {
      expect(p.regex.source.startsWith('^'), p.id).toBe(true);
      expect(p.regex.source.endsWith('$'), p.id).toBe(true);
    }
  });

  it('格式表条目全量有 fixture 覆盖（表条目 ↔ 样文对拍零遗漏）', () => {
    const covered = new Set(FORMAT_FIXTURES.map((f) => f.format));
    for (const p of CHAPTER_HEADING_PATTERNS) {
      expect(covered.has(p.format), `表条目 ${p.id}（${p.format}）缺 fixture`).toBe(true);
    }
  });
});

describe('splitChapters — 表驱动格式识别（fixtures 全自制样文）', () => {
  it.each(FORMAT_FIXTURES)('章标「$line」→ 命中 $format（title=$title）', ({ line, title, format }) => {
    const doc = `${line}\n\n${BODY}`;
    const r = splitChapters(doc);
    expect(r.matchedFormats, `格式族：${line}`).toEqual([format]);
    expect(r.chapters, `章数组：${line}`).toHaveLength(1);
    expect(r.chapters[0], `span：${line}`).toMatchObject({
      index: 0,
      title,
      charStart: 0,
      charEnd: doc.length,
    });
    expect(doc.slice(r.chapters[0].charStart, r.chapters[0].charEnd).startsWith(line)).toBe(true);
  });

  it.each([
    '第一章的内容讲的是往事',
    '十分钟后他推门进来，屋里没人',
    '一九九七年夏天很热',
    '2024年他离开了故乡',
    '1987年4月',
    '他说：今晚不回去了',
    '卷帘门的生意不好做',
    '卷一宗旧案被翻了出来',
    '序章般安静的长夜',
  ])('正文行「%s」不是章标（量词后直接跟字/非独立行 → 零命中）', (line) => {
    const doc = `前情提要一段。\n\n${line}\n\n${BODY}`;
    const r = splitChapters(doc);
    expect(r.matchedFormats).toEqual([]);
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0].title).toBeNull();
  });

  it('markdown ATX 前缀剥离：# 第一章 / ## 楔子 同样识别（md/epub 来源）', () => {
    const r1 = splitChapters(`# 第一章 风起\n\n${BODY}`);
    expect(r1.matchedFormats).toEqual(['第X章·汉字数字']);
    expect(r1.chapters[0].title).toBe('风起');
    const r2 = splitChapters(`## 楔子\n\n${BODY}`);
    expect(r2.matchedFormats).toEqual(['楔子']);
    expect(r2.chapters[0].title).toBeNull();
  });
});

describe('splitChapters — 置信分级边界（design §2.2 启发式）', () => {
  it('8 章均匀分布 + 首行即章标（覆盖率 100%）→ high', () => {
    const text = chapterDoc([2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]);
    const r = splitChapters(text);
    expect(r.confidence).toBe('high');
    expect(r.chapters).toHaveLength(8);
    expect(r.matchedFormats).toEqual(['第X章·阿拉伯数字']);
    // 章间连续无缝（半开区间相邻）：首起 0、末达全文尾
    expect(r.chapters[0].charStart).toBe(0);
    expect(r.chapters[r.chapters.length - 1].charEnd).toBe(text.length);
    for (let i = 1; i < r.chapters.length; i++) {
      expect(r.chapters[i].charStart).toBe(r.chapters[i - 1].charEnd);
    }
    expect(r.chapters.map((c) => c.index)).toEqual(r.chapters.map((_, i) => i));
  });

  it('大段前导正文（覆盖率 ~83% <95%）→ medium（部分满足）', () => {
    const text = `${'墨'.repeat(2000)}。\n\n${chapterDoc([2000, 2000, 2000, 2000, 2000])}`;
    const r = splitChapters(text);
    expect(r.confidence).toBe('medium');
    expect(r.chapters).toHaveLength(6); // 前导段自成一章（title null）+ 5 章
    expect(r.chapters[0].title).toBeNull();
    expect(r.chapters[1].title).toBeNull();
  });

  it('间距忽长忽短（一段 6 倍长但 <8 倍游离线，CV>0.9）→ medium', () => {
    const r = splitChapters(chapterDoc([2000, 2000, 2000, 12000, 2000, 2000]));
    expect(r.confidence).toBe('medium');
    expect(r.chapters).toHaveLength(6);
  });

  it('≤2 命中 → low（情报不足）', () => {
    expect(splitChapters(chapterDoc([100, 100])).confidence).toBe('low');
  });

  it('目录页形态（20 行连续章标 + 大段正文游离）→ low（大段游离=漏检信号）', () => {
    const toc = Array.from({ length: 20 }, (_, i) => `第${i + 1}章`).join('\n');
    const text = `${toc}\n\n${'墨'.repeat(30000)}。`;
    const r = splitChapters(text);
    expect(r.confidence).toBe('low');
    expect(r.chapters).toHaveLength(20); // 19 个单行章 + 末标题段吸收整段正文（不硬给——low 交下游分流）
    expect(r.matchedFormats).toEqual(['第X章·阿拉伯数字']);
  });

  it('无标记长文 → low + 全文单章（title null）', () => {
    const text = `${'墨'.repeat(3000)}。`;
    const r = splitChapters(text);
    expect(r.confidence).toBe('low');
    expect(r.matchedFormats).toEqual([]);
    expect(r.chapters).toEqual([{ index: 0, title: null, charStart: 0, charEnd: text.length }]);
  });
});

describe('splitChapters — 空与退化输入 + 确定性', () => {
  it.each([
    ['空串', ''],
    ['纯空白', '  \n\t\n  '],
    ['只有换行', '\n\n\n'],
  ])('%s → chapters: [] / low / 零格式（确定性）', (_label, text) => {
    expect(splitChapters(text)).toEqual({ chapters: [], confidence: 'low', matchedFormats: [] });
  });

  it('单章超长文本 → 全文一章 / low；同输入两次调用 deep-equal（无 Date/random）', () => {
    const text = `${'墨'.repeat(5000)}。`;
    const a = splitChapters(text);
    const b = splitChapters(text);
    expect(a).toEqual(b);
    expect(a.chapters).toHaveLength(1);
    expect(a.confidence).toBe('low');
  });
});

describe('extractHeadingCandidates — 弱模式候选行（LLM 兜底约束消费）', () => {
  it('强命中全收 + 弱补充按段首/短行/非句读收，其余排除；行序输出', () => {
    const text = [
      '雨夜', // 0 段首弱候选 ✓
      '他推开门坐下了。', // 1 非段首 + 句读收尾 ✗
      '', // 2
      '第一章', // 3 强命中 ✓
      '他接着说。', // 4 非段首 ✗
      '', // 5
      '谁杀了谁？', // 6 段首 + 「？」允许（问句式章题常见，宁多留 LLM 裁）✓
      '', // 7
      'x'.repeat(31), // 8 超长（>30）✗
      '', // 9
      '---', // 10 转场标记 ✗
      '', // 11
      '<!-- mat-chapter index=0 method=manual -->', // 12 注释行 ✗
      '', // 13
      'x'.repeat(30), // 14 恰好 30 字 ✓
    ].join('\n');
    expect(extractHeadingCandidates(text).map((c) => c.lineIndex)).toEqual([0, 3, 6, 14]);
    expect(extractHeadingCandidates(text)[1]).toEqual({ lineIndex: 3, text: '第一章' });
  });

  it('强命中不受段首约束（正文行后紧跟的章标行同样是候选）', () => {
    const cands = extractHeadingCandidates(`他推开门。\n第一章\n${BODY}`);
    expect(cands.map((c) => c.lineIndex)).toEqual([1]);
  });

  it('全量枚举绝不截断（候选预算 300 的超限挂起归摄取编排，F-07）', () => {
    const text = Array.from({ length: 400 }, (_, i) => `第${i + 1}章\n${BODY}`).join('\n\n');
    expect(extractHeadingCandidates(text)).toHaveLength(400);
  });

  it('空文本 → []', () => {
    expect(extractHeadingCandidates('')).toEqual([]);
    expect(extractHeadingCandidates(' \n\n ')).toEqual([]);
  });
});

describe('serializeChapterMarkers / parseChapterMarkers — 章标记协议（§2.3）', () => {
  it('往返一致且 method 属性保留（F-03：四值全验）', () => {
    const markers = [
      { index: 0, title: '楔子', method: 'manual' as const },
      { index: 1, title: null, method: 'regex' as const, confidence: 'high' as const },
      { index: 2, title: '第 三 章', method: 'llm-fallback' as const, confidence: 'low' as const },
      { index: 3, title: null, method: 'none' as const },
    ];
    const parsed = parseChapterMarkers(serializeChapterMarkers(markers));
    expect(parsed).toEqual(markers.map((m, i) => ({ lineIndex: i, ...m })));
    // method 逐项钉死（F-03 核心断言——重摄取判别人工/自动靠它）
    expect(parsed.map((m) => m.method)).toEqual(['manual', 'regex', 'llm-fallback', 'none']);
  });

  it('序列化格式钉死：独立行注释、title=null 不出属性、confidence 可选随行', () => {
    expect(serializeChapterMarkers([{ index: 3, title: '夜行', method: 'manual' }])).toBe(
      '<!-- mat-chapter index=3 title="夜行" method=manual -->',
    );
    expect(
      serializeChapterMarkers([{ index: 1, title: null, method: 'regex', confidence: 'high' }]),
    ).toBe('<!-- mat-chapter index=1 method=regex confidence=high -->');
    expect(serializeChapterMarkers([])).toBe('');
  });

  it('标题转义：引号 / 注释终结符 / 换行 往返还原', () => {
    const title = '他说"去吧"-->后来';
    const parsed = parseChapterMarkers(serializeChapterMarkers([{ index: 0, title, method: 'manual' }]));
    expect(parsed[0].title).toBe(title);
  });

  it('解析容忍用户手改：多余空格 / 缺 title / 缺 method（→manual）/ 非法 method（→manual）/ 坏 index（→0），均不炸', () => {
    const parsed = parseChapterMarkers(
      '<!--  mat-chapter   index=7   title="夜行"   method=manual  -->\n' +
        '<!-- mat-chapter index=2 method=regex -->\n' +
        '<!-- mat-chapter index=0 title="手写" -->\n' +
        '<!-- mat-chapter index=1 method=auto -->\n' +
        '<!-- mat-chapter index=abc method=none -->',
    );
    expect(parsed).toEqual([
      { lineIndex: 0, index: 7, title: '夜行', method: 'manual' },
      { lineIndex: 1, index: 2, title: null, method: 'regex' },
      { lineIndex: 2, index: 0, title: '手写', method: 'manual' }, // 缺 method = 手写标记 = 人工裁决意图
      { lineIndex: 3, index: 1, title: null, method: 'manual' }, // 非法值不翻转成别的自动档
      { lineIndex: 4, index: 0, title: null, method: 'none' },
    ]);
  });

  it('乱序/重复 index 按文档序诚实返回（行位置才是权威边界）', () => {
    const parsed = parseChapterMarkers(
      `前文。\n<!-- mat-chapter index=5 method=manual -->\n章一正文。\n<!-- mat-chapter index=2 method=manual -->\n章二正文。`,
    );
    expect(parsed.map((m) => [m.lineIndex, m.index])).toEqual([
      [1, 5],
      [3, 2],
    ]);
  });

  it('只认独立行注释——行内夹杂的 mat-chapter 字样不是标记', () => {
    expect(parseChapterMarkers('正文 <!-- mat-chapter index=0 method=manual --> 继续')).toEqual([]);
  });
});
