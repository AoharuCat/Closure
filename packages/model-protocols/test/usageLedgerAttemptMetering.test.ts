import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationMessage, ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import { ProtocolHttpError } from '../src/errors';
import {
  createAntigravityCliDriver,
  generateEmbeddings,
  generateImage,
  generateText,
  generateTextStream,
  rerank,
  setAntigravityCliGenerateForTest,
  setGenerationUsageSink,
} from '../src';
import type { AntigravityCliDriver, AntigravityCliGenerateFn, GenerationCallRecord } from '../src';
import type { FakeAgyProcess, FakePoolEnv } from './antigravityCliFakes';
import { fakePoolEnv } from './antigravityCliFakes';

// ── C3.1 W2：三入口计量 wrapper（embed/rerank/image）+ driver attempt 级记账 ──
//
// design §1/§4：embed 行 prompt/total 记、output ABSENT；image 行 token 全 ABSENT +
// image_count；driver 两发射点（空 SUCCESS 重试前 / 降级重跑替换确认后）——每形态断言
// 无重复计费。fetch 桩 + fakePoolEnv driver 经 setAntigravityCliGenerateForTest 接入
// generateText 全链（attempt 收集器 → dispatch → stub sink），mirror usageSink.test.ts /
// antigravityDriver.test.ts 既有形态。

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function embedModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'text-embedding-test',
    protocol: 'openai-compatible',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-test',
    capability: 'text',
  };
}

function rerankModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'bge-reranker-test',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.jina.ai',
    apiKey: 'sk-test',
    capability: 'rerank',
  };
}

function imageModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'image-test',
    protocol: 'openai-compatible',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-test',
    capability: 'text',
  };
}

function cliModel(): ResolvedModel {
  return {
    keyId: 'agy-key',
    modelId: 'gemini-3.8-pro-high',
    protocol: 'antigravity-cli',
    baseUrl: '',
    apiKey: '',
    capability: 'text',
    cliExecutable: 'C:\\agy\\bin\\agy.exe',
  };
}

function textRequest(overrides: Partial<TextGenerationRequest> = {}): TextGenerationRequest {
  return { model: 'gemini-3.8-pro-high', messages: [{ role: 'user', content: 'x' } as GenerationMessage], ...overrides };
}

/** 工具 step + DONE usage + 成功收尾（降级带触发形态，attempt1 已知消耗在场）。 */
function scriptToolStepTurnWithUsage(proc: FakeAgyProcess, response: string, usage: { input: number; output: number }): void {
  proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'grep_search' } });
  proc.emitEvent({
    type: 'step_update', step_index: 3, state: 'DONE', step_type: 'agent_response',
    text_delta: response, usage: { input: usage.input, output: usage.output },
  });
  proc.emitEvent({ type: 'result', status: 'SUCCESS', response });
}

/** 空 SUCCESS 但 step usage 计数器在场（EMPTY 终态计数器在场、构造错误时旁挂的形态）。 */
function scriptEmptySuccessTurnWithUsage(proc: FakeAgyProcess, usage: { input: number; output: number }): void {
  proc.emitEvent({
    type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response',
    usage: { input: usage.input, output: usage.output },
  });
  proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '' });
}

/** 组装 generateText 全链：真 wrapper + 真 attempt 收集器 + fakePoolEnv 驱动器。 */
function installFakeDriver(env: FakePoolEnv, driverOpts?: { resolveTextAgent?: () => string | undefined }): AntigravityCliDriver {
  const driver = createAntigravityCliDriver(env.deps, undefined, driverOpts);
  setAntigravityCliGenerateForTest(((model, request, ctx, onDelta) =>
    driver.generateText(model, request, ctx, onDelta)) as AntigravityCliGenerateFn);
  return driver;
}

