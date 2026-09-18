import { describe, expect, it, vi } from 'vitest';

// E10.3a（task 09-05）W2：拆解 LLM 缝生产装配 wiring 测试（mirror craftDistillLlmWiring.test.ts）。
//
// 钉死（deconLlmCore.ts JSDoc 指定链）：
// - 档位随 slot 路由：extraction（P1a/P1b/P3a——判别面温度 0）/ review-judge（P1c 裁决/
//   P4 应答——语义裁判面温度 0.2）/ writer-draft（P5 读法/细批——**自钉 0.3 非创作温度**，F-17）；
//   assignment → 窄引用直达环入口 payload.ref。
// - 缺档/未注入 → default 哨兵 {keyId:'default',modelId:'default'}（环内 resolveModel 自动选择）。
// - 思考策略随档（assignmentThinkingControl 镜像——非法值不注入）。
// - maxTokens 调用方传入优先；缺省 belt 常量。
// - finishReason 透传（CR-2——截断判定权威信号）。
//
// 09-12 子2（复核 H1 重接）：生产面改经网关环入口 handleGenerateText——mock 面从 protocol
// generateText 换到环入口（resolveModel 已上移进环 per-attempt 解析，环行为在
// modelGatewayFallbackLoop.test.ts 钉死，此处只钉「档位 → payload 组装」）。

const { resolveTaskModel, assignmentThinkingControl, assignmentFallbackChain, handleGenerateText } =
  vi.hoisted(() => ({
    resolveTaskModel: vi.fn(),
    assignmentThinkingControl: vi.fn(),
    // 09-12 子2：链投影 helper 缺省返 undefined（零链）。
    assignmentFallbackChain: vi.fn(() => undefined),
    handleGenerateText: vi.fn(),
  }));

vi.mock('@orison/desktop-agent', () => ({ resolveTaskModel, assignmentThinkingControl, assignmentFallbackChain }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({ handleGenerateText }));

import {
  DECON_DEFAULT_MAX_TOKENS,
  __clearDeconLlmCoreForTest,
  getDeconLlmCore,
  installDeconLlmCoreProduction,
} from '../main/decon/deconLlmCore';

/** 取第 i 次环入口调用的 payload（ref + request）。 */
function payloadAt(i: number): { ref: { keyId: string; modelId: string }; request: Record<string, unknown> } {
  return handleGenerateText.mock.calls[i]![0] as unknown as {
    ref: { keyId: string; modelId: string };
    request: Record<string, unknown>;
  };
}

describe('installDeconLlmCoreProduction（生产装配链）', () => {
  it('extraction 档：档位 key + 窄引用 + 温度 0 + maxTokens 传入优先 + 思考随档', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue({ keyId: 'key-ext', modelId: 'decon-extractor-x', thinking: 'low' });
    assignmentThinkingControl.mockReturnValue({ level: 'low' });
    handleGenerateText.mockImplementation(async () => ({ text: '[]' }));
    installDeconLlmCoreProduction();
    const core = getDeconLlmCore()!;
    expect(core).not.toBeNull();

    const out = await core.generateText({ slot: 'extraction', system: 'SYS', user: 'USER', maxTokens: 16384 });
    expect(out).toEqual({ text: '[]' });
    expect(resolveTaskModel).toHaveBeenCalledWith('extraction');
    const { ref, request } = payloadAt(0);
    expect(ref).toEqual({ keyId: 'key-ext', modelId: 'decon-extractor-x' });
    expect(request.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(request.temperature).toBe(0);
    expect(request.maxTokens).toBe(16384); // 调用方预算优先（按缝输出量独立核算）
    expect(request.thinking).toEqual({ level: 'low' });
  });

  it('review-judge 档（P1c 裁决/P4 应答）：档位 key + 温度 0.2 + 缺省 maxTokens belt + default 哨兵链', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    handleGenerateText.mockImplementation(async () => ({ text: '{"same":true}' }));
    installDeconLlmCoreProduction();
    await getDeconLlmCore()!.generateText({ slot: 'review-judge', user: 'ONLY-USER' });

    expect(resolveTaskModel).toHaveBeenCalledWith('review-judge');
    // 缺档 → default 哨兵（环内 resolveModel 自动选择）。
    const { ref, request } = payloadAt(0);
    expect(ref).toEqual({ keyId: 'default', modelId: 'default' });
    expect(request.temperature).toBe(0.2);
    expect(request.maxTokens).toBe(DECON_DEFAULT_MAX_TOKENS); // 缺省 belt
    expect(request.messages).toEqual([{ role: 'user', content: 'ONLY-USER' }]); // system 缺省不占位
    expect('thinking' in request).toBe(false); // 无思考注入
  });

  it('writer-draft 档（P5 读法/细批）：自钉温度 0.3（F-17——分析性叙事报告非创作文本，不沿用创作温度）', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    handleGenerateText.mockImplementation(async () => ({ text: '# 读法' }));
    installDeconLlmCoreProduction();
    await getDeconLlmCore()!.generateText({ slot: 'writer-draft', user: 'U', maxTokens: 12000 });

    expect(resolveTaskModel).toHaveBeenCalledWith('writer-draft');
    const { request } = payloadAt(0);
    expect(request.temperature).toBe(0.3);
    expect(request.maxTokens).toBe(12000);
  });

  it('finishReason 透传（CR-2）：协议层停因进 seam 返回——截断判定权威信号', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installDeconLlmCoreProduction();
    // 'length' = 输出被 token 上限截断 → 透传（调用方 capped/失败挂起）。
    handleGenerateText.mockImplementation(async () => ({ text: '{"synopsis":', finishReason: 'length' }));
    const out = await getDeconLlmCore()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out.text).toBe('{"synopsis":');
    expect(out.finishReason).toBe('length');
    // 端点未回报停因 → undefined 透传。
    handleGenerateText.mockImplementationOnce(async () => ({ text: '[]' }));
    const out2 = await getDeconLlmCore()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out2.finishReason).toBeUndefined();
  });

  it('usage 透传（CR-13）：provider 计量进 seam 返回——cost 记账真值优先', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installDeconLlmCoreProduction();
    handleGenerateText.mockImplementation(async () => ({
      text: '[]',
      finishReason: 'stop',
      usage: { promptTokens: 1200, completionTokens: 80, totalTokens: 1280 },
    }));
    const out = await getDeconLlmCore()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out.usage).toEqual({ promptTokens: 1200, completionTokens: 80, totalTokens: 1280 });
    // 端点未回报 usage → undefined 透传（调用方回退字符近似 + estimated 标注）。
    handleGenerateText.mockImplementationOnce(async () => ({ text: '[]' }));
    const out2 = await getDeconLlmCore()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out2.usage).toBeUndefined();
  });

  it('setter 防环幂等：重复 install 覆盖同一内核引用（不叠加 handler）', () => {
    installDeconLlmCoreProduction();
    const first = getDeconLlmCore();
    installDeconLlmCoreProduction();
    expect(getDeconLlmCore()).toBe(first);
  });
});

describe('teardown', () => {
  it('清装配内核（用例隔离——未装配态 = llm-unavailable 挂起路径）', () => {
    __clearDeconLlmCoreForTest();
    expect(getDeconLlmCore()).toBeNull();
  });
});
