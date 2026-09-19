import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-world-subject-id-migration');

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
import { migrateWorldSubjectIds } from '../main/db/worldSubjectIdMigration';
import {
  insertWorldCheckpoints,
  listWorldSubjects,
  resolveWorldSubjectIdentity,
  upsertChapterSummary,
  type WorldCheckpointInsert,
} from '../main/db/worldStateRepository';
import type { ChapterStateSummary, WorldPatchInput, WorldSubject } from '@orison/shared-contracts';

// better-sqlite3 ABI gate (mirror worldStateRepository.test.ts): skip the SQL suite
// instead of failing when the native addon cannot load under plain-Node vitest
// (better-sqlite3 is rebuilt against Electron's ABI; run under Electron-matched
// node / CI to exercise this suite).
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

const PID = '00091';

/** 三分身 + 双形态 + 裸 id + 已规范 + 卡锚——mirror dogfood R2 #91 project 00004 实证形态。 */
function seedSplitLibrary(db: ReturnType<typeof getDb>): void {
  // ── subjects ──
  const insertSubject = db.prepare(
    `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // 沈砚三分身（patch 引用数：character:shen-yan 4 > shen-yan 1 > character:shenyan 1——canonical 取引用最多者）
  insertSubject.run('character:shen-yan', PID, 'character', '沈砚', null, 1);
  insertSubject.run('shen-yan', PID, 'character', null, null, 1); // name 空（COALESCE 并入面）
  insertSubject.run('character:shenyan', PID, 'character', null, null, 2); // firstSeen 更晚（min 并入面）
  // 老魏双形态
  insertSubject.run('lao-wei', PID, 'character', '老魏', null, 1);
  insertSubject.run('character:lao-wei', PID, 'character', '老魏', null, 2);
  // 裸 id 单身（纯改名组）
  insertSubject.run('xiao-guan', PID, 'character', '小关', null, 1);
  // 已规范（幂等 no-op 组）
  insertSubject.run('group:archaeology-team', PID, 'group', '考古队', null, 1);
  // 卡锚主体（id = 卡 id，不可动）
  insertSubject.run('card_miya_01', PID, 'character', '米娅', 'card_miya_01', 1);

  // ── slices + patches ──
  db.prepare(
    `INSERT INTO closure_world_slice (id, project_id, story_time, kind, title, summary, episode_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ep1-01:1', PID, 1, 'event', '舱内苏醒', null, 'ep1-01');
  const insertPatch = db.prepare(
    `INSERT INTO closure_world_patch (id, slice_id, project_id, subject_id, path, op, value, axis, source, summary, evidence_scene_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'derived', ?, NULL)`,
  );
  const addPatch = (id: string, subjectId: string, path: string, op: string, value: string | null, axis: string) =>
    insertPatch.run(id, 'ep1-01:1', PID, subjectId, path, op, value, axis, `${subjectId} ${path}`);
  addPatch('p1', 'character:shen-yan', '/suspects/crew', 'replace', '"所有人"', 'cognitive');
  addPatch('p2', 'character:shen-yan', '/knows/wreck', 'replace', '"远古舱体"', 'cognitive');
  addPatch('p3', 'character:shen-yan', '/believes/self', 'replace', '"幸存者"', 'cognitive');
  addPatch('p4', 'character:shen-yan', '/memory/wake', 'replace', '"低温苏醒"', 'cognitive');
  addPatch('p5', 'shen-yan', '/location', 'replace', '"subject://item:cryo-pod-01"', 'physical');
  addPatch('p6', 'character:shenyan', '/mood', 'replace', '"警惕"', 'emotional');
  addPatch('p7', 'lao-wei', '/hp', 'increment', '-10', 'physical');
  addPatch('p8', 'character:lao-wei', '/suspects/shen-yan', 'replace', '"subject://shen-yan"', 'cognitive');
  addPatch('p9', 'xiao-guan', '/presence_scene', 'replace', '"scene-1"', 'physical');
  addPatch('p10', 'group:archaeology-team', '/morale', 'replace', '"低落"', 'emotional');
  addPatch('p11', 'card_miya_01', '/mood', 'replace', '"好奇"', 'emotional');
  // cryo-pod-01 主体未登记（裸引用——value ref 改写面测它：shen-yan 的 /location 指向 item:cryo-pod-01
  // 形态变体；本测试不构造该主体行，仅测改写不动非改写目标）。

  // ── checkpoints（merge 组应删、rename 组应改名）──
  const insertCkpt = db.prepare(
    `INSERT INTO closure_world_checkpoint (project_id, subject_id, at_story_time, state, issue_count, patch_rowid_high, patch_count_folded)
     VALUES (?, ?, ?, ?, 0, 1, 1)`,
  );
  for (const sid of [
    'character:shen-yan',
    'shen-yan',
    'character:shenyan',
    'lao-wei',
    'character:lao-wei',
    'xiao-guan',
    'group:archaeology-team',
    'card_miya_01',
  ]) {
    insertCkpt.run(PID, sid, 1, JSON.stringify({ folded: sid }));
  }

  // ── chapter summary（subjectId 改写 + 塌缩去重面）──
  const summary: ChapterStateSummary = {
    episodeId: 'ep1-01',
    episodeIndex: 1,
    storyTimeStart: 1,
    storyTimeEnd: 1,
    characterEndStates: [
      { subjectId: 'character:shen-yan', type: 'character', state: { knows: 'wreck' } },
      { subjectId: 'shen-yan', type: 'character', state: { location: 'cryo-pod' } },
      { subjectId: 'character:shenyan', type: 'character', state: { mood: '警惕' } },
      { subjectId: 'xiao-guan', type: 'character', state: { presence: 'scene-1' } },
    ],
    oracleDormant: [],
    relationshipChanges: [],
    foreshadowChanges: [],
    newEntities: [
      { subjectId: 'shen-yan', type: 'character', name: '沈砚' },
      { subjectId: 'character:shenyan', type: 'character', name: '沈砚' },
      { subjectId: 'xiao-guan', type: 'character', name: '小关' },
    ],
    openPromises: [],
    nextChapterPayoffs: [],
    truncated: false,
    degradedNote: undefined,
  };
  upsertChapterSummary(PID, {
    episodeId: 'ep1-01',
    episodeIndex: 1,
    storyTimeEnd: 1,
    summary,
    tokenEstimate: 100,
    truncated: false,
    patchRowidHigh: 11,
  });
}

describe.skipIf(!sqliteUsable)('worldSubjectIdMigration (dogfood R2 #91)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();
    // getDb 启动已跑过一次迁移（空库 no-op）——此处直接插脏数据后显式调迁移，模拟旧库首启。
    seedSplitLibrary(db);
  });
  afterAll(clean);

  it('三分身合并 + 双形态合并 + 裸 id 改名 + 已规范/卡锚不动', () => {
    const result = migrateWorldSubjectIds(getDb());
    const db = getDb();

    // 沈砚三形态 → character:shen-yan（引用最多者，4 patches）；老魏双形态 → character:lao-wei（2 > 1）；
    // 小关裸 id → character:xiao-guan（纯改名）；group 已规范不动；卡锚主体不动。
    const subjects = listWorldSubjects(PID);
    expect(subjects.map((s) => s.id).sort()).toEqual(
      [
        'character:lao-wei',
        'character:shen-yan',
        'character:xiao-guan',
        'card_miya_01',
        'group:archaeology-team',
      ].sort(),
    );
    // 字段 COALESCE：name 从分身并入（shen-yan 行 name 为 null → 并入 character:shen-yan 的 '沈砚'）；
    // firstSeen 取最小（character:shenyan 的 2 不抬高）。
    const shenYan = subjects.find((s) => s.id === 'character:shen-yan');
    expect(shenYan?.name).toBe('沈砚');
    expect(shenYan?.firstSeenStoryTime).toBe(1);

    // patch.subject_id 引用全表改写：6 条沈砚 patches 全归 character:shen-yan；value ref 同步改写。
    const patches = db
      .prepare('SELECT id, subject_id, value FROM closure_world_patch WHERE project_id = ? ORDER BY id')
      .all(PID) as Array<{ id: string; subject_id: string; value: string | null }>;
    const byId = new Map(patches.map((p) => [p.id, p]));
    for (const pid of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      expect(byId.get(pid)?.subject_id).toBe('character:shen-yan');
    }
    // p8 的 value 内 ref subject://shen-yan → subject://character:shen-yan（JSON-aware 精确改写）。
    expect(JSON.parse(byId.get('p8')?.value as string)).toBe('subject://character:shen-yan');
    expect(byId.get('p8')?.subject_id).toBe('character:lao-wei');
    expect(byId.get('p7')?.subject_id).toBe('character:lao-wei');
    expect(byId.get('p9')?.subject_id).toBe('character:xiao-guan');
    expect(byId.get('p10')?.subject_id).toBe('group:archaeology-team');
    expect(byId.get('p11')?.subject_id).toBe('card_miya_01');

    // checkpoint：merge 组（沈砚三 + 老魏双）删；rename 组（xiao-guan）改名；其余不动。
    const ckpts = db
      .prepare('SELECT subject_id FROM closure_world_checkpoint WHERE project_id = ? ORDER BY subject_id')
      .all(PID) as Array<{ subject_id: string }>;
    expect(ckpts.map((c) => c.subject_id)).toEqual([
      'card_miya_01',
      'character:xiao-guan',
      'group:archaeology-team',
    ]);
    expect(result.subjectsMerged).toBe(3); // shen-yan + character:shenyan（沈砚组）+ lao-wei（老魏组）
    expect(result.subjectsRenamed).toBe(1); // xiao-guan
    expect(result.checkpointsDropped).toBe(5); // 沈砚 3 + 老魏 2
    expect(result.checkpointsRenamed).toBe(1);

    // chapter summary：subjectId 改写 + 塌缩去重（三条沈砚终态 → 一条；两条新实体 → 一条）。
    const summaryRow = db
      .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
      .get(PID, 'ep1-01') as { summary: string };
    const parsed = JSON.parse(summaryRow.summary) as ChapterStateSummary;
    expect(parsed.characterEndStates.map((c) => c.subjectId)).toEqual([
      'character:shen-yan',
      'character:xiao-guan',
    ]);
    expect(parsed.newEntities.map((c) => c.subjectId)).toEqual([
      'character:shen-yan',
      'character:xiao-guan',
    ]);
  });

  it('幂等：重跑零效果（subjects/checkpoints/summary 全量不变）', () => {
    const db = getDb();
    const snapshot = () =>
      JSON.stringify({
        subjects: db
          .prepare('SELECT * FROM closure_world_subject WHERE project_id = ? ORDER BY id')
          .all(PID),
        patches: db
          .prepare('SELECT id, subject_id, value FROM closure_world_patch WHERE project_id = ? ORDER BY id')
          .all(PID),
        checkpoints: db
          .prepare('SELECT * FROM closure_world_checkpoint WHERE project_id = ? ORDER BY subject_id')
          .all(PID),
        summary: db
          .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ?')
          .all(PID),
      });
    const before = snapshot();
    const result = migrateWorldSubjectIds(db);
    expect(result.subjectsRenamed).toBe(0);
    expect(result.subjectsMerged).toBe(0);
    expect(result.patchesRewritten).toBe(0);
    expect(result.checkpointsDropped).toBe(0);
    expect(result.summariesRewritten).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it('退化 id（`character:`）改名后幂等——不每启动叠一层前缀', () => {
    // dogfood R2 #91 check：worldSubjectSlug 退化回退若非定点（曾回退原始串），`character:` 会
    // canonical 成 `character:character:`，下轮再叠一层 → 迁移每启动重改名（重写引用）非幂等。
    const db = getDb();
    const PID2 = '00092';
    const ins = db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES (?, ?, 'character', '退化', NULL, 1)`,
    );
    ins.run('character:', PID2);
    ins.run('-', PID2);
    const r1 = migrateWorldSubjectIds(db);
    // 两退化 id 撞同一占位 canonical `character:unnamed`（slug('character:') 与 slug('-') 均 'unnamed'）
    // → 一改名承接 + 一并入（合并组）。
    expect(r1.subjectsRenamed).toBe(1);
    expect(r1.subjectsMerged).toBe(1);
    const ids1 = db
      .prepare('SELECT id FROM closure_world_subject WHERE project_id = ? ORDER BY id')
      .all(PID2) as Array<{ id: string }>;
    const idStrings = ids1.map((r) => r.id).sort();
    expect(idStrings).toEqual(['character:unnamed']);
    // 重跑：退化组已收敛占位（定点）→ 零改名零合并（无叠层增长）。
    const r2 = migrateWorldSubjectIds(db);
    expect(r2.subjectsRenamed).toBe(0);
    expect(r2.subjectsMerged).toBe(0);
    const ids2 = db
      .prepare('SELECT id FROM closure_world_subject WHERE project_id = ? ORDER BY id')
      .all(PID2) as Array<{ id: string }>;
    expect(ids2.map((r) => r.id).sort()).toEqual(idStrings);
    db.prepare('DELETE FROM closure_world_subject WHERE project_id = ?').run(PID2);
  });

  it('summary state 嵌套 subject:// ref 同步改写（合并后不悬空指向已删分身）', () => {
    const db = getDb();
    const PID3 = '00093';
    db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES (?, ?, 'character', '沈砚', NULL, 1)`,
    ).run('shen-yan', PID3);
    db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES (?, ?, 'character', '沈砚', NULL, 2)`,
    ).run('character:shen-yan', PID3);
    db.prepare(
      `INSERT INTO closure_world_slice (id, project_id, story_time, kind, title, summary, episode_id)
       VALUES ('epA:1', ?, 1, 'event', 'ref 面', NULL, 'epA')`,
    ).run(PID3);
    db.prepare(
      `INSERT INTO closure_world_patch (id, slice_id, project_id, subject_id, path, op, value, axis, source, summary, evidence_scene_id)
       VALUES ('rp1', 'epA:1', ?, 'shen-yan', '/location', 'replace', '"subject://character:shen-yan"', 'physical', 'derived', '位置', NULL)`,
    ).run(PID3);
    upsertChapterSummary(PID3, {
      episodeId: 'epA',
      episodeIndex: 1,
      storyTimeEnd: 1,
      summary: {
        episodeId: 'epA',
        episodeIndex: 1,
        storyTimeStart: 1,
        storyTimeEnd: 1,
        characterEndStates: [
          {
            subjectId: 'shen-yan',
            type: 'character',
            // 折叠态内关系 ref——不写则合并后悬空指向已删的 shen-yan 分身。
            state: { location: 'subject://character:shen-yan', rival: 'subject://shen-yan' },
          },
        ],
        oracleDormant: [],
        relationshipChanges: [],
        foreshadowChanges: [],
        newEntities: [],
        openPromises: [],
        nextChapterPayoffs: [],
        truncated: false,
      },
      tokenEstimate: 50,
      truncated: false,
      patchRowidHigh: 1,
    });
    migrateWorldSubjectIds(db);
    const row = db
      .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
      .get(PID3, 'epA') as { summary: string };
    const parsed = JSON.parse(row.summary) as {
      characterEndStates: Array<{ subjectId: string; state: Record<string, unknown> }>;
    };
    expect(parsed.characterEndStates[0].subjectId).toBe('character:shen-yan');
    expect(parsed.characterEndStates[0].state.location).toBe('subject://character:shen-yan');
    expect(parsed.characterEndStates[0].state.rival).toBe('subject://character:shen-yan');
    // 清场（本 describe 共享 db——后续断言不混入本项目）。
    db.prepare('DELETE FROM closure_world_subject WHERE project_id = ?').run(PID3);
    db.prepare('DELETE FROM closure_world_slice WHERE project_id = ?').run(PID3);
    db.prepare('DELETE FROM closure_world_patch WHERE project_id = ?').run(PID3);
    db.prepare('DELETE FROM closure_chapter_summary WHERE project_id = ?').run(PID3);
  });

  it('事务边界：迁移中途失败回滚——不产生半迁移态（per-project 跳过不抛）', () => {
    const db = getDb();
    // 重新播种脏数据（前测试已迁移干净）——直接改回分身形态再断言失败后不变。
    db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES ('shen-yan', ?, 'character', NULL, NULL, 1)`,
    ).run(PID);
    db.prepare(
      `INSERT INTO closure_world_patch (id, slice_id, project_id, subject_id, path, op, value, axis, source, summary, evidence_scene_id)
       VALUES ('rp9', 'ep1-01:1', ?, 'shen-yan', '/hp', 'replace', '100', 'physical', 'derived', '失败注入', NULL)`,
    ).run(PID);

    const before = JSON.stringify({
      subjects: db
        .prepare('SELECT id FROM closure_world_subject WHERE project_id = ? ORDER BY id')
        .all(PID),
      patches: db
        .prepare('SELECT id, subject_id FROM closure_world_patch WHERE project_id = ? ORDER BY id')
        .all(PID),
      checkpoints: db
        .prepare('SELECT subject_id FROM closure_world_checkpoint WHERE project_id = ? ORDER BY subject_id')
        .all(PID),
    });

    // 注入中途失败：checkpoint DELETE 的 run 时抛（此刻 subjects 合并删行 + patch 引用改写已执行
    // ——靠事务回滚保零半迁移态；prepare 时抛则无已执行写可回，测不到真边界）。
    const target = db as unknown as { prepare: (sql: string) => unknown };
    const origPrepare = db.prepare.bind(db);
    target.prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('DELETE FROM closure_world_checkpoint')) {
        return {
          run: () => {
            throw new Error('simulated mid-migration failure');
          },
        };
      }
      return stmt;
    };
    try {
      expect(() => migrateWorldSubjectIds(db)).not.toThrow(); // per-project catch → warn 不抛
      const after = JSON.stringify({
        subjects: db
          .prepare('SELECT id FROM closure_world_subject WHERE project_id = ? ORDER BY id')
          .all(PID),
        patches: db
          .prepare('SELECT id, subject_id FROM closure_world_patch WHERE project_id = ? ORDER BY id')
          .all(PID),
        checkpoints: db
          .prepare('SELECT subject_id FROM closure_world_checkpoint WHERE project_id = ? ORDER BY subject_id')
          .all(PID),
      });
      expect(after).toBe(before); // 整项目回滚——无半迁移态
    } finally {
      target.prepare = origPrepare;
    }
    // 修复注入后重跑成功收敛（分身并入）。
    const result = migrateWorldSubjectIds(db);
    expect(result.subjectsMerged).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM closure_world_subject WHERE project_id = ? AND id = 'shen-yan'").get(PID),
    ).toEqual({ n: 0 });
  });
});

