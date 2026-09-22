/**
 * Git tool handlers — git_status, git_log, git_commit, git_diff
 */
import git from 'isomorphic-git';
import fs from 'node:fs';
import { assertSafePath } from '../pathGuard';
import { withProjectLock } from '../../fs/projectWriteLock';
import { notifyUI } from '../toolNotify';
import type { ToolHandler } from './types';

export const gitStatusHandler: ToolHandler = async ({ projectDir }) => {
  assertSafePath(projectDir);
  const root = await git.findRoot({ fs, filepath: projectDir });
  const matrix = await git.statusMatrix({ fs, dir: root });
  const files = matrix
    .filter(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1)
    .map(([filepath, head, workdir, stage]) => ({ filepath, head, workdir, stage }));

  const lines = files.map((f) => `${f.filepath} [H:${f.head} W:${f.workdir} S:${f.stage}]`);
  return {
    title: 'git_status',
    output: lines.length > 0 ? lines.join('\n') : '工作区干净，没有待提交的改动。',
    metadata: { count: files.length },
  };
};

export const gitLogHandler: ToolHandler = async ({ params, projectDir }) => {
  const { depth = 20 } = params as { depth?: number };
  assertSafePath(projectDir);
  const root = await git.findRoot({ fs, filepath: projectDir });
  const commits = await git.log({ fs, dir: root, depth });

  const lines = commits.map((c) =>
    `${c.oid.slice(0, 7)} ${c.commit.message.trim().split('\n')[0]} (${c.commit.author.name})`
  );
  return {
    title: 'git_log',
    output: lines.join('\n'),
    metadata: { count: commits.length },
  };
};

// 09-21-subagent-bg-decouple W3 硬闸补漏（write-safety-anchors.md §5）：commit 是 await 点
// 读（HEAD）-写（ref）序列，零锁时两并发 commit 后写覆盖 ref → 先者 commit 孤儿化（既有
// 暴露面 = leader 步内 Promise.all 双工具；bg 车道把它扩为跨 run 窗口）。包 withProjectLock
// 与 project.yaml 写同队列串行。死锁安全：handleToolExecute 全仓仅 agentIpc.ts:439 /
// agyBridge.ts:698 两调用点，均不在任何 withProjectLock 回调内；agent 侧 git_commit 调用
//（write-chapter.ts 经 registry.get）不持 shell 锁。gitIpc 侧 commitProjectCreateNode /
// createNode 不可同包（projectMetaIpc.ts:209/250 已在锁内调用——锁不可重入会死锁）。
export const gitCommitHandler: ToolHandler = async ({ params, projectDir }) => {
  const { message, author } = params as { message: string; author?: { name: string; email: string } };
  assertSafePath(projectDir);
  const root = await git.findRoot({ fs, filepath: projectDir });

  let oid = '';
  await withProjectLock(projectDir, async () => {
    const matrix = await git.statusMatrix({ fs, dir: root });
    for (const [filepath, , workdir] of matrix) {
      if (workdir !== 1) {
        await git.add({ fs, dir: root, filepath });
      }
    }

    oid = await git.commit({
      fs,
      dir: root,
      message,
      author: author ?? { name: 'Closure Agent', email: 'agent@closure.local' },
    });
  });

  notifyUI({ type: 'git:changed', projectPath: projectDir });
  return {
    title: 'git_commit',
    output: `已保存版本节点：${oid.slice(0, 7)} —— ${message}`,
    metadata: { oid },
  };
};

export const gitDiffHandler: ToolHandler = async ({ params, projectDir }) => {
  const { filepath } = params as { filepath?: string };
  assertSafePath(projectDir);
  const root = await git.findRoot({ fs, filepath: projectDir });
  const matrix = await git.statusMatrix({ fs, dir: root });

  const changed = filepath
    ? matrix.filter(([fp]) => fp === filepath)
    : matrix.filter(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1);

  const lines = changed.map(([fp, head, workdir, stage]) =>
    `${fp} [H:${head} W:${workdir} S:${stage}]`
  );
  return {
    title: 'git_diff',
    output: lines.length > 0 ? lines.join('\n') : '没有变更。',
    metadata: { count: lines.length },
  };
};
