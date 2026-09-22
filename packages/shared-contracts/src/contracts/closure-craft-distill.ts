import { z } from 'zod';
import {
  craftCardCategorySchema,
  craftClaimSchema,
  craftTeachingAnchorSchema,
  craftTeachingEvidenceSchema,
} from './closure-craft-card';

// ── E10.2b（task 09-05）：蒸馏管线 schema（切条约束式输出 / 归类 / 冲突判定 /
//    材料级台账 / merge review——design §1.3 + §2.1-2.3）──
//
// 管线宿主 = shell 编排 + LLM 注入 seam（mirror 10.1 ingest），不走 agent 运行时
// （design §0 开放题 #8）。范式判据：切条/归类/冲突判定归 LLM（**约束式输出**——
// 纯代码先注段落清单/词表清单，LLM 输出空间被物理限制为「清单内选择」，集外引用
// 整体拒收不部分采纳，mirror 候选行约束式 LLM 缝 Pattern）；锚定核验/相似度算数/
// 状态机/台账归纯代码。本文件是纯 zod 契约层（零 fs/db）。
//
// 无锚即丢（R1 / ADR-15 红线②）：切条输出经锚定核验（paraRange → char span 映射 +
// 引文子串匹配容忍空白归一）失败即丢该条——计数落台账 stats.droppedNoAnchor
// （AC1 落库可见）。锚定失败即幻觉闸门的执行面。
//
// expected_downstream_consumers:
// - W3 shell 蒸馏管线（LLM 输出 parse + 台账/merge review 记账）。
// - W2 closure_craft_distill 表 repository（stats_json 列 JSON 序列化——db 侧键
//   snake_case〔claims/anchored/dropped_no_anchor/dropped_malformed/dropped_no_category/
//   merged_auto/merge_reviews/new_cards/disputes，design §1.3〕，本 schema camelCase，
//   行映射归 repository，mirror chunkSpans ↔ chunk_spans_json 先例）。

// ── 材料级蒸馏台账（closure_craft_distill 表行，design §1.3）──

/**
 * 台账状态。`material-deleted`：材料四清删除联动标注（讲法 stale + 卡保留快照仍在，
 * F-07 触发③）。`pending`：排队中；`running`：在途（phase 非 null）。
 */
export const CRAFT_DISTILL_STATUSES = ['pending', 'running', 'done', 'failed', 'material-deleted'] as const;
export type CraftDistillStatus = (typeof CRAFT_DISTILL_STATUSES)[number];
export const craftDistillStatusSchema = z.enum(CRAFT_DISTILL_STATUSES);

/**
 * 运行相位（进度可见性——运行阶段可见性是硬要求，design §0：切条/归类/去重/落卡
 * 四相位 + 耗时经 craft:distill-progress 事件报 UI）。
 */
export const CRAFT_DISTILL_PHASES = ['extracting', 'categorizing', 'dedup', 'landing'] as const;
export type CraftDistillPhase = (typeof CRAFT_DISTILL_PHASES)[number];
export const craftDistillPhaseSchema = z.enum(CRAFT_DISTILL_PHASES);

/**
 * 蒸馏统计（台账 stats_json 列的行结构；db 键 snake_case 见文件头注记）。
 * 计数恒非负整数——「锚定核验通过率 = anchored / claims 落库可见」由消费侧算，
 * 不存派生比率（mirror 派生态不存惯例）。
 */
export const craftDistillStatsSchema = z.object({
  /** 切条产出主张数。 */
  claims: z.number().int().nonnegative(),
  /** 锚定核验通过数。 */
  anchored: z.number().int().nonnegative(),
  /** 无锚丢弃数（paraRange 越界/引文不匹配——幻觉闸门计数，AC1 可见）。 */
  droppedNoAnchor: z.number().int().nonnegative(),
  /** schema-invalid 条目数（坏形状 ≠ 无锚——口径拆分：锚定通过率失真防线）。 */
  droppedMalformed: z.number().int().nonnegative(),
  /** 归类失败丢弃数（两次越界/不可解析——per-claim 降级不炸材料；不编造词目名）。 */
  droppedNoCategory: z.number().int().nonnegative(),
  /** 高置信自动挂候选数（≥0.98 档——挂上既有卡，卡回 pending_review）。 */
  mergedAuto: z.number().int().nonnegative(),
  /** 中置信人审并排任务数（0.85-0.98 档）。 */
  mergeReviews: z.number().int().nonnegative(),
  /** 新建卡数（<0.85 档）。 */
  newCards: z.number().int().nonnegative(),
  /** 分歧标记数（冲突检测 dispute=true）。 */
  disputes: z.number().int().nonnegative(),
});

export type CraftDistillStats = z.infer<typeof craftDistillStatsSchema>;

/**
 * 材料级蒸馏台账（每材料一行，PK materialId）。
 *
 * 🔑 **双 hash 门控**（design §1.3 / F-07）：contentHash（原件）变更 → 全量重蒸；
 * derivedHash（派生 .md 锚定基面）变更 → **讲法 stale 复核不自动重蒸**（校对编辑
 * 不烧 LLM）；材料删除 → 讲法 stale + status='material-deleted'。
 */
