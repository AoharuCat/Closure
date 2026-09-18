/**
 * Story 10.1 Wave C（Wave B 移交）：材料分章 LLM 兜底生产装配 wiring 测试。
 *
 * 钉死（materialIngest.ts JSDoc 指定链 + lintIpc classify 同型）：
 * - 档位 = `resolveTaskModel('extraction')`（C3.2 六档 grep 核实——「提取·汇编」档与分章
 *   候选行判别语义对齐）；assignment → 窄引用直达环入口 payload.ref。
 * - 缺档/未注入 → default 哨兵 {keyId:'default',modelId:'default'}（环内 resolveModel 自动选择）。
 * - 思考策略随档（assignmentThinkingControl 镜像——thinking 非法值不注入）。
 * - 装配后 ingestMaterial 低置信材料**真走网关环入口 handleGenerateText**（未装配 =
 *   挂起路径已在 materialIngest.test 覆盖；本文件钉生产链贯通）。
 *
 * 09-12 子2（复核 H1 重接）：生产面改经网关环入口——mock 面从 protocol generateText 换到
 * handleGenerateText（resolveModel 已上移进环，环行为归 modelGatewayFallbackLoop.test.ts）。
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { installMaterialLLMCoreProduction, MATERIAL_FALLBACK_MAX_TOKENS } from '../main/ipc/toolHandlers/materialLLMCore';
import {
  __clearMaterialLLMCoreForTest,
  __getMaterialLLMCoreForTest,
  ingestMaterial,
  SUBTITLE_POLISH_SYSTEM_PROMPT,
} from '../main/ipc/toolHandlers/materialIngest';
import { rmBestEffort } from './rmBestEffort';

/** 取第 i 次环入口调用的 payload（ref + request）。 */
function payloadAt(i: number): { ref: { keyId: string; modelId: string }; request: Record<string, unknown> } {
  return handleGenerateText.mock.calls[i]![0] as unknown as {
    ref: { keyId: string; modelId: string };
    request: Record<string, unknown>;
  };
}

let materialsRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  __clearMaterialLLMCoreForTest();
  materialsRoot = mkdtempSync(path.join(os.tmpdir(), 'material-llm-wiring-'));
  handleGenerateText.mockImplementation(async () => ({ text: '{"selected":[]}' }));
});

afterEach(() => {
  __clearMaterialLLMCoreForTest();
  rmBestEffort(materialsRoot);
});

describe('installMaterialLLMCoreProduction（生产装配链）', () => {
  it('extraction 档配置 → 窄引用直达环入口 + request 收 system/user + 温度 0 + 思考随档', async () => {
    resolveTaskModel.mockReturnValue({ keyId: 'key-ext', modelId: 'extractor-x', thinking: 'low' });
    assignmentThinkingControl.mockReturnValue({ level: 'low' });
    installMaterialLLMCoreProduction();
    const core = __getMaterialLLMCoreForTest()!;
    expect(core).not.toBeNull();

    const out = await core.generateText({ system: 'SYS', user: 'USER' });
    expect(out).toEqual({ text: '{"selected":[]}' });

    // 档位 key 钉死：extraction（C3.2 六档的「提取·汇编」档）。
    expect(resolveTaskModel).toHaveBeenCalledWith('extraction');
    // assignment → 窄引用（keyId/modelId 顶层平铺，不渗 thinking 键）——环内 per-attempt 解析。
    const { ref, request } = payloadAt(0);
    expect(ref).toEqual({ keyId: 'key-ext', modelId: 'extractor-x' });
    expect(request.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(request.temperature).toBe(0);
    expect(request.maxTokens).toBe(MATERIAL_FALLBACK_MAX_TOKENS);
    expect(request.thinking).toEqual({ level: 'low' });
  });

  it('缺档（undefined）→ default 哨兵（环内自动选择）；无思考注入', async () => {
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installMaterialLLMCoreProduction();
    await __getMaterialLLMCoreForTest()!.generateText({ user: 'ONLY-USER' });
    const { ref, request } = payloadAt(0);
    expect(ref).toEqual({ keyId: 'default', modelId: 'default' });
    expect(request.messages).toEqual([{ role: 'user', content: 'ONLY-USER' }]); // system 缺省不占位
    expect('thinking' in request).toBe(false);
  });

  it('finishReason 透传（CR-2）：协议层停因进 seam 返回——整理档截断判定的权威信号', async () => {
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installMaterialLLMCoreProduction();
    // 'length' = 输出被 token 上限截断（GenerationFinishReason）→ 透传。
    handleGenerateText.mockImplementation(async () => ({ text: '正文', finishReason: 'length' }));
    const out = await __getMaterialLLMCoreForTest()!.generateText({ user: 'U' });
    expect(out.text).toBe('正文');
    expect(out.finishReason).toBe('length');
    // 端点未回报停因 → undefined 透传（调用方回退比值法启发式）。
    handleGenerateText.mockImplementationOnce(async () => ({ text: '正文二' }));
    const out2 = await __getMaterialLLMCoreForTest()!.generateText({ user: 'U' });
    expect(out2.finishReason).toBeUndefined();
  });

  it('装配后 ingestMaterial 低置信 ≥2 万字材料真走环入口（生产链贯通 + 挂起态诚实）', async () => {
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
    expect(handleGenerateText).toHaveBeenCalledTimes(1);
    const { request } = payloadAt(0);
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === 'user' && m.content.includes('候选行'))).toBe(true);
    expect(result.material.quality.chapterDetection.method).toBe('llm-fallback');
    expect(result.material.chapters).toHaveLength(0);
    expect(result.material.status).toBe('low-confidence');
    expect(result.material.quality.parseNotes.some((n) => n.includes('LLM'))).toBe(true);
  });
});

describe('installMaterialLLMCoreProduction — 字幕书面化整理链（E10.2a）', () => {
  it('装配后摄取 .srt 真走生产环入口：整理 system 进 request + 整理稿落派生 .md + 成功 note', async () => {
    resolveTaskModel.mockReturnValue(undefined);
    assignmentThinkingControl.mockReturnValue(undefined);
    installMaterialLLMCoreProduction();
    handleGenerateText.mockImplementation(async () => ({ text: '大家好，今天给大家分享一个很实用的写作方法。' }));

    writeFileSync(
      path.join(materialsRoot, '分享.srt'),
      '1\n00:00:01,000 --> 00:00:03,000\n大家好 今天给大家分享\n\n2\n00:00:03,500 --> 00:00:06,000\n一个很实用的写作方法\n',
      'utf-8',
    );
    const result = await ingestMaterial({ scope: 'global', materialsRoot, projectId: null }, '分享.srt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 🔑 生产内核被消费：整理 system 段进 request（单段小样例无分章兜底——调用恰一次）。
    expect(handleGenerateText).toHaveBeenCalledTimes(1);
    const { request } = payloadAt(0);
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: SUBTITLE_POLISH_SYSTEM_PROMPT });
    expect(result.material.quality.parseNotes.some((n) => n.includes('字幕已书面化整理（1 段）'))).toBe(true);
    expect(result.material.provenance.via).toBe('builtin-subtitle');
    expect(result.material.provenance.medium).toBe('video');
    // 整理稿落派生 .md（时间码剥离——剥标记正文上检查，标记本身的 `-->` 是注释闭合）。
    const derived = readFileSync(path.join(materialsRoot, '.derived', '分享.md'), 'utf-8');
    expect(derived).toContain('大家好，今天给大家分享一个很实用的写作方法。');
    expect(derived.replace(/<!--\s*mat-chapter[^>]*-->/g, '')).not.toContain('-->');
  });
});
