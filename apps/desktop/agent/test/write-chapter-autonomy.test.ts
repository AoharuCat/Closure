import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 4.3 Step 3：write_chapter tool mode wiring（permissionMode → CheckpointPolicy → runChapterChain options.mode）
// + paused summary → chapter_review metadata（design §3.5 / §3.6 / §4 映射表）。
//
// mock getSession（控制 leader session.permissionMode）+ skillExecutor.runChapterChain → 验：
// (a) permissionMode=suggest → mode.pauseStages=['draft']；
// (b) permissionMode=auto → mode.pauseStages=[]（零回归）；
// (c) permissionMode=readonly → mode.pauseStages=['brief','draft','verdict']；
// (d) session 缺 → 兜底 'suggest'；
// (e) paused summary（stage=draft）→ metadata.chapter_review shape（type/stage/draftContent/resumeOptions）；
// (f) paused summary（stage=brief）→ briefContent。

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  // 以下 session 函数 write_chapter 不用，但模块解析需存在（避免 import 出错）。
  loadSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  loadSessionMeta: vi.fn(),
}));

import { getSession } from '../src/agent/session';

const mockedGetSession = vi.mocked(getSession);

function setSessionPermissionMode(
  mode: 'readonly' | 'suggest' | 'auto' | undefined,
  gear: 'smart' | 'steer' | 'balanced' | 'hands_off' = 'smart',
  trust: boolean = false,
): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  // Story 3.5 CR-001 改造：auto-trust 闸改 gear+hands_off+trust 显式 opt-in（permissionMode 不再
  // 决定 auto-trust）。4.3 既有 auto-trust 测试需要补 gear 设置以保持语义可测。
  mockedGetSession.mockReturnValue({
    permissionMode: mode,
    participationGear: gear,
    trustAdjudication: trust,
  } as SessionState);
}

describe('write_chapter tool mode wiring（Story 4.3 Step 3）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-mode-'));
    runChapterChain = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn() },
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

  const SUMMARY_COMPLETED: RunSnapshotSummary = {
    status: 'completed',
    routeDecision: { decision: 'accept_as_truth', reason: '通过' },
    errors: [],
  };

  it('permissionMode=suggest → runChapterChain 收 mode.pauseStages=["final"]（W2 终稿人审）+ escalateMode="ask"', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(SUMMARY_COMPLETED);
    setSessionPermissionMode('suggest');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    const options = runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[]; escalateMode: string } };
    expect(options.mode).toBeDefined();
    expect(options.mode!.pauseStages).toEqual(['final']);
    expect(options.mode!.escalateMode).toBe('ask');
  });

  it('permissionMode=auto → mode.pauseStages=[]（零回归）+ escalateMode="auto-trust"', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(SUMMARY_COMPLETED);
    setSessionPermissionMode('auto');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const options = runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[]; escalateMode: string } };
    expect(options.mode!.pauseStages).toEqual([]);
    expect(options.mode!.escalateMode).toBe('auto-trust');
  });

  it('permissionMode=readonly → mode.pauseStages=["brief","final"]（W2：旧 draft/verdict 停点退役）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(SUMMARY_COMPLETED);
    setSessionPermissionMode('readonly');
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const options = runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[] } };
    expect(options.mode!.pauseStages).toEqual(['brief', 'final']);
  });

  it('session 缺（getSession 返 undefined）→ 兜底 suggest（pauseStages=["final"]，W2 映射）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(SUMMARY_COMPLETED);
    setSessionPermissionMode(undefined);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const options = runChapterChain.mock.calls[0][2] as { mode?: { pauseStages: string[] } };
    expect(options.mode!.pauseStages).toEqual(['final']); // 兜底 suggest
  });
});

