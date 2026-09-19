import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmBestEffort } from './rmBestEffort';

// ─────────────────────────────────────────────────────────────────────────────
// CR-09-19-agy-toolface-fix-batch-5：遍历面 readdir 失败的两侧对齐。
//
// 治前：`listFilesHandler.walk` 裸调 readdirSync——同一「目录读不动」在 search 侧跳过
// （skipped 计数），在 list 侧整体抛错。现两处同款（catch → skipped += 1; return）。
//
// 顶层例外（本批刻意保留响亮失败）：`list_files` 指向**文件**（ENOTDIR）若也走跳过路径，
// 模型侧只见空列表（桥回帧只带 output，metadata 不可见），无从分辨「空目录 / 读不动 /
// 根本不是目录」——故顶层先 `isDirectory` 判定，非目录即类型化报错。
//
// 模拟手法：partial mock `node:fs`——只让登记在案的目录抛 EACCES（真 fs 其余全通过）。
// 权限位模拟在 Windows 上不可移植（chmod 不生效），故走模块层注入。
// ─────────────────────────────────────────────────────────────────────────────

const { unreadableDirs } = vi.hoisted(() => ({ unreadableDirs: new Set<string>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((...args: unknown[]) => {
      if (unreadableDirs.has(String(args[0]))) {
        throw new Error('EACCES: permission denied, scandir');
      }
      return (actual.readdirSync as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdirSync,
  };
});

const { degradeMentionLedgerForChapterFile, notifyUI } = vi.hoisted(() => ({
  degradeMentionLedgerForChapterFile: vi.fn(async () => undefined),
  notifyUI: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/tmp', isPackaged: false },
}));
vi.mock('../main/db/mentionLedgerDegrade', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../main/db/mentionLedgerDegrade')>()),
  degradeMentionLedgerForChapterFile,
}));
vi.mock('../main/ipc/toolNotify', () => ({ notifyUI }));

import { listFilesHandler, searchHandler } from '../main/ipc/toolHandlers/fileHandlers';

const TMP = path.join(process.cwd(), 'test-tmp-file-handlers-traversal');

function ctx() {
  return { params: {} as Record<string, unknown>, projectDir: TMP, sessionId: 's1', abort: new AbortController().signal };
}

describe('遍历面 readdir 失败：list / search 两侧一致跳过（CR-5）', () => {
  beforeEach(() => {
    rmBestEffort(TMP);
    mkdirSync(path.join(TMP, 'sub'), { recursive: true });
    writeFileSync(path.join(TMP, 'top.md'), 'needle top', 'utf8');
    writeFileSync(path.join(TMP, 'sub', 'inside.md'), 'needle inside', 'utf8');
    unreadableDirs.clear();
  });
  afterEach(() => {
    unreadableDirs.clear();
    rmBestEffort(TMP);
  });

  it('list_files：子目录读不动 = 跳过（不抛）+ skipped 计数，其余目录照常列出', async () => {
    unreadableDirs.add(path.join(TMP, 'sub'));

    const res = await listFilesHandler({ ...ctx(), params: { recursive: true } });

    const listed = res.output.split('\n').filter(Boolean);
    expect(listed).toContain('top.md');
    expect(listed).toContain('sub/'); // 目录项本身可列（readdir 它才失败）
    expect(listed).not.toContain('sub/inside.md'); // 下钻失败 → 子树无产出
    expect(res.metadata).toMatchObject({ skipped: 1 });
  });

  it('search：同一目录读不动 = 跳过（与 list 侧同款）+ skipped 计数', async () => {
    unreadableDirs.add(path.join(TMP, 'sub'));

    const res = await searchHandler({ ...ctx(), params: { query: 'needle' } });

    expect(res.output.replace(/\\/g, '/')).toContain('top.md');
    expect(res.output).not.toContain('inside');
    expect(res.metadata).toMatchObject({ count: 1, skipped: 1 });
  });

  it('顶层指向文件：响亮失败（不落「空列表」——metadata 到不了模型，空列表无从分辨）', async () => {
    await expect(listFilesHandler({ ...ctx(), params: { dirPath: 'top.md' } })).rejects.toThrow('不是目录：top.md');
  });

  it('顶层目录读不动：响亮失败（顶层是模型给的路由，静默空列表 = 无从自纠）', async () => {
    unreadableDirs.add(TMP);

    await expect(listFilesHandler({ ...ctx(), params: { recursive: true } })).rejects.toThrow('目录读不动');
  });
});
