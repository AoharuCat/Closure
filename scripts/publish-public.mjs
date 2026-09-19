#!/usr/bin/env node
// publish-public.mjs — 双仓出仓同步（M2：私仓 dev → 公仓 main，快照 commit 形态）。
//
// 用法：
//   node scripts/publish-public.mjs            # 交互模式（push 前人肉过目变更清单）
//   node scripts/publish-public.mjs --yes      # 跳过确认（CI/熟练后用）
//   node scripts/publish-public.mjs --dry-run  # 只打印同步集，不动任何东西
//
// 流程（design.md §1，含 CR-08-29 二轮加固）：
//   0. 前置守门：工作树净 / public remote 已配置 / 交互确认可读（TTY）
//   1. 残留自检（上次异常中止的 worktree/分支自动清理）
//   2. 公仓领先守门：public/main 有 dev 不含的 commit → die（先人工 merge 外部贡献）
//   3. fetch public → 公栖清单（scripts/publish-paths.json）展开两树 → blob 哈希对比
//      → copy 集 + delete 集；空集 = 已最新 exit 0（幂等）
//   4. worktree（public/main 起 publish-sync 分支）→ 文件级 blob 应用（gitBlob 字节
//      直拷，只认 HEAD 已提交内容）→ 变更清单人肉过目（delete 集单独警示——外部
//      贡献文件被删的最大风险面）→ commit sync 快照 → push
//   5. push 后回注 merge（外部贡献以 sync commit 为共同祖先）；冲突 = abort + 明确
//      中止指示（绝不吞成功信号）
//   6. 推后复验（用 push 已更新的本地跟踪引用，不 refetch——防 GitHub 引用传播竞态）
//
// 事故防（08-29 实录）：不做目录级 cp（嵌套）；删除只删算出路径；push 只推 main；
// 中止/异常路径的清理在 finally + 兜底自检，不留残留分支害下次运行。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_REMOTE = 'public';
const PUBLIC_REF = `${PUBLIC_REMOTE}/main`;
const BRANCH = 'publish-sync';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const dryRun = args.includes('--dry-run');

// core.quotepath=false：中文路径（docs/guides/时间线指南.md）在默认配置的新克隆上会被
// 八进制转义，后续 rev-parse/show 直接崩（CR-08-29-007）。所有 git 调用统一带此配置。
const GIT_COMMON = ['-c', 'core.quotepath=false'];

