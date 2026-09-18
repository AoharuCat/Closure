import { describe, it, expect, vi } from 'vitest';
import { runLoop } from '../src/agent/loop';
import { appendToolDescriptions } from '../src/prompt/render';
import { estimateTokens, estimateMessagesTokens } from '../src/context/tokenEstimator';
import { createDefaultContextState, type ContextState } from '../src/context/contextManager';
import type { ContextUsageEventData, SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 子5 R6（design §11）：leader 上下文占用快照发射——runLoop 每步 prepareContext
// 落定（含压缩对齐）后经 onContextUsage 回调一次。载荷单源 ContextUsageEventData：
// usedTokens = prepareContext loadTokens × 校准比（四段相加口径与压缩触发同源——同一份
// 计算，非两处公式）；windowTokens = 注入原值（未注入 → null，不用 1M 缺省充数）；
// redlinePercent = clamp 后生效红线。值等跳写在 UI dispatcher——agent 侧不判等。
// ─────────────────────────────────────────────────────────────────────────────

function makeMessages(): SessionMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'x'.repeat(700), createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'y'.repeat(700), createdAt: 2 },
  ];
}

const SYSTEM_PROMPT = 'System';

/** 无压缩路径的四段估算（system + messages；无 pinned / summary / 校准偏移）。 */
function expectedPlainLoad(messages: SessionMessage[]): number {
  return estimateTokens(appendToolDescriptions(SYSTEM_PROMPT, [])) + estimateMessagesTokens(messages);
}

