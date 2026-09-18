import { describe, expect, it, vi } from 'vitest';
import {
  createBriefReviewerNode,
  normalizePlanReviewSeverity,
  normalizePlanReviewVerdict,
  PLAN_REVIEW_DIMENSIONS,
  PLAN_REVIEW_KEY,
  PLAN_REVIEW_VERDICTS,
  selectEpisodeOutlineWindow,
} from '../src/nodes/brief-reviewer-node';
import { loadAgentPrompt } from '../src/prompt/agentPrompt';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// 链流程重排 W1c：brief-reviewer-node（规划环 A2 位）单测。
//
// createLlmNode 工厂骨架（重试/兜底/abort）已由 llm-node.test.ts 覆盖。此处只验：
// 1. parseOutput：valid JSON → plan_review artifact（verdict/dimension/severity 归一）
// 2. 软硬划界 schema：severity 收敛 hard|soft（坏值降 soft 不丢 finding）；grounding 硬要求
// 3. buildPrompt：W0-9 四 vars——episodeOutlines 机械截取本章 ±1 邻章（非全量）
// 4. graceful（CR-E3 mirror）：LLM 失败 → skipped pass-through（skipped 标记 ≠ clean pass）
// 5. yaml 契约真实加载（brief-reviewer-agent.yaml system 段）
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

const RUN_FIXTURE = {
  chapter_brief: { goal: '主角识破伪装', ending: '留下隐患离场' },
  chapter_brief_input: { episodeId: 'ep_2', brief: {} },
  episode_outlines: [
    { id: 'ep_1', index: 1, title: '第一章 伪装入场' },
    { id: 'ep_2', index: 2, title: '第二章 当面对峙（本章）' },
    { id: 'ep_3', index: 3, title: '第三章 事后清算' },
    { id: 'ep_9', index: 9, title: '远章不进窗口' },
  ],
  emotion_curve: { unit: 'scene', points: [{ refId: 's1', sceneMood: 'tense' }] },
  genreContract: { commitments: [], genre_tags: ['都市悬疑'], world_constitution: [] },
};

describe('normalizePlanReviewVerdict / Severity（归一）', () => {
  it('canonical + 中文/变体别名归一', () => {
    expect(normalizePlanReviewVerdict('pass')).toBe('pass');
    expect(normalizePlanReviewVerdict(' 通过 ')).toBe('pass');
    expect(normalizePlanReviewVerdict('重编')).toBe('revise');
    expect(normalizePlanReviewVerdict('Auto-Revise-Pending')).toBe('revise');
    expect(normalizePlanReviewVerdict('escalate_user')).toBe('escalate');
    expect(normalizePlanReviewVerdict('灰区')).toBe('escalate');
  });

  it('未识别 → undefined（machinery 不能驱动未知 verdict）', () => {
    expect(normalizePlanReviewVerdict('maybe')).toBeUndefined();
    expect(normalizePlanReviewVerdict('')).toBeUndefined();
    expect(normalizePlanReviewVerdict(42)).toBeUndefined();
  });

  it('severity：block → hard（multi-review 习惯值兼容）；warn/未知 → soft 保守降级', () => {
    expect(normalizePlanReviewSeverity('hard')).toBe('hard');
    expect(normalizePlanReviewSeverity('BLOCK')).toBe('hard');
    expect(normalizePlanReviewSeverity('soft')).toBe('soft');
    expect(normalizePlanReviewSeverity('warn')).toBe('soft');
    expect(normalizePlanReviewSeverity('critical')).toBe('soft');
    expect(normalizePlanReviewSeverity(undefined)).toBe('soft');
  });
});

