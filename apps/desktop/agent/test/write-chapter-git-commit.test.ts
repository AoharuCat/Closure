import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 7.4 Step 6：isomorphic-git 版本节点落地单测（R5/AC6 + R6/AC7 FR-293 精神）。
//
// 验 commitRevisionNode 两落地点：
// a) 环 B：auto mode + Director atomicEdits valid + scene_graph 落盘刷新 → git_commit 被调
//    （git_status 守卫 count>0 放行），message 含「结构编辑 (Director-atomic-edit)」；
// b) 环 A：auto mode + auto_revise redo 落定（autoReviseCount>0）→ git_commit 被调，
//    message 含「段落级保义改稿 (auto_revise)」+ findings 摘要（FR-293 可查回溯）；
// c) 首写（无修订无 atomic-edit）→ git_commit 不调（零回归——write_chapter / chain 既有行为）；
// d) git_status count=0（无 working tree 变更）→ git_commit 不调（防空 commit 噪音）。
//
// mock skillExecutor.runChapterChain（控制 summary）+ runAgentWithExplicitSystem（role-aware）+
// registry git_commit / git_status / scene_graph_update / feedback_ledger_read（mirror atomic-edit test 模式）。

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

function setSessionPermissionMode(mode: 'readonly' | 'suggest' | 'auto' | undefined): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  mockedGetSession.mockReturnValue({ permissionMode: mode } as SessionState);
}

