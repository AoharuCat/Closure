import { randomUUID } from 'node:crypto';
import type { SessionMessage, ToolCall, ToolContext, ToolDefinition } from '../types';
import type { GenerateFallbackEntry, ThinkingControl } from '@orison/shared-contracts';
import { THINKING_PROFILES, resolveModelInfo } from '@orison/shared-contracts';
import { registry } from '../tool/registry';
import { logger } from '../logger';
import { extractJson } from './extract-json';
import type { GenerateFn } from './llm-node';
import type { GenerateResult, GenerationDelta } from '../provider/ipc-provider';
import type { SummarizationGenerateFn } from '../context/summarizer';
import { compactWithSummarization } from '../context/summarizer';
import { compactConversationHardCut, ContextWindowOverflowError } from '../context/contextManager';
import { hardCutForOverflow, isContextOverflowSeamError } from '../context/overflow';
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldTriggerCompaction,
  isProjectionOverflow,
  resolveContextWindowTokens,
  clampRedlinePercent,
  COMPACTION_TARGET_RATIO,
} from '../context/tokenEstimator';

// ── Story 8.4 A 段（design §1.1 形态 c / §1.6）：节点内轻量 agent 工具循环基建 ──
//
// draft-writer 节点 agent 化（形态 c：节点内部 agent 循环）+ 资料员核实子循环共用的机制底座。
// ADR-17 节点柔性明文（WriteHERE：draft 节点内部创作行为柔性，允许递归子任务，不锁刚性单 pass）。
//
// **为什么自建而不用 runLoop / runAgentWithExplicitSystem**：链段节点无会话语义（chainRunner 跑
// DAG，节点不持 session 引用），借 leader 侧 runAgentWithExplicitSystem 反而重（要 createChildSession
// + 权限收窄 + LRU 占位）；runLoop 自带 session/权限/压缩/skill 机制，节点内用不上。本 helper
// **无会话语义、纯节点内**——不 import 不复用 runLoop 的 session 机制，只 mirror 它的既定容错模式
// （.trellis/spec/agent/agent-runtime.md）：
// - 畸形工具调用容错：JSON.parse 失败 → extractJson 防御抽取（first-{→last-} 嵌套主策略 + last-{→last-}
//   DashScope "{}{...}" 双对象副策略，双候选先 parse 通过者返回；R2-盲6：旧 lastBrace>0 守卫排除
//   「首字符即 { + 尾垃圾」形态，本可恢复被判死）+ 参数被嵌套成 JSON 字符串时解包 + 修正后回写
//   call.arguments 防毒历史。
// - 与 runLoop 的一处差异：兜底彻底失败（解析不出任何 JSON 对象）→ 回显式 `Error:` 消息不执行
//   （runLoop 以 {} 执行——本 helper 的工具是只读查询，显式错误消息 + 原参数片段让 LLM 直接自纠重发）。
// - 连续错误中断：连续 N 轮（默认 3，mirror runLoop MAX_CONSECUTIVE_TOOL_ERRORS）全部工具结果为
//   Error → 中断返回（caller 降级处理）；有任一成功结果即清零。
// - abort 贯穿：轮首/工具执行后检查，AbortError 传播（取消语义不吞）。
//
// **稳定前缀约定（design §1.2，两阶段不变）**：stablePrefix = 任务卡 + 设定前缀消息，写手两阶段
// （自查 / 写作）**逐字节同一份**；查询轮消息追加其后。messages 组装序 = stablePrefix →
// priorMessages（续阶段时 = 上一阶段产出的消息）→ 本阶段 user 指令 → 查询轮。为 C 系列 provider
// prompt 缓存铺路但不依赖它。⚠️ 返回值 messages 只含**本循环新增**消息（不含 stablePrefix /
// priorMessages）——续阶段时 caller 把它作 priorMessages 传回、stablePrefix 由 config 恒定重携，
// 前缀不重复不漂移。
//
// **工具执行 seam**：resolveTool 缺省直调 builtin `registry.get(id)`（mirror world-state-query.ts
// executeBuildWorldSnapshotTool 先例——remoteToolProxy 工具 execute → IPC → shell handler；ToolContext
// sessionId 空串 placeholder，handler 只读 projectDir）。工具集由 config 传 id 列表（Step 2 写手接
// 只读十三件（Story 8.7 S8 扩三件）。config 里解析不到的 id → 响亮报错拒绝开跑（静默缺工具开跑 =
// 写手自查能力面暗中残缺，永不静默）。
//
// **两条独立保险丝（design §1.6，互不复用计数）**：maxRounds = 查询轮上限（写手 50，bug 保险丝——
// 正常写作远到不了，到了即机械熔断）超限抛 ToolLoopFuseError（message 含 `tool_loop_fuse`，供
// RunSnapshot 记 reason，不静默截断）；核实回合 ≤3 是 caller 侧的另一条闸（写手循环内维护），不在本 helper。
//
// **循环只管「工具循环到收束」，阶段编排归 caller**：写手（阶段一自查以产出简报收束 → dispatch
// 资料员核实 → 阶段二以产出正文收束，阶段推进由节点代码控制非 LLM 自觉）与资料员（核实单阶段）。
//
// expected_downstream_consumers:
// - Story 8.4 Step 2：draft-writer 节点改造（阶段一自查循环产调查简报 + 阶段二写作循环产正文）。
// - Story 8.4 Step 3：资料员核实子循环（任务卡+简报+机械弹药包 → verification verdict）。