describe('selectEpisodeOutlineWindow（机械截取本章 ±1 邻章）', () => {
  it('命中本章 + 前后邻章，远章剔除，按 index 排序', () => {
    const window = selectEpisodeOutlineWindow(RUN_FIXTURE.episode_outlines, 'ep_2');
    expect(window.map((ep) => ep.id)).toEqual(['ep_1', 'ep_2', 'ep_3']);
  });

  it('episodeId 缺 / 本章 entry 不在 / 非数组 → 空窗口（graceful）', () => {
    expect(selectEpisodeOutlineWindow(RUN_FIXTURE.episode_outlines, undefined)).toEqual([]);
    expect(selectEpisodeOutlineWindow(RUN_FIXTURE.episode_outlines, 'ep_missing')).toEqual([]);
    expect(selectEpisodeOutlineWindow(null, 'ep_2')).toEqual([]);
  });

  it('坏条目单独丢（per-element safeParse），好条目保留', () => {
    const window = selectEpisodeOutlineWindow(
      [{ id: 'ep_1', index: 1 }, { id: 'ep_2', index: 2, title: '本章' }, 'not-an-object'],
      'ep_2',
    );
    expect(window.map((ep) => ep.id)).toEqual(['ep_2']);
  });
});

describe('brief-reviewer 节点', () => {
  it('parseOutput: valid JSON → plan_review artifact + stateKey（verdict/dimension 别名归一 + severity 收敛）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeOkResult({
        verdict: '通过',
        summary: '卡整体成立，红线有冲突',
        findings: [
          {
            dimension: '红线一致',
            severity: 'block',
            grounding: 'chapterBrief.doNotWrite 与 goal',
            note: 'goal 要求写出禁写内容',
          },
          {
            dimension: 'some-future-dim',
            severity: '奇怪值',
            grounding: 'chapterBrief.pacing',
            note: '未知维度未知档位原样保留',
          },
        ],
      }),
    );
    const node = createBriefReviewerNode({ generate });

    const result = await node.run({ run: makeRun(RUN_FIXTURE), requirement: '' });

    expect(result.stateKey).toBe(PLAN_REVIEW_KEY);
    expect(result.artifact).toEqual({
      verdict: 'pass',
      summary: '卡整体成立，红线有冲突',
      findings: [
        {
          dimension: 'red-line',
          severity: 'hard',
          grounding: 'chapterBrief.doNotWrite 与 goal',
          note: 'goal 要求写出禁写内容',
        },
        {
          dimension: 'some-future-dim',
          severity: 'soft',
          grounding: 'chapterBrief.pacing',
          note: '未知维度未知档位原样保留',
        },
      ],
    });
  });

  it('未识别 verdict → 抛触发重试 → 重试成功产 canonical', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce({
        content: '{"verdict":"maybe","summary":"x","findings":[]}',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce(
        makeOkResult({
          verdict: 'revise',
          summary: '第二次给对了',
          // 带 hard finding——verdict 归一（soft-only → pass）不触发，钉「重试产物 canonical revise」。
          findings: [{ dimension: 'writability', severity: 'hard', grounding: 'chapterBrief.plotPoints', note: 'goal 无场次支撑' }],
        }),
      );
    const node = createBriefReviewerNode({ generate });

    const result = await node.run({ run: makeRun(RUN_FIXTURE), requirement: '' });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.stateKey).toBe(PLAN_REVIEW_KEY);
    expect((result.artifact as { verdict: string }).verdict).toBe('revise');
  });

  it('findings 缺 note / grounding 空串 → schema 拒 → 重试 → graceful skipped pass-through', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({
        verdict: 'revise',
        summary: 'x',
        findings: [{ dimension: 'red-line', severity: 'hard', grounding: '', note: '缺 grounding' }],
      }),
      finishReason: 'stop',
    }));
    const node = createBriefReviewerNode({ generate });

    const result = await node.run({ run: makeRun(RUN_FIXTURE), requirement: '' });

    // 两轮均败（MAX_ATTEMPTS=2）→ wrapper 转 skipped pass-through（CR-E3 mirror：不破链）
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.stateKey).toBe(PLAN_REVIEW_KEY);
    expect(result.artifact).toMatchObject({
      verdict: 'pass',
      findings: [],
      skipped: true,
    });
    // 永不假 pass 须区分：skipped 标记在场（非 clean pass）
    expect((result.artifact as { skipped?: true }).skipped).toBe(true);
  });

  it('graceful: LLM 全失败（畸形输出）→ skipped pass-through 直通写作', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({
      content: '不是 JSON',
      finishReason: 'stop',
    }));
    const node = createBriefReviewerNode({ generate });

    const result = await node.run({ run: makeRun(RUN_FIXTURE), requirement: '' });

    expect(result.stateKey).toBe(PLAN_REVIEW_KEY);
    expect(result.artifact).toMatchObject({ verdict: 'pass', skipped: true, findings: [] });
  });

  it('buildPrompt: episodeOutlines 机械截取（本章 ±1，远章剔除）+ currentEpisodeId + 其余三 vars 注入', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeOkResult({ verdict: 'pass', summary: 'ok', findings: [] }),
    );
    const node = createBriefReviewerNode({ generate });

    await node.run({ run: makeRun(RUN_FIXTURE), requirement: '' });

    const [messages, system] = generate.mock.calls[0];
    const userContent = messages[0]?.content ?? '';
    // chapterBrief 主载荷
    expect(userContent).toContain('主角识破伪装');
    // 邻章窗口：本章 + 前后邻章在，远章不在
    expect(userContent).toContain('当面对峙（本章）');
    expect(userContent).toContain('伪装入场');
    expect(userContent).toContain('事后清算');
    expect(userContent).not.toContain('远章不进窗口');
    expect(userContent).toContain('ep_2');
    // emotionCurve / genreContract 透传
    expect(userContent).toContain('tense');
    expect(userContent).toContain('都市悬疑');
    // yaml system 段真实加载（brief-reviewer-agent.yaml）
    expect(system).toContain('规划审核');
    expect(system).toContain('severity');
  });

  it('episodeId 解析不到 → episodes 空窗口（全书契合维 graceful 跳过）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeOkResult({ verdict: 'pass', summary: 'ok', findings: [] }),
    );
    const node = createBriefReviewerNode({ generate });
    const { chapter_brief_input, ...rest } = RUN_FIXTURE;

    await node.run({ run: makeRun(rest), requirement: '' });

    const [messages] = generate.mock.calls[0];
    const userContent = messages[0]?.content ?? '';
    expect(userContent).toContain('"episodes":[]');
  });

  it('契约：requiredArtifactKeys=[chapter_brief] + producedArtifactKeys=[plan_review]', () => {
    const node = createBriefReviewerNode({ generate: vi.fn<GenerateFn>(async () => makeOkResult({})) });
    expect(node.contract).toMatchObject({
      nodeId: 'brief-reviewer-node',
      requiredArtifactKeys: ['chapter_brief'],
      producedArtifactKeys: [PLAN_REVIEW_KEY],
      sideEffects: ['call_model'],
    });
  });

  // ── 软硬划界归一（链流程重排 W1d 单源落点：本节点 parseOutput）──
  // chainRunner readLoopVerdict 只读 verdict 字段——soft-only/零 findings 的 revise 必须在此
  // normalize 为 pass + 附注（防确定性空转环：brief-compiler 纯代码重编原样 → review 再判 → cap 耗尽）。

  it('soft-only findings + verdict=revise → 归一 pass + 附注标记（软维度不触发回环，findings 保留附注呈现）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeOkResult({
        verdict: 'revise',
        summary: '节奏偏紧',
        findings: [
          { dimension: 'pacing', severity: 'soft', grounding: 'chapterBrief.pacing', note: '连续高潮无喘息' },
          { dimension: 'drama-quality', severity: 'soft', grounding: 'chapterBrief.goal', note: '目标可欲性一般' },
        ],
      }),
    );
    const node = createBriefReviewerNode({ generate });
    const result = await node.run({ run: makeRun(RUN_FIXTURE), requirement: '' });

    expect(result.stateKey).toBe(PLAN_REVIEW_KEY);
    const artifact = result.artifact as { verdict: string; summary: string; findings: unknown[] };
    // verdict 归一 pass（plan_review 词表 → chainRunner kind='pass' 落穿前进，不回环）
    expect(artifact.verdict).toBe('pass');
    // summary 附注标记（观测面可辨「归一」而非 clean pass）+ soft findings 原样保留（任务卡附注呈现）
    expect(artifact.summary).toContain('soft-only');
    expect(artifact.findings).toHaveLength(2);
  });

  it('零 findings + verdict=revise（LLM 误标）→ 同归一 pass（无 hard 依据不可回环）', async () => {
    const generate = vi.fn<GenerateFn>(async () =>
      makeOkResult({ verdict: 'revise', summary: '感觉不行', findings: [] }),
    );
    const node = createBriefReviewerNode({ generate });
    const result = await node.run({ run: makeRun(RUN_FIXTURE), requirement: '' });
    expect((result.artifact as { verdict: string }).verdict).toBe('pass');
  });

  it('含 hard finding 的 revise → 维持 revise（硬维度照常触发重编回环）+ escalate 不受 severity 影响', async () => {
    const hardOnly = vi.fn<GenerateFn>(async () =>
      makeOkResult({
        verdict: 'revise',
        summary: '可写性缺陷',
        findings: [{ dimension: 'writability', severity: 'hard', grounding: 'chapterBrief.plotPoints', note: 'goal 无场次支撑' }],
      }),
    );
    const nodeHard = createBriefReviewerNode({ generate: hardOnly });
    const resultHard = await nodeHard.run({ run: makeRun(RUN_FIXTURE), requirement: '' });
    expect((resultHard.artifact as { verdict: string }).verdict).toBe('revise');

    // escalate + soft-only → 仍 escalate（灰区语义独立于 severity，归一不动 escalate）
    const esc = vi.fn<GenerateFn>(async () =>
      makeOkResult({
        verdict: 'escalate',
        summary: '规划与题材根基冲突',
        findings: [{ dimension: 'book-fit', severity: 'soft', grounding: 'genreContract.commitments[0]', note: '方向冲突两可' }],
      }),
    );
    const nodeEsc = createBriefReviewerNode({ generate: esc });
    const resultEsc = await nodeEsc.run({ run: makeRun(RUN_FIXTURE), requirement: '' });
    expect((resultEsc.artifact as { verdict: string }).verdict).toBe('escalate');
  });
});

