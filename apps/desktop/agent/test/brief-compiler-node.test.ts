import { describe, expect, it } from 'vitest';
import {
  sceneNodeSchema,
  episodeOutlineSchema,
  promiseRegistrySchema,
  infoReleaseMapSchema,
  type SceneGraph,
  type PromiseRegistry,
  type InfoReleaseMap,
} from '@orison/shared-contracts';
import { createBriefCompilerNode } from '../src/nodes/brief-compiler-node';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.3 / implement.md 3.6：brief-compiler-node（纯代码节点）。
// 核心断言：
// 1. #6 plotPoints 正确 filter 本章场（episodeId 直挂 + presentationSpans M:N 命中）
// 2. 连续性标注正确（从前章续入 / 本章内 / 续到后章 / 跨章场）
// 3. LLM 段 #1-5,10 透传 chapter_brief_input
// 4. #7/#8 undefined 空容忍（不造假）
// 5. Zod parse 确保 shape（chapterBriefSchema 全 optional）
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_brief',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

// episode_outlines fixture（ep1<ep2<ep3，index 决定前后序）
const EPISODES = [
  episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
  episodeOutlineSchema.parse({ id: 'ep2', index: 1, title: '第二章' }),
  episodeOutlineSchema.parse({ id: 'ep3', index: 2, title: '第三章' }),
];

// 目标 episode = ep2（index 1）
const TARGET_EPISODE = 'ep2';

/** 构造 valid SceneNode（schema.parse 填默认，避免漏 required 字段）。 */
function scene(partial: Record<string, unknown>) {
  return sceneNodeSchema.parse({
    storyTime: 0,
    presentationOrder: { chapter: 0, pos: 0 },
    ...partial,
  });
}

// 7 场覆盖矩阵：
// - s_single：episodeId=ep2，无 spans → 单章场（1.1 行为）→ '本章内'
// - s_only：spans=[ep2] → 仅本章 → '本章内'
// - s_forward：spans=[ep2,ep3] → hasAfter → '续到后章'
// - s_backward：spans=[ep1,ep2] → hasBefore → '从前章续入'
// - s_cross：spans=[ep1,ep2,ep3] → before+after → '跨章场'
// - s_other_episode：episodeId=ep1，无 spans → 不命中 → 排除
// - s_spans_miss：spans=[ep1,ep3]（不含 ep2）→ 不命中 → 排除
function buildSceneGraph(): SceneGraph {
  return {
    nodes: [
      scene({ id: 's_single', episodeId: TARGET_EPISODE }),
      scene({ id: 's_only', presentationSpans: [{ episodeId: TARGET_EPISODE, pos: 0 }] }),
      scene({ id: 's_forward', presentationSpans: [{ episodeId: TARGET_EPISODE, pos: 0 }, { episodeId: 'ep3', pos: 0 }] }),
      scene({ id: 's_backward', presentationSpans: [{ episodeId: 'ep1', pos: 0 }, { episodeId: TARGET_EPISODE, pos: 0 }] }),
      scene({ id: 's_cross', presentationSpans: [{ episodeId: 'ep1', pos: 0 }, { episodeId: TARGET_EPISODE, pos: 0 }, { episodeId: 'ep3', pos: 0 }] }),
      scene({ id: 's_other_episode', episodeId: 'ep1' }),
      scene({ id: 's_spans_miss', presentationSpans: [{ episodeId: 'ep1', pos: 0 }, { episodeId: 'ep3', pos: 0 }] }),
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };
}

describe('brief-compiler-node — #6 plotPoints 汇编（filter + 连续性）', () => {
  it('filter 本章场：episodeId 直挂 + presentationSpans M:N 命中；排除不命中场', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: { sceneId: string; continuity?: string }[] };
    const ids = brief.plotPoints.map((p) => p.sceneId);
    // 命中 5 场（s_single/s_only/s_forward/s_backward/s_cross），排除 s_other_episode/s_spans_miss
    expect(ids).toEqual(['s_single', 's_only', 's_forward', 's_backward', 's_cross']);
  });

  it('连续性标注：单章场/本章内/续到后章/从前章续入/跨章场', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: { sceneId: string; continuity?: string }[] };
    const byId = Object.fromEntries(brief.plotPoints.map((p) => [p.sceneId, p.continuity]));
    expect(byId.s_single).toBe('本章内'); // 无 spans（1.1 单章场）
    expect(byId.s_only).toBe('本章内'); // spans 仅 [N]
    expect(byId.s_forward).toBe('续到后章'); // [N, N+1]
    expect(byId.s_backward).toBe('从前章续入'); // [N-1, N]
    expect(byId.s_cross).toBe('跨章场'); // [N-1, N, N+1]
  });

  it('每场 plotPoint 含 stateAtT: undefined（6.6 占位不造假）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: { stateAtT?: unknown }[] };
    for (const p of brief.plotPoints) {
      expect('stateAtT' in p).toBe(true);
      expect(p.stateAtT).toBeUndefined();
    }
  });
});

describe('brief-compiler-node — LLM 段透传 + #7/8/9 空', () => {
  it('LLM 段 #1-5,10 透传 chapter_brief_input.brief', async () => {
    const node = createBriefCompilerNode();
    const leaderBrief = {
      goal: '主角抵达 B 城',
      ending: '城门关闭前一刻进入',
      pov: '第三人称限知（主角视角）',
      tone: '紧迫',
      readerKnows: '读者知道追兵在后',
      protagonistKnows: '主角不知道前方有埋伏',
      mustHide: '主角的真实身份',
      hintOnly: '城门的异常',
      pacing: '快节奏推进',
      opening: '黄昏荒野',
      nextHook: '城门后的阴影',
      doNotWrite: '主角的过去回忆',
      emotionTarget: { emotion: '紧张', emotionEnd: '释然', vad: { v: -0.5, a: 0.8, d: 0.1 }, steer: '制造窒息感再松一口气' },
    };

    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: leaderBrief },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as Record<string, unknown>;
    // LLM 段全透传
    expect(brief.goal).toBe(leaderBrief.goal);
    expect(brief.ending).toBe(leaderBrief.ending);
    expect(brief.mustHide).toBe(leaderBrief.mustHide);
    expect(brief.doNotWrite).toBe(leaderBrief.doNotWrite);
    expect(brief.emotionTarget).toEqual(leaderBrief.emotionTarget);
    // #6 汇编在场
    expect(Array.isArray(brief.plotPoints)).toBe(true);
    expect((brief.plotPoints as unknown[]).length).toBe(5);
  });

  it('#7 promiseTasks=[]（6.5 compilePromiseTasks 缺源降级空）；#8 openDecisions=[]（story_decisions 缺 → graceful）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as Record<string, unknown>;
    // #7 promise_registry artifact 缺 → compilePromiseTasks 返回 []（graceful，6.5；不造假但不留 undefined）
    expect(brief.promiseTasks).toEqual([]);
    // #8 story_decisions artifact 缺 → compileOpenDecisions 返回 []（graceful，4.1 Step 3）
    expect(brief.openDecisions).toEqual([]);
  });
});