describe('write_chapter Story 7.4 Step 6 git 版本节点落地', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-git-'));
    runChapterChain = vi.fn();
    runAgentWithExplicitSystem = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runAgentWithExplicitSystem,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
      },
    };
    setSessionPermissionMode('auto');
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function writeTwoEpisodeProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomLine: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: {
        nodes: [
          { id: 's1', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor' },
          { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
        ],
        edges: [],
        lines: [],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [
        { id: 'ep1', index: 0, title: '开篇' },
        { id: 'ep2', index: 1, title: '第二章' },
      ],
    }), 'utf8');
  }

  const SUMMARY_ACCEPT: RunSnapshotSummary = {
    status: 'completed',
    routeDecision: { decision: 'accept_as_truth', reason: '通过' },
    reviewVerdict: 'pass',
    draftTitle: '第二章',
    draftWordCount: 2000,
    errors: [],
  };

  const PREV_EP1_ENTRIES = [
    {
      episodeId: 'ep1',
      artifactKey: 'review.latest',
      payload: {
        verdict: 'pass',
        summary: '上章通过',
        dimensions: [
          { name: 'narrative-feature', findings: [{ severity: 'warn', quote: '中段太平无悬念', location: '段 3', explanation: '悬念不足', subClass: 'no-suspense' }] },
        ],
      },
      producedAt: '2026-08-12T00:00:00Z',
    },
  ];

  const DIRECTOR_WITH_ATOMIC = {
    entries: [],
    emotionPoints: [],
    emotionTarget: { emotion: '期待' },
    atomicEditProposals: [
      { op: { op: 'add_suspense', atSceneId: 's1', resolveTowardsSceneId: 's2' }, sourceIssueRef: 'no-suspense', rationale: '中段太平需悬念钩子' },
    ],
  };

  const DIRECTOR_EMPTY = {
    entries: [],
    emotionPoints: [],
    emotionTarget: { emotion: '期待' },
  };

  const PROJECTED_GRAPH = {
    nodes: [
      { id: 's1', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'core-anchor' },
      { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
      { id: 's_suspense', episodeId: 'ep2', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' },
    ],
    edges: [],
    lines: [],
    art_overrides: [],
    version: 0,
    updatedBy: 'agent',
  };

  /** 动态注册 mock tool 到 registry。 */
  async function registerTool(id: string, execute: ReturnType<typeof vi.fn>): Promise<void> {
    const { registry } = await import('../src/tool/registry');
    registry.register({ id, description: 'mock for test', parameters: z.object({}), execute });
  }

  /** 注册 git_commit + git_status（git_status 返 count 控制 commit 放行/跳过）。 */
  async function registerGitTools(statusCount: number): Promise<ReturnType<typeof vi.fn>> {
    const gitCommitExecute = vi.fn().mockResolvedValue({
      title: 'git_commit: mock',
      output: 'Committed: abc1234',
      metadata: { oid: 'abc1234' },
    });
    const gitStatusExecute = vi.fn().mockResolvedValue({
      title: 'git_status: mock',
      output: statusCount > 0 ? 'modified file' : 'Working tree clean.',
      metadata: { count: statusCount },
    });
    await registerTool('git_commit', gitCommitExecute);
    await registerTool('git_status', gitStatusExecute);
    return gitCommitExecute;
  }

  async function registerSceneGraphUpdateTool(): Promise<void> {
    const execute = vi.fn().mockImplementation(async (params: { autoApply?: boolean }) => {
      if (params.autoApply) {
        return { title: 'scene_graph_update: mock', output: 'Auto-applied', metadata: { applied: true, data: PROJECTED_GRAPH } };
      }
      return { title: 'scene_graph_update: mock', output: 'Awaiting review', metadata: { type: 'field_patch', field: 'scene_graph', action: 'set', data: PROJECTED_GRAPH } };
    });
    await registerTool('scene_graph_update', execute);
  }

  async function registerPromiseLedgerUpdateTool(): Promise<void> {
    const execute = vi.fn().mockResolvedValue({
      title: 'promise_ledger_update: mock',
      output: 'Auto-applied',
      metadata: { applied: true, promiseCount: 0, beatCount: 0 },
    });
    await registerTool('promise_ledger_update', execute);
  }

  async function registerFeedbackReadTool(entries: unknown[]): Promise<void> {
    const execute = vi.fn().mockResolvedValue({
      title: 'feedback_ledger_read: mock',
      output: 'mock',
      metadata: { ok: true, episodeId: 'ep1', count: entries.length, entries },
    });
    await registerTool('feedback_ledger_read', execute);
  }

  function mockSubAgents(directorResponse: string): void {
    runAgentWithExplicitSystem.mockImplementation((_sid, role) => {
      if (role === 'director-agent') return Promise.resolve({ content: directorResponse });
      return Promise.resolve({ content: '{}' });
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // a. 环 B：auto mode + Director atomicEdits valid + scene_graph 落盘 → git_commit 被调
  // ════════════════════════════════════════════════════════════════════════════

  it('环 B：auto mode + atomicEdits 落盘 + scene_graph 刷新 → git_commit 被调，message 含「结构编辑」', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify(DIRECTOR_WITH_ATOMIC));
    runChapterChain.mockResolvedValue(SUMMARY_ACCEPT);
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    await registerSceneGraphUpdateTool();
    await registerPromiseLedgerUpdateTool();
    const gitCommitExecute = await registerGitTools(3); // working tree 有变更

    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    // git_commit 被调一次（环 B 落地点：scene_graph 落盘后）。
    expect(gitCommitExecute).toHaveBeenCalledTimes(1);
    // message 含「结构编辑」+ 触发源。
    const commitArgs = gitCommitExecute.mock.calls[0];
    expect((commitArgs[0] as { message: string }).message).toContain('结构编辑');
    expect((commitArgs[0] as { message: string }).message).toContain('Director-atomic-edit');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // b. 环 A（auto_revise leader redo 落定 commit）已随 09-13 W1a 退役——链内回环取代 break 交
  //    leader，autoReviseCount/CR-004 splice 落盘收尾不再存在；修订落定的版本节点收口随新链
  //    落盘拆两步（F1a/F1b）归后续波次。环 B（atomic-edit 落盘 commit）/ 首写 / count=0 / 未注册
  //    四路径保持覆盖。
  // ════════════════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════════════════
  // c. 首写（无修订无 atomic-edit）→ git_commit 不调（零回归）
  // ════════════════════════════════════════════════════════════════════════════

  it('首写（accept 直接终态，无 auto_revise 无 atomic-edit）→ git_commit 不调（零回归）', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify(DIRECTOR_EMPTY)); // Director 无 atomicEditProposals
    runChapterChain.mockResolvedValue(SUMMARY_ACCEPT); // 直接 accept
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    const gitCommitExecute = await registerGitTools(0);

    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    // 无修订落定 → git_commit 不调（首写零回归）。
    expect(gitCommitExecute).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // d. git_status count=0（无 working tree 变更）→ git_commit 不调（防空 commit 噪音）
  // ════════════════════════════════════════════════════════════════════════════

  it('环 B atomicEdits 落盘但 git_status count=0（无 working tree 变更）→ git_commit 不调（防空 commit）', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify(DIRECTOR_WITH_ATOMIC));
    runChapterChain.mockResolvedValue(SUMMARY_ACCEPT);
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    await registerSceneGraphUpdateTool();
    await registerPromiseLedgerUpdateTool();
    // git_status 返 count=0（模拟 working tree clean——环 A redo 纯 in-memory 场景）。
    const gitCommitExecute = await registerGitTools(0);

    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    // git_status count=0 → commitRevisionNode skip（防空 commit 噪音）。
    expect(gitCommitExecute).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // e. git_commit 未注册（registry 空）→ graceful skip，链段照跑（mirror既有 graceful 模式）
  // ════════════════════════════════════════════════════════════════════════════

  it('git_commit 未注册（registry 仅 scene_graph_update）→ graceful skip，链段照跑', async () => {
    writeTwoEpisodeProject();
    mockSubAgents(JSON.stringify(DIRECTOR_WITH_ATOMIC));
    runChapterChain.mockResolvedValue(SUMMARY_ACCEPT);
    await registerFeedbackReadTool(PREV_EP1_ENTRIES);
    await registerSceneGraphUpdateTool();
    await registerPromiseLedgerUpdateTool();
    // 不注册 git_commit / git_status → commitRevisionNode graceful skip。

    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: '抵达 B 城' } }, ctx);

    // 链段照跑（不崩）。
    expect(result.output).toContain('status: completed');
  });
});
