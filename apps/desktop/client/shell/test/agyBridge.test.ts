import { existsSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __getAgyBridgeCoreForTest,
  uninstallAgyBridgeCoreForTest,
  BRIDGE_MCP_SERVER_NAME,
} from '@orison/model-protocols';

const { handleToolExecuteMock } = vi.hoisted(() => ({
  handleToolExecuteMock: vi.fn(),
}));

// 三道闸执行路径走统一工具通道——本文件钉的是闸门次序与回程形态，通道自身行为在
// toolHandlers 各自测试内（mock 面收敛为 handleToolExecute 一点）。
vi.mock('../main/ipc/toolExecution', () => ({
  handleToolExecute: handleToolExecuteMock,
}));

import {
  AgyBridgeHomeError,
  assertFakeHomePath,
  BRIDGE_HOME_MAX_AGE_MS,
  bridgePipeName,
  createAgyBridgeRegistry,
  defaultAgyBridgeHomeRoot,
  executeBridgeToolCall,
  installShellAgyBridgeCore,
  isVerifiedAgyVersionBand,
  prepareBridgeHome,
  probeAgyCliVersion,
  sweepStaleBridgeHomes,
  VERIFIED_AGY_MAJOR_MINOR,
  type BridgeSessionRecord,
} from '../main/ipc/agyBridge';
import type { BridgeToolFaceEntry } from '@orison/model-protocols';

// ── 子4 W2：桥基座（假宿四件套 + 清扫守卫矩阵 + 三道闸 + 管道协议 + wiring）──
// 红线：真实 ~/.gemini 零触碰——全部 fs 面在 temp 根（realHome 为 fixture 根，非真 home）。

const TMP_ROOTS: string[] = [];

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  TMP_ROOTS.push(dir);
  return dir;
}

afterEach(() => {
  uninstallAgyBridgeCoreForTest();
  handleToolExecuteMock.mockReset();
  for (const dir of TMP_ROOTS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const FACE: BridgeToolFaceEntry[] = [
  { name: 'present_result', description: '呈现结果并声明本轮结束。', inputSchema: { type: 'object' } },
  { name: 'write_chapter', description: '为指定章节触发完整写作流程。', inputSchema: { type: 'object' } },
  { name: 'outline_update', description: '修订大纲。', inputSchema: { type: 'object' } },
];

// ── 假宿四件套 + marker + 真实 ~/.gemini 零触碰 ──

/** 递归快照（相对路径 + size + mtimeMs + isDir）——零触碰对拍用。 */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const relNext = rel === '' ? name : `${rel}/${name}`;
      const st = statSync(full);
      out.set(relNext, st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(full, relNext);
    }
  };
  walk(root, '');
  return out;
}

function buildRealHomeFixture(home: string): void {
  mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    JSON.stringify({ theme: 'dark', permissions: { allow: ['read_file(*)'], deny: ['run_command(rm *)'] } }),
    'utf8',
  );
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), '{"mcpServers":{"user-own":{}}}', 'utf8');
  mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'brain'), { recursive: true });
  writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'brain', 'conv-1.json'), '{"k":1}', 'utf8');
}