/** 循环收束形态。 */
export type AgentLoopStatus =
  /** stopMarker 命中——阶段收束产物（content）已出。 */
  | 'stopped'
  /** LLM 结束回合但输出未含收束标记（content 可能仍可解析——parse 与重试归 caller 裁决）。 */
  | 'turn_end'
  /** 连续 maxConsecutiveErrorRounds 轮全部工具错误，中断返回（mirror runLoop break，caller 降级）。 */
  | 'consecutive_errors';

export interface AgentLoopResult {
  status: AgentLoopStatus;
  /** 最后一条 assistant content（阶段产物文本——收束轮或中断前最后一轮）。 */
  content: string;
  /** 本循环新增消息（user 指令 + 各轮 assistant/tool；**不含 stablePrefix / priorMessages**——续阶段作 priorMessages 传回）。 */
  messages: SessionMessage[];
  /** 已消耗的 generate 轮数（含收束轮；熔断时 = maxRounds）。 */
  rounds: number;
}

/**
 * 查询轮上限熔断错误（design §1.6：≤50 轮保险丝）。message 含 `tool_loop_fuse`——caller 捕获后
 * RunSnapshot 记 reason=tool_loop_fuse（不静默截断）。
 */
export class ToolLoopFuseError extends Error {
  constructor(maxRounds: number) {
    super(`tool_loop_fuse: agent loop exceeded maxRounds=${maxRounds} without reaching stop marker`);
    this.name = 'ToolLoopFuseError';
  }
}

export interface AgentLoopDeps {
  /** LLM 生成 seam（mirror createLlmNode.deps.generate——节点注入 + mock 测试）。 */
  generate: GenerateFn;
  /** 工具解析 seam：id → ToolDefinition。缺省直调 builtin registry.get（测试注入 fake registry）。 */
  resolveTool?: (id: string) => ToolDefinition | undefined;
  /** 模型引用（透传 generate opts，mirror LlmNodeDeps.modelRef）。 */
  modelRef?: { keyId: string; modelId: string };
  /**
   * S4b（task 08-25 design §1.2/§2）：档位思考策略——与 modelRef 同源同传
   *（assignment 整体随档，design §1.2「不杂交」）。undefined = auto 零行为变化。
   */
  thinking?: ThinkingControl;
  /** abort 信号（缺省新建永不 abort 的 signal，mirror LlmNodeDeps.signal）。 */
  signal?: AbortSignal;
  /**
   * dogfood T1 Stage 6（design §4，r1 甄别）→ 09-13 子2 W1 全相位开流：可选流式回调——
   * 存在时每次 generate **预分配该轮 assistantId**（delta 与该轮 assistant 消息同 id，
   * mirror runLoop §3.1 消除 id 漂移）并把 opts.onDelta 传入 generate（shell 缝按
   * callbacks 分派流式路径）。seam 本身双通道透传（text/reasoning，tool 在包装内滤除）；
   * **通道政策在 caller**（链装配侧）：text 仅 draft-writer 阶段二（正文流语义不变——
   * JSON 阶段裸 text 不上行，writer-node / research-verifier 按相位滤），reasoning
   * 全相位全节点（09-13 子2 design §1）。
   */
  onDelta?: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => void;
  /**
   * 09-12 agy provider（design §3.1 装配点②「writer agent 循环」）：逻辑会话键——链段装配方
   * 注入（chapter-chain 按逻辑会话命名空间分键：写手循环 `chain:<childSessionId>:writer` /
   * 核实子循环 `:verify`〔CR-21〕，runChain 级唯一 id 源）；进主循环 generate
   * opts（每轮同键 → session-capable provider 复用温进程 + 增量发送）。'' 与 undefined
   * 同义 = 缺席（单发冷路径，两态纪律）。**刻意不进** gateSummarizationGenerate——摘要
   * 调用是另一逻辑会话（消息序列无关），同键会造成镜像分歧反复冷重启。
   */
  sessionKey?: string;
  /**
   * 09-12 子2 fallback chains（H2 透传面）：slot 回退链（wire 归一形态，chapter-chain
   * 装配方经 assignmentFallbackChain 投影注入）——进主循环 generate opts。摘要调用
   * （gateSummarizationGenerate）刻意不带——链侧压缩摘要回退政策 = **不回退**（CR-26
   * 统一说明）：单发小调用回退价值低且会拖长压缩窗，摘要 LLM 失败已有
   * compactWithSummarization 内部确定性兜底（segmented → 硬截断）非硬失败
   *（mirror sessionKey 的「摘要另一逻辑会话」裁量）。dialogue 车道（workflow
   * manualCompactSession 的 summarizationGenerate）是另一态 = 随档回退（用户在场，
   * 摘要失败卡对话压缩）——两态互指，改任一侧先读对面（runtime/workflow.ts
   * summarizationGenerate 装配处注释）。
   */
  fallbacks?: GenerateFallbackEntry[];
  /**
   * 09-12 usage-panel：任务档位/流程标签——进主循环 generate opts（writer 循环按 phase
   * 由 writer-node buildLoop 注入 'writer-draft' / 'writer-selfcheck'）。闸门压缩摘要
   * （gateSummarizationGenerate）恒标流程语义 'context-summary'（链段摘要，非档位车道的
   * 主调用——与 sessionKey 的「摘要另一逻辑会话」同款裁量）。
   */
  taskType?: string;
  /**
   * 09-12 子2（design §7）：模型切换回调——链段装配方注入（chapter-chain 补 nodeId/role
   * 转成 ChainStreamEvent 'model-fallback' 事件）。缺省不传（直构测试零事件）。
   */
  onFallback?: (event: { from: { keyId: string; modelId: string }; to: { keyId: string; modelId: string }; reason: string; attempt: number }) => void;
  /**
   * 09-13 子2 CR 批（CR-11）：链节点位元数据——onToolCall 发射时并入载荷（事件归属）。
   * 循环宿主注入（writer-node 用自身节点位常量 / research-verifier 归属写手节点位）；
   * 链外直构测试缺省不带（payload 无 nodeId 键，消费方兜底当前唯一节点位）。additive optional。
   */
  nodeId?: string;
  /**
   * 09-13 子2 W4（design §3，B 路线定案）：链内工具调用观测回调——每个工具执行终态后发射
   * （executeCallSafely 循环体）。inputSummary = 归一后 call.arguments JSON 截断 200（与畸形
   * 参数回显共用 TOOL_ARG_SUMMARY_CAP 单一常数）；status = 输出 `Error:` 前缀机械判；
   * resultCount = **输出字符数恒档**（design §3 定谳：executeCallSafely seam 只返 output 字符串，
   * 不强行改其返回结构透传 ToolResult metadata——结构化计数档机会主义不承诺）。链装配方
   * （chapter-chain）注入并补 nodeId 转 ChainStreamEvent 'chain-tool' 事件；leader/child 车道
   * 不发射（本事件链专用）。缺省不开（直构测试零事件，零回归）。
   */
  onToolCall?: (d: { nodeId?: string; toolName: string; inputSummary: string; resultCount: number; status: 'ok' | 'error' }) => void;
}

