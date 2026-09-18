import type { SessionMessage } from '../types';
import type { ThinkingKind } from '@orison/shared-contracts';
import { THINKING_PROFILES } from '@orison/shared-contracts';
import type { PinnedContextItem } from './pinnedContext';
import type { SummarizationGenerateFn, CompactionResult } from './summarizer';
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldTriggerCompaction,
  isProjectionOverflow,
  resolveContextWindowTokens,
  clampRedlinePercent,
  COMPACTION_TARGET_RATIO,
} from './tokenEstimator';
import { renderPinnedContext, estimatePinnedTokens } from './pinnedContext';
import { compactWithSummarization } from './summarizer';
import { logger } from '../logger';

export interface ContextState {
  compactedSummary?: string;
  compactionCount: number;
  lastCompactionAt?: number;
  totalCompactedMessages: number;
  tokenCalibrationRatio: number;
  /**
   * system 稳定化（09-12）：最近一次追加的 session_state_note 注记内容 sha256——
   * turn 开始快照 hash 与此一致则不追加（幂等门）。additive optional：旧会话 / fork
   * 会话 undefined → 首轮必发全量注记。经 session meta 持久化通道落盘，重启幂等。
   */
  lastSessionStateNoteHash?: string;
}

export function createDefaultContextState(): ContextState {
  return {
    compactionCount: 0,
    totalCompactedMessages: 0,
    tokenCalibrationRatio: 1.0,
  };
}

export interface ContextManagerInput {
  systemPrompt: string;
  messages: SessionMessage[];
  contextState: ContextState;
  pinnedContext?: PinnedContextItem[];
  generate: SummarizationGenerateFn;
  abort: AbortSignal;
  /**
   * S4a（task 08-25 design §4.1）：上下文窗口 token 数——shell 按 send 装配时按当前模型
   * limits 现读注入（LoopOptions 链，支持会话中途换模型窗口跟随）。缺省回落 1M；无效值
   * 同缺省（resolveContextWindowTokens 防御归一）。不传 = 既有 1M 行为。
   */
  contextWindowTokens?: number;
  /**
   * S4a：红线百分比（50~100 clamp，缺省 95——用户拍板的行为变化：S4 前固定 0.75 触发线，
   * 现默认「未到红线不压，顶满语义」）。
   */
  redlinePercent?: number;
  /**
   * CR-008（08-25 BMad CR）：当前车道模型的思考能力 kind（send 装配时按 dialogue 档
   * assignment 经 registry 推导注入）——`THINKING_PROFILES[kind].reasoningRoundTrip ===
   * 'required'` 档（kimi-k3 / deepseek-v4 族）时压缩升级路径（硬截断）的保尾不得低于
   * 保底区段（近段含 reasoning 的消息完整保留在 retained，厂商硬回传义务防 400——不再靠
   * 「preserveRecent 恰好 6」巧合）。undefined = 无 required 义务（现行为）。
   */
  thinkingKind?: ThinkingKind;
}

export interface PreparedContext {
  messages: SessionMessage[];
  contextState: ContextState;
  compactionOccurred: boolean;
  compactedCount: number;
  cacheConfig: CacheConfig;
  /**
   * 09-12 子5 R6（design §11）：本步实际装载量（system + pinned + summary + messages
   * 四段相加口径——与红线/顶满判定同一次计算，只读携带不改判定）。压缩/硬截断后按
   * finalMessages/finalSummary 重算（未压缩时恒等 totalTokens）——消费方（runLoop
   * onContextUsage × 校准比）拿到的即「即将发出的载荷量」。additive required：唯一
   * 生产者本函数，全返回点携带。
   */
  loadTokens: number;
}

export interface CacheConfig {
  pinnedContent?: string;
  compactedSummary?: string;
}

/** 硬截断保尾条数（compactConversation 现成语义，design §4.1「保尾 2」）。 */
const HARD_CUT_PRESERVE_LAST = 2;

/** LLM 压缩保尾条数（机制常量，summarizer 调用位与这里同源）。 */
export const COMPACTION_PRESERVE_RECENT = 6;

/**
 * CR-008（08-25 BMad CR）：reasoningRoundTrip==='required' 档硬截断的保尾下限 = LLM 压缩
 * 保底区段同宽——硬截断（升级路径）不得把 LLM 路径完整保留的近段 reasoning 消息再切掉
 *（kimi-k3 / deepseek-v4 族厂商硬回传义务，漏了 400；此前保尾 2 < 6 靠巧合不违）。
 */
export const REASONING_ROUNDTRIP_PRESERVE_FLOOR = COMPACTION_PRESERVE_RECENT;

