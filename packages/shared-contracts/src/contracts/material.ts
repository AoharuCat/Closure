import { z } from 'zod';
import { chunkChapter } from './chapter-chunking';
import type { ChapterChunk } from './closure-retrieval';

// ── Story 10.1：材料域 schema（统一材料层契约，Zod 单源，design §2.1）──
//
// 「材料」四件套（ADR-15）：干净文本 + 分章 + 出处 + 质量元数据——任何原料（小说/经验文档）
// 进系统先变材料，10.2（经验文档管线）/10.3（小说拆解）统一消费。双轨同契约（D1 拍板：项目车道
// `<project>/materials/` + 全局车道 `~/.orison/materials/`，scope 字段区分——「统一材料层」=
// 契约统一非物理单库）。
//
// 红线注记：
// - 语义分块红线复用：材料 chunk 一律经 `MATERIAL_CHUNK_STRATEGIES['prose']` = `chunkChapter`
//   （8.3 红线：段落原子 + 转场标记硬边界 + 贪心聚合，无 overlap，禁固定窗口硬切）——禁另写
//   切分器。
// - 「无锚即丢」反向要求（ADR-15 红线② / R3 锚定铁律「出处信息在摄取时保存，不是生成时事后找」）：
//   materialChapterSpan / materialChunkSpan 的段落号 + 字符区间在摄取期随登记落库——10.2 锚点
//   （引文级四元组）由此回查，锚定失败即幻觉闸门的供给面。
// - 派生纪律（ADR-1/ADR-3）：closure_material 是 DERIVED 登记层，可 drop 重建；真相源 =
//   materials/ 原件 + 派生 .md 章标记（method 属性判别人工/自动，见 chapter-splitting.ts §2.3）。
// - 版权（AC11）：schema 只存指针/元数据/指纹，提取产物默认留用户本地，不内嵌分发第三方版权内容。
//
// expected_downstream_consumers:
// - 10.2 经验文档管线：锚定（chunkSpans 段落号+字符区间回查）+ 手艺卡「作者立场」←
//   provenance.author/lang/originDate（R3 §5.7 文档级元数据是作者立场字段来源）。
// - 10.3 小说拆解管线：章寻址（chapters[] 章号→span，逐章提取形态直消费）+ 摄取幂等（contentHash）。
// - C5 已有作品导入：分章能力复用（chapter-splitting.splitChapters）+ 章边界数组形状对齐。
// - 同1.1 multi-source 摄取：提取器接口（ADR-10）经三预留接入而不改本契约——medium 开放词表
//   （R1 medium 五值预留）/ kind 开放字符串（event_stream 不拒，AC9）/ 分块策略 seam。

/**
 * 章界裁决方式（唯一 method 源，F-18：无 material 级冗余字段——分章方法只存在于
 * quality.chapterDetection.method 与 chapters[].method，两处同值）。
 *
 * - `regex`：正则高/中置信直用（splitChapters 第一段）。
 * - `llm-fallback`：低置信 LLM 兜底一次（D2 第二段；便宜档路由，切点落段落边界经校验）。
 * - `manual`：人工裁决（派生 .md 章标记编辑），最高优先——重摄取保留不重分章（F-03）。
 * - `none`：伪章（F-09：低置信且 <2 万字的讲义/访谈类材料，章标天然无意义，全文单章直进）。
 */
export const MATERIAL_CHAPTER_METHODS = ['regex', 'llm-fallback', 'manual', 'none'] as const;
export type MaterialChapterMethod = (typeof MATERIAL_CHAPTER_METHODS)[number];
export const materialChapterMethodSchema = z.enum(MATERIAL_CHAPTER_METHODS);

/**
 * 章界/分章置信。`manual` 是置信域的第四值（人工裁决 = 免置信质疑），与三档机器置信并列。
 */
export const MATERIAL_CHAPTER_CONFIDENCE = ['high', 'medium', 'low', 'manual'] as const;
export type MaterialChapterConfidence = (typeof MATERIAL_CHAPTER_CONFIDENCE)[number];
export const materialChapterConfidenceSchema = z.enum(MATERIAL_CHAPTER_CONFIDENCE);

