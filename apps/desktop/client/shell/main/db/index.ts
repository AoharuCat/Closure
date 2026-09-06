import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  isSqliteVecAvailable,
  loadSqliteVec,
  resetSqliteVecState,
} from './sqliteVecLoader';
import { migrateWorldSubjectIds } from './worldSubjectIdMigration';
import { getLogger } from '../logger';

let db: Database.Database;

function getDbPath(): string {
  const dataDir = path.join(app.getPath('home'), '.orison', 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'projects.db');
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    // Load sqlite-vec BEFORE initSchema: initSchema now creates a vec0 virtual
    // table (entry_vec), and `CREATE VIRTUAL TABLE ... USING vec0` throws
    // "no such module: vec0" if the extension is not yet registered on the
    // connection. The WAL pragma stays first. Best-effort: if the binary cannot
    // load, isSqliteVecAvailable() stays false and initSchema simply skips
    // entry_vec — the registry tables and entry_fts (FTS5 is built-in, needs no
    // extension) remain usable (ADR-3 / VS1).
    loadSqliteVec(db);
    initSchema(db);
    // dogfood R2 #91：存量 world subject 分身归一迁移（幂等数据迁移）。与上方 schema 迁移不同——数据
    // 迁移失败 warn 不阻断启动（分身未合并不影响既有读写，下次启动重试）。详 worldSubjectIdMigration.ts。
    try {
      migrateWorldSubjectIds(db);
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'closure_world_subject id migration threw at startup (skipped, retried next startup)',
      );
    }
  }
  return db;
}

// 关闭并释放 SQLite 句柄。WAL 模式下句柄不关，Windows 无法删除底层文件
// （进程持有文件锁），测试清理与应用退出都依赖此方法显式释放。
export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined as unknown as Database.Database;
    // The next getDb() opens a fresh connection that must re-load the extension.
    resetSqliteVecState();
  }
}

