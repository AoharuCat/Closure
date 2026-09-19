import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildWorldStateSnapshot, type ChapterStateSummary } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateRepository.test.ts / closureSchema.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-world-state-ckpt');

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
  buildWorldSnapshotCheckpointed,
  getLatestWorldCheckpoint,
  getWorldPatchRowidHigh,
  insertWorldCheckpoints,
  insertWorldSlice,
  listChapterSummaries,
  listWorldPatches,
  listWorldSlices,
  reduceWorldSubject,
  reduceWorldSubjectCheckpointed,
  resetWorldState,
  upsertChapterSummary,
  upsertChapterSummaryWithCheckpoints,
} from '../main/db/worldStateRepository';

// better-sqlite3 ABI gate (mirror worldStateRepository.test.ts): skip the SQL
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

// Story 8.1 suite uses its own project id (fresh db after clean; composite PKs
// keep subjects isolated per project even when ids are reused across suites).
const PID = '00002';

/** 全量 fold 基准等价断言（design §3.2）：state deep-equal + issueCount ≡ fold issues.length。 */
function expectEquivalentToFullFold(
  checkpointed: { state: Record<string, unknown>; issueCount: number },
  baseline: { state: Record<string, unknown>; issues: unknown[] },
) {
  expect(checkpointed.state).toEqual(baseline.state);
  expect(checkpointed.issueCount).toBe(baseline.issues.length);
}