describe('agyBridge：prepareBridgeHome（四件套 + marker + 真实目录零触碰）', () => {
  it('四件套内容断言 + 真实 home 快照零变化（红线对拍）', async () => {
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    const homeRoot = tempDir('agy-bridge-root-');
    const homeDir = path.join(homeRoot, 'session-1');
    const before = snapshot(realHome);

    await prepareBridgeHome({
      homeDir,
      homeRoot,
      realHome,
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: '\\\\.\\pipe\\test-pipe',
      token: 'tok-1',
      tools: FACE,
      mcpServerPath: '/assets/mcpServer.mjs',
      execPath: '/electron/exe',
      pid: 4242,
      sessionId: 'session-1',
    });

    // ① .gemini 整拷（含凭据子树与用户 settings）。
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', 'conv-1.json'))).toBe(true);
    // ② mcp_config 全新写（用户 global mcpServers 被隔离——不合并）。
    const mcpConfig = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(mcpConfig.mcpServers)).toEqual([BRIDGE_MCP_SERVER_NAME]);
    const entry = mcpConfig.mcpServers[BRIDGE_MCP_SERVER_NAME]!;
    expect(entry.command).toBe('/electron/exe');
    expect(entry.args).toEqual(['/assets/mcpServer.mjs']);
    expect(entry.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      ORISON_BRIDGE_PIPE: '\\\\.\\pipe\\test-pipe',
      ORISON_BRIDGE_TOKEN: 'tok-1',
      ORISON_BRIDGE_TOOLS_JSON: path.join(homeDir, 'bridge', 'tools.json'),
    });
    // ③ settings verbatim 副本 + 预授权追加（用户 deny 随副本保全）。
    const settingsCopy = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as {
      theme: string;
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settingsCopy.theme).toBe('dark');
    expect(settingsCopy.permissions.allow).toEqual(['read_file(*)', `mcp(${BRIDGE_MCP_SERVER_NAME}/*)`]);
    expect(settingsCopy.permissions.deny).toEqual(['run_command(rm *)']);
    // ④ tools.json。
    expect(JSON.parse(readFileSync(path.join(homeDir, 'bridge', 'tools.json'), 'utf8'))).toEqual(FACE);
    // ⑤ marker。
    const marker = JSON.parse(readFileSync(path.join(homeDir, 'marker.json'), 'utf8')) as { pid: number; sessionId: string };
    expect(marker).toMatchObject({ pid: 4242, sessionId: 'session-1' });

    // 🔴 红线：真实 home 快照逐项不变（零写入）。
    expect(snapshot(realHome)).toEqual(before);
  });

  it('用户 settings 损坏 → 类型化阻断（不产出副本）；settings 缺失 → 副本基 {}', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const corruptHome = tempDir('agy-bridge-corrupt-');
    buildRealHomeFixture(corruptHome);
    writeFileSync(path.join(corruptHome, '.gemini', 'antigravity-cli', 'settings.json'), '{broken', 'utf8');
    const corruptHomeDir = path.join(homeRoot, 'c1');
    await expect(prepareBridgeHome({
      homeDir: corruptHomeDir,
      homeRoot,
      realHome: corruptHome,
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: 'p', token: 't', tools: [], mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'c1',
    })).rejects.toThrow(AgyBridgeHomeError);
    // CR-3：corrupt 预检先于一切拷贝——零字节已写假宿（半成品凭据副本不留盘）。
    expect(existsSync(corruptHomeDir)).toBe(false);

    const noSettingsHome = tempDir('agy-bridge-nosettings-');
    mkdirSync(path.join(noSettingsHome, '.gemini'), { recursive: true });
    const homeDir = path.join(homeRoot, 'c2');
    await prepareBridgeHome({
      homeDir, homeRoot, realHome: noSettingsHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'c2',
    });
    const settingsCopy = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as { permissions: { allow: string[] } };
    expect(settingsCopy.permissions.allow).toEqual([`mcp(${BRIDGE_MCP_SERVER_NAME}/*)`]);
  });

  it('CR-3：拷贝/写入中途失败 → catch 内清理已拷内容（半成品假宿不留盘）', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    // 注入失败：homeDir/.gemini 预置为普通文件 → 目录拷贝到文件路径必炸。
    const homeDir = path.join(homeRoot, 'c3');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(path.join(homeDir, '.gemini'), 'not-a-dir', 'utf8');
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'c3',
    })).rejects.toThrow();
    // 失败路径清理——整个半成品假宿（含预置残骸）删除，凭据副本零滞留。
    expect(existsSync(homeDir)).toBe(false);
  });

  it('CR-10：marker 归属其他 sessionId → typed 阻断（sanitize 撞段），他人假宿不误删', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    const homeDir = path.join(homeRoot, 'taken');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(path.join(homeDir, 'marker.json'), JSON.stringify({ pid: 1234, sessionId: 'someone-else' }), 'utf8');
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'mine',
    })).rejects.toThrow(AgyBridgeHomeError);
    expect(existsSync(path.join(homeDir, 'marker.json'))).toBe(true); // 他人假宿原样保留
    // 同 sessionId marker（清理失败的残留）→ force 覆盖照常准备。
    await prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'someone-else',
    });
    expect(existsSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'))).toBe(true);
  });

  it('路径守卫：假宿越出 homeRoot / 与真实目录重叠 → 阻断', () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    expect(() => assertFakeHomePath(tempDir('agy-elsewhere-'), homeRoot, realHome)).toThrow(AgyBridgeHomeError);
    expect(() => assertFakeHomePath(homeRoot, homeRoot, realHome)).toThrow(AgyBridgeHomeError);
    expect(() => assertFakeHomePath(path.join(homeRoot, 'x'), homeRoot, homeRoot)).toThrow(AgyBridgeHomeError);
    expect(() => assertFakeHomePath(path.join(homeRoot, 'x'), homeRoot, realHome)).not.toThrow();
    expect(defaultAgyBridgeHomeRoot('/home/u')).toBe(path.join('/home/u', '.orison', 'agy-bridge', 'home'));
  });
});

