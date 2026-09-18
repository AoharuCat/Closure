import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResearchBrief } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子2 W3（design §2）：节点产出快照（chain-node-artifact）测试。
//
// 覆盖：
// 1. 发射形态表覆盖守门——CHAPTER_CHAIN_NODE_IDS 23 节点全在表内（逐 id 包装后发光栅）；
//    withNodeArtifact 缺省 emit / 表外 id → identity 返回（零回归）。
// 2. 逐 kind 载荷断言（经 withNodeArtifact 公共路径直投 fixture artifact）——brief-card /
//    findings（quote 截断 200 + severity 透传 + rows 封顶）/ items（封顶 50 + total 保全量）/
//    route-decision / line（纯代码节点逐节点机械行）；error·blocked·快照缺失通用行；
//    节点 throw（非 abort）→ error 行后原样 rethrow；AbortError → 零发射。
// 3. runChapterChain e2e——artifact 事件先于同节点 node-done（AC2 顺序断言）+ 23 节点全覆盖
//    + seq 快照不消耗（与 delta 同 seq；纯代码位 -1）+ 环重跑多圈发射（同 run 同 seq）+
//    跨 run（redo）seq+1 + blocked 通用行先于 node-done('blocked')。
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
// 投影 helper：经 withNodeArtifact 公共包装直投 fixture artifact
// ════════════════════════════════════════════════════════════════════════════

