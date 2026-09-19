import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChapterStateSummary } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror mentionLedgerRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-mention-materialize');

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

// loadProject 动态 import 于 recordEpisodeMentionsCore 内（readCardIndex）——top-level mock + per-test
// vi.mocked 控制（mirror arcLedgerHandlers.test.ts 先例）。默认返有效卡清单。
const CARDS_DOC = {
  meta: { name: 'P' },
  asset_cards: [
    { id: 'card-li', type: 'character', name: '李玄', basics: {} },
    { id: 'card-sword', type: 'item', name: '青锋剑' },
  ],
};
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => CARDS_DOC),
}));

import { closeDb, getDb } from '../main/db/index';
import { listRecentEpisodeMentionSignals, queryMentionLedger } from '../main/db/mentionLedgerRepository';
import { recordEpisodeMentionsCore } from '../main/db/mentionLedgerMaterialize';
import { insertWorldSlice, upsertChapterSummary } from '../main/db/worldStateRepository';
import { loadProject } from '@orison/desktop-local-bff';

// better-sqlite3 ABI gate (mirror mentionLedgerRepository.test.ts): skip under
// plain-Node vitest. Electron-as-Node real-run command (testing-discipline Pattern):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/mentionLedgerMaterialize.test.ts
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

const PID = '00077';

