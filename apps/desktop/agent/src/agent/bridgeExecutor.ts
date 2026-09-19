import { randomUUID } from 'node:crypto';
import type {
  AgentBehaviorMode,
  GenerationLane,
  GenerationMessage,
  ThinkingControl,
} from '@orison/shared-contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgyBridgeNoticeData,
  SessionMessage,
  StreamDeltaData,
  ToolDefinition,
} from '../types';
import type { GenerationDelta, GenerateTextUsage } from '../provider/ipc-provider';
import {
  filterToolsForPolicy,
  type SessionPermissionMode,
} from '../runtime/toolPolicy';
import { logger } from '../logger';

// ── agy MCP 工具桥 dialogue 车道 executor（子4 W4，design §0/§5/§7/§8）──
//
// 循环控制权反转面：一个「桥 turn」内 agy 自主多步循环（工具经 MCP server novel-writing
// 在 agy 侧闭环），Closure 只见 turn 边界。本模块 owns：
//   - 桥工具面策展（design §7 分层表：Tier 1 MVP + Tier 2 diff 家族——W5 入面）；
//   - 面装配 = 策展 ∩ 当轮 filterToolsForPolicy 结果（同 toolPolicy 模块——第一层门；
//     agy 侧预授权是第二层，方向不可写反）∩ 注册面（策展表本身只收 shell 可执行 id，
//     结构性排除 spawn_agent/skill 等进程内 ctx 本地工具——非黑名单枚举）；
//   - 持久化同构映射（design §5.6）：管道调用记录（live，result 回来即落）→ 标准
//     SessionMessage 对（assistant.toolCalls + tool.toolResults）+ 终文 assistant 消息
//     ——与 runLoop 产物同构，后续轮次（切回 HTTP 模型/压缩/summarizer）零特殊处理；
//   - 事件发射（既有 RuntimeEventPayload 契约）：delta 文本流（messageId = 预分配
//     assistantId，终帧同 id）+ tool 通道相位（「正在调用 X」，仅桥工具步）+ bridge-notice
//     运行期通知（打回/二次未调/软拒——UI 消费面归 W6；R5 起含内置工具步「模型离开了桥
//     工具族」呈报、R6 起含内置工具被权限拦下，两信号走通知面而非 tool 通道，防与桥工具
//     相位混淆）；
//   - abort 贯通 + 中断落盘门（mirror runLoop §3.3：!text && !reasoning 丢弃，text 已流
//     → aborted_partial）。
//
// 桥 turn 经注入 seam（setBridgeTurnFn）直达 shell 桥基座——不经 generateText 分派点
// （design §6 边界：generate.ts 两分派点零改动）。本包零 model-protocols 依赖（seam 类型
// 本地声明，mirror GenerationDelta 先例；shell 侧实现按本包导出类型编译钉死 seam 不漂移）。

// ── 工具面策展（design §7）──

/** Tier 1（MVP）：桥原生收尾 + 写章派发 + 只读十件主体 + 通用只读件 + 研究两件。 */
export const BRIDGE_TOOL_FACE_TIER1: readonly string[] = [
  'present_result',
  'write_chapter',
  // 只读十件主体（writer/资料员同款只读面的主体子集）。
  'chapter_list',
  'chapter_read',
  'outline_read',
  'query_story',
  'query_relations',
  'query_chapter_summary',
  'query_arc_summary',
  'scene_graph_read',
  'query_promise',
  'query_cognition_graph',
  // 通用只读件（F4b）：对话附件/引用文件场景的唯一读路——没有它，模型面对文件路径在
  // 桥工具面内无路可读（白名单 agent **收窄但未清零**内置工具面——F4b 时代「改用内置」
  // 的岔路仍可能出现，见 BRIDGE_TOOL_FACE 注；本件在场正是让模型有正路可走）。
  'read_file',
  // 通用只读件补件（F8 同型复发——与 F4b 缺 read_file 同一类事故）：模型想「项目里哪里有
  // X」「某个目录下有什么」时桥面内无件可答，于是伸手够 agy 内置检索/列目录件，被 headless
  // 软拒 ⇒ 整轮空输出。两件与 read_file 同簇；classifyTool 对二者缺省归 read，readonly /
  // suggest / auto 三档全可见（零 toolPolicy 登记）。
  'search',
  'list_files',
  // 研究两件（近邻撞名注意：agy 内置是 search_web，词序互反——描述已写清归属）。
  'web_search',
  'wiki_search',
];

