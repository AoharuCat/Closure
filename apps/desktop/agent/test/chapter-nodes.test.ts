import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promiseRegistrySchema } from '@orison/shared-contracts';
import {
  createDraftWriterNode,
  createReaderAuditNode,
  applyEditedDraft,
  isLintSourceMechanicallyConfirmed,
  recountDraftWordCount,
  createRouteNode,
} from '../src/nodes/chapter-nodes';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.2/§4.4 / implement.md 3.6：LLM 节点（draft-writer / multi-review / route）
// 实例化测试。
//
// createLlmNode 工厂的「重试 + 兜底 + abort」逻辑已由 llm-node.test.ts 覆盖。此处只验：
// 1. parseOutput（JSON.parse + inline Zod）—— valid fixture JSON → 正确 artifact shape + stateKey
// 2. buildPrompt —— 从 run.artifacts 抽出正确的 vars 注入 yaml user 段
// 3. generate 收到 yaml system 段（route-agent.yaml 真实存在并加载）
// 4. Zod 拒坏 shape（节点内联 schema 守门）—— 缺字段 JSON 触发重试 → 兜底 error artifact
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_chapter',
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

function makeOkResult(json: object): GenerateResult {
  return { content: JSON.stringify(json), finishReason: 'stop' };
}

const noopGenerate = vi.fn<GenerateFn>(async () => makeOkResult({}));

// ════════════════════════════════════════════════════════════════════════════
// draft-writer 节点
// ════════════════════════════════════════════════════════════════════════════

const VALID_DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' };

describe('draft-writer 节点', () => {
  it('parseOutput: valid JSON → {title,text,wordCount,chapterId} + stateKey=draft.initial', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createDraftWriterNode({ generate });

    const result = await node.run({
      run: makeRun({ chapter_brief: { goal: 'g' }, scene_graph: { nodes: [] }, settings_context: '设定文本' }),
      requirement: '',
    });

    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
  });

  it('buildPrompt（4.1 §3.1）: storyPlan 精选本章场（selectScenesForEpisode，非全量 dump）+ chapterTask 序列化 + projectContext 标量', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createDraftWriterNode({ generate });

    await node.run({
      run: makeRun({
        chapter_brief: { goal: '抵达 B 城' },
        // 4.1：episodeId 从 chapter_brief_input 解析（mirror brief-compiler resolveBriefInput）
        chapter_brief_input: { episodeId: 'ep_target', brief: { goal: '抵达 B 城' } },
        scene_graph: {
          nodes: [
            { id: 's_hit', episodeId: 'ep_target', storyTime: 0, presentationOrder: { chapter: 1, pos: 0 }, role: 'core-anchor', lineTags: ['l1'] },
            { id: 's_miss', episodeId: 'ep_other', storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', lineTags: ['l1'] },
          ],
          edges: [{ id: 'e1', from: 's_miss', to: 's_hit', type: 'CAUSAL' }],
          lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
        },
        settings_context: 'PREFIX-CONTENT',
      }),
      requirement: '',
    });

    const [messages, , , , opts] = generate.mock.calls[0];
    const userContent = messages[0]?.content ?? '';
    // chapterTask：chapter_brief 序列化（含 goal）
    expect(userContent).toContain('抵达 B 城');
    // storyPlan：精选命中场结构面（含 s_hit），非全量 dump（不含 s_miss 不命中场）
    expect(userContent).toContain('s_hit');
    expect(userContent).not.toContain('s_miss');
    // projectContext 是标量直注
    expect(userContent).toContain('PREFIX-CONTENT');
    // modelRef 透传（deps 无 modelRef → undefined）
    expect(opts?.modelRef).toBeUndefined();
  });

  it('buildPrompt（4.1 §3.1）: chapter_brief_input 缺 → episodeId undefined → storyPlan 空数组（graceful，非全量 dump）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createDraftWriterNode({ generate });

    await node.run({
      run: makeRun({
        chapter_brief: { goal: 'g' },
        // 无 chapter_brief_input → episodeId undefined
        scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal', lineTags: [] }] },
        settings_context: 'PREFIX',
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // episodeId 缺 → selectScenesForEpisode 返 [] → storyPlan = '[]'（不 dump 场）
    expect(userContent).not.toContain('s1');
  });

  it('CR-8：wordCount 字符串/省略 coerce 容忍（z.coerce.number().optional()）', async () => {
    // wordCount 为字符串 "2800" → coerce 为 number
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({ title: 't', text: '正文', wordCount: '2800', chapterId: 'ch' }),
      finishReason: 'stop',
    }));
    const node = createDraftWriterNode({ generate });
    const result = await node.run({ run: makeRun({}), requirement: '' });
    expect((result.artifact as { wordCount: number }).wordCount).toBe(2800);
  });

  it('BMad CR F3a：text 与 passageText 均空 → schema refine 拒 → 重试 → 兜底 error artifact', async () => {
    // 段落级 directive 让 LLM 留空 text 只填 passageText；若 LLM 误把 passageText 也留空（空串）→
    // refine 拒（text|passageText 须非空）→ createLlmNode 重试 → 仍失败兜底 error artifact（防 empty draft 入库）。
    const generate = vi.fn<GenerateFn>();
    generate
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 't', text: '', passageText: '' }), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 't', text: '', passageText: '' }), finishReason: 'stop' });
    const node = createDraftWriterNode({ generate });
    const result = await node.run({ run: makeRun({}), requirement: '' });
    expect(generate).toHaveBeenCalledTimes(2); // 重试一次
    expect((result.artifact as { error: boolean }).error).toBe(true); // 兜底 error artifact
  });

  // ── Story 7.1 Route 1：段落级 splice（design §3.2）──
  // revision_intent + scope.anchor + previous draft.initial + passageText 输出 → 节点 splice 回完整 text。

  /** 合法 RevisionIntent（带 scope.anchor = B trigger 选区）。 */
  const PASSAGE_INTENT = {
    change: { summary: '战斗改紧张点' },
    lockedItems: [{ field: '角色性格', authority: 'hard', evidence: '别动角色性格' }],
    rationale: { source: 'user-directive', note: '用户选段指挥' },
    provenance: { rawUserInstruction: '这段战斗改紧张点，别动角色性格', compilerNote: '锁定角色性格' },
    scope: {
      anchor: { quote: '战斗开始了', prefix: '前文。', suffix: '。后文', rangeHint: { from: 3, to: 8 } },
    },
  };

  it('Route 1（Story 7.2）：revision_intent + passageText + previous draft → 不 splice，保改前整章 + passageText 留给 revision-guard', async () => {
    // Story 7.2：splice 从 draft-writer 移到 revision-guard 节点（design §0.2/§1.4）。
    // draft-writer 段落级时只产 passageText + 保改前整章 text（防覆盖丢改前），revision-guard 判定后 splice。
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({ title: '第二章', text: '', passageText: '战斗惨烈地开始了' }),
      finishReason: 'stop',
    }));
    const node = createDraftWriterNode({ generate });
    const result = await node.run({
      run: makeRun({
        chapter_brief: { goal: 'g' },
        scene_graph: { nodes: [] },
        settings_context: 's',
        revision_intent: PASSAGE_INTENT,
        // previous draft.initial（redo resume 时 snapshot 持上一轮完整正文）。
        'draft.initial': { title: '第二章', text: '前文。战斗开始了。后文。' },
      }),
      requirement: '',
    });

    expect(result.stateKey).toBe('draft.initial');
    const artifact = result.artifact as { text: string; passageText?: string; title: string };
    // 🔑 Story 7.2：draft-writer 不 splice——text 保改前整章（revision-guard 才 splice），passageText 保留。
    expect(artifact.text).toBe('前文。战斗开始了。后文。'); // 改前整章原样（不丢改前）
    expect(artifact.passageText).toBe('战斗惨烈地开始了'); // 改后段保留（留给 revision-guard splice）
    expect(artifact.title).toBe('第二章');
  });

  it('Route 1: buildPrompt 注入段落级改稿 directive（含选区 quote + 锁定项硬锁/软锁 + 用户原话）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createDraftWriterNode({ generate });
    await node.run({
      run: makeRun({
        chapter_brief: { goal: 'g' },
        scene_graph: { nodes: [] },
        settings_context: 's',
        revision_intent: PASSAGE_INTENT,
      }),
      requirement: '',
    });
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('【段落级改稿指令】'); // formatRevisionIntent 发出的 bracket header
    expect(userContent).toContain('战斗开始了'); // 选区 quote
    expect(userContent).toContain('战斗改紧张点'); // change.summary
    expect(userContent).toContain('硬锁（用户原话）');
    expect(userContent).toContain('角色性格');
    expect(userContent).toContain('这段战斗改紧张点，别动角色性格'); // rawUserInstruction 硬权威
    expect(userContent).toContain('passageText'); // 输出契约提示
  });

  it('Route 1（Story 7.2）：draft-writer 不做 splice 定位判定（quote 不在 previous draft 仍保 previousText，定位失败归 revision-guard）', async () => {
    // Story 7.2：splice + 定位失败判定都从 draft-writer 移到 revision-guard。draft-writer 段落级时无条件
    // 保改前整章 + passageText（不管 quote 是否在 previous draft——那是 revision-guard splice 时判的）。
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({ title: '第二章', text: '', passageText: '新段落' }),
      finishReason: 'stop',
    }));
    const node = createDraftWriterNode({ generate });
    const previousDraft = { title: '第二章', text: '完全不同的正文，选区 quote 不在。' };
    const result = await node.run({
      run: makeRun({
        chapter_brief: { goal: 'g' },
        scene_graph: { nodes: [] },
        settings_context: 's',
        revision_intent: PASSAGE_INTENT, // quote「战斗开始了」不在 previous draft（revision-guard splice 时才报）
        'draft.initial': previousDraft,
      }),
      requirement: '',
    });

    // draft-writer 不报定位失败（非 error artifact）——保改前整章 + passageText，留给 revision-guard。
    expect(result.stateKey).toBe('draft.initial');
    const artifact = result.artifact as { text: string; passageText?: string; error?: boolean };
    expect(artifact.error).toBeUndefined();
    expect(artifact.text).toBe('完全不同的正文，选区 quote 不在。'); // 保改前（不丢）
    expect(artifact.passageText).toBe('新段落');
  });

  it('Route 1: 无 revision_intent（首写/整章 redo）→ 整章路径零回归（无 splice）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createDraftWriterNode({ generate });
    const result = await node.run({
      run: makeRun({ chapter_brief: { goal: 'g' }, scene_graph: { nodes: [] }, settings_context: 's' }),
      requirement: '',
    });
    expect(result.artifact).toEqual(VALID_DRAFT); // 既有整章行为不变
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).not.toContain('【段落级改稿指令】'); // bracket header（yaml 旁述「段落级改稿指令块」无 bracket）
  });

  it('Zod 拒坏 shape（缺 text）→ 重试 → 兜底 error artifact', async () => {
    const generate = vi.fn<GenerateFn>();
    generate
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 't', wordCount: 1 }), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 't', wordCount: 1 }), finishReason: 'stop' });
    const node = createDraftWriterNode({ generate });

    const result = await node.run({ run: makeRun({}), requirement: '' });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.stateKey).toBe('draft-writer-agent'); // 兜底用 nodeId
    expect((result.artifact as { error: boolean }).error).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Reader-Audit 节点（Story 4.2：composite L1→L2，替换单 createLlmNode 的 5 维 multi-review）
