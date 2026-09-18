import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 2.2 WP-E：write_chapter route 终态 story-sync 反哺 applier 单测（design §5.5.2）。
//
// mock skillExecutor.runChapterChain（summary 携 storySync deliverable）+ runAgentWithExplicitSystem
// （role-aware：director 空 / adjudicator 可控）+ registry story_sync_apply mock tool
// （动态注册，mirror write-chapter-feedback-ledger registerFeedbackReadTool 模式）。验：
// (a) accept + suggest → story_sync_apply 调用不带 autoApply → envelope 组挂 metadata.storySyncPatches + 文案行；
// (b) accept + auto → 调用带 autoApply:true → applied 文案 + 不挂 storySyncPatches；
// (c) auto + 超 cap（9 条）→ 强制人审（调用不带 autoApply）+ 文案注明原因；
// (d) escalate 采信续跑完成（completed + escalate_user，W3：「随裁决材料」路径退役）→ 按档位分流
//     （E9 在裁决 accept 续跑后对终稿提取——链 completed 即裁决已采信，反哺与 accept 同路）；
// (e) 空 patches / 无 storySync → 零痕迹（不调工具、不挂 metadata、不添行）；
// (f) 工具未注册 → 不崩 tool，文案告知补丁未呈现（永不静默数据丢失）；
// (g) summarizeRunSnapshot deliverable 豁免：终态抽 story.sync（空 patches 不抽 / auto_revise 不抽）。

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

function setSession(mode: 'readonly' | 'suggest' | 'auto' | undefined): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  mockedGetSession.mockReturnValue({ permissionMode: mode } as SessionState);
}

/** 放手档 session（hands_off + trustAdjudication，3.5 语义转移后 auto-trust 的显式 opt-in 面）。 */
function setHandsOffSession(mode: 'readonly' | 'suggest' | 'auto'): void {
  mockedGetSession.mockReturnValue({
    permissionMode: mode,
    participationGear: 'hands_off',
    trustAdjudication: true,
  } as SessionState);
}

/** 一条合法 asset_cards merge patch（story-sync 输出形态）。 */
function makePatch(field: string, version = 2) {
  return {
    field,
    action: 'merge' as const,
    data: field === 'asset_cards'
      ? { id: 'card-9', type: 'faction', name: '天机阁' }
      : { premise: '灵气复苏（修订）' },
    fieldVersion: version,
    generatedBy: 'story-sync-agent',
  };
}

