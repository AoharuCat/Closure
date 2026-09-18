import { randomUUID } from 'node:crypto';
import type { ChainStreamEvent, ChildStreamEvent, ContextUsageEventData, SessionMessage, SkillExecutorRef, StreamDeltaData, ToolCall, ToolContext, ToolDefinition } from '../types';
import { CONTEXT_SUMMARY_TASK_TYPE } from '../types';
import type { GenerationDelta, GenerateTextUsage } from '../provider/ipc-provider';
import type { CacheConfig, ContextState } from '../context/contextManager';
import type { SummarizationGenerateFn } from '../context/summarizer';
import type { PinnedContextItem } from '../context/pinnedContext';
import type { AgentBehaviorMode, ThinkingKind } from '@orison/shared-contracts';
import { THINKING_PROFILES } from '@orison/shared-contracts';
import { prepareContext, createDefaultContextState } from '../context/contextManager';
import { hardCutForOverflow, isContextOverflowSeamError } from '../context/overflow';
import { clampRedlinePercent, estimateTokens, estimateMessagesTokens, updateCalibrationRatio } from '../context/tokenEstimator';
import { logger } from '../logger';
import { AUTO_APPLY_SELF_REVIEW_MESSAGE, assertToolAllowed, enforceAutoApplyTier, filterToolsForPolicy, shouldGateAutoApply, type SessionPermissionMode } from '../runtime/toolPolicy';
import { appendToolDescriptions } from '../prompt/render';

interface ActiveSkillMetadata {
  name?: string;
  allowedTools?: string[];
  permission?: SessionPermissionMode;
}

/** runLoop 每次 generate 的返回形状（LoopOptions.generate 的 Promise 值）。 */
interface LoopGenerateResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  /** 深度思考终帧聚合（dogfood T1 #27②）——runLoop 写进终帧 assistantMsg。additive。 */
  reasoning?: string;
  /**
   * Anthropic thinking 块签名（S4b，task 08-25 design §5.1/§5.2）——与 reasoning 同位
   * 落终帧 assistantMsg（SessionMessage.reasoningSignature），多轮回传时原样复用。
   * additive optional：非 Anthropic 路径恒 undefined。
   */
  reasoningSignature?: string;
  /**
   * S4a（task 08-25 design §4.2）：usage 接收面——generate 返回 usage.promptTokens 时驱动
   * token 校准环（updateCalibrationRatio，此前零调用方，spec context-management.md:26 的
   * 设计意图落地）。additive optional：不返回 usage 的 generate 照旧（校准不触发）。
   * S4b 起 ipc-provider GenerateResult 已透出 usage——生产路径（shell seam 回 usage 的
   * 协议层双路径）自此自动激活。
   */
  usage?: GenerateTextUsage;
  /**
   * 09-12 子2 fallback chains（design §7.2）：实际服务模型（网关环成功注记）。只在档位
   * 配了链时携带——runLoop 据此盖终帧 assistantMsg.generatedBy（UI 终态徽标「实际模型
   * B · 回退自 A」的数据源）。additive：无链路径 undefined 零行为变化。
   */
  modelRef?: { keyId: string; modelId: string };
  /** 仅发生过回退时携带（≥1 条逐家失败记录，落 generatedBy.fallbackFrom）。 */
  fallbackTrace?: Array<{ keyId: string; modelId: string; reason: string }>;
}

