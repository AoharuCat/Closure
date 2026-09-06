import { describe, expect, it, vi } from 'vitest';
import {
  generate,
  setGenerateTextFn,
  type GenerateTextFn,
  type GenerateTextRequest,
} from '../src/provider/ipc-provider';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// S4b（task 08-25 design §5.2）：messagesToPayload 多轮回传 reasoning——assistant
// 消息带 reasoning 时以 `reasoning_content`（GLM/Kimi/DeepSeek 生态惯例 wire 名）附在
// 消息对象上、`reasoningSignature`（Anthropic thinking 块签名）同附；无 reasoning 的
// 消息不带（字节级零变化）。thinking 策略经 GenerateOptions → request.thinking 透传。
// 协议层（model-protocols）的 wire 侧消费（Anthropic thinking 块 / OpenAI bodyPatch）
// 由该包 test/reasoning-roundtrip.test.ts 钉住；本文件钉 agent 缝的载荷形态。
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL = new AbortController().signal;

function installSeam() {
  const seam = vi.fn<GenerateTextFn>(async () => ({ text: 'ok', finishReason: 'stop' }));
  setGenerateTextFn(seam);
  return seam;
}

function requestOf(seam: ReturnType<typeof vi.fn<GenerateTextFn>>): GenerateTextRequest {
  return seam.mock.calls[0][0];
}

describe('ipc-provider 多轮回传 reasoning（S4b design §5.2）', () => {
  it('assistant 带 reasoning + signature → payload 消息附 reasoning_content / reasoningSignature', async () => {
    const seam = installSeam();
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '答案',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
        reasoning: '工具前推理',
        reasoningSignature: 'sig-1',
        createdAt: 2,
      },
      { id: 't1', role: 'tool', content: 'out', createdAt: 3 },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const payload = requestOf(seam);
    const assistant = (payload.request.messages as Array<Record<string, unknown>>)
      .find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.reasoning_content).toBe('工具前推理');
    expect(assistant?.reasoningSignature).toBe('sig-1');
    // 既有形态不动（content/toolCalls 照旧）。
    expect(assistant?.content).toBe('答案');
  });

  it('assistant 无 reasoning → 消息不带 reasoning_content/reasoningSignature 键（零回归）', async () => {
    const seam = installSeam();
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '答案', createdAt: 2 },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const assistant = (requestOf(seam).request.messages as Array<Record<string, unknown>>)
      .find((m) => m.role === 'assistant');
    expect('reasoning_content' in (assistant ?? {})).toBe(false);
    expect('reasoningSignature' in (assistant ?? {})).toBe(false);
  });

  it('reasoning 为空串 → 不附带（空思考不回传）', async () => {
    const seam = installSeam();
    const messages: SessionMessage[] = [
      { id: 'a1', role: 'assistant', content: '答案', reasoning: '', createdAt: 1 },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const assistant = (requestOf(seam).request.messages as Array<Record<string, unknown>>)
      .find((m) => m.role === 'assistant');
    expect('reasoning_content' in (assistant ?? {})).toBe(false);
  });

  // task 09-01 B2（R2.3）组合核对：带图 user 消息与 assistant reasoning 回传同史共存
  // ——user 走 image parts 分支，assistant 的 reasoning_content 照常回传，互不干扰。
  it('带图 user 消息 + assistant reasoning 同史 → parts 分支与 reasoning_content 回传互不干扰', async () => {
    const seam = installSeam();
    const messages: SessionMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '看图',
        images: [{ path: 'inbox/images/a.png', b64hash: 'ha', name: '图a' }],
        createdAt: 1,
      },
      { id: 'a1', role: 'assistant', content: '答案', reasoning: '思考', reasoningSignature: 's1', createdAt: 2 },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const payload = requestOf(seam).request.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(payload[1].content)).toBe(true); // user → parts（含 image part）
    expect((payload[1].content as Array<Record<string, unknown>>).some((p) => p.type === 'image')).toBe(true);
    const assistant = payload.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('思考');
    expect(assistant?.reasoningSignature).toBe('s1');
  });
});

describe('ipc-provider thinking 透传（S4b design §2）', () => {
  it('GenerateOptions.thinking → request.thinking 原样透传；未设 → 字段值 undefined（序列化缺席 = auto）', async () => {
    const seam = installSeam();
    await generate(
      [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }],
      'SYS',
      [],
      SIGNAL,
      { thinking: { level: 'custom', custom: '8192' } },
    );
    expect(requestOf(seam).request.thinking).toEqual({ level: 'custom', custom: '8192' });

    const seam2 = installSeam();
    await generate([{ id: 'u2', role: 'user', content: 'hi', createdAt: 1 }], 'SYS', [], SIGNAL);
    expect(requestOf(seam2).request.thinking).toBeUndefined();
  });
});
