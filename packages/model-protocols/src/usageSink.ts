import { randomUUID } from 'node:crypto';
import type {
  GenerationLane,
  GenerationUsage,
  ModelProtocol,
  ResolvedModel,
} from '@orison/shared-contracts';
import type { ProtocolCallContext } from './types';
// C3.2 W3：预算硬线门（零 import 模块——本文件禁 import errors.ts 的纪律不破）。
import {
  BudgetExceededError,
  budgetExceededMessage,
  checkBudgetGate,
} from './budgetGate';

// ── 生成调用计量 sink（09-12 usage-panel，design §1）────────────────────────────
//
// 插桩单源 = generate.ts 两公共入口的 wrapper（CLI 早退罩在 wrapper 内）。本模块是
// model-protocols（纯库，无 db 依赖）与 shell 落库实现之间的注入缝——mirror
// setGenerateTextFn / installAgentImagePartsCore 防环注入先例：shell main 在 whenReady
// 装配 setGenerationUsageSink(insertUsageLog 适配)（W2 接线，时序 registerAllIpc 之前）；
// 缺省 no-op = 零行为变化（协议层测试无 sink 全绿即回归锚）。
//
// 本模块刻意零**项目模块**运行时依赖（只 type-import shared-contracts/types；运行时仅
// node:crypto——callId 自生成用）：generate.ts / rerank.ts 引它不进任何环
// （errors.ts↔generate.ts 的既有环是子2 documented deliberate cycle，勿再挂新边——
// errorKind 因此按 string 而非 FallbackFailureKind 类型化：唯一写点 = wrapper 直接赋
// classifyGenerationFailure().kind，值域由构造保证；三新入口 wrapper 的分类器同样经
// 参数注入，本模块不 import errors.ts）。

/**
 * 一次生成调用的计量记录（design §1/§2 字段单源）。
 *
 * CR-18 零伪造口径（v2 演进，C3.1）：token 字段全 optional——「计数器未上报」= ABSENT
 * （落库 NULL），「上报 0」= 0，二者绝不混淆；`totalTokens` 缺席时**不**由
 * input+output 合成（合成 = 换一种口径伪造）。v2 将「失败行 token 恒 ABSENT」放宽为
 * 「**未知才 ABSENT**」：计数器缺席仍 NULL、total 缺席仍不合成（不变）；CLI EMPTY turn
 * 完成了（计数器在场）、被弃 attempt usage 已知——失败/被弃行的已知消耗如实入账；
 * abort / StreamInterrupted 真实消耗不可知，仍如实不记。
 */
export type GenerationCallRecord = {
  /** 调用起始 epoch ms（日界在查询侧 JS 本地时区算——design §2 偏离注记①）。 */
  ts: number;
  protocol: ModelProtocol;
  keyId: string;
  modelId: string;
  /** 档位/流程标签（request.taskType 透传）；ABSENT = 未标注。 */
  taskType?: string;
  lane?: GenerationLane;
  /** agy 会话键；ABSENT = 单发冷路径/HTTP。 */
  sessionKey?: string;
  /**
   * C3.1：逻辑调用关联 id——一次逻辑调用（含网关回退环每 attempt / driver 内部多
   * attempt）的全部行共享同一 id；缺省入口 wrapper 自生成（单 attempt 行自成一组）。
   */
  callId?: string;
  /** C3.1：逻辑会话 id（generateText 族经 wire request.sessionId 归一入 ctx）；ABSENT = 调用方未标。 */
  sessionId?: string;
  /**
   * C3.1（D1 拍板）：生图张数（`request.n ?? 1`）；仅 generateImage 行携带——图像 API
   * 无 token 信号，该行 token 列如实全 ABSENT，张数是唯一可如实记的量纲。
   */
  imageCount?: number;
  /** 入口形态（true = generateTextStream）。 */
  stream: boolean;
  success: boolean;
  /** classifyGenerationFailure 的 kind 族（auth/quota/timeout/…）；成功行 ABSENT。值域由唯一写点保证。 */
  errorKind?: string;
  /** 错误摘要（≤500 字符，generate.ts wrapper 截断）；成功行 ABSENT。 */
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** driver 唯一来源（agy 单 turn = step DONE 求和口径）；HTTP 端点多数缺席。 */
  thinkingTokens?: number;
  /** driver 唯一来源——HTTP 路径没有的信号。 */
  cacheReadTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  /** 流式首 delta 耗时；非流式/无 delta ABSENT。 */
  firstDeltaMs?: number;
};

