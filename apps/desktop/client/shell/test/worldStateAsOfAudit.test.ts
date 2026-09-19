import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCognitionSnapshot, buildPresenceSignal } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 C1/C2（design §3.1 路径 1/2/3/5 + §3.2 INV-1/INV-5）：as-of 全路径
// 审计——真 better-sqlite3（真表 + 真 SQL at 截断 + 真 fold），mirror
// worldStateCheckpoint.test.ts / worldStateBackfillSummary.test.ts 套路：
// - `@orison/desktop-local-bff` loadProject：materialize 三源给合成 doc（免写盘）。
// - 其余真链（insertWorldSlice / listWorldPatches(at) / buildWorldSnapshotCheckpointed /
//   materializeChapterSummaryCore）。
//
// 审计面：
// - 路径 1（state 投影 buildWorldSnapshotCheckpointed）：未来 storyTime patch +
//   未来登记 subject 查过去切点不进；倒叙 slice（后插入、storyTime 更早）必进。
// - 路径 2（cognition 投影）：经 listWorldPatches(at)——倒叙 fixture 必含 + 未来排除
//   + INV-1 真 db 面（cognition characters ⊆ closure_world_subject）。
// - 路径 3（presence 投影）：per-patch at（reduce 截断在 c.storyTime）——认知发生后
//   挪场不回灌；handler 侧 build_world_snapshot {projection} 胶水锚在
//   worldStateHandlers.test.ts（listWorldPatches(at) + 纯投影同款调用）。
// - 路径 5（章摘要 materializeChapterSummaryCore as-of-N）：表内已有 index > N 的
//   slices 时物化 N 章活动归类不含未来章——真 db 版（handler mock 版锚：
//   worldStateHandlers.test.ts「CR-4 as-of-N 截断」）+ INV-5 窗对拍。
//
// 不变量清单权威源：packages/shared-contracts/tests/as-of-invariants.test.ts
// `INVARIANT_LIST`（INV id 进测试标题）。
//
// Electron-as-Node 真跑（plain-Node vitest 下本 suite 被 ABI gate skip）：
//   cd apps/desktop/client/shell
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/worldStateAsOfAudit.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-world-asof-audit');

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

// dogfood #104-b：真跑 materializeChapterSummaryCore 会兜底到 resolveEmbeddingModel →
// defaultEmbedBatch 真打 embed 端点（401 实录）。mock 模型解析层（逐字 mirror
// chapterSummaryHookWiring.test.ts:22-29）：null 短路 embed 块，FTS-only 降级语义不变。
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

