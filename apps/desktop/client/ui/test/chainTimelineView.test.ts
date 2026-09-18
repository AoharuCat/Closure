/**
 * 09-13 子3 W3（design §3 / §8）：时间线纯投影层（chainTimelineView）。
 *
 * 覆盖：
 * - 圈分组：route-decision 帧为圈边界（历史圈闭合/活跃圈展开）；error 降级帧不闭圈；
 *   append-only 多 attempt（同 nodeId 两圈各持 entry）。
 * - 灰预览：段内 nodeCatalog 序差集（plan/extract 单轮全量差集；loop 活跃圈差集；
 *   accept 后 loop 预览空）。
 * - 未知节点继承段游标（不丢步）；空时间线全目录预览。
 * - 摘要元数据（runmeta 派生）：startedAt/activeSegment/currentLap/completedLaps。
 * - 观察链解析：显式选择 → 项目锚 → null；路径归一（盘符大小写/反斜杠）。
 * - 呈现投影：findings chip 计数与色调 / route 判决色调 / severity 归一 / phase 分层聚合 /
 *   模型 chip（modelSwitch 优先 → writer-draft 槽 → ABSENT null）/ 格式化器。
 */
import { describe, expect, it } from 'vitest';
import type { ChainRunState } from '../src/shared/store/chainStreamBuffer';
import type { TimelineNodeEntry } from '../src/shared/store/chainTimeline';
import {
  artifactChipView,
  countChars,
  findingToneOf,
  formatCharCount,
  formatElapsed,
  formatNodeDuration,
  groupReasoningByPhase,
  KNOWN_SEVERITY_VALUES,
  modelChipView,
  nodeDisplayName,
  projectChapterCandidateEnvelopes,
  projectTimelineFeed,
  projectTimelineFeedMeta,
  resolveObservedChainSession,
  routeDecisionTone,
  severityLabel,
  type Translator,
} from '../src/features/writing/chainTimelineView';
import { CHAIN_NODE_CATALOG } from '../src/features/writing/nodeCatalog';
import { CHAIN_NODE_ORDER } from '../src/shared/store/chainStreamBuffer';

/** identity 译者（key 原样——键位断言语义）。 */
const identityT: Translator = (key) => key;

let at = 1_000;
function entry(nodeId: string, over: Partial<TimelineNodeEntry> = {}): TimelineNodeEntry {
  at += 1_000;
  return { nodeId, seq: -1, status: 'done', tools: [], reasoning: [], at, ...over };
}

function routeDone(decision: string, reason = ''): TimelineNodeEntry {
  return entry('route-agent', { summary: { kind: 'route-decision', decision, reason } });
}

/** 环体七节点一圈（optimizer→writer→guard→lint→multi→completeness→route）。 */
function fullLap(over: Partial<{ route: TimelineNodeEntry; writerStatus: TimelineNodeEntry['status'] }> = {}): TimelineNodeEntry[] {
  return [
    entry('revision-optimizer-node', { summary: { kind: 'line', line: '首圈 no-op 直通' } }),
    entry('draft-writer-agent', { status: over.writerStatus ?? 'done', summary: { kind: 'line', line: '整章交付：3,012 字' } }),
    entry('revision-guard-agent'),
    entry('lint-node', { summary: { kind: 'line', line: '去味扫描：2 命中' } }),
    entry('multi-review-agent'),
    entry('completeness-verify-node'),
    over.route ?? routeDone('auto_revise', '节奏后半偏快'),
  ];
}