// ── provenance（出处四件套之一）──

/**
 * 简介长度上限（CR-6 三处齐的 schema 半）：description 随 MaterialSummary 投影行放大每次
 * 列表查询，无上限即违投影纪律——handler 校验与 UI maxLength 引用本常量单源，不另写魔数。
 */
export const MATERIAL_DESCRIPTION_MAX_CHARS = 2000;

/**
 * 材料来源 provenance。
 *
 * - `medium`：来源类别——**开放受控词表，非封闭枚举**（D6 预留①）。V1 词表：
 *   `novel_text`（小说文本）| `lecture`（讲义/教程）| `interview`（访谈）| `criticism`（批评/
 *   评论）| `wiki`（百科/社区站）| `other`；R1 medium 五值（游戏/同人路线，提取器接口接入时
 *   启用）：`game_files` | `community_data` | `runtime_hook` | `screen_capture` | `video`——
 *   其中 `video` 已于 **E10.2a 启用**（视频字幕摄取默认 medium），其余四值仍预留。
 *   schema 不拒绝未来值——同1.1 经接口实施不改契约。
 * - `tier`：三级来源（10.4 provenance 三级标注预留：原作 vs 社区 vs 批评）；`unspecified` 为
 *   摄取期未知默认，UI 可后补。
 * - `sourcePath`：原件路径，相对各自车道根（项目车道相对 `<project>/`，全局车道相对
 *   `~/.orison/materials/`）。
 * - `via`：解析 provenance（机器可读）。V1 词表 = ParseDocVia 六值
 *   （endpoint-mineru|endpoint-docling|endpoint-custom|builtin-pdfjs|builtin-mammoth|direct-read）
 *   + `builtin-epub`（Story 10.1 新增）+ `builtin-subtitle`（E10.2a 字幕解析新增）。开放字符串：
 *   未来提取器路线扩展 via 词表。
 * - `extractor`：提取器标识（ADR-10 提取器接口注册名）；V1 恒 `builtin-text`（小说文本路径）。
 * - `ingestedAt`：摄取完成时刻（ISO 8601）。
 * - `author` / `lang` / `originDate`：〔F-05〕文档级元数据——R3 §5.7：10.2 手艺卡「作者立场」
 *   字段的来源（冲突表达依赖作者身份）。nullable 非 optional：字段恒在，摄取期未知 = null
 *   （UI 可后补，单行表单）。
 * - `description`：〔E10.2a〕简介 = 来源级元数据（视频简介/文档导语）——标题/简介/UP主/日期
 *   四件套补齐后 10.2b 蒸馏管线以之为文档级上下文消费。nullable + **default(null)**：
 *   closure_material 旧行 provenance_json 无此键，`.parse` 回读（materialIndexer）必须容忍
 *   缺失（零迁移）；新写入恒带键（F-05「恒在」语义向前延续）——与 author 三字段「缺键即拒」
 *   刻意不对称，换取旧行回读零迁移。上限 MATERIAL_DESCRIPTION_MAX_CHARS（max 只约束非 null
 *   值，CR-6 投影纪律）。
 */
export const materialProvenanceSchema = z.object({
  medium: z.string().min(1),
  tier: z.enum(['original', 'community', 'criticism', 'unspecified']),
  sourcePath: z.string().min(1),
  via: z.string().min(1),
  extractor: z.string().min(1),
  ingestedAt: z.string().min(1),
  author: z.string().nullable(),
  lang: z.string().nullable(),
  originDate: z.string().nullable(),
  description: z.string().max(MATERIAL_DESCRIPTION_MAX_CHARS).nullable().default(null),
});

export type MaterialProvenance = z.infer<typeof materialProvenanceSchema>;

// ── 质量元数据（出处四件套之一；sansheng diagnose 参考——质量信号参与证据分级）──

