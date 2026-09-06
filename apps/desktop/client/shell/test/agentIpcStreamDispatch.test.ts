import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { handle, warn, info, error, handleGenerateTextMock, handleGenerateTextStreamMock } = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  handleGenerateTextMock: vi.fn(),
  handleGenerateTextStreamMock: vi.fn(),
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

// Partial mock of the agent package (mirror agentIpcTaskSlotWiring): the seam
// functions stay REAL — setGenerateTextFn installs the impl under test into the
// agent package's own module state, and the real `generate` is what drives it
// from outside the package. Only the heavyweight runtime factory is stubbed.
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return {
    ...actual,
    createWorkflowRuntime: vi.fn(() => ({ __stub: 'agentIpcStreamDispatch' })),
  };
});

// agentIpc only forwards tool executions through handleToolExecute — stub it so
// this file never pulls the full toolHandlers graph.
vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));

// Partial mock of the gateway: resolveModel etc. stay real; ONLY the two
// generate handlers are spied, so the assertions pin exactly which path the
// dispatch line (agentIpc generateTextImpl) selected.
vi.mock('../main/ipc/modelGatewayIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/modelGatewayIpc')>();
  return {
    ...actual,
    handleGenerateText: handleGenerateTextMock,
    handleGenerateTextStream: handleGenerateTextStreamMock,
  };
});

import { generate } from '@orison/desktop-agent';
import type { GenerationDelta, SessionMessage } from '@orison/desktop-agent';
import { registerAgentIpc } from '../main/ipc/agentIpc';
// 09-01 附件 B3：agentIpc 装配 agentImageParts 内核（防环注入缝——漏装配 = 生产图片全降级）。
import { __getAgentImagePartsCoreForTest } from '../main/ipc/agentImageParts';
import { prepareVisionImage } from '../main/research/visionAnalysis';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 1（流式缝分派 / design §2）：agentIpc 的 generateTextImpl 按
// callbacks?.onDelta 有无分派 handleGenerateTextStream / handleGenerateText。
// 经 agent 包真实 generate() 驱动已注入的 impl（端到端穿两条 seam）：
//   - 有 onDelta → 流式路径 + delta 回调原引用透传；
//   - 无 onDelta → 非流式路径，且流式 handler 零调用（既有调用点零回归）。
// 删掉 agentIpc 的分派 wiring（或写反条件）必须让本文件变红。
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES: SessionMessage[] = [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }];