describe('agyBridge：启动清扫守卫（marker pid 判活矩阵）', () => {
  it('死 pid 删 / 活且非本进程跳 / 无 marker 删 / 本进程 pid 删 / 杂散文件删', async () => {
    const root = tempDir('agy-bridge-sweep-');
    const mk = (name: string, marker?: unknown): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      if (marker !== undefined) writeFileSync(path.join(dir, 'marker.json'), JSON.stringify(marker), 'utf8');
      return dir;
    };
    const dead = mk('dead', { pid: 11111, sessionId: 'a' });
    const foreign = mk('foreign', { pid: 22222, sessionId: 'b' });
    const noMarker = mk('nomarker');
    const own = mk('own', { pid: 999, sessionId: 'c' });
    const corrupt = mk('corrupt', 'not-json');
    const strayFile = path.join(root, 'stray.txt');
    writeFileSync(strayFile, 'x', 'utf8');

    const result = await sweepStaleBridgeHomes({
      homeRoot: root,
      ownPid: 999,
      isPidAlive: (pid) => pid === 22222, // 仅 22222 视为存活（另一实例）
    });
    expect(result.removed.sort()).toEqual([corrupt, dead, noMarker, own, strayFile].sort());
    expect(result.skipped).toEqual([{ dir: foreign, reason: 'live-foreign-pid' }]);
    expect(existsSync(foreign)).toBe(true);
  });

  it('CR-4 age 兜底：live-foreign-pid 但 marker/目录 mtime 超 7 天 → 照删（pid 回收形态）', async () => {
    const root = tempDir('agy-bridge-sweep-age-');
    const mkOld = (name: string): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'marker.json'), JSON.stringify({ pid: 22222, sessionId: name }), 'utf8');
      return dir;
    };
    const staleForeign = mkOld('stale-foreign'); // 判活永真（死 pid 被无关进程回收）
    const freshForeign = mkOld('fresh-foreign');
    const eightDaysAgo = new Date(Date.now() - BRIDGE_HOME_MAX_AGE_MS - 24 * 60 * 60 * 1000);
    utimesSync(path.join(staleForeign, 'marker.json'), eightDaysAgo, eightDaysAgo);
    utimesSync(staleForeign, eightDaysAgo, eightDaysAgo);

    const result = await sweepStaleBridgeHomes({
      homeRoot: root,
      ownPid: 999,
      isPidAlive: () => true, // 全部「存活」——纯靠 age 兜底分辨
    });
    expect(result.removed).toEqual([staleForeign]);
    expect(result.skipped).toEqual([{ dir: freshForeign, reason: 'live-foreign-pid' }]);
    expect(existsSync(staleForeign)).toBe(false);
    expect(existsSync(freshForeign)).toBe(true);
  });

  it('CR-4 运行期防护：ownPid 命中但会话注册表仍活跃 → 跳过（防删自家活动桥假宿）', async () => {
    const root = tempDir('agy-bridge-sweep-own-');
    const mk = (name: string, marker?: unknown): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      if (marker !== undefined) writeFileSync(path.join(dir, 'marker.json'), JSON.stringify(marker), 'utf8');
      return dir;
    };
    const activeOwn = mk('active-own', { pid: 999, sessionId: 'live-session' });
    const staleOwn = mk('stale-own', { pid: 999, sessionId: 'gone-session' });

    // 启动语义（无活跃集）：ownPid 残留照删。
    const startup = await sweepStaleBridgeHomes({ homeRoot: root, ownPid: 999, isPidAlive: () => true });
    expect(startup.removed.sort()).toEqual([activeOwn, staleOwn].sort());

    // 运行期误接线语义：活跃集内的会话假宿被守卫保住。
    const root2 = tempDir('agy-bridge-sweep-own2-');
    const mk2 = (name: string): string => {
      const dir = path.join(root2, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'marker.json'), JSON.stringify({ pid: 999, sessionId: name }), 'utf8');
      return dir;
    };
    const active = mk2('live-session');
    const stale = mk2('gone-session');
    const guarded = await sweepStaleBridgeHomes({
      homeRoot: root2,
      ownPid: 999,
      isPidAlive: () => true,
      activeSessionIds: new Set(['live-session']),
    });
    expect(guarded.removed).toEqual([stale]);
    expect(guarded.skipped).toEqual([{ dir: active, reason: 'live-foreign-pid' }]);
    expect(existsSync(active)).toBe(true);
  });
});