const { loadProject } = vi.hoisted(() => ({ loadProject: vi.fn() }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import { closeDb, getDb } from '../main/db/index';
import {
  buildWorldSnapshotCheckpointed,
  insertWorldSlice,
  listChapterSummaries,
  listWorldPatches,
  listWorldSlices,
  listWorldSubjects,
} from '../main/db/worldStateRepository';
import { materializeChapterSummaryCore } from '../main/db/worldStateMaterialize';

// better-sqlite3 ABI gate（mirror worldStateCheckpoint.test.ts）：skip 而非 fail。
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
const PID = '00008';
const PROJECT_DIR = '/proj/asof-audit'; // loadProject 已 mock——只作透传标记。

describe.skipIf(!sqliteUsable)('as-of 审计：state 投影 buildWorldSnapshotCheckpointed（C1 路径 1）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();

    // 插入序故意与 storyTime 序错开：先 t=100，再 t=200（未来），最后补 t=50（倒叙前史）。
    insertWorldSlice(
      PID,
      { id: 'ep-301:100', storyTime: 100, title: '登场', episodeId: 'ep-301' },
      [{ subjectId: 'erina', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
      [{ id: 'erina', type: 'character', name: '艾莉娜', firstSeenStoryTime: 100 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-302:200', storyTime: 200, title: '苦战', episodeId: 'ep-302' },
      [{ subjectId: 'erina', path: '/hp', op: 'increment', value: -30, axis: 'physical' }],
      [],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-300:50', storyTime: 50, title: '前史', episodeId: 'ep-300' },
      [{ subjectId: 'erina', path: '/title', op: 'replace', value: '前史幸存者', axis: 'physical' }],
      [],
      'derived',
    );
    // 未来登记 subject（storyTime 300 章）——查过去切点不得进 subject 收集。
    insertWorldSlice(
      PID,
      { id: 'ep-303:300', storyTime: 300, title: '新章', episodeId: 'ep-303' },
      [{ subjectId: 'raven', path: '/hp', op: 'replace', value: 50, axis: 'physical' }],
      [{ id: 'raven', type: 'character', name: '渡鸦', firstSeenStoryTime: 300 }],
      'derived',
    );
  });
  afterAll(clean);

  it('查过去切点 at=150：未来 patch（t=200 hp-30）与未来 subject（raven@300）都不进；倒叙 slice（后插入 t=50）必进', () => {
    const snap = buildWorldSnapshotCheckpointed(PID, 150);
    expect(snap.at).toBe(150);
    // subject 收集截断：first_seen_story_time <= 150——raven（300）不进。
    expect(snap.subjects.map((s) => s.subjectId)).toEqual(['erina']);
    const erina = snap.subjects[0];
    // fold 截断：t=200 的 increment 不进（hp 仍 100）；倒叙 t=50 的 title 进（后插入不丢）。
    expect(erina.state).toMatchObject({ hp: 100, title: '前史幸存者' });
  });

  it('对照：at 缺省（最新）——未来数据全进（hp 70 + raven 入列），证上例排除确因 at 截断', () => {
    const snap = buildWorldSnapshotCheckpointed(PID, undefined);
    expect(snap.at).toBeUndefined();
    expect(snap.subjects.map((s) => s.subjectId).sort()).toEqual(['erina', 'raven']);
    expect(snap.subjects.find((s) => s.subjectId === 'erina')?.state).toMatchObject({ hp: 70 });
  });
});

describe.skipIf(!sqliteUsable)('as-of 审计：cognition 投影 flashback（C1 路径 2 + INV-1 真 db 面）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();

    // 插入序：先写 t=300（后段揭示），后补 t=100（倒叙/前史揭示）——
    // listWorldPatches(at) 按 slice.story_time 截断，与插入序（rowid）无关。
    insertWorldSlice(
      PID,
      { id: 'ep-401:300', storyTime: 300, title: '后段', episodeId: 'ep-401' },
      [{ subjectId: 'sage', path: '/knows/秘密Z', op: 'replace', value: true, axis: 'cognitive' }],
      [{ id: 'sage', type: 'character', name: '贤者', firstSeenStoryTime: 300 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-400:100', storyTime: 100, title: '前史', episodeId: 'ep-400' },
      [{ subjectId: 'sage', path: '/knows/秘密X', op: 'replace', value: true, axis: 'cognitive' }],
      [],
      'derived',
    );
  });
  afterAll(clean);

  it('查过去切点 at=150：倒叙 patch（后插入 t=100）必含、未来（t=300）不进——fold 按 storyTime 非插入序', () => {
    const patches = listWorldPatches(PID, undefined, 150);
    // SQL 截断面：只剩 t=100 一条（后插入的倒叙）。
    expect(patches.map((p) => [p.storyTime, p.path])).toEqual([[100, '/knows/秘密X']]);

    const snapshot = buildCognitionSnapshot(patches);
    expect(snapshot).toBeDefined();
    const sage = snapshot?.characters.find((c) => c.characterSubjectId === 'sage');
    expect(sage?.facts.map((f) => f.path)).toEqual(['/knows/秘密X']);
  });

  it('INV-1 真 db 面：cognition characters ⊆ closure_world_subject（跨表对拍）', () => {
    // at 缺省（全量 cognition）——characters 必在世界账 subject 表内。
    const snapshot = buildCognitionSnapshot(listWorldPatches(PID));
    const worldSubjectIds = new Set(listWorldSubjects(PID).map((s) => s.id));
    expect(worldSubjectIds.has('sage')).toBe(true);
    for (const c of snapshot?.characters ?? []) {
      expect(worldSubjectIds.has(c.characterSubjectId)).toBe(true);
    }
  });
});

describe.skipIf(!sqliteUsable)('as-of 审计：presence 投影 per-patch at（C1 路径 3）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();

    // scout：t=50 在集市 → t=100 认知密信（揭露场 s_reveal）→ t=200 才挪到宫殿。
    // 认知发生时刻（100）的在场场应是 s_market——t=200 的 presence 是「之后挪场」，
    // 不得回灌进 @100 的 reduce。
    insertWorldSlice(
      PID,
      { id: 'ep-500:50', storyTime: 50, title: '集市', episodeId: 'ep-500' },
      [{ subjectId: 'scout', path: '/presence_scene', op: 'replace', value: 's_market', axis: 'physical' }],
      [{ id: 'scout', type: 'character', name: '斥候', firstSeenStoryTime: 50 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-500:100', storyTime: 100, title: '窥信', episodeId: 'ep-500' },
      [
        {
          subjectId: 'scout',
          path: '/knows/密信',
          op: 'replace',
          value: true,
          axis: 'cognitive',
          evidenceSceneId: 's_reveal',
        },
      ],
      [],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-501:200', storyTime: 200, title: '宫殿', episodeId: 'ep-501' },
      [{ subjectId: 'scout', path: '/presence_scene', op: 'replace', value: 's_palace', axis: 'physical' }],
      [],
      'derived',
    );
    // porter：恰在揭露场——非可疑（≠ 才产信号的正控制）。
    insertWorldSlice(
      PID,
      { id: 'ep-500:50b', storyTime: 50, title: '门房', episodeId: 'ep-500' },
      [{ subjectId: 'porter', path: '/presence_scene', op: 'replace', value: 's_reveal', axis: 'physical' }],
      [{ id: 'porter', type: 'character', name: '门房', firstSeenStoryTime: 50 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-500:100b', storyTime: 100, title: '在场听闻', episodeId: 'ep-500' },
      [
        {
          subjectId: 'porter',
          path: '/knows/密令',
          op: 'replace',
          value: true,
          axis: 'cognitive',
          evidenceSceneId: 's_reveal',
        },
      ],
      [],
      'derived',
    );
  });
  afterAll(clean);

  it('at=150 查询：signal.presenceSceneId = s_market（认知时刻的在场场）；未来 t=200 挪场不在', () => {
    const signals = buildPresenceSignal(listWorldPatches(PID, undefined, 150));
    expect(signals.map((s) => s.characterSubjectId)).toEqual(['scout']);
    expect(signals[0]).toMatchObject({
      characterSubjectId: 'scout',
      evidenceSceneId: 's_reveal',
      storyTime: 100,
      presenceSceneId: 's_market',
    });
  });

  it('更严：全量 patches（含 t=200）入投影——reduce 截断在 c.storyTime=100，之后挪场仍不回灌', () => {
    const signals = buildPresenceSignal(listWorldPatches(PID));
    expect(signals.map((s) => s.characterSubjectId)).toEqual(['scout']);
    expect(signals[0]?.presenceSceneId).toBe('s_market');
  });
});

describe.skipIf(!sqliteUsable)('as-of 审计：章摘要 materialize as-of-N 真链（C1 路径 5 + INV-5）', () => {
  function makeDoc(): Record<string, unknown> {
    return {
      episode_outlines: [
        { id: 'ep-201', index: 0, title: '一章' },
        { id: 'ep-202', index: 1, title: '二章' },
        { id: 'ep-203', index: 2, title: '三章' },
      ],
      promise_registry: { promises: [], beats: [] },
      scene_graph: { nodes: [] },
    };
  }

  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();

    // ep-201（idx 0）：hero 登场。ep-202（idx 1，本章）：hero 伤 + bob 登场 + bob 关系
    // 变化。ep-203（idx 2，未来章）：raven 登场——物化 ep-202 时表内已有它。
    insertWorldSlice(
      PID,
      { id: 'ep-201:100', storyTime: 100, title: '一章', episodeId: 'ep-201' },
      [{ subjectId: 'hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
      [{ id: 'hero', type: 'character', name: '主角', firstSeenStoryTime: 100 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-202:200', storyTime: 200, title: '二章', episodeId: 'ep-202' },
      [
        { subjectId: 'hero', path: '/hp', op: 'increment', value: -30, axis: 'physical' },
        { subjectId: 'bob', path: '/hp', op: 'replace', value: 80, axis: 'physical' },
        {
          subjectId: 'bob',
          path: '/关系/hero',
          op: 'replace',
          value: '决裂',
          axis: 'relational',
          summary: '摊牌后决裂',
        },
      ],
      [{ id: 'bob', type: 'character', name: '鲍勃', firstSeenStoryTime: 200 }],
      'derived',
    );
    insertWorldSlice(
      PID,
      { id: 'ep-203:300', storyTime: 300, title: '三章', episodeId: 'ep-203' },
      [{ subjectId: 'raven', path: '/hp', op: 'replace', value: 50, axis: 'physical' }],
      [{ id: 'raven', type: 'character', name: '渡鸦', firstSeenStoryTime: 300 }],
      'derived',
    );
  });
  afterAll(clean);

  beforeEach(() => {
    loadProject.mockReset();
    loadProject.mockReturnValue(makeDoc());
  });

  it('表内已有 index > N slices：物化 ep-202 活动归类不含未来章（raven 零出现）——真 db 版 CR-4', async () => {
    const { summary } = await materializeChapterSummaryCore(PID, PROJECT_DIR, 'ep-202');

    expect(summary.episodeIndex).toBe(1);
    expect(summary.storyTimeStart).toBe(200);
    expect(summary.storyTimeEnd).toBe(200);

    // cast = 本章与前两章（idx >= n-2 = -1）内有 patch 者：hero(0)/bob(1)。
    // raven 全部活动在 ep-203（idx 2 > 1）——as-of-N 截断，不进任何归类。
    const castIds = summary.characterEndStates.map((c) => c.subjectId);
    expect(castIds).toEqual(['bob', 'hero']); // 同 lastActive idx → id 序
    expect(castIds).not.toContain('raven');

    // ④ 新实体：firstSeen ∈ [200,200] = bob；raven（300）是未来登场不进。
    expect(summary.newEntities.map((n) => n.subjectId)).toEqual(['bob']);
    expect(JSON.stringify(summary)).not.toContain('raven');
  });

  it('INV-5 真 db 面：②关系变化 + ④新实体 ⊆ 本章窗内 patch 涉及主体（跨章零泄漏）', async () => {
    const { summary } = await materializeChapterSummaryCore(PID, PROJECT_DIR, 'ep-202');

    // 本章窗 = ep-202 归属 slices 的 patches（worldSliceEpisodeId 单源归类）。
    const chapterSlices = listWorldSlices(PID, { episodeId: 'ep-202', withPatches: true });
    const windowSubjects = new Set(chapterSlices.flatMap((s) => (s.patches ?? []).map((p) => p.subjectId)));
    expect(windowSubjects).toEqual(new Set(['hero', 'bob']));

    for (const rc of summary.relationshipChanges) {
      expect(windowSubjects.has(rc.subjectId)).toBe(true);
    }
    expect(summary.relationshipChanges).toHaveLength(1);
    expect(summary.relationshipChanges[0]).toMatchObject({ subjectId: 'bob', storyTime: 200 });
    for (const ne of summary.newEntities) {
      expect(windowSubjects.has(ne.subjectId)).toBe(true);
    }
  });

  it('落表 round-trip：listChapterSummaries 读回 ep-202 行（episodeIndex=1）', async () => {
    await materializeChapterSummaryCore(PID, PROJECT_DIR, 'ep-202');
    const rows = listChapterSummaries(PID, { episodeIds: ['ep-202'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].episodeIndex).toBe(1);
    expect(rows[0].storyTimeEnd).toBe(200);
  });
});
