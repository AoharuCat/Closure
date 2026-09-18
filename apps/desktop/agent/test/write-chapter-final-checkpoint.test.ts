import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// 链流程重排（09-13 W2）：终稿 checkpoint + 落盘拆两步 + hardEscalatePolicy 处置矩阵（write_chapter
// 编排层）。覆盖：
// a) 终稿 pause → chapter_review metadata（stage='final' + resumeOptions accept/redo/abort +
//    reviewSummary/lintReport 字段级 additive 清单——plan-review M5）
// b) hardEscalate 矩阵（R4 / design §3）——cap 超限（强难信号）：
//    b1 'ask'（缺省，强难停点开）→ 不 auto-trust（裁决器仍派发供参考）+ 强难停点文案 + 无 resume
//    b2 'auto' + lintUnresolved（去味门禁未过机械代理）→ 终弃该章（clearChainSnapshot + 终弃上报，
//        不产 chapter_accept）
//    b3 'auto' + lint 干净 → 采信终稿（resume 续跑 + 「环未收敛」上报行）
//    b4 'auto' + 裁决器 null（普通灰区）→ 保守采信（resume + 环未收敛标注）
// c) auto 档挂起跳章（R4 安全自决）：
//    c1 单次挂起 → 跳章+标记（clearChainSnapshot + 跳章文案 + 不产 chapter_review 卡）
//    c2 suggest 挂起 → 维持暂停叫人（chapter_review 卡 + redo/abort）
//    c3 同章连续 ≥2 + 'ask' → 不再跳章，保持暂停叫人（快照保留）
//    c4 同章连续 ≥2 + 'auto' → 终弃
// d) E 段失败注入（AC2c / R4c）：derivationStale summary → 正文 post-hoc 落盘（chapter_write）+
//    【提取中断】上报 + 重提取指路
//
// mock skillExecutor.runChapterChain（控制 summary 返值）+ runAgentWithExplicitSystem（role-aware）+
// registry chapter_write mock tool（mirror write-chapter-story-sync 动态注册模式）。

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

function setSession(
  mode: 'readonly' | 'suggest' | 'auto',
  extra?: { gear?: 'hands_off'; trust?: boolean; hardEscalate?: 'ask' | 'auto' },
): void {
  mockedGetSession.mockReturnValue({
    permissionMode: mode,
    ...(extra?.gear !== undefined ? { participationGear: extra.gear } : {}),
    ...(extra?.trust !== undefined ? { trustAdjudication: extra.trust } : {}),
    ...(extra?.hardEscalate !== undefined ? { hardEscalatePolicy: extra.hardEscalate } : {}),
  } as SessionState);
}