describe('brief-compiler-node — 降级 / 兼容形态', () => {
  it('raw ChapterBrief 形态（无 episodeId 包装）：episodeId 退到 requirement fallback', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { goal: 'raw brief 无 episodeId 字段' }, // raw ChapterBrief
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: TARGET_EPISODE, // requirement 作 episodeId 兜底
    });

    const brief = result.artifact as { plotPoints: unknown[]; goal: string };
    expect(brief.goal).toBe('raw brief 无 episodeId 字段'); // raw brief 透传
    expect(brief.plotPoints.length).toBe(5); // episodeId 从 requirement 解出 → filter 命中
  });

  it('缺 episode_outlines：M:N 场连续性降级 undefined（单章场仍 本章内）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        // 不注入 episode_outlines
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: { sceneId: string; continuity?: string }[] };
    const byId = Object.fromEntries(brief.plotPoints.map((p) => [p.sceneId, p.continuity]));
    // 单章场无 spans，不需 index 解析 → 仍 '本章内'
    expect(byId.s_single).toBe('本章内');
    // M:N 场需 index 排序，缺 episode_outlines → undefined（诚实不造假）
    expect(byId.s_forward).toBeUndefined();
    expect(byId.s_backward).toBeUndefined();
    expect(byId.s_cross).toBeUndefined();
    // s_only spans 仅 [target]，即便无 index 也 only-target → '本章内'（spans 全等 target，hasBefore/After 均无）
    expect(byId.s_only).toBe('本章内');
  });

  it('缺 scene_graph：plotPoints 空数组（graceful，不抛）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
      }),
      requirement: '',
    });

    const brief = result.artifact as { plotPoints: unknown[]; goal: string };
    expect(brief.plotPoints).toEqual([]);
    expect(brief.goal).toBe('g'); // LLM 段仍透传
  });

  it('缺 chapter_brief_input：空 brief + requirement 兜底 episodeId', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({ scene_graph: buildSceneGraph(), episode_outlines: EPISODES }),
      requirement: TARGET_EPISODE,
    });

    expect(result.stateKey).toBe('chapter_brief');
    const brief = result.artifact as { plotPoints: unknown[] };
    expect(brief.plotPoints.length).toBe(5); // requirement 兜底 → 命中
  });

  it('leader brief 带额外字段：Zod parse 剥离（chapterBriefSchema 守 shape）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: TARGET_EPISODE,
          brief: { goal: 'g', rogue: 'unknown field', emotionTarget: { emotion: 'v' } },
        },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });

    const brief = result.artifact as Record<string, unknown>;
    expect(brief.rogue).toBeUndefined(); // schema 外字段被 parse 剥离
    expect(brief.goal).toBe('g');
  });
});

describe('brief-compiler-node — 契约 + stateKey', () => {
  it('contract 元数据正确（brief-compiler-node）', () => {
    const node = createBriefCompilerNode();
    expect(node.contract?.nodeId).toBe('brief-compiler-node');
    expect(node.contract?.producedArtifactKeys).toContain('chapter_brief');
    expect(node.contract?.requiredArtifactKeys).toEqual(['chapter_brief_input', 'scene_graph']);
  });

  it('stateKey=draft... no, stateKey=chapter_brief', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('chapter_brief');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.1 §3.2：brief-compiler-node run() 产 chapter_brief 时填 readiness 就绪阶梯。
// readiness 由 computeReadiness 算（纯代码：scene_graph 结构 + settings_context 非空 + brief.goal）。
// 5 档：needs_plot / needs_world_anchor / needs_world_context / needs_chapter_brief / ready。
// ─────────────────────────────────────────────────────────────────────────────

describe('brief-compiler-node — readiness 就绪阶梯（4.1 §3.2，纯代码填）', () => {
  const SETTINGS = '设定前缀非空（settings_context present）';

  it('needs_plot：scene_graph 全空（nodes=[]）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: { nodes: [], edges: [], lines: [], art_overrides: [], version: 0, updatedBy: 'agent' },
        settings_context: SETTINGS,
      }),
      requirement: '',
    });
    expect((result.artifact as { readiness: string }).readiness).toBe('needs_plot');
  });

  it('needs_plot：缺 scene_graph artifact', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        settings_context: SETTINGS,
      }),
      requirement: '',
    });
    expect((result.artifact as { readiness: string }).readiness).toBe('needs_plot');
  });

  it('needs_world_anchor：有场但 settings_context 空', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        settings_context: '', // 设定锚点空
      }),
      requirement: '',
    });
    expect((result.artifact as { readiness: string }).readiness).toBe('needs_world_anchor');
  });

  it('needs_world_anchor：settings_context 缺省（undefined）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        // 无 settings_context artifact
      }),
      requirement: '',
    });
    expect((result.artifact as { readiness: string }).readiness).toBe('needs_world_anchor');
  });

  it('needs_world_context：有场+设定但 brief.goal 空', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} }, // goal 缺
        scene_graph: buildSceneGraph(),
        settings_context: SETTINGS,
      }),
      requirement: '',
    });
    expect((result.artifact as { readiness: string }).readiness).toBe('needs_world_context');
  });

  it('needs_chapter_brief：有场+设定+LLM 意图但本章 episode 无匹配场', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        // ep_nomatch 在 buildSceneGraph 的场里不存在（场只挂 ep1/ep2/ep3）
        chapter_brief_input: { episodeId: 'ep_nomatch', brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        settings_context: SETTINGS,
      }),
      requirement: '',
    });
    expect((result.artifact as { readiness: string }).readiness).toBe('needs_chapter_brief');
  });

  it('ready：全 populated（场匹配 episode + 设定 + goal）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: '主角抵达 B 城' } },
        scene_graph: buildSceneGraph(),
        settings_context: SETTINGS,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readiness: string; plotPoints: unknown[] };
    expect(brief.readiness).toBe('ready');
    expect(brief.plotPoints.length).toBe(5); // plotPoints 仍汇编（readiness 不影响 #6）
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.1 Step 3（design §3.5）：brief-compiler-node #8 openDecisions 汇编。
// 纯代码段 from story_decisions artifact：filter status:'open' + relatedEpisodeId 命中本章 / 全局 open，
// 投影到 {id, summary, risk}（brief #8 警告子集）。graceful：artifact 缺 / 空 / 非数组 → []。
// ─────────────────────────────────────────────────────────────────────────────

/** 合法 StoryDecision fixture（storyDecisionSchema shape；alternatives/status/source 走 default）。 */
function decision(partial: Record<string, unknown>): unknown {
  return {
    id: 'd_x',
    summary: '决策摘要',
    reason: '创作意图',
    risk: '风险描述',
    createdAt: '2026-08-01T00:00:00Z',
    ...partial,
  };
}