// ════════════════════════════════════════════════════════════════════════════

const VALID_REVIEW = {
  verdict: 'revise',
  summary: '一致性矛盾：主角动机铺垫不足',
  dimensions: [
    {
      name: 'consistency',
      findings: [
        {
          subClass: 'Characterization.memory',
          severity: 'warn',
          quote: '主角突然决定进城',
          location: '句3',
          explanation: '前文未铺垫进城动机',
        },
      ],
    },
    {
      name: 'narrative-feature',
      findings: [
        {
          severity: 'info',
          quote: '嘴角微微上扬',
          location: '句2',
          explanation: 'cliché 微表情（L1 已 flag，语境尚可）',
        },
      ],
    },
  ],
  reasons: ['主角动机铺垫不足', 'L1 cliché hotspot 已回应（句2，降级 info）'],
};

/** Reader-Audit 节点所需的最小 artifacts（draft + scene_graph + chapter_brief 三 required——W1d/W3：
 * story.sync 已移出 required 且 continuityMemory var 已删，story-sync 后移 E9 审读后无本章提取物）。 */
function makeReaderAuditRun(overrides: Record<string, unknown> = {}): RunSnapshot {
  return makeRun({
    'draft.initial': { text: '正文……', wordCount: 100 },
    scene_graph: { nodes: [] },
    chapter_brief: { goal: 'g' },
    ...overrides,
  });
}

