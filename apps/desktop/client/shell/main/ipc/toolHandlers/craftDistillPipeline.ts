/**
 * E10.2b（task 09-05）Wave 3：经验文档蒸馏管线主体（design §0 管线 / §1.3 台账 / §2.1-2.3 各缝）。
 *
 * 管线（按材料触发，craft:distill-run 批量队列）：
 *
 *   材料（ready/low-confidence 派生 .md——章界挂起与蒸馏正交〔F-09〕；pending/failed 不可蒸）
 *     → 台账双 hash 门控（原件 hash 全量重蒸 / 派生 .md 变更→讲法 stale 复核不重蒸〔F-07〕）
 *     → 切条（LLM 约束式：全局段落号引用〔F-16 段偏移零换算〕+ provenance 摘要注入〔F-11〕）
 *     → 锚定核验（纯代码：paraRange→splitParagraphBlocks 映射 char span + 引文子串匹配容忍
 *        空白归一；**无锚即丢**——失败丢该条非整体，计数落台账 stats.droppedNoAnchor，AC1）
 *     → 词表归类（LLM 受控 13 大类 + active 词目清单内选；越界整体重试一次 → 仍越界转 pending
 *        词目提案〔design §2.2〕；confidence 只排序不自动批准——R3 红线）
 *     → 去重（#claim 向量同形状对比：新 condensed vs 既有卡 condensed〔F-09〕；三档分流
 *        ≥0.98 自动挂候选 / 0.85-0.98 建 merge_review / <0.85 新建卡；无 embed 模型 → 去重
 *        不可用全部新建卡 + 台账诚实 note〔管线产物本就全量人审——pending_review 队列即人审
 *        面，「降中档」语义落地为新建卡进队〕；冲突 LLM 判语义相反 → dispute 标记 + note，
 *        禁纯代码词面判——R4 红线）
 *     → 落卡（**每材料单事务**〔F-04〕：新卡 insert / 讲法 append / review 行 / pending 词目 /
 *        重蒸旧讲法 stale / 台账 done 同一 `db.transaction`——崩溃全回滚，重跑从零干净起板；
 *        belt = teaching (materialId+contentHash+quote 归一) 幂等键〔W1 tea-<sha12> 派生〕）
 *
 * 范式判据（ADR-3 / creative-vs-mechanical spec）：切条（完整主张判定）/ 归类（受控词表内选）/
 * 冲突判定（语义相反）= LLM 约束式缝；锚定核验 / 相似度算数 / 三档分流 / 台账记账 / 状态机 =
 * 纯代码。LLM 缝全按 E10.2a 沉淀（creative-vs-mechanical spec 两 Pattern）：
 * - **finishReason 权威停因**（CR-2）：切条输出截断判定看 provider 停因不猜比值——'length' →
 *   材料级失败挂起（不落半程产物），非 'length' 通过，缺省无启发式回退（切条输出 JSON 截断
 *   必然解析失败，无需比值兜底）。
 * - **独立 maxTokens 核算**（CR-2 配套纪律）：切条是生成式大 JSON 输出，预算独立常量、不 mirror
 *   小 JSON 缝的 4096（见 CLAIM_EXTRACTION_MAX_TOKENS 注记）。
 * - **超限诚实挂起**（F-17）：主张数超 MAX_CLAIMS_PER_MATERIAL → 台账 failed + 诚实 note，
 *   不静默截断（截断即隐性丢主张 = 假信心门家族）。
 *
 * never-throws（W3.4）：单材料失败落台账 failed + error + 终态进度事件，批量继续（mirror
 * backfill per-item try/catch）；进度事件 best-effort push（craftDistillNotify，可丢——读侧
 * 兜底 distill-status 拉取）。
 *
 * 依赖边界：LLM 生成走 install seam（craftDistillLlmCore 生产装配真身——configIpc/
 * modelGatewayIpc 在既有环上，本模块位于 craftIpc/repository 链上不可静态引入，mirror
 * materialIngest installMaterialLLMCore 先例）；embed 走 DI deps（resolveModel/embed，
 * mirror CraftCardIndexDeps——db 层既有直引面）。
 *
 * expected_downstream_consumers:
 * - W3 craftIpc（craft:distill-run 批量入队 / craft:distill-status 台账查询）。
 * - W5 手艺页（经 distill-status + craft:distill-progress 事件刷新台账徽章）。
 * - W4/W5 merge-review resolve 执行面（三动作裁决的消费）。**review 路径的冲突信号**
 *   （CR-2b-D1 拍板 a 案 2026-09-05）：去重段 judgeDispute 的 verdict 随 review 行
 *   disputeHint 持久化（可选键二态——缺省 = LLM 判定不可用，不写暗示已检查的标记），
 *   并排视图提示 LLM 预判（auto-merge 档 dispute 落卡之外，中档也有了信号）；合并后
 *   仍可经 craft:card-patch dispute 位人工标记；auto-merge 路径的 dispute 由本管线
 *   落卡（dispute=1 + 讲法 note，§2.3）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CraftCard,
  CraftCardCategory,
  CraftClaimExtractionItem,
  CraftDistillLedger,
  CraftDistillPhase,
  CraftDistillProgressEvent,
  CraftDistillSkipReason,
  CraftDistillStats,
  CraftMergeReview,
  CraftTeaching,
  CraftTeachingAnchor,
  CraftTerm,
  GenerationFinishReason,
  Material,
  ResolvedModel,
} from '@orison/shared-contracts';
import {
  craftClaimExtractionItemSchema,
  craftDisputeVerdictOutputSchema,
  craftKnownTermCategorizationSchema,
  craftProposedTermCategorizationSchema,
  formatCraftCardCategories,
} from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from '../../db';
import { isSqliteVecAvailable } from '../../db/sqliteVecLoader';
import { getCurrentCraftVecDim } from '../../db/craftVecDim';
import { floatArrayToBuffer, shouldSkipForModelMismatch } from '../../db/closureIndexer';
import {
  appendCraftTeaching,
  decodeCardCraftId,
  getCraftCardRow,
  insertCraftCardRowSync,
  markCraftTeachingsStaleByMaterial,
  resolvePrevailingCraftVectorModel,
  type CraftCardRow,
} from '../../db/closureCraftCardRepository';
import {
  findCraftTermByName,
  getCraftTerm,
  insertCraftTerm,
  listCraftTerms,
  proposedCraftTermId,
} from '../../db/closureCraftTermRepository';
import { getCraftDistillLedger, upsertCraftDistillLedger } from '../../db/closureCraftDistillRepository';
import { insertCraftMergeReview } from '../../db/closureCraftMergeReviewRepository';
import {
  derivedRelPathForMaterial,
  getGlobalMaterialsRoot,
  getMaterialRow,
} from '../../db/materialIndexer';
import { getProjectById } from '../../db/projectRepository';
import { resolveEmbeddingModel } from '../modelGatewayIpc';
import { sendCraftDistillProgress } from '../craftDistillNotify';
import { splitParagraphBlocks, type MaterialParagraphBlock } from './materialIngest';
import { getLogger } from '../../logger';

// ── 常量（阈值全部 R3 推测值起步——W6 真实语料校准，design §6）──

/**
 * 材料级主张数上限（F-17）：超限挂起（台账 failed + 诚实 note）——不静默截断。
 * 200 = 两百份语料量级下单材料手艺数的宽松上界（3-8 条/3000 字密度 × 异常长材料护栏）。
 */
export const MAX_CLAIMS_PER_MATERIAL = 200;

/**
 * 切条分段字符预算（超限按块边界分段串行——design §2.1；单块超限保持整段不硬截，mirror
 * CR-1 极端流纪律）。**与输出预算自洽（CR-2b-3）**：密度上限 8 条/3000 字（切条判据参考
 * 密度）→ 18000 字段最多 48 条 × ~350 tokens/条 ≈ 17k tokens，与 CLAIM_EXTRACTION_MAX_
 * TOKENS=16384 预算匹配（30k 会让密集段合法产出 ~80 条 ≈ 28k tokens 必然触发 length
 * 硬截断挂起——密度上限与分段上限的换算在此钉死，改动任一侧须同步核另一侧）。
 */
