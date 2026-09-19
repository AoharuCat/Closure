import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CraftDistillLedger } from '@orison/shared-contracts';

// 蒸馏台账 repository 直测（mirror closureCraftCardRepository.test.ts 形态——ABI 门控 +
// throwaway home）。核心面：启动对账 closeStaleRunningDistills（非终态行翻中断 / 终态行不动 /
// 空表 no-op）+ 既有 upsert/get/list 往返不回归。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-craft-distill-repo');

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

vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

import {
  CRAFT_DISTILL_INTERRUPTED_NOTE,
  closeStaleRunningDistills,
  getCraftDistillLedger,
  listCraftDistillLedgers,
  upsertCraftDistillLedger,
} from '../main/db/closureCraftDistillRepository';
import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';

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
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

// ── fixtures ──

const ZERO_STATS: CraftDistillLedger['stats'] = {
  claims: 0,
  anchored: 0,
  droppedNoAnchor: 0,
  droppedMalformed: 0,
  droppedNoCategory: 0,
  mergedAuto: 0,
  mergeReviews: 0,
  newCards: 0,
  disputes: 0,
};

/** 全量台账行（字段合法——materialId 须 mat-<12hex>，hash 须 sha256:<64hex>）。 */
function mkLedger(over: Partial<CraftDistillLedger> & { materialId: string }): CraftDistillLedger {
  return {
    contentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    status: 'running',
    stats: { ...ZERO_STATS },
    phase: null,
    error: null,
    distilledAt: null,
    ...over,
  };
}

describe.skipIf(!sqliteUsable)('closure_craft_distill 台账（启动对账 closeStaleRunningDistills）', () => {
  beforeAll(clean);
  afterAll(clean);

  it('空表 no-op：返回 0，不抛错', () => {
    expect(listCraftDistillLedgers()).toEqual([]);
    expect(closeStaleRunningDistills()).toBe(0);
  });

  it('running 行 → 翻 failed + 清相位 + 落中断 note；stats/双 hash/distilledAt 原样保留', () => {
    const id = 'mat-000000000001';
    upsertCraftDistillLedger(
      mkLedger({
        materialId: id,
        contentHash: `sha256:${'1'.repeat(64)}`,
        derivedHash: `sha256:${'2'.repeat(64)}`,
        status: 'running',
        phase: 'extracting',
        stats: { ...ZERO_STATS, claims: 7, anchored: 6, newCards: 5 },
        distilledAt: '2026-09-01T00:00:00.000Z', // 前次成功蒸馏时刻——中断不抹
      }),
    );

    expect(closeStaleRunningDistills()).toBe(1);

    const row = getCraftDistillLedger(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('failed');
    expect(row!.phase).toBeNull();
    expect(row!.error).toBe(CRAFT_DISTILL_INTERRUPTED_NOTE);
    // 窄 UPDATE 纪律：只翻 status/phase/error 三列，其余列对账不碰。
    expect(row!.stats).toEqual({ ...ZERO_STATS, claims: 7, anchored: 6, newCards: 5 });
    expect(row!.contentHash).toBe(`sha256:${'1'.repeat(64)}`);
    expect(row!.derivedHash).toBe(`sha256:${'2'.repeat(64)}`);
    expect(row!.distilledAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('pending 行同翻（非终态词表 = schema 全词表减终态，不只 running）', () => {
    const id = 'mat-000000000002';
    upsertCraftDistillLedger(mkLedger({ materialId: id, status: 'pending', phase: null }));

    expect(closeStaleRunningDistills()).toBe(1);

    const row = getCraftDistillLedger(id);
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe(CRAFT_DISTILL_INTERRUPTED_NOTE);
  });

  it('终态行（done/failed/material-deleted）原样不动：失败原因不被覆写、完成时刻不丢', () => {
    const doneId = 'mat-000000000003';
    const failedId = 'mat-000000000004';
    const deletedId = 'mat-000000000005';
    upsertCraftDistillLedger(
      mkLedger({
        materialId: doneId,
        status: 'done',
        phase: null,
        error: '去重不可用（未配置 embedding 模型）——全部按新建卡落库',
        stats: { ...ZERO_STATS, claims: 3, anchored: 3, newCards: 3 },
        distilledAt: '2026-09-10T00:00:00.000Z',
      }),
    );
    upsertCraftDistillLedger(
      mkLedger({
        materialId: failedId,
        status: 'failed',
        phase: null,
        error: '切条返回空回复——已挂起。',
      }),
    );
    upsertCraftDistillLedger(mkLedger({ materialId: deletedId, status: 'material-deleted' }));

    expect(closeStaleRunningDistills()).toBe(0);

    const done = getCraftDistillLedger(doneId)!;
    expect(done.status).toBe('done');
    expect(done.error).toBe('去重不可用（未配置 embedding 模型）——全部按新建卡落库');
    expect(done.distilledAt).toBe('2026-09-10T00:00:00.000Z');

    const failed = getCraftDistillLedger(failedId)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('切条返回空回复——已挂起。'); // 真失败原因不被中断 note 覆盖

    expect(getCraftDistillLedger(deletedId)!.status).toBe('material-deleted');
  });

  it('混合批：非终态行数 = 返回值，终态行夹在其中不受影响', () => {
    upsertCraftDistillLedger(mkLedger({ materialId: 'mat-000000000006', status: 'running', phase: 'landing' }));
    upsertCraftDistillLedger(mkLedger({ materialId: 'mat-000000000007', status: 'running', phase: 'dedup' }));
    upsertCraftDistillLedger(mkLedger({ materialId: 'mat-000000000008', status: 'done' }));

    expect(closeStaleRunningDistills()).toBe(2);
    expect(getCraftDistillLedger('mat-000000000006')!.status).toBe('failed');
    expect(getCraftDistillLedger('mat-000000000007')!.status).toBe('failed');
    expect(getCraftDistillLedger('mat-000000000008')!.status).toBe('done');
  });

  it('对账后行仍过 schema 读回（craft:distill-status 取数面不因中断行变坏行）', () => {
    const rows = listCraftDistillLedgers();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(['done', 'failed', 'material-deleted']).toContain(row.status);
      expect(row.phase).toBeNull();
    }
  });
});
