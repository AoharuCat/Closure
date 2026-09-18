import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

// ── spawnRealCli 适配层单测（CR-5 回归面）──
//
// 零真进程纪律：spawnRealCli 是唯一触真 node:child_process 的位置——在本文件以
// vi.mock 在 **spawn 缝**注入 fake child（比 CliChild 更低一层的 fake），专测行分帧
// / 无尾换行残行冲刷 / 退出排空时序 / spawn error 归一 / 背压写桥接。

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));

import { spawn as mockedSpawn, execFile as mockedExecFile } from 'node:child_process';
import { spawnRealCli, treeKillDispatch } from '../src/antigravityCli/driver';

type FakeStream = EventEmitter & { setEncoding: (enc: string) => void };
type FakeWritable = EventEmitter & { write: (chunk: string) => boolean; end: () => void };

interface FakeNodeChild extends EventEmitter {
  pid: number;
  stdin: FakeWritable;
  stdout: FakeStream;
  stderr: FakeStream;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeNodeChild(): FakeNodeChild {
  const proc = new EventEmitter() as FakeNodeChild;
  proc.pid = 4242;
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(() => true),
    end: vi.fn(),
  }) as FakeWritable;
  proc.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) as FakeStream;
  proc.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) as FakeStream;
  proc.kill = vi.fn();
  return proc;
}

function armSpawn(): FakeNodeChild {
  const fake = makeFakeNodeChild();
  vi.mocked(mockedSpawn).mockImplementation(() => fake as unknown as ChildProcess);
  return fake;
}

beforeEach(() => {
  vi.mocked(mockedSpawn).mockReset();
  // execFile 调用计数跨用例清零（taskkill 断言含「零调用」面——不清零会累计前用例调用）。
  vi.mocked(mockedExecFile).mockReset();
});