/** 硬截断合并摘要的预算占窗口比（防确定性 join 本身撑爆窗口——被压内容搬进摘要不是解压）。 */
const HARD_CUT_SUMMARY_WINDOW_SHARE = 0.25;

/**
 * S4a 三触发第③级的明确报错（design §4.1：硬截断后仍塞不下**不静默**）。消息含当前
 * 估算/窗口/预留值，提示手动压缩或换大窗口模型——比「请求打到厂商吃 400」更可操作。
 */
export class ContextWindowOverflowError extends Error {
  readonly estimatedTokens: number;
  readonly windowTokens: number;

  constructor(detail: { estimatedTokens: number; windowTokens: number; redlinePercent: number }) {
    super(
      `上下文超出模型窗口：硬截断后仍塞不下（估算 ${detail.estimatedTokens} tokens + 回复预留 ` +
        `> 窗口 ${detail.windowTokens} tokens，红线 ${detail.redlinePercent}%）。` +
        '请手动压缩该会话上下文，或换更大上下文窗口的模型。',
    );
    this.name = 'ContextWindowOverflowError';
    this.estimatedTokens = detail.estimatedTokens;
    this.windowTokens = detail.windowTokens;
  }
}

/**
 * S4a 硬截断兜底（design §4.1「压完仍塞不下」）：确定性保尾切分 + 既有摘要合并 + 窗口占比
 * 预算截断。供 prepareContext（三触发第③级第二段）/ runLoop 溢出重试（context/overflow.ts
 * hardCutForOverflow）/ makeAgentLoop pre-gate（LLM 压缩失败的退化路径）三调用点共用——
 * 确定性、零 LLM 依赖。
 *
 * CR-001（08-25 BMad CR）配对守卫：保尾切分不得拆散 tool 消息配对——
 * - 尾段不得以孤儿 tool 开头（其 assistant(toolCalls) 落在压缩侧）：切点向前收紧含其
 *   assistant（mirror summarizer.ts splitIndex 回退）；
 * - 尾段末尾的 dangling assistant(toolCalls)（无后续 tool 回填——中断/半写历史形态）并入
 *   压缩侧：留在尾段会让下一请求带着未回填的 toolCalls 发出（OpenAI 族 400）。
 * 此前委托 compactConversation 盲切（保尾 2 恰好切出 `[tool,user]` 孤儿），守卫在此单点修，
 * 三调用点一并受益（legacy compactConversation 的 continuation 快照语义不动）。
 *
 * CR-008（08-25 BMad CR）：`reasoningRoundTripRequired` 时保尾下限抬到保底区段
 * （REASONING_ROUNDTRIP_PRESERVE_FLOOR）——required 档近段含 reasoning 的消息完整保留。
 */
export function compactConversationHardCut(input: {
  messages: SessionMessage[];
  existingSummary?: string;
  contextWindowTokens: number;
  preserveLast?: number;
  reasoningRoundTripRequired?: boolean;
}): { messages: SessionMessage[]; summary: string; compactedCount: number } {
  const messages = input.messages;
  // CR-008：required 档保尾下限 = 保底区段（显式 preserveLast 与下限取大——显式值更小不破防）。
  const preserveLastWanted = input.reasoningRoundTripRequired === true
    ? Math.max(input.preserveLast ?? HARD_CUT_PRESERVE_LAST, REASONING_ROUNDTRIP_PRESERVE_FLOOR)
    : input.preserveLast ?? HARD_CUT_PRESERVE_LAST;
  const preserveLast = Math.max(0, Math.min(preserveLastWanted, messages.length));

  // CR-001 前侧守卫：切点落在 assistant(toolCalls) 与其 tool 结果之间（尾段以孤儿 tool 开头）
  // 时向前收紧到配对 assistant。
  let splitIndex = messages.length - preserveLast;
  while (splitIndex > 0 && messages[splitIndex]?.role === 'tool') {
    splitIndex--;
  }
  const tailRaw = messages.slice(splitIndex);

  // CR-001 后侧守卫：尾段末尾的 dangling assistant(toolCalls) 并入压缩侧（至少保 1 条防空尾）。
  let trimCount = 0;
  while (
    trimCount < tailRaw.length - 1
    && tailRaw[tailRaw.length - 1 - trimCount].role === 'assistant'
    && (tailRaw[tailRaw.length - 1 - trimCount].toolCalls?.length ?? 0) > 0
  ) {
    trimCount++;
  }
  const tail = trimCount > 0 ? tailRaw.slice(0, tailRaw.length - trimCount) : tailRaw;
  // 压缩侧 = 切点前全量 + 被并入守卫移出尾段的尾部消息（时序保持——被并入的在最后）。
  const summarized = trimCount > 0
    ? [...messages.slice(0, splitIndex), ...tailRaw.slice(tailRaw.length - trimCount)]
    : messages.slice(0, splitIndex);
  // role:content join（mirror compactConversation 的确定性 join 形态——切分逻辑 CR-001 起
  // 自带配对守卫，不再委托盲切）。
  const joined = summarized.map((m) => `${m.role}: ${m.content}`).join('\n');
  const merged = [input.existingSummary?.trim(), joined].filter(Boolean).join('\n\n');
  // 预算 = 窗口 25% × 3.5 字符/token（mirror estimateTokens 启发式）；超限保头尾去中段。
  const maxChars = Math.floor(input.contextWindowTokens * HARD_CUT_SUMMARY_WINDOW_SHARE * 3.5);
  let summary = merged;
  if (merged.length > maxChars && maxChars > 0) {
    const head = Math.floor(maxChars * 0.6);
    const tailChars = Math.floor(maxChars * 0.3);
    summary = `${merged.slice(0, head)}\n[... 硬截断摘要中段省略（${merged.length} 字符 → ${maxChars} 预算）...]\n${merged.slice(-tailChars)}`;
  }
  return {
    messages: tail,
    summary,
    compactedCount: Math.max(0, messages.length - tail.length),
  };
}