describe('projectTimelineFeed — 圈分组（route-decision 帧为圈边界）', () => {
  it('两圈：第 1 圈闭合（含判决）折叠候选；第 2 圈活跃展开；loop pending = 活跃圈差集', () => {
    const entries = [
      entry('brief-compiler-node', { summary: { kind: 'brief-card', brief: {} } }),
      entry('brief-reviewer-node'),
      ...fullLap(),
      entry('revision-optimizer-node', { summary: { kind: 'line', line: '3 findings → 定向修订' } }),
      entry('draft-writer-agent', { status: 'running' }),
    ];
    const blocks = projectTimelineFeed(entries);

    // 三段恒出块（extract 未达也出——段标题 + 灰预览全貌）。
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: 'plain', segment: 'plan' });
    expect(blocks[2]).toMatchObject({ kind: 'plain', segment: 'extract', entries: [] });
    expect(blocks[2].pendingNodeIds).toHaveLength(14);
    const loop = blocks[1];
    if (loop.kind !== 'loop') throw new Error('unreachable');
    expect(loop.laps).toHaveLength(2);
    expect(loop.laps[0].closed).toBe(true);
    expect(loop.laps[0].routeDecision).toEqual({ decision: 'auto_revise', reason: '节奏后半偏快' });
    expect(loop.laps[0].entries).toHaveLength(7);
    expect(loop.laps[1].closed).toBe(false);
    expect(loop.laps[1].index).toBe(2);
    expect(loop.laps[1].entries).toHaveLength(2);
    // 灰预览 = catalog 序中活跃圈（第 2 圈）未跑节点。
    expect(loop.pendingNodeIds).toEqual([
      'revision-guard-agent', 'lint-node', 'multi-review-agent', 'completeness-verify-node', 'route-agent',
    ]);
  });

  it('append-only 多 attempt：同 nodeId（写手）两圈各持 entry（到达序即圈序）', () => {
    const entries = [...fullLap(), entry('revision-optimizer-node'), entry('draft-writer-agent')];
    const loop = projectTimelineFeed(entries)[1];
    if (loop?.kind !== 'loop') throw new Error('unreachable');
    const writerEntries = loop.laps.flatMap((l) => l.entries.filter((e) => e.nodeId === 'draft-writer-agent'));
    expect(writerEntries).toHaveLength(2); // 两圈各一条
    expect(loop.laps[0].entries.some((e) => e.nodeId === 'draft-writer-agent')).toBe(true);
    expect(loop.laps[1].entries.some((e) => e.nodeId === 'draft-writer-agent')).toBe(true);
  });

  it('route-agent error 降级帧（line kind）不闭圈；route-decision 才闭', () => {
    const entries = [
      ...fullLap({ route: entry('route-agent', { status: 'error', summary: { kind: 'line', line: '节点失败：429' } }) }),
    ];
    const loop = projectTimelineFeed(entries)[1];
    if (loop?.kind !== 'loop') throw new Error('unreachable');
    expect(loop.laps).toHaveLength(1);
    expect(loop.laps[0].closed).toBe(false);
  });

  it('accept 判决闭环 → 其后提取段 entries 落独立 plain 块；loop pending 空（终圈全成员）', () => {
    const entries = [
      entry('brief-compiler-node'),
      entry('brief-reviewer-node'),
      ...fullLap(),
      ...fullLap({ route: routeDone('accept', '质量达标') }),
      entry('world-extractor-physical', { summary: { kind: 'items', label: '物理事件', items: ['雨停'], total: 1 } }),
    ];
    const blocks = projectTimelineFeed(entries);
    expect(blocks.map((b) => (b.kind === 'loop' ? 'loop' : b.segment))).toEqual(['plan', 'loop', 'extract']);
    const loop = blocks[1];
    if (loop?.kind !== 'loop') throw new Error('unreachable');
    expect(loop.laps).toHaveLength(2);
    expect(loop.laps[1].closed).toBe(true);
    expect(loop.laps[1].routeDecision?.decision).toBe('accept');
    expect(loop.pendingNodeIds).toEqual([]); // 提取已开跑但 loop 自身无 pending
    const extract = blocks[2];
    if (extract?.kind !== 'plain') throw new Error('unreachable');
    expect(extract.entries).toHaveLength(1);
    // extract 灰预览 = 全量 14 节点差集（首节点已跑）。
    expect(extract.pendingNodeIds[0]).toBe('world-extractor-cognitive');
    expect(extract.pendingNodeIds).toHaveLength(13);
  });
});