describe('write_chapter story-sync 反哺 applier（Story 2.2 WP-E）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-storysync-'));
    runChapterChain = vi.fn();
    runAgentWithExplicitSystem = vi.fn(async (_sid: string, role: string) => {
      if (role === 'director-agent') return { content: JSON.stringify({ infoRelease: [], emotionPoints: [] }) };
      return { content: '{}' };
    });
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn(), runAgentWithExplicitSystem },
    };
    mockedGetSession.mockReset();
    setSession('suggest');
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-08-16T00:00:00Z', updated_at: '2026-08-16T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }], edges: [], lines: [] },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    }), 'utf8');
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function makeAcceptSummary(patches?: unknown[]): RunSnapshotSummary {
    return {
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      ...(patches
        ? { storySync: { runId: 'run_1', chapterId: 'ch_7', summary: '提取新实体', patches: patches as RunSnapshotSummary['storySync'] extends undefined ? never : NonNullable<RunSnapshotSummary['storySync']>['patches'] } }
        : {}),
      errors: [],
    };
  }

  function makeEscalateSummary(patches: unknown[]): RunSnapshotSummary {
    return {
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: '灰区难断' },
      storySync: { runId: 'run_1', chapterId: 'ch_7', summary: '提取新实体', patches: patches as never },
      errors: [],
    };
  }

  /** 动态注册 mock story_sync_apply tool（mirror registerFeedbackReadTool 模式）。 */
  async function registerStorySyncTool(result: {
    applied?: boolean;
    patches?: Array<{ type: 'field_patch'; field: string; action: string; data: unknown; fieldVersion?: number }>;
    appliedFields?: string[];
    skipped?: Array<{ field: string; reason: string }>;
  }): Promise<ReturnType<typeof vi.fn>> {
    const { registry } = await import('../src/tool/registry');
    const execute = vi.fn().mockResolvedValue({
      title: 'story_sync_apply: mock',
      output: 'mock',
      metadata: { ok: true, ...result },
    });
    registry.register({ id: 'story_sync_apply', description: 'mock', parameters: z.object({}), execute });
    return execute;
  }

  // ─── a) accept + suggest → envelope 组挂 metadata ───

  it('accept + suggest → 调 story_sync_apply（无 autoApply）→ envelope 组挂 metadata.storySyncPatches + 文案行', async () => {
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([makePatch('asset_cards'), makePatch('world_setting')]));
    const execute = await registerStorySyncTool({
      patches: [
        { type: 'field_patch', field: 'asset_cards', action: 'set', data: [], fieldVersion: 3 },
        { type: 'field_patch', field: 'world_setting', action: 'set', data: { premise: 'x' }, fieldVersion: 1 },
      ],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterId: 'ch-7', chapterBrief: { goal: 'g' } }, ctx);

    expect(execute).toHaveBeenCalledTimes(1);
    const callParams = execute.mock.calls[0][0] as { autoApply?: boolean; patches: unknown[]; chapterNote?: string };
    expect(callParams.autoApply).toBeUndefined(); // suggest 不直落
    expect(callParams.patches).toHaveLength(2);
    expect(callParams.chapterNote).toContain('story-sync 提取');
    // CR-08-16-010：非数字 chapterId（'ch-7'）不套「第 N 章」模板——「章节 ch-7」非「第 ch-7 章」。
    expect(callParams.chapterNote).toBe('章节 ch-7 story-sync 提取');
    const meta = result.metadata as { storySyncPatches?: Array<{ field: string }> };
    expect(meta.storySyncPatches).toHaveLength(2);
    expect(meta.storySyncPatches!.map((e) => e.field)).toEqual(['asset_cards', 'world_setting']);
    expect(result.output).toContain('正文反哺');
  });

  // ─── b) accept + auto → autoApply 直落 ───

  it('accept + auto → 调用带 autoApply:true → applied 文案 + 不挂 storySyncPatches', async () => {
    setSession('auto');
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([makePatch('asset_cards')]));
    const execute = await registerStorySyncTool({ applied: true, appliedFields: ['asset_cards'] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const callParams = execute.mock.calls[0][0] as { autoApply?: boolean };
    expect(callParams.autoApply).toBe(true);
    const meta = result.metadata as { storySyncPatches?: unknown };
    expect(meta.storySyncPatches).toBeUndefined();
    expect(result.output).toContain('已自动落盘');
  });

  // ─── c) auto + 超 cap → 强制人审 ───

  it('auto + 9 条补丁（超 cap 8）→ 强制转人审（无 autoApply）+ 文案注明原因', async () => {
    setSession('auto');
    const patches = Array.from({ length: 9 }, () => makePatch('world_setting'));
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary(patches));
    const execute = await registerStorySyncTool({
      patches: [{ type: 'field_patch', field: 'world_setting', action: 'set', data: { premise: 'x' }, fieldVersion: 1 }],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const callParams = execute.mock.calls[0][0] as { autoApply?: boolean };
    expect(callParams.autoApply).toBeUndefined(); // 超 cap 不直落
    expect(result.output).toContain('强制转人工审阅');
    const meta = result.metadata as { storySyncPatches?: unknown[] };
    expect(meta.storySyncPatches).toHaveLength(1);
  });

  // ─── d) escalate 采信续跑完成 → 按档位分流（W3：「随裁决材料」路径退役）───
  //
  // 链流程重排 W3：裁决在终稿前、E9 story-sync 在裁决 accept 续跑后——summary 到达本入口层时
  // decision='escalate_user' 且 status='completed' 即裁决已采信（链已完成 = E9 已对终稿提取），
  // 反哺按正常档位分流，不再「随裁决材料」文字呈现不 stage。

  it('escalate 采信续跑完成（suggest）→ 调 story_sync_apply 转 envelope 人审（非随裁决材料退役路径）', async () => {
    runChapterChain.mockResolvedValueOnce(makeEscalateSummary([makePatch('asset_cards')]));
    const execute = await registerStorySyncTool({
      patches: [{ type: 'field_patch', field: 'asset_cards', action: 'set', data: [], fieldVersion: 3 }],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    // 收尾照常（E9 产物按档位转出，不静默丢弃）。
    expect(execute).toHaveBeenCalledTimes(1);
    const callParams = execute.mock.calls[0][0] as { autoApply?: boolean };
    expect(callParams.autoApply).toBeUndefined(); // suggest 档 envelope 人审
    const meta = result.metadata as { storySyncPatches?: Array<{ field: string }> };
    expect(meta.storySyncPatches).toHaveLength(1);
    expect(result.output).toContain('正文反哺');
    // 退役路径文案不再出现（旧形态：随裁决材料呈现 + 不自动落地指示）。
    expect(result.output).not.toContain('随灰区裁决材料');
    expect(result.output).not.toContain('不会自动落地');
  });

  it('escalate 采信续跑完成（auto）→ autoApply:true 直落（与 accept 同路）', async () => {
    setSession('auto');
    runChapterChain.mockResolvedValueOnce(makeEscalateSummary([makePatch('asset_cards')]));
    const execute = await registerStorySyncTool({ applied: true, appliedFields: ['asset_cards'] });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const callParams = execute.mock.calls[0][0] as { autoApply?: boolean };
    expect(callParams.autoApply).toBe(true);
    const meta = result.metadata as { storySyncPatches?: unknown };
    expect(meta.storySyncPatches).toBeUndefined();
    expect(result.output).toContain('已自动落盘');
  });

  // ─── d2) escalate + 放手采信 accept（check fix）→ 已转 accept 语义，反哺按 accept 落地 ───
  //
  // 回归锚：原 guard `decision !== 'accept_as_truth' && !isEscalate` 会把 escalate+autoTrustAccepted
  // （isEscalate=false）误判非终态 return null——放手档采信裁决器 accept 的整条反哺路径被静默丢弃
  // （design §5.5.2「escalate+放手采信 accept」正是反哺时机）。修后 decision=escalate_user 进入收尾，
  // isEscalate=false 走落盘逻辑。

  it('escalate + 放手采信 accept（suggest）→ 调 story_sync_apply 转 envelope 人审（非静默丢弃）', async () => {
    setHandsOffSession('suggest');
    runChapterChain.mockResolvedValueOnce({
      ...makeEscalateSummary([makePatch('asset_cards')]),
      escalateFindings: [{ severity: 'warn', quote: 'q', location: 'l', explanation: 'e' }],
    });
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'adjudicator-agent') {
        return {
          content: JSON.stringify({
            analysis: '正文偏离计划但更符合角色弧',
            recommendation: 'accept',
            recommendationReason: '正文比计划好',
            options: [
              { label: '接受为真相', reason: '保正文' },
              { label: '改稿', reason: '回计划' },
            ],
          }),
        };
      }
      if (role === 'director-agent') return { content: JSON.stringify({ infoRelease: [], emotionPoints: [] }) };
      return { content: '{}' };
    });
    const execute = await registerStorySyncTool({
      patches: [{ type: 'field_patch', field: 'asset_cards', action: 'set', data: [], fieldVersion: 3 }],
    });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(execute).toHaveBeenCalledTimes(1); // 转出未被静默丢弃
    const callParams = execute.mock.calls[0][0] as { autoApply?: boolean };
    expect(callParams.autoApply).toBeUndefined(); // suggest 档 envelope 人审
    const meta = result.metadata as { storySyncPatches?: Array<{ field: string }> };
    expect(meta.storySyncPatches).toHaveLength(1);
    expect(result.output).toContain('正文反哺');
    expect(result.output).not.toContain('随灰区裁决材料'); // 已采信非待裁决形态
  });

  // ─── e) 空 patches → 零痕迹 ───

  it('accept 但 storySync 空 patches → 不调工具 / 不挂 metadata / 无反哺文案（零痕迹）', async () => {
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const execute = await registerStorySyncTool({ applied: true });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(execute).not.toHaveBeenCalled();
    const meta = result.metadata as { storySyncPatches?: unknown };
    expect(meta.storySyncPatches).toBeUndefined();
    expect(result.output).not.toContain('正文反哺');
  });

  it('auto_revise（非终态；退役 status 防御形态）→ 不收尾（E9 在终稿后一次跑，非终态零反哺）', async () => {
    runChapterChain.mockResolvedValueOnce({
      status: 'auto_revise_pending',
      routeDecision: { decision: 'auto_revise', reason: '需修订' },
      storySync: { runId: 'run_1', chapterId: 'ch_7', summary: '提取', patches: [makePatch('asset_cards')] as never },
      errors: [],
    } as RunSnapshotSummary);
    const execute = await registerStorySyncTool({ applied: true });
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(execute).not.toHaveBeenCalled();
    expect(result.output).not.toContain('正文反哺');
  });

  // ─── f) 工具未注册 → 文案告知 ───

  it('accept + patches 但工具未注册（registry 空）→ 不崩 tool，文案告知补丁未呈现', async () => {
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([makePatch('asset_cards')]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('落盘工具暂不可用');
    const meta = result.metadata as { storySyncPatches?: unknown };
    expect(meta.storySyncPatches).toBeUndefined();
  });
});

