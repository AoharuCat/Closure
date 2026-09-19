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
// 09-19 CLI 内置工具白名单 W2/W5：桥 spawn 恒挂声明式 agent（agent 文件不声明 `tools`
// + system prompt 通道）——激活值取布局常量单源，禁止字面量散落（agents.ts 布局节隔离
// 注释）；W5 起 BRIDGE_MCP_SERVER_NAME 单源也在 agents.ts（桥 agent 正文插值用），本模块
// 转发导出。
import { AGY_MCP_DISPATCHER_TOOL_NAME, BRIDGE_MCP_SERVER_NAME, CLOSURE_BRIDGE_AGENT_LAYOUT } from './agents';
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
  isMcpPermissionSubject,
  parsePermissionSoftDenyMessageSubject,
  parsePermissionSoftDenyStderrSubject,
  type PermissionSoftDenySubject,
} from './permissionSoftDeny';
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
//     + 桥声明式 agent 文件写入实现经 AgyBridgeCore 注入，本模块零 fs）；
//   - 工具步相位记录（E2：events toolStepStarted/Result/Error → BridgeToolStepRecord）
//     + MCP 派发解析（ServerName/ToolName/Arguments）；
//   - present_result 事后核验 + 同会话 stdin 增量行打回**恰好一次**（D5——不用
//     `--conversation`：无缓存且慢 ~15×）；
//   - R7 内置工具步纠正续跑（同一 cycle 内 + 至多一次）：模型离开桥工具族（非 novel-writing
//     派发步）时注入纠正行并续跑——实测判据行到空终态仅 ≈1ms（早停零收益），而 agy 接受
//     turn 未结束时写入的 stdin 行并当作下一轮（f8 §3/§6 处置 B）；
//   - 权限软拒族 matcher（W0 §2 三形态 + R6 主体分派：流事件 tool_info.error 主信号 +
//     stderr 兜底① + denied_actions 兜底②；'mcp' 主体 → soft-denied、其它主体 →
//     builtin-tool-denied——主语判据单源在 permissionSoftDeny.ts）。
//
// cycle 骨架 mirror driver.runTurnOnSession（belt/abort/settle/CR-2/CR-3/CR-8 守卫同构）；
// 语义差异：工具步消费（非 warn）、打回二段、软拒累积、print-timeout 档。两侧 CR 守卫
// 修复须同步（勿单侧回退）。
//
// DI seam（mirror installAgentImagePartsCore 先例）：core 由 shell
// installShellAgyBridgeCore 装配（假宿写入/管道注册表/spawn deps）；未装配即调用 →
// 响亮失败（wiring 测试钉死，不静默降级）。零真进程：spawn/mkdtemp/removeDir/timer 全
// 经 poolDeps 注入（testing-discipline）。

/** MCP server 名（单源在 agents.ts——W5 常量落内容源；此处转发保持既有 import 路径）。 */
export { BRIDGE_MCP_SERVER_NAME };

