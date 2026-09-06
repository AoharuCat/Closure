import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

// 09-01 A3（AC6e 第三态）：附件已被发送消费 → description 异步回填守卫丢弃。
//
// 最小组合 store + vi.mock(api/agent) 模式（agentSessionBatchPassthrough.test.ts 先例）：
// sendAgentMessage 的会话创建/流 invoke 走 mock；inbox 附件 api 层（api/inboxAttachments）
// 不 mock——经 window.orisonDesktop 惰性取桥，per-test 安装。

const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  fetchAgentSession: vi.fn(),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionParticipationGear: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  truncateAgentSession: vi.fn(),
  listAgentSessions: vi.fn(async () => ({ sessions: [] })),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import { createAgentSessionSlice, type AgentSessionSlice } from '../src/shared/store/agentSessionSlice';

type TestState = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  clearSessionPending: ReturnType<typeof vi.fn>;
  clearPausedReviewFor: ReturnType<typeof vi.fn>;
  clearPendingPatchFor: ReturnType<typeof vi.fn>;
};

const useTestStore = create<TestState>()((...args) => ({
  currentProject: null,
  activeChapterId: null,
  clearSessionPending: vi.fn(),
  clearPausedReviewFor: vi.fn(),
  clearPendingPatchFor: vi.fn(),
  ...createAgentSessionSlice(...args),
}));

const PROJECT_PATH = 'I:/echo/project';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function seedState() {
  useTestStore.setState({
    currentProject: { path: PROJECT_PATH },
    agentSessionId: null,
    agentMessages: [],
    agentSessions: [],
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    sessionSwitching: false,
    draftSession: false,
    pendingAttachments: [],
    attachmentUploadStates: {},
  } as any);
}

function installBridge(overrides: Record<string, any> = {}): Record<string, any> {
  const bridge: Record<string, any> = {
    resolveInboxAttachment: vi.fn(async () => ({
      ok: true,
      contentHash: 'sha256:abc',
      mtime: 1_700_000_000_000,
      preview: '北境设定预览',
      derivedPath: 'inbox/大纲.md',
      reused: false,
    })),
    storeAttachmentDescription: vi.fn(async () => ({ ok: true, contentHash: 'sha256:x' })),
    generateText: vi.fn(async () => ({ model: 'm', text: '一份北境世界观设定大纲' })),
    readFile: vi.fn(async () => '第一章 北境的风……（正文）'),
    ...overrides,
  };
  (window as any).orisonDesktop = bridge;
  return bridge;
}

async function flushAsync(times = 6) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => { setTimeout(r, 0); });
  }
}

describe('AC6e 已发送三态：send 消费的附件不被回填', () => {
  beforeEach(() => {
    apiMocks.createAgentSession.mockReset();
    apiMocks.createAgentSession.mockImplementation(async () => ({
      id: 'session-new',
      agentName: 'writer',
      projectPath: PROJECT_PATH,
      status: 'idle',
      messages: [],
    }));
    apiMocks.streamAgentMessage.mockClear();
    apiMocks.streamAgentMessage.mockImplementation(async () => ({ status: 'completed' }));
    seedState();
  });

  it('backfill in flight when the message is sent → attachment consumed, description dropped, sidecar untouched', async () => {
    const gate = deferred<{ model: string; text: string }>();
    const bridge = installBridge({ generateText: vi.fn(() => gate.promise) });

    await useTestStore.getState().attachInboxMaterial('inbox/大纲.md', '大纲.md');
    const pending = useTestStore.getState().pendingAttachments;
    expect(pending).toHaveLength(1);
    expect((pending[0] as any).description).toBeUndefined();

    // 回填在途时发送（preview 兜底不阻塞 Send）——附件随消息消费 + 状态机清场。
    const sent = await useTestStore.getState().sendAgentMessage('基于附件写一段');
    expect(sent).toBe(true);
    await waitForEmpty();
    expect(useTestStore.getState().pendingAttachments).toHaveLength(0);
    expect(useTestStore.getState().attachmentUploadStates).toEqual({});
    expect(apiMocks.streamAgentMessage).toHaveBeenCalledTimes(1);

    gate.resolve({ model: 'm', text: '迟到的描述' });
    await flushAsync();

    // 已发送 → 不回填、不写 sidecar（守卫 = 附件已不在 pendingAttachments）。
    expect(useTestStore.getState().pendingAttachments).toHaveLength(0);
    expect(bridge.storeAttachmentDescription).not.toHaveBeenCalled();
  });

  it('attachment still pending → backfill lands on the attachment and sidecar write follows', async () => {
    const bridge = installBridge();

    await useTestStore.getState().attachInboxMaterial('inbox/大纲.md', '大纲.md');
    await flushAsync();

    const att = useTestStore.getState().pendingAttachments[0] as any;
    expect(att.description).toBe('一份北境世界观设定大纲');
    expect(typeof att.describedAt).toBe('number');
    // CR-013：写回 sidecar 带 capturedMtime（= resolve 返回的 mtime，即附件 fileMtime）——
    // shell 比对现盘更新即拒（TOCTOU 守卫）。
    expect(bridge.storeAttachmentDescription).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      filePath: 'inbox/大纲.md',
      description: '一份北境世界观设定大纲',
      capturedMtime: 1_700_000_000_000,
    });
  });
});

function waitForEmpty() {
  return vi.waitFor(() => {
    if (useTestStore.getState().pendingAttachments.length !== 0) throw new Error('not consumed yet');
  });
}
