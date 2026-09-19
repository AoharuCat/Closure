import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.1 Step 6：rebuildChapterSummaries（backfill summary 重建 pass）真 db
// round-trip 测试。db-repository.md #1 教训：纯函数测试内存构造数据绕过 db → 测试绿生产失效——
// 本 suite 走真 better-sqlite3（真表 + 真材料化链），只 mock 两处边界：
// - `@orison/desktop-local-bff` loadProject：project.yaml 三源给合成 doc（免写盘整档 project.yaml，
//   mirror worldStateHandlers.test.ts 同 mock）。
// - worldStateHandlers.materializeChapterSummaryCore 包 spy（importOriginal 保留真实现——仅 per-episode
//   失败容错测注入单章抛错；其余测试真跑完整材料化链）。
//
// Electron-as-Node 真跑（better-sqlite3 按 Electron ABI 重建，plain-Node vitest 下本 suite 会被
// ABI gate skip）：
//   cd apps/desktop/client/shell
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/worldStateBackfillSummary.test.ts
// ─────────────────────────────────────────────────────────────────────────────

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateCheckpoint.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-world-state-backfill-sum');

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

// dogfood #104-b：importOriginal 保留真 materialize 实现 → 真 hook 兜底 resolveEmbeddingModel
// → defaultEmbedBatch 真打 embed 端点。mock 模型解析层（逐字 mirror
// chapterSummaryHookWiring.test.ts:22-29）：null 短路 embed 块，FTS-only 降级语义不变。
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

// hoisted mock 状态（vi.mock factory 提升后仍可经闭包引用）。
const { loadProject, materializeCore, mockState } = vi.hoisted(() => {
  const loadProject = vi.fn();
  const materializeCore = vi.fn();
  const mockState: {
    /** per-episode 失败容错测注入：命中该 episodeId 的 materialize 抛错（null = 全放行真实现）。 */
    failEpisodeId: string | null;
    /** 真实现（factory 里 importOriginal 后注入；beforeEach 重装 mockImplementation 用）。 */
    actual:
      | ((
          projectId: string,
          projectDir: string,
          episodeId: string,
        ) => Promise<{ summary: unknown; tokenEstimate: number; checkpointCount: number }>)
      | null;
  } = { failEpisodeId: null, actual: null };
  return { loadProject, materializeCore, mockState };
});

vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

// 真 db + 真 repo，只把 materialize 核心包 spy（default 放行真实现；失败容错测按 episodeId 注入抛错）。
// CR-8（8.1 修复批）：materializeChapterSummaryCore 已下潜 db/worldStateMaterialize（原住
// worldStateHandlers——db 层 worldStateBackfill 反向 import ipc 层的分层倒置修复），mock 目标随迁。
vi.mock('../main/db/worldStateMaterialize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/db/worldStateMaterialize')>();
  mockState.actual = actual.materializeChapterSummaryCore;
  return { ...actual, materializeChapterSummaryCore: materializeCore };
});

import { closeDb, getDb } from '../main/db/index';
import {
  insertWorldSlice,
  listChapterSummaries,
  resetWorldState,
} from '../main/db/worldStateRepository';
import { rebuildChapterSummaries } from '../main/db/worldStateBackfill';
import { materializeChapterSummaryCore } from '../main/db/worldStateMaterialize';

// better-sqlite3 ABI gate（mirror worldStateCheckpoint.test.ts）：plain-Node vitest 下原生 addon ABI
// 不匹配时 skip 而非 fail。
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

// 本 suite 专属 project id（fresh db after clean；composite PK 跨 suite 隔离）。
const PID = '00003';
// loadProject 已 mock——projectDir 只作透传标记（真链不读盘）。
const PROJECT_DIR = '/proj/backfill-refresh';

/** loadProject 合成 doc（episode_outlines + promise_registry + 空 scene_graph——direct 抽取 + per-element safeParse 消费）。 */
function makeDoc(): Record<string, unknown> {
  return {
    episode_outlines: [
      { id: 'ep-101', index: 0, title: '一章' },
      { id: 'ep-102', index: 1, title: '二章' },
      { id: 'ep-103', index: 2, title: '三章' },
      { id: 'ep-104', index: 3, title: '四章' },
    ],
    promise_registry: {
      promises: [
        { id: 'pm-1', title: '旧誓', summary: '旧誓待兑', status: 'open', deadlineEpisodeId: 'ep-104' },
      ],
      beats: [],
    },
    scene_graph: { nodes: [] },
  };
}

