/**
 * Story 4.3 Step 4（design §3.5 / §3.6）：write_chapter paused → chapter_review metadata 路由。
 *
 * agentSessionSlice 的 tool-result 路由循环在 WRITE_TOOLS gate 后，按 meta.type 分支：
 * - field_patch → setPendingPatch（4.1 chapter_candidate，已覆盖）。
 * - passage → pendingDiffs passage（rewrite_passage，已覆盖）。
 * - content → pendingDiffs chapter（chapter_write，已覆盖）。
 * - chapter_review（本 story 加）→ chapterReviewSlice.setPausedReview。
 *
 * 本测验证：write_chapter tool result 带 chapter_review metadata → pausedReview 落（ChapterReviewPanel
 * 可显示）；非 write tool 的 chapter_review → 不进（WRITE_TOOLS gate 防御）；无 metadata → 不误触。
 * 照 writeChapterTrigger.test.tsx section 2 模式（full appStore + stream event emit）。
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'session-1', messages: [] })),
  fetchAgentSession: vi.fn(),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => []),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import { ChapterReviewPanel } from '../src/features/writing/ChapterReviewPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';
import type { AgentStreamEvent } from '../src/shared/api/agent';

describe('Story 4.3 Step 4 — write_chapter chapter_review metadata 路由', () => {
  const emitStreamEvent = (event: AgentStreamEvent): void => {
  // dogfood T1 Stage 3：路由测试直驱全局分发器（事件带 sessionId+projectPath 进活跃分支）。
  const s = useAppStore.getState();
  handleAgentStreamEvent(useAppStore, {
    ...event,
    sessionId: s.agentSessionId ?? '',
    projectPath: s.currentProject?.path,
  });
};

  beforeEach(() => {
    __clearAgentEventTracks();
    apiMocks.streamAgentMessage.mockReset();
    apiMocks.createAgentSession.mockReset();
    apiMocks.createAgentSession.mockResolvedValue({ id: 'session-1', messages: [] });
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    (globalThis as any).window = globalThis.window ?? {};
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };

    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: '/proj', type: 'novel' },
      agentSessionId: null,
      agentMessages: [],
      activeSessionRunning: false,
      agentRunStates: {},
      agentError: null,
      agentMode: 'suggest',
      pendingPatchBySession: {},
                  fieldMetadata: {},
      pausedReviewBySession: {},
      reviewResumingBySession: {},
      resolvedLocale: 'zh-CN',
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('write_chapter tool result 带 chapter_review metadata → pausedReview 落（ChapterReviewPanel 可显示）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-1',
          results: [
            {
              toolCallId: 'call_1',
              toolName: 'write_chapter',
              output: '链段在 草稿 checkpoint 暂停，等待你审阅。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                chapterId: 'ch_001',
                draftContent: '第一章草稿正文…',
                resumeOptions: ['continue', 'redo', 'abort'],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const paused = (useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null);
    expect(paused).not.toBeNull();
    expect(paused?.type).toBe('chapter_review');
    expect(paused?.stage).toBe('draft');
    expect(paused?.chapterId).toBe('ch_001');
    expect(paused?.draftContent).toBe('第一章草稿正文…');
    expect(paused?.resumeOptions).toEqual(['continue', 'redo', 'abort']);
  });

  it('chapter_review metadata 落后 → ChapterReviewPanel 渲染 draft 正文 + 三动作', async () => {
    useAppStore.setState({ agentSessionId: 'session-1' } as any);
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-2',
          results: [
            {
              toolCallId: 'call_2',
              toolName: 'write_chapter',
              output: '草稿 checkpoint 暂停。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                draftContent: '渲染断言正文。',
                resumeOptions: ['continue', 'redo', 'abort'],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    render(<ChapterReviewPanel />);
    expect(screen.getByText('渲染断言正文。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续写' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '改稿重跑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '放弃' })).toBeTruthy();
  });

  it('非 write tool 的 chapter_review metadata → 不进 pausedReview（WRITE_TOOLS gate 防御）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('看一下');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-3',
          results: [
            {
              toolCallId: 'call_3',
              toolName: 'read_file',
              output: 'ok',
              metadata: { type: 'chapter_review', stage: 'draft', resumeOptions: ['continue', 'redo', 'abort'] },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    expect((useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // dogfood R2 #83/#84（2026-08-28）：写前挂起 pause 的载荷透传——chapter_review metadata 带
  // researchSuspension + resumeOptions=['redo','abort']（write_chapter 挂起分支产）时，dispatcher 须
  // 原样透传（旧实现两丢：硬编码三钮覆写 resumeOptions + 丢挂起载荷 → 挂起被渲染成可「继续写」的
  // 草稿审阅卡——continue 对挂起非法且不带偏离批准，用户被引导进死循环）。
  // ════════════════════════════════════════════════════════════════════════════

  it('#83/#84：chapter_review metadata 带 researchSuspension + resumeOptions（redo/abort）→ pausedReview 原样透传（不覆写三钮）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-susp',
          results: [
            {
              toolCallId: 'call_susp',
              toolName: 'write_chapter',
              output: '【本章挂起——出发核查发现任务卡与资料矛盾 / 写前偏离】',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                chapterId: 'ch_001',
                researchSuspension: {
                  kind: 'research_contradiction',
                  rounds: 1,
                  evidence: {
                    contradictions: [{ desc: '爽点底线 vs 女主第一章未登场', severity: 'contradiction' }],
                    deviations: [
                      { scene_ref: 's1', plan_says: '按大纲登场', brief_says: '延后登场', reason: 'pacing' },
                    ],
                  },
                },
                resumeOptions: ['redo', 'abort'],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const paused = (useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null);
    expect(paused?.researchSuspension?.kind).toBe('research_contradiction');
    expect(paused?.researchSuspension?.evidence?.deviations).toHaveLength(1);
    // resumeOptions 尊重载荷（无 continue——挂起恢复只有 redo）。
    expect(paused?.resumeOptions).toEqual(['redo', 'abort']);
  });

  it('write_chapter 无 metadata → pausedReview 不设（不误触 review 面板）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-4',
          results: [{ toolCallId: 'call_4', toolName: 'write_chapter', output: 'status: completed' }],
        },
      });
      await Promise.resolve();
    });
    await sending;

    expect((useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CR-003（Edge+Blind major）：stale pausedReview 清除——新 write_chapter 跑完未 pause
  // （completed/aborted/escalate）须清老 pausedReview，否则 chainSnapshot 单槽覆盖后跨章 resume
  // 用老 chapterId 映射错章。只 write_chapter 触发清/设（勿清 outline_update 等非 write_chapter 工具）。
  // ════════════════════════════════════════════════════════════════════════════

  it('CR-003：stale pausedReview 被 new write_chapter completed（field_patch metadata）清掉', async () => {
    // 预设 stale pausedReview（上一章 draft pause 残留）。
    useAppStore.setState({
      pausedReview: {
        type: 'chapter_review',
        stage: 'draft',
        chapterId: 'ch_OLD',
        draftContent: '上一章草稿…',
        resumeOptions: ['continue', 'redo', 'abort'],
      } as any,
    });
    const sending = useAppStore.getState().sendAgentMessage('请写第 2 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-cr003a',
          results: [
            {
              toolCallId: 'call_cr003a',
              toolName: 'write_chapter',
              output: 'status: completed',
              // completed accept → field_patch metadata（非 chapter_review）。
              metadata: {
                type: 'field_patch',
                field: 'chapter_candidate',
                action: 'set',
                data: { chapterId: 'ch_NEW', runId: 'r1', candidate: { content: '新章正文' } },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    // CR-003：新 write_chapter 非 paused → 清 stale pausedReview（避免跨章 resume 用老 chapterId=ch_OLD）。
    expect((useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  it('CR-003：stale pausedReview 被 new write_chapter 无 metadata 清掉（裸 completed）', async () => {
    useAppStore.setState({
      pausedReview: {
        type: 'chapter_review',
        stage: 'draft',
        chapterId: 'ch_OLD',
        resumeOptions: ['continue', 'redo', 'abort'],
      } as any,
    });
    const sending = useAppStore.getState().sendAgentMessage('请写第 2 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-cr003b',
          // 无 metadata 的 completed write_chapter（如链段 error/aborted 退出）。
          results: [{ toolCallId: 'call_cr003b', toolName: 'write_chapter', output: 'status: aborted' }],
        },
      });
      await Promise.resolve();
    });
    await sending;

    expect((useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null)).toBeNull();
  });

  it('CR-003：非 write_chapter 工具（outline_update）不清 pausedReview（只 write_chapter 触发清/设）', async () => {
    useAppStore.setState({
      pausedReviewBySession: {
        'session-1': {
          type: 'chapter_review',
          stage: 'draft',
          chapterId: 'ch_OLD',
          draftContent: '在审稿中…',
          resumeOptions: ['continue', 'redo', 'abort'],
        } as any,
      },
    });
    const sending = useAppStore.getState().sendAgentMessage('调整大纲');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-cr003c',
          // outline_update 是 WRITE_TOOL 但非 write_chapter → 不应清 pausedReview。
          results: [{
            toolCallId: 'call_cr003c',
            toolName: 'outline_update',
            output: 'ok',
            metadata: { type: 'field_patch', field: 'episode_outlines', action: 'set', data: {} },
          }],
        },
      });
      await Promise.resolve();
    });
    await sending;

    // 非 write_chapter 工具不触碰 pausedReview（review 仍在待用户裁决）。
    expect((useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null)).not.toBeNull();
    expect((useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null)?.chapterId).toBe('ch_OLD');
  });

  it('CR-003：同一 batch write_chapter paused（chapter_review）仍正常设 pausedReview（清逻辑不误伤 set）', async () => {
    // 预设 stale + 新 write_chapter 产 chapter_review → 应替换为新的（非清）。
    useAppStore.setState({
      pausedReview: {
        type: 'chapter_review',
        stage: 'brief',
        chapterId: 'ch_OLD',
        resumeOptions: ['continue', 'redo', 'abort'],
      } as any,
    });
    const sending = useAppStore.getState().sendAgentMessage('请写第 2 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-cr003d',
          results: [
            {
              toolCallId: 'call_cr003d',
              toolName: 'write_chapter',
              output: '草稿 checkpoint 暂停。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                chapterId: 'ch_NEW',
                draftContent: '新草稿…',
                resumeOptions: ['continue', 'redo', 'abort'],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    // chapter_review metadata → setPausedReview 替换为新的（chapterId=ch_NEW，非清 null）。
    const paused = (useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null);
    expect(paused).not.toBeNull();
    expect(paused?.chapterId).toBe('ch_NEW');
    expect(paused?.stage).toBe('draft');
  });

  it('brief stage chapter_review metadata → pausedReview 落 briefContent（不崩）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-5',
          results: [
            {
              toolCallId: 'call_5',
              toolName: 'write_chapter',
              output: 'brief checkpoint 暂停。',
              metadata: {
                type: 'chapter_review',
                stage: 'brief',
                briefContent: { goal: '建立危机' },
                resumeOptions: ['continue', 'redo', 'abort'],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const paused = (useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null);
    expect(paused?.stage).toBe('brief');
    expect(paused?.briefContent).toEqual({ goal: '建立危机' });
  });

  // KD2：readonly（微操）模式是 pause 密度最高的模式（brief+draft+verdict 全 checkpoint 停）。
  // chapter_review 是 review 载荷（非 write 应用），须在 readonly gate 之外恒路由——否则微操模式
  //（最需 review 面板的模式）panel 永远不显示。write_chapter 是 read-class（toolPolicy 不阻断）。
  it('readonly 模式下 chapter_review metadata 仍路由（微操模式 pause 密度最高，不能丢）', async () => {
    useAppStore.setState({ agentMode: 'readonly' } as any);
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-6',
          results: [
            {
              toolCallId: 'call_6',
              toolName: 'write_chapter',
              output: '草稿 checkpoint 暂停。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                draftContent: '微操模式下的草稿。',
                resumeOptions: ['continue', 'redo', 'abort'],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const paused = (useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null);
    expect(paused).not.toBeNull();
    expect(paused?.stage).toBe('draft');
    expect(paused?.draftContent).toBe('微操模式下的草稿。');
  });
});