/** Tier 2（W5 入面）：diff 家族（产人审 envelope——三道闸重建 + envelope 经桥消息流路由）。 */
export const BRIDGE_TOOL_FACE_TIER2: readonly string[] = [
  'outline_update',
  'overview_update',
  'memory_update',
  'scene_graph_update',
  'info_release_map_update',
  'promise_ledger_update',
  'genre_contract_update',
  'rewrite_passage',
  'setting_md_update',
  'asset_cards_update',
];

/**
 * 全量桥面（Tier 1 + Tier 2）。read_file 入面（F4b）时与 agy 内置同名读文件工具并存，
 * 曾靠描述归属句 + 桥指令硬禁令双面消歧（MCP 派发器 ServerName+ToolName 本就分命名
 * 空间，技术上无冲突）。09-19 白名单落地后桥 spawn 恒挂声明式 agent，消歧文案随 W5
 * 瘦身移除（CR-21 收口：不改名）。
 *
 * ⚠️ 归因纠正（2026-09-19 F8 真机实证）：零工具 agent **没有**把内置工具面从桥会话
 * 模型侧清零——agy 1.2.2 实测挂 agent（日志 agent=true、system prompt 被整体替换、
 * input tokens 腰斩）时内置工具仍可调用、可执行（`find_by_name` 在默认无头权限下执行
 * 成功并逐字回读随机标记文件名）。`--agent` 的真实效果 = 替换 system prompt + **收窄**
 * 内置工具面（收窄但未清零）；「出现内置工具步 ⇒ agent 未加载」不成立，工具步与加载
 * 状态**无因果关系**。故本面策展是给模型铺正路，不是「同名词机制性不存在」的兜底。
 * 证据：task 09-19-agy-toolface-fix-batch research/f8-builtin-tool-stream-signal.md §4/§5。
 */
export const BRIDGE_TOOL_FACE: readonly string[] = [...BRIDGE_TOOL_FACE_TIER1, ...BRIDGE_TOOL_FACE_TIER2];

/**
 * 工具描述写作域措辞改写（w0-findings §8 基线——剥离工作台/产品名/实现词，保持真实
 * 用途；MCP 描述逐字进模型上下文与 agy 侧缓存 json）。未列出的工具沿用 registry 描述
 * （既有描述已按「作用视角说人话」纪律书写——agent-tools spec）。
 */
export const BRIDGE_TOOL_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  present_result:
    '呈现结果并声明本轮结束。每次你向用户呈现结果、停下来等回应前，必须调用此工具声明这次停下的性质：' +
    '等待用户确认（awaiting_intent_confirmation=true）或本轮已完成（false）。' +
    '呈现给用户看的正文必须写在调用本工具的同一条消息里。',
  write_chapter:
    '为指定章节触发完整写作流程：编译写作简报 → 生成初稿 → 同步故事档案 → 五维审核 → 定稿路线判定与修订闭环。' +
    '只回摘要（标题/字数/判定结论）。写作简报传本章目标/参数/信息控制/节奏/禁写/情绪目标。',
  // read_file（F4b 入面 / W5 简化）：归属消歧句删除（命名空间分派本无硬冲突 + CR-21 不改
  // 名）——描述回归工具本义（路径契约、场景与章节正文指引保留）。
  read_file:
    '读取项目内的文件内容（对话附件、引用文件、设定/资料文档等场景），filePath 传相对项目根的相对路径' +
    '（如 inbox/简介.txt、research/设定集.md）。章节正文优先用 chapter_read。',
  // search / list_files（F8 同型补件）：builtin.ts 原描述是英文且只写「能做什么」的泛话——
  // 桥面用中文写作域措辞写清「能回答什么问题」与路径/参数契约（agent-tools spec 说人话双规则）。
  search:
    '在项目内的文件里按文本检索，回答「某句话出现在哪里」——命中给出所在文件、第几行与该行内容。' +
    'query 支持正则；glob 按文件名后缀过滤（如 *.md；**/*.md 这类路径式通配无效）；maxResults 限制命中条数。' +
    '查故事设定与档案（人物、伏笔、章摘要等）用 query_story 等专项查询；读整份文件用 read_file。',
  list_files:
    '列出项目内某个目录下的文件与子目录，回答「这个目录里有什么」——dirPath 传相对项目根的相对路径' +
    '（缺省即项目根），recursive 传 true 递归列出全部层级（条目多时先列浅层、再按需下钻）；' +
    '点开头的条目（如 .orison、.git）不会列出，属正常现象。',
};

