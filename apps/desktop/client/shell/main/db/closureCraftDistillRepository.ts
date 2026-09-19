import {
  craftDistillLedgerSchema,
  type CraftDistillLedger,
  type CraftDistillStatus,
} from '@orison/shared-contracts';
import { getDb } from './index';

// ── E10.2b（task 09-05）Wave 2：closure_craft_distill 蒸馏台账 repository（design §1.3）──
//
// 材料级台账（每材料一行，PK materialId）：**双 hash 门控**（F-07）——contentHash（原件）变更
// → 全量重蒸；derivedHash（派生 .md 锚定基面）变更 → 讲法 stale 复核不自动重蒸；材料删除 →
// status='material-deleted'。stats_json 键 snake_case（claims/anchored/dropped_no_anchor/
// dropped_malformed/dropped_no_category/merged_auto/merge_reviews/new_cards/disputes——W1 契约
// 注记），行映射归本文件（camelCase ↔ snake_case，mirror chunkSpans ↔ chunk_spans_json 先例）。
//
// expected_downstream_consumers:
// - W3 台账编排（双 hash 门控判定 + 相位进度写 + never-throws 失败态落账）。
// - W4/W5 IPC（craft:distill-status 取数面——材料页/手艺页台账徽章）。
// - shell 启动对账（main/index.ts whenReady——closeStaleRunningDistills 翻中断残留行）。

interface CraftDistillSqlRow {
  material_id: string;
  content_hash: string;
  derived_hash: string;
  status: string;
  stats_json: string;
  phase: string | null;
  error: string | null;
  distilled_at: string | null;
}

/** stats 的 snake_case（db 侧）↔ camelCase（契约侧）双向映射单源。 */
function statsToJson(stats: CraftDistillLedger['stats']): string {
  return JSON.stringify({
    claims: stats.claims,
    anchored: stats.anchored,
    dropped_no_anchor: stats.droppedNoAnchor,
    dropped_malformed: stats.droppedMalformed,
    dropped_no_category: stats.droppedNoCategory,
    merged_auto: stats.mergedAuto,
    merge_reviews: stats.mergeReviews,
    new_cards: stats.newCards,
    disputes: stats.disputes,
  });
}

function rowToLedger(r: CraftDistillSqlRow): CraftDistillLedger | null {
  try {
    const raw = JSON.parse(r.stats_json) as Record<string, unknown>;
    const num = (key: string): number =>
      typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : 0;
    return craftDistillLedgerSchema.parse({
      materialId: r.material_id,
      contentHash: r.content_hash,
      derivedHash: r.derived_hash,
      status: r.status,
      stats: {
        claims: num('claims'),
        anchored: num('anchored'),
        droppedNoAnchor: num('dropped_no_anchor'),
        // 旧行缺键 → 0（拆分键上线前的台账按零计数读回，不拒行——num 缺省语义）。
        droppedMalformed: num('dropped_malformed'),
        droppedNoCategory: num('dropped_no_category'),
        mergedAuto: num('merged_auto'),
        mergeReviews: num('merge_reviews'),
        newCards: num('new_cards'),
        disputes: num('disputes'),
      },
      phase: r.phase,
      error: r.error,
      distilledAt: r.distilled_at,
    });
  } catch {
    // tolerant（mirror rowToMaterial CR-E6）：坏 JSON/坏行跳过不崩调用方。
    return null;
  }
}

/**
 * 台账 upsert（冲突键 materialId——重蒸/相位推进/终态落账全走此面；调用方给全量行，
 * ON CONFLICT 整行替换，无部分更新漂移面）。
 */
export function upsertCraftDistillLedger(ledger: CraftDistillLedger): void {
  getDb()
    .prepare(
      `INSERT INTO closure_craft_distill
         (material_id, content_hash, derived_hash, status, stats_json, phase, error, distilled_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(material_id) DO UPDATE SET
         content_hash=excluded.content_hash,
         derived_hash=excluded.derived_hash,
         status=excluded.status,
         stats_json=excluded.stats_json,
         phase=excluded.phase,
         error=excluded.error,
         distilled_at=excluded.distilled_at`,
    )
    .run(
      ledger.materialId,
      ledger.contentHash,
      ledger.derivedHash,
      ledger.status,
      statsToJson(ledger.stats),
      ledger.phase,
      ledger.error,
      ledger.distilledAt,
    );
}

