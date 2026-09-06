import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const { handle, warn, info, error, send, runtimeState } = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  send: vi.fn(),
  runtimeState: {
    session: { id: 's-pp', projectPath: 'C:/proj/alpha' } as { id: string; projectPath: string } | undefined,
    streamError: null as Error | null,
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info, error }) }));

// Fake runtime：只实现 stream-message handler 需要的面（getSession / streamMessage），
// 其余 seam（setGenerateTextFn 等）走真实 agent 包（mirror agentIpcStreamDispatch mock 形态）。
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return {
    ...actual,
    createWorkflowRuntime: vi.fn(() => ({
      getSession: vi.fn(() => runtimeState.session),
      streamMessage: vi.fn(async (input: { sendEvent: (event: unknown) => void }) => {
        if (runtimeState.streamError) throw runtimeState.streamError;
        input.sendEvent({ type: 'done', data: { status: 'completed' } });
      }),
    })),
  };
});

vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));
// 09-01 附件 B3：agentIpc 现额外 import resolveModel（agentImageParts 内核装配）+
// visionAnalysis/agentImageParts 入图（import readModelConfigFromDisk/generateText）——
// 工厂 mock 必须同步被引出的全部导出（缺即 vitest 假红，spec ipc-handlers 沉淀）。
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  handleGenerateText: vi.fn(),
  handleGenerateTextStream: vi.fn(),
  resolveModel: vi.fn(),
}));
vi.mock('../main/ipc/configIpc', () => ({
  readTaskModelSlots: vi.fn(() => undefined),
  readModelConfigFromDisk: vi.fn(() => ({ keys: [] })),
}));

import { registerAgentIpc } from '../main/ipc/agentIpc';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 2（design §3.1 / r7 坑 2 解法 a）：agent:stream-event payload 补
// projectPath——store 级全局监听（S3）项目隔离的硬前提。删掉 sendEvent 的 projectPath
// 字段必须让本文件变红。Preload/UI 消费不动（additive 字段）。
// ─────────────────────────────────────────────────────────────────────────────

// Production registers once for the app lifetime (module `registered` guard) —
// mirror agentIpcStreamDispatch: register once, then drive the captured handler.
registerAgentIpc(() => ({ webContents: { send } } as unknown as BrowserWindow));

function getStreamMessageHandler() {
  const registration = handle.mock.calls.find(([channel]) => channel === 'agent:stream-message');
  expect(registration).toBeDefined();
  return registration![1] as (
    _event: unknown,
    input: { sessionId: string; content: string },
  ) => Promise<{ status: string; message?: string }>;
}

describe('agentIpc stream-event payload（dogfood T1 Stage 2 projectPath）', () => {
  beforeEach(() => {
    send.mockReset();
    runtimeState.session = { id: 's-pp', projectPath: 'C:/proj/alpha' };
    runtimeState.streamError = null;
  });

  it('sendEvent payload 带 sessionId + projectPath（会话在内存即解析一次）', async () => {
    const result = await getStreamMessageHandler()({}, { sessionId: 's-pp', content: 'hi' });

    expect(result).toEqual({ status: 'completed' });
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'done',
      data: { status: 'completed' },
      sessionId: 's-pp',
      projectPath: 'C:/proj/alpha',
    });
  });

  it('会话不在内存 → projectPath 为 undefined（payload 仍含字段；错误路径同款）', async () => {
    runtimeState.session = undefined;
    runtimeState.streamError = new Error('session not found');

    const result = await getStreamMessageHandler()({}, { sessionId: 's-missing', content: 'hi' });

    expect(result.status).toBe('error');
    expect(send).toHaveBeenCalledWith('agent:stream-event', {
      type: 'error',
      data: { message: 'session not found' },
      sessionId: 's-missing',
      projectPath: undefined,
    });
  });
});
