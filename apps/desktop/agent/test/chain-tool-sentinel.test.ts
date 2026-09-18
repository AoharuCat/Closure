import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResearchBrief } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子2 W4：chain-tool 事件（design §3，B 路线定案）+ 哨兵 pauseKind（design §4）测试。
//
// 覆盖：
// 1. makeAgentLoop onToolCall seam——逐字段断言（工具名 / inputSummary 截断 200 + 归一形态 /
//    status = Error: 前缀机械判 / resultCount = 输出字符数恒档）+ error 三形态（execute 抛 /
//    畸形参数 / 未知工具）+ 发射失败静默（可观测性绝不破循环）。
// 2. deriveSentinelPauseKind 投影（AC4）——五暂停面 + escalatePause 优先于 stage + 'verdict'→
//    'final' 归一 + 非 paused 终态零 pauseKind。
// 3. runChapterChain e2e——AC3（draft-writer 阶段一 research 工具实测上行，全链 threading：
//    agent-loop seam → writer/verifier deps → chapter-chain 补 nodeId → workflow emitChainEvent）+
//    AC4（final 停点 / escalate 停点 / 非 pause 终态帧形态零变化）。
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
// 1. makeAgentLoop — onToolCall seam（agent-loop 工具执行循环体）
// ════════════════════════════════════════════════════════════════════════════

function makeSeamTool(id: string, opts: { output?: string; throwErr?: Error } = {}) {
  return {
    id,
    description: `fake ${id}`,
    parameters: z.object({}),
    execute: async () => {
      if (opts.throwErr) throw opts.throwErr;
      return { title: id, output: opts.output ?? `${id} ok` };
    },
  };
}

/** seam 直构 loop：首轮返回指定 toolCalls，次轮收束。返 AgentLoopResult（发射经 caller 闭包收集）。 */
async function runSeamLoop(args: {
  calls: Array<{ id: string; name: string; arguments: string }>;
  tool?: ReturnType<typeof makeSeamTool>;
  nodeId?: string;
  onToolCall?: (d: { nodeId?: string; toolName: string; inputSummary: string; resultCount: number; status: 'ok' | 'error' }) => void;
}): Promise<import('../src/nodes/agent-loop').AgentLoopResult> {
  const { makeAgentLoop } = await import('../src/nodes/agent-loop');
  const tool = args.tool ?? makeSeamTool('query_story');
  let round = 0;
  const generate = vi.fn(async () => {
    round += 1;
    if (round === 1) {
      return { content: '我先查一下。', toolCalls: args.calls, finishReason: 'stop' as const };
    }
    return { content: 'done<STOP>', finishReason: 'stop' as const };
  });
  const loop = makeAgentLoop(
    {
      generate: generate as never,
      resolveTool: (id: string) => (id === tool.id ? tool : undefined),
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
      ...(args.onToolCall ? { onToolCall: args.onToolCall } : {}),
    },
    {
      toolIds: [tool.id],
      systemPrompt: 'sys',
      stablePrefix: [],
      stopMarkers: ['<STOP>'],
      maxRounds: 5,
      projectPath: '/test',
    },
  );
  return loop({ userPrompt: '写' });
}

