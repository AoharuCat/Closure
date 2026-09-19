/**
 * Directory-watch injection seam — 注入缝模式，先例 spec
 * `shell/bundled-resources.md` 的 setPromptsBaseDir：各 watcher 模块不直接调
 * `fs.watch`，统一走 `watchDir`——有注入时用注入源（测试合成事件，驱动 debounce/
 * 过滤/串行化/生命周期断言，不开真句柄），无注入时走生产默认。
 *
 * 生产默认 = 无条件单句柄 `watch(dir, { recursive: true }, cb)`，三平台同一路径：
 * recursive 自 Node 19.1.0 起三平台原生支持（Linux 由 libuv inotify 实现；本仓
 * Electron 37 = Node 22.21.1）。生产分支自身不开 try/catch——降级兜底在消费方
 * （projectWatcher + 五 db watcher）：句柄创建失败 / `'error'`（ENOSPC、平台不支持、
 * 瞬时失败）→ warn + 降级手动刷新 / 下次打开 backfill，不崩。
 *
 * Why（libuv windows CI 断言根除）：GitHub windows runner 上真 `fs.watch` 句柄在
 * 「事件处理中 close」竞态时触发 libuv fs-event C 层断言 `!_wcsnicmp (fs-event.c:72)`
 * 直接 abort 进程（JS 无从捕获，六轮实录）。测试改注入合成事件源后无真句柄可撞，
 * `describe.skipIf(win32 && CI)` 门随之撤销（三平台 CI 恢复全覆盖）；真 fs.watch
 * 集成验证挪 e2e 手动清单 + watchFactory.test.ts 的 linux 真句柄集成测试。
 */
import { watch } from 'node:fs';

/**
 * 各 watcher 实际消费的 `fs.FSWatcher` 结构切片：close（停看）+ on('error')
 * （错误自停）。生产 FSWatcher 结构满足；测试 fake 只需实现这两者。
 */
export type DirWatcher = {
  close(): void;
  /** 生产：FSWatcher 'error' 事件（watcher 自停）；注入源可 no-op。 */
  on(event: 'error', listener: (err: Error) => void): void;
};

export type WatchFn = (
  dir: string,
  cb: (event: string, filename: string | null) => void,
) => DirWatcher;

/** 注入源；null = 生产默认（recursive 单句柄，三平台同一路径）。 */
let activeWatchFn: WatchFn | null = null;

/**
 * Test seam：安装合成 watch 源；传 null 复位生产行为。切换无需清缓存——
 * watcher 不持有按源缓存的内容（异于 setPromptsBaseDir 的内容 cache 语义）。
 */
export function setWatchFactory(fn: WatchFn | null): void {
  activeWatchFn = fn;
}

/** 统一目录 watch 接线：注入时走 activeWatchFn，null 时生产默认 recursive 单句柄。 */
export function watchDir(
  dir: string,
  cb: (event: string, filename: string | null) => void,
): DirWatcher {
  if (activeWatchFn) return activeWatchFn(dir, cb);
  return watch(dir, { recursive: true }, cb);
}
