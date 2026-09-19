import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import { bridgeHomeDirFor } from '@orison/model-protocols';
import { getLogger } from '../logger';

// ── agy CLI 日志观测（09-19 agy 工具面修复批 W3 · R9）──
//
// 观测面（**绝非功能判据**）：读 agy CLI 自己落的会话日志，判声明式 agent 的三态，在应用
// 日志里落一行。本批裁决 = **shell 侧模块 + 应用日志行，不做 IPC、不做 UI**。
//
// 定位（零 spawn 改动）：桥车道 spawn 本就未传 `--log-file`，且把 HOME/USERPROFILE 覆盖到
// 假宿 ⇒ 会话日志今天就在
//   `<homeRoot>/<净化 sessionId>/.gemini/antigravity-cli/log/cli-<YYYYMMDD_HHMMSS>.log`
// 同目录上一级 `cli.log` 指向本会话那份（agy 每进程启动改写）。路径由 `bridgeHomeDirFor`
// 纯函数复算。**绝不加 `--log-file`**：实测它与默认落点互斥（传了它假宿的 log/ 与 cli.log
// 都不创建），而桥 spawn 的 cwd 是进程池 mkdtemp、进程退出即删——加了反而把日志弄丢，且
// 逐进程唯一路径否则重试/降级重跑会原地清掉证据。
// 证据：`.trellis/tasks/09-19-agy-toolface-fix-batch/research/agy-log-observability-channel.md`
// §1/§2/§3。
//
// 锚点纪律（宽行号 + 窄文案）：行号随 agy 版本必然漂移（同一行文案 09-12 是 `:32`、09-19 是
// `:188`），故只认「文件名 + 文案」、绝不认行号；`launchsteps.go … falling back to default`
// 是噪音（加载成功的运行里同样出现），永不作为判据。
//
// 降级纪律（红线）：读不到 / 认不出 → `'unknown'`，**静默降级、零上抛、零功能影响**。agy 在
// 日志路径不可写时完全静默（exit 0、stderr 空、两处都无文件）⇒ 日志无法区分「agent 没加载」
// 与「日志没写成」——只作观测 / 告警 / 验收凭据，绝不进任何控制流。
//
// 生命周期：日志只在**假宿存活期**内可读（最后一个关联进程退出即整树删除；idle TTL 10 分钟
// 为上界）⇒ 「读不到」是常态之一，不是异常。

/** 声明式 agent 在 agy 侧的实际加载态（`unknown` = 读不到 / 认不出——绝不猜）。 */
export type AgyCliAgentState = 'agent-loaded' | 'agent-not-loaded' | 'agent-fallback' | 'unknown';

/** 取景时机（R9 三处）：桥会话开启 / 本会话首个 turn 正常完成 / 桥 turn 以空回合失败。 */
export type AgyCliLogReason = 'session-open' | 'first-turn-completed' | 'empty-turn-failure';

/** 观测结论（纯数据；`detail` 为人读数——未来消费者不得对它做等值匹配）。 */
export interface AgyCliLogInspection {
  state: AgyCliAgentState;
  /** 本会话日志目录（路径恒可算——文件未必存在；供人按图索骥）。 */
  logDir?: string;
  /** 实际读到的那份日志（文件名自带进程启动时刻，可人核新旧）。 */
  logFile?: string;
  /** 降级原因 / 命中说明（人读）。 */
  detail?: string;
}

// ── 锚点（宽行号 + 窄文案）──

/**
 * A1：agent 加载判据行（`conversation_manager.go:<行号>] Starting new conversation (agent=true)`）。
 * 实测 `true` / `false` 两态都出现 = 差分信号，无需负例校准。
 */
const AGENT_CONVERSATION_RE =
  /conversation_manager\.go:\d+\]\s+Starting new conversation \(agent=(true|false)\)/g;
/**
 * A2：第二独立信号（与 A1 同真值）：
 * `server.go:<行号>] Creating new cascade trajectory (agentScript=true)`。
 */
const AGENT_TRAJECTORY_RE =
  /server\.go:\d+\]\s+Creating new cascade trajectory \(agentScript=(true|false)\)/g;
/**
 * A3：显式 fallback 记录行（只在不加载时出现；**缺行 ≠ 成功**，须配 A1/A2 取值）。
 * 以 agent 专属整句为锚——`launchsteps.go … falling back to default` 噪音行绝不命中。
 */
const AGENT_FALLBACK_RE = /Agent "[^"]*" not found, falling back to default/;

