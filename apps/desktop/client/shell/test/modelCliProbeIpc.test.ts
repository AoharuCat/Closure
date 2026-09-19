// 09-19 dogfood R4：CLI 型 provider 凭据探针——三态分类纯函数（ok/auth-dead/error/超时）、
// 探针内核（spawn 形态/在途去重/转变通知防骚扰）、启动自动扫（无 CLI key 零进程）与
// IPC 两通道形状（零真进程：node:child_process 全程 mock，electron ipcMain.handle +
// configIpc 读面 mock，同 modelCliDiscoveryIpc.test.ts 套路）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';

const { handle, execFileMock, configModule } = vi.hoisted(() => ({
  handle: vi.fn(),
  execFileMock: vi.fn(),
  configModule: { readModelConfigFromDisk: vi.fn() },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  // toolNotify 顶层 import BrowserWindow——探针测试注入 notify，广播面不会被触发，
  // 这里给个空壳防 import 期炸。
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}));

vi.mock('../main/ipc/configIpc', () => configModule);

import {
  _resetModelCliProbeStoreForTest,
  classifyCliProbeOutcome,
  probeConfiguredCliKeysOnStartup,
  registerModelCliProbeIpc,
  runCliProbeForKey,
  type ModelCliProbeDeps,
} from '../main/ipc/modelCliProbeIpc';

