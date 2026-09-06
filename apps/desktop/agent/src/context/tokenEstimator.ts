import type { SessionMessage } from '../types';
import { estimateTextTokens } from '@orison/shared-contracts';

/**
 * Context window constants.
 *
 * S4a（task 08-25 design §4.1）：窗口不再固定——`CONTEXT_WINDOW` 降级为**缺省回落值**，
 * 实际窗口经调用链注入（LoopOptions.contextWindowTokens ← shell 按当前模型 limits 装配，
 * 支持会话中途换模型窗口跟随）。reasoning 等思考内容计入估算后，1M 固定窗口对 200K 级
 * 模型不再成立（research C 主题二：窗口/输出上限 per-model 差异巨大，无统一常数）。
 */
export const CONTEXT_WINDOW = 1_000_000;

/**
 * S4a 前的历史触发线（0.75 → 750K）。**不再是缺省**——08-25 用户拍板「默认顶满窗口，
 * 未到红线不自动压缩」后缺省红线 95%（DEFAULT_REDLINE_PERCENT）。导出面保留供历史
 * 引用与既有测试锚点（旧值语义：75% 即压）。
 */
export const COMPACTION_TRIGGER_RATIO = 0.75;
export const COMPACTION_TARGET_RATIO = 0.50;

/**
 * 缺省红线百分比（95 = 「顶满即压」语义落地——预留回复空间）。S4a 起的缺省值，
 * 这是用户拍板的行为变化（S4 前固定 0.75），回滚 = preferences 恢复 + 常量还原。
 */
export const DEFAULT_REDLINE_PERCENT = 95;

/** 红线可设区间（UI 滑杆同域）：50~100。 */
export const REDLINE_PERCENT_MIN = 50;
export const REDLINE_PERCENT_MAX = 100;

/**
 * 投影溢出判定的保守回复预留（token）：估算 + 预留 > 窗口即「下一轮请求塞不下」。
 * 量级取 32K——思考+正文合计预算的现网护栏尺度（max_tokens 护栏 32768 同源；Kimi 官方
 * 建议工具调用场景 max_tokens ≥ 16000，思考内容可翻倍，保守取其 2 倍）。
 */
export const CONTEXT_REPLY_RESERVE_TOKENS = 32_768;

/** 历史触发线（750K，S4 前缺省）——保留导出面；实际触发线 = 注入窗口 × 注入红线。 */
export const COMPACTION_TRIGGER_TOKENS = CONTEXT_WINDOW * COMPACTION_TRIGGER_RATIO;
export const COMPACTION_TARGET_TOKENS = CONTEXT_WINDOW * COMPACTION_TARGET_RATIO;

/**
 * 每图固定 token 预算（task 09-01 B 波 R2.3b / 复查 M2，2026-09-01）：
 * `estimateMessagesTokens` 对 `m.images` 逐图加算——image parts 不在 content 字符串
 * 里，缺预算会系统性低估实际载荷。三处口径一并修复：①红线/投影判定
 * （shouldTriggerCompaction / isProjectionOverflow——vision 直传 + 小窗模型可实际
 * 超载而估算说装得下）；②校准环（loop.ts updateCalibrationRatio——「估算(无图) vs
 * 实际 usage(含图)」会把 ratio 系统性抬高 → 贴过图的会话后续**纯文本轮**过早压缩）；
 * ③summarizer 决策（contextManager 压缩判定同口径）。
 *
 * 量级依据：归一后（shell 5MB 闸 / 长边 1568）Claude 图像 token ≈ w×h/750 的保守
 * 上界取 2,500；非 Claude 家族按同口径近似。固定预算而非逐图尺寸计算——估算器是
 * 纯启发式不读图（范式判据：不解析图片字节）。
 */
export const IMAGE_TOKEN_BUDGET = 2_500;

/**
 * Fast token estimation using character-based heuristic.
 * Mixed CJK/Latin text averages ~1 token per 3.5 characters.
 * Calibrated at runtime via actual usage feedback from the API.
 *
 * Story 8.4 B1：实现上提单源 shared-contracts `estimateTextTokens`（热层度量跨两编译点共用）——本函数
 * 保 agent 侧既有导出面，委托单源（零行为变化）。
 */
