import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../logger';
import type { McpServerConfig } from './config';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';

  constructor(private name: string, private config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`MCP server "${this.name}" has no command configured`);
    }

    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      // windowsHide 与其余 spawn 点对齐（多 OS R6）：agent 跑在 GUI 进程内，spawn 控制台
      // 程序在 Windows 理论上闪现 console 窗。
      windowsHide: true,
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      logger.warn({ server: this.name }, chunk.toString().trim());
    });

    // spawn 失败（ENOENT/权限等）：child_process 的 'error' 事件无监听 = uncaught
    // exception 崩主进程（多 OS R6 崩溃级补齐）。归一为类型化失败：reject 全部在途
    // 请求（initialize 握手是首个消费者，否则此处直接挂死）——mirror antigravityCli
    // driver.ts spawn error 归一范式。
    this.process.on('error', (err: Error) => {
      logger.warn({ server: this.name }, `spawn failed: ${err.message}`);
      this.failPending(new Error(`MCP server "${this.name}" spawn failed: ${err.message}`));
      this.process = null;
    });

    this.process.on('exit', (code) => {
      logger.info({ server: this.name, code }, 'MCP server exited');
      this.process = null;
    });

    // 在途请求判死挂 'close' 而非 'exit'：close 晚于 exit（stdio 全排空），server 死前
    // 末批响应先经 data 解析派发，剩余 pending 才 reject——否则「响应后退出」的常态
    // 会让在途请求永挂（mirror driver 退出通知挂 close 的同一理由）。
    this.process.on('close', () => {
      this.failPending(new Error(`MCP server "${this.name}" exited before responding`));
    });

    // stdin 持久 error 兜底：子进程死后 stdin.write 的 EPIPE 可能异步落在两次写之间，
    // 无监听 'error' = uncaught exception 崩主进程。空 handler 吞掉：该请求的失败由
    // 上方 close 归一 reject（与 driver.ts 同款纪律）。
    this.process.stdin?.on('error', () => {});

    // Initialize
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orison-agent', version: '0.1.0' },
    });
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const result = await this.request('tools/list', {}) as { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }) as { content: Array<{ type: string; text?: string }> };
    return result.content?.map(c => c.text ?? '').join('\n') ?? '';
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  /** reject 全部在途请求并清表（error/close 归一的单一消费点——清表后二次归一无害）。 */
  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        return reject(new Error('MCP server not connected'));
      }

      const id = this.nextId++;
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // ignore malformed lines
      }
    }
  }
}
