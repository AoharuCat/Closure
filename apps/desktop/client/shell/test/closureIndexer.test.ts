import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched. The db module derives its path from os.homedir() (node:os mock below). A
// distinct dir from the other suites so they never collide.
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-closure-indexer');

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
  // modelGatewayIpc imports ipcMain at module load (only used inside
  // registerModelGatewayIpc, which the tests never call). Provide a no-op so
  // the import resolves without pulling in the real Electron runtime.
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

import {
  EMBED_DIM,
  floatArrayToBuffer,
  materializeBody,
  reindexAll,
  reindexAsset,
  reindexAssetDelete,
  shouldSkipForModelMismatch,
} from '../main/db/closureIndexer';
import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 is a native addon rebuilt against Electron's ABI for the app;
// under plain-Node vitest its ABI may not match (NODE_MODULE_VERSION mismatch),
// so the SQL integration suite skips instead of failing the run (same gate as
// closureSchema.test.ts / sqliteVec.spike.test.ts). The Electron one-shot smoke
// (scripts/smoke-closure-indexer.cjs) is the runtime gate-G3 evidence.
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

// A stub ResolvedModel used by the DI seam in the DB-integration tests.
function stubModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'text-embedding-3-test',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:0',
    apiKey: 'stub',
    capability: 'embedding',
  };
}

// A unit 1024-dim vector (first dim = 1, rest 0). cosine distance ignores
// magnitude, so no explicit normalization is needed.
function vec1024(): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[0] = 1.0;
  return v;
}

// ── Pure-logic unit tests (RUN under plain vitest, no DB) ──
// These exercise the helper logic exported from closureIndexer without touching
// SQLite, giving real coverage even where the DB suite skips on ABI mismatch.
describe('closureIndexer pure logic (VS1 R3)', () => {
  it('materializeBody joins name + summary, skipping empty parts', () => {
    expect(materializeBody('Ranger', 'texas ranger')).toBe('Ranger\ntexas ranger');
    // null summary → name only
    expect(materializeBody('Ranger', null)).toBe('Ranger');
    // empty-string parts filtered (matches filter(Boolean))
    expect(materializeBody('Ranger', '')).toBe('Ranger');
    expect(materializeBody('', '')).toBe('');
    expect(materializeBody(null, null)).toBe('');
  });

  it('floatArrayToBuffer encodes floats little-endian (round-trips)', () => {
    const floats = [1.5, -2.25, 0, 3.14159];
    const buf = floatArrayToBuffer(floats);
    expect(buf.length).toBe(floats.length * 4);
    const back: number[] = [];
    for (let i = 0; i < floats.length; i++) back.push(buf.readFloatLE(i * 4));
    // 32-bit float round-trip is exact for these values (or within epsilon).
    back.forEach((v, i) => expect(v).toBeCloseTo(floats[i], 6));
  });

  it('content-hash skip is stable for an unchanged body, sensitive to a change', () => {
    // Mirror the exact hash + skip predicate closureIndexer uses:
    //   skip = existing?.content_hash === sha256(materializeBody(name, summary)).
    const hash = (name: string, summary: string | null) =>
      createHash('sha256').update(materializeBody(name, summary)).digest('hex');

    const a1 = hash('Ranger', 'texas ranger');
    const a2 = hash('Ranger', 'texas ranger');
    expect(a1).toBe(a2); // unchanged body → skip (equal hashes)

    const b = hash('Ranger', 'oregon ranger');
    expect(b).not.toBe(a1); // changed body → reindex (different hash)
  });

  // ── CR-02: model-consistency gate (pure predicate; the DB-touching half is
  // runtime-proven via the Electron smoke — not testable under plain vitest due
  // to the better-sqlite3 ABI skip). ──
  it('shouldSkipForModelMismatch: no prevailing model → false (first embed always allowed)', () => {
    // A fresh project (no embedded entries) has no prevailing model, so the very
    // first embed under any model is allowed — it BECOMES the prevailing model.
    expect(shouldSkipForModelMismatch(null, 'bge-m3')).toBe(false);
  });

  it('shouldSkipForModelMismatch: prevailing === resolved → false (same vector space)', () => {
    expect(shouldSkipForModelMismatch('bge-m3', 'bge-m3')).toBe(false);
  });

  it('shouldSkipForModelMismatch: prevailing !== resolved → true (would corrupt the space)', () => {
    // Different models live in different geometric spaces even at the same dim
    // (research §2.4) — writing this vector would mix models in one vec0 table.
    expect(shouldSkipForModelMismatch('bge-m3', 'qwen3-embedding')).toBe(true);
  });
});