function mkSummary(episodeId: string): ChapterStateSummary {
  return {
    episodeId,
    episodeIndex: 1,
    storyTimeStart: 100,
    storyTimeEnd: 100,
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

/** 播种本章 world 状态：hero（桥 card-li）两 patch（presence_scene + hp）+ mob-01（无桥）一 patch。 */
function seedWorldState(): void {
  insertWorldSlice(
    PID,
    { id: 'ep-1:100', storyTime: 100, title: '遇袭', episodeId: 'ep-1' },
    [
      { subjectId: 'hero', path: '/presence_scene', op: 'replace', value: 's_a', axis: 'physical' },
      { subjectId: 'hero', path: '/hp', op: 'replace', value: 80, axis: 'physical' },
      { subjectId: 'mob-01', path: '/mood', op: 'replace', value: '慌乱', axis: 'emotional' },
    ],
    [
      { id: 'hero', type: 'character', name: '李玄', sourceCardId: 'card-li', firstSeenStoryTime: 100 },
      { id: 'mob-01', type: 'group', firstSeenStoryTime: 100 }, // 无卡桥——不入账（design §1.1 已知限制）
    ],
    'derived',
  );
  // 他章 slice（episode 归属过滤验证）。
  insertWorldSlice(
    PID,
    { id: 'ep-2:200', storyTime: 200, title: '他章', episodeId: 'ep-2' },
    [{ subjectId: 'hero', path: '/hp', op: 'replace', value: 70, axis: 'physical' }],
    [],
    'derived',
  );
  // 本章摘要行（synopsis 回填目标）。
  upsertChapterSummary(PID, {
    episodeId: 'ep-1',
    episodeIndex: 1,
    storyTimeEnd: 100,
    summary: mkSummary('ep-1'),
    tokenEstimate: 100,
    truncated: false,
    patchRowidHigh: 0,
  });
}

function readSummarySynopsis(): { synopsis?: string; degradedNote?: string } {
  const row = getDb()
    .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
    .get(PID, 'ep-1') as { summary: string };
  return JSON.parse(row.summary) as { synopsis?: string; degradedNote?: string };
}

describe.skipIf(!sqliteUsable)('recordEpisodeMentionsCore (Story 8.7 S8, design §2.2)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('正常申报：四通道合并落账（presence 档/state_changed/粗筛计数/计划对拍/source full）+ synopsis 回填 + 五类信号中的 alias/new_face', async () => {
    seedWorldState();
    const result = await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      declaration: {
        synopsis: '李玄与江白各自遇袭。',
        present: [{ name: '三师叔', card: '李玄' }],
        mentioned: [{ name: '青锋剑' }],
      },
      draftText: '李玄握紧青锋剑迎敌。',
      plannedAssetRefs: ['card-sword'],
    });

    // 两行：card-li（hero 桥）+ card-sword（申报提及 + 粗筛 + 计划）；mob-01 无桥不入账；ep-2 不计。
    expect(result.rowCount).toBe(2);
    const rows = queryMentionLedger(PID, { episodeId: 'ep-1' });
    expect(rows.map((r) => r.entryId).sort()).toEqual(['card-li', 'card-sword']);
    const li = rows.find((r) => r.entryId === 'card-li')!;
    expect(li).toMatchObject({
      presence: 'present', // 申报登场 ∨ 在场记录 ∨ 状态变化
      declared: 1,
      presenceShot: 1,
      stateChanged: 1,
      coarseHit: 1,
      coarseCount: 1, // 「李玄」一次
      planLinked: 0,
      source: 'full',
    });
    const sword = rows.find((r) => r.entryId === 'card-sword')!;
    expect(sword).toMatchObject({
      presence: 'mentioned', // 申报提及 + 粗筛 + 计划——无一能证在场（coarse 不升档）
      declared: 1,
      presenceShot: 0,
      stateChanged: 0,
      coarseHit: 1,
      planLinked: 1,
      source: 'full',
    });

    // synopsis 回填：summary JSON $.synopsis 写入。
    expect(result.synopsis).toBe('applied');
    expect(result.degradedReasons).toEqual([]);
    expect(readSummarySynopsis().synopsis).toBe('李玄与江白各自遇袭。');

    // 信号：alias_suggestion（三师叔经归属解析但不在 card-li 名/别名）。
    expect(result.signals).toEqual([
      { kind: 'alias_suggestion', episodeId: 'ep-1', name: '三师叔', entryId: 'card-li' },
    ]);

    // Story 8.7 S9：信号随 upsert 同事务持久化（closure_mention_signals——leader 注入段消费的落表值）。
    const persisted = listRecentEpisodeMentionSignals(PID, 5);
    expect(persisted).toEqual([
      { episodeId: 'ep-1', signals: [{ kind: 'alias_suggestion', episodeId: 'ep-1', name: '三师叔', entryId: 'card-li' }] },
    ]);
  });

  it('无申报（declaration 缺）→ 保守账：全行 source conservative + declared 0；synopsis 不写（no_declaration）', async () => {
    seedWorldState();
    const result = await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      draftText: '李玄握紧青锋剑迎敌。',
      plannedAssetRefs: ['card-sword'],
    });

    // 行集 = 纯代码通道命中（card-li 桥 + card-sword 粗筛/计划）；declared 全 0、source 全 conservative。
    const rows = queryMentionLedger(PID, { episodeId: 'ep-1' });
    for (const row of rows) {
      expect(row.declared).toBe(0);
      expect(row.source).toBe('conservative');
    }
    expect(rows.find((r) => r.entryId === 'card-li')?.presence).toBe('present'); // presence_shot 仍证在场

    expect(result.synopsis).toBe('no_declaration');
    expect(readSummarySynopsis().synopsis).toBeUndefined(); // 梗概不编造
    // 信号：无申报章只有 plan↔正文对拍（card-sword 有实际命中不产 plan_deviation；hard/soft/new_face/alias 不产生）。
    expect(result.signals).toEqual([]);
  });

  it('新面孔（三步解析全失败）→ 不产账行，产 new_face 信号（含 declaredAs 透传）', async () => {
    seedWorldState();
    const result = await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      declaration: {
        synopsis: '两人遇袭。',
        present: [{ name: '李玄' }, { name: '蒙面人' }], // 李玄正常解析（hero 桥行已申报——不产 hard_miss）
        mentioned: [{ name: '王五' }],
      },
      draftText: '',
    });
    // 蒙面人/王五均无卡可解析 → 不产行（hero 桥行照常）。
    const rows = queryMentionLedger(PID, { episodeId: 'ep-1' });
    expect(rows.map((r) => r.entryId)).toEqual(['card-li']);
    expect(result.signals).toEqual([
      { kind: 'new_face', episodeId: 'ep-1', name: '王五', declaredAs: 'mentioned' },
      { kind: 'new_face', episodeId: 'ep-1', name: '蒙面人', declaredAs: 'present' },
    ]);
  });

  it('卡索引不可用（loadProject null）→ 整章跳过记账 + degradedReason（写错账不如不写）', async () => {
    seedWorldState();
    // 先清本章既有账（此前测试可能已写入——本测试断言「跳过写入」需干净起点）。
    getDb().prepare('DELETE FROM closure_mention WHERE project_id = ?').run(PID);
    vi.mocked(loadProject).mockReturnValueOnce(null);
    const result = await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      declaration: { synopsis: 'x。', present: [], mentioned: [] },
      draftText: '李玄',
    });
    expect(result.rowCount).toBe(0);
    expect(queryMentionLedger(PID, { episodeId: 'ep-1' })).toEqual([]);
    expect(result.degradedReasons).toEqual(['asset_cards_unavailable']);
    expect(result.synopsis).toBe('no_declaration');
  });

  it('无 summary 行（bypass/直调）→ mention 账照常落，synopsis 记 no_summary_row + degradedReason', async () => {
    seedWorldState();
    getDb().prepare('DELETE FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?').run(PID, 'ep-1');
    const result = await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      declaration: { synopsis: '两人遇袭。', present: [], mentioned: [] },
      draftText: '',
    });
    expect(result.rowCount).toBeGreaterThanOrEqual(1); // hero 桥行照常
    expect(result.synopsis).toBe('no_summary_row');
    expect(result.degradedReasons).toEqual(['summary_row_missing']);
  });

  it('BMad CR-009：summary 行在但列为 NULL → 如实报 skipped 非假 applied（宽松克隆表构造——真表 summary NOT NULL）', async () => {
    seedWorldState();
    const db = getDb();
    // 真表 summary TEXT NOT NULL——NULL 行 schema 不可能；守卫是防御 belt（mirror degradeEpisodeMentions
    // 同款 NULL 守卫的对称性，约束未来放宽/手改 schema 时诚实报告）。用「换名 + 宽松克隆」构造 NULL 行
    // 真跑守卫分支（try/finally 还原真表，镜像表无索引对本测试无影响）。
    db.prepare('ALTER TABLE closure_chapter_summary RENAME TO closure_chapter_summary_real').run();
    db.exec(`CREATE TABLE closure_chapter_summary (
      project_id       TEXT NOT NULL,
      episode_id       TEXT NOT NULL,
      episode_index    INTEGER,
      story_time_end   INTEGER,
      summary          TEXT,
      token_estimate   INTEGER NOT NULL DEFAULT 0,
      truncated        INTEGER NOT NULL DEFAULT 0,
      patch_rowid_high INTEGER NOT NULL,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, episode_id)
    )`);
    try {
      // 手改库/半写入态：行在、summary 列 NULL。
      db.prepare(
        'INSERT INTO closure_chapter_summary (project_id, episode_id, summary, patch_rowid_high) VALUES (?, ?, NULL, 0)',
      ).run(PID, 'ep-1');
      const result = await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
        declaration: { synopsis: '两人遇袭。', present: [], mentioned: [] },
        draftText: '',
      });
      // mention 账照常（独立关注点）；synopsis 如实 skipped + 注记（旧实现误报 applied——
      // json_set(NULL,...) 恒 NULL 但 UPDATE changes=1）。
      expect(result.rowCount).toBeGreaterThanOrEqual(1);
      expect(result.synopsis).toBe('skipped');
      expect(result.degradedReasons).toEqual(['summary_row_null']);
      const row = db
        .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
        .get(PID, 'ep-1') as { summary: string | null };
      expect(row.summary).toBeNull(); // 列保持 NULL（没写成也不破坏）
    } finally {
      db.prepare('DROP TABLE closure_chapter_summary').run();
      db.prepare('ALTER TABLE closure_chapter_summary_real RENAME TO closure_chapter_summary').run();
    }
  });

  it('BMad CR-009 邻接：坏 summary JSON（可达形态）→ json_set 抛 → catch 降级（synopsis_backfill_failed），mention 账照常', async () => {
    seedWorldState();
    getDb()
      .prepare('UPDATE closure_chapter_summary SET summary = ? WHERE project_id = ? AND episode_id = ?')
      .run('{malformed', PID, 'ep-1');
    const result = await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      declaration: { synopsis: '两人遇袭。', present: [], mentioned: [] },
      draftText: '',
    });
    expect(result.rowCount).toBeGreaterThanOrEqual(1); // 账独立落（warn 不破链）
    expect(result.synopsis).toBe('no_summary_row');
    expect(result.degradedReasons[0]).toContain('synopsis_backfill_failed');
  });

  it('重收幂等：同 episode 重调整体覆盖（per-episode 全量替换，不累积）', async () => {
    seedWorldState();
    await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      declaration: { synopsis: '第一版。', present: [{ name: '李玄' }], mentioned: [] },
      draftText: '李玄',
    });
    await recordEpisodeMentionsCore(PID, TEST_HOME, 'ep-1', {
      declaration: { synopsis: '第二版。', present: [{ name: '李玄' }], mentioned: [] },
      draftText: '李玄',
    });
    const rows = queryMentionLedger(PID, { episodeId: 'ep-1' });
    expect(rows.filter((r) => r.entryId === 'card-li')).toHaveLength(1); // 不累积
    expect(readSummarySynopsis().synopsis).toBe('第二版。'); // synopsis last-wins 覆盖
    // S9：信号行同替换语义（重收覆盖，一行非两行）。
    expect(listRecentEpisodeMentionSignals(PID, 5)).toHaveLength(1);
  });
});
