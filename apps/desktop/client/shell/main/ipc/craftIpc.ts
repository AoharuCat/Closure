/**
 * E10.2b（task 09-05）W3+W5：手艺卡/蒸馏管线 IPC——十一 invoke 通道。
 *
 * - `craft:distill-run {materialIds[]}`（模式 A 部分成功语义）：逐材料同步过**便宜门**
 *   （evaluateCraftDistillGateSync——not-found/not-ready/already-running 三档跳过逐份回报；
 *   hash-unchanged 幂等判定含 readFileSync+SHA256，归 batch worker 异步路径，CR-2b-15）
 *   → 过门项占位在途槽 → 后台批量执行（craftDistillPipeline.runCraftDistillBatch
 *   fire-and-forget——进度经 craft:distill-progress 事件推送，台账/卡是真相源）。派生 .md 已
 *   变更的材料过门入队（批内走讲法 stale 复核路径 F-07——对 UI 是「已处理」非跳过）。
 * - `craft:distill-status {materialIds?}`（读面 plain 返回，mirror materials:list）：台账清单
 *   （材料页/手艺页徽章取数面；省略 materialIds = 全部行）。
 *
 * W5 九通道（载荷契约单源 ipc.ts「E10.2b Wave 1」段；错误模式 mirror 材料管理面）：
 * - `craft:card-list {status?/category?/termId?/tags?/materialId?/sort?}` → CraftCardSummary[]
 *   （读面 plain 返回；过滤参数透传 listCraftCards——全字段可选 AND + tags OR + 置信排序，
 *   分页 W2 API 无此面即全量返回）。
 * - `craft:card-get {cardId}` → CraftCard | null（全卡——四件套全文/讲法/锚点）。
 * - `craft:card-patch {cardId, patch}` → 模式 A。**编辑即降级在 repository patchCraftCard 执行**
 *   （任何实际写库 → status='pending_review' + entry 检索行删，F-06）——本 handler 只做入参
 *   校验与错误映射（'rejected-card' 等 error 码与契约对齐）。
 * - `craft:card-review {cardId, action?, teachingRank?}` → 模式 A。状态机动作（verify 写 entry /
 *   reject 删 entry / recover 救回）+ 讲法级 rank 改（**不触发卡降级不动 entry**——讲法级状态
 *   与内容编辑/状态动作都正交）。action 与 teachingRank 至少其一。
 * - `craft:merge-review-list {includeResolved?}` → CraftMergeReview[]（默认仅待审）。
 * - `craft:merge-review-resolve {reviewId, action, note?}` → 模式 A。三动作执行面
 *   （**卡动作 + review 落账单事务**，CR-2b-1——repository 事务化入口
 *   runCraftMergeResolveTransaction：resolution 幂等闸在事务内，并发裁决竞态 →
 *   invalid-state 且卡动作一并回滚，无幻影卡/讲法残留）：merge = 讲法 append 既有卡
 *   （teachingId 幂等键派生 + 卡回 pending_review）+ review 落账 / independent = 新建卡
 *   （pending_review 起板 + #claim 向量预嵌；newClaim.termId 经 resolveTermTombstone 墓碑
 *   链跟随，CR-2b-9）/ dismiss = 丢弃留痕 + review 落账。已裁决再 resolve = `invalid-state`。
 * - `craft:term-list {status?/category?}` → CraftTerm[]（含 pending——待并词表视图；懒种子）。
 * - `craft:term-approve {termId}` → 模式 A（pending → active）。
 * - `craft:term-merge {termId, mergeIntoTermId}` → 模式 A（卡改挂 + category 跟随 + entry 重写
 *   归 mergeCraftTerm；movedCardCount 回馈「N 张卡已改挂」）。
 *
 * 错误模式（ipc-handlers spec + W1 契约头注）：读面（list/get 两族）plain 返回、坏参 = 模式 B
 * throw（不变量——mirror materialIpc listMaterials/getMaterial）；写面（patch/review/resolve/
 * term 三写）= 模式 A 判别联合 + 稳定 error code（含 operation-failed belt——repository 抛错
 * 兜底）。id 形态预校验：card-/term-/mrev-/tea- 全机器生成，坏形态 = renderer bug → 读面 throw /
 * 写面 invalid-input，与「不存在 = not-found（用户态）」显式区分。
 *
 * 注册纪律：registerAllIpc 恰调一次（同 channel 二次 ipcMain.handle 会抛错——spec/shell/
 * ipc-handlers.md）；无窗口面（progress 推送走 craftDistillNotify 全窗广播，不经本注册器）。
 *
 * expected_downstream_consumers:
 * - W5 手艺页 + 材料页联动（队列/卡编辑/并排对比/废弃区/词表视图——本面唯一设计消费者）。
 */