export const CRAFT_DISTILL_SEGMENT_CHAR_LIMIT = 18_000;

/**
 * 高置信自动挂候选阈（R3 推测值——Neo4j SAME_AS ≥0.98；校准注记：驳回率 >2% 调高，design §6）。
 */
export const DEDUP_AUTO_SIMILARITY = 0.98;

/** 中置信人审并排阈（R3 推测值——0.85-0.98 档；同上校准注记）。 */
export const DEDUP_REVIEW_SIMILARITY = 0.85;

/** 去重 KNN 窗口（只需 top-1 最大相似度定档——16 = 平局余量，非分页面）。 */
const DEDUP_KNN_K = 16;

/**
 * 切条输出 token 预算（**独立核算**——E10.2a CR-2 配套纪律：切条是生成式大 JSON，不 mirror
 * 分章兜底 4096 那种小 JSON 预算）。换算依据（CR-2b-3 钉死）：每条 = 四件套 + quote + tags
 * 估 250-400 tokens（中文 ~1.5-2 字/token）；CRAFT_DISTILL_SEGMENT_CHAR_LIMIT=18000 字段
 * 按密度上限 8 条/3000 字最多 48 条 ≈ 17k tokens ≤ 16384 预算余量内（截断由
 * finishReason='length' 权威判定挂起，不静默截断主张——分段上限与预算的换算见彼常量注记）。
 */
export const CLAIM_EXTRACTION_MAX_TOKENS = 16384;

/** 归类输出预算（小 JSON：{category,termId,confidence} 或 proposedTerm 形态）。 */
export const CATEGORIZATION_MAX_TOKENS = 1024;

/** 冲突判定输出预算（小 JSON：{dispute,reason}——reason 一句话）。 */
export const DISPUTE_MAX_TOKENS = 1024;

/**
 * 相位内进度发射 tick 间隔（CR-2b-5——运行可见性硬要求）：长相位（3 分钟切条等）全靠相位
 * 切换发一次事件会让耗时全程冻结在 0s——相位内按本间隔重复发 running 事件（同相位
 * elapsedMs 递增），终态停发。
 */
export const CRAFT_DISTILL_PROGRESS_TICK_MS = 1000;

/** 台账 hash 哨兵（missing-derived 等无基面可 hash 的失败态——成功运行即被真 hash 覆盖）。 */
const UNKNOWN_HASH = `sha256:${'0'.repeat(64)}`;

// ── LLM 缝（installXxxCore setter 防环先例——materialIngest.ts 同型）──

/** 蒸馏 LLM 任务档（C3.2 六档成员：extraction「提取·汇编」= 切条/归类；review-judge = 冲突判定）。 */
export type CraftDistillGenerateSlot = 'extraction' | 'review-judge';

/**
 * 蒸馏单次文本生成 seam（never-throws 由调用方兜——失败 → 材料级失败挂起）。
 * `finishReason` 透传 provider 停因（E10.2a CR-2——截断判定权威信号）；`maxTokens` 由调用方
 * 按缝的输出量独立核算传入（缺省 = 装配侧常量 belt）。
 */
export type CraftDistillGenerateText = (input: {
  slot: CraftDistillGenerateSlot;
  system?: string;
  user: string;
  maxTokens?: number;
}) => Promise<{
  text: string;
  finishReason?: GenerationFinishReason;
}>;

export interface CraftDistillLlmCore {
  /**
   * 生产装配（craftDistillLlmCore.ts——main/index.ts whenReady 接线）：slot → resolveTaskModel
   * (slot) 每调用现解析 → resolveModel → model-protocols generateText；温度随档（判别 0 /
   * 语义裁判 0.2）；思考策略随档（assignmentThinkingControl）。
   */
  generateText: CraftDistillGenerateText;
}

let llmCore: CraftDistillLlmCore | null = null;

/** 生产装配点（main/index.ts whenReady；未装配时蒸馏一律 'llm-unavailable' 失败挂起）。 */
export function installCraftDistillLlmCore(next: CraftDistillLlmCore): void {
  llmCore = next;
}

/** 测试缝：探针已装配内核。 */
export function __getCraftDistillLlmCoreForTest(): CraftDistillLlmCore | null {
  return llmCore;
}

/** 测试缝：清装配内核（用例间隔离）。 */
export function __clearCraftDistillLlmCoreForTest(): void {
  llmCore = null;
}

// ── DI deps（mirror MaterialIngestDeps / CraftCardIndexDeps——测试零网络）──

export interface CraftDistillDeps {
  /** 生成注入（优先于 install 装配内核；测试注入 mock）。 */
  generateText?: CraftDistillGenerateText;
  /** 解析 embed 模型；null → 去重不可用（全部新建卡 + 台账诚实 note）。缺省 resolveEmbeddingModel。 */
  resolveModel?: () => ResolvedModel | null;
  /** 单文本 embed；缺省 generateEmbeddings 包装（30s 超时，mirror card repo defaultEmbed）。 */
  embed?: (model: ResolvedModel, text: string) => Promise<number[]>;
  /** 进度事件发射面（默认 sendCraftDistillProgress；测试收集断言）。 */
  notify?: (event: CraftDistillProgressEvent) => void;
  /** 相位内进度 tick 间隔（CR-2b-5；默认 CRAFT_DISTILL_PROGRESS_TICK_MS——测试注入缩短）。 */
  progressTickMs?: number;
  /** 时钟注入（createdAt/distilledAt 可测）。 */
  now?: () => Date;
}

