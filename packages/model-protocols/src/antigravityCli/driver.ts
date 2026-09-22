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
  classifyGenerationFailure,
  isContextOverflowError,
} from '../errors';
import type { AttemptMeteringRecord } from '../usageSink';
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
import { findPermissionSoftDenySubject, hasMcpPermissionSoftDeny, isMcpPermissionSubject } from './permissionSoftDeny';
import {
  AgySessionPool,
  agySessionKeyId,
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
// 聚合，onDelta 缺省不外发。driver 内唯一自动重试 = 空 SUCCESS 整 turn 恰一次（CLI 纯文本
// 车道模型偶发空转的整 turn 级兜底）；其余失败不自动重试（防放大；重试/回退归调用方与子2 链）。

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
 * 共用同一词表——两处判定不得各自漂移）。三类信号形态：交互登录引导
 *（Authentication required…）、登录等待超时（authentication failed or timed out…）、
 * 裸 401 状态行（status: 401）。
 */
export function isAuthError(text: string): boolean {
  return /authenticat|auth required|not logged in|login required|status: ?401\b/i.test(text);
}

/**
 * CLI 内置工具权限自动拒绝的短语族判定（子串取自 agy headless 拒绝通知的稳定原文）：
 * headless print 模式弹不出权限窗，agy 对模型调用的内置工具（command/浏览器/搜索类）
 * 一律自动拒绝并在 stderr 打通知，turn 仍以 SUCCESS 零文本收尾。
 *
 * R6/F9 单源主语分派（先于旧短语族）：文本命中**权限软拒主体**时按主体归族——主体
 * 'mcp' = MCP 工具预授权被拒（桥侧 soft-denied 诊断路径），**绝不**判成内置工具族
 *（旧针 `cannot prompt for` 把 MCP 软拒通知一并卷进来 → 用户面拿到归因错误的指引）；
 * 其它主体（command/read_file/…）= 内置工具被权限拦下，属本族。主体判据单源 =
 * permissionSoftDeny.ts（桥侧三针同源——两车道不漂移），**含 CR-3 去装饰归一与 MCP
 * 主体优先**：haystack 同时含两类主体时以 MCP 为准（显式规则，非文本位置首次命中）。
 * 无主体形态回落旧三子串。
 */
export function isBuiltinToolAutoDeny(text: string): boolean {
  const subject = findPermissionSoftDenySubject(text);
  if (subject !== undefined) return !isMcpPermissionSubject(subject);
  return /no output produced|auto-denied|cannot prompt for/i.test(text);
}

/**
 * 空 SUCCESS 错误的判定缝（driver 单次重试的唯一信号读取点）：finishOutcome 在终态
 * status='EMPTY'（SUCCESS 收尾但零文本）时给分类产物挂内部标记——错误面（类型/message/
 * excerpt）零变化，仅作重试包装层判别。认证命中时不挂标记（凭据失效重试必然同死），
 * 其余分类照挂（含内置工具自动拒——模型行为有随机性，恰一次重试给第二次机会）。
 */
export function isCliEmptySuccessError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { cliEmptySuccess?: boolean }).cliEmptySuccess === true;
}

/**
 * 挂空 SUCCESS 内部标记（对错误对象自身的附加位，不改写任何既有字段）。C3.1：attempt
 * 计量 usage 旁挂同点——wrapper 失败行（M1）与空 SUCCESS 重试发射点读它。usage 未知
 *（undefined）不挂——「已知则记」（CR-18 v2），绝不伪造。
 */
function tagCliEmptySuccess(err: Error, attemptUsage: GenerationUsage | undefined): Error {
  (err as Error & { cliEmptySuccess?: boolean }).cliEmptySuccess = true;
  if (attemptUsage !== undefined) {
    (err as Error & { cliAttemptUsage?: GenerationUsage }).cliAttemptUsage = attemptUsage;
  }
  return err;
}

/**
 * 计量读缝（C3.1 M1，generate.ts wrapper 失败行 + driver 重试发射点消费）：错误对象
 * 旁挂的 attempt usage——已知名则记、未知 undefined（CR-18 v2「未知才 ABSENT」）。
 */
