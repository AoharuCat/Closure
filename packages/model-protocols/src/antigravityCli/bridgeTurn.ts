import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  GenerationLane,
  GenerationMessage,
  GenerationUsage,
  ThinkingControl,
} from '@orison/shared-contracts';
import type { GenerationDelta } from '../types';
import { ProtocolHttpError, ProtocolTimeoutError } from '../errors';
import { buildCliArgs, BRIDGE_PRINT_TIMEOUT, BRIDGE_PRINT_TIMEOUT_GRACE_MS } from './args';
import {
  buildStdinLine,
  buildTurnSegments,
  composeMessageSegment,
  type InstructionBlockOptions,
} from './compose';
import {
  addCliUsage,
  applyCliLine,
  createCliTurnAccumulator,
  emptyCliUsage,
  finishCliTurn,
  type CliToolStepInfo,
  type CliUsageCounters,
} from './events';
import { diffMirror, hashSegment, hashSegments } from './mirror';
import { classifyCliError, mapCliUsage } from './driver';
import {
  AgySessionPool,
  createCliAbortError,
  type AgyPoolDeps,
  type AgyTurnSession,
  type CliSpawnSpec,
} from './sessions';

// ── agy MCP 工具桥 turn 编排（子4，design §0/§5/§6 E1-E4）──
//
// 桥 turn = 一个「桥 turn」内 agy 自主多步循环（工具经 MCP server novel-writing 在 agy
// 侧闭环），Closure 只见 turn 边界。本模块 owns：
//   - 池键后缀 `｜bridge｜face:<hash>`（D9——桥/纯文本/面变更天然分进程，绝不可共进程：
//     假宿 env 会污染纯文本 turn）；
//   - BRIDGE_PRINT_TIMEOUT 30m 独立档（write_chapter 内嵌整链 >> dialogue 3m）；
//   - 假宿准备编排（E1：spec.env USERPROFILE/HOME + homeDir + prepareHome 闭包——四件套
//     写入实现经 AgyBridgeCore 注入，本模块零 fs）；
//   - 工具步相位记录（E2：events toolStepStarted/Result/Error → BridgeToolStepRecord）
//     + MCP 派发解析（ServerName/ToolName/Arguments）；
//   - present_result 事后核验 + 同会话 stdin 增量行打回**恰好一次**（D5——不用
//     `--conversation`：无缓存且慢 ~15×）；
//   - 软拒诊断 matcher（W0 §2 三形态：流事件 tool_info.error 主信号 + stderr + 兜底
//     denied_actions）。
//
// cycle 骨架 mirror driver.runTurnOnSession（belt/abort/settle/CR-2/CR-3/CR-8 守卫同构）；
// 语义差异：工具步消费（非 warn）、打回二段、软拒累积、print-timeout 档。两侧 CR 守卫
// 修复须同步（勿单侧回退）。
//
// DI seam（mirror installAgentImagePartsCore 先例）：core 由 shell
// installShellAgyBridgeCore 装配（假宿写入/管道注册表/spawn deps）；未装配即调用 →
// 响亮失败（wiring 测试钉死，不静默降级）。零真进程：spawn/mkdtemp/removeDir/timer 全
// 经 poolDeps 注入（testing-discipline）。

/** MCP server 名（子4 D4 用户定谳 2026-09-12——写作域自然措辞，不冒充任何官方/第三方组件）。 */
export const BRIDGE_MCP_SERVER_NAME = 'novel-writing';

/**
 * 桥 turn 输出框架声明（compose 指令块输出要求覆盖）：与纯文本 CLI_OUTPUT_DIRECTIVE
 * （「不要调用任何工具」）相反——工具调用是桥的预期行为。工具引导用 ServerName+
 * ToolName 对偶（design §7），不硬编码 agy 侧派发器名。server 名插值自
 * BRIDGE_MCP_SERVER_NAME 单源（改名单点生效，杜绝字面量双写漂移）。
 */
export const BRIDGE_OUTPUT_DIRECTIVE =
  `请完成最后一条消息所述的任务。需要写作能力时，使用 MCP 服务器 ${BRIDGE_MCP_SERVER_NAME} 提供的工具（按各工具说明调用）；面向用户的最终正文直接以纯文本写出。`;