type ExecCallback = (
  err: (Error & { code?: unknown; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

/** 受控时钟（probedAt 断言确定性）。 */
const FIXED_NOW = new Date('2026-09-19T00:30:00Z');

function baseDeps(overrides: Partial<ModelCliProbeDeps> = {}): ModelCliProbeDeps {
  return {
    execFile: execFileMock as unknown as ModelCliProbeDeps['execFile'],
    tmpDir: '/test-tmp',
    now: () => FIXED_NOW,
    readConfig: configModule.readModelConfigFromDisk,
    notify: vi.fn(),
    ...overrides,
  };
}

function cliKeyConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    keys: [
      {
        id: 'agy1',
        name: 'Antigravity',
        protocol: 'antigravity-cli',
        cliExecutable: 'C:/agy/bin/agy.exe',
        models: [],
      },
    ],
    ...overrides,
  };
}

/** 按 matchee 分发的 fake execFile（file/args/opts/cb 形参签名钉死）。 */
function fakeExecFile(
  routes: Array<{
    executable: string;
    err?: Error & { code?: unknown; killed?: boolean };
    stdout?: string;
    stderr?: string;
  }>,
) {
  execFileMock.mockImplementation(
    (file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const route = routes.find((r) => r.executable === file);
      if (!route) throw new Error(`unexpected execFile target: ${file} ${args.join(' ')}`);
      cb(route.err ?? null, route.stdout ?? '', route.stderr ?? '');
    },
  );
}

function killedTimeout(): Error & { killed: boolean; code: number } {
  const err = new Error("Command failed: C:/agy/bin/agy.exe -p hi") as Error & {
    killed: boolean;
    code: number;
  };
  err.killed = true;
  err.code = 1;
  return err;
}

beforeEach(() => {
  handle.mockReset();
  execFileMock.mockReset();
  configModule.readModelConfigFromDisk.mockReset();
  _resetModelCliProbeStoreForTest();
});

describe('CLI 凭据探针（09-19 dogfood R4）', () => {
  describe('classifyCliProbeOutcome（三态分类纯函数）', () => {
    it('exit 0 且 stdout 非空且无认证信号 → ok', () => {
      expect(classifyCliProbeOutcome(null, 'Hello! How can I help?', '')).toEqual({ status: 'ok' });
    });

    it('exit 1 且 stderr 命中认证词表 → auth-dead', () => {
      const err = new Error('agy exited 1') as Error & { code: number };
      err.code = 1;
      expect(
        classifyCliProbeOutcome(err, '', 'authentication required: run agy to log in'),
      ).toEqual({ status: 'auth-dead' });
    });

    it('exit 0 且 stderr 命中认证词表仍 auth-dead（词表判定先于 exit 码）', () => {
      expect(
        classifyCliProbeOutcome(null, 'Hello!', 'Authentication required. Please log in first.'),
      ).toEqual({ status: 'auth-dead' });
    });

    it('stderr 裸 401 状态行命中词表 → auth-dead', () => {
      expect(classifyCliProbeOutcome(null, '', 'status: 401')).toEqual({ status: 'auth-dead' });
    });

    it('stdout 正文含 401 字样不当死票（stdout 不进认证词表，只用于非空判定）', () => {
      expect(
        classifyCliProbeOutcome(null, 'HTTP 401 means the request lacks valid credentials.', ''),
      ).toEqual({ status: 'ok' });
    });

    it('exit 0 且 stdout 空白 → error（无生成即无凭据证据，不当成功）', () => {
      const verdict = classifyCliProbeOutcome(null, '  \n', '');
      expect(verdict.status).toBe('error');
      expect(verdict.status === 'error' && verdict.detail).toContain('empty output');
    });

    it('非零崩溃（无认证信号）→ error，detail 带原始 stderr 摘要', () => {
      const err = new Error('agy exited 3') as Error & { code: number };
      err.code = 3;
      const verdict = classifyCliProbeOutcome(err, '', 'boom: something broke');
      expect(verdict.status).toBe('error');
      expect(verdict.status === 'error' && verdict.detail).toContain('boom: something broke');
    });

    it('超时（execFile killed）→ error，detail 注明时限', () => {
      const verdict = classifyCliProbeOutcome(killedTimeout(), '', '');
      expect(verdict.status).toBe('error');
      expect(verdict.status === 'error' && verdict.detail).toContain('timed out after 30s');
    });
  });

  describe('runCliProbeForKey（探针内核）', () => {
    it('spawn 形态：`<executable> -p "hi"`，cwd = 注入 tmpDir，30s 超时', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', stdout: 'hi there' }]);
      const deps = baseDeps();
      const snapshot = await runCliProbeForKey('agy1', deps);
      expect(snapshot).toEqual({
        keyId: 'agy1',
        status: 'ok',
        probedAt: FIXED_NOW.toISOString(),
      });
      expect(execFileMock).toHaveBeenCalledWith(
        'C:/agy/bin/agy.exe',
        ['-p', 'hi'],
        expect.objectContaining({ timeout: 30_000, cwd: '/test-tmp', windowsHide: true }),
        expect.any(Function),
      );
    });

    it('key 不存在 / 非 CLI 形态 / 缺 cliExecutable → error 快照（不 throw）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue({
        keys: [
          { id: 'http1', name: 'Relay', protocol: 'openai-compatible', baseUrl: 'https://x', apiKey: 'k', models: [] },
          { id: 'agy_broken', name: 'Broken', protocol: 'antigravity-cli', models: [] },
        ],
      });
      const deps = baseDeps();
      for (const keyId of ['missing', 'http1', 'agy_broken']) {
        const snapshot = await runCliProbeForKey(keyId, deps);
        expect(snapshot.status).toBe('error');
        expect(snapshot.status === 'error' && snapshot.detail).toContain(keyId);
      }
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('auth-dead 转变推一次通知；连续 auth-dead 不重推；回 ok 再转 auth-dead 再推', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      const deps = baseDeps();
      const authErr = new Error('agy exited 1') as Error & { code: number };
      authErr.code = 1;

      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', err: authErr, stderr: 'not logged in' }]);
      await runCliProbeForKey('agy1', deps);
      expect(deps.notify).toHaveBeenCalledTimes(1);
      expect(deps.notify).toHaveBeenCalledWith({
        type: 'cli:auth-dead',
        keys: [{ keyId: 'agy1', keyName: 'Antigravity' }],
      });

      // 连续 auth-dead（重测都红）——以内存上次结果为准，不重推。
      await runCliProbeForKey('agy1', deps);
      expect(deps.notify).toHaveBeenCalledTimes(1);

      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', stdout: 'hello' }]);
      const recovered = await runCliProbeForKey('agy1', deps);
      expect(recovered.status).toBe('ok');
      expect(deps.notify).toHaveBeenCalledTimes(1);

      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', err: authErr, stderr: 'not logged in' }]);
      await runCliProbeForKey('agy1', deps);
      expect(deps.notify).toHaveBeenCalledTimes(2);
    });

    it('readConfig 抛错 → 该 key 的 error 快照（模式 A，不向上抛）', async () => {
      configModule.readModelConfigFromDisk.mockImplementation(() => {
        throw new Error('config file unreadable');
      });
      const deps = baseDeps();
      const snapshot = await runCliProbeForKey('agy1', deps);
      expect(snapshot.status).toBe('error');
      expect(snapshot.status === 'error' && snapshot.detail).toContain('config file unreadable');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('同 key 并发触发共享在途 promise（不并发起第二次生成）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        gate.then(() => cb(null, 'hello', ''));
      });
      const deps = baseDeps();
      const first = runCliProbeForKey('agy1', deps);
      const second = runCliProbeForKey('agy1', deps);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      // 在途表清理：完成后再次触发会重新生成（手动重测语义）。
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        cb(null, 'hello again', '');
      });
      const third = await runCliProbeForKey('agy1', deps);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(third.status).toBe('ok');
    });
  });

  describe('probeConfiguredCliKeysOnStartup（启动自动扫）', () => {
    it('无任何 CLI key → 零进程零快照（存在任一 CLI key 才探）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue({
        keys: [
          { id: 'http1', name: 'Relay', protocol: 'openai-compatible', baseUrl: 'https://x', apiKey: 'k', models: [] },
        ],
      });
      const results = await probeConfiguredCliKeysOnStartup(baseDeps());
      expect(results).toEqual([]);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('两个 CLI key 逐个串行探完，快照齐回', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue({
        keys: [
          { id: 'agy1', name: 'A1', protocol: 'antigravity-cli', cliExecutable: 'C:/agy/a.exe', models: [] },
          { id: 'agy2', name: 'A2', protocol: 'antigravity-cli', cliExecutable: 'C:/agy/b.exe', models: [] },
        ],
      });
      fakeExecFile([
        { executable: 'C:/agy/a.exe', stdout: 'hello' },
        { executable: 'C:/agy/b.exe', stderr: 'authenticat', err: Object.assign(new Error('exit 1'), { code: 1 }) },
      ]);
      const deps = baseDeps();
      const results = await probeConfiguredCliKeysOnStartup(deps);
      expect(results.map((r) => `${r.keyId}:${r.status}`)).toEqual(['agy1:ok', 'agy2:auth-dead']);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      // 扫内单 key 死票：扫完同样走单次合并通知（单元素 keys）。
      expect(deps.notify).toHaveBeenCalledTimes(1);
      expect(deps.notify).toHaveBeenCalledWith({
        type: 'cli:auth-dead',
        keys: [{ keyId: 'agy2', keyName: 'A2' }],
      });
    });

    it('坏 key（缺 cliExecutable）error 快照入库，不中断其余 key 的探测', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue({
        keys: [
          { id: 'agy_broken', name: 'Broken', protocol: 'antigravity-cli', models: [] },
          { id: 'agy2', name: 'A2', protocol: 'antigravity-cli', cliExecutable: 'C:/agy/b.exe', models: [] },
        ],
      });
      fakeExecFile([{ executable: 'C:/agy/b.exe', stdout: 'hello' }]);
      const results = await probeConfiguredCliKeysOnStartup(baseDeps());
      expect(results.map((r) => `${r.keyId}:${r.status}`)).toEqual(['agy_broken:error', 'agy2:ok']);
    });

    it('单 key 探测抛错 → error 快照入库，不中断其余 key 的探测', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue({
        keys: [
          { id: 'agy_boom', name: 'Boom', protocol: 'antigravity-cli', cliExecutable: 'C:/agy/boom.exe', models: [] },
          { id: 'agy2', name: 'A2', protocol: 'antigravity-cli', cliExecutable: 'C:/agy/b.exe', models: [] },
        ],
      });
      execFileMock.mockImplementation((file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        if (file === 'C:/agy/boom.exe') throw new Error('spawn ENOENT simulated');
        cb(null, 'hello', '');
      });
      const results = await probeConfiguredCliKeysOnStartup(baseDeps());
      expect(results.map((r) => `${r.keyId}:${r.status}`)).toEqual(['agy_boom:error', 'agy2:ok']);
      expect(results[0]).toMatchObject({ status: 'error' });
      expect(results[0]?.status === 'error' && results[0].detail).toContain('spawn ENOENT simulated');
    });

    it('启动扫多 key 死票合并为单次通知（keys 多元素，renderer 单 toast 不堆叠）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue({
        keys: [
          { id: 'agy1', name: 'A1', protocol: 'antigravity-cli', cliExecutable: 'C:/agy/a.exe', models: [] },
          { id: 'agy2', name: 'A2', protocol: 'antigravity-cli', cliExecutable: 'C:/agy/b.exe', models: [] },
        ],
      });
      const authErr = new Error('agy exited 1') as Error & { code: number };
      authErr.code = 1;
      fakeExecFile([
        { executable: 'C:/agy/a.exe', err: authErr, stderr: 'not logged in' },
        { executable: 'C:/agy/b.exe', err: authErr, stderr: 'authentication required' },
      ]);
      const deps = baseDeps();
      await probeConfiguredCliKeysOnStartup(deps);
      expect(deps.notify).toHaveBeenCalledTimes(1);
      expect(deps.notify).toHaveBeenCalledWith({
        type: 'cli:auth-dead',
        keys: [
          { keyId: 'agy1', keyName: 'A1' },
          { keyId: 'agy2', keyName: 'A2' },
        ],
      });
    });
  });

  describe('超时树杀（CR-8）', () => {
    function timeoutErr(): Error & { killed: boolean } {
      const err = new Error('Command failed: killed') as Error & { killed: boolean };
      err.killed = true;
      return err;
    }

    function fakeChild(overrides: { pid?: number; exitCode?: number | null } = {}) {
      return {
        pid: 4321,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
        ...overrides,
      };
    }

    it('win 超时路径：killed 后对子进程 pid 发 taskkill /T /F', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      const child = fakeChild();
      execFileMock.mockImplementation((file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        if (file === 'taskkill') {
          cb(null, '', '');
          return child;
        }
        // 真实 execFile 语义：回调异步到——child 赋值完成后才触发树杀路径。
        queueMicrotask(() => cb(timeoutErr(), '', ''));
        return child;
      });
      const snapshot = await runCliProbeForKey('agy1', baseDeps());
      expect(snapshot.status).toBe('error');
      const taskkillCall = execFileMock.mock.calls.find((c) => c[0] === 'taskkill');
      if (process.platform === 'win32') {
        expect(taskkillCall).toBeDefined();
        expect(taskkillCall![1]).toEqual(['/PID', '4321', '/T', '/F']);
      } else {
        // posix 无 taskkill：回落 SIGKILL 直杀。
        expect(taskkillCall).toBeUndefined();
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      }
    });

    it('子进程已退（exitCode 落值）→ 不补杀（防 pid 复用误杀）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      const child = fakeChild({ exitCode: 1 });
      execFileMock.mockImplementation((file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        if (file === 'taskkill') {
          cb(null, '', '');
          return child;
        }
        queueMicrotask(() => cb(timeoutErr(), '', ''));
        return child;
      });
      await runCliProbeForKey('agy1', baseDeps());
      expect(execFileMock.mock.calls.some((c) => c[0] === 'taskkill')).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  describe('IPC 两通道', () => {
    function handlerFor(channel: string): (event: unknown, payload?: unknown) => unknown {
      const call = handle.mock.calls.find((c) => c[0] === channel);
      if (!call) throw new Error(`channel not registered: ${channel}`);
      return call[1] as (event: unknown, payload?: unknown) => unknown;
    }

    it('注册两个通道：model:cli-probe-status / model:cli-probe-run', () => {
      registerModelCliProbeIpc();
      const channels = handle.mock.calls.map((c) => c[0]);
      expect(channels).toContain('model:cli-probe-status');
      expect(channels).toContain('model:cli-probe-run');
    });

    it('status 读取：有结果回快照；已删 key 的残留内存条目被过滤', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', stdout: 'hello' }]);
      registerModelCliProbeIpc();
      await runCliProbeForKey('agy1', baseDeps());

      const statusHandler = handlerFor('model:cli-probe-status');
      const live = (await statusHandler({})) as Record<string, { keyId: string; status: string }>;
      expect(live.agy1).toMatchObject({ keyId: 'agy1', status: 'ok' });

      // key 删除后：内存残留不外泄。
      configModule.readModelConfigFromDisk.mockReturnValue({ keys: [] });
      const afterDelete = (await statusHandler({})) as Record<string, unknown>;
      expect(afterDelete).toEqual({});
    });

    it('status 读取：无任何探针结果 → 空对象（renderer 渲染未探测态）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      registerModelCliProbeIpc();
      const statusHandler = handlerFor('model:cli-probe-status');
      expect(await statusHandler({})).toEqual({});
    });

    it('run 触发：即时返回新快照并入库', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', stdout: 'hello' }]);
      registerModelCliProbeIpc();
      const runHandler = handlerFor('model:cli-probe-run');
      const snapshot = (await runHandler({}, { keyId: 'agy1' })) as {
        keyId: string;
        status: string;
        probedAt: string;
      };
      expect(snapshot).toMatchObject({ keyId: 'agy1', status: 'ok' });
      expect(typeof snapshot.probedAt === 'string' && !Number.isNaN(Date.parse(snapshot.probedAt))).toBe(true);
    });

    it('run 触发：病态载荷（keyId 缺失/非字符串）→ error 快照（模式 A，不 throw）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      registerModelCliProbeIpc();
      const runHandler = handlerFor('model:cli-probe-run');
      for (const payload of [undefined, {}, { keyId: 42 }, { keyId: '  ' }]) {
        const snapshot = (await runHandler({}, payload)) as { keyId: string; status: string; detail?: string };
        expect(snapshot.status).toBe('error');
        expect(snapshot.detail).toContain('keyId must be a non-empty string');
      }
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('run 触发：未知 keyId → error 快照（可诊断，不 throw）', async () => {
      configModule.readModelConfigFromDisk.mockReturnValue(cliKeyConfig());
      registerModelCliProbeIpc();
      const runHandler = handlerFor('model:cli-probe-run');
      const snapshot = (await runHandler({}, { keyId: 'ghost' })) as { status: string; detail?: string };
      expect(snapshot.status).toBe('error');
      expect(snapshot.detail).toContain('ghost');
    });
  });
});