/**
 * 分章检测结论。**method 唯一源**（F-18：材料级无 chapteringMethod 冗余字段——本结构与
 * chapters[].method 同值，改一处必改两处，db 亦不设冗余列）。
 *
 * - `method`：裁决方式（词表见 MATERIAL_CHAPTER_METHODS）。
 * - `confidence`：文档级分章置信（llm-fallback 成功 → low→维持 low 或升 medium？——按兜底结果
 *   诚实落值；manual 最高）。
 * - `matchedFormats`：命中的章标格式族标签（splitChapters.matchedFormats 透传——用户/UI 可见
 *   「按什么格式切的」，可解释）。
 * - `llmCapped`：〔F-07〕true = LLM 兜底候选行超预算 300 挂起（不静默截断——截断即隐性丢候选
 *   = 假信心）。二态字段纪律：未触发不出现。
 */
export const materialChapterDetectionSchema = z.object({
  method: materialChapterMethodSchema,
  confidence: materialChapterConfidenceSchema,
  matchedFormats: z.array(z.string()),
  llmCapped: z.boolean().optional(),
});

/**
 * 材料质量元数据。
 *
 * - `ok`：总体质量旗（true = 无降级信号；false = 有扫描/编码/解析降级但不失败——诚实标注，
 *   AC8 不返回近空文本冒充成功）。
 * - `scanned`：扫描版 PDF / 扫描图 epub 降级标注（解析内核 SCANNED_PAGE_CHAR_THRESHOLD 同源）。
 * - `nonUtf8`：非 UTF-8 嫌疑（U+FFFD 替换符比率超阈，GBK 防护信号）。
 * - `parseNotes`：解析 notes（端点降级原因 / 硬骨头格式提示 / LLM 兜底失败原因等，人读）。
 * - `charCount`：归一化后干净文本字符数（UTF-16 code unit 计）。
 */
export const materialQualitySchema = z.object({
  ok: z.boolean(),
  scanned: z.boolean(),
  nonUtf8: z.boolean(),
  parseNotes: z.array(z.string()),
  charCount: z.number().int().nonnegative(),
  chapterDetection: materialChapterDetectionSchema,
});

export type MaterialQuality = z.infer<typeof materialQualitySchema>;

// ── 分章边界 + chunk spans（「摄取时保存段落号+字符区间」的落点）──

/**
 * 材料章边界 span。
 *
 * - `index`：材料内章号（0 起，章可寻址锚——10.3 逐章提取 / 章号→span 查询的键）。
 * - `title`：章题（章标行尾提取；无标题 = null）。
 * - `charStart` / `charEnd`：章全文内字符区间，**半开 [start, end)**，UTF-16 code unit 偏移
 *   （与 JS string 索引一致）——基面 = 派生 .md 归一化文本（BOM strip + CRLF→LF 后）。
 * - `paraStart` / `paraEnd`：段落区间，**半开 [start, end)**，0 起段落序——段落 = markdown 空行
 *   切分的最小单位（与 chunkChapter 段落编号同约定，锚点跨层对齐）。
 * - `confidence` / `method`：该章界的置信与裁决来源（method 含 `none` = 伪章，F-09）。
 */
export const materialChapterSpanSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().nullable(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  paraStart: z.number().int().nonnegative(),
  paraEnd: z.number().int().nonnegative(),
  confidence: materialChapterConfidenceSchema,
  method: materialChapterMethodSchema,
});

export type MaterialChapterSpan = z.infer<typeof materialChapterSpanSchema>;

/**
 * 材料 chunk span（〔F-02〕索引时回填，与 closure_material 登记更新同事务）。
 *
 * **全局车道 span 唯一落点**：全局车道 chunk 走 closure_craft_entry（该表无 span 列，零 ALTER
 * 约束）——命中行经 craft_id 解码 `mat:${materialId}.ch${i}#c${n}` 回查本表取段落号+字符区间
 * （10.2 锚定 / query_craft 命中渲染 span 脚注的取数面）。
 *
 * - `chapterIndex`：所属材料章（chapters[].index）。
 * - `chunkIndex`：章内 chunk 序（chunkChapter 输出的 chunk.index）。
 * - `charStart` / `charEnd` / `paraStart` / `paraEnd`：半开区间，基面同 materialChapterSpan
 *   （chunk.text === 章全文.slice(charStart, charEnd)，chunkChapter 输出保证）。
 */
