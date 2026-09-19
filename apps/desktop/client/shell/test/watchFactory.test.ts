import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// watchFactory 测试钉，三件事：
// 1. 注入缝三态：注入全接管 / null 复位（各 watcher 的行为面——debounce/过滤/
//    串行化/生命周期——在各自测试，合成事件源，本文件不触及）。
// 2. 生产默认 = 无条件单句柄 `watch(dir, { recursive: true }, cb)`，三平台同一路径
//    （recursive 自 Node 19.1 起 Linux 原生支持）——options 多键/少键/改值都红。
// 3. 真句柄集成（skipIf 非 linux——ubuntu CI 实证，本地 win/mac skip）：真实 fs 写入
//    → watchDir 生产路径收到相对根事件；close 不落在事件回调内（Windows libuv 教训）。
// ─────────────────────────────────────────────────────────────────────────────

type WatchCb = (event: string, filename: string | null) => void;

const watchMock = vi.hoisted(() =>
  vi.fn((_dir: string, _opts: unknown, _cb: WatchCb) => ({ close() {}, on() {} })),
);
/** 真实现 stash：mock factory 捕获原 fs.watch，linux 真句柄集成测试委托回真。 */
const realWatch = vi.hoisted(() => ({
  fn: null as null | ((dir: string, opts: unknown, cb: WatchCb) => unknown),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  realWatch.fn = actual.watch as unknown as typeof realWatch.fn;
  return { ...actual, watch: watchMock };
});

import { setWatchFactory, watchDir } from '../main/fs/watchFactory';
import { rmBestEffort } from './rmBestEffort';

describe('watchFactory（注入缝 + 生产默认 recursive 单句柄）', () => {
  afterEach(() => {
    setWatchFactory(null); // 复位生产默认（防注入态泄漏进后续测试）
    vi.clearAllMocks();
  });

  it('无注入时走真 fs.watch——(dir, { recursive: true }, cb) 逐字（options 无多无漏），三平台无条件同一路径', () => {
    const cb = (_event: string, _filename: string | null) => {};
    watchDir('C:/proj', cb);

    expect(watchMock).toHaveBeenCalledTimes(1);
    // toHaveBeenCalledWith 对每参 deep-equal：第二参恰为 { recursive: true }——
    // 多键/少键/改值都红（「逐字等价」硬门的断言守卫）。
    expect(watchMock).toHaveBeenCalledWith('C:/proj', { recursive: true }, cb);
  });

  it('默认分支返回值透传 fs.watch 句柄（DirWatcher 切片：close/on 可用）', () => {
    const sentinel = { close: vi.fn(), on: vi.fn() };
    watchMock.mockReturnValueOnce(sentinel);

    const handle = watchDir('C:/proj', () => {});

    expect(handle).toBe(sentinel);
    expect(typeof handle.close).toBe('function');
    expect(typeof handle.on).toBe('function');
  });

  it('注入分支：setWatchFactory(fake) 后全走 fake——生产 fs.watch 零触碰，句柄原样返回', () => {
    const fakeHandle = { close() {}, on() {} };
    const fake = vi.fn(() => fakeHandle);
    setWatchFactory(fake);

    const cb = (_event: string, _filename: string | null) => {};
    const handle = watchDir('C:/watched', cb);

    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake).toHaveBeenCalledWith('C:/watched', cb);
    expect(handle).toBe(fakeHandle);
    expect(watchMock).not.toHaveBeenCalled();
  });

  it('复位分支：setWatchFactory(null) 后回到生产默认——真 fs.watch recursive 单句柄（三平台无条件）', () => {
    setWatchFactory(() => ({ close() {}, on() {} })); // 先入注入态
    setWatchFactory(null);

    const cb = (_event: string, _filename: string | null) => {};
    watchDir('C:/after-reset', cb);

    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledWith('C:/after-reset', { recursive: true }, cb);
  });

  // ── 真句柄集成（linux only——ubuntu CI 实证；本地 win/mac skip）──

  describe.skipIf(process.platform !== 'linux')('生产默认真句柄集成（linux）', () => {
    it('真 fs.watch recursive 全链：根级写 → 新目录入看 → 孙目录写 → 子树删除后 watcher 存活；close 不落在事件回调内', async () => {
      setWatchFactory(null);
      expect(realWatch.fn).toBeTypeOf('function');
      // 生产路径调到的（被 mock 的）watch 委托回真实现——watchDir 产出真 FSWatcher。
      watchMock.mockImplementation(
        (dir, opts, cb) => realWatch.fn!(dir, opts, cb) as { close(): void; on(): void },
      );

      const dir = mkdtempSync(path.join(os.tmpdir(), 'watchfactory-it-'));
      const events: string[] = [];
      const errors: Error[] = [];
      const w = watchDir(dir, (_event, filename) => events.push(filename ?? '<null>'));
      w.on('error', (err) => errors.push(err));

      const waitFor = async (predicate: () => boolean, what: string) => {
        const start = Date.now();
        while (!predicate()) {
          if (Date.now() - start > 15_000) {
            throw new Error(`waitFor timeout (${what}); events=${JSON.stringify(events)}`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      try {
        writeFileSync(path.join(dir, 'a.txt'), 'x');
        mkdirSync(path.join(dir, 'sub'));
        await waitFor(() => events.some((e) => e === 'a.txt'), 'root file event');
        // 'sub' 事件递达即该目录已被 recursive 机制纳入监看（事件处理先于后续 inotify
        // 批次）——后续其内创建必然可见。
        await waitFor(() => events.some((e) => e === 'sub'), 'subdir event');

        mkdirSync(path.join(dir, 'sub', 'deep'));
        await waitFor(() => events.some((e) => e === 'sub/deep'), 'nested dir event');
        writeFileSync(path.join(dir, 'sub', 'deep', 'b.txt'), 'x');
        await waitFor(() => events.some((e) => e === 'sub/deep/b.txt'), 'nested write event');

        rmSync(path.join(dir, 'sub'), { recursive: true });
        await waitFor(() => events.filter((e) => e === 'sub').length >= 2, 'sub delete event');

        // 子树删除后根句柄仍活（删除不误杀、不误报 error）。
        writeFileSync(path.join(dir, 'c.txt'), 'x');
        await waitFor(() => events.some((e) => e === 'c.txt'), 'root alive after delete');
        expect(errors).toEqual([]);
      } finally {
        // 测试体协程内 close，不在 watcher 事件回调链内——libuv 教训纪律。
        w.close();
        await new Promise((r) => setTimeout(r, 50));
        rmBestEffort(dir);
        watchMock.mockReset(); // 撤委托，恢复 fake 句柄默认实现
      }
    }, 30_000);
  });
});
