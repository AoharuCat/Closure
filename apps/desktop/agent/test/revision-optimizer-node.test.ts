import { describe, expect, it, vi } from 'vitest';
import {
  createRevisionOptimizerNode,
  isOptimizerFailedSignal,
  OPTIMIZER_FAILED_KEY,
  REVISION_INTENT_KEY,
} from '../src/nodes/revision-optimizer-node';
import { createRevisionGuardNode } from '../src/nodes/chapter-nodes';
import type { RevisionIntent } from '@orison/shared-contracts';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// 链流程重排 W1c：revision-optimizer-node（自审环 C1 位 in-chain 化）单测。
//
// 覆盖面（dispatch W1c）：
// 1. no-op 直通三条件：无 review.latest（首圈）/ 无 review + 外部预置意图 / 有 review + 外部预置
//    （rationale.source≠'audit-finding'）——均不调 generate，预置意图原样透传不覆盖
// 2. 编译路径：四 vars（selectedPassage=整稿 / userInstruction=机械指令 / chapterContext /
//    auditFindings=block+warn 投影 drop info）→ revision_intent artifact + source 机械盖戳
// 3. 失败信号：LLM 两轮均败 → optimizer_failed 信号（永不编造 intent）
// 4. 复用既有 revision-optimizer-agent.yaml（system 段真实加载）
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

const DRAFT = { title: '第二章', text: '黄昏的荒野上，他把真相说了出来。', wordCount: 2800 };

const REVIEW = {
  verdict: 'revise',
  summary: '信息泄露',
  dimensions: [
    {
      name: 'consistency',
      findings: [
        { severity: 'block', quote: '他把真相说了出来', location: '第1段', explanation: 'mustHide 违背' },
        { severity: 'info', quote: 'info 级不该进投影', location: '第2段', explanation: '噪声' },
      ],
    },
  ],
  reasons: ['mustHide 违背'],
};

/** LLM 输出形态的合法 RevisionIntent（source 故意标 user-directive——测 parseOutput 机械盖戳）。 */
const LLM_INTENT_OUTPUT = {
  change: { summary: '回收 mustHide 泄露段', details: ['把知情台词改为暗示'] },
  lockedItems: [{ field: '角色性格', authority: 'hard', evidence: '别动角色性格' }],
  rationale: { source: 'user-directive', note: '审读发现 mustHide 违背' },
  provenance: { rawUserInstruction: '修订本章泄露', compilerNote: '据 findings 编译' },
};

/** 外部预置意图（终稿/裁决 redo 注入形态——source ≠ 'audit-finding'）。 */
const EXTERNAL_INTENT = {
  change: { summary: '按终稿意见调整结尾' },
  lockedItems: [],
  rationale: { source: 'redo-feedback', note: '终稿打回意见' },
  provenance: { rawUserInstruction: '结尾太赶', compilerNote: '编译' },
};

/** C1 自产上一轮产物形态（source='audit-finding'——重编译不 no-op）。 */
const OWN_LAST_INTENT = {
  change: { summary: '上一轮编译的意图' },
  lockedItems: [],
  rationale: { source: 'audit-finding', note: '上一轮' },
  provenance: { rawUserInstruction: '修订', compilerNote: '上一轮编译' },
};