export interface LoopOptions {
  sessionId: string;
  projectPath: string;
  messages: SessionMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  maxSteps: number;
  /**
   * dogfood T1 Stage 2（design §3.1）：第 6 参 onDelta（provider 原生 GenerationDelta）非空时
   * 该次调用走 shell 缝的流式路径。runLoop 在 emitDelta 存在时为每次 generate 预分配
   * assistantId 并包装 onDelta（累积缓冲 + 发射 delta 事件）；既有 5 参 lambda 忽略第 6 参
   * 照旧编译（additive）。
   */
  generate: (
    messages: SessionMessage[],
    system: string,
    tools: ToolDefinition[],
    abort: AbortSignal,
    cacheConfig?: CacheConfig,
    onDelta?: (d: GenerationDelta) => void,
    /**
     * 09-12 子5 CR-1：调用面标签透传——runLoop 车道内压缩摘要调用（summarizationGenerate）
     * 恒携 { taskType: 'context-summary' }（与链段 gate 摘要同族——流程标签非档位词，
     * mirror agent-loop gateSummarizationGenerate）。装配闭包（workflow leader 车道）以
     * `callOpts?.taskType ?? '<车道档>'` 转发进 generateImpl opts；不声明本参的既有闭包
     * （child/skill 等少参形态）天然忽略（additive，零回归）。缺省 undefined = 主调用形态。
     */
    callOpts?: { taskType?: string },
  ) => Promise<LoopGenerateResult>;
  onMessage?: (msg: SessionMessage) => void;
  abort: AbortSignal;
  skillExecutor?: SkillExecutorRef;
  spawnDepth?: number;
  emitChildEvent?: (event: ChildStreamEvent) => void;
  /**
   * dogfood T1 Stage 2（design §3.1）：delta 事件发射钩子——leader 流式对话（sendEvent delta
   * 变体）/ 有 emitChildEvent 通道的子 agent（child 包装内事件）由 caller 注入。缺省不开流
   * （sendMessage 车道 / 无 UI 消费者零回归）。事件 messageId = 预分配 assistantId，终帧
   * assistantMsg 同 id。
   */
  emitDelta?: (event: StreamDeltaData) => void;
  /**
   * dogfood T1 Stage 6（design §4）：链事件通道（chain-delta / chain-node-done）——透传进
   * ToolContext.emitChainEvent（write_chapter 等工具转发给 runChapterChain）。与 emitChildEvent
   * 同模式（streamMessage 装配 sendEvent 包装注入）。缺省不开（零回归）。
   */
  emitChainEvent?: (event: ChainStreamEvent) => void;
  emitConfirmation?: (pending: import('../types').PendingConfirmationState) => void;
  permissionMode?: SessionPermissionMode;
  /**
   * Story 3.3 线 D：leader behavior mode（normal/discuss/plan）。runLoop 在 break 分支（leader 停下）
   * 仅 plan/discuss 模式校验「调过 present_result 收尾工具没」——没调则打回重跑限 1 次。normal/auto 不强制。
   * 缺省 normal（不强制，向后兼容）。
   */
  behaviorMode?: AgentBehaviorMode;
  contextState?: ContextState;
  pinnedContext?: PinnedContextItem[];
  /**
   * S4a（task 08-25 design §4.1）：上下文窗口 token 数——每次 send 装配时按当前模型 limits
   * 现读注入（支持会话中途换模型窗口跟随；participationGear 同层先例）。缺省回落 1M
   * （CONTEXT_WINDOW）。本批只做 agent 侧接收面，shell 侧注入由后续批接线。
   */
  contextWindowTokens?: number;
  /**
   * S4a：压缩红线百分比（50~100 clamp，缺省 95——用户拍板的行为变化：未到红线不压、
   * 顶满语义；S4 前为固定 0.75 触发线）。与 contextWindowTokens 同批同链注入。
   */
  redlinePercent?: number;
  /**
   * CR-008（08-25 BMad CR）：当前车道模型的思考 kind（send 装配时按 dialogue 档 assignment
   * 经 registry 推导注入）——`THINKING_PROFILES[kind].reasoningRoundTrip === 'required'` 档
   * （kimi-k3 / deepseek-v4 族）时溢出兜底 hardCut 的保尾不得低于保底区段（近段 reasoning
   * 完整保留，厂商硬回传义务防 400）。undefined = 现行为。透传给 prepareContext 同消费。
   */
  thinkingKind?: ThinkingKind;
  onContextStateUpdate?: (state: ContextState) => void;
  onCompaction?: (compactedCount: number) => void;
  /**
   * 09-12 子5 R6（design §11）：leader 上下文占用快照发射钩子——每步 prepareContext 落定
   * （含压缩对齐）后回调一次。usedTokens = loadTokens × 校准比（口径与压缩触发同源）；
   * windowTokens 携带注入原值（contextWindowTokens 未注入 → null——不用 1M 缺省充数）；
   * redlinePercent = clamp 后生效红线。agent 侧不判等（UI dispatcher 值等跳写）；每步一发，
   **不**在循环里每 delta 发。缺省不开发射（child/链节点/非流式车道零回归）。载荷单源
   * ContextUsageEventData——与 UI 侧 AgentStreamEvent 占位变体逐字段同型。
   */
  onContextUsage?: (data: ContextUsageEventData) => void;
}

