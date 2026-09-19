import { ipcMain, BrowserWindow } from 'electron';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { assertSafePath } from './pathGuard';
import { getLogger } from '../logger';
import type { GitCommitEntry, GitFileDiff } from '@orison/shared-contracts';

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git.findRoot({ fs, filepath: dir });
    return true;
  } catch {
    return false;
  }
}

async function getGitRoot(dir: string): Promise<string> {
  return git.findRoot({ fs, filepath: dir });
}

async function listCommits(dir: string, depth: number): Promise<GitCommitEntry[]> {
  const root = await getGitRoot(dir);

  // Collect commits from all branches for full graph
  const branchNames = await git.listBranches({ fs, dir: root });
  const seen = new Set<string>();
  const allEntries: Array<{ oid: string; commit: { message: string; author: { name: string; timestamp: number }; parent: string[] } }> = [];

  for (const branch of branchNames) {
    try {
      const logs = await git.log({ fs, dir: root, ref: branch, depth });
      for (const entry of logs) {
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          allEntries.push(entry);
        }
      }
    } catch { /* skip unresolvable branches */ }
  }

  // Sort by timestamp descending
  allEntries.sort((a, b) => b.commit.author.timestamp - a.commit.author.timestamp);

  // Build oid -> tag map
  const tags = await git.listTags({ fs, dir: root });
  const tagMap = new Map<string, string>();
  for (const tag of tags) {
    try {
      const resolved = await git.resolveRef({ fs, dir: root, ref: `refs/tags/${tag}` });
      tagMap.set(resolved, tag);
    } catch { /* skip */ }
  }

  return allEntries.map((entry) => ({
    oid: entry.oid,
    parents: entry.commit.parent,
    message: entry.commit.message.trim(),
    author: entry.commit.author.name,
    timestamp: entry.commit.author.timestamp,
    tag: tagMap.get(entry.oid),
  }));
}

async function getCommitDiff(dir: string, oid: string): Promise<GitFileDiff[]> {
  const root = await getGitRoot(dir);
  const commit = await git.readCommit({ fs, dir: root, oid });
  const parentOid = commit.commit.parent[0] ?? undefined;

  const currentTree = git.TREE({ ref: oid });
  const parentTree = parentOid ? git.TREE({ ref: parentOid }) : undefined;

  const trees = parentTree ? [parentTree, currentTree] : [currentTree];
  const results: GitFileDiff[] = [];

  await git.walk({
    fs,
    dir: root,
    trees,
    map: async (filepath, entries) => {
      if (!entries || filepath === '.') return;
      if (parentTree) {
        const [parent, current] = entries;
        const parentOidVal = parent ? await parent.oid() : null;
        const currentOidVal = current ? await current.oid() : null;
        if (parentOidVal === currentOidVal) return;
        if (!parentOidVal && currentOidVal) {
          results.push({ filepath, status: 'added' });
        } else if (parentOidVal && !currentOidVal) {
          results.push({ filepath, status: 'deleted' });
        } else {
          results.push({ filepath, status: 'modified' });
        }
      } else {
        const [current] = entries;
        if (current && (await current.type()) === 'blob') {
          results.push({ filepath, status: 'added' });
        }
      }
    },
  });

  return results;
}

async function getFileAtCommit(dir: string, oid: string, filepath: string): Promise<string | null> {
  const root = await getGitRoot(dir);
  try {
    const { blob } = await git.readBlob({
      fs,
      dir: root,
      oid,
      filepath,
    });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

function notifyGitChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tool:event', { type: 'git:changed' });
  }
}

/** git 节点作者（时间线展示用；全部节点统一）。 */
const GIT_AUTHOR = { name: 'Closure', email: 'user@closure.local' };
/**
 * CR-28（dogfood R2）：新项目首节点消息——初始内容（project.yaml + 先行落盘的封面）
 * 落地那一刻由 commitProjectCreateNode 挂上。详设要求首节点含初始内容，而不是空节点。
 */
const PROJECT_CREATE_COMMIT_MESSAGE = '项目创建';
/**
 * 存量/导入目录 opt-in 开启版本管理时的首节点消息（git:init 入口——磁盘上已有内容，
 * 首节点捕获导入现场）。
 */
const VERSIONING_INIT_COMMIT_MESSAGE = '开启版本管理';

/**
 * Initialize version management for a project folder that isn't a repo yet
 * (e.g. an imported existing directory). Creates the repo, stages everything
 * currently on disk, and lays down a first node so the timeline has a starting
 * point. Idempotent: if the folder is already a repo, returns without error.
 *
 * dogfood R2 批次0：export 供 projectFileIpc 的 create-directory 路径直调（新项目
 * 自动开版本管理）——同层 main/ipc 直接 import 函数，不走 IPC 自绕。
 *
 * CR-28（dogfood R2）：空目录（Closure 新建项目的 create-directory 路径）只建 repo、
 * 不落空节点——「开启版本管理」空节点会让随后的 project.yaml 落成未提交变更。首节点
 * 「项目创建」等初始内容就绪，由 projectMetaIpc 首写路径挂 commitProjectCreateNode。
 */
