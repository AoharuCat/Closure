/**
 * dogfood R3 / R10（C1）：派生 .md 章标记（`<!-- mat-chapter ... -->` 行）的
 * 剥/拼契约（shared/utils/chapter-markers.ts）。
 *
 * 覆盖（mirror frontmatter 测试形态 + implement.md W3a checklist）：
 * - 恒等双射：未编辑内容 strip→splice 字节还原——LF / CRLF / 无尾换行 / BOM /
 *   空行 gap / 连续标记共享锚 / 锚文本重复（标记前出现 / 标记后出现）/ EOF 标记。
 * - 剥离识别：只认独立行（行内夹杂不剥）；非 mat-chapter 的 HTML 注释不剥；
 *   标记行按原字节捕获（含缩进/行尾空白/换行符）。
 * - 拼接语义：锚行被删/被改 → 该标记不回拼；编辑漂移（前方删文）后锚仍可寻；
 *   编辑器序列化剥掉首标记前的空行 gap → 锚行 tier 3 回落仍回拼；空数组透传。
 */
import { describe, expect, it } from 'vitest';
import { spliceChapterMarkers, stripChapterMarkers } from '../src/shared/utils/chapter-markers';

const M0 = '<!-- mat-chapter index=0 title="书名页" method=regex confidence=high -->';
const M1 = '<!-- mat-chapter index=1 title="预付200万日元" method=regex confidence=high -->';

function expectBijection(content: string): void {
  const { body, markers } = stripChapterMarkers(content);
  expect(spliceChapterMarkers(body, markers)).toBe(content);
}

describe('stripChapterMarkers / spliceChapterMarkers 恒等双射（R10）', () => {
  it('无标记文件原样透传（markers 空、body 原文）', () => {
    const md = '# 标题\n\n正文，无任何标记。\n';
    const { body, markers } = stripChapterMarkers(md);
    expect(body).toBe(md);
    expect(markers).toEqual([]);
    expect(spliceChapterMarkers(body, markers)).toBe(md);
  });

  it('R3 实样形态：双标记（无 gap + 空行 gap）字节还原', () => {
    const md = `${M0}\n书名：无法告白：\nbook_id=7546823812877143065\n\n${M1}\n\n预付200万日元\n正文第一段。\n`;
    const { body, markers } = stripChapterMarkers(md);
    expect(body).not.toContain('mat-chapter');
    expect(body).toContain('book_id=7546823812877143065');
    expect(body).toBe('书名：无法告白：\nbook_id=7546823812877143065\n\n\n预付200万日元\n正文第一段。\n');
    expect(markers).toHaveLength(2);
    expect(markers[0]!.markerLine).toBe(`${M0}\n`);
    expect(markers[1]!.markerLine).toBe(`${M1}\n`);
    expectBijection(md);
  });

  it('CRLF 全程保真（标记行换行符与正文一致）', () => {
    const md = `${M0}\r\n书名：无法告白：\r\nbook_id=1\r\n\r\n${M1}\r\n\r\n预付200万日元\r\n正文。\r\n`;
    const { markers } = stripChapterMarkers(md);
    expect(markers[0]!.markerLine).toBe(`${M0}\r\n`);
    expect(markers[1]!.markerLine).toBe(`${M1}\r\n`);
    expectBijection(md);
  });

  it('无尾换行与 EOF 标记还原', () => {
    expectBijection(`前文\n${M0}`); // 标记即文件尾（无换行）
    expectBijection(`前文\n${M0}\n`); // 标记行有换行但后无内容
    expectBijection(`${M0}`); // 标记独占文件
    expectBijection(`${M0}\n${M1}`); // 连续 EOF 标记（无内容跟随）
  });

  it('标记后只剩空行：空行尾巴作锚还原', () => {
    expectBijection(`前文\n${M0}\n\n\n`);
  });

  it('连续标记共享同一锚，按原文顺序堆叠', () => {
    const md = `前文\n${M0}\n${M1}\n共享锚行\n正文\n`;
    const { markers } = stripChapterMarkers(md);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.anchorLine).toBe('共享锚行');
    expect(markers[1]!.anchorLine).toBe('共享锚行');
    expectBijection(md);
  });

  it('锚文本在标记之前出现（重复陷阱）：按记录位置精确回位', () => {
    // 纯文本就近搜索会把标记插到第一个 content 前——tier 1 记录位置必须赢。
    expectBijection(`X\ncontent\n${M0}\ncontent\n`);
  });

  it('锚行在标记后重复出现：按文档序就近匹配', () => {
    const md = `${M0}\n锚行\n正文\n${M1}\n锚行\n更多\n`;
    const { markers } = stripChapterMarkers(md);
    expect(markers).toHaveLength(2);
    expectBijection(md);
  });

  it('BOM 开头的首标记行还原（BOM 随标记行往返）', () => {
    expectBijection(`\uFEFF${M0}\n书名\n`);
  });

  it('行首缩进/行尾空白的标记行按原字节还原', () => {
    expectBijection(`  ${M0}  \n书名\n`);
  });

  it('行内夹杂的 mat-chapter 字样不是标记（只认独立行）', () => {
    const md = `正文 <!-- mat-chapter index=0 --> 续写\n下一行\n`;
    const { body, markers } = stripChapterMarkers(md);
    expect(markers).toEqual([]);
    expect(body).toBe(md);
  });

  it('非 mat-chapter 的 HTML 注释不剥', () => {
    const md = `<!-- 普通注释 -->\n正文\n`;
    const { body, markers } = stripChapterMarkers(md);
    expect(markers).toEqual([]);
    expect(body).toBe(md);
  });
});