/**
 * present_result 打回提示（同会话 stdin 增量行）。与 agent loop.ts 的 runLoop 打回文案
 * 同义基线（两侧改文案须同步——模型在两条车道上应见到同一协议措辞）。
 */
export const BRIDGE_SENDBACK_MESSAGE =
  '你停下来向用户呈现结果前，必须先调用 present_result 工具声明这次停是否在等用户确认意图（awaiting_intent_confirmation 参数）。请重新呈现并用 present_result 收尾。';

// ── 软拒诊断 matcher（W0 §2 样本固化；主信号 = 流事件 tool_info.error）──

/** 主信号：流事件 tool_info.error.message 含本短语（W0 §2 样本② 逐字锚）。 */
export const MCP_SOFT_DENY_TOOL_MESSAGE_NEEDLE = 'permission check failed for mcp "';
/** 兜底①：stderr 通知含本短语（W0 §2 样本① 逐字锚；有 jetski: 前缀——用中段子串）。 */
export const MCP_SOFT_DENY_STDERR_NEEDLE = 'the "mcp" permission that headless mode cannot prompt for';
/** 兜底②：result.denied_actions 含 action === 'mcp'（W0 §2 样本③）。 */

export function isMcpSoftDenyToolError(info: CliToolStepInfo | undefined): boolean {
  const err = info?.error;
  if (err === null || typeof err !== 'object' || Array.isArray(err)) return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes(MCP_SOFT_DENY_TOOL_MESSAGE_NEEDLE);
}

export function isMcpSoftDenyStderr(chunk: string): boolean {
  return chunk.includes(MCP_SOFT_DENY_STDERR_NEEDLE);
}

export function hasMcpDeniedAction(actions: readonly string[] | undefined): boolean {
  return actions?.includes('mcp') ?? false;
}

// ── 类型 ──

