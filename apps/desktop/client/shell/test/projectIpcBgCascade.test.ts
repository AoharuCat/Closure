import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getProjectsRoot } from '../main/ipc/pathGuard';
import { rmBestEffort } from './rmBestEffort';

const { handle, deleteProject, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  deleteProject: vi.fn(async () => ({ ok: true })),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })),
  },
  shell: { trashItem: vi.fn(async () => undefined) },
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: vi.fn(), info, error: vi.fn() }) }));

// fs watcher / indexer / repository / 生命周期族全 mock（本测试只钉 bg 级联接线 + 转发）。
vi.mock('../main/fs/projectWatcher', () => ({ watchProject: vi.fn(), unwatchProject: vi.fn() }));
vi.mock('../main/db/assetCardsWatcher', () => ({ startAssetCardsWatcher: vi.fn(), stopAssetCardsWatcher: vi.fn() }));
vi.mock('../main/db/settingMdWatcher', () => ({ startSettingMdWatcher: vi.fn(), stopSettingMdWatcher: vi.fn() }));
vi.mock('../main/db/chapterChunkWatcher', () => ({ startChapterChunkWatcher: vi.fn(), stopChapterChunkWatcher: vi.fn() }));
vi.mock('../main/db/materialWatcher', () => ({ startProjectMaterialWatcher: vi.fn(), stopProjectMaterialWatcher: vi.fn() }));
vi.mock('../main/db/materialIndexer', () => ({ backfillProjectMaterials: vi.fn(async () => []) }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards: vi.fn(async () => ({ reindexed: 0 })) }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd: vi.fn(async () => ({})) }));
vi.mock('../main/db/chapterChunkIndexer', () => ({ rebuildChapterChunks: vi.fn(async () => ({})) }));
vi.mock('../main/db/projectRepository', () => ({
  ensureProject: vi.fn(),
  getProject: vi.fn(() => undefined),
  listProjects: vi.fn(() => []),
  touchProject: vi.fn(),
}));
vi.mock('../main/ipc/toolNotify', () => ({ notifyUI: vi.fn(), notifyProjectQuarantined: vi.fn() }));
vi.mock('../main/ipc/projectFileIpc', () => ({ registerProjectFileIpc: vi.fn() }));
vi.mock('../main/ipc/projectMetaIpc', () => ({ registerProjectMetaIpc: vi.fn() }));
vi.mock('../main/ipc/projectLifecycle', () => ({ deleteProject, duplicateProject: vi.fn(), renameProject: vi.fn() }));
vi.mock('../main/ipc/projectIdentity', () => ({ loadVerifiedProjectDocument: vi.fn() }));

import { registerProjectIpc } from '../main/ipc/projectIpc';
import { getBgTaskRegistry } from '@orison/desktop-agent';

registerProjectIpc();

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = handle.mock.calls.find(([c]) => c === channel);
  expect(registration).toBeDefined();
  return registration![1] as (...args: unknown[]) => Promise<unknown>;
}

/** 注册一个 cancel 可观察的后台任务（cancel → outcome 收敛 aborted）。 */
function seedCancellableBgTask(projectPath: string, childSessionId: string): { taskId: string; settled: () => boolean } {
  let settled = false;
  const taskId = getBgTaskRegistry().dispatchBg({
    parentSessionId: 'leader-1',
    projectPath,
    role: 'researcher',
    prompt: '级联测试任务',
    notify: 'silent',
    start: ({ signal }) => {
      const outcome = new Promise<{ status: 'aborted' }>((resolve) => {
        signal.addEventListener('abort', () => { settled = true; resolve({ status: 'aborted' }); });
      });
      return { childSessionId, outcome };
    },
  }).taskId;
  return { taskId, settled: () => settled };
}

beforeEach(() => {
  // ⚠ handle 不 mockClear——getHandler 依赖模块加载期的注册调用记录（registerProjectIpc
  // 无幂等守卫不可重跑）；本文件无 per-test 注册断言，保留记录无污染面。
  deleteProject.mockClear();
  info.mockClear();
  getBgTaskRegistry().__clearForTest();
});

// CR-16：本文件在真实 projects root 下建过目录——afterAll 统一清理（rmBestEffort 纪律）。
const createdDirs: string[] = [];
afterAll(() => {
  for (const dir of createdDirs) rmBestEffort(dir);
});

/** 建测试项目目录并登记清理（CR-16）。 */
function ensureProjectDir(name: string): string {
  const dir = path.join(getProjectsRoot(), name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

describe('W3 项目生命周期 bg 级联接线（project:delete / project:unwatch）', () => {
  it('project:delete 先级联取消该项目后台任务，有界 await 终态（CR-13）后再转发 deleteProject', async () => {
    const projDir = ensureProjectDir('bg-ipc-cascade');
    const task = seedCancellableBgTask(projDir, 'bg-ipc-child');

    await getHandler('project:delete')(undefined as never, projDir);

    expect(deleteProject).toHaveBeenCalledWith(projDir, expect.any(Function));
    // CR-13：handler 有界 await 终态收敛——返回时任务已 settled（不再与 trash 竞态写盘）。
    expect(task.settled()).toBe(true);
    expect(getBgTaskRegistry().get(task.taskId)?.status).toBe('aborted');
  });

  it('project:watch 登记 + project:unwatch 级联取消活跃项目后台任务', async () => {
    const projDir = ensureProjectDir('bg-ipc-unwatch');
    const task = seedCancellableBgTask(projDir, 'bg-ipc-unwatch-child');

    await getHandler('project:watch')(undefined as never, projDir);
    await getHandler('project:unwatch')(undefined as never);

    await vi.waitFor(() => expect(task.settled()).toBe(true));
    expect(getBgTaskRegistry().get(task.taskId)?.status).toBe('aborted');
  });

  it('CR-8：连续两次 watch（无 unwatch）→ 前项目锚不覆写丢失；unwatch 消费全部', async () => {
    const projA = ensureProjectDir('bg-ipc-unwatch-a');
    const projB = ensureProjectDir('bg-ipc-unwatch-b');
    const taskA = seedCancellableBgTask(projA, 'bg-ipc-a-child');
    const taskB = seedCancellableBgTask(projB, 'bg-ipc-b-child');

    // A watch → B watch（未先 unwatch——旧单值记忆会覆写丢 A 锚）→ 一次 unwatch。
    await getHandler('project:watch')(undefined as never, projA);
    await getHandler('project:watch')(undefined as never, projB);
    await getHandler('project:unwatch')(undefined as never);

    // 两个项目的后台任务都被级联取消（Set 记忆——unwatch 全消费并清）。
    await vi.waitFor(() => {
      expect(taskA.settled()).toBe(true);
      expect(taskB.settled()).toBe(true);
    });
  });

  it('未 watch 过即 unwatch（零登记态）：级联 no-op 不抛', async () => {
    await expect(getHandler('project:unwatch')(undefined as never)).resolves.toBeUndefined();
  });
});
