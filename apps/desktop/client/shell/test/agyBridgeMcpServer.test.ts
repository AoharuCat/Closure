import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// ── 子4 W2：mcpServer.mjs 协议集成（真子进程 = 本仓静态资产 node 进程——零真 agy）──
//
// 覆盖面（W0 §5 实测序列为脚本依据）：server/discover 探针 -32601 回退 → initialize 回显
// protocolVersion → notifications/initialized 无响应 → tools/list 读 tools.json →
// tools/call 经管道（_meta 忽略）→ present_result 桥原生确认 + 管道通知 → stdin EOF 自退。

const TMP_ROOTS: string[] = [];

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  TMP_ROOTS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_ROOTS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const MCP_SERVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'resources',
  'agy-bridge',
  'mcpServer.mjs',
);

const TOOLS_JSON = [
  { name: 'write_chapter', description: '为指定章节触发完整写作流程。', inputSchema: { type: 'object' } },
  { name: 'present_result', description: '呈现结果并声明本轮结束。', inputSchema: { type: 'object' } },
];

interface FrameWaiter {
  predicate: (frame: Record<string, unknown>) => boolean;
  resolve: (frame: Record<string, unknown>) => void;
}

/** 测试侧 mcpServer 客户端（agy 的角色）：stdin NDJSON + stdout 帧等待。 */
class McpClient {
  readonly proc: ReturnType<typeof spawn>;
  private buffer = '';
  private readonly frames: Array<Record<string, unknown>> = [];
  private readonly waiters: FrameWaiter[] = [];
  exited: Promise<number | null>;

  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, [MCP_SERVER_PATH], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => {
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
    this.proc.stderr!.on('data', () => { /* 诊断输出静默（失败经帧等待超时暴露） */ });
    this.exited = new Promise<number | null>((resolve) => {
      this.proc.once('exit', (code) => resolve(code));
    });
  }

  send(frame: Record<string, unknown>): void {
    this.proc.stdin!.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown, id: number | string): Promise<Record<string, unknown>> {
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.waitFor((f) => f.id === id);
  }

  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mcp frame wait timeout')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  endStdin(): void {
    this.proc.stdin!.end();
  }
}

/** 伪桥管道 server（agyBridge 管道协议的 shell 侧角色）：hello 握手 + 调用应答。 */
class FakeBridgePipe {
  readonly server: net.Server;
  readonly received: Array<Record<string, unknown>> = [];
  private socket: net.Socket | undefined;
  private buffer = '';