describe('brief-compiler-node — #8 openDecisions 汇编（4.1 Step 3，纯代码）', () => {
  it('filter open：open 命中本章 relatedEpisodeId → 进 openDecisions', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        story_decisions: [
          decision({ id: 'd1', summary: '本章决策 A', risk: '风险 A', status: 'open', relatedEpisodeId: TARGET_EPISODE }),
        ],
      }),
      requirement: '',
    });
    const brief = result.artifact as { openDecisions: Array<{ id: string; summary: string; risk: string }> };
    expect(brief.openDecisions).toEqual([{ id: 'd1', summary: '本章决策 A', risk: '风险 A' }]);
  });

  it('全局 open 决策（relatedEpisodeId 缺省）→ 进 openDecisions（所有章警告）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        story_decisions: [
          decision({ id: 'd_global', summary: '全局决策', risk: '全局风险', status: 'open' }), // 无 relatedEpisodeId
        ],
      }),
      requirement: '',
    });
    const brief = result.artifact as { openDecisions: Array<{ id: string }> };
    expect(brief.openDecisions.map((d) => d.id)).toEqual(['d_global']);
  });

  it('open 决策 relatedEpisodeId 命中它章 → 不进（本章过滤）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} }, // 目标 ep2
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        story_decisions: [
          decision({ id: 'd_other', status: 'open', relatedEpisodeId: 'ep1' }), // 他章 open
          decision({ id: 'd_mine', status: 'open', relatedEpisodeId: TARGET_EPISODE }), // 本章 open
        ],
      }),
      requirement: '',
    });
    const brief = result.artifact as { openDecisions: Array<{ id: string }> };
    expect(brief.openDecisions.map((d) => d.id)).toEqual(['d_mine']);
  });

  it('decided / superseded / dropped 不进 openDecisions（仅 open）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        story_decisions: [
          decision({ id: 'd_decided', status: 'decided', relatedEpisodeId: TARGET_EPISODE }),
          decision({ id: 'd_superseded', status: 'superseded', supersededBy: 'd_x', relatedEpisodeId: TARGET_EPISODE }),
          decision({ id: 'd_dropped', status: 'dropped', relatedEpisodeId: TARGET_EPISODE }),
          decision({ id: 'd_open', status: 'open', relatedEpisodeId: TARGET_EPISODE }),
        ],
      }),
      requirement: '',
    });
    const brief = result.artifact as { openDecisions: Array<{ id: string }> };
    expect(brief.openDecisions.map((d) => d.id)).toEqual(['d_open']);
  });

  it('投影到 {id, summary, risk}：不携带 reason/alternatives/status 等其它字段（brief 警告子集）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        story_decisions: [
          decision({
            id: 'd1',
            summary: 'S',
            reason: 'R',
            alternatives: ['A', 'B'],
            risk: 'RK',
            status: 'open',
            source: 'director',
            landingState: '已落地',
            relatedEpisodeId: TARGET_EPISODE,
            createdAt: '2026-08-01T00:00:00Z',
          }),
        ],
      }),
      requirement: '',
    });
    const brief = result.artifact as { openDecisions: Array<Record<string, unknown>> };
    expect(brief.openDecisions).toHaveLength(1);
    // 只含 pick 的三字段（chapter-brief #8 收紧 shape 守门）
    expect(brief.openDecisions[0]).toEqual({ id: 'd1', summary: 'S', risk: 'RK' });
  });

  it('story_decisions 空数组 → openDecisions=[]（graceful）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        story_decisions: [],
      }),
      requirement: '',
    });
    expect((result.artifact as { openDecisions: unknown[] }).openDecisions).toEqual([]);
  });

  it('story_decisions 非数组（坏形态）→ openDecisions=[]（graceful，不抛）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        story_decisions: { not: 'an array' },
      }),
      requirement: '',
    });
    expect((result.artifact as { openDecisions: unknown[] }).openDecisions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.5 §7：brief-compiler-node #7 promiseTasks 汇编。
// 纯代码段 from promise_registry artifact（assembleChapterChainArtifacts 注入）：filter 本章相关 beats
// （episodeId 匹配 OR sceneRef ∈ 本章 scenes）+ 所在 Promise 非 abandoned → join promise 主体 →
// BriefPromiseTask[]。graceful：artifact 缺 / beats 空 / 无本章命中 → []（不造假）。
// 范式判据：filter + join = 纯代码查询，非语义（不判「该不该推进」归 emergence LLM 登记）。
// ─────────────────────────────────────────────────────────────────────────────

/** 合法 PromiseEntry fixture（promiseEntrySchema shape；defaults 走 schema.parse 填）。 */
function promise(partial: Record<string, unknown>): PromiseRegistry['promises'][number] {
  return promiseRegistrySchema.parse({
    promises: [{ id: 'p_x', title: 'T', summary: 'S', ...partial }],
    beats: [],
  }).promises[0];
}

/** 合法 PromiseBeat fixture（promiseBeatSchema shape）。 */
function beat(partial: Record<string, unknown>): PromiseRegistry['beats'][number] {
  return promiseRegistrySchema.parse({
    promises: [],
    beats: [{ id: 'b_x', promiseId: 'p_x', sceneRef: 's_single', kind: 'plant', ...partial }],
  }).beats[0];
}

/** 构造 PromiseRegistry（promises + beats fixture 拼装，schema.parse 归一 defaults）。 */
function makePromiseRegistry(
  promises: Record<string, unknown>[],
  beats: Record<string, unknown>[],
): PromiseRegistry {
  return promiseRegistrySchema.parse({ promises, beats });
}

describe('brief-compiler-node — #7 promiseTasks 汇编（6.5，纯代码）', () => {
  it('filter 本章相关：beat.episodeId 匹配 OR beat.sceneRef ∈ 本章 scenes', async () => {
    const node = createBriefCompilerNode();
    const registry = makePromiseRegistry(
      [promise({ id: 'p1', title: '国王真相', summary: '读者以为明君实为暴君' })],
      [
        // episodeId 命中本章（ep2）→ 进
        beat({ id: 'b_ep', promiseId: 'p1', sceneRef: 's_other_episode', episodeId: TARGET_EPISODE, kind: 'plant' }),
        // sceneRef 命中本章场 s_single（ep2 内）→ 进
        beat({ id: 'b_sc', promiseId: 'p1', sceneRef: 's_single', kind: 'advance' }),
        // sceneRef 命中本章场 s_forward（ep2 内，跨章场）→ 进
        beat({ id: 'b_x', promiseId: 'p1', sceneRef: 's_forward', kind: 'payoff' }),
        // episodeId 他章 + sceneRef 他章场 → 不进
        beat({ id: 'b_other', promiseId: 'p1', sceneRef: 's_other_episode', episodeId: 'ep1', kind: 'plant' }),
      ],
    );
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        promise_registry: registry,
      }),
      requirement: '',
    });
    const brief = result.artifact as { promiseTasks: Array<{ sceneRef: string; beatKind: string }> };
    // 3 beat 进（b_ep/b_sc/b_x），b_other 排除
    expect(brief.promiseTasks.map((t) => t.sceneRef).sort()).toEqual(['s_forward', 's_other_episode', 's_single']);
  });

  it('join promise 主体：task 含 promiseId/title/summary + 可选 category/payoffExpectation', async () => {
    const node = createBriefCompilerNode();
    const registry = makePromiseRegistry(
      [promise({
        id: 'p1',
        title: '国王真相',
        summary: '读者以为明君实为暴君',
        category: 'dramatic_irony',
        payoffExpectation: '揭露时震撼',
      })],
      [beat({ id: 'b1', promiseId: 'p1', sceneRef: 's_single', episodeId: TARGET_EPISODE, kind: 'plant' })],
    );
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: registry,
      }),
      requirement: '',
    });
    const brief = result.artifact as { promiseTasks: Array<Record<string, unknown>> };
    expect(brief.promiseTasks).toHaveLength(1);
    const task = brief.promiseTasks[0];
    expect(task.promiseId).toBe('p1');
    expect(task.title).toBe('国王真相');
    expect(task.summary).toBe('读者以为明君实为暴君');
    expect(task.category).toBe('dramatic_irony');
    expect(task.payoffExpectation).toBe('揭露时震撼');
  });

  it('beat 字段：beatKind + note + sceneRef 透传', async () => {
    const node = createBriefCompilerNode();
    const registry = makePromiseRegistry(
      [promise({ id: 'p1', title: 'T', summary: 'S' })],
      [beat({
        id: 'b1',
        promiseId: 'p1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        kind: 'advance',
        note: '本次只写到发烫，不许发光',
      })],
    );
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: registry,
      }),
      requirement: '',
    });
    const brief = result.artifact as { promiseTasks: Array<Record<string, unknown>> };
    expect(brief.promiseTasks[0].beatKind).toBe('advance');
    expect(brief.promiseTasks[0].note).toBe('本次只写到发烫，不许发光');
    expect(brief.promiseTasks[0].sceneRef).toBe('s_single');
  });

  it('abandoned 线不下发（promise.status=abandoned → 其 beats 全排除）', async () => {
    const node = createBriefCompilerNode();
    const registry = makePromiseRegistry(
      [
        promise({ id: 'p_open', title: '开放线', summary: '进行中' }),
        promise({ id: 'p_abandon', title: '弃线', summary: '已弃', status: 'abandoned' }),
      ],
      [
        beat({ id: 'b_open', promiseId: 'p_open', sceneRef: 's_single', episodeId: TARGET_EPISODE, kind: 'plant' }),
        beat({ id: 'b_abandon', promiseId: 'p_abandon', sceneRef: 's_single', episodeId: TARGET_EPISODE, kind: 'plant' }),
      ],
    );
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: registry,
      }),
      requirement: '',
    });
    const brief = result.artifact as { promiseTasks: Array<{ promiseId: string }> };
    // 只 p_open 的 beat 进（p_abandon 的 beat 跳过）
    expect(brief.promiseTasks.map((t) => t.promiseId)).toEqual(['p_open']);
  });

  it('同一 Promise 多本章 beat → 多 task（一场一 beat，节拍序列）', async () => {
    const node = createBriefCompilerNode();
    const registry = makePromiseRegistry(
      [promise({ id: 'p1', title: 'T', summary: 'S' })],
      [
        beat({ id: 'b1', promiseId: 'p1', sceneRef: 's_single', episodeId: TARGET_EPISODE, kind: 'plant' }),
        beat({ id: 'b2', promiseId: 'p1', sceneRef: 's_forward', episodeId: TARGET_EPISODE, kind: 'advance' }),
        beat({ id: 'b3', promiseId: 'p1', sceneRef: 's_backward', episodeId: TARGET_EPISODE, kind: 'payoff' }),
      ],
    );
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: registry,
      }),
      requirement: '',
    });
    const brief = result.artifact as { promiseTasks: Array<{ beatKind: string }> };
    expect(brief.promiseTasks).toHaveLength(3);
    expect(brief.promiseTasks.map((t) => t.beatKind).sort()).toEqual(['advance', 'payoff', 'plant']);
  });

  it('graceful：无 promise_registry artifact → promiseTasks=[]（不造假）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        // 不注入 promise_registry
      }),
      requirement: '',
    });
    expect((result.artifact as { promiseTasks: unknown[] }).promiseTasks).toEqual([]);
  });

  it('graceful：promise_registry 坏形态（非对象）→ promiseTasks=[]（不抛）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: 'not a registry',
      }),
      requirement: '',
    });
    expect((result.artifact as { promiseTasks: unknown[] }).promiseTasks).toEqual([]);
  });

  it('graceful：空 registry（promises/beats 空）→ promiseTasks=[]', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: makePromiseRegistry([], []),
      }),
      requirement: '',
    });
    expect((result.artifact as { promiseTasks: unknown[] }).promiseTasks).toEqual([]);
  });

  it('graceful：本章无命中 beat（全他章）→ promiseTasks=[]（不造假）', async () => {
    const node = createBriefCompilerNode();
    const registry = makePromiseRegistry(
      [promise({ id: 'p1', title: 'T', summary: 'S' })],
      [
        beat({ id: 'b1', promiseId: 'p1', sceneRef: 's_other_episode', episodeId: 'ep1', kind: 'plant' }),
        beat({ id: 'b2', promiseId: 'p1', sceneRef: 's_spans_miss', episodeId: 'ep3', kind: 'advance' }),
      ],
    );
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: registry,
      }),
      requirement: '',
    });
    expect((result.artifact as { promiseTasks: unknown[] }).promiseTasks).toEqual([]);
  });

  it('范式红线：compilePromiseTasks 只 filter+join（不判 promise 重要性 / 节拍合不合理）', async () => {
    // 纯代码 filter 不按 importance 过滤、不判 category 是否合理——全本章相关非 abandoned beat 都下发。
    const node = createBriefCompilerNode();
    const registry = makePromiseRegistry(
      [promise({ id: 'p1', title: 'T', summary: 'S', importance: 0.1, category: '自定义奇怪分类' })],
      [beat({ id: 'b1', promiseId: 'p1', sceneRef: 's_single', episodeId: TARGET_EPISODE, kind: 'setback' })],
    );
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        promise_registry: registry,
      }),
      requirement: '',
    });
    const brief = result.artifact as { promiseTasks: Array<Record<string, unknown>> };
    expect(brief.promiseTasks).toHaveLength(1); // 低 importance + 自定义分类仍下发（纯代码不语义裁断）
    expect(brief.promiseTasks[0].beatKind).toBe('setback');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.3 §3 段②：brief-compiler-node #3 信息控制 + manipulationDirectives 汇编。
