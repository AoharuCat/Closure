/**
 * Story 6.3 CR-6a（design §3 段① / D8）：non-auto mode info_release_map patch UI surfacing。
 *
 * write_chapter 在 non-auto mode（suggest/readonly，permissionMode !== 'auto'）下，Director 产出
 * info_release_map plan 后**不调写工具**（D8 不自动落盘），而是在 tool result metadata 挂
 * `infoReleasePatch = {type:'field_patch', field:'info_release_map', action:'set', data: mergedMap}`。
 * 该字段与链段 pause 的 `metadata.type='chapter_review'` 共存（两者不能同占 metadata.type，故走独立字段）。
 *
 * agentSessionSlice 的 tool-result 路由循环原本只读 `meta.type === 'field_patch'`（单 patch per result），
 * 不读 `metadata.infoReleasePatch` -> Director plan 不进 PatchReview。本测验证新增的 infoReleasePatch
 * 读取分支：surface 成 fieldPatchEntry（field='info_release_map', action='set'）-> setPendingPatch ->
 * PatchReviewPanel 可审阅。复用既有 creativeFieldsSlice.syncField('info_release_map') 持久化路径，
 * 无需新 UI 路径。
 *
 * 照 chapterReviewRouting.test.tsx 模式（full appStore + stream event emit）。
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

import { PatchReviewPanel } from '../src/features/agent-panel/PatchReviewPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';
import type { AgentStreamEvent } from '../src/shared/api/agent';

describe('Story 6.3 CR-6a - write_chapter infoReleasePatch metadata 路由', () => {
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

  it('write_chapter tool result 带 infoReleasePatch metadata -> pendingPatch 落 info_release_map entry（field=set）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-ir-1',
          results: [
            {
              toolCallId: 'call_ir_1',
              toolName: 'write_chapter',
              output: '已生成信息释放计划--等待你审阅后落盘。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                chapterId: 'ch_001',
                draftContent: '第一章草稿正文…',
                resumeOptions: ['continue', 'redo', 'abort'],
                infoReleasePatch: {
                  type: 'field_patch',
                  field: 'info_release_map',
                  action: 'set',
                  data: {
                    entries: [
                      {
                        id: 'ir_e1',
                        sceneRef: 'sc_1',
                        episodeId: 'ep1',
                        reveal: ['国王真意'],
                        withhold: ['暗杀计划'],
                        directive: {
                          mode: 'sustain_unknown',
                          actions: ['withhold'],
                          forbiddenMoves: ['不可透露暗杀者身份'],
                        },
                      },
                    ],
                    version: 3,
                  },
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    expect(pending!.patches).toHaveLength(1);
    const entry = pending!.patches[0];
    expect(entry.field).toBe('info_release_map');
    expect(entry.action).toBe('set');
    expect(entry.generatedBy).toBe('write_chapter');
    // data 透传（Director mergedMap）。
    expect((entry.data as { entries: unknown[]; version: number }).entries).toHaveLength(1);
    expect((entry.data as { version: number }).version).toBe(3);
    // fieldVersion = currentVersion(0) + 1（fieldMetadata 无既有 info_release_map 版本）。
    expect(entry.fieldVersion).toBe(1);
  });

  it('infoReleasePatch 与 chapter_review 共存 -> pausedReview 与 pendingPatch 同时落（两通道不互斥）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-ir-2',
          results: [
            {
              toolCallId: 'call_ir_2',
              toolName: 'write_chapter',
              output: '草稿暂停 + 信息释放计划待审。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                chapterId: 'ch_001',
                draftContent: '草稿…',
                resumeOptions: ['continue', 'redo', 'abort'],
                infoReleasePatch: {
                  type: 'field_patch',
                  field: 'info_release_map',
                  action: 'set',
                  data: { entries: [{ id: 'ir_e1', sceneRef: 'sc_1' }], version: 1 },
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    // chapter_review -> pausedReview（draft checkpoint review UI）。
    const paused = (useAppStore.getState().pausedReviewBySession[useAppStore.getState().agentSessionId ?? ''] ?? null);
    expect(paused).not.toBeNull();
    expect(paused?.type).toBe('chapter_review');
    expect(paused?.chapterId).toBe('ch_001');

    // infoReleasePatch -> pendingPatch（PatchReviewPanel creative field 审阅）。
    const pending = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null);
    expect(pending).not.toBeNull();
    expect(pending!.patches[0].field).toBe('info_release_map');
  });

  it('fieldMetadata 有既有 info_release_map 版本 -> fieldVersion = currentVersion + 1（版本递增）', async () => {
    useAppStore.setState({
      fieldMetadata: { info_release_map: { version: 5, source: 'user', locked: false, dependsOn: [], stale: false } } as any,
    });
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-ir-3',
          results: [
            {
              toolCallId: 'call_ir_3',
              toolName: 'write_chapter',
              output: '信息释放计划待审。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                resumeOptions: ['continue', 'redo', 'abort'],
                infoReleasePatch: {
                  type: 'field_patch',
                  field: 'info_release_map',
                  action: 'set',
                  data: { entries: [], version: 6 },
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    const entry = (useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null)!.patches[0];
    // currentVersion(5) + 1 = 6（递增，mirror 既有 field_patch 路径）。
    expect(entry.fieldVersion).toBe(6);
  });

  it('无 infoReleasePatch metadata -> 不 surface info_release_map patch（非回归）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-ir-4',
          results: [
            {
              toolCallId: 'call_ir_4',
              toolName: 'write_chapter',
              output: 'status: completed',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                resumeOptions: ['continue', 'redo', 'abort'],
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    // 无 infoReleasePatch -> pendingPatch 不落 info_release_map（auto mode Director 已持久化 / 无 Director 产出）。
    expect((useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null)).toBeNull();
  });

  it('infoReleasePatch surface 后 -> PatchReviewPanel 渲染 info_release_map 行（label + action + 工具）', async () => {
    useAppStore.setState({ agentSessionId: 'session-1' } as any);
    const sending = useAppStore.getState().sendAgentMessage('请写第 1 章');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitStreamEvent?.({
        type: 'tool',
        data: {
          id: 'tool-msg-ir-5',
          results: [
            {
              toolCallId: 'call_ir_5',
              toolName: 'write_chapter',
              output: '信息释放计划待审。',
              metadata: {
                type: 'chapter_review',
                stage: 'draft',
                resumeOptions: ['continue', 'redo', 'abort'],
                infoReleasePatch: {
                  type: 'field_patch',
                  field: 'info_release_map',
                  action: 'set',
                  data: { entries: [{ id: 'ir_e1', sceneRef: 'sc_1' }], version: 1 },
                },
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });
    await sending;

    render(<PatchReviewPanel />);
    // creative.tabs.info_release_map i18n label（zh-CN = 「信息释放图」）。
    expect(screen.getByText('信息释放图')).toBeTruthy();
    // action label（set = 「应用」in zh-CN creative.patch.set）。
    expect(screen.getByText('write_chapter')).toBeTruthy();
  });
});