describe('write_chapter tool paused summary → chapter_review metadata（Story 4.3 Step 3）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-paused-'));
    runChapterChain = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn() },
    };
    mockedGetSession.mockReset();
    setSessionPermissionMode('suggest');
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

  it('paused summary（stage=draft，含 draftContent）→ metadata.chapter_review shape + 不产 field_patch', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'paused',
      pausedStage: 'draft',
      draftContent: '黄昏的荒野上，主角深吸一口气。',
      errors: [],
    } as RunSnapshotSummary);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterId: 'ch_001', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // chapter_review metadata shape（mirror 4.6 chapter_accept→field_patch 模式）
    expect(result.metadata?.type).toBe('chapter_review');
    expect(result.metadata?.stage).toBe('draft');
    expect(result.metadata?.chapterId).toBe('ch_001');
    expect(result.metadata?.draftContent).toBe('黄昏的荒野上，主角深吸一口气。');
    expect(result.metadata?.resumeOptions).toEqual(['continue', 'redo', 'abort']);
    // paused 不产 field_patch（与 chapter_accept 互斥）
    expect(result.metadata?.field).toBeUndefined();
    expect(result.metadata?.action).toBeUndefined();
    // output 含 paused 文案
    expect(result.output).toContain('暂停');
    expect(result.output).toContain('redo');
  });

  it('paused summary（stage=brief）→ briefContent + stage=brief', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'paused',
      pausedStage: 'brief',
      briefContent: { goal: '抵达 B 城', tone: '紧张' },
      errors: [],
    } as RunSnapshotSummary);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    expect(result.metadata?.type).toBe('chapter_review');
    expect(result.metadata?.stage).toBe('brief');
    expect(result.metadata?.briefContent).toEqual({ goal: '抵达 B 城', tone: '紧张' });
    expect(result.metadata?.draftContent).toBeUndefined();
  });

  it('paused summary 无 chapterId param → metadata.chapterId 缺省', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'paused',
      pausedStage: 'draft',
      draftContent: '正文',
      errors: [],
    } as RunSnapshotSummary);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } }, // 不传 chapterId
      ctx,
    );

    expect(result.metadata?.type).toBe('chapter_review');
    expect(result.metadata?.chapterId).toBeUndefined();
  });

  it('completed summary（非 paused）→ 不产 chapter_review（现行 4.6 路径不动）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue({
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      errors: [],
    } as RunSnapshotSummary);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: 'g' } },
      ctx,
    );

    expect(result.metadata?.type).not.toBe('chapter_review');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Story 4.3 Step 6：escalate mode-gating（auto-trust vs ask，design §3.8）。
// auto-trust（全自动）→ 自动采信裁决器 recommendation（skip 人裁决 PatchReview）；
// ask（半自动/微操）→ 4.6 既有路径不动（PatchReviewPanel 人裁决）。
// 范式判据：mode-gating 分派 = 纯代码机械；recommendation = LLM 语义（4.6 不动）。
// ════════════════════════════════════════════════════════════════════════════

