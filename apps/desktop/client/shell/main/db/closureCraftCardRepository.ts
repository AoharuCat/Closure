import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ResolvedModel } from '@orison/shared-contracts';
import {
  CRAFT_CARD_CATEGORIES,
  CRAFT_CARD_CATEGORY_VALUES,
  CRAFT_CARD_STATUSES,
  craftCardSchema,
  type CraftCard,
  type CraftCardCategory,
  type CraftCardListInput,
  type CraftCardPatchInput,
  type CraftCardStatus,
  type CraftCardSummary,
  type CraftClaim,
  type CraftMergeReviewResolution,
  type CraftTeaching,
  type CraftTeachingRank,
} from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { getCurrentCraftVecDim } from './craftVecDim';
import { floatArrayToBuffer, shouldSkipForModelMismatch } from './closureIndexer';
import { markCraftMergeReviewResolved } from './closureCraftMergeReviewRepository';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';

// ── E10.2b（task 09-05）Wave 2：closure_craft_card 表 repository + 卡派生面（entry/vec）索引器 ──
//
// 手艺卡 = 条目级真相源表（design §1.1：表为真相源，人审 UI 为唯一编辑面）+ 两张派生面：
//
// 1. **#claim 向量路（去重面，常驻全卡——design §1.4 / F-09）**：closure_craft_vec 写
//    `card:<card_id>#claim` 行（vector_kind='claim'，与 doc 行 #body/#identity 并存第三路，
//    mirror 8.7 双向量先例）。向量文本 = 卡 claim.condensed（**同形状对比**——去重 = 新 condensed
//    vs 既有卡 condensed，不与含引文的检索 body 比）。pending/rejected 卡也写（去重必须看见
//    未审卡，否则重跑/新语料对未审主张增殖重复卡）。卡删 → claim vec 行同事务清。
// 2. **entry 检索行（消费面，verified 才写——F-06）**：closure_craft_entry `card:<card_id>` 行
//    （source_kind='craft_card'，craft_type = 大类 slug〔F-10〕，body = 词目名 + 大类 gloss +
//    title + condensed + 讲法引文拼接——词目级检索面）。**verify 时写 / reject·降级时删 /
//    卡内容变更（含词目归并）时重写**——检索可见性 = 人审状态（AC6）。FTS 臂 = entry 行既有
//    trigger；vec 臂经 craft_id join entry 行，pending 卡 vec 行 join 落空自然排除。
//
// 状态机（design §1.1 F-15 转换表权威描述见 contracts/closure-craft-card.ts craftCardSchema
// JSDoc）：verify 写 entry / reject·recover 删 entry / 任何内容编辑（patch·appendCraftTeaching）
// 降级回 pending_review 并删 entry / 讲法 rank 改级是讲法级动作（不降级不动 entry）。
//
// 向量 provenance（F-05）：vec0 虚表无 model/dim 列（无 ALTER 路径），而 pending/rejected 卡无
// entry 行——claim 路记账落 **卡行 claim_model/claim_dim 列**；entry 行（verified）的 model/dim
// 恒镜像卡行两列。模型迁移 sweep = reindexAllCards（挂 reindexAllCraft 同点位，F-05）。
//
// 范式判据（ADR-3）：状态机转换/哈希/行记账 = 纯代码机械（本文件）；切条/归类/冲突判归 LLM
// （W3 管线）。prevailing-model 门 + pending_embed 降级 mirror reindexCraftDoc（CR-02/CR-06）。
//
// expected_downstream_consumers:
// - W3 蒸馏管线（insertCraftCard 落卡 + appendCraftTeaching 高置信挂候选）。
// - W4/W5 IPC（craft:card-list/get/patch/review——result 联合形态与 ipc.ts 契约 error 码对齐，
//   handler 补 operation-failed 兜底；**merge-review-resolve 的卡动作 + resolution 落账经
//   本文件事务化入口 runCraftMergeResolveTransaction 单事务执行**——CR-2b-1，merge review
//   repository 是纯记账面，事务边界归卡侧。closureCraftMergeReviewRepository 单向依赖无环）。
// - closureCraftIndexer.reindexAllCraft（末尾串接 reindexAllCards sweep）。
// - closureCraftTermRepository.mergeCraftTerm（词目归并 → rewriteCraftCardEntryRow）。

/** 卡 entry 行的 source_kind（closure_craft_entry 领地标记——F-01 谓词值域成员）。 */
export const CRAFT_CARD_SOURCE_KIND = 'craft_card';

/** 卡 entry / vec 行的 craft_id（`card:` 前缀 = 命中渲染器识别卡行的锚，mirror F-02 `mat:` 先例）。 */
export function cardCraftId(cardId: string): string {
  return `card:${cardId}`;
}

/** cardCraftId 的逆（F-01/命中渲染解码侧）：非卡行 / 形态不符 → null。 */
export function decodeCardCraftId(craftId: string): string | null {
  const m = /^card:(card-[0-9a-f]{12})$/.exec(craftId);
  return m === null ? null : m[1]!;
}

/** #claim 向量行 id（第三路形态，mirror doc 行 `${craft_id}#body`/`#identity`）。 */
function cardClaimVectorId(cardId: string): string {
  return `${cardCraftId(cardId)}#claim`;
}

/** 卡 patch 入参形态（ipc.ts CraftCardPatchInput.patch 的复用别名——W4/W5 handler 共享）。 */
export type CraftCardPatch = CraftCardPatchInput['patch'];

/** 卡状态机/编辑操作的 result 联合（error 码与 ipc.ts craft:card-patch/review 对齐）。 */
export type CraftCardMutationResult =
  | { ok: true; card: CraftCard }
  | {
      ok: false;
      error: 'not-found' | 'invalid-input' | 'invalid-state' | 'rejected-card';
    };

/** DI seam（mirror CraftReindexDeps / MaterialIndexerDeps——测试零网络）。 */
export interface CraftCardIndexDeps {
  /** 解析 embed 模型；null → claim 向量 pending 不写（F-05 裁定降级 mirror 材料行）。 */
  resolveModel?: () => ResolvedModel | null;
  /** 单文本 embed；缺省 generateEmbeddings 包装（30s 超时，mirror CR-06）。 */
  embed?: (model: ResolvedModel, text: string) => Promise<number[]>;
}

async function defaultEmbed(model: ResolvedModel, text: string): Promise<number[]> {
  const res = await generateEmbeddings(
    model,
    { input: [text] },
    { signal: AbortSignal.timeout(30_000) },
  );
  return res.embeddings[0] ?? [];
}