/** 桥会话工具面条目（tools.json 内容原形；inputSchema = wire request.tools 的 JSON Schema 1:1）。 */
export interface BridgeToolFaceEntry {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** 桥会话权限档（与 agent toolPolicy.SessionPermissionMode 同值字面量联合——跨包同 root）。 */
export type BridgePermissionMode = 'readonly' | 'suggest' | 'auto';

/** 假宿四件套写入载荷（shell writeHomePayload 消费；含 marker 所需 sessionId）。 */
export interface BridgeHomePayload {
  homeDir: string;
  sessionId: string;
  serverName: string;
  pipeName: string;
  token: string;
  tools: BridgeToolFaceEntry[];
}

/** 桥会话注册输入（shell 注册表 openSession 消费——管道/token/权限档/面）。 */
export interface BridgeSessionOpenInput {
  sessionId: string;
  projectDir: string;
  permissionMode: BridgePermissionMode;
  face: BridgeToolFaceEntry[];
}

/**
 * shell 注入内核（installShellAgyBridgeCore 装配；本模块纯编排零 fs/零管道）。
 * poolDeps 供本模块自建桥会话池（与纯文本驱动器池分实例——键空间已隔离，互不逐出）。
 */
export interface AgyBridgeCore {
  /** 假宿根（`~/.orison/agy-bridge/home`）。 */
  homeRoot: string;
  /** 假宿四件套 + marker 写入（E1 prepareHome 闭包的目标实现）。 */
  writeHomePayload(input: BridgeHomePayload): Promise<void>;
  /** 桥会话注册（幂等 per sessionId——管道/token 复用）。 */
  openBridgeSession(input: BridgeSessionOpenInput): Promise<{ pipeName: string; token: string }>;
  poolDeps: AgyPoolDeps;
  warn(message: string): void;
  info?(message: string): void;
}

/** 工具步相位记录（E2 透出 + MCP 派发解析；W4 executor 转 SessionMessage/相位事件素材）。 */
export interface BridgeToolStepRecord {
  phase: 'started' | 'result' | 'error';
  stepIndex: number;
  /** agy 步工具名（MCP 调用时 = 派发器 call_mcp_tool）。 */
  toolName?: string;
  /** MCP 派发参数解析成功时（{ServerName, ToolName, Arguments} 大写键——W0 §3）。 */
  mcp?: { serverName: string; toolName: string; arguments?: unknown };
  info?: CliToolStepInfo;
}

/**
 * 桥 turn 运行期相位事件（W4 executor 消费——UI 相位/通知面素材，design §8）：
 *   - `tool-started`：桥面工具调用开始（仅 `novel-writing` 派发步——agy 内置工具步不发，
 *     其结果无 Closure 侧执行记录，进 UI 卡面会是无归依的孤儿相位）；
 *   - `sendback` / `sendback-missed`：present_result 打回决策 / 二次未调接受（§5.3）；
 *   - `soft-denied`：软拒三形态任一信号首次命中（每 turn 至多一次——重复信号不重发）。
 */
export type AgyBridgePhaseEvent =
  | { kind: 'tool-started'; toolName: string; stepIndex: number }
  | { kind: 'sendback' }
  | { kind: 'sendback-missed' }
  | { kind: 'soft-denied' };

export interface BridgeTurnInput {
  cliExecutable: string;
  keyId: string;
  modelId: string;
  thinking?: ThinkingControl;
  system: string;
  messages: GenerationMessage[];
  /** 逻辑会话键（lane 装配侧；池键派生用）。 */
  sessionKey: string;
  /** 桥会话身份（假宿归属 `<homeRoot>/<sessionId>` + 注册表键）。 */
  sessionId: string;
  projectDir: string;
  permissionMode: BridgePermissionMode;
  /** 本桥会话工具面（tools.json 内容 + face hash 池键派生）。 */
  face: BridgeToolFaceEntry[];
  /** plan/discuss 档传 true（present_result 收尾强制）；normal/auto 传 false。 */
  requirePresentResult: boolean;
  lane?: GenerationLane;
  onDelta?: (d: GenerationDelta) => void;
  /** 运行期相位事件（W4 executor → UI；缺省不发——协议层自身零 UI 依赖）。 */
  onPhase?: (event: AgyBridgePhaseEvent) => void;
  signal?: AbortSignal;
}

export interface BridgeTurnResult {
  text: string;
  usage: GenerationUsage | undefined;
  /** 全部工具步相位记录（含打回重跑段）。 */
  toolSteps: BridgeToolStepRecord[];
  presentResultCalled: boolean;
  presentResultAwaiting: boolean | undefined;
  /** 是否发生打回重跑（同会话增量行）。 */
  sentBack: boolean;
  /** 打回后仍未调 present_result → 接受结果 + 警告（不无限打回）。 */
  secondPassMissedPresentResult: boolean;
  /** 软拒三形态任一信号命中（W0 §2）。 */
  mcpSoftDenied: boolean;
  /** 桥面工具调用次数（MCP 派发 started 计数——「零调用」判据）。 */
  bridgeToolCalls: number;
}

// ── 池键 / 假宿路径派生（纯函数）──

export function bridgeFaceHash(face: BridgeToolFaceEntry[]): string {
  return createHash('sha256').update(JSON.stringify(face), 'utf8').digest('hex').slice(0, 12);
}

/** D9 池键后缀：`<sessionKey>｜bridge｜face:<hash>`——桥/纯文本/面变更分进程。 */
export function bridgePoolSessionKey(sessionKey: string, face: BridgeToolFaceEntry[]): string {
  return `${sessionKey}｜bridge｜face:${bridgeFaceHash(face)}`;
}

/** 假宿目录派生（sessionId 净化为安全段；空/点段拒绝——防路径注入）。 */
export function bridgeHomeDirFor(homeRoot: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_');
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new Error(`invalid bridge session id for home dir: ${JSON.stringify(sessionId)}`);
  }
  return path.join(homeRoot, safe);
}

function parseMcpDispatch(
  info: CliToolStepInfo | undefined,
): { serverName: string; toolName: string; arguments?: unknown } | undefined {
  const params = info?.parameters;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const p = params as Record<string, unknown>;
  if (typeof p.ServerName !== 'string' || typeof p.ToolName !== 'string') return undefined;
  return {
    serverName: p.ServerName,
    toolName: p.ToolName,
    ...(p.Arguments !== undefined ? { arguments: p.Arguments } : {}),
  };
}

interface PresentResultState {
  called: boolean;
  awaiting: boolean | undefined;
}