describe('agyBridge：版本带 + 探测（零真进程）', () => {
  it('1.2.x 在带内；其他版本带外；探测 runner 注入', async () => {
    expect(VERIFIED_AGY_MAJOR_MINOR).toBe('1.2');
    expect(isVerifiedAgyVersionBand('1.2.2')).toBe(true);
    expect(isVerifiedAgyVersionBand('v1.2.9')).toBe(true);
    expect(isVerifiedAgyVersionBand('1.3.0')).toBe(false);
    expect(isVerifiedAgyVersionBand('agy version 1.2.2')).toBe(false); // 前缀文本不匹配（探测层先提取）
    expect(await probeAgyCliVersion('agy', async () => 'agy version 1.2.2\n')).toBe('1.2.2');
    expect(await probeAgyCliVersion('agy', async () => '1.3.0')).toBe('1.3.0');
    expect(await probeAgyCliVersion('missing', async () => { throw new Error('spawn ENOENT'); })).toBeUndefined();
  });
});

// ── 三道闸（§5.2 等价重建——同一 toolPolicy 模块）──

function makeRecord(overrides: Partial<BridgeSessionRecord> = {}): BridgeSessionRecord {
  return {
    sessionId: 'session-1',
    projectDir: os.tmpdir(),
    permissionMode: 'suggest',
    face: FACE,
    faceNames: new Set(FACE.map((t) => t.name)),
    pipeName: 'pipe',
    token: 'tok',
    abortController: new AbortController(),
    callRecords: [],
    presentResult: { called: false, awaiting: undefined },
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe('agyBridge：三道闸（面外拒 / 档位强制 / 自审闸）', () => {
  it('闸1 面外：不在会话注册面 → 错误结果 + 不执行', async () => {
    const record = makeRecord();
    const result = await executeBridgeToolCall(record, 'write_file', {});
    expect(result).toMatchObject({ ok: false, gate: 'face' });
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('闸1b 权限档：readonly 档 write 类工具 → assertToolAllowed 拒绝文案回错误结果', async () => {
    // memory_update 须在会话面内（闸1 面外先于闸1b 权限档）——面内但 readonly 档拒。
    const face = [...FACE, { name: 'memory_update', description: '更新记忆。', inputSchema: { type: 'object' } }];
    const record = makeRecord({ permissionMode: 'readonly', face, faceNames: new Set(face.map((t) => t.name)) });
    const result = await executeBridgeToolCall(record, 'memory_update', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not allowed in readonly mode');
    expect(result).toMatchObject({ gate: 'policy' });
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('闸2 档位强制：suggest 档 diff 工具带 autoApply:true → 改写 autoApply:false 后执行', async () => {
    const record = makeRecord({ permissionMode: 'suggest' });
    handleToolExecuteMock.mockResolvedValue({ title: '大纲', output: '已修订' });
    const result = await executeBridgeToolCall(record, 'outline_update', { patch: [], autoApply: true, selfReviewConfirmed: true });
    expect(result.ok).toBe(true);
    expect(handleToolExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'outline_update',
      params: expect.objectContaining({ autoApply: false }),
      projectDir: record.projectDir,
      sessionId: record.sessionId,
      abort: record.abortController.signal,
    }));
  });

  it('闸3 自审闸：auto 档首发 autoApply:true 未自审 → 不执行，闸门文案作工具结果返回', async () => {
    const record = makeRecord({ permissionMode: 'auto' });
    const result = await executeBridgeToolCall(record, 'outline_update', { patch: [], autoApply: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('自审');
      expect(result.output).toContain('selfReviewConfirmed: true');
      expect(result.gate).toBe('self-review');
      expect(result.metadata).toMatchObject({ bridgeGate: 'self-review' });
    }
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('自审重发（selfReviewConfirmed:true）→ 放行执行；执行异常 → ok:false 错误结果', async () => {
    const record = makeRecord({ permissionMode: 'auto' });
    handleToolExecuteMock.mockResolvedValueOnce({ title: '大纲', output: '已修订' });
    const okResult = await executeBridgeToolCall(record, 'outline_update', { patch: [], autoApply: true, selfReviewConfirmed: true });
    expect(okResult).toMatchObject({ ok: true, output: '已修订' });
    expect(handleToolExecuteMock).toHaveBeenCalledTimes(1);

    handleToolExecuteMock.mockRejectedValueOnce(new Error('章节不存在'));
    const errResult = await executeBridgeToolCall(record, 'write_chapter', { chapter: 1 });
    expect(errResult).toMatchObject({ ok: false, error: '章节不存在' });
    expect('gate' in errResult ? errResult.gate : undefined).toBeUndefined();
    // 调用记录随管道帧一起落（此处直调不经注册表——记录面在管道路径测试）。
  });
});

// ── 注册表 + 管道协议 ──

interface FrameWaiter {
  predicate: (frame: Record<string, unknown>) => boolean;
  resolve: (frame: Record<string, unknown>) => void;
}

/** 测试侧管道客户端（mcpServer 的角色——hello 握手 + 行帧收发）。 */
class PipeClient {
  readonly socket: net.Socket;
  private buffer = '';
  private readonly waiters: FrameWaiter[] = [];
  readonly frames: Array<Record<string, unknown>> = [];

  constructor(pipeName: string) {
    this.socket = net.connect(pipeName);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.frames.push(frame);
        const idx = this.waiters.findIndex((w) => w.predicate(frame));
        if (idx >= 0) {
          const [waiter] = this.waiters.splice(idx, 1);
          waiter.resolve(frame);
        }
      }
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pipe frame wait timeout')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connectWithRetry(pipeName: string, timeoutMs = 5000): Promise<PipeClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const client = new PipeClient(pipeName);
      await new Promise<void>((resolve, reject) => {
        client.socket.once('connect', () => resolve());
        client.socket.once('error', (err) => reject(err));
      });
      return client;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe('agyBridge：注册表 + 管道协议（hello 握手 / 调用往返 / token 拒绝 / present_result 记录）', () => {
  it('全链往返：鉴权 → 工具调用 → 结果帧 + 调用记录；错 token 拒断；present_result 通知记录', async () => {
    handleToolExecuteMock.mockResolvedValue({ title: '写章', output: '第一章已完成' });
    const registry = createAgyBridgeRegistry();
    const { pipeName, token } = registry.openSession({
      sessionId: 'session-1',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    // CR-2 安全形态：管道名不含 token 任何片段——Windows 管道命名空间本机可枚举，
    // 枚举者只能拿到不可认证的端点（认证只经 hello 帧 token 比对）。
    expect(pipeName).not.toContain(token);
    expect(pipeName).toContain('orison-agy-bridge-');
    // 管道名派生自独立随机 id（bridgePipeName 入参 = 不透明 pipeId，非 token）。
    expect(pipeName).not.toBe(bridgePipeName(token));

    // 错 token：welcome ok:false + 断连。
    const bad = await connectWithRetry(pipeName);
    bad.send({ op: 'hello', token: 'wrong' });
    await bad.waitFor((f) => f.op === 'welcome');
    expect(bad.frames[0]).toMatchObject({ op: 'welcome', ok: false });
    bad.close();

    // 对 token：握手 + 调用往返。
    const client = await connectWithRetry(pipeName);
    client.send({ op: 'hello', token });
    await client.waitFor((f) => f.op === 'welcome' && f.ok === true);
    client.send({ op: 'call', id: 7, toolId: 'write_chapter', arguments: { chapter: 1 } });
    const resultFrame = await client.waitFor((f) => f.op === 'result' && f.id === 7);
    expect(resultFrame).toMatchObject({ op: 'result', id: 7, ok: true, output: '第一章已完成' });
    expect(handleToolExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'write_chapter',
      params: { chapter: 1 },
      projectDir: os.tmpdir(),
      sessionId: 'session-1',
    }));
    const record = registry.getSession('session-1')!;
    expect(record.callRecords).toHaveLength(1);
    expect(record.callRecords[0]).toMatchObject({ toolId: 'write_chapter', ok: true, output: '第一章已完成' });

    // 握手前业务帧 = 未鉴权断连。
    const naked = await connectWithRetry(pipeName);
    naked.send({ op: 'call', id: 1, toolId: 'write_chapter', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    naked.close();

    // present_result 通知 → 记录（无回执帧）。
    client.send({ op: 'present_result', awaiting: true, summary: '方案已出' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(record.presentResult).toMatchObject({ called: true, awaiting: true, summary: '方案已出' });

    // 执行异常路径。
    handleToolExecuteMock.mockRejectedValueOnce(new Error('工具炸了'));
    client.send({ op: 'call', id: 8, toolId: 'write_chapter', arguments: {} });
    const errFrame = await client.waitFor((f) => f.op === 'result' && f.id === 8);
    expect(errFrame).toMatchObject({ op: 'result', id: 8, ok: false, error: '工具炸了' });

    // 幂等开管道：同会话复用 pipe/token。
    expect(registry.openSession({
      sessionId: 'session-1', projectDir: os.tmpdir(), permissionMode: 'auto', face: FACE,
    })).toEqual({ pipeName, token });
    client.close();

    // revoke：会话出表 + 管道关闭（新连接失败 = token 吊销后的拒绝面；旧连接被强断）。
    expect(registry.revokeSession('session-1')).toBe(true);
    expect(registry.getSession('session-1')).toBeUndefined();
    await expect(connectWithRetry(pipeName, 800)).rejects.toThrow();
    registry.disposeAll();
  });
});

// ── CR-6/7/8：会话重建 / idle 回收 / 执行路径 reject 兜底 ──

describe('agyBridge：openSession 配置变更（CR-6）', () => {
  it('同 sessionId 变更权限档/面/项目目录 → revoke 旧会话重建（新管道新 token，旧管道关闭）', async () => {
    const registry = createAgyBridgeRegistry();
    const base = { sessionId: 'session-1', projectDir: 'C:/proj-a', permissionMode: 'suggest' as const, face: FACE };
    const first = registry.openSession(base);
    // 完全相同输入 → 幂等复用。
    expect(registry.openSession(base)).toEqual(first);

    // 权限档收紧（suggest → readonly）→ 重建：新 token/管道，注册表反映新档。
    const tightened = registry.openSession({ ...base, permissionMode: 'readonly' });
    expect(tightened.token).not.toBe(first.token);
    expect(tightened.pipeName).not.toBe(first.pipeName);
    expect(registry.getSession('session-1')?.permissionMode).toBe('readonly');
    expect(registry.getByToken(first.token)).toBeUndefined(); // 旧 token 吊销
    await expect(connectWithRetry(first.pipeName, 800)).rejects.toThrow(); // 旧管道已关

    // 面变更 / 项目目录变更同样触发重建。
    const biggerFace = [...FACE, { name: 'wiki_search', description: '检索维基。', inputSchema: { type: 'object' } }];
    const refaced = registry.openSession({ ...base, permissionMode: 'readonly', face: biggerFace });
    expect(refaced.token).not.toBe(tightened.token);
    const moved = registry.openSession({ ...base, permissionMode: 'readonly', face: biggerFace, projectDir: 'C:/proj-b' });
    expect(moved.token).not.toBe(refaced.token);
    registry.disposeAll();
  });
});

describe('agyBridge：桥会话 idle 回收（CR-7）', () => {
  it('超过 TTL 无帧活动 → 关管道 + 出表；帧活动刷新存活；无会话清扫器停摆', async () => {
    const timers: Array<{ fn: () => void; cleared: boolean; clear(): void }> = [];
    let nowValue = 1_000_000;
    const registry = createAgyBridgeRegistry({
      idleTtlMs: 1_000,
      sweepIntervalMs: 100,
      now: () => nowValue,
      setTimer: (fn, _ms) => {
        const timer = { fn, cleared: false, clear() { this.cleared = true; } };
        timers.push(timer);
        return timer;
      },
    });
    const opened = registry.openSession({
      sessionId: 'session-idle',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    expect(timers).toHaveLength(1); // openSession 武装清扫器

    // T+900 present_result 帧（活动）→ T+1000 清扫（自 T+900 起 100ms ≤ TTL）→ 存活。
    nowValue += 900;
    registry.recordPresentResult('session-idle', true, '活动中');
    nowValue += 100;
    timers[0]!.fn();
    expect(registry.getSession('session-idle')).toBeDefined();

    // 清扫后重武装（会话仍在）；T+2000（自 T+900 帧 activity 起 1100ms > TTL）→ 回收。
    expect(timers).toHaveLength(2);
    nowValue += 1_000;
    timers[1]!.fn();
    expect(registry.getSession('session-idle')).toBeUndefined();
    expect(registry.getByToken(opened.token)).toBeUndefined();
    await expect(connectWithRetry(opened.pipeName, 800)).rejects.toThrow(); // 管道已关

    // 无会话 → 清扫器停摆（不再重武装）。
    expect(timers).toHaveLength(2);
    registry.disposeAll();
  });

  it('hello/call 帧也刷新活动（管道交互即活跃）', async () => {
    handleToolExecuteMock.mockResolvedValue({ title: '写章', output: 'ok' });
    const timers: Array<{ fn: () => void; cleared: boolean; clear(): void }> = [];
    let nowValue = 1_000_000;
    const registry = createAgyBridgeRegistry({
      idleTtlMs: 1_000,
      sweepIntervalMs: 100,
      now: () => nowValue,
      setTimer: (fn, _ms) => {
        const timer = { fn, cleared: false, clear() { this.cleared = true; } };
        timers.push(timer);
        return timer;
      },
    });
    const { pipeName, token } = registry.openSession({
      sessionId: 'session-frames',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    const client = await connectWithRetry(pipeName);
    nowValue += 900;
    client.send({ op: 'hello', token });
    await client.waitFor((f) => f.op === 'welcome' && f.ok === true);
    nowValue += 900; // 自 hello 起 900ms < TTL
    client.send({ op: 'call', id: 1, toolId: 'write_chapter', arguments: {} });
    await client.waitFor((f) => f.op === 'result' && f.id === 1);
    nowValue += 900; // 自 call 起 900ms < TTL
    timers[0]!.fn();
    expect(registry.getSession('session-frames')).toBeDefined(); // 帧活动链保活
    client.close();
    registry.disposeAll();
  });
});

describe('agyBridge：执行路径 reject 兜底（CR-8）', () => {
  it('executeCall reject → 错误 result 帧（agy 不挂）+ 不成未处理拒绝', async () => {
    const registry = createAgyBridgeRegistry({
      executeCall: async () => { throw new Error('dispatch boom'); },
    });
    const { pipeName, token } = registry.openSession({
      sessionId: 'session-cr',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    const client = await connectWithRetry(pipeName);
    client.send({ op: 'hello', token });
    await client.waitFor((f) => f.op === 'welcome' && f.ok === true);
    client.send({ op: 'call', id: 9, toolId: 'write_chapter', arguments: {} });
    const frame = await client.waitFor((f) => f.op === 'result' && f.id === 9);
    expect(frame).toMatchObject({ op: 'result', id: 9, ok: false, error: 'dispatch boom' });
    client.close();
    registry.disposeAll();
  });
});

// ── 装配 wiring（漏装配红线）──

describe('agyBridge：installShellAgyBridgeCore wiring（model-protocols 内核装配钉死）', () => {
  it('install 后 model-protocols 探针非空 + writeHomePayload 走通真实四件套路径', async () => {
    expect(__getAgyBridgeCoreForTest()).toBeUndefined(); // 前置：未装配
    const realHome = tempDir('agy-bridge-wiring-real-');
    buildRealHomeFixture(realHome);
    const homeRoot = tempDir('agy-bridge-wiring-root-');
    const registry = installShellAgyBridgeCore({
      homeRoot,
      realHome,
      mcpServerPath: '/assets/mcpServer.mjs',
      execPath: '/electron/exe',
    });

    const core = __getAgyBridgeCoreForTest();
    expect(core).toBeDefined();
    expect(core!.homeRoot).toBe(homeRoot);
    // 内核 writeHomePayload → shell prepareBridgeHome 真实现（漏装配 = 生产全量降级而无红的对偶：装配了但没接到实现也在此红）。
    const homeDir = path.join(homeRoot, 'session-w');
    await core!.writeHomePayload({
      homeDir,
      sessionId: 'session-w',
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: 'p-w',
      token: 't-w',
      tools: FACE,
    });
    const mcpConfig = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcpConfig.mcpServers)).toEqual([BRIDGE_MCP_SERVER_NAME]);
    expect(JSON.parse(readFileSync(path.join(homeDir, 'marker.json'), 'utf8'))).toMatchObject({ sessionId: 'session-w' });
    // openBridgeSession → 注册表。
    const opened = await core!.openBridgeSession({ sessionId: 'session-o', projectDir: os.tmpdir(), permissionMode: 'auto', face: FACE });
    expect(registry.getSession('session-o')?.token).toBe(opened.token);
    registry.disposeAll();
  });
});

// 静态资产在位守卫（构建期拷贝的源文件——丢资产 = prod spawn 哑火）。
describe('agyBridge：mcpServer.mjs 资产在位', () => {
  it('resources/agy-bridge/mcpServer.mjs 存在且含协议关键锚点', () => {
    const assetPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'agy-bridge', 'mcpServer.mjs');
    expect(existsSync(assetPath)).toBe(true);
    const source = readFileSync(assetPath, 'utf8');
    expect(source).toContain('server/discover');
    expect(source).toContain('-32601');
    expect(source).toContain('protocolVersion');
    expect(source).toContain('present_result');
    expect(source).toContain('ORISON_BRIDGE_TOOLS_JSON');
    expect(source).toContain('novel-writing');
  });
});
