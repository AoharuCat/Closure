import type { ModelProtocol } from './model';

// ── 应用内用量面板（09-12 usage-panel，design §3）──────────────────────────────
//
// closure_llm_log（machine 级 ledger，shell main/db）聚合查询的载荷契约 + ¥ 估算
// 纯函数。纯 TS 类型（非 zod）——这是 IPC 的 OUTPUT 形态（handler → renderer），
// mirror ipc.ts UserPreferencesConfig / CompileReport 先例；数值单源 = db 聚合
// SQL（GROUP BY 下推，SUM 对 NULL 天然跳过——CR-18：缺席计数器 ≠ 0）。
//
// estimatedCost 口径（prd R2 用户拍板）：模型配 per-1M 单价（子3 pricing 三字段）
// 才有值；无单价 → ABSENT（UI 隐藏金额列，不硬造 0）；thinking 无专门价按 output
// 价、cache_read 无专门价按 input 价折算；NULL/缺席 tokens 分量不计入。恒标
// 「仅供参考」是 UI 义务（i18n 键），本层只供数。
//
// 聚合 NULL 语义（CR-2，09-12 子5 CR 批——CR-18「未上报 ≠ 0」的聚合层延伸）：
// token 字段 `number | null`——null = 窗口/行组内有调用但该分量**全程未上报**
//（SUM 全 NULL 透传，不 COALESCE 归 0）；0 = 真零消耗（含空窗零行）。UI 聚合
// cell 渲染「?」+ 未上报 title（与行级「—」区分），不把未知显示成 0。

/** 单窗口聚合（今日 / 近 7 日 / 累计=保留窗内）。token 字段 null = 全程未上报（见文件头 CR-2 注记）。 */
export type UsageWindowTotals = {
  calls: number;
  failedCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  /** 有价才有值（行组任一单价存在即非 undefined）；币种不强制（用户自知）。 */
  estimatedCost?: number;
};

/**
 * per-(key, model, protocol) 行组——¥ 计价的原子粒度（同 modelId 在不同 key 下
 * 单价可不同，计价必须按行组、折叠在 handler）。estimatedCost 由 handler 经
 * estimateUsageCost 注入，repository 不产。
 */
export type UsageModelKeyRow = UsageWindowTotals & {
  keyId: string;
  modelId: string;
  protocol: ModelProtocol;
};

/**
 * per-model 展示行组（CR-3，design §3 拍定）：handler 按 (modelId, protocol) 折叠
 * UsageModelKeyRow——同模型多键一行（tokens/calls 相加、金额各自计价后求和、键
 * 差异进 keyIds 供 UI title）。keyIds 恒非空（行组来自真实行）。
 */
export type UsageModelBreakdown = UsageWindowTotals & {
  keyIds: string[];
  modelId: string;
  protocol: ModelProtocol;
};

/** 按档位/流程标签分解（taskType 列；NULL 组 = 未标注，UI 映射「未标注」标签）。无金额维度。 */
export type UsageTaskBreakdown = {
  taskType: string | null;
  calls: number;
  failedCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
};

/** 最近一行调用（NULL cell = 未上报/不适用——CR-18 缺席 ≠ 0 的行级呈现形态）。 */
export type UsageRecentCall = {
  id: number;
  ts: number;
  protocol: ModelProtocol;
  keyId: string;
  modelId: string;
  taskType: string | null;
  sessionKey: string | null;
  stream: boolean;
  success: boolean;
  /** classifyGenerationFailure 的 kind 族（auth/quota/timeout/…）；成功行 NULL。 */
  errorKind: string | null;
  /** 错误摘要 ≤500 字符；成功行 NULL。本地 db，无外发。 */
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  /** 流式首 delta 耗时；非流式/无 delta NULL。 */
  firstDeltaMs: number | null;
};

/** `usage:overview` 单载荷（W3 IPC 通道契约；窗口边界 JS 本地时区算好传入查询）。 */
export type UsageOverview = {
  today: UsageWindowTotals;
  last7d: UsageWindowTotals;
  /** 累计 = 保留窗内累计（prune 后历史不可恢复，UI 文案如实标注）。 */
  total: UsageWindowTotals;
  /** 近 7 日窗（含今日，design §3 开放项 ③）。 */
  byModel: UsageModelBreakdown[];
  byTask: UsageTaskBreakdown[];
  recent: UsageRecentCall[];
  retentionDays: number;
};

// ── ¥ 估算纯函数（design §3 计价式）──────────────────────────────────────────

/**
 * token 分量子集——UsageWindowTotals / UsageModelBreakdown / ledger 行组皆结构兼容。
 * null = 未上报（CR-2 聚合层语义；贡献 0，同 undefined）。
 */
export type UsageCostTokenInput = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  cacheReadTokens?: number | null;
};

/**
 * 按行组 token 分量 × per-(key,model) 单价换算金额（纯函数，usageIpc handler 消费）。
 *
 * 计价式（design §3）：input×input价 + output×output价 + thinking×output价（思考按
 * 输出价折算——无厂商单独报思考价）+ cache_read×(cachedInput价 ?? input价)，全部 ÷1M。
 *
 * 三条缺席纪律：
 * - **无单价不计入估算**：pricing 三字段全 ABSENT → 返 undefined（UI 隐藏金额，不硬造 0）；
 * - **NULL/缺席 tokens 分量不计**：不可知不折算（贡献 0，非拒绝整个估算——行组里有
 *   价的分量照常计）；
 * - 币种不强制（pricing 是纯数字，用户自知单位）。
 */
export function estimateUsageCost(
  tokens: UsageCostTokenInput,
  pricing: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cachedInputPerMillion?: number;
  } | undefined,
): number | undefined {
  // 无 pricing 条目（子3 pricing 字段 optional——模型未配单价）同「无单价不计入」。
  if (pricing === undefined) return undefined;
  const hasInputPrice = pricing.inputPerMillion !== undefined;
  const hasOutputPrice = pricing.outputPerMillion !== undefined;
  const hasCachedPrice = pricing.cachedInputPerMillion !== undefined;
  if (!hasInputPrice && !hasOutputPrice && !hasCachedPrice) return undefined;
  const input = (tokens.inputTokens ?? 0) * (pricing.inputPerMillion ?? 0);
  const output = (tokens.outputTokens ?? 0) * (pricing.outputPerMillion ?? 0);
  // thinking 无专门价 → 按 output 价折算（工程默认，prd 拍板记录）。
  const thinking = (tokens.thinkingTokens ?? 0) * (pricing.outputPerMillion ?? 0);
  // cache_read 无专门价 → 回退 input 价（缓存读与输入同源计价）。
  const cacheRead =
    (tokens.cacheReadTokens ?? 0) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion ?? 0);
  return (input + output + thinking + cacheRead) / 1_000_000;
}
