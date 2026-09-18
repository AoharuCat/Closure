import { z } from 'zod';
import { craftCardCategorySchema, craftTeachingAnchorSchema } from './closure-craft-card';

// ── E10.3a（task 09-05）W1：小说拆解管线契约（parent design §2 数据模型——Zod 单源，ADR-4）──
//
// 「拆解」= 多 pass 倒推一本经 10.1 摄取的小说材料：P1 事实层（词典→逐章提取→聚合消歧）
// → P2 canon 六域 → P3 计量 → P4 手艺层按维多轮 → P5 输出装配 → P6 craft 落卡。本文件是
// child A（P0-P2 + 断点底座）与 child B（P3-P6）共用的契约层（零 fs/db）。
//
// 红线注记：
// - **无锚即丢（R8 / ADR-15 红线②）**：一切提取条目（facts/canon/打标）指不出原文 span 直接
//   丢弃。span 基面 = 材料派生 .md 归一化文本（与 10.2 craftTeachingAnchor 同基同形——本文件
//   直接复用该 schema 单源防漂移）。
// - **双指纹 stale 门控（F-02）**：job 行持有 material_content_hash（原件）+ derived_hash
//   （派生 .md 锚定基面）双指纹——材料被校对/重摄取后现值失配 → job=stale，锚点整体漂移
//   不可静默沿用（用户确认重跑，非自动）。
// - **事实层材料级键控（F-07）**：facts/entity/dictionary 三表按 (material_ref, derived_hash)
//   键控——非 job 私有。新 job（粗拆→细拆迭代）同指纹直接继承 P1 产物，不重付事实层成本。
// - 范式判据（parent design §9）：提取/归纳/裁决归 LLM；断点状态机/预算/成本预估/锚定校验
//   归纯代码。本文件只定义形状，不判定语义。
//
// expected_downstream_consumers:
// - W2 shell 断点底座（decon/deconJob.ts 状态机 + decon/deconBudget.ts 预算/预估）。
// - W3-W5 P1a/P1b/P1c/P2 管线（LLM 输出 parse + 产物落库）。
// - child B P3-P6（计量打标/手艺层/报告/craft 落卡——pass 枚举已含 p3a/p3b/p4:/p5:/p6）。
// - child B 三表（E10.3b W1：维度目录/打标正典枚举/findings 契约 + product/report/review 行
//   schema——W2-W5 管线落库 + 拆书页 UI/人审闸门消费）。
// - W6 deconIpc（七通道载荷：create/start/pause/cancel/delete/get/list）+ materials:delete
//   级联四清（按 materialId 清本表族）。

// ── 拆解会话（closure_decon_job 表行）──

/**
 * 拆解档位（成本结构，parent design §5）。
 *
 * - `coarse` 粗拆：P1+P2+P3+书级结构读法（canon + 骨架）。
 * - `fine` 细拆：粗拆 + 手艺层选定维度子集（1-3 个）。
 * - `deep` 深度：全书全维度 + 名场面细批。
 */
export const DECON_TIERS = ['coarse', 'fine', 'deep'] as const;
export type DeconTier = (typeof DECON_TIERS)[number];
export const deconTierSchema = z.enum(DECON_TIERS);

/**
 * job 状态机（W2 deconJob 转移矩阵的枚举面）。
 *
 * - `pending`：P0 落库态（create 后、start 前）。
 * - `running`：在途（pass 相位见 closure_decon_pass_state）。
 * - `paused`：用户暂停（优雅中断——state 行保留，resume 续跑）。
 * - `done`：全部 pass 完成（done 后 start = 幂等 no-op，F-11）。
 * - `failed`：失败（error 列记因；start 可 retry）。
 * - `capped`：预算超限诚实挂起（llmCapped 家族纪律——不静默截断；调预算后续跑）。
 * - `stale`：双指纹失配（F-02——材料校对/重摄取后，用户确认重跑）。
 * - `cancelled`：用户取消（终态；重拆走新 job）。
 *
 * 在途守卫口径（F-11 同材料唯一在途 job）：pending/running/paused/capped 四态算在途。
 */
export const DECON_JOB_STATUSES = [
  'pending',
  'running',
  'paused',
  'done',
  'failed',
  'capped',
  'stale',
  'cancelled',
] as const;
export type DeconJobStatus = (typeof DECON_JOB_STATUSES)[number];
export const deconJobStatusSchema = z.enum(DECON_JOB_STATUSES);

/** 在途状态集（并发 create 守卫 + inflight 查询面——生产写点值域，勿按 schema DEFAULT 猜）。 */
export const DECON_JOB_INFLIGHT_STATUSES: readonly DeconJobStatus[] = [
  'pending',
  'running',
  'paused',
  'capped',
] as const;

/** sha256 指纹格式（与 10.2 台账双 hash 同形）。 */
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** 材料 id 格式（mat-<sha12>——materialSchema 单源同形，此处 regex 钉防漂移）。 */
const MATERIAL_ID_PATTERN = /^mat-[0-9a-f]{12}$/;

/**
 * material_ref = 「轨+id」（parent design §2.1）：
 * `global:mat-<sha12>`（全局车道）| `project:<registry 5 位 id>:mat-<sha12>`（项目车道）。
 * 同一材料的轨恒定（materialId = 路径身份），故 material_ref ↔ materialId 一一对应——
 * materials:delete 级联按 id 尾缀（恒 16 字符 `mat-<12hex>`）匹配本族全表。
 */
export const deconMaterialRefPattern = /^(global|project:[0-9]{5}):mat-[0-9a-f]{12}$/;
export const deconMaterialRefSchema = z.string().regex(deconMaterialRefPattern);

/** 材料行 → material_ref（轨+id 拼装单源）。 */
export function deconMaterialRef(material: {
  scope: 'project' | 'global';
  projectId: string | null;
  materialId: string;
}): string {
  return material.scope === 'global'
    ? `global:${material.materialId}`
    : `project:${material.projectId}:${material.materialId}`;
}

/** material_ref 解析（坏形 → null；级联清理/车道恢复用）。 */
export function parseDeconMaterialRef(
  ref: string,
): { scope: 'project' | 'global'; projectId: string | null; materialId: string } | null {
  const m = deconMaterialRefPattern.exec(ref);
  if (m === null) return null;
  return m[1] === 'global'
    ? { scope: 'global', projectId: null, materialId: ref.slice('global:'.length) }
    : {
        scope: 'project',
        projectId: m[1].slice('project:'.length),
        materialId: ref.slice(m[1].length + 1),
      };
}

/** pass 级 token 预算（budget_json 行结构）。null = 无上限跑完为止。 */
export const deconBudgetSchema = z.object({
  /** 总 token 上限（超限 → job=capped 诚实挂起）。 */
  totalTokens: z.number().int().positive().nullable(),
  /** per-pass 追加上限（键 = pass 茎，如 'p1b'——p4:<dim> 按 'p4' 茎统一约束）。 */
  perPass: z.record(z.string(), z.number().int().positive()).default({}),
});

