import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { getProjectsRoot } from '../main/ipc/pathGuard';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

import { gitCommitHandler } from '../main/ipc/toolHandlers/gitHandlers';

// 09-21-subagent-bg-decouple W3 硬闸补漏回归（write-safety-anchors.md §5）：git_commit 工具
// handler 包 withProjectLock——两并发 commit 串行为「B 的父是 A」的线性史（补闸前两并发同读
// HEAD → ref 后写覆盖 → 先者 commit 孤儿化）。真 repo 集成（isomorphic-git 纯 JS，无 native ABI）。

const repoDir = path.join(getProjectsRoot(), 'bg-git-lock-repo');

async function initRepoWithCommit(): Promise<void> {
  mkdirSync(repoDir, { recursive: true });
  await git.init({ fs, dir: repoDir, defaultBranch: 'main' });
  writeFileSync(path.join(repoDir, 'a.txt'), 'initial');
  await git.add({ fs, dir: repoDir, filepath: 'a.txt' });
  await git.commit({
    fs,
    dir: repoDir,
    message: 'init',
    author: { name: 't', email: 't@t.local' },
  });
}

afterAll(() => {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* 并行负载 rmSync EPERM 容忍（testing-discipline rmBestEffort 姿态） */
  }
});

describe('W3 git_commit 工具锁串行（bg 车道跨 run 并发提交不孤儿化）', () => {
  it('两并发 commit → 线性史两条（后者 parent = 前者，无孤儿）', async () => {
    await initRepoWithCommit();

    writeFileSync(path.join(repoDir, 'b1.txt'), 'one');
    writeFileSync(path.join(repoDir, 'b2.txt'), 'two');

    // 同 tick 并发派发（mirror bg 子 agent 与 leader run 的跨 run 并发窗口）。
    const ctx = { sessionId: 'test-sess', abort: new AbortController().signal };
    const [r1, r2] = await Promise.all([
      gitCommitHandler({ params: { message: 'commit-one' }, projectDir: repoDir, ...ctx }) as unknown as Promise<{ metadata: { oid: string } }>,
      gitCommitHandler({ params: { message: 'commit-two' }, projectDir: repoDir, ...ctx }) as unknown as Promise<{ metadata: { oid: string } }>,
    ]);

    const oids = [r1.metadata.oid, r2.metadata.oid];
    expect(new Set(oids).size).toBe(2);

    // 线性史：HEAD(第二条) → 第一条 → init，三条全可达（孤儿化形态 = 两条提交 parent 同为
    // init，log 里只能看到一条 agent commit）。
    const log = await git.log({ fs, dir: repoDir, depth: 5 });
    const messages = log.map((e) => e.commit.message.trim());
    expect(messages).toContain('commit-one');
    expect(messages).toContain('commit-two');
    expect(log.length).toBe(3);
    // 父子链：HEAD 的 parent 恰是先完成的那条 commit（串行结果）。
    const oidByMessage = new Map(log.map((e) => [e.commit.message.trim(), e.oid]));
    const firstCommitOid = messages[1] === 'init' ? oidByMessage.get(messages[0])! : oidByMessage.get(messages[1])!;
    expect(log[1].oid).toBe(firstCommitOid);
    expect(log[1].oid).not.toBe(log[0].oid);
  });
});
