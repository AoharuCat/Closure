/**
 * 09-12 子2 fallback chains W5：运行期模型可见性的 store 面测试。
 *
 * 覆盖（implement.md W5 清单）：
 * - agentEvents 'model-fallback' 分发：通知写入（cap 5）/ leader 车道 chip 翻转
 *   （activeModelBySession）/ 链车道 ChainRunState.modelSwitch（链卡 chip 数据源）+
 *   项目锚登记 / run 态活性。
 * - child 通道冒泡：inner model-fallback → 通知带子代理角色标签。
 * - chainStreamBuffer.applyChainModelFallback：无卡不建（delta 驱动建卡）/ 终态跳过。
 * - deleteAgentSession 清通知与 chip（随会话消亡）。
 * - AgentMessages 渲染面（通知条/当前模型 chip）在组件测试文件（jsdom 渲染）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent } from '../src/shared/api/agent';

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'sess-a', messages: [] })),
  fetchAgentSession: vi.fn(async () => ({ id: 'sess-a', status: 'idle', messages: [] })),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionParticipationGear: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => []),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import {
  handleAgentStreamEvent,
  MODEL_FALLBACK_NOTICE_CAP,
  type AgentDispatchState,
  type AgentStreamWireEvent,
} from '../src/shared/store/agentEvents';
import { applyChainModelFallback } from '../src/shared/store/chainStreamBuffer';
import { createAgentSessionSlice, type AgentSessionSlice } from '../src/shared/store/agentSessionSlice';
import { useAppStore } from '../src/shared/store/appStore';
import { __clearAgentStreamBuffers } from '../src/shared/store/agentStreamBuffer';

type SliceState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  resolvedLocale?: string;
  clearSessionPending: (sessionId: string) => void;
  clearPausedReviewFor: (sessionId: string) => void;
  clearPendingPatchFor: (sessionId: string) => void;
  /** 09-13 子3 W4：五审阅本地态键随会话消亡清理（deleteAgentSession 调用面）。 */
  clearReviewLocalStateFor: (sessionId: string) => void;
};

// 真跑 agentSessionSlice（清面/reset 面是真行为——mock 掉就没测到 forget 链），diff/patch/
// review 槽用结构面 stub（mirror agentEventsDispatch.test.ts 同款取舍）。
const useTestStore = create<SliceState & AgentDispatchState>()((...args) => ({
  currentProject: { path: 'C:\\proj\\a' },
  activeChapterId: null,
  resolvedLocale: 'zh-CN',
  clearSessionPending: vi.fn(),
  clearPausedReviewFor: vi.fn(),
  clearPendingPatchFor: vi.fn(),
  clearReviewLocalStateFor: vi.fn(),
  ...createAgentSessionSlice(...args),
}) as never);

function ev(event: AgentStreamEvent, sessionId: string, projectPath?: string): AgentStreamWireEvent {
  return { ...event, sessionId, ...(projectPath !== undefined ? { projectPath } : {}) };
}

const FROM = { keyId: 'k0', modelId: 'm0' };
const TO = { keyId: 'k1', modelId: 'm1' };
const SWITCH = { from: FROM, to: TO, reason: 'quota: HTTP 429: rate limited', attempt: 1 };

beforeEach(() => {
  __clearAgentStreamBuffers();
  (window as unknown as { orisonDesktop: unknown }).orisonDesktop = { abortAgentRun: vi.fn() };
  apiMocks.streamAgentMessage.mockClear();
  apiMocks.deleteAgentSession.mockClear();
  useTestStore.setState({
    agentSessionId: 'sess-a',
    agentMessages: [],
    activeSessionRunning: false,
    agentError: null,
    agentRunStates: {},
    chainRunBySession: {},
    chainRunAnchorByProject: {},
    modelFallbackNotices: {},
    activeModelBySession: {},
    currentProject: { path: 'C:\\proj\\a' },
  });
});