// ── seam 类型（本地声明——mirror GenerationDelta 先例；shell 实现按导出类型编译）──

/** 桥面工具条目（tools.json 内容原形；inputSchema = zodToJsonSchema 的 JSON Schema 1:1）。 */
export interface BridgeFaceEntry {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * 桥 turn 内一次工具调用的执行记录（管道 result 回来即达——live 持久化素材）。
 * 生产侧填充缝（CR-17 核实结论：非死字段）：shell `agyBridge.executeBridgeToolCall`
 * 的三道闸结果经 registry `callListener`（BridgeCallRecord——结构兼容本型，含 gate）
 * 直达 executor 的 onToolCall；gate 标记闸门拦截（面外 'face' / 档位 'policy' /
 * 自审 'self-review'），未被拦截的执行无此键。
 */
export interface BridgeToolCallRecord {
  toolId: string;
  arguments?: unknown;
  ok: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  /** 三道闸拦截标记（生产侧 = shell executeBridgeToolCall 经管道调用记录透传）。 */
  gate?: 'face' | 'policy' | 'self-review';
}

/** 桥 turn 运行期相位事件（protocol 层 AgyBridgePhaseEvent 的 seam 同构声明）。 */
export type BridgeTurnPhaseEvent =
  | { kind: 'tool-started'; toolName: string; stepIndex: number }
  // 09-19 工具面修复批 R5：agy 内置工具步（非桥工具族）——「模型离开了桥工具族」的可观测
  // 相位；与 tool-started 分开发（内置工具不是桥件，混进桥相位 = UI 语义错误）。
  | { kind: 'builtin-tool-started'; toolName: string; stepIndex: number }
  // 09-19 工具面修复批 R6（F13）：内置工具**权限软拒**——模型离开桥工具族且该调用被
  // headless 权限系统拦下（与 soft-denied 分开：后者是 MCP 预授权缺失，指向设置页授权）。
  // 工具名/步号可缺席（stderr 兜底信号无步上下文——见 protocol 层相位注）。
  | { kind: 'builtin-tool-denied'; toolName?: string; stepIndex?: number }
  | { kind: 'sendback' }
  | { kind: 'sendback-missed' }
  | { kind: 'soft-denied' };

export interface BridgeTurnRequest {
  modelRef: { keyId: string; modelId: string };
  thinking?: ThinkingControl;
  /** 桥 turn 前置 system（不含 appendToolDescriptions——工具描述由 agy 经 MCP 注入）。 */
  system: string;
  messages: GenerationMessage[];
  /** 逻辑会话键（池键派生 `<sessionKey>｜bridge｜face:<hash>`——D9）。 */
  sessionKey: string;
  /** 桥会话身份（假宿归属 + 注册表键）。 */
  sessionId: string;
  projectDir: string;
  permissionMode: SessionPermissionMode;
  /** 本桥会话工具面（face hash 池键派生 + tools.json 内容）。 */
  face: BridgeFaceEntry[];
  /** plan/discuss 档传 true（present_result 收尾强制）；normal/auto 传 false。 */
  requirePresentResult: boolean;
  lane?: GenerationLane;
  onDelta?: (d: GenerationDelta) => void;
  onPhase?: (event: BridgeTurnPhaseEvent) => void;
  /** 工具调用执行记录 live 回调（管道 result 回来即达——executor 即刻持久化消息对）。 */
  onToolCall?: (call: BridgeToolCallRecord) => void;
  signal?: AbortSignal;
}

export interface BridgeTurnOutcome {
  text: string;
  usage?: GenerateTextUsage;
  presentResultCalled: boolean;
  presentResultAwaiting: boolean | undefined;
  sentBack: boolean;
  secondPassMissedPresentResult: boolean;
  mcpSoftDenied: boolean;
  bridgeToolCalls: number;
}

export type AgyBridgeTurnFn = (request: BridgeTurnRequest) => Promise<BridgeTurnOutcome>;

/** 同意征询态（missing-consent = 未同意；conflict = 用户 deny/ask 压制）。 */
export type AgyBridgeConsentAskState = 'missing-consent' | 'conflict';

/** 类型化拒绝可承载的全部同意态（turn 生产入口硬门含 declined——CR-27）。 */
export type AgyBridgeConsentErrorState = AgyBridgeConsentAskState | 'declined';

/** shell 注入的模式判定（design §5.1：protocol/同意态/桥面——agent 侧零盘读）。 */
export type AgyBridgeModeDecision =
  | { mode: 'off'; reason?: string }
  | { mode: 'bridge' }
  | { mode: 'rejected'; state: AgyBridgeConsentAskState; conflicts: string[] };

export type AgyBridgeModeResolver = (input: { modelRef: { keyId: string; modelId: string } }) => AgyBridgeModeDecision;

/**
 * 同意类型化拒绝（车道上抛 → 既有 error 事件面；机器可读前缀 mirror
 * project_run_active|heldBy= 结构化拒绝族——W6 UI 波次按前缀消费转同意对话框）。
 * lane 车道只发 missing-consent / conflict（declined 在 shell resolver 即降级 off——
 * AC6 纯文本路径，会话不中断）；**turn 生产入口硬门（CR-27）三态全发**——declined 的
 * 用户选择不得被任何入口绕过（直接调 seam 也拦）。
 * rules 串接：逐条 encodeURIComponent 后 join(';')（CR-7——用户规则原文可含 '|' / ';'
 * 分隔符，未编码则 UI 侧 parse 按分隔符切开 = round-trip 损坏）；消费侧
 * agyBridgeStore.parseAgyBridgeConsentError 对应解码。
 */
export class AgyBridgeConsentRequiredError extends Error {
  readonly bridgeState: AgyBridgeConsentErrorState;
  readonly conflicts: string[];
  constructor(state: AgyBridgeConsentErrorState, conflicts: string[] = []) {
    super(
      state === 'conflict'
        ? `agy_bridge_consent|state=conflict|rules=${conflicts.map((r) => encodeURIComponent(r)).join(';')}`
        : `agy_bridge_consent|state=${state}`,
    );
    this.name = 'AgyBridgeConsentRequiredError';
    this.bridgeState = state;
    this.conflicts = conflicts;
  }
}

// ── 注入 seam（mirror setGenerateTextFn；agentIpc 装配，wiring 测试钉死漏装配）──

let _bridgeTurn: AgyBridgeTurnFn | undefined;
let _modeResolver: AgyBridgeModeResolver | undefined;

export function setBridgeTurnFn(fn: AgyBridgeTurnFn): void {
  _bridgeTurn = fn;
}

export function setAgyBridgeModeResolver(fn: AgyBridgeModeResolver): void {
  _modeResolver = fn;
}

/** 测试缝：清空注入（用例间隔离）。 */
export function __clearBridgeSeamsForTest(): void {
  _bridgeTurn = undefined;
  _modeResolver = undefined;
}

/** 测试缝：探针已注入的 turn fn（shell wiring 测试钉死 agentIpc 装配行——删除接线即红）。 */
export function __getAgyBridgeTurnFnForTest(): AgyBridgeTurnFn | undefined {
  return _bridgeTurn;
}

/** 测试缝：探针已注入的模式判定 resolver（同上）。 */
export function __getAgyBridgeModeResolverForTest(): AgyBridgeModeResolver | undefined {
  return _modeResolver;
}

// ── 工具面装配（纯函数）──

/** 策展面 ∩ 当轮 policy 面（同 toolPolicy 模块调用——第一层门；便宜序：零 schema 编译）。 */
export function bridgeFaceToolIds(tools: ToolDefinition[], sessionMode?: SessionPermissionMode): string[] {
  const visible = new Set(filterToolsForPolicy({ tools, sessionMode }).map((t) => t.id));
  return BRIDGE_TOOL_FACE.filter((id) => visible.has(id));
}

/** 完整面条目（含 JSON Schema——resolver 判 bridge 后才调，省 HTTP 车道每 turn 编译）。 */
export function buildBridgeFaceEntries(tools: ToolDefinition[], sessionMode?: SessionPermissionMode): BridgeFaceEntry[] {
  const wanted = new Set(bridgeFaceToolIds(tools, sessionMode));
  const entries: BridgeFaceEntry[] = [];
  for (const tool of tools) {
    if (!wanted.has(tool.id)) continue;
    // mirror messagesToPayload 的 toolDefs 映射（$schema 剥除——tools.json 消费方不需要）。
    const { $schema: _$schema, ...schema } = zodToJsonSchema(tool.parameters, { target: 'jsonSchema7' }) as Record<string, unknown>;
    entries.push({
      name: tool.id,
      description: BRIDGE_TOOL_DESCRIPTION_OVERRIDES[tool.id] ?? tool.description,
      inputSchema: schema,
    });
  }
  return entries;
}

// ── 车道判定（design §5.1 序：面空 → off；protocol/同意态 → shell resolver）──

export type AgyBridgeLaneDecision =
  | { kind: 'off'; reason?: string }
  | { kind: 'bridge' }
  | { kind: 'rejected'; error: AgyBridgeConsentRequiredError };

/**
 * dialogue 车道桥判定：面 id 交集（纯集合运算）为空 → off（HTTP 模型零 resolver 调用）；
 * 非空 → 注入 resolver（shell 判 protocol + 同意态 + declined 降级）。resolver 未装配 →
 * off（缺 wiring 时回 runLoop 纯文本路径——fail-safe 方向：不误入桥车道）。
 *
 * CR-12（子4 CR 批）：判定/构造分家——**判定路径零 schema 编译**（只走
 * bridgeFaceToolIds 集合交集）；完整面（含 zodToJsonSchema 编译）由车道分支点
 * （workflow streamMessage）单次构造经 `BridgeExecutorOptions.face` 注入 executor，
 * 消除「判定编译 → 丢弃 → executor 重编译」的三重计算。
 */
export function resolveAgyBridgeDialogueLane(input: {
  tools: ToolDefinition[];
  permissionMode: SessionPermissionMode | undefined;
  modelRef: { keyId: string; modelId: string } | undefined;
}): AgyBridgeLaneDecision {
  if (bridgeFaceToolIds(input.tools, input.permissionMode).length === 0) {
    return { kind: 'off', reason: 'empty-face' };
  }
  const resolver = _modeResolver;
  if (resolver === undefined) {
    return { kind: 'off', reason: 'resolver-not-installed' };
  }
  // 未指派档（undefined）用 default 哨兵——shell resolveModel 对哨兵 auto-pick 默认 key，
  // 协议判定与生成车道同源。
  const modelRef = input.modelRef ?? { keyId: 'default', modelId: 'default' };
  const decision = resolver({ modelRef });
  if (decision.mode === 'off') {
    return { kind: 'off', reason: decision.reason };
  }
  if (decision.mode === 'rejected') {
    return { kind: 'rejected', error: new AgyBridgeConsentRequiredError(decision.state, decision.conflicts) };
  }
  return { kind: 'bridge' };
}

// ── SessionMessage → GenerationMessage wire 映射（mirror ipc-provider messagesToPayload 核心）──

/**
 * 会话历史 → 桥 turn 线格式。pinned context / 压缩摘要**不注入**（design §6：agy 自管
 * 上下文——Closure pinned context 不适用桥车道）；带图 user 消息以 parts 形态透传
 * （compose 侧渲染「本通道不支持图片输入」占位——不丢消息形状，mirror 纯文本 CLI 车道）。
 *
 * CR-6（子4 CR 批）：assistant.toolCalls **按已有 resultIds 过滤**——截断/崩溃落在
 * 工具对持久化之间时，历史会留下无对应 toolResults 的悬空 toolCall；wire 契约要求
 * toolCalls 与 tool 消息成对，悬空 call 上线 = CLI/协议拒收**整 turn**（一处历史损缺
 * 炸掉后续所有轮次）。过滤只影响上行 wire，不改动会话历史本身。
 */
export function sessionMessagesToWire(messages: SessionMessage[]): GenerationMessage[] {
  // 先收集全部已有 toolResult 的 callId（tool 消息在 assistant 之后——须两遍扫描）。
  const answeredCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const tr of m.toolResults ?? []) answeredCallIds.add(tr.toolCallId);
  }
  const wire: GenerationMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls ?? []).filter((tc) => answeredCallIds.has(tc.id));
      wire.push({
        role: 'assistant',
        content: m.content,
        ...(toolCalls.length
          ? { toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) }
          : {}),
      });
    } else if (m.role === 'tool') {
      for (const tr of m.toolResults ?? []) {
        wire.push({ role: 'tool', toolCallId: tr.toolCallId, content: tr.output });
      }
    } else if (m.role === 'user') {
      if (m.images?.length) {
        // 带图 user 消息：桥车道不经 generate 缝（resolveImageParts 的指针归一/转述面不在
        // 路径上——wire 契约只认归一后 b64 part），图片以占位注记呈现（不丢消息形状，
        // mirror compose 的 parts 占位措辞）。图片输入的桥面支持 = 模态后置项。
        const notes = m.images.map(() => '[图片附件：本通道暂不支持图片输入，已省略]');
        wire.push({ role: 'user', content: [m.content, ...notes].join('\n') });
      } else {
        wire.push({ role: 'user', content: m.content });
      }
    }
    // 'system' SessionMessage：system 经独立参数传递（composeInstructionBlock 承载），跳过。
  }
  return wire;
}