function notePresentResult(record: BridgeToolStepRecord, present: PresentResultState): void {
  if (record.mcp?.serverName !== BRIDGE_MCP_SERVER_NAME || record.mcp.toolName !== 'present_result') return;
  present.called = true;
  const args = record.mcp.arguments;
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const awaiting = (args as Record<string, unknown>).awaiting_intent_confirmation;
    if (typeof awaiting === 'boolean') present.awaiting = awaiting;
  }
}

// ── DI seam（mirror installAgentImagePartsCore；wiring 测试钉死漏装配）──

let core: AgyBridgeCore | undefined;
let pool: AgySessionPool | undefined;

/** shell 装配点（installShellAgyBridgeCore）——重复 install 重建池（旧池 dispose）。 */
export function installAgyBridgeCore(next: AgyBridgeCore): void {
  pool?.dispose();
  core = next;
  pool = new AgySessionPool(next.poolDeps);
}

/** 测试缝：探针已装配内核（钉 shell wiring）。 */
export function __getAgyBridgeCoreForTest(): AgyBridgeCore | undefined {
  return core;
}

/** 测试缝：卸载 + 关停池（用例间隔离）。 */
export function uninstallAgyBridgeCoreForTest(): void {
  pool?.dispose();
  core = undefined;
  pool = undefined;
}

/** 全量关停（app 退出接线位——关停桥进程池；core 保留待下次装配）。 */
export function disposeAgyBridgeRuntime(): void {
  pool?.dispose();
  pool = undefined;
}

function requireCore(): AgyBridgeCore {
  if (core === undefined) {
    throw new Error(
      'agy bridge core not installed — shell must call installShellAgyBridgeCore (agyBridge.ts) before any bridge turn',
    );
  }
  return core;
}

// ── 单 cycle 执行（骨架 mirror driver.runTurnOnSession——见文件头同步注记）──

const STDERR_EXCERPT_LIMIT = 2_000;
const STDERR_RING_LIMIT = 200_000;

function stderrExcerpt(buffer: string): string {
  return buffer.length > STDERR_EXCERPT_LIMIT ? buffer.slice(-STDERR_EXCERPT_LIMIT) : buffer;
}

interface BridgeCycleState {
  toolSteps: BridgeToolStepRecord[];
  mcpSoftDenied: boolean;
  /** soft-denied 相位事件已发（每 turn 至多一次——stderr/流事件/denied_actions 三信号去重）。 */
  softDenyNoticed: boolean;
}

interface BridgeCycleRun {
  text: string;
  usage: CliUsageCounters;
  sawUsage: boolean;
}

