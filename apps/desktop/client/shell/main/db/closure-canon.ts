import {
  deconCanonEntrySchema,
  type DeconCanonDomain,
  type DeconCanonEntry,
} from '@orison/shared-contracts';
import { getDb } from './index';

// ── E10.3a（task 09-05）W1：closure_canon_entry repository（P2 canon 六域产物）──
//
// canon = 拆解产出的同人保真薄事实档案（六域：world/rule/character/tone/timeline/
// relationship——2026-09-05 拍板定稿）。做薄纪律：不复述情节，只存事实骨架；**不写自己
// 项目的 asset_cards**（C5 边界）。条目 PK(job_id, domain, name) 自然键；anchors 无锚不立行
// （zod min(1) 契约层守——DDL 无 JSON 形状可 CHECK）。
//
// 写路径 = per (job, domain) 全量替换（P2 域装配幂等整体重算——单 WAL 事务 DELETE+INSERT，
// mirror replaceDeconEntities / per-episode 全量替换哲学）。
//
// expected_downstream_consumers:
// - W5 P2 canon 装配（六域产物落库）。
// - W6 deconIpc（canon 浏览通道）+ materials:delete 级联（deleteDeconProductsByMaterial 调
//   deleteDeconCanonEntriesByMaterial）。
// - 同人-1 epic（未来——canon 消费面 C1-C9，接口形状见 shared-contracts 注释预留）。

interface DeconCanonSqlRow {
  job_id: string;
  domain: string;
  name: string;
  payload_json: string;
  anchors_json: string;
  provenance_json: string;
}

function rowToCanonEntry(r: DeconCanonSqlRow): DeconCanonEntry | null {
  // tolerant（mirror rowToLedger）：坏 JSON/坏行跳过不崩调用方——canon 是 DERIVED 可重算面。
  try {
    return deconCanonEntrySchema.parse({
      jobId: r.job_id,
      domain: r.domain,
      name: r.name,
      payload: JSON.parse(r.payload_json),
      anchors: JSON.parse(r.anchors_json),
      provenance: JSON.parse(r.provenance_json),
    });
  } catch {
    return null;
  }
}

/**
 * canon 条目 per (job, domain) 全量替换（P2 域装配幂等——重跑该域不留 stale 条目；单事务）。
 */
export function replaceDeconCanonEntries(jobId: string, domain: DeconCanonDomain, entries: DeconCanonEntry[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO closure_canon_entry
       (job_id, domain, name, payload_json, anchors_json, provenance_json)
     VALUES (?,?,?,?,?,?)`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM closure_canon_entry WHERE job_id=? AND domain=?').run(jobId, domain);
    for (const e of entries) {
      insert.run(e.jobId, e.domain, e.name, JSON.stringify(e.payload), JSON.stringify(e.anchors), JSON.stringify(e.provenance));
    }
  })();
}

/** canon 条目清单（六域浏览/同人消费取数面；省略 domain = 全域）。坏行跳过。 */
export function listDeconCanonEntries(jobId: string, domain?: DeconCanonDomain): DeconCanonEntry[] {
  const db = getDb();
  const rows =
    domain !== undefined
      ? (db
          .prepare('SELECT * FROM closure_canon_entry WHERE job_id=? AND domain=? ORDER BY name ASC')
          .all(jobId, domain) as DeconCanonSqlRow[])
      : (db
          .prepare('SELECT * FROM closure_canon_entry WHERE job_id=? ORDER BY domain ASC, name ASC')
          .all(jobId) as DeconCanonSqlRow[]);
  return rows.flatMap((r) => {
    const entry = rowToCanonEntry(r);
    return entry === null ? [] : [entry];
  });
}

/** 按 job 清 canon（decon:delete 拆解会话删除的级联面）。 */
export function deleteDeconCanonEntriesByJob(jobId: string): void {
  getDb().prepare('DELETE FROM closure_canon_entry WHERE job_id=?').run(jobId);
}

/**
 * 按材料清 canon（materials:delete 级联四清的 canon 段）。双谓词（CR-2）：
 * 1. provenance 的 materialId（json_extract——provenance 由 P2 装配单点写入，恒含
 *    source='decon' + materialId；**生产写点值域**，勿按形状缺省猜）。json_valid 守卫：
 *    malformed provenance 行 json_extract 会**抛错**炸整条级联事务（NULL 兜底缺失的根因）
 *    ——坏行跳过 json 路径走谓词 2。
 * 2. `job_id IN (SELECT … WHERE material_ref 尾缀=?)` 兜底：malformed/缺 provenance 的行
 *    经 job 反查同样清掉（保清理可重入——级联失败可经重删/补偿后 per-job decon:delete 收尾）。
 */
export function deleteDeconCanonEntriesByMaterial(materialId: string): void {
  getDb()
    .prepare(
      `DELETE FROM closure_canon_entry
       WHERE (json_valid(provenance_json) AND json_extract(provenance_json, '$.materialId') = ?)
          OR job_id IN (SELECT job_id FROM closure_decon_job WHERE substr(material_ref, -16) = ?)`,
    )
    .run(materialId, materialId);
}
