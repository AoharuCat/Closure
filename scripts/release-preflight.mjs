#!/usr/bin/env node
// ── 发布预检（release-preflight）──
// 发布 v* tag 前的机械门：把「同一事实多处散抄」类不同步错误变成脚本检查。
// 用法：node scripts/release-preflight.mjs   （全部通过 exit 0；任一失败 exit 1）
// 纪律：新增含 owner/version 等散抄事实的文件时，同步加进下面的检查清单数组。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const ok = [];

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) {
    fail.push(`文件缺失: ${rel}`);
    return null;
  }
  return readFileSync(p, 'utf8');
}

// ── 1. 版本两处一致（根 + shell；set-version.mjs 负责写，这里核对）──
/**
 * 读 package.json 的 version；文件缺失 / 坏 JSON / version 缺失一律落 fail 行，
 * 不裸抛 TypeError（坏输入也要给出人话诊断，而非堆栈）。
 */
function readVersion(rel) {
  const text = read(rel);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version;
  } catch {
    // 坏 JSON——落到下方 fail 行
  }
  fail.push(`package.json version unreadable: ${rel}`);
  return null;
}

const rootVersion = readVersion('package.json');
const shellVersion = readVersion('apps/desktop/client/shell/package.json');
if (rootVersion !== null && shellVersion !== null) {
  if (rootVersion === shellVersion) {
    ok.push(`版本一致: ${rootVersion}（根 + shell）`);
  } else {
    fail.push(`版本不一致: 根 ${rootVersion} vs shell ${shellVersion}（跑 node scripts/set-version.mjs <版号>）`);
  }
}

// ── 2. owner/repo 散抄点全部一致（改名/换仓时最易漏的事实）──
// 新增发布面 owner 引用文件时加进本数组。
const SLUG_FILES = [
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'package.json',
  'scripts/publish-public.mjs',
  '.github/ISSUE_TEMPLATE/config.yml',
  'docs/deployment/windows-installer.md',
  '_bmad-output/planning-artifacts/architecture.md',
  'apps/desktop/client/shell/electron-builder.yml',
  'apps/desktop/client/shell/electron-builder.portable.yml',
  'apps/desktop/client/shell/main/ipc/updateIpc.ts',
  'apps/desktop/client/ui/src/shared/components/settings/AboutSettingsPage.tsx',
];
const SLUG_RE = /github\.com\/([\w.-]+)\/Closure/gi;
const EXPECTED_OWNER = 'AoharuCat';
// 独立 ok 标记（不用 fail 行子串反推——无关失败行里碰巧含「owner」等字样会误触发绿行）。
let slugOk = true;
for (const rel of SLUG_FILES) {
  const text = read(rel);
  if (text === null) continue;
  const owners = [...text.matchAll(SLUG_RE)].map((m) => m[1]);
  const stale = owners.filter((o) => o !== EXPECTED_OWNER);
  if (stale.length > 0) {
    slugOk = false;
    fail.push(`${rel}: 陈旧 owner 引用 ${[...new Set(stale)].join(', ')}（应为 ${EXPECTED_OWNER}）`);
  }
  // 裸 profile 链接（github.com/<owner> 不带 /Closure）也核对——历史事故形态之一
  const bare = [...text.matchAll(/github\.com\/(AoharuCat|chillison)\b(?!\/Closure)/g)].map((m) => m[1]);
  if (bare.includes('chillison')) {
    slugOk = false;
    fail.push(`${rel}: 残留 github.com/chillison 裸链接`);
  }
}
if (slugOk) {
  ok.push(`owner/repo 散抄点一致（${SLUG_FILES.length} 文件 → ${EXPECTED_OWNER}/Closure）`);
}

// ── 3. CHANGELOG 最新已发布条目含当前版本（跳过 [Unreleased] 段）──
const changelog = read('CHANGELOG.md');
if (changelog !== null && rootVersion !== null) {
  const entries = changelog.split(/^## /m).slice(1);
  const latestRelease = entries.find((e) => !/^\[Unreleased\]/.test(e)) ?? '';
  // 数字边界正则：0.3.1 不得命中 0.3.12 / 10.3.1 这类「子串撞车」版本号
  const versionRe = new RegExp(`(?<![\\d.])${rootVersion.replace(/\./g, '\\.')}(?![\\d.])`);
  if (versionRe.test(latestRelease)) {
    ok.push(`CHANGELOG 最新发布条目含当前版本 ${rootVersion}`);
  } else {
    fail.push(`CHANGELOG 最新发布条目不含当前版本 ${rootVersion}——发布前补条目`);
  }
}

// ── 4. 工作树干净（publish-public 同步只认 HEAD）──
import { execSync } from 'node:child_process';
let dirty = '';
try {
  dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
} catch {
  fail.push('git status 执行失败');
}
if (dirty !== '') {
  fail.push(`工作树不干净（${dirty.trim().split('\n').length} 项未提交）——publish 同步与 tag 只认 HEAD，先 commit`);
} else {
  ok.push('工作树干净');
}

// ── 结果 ──
console.log(`\n发布预检（目标版本 ${rootVersion ?? '未知'}）`);
for (const line of ok) console.log(`  ✓ ${line}`);
if (fail.length > 0) {
  for (const line of fail) console.error(`  ✗ ${line}`);
  console.error(`\n${fail.length} 项未过——修完再发布。`);
  process.exit(1);
}
console.log(`\n全部通过（${ok.length} 项）。`);
