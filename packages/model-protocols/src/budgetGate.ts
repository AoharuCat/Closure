/**
 * C3.2 W3 月度预算硬线门（design §3.3）——mirror usageSink.ts 的注入缝形态：
 * shell main 在 whenReady 装配 `setBudgetGate(...)`（installBudgetGateProduction，
 * usageIpc.ts——与计量 sink 装配点并列）；缺省 no-gate = 恒放行（字节级无 gate 现行为，
 * 协议层测试零装配全绿即回归锚）。
 *
 * 本模块**零任何 import**（连 node 内建都不引）：errors.ts 与 usageSink.ts 两个消费方
 * 分处两条既有依赖链上（errors↔generate 是 documented deliberate cycle，usageSink 刻意
 * 零项目模块运行时依赖、禁再挂新边）——BudgetExceededError 因此物理落位本模块（design
 * §3.3 原写 errors.ts，偏离注记：类在本模块定义、errors.ts 转出 + 分类，两消费面从
 * errors.ts import 的调用方视角不变），分类器 `instanceof` 与 wrapper 抛出走同一份类。
 */

/** gate 判定结果：allowed=true 放行；allowed=false 附月累计与硬线（错误消息与账面消费）。 */
export type BudgetGateResult =
  | { allowed: true }
  | { allowed: false; spentCny: number; hardCapCny: number };

/** 月累计查询 + 比对闭包（shell 装配；偏好读失败 = 无上限放行是装配侧纪律）。 */
export type BudgetGate = () => BudgetGateResult;

/** 模块级缺省无 gate——未装配时 wrapper 前置门恒放行（零行为变化）。 */
let budgetGate: BudgetGate | undefined;

/**
 * 装配/卸载预算硬线 gate（shell main whenReady 一次装配；测试 afterEach 传 undefined
 * 还原）。全仓唯一装配点 = usageIpc installBudgetGateProduction。
 */
export function setBudgetGate(gate: BudgetGate | undefined): void {
  budgetGate = gate;
}

/**
 * wrapper 族五入口前置门唯一读点（best-effort 降级：无 gate → 放行；gate 自身抛错 →
 * 放行——预算门故障绝不杀生成，mirror sink best-effort 纪律）。CR-7（c3-2 CR 批）：
 * 降级可见性归装配闭包（usageIpc installBudgetGateProduction 的结构化 logger.warn 已
 * 覆盖生产降级路径），本模块不留 console 面——零任何 import 纪律不变。
 */
export function checkBudgetGate(): BudgetGateResult {
  if (budgetGate === undefined) return { allowed: true };
  try {
    return budgetGate();
  } catch {
    return { allowed: true };
  }
}

/** 被拦错误消息单源（错误本体与账面 error_message 同文——指路信息：去哪改/怎么关）。 */
export function budgetExceededMessage(spentCny: number, hardCapCny: number): string {
  return (
    `Monthly LLM budget exceeded: spent ${spentCny.toFixed(2)} / hard cap ${hardCapCny.toFixed(2)} — ` +
    'raise or clear the cap in Settings → Usage → Monthly budget, or wait for the next month.'
  );
}

/**
 * 月度硬线拦截错误（C3.2 W3）：wrapper 前置门在**发起任何请求之前**抛出——账户级问题
 * 换模型不救（classifyGenerationFailure 归 'budget' / ineligible，回退链不烧）。携带
 * 月累计与硬线供上游呈现如实归因（被拦调用已落 budget 失败行，账面可查「为什么这章断了」）。
 */
export class BudgetExceededError extends Error {
  readonly spentCny: number;
  readonly hardCapCny: number;
  constructor(spentCny: number, hardCapCny: number) {
    super(budgetExceededMessage(spentCny, hardCapCny));
    this.name = 'BudgetExceededError';
    this.spentCny = spentCny;
    this.hardCapCny = hardCapCny;
  }
}
