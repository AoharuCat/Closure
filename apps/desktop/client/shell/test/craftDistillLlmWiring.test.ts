/**
 * E10.2b（task 09-05）W3.5：蒸馏 LLM 缝生产装配 wiring 测试（mirror materialLLMWiring.test.ts）。
 *
 * 钉死（craftDistillLlmCore.ts JSDoc 指定链）：
 * - 档位随 slot 路由：extraction（切条/归类——判别面温度 0）/ review-judge（冲突判定——语义
 *   裁判面温度 0.2，mirror lintIpc classify）；assignment → 窄引用直达环入口 payload.ref。
 * - 缺档/未注入 → default 哨兵 {keyId:'default',modelId:'default'}（环内 resolveModel 自动选择）。
 * - 思考策略随档（assignmentThinkingControl 镜像——非法值不注入）。
 * - maxTokens 调用方传入优先（切条 16384 独立核算——E10.2a CR-2 配套纪律）；缺省 belt 常量。
 * - finishReason 透传（CR-2——截断判定权威信号）。
 *
 * 09-12 子2（复核 H1 重接）：生产面改经网关环入口 handleGenerateText——mock 面从 protocol
 * generateText 换到环入口（resolveModel 已上移进环 per-attempt 解析，环行为在
 * modelGatewayFallbackLoop.test.ts 钉死，此处只钉「档位 → payload 组装」）。
 */
import { describe, expect, it, vi } from 'vitest';

const { resolveTaskModel, assignmentThinkingControl, assignmentFallbackChain, handleGenerateText } =
  vi.hoisted(() => ({
    resolveTaskModel: vi.fn(),
    assignmentThinkingControl: vi.fn(),
    // 09-12 子2：链投影 helper 缺省返 undefined（零链——本文件钉档位/组装面，链行为归
    // modelGatewayFallbackLoop.test.ts）。
    assignmentFallbackChain: vi.fn(() => undefined),
    handleGenerateText: vi.fn(),
  }));

vi.mock('@orison/desktop-agent', () => ({ resolveTaskModel, assignmentThinkingControl, assignmentFallbackChain }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({ handleGenerateText }));

import {
  CRAFT_DISTILL_DEFAULT_MAX_TOKENS,
  installCraftDistillLlmCoreProduction,
} from '../main/ipc/toolHandlers/craftDistillLlmCore';
import {
  __clearCraftDistillLlmCoreForTest,
  __getCraftDistillLlmCoreForTest,
} from '../main/ipc/toolHandlers/craftDistillPipeline';

/** 取第 i 次环入口调用的 payload（ref + request）。 */
function payloadAt(i: number): { ref: { keyId: string; modelId: string }; request: Record<string, unknown> } {
  return handleGenerateText.mock.calls[i]![0] as unknown as {
    ref: { keyId: string; modelId: string };
    request: Record<string, unknown>;
  };
}

describe('installCraftDistillLlmCoreProduction（生产装配链）', () => {
  it('extraction 档：档位 key + 窄引用 + 温度 0 + maxTokens 传入优先 + 思考随档', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue({ keyId: 'key-ext', modelId: 'extractor-x', thinking: 'low' });
    assignmentThinkingControl.mockReturnValue({ level: 'low' });
    handleGenerateText.mockImplementation(async () => ({ text: '[]' }));
    installCraftDistillLlmCoreProduction();
    const core = __getCraftDistillLlmCoreForTest()!;
    expect(core).not.toBeNull();

    const out = await core.generateText({ slot: 'extraction', system: 'SYS', user: 'USER', maxTokens: 16384 });
    expect(out).toEqual({ text: '[]' });
    expect(resolveTaskModel).toHaveBeenCalledWith('extraction');
    const { ref, request } = payloadAt(0);
    expect(ref).toEqual({ keyId: 'key-ext', modelId: 'extractor-x' });
    expect(request.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(request.temperature).toBe(0);
    expect(request.maxTokens).toBe(16384); // 调用方预算优先（切条独立核算不落缺省）
    expect(request.thinking).toEqual({ level: 'low' });
  });

  it('review-judge 档（冲突判定）：档位 key + 温度 0.2（语义裁判面，mirror lintIpc classify）+ 缺省 maxTokens belt', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    handleGenerateText.mockImplementation(async () => ({ text: '{"dispute":false,"reason":"r"}' }));
    installCraftDistillLlmCoreProduction();
    await __getCraftDistillLlmCoreForTest()!.generateText({ slot: 'review-judge', user: 'ONLY-USER' });

    expect(resolveTaskModel).toHaveBeenCalledWith('review-judge');
    // 缺档 → default 哨兵（环内 resolveModel 自动选择）。
    const { ref, request } = payloadAt(0);
    expect(ref).toEqual({ keyId: 'default', modelId: 'default' });
    expect(request.temperature).toBe(0.2);
    expect(request.maxTokens).toBe(CRAFT_DISTILL_DEFAULT_MAX_TOKENS); // 缺省 belt
    expect(request.messages).toEqual([{ role: 'user', content: 'ONLY-USER' }]); // system 缺省不占位
    expect('thinking' in request).toBe(false); // 无思考注入
  });

  it('finishReason 透传（CR-2）：协议层停因进 seam 返回——切条截断判定的权威信号', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installCraftDistillLlmCoreProduction();
    // 'length' = 输出被 token 上限截断（GenerationFinishReason）→ 透传。
    handleGenerateText.mockImplementation(async () => ({ text: '[{"condensed"', finishReason: 'length' }));
    const out = await __getCraftDistillLlmCoreForTest()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out.text).toBe('[{"condensed"');
    expect(out.finishReason).toBe('length');
    // 端点未回报停因 → undefined 透传（调用方无启发式回退——切条 JSON 截断必然解析失败）。
    handleGenerateText.mockImplementationOnce(async () => ({ text: '[]' }));
    const out2 = await __getCraftDistillLlmCoreForTest()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out2.finishReason).toBeUndefined();
  });
});

describe('teardown', () => {
  it('清装配内核（用例隔离——未装配态 = llm-unavailable 挂起路径）', () => {
    __clearCraftDistillLlmCoreForTest();
    expect(__getCraftDistillLlmCoreForTest()).toBeNull();
  });
});
