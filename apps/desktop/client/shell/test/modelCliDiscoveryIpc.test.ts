// 09-12 agy provider W4：`model:list-cli-models` 发现端点——`agy models` TSV 解析、
// 默认路径候选序、未登录/缺失/失败三态分类（零真进程：node:child_process 全程 mock，
// electron ipcMain.handle 同 modelProviderIpc.test.ts 套路）。
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handle, execFileMock } = vi.hoisted(() => ({
  handle: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}));

import {
  defaultAgyExecutableCandidates,
  discoverCliModels,
  parseAgyModelsTsv,
  registerModelCliDiscoveryIpc,
} from '../main/ipc/modelCliDiscoveryIpc';

type ExecCallback = (
  err: (Error & { code?: unknown; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

/** 按 matchee 分发的 fake execFile（file/args/opts/cb 形参签名钉死）。 */
function fakeExecFile(
  routes: Array<{ executable: string; err?: Error & { code?: unknown }; stdout?: string; stderr?: string }>,
) {
  execFileMock.mockImplementation(
    (file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const route = routes.find((r) => r.executable === file);
      if (!route) throw new Error(`unexpected execFile target: ${file} ${args.join(' ')}`);
      cb(route.err ?? null, route.stdout ?? '', route.stderr ?? '');
    },
  );
}

function enoent(executable: string): Error & { code: string } {
  const err = new Error(`spawn ${executable} ENOENT`) as Error & { code: string };
  err.code = 'ENOENT';
  return err;
}

// 装机实测形态（研究 R-E）：两列 tab 分隔 slug<TAB>显示名。
const SAMPLE_TSV = [
  'gemini-3.8-pro-high\tGemini 3.8 Pro (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6',
].join('\n');

describe('model CLI discovery IPC（09-12 agy provider W4）', () => {
  beforeEach(() => {
    handle.mockReset();
    execFileMock.mockReset();
  });

  describe('parseAgyModelsTsv', () => {
    it('parses the two-column TSV into RemoteModel rows (slug→id, display name→alias)', () => {
      const models = parseAgyModelsTsv(SAMPLE_TSV);
      expect(models).toEqual([
        { id: 'gemini-3.8-pro-high', capability: 'text', alias: 'Gemini 3.8 Pro (High)' },
        { id: 'gemini-3.8-flash-medium', capability: 'text', alias: 'Gemini 3.8 Flash (Medium)' },
        { id: 'claude-sonnet-4-6', capability: 'text', alias: 'Claude Sonnet 4.6' },
      ]);
    });

    it('tolerates CRLF and blank lines, dedupes repeated slugs', () => {
      const models = parseAgyModelsTsv(`a-model\tA\r\n\r\na-model\tA again\r\nb-model\tB\r\n`);
      expect(models).toEqual([
        { id: 'a-model', capability: 'text', alias: 'A' },
        { id: 'b-model', capability: 'text', alias: 'B' },
      ]);
    });

    // CR-12（09-12 agy provider CR 批）：噪声/横幕行（首列含空格/提示文案/箱线字符）
    // 不成假模型 id——白名单外整行跳过，不可被选中持久化。
    it('skips noise/banner rows whose first column is not a legal slug (CR-12)', () => {
      const models = parseAgyModelsTsv([
        'Available models:',                        // 提示行（冒号后空 → 首列含空格非法）
        '────────────',                              // 箱线字符
        'gemini-3.8-pro-high\tGemini 3.8 Pro (High)',
        '使用以下模型 Use --model <slug>',            // 双语横幅
        'gpt-oss-120b-medium\tGPT-OSS 120B',
      ].join('\n'));
      expect(models.map((m) => m.id)).toEqual(['gemini-3.8-pro-high', 'gpt-oss-120b-medium']);
    });

    it('falls back to the registry alias/capability when the display column is missing', () => {
      const models = parseAgyModelsTsv('claude-sonnet-4-6\ngpt-oss-120b-medium');
      // claude-* 命中 registry（capability text + 族别名）；未登记 slug 回落 id 本身。
      expect(models).toEqual([
        { id: 'claude-sonnet-4-6', capability: 'text', alias: 'Claude sonnet-4-6' },
        { id: 'gpt-oss-120b-medium', capability: 'text', alias: 'gpt-oss-120b-medium' },
      ]);
    });
  });

  describe('defaultAgyExecutableCandidates', () => {
    it('Windows: install-dir candidate first, then agy.exe on PATH', () => {
      const local = path.join('C:', 'Users', 'u', 'AppData', 'Local');
      expect(defaultAgyExecutableCandidates('win32', { LOCALAPPDATA: local })).toEqual([
        path.join(local, 'agy', 'bin', 'agy.exe'),
        'agy.exe',
      ]);
    });

    it('Windows without LOCALAPPDATA: homedir fallback derivation', () => {
      const expected = path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
      expect(defaultAgyExecutableCandidates('win32', {})).toEqual([expected, 'agy.exe']);
    });

    it('non-Windows: bare agy on PATH', () => {
      expect(defaultAgyExecutableCandidates('darwin', {})).toEqual(['agy']);
      expect(defaultAgyExecutableCandidates('linux', {})).toEqual(['agy']);
    });
  });

  describe('discoverCliModels', () => {
    it('explicit path: success parses TSV and echoes the executable', async () => {
      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', stdout: SAMPLE_TSV }]);
      const result = await discoverCliModels('C:/agy/bin/agy.exe');
      expect(result).toEqual({
        ok: true,
        resolvedExecutable: 'C:/agy/bin/agy.exe',
        models: [
          { id: 'gemini-3.8-pro-high', capability: 'text', alias: 'Gemini 3.8 Pro (High)' },
          { id: 'gemini-3.8-flash-medium', capability: 'text', alias: 'Gemini 3.8 Flash (Medium)' },
          { id: 'claude-sonnet-4-6', capability: 'text', alias: 'Claude Sonnet 4.6' },
        ],
      });
      expect(execFileMock).toHaveBeenCalledWith(
        'C:/agy/bin/agy.exe',
        ['models'],
        expect.objectContaining({ timeout: 30_000 }),
        expect.any(Function),
      );
    });

    it('explicit path miss: typed executable-not-found', async () => {
      fakeExecFile([{ executable: 'D:/missing/agy.exe', err: enoent('D:/missing/agy.exe') }]);
      const result = await discoverCliModels('D:/missing/agy.exe');
      expect(result).toEqual({
        ok: false,
        error: 'executable-not-found',
        detail: 'tried: D:/missing/agy.exe (ENOENT)',
      });
    });

    // CR-11（09-12 agy provider CR 批）：EACCES/EISDIR 与 ENOENT 同族——步行续试下一
    // 候选（首候选无执行权限/路径是目录不再中断整条探测链，PATH 兜底候选可达）。
    it('candidate walk continues past EACCES/EISDIR to the PATH fallback (CR-11)', async () => {
      const candidates = defaultAgyExecutableCandidates('win32', { LOCALAPPDATA: 'C:/L' });
      const eacces = new Error('EACCES: permission denied') as Error & { code: string };
      eacces.code = 'EACCES';
      const eisdir = new Error('EISDIR: illegal operation on a directory') as Error & { code: string };
      eisdir.code = 'EISDIR';
      fakeExecFile([
        { executable: candidates[0]!, err: eacces },
        { executable: 'agy.exe', err: eisdir },
      ]);
      const result = await discoverCliModels('  ', { platform: 'win32', env: { LOCALAPPDATA: 'C:/L' } });
      expect(result).toEqual({
        ok: false,
        error: 'executable-not-found',
        detail: `tried: ${candidates[0]!} (EACCES), agy.exe (EISDIR)`,
      });
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('EACCES on the first candidate still reaches a working PATH candidate (CR-11)', async () => {
      const candidates = defaultAgyExecutableCandidates('win32', { LOCALAPPDATA: 'C:/L' });
      const eacces = new Error('EACCES: permission denied') as Error & { code: string };
      eacces.code = 'EACCES';
      fakeExecFile([
        { executable: candidates[0]!, err: eacces },
        { executable: 'agy.exe', stdout: 'gemini-3.8-pro-high\tGemini 3.8 Pro (High)' },
      ]);
      const result = await discoverCliModels('', { platform: 'win32', env: { LOCALAPPDATA: 'C:/L' } });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolvedExecutable).toBe('agy.exe');
    });

    it('empty request: walks the default candidates, succeeding on the second', async () => {
      const candidates = defaultAgyExecutableCandidates('win32', { LOCALAPPDATA: 'C:/L' });
      fakeExecFile([
        { executable: candidates[0]!, err: enoent(candidates[0]!) },
        { executable: 'agy.exe', stdout: 'gemini-3.8-pro-high\tGemini 3.8 Pro (High)' },
      ]);
      // 受控 platform/env 经 DI 注入（execFile 缺省回落被 mock 的模块导入）。
      const result = await discoverCliModels('  ', { platform: 'win32', env: { LOCALAPPDATA: 'C:/L' } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedExecutable).toBe('agy.exe');
        expect(result.models).toHaveLength(1);
      }
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('stderr authentication failure maps to typed not-logged-in (no throw)', async () => {
      const err = new Error('agy models exited 1') as Error & { code: number };
      err.code = 1;
      fakeExecFile([{ executable: 'agy.exe', err, stderr: 'authentication required: run agy to log in' }]);
      const result = await discoverCliModels('agy.exe');
      expect(result).toEqual({ ok: false, error: 'not-logged-in' });
    });

    it('other non-zero failures map to discovery-failed with a stderr excerpt', async () => {
      const err = new Error('agy models exited 3') as Error & { code: number };
      err.code = 3;
      fakeExecFile([{ executable: 'agy.exe', err, stderr: 'boom: something broke' }]);
      const result = await discoverCliModels('agy.exe');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('discovery-failed');
        expect(result.detail).toContain('boom: something broke');
      }
    });

    it('exit 0 with no parseable rows reports failure (no empty success face)', async () => {
      fakeExecFile([{ executable: 'agy.exe', stdout: '\n \n' }]);
      const result = await discoverCliModels('agy.exe');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('discovery-failed');
        expect(result.detail).toContain('no parseable model rows');
      }
    });
  });

  describe('IPC handler', () => {
    it('registers under model:list-cli-models and forwards to the discovery core', async () => {
      fakeExecFile([{ executable: 'C:/agy/bin/agy.exe', stdout: SAMPLE_TSV }]);
      registerModelCliDiscoveryIpc();
      expect(handle).toHaveBeenCalledWith('model:list-cli-models', expect.any(Function));

      const [, handler] = handle.mock.calls[0]!;
      const result = await handler({}, { cliExecutable: 'C:/agy/bin/agy.exe' });
      expect(result).toMatchObject({ ok: true, resolvedExecutable: 'C:/agy/bin/agy.exe' });
    });

    it('rejects a non-string cliExecutable as a typed failure (模式 A, no throw)', async () => {
      registerModelCliDiscoveryIpc();
      const [, handler] = handle.mock.calls[0]!;
      const result = await handler({}, { cliExecutable: 42 });
      expect(result).toEqual({
        ok: false,
        error: 'discovery-failed',
        detail: 'cliExecutable must be a string',
      });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