describe('projectTimelineFeed — 灰预览与段游标', () => {
  it('plan 段部分跑：pending = catalog 序差集', () => {
    const blocks = projectTimelineFeed([entry('brief-compiler-node')]);
    expect(blocks[0]).toMatchObject({ kind: 'plain', segment: 'plan' });
    const plan = blocks[0];
    if (plan?.kind !== 'plain') throw new Error('unreachable');
    expect(plan.pendingNodeIds).toEqual(['brief-reviewer-node']);
  });

  it('未知节点继承前游标段（不丢步）', () => {
    const blocks = projectTimelineFeed([
      entry('brief-compiler-node'),
      entry('future-unknown-node'),
    ]);
    const plan = blocks[0];
    if (plan?.kind !== 'plain') throw new Error('unreachable');
    expect(plan.entries.map((e) => e.nodeId)).toEqual(['brief-compiler-node', 'future-unknown-node']);
    // 未知节点不进灰预览差集（表外无目录序）。
    expect(plan.pendingNodeIds).toEqual(['brief-reviewer-node']);
  });

  it('空时间线：三段恒出块 + 全目录 pending（2/7/14）——全貌灰预览', () => {
    const blocks = projectTimelineFeed([]);
    expect(blocks.map((b) => (b.kind === 'loop' ? 'loop' : b.segment))).toEqual(['plan', 'loop', 'extract']);
    const counts = blocks.map((b) => b.pendingNodeIds.length);
    expect(counts).toEqual([2, 7, 14]);
    expect(blocks[1].pendingNodeIds).toEqual(CHAIN_NODE_ORDER.filter((id) => CHAIN_NODE_CATALOG[id].segment === 'loop'));
  });
});

describe('projectTimelineFeedMeta — runmeta 派生', () => {
  it('空时间线：全 null/0', () => {
    expect(projectTimelineFeedMeta([])).toEqual({
      startedAt: null, activeSegment: null, currentLap: null, completedLaps: 0,
    });
  });

  it('plan 进行中 → activeSegment plan；loop 活跃圈 → lap 号 + completedLaps', () => {
    const plan = projectTimelineFeedMeta([entry('brief-compiler-node')]);
    expect(plan.activeSegment).toBe('plan');
    expect(plan.startedAt).not.toBeNull();

    const oneLap = projectTimelineFeedMeta([...fullLap(), entry('revision-optimizer-node')]);
    expect(oneLap.activeSegment).toBe('loop');
    expect(oneLap.currentLap).toBe(2);
    expect(oneLap.completedLaps).toBe(1);

    const midLap1 = projectTimelineFeedMeta(fullLap().slice(0, 3));
    expect(midLap1.currentLap).toBe(1);
    expect(midLap1.completedLaps).toBe(0);
  });

  it('accept 后提取段 → activeSegment extract + completedLaps 2（圈号连续性=末圈）', () => {
    const entries = [
      ...fullLap(),
      ...fullLap({ route: routeDone('accept') }),
      entry('world-extractor-physical'),
    ];
    const meta = projectTimelineFeedMeta(entries);
    expect(meta.activeSegment).toBe('extract');
    expect(meta.completedLaps).toBe(2);
    expect(meta.currentLap).toBe(2);
    expect(meta.startedAt).toBe(entries[0].at);
  });
});

describe('resolveObservedChainSession — 观察链解析', () => {
  const base = {
    chainRunBySession: { 'chain-1': { status: 'running' }, 'chain-2': { status: 'paused' } } as Record<string, unknown>,
    chainRunAnchorByProject: { '/proj-1': 'chain-1' },
    projectPath: '/proj-1',
  };

  it('显式选择（存在）胜项目锚；失效选择回落锚；无链 null', () => {
    expect(resolveObservedChainSession({ ...base, selectedChainSessionId: 'chain-2' })).toBe('chain-2');
    expect(resolveObservedChainSession({ ...base, selectedChainSessionId: 'chain-gone' })).toBe('chain-1');
    expect(resolveObservedChainSession({ ...base, chainRunBySession: {} })).toBeNull();
  });

  it('锚键归一匹配：盘符大小写/反斜杠漂移仍命中', () => {
    expect(resolveObservedChainSession({
      selectedChainSessionId: null,
      chainRunBySession: base.chainRunBySession,
      chainRunAnchorByProject: { 'c:/proj/a': 'chain-1' },
      projectPath: 'C:\\PROJ\\A',
    })).toBe('chain-1');
  });

  it('无 projectPath / 无锚表 → null（不误取他项目链）', () => {
    expect(resolveObservedChainSession({ ...base, projectPath: undefined })).toBeNull();
    expect(resolveObservedChainSession({ ...base, chainRunAnchorByProject: undefined })).toBeNull();
  });
});

