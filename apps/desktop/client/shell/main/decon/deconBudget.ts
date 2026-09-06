import {
  DECON_CRAFT_DIMENSION_IDS,
  DECON_DIMENSIONS,
  type DeconBudget,
  type DeconCost,
  type DeconCraftDimensionId,
  type DeconP1Inheritance,
  type DeconTier,
} from '@orison/shared-contracts';
import { DECON_P4_GRANULARITY } from './p4Questionnaires';

// ── E10.3a（task 09-05）W2：拆解管线预算/成本预估（parent design §4-5——纯代码，零 IO）──
//
// 范式判据：预算判定/成本预估/累计算数全纯代码（parent design §9「全局」行）。三档预估
// 启动前呈现（wuhang「300 章 3-6 美元」式预期管理）；实际 cost_json 累计与预估对照（AC4）。
// 🔑 F-07 跨 job 复用打折：P1 事实层产物按材料指纹键控——同指纹新 job 预估时 P1 三 pass
// 清零（粗拆→细拆迭代不重付事实层成本）。
//
// ⚠️ 全部 token 常量为**推测值校准注记**（mirror 10.2 切条密度常量先例）：按中文
// ~1.5-2 字/token 与 10.2 分段预算经验设定，dogfood 首本标定后回调（parent design §12
// 风险①——手艺层 LLM 执行质量无实测先例）。
//
// expected_downstream_consumers:
// - W2 deconJob（create 时落 budget_json + 预估呈现）。
// - W3-W5 管线（每次 LLM 调用前 wouldExceedDeconBudget 判定——超限 capped 不烧 token；
//   调用后 accumulateDeconCost 累计）。
// - W6 deconIpc（成本预估卡——estimateDeconCost 直取）+ child B UI 呈现。
// - E10.3b W1：validateDeconDimensions 成员级放宽（消费 DECON_DIMENSIONS 目录常量）+
//   estimate 三态 gate（style 特化式——拍板②）。

/** 材料体量统计（预估输入——章数/字数来自 closure_material 登记行）。 */
export interface DeconMaterialStats {
  chapterCount: number;
  charCount: number;
}

/** 中文 ≈ 1.7 字/token（推测值：10.2 切条换算区间 1.5-2 取中值；dogfood 首本标定）。 */
export const DECON_CHARS_PER_TOKEN = 1.7;

/** P1a 词典分类（候选行约束式小 JSON——候选 ≤600 行；含 prompt 开销）。 */
export const DECON_P1A_FIXED_TOKENS = 6_000;

/** P1b 每章固定面（facts JSON 输出 ~1200 + prompt 开销；章文另按字数线性计）。 */
export const DECON_P1B_CHAPTER_BASE_TOKENS = 4_000;

/** P1b 每章注入上下文（词典 + 前章 synopsis 滑窗——AI-Reader ContextSummaryBuilder 模式）。 */
export const DECON_P1B_CONTEXT_TOKENS = 2_500;

/** P1c 聚合消歧（聚类后低置信对裁决——输入=实体/别名/共现表，输出=裁决 JSON）。 */
export const DECON_P1C_FIXED_TOKENS = 12_000;

/** P2 canon 每域（候选供给式归纳——输入=纯代码召回的候选段落，输出=域条目集）。 */
export const DECON_P2_PER_DOMAIN_TOKENS = 9_000;

/**
 * P3a 每章固定面（枚举小 JSON：钩子/转折/情绪拍/剧情段四相位/爽点段落——信息差不重打 F-08）。
 * **章文输入另按字数线性计**（E10.3b W1 顺手修——原 flat 2200 不随章长伸缩，大书低估；
 * 对齐 p1b 结构）。
 */
export const DECON_P3A_PER_CHAPTER_TOKENS = 2_200;

/** P5 书级读法（输入=弧级聚合+计量统计非全书原文——两级摘要范式；粗拆即含）。 */
export const DECON_P5_BOOK_READING_TOKENS = 20_000;

/** P5 章评每章（两级摘要之章级阅读——细拆以上档位；推测注记：章评归细拆+）。 */
export const DECON_P5_CHAPTER_REVIEW_TOKENS = 1_500;