export interface AgentLoopConfig {
  /** 工具集（builtin registry id 列表——caller 负责**只传只读工具**；本 helper 不做权限收窄，禁区红线归 caller 契约）。 */
  toolIds: string[];
  /** system prompt（yaml system 段，ADR-4 单契约源——caller 从 loadAgentPrompt 取）。 */
  systemPrompt: string;
  /** 稳定前缀消息（任务卡+设定前缀，两阶段逐字节不变——见文件头稳定前缀约定）。 */
  stablePrefix: SessionMessage[];
  /** 阶段收束标记：LLM 输出 content 含任一标记即该阶段完成（空串标记忽略）。 */
  stopMarkers: string[];
  /** 轮数上限（bug 保险丝，≥1；超限抛 ToolLoopFuseError）。 */
  maxRounds: number;
  /** 连续全错误轮中断阈值（缺省 3，mirror runLoop MAX_CONSECUTIVE_TOOL_ERRORS）。 */
  maxConsecutiveErrorRounds?: number;
  /** 项目路径（ToolContext.projectPath——工具 handler 解析 projectDir 用）。 */
  projectPath: string;
  /**
   * S4a（task 08-25 design §4.1）：上下文窗口 token 数——pre-gate 判定用。缺省回落 1M
   * （resolveContextWindowTokens 防御归一）。链段装配方（chapter-chain llmDepsFor 线）按节点
   * 所指模型 limits 注入；缺省 = 既有 1M 行为（additive optional 零迁移）。
   */
  contextWindowTokens?: number;
  /**
   * S4a：压缩红线百分比（50~100 clamp，缺省 95——runLoop 车道同款语义：未到红线不压）。
   */
  redlinePercent?: number;
}

export interface AgentLoopInput {
  /** 本阶段首轮 user 指令（阶段一=自查任务指令；阶段二=许可回执+写作指令）。 */
  userPrompt: string;
  /** 续阶段：上一阶段循环产出的 messages（不含其 stablePrefix——见返回值约定）。缺省 = 全新阶段。 */
  priorMessages?: SessionMessage[];
}

