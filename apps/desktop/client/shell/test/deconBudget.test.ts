import { describe, expect, it } from 'vitest';
import {
  DECON_ARC_CHARS,
  accumulateDeconCost,
  deconCostStemTotals,
  estimateDeconArcCount,
  estimateDeconCost,
  validateDeconDimensions,
  wouldExceedDeconBudget,
} from '../main/decon/deconBudget';
import { DECON_CRAFT_DIMENSION_IDS } from '@orison/shared-contracts';
import type { DeconBudget, DeconCost } from '@orison/shared-contracts';

// E10.3a W2：预算/成本预估纯函数面——三档预估（含 F-07 P1 打折）/ 维度校验 / 预算判定 /
// cost 累计。AC4（三档预估 + 实际对照同量级）的函数半边。

const STATS = { chapterCount: 300, charCount: 2_100_000 };

const P1_NONE = { p1a: false, p1b: false, p1c: false };
const P1_ALL = { p1a: true, p1b: true, p1c: true };

function zeroCost(): DeconCost {
  return { totalTokens: 0, calls: 0, byPass: {}, estimated: true };
}

function uncapped(): DeconBudget {
  return { totalTokens: null, perPass: {} };
}

describe('estimateDeconCost（三档预估）', () => {
  it('粗拆：P1+P2+P3a+书级读法；无 p4/p5 章评维——coarse 维度必空才合法', () => {
    const est = estimateDeconCost({ tier: 'coarse', dimensions: [], stats: STATS, p1Reusable: P1_NONE });
    expect(est.byPass.p1a).toBeGreaterThan(0);
    expect(est.byPass.p1b).toBeGreaterThan(0);
    expect(est.byPass.p1c).toBeGreaterThan(0);
    expect(est.byPass.p2).toBeGreaterThan(0);
    expect(est.byPass.p3a).toBeGreaterThan(0);
    expect(est.byPass['p5:book_reading']).toBeGreaterThan(0);
    expect(est.byPass['p5:chapter_review']).toBeUndefined();
    expect(est.byPass['p5:scene_annotation']).toBeUndefined();
    expect(est.byPass.p6).toBeUndefined();
    expect(Object.keys(est.byPass).filter((k) => k.startsWith('p4:'))).toEqual([]);
    expect(est.totalTokens).toBe(Object.values(est.byPass).reduce((a, b) => a + b, 0));
  });

  it('粗拆 p1b 随章文线性：300 章 × 7000 字的输入 token 按 DECON_CHARS_PER_TOKEN 折算', () => {
    const est = estimateDeconCost({ tier: 'coarse', dimensions: [], stats: STATS, p1Reusable: P1_NONE });
    const charsPerChapter = STATS.charCount / STATS.chapterCount;
    const expectedPerChapter = 4_000 + 2_500 + charsPerChapter / 1.7;
    expect(est.byPass.p1b).toBe(Math.round(STATS.chapterCount * expectedPerChapter));
  });

  it('E10.3b W1：p3a/p4 章级公式补章文线性项（原 flat 不随章长伸缩——大书低估）', () => {
    const est = estimateDeconCost({ tier: 'fine', dimensions: ['qingxu'], stats: STATS, p1Reusable: P1_NONE });
    const charsPerChapter = STATS.charCount / STATS.chapterCount;
    const linear = charsPerChapter / 1.7;
    expect(est.byPass.p3a).toBe(Math.round(STATS.chapterCount * (2_200 + linear)));
    const arcs = Math.round(STATS.charCount / 60_000);
    expect(est.byPass['p4:qingxu']).toBe(
      Math.round(STATS.chapterCount * (2_500 + linear) + arcs * 18_000),
    );
  });

  it('CR-1 按维度粒度计费：弧级维只计弧项（不计章级项）/ huoke 开篇子集 / wenbi 仅章面 / 双面维合计', () => {
    const est = estimateDeconCost({
      tier: 'deep',
      dimensions: ['huoke', 'jiegou', 'renshe', 'shijieguan', 'qingxu', 'wenbi', 'fubi', 'duizhao'],
      stats: STATS,
      p1Reusable: P1_NONE,
    });
    const charsPerChapter = STATS.charCount / STATS.chapterCount;
    const linear = charsPerChapter / 1.7;
    const arcs = Math.round(STATS.charCount / DECON_ARC_CHARS);
    const arcOnly = Math.round(arcs * 18_000);
    // 弧级维（jiegou/renshe/shijieguan/fubi/duizhao）只计 arcs × 18000——旧式按章计费虚增数百万。
    expect(est.byPass['p4:jiegou']).toBe(arcOnly);
    expect(est.byPass['p4:renshe']).toBe(arcOnly);
    expect(est.byPass['p4:shijieguan']).toBe(arcOnly);
    expect(est.byPass['p4:fubi']).toBe(arcOnly);
    expect(est.byPass['p4:duizhao']).toBe(arcOnly);
    // huoke 章面 = 开篇子集 min(12, 章数)——非全 300 章。
    expect(est.byPass['p4:huoke']).toBe(Math.round(12 * (2_500 + linear)));
    // wenbi 仅章面（无弧项）。
    expect(est.byPass['p4:wenbi']).toBe(Math.round(STATS.chapterCount * (2_500 + linear)));
    // 章+弧双面维（qingxu）两面合计。
    expect(est.byPass['p4:qingxu']).toBe(Math.round(STATS.chapterCount * (2_500 + linear) + arcs * 18_000));
  });

  it('细拆：+ 维度子集 p4:<dim> + 章评 + p6；无名场面细批', () => {
    const est = estimateDeconCost({ tier: 'fine', dimensions: ['qidaigan', 'jiegou'], stats: STATS, p1Reusable: P1_NONE });
    expect(est.byPass['p4:qidaigan']).toBeGreaterThan(0);
    expect(est.byPass['p4:jiegou']).toBeGreaterThan(0);
    expect(est.byPass['p5:chapter_review']).toBeGreaterThan(0);
    expect(est.byPass.p6).toBeGreaterThan(0);
    expect(est.byPass['p5:scene_annotation']).toBeUndefined();
  });

  it('E10.3b 三态 gate①：coarse+style 也估——p4:style 走特化式（arcs×2500+6000），无章评/p6', () => {
    const est = estimateDeconCost({ tier: 'coarse', dimensions: ['style'], stats: STATS, p1Reusable: P1_NONE });
    const arcs = Math.round(STATS.charCount / 60_000);
    expect(est.byPass['p4:style']).toBe(Math.round(arcs * 2_500 + 6_000));
    expect(est.byPass['p5:chapter_review']).toBeUndefined();
    expect(est.byPass.p6).toBeUndefined();
    expect(Object.keys(est.byPass).filter((k) => k.startsWith('p4:') && k !== 'p4:style')).toEqual([]);
  });

  it('C6 thinkingBySlot：开启档系数只放大对应 slot 的 pass——未开启 slot 面与 base 零变化', () => {
    const input = { tier: 'fine' as const, dimensions: ['qingxu', 'style'], stats: STATS, p1Reusable: P1_NONE };
    const base = estimateDeconCost(input);
    // extraction（p1a/p1b/p3a/p6）+ review-judge（p1c/p2/p4:<手艺维>）开启：
    const withExRev = estimateDeconCost({ ...input, thinkingBySlot: { extraction: 1.5, 'review-judge': 1.5 } });
    expect(withExRev.byPass.p1a).toBe(Math.round(base.byPass.p1a! * 1.5));
    expect(withExRev.byPass.p1b).toBe(Math.round(base.byPass.p1b! * 1.5));
    expect(withExRev.byPass.p3a).toBe(Math.round(base.byPass.p3a! * 1.5));
    expect(withExRev.byPass.p6).toBe(Math.round(base.byPass.p6! * 1.5));
    expect(withExRev.byPass.p1c).toBe(Math.round(base.byPass.p1c! * 1.5));
    expect(withExRev.byPass.p2).toBe(Math.round(base.byPass.p2! * 1.5));
    expect(withExRev.byPass['p4:qingxu']).toBe(Math.round(base.byPass['p4:qingxu']! * 1.5));
    // writer-draft（p5:book_reading / p5:chapter_review / p4:style）未开启 → 原值：
    expect(withExRev.byPass['p5:book_reading']).toBe(base.byPass['p5:book_reading']);
    expect(withExRev.byPass['p5:chapter_review']).toBe(base.byPass['p5:chapter_review']);
    expect(withExRev.byPass['p4:style']).toBe(base.byPass['p4:style']);
    expect(withExRev.totalTokens).toBe(Object.values(withExRev.byPass).reduce((a, b) => a + b, 0));
    expect(withExRev.totalTokens).toBeGreaterThan(base.totalTokens);
    // writer-draft 开启 → p5/p4:style 面放大、extraction 面不变：
    const withWriter = estimateDeconCost({ ...input, thinkingBySlot: { 'writer-draft': 1.5 } });
    expect(withWriter.byPass['p5:book_reading']).toBe(Math.round(base.byPass['p5:book_reading']! * 1.5));
    expect(withWriter.byPass['p4:style']).toBe(Math.round(base.byPass['p4:style']! * 1.5));
    expect(withWriter.byPass.p1b).toBe(base.byPass.p1b);
    // 空表 / 系数 1 = 旧行为（零思考假设逐字节不变）：
    expect(estimateDeconCost({ ...input, thinkingBySlot: {} })).toEqual(base);
    expect(estimateDeconCost({ ...input, thinkingBySlot: { extraction: 1 } })).toEqual(base);
  });

  it('E10.3b 三态 gate②③：fine 手艺维原式 + style 特化式并存；p6 只计手艺维（排除 style——风格维不落 craft 卡）', () => {
    const withStyle = estimateDeconCost({
      tier: 'fine',
      dimensions: ['qingxu', 'style'],
      stats: STATS,
      p1Reusable: P1_NONE,
    });
    const styleOnly = estimateDeconCost({ tier: 'coarse', dimensions: ['style'], stats: STATS, p1Reusable: P1_NONE });
    const craftOnly = estimateDeconCost({ tier: 'fine', dimensions: ['qingxu'], stats: STATS, p1Reusable: P1_NONE });
    expect(withStyle.byPass['p4:style']).toBe(styleOnly.byPass['p4:style']); // style 恒走特化式
    expect(withStyle.byPass['p4:qingxu']).toBe(craftOnly.byPass['p4:qingxu']); // 手艺维原式不受 style 影响
    const arcs = Math.round(STATS.charCount / 60_000);
    expect(withStyle.byPass.p6).toBe(Math.round(1 * arcs * 3 * 600)); // 只计 qingxu（style 排除）
  });

  it('深度：细拆面 + 名场面细批（scenes ≈ 章数 × 0.3）', () => {
    const est = estimateDeconCost({
      tier: 'deep',
      dimensions: ['huoke', 'qidaigan', 'jiegou', 'renshe'],
      stats: STATS,
      p1Reusable: P1_NONE,
    });
    expect(est.byPass['p5:scene_annotation']).toBe(Math.round(Math.max(1, Math.round(300 * 0.3)) * 6_000));
  });

  it('档位单调：deep ≥ fine ≥ coarse（同材料同维度前缀）', () => {
    const dims = ['qingxu', 'jiegou', 'fubi'];
    const coarse = estimateDeconCost({ tier: 'coarse', dimensions: [], stats: STATS, p1Reusable: P1_NONE });
    const fine = estimateDeconCost({ tier: 'fine', dimensions: dims, stats: STATS, p1Reusable: P1_NONE });
    const deep = estimateDeconCost({ tier: 'deep', dimensions: dims, stats: STATS, p1Reusable: P1_NONE });
    expect(coarse.totalTokens).toBeLessThan(fine.totalTokens);
    expect(fine.totalTokens).toBeLessThan(deep.totalTokens);
  });

  it('F-07 打折：p1Reusable → P1 三 pass 清零（粗拆→细拆迭代不重付事实层）', () => {
    const fresh = estimateDeconCost({ tier: 'fine', dimensions: ['qingxu'], stats: STATS, p1Reusable: P1_NONE });
    const reused = estimateDeconCost({ tier: 'fine', dimensions: ['qingxu'], stats: STATS, p1Reusable: P1_ALL });
    expect(reused.byPass.p1a).toBeUndefined();
    expect(reused.byPass.p1b).toBeUndefined();
    expect(reused.byPass.p1c).toBeUndefined();
    // 其余 pass 不受打折影响。
    expect(reused.byPass.p2).toBe(fresh.byPass.p2);
    expect(reused.byPass.p3a).toBe(fresh.byPass.p3a);
    expect(reused.totalTokens).toBeLessThan(fresh.totalTokens);
  });

  it('CR-17 部分继承逐 pass 打折：仅词典在（p1a 继承）→ p1b/p1c 照常预估（不再全有全无）', () => {
    const fresh = estimateDeconCost({ tier: 'coarse', dimensions: [], stats: STATS, p1Reusable: P1_NONE });
    const partial = estimateDeconCost({ tier: 'coarse', dimensions: [], stats: STATS, p1Reusable: { p1a: true, p1b: false, p1c: false } });
    expect(partial.byPass.p1a).toBeUndefined(); // 词典继承 → p1a 打折
    expect(partial.byPass.p1b).toBe(fresh.byPass.p1b); // facts 未齐 → p1b 照估
    expect(partial.byPass.p1c).toBe(fresh.byPass.p1c);
    expect(partial.totalTokens).toBeLessThan(fresh.totalTokens);
  });

  it('百万字量级对照（wuhang 300 章 3-6 美元式预期管理的粗校验）：粗拆非 P1 打折在 1M-10M token 带内', () => {
    const est = estimateDeconCost({ tier: 'coarse', dimensions: [], stats: STATS, p1Reusable: P1_NONE });
    // 全书 210 万字 / 1.7 ≈ 1.24M 输入 token——粗拆含逐章通读（p1b+p3a 两处章文线性；E10.3b
    // W1 给 p3a 补线性项后诚实总量级 ≈5M——原 <5M 上界是 p3a 低估时代所设，随迁非破坏）。
    // 不精细断言具体值——常量是推测值校准注记，只钉量级防数量级回归。
    expect(est.totalTokens).toBeGreaterThan(1_000_000);
    expect(est.totalTokens).toBeLessThan(10_000_000);
  });

  it('CR-1 百万字 deep 全 12 维重算钉带（弧级维省下章级项 + huoke 开篇子集后的诚实总量级）', () => {
    const est = estimateDeconCost({ tier: 'deep', dimensions: [...DECON_CRAFT_DIMENSION_IDS], stats: STATS, p1Reusable: P1_NONE });
    // 重算真实值（300 章 210 万字 / 1.7 字每 token / 35 弧）：五章级弧维各 630K + 五双面维各
    // ~2.62M + wenbi ~1.99M + huoke 开篇子集 ~79K + P1/P2/P3a/章评/细批/p6 ≈ **25.2M**（旧式
    // 全维「章+弧」≈ 31.4M+——CR-1 前虚增数百万）。钉带防数量级回归（常量推测值不精断）。
    expect(est.totalTokens).toBeGreaterThan(20_000_000);
    expect(est.totalTokens).toBeLessThan(30_000_000);
    // 全 12 维各得一行（粒度分派不漏维）。
    expect(Object.keys(est.byPass).filter((k) => k.startsWith('p4:'))).toHaveLength(DECON_CRAFT_DIMENSION_IDS.length);
  });
});