export const materialChunkSpanSchema = z.object({
  chapterIndex: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  paraStart: z.number().int().nonnegative(),
  paraEnd: z.number().int().nonnegative(),
});

export type MaterialChunkSpan = z.infer<typeof materialChunkSpanSchema>;

// ── 材料登记行（统一材料层主契约）──

/**
 * 原件格式（V1 白名单；硬骨头格式老 doc/chm/录音转写分期记档不进词表，design §4.5）。
 * E10.2a += 字幕三格式 srt/ass/vtt（解析归 contracts/subtitle-parsing.ts 纯函数，
 * 拼合文本经 LLM 书面化整理后进既有分章/索引管线）。
 */
export const MATERIAL_FORMATS = ['txt', 'md', 'docx', 'pdf', 'epub', 'srt', 'ass', 'vtt'] as const;
export type MaterialFormat = (typeof MATERIAL_FORMATS)[number];

/**
 * 材料登记状态。
 *
 * `low-confidence`（F-09）：章界不可信（挂起人工校对）但**检索照常**——伪章/已有章照索引，
 * 章界与检索解耦，10.2 原料层兜底不断线。`pending`：摄取/索引进行中。
 */
export const MATERIAL_STATUSES = ['pending', 'ready', 'low-confidence', 'failed'] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

/**
 * 材料登记行（双车道同契约，scope 区分）。
 *
 * - `materialId`：格式钉死 `mat-<sha12>`——sha12 = sha256(scope + '\0' + sourcePath) 的前 12 位
 *   hex（**路径身份非内容身份**：同路径换内容 = 同 ID 重摄取幂等；12 hex 消碰撞余量，F-19）。
 *   派生计算归 shell（node:crypto），本 regex 钉格式防漂移。
 * - `scope` / `projectId`：车道（project 车道带 registry 5 位 projectId；global 车道 null）。
 * - `kind`：材料种类——**开放字符串**（D6 预留②）：V1 恒 `prose`（小说/文档文本路径）；
 *   `event_stream` 等未来值（游戏对话事件流，同人期提取器实施）schema 不拒绝、代码不实现（AC9）。
 * - `contentHash`：原件内容指纹 `sha256:<64hex>`——幂等/增量判定底座（精确命中 skip +
 *   shingle 差分识别内容变更，attachmentMeta 先例在 shell）。
 */
export const materialSchema = z.object({
  materialId: z.string().regex(/^mat-[0-9a-f]{12}$/),
  scope: z.enum(['project', 'global']),
  projectId: z.string().nullable(),
  kind: z.string().min(1),
  name: z.string().min(1),
  format: z.enum(MATERIAL_FORMATS),
  provenance: materialProvenanceSchema,
  quality: materialQualitySchema,
  chapters: z.array(materialChapterSpanSchema),
  chunkSpans: z.array(materialChunkSpanSchema),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: z.enum(MATERIAL_STATUSES),
});

export type Material = z.infer<typeof materialSchema>;

// ── 分块策略 seam（D6 预留③）──

/**
 * 材料 chunk 分块策略：整章文本 → chunk 数组。
 *
 * 索引器经 `MATERIAL_CHUNK_STRATEGIES[kind]` 取策略（取不到 = 该 kind 不分块/未实施——索引器
 * 不硬编码 prose）。V1 仅注册 `prose: chunkChapter`（语义分块红线复用）；未来 event_stream
 * 材料（游戏对话等，同人期经提取器接口实施）到时**加策略不改索引器**。
 */
export type MaterialChunkStrategy = (text: string) => ChapterChunk[];

export const MATERIAL_CHUNK_STRATEGIES: Readonly<Record<string, MaterialChunkStrategy>> = {
  prose: chunkChapter,
};