/**
 * 协议层空 SUCCESS 终态原文片段（`events.ts` finishCliTurn 的 EMPTY message）。
 * 跨包文案耦合（shell → 协议层单向依赖，常量不可共享）：**由交叉校验测试守门**——
 * `test/agyCliLog.test.ts` 的「文案交叉校验」用例跑真 driver 产出该错误，断言本针命中；
 * 协议层改文案而此处不同步 = 该测试红（不是静默失效）。
 */
const EMPTY_TURN_MESSAGE_NEEDLE = 'produced no response text';

/**
 * 协议层内置工具自动拒 412 的指引文案片段（`driver.ts` CLI_TOOL_AUTO_DENY_GUIDANCE_MESSAGE
 * 的 `… invoked a built-in agy tool …`）。与 MCP 预授权 412 家族（同状态码、另文案）靠
 * **消息身份**区分——裸状态码 412 不构成归属判据。守门同上（交叉校验测试跑真 classifyCliError
 * 产出该 412 并断言本针命中；MCP 家族断言不命中）。
 */
const BUILTIN_TOOL_DENY_MESSAGE_NEEDLE = 'built-in agy tool';

/** 会话日志文件名形态（`cli-<YYYYMMDD>_<HHMMSS>.log`——零填充，字典序即时间序）。 */
const LOG_FILE_NAME_RE = /^cli-\d{8}_\d{6}\.log$/;

/** 判据行都在进程起步段——只读文件头（有界读，避免长会话整份灌内存）。 */
const LOG_HEAD_READ_BYTES = 128 * 1024;

// ── 路径派生（复用协议层假宿段规则——路径单源，勿另写净化）──

/** 假宿内 agy 会话日志目录。 */
export function agyCliLogDirFor(homeRoot: string, sessionId: string): string {
  return path.join(bridgeHomeDirFor(homeRoot, sessionId), '.gemini', 'antigravity-cli', 'log');
}

/** 本会话日志指针（agy 每进程启动改写的 `cli.log`）。 */
export function agyCliLogLinkPathFor(homeRoot: string, sessionId: string): string {
  return path.join(bridgeHomeDirFor(homeRoot, sessionId), '.gemini', 'antigravity-cli', 'cli.log');
}

// ── 归类（纯函数）──

function lastFlag(text: string, re: RegExp): 'true' | 'false' | undefined {
  let last: 'true' | 'false' | undefined;
  for (const m of text.matchAll(re)) last = m[1] as 'true' | 'false';
  return last;
}

/** 日志文本 → agent 三态（纯函数；认不出走 `'unknown'`，绝不猜）。 */
export function classifyAgyCliLog(text: string): { state: AgyCliAgentState; detail?: string } {
  if (AGENT_FALLBACK_RE.test(text)) {
    return {
      state: 'agent-fallback',
      detail: '命中 fallback 记录行（Agent "<name>" not found, falling back to default）',
    };
  }
  const conversation = lastFlag(text, AGENT_CONVERSATION_RE);
  const trajectory = lastFlag(text, AGENT_TRAJECTORY_RE);
  if (conversation === 'true' && trajectory === 'true') return { state: 'agent-loaded' };
  if (conversation === 'false' && trajectory === 'false') {
    return { state: 'agent-not-loaded', detail: 'agent=false 且 agentScript=false（未请求或静默未加载）' };
  }
  return { state: 'unknown', detail: '未命中 agent 判据行（进程刚起步 / 日志截断 / 文案漂移）' };
}

// ── 定位 + 读取（best-effort；任何失败都返回 undefined 不抛）──

