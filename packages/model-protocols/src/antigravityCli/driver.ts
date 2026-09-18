import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  GenerationUsage,
  ResolvedModel,
  TextGenerationRequest,
  TextGenerationResponse,
} from '@orison/shared-contracts';
import type { GenerationDelta, ProtocolCallContext } from '../types';
import {
  ProtocolContextOverflowError,
  ProtocolHttpError,
  ProtocolSchemaError,
  ProtocolTimeoutError,
  isContextOverflowError,
} from '../errors';
import { buildCliArgs, printTimeoutForLane, PRINT_TIMEOUT_GRACE_MS } from './args';
import {
  buildStdinLine,
  buildTurnSegments,
  composeTurnText,
  splitSystemMessages,
} from './compose';
import {
  applyCliLine,
  createCliTurnAccumulator,
  finishCliTurn,
  type CliUsageCounters,
} from './events';
import { diffMirror, hashSegments } from './mirror';
import {
  AgySessionPool,
  createCliAbortError,
  type AgyPoolDeps,
  type AgyTurnSession,
  type CliChild,
  type CliSpawnSpec,
} from './sessions';

// ── Antigravity CLI 驱动器（09-12 agy provider，design §3.6/§3.7）──
//
// generateText / generateTextStream 的 CLI 形态分派目标（generate.ts 顶部早退——不经
// 流式韧性层，防 CLI 502 被「回退非流式重发」）。单实现两态消费：非流式同跑 stream-json
// 聚合，onDelta 缺省不外发。driver 内**不自动重试**（防放大；重试/回退归调用方与子2 链）。

/** stderr 摘要素材上限（退出无 result 时的 502 excerpt）。 */
const STDERR_EXCERPT_LIMIT = 2_000;
/** stderr 累积环形上限（CR-8：≈200KB——长跑进程诊断输出不得无界膨胀内存，只保尾部）。 */
const STDERR_RING_LIMIT = 200_000;

// ── 错误分类表（design §3.7，喂子2 回退链）──

function stderrExcerpt(buffer: string): string {
  return buffer.length > STDERR_EXCERPT_LIMIT ? buffer.slice(-STDERR_EXCERPT_LIMIT) : buffer;
}

/**
 * CLI 凭据缺失的短语族判定（driver 错误分类与 shell 侧 `agy models` 未登录检测
 * 共用同一词表——两处判定不得各自漂移）。
 */
export function isAuthError(text: string): boolean {
  return /authenticat|auth required|not logged in|login required/i.test(text);
}

function isQuotaError(text: string): boolean {
  return /quota|rate.?limit|429|too many requests/i.test(text);
}

function isInvalidModelError(text: string): boolean {
  return /invalid model|unknown model|model not (found|supported)/i.test(text);
}

/** 错误文本 → 协议层错误类型（顺序：auth → quota → 模型配置 → 上下文溢出 → 502 兜底）。 */
export function classifyCliError(message: string, excerpt: string): Error {
  const haystack = `${message}\n${excerpt}`;
  if (isAuthError(haystack)) return new ProtocolHttpError(message, 401, excerpt);
  if (isQuotaError(haystack)) return new ProtocolHttpError(message, 429, excerpt);
  if (isInvalidModelError(haystack)) return new ProtocolSchemaError(message);
  // 上下文溢出：构造 ProtocolHttpError 后走共享谓词（isContextOverflowError 短语族），
  // 命中则升级 ProtocolContextOverflowError（runLoop 压缩重试路自动兼容）。
  const candidate = new ProtocolHttpError(message, 502, excerpt);
  if (isContextOverflowError(candidate)) {
    return new ProtocolContextOverflowError(message, 502, excerpt);
  }
  return candidate;
}

// ── usage 映射（design §3.5；CR-18：缺席计数器保持键 ABSENT——0 与「未上报」不可分）──

