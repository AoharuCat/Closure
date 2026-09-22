/**
 * C3.2 W1 — per-(keyId, modelId) circuit breaker（design §1）。
 *
 * 两层结构：
 *  - 纯函数族（breakerVerdict / recordEligibleFailure / recordSuccess）：无副作用、
 *    now 显式入参，全态迁移单测直测。
 *  - 进程内有状态薄层（verdictFor / recordFailureFor / recordSuccessFor）：模块级
 *    Map 键控 `${keyId}::${modelId}`，网关（modelGatewayIpc）两条生成路径消费。重启即
 *    清（进程内存态，V1 拍板——不做持久化/手动重置面）。
 *
 * 状态机（复核 must-fix#1 订正后的语义）：
 *   closed --(滚动窗内 eligible 失败达阈值)--> open --(冷却期满)--> half-open
 *   half-open 探针成功 --> closed（清空）
 *   half-open 探针 eligible 失败 --> open（直接重开——openedAt=now、failures 保持空；
 *     绝不经 failures 计数绕回：open 时 failures 已清空，若计 1 < 阈值 5，断路器将
 *     永真半开。滚动窗计数只服务 closed→open 转移，open→冷却→half-open→失败→open
 *     是独立直通转移）
 *
 * 本模块零 Electron / 零 logger / 零项目内运行时依赖——可被纯 Node 单测直驱；状态迁移
 * 的 warn 日志归网关接线层（按 recordFailureFor 返回的 transition 打点，design §1.3）。
 */

/** 滚动窗宽（eligible 失败时间戳只在此窗内累计）。 */
export const BREAKER_WINDOW_MS = 60_000;
/** 窗内 eligible 失败达到该数 → open。 */
export const BREAKER_THRESHOLD = 5;
/** open 冷却时长；期满后下一调用作为 half-open 探针放行。 */
export const BREAKER_COOLDOWN_MS = 60_000;

/** One identity's breaker state (per-(keyId, modelId)). */
export type BreakerState = {
  /** closed 态滚动窗内的 eligible 失败 epoch ms；open 期恒空（见模块头状态机注记）。 */
  failures: number[];
  /** 有值 = open/half-open 期（openedAt = 开断/最近一次重开时刻）。 */
  openedAt?: number;
};

export type BreakerVerdict =
  | { kind: 'closed' }
  | { kind: 'open'; cooldownLeftMs: number }
  | { kind: 'half-open' };

/** 纯函数判定：closed / open（带剩余冷却）/ half-open（冷却期满，下一次调用即探针）。
 * CR-11 时钟回拨守卫：now 早于 openedAt（NTP 校正回拨）若按 elapsed 负数算，剩余冷却
 * 会胀过满额且在墙钟追回前恒不衰减 = 冷却永滞——视作冷却已服进 half-open。 */
export function breakerVerdict(state: BreakerState, now: number): BreakerVerdict {
  if (state.openedAt === undefined) return { kind: 'closed' };
  if (now < state.openedAt) return { kind: 'half-open' };
  const elapsed = now - state.openedAt;
  if (elapsed >= BREAKER_COOLDOWN_MS) return { kind: 'half-open' };
  return { kind: 'open', cooldownLeftMs: BREAKER_COOLDOWN_MS - elapsed };
}

/**
 * One eligible failure's state transition. closed 态：窗内追加 + 超窗裁剪，达阈值 →
 * open（openedAt=now、failures 清空）。open/half-open 期：本次失败就是半开探针失败 →
 * 直接重开（openedAt=now、failures 保持空——不经计数，见模块头 must-fix#1 注记）。
 */
export function recordEligibleFailure(state: BreakerState, now: number): BreakerState {
  if (state.openedAt !== undefined) {
    return { failures: [], openedAt: now };
  }
  // CR-11 时钟回拨容忍：回拨后的 now 让窗下界变小、回拨前记录的未来时间戳滞留窗内
  // ——方向偏保守（可能提前达阈值开断），可接受，不做时间负序重排。
  const windowFloor = now - BREAKER_WINDOW_MS;
  const failures = [...state.failures, now].filter((ts) => ts > windowFloor);
  if (failures.length >= BREAKER_THRESHOLD) {
    return { failures: [], openedAt: now };
  }
  return { failures };
}

/**
 * Success clears everything — closed 态成功是无害 no-op 等价（返回恒等空态），open 期
 * 成功 = 半开探针通过 → 关断。
 */
export function recordSuccess(_state: BreakerState): BreakerState {
  return { failures: [] };
}

// ── 进程内有状态薄层（网关消费面）──────────────────────────────────────────────

const BREAKER_STATES = new Map<string, BreakerState>();

export function breakerKey(keyId: string, modelId: string): string {
  return `${keyId}::${modelId}`;
}

/** DI 时钟缝（mirror ModelCliProbeDeps now() 先例）：测试注入可控时钟；undefined 还原墙钟。 */
let clock: () => number = () => Date.now();

/** 测试缝：注入/还原熔断时钟（用例 afterEach 传 undefined 还原）。 */
export function _setBreakerClockForTest(fn: (() => number) | undefined): void {
  clock = fn ?? (() => Date.now());
}

function getState(key: string): BreakerState {
  return BREAKER_STATES.get(key) ?? { failures: [] };
}

/** How a recorded failure changed the identity's breaker (gateway logs 'opened'/'reopened'). */
export type BreakerFailureTransition = 'counted' | 'opened' | 'reopened';

/** 网关消费：按 resolved 身份判定（open → 调用方跳条目/快败；closed/half-open → 放行）。 */
export function verdictFor(keyId: string, modelId: string): BreakerVerdict {
  return breakerVerdict(getState(breakerKey(keyId, modelId)), clock());
}

/**
 * 网关消费：记一次 eligible 失败，返回迁移面（'opened' = closed→open 阈值触发；
 * 'reopened' = half-open 探针失败直接重开；'counted' = closed 态滚动计数无迁移）——
 * 日志归调用方，本模块零 logger 依赖。
 */
export function recordFailureFor(
  keyId: string,
  modelId: string,
): { state: BreakerState; transition: BreakerFailureTransition } {
  const key = breakerKey(keyId, modelId);
  const before = getState(key);
  const wasOpenPeriod = before.openedAt !== undefined;
  const state = recordEligibleFailure(before, clock());
  BREAKER_STATES.set(key, state);
  let transition: BreakerFailureTransition = 'counted';
  if (wasOpenPeriod) transition = 'reopened';
  else if (state.openedAt !== undefined) transition = 'opened';
  return { state, transition };
}

/** 网关消费：成功关断（无表项 = closed 恒等，no-op；open 期成功 = 探针通过）。 */
export function recordSuccessFor(keyId: string, modelId: string): void {
  const key = breakerKey(keyId, modelId);
  if (!BREAKER_STATES.has(key)) return;
  BREAKER_STATES.set(key, recordSuccess(getState(key)));
}

/** 测试缝：清空全部熔断态（fallback loop 既有测试故意打 eligible 失败——不复位会在
 * 套件 <60s 窗口内跨用例累计中途 open，制造顺序依赖红；每用例 beforeEach 调用）。 */
export function _resetBreakerForTest(): void {
  BREAKER_STATES.clear();
}

/** 测试/诊断缝：窥视某身份的当前态（接线测试断言「探针成功 → closed」等用）。 */
export function peekBreakerState(keyId: string, modelId: string): BreakerState {
  return getState(breakerKey(keyId, modelId));
}
