import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChapterStateSummary } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateCheckpoint.test.ts / closureSchema.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-mention-ledger');

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
  degradeEpisodeMentions,
  degradeEpisodeToConservative,
  deleteEpisodeMentions,
  getMentionAggregates,
  listRecentEpisodeMentionSignals,
  queryMentionLedger,
  upsertEpisodeMentions,
  type MentionRowInsert,
} from '../main/db/mentionLedgerRepository';
import { resetWorldState, upsertChapterSummary } from '../main/db/worldStateRepository';
import type { MentionSignal } from '@orison/shared-contracts';

// better-sqlite3 ABI gate (mirror worldStateCheckpoint.test.ts): skip the SQL
// suite instead of failing when the native addon cannot load under plain-Node
// vitest. Electron-as-Node real-run command (testing-discipline Pattern):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/mentionLedgerRepository.test.ts
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

// Story 8.7 S3 suite：每测试独立 project id（composite PK 跨项目隔离——测试间状态零泄漏，
// 各测试自播自验，mirror closureSchema 分 describe 隔离哲学但更轻量）。
const PID = '00007'; // upsert 替换幂等
const PID_QUERY = '00071'; // 双向查询
const PID_DEGRADE = '00072'; // 修订降档
const PID_AGG = '00073'; // 聚合
const PID_DEL = '00074'; // 删除

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