describe.skipIf(!sqliteUsable)('worldStateRepository checkpoint + chapter summary (Story 8.1 Step 2)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('initSchema 建 closure_world_checkpoint / closure_chapter_summary + 索引 + slice.episode_id 列', () => {
    const db = getDb();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(tables.has('closure_world_checkpoint')).toBe(true);
    expect(tables.has('closure_chapter_summary')).toBe(true);

    const indexes = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(indexes.has('idx_world_ckpt_lookup')).toBe(true);
    expect(indexes.has('idx_chapter_summary_order')).toBe(true);

    const sliceCols = (
      db.pragma('table_info(closure_world_slice)') as { name: string }[]
    ).map((c) => c.name);
    expect(sliceCols).toContain('episode_id');
  });

  it('seed fixture：多 slice / 多 subject / 含 broken-relative issues（后续等价性测试数据）', () => {
    // erina：t=100 登记 + hp 100；t=150 hp -30（→70）；t=150 armor increment 无基准（issue #1）；
    //        t=200 hp -20（→50）；t=250 cloak increment 无基准（issue #2）；t=300 hp replace 90。
    insertWorldSlice(
      PID,
      { id: 'ep-001:100', storyTime: 100, title: '转生', episodeId: 'ep-001' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
      [{ id: 'erina', type: 'character', name: '艾莉娜', firstSeenStoryTime: 100 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-001:150', storyTime: 150, title: '受伤', episodeId: 'ep-001' },
      [
        { subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical' },
        { subjectId: 'erina', path: '/armor', op: 'increment', value: 5, axis: 'physical' }, // 无基准 → issue
      ],
      [],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-002:200', storyTime: 200, title: '苦战', episodeId: 'ep-002' },
      [
        { subjectId: 'erina', path: '/hp', op: 'increment', value: -20, axis: 'physical' },
        { subjectId: 'bob', path: '/mana', op: 'replace', value: 10, axis: 'physical' },
      ],
      [{ id: 'bob', type: 'character', name: '鲍勃', firstSeenStoryTime: 200 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-002:250', storyTime: 250, title: '夜谈', episodeId: 'ep-002' },
      [
        { subjectId: 'erina', path: '/cloak', op: 'increment', value: 1, axis: 'physical' }, // 无基准 → issue
        { subjectId: 'bob', path: '/mana', op: 'increment', value: 5, axis: 'physical' },
      ],
      [],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-003:300', storyTime: 300, title: '再起', episodeId: 'ep-003' },
      [
        { subjectId: 'erina', path: '/hp', op: 'replace', value: 90, axis: 'physical' },
        { subjectId: 'no-base', path: '/grudge', op: 'increment', value: 1, axis: 'emotional' }, // 无基准 → issue
      ],
      [{ id: 'no-base', type: 'character', firstSeenStoryTime: 300 }],
      'derived',
    );

    // 基线 sanity：全量 fold（既有 reduceWorldSubject 路径）数字符合手算。
    const erinaAt150 = reduceWorldSubject(PID, 'erina', 150);
    expect(erinaAt150.state.hp).toBe(70);
    expect(erinaAt150.issues).toHaveLength(1); // armor broken-relative
  });

  it('miss → lazy 建 checkpoint（字段正确）；再次 reduce 命中且零窗等价', () => {
    const first = reduceWorldSubjectCheckpointed(PID, 'erina', 150);
    expect(first.checkpointHit).toBe(false);
    expect(first.patchesFolded).toBe(3); // hp100 + hp-30 + armor(跳过但仍 fold 计数)
    expect(first.issueCount).toBe(1);
    expectEquivalentToFullFold(first, reduceWorldSubject(PID, 'erina', 150));

    // 顺手建的 checkpoint 字段（design §3.1）。
    const ckpt = getLatestWorldCheckpoint(PID, 'erina', 150);
    expect(ckpt).toBeDefined();
    expect(ckpt?.atStoryTime).toBe(150);
    expect(ckpt?.issueCount).toBe(1);
    expect(ckpt?.patchCountFolded).toBe(3);
    expect(ckpt?.patchRowidHigh).toBeGreaterThan(0);
    expect((ckpt?.state as { hp?: number }).hp).toBe(70);

    // 同 at 再 reduce：命中 + 零窗 + 结果等价（checkpoint state 经 db JSON round-trip 后仍正确）。
    const second = reduceWorldSubjectCheckpointed(PID, 'erina', 150);
    expect(second.checkpointHit).toBe(true);
    expect(second.patchesFolded).toBe(0);
    expect(second.state).toEqual(first.state);
    expect(second.issueCount).toBe(first.issueCount);
  });

  it('命中路径等价：窗口叠加 + issueCount 合并 ≡ 全量 fold（多 subject × 多 at，含 at=undefined）', () => {
    const subjects = ['erina', 'bob', 'no-base'];
    const ats: Array<number | undefined> = [150, 250, 300, undefined];
    for (const subjectId of subjects) {
      for (const at of ats) {
        const checkpointed = reduceWorldSubjectCheckpointed(PID, subjectId, at);
        const baseline = reduceWorldSubject(PID, subjectId, at);
        expectEquivalentToFullFold(checkpointed, baseline);
      }
    }
    // 定点抽查语义（非只比形状）：erina@250 命中自 ckpt@150，窗 = hp-20 + cloak issue。
    const erina250 = reduceWorldSubjectCheckpointed(PID, 'erina', 250);
    expect(erina250.checkpointHit).toBe(true);
    expect(erina250.patchesFolded).toBe(2);
    expect(erina250.state.hp).toBe(50);
    expect(erina250.issueCount).toBe(2); // ckpt(armor) + 窗(cloak)
    // erina 最新：hp replace 90 覆盖 increment 链。
    const erinaLatest = reduceWorldSubjectCheckpointed(PID, 'erina');
    expect(erinaLatest.state.hp).toBe(90);
  });

  it('重写 slice 产零 patch → 显式失效（水印漏判路径：删除不留 rowid 痕迹）', () => {
    // dormant-hero：t=100 一个 patch → lazy 建 checkpoint@100；再手动补一个@120 的 checkpoint（盖 >= 语义）。
    insertWorldSlice(
      PID,
      { id: 'dz:100', storyTime: 100, title: '登场' },
      [{ subjectId: 'dormant-hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
      [{ id: 'dormant-hero', type: 'character', firstSeenStoryTime: 100 }],
      'derived',
    );
    reduceWorldSubjectCheckpointed(PID, 'dormant-hero', 100); // miss → 建 checkpoint@100
    expect(getLatestWorldCheckpoint(PID, 'dormant-hero', 100)).toBeDefined();
    // CR-11 修复批：水印取真实值（原 999_999 巨水印会被新 rowid 回卷 belt 误证伪——belt 判
    // 「声称折叠过的 rowid 已不存在」；真实水印 = subject 现存 MAX(rowid)，belt 不干预，本测检验显式失效）。
    insertWorldCheckpoints(PID, [
      {
        subjectId: 'dormant-hero',
        atStoryTime: 120,
        state: { hp: 100 },
        issueCount: 0,
        patchRowidHigh: getWorldPatchRowidHigh(PID, 'dormant-hero'),
        patchCountFolded: 1,
      },
    ]);
    expect(getLatestWorldCheckpoint(PID, 'dormant-hero', 120)?.atStoryTime).toBe(120);

    // 重提取产出零 patch：旧 patch 删除、零新行——水印判不了（无 rowid > watermark 的新行），
    // 显式失效必须删掉 >= 100 的全部 checkpoint。
    insertWorldSlice(
      PID,
      { id: 'dz:100', storyTime: 100, title: '重提取零产出' },
      [],
      [],
      'derived',
    );
    expect(getLatestWorldCheckpoint(PID, 'dormant-hero', 100)).toBeUndefined();
    expect(getLatestWorldCheckpoint(PID, 'dormant-hero', 120)).toBeUndefined();
    // 行真被 DELETE（belt 证伪只绕过不删行——显式失效的证据）。
    const ckptRows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM closure_world_checkpoint WHERE subject_id = ?')
      .get('dormant-hero') as { n: number };
    expect(ckptRows.n).toBe(0);

    // 全 fold 空史 → state {}（若 stale checkpoint 被误用会得 hp:100——这正是要防的）。
    const after = reduceWorldSubjectCheckpointed(PID, 'dormant-hero', 100, {
      writeCheckpoint: false,
    });
    expect(after.checkpointHit).toBe(false);
    expect(after.state).toEqual({});
  });

  it('amendment 写入失效 at >= slice.storyTime 的 checkpoint，保留更早的', () => {
    // amend-hero：t=100 derived → checkpoint@100；t=200 amendment hp=40。
    insertWorldSlice(
      PID,
      { id: 'am:100', storyTime: 100, title: '登场' },
      [{ subjectId: 'amend-hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
      [{ id: 'amend-hero', type: 'character', firstSeenStoryTime: 100 }],
      'derived',
    );
    reduceWorldSubjectCheckpointed(PID, 'amend-hero', 100); // 建 checkpoint@100
    insertWorldSlice(
      PID,
      { id: 'am-fix:200', storyTime: 200, title: '修正' },
      [{ subjectId: 'amend-hero', path: '/hp', op: 'replace', value: 40, axis: 'physical', summary: '修补' }],
      [],
      'amendment',
    );

    // checkpoint@100 < 200 → 保留；自它起的窗含 amendment → 等价。
    expect(getLatestWorldCheckpoint(PID, 'amend-hero', 100)?.atStoryTime).toBe(100);
    const at300 = reduceWorldSubjectCheckpointed(PID, 'amend-hero', 300);
    expect(at300.state.hp).toBe(40);
    expectEquivalentToFullFold(at300, reduceWorldSubject(PID, 'amend-hero', 300));

    // 手动放一个 checkpoint@300（mirror 物化路径的阈值推进写），再 re-amend 同 slice（t=200）→
    // 显式失效删 >= 200（@300 亡）保 < 200（@100 存）。水印取真实值（CR-11 修复批——原 999_999 巨水印
    // 会被 rowid 回卷 belt 证伪；真实水印确保检验的是**显式失效**路径而非任一 belt）。
    insertWorldCheckpoints(PID, [
      {
        subjectId: 'amend-hero',
        atStoryTime: 300,
        state: { hp: 40 },
        issueCount: 0,
        patchRowidHigh: getWorldPatchRowidHigh(PID, 'amend-hero'),
        patchCountFolded: 2,
      },
    ]);
    insertWorldSlice(
      PID,
      { id: 'am-fix:200', storyTime: 200, title: '再修正' },
      [{ subjectId: 'amend-hero', path: '/hp', op: 'replace', value: 60, axis: 'physical', summary: '修补2' }],
      [],
      'amendment',
    );
    expect(getLatestWorldCheckpoint(PID, 'amend-hero', 400)?.atStoryTime).toBe(100);
    // 行级证据：@300 被 DELETE（非 belt 绕过），@100 留存。
    const amendCkpts = getDb()
      .prepare('SELECT at_story_time AS t FROM closure_world_checkpoint WHERE subject_id = ?')
      .all('amend-hero') as Array<{ t: number }>;
    expect(amendCkpts.map((r) => r.t)).toEqual([100]);
    const at400 = reduceWorldSubjectCheckpointed(PID, 'amend-hero', 400);
    expect(at400.checkpointHit).toBe(true);
    expect(at400.state.hp).toBe(60);
    expectEquivalentToFullFold(at400, reduceWorldSubject(PID, 'amend-hero', 400));
  });

  it('水印 belt：checkpoint 后绕过 insertWorldSlice 手动补历史 patch → getLatest 判无效', () => {
    insertWorldSlice(
      PID,
      { id: 'belt:100', storyTime: 100, title: '登场' },
      [{ subjectId: 'belt-hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
      [{ id: 'belt-hero', type: 'character', firstSeenStoryTime: 100 }],
      'derived',
    );
    reduceWorldSubjectCheckpointed(PID, 'belt-hero', 100); // 建 checkpoint@100
    expect(getLatestWorldCheckpoint(PID, 'belt-hero', 100)).toBeDefined();

    // 手动改库：绕过 insertWorldSlice（无显式失效）插一条 backdated patch（rowid > 水印 且
    // story_time 90 <= ckpt.at 100）——水印 belt 应证伪该 checkpoint。value 列存 JSON（表契约）。
    const db = getDb();
    db.prepare(
      "INSERT INTO closure_world_slice (id, project_id, story_time, title) VALUES ('belt2:90', ?, 90, '手动补历史')",
    ).run(PID);
    db.prepare(
      `INSERT INTO closure_world_patch (id, slice_id, project_id, subject_id, path, op, value, axis, source)
       VALUES ('belt-p2', 'belt2:90', ?, 'belt-hero', '/title', 'replace', ?, 'physical', 'derived')`,
    ).run(PID, JSON.stringify('侠'));

    expect(getLatestWorldCheckpoint(PID, 'belt-hero', 100)).toBeUndefined();

    // miss 全 fold 拿到补历史后的完整态（title 在——证明真的重 fold 而非用 stale checkpoint）。
    const after = reduceWorldSubjectCheckpointed(PID, 'belt-hero', 100, { writeCheckpoint: false });
    expect(after.checkpointHit).toBe(false);
    expect(after.state).toEqual({ title: '侠', hp: 100 });
    expectEquivalentToFullFold(after, reduceWorldSubject(PID, 'belt-hero', 100));
  });

  it('CR-7 LIKE `_` 通配符转义：episodeId 含下划线不误匹配单字符位（ep_1 查不走 epX1:…）', () => {
    // 两行存量 slice（episode_id NULL → 走 LIKE fallback）：目标 'ep_1:60'（episode 'ep_1'）+ 诱饵
    // 'epX1:50'——未转义模式 'ep_1:%' 的 `_` 是单字符通配符，会误匹配 'epX1:50'。
    insertWorldSlice(PID, { id: 'epX1:50', storyTime: 50, title: '诱饵' }, [], [], 'derived');
    insertWorldSlice(PID, { id: 'ep_1:60', storyTime: 60, title: '下划线章' }, [], [], 'derived');

    const hits = listWorldSlices(PID, { episodeId: 'ep_1' });
    expect(hits.map((s) => s.id)).toEqual(['ep_1:60']); // epX1:50 不入（escapeLike + ESCAPE '\'）
  });

  it('CR-11 rowid 回卷 belt：手动删行后新 patch rowid 低于水印 → checkpoint 证伪（声称折叠过的行已不存在）', () => {
    // rb-a 先插（占低 rowid），rb-b 两 patch（更高 rowid）→ lazy 建 ckpt@200（high = rb-b 最高 rowid）。
    insertWorldSlice(
      PID,
      { id: 'rb-a:100', storyTime: 100, title: 'A' },
      [{ subjectId: 'rb-a', path: '/hp', op: 'replace', value: 1, axis: 'physical' }],
      [{ id: 'rb-a', type: 'character', firstSeenStoryTime: 100 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'rb-b:100', storyTime: 100, title: 'B1' },
      [{ subjectId: 'rb-b', path: '/hp', op: 'replace', value: 10, axis: 'physical' }],
      [{ id: 'rb-b', type: 'character', firstSeenStoryTime: 100 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'rb-b:200', storyTime: 200, title: 'B2' },
      [{ subjectId: 'rb-b', path: '/hp', op: 'increment', value: 5, axis: 'physical' }],
      [],
      'derived',
    );
    const fold1 = reduceWorldSubjectCheckpointed(PID, 'rb-b', 200); // miss → lazy ckpt@200
    expect(fold1.state.hp).toBe(15);
    expect(getLatestWorldCheckpoint(PID, 'rb-b', 200)).toBeDefined();

    // 手术（绕过 insertWorldSlice——无显式失效）：删 rb-b 全部 patch 行，再直插一条 backdated patch
    // （storyTime 200 ≤ ckpt.at 200——落在 checkpoint 声称的折叠范围内）。新 rowid = 表内剩余最大
    // rowid（rb-a）+1 < 原水印（删最高行后 SQLite 复用低 rowid）——旧 belt（rowid > high 的新行）
    // 对删除无感知，回卷 belt（high > 现存 MAX(rowid)）是唯一防线。
    const db = getDb();
    db.prepare("DELETE FROM closure_world_patch WHERE project_id = ? AND subject_id = 'rb-b'").run(PID);
    db.prepare(
      `INSERT INTO closure_world_patch (id, slice_id, project_id, subject_id, path, op, value, axis, source)
       VALUES ('rb-b-p3', 'rb-b:200', ?, 'rb-b', '/hp', 'replace', ?, 'physical', 'derived')`,
    ).run(PID, JSON.stringify(12));

    expect(getLatestWorldCheckpoint(PID, 'rb-b', 200)).toBeUndefined(); // 回卷 belt 证伪
    const after = reduceWorldSubjectCheckpointed(PID, 'rb-b', 200, { writeCheckpoint: false });
    expect(after.checkpointHit).toBe(false); // 弃 checkpoint 全 fold
    expect(after.state).toEqual({ hp: 12 }); // 手术后的真值（若用 stale ckpt 会丢这条 patch 得 hp:15）
    expectEquivalentToFullFold(after, reduceWorldSubject(PID, 'rb-b', 200));
  });

  it('CR-15 checkpoint state 含 undefined 值键：db JSON round-trip 后 seeded reduce ≡ 全量 fold（观测等价）', () => {
    // replace 无 value → state.ghost = undefined（键存在值 undefined——JSON.stringify 会丢该键）。
    insertWorldSlice(
      PID,
      { id: 'ud:100', storyTime: 100, title: '登记', episodeId: 'ep-ud' },
      [
        { subjectId: 'ud-hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' },
        { subjectId: 'ud-hero', path: '/ghost', op: 'replace', axis: 'physical' },
      ],
      [{ id: 'ud-hero', type: 'character', firstSeenStoryTime: 100 }],
      'derived',
    );
    const first = reduceWorldSubjectCheckpointed(PID, 'ud-hero', 100); // miss → lazy ckpt@100
    expect(first.checkpointHit).toBe(false);
    expect('ghost' in first.state).toBe(true); // 折叠态确有 undefined 值键（round-trip 前提成立）

    // 后续 patch → 命中 checkpoint（其 state 经 db JSON round-trip——undefined 键被丢）。
    insertWorldSlice(
      PID,
      { id: 'ud:200', storyTime: 200, title: '受伤', episodeId: 'ep-ud' },
      [{ subjectId: 'ud-hero', path: '/hp', op: 'increment', value: -30, axis: 'physical' }],
      [],
      'derived',
    );
    const hit = reduceWorldSubjectCheckpointed(PID, 'ud-hero', 200, { writeCheckpoint: false });
    expect(hit.checkpointHit).toBe(true);
    // 观测等价（Blind#6）：undefined 值键与缺键在 fold 输出上不可区分（getState 均返 undefined），
    // checkpointed ≡ 全量 fold（toEqual 视两形态相等；显式值断言旁证）。
    expect(hit.state).toEqual(reduceWorldSubject(PID, 'ud-hero', 200).state);
    expect(hit.state.hp).toBe(70);
    expect(hit.state.ghost).toBeUndefined();
  });

  it('episode_id 列读写 + legacy NULL 行 LIKE fallback 查询', () => {
    // 新写入：显式 episodeId 落列 + 读回。
    insertWorldSlice(
      PID,
      { id: 'ep-005:500', storyTime: 500, title: '第五章', episodeId: 'ep-005' },
      [{ subjectId: 'ep5-hero', path: '/hp', op: 'replace', value: 55, axis: 'physical' }],
      [{ id: 'ep5-hero', type: 'character', firstSeenStoryTime: 500 }],
      'derived',
    );
    const written = listWorldSlices(PID, { episodeId: 'ep-005' }).find((s) => s.id === 'ep-005:500');
    expect(written?.episodeId).toBe('ep-005');

    // 存量行模拟：episode_id 置 NULL（8.1 之前写入的行）→ LIKE '<episodeId>:%' fallback 仍可查。
    const db = getDb();
    db.prepare("UPDATE closure_world_slice SET episode_id = NULL WHERE id = 'ep-005:500'").run();
    const legacy = listWorldSlices(PID, { episodeId: 'ep-005' });
    expect(legacy.map((s) => s.id)).toEqual(['ep-005:500']);
    expect(legacy[0].episodeId).toBeUndefined();

    // 前缀诱饵不误匹配：'ep-005x:700' 不含 'ep-005:' 子串（冒号定界）；他集 slice 不入集。
    insertWorldSlice(
      PID,
      { id: 'ep-005x:700', storyTime: 700, title: '前缀诱饵' },
      [],
      [],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-006:800', storyTime: 800, title: '第六章', episodeId: 'ep-006' },
      [],
      [],
      'derived',
    );
    const still = listWorldSlices(PID, { episodeId: 'ep-005' }).map((s) => s.id);
    expect(still).toEqual(['ep-005:500']);
  });

  it('buildWorldSnapshotCheckpointed ≡ 纯函数 buildWorldStateSnapshot（at/attrs 变体，内容等价）', () => {
    const allPatches = listWorldPatches(PID);
    const variants: Array<{ at: number | undefined; attrs?: string[] }> = [
      { at: 250 },
      { at: undefined },
      { at: 250, attrs: ['hp'] },
      { at: 100 },
    ];
    for (const v of variants) {
      const shellSide = buildWorldSnapshotCheckpointed(PID, v.at, v.attrs ? { attrs: v.attrs } : undefined);
      const pureSide = buildWorldStateSnapshot(allPatches, v.at, v.attrs ? { attrs: v.attrs } : undefined);
      // 内容等价（subject 集合 + per-subject state/issueCount）。顺序规范化后再比：两侧 first-seen
      // 序的 tie-break 不同（SQL id ASC vs 纯函数 patch rowid 序）——同 first_seen 的 subject 间顺序
      // 不是本契约的一部分（design §3.2 只断言语义一致 + cap 截断前序）。
      const byId = (arr: { subjectId: string }[]) => arr.slice().sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));
      expect(shellSide.at).toBe(pureSide.at);
      expect(byId(shellSide.subjects)).toEqual(byId(pureSide.subjects));
    }
  });

  it('chapter summary upsert/list round-trip + 幂等覆盖 + 三过滤 + NULL index graceful', () => {
    const mkSummary = (episodeId: string, index: number | null): ChapterStateSummary => ({
      episodeId,
      episodeIndex: index,
      storyTimeStart: index !== null ? index * 100 : null,
      storyTimeEnd: index !== null ? index * 100 + 50 : null,
      characterEndStates: [{ subjectId: 'erina', type: 'character', state: { hp: 70 } }],
      oracleDormant: [{ subjectId: 'dormant-hero' }],
      relationshipChanges: [],
      foreshadowChanges: [],
      newEntities: [],
      openPromises: [],
      nextChapterPayoffs: [],
      truncated: false,
    });

    // 首写 + 同 episode 二次 upsert 覆盖（幂等，不累积）。
    upsertChapterSummary(PID, {
      episodeId: 'ep-001',
      episodeIndex: 1,
      storyTimeEnd: 150,
      summary: mkSummary('ep-001', 1),
      tokenEstimate: 42,
      truncated: false,
      patchRowidHigh: 3,
    });
    upsertChapterSummary(PID, {
      episodeId: 'ep-001',
      episodeIndex: 1,
      storyTimeEnd: 160,
      summary: mkSummary('ep-001', 1),
      tokenEstimate: 99,
      truncated: true,
      patchRowidHigh: 7,
    });
    upsertChapterSummary(PID, {
      episodeId: 'ep-002',
      episodeIndex: 2,
      storyTimeEnd: 250,
      summary: mkSummary('ep-002', 2),
      tokenEstimate: 50,
      truncated: false,
      patchRowidHigh: 9,
    });
    upsertChapterSummary(PID, {
      episodeId: 'ep-003',
      episodeIndex: 3,
      storyTimeEnd: 300,
      summary: mkSummary('ep-003', 3),
      tokenEstimate: 60,
      truncated: false,
      patchRowidHigh: 11,
    });
    // 源缺 index 的历史章（episode_outlines 无 index）：episodeIndex NULL，排序垫底、范围查询不命中。
    upsertChapterSummary(PID, {
      episodeId: 'ep-na',
      episodeIndex: null,
      storyTimeEnd: null,
      summary: mkSummary('ep-na', null),
      tokenEstimate: 10,
      truncated: false,
      patchRowidHigh: 0,
    });

    const all = listChapterSummaries(PID);
    expect(all.map((r) => r.episodeId)).toEqual(['ep-001', 'ep-002', 'ep-003', 'ep-na']);
    // 覆盖语义：ep-001 是第二次写入的值（tokenEstimate/truncated/patchRowidHigh 均更新）。
    const ep1 = all.find((r) => r.episodeId === 'ep-001')!;
    expect(ep1.tokenEstimate).toBe(99);
    expect(ep1.truncated).toBe(true);
    expect(ep1.patchRowidHigh).toBe(7);
    expect(ep1.storyTimeEnd).toBe(160);
    // summary JSON round-trip（结构化对象完整往返）。
    expect(ep1.summary.characterEndStates[0]?.state).toEqual({ hp: 70 });
    expect(ep1.summary.oracleDormant).toEqual([{ subjectId: 'dormant-hero' }]);
    expect(typeof ep1.updatedAt).toBe('string');

    // episodeIds 精确集（顺序按 index，NULL 垫底）。
    const byIds = listChapterSummaries(PID, { episodeIds: ['ep-003', 'ep-001'] });
    expect(byIds.map((r) => r.episodeId)).toEqual(['ep-001', 'ep-003']);
    // fromIndex/toIndex 闭区间；NULL index 行不命中（SQL NULL 比较语义）。
    const range = listChapterSummaries(PID, { fromIndex: 2, toIndex: 3 });
    expect(range.map((r) => r.episodeId)).toEqual(['ep-002', 'ep-003']);
    // NULL index 行仍可按 id 精确取。
    const naOnly = listChapterSummaries(PID, { episodeIds: ['ep-na'] });
    expect(naOnly.map((r) => r.episodeId)).toEqual(['ep-na']);
    expect(naOnly[0].episodeIndex).toBeNull();

    // 坏 JSON 行容错（CR-E6 模式）：单行损坏只丢该行，不崩整 list。
    const db = getDb();
    db.prepare(
      "UPDATE closure_chapter_summary SET summary = '{broken' WHERE episode_id = 'ep-002'",
    ).run();
    const afterCorrupt = listChapterSummaries(PID);
    expect(afterCorrupt.map((r) => r.episodeId)).toEqual(['ep-001', 'ep-003', 'ep-na']);
  });

  it('resetWorldState 事务内清全 checkpoint + chapter summary（重跑提取后由物化重建）', () => {
    const db = getDb();
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(PID) as { n: number }).n;
    expect(count('closure_world_checkpoint')).toBeGreaterThan(0);
    expect(count('closure_chapter_summary')).toBeGreaterThan(0);

    resetWorldState(PID);

    expect(count('closure_world_checkpoint')).toBe(0);
    expect(count('closure_chapter_summary')).toBe(0);
    // 6.6 既有语义不回归：patches/slices 清空、subject 身份保留。
    expect(listWorldPatches(PID)).toEqual([]);
    expect(listWorldSlices(PID)).toEqual([]);
    expect(listWorldSlices(PID, { episodeId: 'ep-005' })).toEqual([]);
    // 空 db 上 checkpointed reduce 仍正确（miss → 空 fold）。
    const empty = reduceWorldSubjectCheckpointed(PID, 'erina', undefined, { writeCheckpoint: false });
    expect(empty.checkpointHit).toBe(false);
    expect(empty.state).toEqual({});
    expect(empty.issueCount).toBe(0);
  });

  it('upsertChapterSummaryWithCheckpoints + getWorldPatchRowidHigh：Step 3 落盘路径真 db round-trip', () => {
    // 前测已 reset（空库）——本测聚焦 Step 3 组合落盘路径（materialize handler 的 repo 依赖）。
    insertWorldSlice(
      PID,
      { id: 'cpw:100', storyTime: 100, title: '登场', episodeId: 'ep-cpw' },
      [{ subjectId: 'cpw-hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
      [{ id: 'cpw-hero', type: 'character', firstSeenStoryTime: 100 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'cpw:200', storyTime: 200, title: '受伤', episodeId: 'ep-cpw' },
      [{ subjectId: 'cpw-hero', path: '/hp', op: 'increment', value: -20, axis: 'physical' }],
      [],
      'derived',
    );

    // rowid 水印 helper：subject + at 收窄单调（t=100 窗 1 条 < t=200 窗 2 条 ≤ 全量）。
    const highAt100 = getWorldPatchRowidHigh(PID, 'cpw-hero', 100);
    const highAt200 = getWorldPatchRowidHigh(PID, 'cpw-hero', 200);
    const highAll = getWorldPatchRowidHigh(PID);
    expect(highAt100).toBeGreaterThan(0);
    expect(highAt200).toBeGreaterThan(highAt100);
    expect(highAll).toBeGreaterThanOrEqual(highAt200);

    // 组合事务：summary + checkpoint 批一次落（内部嵌套 transaction → savepoint，better-sqlite3 语义；
    // 水印取 at=200 全窗值——belt 校验通过）。
    upsertChapterSummaryWithCheckpoints(
      PID,
      {
        episodeId: 'ep-cpw',
        episodeIndex: 9,
        storyTimeEnd: 200,
        summary: {
          episodeId: 'ep-cpw',
          episodeIndex: 9,
          storyTimeStart: 100,
          storyTimeEnd: 200,
          characterEndStates: [{ subjectId: 'cpw-hero', type: 'character', state: { hp: 80 } }],
          oracleDormant: [],
          relationshipChanges: [],
          foreshadowChanges: [],
          newEntities: [],
          openPromises: [],
          nextChapterPayoffs: [],
          truncated: false,
        },
        tokenEstimate: 33,
        truncated: false,
        patchRowidHigh: highAll,
      },
      [
        {
          subjectId: 'cpw-hero',
          atStoryTime: 200,
          state: { hp: 80 },
          issueCount: 0,
          patchRowidHigh: highAt200,
          patchCountFolded: 2,
        },
      ],
    );

    // 两侧都落了 + belt 校验过（水印取全窗精确值 → checkpoint 可用）。
    const rows = listChapterSummaries(PID, { episodeIds: ['ep-cpw'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary.characterEndStates[0]?.state).toEqual({ hp: 80 });
    const ckpt = getLatestWorldCheckpoint(PID, 'cpw-hero', 200);
    expect(ckpt?.state).toEqual({ hp: 80 });
    expect(ckpt?.patchCountFolded).toBe(2);
    expect(ckpt?.patchRowidHigh).toBe(highAt200);
  });
});