const FINDINGS = [
  { severity: 'warn' as const, quote: '进城动机未铺垫', location: '句3', explanation: '前文无铺垫' },
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

/** cap 超限 escalate-pause summary（errors 含 loop cap —— 强难机械信号）。 */
function makeCapEscalatePauseSummary(lintUnresolved: boolean): RunSnapshotSummary {
  return {
    status: 'paused',
    escalatePause: true,
    routeDecision: { decision: 'escalate_user', reason: '环未收敛' },
    escalateFindings: FINDINGS,
    draftText: '环内终稿正文',
    ...(lintUnresolved ? { lintUnresolved: true } : {}),
    errors: ['loop cap (3) reached at "route-agent"; forced escalate'],
  };
}

/** 终稿 pause summary（suggest/readonly 档 stage 人审形态——route accept 后、E 段前）。 */
function makeFinalPauseSummary(): RunSnapshotSummary {
  return {
    status: 'paused',
    pausedStage: 'final',
    routeDecision: { decision: 'accept_as_truth', reason: '终稿可接受' },
    draftText: '终稿正文',
    draftContent: '终稿正文',
    reviewSummary: { verdict: 'pass', reasons: ['终稿可接受'], loopCount: 1, capExhausted: false },
    lintReport: '去味终态：0 命中（干净）。',
    errors: [],
  };
}

/** 出发核查挂起 pause summary（researchSuspension 载荷——A8 全档位链层暂停形态）。 */
function makeSuspensionPauseSummary(): RunSnapshotSummary {
  return {
    status: 'paused',
    pausedStage: 'draft',
    researchSuspension: {
      kind: 'research_contradiction',
      rounds: 1,
      evidence: {
        contradictions: [{ desc: '任务卡说右臂伤，第 3 章正文是左臂', severity: 'contradiction' }],
        deviations: [],
      },
    },
    errors: [],
  };
}

/** E 段失败 summary（derivationStale——route accept 已过但提取段 error 中断）。 */
function makeDerivationStaleSummary(): RunSnapshotSummary {
  return {
    status: 'error',
    routeDecision: { decision: 'accept_as_truth', reason: '终稿可接受' },
    draftText: '终稿正文（提取中断前的定稿）',
    derivationStale: true,
    errors: ['node "world-merge-node" error: mock E failure'],
  };
}

describe('write_chapter 链流程重排 W2：终稿 checkpoint + 落盘拆两步 + hardEscalate 矩阵', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let adjudicatorContent: string;
  let clearChainSnapshot: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(async () => {
    // W2：同章连续挂起计数是 module 级 Map——测试隔离清表。
    const { __resetSuspensionStreaks } = await import('../src/tool/write-chapter');
    __resetSuspensionStreaks();
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-final-'));
    runChapterChain = vi.fn();
    adjudicatorContent = '{}'; // 默认 parse 失败 → adjudication null
    runAgentWithExplicitSystem = vi.fn(async (_sid: string, role: string) => {
      if (role === 'director-agent') {
        return { content: JSON.stringify({ infoRelease: [], emotion: { points: [] }, atomicEdits: null }) };
      }
      if (role === 'adjudicator-agent') {
        return { content: adjudicatorContent };
      }
      return { content: '{}' };
    });
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
        clearChainSnapshot,
      },
    };
    mockedGetSession.mockReset();
    // 默认 suggest（终稿人审档）。
    setSession('suggest');
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** 就绪 project（scene/episode/registered chapter ch_001——chapterId 映射 + E 失败落盘判定用）。 */
  function writeReadyProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomLine: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }], edges: [], lines: [] },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
      novel: { chapters: [{ id: 'ch_001', sort_order: 0, title: '第一章', sections: [{ content_file: 'chapters/ch_001.md' }] }] },
    }), 'utf8');
  }

  function countAdjudicatorCalls(): number {
    return runAgentWithExplicitSystem.mock.calls.filter((c) => c[1] === 'adjudicator-agent').length;
  }

  // ─── a) 终稿 pause metadata（plan-review M5 字段级清单）───

  it('终稿 pause → chapter_review metadata：stage=final + resumeOptions=[accept,redo,abort] + reviewSummary/lintReport 透传 + 终稿文案', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValueOnce(makeFinalPauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const metadata = result.metadata as {
      type?: string;
      stage?: string;
      resumeOptions?: string[];
      reviewSummary?: { verdict: string; loopCount: number };
      lintReport?: string;
      draftContent?: string;
    };
    expect(metadata.type).toBe('chapter_review');
    expect(metadata.stage).toBe('final');
    expect(metadata.resumeOptions).toEqual(['accept', 'redo', 'abort']);
    expect(metadata.reviewSummary).toMatchObject({ verdict: 'pass', loopCount: 1 });
    expect(metadata.lintReport).toBe('去味终态：0 命中（干净）。');
    expect(metadata.draftContent).toBe('终稿正文');
    expect(result.output).toContain('终稿 checkpoint');
    expect(result.output).toContain('accept');
  });

  // ─── b1) cap 超限 + 'ask'（缺省强难停点开）→ 不 auto-trust ───

  it('cap 超限 + hardEscalate=ask（缺省）+ 放手档 + 裁决 accept → 不 auto-trust：单次 run + 强难停点文案（收敛失败停下叫人）', async () => {
    writeReadyProject();
    setSession('auto', { gear: 'hands_off', trust: true }); // hardEscalate 缺省 'ask'
    adjudicatorContent = JSON.stringify(ADJUDICATION_ACCEPT); // 裁决器建议 accept 也不自动采信
    runChapterChain.mockResolvedValueOnce(makeCapEscalatePauseSummary(false));

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 裁决器派发（呈人参考）但无第二次 run（不 auto-trust——收敛失败停下叫人）。
    expect(countAdjudicatorCalls()).toBe(1);
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('【强难停点】');
    expect(result.output).toContain('未自动采信');
    // 链以 escalate-pause 滞留（快照保留——人决断驱动 resume）。
    expect(clearChainSnapshot).not.toHaveBeenCalled();
  });

  // ─── b2) cap 超限 + 'auto' + 去味门禁未过 → 终弃 ───

  it('cap 超限 + hardEscalate=auto + lintUnresolved（去味门禁未过机械代理）→ 终弃该章：clearChainSnapshot + 终弃上报 + 不产候选', async () => {
    writeReadyProject();
    setSession('auto', { gear: 'hands_off', trust: true, hardEscalate: 'auto' });
    runChapterChain.mockResolvedValueOnce(makeCapEscalatePauseSummary(true));

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 机械分派：不派裁决器、不 resume——终弃（清快照 + 上报，永不带病落盘）。
    expect(countAdjudicatorCalls()).toBe(0);
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(clearChainSnapshot).toHaveBeenCalledWith('leader-session-1');
    expect(result.output).toContain('【本章已终弃】');
    expect(result.output).toContain('去味门禁未过');
    const metadata = result.metadata as { type?: string };
    expect(metadata.type).toBeUndefined(); // 不产 chapter_accept / chapter_review
  });

  // ─── b3) cap 超限 + 'auto' + 去味门禁已过 → 采信终稿 ───

  it('cap 超限 + hardEscalate=auto + lint 干净 → 采信终稿：resume 续跑 + 「环未收敛」上报行 + 候选照常呈现', async () => {
    writeReadyProject();
    setSession('auto', { gear: 'hands_off', trust: true, hardEscalate: 'auto' });
    runChapterChain
      .mockResolvedValueOnce(makeCapEscalatePauseSummary(false))
      .mockResolvedValueOnce({
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '采信终稿' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '采信终稿' }, runId: 'r-cap' },
        errors: [],
      } satisfies RunSnapshotSummary);

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 机械分派（无裁决器）+ resume 续跑（E 段 + 完成收尾）+ 环未收敛上报。
    expect(countAdjudicatorCalls()).toBe(0);
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    const resumeOptions = runChapterChain.mock.calls[1][2] as { resume?: { fromSnapshot?: boolean } };
    expect(resumeOptions.resume).toEqual({ fromSnapshot: true });
    expect(result.output).toContain('【环未收敛·保守采信】');
    expect((result.metadata as { type?: string }).type).toBe('field_patch');
  });

  // ─── b4) 普通灰区 + 'auto' + 裁决器 null → 保守采信 ───

  it('普通灰区 + hardEscalate=auto + 裁决器 null（W0-7 机械信号）→ 保守采信：resume 续跑 + 环未收敛标注（不假 pass）', async () => {
    writeReadyProject();
    setSession('auto', { gear: 'hands_off', trust: true, hardEscalate: 'auto' });
    adjudicatorContent = 'not-json'; // parse 失败 → adjudication null
    runChapterChain
      .mockResolvedValueOnce({
        status: 'paused',
        escalatePause: true,
        routeDecision: { decision: 'escalate_user', reason: '灰区难断' },
        escalateFindings: FINDINGS,
        errors: [],
      } satisfies RunSnapshotSummary)
      .mockResolvedValueOnce({
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '保守采信' },
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '保守采信稿' }, runId: 'r-cons' },
        errors: [],
      } satisfies RunSnapshotSummary);

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(runChapterChain).toHaveBeenCalledTimes(2);
    expect(result.output).toContain('【环未收敛·保守采信】');
    expect((result.metadata as { type?: string }).type).toBe('field_patch');
  });

  // ─── c1) auto 档单次挂起 → 跳章+标记 ───

  it('auto 档单次挂起（R4 安全自决）→ 跳章+标记：clearChainSnapshot + 跳章文案 + 不产 chapter_review 卡', async () => {
    writeReadyProject();
    setSession('auto');
    runChapterChain.mockResolvedValueOnce(makeSuspensionPauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('【本章挂起');
    expect(result.output).toContain('安全自决跳过');
    // 跳章 = 链终态（快照清——恢复靠作者决断后重跑，非 resume 续跑）。
    expect(clearChainSnapshot).toHaveBeenCalledWith('leader-session-1');
    const metadata = result.metadata as { type?: string; resumeOptions?: string[] };
    expect(metadata.type).toBeUndefined(); // 不产 chapter_review（链已终态）
  });

  // ─── c2) suggest 档挂起 → 维持暂停叫人（现状零变化）───

  it('suggest 档挂起 → 维持暂停叫人：chapter_review 卡（redo/abort）+ 决断指引（不清快照）', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeSuspensionPauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('【本章挂起');
    expect(result.output).toContain('请核实以上证据后呈给作者决断');
    expect(clearChainSnapshot).not.toHaveBeenCalled();
    const metadata = result.metadata as { type?: string; resumeOptions?: string[] };
    expect(metadata.type).toBe('chapter_review');
    expect(metadata.resumeOptions).toEqual(['redo', 'abort']);
  });

  // ─── c3) 同章连续 ≥2 + 'ask' → 保持暂停叫人 ───

  it('auto 档同章连续挂起 ≥2 + hardEscalate=ask（缺省）→ 不再跳章：保持暂停叫人（快照保留 + chapter_review 卡）', async () => {
    writeReadyProject();
    setSession('auto');
    const { __resetSuspensionStreaks, peekSuspensionStreak } = await import('../src/tool/write-chapter');
    __resetSuspensionStreaks();
    runChapterChain.mockResolvedValue(makeSuspensionPauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    // 第一次挂起 → 跳章（streak=1，快照清）。
    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);
    expect(peekSuspensionStreak('leader-session-1', 'ep1')).toBe(1);
    // 第二次挂起（同章重跑后再挂）→ streak=2 + 'ask' → 强难停点：不再跳章。
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(peekSuspensionStreak('leader-session-1', 'ep1')).toBe(2);
    expect(result.output).toContain('第 2 次挂起');
    expect(result.output).toContain('不再自动跳章');
    expect(clearChainSnapshot).toHaveBeenCalledTimes(1); // 只第一次（跳章）清
    const metadata = result.metadata as { type?: string; resumeOptions?: string[] };
    expect(metadata.type).toBe('chapter_review'); // 强难保持暂停 → 审阅卡照产
    expect(metadata.resumeOptions).toEqual(['redo', 'abort']);
  });

  // ─── c4) 同章连续 ≥2 + 'auto' → 终弃 ───

  it('auto 档同章连续挂起 ≥2 + hardEscalate=auto → 终弃该章（终弃上报 + 不产候选）', async () => {
    writeReadyProject();
    setSession('auto', { hardEscalate: 'auto' });
    const { __resetSuspensionStreaks } = await import('../src/tool/write-chapter');
    __resetSuspensionStreaks();
    runChapterChain.mockResolvedValue(makeSuspensionPauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    // 第一次挂起 → 跳章（streak=1）。
    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);
    // 第二次挂起 → streak=2 + 'auto' → 终弃。
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('【本章已终弃】');
    expect(result.output).toContain('反复矛盾');
    const metadata = result.metadata as { type?: string };
    expect(metadata.type).toBeUndefined();
  });

  // ─── d) E 段失败注入（AC2c）：正文 post-hoc 落盘 + stale 上报 + 重提取指路 ───

  it('E 段失败（derivationStale）→ 正文 post-hoc 落盘（chapter_write）+ 【提取中断】上报 + 重提取指路', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeDerivationStaleSummary());
    // chapter_write mock tool（mirror write-chapter-story-sync 动态注册模式）。
    const { registry } = await import('../src/tool/registry');
    const chapterWriteExecute = vi.fn().mockResolvedValue({ title: 'mock', output: 'written' });
    registry.register({
      id: 'chapter_write',
      description: 'mock',
      parameters: z.object({}),
      execute: chapterWriteExecute,
    });

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 正文先落盘（已注册章 ch_001——ep1 index 0 → sort_order 0 唯一命中）。
    expect(chapterWriteExecute).toHaveBeenCalledTimes(1);
    const [writeParams] = chapterWriteExecute.mock.calls[0] as [{ chapterId: string; content: string }];
    expect(writeParams.chapterId).toBe('ch_001');
    expect(writeParams.content).toBe('终稿正文（提取中断前的定稿）');
    // 章标 stale 上报 + 重提取指路（永不静默——提取段错误如实转达）。
    expect(result.output).toContain('【提取中断】');
    expect(result.output).toContain('正文已先落盘');
    expect(result.output).toContain('重提取');
    expect(result.output).toContain('mock E failure');
  });

  it('E 段失败但章未注册（映射失败）→ 不落盘只上报（正文在摘要中未丢，如实指路）', async () => {
    writeReadyProject();
    // 覆写 project：novel.chapters 空（no-chapter 映射失败）。
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }], edges: [], lines: [] },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
      novel: { chapters: [] },
    }), 'utf8');
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeDerivationStaleSummary());
    const { registry } = await import('../src/tool/registry');
    const chapterWriteExecute = vi.fn().mockResolvedValue({ title: 'mock', output: 'written' });
    registry.register({
      id: 'chapter_write',
      description: 'mock',
      parameters: z.object({}),
      execute: chapterWriteExecute,
    });

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(chapterWriteExecute).not.toHaveBeenCalled();
    expect(result.output).toContain('【提取中断】');
    expect(result.output).toContain('正文仍在链快照与摘要中');
  });

  // ════════════════════════════════════════════════════════════════════════
  // CR 修复批（09-13 簇 3）：CR-8（cap 判定精确匹配）/ CR-15（streak 衰减窗 + 终弃清零）/
  // CR-16（hard-stop 文案按实际触发信号分派）。
  // ════════════════════════════════════════════════════════════════════════

  it('CR-8：规划环 cap error（brief-reviewer-node）+ route escalate → 不入自审环 cap 矩阵（普通灰区处置，无强难停点误触发）', async () => {
    writeReadyProject();
    setSession('auto', { gear: 'hands_off', trust: true }); // hardEscalate 缺省 'ask'
    runChapterChain.mockResolvedValueOnce({
      status: 'paused',
      escalatePause: true,
      routeDecision: { decision: 'escalate_user', reason: '灰区' },
      escalateFindings: FINDINGS,
      errors: ['loop cap (2) reached at "brief-reviewer-node"; forced escalate'], // 规划环 cap 标记
    } as RunSnapshotSummary);

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 修前 'loop cap' 子串匹配 → capExhausted=true + 'ask' → 强难信号误触发【强难停点】文案（错环：
    // 该 error 属规划环，处置应走 planEscalate 路径）。修后精确匹配 loop 节点 id → 普通灰区：
    // 派裁决器呈人参考 + 无强难停点文案。
    expect(countAdjudicatorCalls()).toBe(1);
    expect(runChapterChain).toHaveBeenCalledTimes(1);
    expect(result.output).not.toContain('【强难停点】');
    expect(result.output).not.toContain('自审环迭代上限耗尽');
    expect(result.output).not.toContain('环未收敛');
    expect(result.output).not.toContain('【本章已终弃】');
  });

  it('CR-16：cap 超限 + streak≥2 且 lint 干净（lintUnresolved 缺省）→ 终弃文案按实际信号（连续挂起，非「去味门禁未过」）+ streak 清零（CR-15）', async () => {
    writeReadyProject();
    setSession('auto', { gear: 'hands_off', trust: true, hardEscalate: 'auto' });
    const { __seedSuspensionStreak, peekSuspensionStreak } = await import('../src/tool/write-chapter');
    __seedSuspensionStreak('leader-session-1', 'ep1', 2); // 跨调用连续挂起计数（新鲜——衰减窗内）
    runChapterChain.mockResolvedValueOnce(makeCapEscalatePauseSummary(false)); // cap + lint 干净

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('【本章已终弃】');
    // 实际触发信号 = 同章连续挂起 2 次（lintUnresolved 缺省——不得误报「去味门禁未过（AI 味未清）」）。
    expect(result.output).toContain('同章连续出发核查挂起 2 次');
    expect(result.output).not.toContain('去味门禁未过');
    // CR-15①：终弃时 streak 清零——重跑从满额计数重启（否则章永久不可写）。
    expect(peekSuspensionStreak('leader-session-1', 'ep1')).toBe(0);
  });

  it('CR-15②：streak 条目超 24h → 过期清零后再计（新一次挂起不触发 hard-stop——「连续」按时间邻接判）', async () => {
    writeReadyProject();
    setSession('auto');
    const { __seedSuspensionStreak, peekSuspensionStreak } = await import('../src/tool/write-chapter');
    // 25h 前的旧挂起计数 2（跨月旧计数不应把新一次挂起直接顶到 hard-stop/终弃）。
    __seedSuspensionStreak('leader-session-1', 'ep1', 2, 25 * 60 * 60 * 1000);
    runChapterChain.mockResolvedValueOnce(makeSuspensionPauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 衰减后从 0 重计（next=1）→ 单次挂起跳章（非「第 2 次挂起」hard-stop / 终弃）。
    expect(result.output).toContain('安全自决跳过');
    expect(result.output).not.toContain('第 2 次挂起');
    expect(result.output).not.toContain('【本章已终弃】');
    expect(peekSuspensionStreak('leader-session-1', 'ep1')).toBe(1);
  });
});
