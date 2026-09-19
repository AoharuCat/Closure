/**
 * 纯文本 lane agy 会话临时 cwd 的启动清扫（mirror 桥假宿启动清扫 sweepStaleBridgeHomes
 * 先例）：会话池的退出链（gracefulStop / idle LRU / will-quit dispose）覆盖正常路径，
 * 但父进程被硬杀（崩溃 / SIGKILL / 断电）时 mkdtemp 目录残留在 os.tmpdir()/ 下无限累积。
 * 从 index.ts 抽出为独立模块——纯判定谓词可单测，I/O 装配薄壳。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from '../logger';

/**
 * 清扫窗龄：远大于池内 idle 逐出（10min）与 belt 硬杀时限（5s）——活跃会话的 cwd
 * 不会被窗龄本身误伤，误删防线由下面的子项活动判据承担。
 */
const AGY_TMP_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// mkdtemp('agy-') 产物名形单源（antigravityCli/sessions.ts）：`agy-` + Node 随机
// 6 位 [A-Za-z0-9]。收紧到精确名形——共享 tmpdir 里第三方 `agy-` 前缀条目一律不碰。
const AGY_TMP_DIR_NAME_RE = /^agy-[A-Za-z0-9]{6}$/;

/**
 * 单条 tmpdir 条目的陈旧判定（纯函数，I/O 由调用方装配）：
 * - 名形不符或非目录 → false（第三方同名前缀的文件/目录绝不删）；
 * - 空目录 → true（无任何活动痕迹；代价是与另一实例并发 spawn 之间有毫秒级窗口，
 *   后果是单次类型化 turn 失败、会话池自愈，可接受）；
 * - 陈旧判据 = 目录自身与直接子项的最大 mtime < cutoff。只看目录 mtime 会误删长活跃
 *   会话：目录 mtime 仅在直接子项增删/改名时刷新，子文件持续覆写不动它；而深层写
 *  （cwd/sub/x）会刷新 sub 的 mtime，sub 正是 cwd 的直接子项——故「目录 + 直接子项」
 *   一层已覆盖真实活动面。
 */
export function isStaleAgyTempEntry(
  name: string,
  self: { isDirectory: boolean; mtimeMs: number },
  childMtimeMs: number[],
  cutoffMs: number,
): boolean {
  if (!AGY_TMP_DIR_NAME_RE.test(name)) return false;
  if (!self.isDirectory) return false;
  if (childMtimeMs.length === 0) return true;
  return Math.max(self.mtimeMs, ...childMtimeMs) < cutoffMs;
}

/** 目录不可读 / 子项不可 stat 一律保守当活跃（Infinity）——宁可漏删，不可误删。 */
function listChildMtimes(dirPath: string): number[] {
  try {
    return readdirSync(dirPath).map((child) => {
      try {
        return statSync(path.join(dirPath, child)).mtimeMs;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    });
  } catch {
    return [Number.POSITIVE_INFINITY];
  }
}

/**
 * 启动时扫 `os.tmpdir()/agy-*` 会话残留目录，超窗龄且无近期活动痕迹的 best-effort 删。
 * 启动窗口内本进程尚未创建任何会话目录（会话池惰性 spawn）；他进程实例的活跃会话由
 * 窗龄 + 子项活动判据保护。整函数 try/catch 全吞：清扫失败绝不阻启动（best-effort
 * 卫生，非功能）。
 */
export function sweepStaleAgyTempSessionDirs(): void {
  const log = getLogger();
  try {
    const tmpRoot = os.tmpdir();
    const cutoffMs = Date.now() - AGY_TMP_SWEEP_MAX_AGE_MS;
    let entries: string[];
    try {
      entries = readdirSync(tmpRoot);
    } catch {
      return; // tmpdir 不可读（极端沙箱形态）——静默放弃，不阻启动
    }
    let swept = 0;
    for (const entry of entries) {
      const fullPath = path.join(tmpRoot, entry);
      try {
        const selfStat = statSync(fullPath);
        const stale = isStaleAgyTempEntry(
          entry,
          { isDirectory: selfStat.isDirectory(), mtimeMs: selfStat.mtimeMs },
          listChildMtimes(fullPath),
          cutoffMs,
        );
        if (!stale) continue;
        rmSync(fullPath, { recursive: true, force: true });
        swept += 1;
      } catch {
        // 单条失败（他实例占用 / AV 扫描 / 权限）——保留现场，下轮启动再试
      }
    }
    if (swept > 0) {
      log.debug({ swept, root: tmpRoot }, 'swept stale agy session temp dirs on startup');
    }
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'agy session temp dir startup sweep failed (non-fatal)',
    );
  }
}
