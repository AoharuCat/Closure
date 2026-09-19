import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S3：章摘要物化点 → 摘要检索行索引 hook 的接线测试（mirror
// chapterDegradeWiring.test.ts 形态）。reindexChapterSummaryEntry 本体的 db round-trip 在
// chapterSummaryIndexer.test.ts（Electron 真跑）锚定；此处锚「物化成功路径真的调了 hook、
// 参数正确、hook 抛错不阻摘要落盘」——vi.mock 索引器模块捕获调用（wiring 测试）。
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-chapter-summary-hook-wiring');

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
  ipcMain: { handle: () => undefined },
}));
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

// 索引器 spy（wiring 测试不跑真索引——本体已在他套锚定；prune 同 mock 免真跑）。
const { reindexChapterSummaryEntry, pruneOrphanChapterSummaryEntries } = vi.hoisted(() => ({
  reindexChapterSummaryEntry: vi.fn(async () => undefined),
  pruneOrphanChapterSummaryEntries: vi.fn(() => 0),
}));
vi.mock('../main/db/chapterSummaryIndexer', () => ({
  reindexChapterSummaryEntry,
  pruneOrphanChapterSummaryEntries,
}));

import { closeDb, getDb } from '../main/db/index';
import {
  materializeChapterSummaryCore,
  waitForSummaryIndexQueue,
} from '../main/db/worldStateMaterialize';
import { rebuildChapterSummaries } from '../main/db/worldStateBackfill';
import { insertWorldSlice, resetWorldState } from '../main/db/worldStateRepository';

// better-sqlite3 ABI gate（mirror chapterDegradeWiring 家族）：Electron 真跑 ABI 匹配。
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

const PID = '00007';
const PROJECT_DIR = '/proj/summary-hook-wiring'; // loadProject 已 mock——projectDir 只透传。

const DOC = {
  episode_outlines: [
    { id: 'ep-1', index: 0, title: '一章' },
    { id: 'ep-2', index: 1, title: '二章' },
  ],
  promise_registry: { promises: [], beats: [] },
  scene_graph: { nodes: [] },
};

function seedEpisode(episodeId: string, storyTime: number): void {
  insertWorldSlice(
    PID,
    { id: `${episodeId}:${storyTime}`, storyTime, title: episodeId, episodeId },
    [{ subjectId: 'hero', path: '/hp', op: 'replace', value: 100, axis: 'physical' }],
    [{ id: 'hero', type: 'character', name: '主角', firstSeenStoryTime: storyTime }],
    'derived',
  );
}

describe.skipIf(!sqliteUsable)('章摘要物化点 → 摘要检索行 hook 接线（Story 8.3 S3）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  beforeEach(() => {
    vi.clearAllMocks();
    loadProject.mockReturnValue(DOC);
    resetWorldState(PID); // 清 slices/checkpoint/summary（含 8.7 mention 级联）——每测干净起点。
  });

  it('materializeChapterSummaryCore 成功路径 → hook 收 (projectId, projectDir, episodeId)', async () => {
    seedEpisode('ep-1', 100);
    const res = await materializeChapterSummaryCore(PID, PROJECT_DIR, 'ep-1');
    expect(res.summary.episodeId).toBe('ep-1'); // 物化本体成功
    // X1：hook 已 fire-and-forget（后台串行链）——排空队列后断言（物化不再等待检索行索引）。
    await waitForSummaryIndexQueue();
    expect(reindexChapterSummaryEntry).toHaveBeenCalledTimes(1);
    expect(reindexChapterSummaryEntry).toHaveBeenCalledWith(PID, PROJECT_DIR, 'ep-1');
  });

  it('hook 抛错 → best-effort：摘要行照常落盘、物化不抛（never-throws 契约）', async () => {
    seedEpisode('ep-1', 100);
    reindexChapterSummaryEntry.mockRejectedValueOnce(new Error('indexer boom'));
    const res = await materializeChapterSummaryCore(PID, PROJECT_DIR, 'ep-1');
    expect(res.summary.episodeId).toBe('ep-1'); // 摘要本体不受索引失败影响
    await waitForSummaryIndexQueue(); // 队列 catch 消化 rejection（链不断、无 unhandled）
  });

  it('rebuildChapterSummaries → 每物化 episode 一次 hook + 尾部 orphan 清扫一次', async () => {
    seedEpisode('ep-1', 100);
    seedEpisode('ep-2', 200);
    const report = await rebuildChapterSummaries(PID, PROJECT_DIR);
    expect(report.ok).toBe(true);
    expect(report.materialized).toBe(2);
    // rebuild 尾部 prune 前排空队列（X1）——hook 计数在 rebuild 返回时已确定。
    expect(reindexChapterSummaryEntry).toHaveBeenCalledTimes(2); // 经 materializeCore 内 hook
    expect(pruneOrphanChapterSummaryEntries).toHaveBeenCalledTimes(1);
    expect(pruneOrphanChapterSummaryEntries).toHaveBeenCalledWith(PID);
  });
});