async function runBridgeCycle(
  session: AgyTurnSession,
  segments: string[],
  hashes: string[],
  opts: {
    onDelta: ((d: GenerationDelta) => void) | undefined;
    onPhase: ((event: AgyBridgePhaseEvent) => void) | undefined;
    signal: AbortSignal | undefined;
    warn: (message: string) => void;
    info: ((message: string) => void) | undefined;
    setTimer: AgyPoolDeps['setTimer'];
  },
  state: BridgeCycleState,
  present: PresentResultState,
): Promise<BridgeCycleRun> {
  const decision = diffMirror(session.seenHashes, hashes);
  if (decision.kind === 'diverge') {
    await session.restart();
  }
  const tailSegments = decision.kind === 'append'
    ? segments.slice(decision.prefixLength)
    : segments;
  const stdinLine = buildStdinLine(tailSegments.join('\n\n'));

  let acc = createCliTurnAccumulator();
  let stderrBuf = '';
  const warnedUnknownEvents = new Set<string>();
  return await new Promise<BridgeCycleRun>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    // CR-2 同源守卫：belt 声明先于一切可能同步触发的注册（setExitObserver 已死同步回调）。
    // （声明后到赋值前存在 belt?.clear() 读取路径——prefer-const 误报，豁免）
    // eslint-disable-next-line prefer-const
    let belt: { clear(): void } | undefined;

    const cleanup = (): void => {
      belt?.clear();
      if (onAbort !== undefined && opts.signal !== undefined) {
        opts.signal.removeEventListener('abort', onAbort);
      }
      session.setLineTap(undefined);
      session.setStderrTap(undefined);
      session.setExitObserver(undefined);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const pushToolRecord = (record: BridgeToolStepRecord): void => {
      state.toolSteps.push(record);
      notePresentResult(record, present);
    };
    // soft-denied 相位去重通知（三信号 stderr/流事件/denied_actions 只发第一次）。
    const noteSoftDenied = (): void => {
      if (state.softDenyNoticed) return;
      state.softDenyNoticed = true;
      opts.onPhase?.({ kind: 'soft-denied' });
    };
    const finishOutcome = (): void => {
      const outcome = finishCliTurn(acc);
      switch (outcome.kind) {
        case 'success': {
          // 兜底③：result.denied_actions（软拒后模型放弃作答的形态下仍携带）。
          if (hasMcpDeniedAction(acc.result?.deniedActions)) {
            state.mcpSoftDenied = true;
            noteSoftDenied();
          }
          resolve({ text: outcome.text, usage: outcome.usage, sawUsage: outcome.sawStepUsage });
          return;
        }
        case 'canceled':
          session.invalidate('turn-canceled');
          reject(createCliAbortError());
          return;
        case 'error': {
          const err = classifyCliError(outcome.message, stderrExcerpt(stderrBuf));
          if (/^(WAITING|RUNNING|INVALID)$/.test(outcome.status)) {
            session.invalidate(`turn-status-${outcome.status}`);
          }
          reject(err);
          return;
        }
        case 'no-result':
          reject(new ProtocolHttpError(
            'antigravity-cli bridge stream ended without a result event',
            502,
            stderrExcerpt(stderrBuf),
          ));
          return;
      }
    };

    session.setLineTap((line) => {
      const applied = applyCliLine(acc, line);
      acc = applied.acc;
      const effect = applied.effect;
      if (effect?.textDelta !== undefined && opts.onDelta !== undefined) {
        // CR-8：消费者 throw 不逃逸成流桥内未捕获异常；终帧正文以 result.response 为权威。
        try {
          opts.onDelta({ type: 'text', delta: effect.textDelta });
        } catch (err) {
          opts.warn(
            `[agy-bridge] onDelta consumer threw (ignored; final text comes from the result event): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (effect?.toolStepStarted !== undefined) {
        const started = effect.toolStepStarted;
        const mcp = parseMcpDispatch(started.toolInfo);
        pushToolRecord({
          phase: 'started',
          stepIndex: started.stepIndex,
          ...(started.toolName !== undefined ? { toolName: started.toolName } : {}),
          mcp,
          ...(started.toolInfo !== undefined ? { info: started.toolInfo } : {}),
        });
        // 桥面工具相位（仅 novel-writing 派发步——agy 内置工具步无 Closure 侧执行记录）。
        if (mcp?.serverName === BRIDGE_MCP_SERVER_NAME) {
          opts.onPhase?.({ kind: 'tool-started', toolName: mcp.toolName, stepIndex: started.stepIndex });
        }
      }
      if (effect?.toolStepResult !== undefined) {
        pushToolRecord({
          phase: 'result',
          stepIndex: effect.toolStepResult.stepIndex,
          ...(effect.toolStepResult.toolName !== undefined ? { toolName: effect.toolStepResult.toolName } : {}),
          mcp: parseMcpDispatch(effect.toolStepResult.toolInfo),
          info: effect.toolStepResult.toolInfo,
        });
      }
      if (effect?.toolStepError !== undefined) {
        if (isMcpSoftDenyToolError(effect.toolStepError.toolInfo)) {
          // 主信号：流事件 tool_info.error（W0 §2 matcher 定谳——结构化最稳）。
          state.mcpSoftDenied = true;
          noteSoftDenied();
        }
        pushToolRecord({
          phase: 'error',
          stepIndex: effect.toolStepError.stepIndex,
          ...(effect.toolStepError.toolName !== undefined ? { toolName: effect.toolStepError.toolName } : {}),
          mcp: parseMcpDispatch(effect.toolStepError.toolInfo),
          ...(effect.toolStepError.toolInfo !== undefined ? { info: effect.toolStepError.toolInfo } : {}),
        });
      }
      if (effect?.init !== undefined) {
        const parts = [
          effect.init.model !== undefined ? `model=${effect.init.model}` : undefined,
          effect.init.permissionMode !== undefined ? `permission_mode=${effect.init.permissionMode}` : undefined,
          effect.init.toolsCount !== undefined ? `tools=${effect.init.toolsCount}` : undefined,
        ].filter((p): p is string => p !== undefined);
        opts.info?.(`[agy-bridge] process init: ${parts.join(' ')}`);
      }
      if (effect?.unknownEvent !== undefined && !warnedUnknownEvents.has(effect.unknownEvent.type)) {
        warnedUnknownEvents.add(effect.unknownEvent.type);
        opts.warn(`[agy-bridge] unknown stream event type '${effect.unknownEvent.type}' ignored`);
      }
      if (acc.result !== undefined) {
        settle(finishOutcome);
      }
    });
    session.setStderrTap((chunk) => {
      stderrBuf += chunk;
      if (stderrBuf.length > STDERR_RING_LIMIT) {
        stderrBuf = stderrBuf.slice(-STDERR_RING_LIMIT);
      }
      // 兜底①：stderr 软拒通知（jetski: 前缀通知——W0 §2 样本①）。
      if (isMcpSoftDenyStderr(chunk)) {
        state.mcpSoftDenied = true;
        noteSoftDenied();
      }
    });
    session.setExitObserver((code) => {
      settle(() => reject(new ProtocolHttpError(
        `antigravity-cli bridge process exited (code ${code ?? 'null'}) before the turn result`,
        502,
        stderrExcerpt(stderrBuf),
      )));
    });
    if (settled) return; // 已退进程的退出观察同步抢跑（CR-2 路径）
    // 外层兜底 kill = 桥档 print-timeout(30m) + 5m 宽限（design §5.5 桥档 grace——与
    // 纯文本 60s 分档；settle 先于 invalidate）。
    const outerBeltMs = BRIDGE_PRINT_TIMEOUT.ms + BRIDGE_PRINT_TIMEOUT_GRACE_MS;
    belt = opts.setTimer(() => {
      settle(() => reject(new ProtocolTimeoutError(
        `agy bridge turn exceeded ${outerBeltMs}ms (bridge print-timeout + grace outer belt)`,
      )));
      session.invalidate('outer-belt-timeout');
    }, outerBeltMs);
    if (opts.signal !== undefined) {
      onAbort = () => {
        settle(() => reject(createCliAbortError()));
        session.invalidate('abort');
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    // CR-3：写行在 belt/abort 武装之后发起；写失败作废会话 + 502。
    void (async () => {
      try {
        await session.writeLine(stdinLine);
      } catch (err) {
        settle(() => {
          session.invalidate('stdin-write-failed');
          const detail = err instanceof Error ? err.message : String(err);
          reject(new ProtocolHttpError(`antigravity-cli bridge stdin write failed: ${detail}`, 502));
        });
        return;
      }
      session.commitSeenHashes(hashes);
    })();
  });
}

// ── 桥 turn 主入口 ──

export async function runAgyBridgeTurn(input: BridgeTurnInput): Promise<BridgeTurnResult> {
  const c = requireCore();
  const activePool = pool;
  if (activePool === undefined) {
    // requireCore 已保证 core 在位 → pool 必在位；防御式断言（类型收窄）。
    throw new Error('agy bridge session pool missing despite installed core');
  }
  const { pipeName, token } = await c.openBridgeSession({
    sessionId: input.sessionId,
    projectDir: input.projectDir,
    permissionMode: input.permissionMode,
    face: input.face,
  });
  const homeDir = bridgeHomeDirFor(c.homeRoot, input.sessionId);
  const instructionOpts: InstructionBlockOptions = { outputDirective: BRIDGE_OUTPUT_DIRECTIVE };
  const segments = buildTurnSegments(input.system, input.messages, instructionOpts);
  const hashes = hashSegments(segments);
  const spec: CliSpawnSpec = {
    executable: input.cliExecutable,
    args: buildCliArgs({
      model: input.modelId,
      lane: input.lane,
      thinking: input.thinking,
      printTimeout: BRIDGE_PRINT_TIMEOUT,
    }),
    // β 通道 env 双变量（W0 §10 双设实证；Go os.UserHomeDir 读 USERPROFILE，HOME 兜底）。
    env: { USERPROFILE: homeDir, HOME: homeDir },
    homeDir,
    // CR-10：假宿归属 = 桥 sessionId——两 sessionId sanitize 到同段时池侧 typed 拒绝
    //（引用计数跳过 prepareHome 的窗口里绝不可静默读错首会话 mcp_config）。
    homeOwner: input.sessionId,
    prepareHome: (dir) =>
      c.writeHomePayload({
        homeDir: dir,
        sessionId: input.sessionId,
        serverName: BRIDGE_MCP_SERVER_NAME,
        pipeName,
        token,
        tools: input.face,
      }),
  };

  const runCycles = async (session: AgyTurnSession): Promise<BridgeTurnResult> => {
    const state: BridgeCycleState = { toolSteps: [], mcpSoftDenied: false, softDenyNoticed: false };
    const present: PresentResultState = { called: false, awaiting: undefined };
    const cycleOpts = {
      onDelta: input.onDelta,
      onPhase: input.onPhase,
      signal: input.signal,
      warn: c.warn,
      info: c.info,
      setTimer: c.poolDeps.setTimer,
    };

    let last = await runBridgeCycle(session, segments, hashes, cycleOpts, state, present);
    let usageSum = last.sawUsage ? last.usage : emptyCliUsage();
    let sawUsage = last.sawUsage;

    let sentBack = false;
    let secondMiss = false;
    if (input.requirePresentResult && !present.called) {
      // §5.3：turn 结束（SUCCESS 且产出正文——失败路径已在上方 reject）未调 present_result
      // → 同会话写一行打回提示，模型重跑；至多一次，二次未调接受 + 警告。
      sentBack = true;
      c.warn('[agy-bridge] present_result not called before stopping — sending back once via same-session stdin line');
      input.onPhase?.({ kind: 'sendback' });
      const sendbackSegment = composeMessageSegment({ role: 'user', content: BRIDGE_SENDBACK_MESSAGE });
      const allSegments = [...segments, sendbackSegment];
      const allHashes = [...hashes, hashSegment(sendbackSegment)];
      // CR-5：二轮（打回重跑）不再发 delta——首轮已流出的正文不得在 UI 占位重放双份；
      // 终文以本轮 result.response 为权威，无 delta 消费者路径照常工作。
      const sendbackOpts = { ...cycleOpts, onDelta: undefined };
      try {
        last = await runBridgeCycle(session, allSegments, allHashes, sendbackOpts, state, present);
        if (last.sawUsage) {
          usageSum = addCliUsage(usageSum, last.usage);
          sawUsage = true;
        }
      } catch (err) {
        // CR-5：打回重跑失败（quota/timeout 等运行失败）不得把有效首轮答案变硬失败——
        // 接受首轮结果 + 警告。abort 族照常上抛：用户中断不是可吞失败。
        const abortLike = (err instanceof Error && err.name === 'AbortError') || input.signal?.aborted === true;
        if (abortLike) throw err;
        c.warn(
          `[agy-bridge] sendback retry failed (${err instanceof Error ? err.message : String(err)}) — accepting first-pass result`,
        );
      }
      if (!present.called) {
        secondMiss = true;
        c.warn('[agy-bridge] present_result still not called after sendback — accepting result with warning (no infinite resend)');
        input.onPhase?.({ kind: 'sendback-missed' });
      }
    }

    return {
      text: last.text,
      usage: sawUsage ? mapCliUsage(usageSum) : undefined,
      toolSteps: state.toolSteps,
      presentResultCalled: present.called,
      presentResultAwaiting: present.awaiting,
      sentBack,
      secondPassMissedPresentResult: secondMiss,
      mcpSoftDenied: state.mcpSoftDenied,
      bridgeToolCalls: state.toolSteps.filter(
        (s) => s.phase === 'started' && s.mcp?.serverName === BRIDGE_MCP_SERVER_NAME,
      ).length,
    };
  };

  return activePool.runTurn(
    { sessionKey: bridgePoolSessionKey(input.sessionKey, input.face), keyId: input.keyId, modelId: input.modelId },
    spec,
    input.signal,
    runCycles,
  );
}