describe('revision-optimizer 节点：no-op 直通三条件', () => {
  it('条件一（无 review.latest 且无预置）：不调 generate，产 no-op 标记（非 RevisionIntent shape）——draft.initial 缺也不读（W1d 写手前链位，环回圈才有稿）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    // W1d 位调整钉死：C1 在写手**前**——首圈 draft.initial 不在场（写手还没跑），no-op 直通不读稿。
    const result = await node.run({
      run: makeRun({ chapter_brief: { goal: 'g' } }),
      requirement: '',
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.stateKey).toBe(REVISION_INTENT_KEY);
    expect(result.artifact).toEqual({
      optimizerNoOp: true,
      nodeId: 'revision-optimizer-node',
      reason: 'no-review-latest',
    });
  });

  it('条件一 + 外部预置（redo 清 review.latest 后注入）：预置意图原样透传，不编译不稀释', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': DRAFT, revision_intent: EXTERNAL_INTENT }),
      requirement: '',
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.stateKey).toBe(REVISION_INTENT_KEY);
    expect(result.artifact).toEqual(EXTERNAL_INTENT);
  });

  it('条件二（review.latest 在 + 外部预置 user-directive）：跳过编译，预置透传', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });
    const userDirectiveIntent = {
      ...EXTERNAL_INTENT,
      rationale: { source: 'user-directive', note: '选区指挥精修' },
    };

    const result = await node.run({
      run: makeRun({
        'draft.initial': DRAFT,
        'review.latest': REVIEW,
        revision_intent: userDirectiveIntent,
      }),
      requirement: '',
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.artifact).toEqual(userDirectiveIntent);
  });
});

describe('revision-optimizer 节点：编译路径', () => {
  it('review.latest 在且无预置 → 编译：四 vars 注入（整稿/机械指令/brief/投影 findings）+ source 盖戳 audit-finding', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({
        'draft.initial': DRAFT,
        chapter_brief: { goal: '主角识破伪装' },
        'review.latest': REVIEW,
      }),
      requirement: '',
    });

    expect(generate).toHaveBeenCalledTimes(1);
    const [messages, system] = generate.mock.calls[0];
    const userContent = messages[0]?.content ?? '';
    // selectedPassage = 整稿（mirror leader A-trigger）
    expect(userContent).toContain('黄昏的荒野上');
    // userInstruction 机械指令（与 write-chapter.ts leader 路径逐字对齐）
    expect(userContent).toContain('据 Reader-Audit 审核发现修订本章明确缺陷（auto_revise route decision）');
    // chapterContext
    expect(userContent).toContain('主角识破伪装');
    // auditFindings 投影：block 进、info 不进
    expect(userContent).toContain('他把真相说了出来');
    expect(userContent).not.toContain('info 级不该进投影');
    // 复用既有 revision-optimizer-agent.yaml（system 段真实加载）
    expect(system).toContain('改稿意图编译器');

    // revision_intent artifact：合法 RevisionIntent + source 机械盖戳（LLM 误标 user-directive 也归位）
    expect(result.stateKey).toBe(REVISION_INTENT_KEY);
    expect(result.artifact).toMatchObject({
      change: { summary: '回收 mustHide 泄露段' },
      lockedItems: [{ field: '角色性格', authority: 'hard' }],
      rationale: { source: 'audit-finding', note: '审读发现 mustHide 违背' },
    });
  });

  it('自产上一轮产物（source=audit-finding）+ 新 review.latest → 重编译（不 no-op）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    await node.run({
      run: makeRun({
        'draft.initial': DRAFT,
        'review.latest': REVIEW,
        revision_intent: OWN_LAST_INTENT,
      }),
      requirement: '',
    });

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('auditFindings 投影控量：9 条 block 只进 8（cap mirror extractEscalateFindings）', async () => {
    const findings = Array.from({ length: 9 }, (_, i) => ({
      severity: 'block',
      quote: `cap-quote-${i + 1}`,
      location: `第${i + 1}段`,
      explanation: `问题${i + 1}`,
    }));
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    await node.run({
      run: makeRun({
        'draft.initial': DRAFT,
        'review.latest': { verdict: 'revise', dimensions: [{ name: 'consistency', findings }], reasons: [] },
      }),
      requirement: '',
    });

    const [messages] = generate.mock.calls[0];
    const userContent = messages[0]?.content ?? '';
    expect(userContent).toContain('cap-quote-8');
    expect(userContent).not.toContain('cap-quote-9');
  });
});

