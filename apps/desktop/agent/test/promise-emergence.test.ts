import { describe, expect, it, vi } from 'vitest';
import {
  createPromiseEmergenceNode,
  detectAxisPerspectiveGaps,
  parsePromiseEmergenceOutput,
  type AxisGap,
  type PromiseEmergenceArtifact,
} from '../src/nodes/promise-emergence-node';
import type { WorldPatch, PromiseAction } from '@orison/shared-contracts';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import { registry } from '../src/tool/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.5 Phase D1：promise-emergence-node 测试。
//
// 不测真实 generateText（LLM 质量非 dogfood 推迟，照 project-dogfood-deferred-after-core-features）。
// 测四块（implement.md Phase D 11）：
// 1. detectAxisPerspectiveGaps：合成 cognitive+relational patches → per-axis AxisGap[]（复用 6.1 detectPerspectiveGap）。
// 2. parsePromiseEmergenceOutput：合成 LLM JSON 输出 → PromiseAction[]（含坏条目丢弃）。
// 3. 节点契约 + run 行为（graceful：无 patches/无 gap/LLM 失败 不破 chain）。
// 4. 🔑 范式红线单测：gap 检测输出仅 `*_vs_*` 方向（不命名叙事工具），涌现产物含 LLM 命名（category tags）。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_promise',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test/project',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

// 合成 cognitive 轴 patch（角色 layered value：objective 真实想法 vs reader_perceived 表象）。
function cognitivePatch(
  subjectId: string,
  path: string,
  value: unknown,
  storyTime = 5,
): WorldPatch {
  return {
    id: `cog-${subjectId}-${path}`,
    sliceId: 'ep1:5',
    subjectId,
    path,
    op: 'replace',
    value,
    axis: 'cognitive',
    source: 'derived',
    storyTime,
  } as WorldPatch;
}

