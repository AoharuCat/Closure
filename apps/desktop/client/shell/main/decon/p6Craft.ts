import { randomBytes } from 'node:crypto';
import type {
  CraftCard,
  CraftCardCategory,
  CraftMergeReview,
  CraftTerm,
  CraftTeaching,
  DeconJob,
  DeconProgressEvent,
  Material,
  ResolvedModel,
} from '@orison/shared-contracts';
import {
  craftCardCategorySchema,
  deconFindingsSchema,
  formatCraftCardCategories,
  type DeconFindings,
  type DeconSpan,
} from '@orison/shared-contracts';
import { getDb } from '../db/index';
import { getDeconPassState, listDeconProducts, upsertDeconPassState } from '../db/closure-decon';
import {
  appendCraftTeaching,
  embedClaimCondensed,
  getCraftCardRow,
  insertCraftCardRowSync,
  listCraftTeachingIdsByMaterial,
  resolvePrevailingCraftVectorModel,
  type CraftCardIndexDeps,
} from '../db/closureCraftCardRepository';
import {
  findCraftTermByName,
  insertCraftTerm,
  listCraftTerms,
  proposedCraftTermId,
} from '../db/closureCraftTermRepository';
import {
  insertCraftMergeReview,
  listCraftMergeReviews,
} from '../db/closureCraftMergeReviewRepository';
import { getMaterialRow } from '../db/materialIndexer';
import { getLogger } from '../logger';
import {
  splitParagraphBlocks,
  type MaterialParagraphBlock,
} from '../ipc/toolHandlers/materialIngest';
import {
  DEDUP_AUTO_SIMILARITY,
  DEDUP_REVIEW_SIMILARITY,
  cosineSimilarity,
  deriveCardTitle,
  knnClaimSimilarities,
  resolveTermTombstone,
  teachingIdFor,
} from '../ipc/toolHandlers/craftDistillPipeline';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { isSqliteVecAvailable } from '../db/sqliteVecLoader';
import { getCurrentCraftVecDim } from '../db/craftVecDim';
import { shouldSkipForModelMismatch } from '../db/closureIndexer';
import {
  DECON_STALE_NOTE,
  capDeconUnit,
  checkDeconRunBoundary,
  deconErrMsg,
  failDeconUnit,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  runDeconLlmCall,
  sha256DeconContent,
  writeDeconPassState,
  type DeconBoundaryStop,
} from './deconRun';
import { getDeconLlmCore, type DeconGenerateText } from './deconLlmCore';
import { decideDeconPassReentry, extractMaterialId, transitionDeconJob } from './deconJob';
import { isQuoteInSpan, type DeconParaRange } from './p1Extract';
import { hashDeconProductOutput } from './p3Label';

// ── E10.3b（task 09-05）W5：P6 craft 落卡（child B design §5——10.2 管线 additive 扩展）──
//
// 拆书手艺发现直落全局手艺库：product 表全部 `p4:<dim>`（非 style）findings 中 craftHint≠null
// 者 → 逐候选 LLM 约束式归类+浓缩（13 大类受控注入 formatCraftCardCategories() + condensed
// 四件套 + active 词目清单内选/提案）→ **dedup 三档分流**（embedClaimCondensed〔deps 注入
// embed 缝，mirror repository DI〕→ knnClaimSimilarities + 批内向量比对——≥DEDUP_AUTO 挂既有
// 卡候选 / 中档进 merge-review 人审裁并 / <DEDUP_REVIEW 新建卡；无 embed 模型 → 全部新建 +
// 诚实 note）→ **分批落库（CR-6）**：候选按 DECON_P6_BATCH_SIZE 逐批独立事务落（pending 词目
// + 卡/讲法/review 行 + 批内向量），无候选数硬上限——批失败只挂该批（计数继续下一批，已落批
// 保留）；边界停走回写 pass_state pending（CR-22）+ 已落 teachingId 幂等面续跑零重付。
//
// - **slot = extraction（温 0）**——归类+浓缩是判别面（与 P1a 候选分类同族），非创作。
// - **teaching 构造**：quote=evidence[0].quote（锚定单源）、anchor=对应 span（deconSpan 与
//   craftTeachingAnchor 同基同形——A 已统一，零转换）、originKind='decon_instance'、bookTitle=
//   材料登记名、evidence={anchors（呼应证据锚点族）, level（≥2 锚=strong）, derivedHash（派生
//   指纹——校对后锚点漂移的查询侧提示面）}；**teachingId 复用 teachingIdFor(materialId,
//   materialContentHash, quote)**（确定性派生——appendCraftTeaching 幂等键命中 no-op 零重复）。
// - **锚点终验**（P6 侧最后一道，无锚即丢）：落卡前纯代码验证 evidence 锚点 span 存在于原文
//   （P1c 幻觉过滤同机制复用——paraRange→span 边界 + isQuoteInSpan 引文匹配）；evidence[0]
//   不过验 → 整条候选丢（主锚 broken），其余证据逐条过滤进 evidence.anchors。
// - **状态恒 pending_review**（R3 红线全量人过，禁自动 verify）；风格维不落 craft 卡（p4:style
//   排除在候选源外）。
// - 断点/capped/边界/cost/notify 全链 mirror p3Label；重跑幂等（候选集 hash + teachingId 双保险）。
//
// 范式判据（parent design §9 P6 行）：归类候选/浓缩 = LLM 约束式缝；落卡事务 / 幂等 / 去重
// 相似度算数 / 三档分流 / 锚点终验 = 纯代码。
//
// expected_downstream_consumers:
// - deconIpc phases（design §9 序尾——手艺维非空时挂 p6 步；运行面候选判定在本 runner）。
// - W6 拆书页 craft 条目跳转（10.2 人审页消费——卡上 originKind/bookTitle 来源徽章）。

// ── 常量（推测值起步——dogfood 首本标定）──

/**
 * 单候选归类+浓缩输出 token 预算（**独立核算**——E10.2a CR-2 纪律）：小 JSON（四件套 +
 * 归类三字段），中文主张 ~100-300 字 ≈ 200 tokens 内，2048 含余量。截断由 finishReason=
 * 'length' 权威判定（condensed 是语义面——半程主张不可续，failed 诚实挂起 mirror p1b/p4）。
 */