describe('runLoop context-usage 发射（09-12 子5 R6）', () => {
  it('turn 装配后发射：载荷字段齐全（无 usage 响应仍发射；usedTokens = 四段估算；窗口/红线透传注入原值）', async () => {
    const messages = makeMessages();
    const expected = expectedPlainLoad(messages);
    const snapshots: ContextUsageEventData[] = [];
    await runLoop({
      sessionId: 's-ctx1',
      projectPath: '/test',
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({ content: 'Response', toolCalls: undefined, finishReason: 'stop' })),
      onMessage: () => {},
      abort: new AbortController().signal,
      contextWindowTokens: 204_800,
      redlinePercent: 80,
      onContextUsage: (data) => snapshots.push(data),
    });

    expect(snapshots).toHaveLength(1); // 单步 turn 一发（非每 delta）
    expect(snapshots[0]).toEqual({
      usedTokens: expected, // 校准比缺省 1.0（generate 未返回 usage——校准环不触发）
      windowTokens: 204_800,
      redlinePercent: 80,
    });
  });

  it('未注入窗口/红线 → windowTokens null（注入原值语义，不得 1M 充数）+ redlinePercent 缺省 95', async () => {
    const snapshots: ContextUsageEventData[] = [];
    await runLoop({
      sessionId: 's-ctx2',
      projectPath: '/test',
      messages: makeMessages(),
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({ content: 'Response', toolCalls: undefined, finishReason: 'stop' })),
      onMessage: () => {},
      abort: new AbortController().signal,
      onContextUsage: (data) => snapshots.push(data),
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].windowTokens).toBeNull(); // UI 收 null 隐藏条形态
    expect(snapshots[0].redlinePercent).toBe(95); // clamp 缺省（与红线压缩触发同值）
  });

  it('校准比生效：seed ratio 1.2 → usedTokens = ceil(load × 1.2)', async () => {
    const messages = makeMessages();
    const expected = Math.ceil(expectedPlainLoad(messages) * 1.2);
    const snapshots: ContextUsageEventData[] = [];
    await runLoop({
      sessionId: 's-ctx3',
      projectPath: '/test',
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({ content: 'Response', toolCalls: undefined, finishReason: 'stop' })),
      onMessage: () => {},
      abort: new AbortController().signal,
      contextState: { ...createDefaultContextState(), tokenCalibrationRatio: 1.2 },
      onContextUsage: (data) => snapshots.push(data),
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].usedTokens).toBe(expected);
  });

  it('多步 turn（工具步进）每步各发一次，载荷随步进载荷增长', async () => {
    const snapshots: ContextUsageEventData[] = [];
    let call = 0;
    await runLoop({
      sessionId: 's-ctx4',
      projectPath: '/test',
      messages: makeMessages(),
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 5,
      generate: vi.fn(async () => {
        call++;
        if (call === 1) {
          return {
            content: 'need a tool',
            toolCalls: [{ id: 'tc1', name: 'nonexistent_tool', arguments: '{}' }],
            finishReason: 'stop',
          };
        }
        return { content: 'done', toolCalls: undefined, finishReason: 'stop' };
      }),
      onMessage: () => {},
      abort: new AbortController().signal,
      onContextUsage: (data) => snapshots.push(data),
    });

    // 两步 = 两次 prepareContext = 两发（每步粒度，非 turn 终了一发）。
    expect(snapshots).toHaveLength(2);
    // 步 2 载荷含步 1 的 assistant(toolCalls) + tool 消息 → 严格增长。
    expect(snapshots[1].usedTokens).toBeGreaterThan(snapshots[0].usedTokens);
  });

  it('重复 turn 值等时仍发（跳写在 UI 侧——agent 侧不判等）', async () => {
    const snapshots: ContextUsageEventData[] = [];
    for (let turn = 0; turn < 2; turn++) {
      await runLoop({
        sessionId: 's-ctx5',
        projectPath: '/test',
        messages: makeMessages(),
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        maxSteps: 3,
        generate: vi.fn(async () => ({ content: 'Response', toolCalls: undefined, finishReason: 'stop' })),
        onMessage: () => {},
        abort: new AbortController().signal,
        contextWindowTokens: 204_800,
        onContextUsage: (data) => snapshots.push(data),
      });
    }

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual(snapshots[1]); // 值相等也照发——去重归 UI dispatcher
  });

  it('压缩后回落：红线触发压缩 → 事件携带压缩后 loadTokens（< 压缩前四段估算）', async () => {
    // 8 条 ~5000 token 消息（> 保尾 6 → 有可压内容）≈ 40K 装载；窗口 75K / 红线 50 →
    // 阈值 37.5K ≤ 40K 红线触发；投影 40K + 32.768K 预留 < 75K 不溢出——隔离纯红线路径
    //（压缩摘要走 mock generate 的 'Response'，保尾 6 ≈ 30K 塞得下）。
    const messages: SessionMessage[] = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'z'.repeat(17_500),
      createdAt: i + 1,
    }));
    const preCompactionLoad = estimateTokens(appendToolDescriptions(SYSTEM_PROMPT, [])) + estimateMessagesTokens(messages);

    const snapshots: ContextUsageEventData[] = [];
    await runLoop({
      sessionId: 's-ctx6',
      projectPath: '/test',
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({ content: 'Response', toolCalls: undefined, finishReason: 'stop' })),
      onMessage: () => {},
      abort: new AbortController().signal,
      contextWindowTokens: 75_000,
      redlinePercent: 50,
      onContextUsage: (data) => snapshots.push(data),
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].usedTokens).toBeGreaterThan(0);
    // 压缩在 prepareContext 内完成，loadTokens 按 final 态重算——条回落。
    expect(snapshots[0].usedTokens).toBeLessThan(preCompactionLoad);
  });

  it('onContextUsage 缺省 → 零行为变化（回归锚：未注入回调的既有调用面不炸不发）', async () => {
    const messages = makeMessages();
    const result = await runLoop({
      sessionId: 's-ctx7',
      projectPath: '/test',
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      generate: vi.fn(async () => ({ content: 'Response', toolCalls: undefined, finishReason: 'stop' })),
      onMessage: () => {},
      abort: new AbortController().signal,
    });

    expect(result).toHaveLength(1); // assistant 终帧照旧
    expect(result[0].content).toBe('Response');
  });

  // ── CR-5（09-12 子5 CR 批）：tokenCalibrationRatio 读点守卫 ──
  // 复活会话 meta 缺字段（undefined）/NaN 时回退 1——usedTokens 有限非 NaN、EMA
  // 输入同守卫（NaN 无自愈，有限输出回写即自愈）。

  /** 模拟复活会话 meta 缺 tokenCalibrationRatio 字段的运行时形态（TS 类型上 required，
   * 实际来自持久化 JSON 解析——旧 meta 可缺；cast 模拟）。 */
  const revivedContextState = (ratio: unknown): ContextState =>
    ({ compactionCount: 0, totalCompactedMessages: 0, tokenCalibrationRatio: ratio }) as ContextState;

  it('CR-5：缺字段/NaN 校准比 → usedTokens 守卫回退 1（有限值，非 NaN%）', async () => {
    // （Infinity 不在此列——prepareContext 内部判定的投影比较为真会先走压缩/溢出
    // 抛错路径，非「缺字段静默毒发射」形态；守卫面向的是复活 meta 缺字段/NaN。）
    for (const bad of [undefined, NaN]) {
      const messages = makeMessages();
      const expected = Math.ceil(expectedPlainLoad(messages));
      const snapshots: ContextUsageEventData[] = [];
      await runLoop({
        sessionId: 's-ctx-cr5a',
        projectPath: '/test',
        messages,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        maxSteps: 3,
        generate: vi.fn(async () => ({ content: 'Response', toolCalls: undefined, finishReason: 'stop' })),
        onMessage: () => {},
        abort: new AbortController().signal,
        contextState: revivedContextState(bad),
        onContextUsage: (data) => snapshots.push(data),
      });
      expect(snapshots).toHaveLength(1);
      expect(Number.isFinite(snapshots[0]!.usedTokens)).toBe(true);
      expect(snapshots[0]!.usedTokens).toBe(expected); // ratio 回退 1 = 无偏估算
    }
  });

  it('CR-5：EMA 输入同守卫——缺字段会话首轮回 usage 后校准比自愈为有限值（不 NaN 永久污染）', async () => {
    const messages = makeMessages();
    const estimated = expectedPlainLoad(messages);
    const states: Array<{ tokenCalibrationRatio: number }> = [];
    await runLoop({
      sessionId: 's-ctx-cr5b',
      projectPath: '/test',
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      maxSteps: 3,
      // 实测 = 估算 2 倍（低估场景）→ 守卫起点 1 的 EMA = 1×0.8 + 2×0.2 = 1.2（有限）。
      generate: vi.fn(async () => ({
        content: 'Response',
        toolCalls: undefined,
        finishReason: 'stop',
        usage: { promptTokens: estimated * 2 },
      })),
      onMessage: () => {},
      abort: new AbortController().signal,
      contextState: revivedContextState(undefined),
      onContextStateUpdate: (state) => states.push({ tokenCalibrationRatio: state.tokenCalibrationRatio }),
    });
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(states[0]!.tokenCalibrationRatio)).toBe(true);
    expect(states[0]!.tokenCalibrationRatio).toBeCloseTo(1.2, 8);
  });
});
