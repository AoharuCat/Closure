#!/usr/bin/env node
// agy MCP 工具桥——stdio MCP server 最小实现（agy 按假宿 mcp_config spawn 的孙进程）。
//
// 零 app 代码依赖：只说两种方言——MCP JSON-RPC 2.0（stdin/stdout 换行分隔）与桥管道
// JSON-RPC（行分隔）。协议面按 W0 装机实测样本实现（task 09-12-agy-mcp-tool-bridge
// research/w0-findings.md §5）：
//   - agy 握手前先发非标准 `server/discover` 探针 → 回 -32601 即自动回退标准 initialize
//     （最小 server 无需实现该方法）；
//   - initialize → **回显客户端请求的 protocolVersion**（实测 agy 用 2025-11-25；回显
//     策略实测有效——不写死任何版本号）；
//   - tools/call 的 params._meta 携带 conversation_id / artifacts_dir / progressToken
//     ——一律不读取（忽略未知 `_meta` 键，W0 实证忽略无碍）；
//   - `present_result` 桥原生处理（不经管道执行路径）：本地即时确认 + 管道通知记录
//     （断管道时通知丢弃，agy 流事件为 belt 双源）；
//   - stdin EOF（agy 会话结束主动关 server stdin——官方保障）→ 自退；桥管道断连 → 自退。
//
// 文件名用 .mjs：宿主包 "type":"module" 下 .js 的模块判定随运行树漂移，显式 ESM 在
// dev / vitest / packaged（asar + ELECTRON_RUN_AS_NODE）三形态零歧义。
'use strict';

import net from 'node:net';
import fs from 'node:fs';

const SERVER_NAME = 'novel-writing';
const SERVER_VERSION = '0.2.1';
const PIPE = process.env.ORISON_BRIDGE_PIPE;
const TOKEN = process.env.ORISON_BRIDGE_TOKEN;
const TOOLS_JSON = process.env.ORISON_BRIDGE_TOOLS_JSON;
// welcome 握手超时（默认 30s；env 覆盖仅供测试加速）——管道连上但首帧永不达时，
// 在途 tools/call 不得无限排队等外层 print-timeout 兜底（30m）。
const WELCOME_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ORISON_BRIDGE_WELCOME_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

const log = (...args) => {
  try {
    console.error('[agy-bridge-mcp]', ...args);
  } catch {
    /* stderr 不可写时静默 */
  }
};

function loadTools() {
  if (!TOOLS_JSON) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(TOOLS_JSON, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log('tools.json read failed:', err && err.message ? err.message : err);
    return [];
  }
}

/** 本桥会话工具面（spawn 时固化——面变更走会话重启，无陈旧面窗口）。 */
const TOOLS = loadTools();

// ── 桥管道客户端（懒连接 + 就绪队列；断连自退）──

let pipeSocket = null;
let pipeReady = false;
let pipeGreeted = false;
let welcomeTimer = null;
let nextPipeCallId = 1;
const pendingPipeCalls = new Map(); // pipe call id → resolve(frame)
const onPipeReady = []; // (ok: boolean) => void

function clearWelcomeTimer() {
  if (welcomeTimer !== null) {
    clearTimeout(welcomeTimer);
    welcomeTimer = null;
  }
}

function flushReadyQueue(ok) {
  const queue = onPipeReady.splice(0);
  for (const fn of queue) {
    try {
      fn(ok);
    } catch {
      /* 队列消费方错误不外溢 */
    }
  }
}

function failAllPendingPipeCalls() {
  const pending = [...pendingPipeCalls.values()];
  pendingPipeCalls.clear();
  for (const resolve of pending) resolve({ ok: false, error: 'bridge pipe closed' });
  flushReadyQueue(false);
}

function ensurePipe() {
  if (pipeSocket !== null) return;
  if (!PIPE) return;
  try {
    pipeSocket = net.connect(PIPE);
  } catch (err) {
    log('pipe connect failed:', err && err.message ? err.message : err);
    pipeSocket = null;
    return;
  }
  let buf = '';
  pipeSocket.setEncoding('utf8');
  // 握手序：客户端连上即发 hello（token 校验），服务端回 welcome。
  pipeSocket.on('connect', () => {
    pipeSocket.write(JSON.stringify({ op: 'hello', token: TOKEN }) + '\n');
    // welcome 超时：管道连上但首帧永不达（shell 侧卡死/假 server 占名）→ 在途调用
    // 全失败 + 自退（exit 6），绝不排队等外层 30m 兜底。
    welcomeTimer = setTimeout(() => {
      welcomeTimer = null;
      log('bridge pipe welcome timeout after', WELCOME_TIMEOUT_MS, 'ms');
      failAllPendingPipeCalls();
      shutdown(6);
    }, WELCOME_TIMEOUT_MS);
  });
  pipeSocket.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame && frame.op === 'welcome') {
        clearWelcomeTimer();
        pipeGreeted = frame.ok === true;
        pipeReady = true;
        if (pipeGreeted) {
          flushReadyQueue(true);
        } else {
          log('bridge rejected handshake');
          failAllPendingPipeCalls(); // 在途调用方须收到失败（等在 ready 队列里的帧在此落空成功）
          shutdown(4);
        }
        return;
      }
      if (frame && frame.op === 'result' && frame.id !== undefined) {
        const resolve = pendingPipeCalls.get(frame.id);
        if (resolve !== undefined) {
          pendingPipeCalls.delete(frame.id);
          resolve(frame);
        }
      }
    }
  });
  pipeSocket.on('error', (err) => {
    log('pipe error:', err && err.message ? err.message : err);
    clearWelcomeTimer();
    failAllPendingPipeCalls();
    pipeSocket = null;
    pipeReady = false;
    pipeGreeted = false;
  });
  pipeSocket.on('close', () => {
    clearWelcomeTimer();
    failAllPendingPipeCalls();
    pipeSocket = null;
    pipeReady = false;
    pipeGreeted = false;
    shutdown(5);
  });
}