export async function runLoop(opts: LoopOptions): Promise<SessionMessage[]> {
  const { systemPrompt, tools, maxSteps, generate, onMessage, abort } = opts;
  const result: SessionMessage[] = [];
  let steps = 0;
  let contextState = opts.contextState ?? createDefaultContextState();
  let consecutiveLengthHits = 0;
  let consecutiveToolErrors = 0;
  // Story 3.3 线 D：present_result 收尾工具的 turn 级状态。turn 内（整个 runLoop 调用）只要调过
  // present_result 即算「已声明」；break 分支校验 plan/discuss 模式下是否声明过。
  // dogfood T1 #32B：kind 盖章已前移到 assistantMsg 构造点（arguments 直读，见下方），本状态
  // 仅供打回门判定 calledPresentResult；awaiting 后置 metadata 检测不再消费。
  let calledPresentResult = false;
  let restateRetryCount = 0;
  const MAX_RESTATE_RETRIES = 1;
  const initialActiveSkill = await resolveLatestActiveSkillMetadata(opts, readLatestActiveSkillMetadata(opts.messages));
  let activeSkillAllowedTools: string[] | undefined = initialActiveSkill?.allowedTools;
  let activeSkillPermission: SessionPermissionMode | undefined = initialActiveSkill?.permission;
  const MAX_CONSECUTIVE_TOOL_ERRORS = 3;
  // CR-008（08-25 BMad CR）：required 档（reasoningRoundTrip==='required'——kimi-k3 /
  // deepseek-v4 族）标记：溢出兜底 hardCut 保尾下限抬到保底区段（近段含 reasoning 的消息
  // 完整保留，厂商硬回传义务防 400）。
  const requiredRoundTrip = opts.thinkingKind !== undefined
    && THINKING_PROFILES[opts.thinkingKind].reasoningRoundTrip === 'required';

  // Snapshot the base messages at entry — `opts.messages` may be a live reference
  // to session.messages that gets mutated by onMessage → addMessage. We must NOT
  // re-read it on each iteration.
  let baseMessages: SessionMessage[] = [...opts.messages];

  // Build a summarization generate function that reuses the same model (no tools)
  const summarizationGenerate: SummarizationGenerateFn = async (msgs, system, abortSignal) => {
    // 09-12 子5 CR-1：压缩摘要恒标流程标签 'context-summary'（不随车道档位词归组——
    // 与链段摘要同族），经 seam 第 7 参透传、装配闭包转发；不转发的主调用闭包不受影响。
    const res = await generate(msgs, system, [], abortSignal, undefined, undefined, { taskType: CONTEXT_SUMMARY_TASK_TYPE });
    return { content: res.content };
  };

  while (steps < maxSteps) {
    throwIfAborted(abort);
    steps++;

    const visibleTools = filterToolsForPolicy({
      tools,
      sessionMode: opts.permissionMode,
      activeSkillAllowedTools,
      activeSkillPermission,
    });
    const effectiveSystemPrompt = appendToolDescriptions(systemPrompt, visibleTools);

    // --- Context management: check budget and compact if needed ---
    let allMessages = [...baseMessages, ...result];

    const prepared = await prepareContext({
      systemPrompt: effectiveSystemPrompt,
      messages: allMessages,
      contextState,
      pinnedContext: opts.pinnedContext,
      generate: summarizationGenerate,
      abort,
      // S4a：窗口/红线每轮经 options 现读透传（缺省 1M / 95%）。undefined 时不带字段
      //——prepareContext 防御归一回缺省，与不传 = 既有行为对齐。CR-008：thinkingKind 同链
      // 透传（required 档标记消费点在 prepareContext 升级路径）。
      ...(opts.contextWindowTokens !== undefined ? { contextWindowTokens: opts.contextWindowTokens } : {}),
      ...(opts.redlinePercent !== undefined ? { redlinePercent: opts.redlinePercent } : {}),
      ...(opts.thinkingKind !== undefined ? { thinkingKind: opts.thinkingKind } : {}),
    });

    if (prepared.compactionOccurred) {
      // After compaction, `prepared.messages` is the retained tail.
      // We need to replace both `baseMessages` and `result` with this new set
      // so that subsequent iterations only see the compacted view.
      // Split retained messages back: those from the original base vs those from result.
      const baseIds = new Set(baseMessages.map(m => m.id));
      const newBase = prepared.messages.filter(m => baseIds.has(m.id));
      const newResult = prepared.messages.filter(m => !baseIds.has(m.id));

      baseMessages = newBase;
      result.splice(0, result.length, ...newResult);
      allMessages = prepared.messages;
      contextState = prepared.contextState;
      opts.onContextStateUpdate?.(contextState);
      opts.onCompaction?.(prepared.compactedCount);
      logger.info({ compactedCount: prepared.compactedCount }, 'in-loop compaction applied');
    }

    // 09-12 子5 R6（design §11）：上下文占用快照发射——prepared context 出来就发（压缩分支
    // 已在上方对齐，loadTokens 为压缩后回落值）。值等跳写在 UI dispatcher（agent 侧不判等）；
    // 每步 prepareContext 一发，非每 delta。windowTokens 携带注入原值（未注入 → null）；
    // redlinePercent 与红线压缩触发同 clamp 生效值。
    // CR-5（09-12 子5 CR 批）：校准比读点守卫——复活会话 meta 缺字段（undefined）/NaN 时
    // 回退 1（Number.isFinite 全拦），防 usedTokens NaN% 毒 UI；下方校准环 EMA 输入同守卫
    // （EMA 对 NaN 无自愈，守卫后的有限输出经 onContextStateUpdate 回写即自愈缺字段会话）。
    // CR-10（09-12 子5 CR 批）：读外层 contextState 安全——prepareContext 全返回点不改
    // tokenCalibrationRatio（压缩分支 finalState 透传原值、早退路径原样返回 contextState），
    // 且本发射点在 generate 后的校准环更新之前，两值不可能分叉；若未来 prepareContext
    // 改 ratio，须换读 prepared.contextState 终态。
    const calibrationRatio = Number.isFinite(contextState.tokenCalibrationRatio)
      ? contextState.tokenCalibrationRatio
      : 1;
    opts.onContextUsage?.({
      usedTokens: Math.ceil(prepared.loadTokens * calibrationRatio),
      windowTokens: opts.contextWindowTokens ?? null,
      redlinePercent: clampRedlinePercent(opts.redlinePercent),
    });

    // CR-002（08-25 BMad CR）：let——溢出重试路径从更新后的 contextState 重建（见 catch 内）。
    let cacheConfig = prepared.cacheConfig;

    // dogfood T1 Stage 2（design §3.1）：预分配 assistantId——delta 事件与终帧 assistantMsg 同 id
    //（消除占位→终帧合并的 id 漂移）。emitDelta 缺省时 onGenerateDelta 为 undefined → generate
    // 收到不含 onDelta 的调用 = 既有非流式路径零回归（sendMessage 车道 / 无 UI 消费者）。
    const assistantId = randomUUID();
    const deltaBuffer: { text: string; reasoning: string } = { text: '', reasoning: '' };
    const onGenerateDelta = opts.emitDelta
      ? (d: GenerationDelta) => {
          if (d.type === 'text') deltaBuffer.text += d.delta;
          else if (d.type === 'reasoning') deltaBuffer.reasoning += d.delta;
          // R2 #30：tool 通道（工具参数流活性）只透传不缓冲——UI 侧渲染「正在准备
          // 工具调用」指示，终帧替换后自然消失。
          opts.emitDelta!({
            messageId: assistantId,
            channel: d.type,
            delta: d.delta,
            ...(d.type === 'tool' && d.toolName ? { toolName: d.toolName } : {}),
          });
        }
      : undefined;

    // dogfood T1 §3.3（R3 落点补缺）：abort / StreamInterruptedError 且已累积内容 → 部分落盘为
    // aborted_partial（**用预分配 assistantId**——UI 占位消息按同一 id 被终态替换，无 id 漂移），
    // 经 onMessage 走既有 addMessage 落盘管线（UI 已展示的部分重载后不消失）。全空缓冲照旧丢弃。
    // CR-T1-015：纯思考中断（text 空但 reasoning 已流）也落——content 空串占位、reasoning 保留，
    // 不把用户已看到的思考整体丢弃。CR-T1-019：整体包 try/catch——落盘管线（push/onMessage →
    // addMessage → appendFileSync）自身抛错只记 error 日志，不顶替原错误（abort/中断）上抛。
    const persistAbortedPartial = (interrupted?: { text: string; reasoning: string }): void => {
      try {
        const text = interrupted?.text ?? deltaBuffer.text;
        const reasoning = interrupted?.reasoning ?? deltaBuffer.reasoning;
        if (!text && !reasoning) return; // 全空缓冲照旧丢弃（Plain late text is discarded）
        const partialMsg: SessionMessage = {
          id: assistantId,
          role: 'assistant',
          content: text,
          ...(reasoning ? { reasoning } : {}),
          createdAt: Date.now(),
          kind: 'aborted_partial',
        };
        result.push(partialMsg);
        onMessage?.(partialMsg);
      } catch (persistErr) {
        logger.error(
          { err: persistErr instanceof Error ? persistErr.message : String(persistErr) },
          'runLoop: persistAbortedPartial failed (partial content not persisted; original error preserved)',
        );
      }
    };

    let response: LoopGenerateResult;
    try {
      response = await generate(
        allMessages,
        effectiveSystemPrompt,
        visibleTools,
        abort,
        cacheConfig,
        onGenerateDelta,
      );
    } catch (err) {
      // S4b（task 08-25 design §4.1 未知模型溢出 400 兜底）：协议层已把 context
      // length/window 族 4xx 标记为 ProtocolContextOverflowError（errors.ts 稳定
      // name + code）——agent 包不依赖 model-protocols（缝是注入的，mirror
      // readStreamInterrupted 的鸭子判定先例），按 name 识别（CR-004 起共享 helper
      // context/overflow.ts）。处置：一次确定性快压（hardCutForOverflow：CR-003 报文提取
      // 真实窗口 + CR-001 配对守卫 + 摘要窗口占比截断，零 LLM 依赖）后重试
      // 一次；再溢出走下方既有错误路径原样上抛（不无限压缩重试）。压缩同时回写 loop
      // 消息状态（mirror 下方 prepared.compactionOccurred 分支的 id 集对齐）——修的是
      // 「本 turn 的上下文」，下一轮 prepareContext 以压缩后状态续跑，不会每轮复溢。
      if (isContextOverflowSeamError(err)) {
        // CR-003/CR-004（08-25 BMad CR）：hardCut 预算窗口 = 400 报文提取值 ?? 注入窗口 ?? 1M
        //（共享 helper context/overflow.ts——makeAgentLoop 车道同款复用）；hardCut 自带
        // CR-001 配对守卫与 CR-008 required 档保底区段。
        const hardCut = hardCutForOverflow({
          err,
          messages: allMessages,
          existingSummary: contextState.compactedSummary,
          ...(opts.contextWindowTokens !== undefined ? { injectedWindowTokens: opts.contextWindowTokens } : {}),
          ...(requiredRoundTrip ? { reasoningRoundTripRequired: true } : {}),
        });
        const baseIds = new Set(baseMessages.map(m => m.id));
        baseMessages = hardCut.messages.filter(m => baseIds.has(m.id));
        result.splice(0, result.length, ...hardCut.messages.filter(m => !baseIds.has(m.id)));
        allMessages = hardCut.messages;
        contextState = {
          ...contextState,
          compactedSummary: hardCut.summary,
          compactionCount: contextState.compactionCount + 1,
          lastCompactionAt: Date.now(),
          totalCompactedMessages: contextState.totalCompactedMessages + hardCut.compactedCount,
        };
        opts.onContextStateUpdate?.(contextState);
        opts.onCompaction?.(hardCut.compactedCount);
        logger.warn(
          { compactedCount: hardCut.compactedCount, retained: hardCut.messages.length, windowTokens: hardCut.windowTokens },
          'runLoop: context overflow 400 → one deterministic hard-cut compaction, retrying generate once',
        );
        // CR-002（08-25 BMad CR）：重试 cacheConfig 从更新后的 contextState 重建——hardCut
        // 摘要已进 contextState.compactedSummary，沿用旧 cacheConfig 会让重试载荷带过期摘要
        //（切掉的中段静默丢失）；下方校准估算口径同步消费重建值。
        cacheConfig = {
          pinnedContent: cacheConfig.pinnedContent,
          compactedSummary: contextState.compactedSummary,
        };
        try {
          response = await generate(
            allMessages,
            effectiveSystemPrompt,
            visibleTools,
            abort,
            cacheConfig,
            onGenerateDelta,
          );
        } catch (retryErr) {
          if (isAbortErrorSignal(retryErr)) {
            persistAbortedPartial();
          } else {
            const interrupted = readStreamInterrupted(retryErr);
            if (interrupted) persistAbortedPartial(interrupted);
          }
          throw retryErr;
        }
        // 重试成功 → 落到下方既有 abort-with-response / 正常路径（不在此重复处理）。
      } else {
        // §3.3：仅 abort / StreamInterruptedError 走部分落盘；其他错误原样上抛（error 语义不变）。
        if (isAbortErrorSignal(err)) {
          persistAbortedPartial();
        } else {
          const interrupted = readStreamInterrupted(err);
          if (interrupted) persistAbortedPartial(interrupted);
        }
        throw err;
      }
    }

    // S4a（design §4.2）：校准环接线——generate 返回 usage.promptTokens 时用「本请求实际发出的
    // 估算」（system + pinned + summary + messages，与 prepareContext 触发判定同一口径）驱动 EMA
    // 校准（updateCalibrationRatio 首个生产调用方；系数 0.8/0.2 不动）。无 usage 的 generate 路径
    // 零行为变化。onContextStateUpdate 通知 caller 持久化（mirror 压缩回写路径）。
    if (typeof response.usage?.promptTokens === 'number' && response.usage.promptTokens > 0) {
      const estimatedPromptTokens =
        estimateTokens(effectiveSystemPrompt)
        + (cacheConfig.pinnedContent ? estimateTokens(cacheConfig.pinnedContent) : 0)
        + (cacheConfig.compactedSummary ? estimateTokens(cacheConfig.compactedSummary) : 0)
        + estimateMessagesTokens(allMessages);
      // CR-5（09-12 子5 CR 批）：EMA 输入守卫（同发射点）——缺字段/NaN 回退 1（EMA 对
      // NaN 无自愈：NaN×0.8+observed×0.2 恒 NaN），有限输出回写即自愈缺字段会话。
      const currentRatio = Number.isFinite(contextState.tokenCalibrationRatio)
        ? contextState.tokenCalibrationRatio
        : 1;
      const nextRatio = updateCalibrationRatio(
        currentRatio,
        response.usage.promptTokens,
        estimatedPromptTokens,
      );
      if (nextRatio !== contextState.tokenCalibrationRatio) {
        contextState = { ...contextState, tokenCalibrationRatio: nextRatio };
        opts.onContextStateUpdate?.(contextState);
      }
    }

    // A cancelled response with tool calls must still persist the assistant turn
    // and synthetic tool results as a valid pair. Plain late text is discarded —
    // 已流出的部分例外：保留为 aborted_partial（§3.3）。
    if (abort.aborted && !response.toolCalls?.length) {
      persistAbortedPartial();
      throwIfAborted(abort);
    }

    // Story 3.3 线 D：present_result 收尾校验（仅在 leader 停下分支 = 无 toolCalls，且 plan/discuss 模式）。
    // 必须在 push/onMessage assistantMsg 之前——若需打回，丢弃这条「没规范收尾的坏消息」（不 onMessage），
    // inject 提醒让 leader 重新生成规范的（调 present_result 收尾）。避用户看到两条重复。
    // normal/auto 模式不强制（behaviorMode 缺省 normal）。length 续写既有逻辑在下面原位保留。
    const isStopping = !response.toolCalls?.length;
    const isRestateSoftGateMode = opts.behaviorMode === 'plan' || opts.behaviorMode === 'discuss';
    if (
      isStopping
      && response.finishReason !== 'length'  // length 续写走原逻辑，不拦
      && isRestateSoftGateMode
      && !calledPresentResult
      && restateRetryCount < MAX_RESTATE_RETRIES
      && steps < maxSteps  // BMad CR Edge-004 fix：确保打回后还有步数重新 generate；末步 naked stop 不打回→放行（消息正常 onMessage 显示），避静默无回复 turn。
    ) {
      restateRetryCount++;
      // 丢弃坏 response（不 push 不 onMessage）+ inject 提醒 + 重新生成。
      const remindMsg: SessionMessage = {
        id: randomUUID(),
        role: 'user',
        content: '你停下来向用户呈现结果前，必须先调用 present_result 工具声明这次停是否在等用户确认意图（awaiting_intent_confirmation 参数）。请重新呈现并用 present_result 收尾。',
        createdAt: Date.now(),
      };
      result.push(remindMsg);
      // 提醒消息是给 leader 的内部指令，不 onMessage（不发 UI）——避免用户看到打回机制。
      continue;
    }

    // dogfood R2 #16：intent_restate 盖章删除——快捷按钮移除后零消费者。presentResultAwaiting
    // 检测随之退役；打回门（calledPresentResult，metadata 检测路径）不受影响。
    const assistantMsg: SessionMessage = {
      // dogfood T1 Stage 2（design §3.1）：预分配 id——delta 流与终帧同 id。
      id: assistantId,
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      createdAt: Date.now(),
      // dogfood T1 #27②：深度思考终帧聚合落消息（持久化 + assistant 事件透传）。
      reasoning: response.reasoning,
      // S4b（design §5.1/§5.2）：Anthropic thinking 块签名同位落消息——多轮回传时
      // messagesToPayload 原样复用（厂商校验签名，不得伪造）。
      reasoningSignature: response.reasoningSignature,
      // 09-12 子2 fallback chains（design §7.2）：终态标注实际模型——只在回退机械运行过
      //（档位配链，generate 回传 modelRef）时盖章；generatedBy additive optional，旧消息
      // 零迁移。fallbackFrom 仅发生过回退时携带（二态）。
      ...(response.modelRef
        ? {
            generatedBy: {
              keyId: response.modelRef.keyId,
              modelId: response.modelRef.modelId,
              ...(response.fallbackTrace?.length
                ? { fallbackFrom: response.fallbackTrace.map((t) => ({ keyId: t.keyId, modelId: t.modelId, reason: t.reason })) }
                : {}),
            },
          }
        : {}),
    };
    result.push(assistantMsg);
    onMessage?.(assistantMsg);

    if (!response.toolCalls?.length) {
      if (response.finishReason === 'length') {
        consecutiveLengthHits++;
        if (consecutiveLengthHits >= 3) break;
        const contMsg: SessionMessage = {
          id: randomUUID(),
          role: 'user',
          content: 'Continue from where you left off. Execute the next step using the appropriate tool.',
          createdAt: Date.now(),
        };
        result.push(contMsg);
        onMessage?.(contMsg);
        continue;
      }
      break;
    }
    consecutiveLengthHits = 0;

    // Execute tool calls in parallel
    const ctx: ToolContext = {
      sessionId: opts.sessionId,
      projectPath: opts.projectPath,
      abort,
      skillExecutor: opts.skillExecutor,
      spawnDepth: opts.spawnDepth ?? 0,
      emitChildEvent: opts.emitChildEvent,
      // dogfood T1 Stage 6：链事件透传（write_chapter → runChapterChain options.emitChainEvent）。
      emitChainEvent: opts.emitChainEvent,
      emitConfirmation: opts.emitConfirmation,
    };

    let terminal = false;

    if (abort.aborted) {
      for (const call of response.toolCalls) {
        const cancelOutput = 'Tool call cancelled: the run was stopped by the user before this tool executed.';
        const toolMsg: SessionMessage = {
          id: randomUUID(),
          role: 'tool',
          content: cancelOutput,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: cancelOutput }],
          createdAt: Date.now(),
        };
        result.push(toolMsg);
        onMessage?.(toolMsg);
      }
      throwIfAborted(abort);
    }

    const toolMessages = await Promise.all(response.toolCalls.map(async (call) => {
      try {
        assertToolAllowed({
          toolName: call.name,
          sessionMode: opts.permissionMode,
          activeSkillAllowedTools,
          activeSkillPermission,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: `Error: ${errMsg}`,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: `Error: ${errMsg}` }],
          createdAt: Date.now(),
        };
      }

      const tool = visibleTools.find(t => t.id === call.name);
      if (!tool) {
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: `Error: tool "${call.name}" not found`,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: `Error: tool "${call.name}" not found` }],
          createdAt: Date.now(),
        };
      }

      try {
        let params: any;
        try {
          params = JSON.parse(call.arguments);
        } catch {
          // 某些 provider（如 DashScope/Qwen）偶尔返回畸形 arguments，
          // 例如 "{}{"name":"story",...}" — 尝试提取最后一个有效 JSON 对象
          //（#32B 起与 kind 盖章点共用同一容错 parse，不二次实现）。
          params = parseToolCallArguments(call.arguments);
          // 修正存储的 arguments，防止畸形字符串进入会话历史导致后续 JSON.parse 报错
          call.arguments = JSON.stringify(params);
        }
        // 兼容某些 provider 将参数作为 JSON 字符串嵌套传入的情况
        if (typeof params === 'string') {
          try { params = JSON.parse(params); } catch { /* 保持原样 */ }
        }
        // CR-001（8.5 BMad CR）：autoApply 自审闸门。LLM 首次带 autoApply:true 调 diff 工具 →
        // 拦截不执行（无 IPC），合成闸门消息（重读当前数据自审后带 selfReviewConfirmed:true 重发）。
        // 本处是 LLM 工具调用的唯一派发 seam（leader/子 agent/Director/skill 内 LLM 节点全经
        // runLoop）；链上节点程序化 registry.execute 直调不经此（调用来源判据，见 toolPolicy 注释）。
        // 非 Error 前缀——不进连续 tool 错误计数（闸门是流程提示非失败）。
        //
        // CR-002（8.6 BMad CR）：档位强制在闸门**之前**——有效档位（session 与 active skill 取严）
        // 非 auto 时 diff 工具的 autoApply 一律视为 false（strip 后再派发）：suggest 档恒走 patch
        // 人审（首发 autoApply:true + selfReviewConfirmed:true 同发也绕不过）；故 suggest 档闸门
        // 不再触发（autoApply 已 false），闸门实际只在 auto 档拦「首发未自审」。程序化直调不经此。
        const enforcedParams = enforceAutoApplyTier(call.name, params, opts.permissionMode, activeSkillPermission);
        if (enforcedParams !== params) {
          logger.info({ tool: call.name, mode: opts.permissionMode ?? 'suggest' }, 'autoApply tier enforcement: non-auto mode, autoApply forced to false (CR-002)');
          params = enforcedParams;
        }
        if (shouldGateAutoApply(call.name, params)) {
          logger.info({ tool: call.name }, 'autoApply self-review gate: intercepted, awaiting selfReviewConfirmed resend');
          return {
            id: randomUUID(),
            role: 'tool' as const,
            content: AUTO_APPLY_SELF_REVIEW_MESSAGE,
            toolResults: [{
              toolCallId: call.id,
              toolName: call.name,
              output: AUTO_APPLY_SELF_REVIEW_MESSAGE,
            }],
            createdAt: Date.now(),
          };
        }
        const toolResult = await tool.execute(params, ctx);
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: toolResult.output,
          toolResults: [{
            toolCallId: call.id,
            toolName: call.name,
            output: toolResult.output,
            metadata: toolResult.metadata,
          }],
          createdAt: Date.now(),
          _terminal: toolResult.terminal,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ tool: call.name, err: errMsg }, 'tool execution failed');
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: `Error: ${errMsg}`,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: `Error: ${errMsg}` }],
          createdAt: Date.now(),
        };
      }
    }));

    // dogfood R2 findings #4（A 层·loop 顺序修复）：abort 检查移到工具消息入栈**之后**——abort
    // 落在工具执行窗内时（Promise.all 已 resolve、abort 旗已竖），已完成 / 已优雅降级（dispatch 族）
    // 的工具结果先经 onMessage（addMessage 落盘线）持久化，与盘上 assistant(toolCalls) 配成完整对，
    // 随后再抛 AbortError 终止本轮。此前 throwIfAborted 在入栈循环之前：先抛后落盘 → tool 消息全丢
    // → 盘上悬空 toolCall，该会话后续每条组货请求都在 ai-sdk 客户端校验点炸
    // AI_MissingToolResultsError（请求不出门，会话不可用）。下方 allErrors/terminal 逻辑保持在
    // throw 之后不受影响（throw 中断本轮）；上方「执行前 abort → cancel stub」分支是另一个窗口，
    // 不动。组货层兜底（救活已疤会话）见 ipc-provider messagesToPayload 的悬空 toolCall stub。
    for (const msg of toolMessages) {
      const { _terminal, ...toolMsg } = msg as any;
      result.push(toolMsg);
      onMessage?.(toolMsg);
      if (_terminal) terminal = true;
      for (const toolResult of toolMsg.toolResults ?? []) {
        const nextActiveSkill = readActiveSkillMetadata(toolResult.metadata);
        if (nextActiveSkill) {
          activeSkillAllowedTools = nextActiveSkill.allowedTools;
          activeSkillPermission = nextActiveSkill.permission;
        }
        // Story 3.3 线 D：检测 present_result 收尾工具——记 turn 级 calledPresentResult 供打回门
        //（present-result.ts metadata.presentResult）。#32B 起 awaiting 由 kind 盖章点直读 arguments，
        // 后置 metadata 不再消费。
        const presentMeta = (toolResult.metadata as { presentResult?: { awaitingIntentConfirmation?: boolean } } | undefined)?.presentResult;
        if (presentMeta) {
          calledPresentResult = true;
        }
      }
    }
    // findings #4：工具消息已全部入栈落盘（上方循环），此处再查 abort——abort 时本轮到此终止，
    // 不再进入连续错误 / terminal 判定（与既有「本轮中断」语义一致，只是不再丢弃已落盘配对）。
    throwIfAborted(abort);

    // 检测连续 tool 错误：所有 tool 结果都是 Error 开头则计数
    const allErrors = toolMessages.every((m: any) => m.content?.startsWith('Error:'));
    if (allErrors) {
      consecutiveToolErrors++;
      if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
        logger.warn('too many consecutive tool errors, breaking loop');
        break;
      }
    } else {
      consecutiveToolErrors = 0;
    }

    // 本轮存在 terminal 工具（如 skill）：它已直接对用户说完话，
    // 不再让模型基于同样的 tool 结果生成一段重复收尾，直接结束本次运行。
    if (terminal) {
      break;
    }
  }

  return result;
}

