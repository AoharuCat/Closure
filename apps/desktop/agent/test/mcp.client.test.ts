import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

// ── mcp/client.ts 崩溃面补齐（多 OS R6）──
//
// 零真进程纪律：vi.mock 在 node:child_process spawn 缝注入 fake child，专测「无监听
// 'error' = uncaught exception 崩主进程」三类面的归一形态——spawn 失败 / 进程死后
// stdin EPIPE / server 中途退出时在途请求判死。用例自身跑完不崩 = 归一生效的直接证据。

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn as mockedSpawn } from 'node:child_process';
import { McpClient } from '../src/mcp/client';

type FakeWritable = EventEmitter & { write: (chunk: string) => boolean };

interface FakeChild extends EventEmitter {
  stdin: FakeWritable;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const proc = new EventEmitter() as FakeChild;
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(() => true) }) as FakeWritable;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('McpClient spawn 失败归一（多 OS R6 崩溃面补齐）', () => {
  beforeEach(() => {
    vi.mocked(mockedSpawn).mockReset();
  });

  it('spawn ENOENT → connect 以类型化失败 reject，不崩主进程；spawn 选项带 windowsHide', async () => {
    const fake = makeFakeChild();
    vi.mocked(mockedSpawn).mockImplementation(() => fake as unknown as ChildProcess);
    const client = new McpClient('fs', { command: 'missing-mcp-server' });
    const connecting = client.connect();
    // ENOENT 形态：child 发 'error'、无 'exit'/'close'——归一 reject initialize 握手。
    fake.emit('error', new Error('spawn missing-mcp-server ENOENT'));
    await expect(connecting).rejects.toThrow(
      'MCP server "fs" spawn failed: spawn missing-mcp-server ENOENT',
    );
    // 归一后重复 error 不再抛（监听持久在 child 上——测试不崩即证）。
    expect(() => fake.emit('error', new Error('late error'))).not.toThrow();
    expect(mockedSpawn).toHaveBeenCalledWith(
      'missing-mcp-server',
      [],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('server 中途退出 → 在途请求在 close（stdio 排空后）判死 reject，不永挂', async () => {
    const fake = makeFakeChild();
    vi.mocked(mockedSpawn).mockImplementation(() => fake as unknown as ChildProcess);
    const client = new McpClient('broken', { command: 'not-an-mcp-server' });
    const connecting = client.connect();
    // exit → close 序：exit 时仍在途（不抢跑），close（stdio 排空）才判死。
    fake.emit('exit', 1);
    let settled = false;
    void connecting.catch(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    fake.emit('close', 1);
    await expect(connecting).rejects.toThrow('MCP server "broken" exited before responding');
  });

  it('进程死后 stdin EPIPE → 持久空 handler 吞掉，无 uncaught（后续请求类型化拒绝）', async () => {
    const fake = makeFakeChild();
    vi.mocked(mockedSpawn).mockImplementation(() => fake as unknown as ChildProcess);
    const client = new McpClient('fs', { command: 'mcp-server' });
    const connecting = client.connect();
    fake.emit('exit', 0);
    fake.emit('close', 0);
    await expect(connecting).rejects.toThrow('exited before responding');
    // 写已受理、flush 前进程死掉的异步 EPIPE 落在 close 之后——无监听即崩。
    expect(() => fake.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
    // 死后新请求走 not-connected 守卫类型化拒绝（不写死管道、不挂起）。
    await expect(client.callTool('ping', {})).rejects.toThrow('MCP server not connected');
  });
});