export async function initRepo(dir: string): Promise<{ initialized: boolean }> {
  if (await isGitRepo(dir)) {
    return { initialized: false };
  }
  await git.init({ fs, dir, defaultBranch: 'main' });
  // R2 #26：统一走 stageAllChanges（fresh init 理论上无删件行，但与 createNode/首节点
  // 单源同语义，不留第二套 add 循环）。
  const stagedAny = await stageAllChanges(dir);
  if (!stagedAny) {
    // Empty folder: nothing to capture — leave HEAD unborn; the first node is
    // 项目创建, laid when initial content lands (see commitProjectCreateNode).
    return { initialized: true };
  }
  await git.commit({
    fs,
    dir,
    message: VERSIONING_INIT_COMMIT_MESSAGE,
    author: GIT_AUTHOR,
  });
  notifyGitChanged();
  return { initialized: true };
}

/**
 * CR-28（dogfood R2）：新项目的 git 首节点——在初始内容（project.yaml 首写，含先行
 * 落盘的封面）就绪那一刻挂「项目创建」。只在「零提交 repo」（create-directory 的
 * initRepo 在空目录留下的 unborn repo）上生效：unborn HEAD 判定保证存量/导入项目
 * （已有提交）与用户自有 repo 永不被偷挂节点；非 repo 目录（打开的既有目录——版本
 * 管理 opt-in 走 git:init）同样 no-op。任何失败只 warn 不抛：首节点失败不阻塞项目
 * 创建（调用方 save-meta/ensure-document 依赖这条不阻塞语义）。
 */
export async function commitProjectCreateNode(dir: string): Promise<{ committed: boolean }> {
  try {
    if (!(await isGitRepo(dir))) {
      return { committed: false };
    }
    const root = await getGitRoot(dir);
    // Unborn-HEAD probe: a repo with any commit has a resolvable HEAD. Only a
    // zero-commit repo is waiting for its 项目创建 node.
    try {
      await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
      return { committed: false };
    } catch {
      // unborn — proceed to lay the first node
    }
    const stagedAny = await stageAllChanges(root);
    if (!stagedAny) {
      return { committed: false }; // nothing landed yet — no empty node (CR-28)
    }
    await git.commit({
      fs,
      dir: root,
      message: PROJECT_CREATE_COMMIT_MESSAGE,
      author: GIT_AUTHOR,
    });
    try {
      notifyGitChanged();
    } catch {
      // best-effort broadcast — the commit itself already succeeded
    }
    return { committed: true };
  } catch (err) {
    getLogger().warn({ dir, err }, 'git first node (项目创建) failed — project creation continues without it');
    return { committed: false };
  }
}

/**
 * dogfood R2 #26：statusMatrix 全量暂存（createNode / initRepo / 首节点共用）。两处坑：
 * ① isomorphic-git 的 `git.add` **不接受工作区不存在的文件**（真 git 可以）——删件（如
 * 「删除对话」移走的 session jsonl）必须走 `git.remove` 暂存，否则整个快照 NotFoundError
 * 全炸；② statusMatrix 对「同尺寸 + 同秒改写」走 stat 快径**误报未变**（真 git 有
 * racy-git 重哈希防御，isomorphic-git 没有——集成测试实测抓到 v1→v2 被漏），故不信
 * workdir===1，凡在工作区的文件一律 add（幂等，未变文件重暂存无副作用，代价是快照
 * 全量哈希一遍——项目规模下可接受，换快照不漏改）。
 * 返回是否暂存了任何内容（调用方据此决定是否跳过空节点）。
 */
export async function stageAllChanges(root: string): Promise<boolean> {
  const matrix = await git.statusMatrix({ fs, dir: root });
  let stagedAny = false;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (workdir === 0) {
      // 工作区已删：git.remove 暂存删除。head/index 至少一边挂着才有意义（两边都空的
      // 幽灵行防御式跳过——git.remove 对不在索引的路径同样 NotFoundError）。
      if (head === 1 || stage !== 0) {
        await git.remove({ fs, dir: root, filepath });
        stagedAny = true;
      }
    } else {
      await git.add({ fs, dir: root, filepath });
      stagedAny = true;
    }
  }
  return stagedAny;
}

export async function createNode(dir: string, message: string, tag?: string): Promise<{ oid: string }> {
  const root = await getGitRoot(dir);
  await stageAllChanges(root);
  const oid = await git.commit({
    fs,
    dir: root,
    message,
    author: GIT_AUTHOR,
  });
  if (tag) {
    await git.tag({ fs, dir: root, ref: tag, object: oid });
  }
  notifyGitChanged();
  return { oid };
}

async function listBranches(dir: string): Promise<string[]> {
  const root = await getGitRoot(dir);
  return git.listBranches({ fs, dir: root });
}

async function currentBranch(dir: string): Promise<string> {
  const root = await getGitRoot(dir);
  const branch = await git.currentBranch({ fs, dir: root });
  return branch ?? 'HEAD';
}

async function createBranch(dir: string, name: string, fromOid?: string): Promise<void> {
  const root = await getGitRoot(dir);
  await git.branch({ fs, dir: root, ref: name, object: fromOid });
}

