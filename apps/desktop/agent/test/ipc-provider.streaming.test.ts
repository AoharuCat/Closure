import { describe, expect, it, vi } from 'vitest';
import {
  generate,
  setGenerateTextFn,
  type GenerateTextFn,
  type GenerateTextRequest,
  type GenerationDelta,
} from '../src/provider/ipc-provider';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 1（流式缝 / design §2）：GenerateTextFn 加第三参
// callbacks{onDelta} + 返回类型加 reasoning?/usage?（usage 仅类型留缝，零消费）。
// generate() 加 opts.onDelta 透传。本文件钉住三件事：
//   1. 无 onDelta → seam 调用形状与升级前逐字节一致（恰好两参，零回归）；
//   2. 有 onDelta → 第三参 {onDelta} 原引用透传，delta 经闭包直达调用方；
//   3. seam 返回带 reasoning/usage（新 additive 字段）时既有 GenerateResult
//      映射不动（content/toolCalls/finishReason 照旧）。
// 分派逻辑（有回调走流式/无回调走非流式）在 shell 侧 generateTextImpl，
// 由 shell 包 agentIpcStreamDispatch.test.ts 端到端钉住。
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES: SessionMessage[] = [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }];
const SIGNAL = new AbortController().signal;

function installSeam(impl: GenerateTextFn) {
  const seam = vi.fn<GenerateTextFn>(impl);
  setGenerateTextFn(seam);
  return seam;
}