/** P5 名场面细批每场（深度档——R4-G 逐词层级协议；候选≈章数×0.3 推测值）。 */
export const DECON_P5_SCENE_ANNOTATION_TOKENS = 6_000;
export const DECON_P5_SCENES_PER_CHAPTER = 0.3;

/**
 * P4 每维每章（章级问题单——正典词汇反向提问）+ 每维每弧（弧级通读——sansheng 分组纪律）。
 * **章文输入另按字数线性计**（E10.3b W1——原 flat 2500 同 p3a 的不随章长伸缩问题）。
 * 面的选择按 DECON_P4_GRANULARITY（CR-1——弧级维不计章级项，见 estimateDeconCost）。
 */
export const DECON_P4_PER_CHAPTER_TOKENS = 2_500;
export const DECON_P4_PER_ARC_TOKENS = 18_000;

/**
 * huoke 开篇子集窗口（design §3.1：前 min(12, 章数) 章）。**单源落预估侧**（CR-1——预估与
 * p4Craft 章级 unit 集共消费；p4Craft 自此 import 并再导出，反向定义会与 deconBudget↔p4Craft
 * 既有依赖成环）。
 */
export const DECON_HUOKE_CHAPTER_WINDOW = 12;

/**
 * P4 风格维特化（书级抽样非逐章——输入=style_stats 机械统计〔纯代码直落，LLM 不编数字〕+
 * 每弧首/中/尾抽样段 + 高潮段对照，输出=14 节 payload + md 报告；arcs×2500+6000 为推测值
 * 注记，dogfood 首本标定）。coarse+style 档唯一的手艺面 pass（拍板②）。
 */
export const DECON_P4_STYLE_PER_ARC_TOKENS = 2_500;
export const DECON_P4_STYLE_FIXED_TOKENS = 6_000;

/** P6 craft 落卡每候选（归类候选/词目挂接建议——10.2 管线复用面）。 */
export const DECON_P6_PER_CRAFT_TOKENS = 600;
/** 每维每弧手艺候选条数（推测值——落卡候选密度，dogfood 标定）。 */
export const DECON_P6_CANDIDATES_PER_ARC_DIM = 3;

/** 弧字数（R2 计量化：211 万字 ≈ 35-40 剧情段 → ~5-6 万字/段；卷界优先归 P3b 切分）。 */
export const DECON_ARC_CHARS = 60_000;

/** canon 六域（shared-contracts DECON_CANON_DOMAINS 同值——预估侧钉死 6）。 */
const CANON_DOMAIN_COUNT = 6;

/** 弧数估计（≥1——材料不足一弧按单弧）。 */
export function estimateDeconArcCount(stats: DeconMaterialStats): number {
  return Math.max(1, Math.round(stats.charCount / DECON_ARC_CHARS));
}

/** 三档预估输入。`p1Reusable` = P1 三 pass **各自**继承旗标（CR-17：仅词典在时 p1b 不打折——逐 pass 折算非全有全无）。 */
export interface DeconEstimateInput {
  tier: DeconTier;
  /** 维度子集（成员权威 DECON_DIMENSIONS——style 可与手艺维并选，拍板②；此处只按成员分派计）。 */
  dimensions: readonly string[];
  stats: DeconMaterialStats;
  p1Reusable: DeconP1Inheritance;
}

/** 三档预估产出（byPass 键 = pass 全值：'p1a'/'p1b'/'p4:<dim>'/'p5:book_reading'…）。 */
export interface DeconEstimate {
  totalTokens: number;
  byPass: Record<string, number>;
}

/**
 * 三档成本预估（纯函数——启动前呈现面）：
 * - 粗拆 = P1 + P2 六域 + P3 + 书级读法（canon + 骨架）+ 可选风格维特化式（拍板②——
 *   coarse 勾 style 时也估，原 `tier !== 'coarse'` 门会漏估）。
 * - 细拆 = 粗拆 + 手艺层选定维度（1-3）+ 章评 + 风格维可选。
 * - 深度 = 细拆全维度（12 手艺维）+ 名场面细批。
 * **CR-1 按维度粒度计费**：手艺维的面消费 DECON_P4_GRANULARITY（runner 同一登记——预估与
 * 实跑同源）：弧级维（jiegou/renshe/shijieguan/fubi/duizhao）只计 `arcs × PER_ARC`（不计
 * 章级项——旧式按章计费 fine/deep 虚增数百万 token）；带章面的维计 `chapters ×（2500+章文
 * 线性）`；huoke 章面 = 开篇子集 min(12, 章数)；章+弧双面维两面合计。三态 gate（E10.3b W1）：
 * style 恒走特化式（书级抽样）；**p6 计手艺维数（排除 style——风格维不落 craft 卡）**；
 * chapter_review 维持手艺维非空（档位校验下与 fine+ 等价）。P3b 纯代码算数零 LLM token
 * （范式判据——打标 LLM / 算数纯代码）。章文输入按 DECON_CHARS_PER_TOKEN 线性折算（中文
 * 推测值——p3a/p4 章级公式 E10.3b W1 补线性项）。
 */