describe.skipIf(!sqliteUsable)('resolveWorldSubjectIdentity (dogfood R2 #91 写入门)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();
    seedSplitLibrary(db);
    // 先迁移到规范态（写入门面对的是迁移后世界）。
    migrateWorldSubjectIds(db);
  });
  afterAll(clean);

  it('同角色第二章提取（连字符变体 shenyan）→ 复用既有 canonical id，不建分身', () => {
    // 提取器产 `character:shenyan`（LLM 连字符习惯漂移）——精确 id 库内不存在，matchKey 兜住。
    const subjects: WorldSubject[] = [{ id: 'character:shenyan', type: 'character', name: '沈砚', firstSeenStoryTime: 9 }];
    const patches: WorldPatchInput[] = [
      { subjectId: 'character:shenyan', path: '/mood', op: 'replace', value: '动摇', axis: 'emotional' },
    ];
    const res = resolveWorldSubjectIdentity(PID, subjects, patches);

    expect(res.subjects).toHaveLength(1);
    expect(res.subjects[0].id).toBe('character:shen-yan'); // 复用既有 canonical
    expect(res.patches[0].subjectId).toBe('character:shen-yan');
    expect(res.remaps).toEqual([{ from: 'character:shenyan', to: 'character:shen-yan' }]);
    expect(res.reusedCount).toBe(1);
  });

  it('裸 slug + 前缀形态 + 新主体（canonical 登记）', () => {
    const subjects: WorldSubject[] = [
      { id: 'lao-wei', type: 'character', firstSeenStoryTime: 9 }, // 裸形态 → matchKey 命中 character:lao-wei
      { id: 'wei-zhe', type: 'character', name: '卫者', firstSeenStoryTime: 9 }, // 新主体 → canonical 登记
    ];
    const patches: WorldPatchInput[] = [
      { subjectId: 'lao-wei', path: '/hp', op: 'increment', value: -5, axis: 'physical' },
      { subjectId: 'wei-zhe', path: '/presence_scene', op: 'replace', value: 'subject://shen-yan', axis: 'physical' },
    ];
    const res = resolveWorldSubjectIdentity(PID, subjects, patches);

    const ids = res.subjects.map((s) => s.id).sort();
    expect(ids).toEqual(['character:lao-wei', 'character:wei-zhe']);
    expect(res.patches[0].subjectId).toBe('character:lao-wei');
    expect(res.patches[1].subjectId).toBe('character:wei-zhe');
    // value ref（subject://shen-yan）经 slug-only 唯一命中归一到 canonical。
    expect(res.patches[1].value).toBe('subject://character:shen-yan');
    expect(res.reusedCount).toBe(1); // lao-wei 复用；wei-zhe 新建
  });

  it('卡锚优先：sourceCardId 命中既有卡主体 → 复用卡 id（不建分身）', () => {
    const subjects: WorldSubject[] = [
      { id: 'miya', type: 'character', name: '米娅', sourceCardId: 'card_miya_01', firstSeenStoryTime: 9 },
    ];
    const res = resolveWorldSubjectIdentity(PID, subjects, []);
    expect(res.subjects[0].id).toBe('card_miya_01');
    expect(res.reusedCount).toBe(1);
  });

  it('表外 subjectId slug-only 多义不归一（不臆测）', () => {
    // 构造多义：另插一个 type=group 的 shenyan 主体 → slug 键 'shenyan' 双主体现身。
    const db = getDb();
    db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES ('group:shenyan', ?, 'group', '沈砚研究组', NULL, 9)`,
    ).run(PID);
    const patches: WorldPatchInput[] = [
      { subjectId: 'shenyan2', path: '/x', op: 'replace', value: 1, axis: 'physical' },
    ];
    const res = resolveWorldSubjectIdentity(PID, [], patches);
    // slug 键 'shenyan2' 无命中 → 原样；且此前测试内 'shenyan' 键多义——value ref 场景同样留原值。
    expect(res.patches[0].subjectId).toBe('shenyan2');
  });

  it('entity 哨兵认领批内具体主体（linkReferencedSubjects 裸 ref stub 不裂分身）', () => {
    // 常态路径（#91 check 发现）：prompt ref 示例是裸形态（subject://erina），agent 层 subjects 已
    // canonical 化而 value ref 未改 → merge 对批内裸 ref 补 type='entity' stub。gate 须让 stub 认领
    // 批内具体主体（slug 桶唯一命中），而非另建 `entity:sword-01` 分身。
    const subjects: WorldSubject[] = [
      { id: 'item:sword-01', type: 'item', name: '佩剑', firstSeenStoryTime: 9 }, // 具体主体（agent 已 canonical 化）
      { id: 'sword-01', type: 'entity', firstSeenStoryTime: 9 }, // 裸 ref 补的 stub（type 未知哨兵）
    ];
    const patches: WorldPatchInput[] = [
      {
        subjectId: 'item:sword-01',
        path: '/equipment/weapon',
        op: 'replace',
        value: 'subject://sword-01', // 裸 ref → 指向 stub 原始 id
        axis: 'physical',
      },
    ];
    const res = resolveWorldSubjectIdentity(PID, subjects, patches);
    // 单一登记：stub 并入 item:sword-01，无 entity:sword-01 分身。
    expect(res.subjects.map((s) => s.id)).toEqual(['item:sword-01']);
    expect(res.remaps).toContainEqual({ from: 'sword-01', to: 'item:sword-01' });
    // 裸 ref 同步归一到 canonical。
    expect(res.patches[0].value).toBe('subject://item:sword-01');
    expect(res.reusedCount).toBe(0); // 批内新登记（库内无 sword-01）
  });

  it('遗留 entity 哨兵被具体 type 到场认领（type 经 upsert 细化，不裂第二行）', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES ('entity:beacon-01', ?, 'entity', NULL, NULL, 8)`,
    ).run(PID);
    // 下一章提取器给出具体 type=item——slug 桶内仅 entity 哨兵 → 沿用其 id（upsert COALESCE 细化 type）。
    const subjects: WorldSubject[] = [{ id: 'beacon-01', type: 'item', name: '信标', firstSeenStoryTime: 9 }];
    const res = resolveWorldSubjectIdentity(PID, subjects, []);
    expect(res.subjects[0].id).toBe('entity:beacon-01');
    expect(res.subjects[0].type).toBe('item');
    expect(res.reusedCount).toBe(1);
  });

  it('slug 桶具体优先：entity 哨兵 + 具体 phoenix 同 slug → ref 解析具体者', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES ('entity:phoenix', ?, 'entity', NULL, NULL, 8)`,
    ).run(PID);
    db.prepare(
      `INSERT INTO closure_world_subject (id, project_id, type, name, source_card_id, first_seen_story_time)
       VALUES ('faction:phoenix', ?, 'faction', '凤凰', NULL, 8)`,
    ).run(PID);
    const patches: WorldPatchInput[] = [
      { subjectId: 'character:shen-yan', path: '/allies', op: 'append', value: 'subject://phoenix', axis: 'relational' },
    ];
    const res = resolveWorldSubjectIdentity(PID, [], patches);
    // entity 在场不构成歧义——具体 faction:phoenix 胜出。
    expect(res.patches[0].value).toBe('subject://faction:phoenix');
  });

  it('卡锚主体在 matchKey 索引内：LLM 用卡 id 当 subjectId 但漏带 sourceCardId → 兜回卡主体', () => {
    // 迁移分组含卡锚成员（按自身 id 的 matchKey 入组），gate 索引同规则——否则 canonical
    // `character:card_miya_01` 会与 `card_miya_01` 裂成分身（迁移下启动才合并，期间跨章分裂）。
    const subjects: WorldSubject[] = [
      { id: 'card_miya_01', type: 'character', name: '米娅', firstSeenStoryTime: 9 }, // ⚠️ 无 sourceCardId
    ];
    const res = resolveWorldSubjectIdentity(PID, subjects, []);
    expect(res.subjects[0].id).toBe('card_miya_01');
    expect(res.reusedCount).toBe(1);
  });

  it('checkpoint state 内 ref 改写辅助面：rewriteSubjectRefsInValue 精确整串匹配（不伤 prose 子串）', async () => {
    const { rewriteSubjectRefsInValue } = await import('../main/db/worldSubjectIdMigration');
    const value = {
      weapon: 'subject://sword-01',
      note: '提到了 subject://sword-01 的传说', // 内嵌子串——不改
      arr: ['subject://shield-02', { inner: 'subject://ring-03' }],
    };
    const res = rewriteSubjectRefsInValue(value, (refId) =>
      refId === 'sword-01' ? 'item:sword-01' : undefined,
    );
    expect(res.changed).toBe(true);
    const v = res.value as { weapon: string; note: string; arr: unknown[] };
    expect(v.weapon).toBe('subject://item:sword-01');
    expect(v.note).toBe('提到了 subject://sword-01 的传说'); // prose 子串保留
    expect((v.arr[0] as string)).toBe('subject://shield-02'); // 不在改写表保留
  });

  it('checkpoint 写入面回归：迁移后 insertWorldCheckpoints 正常（schema 兼容）', () => {
    const rows: WorldCheckpointInsert[] = [
      { subjectId: 'character:shen-yan', atStoryTime: 2, state: { folded: true }, issueCount: 0, patchRowidHigh: 99, patchCountFolded: 3 },
    ];
    expect(() => insertWorldCheckpoints(PID, rows)).not.toThrow();
  });
});
