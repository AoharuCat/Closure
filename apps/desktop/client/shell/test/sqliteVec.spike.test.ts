import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched. The db module derives its path from os.homedir() (node:os mock below).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-sqlite-vec-spike');

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    // The loader's packaged resolver is only engaged when process.resourcesPath
    // points at a real unpacked binary; under vitest it is absent so the fork's
    // getLoadablePath() (node_modules) is used, identical to dev mode.
    isPackaged: false,
  },
}));

import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 is a native addon rebuilt against Electron's ABI for the app;
// under plain-Node vitest its ABI may not match (NODE_MODULE_VERSION mismatch),
// so the whole SQL integration suite skips instead of failing the run.
// This is exactly the gating concern AC1 validates inside Electron instead —
// see scripts/spike-sqlite-vec.cjs for the authoritative proof.
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

describe.skipIf(!sqliteUsable)('sqlite-vec extension load + vec0 round-trip', () => {
  beforeAll(clean);
  afterAll(clean);

  it('loads the extension when getDb() opens the connection', () => {
    // Ensure the data dir exists so the db file can be created.
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });

    const db = getDb();
    expect(isSqliteVecAvailable()).toBe(true);

    // vec_version() is a sqlite-vec scalar; only resolvable if the extension
    // is actually registered on this connection.
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
    expect(typeof row.v).toBe('string');
    expect(row.v.length).toBeGreaterThan(0);
  });

  it('creates a vec0 table, inserts vectors, and returns cosine-ranked KNN', () => {
    const db = getDb();

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_spike_test USING vec0(
        project_id TEXT partition key,
        embedding float[1024] distance_metric=cosine
      );
    `);

    const f32 = (vals: number[]) => {
      const buf = Buffer.alloc(vals.length * 4);
      vals.forEach((v, i) => buf.writeFloatLE(v, i * 4));
      return buf;
    };
    const unit = (first: number, second: number) => {
      const v = new Array(1024).fill(0);
      v[0] = first;
      v[1] = second;
      return f32(v);
    };

    const ins = db.prepare(
      'INSERT INTO vec_spike_test(project_id, embedding) VALUES (?, ?)',
    );
    ins.run('p', unit(1.0, 0.0));
    ins.run('p', unit(0.0, 1.0));
    ins.run('p', unit(0.7, 0.7));

    const rows = db
      .prepare(
        `SELECT rowid, distance
         FROM vec_spike_test
         WHERE project_id = 'p' AND embedding MATCH ? AND k = 3
         ORDER BY distance`,
      )
      .all(unit(1.0, 0.0)) as Array<{ rowid: number; distance: number }>;

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.rowid)).toEqual([1, 3, 2]);
    // Identical query vector -> nearest distance ~ 0.
    expect(rows[0].distance).toBeLessThan(1e-6);

    db.exec('DROP TABLE vec_spike_test');
  });
});
