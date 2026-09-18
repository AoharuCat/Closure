import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generate, setGenerateTextFn, type GenerateTextRequest } from '../src/provider/ipc-provider';
import { createLlmNode } from '../src/nodes/llm-node';
import { makeAgentLoop, type AgentLoopConfig, type AgentLoopDeps } from '../src/nodes/agent-loop';
import { runLoop } from '../src/agent/loop';
import { createDefaultContextState, type CacheConfig } from '../src/context/contextManager';
import type { GenerationDelta } from '../src/provider/ipc-provider';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { GenerateResult } from '../src/provider/ipc-provider';
import type { SessionMessage, ToolDefinition } from '../src/types';
import type { NodeResult, RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 usage-panel W2（design §9.6）：taskType 装配测试——mirror
// runtime.fallbackChain.wiring 的「断言钉 mock generate/seam 实收」红线形态：
// - ipc-provider seam 三跳（agent 面）：opts.taskType → body.request.taskType，
//   '' 归一为缺席（两态纪律 mirror sessionKey CR-13）；
// - createLlmNode：LlmNodeDeps.taskType → generate opts（chapter-chain llmDepsFor
//   按 slot 注入的消费端）；
// - makeAgentLoop：AgentLoopDeps.taskType → 主循环 generate opts + 闸门压缩摘要
//   恒标 'context-summary'（流程标签非档位词）；
// - runLoop（CR-1，09-12 子5 CR 批）：leader 车道内压缩摘要经 seam 第 7 参恒标
//   'context-summary'（与链段摘要同族）；缺省未标注路径 wire body 零变化（CR-14
//   形态对拍锚）。
// ─────────────────────────────────────────────────────────────────────────────

function userMsg(content: string): SessionMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role: 'user', content, createdAt: Date.now() };
}

describe('ipc-provider taskType 三跳（agent 缝）', () => {
  it('opts.taskType → body.request.taskType 透传', async () => {
    const bodies: GenerateTextRequest[] = [];
    setGenerateTextFn(async (body): Promise<{ text: string; finishReason: string }> => {
      bodies.push(body);
      return { text: 'ok', finishReason: 'stop' };
    });
    await generate([userMsg('hi')], 'sys', [], new AbortController().signal, { taskType: 'writer-draft' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.request.taskType).toBe('writer-draft');
  });

  it("'' 归一为缺席（两态纪律——'' ≡ undefined，不占 wire 位）", async () => {
    const bodies: GenerateTextRequest[] = [];
    setGenerateTextFn(async (body): Promise<{ text: string; finishReason: string }> => {
      bodies.push(body);
      return { text: 'ok', finishReason: 'stop' };
    });
    await generate([userMsg('hi')], 'sys', [], new AbortController().signal, { taskType: '' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.request.taskType).toBeUndefined();
    expect('taskType' in bodies[0]!.request).toBe(true); // 键在（值 undefined——序列化自然缺席）
  });

  it('未传 taskType：wire 形态零变化（缺省未标注）', async () => {
    const bodies: GenerateTextRequest[] = [];
    setGenerateTextFn(async (body): Promise<{ text: string; finishReason: string }> => {
      bodies.push(body);
      return { text: 'ok', finishReason: 'stop' };
    });
    await generate([userMsg('hi')], 'sys', [], new AbortController().signal, { lane: 'background' });
    expect(bodies[0]!.request.taskType).toBeUndefined();
  });
});

describe('createLlmNode taskType 透传（LlmNodeDeps 消费端）', () => {
  it('deps.taskType → generate opts（chapter-chain llmDepsFor(slot) 注入面的终点）', async () => {
    const seenOpts: Array<Parameters<GenerateFn>[4]> = [];
    const generateFn = vi.fn<GenerateFn>(async (_m, _s, _t, _a, opts): Promise<GenerateResult> => {
      seenOpts.push(opts);
      return { content: '{"ok":true}', finishReason: 'stop' };
    });
    const node = createLlmNode(
      {
        nodeId: 'test-node',
        role: 'test-agent',
        contract: null,
        buildPrompt: () => ({ q: 'x' }),
        parseOutput: (): NodeResult => ({ stateKey: 'test-node', artifact: { ok: true } }),
      },
      { generate: generateFn, modelRef: { keyId: 'k', modelId: 'm' }, taskType: 'extraction' },
    );
    await node.run({ run: { artifacts: {} } as unknown as RunSnapshot, requirement: 'test' });
    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]?.taskType).toBe('extraction');
  });

  it('deps.taskType 缺省：opts 不带字段（未标注——回归锚）', async () => {
    const seenOpts: Array<Parameters<GenerateFn>[4]> = [];
    const generateFn = vi.fn<GenerateFn>(async (_m, _s, _t, _a, opts): Promise<GenerateResult> => {
      seenOpts.push(opts);
      return { content: '{"ok":true}', finishReason: 'stop' };
    });
    const node = createLlmNode(
      {
        nodeId: 'test-node',
        role: 'test-agent',
        contract: null,
        buildPrompt: () => ({ q: 'x' }),
        parseOutput: (): NodeResult => ({ stateKey: 'test-node', artifact: { ok: true } }),
      },
      { generate: generateFn },
    );
    await node.run({ run: { artifacts: {} } as unknown as RunSnapshot, requirement: 'test' });
    expect(seenOpts[0]?.taskType).toBeUndefined();
  });
});