function mkSummary(episodeId: string, episodeIndex: number | null): ChapterStateSummary {
  return {
    episodeId,
    episodeIndex,
    storyTimeStart: null,
    storyTimeEnd: null,
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

/** 读章摘要 summary JSON（⚠ 先绑 row 再 .summary——`get() as {summary:string}.summary` 连写形态经 esbuild
 *  转译会让 JSON.parse 收到整行对象（String(row) = "[object Object]" 恒 parse 失败，实证）。 */
function readSummary(projectId: string, episodeId: string): { synopsis?: string; degradedNote?: string } {
  const row = getDb()
    .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
    .get(projectId, episodeId) as { summary: string };
  return JSON.parse(row.summary) as { synopsis?: string; degradedNote?: string };
}

describe.skipIf(!sqliteUsable)('mentionLedgerRepository (Story 8.7 S3)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('upsertEpisodeMentions：per-episode 全量替换幂等（重收不累积；空数组清空该章；他章不动）', () => {
    upsertEpisodeMentions(PID, 'ep-1', [
      ins('card-a'),
      ins('card-b', { presence: 'mentioned', declared: 0, source: 'conservative' }),
      ins('card-c'),
    ]);
    upsertEpisodeMentions(PID, 'ep-2', [ins('card-a', { coarseCount: 5 })]);

    // 重收 ep-1：只留新行（替换非合并）。
    upsertEpisodeMentions(PID, 'ep-1', [ins('card-a', { stateChanged: 1 }), ins('card-d')]);
    const rows = queryMentionLedger(PID, { episodeId: 'ep-1' });
    expect(rows.map((r) => r.entryId)).toEqual(['card-a', 'card-d']);
    expect(rows[0]).toMatchObject({ stateChanged: 1, declared: 1, source: 'full' });
    // 他章不动。
    expect(queryMentionLedger(PID, { episodeId: 'ep-2' }).map((r) => r.entryId)).toEqual(['card-a']);

    // 空数组 = 该章账清空（重扫产出零行的诚实缺位）。
    upsertEpisodeMentions(PID, 'ep-1', []);
    expect(queryMentionLedger(PID, { episodeId: 'ep-1' })).toEqual([]);
    expect(queryMentionLedger(PID, { episodeId: 'ep-2' })).toHaveLength(1);
  });

  it('queryMentionLedger：双向两路径（实体→出场史 / 章→名册 / 交集）+ presence 过滤 + camelCase 映射', () => {
    upsertEpisodeMentions(PID_QUERY, 'ep-10', [
      ins('card-a', { presence: 'present' }),
      ins('card-b', { presence: 'mentioned', declared: 1, coarseHit: 0, coarseCount: 0 }),
    ]);
    upsertEpisodeMentions(PID_QUERY, 'ep-11', [ins('card-a', { presence: 'mentioned', declared: 0 })]);

    // 实体 → 出场史（episode_id 升序）。
    const history = queryMentionLedger(PID_QUERY, { entryId: 'card-a' });
    expect(history.map((r) => r.episodeId)).toEqual(['ep-10', 'ep-11']);
    // snake→camel 集中映射（presenceShot/coarseHit/planLinked/coarseCount/stateChanged）。
    expect(history[0]).toMatchObject({
      projectId: PID_QUERY,
      entryId: 'card-a',
      presence: 'present',
      presenceShot: 0,
      coarseHit: 1,
      planLinked: 0,
      coarseCount: 1,
      stateChanged: 0,
      updatedAt: expect.any(String) as string,
    });

    // 章 → 名册。
    expect(queryMentionLedger(PID_QUERY, { episodeId: 'ep-10' }).map((r) => r.entryId)).toEqual([
      'card-a',
      'card-b',
    ]);

    // 双向交集。
    expect(queryMentionLedger(PID_QUERY, { entryId: 'card-a', episodeId: 'ep-11' })).toHaveLength(1);

    // presence 过滤。
    expect(
      queryMentionLedger(PID_QUERY, { episodeId: 'ep-10', presence: 'mentioned' }).map((r) => r.entryId),
    ).toEqual(['card-b']);
  });

  it('degradeEpisodeToConservative：declared 清位 + source 降档 + updated_at 刷新；无行 no-op；他章不动', () => {
    upsertEpisodeMentions(PID_DEGRADE, 'ep-20', [
      ins('card-a', { declared: 1, source: 'full' }),
      ins('card-b', { declared: 0, source: 'full' }),
    ]);
    upsertEpisodeMentions(PID_DEGRADE, 'ep-21', [ins('card-a', { declared: 1, source: 'full' })]);

    // 固定旧时间戳，验证降档刷新 updated_at（免 sleep）。
    getDb()
      .prepare(
        "UPDATE closure_mention SET updated_at = '2000-01-01 00:00:00' WHERE project_id = ? AND episode_id = 'ep-20'",
      )
      .run(PID_DEGRADE);

    const changed = degradeEpisodeToConservative(PID_DEGRADE, 'ep-20');
    expect(changed).toBe(2);
    for (const row of queryMentionLedger(PID_DEGRADE, { episodeId: 'ep-20' })) {
      expect(row.declared).toBe(0);
      expect(row.source).toBe('conservative');
      expect(row.updatedAt).not.toBe('2000-01-01 00:00:00');
    }
    // 他章不动。
    expect(queryMentionLedger(PID_DEGRADE, { episodeId: 'ep-21' })[0]).toMatchObject({
      declared: 1,
      source: 'full',
    });
    // 无账行章 = no-op（幂等）。
    expect(degradeEpisodeToConservative(PID_DEGRADE, 'ep-99')).toBe(0);
  });

  it('getMentionAggregates：per-entry 章数 + 最后章按 episode_index（缺 index/缺 summary 行排后）', () => {
    // 章摘要播种 episode_index（聚合的章序依据，LEFT JOIN closure_chapter_summary）。
    for (const [ep, idx] of [
      ['ep-2', 2],
      ['ep-3', 3],
      ['ep-10', null],
    ] as const) {
      upsertChapterSummary(PID_AGG, {
        episodeId: ep,
        episodeIndex: idx,
        storyTimeEnd: null,
        summary: mkSummary(ep, idx),
        tokenEstimate: 100,
        truncated: false,
        patchRowidHigh: 0,
      });
    }
    // ep-99 不播种 summary（LEFT JOIN NULL 路径）。

    // per-episode 全量替换语义：同章多实体必须同批 upsert（后播会替换先播）。
    upsertEpisodeMentions(PID_AGG, 'ep-2', [ins('card-a'), ins('card-b')]);
    upsertEpisodeMentions(PID_AGG, 'ep-3', [ins('card-a')]);
    upsertEpisodeMentions(PID_AGG, 'ep-99', [ins('card-a'), ins('card-c')]);
    upsertEpisodeMentions(PID_AGG, 'ep-10', [ins('card-b')]);

    const aggregates = getMentionAggregates(PID_AGG);
    expect(aggregates).toEqual([
      // card-a 3 章；ep-99 无 summary 行（NULL index）排已知 index 章后 → last = ep-3（index 3）。
      { entryId: 'card-a', chapterCount: 3, lastEpisodeId: 'ep-3' },
      // card-b 2 章；ep-10 有 summary 但 index NULL → 已知 index 的 ep-2 胜（虽 ep-10 字典序更大）。
      { entryId: 'card-b', chapterCount: 2, lastEpisodeId: 'ep-2' },
      // card-c 只在无 index 章 → last = ep-99（同层 episode_id 降序决胜）。
      { entryId: 'card-c', chapterCount: 1, lastEpisodeId: 'ep-99' },
    ]);
  });

  it('deleteEpisodeMentions：scoped 删除（他章/他项目不动）+ 返回删除行数', () => {
    upsertEpisodeMentions(PID_DEL, 'ep-30', [ins('card-a'), ins('card-b')]);
    upsertEpisodeMentions(PID_DEL, 'ep-31', [ins('card-a')]);
    upsertEpisodeMentions('00008', 'ep-30', [ins('card-a')]); // 他项目

    expect(deleteEpisodeMentions(PID_DEL, 'ep-30')).toBe(2);
    expect(queryMentionLedger(PID_DEL, { episodeId: 'ep-30' })).toEqual([]);
    expect(queryMentionLedger(PID_DEL, { episodeId: 'ep-31' })).toHaveLength(1);
    expect(queryMentionLedger('00008', { episodeId: 'ep-30' })).toHaveLength(1);
    expect(deleteEpisodeMentions(PID_DEL, 'ep-30')).toBe(0); // 幂等
  });

  // ── Story 8.7 S8：degradeEpisodeMentions 复合降档（mention 行 + synopsis stale 标注，design §2.3）──

  it('degradeEpisodeMentions：行降保守档 + 有申报梗概的章 degradedNote 追记 stale；重复降档幂等不重复追记', () => {
    const PID_COMP = '00075';
    // 播种 ep-40 摘要（带申报梗概）+ ep-41 摘要（无梗概）。
    const withSynopsis = { ...mkSummary('ep-40', 40), synopsis: '本章两人分头遇袭。' };
    upsertChapterSummary(PID_COMP, {
      episodeId: 'ep-40',
      episodeIndex: 40,
      storyTimeEnd: null,
      summary: withSynopsis,
      tokenEstimate: 100,
      truncated: false,
      patchRowidHigh: 0,
    });
    upsertChapterSummary(PID_COMP, {
      episodeId: 'ep-41',
      episodeIndex: 41,
      storyTimeEnd: null,
      summary: mkSummary('ep-41', 41),
      tokenEstimate: 100,
      truncated: false,
      patchRowidHigh: 0,
    });
    upsertEpisodeMentions(PID_COMP, 'ep-40', [ins('card-a', { declared: 1, source: 'full' })]);
    upsertEpisodeMentions(PID_COMP, 'ep-41', [ins('card-a', { declared: 1, source: 'full' })]);

    // 降档 ep-40（有梗概）：行降档 + stale 追记。
    const r40 = degradeEpisodeMentions(PID_COMP, 'ep-40');
    expect(r40.changedRows).toBe(1);
    expect(r40.synopsisMarked).toBe(true);
    expect(queryMentionLedger(PID_COMP, { episodeId: 'ep-40' })[0]).toMatchObject({
      declared: 0,
      source: 'conservative',
    });
    const summary40 = readSummary(PID_COMP, 'ep-40');
    expect(summary40.synopsis).toBe('本章两人分头遇袭。'); // 梗概保留（标 stale 非删除）
    expect(summary40.degradedNote).toContain('正文已修订');

    // 重复降档（幂等）：stale 注不重复追记。
    const r40again = degradeEpisodeMentions(PID_COMP, 'ep-40');
    expect(r40again.synopsisMarked).toBe(true);
    const summary40b = readSummary(PID_COMP, 'ep-40');
    expect(summary40b.degradedNote?.split('正文已修订').length).toBe(2); // 仅一次

    // 降档 ep-41（无梗概）：行降档照常，无梗概可标 → synopsisMarked=false。
    const r41 = degradeEpisodeMentions(PID_COMP, 'ep-41');
    expect(r41.changedRows).toBe(1);
    expect(r41.synopsisMarked).toBe(false);

    // 无 summary 行 + 无账行章：全 no-op。
    const r99 = degradeEpisodeMentions(PID_COMP, 'ep-99');
    expect(r99.changedRows).toBe(0);
    expect(r99.synopsisMarked).toBe(false);
  });

  it('degradeEpisodeMentions：既有 degradedNote 以「；」连接保留（不覆盖既有降级说明）', () => {
    const PID_NOTE = '00076';
    const preNoted = { ...mkSummary('ep-50', 50), synopsis: '遇袭。', degradedNote: 'promise_registry 缺失' };
    upsertChapterSummary(PID_NOTE, {
      episodeId: 'ep-50',
      episodeIndex: 50,
      storyTimeEnd: null,
      summary: preNoted,
      tokenEstimate: 100,
      truncated: false,
      patchRowidHigh: 0,
    });
    upsertEpisodeMentions(PID_NOTE, 'ep-50', [ins('card-a')]);

    const r = degradeEpisodeMentions(PID_NOTE, 'ep-50');
    expect(r.synopsisMarked).toBe(true);
    const summary = readSummary(PID_NOTE, 'ep-50');
    expect(summary.degradedNote).toBe('promise_registry 缺失；正文已修订：梗概与出场申报基于修订前版本');
  });

  // ── Story 8.7 S9：closure_mention_signals 读写（leader 注入段/查询面的持久面）──

  it('upsertEpisodeMentions 携 signals：同事务写 + per-episode 替换（重收覆盖；空数组清信号；undefined 不动信号）', () => {
    const PID_SIG = '00077';
    const sig = (kind: string) => ({ kind, episodeId: 'ep-60', entryId: 'card-a' }) as MentionSignal;

    // 首收：信号落表。
    upsertEpisodeMentions(PID_SIG, 'ep-60', [ins('card-a')], [sig('hard_miss'), sig('new_face')]);
    let rows = listRecentEpisodeMentionSignals(PID_SIG, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].episodeId).toBe('ep-60');
    expect(rows[0].signals.map((s) => s.kind)).toEqual(['hard_miss', 'new_face']);

    // 重收（新信号集）：整体覆盖非累积。
    upsertEpisodeMentions(PID_SIG, 'ep-60', [ins('card-a')], [sig('soft_miss')]);
    rows = listRecentEpisodeMentionSignals(PID_SIG, 5);
    expect(rows[0].signals.map((s) => s.kind)).toEqual(['soft_miss']);

    // 空数组 = 清信号（per-episode 替换语义，与账行一致）。repository 忠实返回落表行（零信号行保留
    // ——「收过、全对上」与「没收过」在表内可区分；零信号章的滤除归消费端——loader/handler）。
    upsertEpisodeMentions(PID_SIG, 'ep-60', [ins('card-a')], []);
    expect(listRecentEpisodeMentionSignals(PID_SIG, 5)).toEqual([{ episodeId: 'ep-60', signals: [] }]);

    // undefined（旧调用面）= 不管理信号——重收账行不动信号（当前空，播种再验）。
    upsertEpisodeMentions(PID_SIG, 'ep-60', [ins('card-a')], [sig('plan_deviation')]);
    upsertEpisodeMentions(PID_SIG, 'ep-60', [ins('card-a')]);
    expect(listRecentEpisodeMentionSignals(PID_SIG, 5)[0].signals.map((s) => s.kind)).toEqual(['plan_deviation']);
  });

  it('listRecentEpisodeMentionSignals：章序按 episode_index 降序（缺 index 排后）+ limit + 坏 JSON 行跳过', () => {
    const PID_LIST = '00078';
    for (const [ep, idx] of [
      ['ep-l1', 1],
      ['ep-l5', 5],
      ['ep-l3', 3],
      ['ep-lnull', null],
    ] as const) {
      upsertChapterSummary(PID_LIST, {
        episodeId: ep,
        episodeIndex: idx,
        storyTimeEnd: null,
        summary: mkSummary(ep, idx),
        tokenEstimate: 100,
        truncated: false,
        patchRowidHigh: 0,
      });
    }
    const one = (kind: string) => [{ kind, episodeId: 'x', entryId: 'y' }] as MentionSignal[];
    upsertEpisodeMentions(PID_LIST, 'ep-l1', [ins('card-a')], one('a'));
    upsertEpisodeMentions(PID_LIST, 'ep-l5', [ins('card-a')], one('b'));
    upsertEpisodeMentions(PID_LIST, 'ep-l3', [ins('card-a')], one('c'));
    upsertEpisodeMentions(PID_LIST, 'ep-lnull', [ins('card-a')], one('n'));

    // 已知 index 章新→旧（5→3→1）；NULL index 章排后。
    expect(listRecentEpisodeMentionSignals(PID_LIST, 10).map((e) => e.episodeId)).toEqual([
      'ep-l5',
      'ep-l3',
      'ep-l1',
      'ep-lnull',
    ]);
    // limit 截最近 N 章。
    expect(listRecentEpisodeMentionSignals(PID_LIST, 2).map((e) => e.episodeId)).toEqual(['ep-l5', 'ep-l3']);

    // 坏 JSON 行跳过不崩整 list（mirror patchRowToRecord CR-E6）。
    getDb()
      .prepare('UPDATE closure_mention_signals SET signals = ? WHERE project_id = ? AND episode_id = ?')
      .run('{malformed', PID_LIST, 'ep-l5');
    expect(listRecentEpisodeMentionSignals(PID_LIST, 10).map((e) => e.episodeId)).toEqual([
      'ep-l3',
      'ep-l1',
      'ep-lnull',
    ]);
  });

  it('degradeEpisodeMentions 级联删信号行（申报对照系失效——留着是误导则删；账行降档保留）+ resetWorldState 级联全清', () => {
    const PID_CAS = '00079';
    upsertEpisodeMentions(PID_CAS, 'ep-70', [ins('card-a', { declared: 1, source: 'full' })], [
      { kind: 'hard_miss', episodeId: 'ep-70', entryId: 'card-a' },
    ]);
    upsertEpisodeMentions(PID_CAS, 'ep-71', [ins('card-a')], [
      { kind: 'soft_miss', episodeId: 'ep-71', entryId: 'card-a', coarseCount: 2 },
    ]);

    // 降档 ep-70：账行降保守档保留 + 该章信号行删除（他章 ep-71 不动）。
    degradeEpisodeMentions(PID_CAS, 'ep-70');
    expect(queryMentionLedger(PID_CAS, { episodeId: 'ep-70' })).toHaveLength(1);
    expect(listRecentEpisodeMentionSignals(PID_CAS, 10).map((e) => e.episodeId)).toEqual(['ep-71']);

    // resetWorldState：全清（mirror closure_mention 同点位级联）。
    resetWorldState(PID_CAS);
    expect(queryMentionLedger(PID_CAS, {})).toEqual([]);
    expect(listRecentEpisodeMentionSignals(PID_CAS, 10)).toEqual([]);
  });

  // ── BMad CR-006：degradeEpisodeMentions 单 WAL 事务（崩溃窗口无半降档）──

  it('BMad CR-006：三条写语句单事务——末条失败整体回滚（mention 行不降档 + 信号行保留，无半降档态）', () => {
    const PID_TX = '00080';
    const withSynopsis = { ...mkSummary('ep-80', 80), synopsis: '遇袭。' };
    upsertChapterSummary(PID_TX, {
      episodeId: 'ep-80',
      episodeIndex: 80,
      storyTimeEnd: null,
      summary: withSynopsis,
      tokenEstimate: 100,
      truncated: false,
      patchRowidHigh: 0,
    });
    upsertEpisodeMentions(PID_TX, 'ep-80', [ins('card-a', { declared: 1, source: 'full' })], [
      { kind: 'hard_miss', episodeId: 'ep-80', entryId: 'card-a' },
    ]);

    // TEMP TRIGGER 让第三条写（synopsis stale 标注 UPDATE）ABORT——事务内前两条（行降档 + 删信号）
    // 须随之回滚（无事务时它们已各自提交 = 半降档：行降了但信号还留着误导）。
    const db = getDb();
    db.prepare(
      `CREATE TEMP TRIGGER fail_summary_update BEFORE UPDATE ON closure_chapter_summary
       BEGIN SELECT RAISE(ABORT, 'forced failure for CR-006'); END`,
    ).run();
    try {
      expect(() => degradeEpisodeMentions(PID_TX, 'ep-80')).toThrow('forced failure');
    } finally {
      db.prepare('DROP TRIGGER fail_summary_update').run();
    }

    // 回滚断言：三写全无（行保持 full + declared、信号行保留、summary 无 stale 注）——原子性。
    expect(queryMentionLedger(PID_TX, { episodeId: 'ep-80' })[0]).toMatchObject({
      declared: 1,
      source: 'full',
    });
    expect(listRecentEpisodeMentionSignals(PID_TX, 10).map((e) => e.episodeId)).toEqual(['ep-80']);
    expect(readSummary(PID_TX, 'ep-80').degradedNote).toBeUndefined();

    // 摘除 trigger 后重跑：全链成功（降档 + 删信号 + stale 标注一次到位）。
    const r = degradeEpisodeMentions(PID_TX, 'ep-80');
    expect(r.changedRows).toBe(1);
    expect(r.synopsisMarked).toBe(true);
    expect(listRecentEpisodeMentionSignals(PID_TX, 10)).toEqual([]);
    expect(readSummary(PID_TX, 'ep-80').degradedNote).toContain('正文已修订');
  });

  // ── BMad CR-008：listRecent 取数缓冲补位（坏 JSON 行丢弃后仍取满 limit）──

  it('BMad CR-008：limit 窗内含坏 JSON 行 → 缓冲补位仍取满 limit（窗外有效行可见，不偏少）', () => {
    const PID_BUF = '00081';
    // 5 章全带信号（index 降序窗内序：ep-b5..ep-b1）。
    for (const [ep, idx] of [
      ['ep-b1', 1],
      ['ep-b2', 2],
      ['ep-b3', 3],
      ['ep-b4', 4],
      ['ep-b5', 5],
    ] as const) {
      upsertChapterSummary(PID_BUF, {
        episodeId: ep,
        episodeIndex: idx,
        storyTimeEnd: null,
        summary: mkSummary(ep, idx),
        tokenEstimate: 100,
        truncated: false,
        patchRowidHigh: 0,
      });
      upsertEpisodeMentions(PID_BUF, ep, [ins('card-a')], [
        { kind: 'hard_miss', episodeId: ep, entryId: 'card-a' },
      ]);
    }
    // 窗内最近 3 章中 2 章坏 JSON（模拟手改库/版本 skew）。
    const corrupt = getDb().prepare(
      'UPDATE closure_mention_signals SET signals = ? WHERE project_id = ? AND episode_id = ?',
    );
    corrupt.run('{malformed', PID_BUF, 'ep-b5');
    corrupt.run('{malformed', PID_BUF, 'ep-b4');

    // limit=3：无缓冲时 SQL LIMIT 3 只取 ep-b5/b4/b3（两坏）→ 仅 1 好行；缓冲（+3）取到 b3/b2/b1
    // 补满 → 恰 3 章有效（b3/b2/b1），不偏少不超发。
    expect(listRecentEpisodeMentionSignals(PID_BUF, 3).map((e) => e.episodeId)).toEqual([
      'ep-b3',
      'ep-b2',
      'ep-b1',
    ]);

    // 全部有效时缓冲不超发（limit 仍硬上限）。
    expect(listRecentEpisodeMentionSignals(PID_BUF, 10)).toHaveLength(3); // b5/b4 仍坏，仅 3 有效章
  });
});