// 纯代码段 from info_release_map artifact（assembleChapterChainArtifacts 注入）：filter 本章相关 entries
// （episodeId 匹配 OR sceneRef ∈ 本章 scenes）→ 每条 entry.directive 投影 #3 字段（mode→字段结构映射）+
// 收集 manipulationDirectives[]。graceful：artifact 缺 / entries 空 / 无匹配 / 无 directive → 空。
// merge precedence（design §6 CRITICAL）：leader 已填 #3 字段优先，Director compileInfoRelease 只补未填。
// 范式判据：mode→字段 = 纯代码结构映射（不判「该透露什么」归 Director LLM 已判）。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 InfoReleaseMap（entries fixture 拼装，schema.parse 归一 defaults）。 */
function makeInfoReleaseMap(entries: Record<string, unknown>[]): InfoReleaseMap {
  return infoReleaseMapSchema.parse({ entries });
}

describe('brief-compiler-node — #3 compileInfoRelease mode→字段映射（6.3，纯代码）', () => {
  it('reveal_first → readerKnows（前置透露给读者）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first', actions: ['release'], target: '反派出底牌' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string; manipulationDirectives: unknown[] };
    expect(brief.readerKnows).toContain('反派出底牌');
    expect(brief.readerKnows).toContain('已向读者前置透露');
    expect(brief.manipulationDirectives).toHaveLength(1);
  });

  it('sustain_unknown → mustHide（维持未知）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'sustain_unknown', actions: ['withhold'], target: '凶手身份' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { mustHide?: string };
    expect(brief.mustHide).toContain('凶手身份');
    expect(brief.mustHide).toContain('维持未知');
  });

  it('method_foreseen → hintOnly（方法预期，只暗示）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'method_foreseen', actions: ['plant'], target: '解谜方法' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { hintOnly?: string };
    expect(brief.hintOnly).toContain('解谜方法');
    expect(brief.hintOnly).toContain('方法预期');
  });

  it('subjective_mislead → mustHide + hintOnly（主观误导）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'subjective_mislead', actions: ['withhold'], target: '主角动机' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { mustHide?: string; hintOnly?: string };
    expect(brief.mustHide).toContain('主角动机');
    expect(brief.hintOnly).toContain('主角动机');
  });

  it('forbiddenMoves 非空 → mustHide「禁止透露：...」+ manipulationDirectives 收集', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: {
          mode: 'sustain_unknown',
          actions: ['withhold'],
          forbiddenMoves: ['主角真实身份', '凶器位置'],
          target: '主角身份',
        },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      mustHide?: string;
      manipulationDirectives: Array<{ forbiddenMoves?: string[] }>;
    };
    expect(brief.mustHide).toContain('禁止透露');
    expect(brief.mustHide).toContain('主角真实身份');
    expect(brief.mustHide).toContain('凶器位置');
    expect(brief.manipulationDirectives).toHaveLength(1);
    expect(brief.manipulationDirectives[0].forbiddenMoves).toEqual(['主角真实身份', '凶器位置']);
  });

  it('filter 本章相关：episodeId 匹配 OR sceneRef ∈ 本章 scenes', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      // episodeId 命中本章 → 进
      { id: 'ir_ep', sceneRef: 's_other_episode', episodeId: TARGET_EPISODE, directive: { mode: 'reveal_first', actions: ['release'], target: 'A' } },
      // sceneRef 命中本章场 s_single → 进
      { id: 'ir_sc', sceneRef: 's_single', directive: { mode: 'reveal_first', actions: ['release'], target: 'B' } },
      // 他章 + 他场 → 不进
      { id: 'ir_other', sceneRef: 's_other_episode', episodeId: 'ep1', directive: { mode: 'reveal_first', actions: ['release'], target: 'C' } },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string; manipulationDirectives: unknown[] };
    expect(brief.readerKnows).toContain('A');
    expect(brief.readerKnows).toContain('B');
    expect(brief.readerKnows).not.toContain('C');
    expect(brief.manipulationDirectives).toHaveLength(2);
  });

  it('多 entry fragments per field join with ；', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      { id: 'ir1', sceneRef: 's_single', episodeId: TARGET_EPISODE, directive: { mode: 'reveal_first', actions: ['release'], target: 'A' } },
      { id: 'ir2', sceneRef: 's_forward', episodeId: TARGET_EPISODE, directive: { mode: 'reveal_first', actions: ['release'], target: 'B' } },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string };
    expect(brief.readerKnows).toContain('；');
    expect(brief.readerKnows).toContain('A');
    expect(brief.readerKnows).toContain('B');
  });

  it('无 directive 的 entry 跳过（无操控指令不下发）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      { id: 'ir_nodir', sceneRef: 's_single', episodeId: TARGET_EPISODE, reveal: ['仅 reveal 数组无 directive'] },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string; manipulationDirectives?: unknown[] };
    expect(brief.readerKnows).toBeUndefined();
    expect(brief.manipulationDirectives).toBeUndefined();
  });
});