describe('C3.1 W2：embed 入口计量 wrapper', () => {
  const records: GenerationCallRecord[] = [];

  beforeEach(() => {
    records.length = 0;
    setGenerationUsageSink((r) => records.push(r));
  });
  afterEach(() => {
    setGenerationUsageSink(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('成功 + usage 有：prompt/total 记、output ABSENT、taskType 走 ctx、stream=false', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: [0.1, 0.2] }], model: 'text-embedding-test', usage: { prompt_tokens: 100, total_tokens: 100 } }));
    const res = await generateEmbeddings(
      embedModel(),
      { input: ['a', 'b'] },
      { taskType: 'kb-query-embed', callId: 'call-embed-1' },
    );
    expect(res.embeddings).toEqual([[0.1, 0.2]]); // 调用结果零变化
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect(rec.stream).toBe(false);
    expect(rec.protocol).toBe('openai-compatible');
    expect(rec.keyId).toBe('k1');
    expect(rec.modelId).toBe('text-embedding-test');
    expect(rec.taskType).toBe('kb-query-embed'); // ctx 通道（非 request.taskType）
    expect(rec.callId).toBe('call-embed-1'); // ctx.callId 透传
    expect(rec.inputTokens).toBe(100);
    expect(rec.totalTokens).toBe(100);
    expect(rec.outputTokens).toBeUndefined(); // 端点不报——ABSENT ≠0
    expect(rec.thinkingTokens).toBeUndefined();
    expect(rec.firstDeltaMs).toBeUndefined();
    expect(rec.imageCount).toBeUndefined();
    expect(typeof rec.latencyMs).toBe('number');
  });

  it('成功 + usage 无（端点不报）：token 全 ABSENT', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [{ embedding: [1] }], model: 'text-embedding-test' }));
    await generateEmbeddings(embedModel(), { input: ['a'] });
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect(rec.inputTokens).toBeUndefined();
    expect(rec.totalTokens).toBeUndefined();
  });

  it('批量输入（AC2/CR-9 钉死）：多 input batch 请求 → 恰单行、token = 端点合并 usage 直传', async () => {
    const captured: Array<{ url: string; body: string | undefined }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : undefined });
      return jsonResponse({
        data: [{ embedding: [0.1] }, { embedding: [0.2] }, { embedding: [0.3] }, { embedding: [0.4] }],
        model: 'text-embedding-test',
        // 端点对整批返回合并 usage（8.3 批量重嵌形态：token 总量与批量输入规模一致）。
        usage: { prompt_tokens: 3456, total_tokens: 3456 },
      });
    });
    const res = await generateEmbeddings(
      embedModel(),
      { input: ['章一全文……', '章二全文……', '章三全文……', '章四全文……'] },
      { taskType: 'kb-index-embed', callId: 'call-batch-1' },
    );
    expect(res.embeddings).toHaveLength(4); // 调用结果零变化
    expect(captured).toHaveLength(1); // 批量 = 恰一次 HTTP 出站
    const sentBody = JSON.parse(captured[0]!.body!) as { input: string[] };
    expect(sentBody.input).toHaveLength(4); // 全 batch 输入单发出站（不拆行）
    // 「token 与批量输入规模一致」的构造语义：批量调用恰一行、端点合并 usage 原样直传
    //（CR-18：不合成、不按 chunk 拆分——拆分/合成是索引层的事，ledger 只记调用）。
    expect(records).toHaveLength(1);
    expect(records[0]!.inputTokens).toBe(3456);
    expect(records[0]!.totalTokens).toBe(3456);
    expect(records[0]!.outputTokens).toBeUndefined(); // 端点不报 → ABSENT
  });

  it('失败（401）：分类落 auth + 原样重抛 + token ABSENT', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
    const err = await generateEmbeddings(embedModel(), { input: ['a'] }, { taskType: 'kb-index-embed' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(false);
    expect(rec.errorKind).toBe('auth');
    expect(rec.taskType).toBe('kb-index-embed');
    expect(rec.inputTokens).toBeUndefined();
    expect(rec.totalTokens).toBeUndefined();
  });
});