// ── executor ──

export interface BridgeExecutorOptions {
  sessionId: string;
  projectPath: string;
  /** 入口快照纪律（mirror runLoop baseMessages）：live 引用由调用方传入，本模块不重读。 */
  messages: SessionMessage[];
  /** 基础 system（不含工具描述——工具面由 agy 经 MCP tools/list 注入，重复即双份噪音）。 */
  systemPrompt: string;
  tools: ToolDefinition[];
  modelRef: { keyId: string; modelId: string } | undefined;
  thinking?: ThinkingControl;
  sessionKey: string;
  permissionMode: SessionPermissionMode | undefined;
  behaviorMode: AgentBehaviorMode | undefined;
  abort: AbortSignal;
  onMessage: (msg: SessionMessage) => void;
  /**
   * 本桥会话工具面（CR-12——车道判定处单次构造注入，消除 executor 重编译 schema）；
   * 缺省由本模块按 tools+permissionMode 现算（测试直调/独立消费面形态）。
   */
  face?: BridgeFaceEntry[];
  /** delta 事件发射钩子（messageId = 预分配 assistantId，终帧 assistant 同 id）。 */
  emitDelta?: (event: StreamDeltaData) => void;
  /** 运行期通知（打回/二次未调/软拒/内置工具步/内置工具被拒——bridge-notice 事件面，UI 消费归 W6/R5/R6）。 */
  onNotice?: (notice: AgyBridgeNoticeData) => void;
}