describe('呈现投影 — chip / severity / phase / 模型', () => {
  it('findings chip：硬软计数 + 色调；零 findings → verdict/pass + ok', () => {
    const both = artifactChipView({
      kind: 'findings', verdict: 'needs_revision', summary: '',
      findings: [
        { label: 'a', severity: 'hard', quote: 'q', note: 'n' },
        { label: 'b', severity: 'block', quote: 'q', note: 'n' },
        { label: 'c', severity: 'soft', quote: 'q', note: 'n' },
        { label: 'd', severity: 'warn', quote: 'q', note: 'n' },
        { label: 'e', severity: 'info', quote: 'q', note: 'n' },
      ], total: 5,
    }, identityT);
    expect(both).toEqual({ text: 'chain.chip.findings', tone: 'err' }); // 2 硬 2 软（info 中性不计）

    const hardOnly = artifactChipView({
      kind: 'findings', summary: '', total: 1,
      findings: [{ label: 'a', severity: 'missing', quote: 'q', note: 'n' }],
    }, identityT);
    expect(hardOnly).toEqual({ text: 'chain.chip.findingsHard', tone: 'err' });

    const softOnly = artifactChipView({
      kind: 'findings', summary: '', total: 1,
      findings: [{ label: 'a', severity: 'soft', quote: 'q', note: 'n' }],
    }, identityT);
    expect(softOnly).toEqual({ text: 'chain.chip.findingsSoft', tone: 'warn' });

    const none = artifactChipView({ kind: 'findings', verdict: 'accept', summary: '', findings: [], total: 0 }, identityT);
    expect(none).toEqual({ text: 'accept', tone: 'ok' });
    const noneNoVerdict = artifactChipView({ kind: 'findings', summary: '', findings: [], total: 0 }, identityT);
    expect(noneNoVerdict).toEqual({ text: 'chain.chip.pass', tone: 'ok' });
  });

  it('route 判决色调：accept 族 ok / escalate 族 warn / auto_revise loop；brief·items·line 无 chip', () => {
    expect(routeDecisionTone('accept_as_truth')).toBe('ok');
    expect(routeDecisionTone('escalate_user')).toBe('warn');
    expect(routeDecisionTone('auto_revise')).toBe('loop');
    expect(artifactChipView({ kind: 'route-decision', decision: 'auto_revise', reason: 'r' }, identityT))
      .toEqual({ text: 'auto_revise', tone: 'loop' });
    expect(artifactChipView({ kind: 'brief-card', brief: {} }, identityT)).toBeNull();
    expect(artifactChipView({ kind: 'items', label: 'l', items: [], total: 0 }, identityT)).toBeNull();
    expect(artifactChipView({ kind: 'line', line: 'x' }, identityT)).toBeNull();
    expect(artifactChipView(undefined, identityT)).toBeNull();
  });

  it('severity 归一与显示名（策展词表 i18n；未知原值回显）', () => {
    expect(findingToneOf('hard')).toBe('hard');
    expect(findingToneOf('block')).toBe('hard');
    expect(findingToneOf('missing')).toBe('hard');
    expect(findingToneOf('under-developed')).toBe('hard');
    expect(findingToneOf('soft')).toBe('soft');
    expect(findingToneOf('warn')).toBe('soft');
    expect(findingToneOf('info')).toBe('neutral');
    expect(findingToneOf('bogus')).toBe('neutral');
    expect(severityLabel('hard', identityT)).toBe('chain.sev.hard');
    expect(severityLabel('under-developed', identityT)).toBe('chain.sev.under-developed');
    expect(severityLabel('bogus', identityT)).toBe('bogus');
  });

  it('phase 分层聚合：连续同段合并 / 相异分段 / null 归通用层', () => {
    const groups = groupReasoningByPhase([
      { messageId: 'r1', phase: 'research', text: '调查思考' },
      { messageId: 'r1b', phase: 'research', text: '（续）' },
      { messageId: 'r2', phase: 'writing', text: '写作思考' },
      { messageId: 'r3', text: '无 phase 段' },
      { messageId: 'r4', text: '又一段' },
    ]);
    expect(groups).toEqual([
      { phase: 'research', texts: ['调查思考', '（续）'], chars: 7 },
      { phase: 'writing', texts: ['写作思考'], chars: 4 },
      { phase: null, texts: ['无 phase 段', '又一段'], chars: 12 },
    ]);
  });

  it('nodeDisplayName：目录节点 → i18nKey；表外 → 机械去后缀', () => {
    expect(nodeDisplayName('lint-node', identityT)).toBe('chain.node.lint-node');
    expect(nodeDisplayName('future-node', identityT)).toBe('future');
    expect(nodeDisplayName('future-agent', identityT)).toBe('future');
  });
});