describe('C3.1 W2：image 入口计量 wrapper（D1：记行 + 张数列）', () => {
  const records: GenerationCallRecord[] = [];

  beforeEach(() => {
    records.length = 0;
    setGenerationUsageSink((r) => records.push(r));
  });
  afterEach(() => {
    setGenerationUsageSink(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('成功 n 缺省：image_count=1、token 全 ABSENT、taskType 走 ctx', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [{ url: 'https://x/img.png' }] }));
    const res = await generateImage(imageModel(), { model: 'image-test', prompt: 'a cat' }, { taskType: 'image-gen' });
    expect(res.images).toHaveLength(1); // 调用结果零变化
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect(rec.imageCount).toBe(1);
    expect(rec.taskType).toBe('image-gen');
    expect(rec.inputTokens).toBeUndefined();
    expect(rec.outputTokens).toBeUndefined();
    expect(rec.totalTokens).toBeUndefined();
    expect(rec.stream).toBe(false);
  });

  it('成功 n=3：image_count=3', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [{ url: 'https://x/1.png' }, { url: 'https://x/2.png' }, { url: 'https://x/3.png' }] }));
    await generateImage(imageModel(), { model: 'image-test', prompt: 'a cat', n: 3 }, { taskType: 'image-gen' });
    expect(records[0]!.imageCount).toBe(3);
  });

  it('失败（400）：error_kind 可读 + 原样重抛', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: { message: 'bad request' } }, 400));
    const err = await generateImage(imageModel(), { model: 'image-test', prompt: 'a cat' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect(records).toHaveLength(1);
    expect(records[0]!.success).toBe(false);
    expect(records[0]!.errorKind).toBe('other'); // 4xx 非 401/402/408/429 → other
    expect(typeof records[0]!.errorMessage).toBe('string');
    // 失败行张数不缺席（design §1 无成败限定——n 是请求侧已知事实，CR-18 v2「已知则记」）。
    expect(records[0]!.imageCount).toBe(1);
  });
});

describe('C3.1 W2：rerank 入口计量 wrapper', () => {
  const records: GenerationCallRecord[] = [];

  beforeEach(() => {
    records.length = 0;
    setGenerationUsageSink((r) => records.push(r));
  });
  afterEach(() => {
    setGenerationUsageSink(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('成功 + usage 有：prompt/total 记、output ABSENT、taskType 走 ctx 透传', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ results: [{ index: 0, relevance_score: 0.9 }], usage: { prompt_tokens: 15, total_tokens: 15 } }));
    const res = await rerank(rerankModel(), { query: 'q', documents: ['doc0'] }, { taskType: 'kb-rerank', callId: 'call-rerank-1' });
    expect(res.scores).toEqual([0.9]); // 调用结果零变化
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect(rec.taskType).toBe('kb-rerank');
    expect(rec.callId).toBe('call-rerank-1');
    expect(rec.inputTokens).toBe(15);
    expect(rec.totalTokens).toBe(15);
    expect(rec.outputTokens).toBeUndefined();
  });

  it('失败（401）：分类落 auth + 原样重抛', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
    const err = await rerank(rerankModel(), { query: 'q', documents: ['doc0'] }, { taskType: 'craft-rerank' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect(records).toHaveLength(1);
    expect(records[0]!.success).toBe(false);
    expect(records[0]!.errorKind).toBe('auth');
    expect(records[0]!.taskType).toBe('craft-rerank');
  });
});

