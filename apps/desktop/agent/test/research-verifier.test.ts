import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppearanceGapStat, ResearchBrief, SceneGraph, VerificationVerdict } from '@orison/shared-contracts';
import {
  buildAmmoText,
  createResearchVerifier,
  mapVerdictToOutcome,
  resolveAnchorStoryTime,
  VERIFIER_MAX_ROUNDS,
  VERIFIER_TOOL_IDS,
  type VerifierAmmo,
} from '../src/nodes/research-verifier';
import { applyEscalateBelt, WRITER_READONLY_TOOL_IDS, type WriterVerifyInput } from '../src/nodes/writer-node';
import { classifyTool } from '../src/runtime/toolPolicy';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { GenerateResult } from '../src/provider/ipc-provider';
import type { ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 Step 3（A4-A6，design §1.5/§1.6）：资料员转岗核实器测试。
// generate / resolveTool / fetchAmmo 全注入 fake（mirror writer-node.test.ts 模式）。覆盖：
// 机械弹药纯函数（出场间隔/锚/文本）/ mapVerdictToOutcome 三态 + AC-3 建议不影响许可 /
// escalate 机械 belt / 核实子循环（stablePrefix 三件 / verdict parse 重发 / graceful pass / 工具集红线）。
// ─────────────────────────────────────────────────────────────────────────────

/** 简报 fixture（无矛盾无偏离——机械 belt 不触发形态）。 */
const CLEAN_BRIEF: ResearchBrief = {
  plan: '城门对峙后入城收束',
  entries: [{ ref: 'char-lin', kind: 'asset', key_facts: [{ fact: '林昭左臂旧伤', source: '人物卡 char-lin' }] }],
  issues: [],
  execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙', notes: '短句提速' }],
  deviations: [],
};

function passVerdict(overrides: Partial<VerificationVerdict> = {}): VerificationVerdict {
  return {
    checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
    pass: true,
    gaps: [],
    suggestions: [],
    archive_issues: [],
    ...overrides,
  };
}

function gapsVerdict(): VerificationVerdict {
  return {
    checklist: { entities_checked: false, sources_grounded: true, gaps_cleared: false, contradictions_zero: true },
    pass: false,
    gaps: [{ desc: '未核查王五行踪', source_hint: 'query_story 搜「王五」' }],
    suggestions: [],
    archive_issues: [],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 机械弹药纯函数（间隔统计本体 = shared buildAppearanceGapStats 单源，shared-contracts 已测；
// 此处锚定弹药面的接缝——resolveAnchorStoryTime 锚 + buildAmmoText 双源措辞）。
// 双源取数（出场账优先/退世界状态/工具缺失降级）的 fetch 路径测试见 mention-query.test.ts。
// ════════════════════════════════════════════════════════════════════════════

function gap(
  entryId: string,
  over: Partial<AppearanceGapStat> = {},
): AppearanceGapStat {
  return {
    entryId,
    basis: 'mention',
    lastEpisodeId: `ep-of-${entryId}`,
    lastStoryTime: 10,
    storyTimeGap: 90,
    ...over,
  };
}

describe('resolveAnchorStoryTime — 本章开场 storyTime 锚', () => {
  const sceneGraph = {
    lines: [],
    nodes: [
      { id: 's1', lineTags: [], storyTime: 30, presentationOrder: { chapter: 2, pos: 0 }, episodeId: 'ep-12' },
      { id: 's2', lineTags: [], storyTime: 22, presentationOrder: { chapter: 2, pos: 1 }, episodeId: 'ep-12' },
      { id: 's3', lineTags: [], storyTime: 45, presentationOrder: { chapter: 3, pos: 0 }, episodeId: 'ep-13' },
    ],
  } as unknown as SceneGraph;

  it('取本章场集最小 storyTime（非首数组元素）', () => {
    expect(resolveAnchorStoryTime(sceneGraph, 'ep-12')).toBe(22);
  });

  it('本章无场 / scene_graph 缺 → undefined（间隔统计降级）', () => {
    expect(resolveAnchorStoryTime(sceneGraph, 'ep-none')).toBeUndefined();
    expect(resolveAnchorStoryTime(undefined, 'ep-12')).toBeUndefined();
  });
});

describe('buildAmmoText — 弹药文本（说人话：报机械事实不下创作结论；S9 双源口径标注）', () => {
  it('间隔条目区分出场账/世界状态口径 + 停滞 + 降级注记各成段', () => {
    const ammo: VerifierAmmo = {
      intervals: [
        gap('char-mei', { lastEpisodeId: 'ep-1', lastStoryTime: 5, storyTimeGap: 95 }),
        gap('char-lin', { basis: 'patches', lastEpisodeId: 'ep-9', lastStoryTime: 60, storyTimeGap: 40 }),
      ],
      stagnantArcs: [
        {
          arcRef: 'line-revenge',
          arcKind: 'line',
          lastBeatEpisodeIndex: 3,
          chaptersSinceLastBeat: 12,
          span: { fromEpisodeIndex: 1, toEpisodeIndex: 3 },
        },
      ],
      degradedReasons: [],
    };
    const text = buildAmmoText(ammo);
    // 段头说明双源口径（登场与被提及都算露面——提及补全 8.4 盲区）。
    expect(text).toContain('登场与被提及都算露面');
    expect(text).toContain('世界状态口径');
    // mention 口径条目：实体 + 最后露面章 + 间隔，无口径尾标。
    const meiLine = text.split('\n').find((l) => l.includes('char-mei'))!;
    expect(meiLine).toContain('ep-1');
    expect(meiLine).toContain('95');
    expect(meiLine).not.toContain('（世界状态口径）');
    // patches 口径条目：逐条标注口径（核实员可区分「间隔或被高估」）。
    const linLine = text.split('\n').find((l) => l.includes('char-lin'))!;
    expect(linLine).toContain('（世界状态口径）');
    expect(text).toContain('line-revenge');
    expect(text).toContain('12 章无新节拍');
    expect(text).toContain('不影响四判定');
  });

  it('空弹药成「无」句式 + 降级注记可见', () => {
    const text = buildAmmoText({ intervals: [], stagnantArcs: [], degradedReasons: ['出场账查询不可用（退世界状态口径）'] });
    expect(text).toContain('出场间隔统计：无');
    expect(text).toContain('弧停滞信号：无');
    expect(text).toContain('出场账查询不可用');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 产出映射 + escalate 机械 belt（AC-3：suggestions 不进 pass 计算）
// ════════════════════════════════════════════════════════════════════════════

describe('mapVerdictToOutcome — 三态映射', () => {
  it('pass → pass；gaps → gaps；verdict.escalate=true → escalate（与 pass 正交：全过仍升级）', () => {
    expect(mapVerdictToOutcome(CLEAN_BRIEF, passVerdict()).kind).toBe('pass');
    expect(mapVerdictToOutcome(CLEAN_BRIEF, gapsVerdict()).kind).toBe('gaps');
    const escalated = mapVerdictToOutcome(CLEAN_BRIEF, passVerdict({ escalate: true }));
    expect(escalated.kind).toBe('escalate');
  });

  it('AC-3：同输入只改 suggestions 字段，pass 判定结果不变', () => {
    const without = passVerdict();
    const withSuggestions = passVerdict({
      suggestions: [
        { text: '让 15 章没出场的少女 C 背景露一面', basis: '出场间隔统计：char-c 距本章 storyTime 差 88' },
        { text: '复仇线可给一拍远景', basis: '弧停滞信号：line-revenge 连续 12 章无新节拍' },
      ],
    });
    // outcome 的 kind 判定一致（suggestions 随 verdict 原样透传，不参与判定）。
    expect(mapVerdictToOutcome(CLEAN_BRIEF, withSuggestions).kind).toBe(mapVerdictToOutcome(CLEAN_BRIEF, without).kind);
    expect(mapVerdictToOutcome(CLEAN_BRIEF, withSuggestions).kind).toBe('pass');
  });
});

describe('applyEscalateBelt — 写手节点侧机械兜底', () => {
  it('简报 issues 含 contradiction → pass 也升级（不因宽松核实器放行）', () => {
    const contradictory: ResearchBrief = {
      ...CLEAN_BRIEF,
      issues: [{ desc: '任务卡与第 3 章正文冲突', severity: 'contradiction' }],
    };
    const out = applyEscalateBelt(contradictory, { kind: 'pass' });
    expect(out.kind).toBe('escalate');
  });

  it('deviations 非空 → 升级；无矛盾无偏离 → 原样透传（gaps 形态不改）', () => {
    const deviating: ResearchBrief = {
      ...CLEAN_BRIEF,
      deviations: [{ scene_ref: 's_gate', plan_says: '正面强攻', brief_says: '智取', reason: '人物动机' }],
    };
    expect(applyEscalateBelt(deviating, { kind: 'pass' }).kind).toBe('escalate');
    const gaps = { kind: 'gaps' as const, verdict: gapsVerdict() };
    expect(applyEscalateBelt(CLEAN_BRIEF, gaps)).toBe(gaps);
  });

  // ── R2-盲2（2026-08-19）：已批准偏离过滤——决断「维持原案」不在重跑中循环挂起 ──

  const D1 = { scene_ref: 's_gate', plan_says: '正面强攻', brief_says: '智取', reason: '人物动机' };

  function deviatingWith(deviation: typeof D1): ResearchBrief {
    return { ...CLEAN_BRIEF, deviations: [deviation] };
  }

  it('R2-盲2：已批准偏离（scene_ref+plan_says 对拍同，brief_says 措辞漂移容忍）→ 不升级', () => {
    const rephrased = { ...D1, brief_says: '改走小道突袭' };
    expect(applyEscalateBelt(deviatingWith(rephrased), { kind: 'pass' }, [D1]).kind).toBe('pass');
    // 完全相同形态同。
    expect(applyEscalateBelt(deviatingWith(D1), { kind: 'pass' }, [D1]).kind).toBe('pass');
    // gaps 形态原样透传（不因批准清单改判）。
    const gaps = { kind: 'gaps' as const, verdict: gapsVerdict() };
    expect(applyEscalateBelt(deviatingWith(D1), gaps, [D1])).toBe(gaps);
  });

  it('R2-盲2：对拍键不同（plan_says 变了 = 新偏离身份）→ 照常升级（批准的是具体偏离不是通行证）', () => {
    const newDeviation = { ...D1, plan_says: '围城困守' };
    expect(applyEscalateBelt(deviatingWith(newDeviation), { kind: 'pass' }, [D1]).kind).toBe('escalate');
    // 空批准清单（改卡决断 / 首跑）= 无过滤。
    expect(applyEscalateBelt(deviatingWith(D1), { kind: 'pass' }, []).kind).toBe('escalate');
    expect(applyEscalateBelt(deviatingWith(D1), { kind: 'pass' }).kind).toBe('escalate');
  });

  it('R2-盲2：已批准偏离不豁免 contradiction（矛盾归人决断恒升级）', () => {
    const both: ResearchBrief = {
      ...CLEAN_BRIEF,
      issues: [{ desc: '任务卡与资料冲突', severity: 'contradiction' }],
      deviations: [D1],
    };
    expect(applyEscalateBelt(both, { kind: 'pass' }, [D1]).kind).toBe('escalate');
  });

  it('R2-盲2：mapVerdictToOutcome 透传 approvedDeviations 进 belt（核实器侧同过滤，双 belt 单源）', () => {
    expect(mapVerdictToOutcome(deviatingWith(D1), passVerdict(), [D1]).kind).toBe('pass');
    expect(mapVerdictToOutcome(deviatingWith(D1), passVerdict(), []).kind).toBe('escalate');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 核实子循环（createResearchVerifier）
// ════════════════════════════════════════════════════════════════════════════

function makeFakeTool(id: string): ToolDefinition {
  return {
    id,
    description: `fake tool ${id}`,
    parameters: z.object({ q: z.string().optional() }),
    execute: vi.fn(async () => ({ title: id, output: `${id} 结果` })),
  };
}

function makeAllTools(): Map<string, ToolDefinition> {
  return new Map(VERIFIER_TOOL_IDS.map((id) => [id, makeFakeTool(id)]));
}

function textRound(content: string): GenerateResult {
  return { content, finishReason: 'stop' };
}

function toolCallRound(name: string): GenerateResult {
  return {
    content: '',
    toolCalls: [{ id: `call-${name}`, name, arguments: '{"q":"x"}' }],
    finishReason: 'tool_calls',
  };
}

function verifyInput(overrides: Partial<WriterVerifyInput> = {}): WriterVerifyInput {
  return {
    brief: CLEAN_BRIEF,
    episodeId: 'ep-12',
    chapterBrief: { goal: '抵达 B 城' },
    sceneGraph: undefined,
    episodeOutlines: undefined,
    ...overrides,
  };
}

function makeVerifierDeps(generate: GenerateFn, opts: { fetchAmmo?: () => Promise<VerifierAmmo> } = {}) {
  return {
    generate,
    resolveTool: (id: string) => makeAllTools().get(id),
    projectPath: '/test',
    fetchAmmo:
      opts.fetchAmmo ??
      (async (): Promise<VerifierAmmo> => ({
        intervals: [gap('char-mei', { lastEpisodeId: 'ep-1', lastStoryTime: 5, storyTimeGap: 95 })],
        stagnantArcs: [],
        degradedReasons: [],
      })),
  };
}

describe('createResearchVerifier — 核实子循环', () => {
  it('工具集 = 写手同款只读十三件（同引用）且全 classifyTool=read（AC-4：无档案写权限）', () => {
    expect([...VERIFIER_TOOL_IDS]).toEqual([...WRITER_READONLY_TOOL_IDS]);
    for (const id of VERIFIER_TOOL_IDS) {
      expect(classifyTool(id), `${id} 应为 read`).toBe('read');
    }
  });

  it('VERIFIER_MAX_ROUNDS 缺省 = 20（独立保险丝）', () => {
    expect(VERIFIER_MAX_ROUNDS).toBe(20);
  });

  it('stablePrefix 携任务卡+简报+弹药 → verdict 收束 → pass outcome', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(toolCallRound('query_story')) // 核实员抽查出处（工具轮）
      .mockResolvedValueOnce(
        textRound(`${JSON.stringify(passVerdict())}\n<VERIFICATION_VERDICT_READY>`),
      );
    const verifier = createResearchVerifier(makeVerifierDeps(generate));
    const outcome = await verifier(verifyInput());

    expect(outcome).toEqual({ kind: 'pass', verdict: passVerdict() });
    expect(generate).toHaveBeenCalledTimes(2);
    // 核实员收到的稳定前缀：任务卡 + 简报 + 机械弹药（yaml user 段三 var 渲染）。
    const firstMessages = generate.mock.calls[0][0];
    expect(firstMessages[0].role).toBe('user');
    expect(firstMessages[0].content).toContain('抵达 B 城'); // 任务卡
    expect(firstMessages[0].content).toContain('林昭左臂旧伤'); // 简报
    expect(firstMessages[0].content).toContain('char-mei'); // 弹药
    // 只读十三件给 LLM；工具真执行（抽查出处）。
    expect(generate.mock.calls[0][2].map((t) => t.id).sort()).toEqual([...VERIFIER_TOOL_IDS].sort());
  });

  it('gaps verdict → gaps outcome（缺什么+线索透传）', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(gapsVerdict())}\n<VERIFICATION_VERDICT_READY>`));
    const verifier = createResearchVerifier(makeVerifierDeps(generate));
    const outcome = await verifier(verifyInput());
    expect(outcome.kind).toBe('gaps');
    expect(outcome.kind === 'gaps' && outcome.verdict.gaps[0].desc).toContain('王五');
  });

  it('onDelta 注入（09-13 子2 W1）：reasoning 增量经 deps.onDelta 上行；text 滤除（verdict JSON 不开正文流）', async () => {
    const seenOpts: Array<{ onDelta?: unknown }> = [];
    const generate = vi.fn(async (
      _msgs: unknown[],
      _sys: string,
      _tls: unknown,
      _abort: AbortSignal,
      opts?: { onDelta?: (d: { type: 'text' | 'reasoning'; delta: string }) => void },
    ) => {
      seenOpts.push(opts ?? {});
      opts?.onDelta?.({ type: 'reasoning', delta: '核对中' });
      opts?.onDelta?.({ type: 'text', delta: '{"checklist"' }); // 裸 JSON text——滤除
      return textRound(`${JSON.stringify(passVerdict())}\n<VERIFICATION_VERDICT_READY>`);
    });
    const deltas: Array<{ messageId: string; channel: string; delta: string }> = [];
    const verifier = createResearchVerifier({
      ...makeVerifierDeps(generate as never as GenerateFn),
      onDelta: (d) => deltas.push(d),
    });
    const outcome = await verifier(verifyInput());
    // 判定不受开流影响（契约零变）。
    expect(outcome).toEqual({ kind: 'pass', verdict: passVerdict() });
    // makeAgentLoop 收到 onDelta（开流选中流式路径）；回调只收 reasoning。
    expect(typeof seenOpts[0]?.onDelta).toBe('function');
    expect(deltas).toEqual([{ messageId: expect.any(String), channel: 'reasoning', delta: '核对中' }]);
  });

  it('verdict parse 失败 → 回纠错重发 → 合法 verdict 收束（不崩不静默）', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound('这不是 verdict 格式'))
      .mockResolvedValueOnce(
        textRound(`${JSON.stringify(passVerdict())}\n<VERIFICATION_VERDICT_READY>`),
      );
    const verifier = createResearchVerifier(makeVerifierDeps(generate));
    const outcome = await verifier(verifyInput());
    expect(outcome.kind).toBe('pass');
    expect(generate).toHaveBeenCalledTimes(2);
    // 重发指令带回执（mirror runPhaseWithParse error-feedback）。
    const retryMessages = generate.mock.calls[1][0];
    expect(retryMessages.some((m) => m.role === 'user' && m.content.includes('无法解析'))).toBe(true);
  });

  it('parse 两试失败 → graceful pass 无 verdict + degraded 标记（增强层缺失不假 gaps/escalate；R2-盲3 降级直通非真许可）', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound('废输出一'))
      .mockResolvedValueOnce(textRound('废输出二'));
    const verifier = createResearchVerifier(makeVerifierDeps(generate));
    const outcome = await verifier(verifyInput());
    expect(outcome).toEqual({ kind: 'pass', degraded: true });
  });

  it('工具环境全 miss → graceful pass + degraded 标记（不残缺开跑核实）', async () => {
    const generate = vi.fn<GenerateFn>();
    const verifier = createResearchVerifier({
      generate,
      resolveTool: () => undefined,
      projectPath: '/test',
    });
    const outcome = await verifier(verifyInput());
    expect(outcome).toEqual({ kind: 'pass', degraded: true });
    expect(generate).not.toHaveBeenCalled();
  });

  it('AC-3（子循环级）：建议存在/不存在，pass 判定输出一致', async () => {
    const withSuggestions = passVerdict({
      suggestions: [{ text: '让少女 C 背景露一面', basis: '出场间隔统计：char-mei 差 95' }],
    });
    const genA = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(passVerdict())}\n<VERIFICATION_VERDICT_READY>`));
    const genB = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(
        textRound(`${JSON.stringify(withSuggestions)}\n<VERIFICATION_VERDICT_READY>`),
      );
    const outA = await createResearchVerifier(makeVerifierDeps(genA))(verifyInput());
    const outB = await createResearchVerifier(makeVerifierDeps(genB))(verifyInput());
    expect(outA.kind).toBe('pass');
    expect(outB.kind).toBe('pass');
    expect(outA.kind).toBe(outB.kind);
  });

  it('fetchAmmo seam 注入生效（弹药来自机械统计，随请求递入非核实期自算）', async () => {
    const fetchAmmo = vi.fn(async (): Promise<VerifierAmmo> => ({
      intervals: [],
      stagnantArcs: [],
      degradedReasons: ['世界状态查询不可用'],
    }));
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(
        textRound(`${JSON.stringify(passVerdict())}\n<VERIFICATION_VERDICT_READY>`),
      );
    const verifier = createResearchVerifier(makeVerifierDeps(generate, { fetchAmmo }));
    await verifier(verifyInput({ episodeId: 'ep-42' }));
    expect(fetchAmmo).toHaveBeenCalledTimes(1);
    expect(fetchAmmo.mock.calls[0][0].episodeId).toBe('ep-42');
    // 降级注记进稳定前缀（弹药部分不可得可见）。
    expect(generate.mock.calls[0][0][0].content).toContain('世界状态查询不可用');
  });
});