export const DECON_P6_CONDENSE_MAX_TOKENS = 2_048;

/**
 * 落库批大小（CR-6 分批落库）：候选按批逐批独立事务落卡——**无候选数硬上限**（deep 档合法
 * 大书可超 200 craftHint findings，旧 200 硬 ceiling 会烧完全部预算后整 job failed、零部分
 * 落地）；批大小只控单事务体量，超大批自然多分批全落。批失败只挂该批（batchesFailed 计数
 * 继续下一批——已落批保留，重试只重付失败批候选）。
 */
export const DECON_P6_BATCH_SIZE = 50;

// ── 候选集（纯函数——product 表读回 + teachingId 确定性派生）──

/** 一条落卡候选（craftHint≠null 的 finding + 确定性幂等键）。 */
export interface DeconP6Candidate {
  /** 来源手艺维（pass 尾——人审分组呈现面）。 */
  dimensionId: string;
  /** 来源 unit（ch:N / arc:N）。 */
  unit: string;
  insight: string;
  elaboration: string;
  evidence: DeconFindings['findings'][number]['evidence'];
  craftHint: NonNullable<DeconFindings['findings'][number]['craftHint']>;
  /** teachingIdFor(materialId, materialContentHash, evidence[0].quote)——重跑幂等键。 */
  teachingId: string;
}

/**
 * 收集落卡候选（纯函数，确定性序 = listDeconProducts 的 pass/unit 升序）：p4:<dim>（style
 * 排除——风格维不落 craft 卡）findings 中 craftHint≠null 者；teachingId 批内去重（F-04 belt
 * ——同引文两条只落一次）。findingsWithoutHint = 无 hint 的 findings 计数（观测面——非失败）。
 */
export function collectDeconP6Candidates(
  jobId: string,
  materialId: string,
  materialContentHash: string,
): { candidates: DeconP6Candidate[]; findingsWithoutHint: number } {
  const candidates: DeconP6Candidate[] = [];
  const seen = new Set<string>();
  let findingsWithoutHint = 0;
  for (const row of listDeconProducts(jobId)) {
    if (!row.pass.startsWith('p4:') || row.pass === 'p4:style') continue;
    const parsed = deconFindingsSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    for (const finding of parsed.data.findings) {
      if (finding.craftHint === null) {
        findingsWithoutHint += 1;
        continue;
      }
      const quote = finding.evidence[0]?.quote;
      if (quote === undefined) continue; // schema evidence ≥1 保证不可达——防御
      const teachingId = teachingIdFor(materialId, materialContentHash, quote);
      if (seen.has(teachingId)) continue;
      seen.add(teachingId);
      candidates.push({
        dimensionId: row.pass.slice('p4:'.length),
        unit: row.unit,
        insight: finding.insight,
        elaboration: finding.elaboration,
        evidence: finding.evidence,
        craftHint: finding.craftHint,
        teachingId,
      });
    }
  }
  return { candidates, findingsWithoutHint };
}

/**
 * P6 产物 hash（候选 teachingId 集的有序序列化——断点重入比对面）。findings 产物稳定（p4
 * 自带 output_hash 门控）→ 候选集确定性 → hash 稳定；done + hash 一致 = 落卡已完成的台账。
 */
export function hashDeconP6Output(teachingIds: readonly string[]): string {
  return hashDeconProductOutput([...teachingIds].sort());
}

// ── 锚点终验（纯函数——paraRange→span 映射 + 引文匹配双核验）──

/**
 * evidence paraRange（全局段号半开区间）→ craftTeachingAnchor 同形 span（mirror 10.2
 * buildBlockChapterMap 的章归属：块 start 落章 char span 内；零章/未命中恒 0——anchor 契约）。
 * 集外（越 blocks 界 / 退化区间）→ null（编造 span）。
 */
export function deconP6EvidenceSpan(
  paraRange: DeconParaRange,
  blocks: readonly MaterialParagraphBlock[],
  chapters: ReadonlyArray<{
    index: number;
    charStart: number;
    charEnd: number;
  }>,
): DeconSpan | null {
  const { start, end } = paraRange;
  if (!(start >= 0 && end > start && end <= blocks.length)) return null;
  const charStart = blocks[start]!.start;
  const charEnd = blocks[end - 1]!.end;
  if (charEnd <= charStart) return null;
  let chapterIndex = 0;
  for (const ch of chapters) {
    if (charStart >= ch.charStart && charStart < ch.charEnd) {
      chapterIndex = ch.index;
      break;
    }
  }
  return { chapterIndex, charStart, charEnd, paraStart: start, paraEnd: end };
}

/**
 * 候选锚点终验（纯函数——P6 侧最后一道，无锚即丢）：逐 evidence 映射 span + isQuoteInSpan
 * 引文匹配（P1c 幻觉过滤同机制复用）；不过验的证据不进 evidence.anchors（计数）。**主锚 =
 * 首个过验证据的 span**（quote=evidence[0] 锚定单源——evidence[0] 本身不过验 → 整条候选丢，
 * 返回 null）。
 */
export function verifyDeconP6Anchors(
  candidate: DeconP6Candidate,
  blocks: readonly MaterialParagraphBlock[],
  chapters: ReadonlyArray<{
    index: number;
    charStart: number;
    charEnd: number;
  }>,
  derived: string,
): {
  mainAnchor: DeconSpan;
  anchors: DeconSpan[];
  droppedEvidence: number;
} | null {
  const anchors: DeconSpan[] = [];
  let dropped = 0;
  let mainAnchor: DeconSpan | null = null;
  for (const ev of candidate.evidence) {
    const span = deconP6EvidenceSpan(ev.paraRange, blocks, chapters);
    if (span === null || !isQuoteInSpan(ev.quote, derived.slice(span.charStart, span.charEnd))) {
      dropped += 1;
      continue;
    }
    if (mainAnchor === null) mainAnchor = span;
    anchors.push(span);
  }
  if (mainAnchor === null) return null;
  return { mainAnchor, anchors, droppedEvidence: dropped };
}

// ── prompt 装配（纯函数——约束式：13 大类受控 + active 词目清单内选/提案）──