describe('C3.1 W2：sink 抛错零影响 + callId 自生成 + sessionId 归一', () => {
  beforeEach(() => {
    setGenerationUsageSink(() => {
      throw new Error('sink boom');
    });
  });
  afterEach(() => {
    setGenerationUsageSink(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('sink 抛错：embed/image/rerank 三入口调用结果零变化（best-effort 回归锚）', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/embeddings')) return jsonResponse({ data: [{ embedding: [1] }], model: 'e' });
      if (url.endsWith('/rerank')) return jsonResponse({ results: [{ index: 0, relevance_score: 1 }] });
      return jsonResponse({ data: [{ url: 'https://x/i.png' }] });
    });
    const embed = await generateEmbeddings(embedModel(), { input: ['a'] });
    expect(embed.embeddings).toEqual([[1]]);
    const image = await generateImage(imageModel(), { model: 'image-test', prompt: 'a cat' });
    expect(image.images).toHaveLength(1);
    const rk = await rerank(rerankModel(), { query: 'q', documents: ['d'] });
    expect(rk.scores).toEqual([1]);
  });

  it('无 ctx.callId：wrapper 自生成且两次调用不同（行自成一组）', async () => {
    setGenerationUsageSink(undefined);
    const records: GenerationCallRecord[] = [];
    setGenerationUsageSink((r) => records.push(r));
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [{ embedding: [1] }], model: 'e' }));
    await generateEmbeddings(embedModel(), { input: ['a'] });
    await generateEmbeddings(embedModel(), { input: ['a'] });
    expect(records).toHaveLength(2);
    expect(records[0]!.callId).toBeTruthy();
    expect(records[1]!.callId).toBeTruthy();
    expect(records[0]!.callId).not.toBe(records[1]!.callId);
  });

  it('text wrapper：wire sessionId 落列 + ctx 优先 + 空串/whitespace-only 归一 ABSENT（CR-7）', async () => {
    setGenerationUsageSink(undefined);
    const records: GenerationCallRecord[] = [];
    setGenerationUsageSink((r) => records.push(r));
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));

    await generateText(embedModel(), textRequest({ sessionId: 'sess-wire' }));
    expect(records[0]!.sessionId).toBe('sess-wire');

    records.length = 0;
    await generateText(embedModel(), textRequest({ sessionId: 'sess-wire' }), { sessionId: 'sess-ctx', callId: 'call-fixed' });
    expect(records[0]!.sessionId).toBe('sess-ctx'); // ctx 优先于 wire
    expect(records[0]!.callId).toBe('call-fixed');

    records.length = 0;
    await generateText(embedModel(), textRequest({ sessionId: '' })); // agent 缝 as any 直调豁免 parse 的 '' 防线
    expect(records[0]!.sessionId).toBeUndefined();

    records.length = 0;
    await generateText(embedModel(), textRequest({ sessionId: '   ' })); // CR-7：whitespace-only 同归 ABSENT（trim 后判空）
    expect(records[0]!.sessionId).toBeUndefined();

    records.length = 0;
    await generateText(embedModel(), textRequest({ sessionId: '  sess-pad  ' })); // CR-7：有效值落 trim 后形态
    expect(records[0]!.sessionId).toBe('sess-pad');

    records.length = 0;
    await generateText(embedModel(), textRequest(), { callId: 'call-fixed', sessionId: '' }); // ctx 通道 '' 同防线
    expect(records[0]!.sessionId).toBeUndefined();
    expect(records[0]!.callId).toBe('call-fixed'); // callId 不受 sessionId 归一影响

    records.length = 0;
    await generateText(embedModel(), textRequest(), { callId: 'call-fixed', sessionId: ' \t ' }); // ctx 通道 whitespace-only 同防线
    expect(records[0]!.sessionId).toBeUndefined();
  });
});