describe('makeAgentLoop taskType（writer/verifier 循环装配面）', () => {
  function makeFakeTool(id: string): ToolDefinition {
    return {
      id,
      description: `fake tool ${id}`,
      parameters: z.object({ q: z.string().optional() }),
      execute: vi.fn(async () => ({ title: id, output: `${id} ok` })),
    };
  }

  function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
    return {
      toolIds: ['query_story'],
      systemPrompt: 'SYS_PROMPT',
      stablePrefix: [{ id: 'prefix-1', role: 'user', content: '任务卡+设定前缀', createdAt: 1 }],
      stopMarkers: ['<BRIEF_DONE>'],
      maxRounds: 10,
      projectPath: '/proj',
      ...overrides,
    };
  }

  function makePrior(count: number, charsPer = 3000): SessionMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `prior-${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
      content: 'x'.repeat(charsPer),
      createdAt: i + 1,
    }));
  }

  it('主循环 generate opts 携带 deps.taskType；闸门压缩摘要恒标 context-summary', async () => {
    const tool = makeFakeTool('query_story');
    // 主调用（tools 非空）收束；摘要调用（tools 空）回摘要文本——mirror agent-loop.contextGate.test 形态。
    const calls: Array<{ tools: ToolDefinition[]; taskType?: string }> = [];
    const generateFn = vi.fn<GenerateFn>(async (_m, _s, tools, _a, opts): Promise<GenerateResult> => {
      calls.push({ tools, taskType: opts?.taskType });
      return tools.length === 0
        ? { content: '## Summary\n- compacted', finishReason: 'stop' }
        : { content: '调查完毕 <BRIEF_DONE>', finishReason: 'stop' };
    });
    const deps: AgentLoopDeps = {
      generate: generateFn,
      resolveTool: (id) => (id === 'query_story' ? tool : undefined),
      taskType: 'writer-draft',
    };
    const run = makeAgentLoop(deps, makeConfig({ contextWindowTokens: 40_000 }));
    const result = await run({ userPrompt: '开始自查', priorMessages: makePrior(10) });

    expect(result.status).toBe('stopped');
    expect(generateFn).toHaveBeenCalledTimes(2); // 1 次 gate 摘要（零工具）+ 1 次主调用
    const summaryCall = calls.find((c) => c.tools.length === 0)!;
    const mainCall = calls.find((c) => c.tools.length > 0)!;
    expect(summaryCall.taskType).toBe('context-summary');
    expect(mainCall.taskType).toBe('writer-draft');
  });

  it('deps.taskType 缺省：主循环与摘要各保持缺省/流程标签（回归锚）', async () => {
    const tool = makeFakeTool('query_story');
    const calls: Array<{ tools: ToolDefinition[]; taskType?: string }> = [];
    const generateFn = vi.fn<GenerateFn>(async (_m, _s, tools, _a, opts): Promise<GenerateResult> => {
      calls.push({ tools, taskType: opts?.taskType });
      return tools.length === 0
        ? { content: '## Summary', finishReason: 'stop' }
        : { content: '完毕 <BRIEF_DONE>', finishReason: 'stop' };
    });
    const deps: AgentLoopDeps = {
      generate: generateFn,
      resolveTool: (id) => (id === 'query_story' ? tool : undefined),
    };
    const run = makeAgentLoop(deps, makeConfig());
    await run({ userPrompt: '开始自查', priorMessages: [] });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      if (c.tools.length === 0) expect(c.taskType).toBe('context-summary');
      else expect(c.taskType).toBeUndefined();
    }
  });
});

describe('runLoop 压缩摘要 taskType（leader 车道——CR-1/CR-14，09-12 子5 CR 批）', () => {
  /** 高校准比触发红线压缩的 fixture（mirror loop.contextIntegration 形态：
   * 20×1000 字符 ≈ 5.8K tokens × 200 校准 ≈ 1.16M > 950K 红线；压后保尾 6 ≈ 348K
   * 不再触发——单次压缩）。 */
  function makeHeavyMessages(): SessionMessage[] {
    return Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as SessionMessage['role'],
      content: 'x'.repeat(1000),
      createdAt: i + 1,
    }));
  }

  function compactingLoopOpts(generate: Parameters<typeof runLoop>[0]['generate']) {
    return {
      sessionId: 's-sum',
      projectPath: '/test',
      messages: makeHeavyMessages(),
      systemPrompt: 'SYS',
      tools: [] as ToolDefinition[],
      maxSteps: 5,
      generate,
      onMessage: () => {},
      abort: new AbortController().signal,
      contextState: { ...createDefaultContextState(), tokenCalibrationRatio: 200 },
    };
  }

  it('seam 第 7 参：压缩摘要调用恒携 { taskType: "context-summary" }，主调用不带（缺省形态）', async () => {
    const calls: Array<{ callOptsTaskType?: string }> = [];
    let compactions = 0;
    const generateFn = async (
      _m: SessionMessage[],
      _s: string,
      _t: ToolDefinition[],
      _a: AbortSignal,
      _c?: CacheConfig,
      _d?: (d: GenerationDelta) => void,
      callOpts?: { taskType?: string },
    ): Promise<{ content: string; finishReason: string }> => {
      calls.push({ callOptsTaskType: callOpts?.taskType });
      return { content: 'ok', finishReason: 'stop' };
    };
    await runLoop({
      ...compactingLoopOpts(generateFn),
      onCompaction: () => { compactions += 1; },
    });
    expect(compactions).toBe(1);
    expect(calls.find((c) => c.callOptsTaskType === 'context-summary')).toBeDefined();
    expect(calls.find((c) => c.callOptsTaskType === undefined)).toBeDefined();
  });

  it('wire body 形态对拍：生产形态闭包（callOpts?.taskType ?? "dialogue"）——摘要 body = context-summary / 主调用 body = dialogue', async () => {
    const bodies: GenerateTextRequest[] = [];
    setGenerateTextFn(async (body): Promise<{ text: string; finishReason: string }> => {
      bodies.push(body);
      return { text: 'ok', finishReason: 'stop' };
    });
    let compactions = 0;
    await runLoop({
      ...compactingLoopOpts(
        // mirror workflow.ts leader 车道装配（sendMessage/streamMessage 同款转发）。
        (msgs, sys, tls, abort, cacheConfig, _onDelta, callOpts) =>
          generate(msgs, sys, tls, abort, { taskType: callOpts?.taskType ?? 'dialogue' }, cacheConfig),
      ),
      onCompaction: () => { compactions += 1; },
    });
    expect(compactions).toBe(1);
    expect(bodies).toHaveLength(2); // 摘要（step1 红线压缩先于主 generate）+ 主调用
    expect(bodies[0]!.request.taskType).toBe('context-summary');
    expect(bodies[1]!.request.taskType).toBe('dialogue');
    expect(Array.isArray(bodies[0]!.request.messages)).toBe(true);
  });

  it('CR-14 回归锚：缺省未标注 = wire body 零变化——不转发 callOpts 的闭包（child/skill 少参形态）无 taskType 值', async () => {
    const bodies: GenerateTextRequest[] = [];
    setGenerateTextFn(async (body): Promise<{ text: string; finishReason: string }> => {
      bodies.push(body);
      return { text: 'ok', finishReason: 'stop' };
    });
    await runLoop(compactingLoopOpts(
      // child/skill 车道既有闭包形态：少于 7 参，天然忽略 callOpts（additive 零回归）。
      (msgs, sys, tls, abort) => generate(msgs, sys, tls, abort),
    ));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.request.taskType).toBeUndefined();
      expect('taskType' in b.request).toBe(true); // 键在值 undefined——序列化自然缺席（wire 零变化）
    }
  });
});