// 合成 relational 轴 patch（关系 layered value：objective 客观真相 vs reader_perceived 读者感知）。
function relationalPatch(
  subjectId: string,
  path: string,
  value: unknown,
  storyTime = 5,
): WorldPatch {
  return {
    id: `rel-${subjectId}-${path}`,
    sliceId: 'ep1:5',
    subjectId,
    path,
    op: 'replace',
    value,
    axis: 'relational',
    source: 'derived',
    storyTime,
  } as WorldPatch;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. detectAxisPerspectiveGaps（纯代码段：per-axis gap 检测，复用 6.1）
// ════════════════════════════════════════════════════════════════════════════

describe('detectAxisPerspectiveGaps', () => {
  it('认知轴 layered value（objective != reader_perceived）→ 产 gap', () => {
    const patches: WorldPatch[] = [
      cognitivePatch('erina', '/believes/国王', {
        objective: '怀疑国王是暴君',
        reader_perceived: '效忠国王',
      }),
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].axis).toBe('cognitive');
    expect(gaps[0].subjectId).toBe('erina');
    expect(gaps[0].factPath).toBe('/believes/国王');
    expect(gaps[0].divergences).toContain('objective_vs_reader');
    expect(gaps[0].objective).toBe('怀疑国王是暴君');
    expect(gaps[0].readerPerceived).toBe('效忠国王');
  });

  it('认知轴 layered value（objective == reader_perceived）→ 无 gap（无分歧）', () => {
    const patches: WorldPatch[] = [
      cognitivePatch('erina', '/believes/国王', {
        objective: '效忠国王',
        reader_perceived: '效忠国王',
      }),
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    expect(gaps).toEqual([]);
  });

  it('认知轴单值 value（无分层）→ 无 gap（within-轴 仅一视图无法分歧）', () => {
    const patches: WorldPatch[] = [
      cognitivePatch('erina', '/knows/秘密', '真相是X'),
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    expect(gaps).toEqual([]);
  });

  it('关系轴 layered value → 产 gap', () => {
    const patches: WorldPatch[] = [
      relationalPatch('erina', '/relationship/kael', {
        objective: '盟友',
        reader_perceived: '敌人',
      }),
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].axis).toBe('relational');
    expect(gaps[0].divergences).toContain('objective_vs_reader');
  });

  it('多 subject + 多轴 → per-axis per-subject gaps（不跨轴 join）', () => {
    const patches: WorldPatch[] = [
      cognitivePatch('erina', '/believes/国王', { objective: '怀疑', reader_perceived: '效忠' }),
      cognitivePatch('kael', '/suspects/队长', { objective: '忠诚', reader_perceived: '叛徒' }),
      relationalPatch('erina', '/relationship/国王', { objective: '暴君', reader_perceived: '明君' }),
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    expect(gaps).toHaveLength(3);
    // 2 个 cognitive gap + 1 个 relational gap（不跨轴 join erina 的认知+关系 gap）。
    const cognitiveGaps = gaps.filter((g) => g.axis === 'cognitive');
    const relationalGaps = gaps.filter((g) => g.axis === 'relational');
    expect(cognitiveGaps).toHaveLength(2);
    expect(relationalGaps).toHaveLength(1);
  });

  it('嵌套 path 分层 value（如 /believes/世界/本质 layered）→ 递归发现', () => {
    const patches: WorldPatch[] = [
      cognitivePatch('erina', '/believes', {
        世界: { 本质: { objective: '残酷', reader_perceived: '美好' } },
      }),
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].factPath).toBe('/believes/世界/本质');
  });

  it('无 cognitive/relational patches → 空数组', () => {
    const patches: WorldPatch[] = [
      { ...cognitivePatch('a', '/x', 1), axis: 'physical' } as WorldPatch,
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    expect(gaps).toEqual([]);
  });

  // 🔑 范式红线单测：gap 检测输出仅 `*_vs_*` 方向，**不命名叙事工具**。
  it('🔑 范式红线：gap 输出仅 *_vs_* 方向（不命名伏笔/戏剧反讽/悬念/误导）', () => {
    // dramatic_irony 与 suspense 纯结构上重叠（都 reader>character）——纯代码不可区分，故 detectPerspectiveGap
    // 只报方向。检测产物 divergences 全是 `*_vs_*` 形态，无叙事工具命名（命名归 LLM 段）。
    const patches: WorldPatch[] = [
      cognitivePatch('erina', '/believes/国王', { objective: '暴君', reader_perceived: '明君' }),
    ];
    const gaps = detectAxisPerspectiveGaps(patches);
    for (const gap of gaps) {
      for (const d of gap.divergences) {
        expect(d).toMatch(/_vs_/);
        // 不含叙事工具名（伏笔/戏剧反讽/悬念/误导/suspense/dramatic_irony/foreshadow/misdirection）。
        expect(d).not.toMatch(/伏笔|戏剧反讽|悬念|误导|suspense|dramatic|foreshadow|misdirection/i);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. parsePromiseEmergenceOutput（LLM 段输出解析）
// ════════════════════════════════════════════════════════════════════════════

const LLM_OUTPUT = {
  actions: [
    {
      type: 'add_promise',
      promise: {
        id: 'promise-king-tyranny',
        title: '国王暴君真相',
        summary: '读者以为国王是明君，实际是暴君',
        category: 'setup_payoff',
        importance: 0.8,
      },
      firstBeat: {
        promiseId: 'promise-king-tyranny',
        sceneRef: 's_court',
        kind: 'plant',
        grounding: '国王在朝堂上露出慈祥的微笑',
        emergedFromGap: { factPath: '/believes/国王', divergences: ['objective_vs_reader'] },
      },
    },
    // 坏条目：缺必填 summary → safeParse 丢
    { type: 'add_promise', promise: { id: 'bad', title: '无 summary' } },
    {
      type: 'add_beat',
      beat: {
        promiseId: 'promise-existing',
        sceneRef: 's_tavern',
        kind: 'advance',
        grounding: '主角发现密信',
      },
    },
    // 坏条目：非法 type → safeParse 丢
    { type: 'bogus_op', foo: 'bar' },
  ],
};

describe('parsePromiseEmergenceOutput', () => {
  it('裸 JSON {actions:[...]} → PromiseAction[]（坏条目丢弃，好条目保留）', () => {
    const actions = parsePromiseEmergenceOutput(JSON.stringify(LLM_OUTPUT));
    // 2 个好条目（add_promise + add_beat），2 个坏条目丢
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe('add_promise');
    expect(actions[1].type).toBe('add_beat');
  });

  it('```json 围栏 + 前导文字 → extractJson 剥离后 parse 成功', () => {
    const fenced = `这是涌现登记结果：\n\`\`\`json\n${JSON.stringify(LLM_OUTPUT)}\n\`\`\``;
    const actions = parsePromiseEmergenceOutput(fenced);
    expect(actions).toHaveLength(2);
  });

  it('裸数组 [...] → 归一为 actions', () => {
    const arr = JSON.stringify(LLM_OUTPUT.actions);
    const actions = parsePromiseEmergenceOutput(arr);
    expect(actions).toHaveLength(2);
  });

  it('root 非 JSON → 抛（触发 createLlmNode 重试/兜底）', () => {
    expect(() => parsePromiseEmergenceOutput('not json at all')).toThrow();
  });

  it('add_promise firstBeat 带 grounding + emergedFromGap（落地公理 + 审计锚）', () => {
    const actions = parsePromiseEmergenceOutput(JSON.stringify(LLM_OUTPUT));
    const addPromise = actions[0] as Extract<PromiseAction, { type: 'add_promise' }>;
    expect(addPromise.firstBeat).toBeDefined();
    expect(addPromise.firstBeat!.grounding).toBe('国王在朝堂上露出慈祥的微笑');
    expect(addPromise.firstBeat!.emergedFromGap).toEqual({
      factPath: '/believes/国王',
      divergences: ['objective_vs_reader'],
    });
  });

  // 🔑 范式红线单测：涌现产物含 LLM 命名（category tags），与段 1 纯代码 gap 检测输出（仅方向）对偶。
  it('🔑 范式红线：涌现产物含 LLM 命名（category tags），与段 1 纯代码输出（方向）对偶', () => {
    // 段 1（detectAxisPerspectiveGaps）输出仅 *_vs_* 方向（见上「范式红线」test）。
    // 段 2（parsePromiseEmergenceOutput）输出含 LLM 命名的 category（setup_payoff/prophecy/motif/mirror）——
    // 叙事工具命名归 LLM，纯代码不命名。两段分工正确。
    const actions = parsePromiseEmergenceOutput(JSON.stringify(LLM_OUTPUT));
    const addPromise = actions[0] as Extract<PromiseAction, { type: 'add_promise' }>;
    expect(addPromise.promise.category).toBe('setup_payoff');
    // category 是 LLM 命名产物（叙事工具分类），非纯代码结构比较输出。
    expect(['setup_payoff', 'prophecy', 'motif', 'mirror']).toContain(addPromise.promise.category);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. createPromiseEmergenceNode（节点契约 + run 行为 + CR-E3 graceful）
// ════════════════════════════════════════════════════════════════════════════

describe('createPromiseEmergenceNode', () => {
  it('契约：required=[world_state.events, draft.initial, scene_graph]，produced=[promise_emergence]', () => {
    const node = createPromiseEmergenceNode({ generate: vi.fn() });
    expect(node.contract?.nodeId).toBe('promise-emergence-node');
    expect(node.contract?.requiredArtifactKeys).toEqual(['world_state.events', 'draft.initial', 'scene_graph']);
    expect(node.contract?.producedArtifactKeys).toEqual(['promise_emergence']);
    expect(node.contract?.sideEffects).toContain('persist_artifact');
  });

  it('CR-E3: query_world_slice 工具未注册（无 patches）→ 空 artifact + skipped，不破 chain', async () => {
    // registry 在 vitest 隔离模块图中（builtin-cognition.test.ts registerBuiltinTools 注册 cognition/info tools
    // 但不注册 query_world_slice）→ fetchWorldPatchesViaTool 返 undefined → graceful skip。
    const generate = vi.fn<GenerateFn>();
    const node = createPromiseEmergenceNode({ generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '国王微笑着走向王座。' },
        'world_state.events': { writes: [], totalPatches: 0, totalSubjects: 0, writeErrors: [] },
        scene_graph: { nodes: [], edges: [], lines: [] },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('promise_emergence');
    const art = result.artifact as PromiseEmergenceArtifact;
    expect(art.actionsProduced).toBe(0);
    expect(art.skipped).toMatch(/no world-state patches/);
    // LLM 未被调（无 gaps → 跳 LLM）。
    expect(generate).not.toHaveBeenCalled();
  });

  it('CR-E3: LLM 返畸形 JSON 两次 → 空 artifact + skipped，不破 chain', async () => {
    // 注册 mock query_world_slice 返有 layered value 的 cognitive patches → 段 1 产 gap → 调 LLM → LLM 失败。
    registry.register({
      id: 'query_world_slice',
      description: 'mock',
      parameters: (await import('zod')).z.object({}),
      async execute() {
        return {
          title: 'mock',
          output: '',
          metadata: {
            slices: [
              {
                storyTime: 5,
                patches: [
                  cognitivePatch('erina', '/believes/国王', {
                    objective: '暴君',
                    reader_perceived: '明君',
                  }),
                ],
              },
            ],
          },
        };
      },
    });

    const generate = vi.fn<GenerateFn>(async () => ({ content: 'totally not json', finishReason: 'stop' }));
    const node = createPromiseEmergenceNode({ generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '国王微笑。' },
        'world_state.events': { writes: [], totalPatches: 0, totalSubjects: 0, writeErrors: [] },
        scene_graph: { nodes: [], edges: [], lines: [] },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('promise_emergence');
    const art = result.artifact as PromiseEmergenceArtifact;
    expect(art.gapsDetected).toBe(1);
    expect(art.actionsProduced).toBe(0);
    expect(art.skipped).toMatch(/LLM emergence failed/);
    // generate 重试两次（createLlmNode 重试机制）。
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('A1 happy path: gaps → LLM 产 add_promise → 调 promise_ledger_update builtin（autoApply:true）→ applied=true 落盘', async () => {
    // 🔑 A1（CR-A1 critical，block AC2）：emergence 传 autoApply:true 让 handler 直接落盘 creative field
    // （mirror 6.6 world-state 自动写 closure_world_patch），非返 field_patch envelope 经 PatchReview。
    // 本测验证 agent 侧：builtin 被调时 params 含 autoApply:true + 段产 applied=true artifact。
    // （shell 侧 handler 真落盘验 onFieldEdited 见 promiseLedgerHandlers.test.ts「autoApply」suite。）
    // query_world_slice 已注册（上 test 注册的 mock 在同模块图沿用——返 cognitive gap patches）。
    // 注册 mock query_promise（既有 Promise 列表）+ mock promise_ledger_update（验 autoApply 入参 + 返 applied metadata）。
    registry.register({
      id: 'query_promise',
      description: 'mock',
      parameters: (await import('zod')).z.object({}),
      async execute() {
        return { title: 'mock', output: '', metadata: { promises: [], beats: [] } };
      },
    });
    // mock promise_ledger_update：断言被调时 params.autoApply===true（A1 关键），返 applied metadata（非 field_patch）。
    const updateExecute = vi.fn(async (params: Record<string, unknown>) => {
      // 🔑 A1 核心断言：emergence 调时传 autoApply:true（绕开 PatchReview 直接落盘）。
      expect(params.autoApply).toBe(true);
      expect(Array.isArray(params.actions)).toBe(true);
      return {
        title: 'mock',
        output: 'applied',
        metadata: { ok: true, applied: true, promiseCount: 1, beatCount: 1 },
      };
    });
    registry.register({
      id: 'promise_ledger_update',
      description: 'mock',
      parameters: (await import('zod')).z.object({}),
      execute: updateExecute,
    });

    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({
        actions: [
          {
            type: 'add_promise',
            promise: {
              id: 'promise-king',
              title: '国王暴君',
              summary: '读者误信国王是明君',
              category: 'setup_payoff',
            },
            firstBeat: {
              promiseId: 'promise-king',
              sceneRef: 's_court',
              kind: 'plant',
              grounding: '国王露出慈祥微笑',
            },
          },
        ],
      }),
      finishReason: 'stop',
    }));
    const node = createPromiseEmergenceNode({ generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '国王微笑着走向王座。' },
        'world_state.events': { writes: [], totalPatches: 0, totalSubjects: 0, writeErrors: [] },
        scene_graph: { nodes: [], edges: [], lines: [] },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('promise_emergence');
    const art = result.artifact as PromiseEmergenceArtifact;
    expect(art.gapsDetected).toBe(1);
    expect(art.actionsProduced).toBe(1);
    expect(art.skipped).toBeUndefined();
    // A1：builtin 被调一次（autoApply:true，上面 mock 内断言）。
    expect(updateExecute).toHaveBeenCalledTimes(1);
    // A1：artifact 记 applied=true（落盘成功信号，mirror 6.6 world-state 自动写）。
    expect(art.applied).toBe(true);
    // fieldPatch 记录 handler 返的 metadata（{ok,applied,promiseCount,beatCount}，审计用）。
    expect(art.fieldPatch).toMatchObject({ ok: true, applied: true, promiseCount: 1, beatCount: 1 });
    expect(art.writeError).toBeUndefined();
  });

  it('A1 graceful: promise_ledger_update builtin 抛错 → 记 writeError，不破 chain（applied 不设）', async () => {
    // emergence graceful：builtin 抛（handler autoApply 落盘失败 / locked field / save error）→ 记 writeError，
    // artifact 仍正常产（applied 不设），chain 不破（mirror 6.6 world-state writeErrors 哲学）。
    // query_world_slice mock 沿用（返 cognitive gap patches）。
    registry.register({
      id: 'promise_ledger_update',
      description: 'mock',
      parameters: (await import('zod')).z.object({}),
      async execute() {
        throw new Error('Field promise_registry is locked and cannot be edited');
      },
    });

    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({
        actions: [
          {
            type: 'add_promise',
            promise: { id: 'p1', title: 'T', summary: 'S' },
            firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
          },
        ],
      }),
      finishReason: 'stop',
    }));
    const node = createPromiseEmergenceNode({ generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '正文。' },
        'world_state.events': { writes: [], totalPatches: 0, totalSubjects: 0, writeErrors: [] },
        scene_graph: { nodes: [], edges: [], lines: [] },
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('promise_emergence');
    const art = result.artifact as PromiseEmergenceArtifact;
    expect(art.actionsProduced).toBe(1);
    // applied 不设（落盘失败）+ writeError 记 locked 错误。
    expect(art.applied).toBeUndefined();
    expect(art.writeError).toMatch(/locked/);
  });

  it('CR 批 CR-4：LLM 超额产出 60 条 → artifact.actions 封顶 50 + actionsProduced 保全量；builtin 落盘不受 cap 影响（携全量）', async () => {
    // query_world_slice mock 沿用（返 cognitive gap patches → 段 1 产 gap → 段 2 LLM）。
    // promise_ledger_update mock 捕获实收 actions——验「落盘全量、artifact 观测面封顶」两侧分离。
    const received: unknown[] = [];
    registry.register({
      id: 'promise_ledger_update',
      description: 'mock',
      parameters: (await import('zod')).z.object({}),
      async execute(params) {
        const rec = params as { actions?: unknown[] };
        received.push(...(rec.actions ?? []));
        return { title: 'mock', output: '', metadata: { ok: true, applied: true, promiseCount: 0, beatCount: 60 } };
      },
    });
    // remove_beat 是 schema 最小形态（type + beatId）——60 条全过逐条 safeParse。
    const actions = Array.from({ length: 60 }, (_, i) => ({ type: 'remove_beat', beatId: `b-${i}` }));
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({ actions }),
      finishReason: 'stop',
    }));
    const node = createPromiseEmergenceNode({ generate });
    const result = await node.run({
      run: makeRun({
        'draft.initial': { text: '国王微笑。' },
        'world_state.events': { writes: [], totalPatches: 0, totalSubjects: 0, writeErrors: [] },
        scene_graph: { nodes: [], edges: [], lines: [] },
      }),
      requirement: '',
    });
    const art = result.artifact as PromiseEmergenceArtifact;
    // 全量计数保真（投影 total 的数据源——截断可观测「N/total」）。
    expect(art.actionsProduced).toBe(60);
    // artifact 侧封顶 50（与产出快照投影 cap 同常数——persist chainSnapshot 不膨胀）。
    expect(art.actions).toHaveLength(50);
    expect(art.actions![0]).toEqual({ type: 'remove_beat', beatId: 'b-0' });
    expect(art.actions![49]).toEqual({ type: 'remove_beat', beatId: 'b-49' });
    // 落盘不受 cap 影响：builtin 实收全量 60 条（cap 只管 run.artifacts 观测面）。
    expect(received).toHaveLength(60);
  });
});