/** 取台账行（无/坏行 → null）。 */
export function getCraftDistillLedger(materialId: string): CraftDistillLedger | null {
  const row = getDb()
    .prepare('SELECT * FROM closure_craft_distill WHERE material_id=?')
    .get(materialId) as CraftDistillSqlRow | undefined;
  return row === undefined ? null : rowToLedger(row);
}

/** 台账清单（craft:distill-status 取数面；省略 materialIds = 全部行）。坏行跳过。 */
export function listCraftDistillLedgers(materialIds?: string[]): CraftDistillLedger[] {
  const db = getDb();
  const rows =
    materialIds !== undefined && materialIds.length > 0
      ? (db
          .prepare(
            `SELECT * FROM closure_craft_distill WHERE material_id IN (${materialIds.map(() => '?').join(',')})`,
          )
          .all(...materialIds) as CraftDistillSqlRow[])
      : (db.prepare('SELECT * FROM closure_craft_distill').all() as CraftDistillSqlRow[]);
  return rows.flatMap((r) => {
    const l = rowToLedger(r);
    return l === null ? [] : [l];
  });
}

// ── 启动对账（dogfood R4 F5：进程中断残留的非终态台账行）──

/**
 * 非终态词表（**封闭枚举字面量**，类型标注钉死成员必须来自 schema 全词表——拼错编译期
 * 即炸）。刻意不做「schema 全集减终态补集」的方向：schema 新增枚举成员时，新成员默认
 * **不进**对账面（宁漏勿误杀——对账误翻一行真实在途蒸馏的代价远大于漏翻一行中断残留），
 * 要进对账必须在这里显式加字面量并说明该状态何以为「在途形态」。done/failed/
 * material-deleted 三终态天然不在表内，对账永不触碰。
 */
const CRAFT_DISTILL_STALE_STATUSES: readonly CraftDistillStatus[] = ['pending', 'running'];

/** 中断行的台账 note（error 列双职——失败原因/诚实备注同槽，对账翻转时落中断说明）。 */
export const CRAFT_DISTILL_INTERRUPTED_NOTE = '应用中断，蒸馏未完成——重新蒸馏将全量重跑。';

/**
 * 启动对账：全部非终态行翻 failed + 清相位 + 落中断 note，返回翻转行数。
 *
 * 前提（防御注记）：**只在进程启动期调用**——蒸馏在途表（pipeline 的 inflightDistills）是
 * 纯内存结构，进程重启后恒为空，此刻台账里的非终态行必然是上次进程中断的残留（kill/崩溃/
 * 强退都跳不过管线 finally 释放）；运行期调用会误杀真实在途蒸馏。
 *
 * 写法纪律（mirror decon 启动对账）：窄 UPDATE 只翻 status/phase/error 三列——stats/双
 * hash/distilledAt 原样保留（重跑由双 hash 门控自然 proceed 全量覆盖；distilledAt 的
 * 「最近成功蒸馏时刻」语义不因中断丢失，旧计数也不被对账抹掉）。
 *
 * 终态选词：schema 枚举无独立中断态，沿用 'failed' + note 说明（该行语义 = 本轮未产出，
 * UI 徽章回落失败态、重跑入口天然可用——failed 行在 craft 页重跑清单内）；加枚举属契约
 * 改动且对消费面零收益，不做。
 */
export function closeStaleRunningDistills(): number {
  const result = getDb()
    .prepare(
      `UPDATE closure_craft_distill
       SET status = 'failed', phase = NULL, error = ?
       WHERE status IN (${CRAFT_DISTILL_STALE_STATUSES.map(() => '?').join(',')})`,
    )
    .run(CRAFT_DISTILL_INTERRUPTED_NOTE, ...CRAFT_DISTILL_STALE_STATUSES);
  return result.changes;
}