describe('模型 chip 投影', () => {
  function runOf(over: Partial<ChainRunState> = {}): ChainRunState {
    return {
      sessionId: 's', status: 'running', completedNodes: [], currentNodeId: null, errorNodeId: null,
      streamNodeId: null, streamRole: null, streamPhase: null, streamText: '', streaming: false,
      updatedAt: 1, ...over,
    };
  }

  const modelConfig = {
    keys: [{
      id: 'k1', name: '主键', protocol: 'openai', baseUrl: '', apiKeyRef: '',
      models: [{ id: 'm1', alias: '日常模型' }, { id: 'm2' }],
    }],
    taskModels: { 'writer-draft': { keyId: 'k1', modelId: 'm1' } },
  } as any;

  it('modelSwitch 优先（回退 to + from 标注）；主指派走 writer-draft 槽；ABSENT → null', () => {
    const sw = modelChipView(runOf({
      modelSwitch: { from: { keyId: 'k1', modelId: 'm2' }, to: { keyId: 'k1', modelId: 'm1' }, reason: 'timeout', nodeLabel: '写手', at: 1 },
    }), modelConfig);
    expect(sw).toEqual({ name: '日常模型', fallbackFrom: '主键 / m2', reason: 'timeout' });

    const slot = modelChipView(runOf(), modelConfig);
    expect(slot).toEqual({ name: '日常模型', fallbackFrom: null, reason: null });

    expect(modelChipView(runOf(), { keys: [] } as any)).toBeNull(); // 槽未配置（ABSENT ≠ 0——不造数）
    expect(modelChipView(undefined, modelConfig)).toEqual({ name: '日常模型', fallbackFrom: null, reason: null });
  });
});