/** 连续全错误轮中断默认阈值（mirror runLoop MAX_CONSECUTIVE_TOOL_ERRORS = 3）。 */
export const AGENT_LOOP_DEFAULT_MAX_CONSECUTIVE_ERROR_ROUNDS = 3;

/**
 * 工具参数摘要截断上限（09-13 子2 W4：单一常数两消费点——chain-tool 事件 inputSummary 与
 * executeCallSafely 畸形参数回显〔既有先例〕同形 `slice(0, 200) + '…'`，免两套常数）。
 */
const TOOL_ARG_SUMMARY_CAP = 200;

// ── 摘要对形态常量 + 构造/估算 helper（CR-018：targetTokens 扣摘要对开销的估算口径与
// 注入口径必须同源——常量单点，估算与 buildSummaryPair 共用，防漂移）。──
const SUMMARY_PAIR_OPEN = '<history_summary readonly="true">';
const SUMMARY_PAIR_CLOSE = '</history_summary>';
const SUMMARY_PAIR_ACK = 'Understood. I will continue based on the context above.';

/** gate / 溢出重试注入的摘要对（user <history_summary> + assistant 确认，mirror provider 注对形态）。 */
function buildSummaryPair(summaryText: string): [SessionMessage, SessionMessage] {
  return [
    {
      id: randomUUID(),
      role: 'user',
      content: `${SUMMARY_PAIR_OPEN}\n${summaryText}\n${SUMMARY_PAIR_CLOSE}`,
      createdAt: Date.now(),
    },
    {
      id: randomUUID(),
      role: 'assistant',
      content: SUMMARY_PAIR_ACK,
      createdAt: Date.now(),
    },
  ];
}

/**
 * CR-018（08-25 BMad CR）：重注入摘要对的估算 tokens（wrapper 标签 + 确认消息 + 2×4
 * framing，mirror estimateMessagesTokens 口径）——gate targetTokens 与 overhead 判定共用，
 * 不扣则压缩目标系统性偏松（压完 target 达标但 + 摘要对 又超）。新摘要尚未生成时以现有
 * 摘要规模为代理（summarizer MAX_SUMMARY_CHARS 有界）。
 */
export function estimateSummaryPairTokens(summary: string | undefined): number {
  return (
    estimateTokens(`${SUMMARY_PAIR_OPEN}\n${summary ?? ''}\n${SUMMARY_PAIR_CLOSE}`)
    + estimateTokens(SUMMARY_PAIR_ACK)
    + 8 // 两条消息 framing（mirror estimateMessagesTokens 每条 +4）
  );
}

/**
 * 构造节点内 agent 工具循环：runAgentLoop(input) = generate（携工具定义）→ 解析 toolCalls →
 * 逐个执行（畸形容错 / 未知工具回错）→ 结果回填 → 再 generate，直到 stopMarker 命中 / 回合自然
 * 结束 / 连续错误中断 / 轮数熔断（抛 ToolLoopFuseError）。
 */
