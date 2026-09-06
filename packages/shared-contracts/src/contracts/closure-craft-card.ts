import { z } from 'zod';

// ── E10.2b（task 09-05）：条目级手艺卡域 schema（卡 / 讲法 / 词目 / 受控大类词表，
//    design §1.1-1.2）──
//
// 「手艺卡」= 经验文档蒸馏管线的条目级产物（区别于 2.1 doc 级 craft KB 文档——两者
// 分层并存不合并不迁移）。一条可复用写作手艺 = 一个完整主张（主张 + 操作要点 + 适用
// 场景 + 反例，R3 切条判据），经 LLM 保义浓缩成 Agent 可消费形态（核心哲学：保留原文
// 精神与总体经验的前提下浓缩改造，不损失原本含义——非原文摘抄堆砌），带引文锚点 +
// 多来源讲法（Wikidata statement 形态）+ 人审状态机。
//
// 范式判据分工（ADR-3 / creative-vs-mechanical spec）：
// - 归 LLM：切条（完整主张判定）/ 词表归类（受控词表内选）/ 冲突判定（语义相反）。
// - 归纯代码：锚定核验（para→char + 引文子串匹配，无锚即丢）/ 相似度算数 / 状态机
//   转换 / 台账记账。本文件是纯 zod 契约层（零 fs/db）。
//
// 红线注记：
// - **大类受控（与 craft_type 刻意相反）**：craft_type（craft-type-vocab.ts 8 类）是
//   doc 级 open string 先验非门禁；手艺卡大类是**封闭 13 类**——R2 红线「禁 LLM 自由
//   生成类目」。schema 层 zod 单源校验（F-20：DDL 不进 CHECK，未来加大类免表重建迁移，
//   只改本常量）；词表外命中走 pending 词目提案（term 级可增长，大类级永不自由增长）。
// - **禁数字阈值自动批准**（R3 红线）：confidence 只作队列排序（低置信排前省力），
//   全量人过——高置信也进（排后面），不自动 verify。
// - **冲突禁纯代码词面判**（L1 假信心门同源）：dispute 恒 LLM 判语义相反 + 人审确认。
// - **出处与裁决正交**（R4）：讲法 author 只标注「谁说的」，权威来源 ≠ 正确，裁决权
//   在用户（rank 三档）。
// - **tags 与受控词表正交**（R10）：category/term 是分类轴（禁自由），tags 是自由
//   facet（鼓励自由——蒸馏 LLM 自由打 + 人审可改；红线只约束类目不约束标签）。
//
// expected_downstream_consumers:
// - Story 9.7 methodology skill / brief-compiler 注入缝（epics 规划链 10.2→9.7→2.1；
//   词目 + tags 字段即注入过滤键——write-chapter 链工具收窄 by-design，注入缝 defer 9.7）。
// - Story 9.4 multi-review「套路陈旧」维（multi-review-agent.yaml:208 自注 defer「需查
//   playbook 精确判」——卡 + tags + 大类的语义查询面届时即齐）。
// - llmlint 反 slop 未来入口（9.4 立起后自然汇合）。
// - W2 卡/词目 repository（closure_craft_card / closure_craft_term 表行往返——
//   claim_json / teachings_json 列 JSON 序列化，行映射归 repository）。
// - E10.3b 拆书管线 P6（decon/p6Craft.ts 写入路径——appendCraftTeaching / insertCraftCard
//   挂 originKind='decon_instance' 讲法；additive 三字段 absent = 旧行语义，teachings_json
//   JSON 列零 ALTER）。

// ── 受控大类词表（13 类，封闭——design §1.2「大类种子」）──
//
// value = 拼音/ASCII slug（稳定可过滤，mirror craft_type 惯例）；gloss = 中文注解。
// 来源 = epics.md:881 Epic 10 词表首落地：原五类 + 新六类 + 人设（承接散并指派）+ 素材。
// **题材中性红线**：男频打法只作词目先验不硬编码进大类（epics.md:881）。
// 对齐注记：epics 散并「节奏调剂子型→期待感节奏」的「期待感节奏」= 大类「期待感管理」
// （Epic 5 喘息维细化同域），写死等价。「人设」承接 epics.md:881 散并指派（人物对照组
// →人设、角色声纹→人设〔兼服务同人 OOC〕，D7 角色设计消费位）；与 doc 级 craft_type
// 'character' 语义同域不同 slug（分层并存，互不迁移）。

