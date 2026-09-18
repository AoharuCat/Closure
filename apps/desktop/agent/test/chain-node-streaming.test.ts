import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResearchBrief } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 6（design §4 / r1）：链节点流式测试。
//
// 覆盖：
// 1. makeAgentLoop onDelta 穿线——deps.onDelta 存在时 generate 收 opts.onDelta + 预分配
//    assistantId（delta 与该轮 assistant 消息同 id）；缺省零事件零回归。
// 2. writer-node 全相位开流甄别（09-13 子2 W1 design §1 H2）——reasoning 双通道全相位转发
//    （phase union：research/writing/declaration）；text 通道维持「仅阶段二」（JSON 阶段滤）。
// 3. workflow runChapterChain e2e——emitChainEvent 收 chain-delta（seq 轮次计数）+
//    chain-node-done（每节点边界 + 哨兵终态帧）；同会话第二次 run 同 nodeId seq+1
//    （redo 防混流）；abort → 哨兵 'aborted'。
// 4. chainRunner onNodeDone——节点边界 / error artifact / DAG blocked 三态（chainRunner.test
//    家族外的补充，此处锚 runChapterChain 侧语义）。
// 5. 09-13 子2 W1 双先例开流——createLlmNode onDelta 透传（brief-reviewer 单发路线）+
//    链 e2e channel='reasoning' 事件断言（draft-writer composite 路线 + phase 投影）。
// 6. 09-13 子2 W2a 批量开流——9 个 createLlmNode 单发位（route/world-extractor×5/
//    promise 段2/arc 段2/revision-optimizer）链 e2e reasoning 逐节点断言 + 重试轮
//    messageId 分层（createLlmNode 每次尝试预分配轮 id——重试轮换 id，UI 按轮分段）。
// 7. 09-13 子2 W2b composite 4 位开流——revision-guard L2 / multi-review L2 /
//    completeness L2 / story-sync 装配面逐位断言（channel/nodeId/role + tool 滤除 +
//    重试轮 messageId 分层）+ 15 位全开流 e2e 集合断言（10 单发 + writer loop 族 +
//    composite 4 位收满 15 LLM 位）。
// ─────────────────────────────────────────────────────────────────────────────

const VALID_BRIEF: ResearchBrief = {
  plan: '先城门对峙再入城收束',
  entries: [
    {
      ref: 'char-lin',
      kind: 'asset',
      key_facts: [{ fact: '林昭左臂旧伤未愈', source: '人物卡 char-lin' }],
    },
  ],
  issues: [],
  execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙节拍', notes: '短句提速' }],
  deviations: [],
};

const VALID_DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' };

const VALID_DECLARATION = {
  synopsis: '林昭与江白在城门分手后各自遇袭。',
  present: [{ name: '林昭' }],
  mentioned: [],
};

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ════════════════════════════════════════════════════════════════════════════
// 1. makeAgentLoop onDelta 穿线
// ════════════════════════════════════════════════════════════════════════════