function git(...gitArgs) {
  return execFileSync('git', [...GIT_COMMON, ...gitArgs], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * 取 blob 原始字节（不走 git() ——其 .trim() 会吃掉尾部换行/空白，首跑实录：
 * paths.json 尾 \n 被吞 → 两仓 blob 恒差一字节 → 后续 merge add/add 假冲突）。
 */
function gitBlob(ref, file) {
  return execFileSync('git', [...GIT_COMMON, 'show', `${ref}:${file}`], {
    cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024,
  });
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── 0. 前置守门 ──────────────────────────────────────────────────────────────
const manifestPath = path.join(REPO_ROOT, 'scripts', 'publish-paths.json');
if (!existsSync(manifestPath)) die('scripts/publish-paths.json 不存在');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const wlPaths = [...(manifest.dirs ?? []), ...(manifest.files ?? [])];
if (wlPaths.length === 0) die('公栖清单为空');

// 工作树必须干净（同步只认 HEAD；脏树状态下人容易误判「已同步」）
if (git('status', '--porcelain') !== '') die('工作树不干净——先 commit 或 stash（同步只认 HEAD）');

// public remote 已配置（CR-08-29-005：未配置时给可操作指引而非裸堆栈）
if (!git('remote').split('\n').map((r) => r.trim()).includes(PUBLIC_REMOTE)) {
  die(`remote "${PUBLIC_REMOTE}" 未配置——先 git remote add ${PUBLIC_REMOTE} https://github.com/AoharuCat/Closure.git`);
}

// 交互确认可读（CR-08-29-005：非 TTY 无 --yes 会挂在 readFileSync(0)）
if (!yes && !dryRun && !process.stdin.isTTY) die('非交互环境（stdin 非 TTY）——确认门需要 TTY；无人值守请加 --yes');

// ── 1. 残留自检（CR-08-29-004：上次异常中止可能留下 worktree/分支，直接撞裸崩）──
git('worktree', 'prune');
if (git('branch', '--list', BRANCH) !== '') {
  console.warn(`⚠ 清理上次运行残留的 ${BRANCH} 分支`);
  git('branch', '-D', BRANCH);
}

console.log('· fetch public …');
git('fetch', PUBLIC_REMOTE, 'main');

// ── 2. 公仓领先守门（CR-08-29-002：外部 PR 合入 public 后未 merge 进 dev 时，
//      其新文件会落入 delete 集被本脚本静默抹除——这是双仓模型最危险通路）──
const ahead = git('rev-list', '--count', `HEAD..${PUBLIC_REF}`);
if (Number(ahead) > 0) {
  die(`public/main 有 ${ahead} 个 dev 不含的 commit（外部贡献未吸收）——先人工：git merge ${PUBLIC_REF} 处理后再同步；跳过此门同步会删掉外部贡献的新文件`);
}

// ── 3. 两树文件集与 blob 哈希对比（.gitattributes 归一两仓一致 = 哈希可比）──────
const devFiles = new Set(git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...wlPaths).split('\n').filter(Boolean));
const pubFiles = new Set(git('ls-tree', '-r', '--name-only', PUBLIC_REF, '--', ...wlPaths).split('\n').filter(Boolean));

const copySet = [];
const deleteSet = [];
for (const f of devFiles) {
  const devBlob = git('rev-parse', `HEAD:${f}`);
  const pubBlob = pubFiles.has(f) ? git('rev-parse', `${PUBLIC_REF}:${f}`) : null;
  if (devBlob !== pubBlob) copySet.push(f);
}
for (const f of pubFiles) if (!devFiles.has(f)) deleteSet.push(f);

if (copySet.length === 0 && deleteSet.length === 0) {
  console.log('✓ 已是最新（公栖路径零差异）——无需同步');
  process.exit(0);
}

copySet.sort();
deleteSet.sort();
console.log(`\n同步集：copy ${copySet.length} / delete ${deleteSet.length}`);
if (deleteSet.length > 0) {
  console.log(`\n⚠️ delete 集（公仓将删除——逐条确认非外部贡献文件）：`);
  for (const f of deleteSet) console.log(`  - ${f}`);
}
const sample = copySet.slice(0, 40);
if (copySet.length > 0) {
  console.log('\ncopy 集（截前 40）：');
  for (const f of sample) console.log(`  + ${f}`);
  if (copySet.length > sample.length) console.log(`  …另 ${copySet.length - sample.length} 项`);
}

if (dryRun) {
  console.log('\n（dry-run：未做任何改动）');
  process.exit(0);
}

// ── 4. worktree 应用 + 确认门 + 快照 commit + push ───────────────────────────
const wt = path.join(os.tmpdir(), `closure-publish-${process.pid}`);
rmSync(wt, { recursive: true, force: true });
console.log(`\n· worktree ${wt} …`);
git('worktree', 'add', '-b', BRANCH, wt, PUBLIC_REF);
let aborted = false;
let pushed = false;
try {
  // 4a. copy 集：内容取 HEAD blob 原始字节（文件级，无目录拷贝）
  for (const f of copySet) {
    const target = path.join(wt, f);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, gitBlob('HEAD', f));
  }
  // 4b. delete 集：只删清单算出的路径
  for (const f of deleteSet) {
    rmSync(path.join(wt, f), { force: true });
  }
  // 4c. 暂存并核对
  git('-C', wt, 'add', '-A');
  const staged = git('-C', wt, 'diff', '--cached', '--name-status', '-M');
  console.log('\n· 暂存变更：');
  console.log(staged);

  // 4d. 人肉过目门（中止走 flag，finally 统一清理后再 die——CR-08-29-004）
  if (!yes) {
    process.stdout.write('\n推上公仓 main？[y/N] ');
    const answer = readFileSync(0, 'utf8').trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') aborted = true;
  }

  if (!aborted) {
    const devHash = git('rev-parse', '--short', 'HEAD');
    git('-C', wt, 'commit', '-m', `sync: dev@${devHash}`);
    console.log(`\n· push ${PUBLIC_REMOTE} HEAD:main …`);
    git('-C', wt, 'push', PUBLIC_REMOTE, 'HEAD:main');
    pushed = true;

    // 4e. push 后把同步点 merge 回注 dev：外部贡献再进来时以 sync commit 为共同
    //     祖先做 3-way（根除 add/add 假冲突，嫁接演练实录）。冲突 = abort + 明确
    //     中止指示，绝不吞成功信号（CR-08-29-003）。
    try {
      git('merge', PUBLIC_REF, '--no-edit', '-m', `merge: publish sync 回注（dev@${devHash} 已上公仓）`);
      console.log('· sync commit 已回注 dev（后续外部 PR merge 将以它为共同祖先）');
    } catch {
      try { git('merge', '--abort'); } catch { /* 无 mid-merge 态则忽略 */ }
      die(`公仓同步已成功，但回注 merge 冲突已 abort（dev 未变）。请人工处理：git merge ${PUBLIC_REF}`);
    }
  }
} finally {
  // 清理失败不掩盖成功结果（CR-08-29-006）
  try {
    git('worktree', 'remove', '--force', wt);
    git('branch', '-D', BRANCH, '--quiet');
  } catch (e) {
    console.warn(`⚠ worktree/分支清理失败（不影响同步结果，下次运行会自检清理）：${String(e).slice(0, 200)}`);
  }
}
if (aborted) die('已中止（worktree 与分支已清理）');

// ── 5. 推后复验（不 refetch：push 已原地更新跟踪引用；refetch 会撞 GitHub 引用
//      传播延迟吃到旧 main——首跑实录明明推成功却报残留）────────────────────────
{
  const devFiles2 = new Set(git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...wlPaths).split('\n').filter(Boolean));
  const pubFiles2 = new Set(git('ls-tree', '-r', '--name-only', PUBLIC_REF, '--', ...wlPaths).split('\n').filter(Boolean));
  let residue = 0;
  for (const f of devFiles2) {
    if (git('rev-parse', `HEAD:${f}`) !== git('rev-parse', `${PUBLIC_REF}:${f}`)) residue++;
  }
  for (const f of pubFiles2) if (!devFiles2.has(f)) residue++;
  if (residue > 0) die(`推后复验仍有 ${residue} 项差异——人工检查 public/main 与清单`);
  console.log('✓ 同步完成且推后复验归零（幂等达成）');
}