export const CRAFT_CARD_CATEGORY_VALUES = [
  'qingxu',
  'xinxicha',
  'fubi',
  'qiaoduan',
  'jiegou',
  'huoke',
  'qidaigan',
  'jiegoudafa',
  'zaogeng',
  'shijieguan',
  'manzu',
  'renshe',
  'sucai',
] as const;

export type CraftCardCategory = (typeof CRAFT_CARD_CATEGORY_VALUES)[number];

/**
 * 受控大类词表（封闭 13 类——craftCardCategorySchema zod 单源校验；DDL 不进
 * CHECK，F-20）。与 CRAFT_TYPE_VOCAB（8 类 open 先验）刻意相反：条目级分类禁
 * 自由生成（R2 红线），词表外主张走 pending 词目提案。
 */
export const CRAFT_CARD_CATEGORIES: ReadonlyArray<{ value: CraftCardCategory; gloss: string }> = [
  { value: 'qingxu', gloss: '情绪手法：情绪点设计/情绪动态/情绪回报模式（先抑后扬等）' },
  { value: 'xinxicha', gloss: '信息差：信息释放时序与读者-角色认知落差操控' },
  { value: 'fubi', gloss: '伏笔：伏笔埋设/回收与长期承诺管理' },
  {
    value: 'qiaoduan',
    gloss: '桥段：可复用情节单元（与 doc 级 craft_type qiaoduan 同语义不同粒度）',
  },
  { value: 'jiegou', gloss: '结构：叙事结构/多线组织/章节结构' },
  { value: 'huoke', gloss: '获客漏斗：书名/简介/开篇的读者获取打法' },
  {
    value: 'qidaigan',
    gloss: '期待感管理：期待建立/维持/兑现与节奏调剂（epics「期待感节奏」= 本类，写死等价）',
  },
  { value: 'jiegoudafa', gloss: '结构打法：同类场景变奏/固定调度模式等可复用调度打法' },
  { value: 'zaogeng', gloss: '造梗与社区互动：梗的制造与读者社区互动打法' },
  { value: 'shijieguan', gloss: '世界观容纳度：世界观可扩展性/容纳新设定元素的打法' },
  { value: 'manzu', gloss: '满足感分层：即时/累积/终极三层满足感机制' },
  {
    value: 'renshe',
    gloss:
      '人设：人物对照组/角色声纹等人物设计手法（承接 epics 散并指派；与 doc 级 craft_type character 同域不同 slug）',
  },
  { value: 'sucai', gloss: '素材：描写词汇/题材素材等原料性条目' },
];

export const craftCardCategorySchema = z.enum(CRAFT_CARD_CATEGORY_VALUES);

/**
 * 把手艺卡大类词表格式化成 prompt 注入文本（纯函数，mirror craft-type-vocab
 * .formatCraftTypeVocab——但语义相反：**受控**词表，LLM 只能在 13 类内选择）。
 * 归类缝（W3.2）prompt 注入 + 未来 UI 补全消费。确定性字符串格式化，零 LLM。
 */
export function formatCraftCardCategories(): string {
  const entries = CRAFT_CARD_CATEGORIES.map((e) => `${e.value}：${e.gloss}`).join('\n');
  return [
    '【手艺卡大类词表（受控——只能在此 13 类内选择，禁自造类目；词表外主张走词目提案）】',
    entries,
  ].join('\n');
}

// ── 讲法（Wikidata statement 形态——design §1.1）──

/**
 * 讲法 rank 三档（mirror Wikidata preferred/normal/deprecated；出处与裁决正交——
 * 权威来源 ≠ 正确，裁决权在用户，R4）。
 *
 * - `approved` 认可：**人审显式动作**（用户试过有效）——注入时最高优先（有 approved
 *   只注 approved，全 normal 并排双方）。
 * - `normal` 正常：默认档——**AI 蒸馏产讲法恒 normal 起板**（开放题 #11；使用信号
 *   回流升 approved defer）。
 * - `rejected` 不认可：**保留不删**注明理由（note）——注入时不注（mirror Wikidata
 *   deprecated）。
 */