describe('makeAgentLoop — onDelta 穿线（dogfood T1 Stage 6）', () => {
  it('deps.onDelta 在 → generate 收 opts.onDelta + 预分配轮 assistantId（delta 与该轮消息同 id）', async () => {
    const { makeAgentLoop } = await import('../src/nodes/agent-loop');
    const seenOpts: Array<{ onDelta?: unknown }> = [];
    const generate = vi.fn(async (_msgs, _sys, _tls, _abort, opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void }) => {
      seenOpts.push(opts ?? {});
      opts?.onDelta?.({ type: 'text', delta: '你好' });
      return { content: `正文<STOP>`, finishReason: 'stop' };
    });
    const deltas: Array<{ messageId: string; channel: string; delta: string }> = [];
    const loop = makeAgentLoop(
      { generate: generate as never, onDelta: (d) => deltas.push(d) },
      {
        toolIds: [],
        systemPrompt: 'sys',
        stablePrefix: [{ id: 'u1', role: 'user', content: '任务卡', createdAt: 0 }],
        stopMarkers: ['<STOP>'],
        maxRounds: 3,
        projectPath: '/test',
      },
    );
    const result = await loop({ userPrompt: '写' });
    expect(result.status).toBe('stopped');
    // generate 收到 onDelta 回调；包装后事件带预分配 id + channel。
    expect(typeof seenOpts[0]?.onDelta).toBe('function');
    expect(deltas).toEqual([{ messageId: expect.any(String), channel: 'text', delta: '你好' }]);
    // 同 id：该轮 assistant 消息复用预分配 id（UI 轮次分段无漂移）。
    const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant?.id).toBe(deltas[0]?.messageId);
  });

  it('deps.onDelta 缺省 → generate 第 5 参不含 onDelta（零回归：不传回调走非流式路径）', async () => {
    const { makeAgentLoop } = await import('../src/nodes/agent-loop');
    const seenOpts: Array<{ onDelta?: unknown }> = [];
    const generate = vi.fn(async (_msgs, _sys, _tls, _abort, opts?: unknown) => {
      seenOpts.push(opts as { onDelta?: unknown });
      return { content: '正文<STOP>', finishReason: 'stop' };
    });
    const loop = makeAgentLoop(
      { generate: generate as never, modelRef: { keyId: 'k', modelId: 'm' } },
      {
        toolIds: [],
        systemPrompt: 'sys',
        stablePrefix: [],
        stopMarkers: ['<STOP>'],
        maxRounds: 3,
        projectPath: '/test',
      },
    );
    await loop({ userPrompt: '写' });
    // modelRef 在但 onDelta 不在 → opts 只含 modelRef（既有调用形态，S1 分派点走非流式）。
    expect(seenOpts[0]).toEqual({ modelRef: { keyId: 'k', modelId: 'm' } });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1b. createLlmNode onDelta 透传（09-13 子2 W1：createLlmNode 路线先例的节点侧机制）
// ════════════════════════════════════════════════════════════════════════════

describe('createLlmNode — onDelta 透传（09-13 子2 W1）', () => {
  it('deps.onDelta 在 → generate 收 opts.onDelta；tool 通道滤除；同 attempt 共享预分配 messageId', async () => {
    const { createLlmNode } = await import('../src/nodes/llm-node');
    const seenOpts: Array<{ onDelta?: unknown }> = [];
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning' | 'tool'; delta: string; toolName?: string }) => void },
    ) => {
      seenOpts.push(opts ?? {});
      opts?.onDelta?.({ type: 'reasoning', delta: '先想' });
      opts?.onDelta?.({ type: 'tool', delta: '{"q"', toolName: 'query_story' }); // 工具参数流——滤除
      opts?.onDelta?.({ type: 'text', delta: '{"ok"' });
      return { content: '{"ok":true}', finishReason: 'stop' };
    });
    const deltas: Array<{ messageId: string; channel: string; delta: string }> = [];
    const node = createLlmNode(
      {
        nodeId: 'test-llm-node',
        role: 'test-agent',
        contract: null,
        buildPrompt: () => ({}),
        parseOutput: (content) => ({ stateKey: 'test-llm-node', artifact: JSON.parse(content) }),
      },
      { generate: generate as never, onDelta: (d) => deltas.push(d) },
    );
    const result = await node.run({
      run: { artifacts: {} } as never,
      requirement: '',
    });
    expect(result.artifact).toEqual({ ok: true });
    // generate 收到 onDelta 回调；tool 通道不透传（R2 #30 同款）；text/reasoning 双通道映射。
    expect(typeof seenOpts[0]?.onDelta).toBe('function');
    expect(deltas).toEqual([
      { messageId: expect.any(String), channel: 'reasoning', delta: '先想' },
      { messageId: expect.any(String), channel: 'text', delta: '{"ok"' },
    ]);
    // 同 attempt 的 delta 共享同一预分配 messageId（UI 轮分段锚——mirror makeAgentLoop）。
    expect(deltas[0]?.messageId).toBe(deltas[1]?.messageId);
  });

  it('deps.onDelta 缺省 → generate opts 不含 onDelta 键（零回归——非流式路径）', async () => {
    const { createLlmNode } = await import('../src/nodes/llm-node');
    const seenOpts: Array<Record<string, unknown>> = [];
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: Record<string, unknown>,
    ) => {
      seenOpts.push(opts ?? {});
      return { content: '{"ok":true}', finishReason: 'stop' };
    });
    const node = createLlmNode(
      {
        nodeId: 'test-llm-node',
        role: 'test-agent',
        contract: null,
        buildPrompt: () => ({}),
        parseOutput: (content) => ({ stateKey: 'test-llm-node', artifact: JSON.parse(content) }),
      },
      { generate: generate as never },
    );
    await node.run({ run: { artifacts: {} } as never, requirement: '' });
    expect(seenOpts[0]).toBeDefined();
    expect('onDelta' in (seenOpts[0] as object)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. writer-node 全相位开流甄别（09-13 子2 W1：reasoning 全放行；text 仅阶段二）
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 全相位开流甄别（reasoning 全放行 / text 仅阶段二）', () => {
  it('阶段一/申报 reasoning 带 phase=research/declaration 上行；阶段二 text+reasoning 双通道带 phase=writing；JSON 阶段 text 滤除', async () => {
    const { createWriterNode, WRITER_READONLY_TOOL_IDS } = await import('../src/nodes/writer-node');
    const { registry } = await import('../src/tool/registry');
    registry.__clearForTest();
    for (const id of WRITER_READONLY_TOOL_IDS) {
      registry.register({
        id,
        description: `fake ${id}`,
        parameters: z.object({}),
        execute: async () => ({ title: id, output: `${id} 结果` }),
      });
    }

    type Phase = 'phase1' | 'phase2' | 'cast';
    const calls: Array<{ phase: Phase; assistantId: string }> = [];
    // generate mock：按最后一条 user 消息的阶段指令路由；每轮主动调 opts.onDelta（模拟
    // provider 流式输出——text 与 reasoning 都到达，验证甄别政策）。
    const generate = vi.fn(async (
      msgs: Array<{ role: string; content: string }>,
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      let phase: Phase;
      let content: string;
      if (lastUser.includes('第三步')) {
        phase = 'cast';
        content = `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`;
      } else if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
        phase = 'phase2';
        content = `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`;
      } else {
        phase = 'phase1';
        content = `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`;
      }
      const assistantId = `${phase}-assistant`;
      calls.push({ phase, assistantId });
      if (opts?.onDelta) {
        opts.onDelta({ type: 'text', delta: `[${phase}]` });
        opts.onDelta({ type: 'reasoning', delta: `[${phase}-think]` });
      }
      return { content, finishReason: 'stop' };
    });

    const deltas: Array<{ phase: string; channel: string; messageId: string; delta: string }> = [];
    const node = createWriterNode({
      generate: generate as never,
      archiveIo: {
        async read() { return null; },
        async write() { /* 内存 no-op */ },
      },
      nowISO: () => '2026-08-22T00:00:00Z',
      onNodeDelta: (d) => deltas.push(d),
    });

    const result = await node.run({
      run: {
        runId: 'run_w',
        status: 'running',
        currentNodeId: null,
        projectPath: '/test',
        completedNodes: [],
        pendingNodes: [],
        artifacts: {
          chapter_brief: { goal: '抵达 B 城' },
          chapter_brief_input: { episodeId: 'ep-s6', brief: { goal: '抵达 B 城' } },
          scene_graph: { nodes: [] },
          settings_context: '设定前缀',
        },
        review: null,
        archive: null,
        delivery: null,
        feedback: null,
      },
      requirement: '',
    });

    // 三阶段都被调用（两阶段主路径 + 申报）。
    expect(calls.map((c) => c.phase)).toEqual(['phase1', 'phase2', 'cast']);
    // 正文交付不受流式影响（契约零变）。
    expect(result.stateKey).toBe('draft.initial');
    // 甄别政策（09-13 子2 W1 design §1）：reasoning 全相位转发（phase union 标注）；
    // text 仅阶段二（phase1/cast 的裸 JSON text 滤除）。messageId 是 makeAgentLoop 预分配的
    // 轮 assistantId（真 randomUUID——此处只断言非空字符串）。
    expect(deltas).toEqual([
      { phase: 'research', channel: 'reasoning', messageId: expect.any(String), delta: '[phase1-think]' },
      { phase: 'writing', channel: 'text', messageId: expect.any(String), delta: '[phase2]' },
      { phase: 'writing', channel: 'reasoning', messageId: expect.any(String), delta: '[phase2-think]' },
      { phase: 'declaration', channel: 'reasoning', messageId: expect.any(String), delta: '[cast-think]' },
    ]);
    // text 通道零 JSON 泄漏：draft-writer 的 text 增量只出现在 phase='writing'。
    expect(deltas.filter((d) => d.channel === 'text').every((d) => d.phase === 'writing')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. workflow runChapterChain e2e（seq 轮次 + 节点边界 + 终态帧）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 全链 generate mock：写手按阶段指令（最后一条 user 消息）路由；其余节点按 system 标记
 * （mirror runChapterChain.test.ts makeChainGenerate），写手路径主动调 opts.onDelta 模拟流式。
 */
function makeStreamingChainGenerate(): ReturnType<typeof vi.fn> {
  const route = { decision: 'accept_as_truth', reason: '正文升级' };
  const review = { verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] };
  const extractor = { storyTime: 5, title: '状态切面', subjects: [], patches: [] };
  const completeness = { findings: [], summary: '无缺漏', degraded: false };
  const storySync = { runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' };
  return vi.fn(async (
    msgs: Array<{ role: string; content: string }>,
    sys: string,
    _tls: unknown,
    _abort: AbortSignal,
    opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
  ) => {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    const s = sys ?? '';
    // 写手三阶段（阶段指令在最后一条 user 消息；判定先于 system 标记——写手 system 无其他标记）。
    if (lastUser.includes('第三步')) {
      return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
      // 阶段二开流：两段 text delta（模拟 provider 分片）。
      opts?.onDelta?.({ type: 'text', delta: '{"title":"第二章' });
      opts?.onDelta?.({ type: 'text', delta: ' B 城"' });
      return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第一步')) {
      return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
    }
    if (s.includes('路由判决')) return { content: JSON.stringify(route), finishReason: 'stop' };
    if (s.includes('完整性审核')) return { content: JSON.stringify(completeness), finishReason: 'stop' };
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) return { content: JSON.stringify(review), finishReason: 'stop' };
    if (s.includes('状态提取')) return { content: JSON.stringify(extractor), finishReason: 'stop' };
    if (s.includes('story-sync-agent')) return { content: JSON.stringify(storySync), finishReason: 'stop' };
    return { content: '{}', finishReason: 'stop' };
  });
}

describe('WorkflowRuntime.runChapterChain — 链事件（chain-delta / chain-node-done）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-chain-stream-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    const { registry } = await import('../src/tool/registry');
    registry.__clearForTest();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    vi.resetModules();
  });

  async function registerWriterTools() {
    const { WRITER_READONLY_TOOL_IDS } = await import('../src/nodes/writer-node');
    const { registry } = await import('../src/tool/registry');
    for (const id of WRITER_READONLY_TOOL_IDS) {
      registry.register({
        id,
        description: `fake ${id}`,
        parameters: z.object({}),
        execute: async () => ({ title: id, output: `${id} 结果` }),
      });
    }
  }

  function makeInitialArtifacts(): Record<string, unknown> {
    return {
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1' }] },
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'REACH_B_CITY_GOAL', tone: '紧张' } },
      settings_context: 'PREFIX_SETTINGS_TEXT',
      promise_registry: { promises: [], beats: [], version: 0 },
    };
  }

  it('emitChainEvent 收 chain-delta（seq=0、nodeId/role/phase 标注）+ 每节点 chain-node-done + 哨兵终态帧 completed', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    // chain-delta：全部来自 draft-writer 阶段二，seq=0（首 run），phase 标注，delta 分片保序。
    const deltas = events.filter((e) => e.type === 'chain-delta');
    expect(deltas.length).toBe(2);
    for (const d of deltas) {
      expect(d.data.nodeId).toBe('draft-writer-agent');
      expect(d.data.role).toBe('draft-writer-agent');
      expect(d.data.phase).toBe('writing');
      expect(d.data.seq).toBe(0);
    }
    expect(deltas.map((d) => d.data.delta)).toEqual(['{"title":"第二章', ' B 城"']);
    // messageId 携带（轮 assistantId——makeAgentLoop 预分配）。
    expect(typeof deltas[0]?.data.messageId).toBe('string');

    // chain-node-done：每节点边界（含 brief-compiler / draft-writer / route）+ 哨兵终态帧。
    const dones = events.filter((e) => e.type === 'chain-node-done');
    const nodeDones = dones.filter((e) => e.data.nodeId !== '__chain_run__');
    expect(nodeDones.length).toBeGreaterThanOrEqual(3);
    expect(nodeDones[0]?.data).toEqual({ nodeId: 'brief-compiler-node', status: 'done' });
    expect(nodeDones.map((e) => e.data.nodeId)).toContain('draft-writer-agent');
    expect(nodeDones.map((e) => e.data.nodeId)).toContain('route-agent');
    for (const e of nodeDones) expect(e.data.status).toBe('done');
    // 哨兵终态帧在最后（run 终态 completed）。
    expect(dones[dones.length - 1]?.data).toEqual({ nodeId: '__chain_run__', status: 'completed' });
  });

  it('同会话第二次 run：同 nodeId（draft-writer）seq+1——redo 重跑不与旧流混淆（r1 坑）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const seqs: number[] = [];
    const emitChainEvent = (e: { type: string; data: Record<string, unknown> }) => {
      if (e.type === 'chain-delta') seqs.push(e.data.seq as number);
    };
    await runtime.runChapterChain(parent.id, makeInitialArtifacts(), { emitChainEvent });
    expect(seqs.every((s) => s === 0)).toBe(true);

    // 第二次 run（redo 形态——同 parent 会话重新整链跑；章档案 briefHash 同 → 简报复用，
    // 阶段二照跑照流）。seq 单调 +1（UI 按 (nodeId, seq) 拼接即天然丢弃旧流）。
    seqs.length = 0;
    await runtime.runChapterChain(parent.id, makeInitialArtifacts(), { emitChainEvent });
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.every((s) => s === 1)).toBe(true);
  });

  it('abort（signal 预 abort）→ 哨兵终态帧 aborted（UI 侧「已中断」数据源）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const abort = new AbortController();
    abort.abort();
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      abort: abort.signal,
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('aborted');
    const dones = events.filter((e) => e.type === 'chain-node-done');
    expect(dones[dones.length - 1]?.data).toEqual({ nodeId: '__chain_run__', status: 'aborted' });
  });

  it('emitChainEvent 缺省 → 零链事件（链段行为零回归）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeStreamingChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });
    // 不传 emitChainEvent——正常完成（既有全部测试路径的形态）。
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts());
    expect(summary.status).toBe('completed');
  });

  it('09-13 子2 W1 双先例开流：brief-reviewer（createLlmNode 路线）+ draft-writer（composite 路线）reasoning → chain-delta channel 断言', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const planReview = { verdict: 'pass', summary: '卡面成立', findings: [] };
    const verifyVerdict = {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
    };
    // reasoning 开流 mock：brief-reviewer（system「规划审核」）与写手三相位 + 核实子循环
    // 主动调 opts.onDelta 吐 reasoning（phase1 额外吐裸 JSON text——断言被滤除不进 text 车道）。
    const generate = vi.fn(async (
      msgs: Array<{ role: string; content: string }>,
      sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const s = sys ?? '';
      if (s.includes('规划审核')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[reviewer-think]' });
        return { content: JSON.stringify(planReview), finishReason: 'stop' };
      }
      if (lastUser.includes('第三步')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[cast-think]' });
        return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
        opts?.onDelta?.({ type: 'text', delta: '{"title":"第二章' });
        opts?.onDelta?.({ type: 'reasoning', delta: '[write-think]' });
        return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第一步')) {
        opts?.onDelta?.({ type: 'text', delta: '{"plan":"先' }); // 裸 JSON text——滤除
        opts?.onDelta?.({ type: 'reasoning', delta: '[research-think]' });
        return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('核查')) {
        // 资料员核实子循环（chapter-chain verifier 接线——phase 静态标 'research'）。
        opts?.onDelta?.({ type: 'reasoning', delta: '[verify-think]' });
        return { content: `${JSON.stringify(verifyVerdict)}\n<VERIFICATION_VERDICT_READY>`, finishReason: 'stop' };
      }
      if (s.includes('路由判决')) return { content: JSON.stringify({ decision: 'accept_as_truth', reason: '正文升级' }), finishReason: 'stop' };
      if (s.includes('完整性审核')) return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] }), finishReason: 'stop' };
      }
      if (s.includes('状态提取')) return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      return { content: '{}', finishReason: 'stop' };
    });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    const deltas = events.filter((e) => e.type === 'chain-delta');
    // 双先例 + 核实子循环的全 reasoning 事件（序 = brief-reviewer → 写手阶段一 → 核实 →
    // 阶段二（text+reasoning）→ 申报）。
    expect(deltas.map((d) => ({
      nodeId: d.data.nodeId,
      phase: d.data.phase,
      channel: d.data.channel,
      delta: d.data.delta,
    }))).toEqual([
      // createLlmNode 路线先例：brief-reviewer 思考流（JSON 节点无 phase 标注）。
      { nodeId: 'brief-reviewer-node', phase: undefined, channel: 'reasoning', delta: '[reviewer-think]' },
      // composite 路线先例：写手全相位 phase union 投影。
      { nodeId: 'draft-writer-agent', phase: 'research', channel: 'reasoning', delta: '[research-think]' },
      { nodeId: 'draft-writer-agent', phase: 'research', channel: 'reasoning', delta: '[verify-think]' },
      { nodeId: 'draft-writer-agent', phase: 'writing', channel: 'text', delta: '{"title":"第二章' },
      { nodeId: 'draft-writer-agent', phase: 'writing', channel: 'reasoning', delta: '[write-think]' },
      { nodeId: 'draft-writer-agent', phase: 'declaration', channel: 'reasoning', delta: '[cast-think]' },
    ]);
    // 阶段一裸 JSON text 被滤除：全事件流中无 text 出现在 writing 相位之外。
    expect(
      deltas.filter((d) => d.data.channel === 'text').every((d) => d.data.phase === 'writing'),
    ).toBe(true);
    expect(deltas.some((d) => d.data.delta === '{"plan":"先')).toBe(false);
    // seq 按 nodeId 独立计数（brief-reviewer 与 draft-writer 各自首 run seq=0）。
    expect(deltas.find((d) => d.data.nodeId === 'brief-reviewer-node')?.data.seq).toBe(0);
    expect(deltas.find((d) => d.data.nodeId === 'draft-writer-agent')?.data.seq).toBe(0);
    // messageId 携带（轮 assistantId——makeAgentLoop / llm-node 预分配）。
    expect(typeof deltas[0]?.data.messageId).toBe('string');
  });

  it('09-13 子2 W2a 批量开流：9 个 createLlmNode 单发位 reasoning → chain-delta（channel/nodeId/role 逐节点断言；全序钉死）', async () => {
    await registerWriterTools();
    // promise-emergence 段 2 触发条件：query_world_slice 返含 layered value 的 cognitive patch
    // （objective vs reader_perceived 分歧 → 段 1 产 gap → 进 LLM 段；mirror promise-emergence.test 认知夹具）。
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'query_world_slice',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        return {
          title: 'mock',
          output: '',
          metadata: {
            slices: [
              {
                storyTime: 5,
                patches: [
                  {
                    id: 'cog-erina-believes-king',
                    sliceId: 'ep1:5',
                    subjectId: 'erina',
                    path: '/believes/国王',
                    op: 'replace',
                    value: { objective: '暴君', reader_perceived: '明君' },
                    axis: 'cognitive',
                    source: 'derived',
                    storyTime: 5,
                  },
                ],
              },
            ],
          },
        };
      },
    });
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const optimizerIntent = {
      change: { summary: '补强主角动机', details: ['进城决策加铺垫'] },
      lockedItems: [{ field: '角色性格', authority: 'hard', evidence: '坚韧少年' }],
      rationale: { source: 'user-directive', note: '环内 C1 编译' },
      provenance: { rawUserInstruction: 'auto_revise', compilerNote: '环内 C1 编译' },
    };
    // W2a 批量开流 mock：**只**在 9 个 W2a 目标位发 reasoning delta（W1 位 brief-reviewer/
    // writer/verify 与 composite 4 位不发——本测聚焦 W2a 接线，事件流即全量断言面）。
    // route 序列 auto_revise → accept：回环一圈让 revision-optimizer 真跑（首圈 shouldSkip），
    // accept 后 E 段（world×5/promise/arc）自然前进。
    const routeDecisions = ['auto_revise', 'accept_as_truth'];
    let routeIdx = 0;
    const generate = vi.fn(async (
      msgs: Array<{ role: string; content: string }>,
      sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const s = sys ?? '';
      if (s.includes('规划审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '卡面成立', findings: [] }), finishReason: 'stop' };
      }
      if (s.includes('路由判决')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[route-think]' });
        const decision = routeDecisions[Math.min(routeIdx, routeDecisions.length - 1)];
        routeIdx += 1;
        return { content: JSON.stringify({ decision, reason: `mock (${decision})` }), finishReason: 'stop' };
      }
      if (s.includes('改稿意图编译器')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[optimizer-think]' });
        return { content: JSON.stringify(optimizerIntent), finishReason: 'stop' };
      }
      // story-sync SYSTEM_PROMPT 兼含「Promise 涌现」字样（提取规则引用）——本分支须在
      // Promise 涌现判定**前**，否则 story-sync 的 generate 被误路由（W2b 开流后会误发 delta）。
      if (s.includes('story-sync-agent')) {
        return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
      }
      if (s.includes('完整性审核')) {
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] }), finishReason: 'stop' };
      }
      if (s.includes('状态提取')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[extract-think]' });
        return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      }
      if (s.includes('Promise 涌现')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[promise-think]' });
        return { content: JSON.stringify({ actions: [] }), finishReason: 'stop' };
      }
      if (s.includes('弧节拍登记')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[arc-think]' });
        return { content: JSON.stringify({ actions: [] }), finishReason: 'stop' };
      }
      // 写手三阶段（本测不发 delta——W1 测试已覆盖）+ 核实子循环（'{}' graceful，同 makeStreamingChainGenerate）。
      if (lastUser.includes('第三步')) {
        return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
        return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第一步')) {
        return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
      }
      return { content: '{}', finishReason: 'stop' };
    });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    // arc-emergence 段 2 触发条件：episode_outlines 供 episodeIndex + scene_graph.lines 供
    // 线弧候选（无候选 → 纯代码跳过 LLM 段省成本）；本测局部扩展 base，不动共享 helper。
    const initialArtifacts = {
      ...makeInitialArtifacts(),
      episode_outlines: [{ id: 'ep1', index: 0 }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1' }], lines: [{ id: 'line-main', name: '主线' }] },
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, initialArtifacts, {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    const deltas = events.filter((e) => e.type === 'chain-delta');
    // 全序断言（10 事件 = route×2 圈 + optimizer 环回圈 + world×5 + promise + arc）：
    // 每事件 channel='reasoning'、nodeId/role 按装配行各归各位（5 轴各自身 nodeId——
    // 防五实例共享一个包装的接线错）、JSON 单发位无 phase 标注。
    expect(deltas.map((d) => ({
      nodeId: d.data.nodeId,
      role: d.data.role,
      channel: d.data.channel,
      phase: d.data.phase,
      delta: d.data.delta,
    }))).toEqual([
      { nodeId: 'route-agent', role: 'route-agent', channel: 'reasoning', phase: undefined, delta: '[route-think]' },
      { nodeId: 'revision-optimizer-node', role: 'revision-optimizer-agent', channel: 'reasoning', phase: undefined, delta: '[optimizer-think]' },
      { nodeId: 'route-agent', role: 'route-agent', channel: 'reasoning', phase: undefined, delta: '[route-think]' },
      { nodeId: 'world-extractor-physical', role: 'event-extractor-physical', channel: 'reasoning', phase: undefined, delta: '[extract-think]' },
      { nodeId: 'world-extractor-cognitive', role: 'event-extractor-cognitive', channel: 'reasoning', phase: undefined, delta: '[extract-think]' },
      { nodeId: 'world-extractor-emotional', role: 'event-extractor-emotional', channel: 'reasoning', phase: undefined, delta: '[extract-think]' },
      { nodeId: 'world-extractor-relational', role: 'event-extractor-relational', channel: 'reasoning', phase: undefined, delta: '[extract-think]' },
      { nodeId: 'world-extractor-factional', role: 'event-extractor-factional', channel: 'reasoning', phase: undefined, delta: '[extract-think]' },
      { nodeId: 'promise-emergence-node', role: 'promise-emergence-agent', channel: 'reasoning', phase: undefined, delta: '[promise-think]' },
      { nodeId: 'arc-emergence-node', role: 'arc-emergence-agent', channel: 'reasoning', phase: undefined, delta: '[arc-think]' },
    ]);
    // 9 位全覆盖核对（防全序断言外的静默漏接）：9 个目标 nodeId 各 ≥1 事件。
    const byNode = new Set(deltas.map((d) => d.data.nodeId as string));
    for (const id of [
      'route-agent',
      'revision-optimizer-node',
      'world-extractor-physical',
      'world-extractor-cognitive',
      'world-extractor-emotional',
      'world-extractor-relational',
      'world-extractor-factional',
      'promise-emergence-node',
      'arc-emergence-node',
    ]) {
      expect(byNode.has(id), `nodeId ${id} 应有 reasoning 事件`).toBe(true);
    }
    // seq：每 nodeId 首 run 递增分配（同 run 内 route 两圈共用同 seq）；messageId 携带。
    for (const d of deltas) {
      expect(d.data.seq).toBe(0);
      expect(typeof d.data.messageId).toBe('string');
    }
    // text 通道零泄漏：W2a 位只发 reasoning（正文流语义不变——text 仅 draft 阶段二）。
    expect(deltas.some((d) => d.data.channel === 'text')).toBe(false);
  });

  it('09-13 子2 W2b 15 位全开流：全链 e2e 全 LLM 位 reasoning 覆盖集合断言（补齐 W2a 10 位到 15 位）', async () => {
    await registerWriterTools();
    // promise-emergence 段 2 触发条件：query_world_slice 返含 layered value 的 cognitive patch
    //（mirror 上方 W2a 测试同款注册）。
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'query_world_slice',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        return {
          title: 'mock',
          output: '',
          metadata: {
            slices: [
              {
                storyTime: 5,
                patches: [
                  {
                    id: 'cog-erina-believes-king',
                    sliceId: 'ep1:5',
                    subjectId: 'erina',
                    path: '/believes/国王',
                    op: 'replace',
                    value: { objective: '暴君', reader_perceived: '明君' },
                    axis: 'cognitive',
                    source: 'derived',
                    storyTime: 5,
                  },
                ],
              },
            ],
          },
        };
      },
    });
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    // 15 位全开流形态（CR-4 更新）：multi-review 产**可定位 quote 的 finding**（'黄昏的荒野' ⊂
    // VALID_DRAFT.text）→ C1 环回圈编译 intent 时**机械构造** scope.anchor（LLM 自报 scope 被
    // 覆盖——F2 范式订正）→ 写手 legacy 单发段落级改稿（passageText）→ revision-guard 走
    // anchored 路径真跑 L2（整章 skip 之外的条件执行位在 e2e 全覆盖里必须被触发）→ clean
    // splice → lint/multi-review/completeness → route accept → E 段。
    const anchoredIntent = {
      change: { summary: '补写城门对峙的起手铺垫' },
      lockedItems: [],
      rationale: { source: 'audit-finding', note: '环内 C1 编译（锚定选区）' },
      provenance: { rawUserInstruction: 'auto_revise', compilerNote: '环内 C1 编译' },
    };
    const passageDraft = { title: '第二章 B 城', text: '', passageText: '黄昏的荒野上，风更紧了。', wordCount: 2800, chapterId: 'ch_2' };
    const verifyVerdict = {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
    };
    const routeDecisions = ['auto_revise', 'accept_as_truth'];
    let routeIdx = 0;
    const generate = vi.fn(async (
      msgs: Array<{ role: string; content: string }>,
      sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const s = sys ?? '';
      // 写手四形态（段落级 legacy 直写判定在阶段指令前——legacy user prompt 含【段落级改稿指令】
      // 不含阶段词）。
      if (lastUser.includes('段落级改稿指令')) {
        return { content: JSON.stringify(passageDraft), finishReason: 'stop' };
      }
      if (lastUser.includes('第三步')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[cast-think]' });
        return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
        opts?.onDelta?.({ type: 'text', delta: '{"title":"第二章' });
        opts?.onDelta?.({ type: 'reasoning', delta: '[write-think]' });
        return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第一步')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[research-think]' });
        return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('核查')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[verify-think]' });
        return { content: `${JSON.stringify(verifyVerdict)}\n<VERIFICATION_VERDICT_READY>`, finishReason: 'stop' };
      }
      if (s.includes('规划审核')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[plan-think]' });
        return { content: JSON.stringify({ verdict: 'pass', summary: '卡面成立', findings: [] }), finishReason: 'stop' };
      }
      if (s.includes('路由判决')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[route-think]' });
        const decision = routeDecisions[Math.min(routeIdx, routeDecisions.length - 1)];
        routeIdx += 1;
        return { content: JSON.stringify({ decision, reason: `mock (${decision})` }), finishReason: 'stop' };
      }
      if (s.includes('改稿意图编译器')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[optimizer-think]' });
        return { content: JSON.stringify(anchoredIntent), finishReason: 'stop' };
      }
      if (s.includes('保义裁判员')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[guard-think]' });
        return { content: JSON.stringify({ verdict: 'clean', findings: [], summary: '保义通过' }), finishReason: 'stop' };
      }
      // story-sync SYSTEM_PROMPT 兼含「Promise 涌现」字样（提取规则引用）——本分支须在
      // Promise 涌现判定**前**，否则 story-sync 的 generate 被误路由。
      if (s.includes('story-sync-agent')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[storysync-think]' });
        return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
      }
      if (s.includes('完整性审核')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[completeness-think]' });
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[review-think]' });
        // CR-4：产可定位 quote 的 finding（'黄昏的荒野' ⊂ VALID_DRAFT.text '黄昏的荒野上……'）——
        // C1 环回圈机械定位构造 scope.anchor，revision-guard 走 anchored L2 真跑路径。
        return {
          content: JSON.stringify({
            verdict: 'revise',
            summary: '开篇意象重复',
            dimensions: [
              {
                name: 'consistency',
                findings: [{ severity: 'block', quote: '黄昏的荒野', location: '句1', explanation: '开篇意象重复' }],
              },
            ],
            reasons: [],
          }),
          finishReason: 'stop',
        };
      }
      if (s.includes('状态提取')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[extract-think]' });
        return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      }
      if (s.includes('Promise 涌现')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[promise-think]' });
        return { content: JSON.stringify({ actions: [] }), finishReason: 'stop' };
      }
      if (s.includes('弧节拍登记')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[arc-think]' });
        return { content: JSON.stringify({ actions: [] }), finishReason: 'stop' };
      }
      return { content: '{}', finishReason: 'stop' };
    });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const initialArtifacts = {
      ...makeInitialArtifacts(),
      episode_outlines: [{ id: 'ep1', index: 0 }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1' }], lines: [{ id: 'line-main', name: '主线' }] },
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, initialArtifacts, {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    const deltas = events.filter((e) => e.type === 'chain-delta');
    const reasoningNodes = new Set(
      deltas.filter((d) => d.data.channel === 'reasoning').map((d) => d.data.nodeId as string),
    );
    // 15 位集合断言（W2b 收满）：全链 15 个 LLM 位逐 nodeId 至少一条 reasoning 事件——
    // 10 单发（W1/W2a）+ writer loop 族（W1）+ composite 4 位（W2b）。
    const ALL_15_LLM_NODES = [
      'brief-reviewer-node',
      'revision-optimizer-node',
      'draft-writer-agent',
      'revision-guard-agent',
      'multi-review-agent',
      'completeness-verify-node',
      'route-agent',
      'world-extractor-physical',
      'world-extractor-cognitive',
      'world-extractor-emotional',
      'world-extractor-relational',
      'world-extractor-factional',
      'promise-emergence-node',
      'arc-emergence-node',
      'story-sync-agent',
    ];
    for (const id of ALL_15_LLM_NODES) {
      expect(reasoningNodes.has(id), `nodeId ${id} 应有 reasoning 事件（15 位全开流漏接）`).toBe(true);
    }
    // 集合恰为 15——无计划外节点混入（接线面 = 15 LLM 位整，纯代码节点零事件）。
    expect(reasoningNodes.size).toBe(ALL_15_LLM_NODES.length);
    // guard L2 真跑（anchored 圈）+ splice 落地（终稿正文含改后段——guard 事件非孤立）。
    expect(deltas.some((d) => d.data.nodeId === 'revision-guard-agent' && d.data.delta === '[guard-think]')).toBe(true);
    // text 通道语义不变：仅 draft-writer writing 相位（正文流），其余全 reasoning。
    const textDeltas = deltas.filter((d) => d.data.channel === 'text');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(
      textDeltas.every((d) => d.data.nodeId === 'draft-writer-agent' && d.data.phase === 'writing'),
    ).toBe(true);
    // seq（首 run 全 0）+ messageId 携带（各工厂预分配）。
    for (const d of deltas) {
      expect(d.data.seq).toBe(0);
      expect(typeof d.data.messageId).toBe('string');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. chainRunner onNodeDone 三态
// ════════════════════════════════════════════════════════════════════════════

describe('runChain — onNodeDone 节点边界三态（dogfood T1 Stage 6）', () => {
  it('每节点完成 fire (done)；error artifact → (error)；DAG blocked → (blocked)；resume 跳过节点不 fire', async () => {
    const { runChain } = await import('../src/runtime/chainRunner');
    const { randomUUID } = await import('node:crypto');

    const doneCalls: Array<[string, string]> = [];
    const mkNode = (id: string, opts: { artifact?: unknown } = {}) => ({
      id,
      checkpointStage: undefined,
      node: {
        contract: null,
        async run() {
          return { stateKey: id, artifact: opts.artifact ?? { ok: true } };
        },
      },
    });

    // 1) 两节点成功 → 各 fire (done)。
    const calls1: Array<[string, string]> = [];
    const snap1 = await runChain(
      {
        chain: [mkNode('a'), mkNode('b')] as never,
        initialArtifacts: {},
        requirement: '',
        onNodeDone: (nodeId, status) => calls1.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 },
        signal: new AbortController().signal,
      },
    );
    expect(snap1.status).toBe('completed');
    expect(calls1).toEqual([['a', 'done'], ['b', 'done']]);

    // 2) error artifact → 该节点 (error)，后续节点不跑。
    const calls2: Array<[string, string]> = [];
    const snap2 = await runChain(
      {
        chain: [mkNode('a', { artifact: { error: true, nodeId: 'a', message: 'x' } }), mkNode('b')] as never,
        initialArtifacts: {},
        requirement: '',
        onNodeDone: (nodeId, status) => calls2.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 },
        signal: new AbortController().signal,
      },
    );
    expect(snap2.status).toBe('error');
    expect(calls2).toEqual([['a', 'error']]);

    // 3) DAG blocked（requiredArtifactKeys 缺）→ (blocked)。
    const calls3: Array<[string, string]> = [];
    const snap3 = await runChain(
      {
        chain: [{
          id: 'needful',
          node: {
            contract: { requiredArtifactKeys: ['missing_key'], producedArtifactKeys: [] },
            async run() { return { stateKey: 'needful', artifact: {} }; },
          },
        }] as never,
        initialArtifacts: {},
        requirement: '',
        onNodeDone: (nodeId, status) => calls3.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 },
        signal: new AbortController().signal,
      },
    );
    expect(snap3.status).toBe('blocked');
    expect(calls3).toEqual([['needful', 'blocked']]);

    // 4) resume：跳过的 completed 节点不 fire（前一 run 已 fire）。
    const calls4: Array<[string, string]> = [];
    const snap4 = await runChain(
      {
        chain: [mkNode('a'), mkNode('b')] as never,
        initialArtifacts: { a: { ok: true } },
        requirement: '',
        resumedCompletedNodes: ['a'],
        onNodeDone: (nodeId, status) => calls4.push([nodeId, status]),
      },
      {
        generate: (async () => ({ content: '', finishReason: 'stop' })) as never,
        sessionContext: { id: 's', agentName: 'a', projectPath: '/t', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0, _runId: randomUUID() } as never,
        signal: new AbortController().signal,
      },
    );
    expect(snap4.status).toBe('completed');
    expect(calls4).toEqual([['b', 'done']]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. W2a 重试轮 messageId 分层（09-13 子2：createLlmNode 每次尝试预分配轮 id）
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — W2a 重试轮 messageId 分层（route-agent 位）', () => {
  it('parse 失败重试：两轮 reasoning delta 各持独立预分配 messageId（轮间分层，UI 按轮分段防重试混流）', async () => {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    let call = 0;
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      call += 1;
      if (call === 1) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[route-think-1]' });
        return { content: '这不是 JSON', finishReason: 'stop' }; // parse 抛 → createLlmNode 重试
      }
      opts?.onDelta?.({ type: 'reasoning', delta: '[route-think-2]' });
      return { content: JSON.stringify({ decision: 'accept_as_truth', reason: 'ok' }), finishReason: 'stop' };
    });
    const deltas: Array<{ nodeId: string; role: string; channel: string; messageId: string; delta: string }> = [];
    const session = {
      id: 'sess_w2a_retry',
      agentName: 'chapter-chain',
      projectPath: '/test/w2a-retry',
      status: 'idle' as const,
      messages: [],
      children: [],
      createdAt: 0,
      updatedAt: 0,
    };
    // 经装配面接线（withNodeStreaming 注入）跑真 route 节点——非直构 createLlmNode，
    // 验的是 chapter-chain 装配行 → llm-node attemptMessageId 的整链通路。
    const chain = createChapterChainNodes(
      generate as never,
      undefined,
      session as never,
      undefined,
      (d) => deltas.push(d as { nodeId: string; role: string; channel: string; messageId: string; delta: string }),
    );
    const routeDef = chain.find((n) => n.id === 'route-agent');
    expect(routeDef).toBeDefined();
    const result = await routeDef!.node.run({
      run: {
        artifacts: {
          'review.latest': { verdict: 'pass', dimensions: [], reasons: [] },
          'draft.initial': { title: '第二章', text: '正文', wordCount: 100 },
          chapter_brief: { goal: '抵达 B 城' },
        },
      } as never,
      requirement: '',
    });
    expect(result.stateKey).toBe('route_decision');
    expect(generate.mock.calls.length).toBe(2); // 初试 + 错误反馈重试
    expect(deltas.map(({ nodeId, role, channel, delta }) => ({ nodeId, role, channel, delta }))).toEqual([
      { nodeId: 'route-agent', role: 'route-agent', channel: 'reasoning', delta: '[route-think-1]' },
      { nodeId: 'route-agent', role: 'route-agent', channel: 'reasoning', delta: '[route-think-2]' },
    ]);
    // 重试轮换 id：两轮 delta 的 messageId 互异（每 attempt 预分配——同 attempt 内共享，跨 attempt 分层）。
    expect(deltas[0]!.messageId).not.toBe(deltas[1]!.messageId);
    expect(typeof deltas[0]!.messageId).toBe('string');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. W2b composite 4 位开流（09-13 子2：guard L2 / multi-review L2 / completeness L2 / story-sync）
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — W2b composite 4 位开流（装配面逐位）', () => {
  type WireDelta = { nodeId: string; role: string; channel?: string; phase?: string; messageId: string; delta: string };

  it('multi-review 位：L2 reasoning → chain-delta（nodeId/role/channel）；tool 通道滤除；重试轮 messageId 分层', async () => {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    let call = 0;
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning' | 'tool'; delta: string; toolName?: string }) => void },
    ) => {
      call += 1;
      opts?.onDelta?.({ type: 'reasoning', delta: `[review-think-${call}]` });
      opts?.onDelta?.({ type: 'tool', delta: '{"q"', toolName: 'query_story' }); // 工具参数流——滤除
      if (call === 1) return { content: '这不是 JSON', finishReason: 'stop' }; // parse 抛 → 重试
      return {
        content: JSON.stringify({ verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] }),
        finishReason: 'stop',
      };
    });
    const deltas: WireDelta[] = [];
    const chain = createChapterChainNodes(
      generate as never,
      undefined,
      { id: 'sess_w2b_review', agentName: 'chapter-chain', projectPath: '/test/w2b', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 } as never,
      undefined,
      (d) => deltas.push(d as WireDelta),
    );
    const def = chain.find((n) => n.id === 'multi-review-agent');
    expect(def).toBeDefined();
    const result = await def!.node.run({
      run: {
        artifacts: {
          'draft.initial': { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800 },
          scene_graph: { nodes: [] },
          chapter_brief: { goal: '抵达 B 城' },
        },
      } as never,
      requirement: '',
    });
    expect(result.stateKey).toBe('review.latest');
    expect(generate.mock.calls.length).toBe(2); // 初试 + 错误反馈重试（MAX_ATTEMPTS 语义不变）
    expect(deltas.map(({ nodeId, role, channel, delta }) => ({ nodeId, role, channel, delta }))).toEqual([
      { nodeId: 'multi-review-agent', role: 'multi-review-agent', channel: 'reasoning', delta: '[review-think-1]' },
      { nodeId: 'multi-review-agent', role: 'multi-review-agent', channel: 'reasoning', delta: '[review-think-2]' },
    ]);
    // tool 通道不透传（R2 #30 同款）+ 重试轮换 id（每 attempt 预分配）。
    expect(deltas.every((d) => d.channel !== 'tool')).toBe(true);
    expect(deltas[0]!.messageId).not.toBe(deltas[1]!.messageId);
    expect(typeof deltas[0]!.messageId).toBe('string');
  });

  it('revision-guard 位：anchored intent 圈 L2 reasoning → chain-delta + clean splice 落地；tool 通道滤除', async () => {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning' | 'tool'; delta: string; toolName?: string }) => void },
    ) => {
      opts?.onDelta?.({ type: 'reasoning', delta: '[guard-think]' });
      opts?.onDelta?.({ type: 'tool', delta: '{"q"', toolName: 'query_story' }); // 滤除
      return {
        content: JSON.stringify({ verdict: 'clean', findings: [], summary: '保义通过' }),
        finishReason: 'stop',
      };
    });
    const deltas: WireDelta[] = [];
    const chain = createChapterChainNodes(
      generate as never,
      undefined,
      { id: 'sess_w2b_guard', agentName: 'chapter-chain', projectPath: '/test/w2b', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 } as never,
      undefined,
      (d) => deltas.push(d as WireDelta),
    );
    const def = chain.find((n) => n.id === 'revision-guard-agent');
    expect(def).toBeDefined();
    const result = await def!.node.run({
      run: {
        artifacts: {
          // 段落级形态（draft-writer 段落级不 splice：text 保改前整章 + passageText 改后段）。
          'draft.initial': {
            title: '第二章 B 城',
            text: '黄昏的荒野上……',
            wordCount: 2800,
            passageText: '黄昏的荒野上，风更紧了。',
          },
          revision_intent: {
            change: { summary: '补写起手铺垫' },
            lockedItems: [],
            rationale: { source: 'user-directive', note: '终稿 redo 选区精修' },
            provenance: { rawUserInstruction: '把开头改得更有压迫感', compilerNote: '选区精修编译' },
            scope: {
              anchor: { quote: '黄昏的荒野上', prefix: '', suffix: '', rangeHint: { from: 0, to: 6 } },
            },
          },
          chapter_brief: { goal: '抵达 B 城' },
        },
      } as never,
      requirement: '',
    });
    // clean → splice 落 draft.initial（原段替换为改后段、passageText 剥离）——L2 开流不改护栏行为。
    expect(result.stateKey).toBe('draft.initial');
    expect((result.artifact as { text: string }).text).toBe('黄昏的荒野上，风更紧了。……');
    expect((result.artifact as { passageText?: string }).passageText).toBeUndefined();
    expect(generate.mock.calls.length).toBe(1); // L2 单轮 clean（条件执行位——anchored 才调）
    expect(deltas.map(({ nodeId, role, channel, delta }) => ({ nodeId, role, channel, delta }))).toEqual([
      { nodeId: 'revision-guard-agent', role: 'revision-guard-agent', channel: 'reasoning', delta: '[guard-think]' },
    ]);
    expect(deltas.every((d) => d.channel !== 'tool')).toBe(true);
  });

  it('completeness 位：L2 reasoning → chain-delta（nodeId=节点 id / role=yaml 名有意区分）', async () => {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning' | 'tool'; delta: string; toolName?: string }) => void },
    ) => {
      opts?.onDelta?.({ type: 'reasoning', delta: '[completeness-think]' });
      return {
        content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }),
        finishReason: 'stop',
      };
    });
    const deltas: WireDelta[] = [];
    const chain = createChapterChainNodes(
      generate as never,
      undefined,
      { id: 'sess_w2b_comp', agentName: 'chapter-chain', projectPath: '/test/w2b', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 } as never,
      undefined,
      (d) => deltas.push(d as WireDelta),
    );
    const def = chain.find((n) => n.id === 'completeness-verify-node');
    expect(def).toBeDefined();
    const result = await def!.node.run({
      run: {
        artifacts: {
          'draft.initial': { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800 },
          scene_graph: { nodes: [] },
        },
      } as never,
      requirement: '',
    });
    expect(result.stateKey).toBe('completeness_verify_result');
    expect(deltas.map(({ nodeId, role, channel, delta }) => ({ nodeId, role, channel, delta }))).toEqual([
      {
        nodeId: 'completeness-verify-node',
        role: 'completeness-verify-agent',
        channel: 'reasoning',
        delta: '[completeness-think]',
      },
    ]);
  });

  it('story-sync 位：LLM 路径 reasoning → chain-delta（单发一次预分配 messageId）', async () => {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning' | 'tool'; delta: string; toolName?: string }) => void },
    ) => {
      opts?.onDelta?.({ type: 'reasoning', delta: '[storysync-think]' });
      return {
        content: JSON.stringify({ runId: 'r', chapterId: 'ch_2', patches: [], summary: '无可提取' }),
        finishReason: 'stop',
      };
    });
    const deltas: WireDelta[] = [];
    const chain = createChapterChainNodes(
      generate as never,
      undefined,
      { id: 'sess_w2b_sync', agentName: 'chapter-chain', projectPath: '/test/w2b', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 } as never,
      undefined,
      (d) => deltas.push(d as WireDelta),
    );
    const def = chain.find((n) => n.id === 'story-sync-agent');
    expect(def).toBeDefined();
    const result = await def!.node.run({
      run: {
        // parseStorySyncResponse 的 runId/chapterId 从 options（run.runId）强灌——须在场，
        // 否则 envelope schema 失败 → rules fallback（走不到 LLM 成功路径）。
        runId: 'run_w2b_sync',
        artifacts: {
          'draft.initial': { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' },
        },
      } as never,
      requirement: '',
    });
    expect(result.stateKey).toBe('story.sync');
    // LLM 成功路径（非 rules fallback——summary 判别：fallback 是 "N patches from rules"）。
    expect((result.artifact as { summary: string }).summary).toBe('无可提取');
    expect(deltas.map(({ nodeId, role, channel, delta }) => ({ nodeId, role, channel, delta }))).toEqual([
      { nodeId: 'story-sync-agent', role: 'story-sync-agent', channel: 'reasoning', delta: '[storysync-think]' },
    ]);
  });

  it('4 位 onDelta 缺省 → generate opts 无 onDelta 键（零回归——非流式路径）', async () => {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    // 标记词分布核实：multi-review yaml 含「完整性」×2（非「完整性审核」完整串）——区分 completeness
    // 须用精确开场标记「创作完整性审核员」；multi-review 用「双层审核员」；guard 用「保义裁判员」。
    const seenOpts: Array<Record<string, unknown>> = [];
    const generate = vi.fn(async (
      _msgs: unknown[],
      sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: Record<string, unknown>,
    ) => {
      seenOpts.push(opts ?? {});
      const s = sys ?? '';
      if (s.includes('保义裁判员')) {
        return { content: JSON.stringify({ verdict: 'clean', findings: [], summary: '保义通过' }), finishReason: 'stop' };
      }
      if (s.includes('创作完整性审核员')) {
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('双层审核员')) {
        return {
          content: JSON.stringify({ verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] }),
          finishReason: 'stop',
        };
      }
      // story-sync SYSTEM_PROMPT（story-sync 包单源）——兜底分支。
      return {
        content: JSON.stringify({ runId: 'r', chapterId: 'ch_2', patches: [], summary: '无可提取' }),
        finishReason: 'stop',
      };
    });
    // 不传 onNodeDelta（第 5 参缺省）→ withNodeStreaming 原样返回 deps → 节点内 onDelta undefined。
    const chain = createChapterChainNodes(
      generate as never,
      undefined,
      { id: 'sess_w2b_none', agentName: 'chapter-chain', projectPath: '/test/w2b', status: 'idle', messages: [], children: [], createdAt: 0, updatedAt: 0 } as never,
    );
    const artifacts = {
      'draft.initial': {
        title: '第二章 B 城',
        text: '黄昏的荒野上……',
        wordCount: 2800,
        passageText: '黄昏的荒野上，风更紧了。',
        chapterId: 'ch_2',
      },
      revision_intent: {
        change: { summary: '补写起手铺垫' },
        lockedItems: [],
        rationale: { source: 'user-directive', note: '终稿 redo 选区精修' },
        provenance: { rawUserInstruction: '把开头改得更有压迫感', compilerNote: '选区精修编译' },
        scope: { anchor: { quote: '黄昏的荒野上', prefix: '', suffix: '', rangeHint: { from: 0, to: 6 } } },
      },
      scene_graph: { nodes: [] },
      chapter_brief: { goal: '抵达 B 城' },
    };
    for (const id of ['multi-review-agent', 'revision-guard-agent', 'completeness-verify-node', 'story-sync-agent']) {
      const def = chain.find((n) => n.id === id);
      expect(def, `装配应含 ${id}`).toBeDefined();
      // runId 在场（story-sync parse 从 run.runId 强灌 envelope runId——缺则走 rules fallback）。
      const result = await def!.node.run({ run: { runId: 'run_w2b_none', artifacts } as never, requirement: '' });
      expect((result.artifact as { error?: boolean }).error).not.toBe(true);
    }
    // 4 位各恰一次 generate；全部 opts 不含 onDelta 键（缺省走非流式路径，字节级零回归）。
    expect(generate.mock.calls.length).toBe(4);
    for (const opts of seenOpts) expect('onDelta' in opts).toBe(false);
  });
});
