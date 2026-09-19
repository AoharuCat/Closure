import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PromiseRegistry } from '@orison/shared-contracts';

// Throwaway home (mirror worldStateRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-foreshadow-indexer');

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
import { reindexForeshadowRegistry, findOpenForeshadows } from '../main/db/foreshadowIndexer';

// better-sqlite3 ABI gate (mirror worldStateRepository.test.ts).
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

const registry: PromiseRegistry = {
  promises: [
    {
      id: 'p1',
      title: '徽章之谜',
      summary: '神秘徽章的来历',
      status: 'open',
      importance: 0.9,
      category: 'mystery',
      related_asset_ids: ['asset-A'],
      source_type: 'emergent',
      related_promise_ids: [],
      tags: [],
      sourceRefs: [],
      autoFulfill: true,
    },
    {
      id: 'p2',
      title: '宿敌对决',
      summary: 'A 与 B 的对决',
      status: 'open',
      importance: 0.5,
      related_asset_ids: [],
      source_type: 'emergent',
      related_promise_ids: [],
      tags: [],
      sourceRefs: [],
      autoFulfill: true,
    },
    {
      id: 'p3',
      title: '已兑现',
      summary: '已回收的伏笔',
      status: 'fulfilled',
      importance: 0.5,
      related_asset_ids: [],
      source_type: 'emergent',
      related_promise_ids: [],
      tags: [],
      sourceRefs: [],
      autoFulfill: true,
    },
  ],
  beats: [
    { id: 'b1', promiseId: 'p1', sceneRef: 'scene-1', kind: 'plant' },
    { id: 'b2', promiseId: 'p1', sceneRef: 'scene-20', kind: 'payoff' },
    { id: 'b3', promiseId: 'p2', sceneRef: 'scene-5', kind: 'plant' },
  ],
  version: 0,
  updatedBy: 'user',
};

describe.runIf(sqliteUsable)('foreshadow indexer (Story 6.4 D3)', () => {
  beforeAll(() => {
    reindexForeshadowRegistry(registry, 'p1');
  });

  afterAll(() => {
    closeDb();
    try {
      rmBestEffort(TEST_HOME);
    } catch {
      // ignore
    }
  });

  it('物化：3 promises → 3 closure_foreshadow rows', () => {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS c FROM closure_foreshadow WHERE project_id=?')
      .get('p1') as { c: number };
    expect(row.c).toBe(3);
  });

  it('plant/resolve_ref 从 beats 派生（p1: plant=scene-1, payoff=scene-20）', () => {
    const row = getDb()
      .prepare('SELECT plant_ref, resolve_ref FROM closure_foreshadow WHERE foreshadow_id=?')
      .get('p1') as { plant_ref: string | null; resolve_ref: string | null };
    expect(row).toEqual({ plant_ref: 'scene-1', resolve_ref: 'scene-20' });
  });

  it('p2 只有 plant beat（resolve_ref null）', () => {
    const row = getDb()
      .prepare('SELECT plant_ref, resolve_ref FROM closure_foreshadow WHERE foreshadow_id=?')
      .get('p2') as { plant_ref: string | null; resolve_ref: string | null };
    expect(row).toEqual({ plant_ref: 'scene-5', resolve_ref: null });
  });

  it('findOpenForeshadows → 2 open（p1+p2），importance 降序（p1 先）', () => {
    const hits = findOpenForeshadows('p1');
    expect(hits).toHaveLength(2);
    expect(hits[0].foreshadowId).toBe('p1'); // importance 0.9 > 0.5
    expect(hits[1].foreshadowId).toBe('p2');
  });

  it('findOpenForeshadows entryId（p1 关联 asset-A）', () => {
    const p1 = findOpenForeshadows('p1').find((h) => h.foreshadowId === 'p1');
    expect(p1!.entryId).toBe('asset-A');
    expect(p1!.plantRef).toBe('scene-1');
  });

  it('reindex 空 registry → 清空索引（派生索引一致性）', () => {
    reindexForeshadowRegistry(undefined, 'p1');
    expect(findOpenForeshadows('p1')).toEqual([]);
  });
});