function seedEp101(): void {
  insertWorldSlice(
    PID,
    { id: 'ep-101:100', storyTime: 100, title: '一章', episodeId: 'ep-101' },
    [{ subjectId: 'hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
    [{ id: 'hero', type: 'character', name: '主角', firstSeenStoryTime: 100 }],
    'derived',
  );
}

function seedEp102(): void {
  insertWorldSlice(
    PID,
    { id: 'ep-102:200', storyTime: 200, title: '二章', episodeId: 'ep-102' },
    [
      { subjectId: 'hero', path: '/hp', op: 'increment', value: -20, axis: 'physical' },
      { subjectId: 'rival', path: '/hp', op: 'replace', value: 80, axis: 'physical' },
    ],
    [{ id: 'rival', type: 'character', name: '宿敌', firstSeenStoryTime: 200 }],
    'derived',
  );
}

/** 项目内指定表的行数（表名只用本 suite 字面量——无注入面）。 */
function countRows(table: 'closure_world_slice' | 'closure_world_patch' | 'closure_world_checkpoint' | 'closure_chapter_summary'): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(PID) as {
      n: number;
    }
  ).n;
}

/** 项目内指定表的 (rowid, id) 快照（「不动 patch/slice 行」断言——rowid 是插入序，删/重插即变）。 */
function snapshotRows(table: 'closure_world_patch' | 'closure_world_slice'): Array<{ rowid: number; id: string }> {
  return getDb()
    .prepare(`SELECT rowid, id FROM ${table} WHERE project_id = ? ORDER BY rowid`)
    .all(PID) as Array<{ rowid: number; id: string }>;
}