export const DECON_P6_SYSTEM_PROMPT = [
  '你是拆书手艺发现的落卡整理器。把一条拆书发现（对某本书写作手艺的观察结论）整理成手艺库的卡主张，并归入受控词表。',
  formatCraftCardCategories(),
  '词目规则：',
  '- 优先从输入给出的 active 词目清单中选最贴合的词目：输出 "termId" 填清单内词目 id；category 必须与所选词目的大类一致；清单外的 termId 不被接受（会降级转待人审的词目提报流程）。',
  '- 清单内确实没有合适词目时才提新词目：输出 "proposedTerm":{"category":"<13类内slug>","name":"<简短中文词目名>"}；大类只能取 13 类之一，禁自造类目。',
  '主张四件套：',
  '- condensed：把发现的洞察改写成写手可直接执行的写作主张——保留原发现的精神与关键信息，写成「怎么做」的表述；发现里没有的内容不写进去；',
  '- points：操作要点（发现里有才写，没有给空数组）；',
  '- scenarios：适用场景（同上）；',
  '- counterexamples：反例/常见误用（同上）；',
  '- tags：自由标签（可参考输入里的落卡提示标签）；',
  '- confidence：你对归类的置信度（0-1 小数），只用于人审队列排序，不会被自动采纳。',
  '输出一个 JSON 对象：{"category":"…","termId":"…"（或 "proposedTerm":{…}）,"condensed":"…","points":[…],"scenarios":[…],"counterexamples":[…],"tags":[…],"confidence":0.8}',
  '只输出 JSON，不要任何其他文字。',
].join('\n');

export interface DeconP6UserPromptInput {
  bookTitle: string;
  candidate: DeconP6Candidate;
  activeTerms: readonly CraftTerm[];
  /** 越界重试的矫正注记（attempt>0 时 true——mirror 10.2 buildCategorizationUserPrompt corrective）。 */
  corrective: boolean;
}

/** 逐候选 user prompt（材料信息 + 发现 + 证据引文 + 落卡提示预注 + active 词目清单）。 */
export function buildDeconP6UserPrompt(input: DeconP6UserPromptInput): string {
  const hint = input.candidate.craftHint;
  const evidenceLines = input.candidate.evidence.map(
    (e) => `- 「${e.quote}」（段落 P${e.paraRange.start}–P${e.paraRange.end - 1}）`,
  );
  return [
    '【材料信息】',
    `书名：${input.bookTitle}（拆书来源——主张的证据来自这本书）`,
    '',
    '【待整理的拆书发现】',
    `结论：${input.candidate.insight}`,
    `展开：${input.candidate.elaboration}`,
    '证据引文：',
    ...evidenceLines,
    '',
    '【落卡提示（上游分析的归类建议——供参考，最终归类由你判）】',
    `- 建议大类：${hint.category ?? '（无）'}`,
    `- 词目提示：${hint.termHint ?? '（无）'}`,
    `- 标签：${hint.tags !== undefined && hint.tags.length > 0 ? hint.tags.join('、') : '（无）'}`,
    '',
    '【active 词目清单（termId | 大类 | 词目名）】',
    ...input.activeTerms.map((t) => `${t.termId} | ${t.category} | ${t.name}`),
    ...(input.corrective
      ? [
          '',
          '注意：上一次输出不可解析或大类越界。请严格只输出一个合法 JSON 对象；termId 从清单内选，若词表确实没有合适词目，输出新词目提案（proposedTerm 形态）。',
        ]
      : []),
  ].join('\n');
}

// ── 归类+浓缩输出解析（约束式——纯函数零 DB 读；词目落位归调用侧 CR-14）──

/**
 * 归类+浓缩的词目选择三态（解析只分类不落位——CR-14 移位：DB 查重/墓碑跟随/提案物化全在
 * 落库侧，纯 parse 步零 IO 耦合）：
 * - `known`：清单内且大类一致——直接可用。
 * - `proposed`：LLM 显式新词目提案（category+name）。
 * - `unresolved-id`：清单外/大类不一致的 termId——**不拒收候选**（降级 pending 提报路径，
 *   10.2「词表外命中走 pending 提报人审」同语义；落库侧 DB 现查可复用中途核准/既有
 *   pending 词目）。
 */
export type DeconP6TermSelection =
  | { kind: 'known'; category: CraftCardCategory; termId: string }
  | { kind: 'proposed'; category: CraftCardCategory; name: string }
  | { kind: 'unresolved-id'; category: CraftCardCategory; termId: string };

/** 归类+浓缩产物（term 为三态选择——落位在调用侧每批现查）。 */
export interface DeconP6CondenseOutcome {
  term: DeconP6TermSelection;
  claim: {
    condensed: string;
    points: string[];
    scenarios: string[];
    counterexamples: string[];
  };
  tags: string[];
  confidence: number;
}

function cleanStrList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
}

/**
 * 解析归类+浓缩响应（纯函数——零 DB 读）：坏 JSON / condensed 空 / proposedTerm 坏形 /
 * termId 路径缺顶层大类（越出 13 类同判）→ `{ok:false}`（调用方重试一次，仍坏 per-claim 丢弃
 * ——CR-2b-2 mirror 不炸整 pass）。proposedTerm 形态允许省略顶层 category（10.2 词目提案
 * 输出形——大类以提案内为准）。confidence 缺失/坏 → 0.5 中位（排序信号非门禁——缺省不阻塞
 * 落卡，不伪造精确）。清单外 termId **不判失败**（CR-14——unresolved-id 降级提报）。
 */