export type GenerationUsageSink = (record: GenerationCallRecord) => void;

/**
 * 一次 driver 内部 attempt 的计量事实（C3.1 attempt 级记账，design §4）：driver 在
 * 重试点经 `ctx.onMeteringAttempt` 上抛被弃/失败 attempt 的已知消耗，入口 wrapper
 * 收集后统一 dispatch——driver 不直接 dispatch（发射面单点）。发射时序防重复计费：
 * 降级重跑 attempt2 失败（首试结果被采用为最终 response）时 attempt1 不发射，否则
 * attempt1 会被最终行记两遍。
 */
export type AttemptMeteringRecord = {
  /** 已知则记（CR-18 v2：失败/被弃 attempt 的已知消耗如实入账；未知 ABSENT）。 */
  usage?: GenerationUsage;
  success: boolean;
  /** 'cli-empty-success' 等（classifyGenerationFailure 同族词表）；成功被弃行 ABSENT。 */
  errorKind?: string;
  /** 错误摘要（原文；≤500 截断在收集器 dispatch 时统一执行）。 */
  errorMessage?: string;
  /**
   * m1（C3.1 复核）：attempt 发射点计时（起止 Date.now() 差，driver 保证）——attempt 行
   * latencyMs 必填列不悬空。
   */
  latencyMs: number;
};

/** 模块级缺省 no-op——未装配时协议层零行为变化（无第二写点、无 IO）。 */
let usageSink: GenerationUsageSink = () => {};

/**
 * 装配/卸载计量 sink（shell main whenReady 一次装配；测试 afterEach 传 undefined 还原）。
 */
export function setGenerationUsageSink(sink: GenerationUsageSink | undefined): void {
  usageSink = sink ?? (() => {});
}

/**
 * 单一分发入口（generate.ts wrapper 唯一调用点）。best-effort：sink 抛错 warn 不阻
 * 生成——计量失败绝不改变调用方结果/错误语义（mirror mention-ledger 降级 hook 哲学）。
 */
export function dispatchGenerationCallRecord(record: GenerationCallRecord): void {
  try {
    usageSink(record);
  } catch (err) {
    console.warn(
      '[model-protocols] generation usage sink threw (best-effort metering; call result unaffected)',
      err,
    );
  }
}

// ── C3.1：wrapper 族共享单源（截断 / usage 映射 / 三入口 wrapper）────────────────

/** 失败行错误摘要上限（error_message 列口径：≤500 字符，本地 db 无外发）。 */
export const LEDGER_ERROR_MESSAGE_CHAR_CAP = 500;

/**
 * C3.2 W3：被拦行的行身份形状（wrapper 族两宿共用——text wrapper 的 identity 含
 * sessionKey、entry wrapper 的含 imageCount，并集可选透传）。
 */
export type BudgetBlockedRowIdentity = Pick<GenerationCallRecord, 'ts' | 'protocol' | 'keyId' | 'modelId' | 'stream'> &
  Partial<Pick<GenerationCallRecord, 'taskType' | 'lane' | 'sessionKey' | 'callId' | 'sessionId' | 'imageCount'>>;

/**
 * C3.2 W3 月度预算硬线前置门（wrapper 族五入口共享单源——text 两入口在 generate.ts
 * `withUsageMetering`、embed/rerank/image 三入口在本模块 `withEntryUsageMetering`，函数体
 * 最前置调用）。被拦 → **先落 budget 失败行**（失败不黑洞——C3.1 纪律延续：success:false /
 * errorKind:'budget' / token 列全 ABSENT〔未发生请求无消耗可记〕/ latencyMs 0〔未发起〕）
 * 后**抛 BudgetExceededError**（调用方感知；分类器归 'budget' ineligible——账户级问题换
 * 模型不救，回退链不烧）。放行 → 原样返回（零开销快径）。
 */
export function enforceBudgetGateOrThrow(identity: BudgetBlockedRowIdentity): void {
  const verdict = checkBudgetGate();
  if (verdict.allowed) return;
  dispatchGenerationCallRecord({
    ...identity,
    success: false,
    errorKind: 'budget',
    errorMessage: truncateForLedger(budgetExceededMessage(verdict.spentCny, verdict.hardCapCny)),
    latencyMs: 0,
  });
  throw new BudgetExceededError(verdict.spentCny, verdict.hardCapCny);
}

export function truncateForLedger(value: string): string {
  return value.length > LEDGER_ERROR_MESSAGE_CHAR_CAP
    ? value.slice(0, LEDGER_ERROR_MESSAGE_CHAR_CAP)
    : value;
}