describe('spliceChapterMarkers 编辑语义', () => {
  it('锚行被用户删除 → 该标记不回拼，其余标记存活', () => {
    const md = `${M0}\n书名\n\n${M1}\n预付\n正文\n`;
    const { body, markers } = stripChapterMarkers(md);
    const edited = body.replace('预付\n', ''); // 用户删掉第二章锚行
    const out = spliceChapterMarkers(edited, markers);
    expect(out).toContain(M0);
    expect(out).not.toContain(M1);
  });

  it('锚行被改写 → 该标记不回拼', () => {
    const md = `${M0}\n书名\n`;
    const { body, markers } = stripChapterMarkers(md);
    const out = spliceChapterMarkers(body.replace('书名', '改名了'), markers);
    expect(out).not.toContain(M0);
  });

  it('编辑发生在标记之前（记录位置漂移）：锚仍按就近寻回', () => {
    const md = `开头段\n${M0}\n锚行\n正文\n`;
    const { body, markers } = stripChapterMarkers(md);
    const edited = body.replace('开头段\n', ''); // 前方删除 → 记录位置漂移
    const out = spliceChapterMarkers(edited, markers);
    expect(out).toContain(M0);
    expect(out).toBe(`${M0}\n锚行\n正文\n`);
  });

  it('编辑器序列化剥掉首标记前的空行 gap：锚行 tier 3 回落仍回拼', () => {
    const md = `${M0}\n\n书名\n`;
    const { markers } = stripChapterMarkers(md);
    // 模拟 TipTap 序列化（trim + 段落化）：开头 gap 与行尾换行都没了
    const serialized = '书名';
    const out = spliceChapterMarkers(serialized, markers);
    expect(out).toBe(`${M0}\n书名`);
  });

  it('CRLF 捕获 → LF 编辑器序列化体：锚按行尾容忍匹配回拼（R3 真实动线）', () => {
    const md = `${M0}\r\n书名：无法告白：\r\nbook_id=1\r\n\r\n${M1}\r\n\r\n预付200万日元\r\n正文。\r\n`;
    const { markers } = stripChapterMarkers(md);
    expect(markers[0]!.anchorLine).toBe('书名：无法告白：'); // 无尾 \r
    // 编辑器 emit 的 body 是 LF 归一形态——两级锚都必须命中。
    const serialized = '书名：无法告白：\nbook_id=1\n\n预付200万日元\n正文。';
    const out = spliceChapterMarkers(serialized, markers);
    expect(out.startsWith(`${M0}\r\n`)).toBe(true);
    // M1 回插在锚前空行之前（编辑器已把双空行归一为单空行）。
    expect(out).toContain(`book_id=1\n${M1}\r\n\n预付200万日元`);
  });

  it('空标记数组透传', () => {
    expect(spliceChapterMarkers('正文\n', [])).toBe('正文\n');
  });
});
