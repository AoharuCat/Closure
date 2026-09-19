import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 CR B5（2026-08-20）：分块器 schema 校验 fail-loud——防御性 flatMap 丢弃会使
// indexTexts/vectors 按位消费错位（写事务抛错或错位绑定），契约破坏必须 throw 而非静默丢。
// 上述契约在主 suite（chapterChunkIndexer.test.ts）无法覆盖：真分块器自产恒过 schema——
// 须 mock chunkChapter 产坏 chunk 断言 reject（vi.mock 文件级，独立小 suite）。
//
// Electron-as-Node 真跑（mirror chapterChunkIndexer.test.ts）：
//   cd apps/desktop/client/shell
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/chapterChunkIndexerFailLoud.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-chapter-chunk-fail-loud');
const PROJECT_DIR = path.join(TEST_HOME, 'my-project');

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
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
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

// B5 本体：chunkChapter 被劫持产 schema-invalid chunk（缺 span 字段）——真实现自产恒过，
// 只有 mock 能构造该契约破坏形态。其余导出保持真实现（chapterChunkSchema 校验面真实）。
vi.mock('@orison/shared-contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/shared-contracts')>();
  return {
    ...actual,
    chunkChapter: () => [{ index: 0, text: '缺 span 字段的坏 chunk' }],
  };
});

import { reindexChapter } from '../main/db/chapterChunkIndexer';
import { closeDb, getDb } from '../main/db/index';
import { ensureProject, getProject } from '../main/db/projectRepository';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';

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
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

let PID: string | undefined;

describe.skipIf(!sqliteUsable)('chapterChunkIndexer fail-loud（CR B5）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    mkdirSync(path.join(PROJECT_DIR, 'chapters'), { recursive: true });
    ensureProject({
      name: 'Test',
      type: 'novel',
      localFingerprint: path.resolve(PROJECT_DIR),
      path: path.resolve(PROJECT_DIR),
    });
    PID = getProject(path.resolve(PROJECT_DIR))!.projectId;
    loadProject.mockReturnValue(null); // 映射失败 graceful 路径（不依赖 episode 元数据）
    getDb();
    writeFileSync(
      path.join(PROJECT_DIR, 'chapters', 'ch_001.md'),
      '# 章\n\n一段正文，足以成块的内容长度需要超过五十个字符的长度要求，这里补足长度的填充文字继续补足。',
      'utf-8',
    );
  });
  afterAll(clean);

  it('分块器产出 schema-invalid chunk → reindexChapter 响亮 reject（fail-loud，非静默丢弃）', async () => {
    await expect(reindexChapter(PID!, PROJECT_DIR, 'ch_001')).rejects.toThrow(
      /schema-invalid chunk/u,
    );
    // 无半写状态：fail-loud 发生在 embed/事务之前，零 chunk 行落库。
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM closure_entry WHERE project_id=? AND source_kind='chapter'")
      .get(PID!) as { n: number };
    expect(rows.n).toBe(0);
  });
});
