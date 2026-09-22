/**
 * C3.2 W1：熔断纯函数族全态迁移（circuitBreaker.ts——零 Electron / 零项目内运行时依赖，
 * 纯 Node 直测）。钉的是 design §1.1 的状态机：
 *   closed --(滚动窗阈值)--> open --(冷却期满)--> half-open
 *   half-open 探针成功 → closed；探针 eligible 失败 → 直接重开（不经计数，防永真半开）。
 *
 * 网关接线（trace circuit-open / 快败 / 回写）归 modelGatewayFallbackLoop.test.ts 熔断 describe。
 */
import { describe, expect, it } from 'vitest';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  BREAKER_WINDOW_MS,
  breakerVerdict,
  recordEligibleFailure,
  recordSuccess,
} from '../main/ipc/circuitBreaker';
import type { BreakerState } from '../main/ipc/circuitBreaker';

const T0 = 1_000_000;

describe('breakerVerdict', () => {
  it('closed：无 openedAt → closed', () => {
    expect(breakerVerdict({ failures: [] }, T0)).toEqual({ kind: 'closed' });
  });

  it('open：冷却期内 → open 且带精确剩余冷却', () => {
    const state = { failures: [], openedAt: T0 };
    expect(breakerVerdict(state, T0 + 1)).toEqual({ kind: 'open', cooldownLeftMs: BREAKER_COOLDOWN_MS - 1 });
    expect(breakerVerdict(state, T0 + BREAKER_COOLDOWN_MS - 1)).toEqual({
      kind: 'open',
      cooldownLeftMs: 1,
    });
  });

  it('half-open：冷却期满（恰好到点即满）→ half-open', () => {
    const state = { failures: [], openedAt: T0 };
    expect(breakerVerdict(state, T0 + BREAKER_COOLDOWN_MS)).toEqual({ kind: 'half-open' });
    expect(breakerVerdict(state, T0 + BREAKER_COOLDOWN_MS + 999_999)).toEqual({ kind: 'half-open' });
  });
});

describe('recordEligibleFailure — closed 态滚动窗计数', () => {
  it(`窗内累计至 ${BREAKER_THRESHOLD} 次 → open（openedAt=now、failures 清空）`, () => {
    let state: BreakerState = { failures: [] };
    for (let i = 1; i < BREAKER_THRESHOLD; i += 1) {
      state = recordEligibleFailure(state, T0 + i * 100);
      expect(state.openedAt).toBeUndefined();
      expect(state.failures).toHaveLength(i);
    }
    // 阈值第 5 次 → open；failures 清空（滚动窗计数只服务 closed→open 转移）。
    const opened = recordEligibleFailure(state, T0 + BREAKER_THRESHOLD * 100);
    expect(opened).toEqual({ failures: [], openedAt: T0 + BREAKER_THRESHOLD * 100 });
    // open 态 verdict。
    expect(breakerVerdict(opened, T0 + BREAKER_THRESHOLD * 100)).toEqual({
      kind: 'open',
      cooldownLeftMs: BREAKER_COOLDOWN_MS,
    });
  });

  it('超窗失败裁剪：窗满 5 次但最早 2 次已滑出窗 → 不 open 继续计数', () => {
    // 4 次集中在 T0..T0+3s，第 5 次（eligible）落在 T0+61s——最早 4 次全部超窗被裁，
    // 窗内仅 1 次 → 仍 closed。
    let state = { failures: [] as number[] };
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) {
      state = recordEligibleFailure(state, T0 + i);
    }
    const late = recordEligibleFailure(state, T0 + BREAKER_WINDOW_MS + 1_000);
    expect(late.openedAt).toBeUndefined();
    expect(late.failures).toEqual([T0 + BREAKER_WINDOW_MS + 1_000]);
    expect(breakerVerdict(late, T0 + BREAKER_WINDOW_MS + 1_000)).toEqual({ kind: 'closed' });
  });

  it('恰好压窗界的失败被裁（now - ts == WINDOW 视为窗外）', () => {
    let state = recordEligibleFailure({ failures: [] }, T0);
    state = recordEligibleFailure(state, T0 + BREAKER_WINDOW_MS);
    expect(state.failures).toEqual([T0 + BREAKER_WINDOW_MS]);
  });
});