async function resolveLatestActiveSkillMetadata(opts: LoopOptions, metadata: ActiveSkillMetadata | undefined): Promise<ActiveSkillMetadata | undefined> {
  if (!metadata?.name || !opts.skillExecutor?.loadSkill) {
    return metadata;
  }
  const skill = await opts.skillExecutor.loadSkill(opts.sessionId, metadata.name);
  if (!skill) {
    return undefined;
  }
  return {
    name: skill.name,
    allowedTools: skill.allowedTools,
    permission: skill.permission,
  };
}

function readLatestActiveSkillMetadata(messages: SessionMessage[]): ActiveSkillMetadata | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'tool') continue;
    for (let resultIndex = (message.toolResults?.length ?? 0) - 1; resultIndex >= 0; resultIndex -= 1) {
      const activeSkill = readActiveSkillMetadata(message.toolResults?.[resultIndex]?.metadata);
      if (activeSkill) return activeSkill;
    }
  }
  return undefined;
}

function readActiveSkillMetadata(metadata: Record<string, unknown> | undefined): ActiveSkillMetadata | undefined {
  const activeSkill = metadata?.activeSkill;
  if (!activeSkill || typeof activeSkill !== 'object') return undefined;
  const name = (activeSkill as { name?: unknown }).name;
  const allowedTools = (activeSkill as { allowedTools?: unknown }).allowedTools;
  const permission = (activeSkill as { permission?: unknown }).permission;
  const normalizedPermission = permission === 'readonly' || permission === 'suggest' || permission === 'auto'
    ? permission
    : undefined;
  return {
    allowedTools: Array.isArray(allowedTools)
      ? allowedTools.filter((tool): tool is string => typeof tool === 'string')
      : undefined,
    name: typeof name === 'string' ? name : undefined,
    permission: normalizedPermission,
  };
}