describe('ipc-provider 流式缝（dogfood T1 Stage 1）', () => {
  it('无 onDelta → seam 恰以两参被调（升级前逐字节一致，零回归）', async () => {
    const seam = installSeam(async (_body: GenerateTextRequest) => ({ text: 'ok', finishReason: 'stop' }));

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL);

    expect(seam).toHaveBeenCalledTimes(1);
    // 恰好两个实参——不传 undefined 占位（旧签名调用形状不变）。
    expect(seam.mock.calls[0].length).toBe(2);
    expect(seam.mock.calls[0][2]).toBeUndefined();
    // 既有映射照旧。
    expect(result).toEqual({ content: 'ok', toolCalls: undefined, finishReason: 'stop' });
  });

  it('有 onDelta → 第三参 {onDelta} 原引用透传，delta 直达调用方回调', async () => {
    const received: GenerationDelta[] = [];
    const onDelta = (d: GenerationDelta) => received.push(d);
    // seam 侧拿到 callbacks 后同步吐两枚 delta（text + reasoning），验证闭包转发链。
    const seam = installSeam(async (_body, _abort, callbacks) => {
      callbacks?.onDelta?.({ type: 'reasoning', delta: '思' });
      callbacks?.onDelta?.({ type: 'text', delta: '正文' });
      return { text: '正文', finishReason: 'stop' };
    });

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL, { onDelta });

    expect(seam).toHaveBeenCalledTimes(1);
    const callbacks = seam.mock.calls[0][2];
    expect(callbacks).toBeDefined();
    expect(callbacks?.onDelta).toBe(onDelta); // 同一函数引用，非包装副本
    expect(received).toEqual([
      { type: 'reasoning', delta: '思' },
      { type: 'text', delta: '正文' },
    ]);
    expect(result.content).toBe('正文');
  });

  it('seam 返回 reasoning/reasoningSignature/usage → 全透传进 GenerateResult（S4b：usage 透出 = 校准环生产激活）', async () => {
    installSeam(async () => ({
      text: '答案',
      toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
      finishReason: 'tool_calls',
      reasoning: '推理过程',
      reasoningSignature: 'sig-abc',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    }));

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL);

    // dogfood T1 Stage 2：generate() 透传 reasoning（#27② 终帧聚合落消息）。
    // S4b（task 08-25）：usage 透出（runLoop 校准环 updateCalibrationRatio 的生产激活开关——
    // 此前仅类型留缝零消费）+ reasoningSignature 透出（Anthropic thinking 块签名，落终帧
    // assistantMsg 供 messagesToPayload 多轮回传）。
    expect(result).toEqual({
      content: '答案',
      toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
      finishReason: 'tool_calls',
      reasoning: '推理过程',
      reasoningSignature: 'sig-abc',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
  });

  it('finishReason 缺省仍回退 stop（缺省语义与升级前一致）', async () => {
    installSeam(async () => ({ text: 'x' }));

    const result = await generate(MESSAGES, 'SYS', [], SIGNAL);
    expect(result.finishReason).toBe('stop');
    expect(result.content).toBe('x');
  });

  // dogfood T1 Stage 4（design §6.3 / r3）：核对钉——历史 assistant 消息携带 reasoning
  //（#27② 持久化字段）时，messagesToPayload **不**把 reasoning 塞回给模型（各协议
  // assistant reasoning 回传格式不一，首期只展示 + 持久化）。经公开 generate 缝行为级断言。
  it('payload 不回传 reasoning——历史消息的 reasoning 字段不进模型请求', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const history: SessionMessage[] = [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: '带思考的回答', reasoning: '深度思考全文', createdAt: 2 },
      { id: 'm3', role: 'user', content: '继续', createdAt: 3 },
    ];

    await generate(history, 'SYS', [], SIGNAL);

    const payloadMessages = seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>;
    const assistantPayload = payloadMessages.find((m) => m.role === 'assistant');
    expect(assistantPayload).toBeDefined();
    expect(assistantPayload?.content).toBe('带思考的回答');
    expect('reasoning' in (assistantPayload ?? {})).toBe(false); // 不回传（r3：各协议格式不一）
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// task 09-01 B 波 B2（R2.3 / dogfood #45）：user 消息带 images 指针 → payload
// content 组 text + image parts。**线上是指针形态非 b64**（agent 零 FS，ADR-2——
// 指针→字节/归一/vision 路由收在 shell generate 缝，B3 resolveImageParts 改写）；
// 无 images 旧消息走原 else 纯字符串（回归锁）。经公开 generate 缝行为级断言。
// ─────────────────────────────────────────────────────────────────────────────

describe('ipc-provider user images parts（B2 R2.3）', () => {
  it('user 消息带 images → content 为 parts 数组：首位 text part + 逐图 image part（指针形态，非 b64）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const messages: SessionMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '[图片引用 · 截图1.png] (path: inbox/images/2026-09-01-a1.png)\n---\n这张图里是什么',
        images: [{ path: 'inbox/images/2026-09-01-a1.png', b64hash: 'sha256-abc', name: '截图1.png' }],
        createdAt: 1,
      },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const payloadMessages = seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>;
    // payload[0] 是 system 前言；user 消息在 [1]。
    const userPayload = payloadMessages[1];
    expect(userPayload).toBeDefined();
    expect(userPayload.role).toBe('user');
    expect(userPayload.content).toEqual([
      { type: 'text', text: '[图片引用 · 截图1.png] (path: inbox/images/2026-09-01-a1.png)\n---\n这张图里是什么' },
      { type: 'image', image: { path: 'inbox/images/2026-09-01-a1.png', b64hash: 'sha256-abc' } },
    ]);
    // CR-001b：无 projectPath 的指针（旧消息/缺省）→ part 键**缺席**（ABSENT 非 undefined，
    // 与既有 wire 形态逐字节一致——shell agentImageParts 老消息回落 fallback 面不扩）。
    const firstParts = userPayload.content as Array<{ type: string; image?: Record<string, unknown> }>;
    expect('projectPath' in firstParts[1]!.image!).toBe(false);
  });

  // CR-001 决议 b（BMad CR 2026-09-01）：线上 image part 形态钉死
  // `{type:'image', image:{path, b64hash, projectPath?}}`——projectPath（指针所在项目根）
  // 有则带，shell 据此精确定位读盘根；字段名/层级与 shell agentImageParts 消费形态逐字对齐。
  it('CR-001b：images 带 projectPath → wire part 形态钉死 {type:image, image:{path, b64hash, projectPath}}', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const messages: SessionMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '看图',
        images: [{ path: 'inbox/images/a.png', b64hash: 'h1', name: 'a', projectPath: 'C:/proj/alpha' }],
        createdAt: 1,
      },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const userPayload = (seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>)[1];
    expect(userPayload.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', image: { path: 'inbox/images/a.png', b64hash: 'h1', projectPath: 'C:/proj/alpha' } },
    ]);
  });

  it('CR-001b：同载荷混合——带/不带 projectPath 的指针逐图独立判定（presence 条件展开）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const messages: SessionMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '对比',
        images: [
          { path: 'inbox/images/a.png', b64hash: 'h1', name: 'a', projectPath: 'C:/proj/alpha' },
          { path: 'inbox/images/b.png', b64hash: 'h2', name: 'b' }, // 旧消息缺省形态
        ],
        createdAt: 1,
      },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const userPayload = (seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>)[1];
    const parts = userPayload.content as Array<{ type: string; image?: Record<string, unknown> }>;
    expect(parts[1]!.image).toEqual({ path: 'inbox/images/a.png', b64hash: 'h1', projectPath: 'C:/proj/alpha' });
    expect(parts[2]!.image).toEqual({ path: 'inbox/images/b.png', b64hash: 'h2' });
    expect('projectPath' in parts[2]!.image!).toBe(false); // 键缺席非 undefined
  });

  it('多图：parts = [text, image, image]，与 images 数组同序；wire 不带 name（展示名只落盘侧）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const messages: SessionMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '这两张对比一下',
        images: [
          { path: 'inbox/images/a.png', b64hash: 'h1', name: '图一' },
          { path: 'inbox/images/b.png', b64hash: 'h2', name: '图二' },
        ],
        createdAt: 1,
      },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const userPayload = (seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>)[1];
    expect(userPayload.content).toEqual([
      { type: 'text', text: '这两张对比一下' },
      { type: 'image', image: { path: 'inbox/images/a.png', b64hash: 'h1' } },
      { type: 'image', image: { path: 'inbox/images/b.png', b64hash: 'h2' } },
    ]);
  });

  it('images 空数组 → content 仍为纯字符串（与无字段消息逐字节一致，不产 [text] 单元素数组）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: '纯文本', images: [], createdAt: 1 },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const userPayload = (seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>)[1];
    expect(userPayload.content).toBe('纯文本');
  });

  it('无 images 的旧 user 消息 → 原路径纯字符串回归（含 pinned/summary 前言注入区同为纯字符串）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '回答', createdAt: 2 },
      { id: 'u2', role: 'user', content: '继续', createdAt: 3 },
    ];

    await generate(messages, 'SYS', [], SIGNAL, {}, {
      pinnedContent: 'pinned',
      compactedSummary: 'summary',
    });

    const payloadMessages = seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>;
    // system + pinned(user/assistant) + summary(user/assistant) + u1 + a1 + u2 = 8 条。
    expect(payloadMessages).toHaveLength(8);
    for (const entry of payloadMessages) {
      expect(typeof entry.content).toBe('string'); // 全部纯字符串，无 parts 混入
    }
    expect(payloadMessages[5]).toEqual({ role: 'user', content: 'hi' });
    expect(payloadMessages[7]).toEqual({ role: 'user', content: '继续' });
  });

  it('混合历史：带图 user 与无图 user 并存——各自走对应分支（parts / 纯字符串）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));
    const messages: SessionMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '看图',
        images: [{ path: 'inbox/images/x.png', b64hash: 'hx', name: 'x' }],
        createdAt: 1,
      },
      { id: 'a1', role: 'assistant', content: '好的', createdAt: 2 },
      { id: 'u2', role: 'user', content: '再问一句', createdAt: 3 },
    ];

    await generate(messages, 'SYS', [], SIGNAL);

    const payloadMessages = seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(payloadMessages[1].content)).toBe(true); // 带图 → parts
    expect(payloadMessages[3].content).toBe('再问一句'); // 无图 → 原路径
  });

  it('buildImagesParts 纯函数：首位恒为 text part，其后逐图一枚 image part（指针序保持）；CR-001b 逐图条件展开 projectPath', async () => {
    const { buildImagesParts } = await import('../src/provider/ipc-provider');
    const parts = buildImagesParts('正文', [
      { path: 'inbox/images/1.png', b64hash: 'b1', name: '一', projectPath: 'C:/proj/alpha' },
      { path: 'inbox/images/2.png', b64hash: 'b2', name: '二' }, // 无字段（旧消息形态）
    ]);
    expect(parts).toEqual([
      { type: 'text', text: '正文' },
      { type: 'image', image: { path: 'inbox/images/1.png', b64hash: 'b1', projectPath: 'C:/proj/alpha' } },
      { type: 'image', image: { path: 'inbox/images/2.png', b64hash: 'b2' } },
    ]);
    // 无字段指针：键缺席（ABSENT 非 undefined——jsonl/wire 均不产字段）。
    const imageParts = parts.filter((p): p is Extract<typeof p, { type: 'image' }> => p.type === 'image');
    expect('projectPath' in imageParts[1]!.image).toBe(false);
    expect(imageParts[1]!.image.projectPath).toBeUndefined();
  });
});