describe('revision-optimizer 节点：失败信号', () => {
  it('LLM 两轮均败 → optimizer_failed 信号（永不编造 intent，非 error artifact 破链）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({
      content: '不是 JSON',
      finishReason: 'stop',
    }));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': DRAFT, 'review.latest': REVIEW }),
      requirement: '',
    });

    expect(generate).toHaveBeenCalledTimes(2); // MAX_ATTEMPTS（初试 + 重试一次）
    expect(result.stateKey).toBe(OPTIMIZER_FAILED_KEY);
    expect(isOptimizerFailedSignal(result.artifact)).toBe(true);
    expect(result.artifact).toMatchObject({
      optimizer_failed: true,
      nodeId: 'revision-optimizer-node',
    });
    expect((result.artifact as { message: string }).message).toContain('parseRevisionIntent 返 null');
  });

  it('isOptimizerFailedSignal：非信号形态（RevisionIntent / no-op 标记）→ false', () => {
    expect(isOptimizerFailedSignal(LLM_INTENT_OUTPUT)).toBe(false);
    expect(isOptimizerFailedSignal({ optimizerNoOp: true, nodeId: 'x', reason: 'no-review-latest' })).toBe(false);
    expect(isOptimizerFailedSignal(undefined)).toBe(false);
  });
});

describe('revision-optimizer 节点：契约', () => {
  it('requiredArtifactKeys=[]（W1d 位调整：C1 在写手前——首圈 no-op 不读稿，draft.initial 进 required 会首圈 DAG blocked）+ may-produce 双 key', () => {
    const node = createRevisionOptimizerNode({ generate: vi.fn<GenerateFn>(async () => makeOkResult({})) });
    expect(node.contract).toMatchObject({
      nodeId: 'revision-optimizer-node',
      requiredArtifactKeys: [],
      producedArtifactKeys: [REVISION_INTENT_KEY, OPTIMIZER_FAILED_KEY],
      sideEffects: ['call_model'],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CR-4（W-CR 批）：scope 机械构造——findings quote 命中段落 → anchored intent（C2 段落级 +
// C3 护栏真跑）；quote 不可定位 → anchorless 降级（guard skip 语义留）。
// ════════════════════════════════════════════════════════════════════════════

/** 多段正文 fixture（finding quote 命中第二段——段落级选区与整稿可区分）。 */
const MULTI_PARA_DRAFT = {
  title: '第三章',
  text: '第一段：夜色沉沉，他推开客栈的门。\n第二段：他把真相说了出来，声音很轻。\n第三段：雨还在下。',
  wordCount: 42,
};

/** LLM 自报 scope（幻觉形态——F2 订正后应被机械构造覆盖）。 */
const LLM_INTENT_WITH_HALLUCINATED_SCOPE = {
  ...LLM_INTENT_OUTPUT,
  scope: { anchor: { quote: '幻觉选区', prefix: '', suffix: '', rangeHint: { from: 0, to: 4 } } },
};

describe('revision-optimizer 节点：CR-4 scope 机械构造（anchored 主路径）', () => {
  it('findings quote 命中段落 → selectedPassage=命中段（非整稿）+ scope.anchor=该段（LLM 自报 scope 被覆盖）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_WITH_HALLUCINATED_SCOPE));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': MULTI_PARA_DRAFT, 'review.latest': REVIEW }),
      requirement: '',
    });

    // selectedPassage = 命中段（第二段），非整稿（第一段不进编译输入）。
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('第二段：他把真相说了出来，声音很轻。');
    expect(userContent).not.toContain('第一段：夜色沉沉');

    // scope 机械构造：anchor.quote = 命中段原文；rangeHint 指向该段在整稿中的位置；
    // LLM 自报 scope（幻觉选区）被覆盖。
    const artifact = result.artifact as RevisionIntent;
    expect(artifact.scope?.anchor.quote).toBe('第二段：他把真相说了出来，声音很轻。');
    expect(artifact.scope?.anchor.rangeHint.from).toBe('第一段：夜色沉沉，他推开客栈的门。\n'.length);
    expect(artifact.scope?.anchor.rangeHint.to).toBe(
      '第一段：夜色沉沉，他推开客栈的门。\n第二段：他把真相说了出来，声音很轻。'.length,
    );
    expect(artifact.scope?.anchor.quote).not.toBe('幻觉选区');
    // source 机械盖戳不变。
    expect(artifact.rationale.source).toBe('audit-finding');
  });

  it('首个 finding quote 不可定位 → 取次个可定位 finding（首个「可定位的」actionable finding）', async () => {
    const review = {
      verdict: 'revise',
      summary: '多发现',
      dimensions: [
        {
          name: 'consistency',
          findings: [
            // 第一条 quote 非逐字（LLM 转述）→ 跳过；第二条可定位。
            { severity: 'block', quote: '他轻声说出了那个秘密（转述非原文）', location: '第1段', explanation: 'x' },
            { severity: 'block', quote: '雨还在下', location: '第3段', explanation: 'y' },
          ],
        },
      ],
      reasons: [],
    };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': MULTI_PARA_DRAFT, 'review.latest': review }),
      requirement: '',
    });

    const artifact = result.artifact as RevisionIntent;
    expect(artifact.scope?.anchor.quote).toBe('第三段：雨还在下。');
  });
});