export type DeconBudget = z.infer<typeof deconBudgetSchema>;

/** 单 pass 累计成本（cost_json.byPass 值结构）。 */
export const deconCostPassSchema = z.object({
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
});

export type DeconCostPass = z.infer<typeof deconCostPassSchema>;

/**
 * 实际累计成本（cost_json 行结构——预估对照面，parent design §5「实际 cost_json 对照」）。
 * `estimated: true` = **至少一笔按字符近似折算**（provider 未回报 usage——CR-13 诚实标注，
 * 预估对照时读侧按近似值理解）；全笔有 provider usage 真值时 false。旧行缺省 true（本族
 * 首版即近似记账）。sticky OR 语义：一笔近似即整表 true。
 */
export const deconCostSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  /** per-pass 累计（键 = pass 全值含后缀，如 'p1b' / 'p4:huoke'）。 */
  byPass: z.record(z.string(), deconCostPassSchema).default({}),
  estimated: z.boolean().default(true),
});

export type DeconCost = z.infer<typeof deconCostSchema>;

/**
 * P1 三 pass **各自**继承旗标（F-07 部分继承合法——CR-17：仅词典在时 p1b 不打折，
 * 预估按旗标逐 pass 折算非全有全无）。p1b 旗标 = 同指纹 facts 章
 * 齐全才算继承（部分章继承不折扣预估——保守）。
 */
export interface DeconP1Inheritance {
  p1a: boolean;
  p1b: boolean;
  p1c: boolean;
}

/**
 * 拆解会话行（closure_decon_job）。一材料 × 一档位 = 一 job；同材料在途 job 唯一（F-11）。
 * done 后 start = 幂等 no-op（返回既有结果不重跑）；双指纹失配 → stale。
 */
export const deconJobSchema = z.object({
  jobId: z.string().regex(/^decon-[0-9a-f]{12}$/),
  materialRef: deconMaterialRefSchema,
  tier: deconTierSchema,
  /** 维度子集（目的先行——12 维目录枚举权威在 parent design §6.0 矩阵，child B 落 UI；A 只存不判）。 */
  dimensions: z.array(z.string().min(1)),
  status: deconJobStatusSchema,
  budget: deconBudgetSchema,
  cost: deconCostSchema,
  /** 🔑 双指纹（F-02）：create 时快照——重入/读取时对 closure_material 现值 + 派生 .md 现值校验。 */
  materialContentHash: z.string().regex(HASH_PATTERN),
  derivedHash: z.string().regex(HASH_PATTERN),
  /** failed/capped 的诚实挂起 note（mirror closure_craft_distill.error；其余态 null）。 */
  error: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type DeconJob = z.infer<typeof deconJobSchema>;

// ── 断点状态行（closure_decon_pass_state）──

/**
 * pass 标识（parent design §2.1）：`p1a|p1b|p1c|p2|p3a|p3b|p4:<dim>|p5:<kind>|p6`。
 * child A 用 p1a/p1b/p1c/p2；p3a/p3b/p4:/p5:/p6 为 child B 预留（枚举一次定义，B 不改契约）。
 * 后缀字符集 `[a-z0-9_-]`（p5 kind 词形含下划线：book_reading/chapter_review/scene_annotation）。
 */
export const DECON_PASS_PATTERN =
  /^(p1a|p1b|p1c|p2|p3a|p3b|p6|p4:[a-z0-9_-]+|p5:[a-z0-9_-]+)$/;
export const deconPassSchema = z.string().regex(DECON_PASS_PATTERN);

/**
 * unit 约定（断点粒度 = pass × unit；E10.3b W1 契约对账钉死——p3b/p4/p5 实际形态与 child A
 * 初版注释的漂移在此修正）：
 * - p1a/p1c/p6：单行哨兵 `'all'`（全书一次）。
 * - p1b：章号十进制字符串（`'0'`、`'12'`…）。
 * - p2：canon 域名（world/rule/character/tone/timeline/relationship）。
 * - p3a：章号十进制字符串（逐章打标——同 p1b 形态）。
 * - p3b：`'arcs'` | `'stats'` **两行**（弧切分定稿 / 统计族——非单行哨兵）。
 * - p4:<dim>：`'ch:<N>'`（章级面）| `'arc:<N>'`（弧级面）；p4:style 单行哨兵 `'all'`（书级）。
 * - p5:<kind>：book_reading → `'all'`；chapter_review → `'ch:<N>'`；scene_annotation →
 *   `'scene:<N>'`；style_report → `'all'`（kind 词形见 DECON_REPORT_KINDS）。
 */
export const DECON_PASS_UNIT_ALL = 'all';

/**
 * unit='all' 为**非法形态**的 pass 清单（F16 化石判据单源——CR-6）：这些 pass 的合法 unit 是
 * 章号/域名/ch:/arc:/scene: 等**多 unit 形态**，`(pass,'all','failed')` 行是材料级前置失败
 * 留下的化石（写侧已改 transition-only 不再新产；R3 遗留 ('p1b','all','failed') 同族）——
 * UI 聚合不计分母/不触发红点，startDeconJob retry 时 DELETE 收口。
 *
 * `'p4:*'` = 前缀约定（全部 `p4:<手艺维>`——经 `DECON_LEGAL_ALL_UNIT_PASSES` 例外扣除
 * p4:style）。**⚠️ 新增逐 unit pass 须同步本清单**；反向亦然——p1a/p1c/p6/p4:style/
 * p5:book_reading 的 'all' 是唯一合法 unit（上方 unit 约定注释单源），绝不进本表。
 * 双端消费：shell `deleteDeconIllegalAllFailedPassStates`（DELETE）+ ui
 * `summarizeDeconPassStates`（聚合过滤）。
 */
export const DECON_ILLEGAL_ALL_UNIT_PASSES: readonly string[] = [
  'p1b',
  'p2',
  'p3a',
  'p3b',
  'p4:*',
  'p5:chapter_review',
  'p5:scene_annotation',
];

/** 前缀约定的合法例外（p4:style 唯一合法 unit = 'all'——'p4:*' 展开的扣除面）。 */
export const DECON_LEGAL_ALL_UNIT_PASSES: readonly string[] = ['p4:style'];

/** (pass,'all') 行是否非法形态（前缀展开 + 例外扣除——UI 聚合过滤共用单源谓词）。 */
export function isIllegalDeconAllUnitPass(pass: string): boolean {
  if (DECON_LEGAL_ALL_UNIT_PASSES.includes(pass)) return false;
  return DECON_ILLEGAL_ALL_UNIT_PASSES.some((entry) =>
    entry.endsWith('*') ? pass.startsWith(entry.slice(0, -1)) : entry === pass,
  );
}

/**
 * pass×unit 断点行。**断点续跑语义（W2 deconJob）**：重入时 done 且 output_hash 与产物
 * 现值一致 → 跳过（不重付 LLM）；capped → 保留挂起态等预算调整后续跑（不静默截断）。
 */
export const deconPassStateSchema = z.object({
  jobId: z.string().regex(/^decon-[0-9a-f]{12}$/),
  pass: deconPassSchema,
  unit: z.string().min(1),
  status: z.enum(['pending', 'running', 'done', 'failed', 'capped']),
  /** 产物行稳定引用（表+键，如 `facts:3` / `canon:world` / `dictionary:all`——W3+ 生产写点定义）。 */
  outputRef: z.string().nullable(),
  /** 产物内容 hash（重入校验防 stale 产物被静默沿用）。 */
  outputHash: z.string().regex(HASH_PATTERN).nullable(),
  updatedAt: z.string().min(1),
});

export type DeconPassState = z.infer<typeof deconPassStateSchema>;

// ── 事实层（材料级三表：facts / entity / dictionary——F-07 跨 job 复用键控）──

/**
 * 原文 span 锚（**与 10.2 craftTeachingAnchor 同基同形**：派生 .md 归一化文本，五元组，
 * 半开区间 UTF-16 code unit——直接复用单源 schema 防两处漂移）。per-chapter facts 内各项
 * span 的 chapterIndex 必须等于所在 facts 行章号（W4 校验层核验，非 schema 面）。
 */
export const deconSpanSchema = craftTeachingAnchorSchema;
export type DeconSpan = z.infer<typeof deconSpanSchema>;

/**
 * 实体五类（parent design §3：人物/地点/物品/组织/概念——P1a LLM 分类目标类目，
 * 候选行约束式缝只许在候选内选/标类，禁自创新名）。
 */
export const DECON_ENTITY_TYPES = ['person', 'place', 'item', 'organization', 'concept'] as const;
export type DeconEntityType = (typeof DECON_ENTITY_TYPES)[number];
export const deconEntityTypeSchema = z.enum(DECON_ENTITY_TYPES);

/**
 * 信息差 6 型（**正典枚举**——写作思维原理微观词汇，Epic 6 信息操控指令集的样本学习面；
 * P1b info_gap 打标轴。中文值即正典词形，避免翻译漂移；与 E6 InfoRelease mode 的对应：
 * 信息前置≈reveal_first / 悬疑未知≈sustain_unknown / 方法预期≈method_foreseen /
 * 主观误导≈subjective_mislead，爽感预期与全知巧合为拆书侧补充型）。
 */
export const DECON_INFO_GAP_TYPES = [
  '爽感预期', // 读者知·主角知·他人不知（戏剧反讽的爽感形态）
  '信息前置', // 读者知·主角不知
  '悬疑未知', // 读者不知·主角不知·他人知
  '方法预期', // 读者不知·主角知
  '全知巧合', // 叙述者全知视角下的巧合揭示
  '主观误导', // 不可靠叙述/主观视角误导
] as const;
export type DeconInfoGapType = (typeof DECON_INFO_GAP_TYPES)[number];
export const deconInfoGapTypeSchema = z.enum(DECON_INFO_GAP_TYPES);

/**
 * P1b 逐章 facts（child A design §P1b——LLM 输出契约 + facts_json 行结构）。
 * 提取目标 = **作者需要的素材**（伏笔埋点/信息差标注/事件分级），非读者事实（R2 §6.5a）。
 *
 * - `synopsis`：章一句话-三句话（粗拆「每章一句话」基底——两级摘要范式之章级输入）。
 * - `entities`：实体出现（name 须在词典内或本章新面——P1c 消歧前按名归组）。
 * - `events`：事件（`kernel` = 查特曼 kernels/satellites 判据「删掉故事断不断」——LLM 判，
 *   下游计量/名场面候选消费；缺省 false 非 unknown，不写暗示已判的标记）。
 * - `relationshipEdges`：关系边（from/to = 实体名，kind 自由短词——LLM 判语义）。
 * - `foreshadowPlanted`：伏笔埋点（**A 只产埋点**；回收验证归 B 的 P6 呼应证据机制）。
 * - `infoGap`：信息差标注（6 型正典枚举——**P3a 不重打**，纯代码消费本字段做统计，F-08）。
 *
 * 无锚即丢双保险（F-15）：本 schema span 必填 + W4 校验层做 span 文本在章内派生 .md 的
 * 存在性比对（镜像 10.2 双核验——paraRange 集外核验 + 引文子串匹配）。
 */
export const deconFactsSchema = z.object({
  synopsis: z.string().min(1),
  entities: z.array(
    z.object({
      name: z.string().min(1),
      type: deconEntityTypeSchema,
      span: deconSpanSchema,
    }),
  ),
  events: z.array(
    z.object({
      what: z.string().min(1),
      span: deconSpanSchema,
      kernel: z.boolean().optional(),
    }),
  ),
  relationshipEdges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: z.string().min(1),
      span: deconSpanSchema,
    }),
  ),
  foreshadowPlanted: z.array(
    z.object({
      hint: z.string().min(1),
      span: deconSpanSchema,
    }),
  ),
  infoGap: z.array(
    z.object({
      type: deconInfoGapTypeSchema,
      span: deconSpanSchema,
    }),
  ),
});

