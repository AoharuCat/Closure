import { describe, expect, it } from 'vitest';
import {
  buildChapterHeadings,
  chapterFullLabel,
  chapterRangeLabel,
  chapterShortLabel,
  joinChapterShortLabels,
} from '../main/db/chapterHeadings';

// ── 章标真值单源（db/chapterHeadings）——F19 index+1 算术错位；零序号算术红线 ──

describe('buildChapterHeadings + 标签族（真实章标行解析）', () => {
  /** 真实摄取形态 fixture：简介伪章（index 0 无章标行）+ 章文首行即章标行。 */
  function composeRealShaped(): {
    derived: string;
    chapters: Array<{ index: number; title: string | null; charStart: number; charEnd: number }>;
  } {
    const intro = '书名：无法告白\n\n开篇前的简介正文，自成一章。';
    const ch1 = '第1章 预付200万日元\n\n他预付了两百万日元。';
    const ch2 = '第十二章 手稿不见了\n\n正文内容。';
    const ch3 = '第３章 全角数字\n\n正文内容。';
    const ch4 = '序章 黑夜的访客\n\n正文内容。';
    const parts = [intro, ch1, ch2, ch3, ch4];
    const chapters: Array<{ index: number; title: string | null; charStart: number; charEnd: number }> = [];
    let off = 0;
    for (let i = 0; i < parts.length; i++) {
      chapters.push({ index: i, title: null, charStart: off, charEnd: off + parts[i]!.length });
      off += parts[i]!.length;
    }
    // title = 章标行尾提取（splitChapters 同式——不含「第N章」前缀）
    chapters[1]!.title = '预付200万日元';
    chapters[2]!.title = '手稿不见了';
    chapters[3]!.title = '全角数字';
    chapters[4]!.title = '黑夜的访客';
    return { derived: parts.join(''), chapters };
  }

  it('真实形态：charStart 首行即章标行——headingLine 原词、number 解析（阿拉伯/汉字/全角）、简介伪章语义回落', () => {
    const { derived, chapters } = composeRealShaped();
    const h = buildChapterHeadings(derived, chapters);
    // 简介伪章（index 0）：无章标行无 title → 简介（卷首）回落
    expect(h.get(0)?.headingLine).toBeNull();
    expect(chapterShortLabel(h.get(0), 0)).toBe('简介（卷首）');
    expect(chapterFullLabel(h.get(0), 0)).toBe('简介（卷首）');
    // 第1章（阿拉伯数字 + 标题尾）
    expect(h.get(1)?.headingLine).toBe('第1章 预付200万日元');
    expect(h.get(1)?.number).toBe(1);
    expect(chapterShortLabel(h.get(1), 1)).toBe('第 1 章');
    expect(chapterFullLabel(h.get(1), 1)).toBe('第1章 预付200万日元');
    // 第十二章（汉字数字 → 12——简介伪章推齐 index 的场景下 index+1 会错位成 3）
    expect(h.get(2)?.number).toBe(12);
    expect(chapterShortLabel(h.get(2), 2)).toBe('第 12 章');
    // 第３章（全角数字 → 3）
    expect(h.get(3)?.number).toBe(3);
    // 序章（无数字章标——headingLine 原词即身份）
    expect(h.get(4)?.number).toBeNull();
    expect(chapterShortLabel(h.get(4), 4)).toBe('序章 黑夜的访客');
  });

  it('合成形态：charStart 首行非章标而 title 自身是章标形态（「第N章」）——title 充当章标行', () => {
    const derived = '李逍遥在青云观醒来。\n\n赵灵儿上山。';
    const chapters = [
      { index: 0, title: '第1章', charStart: 0, charEnd: 11 },
      { index: 1, title: '第2章', charStart: 11, charEnd: derived.length },
    ];
    const h = buildChapterHeadings(derived, chapters);
    expect(h.get(0)?.headingLine).toBe('第1章');
    expect(h.get(0)?.number).toBe(1);
    expect(chapterShortLabel(h.get(0), 0)).toBe('第 1 章');
  });

  it('无章标行有 title → 《title》回落；登记外章号防御 →「材料章 N」', () => {
    const derived = '零散短文没有章标。';
    const chapters = [{ index: 0, title: '灯塔看守人', charStart: 0, charEnd: derived.length }];
    const h = buildChapterHeadings(derived, chapters);
    expect(h.get(0)?.headingLine).toBeNull();
    expect(chapterShortLabel(h.get(0), 0)).toBe('《灯塔看守人》');
    // 单章且 index 0 → 不判简介（简介回落要求多章首章）
    expect(chapters.length === 1 && h.get(0)?.label).toBe('《灯塔看守人》');
    expect(chapterShortLabel(undefined, 7)).toBe('材料章 7');
    expect(chapterFullLabel(undefined, 7)).toBe('材料章 7');
  });

  it('CR-9：单字 title 不起 includes belt——首行 prose 不被「上」类单字抬升为章标行', () => {
    const derived = '他上山的路很陡。\n\n次日清晨天未亮就出发了。';
    // 无守卫时：首行 prose 含「上」→ includes belt 命中 → 整行 prose 被抬升为章标行。
    // 有守卫：单字 belt 跳过；「上」自身是分章库上/中/下族合法章标 → 经 title 兜底充当。
    const h = buildChapterHeadings(derived, [{ index: 0, title: '上', charStart: 0, charEnd: derived.length }]);
    expect(h.get(0)?.headingLine).toBe('上');
    expect(h.get(0)?.label).toBe('上');
    // 任意单字（非章标形态）：belt 跳过后无 title 兜底 → 《title》回落，prose 行不被抬升。
    const rainDerived = '他雨夜上山，路很陡。';
    const rain = buildChapterHeadings(rainDerived, [{ index: 0, title: '雨', charStart: 0, charEnd: rainDerived.length }]);
    expect(rain.get(0)?.headingLine).toBeNull();
    expect(rain.get(0)?.label).toBe('《雨》');
    // 对照：双字 title 的 belt 照常（首行确实含 title → 章标行判定成立）。
    const paired = buildChapterHeadings(derived, [{ index: 0, title: '上山', charStart: 0, charEnd: derived.length }]);
    expect(paired.get(0)?.headingLine).toBe('他上山的路很陡。');
  });

  it('区间标签：正常连续 → 第 M-N 章；同号单章保留；数字跳档回落从到形（CR-11）', () => {
    const { derived, chapters } = composeRealShaped();
    const h = buildChapterHeadings(derived, chapters);
    // CR-11：相邻章号 1/12（数字跳档）——「第 1-12 章」读作 12 章跨度假象 → 回落从到形。
    expect(chapterRangeLabel(h, 1, 2)).toBe('从第1章 预付200万日元到第十二章 手稿不见了');
    expect(chapterRangeLabel(h, 2, 2)).toBe('第 12 章');
    // 正常连续（章号步进 = 索引步进：1→2→3）保留区间形。
    expect(chapterRangeLabel(h, 1, 3)).toBe('第 1-3 章');
    expect(chapterRangeLabel(h, 0, 4)).toBe('从简介（卷首）到序章 黑夜的访客');
    // 章号非单调（12 → 3，章号差 ≠ 索引差）同样回落——不产「第 12-3 章」倒挂形。
    expect(chapterRangeLabel(h, 2, 3)).toBe('从第十二章 手稿不见了到第３章 全角数字');
  });

  it('join 压缩与混合形态', () => {
    expect(joinChapterShortLabels(['第 1 章', '第 12 章', '第 3 章'])).toBe('第 1、12、3 章');
    // 非全数字形态（回落标签混入）→ 逐标签顿号连接，不丢信息
    expect(joinChapterShortLabels(['第 1 章', '简介（卷首）'])).toBe('第 1 章、简介（卷首）');
    expect(joinChapterShortLabels([])).toBe('');
  });
});