describe('revision-optimizer 节点：CR-4 anchorless 降级（quote 不可定位）', () => {
  it('全部 findings quote 不可定位 → 无 scope + compilerNote 机械附注降级原因 + selectedPassage 退整稿', async () => {
    const review = {
      verdict: 'revise',
      summary: '引文非逐字',
      dimensions: [
        {
          name: 'consistency',
          findings: [
            { severity: 'block', quote: '正文里不存在的一句转述', location: '第1段', explanation: 'x' },
          ],
        },
      ],
      reasons: [],
    };
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({ 'draft.initial': MULTI_PARA_DRAFT, 'review.latest': review }),
      requirement: '',
    });

    // anchorless：无 scope（C3 guard 整章 skip 语义留）。
    const artifact = result.artifact as RevisionIntent;
    expect(artifact.scope).toBeUndefined();
    // 附注机械降级原因（可观测非静默）。
    expect(artifact.provenance.compilerNote).toContain('机械附注');
    expect(artifact.provenance.compilerNote).toContain('降级整章改稿');
    // selectedPassage 退整稿（整章编译上下文）。
    const userContent = generate.mock.calls[0][0][0]?.content ?? '';
    expect(userContent).toContain('第一段：夜色沉沉');
  });
});

describe('revision-optimizer 节点：CR-20 空稿守卫（corrupt resume）', () => {
  it('review.latest 在 + draft.initial 缺 → no-op skip（reason=empty-draft-initial），不驱动空态编译', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({ 'review.latest': REVIEW, chapter_brief: { goal: 'g' } }),
      requirement: '',
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.stateKey).toBe(REVISION_INTENT_KEY);
    expect(result.artifact).toEqual({
      optimizerNoOp: true,
      nodeId: 'revision-optimizer-node',
      reason: 'empty-draft-initial',
    });
  });

  it('review.latest 在 + draft.initial.text 空/纯空白 → 同款 no-op skip', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    for (const text of ['', '   \n  ']) {
      const result = await node.run({
        run: makeRun({ 'draft.initial': { title: 't', text }, 'review.latest': REVIEW }),
        requirement: '',
      });
      expect(generate).not.toHaveBeenCalled();
      expect((result.artifact as { reason: string }).reason).toBe('empty-draft-initial');
    }
  });

  it('空稿 + 外部预置意图 → 预置透传优先（redo 注入不被空稿守卫吞）', async () => {
    const generate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const node = createRevisionOptimizerNode({ generate });

    const result = await node.run({
      run: makeRun({ 'review.latest': REVIEW, revision_intent: EXTERNAL_INTENT }),
      requirement: '',
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.artifact).toEqual(EXTERNAL_INTENT);
  });
});