describe('write_chapter tool escalate mode-gating（Story 4.3 Step 6）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-step6-'));
    runChapterChain = vi.fn();
    runAgentWithExplicitSystem = vi.fn();
    ctx = {
      sessionId: 'leader-session-step6',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn(), runAgentWithExplicitSystem },
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

  const ESCALATE_SUMMARY: RunSnapshotSummary = {
    status: 'completed',
    routeDecision: { decision: 'escalate_user', reason: 'OOC 灰区' },
    reviewVerdict: 'escalate',
    draftText: '正文内容……',
    draftTitle: '第二章',
    draftWordCount: 2000,
    escalateFindings: [
      // CR-001 fix：升级 findings 用 'warn' 严重级——'block' 会触发 BLOCK 机械门（optIn 失效，
      // auto-trust 不触发任何配置）。这些测试要触发 auto-trust accept/revise/optIn-fail，须用 warn。
      { severity: 'warn', quote: '林动突然硬气', location: '段1句2', explanation: 'OOC 嫌疑' },
    ],
    chapter_accept: { chapterId: 'ch_001', candidate: { content: '正文…' }, runId: 'run_esc' },
    errors: [],
  };

  /** role-based mock：adjudicator 返 adjudication JSON。 */
  function mockAdjudicator(recommendation: 'accept' | 'revise'): void {
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'adjudicator-agent') {
        return {
          content: JSON.stringify({
            analysis: '硬气是角色弧推进',
            recommendation,
            recommendationReason: recommendation === 'accept' ? '倾向接受' : '倾向改稿',
            options: [
              { label: '改稿', reason: '破坏一致性' },
              { label: '接受为真相', reason: '角色弧推进' },
            ],
          }),
        };
      }
      return { content: '' };
    });
  }

  it('auto-trust + recommendation=accept → 全自动采信（field_patch 复用 accept 路径，不呈裁决建议块）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    // CR-001 fix：auto-trust 现显式 opt-in（hands_off + trust=true），permissionMode='auto' 不再决定。
    setSessionPermissionMode('auto', 'hands_off', true);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // 全自动采信文案（透明，非静默）
    expect(result.output).toContain('全自动采信');
    expect(result.output).toContain('接受为真相');
    expect(result.output).toContain('已按放手档');
    // 不重复呈裁决建议块（已采信，非 ask 模式 PatchReview 裁决）
    expect(result.output).not.toContain('选项（供你裁决）');
    // chapter_accept 复用 4.6 accept 路径 → field_patch metadata（持久化通道，复用 accept 路径）
    expect(result.metadata?.type).toBe('field_patch');
    expect(result.metadata?.field).toBe('chapter_candidate');
    expect((result.metadata?.data as { chapterId: string }).chapterId).toBe('ch_001');
    // runChapterChain 只调一次（accept 不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('auto-trust + recommendation=revise → 触发改稿重跑（runChapterChain 二次调，resume+redo+feedback）', async () => {
    writeReadyProject();
    // 第一次 escalate，第二次（redo）accept
    runChapterChain
      .mockResolvedValueOnce(ESCALATE_SUMMARY)
      .mockResolvedValueOnce({
        status: 'completed',
        routeDecision: { decision: 'accept_as_truth', reason: '改稿后通过' },
        draftTitle: '第二章（改）',
        draftWordCount: 2100,
        chapter_accept: { chapterId: 'ch_001', candidate: { content: '改后正文…' }, runId: 'run_redo' },
        errors: [],
      });
    mockAdjudicator('revise');
    // CR-001 fix：auto-trust 现显式 opt-in（hands_off + trust=true）。
    setSessionPermissionMode('auto', 'hands_off', true);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // runChapterChain 二次调（第一次原链段 escalate，第二次 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(2);
    // 第二次调用含 resume + redo directive（mirror redo，design §3.8）
    const redoOpts = runChapterChain.mock.calls[1][2] as {
      resume?: { fromSnapshot?: boolean };
      redo?: { nodeId: string; feedback?: string };
    };
    expect(redoOpts.resume?.fromSnapshot).toBe(true);
    expect(redoOpts.redo?.nodeId).toBe('draft-writer-agent');
    expect(redoOpts.redo?.feedback).toBe('硬气是角色弧推进'); // adjudication.analysis 作 feedback
    // 全自动采信改稿文案
    expect(result.output).toContain('全自动采信');
    expect(result.output).toContain('改稿');
    // redo 后 accept → field_patch（redo summary 的 chapter_accept）
    expect(result.metadata?.type).toBe('field_patch');
    expect((result.metadata?.data as { chapterId: string }).chapterId).toBe('ch_001');
  });

  it('auto-trust + 裁决器 parse 失败 → fallback 文本（不静默 accept，degrade 4.6 路径呈 findings）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    // adjudicator 返无法 parse 的内容（parseAdjudication → null）
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'adjudicator-agent') return { content: ' 裁决器迷因内容无法 parse ' };
      return { content: '' };
    });
    // CR-001 fix：auto-trust 现显式 opt-in（hands_off + trust=true）。
    setSessionPermissionMode('auto', 'hands_off', true);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // 放手采信失败文案（CR-001：标签从「全自动采信失败」改为「放手采信失败」——不静默 accept。
    expect(result.output).toContain('放手采信失败');
    expect(result.output).not.toContain('已按放手档');
    // degrade：findings 仍呈（4.6 既有路径，非假 pass）
    expect(result.output).toContain('林动突然硬气');
    // runChapterChain 只调一次（parse 失败不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });

  it('ask 模式（suggest）+ recommendation=accept → 4.6 既有路径不动（呈裁决建议，不 auto-trust）', async () => {
    writeReadyProject();
    runChapterChain.mockResolvedValue(ESCALATE_SUMMARY);
    mockAdjudicator('accept');
    // CR-001 fix：非 opt-in 默认（smart + trust=false）→ 不 auto-trust，走 ask 路径。
    setSessionPermissionMode('suggest', 'smart', false);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterBrief: { goal: '抵达 B 城' } },
      ctx,
    );

    // ask 模式：呈裁决建议（4.6 既有路径，PatchReviewPanel 人裁决）
    expect(result.output).toContain('灰区裁决器初审');
    expect(result.output).toContain('选项（供你裁决）');
    // 不含全自动采信文案（smart 非 opt-in 不 auto-trust）
    expect(result.output).not.toContain('已按放手档');
    expect(result.output).not.toContain('放手采信失败');
    // chapter_accept → field_patch（PatchReview 作裁决 UI，4.6 D4）
    expect(result.metadata?.type).toBe('field_patch');
    // runChapterChain 只调一次（ask 模式不 redo）
    expect(runChapterChain).toHaveBeenCalledTimes(1);
  });
});