export function makeAgentLoop(deps: AgentLoopDeps, config: AgentLoopConfig) {
  const resolveTool = deps.resolveTool ?? ((id: string) => registry.get(id));

  return async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
    if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1) {
      throw new Error(`makeAgentLoop: maxRounds must be a positive integer (got ${config.maxRounds})`);
    }
    const maxConsecutiveErrorRounds =
      config.maxConsecutiveErrorRounds ?? AGENT_LOOP_DEFAULT_MAX_CONSECUTIVE_ERROR_ROUNDS;

    // 工具解析（一次性，循环内工具集不变）：config 里的 id 解析不到 → 响亮报错拒绝开跑。
    const toolsById = new Map<string, ToolDefinition>();
    const missing: string[] = [];
    for (const id of config.toolIds) {
      const tool = resolveTool(id);
      if (tool) toolsById.set(id, tool);
      else missing.push(id);
    }
    if (missing.length > 0) {
      throw new Error(`makeAgentLoop: tool(s) not found in registry: ${missing.join(', ')}（接线缺工具，拒绝静默缺工具开跑）`);
    }
    const tools = [...toolsById.values()];

    const abortSignal = deps.signal ?? new AbortController().signal;
    // ToolContext mirror world-state-query makeToolContext：chain node 无 session 引用，sessionId 空串
    // placeholder（builtin 工具 handler 只读 projectDir）；abort 贯穿工具执行。
    const ctx: ToolContext = {
      sessionId: '',
      projectPath: config.projectPath,
      abort: abortSignal,
    };

    const messages: SessionMessage[] = [
      ...config.stablePrefix,
      ...(input.priorMessages ?? []),
      { id: randomUUID(), role: 'user', content: input.userPrompt, createdAt: Date.now() },
    ];
    const produced: SessionMessage[] = [messages[messages.length - 1]];

    // ── S4a pre-gate（task 08-25 design §4.1）：每轮 generate 前的红线/投影溢出闸门 ──
    //
    // writer 自查 / 资料员核实子循环此前零窗口管理（research C Q1：makeAgentLoop 不经
    // prepareContext）——B 块保留思考历史后消息必胀，本闸门补同款判定（红线 + 投影溢出；
    // **无手动位**——手动压缩是会话语义，节点内循环不暴露）。
    //
    // 压缩作用域 = stablePrefix **之后**的对话段：stablePrefix 是两阶段逐字节同一份的任务卡
    // +设定前缀（文件头约定），压缩它 = 跨阶段前缀漂移 + 设定语义质量押给摘要——不可接受；
    // 可压的是对话段（用户指令 + 查询轮）。压缩产物以「摘要对」形态重注入（mirror provider
    // messagesToPayload 的 <history_summary> 注对形态——本循环 generate 不吃 cacheConfig，
    // 摘要必须以消息进上下文）。
    //
    // 压缩实现选型（按可用性）：**compactWithSummarization**——deps.generate 是
    // AgentLoopDeps 必填项故 LLM 摘要可用，且其**内部三级兜底**（segmented → 确定性硬截
    // 中段）已覆盖 LLM 失败退化（机制不动，S4a 只改触发条件），无需外层再包一层
    // compactConversation 退化（外层 catch 是死代码——summarizer 不上抛非 abort 错）。
    // 投影溢出压后仍塞不下时升级 compactConversationHardCut（保尾 2 确定性截断），
    // 再塞不下抛 ContextWindowOverflowError（明确报错不静默，与 runLoop 车道同款兜底序）。
    const gateWindowTokens = resolveContextWindowTokens(config.contextWindowTokens);
    const gateRedlinePercent = clampRedlinePercent(config.redlinePercent);
    const gatePrefixTokens = estimateTokens(config.systemPrompt) + estimateMessagesTokens(config.stablePrefix);
    // CR-008（08-25 BMad CR）：本车道模型的 reasoning 回传义务——`THINKING_PROFILES[kind]
    // .reasoningRoundTrip === 'required'` 档（kimi-k3 / deepseek-v4 族）时压缩升级路径
    // （gate 硬截断 + 溢出重试 hardCut）保尾不得低于保底区段（近段含 reasoning 消息完整
    // 保留，厂商硬回传义务防 400）。kind 从 deps.modelRef 经 registry 单源推导；未配
    // modelRef / 未知模型 → undefined（无 required 义务，现行为）。
    const laneThinkingKind = deps.modelRef ? resolveModelInfo(deps.modelRef.modelId).thinking : undefined;
    const requiredRoundTrip = laneThinkingKind !== undefined
      && THINKING_PROFILES[laneThinkingKind].reasoningRoundTrip === 'required';
    // gate 注入的摘要对（user <history_summary> + assistant 确认）；替换式——再压缩时旧对随
    // 消息重建自然出局。gateSummary 存裸摘要文本（existingSummary 复用），对内消息是包装形态。
    let summaryPair: [SessionMessage, SessionMessage] | undefined;
    let gateSummary: string | undefined;
    // 压缩用 LLM：零工具 + 同模型（deps.modelRef 在时携带，mirror 主 generate 调用位），
    // mirror runLoop summarizationGenerate（loop.ts:106-109）。思考策略同随（assignment
    // 整体，与主调用同源——摘要与写作同档同模型同策略，不拆）。
    const gateSummarizationGenerate: SummarizationGenerateFn = async (msgs, system, abortSignal) => {
      const res = await deps.generate(
        msgs,
        system,
        [],
        abortSignal,
        deps.modelRef || deps.thinking
          ? {
              ...(deps.modelRef ? { modelRef: deps.modelRef } : {}),
              ...(deps.thinking ? { thinking: deps.thinking } : {}),
              // 09-12 usage-panel：链段压缩摘要恒标 'context-summary'（流程标签——不随
              // 主循环档位词，摘要调用语义自成一族，见 AgentLoopDeps.taskType 注释）。
              taskType: 'context-summary',
            }
          : { taskType: 'context-summary' },
      );
      return { content: res.content };
    };
    const prefixIds = new Set(config.stablePrefix.map((m) => m.id));
    const priorIds = new Set((input.priorMessages ?? []).map((m) => m.id));
    // produced 派生同步：压缩重建后按 id 集重算（非 stablePrefix / 非 priorMessages 的消息，
    // 含 gate 注入的摘要对）——被压掉的消息（含旧摘要对）自然出局，不残留 dangling
    // assistant(toolCalls) 无 tool 回填的配对断裂。
    const syncProduced = (): void => {
      produced.splice(
        0,
        produced.length,
        ...messages.filter((m) => !prefixIds.has(m.id) && !priorIds.has(m.id)),
      );
    };

    const runContextGate = async (): Promise<void> => {
      const baseIndex = config.stablePrefix.length + (summaryPair ? summaryPair.length : 0);
      const convo = messages.slice(baseIndex);
      const overheadTokens = gatePrefixTokens + (summaryPair ? estimateMessagesTokens(summaryPair) : 0);
      const convoTokens = estimateMessagesTokens(convo);
      // 无校准环（本循环无 usage 消费），ratio 恒 1.0。
      const redlineHit = shouldTriggerCompaction(overheadTokens, convoTokens, 1.0, gateWindowTokens, gateRedlinePercent);
      const projectionOverflow = isProjectionOverflow(overheadTokens + convoTokens, 1.0, gateWindowTokens);
      if (!redlineHit && !projectionOverflow) return;

      logger.info(
        {
          overheadTokens,
          convoTokens,
          convoCount: convo.length,
          windowTokens: gateWindowTokens,
          redlinePercent: gateRedlinePercent,
          redlineHit,
          projectionOverflow,
        },
        'makeAgentLoop pre-gate: context budget exceeded, compacting conversation segment',
      );

      const result = await compactWithSummarization(convo, {
        // CR-018（08-25 BMad CR）：目标预算扣除重注入摘要对的估算开销（wrapper 标签 + 确认
        // 消息 + framing）——不扣则二次判定系统性偏松。新摘要未生成，以现有 gateSummary
        // 规模为代理（estimateSummaryPairTokens）。
        targetTokens: Math.max(
          0,
          Math.floor(gateWindowTokens * COMPACTION_TARGET_RATIO)
            - gatePrefixTokens
            - estimateSummaryPairTokens(gateSummary),
        ),
        preserveRecent: 6,
        existingSummary: gateSummary,
        generate: gateSummarizationGenerate,
        abort: abortSignal,
      });

      // CR-013（08-25 BMad CR）空转防御②：无可压内容（对话段 ≤ 保尾区 → compactedCount 0）
      // 且非投影溢出路径——不重注入新 UUID 摘要对（UUID churn + 稳定前缀漂移破坏缓存），
      // 本轮 gate 到此为止。prefix + summaryPair 自身过 gate 的稳态由此停住（此前每轮白烧
      // gate 升级 + UUID churn）。
      if (result.compactedCount === 0 && !projectionOverflow) return;

      let retained = result.retainedMessages;
      let summaryText: string | undefined = result.summary;

      // 投影仍溢出（压缩未收敛到窗口内）→ 确定性硬截断兜底；仍溢出 → 明确报错（不静默）。
      // 只在投影溢出路径升级（红线是软目标：压后仍超红线但塞得下则不硬截断）。
      if (projectionOverflow) {
        const afterTokens = gatePrefixTokens + estimateTokens(summaryText ?? '') + estimateMessagesTokens(retained);
        if (isProjectionOverflow(afterTokens, 1.0, gateWindowTokens)) {
          const hard = compactConversationHardCut({
            messages: retained,
            existingSummary: summaryText,
            contextWindowTokens: gateWindowTokens,
            // CR-008：required 档保尾下限 = 保底区段（近段 reasoning 完整保留）。
            ...(requiredRoundTrip ? { reasoningRoundTripRequired: true } : {}),
          });
          retained = hard.messages;
          summaryText = hard.summary;
          logger.warn(
            { retained: retained.length, windowTokens: gateWindowTokens },
            'makeAgentLoop pre-gate: post-compaction still over window, hard-cut applied',
          );

          const hardAfterTokens = gatePrefixTokens + estimateTokens(summaryText ?? '') + estimateMessagesTokens(retained);
          if (isProjectionOverflow(hardAfterTokens, 1.0, gateWindowTokens)) {
            throw new ContextWindowOverflowError({
              estimatedTokens: hardAfterTokens,
              windowTokens: gateWindowTokens,
              redlinePercent: gateRedlinePercent,
            });
          }
        }
      }

      // 重建消息（prefix + 新摘要对 + 保留尾）并派生同步 produced（摘要对构造走
      // buildSummaryPair 单源——CR-018 估算口径同源）。
      summaryPair = buildSummaryPair(summaryText ?? '');
      gateSummary = summaryText;
      messages.splice(0, messages.length, ...config.stablePrefix, ...summaryPair, ...retained);
      syncProduced();
    };

    let rounds = 0;
    let consecutiveErrorRounds = 0;

    while (true) {
      if (rounds >= config.maxRounds) {
        throw new ToolLoopFuseError(config.maxRounds);
      }
      rounds += 1;
      throwIfAborted(abortSignal);

      // S4a：每轮 generate 前跑闸门（不触发时纯估算一次，零 LLM 调用）。
      await runContextGate();

      // dogfood T1 Stage 6：onDelta 在时预分配该轮 assistantId（delta 事件与该轮 assistant 消息
      // 同 id——UI 侧可按 messageId 分轮拼接）；opts.onDelta 随 modelRef/thinking 一并注入 generate。
      // 09-12 子2（H2）：fallbacks/onFallback 同 deps 透传进 generate opts（逐字段枚举会静默丢）。
      // 09-12 usage-panel：taskType 同透传。
      const roundMessageId = randomUUID();
      const generateOpts = deps.modelRef || deps.onDelta || deps.thinking || deps.sessionKey || deps.fallbacks?.length || deps.onFallback || deps.taskType
        ? {
            ...(deps.modelRef ? { modelRef: deps.modelRef } : {}),
            ...(deps.thinking ? { thinking: deps.thinking } : {}),
            ...(deps.sessionKey ? { sessionKey: deps.sessionKey } : {}),
            ...(deps.taskType ? { taskType: deps.taskType } : {}),
            ...(deps.fallbacks?.length ? { fallbacks: deps.fallbacks } : {}),
            ...(deps.onFallback ? { onFallback: deps.onFallback } : {}),
            ...(deps.onDelta
              ? {
                  onDelta: (d: GenerationDelta) => {
                    // R2 #30：tool 通道（工具参数流活性）不进 chain-delta 车道——链卡正文
                    // 只有文本；该指示信号由 leader/child 流式车道消费。
                    if (d.type === 'tool') return;
                    deps.onDelta!({ messageId: roundMessageId, channel: d.type, delta: d.delta });
                  },
                }
              : {}),
          }
        : undefined;
      // `messages` 是 const 数组、hardCut 后 splice 原地重建——callGenerate 每次现读引用内容。
      const callGenerate = (): Promise<GenerateResult> =>
        deps.generate(messages, config.systemPrompt, tools, abortSignal, generateOpts);

      let response: GenerateResult;
      try {
        response = await callGenerate();
      } catch (err) {
        // CR-004（08-25 BMad CR）：CONTEXT_OVERFLOW 标记此前穿过三层无人消费（协议层标记 /
        // runLoop 车道有重试、本车道缺位）——档未配置时 1M 假窗口盲重试到节点失败。接同款
        // 溢出重试（共享 helper context/overflow.ts，与 loop.ts 同源）：确定性 hardCut 一次
        //（窗口 = 报文提取值 ?? config 注入 ?? 1M）→ 摘要对重注入（消息形态，本循环无
        // cacheConfig 车道）→ 重试一次；再溢出原样上抛（不无限压缩重试）。压缩作用域 =
        // stablePrefix + 摘要对之后的对话段（与 gate 同界——prefix 不可压，见文件头约定）。
        if (!isContextOverflowSeamError(err)) throw err;
        const baseIndex = config.stablePrefix.length + (summaryPair ? summaryPair.length : 0);
        const convo = messages.slice(baseIndex);
        const hardCut = hardCutForOverflow({
          err,
          messages: convo,
          existingSummary: gateSummary,
          ...(config.contextWindowTokens !== undefined ? { injectedWindowTokens: config.contextWindowTokens } : {}),
          ...(requiredRoundTrip ? { reasoningRoundTripRequired: true } : {}),
        });
        summaryPair = buildSummaryPair(hardCut.summary);
        gateSummary = hardCut.summary;
        messages.splice(0, messages.length, ...config.stablePrefix, ...summaryPair, ...hardCut.messages);
        syncProduced();
        logger.warn(
          {
            rounds,
            compactedCount: hardCut.compactedCount,
            retained: hardCut.messages.length,
            windowTokens: hardCut.windowTokens,
          },
          'makeAgentLoop: context overflow 400 → one deterministic hard-cut, retrying generate once',
        );
        response = await callGenerate();
      }

      const assistantMsg: SessionMessage = {
        id: roundMessageId,
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
        ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
      };
      messages.push(assistantMsg);
      produced.push(assistantMsg);

      const hitMarker = config.stopMarkers.some((m) => m.length > 0 && response.content.includes(m));

      if (response.toolCalls?.length) {
        // 逐个执行（顺序，非并行）：畸形容错 / 未知工具回错 / execute 抛错回 Error 消息——循环不崩。
        let allErrors = true;
        for (const call of response.toolCalls) {
          const output = await executeCallSafely(call, toolsById, ctx);
          const failed = output.startsWith('Error:');
          if (!failed) allErrors = false;
          // 09-13 子2 W4（design §3，B 定案）：链内工具调用观测——executeCallSafely 后发射
          //（call.arguments 已被归一回写——发射读到的是归一形态，反而更干净）。发射失败静默
          //（可观测性绝不破循环，mirror withNodeArtifact safeEmit 姿态）。
          // CR 批 CR-11：deps.nodeId 并入载荷（节点位透传——装配侧 wrapper 读透传值不硬编码）。
          if (deps.onToolCall) {
            try {
              deps.onToolCall({
                ...(deps.nodeId ? { nodeId: deps.nodeId } : {}),
                toolName: call.name,
                inputSummary:
                  call.arguments.length > TOOL_ARG_SUMMARY_CAP
                    ? `${call.arguments.slice(0, TOOL_ARG_SUMMARY_CAP)}…`
                    : call.arguments,
                resultCount: output.length,
                status: failed ? 'error' : 'ok',
              });
            } catch (err) {
              // 可观测性发射失败（IPC 已死等）静默丢弃；CR 批 CR-5：低噪留痕
              //（系统性死通道与安静系统不可区分——debug 一句，带 nodeId/error）。
              logger.debug(
                { nodeId: deps.nodeId, err: err instanceof Error ? err.message : String(err) },
                'makeAgentLoop: onToolCall emit failed (ignored)',
              );
            }
          }
          const toolMsg: SessionMessage = {
            id: randomUUID(),
            role: 'tool',
            content: output,
            toolResults: [{ toolCallId: call.id, toolName: call.name, output }],
            createdAt: Date.now(),
          };
          messages.push(toolMsg);
          produced.push(toolMsg);
        }
        throwIfAborted(abortSignal);

        if (allErrors) {
          consecutiveErrorRounds += 1;
          if (consecutiveErrorRounds >= maxConsecutiveErrorRounds) {
            logger.warn(
              { rounds, consecutiveErrorRounds },
              'makeAgentLoop: too many consecutive tool errors, breaking loop',
            );
            return { status: 'consecutive_errors', content: response.content, messages: produced, rounds };
          }
        } else {
          consecutiveErrorRounds = 0;
        }

        if (hitMarker) {
          // 收束标记已出且同轮也发了工具调用——先回填工具结果保 assistant/tool 消息配对完整（续阶段
          // 的 generate 读历史时不留 dangling toolCalls），再收束。
          return { status: 'stopped', content: response.content, messages: produced, rounds };
        }
        continue;
      }

      // 无工具调用：回合自然结束。命中标记 → 收束；未命中 → turn_end（产物 parse 与重试归 caller）。
      return {
        status: hitMarker ? 'stopped' : 'turn_end',
        content: response.content,
        messages: produced,
        rounds,
      };
    }
  };
}

