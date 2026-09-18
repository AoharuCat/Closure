import type { GenerationLane, ModelProtocol } from '@orison/shared-contracts';

// ── 生成调用计量 sink（09-12 usage-panel，design §1）────────────────────────────
//
// 插桩单源 = generate.ts 两公共入口的 wrapper（CLI 早退罩在 wrapper 内）。本模块是
// model-protocols（纯库，无 db 依赖）与 shell 落库实现之间的注入缝——mirror
// setGenerateTextFn / installAgentImagePartsCore 防环注入先例：shell main 在 whenReady
// 装配 setGenerationUsageSink(insertUsageLog 适配)（W2 接线，时序 registerAllIpc 之前）；
// 缺省 no-op = 零行为变化（协议层测试无 sink 全绿即回归锚）。
//
// 本模块刻意零运行时依赖（只 type-import shared-contracts）：generate.ts 引它不进任何环
// （errors.ts↔generate.ts 的既有环是子2 documented deliberate cycle，勿再挂新边——
// errorKind 因此按 string 而非 FallbackFailureKind 类型化：唯一写点 = wrapper 直接赋
// classifyGenerationFailure().kind，值域由构造保证）。

/**
 * 一次生成调用的计量记录（design §1/§2 字段单源）。
 *
 * CR-18 零伪造口径：token 字段全 optional——「计数器未上报」= ABSENT（落库 NULL），
 * 「上报 0」= 0，二者绝不混淆；`totalTokens` 缺席时**不**由 input+output 合成（合成
 * = 换一种口径伪造）。失败行 token 恒 ABSENT（真实部分消耗不可知——abort /
 * StreamInterrupted 同型，如实不记）。
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