describe('CR-4 C1→C3 环内衔接（anchored intent → guard L2 实跑；anchorless → guard skip）', () => {
  it('C1 产 anchored intent → C3 guard 真跑 L2（generate 被调）+ splice 落稿——环体主路径每圈有护栏', async () => {
    // C1：mock generate 产合法 intent（无 scope——机械构造补）。
    const optimizerGenerate = vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT));
    const optimizerNode = createRevisionOptimizerNode({ generate: optimizerGenerate });
    const optimizerResult = await optimizerNode.run({
      run: makeRun({ 'draft.initial': MULTI_PARA_DRAFT, 'review.latest': REVIEW }),
      requirement: '',
    });
    const intent = optimizerResult.artifact as RevisionIntent;
    expect(intent.scope?.anchor).toBeDefined();

    // C3：writer 段落级形态（text=改前整章 + passageText=改后段）→ guard 应真跑 L2 非 skip。
    const guardGenerate = vi.fn<GenerateFn>(async () =>
      makeOkResult({ verdict: 'clean', findings: [], summary: '保义通过' }),
    );
    const guardNode = createRevisionGuardNode({ generate: guardGenerate });
    const guardRun = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: intent,
      'draft.initial': {
        title: MULTI_PARA_DRAFT.title,
        text: MULTI_PARA_DRAFT.text,
        passageText: '第二段：他把真相说了出来，声音轻得像叹息。',
      },
    });
    const guardResult = await guardNode.run({ run: guardRun, requirement: '' });

    // L2 实跑（anchored → 非 skip 路径——CR-4 主断言：环体护栏覆盖）。
    expect(guardGenerate).toHaveBeenCalledTimes(1);
    // clean → splice 落稿：命中段被换，其余段落不动。
    expect(guardResult.stateKey).toBe('draft.initial');
    expect((guardResult.artifact as { text: string }).text).toBe(
      '第一段：夜色沉沉，他推开客栈的门。\n第二段：他把真相说了出来，声音轻得像叹息。\n第三段：雨还在下。',
    );
  });

  it('C1 产 anchorless intent（quote 不可定位降级）→ C3 guard 整章 skip（L2 零调用——降级路径语义不变）', async () => {
    const review = {
      verdict: 'revise',
      summary: '引文非逐字',
      dimensions: [
        { name: 'consistency', findings: [{ severity: 'block', quote: '不存在的转述', location: '第1段', explanation: 'x' }] },
      ],
      reasons: [],
    };
    const optimizerNode = createRevisionOptimizerNode({
      generate: vi.fn<GenerateFn>(async () => makeOkResult(LLM_INTENT_OUTPUT)),
    });
    const optimizerResult = await optimizerNode.run({
      run: makeRun({ 'draft.initial': MULTI_PARA_DRAFT, 'review.latest': review }),
      requirement: '',
    });
    const intent = optimizerResult.artifact as RevisionIntent;
    expect(intent.scope).toBeUndefined();

    const guardGenerate = vi.fn<GenerateFn>(async () => makeOkResult({ verdict: 'clean', findings: [], summary: 'x' }));
    const guardNode = createRevisionGuardNode({ generate: guardGenerate });
    const guardRun = makeRun({
      chapter_brief: { goal: 'g' },
      revision_intent: intent,
      'draft.initial': { title: MULTI_PARA_DRAFT.title, text: MULTI_PARA_DRAFT.text },
    });
    const guardResult = await guardNode.run({ run: guardRun, requirement: '' });

    // 整章路径 skip：L2 不调，draft.initial 原样透传，guard 记 skipped。
    expect(guardGenerate).not.toHaveBeenCalled();
    expect(guardResult.stateKey).toBe('draft.initial');
    expect((guardRun.artifacts['revision_guard'] as { skipped?: boolean }).skipped).toBe(true);
  });
});
