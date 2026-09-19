#!/usr/bin/env node
// CI 启动冒烟（W5 R8 / design D4）：spawn 真 Electron 二进制跑 shell 主进程
//（ORISON_SMOKE=1 通道——正常全量 init 到 ready-to-show 打 ORISON_SMOKE_READY
// marker 后 app.exit(0)），判定 = marker 出现 + 退出码 0。
//
// 用法（cwd = apps/desktop/client/shell，ci.yml verify job 尾部三平台各跑一次；
// linux 由 xvfb-run -a 包裹后仍落到本脚本）：
//   pnpm --filter @orison/desktop-shell build
//   node scripts/ci-smoke.mjs
//
// 为什么是真主进程：ELECTRON_RUN_AS_NODE 走不到 BrowserWindow/ready-to-show，
// 冒烟面（db 打开 / 协议注册 / 窗口创建）必须在真 Electron 主进程里发生。
// 超时 120s：主进程启动（含 db 迁移 / IPC 注册 / renderer 首帧）秒级可达，
// 120s 已是两个数量级的余量；到点杀残留进程树 + 非零码退出。
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'ORISON_SMOKE_READY';
const TIMEOUT_MS = 120_000;
const STDERR_TAIL_BYTES = 8000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(scriptDir, '..');
const mainEntry = path.join(shellDir, 'dist', 'main', 'index.cjs');

function fail(message, stderrTail = '') {
  process.stderr.write(`[ci-smoke] FAIL: ${message}\n`);
  if (stderrTail.trim() !== '') {
    process.stderr.write(`[ci-smoke] --- stderr tail ---\n${stderrTail}\n--- end stderr tail ---\n`);
  }
  process.exit(1);
}

// electron npm 包在非 Electron 运行时导出其真二进制绝对路径（require 语义）。
// 经 shell 包 devDep `electron` 解析——CI 已 pnpm install，本机同样成立。
const nodeRequire = createRequire(import.meta.url);
let electronBin;
try {
  electronBin = nodeRequire('electron');
} catch (err) {
  fail(`cannot resolve 'electron' from the shell package (run pnpm install): ${err.message}`);
}
if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
  fail(`'electron' did not resolve to a binary path (got: ${typeof electronBin})`);
}
if (!existsSync(mainEntry)) {
  fail(`built main entry not found at ${mainEntry} — run \`pnpm --filter @orison/desktop-shell build\` first`);
}

// 防御：若宿主环境带 ELECTRON_RUN_AS_NODE，二进制会退化成纯 node 跑 main.cjs，
// 冒烟面（窗口/协议）整体失真——显式剔除。
const childEnv = { ...process.env, ORISON_SMOKE: '1' };
delete childEnv.ELECTRON_RUN_AS_NODE;

// linux CI（xvfb）启动护栏：runner 上 Electron 的 chrome-sandbox 无 root SUID 配置
//（ubuntu 24.04 另有 userns AppArmor 限制），缺 --no-sandbox 会在沙箱初始化即崩、
// 走不到冒烟面；--disable-gpu 防 xvfb 无 GLX 下的 GPU 初始化挂起。只作用于本烟测
// 进程，不改产品启动形态；冒烟面（db 打开 / IPC 注册 / renderer 首帧）与这两开关无关。
const platformArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];

const startedAt = Date.now();
const child = spawn(electronBin, [mainEntry, ...platformArgs], {
  cwd: shellDir,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let sawMarker = false;
let stdoutSoFar = '';
let stderrTail = '';

child.stdout.on('data', (chunk) => {
  const text = String(chunk);
  // 累积后再查 marker：18 字节 marker 理论上可被管道分块截断（假阴性 = CI 假红），
  // 累积后跨块 includes 免疫分块边界。冒烟 stdout 量小，无界累积无虞。
  stdoutSoFar += text;
  if (stdoutSoFar.includes(MARKER)) sawMarker = true;
  process.stdout.write(text);
});
child.stderr.on('data', (chunk) => {
  const text = String(chunk);
  stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
  process.stderr.write(text);
});
child.on('error', (err) => {
  clearTimeout(timeout);
  fail(`failed to spawn electron: ${err.message}`);
});

/**
 * 杀残留进程树（超时路径专用）。树杀纪律（spec/core/interface-contracts「子进程树
 * 终止纪律」）：杀前查已退；win 用异步 taskkill /T /F + 回调内 plainKill 回落
 *（mirror antigravityCli/driver.ts 范式——同步 throw 在异步失败下永不触发）。
 */
function killTree() {
  if (child.pid == null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // 已退出——零害
        }
      }
    });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出——零害
    }
  }
}

const timeout = setTimeout(() => {
  killTree();
  // 给 kill 一拍收尾再退，防进程列表残留误导后续 CI 步
  setTimeout(() => {
    fail(`timeout after ${TIMEOUT_MS / 1000}s waiting for ${MARKER} + exit 0 (process tree killed)`, stderrTail);
  }, 500);
}, TIMEOUT_MS);

child.on('close', (code) => {
  clearTimeout(timeout);
  const elapsedMs = Date.now() - startedAt;
  if (sawMarker && code === 0) {
    process.stdout.write(`[ci-smoke] PASS: ${MARKER} seen + exit 0 in ${elapsedMs}ms\n`);
    process.exit(0);
    return;
  }
  fail(
    `smoke failed — marker seen: ${sawMarker}, exit code: ${code} (elapsed ${elapsedMs}ms). ` +
      `Both the ${MARKER} line on stdout and a 0 exit code are required.`,
    stderrTail,
  );
});