describe('brief-compiler-node — #3 merge precedence（6.3 design §6 CRITICAL，leader 优先）', () => {
  it('leader 已填 mustHide → Director mustHide 不覆盖（leader 优先）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'sustain_unknown', actions: ['withhold'], target: 'Director 隐瞒项' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: TARGET_EPISODE,
          brief: { mustHide: 'leader 已填：主角金手指来源' },
        },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { mustHide?: string };
    // leader 已填优先，Director 编译的 mustHide 不覆盖
    expect(brief.mustHide).toBe('leader 已填：主角金手指来源');
    expect(brief.mustHide).not.toContain('Director 隐瞒项');
  });

  it('leader 未填 readerKnows → Director readerKnows 补上（augment 未填字段）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first', actions: ['release'], target: '反派出底牌' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: TARGET_EPISODE,
          brief: { goal: 'g', mustHide: 'leader 填了 mustHide 但没填 readerKnows' },
        },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string; mustHide?: string };
    // leader 未填 readerKnows → Director 补
    expect(brief.readerKnows).toContain('反派出底牌');
    // leader 已填 mustHide → 保留（不覆盖）
    expect(brief.mustHide).toBe('leader 填了 mustHide 但没填 readerKnows');
  });

  it('leader 部分填 #3（readerKnows+hintOnly 已填，mustHide 未填）→ Director 只补未填', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'subjective_mislead', actions: ['withhold'], target: 'X' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: TARGET_EPISODE,
          brief: {
            readerKnows: 'leader readerKnows',
            hintOnly: 'leader hintOnly',
            // mustHide / protagonistKnows 未填
          },
        },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string; hintOnly?: string; mustHide?: string };
    expect(brief.readerKnows).toBe('leader readerKnows'); // leader 优先
    expect(brief.hintOnly).toBe('leader hintOnly'); // leader 优先（subjective_mislead 的 hintOnly 不覆盖）
    expect(brief.mustHide).toContain('X'); // Director 补未填（subjective_mislead → mustHide）
  });
});