function readLogHead(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(LOG_HEAD_READ_BYTES);
    const bytes = readSync(fd, buf, 0, LOG_HEAD_READ_BYTES, 0);
    return buf.subarray(0, bytes).toString('utf8');
  } catch {
    return undefined; // 缺失 / 权限 / EISDIR / 半截写 → 调用方按 unknown 走
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * 定位本会话日志文件：① `cli.log` 指针（agy 每进程启动改写；桥长驻进程即本会话那份）；
 * ② 退化到 `log/` 下文件名最新一份（防符号链接没建出来——Windows 无开发者模式时 agy
 * 可能建不出链接，但 `cli-*.log` 正文件照写）。都找不到 → undefined。
 *
 * 已知干扰（观测面容忍）：`prepareBridgeHome` 把真实 `.gemini` 整树拷进假宿（含用户历史
 * 日志）——本会话文件按进程启动时刻命名，恒晚于任何被拷入的历史份；`cli.log` 由 agy 每
 * 进程启动改写为指向本会话那份。极窄窗口（两处都落空）下可能读到历史份，故结论只作观测。
 */
function locateAgyCliLogFile(logDir: string, linkPath: string): string | undefined {
  if (existsSync(linkPath)) return linkPath;
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch {
    return undefined;
  }
  const newest = names.filter((n) => LOG_FILE_NAME_RE.test(n)).sort().at(-1);
  return newest !== undefined ? path.join(logDir, newest) : undefined;
}

/** 读一次本会话日志并判 agent 三态（纯观测；**绝不抛穿**）。 */
export function inspectAgyCliLog(input: { homeRoot: string; sessionId: string }): AgyCliLogInspection {
  let logDir: string;
  let linkPath: string;
  try {
    logDir = agyCliLogDirFor(input.homeRoot, input.sessionId);
    linkPath = agyCliLogLinkPathFor(input.homeRoot, input.sessionId);
  } catch {
    // bridgeHomeDirFor 对净化后为空 / 点段的 sessionId 类型化拒绝——观测面就地消化。
    return { state: 'unknown', detail: '假宿路径段派生拒绝（sessionId 非法）' };
  }
  const file = locateAgyCliLogFile(logDir, linkPath);
  if (file === undefined) {
    return {
      state: 'unknown',
      logDir,
      detail: '尚无本会话日志（进程未起 / 假宿已随进程退出删除 / 路径不可写——agy 静默）',
    };
  }
  const text = readLogHead(file);
  if (text === undefined) {
    return { state: 'unknown', logDir, logFile: file, detail: '日志存在但读不了（权限 / 半截写）' };
  }
  const verdict = classifyAgyCliLog(text);
  return {
    state: verdict.state,
    logDir,
    logFile: file,
    ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
  };
}

// ── 落一行（观测出口）──

/** 观测落行 sink（pino 形态；测试注入收集器）。 */
export interface AgyCliLogSink {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

/**
 * 读一次 + 在应用日志落一行（含 agent 三态与日志路径），返回观测结论（生产忽略返回值）。
 * 级别：故障专道（空回合失败）走 warn，其余两处取景走 info。
 * **绝不抛穿**：读取 / 归类 / 落行任何环节失败都只在观测面内消化——调用方功能路径零感知。
 */
export function observeAgyCliAgentState(input: {
  homeRoot: string;
  sessionId: string;
  reason: AgyCliLogReason;
  /** 缺省 `getLogger()`。 */
  sink?: AgyCliLogSink;
}): AgyCliLogInspection {
  const inspection = inspectAgyCliLog({ homeRoot: input.homeRoot, sessionId: input.sessionId });
  const payload: Record<string, unknown> = {
    component: 'agy-bridge',
    sessionId: input.sessionId,
    reason: input.reason,
    agentState: inspection.state,
    ...(inspection.logDir !== undefined ? { logDir: inspection.logDir } : {}),
    ...(inspection.logFile !== undefined ? { logFile: inspection.logFile } : {}),
    ...(inspection.detail !== undefined ? { detail: inspection.detail } : {}),
  };
  const message = `agy cli log observation (${input.reason}): agent state = ${inspection.state}`;
  try {
    const sink = input.sink ?? getLogger();
    if (input.reason === 'empty-turn-failure') sink.warn(payload, message);
    else sink.info(payload, message);
  } catch {
    /* 落行失败（logger 传输异常）同样静默——观测面绝不反向影响功能路径。 */
  }
  return inspection;
}

/**
 * 空回合失败族判据（**观测面专用**——决定要不要读日志，绝不参与功能控制流）：
 *   ① 内置工具无头自动拒（内置工具 412 指引文案 = F8 定谳的空回合第一大族）；
 *   ② 空 SUCCESS 终态（协议层 EMPTY 原文 `… produced no response text …`，桥车道 502）。
 *
 * 两族都按**消息身份**（文案片段）判定，**不按裸状态码**：412 自本批起有两个家族——
 * 内置工具被拒（本族）与 MCP 预授权软拒（remedy = 去设置页补授权，不是「内置工具被拒」，
 * 见 driver.ts 两条合成行）——按裸 412 归族会把后者错报成前者。
 *
 * 认不出（abort / 超时 / quota / 认证 / 一般 5xx）→ false。认证失败虽同样零文本，但错误面
 * 已有独立指引（401 认证文案），不属本观测窗口。桥车道不做纯文本车道的 `cliEmptySuccess`
 * 标记（那是整 turn 重试信号），故此处按错误面事实（文案片段）判定。
 */
export function isEmptyTurnFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes(BUILTIN_TOOL_DENY_MESSAGE_NEEDLE)) return true;
  return err.message.includes(EMPTY_TURN_MESSAGE_NEEDLE);
}
