import {
  craftDistillLedgerSchema,
  type CraftDistillLedger,
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
