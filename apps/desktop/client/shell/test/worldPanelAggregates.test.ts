import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateCheckpoint.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-world-panel-aggr');

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
  insertWorldSlice,
  listWorldAnchorStats,
  listWorldSlices,
  listWorldSubjectActivityStats,
  resetWorldState,
  type WorldAnchorStats,
  type WorldSubjectActivityStats,
} from '../main/db/worldStateRepository';

// better-sqlite3 ABI gate (mirror worldStateCheckpoint.test.ts): skip the SQL
// suite instead of failing when the native addon cannot load under plain-Node
// vitest.
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

// 本 suite 专用 project id（fresh db after clean；复合 PK 跨 suite 隔离）。
const PID = '00003';

/**
 * dogfood R2 #92 · BMad CR #1+#200/#13：世界状态面板读面 db 聚合查询（真 db round-trip——
 * worldIpc.test 全 mock，SQL 行为在此对拍）。fixture 刻意含：
 * - 同 storyTime 跨 episode 双切片（锚点归并键）；
 * - **零 patch slice（t=30）**——CR #13：锚点聚合无行、latestT 不抬；
 * - 多轴多主体（五键 axisCounts / 每主体 stats）。
 */
describe.skipIf(!sqliteUsable)('worldStateRepository 世界面板聚合查询（BMad CR #1+#200/#13）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
    // t=10（跨 episode 同 storyTime）：erina×2 + erina/mentor×1。
    insertWorldSlice(
      PID,
      { id: 'ep-001:10', storyTime: 10, title: '转生', episodeId: 'ep-001' },
      [
        { subjectId: 'character:erina', path: '/hp', op: 'replace', value: 100, axis: 'physical' },
        { subjectId: 'character:erina', path: '/mood', op: 'replace', value: '平静', axis: 'emotional' },
      ],
      [{ id: 'character:erina', type: 'character', name: '艾莉娜', firstSeenStoryTime: 10 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-002:10', storyTime: 10, title: '', episodeId: 'ep-002' },
      [
        { subjectId: 'character:erina', path: '/location', op: 'replace', value: 'subject://item:sword-01 附近', axis: 'physical' },
        { subjectId: 'character:mentor', path: '/knows/艾莉娜的来历', op: 'replace', value: '她的剑术是战地传承', axis: 'cognitive' },
      ],
      [{ id: 'character:mentor', type: 'character', name: '导师', firstSeenStoryTime: 10 }],
      'derived',
    );
    // t=20：三主体三轴。
    insertWorldSlice(
      PID,
      { id: 'ep-003:20', storyTime: 20, title: '苦战', episodeId: 'ep-003' },
      [
        { subjectId: 'character:erina', path: '/hp', op: 'increment', value: -30, axis: 'physical' },
        { subjectId: 'character:mentor', path: '/suspects/袭击者身份', op: 'replace', value: '纹章指向第三军团', axis: 'cognitive' },
        { subjectId: 'faction:guild', path: '/status', op: 'replace', value: '进入二级戒备', axis: 'factional' },
      ],
      [{ id: 'faction:guild', type: 'faction', name: '公会', firstSeenStoryTime: 20 }],
      'derived',
    );
    // t=30：零 patch slice（登记残留 / 空产物）——CR #13 核心场景。
    insertWorldSlice(
      PID,
      { id: 'ep-004:30', storyTime: 30, title: '空切片', episodeId: 'ep-004' },
      [],
      [],
      'derived',
    );
    // t=40：erina 单条。
    insertWorldSlice(
      PID,
      { id: 'ep-005:40', storyTime: 40, title: '尾声', episodeId: 'ep-005' },
      [{ subjectId: 'character:erina', path: '/mood', op: 'replace', value: { objective: '释然', reader_perceived: '平静' }, axis: 'emotional' }],
      [],
      'derived',
    );
  });
  afterAll(clean);

  it('listWorldSubjectActivityStats：每主体一行（patchCount / first / last / distinct axes）', () => {
    const stats = listWorldSubjectActivityStats(PID);
    const byId = new Map(stats.map((s) => [s.subjectId, s]));
    expect(stats).toHaveLength(3);

    const erina = byId.get('character:erina')!;
    expect(erina.patchCount).toBe(5); // t10 ep-001×2 + t10 ep-002×1 + t20 + t40
    expect(erina.firstStoryTime).toBe(10);
    expect(erina.lastStoryTime).toBe(40);
    expect([...erina.axes].sort()).toEqual(['emotional', 'physical']);

    const mentor = byId.get('character:mentor')!;
    expect(mentor).toMatchObject({ patchCount: 2, firstStoryTime: 10, lastStoryTime: 20 });
    expect([...mentor.axes].sort()).toEqual(['cognitive']);

    const guild = byId.get('faction:guild')!;
    expect(guild).toMatchObject({ patchCount: 1, firstStoryTime: 20, lastStoryTime: 20 });
    expect([...guild.axes].sort()).toEqual(['factional']);

    // 空项目形态：另一 project id 无行（聚合按 project_id 隔离）。
    expect(listWorldSubjectActivityStats('99999')).toEqual([]);
  });

  it('listWorldAnchorStats：storyTime 升序、五键 axisCounts、**零 patch slice（t=30）无行**（CR #13）', () => {
    const stats: WorldAnchorStats[] = listWorldAnchorStats(PID);

    expect(stats.map((a) => a.t)).toEqual([10, 20, 40]); // t=30 缺席——零 patch slice 不产出锚点
    const t10 = stats[0];
    expect(t10.subjectCount).toBe(2); // erina + mentor（跨 episode 归并）
    expect(t10.patchCount).toBe(4);
    expect(t10.axisCounts).toEqual({
      physical: 2, cognitive: 1, emotional: 1, relational: 0, factional: 0,
    });
    const t20 = stats[1];
    expect(t20).toMatchObject({ subjectCount: 3, patchCount: 3 });
    expect(t20.axisCounts).toEqual({
      physical: 1, cognitive: 1, emotional: 0, relational: 0, factional: 1,
    });
    const t40 = stats[2];
    expect(t40).toMatchObject({ subjectCount: 1, patchCount: 1 });
    expect(t40.axisCounts.emotional).toBe(1);

    expect(listWorldAnchorStats('99999')).toEqual([]);
  });

  it('listWorldSlices storyTime 精确 opt：只取该时点 slices + patches（CR #1+#200）；与 at 的 <= 累计语义对照', () => {
    // 精确 t=10：跨 episode 双切片归返，各带自己的 patches。
    const at10 = listWorldSlices(PID, { withPatches: true, storyTime: 10 });
    expect(at10.map((s) => s.id)).toEqual(['ep-001:10', 'ep-002:10']);
    expect(at10[0].patches?.map((p) => p.path)).toEqual(['/hp', '/mood']);
    expect(at10[1].patches?.map((p) => p.subjectId)).toEqual(['character:erina', 'character:mentor']);
    // patches 反范式 storyTime 填充（JOIN slice）。
    expect(at10[0].patches?.every((p) => p.storyTime === 10)).toBe(true);

    // 精确 t=30（零 patch slice）：slice 行在、patches 空。
    const at30 = listWorldSlices(PID, { withPatches: true, storyTime: 30 });
    expect(at30.map((s) => s.id)).toEqual(['ep-004:30']);
    expect(at30[0].patches).toEqual([]);

    // 精确缺失时点：[]。
    expect(listWorldSlices(PID, { withPatches: true, storyTime: 99 })).toEqual([]);

    // 对照：at=20 是 <= 累计语义（t=10,20 都返）——storyTime opt 不改既有 at 行为。
    const cumulative = listWorldSlices(PID, { at: 20 });
    expect(cumulative.map((s) => s.storyTime).sort()).toEqual([10, 10, 20]);
  });

  it('聚合行数与 patch 行数解耦（CR #1+#200 轻查询性质——subject/anchor 行数 ≠ patch 行数）', () => {
    const db = getDb();
    const patchRows = (db
      .prepare('SELECT COUNT(*) AS n FROM closure_world_patch WHERE project_id = ?')
      .get(PID) as { n: number }).n;
    expect(patchRows).toBe(8);
    const stats: WorldSubjectActivityStats[] = listWorldSubjectActivityStats(PID);
    expect(stats.length).toBe(3);
    expect(listWorldAnchorStats(PID).length).toBe(3); // 8 patches → 3 subject 行 / 3 anchor 行
    // reset 后聚合清零（DERIVED 全清——subject 身份保留由 subject 表承载，不在聚合面）。
    resetWorldState(PID);
    expect(listWorldSubjectActivityStats(PID)).toEqual([]);
    expect(listWorldAnchorStats(PID)).toEqual([]);
  });
});
