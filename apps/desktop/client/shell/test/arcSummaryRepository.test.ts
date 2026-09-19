import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror feedbackLedgerRepository.test.ts / worldStateRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-arc-summary-repo');

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
  listLatestArcSummaries,
  readArcSummary,
  upsertArcSummary,
  type ArcSummaryUpsertInput,
} from '../main/db/arcSummaryRepository';
import { resetWorldState } from '../main/db/worldStateRepository';
import type { ArcAuditResult } from '@orison/shared-contracts';

// better-sqlite3 ABI gate (mirror feedbackLedgerRepository.test.ts): skip the SQL suite
// instead of failing when the native addon cannot load under plain-Node vitest.
// Electron-as-Node 真跑（Story 8.1 testing-discipline Pattern）：
//   ELECTRON_RUN_AS_NODE=1 <electron.exe> node_modules/vitest/vitest.mjs run test/arcSummaryRepository.test.ts
// （cwd = shell 包）——native addon 真加载，本 skip 门自然放行。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  closeDb();
  rmBestEffort(TEST_HOME);
}

const PID = '00001';

function mkResult(arcRef: string, over: Partial<ArcAuditResult> = {}): ArcAuditResult {
  return {
    arcRef,
    arcKind: 'volume',
    span: { fromEpisodeIndex: 0, toEpisodeIndex: 12 },
    arcSummary: {
      synopsis: `${arcRef} 卷梗概`,
      lineSections: [],
      characterArcs: [],
      openThreads: [],
    },
    findings: [],
    degraded: false,
    ...over,
  };
}

function mkRow(over: Partial<ArcSummaryUpsertInput> & { arcRef: string }): ArcSummaryUpsertInput {
  return {
    arcKind: 'volume',
    auditKind: 'closure',
    fromEpisodeIndex: 0,
    toEpisodeIndex: 12,
    result: mkResult(over.arcRef),
    tokenEstimate: 1200,
    ...over,
  };
}