export function estimateTokens(text: string): number {
  return estimateTextTokens(text);
}

export function estimateMessagesTokens(messages: SessionMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    // dogfood T1 Stage 4（design §6.3 / r3）：reasoning 计入预算——深度思考可与正文等长，
    // 不计会低估 compaction 触发线（summarizer 决策漂移）。S4b 起 reasoning 多轮回传
    //（messagesToPayload 以 reasoning_content 附带），计入口径与实际载荷一致。
    if (msg.reasoning) {
      total += estimateTokens(msg.reasoning);
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(tc.arguments) + estimateTokens(tc.name) + 10;
      }
    }
    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        total += estimateTokens(tr.output) + 10;
      }
    }
    // task 09-01 B 波（R2.3b / 复查 M2）：image parts 逐图固定预算（常量注释见
    // IMAGE_TOKEN_BUDGET——三处口径：红线/投影判定、校准环、summarizer）。
    if (msg.images && msg.images.length > 0) {
      total += msg.images.length * IMAGE_TOKEN_BUDGET;
    }
    total += 4; // per-message framing overhead
  }
  return total;
}

/**
 * S4a：解析注入的上下文窗口（token 数）。无效值（undefined / 非有限数 / 非正数）一律回落
 * 1M 缺省——窗口是注入方（shell 装配）的责任，本函数只做防御归一，不抛错。
 */
export function resolveContextWindowTokens(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return CONTEXT_WINDOW;
  return value;
}

/**
 * S4a：归一红线百分比——undefined / 非有限数 → 缺省 95；越界 clamp 到 [50, 100]
 *（UI 滑杆同域，注入侧的脏值不会把触发线压到荒谬区间）。
 */
export function clampRedlinePercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_REDLINE_PERCENT;
  return Math.min(REDLINE_PERCENT_MAX, Math.max(REDLINE_PERCENT_MIN, value));
}

/**
 * 红线触发（三触发之②）：校准后估算 ≥ 窗口 × 红线百分比。
 *
 * S4a 起窗口/红线可注入（缺省 1M / 95%——用户拍板的行为变化，S4 前固定 0.75）；比较从
 * 严格大于改为 ≥（到达红线即压，「如 80%」的直觉语义）。calibrationRatio 保持第 3 参不变。
 */
export function shouldTriggerCompaction(
  systemTokens: number,
  messagesTokens: number,
  calibrationRatio: number = 1.0,
  contextWindowTokens: number = CONTEXT_WINDOW,
  redlinePercent: number = DEFAULT_REDLINE_PERCENT,
): boolean {
  const estimated = (systemTokens + messagesTokens) * calibrationRatio;
  return estimated >= contextWindowTokens * (redlinePercent / 100);
}

/**
 * 投影溢出（三触发之③顶满强制）：估算 + 保守回复预留 > 窗口——下一轮请求塞不下，
 * 无论红线设多少都必须压（红线 100 也由这条兜住）。压后仍溢出的处置在调用侧
 *（contextManager：compactConversation 硬截断 → 再溢出明确报错）。
 */
export function isProjectionOverflow(
  totalTokens: number,
  calibrationRatio: number = 1.0,
  contextWindowTokens: number = CONTEXT_WINDOW,
): boolean {
  const estimated = totalTokens * calibrationRatio;
  return estimated + CONTEXT_REPLY_RESERVE_TOKENS > contextWindowTokens;
}

/**
 * Update calibration ratio using exponential moving average.
 * Call after each API response that includes usage.promptTokens.
 */
export function updateCalibrationRatio(
  currentRatio: number,
  actualTokens: number,
  estimatedTokens: number,
): number {
  if (estimatedTokens <= 0 || actualTokens <= 0) return currentRatio;
  const observed = actualTokens / estimatedTokens;
  return currentRatio * 0.8 + observed * 0.2;
}