/**
 * 桥 turn 输出框架声明（compose 指令块输出要求覆盖）：与纯文本 CLI_OUTPUT_DIRECTIVE
 * （「不要调用任何工具」）相反——工具调用是桥的预期行为。不点名 agy 侧派发器（经
 * MCP 继承通道注入，与声明式 agent 正交——研究报告 §5），server 名插值自
 * BRIDGE_MCP_SERVER_NAME 单源（CR-24：改名单点生效）。
 *
 * W5 瘦身（09-19 白名单落地）：常驻纪律上移 CLOSURE_BRIDGE_AGENT 正文（novel-writing
 * 工具纪律 + present_result 协议常驻段——design 权衡 6 同波次原子落地），本指令只留
 * 逐 turn 能水 + 工具归属最小句。原「内置工具 headless 必被权限拒导致空回合」死文的
 * **无条件形态**与 read_file 示例点名（归属消歧）随机制移除（消歧对象由命名空间分派
 * 接管——CR-21 收口，不改名）。
 *
 * ⚠️ F16 补正（2026-09-19 真机实证）：路由最小句原带「面向用户的最终正文直接以纯文本
 * 写出」——与「写作域需求一律使用桥工具」互相拆台，模型把它读成「用户要第一章 → 就把
 * 第一章正文写在对话里」的授权（真机 `write_chapter` 零调用，dogfood-round4 F16）。
 * 该半句改为通道分工句（作品内容走桥工具写进作品 / 纯文本只管呈现性回复），与 agent
 * 正文**同句逐字**（CR-1 双写例外延续：桥车道无行为级降级带，此句是降级路径唯一防线，
 * 改字须两处同步）。
 *
 * CR-1（2026-09-19 用户拍板：最小兼容保留 + 条件式降级兜底句）：桥车道无行为级降级带
 * （prd R3 不设），此兜底句覆盖「模型可用工具里仍出现内置工具」的形态。⚠️ 归因纠正
 * （2026-09-19 F12 真机实证）：该形态在**正常加载态**（agent=true / system prompt 已整体
 * 替换）下同样会触发——零工具 agent 收窄但**未清零**内置工具面（实测可调用、可执行），
 * 不限于 agy 升级 fallback / name 竞速残留这类罕见态；故本句是**活防线**，不是必然失活
 * 的句子。措辞三段：①条件式框架（「若你的可用工具中出现……内置工具」）；②点破机制与
 * 后果（无头模式拿不到授权 → 权限系统自动拒绝 → 整轮空回合）；③指明正路（写作工具只有
 * 桥工具族，改道而非禁令）。禁「必须拒绝/绝不使用」类与 present_result 协议撞车的拒绝
 * 式措辞——兜底句只描述机制并改道，不下禁令。证据：task 09-19-agy-toolface-fix-batch
 * research/f8-builtin-tool-stream-signal.md §4/§5。
 */
export const BRIDGE_OUTPUT_DIRECTIVE =
  `请完成最后一条消息所述的任务。写作域需求（写作、改稿、读文件、查资料、检索等）一律使用 MCP 服务器 ${BRIDGE_MCP_SERVER_NAME} 提供的工具（按各工具说明调用）；章节正文、改稿结果这类作品内容一律由对应桥工具产出并写进作品；对话回复只用于讨论、说明、方案、评审意见、回答用户提问这类呈现性回复。若你的可用工具中出现命令执行、浏览器、网页搜索等内置工具：本会话以无头模式运行，内置工具无法获得权限授权，调用会被权限系统自动拒绝并导致整轮空回合；你的写作工具只有 MCP 服务器 ${BRIDGE_MCP_SERVER_NAME} 提供的工具族，请只用它们完成写作任务。`;

/**
 * present_result 打回提示（同会话 stdin 增量行）。与 agent loop.ts 的 runLoop 打回文案
 * 同义基线（两侧改文案须同步——模型在两条车道上应见到同一协议措辞）；W5 起协议常驻段
 * 上移 CLOSURE_BRIDGE_AGENT 正文（同义基线第三站点），协议措辞改动三处同步。
 */
export const BRIDGE_SENDBACK_MESSAGE =
  '你停下来向用户呈现结果前，必须先调用 present_result 工具声明这次停是否在等用户确认意图（awaiting_intent_confirmation 参数）。请重新呈现并用 present_result 收尾。';

/**
 * 内置工具步纠正行（R7：同会话 stdin 增量行——模型离开桥工具族时注入，**单 cycle 内**
 * 至多一次；打回二轮是新 cycle、独立配额——per-cycle 口径见 design §7 F-3）。
 *
 * 背景（实证）：内置工具步的判据行到空回合终态只隔 ≈1ms——**早停零收益**（turn 反正要
 * 空收尾）；但 agy 接受 turn 未结束时写入的新 stdin 行并当作**下一轮**处理，实测第二轮
 * 产出正常回答 ⇒ 「注入纠正而续跑」是唯一能在同一桥 turn 内把空回合救回实质产出的处置。
 * 证据：task 09-19-agy-toolface-fix-batch research/f8-builtin-tool-stream-signal.md §3
 *（逐行时间戳 / R6 注入实验）+ §6 处置 B。
 *
 * 措辞纪律：与既有族同风格（BRIDGE_OUTPUT_DIRECTIVE 兜底句 / BRIDGE_SENDBACK_MESSAGE），
 * 点名本会话工具族（server 名插值单源）+ 给出改道路径；**不下禁令式措辞**（「必须拒绝 /
 * 绝不使用」类会与 present_result 协议段撞车——CR-1 既有教训，见 BRIDGE_OUTPUT_DIRECTIVE 注）。
 */
