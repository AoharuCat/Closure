/**
 * Story 10.1 Wave C（Wave B 移交）：材料分章 LLM 兜底生产装配 wiring 测试。
 *
 * 钉死（materialIngest.ts JSDoc 指定链 + lintIpc classify 同型）：
 * - 档位 = `resolveTaskModel('extraction')`（C3.2 六档 grep 核实——「提取·汇编」档与分章
 *   候选行判别语义对齐）；assignment → resolveModel 收到 {keyId, modelId} 窄引用。
 * - 缺档/未注入 → default 哨兵 {keyId:'default', modelId:'default'} → resolveModel 自动选择。
 * - 思考策略随档（assignmentThinkingControl 镜像——thinking 非法值不注入）。
 * - 装配后 ingestMaterial 低置信材料**真走 model-protocols generateText**（未装配 =
 *   挂起路径已在 materialIngest.test 覆盖；本文件钉生产链贯通）。
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { installMaterialLLMCoreProduction, MATERIAL_FALLBACK_MAX_TOKENS } from '../main/ipc/toolHandlers/materialLLMCore';
import {
  __clearMaterialLLMCoreForTest,
  __getMaterialLLMCoreForTest,
  ingestMaterial,
  SUBTITLE_POLISH_SYSTEM_PROMPT,
} from '../main/ipc/toolHandlers/materialIngest';
import { rmBestEffort } from './rmBestEffort';

function stubResolvedModel() {
  return {
    keyId: 'key-ext',
    modelId: 'extractor-x',
    protocol: 'openai-compatible' as const,
    baseUrl: 'http://endpoint.example.com/v1',
    apiKey: 'sk-stub',
    capability: 'text' as const,
  };
}

let materialsRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  __clearMaterialLLMCoreForTest();
  materialsRoot = mkdtempSync(path.join(os.tmpdir(), 'material-llm-wiring-'));
  readModelConfigFromDisk.mockReturnValue({ keys: [] });
  resolveModel.mockImplementation(() => stubResolvedModel());
  generateText.mockImplementation(async () => ({ text: '{"selected":[]}' }));
});

afterEach(() => {
  __clearMaterialLLMCoreForTest();
  rmBestEffort(materialsRoot);
});

describe('installMaterialLLMCoreProduction（生产装配链）', () => {
  it('extraction 档配置 → resolveModel 收窄引用 + generateText 收 system/user + 温度 0 + 思考随档', async () => {
    resolveTaskModel.mockReturnValue({ keyId: 'key-ext', modelId: 'extractor-x', thinking: 'low' });
    assignmentThinkingControl.mockReturnValue({ level: 'low' });
    installMaterialLLMCoreProduction();
    const core = __getMaterialLLMCoreForTest()!;
    expect(core).not.toBeNull();

    const out = await core.generateText({ system: 'SYS', user: 'USER' });
    expect(out).toEqual({ text: '{"selected":[]}' });

    // 档位 key 钉死：extraction（C3.2 六档的「提取·汇编」档）。
    expect(resolveTaskModel).toHaveBeenCalledWith('extraction');
    // assignment → 窄引用（keyId/modelId 顶层平铺，不渗 thinking 键）。
    expect(resolveModel).toHaveBeenCalledWith(
      { keyId: 'key-ext', modelId: 'extractor-x' },
      readModelConfigFromDisk(),
    );
    // 协议层出站：messages [system, user] + 温度 0 + maxTokens + 思考随档。
    const [modelArg, reqArg] = generateText.mock.calls[0] as unknown as [
      ReturnType<typeof stubResolvedModel>,
      Record<string, unknown>,
    ];
    expect(modelArg.modelId).toBe('extractor-x');
    expect(reqArg.model).toBe('extractor-x');
    expect(reqArg.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(reqArg.temperature).toBe(0);
    expect(reqArg.maxTokens).toBe(MATERIAL_FALLBACK_MAX_TOKENS);
    expect(reqArg.thinking).toEqual({ level: 'low' });
  });

  it('缺档（undefined）→ default 哨兵 → resolveModel 自动选择；无思考注入', async () => {
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installMaterialLLMCoreProduction();
    await __getMaterialLLMCoreForTest()!.generateText({ user: 'ONLY-USER' });
    expect(resolveModel).toHaveBeenCalledWith(
      { keyId: 'default', modelId: 'default' },
      readModelConfigFromDisk(),
    );
    const [, reqArg] = generateText.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(reqArg.messages).toEqual([{ role: 'user', content: 'ONLY-USER' }]); // system 缺省不占位
    expect('thinking' in reqArg).toBe(false);
  });

  it('finishReason 透传（CR-2）：协议层停因进 seam 返回——整理档截断判定的权威信号', async () => {
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installMaterialLLMCoreProduction();
    // 'length' = 输出被 token 上限截断（model-protocols GenerationFinishReason）→ 透传。
    generateText.mockImplementation(async () => ({ text: '正文', finishReason: 'length' }));
    const out = await __getMaterialLLMCoreForTest()!.generateText({ user: 'U' });
    expect(out.text).toBe('正文');
    expect(out.finishReason).toBe('length');
    // 端点未回报停因 → undefined 透传（调用方回退比值法启发式）。
    generateText.mockImplementationOnce(async () => ({ text: '正文二' }));
    const out2 = await __getMaterialLLMCoreForTest()!.generateText({ user: 'U' });
    expect(out2.finishReason).toBeUndefined();
  });

  it('装配后 ingestMaterial 低置信 ≥2 万字材料真走 generateText（生产链贯通 + 挂起态诚实）', async () => {
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installMaterialLLMCoreProduction();

    const text = Array.from(
      { length: 86 },
      (_, i) => `小节之${i}\n\n${'砚'.repeat(240)}。`,
    ).join('\n\n');
    writeFileSync(path.join(materialsRoot, '讲义.txt'), text, 'utf-8');

    const result = await ingestMaterial(
      { scope: 'global', materialsRoot, projectId: null },
      '讲义.txt',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 🔑 生产内核被消费（候选行约束 prompt 单次调用；LLM 负判 → 挂起零章界诚实标注）。
    expect(generateText).toHaveBeenCalledTimes(1);
    const [, reqArg] = generateText.mock.calls[0] as unknown as [unknown, { messages: Array<{ role: string; content: string }> }];
    expect(reqArg.messages.some((m) => m.role === 'user' && m.content.includes('候选行'))).toBe(true);
    expect(result.material.quality.chapterDetection.method).toBe('llm-fallback');
    expect(result.material.chapters).toHaveLength(0);
    expect(result.material.status).toBe('low-confidence');
    expect(result.material.quality.parseNotes.some((n) => n.includes('LLM'))).toBe(true);
  });
});

describe('installMaterialLLMCoreProduction — 字幕书面化整理链（E10.2a）', () => {
  it('装配后摄取 .srt 真走生产 generateText：整理 system 进协议层 + 整理稿落派生 .md + 成功 note', async () => {
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installMaterialLLMCoreProduction();
    generateText.mockImplementation(async () => ({ text: '大家好，今天给大家分享一个很实用的写作方法。' }));

    writeFileSync(
      path.join(materialsRoot, '分享.srt'),
      '1\n00:00:01,000 --> 00:00:03,000\n大家好 今天给大家分享\n\n2\n00:00:03,500 --> 00:00:06,000\n一个很实用的写作方法\n',
      'utf-8',
    );
    const result = await ingestMaterial({ scope: 'global', materialsRoot, projectId: null }, '分享.srt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 🔑 生产内核被消费：整理 system 段进协议层（单段小样例无分章兜底——调用恰一次）。
    expect(generateText).toHaveBeenCalledTimes(1);
    const [, reqArg] = generateText.mock.calls[0] as unknown as [
      unknown,
      { messages: Array<{ role: string; content: string }> },
    ];
    expect(reqArg.messages[0]).toEqual({ role: 'system', content: SUBTITLE_POLISH_SYSTEM_PROMPT });
    expect(result.material.quality.parseNotes.some((n) => n.includes('字幕已书面化整理（1 段）'))).toBe(true);
    expect(result.material.provenance.via).toBe('builtin-subtitle');
    expect(result.material.provenance.medium).toBe('video');
    // 整理稿落派生 .md（时间码剥离——剥标记正文上检查，标记本身的 `-->` 是注释闭合）。
    const derived = readFileSync(path.join(materialsRoot, '.derived', '分享.md'), 'utf-8');
    expect(derived).toContain('大家好，今天给大家分享一个很实用的写作方法。');
    expect(derived.replace(/<!--\s*mat-chapter[^>]*-->/g, '')).not.toContain('-->');
  });
});
