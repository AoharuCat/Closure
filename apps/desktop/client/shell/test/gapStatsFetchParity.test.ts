import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildAppearanceGapStats,
  type ChapterStateSummary,
} from '@orison/shared-contracts';

// Story 8.3 S5（8.7 CR-014）：gap_stats 取数下推对拍——**旧全量组装 vs 新 SQL 聚合投影组装**，
// buildAppearanceGapStats 输出 deep-equal（行为零变化硬门）。旧路径的三个全量 repo 函数
// （listWorldPatches / listChapterSummaries / queryMentionLedger）仍是正式导出（其他消费者在用），
// 本 suite 在同一真 db fixture 上按旧 handler 的取数形态内联组装做基线——synthetic fixture +
// 真 SQL round-trip（testing-discipline：纯函数 fixture 测不出 SQL 形态/JSON 列漂移）。

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-gap-stats-parity');

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
  listChapterSummaries,
  listEpisodeStoryTimeWindows,
  listLastPatchFacts,
  listWorldPatches,
  upsertChapterSummary,
} from '../main/db/worldStateRepository';
import {
  aggregateMentionAppearance,
  queryMentionLedger,
  upsertEpisodeMentions,
  type MentionRowInsert,
} from '../main/db/mentionLedgerRepository';
import { assembleGapStatsInput, resolveAnchorStoryTime } from '../main/ipc/toolHandlers/catalogHandlers';

// better-sqlite3 ABI gate (mirror worldStateRepository.test.ts): skip the SQL
// suite instead of failing when the native addon cannot load under plain-Node
// vitest. Electron-as-Node real-run command (testing-discipline Pattern):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/gapStatsFetchParity.test.ts
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

// ── fixture helpers ──

const PID_FULL = '00091'; // 满配（多实体/多章/窗缺/坏 JSON/并列/ amend）
const PID_EMPTY = '00092'; // 空账
const PID_SOLO = '00093'; // 单实体

function mkSummary(
  storyTimeStart: number | null,
  storyTimeEnd: number | null,
): ChapterStateSummary {
  return {
    episodeId: 'filled-by-caller',
    episodeIndex: 0,
    storyTimeStart,
    storyTimeEnd,
    characterEndStates: [],
    oracleDormant: [],
    relationshipChanges: [],
    foreshadowChanges: [],
    newEntities: [],
    openPromises: [],
    nextChapterPayoffs: [],
    truncated: false,
  };
}

function seedSummary(
  pid: string,
  episodeId: string,
  episodeIndex: number | null,
  storyTimeStart: number | null,
  storyTimeEnd: number | null,
): void {
  upsertChapterSummary(pid, {
    episodeId,
    episodeIndex,
    storyTimeEnd,
    summary: { ...mkSummary(storyTimeStart, storyTimeEnd), episodeId, episodeIndex },
    tokenEstimate: 100,
    truncated: false,
    patchRowidHigh: 0,
  });
}

function ins(entryId: string, over: Partial<MentionRowInsert> = {}): MentionRowInsert {
  return {
    entryId,
    presence: 'present',
    declared: 1,
    presenceShot: 0,
    coarseHit: 1,
    planLinked: 0,
    coarseCount: 1,
    stateChanged: 0,
    source: 'full',
    ...over,
  };
}

/**
 * 旧路径组装（S5 前 handler 形态的逐字镜像，作对拍基线）：全量 patches（含 value JSON）/ 全量章摘要
 * （含六字段 JSON 全文）/ 全量 mention 行 → JS 组装。
 */
function oldGapStatsAssembly(pid: string, entryId?: string) {
  const summaries = listChapterSummaries(pid);
  const windows = summaries.map((s) => ({
    episodeId: s.episodeId,
    storyTimeStart: s.summary?.storyTimeStart ?? null,
    storyTimeEnd: s.storyTimeEnd,
  }));
  const patches = listWorldPatches(pid)
    .filter((p) => (entryId !== undefined ? p.subjectId === entryId : true))
    .map((p) => ({ subjectId: p.subjectId, storyTime: p.storyTime, sliceId: p.sliceId }));
  const anchor = resolveAnchorStoryTime(windows, patches.map((p) => p.storyTime));
  const mentions = queryMentionLedger(pid, entryId !== undefined ? { entryId } : {});
  return { mentions, patches, windows, anchor };
}