export const BRIDGE_BUILTIN_TOOL_CORRECTION_MESSAGE =
  `你刚才调用的内置工具不属于本会话的工具族：本会话的工具只有 MCP 服务器 ${BRIDGE_MCP_SERVER_NAME} 提供的 novel-writing 桥工具族（读文件、检索、列目录等需求都在其中，请按各工具说明调用）。无头模式下内置工具无法获得权限授权，调用会被权限系统拒绝并导致本回合没有产出；请改走 novel-writing 工具族，或直接用纯文本作答。`;

// ── 权限软拒族 matcher（R6 单点收口：三信号各取**主体名**，按主体分派——F13 泛化 + F9 反向）──
//
// 主语判据单源在 permissionSoftDeny.ts（两车道共用，消费者侧零字面量）：'mcp' 主体 →
// 既有 MCP 软拒路径（soft-denied 相位 / D6 诊断，语义与行为不变）；其它主体 → 内置工具
// 权限软拒（builtin-tool-denied 相位——旧三针把 `mcp` 写死，内置工具软拒在其上恒打空，
// F8 §1.1）。

/** tool_info.error → error.message 文本提取（loose 形状防御——透传形态演进不炸流）。 */
function toolErrorMessage(info: CliToolStepInfo | undefined): string | undefined {
  const err = info?.error;
  if (err === null || typeof err !== 'object' || Array.isArray(err)) return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/** 主信号：流事件 tool_info.error.message 的软拒主体名（W0 §2 样本②；F13 泛化取名）。 */
export function parseSoftDenySubjectFromToolInfo(
  info: CliToolStepInfo | undefined,
): PermissionSoftDenySubject | undefined {
  return parsePermissionSoftDenyMessageSubject(toolErrorMessage(info));
}

/** 主信号之 MCP 支：既有导出面（语义 = 主体分派后的 'mcp' 侧）。 */
export function isMcpSoftDenyToolError(info: CliToolStepInfo | undefined): boolean {
  const subject = parseSoftDenySubjectFromToolInfo(info);
  return subject !== undefined && isMcpPermissionSubject(subject);
}

/** 兜底①之 MCP 支：stderr 通知（W0 §2 样本①）命中且主体为 'mcp'。 */
export function isMcpSoftDenyStderr(chunk: string): boolean {
  const subject = parsePermissionSoftDenyStderrSubject(chunk);
  return subject !== undefined && isMcpPermissionSubject(subject);
}

/** 兜底②：result.denied_actions 含 action === 'mcp'（W0 §2 样本③）。 */
export function hasMcpDeniedAction(actions: readonly string[] | undefined): boolean {
  return actions?.some((action) => isMcpPermissionSubject(action)) ?? false;
}

/** 兜底②之内置工具支：denied_actions 含非 mcp 主体（权限能力名，如 read_file——F13 泛化）。 */
function hasBuiltinDeniedAction(actions: readonly string[] | undefined): boolean {
  return actions?.some((action) => !isMcpPermissionSubject(action)) ?? false;
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

/** 假宿四件套 + 桥 agent 文件写入载荷（shell writeHomePayload 消费；含 marker 所需 sessionId）。 */
export interface BridgeHomePayload {
  homeDir: string;
  sessionId: string;
  serverName: string;
  pipeName: string;
  token: string;
  tools: BridgeToolFaceEntry[];
  /**
   * 桥声明式 agent.md 全文（09-19 白名单 W2：agent 文件不声明 `tools` + system prompt
   * 通道）。内容
   * 单源 = 协议层 agents.ts（shell 装配处经 renderAgentMarkdown(CLOSURE_BRIDGE_AGENT)
   * 填充内核 bridgeAgentMarkdown）——本模块只透传（协议层不管 fs，shell 不管内容）。
   */
  agentMarkdown: string;
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
  /**
   * 桥声明式 agent.md 内容（09-19 白名单 W2）。shell 装配处 =
   * renderAgentMarkdown(CLOSURE_BRIDGE_AGENT)——prepareHome 载荷 agentMarkdown 的透传源。
   */
  bridgeAgentMarkdown: string;
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
 *   - `tool-started`：桥面工具调用开始（仅 `novel-writing` 派发步——内置工具步不占此相位，
 *     其结果无 Closure 侧执行记录，进 UI 卡面会是无归依的孤儿相位）；
 *   - `builtin-tool-started`：agy 内置工具步（非 MCP 派发）——「模型离开了桥工具族」的
 *     协议退化相位（R5/F8 观测面）。与 `tool-started` **分开**是语义要求：内置工具不是桥件，
 *     若放宽后者过滤，UI 会把内置工具当桥工具显示「正在调用 X」，而该调用多半会被 headless
 *     权限软拒。证据：research/f8-builtin-tool-stream-signal.md §1（判据行形态）/§5.4（内置步
 *     可成功也可被拒——本相位只报告「离开了桥工具族」，不断言失败）；
 *   - `sendback` / `sendback-missed`：present_result 打回决策 / 二次未调接受（§5.3）；
 *   - `soft-denied`：**MCP 主体**软拒三形态任一信号首次命中（每 turn 至多一次——重复信号
 *     不重发）；
 *   - `builtin-tool-denied`：**内置工具主体**权限软拒（R6/F13）——模型离开桥工具族且该调用
 *     被 headless 权限系统拦下。与 `soft-denied` 分开是语义要求：后者是 MCP 预授权缺失
 *     （UI 指向设置页授权入口），本条是内置工具形态的协议退化。三信号首次命中即发（每 turn
 *     至多一次——stderr 通知常先于 ERROR 步到达，首个命中的信号胜出）。**信号形态决定相位
 *     载荷**：主信号（ERROR 步的 `tool_info.error`）携工具名 + 步号；stderr 通知无步上下文；
 *     `denied_actions` 是终态字段、与具体步无对应关系——后两条路都不带名/不带步号（字段
 *     缺席即键 ABSENT，见 noteBuiltinDenied 注）。`denied_actions` 单项还须**旁证**（本 turn
 *     已有内置工具步）才发——见 finishOutcome 注（CR-2 假归因门）。
 */
export type AgyBridgePhaseEvent =
  | { kind: 'tool-started'; toolName: string; stepIndex: number }
  | { kind: 'builtin-tool-started'; toolName: string; stepIndex: number }
  | { kind: 'builtin-tool-denied'; toolName?: string; stepIndex?: number }
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
  /** **MCP 主体**软拒三形态任一信号命中（W0 §2；内置工具主体走 builtin-tool-denied 相位）。 */
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

/**
 * 该工具步是否「模型离开了桥工具族」（R7/F8 判据单源）：agy 内置工具步 = 未解析出 MCP
 * 派发参数（Closure 工具恒经 novel-writing 派发器，其参数带 ServerName/ToolName 大写键）。
 * 其它 MCP 服务器的派发步**不算**内置工具（有派发器 = 仍是 MCP 形态，只是非本会话桥件）。
 *
 * CR-8 name 兜底：派发器的**退化形态**（`call_mcp_tool` 步缺 `parameters`——ERROR 步常见）
 * 解析不出派发参数，但那正是模型在使用桥派发通道，不是内置工具步。缺了这层兜底会把
 * 派发器退化步判成内置工具（错注入纠正文 + 丢弃当轮 result，整轮挂到外层 belt）。
 *
 * 判据两个触发点同源：ACTIVE 步（toolStepStarted）与 ERROR 步（toolStepError）——实测两形态
 * 都出现（R6 判据行 ACTIVE 恒有属 11/11 样本、历史样本面不足，故不得依赖 ACTIVE 先到）。
 */
function isBuiltinToolStep(toolName: string | undefined, info: CliToolStepInfo | undefined): boolean {
  if (toolName === AGY_MCP_DISPATCHER_TOOL_NAME || info?.name === AGY_MCP_DISPATCHER_TOOL_NAME) return false;
  return parseMcpDispatch(info) === undefined;
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
  /** builtin-tool-denied 相位事件已发（R6——三信号去重，同 soft-denied 纪律）。 */
  builtinDenyNoticed: boolean;
  /**
   * 本 turn 确见过内置工具步（判据与相位/纠正共用同一 isBuiltinToolStep 单源——ACTIVE /
   * ERROR / DONE 三个工具步相位任一命中即置位；DONE 帧靠名字兜底与 MCP 派发帧区分）。
   * 用途 = `denied_actions` 兜底信号的旁证门（CR-2：终态字段单项不构成归因，假归因会让
   * 正常出文的成功回合也弹「被拒」通知）。
   */
  builtinStepSeen: boolean;
}

interface BridgeCycleRun {
  text: string;
  usage: CliUsageCounters;
  sawUsage: boolean;
}

/**
 * 单 cycle 执行（骨架 mirror driver.runTurnOnSession，见文件头同步注记）。R7 增量：cycle
 * 内出现内置工具步时注入纠正行并**在本 cycle 内续跑**（单 cycle 内至多一次，settle 延后到
 * 纠正后那轮的 result）；纠正行与既有打回同构——同会话 stdin 增量行 + 镜像记账同批。
 */
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
    // R7 纠正续跑（单 cycle 内至多一次）：'idle' = 未注入；'injected' = 纠正行已写入、本
    // cycle 的终态改认纠正后那一轮的 result（前置那轮的 result 只用于复位聚合器——其正文与
    // step usage 属即将被作废的回合）；'returned' = 前置轮已收尾，后续 result 即终态（≤1
    // 封顶——纠正后仍走内置工具按既有收场路径走，不二次注入）。状态只在 lineTap 同步段内
    // 推进——不存在「注入在途时 settle」的判定窗口。
    let correctionState: 'idle' | 'injected' | 'returned' = 'idle';
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
    // builtin-tool-denied 相位去重通知（R6——同上，只发第一次）。工具名/步号**只在主信号
    // （ERROR 步）路径有值**：stderr 通知不带步上下文；denied_actions 是终态字段、与具体步
    // 无对应关系——两条兜底路的相位都不带名/不带步号（缺席即键 ABSENT，非 undefined 键）。
    const noteBuiltinDenied = (toolName: string | undefined, stepIndex: number | undefined): void => {
      if (state.builtinDenyNoticed) return;
      state.builtinDenyNoticed = true;
      opts.onPhase?.({
        kind: 'builtin-tool-denied',
        ...(toolName !== undefined ? { toolName } : {}),
        ...(stepIndex !== undefined ? { stepIndex } : {}),
      });
    };
    // ── R7 内置工具步纠正续跑（**单 cycle 内**至多一次——per-cycle 口径见 design §7 F-3）
    // ──注入行与既有打回（sendback）同构：同会话 stdin 增量行；镜像记账同批完成（否则
    // 下一 cycle 的「已发」比对错位）。
    const injectCorrection = (toolName: string | undefined): void => {
      if (correctionState !== 'idle') return;
      correctionState = 'injected';
      const segment = composeMessageSegment({ role: 'user', content: BRIDGE_BUILTIN_TOOL_CORRECTION_MESSAGE });
      const nextHashes = [...hashes, hashSegment(segment)];
      opts.info?.(
        `[agy-bridge] built-in tool step${toolName !== undefined ? ` (${toolName})` : ''} — injecting one corrective line and continuing this turn`,
      );
      void (async () => {
        try {
          await session.writeLine(buildStdinLine(segment));
          // 镜像记账（三处中的 commitSeenHashes）：以**本 cycle 全序列 + 纠正段**提交（非只提交
          // 纠正段）。基准序列无需在此显式补交——首行路径（本 cycle 开头 `session.writeLine(
          // stdinLine)` 成功后的 commitSeenHashes(hashes)）已经提交，且纠正注入恒由 stdout 流
          // 事件触发，该事件必然晚于那次提交：writeLine 在 `stdin.write` 返 true 时**同步
          // resolve**（仅背压才等 drain，drain 回调后的微任务即提交，先于任何 stdout 回调），
          // 而首个 stdout 事件还要整整一轮推理（秒级）才回流。
          //
          // ⚠️ 勿再补「显式基准提交」（历史上一度如此，理由是「commit 由写成功异步触发可能晚于
          // 回流」）：那个竞争在生产不成立（同上），且即便成立该写法也修不了它——commitSeenHashes
          // 是**绝对赋值**（sessions.ts：`entry.seenHashes = [...hashes]`），迟到的同值提交只会把
          // 已落账的纠正序列覆盖回半截，下一 cycle 比对反而错位。若未来真要时序硬化，正确方向是
          // 「注入等首行写完」或 commit 单调化，不是在这里重复提交。
          session.commitSeenHashes(nextHashes);
        } catch (err) {
          // 失败语义不吞（sessions.ts：writeLine 的镜像语义是「已发」——写失败即作废会话）：
          // 与首行写失败同路，settle + invalidate + 502。settle 幂等——若本 cycle 已因
          // abort/超时/结果先行收尾，此处退让（既有失败的语义优先）。
          //
          // CR-1：settle 短路时回调**不执行**——失败必须自己观察掉，否则 writeLine 的
          // rejection 无人观察、无任何日志（设计的「写失败不吞」在短路路径落空）。两种
          // 结局对齐：未 settle → 拒绝上抛（既有语义不变）；已 settle → 落 warn 记账
          //（turn 已由 abort/超时/退出/结果收场，不再有失败面可呈报，也不重写已定结局）。
          const detail = err instanceof Error ? err.message : String(err);
          let rejected = false;
          settle(() => {
            rejected = true;
            session.invalidate('correction-write-failed');
            reject(new ProtocolHttpError(
              `antigravity-cli bridge corrective stdin write failed: ${detail}`,
              502,
            ));
          });
          if (!rejected) {
            opts.warn(
              `[agy-bridge] corrective stdin write failed after this cycle had already settled (${detail}) — recorded, turn outcome unchanged`,
            );
          }
        }
      })();
    };
    const finishOutcome = (): void => {
      const outcome = finishCliTurn(acc);
      switch (outcome.kind) {
        case 'success': {
          // 兜底③：result.denied_actions（软拒后模型放弃作答的形态下仍携带）——按主体分派。
          if (hasMcpDeniedAction(acc.result?.deniedActions)) {
            state.mcpSoftDenied = true;
            noteSoftDenied();
          }
          // 兜底③之内置支须**旁证**（CR-2）：denied_actions 是终态字段，正常出文的成功回合
          // 同样可能携带非 mcp 项（早前轮次残留 / 与本次调用无关的权限条目）——单凭它发
          // 「被拒」通知正是本批要消灭的假归因类。旁证 = 本 turn 确有内置工具步（判据与
          // 相位/纠正共用 isBuiltinToolStep，两触发点任一命中即置位）。stderr 命中情形已
          // 在信号到达时直接发过相位（去重表兜住），不由本处补发。
          if (hasBuiltinDeniedAction(acc.result?.deniedActions) && state.builtinStepSeen) {
            noteBuiltinDenied(undefined, undefined);
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
        } else if (isBuiltinToolStep(started.toolName, started.toolInfo)) {
          // 内置工具步（非 MCP 派发）= 模型离开桥工具族的协议退化信号（R5/F8 观测面）。
          // ⚠️ 不得放宽上方 tool-started 过滤来承接它——内置工具不是桥件，混进桥相位会让 UI
          // 显示「正在调用 <内置工具名>」而该调用无 Closure 侧记录、且多半被 headless 权限软拒。
          // 工具名两跳（tool_name → tool_info.name）已由 events.readToolStepName 做过，此处只用
          // 结果；两跳俱缺的裸步不发（无名步无「可辨识」信息；实测 11/11 内置工具步恒有名，
          // research §5.3）。「其它 MCP 服务器」的派发步两相位皆不发（非桥件、也非内置工具）；
          // 派发器（call_mcp_tool）的退化步同理——判据见 isBuiltinToolStep（CR-8）。
          state.builtinStepSeen = true;
          if (started.toolName !== undefined) {
            opts.onPhase?.({ kind: 'builtin-tool-started', toolName: started.toolName, stepIndex: started.stepIndex });
          }
          // R7 纠正续跑：无名裸步照注入（相位面因无可辨识信息不发，但功能面判据是「非 MCP
          // 派发」——裸步同样是离开桥工具族的步）。
          injectCorrection(started.toolName);
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
        // DONE 步同计旁证（队长裁决 2026-09-19）：置位统一走 isBuiltinToolStep 单源，DONE
        // 路径不另写判据。名字兜底（CR-8）使它对 DONE 帧同样安全——MCP 的 DONE 帧名字是
        // 派发器（且 DONE 帧不携 parameters，纯参数判据会误中），不算内置；内置工具的
        // DONE 帧照算。R8 真机形态「同 turn 内既有成功的桥件调用又有成功的内置工具调用」
        // 缺此计入会漏发本该发的 deny 通知；计入也不放大误报——兜底门另要求 denied_actions
        // 确有非 mcp 项，DONE-only 且无 deny 项的回合依然静默。
        if (isBuiltinToolStep(effect.toolStepResult.toolName, effect.toolStepResult.toolInfo)) {
          state.builtinStepSeen = true;
        }
      }
      if (effect?.toolStepError !== undefined) {
        // 软拒主信号按**主体**分派（R6/F13 泛化）：'mcp' → MCP 预授权诊断；其它主体 →
        // 内置工具权限软拒（模型离开了桥工具族且该调用被拦下）。
        const denySubject = parseSoftDenySubjectFromToolInfo(effect.toolStepError.toolInfo);
        if (denySubject !== undefined) {
          if (isMcpPermissionSubject(denySubject)) {
            // 主信号：流事件 tool_info.error（W0 §2 matcher 定谳——结构化最稳）。
            state.mcpSoftDenied = true;
            noteSoftDenied();
          } else {
            noteBuiltinDenied(effect.toolStepError.toolName, effect.toolStepError.stepIndex);
          }
        }
        // R7 纠正续跑第二触发点：只到达 ERROR 步（无前置 ACTIVE）的内置工具步——判据
        // isBuiltinToolStep 与 ACTIVE 路径同源，不依赖 ACTIVE 行先到（实测 11/11 有 ACTIVE，
        // 但历史样本面不足，不得把「ACTIVE 恒在」写成前提）。注入口自身按 correctionState
        // 去重——封顶是 **per-cycle** 口径（design §7 F-3）：同 cycle 内两触发路径至多一次；
        // 打回二轮是新 cycle、独立配额，单 turn 上界 = 1 首行 + 2 纠正 + 1 打回。
        if (isBuiltinToolStep(effect.toolStepError.toolName, effect.toolStepError.toolInfo)) {
          state.builtinStepSeen = true;
          injectCorrection(effect.toolStepError.toolName);
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
        // R7：纠正行在途 → 本轮的 result 不作终态（延后 settle 只认纠正后那一轮的 result）。
        // ⚠️ 延后必须发生在 `settle` **之前**——settle 的 cleanup 会卸下 line tap，纠正轮的
        // 事件就再也读不到了（延后本身不是「保留 tap」而是「本轮的 result 不做终态」）。
        // 前置那轮聚合器复位：其正文与 step usage 属即将作废的回合，不混进续跑轮产出（语义
        // 对齐打回二轮各 cycle 独立聚合，见 BRIDGE_SENDBACK_MESSAGE 注）。
        if (correctionState === 'injected') {
          correctionState = 'returned';
          acc = createCliTurnAccumulator();
          return;
        }
        settle(finishOutcome);
      }
    });
    session.setStderrTap((chunk) => {
      stderrBuf += chunk;
      if (stderrBuf.length > STDERR_RING_LIMIT) {
        stderrBuf = stderrBuf.slice(-STDERR_RING_LIMIT);
      }
      // 兜底①：stderr 软拒通知（jetski: 前缀通知——W0 §2 样本①）——按主体分派（本信号
      // 不带步上下文：相位无工具名/步号，是合法形态）。
      const stderrSubject = parsePermissionSoftDenyStderrSubject(chunk);
      if (stderrSubject !== undefined) {
        if (isMcpPermissionSubject(stderrSubject)) {
          state.mcpSoftDenied = true;
          noteSoftDenied();
        } else {
          noteBuiltinDenied(undefined, undefined);
        }
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
      // 09-19 白名单 W2：桥车道恒挂声明式 agent（agent 文件不声明 `tools` + system
      // prompt 通道）。
      // 恒挂无「未启用」态——假宿 agent 文件系本方每会话必写（prepareBridgeHome 落盘）；
      // MCP 继承与 --agent 正交（研究报告 §5 P5/P6 实证），桥预授权机制不变。
      agentName: CLOSURE_BRIDGE_AGENT_LAYOUT.agentName,
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
        agentMarkdown: c.bridgeAgentMarkdown,
      }),
  };

  const runCycles = async (session: AgyTurnSession): Promise<BridgeTurnResult> => {
    const state: BridgeCycleState = { toolSteps: [], mcpSoftDenied: false, softDenyNoticed: false, builtinDenyNoticed: false, builtinStepSeen: false };
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