describe('estimateDeconArcCount（弧估计）', () => {
  it('≥1 下限 + 按 DECON_ARC_CHARS 取整', () => {
    expect(estimateDeconArcCount({ chapterCount: 1, charCount: 100 })).toBe(1);
    expect(estimateDeconArcCount({ chapterCount: 300, charCount: 2_100_000 })).toBe(
      Math.round(2_100_000 / DECON_ARC_CHARS),
    );
  });
});

describe('validateDeconDimensions（档位 × 维度子集——E10.3b W1 成员级）', () => {
  it('coarse：空或仅 style 合法（拍板②——粗拆档选择器只显风格维）；手艺维拒', () => {
    expect(validateDeconDimensions('coarse', [])).toBeNull();
    expect(validateDeconDimensions('coarse', ['style'])).toBeNull();
    expect(validateDeconDimensions('coarse', ['qingxu'])).not.toBeNull();
    expect(validateDeconDimensions('coarse', ['style', 'qingxu'])).not.toBeNull();
  });

  it('fine：手艺维 1-3 + style 可选不计入', () => {
    expect(validateDeconDimensions('fine', ['qingxu'])).toBeNull();
    expect(validateDeconDimensions('fine', ['qingxu', 'jiegou', 'fubi'])).toBeNull();
    expect(validateDeconDimensions('fine', ['qingxu', 'style'])).toBeNull(); // style 不计入 1-3
    expect(validateDeconDimensions('fine', [])).not.toBeNull();
    expect(validateDeconDimensions('fine', ['style'])).not.toBeNull(); // 零手艺维
    expect(
      validateDeconDimensions('fine', ['qingxu', 'jiegou', 'fubi', 'duizhao']),
    ).not.toBeNull();
    expect(
      validateDeconDimensions('fine', ['qingxu', 'jiegou', 'fubi', 'duizhao', 'style']),
    ).not.toBeNull(); // 手艺维 4 个（style 不计入仍是 4）
  });

  it('deep：全 12 手艺维必含 + style 可选', () => {
    const all12 = [
      'huoke',
      'qidaigan',
      'jiegou',
      'renshe',
      'shijieguan',
      'qingxu',
      'wenbi',
      'zaogeng',
      'xinxicha',
      'shijian',
      'fubi',
      'duizhao',
    ];
    expect(validateDeconDimensions('deep', all12)).toBeNull();
    expect(validateDeconDimensions('deep', [...all12, 'style'])).toBeNull();
    expect(validateDeconDimensions('deep', [])).not.toBeNull();
    const missingOne = all12.filter((d) => d !== 'fubi');
    expect(validateDeconDimensions('deep', missingOne)?.includes('fubi')).toBe(true); // 缺维点名
  });

  it('成员校验：目录外 id / 重复勾选拒', () => {
    expect(validateDeconDimensions('fine', ['d1'])).not.toBeNull(); // 目录外
    expect(validateDeconDimensions('fine', ['qingxu', 'qingxu'])?.includes('重复')).toBe(true);
  });
});