export function readCliAttemptUsage(err: unknown): GenerationUsage | undefined {
  return err instanceof Error
    ? (err as Error & { cliAttemptUsage?: GenerationUsage }).cliAttemptUsage
    : undefined;
}

function isQuotaError(text: string): boolean {
  return /quota|rate.?limit|429|too many requests/i.test(text);
}

function isInvalidModelError(text: string): boolean {
  return /invalid model|unknown model|model not (found|supported)/i.test(text);
}

/**
 * CLI 认证错误的用户面文案（driver 层错误文案惯例为英文）：认证信号通常来自 stderr
 *（原文留在 bodyExcerpt 作证据），message 统一换成带操作指引的一句话——
 * 「SUCCESS 但零文本」等泛化终态文本不再顶到用户面（对认证失效场景不可读也无指引）。
 */
const CLI_AUTH_GUIDANCE_MESSAGE =
  'antigravity-cli authentication failed: the CLI is not logged in or its login has expired. Run the agy CLI in a terminal to complete the interactive login, then retry.';

/**
 * CLI 内置工具权限被拒的用户面文案（driver 层错误文案惯例为英文，风格对齐认证指引）：
 * 「SUCCESS 但零文本」谜语换成因果 + 出路——内置工具在无头运行里拿不到授权，工具面
 * 操作必须走会话桥接进来的 MCP 工具。server 名不在此硬编码（单源在 bridgeTurn，跨模块
 * 引用会成环），文案用「本会话桥接的 MCP 工具」指称。
 */
const CLI_TOOL_AUTO_DENY_GUIDANCE_MESSAGE =
  'antigravity-cli turn produced no output: the model invoked a built-in agy tool (command/browser/search family) that headless mode cannot prompt permissions for, so it was auto-denied. Built-in tools cannot be granted in headless runs; file, story-data and web work must go through the MCP bridge tools provided to this session.';

/**
 * CLI **MCP 工具预授权**软拒的用户面文案（R6/F9 反向的第二条合成 412 行——与内置工具族
 * 各说各话）：MCP 主体软拒 = **会话授权事实**，不是模型缺陷——同一条桥、同一套预授权，
 * 换模型撞同一堵墙（回退链烧一轮纯浪费，故与内置工具行同用 412「合成状态」落
 * other/eligible=false）。用户面出路 = 补 MCP 工具桥预授权 / 检查 agy 权限规则后重试，
 * 与桥侧 soft-denied 通知（D6 诊断）同向。server 名不在此硬编码（单源在协议层 agents.ts，
 * 文案用「本会话桥接的 MCP 工具」指称）。设置页路径措辞对齐 UI 通知条（Settings → Models
 * → MCP Tool Bridge）。
 */
const CLI_MCP_SOFT_DENY_GUIDANCE_MESSAGE =
  'antigravity-cli turn produced no output: the model called an MCP bridge tool that this session\'s pre-authorization rules deny, and headless mode cannot prompt for permission, so the call was auto-denied. This is a session authorization fact, not a model failure — switching models hits the same wall. Review the MCP tool-bridge authorization in Settings → Models → MCP Tool Bridge (or the agy permission rules), then retry.';

/**
 * 错误文本 → 协议层错误类型。顺序：auth → quota → 模型配置 → 权限软拒族（内置工具 412 /
 * MCP 预授权 412）→ 上下文溢出 → 502 兜底。auth 命中时 message 统一为认证指引，两条
 * 软拒行各自统一为对应指引（形态所致 vs 会话授权事实——两分支由同一主体判据**互斥**
 * 分派：MCP 主体优先于内置主体，见 permissionSoftDeny.findPermissionSoftDenySubject；
 * 主语判据单源在 permissionSoftDeny.ts）。排序依据：认证比软拒更终结（凭据失效是全线
 * 事实）在前；软拒族排在瞬态行（quota/模型配置）之后——turn 真死于瞬态时瞬态才是可
 * 行动真相（换模型可能有用，链应推进），拒绝通知只作为空 SUCCESS 的解释在无更强信号时
 * 命中。
 */