describe('C3.1 W2：driver attempt 级记账（generateText 全链 + fakePoolEnv 驱动器）', () => {
  const records: GenerationCallRecord[] = [];

  beforeEach(() => {
    records.length = 0;
    setGenerationUsageSink((r) => records.push(r));
  });
  afterEach(() => {
    setGenerationUsageSink(undefined);
    setAntigravityCliGenerateForTest(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('空 SUCCESS 重试成功：恰两行（attempt1 失败行含旁挂 usage + attempt2 成功行）、共享 callId', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) scriptEmptySuccessTurnWithUsage(proc, { input: 42, output: 7 });
        else proc.scriptSuccessTurn('重试后的正文', { input: 1, output: 1 });
      };
    });
    const driver = installFakeDriver(env);
    const req = textRequest({ sessionKey: 's1', taskType: 'writer-draft' });
    const r = await generateText(cliModel(), req, { callId: 'call-c31-retry' });
    expect(r.text).toBe('重试后的正文');
    expect(env.spawns).toHaveLength(2); // 重试一次（行为零变化）
    // 无重复计费：恰两行——attempt1 失败行 + 最终成功行。
    expect(records).toHaveLength(2);
    const attempt1 = records[0]!;
    expect(attempt1.success).toBe(false);
    expect(attempt1.errorKind).toBe('cli-empty-success');
    expect(attempt1.errorMessage).toContain('SUCCESS but produced no response text');
    expect(attempt1.inputTokens).toBe(42); // 旁挂 usage（计数器在场已知则记）
    expect(attempt1.outputTokens).toBe(7);
    expect(attempt1.totalTokens).toBeUndefined();
    expect(attempt1.sessionKey).toBe('s1');
    expect(attempt1.taskType).toBe('writer-draft');
    expect(attempt1.stream).toBe(false);
    expect(typeof attempt1.latencyMs).toBe('number');
    expect(attempt1.latencyMs).toBeGreaterThanOrEqual(0);
    const finalRow = records[1]!;
    expect(finalRow.success).toBe(true);
    expect(finalRow.inputTokens).toBe(1); // attempt2（重试）的消耗
    expect(finalRow.outputTokens).toBe(1);
    expect(finalRow.totalTokens).toBe(2);
    // 全部行共享 call_id。
    expect(attempt1.callId).toBe('call-c31-retry');
    expect(finalRow.callId).toBe('call-c31-retry');
    driver.dispose();
  });

  it('重试仍败：两失败行均含已知消耗（M1 最终行读旁挂）、共享 callId', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) scriptEmptySuccessTurnWithUsage(proc, { input: 42, output: 7 });
        else scriptEmptySuccessTurnWithUsage(proc, { input: 13, output: 2 });
      };
    });
    const driver = installFakeDriver(env);
    const req = textRequest({ sessionKey: 's1' });
    await expect(generateText(cliModel(), req, { callId: 'call-c31-retry-fail' })).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 502,
    });
    expect(env.spawns).toHaveLength(2);
    expect(records).toHaveLength(2);
    const attempt1 = records[0]!;
    expect(attempt1.success).toBe(false);
    expect(attempt1.errorKind).toBe('cli-empty-success');
    expect(attempt1.inputTokens).toBe(42); // attempt1 旁挂
    expect(attempt1.outputTokens).toBe(7);
    const finalRow = records[1]!;
    expect(finalRow.success).toBe(false);
    expect(finalRow.errorKind).toBe('server'); // 502 → classifyGenerationFailure
    expect(finalRow.inputTokens).toBe(13); // M1：最终失败行读 attempt2 旁挂
    expect(finalRow.outputTokens).toBe(2);
    expect(attempt1.callId).toBe('call-c31-retry-fail');
    expect(finalRow.callId).toBe('call-c31-retry-fail');
    driver.dispose();
  });

  it('降级重跑替换成功：被弃 attempt1 成功行 + 最终行、无重复计费、共享 callId', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const withAgent = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (withAgent) scriptToolStepTurnWithUsage(proc, 'agent 车道正文', { input: 50, output: 9 });
        else proc.scriptSuccessTurn('降级车道正文', { input: 1, output: 1 });
      };
    });
    const driver = installFakeDriver(env, { resolveTextAgent: () => 'closure-text' });
    const r = await generateText(cliModel(), textRequest({ sessionKey: 'chain:w1' }), { callId: 'call-c31-degrade' });
    expect(r.text).toBe('降级车道正文'); // attempt2（无 agent）结果为最终
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.spawnArgs.args).toContain('--agent');
    expect(env.spawns[1]!.spawnArgs.args).not.toContain('--agent');
    // 无重复计费：恰两行——被弃 attempt1（成功被弃行）+ 最终行（attempt2）。
    expect(records).toHaveLength(2);
    const abandoned = records[0]!;
    expect(abandoned.success).toBe(true); // 成功被弃行
    expect(abandoned.errorKind).toBeUndefined();
    expect(abandoned.errorMessage).toBeUndefined();
    expect(abandoned.inputTokens).toBe(50); // 首试已知消耗如实入账
    expect(abandoned.outputTokens).toBe(9);
    expect(abandoned.latencyMs).toBeGreaterThanOrEqual(0);
    const finalRow = records[1]!;
    expect(finalRow.success).toBe(true);
    expect(finalRow.inputTokens).toBe(1); // attempt2 的消耗（与被弃行不重叠）
    expect(finalRow.totalTokens).toBe(2);
    expect(abandoned.callId).toBe('call-c31-degrade');
    expect(finalRow.callId).toBe('call-c31-degrade');
    driver.dispose();
  });

  it('降级重跑重跑失败：attempt2 失败行 + 首试行为最终行（attempt1 不另发射——无重复计费）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const first = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (first) scriptToolStepTurnWithUsage(proc, '首试正文', { input: 50, output: 9 });
        else proc.scriptErrorTurn('ERROR', 'quota exceeded for today'); // 无 agent 重跑失败
      };
    });
    const driver = installFakeDriver(env, { resolveTextAgent: () => 'closure-text' });
    const r = await generateText(cliModel(), textRequest({ sessionKey: 'chain:c31f' }), { callId: 'call-c31-degrade-fail' });
    expect(r.text).toBe('首试正文'); // catch 保首试结果（行为零变化）
    expect(env.spawns).toHaveLength(2);
    expect(env.warns.some((w) => w.includes('keeping the first-pass result'))).toBe(true);
    // 无重复计费：恰两行——attempt2 失败行 + 最终行（= attempt1，只此一处）。
    expect(records).toHaveLength(2);
    const attempt2 = records[0]!;
    expect(attempt2.success).toBe(false);
    expect(attempt2.errorKind).toBe('quota'); // classifyGenerationFailure 同族词表
    expect(attempt2.inputTokens).toBeUndefined(); // 非 EMPTY 失败无旁挂——如实 ABSENT
    const finalRow = records[1]!;
    expect(finalRow.success).toBe(true);
    expect(finalRow.inputTokens).toBe(50); // attempt1 usage 只出现在最终行（不记两遍）
    expect(finalRow.outputTokens).toBe(9);
    expect(attempt2.callId).toBe('call-c31-degrade-fail');
    expect(finalRow.callId).toBe('call-c31-degrade-fail');
    driver.dispose();
  });

  it('降级重跑遇空 SUCCESS 且重试仍空：attempt2 两行均持专属词 + 首试行为最终行（无重复计费）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const n = spawnCount;
      spawnCount += 1;
      proc.responder = () => {
        if (n === 0) scriptToolStepTurnWithUsage(proc, '首试正文', { input: 50, output: 9 });
        else if (n === 1) scriptEmptySuccessTurnWithUsage(proc, { input: 13, output: 2 }); // 重跑空 SUCCESS → 触发空重试
        else scriptEmptySuccessTurnWithUsage(proc, { input: 4, output: 1 }); // 重试仍空 → 重跑终败
      };
    });
    const driver = installFakeDriver(env, { resolveTextAgent: () => 'closure-text' });
    const r = await generateText(cliModel(), textRequest({ sessionKey: 'chain:c31e' }), { callId: 'call-c31-degrade-empty' });
    expect(r.text).toBe('首试正文'); // catch 保首试结果（行为零变化）
    expect(env.spawns).toHaveLength(3); // 首试 + 重跑空 + 空重试
    // 无重复计费：恰三行——重跑空失败行 + 空重试失败行 + 最终行（= attempt1，只此一处）。
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ success: false, errorKind: 'cli-empty-success' });
    expect(records[0]!.inputTokens).toBe(13);
    // 重试已耗尽的空 SUCCESS 在降级 catch 保持专属词（不被 classifyGenerationFailure 归 'server'）。
    expect(records[1]).toMatchObject({ success: false, errorKind: 'cli-empty-success' });
    expect(records[1]!.inputTokens).toBe(4);
    const finalRow = records[2]!;
    expect(finalRow.success).toBe(true);
    expect(finalRow.inputTokens).toBe(50); // attempt1 usage 只出现在最终行
    for (const rec of records) expect(rec.callId).toBe('call-c31-degrade-empty');
    driver.dispose();
  });

  it('降级重跑 attempt2 abort：零 attempt 行（m2 defer——abort 族如实不记）、最终 abort 失败行', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const first = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (first) scriptToolStepTurnWithUsage(proc, '首试正文', { input: 50, output: 9 });
        else proc.emitEvent({ type: 'result', status: 'CANCELED' }); // 重跑被取消
      };
    });
    const driver = installFakeDriver(env, { resolveTextAgent: () => 'closure-text' });
    await expect(generateText(cliModel(), textRequest({ sessionKey: 'chain:c31a' }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(env.spawns).toHaveLength(2);
    // abort 上抛：attempt1 已知消耗不入账（defer），attempt2 亦零发射——仅 wrapper 最终失败行。
    expect(records).toHaveLength(1);
    expect(records[0]!.success).toBe(false);
    expect(records[0]!.errorKind).toBe('abort');
    expect(records[0]!.inputTokens).toBeUndefined();
    driver.dispose();
  });

  it('流式入口（CR-1）：attempt 行 stream=true（generateTextStreamInner CLI 分支同罩、同 callId）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) scriptEmptySuccessTurnWithUsage(proc, { input: 42, output: 7 });
        else proc.scriptSuccessTurn('重试后的正文', { input: 1, output: 1 });
      };
    });
    const driver = installFakeDriver(env);
    const r = await generateTextStream(
      cliModel(),
      textRequest({ sessionKey: 's1' }),
      { callId: 'call-c31-stream' },
      () => {},
    );
    expect(r.text).toBe('重试后的正文');
    expect(env.spawns).toHaveLength(2);
    expect(records).toHaveLength(2); // attempt1 失败行 + 最终成功行
    const attempt1 = records[0]!;
    expect(attempt1.success).toBe(false);
    expect(attempt1.errorKind).toBe('cli-empty-success');
    expect(attempt1.stream).toBe(true); // CR-1：流式入口的 attempt 行如实（非恒 false）
    expect(attempt1.inputTokens).toBe(42);
    const finalRow = records[1]!;
    expect(finalRow.success).toBe(true);
    expect(finalRow.stream).toBe(true);
    expect(attempt1.callId).toBe('call-c31-stream');
    expect(finalRow.callId).toBe('call-c31-stream');
    driver.dispose();
  });

  it('emit best-effort：收集器抛错不阻 turn 主流程（warn 观测）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) scriptEmptySuccessTurnWithUsage(proc, { input: 42, output: 7 });
        else proc.scriptSuccessTurn('重试后的正文', { input: 1, output: 1 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(
      cliModel(),
      textRequest({ sessionKey: 's1' }),
      {
        onMeteringAttempt: () => {
          throw new Error('collector boom');
        },
      },
    );
    expect(r.text).toBe('重试后的正文'); // 主流程零影响
    expect(env.warns.some((w) => w.includes('metering attempt collector threw'))).toBe(true);
    driver.dispose();
  });
});