function throwIfAborted(abort: AbortSignal): void {
  if (abort.aborted) {
    throw abort.reason instanceof DOMException
      ? abort.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

/** AbortError 判定（mirror agentIpc.isAbortError——loop 侧 abort 部分落盘分流用）。 */
function isAbortErrorSignal(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError';
}

/**
 * dogfood T1 §3.3：StreamInterruptedError 鸭子判定——agent 包不依赖 model-protocols（缝是注入的），
 * 错误跨缝穿过来按 name + accumulatedText/accumulatedReasoning 字段识别（r2/r6 形态）。
 */
function readStreamInterrupted(err: unknown): { text: string; reasoning: string } | undefined {
  if (!(err instanceof Error) || err.name !== 'StreamInterruptedError') return undefined;
  const carried = err as { accumulatedText?: unknown; accumulatedReasoning?: unknown };
  return {
    text: typeof carried.accumulatedText === 'string' ? carried.accumulatedText : '',
    reasoning: typeof carried.accumulatedReasoning === 'string' ? carried.accumulatedReasoning : '',
  };
}

/**
 * 工具 arguments 容错解析（#32B 起为 kind 盖章点与工具执行路径共用实现）：直接 JSON.parse 失败 →
 * lastBrace 截取最后一个有效 JSON 对象（DashScope/Qwen 畸形形态）→ 参数被嵌套成 JSON 字符串时解包。
 * 彻底失败回 {}。返回值可能非对象（原始字符串/数字等）——消费方按属性访问自然得 undefined。
 */
function parseToolCallArguments(raw: string): Record<string, unknown> {
  let params: unknown;
  try {
    params = JSON.parse(raw);
  } catch {
    const lastBrace = raw.lastIndexOf('{');
    if (lastBrace > 0) {
      try {
        params = JSON.parse(raw.slice(lastBrace));
      } catch {
        params = {};
      }
    } else {
      params = {};
    }
  }
  if (typeof params === 'string') {
    try { params = JSON.parse(params); } catch { /* 保持原样 */ }
  }
  return (params ?? {}) as Record<string, unknown>;
}