  constructor(readonly pipeName: string, readonly token: string) {
    this.server = net.createServer((socket) => {
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
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
          this.received.push(frame);
          if (frame.op === 'hello') {
            socket.write(`${JSON.stringify({ op: 'welcome', ok: frame.token === this.token })}\n`);
            continue;
          }
          if (frame.op === 'call') {
            socket.write(`${JSON.stringify({ op: 'result', id: frame.id, ok: true, output: `EXECUTED:${String(frame.toolId)}` })}\n`);
            continue;
          }
          // present_result 通知：记录，无回执。
        }
      });
    });
    this.server.listen(pipeName);
  }

  close(): void {
    this.socket?.destroy();
    this.server.close();
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** 平台正确的测试管道名（win 命名管道 / posix unix socket——mirror bridgePipeName 形态）。 */
function testPipeName(salt: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orison-agy-bridge-test-${salt}`
    : path.join(os.tmpdir(), `orison-agy-bridge-test-${salt}.sock`);
}

describe('mcpServer.mjs 协议集成（真子进程，零真 agy）', () => {
  it('W0 §5 序列：discover -32601 → initialize 回显 → tools/list → call 管道往返（_meta 忽略）→ present_result 原生 + 通知 → EOF 自退', async () => {
    const dir = tempDir('agy-mcp-server-');
    const toolsJsonPath = path.join(dir, 'tools.json');
    writeFileSync(toolsJsonPath, JSON.stringify(TOOLS_JSON), 'utf8');
    const pipe = new FakeBridgePipe(testPipeName(Date.now()), 'tok-test-1');
    try {
      const client = new McpClient({
        ORISON_BRIDGE_PIPE: pipe.pipeName,
        ORISON_BRIDGE_TOKEN: 'tok-test-1',
        ORISON_BRIDGE_TOOLS_JSON: toolsJsonPath,
      });

      // ① server/discover 探针 → -32601（agy 自动回退标准握手）。
      const discover = await client.request('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }, 1);
      expect(discover.error).toMatchObject({ code: -32601 });

      // ② initialize → 回显客户端 protocolVersion + serverInfo novel-writing。
      const init = await client.request('initialize', {
        clientInfo: { name: 'antigravity-client', version: 'v1.0.0' },
        protocolVersion: '2025-11-25',
        capabilities: {},
      }, 2);
      expect(init.result).toMatchObject({
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'novel-writing' },
      });
      // notifications/initialized 无 id → 无响应（不挂起后续）。
      client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

      // ③ tools/list → tools.json 1:1。
      const list = await client.request('tools/list', {}, 3);
      expect(list.result).toEqual({ tools: TOOLS_JSON });

      // ④ tools/call 经管道（带 _meta——一律忽略）。
      const call = await client.request('tools/call', {
        _meta: { 'antigravity.google/conversation_id': 'conv-x', progressToken: 'p1' },
        name: 'write_chapter',
        arguments: { chapter: 1 },
      }, 4);
      expect(call.result).toMatchObject({ content: [{ type: 'text', text: 'EXECUTED:write_chapter' }] });
      await waitUntil(() => pipe.received.some((f) => f.op === 'call'));
      expect(pipe.received.find((f) => f.op === 'call')).toMatchObject({ toolId: 'write_chapter', arguments: { chapter: 1 } });

      // ⑤ present_result 桥原生：即时确认 + 管道通知（awaiting 透传）。
      const present = await client.request('tools/call', {
        name: 'present_result',
        arguments: { awaiting_intent_confirmation: true, summary: '方案已出' },
      }, 5);
      expect(present.result).toMatchObject({ content: [{ type: 'text', text: '已呈现（等用户确认意图）：方案已出' }] });
      await waitUntil(() => pipe.received.some((f) => f.op === 'present_result'));
      expect(pipe.received.find((f) => f.op === 'present_result')).toMatchObject({ awaiting: true, summary: '方案已出' });

      // ⑥ 未入面工具 → isError 结果。
      const unknown = await client.request('tools/call', { name: 'spawn_agent', arguments: {} }, 6);
      expect(unknown.result).toMatchObject({ isError: true });

      // ⑦ stdin EOF → 自退 exit 0。
      client.endStdin();
      expect(await client.exited).toBe(0);
    } finally {
      pipe.close();
    }
  });

  it('坏 token 握手 → 拒绝后 mcpServer 自退（belt 断连语义）', async () => {
    const dir = tempDir('agy-mcp-server-badtok-');
    const toolsJsonPath = path.join(dir, 'tools.json');
    writeFileSync(toolsJsonPath, JSON.stringify(TOOLS_JSON), 'utf8');
    const pipe = new FakeBridgePipe(testPipeName(Date.now() + 1), 'right-token');
    try {
      const client = new McpClient({
        ORISON_BRIDGE_PIPE: pipe.pipeName,
        ORISON_BRIDGE_TOKEN: 'wrong-token',
        ORISON_BRIDGE_TOOLS_JSON: toolsJsonPath,
      });
      // 首个经管道的工具调用触发连接 → welcome ok:false → shutdown。
      client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_chapter', arguments: {} } });
      const rejection = await client.waitFor((f) => f.id === 1);
      expect(rejection.result).toMatchObject({ isError: true });
      expect(await client.exited).toBe(4);
    } finally {
      pipe.close();
    }
  });

  it('welcome 握手超时（CR-9）：管道连上但首帧永不达 → 在途调用失败 + 自退（不等 30m 外层兜底）', async () => {
    const dir = tempDir('agy-mcp-server-silent-');
    const toolsJsonPath = path.join(dir, 'tools.json');
    writeFileSync(toolsJsonPath, JSON.stringify(TOOLS_JSON), 'utf8');
    // 沉默管道：接受连接但永不回 welcome（shell 侧卡死/占名假 server 形态）。
    const silent = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', () => { /* 读但永不写 */ });
      socket.on('error', () => { /* 断连静默 */ });
    });
    const pipePath = testPipeName(Date.now() + 2);
    silent.listen(pipePath);
    try {
      const client = new McpClient({
        ORISON_BRIDGE_PIPE: pipePath,
        ORISON_BRIDGE_TOKEN: 'tok-silent',
        ORISON_BRIDGE_TOOLS_JSON: toolsJsonPath,
        ORISON_BRIDGE_WELCOME_TIMEOUT_MS: '300', // 测试加速（生产默认 30s）
      });
      client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_chapter', arguments: {} } });
      const rejection = await client.waitFor((f) => f.id === 1, 10_000);
      expect(rejection.result).toMatchObject({ isError: true });
      expect(await client.exited).toBe(6); // 握手超时专用退出码
    } finally {
      silent.close();
    }
  });
});