async function defaultEmbedOne(model: ResolvedModel, text: string): Promise<number[]> {
  const res = await generateEmbeddings(model, { input: [text] }, { signal: AbortSignal.timeout(30_000) });
  return res.embeddings[0] ?? [];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha256Content(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/** 空白归一（锚定子串匹配 + teaching 幂等键的 quote 归一单源——LLM 引文空白抖动不误杀）。 */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * teaching 幂等键（W1 契约 JSDoc 钉死形态）：`tea-<sha12>` = sha256(materialId\0contentHash\0
 * quote 归一) 前 12 hex——同材料同内容同引文重跑同 id（appendCraftTeaching 幂等 no-op +
 * 批内 pre-landing 去重双保险，F-04）。
 */
export function teachingIdFor(materialId: string, materialContentHash: string, quote: string): string {
  return `tea-${createHash('sha256')
    .update(`${materialId}\0${materialContentHash}\0${stripWhitespace(quote)}`)
    .digest('hex')
    .slice(0, 12)}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ── 派生 .md 读取（materialIndexer readDerivedText 同式——BOM strip + CRLF→LF 归一）──

function projectMaterialsRoot(projectId: string): string | null {
  const record = getProjectById(projectId);
  const projectPath = record?.path;
  if (typeof projectPath !== 'string' || projectPath.length === 0) return null;
  return path.join(path.resolve(projectPath), 'materials');
}

function readDerivedTextForMaterial(material: Material): string | null {
  const derivedRel = derivedRelPathForMaterial(material);
  if (derivedRel === null) return null;
  const root =
    material.scope === 'global'
      ? getGlobalMaterialsRoot()
      : material.projectId !== null
        ? projectMaterialsRoot(material.projectId)
        : null;
  if (root === null) return null;
  try {
    const raw = readFileSync(path.join(root, derivedRel), 'utf-8');
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return stripped.replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

// ── W3.1 切条缝：分段 + prompt + 约束式解析 + 锚定核验（纯代码）──

/** 切条分段（全局段落号区间——LLM paraRange 即全档坐标，F-16 零偏移换算）。 */
interface ExtractSegment {
  blockStart: number;
  blockEnd: number;
}

/** 段落→章归属（锚点 chapterIndex 用——零章/未命中恒 0，W1 anchor 契约）。 */
function buildBlockChapterMap(
  blocks: readonly MaterialParagraphBlock[],
  chapters: Material['chapters'],
): number[] {
  return blocks.map((b) => {
    for (const c of chapters) {
      if (b.start >= c.charStart && b.start < c.charEnd) return c.index;
    }
    return 0;
  });
}

/**
 * 切条分段（design §2.1）：有章材料按章 char span 相交切块（mirror mapParagraphRanges——章界
 * 落段边界，块范围与章 span 对齐）；零章材料全文一段；段内超过 {@link
 * CRAFT_DISTILL_SEGMENT_CHAR_LIMIT} 按块边界再切（单块超限保持整段不硬截——LLM 输入大但
 * 截断防御在输出侧 finishReason，mirror materialIngest CR-1 极端流纪律）。
 */
function buildExtractSegments(
  blocks: readonly MaterialParagraphBlock[],
  chapters: Material['chapters'],
): ExtractSegment[] {
  const ranges: Array<[number, number]> = [];
  if (chapters.length > 0) {
    for (const c of chapters) {
      let first = -1;
      let last = -1;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].end > c.charStart && blocks[i].start < c.charEnd) {
          if (first === -1) first = i;
          last = i;
        }
      }
      if (first !== -1) ranges.push([first, last + 1]);
    }
  }
  if (ranges.length === 0) ranges.push([0, blocks.length]);
  const segments: ExtractSegment[] = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    let start = rangeStart;
    let len = 0;
    for (let i = rangeStart; i < rangeEnd; i++) {
      const blockLen = blocks[i].end - blocks[i].start;
      if (len > 0 && len + blockLen > CRAFT_DISTILL_SEGMENT_CHAR_LIMIT) {
        segments.push({ blockStart: start, blockEnd: i });
        start = i;
        len = 0;
      }
      len += blockLen;
    }
    segments.push({ blockStart: start, blockEnd: rangeEnd });
  }
  return segments;
}

/** provenance 摘要注入块（标题+作者+简介——e10-2a 元数据接缝 F-11；字段缺省整块跳过）。 */
function buildProvenanceBlock(material: Material): string {
  const lines: string[] = [];
  if (material.name.trim()) lines.push(`标题：${material.name.trim()}`);
  if (material.provenance.author?.trim()) lines.push(`作者：${material.provenance.author.trim()}`);
  if (material.provenance.description?.trim()) lines.push(`简介：${material.provenance.description.trim()}`);
  if (lines.length === 0) return '';
  return `【材料信息】\n${lines.join('\n')}\n\n`;
}

/**
 * 切条 user prompt（纯函数，导出供直测/断言）：正文片段段落以【P全局段号】标记——paraRange
 * 引用的即全档坐标（F-16），锚定映射零偏移换算。
 */
export function buildClaimExtractionUserPrompt(
  derived: string,
  blocks: readonly MaterialParagraphBlock[],
  segment: ExtractSegment,
  material: Material,
): string {
  const numbered: string[] = [];
  for (let i = segment.blockStart; i < segment.blockEnd; i++) {
    numbered.push(`【P${i}】${derived.slice(blocks[i].start, blocks[i].end)}`);
  }
  return [
    buildProvenanceBlock(material),
    '【正文片段（【P段落号】标记每段开始；段落号是全文档全局编号）】',
    numbered.join('\n\n'),
    `（本片段段落号范围 P${segment.blockStart}–P${segment.blockEnd - 1}；paraRange 只能引用该范围内实际出现的段落号）`,
  ].join('\n');
}

/**
 * 切条 system prompt（R3 切条判据 + 用户通透学保义红线 + R10 自由打标指引）。导出供测试断言。
 */
export const CLAIM_EXTRACTION_SYSTEM_PROMPT = [
  '你是写作经验文档的蒸馏器。把经验文档（讲义/访谈/批评/字幕整理稿等）中的可复用写作手艺切条抽取出来，改写成 AI 可直接消费的手艺卡主张。',
  '切条判据：切条单位 = 一个完整主张（招式）= 主张 + 操作要点 + 适用场景 + 反例四件套；宁大勿碎——同一招式的细节合为一条，覆盖两个不同招式的内容切成两条；参考密度 3-8 条/3000 字（按内容密度自然切，非硬指标）。',
  '每条输出字段：',
  '- paraRange：{"start":段号,"end":段号}——该主张依据的段落区间（半开区间），只能引用输入中实际出现的段落号；',
  '- quote：该区间内的原文引文（逐字摘录关键句即可，不得改写、不得拼接不同位置的文字）；',
  '- condensed：保义浓缩——在保留原文精神与总体经验的前提下，浓缩改写成结构清晰的主张表述。红线：不得引入原文没有的主张或信息，不得丢失原文的关键信息；',
  '- points：操作要点（原文有的才写，没有则空数组）；',
  '- scenarios：适用场景（同上）；',
  '- counterexamples：反例/常见误用（同上）；',
  '- tags：自由标签——按题材/场景/流派/强度/适用文体等你认为有用的维度自由打标，不受任何词表限制。',
  '输出：纯 JSON 数组（每元素含上述字段），不要输出任何解释或前后缀。',
].join('\n');

/**
 * 归类 system prompt（受控词表——R2 红线禁自由生成类目；大类 13 类静态注入 system，active
 * 词目清单随 user 动态注入）。导出供测试断言。
 */
export const CATEGORIZATION_SYSTEM_PROMPT = [
  '你是写作手艺卡的归类器。每条手艺卡主张必须归入受控两级词表：大类（13 类，见下）+ 词目（随输入给出的 active 清单）。',
  formatCraftCardCategories(),
  '规则：',
  '- 优先从 active 词目清单中选最贴合的词目：输出 {"category":"<大类slug>","termId":"<清单内词目id>","confidence":0到1的小数}；category 必须与所选词目的大类一致；清单外的 termId 会被整体拒收。',
  '- 清单内确实没有合适词目时才提新词目：输出 {"proposedTerm":{"category":"<13类内slug>","name":"<简短中文词目名>"},"confidence":0到1的小数}；大类永远只能取 13 类之一，禁止自造类目。',
  '- confidence 是你对该归类的置信度（0-1），只用于人审队列排序，不会被自动采纳。',
  '只输出 JSON，不要任何其他文字。',
].join('\n');

/** 冲突判定 system prompt（语义相反判定——R4 红线：分歧不裁决，出处与裁决正交）。导出供测试断言。 */
export const DISPUTE_SYSTEM_PROMPT = [
  '你是写作手艺卡的分歧判定器。同一招式下两条来自不同来源的主张，判断它们是否语义相反（教法冲突：「一说应该 X，另一说应该非 X」）。',
  '只判语义是否相反，不裁决谁对——分歧保留给人审确认。',
  '输出 {"dispute":true或false,"reason":"判定理由（一句话）"}，只输出 JSON，不要任何其他文字。',
].join('\n');

/**
 * 归类 user prompt（active 词目清单 + 待归类主张——纯函数，导出供直测）。CR-2b-19：与切条
 * 同注入材料 provenance 块（标题/作者/简介——AC9 prompt 装配断言两侧都盖；buildProvenanceBlock
 * 单源复用，字段缺省整块跳过）。
 */
export function buildCategorizationUserPrompt(
  item: CraftClaimExtractionItem,
  activeTerms: readonly CraftTerm[],
  corrective: boolean,
  material: Material,
): string {
  const lines = activeTerms.map((t) => `${t.termId} | ${t.category} | ${t.name}`);
  return [
    buildProvenanceBlock(material),
    '【active 词目清单（termId | 大类 | 词目名）】',
    ...lines,
    '',
    '【待归类主张】',
    `主张：${item.condensed}`,
    ...(item.points.length > 0 ? [`操作要点：${item.points.join('；')}`] : []),
    ...(item.scenarios.length > 0 ? [`适用场景：${item.scenarios.join('；')}`] : []),
    ...(corrective
      ? [
          '',
          '注意：上一次输出的 termId 不在词目清单内或与词目大类不一致。请改选清单内词目 id；若词表确实没有合适词目，输出新词目提案（proposedTerm 形态）。',
        ]
      : []),
  ].join('\n');
}

// ── LLM 输出解析（约束式——越界整体拒收不部分采纳，mirror parseChapterFallbackResponse）──

/** 宽松 JSON 抽取（首个 open 到末个 close 的切片——LLM 前后缀噪声容忍，mirror 候选行缝）。 */
function parseJsonLoose(raw: string, open: string, close: string): unknown {
  const s = raw.indexOf(open);
  const e = raw.lastIndexOf(close);
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(raw.slice(s, e + 1));
  } catch {
    return null;
  }
}

/** 归类输出两态（craftCategorizationOutputSchema 的判别形态——known/proposal 手工判别后分别 safeParse）。 */
type CategorizationResult =
  | { kind: 'known'; category: CraftCardCategory; termId: string; confidence: number }
  | { kind: 'proposal'; category: CraftCardCategory; name: string; confidence: number }
  | { kind: 'bad' };

function parseCategorizationResponse(raw: string): CategorizationResult {
  const obj = parseJsonLoose(raw, '{', '}');
  if (obj === null || typeof obj !== 'object') return { kind: 'bad' };
  if ('proposedTerm' in obj) {
    const parsed = craftProposedTermCategorizationSchema.safeParse(obj);
    if (!parsed.success) return { kind: 'bad' };
    return {
      kind: 'proposal',
      category: parsed.data.proposedTerm.category,
      name: parsed.data.proposedTerm.name,
      confidence: parsed.data.confidence,
    };
  }
  const parsed = craftKnownTermCategorizationSchema.safeParse(obj);
  if (!parsed.success) return { kind: 'bad' };
  return { kind: 'known', category: parsed.data.category, termId: parsed.data.termId, confidence: parsed.data.confidence };
}

/** 归类缝（design §2.2）：越界（termId 不在清单/大类不一致/输出坏）整体重试一次 → 仍坏按 per-claim 丢弃降级（CR-2b-2，不编造提案名）。 */
async function categorizeClaim(
  item: CraftClaimExtractionItem,
  activeTerms: readonly CraftTerm[],
  generate: CraftDistillGenerateText,
  material: Material,
): Promise<Extract<CategorizationResult, { kind: 'known' | 'proposal' }> | { kind: 'fail'; message: string }> {
  const termIndex = new Map(activeTerms.map((t) => [t.termId, t] as const));
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = '';
    let finishReason: GenerationFinishReason | undefined;
    try {
      const response = await generate({
        slot: 'extraction',
        system: CATEGORIZATION_SYSTEM_PROMPT,
        user: buildCategorizationUserPrompt(item, activeTerms, attempt > 0, material),
        maxTokens: CATEGORIZATION_MAX_TOKENS,
      });
      text = (response?.text ?? '').trim();
      finishReason = response?.finishReason;
    } catch (err) {
      if (attempt > 0) return { kind: 'fail', message: `归类调用失败：${errMsg(err)}` };
      continue;
    }
    if (finishReason === 'length') {
      if (attempt > 0) return { kind: 'fail', message: '归类输出因 token 上限截断（finishReason=length）' };
      continue;
    }
    if (!text) {
      if (attempt > 0) return { kind: 'fail', message: '归类返回空回复' };
      continue;
    }
    const parsed = parseCategorizationResponse(text);
    if (parsed.kind === 'bad') {
      if (attempt > 0) return { kind: 'fail', message: '归类输出两次不可解析（整体拒收——不硬给归类）' };
      continue;
    }
    if (parsed.kind === 'known') {
      const term = termIndex.get(parsed.termId);
      if (term === undefined || term.category !== parsed.category) {
        // 越界/大类不一致 → 重试一次（约束式纪律：集外引用不部分采纳）。
        if (attempt > 0) {
          return { kind: 'fail', message: `归类 termId 两次越界（${parsed.termId} 不在 active 清单内）` };
        }
        continue;
      }
      return parsed;
    }
    return parsed; // proposal（category 已被 zod 限制在 13 类内——R2 红线 schema 层强制）
  }
  return { kind: 'fail', message: '归类输出不可用（重试耗尽）' };
}

/** 冲突判定缝（review-judge 档——never-throws：失败返 null 按「无分歧」落，warn 留痕）。 */
async function judgeDispute(
  existingCondensed: string,
  newCondensed: string,
  generate: CraftDistillGenerateText,
): Promise<{ dispute: boolean; reason: string } | null> {
  try {
    const response = await generate({
      slot: 'review-judge',
      system: DISPUTE_SYSTEM_PROMPT,
      user: `【既有卡主张】\n${existingCondensed}\n\n【新主张】\n${newCondensed}`,
      maxTokens: DISPUTE_MAX_TOKENS,
    });
    if (response.finishReason === 'length') return null;
    const parsed = craftDisputeVerdictOutputSchema.safeParse(parseJsonLoose((response.text ?? '').trim(), '{', '}'));
    if (!parsed.success) return null;
    return { dispute: parsed.data.dispute, reason: parsed.data.reason };
  } catch (err) {
    getLogger().warn({ err: errMsg(err) }, 'craft distill: dispute judge failed - treating as no dispute');
    return null;
  }
}

// ── 词目墓碑链跟随（CR-2b-9 单源 helper）──

/** 墓碑链跟随深度帽（病态长链/环不悬挂——词目归并的现实链长远 < 16）。 */
const TERM_TOMBSTONE_MAX_DEPTH = 16;

/**
 * 词目墓碑链跟随（CR-2b-9 单源 helper）：命中 status='merged' 墓碑词目时沿 mergedInto 链
 * 跟到最终活词目（active/pending）——A→B→C 归并链后提案命中墓碑 A，卡须挂 C 而非死词目。
 * 环防护 = seen 集 + 深度帽；链断（目标行缺失）或环时返回链上最后可达词目（保守——比编造
 * 或丢条好；活词目/未知 id 原样返回）。**两处消费单源**：本管线归类提案路径 + craftIpc
 * merge-review-resolve independent 路径（彼处接线归 W5 组——字段名/语义在此钉死）。
 */
export function resolveTermTombstone(termId: string): CraftTerm | null {
  let current = getCraftTerm(termId);
  const seen = new Set<string>();
  while (current !== null && current.status === 'merged' && current.mergedInto !== null) {
    if (seen.has(current.termId) || seen.size >= TERM_TOMBSTONE_MAX_DEPTH) break;
    seen.add(current.termId);
    current = getCraftTerm(current.mergedInto);
  }
  return current;
}

// ── 去重相似度算数（纯代码——F-09 同形状：新 condensed vs 既有卡 condensed）──

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 余弦相似度（两向量取公共维前缀——批内比对与 KNN 同度量）。E10.3b W5 导出——P6 拆书落卡
 * 的**批内向量比对**复用（落卡单事务前新卡不在 vec 表，同 run 相似主张须内存比对防近重复卡；
 * 私有→导出，零行为变更——knnClaimSimilarities 的 db 内臂同族）。
 */
export { cosineSimilarity };

/**
 * #claim 向量 KNN（vec0 metadata 过滤 vector_kind='claim'——W2 测试钉死的形态；craft_id 前缀
 * belt 解码）。E10.3b W1 导出——P6 拆书落卡的去重三档分流复用（私有→导出，零行为变更；
 * DEDUP 阈值常量与 teachingIdFor 已导出无需动）。
 */
export function knnClaimSimilarities(queryVector: number[]): Array<{ cardId: string; similarity: number }> {
  const rows = getDb()
    .prepare(
      `SELECT craft_id, distance FROM closure_craft_vec WHERE embedding MATCH ? AND k = ? AND vector_kind='claim'`,
    )
    .all(floatArrayToBuffer(queryVector), DEDUP_KNN_K) as Array<{ craft_id: string; distance: number }>;
  return rows.flatMap((r) => {
    const cardId = decodeCardCraftId(r.craft_id);
    return cardId === null ? [] : [{ cardId, similarity: clamp01(1 - r.distance) }];
  });
}

// ── 台账门控与编排 ──

/** 在途蒸馏守卫（进程内权威——ledger 'running' 行是崩溃残留的 stale 态，重启后由新运行覆盖自愈）。 */
const inflightDistills = new Set<string>();

/**
 * 蒸馏资格门（**单源**，CR-2b-15——双 hash 门逻辑曾两处手抄）分三件：
 * - {@link loadDistillableMaterial}：登记行 + 就绪态（gate 链与 distillMaterial 共用核心）。
 * - {@link decideCraftDistillHashGate}：双 hash 幂等判定纯函数（零 IO——derived 文本归调用方读取）。
 * - {@link evaluateCraftDistillGateSync}（便宜档，零文件 IO）/ {@link evaluateCraftDistillGate}
 *   （全量档，含 readFileSync+SHA256 执行体）两个包装：**invoke 同步循环只用便宜档**——N 份
 *   材料的派生读取/哈希不在 craft:distill-run handler 里跑（阻塞主进程）；全量档归 batch
 *   worker 异步路径（runCraftDistillBatch per-item）与 distillMaterial 内部判定。
 */

/** 资格检查核心：登记行存在 + 就绪态（ready/low-confidence 可蒸——章界挂起与蒸馏正交，F-09）。 */
function loadDistillableMaterial(
  materialId: string,
): { ok: true; material: Material } | { ok: false; reason: 'not-found' | 'not-ready'; message: string } {
  const material = getMaterialRow(materialId);
  if (material === null) return { ok: false, reason: 'not-found', message: '登记行不存在（或坏行）' };
  if (material.status !== 'ready' && material.status !== 'low-confidence') {
    return {
      ok: false,
      reason: 'not-ready',
      message: `材料未就绪（status=${material.status}——pending/failed 不可蒸馏）`,
    };
  }
  return { ok: true, material };
}

/**
 * 双 hash 门控判定（单源纯函数，零 IO——F-07 语义）：
 * - `proceed`：全量重蒸（无台账 / 原件 hash 变 / 前次 failed / 派生不可读〔distillMaterial
 *   后续报 missing-derived〕）。
 * - `skip-unchanged`：done + 双 hash 匹配 → 材料级幂等 skip（AC7）。
 * - `derived-changed`：done + 原件未变 + 派生 .md 变 → 讲法 stale 复核不重蒸（不烧 LLM）。
 */
export type CraftDistillHashGateDecision =
  | { action: 'proceed' }
  | { action: 'skip-unchanged' }
  | { action: 'derived-changed' };

export function decideCraftDistillHashGate(
  priorLedger: CraftDistillLedger | null,
  materialContentHash: string,
  derived: string | null,
): CraftDistillHashGateDecision {
  if (
    priorLedger === null ||
    priorLedger.status !== 'done' ||
    priorLedger.contentHash !== materialContentHash
  ) {
    return { action: 'proceed' };
  }
  if (derived === null) return { action: 'proceed' };
  return sha256Content(derived) === priorLedger.derivedHash
    ? { action: 'skip-unchanged' }
    : { action: 'derived-changed' };
}

type CraftDistillGateResult = { ok: true } | { ok: false; reason: CraftDistillSkipReason; message?: string };

/**
 * 蒸馏资格门·便宜档（**零文件 IO**——craft:distill-run invoke 同步循环专用，CR-2b-15）：
 * 在途槽 / 登记行 / 就绪态三项同步检查。双 hash 幂等判定（readFileSync+SHA256 执行体）**不
 * 在此跑**——已蒸馏未变更材料可能被本门放行入队，批内全量门/distillMaterial 判 hash-unchanged
 * 后跳过（逐材料结果回报；台账徽章读 distill-status 真相源，事件可丢）。
 */
export function evaluateCraftDistillGateSync(materialId: string): CraftDistillGateResult {
  if (inflightDistills.has(materialId)) return { ok: false, reason: 'already-running', message: '该材料正在蒸馏中' };
  const eligibility = loadDistillableMaterial(materialId);
  return eligibility.ok ? { ok: true } : { ok: false, reason: eligibility.reason, message: eligibility.message };
}

/**
 * 蒸馏资格门·全量档（含 readFileSync+SHA256——**batch worker 异步路径专用**，勿在 invoke
 * 同步循环调）：便宜档三项 + 双 hash 幂等判定（done 且双 hash 匹配 → `hash-unchanged`；
 * 派生变不在此拦——批内走讲法 stale 复核路径，对 UI 语义是「已处理」非跳过）。
 */
export function evaluateCraftDistillGate(materialId: string): CraftDistillGateResult {
  const cheap = evaluateCraftDistillGateSync(materialId);
  if (!cheap.ok) return cheap;
  const material = getMaterialRow(materialId);
  if (material === null) return { ok: false, reason: 'not-found', message: '登记行不存在（或坏行）' };
  const decision = decideCraftDistillHashGate(
    getCraftDistillLedger(materialId),
    material.contentHash,
    readDerivedTextForMaterial(material),
  );
  return decision.action === 'skip-unchanged'
    ? { ok: false, reason: 'hash-unchanged', message: '已蒸馏且原件与派生均未变更' }
    : { ok: true };
}

/** 认领在途槽（handler 通过门后同步占位——单线程同步段内 check+add 无竞态窗口；批量收尾释放）。 */
export function claimCraftDistillSlot(materialId: string): void {
  inflightDistills.add(materialId);
}

/** 测试缝：清在途槽（用例间隔离——spy runBatch 不释放占位的场景）。 */
export function __clearCraftDistillInflightForTest(): void {
  inflightDistills.clear();
}

/** 材料级失败档（distillMaterial never-throws 的失败回报面——'hash-unchanged' 是幂等 skip 非失败）。 */
type DistillFailReason = 'not-found' | 'not-ready' | 'missing-derived' | 'llm-unavailable' | 'failed';

export type DistillMaterialResult =
  | { ok: true; outcome: 'done'; ledger: CraftDistillLedger }
  | { ok: true; outcome: 'derived-stale-marked' }
  | { ok: false; reason: DistillFailReason | 'hash-unchanged'; message?: string };

/** 锚定通过的切条产物（claim 四件套 + 锚点 + 幂等键）。 */
interface AnchoredClaim {
  item: CraftClaimExtractionItem;
  anchor: CraftTeachingAnchor;
  teachingId: string;
}

/** 归类解析后的条目（termId 已解析——提案已物化为 pending 词目行载荷）。 */
interface ClaimEntry {
  anchored: AnchoredClaim;
  category: CraftCardCategory;
  termId: string;
  confidence: number;
}

/** 落卡动作（单事务内依次执行——F-04）。 */
type LandAction =
  | { kind: 'new-card'; card: CraftCard; vector: number[] | null; modelId: string | null }
  | { kind: 'append'; targetCardId: string; teaching: CraftTeaching; dispute: boolean }
  | { kind: 'review'; review: CraftMergeReview };

const EMPTY_STATS: CraftDistillStats = {
  claims: 0,
  anchored: 0,
  droppedNoAnchor: 0,
  droppedMalformed: 0,
  droppedNoCategory: 0,
  mergedAuto: 0,
  mergeReviews: 0,
  newCards: 0,
  disputes: 0,
};

/**
 * 卡招式名（title）蒸馏期派生：condensed 首句截 30 字——人审可改（schema 仅 min(1) 不锁形态）。
 * **单源导出**（CR-2b-18）：craftIpc merge-review-resolve independent 建卡同款消费（彼处曾有
 * 手抄副本「两处同步维护」——已删换本 import）。
 */
export function deriveCardTitle(condensed: string): string {
  const firstSentence = condensed.split(/[。！？!?\n]/)[0] ?? condensed;
  const base = firstSentence.length > 30 ? `${firstSentence.slice(0, 30)}…` : firstSentence;
  return base || condensed.slice(0, 30) || '未命名招式';
}

/**
 * 蒸馏一份材料（never-throws——一切失败态落台账 failed + 终态进度事件，批量继续；进度相位
 * extracting→categorizing→dedup→landing + 终态，design §0 运行可见性）。
 *
 * 台账双 hash 门控（F-07）：done + 双 hash 匹配 → skip（幂等）；done + 原件 hash 同 + 派生变
 * → **讲法 stale 复核不重蒸**（不烧 LLM）；其余（无台账/原件变/前次 failed）→ 全量重蒸（旧
 * 讲法在落卡事务内标 stale）。
 */
export async function distillMaterial(materialId: string, deps: CraftDistillDeps = {}): Promise<DistillMaterialResult> {
  const notify = deps.notify ?? sendCraftDistillProgress;
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  let currentPhase: CraftDistillPhase | null = null;
  const emit = (status: CraftDistillProgressEvent['status'], phase: CraftDistillPhase | null, error?: string): void => {
    // 终态（done/failed）清相位——ticker 不再重发（belt：finally clearInterval 双保险）。
    currentPhase = status === 'running' ? phase : null;
    notify({
      materialId,
      status,
      phase,
      elapsedMs: Date.now() - startedAt,
      ...(error !== undefined ? { error } : {}),
    });
  };
  // CR-2b-5 相位内周期发射：只靠相位切换发事件会让 3 分钟切条全程显示 0s——相位内按 tick
  // 重复发 running 事件（同相位 elapsedMs 递增）；无相位（skip/未开跑段）不发电不空转。
  const ticker = setInterval(
    () => {
      if (currentPhase !== null) emit('running', currentPhase);
    },
    deps.progressTickMs ?? CRAFT_DISTILL_PROGRESS_TICK_MS,
  );
  try {
    return await runDistillMaterial(materialId, deps, now, emit);
  } catch (err) {
    // belt never-throws：out-of-contract 抛错也落 failed 台账（重跑干净起板——落卡单事务未触达）。
    getLogger().warn({ err: errMsg(err), materialId }, 'craft distill: material threw - landing failed ledger');
    const material = getMaterialRow(materialId);
    try {
      upsertCraftDistillLedger({
        materialId,
        contentHash: material?.contentHash ?? UNKNOWN_HASH,
        derivedHash: UNKNOWN_HASH,
        status: 'failed',
        stats: EMPTY_STATS,
        phase: null,
        error: `蒸馏异常中断：${errMsg(err)}`,
        distilledAt: null,
      });
    } catch {
      // 双重失败（连台账都写不进）——只剩日志。
    }
    emit('failed', null, `蒸馏异常中断：${errMsg(err)}`);
    return { ok: false, reason: 'failed', message: errMsg(err) };
  } finally {
    clearInterval(ticker);
  }
}

async function runDistillMaterial(
  materialId: string,
  deps: CraftDistillDeps,
  now: () => Date,
  emit: (status: CraftDistillProgressEvent['status'], phase: CraftDistillPhase | null, error?: string) => void,
): Promise<DistillMaterialResult> {
  // 资格 + 双 hash 判定全走单源 helper（CR-2b-15——与 gate 链零手抄漂移）。
  const eligibility = loadDistillableMaterial(materialId);
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason, message: eligibility.message };
  const material = eligibility.material;
  const priorLedger = getCraftDistillLedger(materialId);
  const derived = readDerivedTextForMaterial(material);
  const hashDecision = decideCraftDistillHashGate(priorLedger, material.contentHash, derived);

  // 双 hash 门控分支①：done + 原件未变 + 派生未变 → 幂等 skip。
  if (hashDecision.action === 'skip-unchanged') {
    return { ok: false, reason: 'hash-unchanged', message: '已蒸馏且原件与派生均未变更' };
  }

  // 台账草稿（失败态也要有行可落——missing-derived 用 UNKNOWN 哨兵）。
  const draft: CraftDistillLedger = {
    materialId,
    contentHash: material.contentHash,
    derivedHash: derived !== null ? sha256Content(derived) : UNKNOWN_HASH,
    status: 'running',
    stats: { ...EMPTY_STATS },
    phase: null,
    error: null,
    distilledAt: null,
  };
  const stats = draft.stats;
  const fail = (reason: DistillFailReason, message: string): { ok: false; reason: DistillFailReason; message: string } => {
    upsertCraftDistillLedger({ ...draft, status: 'failed', phase: null, error: message });
    emit('failed', null, message);
    return { ok: false, reason, message };
  };

  // 双 hash 门控分支②：done + 原件未变 + 派生已变 → 讲法 stale 复核（F-07：不自动重蒸烧 LLM）。
  // （'derived-changed' 判定隐含 priorLedger/derived 非 null——单源 helper 内的语义，此处显式
  //  条件仅为 TS 局部收窄，行为等价。）
  if (hashDecision.action === 'derived-changed' && priorLedger !== null && derived !== null) {
    markCraftTeachingsStaleByMaterial(materialId);
    const note = '派生 .md 已变更（校对编辑）：旧讲法已标 stale 待人审复核，未重新蒸馏（锚定基面已变，引文快照仍可回看）。';
    upsertCraftDistillLedger({
      ...draft,
      derivedHash: sha256Content(derived),
      status: 'done',
      phase: null,
      error: note,
      distilledAt: priorLedger.distilledAt,
    });
    // 不发进度事件（未蒸馏——台账徽章读 distill-status；事件面留给真蒸馏运行）。
    return { ok: true, outcome: 'derived-stale-marked' };
  }

  const generate = deps.generateText ?? llmCore?.generateText;
  if (generate === undefined) {
    return fail('llm-unavailable', '蒸馏 LLM 内核未装配（craftDistillLlmCore 未接线）——已挂起，装配后重试。');
  }
  if (derived === null) {
    return fail('missing-derived', '派生 .md 读取失败（缺失或车道不可解析）——请先重摄取材料。');
  }
  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    return fail('failed', '材料无有效段落（派生 .md 全空白）——不可蒸馏。');
  }
  const blockChapter = buildBlockChapterMap(blocks, material.chapters);
  /** 前次蒸馏存在（原件变/前次 failed）→ 落卡事务内先标旧讲法 stale（重蒸语义）。 */
  const reDistill = priorLedger !== null;

  // ── 相位①：切条（extracting）──
  draft.phase = 'extracting';
  upsertCraftDistillLedger(draft);
  emit('running', 'extracting');

  const anchoredList: AnchoredClaim[] = [];
  const seenTeachingIds = new Set<string>();
  for (const segment of buildExtractSegments(blocks, material.chapters)) {
    const user = buildClaimExtractionUserPrompt(derived, blocks, segment, material);
    let text = '';
    let finishReason: GenerationFinishReason | undefined;
    try {
      const response = await generate({
        slot: 'extraction',
        system: CLAIM_EXTRACTION_SYSTEM_PROMPT,
        user,
        maxTokens: CLAIM_EXTRACTION_MAX_TOKENS,
      });
      text = (response?.text ?? '').trim();
      finishReason = response?.finishReason;
    } catch (err) {
      return fail('failed', `切条调用失败：${errMsg(err)}`);
    }
    // CR-2 权威停因：'length' = 输出被 token 上限掐断——材料级挂起（不落半程主张，保义红线）。
    if (finishReason === 'length') {
      return fail('failed', '切条输出因 token 上限截断（finishReason=length）——已挂起，不落半程产物。');
    }
    if (!text) return fail('failed', '切条返回空回复——已挂起。');
    const arr = parseJsonLoose(text, '[', ']');
    if (!Array.isArray(arr)) return fail('failed', '切条输出不可解析为 JSON 数组——整体拒收（不硬给切条）。');
    for (const raw of arr) {
      const parsed = craftClaimExtractionItemSchema.safeParse(raw);
      if (!parsed.success) {
        // 条目级容错（mirror 候选行纪律但条目级）：坏形状丢该条 + droppedMalformed 计数
        // （CR-2b-12 口径拆分——坏形状 ≠ 无锚，锚定通过率不失真；幻觉闸门族——无有效主张即无锚）。
        stats.droppedMalformed += 1;
        continue;
      }
      stats.claims += 1;
      const item = parsed.data;
      const s = item.paraRange.start;
      const e = item.paraRange.end;
      // 约束式核验：paraRange 须落在该片段注入的全局段落范围内（集外 = 幻觉位置，丢该条）。
      if (!(s >= segment.blockStart && e <= segment.blockEnd && s < e)) {
        stats.droppedNoAnchor += 1;
        continue;
      }
      const spanStart = blocks[s]!.start;
      const spanEnd = blocks[e - 1]!.end;
      // 锚定核验：quote 须为 span 内子串（空白归一容忍——LLM 引文空白抖动不误杀）。
      if (!isQuoteInSpan(item.quote, derived.slice(spanStart, spanEnd))) {
        stats.droppedNoAnchor += 1;
        continue;
      }
      stats.anchored += 1;
      const teachingId = teachingIdFor(materialId, material.contentHash, item.quote);
      // 批内幂等键去重（F-04 belt——同引文两条只落一次）。
      if (seenTeachingIds.has(teachingId)) continue;
      seenTeachingIds.add(teachingId);
      anchoredList.push({
        item,
        anchor: { chapterIndex: blockChapter[s]!, charStart: spanStart, charEnd: spanEnd, paraStart: s, paraEnd: e },
        teachingId,
      });
    }
  }
  if (stats.claims > MAX_CLAIMS_PER_MATERIAL) {
    return fail(
      'failed',
      `切条主张数 ${stats.claims} 超过上限 ${MAX_CLAIMS_PER_MATERIAL}——为避免静默截断已挂起（材料可能异常，请人工检查）。`,
    );
  }

  // ── 相位②：归类（categorizing）──
  draft.phase = 'categorizing';
  upsertCraftDistillLedger(draft);
  emit('running', 'categorizing');

  const activeTerms = listCraftTerms({ status: 'active' });
  const pendingTermsToInsert: CraftTerm[] = [];
  const resolvedProposals = new Map<string, CraftTerm>();
  const claimEntries: ClaimEntry[] = [];
  const droppedNoCategorySummaries: string[] = [];
  for (const anchored of anchoredList) {
    const categorization = await categorizeClaim(anchored.item, activeTerms, generate, material);
    if (categorization.kind === 'fail') {
      // CR-2b-2 per-claim 降级：单条病理性归类（两次越界/不可解析）只丢该条——不炸整材料
      // （原样材料级 failed 会永久卡死 + 重试重烧全部 LLM），mirror 无锚即丢哲学：不编造
      // 词目名，drop + 计数 + 台账 note 列明丢条目摘要；其余主张照常落卡。
      stats.droppedNoCategory += 1;
      droppedNoCategorySummaries.push(anchored.item.condensed.slice(0, 20));
      getLogger().warn(
        { materialId, claim: anchored.item.condensed.slice(0, 40), reason: categorization.message },
        'craft distill: claim categorization failed - dropping claim (material continues)',
      );
      continue;
    }
    let category: CraftCardCategory;
    let termId: string;
    if (categorization.kind === 'known') {
      category = categorization.category;
      termId = categorization.termId;
    } else {
      // 提案 → pending 词目行（find-first 复用：同 (category,name) 既有行不重插；merged 墓碑
      // 链跟随到最终活词目——CR-2b-9 单源 helper，A→B→C 链后命中墓碑 A 挂 C 不挂死词目）。
      const key = `${categorization.category}\0${categorization.name}`;
      let term = resolvedProposals.get(key) ?? findCraftTermByName(categorization.category, categorization.name);
      if (term === null) {
        term = {
          termId: proposedCraftTermId(categorization.category, categorization.name),
          category: categorization.category,
          name: categorization.name,
          status: 'pending',
          mergedInto: null,
          note: '蒸馏管线归类提案（词表外命中，待人审核准/归并）',
        };
        resolvedProposals.set(key, term);
        pendingTermsToInsert.push(term);
      } else {
        term = resolveTermTombstone(term.termId) ?? term;
      }
      category = term.category;
      termId = term.termId;
    }
    claimEntries.push({ anchored, category, termId, confidence: categorization.confidence });
  }

  // ── 相位③：去重（dedup）──
  draft.phase = 'dedup';
  upsertCraftDistillLedger(draft);
  emit('running', 'dedup');

  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbedOne;
  const model = resolveModel();
  const db = getDb();
  const vecAvailable = isSqliteVecAvailable();
  const vecDim = getCurrentCraftVecDim(db);
  let dedupOffReason: string | null = null;
  if (model === null) {
    dedupOffReason = '去重不可用（未配置 embedding 模型）——全部按新建卡落库，人审时请留意重复主张';
  } else if (!vecAvailable || vecDim === null) {
    dedupOffReason = '去重不可用（sqlite-vec 未加载或向量表维度未知）——全部按新建卡落库，人审时请留意重复主张';
  } else if (shouldSkipForModelMismatch(resolvePrevailingCraftVectorModel(db), model.modelId)) {
    dedupOffReason = '去重不可用（向量模型与存量不一致——请先运行 craft 索引重建迁移）——全部按新建卡落库';
  }

  const landActions: LandAction[] = [];
  /**
   * 批内新建卡向量（同材料相似主张互去重——落卡前卡不在 vec 表，内存比对补盲）+
   * 批内已排程卡登记（CR-2b-8：批内卡未落库时 getCraftCardRow 回查 null ≠ 被删——落卡事务
   * 内 new-card action 先执行，同事务 append/review 行指向它可达）。
   */
  const batchVectors: Array<{ cardId: string; vector: number[] }> = [];
  const scheduledBatchCards = new Map<string, CraftCard>();
  for (const entry of claimEntries) {
    const { item, anchor, teachingId } = entry.anchored;
    const condensed = item.condensed;
    let vector: number[] | null = null;
    if (dedupOffReason === null && model !== null) {
      try {
        const arr = await embed(model, condensed);
        if (arr.length === vecDim) vector = arr;
        else vector = null; // dim 不符——该条按无向量处理（卡 claim 向量 pending）
      } catch (err) {
        getLogger().warn({ err: errMsg(err), materialId }, 'craft distill: claim embed failed - vector pending');
        vector = null;
      }
    }
    let best: { cardId: string; similarity: number } | null = null;
    if (vector !== null) {
      for (const b of batchVectors) {
        const sim = cosineSimilarity(vector, b.vector);
        if (best === null || sim > best.similarity) best = { cardId: b.cardId, similarity: sim };
      }
      if (vecAvailable) {
        try {
          for (const hit of knnClaimSimilarities(vector)) {
            if (best === null || hit.similarity > best.similarity) best = hit;
          }
        } catch (err) {
          getLogger().warn({ err: errMsg(err), materialId }, 'craft distill: claim KNN failed - degrading to new card');
        }
      }
    }
    // CR-2b-8：命中卡回查一次——db 行在（常态）或批内已排程卡（同事务先落，append 可达）；
    // 两者皆无 = 命中卡 mid-run 被删（vec/卡行漂移的罕见竞态）→ 降「新建卡」档，不建指向
    // 已删卡的 review 行（死行 resolve not-found / UI 右栏空转）。
    let existingRow: CraftCardRow | null = null;
    let existingCondensed: string | null = null;
    if (best !== null) {
      existingRow = getCraftCardRow(best.cardId);
      if (existingRow !== null) {
        existingCondensed = existingRow.card.claim.condensed;
      } else {
        const batchCard = scheduledBatchCards.get(best.cardId);
        if (batchCard !== undefined) {
          existingCondensed = batchCard.claim.condensed;
        } else {
          getLogger().warn(
            { materialId, cardId: best.cardId },
            'craft distill: KNN hit card missing (deleted mid-run) - downgrading to new card',
          );
          best = null;
        }
      }
    }
    const teachingBase = {
      teachingId,
      materialId,
      materialContentHash: material.contentHash,
      author: material.provenance.author,
      quote: item.quote,
      anchor,
      rank: 'normal' as const,
      stale: false,
    };
    if (best !== null && existingCondensed !== null && best.similarity >= DEDUP_AUTO_SIMILARITY) {
      // 冲突判定（review-judge 档）：语义相反 → dispute 标记 + 讲法 note（R4——分歧不裁决）。
      // CR-2b-13：判定失败（LLM 不可用/输出坏）note 诚实标注「分歧判定不可用」——不写暗示
      // 已检查的「自动挂候选」（judgeDispute never-throws 返 null 的三态在此分家）。
      const verdict = await judgeDispute(existingCondensed, condensed, generate);
      const dispute = verdict?.dispute === true;
      if (dispute) stats.disputes += 1;
      const teaching: CraftTeaching = {
        ...teachingBase,
        note: dispute
          ? `疑似分歧（LLM 判定）：${verdict!.reason}`
          : verdict !== null
            ? `相似度 ${best.similarity.toFixed(3)} 自动挂候选（LLM 判定无分歧）`
            : `相似度 ${best.similarity.toFixed(3)} 自动挂候选——分歧判定不可用（LLM 失败），人审请留意语义冲突`,
      };
      landActions.push({ kind: 'append', targetCardId: best.cardId, teaching, dispute });
      stats.mergedAuto += 1;
      continue;
    }
    if (best !== null && existingCondensed !== null && best.similarity >= DEDUP_REVIEW_SIMILARITY) {
      const verdict = await judgeDispute(existingCondensed, condensed, generate);
      if (verdict?.dispute === true) stats.disputes += 1;
      const review: CraftMergeReview = {
        reviewId: `mrev-${randomBytes(6).toString('hex')}`,
        newClaim: {
          claim: {
            condensed: item.condensed,
            points: item.points,
            scenarios: item.scenarios,
            counterexamples: item.counterexamples,
          },
          quote: item.quote,
          anchor,
          materialId,
          materialContentHash: material.contentHash,
          author: material.provenance.author,
          category: entry.category,
          termId: entry.termId,
          tags: item.tags,
          confidence: entry.confidence,
        },
        existingCardId: best.cardId,
        similarity: clamp01(best.similarity),
        // CR-2b-D1（拍板 a 案）：verdict 随 review 行持久化——并排人审可见 LLM 预判提示。
        // 可选键二态：在场 = 判定成功（dispute 真假均可能）；缺省 = 判定不可用（LLM 失败）。
        ...(verdict !== null ? { disputeHint: { dispute: verdict.dispute, reason: verdict.reason } } : {}),
        resolution: null,
        createdAt: now().toISOString(),
      };
      landActions.push({ kind: 'review', review });
      stats.mergeReviews += 1;
      continue;
    }
    // 新建卡（<0.85 或无相似命中或去重不可用）——pending_review 起板，无 entry 检索行（F-06）。
    const nowIso = now().toISOString();
    const card: CraftCard = {
      cardId: `card-${randomBytes(6).toString('hex')}`,
      category: entry.category,
      termId: entry.termId,
      title: deriveCardTitle(condensed),
      claim: {
        condensed: item.condensed,
        points: item.points,
        scenarios: item.scenarios,
        counterexamples: item.counterexamples,
      },
      tags: item.tags,
      teachings: [{ ...teachingBase, note: null }],
      dispute: false,
      status: 'pending_review',
      rejectReason: null,
      confidence: entry.confidence,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    landActions.push({ kind: 'new-card', card, vector, modelId: vector !== null && model !== null ? model.modelId : null });
    scheduledBatchCards.set(card.cardId, card);
    if (vector !== null) batchVectors.push({ cardId: card.cardId, vector });
    stats.newCards += 1;
  }

  // ── 相位④：落卡（landing——每材料单事务，F-04）──
  draft.phase = 'landing';
  upsertCraftDistillLedger(draft);
  emit('running', 'landing');

  const landedAt = now().toISOString();
  // 台账 note 合成（ledger.error 双职——失败/挂起原因 + 诚实 note 落此，W1 契约注记）：
  // 归类丢条摘要（CR-2b-2，上限 5 条防长材料刷屏）+ 去重不可用降级 note。
  const ledgerNotes: string[] = [];
  if (droppedNoCategorySummaries.length > 0) {
    const shown = droppedNoCategorySummaries.slice(0, 5).join(' / ');
    const ellipsis = droppedNoCategorySummaries.length > 5 ? ' 等' : '';
    ledgerNotes.push(
      `${droppedNoCategorySummaries.length} 条主张归类失败已丢弃（${shown}${ellipsis}）——词表校准后可重蒸找回`,
    );
  }
  if (dedupOffReason !== null) ledgerNotes.push(dedupOffReason);
  db.transaction(() => {
    for (const term of pendingTermsToInsert) insertCraftTerm(term);
    if (reDistill) markCraftTeachingsStaleByMaterial(materialId); // 原件变更重蒸：旧讲法 stale 与新落卡同事务
    for (const action of landActions) {
      if (action.kind === 'new-card') {
        // 预嵌向量直落（去重段已 embed——同形状向量即落卡向量，无二次调用）。
        insertCraftCardRowSync(action.card, { vector: action.vector, modelId: action.modelId });
      } else if (action.kind === 'append') {
        const res = appendCraftTeaching(action.targetCardId, action.teaching); // teachingId 幂等键命中 → no-op
        if (!res.ok) throw new Error(`讲法挂载失败（${action.targetCardId}: ${res.error}）——整体回滚`);
        if (action.dispute) {
          // 分歧标记（挂讲法已降级卡回 pending_review——dispute 位随同事务置位，编辑即降级语义不破）。
          db.prepare('UPDATE closure_craft_card SET dispute=1, updated_at=? WHERE card_id=?').run(
            now().toISOString(),
            action.targetCardId,
          );
        }
      } else {
        insertCraftMergeReview(action.review);
      }
    }
    upsertCraftDistillLedger({
      ...draft,
      status: 'done',
      phase: null,
      error: ledgerNotes.length > 0 ? ledgerNotes.join('；') : null,
      distilledAt: landedAt,
    });
  })();

  const finalLedger = getCraftDistillLedger(materialId);
  emit('done', null);
  return finalLedger === null
    ? { ok: true, outcome: 'done', ledger: { ...draft, status: 'done', phase: null, distilledAt: landedAt } }
    : { ok: true, outcome: 'done', ledger: finalLedger };
}

/** 引文子串判定（空白归一——stripWhitespace 后包含即命中；空引文（全空白）不命中）。 */
function isQuoteInSpan(quote: string, spanText: string): boolean {
  const q = stripWhitespace(quote);
  return q.length > 0 && stripWhitespace(spanText).includes(q);
}

/**
 * 批量蒸馏（craft:distill-run 后台队列 + 测试直入口）：逐材料串行（API 并发纪律——切条/归类/
 * 去重三缝单材料内本就串行）；never-throws per-item（单材料失败落台账继续，mirror backfill
 * CR-018）。在途守卫：已认领（handler 门后占位）直接执行；未认领先过门（拒绝项跳过）。返回
 * 逐材料结果（按处理序）。
 */
export async function runCraftDistillBatch(
  materialIds: readonly string[],
  deps: CraftDistillDeps = {},
): Promise<DistillMaterialResult[]> {
  const results: DistillMaterialResult[] = [];
  for (const materialId of materialIds) {
    if (!inflightDistills.has(materialId)) {
      const gate = evaluateCraftDistillGate(materialId);
      if (!gate.ok) continue;
      inflightDistills.add(materialId);
    }
    try {
      results.push(await distillMaterial(materialId, deps));
    } catch (err) {
      // belt（distillMaterial 自身 never-throws——此层防御测试注入 deps 抛错的场景）。
      getLogger().warn({ err: errMsg(err), materialId }, 'craft distill batch: item threw - continuing');
      results.push({ ok: false, reason: 'failed', message: errMsg(err) });
    } finally {
      inflightDistills.delete(materialId);
    }
  }
  return results;
}