/**
 * Main entry point: checks token budget, triggers compaction if needed,
 * and assembles the cache configuration for the provider layer.
 *
 * S4a 三触发（task 08-25 design §4.1，用户拍板 4/6/7 + D 块）：
 * ① 手动——不经本函数（workflow.manualCompactSession 门面直接 compactWithSummarization）；
 * ② 红线——校准后估算 ≥ 窗口 × redlinePercent（缺省 95%）→ LLM 压缩；
 * ③ 顶满——投影溢出（估算 + 保守回复预留 > 窗口）强制压缩；压后仍溢出 →
 *    compactConversation 硬截断（保尾 2）→ 仍溢出抛 ContextWindowOverflowError（不静默）。
 * 压缩目标（窗口 × 50%）/保尾 6/三级兜底（summarizer.ts）机制不变，只换触发条件与窗口来源。
 */
export async function prepareContext(input: ContextManagerInput): Promise<PreparedContext> {
  const { systemPrompt, messages, contextState, pinnedContext, generate, abort } = input;
  const windowTokens = resolveContextWindowTokens(input.contextWindowTokens);
  const redlinePercent = clampRedlinePercent(input.redlinePercent);
  // CR-008（08-25 BMad CR）：required 档（THINKING_PROFILES[kind].reasoningRoundTrip ===
  // 'required'——kimi-k3 / deepseek-v4 族）标记：硬截断升级路径保尾下限抬到保底区段
  //（近段含 reasoning 的消息完整保留在 retained，厂商硬回传义务防 400）。
  const requiredRoundTrip = input.thinkingKind !== undefined
    && THINKING_PROFILES[input.thinkingKind].reasoningRoundTrip === 'required';

  const systemTokens = estimateTokens(systemPrompt);
  const pinnedTokens = estimatePinnedTokens(pinnedContext ?? []);
  const summaryTokens = estimateTokens(contextState.compactedSummary ?? '');
  const messagesTokens = estimateMessagesTokens(messages);
  const totalTokens = systemTokens + pinnedTokens + summaryTokens + messagesTokens;

  const pinnedContent = renderPinnedContext(pinnedContext ?? []);

  let finalMessages = messages;
  let finalSummary: string | undefined = contextState.compactedSummary;
  let compactionOccurred = false;
  let compactedCount = 0;

  // 三触发判定：② 红线（估算到达窗口百分比）/ ③ 投影溢出（估算+预留超窗口，顶满强制）。
  // 两者独立判定——红线未到但投影已溢出同样必须压（红线设 100 也由 ③ 兜住）。
  const overheadTokens = systemTokens + pinnedTokens + summaryTokens;
  const redlineHit = shouldTriggerCompaction(
    overheadTokens,
    messagesTokens,
    contextState.tokenCalibrationRatio,
    windowTokens,
    redlinePercent,
  );
  const projectionOverflow = isProjectionOverflow(totalTokens, contextState.tokenCalibrationRatio, windowTokens);

  if (redlineHit || projectionOverflow) {
    logger.info(
      {
        totalTokens,
        messagesCount: messages.length,
        calibration: contextState.tokenCalibrationRatio,
        windowTokens,
        redlinePercent,
        redlineHit,
        projectionOverflow,
      },
      'context budget exceeded, triggering compaction',
    );

    let result: CompactionResult;
    try {
      result = await compactWithSummarization(messages, {
        // 压缩目标随窗口参数化（窗口 × 50%——目标机制本身不变，只换窗口来源）。
        targetTokens: Math.max(0, Math.floor(windowTokens * COMPACTION_TARGET_RATIO) - systemTokens - pinnedTokens),
        preserveRecent: COMPACTION_PRESERVE_RECENT,
        pinnedContext,
        existingSummary: contextState.compactedSummary,
        generate,
        abort,
      });
    } catch (err) {
      // Re-throw abort errors — they are not compaction failures
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      logger.error({ err }, 'compaction failed, proceeding with full context');
      return {
        messages,
        contextState,
        compactionOccurred: false,
        compactedCount: 0,
        loadTokens: totalTokens,
        cacheConfig: {
          pinnedContent: pinnedContent || undefined,
          compactedSummary: contextState.compactedSummary,
        },
      };
    }

    // CR-013（08-25 BMad CR）空转防御①：红线到线但无可压内容（对话 ≤ 保尾区 →
    // compactedCount 0）且非投影溢出路径——跳过状态改写（compactionCount 不空涨、
    // lastCompactionAt 不动、compactionOccurred=false 不触发调用方 onCompaction/消息重建）。
    // system+pinned+summary 自身过线的稳态由此停住（此前每轮空转改写状态）。
    if (result.compactedCount === 0 && !projectionOverflow) {
      return {
        messages,
        contextState,
        compactionOccurred: false,
        compactedCount: 0,
        loadTokens: totalTokens,
        cacheConfig: {
          pinnedContent: pinnedContent || undefined,
          compactedSummary: contextState.compactedSummary,
        },
      };
    }

    finalMessages = result.retainedMessages;
    finalSummary = result.summary;
    compactionOccurred = true;
    compactedCount = result.compactedCount;

    // ③ 顶满的第二/三段：LLM 压缩后投影仍溢出 → compactConversation 硬截断 → 仍溢出明确报错。
    // 只在投影溢出路径升级（红线是软目标：压后仍超红线但塞得下则不硬截断）。
    if (projectionOverflow) {
      const afterTokens = systemTokens + pinnedTokens + estimateTokens(finalSummary) + estimateMessagesTokens(finalMessages);
      if (isProjectionOverflow(afterTokens, contextState.tokenCalibrationRatio, windowTokens)) {
        const hardCut = compactConversationHardCut({
          messages: finalMessages,
          existingSummary: finalSummary,
          contextWindowTokens: windowTokens,
          ...(requiredRoundTrip ? { reasoningRoundTripRequired: true } : {}),
        });
        finalMessages = hardCut.messages;
        finalSummary = hardCut.summary;
        compactedCount = messages.length - finalMessages.length;
        logger.warn(
          { retained: finalMessages.length, summaryChars: finalSummary.length, windowTokens },
          'post-compaction still over window, hard-cut applied (compactConversation tail-preserving)',
        );

        const hardAfterTokens = systemTokens + pinnedTokens + estimateTokens(finalSummary) + estimateMessagesTokens(finalMessages);
        if (isProjectionOverflow(hardAfterTokens, contextState.tokenCalibrationRatio, windowTokens)) {
          throw new ContextWindowOverflowError({
            estimatedTokens: Math.ceil(hardAfterTokens * contextState.tokenCalibrationRatio),
            windowTokens,
            redlinePercent,
          });
        }
      }
    }

    logger.info(
      { savedTokens: result.estimatedSavedTokens, compactedCount, retained: finalMessages.length },
      'compaction complete',
    );
  }

  // spread 打头保留 additive 字段（lastSessionStateNoteHash——注记幂等门；mirror loop.ts
  // hardCut 的 spread 形态）：整体枚举字段重建会丢 hash → 压缩后同快照重发注记（注记在
  // 消息尾，preserveRecent 保尾必存活 → 流里出现重复注记，违反幂等门语义）。
  const finalState: ContextState = compactionOccurred
    ? {
        ...contextState,
        compactedSummary: finalSummary,
        compactionCount: contextState.compactionCount + 1,
        lastCompactionAt: Date.now(),
        totalCompactedMessages: contextState.totalCompactedMessages + compactedCount,
        tokenCalibrationRatio: contextState.tokenCalibrationRatio,
      }
    : contextState;

  // 09-12 子5 R6（design §11）：本步实际装载量（final 态四段重算——未压缩时恒等
  // totalTokens：finalSummary/finalMessages 即输入原值）。
  const loadTokens = systemTokens + pinnedTokens + estimateTokens(finalSummary ?? '') + estimateMessagesTokens(finalMessages);

  return {
    messages: finalMessages,
    contextState: finalState,
    compactionOccurred,
    compactedCount,
    loadTokens,
    cacheConfig: {
      pinnedContent: pinnedContent || undefined,
      compactedSummary: finalState.compactedSummary,
    },
  };
}