import { randomBytes } from 'node:crypto';
import { ipcMain } from 'electron';
import type {
  CraftCard,
  CraftCardListInput,
  CraftCardPatchResult,
  CraftCardReviewResult,
  CraftCardSort,
  CraftCardStatus,
  CraftCardSummary,
  CraftCardCategory,
  CraftDistillLedger,
  CraftDistillRunResult,
  CraftDistillSkipReason,
  CraftMergeReview,
  CraftMergeReviewAction,
  CraftMergeReviewResolveResult,
  CraftTerm,
  CraftTermApproveResult,
  CraftTermMergeResult,
  CraftTermStatus,
  CraftTeaching,
  CraftTeachingRank,
} from '@orison/shared-contracts';
import {
  CRAFT_CARD_CATEGORY_VALUES,
  CRAFT_CARD_STATUSES,
  CRAFT_TEACHING_RANKS,
  CRAFT_TERM_STATUSES,
} from '@orison/shared-contracts';
import {
  claimCraftDistillSlot,
  deriveCardTitle,
  evaluateCraftDistillGateSync,
  resolveTermTombstone,
  runCraftDistillBatch,
  teachingIdFor,
} from './toolHandlers/craftDistillPipeline';
import {
  getCraftCard,
  getCraftCardRow,
  listCraftCards,
  patchCraftCard,
  reviewCraftCard,
  runCraftMergeResolveTransaction,
  updateCraftTeachingRank,
  type CraftCardMutationResult,
  type CraftCardPatch,
  type CraftMergeResolveCardAction,
} from '../db/closureCraftCardRepository';
import {
  approveCraftTerm,
  listCraftTerms,
  mergeCraftTerm,
} from '../db/closureCraftTermRepository';
import {
  getCraftMergeReview,
  listCraftMergeReviews,
} from '../db/closureCraftMergeReviewRepository';
import { listCraftDistillLedgers } from '../db/closureCraftDistillRepository';
import { getLogger } from '../logger';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 入参宽容归一（mirror materialIpc coerceXxx——renderer 传错形态是预期输入非攻击面）。 */
function coerceMaterialIdsInput(raw: unknown): string[] | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { materialIds } = raw as { materialIds?: unknown };
  if (!Array.isArray(materialIds)) return null;
  const ids = materialIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  return ids.length > 0 ? ids : null;
}

// ── id 形态预校验（全机器生成——坏形态 = renderer bug，与 not-found〔用户态〕显式区分）──

const CARD_ID_RE = /^card-[0-9a-f]{12}$/;
const TERM_ID_RE = /^term-[0-9a-f]{8}$/;
const REVIEW_ID_RE = /^mrev-[0-9a-f]{12}$/;
const TEACHING_ID_RE = /^tea-[0-9a-f]{12}$/;
const MATERIAL_ID_RE = /^mat-[0-9a-f]{12}$/;

function coerceIdField(raw: unknown, field: string): { id?: string; error?: string } {
  if (raw === null || typeof raw !== 'object') return { error: `需要 ${field}` };
  const value = (raw as Record<string, unknown>)[field];
  if (value === undefined) return { error: `需要 ${field}` };
  if (typeof value !== 'string' || value.trim().length === 0) return { error: `${field} 须为非空字符串` };
  return { id: value.trim() };
}

