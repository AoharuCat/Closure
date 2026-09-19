// 多 OS R5：agyBridge 版本探测默认 runner 的 execFile 选项钉面——GUI 主进程 spawn
// 控制台程序（agy --version）时 Windows 理论上闪现 console 窗，windowsHide 必须在位。
// 默认 runner 平时不被测试触达（既有用例全部注入 run），本文件单独在 child_process 缝
// mock 锁定选项形态；mock 面收敛照抄 agyBridge.test.ts 的已证形态。
import { describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: vi.fn() }));

vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));

import { probeAgyCliVersion } from '../main/ipc/agyBridge';

describe('probeAgyCliVersion 默认 runner（多 OS R5 windowsHide 钉面）', () => {
  it('默认 execFile 选项 = 10s 超时 + windowsHide（与其余 spawn 点对齐）', async () => {
    execFileMock.mockImplementation(
      (_exe: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
        cb(null, 'agy version 1.2.2\n');
      },
    );
    const version = await probeAgyCliVersion('agy');
    expect(version).toBe('1.2.2');
    expect(execFileMock).toHaveBeenCalledWith(
      'agy',
      ['--version'],
      { timeout: 10_000, windowsHide: true },
      expect.any(Function),
    );
  });
});