/**
 * 单个工具调用的容错执行。返回 tool 输出文本（失败为 `Error: ...` 消息——`Error:` 前缀约定供连续
 * 错误轮计数，mirror runLoop）。畸形 arguments 兜底链（mirror runLoop loop.ts:253-275 + R2-盲6 修正）：
 * JSON.parse → extractJson 防御抽取（双候选：first-{→last-} 嵌套对象+前后文字主策略 / last-{→last-}
 * DashScope `"{}{...}"` 双对象副策略）→ 嵌套 JSON 字符串解包 → 仍非普通对象 → 显式 Error 消息（不执行）。
 * 成功解析后回写 call.arguments（防畸形串进消息历史毒化后续轮次）。
 */
async function executeCallSafely(
  call: ToolCall,
  toolsById: Map<string, ToolDefinition>,
  ctx: ToolContext,
): Promise<string> {
  const tool = toolsById.get(call.name);
  if (!tool) {
    return `Error: tool "${call.name}" not found`;
  }

  let params: unknown;
  try {
    params = JSON.parse(call.arguments);
  } catch {
    // 某些 provider（DashScope/Qwen）偶发畸形 arguments："{}{...}" 双对象 / "{...}尾垃圾" 等。R2-盲6：
    // 旧 `lastBrace > 0` 守卫排除「首字符即 { + 尾垃圾」载荷（lastIndexOf('{')===0 被判死）——改经
    // extractJson 防御抽取（双候选先 parse 通过者返回，first-{ 主策略天然覆盖嵌套对象 + 前后文字，
    // mirror extract-json.ts 4 节点 parseOutput 同源哲学），首字符即 { 的可恢复形态不再误杀。
    try {
      params = JSON.parse(extractJson(call.arguments));
    } catch {
      params = undefined;
    }
  }
  // 兼容参数被嵌套成 JSON 字符串传入的情况。
  if (typeof params === 'string') {
    try {
      params = JSON.parse(params);
    } catch {
      /* 保持原样，落进下面的形态检查 */
    }
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    // 09-13 子2 W4：截断常数与 chain-tool inputSummary 共用 TOOL_ARG_SUMMARY_CAP（单一常数）。
    const raw = call.arguments.length > TOOL_ARG_SUMMARY_CAP ? `${call.arguments.slice(0, TOOL_ARG_SUMMARY_CAP)}…` : call.arguments;
    return `Error: malformed arguments for tool "${call.name}"（无法解析为 JSON 对象，请修正后重发）：${raw}`;
  }
  // 修正回写防毒历史（mirror runLoop：畸形串留在消息历史会毒化后续 parse）。
  call.arguments = JSON.stringify(params);

  try {
    const result = await tool.execute(params, ctx);
    return result.output;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ tool: call.name, err: errMsg }, 'makeAgentLoop: tool execution failed');
    return `Error: ${errMsg}`;
  }
}

function throwIfAborted(abort: AbortSignal): void {
  if (abort.aborted) {
    throw abort.reason instanceof DOMException
      ? abort.reason
      : new DOMException('Aborted', 'AbortError');
  }
}