// ─── summarizeRunSnapshot deliverable 豁免（Story 2.2 WP-E，终态抽 story.sync）───

describe('summarizeRunSnapshot storySync 豁免（Story 2.2 WP-E）', () => {
  it('route=accept_as_truth + story.sync 非空 patches → summary.storySync 透传', async () => {
    const { summarizeRunSnapshot } = await import('../src/runtime/chainRunner');
    const summary = summarizeRunSnapshot({
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
      artifacts: {
        route_decision: { decision: 'accept_as_truth', reason: '通过' },
        'story.sync': { runId: 'run_1', chapterId: 'ch_7', summary: '提取新实体', patches: [makePatch('asset_cards')] },
      },
    });
    expect(summary.storySync).toBeDefined();
    expect(summary.storySync!.patches).toHaveLength(1);
  });

  it('空 patches → 不抽（零痕迹，summary 不带空载荷）', async () => {
    const { summarizeRunSnapshot } = await import('../src/runtime/chainRunner');
    const summary = summarizeRunSnapshot({
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
      artifacts: {
        route_decision: { decision: 'accept_as_truth', reason: '通过' },
        'story.sync': { runId: 'run_1', chapterId: 'ch_7', summary: '无可提取', patches: [] },
      },
    });
    expect(summary.storySync).toBeUndefined();
  });

  it('route=auto_revise（非终态）→ 不抽（E9 在终稿后一次跑，环内中间轮零提取）', async () => {
    const { summarizeRunSnapshot } = await import('../src/runtime/chainRunner');
    const summary = summarizeRunSnapshot({
      status: 'auto_revise_pending',
      currentNodeId: 'route-agent',
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
      artifacts: {
        route_decision: { decision: 'auto_revise', reason: '需修订' },
        'story.sync': { runId: 'run_1', chapterId: 'ch_7', summary: '提取', patches: [makePatch('asset_cards')] },
      },
    });
    expect(summary.storySync).toBeUndefined();
  });

  it('route=escalate_user → 同样透传（W3：裁决采信续跑后 E9 产物按档位反哺）', async () => {
    const { summarizeRunSnapshot } = await import('../src/runtime/chainRunner');
    const summary = summarizeRunSnapshot({
      status: 'completed',
      currentNodeId: null,
      projectPath: '/p',
      completedNodes: [],
      pendingNodes: [],
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
      errors: [],
      artifacts: {
        route_decision: { decision: 'escalate_user', reason: '灰区' },
        'story.sync': { runId: 'run_1', chapterId: 'ch_7', summary: '提取', patches: [makePatch('world_setting')] },
      },
    });
    expect(summary.storySync).toBeDefined();
  });
});