/** 对拍断言：锚点相等（含 undefined 态）+ 纯函数输出 deep-equal。 */
function expectParity(pid: string, entryId?: string) {
  const old = oldGapStatsAssembly(pid, entryId);
  const neu = assembleGapStatsInput(pid, entryId !== undefined ? { entryId } : {});
  expect(neu.anchorStoryTime).toBe(old.anchor);
  if (old.anchor === undefined) {
    return { old, neu, oldStats: null, newStats: null };
  }
  const oldStats = buildAppearanceGapStats(old.mentions, old.patches, old.windows, old.anchor);
  const newStats = buildAppearanceGapStats(neu.mentions, neu.patches, neu.windows, neu.anchorStoryTime!);
  expect(newStats).toEqual(oldStats);
  return { old, neu, oldStats, newStats };
}

function seedFullFixture(): void {
  // ── world patches 先种（并列 derived/amend + 多 subject）——insertWorldSlice 的 summary 级联失效
  // 会删后续才写的章摘要行，故顺序：patches → summaries → mentions。 ──
  insertWorldSlice(
    PID_FULL,
    { id: 'ep-9:50', storyTime: 50, title: 't1', episodeId: 'ep-9' },
    [{ subjectId: 'entryB', path: '/hp', op: 'replace', value: 1, axis: 'physical' }],
    [],
    'derived',
  );
  insertWorldSlice(
    PID_FULL,
    { id: 'ep-x:50', storyTime: 50, title: 't2' },
    [{ subjectId: 'entryB', path: '/hp', op: 'replace', value: 2, axis: 'physical' }],
    [],
    'amendment', // 与 derived 并列 t=50 → 旧路径 derived 先迭代胜出（lastEpisodeId 'ep-9'）
  );
  insertWorldSlice(
    PID_FULL,
    { id: 'ep-4:45', storyTime: 45, title: 't3', episodeId: 'ep-4' },
    [{ subjectId: 'entryC', path: '/location', op: 'replace', value: 'x', axis: 'physical' }],
    [],
    'derived',
  );
  insertWorldSlice(
    PID_FULL,
    { id: 'ep-7:70', storyTime: 70, title: 't4', episodeId: 'ep-7' },
    [{ subjectId: 'entryC', path: '/location', op: 'replace', value: 'y', axis: 'physical' }],
    [],
    'derived',
  );
  insertWorldSlice(
    PID_FULL,
    { id: 'ep-2:30', storyTime: 30, title: 't5', episodeId: 'ep-2' },
    [{ subjectId: 'solo', path: '/hp', op: 'replace', value: 9, axis: 'physical' }],
    [],
    'derived',
  );
  insertWorldSlice(
    PID_FULL,
    { id: 'ep-z:80', storyTime: 80, title: 't6' },
    [{ subjectId: 'solo', path: '/hp', op: 'replace', value: 8, axis: 'physical' }],
    [],
    'amendment', // amendment 后来居上（t=80 max）
  );

  // ── 章摘要窗：全形态覆盖 ──
  seedSummary(PID_FULL, 'ep-1', 1, 10, 20);
  seedSummary(PID_FULL, 'ep-2', 2, 21, 30);
  seedSummary(PID_FULL, 'ep-3', 3, 31, null); // start-only 窗（end 缺）
  seedSummary(PID_FULL, 'ep-4', 4, null, null); // 全缺窗（有行但不可解析）
  seedSummary(PID_FULL, 'ep-5', null, 41, 50); // 无 index 章（ledger 排序用，gap 可解析）
  seedSummary(PID_FULL, 'ep-7', 7, 61, 70); // 先种后弄坏（UPDATE 只改已存在行）
  seedSummary(PID_FULL, 'ep-8', 8, 71, 80); // 同上
  seedSummary(PID_FULL, 'ep-9', 9, 51, 60);
  seedSummary(PID_FULL, 'ep-10', 10, 55, 60); // 与 ep-9 并列 end=60（mention best 并列决胜测试）
  seedSummary(PID_FULL, 'ep-11', 11, 35, null);
  // 手改库形态（对拍硬门——坏行须与旧路径同门跳过，且 SQL json 函数不得抛错炸查询）：
  getDb()
    .prepare("UPDATE closure_chapter_summary SET summary = 'not-json' WHERE project_id = ? AND episode_id = 'ep-7'")
    .run(PID_FULL); // 坏 JSON：两路径都无窗
  getDb()
    .prepare("UPDATE closure_chapter_summary SET summary = '[1,2]' WHERE project_id = ? AND episode_id = 'ep-8'")
    .run(PID_FULL); // 合法 JSON 非 object：两路径都无窗
  getDb()
    .prepare(
      "UPDATE closure_chapter_summary SET summary = json_set(summary, '$.storyTimeStart', '35-string') WHERE project_id = ? AND episode_id = 'ep-11'",
    )
    .run(PID_FULL); // start 被写成字符串：新路径 json_type 守卫 → NULL；旧路径字符串进窗后 isFinite 拒——同效
  // ep-6：无摘要行（episode 缺席 → 无窗）。

  // ── mention 账（6 实体 × 多形态）──
  upsertEpisodeMentions(PID_FULL, 'ep-1', [ins('entryA')]);
  upsertEpisodeMentions(PID_FULL, 'ep-2', [ins('entryA'), ins('entryB', { presence: 'mentioned' })]);
  upsertEpisodeMentions(PID_FULL, 'ep-9', [ins('entryA')]);
  upsertEpisodeMentions(PID_FULL, 'ep-10', [ins('entryA')]); // entryA 并列 end=60 → best=ep-10（episode_id 升序首）
  upsertEpisodeMentions(PID_FULL, 'ep-4', [ins('entryB')]); // entryB：ep-2 可解析 + ep-4 全缺窗 → 降档
  upsertEpisodeMentions(PID_FULL, 'ep-6', [ins('entryC')]); // entryC：episode 无摘要行 → 无 best，退 patches
  upsertEpisodeMentions(PID_FULL, 'ep-7', [ins('entryD')]); // entryD：坏 JSON 章（无窗）+ ep-5 可解析
  upsertEpisodeMentions(PID_FULL, 'ep-5', [ins('entryD')]);
  upsertEpisodeMentions(PID_FULL, 'ep-3', [ins('entryE')]); // entryE：start-only 窗
  upsertEpisodeMentions(PID_FULL, 'ep-11', [ins('entryF')]); // entryF：start 为字符串 → 两路径都不可解析且无 patches → 无统计
}

