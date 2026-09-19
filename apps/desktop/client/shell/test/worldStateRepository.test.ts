import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror closureSchema.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-world-state-repo');

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
import { queryMentionLedger, upsertEpisodeMentions } from '../main/db/mentionLedgerRepository';
import {
  findWorldRefs,
  getWorldSubject,
  insertWorldSlice,
  listWorldPatches,
  listWorldSlices,
  listWorldSubjects,
  reduceWorldSubject,
  resetWorldState,
  upsertWorldSubject,
} from '../main/db/worldStateRepository';
import {
  buildCognitionSnapshot,
  buildPresenceSignal,
  type WorldPatchInput,
} from '@orison/shared-contracts';

// better-sqlite3 ABI gate (mirror closureSchema.test.ts): skip the SQL suite
// instead of failing when the native addon cannot load under plain-Node vitest.
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

// All Story 6.6 tests share one project id; the composite subject PK keeps
// subjects isolated per project even when ids are reused across suites.
const PID = '00001';

describe.skipIf(!sqliteUsable)('worldStateRepository (Story 6.6 Phase B)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('creates the 3 closure_world_* tables + 3 indexes on initSchema', () => {
    const db = getDb();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(tables.has('closure_world_subject')).toBe(true);
    expect(tables.has('closure_world_slice')).toBe(true);
    expect(tables.has('closure_world_patch')).toBe(true);

    const indexes = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(indexes.has('idx_closure_world_patch_proj_sub_time')).toBe(true);
    expect(indexes.has('idx_closure_world_slice_proj_time')).toBe(true);
    expect(indexes.has('idx_closure_world_subject_proj_type')).toBe(true);
  });

  it('upsertWorldSubject is idempotent + getWorldSubject/listWorldSubjects read back', () => {
    upsertWorldSubject(PID, {
      id: 'erina',
      type: 'character',
      name: '艾莉娜',
      firstSeenStoryTime: 100,
    });
    // second upsert refreshes name, keeps id stable (composite PK)
    upsertWorldSubject(PID, {
      id: 'erina',
      type: 'character',
      name: '艾莉娜·改',
      firstSeenStoryTime: 100,
    });
    const got = getWorldSubject(PID, 'erina');
    expect(got?.name).toBe('艾莉娜·改');
    expect(got?.type).toBe('character');

    upsertWorldSubject(PID, { id: 'sword-01', type: 'item', firstSeenStoryTime: 100 });
    const all = listWorldSubjects(PID);
    expect(all.map((s) => s.id).sort()).toEqual(['erina', 'sword-01']);
    const chars = listWorldSubjects(PID, 'character');
    expect(chars.map((s) => s.id)).toEqual(['erina']);
  });

  it('insertWorldSlice writes slice+patches+subjects in one txn; patches get storyTime/source injected', () => {
    // /inventory 先 replace [] 建基准再 append（Story 8.1 fixture 漂移修——现行 reduce 语义 append 缺基准
    // → broken-relative 跳过是正确行为；原 fixture 无基准，后续 reduce 断言漂移）。
    insertWorldSlice(
      PID,
      { id: 'slice-100', storyTime: 100, title: '艾莉娜转生', kind: 'event' },
      [
        { subjectId: 'erina', path: '/hp', op: 'replace', value: 100, axis: 'physical' },
        { subjectId: 'erina', path: '/location', op: 'replace', value: 'subject://altar', axis: 'physical' },
        { subjectId: 'erina', path: '/inventory', op: 'replace', value: [], axis: 'physical' },
        { subjectId: 'erina', path: '/inventory', op: 'append', value: 'subject://sword-01', axis: 'physical' },
      ],
      [{ id: 'erina', type: 'character', name: '艾莉娜', firstSeenStoryTime: 100 }],
      'derived',
    );

    const patches = listWorldPatches(PID, 'erina');
    expect(patches).toHaveLength(4);
    // storyTime反范式自 slice（patch 表无 story_time 列，JOIN slice 填充）。
    expect(patches.every((p) => p.storyTime === 100)).toBe(true);
    // source 注入为 derived（handler 强制，patches 输入无 source）。
    expect(patches.every((p) => p.source === 'derived')).toBe(true);
    // value JSON 列 round-trip（/inventory 有 replace [] 基准 + append 两条，验 append 那条）。
    const hp = patches.find((p) => p.path === '/hp');
    expect(hp?.value).toBe(100);
    const inv = patches.find((p) => p.path === '/inventory' && p.op === 'append');
    expect(inv?.value).toBe('subject://sword-01');
  });

  it('reduceWorldSubject reduce出 subject 状态（replace + append + increment + attrs 投影）', () => {
    // 追加一条 increment（在 slice-100 之后）+ 一条 events append（list 追加语义）。
    // /events 同 /inventory：先 replace [] 建基准再 append（append 缺基准 → broken-relative 是正确语义）。
    insertWorldSlice(
      PID,
      { id: 'slice-200', storyTime: 200, title: '受伤' },
      [
        { subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical', summary: '受伤' },
        { subjectId: 'erina', path: '/events', op: 'replace', value: [], axis: 'cognitive' },
        { subjectId: 'erina', path: '/events', op: 'append', value: { text: '被伏击' }, axis: 'cognitive' },
      ],
      [],
      'derived',
    );

    // 最新状态：hp 70（100-30）、location、inventory[1]、events[1]。
    const latest = reduceWorldSubject(PID, 'erina');
    expect(latest.state.hp).toBe(70);
    expect(latest.state.location).toBe('subject://altar');
    expect(latest.state.inventory).toEqual(['subject://sword-01']);
    expect((latest.state.events as unknown[]).length).toBe(1);
    expect(latest.issues).toEqual([]);

    // at=150 截断：slice-200 不参与，hp 仍 100。
    const at150 = reduceWorldSubject(PID, 'erina', 150);
    expect(at150.state.hp).toBe(100);
    expect(at150.state.events).toBeUndefined();

    // attrs 投影：只要 hp + location，issues 也跟随收窄。
    const projected = reduceWorldSubject(PID, 'erina', undefined, { attrs: ['hp', 'location'] });
    expect(Object.keys(projected.state).sort()).toEqual(['hp', 'location']);
  });

  it('reduce increment 缺基准 → broken-relative issue（patch 被跳过，不污染 state）', () => {
    insertWorldSlice(
      PID,
      { id: 'slice-250', storyTime: 250, title: '无基准 increment' },
      [{ subjectId: 'no-base', path: '/mana', op: 'increment', value: 5, axis: 'physical' }],
      [{ id: 'no-base', type: 'character', firstSeenStoryTime: 250 }],
      'derived',
    );
    const result = reduceWorldSubject(PID, 'no-base');
    // mana 没有前置 replace → increment 缺基准 → issue，state 无 mana。
    expect(result.state.mana).toBeUndefined();
    expect(result.issues.some((i) => i.code === 'broken-relative' && i.path === '/mana')).toBe(true);
  });

  it('amendment 覆盖层叠加在 derived 之上（同 storyTime amendment 后于 derived）', () => {
    // 在 slice-200 同 storyTime=200 写 amendment 修正 hp（derived hp=70 → amendment 改 50）。
    insertWorldSlice(
      PID,
      { id: 'slice-200-amend', storyTime: 200, title: '修正 hp' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 50, axis: 'physical', summary: '修补：应为 50' }],
      [],
      'amendment',
    );
    const result = reduceWorldSubject(PID, 'erina');
    expect(result.state.hp).toBe(50); // amendment replace 覆盖 derived increment 结果
    // 仍是 derived + amendment 两层全 reduce（amendment 不删 derived）。
    const patches = listWorldPatches(PID, 'erina');
    expect(patches.some((p) => p.source === 'amendment')).toBe(true);
  });

  it('insertWorldSlice per-slice idempotency：同 slice.id 重写替换 patches，不重复累积', () => {
    // slice-200 此前有 2 条 derived（hp inc -30 + events append）；slice-200-amend 有 1 条 amendment。
    const slice200Before = listWorldPatches(PID).filter((p) => p.sliceId === 'slice-200');
    expect(slice200Before.length).toBeGreaterThan(1);
    const amendBefore = listWorldPatches(PID).filter(
      (p) => p.sliceId === 'slice-200-amend',
    );
    expect(amendBefore).toHaveLength(1);

    // 重写 slice-200（不同 patches——只 1 条）。
    insertWorldSlice(
      PID,
      { id: 'slice-200', storyTime: 200, title: '受伤（重写）' },
      [{ subjectId: 'erina', path: '/hp', op: 'increment', value: -10, axis: 'physical' }],
      [],
      'derived',
    );

    // slice-200 旧 derived patches 全删，只留新写的 1 条（替换非累积）。
    const slice200After = listWorldPatches(PID).filter((p) => p.sliceId === 'slice-200');
    expect(slice200After).toHaveLength(1);
    expect(slice200After[0].value).toBe(-10);
    // slice-200-amend 不受影响（不同 slice.id，amendment 保留）。
    const amendAfter = listWorldPatches(PID).filter((p) => p.sliceId === 'slice-200-amend');
    expect(amendAfter).toHaveLength(1);
    expect(amendAfter[0].source).toBe('amendment');
  });

  it('CR-1: source=derived 写时清全 source（同 slice.id 的 amendment 同步清零，design §2 重跑语义）', () => {
    // 准备：slice-cr1 先写 amendment（hp replace 999），再写 derived。
    insertWorldSlice(
      PID,
      { id: 'slice-cr1', storyTime: 800, title: 'CR-1 初始 amendment' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 999, axis: 'physical', summary: '修补' }],
      [],
      'amendment',
    );
    // 此时 slice-cr1 有 1 amendment（hp=999）。
    expect(listWorldPatches(PID).filter((p) => p.sliceId === 'slice-cr1')).toHaveLength(1);

    // 重写 slice-cr1 写 derived（重提取）——CR-1：derived 写时删全 source，amendment 清零。
    insertWorldSlice(
      PID,
      { id: 'slice-cr1', storyTime: 800, title: 'CR-1 重提取 derived' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 50, axis: 'physical' }],
      [],
      'derived',
    );

    const after = listWorldPatches(PID).filter((p) => p.sliceId === 'slice-cr1');
    expect(after).toHaveLength(1);
    expect(after[0].source).toBe('derived');
    expect(after[0].value).toBe(50);
    // amendment 已清零（重提取 derived 从 prose 重建，修补临时性依附当时派生快照，design §2）。
    expect(after.some((p) => p.source === 'amendment')).toBe(false);
  });

  it('CR-1: source=amendment 写时只删 amendment（保 derived，re-amend 不碰派生层）', () => {
    // 准备：slice-cr1b 先写 derived（hp replace 50），再写 amendment。
    insertWorldSlice(
      PID,
      { id: 'slice-cr1b', storyTime: 810, title: 'CR-1b 初始 derived' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 50, axis: 'physical' }],
      [],
      'derived',
    );
    // 首次 amendment（hp replace 70）。
    insertWorldSlice(
      PID,
      { id: 'slice-cr1b', storyTime: 810, title: 'CR-1b 首次 amend' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 70, axis: 'physical', summary: '修补1' }],
      [],
      'amendment',
    );
    // re-amend（hp replace 80）——CR-1：amendment 写时只删 amendment（保 derived）。
    insertWorldSlice(
      PID,
      { id: 'slice-cr1b', storyTime: 810, title: 'CR-1b re-amend' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 80, axis: 'physical', summary: '修补2' }],
      [],
      'amendment',
    );

    const after = listWorldPatches(PID).filter((p) => p.sliceId === 'slice-cr1b');
    // derived 保留 + 最新 amendment（1 derived + 1 amendment，旧 amendment 替换非累积）。
    expect(after.filter((p) => p.source === 'derived')).toHaveLength(1);
    expect(after.filter((p) => p.source === 'amendment')).toHaveLength(1);
    const amend = after.find((p) => p.source === 'amendment')!;
    expect(amend.value).toBe(80);
    // derived 层未被碰（hp=50）。
    const derived = after.find((p) => p.source === 'derived')!;
    expect(derived.value).toBe(50);
  });

  it('listWorldSlices 收窄 subjectIds/type/at + withPatches', () => {
    const allSlices = listWorldSlices(PID);
    expect(allSlices.length).toBeGreaterThanOrEqual(4);

    const erinaSlices = listWorldSlices(PID, { subjectIds: ['erina'] });
    expect(erinaSlices.every((s) => s.storyTime !== undefined)).toBe(true);

    const charSlices = listWorldSlices(PID, { type: 'character' });
    // no-base 也是 character；erina slices 全 character。
    expect(charSlices.length).toBeGreaterThanOrEqual(erinaSlices.length);

    const withPatches = listWorldSlices(PID, { subjectIds: ['erina'], withPatches: true });
    expect(withPatches.some((s) => (s.patches ?? []).length > 0)).toBe(true);

    const at150 = listWorldSlices(PID, { at: 150 });
    expect(at150.every((s) => s.storyTime <= 150)).toBe(true);
  });

  it('findWorldRefs 反查引用（LIKE 预筛 + 精确匹配，不误匹配前缀）', () => {
    // 新增一个引用 subject://sword-01 的 patch + 一个前缀诱饵 subject://sword-011。
    insertWorldSlice(
      PID,
      { id: 'slice-300', storyTime: 300, title: '装备剑' },
      [
        { subjectId: 'erina', path: '/equipment/weapon', op: 'replace', value: 'subject://sword-01', axis: 'physical' },
        { subjectId: 'erina', path: '/trophy', op: 'replace', value: 'subject://sword-011', axis: 'physical' },
      ],
      [],
      'derived',
    );

    const refs = findWorldRefs(PID, 'sword-01');
    // 2 命中（Story 8.1 fixture 漂移修——slice-100 的 /inventory append patch 存储后即含
    // subject://sword-01，反查命中它是合法行为）：/inventory（slice-100）+ /equipment/weapon（slice-300）。
    // 不含 trophy（subject://sword-011 前缀诱饵，LIKE 预筛命中但精确匹配排除）。
    expect(refs).toHaveLength(2);
    const paths = refs.map((r) => r.path).sort();
    expect(paths).toEqual(['/equipment/weapon', '/inventory']);
    const weapon = refs.find((r) => r.path === '/equipment/weapon')!;
    expect(weapon.subjectId).toBe('erina');
    expect(weapon.value).toBe('subject://sword-01');
  });

  it('resetWorldState 删 patches+slices，保留 subject 身份（+ Story 8.7 mention 账级联清理）', () => {
    // Story 8.7：播种 mention 行验级联（patches/slices 全删 → 通道依据清零 → 账行保守清）。
    upsertEpisodeMentions(PID, 'slice-100', [
      { entryId: 'card-a', presence: 'present', declared: 1, presenceShot: 1, coarseHit: 0, planLinked: 0, coarseCount: 0, stateChanged: 1, source: 'full' },
    ]);
    const beforeSubjects = listWorldSubjects(PID);
    expect(beforeSubjects.length).toBeGreaterThan(0);
    resetWorldState(PID);
    // patches + slices 清空。
    expect(listWorldPatches(PID)).toEqual([]);
    expect(listWorldSlices(PID)).toEqual([]);
    // subject 身份保留（subject-lifecycle §6 稳定登记）。
    expect(listWorldSubjects(PID).length).toBe(beforeSubjects.length);
    // Story 8.7：mention 账全清（DERIVED——重提取后下次写章重收 / rebuild 重扫重建）。
    expect(queryMentionLedger(PID, { episodeId: 'slice-100' })).toEqual([]);
  });

  it('listWorldPatches/listWorldSlices axis filter（Story 6.4 D4 / 6.1 DW：单轴查询不扫全轴）', () => {
    insertWorldSlice(
      PID,
      { id: 'slice-axis', storyTime: 300, title: '多轴测试' },
      [
        { subjectId: 'axis-char', path: '/hp', op: 'replace', value: 80, axis: 'physical' },
        { subjectId: 'axis-char', path: '/knows/秘密', op: 'replace', value: true, axis: 'cognitive' },
        { subjectId: 'axis-char', path: '/believes/国王', op: 'replace', value: '忠诚', axis: 'cognitive' },
      ],
      [{ id: 'axis-char', type: 'character', name: '轴测角色', firstSeenStoryTime: 300 }],
      'derived',
    );
    // listWorldPatches axis filter：cognitive 只 2 条（不含 physical hp）。
    const cognitive = listWorldPatches(PID, 'axis-char', undefined, 'cognitive');
    expect(cognitive).toHaveLength(2);
    expect(cognitive.every((p) => p.axis === 'cognitive')).toBe(true);
    // 不传 axis → 全轴 3 条（向后兼容，缺省不过滤）。
    expect(listWorldPatches(PID, 'axis-char', undefined)).toHaveLength(3);
    // listWorldSlices axis filter：withPatches 时 patches 只取该轴。
    const sliceNoFilter = listWorldSlices(PID, { withPatches: true }).find((s) => s.id === 'slice-axis');
    expect(sliceNoFilter?.patches).toHaveLength(3);
    const sliceCognitive = listWorldSlices(PID, { withPatches: true, axis: 'cognitive' }).find(
      (s) => s.id === 'slice-axis',
    );
    expect(sliceCognitive?.patches).toHaveLength(2);
    expect(sliceCognitive?.patches?.every((p) => p.axis === 'cognitive')).toBe(true);
  });

  it('listWorldPatches 多轴 IN（Story 8.3 S5）+ cognition/presence 投影 SQL 轴预过滤对拍等价', () => {
    // 独立 project（与上文 slice 隔离）；多轴混合 + evidenceSceneId（presence 对拍臂需要）。
    const P = '00088';
    const mk = (
      subjectId: string,
      path: string,
      axis: WorldPatchInput['axis'],
      extra: Partial<WorldPatchInput> = {},
    ): WorldPatchInput => ({ subjectId, path, op: 'replace', value: true, axis, ...extra });
    insertWorldSlice(
      P,
      { id: 'ep-x:10', storyTime: 10, title: 't', episodeId: 'ep-x' },
      [
        // s1：在场场 ≠ 证据场 → presence 信号应命中 1 条。
        mk('s1', '/knows/秘密', 'cognitive', { evidenceSceneId: 'scene-a' }),
        mk('s1', '/presence_scene', 'physical', { value: 'scene-hall' }),
        mk('s1', '/hp', 'physical'),
        // s2：在场场 = 证据场 → 无信号（负例，防「全命中」假对拍）。
        mk('s2', '/knows/真相', 'cognitive', { evidenceSceneId: 'scene-b' }),
        mk('s2', '/presence_scene', 'physical', { value: 'scene-b' }),
        // 关系轴（第三轴）——两投影都不消费，SQL 预过滤的「少拉行」对象。
        mk('s3', '/affinity/s2', 'relational'),
      ],
      [
        { id: 's1', type: 'character', name: '一', firstSeenStoryTime: 10 },
        { id: 's2', type: 'character', name: '二', firstSeenStoryTime: 10 },
        { id: 's3', type: 'group', name: '群', firstSeenStoryTime: 10 },
      ],
      'derived',
    );

    // 多轴 IN：cognitive+physical 全取（6 条中 5 条——relational 不取）；SQL 侧过滤断言（返回行全在轴集内）。
    const twoAxis = listWorldPatches(P, undefined, undefined, ['cognitive', 'physical']);
    expect(twoAxis).toHaveLength(5);
    expect(twoAxis.every((p) => p.axis === 'cognitive' || p.axis === 'physical')).toBe(true);
    // 空数组 = 无过滤（与 undefined 同义）。
    expect(listWorldPatches(P, undefined, undefined, [])).toHaveLength(6);

    // 对拍（axis 传参 vs 全取 + 纯函数内 TS filter——行为等价是 S5 硬门）：
    const all = listWorldPatches(P);
    expect(buildCognitionSnapshot(listWorldPatches(P, undefined, undefined, 'cognitive'))).toEqual(
      buildCognitionSnapshot(all),
    );
    expect(
      buildPresenceSignal(listWorldPatches(P, undefined, undefined, ['cognitive', 'physical'])),
    ).toEqual(buildPresenceSignal(all));
    // 非空 sanity（对拍非空集空等空——s1 在场≠证据应产 1 条信号）。
    expect(buildCognitionSnapshot(listWorldPatches(P, undefined, undefined, 'cognitive'))).toBeDefined();
    expect(
      buildPresenceSignal(listWorldPatches(P, undefined, undefined, ['cognitive', 'physical'])),
    ).toHaveLength(1);
  });

  it('evidenceSceneId round-trip（Story 6.4 D1 #1 CR fix：db 透传不丢）', () => {
    insertWorldSlice(
      PID,
      { id: 'slice-evidence', storyTime: 400, title: '认知 transmit 场' },
      [
        {
          subjectId: 'evid-char',
          path: '/knows/秘密',
          op: 'replace',
          value: true,
          axis: 'cognitive',
          evidenceSceneId: 'scene-reveal',
        },
        { subjectId: 'evid-char', path: '/hp', op: 'replace', value: 100, axis: 'physical' },
      ],
      [{ id: 'evid-char', type: 'character', name: '证据角色', firstSeenStoryTime: 400 }],
      'derived',
    );
    const patches = listWorldPatches(PID, 'evid-char');
    // evidenceSceneId 经 db round-trip 保留（认知 patch）；physical patch 无（undefined）。
    const cognitive = patches.find((p) => p.path === '/knows/秘密');
    expect(cognitive?.evidenceSceneId).toBe('scene-reveal');
    const physical = patches.find((p) => p.path === '/hp');
    expect(physical?.evidenceSceneId).toBeUndefined();
  });
});