// ─── Story 8.3：entry_fts DDL 单源（external-content 表 + 3 个同步 trigger）──────────
// FTS5 external-content table over closure_entry. The trigram tokenizer gives
// language-agnostic substring + BM25 matching (good for CJK per research
// 'hybrid-retrieval-sqlite-vec-research.md' §5). closure_entry has a TEXT PRIMARY
// KEY (not an INTEGER PK rowid alias), so its implicit rowid is the content
// linkage key (content_rowid='rowid'); the triggers pass new.rowid / old.rowid.
// entry_id is UNINDEXED — retrieved from the content table, never tokenized.
//
// FTS5 virtual tables have no ALTER path, so adding the index_text column is a
// STRUCTURE change: fresh dbs create it here, and old dbs go through the
// DROP+reCREATE+rebuild migration inside initSchema (which re-runs THIS exact
// DDL — 单源，两条路径永不漂移；implement.md S1「trigger 生成源单源化」，design §10 风险首条）。
//
// index_text semantics (design §2.2): chunk 行（source_kind='chapter'）的 FTS 组料 =
// 章梗概 prefix + 正文（contextual prefix 进 FTS 臂，mirror「embed/BM25 看 context+chunk」）；
// 非章源行 index_text 为 NULL —— FTS5 对 NULL 列值零 token 化（实测探针：NULL 在 trigger
// insert / MATCH / rebuild / integrity-check 全路径安全，且不进匹配面），非章行照旧只经
// name + body_text 匹配，既有行为零变化。trigger 直接镜像 new.index_text / old.index_text
// （insert 与 delete 两侧同源，external-content 'delete' 命令的值必须与索引时逐字一致）。
const ENTRY_FTS_DDL = `
    CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
      entry_id UNINDEXED,
      name,
      body_text,
      index_text,
      content='closure_entry',
      content_rowid='rowid',
      tokenize='trigram'
    );

    -- FTS5 external-content sync triggers (SQLite canonical pattern). The AFTER
    -- UPDATE trigger deletes the stale indexed row before inserting the new one —
    -- order matters for external-content tables.
    CREATE TRIGGER IF NOT EXISTS closure_entry_ai AFTER INSERT ON closure_entry BEGIN
      INSERT INTO entry_fts(rowid, entry_id, name, body_text, index_text)
      VALUES (new.rowid, new.entry_id, new.name, new.body_text, new.index_text);
    END;
    CREATE TRIGGER IF NOT EXISTS closure_entry_ad AFTER DELETE ON closure_entry BEGIN
      INSERT INTO entry_fts(entry_fts, rowid, entry_id, name, body_text, index_text)
      VALUES ('delete', old.rowid, old.entry_id, old.name, old.body_text, old.index_text);
    END;
    CREATE TRIGGER IF NOT EXISTS closure_entry_au AFTER UPDATE ON closure_entry BEGIN
      INSERT INTO entry_fts(entry_fts, rowid, entry_id, name, body_text, index_text)
      VALUES ('delete', old.rowid, old.entry_id, old.name, old.body_text, old.index_text);
      INSERT INTO entry_fts(rowid, entry_id, name, body_text, index_text)
      VALUES (new.rowid, new.entry_id, new.name, new.body_text, new.index_text);
    END;
`;

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id        TEXT PRIMARY KEY,
      project_name      TEXT NOT NULL,
      project_type      TEXT NOT NULL CHECK(project_type IN ('novel','script')),
      local_fingerprint TEXT NOT NULL UNIQUE,
      project_path      TEXT,
      cover_image       TEXT,
      last_opened_at    TEXT,
      logline           TEXT,
      genre             TEXT,
      writing_style     TEXT,
      deleted_at        TEXT,
      identity_backfill_pending INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id         TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(project_id),
      target_id       TEXT,
      task_type       TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL,
      input_text      TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
      output_type     TEXT,
      output_payload  TEXT,
      result_summary  TEXT,
      rationale       TEXT NOT NULL DEFAULT '',
      review_hint     TEXT NOT NULL DEFAULT '',
      retryable       INTEGER NOT NULL DEFAULT 1,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      started_at      TEXT,
      finished_at     TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_asset_refs (
      task_id  TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL,
      PRIMARY KEY (task_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS project_assets (
      asset_id       TEXT NOT NULL,
      project_id     TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      asset_type     TEXT NOT NULL,
      asset_name     TEXT NOT NULL,
      asset_group    TEXT NOT NULL DEFAULT '',
      asset_status   TEXT NOT NULL,
      relative_path  TEXT NOT NULL DEFAULT '',
      source_task_id TEXT,
      summary        TEXT,
      version        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_created
      ON tasks (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status
      ON tasks (project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_asset_refs_asset
      ON task_asset_refs (asset_id);
    CREATE INDEX IF NOT EXISTS idx_project_assets_type
      ON project_assets (project_id, asset_type, updated_at DESC);
  `);

  // Migration: add columns if missing (non-destructive)
  const cols = db.pragma('table_info(projects)') as { name: string }[];
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('logline')) db.exec('ALTER TABLE projects ADD COLUMN logline TEXT');
  if (!colNames.has('genre')) db.exec('ALTER TABLE projects ADD COLUMN genre TEXT');
  if (!colNames.has('writing_style')) db.exec('ALTER TABLE projects ADD COLUMN writing_style TEXT');
  // Registry columns: durable project list surviving app version changes.
  if (!colNames.has('project_path')) db.exec('ALTER TABLE projects ADD COLUMN project_path TEXT');
  if (!colNames.has('cover_image')) db.exec('ALTER TABLE projects ADD COLUMN cover_image TEXT');
  if (!colNames.has('last_opened_at')) db.exec('ALTER TABLE projects ADD COLUMN last_opened_at TEXT');
  if (!colNames.has('deleted_at')) db.exec('ALTER TABLE projects ADD COLUMN deleted_at TEXT');
  // 旧版本只在 SQLite 中保存项目编号，project.yaml 尚无 meta.project_id。
  // 新增一次性标记后，仅允许这些迁移前已存在的活动记录补写编号；新记录默认不允许，
  // 避免同一路径被新目录占用时错误继承旧项目身份。
  if (!colNames.has('identity_backfill_pending')) {
    db.transaction(() => {
      db.exec('ALTER TABLE projects ADD COLUMN identity_backfill_pending INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE projects SET identity_backfill_pending = 1 WHERE deleted_at IS NULL');
    })();
  }
  // Backfill project_path from the fingerprint for rows registered before this column existed.
  if (!colNames.has('project_path')) {
    db.exec('UPDATE projects SET project_path = local_fingerprint WHERE project_path IS NULL');
  }

  // Migration: project_assets new columns
  const assetCols = db.pragma('table_info(project_assets)') as { name: string }[];
  const assetColNames = new Set(assetCols.map(c => c.name));
  if (!assetColNames.has('asset_group')) db.exec("ALTER TABLE project_assets ADD COLUMN asset_group TEXT NOT NULL DEFAULT ''");
  if (!assetColNames.has('relative_path')) db.exec("ALTER TABLE project_assets ADD COLUMN relative_path TEXT NOT NULL DEFAULT ''");

  // ─── Closure KB derived retrieval index (ADR-3 / VS1 R1) ─────────────────
  // closure-* tables are a DERIVED query/retrieval index materialized from
  // project_assets / project.yaml (source of truth = the files). They can be
  // dropped and fully rebuilt from project_assets at any time (design §7
  // rollback). VS1 builds the minimal subset: closure_entry (queryable face) +
  // entry_fts (FTS5 trigram) + entry_vec (vec0, only when the sqlite-vec
  // extension actually loaded). FTS5 is built into the bundled SQLite and needs
  // no extension, so closure_entry / entry_fts / triggers are created
  // unconditionally; only entry_vec is gated on isSqliteVecAvailable().
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_entry (
      entry_id      TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      entry_type    TEXT NOT NULL,
      source_kind   TEXT NOT NULL DEFAULT 'asset_card',
      name          TEXT NOT NULL,
      body_text     TEXT NOT NULL,
      visibility    TEXT NOT NULL DEFAULT 'known',
      content_hash  TEXT,
      model         TEXT,
      dim           INTEGER,
      -- Story 8.7 摘要层 + status 物化列（design §1.2；旧库内省 ALTER 见下）。
      summary_text  TEXT,
      summary_source TEXT,
      summary_hash  TEXT,
      status        TEXT,
      -- Story 8.3 章源 chunk 列（design §2.2；旧库内省 ALTER 见下）。chunk = source_kind='chapter'
      -- 的一行（一行一 chunk）：chapter_id/chapter_index = 所属章与章序（排序/出处呈现，呈现层 JOIN
      -- episode_outlines 补章名）；char_start/char_end = 章内字符区间（半开 [start, end)，段级出处
      -- 锚定——8.4 调查简报消费）；para_start/para_end = 段落区间（半开，0 起段落序）；index_text =
      -- FTS/embed 组料专用列（章梗概 prefix + 正文；非章源行 NULL——NULL 不进 FTS 匹配面，见
      -- ENTRY_FTS_DDL 注释）。现有六 source_kind 行这些列全 NULL（additive 零 migration 风险）。
      chapter_id    TEXT,
      chapter_index INTEGER,
      char_start    INTEGER,
      char_end      INTEGER,
      para_start    INTEGER,
      para_end      INTEGER,
      index_text    TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    ${ENTRY_FTS_DDL}

    -- Forward-looking b-tree index for the structured pre-filter in the hybrid
    -- retrieval pipeline (entry_type / project_id); mirrors
    -- idx_project_assets_type over the derived face.
    CREATE INDEX IF NOT EXISTS idx_closure_entry_project_type
      ON closure_entry (project_id, entry_type);
  `);

  // ── Story 8.7：closure_entry 摘要层 + status 加列（design §1.2；内省 ALTER mirror craft
  // tags/source 先例 CR-craft-kb-012，多语句迁移事务包裹 mirror identity_backfill 先例）──
  // summary_text/summary_source/summary_hash = 简述层（design §3.1）：'curated'（frontmatter 策展值，
  // S1 解析已透传）| 'generated'（索引路径 LLM 兜底 ~50-100 字）| NULL（未生成——存量行/无模型 graceful，
  // 检索照常）。summary_hash = 生成时 body 指纹（指纹缓存：hash 命中不重生成；策展值同样记 body hash 便于
  // 变更检测）。status = 物化卡 status（creative-fields assetCardStatusSchema 词面，'draft' 默认；不加
  // CHECK——词表演进归 shared schema 层，db 侧纯存档列）。列 additive；写入归 S4 索引器，消费归 S5 检索
  // 预过滤 + S6 目录/下钻。
  const entryCols = db.pragma('table_info(closure_entry)') as { name: string }[];
  const entryColNames = new Set(entryCols.map((c) => c.name));
  db.transaction(() => {
    if (!entryColNames.has('summary_text')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN summary_text TEXT');
    }
    if (!entryColNames.has('summary_source')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN summary_source TEXT');
    }
    if (!entryColNames.has('summary_hash')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN summary_hash TEXT');
    }
    if (!entryColNames.has('status')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN status TEXT');
    }
  })();

  // ── Story 8.3：closure_entry 章源七列内省 ALTER（design §2.2；additive——旧库全 NULL
  // 零行为变化；事务包裹 mirror 上方 8.7 先例）。写入归 S3 章索引器（chunk/chapter_summary
  // 行），消费归 S4 检索臂 + 目录面。entryColNames 是 8.7 块前的快照，7 列均不可能由上方
  // ALTER 引入，复用安全。──
  db.transaction(() => {
    if (!entryColNames.has('chapter_id')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN chapter_id TEXT');
    }
    if (!entryColNames.has('chapter_index')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN chapter_index INTEGER');
    }
    if (!entryColNames.has('char_start')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN char_start INTEGER');
    }
    if (!entryColNames.has('char_end')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN char_end INTEGER');
    }
    if (!entryColNames.has('para_start')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN para_start INTEGER');
    }
    if (!entryColNames.has('para_end')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN para_end INTEGER');
    }
    if (!entryColNames.has('index_text')) {
      db.exec('ALTER TABLE closure_entry ADD COLUMN index_text TEXT');
    }
  })();

  // Story 8.3: chapter access index。⚠️ 必须在上方内省 ALTER **之后**建——旧库的
  // closure_entry 此时才有 chapter_id 列（放 big exec 里会在 pre-8.3 库上 CREATE INDEX
  // 报 no such column）。chunk 行按章寻址（watcher reindex 的 DELETE/INSERT scope、orphan
  // 清理、段级出处取行都走 project_id + chapter_id 等值）；非章行 chapter_id 为 NULL，
  // 等值查询天然不含——index seek 语义正确。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_closure_entry_chapter
      ON closure_entry (project_id, chapter_id);
  `);

  // ── Story 8.3：entry_fts external-content 扩 index_text——旧结构迁移（design §10 风险首条）──
  // FTS5 无 ALTER：旧库（entry_fts 无 index_text 列）须 DROP + reCREATE + rebuild。⚠️ trigger
  // 名是 schema 级全局对象：CREATE TRIGGER IF NOT EXISTS 对旧定义 no-op——必须显式 DROP 旧
  // trigger（只索引 name/body_text 的老三件）再经 ENTRY_FTS_DDL 重建，否则旧 trigger 残留、
  // chunk 行的 index_text 永远不进 FTS 匹配面（silent schema drift，spec db-repository FTS5
  // 陷阱）。rebuild 从 closure_entry 全量重灌（external-content 语义：rebuild 直读 content 表
  // 全部行）——必须发生在上方 closure_entry 加列之后（index_text 列可读），rebuild 后的
  // integrity-check（下方探测）随之通过。成对事务包裹（mirror identity_backfill / entry_vec
  // 迁移先例）；失败即启动崩（结构性不一致无 graceful 可言）。
  const entryFtsSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_fts'").get() as
      | { sql: string | null }
      | undefined
  )?.sql;
  if (entryFtsSql && !entryFtsSql.includes('index_text')) {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS closure_entry_ai;
        DROP TRIGGER IF EXISTS closure_entry_ad;
        DROP TRIGGER IF EXISTS closure_entry_au;
        DROP TABLE IF EXISTS entry_fts;
      `);
      db.exec(ENTRY_FTS_DDL);
      db.exec(`INSERT INTO entry_fts(entry_fts) VALUES('rebuild')`);
    })();
    getLogger().info(
      'closure entry_fts: pre-8.3 structure (no index_text column) dropped, recreated and rebuilt from closure_entry',
    );
  }

  // entry_vec (vec0) is created only when the sqlite-vec extension actually
  // loaded. This honours loadSqliteVec's best-effort contract: a packaging
  // regression that prevents the binary from loading disables vector features
  // without bricking the registry tables or FTS5. Path B (embedding model/dim
  // swap, R7/AC7) will DROP + reCREATE this table on a (model,dim) change since
  // vec0 dims are fixed at CREATE time and have no ALTER path (research
  // `embedding-model-swap-compatibility-2026-07-23.md`).
  //
  // ── Story 8.7 multi-vector（design §1.3/§5）──
  // Pre-8.7 rows were keyed by `entry_id TEXT PRIMARY KEY`（单向量/条目）。8.7 起一行一向量：
  // vector_id = `${entry_id}#body`（全文向量）| `${entry_id}#identity`（name+type+简述身份向量，
  // 仅长文档 setting_md/craft 写——卡类 body_text 已是身份拼料只写 #body）；Story 8.3 chunk 将扩
  // `${chapterId}#c<n>`。vec0 无 ALTER 路径 → 检测旧结构（sqlite_master sql 无 `vector_id`——旧 DDL
  // 唯一 PK 是 entry_id）启动期 DROP + 按新结构 CREATE：向量是 DERIVED（可重 embed），无真实数据窗口
  // 免费（design §5：首次 reindex 自然回填）。结构变更视为 dim 变更同级事件，与 ensureEntryVecDim 家族
  // 同一 DROP+reCREATE 哲学；parseVecDimFromSql 的 float[N] 解析对新 DDL 不变（dim 探测零影响）。
  // DROP+CREATE 成对事务包裹（mirror identity_backfill 多语句迁移先例）。project_id partition key 保持。
  //
  // ── Story 8.3 CR-005 结构正解（design §4）：status/visibility 物化进 vec0 metadata 列──
  // 与 entry_type 的 KNN 内预剪枝同构（vec0 metadata WHERE 支持 `=` 等，closure_craft_vec 的
  // craft_type 先例），status/visibility 过滤从「post-KNN belt + vecK ×4 补偿」（8.7 CR-005 的
  // 临时态）升级为 KNN 内预剪枝——检索面接线归 S4（buildRrfQuery），本站只落 DDL + 写入面。
  //
  // ⚠️ vec0 TEXT metadata 列**拒绝 NULL**（Electron 实测探针：显式 NULL 与省略列皆抛
  // "Expected text for TEXT metadata column"）。约定：**空串 sentinel = 无值**——closure_entry
  // 侧 status 为 NULL 的行（asset_card/setting_md/chapter 等非卡源）在 entry_vec 写 ''。语义
  // 对齐已实证：KNN `= '具体值'` 对 sentinel 行与 SQL `=` 对 NULL 行同为不匹配（closure_entry
  // belt 的 NULL 语义不因 sentinel 漂移），最终 WHERE belt（closure_entry.status = ?，真 NULL
  // 语义）保留为双保险。visibility 在 closure_entry 是 NOT NULL DEFAULT 'known'，永远有具体值。
  //
  // 🔑 三处同步纪律（8.7 S10 flip-flop 教训，spec db-repository）：entry_vec 的 CREATE 语句存在
  // 两处（此处 + closureIndexer.ensureEntryVecDim 内嵌 CREATE），closure_craft_vec 两处（此处 +
  // closureCraftIndexer.reindexAllCraft 内嵌）。**closure_craft_vec 不加 status/visibility**——
  // craft 无状态概念（initSchema craft 表注释）、craft 检索无此过滤面（closureCraftRetrieval 只按
  // craft_type 预筛），加一对恒空列只会强制一次无谓的全量 craft 向量重建；其两处 CREATE 维持 8.7
  // 形态互一致。entry_vec 两处必须逐字段同步（下方探测按 status/visibility 列存在性判旧结构——
  // 任一处漂移即启动期 DROP 循环丢向量）。
  if (isSqliteVecAvailable()) {
    const ENTRY_VEC_DDL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_vec USING vec0(
        vector_id TEXT PRIMARY KEY,
        project_id TEXT partition key,
        entry_id TEXT,
        entry_type TEXT,
        source_kind TEXT,
        vector_kind TEXT,
        status TEXT,
        visibility TEXT,
        embedding float[1024] distance_metric=cosine
      );
    `;
    const entryVecSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_vec'").get() as
        | { sql: string | null }
        | undefined
    )?.sql;
    // 旧结构 = pre-8.7 单向量（无 vector_id）或 pre-8.3 无 metadata 列（无 status/visibility）。
    // 探测按列定义子串（'status TEXT' 在 8.7 DDL 的列集里唯一，无其他子串误配面）。
    const entryVecOldStructure =
      !!entryVecSql &&
      (!entryVecSql.includes('vector_id') ||
        !entryVecSql.includes('status TEXT') ||
        !entryVecSql.includes('visibility TEXT'));
    if (entryVecSql && entryVecOldStructure) {
      db.transaction(() => {
        db.exec('DROP TABLE entry_vec');
        db.exec(ENTRY_VEC_DDL);
        // E1（CR 2026-08-20）：结构 DROP 重建 = 全部既有向量丢失（vec0 无导出/导入路径）。同步把
        // 「有向量记账」的行（model IS NOT NULL）content_hash 清 NULL——pending_embed 语义，下次
        // reindex NULL !== hash 即触发重嵌补回。不清则 hash-skip 永久阻断重嵌：全部既有向量静默
        // 丢失（FTS-only 降质无提示）。无 model 的行本就 pending（hash NULL），无需触碰。
        // craft 表（closure_craft_vec）结构未动，不涉及。⚠️ 与 closureIndexer.ensureEntryVecDim
        // 的重建点同款 UPDATE——两处同步纪律（mirror 三处 DDL 同步）。
        db.exec('UPDATE closure_entry SET content_hash = NULL WHERE model IS NOT NULL');
      })();
      getLogger().info(
        'closure entry_vec: pre-8.7/pre-8.3 structure dropped and recreated (multi-vector + status/visibility metadata; vectors re-embed on next reindex)',
      );
    } else {
      db.exec(ENTRY_VEC_DDL);
    }
  }

  // ── Story 6.4 D2：relation 图遍历召回臂派生索引（物化 relationship_graph.edges）──
  // 结构索引（不 embed/FTS，design §3.1「不经 closure_* 语义面」）——经 entry_id JOIN closure_entry
  // 取 name/body。可 drop 重建（派生索引，source of truth = project.yaml relationship_graph）。
  // 递归 CTE 图遍历召回「结构关联但语义不相似」条目（补 searchClosure 语义盲区，ADR-3 纯代码）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_relation (
      relation_id   TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      src_entry_id  TEXT NOT NULL,
      tgt_entry_id  TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      polarity      TEXT,
      visibility    TEXT,
      strength      REAL,
      source_refs   TEXT,
      -- Story 8.7 两写者来源列（design §1.4；旧库内省 ALTER 见下）。
      source        TEXT NOT NULL DEFAULT 'graph',
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_closure_relation_src
      ON closure_relation (project_id, src_entry_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_closure_relation_tgt
      ON closure_relation (project_id, tgt_entry_id, relation_type);
    -- relation_type 注册表（extensible；mirror kb-structure-design-research.md:236）。
    CREATE TABLE IF NOT EXISTS relation_type (
      project_id    TEXT NOT NULL,
      key           TEXT NOT NULL,
      name          TEXT,
      is_system     INTEGER NOT NULL DEFAULT 0,
      inverse_label TEXT,
      PRIMARY KEY (project_id, key)
    );
  `);

  // ── Story 8.7：closure_relation 加 source 列（两写者共存，design §1.4）──
  // 'graph'（DEFAULT——存量行零影响）= relationship_graph 索引器 | 'setting_link' = setting_md 索引器
  // （frontmatter linked_entities 物化成边）。两写者的全量替换 scope 与 orphan 清理各自按 source 隔离
  // （S4：relationIndexer 替换 scope 收窄 WHERE source='graph'、settingMdIndexer orphan 清理
  // source='setting_link'——scope 隔离错=互相清边，implement.md 风险注记）；query_relations BFS 读全边
  // 零改动（seed 可为 setting entry，closure_entry JOIN 已覆盖）。单语句迁移无需事务（mirror craft
  // tags/source 先例）。
  const relationCols = db.pragma('table_info(closure_relation)') as { name: string }[];
  if (!relationCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE closure_relation ADD COLUMN source TEXT NOT NULL DEFAULT 'graph'");
  }

  // ── Story 6.4 D3：foreshadow lifecycle 派生索引（物化 promise_registry）──
  // 物化 6.5 promise_registry 的 lifecycle（status/category/plant/resolve_ref）供召回作种子/过滤
  // （AC6：open 伏笔可作召回种子）。可 drop 重建（派生索引，source of truth = project.yaml promise_registry）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_foreshadow (
      foreshadow_id       TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL,
      title               TEXT NOT NULL,
      summary             TEXT NOT NULL,
      status              TEXT NOT NULL,
      category            TEXT,
      importance          REAL,
      entry_id            TEXT,
      plant_ref           TEXT,
      resolve_ref         TEXT,
      deadline_episode_id TEXT,
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_closure_foreshadow_status
      ON closure_foreshadow (project_id, status);
  `);

  // ─── Global craft KB derived retrieval index (ADR-3 / Story 2.1) ──────────
  // closure_craft_* mirrors closure_entry/entry_fts/entry_vec for the GLOBAL
  // cross-project craft reference library. Source of truth = markdown docs under
  // ~/.orison/craft-kb/ (+ bundled read-only seeds); these tables are a DERIVED
  // query/retrieval face that can be dropped and rebuilt from the docs at any
  // time. Differences from closure_*: NO project_id (global scope), craft_type
  // instead of entry_type, NO visibility (craft docs are all public), vec0 has no
  // partition key (craft_id PK is already unique). Same engine + single getDb()
  // singleton (db spec: opening a second handle is an anti-pattern).
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_craft_entry (
      craft_id      TEXT PRIMARY KEY,
      craft_type    TEXT NOT NULL,
      source_kind   TEXT NOT NULL DEFAULT 'craft_md',
      name          TEXT NOT NULL,
      body_text     TEXT NOT NULL,
      tags          TEXT,
      source        TEXT,
      content_hash  TEXT,
      model         TEXT,
      dim           INTEGER,
      -- Story 8.7 简述层（design §1.2；无 status——craft 无状态概念）。
      summary_text  TEXT,
      summary_source TEXT,
      summary_hash  TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- FTS5 external-content table over closure_craft_entry (mirrors entry_fts:
    -- trigram tokenizer for CJK substring + BM25; craft_id UNINDEXED, retrieved
    -- from the content table; content_rowid='rowid' links via the implicit rowid).
    CREATE VIRTUAL TABLE IF NOT EXISTS closure_craft_fts USING fts5(
      craft_id UNINDEXED,
      name,
      body_text,
      content='closure_craft_entry',
      content_rowid='rowid',
      tokenize='trigram'
    );

    -- FTS5 external-content sync triggers (mirror closure_entry triggers; the
    -- AFTER UPDATE trigger deletes the stale indexed row before the new insert).
    CREATE TRIGGER IF NOT EXISTS closure_craft_entry_ai AFTER INSERT ON closure_craft_entry BEGIN
      INSERT INTO closure_craft_fts(rowid, craft_id, name, body_text)
      VALUES (new.rowid, new.craft_id, new.name, new.body_text);
    END;
    CREATE TRIGGER IF NOT EXISTS closure_craft_entry_ad AFTER DELETE ON closure_craft_entry BEGIN
      INSERT INTO closure_craft_fts(closure_craft_fts, rowid, craft_id, name, body_text)
      VALUES ('delete', old.rowid, old.craft_id, old.name, old.body_text);
    END;
    CREATE TRIGGER IF NOT EXISTS closure_craft_entry_au AFTER UPDATE ON closure_craft_entry BEGIN
      INSERT INTO closure_craft_fts(closure_craft_fts, rowid, craft_id, name, body_text)
      VALUES ('delete', old.rowid, old.craft_id, old.name, old.body_text);
      INSERT INTO closure_craft_fts(rowid, craft_id, name, body_text)
      VALUES (new.rowid, new.craft_id, new.name, new.body_text);
    END;

    -- Forward-looking b-tree index for the craft_type structured pre-filter
    -- (mirrors idx_closure_entry_project_type over the craft face).
    CREATE INDEX IF NOT EXISTS idx_closure_craft_entry_type
      ON closure_craft_entry (craft_type);
  `);

  // CR-craft-kb-012: introspective ALTER for the new `tags` + `source` columns
  // (frontmatter tags/source are now persisted, not dropped). Mirror of the
  // projects/project_assets migration pattern above: existing dbs upgrade
  // in-place without a column-missing failure on first INSERT.
  const craftCols = db.pragma('table_info(closure_craft_entry)') as { name: string }[];
  const craftColNames = new Set(craftCols.map((c) => c.name));
  if (!craftColNames.has('tags')) db.exec('ALTER TABLE closure_craft_entry ADD COLUMN tags TEXT');
  if (!craftColNames.has('source')) db.exec('ALTER TABLE closure_craft_entry ADD COLUMN source TEXT');

  // ── Story 8.7：closure_craft_entry 简述层加列（design §1.2；无 status——craft 无状态概念）──
  // 语义同 closure_entry 侧（'curated' | 'generated' | NULL + body 指纹缓存，design §3.1）。⚠️ craft
  // hashPayload 是固定字段清单（closureCraftIndexer，非全 frontmatter），S4 须显式把 frontmatter.summary
  // 纳入清单，否则纯简述编辑不触发 reindex 留 stale（design §3.1 订正注记）。事务包裹 mirror
  // identity_backfill 先例。
  db.transaction(() => {
    if (!craftColNames.has('summary_text')) {
      db.exec('ALTER TABLE closure_craft_entry ADD COLUMN summary_text TEXT');
    }
    if (!craftColNames.has('summary_source')) {
      db.exec('ALTER TABLE closure_craft_entry ADD COLUMN summary_source TEXT');
    }
    if (!craftColNames.has('summary_hash')) {
      db.exec('ALTER TABLE closure_craft_entry ADD COLUMN summary_hash TEXT');
    }
  })();

  // closure_craft_vec (vec0) mirrors entry_vec: created only when the sqlite-vec
  // extension actually loaded (best-effort). NO project_id partition key (global
  // cross-project craft KB); craft_type / source_kind are metadata columns for the
  // structured pre-filter (vec0 metadata WHERE supports only = != > >= < <=).
  //
  // ── Story 8.7 multi-vector（design §1.3「craft 表同步改造」）──
  // vector_id = `${craft_id}#body` | `${craft_id}#identity`（长文档双向量，craft 全是长文档）。
  // 旧结构（PK craft_id）启动期 DROP+CREATE——DERIVED 可重 embed，无数据窗口免费，mirror 上方
  // entry_vec 迁移（检测 = sqlite_master sql 无 `vector_id`；成对事务包裹）。
  if (isSqliteVecAvailable()) {
    const CRAFT_VEC_DDL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS closure_craft_vec USING vec0(
        vector_id TEXT PRIMARY KEY,
        craft_id TEXT,
        craft_type TEXT,
        source_kind TEXT,
        vector_kind TEXT,
        embedding float[1024] distance_metric=cosine
      );
    `;
    const craftVecSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_craft_vec'").get() as
        | { sql: string | null }
        | undefined
    )?.sql;
    if (craftVecSql && !craftVecSql.includes('vector_id')) {
      db.transaction(() => {
        db.exec('DROP TABLE closure_craft_vec');
        db.exec(CRAFT_VEC_DDL);
      })();
      getLogger().info(
        'closure closure_craft_vec: pre-8.7 single-vector structure dropped and recreated as multi-vector (vectors re-embed on next reindex)',
      );
    } else {
      db.exec(CRAFT_VEC_DDL);
    }
  }

  // FTS5 external-content integrity probe. External-content tables can degrade
  // to "database disk image is malformed" when their rowids drift from the
  // content table (e.g. orphaned FTS rows after a crash). Never let this brick
  // app startup — on failure, log and rebuild the index from closure_entry. The
  // vec0 best-effort philosophy applies here too: corruption is degraded, never
  // fatal.
  try {
    db.exec(`INSERT INTO entry_fts(entry_fts) VALUES('integrity-check')`);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'closure entry_fts integrity-check failed — rebuilding FTS index',
    );
    try {
      db.exec(`INSERT INTO entry_fts(entry_fts) VALUES('rebuild')`);
    } catch (rebuildErr) {
      getLogger().warn(
        { err: rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr) },
        'closure entry_fts rebuild also failed - FTS index left degraded (closure_entry data is intact)',
      );
    }
  }

  // closure_craft_fts integrity probe (mirror entry_fts above): never let a
  // degraded craft FTS index brick app startup - on failure, log + rebuild from
  // closure_craft_entry. craft docs are the source of truth, so the index is
  // fully rebuildable.
  try {
    db.exec(`INSERT INTO closure_craft_fts(closure_craft_fts) VALUES('integrity-check')`);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'closure closure_craft_fts integrity-check failed - rebuilding FTS index',
    );
    try {
      db.exec(`INSERT INTO closure_craft_fts(closure_craft_fts) VALUES('rebuild')`);
    } catch (rebuildErr) {
      getLogger().warn(
        { err: rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr) },
        'closure closure_craft_fts rebuild also failed - FTS index left degraded (closure_craft_entry data is intact)',
      );
    }
  }

  // ─── Story 6.6 world-state derived index (ADR-14 / ADR-3) ─────────────────
  // closure_world_state 3 tables are a DERIVED event-sourced state index
  // materialized from chapter prose (source of truth = the prose, ADR-1).
  // 5-axis extractors (Phase C) derive `source='derived'` patches from prose;
  // the amendment agent (Phase C) writes `source='amendment'` overlay patches
  // (reduce applies both layers; re-extraction clears both via resetWorldState).
  // They can be dropped and fully rebuilt from prose at any time (design §7
  // rollback / §9). All three are project-scoped via the registry 5-digit
  // project_id (mirror 2.7/2.3 — NOT meta.id UUID, avoids cross-project
  // namespace mismatch).
  //
  // CR-subject-pk: closure_world_subject uses a COMPOSITE (project_id, id) PK,
  // not the single-column `id PK` from implement.md. Subject ids are SEMANTIC
  // (e.g. `erina`, `sword-01`) and would collide across projects in this
  // machine-wide registry db — same lesson as setting_md entry_id cross-project
  // namespacing (db-repository.md Story 2.3). project_assets sets the precedent
  // (`PRIMARY KEY (project_id, asset_id)`). slice/patch keep single-column `id
  // PK` (system-generated UUIDs, no collision class); the slice→patch FK stays
  // single-column with ON DELETE CASCADE (resetWorldState deletes slices by
  // project_id → cascades their patches; orphan-patch cleanup also runs explicit
  // by project_id as belt-and-suspenders).
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_world_subject (
      id                     TEXT NOT NULL,
      project_id             TEXT NOT NULL,
      type                   TEXT NOT NULL,
      name                   TEXT,
      source_card_id         TEXT,
      first_seen_story_time  INTEGER NOT NULL,
      PRIMARY KEY (project_id, id)
    );

    CREATE TABLE IF NOT EXISTS closure_world_slice (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      story_time  INTEGER NOT NULL,
      kind        TEXT,
      title       TEXT NOT NULL,
      summary     TEXT,
      episode_id  TEXT
    );

    CREATE TABLE IF NOT EXISTS closure_world_patch (
      id          TEXT PRIMARY KEY,
      slice_id    TEXT NOT NULL REFERENCES closure_world_slice(id) ON DELETE CASCADE,
      project_id  TEXT NOT NULL,
      subject_id  TEXT NOT NULL,
      path        TEXT NOT NULL,
      op          TEXT NOT NULL CHECK(op IN ('replace','increment','remove','append')),
      value       TEXT,
      axis        TEXT NOT NULL,
      source      TEXT NOT NULL CHECK(source IN ('derived','amendment')),
      summary     TEXT,
      evidence_scene_id TEXT
    );

    -- reduce query main path: by (project_id, subject_id) → ordered by story_time
    -- (JOIN closure_world_slice for story_time). Mirror design §4 index spec.
    CREATE INDEX IF NOT EXISTS idx_closure_world_patch_proj_sub_time
      ON closure_world_patch (project_id, subject_id, slice_id);
    -- slice timeline listing by project + story_time.
    CREATE INDEX IF NOT EXISTS idx_closure_world_slice_proj_time
      ON closure_world_slice (project_id, story_time);
    -- subject listing by project + type (subject.list(type) filter).
    CREATE INDEX IF NOT EXISTS idx_closure_world_subject_proj_type
      ON closure_world_subject (project_id, type);
  `);

  // Story 6.4 D1（#1 CR fix）：closure_world_patch.evidence_scene_id 列——认知 patch 的 transmit 场。
  // 旧 db（6.6 建表时无此列）ALTER 补；新 db CREATE TABLE 已含。mirror craft tags/source ALTER 模式。
  const worldPatchCols = db.pragma('table_info(closure_world_patch)') as { name: string }[];
  if (!worldPatchCols.some((c) => c.name === 'evidence_scene_id')) {
    db.exec('ALTER TABLE closure_world_patch ADD COLUMN evidence_scene_id TEXT');
  }

  // ─── Story 8.1：checkpoint 缓存 + ChapterStateSummary（百万字长程有界化，design §4）──────────
  // 两者都是 6.6 派生索引之上的二级派生缓存（DERIVED，可 drop 重建，prose 仍是唯一文件真相源 ADR-1/14）：
  // - closure_world_checkpoint：per-subject 折叠态缓存（reduce 从最近 checkpoint 起算免全量重放，
  //   conclusions §3.1）。有效性双保险（design §7）：insertWorldSlice/resetWorldState 事务内显式失效 DELETE
  //   （覆盖删除路径——重写 slice 产零 patch / 清 amendment 不留 rowid 痕迹）+ patch_rowid_high 水印 belt
  //   （getLatestWorldCheckpoint 校验，覆盖手动改库等漏网路径）。
  // - closure_chapter_summary：per-episode 六字段结构化摘要（~500 token 预算，供审核/检索消费免重读原文）。
  //   episode = chapter 维度 PK；episode_index 冗余列保排序（源 episode_outlines 缺 index 则 NULL，查询侧
  //   graceful，design §4）。
  // ⚠️ 命名空间：「世界状态 checkpoint」（reduce 折叠态缓存）≠ agent runLoop 的 RunCheckpoint（runState.ts，
  // pause/resume 编排语义）——不同概念不同命名空间，world-state.ts 注释互指防混。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_world_checkpoint (
      project_id         TEXT NOT NULL,
      subject_id         TEXT NOT NULL,
      at_story_time      INTEGER NOT NULL,
      state              TEXT NOT NULL,
      issue_count        INTEGER NOT NULL DEFAULT 0,
      patch_rowid_high   INTEGER NOT NULL,
      patch_count_folded INTEGER NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, subject_id, at_story_time)
    );
    CREATE INDEX IF NOT EXISTS idx_world_ckpt_lookup
      ON closure_world_checkpoint (project_id, subject_id, at_story_time DESC);

    CREATE TABLE IF NOT EXISTS closure_chapter_summary (
      project_id       TEXT NOT NULL,
      episode_id       TEXT NOT NULL,
      episode_index    INTEGER,
      story_time_end   INTEGER,
      summary          TEXT NOT NULL,
      token_estimate   INTEGER NOT NULL DEFAULT 0,
      truncated        INTEGER NOT NULL DEFAULT 0,
      patch_rowid_high INTEGER NOT NULL,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_summary_order
      ON closure_chapter_summary (project_id, episode_index);
  `);

  // Story 8.1：closure_world_slice.episode_id 列（chapter = episode 维度锚）。稳定 slice.id =
  // `${episodeId}:${storyTime}` 已隐含归属，但解析 id 是 magic string 契约——显式列 + listWorldSlices
  // episodeId 过滤（存量行 NULL → 查询侧 legacy LIKE fallback，design §4/§7）。additive 零风险。
  const worldSliceCols = db.pragma('table_info(closure_world_slice)') as { name: string }[];
  if (!worldSliceCols.some((c) => c.name === 'episode_id')) {
    db.exec('ALTER TABLE closure_world_slice ADD COLUMN episode_id TEXT');
  }

  // ─── Story 8.2：弧摘要物化（折叠快照，design §4）─────────────────────────────
  // closure_arc_summary = arc-audit-agent 大审/停滞专注审产物的 DERIVED 持久层（可 drop 重跑重建，
  // prose 仍是唯一文件真相源 ADR-1/14；beats 本体住 project.yaml arc_registry creative field——LLM-authored
  // 叙事状态重跑不复现，不进 DERIVED 表）。与 closure_chapter_summary 同典位（8.1 二级派生缓存家族）。
  //
  // PK (project_id, arc_ref, audit_kind, to_episode_index)：弧重写后重跑大审 → 新 to_episode_index 行
  // （历史留档）+ 查询侧取最新（arcSummaryRepository listLatest / read，design §4）。project_id 是
  // registry 5 位 id（mirror closure_world_* / closure_chapter_summary 命名空间惯例，非 meta.id UUID）。
  // result TEXT(JSON) 存 ArcAuditResult（shared-contracts arc-registry.ts）；读时 JSON.parse try/catch
  // 容错（CR-E6 模式，corruptPayload 标记）。重置：resetWorldState 同点位清理（正文重写则摘要失真，
  // 保守清弧摘要行；beats 在 project.yaml 归用户/写手管理不自动清——worldStateRepository.ts）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_arc_summary (
      project_id         TEXT NOT NULL,
      arc_ref            TEXT NOT NULL,
      arc_kind           TEXT NOT NULL,
      audit_kind         TEXT NOT NULL,
      from_episode_index INTEGER NOT NULL,
      to_episode_index   INTEGER NOT NULL,
      result             TEXT NOT NULL,
      token_estimate     INTEGER NOT NULL DEFAULT 0,
      produced_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, arc_ref, audit_kind, to_episode_index)
    );
  `);

  // ─── Story 7.4 cross-chapter feedback ledger (ADR-3 / design §2.2) ───────────
  // closure_feedback_ledger is a DERIVED cross-chapter persistence layer for chain
  // artifacts (review.latest / emotion_verify_result / completeness_verify_result).
  // Source of truth for prose/structure stays in project.yaml; this table only
  // relays chain artifacts across chapter boundaries (Director chain-start reads
  // the PREVIOUS chapter's artifacts to fill feedback vars — review/emotion/
  // completeness). NOT project.yaml (spec anti-pattern orchestration-pattern.md:372
  // forbids chain artifacts in project.yaml). Per-episode + artifact_key composite
  // PK (each chapter's each artifact = one row, upsert on re-run). project_id is the
  // 5-digit registry id (mirror closure_world_* / closure_entry namespace convention,
  // NOT meta.id UUID — avoids cross-project PK collision, db-repository §2.7).
  // payload TEXT(JSON) stores the full serialized artifact; produced_at = write time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_feedback_ledger (
      project_id    TEXT NOT NULL,
      episode_id    TEXT NOT NULL,
      artifact_key  TEXT NOT NULL,
      payload       TEXT NOT NULL,
      produced_at   TEXT NOT NULL,
      PRIMARY KEY (project_id, episode_id, artifact_key)
    );
    CREATE INDEX IF NOT EXISTS idx_closure_feedback_ledger_proj_ep
      ON closure_feedback_ledger (project_id, episode_id);
  `);

  // ─── Story 8.7：closure_mention 共现账（memory integrity index，design §1.1）──────────
  // (章, 实体) mention 账本 = DERIVED 派生索引（可 drop 重建：record_episode_mentions 纯代码通道
  // 随时可保守重扫，prose 仍是唯一文件真相源 ADR-1/14；S3 repository + S8 汇账节点消费）。四通道记账
  // （零新增提取调用，design §2.2）：declared（写手写后申报）/ presence_shot（在场记录升格——本章
  // /presence_scene patch）/ coarse_hit+coarse_count（粗筛明写名保守计数，CJK 免分词）/ plan_linked
  // （scene_graph 计划登场 SceneNode.assetRefs）；state_changed = 本章 world patches 对拍物化（目录行
  // 「有戏份」信号，恒 present）。presence 取最高态（present > mentioned）；source 档 'full'（含申报）
  // | 'conservative'（仅纯代码通道——降级直写/修订降档/补账章，design §2.3）。两枚举 CHECK 约束
  // （schema 级强约束合法集，mirror tasks status CHECK 先例）。entry_id 锚实体卡（D1a 锚卡非名字归组
  // ——名字→卡解析在汇账层；无卡主体不入账，design §1.1 已知限制）。project_id = registry 5 位 id（与
  // closure_chapter_summary 同典位命名空间惯例，非 meta.id UUID——跨项目 PK 碰撞防线）。行粒度 PK
  // (project_id, episode_id, entry_id)：章→实体走 PK 前缀、实体→章走 idx_mention_entry（双向查询同表
  // 两条索引路径）；幂等 = per-episode 全量替换（redo/重申报重收，mirror 章摘要 upsert 哲学）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_mention (
      project_id    TEXT NOT NULL,
      episode_id    TEXT NOT NULL,
      entry_id      TEXT NOT NULL,
      presence      TEXT NOT NULL CHECK (presence IN ('present','mentioned')),
      declared      INTEGER NOT NULL DEFAULT 0,
      presence_shot INTEGER NOT NULL DEFAULT 0,
      coarse_hit    INTEGER NOT NULL DEFAULT 0,
      plan_linked   INTEGER NOT NULL DEFAULT 0,
      coarse_count  INTEGER NOT NULL DEFAULT 0,
      state_changed INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL CHECK (source IN ('full','conservative')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, episode_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mention_entry
      ON closure_mention (project_id, entry_id);
  `);

  // ─── Story 8.7 S9：closure_mention_signals 申报对拍差异信号（episode 级一行，DERIVED）─────────
  // 五类 MentionSignal（hard_miss/soft_miss/plan_deviation/new_face/alias_suggestion，closure-mention.ts）
  // 的持久面。为什么独立小表而非 closure_mention 加列：①信号是 **episode 级**产物而 closure_mention 行粒度
  // 是 (章, 实体)——塞进账行要挑任意载体行或造合成行（污染 ledger 视图）；②全 unresolved 申报章（零账行）
  // 仍可产 new_face 信号，账行载体可能不存在；③修订降档（degradeEpisodeMentions）时信号整体失效（申报
  // 对照系被清）而账行保留——两生命周期不同，分表各管各的。信号重算输入（写手申报 cast_declaration）只存
  // 链内 artifact 不持久——leader 侧消费须读落表值非重算（S9 勘察定案，详 mentionLedgerRepository 注释）。
  // 写路径 = upsertEpisodeMentions 同事务（per-episode 全量替换同账行语义）；清路径 = 修订降档删该章行 +
  // resetWorldState 级联全清（mirror closure_mention 同点位）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_mention_signals (
      project_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      signals    TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, episode_id)
    );
  `);

  // ─── Story 10.1 Wave C：closure_material 材料登记层（design §3.1，双车道同表）──────────
  // 「材料」= 任何原料进系统的统一形态（ADR-15 四件套：干净文本 + 分章 + 出处 + 质量元数据）。
  // DERIVED 纪律（ADR-1/ADR-3「增强不另建」）：真相源 = materials/ 原件 + 派生 .md 章标记
  // （chapter-splitting §2.3 method 属性判别人工/自动）；本表可 drop 重建（watcher/启动扫描
  // 全量重摄取自愈）。检索面复用既有共享表——项目车道 chunk 走 closure_entry
  // source_kind='material' 行（mirror 8.3 chunk = source_kind='chapter' 行），全局车道走
  // closure_craft_entry source_kind='material_chunk' 行，本表不建平行检索面。
  //
  // 列形态：JSON 列存 materialSchema（shared-contracts Zod 单源）各域对象——
  // - provenance_json：materialProvenanceSchema（含 F-05 author/lang/originDate——10.2 手艺卡
  //   「作者立场」来源；UI 可后补，重摄取经 COALESCE 防清）。
  // - quality_json：materialQualitySchema。🔑 F-18：分章 method 唯一源在
  //   quality.chapterDetection.method（与 chapters[].method 同值），无材料级冗余列。
  // - chapters_json：materialChapterSpanSchema[]（章可寻址锚——10.3 章号→span 消费）。
  // - chunk_spans_json：materialChunkSpanSchema[]（🔑 F-02 索引时回填，与 chunk 行写入 +
  //   本表更新同一 WAL 事务——全局车道 span 唯一落点：closure_craft_entry 无 span 列〔零
  //   ALTER〕，命中行经 craft_id 解码回查本列取段落号+字符区间）。
  // UNIQUE(scope, source_path)：路径身份防重复登记（materialId = sha12(scope+sourcePath) 派生
  // 自同源，双保险）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_material (
      material_id      TEXT PRIMARY KEY,
      scope            TEXT NOT NULL,
      project_id       TEXT,
      kind             TEXT NOT NULL DEFAULT 'prose',
      name             TEXT NOT NULL,
      source_path      TEXT NOT NULL,
      format           TEXT NOT NULL,
      provenance_json  TEXT NOT NULL,
      quality_json     TEXT NOT NULL,
      chapters_json    TEXT NOT NULL,
      chunk_spans_json TEXT NOT NULL DEFAULT '[]',
      content_hash     TEXT NOT NULL,
      char_count       INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_closure_material_scope_path
      ON closure_material (scope, source_path);
  `);

  // ─── E10.2b（task 09-05）Wave 2：手艺卡四表（design §1.1-1.3 + W1 裁决 merge_review 独立表）──────────
  // 条目级手艺卡 = 经验文档蒸馏管线的产物（区别于 2.1 doc 级 craft KB——分层并存不合并不迁移）。
  // 与既有 closure-* 派生索引不同：closure_craft_card / closure_craft_term 是**真相源表**（表为真相源，
  // 人审 UI 为唯一编辑面——不做 markdown 载体）；closure_craft_distill / closure_craft_merge_review 是
  // 管线记账面。检索/向量面**零新表**——复用 closure_craft_entry（`card:` 前缀行，source_kind='craft_card'，
  // mirror 10.1 `mat:` 前缀先例 F-02）+ closure_craft_vec（#claim 第三向量路，mirror 8.7 双向量）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS closure_craft_card (
      card_id        TEXT PRIMARY KEY,        -- card-<12hex>（创建时生成；合并保留目标卡 id）
      category       TEXT NOT NULL,           -- 受控 13 大类 slug。⚠️ 刻意不进 DDL CHECK（F-20）——
                                             -- zod 单源校验（craftCardCategorySchema），未来加大类只改
                                             -- shared-contracts 常量免表重建迁移（与 craft_type open string
                                             -- 同哲学的两面：条目级分类禁自由但也不锁死在 db 层）。
      term_id        TEXT NOT NULL,           -- closure_craft_term 词目（归类必填；category 恒跟随
                                             -- term.category 单源，词目归并时随新 term 自动改 F-15）
      title          TEXT NOT NULL,           -- 招式名（人可读）
      claim_json     TEXT NOT NULL,           -- 主张四件套（craftClaimSchema：condensed/points/scenarios/
                                             -- counterexamples——condensed 即 #claim 向量文本，去重同形状）
      tags_json      TEXT NOT NULL DEFAULT '[]',  -- 自由标签（R10——与 category/term 受控轴正交）
      teachings_json TEXT NOT NULL,           -- 讲法数组（Wikidata statement 形态，craftTeachingSchema）
      dispute        INTEGER NOT NULL DEFAULT 0,  -- 分歧点标记（LLM 判 + 人审确认）
      status         TEXT NOT NULL CHECK (status IN ('pending_review','verified','rejected')),
      reject_reason  TEXT,                    -- 驳回理由（废弃区回看；rejected 行不物理删）
      confidence     REAL NOT NULL,           -- AI 置信（0-1；只作队列排序不作自动批准——R3 红线）
      -- #claim 向量 provenance（F-05 模型迁移 sweep 面）。vec0 虚表无 model/dim 列（无 ALTER 路径），
      -- 而 pending/rejected 卡**没有 entry 行**（检索可见性 = 人审状态 F-06）——claim 路的 model/dim
      -- 记账只能落卡行。entry 行（verified）的 model/dim 恒镜像此两列（sweep/verify 双向同步）。
      claim_model    TEXT,
      claim_dim      INTEGER,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    -- 人审队列主路径：状态过滤 + 置信排序（confidence-asc 低置信排前，R5）。
    CREATE INDEX IF NOT EXISTS idx_closure_craft_card_queue
      ON closure_craft_card (status, confidence);
    -- 词目改挂/归并迁移的按词目寻址路径。
    CREATE INDEX IF NOT EXISTS idx_closure_craft_card_term
      ON closure_craft_card (term_id);

    CREATE TABLE IF NOT EXISTS closure_craft_term (
      term_id     TEXT PRIMARY KEY,           -- term-<8hex>
      category    TEXT NOT NULL,              -- 所属大类 slug（受控；卡 category 的单源）
      name        TEXT NOT NULL,              -- 词目名（中文，如「先抑后扬」）
      status      TEXT NOT NULL CHECK (status IN ('active','pending','merged')),
      merged_into TEXT,                       -- status='merged' 时并入的目标 termId（留痕不删）
      note        TEXT,
      UNIQUE(category, name)                  -- 业务唯一（词目业务键；同词目换大类 = 两行）
    );

    CREATE TABLE IF NOT EXISTS closure_craft_distill (
      material_id  TEXT PRIMARY KEY,          -- FK closure_material（材料级一行）
      content_hash TEXT NOT NULL,             -- 蒸馏时材料原件 hash（全量重蒸门控）
      derived_hash TEXT NOT NULL,             -- 蒸馏时派生 .md hash（F-07：变更→讲法 stale 复核不自动重蒸）
      status       TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','material-deleted')),
      stats_json   TEXT NOT NULL,             -- craftDistillStatsSchema（snake_case 键，W1 契约注记）
      phase        TEXT,                      -- 运行相位（running 时非 null——进度可见性）
      error        TEXT,                      -- 失败/挂起原因（never-throws 失败态落台账）
      distilled_at TEXT                       -- 最近蒸馏完成时刻（从未完成过 null）
    );

    -- merge review = 中档去重（0.85-0.98）的人审并排对比任务（W1 裁决：独立表而非卡行 JSON 列——
    -- 队列生命周期 ≠ 卡生命周期 + 待审列表热路径 WHERE resolution IS NULL 可索引 + F-04 落卡事务
    -- 内 review 行与卡行同进出）。new_claim_json = craftMergeReviewSchema['newClaim'] 序列化
    -- （未落卡的完整条目载荷——三动作裁决据此执行）。dispute_hint_json = LLM 分歧预判 verdict
    -- （CR-2b-D1 拍板 a 案：{dispute,reason}；null = 判定不可用——可选键二态纪律）。
    CREATE TABLE IF NOT EXISTS closure_craft_merge_review (
      review_id        TEXT PRIMARY KEY,      -- mrev-<12hex>
      new_claim_json   TEXT NOT NULL,
      existing_card_id TEXT NOT NULL,
      similarity       REAL NOT NULL,
      dispute_hint_json TEXT,                 -- null = LLM 分歧判定不可用（缺省态非「无分歧」）
      resolution_json  TEXT,                  -- null = 待审（三动作裁决后不可改）
      created_at       TEXT NOT NULL
    );
    -- 审阅 UI 热路径：待审队列（部分索引——resolved 行不占索引面）。
    CREATE INDEX IF NOT EXISTS idx_closure_craft_merge_review_open
      ON closure_craft_merge_review (created_at) WHERE resolution_json IS NULL;
  `);

  // ── E10.2b CR-2b-D1：closure_craft_merge_review 加 dispute_hint_json 列（内省式 ALTER——
  //    本 task W2 建表后又拍的 additive 列，旧测试库升级补列，mirror craft tags/source 先例）──
  const mergeReviewCols = db.pragma('table_info(closure_craft_merge_review)') as { name: string }[];
  if (!(mergeReviewCols.some((c) => c.name === 'dispute_hint_json'))) {
    db.exec('ALTER TABLE closure_craft_merge_review ADD COLUMN dispute_hint_json TEXT');
  }

  // ─── E10.3a（task 09-05）W1：拆解管线表族（parent design §2.1-2.2——job/断点 + 材料级事实层三表 + canon）──────────
  // 拆解 = 多 pass 倒推一本经 10.1 摄取的小说（P1 事实层→P2 canon→P3 计量→P4 手艺→P5 输出→P6 落卡）。
  // 本族全 DERIVED（可 drop 重建——真相源 = 材料原件 + 派生 .md）；与 closure_craft_distill 台账同门
  // （材料级记账），但断点粒度 = pass×unit 一等状态行（10.2 无相位级断点先例——本族即先例）。
  //
  // 🔑 材料生命周期联动（F-02，W6 接 materials:delete 级联）：
  // - closure_decon_job 双指纹（material_content_hash 原件 + derived_hash 派生 .md）——重入/读取时
  //   对现值校验，失配 → status='stale'（不静默沿用漂移锚点，用户确认重跑）。
  // - 级联四清按 materialId 尾缀清本族全表（material_ref 恒以 `mat-<12hex>`（16 字符）结尾——
  //   repository 用 substr(material_ref, -16) 精确匹配，生产写点值域单源在 deconMaterialRef）。
  // - 事实层三表（facts/entity/dictionary）**材料级键控非 job 私有**（F-07）：新 job 同指纹直接
  //   继承 P1 产物（粗拆→细拆迭代不重付事实层成本）——级联按材料清、job 删除不清三表。
  //
  // orphan/清扫纪律（F-01）：本族唯一写点 = decon 管线（W3+）与 deconJob 底座（W2）——无共享表
  // 第二写者，清扫谓词按 material_ref 尾缀即生产值域全量（勿按 schema DEFAULT 假设）。
  db.exec(`
    -- 拆解会话（一材料 × 一档位 = 一 job；同材料在途唯一 = 应用层 inflight 守卫，非表约束）。
    -- status 含 pending/cancelled 两态为 W2 状态机生命周期补全（parent §2.1 六态素描之外）。
    -- error 列：failed/capped 的诚实挂起 note（mirror closure_craft_distill.error）。
    CREATE TABLE IF NOT EXISTS closure_decon_job (
      job_id                TEXT PRIMARY KEY,        -- decon-<12hex>
      material_ref          TEXT NOT NULL,           -- 轨+id：global:mat-<sha12> | project:<5位>:mat-<sha12>
      tier                  TEXT NOT NULL CHECK (tier IN ('coarse','fine','deep')),
      dimensions_json       TEXT NOT NULL DEFAULT '[]',  -- 维度子集（目的先行；枚举权威在 parent §6.0 矩阵）
      status                TEXT NOT NULL CHECK (status IN ('pending','running','paused','done','failed','capped','stale','cancelled')),
      budget_json           TEXT NOT NULL,           -- deconBudgetSchema
      cost_json             TEXT NOT NULL,           -- deconCostSchema（实际累计——预估对照面）
      material_content_hash TEXT NOT NULL,           -- 🔑 双指纹①：create 时材料原件 hash（F-02 stale 门控）
      derived_hash          TEXT NOT NULL,           -- 🔑 双指纹②：create 时派生 .md hash（锚定基面）
      error                 TEXT,                    -- failed/capped 原因（诚实挂起 note）
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 同材料在途守卫查询路径 + 列表页。
    CREATE INDEX IF NOT EXISTS idx_closure_decon_job_material
      ON closure_decon_job (material_ref, status);

    -- 断点状态行（pass×unit 一等状态——台账式幂等重入的粒度面；UNIQUE(job_id,pass,unit) 即 PK）。
    -- pass 形态 p1a|p1b|p1c|p2|p3a|p3b|p4:<dim>|p5:<kind>|p6（动态后缀，zod 层校验，DDL 不 CHECK）。
    CREATE TABLE IF NOT EXISTS closure_decon_pass_state (
      job_id      TEXT NOT NULL,
      pass        TEXT NOT NULL,
      unit        TEXT NOT NULL,                     -- 章号(p1b)/域名(p2)/维度(p4)/单行哨兵 'all'
      status      TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','capped')),
      output_ref  TEXT,                              -- 产物行稳定引用（表+键，如 facts:3 / canon:world）
      output_hash TEXT,                              -- 产物内容 hash（重入校验防 stale 产物静默沿用）
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_id, pass, unit)
    );

    -- P1b 逐章 facts（材料级键控——F-07 跨 job 复用；facts_json = deconFactsSchema camelCase 原样）。
    CREATE TABLE IF NOT EXISTS closure_decon_facts (
      material_ref  TEXT NOT NULL,
      derived_hash  TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      facts_json    TEXT NOT NULL,
      PRIMARY KEY (material_ref, derived_hash, chapter_index)
    );

    -- P1c 聚合实体（材料级键控；别名归并后聚合行——canonical_name 域内唯一）。
    CREATE TABLE IF NOT EXISTS closure_decon_entity (
      material_ref   TEXT NOT NULL,
      derived_hash   TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      type           TEXT NOT NULL CHECK (type IN ('person','place','item','organization','concept')),
      aliases_json   TEXT NOT NULL DEFAULT '[]',
      mentions_json  TEXT NOT NULL DEFAULT '[]',     -- [{chapterIndex,count}]
      audit_json     TEXT NOT NULL DEFAULT '{}',     -- 幻觉过滤/归并留痕/类型投票（观测面）
      PRIMARY KEY (material_ref, derived_hash, canonical_name)
    );

    -- P1a 实体词典（材料级键控；注入 P1b 逐章 prompt 压幻觉）。
    CREATE TABLE IF NOT EXISTS closure_decon_dictionary (
      material_ref TEXT NOT NULL,
      derived_hash TEXT NOT NULL,
      entries_json TEXT NOT NULL,                    -- [{name,type,confidence}]
      PRIMARY KEY (material_ref, derived_hash)
    );

    -- canon 六域条目（P2 产出——同人保真薄事实档案；PK(job_id,domain,name) 自然键）。
    -- anchors_json 无锚不立行（zod min(1) 强约束——DDL 无 JSON 形状可 CHECK，契约层守）。
    -- timeline 域 payload 必含 consistency 三档 / relationship 域必含 pair（契约注释预留，C1-C9）。
    CREATE TABLE IF NOT EXISTS closure_canon_entry (
      job_id          TEXT NOT NULL,
      domain          TEXT NOT NULL CHECK (domain IN ('world','rule','character','tone','timeline','relationship')),
      name            TEXT NOT NULL,
      payload_json    TEXT NOT NULL,                 -- 域内自由形状 + evidence: exact|inferred 硬字段
      anchors_json    TEXT NOT NULL,
      provenance_json TEXT NOT NULL,                 -- {source:'decon', materialId, bookTitle}
      PRIMARY KEY (job_id, domain, name)
    );
    -- 域浏览/同人消费取数路径（PK 前缀可查但显式索引供 domain 过滤面）。
    CREATE INDEX IF NOT EXISTS idx_closure_canon_entry_job
      ON closure_canon_entry (job_id, domain);
  `);

  // ─── E10.3b（task 09-05）W1：拆解 child B 三表（product / report / review——child B design §1，
  //    全 job 键控非材料级：P3-P6 产物属会话，级联随 decon:delete / materials:delete 走）──────────
  // 行形状 zod 单源 shared-contracts closure-decon.ts（payload/content 按_pass 分派形状——DDL 无
  // JSON 形状可 CHECK，写侧 zod 门守）；unit 词形契约同源（DECON_PRODUCT/REPORT_UNIT_PATTERN）。
  // review 的 'off' = create 时用户关闸门（配置即行——job 表零改 A，拍板①）；stale 确认重跑时
  // approved 行复位 pending（resetDeconRerunState，M2——off 常设配置不翻）。
  db.exec(`
    -- 通用 pass 产物（P3a 标签 / P3b 弧+统计 / P4 findings——payload_json 按 pass 分派）。
    -- unit：p3a=章号 / p3b='arcs'|'stats' / p4=ch:N|arc:N|all(style)；p6 不落本表（产物=craft 卡）。
    CREATE TABLE IF NOT EXISTS closure_decon_product (
      job_id       TEXT NOT NULL,
      pass         TEXT NOT NULL,                    -- p3a|p3b|p4:<dim>（zod 层校验，DDL 不 CHECK）
      unit         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_id, pass, unit)
    );
    -- 读面按 pass 过滤（craft 闸门卡 / 产出阅读的取数路径）。
    CREATE INDEX IF NOT EXISTS idx_closure_decon_product_pass
      ON closure_decon_product (job_id, pass);

    -- P5 三层输出 + 风格报告（叙事性 markdown——不进 craft KB，读法/章评/细批/风格面）。
    -- dimension 关联维度（style_report → 'style'；其余可 NULL）；anchors_json 允许 '[]'（报告级
    -- 锚点是补充面，锚定纪律在证据条目级）。
    CREATE TABLE IF NOT EXISTS closure_decon_report (
      job_id       TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('book_reading','chapter_review','scene_annotation','style_report')),
      unit         TEXT NOT NULL,                    -- 'all' | 'ch:N' | 'scene:N'
      content_md   TEXT NOT NULL,
      anchors_json TEXT NOT NULL DEFAULT '[]',
      dimension    TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_id, kind, unit)
    );

    -- 人审闸门记录 + 配置（三 checkpoint——P1c 后词典 / P2 后 canon / P4 后 craft）。
    CREATE TABLE IF NOT EXISTS closure_decon_review (
      job_id     TEXT NOT NULL,
      checkpoint TEXT NOT NULL CHECK (checkpoint IN ('dictionary','canon','craft')),
      status     TEXT NOT NULL CHECK (status IN ('pending','approved','off')),
      note       TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_id, checkpoint)
    );
  `);
}