export type DeconFacts = z.infer<typeof deconFactsSchema>;

/** 逐章 facts 行（closure_decon_facts——材料级键控，UNIQUE(material_ref, derived_hash, chapter_index)）。 */
export const deconChapterFactsSchema = z.object({
  materialRef: deconMaterialRefSchema,
  derivedHash: z.string().regex(HASH_PATTERN),
  chapterIndex: z.number().int().nonnegative(),
  facts: deconFactsSchema,
});

export type DeconChapterFacts = z.infer<typeof deconChapterFactsSchema>;

/** P1c 实体审计（audit_json 行结构——观测面，passthrough 容管线加记不 churn 契约）。 */
export const deconEntityAuditSchema = z
  .object({
    /** 幻觉过滤剔除记录（本名与别名均不见于原文——AI-Reader-V2 issue #30 存在性检查模式）。 */
    hallucinationFiltered: z.boolean().optional(),
    /** 别名归并来源（本实体由哪些聚类成员合并——纯代码聚类 + 低置信对 LLM 裁决的留痕）。 */
    mergedFrom: z.array(z.string().min(1)).optional(),
    /** 类型投票明细（类型→出现章数——跨章多数票）。 */
    typeVotes: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .passthrough();

export type DeconEntityAudit = z.infer<typeof deconEntityAuditSchema>;

/** 实体章级出现（mentions_json 数组元素）。 */
export const deconEntityMentionSchema = z.object({
  chapterIndex: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

/** P1c 聚合实体行（closure_decon_entity——材料级键控，PK(material_ref, derived_hash, canonical_name)）。 */
export const deconEntitySchema = z.object({
  materialRef: deconMaterialRefSchema,
  derivedHash: z.string().regex(HASH_PATTERN),
  canonicalName: z.string().min(1),
  type: deconEntityTypeSchema,
  aliases: z.array(z.string().min(1)),
  mentions: z.array(deconEntityMentionSchema),
  audit: deconEntityAuditSchema,
});

export type DeconEntity = z.infer<typeof deconEntitySchema>;

/** P1a 词典条目（entries_json 数组元素——LLM 候选分类产物：五类 + 置信）。 */
export const deconDictionaryEntrySchema = z.object({
  name: z.string().min(1),
  type: deconEntityTypeSchema,
  /** 自报置信（E10.2b 拍板：排序信号非门禁——驱动人审队列排序，禁数字阈值自动批准）。 */
  confidence: z.number().min(0).max(1),
});

export type DeconDictionaryEntry = z.infer<typeof deconDictionaryEntrySchema>;

/** P1a 词典行（closure_decon_dictionary——材料级键控，PK(material_ref, derived_hash)；注入 P1b 压幻觉）。 */
export const deconDictionarySchema = z.object({
  materialRef: deconMaterialRefSchema,
  derivedHash: z.string().regex(HASH_PATTERN),
  entries: z.array(deconDictionaryEntrySchema),
});

export type DeconDictionary = z.infer<typeof deconDictionarySchema>;

// ── canon 六域（closure_canon_entry）──

/**
 * canon 域（2026-09-05 拍板定稿六域——世界/规则/角色/基调/时间线/关系；主题住书级读法、
 * 文风住风格卡〔4.7 落点〕，均不入 canon）。做薄纪律：canon 不复述情节，只存同人保真
 * 所需事实骨架；**不写自己项目的 asset_cards**（C5 边界——互补不重叠）。
 */
export const DECON_CANON_DOMAINS = [
  'world',
  'rule',
  'character',
  'tone',
  'timeline',
  'relationship',
] as const;
export type DeconCanonDomain = (typeof DECON_CANON_DOMAINS)[number];
export const deconCanonDomainSchema = z.enum(DECON_CANON_DOMAINS);

/**
 * 证据分级（F-13——sansheng evidence_level 三值裁两值）：`exact` 原文确认（直接引用条目）/
 * `inferred` 结构推断（归纳型条目——world/rule/tone 域归纳产物默认 inferred，同人消费侧可
 * 按档过滤）。**非 certainty**（知识出处轴，10.4 在线生态再议）。
 */
export const DECON_CANON_EVIDENCE = ['exact', 'inferred'] as const;
export type DeconCanonEvidence = (typeof DECON_CANON_EVIDENCE)[number];
export const deconCanonEvidenceSchema = z.enum(DECON_CANON_EVIDENCE);

/**
 * 时间线容错三档（R4 硬约束①——连载存在作者**有意错乱**，不把一切矛盾当失误上报）：
 * - `exact`：章序/标注一致。
 * - `intentional_loose`：有意不一致（倒叙/预叙/作者刻意——**需 LLM 复核标记**，P2 规则+复核两段）。
 * - `conflict`：真矛盾（不使 job failed——canon 层记录，读侧可见）。
 */
export const DECON_TIMELINE_CONSISTENCY = ['exact', 'intentional_loose', 'conflict'] as const;
export type DeconTimelineConsistency = (typeof DECON_TIMELINE_CONSISTENCY)[number];
export const deconTimelineConsistencySchema = z.enum(DECON_TIMELINE_CONSISTENCY);

/**
 * canon 条目 payload（域内自由形状 + 一个硬字段 `evidence`）。域内预期形状（**接口形状落
 * 注释不实施同人消费**，parent design §2.2——同人-1 epic 实施期回头定 schema）：
 *
 * | 域 | 预期 payload 字段（同人-1 消费预留） |
 * |---|---|
 * | `world` | `layers[]`（世界观分层）、`summary`——C5：canon-规则 audit 消费 |
 * | `rule` | `statement`（规则表述）、`scope`——C5 同上 |
 * | `character` | `traits: [{name, mutability: 'immutable'\|'evolvable', note?}]`（**C7 OOC tolerance_curve 基准**——immutable=0 随弧渐宽）、`identity`/`speechPattern`/`abilities`/`arc`/`coreTrauma`（**C3 per-character 画像**——落 asset_cards 形态的字段名对齐）、`pillars`/`voiceAnchors`/`antiVoice`/`neverDo`（**C6 FPS 原料**——FPS 生成归同2.3，canon 只供原料） |
 * | `tone` | `baseline`（基调描述）、`register`（语域三档——**C4** tone deviation respect 覆盖基准） |
 * | `timeline` | `consistency: 'exact'\|'intentional_loose'\|'conflict'`（**必填**——R4 容错三档）、`events?: [{chapterIndex, storyTimeLabel?}]`（**C1** CanonLocationRegistry/CanonTimelinePicker 选点原料）、`conflictNote?` |
 * | `relationship` | `pair: {from, to, kind, evidence}`（**必填**——**C2** per-pair 独立配档到「角色对」粒度） |
 */
export const deconCanonPayloadSchema = z.object({ evidence: deconCanonEvidenceSchema }).passthrough();

/**
 * canon 条目 provenance。`source='decon'`（**C8**——原作正文出处；社区/批评源由 10.4 在线
 * 生态补三级标注）。bookTitle = 材料显示名（登记行 name）。
 */
export const deconCanonProvenanceSchema = z
  .object({
    source: z.literal('decon'),
    materialId: z.string().regex(MATERIAL_ID_PATTERN),
    bookTitle: z.string().nullable(),
  })
  .passthrough();

export type DeconCanonProvenance = z.infer<typeof deconCanonProvenanceSchema>;

/**
 * canon 条目行（closure_canon_entry，PK(job_id, domain, name)）。
 * **无锚不立行**：anchors 至少 1 个 span（zod min(1) 强约束——world/rule/tone 走候选供给式
 * 归纳锚定，不裸读 synopsis〔F-04——synopsis 无锚，裸归纳要么空域要么假锚〕）。
 * **C9 多题材适配**：材料 medium/kind 差异下 canon 提取维度可降级（对齐 extractor-interface
 * 降级字段哲学）——本 schema 载荷无关载体，降级由管线按材料属性决定。
 */
export const deconCanonEntrySchema = z.object({
  jobId: z.string().regex(/^decon-[0-9a-f]{12}$/),
  domain: deconCanonDomainSchema,
  /** 条目名（域内唯一键：角色 canon 名/规则名/关系对名等）。 */
  name: z.string().min(1),
  payload: deconCanonPayloadSchema,
  anchors: z.array(deconSpanSchema).min(1),
  provenance: deconCanonProvenanceSchema,
});

export type DeconCanonEntry = z.infer<typeof deconCanonEntrySchema>;

// ── E10.3b（task 09-05）W1：child B 契约——维度目录 / P3 打标正典枚举 / P4 findings / 三表行 ──
//
// 消费关系：DECON_DIMENSIONS 是 P0 目的先行选择器的枚举权威（12 手艺维 + 风格维 style——
// 2026-09-05 拍板②）；打标枚举（钩子/转折/情绪拍/四相位）中文值即正典词形，词汇权威 =
// parent research/writing-principles-mirror.md（原文核对《写作思维原理》——正典单源，外部
// 参考冲突时以项目为准）；product/report/review 三表行 schema 是 shell repository 写侧
// zod 门（CR-4 Pattern）的单源。范式判据（parent design §9）：打标/问题单应答/读法生成
// 归 LLM；枚举封闭/成员校验/行形状归纯代码契约。

/**
 * 手艺层维度目录（13 项 = 12 手艺维 + 风格维 style，B design §3.1——parent §6.0 矩阵逐行
 * + 拍板②风格维）。id 稳定 slug（p4:<dim> 后缀字符集内）；label 中文呈现面；granularity
 * 是呈现/文档轴（unit 形态契约见上方 pass 注释——huoke/jiegou/renshe/shijieguan 的书级面
 * 住 P5 读法注入，**不建 unit='all' 的 pass 行**）。
 *
 * 档位 × 维度校验（成员级，逻辑在 shell deconBudget.validateDeconDimensions——消费本常量）：
 * coarse → dims ⊆ {style}（拍板②）；fine → 手艺维 1-3 + style 可选不计入；deep → 全 12
 * 手艺维必含 + style 可选。**维度目录（提问轴）与 13 大类（归类轴）正交**——craftHint.category
 * 由 LLM 在 CRAFT_CARD_CATEGORY_VALUES 受控内选（矩阵「落卡归类」列是语义提示非类目键），
 * 无维度→类目预映射。
 */
export interface DeconDimension {
  id: string;
  label: string;
  /** 粒度面（呈现/文档轴——unit 词形契约见 DECON_PASS_UNIT 注释）。 */
  granularity: string;
}

export const DECON_DIMENSIONS: ReadonlyArray<DeconDimension> = [
  { id: 'huoke', label: '获客漏斗', granularity: '开篇章级（前 min(12, 章数) 章，unit=ch:N）——书级面住 P5 读法注入' },
  { id: 'qidaigan', label: '期待感与铺垫', granularity: '章 + 弧' },
  { id: 'jiegou', label: '结构与多线', granularity: '弧——书级面住 P5 读法' },
  { id: 'renshe', label: '人设与成长', granularity: '弧（出场退场表 = 纯代码 facts 聚合预注）' },
  { id: 'shijieguan', label: '世界观容纳度', granularity: '弧——书级面住读法；层级-字数证据 = style_stats + 设定段预注' },
  { id: 'qingxu', label: '情绪与爽点', granularity: '章 + 弧' },
  { id: 'wenbi', label: '文笔与画面感', granularity: '章级抽查（深度档主战场 = 名场面细批，P5）' },
  { id: 'zaogeng', label: '造梗与互动', granularity: '章 + 弧' },
  { id: 'xinxicha', label: '信息控制', granularity: '章级（消费 P1b 标注 + P3b 统计预注，不重打）+ 弧级读者知识曲线' },
  { id: 'shijian', label: '时间三轴', granularity: '章 + 弧（频率面）' },
  { id: 'fubi', label: '伏笔形态学', granularity: '弧（埋-收配对 LLM 判，回收点锚点必带——P6 纯代码终验）' },
  { id: 'duizhao', label: '对照与变奏', granularity: '弧（同类场景聚类纯代码预注 + LLM 析变奏）' },
  { id: 'style', label: '风格维（风格卡通道）', granularity: '书级抽样（14 节 payload + style_report）' },
];

/** 维度 id 全集（成员校验面）。 */
export const DECON_DIMENSION_IDS = [
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
  'style',
] as const;
export type DeconDimensionId = (typeof DECON_DIMENSION_IDS)[number];
export const deconDimensionIdSchema = z.enum(DECON_DIMENSION_IDS);

/** 12 手艺维 id（style 之外——deep 必含集 / p6 落卡候选计数排除面）。 */
export type DeconCraftDimensionId = Exclude<DeconDimensionId, 'style'>;
export const DECON_CRAFT_DIMENSION_IDS: readonly DeconCraftDimensionId[] = DECON_DIMENSION_IDS.filter(
  (id): id is DeconCraftDimensionId => id !== 'style',
);

// ── P3a 打标正典枚举（span 级轻枚举；归因型深判归 P4 问题单）──

/**
 * 期待感钩子 11 型（**正典枚举**——写作思维原理「期待感十一钩」，中文值即正典词形；原文
 * 核对原理 txt:535-559/1051）。打标 schema 另含 `'other'` 兜底（集外命中可观测计数，
 * 不静默编造型号）。
 */
export const DECON_HOOK_TYPES = [
  '被迫压力钩',
  '排行贪欲钩',
  '人物情感钩',
  '人前显圣钩',
  '全村希望钩',
  '解决能力钩',
  '外挂神器钩',
  '未知悬疑钩',
  '方法掌控钩',
  '信息前置钩',
  '信息预期钩',
] as const;
export type DeconHookType = (typeof DECON_HOOK_TYPES)[number];
export const deconHookTypeSchema = z.enum(DECON_HOOK_TYPES);

/**
 * 转折 9 型（**正典枚举，全名词形**——原文核对原理 txt:483-521/866-868：阻碍递进类〔①阻碍
 * ②方法③误导〕+ 目标颠覆类〔④偏差⑤反差⑥规则〕+ 人物反差类〔⑦目的⑧人物⑨动态〕，全名 =
 * 短名+转折。mirror digest 只记类名+短名，本常量按原文补全全名不臆造）。三类分组供 P3b
 * 统计聚合面，schema 只钉 9 型词形。`'other'` 兜底同钩子（识别为转折但类型存疑——深归因
 * 留 P4）。
 */
export const DECON_TRANSITION_TYPES = [
  '阻碍转折', // 阻碍递进类
  '方法转折', // 阻碍递进类
  '误导转折', // 阻碍递进类
  '偏差转折', // 目标颠覆类
  '反差转折', // 目标颠覆类
  '规则转折', // 目标颠覆类
  '目的转折', // 人物反差类
  '人物转折', // 人物反差类
  '动态转折', // 人物反差类
] as const;
export type DeconTransitionType = (typeof DECON_TRANSITION_TYPES)[number];
export const deconTransitionTypeSchema = z.enum(DECON_TRANSITION_TYPES);

/**
 * 情绪动态 7 拍（**正典枚举**——写作思维原理【情绪动态】七拍：拉扯/推动/上行/下行/起伏/
 * 持续动态〔倒计时·数量·距离〕/层层递进；原文核对原理 txt:829-886）。
 */
export const DECON_EMOTIONAL_BEATS = [
  '拉扯',
  '推动',
  '上行',
  '下行',
  '起伏',
  '持续动态',
  '层层递进',
] as const;
export type DeconEmotionalBeat = (typeof DECON_EMOTIONAL_BEATS)[number];
export const deconEmotionalBeatSchema = z.enum(DECON_EMOTIONAL_BEATS);

/**
 * 剧情段四相位（章主导相位——单元四步法的情绪相位全词形：起=拉仇恨/承=积蓄〔试探压抑〕/
 * 转=释放〔爆发反转〕/合=落袋为安〔收获余波〕。digest 原形；与情绪 7 拍并列的两级词汇——
 * 四相位是剧情段级、7 拍是章内 span 级）。
 */
export const DECON_PLOT_PHASES = ['拉仇恨', '积蓄', '释放', '落袋为安'] as const;
export type DeconPlotPhase = (typeof DECON_PLOT_PHASES)[number];
export const deconPlotPhaseSchema = z.enum(DECON_PLOT_PHASES);

/** 打标枚举 + `'other'` 兜底（labels schema 用——与封闭枚举常量分开定义防词形重复）。 */
const DECON_HOOK_LABEL_TYPES = [...DECON_HOOK_TYPES, 'other'] as const;
export const deconHookLabelTypeSchema = z.enum(DECON_HOOK_LABEL_TYPES);
const DECON_TRANSITION_LABEL_TYPES = [...DECON_TRANSITION_TYPES, 'other'] as const;
export const deconTransitionLabelTypeSchema = z.enum(DECON_TRANSITION_LABEL_TYPES);

/**
 * P3a 逐章打标（B design §2——product 表 p3a payload 形状）。span 级轻枚举事实标记：
 * 归因型判断（转折深归类/埋-收配对/变奏对）归 P4；**信息差不重打**（F-08——P3b 统计直接
 * 消费 P1b infoGap）。落库前经锚定双核验（buildDeconAnchor + isQuoteInSpan——集外/引文
 * 不匹配丢条+计数），存的是已核验 span 形态（非 LLM 原始 paraRange）。
 */
export const deconChapterLabelsSchema = z.object({
  hooks: z.array(z.object({ type: deconHookLabelTypeSchema, span: deconSpanSchema })),
  transitions: z.array(z.object({ type: deconTransitionLabelTypeSchema, span: deconSpanSchema })),
  emotionalBeats: z.array(z.object({ beat: deconEmotionalBeatSchema, span: deconSpanSchema })),
  /** 章主导相位（null = 无明确主导/非剧情段章）。 */
  plotPhase: deconPlotPhaseSchema.nullable(),
  /** 爽点段落。 */
  highlightSpans: z.array(deconSpanSchema),
  /** 设定说明段（维 5 层级-字数证据 F-09）。 */
  expositionSpans: z.array(deconSpanSchema),
  /** 弧界候选（P3b 候选聚合输入——confidence 0-1；null = 本章无候选）。 */
  arcBoundary: z
    .object({
      isCandidate: z.boolean(),
      confidence: z.number().min(0).max(1),
      signal: z.string().min(1).optional(),
    })
    .nullable(),
});

export type DeconChapterLabels = z.infer<typeof deconChapterLabelsSchema>;

// ── P3b 弧切分 + 统计族（B design §2——product 表 p3b payload；纯代码算数零 LLM）──

/**
 * 数值分布摘要（min/avg/max/σ——总体标准差）。**全部可纯代码复算**（AC2——同输入两跑同
 * 输出）；`count=0` 时四值全 0（空集约定——调用方免 null 分支）。
 */
export const deconDistributionSchema = z.object({
  count: z.number().int().nonnegative(),
  min: z.number().nonnegative(),
  avg: z.number().nonnegative(),
  max: z.number().nonnegative(),
  sigma: z.number().nonnegative(),
});
export type DeconDistribution = z.infer<typeof deconDistributionSchema>;

/**
 * 弧（P4/P5 的通读单元——P3b 切分定稿产物，B design §2「弧切分定稿」）。切分序：卷界
 * title 探测（章题「卷/篇/部」分界词）优先 → 无卷界时 P3a arcBoundary 候选聚合（置信阈值
 * + 相邻合并）→ 守卫（弧字数目标带 30K-100K——过小并弧/过大在候选点拆弧；参数为推测值，
 * dogfood 首本标定回调）。
 */
export const deconArcSchema = z.object({
  index: z.number().int().nonnegative(),
  /** 卷名（卷界 title 探测命中的章题；候选聚合切分 / 非卷界起点 → null）。 */
  title: z.string().min(1).nullable(),
  /** 起章 index（含）。 */
  fromChapter: z.number().int().nonnegative(),
  /** 止章 index（含）。 */
  toChapter: z.number().int().nonnegative(),
  chapterCount: z.number().int().positive(),
  /** 弧字数（章内干净文本合计——守卫面目标带输入）。 */
  charCount: z.number().int().nonnegative(),
  /** 切分来源：`volume` 卷界 / `boundary` 候选聚合 / `single` 单弧兜底（全书无切点）。 */
  origin: z.enum(['volume', 'boundary', 'single']),
});
export type DeconArc = z.infer<typeof deconArcSchema>;

/** p3b unit='arcs' 行 payload（弧切分定稿 + 守卫审计留痕——参数标定面）。 */
export const deconArcsPayloadSchema = z.object({
  arcs: z.array(deconArcSchema),
  audit: z.object({
    /** 切分来源面（arcs[].origin 的路径级汇总）。 */
    source: z.enum(['volume', 'boundary', 'single']),
    /** 卷界命中章（title 探测切点——守卫并弧后可能不在最终弧界上，审计留痕）。 */
    volumeBoundaries: z.array(
      z.object({ chapterIndex: z.number().int().nonnegative(), title: z.string().min(1) }),
    ),
    /** arcBoundary 候选总数（置信阈值前）。 */
    candidatesTotal: z.number().int().nonnegative(),
    /** 阈值+相邻合并后实际成为切点的候选数。 */
    candidatesUsed: z.number().int().nonnegative(),
    /** 守卫并弧次数（过小弧并邻——并前优先，弧 0 并后）。 */
    arcsMerged: z.number().int().nonnegative(),
    /** 守卫拆弧次数（过大弧在候选点/半量章拆）。 */
    arcsSplit: z.number().int().nonnegative(),
  }),
});
export type DeconArcsPayload = z.infer<typeof deconArcsPayloadSchema>;

/**
 * p3b unit='stats' 行 payload——统计族 + style_stats（B design §2 统计族全项，纯代码可复算
 * AC2）。**by 型明细住书级**（记录全键列齐零计型——P4/P5 注入面免补键判断）；**弧级 = 聚合
 * 计数面** + 章字数分布（弧注入用聚合足够，明细查询走书级）。infoGap 计数**消费 P1b**
 * `infoGap` 字段（F-08 不重打）；铺垫-高潮跨度消费 P3a hooks + P1b events kernel。
 */
export const deconStatsPayloadSchema = z.object({
  book: z.object({
    chapterCount: z.number().int().nonnegative(),
    charCount: z.number().int().nonnegative(),
    /** 章字数分布。 */
    chapterChars: deconDistributionSchema,
    /** 爽点段计数。 */
    highlightCount: z.number().int().nonnegative(),
    /** 爽点段字数分布。 */
    highlightChars: deconDistributionSchema,
    /** 相邻爽点段间隔（章距——同章相邻 = 0）分布。 */
    highlightIntervalChapters: deconDistributionSchema,
    /** 钩子计数 by 型（11 型全集 + 'other'——零计型列齐）。 */
    hooksByType: z.record(z.string(), z.number().int().nonnegative()),
    /** 转折计数 by 型（9 型全集 + 'other'）。 */
    transitionsByType: z.record(z.string(), z.number().int().nonnegative()),
    /** 情绪拍分布（7 拍全集——封闭枚举无 other）。 */
    emotionalBeatsByType: z.record(z.string(), z.number().int().nonnegative()),
    /** 信息差计数 by 6 型（消费 P1b infoGap——F-08）。 */
    infoGapByType: z.record(z.string(), z.number().int().nonnegative()),
    /** 伏笔埋点数（P1b foreshadowPlanted 合计）。 */
    foreshadowPlantedCount: z.number().int().nonnegative(),
    /** 伏笔埋点密度（埋点/万字——R2 计量化轴）。 */
    foreshadowDensityPer10k: z.number().nonnegative(),
    /** 设定说明段字数分布（维 5 层级-字数证据 F-09）。 */
    expositionChars: deconDistributionSchema,
    /** 铺垫-高潮跨度（章距）分布：各钩子章 → 其后首个 kernel 事件章（同章兑现 = 0）。 */
    hookToKernelChapterSpan: deconDistributionSchema,
  }),
  /** 弧级统计（与 p3b arcs 切分同序——聚合面）。 */
  arcs: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      fromChapter: z.number().int().nonnegative(),
      toChapter: z.number().int().nonnegative(),
      chapterCount: z.number().int().positive(),
      charCount: z.number().int().nonnegative(),
      chapterChars: deconDistributionSchema,
      hookCount: z.number().int().nonnegative(),
      transitionCount: z.number().int().nonnegative(),
      highlightCount: z.number().int().nonnegative(),
      emotionalBeatCount: z.number().int().nonnegative(),
      infoGapCount: z.number().int().nonnegative(),
      foreshadowPlantedCount: z.number().int().nonnegative(),
      /** 章主导相位分布（四相位全集——零计相位列齐）。 */
      plotPhaseCounts: z.record(z.string(), z.number().int().nonnegative()),
    }),
  ),
  /** style_stats——纯代码 stylometry（风格维原料，ADR-3 四块之一最小落地；LLM 不编数字）。 */
  styleStats: z.object({
    /** 句长分布（字符——句末标点切分；基面 = 剥章标记行的派生 .md）。 */
    sentenceChars: deconDistributionSchema,
    /** 段落长度分布（字符——空行切块）。 */
    paragraphChars: deconDistributionSchema,
    /** 对话行占比（0-1——含中文引号「『“ 的行 / 非空行；启发式，dogfood 标定）。 */
    dialogueLineRatio: z.number().min(0).max(1),
  }),
});
export type DeconStatsPayload = z.infer<typeof deconStatsPayloadSchema>;

// ── P4 findings（问题单应答产物）──

/**
 * P4 手艺层 findings（B design §3.2——LLM 输出契约 + product 表 p4:<dim> payload 形状）。
 * evidence ≥1 是**无锚即丢红线**（R7/R8——纯代码核验 paraRange 集内 + 引文匹配后才落库，
 * 空证据 findings 在写侧被丢）；craftHint 是 P6 落卡路由提示（category 在 13 大类受控内选
 * ——语义提示非类目键）；synthesis 章级可空串（维度小结归弧/书级聚合面——schema 不做假信心门）。
 */
export const deconFindingsSchema = z.object({
  findings: z.array(
    z.object({
      /** 结论一句话（正典词汇表述）。 */
      insight: z.string().min(1),
      /** 展开 2-4 句。 */
      elaboration: z.string().min(1),
      /** 呼应证据（回收点/对照物/重复调度的 paraRange+quote——paraRange 为全局段号，F-16 同 10.2 坐标）。 */
      evidence: z
        .array(
          z.object({
            paraRange: z.object({
              start: z.number().int().nonnegative(),
              end: z.number().int().nonnegative(),
            }),
            quote: z.string().min(1),
          }),
        )
        .min(1),
      /** 落卡路由提示（null = 该发现不落 craft 卡）。 */
      craftHint: z
        .object({
          category: craftCardCategorySchema.optional(),
          termHint: z.string().min(1).optional(),
          tags: z.array(z.string().min(1)).optional(),
        })
        .nullable(),
    }),
  ),
  synthesis: z.string(),
});

export type DeconFindings = z.infer<typeof deconFindingsSchema>;

// ── P4 风格维 14 节 payload（B design §3.3——4.7 完整风格学习落点）──

/**
 * 风格卡 14 节语义键（**值对齐 agent 包 `StyleSectionKey`**——`apps/desktop/agent/src/tool/style-card.ts`
 * 的 ①-⑭ 语义键；agent 侧是模块私有常量不可跨包导入，此处按值钉死，两处漂移由
 * agent/src/index.ts 导出面测试对拍防）。词形：voice 声音画像 / stats 机械统计 / syntax 句法
 * 与文字节奏 / narrative 叙事节奏 / dialogue 对话 / description 描写的取舍 / imagery 意象与
 * 比喻思维 / emotion 情绪手法 / info 信息处理 / character 人物呈现法 / expectation 期待管理 /
 * prohibitions 禁则 / excerpt 节选（few-shot）/ appendix 原文附录。
 */
export const DECON_STYLE_SECTION_KEYS = [
  'voice',
  'stats',
  'syntax',
  'narrative',
  'dialogue',
  'description',
  'imagery',
  'emotion',
  'info',
  'character',
  'expectation',
  'prohibitions',
  'excerpt',
  'appendix',
] as const;
export type DeconStyleSectionKey = (typeof DECON_STYLE_SECTION_KEYS)[number];
export const deconStyleSectionKeySchema = z.enum(DECON_STYLE_SECTION_KEYS);

/**
 * LLM 产的 11 节（语义分析节）。**stats / excerpt / appendix 三节纯代码产**（② 机械统计
 * =style_stats 渲染直落——LLM 不编数字；⑬ 节选=纯代码选 800-2000 字原文 fenced；⑭ 附录=
 * 材料来源注记非全文复制——版权姿势），不进 LLM 输出契约。
 */
export const DECON_STYLE_LLM_SECTION_KEYS: readonly DeconStyleSectionKey[] = DECON_STYLE_SECTION_KEYS.filter(
  (k) => k !== 'stats' && k !== 'excerpt' && k !== 'appendix',
);

/**
 * p4:style 结构化 payload（product 表 pass='p4:style'、unit='all'——B design §3.3）。节内容
 * 为 markdown 文本（各节「模仿指令」面）；`sections` 只含产出的节（分析者哲学：证据不足的节
 * 整节省略——宁缺毋滥，无假信心门），但纯代码三节（stats/excerpt/appendix）由 `.refine` 钉为
 * 必出（确定性产物不缺省）。md 渲染落 report 表 kind='style_report'。
 */
export const deconStylePayloadSchema = z
  .object({
    /** 14 节按语义键（存在的节——LLM 11 节 + 纯代码 3 节合并面）。 */
    sections: z.record(deconStyleSectionKeySchema, z.string().min(1)),
    /** ⑬ 节选的原文锚（导出定位/阅读面跳原文——至少一段）。 */
    excerptAnchors: z.array(deconSpanSchema).min(1),
    /** ⑭ 附录来源注记数据面（书名 = 材料登记行 name；本地私用节选级引用）。 */
    bookTitle: z.string().min(1).nullable(),
    materialId: z.string().regex(MATERIAL_ID_PATTERN),
  })
  .refine(
    (p) => p.sections.stats !== undefined && p.sections.excerpt !== undefined && p.sections.appendix !== undefined,
    { message: '纯代码三节（stats/excerpt/appendix）必出——确定性产物不缺省' },
  );

export type DeconStylePayload = z.infer<typeof deconStylePayloadSchema>;

// ── child B 三表行（closure_decon_product / closure_decon_report / closure_decon_review）──

/**
 * product 行 unit 词形（与 DECON_PASS_UNIT 注释同源钉死）：p3a=章号 / p3b='arcs'|'stats' /
 * p4=ch:N|arc:N|all（style）/ p6 不落 product 行。
 */
export const DECON_PRODUCT_UNIT_PATTERN = /^(all|arcs|stats|[0-9]+|ch:[0-9]+|arc:[0-9]+)$/;

/**
 * product 行（closure_decon_product——通用 pass 产物：P3a 标签 / P3b 弧+统计 / P4 findings）。
 * payload 形状按 pass×unit 分派（分派单源在 shell db/closure-decon.ts 写侧 zod 门）：p3a →
 * DeconChapterLabels；p3b:'arcs' → DeconArcsPayload / 'stats' → DeconStatsPayload（E10.3b W2
 * 已登记）；p4:<dim>（非 style）→ DeconFindings；p4:style → deconStylePayloadSchema（14 节
 * 风格 payload——E10.3b W3b 登记，语义键对齐 agent style-card.ts 的 StyleSectionKey）。outputRef 命名 = `product:<pass>:<unit>`（对齐 A 的
 * `facts:3`/`canon:world` 表:键式）。
 */
export const deconProductRowSchema = z.object({
  jobId: z.string().regex(/^decon-[0-9a-f]{12}$/),
  pass: deconPassSchema,
  unit: z.string().regex(DECON_PRODUCT_UNIT_PATTERN),
  payload: z.unknown(),
  updatedAt: z.string().min(1),
});

export type DeconProductRow = z.infer<typeof deconProductRowSchema>;

/** P5 三层输出 + 风格报告的 kind（p5:<kind> pass 词形同源——style_report 为风格维伴生报告）。 */
export const DECON_REPORT_KINDS = ['book_reading', 'chapter_review', 'scene_annotation', 'style_report'] as const;
export type DeconReportKind = (typeof DECON_REPORT_KINDS)[number];
export const deconReportKindSchema = z.enum(DECON_REPORT_KINDS);

/** report 行 unit 词形（book_reading/style_report='all' / chapter_review='ch:N' / scene_annotation='scene:N'）。 */
export const DECON_REPORT_UNIT_PATTERN = /^(all|ch:[0-9]+|scene:[0-9]+)$/;

/**
 * report 行（closure_decon_report——P5 三层输出 + 风格报告，叙事性 markdown 不进 craft KB）。
 * anchors 允许空数组：报告级锚点是补充面（章评/细批的锚定纪律在证据条目级——findings
 * evidence / scene 候选 span；schema 不做假信心门）。dimension 关联维度（style_report →
 * 'style'；book_reading/chapter_review/scene_annotation 可 null）。outputRef 命名 =
 * `report:<kind>:<unit>`。
 */
export const deconReportRowSchema = z.object({
  jobId: z.string().regex(/^decon-[0-9a-f]{12}$/),
  kind: deconReportKindSchema,
  unit: z.string().regex(DECON_REPORT_UNIT_PATTERN),
  contentMd: z.string().min(1),
  anchors: z.array(deconSpanSchema),
  dimension: z.string().min(1).nullable(),
  updatedAt: z.string().min(1),
});

export type DeconReportRow = z.infer<typeof deconReportRowSchema>;

/** report 行 meta 投影（列表只回 meta——大书章评数百行不整面灌 renderer，内容经单取）。 */
export interface DeconReportMeta {
  kind: DeconReportKind;
  unit: string;
  dimension: string | null;
  updatedAt: string;
}

/**
 * 人审闸门 checkpoint（拍板①——默认开、可关；三个，插在管线相位边界）：`dictionary`（P1c
 * 后——词典/实体确认）/ `canon`（P2 后——六域抽查）/ `craft`（P4 全部完成后——各维 findings
 * 按维分组展示、一次确认；**前置 = 手艺维非空且 P4 有 findings**——coarse / coarse+style
 * 零 findings 不空停）。
 */
export const DECON_REVIEW_CHECKPOINTS = ['dictionary', 'canon', 'craft'] as const;
export type DeconReviewCheckpoint = (typeof DECON_REVIEW_CHECKPOINTS)[number];
export const deconReviewCheckpointSchema = z.enum(DECON_REVIEW_CHECKPOINTS);

/**
 * 闸门行状态：`pending` 等待人工确认（编排层到点 → job 翻 paused + 进度事件注「待人工确认」）
 * → `approved` 确认即续跑（approve-review → start，台账 skip 已 done pass 零重付）；`off` =
 * create 时用户关闭闸门（配置即行——job 表零改 A）。stale 确认重跑时 approved 行复位 pending
 * （新指纹产物应再过闸——首本标定语义）；off 是用户常设配置不翻（已关的闸门不因重跑复活）。
 */
export const DECON_REVIEW_STATUSES = ['pending', 'approved', 'off'] as const;
export type DeconReviewStatus = (typeof DECON_REVIEW_STATUSES)[number];
export const deconReviewStatusSchema = z.enum(DECON_REVIEW_STATUSES);

/** 闸门行（closure_decon_review——create 时初始化三行 pending）。 */
export const deconReviewRowSchema = z.object({
  jobId: z.string().regex(/^decon-[0-9a-f]{12}$/),
  checkpoint: deconReviewCheckpointSchema,
  status: deconReviewStatusSchema,
  note: z.string().nullable(),
  updatedAt: z.string().min(1),
});

export type DeconReviewRow = z.infer<typeof deconReviewRowSchema>;