// ── DB-integration tests (skip under plain vitest on ABI mismatch) ──
describe.skipIf(!sqliteUsable)('closureIndexer DB integration (VS1 R3)', () => {
  beforeAll(() => {
    clean();
    // project_assets has a real FK to projects(project_id), and the
    // Electron-rebuild binary enforces foreign keys by default (the plain-Node
    // prebuilt one does not). Seed a real registry row for the fake 'p1' id so
    // seedAsset passes the constraint — column set mirrors ensureProject's
    // INSERT (sibling suites register via ensureProject; it auto-assigns a
    // 5-digit id, so a raw INSERT is the minimal way to keep 'p1').
    getDb()
      .prepare(
        `INSERT INTO projects
           (project_id, project_name, project_type, local_fingerprint, project_path, last_opened_at)
         VALUES ('p1', 'Closure Indexer Test', 'novel', 'closure-indexer-test-p1', 'closure-indexer-test-p1', ?)`,
      )
      .run(new Date().toISOString());
  });
  afterAll(clean);

  function seedAsset(assetId: string, name: string, summary: string | null, projectId = 'p1') {
    const db = getDb();
    db.prepare(
      `INSERT INTO project_assets
         (asset_id, project_id, asset_type, asset_name, asset_group, asset_status, relative_path, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(assetId, projectId, 'character', name, '', 'active', '', summary);
  }

  it('reindexAsset writes closure_entry + entry_fts + entry_vec (when vec available)', async () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    seedAsset('asset-A', 'Ranger', 'texas ranger silent hunter');

    let embedCalls = 0;
    await reindexAsset('p1', 'asset-A', {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    });

    // embed ran exactly once (no prior entry → no hash skip).
    expect(embedCalls).toBe(1);

    // closure_entry row present with the materialized body + provenance.
    const entry = db
      .prepare('SELECT name, body_text, content_hash, model, dim FROM closure_entry WHERE entry_id=?')
      .get('asset-A') as {
      name: string; body_text: string; content_hash: string; model: string | null; dim: number | null;
    };
    expect(entry.name).toBe('Ranger');
    expect(entry.body_text).toBe('Ranger\ntexas ranger silent hunter');
    expect(entry.content_hash.length).toBe(64); // sha256 hex
    // model/dim are recorded on closure_entry from the embed result, regardless
    // of whether the vec extension loaded (the extension only gates the
    // entry_vec INSERT, not the provenance columns).
    expect(entry.model).toBe('text-embedding-3-test');
    expect(entry.dim).toBe(EMBED_DIM);

    // entry_fts MATCH finds a body-only term (proves AFTER INSERT trigger).
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('silent') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain('asset-A');

    // entry_vec row queryable via KNN when the extension loaded.
    if (vecAvailable) {
      const rows = db
        .prepare(
          `SELECT entry_id, distance
           FROM entry_vec
           WHERE embedding MATCH ? AND k = 1 AND project_id = ?`,
        )
        .all(floatArrayToBuffer(vec1024()), 'p1') as { entry_id: string; distance: number }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_id).toBe('asset-A');
      expect(rows[0].distance).toBeLessThan(1e-6);

      // Story 8.7 §1.3: card-type entries write a SINGLE #body vector row
      // (vector_id PK + entry_id reverse-lookup column + vector_kind).
      // Story 8.3: status/visibility metadata mirror the closure_entry values —
      // project_assets rows carry NO closure status ('' sentinel) + 'known'.
      const vecRows = db
        .prepare('SELECT vector_id, entry_id, vector_kind, status, visibility FROM entry_vec WHERE entry_id=?')
        .all('asset-A') as {
        vector_id: string;
        entry_id: string;
        vector_kind: string;
        status: string;
        visibility: string;
      }[];
      expect(vecRows).toHaveLength(1);
      expect(vecRows[0]).toEqual({
        vector_id: 'asset-A#body',
        entry_id: 'asset-A',
        vector_kind: 'body',
        status: '',
        visibility: 'known',
      });
    }
  });

  it('content-hash skip: unchanged body does not re-embed', async () => {
    const db = getDb();
    seedAsset('asset-B', 'Scout', 'lone wanderer');

    let embedCalls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    };
    await reindexAsset('p1', 'asset-B', deps);
    expect(embedCalls).toBe(1);

    // Second pass with an UNCHANGED body → hash skip → embed NOT called again.
    await reindexAsset('p1', 'asset-B', deps);
    expect(embedCalls).toBe(1);

    // Sanity: the row is still there.
    const entry = db
      .prepare('SELECT body_text FROM closure_entry WHERE entry_id=?')
      .get('asset-B') as { body_text: string };
    expect(entry.body_text).toBe('Scout\nlone wanderer');
  });

  it('no model → FTS-only (closure_entry + entry_fts present, entry_vec absent)', async () => {
    const db = getDb();
    seedAsset('asset-C', 'Mage', 'arcane ritual');

    await reindexAsset('p1', 'asset-C', {
      resolveModel: () => null, // no embedding model configured
      embed: async () => vec1024(), // should NOT be called when model is null
    });

    const entry = db
      .prepare('SELECT model, dim FROM closure_entry WHERE entry_id=?')
      .get('asset-C') as { model: string | null; dim: number | null };
    expect(entry.model).toBeNull();
    expect(entry.dim).toBeNull();

    // FTS still indexed (degradation is vector-only, never FTS).
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('arcane') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain('asset-C');

    // No vec row was written for this entry.
    if (isSqliteVecAvailable()) {
      const vecRows = db
        .prepare('SELECT entry_id FROM entry_vec WHERE entry_id=?')
        .all('asset-C') as { entry_id: string }[];
      expect(vecRows).toHaveLength(0);
    }
  });

  it('embed failure → FTS-only (pending_embed)', async () => {
    const db = getDb();
    seedAsset('asset-D', 'Knight', 'oathbound');

    await reindexAsset('p1', 'asset-D', {
      resolveModel: () => stubModel(),
      embed: async () => {
        throw new Error('network down');
      },
    });

    const entry = db
      .prepare('SELECT model, dim FROM closure_entry WHERE entry_id=?')
      .get('asset-D') as { model: string | null; dim: number | null };
    expect(entry.model).toBeNull();
    expect(entry.dim).toBeNull();

    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('oathbound') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain('asset-D');
  });

  it('embedding dim mismatch → FTS-only', async () => {
    const db = getDb();
    seedAsset('asset-E', 'Bard', 'wandering song');

    await reindexAsset('p1', 'asset-E', {
      resolveModel: () => stubModel(),
      embed: async () => [1, 2, 3], // wrong dim
    });

    const entry = db
      .prepare('SELECT dim FROM closure_entry WHERE entry_id=?')
      .get('asset-E') as { dim: number | null };
    expect(entry.dim).toBeNull();
  });

  it('reindexAssetDelete clears closure_entry + entry_fts (+ entry_vec)', async () => {
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    seedAsset('asset-F', 'Healer', 'mending hands');
    await reindexAsset('p1', 'asset-F', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    // Precondition: row present.
    expect(
      (db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get('asset-F') as undefined | object),
    ).toBeDefined();

    await reindexAssetDelete('p1', 'asset-F');

    expect(db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get('asset-F')).toBeUndefined();
    // AFTER DELETE trigger must have cleared the FTS row.
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('mending') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).not.toContain('asset-F');
    if (vecAvailable) {
      const vecRows = db
        .prepare('SELECT entry_id FROM entry_vec WHERE entry_id=?')
        .all('asset-F') as { entry_id: string }[];
      expect(vecRows).toHaveLength(0);
    }
  });

  it('reindexAsset on a deleted asset delegates to the delete path (no orphan)', async () => {
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    seedAsset('asset-G', 'Rogue', 'shadow step');
    await reindexAsset('p1', 'asset-G', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    // Delete the canonical row directly, then reindex — reindex must observe
    // the missing source row and clean up the derived index.
    db.prepare('DELETE FROM project_assets WHERE project_id=? AND asset_id=?').run('p1', 'asset-G');
    await reindexAsset('p1', 'asset-G', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    expect(db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get('asset-G')).toBeUndefined();
    if (vecAvailable) {
      const vecRows = db
        .prepare('SELECT entry_id FROM entry_vec WHERE entry_id=?')
        .all('asset-G') as { entry_id: string }[];
      expect(vecRows).toHaveLength(0);
    }
  });

  // ── E1（CR 2026-08-20）：vec0 结构/维度 DROP 后 hash-skip 阻断重嵌——迁移点清 content_hash ──

  it('E1a：entry_vec 旧结构 DROP 迁移清 content_hash → reindexAsset 补回向量（drop 后重索引能恢复）', async () => {
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    seedAsset('asset-e1a', 'Sentry', 'gate watcher');
    let embedCalls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    };
    await reindexAsset('p1', 'asset-e1a', deps);
    expect(embedCalls).toBe(1);
    expect(
      (db.prepare('SELECT content_hash FROM closure_entry WHERE entry_id=?').get('asset-e1a') as { content_hash: string | null }).content_hash,
    ).toHaveLength(64);

    // 模拟 pre-8.3 旧结构（无 status/visibility metadata 列）→ 重启走 initSchema 迁移。
    db.exec('DROP TABLE entry_vec');
    db.exec(`CREATE VIRTUAL TABLE entry_vec USING vec0(
      vector_id TEXT PRIMARY KEY,
      project_id TEXT partition key,
      entry_id TEXT,
      entry_type TEXT,
      source_kind TEXT,
      vector_kind TEXT,
      embedding float[1024] distance_metric=cosine
    )`);
    closeDb();
    resetSqliteVecState();
    const reopened = getDb(); // 重启：initSchema 检测旧结构 → DROP + reCREATE + 清 hash（E1）

    // 迁移点清 hash：有向量记账（model IS NOT NULL）的行全变 pending_embed 语义——修复前
    // hash-skip 会让这些行的向量静默丢失（FTS-only 降质无提示）。
    expect(
      (reopened.prepare('SELECT content_hash FROM closure_entry WHERE entry_id=?').get('asset-e1a') as { content_hash: string | null }).content_hash,
    ).toBeNull();
    if (vecAvailable) {
      expect((reopened.prepare('SELECT COUNT(*) AS n FROM entry_vec').get() as { n: number }).n).toBe(0);
      const vecSql = (
        reopened.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entry_vec'").get() as
          | { sql: string }
          | undefined
      )?.sql;
      expect(vecSql).toContain('status TEXT'); // 新结构
    }

    // 重索引（无 force）：NULL !== hash → 重嵌补回。
    await reindexAsset('p1', 'asset-e1a', deps);
    expect(embedCalls).toBe(2);
    expect(
      (reopened.prepare('SELECT content_hash, model FROM closure_entry WHERE entry_id=?').get('asset-e1a') as { content_hash: string | null; model: string | null }).content_hash,
    ).toHaveLength(64);
    if (vecAvailable) {
      const vecRows = reopened
        .prepare('SELECT entry_id FROM entry_vec WHERE entry_id=?')
        .all('asset-e1a') as { entry_id: string }[];
      expect(vecRows).toHaveLength(1);
    }
  });

  it('E1b：reindexAll dim change（ensureEntryVecDim 重建）→ 他项目行 hash 同步清 → 无 force 重索引补回', async () => {
    const db = getDb();
    // 第二个项目（vec0 dim 是表级——p1 的 dim 重建会全项目丢向量，p2 是「未参与 rebuild 的项目」形态）。
    db.prepare(
      `INSERT INTO projects
         (project_id, project_name, project_type, local_fingerprint, project_path, last_opened_at)
       VALUES ('p2', 'Closure Indexer Test 2', 'novel', 'closure-indexer-test-p2', 'closure-indexer-test-p2', ?)`,
    ).run(new Date().toISOString());
    seedAsset('asset-p2a', 'Warden', 'far tower', 'p2');
    await reindexAsset('p2', 'asset-p2a', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    expect(
      (db.prepare('SELECT content_hash FROM closure_entry WHERE entry_id=?').get('asset-p2a') as { content_hash: string | null }).content_hash,
    ).toHaveLength(64);

    // p1 换 512-dim 模型全量重建：ensureEntryVecDim DROP+CREATE at 512 + E1 清全库 model 行 hash。
    const vec512 = new Array(512).fill(0);
    vec512[0] = 1.0;
    const result = await reindexAll('p1', {
      resolveModel: () => stubModel(),
      embed: async () => vec512,
    });
    expect(result.dimChanged).toBe(true);
    expect(result.newDim).toBe(512);
    // 🔘 p2 行（未参与 p1 的 rebuild）hash 已清——修复前会 hash-skip 永久阻断（向量已随表 DROP 丢失）。
    expect(
      (db.prepare('SELECT content_hash FROM closure_entry WHERE entry_id=?').get('asset-p2a') as { content_hash: string | null }).content_hash,
    ).toBeNull();

    // p2 无 force 重索引（同 512-dim）→ 重嵌补回。
    let p2Embeds = 0;
    await reindexAsset('p2', 'asset-p2a', {
      resolveModel: () => stubModel(),
      embed: async () => {
        p2Embeds++;
        return vec512;
      },
    });
    expect(p2Embeds).toBe(1);
    expect(
      (db.prepare('SELECT content_hash FROM closure_entry WHERE entry_id=?').get('asset-p2a') as { content_hash: string | null }).content_hash,
    ).toHaveLength(64);
  });
});