// ── canonical 表 × yaml 契约漂移守卫（W1c 导出的消费面）──
// PLAN_REVIEW_DIMENSIONS / PLAN_REVIEW_VERDICTS 是 brief-reviewer-agent.yaml 输出契约的 canonical
// 值表（dimension 开放 string 非封闭 enum，表仅文档化归一目标）——yaml 侧改维度/verdict 集而不改
// 表（或反向）会让归一目标与契约静默漂移。此测试钉双向在场：每个 canonical id 都须在 yaml 文本中
// 出现（yaml 删维度/verdict → 红）；表加新维度而 yaml 未写 → 红（强制先落 yaml 契约）。
describe('PLAN_REVIEW canonical 表 × yaml 契约漂移守卫', () => {
  it('六维 canonical id + 三档 verdict 均出现在 brief-reviewer-agent.yaml 契约中', async () => {
    const prompt = await loadAgentPrompt('brief-reviewer-agent');
    const yamlText = `${prompt.system}\n${prompt.userTemplate}`;
    for (const dim of PLAN_REVIEW_DIMENSIONS) {
      expect(yamlText, `dimension "${dim}" 应出现在 yaml 契约`).toContain(dim);
    }
    for (const verdict of PLAN_REVIEW_VERDICTS) {
      expect(yamlText, `verdict "${verdict}" 应出现在 yaml 契约`).toContain(verdict);
    }
  });
});