describe('brief-compiler-node — #3 缺源降级（6.3 graceful，mirror #6/#7/#8）', () => {
  it('无 info_release_map artifact → #3 untouched + manipulationDirectives undefined', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: 'g' } },
        scene_graph: buildSceneGraph(),
        // 不注入 info_release_map
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      readerKnows?: string;
      mustHide?: string;
      hintOnly?: string;
      manipulationDirectives?: unknown[];
    };
    expect(brief.readerKnows).toBeUndefined();
    expect(brief.mustHide).toBeUndefined();
    expect(brief.hintOnly).toBeUndefined();
    expect(brief.manipulationDirectives).toBeUndefined();
  });

  it('info_release_map 坏形态（非对象）→ #3 untouched + manipulationDirectives undefined（不抛）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: 'not a map',
      }),
      requirement: '',
    });
    const brief = result.artifact as { manipulationDirectives?: unknown[] };
    expect(brief.manipulationDirectives).toBeUndefined();
  });

  it('info_release_map 空 entries → #3 untouched + manipulationDirectives undefined', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: makeInfoReleaseMap([]),
      }),
      requirement: '',
    });
    const brief = result.artifact as { manipulationDirectives?: unknown[] };
    expect(brief.manipulationDirectives).toBeUndefined();
  });

  it('info_release_map 全他章 entries（无本章匹配）→ #3 untouched + manipulationDirectives undefined', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_other_episode',
        episodeId: 'ep1',
        directive: { mode: 'reveal_first', actions: ['release'], target: '他章' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string; manipulationDirectives?: unknown[] };
    expect(brief.readerKnows).toBeUndefined();
    expect(brief.manipulationDirectives).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-inforelease-steer-1（BMad CR）：compileInfoRelease per-entry directive shape 守卫。
// isValidInfoReleaseMap 只守 entries 数组形态，不验 directive 子结构--bypass-assemble 路径（直测 / 坏 IPC
// payload）可能带坏 directive（缺 actions / 坏 mode / actions 非数组）。safeParse 失败 -> 丢该条（mirror
// CR-4.1-07 坏条目单独丢不全丢），好条目仍合入，免 for-of directive.actions throw + 免 brief poison。
// ─────────────────────────────────────────────────────────────────────────────

describe('brief-compiler-node - #3 CR-1 malformed directive 守卫（BMad CR，坏条目单独丢不全丢）', () => {
  // 直接构造坏 map（不经 infoReleaseMapSchema.parse -- 绕过 schema 验证模拟 bypass-assemble 路径：
  // 直测 / 坏 IPC payload / 未走 assemble 的链段）。isValidInfoReleaseMap 只查 entries 是数组，directive
  // 子结构不验 -> 坏 directive 能进 compileInfoRelease 循环。
  function makeRawMap(entries: Record<string, unknown>[]): unknown {
    return { entries, version: 0 };
  }

  it('坏 directive（actions 非数组）被丢 -> 不抛 + 好条目仍合入 + brief 不 poison', async () => {
    const node = createBriefCompilerNode();
    const malformedMap = makeRawMap([
      {
        id: 'ir_bad',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first', actions: 'not-an-array' },
      },
      {
        id: 'ir_good',
        sceneRef: 's_forward',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'sustain_unknown', actions: ['withhold'], target: '好条目' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: malformedMap,
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('chapter_brief');
    const brief = result.artifact as { readerKnows?: string; mustHide?: string; manipulationDirectives?: unknown[] };
    expect(brief.readerKnows).toBeUndefined();
    expect(brief.mustHide).toContain('好条目');
    expect(brief.manipulationDirectives).toHaveLength(1);
  });

  it('坏 directive（mode 非法）被丢 + 好条目仍合入', async () => {
    const node = createBriefCompilerNode();
    const malformedMap = makeRawMap([
      {
        id: 'ir_bad',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'bad_mode', actions: ['release'] },
      },
      {
        id: 'ir_good',
        sceneRef: 's_forward',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first', actions: ['release'], target: '好条目' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: malformedMap,
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('chapter_brief');
    const brief = result.artifact as { readerKnows?: string; manipulationDirectives?: unknown[] };
    expect(brief.readerKnows).toContain('好条目');
    expect(brief.manipulationDirectives).toHaveLength(1);
  });

  it('坏 directive（缺 actions）被丢 + 好条目仍合入', async () => {
    const node = createBriefCompilerNode();
    const malformedMap = makeRawMap([
      {
        id: 'ir_bad',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first' },
      },
      {
        id: 'ir_good',
        sceneRef: 's_forward',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first', actions: ['release'], target: '好条目' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: malformedMap,
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('chapter_brief');
    const brief = result.artifact as { readerKnows?: string; manipulationDirectives?: unknown[] };
    expect(brief.readerKnows).toContain('好条目');
    expect(brief.manipulationDirectives).toHaveLength(1);
  });

  it('全坏 directive（无好条目）-> #3 untouched + manipulationDirectives undefined（不抛）', async () => {
    const node = createBriefCompilerNode();
    const malformedMap = makeRawMap([
      {
        id: 'ir_bad1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first', actions: 'not-an-array' },
      },
      {
        id: 'ir_bad2',
        sceneRef: 's_forward',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'bad_mode', actions: ['release'] },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        info_release_map: malformedMap,
      }),
      requirement: '',
    });
    expect(result.stateKey).toBe('chapter_brief');
    const brief = result.artifact as { readerKnows?: string; mustHide?: string; manipulationDirectives?: unknown[] };
    expect(brief.readerKnows).toBeUndefined();
    expect(brief.mustHide).toBeUndefined();
    expect(brief.manipulationDirectives).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-inforelease-steer-3（BMad CR）：#3 merge precedence「已填」= 非空 intent（非空串 ''）。
// 原 `??` 视 leader 空串 '' 为已填（blocks Director 的值）-> 改 nonEmpty trim 检查：
// leader 非空串优先，空串/空白串/undefined -> Director 补。
// ─────────────────────────────────────────────────────────────────────────────

describe('brief-compiler-node - #3 CR-3 merge 非空 intent 判据（BMad CR，leader 空串 -> Director 补）', () => {
  it('leader mustHide 空串 "" -> Director 补（非 ?? 视空串为已填）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'sustain_unknown', actions: ['withhold'], target: 'Director 隐瞒项' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { mustHide: '' } },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { mustHide?: string };
    expect(brief.mustHide).toContain('Director 隐瞒项');
  });

  it('leader mustHide 空白串 "   " -> Director 补（trim 后空）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'sustain_unknown', actions: ['withhold'], target: 'Director 隐瞒项' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { mustHide: '   ' } },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { mustHide?: string };
    expect(brief.mustHide).toContain('Director 隐瞒项');
  });

  it('leader readerKnows 非空串 -> leader 优先（Director readerKnows 不覆盖）', async () => {
    const node = createBriefCompilerNode();
    const map = makeInfoReleaseMap([
      {
        id: 'ir1',
        sceneRef: 's_single',
        episodeId: TARGET_EPISODE,
        directive: { mode: 'reveal_first', actions: ['release'], target: 'Director 透露项' },
      },
    ]);
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { readerKnows: 'leader 非空 readerKnows' } },
        scene_graph: buildSceneGraph(),
        info_release_map: map,
      }),
      requirement: '',
    });
    const brief = result.artifact as { readerKnows?: string };
    expect(brief.readerKnows).toBe('leader 非空 readerKnows');
    expect(brief.readerKnows).not.toContain('Director 透露项');
  });
});

// Story 5.2 §emotion 段：brief-compiler-node #10 emotionTarget 汇编（章级，Director 独立产 + leader merge）。
// merge precedence（mirror #3 nonEmpty）：leader 字段优先，Director 补未填。章级独立产非 per-scene rollup。
// graceful：leader + Director 全空 → undefined（brief #10 optional）。
describe('brief-compiler-node — #10 compileEmotionTarget 章级情绪目标（5.2，纯代码 merge）', () => {
  it('Director emotionTarget 补未填（leader 无 emotionTarget）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        director_emotion_target: { emotion: '恐惧', emotionEnd: '决心', steer: '先压抑后爆发' },
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: { emotion?: string; emotionEnd?: string; steer?: string } };
    expect(brief.emotionTarget).toEqual({ emotion: '恐惧', emotionEnd: '决心', steer: '先压抑后爆发' });
  });

  it('leader 已填优先（Director 同字段不覆盖，人意图硬约束）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: TARGET_EPISODE,
          brief: { emotionTarget: { emotion: '紧张', steer: 'leader 的 steer' } },
        },
        scene_graph: buildSceneGraph(),
        director_emotion_target: { emotion: 'Director 情绪', emotionEnd: 'Director 转变', steer: 'Director steer' },
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: { emotion?: string; emotionEnd?: string; steer?: string } };
    // leader emotion/steer 优先；Director 补 leader 未填的 emotionEnd。
    expect(brief.emotionTarget?.emotion).toBe('紧张');
    expect(brief.emotionTarget?.steer).toBe('leader 的 steer');
    expect(brief.emotionTarget?.emotionEnd).toBe('Director 转变');
  });

  it('leader + Director 全空 → emotionTarget undefined（brief #10 optional）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: unknown };
    expect(brief.emotionTarget).toBeUndefined();
  });

  it('Director emotionTarget 含可选 vad 投影（truthy 透传，非情绪真相）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        director_emotion_target: { emotion: '恐惧', vad: { v: -0.7, a: 0.8, d: -0.3 } },
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: { emotion?: string; vad?: { v: number; a: number; d: number } } };
    expect(brief.emotionTarget?.emotion).toBe('恐惧');
    expect(brief.emotionTarget?.vad).toEqual({ v: -0.7, a: 0.8, d: -0.3 });
  });

  it('不 rollup per-scene emotion_curve（章级独立产，per-scene 不进 brief #10）', async () => {
    // emotion_curve artifact 含 per-scene points，但 compileEmotionTarget 不读它（D2：章级 Director 独立产非 rollup）。
    // 无 director_emotion_target + 无 leader emotionTarget → emotionTarget undefined（即使 emotion_curve 有 points）。
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        emotion_curve: {
          unit: 'scene',
          points: [{ refId: 's_single', sceneMood: '压抑', characters: [{ characterId: 'c1', emotion: '恐惧' }] }],
        },
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: unknown };
    expect(brief.emotionTarget).toBeUndefined(); // per-scene points 不 rollup 成章级 #10
  });

  // D-5.1-2（5.1 CR deferred，owner=5.2）+ BMad CR Blind-2/Edge-3 fix：vad/vadEnd 成对验证。
  it('D-5.1-2：vad+vadEnd 成对取自同一 producer（leader 优先有 vad），免跨 producer 混搭', async () => {
    const node = createBriefCompilerNode();
    // leader 有 vad 无 vadEnd；Director 有 vadEnd 无 vad。成对契约：取 leader 的 pair（vad + leader.vadEnd=undefined），
    // 不混搭 director.vadEnd（跨情绪模型拼接语义不连贯）。
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: TARGET_EPISODE,
          brief: { emotionTarget: { emotion: '紧张', vad: { v: -0.5, a: 0.8, d: 0.1 } } },
        },
        scene_graph: buildSceneGraph(),
        director_emotion_target: { vadEnd: { v: 0.4, a: 0.6, d: 0.3 } }, // director 只有 vadEnd（orphan）
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: { vad?: { v: number }; vadEnd?: unknown } };
    expect(brief.emotionTarget?.vad).toEqual({ v: -0.5, a: 0.8, d: 0.1 }); // leader 的 vad
    expect(brief.emotionTarget?.vadEnd).toBeUndefined(); // 不取 director 的 orphan vadEnd
  });

  it('D-5.1-2：Director vad+vadEnd 成对（leader 无 vad）→ pair 取自 Director', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { emotionTarget: { emotion: '恐惧' } } }, // leader 无 vad
        scene_graph: buildSceneGraph(),
        director_emotion_target: { vad: { v: -0.7, a: 0.8, d: -0.3 }, vadEnd: { v: 0.2, a: 0.6, d: 0.4 } },
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: { vad?: { v: number }; vadEnd?: { v: number } } };
    expect(brief.emotionTarget?.vad).toEqual({ v: -0.7, a: 0.8, d: -0.3 });
    expect(brief.emotionTarget?.vadEnd).toEqual({ v: 0.2, a: 0.6, d: 0.4 }); // director pair 完整
  });

  it('D-5.1-2：orphan vadEnd（两 producer 都无 vad，仅 director vadEnd）→ drop（不进 brief）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        director_emotion_target: { emotion: '恐惧', vadEnd: { v: 0.4, a: 0.6, d: 0.3 } }, // 有 vadEnd 无 vad
      }),
      requirement: '',
    });
    const brief = result.artifact as { emotionTarget?: { vad?: unknown; vadEnd?: unknown } };
    expect(brief.emotionTarget?.emotion).toBe('恐惧');
    expect(brief.emotionTarget?.vad).toBeUndefined();
    expect(brief.emotionTarget?.vadEnd).toBeUndefined(); // orphan vadEnd drop（成对：有终点必有起点）
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 R3（design §4.2）：brief-compiler-node characterProgressions 编译通道。
// 三源：episode_outlines 本章 progressions（主源）+ growth_curve 转折点 join（write_chapter post-assemble
// artifact，4.4 既有注入点）+ asset_cards character 卡 id→name（5.3 既有注入点）。缺主源 → 不设字段
// （二态：缺失 = 无弧走向，主笔照写；空 episode progressions 与字段缺失同态 → undefined 非空数组）。
// ⚠️ IPC 路径（closureChainIpc）不注入 growth_curve/asset_cards → 仅 episode 源编译（join/名字降级，零回归）。
// 范式判据：filter + join + id→name 查表 = 纯代码结构查询，非语义（不判「走向好不好」归设计/弧维 LLM）。
// ─────────────────────────────────────────────────────────────────────────────