export const craftDistillLedgerSchema = z.object({
  materialId: z.string().regex(/^mat-[0-9a-f]{12}$/),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  derivedHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: craftDistillStatusSchema,
  stats: craftDistillStatsSchema,
  /** 运行相位（status='running' 时非 null；终态/未开跑 null）。 */
  phase: craftDistillPhaseSchema.nullable(),
  /** 失败/挂起原因（never-throws 失败态落台账；F-17 主张数超限挂起的诚实 note 亦落此）。 */
  error: z.string().nullable(),
  /** 最近蒸馏完成时刻（ISO 8601；从未完成过 null）。 */
  distilledAt: z.string().nullable(),
});

export type CraftDistillLedger = z.infer<typeof craftDistillLedgerSchema>;

// ── 切条约束式输出（design §2.1）──

/**
 * 切条单条输出（LLM 约束式——**只能引用 prompt 注入的段落清单内实际段落号**，集外
 * paraRange 整体拒收不部分采纳，mirror 候选行约束式 LLM 缝）。
 *
 * claim 四件套（condensed/points/scenarios/counterexamples）自 craftClaimSchema
 * extend 派生——切条输出与卡 claim 形状单源（落卡零转换）。
 */
export const craftClaimExtractionItemSchema = craftClaimSchema.extend({
  /**
   * 段落区间（**全档全局段落号**，半开 [start, end)——>30k 字按章分段串行时每段
   * 注入含段偏移的全档坐标，锚定映射零偏移换算，F-16）。
   */
  paraRange: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  /** 引文（锚定核验：须为 paraRange 映射 char span 内子串，容忍空白归一；失败即丢）。 */
  quote: z.string().min(1),
  /** 自由标签（R10——打标维度自由发挥不受控：题材/场景/流派/强度/适用文体等，不预设词表）。 */
  tags: z.array(z.string().min(1)),
});

export type CraftClaimExtractionItem = z.infer<typeof craftClaimExtractionItemSchema>;

/**
 * 切条输出（主张数组——3-8 条/3000 字参考区间 + 100-600 字/条护栏均为推测值校准
 * 注记；材料级上限 MAX_CLAIMS_PER_MATERIAL=200 超限挂起归 W3 shell 常量，F-17）。
 */
export const craftClaimExtractionOutputSchema = z.array(craftClaimExtractionItemSchema);

export type CraftClaimExtractionOutput = z.infer<typeof craftClaimExtractionOutputSchema>;

// ── 归类输出（design §2.2——受控词表内选 或 pending 词目提案）──

/** 已知词目归类（termId 只准引用 prompt 注入的 active 词目清单内 id——越界整体拒收重试一次）。 */
export const craftKnownTermCategorizationSchema = z.object({
  category: craftCardCategorySchema,
  termId: z.string().regex(/^term-[0-9a-f]{8}$/),
  confidence: z.number().min(0).max(1),
});

/**
 * 词表外提案（重试仍越界 → 建 pending 词目行 + 卡挂它进人审，「待并词表」入口）。
 * **category 仍受控 13 类内**——自由的是词目名，大类永禁自由生成（R2 红线）。
 */
export const craftProposedTermCategorizationSchema = z.object({
  proposedTerm: z.object({
    category: craftCardCategorySchema,
    name: z.string().min(1),
  }),
  confidence: z.number().min(0).max(1),
});

/**
 * 归类输出两态（每建议带置信度——含提案态，置信恒驱动人审队列排序，AC2；只排序
 * 不自动批准，R3 红线）。
 */
export const craftCategorizationOutputSchema = z.union([
  craftKnownTermCategorizationSchema,
  craftProposedTermCategorizationSchema,
]);

export type CraftCategorizationOutput = z.infer<typeof craftCategorizationOutputSchema>;

// ── 冲突判定输出（design §2.3——LLM 语义相反判定）──

/**
 * 冲突判定输出（挂候选/并排时判「语义相反」→ dispute 标记 + 讲法 note）。
 * **禁纯代码词面判冲突**（R4 红线——L1 假信心门同源）：语义相反归 LLM 判 + 人审
 * 确认；分歧不裁决（出处/裁决正交——多讲法并存，注入按 rank 过滤或并排）。
 */
export const craftDisputeVerdictOutputSchema = z.object({
  /** true = 分歧点（「无书说 X 另一作者说 Y」保留分歧不抹平）。 */
  dispute: z.boolean(),
  /** 判定理由（无论真假均要求——LLM 判断可解释，人审确认依据）。 */
  reason: z.string().min(1),
});

export type CraftDisputeVerdictOutput = z.infer<typeof craftDisputeVerdictOutputSchema>;

// ── merge review（中档去重的人审并排对比任务，design §2.3 / AC3）──

/**
 * 三动作裁决：merge 合并（newClaim 挂讲法到既有卡，卡回 pending_review）/
 * independent 分立（newClaim 建新卡）/ dismiss 驳回（丢弃该主张，记录留痕）。
 */