describe('格式化器', () => {
  it('formatElapsed / formatNodeDuration / formatCharCount / countChars', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(754_000)).toBe('12:34');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatNodeDuration(45_000)).toBe('45s');
    expect(formatNodeDuration(250_000)).toBe('4m10s');
    expect(formatNodeDuration(300_000)).toBe('5m');
    expect(formatNodeDuration(3_780_000)).toBe('1h03m');
    expect(formatCharCount(812)).toBe('812');
    expect(formatCharCount(1_140)).toBe('1.1K');
    expect(countChars('你好  world\n\t！')).toBe(8); // 非空白计数（CJK 口径）
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CR-2（09-18 CR 批 B）：chapter_candidate envelope 扫描——项目过滤 + 观察链关联优先
// ════════════════════════════════════════════════════════════════════════════

describe('projectChapterCandidateEnvelopes — 项目过滤 + 观察链关联优先（CR-2）', () => {
  const candidatePatch = (chapterId: string, runId: string) => ({
    patch: {
      runId,
      createdAt: '2026-09-18T00:00:00.000Z',
      patches: [{
        field: 'chapter_candidate',
        action: 'set',
        data: { chapterId, runId: 'run-9', candidate: { chapterId, title: 't', content: 'c', wordCount: 1 } },
        fieldVersion: 1,
        generatedBy: 'write_chapter',
      }],
    },
    selections: {},
  });

  it('项目归属过滤：他项目 / 归属未知会话排除（mirror projectChainChips 注入形态）', () => {
    const pendingPatchBySession = {
      's-here': candidatePatch('ch-1', 's-here'),
      's-other': candidatePatch('ch-2', 's-other'),
      's-unknown': candidatePatch('ch-3', 's-unknown'),
      's-noncandidate': { patch: { runId: 's-nc', createdAt: '', patches: [{ field: 'outline_v2', action: 'set', data: {}, fieldVersion: 1 }] }, selections: {} },
      's-empty': undefined,
    } as any;
    const out = projectChapterCandidateEnvelopes({
      pendingPatchBySession,
      sessionProjects: (sid) => (sid === 's-here' ? '/proj-1' : sid === 's-other' ? '/other' : undefined),
      projectPath: '/proj-1',
      observedSessionId: null,
    });
    // 只有本项目 envelope 存活（他项目 + 归属未知排除；非 chapter_candidate / 空条目不进）。
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionId: 's-here', chapterId: 'ch-1', chainMatched: false });
  });

  it('观察链关联优先：chainMatched（挂载键或 patch.runId = 观察链 sid）排前；chapterId 缺席不造数', () => {
    const pendingPatchBySession = {
      's-early': candidatePatch('ch-early', 's-elsewhere'), // 项目内但非本链
      's-obs': candidatePatch('ch-obs', 's-obs'), // 挂载键 = 观察链 sid
      's-runid': candidatePatch('ch-runid', 's-obs'), // patch.runId = 观察链 sid（挂载键不同）
    } as any;
    const out = projectChapterCandidateEnvelopes({
      pendingPatchBySession,
      sessionProjects: () => '/proj-1',
      projectPath: '/proj-1',
      observedSessionId: 's-obs',
    });
    // 关联两条排前（挂载键命中者在最前），非关联殿后；消费方取 [0] 即本链关联。
    expect(out.map((e) => e.sessionId)).toEqual(['s-obs', 's-runid', 's-early']);
    expect(out[0]).toMatchObject({ chainMatched: true, chapterId: 'ch-obs' });
    expect(out[2].chainMatched).toBe(false);

    // data.chapterId 形态坏（非串/空串）→ chapterId null（不造数——消费方正文行缺省）。
    const bad = projectChapterCandidateEnvelopes({
      pendingPatchBySession: {
        's-bad': {
          patch: {
            runId: 's-bad', createdAt: '',
            patches: [{ field: 'chapter_candidate', action: 'set', data: { chapterId: 42 }, fieldVersion: 1 }],
          },
          selections: {},
        },
      } as any,
      sessionProjects: () => '/proj-1',
      projectPath: '/proj-1',
      observedSessionId: null,
    });
    expect(bad).toHaveLength(1);
    expect(bad[0].chapterId).toBeNull();
  });

  it('无项目路径 / 全键排除 → 空数组', () => {
    expect(projectChapterCandidateEnvelopes({
      pendingPatchBySession: { 's-1': candidatePatch('ch-1', 's-1') } as any,
      sessionProjects: () => '/proj-1',
      projectPath: undefined,
      observedSessionId: null,
    })).toEqual([]);
  });
});

// CR-16b（09-18 CR 批 B）：severity 已知集单源导出——severityLabel 与 i18n 守卫测试同源。
describe('KNOWN_SEVERITY_VALUES 单源（CR-16b）', () => {
  it('severityLabel 按导出集判定；集内七值齐全', () => {
    expect([...KNOWN_SEVERITY_VALUES].sort()).toEqual(
      ['block', 'hard', 'info', 'missing', 'soft', 'under-developed', 'warn'].sort(),
    );
    for (const sev of KNOWN_SEVERITY_VALUES) {
      expect(severityLabel(sev, identityT)).toBe(`chain.sev.${sev}`);
    }
    // 集外原值回显（未知不炸 UI）。
    expect(severityLabel('brand-new-sev', identityT)).toBe('brand-new-sev');
  });
});