async function checkoutBranch(dir: string, name: string): Promise<void> {
  const root = await getGitRoot(dir);
  await git.checkout({ fs, dir: root, ref: name });
  notifyGitChanged();
}

/**
 * Restore the working tree to the state of `oid` and record it as a new node
 * on the current branch. Keeps history linear: no restore-* branches and no
 * detached HEAD — "going back" is itself a step forward on the timeline, so
 * the version being left behind stays reachable.
 */
async function restoreVersion(dir: string, oid: string, message: string): Promise<{ oid: string }> {
  const root = await getGitRoot(dir);
  // Materialize the snapshot into worktree + index without moving HEAD.
  await git.checkout({ fs, dir: root, ref: oid, force: true, noUpdateHead: true });
  // Already at that state? Don't record an empty node.
  const matrix = await git.statusMatrix({ fs, dir: root });
  const dirty = matrix.some(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1);
  if (!dirty) {
    notifyGitChanged();
    return { oid: await git.resolveRef({ fs, dir: root, ref: 'HEAD' }) };
  }
  const newOid = await git.commit({
    fs,
    dir: root,
    message,
    author: GIT_AUTHOR,
  });
  notifyGitChanged();
  return { oid: newOid };
}

async function statusCount(dir: string): Promise<number> {
  const root = await getGitRoot(dir);
  const matrix = await git.statusMatrix({ fs, dir: root });
  let count = 0;
  for (const [, head, workdir, stage] of matrix) {
    if (head !== 1 || workdir !== 1 || stage !== 1) count++;
  }
  return count;
}

export function registerGitIpc() {
  const logger = getLogger();

  ipcMain.handle('git:is-repo', async (_e, dir: string) => {
    try {
      assertSafePath(dir);
      return await isGitRepo(dir);
    } catch (err) {
      logger.warn({ dir, err }, 'git:is-repo failed');
      return false;
    }
  });

  ipcMain.handle('git:init', async (_e, dir: string) => {
    try {
      assertSafePath(dir);
      return await initRepo(dir);
    } catch (err) {
      logger.warn({ dir, err }, 'git:init failed');
      throw err;
    }
  });

  ipcMain.handle('git:log', async (_e, dir: string, depth?: number) => {
    try {
      assertSafePath(dir);
      return await listCommits(dir, depth ?? 50);
    } catch (err) {
      logger.warn({ dir, err }, 'git:log failed');
      return [];
    }
  });

  ipcMain.handle('git:commit-diff', async (_e, dir: string, oid: string) => {
    try {
      assertSafePath(dir);
      return await getCommitDiff(dir, oid);
    } catch (err) {
      logger.warn({ dir, oid, err }, 'git:commit-diff failed');
      return [];
    }
  });

  ipcMain.handle('git:file-at-commit', async (_e, dir: string, oid: string, filepath: string) => {
    try {
      assertSafePath(dir);
      return await getFileAtCommit(dir, oid, filepath);
    } catch (err) {
      logger.warn({ dir, oid, filepath, err }, 'git:file-at-commit failed');
      return null;
    }
  });

  ipcMain.handle('git:create-node', async (_e, dir: string, message: string, tag?: string) => {
    try {
      assertSafePath(dir);
      return await createNode(dir, message, tag);
    } catch (err) {
      logger.warn({ dir, err }, 'git:create-node failed');
      throw err;
    }
  });

  ipcMain.handle('git:list-branches', async (_e, dir: string) => {
    try {
      assertSafePath(dir);
      return await listBranches(dir);
    } catch (err) {
      logger.warn({ dir, err }, 'git:list-branches failed');
      return [];
    }
  });

  ipcMain.handle('git:current-branch', async (_e, dir: string) => {
    try {
      assertSafePath(dir);
      return await currentBranch(dir);
    } catch (err) {
      logger.warn({ dir, err }, 'git:current-branch failed');
      return 'HEAD';
    }
  });

  ipcMain.handle('git:create-branch', async (_e, dir: string, name: string, fromOid?: string) => {
    try {
      assertSafePath(dir);
      await createBranch(dir, name, fromOid);
    } catch (err) {
      logger.warn({ dir, name, err }, 'git:create-branch failed');
      throw err;
    }
  });

  ipcMain.handle('git:checkout-branch', async (_e, dir: string, name: string) => {
    try {
      assertSafePath(dir);
      await checkoutBranch(dir, name);
    } catch (err) {
      logger.warn({ dir, name, err }, 'git:checkout-branch failed');
      throw err;
    }
  });

  ipcMain.handle('git:restore-version', async (_e, dir: string, oid: string, message: string) => {
    try {
      assertSafePath(dir);
      return await restoreVersion(dir, oid, message);
    } catch (err) {
      logger.warn({ dir, oid, err }, 'git:restore-version failed');
      throw err;
    }
  });

  ipcMain.handle('git:status-count', async (_e, dir: string) => {
    try {
      assertSafePath(dir);
      return await statusCount(dir);
    } catch (err) {
      logger.warn({ dir, err }, 'git:status-count failed');
      return 0;
    }
  });
}
