import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched. The db module derives its path from os.homedir() (node:os mock below). A
// distinct dir from sqliteVec.spike.test.ts so the two suites never collide.
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-closure-schema');

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
}));

import { closeDb, getDb } from '../main/db/index';
import {
  isSqliteVecAvailable,
  loadSqliteVec,
  resetSqliteVecState,
} from '../main/db/sqliteVecLoader';

// better-sqlite3 is a native addon rebuilt against Electron's ABI for the app;
// under plain-Node vitest its ABI may not match (NODE_MODULE_VERSION mismatch),
// so the whole SQL integration suite skips instead of failing the run (same
// gate as sqliteVec.spike.test.ts).
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  // Close the handle first: Windows refuses to delete a locked db file.
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

describe.skipIf(!sqliteUsable)('closure derived-index schema (VS1 R1)', () => {
  beforeAll(clean);
  afterAll(clean);

  it('creates closure_entry + entry_fts + 3 triggers, and entry_vec only when sqlite-vec loaded', () => {
    // Ensure the data dir exists so the db file can be created.
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();

    const tableNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    const triggerNames = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='closure_entry'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );

    // closure_entry + entry_fts are built on FTS5 (built into the bundled
    // SQLite, no extension needed), so they are always present.
    expect(tableNames.has('closure_entry')).toBe(true);
    expect(tableNames.has('entry_fts')).toBe(true);
    // The three external-content sync triggers.
    expect(triggerNames.has('closure_entry_ai')).toBe(true);
    expect(triggerNames.has('closure_entry_ad')).toBe(true);
    expect(triggerNames.has('closure_entry_au')).toBe(true);

    // entry_vec is gated on the sqlite-vec extension loading. Asserting BOTH
    // branches proves the best-effort contract: when vec loads the table exists,
    // when it cannot the registry/FTS schema stays usable without vec0.
    if (vecAvailable) {
      expect(tableNames.has('entry_vec')).toBe(true);
    } else {
      expect(tableNames.has('entry_vec')).toBe(false);
    }
  });

  it('syncs closure_entry writes into entry_fts via the AFTER INSERT trigger', () => {
    const db = getDb();

    // 'silent' appears only in body_text (not in the name), so a match on this
    // term proves the trigger wired body_text into the FTS index. trigram needs
    // a >=3-char term to tokenize.
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, name, body_text)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('ftstest', 'p1', 'character', 'Ranger', 'texas ranger silent hunter');

    const hits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('silent') as { entry_id: string }[];
    expect(hits.map((h) => h.entry_id)).toContain('ftstest');
  });

  it('inserts + KNN-smokes entry_vec when sqlite-vec is available (no-op otherwise)', () => {
    const db = getDb();
    // When vec did not load, entry_vec is absent (asserted in the schema test);
    // there is nothing to smoke here.
    if (!isSqliteVecAvailable()) return;

    // Unit-ish 1024-dim vector (first dim = 1, rest 0). A pure-zero vector has
    // undefined cosine (zero norm); a unit query vector vs itself => distance ~0.
    const vec = Buffer.alloc(1024 * 4);
    vec.writeFloatLE(1.0, 0);

    // Story 8.7 multi-vector shape: one row PER VECTOR keyed by vector_id
    // (`${entry_id}#body`); entry_id demoted to a plain reverse-lookup column.
    // Story 8.3: status/visibility metadata columns are part of the shape (and
    // are NOT omittable — vec0 rejects NULL/absent TEXT metadata values).
    db.prepare(
      `INSERT INTO entry_vec(vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('vectest#body', 'p1', 'vectest', 'character', 'asset_card', 'body', 'active', 'known', vec);

    const rows = db
      .prepare(
        `SELECT vector_id, entry_id, vector_kind, distance
         FROM entry_vec
         WHERE project_id = ? AND embedding MATCH ? AND k = 1
         ORDER BY distance`,
      )
      .all('p1', vec) as {
      vector_id: string;
      entry_id: string;
      vector_kind: string;
      distance: number;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].vector_id).toBe('vectest#body');
    expect(rows[0].entry_id).toBe('vectest');
    expect(rows[0].vector_kind).toBe('body');
    expect(rows[0].distance).toBeLessThan(1e-6);
  });
});

// ── Story 8.7 schema（mention 账 + 摘要层加列 + vec 多向量，design §1.1–§1.4/§5）──────────
//
// 覆盖三面：新表/新列 fresh 建库形态、pre-8.7 旧库启动迁移（内省 ALTER 保留行 / vec 旧结构
// DROP+CREATE）、迁移后新结构可用性（multi-vector insert + KNN）。

/**
 * Hand-build a PRE-8.7 db (old table shapes only) with a raw handle, then hand
 * control back — the caller's next getDb() runs initSchema on it, exercising the
 * introspective migration paths exactly as an old-db first app start would.
 */
function buildPre87Db(build: (raw: Database.Database) => void): void {
  // Close + wipe so this db contains ONLY what `build` creates (no tables left
  // over from an earlier getDb() in this suite).
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
  mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
  // Lazy require (same ABI-gate pattern as above): a top-level VALUE import of
  // better-sqlite3 would fail suite collection under plain-Node vitest when the
  // addon targets Electron's ABI. The type-only import above is erased.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const raw: Database.Database = new Database(
    path.join(TEST_HOME, '.orison', 'data', 'projects.db'),
  );
  loadSqliteVec(raw);
  build(raw);
  raw.close();
  // loadSqliteVec caches availability in module state, NOT per connection —
  // reset so the next getDb() actually loads the extension on its own handle
  // (otherwise isSqliteVecAvailable() would lie and vec0 DDL would throw
  // "no such module").
  resetSqliteVecState();
}

describe.skipIf(!sqliteUsable)('closure 8.7 schema (mention ledger + summary columns + multi-vector vec)', () => {
  beforeAll(clean);
  afterAll(clean);

  it('creates closure_mention with enum CHECKs, composite PK, and the entry→chapter index', () => {
    const db = getDb();

    const tableSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_mention'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    expect(tableSql).toBeTruthy();
    // Enum legal sets enforced at the schema level (mirror tasks.status CHECK).
    expect(tableSql).toContain("presence IN ('present','mentioned')");
    expect(tableSql).toContain("source IN ('full','conservative')");
    expect(tableSql).toContain('PRIMARY KEY (project_id, episode_id, entry_id)');

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mention_entry'")
      .get();
    expect(idx).toBeTruthy();

    // CHECK rejects out-of-enum values (both enums).
    expect(() =>
      db
        .prepare('INSERT INTO closure_mention (project_id, episode_id, entry_id, presence) VALUES (?,?,?,?)')
        .run('00001', 'ep_1', 'card-a', 'bogus'),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          'INSERT INTO closure_mention (project_id, episode_id, entry_id, presence, source) VALUES (?,?,?,?,?)',
        )
        .run('00001', 'ep_1', 'card-a', 'present', 'wrong'),
    ).toThrow();

    // Legal row passes; the four channel flags + counters default to 0;
    // presence/source have no silent default (callers must state them).
    db.prepare(
      'INSERT INTO closure_mention (project_id, episode_id, entry_id, presence, source) VALUES (?,?,?,?,?)',
    ).run('00001', 'ep_1', 'card-a', 'present', 'full');
    const row = db
      .prepare('SELECT * FROM closure_mention WHERE project_id=? AND episode_id=? AND entry_id=?')
      .get('00001', 'ep_1', 'card-a') as Record<string, unknown>;
    expect(row.declared).toBe(0);
    expect(row.presence_shot).toBe(0);
    expect(row.coarse_hit).toBe(0);
    expect(row.coarse_count).toBe(0);
    expect(row.plan_linked).toBe(0);
    expect(row.state_changed).toBe(0);
    expect(row.updated_at).toBeTruthy();
  });

  it('creates closure_mention_signals (S9：episode 级信号持久面——composite PK + JSON 列)', () => {
    const db = getDb();
    const tableSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_mention_signals'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    expect(tableSql).toBeTruthy();
    expect(tableSql).toContain('PRIMARY KEY (project_id, episode_id)');

    // signals 是 JSON 数组列（五类 MentionSignal 落表值）；upsert 同事务写（repository 测试锚定语义）。
    db.prepare(
      "INSERT INTO closure_mention_signals (project_id, episode_id, signals) VALUES (?,?,?)",
    ).run('00001', 'ep_1', '[{"kind":"hard_miss","episodeId":"ep_1","entryId":"card-a"}]');
    const row = db
      .prepare('SELECT * FROM closure_mention_signals WHERE project_id=? AND episode_id=?')
      .get('00001', 'ep_1') as Record<string, unknown>;
    expect(JSON.parse(row.signals as string)).toHaveLength(1);
    expect(row.updated_at).toBeTruthy();
    // 同章重收 upsert 覆盖（PK 冲突路径由 repository ON CONFLICT 子句管，此处锚表存在性 + 列形态）。
  });

  it('fresh db carries the 8.7 columns (closure_entry 4 / craft 3 / relation source)', () => {
    const db = getDb();

    const entryCols = (db.pragma('table_info(closure_entry)') as { name: string }[]).map((c) => c.name);
    for (const col of ['summary_text', 'summary_source', 'summary_hash', 'status']) {
      expect(entryCols, `closure_entry.${col}`).toContain(col);
    }

    const craftCols = (db.pragma('table_info(closure_craft_entry)') as { name: string }[]).map(
      (c) => c.name,
    );
    for (const col of ['summary_text', 'summary_source', 'summary_hash']) {
      expect(craftCols, `closure_craft_entry.${col}`).toContain(col);
    }
    // craft has NO status concept (design §1.2).
    expect(craftCols).not.toContain('status');

    const relationCols = db.pragma('table_info(closure_relation)') as {
      name: string;
      dflt_value: string | null;
    }[];
    const sourceCol = relationCols.find((c) => c.name === 'source');
    expect(sourceCol).toBeTruthy();
    // Existing rows backfill to 'graph' via the column default (zero impact).
    expect(sourceCol?.dflt_value).toBe("'graph'");
  });

  it('migrates a pre-8.7 db: introspective ALTER adds the new columns, existing rows preserved', () => {
    buildPre87Db((raw) => {
      // Pre-8.7 shapes verbatim (no summary/status columns; relation has no
      // source column). initSchema's CREATE TABLE IF NOT EXISTS no-ops on these
      // and the guarded ALTERs must upgrade them in place.
      raw.exec(`
        CREATE TABLE closure_entry (
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
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE closure_relation (
          relation_id   TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL,
          src_entry_id  TEXT NOT NULL,
          tgt_entry_id  TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          polarity      TEXT,
          visibility    TEXT,
          strength      REAL,
          source_refs   TEXT,
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE closure_craft_entry (
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
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      raw
        .prepare(
          "INSERT INTO closure_entry (entry_id, project_id, entry_type, name, body_text) VALUES ('survivor', '00001', 'character', 'Erina', 'knife girl')",
        )
        .run();
      raw
        .prepare(
          "INSERT INTO closure_relation (relation_id, project_id, src_entry_id, tgt_entry_id, relation_type) VALUES ('rel-1', '00001', 'a', 'b', 'ally')",
        )
        .run();
    });

    const db = getDb(); // first app start on the old db → initSchema migrations.

    for (const [table, col] of [
      ['closure_entry', 'summary_text'],
      ['closure_entry', 'summary_source'],
      ['closure_entry', 'summary_hash'],
      ['closure_entry', 'status'],
      ['closure_craft_entry', 'summary_text'],
      ['closure_craft_entry', 'summary_source'],
      ['closure_craft_entry', 'summary_hash'],
      ['closure_relation', 'source'],
    ] as const) {
      const cols = (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
      expect(cols, `${table}.${col}`).toContain(col);
    }

    // Pre-existing rows survive the migration; new columns read back as
    // NULL (nullable additions) / the 'graph' default (relation source).
    const entryRow = db
      .prepare('SELECT summary_text, status FROM closure_entry WHERE entry_id=?')
      .get('survivor') as { summary_text: string | null; status: string | null };
    expect(entryRow.summary_text).toBeNull();
    expect(entryRow.status).toBeNull();
    const relRow = db
      .prepare('SELECT source FROM closure_relation WHERE relation_id=?')
      .get('rel-1') as { source: string };
    expect(relRow.source).toBe('graph');
  });

  it('migrates pre-8.7 single-vector vec tables to the multi-vector structure (DROP+CREATE)', () => {
    // Guard BEFORE buildPre87Db resets the loader cache: whether the vec binary
    // loads on this machine was settled by the earlier getDb() calls.
    if (!isSqliteVecAvailable()) return;

    buildPre87Db((raw) => {
      raw.exec(`
        CREATE VIRTUAL TABLE entry_vec USING vec0(
          entry_id TEXT PRIMARY KEY,
          project_id TEXT partition key,
          entry_type TEXT,
          source_kind TEXT,
          embedding float[8] distance_metric=cosine
        );
        CREATE VIRTUAL TABLE closure_craft_vec USING vec0(
          craft_id TEXT PRIMARY KEY,
          craft_type TEXT,
          source_kind TEXT,
          embedding float[8] distance_metric=cosine
        );
      `);
      const vec8 = Buffer.alloc(8 * 4);
      vec8.writeFloatLE(1.0, 0);
      raw
        .prepare(
          "INSERT INTO entry_vec (entry_id, project_id, entry_type, source_kind, embedding) VALUES ('old-vec', '00001', 'character', 'asset_card', ?)",
        )
        .run(vec8);
    });

    const db = getDb(); // initSchema detects the old structure → DROP + reCREATE.

    for (const name of ['entry_vec', 'closure_craft_vec']) {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as
          | { sql: string }
          | undefined
      )?.sql;
      expect(sql, name).toContain('vector_id TEXT PRIMARY KEY');
      expect(sql, name).toContain('vector_kind TEXT');
    }
    // entry_vec keeps the project_id partition key and gains the plain
    // reverse-lookup entry_id column (no longer the PK).
    const entryVecSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_vec'").get() as {
        sql: string;
      }
    ).sql;
    expect(entryVecSql).toContain('project_id TEXT partition key');
    expect(entryVecSql).not.toContain('entry_id TEXT PRIMARY KEY');

    // Old-structure vectors are dropped (DERIVED — reindex backfills; no real
    // data window, design §5).
    expect((db.prepare('SELECT count(*) AS n FROM entry_vec').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM closure_craft_vec').get() as { n: number }).n).toBe(0);

    // The recreated table accepts per-vector rows and KNN returns both kinds.
    const vec = Buffer.alloc(1024 * 4);
    vec.writeFloatLE(1.0, 0);
    const insertVec = db.prepare(
      `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertVec.run('card-a#body', '00001', 'card-a', 'character', 'asset_card', 'body', 'active', 'known', vec);
    insertVec.run('card-a#identity', '00001', 'card-a', 'character', 'asset_card', 'identity', 'active', 'known', vec);
    const rows = db
      .prepare(
        `SELECT vector_id, vector_kind FROM entry_vec
         WHERE project_id = ? AND embedding MATCH ? AND k = 2 ORDER BY distance`,
      )
      .all('00001', vec) as { vector_id: string; vector_kind: string }[];
    expect(rows.map((r) => r.vector_id).sort()).toEqual(['card-a#body', 'card-a#identity']);
  });
});

// ── Story 8.3 schema（chunk 章源列 + entry_fts index_text + vec status/visibility，design §2.2/§4）──
//
// 覆盖四面：fresh 建库新形态、pre-8.3 旧库启动迁移（closure_entry 内省 ALTER / entry_fts
// DROP+reCREATE+rebuild / entry_vec 旧结构 DROP+reCREATE）、迁移后新结构可用性、以及两条
// **Electron 探针钉死**（design §10 风险项，防版本漂移）：
//  ① vec0 TEXT metadata 列拒绝 NULL（显式 NULL 与省略列皆抛）→ 生产写 '' sentinel；
//  ② FTS5 external-content 的 NULL 列值安全（trigger insert / MATCH / rebuild / 不进匹配面）。
describe.skipIf(!sqliteUsable)('closure 8.3 schema (chapter columns + FTS index_text + vec metadata)', () => {
  beforeAll(clean);
  afterAll(clean);

  it('fresh db carries the 8.3 shapes: closure_entry 7 columns, entry_fts index_text, vec status/visibility, chapter index', () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();

    const entryCols = (db.pragma('table_info(closure_entry)') as { name: string }[]).map((c) => c.name);
    for (const col of [
      'chapter_id',
      'chapter_index',
      'char_start',
      'char_end',
      'para_start',
      'para_end',
      'index_text',
    ]) {
      expect(entryCols, `closure_entry.${col}`).toContain(col);
    }

    // entry_fts gained the index_text column AND the triggers pass it (single
    // source: the FTS DDL constant both creates and migrates).
    const ftsSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_fts'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    expect(ftsSql).toContain('index_text');
    for (const trigger of ['closure_entry_ai', 'closure_entry_ad', 'closure_entry_au']) {
      const trigSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger) as
          | { sql: string }
          | undefined
      )?.sql;
      expect(trigSql, trigger).toContain('index_text');
    }

    // Chapter access index (watcher reindex scope / orphan cleanup / 出处取行).
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_closure_entry_chapter'").get(),
    ).toBeTruthy();

    if (isSqliteVecAvailable()) {
      const vecSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_vec'").get() as
          | { sql: string }
          | undefined
      )?.sql;
      expect(vecSql).toContain('status TEXT');
      expect(vecSql).toContain('visibility TEXT');
    }
  });

  it('probe ①: vec0 TEXT metadata columns REJECT NULL (explicit null AND omitted) — the production writers must use the "" sentinel', () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    const vec = Buffer.alloc(1024 * 4);
    vec.writeFloatLE(1.0, 0);

    // Explicit NULL → throws (probe-proven on this exact Electron/sqlite-vec pair).
    expect(() =>
      db
        .prepare(
          `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('probe-null#body', 'p83', 'probe-null', 'character', 'asset_card', 'body', null, 'known', vec),
    ).toThrow(/Expected text for TEXT metadata column status/);

    // Omitting the columns entirely → same rejection (metadata columns are NOT
    // optional). This is why EVERY entry_vec INSERT site was updated in lockstep.
    expect(() =>
      db
        .prepare(
          `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('probe-omit#body', 'p83', 'probe-omit', 'character', 'asset_card', 'body', vec),
    ).toThrow(/Expected text for TEXT metadata column status/);
  });

  it('probe ①b: KNN `status = value` pre-prunes INSIDE vec0 and excludes the "" sentinel rows — aligned with closure_entry SQL NULL semantics', () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    // Three orthogonal unit vectors at distinct slots: a=active, b=deprecated,
    // c='' sentinel (the shape production writers use for NULL-status sources).
    const mkVec = (slot: number) => {
      const b = Buffer.alloc(1024 * 4);
      b.writeFloatLE(1.0, slot * 4);
      return b;
    };
    const insert = db.prepare(
      `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'known', ?)`,
    );
    insert.run('pa#body', 'p83b', 'pa', 'character', 'setting_card', 'body', 'active', mkVec(0));
    insert.run('pb#body', 'p83b', 'pb', 'character', 'setting_card', 'body', 'deprecated', mkVec(1));
    insert.run('pc#body', 'p83b', 'pc', 'character', 'setting_md', 'body', '', mkVec(2));

    const knn = (sql: string, ...params: unknown[]) =>
      db.prepare(sql).all(...params) as { vector_id: string }[];

    // Baseline (no filter): all three rows reachable.
    expect(
      knn(
        `SELECT vector_id FROM entry_vec
         WHERE embedding MATCH ? AND k = 3 AND project_id = ? ORDER BY distance`,
        mkVec(0),
        'p83b',
      ).map((r) => r.vector_id).sort(),
    ).toEqual(['pa#body', 'pb#body', 'pc#body']);

    // status = 'active' INSIDE the KNN: only the active row survives — both the
    // differently-valued row AND the '' sentinel row are excluded. This is the
    // SQL `=` semantics the closure_entry WHERE belt has for NULL rows (a NULL
    // entry status never matches a concrete filter): sentinel '' behaves as NULL.
    expect(
      knn(
        `SELECT vector_id FROM entry_vec
         WHERE embedding MATCH ? AND k = 3 AND project_id = ? AND status = ? ORDER BY distance`,
        mkVec(0),
        'p83b',
        'active',
      ).map((r) => r.vector_id),
    ).toEqual(['pa#body']);

    // Pre-pruning is real, not post-filtering: query nearest to the SENTINEL row
    // (slot 2) with status='active' — the sentinel row itself is excluded and the
    // nearest MATCHING row (pa) is returned with the k budget intact. This is the
    // S4 buildRrfQuery shape (partition key + metadata + KNN, mirror vecEt).
    expect(
      knn(
        `SELECT vector_id FROM entry_vec
         WHERE embedding MATCH ? AND k = 1 AND project_id = ? AND status = ? ORDER BY distance`,
        mkVec(2),
        'p83b',
        'active',
      ).map((r) => r.vector_id),
    ).toEqual(['pa#body']);

    // Point query agrees (plain SQL over the metadata column).
    expect(
      (db.prepare('SELECT count(*) AS n FROM entry_vec WHERE status = ?').get('active') as { n: number }).n,
    ).toBe(1);
  });

  it('migrates a pre-8.3 db: closure_entry ALTER + entry_fts DROP/reCREATE/rebuild + entry_vec structure rebuild', () => {
    // Guard BEFORE buildPre87Db resets the loader cache (mirror the 8.7 test):
    // whether the vec binary loads was settled by the earlier getDb() calls.
    const vecWasAvailable = isSqliteVecAvailable();

    buildPre87Db((raw) => {
      // Pre-8.3 shape verbatim: closure_entry carries the 8.7 columns but NOT the
      // seven chapter columns; entry_fts is the 3-column external-content table
      // with the OLD trigger definitions; entry_vec is the 8.7 multi-vector shape
      // WITHOUT status/visibility.
      raw.exec(`
        CREATE TABLE closure_entry (
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
          summary_text  TEXT,
          summary_source TEXT,
          summary_hash  TEXT,
          status        TEXT,
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE entry_fts USING fts5(
          entry_id UNINDEXED,
          name,
          body_text,
          content='closure_entry',
          content_rowid='rowid',
          tokenize='trigram'
        );
        CREATE TRIGGER closure_entry_ai AFTER INSERT ON closure_entry BEGIN
          INSERT INTO entry_fts(rowid, entry_id, name, body_text)
          VALUES (new.rowid, new.entry_id, new.name, new.body_text);
        END;
        CREATE TRIGGER closure_entry_ad AFTER DELETE ON closure_entry BEGIN
          INSERT INTO entry_fts(entry_fts, rowid, entry_id, name, body_text)
          VALUES ('delete', old.rowid, old.entry_id, old.name, old.body_text);
        END;
        CREATE TRIGGER closure_entry_au AFTER UPDATE ON closure_entry BEGIN
          INSERT INTO entry_fts(entry_fts, rowid, entry_id, name, body_text)
          VALUES ('delete', old.rowid, old.entry_id, old.name, old.body_text);
          INSERT INTO entry_fts(rowid, entry_id, name, body_text)
          VALUES (new.rowid, new.entry_id, new.name, new.body_text);
        END;
      `);
      if (vecWasAvailable) {
        raw.exec(`
          CREATE VIRTUAL TABLE entry_vec USING vec0(
            vector_id TEXT PRIMARY KEY,
            project_id TEXT partition key,
            entry_id TEXT,
            entry_type TEXT,
            source_kind TEXT,
            vector_kind TEXT,
            embedding float[8] distance_metric=cosine
          );
        `);
        const vec8 = Buffer.alloc(8 * 4);
        vec8.writeFloatLE(1.0, 0);
        raw
          .prepare(
            "INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, embedding) VALUES ('old83-vec#body', '00001', 'old83-vec', 'character', 'setting_card', 'body', ?)",
          )
          .run(vec8);
      }
      // A row that must SURVIVE the migration (old trigger indexes it into the
      // old-shape FTS; the rebuild must carry it into the new-shape FTS).
      raw
        .prepare(
          "INSERT INTO closure_entry (entry_id, project_id, entry_type, name, body_text) VALUES ('survivor83', '00001', 'character', 'Erina', '刀锋少女静默狩猎')",
        )
        .run();
      // E1（CR 2026-08-20）：有向量记账的行（model + content_hash 齐）——迁移须清 hash 为
      // pending_embed 语义（vec0 结构 DROP = 向量全丢，hash-skip 会永久阻断重嵌）。
      raw
        .prepare(
          "INSERT INTO closure_entry (entry_id, project_id, entry_type, name, body_text, content_hash, model, dim) VALUES ('embedded83', '00001', 'character', 'Vault', '地窖深处的守望者', 'deadbeefdeadbeef', 'embed-m', 8)",
        )
        .run();
    });

    const db = getDb(); // first app start on the pre-8.3 db → initSchema migrations.

    // 1. closure_entry: seven columns added, row preserved with NULL chapter cols.
    const entryCols = (db.pragma('table_info(closure_entry)') as { name: string }[]).map((c) => c.name);
    for (const col of ['chapter_id', 'chapter_index', 'char_start', 'char_end', 'para_start', 'para_end', 'index_text']) {
      expect(entryCols, `closure_entry.${col}`).toContain(col);
    }
    const survivor = db
      .prepare('SELECT chapter_id, index_text, body_text FROM closure_entry WHERE entry_id=?')
      .get('survivor83') as { chapter_id: string | null; index_text: string | null; body_text: string };
    expect(survivor.chapter_id).toBeNull();
    expect(survivor.index_text).toBeNull();
    expect(survivor.body_text).toContain('刀锋少女');

    // E1：vec0 旧结构 DROP 迁移同步清 model 行 content_hash（NULL = pending_embed——下次 reindex
    // NULL !== hash 触发重嵌补回；修复前 hash-skip 使既有向量静默丢失）。
    const embedded = db
      .prepare('SELECT content_hash FROM closure_entry WHERE entry_id=?')
      .get('embedded83') as { content_hash: string | null };
    expect(embedded.content_hash).toBeNull();

    // 2. entry_fts: rebuilt in the NEW shape (index_text column) and the
    //    pre-migration row is still FTS-reachable (data preserved through the
    //    DROP+reCREATE+rebuild — external-content rebuild reads closure_entry).
    const ftsSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_fts'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    expect(ftsSql).toContain('index_text');
    const trigSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='closure_entry_ai'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    // The migration replaced the OLD trigger (IF NOT EXISTS would have no-opped
    // on it — the global-trigger-name trap); the new one carries index_text.
    expect(trigSql).toContain('index_text');
    const rebuiltHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('静默狩猎') as { entry_id: string }[];
    expect(rebuiltHits.map((h) => h.entry_id)).toContain('survivor83');

    // 3. entry_vec: the pre-8.3 (8.7-shape) table was detected + rebuilt with the
    //    metadata columns; old vectors dropped (DERIVED — reindex backfills).
    if (isSqliteVecAvailable()) {
      const vecSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_vec'").get() as
          | { sql: string }
          | undefined
      )?.sql;
      expect(vecSql).toContain('status TEXT');
      expect(vecSql).toContain('visibility TEXT');
      expect((db.prepare('SELECT count(*) AS n FROM entry_vec').get() as { n: number }).n).toBe(0);
    }
  });

  it('probe ②: FTS index_text semantics — chunk rows match via prefix+正文, NULL-index rows keep name+body matching only', () => {
    const db = getDb();

    // Chunk-style row (source_kind='chapter'): index_text = 梗概 prefix + 正文,
    // body_text = 正文原文 only. The prefix term appears ONLY in index_text.
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, chapter_id, chapter_index,
          char_start, char_end, para_start, para_end, index_text)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      '00001:ep_1#c0',
      '00001',
      'chapter',
      'chapter',
      '第1章·段0',
      '雨夜里他推开当铺的门',
      'ep_1',
      1,
      0,
      10,
      0,
      1,
      '[梗概：黑市拍卖会风云突变] 雨夜里他推开当铺的门',
    );
    // Non-chapter row: index_text NULL (probe: NULL survives trigger insert +
    // contributes zero tokens — not in the match surface).
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text)
       VALUES (?,?,?,?,?,?)`,
    ).run('plain83', '00001', 'character', 'setting_card', '玄机子', '算命先生看破天机');

    const match = (term: string) =>
      (db.prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?').all(term) as {
        entry_id: string;
      }[]).map((r) => r.entry_id).sort();

    // Chunk row: reachable via the prefix-only term (contextual prefix in the
    // FTS arm) AND via its 正文 term.
    expect(match('拍卖会风云突变')).toEqual(['00001:ep_1#c0']);
    expect(match('当铺的门')).toEqual(['00001:ep_1#c0']);
    // Non-chapter row: body term still matches (existing behavior preserved);
    // the prefix-only term does NOT hit it; and the chunk's index_text does not
    // leak the NULL row into anything.
    expect(match('看破天机')).toEqual(['plain83']);
    expect(match('玄机子')).toEqual(['plain83']);
    // A term in nobody's surface: no hits at all.
    expect(match('完全不存在的词组')).toEqual([]);

    // integrity-check passes with NULL index_text rows present (probe ② pinned:
    // rebuild/integrity over nullable FTS columns is safe).
    expect(() => db.exec(`INSERT INTO entry_fts(entry_fts) VALUES('integrity-check')`)).not.toThrow();
  });
});