describe('wouldExceedDeconBudget（预算判定——LLM 调用前）', () => {
  it('总限：累计 + 下次调用超 totalTokens → true；未超 → false', () => {
    const budget: DeconBudget = { totalTokens: 10_000, perPass: {} };
    const cost = zeroCost();
    expect(wouldExceedDeconBudget(budget, cost, 'p1a', 10_000)).toBe(false);
    const after = accumulateDeconCost(cost, 'p1a', 9_000);
    expect(wouldExceedDeconBudget(budget, after, 'p1b', 1_500)).toBe(true);
    expect(wouldExceedDeconBudget(budget, after, 'p1b', 1_000)).toBe(false);
  });

  it('null 总限 = 无上限跑完为止', () => {
    expect(wouldExceedDeconBudget(uncapped(), zeroCost(), 'p1b', 99_999_999)).toBe(false);
  });

  it('per-pass 茎限：p4:<dim> 聚合到 p4 茎判；p5 独立茎不受 p4 影响', () => {
    const budget: DeconBudget = { totalTokens: null, perPass: { p4: 20_000 } };
    let cost = zeroCost();
    cost = accumulateDeconCost(cost, 'p4:huoke', 12_000);
    cost = accumulateDeconCost(cost, 'p4:jiegou', 5_000);
    expect(wouldExceedDeconBudget(budget, cost, 'p4:qidaigan', 4_000)).toBe(true); // 17k + 4k > 20k
    expect(wouldExceedDeconBudget(budget, cost, 'p4:qidaigan', 3_000)).toBe(false);
    expect(wouldExceedDeconBudget(budget, cost, 'p5:book_reading', 100_000)).toBe(false); // p5 无茎限
  });
});