// ── #claim 向量 embed 核心（prevailing 门 + dim 预检 + never-throws）──

/**
 * 全局 craft 向量空间的 prevailing 模型探针。entry 行（doc/material/verified 卡）优先；
 * pending/rejected 卡无 entry 行（F-06），claim 路自身记账（卡行 claim_model）兜底——
 * 未审卡的向量也在同一空间，去重相似度（F-09）不容混模型向量。
 *
 * E10.2b W3 导出（craftDistillPipeline 去重段复用——蒸馏新 claim 向量必须与存量 #claim 路
 * 同模型空间，与 embedClaimCondensed 的 prevailing 门同判定单源）。
 */
export function resolvePrevailingCraftVectorModel(db: Database.Database): string | null {
  const entryRow = db
    .prepare('SELECT model FROM closure_craft_entry WHERE model IS NOT NULL LIMIT 1')
    .get() as { model: string } | undefined;
  if (entryRow?.model) return entryRow.model;
  const cardRow = db
    .prepare('SELECT claim_model FROM closure_craft_card WHERE claim_model IS NOT NULL LIMIT 1')
    .get() as { claim_model: string } | undefined;
  return cardRow?.claim_model ?? null;
}

export interface ClaimEmbedOutcome {
  vector: number[] | null;
  modelId: string | null;
}

/**
 * 落一段 claim 向量（never-throws——失败/无模型/prevailing mismatch/dim 不符一律
 * `{vector:null, modelId:null}` = pending 语义，卡行照写）。`force` 供 sweep（迁移本身
 * 即 prevailing 的合法翻转，mirror reindexAllCraft 对 reindexCraftDoc 的关系）。
 * E10.3b W1 导出——P6 拆书落卡的去重三档分流复用（私有→导出，零行为变更）。
 */
export async function embedClaimCondensed(
  condensed: string,
  deps: CraftCardIndexDeps,
  opts: { force: boolean },
): Promise<ClaimEmbedOutcome> {
  const db = getDb();
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const model = resolveModel();
  if (!model || !condensed.trim()) return { vector: null, modelId: null };
  if (!isSqliteVecAvailable()) return { vector: null, modelId: null };
  const vecDim = getCurrentCraftVecDim(db);
  if (vecDim === null) return { vector: null, modelId: null };
  if (!opts.force) {
    const prevailing = resolvePrevailingCraftVectorModel(db);
    if (shouldSkipForModelMismatch(prevailing, model.modelId)) {
      getLogger().warn(
        { prevailingModel: prevailing, resolvedModel: model.modelId },
        'craft card: model mismatch (prevailing vs resolved) - claim vector pending; run rebuild to migrate',
      );
      return { vector: null, modelId: null };
    }
  }
  try {
    const arr = await embed(model, condensed);
    if (arr.length === vecDim) return { vector: arr, modelId: model.modelId };
    getLogger().warn(
      { expected: vecDim, got: arr.length, model: model.modelId },
      'craft card: claim embedding dim mismatch - vector pending',
    );
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'craft card: claim embed failed - vector pending',
    );
  }
  return { vector: null, modelId: null };
}

// ── 行映射（tolerant——坏 JSON/坏行跳过不崩调用方，mirror rowToMaterial CR-E6）──

interface CraftCardSqlRow {
  card_id: string;
  category: string;
  term_id: string;
  title: string;
  claim_json: string;
  tags_json: string;
  teachings_json: string;
  dispute: number;
  status: string;
  reject_reason: string | null;
  confidence: number;
  claim_model: string | null;
  claim_dim: number | null;
  created_at: string;
  updated_at: string;
}

/** 卡行（真相源字段 + claim 向量记账两列——派生面同步要用）。 */
export interface CraftCardRow {
  card: CraftCard;
  claimModel: string | null;
  claimDim: number | null;
}

const CRAFT_CARD_COLS =
  'card_id, category, term_id, title, claim_json, tags_json, teachings_json, dispute, status, reject_reason, confidence, claim_model, claim_dim, created_at, updated_at';