function whenPipeReady(fn) {
  ensurePipe();
  if (pipeReady && pipeGreeted) fn(true);
  else if (pipeSocket === null) fn(false);
  else onPipeReady.push(fn);
}

/**
 * 经管道调用 shell 侧工具。不设调用级超时——write_chapter 类长工具依赖外层
 * print-timeout 档；管道断连由 close/error 路径统一失败。
 */
function pipeCall(toolId, args) {
  return new Promise((resolve) => {
    whenPipeReady((ok) => {
      if (!ok || pipeSocket === null) {
        resolve({ ok: false, error: 'bridge pipe unavailable' });
        return;
      }
      const id = nextPipeCallId++;
      pendingPipeCalls.set(id, resolve);
      pipeSocket.write(
        JSON.stringify({ op: 'call', id, toolId, ...(args !== undefined ? { arguments: args } : {}) }) + '\n',
      );
    });
  });
}

// ── MCP JSON-RPC 面 ──

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function replyResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  const method = msg.method;
  if (method === 'initialize') {
    const params = msg.params !== null && typeof msg.params === 'object' ? msg.params : {};
    replyResult(msg.id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'tools/list') {
    replyResult(msg.id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const params = msg.params !== null && typeof msg.params === 'object' ? msg.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments;
    // （params._meta 携带 conversation_id / artifacts_dir / progressToken——不读取即忽略。）
    if (name === 'present_result') {
      const argObj = args !== null && typeof args === 'object' ? args : {};
      const awaiting = argObj.awaiting_intent_confirmation === true;
      const summary = typeof argObj.summary === 'string' ? argObj.summary : undefined;
      whenPipeReady((ok) => {
        if (ok && pipeSocket !== null) {
          pipeSocket.write(
            JSON.stringify({ op: 'present_result', awaiting, ...(summary !== undefined ? { summary } : {}) }) + '\n',
          );
        }
      });
      const text = summary !== undefined
        ? `已呈现（${awaiting ? '等用户确认意图' : '本轮完成'}）：${summary}`
        : `已呈现（${awaiting ? '等用户确认意图' : '本轮完成'}）。`;
      replyResult(msg.id, { content: [{ type: 'text', text }] });
      return;
    }
    if (!TOOLS.some((t) => t !== null && typeof t === 'object' && t.name === name)) {
      replyResult(msg.id, { content: [{ type: 'text', text: `工具 ${name} 不存在` }], isError: true });
      return;
    }
    const frame = await pipeCall(name, args);
    if (frame && frame.ok) {
      replyResult(msg.id, { content: [{ type: 'text', text: frame.output === undefined ? '' : String(frame.output) }] });
    } else {
      const detail = frame && frame.error ? frame.error : '桥通道不可用';
      replyResult(msg.id, { content: [{ type: 'text', text: `工具执行失败：${detail}` }], isError: true });
    }
    return;
  }
  // 含 server/discover 探针（W0 §5：agy 收 -32601 自动回退标准 initialize）。
  replyError(msg.id, -32601, `Method not found: ${method}`);
}

// ── stdin 生命周期 ──

let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  try {
    if (pipeSocket !== null) pipeSocket.destroy();
  } catch {
    /* best-effort */
  }
  // 小延迟让已 write 的 stdout 应答帧冲刷（管道写异步——exit 过早会截尾最后应答）。
  setTimeout(() => process.exit(code), 10);
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('bad json-rpc line ignored');
      continue;
    }
    if (msg === null || typeof msg !== 'object') continue;
    // notifications/*（如 notifications/initialized）无 id → 无响应。
    if (msg.id === undefined || msg.id === null) continue;
    if (typeof msg.method !== 'string') continue;
    handleRequest(msg).catch((err) => {
      replyError(msg.id, -32603, `internal error: ${err && err.message ? err.message : err}`);
    });
  }
});
process.stdin.on('end', () => {
  log('stdin EOF, exiting');
  shutdown(0);
});
process.stdin.on('error', () => shutdown(0));