describe.skipIf(!sqliteUsable)('arcSummaryRepository (Story 8.2 design §4)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('creates the closure_arc_summary table on initSchema（composite PK 四列）', () => {
    const db = getDb();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(tables.has('closure_arc_summary')).toBe(true);

    const cols = (
      db.pragma('table_info(closure_arc_summary)') as { name: string; pk: number }[]
    ).sort((a, b) => a.pk - b.pk);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
      'project_id',
      'arc_ref',
      'audit_kind',
      'to_episode_index',
    ]);
  });

  it('upsert → read roundtrip（字段 + JSON result 还原 + ISO produced_at）', () => {
    upsertArcSummary(PID, mkRow({ arcRef: 'phase-1' }));

    const rec = readArcSummary(PID, 'phase-1', 'closure');
    expect(rec).toBeDefined();
    expect(rec!.arcRef).toBe('phase-1');
    expect(rec!.arcKind).toBe('volume');
    expect(rec!.auditKind).toBe('closure');
    expect(rec!.fromEpisodeIndex).toBe(0);
    expect(rec!.toEpisodeIndex).toBe(12);
    expect(rec!.result).toMatchObject({
      arcRef: 'phase-1',
      arcKind: 'volume',
      arcSummary: { synopsis: 'phase-1 卷梗概' },
    });
    expect(rec!.tokenEstimate).toBe(1200);
    expect(rec!.producedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('read 未命中返 undefined', () => {
    expect(readArcSummary(PID, 'arc-ghost', 'closure')).toBeUndefined();
  });

  it('同 PK upsert 幂等覆盖（last-wins——同弧同 kind 同 to_episode_index 重跑大审）', () => {
    upsertArcSummary(PID, mkRow({ arcRef: 'phase-2', toEpisodeIndex: 20 }));
    upsertArcSummary(
      PID,
      mkRow({ arcRef: 'phase-2', toEpisodeIndex: 20, result: mkResult('phase-2', { degraded: true }) }),
    );
    const rec = readArcSummary(PID, 'phase-2', 'closure');
    expect(rec!.result?.degraded).toBe(true);
    // 幂等：单行不累积。
    const db = getDb();
    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM closure_arc_summary WHERE arc_ref = ?')
        .get('phase-2') as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('弧重写后重跑大审 → 新 to_episode_index 行历史留档 + read 缺省取最新 + 精确取历史行（design §4）', () => {
    upsertArcSummary(PID, mkRow({ arcRef: 'phase-3', toEpisodeIndex: 20 }));
    upsertArcSummary(PID, mkRow({ arcRef: 'phase-3', toEpisodeIndex: 35 }));

    // 最新行 = MAX(to_episode_index)。
    expect(readArcSummary(PID, 'phase-3', 'closure')?.toEpisodeIndex).toBe(35);
    // 精确历史行仍可取（留档语义）。
    expect(readArcSummary(PID, 'phase-3', 'closure', 20)?.toEpisodeIndex).toBe(20);
  });

  it('closure / stagnation 两 audit_kind 并列独立（PK 含 audit_kind）', () => {
    upsertArcSummary(PID, mkRow({ arcRef: 'line-a', arcKind: 'line', auditKind: 'closure', toEpisodeIndex: 12 }));
    upsertArcSummary(PID, mkRow({ arcRef: 'line-a', arcKind: 'line', auditKind: 'stagnation', toEpisodeIndex: 14 }));

    expect(readArcSummary(PID, 'line-a', 'closure')?.toEpisodeIndex).toBe(12);
    expect(readArcSummary(PID, 'line-a', 'stagnation')?.toEpisodeIndex).toBe(14);
  });

  it('listLatest：每 (arc_ref, audit_kind) 最新行 + arcRef 收窄 + project 隔离', () => {
    upsertArcSummary(PID, mkRow({ arcRef: 'z-line', arcKind: 'line', auditKind: 'stagnation', toEpisodeIndex: 30 }));
    upsertArcSummary(PID, mkRow({ arcRef: 'z-line', arcKind: 'line', auditKind: 'stagnation', toEpisodeIndex: 44 }));
    upsertArcSummary(PID, mkRow({ arcRef: 'a-phase', toEpisodeIndex: 9 }));

    const all = listLatestArcSummaries(PID);
    // phase-1/phase-2/phase-3（上方 cases）+ z-line stagnation 最新 44 + a-phase 9——每 (arc,kind) 一行。
    const zLine = all.filter((r) => r.arcRef === 'z-line');
    expect(zLine).toHaveLength(1);
    expect(zLine[0].toEpisodeIndex).toBe(44);

    // arcRef 收窄。
    expect(listLatestArcSummaries(PID, 'a-phase').map((r) => r.arcRef)).toEqual(['a-phase']);

    // project 隔离（另一 project 的同 arc_ref 行不可见）。
    upsertArcSummary('00002', mkRow({ arcRef: 'a-phase', toEpisodeIndex: 99 }));
    expect(listLatestArcSummaries(PID, 'a-phase')[0].toEpisodeIndex).toBe(9);
    expect(readArcSummary('00002', 'a-phase', 'closure')?.toEpisodeIndex).toBe(99);
  });

  it('坏 JSON 行 corruptPayload 标记（不崩、不丢行、不造假空对象——CR-E6/CR-011 模式）', () => {
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO closure_arc_summary (project_id, arc_ref, arc_kind, audit_kind, from_episode_index, to_episode_index, result, token_estimate, produced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(PID, 'arc-corrupt', 'volume', 'closure', 0, 5, '{malformed json', 0, '2026-01-01T00:00:00.000Z');

    const rec = readArcSummary(PID, 'arc-corrupt', 'closure');
    expect(rec).toBeDefined();
    expect(rec!.corruptPayload).toBe(true);
    expect(rec!.result).toBeUndefined(); // 坏 JSON 不造假空对象
    expect(rec!.arcRef).toBe('arc-corrupt'); // 其余字段仍有效
    expect(listLatestArcSummaries(PID, 'arc-corrupt')[0].corruptPayload).toBe(true);
  });

  it('resetWorldState 级联清理 arc_summary（mirror 8.1 summary 级联点位；beats 在 project.yaml 不自动清）', () => {
    upsertArcSummary(PID, mkRow({ arcRef: 'to-be-reset', toEpisodeIndex: 50 }));
    expect(readArcSummary(PID, 'to-be-reset', 'closure')).toBeDefined();

    resetWorldState(PID);

    expect(readArcSummary(PID, 'to-be-reset', 'closure')).toBeUndefined();
    expect(listLatestArcSummaries(PID)).toEqual([]);
    // 另一 project 不受牵连。
    expect(readArcSummary('00002', 'a-phase', 'closure')?.toEpisodeIndex).toBe(99);
  });
});
