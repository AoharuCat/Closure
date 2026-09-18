import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextUsageEventData } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 子5 R6（design §11）：streamMessage leader 上下文占用事件接线——runLoop 装配处
// onContextUsage → input.sendEvent('context-usage')。载荷单源在 loop 侧组装（loadTokens ×
// 校准比 + 注入原值窗口 + clamp 红线），本文件钉「装配→发射」全链：sendEvent 流上出现
// 同型事件且窗口/红线与注入一致。钉法 mirror workflow.leaderContext.test.ts（真实
// prepareContext 透传——无需 mock；usedTokens 的精确值在 loop.contextUsage.test.ts 钉）。
// ─────────────────────────────────────────────────────────────────────────────

import { createWorkflowRuntime } from '../src/runtime/workflow';
import { setTaskSlotResolver } from '../src/runtime/taskModelRouting';
import { setContextPolicyProvider } from '../src/runtime/contextPolicy';

async function makeRuntime(generate: ReturnType<typeof vi.fn>, projectPath: string) {
  const runtime = createWorkflowRuntime({ generate });
  const session = runtime.createSession({ agentName: 'writer', projectPath });
  return { runtime, session };
}

describe('09-12 子5 R6 — streamMessage context-usage 事件接线', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = `C:/test/ctx-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    setTaskSlotResolver(undefined);
    setContextPolicyProvider(undefined);
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    vi.resetModules();
  });

  it('dialogue 档指 glm-5.1（registry limits 204800 窗口）+ 红线 80 → context-usage 事件发射且字段齐全', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);
    setTaskSlotResolver((slot) =>
      slot === 'dialogue'
        ? { keyId: 'wire', modelId: 'glm-5.1', thinking: 'high' as const }
        : undefined,
    );
    setContextPolicyProvider(() => ({ redlinePercent: 80 }));

    const events: Array<{ type: string; data: ContextUsageEventData | unknown }> = [];
    await runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push(event as { type: string; data: unknown }),
    });

    const usageEvents = events.filter((e) => e.type === 'context-usage');
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    const data = usageEvents[0].data as ContextUsageEventData;
    // 字段齐全 + 注入原值透传（窗口随 assignment limits；红线随 contextPolicy）。
    expect(data.windowTokens).toBe(204_800);
    expect(data.redlinePercent).toBe(80);
    expect(Number.isInteger(data.usedTokens)).toBe(true);
    expect(data.usedTokens).toBeGreaterThan(0);
  });

  it('空档（无 limits）+ 未注入红线 → windowTokens null + redlinePercent 缺省 95（UI 隐藏条形态）', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);

    const events: Array<{ type: string; data: ContextUsageEventData | unknown }> = [];
    await runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push(event as { type: string; data: unknown }),
    });

    const usageEvents = events.filter((e) => e.type === 'context-usage');
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    const data = usageEvents[0].data as ContextUsageEventData;
    expect(data.windowTokens).toBeNull(); // 不猜窗口（不用 1M 缺省充数）
    expect(data.redlinePercent).toBe(95);
    expect(data.usedTokens).toBeGreaterThan(0);
  });

  it('sendEvent 事件面透传：context-usage 与既有变体同流广播（不吞不替换既有事件）', async () => {
    const generate = vi.fn(async (): Promise<{ content: string; finishReason: string }> => ({
      content: 'ok',
      finishReason: 'stop',
    }));
    const { runtime, session } = await makeRuntime(generate, projectPath);

    const events: Array<{ type: string }> = [];
    await runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push(event as { type: string }),
    });

    const types = events.map((e) => e.type);
    // 既有 assistant / done 终态照旧在流上（additive——新变体不改既有事件形态）。
    expect(types).toContain('assistant');
    expect(types[types.length - 1]).toBe('done');
    expect(types).toContain('context-usage');
  });
});