export function estimateDeconCost(input: DeconEstimateInput): DeconEstimate {
  const chapters = Math.max(0, input.stats.chapterCount);
  const charsPerChapter = chapters > 0 ? input.stats.charCount / chapters : input.stats.charCount;
  const chapterTextTokens = Math.max(0, charsPerChapter) / DECON_CHARS_PER_TOKEN;
  const arcs = estimateDeconArcCount(input.stats);
  const byPass: Record<string, number> = {};

  if (!input.p1Reusable.p1a) byPass.p1a = DECON_P1A_FIXED_TOKENS;
  if (!input.p1Reusable.p1b) {
    byPass.p1b = Math.round(
      chapters * (DECON_P1B_CHAPTER_BASE_TOKENS + DECON_P1B_CONTEXT_TOKENS + chapterTextTokens),
    );
  }
  if (!input.p1Reusable.p1c) byPass.p1c = DECON_P1C_FIXED_TOKENS;
  // F-07：各 pass 旗标独立打折（继承同指纹产物的 pass 不入账——零重付；CR-17 部分继承不再
  // 全有全无——仅词典在时 p1b 照常估）。

  byPass.p2 = Math.round(CANON_DOMAIN_COUNT * DECON_P2_PER_DOMAIN_TOKENS);
  byPass.p3a = Math.round(chapters * (DECON_P3A_PER_CHAPTER_TOKENS + chapterTextTokens));
  byPass['p5:book_reading'] = DECON_P5_BOOK_READING_TOKENS;

  const craftDims = input.dimensions.filter((d) => d !== 'style');
  if (input.dimensions.includes('style')) {
    byPass['p4:style'] = Math.round(arcs * DECON_P4_STYLE_PER_ARC_TOKENS + DECON_P4_STYLE_FIXED_TOKENS);
  }
  if (craftDims.length > 0) {
    for (const dim of craftDims) {
      // CR-1：粒度面按 DECON_P4_GRANULARITY 分派计费（成员上游经 validateDeconDimensions 门
      // ——目录外 id 到不了这里；防御性空面按零估不虚增）。
      const faces = DECON_P4_GRANULARITY[dim as DeconCraftDimensionId] ?? [];
      let dimTokens = 0;
      if (faces.includes('chapter')) {
        const chapterUnits = dim === 'huoke' ? Math.min(DECON_HUOKE_CHAPTER_WINDOW, chapters) : chapters;
        dimTokens += chapterUnits * (DECON_P4_PER_CHAPTER_TOKENS + chapterTextTokens);
      }
      if (faces.includes('arc')) {
        dimTokens += arcs * DECON_P4_PER_ARC_TOKENS;
      }
      byPass[`p4:${dim}`] = Math.round(dimTokens);
    }
    byPass['p5:chapter_review'] = Math.round(chapters * DECON_P5_CHAPTER_REVIEW_TOKENS);
    byPass.p6 = Math.round(craftDims.length * arcs * DECON_P6_CANDIDATES_PER_ARC_DIM * DECON_P6_PER_CRAFT_TOKENS);
    if (input.tier === 'deep') {
      const scenes = Math.max(1, Math.round(chapters * DECON_P5_SCENES_PER_CHAPTER));
      byPass['p5:scene_annotation'] = Math.round(scenes * DECON_P5_SCENE_ANNOTATION_TOKENS);
    }
  }

  const totalTokens = Object.values(byPass).reduce((sum, v) => sum + v, 0);
  return { totalTokens, byPass };
}