describe('makeAgentLoop — onToolCall seam（09-13 子2 W4 design §3）', () => {
  it('成功工具调用 → 逐字段发射（工具名 / inputSummary 归一形态 / resultCount=输出字符数 / status ok）', async () => {
    const emissions: Array<{ toolName: string; inputSummary: string; resultCount: number; status: string }> = [];
    await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'query_story', arguments: '{"query": "林昭", "topK": 5}' }],
      tool: makeSeamTool('query_story', { output: '查询结果' }),
      onToolCall: (d) => emissions.push(d),
    });
    // inputSummary = 归一后 arguments（executeCallSafely 回写 JSON.stringify(params)——
    // 空格压缩后的规范形态）；resultCount = 输出字符数恒档；status 机械判 ok。
    expect(emissions).toEqual([
      { toolName: 'query_story', inputSummary: '{"query":"林昭","topK":5}', resultCount: '查询结果'.length, status: 'ok' },
    ]);
  });

  it('inputSummary 截断 200（超长归一参数 → slice(0,200) + "…"，与畸形参数回显共用常数）', async () => {
    const emissions: Array<{ inputSummary: string }> = [];
    await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'query_story', arguments: JSON.stringify({ query: 'x'.repeat(400) }) }],
      onToolCall: (d) => emissions.push(d),
    });
    expect(emissions.length).toBe(1);
    expect(emissions[0]!.inputSummary.length).toBe(201);
    expect(emissions[0]!.inputSummary.endsWith('…')).toBe(true);
    expect(emissions[0]!.inputSummary.startsWith('{"query":"xxxx')).toBe(true);
  });

  it('工具 execute 抛错 → status error（Error: 前缀机械判）', async () => {
    const emissions: Array<{ toolName: string; inputSummary: string; status: string; resultCount: number }> = [];
    await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'query_story', arguments: '{"q":"x"}' }],
      tool: makeSeamTool('query_story', { throwErr: new Error('db locked') }),
      onToolCall: (d) => emissions.push(d),
    });
    expect(emissions).toEqual([
      { toolName: 'query_story', inputSummary: '{"q":"x"}', status: 'error', resultCount: 'Error: db locked'.length },
    ]);
  });

  it('畸形参数 → status error（inputSummary 保持原始串——归一失败不回写）', async () => {
    const emissions: Array<{ toolName: string; inputSummary: string; status: string; resultCount: number }> = [];
    await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'query_story', arguments: 'not-json{{{' }],
      onToolCall: (d) => emissions.push(d),
    });
    expect(emissions.length).toBe(1);
    expect(emissions[0]!.toolName).toBe('query_story');
    expect(emissions[0]!.inputSummary).toBe('not-json{{{');
    expect(emissions[0]!.status).toBe('error');
    expect(emissions[0]!.resultCount).toBe(
      'Error: malformed arguments for tool "query_story"（无法解析为 JSON 对象，请修正后重发）：not-json{{{'.length,
    );
  });

  it('未知工具（响应携 config 外工具名）→ status error', async () => {
    const emissions: Array<{ toolName: string; status: string; resultCount: number }> = [];
    await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'no_such_tool', arguments: '{}' }],
      onToolCall: (d) => emissions.push(d),
    });
    expect(emissions).toEqual([
      // arguments '{}' 可归一（未知工具在 lookup 拦——归一后的 inputSummary 照常携带）。
      { toolName: 'no_such_tool', inputSummary: '{}', status: 'error', resultCount: 'Error: tool "no_such_tool" not found'.length },
    ]);
  });

  it('发射回调 throw → 循环照常收束（可观测性绝不破节点行为——mirror withNodeArtifact safeEmit 姿态）', async () => {
    const { makeAgentLoop } = await import('../src/nodes/agent-loop');
    const tool = makeSeamTool('query_story', { output: '结果' });
    let round = 0;
    const generate = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return { content: '查', toolCalls: [{ id: 'tc-1', name: 'query_story', arguments: '{}' }], finishReason: 'stop' as const };
      }
      return { content: 'done<STOP>', finishReason: 'stop' as const };
    });
    const loop = makeAgentLoop(
      {
        generate: generate as never,
        resolveTool: (id: string) => (id === tool.id ? tool : undefined),
        onToolCall: () => {
          throw new Error('IPC channel dead');
        },
      },
      {
        toolIds: [tool.id],
        systemPrompt: 'sys',
        stablePrefix: [],
        stopMarkers: ['<STOP>'],
        maxRounds: 5,
        projectPath: '/test',
      },
    );
    const result = await loop({ userPrompt: '写' });
    expect(result.status).toBe('stopped');
    // 工具结果照常回填（消息历史完整——循环行为零受观测面影响）。
    expect(result.messages.some((m) => m.role === 'tool' && m.content === '结果')).toBe(true);
  });

  it('onToolCall 缺省 → 零异常照常收束（直构/测试路径零回归）', async () => {
    const result = await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'query_story', arguments: '{}' }],
    });
    expect(result.status).toBe('stopped');
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('CR-11：loop deps.nodeId 并入 onToolCall 载荷（节点位透传）；缺省不带键（直构形态零变化）', async () => {
    // 带 nodeId：发射并入（第二工具节点接入时事件归属不误标——装配侧 wrapper 读透传值）。
    const withId: Array<{ nodeId?: string; toolName: string; inputSummary: string; resultCount: number; status: string }> = [];
    await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'query_story', arguments: '{}' }],
      nodeId: 'future-tool-node',
      onToolCall: (d) => withId.push(d),
    });
    expect(withId).toEqual([
      { nodeId: 'future-tool-node', toolName: 'query_story', inputSummary: '{}', resultCount: 'query_story ok'.length, status: 'ok' },
    ]);
    // 缺省：payload 无 nodeId 键（undefined 键 vs 无键——toEqual 均过，此处钉字段集形态）。
    const withoutId: Array<Record<string, unknown>> = [];
    await runSeamLoop({
      calls: [{ id: 'tc-1', name: 'query_story', arguments: '{}' }],
      onToolCall: (d) => withoutId.push(d as unknown as Record<string, unknown>),
    });
    expect(withoutId).toHaveLength(1);
    expect(Object.keys(withoutId[0]!).sort()).toEqual(['inputSummary', 'resultCount', 'status', 'toolName']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. deriveSentinelPauseKind 投影（AC4——五暂停面 + 归一 + 非 pause 零字段）
// ════════════════════════════════════════════════════════════════════════════

function stubChain(): import('../src/contracts/run').ChainNodeDef[] {
  const stub = () => ({ contract: null, async run() { return { stateKey: 'x', artifact: {} }; } });
  return [
    { id: 'brief-compiler-node', node: stub() },
    { id: 'brief-reviewer-node', node: stub(), checkpointStage: 'brief' },
    { id: 'draft-writer-agent', node: stub(), checkpointStage: 'draft' },
    { id: 'revision-guard-agent', node: stub(), checkpointStage: 'revision-guard' },
    { id: 'route-agent', node: stub(), checkpointStage: 'final' },
  ];
}

function snap(over: Partial<import('../src/contracts/run').RunSnapshot>): import('../src/contracts/run').RunSnapshot {
  return {
    runId: 'r',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test',
    completedNodes: [],
    pendingNodes: [],
    artifacts: {},
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
    ...over,
  } as import('../src/contracts/run').RunSnapshot;
}

describe('deriveSentinelPauseKind — 五暂停面投影（design §4）', () => {
  it('非 paused 终态 → undefined（completed / aborted / error / blocked）', async () => {
    const { deriveSentinelPauseKind } = await import('../src/runtime/workflow');
    const chain = stubChain();
    for (const status of ['completed', 'aborted', 'error', 'blocked']) {
      expect(deriveSentinelPauseKind(chain, snap({ status, currentNodeId: 'route-agent' }))).toBeUndefined();
    }
  });

  it('escalatePause 优先于 stage——currentNodeId 停在 through 节点（route→final / brief-reviewer→brief）仍判 escalate', async () => {
    const { deriveSentinelPauseKind } = await import('../src/runtime/workflow');
    const chain = stubChain();
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', escalatePause: true, currentNodeId: 'route-agent' }))).toBe('escalate');
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', escalatePause: true, currentNodeId: 'brief-reviewer-node' }))).toBe('escalate');
  });

  it('四 stage 面：brief 停点 / draft（挂起动态 pause）/ revision-guard（soft-violation）/ final（终稿）', async () => {
    const { deriveSentinelPauseKind } = await import('../src/runtime/workflow');
    const chain = stubChain();
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', currentNodeId: 'brief-reviewer-node' }))).toBe('brief');
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', currentNodeId: 'draft-writer-agent' }))).toBe('draft');
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', currentNodeId: 'revision-guard-agent' }))).toBe('revision-guard');
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', currentNodeId: 'route-agent' }))).toBe('final');
  });

  it("'verdict' → 'final' 归一（M1 过渡窗口双保险——旧链 / mock 链 checkpointStage 为 verdict 的终稿停点）", async () => {
    const { deriveSentinelPauseKind } = await import('../src/runtime/workflow');
    const stub = () => ({ contract: null, async run() { return { stateKey: 'x', artifact: {} }; } });
    const legacyChain: import('../src/contracts/run').ChainNodeDef[] = [
      { id: 'route-agent', node: stub(), checkpointStage: 'verdict' },
    ];
    expect(deriveSentinelPauseKind(legacyChain, snap({ status: 'paused', currentNodeId: 'route-agent' }))).toBe('final');
  });

  it('currentNodeId null / 表外节点 → undefined（不造数据）', async () => {
    const { deriveSentinelPauseKind } = await import('../src/runtime/workflow');
    const chain = stubChain();
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', currentNodeId: null }))).toBeUndefined();
    expect(deriveSentinelPauseKind(chain, snap({ status: 'paused', currentNodeId: 'unknown-node' }))).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. runChapterChain e2e —— AC3（chain-tool 上行）+ AC4（哨兵 pauseKind）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 全链 generate mock（mirror chain-node-artifact.test.ts makeArtifactChainGenerate）：
 * 写手阶段一**首轮发两条工具调用**（research 工具为主——AC3 实测形态），次轮收束产简报；
 * 其余节点按 system 标记返回合法 JSON。routeDecision 可注入（escalate/accept e2e 复用）。
 */
function makeToolCallChainGenerate(opts: { routeDecision?: { decision: string; reason: string } } = {}): ReturnType<typeof vi.fn> {
  const route = opts.routeDecision ?? { decision: 'accept_as_truth', reason: '正文升级' };
  const review = { verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] };
  const extractor = { storyTime: 5, title: '状态切面', subjects: [], patches: [] };
  const completeness = { findings: [], summary: '无缺漏', degraded: false };
  const storySync = { runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' };
  const planReview = { verdict: 'pass', summary: '卡面成立', findings: [] };
  let phase1Calls = 0;
  return vi.fn(async (
    msgs: Array<{ role: string; content: string }>,
    sys: string,
    _tls: unknown,
    _abort: AbortSignal,
    _opts?: unknown,
  ) => {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    const s = sys ?? '';
    if (lastUser.includes('第三步')) {
      return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
      return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第一步')) {
      phase1Calls += 1;
      if (phase1Calls === 1) {
        // 阶段一自查首轮：research 工具调用（makeAgentLoop 执行后次轮产简报）。
        return {
          content: '我先查一下任务卡点名的实体。',
          toolCalls: [
            { id: 'tc-1', name: 'query_story', arguments: '{"query": "林昭", "topK": 5}' },
            { id: 'tc-2', name: 'chapter_list', arguments: '{"limit": 3}' },
          ],
          finishReason: 'stop',
        };
      }
      return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('核查')) {
      return { content: '{}', finishReason: 'stop' };
    }
    if (s.includes('规划审核')) return { content: JSON.stringify(planReview), finishReason: 'stop' };
    if (s.includes('路由判决')) return { content: JSON.stringify(route), finishReason: 'stop' };
    if (s.includes('完整性审核')) return { content: JSON.stringify(completeness), finishReason: 'stop' };
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) return { content: JSON.stringify(review), finishReason: 'stop' };
    if (s.includes('story-sync-agent')) return { content: JSON.stringify(storySync), finishReason: 'stop' };
    if (s.includes('状态提取')) return { content: JSON.stringify(extractor), finishReason: 'stop' };
    return { content: '{}', finishReason: 'stop' };
  });
}

describe('WorkflowRuntime.runChapterChain — chain-tool + 哨兵 pauseKind e2e', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-chain-tool-'));
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

  it('AC3：draft-writer 阶段一 research 工具实测上行——chain-tool 事件逐字段（nodeId/工具名/归一截断摘要/字符数档/status）+ 先于节点 node-done', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeToolCallChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    const toolEvents = events.filter((e) => e.type === 'chain-tool');
    // 阶段一两条调用全上行；inputSummary = 归一后 JSON（executeCallSafely 回写形态）；
    // resultCount = fake 工具输出字符数（`${id} 结果`）；status 机械判 ok。
    expect(toolEvents.map((e) => e.data)).toEqual([
      { nodeId: 'draft-writer-agent', toolName: 'query_story', inputSummary: '{"query":"林昭","topK":5}', resultCount: 'query_story 结果'.length, status: 'ok' },
      { nodeId: 'draft-writer-agent', toolName: 'chapter_list', inputSummary: '{"limit":3}', resultCount: 'chapter_list 结果'.length, status: 'ok' },
    ]);
    // 全链事件面归属单一节点位（createLlmNode 系节点 tools=[] 零调用；leader/child 车道不经链装配零发射）。
    expect(toolEvents.every((e) => e.data.nodeId === 'draft-writer-agent')).toBe(true);
    // 工具调用发生在节点 run 内——事件先于 draft-writer 的 node-done（结构性顺序）。
    const writerDone = events.find((e) => e.type === 'chain-node-done' && e.data.nodeId === 'draft-writer-agent');
    expect(writerDone).toBeDefined();
    expect(events.indexOf(toolEvents[toolEvents.length - 1]!)).toBeLessThan(events.indexOf(writerDone!));
  });

  it('AC4：final 停点（suggest 档终稿人审）→ 哨兵 paused 帧携带 pauseKind=final', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeToolCallChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      mode: { pauseStages: ['final'], escalateMode: 'ask' },
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('paused');
    expect(summary.pausedStage).toBe('final');

    const dones = events.filter((e) => e.type === 'chain-node-done');
    expect(dones[dones.length - 1]!.data).toEqual({
      nodeId: '__chain_run__',
      status: 'paused',
      pauseKind: 'final',
    });
  });

  it('AC4：escalate-pause（route=escalate_user）→ 哨兵 paused 帧携带 pauseKind=escalate（escalatePause 优先于 stage）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeToolCallChainGenerate({ routeDecision: { decision: 'escalate_user', reason: '视角丢失灰区' } });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('paused');
    expect(summary.escalatePause).toBe(true);

    const dones = events.filter((e) => e.type === 'chain-node-done');
    // currentNodeId 停在 route-agent（checkpointStage='final'）——escalatePause 投影优先，不误报 'final'。
    expect(dones[dones.length - 1]!.data).toEqual({
      nodeId: '__chain_run__',
      status: 'paused',
      pauseKind: 'escalate',
    });
  });

  it('AC4 补（CR-3a）：escalate-accept 续跑补发终稿停点 → 哨兵帧 pauseKind=final（非 escalate——runChain 新 run 不携带 escalatePause 残留）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeToolCallChainGenerate({ routeDecision: { decision: 'escalate_user', reason: '视角丢失灰区' } });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    // 第一腿：escalate-pause（route=escalate_user 无条件——escalateMode 不 gate）。
    const first = await runtime.runChapterChain(parent.id, makeInitialArtifacts());
    expect(first.status).toBe('paused');
    expect(first.escalatePause).toBe(true);

    // 第二腿：裁决 accept → resume 续跑 → CR-3a 补发终稿 checkpoint（suggest=['final'] → pause；
    // 补发停点 currentNodeId=route-agent 且新 run 无 escalatePause → 投影落 'final' 而非 'escalate'）。
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const second = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      resume: { fromSnapshot: true },
      mode: { pauseStages: ['final'], escalateMode: 'ask' },
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(second.status).toBe('paused');
    expect(second.escalatePause).toBeUndefined();
    expect(second.pausedStage).toBe('final');
    // 补发腿无节点 run（completed 前缀全跳 + 补发先于主循环）——chain-node-done = 前缀重放帧
    //（resume 既有补发重放机制）+ 末尾哨兵帧。
    const dones = events.filter((e) => e.type === 'chain-node-done');
    expect(dones[dones.length - 1]!.data).toEqual({ nodeId: '__chain_run__', status: 'paused', pauseKind: 'final' });
  });

  it('AC4：非 pause 终态（completed）→ 哨兵帧形态零变化（无 pauseKind 键——additive 零破坏）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeToolCallChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');
    const dones = events.filter((e) => e.type === 'chain-node-done');
    expect(dones[dones.length - 1]!.data).toEqual({ nodeId: '__chain_run__', status: 'completed' });
    expect('pauseKind' in dones[dones.length - 1]!.data).toBe(false);
  });

  it('emitChainEvent 缺省 → 零链事件（链段行为零回归——chain-tool 车道同样缺省不开）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeToolCallChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts());
    expect(summary.status).toBe('completed');
  });
});
