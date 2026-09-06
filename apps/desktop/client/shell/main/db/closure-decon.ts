import {
  DECON_JOB_INFLIGHT_STATUSES,
  DECON_REPORT_KINDS,
  DECON_REVIEW_CHECKPOINTS,
  deconChapterFactsSchema,
  deconChapterLabelsSchema,
  deconArcsPayloadSchema,
  deconDictionarySchema,
  deconEntitySchema,
  deconFindingsSchema,
  deconJobSchema,
  deconPassStateSchema,
  deconProductRowSchema,
  deconReportRowSchema,
  deconStatsPayloadSchema,
  deconStylePayloadSchema,
  deconReviewRowSchema,
  type DeconBudget,
  type DeconCanonDomain,
  type DeconCanonEntry,
  type DeconChapterFacts,
  type DeconDictionary,
  type DeconEntity,
  type DeconJob,
  type DeconJobStatus,
  type DeconPassState,
  type DeconProductRow,
  type DeconReportKind,
  type DeconReportMeta,
  type DeconReportRow,
  type DeconReviewCheckpoint,
  type DeconReviewRow,
} from '@orison/shared-contracts';
import { getDb } from './index';
import {
  deleteDeconCanonEntriesByJob,
  deleteDeconCanonEntriesByMaterial,
  replaceDeconCanonEntries,
} from './closure-canon';

// ── E10.3a（task 09-05）W1：拆解管线表族 repository（job/断点 + 材料级事实层三表）──
//
// 一表一文件惯例（spec db-repository）：纯函数 + getDb() 单例 + snake_case 列 ↔ camelCase
// record 集中映射。本文件管八表：closure_decon_job / closure_decon_pass_state /
// closure_decon_facts / closure_decon_entity / closure_decon_dictionary（canon 归
// closure-canon.ts）+ child B 三表 closure_decon_product / closure_decon_report /
// closure_decon_review（E10.3b W1——job 键控非材料级，级联随 job/材料走）。同步函数保持
// 同步（事务边界纪律）。
//
// 🔑 事实层三表材料级键控（F-07）：键 = (material_ref, derived_hash)——非 job 私有，跨 job
// 复用（同指纹新 job 继承 P1 产物零重算）；job 删除**不**清三表，材料删除（级联四清）才清。
//
// 🔴 级联四清（F-02，W6 接 materials:delete）：deleteDeconProductsByMaterial 按 materialId
// 尾缀匹配（material_ref 恒以 `mat-<12hex>` 16 字符结尾——生产写点值域单源在
// shared-contracts deconMaterialRef；**勿按 schema DEFAULT 或 LIKE 通配猜**，substr 精确比对）。
//
// expected_downstream_consumers:
// - W2 decon/deconJob.ts（状态机 + inflight 守卫 + 断点重入 + 双指纹 stale）。
// - W3-W5 P1a/P1b/P1c/P2 管线（产物落库 + pass_state 同事务写）。
// - child B W2-W5 管线（P3a/P3b/P4/P5 产物落 product/report + 闸门行读写——E10.3b）。
// - W6 deconIpc（通道族取数 + products/reports/approve-review/export-style 消费面）+
//   materials:delete 级联扩展。