export function parseDeconP6Response(
  raw: string,
  activeTerms: readonly CraftTerm[],
): { ok: true; outcome: DeconP6CondenseOutcome } | { ok: false } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false };
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false };
  }
  if (obj === null || typeof obj !== 'object') return { ok: false };
  const o = obj as Record<string, unknown>;
  const condensed = typeof o.condensed === 'string' ? o.condensed.trim() : '';
  if (condensed.length === 0) return { ok: false };
  const confidence =
    typeof o.confidence === 'number' &&
    Number.isFinite(o.confidence) &&
    o.confidence >= 0 &&
    o.confidence <= 1
      ? o.confidence
      : 0.5;
  const claim = {
    condensed,
    points: cleanStrList(o.points),
    scenarios: cleanStrList(o.scenarios),
    counterexamples: cleanStrList(o.counterexamples),
  };
  const tags = cleanStrList(o.tags);

  if (o.proposedTerm !== null && o.proposedTerm !== undefined) {
    if (o.proposedTerm === null || typeof o.proposedTerm !== 'object') return { ok: false };
    const p = o.proposedTerm as Record<string, unknown>;
    const pCategory = typeof p.category === 'string' ? p.category : null;
    const pName = typeof p.name === 'string' ? p.name.trim() : '';
    if (
      pCategory === null ||
      !craftCardCategorySchema.safeParse(pCategory).success ||
      pName.length === 0
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      outcome: {
        term: {
          kind: 'proposed',
          category: pCategory as CraftCardCategory,
          name: pName,
        },
        claim,
        tags,
        confidence,
      },
    };
  }

  const category = typeof o.category === 'string' ? o.category : null;
  if (category === null || !craftCardCategorySchema.safeParse(category).success)
    return { ok: false };
  const termId = typeof o.termId === 'string' ? o.termId : null;
  if (termId === null) return { ok: false };
  const term = activeTerms.find((t) => t.termId === termId);
  if (term !== undefined && term.category === category) {
    return {
      ok: true,
      outcome: {
        term: { kind: 'known', category: term.category, termId: term.termId },
        claim,
        tags,
        confidence,
      },
    };
  }
  // 清单外/大类不一致（CR-14）：不再拒收——unresolved-id 交落库侧 DB 现查复用或降级提报。
  return {
    ok: true,
    outcome: {
      term: {
        kind: 'unresolved-id',
        category: category as CraftCardCategory,
        termId,
      },
      claim,
      tags,
      confidence,
    },
  };
}

// ── 词目解析落位（CR-14：每批现查——DB 查重 / 墓碑链跟随 / 提案物化）──

/** 词目落位结果（pendingTerm 非空 = 新词目提案，批落卡事务内先插 pending 行）。 */
export interface DeconP6ResolvedTerm {
  category: CraftCardCategory;
  termId: string;
  pendingTerm: CraftTerm | null;
}

function resolveDeconP6Proposal(
  category: CraftCardCategory,
  name: string,
  note: string,
): DeconP6ResolvedTerm {
  // find-first 复用（同 (category,name) 既有行不重插）+ 墓碑链跟随（CR-2b-9 单源 helper——
  // A→B→C 归并链后提案命中墓碑 A 挂 C 不挂死词目）。
  const existing = findCraftTermByName(category, name);
  if (existing !== null) {
    const term = resolveTermTombstone(existing.termId) ?? existing;
    return { category: term.category, termId: term.termId, pendingTerm: null };
  }
  const pendingTerm: CraftTerm = {
    termId: proposedCraftTermId(category, name),
    category,
    name,
    status: 'pending',
    mergedInto: null,
    note,
  };
  return { category, termId: pendingTerm.termId, pendingTerm };
}

/**
 * 词目选择 → 落位（每批现查，activeTerms 快照外的库内词目也能命中）：`known` 直用；
 * `unresolved-id` 先 DB 现查（运行中途核准的词目 / 既有 pending 词目命中即复用——不再因
 * 快照陈旧拒收+重试必失败+丢候选），真集外降级 pending 提报（名称取落卡提示词目、无则原
 * termId——待人审裁决）；`proposed` 显式提案（10.2 同语义）。
 */
function resolveDeconP6TermSelection(
  selection: DeconP6TermSelection,
  termHint: string | undefined,
): DeconP6ResolvedTerm {
  if (selection.kind === 'known') {
    return {
      category: selection.category,
      termId: selection.termId,
      pendingTerm: null,
    };
  }
  if (selection.kind === 'proposed') {
    return resolveDeconP6Proposal(
      selection.category,
      selection.name,
      '拆书落卡归类提案（词表外命中，待人审核准/归并）',
    );
  }
  const found = resolveTermTombstone(selection.termId);
  if (found !== null) {
    return {
      category: found.category,
      termId: found.termId,
      pendingTerm: null,
    };
  }
  const name =
    termHint !== undefined && termHint.trim().length > 0 ? termHint.trim() : selection.termId;
  return resolveDeconP6Proposal(
    selection.category,
    name,
    '拆书落卡归类降级提案（termId 清单外且库内无此词目，待人审核准/归并）',
  );
}

// ── 落卡动作（批事务内依次执行——mirror 10.2 LandAction）──

/** 批内预嵌向量载荷（去重段已 embed——同形状向量即落卡向量，无二次调用；null = 去重关/降级）。 */
interface DeconP6ClaimVector {
  vector: number[] | null;
  modelId: string | null;
}

type DeconP6LandAction =
  | { kind: 'new-card'; card: CraftCard; claimVector: DeconP6ClaimVector }
  | {
      kind: 'append';
      targetCardId: string;
      teaching: CraftTeaching;
      /** 目标卡在批落库前被删的降级新建卡（CR-21——保已付 LLM 成本，不回滚整批）。 */
      fallbackCard: CraftCard;
      claimVector: DeconP6ClaimVector;
    }
  | { kind: 'review'; review: CraftMergeReview };

