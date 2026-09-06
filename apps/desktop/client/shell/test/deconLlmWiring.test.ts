import { describe, expect, it, vi } from 'vitest';

// E10.3a（task 09-05）W2：拆解 LLM 缝生产装配 wiring 测试（mirror craftDistillLlmWiring.test.ts）。
//
// 钉死（deconLlmCore.ts JSDoc 指定链）：
// - 档位随 slot 路由：extraction（P1a/P1b/P3a——判别面温度 0）/ review-judge（P1c 裁决/
//   P4 应答——语义裁判面温度 0.2）/ writer-draft（P5 读法/细批——**自钉 0.3 非创作温度**，F-17）；
//   assignment → resolveModel 收窄引用。
// - 缺档/未注入 → default 哨兵 {keyId:'default', modelId:'default'} → resolveModel 自动选择。
// - 思考策略随档（assignmentThinkingControl 镜像——非法值不注入）。
// - maxTokens 调用方传入优先；缺省 belt 常量。
// - finishReason 透传（CR-2——截断判定权威信号）。

const { resolveTaskModel, assignmentThinkingControl, resolveModel, generateText, readModelConfigFromDisk } =
  vi.hoisted(() => ({
    resolveTaskModel: vi.fn(),
    assignmentThinkingControl: vi.fn(),
    resolveModel: vi.fn(),
    generateText: vi.fn(),
    readModelConfigFromDisk: vi.fn(),
  }));

vi.mock('@orison/desktop-agent', () => ({ resolveTaskModel, assignmentThinkingControl }));
vi.mock('@orison/model-protocols', () => ({ generateText }));
vi.mock('../main/ipc/configIpc', () => ({ readModelConfigFromDisk }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({ resolveModel }));

import {
  DECON_DEFAULT_MAX_TOKENS,
  __clearDeconLlmCoreForTest,
  getDeconLlmCore,
  installDeconLlmCoreProduction,
} from '../main/decon/deconLlmCore';

function stubResolvedModel() {
  return {
    keyId: 'key-ext',
    modelId: 'decon-extractor-x',
    protocol: 'openai-compatible' as const,
    baseUrl: 'http://endpoint.example.com/v1',
    apiKey: 'sk-stub',
    capability: 'text' as const,
  };
}

describe('installDeconLlmCoreProduction（生产装配链）', () => {
  it('extraction 档：档位 key + 窄引用 + 温度 0 + maxTokens 传入优先 + 思考随档', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue({ keyId: 'key-ext', modelId: 'decon-extractor-x', thinking: 'low' });
    assignmentThinkingControl.mockReturnValue({ level: 'low' });
    resolveModel.mockImplementation(() => stubResolvedModel());
    generateText.mockImplementation(async () => ({ text: '[]' }));
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    installDeconLlmCoreProduction();
    const core = getDeconLlmCore()!;
    expect(core).not.toBeNull();

    const out = await core.generateText({ slot: 'extraction', system: 'SYS', user: 'USER', maxTokens: 16384 });
    expect(out).toEqual({ text: '[]' });
    expect(resolveTaskModel).toHaveBeenCalledWith('extraction');
    expect(resolveModel).toHaveBeenCalledWith(
      { keyId: 'key-ext', modelId: 'decon-extractor-x' },
      readModelConfigFromDisk(),
    );
    const [modelArg, reqArg] = generateText.mock.calls[0] as unknown as [
      ReturnType<typeof stubResolvedModel>,
      Record<string, unknown>,
    ];
    expect(modelArg.modelId).toBe('decon-extractor-x');
    expect(reqArg.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(reqArg.temperature).toBe(0);
    expect(reqArg.maxTokens).toBe(16384); // 调用方预算优先（按缝输出量独立核算）
    expect(reqArg.thinking).toEqual({ level: 'low' });
  });

  it('review-judge 档（P1c 裁决/P4 应答）：档位 key + 温度 0.2 + 缺省 maxTokens belt + default 哨兵链', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    resolveModel.mockImplementation(() => stubResolvedModel());
    generateText.mockImplementation(async () => ({ text: '{"same":true}' }));
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    installDeconLlmCoreProduction();
    await getDeconLlmCore()!.generateText({ slot: 'review-judge', user: 'ONLY-USER' });

    expect(resolveTaskModel).toHaveBeenCalledWith('review-judge');
    // 缺档 → default 哨兵 → resolveModel 自动选择。
    expect(resolveModel).toHaveBeenCalledWith(
      { keyId: 'default', modelId: 'default' },
      readModelConfigFromDisk(),
    );
    const [, reqArg] = generateText.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(reqArg.temperature).toBe(0.2);
    expect(reqArg.maxTokens).toBe(DECON_DEFAULT_MAX_TOKENS); // 缺省 belt
    expect(reqArg.messages).toEqual([{ role: 'user', content: 'ONLY-USER' }]); // system 缺省不占位
    expect('thinking' in reqArg).toBe(false); // 无思考注入
  });

  it('writer-draft 档（P5 读法/细批）：自钉温度 0.3（F-17——分析性叙事报告非创作文本，不沿用创作温度）', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    resolveModel.mockImplementation(() => stubResolvedModel());
    generateText.mockImplementation(async () => ({ text: '# 读法' }));
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    installDeconLlmCoreProduction();
    await getDeconLlmCore()!.generateText({ slot: 'writer-draft', user: 'U', maxTokens: 12000 });

    expect(resolveTaskModel).toHaveBeenCalledWith('writer-draft');
    const [, reqArg] = generateText.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(reqArg.temperature).toBe(0.3);
    expect(reqArg.maxTokens).toBe(12000);
  });

  it('finishReason 透传（CR-2）：协议层停因进 seam 返回——截断判定权威信号', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    resolveModel.mockImplementation(() => stubResolvedModel());
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    installDeconLlmCoreProduction();
    // 'length' = 输出被 token 上限截断 → 透传（调用方 capped/失败挂起）。
    generateText.mockImplementation(async () => ({ text: '{"synopsis":', finishReason: 'length' }));
    const out = await getDeconLlmCore()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out.text).toBe('{"synopsis":');
    expect(out.finishReason).toBe('length');
    // 端点未回报停因 → undefined 透传。
    generateText.mockImplementationOnce(async () => ({ text: '[]' }));
    const out2 = await getDeconLlmCore()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out2.finishReason).toBeUndefined();
  });

  it('usage 透传（CR-13）：provider 计量进 seam 返回——cost 记账真值优先', async () => {
    vi.clearAllMocks();
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    resolveModel.mockImplementation(() => stubResolvedModel());
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    installDeconLlmCoreProduction();
    generateText.mockImplementation(async () => ({
      text: '[]',
      finishReason: 'stop',
      usage: { promptTokens: 1200, completionTokens: 80, totalTokens: 1280 },
    }));
    const out = await getDeconLlmCore()!.generateText({ slot: 'extraction', user: 'U' });
    expect(out.usage).toEqual({ promptTokens: 1200, completionTokens: 80, totalTokens: 1280 });
    // 端点未回报 usage → undefined 透传（调用方回退字符近似 + estimated 标注）。
    generateText.mockImplementationOnce(async () => ({ text: '[]' }));
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