describe('model-fallback 事件分发（agentEvents）', () => {
  it('leader 车道（无 nodeId）→ 通知写入 + activeModelBySession 翻转为接管模型', () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'model-fallback', data: { ...SWITCH } } as AgentStreamEvent, 'sess-a', 'C:\\proj\\a'));

    const state = useTestStore.getState();
    expect(state.modelFallbackNotices['sess-a']).toHaveLength(1);
    expect(state.modelFallbackNotices['sess-a']![0]).toMatchObject(SWITCH);
    expect(state.modelFallbackNotices['sess-a']![0]!.scopeLabel).toBeUndefined();
    expect(state.activeModelBySession['sess-a']).toEqual(TO);
    // run 态活性同步（事件即「仍在跑」）。
    expect(state.agentRunStates['sess-a']?.phase).toBe('running');
  });

  it('链车道（带 nodeId）→ 链卡 modelSwitch 写入 + 项目锚登记；chip（activeModel）不翻', () => {
    // 先建卡（delta 驱动——切换可能先于首条 delta，但无卡时 applyChainModelFallback 防御跳过；
    // 有卡是生产主流路径）。
    handleAgentStreamEvent(useTestStore, ev({
      type: 'chain-delta',
      data: { nodeId: 'draft-writer-agent', role: 'draft-writer-agent', phase: 'writing', messageId: 'm1', delta: '文', seq: 0 },
    }, 'sess-a', 'C:\\proj\\a'));
    handleAgentStreamEvent(useTestStore, ev({
      type: 'model-fallback',
      data: { ...SWITCH, nodeId: 'draft-writer-agent', role: 'draft-writer-agent' },
    } as AgentStreamEvent, 'sess-a', 'C:\\proj\\a'));

    const state = useTestStore.getState();
    const run = state.chainRunBySession['sess-a'];
    expect(run?.modelSwitch).toMatchObject({ from: FROM, to: TO, nodeLabel: 'draft-writer' });
    // 通知带链节点标签（scopeLabel = chainNodeLabel 去后缀形态）。
    expect(state.modelFallbackNotices['sess-a']![0]!.scopeLabel).toBe('draft-writer');
    // leader chip 不翻（链车道归链卡，不污染对话占位 chip）。
    expect(state.activeModelBySession['sess-a']).toBeUndefined();
    // 项目锚登记（挂载门兜底）。
    const key = state.chainRunAnchorByProject && Object.keys(state.chainRunAnchorByProject)[0];
    expect(key).toBeTruthy();
  });

  it('child 通道冒泡 → 通知带子代理角色标签；chip 不翻', () => {
    useTestStore.setState({ agentSessionId: 'sess-a' });
    handleAgentStreamEvent(useTestStore, ev({
      type: 'child',
      data: {
        source: 'subagent',
        role: 'researcher-agent',
        sessionId: 'child-1',
        depth: 1,
        event: { type: 'model-fallback', data: { ...SWITCH } },
      },
    }, 'sess-a', 'C:\\proj\\a'));

    const state = useTestStore.getState();
    expect(state.modelFallbackNotices['sess-a']).toHaveLength(1);
    expect(state.modelFallbackNotices['sess-a']![0]!.scopeLabel).toBe('researcher-agent');
    expect(state.activeModelBySession['sess-a']).toBeUndefined();
  });

  it(`通知 cap ${MODEL_FALLBACK_NOTICE_CAP}：超出裁最旧`, () => {
    for (let i = 0; i < MODEL_FALLBACK_NOTICE_CAP + 3; i += 1) {
      handleAgentStreamEvent(useTestStore, ev({
        type: 'model-fallback',
        data: { ...SWITCH, attempt: i + 1 },
      }, 'sess-a', 'C:\\proj\\a'));
    }
    const notices = useTestStore.getState().modelFallbackNotices['sess-a']!;
    expect(notices).toHaveLength(MODEL_FALLBACK_NOTICE_CAP);
    expect(notices[0]!.attempt).toBe(4); // 最旧三条被裁
    expect(notices[notices.length - 1]!.attempt).toBe(8);
  });

  it('deleteAgentSession → 通知与 chip 随会话清（防悬空）', async () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'model-fallback', data: { ...SWITCH } } as AgentStreamEvent, 'sess-a', 'C:\\proj\\a'));
    expect(useTestStore.getState().modelFallbackNotices['sess-a']).toHaveLength(1);

    await useTestStore.getState().deleteAgentSession('sess-a');
    const state = useTestStore.getState();
    expect(state.modelFallbackNotices['sess-a']).toBeUndefined();
    expect(state.activeModelBySession['sess-a']).toBeUndefined();
  });

  it('sendAgentMessage → 回退通知与上下文占用 last 值随新 run 清（CR-14——stale bar 防线）', async () => {
    handleAgentStreamEvent(useTestStore, ev({ type: 'model-fallback', data: { ...SWITCH } } as AgentStreamEvent, 'sess-a', 'C:\\proj\\a'));
    useTestStore.setState({
      contextUsageBySession: {
        'sess-a': { usedTokens: 12345, windowTokens: 200000, redlinePercent: 95, updatedAt: 1 },
      },
    });
    expect(useTestStore.getState().contextUsageBySession['sess-a']).toBeDefined();

    await useTestStore.getState().sendAgentMessage('继续写');
    const state = useTestStore.getState();
    // 新 run 起：上一轮的切换记录与余量条一并清（新 run 首帧未到前不显示旧值）。
    expect(state.modelFallbackNotices['sess-a']).toBeUndefined();
    expect(state.contextUsageBySession['sess-a']).toBeUndefined();
  });
});

describe('applyChainModelFallback 防御面（chainStreamBuffer）', () => {
  it('无卡不建（建卡归 delta/步进事件——切换先到不抢跑出空卡）', () => {
    applyChainModelFallback(useTestStore as never, 'sess-b', { ...SWITCH, nodeId: 'draft-writer-agent' });
    expect(useTestStore.getState().chainRunBySession['sess-b']).toBeUndefined();
  });
});

// AgentMessages 的通知条/当前模型 chip 渲染断言在组件测试（jsdom）——本文件钉 store 面。
describe('AgentMessages 渲染面接线冒烟（真 appStore 查询形状）', () => {
  it('useAppStore 含 modelFallbackNotices / activeModelBySession 字段（slice 装配面）', () => {
    const s = useAppStore.getState();
    expect(typeof s.modelFallbackNotices).toBe('object');
    expect(typeof s.activeModelBySession).toBe('object');
  });
});
