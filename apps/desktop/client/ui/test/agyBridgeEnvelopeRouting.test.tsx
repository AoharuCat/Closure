/**
 * 子4 W6（design §7 Tier 2 / agent-tools 三处同步契约的桥侧等价断言）：桥车道
 * envelope 捕获层测试。
 *
 * bridgeExecutor 的持久化同构映射（design §5.6）把桥 turn 内工具步落成与 runLoop
 * 产物同构的 SessionMessage 对——assistant(toolCalls) + tool(toolResults)，metadata
 * （含 Tier 2 diff 家族的 field_patch envelope）随 tool result 透传。本文件按桥车道
 * 的**事件对形态**驱动全局分发器（handleAgentStreamEvent），断言：
 * - assistant(toolCalls) → tool(field_patch) 对 → pendingPatch surface（PatchReview 卡
 *   数据源）——WRITE_TOOLS 漏登任一工具时该 tool result 被静默丢弃（B01 盲区形态）；
 * - 末两例锚定 Tier 2 新登记件：info_release_map_update / promise_ledger_update 的
 *   envelope 此前不在 UI WRITE_TOOLS（handler 注释言明 intended 路径 = UI patch-review）
 *   ——bridge Tier 2 面把它们暴露进对话车道后必须可路由。
 */
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { useAppStore } from '../src/shared/store/appStore';
import { handleAgentStreamEvent, __clearAgentEventTracks } from '../src/shared/store/agentEvents';
import { __resetAgyBridgeStoreForTest } from '../src/shared/store/agyBridgeStore';
import type { AgentStreamEvent } from '../src/shared/api/agent';

describe('子4 Tier 2 - 桥车道 envelope 捕获（suggest 档主路径）', () => {
  const emitStreamEvent = (event: AgentStreamEvent): void => {
    const s = useAppStore.getState();
    handleAgentStreamEvent(useAppStore, {
      ...event,
      sessionId: s.agentSessionId ?? '',
      projectPath: s.currentProject?.path,
    });
  };

  /** 桥车道事件对形态（executor persistToolCallPair 同构）：assistant(toolCalls) → tool。 */
  const emitBridgeToolPair = (
    toolName: string,
    metadata: Record<string, unknown>,
    seq: string,
  ): void => {
    emitStreamEvent({
      type: 'assistant',
      data: {
        id: `assistant-bridge-${seq}`,
        content: '',
        toolCalls: [{ id: `call_${seq}`, name: toolName, arguments: '{}' }],
      },
    } as AgentStreamEvent);
    emitStreamEvent({
      type: 'tool',
      data: {
        id: `tool-bridge-${seq}`,
        results: [
          {
            toolCallId: `call_${seq}`,
            toolName,
            output: '已准备修改，等待作者审阅。',
            metadata,
          },
        ],
      },
    } as AgentStreamEvent);
  };

  beforeEach(() => {
    __clearAgentEventTracks();
    __resetAgyBridgeStoreForTest();
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
      reviewResuming: false,
      resolvedLocale: 'zh-CN',
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('桥车道 outline_update 对（assistant toolCalls + tool field_patch）→ pendingPatch surface', async () => {
    const sending = useAppStore.getState().sendAgentMessage('调整第一卷大纲');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitBridgeToolPair(
        'outline_update',
        {
          type: 'field_patch',
          field: 'outline',
          action: 'merge',
          data: { phases: [{ id: 'phase-1', title: '第一卷', scenes: [] }] },
        },
        'ou1',
      );
      await Promise.resolve();
    });
    await sending;

    const pending = useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null;
    expect(pending).not.toBeNull();
    expect(pending!.patches).toHaveLength(1);
    const entry = pending!.patches[0];
    expect(entry.field).toBe('outline');
    expect(entry.action).toBe('merge');
    expect(entry.generatedBy).toBe('outline_update');
    expect((entry.data as { phases: unknown[] }).phases).toHaveLength(1);
  });

  it('桥车道 info_release_map_update（Tier 2 新登记件）→ field=info_release_map entry', async () => {
    const sending = useAppStore.getState().sendAgentMessage('规划信息释放');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitBridgeToolPair(
        'info_release_map_update',
        {
          type: 'field_patch',
          field: 'info_release_map',
          action: 'set',
          data: { entries: [{ id: 'ie-1', secret: '身世', mode: 'withhold' }] },
        },
        'ir1',
      );
      await Promise.resolve();
    });
    await sending;

    const pending = useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null;
    expect(pending).not.toBeNull();
    const entry = pending!.patches[0];
    expect(entry.field).toBe('info_release_map');
    expect(entry.generatedBy).toBe('info_release_map_update');
    expect((entry.data as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('桥车道 promise_ledger_update（Tier 2 新登记件）→ field=promise_registry entry', async () => {
    const sending = useAppStore.getState().sendAgentMessage('登记一条承诺');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitBridgeToolPair(
        'promise_ledger_update',
        {
          type: 'field_patch',
          field: 'promise_registry',
          action: 'set',
          data: { promises: [{ id: 'pr-1', title: '复仇', status: 'open' }], beats: [] },
        },
        'pl1',
      );
      await Promise.resolve();
    });
    await sending;

    const pending = useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null;
    expect(pending).not.toBeNull();
    const entry = pending!.patches[0];
    expect(entry.field).toBe('promise_registry');
    expect(entry.generatedBy).toBe('promise_ledger_update');
  });

  it('非 WRITE_TOOLS 工具的桥消息对 → 不产 pendingPatch（toolId 门语义零回归）', async () => {
    const sending = useAppStore.getState().sendAgentMessage('查一下设定');
    await waitFor(() => expect(useAppStore.getState().agentSessionId).not.toBeNull());

    await act(async () => {
      emitBridgeToolPair(
        'query_story',
        { type: 'field_patch', field: 'outline', action: 'set', data: {} },
        'qs1',
      );
      await Promise.resolve();
    });
    await sending;

    const pending = useAppStore.getState().pendingPatchBySession[useAppStore.getState().agentSessionId ?? '']?.patch ?? null;
    expect(pending).toBeNull();
  });
});