/** 新建卡构造（低置信档/去重关/append 目标被删降级共形——pending_review 起板，无 entry 检索行 F-06）。 */
function buildDeconP6NewCard(
  resolved: { category: CraftCardCategory; termId: string },
  claim: DeconP6CondenseOutcome['claim'],
  tags: string[],
  confidence: number,
  teaching: CraftTeaching,
  nowIso: string,
): CraftCard {
  return {
    cardId: `card-${randomBytes(6).toString('hex')}`,
    category: resolved.category,
    termId: resolved.termId,
    title: deriveCardTitle(claim.condensed),
    claim,
    tags,
    teachings: [teaching],
    dispute: false,
    status: 'pending_review',
    rejectReason: null,
    confidence,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

// ── P6 编排（候选循环——断点/预算/锚定终验/单事务落卡）──

export interface DeconP6Stats {
  /** 落卡候选数（craftHint≠null 且 teachingId 批内唯一）。 */
  candidates: number;
  /** 无 craftHint 的 findings 计数（观测面——非失败）。 */
  findingsWithoutHint: number;
  /** teachingId 已在库（幂等 no-op——重跑/续跑零重复面）。 */
  skippedLanded: number;
  /** 主锚不过验被丢的候选数（无锚即丢红线）。 */
  droppedNoAnchor: number;
  /** 证据条目级不过验计数（evidence.anchors 过滤面）。 */
  droppedEvidence: number;
  /** 归类+浓缩两次不可用被丢的候选数（CR-2b-2 per-claim 降级）。 */
  droppedNoCategory: number;
  appended: number;
  mergeReviews: number;
  newCards: number;
  /** append 目标卡在批落库前被删 → 降级转新建卡计数（CR-21——同时计入 newCards）。 */
  appendTargetGone: number;
  /** 落库批事务失败计数（CR-6——每批独立事务：失败批回滚、已落批保留、后续批照走；>0 → pass failed 可重试续落）。 */
  batchesFailed: number;
  /** 去重不可用（无 embed 模型/vec 缺失/模型不一致）——全部新建 + 诚实 note。 */
  dedupOff: boolean;
}

export type DeconP6Result =
  | { status: 'done'; stats: DeconP6Stats }
  | { status: 'paused'; stats: DeconP6Stats }
  | { status: 'cancelled'; stats: DeconP6Stats }
  | { status: 'capped'; message: string; stats: DeconP6Stats }
  | { status: 'failed'; message: string; stats: DeconP6Stats }
  | { status: 'stale'; message: string };

export interface DeconP6Deps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  /** embed 缝注入（mirror CraftCardIndexDeps repository DI——缺省生产 resolveEmbeddingModel/generateEmbeddings）。 */
  resolveModel?: () => ResolvedModel | null;
  embed?: (model: ResolvedModel, text: string) => Promise<number[]>;
  /** 进度事件注入（CR-8——runDeconPassSequence 传 stamped notify；直调测试缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
  now?: () => Date;
}

function emptyStats(): DeconP6Stats {
  return {
    candidates: 0,
    findingsWithoutHint: 0,
    skippedLanded: 0,
    droppedNoAnchor: 0,
    droppedEvidence: 0,
    droppedNoCategory: 0,
    appended: 0,
    mergeReviews: 0,
    newCards: 0,
    appendTargetGone: 0,
    batchesFailed: 0,
    dedupOff: false,
  };
}

/** 边界/门停走映射（CR-7——paused/cancelled/stale 如实，其余 failed）。 */
function boundaryToP6Result(stop: DeconBoundaryStop, stats: DeconP6Stats): DeconP6Result {
  if (stop.status === 'paused') return { status: 'paused', stats };
  if (stop.status === 'cancelled') return { status: 'cancelled', stats };
  return { status: stop.status, message: stop.message, stats };
}

/**
 * 边界停走的 pass_state 降级 + 结果映射（CR-22）：loop 内已写的 'running' 回写 'pending'
 * （非留假 running——重入判定对 pending/running 同为 rerun，但读面/诊断不悬挂在途假象）；
 * **已落批次经独立事务天然保留**，续跑从 teachingId 幂等面跳过（零重付已落批）。只在现值
 * 恰为 running 时降级（done/failed/capped 不动——外部翻态路径各有自己的落库面）。
 */
function stopDeconP6(
  jobId: string,
  stop: DeconBoundaryStop,
  stats: DeconP6Stats,
  nowIso: string,
): DeconP6Result {
  const state = getDeconPassState(jobId, 'p6', 'all');
  if (state !== null && state.status === 'running') {
    upsertDeconPassState({
      jobId,
      pass: 'p6',
      unit: 'all',
      status: 'pending',
      outputRef: null,
      outputHash: null,
      updatedAt: nowIso,
    });
  }
  return boundaryToP6Result(stop, stats);
}

/**
 * 跑 P6 craft 落卡（pass='p6'，unit='all'）。前置两道（design §9「有 craftHint 落卡候选时」）：
 * ①手艺维非空（phases 静态过滤的 belt——coarse / coarse+style 直接 done）；②运行面候选判定
 * （craftHint 产物在管线启动时还不存在——候选集读 product 现值，零候选诚实完成不空停）。
 * 断点重入 = 候选集 hash（findings 稳定 → teachingId 集确定性）+ teachingId 幂等面（卡讲法 +
 * merge-review 行）双保险。**分批落库（CR-6）**：候选按 DECON_P6_BATCH_SIZE 逐批独立事务落
 * 卡，无候选数硬上限——批失败只挂该批（计数继续下一批）；边界停走回写 pass_state pending +
 * 已落批保留（CR-22——续跑零重付已落候选）。LLM 内核惰性判定（CR-10——全 skip 的 job 不因
 * 内核未装配误 fail）。
 */
export async function runDeconP6(jobId: string, deps: DeconP6Deps = {}): Promise<DeconP6Result> {
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();

  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) {
    if (gate.stop === 'paused') return { status: 'paused', stats: emptyStats() };
    if (gate.stop === 'cancelled' || gate.stop === 'not-found')
      return { status: 'cancelled', stats: emptyStats() };
    if (gate.stop === 'stale') return { status: 'stale', message: gate.message };
    return { status: 'failed', message: gate.message, stats: emptyStats() };
  }
  const job: DeconJob = gate.job;

  // 前置①：手艺维非空（coarse / coarse+style 不落 craft 卡——风格维产物不进候选源）。
  if (!job.dimensions.some((d) => d !== 'style')) {
    return { status: 'done', stats: emptyStats() };
  }

  const materialId = extractMaterialId(job.materialRef);
  const collected = collectDeconP6Candidates(jobId, materialId, job.materialContentHash);
  const stats: DeconP6Stats = {
    ...emptyStats(),
    candidates: collected.candidates.length,
    findingsWithoutHint: collected.findingsWithoutHint,
  };

  // 前置②：零候选诚实完成（fine/deep 但 findings 全无 craftHint / 全被锚定核验丢弃时同理
  // 不空停——无产物可落）。
  if (collected.candidates.length === 0) {
    getLogger().info(
      { jobId },
      'decon p6: no craftHint candidates - pass completes without landing',
    );
    return { status: 'done', stats };
  }
  if (collected.candidates.length > 200) {
    // 观测注记（旧硬 ceiling 语义退役——CR-6 分批全落，不再 fail）：大候选量走多批落库。
    getLogger().info(
      {
        jobId,
        candidates: collected.candidates.length,
        batchSize: DECON_P6_BATCH_SIZE,
      },
      'decon p6: large candidate set - landing in batches (no hard ceiling)',
    );
  }

  const outputHash = hashDeconP6Output(collected.candidates.map((c) => c.teachingId));

  const boundary = checkDeconRunBoundary(jobId);
  if (boundary !== null) return stopDeconP6(jobId, boundary, stats, nowIso());
  deps.notify?.({ jobId, status: 'running', pass: 'p6', unit: 'all' });

  // 断点重入：done + 候选集 hash 一致 → skip（零重付——落卡已完成的台账语义）。
  const state = getDeconPassState(jobId, 'p6', 'all');
  const decision = decideDeconPassReentry(state, outputHash);
  if (decision === 'skip') {
    return {
      status: 'done',
      stats: { ...stats, skippedLanded: stats.candidates },
    };
  }

  const failUnit = (
    message: string,
  ): { status: 'failed'; message: string; stats: DeconP6Stats } => {
    failDeconUnit(jobId, 'p6', 'all', message, nowIso());
    return { status: 'failed', message, stats };
  };

  const material = getMaterialRow(materialId);
  if (material === null) {
    return failUnit(`材料 ${job.materialRef} 不存在——P6 无落卡基面`);
  }
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    return failUnit('派生 .md 读取失败（缺失或车道不可解析）——无法锚定落卡基面');
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }
  const blocks = splitParagraphBlocks(derived);
  if (blocks.length === 0) {
    return failUnit('材料无有效段落（派生 .md 全空白）——不可落卡');
  }

  // 去重可用性（mirror 10.2 去重段三检查——off 时全部新建 + 诚实注记；per-call 失败由
  // embedClaimCondensed never-throws 降级该候选无向量）。
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const model = resolveModel();
  const db = getDb();
  let dedupOffReason: string | null = null;
  if (model === null) {
    dedupOffReason = '去重不可用（未配置 embedding 模型）——本次全部新建卡，人审时请留意重复主张';
  } else if (!isSqliteVecAvailable() || getCurrentCraftVecDim(db) === null) {
    dedupOffReason =
      '去重不可用（sqlite-vec 未加载或向量表维度未知）——本次全部新建卡，人审时请留意重复主张';
  } else if (shouldSkipForModelMismatch(resolvePrevailingCraftVectorModel(db), model.modelId)) {
    dedupOffReason =
      '去重不可用（向量模型与存量不一致——请先运行 craft 索引重建迁移）——本次全部新建卡';
  }
  if (dedupOffReason !== null) {
    stats.dedupOff = true;
    getLogger().warn({ jobId }, `decon p6: ${dedupOffReason}`);
  }
  const cardDeps: CraftCardIndexDeps = {
    ...(deps.resolveModel !== undefined ? { resolveModel: deps.resolveModel } : {}),
    ...(deps.embed !== undefined ? { embed: deps.embed } : {}),
  };

  // 幂等面：本材料已落讲法 teachingId 集（崩溃后重跑/续跑零重复挂载——批内 pre-landing
  // 去重双保险，F-04）。**merge-review 落点也占位**（CR-22 分批落库后部分完成的 review 候选
  // 不再重付——resolved 行同算已落，重提会造重复并排任务）。
  const landedTeachingIds = new Set(listCraftTeachingIdsByMaterial(materialId));
  for (const review of listCraftMergeReviews({ includeResolved: true })) {
    const claim = review.newClaim;
    if (claim.materialId === materialId && claim.materialContentHash === job.materialContentHash) {
      landedTeachingIds.add(teachingIdFor(materialId, job.materialContentHash, claim.quote));
    }
  }

  let generate: DeconGenerateText | undefined;
  /** 批内新建卡向量（同 run 相似主张互去重——批落卡事务前新卡不在 vec 表，内存比对补盲）+ 已排程卡登记。 */
  const batchVectors: Array<{ cardId: string; vector: number[] }> = [];
  const batchVectorCards = new Map<string, CraftCard>();
  const forgetBatchVector = (cardId: string): void => {
    batchVectorCards.delete(cardId);
    for (let i = batchVectors.length - 1; i >= 0; i -= 1) {
      if (batchVectors[i]!.cardId === cardId) batchVectors.splice(i, 1);
    }
  };
  let cost = job.cost;

  let batches = 0;
  for (let offset = 0; offset < collected.candidates.length; offset += DECON_P6_BATCH_SIZE) {
    const batchCandidates = collected.candidates.slice(offset, offset + DECON_P6_BATCH_SIZE);
    batches += 1;
    // 每批现查 active 词目（CR-14——运行中途核准的词目下批即命中，activeTerms 快照不再陈旧）。
    const activeTerms = listCraftTerms({ status: 'active' });
    const pendingTermsToInsert: CraftTerm[] = [];
    const resolvedProposals = new Map<string, CraftTerm>();
    const landActions: DeconP6LandAction[] = [];

    for (const candidate of batchCandidates) {
      // 中断韧性（CR-7 + CR-22）：候选边界如实判别 pause/cancel/外部翻态——停走回写 pass_state
      // pending（非留 running）；本批未落动作弃（续跑重付仅限本批），已落批保留。
      const stop = checkDeconRunBoundary(jobId);
      if (stop !== null) return stopDeconP6(jobId, stop, stats, nowIso());

      if (landedTeachingIds.has(candidate.teachingId)) {
        stats.skippedLanded += 1;
        continue;
      }

      // 锚点终验（无锚即丢——P6 侧最后一道）。
      const verified = verifyDeconP6Anchors(candidate, blocks, material.chapters, derived);
      if (verified === null) {
        stats.droppedNoAnchor += 1;
        getLogger().warn(
          { jobId, insight: candidate.insight.slice(0, 40) },
          'decon p6: candidate dropped for missing anchor (fabricated paraRange or quote) - no-anchor-no-keep discipline',
        );
        continue;
      }
      stats.droppedEvidence += verified.droppedEvidence;

      if (generate === undefined) {
        generate = deps.generateText ?? getDeconLlmCore()?.generateText;
        if (generate === undefined) {
          return failUnit('拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试');
        }
      }
      writeDeconPassState(jobId, 'p6', 'all', 'running', null, nowIso());

      // 约束式归类+浓缩（两次尝试——越界/坏输出重试矫正，仍坏 per-claim 丢弃不炸 pass）。
      // C3：LLM 调用面走脚手架单源（预算门→调用→记账→length 升帽重试一次）；截断仍挂 =
      // failed（condensed 语义面——半程主张不可续）。空回复/解析坏仍是候选级丢弃非 pass 失败。
      let outcome: DeconP6CondenseOutcome | null = null;
      let dropReason = '归类+浓缩输出不可用（重试耗尽）';
      for (let attempt = 0; attempt < 2 && outcome === null; attempt++) {
        const user = buildDeconP6UserPrompt({
          bookTitle: material.name,
          candidate,
          activeTerms,
          corrective: attempt > 0,
        });
        const call = await runDeconLlmCall({
          jobId,
          pass: 'p6',
          unit: 'all',
          slot: 'extraction',
          system: DECON_P6_SYSTEM_PROMPT,
          user,
          maxTokens: DECON_P6_CONDENSE_MAX_TOKENS,
          budget: job.budget,
          cost,
          job,
          generate,
          notify: deps.notify,
          nowIso,
          label: 'p6 落卡整理',
        });
        // CR-16：记账先累计再分支——empty 纠偏重试的 attempt-1 花费已落 job 行（helper 内
        // writeDeconCost 单源），本地 cost 不跟进会在 attempt-2 以旧值覆写（replace 语义丢笔）。
        cost = call.cost;
        if (!call.ok) {
          if (call.kind === 'budget-capped') {
            capDeconUnit(jobId, 'p6', 'all', call.note, nowIso());
            return { status: 'capped', message: call.note, stats };
          }
          if (call.kind === 'length') {
            return failUnit(`${call.note}——已挂起（不落半程主张）`);
          }
          if (call.kind === 'empty') {
            dropReason = '空回复';
            continue;
          }
          return failUnit(call.note); // error
        }
        const parsed = parseDeconP6Response(call.text, activeTerms);
        if (!parsed.ok) {
          dropReason = '输出不可解析/越界';
          continue;
        }
        outcome = parsed.outcome;
      }
      if (outcome === null) {
        stats.droppedNoCategory += 1;
        getLogger().warn(
          {
            jobId,
            insight: candidate.insight.slice(0, 40),
            reason: dropReason,
          },
          'decon p6: claim condense failed - dropping candidate (pass continues)',
        );
        continue;
      }
      // 词目解析落位（CR-14：清单外 termId 不再拒收——每批现查复用库内词目 / 降级 pending 提报）。
      const resolved = resolveDeconP6TermSelection(outcome.term, candidate.craftHint.termHint);
      if (resolved.pendingTerm !== null) {
        const key = `${resolved.pendingTerm.category}\0${resolved.pendingTerm.name}`;
        if (!resolvedProposals.has(key)) {
          resolvedProposals.set(key, resolved.pendingTerm);
          pendingTermsToInsert.push(resolved.pendingTerm);
        }
      }

      // teaching 构造（additive 三字段——originKind/bookTitle/evidence 呼应证据族）。
      const teachingBase = {
        teachingId: candidate.teachingId,
        materialId,
        materialContentHash: job.materialContentHash,
        author: material.provenance.author,
        quote: candidate.evidence[0]!.quote,
        anchor: verified.mainAnchor,
        rank: 'normal' as const,
        stale: false,
        originKind: 'decon_instance' as const,
        bookTitle: material.name,
        evidence: {
          anchors: verified.anchors,
          level: (verified.anchors.length >= 2 ? 'strong' : 'weak') as 'strong' | 'weak',
          derivedHash: job.derivedHash,
        },
      };

      // dedup 三档分流（F-09 同形状：新 condensed vs 既有卡 condensed）。
      let vector: number[] | null = null;
      let modelId: string | null = null;
      if (dedupOffReason === null) {
        const embedded = await embedClaimCondensed(outcome.claim.condensed, cardDeps, {
          force: false,
        });
        vector = embedded.vector;
        modelId = embedded.modelId;
      }
      let best: { cardId: string; similarity: number } | null = null;
      if (vector !== null) {
        // 批内比对（落卡事务前新卡不在 vec 表——内存比对补盲，mirror 10.2 batchVectors）。
        for (const b of batchVectors) {
          const sim = cosineSimilarity(vector, b.vector);
          if (best === null || sim > best.similarity) best = { cardId: b.cardId, similarity: sim };
        }
        try {
          for (const hit of knnClaimSimilarities(vector)) {
            if (best === null || hit.similarity > best.similarity) best = hit;
          }
        } catch (err) {
          getLogger().warn(
            { err: deconErrMsg(err), jobId },
            'decon p6: claim KNN failed - degrading to new card',
          );
        }
      }
      // 命中卡回查（CR-2b-8 mirror：mid-run 删卡/批内已排程卡——db 行在或批内可达，否则降新建档）。
      let existingCondensed: string | null = null;
      if (best !== null) {
        const row = getCraftCardRow(best.cardId);
        if (row !== null) {
          existingCondensed = row.card.claim.condensed;
        } else if (batchVectorCards.has(best.cardId)) {
          existingCondensed = batchVectorCards.get(best.cardId)!.claim.condensed;
        } else {
          getLogger().warn(
            { jobId, cardId: best.cardId },
            'decon p6: KNN hit card missing (deleted mid-run) - downgrading to new card',
          );
          best = null;
        }
      }

      if (best !== null && existingCondensed !== null && best.similarity >= DEDUP_AUTO_SIMILARITY) {
        // 高置信档：挂既有卡候选（appendCraftTeaching 降级回 pending_review + entry 行删——
        // 10.2 均一语义；teachingId 幂等键命中 no-op）。CR-21：附降级新建卡载荷——目标卡在批
        // 落库前被删时转新建（保已付 LLM 成本），不扔回滚整批。
        const teaching: CraftTeaching = {
          ...teachingBase,
          note: `拆书落卡：相似度 ${best.similarity.toFixed(3)} 自动挂候选（来源《${material.name}》拆书）`,
        };
        const fallbackCard = buildDeconP6NewCard(
          resolved,
          outcome.claim,
          outcome.tags,
          outcome.confidence,
          {
            ...teachingBase,
            note: `拆书落卡：目标卡在落库前已被删除，降级转新建卡（来源《${material.name}》拆书）`,
          },
          nowIso(),
        );
        landActions.push({
          kind: 'append',
          targetCardId: best.cardId,
          teaching,
          fallbackCard,
          claimVector: { vector, modelId },
        });
        landedTeachingIds.add(candidate.teachingId);
        continue;
      }
      if (
        best !== null &&
        existingCondensed !== null &&
        best.similarity >= DEDUP_REVIEW_SIMILARITY
      ) {
        // 中置信档：merge-review 人审裁并（并排视图裁决归 10.2 既有流）。newClaim 携带
        // additive 三字段（W7 小补①——resolve 成卡时 originKind/bookTitle/evidence 透传进
        // teaching，decon 实例身份经裁决路径不丢，AC4 语义完整性）。
        const review: CraftMergeReview = {
          reviewId: `mrev-${randomBytes(6).toString('hex')}`,
          newClaim: {
            claim: outcome.claim,
            quote: teachingBase.quote,
            anchor: teachingBase.anchor,
            materialId,
            materialContentHash: job.materialContentHash,
            author: material.provenance.author,
            category: resolved.category,
            termId: resolved.termId,
            tags: outcome.tags,
            confidence: outcome.confidence,
            originKind: 'decon_instance',
            bookTitle: material.name,
            evidence: teachingBase.evidence,
          },
          existingCardId: best.cardId,
          similarity: Math.min(1, Math.max(0, best.similarity)),
          resolution: null,
          createdAt: nowIso(),
        };
        landActions.push({ kind: 'review', review });
        landedTeachingIds.add(candidate.teachingId);
        continue;
      }
      // 低置信档 / 无相似命中 / 去重不可用：新建卡（pending_review 起板，无 entry 检索行 F-06）。
      const card = buildDeconP6NewCard(
        resolved,
        outcome.claim,
        outcome.tags,
        outcome.confidence,
        { ...teachingBase, note: null },
        nowIso(),
      );
      landActions.push({
        kind: 'new-card',
        card,
        claimVector: { vector, modelId },
      });
      landedTeachingIds.add(candidate.teachingId);
      batchVectorCards.set(card.cardId, card);
      if (vector !== null) batchVectors.push({ cardId: card.cardId, vector });
    }

    // ── 批落卡事务（CR-6：每批独立——崩溃/失败只弃该批，已落批保留；pending 词目 + 卡/讲法/
    //    review 行同批原子；CR-21：append 前重验目标卡在库——被删降级转新建不回滚整批）。──
    const staged = {
      appended: 0,
      newCards: 0,
      mergeReviews: 0,
      appendTargetGone: 0,
    };
    try {
      getDb().transaction(() => {
        for (const term of pendingTermsToInsert) insertCraftTerm(term);
        for (const action of landActions) {
          if (action.kind === 'new-card') {
            // 预嵌向量直落（去重段已 embed——同形状向量即落卡向量，无二次调用）。
            insertCraftCardRowSync(action.card, {
              vector: action.claimVector.vector,
              modelId: action.claimVector.modelId,
            });
            staged.newCards += 1;
          } else if (action.kind === 'append') {
            if (getCraftCardRow(action.targetCardId) === null) {
              // CR-21：目标卡在调度后被删——降级转新建卡（保已付 LLM 成本），计数不回滚整批。
              insertCraftCardRowSync(action.fallbackCard, {
                vector: action.claimVector.vector,
                modelId: action.claimVector.modelId,
              });
              staged.appendTargetGone += 1;
              staged.newCards += 1;
            } else {
              const res = appendCraftTeaching(action.targetCardId, action.teaching); // teachingId 幂等键命中 → no-op
              if (!res.ok)
                throw new Error(
                  `p6 讲法挂载失败（${action.targetCardId}: ${res.error}）——该批回滚`,
                );
              staged.appended += 1;
            }
          } else {
            insertCraftMergeReview(action.review);
            staged.mergeReviews += 1;
          }
        }
      })();
    } catch (err) {
      stats.batchesFailed += 1;
      // 回滚批的新卡向量登记撤销（防后续批对幽灵卡去重/挂 review）。
      for (const action of landActions) {
        if (action.kind === 'new-card') forgetBatchVector(action.card.cardId);
      }
      getLogger().error(
        {
          err: deconErrMsg(err),
          jobId,
          batch: batches,
          candidates: batchCandidates.length,
        },
        'decon p6: batch landing failed - batch rolled back (landed batches preserved), continuing next batch',
      );
      continue;
    }
    // 批落定才入账（staged 并入点在事务成功后——失败批回滚即弃计数，stats 恒反映已落真相）。
    stats.appended += staged.appended;
    stats.newCards += staged.newCards;
    stats.mergeReviews += staged.mergeReviews;
    stats.appendTargetGone += staged.appendTargetGone;
  }

  if (stats.batchesFailed > 0) {
    return failUnit(
      `p6 落库 ${stats.batchesFailed}/${batches} 批事务失败（已落批次保留——已落 ${stats.appended + stats.mergeReviews + stats.newCards} 条；重试只重付失败批候选）`,
    );
  }

  // ── 全批落定 → done 台账（候选集 hash——findings 稳定 → teachingId 集确定性，重入 skip 面；
  //    写点在批事务外：该窗口崩溃由 teachingId 幂等面兜住——续跑全 skip 零 LLM 再走到此）。──
  writeDeconPassState(jobId, 'p6', 'all', 'done', { outputRef: 'craft:all', outputHash }, nowIso());

  if (stats.droppedNoAnchor > 0 || stats.droppedNoCategory > 0 || stats.droppedEvidence > 0) {
    getLogger().warn(
      {
        jobId,
        droppedNoAnchor: stats.droppedNoAnchor,
        droppedEvidence: stats.droppedEvidence,
        droppedNoCategory: stats.droppedNoCategory,
      },
      'decon p6: candidates/evidence dropped (anchor verification / condense failures - counted, not silent)',
    );
  }
  return { status: 'done', stats };
}
