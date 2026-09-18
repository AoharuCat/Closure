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

  it('无 onDelta → 走非流式 handler（第 3 参 onFallback=undefined），流式 handler 零调用（零回归）', async () => {
    handleGenerateTextMock.mockResolvedValueOnce({ model: 'm', text: 'plain', finishReason: 'stop' });

    const signal = new AbortController().signal;
    const result = await generate(MESSAGES, 'SYS', [], signal);

    expect(handleGenerateTextMock).toHaveBeenCalledOnce();
    expect(handleGenerateTextStreamMock).not.toHaveBeenCalled();

    // 非流式调用形状：body + signal + onFallback（09-12 子2 后第 3 参常在——无回调时
    // undefined；语义回归门 = 非流式分派 + signal 引用不变，非 arity）。
    const call = handleGenerateTextMock.mock.calls[0];
    expect(call.length).toBe(3);
    expect(call[1]).toBe(signal);
    expect(call[2]).toBeUndefined();
    expect(result).toEqual({ content: 'plain', toolCalls: undefined, finishReason: 'stop' });
  });

  // 09-12 子2 fallback chains：onFallback 单独在场（非流式调用配链）→ 仍走非流式
  // handler，切换回调作第 3 参过缝（不依赖流式路径）。
  it('仅 onFallback（无 onDelta）→ 非流式 handler + onFallback 第 3 参透传（同 callbacks 对象族）', async () => {
    handleGenerateTextMock.mockResolvedValueOnce({ model: 'm', text: 'plain', finishReason: 'stop' });
    const signal = new AbortController().signal;
    const onFallback = vi.fn();
    await generate(MESSAGES, 'SYS', [], signal, { onFallback });

    expect(handleGenerateTextMock).toHaveBeenCalledOnce();
    expect(handleGenerateTextStreamMock).not.toHaveBeenCalled();
    const call = handleGenerateTextMock.mock.calls[0];
    expect(call.length).toBe(3);
    expect(call[2]).toBe(onFallback);
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

  // 09-12 agy provider（design §2 复核 M1 第三跳防线）：sessionKey 经 agent 侧
  // GenerateOptions → ipc-provider 序列化进 body.request.sessionKey → agentIpc 缝过
  // generateTextPayloadSchema 校验门（CR-16 后真 parse；两态归一双保险 = schema
  // transform + 装配侧 `|| undefined`）后原样抵达网关 handler（协议层 CLI 驱动器据此
  // 键控温进程）。删掉 ipc-provider 的 sessionKey 序列化必须让本测试变红。
  it('opts.sessionKey → body.request.sessionKey 抵达两 handler；缺省 undefined（单发冷路径）', async () => {
    handleGenerateTextStreamMock.mockResolvedValueOnce({ model: 'm', text: 's', finishReason: 'stop' });
    await generate(MESSAGES, 'SYS', [], new AbortController().signal, {
      onDelta: () => {},
      sessionKey: 'chain:sess-abc',
    });
    expect(handleGenerateTextStreamMock.mock.calls[0][0]).toMatchObject({
      request: expect.objectContaining({ sessionKey: 'chain:sess-abc' }),
    });

    handleGenerateTextMock.mockResolvedValueOnce({ model: 'm', text: 'n', finishReason: 'stop' });
    await generate(MESSAGES, 'SYS', [], new AbortController().signal, { sessionKey: 'leader:sess-1' });
    expect(handleGenerateTextMock.mock.calls[0][0]).toMatchObject({
      request: expect.objectContaining({ sessionKey: 'leader:sess-1' }),
    });

    // 缺省不带会话键（键占位、值 undefined——mirror lane/thinking 字段形态）。
    handleGenerateTextStreamMock.mockReset();
    handleGenerateTextStreamMock.mockResolvedValueOnce({ model: 'm', text: 'x', finishReason: 'stop' });
    await generate(MESSAGES, 'SYS', [], new AbortController().signal, { onDelta: () => {} });
    const request = handleGenerateTextStreamMock.mock.calls[0][0].request as Record<string, unknown>;
    expect(request.sessionKey).toBeUndefined();
  });

  // ── CR-16（09-12 子2 CR 批）：agent 缝 body 的 schema 校验门 ──
  // 此前 `as any` 直传使畸形载荷绕过 generateTextPayloadSchema 直达协议层；门语义 =
  // 畸形拒收（走既有错误路径）+ 指针形态 image part 豁免（归一在网关 resolveImageParts）。
  it('CR-16：坏 thinking 投影的回退条目 → generate reject（schema 拒收），两 handler 零调用', async () => {
    handleGenerateTextMock.mockResolvedValueOnce({ model: 'm', text: 'should not reach', finishReason: 'stop' });

    const signal = new AbortController().signal;
    await expect(
      generate(MESSAGES, 'SYS', [], signal, {
        // 运行时畸形（类型面 as never 直注——模拟装配层投影 bug 产出的坏条目）。
        fallbacks: [
          { ref: { keyId: 'k1', modelId: 'm1' }, thinking: { level: 'bogus' as never } },
        ],
      }),
    ).rejects.toThrow(/schema validation/);

    expect(handleGenerateTextMock).not.toHaveBeenCalled();
    expect(handleGenerateTextStreamMock).not.toHaveBeenCalled();
  });

  it('CR-16：指针形态 image part 豁免——带图消息原样（指针不剥）过缝抵达网关 handler', async () => {
    handleGenerateTextMock.mockResolvedValueOnce({ model: 'm', text: 'ok', finishReason: 'stop' });

    const pointerPart = {
      type: 'image' as const,
      image: { path: 'inbox/images/a.png', b64hash: 'sha-1', projectPath: 'C:\\proj\\a' },
    };
    const withImage: SessionMessage[] = [
      {
        id: 'm-img',
        role: 'user',
        content: '看这张图',
        createdAt: 1,
        images: [{ path: 'inbox/images/a.png', b64hash: 'sha-1', name: 'a.png', projectPath: 'C:\\proj\\a' }],
      },
    ];

    await generate(withImage, 'SYS', [], new AbortController().signal);

    expect(handleGenerateTextMock).toHaveBeenCalledOnce();
    const messages = (
      handleGenerateTextMock.mock.calls[0][0] as { request: { messages: Array<{ role: string; content: unknown }> } }
    ).request.messages;
    const imageMessage = messages.find((m) => Array.isArray(m.content));
    expect(imageMessage).toBeDefined();
    // 指针 part 逐字段原样过缝（b64/转述归一是网关 resolveImageParts 的职责，非缝门）。
    expect(imageMessage!.content).toEqual([{ type: 'text', text: '看这张图' }, pointerPart]);
  });
});