// ── 维度子集校验（目的先行——档位 × 维度成员/数量约束；E10.3b W1 成员级放宽）──

/**
 * 档位 × 维度子集合法性（纯函数，**成员级**——E10.3b 拍板②；成员枚举权威 =
 * shared-contracts DECON_DIMENSIONS 13 项目录）：
 * - 成员：每项须在目录内且不重复。
 * - coarse → dims ⊆ {style}（风格维可选可勾——粗拆档选择器只显风格维）。
 * - fine → 手艺维 1-3 个 + style 可选不计入。
 * - deep → 全 12 手艺维必含 + style 可选。
 * 返回错误消息或 null（合法）。
 */
export function validateDeconDimensions(tier: DeconTier, dimensions: readonly string[]): string | null {
  const known = new Set<string>(DECON_DIMENSIONS.map((d) => d.id));
  const seen = new Set<string>();
  for (const dim of dimensions) {
    if (!known.has(dim)) return `未知维度「${dim}」——维度目录以拆书页选择器为准`;
    if (seen.has(dim)) return `维度「${dim}」重复勾选`;
    seen.add(dim);
  }
  const craftCount = dimensions.filter((d) => d !== 'style').length;
  if (tier === 'coarse') {
    return craftCount === 0 ? null : '粗拆不含手艺层维度（只能勾选风格维——细拆/深度才选手艺维度子集）';
  }
  if (tier === 'fine') {
    if (craftCount < 1 || craftCount > 3) return '细拆须选 1-3 个手艺维度（风格维可选、不计入数量）';
    return null;
  }
  const missing = DECON_CRAFT_DIMENSION_IDS.filter((d) => !seen.has(d));
  return missing.length === 0 ? null : `深度档须包含全部 12 个手艺维度（缺：${missing.join('、')}）`;
}

// ── 预算判定 + cost 累计（管线运行面——capped 诚实挂起家族纪律）──

/** cost 按 pass 茎聚合（'p4:huoke' → 'p4'——perPass 预算键为茎）。 */
export function deconCostStemTotals(cost: DeconCost): Record<string, { tokens: number; calls: number }> {
  const totals: Record<string, { tokens: number; calls: number }> = {};
  for (const [pass, entry] of Object.entries(cost.byPass)) {
    const stem = pass.split(':')[0];
    const acc = totals[stem] ?? { tokens: 0, calls: 0 };
    acc.tokens += entry.tokens;
    acc.calls += entry.calls;
    totals[stem] = acc;
  }
  return totals;
}

/**
 * 预算判定（**LLM 调用前**——超限 → state=capped + job=capped，不烧 token，parent design
 * §4/capped 语义）。判总限 + per-pass 茎限两道；任一超即 true。
 */
export function wouldExceedDeconBudget(budget: DeconBudget, cost: DeconCost, pass: string, nextCallTokens: number): boolean {
  if (budget.totalTokens !== null && cost.totalTokens + nextCallTokens > budget.totalTokens) {
    return true;
  }
  const stem = pass.split(':')[0];
  const stemCap = budget.perPass[stem];
  if (stemCap !== undefined) {
    const stemTokens = deconCostStemTotals(cost)[stem]?.tokens ?? 0;
    if (stemTokens + nextCallTokens > stemCap) return true;
  }
  return false;
}

/**
 * cost 累计（LLM 调用后——纯函数返回新 record，不就地改；调用方落库 cost_json）。
 * tokens/calls 恒非负整数。`estimated`（CR-13）：本笔是否字符近似折算（provider 无 usage）
 * ——sticky OR（一笔近似即整表 estimated=true，诚实标注预估对照面）。
 */
export function accumulateDeconCost(cost: DeconCost, pass: string, tokens: number, calls = 1, estimated = true): DeconCost {
  const prev = cost.byPass[pass] ?? { tokens: 0, calls: 0 };
  return {
    totalTokens: cost.totalTokens + Math.max(0, Math.round(tokens)),
    calls: cost.calls + Math.max(0, Math.round(calls)),
    estimated: cost.estimated || estimated,
    byPass: {
      ...cost.byPass,
      [pass]: {
        tokens: prev.tokens + Math.max(0, Math.round(tokens)),
        calls: prev.calls + Math.max(0, Math.round(calls)),
      },
    },
  };
}