/** 带 character_progressions 的 episode fixture（episodeOutlineSchema.parse 填 defaults）。 */
const PROG_EPISODES = [
  episodeOutlineSchema.parse({
    id: 'ep1',
    index: 0,
    title: '第一章',
    character_progressions: [{ characterId: 'c_lin', from: '隐忍', to: '试探' }],
  }),
  episodeOutlineSchema.parse({
    id: 'ep2',
    index: 1,
    title: '第二章',
    character_progressions: [
      { characterId: 'c_lin', from: '试探', to: '决意反抗' },
      { characterId: 'c_wang', from: '怀疑', to: '确信' },
    ],
  }),
  episodeOutlineSchema.parse({ id: 'ep3', index: 2, title: '第三章', character_progressions: [] }),
];

/** growth_curve array fixture（8.5 canonical 形态）：c_lin 转折点锚 ep2；c_wang 转折点锚 ep3（他章）。 */
const PROG_GROWTH = [
  {
    character_id: 'c_lin',
    start_state: '隐忍求生',
    turning_points: [
      { turning_point: '目睹同袍之死，求生信念崩塌', linked_episode_ids: ['ep2'] },
      { turning_point: '他章才兑现的转折', linked_episode_ids: ['ep3'] },
    ],
  },
  {
    character_id: 'c_wang',
    start_state: '怀疑一切',
    turning_points: [{ turning_point: '拿到实证', linked_episode_ids: ['ep3'] }],
  },
];

/** asset_cards fixture：c_lin 有 character 卡；c_wang 只有 location 卡（不参与名字解析）。 */
const PROG_CARDS = [
  { id: 'c_lin', type: 'character', name: '林昭' },
  { id: 'c_wang', type: 'location', name: '王城' },
];