describe('Reader-Audit 节点（composite L1→L2）', () => {
  it('parseOutput: valid JSON → verdict + dimensions.findings + stateKey=review.latest', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest');
    expect(result.artifact).toEqual(VALID_REVIEW);
  });

  it('L1→L2 composite: generate 收到的 userPrompt 含 draftText + L1 hotspot + briefIntent（L1 先算喂 L2）', async () => {
    // AI 腔正文触发 L1 cliché/crutch flag（嘴角微微上扬/璀璨/然而/突然/似乎）
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({
        'draft.initial': { text: '突然，他嘴角微微上扬，璀璨的光芒绽放。然而，他注意到事情似乎并非如此。' },
        // W3：story.sync 在场也不注入（continuityMemory var 已删——story-sync 后移 E9，审读对照源
        // = 启动前快照 + 计划；本章自提物对照本章是循环论证）。
        'story.sync': { patches: [{ title: '伏笔X' }] },
        chapter_brief: {
          goal: '抵达 B 城',
          mustHide: '主角身份',
          hintOnly: '身世线索',
          gap_whitelist: [{ location: '句2', reason: '故意信息延迟' }],
        },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // draftText 注入
    expect(userContent).toContain('嘴角微微上扬');
    // W3（R5）：continuityMemory var 删除——story.sync 内容不注入（提取段后移，审读不再消费本章自提物）。
    expect(userContent).not.toContain('伏笔X');
    expect(userContent).not.toContain('连续性记忆');
    // briefIntent（chapter_brief 序列化，含 mustHide + gap_whitelist reason）
    expect(userContent).toContain('主角身份');
    expect(userContent).toContain('故意信息延迟');
    // L1 hotspot 注入（signals 数组含 cliche_ratio 信号名——L1 纯代码已算）
    expect(userContent).toContain('cliche_ratio');
    // renderTemplate 无残留 {{}} 模板标记
    expect(userContent).not.toContain('{{');
  });

  it('L1 hotspot 是 L2 语义裁判的机械提示（POS 信号名出现在 prompt，证 L1 真跑了）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({ run: makeReaderAuditRun({ 'draft.initial': { text: '正文内容' } }), requirement: '' });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // L1 signals 全名注入（含 POS-gram / CR-words 等——证 L1 纯代码层跑了，喂 L2）
    expect(userContent).toContain('posgram_skeleton_repeat');
    expect(userContent).toContain('cr_words');
    expect(userContent).toContain('punctuation_rhythm');
  });

  // ── Story 6.6 Phase D：worldStateContext 一致基底注入（Reader-Audit 对照已建立状态找矛盾）──

  it('Phase D：world_state_snapshot artifact 在 → worldStateContext 注入 user prompt（含主体状态）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({
        world_state_snapshot: {
          at: undefined,
          subjects: [
            { subjectId: 'erina', state: { hp: 70, location: 'subject://altar-01' }, issueCount: 0 },
          ],
        },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // snapshot 序列化注入 worldStateContext——含主体 id + 状态字段。
    expect(userContent).toContain('世界状态基底');
    expect(userContent).toContain('erina');
    expect(userContent).toContain('"hp":70');
  });

  it('Phase D graceful：world_state_snapshot artifact 缺 → worldStateContext 空段（Reader-Audit 不崩）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // makeReaderAuditRun 不含 world_state_snapshot（默认缺省）。
    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest'); // 节点不崩，正常产 review
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // worldStateContext 段渲染但序列化空串（run.artifacts['world_state_snapshot'] ?? '' → ''）。
    expect(userContent).toContain('世界状态基底');
    // renderTemplate 无残留 {{worldStateContext}} 模板标记（已替换为空串）。
    expect(userContent).not.toContain('{{worldStateContext}}');
  });
  it('Story 2.6：decidedDecisions 注入——decided 相关命中（本章+全局 newestFirst）+ cap 10 截断标注', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // 12 条 decided（1 条 relatedEpisodeId 他章 + 11 条相关：全局 1 + 本章 10）→ cap 10 + truncated:true + total:11。
    const decided = (id: string, relatedEpisodeId?: string, createdAt = '2026-08-01T00:00:00Z') => ({
      id, summary: `决策 ${id}`, reason: 'r', risk: 'k', status: 'decided', source: 'workbench', createdAt,
      ...(relatedEpisodeId ? { relatedEpisodeId } : {}),
    });
    const decisions = [
      decided('d-other-ep', 'ep-other'), // 他章 → 排除
      decided('d-global'), // 全局 → 相关
      ...Array.from({ length: 10 }, (_, i) => decided(`d-ep-${String(i).padStart(2, '0')}`, 'ep1', `2026-08-0${(i % 9) + 1}T00:00:00Z`)),
      decided('d-open', undefined, '2026-08-09T00:00:00Z'), // open → 排除
    ];
    decisions[decisions.length - 1].status = 'open';

    await node.run({
      run: makeReaderAuditRun({
        story_decisions: decisions,
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    const marker = userContent.indexOf('{{decidedDecisions}}');
    // var 已渲染（模板塌空行后不应残留原始 placeholder）。
    expect(userContent).not.toContain('{{decidedDecisions}}');
    // 截断标注进 prompt（truncated:true + total:11）。
    expect(userContent).toContain('"truncated":true');
    expect(userContent).toContain('"total":11');
    // newestFirst cap：前 10 条相关 decided（全局 d-global + d-ep-*），他章/open 不进。
    expect(userContent).toContain('d-global');
    expect(userContent).not.toContain('d-other-ep');
    expect(userContent).not.toContain('d-open');
  });

  it('Story 2.6：story_decisions artifact 缺 -> decidedDecisions 空（graceful，决策落地维无数据零回归）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('"decisions":[]');
  });


  // ── Story 6.5：promiseLedger 注入（Reader-Audit promise-landing 维数据源，mirror worldStateContext）──

  it('6.5：promise_registry artifact 在 → promiseLedger 注入 user prompt（E6：filter 本章相关 beats，非全 registry）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // E6（CR-E6）：promiseLedger var filter 本章自洽子集（mirror compilePromiseTasks filter 单源）——
    // 只注入本章相关 beats（episodeId 匹配 OR sceneRef ∈ 本章 scenes）+ 所属非 abandoned promises，
    // 非全 registry（避免 LLM 误报后章 Promise 为 missing-payoff / 跨章 scope 泄漏）。
    const registry = promiseRegistrySchema.parse({
      promises: [
        { id: 'p1', title: '国王真相', summary: '读者以为明君实为暴君' },
        // p2 后章节拍——不属于本章，应被 filter 排除（scope 泄漏防线）。
        { id: 'p2', title: '后章复仇', summary: '后章才推进的读者债' },
      ],
      beats: [
        // 本章相关：sceneRef ∈ 本章 scenes（scene-royal 在本章 scene_graph.nodes）。
        { id: 'b1', promiseId: 'p1', sceneRef: 'scene-royal', episodeId: 'ep2', kind: 'plant' },
        // 非本章相关：sceneRef 不在本章 scenes + episodeId 非本章 → 应被 filter 排除。
        { id: 'b2', promiseId: 'p2', sceneRef: 'scene-other', episodeId: 'ep_later', kind: 'payoff' },
      ],
    });

    await node.run({
      // 本章 scene_graph 含 scene-royal（本章场）→ b1 命中（sceneRef ∈ 本章 scenes）。
      // chapter_brief_input episodeId='ep_target'（b1.episodeId='ep2' 非本章，但 sceneRef 命中路径通过）。
      run: makeReaderAuditRun({
        promise_registry: registry,
        scene_graph: {
          nodes: [
            { id: 'scene-royal', episodeId: 'ep_target', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor', lineTags: ['l1'] },
          ],
        },
        chapter_brief_input: { episodeId: 'ep_target', brief: { goal: '本章' } },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // promiseLedger 段注入——含本章相关 Promise 主体 + beat 节拍。
    expect(userContent).toContain('Promise 账本');
    expect(userContent).toContain('国王真相');
    expect(userContent).toContain('scene-royal');
    expect(userContent).toContain('plant');
    // E6 scope 泄漏防线：非本章相关的 p2「后章复仇」不注入（filter 排除，避免 LLM 误报后章 missing-payoff）。
    expect(userContent).not.toContain('后章复仇');
    expect(userContent).not.toContain('scene-other');
  });

  it('6.5 graceful：promise_registry artifact 缺 → promiseLedger 空段（Reader-Audit 不崩）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // makeReaderAuditRun 不含 promise_registry（默认缺省）。
    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest'); // 节点不崩，正常产 review
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // promiseLedger 段渲染但序列化空串（run.artifacts['promise_registry'] ?? '' → ''）。
    expect(userContent).toContain('Promise 账本');
    // renderTemplate 无残留 {{promiseLedger}} 模板标记（已替换为空串）。
    expect(userContent).not.toContain('{{promiseLedger}}');
    // 无残留任何模板标记。
    expect(userContent).not.toContain('{{');
  });

  it('6.5 prompt：system 段含 Promise 落地维 + subClass 约定 + per-chapter scope 边界', async () => {
    // 验 prompt 落地维段已加（落地公理 + subClass + 三边界 + 不套 force-escalate）。
    // 这是 prompt 静态内容断言（非 LLM 行为）——确保 prompt 段真写进去了（防漏接）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const [, system] = generate.mock.calls[0] as unknown as [
      unknown,
      string,
      unknown,
      unknown,
      unknown,
    ];
    // system prompt 含 Promise 落地维段 + 落地公理。
    expect(system).toContain('Promise 落地维');
    expect(system).toContain('落地公理');
    // subClass 约定（4 类落地缺失）。
    expect(system).toContain('Promise.unlanded-plant');
    expect(system).toContain('Promise.missing-advance');
    expect(system).toContain('Promise.missing-payoff');
    // per-chapter scope 边界（不越 4.4 cross-arc / 6.2 状态机）。
    expect(system).toContain('per-chapter scope');
    expect(system).toContain('4.4');
    expect(system).toContain('6.2');
    // 不套 force-escalate（落地缺失 writer 能补，走 route LLM 判）。
    expect(system).toContain('不强制 escalate');
  });

  // ── Story 6.2：cognitionContext 注入（Reader-Audit 认知状态机维数据源，mirror worldStateContext/promiseLedger）──

  it('6.2：cognition_snapshot artifact 在 → cognitionContext 注入 user prompt（含 BeliefStatus 视图）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({
        cognition_snapshot: {
          characters: [
            {
              characterSubjectId: 'erina',
              facts: [
                { path: '/knows/秘密X', status: 'believes_true', value: true, hasReaderPerceivedLayer: false },
                {
                  path: '/believes/国王',
                  status: 'believes_true',
                  value: { objective: '怀疑篡位', reader_perceived: '表面效忠' },
                  hasReaderPerceivedLayer: true,
                },
              ],
            },
          ],
        },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // cognitionContext 段注入——含角色 id + BeliefStatus 投影字段。
    expect(userContent).toContain('角色认知状态投影视图');
    expect(userContent).toContain('erina');
    expect(userContent).toContain('believes_true');
    expect(userContent).toContain('hasReaderPerceivedLayer');
    // renderTemplate 无残留 {{cognitionContext}} 模板标记。
    expect(userContent).not.toContain('{{cognitionContext}}');
  });

  it('6.2 graceful：cognition_snapshot artifact 缺 → cognitionContext 空段（Reader-Audit 不崩）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // makeReaderAuditRun 不含 cognition_snapshot（默认缺省）。
    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest'); // 节点不崩，正常产 review
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // cognitionContext 段渲染但序列化空串（run.artifacts['cognition_snapshot'] ?? '' → ''）。
    expect(userContent).toContain('角色认知状态投影视图');
    // renderTemplate 无残留 {{cognitionContext}} 模板标记（已替换为空串）。
    expect(userContent).not.toContain('{{cognitionContext}}');
    // 无残留任何模板标记。
    expect(userContent).not.toContain('{{');
  });

  it('6.2 prompt：system 段含认知状态机维 + 两类违规 subClass + per-chapter scope + 不套 force-escalate', async () => {
    // 验 prompt 认知状态机维段已加（KNOWLEDGE_VIOLATION/FORGOTTEN_REVEAL + ConStory 既有子类 + 三边界 + 白名单）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const [, system] = generate.mock.calls[0] as unknown as [
      unknown,
      string,
      unknown,
      unknown,
      unknown,
    ];
    // system prompt 含认知状态机维段。
    expect(system).toContain('认知状态机维');
    expect(system).toContain('info-gap');
    // 两类违规 + ConStory 既有子类（不造新子类名）。
    expect(system).toContain('KNOWLEDGE_VIOLATION');
    expect(system).toContain('FORGOTTEN_REVEAL');
    expect(system).toContain('Characterization.knowledge');
    expect(system).toContain('Characterization.forgotten');
    // 白名单：分层 fact（hasReaderPerceivedLayer）+ gap_whitelist 命中不报。
    expect(system).toContain('hasReaderPerceivedLayer');
    expect(system).toContain('gap_whitelist');
    // per-chapter scope 三边界（不越 4.4 cross-arc / 不改 6.5 promise-landing）。
    expect(system).toContain('per-chapter scope');
    expect(system).toContain('4.4');
    expect(system).toContain('6.5');
    // 不套 force-escalate（认知违背 writer 能补，走 route LLM 判）。
    expect(system).toContain('不强制 escalate');
  });

  it('AC2/AC3：info-gap 维 finding（Characterization.knowledge/forgotten）过 schema（dim name 开放 string）', async () => {
    // reviewOutputSchema dimensions[].name 是开放 z.string()——info-gap 维值合法，subClass 用 ConStory 既有子类。
    // 这是「L2 产出 info-gap finding 时 schema 不拒」的结构性保证（L2 是否真判违规是 dogfood gate，非单测范畴）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'revise',
      summary: '认知状态机违背：主角不该知 X 却知情',
      dimensions: [
        {
          name: 'info-gap',
          findings: [
            {
              subClass: 'Characterization.knowledge',
              severity: 'block',
              quote: '主角突然说出了只有反派知道的密语',
              location: '句5',
              explanation: '前章从未知悉密语（视图 unaware），本章却表现知情',
            },
            {
              subClass: 'Characterization.forgotten',
              severity: 'warn',
              quote: '主角忘了早已被告知的约定',
              location: '句8',
              explanation: '前章已 believes_true，本章写成不知情',
            },
          ],
        },
      ],
      reasons: ['KNOWLEDGE_VIOLATION 句5', 'FORGOTTEN_REVEAL 句8'],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest');
    const dims = (result.artifact as { dimensions: Array<{ name: string; findings: Array<{ subClass?: string; severity: string }> }> })
      .dimensions;
    expect(dims[0].name).toBe('info-gap');
    expect(dims[0].findings).toHaveLength(2);
    expect(dims[0].findings[0].subClass).toBe('Characterization.knowledge');
    expect(dims[0].findings[0].severity).toBe('block');
    expect(dims[0].findings[1].subClass).toBe('Characterization.forgotten');
  });

  it('AC6 三边界：info-gap 维与 consistency / promise-landing 维并存于同一 review.latest（各报各的）', async () => {
    // 6.2 与 6.5/consistency 机制独立：同一 review.latest 可含多 dim，各报各的 finding（route LLM 去重）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'revise',
      summary: '多维度问题',
      dimensions: [
        {
          name: 'consistency',
          findings: [{ subClass: 'Characterization.memory', severity: 'warn', quote: '动机矛盾', location: '句1', explanation: 'e' }],
        },
        {
          name: 'promise-landing',
          findings: [{ subClass: 'Promise.unlanded-plant', severity: 'warn', quote: '伏笔没种', location: '句2', explanation: 'e' }],
        },
        {
          name: 'info-gap',
          findings: [{ subClass: 'Characterization.knowledge', severity: 'block', quote: '不该知情', location: '句3', explanation: 'e' }],
        },
      ],
      reasons: ['三维度并存'],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const dims = (result.artifact as { dimensions: Array<{ name: string }> }).dimensions;
    expect(dims.map((d) => d.name).sort()).toEqual(['consistency', 'info-gap', 'promise-landing']);
  });

  it('AC8 路由：info-gap 维 block finding + LLM 返 auto_revise → 不套 force-escalate（走 route LLM 判）', async () => {
    // info-gap 维名不含 narrative|discourse|imagery|agency 关键字 → hasNarrativeFeatureBlock guard 不命中。
    // 认知违背是内容缺陷 writer 能补写（非 discourse 人导演域），尊重 LLM 判 auto_revise（design D5/D6）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '补认知' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'info-gap',
              findings: [{ severity: 'block', quote: '不该知情', location: '句3', explanation: 'KNOWLEDGE_VIOLATION' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    // info-gap block 不触发 guard → 尊重 LLM 判 auto_revise（非 escalate_user）。
    expect((result.artifact as { decision: string }).decision).toBe('auto_revise');
  });

  it('R6① parse 失败 → fallback verdict=escalate（永不假 pass / 静默 fail）', async () => {
    const generate = vi.fn<GenerateFn>();
    generate
      .mockResolvedValueOnce({ content: 'NOT_JSON_at_all', finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'STILL_NOT_JSON', finishReason: 'stop' });
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(generate).toHaveBeenCalledTimes(2); // 初试 + 重试
    expect(result.stateKey).toBe('review.latest');
    const artifact = result.artifact as { verdict: string; summary: string; reasons: string[] };
    expect(artifact.verdict).toBe('escalate'); // R6① 永不假 pass
    expect(artifact.reasons).toContain('reader-audit-parse-failure');
  });

  it('E1：L1 compute 抛错 → 降级空 report 继续跑 L2（不崩链；tagger 抛被 try/catch 兜）', async () => {
    // E1（CR patch）：computeL1SignalReport 包 try/catch——tagger 运行时抛（或任何 L1 内部错）降级空 report，
    // 继续 L2（不崩链）。R6①「永不崩链」由 L2 escalate fallback 兜底；L1 失败仅缺 hotspot 提示。
    // isPosTaggerAvailable()=true（测试环境 native binding 在），故 deps.tagChinese 会被注入 → 抛错路径可测。
    const throwingTagger = (): never => { throw new Error('tagger boom'); };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate, tagChinese: throwingTagger });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    // L2 仍跑了（generate 被调一次），节点不崩，产正常 review（非 error artifact）
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.stateKey).toBe('review.latest');
    expect((result.artifact as { verdict: string }).verdict).toBe('revise');
  });

  it('CR-8：verdict 非规范值（"pass_with_minor_notes"）→ 开放纵容（z.string()），透传 route LLM 裁决', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ verdict: 'pass_with_minor_notes', summary: 's' }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(generate).toHaveBeenCalledTimes(1); // 开放值合法，不重试
    expect(result.stateKey).toBe('review.latest');
    expect((result.artifact as { verdict: string }).verdict).toBe('pass_with_minor_notes');
  });

  it('verdict 缺失（结构不合法）→ Zod 拒 → 重试 → R6① fallback escalate（非 error artifact）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ summary: 's' })); // 无 verdict（required）
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(generate).toHaveBeenCalledTimes(2);
    // Reader-Audit fallback = escalate（非 createLlmNode 的 error artifact）—— R6① 永不假 pass
    expect(result.stateKey).toBe('review.latest');
    expect((result.artifact as { verdict: string }).verdict).toBe('escalate');
  });

  it('缺 dimensions/reasons → Zod default 兜底（[]）仍通过', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ verdict: 'pass', summary: 'ok' }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const artifact = result.artifact as { dimensions: unknown[]; reasons: unknown[] };
    expect(artifact.dimensions).toEqual([]);
    expect(artifact.reasons).toEqual([]);
  });

  it('findings severity 缺省 → catch warn（封闭 enum 机械控制信号）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'revise',
      summary: 's',
      dimensions: [{ name: 'consistency', findings: [{ quote: 'q', location: '句1', explanation: 'e' }] }],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const finding = (result.artifact as { dimensions: Array<{ findings: Array<{ severity: string }> }> })
      .dimensions[0].findings[0];
    expect(finding.severity).toBe('warn'); // 缺省 → .catch('warn')
  });

  it('E9：findings severity 非法值（"critical"）→ .catch(warn) 降级，不丢全 review', async () => {
    // .catch 非 .default：.default 只管 undefined，.catch 容忍非法 enum 值——单坏值降级 'warn'，review 其余保留。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'revise',
      summary: 's',
      dimensions: [{
        name: 'consistency',
        findings: [
          { severity: 'critical', quote: 'q1', location: '句1', explanation: 'e1' },
          { severity: 'block', quote: 'q2', location: '句2', explanation: 'e2' },
        ],
      }],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest');
    const dims = (result.artifact as { dimensions: Array<{ findings: Array<{ severity: string; quote: string }> }> })
      .dimensions;
    // 非法 'critical' 降级 'warn'（非整 review 丢）；合法 'block' 保留
    expect(dims[0].findings).toHaveLength(2);
    expect(dims[0].findings[0].severity).toBe('warn');
    expect(dims[0].findings[1].severity).toBe('block');
  });

  it('E3：findings quote/location 空串 → schema 拒收（grounding 硬要求 defense-in-depth）', async () => {
    // 空串过旧 schema（违 R3 §1.2 evidence-grounded）；.min(1) 拒收 → 重试 → R6① fallback escalate。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'revise',
      summary: 's',
      dimensions: [{
        name: 'consistency',
        findings: [{ severity: 'warn', quote: '', location: '句1', explanation: 'e' }],
      }],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(generate).toHaveBeenCalledTimes(2); // 空串 quote 拒收 → 重试
    // 重试仍失败 → R6① fallback escalate（非假 pass）
    expect((result.artifact as { verdict: string }).verdict).toBe('escalate');
  });

  // ── Step 7：gap whitelist（design §8）── brief 信息控制 + gap_whitelist 喂 L2 防误报。

  it('Step 7 gap whitelist: brief hintOnly + gap_whitelist 注入 briefIntent + system 含故意惊喜白名单指令', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({
        chapter_brief: {
          goal: 'g',
          mustHide: '主角的真实身份',
          hintOnly: '身世线索只能暗示',
          gap_whitelist: [{ location: '句4', reason: '故意信息延迟（信息差操控）' }],
        },
      }),
      requirement: '',
    });

    const systemArg = generate.mock.calls[0][1];
    // L2 system 段含故意惊喜白名单指令（防误报作者故意的非线性叙事/信息延迟）
    expect(systemArg).toContain('故意惊喜');
    expect(systemArg).toContain('gap_whitelist');

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // briefIntent 含 mustHide + hintOnly + gap_whitelist reason（喂 L2 据创作意图不误报）
    expect(userContent).toContain('主角的真实身份');
    expect(userContent).toContain('身世线索只能暗示');
    expect(userContent).toContain('故意信息延迟（信息差操控）');
  });

  // ── Story 6.3 R3 Step 6：brief manipulationDirectives 经 briefIntent 序列化喂 L2（forbiddenMoves 违规判 +
  //    subjective_mislead 白名单）。NO chapter-nodes.ts var/code change——briefIntent 已 JSON.stringify 整个
  //    chapter_brief（含 R1 加的 manipulationDirectives 字段，chapter-nodes.ts:353）。prompt 侧（multi-review-agent.yaml）
  //    扩 forbiddenMoves 消费指令 + subjective_mislead 白名单。此处验 briefIntent 真携带 manipulationDirectives。──

  it('6.3 R3 Step 6: brief manipulationDirectives 经 briefIntent 序列化注入（forbiddenMoves + mode round-trip）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({
        chapter_brief: {
          goal: 'g',
          // R1 compileInfoRelease 产 manipulationDirectives[] structured 字段供 L2 精确裁判（与 #3 mustHide 平行）。
          manipulationDirectives: [
            {
              mode: 'subjective_mislead',
              actions: ['plant', 'withhold'],
              forbiddenMoves: ['主角提到那封密信', '揭示凶手的真实身份'],
              target: '读者对凶手身份的误判',
            },
          ],
        },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // briefIntent = JSON.stringify(chapter_brief) 含 manipulationDirectives（forbiddenMoves 精确实体 + mode）。
    // L2 据此逐条判 Writer 是否违规透露禁实体 + mode=subjective_mislead 白名单不误报。
    expect(userContent).toContain('manipulationDirectives');
    expect(userContent).toContain('主角提到那封密信');
    expect(userContent).toContain('揭示凶手的真实身份');
    expect(userContent).toContain('subjective_mislead');
    // renderTemplate 无残留 {{}} 模板标记
    expect(userContent).not.toContain('{{');
  });

  it('6.3 R3 Step 6: multi-review-agent.yaml prompt 含 forbiddenMoves 消费 + subjective_mislead 白名单指令', () => {
    // prompt-only 范式（无 chapter-nodes.ts var 改动）：forbiddenMoves→L2 信号全靠 prompt 指令 + briefIntent 序列化。
    // 验 yaml 含 forbiddenMoves 违规判段 + subjective_mislead 白名单（防 6.2 DW-3 defer 信号源漏接 + R6① 不假 pass）。
    const yamlPath = resolve(__dirname, '../prompts/multi-review-agent.yaml');
    const yaml = readFileSync(yamlPath, 'utf-8');
    // forbiddenMoves 消费指令（L2 逐条判违规透露，复用 KNOWLEDGE_VIOLATION 子类）
    expect(yaml).toContain('forbiddenMoves');
    expect(yaml).toContain('不假 pass');
    // subjective_mislead 白名单（6.2 DW-3 defer 信号源 → 6.3 接，mode=subjective_mislead 不报）
    expect(yaml).toContain('subjective_mislead');
    expect(yaml).toContain('mode === \'subjective_mislead\'');
  });

  // ── Story 8.4 Step 6（A11 审核对照）：researchBrief 注入 + findings attribution 三态归因（mirror 6.2 optional 哲学）──

  /** 写手自查产 research_brief artifact fixture（writer-node mutate 写形态：brief 本体 + 存档元数据）。 */
  const WRITER_RESEARCH_BRIEF = {
    brief: {
      plan: '先城门对峙再入城收束',
      entries: [
        { ref: 'char-lin', kind: 'asset', key_facts: [{ fact: '林昭左臂旧伤未愈', source: '人物卡 char-lin' }] },
      ],
      issues: [],
      execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙节拍', notes: '短句提速' }],
      deviations: [],
    },
    briefHash: 'sha256:fixture',
    rounds: 3,
    verifyRounds: 1,
    verified: true,
  };

  it('8.4：research_brief artifact 在（含 brief）→ researchBrief 注入 user prompt（简报本体：执行案场 id + 出处事实）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({ research_brief: WRITER_RESEARCH_BRIEF }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // researchBrief 段注入——含数据段标题 + 简报本体内容（执行案场 id + 出处锚定事实）。
    expect(userContent).toContain('写手的调查简报与写作执行案');
    expect(userContent).toContain('s_gate');
    expect(userContent).toContain('林昭左臂旧伤未愈');
    // 注入的是简报本体（brief 子对象）非档案外壳（briefHash/rounds 是存档元数据，非归因对照材料）。
    expect(userContent).not.toContain('sha256:fixture');
    // renderTemplate 无残留 {{researchBrief}} 模板标记。
    expect(userContent).not.toContain('{{researchBrief}}');
  });

  it('8.4 graceful：research_brief artifact 缺 → researchBrief 空段（零注入，Reader-Audit 不崩零回归）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // makeReaderAuditRun 不含 research_brief（默认缺省——旧链/测试环境）。
    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest'); // 节点不崩，正常产 review（降级零回归）
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('写手的调查简报与写作执行案'); // 段渲染但序列化空串
    expect(userContent).not.toContain('s_gate'); // 零注入（简报内容不出现）
    expect(userContent).not.toContain('{{researchBrief}}'); // 模板标记已替换
    expect(userContent).not.toContain('{{'); // 无残留任何模板标记
  });

  it('8.4 degraded：research_brief = {degraded,reason} 形态（自查降级/直写路径）→ researchBrief 空段不注简报', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({
      run: makeReaderAuditRun({ research_brief: { degraded: true, reason: 'research_tools_unavailable' } }),
      requirement: '',
    });

    expect(result.stateKey).toBe('review.latest');
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // degraded 形态无 brief → 空串注入（mirror cognitionContext `?? ''`——降级路径审核对照降级零回归）。
    expect(userContent).not.toContain('s_gate');
    expect(userContent).not.toContain('林昭左臂旧伤未愈');
  });

  it.each(['execution_gap', 'planning_blind', 'plan_level'] as const)(
    '8.4：findings attribution=%s 过 schema（三态归因产出路径——review.latest 携归因）',
    async (attribution) => {
      const generate = vi.fn<GenerateFn>(async () =>
        makeOkResult({
          verdict: 'revise',
          summary: '正文与写作执行案不符',
          dimensions: [
            {
              name: 'consistency',
              findings: [
                {
                  subClass: 'Timeline.causality',
                  severity: 'warn',
                  quote: '两人径直穿过城门',
                  location: '段1',
                  explanation: '执行案 s_gate 安排了对峙节拍，正文直接进城未写',
                  attribution,
                },
              ],
            },
          ],
          reasons: [],
        }),
      );
      const node = createReaderAuditNode({ generate });

      const result = await node.run({
        run: makeReaderAuditRun({ research_brief: WRITER_RESEARCH_BRIEF }),
        requirement: '',
      });

      expect(result.stateKey).toBe('review.latest');
      const finding = (
        result.artifact as { dimensions: Array<{ findings: Array<{ attribution?: string }> }> }
      ).dimensions[0].findings[0];
      expect(finding.attribution).toBe(attribution); // optional 字段 additive 透传（非法不拒、合法携带）
    },
  );

  it('8.4：attribution 非法值（"writer_fault"）→ .catch(undefined) 丢字段不丢 finding（mirror E9 severity 容忍）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeOkResult({
        verdict: 'revise',
        summary: '正文与写作执行案不符',
        dimensions: [
          {
            name: 'consistency',
            findings: [
              {
                severity: 'warn',
                quote: '两人径直穿过城门',
                location: '段1',
                explanation: '执行案安排了对峙节拍，正文直接进城未写',
                attribution: 'writer_fault', // 值外字面量（LLM 变体）
              },
            ],
          },
        ],
        reasons: [],
      }),
    );
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest');
    const finding = (
      result.artifact as { dimensions: Array<{ findings: Array<{ quote: string; attribution?: string }> }> }
    ).dimensions[0].findings[0];
    expect(finding.quote).toBe('两人径直穿过城门'); // finding 保留（单坏值不掀翻整个 review）
    expect(finding.attribution).toBeUndefined(); // 非法归因降级「无归因」
  });

  it('8.4 prompt：multi-review-agent.yaml 含 {{researchBrief}} 数据段 + attribution 三态归因指令', () => {
    const yamlPath = resolve(__dirname, '../prompts/multi-review-agent.yaml');
    const yaml = readFileSync(yamlPath, 'utf-8');
    // 数据段（optional var + 空段降级语义——无简报不输出 attribution）。
    expect(yaml).toContain('{{researchBrief}}');
    expect(yaml).toContain('写手的调查简报与写作执行案');
    // system 归因段 + 三态枚举就地解释（execution_gap 执行漏 / planning_blind 规划盲 / plan_level 计划层）。
    expect(yaml).toContain('计划对照归因');
    expect(yaml).toContain('execution_gap');
    expect(yaml).toContain('planning_blind');
    expect(yaml).toContain('plan_level');
    // 输出契约字段（findings.attribution）。
    expect(yaml).toContain('attribution:');
  });

  // ── C1.2：lint_report 注入（Reader-Audit 叙事特征维 lint 软信号，mirror promiseLedger/cognitionContext pattern）──

  it('C1.2：lint_report artifact 在 → lintReport 注入 user prompt（agent 桶聚合 + 引文样例 + 密度指纹）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // lint_report 形态 = lint-node 产的 agent 桶 LintChapterReport（issues 逐条自包含）。
    // 混入 1 条 review=human 命中（验投影 agent 桶过滤——human/none 不驱动 L2）。
    const lintReport = {
      chapterId: 'ep-1',
      issues: [
        {
          ruleId: 'story-deslop.not-is-comparison', namespace: 'story-deslop', title: '不是而是对比',
          level: 'high', review: 'agent', fixability: 'manual', chapterId: 'ep-1',
          line: 1, column: 1, endLine: 1, endColumn: 8, match: '不是怯懦，而是清醒',
          context: { before: '', current: '不是怯懦，而是清醒', after: '' },
        },
        {
          ruleId: 'story-deslop.not-is-comparison', namespace: 'story-deslop', title: '不是而是对比',
          level: 'high', review: 'agent', fixability: 'manual', chapterId: 'ep-1',
          line: 2, column: 3, endLine: 2, endColumn: 10, match: '不是退让，而是选择',
          context: { before: '', current: '不是退让，而是选择', after: '' },
        },
        {
          ruleId: 'filler.worth-noting', namespace: 'filler', title: '值得注意的是',
          level: 'low', review: 'human', fixability: 'manual', chapterId: 'ep-1',
          line: 3, column: 1, endLine: 3, endColumn: 6, match: '值得注意的是',
          context: { before: '', current: '值得注意的是', after: '' },
        },
      ],
      densityIssues: [
        { ruleId: 'story-deslop.abstract-summary-density', chapterId: 'ep-1', line: 1, column: 1, hits: 5, perKilo: 7.2, samples: ['新的开始', '全新的开始'] },
      ],
      summary: { total: 3, high: 2, medium: 0, low: 1, visibleChars: 800 },
      upstream: { repo: 'r', commit: 'c', ruleVersion: '3.0.0' },
    };

    await node.run({
      run: makeReaderAuditRun({ lint_report: lintReport }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // lintReport 段注入——按规则聚合的命中清单（count=2 + 两条去重引文）。
    expect(userContent).toContain('lint 静态命中清单');
    expect(userContent).toContain('story-deslop.not-is-comparison');
    expect(userContent).toContain('不是而是对比');
    expect(userContent).toContain('不是怯懦，而是清醒');
    expect(userContent).toContain('不是退让，而是选择');
    // 密度指纹投影（hits/perKilo + 样本）。
    expect(userContent).toContain('story-deslop.abstract-summary-density');
    expect(userContent).toContain('新的开始');
    // agent 桶过滤：human 桶命中（filler.worth-noting）不注入（不驱动 L2 改写判断）。
    expect(userContent).not.toContain('filler.worth-noting');
  });

  it('C1.2 graceful：lint_report artifact 缺 → lintReport 空段（零注入，Reader-Audit 不崩零回归）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // makeReaderAuditRun 不含 lint_report（老链/旧 snapshot/bypass 路径合法状态——不在 requiredArtifactKeys）。
    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest'); // 节点不崩，正常产 review
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('lint 静态命中清单'); // 数据段标签在（renderTemplate 塌空串）
    expect(userContent).not.toContain('{{lintReport}}'); // 无残留模板标记
    expect(userContent).not.toContain('{{');
  });

  it('C1.2 prompt：multi-review-agent.yaml 含 {{lintReport}} 数据段 + semantic 8 条判定任务 + 软信号纪律', () => {
    const yamlPath = resolve(__dirname, '../prompts/multi-review-agent.yaml');
    const yaml = readFileSync(yamlPath, 'utf-8');
    // user 数据段（lintReport templateVar + 软信号语义说明）。
    expect(yaml).toContain('{{lintReport}}');
    expect(yaml).toContain('规则命中≠定罪');
    // system lint 段（消费纪律 + semantic 8 条判定任务清单——rule id 全集）。
    expect(yaml).toContain('lint 静态命中与 semantic 判定');
    for (const ruleId of [
      'hollow-summary-paragraph',
      'hidden-actor',
      'mechanical-elevation-ending',
      'over-explaining-reader',
      'quotable-punchline',
      'register-mismatch',
      'monotone-rhythm',
      'low-specificity',
    ]) {
      expect(yaml).toContain(ruleId);
    }
    // 判定任务措辞 = 上游规则 prompt 原文（抽 2 条锚点防改写漂移）。
    expect(yaml).toContain('判断段落是否只是把前文包装成空泛总结，而没有推进事实、情绪、论点或场景。');
    expect(yaml).toContain('判断文本是否用抽象判断替代了具体信息。');
    // LLM 消费纪律（逐组回应 + 截断标注 + 空清单零回归）。
    expect(yaml).toContain('逐组回应');
    expect(yaml).toContain('truncated=true');
  });

  it('W3 prompt：multi-review-agent.yaml 含 source 来源标记条款；{{continuityMemory}} 已移除（提取段后移）', () => {
    const yamlPath = resolve(__dirname, '../prompts/multi-review-agent.yaml');
    const yaml = readFileSync(yamlPath, 'utf-8');
    // W3（R2 H2）：lint 清单判真条目携带 source:'lint' 的标注纪律（system 段）+ 输出契约字段（user 段）。
    expect(yaml).toContain('来源标记');
    expect(yaml).toContain('"source": "lint"');
    expect(yaml).toContain('source: 仅当你根据上方「lint 静态命中清单」');
    // 两约束 ② 豁免划界（lint 条目例外可 auto_revise）+ verdict revise 档含 lint 确认 AI 味。
    expect(yaml).toContain('source=lint 豁免除外');
    expect(yaml).toContain('lint 确认的 AI 味未清');
    // W3（R5）：continuityMemory var 已删——story-sync 后移 E9，审读不再消费本章自提物。
    expect(yaml).not.toContain('{{continuityMemory}}');
    expect(yaml).not.toContain('连续性记忆');
  });

  // ── Story 5.4：情绪维注入（Reader-Audit emotion-landing + pacing-breath 数据源，mirror 6.2/6.5 pattern）──

  it('5.4：emotion_curve artifact 在 → emotionCurve 注入 user prompt（含 per-scene 目标情绪）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({
        emotion_curve: {
          unit: 'scene',
          points: [
            {
              refId: 'scene-1',
              sceneMood: '压抑',
              characters: [{ characterId: 'char-1', emotion: '恐惧' }],
            },
          ],
          emotional_promises: [],
          catharsis_points: [],
        },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // emotionCurve 段注入——含场 id + 目标情绪语义词。
    expect(userContent).toContain('情绪目标弧');
    expect(userContent).toContain('scene-1');
    expect(userContent).toContain('压抑');
    expect(userContent).toContain('恐惧');
    // renderTemplate 无残留 {{emotionCurve}} 模板标记。
    expect(userContent).not.toContain('{{emotionCurve}}');
  });

  it('5.4 graceful：emotion_curve artifact 缺 → emotionCurve 空段（Reader-Audit 不崩）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // makeReaderAuditRun 不含 emotion_curve（默认缺省）。
    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest'); // 节点不崩，正常产 review
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // emotionCurve 段渲染但序列化空串。
    expect(userContent).toContain('情绪目标弧');
    // renderTemplate 无残留 {{emotionCurve}} 模板标记（已替换为空串）。
    expect(userContent).not.toContain('{{emotionCurve}}');
    // 无残留任何模板标记。
    expect(userContent).not.toContain('{{');
  });

  it('5.4：pacingBreath 注入（连续 3 场推进 → breached=true 机械信号）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({
      run: makeReaderAuditRun({
        scene_graph: {
          nodes: [
            { id: 's1', episodeId: 'ep_target', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor', lineTags: ['l1'], pacingRole: '推进' },
            { id: 's2', episodeId: 'ep_target', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal', lineTags: ['l1'], pacingRole: '推进' },
            { id: 's3', episodeId: 'ep_target', storyTime: 2, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal', lineTags: ['l1'], pacingRole: '推进' },
          ],
        },
        chapter_brief_input: { episodeId: 'ep_target', brief: { goal: '高压章节' } },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // pacingBreath 段注入——breached=true（连续 3 场推进）。
    expect(userContent).toContain('节奏喘息纯代码 hotspot');
    expect(userContent).toContain('"breached":true');
    expect(userContent).toContain('"maxConsecutiveIntense":3');
    // renderTemplate 无残留 {{pacingBreath}} 模板标记。
    expect(userContent).not.toContain('{{pacingBreath}}');
  });

  it('5.4 graceful：无 pacingRole 数据 → pacingBreath breached=false + note=no-pacing-data', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    // scene_graph 无 pacingRole（makeReaderAuditRun 默认 scene_graph={nodes:[]}）。
    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest'); // 节点不崩
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    // pacingBreath 段注入——breached=false（无 pacingRole 数据）。
    expect(userContent).toContain('节奏喘息纯代码 hotspot');
    expect(userContent).toContain('"breached":false');
    expect(userContent).toContain('no-pacing-data');
    // renderTemplate 无残留模板标记。
    expect(userContent).not.toContain('{{');
  });

  it('5.4 prompt：system 段含情绪维 + 两 subClass + scope + 白名单 + 不套 force-escalate', async () => {
    // 验 prompt 情绪维段已加（unlanded + pacing-breath + scope + 白名单 + 不强制 escalate）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_REVIEW));
    const node = createReaderAuditNode({ generate });

    await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const [, system] = generate.mock.calls[0] as unknown as [
      unknown,
      string,
      unknown,
      unknown,
      unknown,
    ];
    // system prompt 含情绪维段。
    expect(system).toContain('情绪维');
    expect(system).toContain('emotion-landing');
    expect(system).toContain('pacing-breath');
    // 两 subClass 约定。
    expect(system).toContain('Emotion.unlanded');
    expect(system).toContain('Emotion.pacing-breath');
    // 落地公理（类比 promise-landing）。
    expect(system).toContain('落地公理');
    // 白名单（Director 故意持续高压不报）。
    expect(system).toContain('白名单');
    expect(system).toContain('持续高压');
    // scope 边界（不越 4.4 cross-arc）。
    expect(system).toContain('4.4');
    // 不套 force-escalate（情绪落地缺失 writer 能补，走 route LLM 判）。
    expect(system).toContain('不强制 escalate');
  });

  it('AC2：Emotion.unlanded finding 过 schema（dim name="emotion"，severity=block，含 grounding）', async () => {
    // reviewOutputSchema dimensions[].name 是开放 z.string()——emotion 维值合法。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'revise',
      summary: '情绪落地缺失：Director 设计的恐惧没写出来',
      dimensions: [
        {
          name: 'emotion',
          findings: [
            {
              subClass: 'Emotion.unlanded',
              severity: 'block',
              quote: '他走进了房间',
              location: '句5',
              explanation: 'Director 目标情绪「恐惧」但正文无恐惧渲染（欠情绪债）',
            },
          ],
        },
      ],
      reasons: ['Emotion.unlanded 句5：恐惧未落地'],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest');
    const dims = (result.artifact as { dimensions: Array<{ name: string; findings: Array<{ subClass?: string; severity: string }> }> })
      .dimensions;
    expect(dims[0].name).toBe('emotion');
    expect(dims[0].findings[0].subClass).toBe('Emotion.unlanded');
    expect(dims[0].findings[0].severity).toBe('block');
  });

  it('AC3：Emotion.pacing-breath finding 过 schema（dim name="emotion"，severity=warn）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'pass',
      summary: '节奏喘息风险：连续 4 场高强度无松弛',
      dimensions: [
        {
          name: 'emotion',
          findings: [
            {
              subClass: 'Emotion.pacing-breath',
              severity: 'warn',
              quote: '他冲向前方，剑光闪烁',
              location: '段3',
              explanation: '连续 4 场推进/高潮无喘息间隔，读者麻木风险',
            },
          ],
        },
      ],
      reasons: ['Emotion.pacing-breath 段3：节奏连续高压'],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    expect(result.stateKey).toBe('review.latest');
    const dims = (result.artifact as { dimensions: Array<{ name: string; findings: Array<{ subClass?: string; severity: string }> }> })
      .dimensions;
    expect(dims[0].name).toBe('emotion');
    expect(dims[0].findings[0].subClass).toBe('Emotion.pacing-breath');
    expect(dims[0].findings[0].severity).toBe('warn');
  });

  it('AC4 路由：emotion 维 block finding + LLM 返 auto_revise → 不套 force-escalate（走 route LLM 判）', async () => {
    // emotion 维名不含 narrative|discourse|imagery|agency 关键字 → hasNarrativeFeatureBlock guard 不命中。
    // 情绪落地缺失是内容缺陷 writer 能补写（非 discourse 人导演域），尊重 LLM 判 auto_revise。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '补情绪' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'emotion',
              findings: [{ severity: 'block', quote: '他走进房间', location: '句5', explanation: 'Emotion.unlanded 恐惧未落地' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    // emotion block 不触发 guard → 尊重 LLM 判 auto_revise（非 escalate_user）。
    expect((result.artifact as { decision: string }).decision).toBe('auto_revise');
  });

  it('5.4：emotion 维与其他维度并存于同一 review.latest（各报各的）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({
      verdict: 'revise',
      summary: '多维度问题（含情绪维）',
      dimensions: [
        {
          name: 'consistency',
          findings: [{ subClass: 'Characterization.memory', severity: 'warn', quote: '动机矛盾', location: '句1', explanation: 'e' }],
        },
        {
          name: 'emotion',
          findings: [{ subClass: 'Emotion.unlanded', severity: 'block', quote: '恐惧没写出', location: '句3', explanation: 'e' }],
        },
      ],
      reasons: ['多维度并存（含情绪维）'],
    }));
    const node = createReaderAuditNode({ generate });

    const result = await node.run({ run: makeReaderAuditRun(), requirement: '' });

    const dims = (result.artifact as { dimensions: Array<{ name: string }> }).dimensions;
    expect(dims.map((d) => d.name).sort()).toEqual(['consistency', 'emotion']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// targeted-revision 节点——测试已随 W4 F-1 清理删除（yaml/prompts/targeted-revision-agent.yaml
// 已删，dormant 工厂 createTargetedRevisionNode 的 yaml 加载不再可测）；CR 批（CR-25）工厂本体与
// CONTRACTS 条目已一并清零（见 chapter-nodes.ts / agentContracts.ts 退役注记）。
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// route 节点（ADR-17 反馈路由）
// ════════════════════════════════════════════════════════════════════════════

const VALID_ROUTE = { decision: 'accept_as_truth', reason: '正文把主角进城动机写实了，是升级非错误' };

describe('route 节点', () => {
  it('parseOutput: valid JSON → decision 三档 + reason + stateKey=route_decision', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_ROUTE));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': { verdict: 'revise', reasons: ['偏离'] },
        chapter_brief: { goal: 'g' },
        'draft.initial': { text: '正文' },
      }),
      requirement: '',
    });

    expect(result.stateKey).toBe('route_decision');
    expect(result.artifact).toEqual(VALID_ROUTE);
  });

  it('三档 decision 均合法（auto_revise / accept_as_truth / escalate_user）', async () => {
    for (const decision of ['auto_revise', 'accept_as_truth', 'escalate_user'] as const) {
      const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision, reason: 'r' }));
      const node = createRouteNode({ generate });

      const result = await node.run({ run: makeRun({}), requirement: '' });

      expect((result.artifact as { decision: string }).decision).toBe(decision);
    }
  });

  it('buildPrompt: verdict 标量 + reasons/chapterBrief 序列化 + draft 抽 draft.initial.text', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_ROUTE));
    const node = createRouteNode({ generate });

    await node.run({
      run: makeRun({
        'review.latest': { verdict: 'revise', reasons: ['OOC 风险'] },
        chapter_brief: { mustHide: '主角身份', emotionTarget: { emotion: '紧张' } },
        'draft.initial': { text: 'DRAFT_FOR_ROUTE' },
      }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('revise'); // verdict 标量
    expect(userContent).toContain('OOC 风险'); // reasons 序列化
    expect(userContent).toContain('主角身份'); // chapterBrief 序列化
    expect(userContent).toContain('DRAFT_FOR_ROUTE'); // draft 标量
  });

  it('generate 收到 route-agent.yaml 的 system 段（非 Orison 默认，含「路由判决」语义）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_ROUTE));
    const node = createRouteNode({ generate });

    await node.run({ run: makeRun({}), requirement: '' });

    const systemArg = generate.mock.calls[0][1];
    // route-agent.yaml system 段编码三档判据 + 创作意图优先（AC「route 非规则」）
    expect(systemArg).toContain('路由');
    expect(systemArg).toContain('auto_revise');
    expect(systemArg).toContain('accept_as_truth');
    expect(systemArg).toContain('escalate_user');
    expect(systemArg).not.toContain('You are Closure');
  });

  it('CR-8：route decision 别名归一（中文/连字符/缩写 → canonical 三档）', async () => {
    const cases: Array<[string, string]> = [
      ['自动修订', 'auto_revise'],
      ['auto-revise', 'auto_revise'],
      ['accept', 'accept_as_truth'],
      ['通过', 'accept_as_truth'],
      ['上报', 'escalate_user'],
      ['escalate', 'escalate_user'],
    ];
    for (const [alias, canonical] of cases) {
      const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: alias, reason: 'r' }));
      const node = createRouteNode({ generate });
      const result = await node.run({ run: makeRun({}), requirement: '' });
      expect((result.artifact as { decision: string }).decision).toBe(canonical);
    }
  });

  it('CR-8：无法识别的 decision（非三档/非别名）→ normalizeRouteDecision undefined → 抛 → 重试 → 兜底', async () => {
    // machinery 不能驱动未知 decision（chainRunner switch 需规范化值）→ 重试，非假信心判死
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'invalid_choice', reason: 'r' }));
    const node = createRouteNode({ generate });

    const result = await node.run({ run: makeRun({}), requirement: '' });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.stateKey).toBe('route-agent'); // 兜底用 nodeId
    expect((result.artifact as { error: boolean }).error).toBe(true);
  });

  it('user prompt 已渲染（含 verdict 值，不含字面 {{verdict}}）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_ROUTE));
    const node = createRouteNode({ generate });

    await node.run({
      run: makeRun({ 'review.latest': { verdict: 'escalate' } }),
      requirement: '',
    });

    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('escalate');
    expect(userContent).not.toMatch(/\{\{verdict\}\}/);
    expect(userContent).not.toMatch(/\{\{reasons\}\}/);
    expect(userContent).not.toMatch(/\{\{chapterBrief\}\}/);
    expect(userContent).not.toMatch(/\{\{draft\}\}/);
  });

  // ── R6② defense-in-depth guard（Story 4.2 / design §7②）──
  // narrative-feature 维 block finding + LLM 误判 auto_revise → 强制 escalate_user（discourse 人导演域）。

  it('R6② defense guard: narrative-feature block finding + LLM 返 auto_revise → 强制 escalate_user', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '改' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [{ severity: 'block', quote: '意象陈腐', location: '句1', explanation: '骨架偏 AI 腔' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    // discourse 域 block → 强制 escalate_user（永不 auto_revise 给 writer）
    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  it('E2：narrative-feature block + LLM 返 accept_as_truth → 强制 escalate_user（guard 覆盖 accept 漏洞）', async () => {
    // E2（CR patch）：guard 从 `decision === 'auto_revise'` 扩为 `decision !== 'escalate_user'`——
    // narrative-feature block 时 accept_as_truth 也不该静默接受（discourse 问题需用户结构重写）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'accept_as_truth', reason: '接受' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'pass',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [{ severity: 'block', quote: '骨架偏 AI', location: '句2', explanation: 'imagery 陈腐' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    // accept_as_truth + narrative-feature block → 强制 escalate_user（非静默接受）
    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  it('E7：narrative-feature dim 名同义词（"风格"/"骨架"）也命中 guard', async () => {
    // E7（CR patch）：dim 名正则扩同义词——LLM 用「风格」/「骨架」作 dim 名时 guard 不漏。
    for (const dimName of ['风格', '骨架', 'anti-slop', '文风']) {
      const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: 'r' }));
      const node = createRouteNode({ generate });
      const result = await node.run({
        run: makeRun({
          'review.latest': {
            verdict: 'revise',
            dimensions: [{ name: dimName, findings: [{ severity: 'block', quote: 'q', location: '句1', explanation: 'e' }] }],
          },
          chapter_brief: {},
          'draft.initial': { text: 't' },
        }),
        requirement: '',
      });
      expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
    }
  });

  it('R6② 不触发：narrative-feature warn（非 block）→ 走 LLM 判 auto_revise（不强制）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '改' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [{ severity: 'warn', quote: '...', location: '句1', explanation: '...' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    // warn 不触发 guard（仅 block 级触发）→ 尊重 LLM 判 auto_revise
    expect((result.artifact as { decision: string }).decision).toBe('auto_revise');
  });

  it('R6② 不触发：consistency block（非 narrative-feature 维）→ 走 LLM 判（不强制）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '改' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'consistency',
              findings: [{ severity: 'block', quote: '矛盾', location: '句1', explanation: '事实矛盾' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    // consistency 维 block 不触发 guard（writer 能按 fact 修）→ 尊重 LLM 判 auto_revise
    expect((result.artifact as { decision: string }).decision).toBe('auto_revise');
  });

  it('R6② dim name 开放匹配（"叙事特征" 中文变体也命中 guard）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: 'r' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: '叙事特征维',
              findings: [{ severity: 'block', quote: 'q', location: '句1', explanation: 'e' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  // ── 链流程重排 W3（R2 去味门禁 H2 机械门豁免，AC2d）+ CR-5（W-CR 批机械交叉核对）──
  // lint 来源（source='lint'）的叙事特征 block = 机械引擎命中 + L2 判真的确认 AI 味（明确缺陷）→
  // 豁免强制 escalate，可环内 auto_revise；非 lint 来源叙事特征 block 维持强制 escalate（人导演域）。
  // CR-5：豁免须过 isLintSourceMechanicallyConfirmed——source 是 LLM 自报字段，须与 lint_report 机械
  // 命中清单匹配（quote 互含 / ruleId 相等）才确认（design H2「机械标注非 LLM 自报」）。

  /** 机械命中清单 fixture（raw lint_report artifact 形态——issue.match 与 finding quote 逐字对齐）。 */
  const LINT_REPORT = {
    issues: [
      {
        ruleId: 'story-deslop.not-is-comparison',
        namespace: 'story-deslop',
        title: '不是X而是Y',
        level: 'medium',
        review: 'agent',
        fixability: 'suggest',
        chapterId: 'ch_001',
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 20,
        match: '不是怯懦，而是清醒',
        context: { before: '他停下脚步。', current: '那不是怯懦，而是清醒的抉择。', after: '随后转身离开。' },
      },
    ],
    densityIssues: [
      { ruleId: 'story-deslop.hollow-summary', chapterId: 'ch_001', line: 3, column: 1, hits: 5, perKilo: 2.5, samples: ['这一切终将过去'] },
    ],
  };

  it('AC2d 正向：narrative-feature block + source=lint + lint_report 机械匹配（quote 互含）→ 豁免强制 escalate，LLM 判 auto_revise 保留', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '去味' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [
                // lint 来源（llmlint 静态命中清单判真 + 机械核对过）——判源不判义豁免。
                { subClass: 'story-deslop.not-is-comparison', severity: 'block', quote: '不是怯懦，而是清醒', location: '句1', explanation: 'lint 确认套话', source: 'lint' },
              ],
            },
          ],
        },
        lint_report: LINT_REPORT,
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    // lint-sourced block 机械核对过 → 不触发 guard → 环内 auto_revise 去味（不强制 escalate）。
    expect((result.artifact as { decision: string }).decision).toBe('auto_revise');
  });

  it('AC2d 反向：narrative-feature block 无 source（人导演域语义判定）→ 仍强制 escalate_user', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '改' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              // source 缺省（L2 自判 / semantic 8 条——无机械确认）→ 人导演域硬规则不动。
              findings: [{ severity: 'block', quote: '意象陈腐', location: '句1', explanation: '语义判定陈腐' }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  it('AC2d 混合来源：同维 lint-sourced block + 非 lint block 并存 → 非 lint 条目触发强制 escalate（豁免只放行条目不放行维度）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '改' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [
                { subClass: 'story-deslop.not-is-comparison', severity: 'block', quote: '不是怯懦，而是清醒', location: '句1', explanation: 'lint 确认', source: 'lint' },
                { severity: 'block', quote: '意象陈腐', location: '句2', explanation: '语义判定' },
              ],
            },
          ],
        },
        lint_report: LINT_REPORT,
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  it('AC2d 豁免限 block 修复路径非 accept 直通：lint-sourced block + LLM 误判 accept_as_truth → 仍被 guard 豁免放行（去味条款归 route prompt 约束）', async () => {
    // guard 只判「lint 条目不强制 escalate」；「AI 味未清不可 accept」是 route prompt 去味条款（LLM 判），
    // 机械面由 summarize.lintUnresolved（hardEscalate 消费）承载——guard 不在此重复拦截（判源不判义）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'accept_as_truth', reason: '接受' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'pass',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [{ subClass: 'story-deslop.not-is-comparison', severity: 'block', quote: '不是怯懦，而是清醒', location: '句1', explanation: 'lint 确认', source: 'lint' }],
            },
          ],
        },
        lint_report: LINT_REPORT,
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('accept_as_truth');
  });

  it('W3 source 字段 schema 容忍：非法 source 值 → .catch(undefined) 丢字段不丢 finding（block 非 lint 来源照常触发 guard）', async () => {
    // 单坏值（LLM 返 source:'engine' 非法枚举）→ schema 降级无 source → guard 视为非 lint 来源（保守归人导演域）。
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: 'r' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [{ severity: 'block', quote: 'q', location: '句1', explanation: 'e', source: 'engine' as never }],
            },
          ],
        },
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  // ── CR-5（W-CR 批）：source='lint' 自报须经机械交叉核对——核对不过按 agent 来源强制 escalate ──

  it('CR-5：source=lint 自报但 lint_report artifact 缺 → 无机械确认不豁免 → 强制 escalate', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '去味' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              findings: [{ severity: 'block', quote: '不是怯懦，而是清醒', location: '句1', explanation: '自报 lint', source: 'lint' }],
            },
          ],
        },
        // lint_report 缺（L2 幻觉自标 / 旧链）→ 机械清单不存在 = 无机械确认。
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  it('CR-5：source=lint 自报 + lint_report 在但 quote/ruleId 均不匹配 → 不豁免 → 强制 escalate', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '去味' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              // quote 与清单命中无包含关系，subClass 非 ruleId——LLM 给语义判定条目自贴 lint 标签。
              findings: [{ subClass: 'imagery-staleness', severity: 'block', quote: '月光如水倾泻', location: '句1', explanation: '语义陈腐但自报 lint', source: 'lint' }],
            },
          ],
        },
        lint_report: LINT_REPORT,
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('escalate_user');
  });

  it('CR-5：ruleId 相等通道——subClass=命中规则 id（quote 无文本关联）→ 机械确认豁免 → auto_revise 保留', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult({ decision: 'auto_revise', reason: '去味' }));
    const node = createRouteNode({ generate });

    const result = await node.run({
      run: makeRun({
        'review.latest': {
          verdict: 'revise',
          dimensions: [
            {
              name: 'narrative-feature',
              // quote 引的是改写方向描述非原句，但 subClass 精确回填 ruleId——rule id 相等通道确认。
              findings: [{ subClass: 'story-deslop.not-is-comparison', severity: 'block', quote: '该段套用不是而是句式', location: '句1', explanation: 'lint 确认', source: 'lint' },
              ],
            },
          ],
        },
        lint_report: LINT_REPORT,
        chapter_brief: {},
        'draft.initial': { text: 't' },
      }),
      requirement: '',
    });

    expect((result.artifact as { decision: string }).decision).toBe('auto_revise');
  });

  it('CR-5 helper：isLintSourceMechanicallyConfirmed 逐通道（match 互含 / context.current / density 样本 / 空白归一 / 坏形态）', () => {
    // quote ⊇ issue.match（L2 引文包住机械命中片段）。
    expect(isLintSourceMechanicallyConfirmed(
      { quote: '那不是怯懦，而是清醒的抉择。', subClass: undefined },
      LINT_REPORT,
    )).toBe(true);
    // quote ⊆ issue.context.current（引用命中行的一部分）。
    expect(isLintSourceMechanicallyConfirmed(
      { quote: '清醒的抉择', subClass: undefined },
      LINT_REPORT,
    )).toBe(true);
    // density 样本互含。
    expect(isLintSourceMechanicallyConfirmed(
      { quote: '这一切终将过去，一切都将成为过去', subClass: undefined },
      LINT_REPORT,
    )).toBe(true);
    // 空白归一：LLM 引文压平换行后互含。
    expect(isLintSourceMechanicallyConfirmed(
      { quote: '不是怯懦，\n而是 清醒', subClass: undefined },
      LINT_REPORT,
    )).toBe(true);
    // ruleId 相等。
    expect(isLintSourceMechanicallyConfirmed(
      { quote: '无文本关联', subClass: 'story-deslop.not-is-comparison' },
      LINT_REPORT,
    )).toBe(true);
    // 无任何关联 → false。
    expect(isLintSourceMechanicallyConfirmed(
      { quote: '月光如水倾泻', subClass: 'imagery-staleness' },
      LINT_REPORT,
    )).toBe(false);
    // 坏形态 lint_report / 空 finding → false（无机械确认）。
    expect(isLintSourceMechanicallyConfirmed({ quote: 'q', subClass: 's' }, undefined)).toBe(false);
    expect(isLintSourceMechanicallyConfirmed({ quote: 'q', subClass: 's' }, 'not-an-object')).toBe(false);
    expect(isLintSourceMechanicallyConfirmed({}, LINT_REPORT)).toBe(false);
    expect(isLintSourceMechanicallyConfirmed({ quote: 'q', subClass: 's' }, { issues: 'bad' })).toBe(false);
  });

  it('R6② route-agent.yaml system 含 narrative-feature→escalate 约束（prompt 编码 + defense guard 双保险）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(VALID_ROUTE));
    const node = createRouteNode({ generate });

    await node.run({ run: makeRun({}), requirement: '' });

    const systemArg = generate.mock.calls[0][1];
    // route yaml system 段编码 R6② 约束（prompt 层）——defense guard 是兜底
    expect(systemArg).toContain('narrative-feature');
    expect(systemArg).toContain('escalate_user');
  });

  it('W3 去味条款：route-agent.yaml system 含「lint 确认的 AI 味未清不可 accept」+ 人导演域划界', () => {
    const yamlPath = resolve(__dirname, '../prompts/route-agent.yaml');
    const yaml = readFileSync(yamlPath, 'utf-8');
    // 去味门禁条款（R2）：source=lint 条目未清不得 accept_as_truth，应 auto_revise 去味。
    expect(yaml).toContain('去味门禁');
    expect(yaml).toContain('未清不得走 accept_as_truth');
    // 与 narrative-feature 人导演域划界说明（本条款只针对机械确认缺陷）。
    expect(yaml).toContain('source="lint"');
    expect(yaml).toContain('划清界限');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 契约元数据
// ════════════════════════════════════════════════════════════════════════════

describe('四 LLM 节点契约元数据', () => {
  it('draft-writer contract: reads chapter_brief/scene_graph/settings_context → owns draft.initial', () => {
    const node = createDraftWriterNode({ generate: noopGenerate });
    expect(node.contract?.nodeId).toBe('draft-writer-agent');
    // Story 8.4：research_brief may-produce 加入（writer-node 两阶段自查副产物；本单发引擎共享同一契约）。
    // Story 8.7 S7：cast_declaration 加入（阶段 2.5 申报轮 mutate 写；单发降级/段落级路径不写）。
    expect(node.contract?.producedArtifactKeys).toEqual(['draft.initial', 'research_brief', 'cast_declaration']);
    expect(node.contract?.requiredArtifactKeys).toContain('chapter_brief');
  });

  it('Reader-Audit contract（4.2）: reads draft.initial+scene_graph+chapter_brief → owns review.latest（W1d：story.sync 移出 required）', () => {
    const node = createReaderAuditNode({ generate: noopGenerate });
    expect(node.contract?.producedArtifactKeys).toEqual(['review.latest']);
    // design §3：加 chapter_brief（喂 gap 白名单 intent）。链流程重排 W1d：story.sync 移出 required
    //（story-sync 后移提取段 E9——hard required 会让每章在审读位 blocked，W0-3 断链级适配）。
    expect(node.contract?.requiredArtifactKeys).toEqual([
      'draft.initial',
      'scene_graph',
      'chapter_brief',
    ]);
  });

  it('route contract: reads review.latest+chapter_brief+draft.initial → owns route_decision', () => {
    const node = createRouteNode({ generate: noopGenerate });
    expect(node.contract?.nodeId).toBe('route-agent');
    expect(node.contract?.producedArtifactKeys).toEqual(['route_decision']);
    expect(node.contract?.requiredArtifactKeys).toEqual(['review.latest', 'chapter_brief', 'draft.initial']);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// 链流程重排 W2（R3 终稿手改通道）：applyEditedDraft / recountDraftWordCount 单源单测
// ════════════════════════════════════════════════════════════════════════════

describe('W2 applyEditedDraft — editedDraft 覆写单源（终稿手改）', () => {
  it('覆写 draft.initial.text + wordCount 机械重算 + 剥段落级 passageText；title 保留', () => {
    const artifacts = {
      'draft.initial': { title: '章题', text: '原稿正文', wordCount: 4, passageText: '改后段' },
    };
    const next = applyEditedDraft(artifacts, '手 改 后 的 终稿正文');
    expect(next['draft.initial']).toMatchObject({
      title: '章题',
      text: '手 改 后 的 终稿正文',
    });
    // wordCount = 非空白字符数（空白剔除）
    expect((next['draft.initial'] as { wordCount?: number }).wordCount).toBe(recountDraftWordCount('手 改 后 的 终稿正文'));
    expect((next['draft.initial'] as { passageText?: unknown }).passageText).toBeUndefined();
    // 原 artifacts 不被 mutate（纯函数）
    expect((artifacts['draft.initial'] as { text: string }).text).toBe('原稿正文');
  });

  it('申报类 stale 清理：cast_declaration 删除 + research_brief.suspended 剥离（mirror stale 清理不变式）', () => {
    const artifacts = {
      'draft.initial': { title: 't', text: '原稿' },
      cast_declaration: { declaration: { appearances: [{ assetRef: 'char-1' }] } },
      research_brief: { briefHash: 'h', suspended: { kind: 'research_contradiction', rounds: 1 } },
    };
    const next = applyEditedDraft(artifacts, '改后');
    expect(Object.prototype.hasOwnProperty.call(next, 'cast_declaration')).toBe(false);
    expect((next['research_brief'] as { suspended?: unknown }).suspended).toBeUndefined();
    expect((next['research_brief'] as { briefHash?: string }).briefHash).toBe('h');
  });

  it('draft.initial 缺（防御）→ 不覆写正文，申报清理照常', () => {
    const next = applyEditedDraft({ cast_declaration: { declaration: {} } }, '改后');
    expect(Object.prototype.hasOwnProperty.call(next, 'draft.initial')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(next, 'cast_declaration')).toBe(false);
  });
});

describe('W2 recountDraftWordCount — wordCount 机械重算（CJK 非空白口径）', () => {
  it('空白剔除计数', () => {
    expect(recountDraftWordCount('黄昏的荒野上，主角深吸一口气。')).toBe(15); // 含标点（非空白字符口径）
    expect(recountDraftWordCount('a b\tc\nd')).toBe(4);
    expect(recountDraftWordCount('')).toBe(0);
  });
});