describe('recordEligibleFailure — open/half-open 期（探针失败 → 直接重开）', () => {
  it('open 期记失败 = 半开探针失败 → 重开（openedAt 前移、failures 保持空——绝不绕回计数）', () => {
    const openedAt = T0;
    const state = { failures: [], openedAt: openedAt };
    // 探针在冷却过半时失败 → openedAt 直接前移到探针失败时刻（重开满额冷却）。
    const reopened = recordEligibleFailure(state, T0 + 30_000);
    expect(reopened).toEqual({ failures: [], openedAt: T0 + 30_000 });
    expect(breakerVerdict(reopened, T0 + 30_001)).toEqual({
      kind: 'open',
      cooldownLeftMs: BREAKER_COOLDOWN_MS - 1,
    });
  });

  it('重开链不衰减：连续探针失败每次都满额重开（复核 must-fix#1——非永久半开）', () => {
    let state: BreakerState = { failures: [], openedAt: T0 };
    for (let round = 1; round <= 3; round += 1) {
      const probeAt = state.openedAt! + BREAKER_COOLDOWN_MS; // 冷却期满探针
      state = recordEligibleFailure(state, probeAt);
      expect(state.openedAt).toBe(probeAt);
      expect(state.failures).toHaveLength(0);
    }
  });
});

describe('recordSuccess', () => {
  it('open 期成功（半开探针通过）→ 清空关断', () => {
    const closed = recordSuccess({ failures: [], openedAt: T0 });
    expect(closed).toEqual({ failures: [] });
    expect(breakerVerdict(closed, T0)).toEqual({ kind: 'closed' });
  });

  it('closed 态成功 = 恒等空态（含残留 failures 一并清）', () => {
    expect(recordSuccess({ failures: [T0 - 1, T0] })).toEqual({ failures: [] });
  });
});

// ── CR-11（c3-2 CR 批）：时钟回拨守卫 ──
// NTP 校正回拨让 now 落到 openedAt 之前：按负 elapsed 算，剩余冷却胀过满额且在墙钟
// 追回前恒不衰减 = 冷却永滞（half-open 永不到来）。守卫语义 = now < openedAt 视冷却
// 已服进 half-open；失败窗过滤对回拨天然容忍（窗下界变小、旧时间戳滞留——偏保守方向）。
describe('breakerVerdict — 时钟回拨（CR-11）', () => {
  it('now < openedAt → half-open（负 elapsed 不再永滞 open）', () => {
    const state = { failures: [], openedAt: T0 };
    expect(breakerVerdict(state, T0 - 1)).toEqual({ kind: 'half-open' });
    expect(breakerVerdict(state, T0 - 30_000)).toEqual({ kind: 'half-open' });
  });

  it('回拨全程态迁移：open → 回拨判 half-open → 探针失败在回拨时刻重开 → 新冷却期内正确 open', () => {
    // T0 开断（阈值触发形态），随后时钟回拨 60s。
    let state: BreakerState = recordEligibleFailure(
      { failures: Array.from({ length: BREAKER_THRESHOLD - 1 }, (_, i) => T0 - (BREAKER_THRESHOLD - 1 - i)) },
      T0,
    );
    expect(state.openedAt).toBe(T0);

    // 回拨后判定：冷却已服 → half-open（探针放行）。
    const rolledBack = T0 - BREAKER_COOLDOWN_MS;
    expect(breakerVerdict(state, rolledBack)).toEqual({ kind: 'half-open' });

    // 探针失败 → 在回拨时刻直接重开（openedAt = 回拨时刻）。
    state = recordEligibleFailure(state, rolledBack);
    expect(state).toEqual({ failures: [], openedAt: rolledBack });

    // 重开后新冷却期内：微小幅进（无回拨）→ open 且剩余冷却精确递减。
    expect(breakerVerdict(state, rolledBack + 1)).toEqual({
      kind: 'open',
      cooldownLeftMs: BREAKER_COOLDOWN_MS - 1,
    });
    // 再次回拨到重开时刻之前 → 仍按冷却已服进 half-open（守卫对新 openedAt 同样生效）。
    expect(breakerVerdict(state, rolledBack - 1)).toEqual({ kind: 'half-open' });
  });
});