function isAbortLike(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError';
}

/**
 * 桥 turn 驱动 + 持久化同构映射。产出（与 runLoop 产物同构——shape 对拍测试钉死）：
 *   - 每次工具执行记录 → assistant(toolCalls) + tool(toolResults) 对（live 落盘——管道
 *     result 回来即 onMessage，长链工具中途 UI 可见结果卡）；
 *   - turn 终文 → assistant 消息（id = 预分配 assistantId，与 delta 流同锚）；
 *   - abort 中断 → delta 已流文本落 aborted_partial（!text && !reasoning 丢弃——桥车道
 *     无 reasoning 流，门退化为 !text）。
 * kind 盖章语义与 runLoop 既有口径一致（R2 #16 起 present_result 不盖 kind——仅
 * aborted_partial 中断落盘盖章）。
 */
export async function runBridgeExecutor(opts: BridgeExecutorOptions): Promise<SessionMessage[]> {
  if (_bridgeTurn === undefined) {
    throw new Error('agy bridge turn fn not initialized — call setBridgeTurnFn first');
  }
  const result: SessionMessage[] = [];
  const assistantId = randomUUID();
  let streamedText = '';
  const emitDelta = opts.emitDelta;
  const onDelta = emitDelta
    ? (d: GenerationDelta): void => {
      if (d.type === 'text') streamedText += d.delta;
      try {
        emitDelta({
          messageId: assistantId,
          channel: d.type,
          delta: d.delta,
          ...(d.toolName !== undefined ? { toolName: d.toolName } : {}),
        });
      } catch (err) {
        // mirror CR-8：消费者 throw 不逃逸成桥内未捕获异常；终文以 result 为权威。
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'bridgeExecutor: emitDelta consumer threw (ignored)',
        );
      }
    }
    : undefined;

  const onPhase = (event: BridgeTurnPhaseEvent): void => {
    if (event.kind === 'tool-started') {
      // R2 #30 tool 通道：UI「正在调用 X」指示（占位流式消息上标记，终帧替换后消失）。
      if (emitDelta !== undefined) {
        try {
          emitDelta({ messageId: assistantId, channel: 'tool', delta: '', toolName: event.toolName });
        } catch {
          /* 同上：相位事件发射失败不阻桥 turn */
        }
      }
      return;
    }
    // 其余相位 → bridge-notice 通知面（打回/二次未调/软拒，以及 R5/R6 的内置工具步与
    // 内置工具被拒呈报）。
    // R5（09-19 工具面修复批）：内置工具步与桥工具相位**分开**呈报——走通知条而非 tool
    // 通道的「正在调用 X」占位 chip（内置工具不是桥件，混用会给出错误的桥工具语义）。
    // R6：内置工具权限软拒（F13）同走通知面；工具名缺席时条件展开（stderr 兜底信号无
    // 步上下文——缺席即不带键，防 undefined 混进渲染面）。
    const notice: AgyBridgeNoticeData =
      event.kind === 'builtin-tool-started'
        ? { notice: 'builtin-tool-started', toolName: event.toolName }
        : event.kind === 'builtin-tool-denied'
          ? { notice: 'builtin-tool-denied', ...(event.toolName !== undefined ? { toolName: event.toolName } : {}) }
          : { notice: event.kind };
    // CR-5（子4 CR 批）：onNotice 消费者 throw 不冒泡穿协议层中断整桥 turn（mirror
    // driver onDelta catch 先例）——记 warn 后继续；异常处文本以 result 为权威。
    try {
      opts.onNotice?.(notice);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), notice: notice.notice },
        'bridgeExecutor: onNotice consumer threw (ignored; turn continues)',
      );
    }
  };

  // live 持久化：管道执行记录 → SessionMessage 对（成对落盘——无悬空 toolCall 风险）。
  const persistToolCallPair = (call: BridgeToolCallRecord): void => {
    try {
      const toolCallId = randomUUID();
      const assistantMsg: SessionMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: toolCallId,
            name: call.toolId,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        ],
        createdAt: Date.now(),
      };
      result.push(assistantMsg);
      opts.onMessage(assistantMsg);
      // 失败输出对齐 runLoop 的 "Error: " 前缀惯例（gate 拒绝/执行异常同形）。
      const output = call.ok ? (call.output ?? '') : `Error: ${call.error ?? '工具调用失败'}`;
      const toolMsg: SessionMessage = {
        id: randomUUID(),
        role: 'tool',
        content: output,
        toolResults: [
          {
            toolCallId,
            toolName: call.toolId,
            output,
            // metadata（含 Tier 2 envelope field_patch）随 tool result 透传——UI 捕获层
            // （agentDiffSlice WRITE_TOOLS 门）消费面归 W6。
            ...(call.ok && call.metadata !== undefined ? { metadata: call.metadata } : {}),
          },
        ],
        createdAt: Date.now(),
      };
      result.push(toolMsg);
      opts.onMessage(toolMsg);
    } catch (err) {
      // 落盘管线抛错只记日志，不顶替 turn 主流程（mirror persistAbortedPartial 纪律）。
      logger.error(
        { err: err instanceof Error ? err.message : String(err), toolId: call.toolId },
        'bridgeExecutor: persistToolCallPair failed (tool pair not persisted; turn continues)',
      );
    }
  };

  const baseMessages = [...opts.messages];
  // CR-12：face 单次构造——车道判定处（workflow）注入优先；缺省现算（测试直调形态）。
  const face = opts.face ?? buildBridgeFaceEntries(opts.tools, opts.permissionMode);
  let outcome: BridgeTurnOutcome;
  try {
    outcome = await _bridgeTurn({
      modelRef: opts.modelRef ?? { keyId: 'default', modelId: 'default' },
      thinking: opts.thinking,
      system: opts.systemPrompt,
      messages: sessionMessagesToWire(baseMessages),
      sessionKey: opts.sessionKey,
      sessionId: opts.sessionId,
      projectDir: opts.projectPath,
      permissionMode: opts.permissionMode ?? 'suggest',
      face,
      // §5.3：plan/discuss 档强制 present_result 收尾（mirror runLoop behaviorMode 口径）。
      requirePresentResult: opts.behaviorMode === 'plan' || opts.behaviorMode === 'discuss',
      onDelta,
      onPhase,
      onToolCall: persistToolCallPair,
      signal: opts.abort,
    });
  } catch (err) {
    // CR-3（子4 CR 批）：abort 竞态按**信号状态**归类而非仅错误形态——kill 级联下
    // exit-observer 的 502 可能先于 abort listener settle（非 AbortError 形态 + signal
    // 已断 = 用户中断），按 abort 语义落 aborted_partial，不得当 infra 错误丢已流文本。
    if (isAbortLike(err) || opts.abort.aborted) {
      // 中断落盘门：已流文本 → aborted_partial（预分配 assistantId——UI 占位同锚替换）；
      // 全空丢弃。工具对已 live 落盘的不动（成对完整）。
      if (streamedText) {
        try {
          const partialMsg: SessionMessage = {
            id: assistantId,
            role: 'assistant',
            content: streamedText,
            createdAt: Date.now(),
            kind: 'aborted_partial',
          };
          result.push(partialMsg);
          opts.onMessage(partialMsg);
        } catch (persistErr) {
          logger.error(
            { err: persistErr instanceof Error ? persistErr.message : String(persistErr) },
            'bridgeExecutor: aborted partial persist failed (original error preserved)',
          );
        }
      }
    }
    throw err;
  }

  // CR-15（子4 CR 批）：空终文且有工具对 → 跳过终文 assistant broadcast——agy 侧模型
  // 只产工具调用不落正文时不再广播空气泡（工具对消息已是本 turn 的完整答案面）；
  // delta 已流文本时仍 broadcast（空终帧落盘 settle UI 占位——与 delta 流同 messageId 锚，
  // 跳过会让占位悬挂）。abort partial 路径在上方 catch 内，不受影响。
  const hasToolPair = result.some((m) => m.role === 'tool');
  if (outcome.text.length === 0 && hasToolPair && streamedText.length === 0) {
    return result;
  }
  const finalMsg: SessionMessage = {
    id: assistantId,
    role: 'assistant',
    content: outcome.text,
    createdAt: Date.now(),
  };
  result.push(finalMsg);
  // CR-4（子4 CR 批）：终文持久化 throw 不翻 error 态——turn 本身已成功，落盘管线
  // 失败记日志后照常返回（mirror persistToolCallPair / aborted partial 纪律）。
  try {
    opts.onMessage(finalMsg);
  } catch (persistErr) {
    logger.error(
      { err: persistErr instanceof Error ? persistErr.message : String(persistErr) },
      'bridgeExecutor: final assistant persist failed (turn result preserved)',
    );
  }
  return result;
}