describe('agentIpc 流式缝分派（dogfood T1 Stage 1）', () => {
  // Production registers once for the app lifetime (module `registered` guard)
  // — mirror that here: the generateTextImpl closure is installed once and each
  // test re-seeds the gateway mocks. Vitest isolates module state per file.
  beforeAll(() => {
    registerAgentIpc(() => null);
  });

  beforeEach(() => {
    handle.mockReset();
    handleGenerateTextMock.mockReset();
    handleGenerateTextStreamMock.mockReset();
  });

  it('有 onDelta → 走流式 handler，signal 与 onDelta 原引用透传，delta 直达调用方', async () => {
    handleGenerateTextStreamMock.mockImplementationOnce(
      async (_payload: unknown, _signal: AbortSignal | undefined, onDelta: (d: GenerationDelta) => void) => {
        onDelta({ type: 'reasoning', delta: '思' });
        onDelta({ type: 'text', delta: '你好' });
        return { model: 'm', text: '你好', reasoning: '思', finishReason: 'stop' };
      },
    );

    const received: GenerationDelta[] = [];
    const onDelta = (d: GenerationDelta) => received.push(d);
    const signal = new AbortController().signal;
    const result = await generate(MESSAGES, 'SYS', [], signal, { onDelta });

    // 分派：只打流式 handler，非流式零调用。
    expect(handleGenerateTextStreamMock).toHaveBeenCalledOnce();
    expect(handleGenerateTextMock).not.toHaveBeenCalled();

    // 透传：ref 哨兵 + 同一 signal + 同一 onDelta 引用（非包装副本）。
    const call = handleGenerateTextStreamMock.mock.calls[0];
    expect(call[0]).toMatchObject({ ref: { keyId: 'default', modelId: 'default' } });
    expect(call[1]).toBe(signal);
    expect(call[2]).toBe(onDelta);

    // delta 经 seam → impl → 调用方回调；终帧经既有 generate 映射（Stage 2 起 reasoning
    // 一并透传进 GenerateResult——runLoop 终帧 assistantMsg 消费）。
    expect(received).toEqual([
      { type: 'reasoning', delta: '思' },
      { type: 'text', delta: '你好' },
    ]);
    expect(result).toEqual({ content: '你好', toolCalls: undefined, finishReason: 'stop', reasoning: '思' });
  });

  it('无 onDelta → 走非流式 handler（恰好两参），流式 handler 零调用（零回归）', async () => {
    handleGenerateTextMock.mockResolvedValueOnce({ model: 'm', text: 'plain', finishReason: 'stop' });

    const signal = new AbortController().signal;
    const result = await generate(MESSAGES, 'SYS', [], signal);

    expect(handleGenerateTextMock).toHaveBeenCalledOnce();
    expect(handleGenerateTextStreamMock).not.toHaveBeenCalled();

    // 非流式调用形状与升级前一致：body + signal 恰两参。
    const call = handleGenerateTextMock.mock.calls[0];
    expect(call.length).toBe(2);
    expect(call[1]).toBe(signal);
    expect(result).toEqual({ content: 'plain', toolCalls: undefined, finishReason: 'stop' });
  });

  // 09-01 附件 B3：registerAgentIpc 装配 agentImageParts 防环注入内核——generateTextImpl
  // 保持纯分派不动（上一对用例钉分派），图片处理内核经 installAgentImagePartsCore 注入
  //（mirror setGenerateTextFn 形态）。漏装配时生产全图降级，此处钉死 wiring。
  it('registerAgentIpc 装配 agentImageParts 内核（prepareImage = 真 prepareVisionImage）', () => {
    const core = __getAgentImagePartsCoreForTest();
    expect(core).not.toBeNull();
    expect(core!.prepareImage).toBe(prepareVisionImage);
    expect(typeof core!.resolveModelRef).toBe('function');
    expect(typeof core!.readModelConfig).toBe('function');
    // CR-003a：转述进度广播发射器（全窗 webContents.send('image-relay-progress')）随内核装配。
    expect(typeof core!.notifyRelayProgress).toBe('function');
  });

  // dogfood R2 #7：车道过缝——agent 侧 GenerateOptions.lane 经 ipc-provider 序列化进
  // body.request.lane，随分派原样抵达两 handler（shell 网关再透传到 ProtocolCallContext，
  // 那一段由 modelGatewayIpc.test.ts 的 240s 窗口测试钉住）。删掉 ipc-provider 的 lane
  // 序列化（或分派丢 body 字段）必须让本测试变红。
  it('opts.lane:"background" → body.request.lane 抵达流式 handler；缺省不带 lane 字段', async () => {
    handleGenerateTextStreamMock.mockResolvedValueOnce({ model: 'm', text: 'bg', finishReason: 'stop' });
    await generate(MESSAGES, 'SYS', [], new AbortController().signal, { onDelta: () => {}, lane: 'background' });

    expect(handleGenerateTextStreamMock).toHaveBeenCalledOnce();
    expect(handleGenerateTextStreamMock.mock.calls[0][0]).toMatchObject({
      request: expect.objectContaining({ lane: 'background' }),
    });

    handleGenerateTextStreamMock.mockReset();
    handleGenerateTextStreamMock.mockResolvedValueOnce({ model: 'm', text: 'fg', finishReason: 'stop' });
    await generate(MESSAGES, 'SYS', [], new AbortController().signal, { onDelta: () => {} });

    // 缺省（leader 对话车道）lane 值为 undefined = interactive 语义零回归
    //（mirror thinking 字段形态：键占位、值 undefined——本缝为进程内直调，无 JSON 序列化）。
    const request = handleGenerateTextStreamMock.mock.calls[0][0].request as Record<string, unknown>;
    expect(request.lane).toBeUndefined();
  });
});