describe.skipIf(!sqliteUsable)('gap_stats 取数下推对拍（Story 8.3 S5 / 8.7 CR-014）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
    seedFullFixture();
  });
  afterAll(clean);

  it('满配（多实体/窗缺/坏 JSON/并列/amend）：未收窄全实体统计——旧全量组装 vs 新下推组装输出 deep-equal', () => {
    const { oldStats, newStats } = expectParity(PID_FULL);
    expect(oldStats).not.toBeNull();
    expect(newStats).toEqual(oldStats);

    // 手算 ground truth（锚点 = max(窗 60, patches 80) = 80；gap 0 的锚点持有者 solo 被 minGap 滤除）：
    expect(newStats).toEqual([
      { entryId: 'entryE', basis: 'mention', lastEpisodeId: 'ep-3', lastStoryTime: 31, storyTimeGap: 49 }, // start-only 窗
      { entryId: 'entryB', basis: 'patches', lastEpisodeId: 'ep-9', lastStoryTime: 50, storyTimeGap: 30 }, // 窗缺降档 + 并列取 derived
      { entryId: 'entryD', basis: 'mention', lastEpisodeId: 'ep-5', lastStoryTime: 50, storyTimeGap: 30 }, // 坏 JSON 章降档 + 无 patches → best-effort
      { entryId: 'entryA', basis: 'mention', lastEpisodeId: 'ep-10', lastStoryTime: 60, storyTimeGap: 20 }, // 并列 end=60 → ep-10（升序首）
      { entryId: 'entryC', basis: 'patches', lastEpisodeId: 'ep-7', lastStoryTime: 70, storyTimeGap: 10 }, // 无窗章 → patches 口径
    ]);
  });

  it('entry_id 收窄（entryB）：mention 全行路径 + patches SQL 收窄——对拍等价（锚点语义含收窄 quirk 保持）', () => {
    const { newStats, neu } = expectParity(PID_FULL, 'entryB');
    // 收窄锚点 = max(窗 60, entryB patches 50) = 60（旧路径同款——patch 过滤先于锚点计算，保持）。
    expect(neu.anchorStoryTime).toBe(60);
    expect(newStats).toEqual([
      { entryId: 'entryB', basis: 'patches', lastEpisodeId: 'ep-9', lastStoryTime: 50, storyTimeGap: 10 },
    ]);
  });

  it('空账：两路径锚点均 undefined（no_anchor 态一致）', () => {
    const { oldStats } = expectParity(PID_EMPTY);
    expect(oldStats).toBeNull();
  });

  it('单实体：mention 口径 gap 0 被 minGap 滤除 → 两路径空统计', () => {
    seedSummary(PID_SOLO, 'ep-1', 1, 5, 10);
    upsertEpisodeMentions(PID_SOLO, 'ep-1', [ins('only')]);
    const { oldStats, newStats, neu } = expectParity(PID_SOLO);
    expect(neu.anchorStoryTime).toBe(10);
    expect(oldStats).toEqual([]);
    expect(newStats).toEqual([]);
  });

  it('presence 收窄：mention 臂走 queryMentionLedger 同参直通（窄路径不经聚合）', () => {
    const narrow = assembleGapStatsInput(PID_FULL, { presence: 'present' });
    expect(narrow.mentions).toEqual(queryMentionLedger(PID_FULL, { presence: 'present' }));
  });

  it('取数行数量级（CR-014 断言主体）：聚合行数 = subject/entry 数，非 patch/mention 全量', () => {
    // patches：6 行 → per-subject 3 行（entryB/entryC/solo）。
    expect(listWorldPatches(PID_FULL)).toHaveLength(6);
    const facts = listLastPatchFacts(PID_FULL);
    expect(facts).toHaveLength(3);
    expect(facts.map((f) => f.subjectId)).toEqual(['entryB', 'entryC', 'solo']);
    // 并列 derived 胜出 + amendment max 胜出（argmax 行选取正确性）：
    expect(facts.find((f) => f.subjectId === 'entryB')).toEqual({
      subjectId: 'entryB',
      storyTime: 50,
      sliceId: 'ep-9:50',
    });
    expect(facts.find((f) => f.subjectId === 'solo')).toEqual({
      subjectId: 'solo',
      storyTime: 80,
      sliceId: 'ep-z:80',
    });
    // subject 收窄下推 SQL。
    expect(listLastPatchFacts(PID_FULL, 'entryC')).toEqual([
      { subjectId: 'entryC', storyTime: 70, sliceId: 'ep-7:70' },
    ]);

    // mention：11 行 → per-entry 6 行（A-F）。
    expect(queryMentionLedger(PID_FULL)).toHaveLength(11);
    const aggs = aggregateMentionAppearance(PID_FULL);
    expect(aggs).toHaveLength(6);
    // entryA：并列 end=60 → best ep-10（episode_id 升序首，与全行路径 JS 分组同解）；全解析。
    expect(aggs.find((a) => a.entryId === 'entryA')).toEqual({
      entryId: 'entryA',
      bestEpisodeId: 'ep-10',
      bestStoryTime: 60,
      hasUnresolvedWindow: false,
    });
    // entryC：唯一行所在章无摘要 → 无 best + unresolved。
    expect(aggs.find((a) => a.entryId === 'entryC')).toEqual({
      entryId: 'entryC',
      bestEpisodeId: null,
      bestStoryTime: null,
      hasUnresolvedWindow: true,
    });
    // entryF：start 为字符串的窗 → 两路径同判不可解析。
    expect(aggs.find((a) => a.entryId === 'entryF')).toEqual({
      entryId: 'entryF',
      bestEpisodeId: null,
      bestStoryTime: null,
      hasUnresolvedWindow: true,
    });

    // 章摘要：轻列窗与 listChapterSummaries 同门（坏 JSON / 非 object 行两路径都跳过）。
    expect(listChapterSummaries(PID_FULL)).toHaveLength(8); // 10 行 - ep-7 坏 - ep-8 非 object
    expect(listEpisodeStoryTimeWindows(PID_FULL)).toHaveLength(8);
    // 字符串 start 的 ep-11：轻列读出 NULL（json_type 守卫），数值窗其余正常。
    const ep11 = listEpisodeStoryTimeWindows(PID_FULL).find((w) => w.episodeId === 'ep-11');
    expect(ep11).toMatchObject({ storyTimeStart: null, storyTimeEnd: null });
  });
});