export function mapCliUsage(usage: CliUsageCounters): GenerationUsage {
  return {
    ...(usage.input !== undefined ? { promptTokens: usage.input } : {}),
    ...(usage.output !== undefined ? { completionTokens: usage.output } : {}),
    ...(usage.total !== undefined ? { totalTokens: usage.total } : {}),
    ...(usage.thinking !== undefined ? { thinkingTokens: usage.thinking } : {}),
    ...(usage.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
  };
}

// ── turn 执行 ──

interface TurnRunOptions {
  onDelta: ((d: GenerationDelta) => void) | undefined;
  signal: AbortSignal | undefined;
  /** 外层兜底 kill = print-timeout + 60s。 */
  outerBeltMs: number;
  /** 观测 seam（CR-24：driver 侧观测统一走 deps.warn/deps.info——缺省静默，测试注入收集器）。 */
  warn: ((message: string) => void) | undefined;
  info: ((message: string) => void) | undefined;
}

interface TurnRunResult {
  text: string;
  usage: GenerationUsage | undefined;
}

/**
 * 在会话上执行一轮：镜像判定（冷启动/追加/分歧→restart 全量）→ 写 stdin 行 → 读事件
 * 流到 result → 终态归约。写行发生在 belt/abort 武装**之后**（CR-3：背压写挂死可被
 * 外层兜底/abort 解救——此前写阶段无任何看门狗，挂起 = 永久悬挂）。writeLine 成功即
 * commit 镜像（「已发」语义——与 turn 成败无关，防失败 turn 后增量判定错位重发）。
 */
async function runTurnOnSession(
  session: AgyTurnSession,
  segments: string[],
  hashes: string[],
  opts: TurnRunOptions,
  setTimer: AgyPoolDeps['setTimer'],
): Promise<TurnRunResult> {
  const decision = diffMirror(session.seenHashes, hashes);
  if (decision.kind === 'diverge') {
    // 历史分歧（压缩/改写/fork/system 变化）或零尾段（重复请求）→ 优雅关停 + 冷启动全量。
    await session.restart();
  }
  const tailSegments = decision.kind === 'append'
    ? segments.slice(decision.prefixLength)
    : segments;
  const stdinLine = buildStdinLine(composeTurnText(tailSegments));

  let acc = createCliTurnAccumulator();
  let stderrBuf = '';
  const warnedUnknownEvents = new Set<string>();
  return await new Promise<TurnRunResult>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    // CR-2：belt 声明先于一切可能同步触发的注册——已退进程时 setExitObserver 会同步
    // 回调（sessions 侧「已死则立即回调」契约），若 belt 仍是后置 const，同步回调里的
    // cleanup() 撞 TDZ → ReferenceError 顶掉类型化 502。
    // （声明后到 262 行赋值前存在 belt?.clear() 读取路径——prefer-const 误报，豁免）
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
    /** 终态归约（result 已到）——直接 resolve/reject（外层 settle 已置位 + 清扫）。 */
    const finishOutcome = (): void => {
      const outcome = finishCliTurn(acc);
      switch (outcome.kind) {
        case 'success':
          resolve({
            text: outcome.text,
            usage: outcome.sawStepUsage ? mapCliUsage(outcome.usage) : undefined,
          });
          return;
        case 'canceled':
          // CANCELED / INTERRUPTED → abort 语义 + 作废会话。
          session.invalidate('turn-canceled');
          reject(createCliAbortError());
          return;
        case 'error': {
          const err = classifyCliError(outcome.message, stderrExcerpt(stderrBuf));
          // WAITING/RUNNING/INVALID（等待权限/卡运行/非法态）→ 会话不可信，作废。
          //（EMPTY 不作废：重试请求 = 零尾段 → 镜像分歧 → 自动冷重启，无需显式杀。）
          if (/^(WAITING|RUNNING|INVALID)$/.test(outcome.status)) {
            session.invalidate(`turn-status-${outcome.status}`);
          }
          reject(err);
          return;
        }
        case 'no-result':
          reject(new ProtocolHttpError(
            'antigravity-cli stream ended without a result event',
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
        // CR-8：消费者 throw 不得逃逸成流桥内的未捕获异常（tap 回调抛出 = 主进程崩）。
        // 记 warn 后继续——终帧正文以 result.response 为权威，丢增量不丢 turn。
        try {
          opts.onDelta({ type: 'text', delta: effect.textDelta });
        } catch (err) {
          opts.warn?.(
            `[antigravity-cli] onDelta consumer threw (ignored; final text comes from the result event): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (effect?.toolStepStarted !== undefined) {
        // 模型动用 agy 自带工具——观测不中断（design §3.5；Closure 工具面子4 补全）。
        opts.warn?.(
          `[antigravity-cli] model invoked a built-in tool (step ${effect.toolStepStarted.stepIndex}) — CLI form does not bridge Closure tools; continuing`,
        );
      }
      if (effect?.init !== undefined) {
        // init 观测（CR-17）：tools 数 / permission_mode / model——落 info（默认门控
        // ORISON_PROTOCOL_DEBUG，mirror generate.ts 每请求仪表先例）。
        const parts = [
          effect.init.model !== undefined ? `model=${effect.init.model}` : undefined,
          effect.init.permissionMode !== undefined ? `permission_mode=${effect.init.permissionMode}` : undefined,
          effect.init.toolsCount !== undefined ? `tools=${effect.init.toolsCount}` : undefined,
        ].filter((p): p is string => p !== undefined);
        opts.info?.(`[antigravity-cli] process init: ${parts.join(' ')}`);
      }
      if (effect?.unknownEvent !== undefined && !warnedUnknownEvents.has(effect.unknownEvent.type)) {
        // 未知 event 类型（官方约定「跳过并警告」）——每类型每 turn 一次，防坏流刷屏。
        warnedUnknownEvents.add(effect.unknownEvent.type);
        opts.warn?.(`[antigravity-cli] unknown stream event type '${effect.unknownEvent.type}' ignored`);
      }
      if (acc.result !== undefined) {
        settle(finishOutcome);
      }
    });
    session.setStderrTap((chunk) => {
      stderrBuf += chunk;
      // CR-8：环形截尾——只保尾部（502 摘要只消费尾部 excerpt）。
      if (stderrBuf.length > STDERR_RING_LIMIT) {
        stderrBuf = stderrBuf.slice(-STDERR_RING_LIMIT);
      }
    });
    session.setExitObserver((code) => {
      // 进程退出且本 turn 无 result → 502 + 作废会话（executeTurn 的 catch 兜底 invalidate）。
      settle(() => reject(new ProtocolHttpError(
        `antigravity-cli process exited (code ${code ?? 'null'}) before the turn result`,
        502,
        stderrExcerpt(stderrBuf),
      )));
    });
    if (settled) return; // 已退进程的退出观察同步抢跑（CR-2 路径）——不再武装/写行
    // 外层兜底 kill = print-timeout + 60s（防 agy 自身超时机制失效；design §3.3）。
    // ⚠️ settle 先于 invalidate：invalidate 的 kill 会触发本 turn 的退出观察——
    // 先置位 settle 才能保住超时错误形态（否则退出 502 抢跑）。
    belt = setTimer(() => {
      settle(() => reject(new ProtocolTimeoutError(
        `antigravity-cli turn exceeded ${opts.outerBeltMs}ms (print-timeout + grace outer belt)`,
      )));
      session.invalidate('outer-belt-timeout');
    }, opts.outerBeltMs);
    if (opts.signal !== undefined) {
      onAbort = () => {
        // 同上：settle 先于 invalidate（kill 的退出级联不得抢跑 abort 形态）。
        settle(() => reject(createCliAbortError()));
        session.invalidate('abort');
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    // CR-3：写行在 belt/abort 武装之后发起——写阶段被全部看门狗罩住。写失败（EPIPE
    // 等）→ 作废会话 + 502（不自动重试）；spawnRealCli 的持久 stdin error 兜底保持
    // 「不吞写失败」（该 turn 的失败由写拒绝/退出观察上抛）。
    void (async () => {
      try {
        await session.writeLine(stdinLine);
      } catch (err) {
        settle(() => {
          session.invalidate('stdin-write-failed');
          const detail = err instanceof Error ? err.message : String(err);
          reject(new ProtocolHttpError(`antigravity-cli stdin write failed: ${detail}`, 502));
        });
        return;
      }
      // 镜像记录「已发」内容（design §3.2）——写成功即提交，与 turn 成败无关。
      session.commitSeenHashes(hashes);
    })();
  });
}

// ── 真实 spawn 适配（唯一触真进程处；测试经 DI 注入 fake）──

/**
 * E3 树杀分派（子4 design §5.4——AC3 实现重心）：kill 必须覆盖 MCP server 孙进程——
 * Windows 无进程组语义 → `taskkill /T /F`（树杀）；posix → `kill(-pid)`（进程组——spawn
 * 已按平台 detached 建组）。pid 未知（spawn 同步失败形态）或树杀抛错 → 回落 plainKill
 * （仅杀直接子进程—— belt，孙进程由 mcpServer stdin EOF 自退 + agy 会话结束关 server
 * stdin 的官方 EOF 保障兜底，W0 §5 实测）。纯函数（平台/杀法全参数化）——单测零真进程
 * 覆盖三平台分支。
 */
export function treeKillDispatch(input: {
  platform: NodeJS.Platform;
  pid: number | undefined;
  /** win 分支：树杀（taskkill /T /F 的适配层）。 */
  taskkill: (pid: number) => void;
  /** posix 分支：进程组杀（kill(-pid, sig) 的适配层）。 */
  groupKill: (pid: number) => void;
  /** 回落：仅杀直接子进程（原 kill 语义）。 */
  plainKill: () => void;
}): void {
  if (input.pid === undefined) {
    input.plainKill();
    return;
  }
  if (input.platform === 'win32') {
    try {
      input.taskkill(input.pid);
    } catch {
      input.plainKill();
    }
    return;
  }
  try {
    input.groupKill(input.pid);
  } catch {
    input.plainKill();
  }
}

/** node:child_process 适配到 CliChild 缝（readline NDJSON + 背压写 + 错误/退出归一）。 */
export function spawnRealCli(
  executable: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): CliChild {
  const proc = nodeSpawn(executable, args, {
    shell: false,
    cwd: opts.cwd,
    // 子4 E1 β 通道：附加 env merge 进子进程（USERPROFILE/HOME 假宿覆盖）；缺省 = 父 env
    // 原样（纯文本路径逐字节现行为——回归锚断言依赖该不变式）。
    env: opts.env !== undefined ? { ...process.env, ...opts.env } : process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 子4 E3 树杀（design §5.4）：posix 下 detached 让子进程自成进程组长——kill(-pid) 才能整组
    // 覆盖 MCP server 孙进程。win 无进程组概念（树杀走 taskkill /T），detached 无意义不设。
    // 代价（behavior-risk）：posix 子进程不再随父进程组的信号消亡——退出路径全在显式
    // kill/优雅关停（会话池），stdio 管道随父进程关闭时子进程收 EOF 自退（belt）。
    detached: process.platform !== 'win32',
  });
  const lineHandlers = new Set<(line: string) => void>();
  const stderrHandlers = new Set<(chunk: string) => void>();
  const exitHandlers = new Set<(code: number | null) => void>();
  let exited = false;
  let exitCode: number | null = null;

  const notifyExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    for (const handler of exitHandlers) handler(code);
  };
  // spawn 失败（ENOENT 等）：'error' 不伴随 'exit'——归一为退出（code null）+ 错误进
  // stderr 通道（driver 的 502 摘要可见「spawn ... ENOENT」）。
  proc.on('error', (err) => {
    const chunk = `spawn ${executable} failed: ${err.message}`;
    for (const handler of stderrHandlers) handler(chunk);
    notifyExit(null);
  });
  // 退出通知挂 'close'（进程已退 + stdio 全关）而非 'exit'（CR-5）：stdout 的残行冲刷
  // （'end' 时）先于退出通知——终帧 result 常无尾换行，挂 'exit' 会在冲刷前发通知 →
  // 「无 result」假 502。'error'（spawn 失败无 'close'）路径由上方归一覆盖。
  proc.on('close', (code) => notifyExit(code));
  // stdin 持久 error 兜底：writeLine 的 once('error') 只挂在写窗口（write 返 true 即
  // 摘除），而 EPIPE 可能异步晚到——写已受理、子进程在 flush 前死掉，错误落在两次写
  // 之间。无监听 'error' = uncaught exception 崩主进程。空 handler 吞掉即可：该 turn
  // 的失败由退出观察/写拒绝上抛，窗口内的错误仍被 writeLine 的 once 先收（注册序保证）。
  proc.stdin?.on('error', () => {});

  let stdoutBuf = '';
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      for (const handler of lineHandlers) handler(line);
    }
  });
  proc.stdout?.on('end', () => {
    // CR-5：流尽冲刷残行——无尾换行的终帧行（result）在此派发，先于 'close' 的退出
    // 通知（行到达序 ≠ 退出序，丢失终帧 = 终态误判 502）。
    if (stdoutBuf.length > 0) {
      const line = stdoutBuf;
      stdoutBuf = '';
      for (const handler of lineHandlers) handler(line);
    }
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    for (const handler of stderrHandlers) handler(chunk);
  });

  return {
    kill: () => {
      // CR-1（子4 CR 批）：子进程已退 → 零信号直接返回——OS 可能已回收 pid/pgid，
      // taskkill /T / kill(-pid) 对已回收 pid 发信号会命中复用该 pid 的**无关进程组**
      //（高危误杀面）。三判据并集：`exited`（close/error 已归一，含 spawn 失败形态）/
      // `exitCode`/`signalCode`（Node 在 'exit' 时即落值——覆盖 exit→close 的 stdio 排空
      // 窗口，此时退出观察者尚未通知但 pid 已死）。
      if (exited || proc.exitCode != null || proc.signalCode != null) {
        return;
      }
      // E3 树杀（design §5.4/D6）：mid-turn abort 的 kill 必须及 agy spawn 的 MCP server
      // 孙进程。taskkill 异步 fire-and-forget：进程已死时 taskkill 报「找不到进程」是幂等
      // 杀的常态，不构成失败信号（退出观察者收尾）；CR-2（子4 CR 批）：真启动级失败
      //（ENOENT/access denied 等）→ **回调内回落 plainKill**（仅杀直接子进程——belt：
      // 孙进程由 mcpServer stdin EOF 自退 + agy 会话结束关 server stdin 的官方 EOF 保障
      // 兜底，W0 §5 实测）。treeKillDispatch 的 sync-catch 回落只覆盖适配层同步异常
      //（execFile 异步报错不走 throw），异步失败面必须在此补回落。
      treeKillDispatch({
        platform: process.platform,
        pid: proc.pid,
        taskkill: (pid) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
            if (err === null || err === undefined) return;
            proc.kill();
          });
        },
        groupKill: (pid) => {
          process.kill(-pid, 'SIGTERM');
        },
        plainKill: () => {
          proc.kill();
        },
      });
    },
    endStdin: () => {
      proc.stdin.end();
    },
    writeLine: (line) =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        proc.stdin.once('error', onError);
        const proceed = (): void => {
          proc.stdin.removeListener('error', onError);
          resolve();
        };
        // 大 prompt 单行写入的背压纪律（复核 L8）：write 返 false → await drain。
        const ok = proc.stdin.write(`${line}\n`);
        if (ok) proceed();
        else proc.stdin.once('drain', proceed);
      }),
    onStdoutLine: (cb) => {
      lineHandlers.add(cb);
    },
    onStderrData: (cb) => {
      stderrHandlers.add(cb);
    },
    onExit: (cb) => {
      if (exited) cb(exitCode);
      else exitHandlers.add(cb);
    },
    hasExited: () => exited,
  };
}

export function defaultAgyPoolDeps(): AgyPoolDeps {
  return {
    spawn: spawnRealCli,
    mkdtemp: (prefix) => mkdtemp(path.join(os.tmpdir(), prefix)),
    removeDir: async (dir) => {
      await rm(dir, { recursive: true, force: true });
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      (timer as { unref?: () => void }).unref?.();
      return { clear: () => clearTimeout(timer) };
    },
    // CR-24：antigravityCli 簇观测单缝（deps.warn/deps.info），生产实现走包既有约定
    // ——warn 直发 console.warn；info 门控 ORISON_PROTOCOL_DEBUG（mirror generate.ts
    // 每请求仪表先例）。测试注入收集器，零 console 侦听。
    warn: (message) => {
      console.warn(message);
    },
    info: (message) => {
      if (process.env.ORISON_PROTOCOL_DEBUG) console.info(message);
    },
  };
}

// ── 驱动器组装 ──

export interface AntigravityCliDriver {
  /** CLI 形态生成（流式/非流式同实现；onDelta 缺省 = 非流式消费面）。 */
  generateText(
    model: ResolvedModel,
    request: TextGenerationRequest,
    ctx?: ProtocolCallContext,
    onDelta?: (d: GenerationDelta) => void,
  ): Promise<TextGenerationResponse>;
  /** 测试清理：全量关停 + 停清扫器。 */
  dispose(): void;
}

export function createAntigravityCliDriver(
  deps: AgyPoolDeps,
  opts?: ConstructorParameters<typeof AgySessionPool>[1],
): AntigravityCliDriver {
  const pool = new AgySessionPool(deps, opts);
  return {
    async generateText(model, request, ctx, onDelta) {
      // CLI 形态配置错防御（resolveModel 已在解析点拦截；协议层兜底）。
      if (!model.cliExecutable) {
        throw new ProtocolHttpError(
          `CLI-form model '${model.modelId}' resolved without cliExecutable — fix the provider key`,
          500,
        );
      }
      // tools 剥离（design §5）：非 fail-loud（agent 化写手必撞墙，正文可写是底线）、
      // 非静默（warn 含工具名清单 + driver 测试断言 tools 不进请求）。
      let effectiveRequest = request;
      if (request.tools !== undefined && request.tools.length > 0) {
        // CR-9：工具名提取防非 function 形态崩溃——agent 缝 `as any` 直调豁免 zod
        // parse，运行时垃圾形状可抵达此处；剥离本身不得被 warn 路径炸掉。
        const names = request.tools
          .map((t) => {
            const loose = t as { function?: { name?: string }; name?: unknown };
            return loose.function?.name ?? (typeof loose.name === 'string' ? loose.name : 'unknown');
          })
          .join(', ');
        deps.warn?.(
          `[antigravity-cli] request for key=${model.keyId} model=${model.modelId} carried ${request.tools.length} tool definition(s) [${names}] — the CLI form cannot bridge Closure tool calls; tools stripped (research phases degrade, prose unaffected)`,
        );
        effectiveRequest = { ...request, tools: undefined };
      }

      const { system, rest } = splitSystemMessages(effectiveRequest.messages);
      const segments = buildTurnSegments(system, rest);
      const hashes = hashSegments(segments);
      const lane = effectiveRequest.lane ?? ctx?.lane;
      const spec: CliSpawnSpec = {
        executable: model.cliExecutable,
        args: buildCliArgs({ model: model.modelId, lane, thinking: effectiveRequest.thinking }),
      };
      const outerBeltMs = printTimeoutForLane(lane).ms + PRINT_TIMEOUT_GRACE_MS;
      const turnOpts: TurnRunOptions = {
        onDelta,
        signal: ctx?.signal,
        outerBeltMs,
        warn: deps.warn,
        info: deps.info,
      };

      const runTurn = (session: AgyTurnSession): Promise<TurnRunResult> =>
        runTurnOnSession(session, segments, hashes, turnOpts, deps.setTimer);

      const result = effectiveRequest.sessionKey !== undefined && effectiveRequest.sessionKey.length > 0
        ? await pool.runTurn(
            { sessionKey: effectiveRequest.sessionKey, keyId: model.keyId, modelId: model.modelId },
            spec,
            ctx?.signal,
            runTurn,
          )
        : await pool.runOneshot(spec, ctx?.signal, runTurn);

      return {
        model: model.modelId,
        text: result.text,
        finishReason: 'stop',
        usage: result.usage,
      };
    },
    dispose() {
      pool.dispose();
    },
  };
}

// ── 模块级单例 + 测试覆写缝（generate.ts 分派点消费）──

const defaultDriver = createAntigravityCliDriver(defaultAgyPoolDeps());

export type AntigravityCliGenerateFn = AntigravityCliDriver['generateText'];

let generateOverride: AntigravityCliGenerateFn | undefined;

/** 测试缝：覆写/还原 generate.ts CLI 分派实际调用的驱动器。 */
export function setAntigravityCliGenerateForTest(fn: AntigravityCliGenerateFn | undefined): void {
  generateOverride = fn;
}

/** generate.ts 两分派点的唯一入口（缺省真驱动器；测试可覆写）。 */
export function antigravityCliGenerateText(
  model: ResolvedModel,
  request: TextGenerationRequest,
  ctx?: ProtocolCallContext,
  onDelta?: (d: GenerationDelta) => void,
): Promise<TextGenerationResponse> {
  return (generateOverride ?? defaultDriver.generateText)(model, request, ctx, onDelta);
}

/**
 * 缺省驱动器（模块单例）的全量关停——Electron main 退出（will-quit）时调用：
 * 优雅关停全部长驻 agy 进程 + 停清扫定时器，防子进程/定时器活过 app 生命周期
 * （09-12 W4 接线，mirror shell 侧 watcher stop-on-quit 先例）。
 */
export function disposeAntigravityCliDriver(): void {
  defaultDriver.dispose();
}