describe('spawnRealCli 适配层（行分帧 / 退出排空）', () => {
  it('stdout 行分帧：完整行即时派发，残行留在缓冲', () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy.exe', ['--model', 'm'], { cwd: 'tmp' });
    const lines: string[] = [];
    child.onStdoutLine((l) => lines.push(l));
    fake.stdout.emit('data', '{"a":1}\n{"b":2}\n');
    fake.stdout.emit('data', '{"partial"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('无尾换行的终帧行在流尽时冲刷（CR-5）：result 行不丢，且先于退出通知', () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy.exe', [], { cwd: 'tmp' });
    const order: string[] = [];
    child.onStdoutLine((l) => order.push(`line:${l}`));
    child.onExit((code) => order.push(`exit:${code}`));
    fake.stdout.emit('data', '{"type":"result","status":"SUCCESS","response":"ok"}'); // 无尾换行
    expect(order).toEqual([]); // 未冲刷：无换行不分帧
    fake.stdout.emit('end');
    fake.emit('close', 0);
    expect(order).toEqual([
      'line:{"type":"result","status":"SUCCESS","response":"ok"}',
      'exit:0',
    ]);
  });

  it('退出通知挂 close 不挂 exit（CR-5）：exit 后 end 前不抢跑（行到达序优先于退出序）', () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy.exe', [], { cwd: 'tmp' });
    const order: string[] = [];
    child.onStdoutLine((l) => order.push(`line:${l}`));
    child.onExit((code) => order.push(`exit:${code}`));
    fake.emit('exit', 0); // 进程已退但 stdio 未排空——不得发退出通知（残行还可能在途）
    expect(order).toEqual([]);
    fake.stdout.emit('data', 'tail-line\n'); // exit 后到达的尾行仍派发
    expect(order).toEqual(['line:tail-line']);
    fake.stdout.emit('end');
    fake.emit('close', 0);
    expect(order).toEqual(['line:tail-line', 'exit:0']);
    expect(child.hasExited()).toBe(true);
  });

  it('spawn error（ENOENT 无 close）→ stderr 通道报错摘要 + 退出归一 code null（恰好一次）', () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy-missing.exe', [], { cwd: 'tmp' });
    const stderr: string[] = [];
    const exits: Array<number | null> = [];
    child.onStderrData((c) => stderr.push(c));
    child.onExit((code) => exits.push(code));
    fake.emit('error', new Error('spawn agy-missing.exe ENOENT'));
    expect(stderr).toEqual(['spawn agy-missing.exe failed: spawn agy-missing.exe ENOENT']);
    expect(exits).toEqual([null]);
    // 已死进程的后续注册立即回调。
    let lateExit: number | null | undefined;
    child.onExit((code) => {
      lateExit = code;
    });
    expect(lateExit).toBeNull();
  });

  it('writeLine：换行追加 + 背压（write 返 false → 等 drain 才 resolve）', async () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy.exe', [], { cwd: 'tmp' });
    fake.stdin.write = vi.fn<(chunk: string) => boolean>().mockReturnValueOnce(false).mockReturnValue(true);
    const pending = child.writeLine('{"event":"user"}');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false); // 背压：未 drain 不 resolve
    expect(fake.stdin.write).toHaveBeenCalledWith('{"event":"user"}\n');
    fake.stdin.emit('drain');
    await pending;
    expect(settled).toBe(true);
  });

  it('endStdin 桥接；kill = E3 树杀（win → taskkill /T /F；posix → 进程组杀）', () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy.exe', [], { cwd: 'tmp' });
    child.endStdin();
    expect(fake.stdin.end).toHaveBeenCalled();
    // 进程组杀经 spy 隔离（不向真实 pid 发信号）；树杀分支按运行平台分流断言。
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      child.kill();
      if (process.platform === 'win32') {
        expect(mockedExecFile).toHaveBeenCalledWith(
          'taskkill',
          expect.arrayContaining(['/PID', '4242', '/T', '/F']),
          expect.anything(),
        );
        expect(killSpy).not.toHaveBeenCalled();
      } else {
        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
        expect(fake.kill).not.toHaveBeenCalled();
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  it('CR-1：子进程已退 → kill 零信号（树杀绝不命中 OS 回收后的无关 pid/进程组）', () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy.exe', [], { cwd: 'tmp' });
    fake.emit('close', 0); // 进程已退 + stdio 排空（exited 归一——含 exit→close 窗口面）
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      child.kill();
      expect(mockedExecFile).not.toHaveBeenCalled(); // win：不派 taskkill
      expect(killSpy).not.toHaveBeenCalled(); // posix：不发组信号
      expect(fake.kill).not.toHaveBeenCalled(); // 不回落 plainKill
    } finally {
      killSpy.mockRestore();
    }
  });

  it('CR-2：taskkill 异步失败（ENOENT/access denied）→ 回调内 plainKill 回落', () => {
    const fake = armSpawn();
    const child = spawnRealCli('agy.exe', [], { cwd: 'tmp' });
    // 平台覆写：win 分支在任何 CI 平台都可测（treeKillDispatch 按调用时 process.platform 分派）。
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      child.kill();
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
      const callback = vi.mocked(mockedExecFile).mock.calls[0]![2] as (
        err: Error | null,
      ) => void;
      expect(fake.kill).not.toHaveBeenCalled(); // 成功路径零回落
      callback(new Error('spawn taskkill ENOENT'));
      expect(fake.kill).toHaveBeenCalledTimes(1); // 异步失败 → plainKill 兜底
      // 幂等杀报错（进程已死形态）同走回落——proc.kill() 对已死进程无害（返 false）。
      callback(new Error('process not found'));
      expect(fake.kill).toHaveBeenCalledTimes(2);
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('treeKillDispatch（E3 树杀分派纯函数——三平台分支零真进程）', () => {
  it('win32 → taskkill（含 /T /F 覆盖孙进程）；taskkill 抛错 → plainKill 回落', () => {
    const taskkill = vi.fn();
    const plainKill = vi.fn();
    treeKillDispatch({ platform: 'win32', pid: 4321, taskkill, groupKill: vi.fn(), plainKill });
    expect(taskkill).toHaveBeenCalledWith(4321);
    expect(plainKill).not.toHaveBeenCalled();

    const throwing = vi.fn(() => { throw new Error('taskkill not found'); });
    treeKillDispatch({ platform: 'win32', pid: 4321, taskkill: throwing, groupKill: vi.fn(), plainKill });
    expect(plainKill).toHaveBeenCalledTimes(1);
  });

  it('posix → groupKill（进程组）；组杀抛错（如 ESRCH）→ plainKill 回落', () => {
    const groupKill = vi.fn();
    const plainKill = vi.fn();
    treeKillDispatch({ platform: 'linux', pid: 99, taskkill: vi.fn(), groupKill, plainKill });
    expect(groupKill).toHaveBeenCalledWith(99);
    expect(plainKill).not.toHaveBeenCalled();

    const throwing = vi.fn(() => { throw new Error('ESRCH'); });
    treeKillDispatch({ platform: 'darwin', pid: 99, taskkill: vi.fn(), groupKill: throwing, plainKill });
    expect(plainKill).toHaveBeenCalledTimes(1);
  });

  it('pid 未知（spawn 同步失败形态）→ plainKill（两平台同）', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const plainKill = vi.fn();
      treeKillDispatch({ platform, pid: undefined, taskkill: vi.fn(), groupKill: vi.fn(), plainKill });
      expect(plainKill).toHaveBeenCalledTimes(1);
    }
  });
});