export const CRAFT_MERGE_REVIEW_ACTIONS = ['merge', 'independent', 'dismiss'] as const;
export type CraftMergeReviewAction = (typeof CRAFT_MERGE_REVIEW_ACTIONS)[number];
export const craftMergeReviewActionSchema = z.enum(CRAFT_MERGE_REVIEW_ACTIONS);

/** 三动作裁决结果（裁决后不可改——resolve 二次调用 = invalid-state）。 */
export const craftMergeReviewResolutionSchema = z.object({
  action: craftMergeReviewActionSchema,
  /** 裁决时刻（ISO 8601）。 */
  resolvedAt: z.string().min(1),
  note: z.string().nullable(),
});

export type CraftMergeReviewResolution = z.infer<typeof craftMergeReviewResolutionSchema>;

/**
 * merge review 记录（0.85-0.98 中档去重的人审并排对比任务——AC3 专属用例）。
 *
 * **存储形态注记**（design 未拍板，W1 契约层建议 + W2 落地裁决）：建议**独立表**
 * closure_craft_merge_review（一表一文件 repository 惯例）而非「closure_craft_card
 * 行 JSON 列存 pending 队列」——①队列生命周期 ≠ 卡生命周期（resolved 记录永塞卡
 * 真相行成幽灵数据）；②newClaim 是**未落卡**的完整条目载荷，嵌进既有卡行是实体
 * 套实体；③待审列表是审阅 UI 热路径（WHERE resolution IS NULL 自表可索引 vs JSON
 * 列全表扫）；④F-04 每材料落卡单事务里 review 行与卡行同事务进出更干净。本 schema
 * 形态对两种存储均适用（JSON 列值 = 本 record 序列化），不预绑存储。
 *
 * - `newClaim`：待并新主张**完整内联载荷**（三动作裁决据此执行：merge → 挂讲法 /
 *   independent → 建卡 / dismiss → 丢弃）——进 review 前已过锚定核验与归类。
 * - `existingCardId`：对比方既有卡（#claim 向量相似命中）。
 * - `similarity`：#claim 向量路**同形状**对比（新 condensed vs 既有卡 condensed，
 *   F-09——不与含引文的检索 body 比，跨形状分布平移会让 0.98 档永不可达）。
 * - `resolution`：null = 待审。
 */
export const craftMergeReviewSchema = z.object({
  reviewId: z.string().regex(/^mrev-[0-9a-f]{12}$/),
  newClaim: z.object({
    claim: craftClaimSchema,
    quote: z.string().min(1),
    anchor: craftTeachingAnchorSchema,
    materialId: z.string().regex(/^mat-[0-9a-f]{12}$/),
    materialContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    author: z.string().nullable(),
    /** 蒸馏时归类结论（independent 建卡时沿用；termId 可指 pending 词目提案行）。 */
    category: craftCardCategorySchema,
    termId: z.string().regex(/^term-[0-9a-f]{8}$/),
    tags: z.array(z.string().min(1)),
    confidence: z.number().min(0).max(1),
    /**
     * 来源类型 + 书名（E10.3b W7 additive，mirror craftTeachingSchema additive 形态——
     * absent = 10.2 蒸馏语义〔doc_claim〕，旧行零迁移）。newClaim 是**未落卡的完整讲法
     * 载荷**：decon 实例进并排任务时带上，resolve 成卡（merge 挂讲法 / independent 建卡）
     * 时透传进 teaching——AC4「originKind=decon_instance+书名落库」在裁决路径不丢。
     */
    originKind: z.enum(['doc_claim', 'decon_instance']).optional(),
    bookTitle: z.string().nullable().optional(),
    /**
     * 来源三级（E10.4 additive，mirror craftTeachingSchema.originTier——newClaim 是未落卡
     * 的完整讲法载荷，resolve 成卡〔merge 挂讲法 / independent 建卡〕时透传不丢；absent =
     * 旧行零迁移 / unspecified 材料蒸馏语义）。
     */
    originTier: z.enum(['original', 'community', 'criticism']).optional(),
    /** 呼应证据族（同上 additive——craftTeachingEvidenceSchema 同形状单源）。 */
    evidence: craftTeachingEvidenceSchema.optional(),
  }),
  existingCardId: z.string().regex(/^card-[0-9a-f]{12}$/),
  similarity: z.number().min(0).max(1),
  /**
   * LLM 分歧预判（CR-2b-D1，拍板 a 案 2026-09-05）：蒸馏管线建行时对双方主张调 judgeDispute
   * 的 verdict 持久化——并排人审时可见 LLM 预判提示（auto-merge 档 dispute 落卡有信号，中档
   * 此前反而只进计数）。**可选键二态纪律**：在场 = 判定成功（dispute true/false 均可能，reason
   * 必随）；缺省 = 判定不可用（LLM 失败）——不写暗示已检查的标记。并排视图展示归 W5 UI。
   */
  disputeHint: z
    .object({
      dispute: z.boolean(),
      reason: z.string().min(1),
    })
    .optional(),
  resolution: craftMergeReviewResolutionSchema.nullable(),
  createdAt: z.string().min(1),
});

export type CraftMergeReview = z.infer<typeof craftMergeReviewSchema>;