/**
 * GenerationUsage → ledger token 字段单源映射（wrapper 族共用）。CR-18：缺席计数器落
 * ABSENT（≠0）、totalTokens 缺席不由 input+output 合成。条件展开（CR-4 复核对齐
 * bridgeUsageTokenFields 同一纪律）：缺席键**不出现**（键在而 undefined 的弱形态与
 * 两态纪律相矛盾——sink 绑定层 `?? null` 语义不变，「键不在 = ABSENT」单一形态）。
 */
export function usageToLedgerTokenFields(usage: GenerationUsage | undefined): {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
} {
  return {
    ...(usage?.promptTokens !== undefined ? { inputTokens: usage.promptTokens } : {}),
    ...(usage?.completionTokens !== undefined ? { outputTokens: usage.completionTokens } : {}),
    ...(usage?.thinkingTokens !== undefined ? { thinkingTokens: usage.thinkingTokens } : {}),
    ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  };
}

/**
 * C3.1：embed / rerank / image 三公共入口的计量 wrapper（design §1——mirror generate.ts
 * 两 text wrapper 形态）。共享宿在本模块：三入口分居 generate.ts / rerank.ts，而
 * classifyGenerationFailure（errors.ts）不可被本模块 import（errors↔generate 既有
 * documented cycle 勿挂新边）——分类器经参数注入，各调用方传同一 lambda。
 *
 * 与 text wrapper 的通道分工（两通道并存，各读各的）：本 wrapper 的 taskType 走
 * `ctx.taskType`（embed/rerank/image 调用方 100% 在 shell main，零 wire 改动）；text 族
 * 维持 `request.taskType`。sessionId 走 `ctx.sessionId`（本族调用方暂不标，ABSENT 组）。
 *
 * 计量 best-effort：sink 抛错由 dispatchGenerationCallRecord 吞掉（warn 不阻）；run 的
 * 错误原样重抛（计量绝不改变错误语义）。失败行不读错误旁挂 usage——三入口是纯 HTTP
 * 路径，CLI attempt 旁挂只存在于 text 车道。
 */
export async function withEntryUsageMetering<T>(
  meta: {
    model: ResolvedModel;
    ctx: ProtocolCallContext | undefined;
    /** 成功行 token 源（embed/rerank = response.usage）；缺省 = 端点无 token 信号（image——token 列如实全 ABSENT）。 */
    usageOf?: (response: T) => GenerationUsage | undefined;
    /** 生图张数（D1 拍板：`request.n ?? 1`）——仅 generateImage 传；embed/rerank 缺省 = 键不出现。 */
    imageCount?: number;
  },
  /** 失败行 errorKind（classifyGenerationFailure(err).kind——注入理由见上）。 */
  classifyError: (err: unknown) => string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const identity = {
    ts: startedAt,
    protocol: meta.model.protocol,
    keyId: meta.model.keyId,
    modelId: meta.model.modelId,
    taskType: meta.ctx?.taskType,
    lane: meta.ctx?.lane,
    callId: meta.ctx?.callId ?? randomUUID(),
    sessionId: meta.ctx?.sessionId,
    stream: false,
  };
  // C3.2 W3：预算硬线前置门（五入口共享单源）——被拦落 budget 失败行后抛，run 不发起。
  // imageCount 照带（与既有失败行「已知张数照记」同款：n 是请求侧事实）。
  enforceBudgetGateOrThrow({
    ...identity,
    ...(meta.imageCount !== undefined ? { imageCount: meta.imageCount } : {}),
  });
  try {
    const response = await run();
    dispatchGenerationCallRecord({
      ...identity,
      success: true,
      ...usageToLedgerTokenFields(meta.usageOf?.(response)),
      ...(meta.imageCount !== undefined ? { imageCount: meta.imageCount } : {}),
      latencyMs: Date.now() - startedAt,
    });
    return response;
  } catch (err) {
    dispatchGenerationCallRecord({
      ...identity,
      success: false,
      errorKind: classifyError(err),
      errorMessage: truncateForLedger(err instanceof Error ? err.message : String(err)),
      // 失败行同样携带已知张数（design §1 无成败限定；CR-18 v2「已知则记」——n 是
      // 请求侧事实，不因调用失败变未知；失败 chip 与 ×N 张并存 = 「试了 N 张」如实）。
      ...(meta.imageCount !== undefined ? { imageCount: meta.imageCount } : {}),
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
}