export const CRAFT_TEACHING_RANKS = ['approved', 'normal', 'rejected'] as const;
export type CraftTeachingRank = (typeof CRAFT_TEACHING_RANKS)[number];
export const craftTeachingRankSchema = z.enum(CRAFT_TEACHING_RANKS);

/**
 * 讲法锚点（引文级——基面 = 材料派生 .md 归一化文本，BOM strip + CRLF→LF 后）。
 *
 * mirror materialChunkSpan 同字段减 chunkIndex（讲法锚定到段落+字符级，非 chunk 级）。
 * 区间半开 [start, end)，UTF-16 code unit 偏移（与 JS string 索引一致）；段落号 =
 * 0 起全局段落序（markdown 空行切分最小单位，与 chunkChapter 段落编号同约定，锚点
 * 跨层对齐——10.1 material.ts「摄取时保存」供给面的消费端）。
 */
export const craftTeachingAnchorSchema = z.object({
  /** 所属材料章（chapters[].index；伪章材料〔method='none'〕恒 0）。 */
  chapterIndex: z.number().int().nonnegative(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  paraStart: z.number().int().nonnegative(),
  paraEnd: z.number().int().nonnegative(),
});

export type CraftTeachingAnchor = z.infer<typeof craftTeachingAnchorSchema>;

/**
 * 一条讲法（同词目卡的多来源并列——「合并 = 招式卡聚合多来源讲法非删成一条」，R3）。
 *
 * - `teachingId`：格式钉死 `tea-<sha12>`——sha12 = sha256(materialId + '\\0' +
 *   materialContentHash + '\\0' + quote 归一) 前 12 位 hex（**teaching 幂等键的确定性
 *   派生**，design §1.3：重跑同键同 id 防重复挂载；mirror materialId 路径身份先例——
 *   派生计算归 shell node:crypto，本 regex 钉格式防漂移）。
 * - `materialId` / `materialContentHash`：来源材料 + 蒸馏时原件 hash——stale 判定锚
 *   （原件变 → 讲法 stale 重蒸馏）。
 * - `author`：provenance.author ?? null（e10-2a 元数据接缝 F-11——冲突表达依赖作者
 *   身份；出处与裁决正交）。nullable 非 optional：字段恒在，未知 = null。
 * - `quote`：引文快照（**冗余存**——原文冷层永久保留 + 快照防材料变更后锚空转，
 *   R3 锚定铁律「出处信息在摄取时保存，不是生成时事后找」）。
 * - `note`：差异备注（多来源讲法并列的差异说明 / rank='rejected' 时的不认可理由）。
 * - `stale`：F-07 三触发——①材料原件变更重蒸馏 ②派生 .md 校对编辑（原件 hash 不变、
 *   锚定基面文本变）③材料删除（四清——卡保留，快照仍在）。
 */
/**
 * 呼应证据族形状（craftTeachingSchema.evidence 的独立导出面——E10.3b W7 提取，形状零变更）：
 * merge-review newClaim 携带同形状（裁决成卡时透传进 teaching），两处单源防漂移。
 */
export const craftTeachingEvidenceSchema = z.object({
  anchors: z.array(craftTeachingAnchorSchema).min(1),
  level: z.enum(['strong', 'weak']),
  derivedHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export type CraftTeachingEvidence = z.infer<typeof craftTeachingEvidenceSchema>;

export const craftTeachingSchema = z.object({
  teachingId: z.string().regex(/^tea-[0-9a-f]{12}$/),
  materialId: z.string().regex(/^mat-[0-9a-f]{12}$/),
  materialContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  author: z.string().nullable(),
  quote: z.string().min(1),
  anchor: craftTeachingAnchorSchema,
  rank: craftTeachingRankSchema,
  note: z.string().nullable(),
  stale: z.boolean(),
  /**
   * 来源类型（E10.3b additive，absent = 10.2 既有语义「教程主张」——旧行零迁移）：
   * `doc_claim` = 经验文档蒸馏主张（10.2）；`decon_instance` = 拆书实例讲法（10.3——
   * originKind=decon_instance 时 bookTitle 给出来源书名，人审页来源徽章消费）。
   */
  originKind: z.enum(['doc_claim', 'decon_instance']).optional(),
  /** 拆书来源书名（decon_instance = 材料显示名；doc_claim 缺省；nullable = 材料未命名）。 */
  bookTitle: z.string().nullable().optional(),
  /**
   * 呼应证据族（E10.3b additive——过度归因防线 R7 的落卡面；absent = 旧行〔教程主张无
   * 呼应证据语义〕）。anchors ≥1（回收点/对照物/重复调度——与 anchor 主锚同基同形）；
   * level：`strong` = ≥2 锚或回收点已验 / `weak` = 单锚未验；derivedHash = 拆解时派生
   * .md 指纹（材料校对后锚点漂移的**查询侧提示面**——不自动清理，parent design §2.1）。
   *
   * W7 起独立成 {@link craftTeachingEvidenceSchema} 导出——closure-craft-distill.ts 的
   * merge-review newClaim additive 字段同形状单源（decon 实例经并排裁决独立成卡后
   * originKind/bookTitle/evidence 透传不丢，AC4 语义完整性）。
   */
  evidence: craftTeachingEvidenceSchema.optional(),
});

export type CraftTeaching = z.infer<typeof craftTeachingSchema>;

// ── 主张四件套（R3 切条判据：一个完整主张 = 主张 + 操作要点 + 适用场景 + 反例）──

/**
 * 手艺卡主张四件套。
 *
 * 四件套是**切条判据的完整形态**（LLM prompt 目标）；schema 只钉结构不强制每件非空
 * （points/scenarios/counterexamples 允许空数组——语义完整性归 prompt/人审，schema
 * 不做假信心门）；condensed 非空是硬底（无主张文本即无卡）。切条约束式输出
 * （closure-craft-distill.ts）以本 schema extend 派生，两处四件套形状单源。
 */
export const craftClaimSchema = z.object({
  /** 保义浓缩：主张核心的 Agent 可消费浓缩形态（核心哲学——保留原文精神，不损失含义）。 */
  condensed: z.string().min(1),
  /** 操作要点。 */
  points: z.array(z.string().min(1)),
  /** 适用场景。 */
  scenarios: z.array(z.string().min(1)),
  /** 反例（何时不适用/常见误用）。 */
  counterexamples: z.array(z.string().min(1)),
});

export type CraftClaim = z.infer<typeof craftClaimSchema>;

// ── 手艺卡（closure_craft_card 表行——条目层真相源，design §1.1）──

/** 卡人审状态三态（Guru 验证状态机，R5）。 */
export const CRAFT_CARD_STATUSES = ['pending_review', 'verified', 'rejected'] as const;
export type CraftCardStatus = (typeof CRAFT_CARD_STATUSES)[number];
export const craftCardStatusSchema = z.enum(CRAFT_CARD_STATUSES);

/**
 * 手艺卡（**表为真相源，人审 UI 为唯一编辑面**——不做 markdown 载体，D8 doc-level
 * 形态已实证装不下多讲法+状态机；design §1.1 开放题 #1）。
 *
 * 🔑 **状态机转换表**（design §1.1 F-15 全路径；shell 仓库层强制，本注释是唯一权威
 * 描述——IPC 层 craft:card-patch / craft:card-review 消费）：
 *
 * | from → to | 动作 | 备注 |
 * |---|---|---|
 * | pending_review → verified | verify（人审） | verify 时写 entry 检索行（检索可见性 = 人审状态，AC6） |
 * | pending_review → rejected | reject（驳回） | rejectReason 落库（废弃区回看） |
 * | verified → rejected | reject（直接驳回） | 允许；entry 检索行删 |
 * | rejected → pending_review | recover（救回） | rejected 卡**内容编辑入口禁用**，必须先救回 |
 * | 任何状态 --内容编辑--> pending_review | 编辑即降级 | uniform：人改也回待审（一次额外点击换无机可乘，R5）；状态位独立变更（人审动作本身）不触发降级 |
 *
 * - 讲法级 stale 新增到 verified 卡**不**降级卡（讲法级复核项进队列，卡级状态不动）。
 * - rejected 行不物理删（**驳回废弃区**——防同内容换来源重进 + 误判救回，队列过滤可查）。
 *
 * 字段：
 * - `cardId`：格式钉死 `card-<12hex>`（创建时生成；**合并保留目标卡 id**）。
 * - `category`：受控 13 大类之一（应用层 zod 单源校验；**恒跟随 term.category 单源**，
 *   人审不独立编辑大类——F-15，词目归并时随新 term 自动改）。
 * - `termId`：归类词目（closure_craft_term FK——归类必填，pending 词目也是行）。
 * - `confidence`：AI 归类/去重置信（0-1）——只作队列排序不作自动批准（R3 红线）。
 * - `dispute`：分歧点标记（多讲法语义相反，LLM 判 + 人审确认；**分歧不裁决**——
 *   多讲法并存，注入按 rank 过滤或并排，R4）。
 * - `teachings`：每卡至少一讲法（无锚即丢的必然——无来源主张不可落卡，R1）。
 */
export const craftCardSchema = z.object({
  cardId: z.string().regex(/^card-[0-9a-f]{12}$/),
  category: craftCardCategorySchema,
  termId: z.string().regex(/^term-[0-9a-f]{8}$/),
  /** 招式名（人可读——蒸馏产出/人审可改）。 */
  title: z.string().min(1),
  claim: craftClaimSchema,
  /** 自由标签（R10——与受控 category/term 正交；蒸馏 LLM 自由打 + 人审可改）。 */
  tags: z.array(z.string().min(1)),
  /** 讲法数组（每来源一讲法带作者+锚点+rank——Wikidata statement 形态）。 */
  teachings: z.array(craftTeachingSchema).min(1),
  dispute: z.boolean(),
  status: craftCardStatusSchema,
  /** 驳回理由（status='rejected' 时落值——废弃区回看；其余 null）。 */
  rejectReason: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  /** ISO 8601 时刻（db 侧 datetime 归一，行映射归 repository）。 */
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type CraftCard = z.infer<typeof craftCardSchema>;

// ── 词目（closure_craft_term 表行——两级词表的词目级，design §1.2）──

/**
 * 词目状态。**「待并词表」= status='pending' 行**（AI 归类词表外命中 → 提案 pending
 * 词目，卡 termId 指向它进人审——flomo「积累后再整理」）；人审两动作：核准（→active）/
 * 归并（→merged + 卡 termId 改指目标，category 随新 term 自动改）。
 */
export const CRAFT_TERM_STATUSES = ['active', 'pending', 'merged'] as const;
export type CraftTermStatus = (typeof CRAFT_TERM_STATUSES)[number];
export const craftTermStatusSchema = z.enum(CRAFT_TERM_STATUSES);

/**
 * 词目（两级词表的可增长级：大类受控常量 + 词目 data；**词表即检索面**——词目字段
 * 直接映射混合检索结构化预过滤，R3 §5.3）。
 *
 * - `termId`：格式钉死 `term-<8hex>`（创建时生成；业务唯一 = UNIQUE(category, name)，
 *   db 层约束）。
 * - `mergedInto`：status='merged' 时并入的目标 termId；其余状态 null（待并词表归并
 *   动作的落点——被归并词目留痕不删，挂它的卡改指目标）。
 */
export const craftTermSchema = z.object({
  termId: z.string().regex(/^term-[0-9a-f]{8}$/),
  category: craftCardCategorySchema,
  /** 词目名（中文，如「先抑后扬」）。 */
  name: z.string().min(1),
  status: craftTermStatusSchema,
  mergedInto: z.string().regex(/^term-[0-9a-f]{8}$/).nullable(),
  note: z.string().nullable(),
});

export type CraftTerm = z.infer<typeof craftTermSchema>;

/**
 * 词目初始种子（design §1.2——五个白话散并位按 epics.md:881 指派全承接落位）。
 * W2 建库时落 active 行（termId 生成归 shell）；实施期 D 样例校准补充（W6）。
 * 男频打法类词目后续作词目先验补充（题材中性红线——不硬编码进大类）。
 */
export const CRAFT_TERM_SEEDS: ReadonlyArray<{ name: string; category: CraftCardCategory }> = [
  { name: '同类场景变奏', category: 'jiegoudafa' },
  { name: '固定调度模式', category: 'jiegoudafa' },
  { name: '人物对照组', category: 'renshe' },
  { name: '角色声纹', category: 'renshe' },
  { name: '节奏调剂子型', category: 'qidaigan' },
];