describe('accumulateDeconCost / deconCostStemTotals（累计与聚合）', () => {
  it('累加 per-pass 与总量；不就地改原 record', () => {
    const cost = zeroCost();
    const a = accumulateDeconCost(cost, 'p1b', 1_200);
    const b = accumulateDeconCost(a, 'p1b', 800, 1);
    expect(cost.totalTokens).toBe(0);
    expect(b.totalTokens).toBe(2_000);
    expect(b.calls).toBe(2);
    expect(b.byPass.p1b).toEqual({ tokens: 2_000, calls: 2 });
  });

  it('CR-13 estimated sticky OR：usage 真值笔 estimated=false / 近似笔 true；一笔近似即整表 true', () => {
    // 起点 true（emptyCost 近似底座）——追加真值笔不清旗（sticky OR）。
    const fromApproxBase = accumulateDeconCost(zeroCost(), 'p1a', 500, 1, false);
    expect(fromApproxBase.estimated).toBe(true);
    const freshAll: DeconCost = { totalTokens: 0, calls: 0, byPass: {}, estimated: false };
    const realOnly = accumulateDeconCost(freshAll, 'p1a', 500, 1, false);
    expect(realOnly.estimated).toBe(false); // 全笔真值 → false
    const mixed = accumulateDeconCost(realOnly, 'p1b', 300, 1, true); // 追加一笔近似
    expect(mixed.estimated).toBe(true); // sticky OR——一笔近似即整表 true
  });

  it('茎聚合：p4 两维合计到 p4 茎', () => {
    let cost = zeroCost();
    cost = accumulateDeconCost(cost, 'p4:huoke', 100, 1);
    cost = accumulateDeconCost(cost, 'p4:jiegou', 50, 2);
    cost = accumulateDeconCost(cost, 'p1b', 30, 1);
    const stems = deconCostStemTotals(cost);
    expect(stems.p4).toEqual({ tokens: 150, calls: 3 });
    expect(stems.p1b).toEqual({ tokens: 30, calls: 1 });
    expect(stems.p5).toBeUndefined();
  });
});
