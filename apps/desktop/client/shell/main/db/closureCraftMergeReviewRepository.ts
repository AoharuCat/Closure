import {
  craftMergeReviewSchema,
  type CraftMergeReview,
  type CraftMergeReviewResolution,
} from '@orison/shared-contracts';
import { getDb } from './index';

// ── E10.2b（task 09-05）Wave 2：closure_craft_merge_review repository（design §2.3 + W1 裁决）──
//
// 中档去重（0.85-0.98 相似度）的人审并排对比任务。**独立表**（W1 裁决，schema JSDoc 注记）：
// 队列生命周期 ≠ 卡生命周期（resolved 记录不塞卡真相行成幽灵数据）+ newClaim 是未落卡的完整
// 条目载荷（嵌进卡行是实体套实体）+ 待审列表是审阅 UI 热路径（WHERE resolution IS NULL 部分索引）。
//
// 三动作裁决（merge/independent/dismiss）的**执行**归 W3/W4 编排（merge → appendCraftTeaching
// 挂讲法 / independent → insertCraftCard 建卡 / dismiss → 丢弃留痕）——本文件只管 review 行
// 的记账与 resolve 幂等闸（已裁决再 resolve = invalid-state，ipc 契约）。
//
// expected_downstream_consumers:
// - W3 去重段（0.85-0.98 档建 review 行——与落卡同事务，F-04）。
// - W4/W5 IPC（craft:merge-review-list/resolve——并排对比组件取数 + 三动作裁决）。

interface CraftMergeReviewSqlRow {
  review_id: string;
  new_claim_json: string;
  existing_card_id: string;
  similarity: number;
  dispute_hint_json: string | null;
  resolution_json: string | null;
  created_at: string;
}

function rowToReview(r: CraftMergeReviewSqlRow): CraftMergeReview | null {
  try {
    return craftMergeReviewSchema.parse({
      reviewId: r.review_id,
      newClaim: JSON.parse(r.new_claim_json),
      existingCardId: r.existing_card_id,
      similarity: r.similarity,
      // CR-2b-D1：LLM 分歧预判 verdict（可选键二态——null = 判定不可用，不写「无分歧」暗示）。
      disputeHint: r.dispute_hint_json === null ? undefined : JSON.parse(r.dispute_hint_json),
      resolution: r.resolution_json === null ? null : JSON.parse(r.resolution_json),
      createdAt: r.created_at,
    });
  } catch {
    // tolerant（mirror rowToMaterial CR-E6）：坏 JSON/坏行跳过不崩调用方。
    return null;
  }
}

/** 建 review 行（待审起板——resolution null；PK 冲突抛错，建行是 W3 单事务内的确定性新建）。 */
export function insertCraftMergeReview(review: CraftMergeReview): void {
  getDb()
    .prepare(
      `INSERT INTO closure_craft_merge_review
         (review_id, new_claim_json, existing_card_id, similarity, dispute_hint_json, resolution_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      review.reviewId,
      JSON.stringify(review.newClaim),
      review.existingCardId,
      review.similarity,
      review.disputeHint === undefined ? null : JSON.stringify(review.disputeHint),
      review.resolution === null ? null : JSON.stringify(review.resolution),
      review.createdAt,
    );
}

/** 取 review 行（无/坏行 → null）。 */
export function getCraftMergeReview(reviewId: string): CraftMergeReview | null {
  const row = getDb()
    .prepare('SELECT * FROM closure_craft_merge_review WHERE review_id=?')
    .get(reviewId) as CraftMergeReviewSqlRow | undefined;
  return row === undefined ? null : rowToReview(row);
}

/**
 * review 清单（craft:merge-review-list 取数面）：缺省仅待审（resolution IS NULL——热路径走
 * idx_closure_craft_merge_review_open 部分索引）；includeResolved = true 含已裁决（审计回看）。
 */
export function listCraftMergeReviews(
  input: { includeResolved?: boolean } = {},
): CraftMergeReview[] {
  const db = getDb();
  const rows = (
    input.includeResolved === true
      ? db.prepare('SELECT * FROM closure_craft_merge_review ORDER BY created_at')
      : db.prepare('SELECT * FROM closure_craft_merge_review WHERE resolution_json IS NULL ORDER BY created_at')
  ).all() as CraftMergeReviewSqlRow[];
  return rows.flatMap((r) => {
    const v = rowToReview(r);
    return v === null ? [] : [v];
  });
}

/**
 * resolve 记账（裁决结果落行——调用方在**同一外层事务/调用序列**里执行三动作的卡面产物）。
 * 幂等闸：已裁决记录再 resolve = invalid-state（ipc 契约「裁决后不可改」）。
 */
export function markCraftMergeReviewResolved(
  reviewId: string,
  resolution: CraftMergeReviewResolution,
): { ok: true } | { ok: false; error: 'not-found' | 'invalid-state' } {
  const db = getDb();
  const existing = db
    .prepare('SELECT resolution_json FROM closure_craft_merge_review WHERE review_id=?')
    .get(reviewId) as { resolution_json: string | null } | undefined;
  if (existing === undefined) return { ok: false, error: 'not-found' };
  if (existing.resolution_json !== null) return { ok: false, error: 'invalid-state' };
  db.prepare('UPDATE closure_craft_merge_review SET resolution_json=? WHERE review_id=?').run(
    JSON.stringify(resolution),
    reviewId,
  );
  return { ok: true };
}