function rowToCraftCardRow(r: CraftCardSqlRow): CraftCardRow | null {
  try {
    const card = craftCardSchema.parse({
      cardId: r.card_id,
      category: r.category,
      termId: r.term_id,
      title: r.title,
      claim: JSON.parse(r.claim_json),
      tags: JSON.parse(r.tags_json),
      teachings: JSON.parse(r.teachings_json),
      dispute: r.dispute === 1,
      status: r.status,
      rejectReason: r.reject_reason,
      confidence: r.confidence,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
    return { card, claimModel: r.claim_model, claimDim: r.claim_dim };
  } catch {
    return null;
  }
}

/** 取卡（zod 全校验；坏行/缺行 → null）。 */
export function getCraftCard(cardId: string): CraftCard | null {
  const row = getDb()
    .prepare(`SELECT ${CRAFT_CARD_COLS} FROM closure_craft_card WHERE card_id=?`)
    .get(cardId) as CraftCardSqlRow | undefined;
  return row === undefined ? null : (rowToCraftCardRow(row)?.card ?? null);
}

/** 取卡行（含 claim_model/claim_dim——派生面同步/状态机路径用）。 */
export function getCraftCardRow(cardId: string): CraftCardRow | null {
  const row = getDb()
    .prepare(`SELECT ${CRAFT_CARD_COLS} FROM closure_craft_card WHERE card_id=?`)
    .get(cardId) as CraftCardSqlRow | undefined;
  return row === undefined ? null : rowToCraftCardRow(row);
}

/** 词目名查词（entry body 组料用；词目行缺失防御性 null——调用方回退 termId）。 */
function lookupTermName(db: Database.Database, termId: string): string | null {
  const row = db.prepare('SELECT name FROM closure_craft_term WHERE term_id=?').get(termId) as
    { name: string } | undefined;
  return row?.name ?? null;
}

// ── entry 检索行（消费面——verified 才写，F-06/F-10）──

/**
 * 大类 gloss 短标签（全 gloss 首个全角冒号前的类名——长注记不进检索体浪费命中渲染预算）。
 * E10.2b W4.1 导出：query_craft 卡命中渲染头部 `## title（{gloss}·{词目名}）` 与 entry
 * body 组料共用同一截断口径（单源防漂移）。
 */
export function craftCategoryGlossLabel(category: string): string {
  const entry = CRAFT_CARD_CATEGORIES.find((c) => c.value === category);
  if (entry === undefined) return category;
  const idx = entry.gloss.indexOf('：');
  return idx > 0 ? entry.gloss.slice(0, idx) : entry.gloss;
}

/**
 * 卡 entry 检索行 body（design §1.4 F-10——词目级检索面）：词目名 + 大类 gloss + title +
 * condensed 四件套 + 讲法引文拼接。讲法全量进 body（rank 过滤归命中渲染 W4——检索面按
 * 「卡被检回」组织，讲法裁决不收缩匹配面）。
 */
function buildCardEntryBody(card: CraftCard, termName: string): string {
  const lines: string[] = [
    `词目：${termName}`,
    `大类：${craftCategoryGlossLabel(card.category)}`,
    `招式：${card.title}`,
    `主张：${card.claim.condensed}`,
  ];
  const section = (label: string, items: readonly string[]): void => {
    if (items.length > 0) lines.push(`${label}：\n${items.map((x) => `- ${x}`).join('\n')}`);
  };
  section('操作要点', card.claim.points);
  section('适用场景', card.claim.scenarios);
  section('反例', card.claim.counterexamples);
  const teachings = card.teachings
    .map((t) => `- 引文：「${t.quote}」${t.author === null ? '' : `（${t.author}）`}`)
    .join('\n');
  if (teachings) lines.push(`多来源讲法：\n${teachings}`);
  return lines.join('\n\n');
}

/** entry content_hash（sha256 hex——物化体检索体全文的哈希；claim 向量落地才有值 = pending_embed 语义）。 */
function computeCardEntryHash(card: CraftCard, termName: string): string {
  return createHash('sha256').update(buildCardEntryBody(card, termName)).digest('hex');
}

/**
 * 写卡 entry 检索行（verify/sweep/词目归并的公共落点）。model/dim 恒镜像卡行 claim 记账
 * （不变式：entry.model ≡ card.claim_model）；claim 无向量 → content_hash NULL（pending_embed）。
 * FTS 臂由 closure_craft_entry 既有 trigger 同步。
 */
function writeCardEntryRow(
  db: Database.Database,
  card: CraftCard,
  claim: { model: string | null; dim: number | null },
): void {
  const termName = lookupTermName(db, card.termId) ?? card.termId;
  const hash = claim.model !== null ? computeCardEntryHash(card, termName) : null;
  db.prepare(
    `INSERT INTO closure_craft_entry
       (craft_id, craft_type, source_kind, name, body_text, tags, source,
        summary_text, summary_source, summary_hash, content_hash, model, dim, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(craft_id) DO UPDATE SET
       craft_type=excluded.craft_type,
       source_kind=excluded.source_kind,
       name=excluded.name,
       body_text=excluded.body_text,
       tags=excluded.tags,
       source=excluded.source,
       summary_text=excluded.summary_text,
       summary_source=excluded.summary_source,
       summary_hash=excluded.summary_hash,
       content_hash=excluded.content_hash,
       model=excluded.model,
       dim=excluded.dim,
       updated_at=datetime('now')`,
  ).run(
    cardCraftId(card.cardId),
    card.category, // craft_type = 大类 slug（F-10——与 doc 8 类 slug 部分重合是特性）
    CRAFT_CARD_SOURCE_KIND,
    card.title,
    buildCardEntryBody(card, termName),
    JSON.stringify(card.tags),
    termName, // source = 词目名（检索行出处呈现；讲法级 provenance 住卡表 teachings）
    null, // 卡无简述层（condensed 即首面）
    null,
    null,
    hash,
    claim.model,
    claim.dim,
  );
}

/** 删卡 entry 检索行（reject/降级/删卡——FTS trigger 同步清）。 */
function deleteCardEntryRow(db: Database.Database, cardId: string): void {
  // F-01 领地：精确 craft_id + source_kind 双条件——卡删除永不触碰 doc/材料行。
  db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=? AND source_kind=?').run(
    cardCraftId(cardId),
    CRAFT_CARD_SOURCE_KIND,
  );
}

/** 写 #claim 向量行（调用方保证 vec 扩展可用 + 维度相符）。 */
function insertClaimVecRow(db: Database.Database, card: CraftCard, vector: number[]): void {
  db.prepare(
    `INSERT INTO closure_craft_vec (vector_id, craft_id, craft_type, source_kind, vector_kind, embedding)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    cardClaimVectorId(card.cardId),
    cardCraftId(card.cardId),
    card.category,
    CRAFT_CARD_SOURCE_KIND,
    'claim',
    floatArrayToBuffer(vector),
  );
}

/**
 * vec0 写入前的 dim 复验（CR-2b-7）：claim 向量在事务外预嵌（embed 是网络调用），embed 与
 * 落库之间 reindex 换 dim（DROP+reCREATE `float[N]`）→ 旧维向量 insert 会 vec0 原生抛、
 * 连坐回滚整笔材料事务。不符 → 调用方**不写向量行 + 记账压 null/pending**（verify/sweep
 * 补嵌自愈），不裸抛抢答回滚。
 */
function claimVecDimOk(db: Database.Database, vector: number[]): boolean {
  const dim = getCurrentCraftVecDim(db);
  return dim !== null && dim === vector.length;
}

/**
 * 按卡当前状态重建 entry 检索行（词目归并/sweep 的公共重写面）：verified → 重写（claim
 * 记账镜像）；非 verified → 幂等清行（状态机路径本已保证无行，belt 防半程残留）。
 * condensed 未变——claim 向量不动（词目归并不改主张文本，只改分类面）。
 */
export function rewriteCraftCardEntryRow(cardId: string): boolean {
  const db = getDb();
  const row = getCraftCardRow(cardId);
  if (row === null) return false;
  if (row.card.status !== 'verified') {
    deleteCardEntryRow(db, cardId);
    return true;
  }
  writeCardEntryRow(db, row.card, { model: row.claimModel, dim: row.claimDim });
  return true;
}

// ── 列表（人审队列——过滤 + 摘要投影，CraftCardSummary）──

function teachingsStats(teachings: readonly CraftTeaching[]): {
  teachingCount: number;
  staleTeachingCount: number;
  materialIds: string[];
} {
  const ids: string[] = [];
  const seen = new Set<string>();
  let stale = 0;
  for (const t of teachings) {
    if (!seen.has(t.materialId)) {
      seen.add(t.materialId);
      ids.push(t.materialId);
    }
    if (t.stale) stale += 1;
  }
  return {
    teachingCount: teachings.length,
    staleTeachingCount: stale,
    materialIds: ids,
  };
}

/** LIKE 转义（`%`/`_`/`\`——mirror materialIndexer escapeLikePrefix）。 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 卡列表（craft:card-list 取数面）：全字段可选 AND 组合，tags 内 OR（json_each 精确匹配
 * ——tags_json 恒合法 JSON 数组）；materialId 按 teachings_json LIKE（材料 id 格式
 * `mat-<12hex>` 无通配符面，子串误配不可能）；排序 confidence-asc（默认——低置信排前，R5）/
 * updated-desc / created-desc。摘要投影剥 teachings 大数组（mirror MaterialSummary 纪律）。
 */
export function listCraftCards(input: CraftCardListInput = {}): CraftCardSummary[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    clauses.push('c.status = ?');
    params.push(input.status);
  }
  if (input.category !== undefined) {
    clauses.push('c.category = ?');
    params.push(input.category);
  }
  if (input.termId !== undefined) {
    clauses.push('c.term_id = ?');
    params.push(input.termId);
  }
  if (input.tags !== undefined && input.tags.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM json_each(c.tags_json) je WHERE je.value IN (${input.tags
        .map(() => '?')
        .join(',')}))`,
    );
    params.push(...input.tags);
  }
  if (input.materialId !== undefined) {
    clauses.push("c.teachings_json LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(input.materialId)}%`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const order =
    input.sort === 'updated-desc'
      ? 'c.updated_at DESC'
      : input.sort === 'created-desc'
        ? 'c.created_at DESC'
        : 'c.confidence ASC, c.updated_at DESC';
  const rows = db
    .prepare(
      `SELECT c.card_id, c.category, c.term_id, t.name AS term_name, c.title, c.claim_json,
              c.tags_json, c.teachings_json, c.status, c.dispute, c.confidence, c.reject_reason,
              c.created_at, c.updated_at
       FROM closure_craft_card c
       LEFT JOIN closure_craft_term t ON t.term_id = c.term_id
       ${where}
       ORDER BY ${order}`,
    )
    .all(...params) as Array<{
    card_id: string;
    category: string;
    term_id: string;
    term_name: string | null;
    title: string;
    claim_json: string;
    tags_json: string;
    teachings_json: string;
    status: string;
    dispute: number;
    confidence: number;
    reject_reason: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows.flatMap((r) => {
    try {
      // 值域守卫（db 原始列是 string——坏行〔手改库〕跳过，不静默伪造联合类型）。
      if (!(CRAFT_CARD_CATEGORY_VALUES as readonly string[]).includes(r.category)) return [];
      if (!(CRAFT_CARD_STATUSES as readonly string[]).includes(r.status)) return [];
      const claim = JSON.parse(r.claim_json) as CraftClaim;
      const tags = JSON.parse(r.tags_json) as string[];
      const teachings = JSON.parse(r.teachings_json) as CraftTeaching[];
      if (
        typeof claim.condensed !== 'string' ||
        !Array.isArray(tags) ||
        !Array.isArray(teachings)
      ) {
        return [];
      }
      const stats = teachingsStats(teachings);
      return [
        {
          cardId: r.card_id,
          category: r.category as CraftCardCategory,
          termId: r.term_id,
          termName: r.term_name,
          title: r.title,
          condensed: claim.condensed,
          tags,
          status: r.status as CraftCardStatus,
          dispute: r.dispute === 1,
          confidence: r.confidence,
          teachingCount: stats.teachingCount,
          staleTeachingCount: stats.staleTeachingCount,
          materialIds: stats.materialIds,
          rejectReason: r.reject_reason,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        },
      ];
    } catch {
      return [];
    }
  });
}

// ── 落卡（W3 管线入口）──

/**
 * 落卡写库核心（同步——**预嵌向量直落**，E10.2b W3 每材料落卡单事务的消费入口：蒸馏管线在
 * 去重段已 embed condensed，落卡阶段把本函数嵌进外层 `db.transaction`（内层事务自动降级为
 * savepoint，better-sqlite3 嵌套语义）——F-04 崩溃全回滚）。零 embed 调用：`claim` 由调用方
 * 预备（embedClaimCondensed 或蒸馏去重段的向量）。
 */
export function insertCraftCardRowSync(card: CraftCard, claim: ClaimEmbedOutcome): void {
  const db = getDb();
  db.transaction(() => {
    // CR-2b-7 dim 复验：embed 与落卡间 reindex 换 dim → vec0 insert 原生抛会回滚整笔材料
    // 事务；不符 → 向量行不写 + 记账 null/pending（verify/sweep 补嵌），材料照落。
    const vectorUsable = claim.vector !== null && claimVecDimOk(db, claim.vector);
    const claimModel = vectorUsable ? claim.modelId : null;
    const claimDim = vectorUsable ? claim.vector!.length : null;
    db.prepare(
      `INSERT INTO closure_craft_card
         (card_id, category, term_id, title, claim_json, tags_json, teachings_json,
          dispute, status, reject_reason, confidence, claim_model, claim_dim, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      card.cardId,
      card.category,
      card.termId,
      card.title,
      JSON.stringify(card.claim),
      JSON.stringify(card.tags),
      JSON.stringify(card.teachings),
      card.dispute ? 1 : 0,
      card.status,
      card.rejectReason,
      card.confidence,
      claimModel,
      claimDim,
      card.createdAt,
      card.updatedAt,
    );
    if (vectorUsable) {
      insertClaimVecRow(db, card, claim.vector!);
    }
    if (card.status === 'verified') {
      writeCardEntryRow(db, card, { model: claimModel, dim: claimDim });
    }
  })();
}

/**
 * 落一张新卡：#claim 向量 embed（事务外，never-throws 降级）→ 单 WAL 事务写卡行 + claim vec
 * 行。管线产物恒 pending_review 起板——无 entry 检索行（F-06）。防御：直接落 verified 卡
 * （导入/测试形态）也守「verified ⇒ entry 行存在」不变式，同事务写 entry。
 * PK 冲突（cardId 已在）抛错——落卡是新建语义，重挂/合并走 appendCraftTeaching。
 */
export async function insertCraftCard(
  card: CraftCard,
  deps: CraftCardIndexDeps = {},
): Promise<CraftCard> {
  const claim = await embedClaimCondensed(card.claim.condensed, deps, {
    force: false,
  });
  insertCraftCardRowSync(card, claim);
  return card;
}

/**
 * 挂一条讲法到既有卡（高置信自动挂候选 / merge review merge 动作的落点）。teachingId 幂等
 * 键命中 → no-op（F-04 防同键重复挂载）。挂讲法是内容编辑——**降级回 pending_review** +
 * entry 检索行删（design §2.3「卡回 pending_review」）；claim 向量不动（condensed 未变）。
 * rejected 卡允许挂（新证据重开复核——去重面常驻全卡的必然：同主张新来源命中已驳回卡，
 * 挂上回队列让人看，比静默新建重复卡诚实）。
 */
export function appendCraftTeaching(
  cardId: string,
  teaching: CraftTeaching,
): CraftCardMutationResult {
  const db = getDb();
  const existing = getCraftCardRow(cardId);
  if (existing === null) return { ok: false, error: 'not-found' };
  if (existing.card.teachings.some((t) => t.teachingId === teaching.teachingId)) {
    return { ok: true, card: existing.card };
  }
  const teachings = [...existing.card.teachings, teaching];
  const updatedAt = new Date().toISOString();
  const parsed = craftCardSchema.safeParse({
    ...existing.card,
    teachings,
    status: 'pending_review',
    updatedAt,
  });
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  db.transaction(() => {
    db.prepare(
      `UPDATE closure_craft_card SET teachings_json=?, status='pending_review', reject_reason=NULL, updated_at=? WHERE card_id=?`,
    ).run(JSON.stringify(teachings), updatedAt, cardId);
    deleteCardEntryRow(db, cardId);
  })();
  return { ok: true, card: parsed.data };
}

// ── merge-review resolve 事务化入口（CR-2b-1——卡动作 + resolution 落账单事务，F-04）──

/** resolve 卡动作载荷（craftIpc mergeReviewResolve 构造的纯产物——teaching/card 在彼处组装）。 */
export type CraftMergeResolveCardAction =
  | { kind: 'merge'; cardId: string; teaching: CraftTeaching }
  | { kind: 'independent'; card: CraftCard }
  | { kind: 'dismiss' };

/** resolve 事务化执行结果：error 码与 craft:merge-review-resolve 契约对齐（rejected-card
 * 归并——该码契约无此位）。 */
export type CraftMergeResolveTxResult =
  | { ok: true; card?: CraftCard }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'invalid-state' };

/** 事务内 abort 信号：卡动作/落账的业务失败 → 整体回滚 + 错误码透传（非 db 异常）。 */
class MergeResolveAbort extends Error {
  constructor(readonly code: 'not-found' | 'invalid-input' | 'invalid-state' | 'rejected-card') {
    super(code);
  }
}

/**
 * 三动作裁决的事务化执行面（craftIpc craft:merge-review-resolve 调用——CR-2b-1）：卡动作
 * （merge=appendCraftTeaching / independent=insertCraftCardRowSync / dismiss=零卡面动作）与
 * **resolution 落账（markCraftMergeReviewResolved 幂等闸）在同一 `db.transaction`**——
 * 并发裁决竞态过 invalid-state 闸时卡动作一并回滚（幻影屏障：无重复卡/讲法残留，不依赖
 * 「幂等键/新建卡语义」的口头保证）；动作失败（not-found/invalid-input）同样整体回滚不落账
 * （用户可重试）。independent 的 #claim 向量在事务外预嵌（网络调用不进 WAL 事务；
 * never-throws 降级 pending，mirror insertCraftCard）。
 *
 * 内层各写函数自带 `db.transaction`——better-sqlite3 嵌套自动降级 savepoint，回滚由外层
 * 统一裁定。db 层异常原样抛出（调用方 operation-failed belt）。
 */
export async function runCraftMergeResolveTransaction(
  action: CraftMergeResolveCardAction,
  reviewId: string,
  resolution: CraftMergeReviewResolution,
  deps: CraftCardIndexDeps = {},
): Promise<CraftMergeResolveTxResult> {
  const claim: ClaimEmbedOutcome =
    action.kind === 'independent'
      ? await embedClaimCondensed(action.card.claim.condensed, deps, {
          force: false,
        })
      : { vector: null, modelId: null };
  const db = getDb();
  try {
    const landed = db.transaction((): CraftCard | undefined => {
      let card: CraftCard | undefined;
      if (action.kind === 'merge') {
        const res = appendCraftTeaching(action.cardId, action.teaching); // teachingId 幂等键命中 → no-op
        if (!res.ok) throw new MergeResolveAbort(res.error);
        card = res.card;
      } else if (action.kind === 'independent') {
        insertCraftCardRowSync(action.card, claim);
        card = action.card;
      }
      const mark = markCraftMergeReviewResolved(reviewId, resolution);
      if (!mark.ok) throw new MergeResolveAbort(mark.error);
      return card;
    })();
    return { ok: true, ...(landed !== undefined ? { card: landed } : {}) };
  } catch (err) {
    if (err instanceof MergeResolveAbort) {
      // 'rejected-card' 是卡编辑路径的错误码，appendCraftTeaching 当前不产它（防御唯一可达
      // 路径）——resolve 契约无此码，如实映射 invalid-state 不吞。
      return err.code === 'rejected-card'
        ? { ok: false, error: 'invalid-state' }
        : { ok: false, error: err.code };
    }
    throw err;
  }
}

// ── 编辑即降级（patch——W5 表单落盘点）──

/** 词目行读取（patch 改挂校验用）：缺行/坏 category（手改库）→ null——category 单源脏值不得写进卡。 */
function lookupTermCategory(db: Database.Database, termId: string): CraftCardCategory | null {
  const target = db
    .prepare('SELECT term_id, category FROM closure_craft_term WHERE term_id=?')
    .get(termId) as { term_id: string; category: string } | undefined;
  if (target === undefined) return null;
  if (!(CRAFT_CARD_CATEGORY_VALUES as readonly string[]).includes(target.category)) return null;
  return target.category as CraftCardCategory;
}

/**
 * 卡内容编辑（**编辑即降级执行点**，R5 uniform——人改也回待审）：任何实际写库 → status
 * pending_review + entry 检索行删（F-06）。condensed 变更 → #claim 向量重嵌（同形状去重面
 * 不能停留在旧主张文本上；embed 失败/dim 不符 → pending + 旧向量清，mirror CR-craft-kb-009）。
 * rejected 卡 → `rejected-card`（编辑入口禁用，必须先 recover）。termId 改挂校验目标词目
 * 存在，category 恒跟随 term.category 单源（F-15——patch 无 category 字段）。
 *
 * **并发覆写防护（CR-2b-6）**：condensed 重嵌是网络调用（事务外），窗口内的并发写（另一路
 * patch 的 tags/title 等）不能被本路的旧快照全行 UPDATE 吞——终事务内**重读 fresh 基行**，
 * patch 字段叠加在 fresh 上就地合并；前置快照只用于「是否值得烧 embed」的预判与快速失败态。
 */
export async function patchCraftCard(
  cardId: string,
  patch: CraftCardPatch,
  deps: CraftCardIndexDeps = {},
): Promise<CraftCardMutationResult> {
  const db = getDb();
  // 前置快照读：快速失败态（not-found / rejected-card / 词目存在性）在烧 embed 前拦。
  const existing = getCraftCardRow(cardId);
  if (existing === null) return { ok: false, error: 'not-found' };
  if (existing.card.status === 'rejected') return { ok: false, error: 'rejected-card' };
  if (patch.termId !== undefined && patch.termId !== existing.card.termId) {
    if (lookupTermCategory(db, patch.termId) === null) return { ok: false, error: 'invalid-input' };
  }

  const patchCondensed = patch.claim?.condensed;
  const wantsReembed =
    patchCondensed !== undefined && patchCondensed !== existing.card.claim.condensed;
  let embedOutcome: ClaimEmbedOutcome | null = null;
  if (wantsReembed) {
    embedOutcome = await embedClaimCondensed(patchCondensed, deps, {
      force: false,
    });
  }

  const updatedAt = new Date().toISOString();
  const outcome: {
    card: CraftCard | null;
    failure: CraftCardMutationResult | null;
  } = {
    card: null,
    failure: null,
  };
  db.transaction(() => {
    // CR-2b-6：终事务重读 fresh 基行 + 就地合并——embed 窗口内的并发写全数保留。
    const fresh = getCraftCardRow(cardId);
    if (fresh === null) {
      outcome.failure = { ok: false, error: 'not-found' }; // embed 窗口内被并发删除
      return;
    }
    if (fresh.card.status === 'rejected') {
      outcome.failure = { ok: false, error: 'rejected-card' }; // embed 窗口内被并发驳回
      return;
    }
    let nextCategory = fresh.card.category;
    if (patch.termId !== undefined && patch.termId !== fresh.card.termId) {
      const category = lookupTermCategory(db, patch.termId);
      if (category === null) {
        outcome.failure = { ok: false, error: 'invalid-input' }; // 词目缺失/坏 category（手改库）
        return;
      }
      nextCategory = category;
    }
    const next: CraftCard = {
      ...fresh.card,
      category: nextCategory,
      termId: patch.termId ?? fresh.card.termId,
      title: patch.title ?? fresh.card.title,
      claim: {
        condensed: patch.claim?.condensed ?? fresh.card.claim.condensed,
        points: patch.claim?.points ?? fresh.card.claim.points,
        scenarios: patch.claim?.scenarios ?? fresh.card.claim.scenarios,
        counterexamples: patch.claim?.counterexamples ?? fresh.card.claim.counterexamples,
      },
      tags: patch.tags ?? fresh.card.tags,
      dispute: patch.dispute ?? fresh.card.dispute,
      status: 'pending_review', // 编辑即降级
      rejectReason: null,
      updatedAt,
    };
    const parsed = craftCardSchema.safeParse(next);
    if (!parsed.success) {
      outcome.failure = { ok: false, error: 'invalid-input' };
      return;
    }
    // condensed 相对 fresh 是否真变（并发写者可能已写入同值 → 幂等无操作，保持其向量记账）。
    const condensedChanged =
      patch.claim?.condensed !== undefined && patch.claim.condensed !== fresh.card.claim.condensed;
    let claimModel = fresh.claimModel;
    let claimDim = fresh.claimDim;
    let vector: number[] | null = null;
    if (condensedChanged) {
      if (embedOutcome !== null) {
        // CR-2b-7 dim 复验：embed 与落库间 reindex 换 dim → vec0 insert 原生抛；不符 → 降
        // pending（记账 null + 旧向量清，verify/sweep 补嵌），不裸抛回滚整笔 patch。
        const usable = embedOutcome.vector !== null && claimVecDimOk(db, embedOutcome.vector);
        vector = usable ? embedOutcome.vector : null;
        claimModel = usable ? embedOutcome.modelId : null;
        claimDim = usable ? (embedOutcome.vector?.length ?? null) : null;
      } else {
        // 罕见竞态：patch.condensed == 前置快照值但 fresh 已被并发改走（改回场景）——本路未
        // 预嵌向量，fresh 的向量对本路落值必然陈旧 → 删行 + pending 记账（verify/sweep 补嵌）。
        claimModel = null;
        claimDim = null;
      }
    }
    db.prepare(
      `UPDATE closure_craft_card
         SET category=?, term_id=?, title=?, claim_json=?, tags_json=?, dispute=?,
             status='pending_review', reject_reason=NULL, confidence=?,
             claim_model=?, claim_dim=?, updated_at=?
       WHERE card_id=?`,
    ).run(
      next.category,
      next.termId,
      next.title,
      JSON.stringify(next.claim),
      JSON.stringify(next.tags),
      next.dispute ? 1 : 0,
      next.confidence,
      claimModel,
      claimDim,
      next.updatedAt,
      cardId,
    );
    if (condensedChanged && isSqliteVecAvailable()) {
      // 无条件删旧向量再按落地面写——浓缩改了，旧向量会 KNN 命中旧主张（CR-craft-kb-009 同款）。
      db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(cardCraftId(cardId));
      if (vector !== null) insertClaimVecRow(db, parsed.data, vector);
    }
    // 降级 ⇒ 检索可见性收回。
    deleteCardEntryRow(db, cardId);
    outcome.card = parsed.data;
  })();
  if (outcome.failure !== null) return outcome.failure;
  return {
    ok: true,
    card: outcome.card ?? getCraftCard(cardId) ?? existing.card,
  };
}

// ── 人审状态机（review——verify/reject/recover + 讲法 rank）──

/**
 * 卡状态机动作（转换表见 craftCardSchema JSDoc）：
 * - `verify`：pending_review → verified。**entry 检索行此际写**（F-06）；claim 向量若 pending
 *   （落卡时无模型）在此补嵌重试（pending_embed 自愈——模型可能已配置上）。
 * - `reject`：pending_review|verified → rejected。entry 行删；**claim 向量保留**（去重面常驻
 *   全卡——防同内容换来源重进）；rejectReason 落库（废弃区回看）。
 * - `recover`：rejected → pending_review（编辑入口解锁）；rejectReason 清（schema：仅 rejected 落值）。
 */
export async function reviewCraftCard(
  cardId: string,
  action: 'verify' | 'reject' | 'recover',
  opts: { rejectReason?: string } = {},
  deps: CraftCardIndexDeps = {},
): Promise<CraftCardMutationResult> {
  const db = getDb();
  const existing = getCraftCardRow(cardId);
  if (existing === null) return { ok: false, error: 'not-found' };

  if (action === 'verify') {
    if (existing.card.status !== 'pending_review') return { ok: false, error: 'invalid-state' };
    let vector: number[] | null = null;
    let claimModel = existing.claimModel;
    let claimDim = existing.claimDim;
    if (existing.claimModel === null) {
      const outcome = await embedClaimCondensed(existing.card.claim.condensed, deps, {
        force: false,
      });
      vector = outcome.vector;
      claimModel = outcome.modelId;
      claimDim = outcome.vector !== null ? outcome.vector.length : null;
    }
    const updatedAt = new Date().toISOString();
    const verified: CraftCard = {
      ...existing.card,
      status: 'verified',
      rejectReason: null,
      updatedAt,
    };
    db.transaction(() => {
      // CR-2b-7 dim 复验（verify 补嵌路径同款）：补嵌向量与当前 vec 表 dim 不符 → 降 pending
      // （记账 null，下次 verify/sweep 再试），不裸抛回滚 verify。
      const dimOk = vector === null || claimVecDimOk(db, vector);
      const effVector = dimOk ? vector : null;
      const effModel = dimOk ? claimModel : null;
      const effDim = dimOk ? claimDim : null;
      db.prepare(
        `UPDATE closure_craft_card SET status='verified', reject_reason=NULL, claim_model=?, claim_dim=?, updated_at=? WHERE card_id=?`,
      ).run(effModel, effDim, updatedAt, cardId);
      if (effVector !== null && isSqliteVecAvailable()) {
        db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(cardCraftId(cardId));
        insertClaimVecRow(db, existing.card, effVector);
      }
      writeCardEntryRow(db, verified, { model: effModel, dim: effDim });
    })();
  } else if (action === 'reject') {
    if (existing.card.status === 'rejected') return { ok: false, error: 'invalid-state' };
    db.transaction(() => {
      db.prepare(
        `UPDATE closure_craft_card SET status='rejected', reject_reason=?, updated_at=? WHERE card_id=?`,
      ).run(opts.rejectReason ?? null, new Date().toISOString(), cardId);
      deleteCardEntryRow(db, cardId);
    })();
  } else {
    if (existing.card.status !== 'rejected') return { ok: false, error: 'invalid-state' };
    db.transaction(() => {
      db.prepare(
        `UPDATE closure_craft_card SET status='pending_review', reject_reason=NULL, updated_at=? WHERE card_id=?`,
      ).run(new Date().toISOString(), cardId);
      deleteCardEntryRow(db, cardId); // belt（状态机路径本已无行）
    })();
  }
  const updated = getCraftCard(cardId);
  return updated === null ? { ok: false, error: 'not-found' } : { ok: true, card: updated };
}

/**
 * 讲法级 rank 改级（craft:card-review 的 teachingRank 面）。rank 是讲法级状态（人审动作族）——
 * **不触发卡降级**、不动 entry/claim 向量（检索 body 全量讲法，rank 过滤归命中渲染 W4）、
 * 不动 updated_at（与内容编辑〔降级〕和状态动作〔队列相关〕都正交）。note 省略 = 保留原备注。
 */
export function updateCraftTeachingRank(
  cardId: string,
  teachingId: string,
  rank: CraftTeachingRank,
  note?: string,
): CraftCardMutationResult {
  const db = getDb();
  const existing = getCraftCardRow(cardId);
  if (existing === null) return { ok: false, error: 'not-found' };
  const idx = existing.card.teachings.findIndex((t) => t.teachingId === teachingId);
  if (idx === -1) return { ok: false, error: 'not-found' };
  const teachings = [...existing.card.teachings];
  const prev = teachings[idx]!;
  teachings[idx] = { ...prev, rank, ...(note !== undefined ? { note } : {}) };
  const parsed = craftCardSchema.safeParse({ ...existing.card, teachings });
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  db.prepare('UPDATE closure_craft_card SET teachings_json=? WHERE card_id=?').run(
    JSON.stringify(teachings),
    cardId,
  );
  return { ok: true, card: parsed.data };
}

/**
 * 材料的已落讲法 teachingId 全集（E10.3b W5 导出——P6 拆书落卡的幂等面：候选 teachingId 命中
 * 即跳过，重跑/续跑零重复挂载）。**JSON 键值对锚定预筛（CR-13）**：`"materialId":"<id>"` 精确
 * 键值模式——裸子串 LIKE 会把「引文/hash/note 文本里出现 materialId 字样」的行误当已落库，
 * 合法重落被静默跳过 = 无计数数据丢失；预筛之上再 per-teaching `materialId` 严配（引文文本
 * 恰含该 JSON 键值字面量的极端形态兜底）。坏行跳过（tolerant 惯例——幂等面按能读到的讲法算，
 * 读不到的行不阻塞）。
 */
export function listCraftTeachingIdsByMaterial(materialId: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT teachings_json FROM closure_craft_card WHERE teachings_json LIKE ? ESCAPE '\\'",
    )
    .all(`%"materialId":"${escapeLike(materialId)}"%`) as Array<{
    teachings_json: string;
  }>;
  const ids: string[] = [];
  for (const r of rows) {
    try {
      const teachings = JSON.parse(r.teachings_json) as CraftTeaching[];
      if (!Array.isArray(teachings)) continue;
      for (const t of teachings) {
        if (
          t !== null &&
          typeof t === 'object' &&
          t.materialId === materialId &&
          typeof t.teachingId === 'string'
        ) {
          ids.push(t.teachingId);
        }
      }
    } catch {
      // 坏行跳过（tolerant）。
    }
  }
  return ids;
}

// ── 删卡（清理面——rejected 行不物理删，此为显式 purge：测试/未来清理入口）──

/**
 * 硬删一张卡的全部三面：卡行 + entry 检索行 + #claim 向量行（单事务）。**领地纪律（F-01
 * 反向）**：entry/vec 删除按 `card:` craft_id 精确匹配——craft 文档行 / 材料 chunk 行不在
 * 卡删除的领地，永不误删。
 */
export function deleteCraftCardRow(cardId: string): void {
  const db = getDb();
  db.transaction(() => {
    deleteCardEntryRow(db, cardId);
    if (isSqliteVecAvailable()) {
      db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(cardCraftId(cardId));
    }
    db.prepare('DELETE FROM closure_craft_card WHERE card_id=?').run(cardId);
  })();
}

// ── 讲法级 stale 标记（F-07 三触发的公共面——E10.2b W3）──

/**
 * 把某材料的**全部讲法**置 stale=true（F-07 三触发公共面：①材料原件变更重蒸馏〔落卡事务内——
 * 旧讲法 stale + 新讲法同事务落〕②派生 .md 校对编辑〔蒸馏台账编排的派生已变更路径〕③材料删除
 * 四清〔materialIndexer.deleteMaterialRows 尾部钩子〕）。
 *
 * - **卡级状态不动**（design §1.1 状态机表：讲法级 stale 新增到 verified 卡不降级卡——讲法级
 *   复核项进队列，卡级状态不动）；claim 向量不动（condensed 未变——去重面不收缩）。
 * - entry 检索行不动（verified 卡 body 含讲法引文——stale 不改引文文本，检索面无漂移）。
 * - updated_at bump（讲法 stale 是队列可见事件——staleTeachingCount 徽章 + updated-desc 排序
 *   把复核项顶到人眼前）。
 * - 容错：坏 teachings_json（手改库）跳过该卡不抛（tolerant row 惯例）。返回触及卡数。
 */
export function markCraftTeachingsStaleByMaterial(materialId: string): number {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT card_id, teachings_json FROM closure_craft_card WHERE teachings_json LIKE ? ESCAPE '\\'",
    )
    .all(`%${escapeLike(materialId)}%`) as Array<{
    card_id: string;
    teachings_json: string;
  }>;
  const update = db.prepare(
    'UPDATE closure_craft_card SET teachings_json=?, updated_at=? WHERE card_id=?',
  );
  let touched = 0;
  db.transaction(() => {
    for (const r of rows) {
      try {
        const teachings = JSON.parse(r.teachings_json) as CraftTeaching[];
        if (!Array.isArray(teachings)) continue;
        let changed = false;
        const next = teachings.map((t) => {
          if (
            t !== null &&
            typeof t === 'object' &&
            t.materialId === materialId &&
            t.stale !== true
          ) {
            changed = true;
            return { ...t, stale: true };
          }
          return t;
        });
        if (!changed) continue;
        update.run(JSON.stringify(next), new Date().toISOString(), r.card_id);
        touched += 1;
      } catch {
        // 坏行跳过（tolerant——stale 标记是 best-effort 联动，不阻调用方）。
      }
    }
  })();
  return touched;
}

// ── sweep（F-05 模型迁移——reindexAllCraft 同点位收尾）──

/** 探针体回退源（reindexAllCraft 零文档但有卡时用卡 condensed 探 dim）。 */
export function firstCraftCardCondensed(): string | null {
  const db = getDb();
  let rows: Array<{ claim_json: string }>;
  try {
    rows = db.prepare('SELECT claim_json FROM closure_craft_card LIMIT 8').all() as Array<{
      claim_json: string;
    }>;
  } catch {
    return null;
  }
  for (const r of rows) {
    try {
      const claim = JSON.parse(r.claim_json) as { condensed?: unknown };
      if (typeof claim.condensed === 'string' && claim.condensed.trim()) return claim.condensed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 卡向量迁移 sweep（F-05）：**恒 force** 重嵌全部卡的 #claim 向量（sweep 即 prevailing 的合法
 * 翻转——同 reindexAllCraft 之于 reindexCraftDoc），entry 检索行按卡状态重建（verified 重写
 * 含新 model 记账；其余幂等清行）。pending/rejected 卡同嵌（去重面常驻全卡）。卡内容未变——
 * **不 bump updated_at**（队列排序稳定，只更新向量记账面）。per-card 容错（单卡失败 continue，
 * mirror reindexAllCraft per-doc 循环）。
 *
 * 返回**实际重嵌成功**卡数（CR-2b-16）：vec 不可用 / embed 失败 / dim 不符的 pending 记账
 * 不计入（零重嵌不报成功——消费方 reindexAllCraft 以此数回报 cardsReembedded）；entry 行
 * 重建照常执行只是不计入返回值。
 *
 * vec 扩展不可用：无向量可写（恒计 0）——entry 行按既有 claim 记账镜像重写（FTS 面保持新鲜）。
 */
export async function reindexAllCards(deps: CraftCardIndexDeps = {}): Promise<number> {
  const db = getDb();
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embed = deps.embed ?? defaultEmbed;
  const model = resolveModel();
  if (!model) return 0;
  let ids: Array<{ card_id: string }>;
  try {
    ids = db.prepare('SELECT card_id FROM closure_craft_card').all() as Array<{
      card_id: string;
    }>;
  } catch {
    return 0;
  }
  const vecAvailable = isSqliteVecAvailable();
  const vecDim = getCurrentCraftVecDim(db);
  let reembedded = 0;
  for (const { card_id } of ids) {
    const row = getCraftCardRow(card_id);
    if (row === null) continue;
    try {
      let vector: number[] | null = null;
      if (vecAvailable && vecDim !== null && row.card.claim.condensed.trim()) {
        try {
          const arr = await embed(model, row.card.claim.condensed);
          if (arr.length === vecDim) {
            vector = arr;
          } else {
            getLogger().warn(
              {
                cardId: card_id,
                expected: vecDim,
                got: arr.length,
                model: model.modelId,
              },
              'craft card sweep: dim mismatch - claim vector pending',
            );
          }
        } catch (err) {
          getLogger().warn(
            {
              err: err instanceof Error ? err.message : String(err),
              cardId: card_id,
            },
            'craft card sweep: embed failed - claim vector pending',
          );
        }
      }
      let vectorWritten = false;
      db.transaction(() => {
        if (vecAvailable) {
          // 无条件删再按落地面写（CR-craft-kb-009；DROP 重建后理论为空，防半程残留）。
          db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(cardCraftId(card_id));
          // CR-2b-7 dim 复验（sweep 同款）：循环中途表 dim 被换 → 不写行 + pending 记账。
          if (vector !== null && claimVecDimOk(db, vector)) {
            insertClaimVecRow(db, row.card, vector);
            vectorWritten = true;
          }
        }
        const claimModel = vecAvailable ? (vectorWritten ? model.modelId : null) : row.claimModel;
        const claimDim = vecAvailable ? (vectorWritten ? vector!.length : null) : row.claimDim;
        db.prepare('UPDATE closure_craft_card SET claim_model=?, claim_dim=? WHERE card_id=?').run(
          claimModel,
          claimDim,
          card_id,
        );
        rewriteCraftCardEntryRow(card_id);
      })();
      if (vectorWritten) reembedded++;
    } catch (err) {
      getLogger().warn(
        {
          err: err instanceof Error ? err.message : String(err),
          cardId: card_id,
        },
        'craft card sweep: per-card reindex failed - continuing',
      );
    }
  }
  return reembedded;
}