interface DeconJobSqlRow {
  job_id: string;
  material_ref: string;
  tier: string;
  dimensions_json: string;
  status: string;
  budget_json: string;
  cost_json: string;
  material_content_hash: string;
  derived_hash: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonSafe(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** budget_json 列值（camelCase 契约形状直接序列化——W1 裁决：本族 JSON 列不做 snake 换键，减少映射层）。 */
function budgetToJson(job: DeconJob): string {
  return JSON.stringify(job.budget);
}

function costToJson(job: DeconJob): string {
  return JSON.stringify(job.cost);
}

function rowToJob(r: DeconJobSqlRow): DeconJob | null {
  // tolerant（mirror rowToLedger）：坏 JSON/坏行跳过不崩调用方。
  const budget = parseJsonSafe(r.budget_json);
  const cost = parseJsonSafe(r.cost_json);
  if (budget === null || cost === null) return null;
  let dimensions: unknown;
  try {
    dimensions = JSON.parse(r.dimensions_json);
  } catch {
    return null;
  }
  try {
    return deconJobSchema.parse({
      jobId: r.job_id,
      materialRef: r.material_ref,
      tier: r.tier,
      dimensions,
      status: r.status,
      budget,
      cost,
      materialContentHash: r.material_content_hash,
      derivedHash: r.derived_hash,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch {
    return null;
  }
}

/** job upsert（冲突键 jobId——全量行替换，无部分更新漂移面；调用方控制 createdAt/updatedAt 可测）。 */
export function upsertDeconJob(job: DeconJob): void {
  getDb()
    .prepare(
      `INSERT INTO closure_decon_job
         (job_id, material_ref, tier, dimensions_json, status, budget_json, cost_json,
          material_content_hash, derived_hash, error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(job_id) DO UPDATE SET
         material_ref=excluded.material_ref,
         tier=excluded.tier,
         dimensions_json=excluded.dimensions_json,
         status=excluded.status,
         budget_json=excluded.budget_json,
         cost_json=excluded.cost_json,
         material_content_hash=excluded.material_content_hash,
         derived_hash=excluded.derived_hash,
         error=excluded.error,
         updated_at=excluded.updated_at`,
    )
    .run(
      job.jobId,
      job.materialRef,
      job.tier,
      JSON.stringify(job.dimensions),
      job.status,
      budgetToJson(job),
      costToJson(job),
      job.materialContentHash,
      job.derivedHash,
      job.error,
      job.createdAt,
      job.updatedAt,
    );
}

/** 取 job 行（无/坏行 → null）。 */
export function getDeconJob(jobId: string): DeconJob | null {
  const row = getDb().prepare('SELECT * FROM closure_decon_job WHERE job_id=?').get(jobId) as
    DeconJobSqlRow | undefined;
  return row === undefined ? null : rowToJob(row);
}

/** job 清单（decon:list 取数面——CR-14c：清单页新序在前，created_at 降序确定性排序）。坏行跳过。 */
export function listDeconJobs(): DeconJob[] {
  const rows = getDb()
    .prepare('SELECT * FROM closure_decon_job ORDER BY created_at DESC, job_id DESC')
    .all() as DeconJobSqlRow[];
  return rows.flatMap((r) => {
    const job = rowToJob(r);
    return job === null ? [] : [job];
  });
}

/** 材料的全部 job（含终态——按 materialId 尾缀匹配，生产写点值域单源）。坏行跳过。 */
export function listDeconJobsByMaterial(materialId: string): DeconJob[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM closure_decon_job WHERE substr(material_ref, -16)=? ORDER BY created_at ASC, job_id ASC',
    )
    .all(materialId) as DeconJobSqlRow[];
  return rows.flatMap((r) => {
    const job = rowToJob(r);
    return job === null ? [] : [job];
  });
}

/** 同材料在途 job（F-11 inflight 守卫查询面——pending/running/paused/capped 四态）。 */
export function findInflightDeconJobByMaterial(materialId: string): DeconJob | null {
  const inflight = listDeconJobsByMaterial(materialId).filter((job) =>
    (DECON_JOB_INFLIGHT_STATUSES as readonly string[]).includes(job.status),
  );
  return inflight.length > 0 ? inflight[0] : null;
}

/** job 状态直改（状态机转移落库轻量面——避免全行重写竞态；其余字段不变）。 */
export function updateDeconJobStatus(
  jobId: string,
  status: DeconJobStatus,
  error: string | null,
  updatedAt: string,
): void {
  getDb()
    .prepare('UPDATE closure_decon_job SET status=?, error=?, updated_at=? WHERE job_id=?')
    .run(status, error, updatedAt, jobId);
}

/**
 * job 预算直改（CR-1：start{budget} 的窄更新面——**只对非 running 态生效**，不整行重写
 * 不复活已删行〔UPDATE 零命中即静默无效果〕）。capped-hold 调预算重入的落库单点。
 */
export function updateDeconJobBudget(jobId: string, budget: DeconBudget, updatedAt: string): void {
  getDb()
    .prepare(
      "UPDATE closure_decon_job SET budget_json=?, updated_at=? WHERE job_id=? AND status != 'running'",
    )
    .run(JSON.stringify(budget), updatedAt, jobId);
}

/**
 * 级联清理失败的补偿（CR-2）：材料已删、级联事务失败后残留的 job 翻 failed——可见可清
 * （decon:delete per-job 级联可重入清理 job/pass_state/canon 残留），不静默孤儿。非终态
 * （pending/running/paused/capped）与 done 一并翻（材料没了，done 产物同样成僵尸）。
 * 返回翻态行数。
 */
export function failDeconJobsByMaterialForCleanup(
  materialId: string,
  note: string,
  updatedAt: string,
): number {
  const result = getDb()
    .prepare(
      `UPDATE closure_decon_job SET status='failed', error=?, updated_at=?
       WHERE substr(material_ref, -16)=? AND status IN ('pending','running','paused','capped','done')`,
    )
    .run(note, updatedAt, materialId);
  return result.changes;
}

// ── 断点状态行 ──

interface DeconPassStateSqlRow {
  job_id: string;
  pass: string;
  unit: string;
  status: string;
  output_ref: string | null;
  output_hash: string | null;
  updated_at: string;
}

function rowToPassState(r: DeconPassStateSqlRow): DeconPassState | null {
  try {
    return deconPassStateSchema.parse({
      jobId: r.job_id,
      pass: r.pass,
      unit: r.unit,
      status: r.status,
      outputRef: r.output_ref,
      outputHash: r.output_hash,
      updatedAt: r.updated_at,
    });
  } catch {
    return null;
  }
}

/** pass_state upsert（UNIQUE(job_id,pass,unit) 冲突全量替换——重跑/续跑同面）。 */
export function upsertDeconPassState(state: DeconPassState): void {
  getDb()
    .prepare(
      `INSERT INTO closure_decon_pass_state
         (job_id, pass, unit, status, output_ref, output_hash, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(job_id, pass, unit) DO UPDATE SET
         status=excluded.status,
         output_ref=excluded.output_ref,
         output_hash=excluded.output_hash,
         updated_at=excluded.updated_at`,
    )
    .run(
      state.jobId,
      state.pass,
      state.unit,
      state.status,
      state.outputRef,
      state.outputHash,
      state.updatedAt,
    );
}

/** 取单 pass 状态行（断点重入判定面）。 */
export function getDeconPassState(
  jobId: string,
  pass: string,
  unit: string,
): DeconPassState | null {
  const row = getDb()
    .prepare('SELECT * FROM closure_decon_pass_state WHERE job_id=? AND pass=? AND unit=?')
    .get(jobId, pass, unit) as DeconPassStateSqlRow | undefined;
  return row === undefined ? null : rowToPassState(row);
}

/** job 全部状态行（进度/断点续跑扫描面）。坏行跳过。 */
export function listDeconPassStates(jobId: string): DeconPassState[] {
  const rows = getDb()
    .prepare('SELECT * FROM closure_decon_pass_state WHERE job_id=? ORDER BY pass ASC, unit ASC')
    .all(jobId) as DeconPassStateSqlRow[];
  return rows.flatMap((r) => {
    const state = rowToPassState(r);
    return state === null ? [] : [state];
  });
}

// ── P1b 逐章 facts（材料级）──

interface DeconFactsSqlRow {
  material_ref: string;
  derived_hash: string;
  chapter_index: number;
  facts_json: string;
}

function rowToFacts(r: DeconFactsSqlRow): DeconChapterFacts | null {
  try {
    return deconChapterFactsSchema.parse({
      materialRef: r.material_ref,
      derivedHash: r.derived_hash,
      chapterIndex: r.chapter_index,
      facts: JSON.parse(r.facts_json),
    });
  } catch {
    return null;
  }
}

/** 逐章 facts upsert（同指纹同章重跑全量替换——P1 幂等面）。 */
export function upsertDeconChapterFacts(row: DeconChapterFacts): void {
  getDb()
    .prepare(
      `INSERT INTO closure_decon_facts (material_ref, derived_hash, chapter_index, facts_json)
       VALUES (?,?,?,?)
       ON CONFLICT(material_ref, derived_hash, chapter_index) DO UPDATE SET
         facts_json=excluded.facts_json`,
    )
    .run(row.materialRef, row.derivedHash, row.chapterIndex, JSON.stringify(row.facts));
}

/** 取单章 facts（child B 计量/手艺消费 + 继承校验面）。 */
export function getDeconChapterFacts(
  materialRef: string,
  derivedHash: string,
  chapterIndex: number,
): DeconChapterFacts | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM closure_decon_facts WHERE material_ref=? AND derived_hash=? AND chapter_index=?',
    )
    .get(materialRef, derivedHash, chapterIndex) as DeconFactsSqlRow | undefined;
  return row === undefined ? null : rowToFacts(row);
}

/** 同指纹全部章 facts（P1c 聚合输入 + 继承判定面）。坏行跳过。 */
export function listDeconChapterFacts(
  materialRef: string,
  derivedHash: string,
): DeconChapterFacts[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM closure_decon_facts WHERE material_ref=? AND derived_hash=? ORDER BY chapter_index ASC',
    )
    .all(materialRef, derivedHash) as DeconFactsSqlRow[];
  return rows.flatMap((r) => {
    const facts = rowToFacts(r);
    return facts === null ? [] : [facts];
  });
}

// ── P1c 聚合实体（材料级）──

interface DeconEntitySqlRow {
  material_ref: string;
  derived_hash: string;
  canonical_name: string;
  type: string;
  aliases_json: string;
  mentions_json: string;
  audit_json: string;
}

function rowToEntity(r: DeconEntitySqlRow): DeconEntity | null {
  try {
    return deconEntitySchema.parse({
      materialRef: r.material_ref,
      derivedHash: r.derived_hash,
      canonicalName: r.canonical_name,
      type: r.type,
      aliases: JSON.parse(r.aliases_json),
      mentions: JSON.parse(r.mentions_json),
      audit: JSON.parse(r.audit_json),
    });
  } catch {
    return null;
  }
}

/**
 * 聚合实体**整组替换**（per 指纹全量替换——P1c 聚合是幂等整体重算，mirror per-episode
 * 全量替换哲学；单 WAL 事务 DELETE+INSERT，崩溃不留半组）。
 */
export function replaceDeconEntities(
  materialRef: string,
  derivedHash: string,
  entities: DeconEntity[],
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO closure_decon_entity
       (material_ref, derived_hash, canonical_name, type, aliases_json, mentions_json, audit_json)
     VALUES (?,?,?,?,?,?,?)`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM closure_decon_entity WHERE material_ref=? AND derived_hash=?').run(
      materialRef,
      derivedHash,
    );
    for (const e of entities) {
      insert.run(
        e.materialRef,
        e.derivedHash,
        e.canonicalName,
        e.type,
        JSON.stringify(e.aliases),
        JSON.stringify(e.mentions),
        JSON.stringify(e.audit),
      );
    }
  })();
}

/** 同指纹聚合实体清单（canon character/relationship 装配输入 + 继承判定面）。坏行跳过。 */
export function listDeconEntities(materialRef: string, derivedHash: string): DeconEntity[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM closure_decon_entity WHERE material_ref=? AND derived_hash=? ORDER BY canonical_name ASC',
    )
    .all(materialRef, derivedHash) as DeconEntitySqlRow[];
  return rows.flatMap((r) => {
    const entity = rowToEntity(r);
    return entity === null ? [] : [entity];
  });
}

// ── P1a 词典（材料级）──

interface DeconDictionarySqlRow {
  material_ref: string;
  derived_hash: string;
  entries_json: string;
}

function rowToDictionary(r: DeconDictionarySqlRow): DeconDictionary | null {
  try {
    return deconDictionarySchema.parse({
      materialRef: r.material_ref,
      derivedHash: r.derived_hash,
      entries: JSON.parse(r.entries_json),
    });
  } catch {
    return null;
  }
}

/** 词典 upsert（同指纹重扫全量替换——每指纹恒一行）。 */
export function upsertDeconDictionary(dict: DeconDictionary): void {
  getDb()
    .prepare(
      `INSERT INTO closure_decon_dictionary (material_ref, derived_hash, entries_json)
       VALUES (?,?,?)
       ON CONFLICT(material_ref, derived_hash) DO UPDATE SET
         entries_json=excluded.entries_json`,
    )
    .run(dict.materialRef, dict.derivedHash, JSON.stringify(dict.entries));
}

/** 取词典（P1b 注入面 + 继承判定面）。 */
export function getDeconDictionary(
  materialRef: string,
  derivedHash: string,
): DeconDictionary | null {
  const row = getDb()
    .prepare('SELECT * FROM closure_decon_dictionary WHERE material_ref=? AND derived_hash=?')
    .get(materialRef, derivedHash) as DeconDictionarySqlRow | undefined;
  return row === undefined ? null : rowToDictionary(row);
}

/**
 * P1c 聚合落库（实体整组替换 + pass_state **同事务**——W2「产物写入与状态写入同事务」纪律；
 * 嵌套 replaceDeconEntities 在外层事务内自动降级为 savepoint，better-sqlite3 文档语义，
 * 崩溃全回滚不留半组/半状态）。
 */
export function replaceDeconEntitiesWithPassState(
  materialRef: string,
  derivedHash: string,
  entities: DeconEntity[],
  state: DeconPassState,
): void {
  getDb().transaction(() => {
    replaceDeconEntities(materialRef, derivedHash, entities);
    upsertDeconPassState(state);
  })();
}

/**
 * P2 域落库（canon per (job,domain) 全量替换 + pass_state **同事务**——同上纪律；canon 行
 * DELETE+INSERT 与断点行原子，崩溃不留半域/半状态）。canon 表 SQL 单源在 closure-canon.ts
 * 的 replaceDeconCanonEntries（本函数嵌套调用，savepoint 语义同上）。
 */
export function replaceDeconCanonEntriesWithPassState(
  jobId: string,
  domain: DeconCanonDomain,
  entries: DeconCanonEntry[],
  state: DeconPassState,
): void {
  getDb().transaction(() => {
    replaceDeconCanonEntries(jobId, domain, entries);
    upsertDeconPassState(state);
  })();
}

// ── child B 三表（E10.3b W1——product / report / review；job 键控非材料级）──

interface DeconProductSqlRow {
  job_id: string;
  pass: string;
  unit: string;
  payload_json: string;
  updated_at: string;
}

/**
 * product 行 payload 形状分派（写侧 zod 门的 schema 单源——spec long-running-pipeline
 * 「断点产物完整性」Pattern）：未登记形状的 pass×unit **一律拒收**（禁裸放——写侧放过坏
 * 形状 = 读侧投影静默丢 → hash 永不匹配 → 该 unit 每次重入重烧 LLM 且表面 done）。已登记：
 * p3a → labels（**unit 须纯章号** `^[0-9]+$`——CR-19）/ p3b:'arcs' → 弧切分 + 审计 /
 * p3b:'stats' → 统计族（E10.3b W2——p3b 只认 'arcs'|'stats' 两 unit 词形）/ p4:&lt;dim&gt;
 * （非 style）→ findings（**unit 须 ch:N|arc:N|all**——CR-19）/ **p4:style → 14 节风格
 * payload（unit 须 'all'）**（E10.3b W3b 转正——语义键对齐 agent style-card.ts，纯代码三节
 * refine 必出）。错形 unit（如 p3a 行 'all'/'ch:3'、p4:style 行 'ch:3'）在 schemaFor 分派
 * 即拒——unit 键读者（Number(unit) 章号解析等）不再吃 NaN/漏行。
 */
const DECON_P3A_UNIT_PATTERN = /^[0-9]+$/;
const DECON_P4_UNIT_PATTERN = /^(ch:[0-9]+|arc:[0-9]+|all)$/;

function deconProductPayloadSchemaFor(pass: string, unit: string) {
  if (pass === 'p3a') return DECON_P3A_UNIT_PATTERN.test(unit) ? deconChapterLabelsSchema : null;
  if (pass === 'p3b') {
    if (unit === 'arcs') return deconArcsPayloadSchema;
    if (unit === 'stats') return deconStatsPayloadSchema;
    return null;
  }
  if (pass === 'p4:style') return unit === 'all' ? deconStylePayloadSchema : null;
  if (pass.startsWith('p4:')) return DECON_P4_UNIT_PATTERN.test(unit) ? deconFindingsSchema : null;
  return null;
}

function rowToProduct(r: DeconProductSqlRow): DeconProductRow | null {
  // tolerant（mirror rowToJob）：坏 JSON/坏行跳过不崩调用方——product 是 DERIVED 可重算面。
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    return null;
  }
  try {
    return deconProductRowSchema.parse({
      jobId: r.job_id,
      pass: r.pass,
      unit: r.unit,
      payload,
      updatedAt: r.updated_at,
    });
  } catch {
    return null;
  }
}

/**
 * product upsert + 写侧 zod 门（CR-4 Pattern 的单行粒度版）：行 envelope + payload 按 pass
 * 分派校验，不过 → **不落库**返回 false（调用方按 unit 失败处理——mirror
 * sanitizeDeconCanonEntries 的「无效丢+计数」，单行写入即单行裁决）。hash 同基：调用方
 * pass_state.output_hash 必须取**同一校验后 payload** 的序列化面（落库面与读侧面同基，
 * 防「域永久重烧」）。
 */
export function upsertDeconProduct(row: DeconProductRow): boolean {
  if (row.payload === undefined) return false;
  if (!deconProductRowSchema.safeParse(row).success) return false;
  const payloadSchema = deconProductPayloadSchemaFor(row.pass, row.unit);
  if (payloadSchema === null || !payloadSchema.safeParse(row.payload).success) return false;
  getDb()
    .prepare(
      `INSERT INTO closure_decon_product (job_id, pass, unit, payload_json, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(job_id, pass, unit) DO UPDATE SET
         payload_json=excluded.payload_json,
         updated_at=excluded.updated_at`,
    )
    .run(row.jobId, row.pass, row.unit, JSON.stringify(row.payload), row.updatedAt);
  return true;
}

/** 取单 product 行（断点重入校验的产物现值面）。坏行 null。 */
export function getDeconProduct(jobId: string, pass: string, unit: string): DeconProductRow | null {
  const row = getDb()
    .prepare('SELECT * FROM closure_decon_product WHERE job_id=? AND pass=? AND unit=?')
    .get(jobId, pass, unit) as DeconProductSqlRow | undefined;
  return row === undefined ? null : rowToProduct(row);
}

/** product 清单（按 pass/unit 过滤；省略 = 全部——产出阅读/craft 闸门卡取数面）。坏行跳过。 */
export function listDeconProducts(jobId: string, pass?: string, unit?: string): DeconProductRow[] {
  const db = getDb();
  const clauses = ['job_id=?'];
  const params: unknown[] = [jobId];
  if (pass !== undefined) {
    clauses.push('pass=?');
    params.push(pass);
  }
  if (unit !== undefined) {
    clauses.push('unit=?');
    params.push(unit);
  }
  const rows = db
    .prepare(
      `SELECT * FROM closure_decon_product WHERE ${clauses.join(' AND ')} ORDER BY pass ASC, unit ASC`,
    )
    .all(...params) as DeconProductSqlRow[];
  return rows.flatMap((r) => {
    const product = rowToProduct(r);
    return product === null ? [] : [product];
  });
}

interface DeconReportSqlRow {
  job_id: string;
  kind: string;
  unit: string;
  content_md: string;
  anchors_json: string;
  dimension: string | null;
  updated_at: string;
}

function rowToReport(r: DeconReportSqlRow): DeconReportRow | null {
  let anchors: unknown;
  try {
    anchors = JSON.parse(r.anchors_json);
  } catch {
    return null;
  }
  try {
    return deconReportRowSchema.parse({
      jobId: r.job_id,
      kind: r.kind,
      unit: r.unit,
      contentMd: r.content_md,
      anchors,
      dimension: r.dimension,
      updatedAt: r.updated_at,
    });
  } catch {
    return null;
  }
}

/** report upsert + 写侧 zod 门（contentMd 非空/kind 枚举/unit 词形/锚点形状——不过不落库返回 false）。 */
export function upsertDeconReport(row: DeconReportRow): boolean {
  if (!deconReportRowSchema.safeParse(row).success) return false;
  getDb()
    .prepare(
      `INSERT INTO closure_decon_report
         (job_id, kind, unit, content_md, anchors_json, dimension, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(job_id, kind, unit) DO UPDATE SET
         content_md=excluded.content_md,
         anchors_json=excluded.anchors_json,
         dimension=excluded.dimension,
         updated_at=excluded.updated_at`,
    )
    .run(
      row.jobId,
      row.kind,
      row.unit,
      row.contentMd,
      JSON.stringify(row.anchors),
      row.dimension,
      row.updatedAt,
    );
  return true;
}

/** 取单报告全文（decon:reports 单取面）。坏行 null。 */
export function getDeconReport(
  jobId: string,
  kind: DeconReportKind,
  unit: string,
): DeconReportRow | null {
  const row = getDb()
    .prepare('SELECT * FROM closure_decon_report WHERE job_id=? AND kind=? AND unit=?')
    .get(jobId, kind, unit) as DeconReportSqlRow | undefined;
  return row === undefined ? null : rowToReport(row);
}

/** 报告 meta 清单（列表只回 meta——kind/unit/dimension/更新时间，大书章评不整面灌 renderer；省略 kind = 全部）。坏行跳过。 */
export function listDeconReportMetas(jobId: string, kind?: DeconReportKind): DeconReportMeta[] {
  const db = getDb();
  const rows =
    kind !== undefined
      ? (db
          .prepare(
            'SELECT kind, unit, dimension, updated_at FROM closure_decon_report WHERE job_id=? AND kind=? ORDER BY unit ASC',
          )
          .all(jobId, kind) as Omit<DeconReportSqlRow, 'job_id' | 'content_md' | 'anchors_json'>[])
      : (db
          .prepare(
            'SELECT kind, unit, dimension, updated_at FROM closure_decon_report WHERE job_id=? ORDER BY kind ASC, unit ASC',
          )
          .all(jobId) as Omit<DeconReportSqlRow, 'job_id' | 'content_md' | 'anchors_json'>[]);
  return rows.flatMap((r) => {
    if (!(DECON_REPORT_KINDS as readonly string[]).includes(r.kind)) return [];
    const kind = r.kind as DeconReportKind;
    return [{ kind, unit: r.unit, dimension: r.dimension, updatedAt: r.updated_at }];
  });
}

interface DeconReviewSqlRow {
  job_id: string;
  checkpoint: string;
  status: string;
  note: string | null;
  updated_at: string;
}

function rowToReview(r: DeconReviewSqlRow): DeconReviewRow | null {
  try {
    return deconReviewRowSchema.parse({
      jobId: r.job_id,
      checkpoint: r.checkpoint,
      status: r.status,
      note: r.note,
      updatedAt: r.updated_at,
    });
  } catch {
    return null;
  }
}

/** 闸门行 upsert（create 初始化三行 pending / approve 翻 approved / off 配置——单写点）。 */
export function upsertDeconReview(row: DeconReviewRow): void {
  getDb()
    .prepare(
      `INSERT INTO closure_decon_review (job_id, checkpoint, status, note, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(job_id, checkpoint) DO UPDATE SET
         status=excluded.status,
         note=excluded.note,
         updated_at=excluded.updated_at`,
    )
    .run(row.jobId, row.checkpoint, row.status, row.note, row.updatedAt);
}

/** 取单闸门行（approve-review 的状态判定面）。坏行 null。 */
export function getDeconReview(
  jobId: string,
  checkpoint: DeconReviewCheckpoint,
): DeconReviewRow | null {
  const row = getDb()
    .prepare('SELECT * FROM closure_decon_review WHERE job_id=? AND checkpoint=?')
    .get(jobId, checkpoint) as DeconReviewSqlRow | undefined;
  return row === undefined ? null : rowToReview(row);
}

/** job 三闸门行（checkpoint 常量序——dictionary → canon → craft，非字母序）。坏行跳过。 */
export function listDeconReviews(jobId: string): DeconReviewRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM closure_decon_review WHERE job_id=?')
    .all(jobId) as DeconReviewSqlRow[];
  return rows
    .flatMap((r) => {
      const review = rowToReview(r);
      return review === null ? [] : [review];
    })
    .sort(
      (a, b) =>
        DECON_REVIEW_CHECKPOINTS.indexOf(a.checkpoint) -
        DECON_REVIEW_CHECKPOINTS.indexOf(b.checkpoint),
    );
}

// ── 级联四清（F-02——materials:delete 扩展的 repository 面，W6 接 IPC）──

/**
 * `decon:delete` 的 per-job 级联（W6 + E10.3b W1）：pass_state + B 三表（product/report/
 * review）+ job 行 + canon 条目（deleteDeconCanonEntriesByJob）单事务。**事实层三表
 * （facts/entity/dictionary）材料级保留**（F-07——其他 job 仍可继承同指纹 P1 产物；
 * 材料删除才走 deleteDeconProductsByMaterial 全清）。
 */
export function deleteDeconJobCascade(jobId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM closure_decon_pass_state WHERE job_id=?').run(jobId);
    db.prepare('DELETE FROM closure_decon_product WHERE job_id=?').run(jobId);
    db.prepare('DELETE FROM closure_decon_report WHERE job_id=?').run(jobId);
    db.prepare('DELETE FROM closure_decon_review WHERE job_id=?').run(jobId);
    db.prepare('DELETE FROM closure_decon_job WHERE job_id=?').run(jobId);
    deleteDeconCanonEntriesByJob(jobId);
  })();
}

/**
 * stale 确认重跑的状态复位（CR-5 + E10.3b M2）：清 **p2+** 的 pass_state 行 + canon 行 +
 * **B 两产物表**（product/report——旧指纹 findings/报告滞留 UI 的脏路径）+ 闸门行复位（单事务）。
 * 不清则旧 canon 行 hash 照样匹配 → 六域 skip → 旧材料锚点的 canon 终态 done（脏路径）。
 * P1 三 pass 行不清——新 derived_hash 下产物现值缺失，decideDeconPassReentry 自然 rerun
 * （材料级 P1 行由新指纹键控重新长出）。
 *
 * 闸门复位语义：**approved → pending**（新指纹的词典/canon/findings 是新产物，应再过闸——
 * 首本标定语义）；**off 保留**（用户常设配置不翻——重跑不复活已关的闸门）。
 */
export function resetDeconRerunState(
  jobId: string,
  updatedAt: string = new Date().toISOString(),
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM closure_decon_pass_state WHERE job_id=? AND pass NOT IN ('p1a','p1b','p1c')`,
    ).run(jobId);
    deleteDeconCanonEntriesByJob(jobId);
    db.prepare('DELETE FROM closure_decon_product WHERE job_id=?').run(jobId);
    db.prepare('DELETE FROM closure_decon_report WHERE job_id=?').run(jobId);
    db.prepare(
      "UPDATE closure_decon_review SET status='pending', updated_at=? WHERE job_id=? AND status='approved'",
    ).run(updatedAt, jobId);
  })();
}

/**
 * 材料删除级联四清：按 materialId 清本族八表 + canon（单事务）。
 * 匹配谓词 = material_ref 尾缀（恒 16 字符 `mat-<12hex>`）+ canon provenance 的 materialId
 * （json_extract——**生产写点值域**：本族唯一写点是 decon 管线/deconJob，material_ref 必经
 * shared-contracts deconMaterialRef 拼装）。pass_state 与 **B 三表**（job 键控无 material 列）
 * 经 job 集反查——B 三表的 IN 子查询置于 job 行删除**前**（谓词仍有效）。
 */
export function deleteDeconProductsByMaterial(materialId: string): void {
  const db = getDb();
  db.transaction(() => {
    const jobIds = (
      db
        .prepare('SELECT job_id FROM closure_decon_job WHERE substr(material_ref, -16)=?')
        .all(materialId) as { job_id: string }[]
    ).map((r) => r.job_id);
    for (const jobId of jobIds) {
      db.prepare('DELETE FROM closure_decon_pass_state WHERE job_id=?').run(jobId);
    }
    // E10.3b：B 三表按 job 集反查（同 pass_state 谓词，先于 job 行删除）。
    db.prepare(
      `DELETE FROM closure_decon_product WHERE job_id IN
         (SELECT job_id FROM closure_decon_job WHERE substr(material_ref, -16)=?)`,
    ).run(materialId);
    db.prepare(
      `DELETE FROM closure_decon_report WHERE job_id IN
         (SELECT job_id FROM closure_decon_job WHERE substr(material_ref, -16)=?)`,
    ).run(materialId);
    db.prepare(
      `DELETE FROM closure_decon_review WHERE job_id IN
         (SELECT job_id FROM closure_decon_job WHERE substr(material_ref, -16)=?)`,
    ).run(materialId);
    db.prepare('DELETE FROM closure_decon_job WHERE substr(material_ref, -16)=?').run(materialId);
    db.prepare('DELETE FROM closure_decon_facts WHERE substr(material_ref, -16)=?').run(materialId);
    db.prepare('DELETE FROM closure_decon_entity WHERE substr(material_ref, -16)=?').run(
      materialId,
    );
    db.prepare('DELETE FROM closure_decon_dictionary WHERE substr(material_ref, -16)=?').run(
      materialId,
    );
    deleteDeconCanonEntriesByMaterial(materialId);
  })();
}
