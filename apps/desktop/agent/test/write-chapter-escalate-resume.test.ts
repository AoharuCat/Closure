import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// 链流程重排（09-13 W1a）：escalate-pause 裁决 resume 分派（R4b——入口层裁决编排改造）。
//
// leader 驱动 auto_revise redo 编排段已退役（chainRunner loops 链内回环取代 break 交 leader）——
// 本文件覆盖退役后的新入口层行为：
// a) escalate-pause + 放手档（hands_off+trust）+ 裁决 accept → resume 续跑分派（无 redo）+ 透明文案
// b) escalate-pause + 裁决 revise → resume redo 回环（nodeId=draft-writer + feedback=裁决 analysis）
// c) escalate-pause + 裁决器 null（parse 失败，W0-7 机械可判）→ 不假 pass：无第二次 runChapterChain +
//    findings 上呈 + 待裁决指引
// d) escalate-pause + ask 档（无 opt-in）→ 不自动 resume + findings metadata 透传 + 无 chapter_review 卡
// e) BLOCK 机械门（CR-001 保留）：escalate findings 含 block → 放手档也不 auto-trust（单次 run）
// f) W0-5 旧 stage 停点废弃拦截：resume 分派前检测 → clearChainSnapshot + fresh 重跑 + 迁移告知
//
// mock skillExecutor.runChapterChain（控制 summary 返值）+ runAgentWithExplicitSystem（role-aware：
// director 返空 entries / adjudicator 可控）。
//
// f) W0-5 旧 stage 停点废弃拦截：resume 分派前检测 → clearChainSnapshot + fresh 重跑 + 迁移告知
//    （W2 起按真实档位重映射激活——route-agent legacy 判据 = chapter_accept 在；draft-writer 活形态
//    = 挂起载荷在场）。

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  loadSessionMeta: vi.fn(),
}));

import { getSession } from '../src/agent/session';

const mockedGetSession = vi.mocked(getSession);

/** Story 3.5 之后采信权档位组合在 session 上（participationGear + trustAdjudication）；链流程重排
 * W2 起 hardEscalatePolicy 子开关同源（CR-2b 规划环矩阵用例）。 */
function setSession(
  mode: 'readonly' | 'suggest' | 'auto' | undefined,
  gear?: 'smart' | 'steer' | 'balanced' | 'hands_off',
  trust?: boolean,
  hardEscalate?: 'ask' | 'auto',
): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  mockedGetSession.mockReturnValue({
    permissionMode: mode,
    ...(gear !== undefined ? { participationGear: gear } : {}),
    ...(trust !== undefined ? { trustAdjudication: trust } : {}),
    ...(hardEscalate !== undefined ? { hardEscalatePolicy: hardEscalate } : {}),
  } as SessionState);
}

const FINDINGS = [
  {
    severity: 'warn' as const,
    quote: '主角突然决定进城',
    location: '句3',
    explanation: '前文未铺垫进城动机',
  },
];

const BLOCK_FINDINGS = [
  { severity: 'block' as const, quote: 'OOC 硬违规', location: '段1', explanation: '叙事特征维 block' },
];

const ADJUDICATION_ACCEPT = {
  analysis: '灰区整体可控，建议接受',
  recommendation: 'accept',
  recommendationReason: '缺陷不影响主线',
  options: [
    { label: '接受为真相', reason: '缺陷属风格层面' },
    { label: '改稿', reason: '补铺垫动机' },
  ],
};

const ADJUDICATION_REVISE = {
  analysis: '动机铺垫确有缺口，建议改稿',
  recommendation: 'revise',
  recommendationReason: '正文与计划冲突处计划更可信',
  options: [
    { label: '接受为真相', reason: '保留正文' },
    { label: '改稿', reason: '按计划补铺垫' },
  ],
};

/** escalate-pause summary factory（chainRunner W1a 产出的灰区暂停形态）。 */
function makeEscalatePauseSummary(
  findings: typeof FINDINGS | typeof BLOCK_FINDINGS = FINDINGS,
): RunSnapshotSummary {
  return {
    status: 'paused',
    escalatePause: true,
    routeDecision: { decision: 'escalate_user', reason: '灰区难断' },
    escalateFindings: findings,
    chapter_accept: { chapterId: 'ch_001', candidate: { content: '灰区稿' }, runId: 'r-esc' },
    draftText: '正文内容',
    errors: [],
  };
}