function coerceOptionalId(raw: unknown, field: string, re: RegExp): { id?: string; error?: string } {
  if (raw === null || typeof raw !== 'object') return {};
  const value = (raw as Record<string, unknown>)[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return { error: `${field} 须为字符串` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { error: `${field} 须为非空字符串` };
  if (!re.test(trimmed)) return { error: `${field} 形态非法（${trimmed.slice(0, 32)}）` };
  return { id: trimmed };
}

// ── W5 读面入参归一（值严格：形态宽容〔缺省=不过滤〕，在场值必须合法——显式坏参优于静默滤丢）──

const CARD_SORTS: readonly CraftCardSort[] = ['confidence-asc', 'updated-desc', 'created-desc'];

function coerceCardListInput(raw: unknown): CraftCardListInput {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object') throw new Error('craft:card-list 入参须为对象');
  const source = raw as Record<string, unknown>;
  const input: CraftCardListInput = {};
  if (source.status !== undefined) {
    if (!(CRAFT_CARD_STATUSES as readonly string[]).includes(source.status as string)) {
      throw new Error(`craft:card-list status 须为 ${CRAFT_CARD_STATUSES.join('|')}（收到：${String(source.status)}）`);
    }
    input.status = source.status as CraftCardStatus;
  }
  if (source.category !== undefined) {
    if (!(CRAFT_CARD_CATEGORY_VALUES as readonly string[]).includes(source.category as string)) {
      throw new Error(`craft:card-list category 须为 13 大类 slug 之一（收到：${String(source.category)}）`);
    }
    input.category = source.category as CraftCardCategory;
  }
  const termId = coerceOptionalId(source, 'termId', TERM_ID_RE);
  if (termId.error !== undefined) throw new Error(`craft:card-list ${termId.error}`);
  if (termId.id !== undefined) input.termId = termId.id;
  if (source.tags !== undefined) {
    if (!Array.isArray(source.tags) || source.tags.some((t) => typeof t !== 'string')) {
      throw new Error('craft:card-list tags 须为字符串数组');
    }
    // CR-2b-26 值归一（mirror searchCraft 防御归一——命中渲染展示 `#tag` 形态，UI chips 点击
    // 过滤把展示形态原样传回是自然输入）：剥前导 # + trim + 去空 + 去重；归一后全空 = 无该
    // 过滤项（不 throw——renderer 值抖动是预期输入非攻击面，mirror coerceMaterialIdsInput）。
    const tags = Array.from(
      new Set(
        (source.tags as string[])
          .map((t) => t.trim().replace(/^#/, ''))
          .filter((t) => t.length > 0),
      ),
    );
    if (tags.length > 0) input.tags = tags;
  }
  const materialId = coerceOptionalId(source, 'materialId', MATERIAL_ID_RE);
  if (materialId.error !== undefined) throw new Error(`craft:card-list ${materialId.error}`);
  if (materialId.id !== undefined) input.materialId = materialId.id;
  if (source.sort !== undefined) {
    if (!(CARD_SORTS as readonly string[]).includes(source.sort as string)) {
      throw new Error(`craft:card-list sort 须为 ${CARD_SORTS.join('|')}（收到：${String(source.sort)}）`);
    }
    input.sort = source.sort as CraftCardSort;
  }
  return input;
}

function coerceTermListInput(raw: unknown): { status?: CraftTermStatus; category?: CraftCardCategory } {
  if (raw === null || raw === undefined || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const input: { status?: CraftTermStatus; category?: CraftCardCategory } = {};
  if (source.status !== undefined) {
    if (!(CRAFT_TERM_STATUSES as readonly string[]).includes(source.status as string)) {
      throw new Error(`craft:term-list status 须为 ${CRAFT_TERM_STATUSES.join('|')}（收到：${String(source.status)}）`);
    }
    input.status = source.status as CraftTermStatus;
  }
  if (source.category !== undefined) {
    if (!(CRAFT_CARD_CATEGORY_VALUES as readonly string[]).includes(source.category as string)) {
      throw new Error(`craft:term-list category 须为 13 大类 slug 之一（收到：${String(source.category)}）`);
    }
    input.category = source.category as CraftCardCategory;
  }
  return input;
}

// ── W5 写面入参归一（校验通过才落 repository——错误码与契约对齐）──

/** 卡 patch 字段校验 + 归一（trim 校验不静默改值——值原样透传，schema 层守形）。 */
function coerceCardPatch(raw: unknown): { patch?: CraftCardPatch; error?: string } {
  if (raw === null || typeof raw !== 'object') return { error: '需要 patch 对象' };
  const rawPatch = (raw as { patch?: unknown }).patch;
  if (rawPatch === null || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    return { error: '需要 patch 对象' };
  }
  const source = rawPatch as Record<string, unknown>;
  const patch: CraftCardPatch = {};
  if ('title' in source) {
    if (typeof source.title !== 'string' || source.title.trim().length === 0) {
      return { error: 'title 须为非空字符串' };
    }
    patch.title = source.title;
  }
  if ('termId' in source) {
    if (typeof source.termId !== 'string' || !TERM_ID_RE.test(source.termId)) {
      return { error: 'termId 形态非法（须 term-<8hex>）' };
    }
    patch.termId = source.termId;
  }
  if ('tags' in source) {
    if (
      !Array.isArray(source.tags) ||
      source.tags.some((t) => typeof t !== 'string' || t.trim().length === 0)
    ) {
      return { error: 'tags 须为非空字符串数组' };
    }
    patch.tags = source.tags as string[];
  }
  if ('dispute' in source) {
    if (typeof source.dispute !== 'boolean') return { error: 'dispute 须为 boolean' };
    patch.dispute = source.dispute;
  }
  if ('claim' in source) {
    const claim = source.claim;
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      return { error: 'claim 须为对象' };
    }
    const claimPatch: NonNullable<CraftCardPatch['claim']> = {};
    const c = claim as Record<string, unknown>;
    if ('condensed' in c) {
      if (typeof c.condensed !== 'string' || c.condensed.trim().length === 0) {
        return { error: 'claim.condensed 须为非空字符串' };
      }
      claimPatch.condensed = c.condensed;
    }
    for (const field of ['points', 'scenarios', 'counterexamples'] as const) {
      if (!(field in c)) continue;
      const items = c[field];
      if (
        !Array.isArray(items) ||
        items.some((x) => typeof x !== 'string' || x.trim().length === 0)
      ) {
        return { error: `claim.${field} 须为非空字符串数组` };
      }
      claimPatch[field] = items as string[];
    }
    patch.claim = claimPatch;
  }
  if (Object.keys(patch).length === 0) return { error: 'patch 须至少含一个字段' };
  return { patch };
}

const CARD_REVIEW_ACTIONS: ReadonlySet<string> = new Set(['verify', 'reject', 'recover']);

interface CoercedCardReview {
  action?: 'verify' | 'reject' | 'recover';
  rejectReason?: string;
  teachingRank?: { teachingId: string; rank: CraftTeachingRank; note?: string };
}

function coerceCardReview(raw: unknown): { review?: CoercedCardReview; error?: string } {
  if (raw === null || typeof raw !== 'object') return { error: '入参须为对象' };
  const source = raw as Record<string, unknown>;
  const out: CoercedCardReview = {};
  if (source.action !== undefined) {
    if (typeof source.action !== 'string' || !CARD_REVIEW_ACTIONS.has(source.action)) {
      return { error: `action 须为 verify|reject|recover（收到：${String(source.action)}）` };
    }
    out.action = source.action as CoercedCardReview['action'];
  }
  if (source.rejectReason !== undefined && source.rejectReason !== null) {
    if (typeof source.rejectReason !== 'string') return { error: 'rejectReason 须为字符串' };
    const trimmed = source.rejectReason.trim();
    if (trimmed.length > 0) out.rejectReason = trimmed;
  }
  if (source.teachingRank !== undefined) {
    const tr = source.teachingRank;
    if (tr === null || typeof tr !== 'object' || Array.isArray(tr)) {
      return { error: 'teachingRank 须为对象' };
    }
    const t = tr as Record<string, unknown>;
    if (typeof t.teachingId !== 'string' || !TEACHING_ID_RE.test(t.teachingId)) {
      return { error: 'teachingRank.teachingId 形态非法（须 tea-<12hex>）' };
    }
    if (typeof t.rank !== 'string' || !(CRAFT_TEACHING_RANKS as readonly string[]).includes(t.rank)) {
      return { error: `teachingRank.rank 须为 ${CRAFT_TEACHING_RANKS.join('|')}（收到：${String(t.rank)}）` };
    }
    const rankEntry: { teachingId: string; rank: CraftTeachingRank; note?: string } = {
      teachingId: t.teachingId,
      rank: t.rank as CraftTeachingRank,
    };
    if (t.note !== undefined && t.note !== null) {
      if (typeof t.note !== 'string') return { error: 'teachingRank.note 须为字符串' };
      const note = t.note.trim();
      if (note.length > 0) rankEntry.note = note;
    }
    out.teachingRank = rankEntry;
  }
  if (out.action === undefined && out.teachingRank === undefined) {
    return { error: 'action 与 teachingRank 至少其一' };
  }
  return { review: out };
}

const MERGE_REVIEW_ACTIONS: ReadonlySet<string> = new Set(['merge', 'independent', 'dismiss']);

// ── merge resolve 三动作的卡面产物构造 ──
// （卡招式名 title 派生 = craftDistillPipeline.deriveCardTitle 单源 import——CR-2b-18，
//   彼处曾有手抄副本「两处同步维护」，已删换 import。）

/** 讲法构造（merge/independent 共用——teachingId 幂等键派生自 newClaim 三元组，重放同 id）。 */
function teachingFromNewClaim(
  review: CraftMergeReview,
  note: string | null,
): CraftTeaching {
  const nc = review.newClaim;
  return {
    teachingId: teachingIdFor(nc.materialId, nc.materialContentHash, nc.quote),
    materialId: nc.materialId,
    materialContentHash: nc.materialContentHash,
    author: nc.author,
    quote: nc.quote,
    anchor: nc.anchor,
    rank: 'normal',
    note,
    stale: false,
    // E10.3b W7 additive 透传（absent = 10.2 蒸馏语义不变——旧行零迁移）：decon 实例经
    // 并排裁决成卡时 originKind/bookTitle/evidence 不丢（AC4 语义完整性）。
    ...(nc.originKind !== undefined ? { originKind: nc.originKind } : {}),
    ...(nc.bookTitle !== undefined ? { bookTitle: nc.bookTitle } : {}),
    ...(nc.evidence !== undefined ? { evidence: nc.evidence } : {}),
    // E10.4 W3 additive 透传（absent = unspecified 材料蒸馏语义/旧行零迁移——mirror
    // originKind）：来源三级经裁决成卡不丢（人审页三色 tier 徽章消费）。
    ...(nc.originTier !== undefined ? { originTier: nc.originTier } : {}),
  };
}

/**
 * repository result → craft:card-patch 契约 result 的 error 码面适配：patchCraftCard 不产
 * 'invalid-state'（编辑路径无状态机转换），契约（CraftCardPatchResult）也无此码——union 其余
 * 成员直通。invalid-state 是防御唯一可达路径（repository 未来若新增该码）：如实映射
 * operation-failed，坏值可见不吞（CR-2b-28：显式单成员判定替代原 switch + 不可达 default）。
 */
function toPatchResult(res: CraftCardMutationResult): CraftCardPatchResult {
  if (res.ok) return res;
  if (res.error === 'invalid-state') {
    return { ok: false, error: 'operation-failed', message: '意外错误码 invalid-state（patch 路径不产它）' };
  }
  return { ok: false, error: res.error };
}

/**
 * repository result → 契约 result 的 error 码面适配：card-review 两执行面（状态机
 * reviewCraftCard + 讲法级 updateCraftTeachingRank）均不产 'rejected-card'，契约
 * （CraftCardReviewResult）也无此码——其余成员直通；rejected-card 为防御唯一可达路径
 * （同上，CR-2b-28）。
 */
function mapMutationError(
  res: Exclude<CraftCardMutationResult, { ok: true }>,
): { ok: false; error: 'not-found' | 'invalid-input' | 'invalid-state' | 'operation-failed'; message?: string } {
  if (res.error === 'rejected-card') {
    return { ok: false, error: 'operation-failed', message: '意外错误码 rejected-card（card-review 路径不产它）' };
  }
  return { ok: false, error: res.error };
}

// ── IPC 工厂（deps 注入，零 LLM/零窗口可测——mirror createMaterialIpcHandlers）──

export interface CraftIpcHandlers {
  distillRun(rawInput: unknown): Promise<CraftDistillRunResult>;
  distillStatus(rawInput: unknown): Promise<CraftDistillLedger[]>;
  cardList(rawInput: unknown): Promise<CraftCardSummary[]>;
  cardGet(rawInput: unknown): Promise<CraftCard | null>;
  cardPatch(rawInput: unknown): Promise<CraftCardPatchResult>;
  cardReview(rawInput: unknown): Promise<CraftCardReviewResult>;
  mergeReviewList(rawInput: unknown): Promise<CraftMergeReview[]>;
  mergeReviewResolve(rawInput: unknown): Promise<CraftMergeReviewResolveResult>;
  termList(rawInput: unknown): Promise<CraftTerm[]>;
  termApprove(rawInput: unknown): Promise<CraftTermApproveResult>;
  termMerge(rawInput: unknown): Promise<CraftTermMergeResult>;
}

export interface CraftIpcDeps {
  /** 批量执行面（默认 runCraftDistillBatch；测试 spy/短路注入）。 */
  runBatch?: typeof runCraftDistillBatch;
}

export function createCraftIpcHandlers(deps: CraftIpcDeps = {}): CraftIpcHandlers {
  const runBatch = deps.runBatch ?? runCraftDistillBatch;
  return {
    /**
     * `craft:distill-run`——批量入队：同步过门逐份回报跳过原因；过门项后台蒸馏（相位/终态经
     * craft:distill-progress 推送；台账是查询真相源——事件可丢，读侧 distill-status 兜底）。
     *
     * CR-2b-4 槽补偿：claim 循环的派发收在 **finally**——gate 读 db 意外抛错（坏行等）中断
     * 循环时，已占位材料的槽若不派发将永久 already-running（释放只发生在批量 per-item
     * finally）。对预占位材料批量循环**零 gate 调用**（早退源被结构性绕开），per-item finally
     * 必达即释放；中断本身如实回报 operation-failed。
     */
    async distillRun(rawInput: unknown): Promise<CraftDistillRunResult> {
      const materialIds = coerceMaterialIdsInput(rawInput);
      if (materialIds === null) {
        return { ok: false, error: 'invalid-input', message: '需要非空 materialIds 字符串数组' };
      }
      const queued: string[] = [];
      const skipped: Array<{ materialId: string; reason: CraftDistillSkipReason }> = [];
      try {
        for (const materialId of materialIds) {
          // CR-2b-15：invoke 同步循环用**便宜门**（零文件 IO——readFileSync+SHA256 的双 hash
          // 执行体归 batch worker 异步路径 per-item，N 份派生读取不阻塞 handler）。
          const gate = evaluateCraftDistillGateSync(materialId);
          if (gate.ok) {
            // 同步段内 check+占位（单线程无竞态窗口）；释放归批量 per-item finally。
            claimCraftDistillSlot(materialId);
            queued.push(materialId);
          } else {
            skipped.push({ materialId, reason: gate.reason });
          }
        }
      } catch (err) {
        getLogger().warn(
          { err: errMsg(err), queued: [...queued] },
          'craft:distill-run gate loop interrupted - dispatching claimed items, returning operation-failed',
        );
        return { ok: false, error: 'operation-failed', message: `蒸馏入队中断：${errMsg(err)}` };
      } finally {
        // 唯一派发点（正常收尾与中断补偿共用）：已 claim 项恒交批量执行。
        if (queued.length > 0) {
          // 后台执行（不等蒸馏完成——invoke 即回，进度走事件）；belt catch（批内 per-item 已
          // never-throws，且预占位材料批内不调 gate——早退不可达，槽释放在 per-item finally）。
          void runBatch(queued).catch((err) => {
            getLogger().warn(
              { err: errMsg(err) },
              'craft:distill-run background batch threw (belt - per-item failures already landed in ledger)',
            );
          });
        }
      }
      return { ok: true, queued, skipped };
    },

    /**
     * `craft:distill-status`——台账清单。materialIds 省略 = 全部行（徽章面兜底取数）；
     * **键在场但形态坏**（非数组）= 显式忽略该过滤键返回全部行 + warn 留痕（CR-2b-26：
     * 无过滤 = 全部是保留语义，忽略是注记过的显式决定——非静默吞坏参）；数组内混非字符串
     * 项过滤掉，有效 id 空集同无过滤。
     */
    async distillStatus(rawInput: unknown): Promise<CraftDistillLedger[]> {
      let materialIds: string[] | undefined;
      if (rawInput !== null && typeof rawInput === 'object') {
        const { materialIds: rawIds } = rawInput as { materialIds?: unknown };
        if (Array.isArray(rawIds)) {
          const ids = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
          if (ids.length > 0) materialIds = ids;
        } else if (rawIds !== undefined && rawIds !== null) {
          getLogger().warn(
            { type: typeof rawIds },
            'craft:distill-status materialIds 形态坏——忽略该过滤键（返回全部台账行）',
          );
        }
      }
      return listCraftDistillLedgers(materialIds);
    },

    /** `craft:card-list`——队列过滤透传 + 摘要投影（读面 plain 返回；坏枚举 throw 模式 B）。 */
    async cardList(rawInput: unknown): Promise<CraftCardSummary[]> {
      return listCraftCards(coerceCardListInput(rawInput));
    },

    /** `craft:card-get`——整卡（四件套全文/讲法/锚点；未知 id → null）。 */
    async cardGet(rawInput: unknown): Promise<CraftCard | null> {
      const { id, error } = coerceIdField(rawInput, 'cardId');
      if (error !== undefined) throw new Error(`craft:card-get ${error}`);
      if (!CARD_ID_RE.test(id!)) throw new Error(`craft:card-get cardId 形态非法（须 card-<12hex>）`);
      return getCraftCard(id!);
    },

    /**
     * `craft:card-patch`——卡内容编辑（**编辑即降级执行点在 patchCraftCard**：任何实际写库 →
     * status 回 pending_review + entry 检索行删）。本 handler 校验入参 + 映射 repository result
     * （error 码与契约对齐；db 抛错 → operation-failed belt）。
     */
    async cardPatch(rawInput: unknown): Promise<CraftCardPatchResult> {
      const { id, error } = coerceIdField(rawInput, 'cardId');
      if (error !== undefined) return { ok: false, error: 'invalid-input', message: error };
      if (!CARD_ID_RE.test(id!)) {
        return { ok: false, error: 'invalid-input', message: 'cardId 形态非法（须 card-<12hex>）' };
      }
      const { patch, error: patchError } = coerceCardPatch(rawInput);
      if (patchError !== undefined || patch === undefined) {
        return { ok: false, error: 'invalid-input', message: patchError ?? 'patch 形态非法' };
      }
      try {
        return toPatchResult(await patchCraftCard(id!, patch));
      } catch (err) {
        getLogger().warn({ err: errMsg(err), cardId: id }, 'craft:card-patch repository threw');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
    },

    /**
     * `craft:card-review`——状态机动作（verify 写 entry / reject 删 entry / recover 救回）+
     * 讲法级 rank 改（不降级不动 entry）。执行序：rank 先（讲法级小动作失败不落状态机大动作），
     * action 后——两者均重读卡行无 lost-update。
     */
    async cardReview(rawInput: unknown): Promise<CraftCardReviewResult> {
      const { id, error } = coerceIdField(rawInput, 'cardId');
      if (error !== undefined) return { ok: false, error: 'invalid-input', message: error };
      if (!CARD_ID_RE.test(id!)) {
        return { ok: false, error: 'invalid-input', message: 'cardId 形态非法（须 card-<12hex>）' };
      }
      const { review, error: reviewError } = coerceCardReview(rawInput);
      if (reviewError !== undefined || review === undefined) {
        return { ok: false, error: 'invalid-input', message: reviewError ?? '入参形态非法' };
      }
      try {
        if (review.teachingRank !== undefined) {
          const rankRes = updateCraftTeachingRank(
            id!,
            review.teachingRank.teachingId,
            review.teachingRank.rank,
            review.teachingRank.note,
          );
          if (!rankRes.ok) return mapMutationError(rankRes);
        }
        if (review.action !== undefined) {
          const actionRes = await reviewCraftCard(id!, review.action, {
            rejectReason: review.rejectReason,
          });
          if (!actionRes.ok) return mapMutationError(actionRes);
        }
        const card = getCraftCard(id!);
        return card === null
          ? { ok: false, error: 'not-found', message: '回读卡失败（并发删除？）' }
          : { ok: true, card };
      } catch (err) {
        getLogger().warn({ err: errMsg(err), cardId: id }, 'craft:card-review repository threw');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
    },

    /** `craft:merge-review-list`——并排任务队列（默认仅待审；includeResolved 含已裁决审计回看）。 */
    async mergeReviewList(rawInput: unknown): Promise<CraftMergeReview[]> {
      let includeResolved = false;
      if (rawInput !== null && rawInput !== undefined && typeof rawInput === 'object') {
        const { includeResolved: flag } = rawInput as { includeResolved?: unknown };
        if (flag !== undefined) {
          if (typeof flag !== 'boolean') {
            throw new Error('craft:merge-review-list includeResolved 须为 boolean');
          }
          includeResolved = flag;
        }
      }
      return listCraftMergeReviews({ includeResolved });
    },

    /**
     * `craft:merge-review-resolve`——三动作裁决执行面（AC3）：
     * - merge：讲法 append 既有卡（appendCraftTeaching——幂等键命中 no-op；卡回 pending_review）
     *   + review 落账；existingCardId 卡已删 → `not-found`（裁决无落点）。
     * - independent：新建卡（pending_review 起板——裁决产物必须再过人审 verify 才进检索面）
     *   + #claim 向量预嵌（embedClaimCondensed never-throws 降级 pending）；newClaim.termId 若
     *   已归并成墓碑则经 resolveTermTombstone **链跟随** mergedInto 到最终词目（CR-2b-9
     *   单源 helper，mirror 管线归类提案路径——A→B→C 链后不挂死词目）。
     * - dismiss：丢弃留痕（只落 review resolution，不动卡）。
     *
     * **幂等闸 + 事务性（CR-2b-1）**：卡动作与 resolution 落账在**同一 db.transaction**
     * （repository 事务化入口 runCraftMergeResolveTransaction）——已裁决再 resolve / 并发
     * 裁决竞态 → invalid-state 且卡动作一并回滚（无幻影卡/讲法残留）；动作失败
     * （not-found/invalid-input）同样整体回滚不落账，用户可重试。前置 resolution 快查仅省
     * 无谓构造，权威闸在事务内。
     */
    async mergeReviewResolve(rawInput: unknown): Promise<CraftMergeReviewResolveResult> {
      const { id, error } = coerceIdField(rawInput, 'reviewId');
      if (error !== undefined) return { ok: false, error: 'invalid-input', message: error };
      if (!REVIEW_ID_RE.test(id!)) {
        return { ok: false, error: 'invalid-input', message: 'reviewId 形态非法（须 mrev-<12hex>）' };
      }
      const source = rawInput as Record<string, unknown> | null;
      const action = source?.action;
      if (typeof action !== 'string' || !MERGE_REVIEW_ACTIONS.has(action)) {
        return { ok: false, error: 'invalid-input', message: 'action 须为 merge|independent|dismiss' };
      }
      let note: string | undefined;
      if (source?.note !== undefined && source?.note !== null) {
        if (typeof source.note !== 'string') {
          return { ok: false, error: 'invalid-input', message: 'note 须为字符串' };
        }
        const trimmed = source.note.trim();
        if (trimmed.length > 0) note = trimmed;
      }
      const reviewId = id!;

      let review: CraftMergeReview | null;
      try {
        review = getCraftMergeReview(reviewId);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), reviewId }, 'craft:merge-review-resolve load threw');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
      if (review === null) return { ok: false, error: 'not-found', message: '并排任务不存在（或坏行）' };
      if (review.resolution !== null) {
        return { ok: false, error: 'invalid-state', message: '该并排任务已裁决（裁决后不可改）' };
      }

      let createdCardId: string | undefined;
      try {
        // 卡面产物构造（事务外纯构造——零 db 写）：teaching 幂等键派生 / 词目墓碑链跟随 /
        // title 单源派生全在此完成，事务内只剩机械落库。
        let cardAction: CraftMergeResolveCardAction;
        if (action === 'merge') {
          const existing = getCraftCardRow(review.existingCardId);
          if (existing === null) {
            return { ok: false, error: 'not-found', message: '对比方既有卡已删除——无法合并（可改判 independent/dismiss）' };
          }
          cardAction = {
            kind: 'merge',
            cardId: review.existingCardId,
            teaching: teachingFromNewClaim(
              review,
              note ?? `并排对比合并（相似度 ${review.similarity.toFixed(3)}）`,
            ),
          };
        } else if (action === 'independent') {
          const nc = review.newClaim;
          // 词目墓碑链跟随（CR-2b-9）：蒸馏后词目被归并（可能成 A→B→C 链）→ 卡挂最终活词目，
          // 不挂词表视图不可见的死词目。未知 id / 链断保守回退 newClaim 原值（与 helper 语义同源）。
          const term = resolveTermTombstone(nc.termId);
          const nowIso = new Date().toISOString();
          createdCardId = `card-${randomBytes(6).toString('hex')}`;
          cardAction = {
            kind: 'independent',
            card: {
              cardId: createdCardId,
              category: term !== null ? term.category : nc.category,
              termId: term !== null ? term.termId : nc.termId,
              title: deriveCardTitle(nc.claim.condensed),
              claim: nc.claim,
              tags: nc.tags,
              teachings: [teachingFromNewClaim(review, note ?? null)],
              dispute: false,
              status: 'pending_review',
              rejectReason: null,
              confidence: nc.confidence,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          };
        } else {
          cardAction = { kind: 'dismiss' };
        }
        // CR-2b-1：卡动作 + resolution 落账单事务——resolution 幂等闸在事务内，并发裁决竞态
        // → invalid-state 且卡动作一并回滚（幻影屏障：无重复卡/讲法残留）。
        const tx = await runCraftMergeResolveTransaction(cardAction, reviewId, {
          action: action as CraftMergeReviewAction,
          resolvedAt: new Date().toISOString(),
          note: note ?? null,
        });
        if (!tx.ok) {
          return tx.error === 'invalid-state'
            ? { ok: false, error: 'invalid-state', message: '该并排任务已裁决（并发竞态）——卡面动作已回滚' }
            : { ok: false, error: tx.error, message: '卡面动作失败——未落账，可重试' };
        }
      } catch (err) {
        getLogger().warn({ err: errMsg(err), reviewId }, 'craft:merge-review-resolve action threw');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }

      const refreshed = getCraftMergeReview(reviewId);
      if (refreshed === null) {
        return { ok: false, error: 'operation-failed', message: '回读并排任务失败' };
      }
      return {
        ok: true,
        review: refreshed,
        ...(action === 'merge' ? { mergedIntoCardId: review.existingCardId } : {}),
        ...(action === 'independent' && createdCardId !== undefined ? { createdCardId } : {}),
      };
    },

    /** `craft:term-list`——词目清单（补全 chips / 待并词表视图；懒种子幂等归 repository）。 */
    async termList(rawInput: unknown): Promise<CraftTerm[]> {
      return listCraftTerms(coerceTermListInput(rawInput));
    },

    /** `craft:term-approve`——核准待并词目（pending → active；核准已 active/merged = invalid-state）。 */
    async termApprove(rawInput: unknown): Promise<CraftTermApproveResult> {
      const { id, error } = coerceIdField(rawInput, 'termId');
      if (error !== undefined) return { ok: false, error: 'invalid-input', message: error };
      if (!TERM_ID_RE.test(id!)) {
        return { ok: false, error: 'invalid-input', message: 'termId 形态非法（须 term-<8hex>）' };
      }
      try {
        // approveCraftTerm 的 result 联合（not-found/invalid-input/invalid-state）与
        // CraftTermApproveResult 契约全含——直通零适配（原 toApproveResult 适配器连同其
        // 不可达 default 分支一并删除，CR-2b-28）。
        return approveCraftTerm(id!);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), termId: id }, 'craft:term-approve repository threw');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
    },

    /** `craft:term-merge`——归并词目（卡改挂 + category 跟随 + entry 重写归 mergeCraftTerm）。 */
    async termMerge(rawInput: unknown): Promise<CraftTermMergeResult> {
      const source = rawInput as Record<string, unknown> | null;
      const termId = source?.termId;
      const mergeIntoTermId = source?.mergeIntoTermId;
      if (
        typeof termId !== 'string' ||
        typeof mergeIntoTermId !== 'string' ||
        !TERM_ID_RE.test(termId) ||
        !TERM_ID_RE.test(mergeIntoTermId)
      ) {
        return { ok: false, error: 'invalid-input', message: '需要 termId 与 mergeIntoTermId（term-<8hex> 形态）' };
      }
      try {
        return mergeCraftTerm(termId, mergeIntoTermId);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), termId, mergeIntoTermId }, 'craft:term-merge repository threw');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
    },
  };
}

/**
 * 注册手艺卡/蒸馏管线十一通道（registerAllIpc 恰调一次；同 channel 二次 ipcMain.handle 会
 * 抛错——spec/shell/ipc-handlers.md 注册纪律）。
 */
export function registerCraftIpc(): void {
  const handlers = createCraftIpcHandlers();
  ipcMain.handle('craft:distill-run', (_e, input: unknown) => handlers.distillRun(input));
  ipcMain.handle('craft:distill-status', (_e, input: unknown) => handlers.distillStatus(input));
  ipcMain.handle('craft:card-list', (_e, input: unknown) => handlers.cardList(input));
  ipcMain.handle('craft:card-get', (_e, input: unknown) => handlers.cardGet(input));
  ipcMain.handle('craft:card-patch', (_e, input: unknown) => handlers.cardPatch(input));
  ipcMain.handle('craft:card-review', (_e, input: unknown) => handlers.cardReview(input));
  ipcMain.handle('craft:merge-review-list', (_e, input: unknown) => handlers.mergeReviewList(input));
  ipcMain.handle('craft:merge-review-resolve', (_e, input: unknown) => handlers.mergeReviewResolve(input));
  ipcMain.handle('craft:term-list', (_e, input: unknown) => handlers.termList(input));
  ipcMain.handle('craft:term-approve', (_e, input: unknown) => handlers.termApprove(input));
  ipcMain.handle('craft:term-merge', (_e, input: unknown) => handlers.termMerge(input));
}