async function projectFixture(
  nodeId: string,
  stateKey: string,
  artifact: unknown,
  runArtifacts: Record<string, unknown> = {},
): Promise<{ summary: import('../src/types').ChainNodeArtifactSummary; result: { stateKey: string; artifact: unknown } }> {
  const { withNodeArtifact } = await import('../src/nodes/chain-node-artifact');
  const emitted: Array<{ nodeId: string; role: string; summary: import('../src/types').ChainNodeArtifactSummary }> = [];
  const def = withNodeArtifact(
    {
      id: nodeId,
      node: {
        contract: null,
        async run() {
          return { stateKey, artifact };
        },
      },
    },
    (d) => emitted.push(d),
  );
  const result = await def.node.run({ run: { artifacts: runArtifacts } as never, requirement: '' });
  expect(emitted.length).toBe(1);
  return { summary: emitted[0]!.summary, result };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 发射形态表覆盖守门
// ════════════════════════════════════════════════════════════════════════════

describe('发射形态表覆盖（design §2 18 行 → 23 节点）', () => {
  it('CHAPTER_CHAIN_NODE_IDS 23 节点全在表内（逐 id 包装后发光栅）+ role 与 withNodeStreaming 接线一致', async () => {
    const { CHAPTER_CHAIN_NODE_IDS } = await import('../src/nodes/chapter-chain');
    const { withNodeArtifact, chainNodeArtifactRoleOf } = await import('../src/nodes/chain-node-artifact');
    for (const nodeId of CHAPTER_CHAIN_NODE_IDS) {
      const emitted: Array<{ nodeId: string; role: string }> = [];
      const def = withNodeArtifact(
        {
          id: nodeId,
          node: { contract: null, async run() { return { stateKey: nodeId, artifact: { ok: true } }; } },
        },
        (d) => emitted.push(d),
      );
      await def.node.run({ run: { artifacts: {} } as never, requirement: '' });
      expect(emitted.length, `节点 ${nodeId} 应发射一份产出快照`).toBe(1);
      expect(emitted[0]!.nodeId).toBe(nodeId);
      // role 单源解析（blocked 通用行消费面）与包装发射一致。
      expect(emitted[0]!.role).toBe(chainNodeArtifactRoleOf(nodeId));
    }
    // 表外 id（mock 链 / 未来节点）→ role 兜底 nodeId 本身。
    expect(chainNodeArtifactRoleOf('unknown-future-node')).toBe('unknown-future-node');
  });

  it('withNodeArtifact 缺省 emit → 原 def 引用返回（identity 零回归）；表外 id → 原样不发光栅', async () => {
    const { withNodeArtifact } = await import('../src/nodes/chain-node-artifact');
    const def = {
      id: 'route-agent',
      node: { contract: null, async run() { return { stateKey: 'route_decision', artifact: {} }; } },
    };
    expect(withNodeArtifact(def, undefined)).toBe(def);
    const offTable = {
      id: 'mock-node-x',
      node: { contract: null, async run() { return { stateKey: 'x', artifact: {} }; } },
    };
    const emitted: unknown[] = [];
    const wrapped = withNodeArtifact(offTable, () => emitted.push(1));
    await wrapped.node.run({ run: { artifacts: {} } as never, requirement: '' });
    expect(emitted.length).toBe(0); // 表外 id 不误配——防 mock 链 / 未来节点误发光栅
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. 逐 kind 载荷断言
// ════════════════════════════════════════════════════════════════════════════

describe('五 kind 载荷断言', () => {
  it('brief-compiler → brief-card：chapter_brief artifact 整体', async () => {
    const brief = { goal: '抵达 B 城', tone: '紧张', plotPoints: [{ sceneId: 's1' }] };
    const { summary } = await projectFixture('brief-compiler-node', 'chapter_brief', brief);
    expect(summary).toEqual({ kind: 'brief-card', brief });
  });

  it('CR-1：brief-card 尺寸守卫——JSON.stringify 超 8K 降级 line「任务卡过大」（唯一整对象 kind 收编量控）', async () => {
    const bigBrief = { goal: 'g'.repeat(9000) };
    const { summary } = await projectFixture('brief-compiler-node', 'chapter_brief', bigBrief);
    const size = JSON.stringify(bigBrief).length;
    expect(size).toBeGreaterThan(8192);
    expect(summary).toEqual({ kind: 'line', line: `任务卡过大（${size} 字符）已省略展示` });
    // 边界内不降级（brief-card 原形态）。
    const okBrief = { goal: '抵达 B 城' };
    const { summary: ok } = await projectFixture('brief-compiler-node', 'chapter_brief', okBrief);
    expect(ok).toEqual({ kind: 'brief-card', brief: okBrief });
  });

  it('brief-reviewer → findings：verdict/severity 透传 + grounding/note 截断 200', async () => {
    const longGrounding = 'g'.repeat(250);
    const planReview = {
      verdict: 'pass',
      summary: '卡面成立',
      findings: [
        { dimension: 'drama-quality', severity: 'soft', grounding: longGrounding, note: '节奏偏缓' },
        { dimension: 'red-line', severity: 'hard', grounding: 'chapterBrief.doNotWrite', note: '禁写项冲突' },
      ],
    };
    const { summary } = await projectFixture('brief-reviewer-node', 'plan_review', planReview);
    expect(summary.kind).toBe('findings');
    if (summary.kind !== 'findings') return;
    expect(summary.verdict).toBe('pass');
    expect(summary.summary).toBe('卡面成立');
    expect(summary.total).toBe(2);
    expect(summary.findings).toEqual([
      { label: 'drama-quality', severity: 'soft', quote: `${'g'.repeat(200)}…`, note: '节奏偏缓' },
      { label: 'red-line', severity: 'hard', quote: 'chapterBrief.doNotWrite', note: '禁写项冲突' },
    ]);
    expect(summary.findings[0]!.quote.length).toBe(201);
  });

  it('CR-1：findings kind 全字段截断——summary/label/verdict 截断 200（此前 quote/note 截了 summary 漏）', async () => {
    const planReview = {
      verdict: 'pass',
      summary: 's'.repeat(250),
      findings: [{ dimension: 'd'.repeat(250), severity: 'soft', grounding: 'g', note: 'n' }],
    };
    const { summary } = await projectFixture('brief-reviewer-node', 'plan_review', planReview);
    expect(summary.kind).toBe('findings');
    if (summary.kind !== 'findings') return;
    expect(summary.summary).toBe(`${'s'.repeat(200)}…`);
    expect(summary.findings[0]!.label).toBe(`${'d'.repeat(200)}…`);
    // multi-review / completeness 同族 findings summary 截断（三 projector 统一）。
    const review = {
      verdict: 'revise',
      summary: 'm'.repeat(250),
      dimensions: [{ name: 'consistency', findings: [] }],
      reasons: [],
    };
    const { summary: multi } = await projectFixture('multi-review-agent', 'review.latest', review);
    if (multi.kind !== 'findings') return;
    expect(multi.summary).toBe(`${'m'.repeat(200)}…`);
    const { summary: comp } = await projectFixture('completeness-verify-node', 'completeness_verify_result', {
      findings: [{ entityId: 'e'.repeat(250), verdict: 'missing', quote: 'q', explanation: 'x' }],
      summary: 'c'.repeat(250),
    });
    if (comp.kind !== 'findings') return;
    expect(comp.summary).toBe(`${'c'.repeat(200)}…`);
    expect(comp.findings[0]!.label).toBe(`${'e'.repeat(200)}…`);
  });

  it('multi-review → findings：dim/subClass 拼接 label + severity/quote 透传截断', async () => {
    const review = {
      verdict: 'revise',
      summary: '开篇意象重复',
      dimensions: [
        {
          name: 'consistency',
          findings: [
            { severity: 'block', subClass: 'Characterization.memory', quote: '黄昏的荒野', location: '句1', explanation: '开篇意象重复' },
            { severity: 'info', quote: '风更紧了', location: '句2', explanation: '观察' },
          ],
        },
      ],
      reasons: [],
    };
    const { summary } = await projectFixture('multi-review-agent', 'review.latest', review);
    expect(summary).toEqual({
      kind: 'findings',
      verdict: 'revise',
      summary: '开篇意象重复',
      findings: [
        { label: 'consistency/Characterization.memory', severity: 'block', quote: '黄昏的荒野', note: '开篇意象重复' },
        { label: 'consistency', severity: 'info', quote: '风更紧了', note: '观察' },
      ],
      total: 2,
    });
  });

  it('multi-review findings 超 50 条 → rows 封顶 50 + total 保全量', async () => {
    const findings = Array.from({ length: 60 }, (_, i) => ({
      severity: 'warn',
      quote: `q${i}`,
      location: `l${i}`,
      explanation: `e${i}`,
    }));
    const review = {
      verdict: 'revise',
      summary: 'many',
      dimensions: [{ name: 'consistency', findings }],
      reasons: [],
    };
    const { summary } = await projectFixture('multi-review-agent', 'review.latest', review);
    expect(summary.kind).toBe('findings');
    if (summary.kind !== 'findings') return;
    expect(summary.findings.length).toBe(50);
    expect(summary.total).toBe(60);
  });

  it('completeness → findings：无 verdict 字段不造（degraded 时 verdict=degraded）', async () => {
    const okResult = {
      findings: [
        { category: 'line', verdict: 'missing', entityId: 'line-main', entityLabel: '主线', quote: '正文原句', location: '段2', explanation: '该推进的没推进', suggestedFix: '补一段' },
      ],
      summary: '1 条缺漏',
      degraded: false,
    };
    const { summary: ok } = await projectFixture('completeness-verify-node', 'completeness_verify_result', okResult);
    expect(ok).toEqual({
      kind: 'findings',
      summary: '1 条缺漏',
      findings: [{ label: '主线', severity: 'missing', quote: '正文原句', note: '该推进的没推进' }],
      total: 1,
    });
    const { summary: degraded } = await projectFixture('completeness-verify-node', 'completeness_verify_result', {
      findings: [],
      summary: '解析失败',
      degraded: true,
    });
    expect(degraded).toEqual({ kind: 'findings', verdict: 'degraded', summary: '解析失败', findings: [], total: 0 });
  });

  it('route-agent → route-decision：decision + reason（截断）', async () => {
    const { summary } = await projectFixture('route-agent', 'route_decision', {
      decision: 'accept_as_truth',
      reason: 'r'.repeat(250),
    });
    expect(summary).toEqual({ kind: 'route-decision', decision: 'accept_as_truth', reason: `${'r'.repeat(200)}…` });
  });

  it('CR-1：route-decision decision 字段截断（词表值恒短，链外/mock 形态无界——统一守卫）', async () => {
    const { summary } = await projectFixture('route-agent', 'route_decision', {
      decision: 'd'.repeat(250),
      reason: 'r',
    });
    expect(summary).toEqual({ kind: 'route-decision', decision: `${'d'.repeat(200)}…`, reason: 'r' });
  });

  it('world-extractor → items：patch 条目 + 封顶 50 + total 保全量', async () => {
    const patches = Array.from({ length: 60 }, (_, i) => ({
      subjectId: `char:lin-${i}`,
      path: '/位置',
      op: 'replace',
      value: 'B 城',
      summary: `状态变化 ${i}`,
    }));
    const extraction = { storyTime: 5, title: '状态切面', subjects: [{ id: 'char:lin', type: 'char' }], patches };
    const { summary } = await projectFixture('world-extractor-physical', 'world_events.physical', extraction);
    expect(summary.kind).toBe('items');
    if (summary.kind !== 'items') return;
    expect(summary.total).toBe(60);
    expect(summary.items.length).toBe(50);
    expect(summary.label).toBe('physical 轴提取：60 条状态变化 · 1 主体');
    expect(summary.items[0]).toBe('char:lin-0 /位置 replace——状态变化 0');
  });

  it('promise-emergence → items（登记动作，节点侧 actions 补字段源）；无 actions → line 降级', async () => {
    const withActions = {
      gapsDetected: 2,
      actionsProduced: 2,
      applied: true,
      actions: [
        { type: 'add_promise', promise: { id: 'p1', title: '密信的下落' } },
        { type: 'add_beat', beatId: 'b9' },
      ],
    };
    const { summary } = await projectFixture('promise-emergence-node', 'promise_emergence', withActions);
    expect(summary).toEqual({
      kind: 'items',
      label: 'Promise 涌现登记：2 项（已落盘）',
      items: ['add_promise · 密信的下落', 'add_beat · b9'],
      total: 2,
    });
    const { summary: skipped } = await projectFixture('promise-emergence-node', 'promise_emergence', {
      gapsDetected: 3,
      actionsProduced: 0,
      skipped: 'LLM produced no valid Promise actions',
    });
    expect(skipped).toEqual({
      kind: 'line',
      line: 'Promise 涌现：gap 3 · 无登记动作（LLM produced no valid Promise actions）',
    });
  });

  it('CR-4：artifact 侧 actions 已封顶 → total 读 actionsProduced 全量（截断可观测 N/total）', async () => {
    // CR-4 后节点侧 artifact.actions slice(0, 50)——投影 total 不得随截断缩水。
    const capped = {
      gapsDetected: 60,
      actionsProduced: 60,
      actions: Array.from({ length: 60 }, (_, i) => ({ type: 'add_beat', beatId: `b${i}` })),
    };
    const { summary } = await projectFixture('promise-emergence-node', 'promise_emergence', capped);
    expect(summary.kind).toBe('items');
    if (summary.kind !== 'items') return;
    expect(summary.items.length).toBe(50);
    expect(summary.items[0]).toBe('add_beat · b0');
    expect(summary.items[49]).toBe('add_beat · b49');
    expect(summary.total).toBe(60);
    expect(summary.label).toBe('Promise 涌现登记：60 项');
  });

  it('draft-writer → line：整章交付 / 段落级 / 挂起三形态', async () => {
    const { summary: whole } = await projectFixture('draft-writer-agent', 'draft.initial', VALID_DRAFT);
    expect(whole).toEqual({ kind: 'line', line: '整章交付《第二章 B 城》：2800 字' });
    // CR-1：title 插值截断（超长章名不进事件载荷）。
    const { summary: longTitle } = await projectFixture('draft-writer-agent', 'draft.initial', {
      ...VALID_DRAFT,
      title: 't'.repeat(300),
    });
    expect(longTitle).toEqual({ kind: 'line', line: `整章交付《${'t'.repeat(200)}…》：2800 字` });
    // wordCount 缺 → 机械重算（recountDraftWordCount 同源：非空白字符数）。
    const { summary: recounted } = await projectFixture('draft-writer-agent', 'draft.initial', {
      title: '无计数',
      text: '黄昏的 荒野上',
    });
    expect(recounted).toEqual({ kind: 'line', line: '整章交付《无计数》：6 字' });
    const { summary: passage } = await projectFixture('draft-writer-agent', 'draft.initial', {
      ...VALID_DRAFT,
      passageText: '黄昏的荒野上，风更紧了。',
    });
    expect(passage).toEqual({ kind: 'line', line: '段落级修订产出：12 字（待保义护栏 splice）' });
    const { summary: suspended } = await projectFixture('draft-writer-agent', 'research_brief', {
      brief: {},
      suspended: { kind: 'verify_exhausted', rounds: 4 },
    });
    expect(suspended).toEqual({ kind: 'line', line: '出发核查挂起：verify_exhausted（4 回合）' });
  });

  it('revision-optimizer → line：no-op / anchored / anchorless / failed 四形态', async () => {
    const { summary: noOp } = await projectFixture('revision-optimizer-node', 'revision_intent', {
      optimizerNoOp: true,
      nodeId: 'revision-optimizer-node',
      reason: 'no-review-latest',
    });
    expect(noOp).toEqual({ kind: 'line', line: '直通（no-review-latest）' });
    const { summary: anchored } = await projectFixture('revision-optimizer-node', 'revision_intent', {
      change: { summary: '补写城门对峙的起手铺垫' },
      lockedItems: [],
      rationale: { source: 'audit-finding', note: '环内 C1 编译' },
      provenance: { rawUserInstruction: 'auto_revise', compilerNote: '编译' },
      scope: { anchor: { quote: '黄昏的荒野上', prefix: '', suffix: '', rangeHint: { from: 0, to: 6 } } },
    });
    expect(anchored).toEqual({ kind: 'line', line: '选区改稿意图：补写城门对峙的起手铺垫' });
    const { summary: anchorless } = await projectFixture('revision-optimizer-node', 'revision_intent', {
      change: { summary: '整章收紧节奏' },
      lockedItems: [],
      rationale: { source: 'audit-finding', note: '环内 C1 编译' },
      provenance: { rawUserInstruction: 'auto_revise', compilerNote: '编译〔机械附注〕引文未定位' },
    });
    expect(anchorless).toEqual({ kind: 'line', line: '整章改稿意图：整章收紧节奏（引文不可定位降级）' });
    const { summary: failed } = await projectFixture('revision-optimizer-node', 'optimizer_failed', {
      optimizer_failed: true,
      nodeId: 'revision-optimizer-node',
      message: 'LLM node failed after 3 attempts',
    });
    expect(failed).toEqual({ kind: 'line', line: '意图编译失败：LLM node failed after 3 attempts' });
  });

  it('revision-guard → line：clean 跳过（mutate 读 run）/ clean splice / soft-violation（result 本体）', async () => {
    // clean-splice 路径：stateKey='draft.initial'，guard 报告 mutate 进 run.artifacts（投影读得到）。
    const { summary: spliced } = await projectFixture(
      'revision-guard-agent',
      'draft.initial',
      { ...VALID_DRAFT, passageText: undefined },
      {
        revision_guard: { verdict: 'clean', findings: [], summary: '保义通过', beforeText: 'a', afterText: 'b' },
      },
    );
    expect(spliced).toEqual({ kind: 'line', line: '保义护栏：clean · 发现 0 条——保义通过' });
    // 整章路径 skip（mutate 写 skipped 标记）。
    const { summary: skipped } = await projectFixture(
      'revision-guard-agent',
      'draft.initial',
      VALID_DRAFT,
      { revision_guard: { verdict: 'clean', findings: [], summary: '整章路径（无段落级 revision_intent），护栏跳过', skipped: true } },
    );
    expect(skipped).toEqual({ kind: 'line', line: '保义护栏：clean（整章路径跳过） · 发现 0 条——整章路径（无段落级 revision_intent），护栏跳过' });
    // soft-violation：result 本体即 guard 报告。
    const { summary: soft } = await projectFixture('revision-guard-agent', 'revision_guard', {
      verdict: 'soft-violation',
      findings: [{ pattern: '语气删除', violatedScope: 'voice', authority: 'hard', evidence: { before: 'a', after: 'b' } }],
      summary: '软锁越界，等作者 art-mode 决定',
    });
    expect(soft).toEqual({ kind: 'line', line: '保义护栏：soft-violation · 发现 1 条——软锁越界，等作者 art-mode 决定' });
  });

  it('lint-node → line：命中计数 + top 项 / 0 命中 / degraded', async () => {
    const report = {
      chapterId: 'ep1',
      summary: { total: 3, high: 1, medium: 1, low: 1, visibleChars: 2800 },
      issues: [
        { level: 'high', title: '排比堆叠', match: '不是……而是……', detail: '三连排比' },
        { level: 'medium', title: '总结腔', match: '总的来说', detail: '' },
      ],
      densityIssues: [],
    };
    const { summary } = await projectFixture('lint-node', 'lint_report', report);
    expect(summary).toEqual({ kind: 'line', line: '去味扫描：3 命中（high 1 / medium 1 / low 1） · 首项：[high] 排比堆叠' });
    const { summary: clean } = await projectFixture('lint-node', 'lint_report', {
      ...report,
      summary: { total: 0, high: 0, medium: 0, low: 0, visibleChars: 2800 },
    });
    expect(clean).toEqual({ kind: 'line', line: '去味扫描：0 命中' });
    const { summary: degraded } = await projectFixture('lint-node', 'lint_report', {
      ...report,
      degraded: true,
    });
    expect(degraded).toEqual({ kind: 'line', line: '去味扫描：引擎缺位降级（本章无静态扫描）' });
  });

  it('纯代码提取段节点 → line 逐节点机械行（world-merge / emotion-verify / arc-emergence / chapter-summary / storytime-drift / mention-ledger / story-sync / feedback-ledger）', async () => {
    const { summary: merge } = await projectFixture('world-merge-node', 'world_state.events', {
      writes: [{ sliceId: 'ep1:5', storyTime: 5, title: '切面', patchCount: 4, subjectCount: 2 }],
      totalPatches: 4,
      totalSubjects: 2,
      writeErrors: [],
    });
    expect(merge).toEqual({ kind: 'line', line: '世界状态落表：1 片 · 4 条 patch · 2 主体' });

    const { summary: mergeErr } = await projectFixture('world-merge-node', 'world_state.events', {
      writes: [],
      totalPatches: 0,
      totalSubjects: 0,
      writeErrors: [{ sliceId: 'ep1:5', error: 'db locked' }],
    });
    expect(mergeErr).toEqual({ kind: 'line', line: '世界状态落表：0 片 · 0 条 patch · 0 主体 · 1 片写失败' });

    const { summary: emotion } = await projectFixture('emotion-verify-node', 'emotion_verify_result', {
      flags: ['character_setpoint_violation'],
      characterArcs: [],
      readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0 },
      adjustedSetpoints: [],
      chapterDtwDistance: 1.5,
      degraded: false,
    });
    expect(emotion).toEqual({ kind: 'line', line: '情绪轨迹校验：character_setpoint_violation · DTW 1.5' });
    // CR-1：flags join 封顶 50（超限计数注明）+ DTW 有限数守卫（NaN/Infinity 不渲染）。
    const manyFlags = Array.from({ length: 55 }, (_, i) => `flag_${i}`);
    const { summary: emotionCapped } = await projectFixture('emotion-verify-node', 'emotion_verify_result', {
      flags: manyFlags,
      characterArcs: [],
      readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0 },
      adjustedSetpoints: [],
      chapterDtwDistance: 1.5,
      degraded: false,
    });
    expect(emotionCapped).toEqual({
      kind: 'line',
      line: `情绪轨迹校验：${Array.from({ length: 50 }, (_, i) => `flag_${i}`).join('、')}……等 55 项 · DTW 1.5`,
    });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { summary: emotionBadDtw } = await projectFixture('emotion-verify-node', 'emotion_verify_result', {
        flags: [],
        characterArcs: [],
        readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0 },
        adjustedSetpoints: [],
        chapterDtwDistance: bad,
        degraded: false,
      });
      expect(emotionBadDtw).toEqual({ kind: 'line', line: '情绪轨迹校验：无违规标记' });
    }
    const { summary: emotionDegraded } = await projectFixture('emotion-verify-node', 'emotion_verify_result', {
      flags: [],
      characterArcs: [],
      readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: true },
      adjustedSetpoints: [],
      degraded: true,
      degradationNote: 'emotion_curve 缺失或 points 为空',
    });
    expect(emotionDegraded).toEqual({ kind: 'line', line: '情绪轨迹校验：降级（emotion_curve 缺失或 points 为空）' });

    const { summary: arc } = await projectFixture('arc-emergence-node', 'arc_emergence', {
      beats: [{ id: 'b1' }],
      lineCandidates: 2,
      volumeCandidates: 1,
      growthCandidates: 3,
      beatsProduced: 1,
      applied: true,
    });
    expect(arc).toEqual({ kind: 'line', line: '弧节拍声明：1 条（候选 线 2 / 卷 1 / 成长 3）' });
    const { summary: arcSkip } = await projectFixture('arc-emergence-node', 'arc_emergence', {
      beats: [],
      lineCandidates: 0,
      volumeCandidates: 0,
      growthCandidates: 0,
      beatsProduced: 0,
      skipped: 'no arc candidates',
    });
    expect(arcSkip).toEqual({ kind: 'line', line: '弧节拍：0 条（no arc candidates）' });

    const { summary: summaryOk } = await projectFixture('chapter-summary-node', 'chapter_summary_result', {
      runId: 'r',
      episodeId: 'ep1',
      ok: true,
      tokenEstimate: 1200,
      truncated: true,
      summary: 'materialized ep1',
    });
    // CR-10：ok 路径补摘要首行（design §2 表「摘要首行」——只发 tokens 行丢「本章摘要写了什么」）。
    expect(summaryOk).toEqual({ kind: 'line', line: '章摘要已物化：~1200 tokens（截断）——materialized ep1' });
    const { summary: summaryFirstLine } = await projectFixture('chapter-summary-node', 'chapter_summary_result', {
      runId: 'r',
      episodeId: 'ep1',
      ok: true,
      tokenEstimate: 900,
      summary: '\n  第一行摘要  \n第二行不该出现',
    });
    // 首个非空行 + trim + 截断 200；summary 缺 → 只有 tokens 行（零造数据）。
    expect(summaryFirstLine).toEqual({ kind: 'line', line: '章摘要已物化：~900 tokens——第一行摘要' });
    const { summary: summaryNoText } = await projectFixture('chapter-summary-node', 'chapter_summary_result', {
      runId: 'r',
      episodeId: 'ep1',
      ok: true,
      tokenEstimate: 900,
    });
    expect(summaryNoText).toEqual({ kind: 'line', line: '章摘要已物化：~900 tokens' });
    const { summary: summaryDegrade } = await projectFixture('chapter-summary-node', 'chapter_summary_result', {
      runId: 'r',
      episodeId: 'ep1',
      ok: false,
      reason: 'tool_not_registered',
      summary: 'skip: tool not registered',
    });
    expect(summaryDegrade).toEqual({ kind: 'line', line: '章摘要降级：tool_not_registered' });

    const { summary: driftWarn } = await projectFixture('storytime-drift-node', 'storytime_drift', {
      runId: 'r',
      episodeId: 'ep1',
      checked: true,
      warnings: [{ sliceId: 'ep1:9' }],
      summary: 'drift: 1',
    });
    expect(driftWarn).toEqual({ kind: 'line', line: 'storyTime 漂移：1 条 slice 落在本章场窗外' });
    const { summary: driftSkip } = await projectFixture('storytime-drift-node', 'storytime_drift', {
      runId: 'r',
      episodeId: null,
      checked: false,
      skipped: 'no_episodeId',
      warnings: [],
      summary: 'skip',
    });
    expect(driftSkip).toEqual({ kind: 'line', line: 'storyTime 漂移守卫：跳过（no_episodeId）' });

    const { summary: mention } = await projectFixture('mention-ledger-node', 'mention_signals', {
      runId: 'r',
      episodeId: 'ep1',
      ok: true,
      rowCount: 7,
      signals: [{ name: '林昭' }],
      summary: 'ok',
    });
    expect(mention).toEqual({ kind: 'line', line: 'mention 台账：7 行 · 1 条共现信号' });
    const { summary: mentionSkip } = await projectFixture('mention-ledger-node', 'mention_signals', {
      runId: 'r',
      episodeId: 'ep1',
      ok: false,
      reason: 'tool_not_registered',
      signals: [],
      summary: 'skip',
    });
    expect(mentionSkip).toEqual({ kind: 'line', line: 'mention 台账：跳过（tool_not_registered）' });

    const { summary: sync } = await projectFixture('story-sync-agent', 'story.sync', {
      runId: 'r',
      chapterId: 'ep1',
      summary: '主角状态更新',
      patches: [{ field: 'asset_cards' }, { field: 'scene_graph' }],
    });
    expect(sync).toEqual({ kind: 'line', line: 'story-sync：2 条设定补丁——主角状态更新' });

    const { summary: feedback } = await projectFixture('feedback-ledger-node', 'feedback_ledger', {
      runId: 'r',
      episodeId: 'ep1',
      written: ['review.latest', 'emotion_verify_result'],
      summary: '2/3 artifacts persisted',
    });
    expect(feedback).toEqual({ kind: 'line', line: '反馈台账：2/3 项已写（review.latest、emotion_verify_result）' });
    const { summary: feedbackEmpty } = await projectFixture('feedback-ledger-node', 'feedback_ledger', {
      runId: 'r',
      episodeId: null,
      written: [],
      summary: 'skip: no episodeId',
    });
    expect(feedbackEmpty).toEqual({ kind: 'line', line: '反馈台账：未写入（skip: no episodeId）' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2b. 通用终态行 + 投影守卫
// ════════════════════════════════════════════════════════════════════════════

describe('error / blocked / 快照缺失通用行（M4 + 投影守卫）', () => {
  it('error artifact（{error:true}）→ 前置守卫先于产物投影 → 通用 error 行（message 截断）', async () => {
    const { summary } = await projectFixture('route-agent', 'route_decision', {
      error: true,
      nodeId: 'route-agent',
      message: 'm'.repeat(250),
    });
    expect(summary).toEqual({ kind: 'line', line: `节点失败：${'m'.repeat(200)}…` });
  });

  it('节点 throw（非 abort）→ error 行后原样 rethrow（chainRunner 合成路径先见快照）', async () => {
    const { withNodeArtifact } = await import('../src/nodes/chain-node-artifact');
    const emitted: Array<{ nodeId: string; summary: unknown }> = [];
    const boom = new Error('generate exploded');
    const def = withNodeArtifact(
      {
        id: 'multi-review-agent',
        node: {
          contract: null,
          async run() {
            throw boom;
          },
        },
      },
      (d) => emitted.push(d),
    );
    await expect(def.node.run({ run: { artifacts: {} } as never, requirement: '' })).rejects.toThrow('generate exploded');
    expect(emitted).toEqual([
      { nodeId: 'multi-review-agent', role: 'multi-review-agent', summary: { kind: 'line', line: '节点失败：generate exploded' } },
    ] as never);
  });

  it('AbortError → 零发射（取消非失败——run 级哨兵 aborted 帧归 workflow）', async () => {
    const { withNodeArtifact } = await import('../src/nodes/chain-node-artifact');
    const emitted: unknown[] = [];
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const def = withNodeArtifact(
      {
        id: 'multi-review-agent',
        node: {
          contract: null,
          async run() {
            throw abortErr;
          },
        },
      },
      (d) => emitted.push(d),
    );
    await expect(def.node.run({ run: { artifacts: {} } as never, requirement: '' })).rejects.toThrow('aborted');
    expect(emitted.length).toBe(0);
  });

  it('artifact 形态不敷投影（非 record / 缺关键字段）→ line『（快照缺失）』不造数据', async () => {
    const { summary: nonRecord } = await projectFixture('brief-compiler-node', 'chapter_brief', 'raw string');
    expect(nonRecord).toEqual({ kind: 'line', line: '（快照缺失）' });
    const { summary: noDecision } = await projectFixture('route-agent', 'route_decision', { reason: '无 decision' });
    expect(noDecision).toEqual({ kind: 'line', line: '（快照缺失）' });
  });

  it('blockedChainNodeArtifactLine：受阻标记 + message 截断（chainRunner blocked 分支消费）', async () => {
    const { blockedChainNodeArtifactLine } = await import('../src/nodes/chain-node-artifact');
    expect(blockedChainNodeArtifactLine('node "x" blocked: missing required artifacts [a, b]')).toEqual({
      kind: 'line',
      line: '节点受阻：node "x" blocked: missing required artifacts [a, b]',
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2c. CR 批 CR-3：through verdict 强制覆写后的快照重发（emitChainNodeArtifactFor + runChain 覆写分支）
// ════════════════════════════════════════════════════════════════════════════

describe('CR-3 emitChainNodeArtifactFor（覆写重发 helper）', () => {
  it('按发射形态表投影覆写后 artifact（route 词表 → route-decision 帧）；emit 缺省 / 表外 id no-op；emit throw 静默', async () => {
    const { emitChainNodeArtifactFor } = await import('../src/nodes/chain-node-artifact');
    const emitted: Array<{ nodeId: string; role: string; summary: unknown }> = [];
    const run = { artifacts: {} } as never;
    emitChainNodeArtifactFor(
      'route-agent',
      run,
      { stateKey: 'route_decision', artifact: { decision: 'escalate_user', reason: 'loop cap (3) reached; escalating to user' } },
      (d) => emitted.push(d),
    );
    expect(emitted).toEqual([
      {
        nodeId: 'route-agent',
        role: 'route-agent',
        summary: { kind: 'route-decision', decision: 'escalate_user', reason: 'loop cap (3) reached; escalating to user' },
      },
    ]);
    // emit 缺省 / 表外 id（mock 链 / 未来节点）→ no-op 零抛。
    emitChainNodeArtifactFor('route-agent', run, { stateKey: 'route_decision', artifact: {} }, undefined);
    emitChainNodeArtifactFor('mock-node-x', run, { stateKey: 'x', artifact: {} }, (d) => emitted.push(d));
    expect(emitted).toHaveLength(1);
    // emit throw → 静默不抛（可观测性绝不破链——发射失败归 logger.debug 留痕）。
    expect(() =>
      emitChainNodeArtifactFor(
        'route-agent',
        run,
        { stateKey: 'route_decision', artifact: { decision: 'accept_as_truth', reason: 'r' } },
        () => {
          throw new Error('IPC channel dead');
        },
      ),
    ).not.toThrow();
  });
});

/** CR-3 runChain 直构 helper：mock 链 + 最小 deps（through 节点契约显式 producedArtifactKeys 对齐 stateKey）。 */
async function runMockChain(args: {
  chain: import('../src/contracts/run').ChainNodeDef[];
  initialArtifacts?: Record<string, unknown>;
  loops?: import('../src/contracts/run').ChainLoopConfig[];
  onVerdictOverwritten?: (
    nodeId: string,
    run: import('../src/contracts/run').RunSnapshot,
    result: { stateKey: string; artifact: unknown },
  ) => void;
}): Promise<import('../src/contracts/run').RunSnapshot> {
  const { runChain } = await import('../src/runtime/chainRunner');
  return runChain(
    {
      chain: args.chain,
      initialArtifacts: args.initialArtifacts ?? {},
      requirement: 'test',
      ...(args.loops ? { loops: args.loops } : {}),
      ...(args.onVerdictOverwritten ? { onVerdictOverwritten: args.onVerdictOverwritten } : {}),
    },
    {
      generate: (async () => ({ content: '{}', finishReason: 'stop' })) as never,
      sessionContext: { id: 'sess-mock', agentName: 'x', projectPath: '/test', status: 'idle' } as never,
      signal: new AbortController().signal,
    },
  );
}

function stubDef(
  id: string,
  run: () => Promise<{ stateKey: string; artifact: unknown }>,
  producedArtifactKeys: string[],
): import('../src/contracts/run').ChainNodeDef {
  return {
    id,
    node: {
      contract: { nodeId: id, requiredArtifactKeys: [], producedArtifactKeys } as never,
      run: run as never,
    },
  };
}

describe('CR-3 runChain 覆写分支——onVerdictOverwritten 携覆写后产物重发', () => {
  it('环 cap 超限（route 词表，cap 0 直触发）：覆写 escalate_user 后重发（时间线末帧防 stale）', async () => {
    const calls: Array<{ nodeId: string; stateKey: string; artifact: unknown }> = [];
    const snap = await runMockChain({
      chain: [
        stubDef('revision-optimizer-node', async () => ({ stateKey: 'revision_intent', artifact: {} }), ['revision_intent']),
        stubDef('route-agent', async () => ({ stateKey: 'route_decision', artifact: { decision: 'auto_revise', reason: 'mock' } }), ['route_decision']),
      ],
      loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 0 }],
      onVerdictOverwritten: (nodeId, _run, result) => calls.push({ nodeId, stateKey: result.stateKey, artifact: result.artifact }),
    });
    expect(snap.status).toBe('paused');
    expect(snap.escalatePause).toBe(true);
    expect(calls).toEqual([
      {
        nodeId: 'route-agent',
        stateKey: 'route_decision',
        artifact: { decision: 'escalate_user', reason: 'loop cap (0) reached; escalating to user' },
      },
    ]);
  });

  it('环 cap 超限（plan 词表）：CR-2a② spread 保 findings——覆写后 verdict=escalate 且 findings 不丢', async () => {
    const calls: Array<{ artifact: unknown }> = [];
    const findings = [{ dimension: 'red-line', severity: 'hard', grounding: '禁写项', note: '冲突' }];
    const snap = await runMockChain({
      chain: [
        stubDef('brief-compiler-node', async () => ({ stateKey: 'chapter_brief', artifact: {} }), ['chapter_brief']),
        stubDef('brief-reviewer-node', async () => ({ stateKey: 'plan_review', artifact: { verdict: 'revise', summary: '卡面不行', findings } }), ['plan_review']),
      ],
      loops: [{ from: 'brief-compiler-node', through: 'brief-reviewer-node', cap: 0 }],
      onVerdictOverwritten: (_nodeId, _run, result) => calls.push({ artifact: result.artifact }),
    });
    expect(snap.status).toBe('paused');
    expect(snap.escalatePause).toBe(true);
    expect(calls).toEqual([
      {
        artifact: {
          verdict: 'escalate',
          summary: '卡面不行；规划环回环上限（cap 0）耗尽，升级裁决',
          findings,
        },
      },
    ]);
  });

  it('optimizer_failed 强制升级（route 词表）：覆写后重发 escalate_user', async () => {
    const calls: Array<{ nodeId: string; artifact: unknown }> = [];
    const snap = await runMockChain({
      chain: [
        // from 节点本圈产失败信号（清理发生在节点 run 前——本圈信号照常到达 through）。
        stubDef('revision-optimizer-node', async () => ({
          stateKey: 'optimizer_failed',
          artifact: { optimizer_failed: true, nodeId: 'revision-optimizer-node', message: 'compile failed' },
        }), ['optimizer_failed']),
        stubDef('route-agent', async () => ({ stateKey: 'route_decision', artifact: { decision: 'accept_as_truth', reason: 'ok' } }), ['route_decision']),
      ],
      loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 3 }],
      onVerdictOverwritten: (nodeId, _run, result) => calls.push({ nodeId, artifact: result.artifact }),
    });
    expect(snap.status).toBe('paused');
    expect(snap.escalatePause).toBe(true);
    expect(calls).toEqual([
      { nodeId: 'route-agent', artifact: { decision: 'escalate_user', reason: 'revision-optimizer 编译失败（optimizer_failed），升级裁决' } },
    ]);
  });

  it('CR-10 未知 verdict（route / plan 双词表）：覆写后各按词表形态重发', async () => {
    const calls: Array<{ artifact: unknown }> = [];
    const runPlan = await runMockChain({
      chain: [
        stubDef('brief-compiler-node', async () => ({ stateKey: 'chapter_brief', artifact: {} }), ['chapter_brief']),
        stubDef('brief-reviewer-node', async () => ({ stateKey: 'plan_review', artifact: { verdict: 'weird_value' } }), ['plan_review']),
      ],
      loops: [{ from: 'brief-compiler-node', through: 'brief-reviewer-node', cap: 2 }],
      onVerdictOverwritten: (_n, _r, result) => calls.push({ artifact: result.artifact }),
    });
    expect(runPlan.status).toBe('paused');
    const runRoute = await runMockChain({
      chain: [
        stubDef('revision-optimizer-node', async () => ({ stateKey: 'revision_intent', artifact: {} }), ['revision_intent']),
        stubDef('route-agent', async () => ({ stateKey: 'route_decision', artifact: { decision: 'weird_value' } }), ['route_decision']),
      ],
      loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 2 }],
      onVerdictOverwritten: (_n, _r, result) => calls.push({ artifact: result.artifact }),
    });
    expect(runRoute.status).toBe('paused');
    expect(calls).toEqual([
      { artifact: { verdict: 'escalate', reason: 'through 节点产出未知判决值 "weird_value"，升级裁决' } },
      { artifact: { decision: 'escalate_user', reason: 'through 节点产出未知判决值 "weird_value"，升级裁决' } },
    ]);
  });

  it('CR-1 空转断路（环入口指纹同判两圈）：覆写后重发', async () => {
    const calls: Array<{ nodeId: string; artifact: unknown }> = [];
    let routeRuns = 0;
    const snap = await runMockChain({
      chain: [
        stubDef('revision-optimizer-node', async () => ({ stateKey: 'revision_intent', artifact: {} }), ['revision_intent']),
        stubDef('route-agent', async () => {
          routeRuns += 1;
          return { stateKey: 'route_decision', artifact: { decision: 'auto_revise', reason: 'mock' } };
        }, ['route_decision']),
      ],
      // 草稿与 guard 判定全程不变——第二圈入口指纹与首圈相同 → 确定性空转短路。
      initialArtifacts: {
        'draft.initial': { text: '原稿正文' },
        'revision_guard': { verdict: 'clean' },
      },
      loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 3 }],
      onVerdictOverwritten: (nodeId, _run, result) => calls.push({ nodeId, artifact: result.artifact }),
    });
    expect(snap.status).toBe('paused');
    expect(snap.escalatePause).toBe(true);
    expect(routeRuns).toBe(1); // 第二圈 through 未再跑（断路在环入口）
    expect(calls).toEqual([
      {
        nodeId: 'route-agent',
        artifact: { decision: 'escalate_user', reason: '环内修订未改变草稿且 guard 同判（确定性空转）——按环超限矩阵短路升级' },
      },
    ]);
  });

  it('回调缺省（onVerdictOverwritten 不传）→ 零调用零回归（覆写分支照常 escalate-pause）', async () => {
    const snap = await runMockChain({
      chain: [
        stubDef('revision-optimizer-node', async () => ({ stateKey: 'revision_intent', artifact: {} }), ['revision_intent']),
        stubDef('route-agent', async () => ({ stateKey: 'route_decision', artifact: { decision: 'auto_revise', reason: 'mock' } }), ['route_decision']),
      ],
      loops: [{ from: 'revision-optimizer-node', through: 'route-agent', cap: 0 }],
    });
    expect(snap.status).toBe('paused');
    expect(snap.artifacts['route_decision']).toEqual({ decision: 'escalate_user', reason: 'loop cap (0) reached; escalating to user' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. runChapterChain e2e
// ════════════════════════════════════════════════════════════════════════════

/** 全链 generate mock（mirror chain-node-streaming.test.ts makeStreamingChainGenerate——终态产物形态按投影断言需要加料）。 */
function makeArtifactChainGenerate(
  mockOpts: { routeContent?: string } = {},
): ReturnType<typeof vi.fn> {
  const route = { decision: 'accept_as_truth', reason: '正文升级' };
  const review = {
    verdict: 'pass',
    summary: '节奏合理',
    dimensions: [
      { name: 'consistency', findings: [{ severity: 'info', quote: '风更紧了', location: '句2', explanation: '观察' }] },
    ],
    reasons: [],
  };
  const extractor = {
    storyTime: 5,
    title: '状态切面',
    subjects: [{ id: 'char:lin', type: 'char' }],
    patches: [{ subjectId: 'char:lin', path: '/位置', op: 'replace', value: 'B 城', summary: '林昭抵达 B 城' }],
  };
  const completeness = { findings: [], summary: '无缺漏', degraded: false };
  const storySync = { runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' };
  const planReview = { verdict: 'pass', summary: '卡面成立', findings: [] };
  return vi.fn(async (
    msgs: Array<{ role: string; content: string }>,
    sys: string,
    _tls: unknown,
    _abort: AbortSignal,
    opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
  ) => {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    const s = sys ?? '';
    if (lastUser.includes('第三步')) {
      return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
      opts?.onDelta?.({ type: 'reasoning', delta: '[write-think]' });
      opts?.onDelta?.({ type: 'text', delta: '{"title":"第二章' });
      return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('第一步')) {
      opts?.onDelta?.({ type: 'reasoning', delta: '[research-think]' });
      return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
    }
    if (lastUser.includes('核查')) {
      return { content: '{}', finishReason: 'stop' };
    }
    if (s.includes('规划审核')) return { content: JSON.stringify(planReview), finishReason: 'stop' };
    if (s.includes('路由判决')) {
      // CR-9 e2e 注入口：返回不可解析内容 → createLlmNode 重试耗尽 → error artifact → 链 error。
      //（brief-reviewer 是 graceful 节点——LLM 失败产 skipped 不产 error，error 终态须走 route。
      // 参数名 mockOpts——generate 回调第 5 参也叫 opts，同名会 shadow 吞掉注入。）
      if (mockOpts.routeContent !== undefined) {
        return { content: mockOpts.routeContent, finishReason: 'stop' };
      }
      return { content: JSON.stringify(route), finishReason: 'stop' };
    }
    if (s.includes('完整性审核')) return { content: JSON.stringify(completeness), finishReason: 'stop' };
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) return { content: JSON.stringify(review), finishReason: 'stop' };
    if (s.includes('story-sync-agent')) return { content: JSON.stringify(storySync), finishReason: 'stop' };
    if (s.includes('状态提取')) return { content: JSON.stringify(extractor), finishReason: 'stop' };
    return { content: '{}', finishReason: 'stop' };
  });
}

describe('WorkflowRuntime.runChapterChain — chain-node-artifact e2e', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-chain-artifact-'));
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

  it('AC2：每节点终态发 artifact（23 节点全覆盖）且先于同节点 node-done；AC-kind 抽查；seq 快照不消耗', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeArtifactChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('completed');

    const artifacts = events.filter((e) => e.type === 'chain-node-artifact');
    const dones = events.filter((e) => e.type === 'chain-node-done' && e.data.nodeId !== '__chain_run__');

    // 23 节点全覆盖（completed run 每节点恰跑一次 → 恰 23 份快照；环重跑多圈形态见下测）。
    const { CHAPTER_CHAIN_NODE_IDS } = await import('../src/nodes/chapter-chain');
    expect(artifacts.map((e) => e.data.nodeId)).toEqual([...CHAPTER_CHAIN_NODE_IDS]);
    expect(dones.map((e) => e.data.nodeId)).toEqual([...CHAPTER_CHAIN_NODE_IDS]);

    // 顺序断言（AC2）：每节点的 artifact 事件先于同节点 node-done（全节点核对）。
    for (const done of dones) {
      const artifactIdx = artifacts.findIndex((e) => e.data.nodeId === done.data.nodeId);
      const doneIdx = events.indexOf(done);
      expect(artifactIdx, `节点 ${done.data.nodeId} 的 artifact 应先于 node-done`).toBeGreaterThan(-1);
      expect(artifactIdx).toBeLessThan(doneIdx);
    }

    // kind 抽查（design §2 发射形态表关键行）。brief-card 的编译产物十段形态随编译器变——
    // 只锚 kind + 关键字段（goal 透传），不深比对全量（防与 brief-compiler 十段实现耦合）。
    const byNode = (id: string) => artifacts.find((e) => e.data.nodeId === id)!.data;
    expect(byNode('brief-compiler-node').summary?.kind).toBe('brief-card');
    expect((byNode('brief-compiler-node').summary as { brief?: { goal?: string } }).brief?.goal).toBe('REACH_B_CITY_GOAL');
    expect(byNode('route-agent').summary).toEqual({ kind: 'route-decision', decision: 'accept_as_truth', reason: '正文升级' });
    expect(byNode('multi-review-agent').summary).toEqual({
      kind: 'findings',
      verdict: 'pass',
      summary: '节奏合理',
      findings: [{ label: 'consistency', severity: 'info', quote: '风更紧了', note: '观察' }],
      total: 1,
    });
    expect(byNode('world-extractor-physical').summary).toEqual({
      kind: 'items',
      label: 'physical 轴提取：1 条状态变化 · 1 主体',
      items: ['char:lin /位置 replace——林昭抵达 B 城'],
      total: 1,
    });
    expect(byNode('story-sync-agent').summary).toEqual({ kind: 'line', line: 'story-sync：0 条设定补丁——无可提取' });

    // seq 语义（M6 快照不消耗）：draft-writer 流过（delta seq=0）→ artifact seq=0 同组；
    // 纯代码位（brief-compiler 无流）→ -1（无 attempt 锚）；artifact 发射后 delta seq 不受扰
    //（后续节点照常 0 起计数——非消耗性读取）。
    expect(byNode('draft-writer-agent').seq).toBe(0);
    expect(byNode('brief-compiler-node').seq).toBe(-1);
    const deltas = events.filter((e) => e.type === 'chain-delta');
    expect(deltas.filter((e) => e.data.nodeId === 'draft-writer-agent').every((e) => e.data.seq === 0)).toBe(true);
  });

  it('环重跑多圈发射（每圈 run 终态一份，不 dedupe）+ 同 run 同 seq；跨 run（redo）seq+1', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    // route 首圈 auto_revise（环回一圈：optimizer 编译 → 写手整章重写〔引文不可定位 → anchorless〕）
    // → 次圈 accept。
    const routeDecisions = ['auto_revise', 'accept_as_truth'];
    let routeIdx = 0;
    const review = {
      verdict: 'revise',
      summary: '开篇意象重复',
      dimensions: [
        { name: 'consistency', findings: [{ severity: 'warn', quote: '找不到这句正文', location: '句1', explanation: '意象重复' }] },
      ],
      reasons: [],
    };
    const optimizerIntent = {
      change: { summary: '整章收紧节奏' },
      lockedItems: [],
      rationale: { source: 'audit-finding', note: '环内 C1 编译' },
      provenance: { rawUserInstruction: 'auto_revise', compilerNote: '编译' },
    };
    const generate = vi.fn(async (
      msgs: Array<{ role: string; content: string }>,
      sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const s = sys ?? '';
      if (lastUser.includes('第三步')) {
        return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[write-think]' });
        return { content: `${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第一步')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[research-think]' });
        return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('核查')) return { content: '{}', finishReason: 'stop' };
      if (s.includes('规划审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '卡面成立', findings: [] }), finishReason: 'stop' };
      }
      if (s.includes('路由判决')) {
        const decision = routeDecisions[Math.min(routeIdx, routeDecisions.length - 1)];
        routeIdx += 1;
        return { content: JSON.stringify({ decision, reason: `mock (${decision})` }), finishReason: 'stop' };
      }
      if (s.includes('改稿意图编译器')) {
        opts?.onDelta?.({ type: 'reasoning', delta: '[optimizer-think]' });
        return { content: JSON.stringify(optimizerIntent), finishReason: 'stop' };
      }
      if (s.includes('完整性审核')) {
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        return { content: JSON.stringify(review), finishReason: 'stop' };
      }
      if (s.includes('story-sync-agent')) {
        return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
      }
      if (s.includes('状态提取')) {
        return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      }
      return { content: '{}', finishReason: 'stop' };
    });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const emitChainEvent = (e: { type: string; data: Record<string, unknown> }) => {
      events.push({ type: e.type, data: e.data });
    };
    const first = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), { emitChainEvent });
    expect(first.status).toBe('completed');

    // 环重跑：draft-writer 两圈各发一份（每圈 run 终态一份，不 dedupe）；同 run 共用同 seq（0）。
    const writerArtifacts = events.filter(
      (e) => e.type === 'chain-node-artifact' && e.data.nodeId === 'draft-writer-agent',
    );
    expect(writerArtifacts.length).toBe(2);
    expect(writerArtifacts.map((e) => e.data.seq)).toEqual([0, 0]);
    // 优化器：首圈 no-op（直通行）+ 环回圈 anchorless 意图行（quote 不可定位）。
    const optimizerArtifacts = events.filter(
      (e) => e.type === 'chain-node-artifact' && e.data.nodeId === 'revision-optimizer-node',
    );
    expect(optimizerArtifacts.length).toBe(2);
    expect(optimizerArtifacts[0]!.data.summary).toEqual({ kind: 'line', line: '直通（no-review-latest）' });
    expect(optimizerArtifacts[1]!.data.summary).toEqual({
      kind: 'line',
      line: '整章改稿意图：整章收紧节奏（引文不可定位降级）',
    });

    // 跨 run（redo 形态——同 parent 会话第二次整链跑）：流过的节点 delta seq+1，artifact 同步 1
    //（计数器快照随 delta 递增——per-attempt 归组锚跨 run 生效）。第二次 run route 首圈即 accept
    //（mock routeIdx 已耗尽双圈）→ writer 单圈单份。
    events.length = 0;
    const second = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), { emitChainEvent });
    expect(second.status).toBe('completed');
    const deltas2 = events.filter((e) => e.type === 'chain-delta' && e.data.nodeId === 'draft-writer-agent');
    expect(deltas2.length).toBeGreaterThan(0);
    expect(deltas2.every((e) => e.data.seq === 1)).toBe(true);
    const writerArtifacts2 = events.filter(
      (e) => e.type === 'chain-node-artifact' && e.data.nodeId === 'draft-writer-agent',
    );
    expect(writerArtifacts2.map((e) => e.data.seq)).toEqual([1]);
  });

  it('blocked 终态：DAG 拦截节点发通用受阻行，先于同节点 node-done(blocked)', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeArtifactChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    // 剥 scene_graph → brief-compiler（requiredArtifactKeys 含 scene_graph）首节点即 blocked。
    const { scene_graph: _stripped, ...initialArtifacts } = makeInitialArtifacts();
    void _stripped;
    const summary = await runtime.runChapterChain(parent.id, initialArtifacts, {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('blocked');

    const artifactEvents = events.filter((e) => e.type === 'chain-node-artifact');
    const blockedDone = events.find(
      (e) => e.type === 'chain-node-done' && e.data.status === 'blocked',
    );
    expect(blockedDone).toBeDefined();
    expect(blockedDone!.data.nodeId).toBe('brief-compiler-node');
    // 受阻通用行先于 node-done(blocked)（AC2 顺序对 blocked 同样成立）。
    expect(artifactEvents.length).toBe(1);
    expect(artifactEvents[0]!.data.nodeId).toBe('brief-compiler-node');
    expect(artifactEvents[0]!.data.role).toBe('brief-compiler-node');
    expect(artifactEvents[0]!.data.seq).toBe(-1);
    expect(artifactEvents[0]!.data.summary).toEqual({
      kind: 'line',
      line: '节点受阻：node "brief-compiler-node" blocked: missing required artifacts [scene_graph]',
    });
    expect(events.indexOf(artifactEvents[0]!)).toBeLessThan(events.indexOf(blockedDone!));
  });

  it('CR 批 CR-3 e2e：自审环 cap 超限覆写 → 补发 route-decision 帧（事件流末帧 escalate_user 非 stale auto_revise）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    // route 恒 auto_revise → 环跑满 cap 3 → 第 4 次 through 处理 cap 超限强制覆写 escalate_user。
    // 写手每圈产**不同**正文（text 随圈变）——绕开 CR-1 空转断路器（同稿两圈短路是另一分支，单测已钉）。
    let draftLap = 0;
    const review = {
      verdict: 'revise',
      summary: '开篇意象重复',
      dimensions: [],
      reasons: [],
    };
    const optimizerIntent = {
      change: { summary: '整章收紧节奏' },
      lockedItems: [],
      rationale: { source: 'audit-finding', note: '环内 C1 编译' },
      provenance: { rawUserInstruction: 'auto_revise', compilerNote: '编译' },
    };
    const generate = vi.fn(async (
      msgs: Array<{ role: string; content: string }>,
      sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts2?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const s = sys ?? '';
      if (lastUser.includes('第三步')) {
        return { content: `${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第二步') || lastUser.includes('<DRAFT_READY>')) {
        draftLap += 1;
        opts2?.onDelta?.({ type: 'reasoning', delta: '[write-think]' });
        const draft = { ...VALID_DRAFT, title: `第二章 B 城（第${draftLap}稿）`, text: `第${draftLap}稿：黄昏的荒野上，风更紧了。` };
        return { content: `${JSON.stringify(draft)}\n<DRAFT_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('第一步')) {
        opts2?.onDelta?.({ type: 'reasoning', delta: '[research-think]' });
        return { content: `${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`, finishReason: 'stop' };
      }
      if (lastUser.includes('核查')) return { content: '{}', finishReason: 'stop' };
      if (s.includes('规划审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '卡面成立', findings: [] }), finishReason: 'stop' };
      }
      if (s.includes('路由判决')) {
        return { content: JSON.stringify({ decision: 'auto_revise', reason: 'mock (auto_revise)' }), finishReason: 'stop' };
      }
      if (s.includes('改稿意图编译器')) {
        return { content: JSON.stringify(optimizerIntent), finishReason: 'stop' };
      }
      if (s.includes('完整性审核')) {
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        return { content: JSON.stringify(review), finishReason: 'stop' };
      }
      if (s.includes('story-sync-agent')) {
        return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
      }
      if (s.includes('状态提取')) {
        return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      }
      return { content: '{}', finishReason: 'stop' };
    });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('paused');
    expect(summary.escalatePause).toBe(true);

    // 路由节点 4 次 run（3 次环回 + 第 4 次 cap 超限）各发一份原始 auto_revise 帧
    // + cap 覆写后的重发帧——事件流末帧 = escalate_user（时间线姿态与真实终态一致）。
    const routeFrames = events.filter(
      (e) => e.type === 'chain-node-artifact' && e.data.nodeId === 'route-agent',
    );
    expect(routeFrames.map((f) => (f.data.summary as { decision: string }).decision)).toEqual([
      'auto_revise',
      'auto_revise',
      'auto_revise',
      'auto_revise',
      'escalate_user',
    ]);
    expect(routeFrames[routeFrames.length - 1]!.data.summary).toEqual({
      kind: 'route-decision',
      decision: 'escalate_user',
      reason: 'loop cap (3) reached; escalating to user',
    });
    // 重发帧在链终态哨兵帧之前（escalate-pause 退出前置发射）。
    const sentinel = events.find(
      (e) => e.type === 'chain-node-done' && e.data.nodeId === '__chain_run__',
    );
    expect(events.indexOf(routeFrames[routeFrames.length - 1]!)).toBeLessThan(events.indexOf(sentinel!));
  });

  it('CR 批 CR-9：error 终态——error artifact 节点的快照先于同节点 node-done(error)（AC2 顺序对 error 同样成立）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    // route-agent 恒返不可解析内容 → createLlmNode 重试耗尽 → error artifact → 链 error 中断。
    //（brief-reviewer 是 graceful 节点——LLM 失败产 skipped 非 error，error 终态走 route 位。）
    const generate = makeArtifactChainGenerate({ routeContent: '完全不是 JSON（无围栏无大括号）' });
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts(), {
      emitChainEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    expect(summary.status).toBe('error');

    const errorDone = events.find(
      (e) => e.type === 'chain-node-done' && e.data.status === 'error',
    );
    expect(errorDone).toBeDefined();
    expect(errorDone!.data.nodeId).toBe('route-agent');
    // error 终态通用行（M4：{error:true} 前置守卫先于产物投影）。
    const errorArtifact = events.find(
      (e) => e.type === 'chain-node-artifact' && e.data.nodeId === 'route-agent',
    );
    expect(errorArtifact).toBeDefined();
    expect(errorArtifact!.data.summary).toEqual({
      kind: 'line',
      line: expect.stringMatching(/^节点失败：/),
    });
    // AC2 顺序（indexOf 断言）：artifact 快照先于同节点 node-done('error')。
    expect(events.indexOf(errorArtifact!)).toBeGreaterThan(-1);
    expect(events.indexOf(errorArtifact!)).toBeLessThan(events.indexOf(errorDone!));
  });

  it('emitChainEvent 缺省 → 零 chain-node-artifact 事件（链段行为零回归）', async () => {
    await registerWriterTools();
    const workflow = await import('../src/runtime/workflow');
    workflow.__resetChainNodeSeqCounters();
    const generate = makeArtifactChainGenerate();
    const runtime = workflow.createWorkflowRuntime({ generate: generate as never });
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });
    // 不传 emitChainEvent——正常完成（既有全部测试路径的形态；包装 identity 零事件）。
    const summary = await runtime.runChapterChain(parent.id, makeInitialArtifacts());
    expect(summary.status).toBe('completed');
  });
});