describe('brief-compiler-node — characterProgressions 编译（8.5 R3，纯代码三源 join）', () => {
  it('双源 join：episode 主源 + 转折点命中本章附 turningPoint + character 卡 id→name 解析', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: PROG_GROWTH,
        asset_cards: PROG_CARDS,
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<Record<string, unknown>>;
    };
    expect(brief.characterProgressions).toHaveLength(2);
    // c_lin：三源全命中（episode from→to + characterName 解析 + 本章命中转折点一句）
    expect(brief.characterProgressions?.[0]).toEqual({
      characterId: 'c_lin',
      characterName: '林昭',
      from: '试探',
      to: '决意反抗',
      turningPoint: '目睹同袍之死，求生信念崩塌',
    });
    // c_wang：转折点锚 ep3（他章）不串章 + location 卡不解析名字 → 两 optional 字段均不设
    expect(brief.characterProgressions?.[1]).toEqual({
      characterId: 'c_wang',
      from: '怀疑',
      to: '确信',
    });
  });

  it('IPC 降级路径：无 growth_curve/asset_cards artifact（closureChainIpc 不注入）→ 仅 episode 源编译', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        // 不注入 growth_curve / asset_cards（模拟 shell IPC 路径）
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<Record<string, unknown>>;
    };
    // 主源照编译（from/to 在），join 增强 + 名字解析降级（两 optional 字段不设）
    expect(brief.characterProgressions).toEqual([
      { characterId: 'c_lin', from: '试探', to: '决意反抗' },
      { characterId: 'c_wang', from: '怀疑', to: '确信' },
    ]);
  });

  it('本章 episode 无 progressions（过场章）→ 字段不设（undefined 非空数组）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep3', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: PROG_GROWTH,
        asset_cards: PROG_CARDS,
      }),
      requirement: '',
    });
    const brief = result.artifact as { characterProgressions?: unknown[] };
    expect(brief.characterProgressions).toBeUndefined(); // 空与缺失同态 → 不设字段
  });

  it('episodeId 不命中任何 episode → 字段不设', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep_none', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: PROG_GROWTH,
      }),
      requirement: '',
    });
    expect((result.artifact as { characterProgressions?: unknown }).characterProgressions).toBeUndefined();
  });

  it('无 episode_outlines artifact → 字段不设（缺主源）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        growth_curve: PROG_GROWTH, // growth 在也无效——episode 主源缺，无 progression 可 join
        asset_cards: PROG_CARDS,
      }),
      requirement: '',
    });
    expect((result.artifact as { characterProgressions?: unknown }).characterProgressions).toBeUndefined();
  });

  it('growth_curve 坏形态 → join 降级不抛（episode 源照编译）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: 'not-a-curve',
        asset_cards: PROG_CARDS,
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<Record<string, unknown>>;
    };
    expect(result.stateKey).toBe('chapter_brief'); // 不抛、不 error artifact
    // join 降级（无 turningPoint），名字解析照常（asset_cards 独立源）
    expect(brief.characterProgressions?.[0]).toEqual({
      characterId: 'c_lin',
      characterName: '林昭',
      from: '试探',
      to: '决意反抗',
    });
  });

  it('growth_curve 单条形态（非 array）→ readGrowthCurves 归一后 join 正常', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: PROG_GROWTH[0], // 单条 GrowthCurve（旧 yaml 形态）
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<{ characterId: string; turningPoint?: string }>;
    };
    const lin = brief.characterProgressions?.find((p) => p.characterId === 'c_lin');
    expect(lin?.turningPoint).toBe('目睹同袍之死，求生信念崩塌');
  });

  it('同角色多转折点命中本章 → 取首现一句（机械「至多一句」，不判哪条更重要）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: [
          {
            character_id: 'c_lin',
            start_state: '隐忍求生',
            turning_points: [
              { turning_point: '首现转折点', linked_episode_ids: ['ep2'] },
              { turning_point: '次现转折点', linked_episode_ids: ['ep2'] },
            ],
          },
        ],
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<{ characterId: string; turningPoint?: string }>;
    };
    expect(brief.characterProgressions?.[0].turningPoint).toBe('首现转折点');
  });

  it('linked_episode_ids 命中他章不串章：c_lin 编译 ep1（growth 转折点只锚 ep2）→ 不附 turningPoint', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep1', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: PROG_GROWTH, // c_lin 转折点只锚 ep2，锚 ep1 无
        asset_cards: PROG_CARDS,
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<Record<string, unknown>>;
    };
    expect(brief.characterProgressions).toEqual([{ characterId: 'c_lin', characterName: '林昭', from: '隐忍', to: '试探' }]);
  });

  it('名字缺失 graceful：asset_cards 无该角色卡 → characterName 不设（characterId 仍 traceable）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: PROG_GROWTH,
        asset_cards: [{ id: 'c_other', type: 'character', name: '无关角色' }], // 无 c_lin/c_wang 卡
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<Record<string, unknown>>;
    };
    expect(brief.characterProgressions?.every((p) => !('characterName' in p))).toBe(true);
    expect(brief.characterProgressions?.[0]).toEqual({ characterId: 'c_lin', from: '试探', to: '决意反抗', turningPoint: '目睹同袍之死，求生信念崩塌' });
  });

  it('坏 progression 条目单独丢好条目保留（raw bypass-parse 路径）；全坏 → 不设字段', async () => {
    const node = createBriefCompilerNode();
    // raw episodes（不经 schema.parse，模拟 assemble raw 透传 / 坏 IPC payload）
    const rawEpisodes = [
      {
        id: 'ep2',
        index: 1,
        title: '第二章',
        character_progressions: [
          { characterId: 'c_ok', from: 'A', to: 'B' },
          { characterId: '', from: 'A', to: 'B' }, // 坏：空 characterId
          { from: 'A', to: 'B' }, // 坏：缺 characterId
          { characterId: 'c_no_to', from: 'A' }, // 坏：缺 to
          'not-an-object', // 坏：非对象
        ],
      },
    ];
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: rawEpisodes,
      }),
      requirement: '',
    });
    expect((result.artifact as { characterProgressions?: unknown[] }).characterProgressions).toEqual([
      { characterId: 'c_ok', from: 'A', to: 'B' },
    ]);

    // 全坏 → out 空 → undefined（同缺源语义）
    const allBad = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: 'ep2', brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: [
          { id: 'ep2', index: 1, title: '第二章', character_progressions: [{ from: 'A' }] },
        ],
      }),
      requirement: '',
    });
    expect((allBad.artifact as { characterProgressions?: unknown }).characterProgressions).toBeUndefined();
  });

  it('单 producer：leader stray characterProgressions 被编译值覆盖（mirror plotPoints/promiseTasks overwrite）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: 'ep2',
          brief: {
            goal: 'g',
            characterProgressions: [{ characterId: 'stray', from: 'x', to: 'y' }], // leader stray（非设计 producer）
          },
        },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
        growth_curve: PROG_GROWTH,
      }),
      requirement: '',
    });
    const brief = result.artifact as {
      characterProgressions?: Array<{ characterId: string }>;
    };
    expect(brief.characterProgressions?.map((p) => p.characterId)).toEqual(['c_lin', 'c_wang']); // 编译值，stray 不留
  });

  it('单 producer：缺源时 leader stray 同被覆盖为 undefined（不透传 stale）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: {
          episodeId: 'ep3', // 本章无 progressions → 编译 undefined
          brief: { goal: 'g', characterProgressions: [{ characterId: 'stray', from: 'x', to: 'y' }] },
        },
        scene_graph: buildSceneGraph(),
        episode_outlines: PROG_EPISODES,
      }),
      requirement: '',
    });
    expect((result.artifact as { characterProgressions?: unknown }).characterProgressions).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 链流程重排 W2（遗留①）：规划环 revise 回环的重编意图注入（plan_review hard findings →
// chapter_brief.recompileHints，纯机械投影）——环有实质输入而非同输入确定性重编 + 空 LLM 复判。
// ════════════════════════════════════════════════════════════════════════════

describe('brief-compiler-node — W2 遗留① recompileHints 注入（规划环 revise 回环）', () => {
  const PLAN_REVIEW_REVISE = {
    verdict: 'revise',
    summary: '红线不一致',
    findings: [
      { dimension: 'red-line', severity: 'hard', grounding: 'chapterBrief.mustHide', note: 'mustHide 与第 2 章已揭露事实矛盾——重编改为 hintOnly' },
      { dimension: 'pacing', severity: 'soft', grounding: 'chapterBrief.pacing', note: '节奏偏慢（软维度——不触发回环）' },
    ],
  };

  it('plan_review verdict=revise → hard findings 机械注入 recompileHints（soft 不注入）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
        plan_review: PLAN_REVIEW_REVISE,
      }),
      requirement: '',
    });
    const brief = result.artifact as { recompileHints?: Array<{ dimension: string; note: string }> };
    expect(brief.recompileHints).toEqual([
      { dimension: 'red-line', grounding: 'chapterBrief.mustHide', note: 'mustHide 与第 2 章已揭露事实矛盾——重编改为 hintOnly' },
    ]);
  });

  it('首圈无 plan_review → 零注入（recompileHints 缺省，零回归）', async () => {
    const node = createBriefCompilerNode();
    const result = await node.run({
      run: makeRun({
        chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
        scene_graph: buildSceneGraph(),
        episode_outlines: EPISODES,
      }),
      requirement: '',
    });
    const brief = result.artifact as { recompileHints?: unknown };
    expect(brief.recompileHints).toBeUndefined();
  });

  it('plan_review verdict=pass / 坏形态 → 零注入（仅 revise 回环语义注入）', async () => {
    const node = createBriefCompilerNode();
    for (const bad of [
      { verdict: 'pass', summary: 'ok', findings: PLAN_REVIEW_REVISE.findings },
      { verdict: 'escalate', summary: '灰区', findings: PLAN_REVIEW_REVISE.findings },
      'not-an-object',
    ]) {
      const result = await node.run({
        run: makeRun({
          chapter_brief_input: { episodeId: TARGET_EPISODE, brief: {} },
          scene_graph: buildSceneGraph(),
          episode_outlines: EPISODES,
          plan_review: bad,
        }),
        requirement: '',
      });
      const brief = result.artifact as { recompileHints?: unknown };
      expect(brief.recompileHints).toBeUndefined();
    }
  });
});
