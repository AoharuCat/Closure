import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RelationshipGraph } from '@orison/shared-contracts';

// Throwaway home so the real ~/.orison db is never touched (mirror worldStateRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-relation-retrieval');

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  app: { getPath: () => TEST_HOME, isPackaged: false },
}));

import { closeDb, getDb } from '../main/db/index';
import { searchRelations } from '../main/db/relationRetrieval';
import { reindexRelationGraph } from '../main/db/relationIndexer';

// better-sqlite3 ABI gate (mirror worldStateRepository.test.ts): skip the SQL suite when the native
// addon cannot load under plain-Node vitest (Electron smoke covers it, codebase 惯例).
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function seedEntry(entryId: string, name: string, type = 'character'): void {
  getDb()
    .prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text, visibility)
       VALUES (?, 'p1', ?, 'setting_card', ?, '', 'known')`,
    )
    .run(entryId, type, name);
}

// A→B(rivalry), B→C(mentor), A→C(alliance, secret) —— C 两条路径（direct depth1 + via B depth2）。
const graph: RelationshipGraph = {
  nodes: [
    { id: 'n-a', assetCardId: 'asset-A', label: 'A', type: 'character', locked: false },
    { id: 'n-b', assetCardId: 'asset-B', label: 'B', type: 'character', locked: false },
    { id: 'n-c', assetCardId: 'asset-C', label: 'C', type: 'character', locked: false },
  ],
  edges: [
    { id: 'e1', from: 'n-a', to: 'n-b', relationType: 'rivalry', locked: false, sourceRefs: [] },
    { id: 'e2', from: 'n-b', to: 'n-c', relationType: 'mentor', locked: false, sourceRefs: [] },
    { id: 'e3', from: 'n-a', to: 'n-c', relationType: 'alliance', visibility: 'secret', locked: false, sourceRefs: [] },
  ],
  version: 0,
  updatedBy: 'user',
};

describe.runIf(sqliteUsable)('relation retrieval + indexer (Story 6.4 D2)', () => {
  beforeAll(() => {
    const db = getDb();
    seedEntry('asset-A', 'Alpha');
    seedEntry('asset-B', 'Bravo');
    seedEntry('asset-C', 'Charlie');
    reindexRelationGraph(graph, 'p1');
  });

  afterAll(() => {
    closeDb();
    try {
      rmBestEffort(TEST_HOME);
    } catch {
      // ignore
    }
  });

  it('物化：3 edges → 3 closure_relation rows（node→assetCardId 解析）', () => {
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM closure_relation WHERE project_id=?')
      .get('p1') as { c: number };
    expect(row.c).toBe(3);
  });

  it('物化：src/tgt 对齐 assetCardId（非 node id）', () => {
    const db = getDb();
    const e1 = db
      .prepare('SELECT src_entry_id, tgt_entry_id FROM closure_relation WHERE relation_id=?')
      .get('e1') as { src_entry_id: string; tgt_entry_id: string };
    expect(e1).toEqual({ src_entry_id: 'asset-A', tgt_entry_id: 'asset-B' });
  });

  it('searchRelations depth=1 → 直接邻居（B + C）', () => {
    const hits = searchRelations('p1', 'asset-A', { depth: 1, budget: 20 });
    expect(hits.map((h) => h.entryId).sort()).toEqual(['asset-B', 'asset-C']);
  });

  it('searchRelations relation_type filter → 只返该类型邻居', () => {
    const hits = searchRelations('p1', 'asset-A', { depth: 1, budget: 20, relationType: 'rivalry' });
    expect(hits).toHaveLength(1);
    expect(hits[0].entryId).toBe('asset-B');
    expect(hits[0].relationType).toBe('rivalry');
  });

  it('searchRelations visibility filter → secret（A-C secret alliance）', () => {
    const hits = searchRelations('p1', 'asset-A', { depth: 1, budget: 20, visibility: 'secret' });
    expect(hits).toHaveLength(1);
    expect(hits[0].entryId).toBe('asset-C');
  });

  it('searchRelations seed 不存在 → 空（graceful）', () => {
    expect(searchRelations('p1', 'asset-X', { depth: 2, budget: 20 })).toEqual([]);
  });

  it('searchRelations budget cap 生效', () => {
    const hits = searchRelations('p1', 'asset-A', { depth: 2, budget: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('dedupe：A→C(direct depth1) + A→B→C(depth2) → C 取最短 depth 1', () => {
    const hits = searchRelations('p1', 'asset-A', { depth: 2, budget: 20 });
    const c = hits.find((h) => h.entryId === 'asset-C');
    expect(c).toBeDefined();
    expect(c!.depth).toBe(1);
  });

  it('viaPath：含 seed + 到达的 entry', () => {
    const hits = searchRelations('p1', 'asset-A', { depth: 1, budget: 20 });
    const b = hits.find((h) => h.entryId === 'asset-B');
    expect(b!.viaPath).toContain('asset-A');
    expect(b!.viaPath).toContain('asset-B');
  });

  it('reindexRelationGraph 空 graph → 清空索引（派生索引一致性）', () => {
    reindexRelationGraph(undefined, 'p1');
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM closure_relation WHERE project_id=?')
      .get('p1') as { c: number };
    expect(row.c).toBe(0);
  });

  // ── Story 8.7 §1.4：两写者 scope 隔离（graph vs setting_link）──
  // closure_relation 有两个写者：本索引器（source='graph'）与 settingMdIndexer
  // （source='setting_link'）。替换/清空 scope 必须按 source 隔离——隔离错=互相清边
  // （implement.md 风险注记，测试钉死）。

  function seedSettingLinkRow(relationId: string): void {
    getDb()
      .prepare(
        `INSERT INTO closure_relation (relation_id, project_id, src_entry_id, tgt_entry_id, relation_type, source)
         VALUES (?, 'p1', '00001:magic-system', 'asset-A', 'setting_link', 'setting_link')`,
      )
      .run(relationId);
  }

  it('Story 8.7 scope 隔离：graph 全量替换不清 setting_link 行', () => {
    const db = getDb();
    seedSettingLinkRow('sl-iso-1');
    // Full graph replace (3 edges re-materialized).
    const written = reindexRelationGraph(graph, 'p1');
    expect(written).toBe(3);
    const graphCount = db
      .prepare("SELECT COUNT(*) AS c FROM closure_relation WHERE project_id=? AND source='graph'")
      .get('p1') as { c: number };
    expect(graphCount.c).toBe(3);
    // The setting_link row survived the graph replace.
    const linkRow = db
      .prepare("SELECT tgt_entry_id, source FROM closure_relation WHERE relation_id='sl-iso-1'")
      .get() as { tgt_entry_id: string; source: string };
    expect(linkRow).toEqual({ tgt_entry_id: 'asset-A', source: 'setting_link' });
  });

  it('Story 8.7 scope 隔离：空 graph 清空只删 graph 行，setting_link 行不动', () => {
    const db = getDb();
    seedSettingLinkRow('sl-iso-2');
    reindexRelationGraph(undefined, 'p1');
    const graphCount = db
      .prepare("SELECT COUNT(*) AS c FROM closure_relation WHERE project_id=? AND source='graph'")
      .get('p1') as { c: number };
    expect(graphCount.c).toBe(0);
    const linkCount = db
      .prepare("SELECT COUNT(*) AS c FROM closure_relation WHERE relation_id='sl-iso-2'")
      .get() as { c: number };
    expect(linkCount.c).toBe(1);
    // Cleanup so downstream counts stay scoped.
    db.prepare("DELETE FROM closure_relation WHERE relation_id='sl-iso-2'").run();
  });

  it('Story 8.7 新写行带 source 列：graph 物化行 source=\'graph\'', () => {
    reindexRelationGraph(graph, 'p1');
    const db = getDb();
    const row = db
      .prepare('SELECT source FROM closure_relation WHERE relation_id=?')
      .get('e1') as { source: string };
    expect(row.source).toBe('graph');
  });
});