function makeAcceptSummary(): RunSnapshotSummary {
  return {
    status: 'completed',
    routeDecision: { decision: 'accept_as_truth', reason: '续跑收敛' },
    chapter_accept: { chapterId: 'ch_001', candidate: { content: '续跑后候选' }, runId: 'r-esc' },
    errors: [],
  };
}

describe('write_chapter 链流程重排 W1a：escalate-pause 裁决 resume 分派 + 旧快照拦截', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let adjudicatorContent: string;
  let getChainSnapshot: ReturnType<typeof vi.fn>;
  let clearChainSnapshot: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-escalate-'));
    runChapterChain = vi.fn();
    adjudicatorContent = '{}'; // 默认 parse 失败 → adjudication null（graceful 分支）
    runAgentWithExplicitSystem = vi.fn(async (_sid: string, role: string) => {
      if (role === 'director-agent') {
        return { content: JSON.stringify({ infoRelease: [], emotion: { points: [] }, atomicEdits: null }) };
      }
      if (role === 'adjudicator-agent') {
        return { content: adjudicatorContent };
      }
      return { content: '{}' };
    });
    getChainSnapshot = vi.fn();
    clearChainSnapshot = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
        runAgentWithExplicitSystem,
        getChainSnapshot,
        clearChainSnapshot,
      },
    };
    mockedGetSession.mockReset();
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function writeReadyProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }], edges: [], lines: [] },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    }), 'utf8');
  }

  /** count adjudicator dispatches only（排除 director）。 */
  function countAdjudicatorCalls(): number {
    return runAgentWithExplicitSystem.mock.calls.filter((c) => c[1] === 'adjudicator-agent').length;
  }

  // ─── a) 放手档 + 裁决 accept → resume 续跑 ───

  it('escalate-pause + hands_off+trust + 裁决 accept → 第二次 runChapterChain resume 续跑（无 redo）+ 采信透明文案', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true);
    adjudicatorContent = JSON.stringify(ADJUDICATION_ACCEPT);
    runChapterChain
      .mockResolvedValueOnce(makeEscalatePauseSummary())
      .mockResolvedValueOnce(makeAcceptSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 裁决器派发 1 次 + resume 续跑 1 次（第二次调用带 resume、无 redo）
    expect(countAdjudicatorCalls()).toBe(1);
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const resumeOptions = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean };
      redo?: { nodeId: string };
    };
    expect(resumeOptions.resume).toEqual({ fromSnapshot: true });
    expect(resumeOptions.redo).toBeUndefined();
    // 续跑后终态 summary + 采信透明文案 + chapter_accept 候选呈现
    const metadata = result.metadata as { summary?: RunSnapshotSummary; type?: string };
    expect(metadata.summary?.routeDecision?.decision).toBe('accept_as_truth');
    expect(result.output).toContain('【全自动采信】');
    expect(metadata.type).toBe('field_patch');
  });

  // ─── b) 放手档 + 裁决 revise → resume redo 回环 ───

  it('escalate-pause + 裁决 revise → resume redo 回环（nodeId=draft-writer + feedback=裁决 analysis）', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true);
    adjudicatorContent = JSON.stringify(ADJUDICATION_REVISE);
    runChapterChain
      .mockResolvedValueOnce(makeEscalatePauseSummary())
      .mockResolvedValueOnce(makeAcceptSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const redoOptions = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean; redoFrom?: string };
      redo?: { nodeId: string; feedback?: string };
    };
    // CR-2c：resume 载荷携 redoFrom（簇 1 workflow 消费——redo 边界节点移除；audit pause 恒
    // draft-writer-agent）。
    expect(redoOptions.resume).toEqual({ fromSnapshot: true, redoFrom: 'draft-writer-agent' });
    expect(redoOptions.redo).toBeDefined();
    expect(redoOptions.redo!.nodeId).toBe('draft-writer-agent');
    expect(redoOptions.redo!.feedback).toBe(ADJUDICATION_REVISE.analysis);
    // redo 后终态
    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('accept_as_truth');
    expect(result.output).toContain('【全自动采信】');
  });

  // ─── c) 裁决器 null（parse 失败）→ 不假 pass，无 resume，上呈 + 指引 ───

  it('escalate-pause + 裁决器 parse 失败 → 无第二次 runChapterChain + findings 上呈 + 待裁决指引（不假 pass）', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true); // 即使 opt-in，裁决器 null 也不采信（W0-7 机械判）
    runChapterChain.mockResolvedValueOnce(makeEscalatePauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 无 resume（裁决失败不自动续跑——绝不静默 accept）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(countAdjudicatorCalls()).toBe(1);
    // findings 上呈 + 采信失败文案 + 待裁决指引（R4b：接受=重调续跑 / 改稿=redo）
    expect(result.output).toContain('灰区 findings');
    expect(result.output).toContain('【放手采信失败】');
    expect(result.output).toContain('已暂停待裁决');
    expect(result.output).toContain('重调 write_chapter');
    // escalate-pause 不产 chapter_review 卡（裁决路径非 stage 审阅）也不产 field_patch（候选待链收尾）
    const metadata = result.metadata as { type?: string; findings?: { route: string } };
    expect(metadata.type).toBeUndefined();
    expect(metadata.findings?.route).toBe('escalate_user');
  });

  // ─── d) ask 档（无 opt-in）→ 不自动 resume + findings 透传 ───

  it('escalate-pause + suggest 档（无 opt-in）→ 单次 run + findings metadata 透传 + 无 chapter_review 卡', async () => {
    writeReadyProject();
    setSession('suggest');
    adjudicatorContent = JSON.stringify(ADJUDICATION_ACCEPT); // 裁决器有建议也不自动采信（未 opt-in）
    runChapterChain.mockResolvedValueOnce(makeEscalatePauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterId: 'ch-9', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const metadata = result.metadata as {
      type?: string;
      findings?: { source: string; route: string; chapterId?: string; items: unknown[] };
    };
    // escalate-pause ≠ stage pause：不产 chapter_review；findings metadata 透传（裁决 UI 消费面）
    expect(metadata.type).toBeUndefined();
    expect(metadata.findings).toEqual({
      source: 'reader-audit',
      route: 'escalate_user',
      chapterId: 'ch-9',
      items: FINDINGS,
    });
    // 裁决建议呈 leader chat（4.6 既有形态）+ 待裁决指引
    expect(result.output).toContain('【灰区裁决器初审】');
    expect(result.output).toContain('已暂停待裁决');
  });

  // ─── e) BLOCK 机械门（CR-001 保留）：block findings → 放手档也不 auto-trust ───

  it('escalate-pause + BLOCK findings + hands_off+trust → 永不 auto-trust（单次 run + 硬违规不豁免文案）', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true);
    adjudicatorContent = JSON.stringify(ADJUDICATION_ACCEPT); // 即便裁决器建议 accept
    runChapterChain.mockResolvedValueOnce(makeEscalatePauseSummary(BLOCK_FINDINGS));

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(runChapterChain).toHaveBeenCalledTimes(1); // BLOCK 门在前——无 resume
    expect(result.output).toContain('【硬违规不豁免】');
    expect(result.output).toContain('BLOCK');
  });

  // ─── f) W0-5 旧 stage 停点废弃拦截 ───

  it('自家 paused 链停在旧 verdict 停点（chapter_accept 在 = 旧 onAccept-先于-pause 产物）→ clearChainSnapshot + fresh 重跑 + 迁移告知（W2 真实 policy 激活态）', async () => {
    // 链流程重排 W2：档位重映射已落地（draft/verdict 退出全部 pauseStages）——拦截门按真实 policy
    // 激活（无需 doMock 模拟）。route-agent 停的 legacy 判据 = 非 escalate-pause + chapter_accept 在
    //（新 final pause 无候选——onAccept 移 E 段完成后）。
    writeReadyProject();
    setSession('suggest');
    // 首调返自家 busy → 走重入分派；快照停在旧 verdict 停点（route-agent，带旧候选）
    runChapterChain
      .mockResolvedValueOnce({
        status: 'error',
        errors: ['chain_run_active|heldBy=leader-session-1'],
      } as RunSnapshotSummary)
      .mockResolvedValueOnce(makeAcceptSummary());
    getChainSnapshot.mockReturnValue({
      runId: 'r-old',
      status: 'paused',
      currentNodeId: 'route-agent',
      projectPath,
      completedNodes: ['brief-compiler-node', 'route-agent'],
      pendingNodes: [],
      artifacts: {
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: '旧' } },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '旧候选' }, runId: 'r-old' },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 拦截：clearChainSnapshot + 第二次调用走 FRESH（无 resume——不机械续跑旧候选绕过新停点）
    expect(clearChainSnapshot).toHaveBeenCalledWith('leader-session-1');
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const secondOptions = runChapterChain.mock.calls[1][2] as { resume?: { fromSnapshot?: boolean } };
    expect(secondOptions.resume).toBeUndefined();
    // 迁移告知文案
    expect(result.output).toContain('【快照迁移】');
    expect(result.output).toContain('verdict');
  });

  it('自家 paused 链停在活挂起形态（draft-writer + suspended 在——W2 后 draft 位唯一活停点）→ 不拦截，走 resume 分派（零回归）', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain
      .mockResolvedValueOnce({
        status: 'error',
        errors: ['chain_run_active|heldBy=leader-session-1'],
      } as RunSnapshotSummary)
      .mockResolvedValueOnce(makeAcceptSummary());
    getChainSnapshot.mockReturnValue({
      runId: 'r-live',
      status: 'paused',
      currentNodeId: 'draft-writer-agent',
      projectPath,
      completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
      pendingNodes: [],
      artifacts: {
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
        // W2：draft 位停的活形态 = 出发核查挂起（suspended 动态 pause 全档位在）；纯 stage 停（无
        // suspended）已随档位重映射退役 → 拦截。
        research_brief: {
          briefHash: 'sha256:x',
          suspended: { kind: 'research_contradiction', rounds: 1, evidence: { contradictions: [], deviations: [] } },
        },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 挂起形态是活停点 → 不废弃（clearChainSnapshot 不调）→ resume 续跑
    expect(clearChainSnapshot).not.toHaveBeenCalled();
    const secondOptions = runChapterChain.mock.calls[1][2] as { resume?: { fromSnapshot?: boolean } };
    expect(secondOptions.resume).toEqual({ fromSnapshot: true });
    expect(result.output).not.toContain('【快照迁移】');
  });

  it('链流程重排 W2：自家 paused 链停在新终稿停点（route-agent 无 chapter_accept、非 escalate-pause）→ 活形态不拦截，走 resume 分派', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain
      .mockResolvedValueOnce({
        status: 'error',
        errors: ['chain_run_active|heldBy=leader-session-1'],
      } as RunSnapshotSummary)
      .mockResolvedValueOnce(makeAcceptSummary());
    // 新 final pause 形态：route-agent 停 + route accept + 无 chapter_accept（onAccept 移 E 段后）+
    // 无 escalatePause 标记。
    getChainSnapshot.mockReturnValue({
      runId: 'r-final',
      status: 'paused',
      currentNodeId: 'route-agent',
      projectPath,
      completedNodes: ['brief-compiler-node', 'brief-reviewer-node', 'route-agent'],
      pendingNodes: [],
      artifacts: {
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
        route_decision: { decision: 'accept_as_truth', reason: 'mock' },
        'draft.initial': { title: '终稿', text: '正文', wordCount: 2 },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 新终稿停点是活形态（suggest=['final']）→ 不废弃 → resume 续跑（E 段腿）
    expect(clearChainSnapshot).not.toHaveBeenCalled();
    const secondOptions = runChapterChain.mock.calls[1][2] as { resume?: { fromSnapshot?: boolean } };
    expect(secondOptions.resume).toEqual({ fromSnapshot: true });
    expect(result.output).not.toContain('【快照迁移】');
  });

  it('链流程重排 W2：自家 paused 链停在 escalate-pause（route-agent 带 chapter_accept 裁决材料）→ 永不拦（活形态，走 resume 分派）', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain
      .mockResolvedValueOnce({
        status: 'error',
        errors: ['chain_run_active|heldBy=leader-session-1'],
      } as RunSnapshotSummary)
      .mockResolvedValueOnce(makeEscalatePauseSummary());
    // escalate-pause 快照：route-agent 停 + escalatePause=true + chapter_accept 裁决材料在——
    // 与 legacy verdict 停（非 escalate + 候选在）的唯一区分 = escalatePause 标记（永不拦 guard）。
    getChainSnapshot.mockReturnValue({
      runId: 'r-esc',
      status: 'paused',
      escalatePause: true,
      currentNodeId: 'route-agent',
      projectPath,
      completedNodes: ['brief-compiler-node', 'route-agent'],
      pendingNodes: [],
      artifacts: {
        chapter_brief_input: { episodeId: 'ep1', brief: { goal: 'g' } },
        route_decision: { decision: 'escalate_user', reason: '灰区' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '裁决材料' }, runId: 'r-esc' },
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
    });

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // escalate-pause 永不拦（裁决暂停非 legacy stage 停）→ 不清快照 → resume 续跑（裁决分派腿）
    expect(clearChainSnapshot).not.toHaveBeenCalled();
    expect(result.output).not.toContain('【快照迁移】');
    const secondOptions = runChapterChain.mock.calls[1][2] as { resume?: { fromSnapshot?: boolean } };
    expect(secondOptions.resume).toEqual({ fromSnapshot: true });
  });

  // ════════════════════════════════════════════════════════════════════════
  // CR-2b（09-13 簇 3）：规划环 escalate-pause 裁决编排——老 gate 只认 routeDecision 对规划环
  // pause 零消费（裁决器不派发/材料不透传/auto-trust 不 resume/hardEscalate 矩阵不可达——真全自动
  // 档停摆）。planEscalate 载荷（簇 1 summarize 产）触发同一套裁决编排；裁决材料 = plan findings。
  // ════════════════════════════════════════════════════════════════════════

  /** 规划环 escalate-pause summary（planEscalate 载荷——簇 1 summarize 形态；无 routeDecision）。 */
  function makePlanEscalatePauseSummary(
    findings: Array<{ dimension: string; severity: 'hard' | 'soft'; grounding: string; note: string }>,
    errors: string[] = [],
  ): RunSnapshotSummary {
    return {
      status: 'paused',
      escalatePause: true,
      planEscalate: {
        verdict: 'escalate',
        loopLabel: 'plan',
        summary: '任务卡信息控制与目标冲突',
        findings,
      },
      errors,
    } as RunSnapshotSummary;
  }

  const PLAN_FINDINGS_SOFT = [
    { dimension: 'writability', severity: 'soft' as const, grounding: 'chapterBrief.goal', note: '目标含两场高潮，篇幅不足以挣得' },
  ];

  const PLAN_FINDINGS_HARD = [
    { dimension: 'redline-consistency', severity: 'hard' as const, grounding: 'genreContract.commitments[0]', note: '任务卡禁写清单与题材契约承诺直接冲突' },
  ];

  it('CR-2b：规划环 escalate-pause + suggest 档 → 派裁决器（plan findings 作材料）+ 规划灰区文案 + metadata.findings(source=plan-review) + 待裁决指引', async () => {
    writeReadyProject();
    setSession('suggest');
    adjudicatorContent = JSON.stringify(ADJUDICATION_ACCEPT);
    runChapterChain.mockResolvedValueOnce(makePlanEscalatePauseSummary(PLAN_FINDINGS_SOFT));

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterId: 'ch-9', chapterBrief: { goal: 'g' } }, ctx);

    // 裁决器派发 1 次（材料 = plan findings——修前规划环 pause 零派发）；单次 run（suggest 不 auto-trust）。
    expect(countAdjudicatorCalls()).toBe(1);
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const adjudicatorVars = runAgentWithExplicitSystem.mock.calls.find((c) => c[1] === 'adjudicator-agent')![2] as
      | Record<string, string>
      | undefined;
    expect(adjudicatorVars?.escalateFindings).toContain('writability'); // plan findings 透传为裁决材料
    // 呈现：规划灰区 findings（dimension/note/grounding 形态）+ 裁决建议 + 待裁决指引（规划环形态）。
    expect(result.output).toContain('规划审核灰区');
    expect(result.output).toContain('writability');
    expect(result.output).toContain('篇幅不足以挣得');
    expect(result.output).toContain('chapterBrief.goal');
    expect(result.output).toContain('【规划灰区裁决器初审】');
    expect(result.output).toContain('已暂停待裁决（规划环');
    expect(result.output).toContain('回规划环重编任务卡');
    // metadata.findings：source=plan-review（reader-audit 家族区分）+ items 投影；不产 chapter_review 卡。
    const metadata = result.metadata as { type?: string; findings?: { source: string; route: string; chapterId?: string; items: unknown[] } };
    expect(metadata.type).toBeUndefined();
    expect(metadata.findings).toEqual({
      source: 'plan-review',
      route: 'escalate',
      chapterId: 'ch-9',
      items: PLAN_FINDINGS_SOFT,
    });
  });

  it('CR-2b：规划环 escalate-pause + 放手档 + 裁决 revise → resume redo 回规划环 A1（nodeId + redoFrom 均 brief-compiler-node）', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true);
    adjudicatorContent = JSON.stringify(ADJUDICATION_REVISE);
    runChapterChain
      .mockResolvedValueOnce(makePlanEscalatePauseSummary(PLAN_FINDINGS_SOFT))
      .mockResolvedValueOnce(makeAcceptSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const redoOptions = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean; redoFrom?: string };
      redo?: { nodeId: string; feedback?: string };
    };
    // CR-2c：规划环裁决 revise 回 A1 重编任务卡（非 draft-writer）；redoFrom 落 resume 载荷。
    expect(redoOptions.resume).toEqual({ fromSnapshot: true, redoFrom: 'brief-compiler-node' });
    expect(redoOptions.redo).toEqual({ nodeId: 'brief-compiler-node', feedback: ADJUDICATION_REVISE.analysis });
    // redo 后终态照常（候选呈现）。
    const metadata = result.metadata as { summary?: RunSnapshotSummary };
    expect(metadata.summary?.routeDecision?.decision).toBe('accept_as_truth');
  });

  it('CR-2b：规划环 cap 耗尽 + hardEscalate=auto → 不停摆：保守采信 resume 续跑 + 「规划环未收敛」上报（无终弃——规划环无正文可弃）', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true, 'auto');
    runChapterChain
      .mockResolvedValueOnce(makePlanEscalatePauseSummary(PLAN_FINDINGS_SOFT, ['loop cap (2) reached at "brief-reviewer-node"; forced escalate']))
      .mockResolvedValueOnce(makeAcceptSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 机械分派（无裁决器）+ resume 续跑（进 B 写稿）+ 规划环未收敛上报；不终弃不派裁决器。
    expect(countAdjudicatorCalls()).toBe(0);
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const resumeOptions = runChapterChain.mock.calls[1][2] as { resume?: { fromSnapshot?: boolean }; redo?: unknown };
    expect(resumeOptions.resume).toEqual({ fromSnapshot: true });
    expect(resumeOptions.redo).toBeUndefined();
    expect(result.output).toContain('【规划环未收敛·保守采信】');
    expect(result.output).not.toContain('【本章已终弃】');
  });

  it('CR-2b：plan findings 含 hard（红线一致族）+ 放手档 → 永不 auto-trust（单次 run + 硬维度不豁免文案）', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true);
    adjudicatorContent = JSON.stringify(ADJUDICATION_ACCEPT); // 即便裁决器建议 accept
    runChapterChain.mockResolvedValueOnce(makePlanEscalatePauseSummary(PLAN_FINDINGS_HARD));

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // hard 维度 mirror CR-001 BLOCK 门：任何配置不 auto-trust——单次 run + 透明告知。
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('【硬维度不豁免】');
    expect(result.output).toContain('redline-consistency');
  });
});