export function classifyCliError(message: string, excerpt: string): Error {
  const haystack = `${message}\n${excerpt}`;
  if (isAuthError(haystack)) return new ProtocolHttpError(CLI_AUTH_GUIDANCE_MESSAGE, 401, excerpt);
  if (isQuotaError(haystack)) return new ProtocolHttpError(message, 429, excerpt);
  if (isInvalidModelError(haystack)) return new ProtocolSchemaError(message);
  // 内置工具自动拒 = CLI 无头形态的内禀缺陷，换模型大概率同死 → 合成 412（非特判状态，
  // 回退分类落 other 行 eligible=false 不烧链）+ stderr 原文留 excerpt 作证据——与认证
  // 落法同族（合成状态 + 人话 message + excerpt），不新增错误种类。
  if (isBuiltinToolAutoDeny(haystack)) {
    return new ProtocolHttpError(CLI_TOOL_AUTO_DENY_GUIDANCE_MESSAGE, 412, excerpt);
  }
  // MCP 主体预授权软拒（F9 反向 + R6）：**会话授权事实**——同一条桥/同一套预授权换模型
  // 同死（不烧链，回落 other/eligible=false 同一机制），但用户面出路是「去设置页补授权 /
  // 查 agy 权限规则」而非「换模型/改工具用法」→ 独立文案独立行（与内置工具行各说各话）。
  if (hasMcpPermissionSoftDeny(haystack)) {
    return new ProtocolHttpError(CLI_MCP_SOFT_DENY_GUIDANCE_MESSAGE, 412, excerpt);
  }
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
  /**
   * 行为级降级带信号（09-19 白名单 W3/R3）：本轮出现任何内置工具 step。仅在挂 agent 的
   * spawn 上武装——无 agent 的 turn 本就走默认形态，没有可降级的 agent 车道。
   *
   * ⚠️ 归因纪律（2026-09-19 真机实证纠正）：工具 step **不是**「agent 未加载」的证据——
   * agy 1.2.2 实测挂 agent 加载成功（agent=true、system prompt 被整体替换、input tokens
   * 腰斩）时内置工具仍可调用、可执行。零工具 agent 的效果是**收窄但未清零**内置工具面。
   * 证据：`.trellis/tasks/09-19-agy-toolface-fix-batch/research/f8-builtin-tool-stream-signal.md`
   * （§0/§4/§5）。
   */
  onToolStep: (() => void) | undefined;
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
          const excerpt = stderrExcerpt(stderrBuf);
          const err = classifyCliError(outcome.message, excerpt);
          // 空 SUCCESS 挂重试标记（仅纯空收尾——stderr 认证信号命中即凭据问题，重试无意义）。
          if (outcome.status === 'EMPTY' && !isAuthError(`${outcome.message}\n${excerpt}`)) {
            // C3.1（m5 修正）：attempt usage 旁挂取 acc.* 计数器域——EMPTY 走 error 形态
            // outcome（CliTurnOutcome 的 error variant 不携带 usage/sawStepUsage），计数器
            // 在 accumulator 在场；未知（sawStepUsage false）不挂——「已知则记」CR-18 v2。
            tagCliEmptySuccess(err, acc.sawStepUsage ? mapCliUsage(acc.stepUsageSum) : undefined);
          }
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
        // 降级带信号（W3/R3）：仅挂 agent 的 spawn 武装了此缝——记账给 generateText 层的
        // 恰一次降级判定（见下）。
        opts.onToolStep?.();
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
          // windowsHide 与其余 spawn 点对齐（多 OS R5）：GUI 主进程 spawn 控制台程序
          //（taskkill）时 Windows 理论上闪现 console 窗。
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
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

/**
 * 纯文本车道零工具 agent 解析器（09-19 白名单 W3）：返回布局常量激活值
 *（agents.ts CLOSURE_TEXT_AGENT_LAYOUT.agentName）挂 `--agent`，或 undefined 走现状
 * 无 agent 路径（γ 反工具硬化兜底）。决策（enabled/文件态/CLI key 前提）归 shell 闭包
 * ——协议层只消费激活值。
 */
export type ResolveTextAgentFn = () => string | undefined;

export interface AntigravityCliDriverOptions {
  /**
   * 每 turn 组 spec 时咨询的 agent 解析器（工厂显式注入——测试用）。缺省 = 模块级
   * override（shell 生产注入缝 setAntigravityCliTextAgentResolver，单例驱动器消费）。
   */
  resolveTextAgent?: ResolveTextAgentFn;
}

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

/** 降级会话键记账上限（防无界增长；FIFO 逐出——链会话键一次性，过期即弃）。 */
const MAX_DEGRADED_SESSION_KEYS = 200;

export function createAntigravityCliDriver(
  deps: AgyPoolDeps,
  opts?: ConstructorParameters<typeof AgySessionPool>[1],
  driverOpts?: AntigravityCliDriverOptions,
): AntigravityCliDriver {
  const pool = new AgySessionPool(deps, opts);
  // 降级带触发过的会话键记账（AC3：降级后同会话恒走无 agent spec——防逐 turn 重降级的
  // 作废/重启 churn）。驱动器实例级（生产单例 = app 生命周期，重启即清）。
  const degradedSessionKeys = new Set<string>();
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

      // ── 零工具 agent 解析（09-19 白名单 W3，design §1.1/§3.1）──每 turn 组 spec 时
      // 咨询。已降级的会话键恒无 agent（防循环，AC3）；resolver undefined = 现状无 agent
      // 路径——driver 侧静默（原因与警示归 shell 闭包），不触发降级带。
      const sessionKeyIdText =
        effectiveRequest.sessionKey !== undefined && effectiveRequest.sessionKey.length > 0
          ? agySessionKeyId({ sessionKey: effectiveRequest.sessionKey, keyId: model.keyId, modelId: model.modelId })
          : undefined;
      const degraded = sessionKeyIdText !== undefined && degradedSessionKeys.has(sessionKeyIdText);
      const resolveTextAgent = driverOpts?.resolveTextAgent ?? textAgentResolverOverride;
      const resolvedAgentName = degraded || resolveTextAgent === undefined ? undefined : resolveTextAgent();
      const agentName =
        typeof resolvedAgentName === 'string' && resolvedAgentName.length > 0 ? resolvedAgentName : undefined;

      const spec: CliSpawnSpec = {
        executable: model.cliExecutable,
        args: buildCliArgs({
          model: model.modelId,
          lane,
          thinking: effectiveRequest.thinking,
          ...(agentName !== undefined ? { agentName } : {}),
        }),
      };
      const outerBeltMs = printTimeoutForLane(lane).ms + PRINT_TIMEOUT_GRACE_MS;
      // 工具 step 证据按进程代次记账（CR-4）：每次 runTurn 进入 = 一次进程尝试，进入时
      // 旧证据作废。本调用内的 runTurn 重入只有两形态、都必然重生进程——空 SUCCESS 重试
      // 走零尾段分歧冷重启；降级重跑换 spec 触发池重生。故干净重试成功后不残留首轮证据
      // （空 SUCCESS 干净重试成功不再触发第三次无谓降级重跑）。
      let sawToolStep = false;
      const turnOpts: TurnRunOptions = {
        onDelta,
        signal: ctx?.signal,
        outerBeltMs,
        warn: deps.warn,
        info: deps.info,
        // 降级带信号仅在挂 agent 的 spawn 上武装——无 agent 的 turn 本就走默认形态，没有
        // 可降级的 agent 车道（归因纪律见 TurnRunOptions.onToolStep）。
        onToolStep: agentName !== undefined ? () => { sawToolStep = true; } : undefined,
      };

      const runTurn = (session: AgyTurnSession): Promise<TurnRunResult> => {
        sawToolStep = false;
        return runTurnOnSession(session, segments, hashes, turnOpts, deps.setTimer);
      };

      // C3.1 attempt 上抛（design §4）：经 ctx.onMeteringAttempt 交入口收集器统一
      // dispatch（driver 不直接 dispatch——发射面单点）。best-effort：收集器抛错不阻
      // turn 主流程（warn 经 deps 单缝观测）。
      const emitAttempt = (rec: AttemptMeteringRecord): void => {
        const emit = ctx?.onMeteringAttempt;
        if (emit === undefined) return;
        try {
          emit(rec);
        } catch (err) {
          deps.warn?.(
            `[antigravity-cli] metering attempt collector threw (ignored; turn result unaffected): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      // 空 SUCCESS 单次重试：整 turn 恰重试一次，会话车道与 oneshot 同过此缝（最小公共缝）。
      // 重试对同一会话句柄再跑一轮——首轮已提交镜像 → 零尾段分歧 → 自动冷重启，即同 spec
      // 全新尝试。第二次仍空（或首轮是认证等不可重试终因）→ 原样上抛，调用方错误面零变化。
      // 记账跨降级重跑共享（恰一次语义覆盖整个 generateText 调用）。
      let retriedEmptySuccess = false;
      const runTurnWithEmptyRetry = (session: AgyTurnSession): Promise<TurnRunResult> => {
        // C3.1 m1：attempt 计时（发射点各记起止——attempt 行 latencyMs 必填不悬空）。
        const attemptStartedAt = Date.now();
        return runTurn(session).catch((err) => {
          if (!isCliEmptySuccessError(err) || retriedEmptySuccess) throw err;
          retriedEmptySuccess = true;
          // C3.1 attempt 级记账（design §4 时序①）：重试**前**发射 attempt1 失败行——
          // usage 读错误旁挂（tagCliEmptySuccess 同点挂，计数器在场已知则记）。attempt2
          // 由入口 wrapper 正常落行 → 合计恰两行、共享 callId。
          const attemptUsage = readCliAttemptUsage(err);
          emitAttempt({
            success: false,
            errorKind: 'cli-empty-success',
            errorMessage: err instanceof Error ? err.message : String(err),
            ...(attemptUsage !== undefined ? { usage: attemptUsage } : {}),
            latencyMs: Date.now() - attemptStartedAt,
          });
          deps.warn?.(
            `[antigravity-cli] turn ended SUCCESS with no text — retrying the whole turn once (fresh attempt) key=${model.keyId} model=${model.modelId}`,
          );
          return runTurn(session);
        });
      };

      const runOnce = (runSpec: CliSpawnSpec): Promise<TurnRunResult> =>
        sessionKeyIdText !== undefined
          ? pool.runTurn(
              { sessionKey: effectiveRequest.sessionKey!, keyId: model.keyId, modelId: model.modelId },
              runSpec,
              ctx?.signal,
              runTurnWithEmptyRetry,
            )
          : pool.runOneshot(runSpec, ctx?.signal, runTurnWithEmptyRetry);

      // C3.1 m1：attempt1 计时（降级重跑发射点的被弃行 latencyMs 源）。
      const firstAttemptStartedAt = Date.now();
      let result = await runOnce(spec);
      const firstAttemptMs = Date.now() - firstAttemptStartedAt;
      if (agentName !== undefined && sawToolStep) {
        // ── 行为级降级带（09-19 白名单 W3/R3，design 权衡 8）──挂 agent 的 turn 出现内置
        // 工具 step ⇒ 恰一次以无 agent spec 重跑本 turn：会话车道下镜像「已发」比对判零尾
        // 段分歧 → 自动冷重启换新 spec 进程（旧 agent 进程走优雅关停）；oneshot 直接新
        // spawn。CR-4：判定读的是当前进程代次的证据（runTurn 重入即重置，见上）；重跑失败
        // 不整 turn 拒绝（下方 catch 保首试成功结果）。
        //
        // ⚠️ 归因纠正（2026-09-19 F12 真机实证）：工具 step **不是** agent 未加载的证据——
        // 挂 agent 时内置工具仍可调用（收窄未清零），本分支在正常加载态同样触发；且「退回
        // 无 agent」的有效性**未经验证**（欠账，见 task design §W3.1）——本段只保留行为，
        // 不背书归因。证据：research/f8-builtin-tool-stream-signal.md §4/§5。
        if (sessionKeyIdText !== undefined) {
          degradedSessionKeys.add(sessionKeyIdText);
          if (degradedSessionKeys.size > MAX_DEGRADED_SESSION_KEYS) {
            const oldest = degradedSessionKeys.values().next().value;
            if (oldest !== undefined) degradedSessionKeys.delete(oldest);
          }
        }
        deps.warn?.(
          `[antigravity-cli] text agent '${agentName}' lane produced a built-in tool step (a tool step is not evidence the agent failed to load — the declarative agent narrows, but does not zero, agy's built-in tool face) — retrying this turn without --agent (once); session stays on the no-agent lane key=${model.keyId} model=${model.modelId}`,
        );
        // C3.1 m1：attempt2 计时起点（重跑发射点用）。
        const rerunStartedAt = Date.now();
        try {
          const rerunResult = await runOnce({
            executable: model.cliExecutable,
            args: buildCliArgs({ model: model.modelId, lane, thinking: effectiveRequest.thinking }),
          });
          // C3.1 attempt 级记账（design §4 时序②——**替换确认后**发射）：attempt2 成功，
          // 首试结果被弃，其已知消耗如实入账（成功被弃行：errorKind/errorMessage ABSENT）。
          // attempt2 由入口 wrapper 正常落行。
          emitAttempt({
            success: true,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            latencyMs: firstAttemptMs,
          });
          result = rerunResult;
        } catch (err) {
          // CR-4：降级重跑失败不把首试成功结果变整 turn 拒绝（mirror bridgeTurn CR-5
          // 打回重跑失败先例——接受首轮结果 + 警告）。abort 族照常上抛：用户中断不是
          // 可吞失败（createCliAbortError 归一 name='AbortError'）。
          const abortLike = (err instanceof Error && err.name === 'AbortError') || ctx?.signal?.aborted === true;
          if (abortLike) throw err; // C3.1（m2 defer）：abort 族如实不记——零发射上抛
          // C3.1 attempt 级记账（design §4 时序②）：attempt2 失败行发射（errorKind 走
          // classifyGenerationFailure 同族词表）。attempt1 是最终行、由入口 wrapper 正常
          // 落行，**不**在此发射——防把 attempt1 记两遍（首试结果被采用为最终 response，
          // wrapper 最终行即 attempt1）。
          const attemptUsage = readCliAttemptUsage(err);
          emitAttempt({
            success: false,
            // 空 SUCCESS（重试已耗尽）保持专属词——classifyGenerationFailure 对它只给
            // 'server'，丢空 SUCCESS 语义；非空失败照常走分类同族词表。
            errorKind: isCliEmptySuccessError(err) ? 'cli-empty-success' : classifyGenerationFailure(err).kind,
            errorMessage: err instanceof Error ? err.message : String(err),
            ...(attemptUsage !== undefined ? { usage: attemptUsage } : {}),
            latencyMs: Date.now() - rerunStartedAt,
          });
          deps.warn?.(
            `[antigravity-cli] degradation rerun without --agent failed (${err instanceof Error ? err.message : String(err)}) — keeping the first-pass result key=${model.keyId} model=${model.modelId}`,
          );
        }
      }

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

let textAgentResolverOverride: ResolveTextAgentFn | undefined;

/**
 * 生产注入缝（shell agentIpc 装配调用；undefined 复位）：生产单例驱动器（裸工厂构造，
 * 无 driverOpts）每 turn 读此 override。wiring 测试经 __getAntigravityCliTextAgentResolverForTest
 * 钉死漏装配（mirror agent 包 __getAgyBridgeModeResolverForTest 先例）。
 */
export function setAntigravityCliTextAgentResolver(fn: ResolveTextAgentFn | undefined): void {
  textAgentResolverOverride = fn;
}

/** wiring 测试探针：当前注入的文本 agent 解析器（漏装配 = undefined → 红）。 */
export function __getAntigravityCliTextAgentResolverForTest(): ResolveTextAgentFn | undefined {
  return textAgentResolverOverride;
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