describe.skipIf(!sqliteUsable)('rebuildChapterSummaries (Story 8.1 Step 6)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  beforeEach(() => {
    mockState.failEpisodeId = null;
    loadProject.mockReset();
    loadProject.mockReturnValue(makeDoc());
    // 重装 spy：默认放行真实现（mockReset 清掉 factory 里的 implementation）。
    materializeCore.mockReset();
    materializeCore.mockImplementation(
      async (projectId: string, projectDir: string, episodeId: string) => {
        if (mockState.failEpisodeId === episodeId) {
          throw new Error('per-episode materialize boom');
        }
        return mockState.actual!(projectId, projectDir, episodeId);
      },
    );
  });

  it('重提取（reset 清 ckpt/summary）→ 落表 → rebuild 全量重建：summary 行数=2 + checkpoint 存在', async () => {
    // 先写 2 episode patches（重提取前的旧态）。
    seedEp101();
    seedEp102();
    // 重提取前 reset（resetWorldStateForBackfill 同源）——Step 2 语义：checkpoint + summary 同清。
    resetWorldState(PID);
    expect(countRows('closure_world_slice')).toBe(0);
    expect(countRows('closure_world_checkpoint')).toBe(0);
    expect(countRows('closure_chapter_summary')).toBe(0);

    // 重提取落表（稳定 slice.id 幂等——此处等价新写 2 episode 的 slices/patches）。
    seedEp101();
    seedEp102();

    const report = await rebuildChapterSummaries(PID, PROJECT_DIR);

    expect(report).toEqual({ ok: true, episodesFound: 2, materialized: 2, failed: [] });
    const rows = listChapterSummaries(PID);
    expect(rows.map((r) => r.episodeId)).toEqual(['ep-101', 'ep-102']);
    expect(rows.map((r) => r.episodeIndex)).toEqual([0, 1]);
    // 物化 fold 机会式 lazy 建 checkpoint（hero@100 + rival@200；hero@200 hit 增量 1 < 25 不推进）。
    expect(countRows('closure_world_checkpoint')).toBeGreaterThanOrEqual(2);
    // summary 内容 sanity：⑤ 未决承诺来自 yaml（pm-1 open）。
    const ep101 = rows.find((r) => r.episodeId === 'ep-101')!;
    expect(ep101.summary.openPromises.map((o) => o.promiseId)).toEqual(['pm-1']);
  });

  it('CR-13 幻影前缀排除：legacy/am-fix 前缀不在 outlines → 不进 rebuild 集、不造幻影 summary 行', async () => {
    // 8.1 之前写入形态：无 episodeId（列 NULL），id = `${episodeId}:${storyTime}`。'legacy-ep' 是真旧章
    // 但 outlines 已无此 episode；'am-fix:200' 是修补标签冒充的幻影前缀——两者都不得物化。
    insertWorldSlice(
      PID,
      { id: 'legacy-ep:300', storyTime: 300, title: '旧式切片' },
      [{ subjectId: 'hero', path: '/hp', op: 'increment', value: -5, axis: 'physical' }],
      [],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'am-fix:200', storyTime: 200, title: '修补标签' },
      [{ subjectId: 'hero', path: '/hp', op: 'replace', value: 99, axis: 'physical' }],
      [],
      'amendment',
    );

    const report = await rebuildChapterSummaries(PID, PROJECT_DIR);

    // 幻影前缀（含被 backfill 懒补写进 episode_id 列的——列归属同 gate，防洗白回归）被排除。
    expect(report.ok).toBe(true);
    expect(report.episodesFound).toBe(2); // 仅 ep-101, ep-102（outlines 内）
    const all = listChapterSummaries(PID);
    expect(all.map((r) => r.episodeId)).toEqual(['ep-101', 'ep-102']);
    expect(listChapterSummaries(PID, { episodeIds: ['legacy-ep'] })).toEqual([]);
    expect(listChapterSummaries(PID, { episodeIds: ['am-fix'] })).toEqual([]);
  });

  it('「仅补 summary」：不动 patch/slice 行（rowid 前后不变）+ 幂等（二次调用覆盖不累积）', async () => {
    const patchesBefore = snapshotRows('closure_world_patch');
    const slicesBefore = snapshotRows('closure_world_slice');
    expect(patchesBefore.length).toBeGreaterThanOrEqual(3);

    const first = await rebuildChapterSummaries(PID, PROJECT_DIR);

    expect(first).toEqual({ ok: true, episodesFound: 2, materialized: 2, failed: [] });
    // 不动 patches（无删除/重插——rowid 是插入序）+ 不动 slices（无 reset / 无重提取触发）。
    expect(snapshotRows('closure_world_patch')).toEqual(patchesBefore);
    expect(snapshotRows('closure_world_slice')).toEqual(slicesBefore);

    // 幂等：二次调用覆盖（composite PK upsert）不累积、不报错。
    const second = await rebuildChapterSummaries(PID, PROJECT_DIR);
    expect(second).toEqual({ ok: true, episodesFound: 2, materialized: 2, failed: [] });
    expect(listChapterSummaries(PID)).toHaveLength(2);
    expect(snapshotRows('closure_world_patch')).toEqual(patchesBefore);
  });

  it('per-episode 失败容错：单 episode 物化抛错 → 批次完成 + failed 列表含它（其余照常物化）', async () => {
    insertWorldSlice(
      PID,
      { id: 'ep-103:400', storyTime: 400, title: '三章', episodeId: 'ep-103' },
      [{ subjectId: 'rival', path: '/hp', op: 'increment', value: -10, axis: 'physical' }],
      [],
      'derived',
    );
    mockState.failEpisodeId = 'ep-103';

    const report = await rebuildChapterSummaries(PID, PROJECT_DIR);

    // 批次完成（不中断）：其余 2 章 materialized；失败章进 failed 列表。
    expect(report.ok).toBe(false);
    expect(report.episodesFound).toBe(3);
    expect(report.materialized).toBe(2);
    expect(report.failed).toEqual([
      { episodeId: 'ep-103', error: expect.stringContaining('boom') },
    ]);
    // 失败章无 summary 行（抛错在落盘前）；其余两章照常（覆盖不丢）。
    expect(listChapterSummaries(PID, { episodeIds: ['ep-103'] })).toEqual([]);
    expect(listChapterSummaries(PID).map((r) => r.episodeId)).toEqual(['ep-101', 'ep-102']);
  });

  // ── CR-5（8.1 修复批）：amend/重提取级联失效已物化 summary（checkpoint 失效的 summary 对应物）──

  it('CR-5 Tier 1：amend 已物化章的 slice → episode_index >= 精确删（后章视角也被前章改动污染）；rebuild 恢复', async () => {
    // 前置状态：ep-101/ep-102 已物化（上两测）。amend ep-101 的 slice（同 id 重写 amendment）。
    expect(listChapterSummaries(PID).map((r) => r.episodeId)).toEqual(['ep-101', 'ep-102']);
    insertWorldSlice(
      PID,
      { id: 'ep-101:100', storyTime: 100, title: '一章（修补）', episodeId: 'ep-101' },
      [{ subjectId: 'hero', path: '/hp', op: 'replace', value: 88, axis: 'physical', summary: '修' }],
      [],
      'amendment',
    );

    // affected = ep-101（index 0，已物化）→ DELETE episode_index >= 0：ep-101 + ep-102 全失效（不再回 stale）。
    expect(listChapterSummaries(PID)).toEqual([]);

    // rebuild 恢复（含上测失败的 ep-103——failEpisodeId 已在 beforeEach 清零）。
    const report = await rebuildChapterSummaries(PID, PROJECT_DIR);
    expect(report.ok).toBe(true);
    expect(report.materialized).toBe(3);
    const rows = listChapterSummaries(PID);
    expect(rows.map((r) => r.episodeId)).toEqual(['ep-101', 'ep-102', 'ep-103']);
    // amend 后终态进摘要：hero @ep-101 末 = 100-5+99 修补链……（physical replace 88 生效于 ep-102 窗前）
    const ep101 = rows.find((r) => r.episodeId === 'ep-101')!;
    expect(ep101.summary.characterEndStates.find((s) => s.subjectId === 'hero')).toBeDefined();
  });

  it('CR-5 Tier 2：affected episode 尚未物化（前向写作 interleave 常态）→ storyTime 镜像删——历史 summary 不误删', async () => {
    // 前置状态：ep-101/102/103 已物化。写入**未来章** ep-104 的 slices（其 summary 尚未建——
    // 逐章 write→materialize interleave 的常态时序）。
    insertWorldSlice(
      PID,
      { id: 'ep-104:600', storyTime: 600, title: '四章', episodeId: 'ep-104' },
      [{ subjectId: 'rival', path: '/hp', op: 'replace', value: 60, axis: 'physical' }],
      [],
      'derived',
    );

    // affected = ep-104（无 summary 行 → index 不可解）→ storyTime 镜像：story_time_end >= 600 的行才删
    // ——现有三章窗（100/200/400）全低于 600，零误删（保守全删会毁掉前向物化的全部历史）。
    expect(listChapterSummaries(PID).map((r) => r.episodeId)).toEqual(['ep-101', 'ep-102', 'ep-103']);
  });

  it('CR-5 不可解析：slice 无 episode 归属（id 不合契约）→ 保守删全项目行（DERIVED 可重建）+ rebuild 恢复', async () => {
    insertWorldSlice(
      PID,
      { id: 'weird-slice', storyTime: 700, title: '无冒号 id' },
      [{ subjectId: 'rival', path: '/hp', op: 'increment', value: -1, axis: 'physical' }],
      [],
      'derived',
    );

    expect(listChapterSummaries(PID)).toEqual([]);

    // 清掉这个永久 NULL 行（其 id 永不可解析，会卡后续 EXISTS 守卫测试）+ rebuild 恢复。
    getDb().prepare("DELETE FROM closure_world_slice WHERE id = 'weird-slice'").run();
    const report = await rebuildChapterSummaries(PID, PROJECT_DIR);
    expect(report.ok).toBe(true);
    expect(report.episodesFound).toBe(4);
    expect(listChapterSummaries(PID).map((r) => r.episodeId)).toEqual([
      'ep-101',
      'ep-102',
      'ep-103',
      'ep-104',
    ]);
  });

  it('CR-14 幂等有效断言：二次物化换输入（episodeIndex 改档）→ 行数 1 且值为新输入（真 upsert 替换）', async () => {
    // 第一次：常规 doc（ep-101 index 0）。
    loadProject.mockReturnValue(makeDoc());
    await materializeChapterSummaryCore(PID, PROJECT_DIR, 'ep-101');

    // 第二次：ep-101 的 outline index 改为 5（换输入——非同值重放）。
    const shifted = makeDoc();
    (shifted.episode_outlines as Array<{ id: string; index: number }>)[0]!.index = 5;
    loadProject.mockReturnValue(shifted);
    await materializeChapterSummaryCore(PID, PROJECT_DIR, 'ep-101');

    const rows = listChapterSummaries(PID, { episodeIds: ['ep-101'] });
    expect(rows).toHaveLength(1); // composite PK upsert：覆盖不累积
    expect(rows[0].episodeIndex).toBe(5); // 值 = 新输入（last-wins 真替换，非旧值残留）
  });

  it('CR-12 二次物化零 UPDATE（backfillWorldSliceEpisodeIds EXISTS 守卫——无 NULL 行跳过）', async () => {
    // 前置：所有可解析行已被此前的物化懒补齐（legacy-ep/am-fix 均已回填列；weird-slice 已删）。
    const db = getDb();
    const stillNull = db
      .prepare('SELECT COUNT(*) AS n FROM closure_world_slice WHERE project_id = ? AND episode_id IS NULL')
      .get(PID) as { n: number };
    expect(stillNull.n).toBe(0);

    // spy db.prepare：统计 UPDATE closure_world_slice 语句（守卫短路则一条都不 prepare）。
    const origPrepare = db.prepare.bind(db);
    let updateStmts = 0;
    db.prepare = ((sql: string) => {
      if (/UPDATE\s+closure_world_slice/i.test(sql)) updateStmts += 1;
      return origPrepare(sql);
    }) as typeof db.prepare;
    try {
      await rebuildChapterSummaries(PID, PROJECT_DIR);
    } finally {
      delete (db as { prepare?: unknown }).prepare; // 还原原型方法（own property 移除）
    }

    expect(updateStmts).toBe(0); // 二次物化：无 NULL 行 → 懒补 UPDATE 整体跳过
  });
});
