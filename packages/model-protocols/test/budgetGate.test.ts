import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import {
  BudgetExceededError,
  checkBudgetGate,
  classifyGenerationFailure,
  generateEmbeddings,
  generateImage,
  generateText,
  generateTextStream,
  rerank,
  setBudgetGate,
  setGenerationUsageSink,
} from '../src';
import type { BudgetGateResult, GenerationCallRecord } from '../src';

// C3.2 W3：月度预算硬线门——gate 判定族（放行/拦截/gate throw 降级放行/无 gate 恒放行）
// + wrapper 族五入口前置门（被拦落 budget 失败行后抛 BudgetExceededError，run 不发起、
// fetch 零触达；image 行 imageCount 照带）+ 分类器归 'budget' ineligible（链不烧）。
// mirror usageSink.test.ts 的 sink 捕获形态。

const ORIGINAL_FETCH = globalThis.fetch;

function openaiModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'totally-unknown-model',
    protocol: 'openai-compatible',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-test',
    capability: 'text',
    ...overrides,
  };
}

const BASE_REQUEST: TextGenerationRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

function blockedGate(spent = 25, cap = 20): () => BudgetGateResult {
  return () => ({ allowed: false, spentCny: spent, hardCapCny: cap });
}

/** token 键两态纪律：被拦行 token 列全 ABSENT（未发生请求无消耗可记——键不在非 0）。 */
function expectNoTokenKeys(rec: GenerationCallRecord): void {
  expect('inputTokens' in rec).toBe(false);
  expect('outputTokens' in rec).toBe(false);
  expect('totalTokens' in rec).toBe(false);
  expect('thinkingTokens' in rec).toBe(false);
  expect('cacheReadTokens' in rec).toBe(false);
}

describe('budget gate（C3.2 W3）', () => {
  let records: GenerationCallRecord[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    records = [];
    setGenerationUsageSink((r) => records.push(r));
    // 放行路径才会触达 fetch——默认桩成「一调即红」哨兵：被拦测试若误发请求即暴露。
    fetchMock = vi.fn(async () => {
      throw new Error('network must not be reached when budget gate blocks');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    setBudgetGate(undefined);
    setGenerationUsageSink(undefined);
    globalThis.fetch = ORIGINAL_FETCH;
  });

  // ── gate 判定族 ──

  it('checkBudgetGate：无 gate 恒放行（缺省 = 字节级无 gate 现行为）', () => {
    expect(checkBudgetGate()).toEqual({ allowed: true });
  });

  it('checkBudgetGate：gate allowed / blocked 判定原样透传', () => {
    setBudgetGate(() => ({ allowed: true }));
    expect(checkBudgetGate()).toEqual({ allowed: true });
    setBudgetGate(blockedGate(12.34, 10));
    expect(checkBudgetGate()).toEqual({ allowed: false, spentCny: 12.34, hardCapCny: 10 });
  });

  it('checkBudgetGate：gate 自身抛错 → 降级放行（best-effort——gate 故障不杀生成）', () => {
    setBudgetGate(() => {
      throw new Error('db boom');
    });
    expect(checkBudgetGate()).toEqual({ allowed: true });
  });

  it('setBudgetGate(undefined)：卸载还原恒放行（测试缝/回滚形态）', () => {
    setBudgetGate(blockedGate());
    expect(checkBudgetGate().allowed).toBe(false);
    setBudgetGate(undefined);
    expect(checkBudgetGate()).toEqual({ allowed: true });
  });

  it('BudgetExceededError：携带 spent/hardCap + 消息含指路信息；分类器归 budget/ineligible', () => {
    const err = new BudgetExceededError(25.5, 20);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.spentCny).toBe(25.5);
    expect(err.hardCapCny).toBe(20);
    expect(err.message).toContain('25.50');
    expect(err.message).toContain('20.00');
    expect(err.message).toContain('Settings');
    const classified = classifyGenerationFailure(err);
    expect(classified.kind).toBe('budget');
    expect(classified.eligible).toBe(false); // 账户级问题换模型不救——链不烧
  });

  // ── wrapper 族五入口前置门（被拦：落行 + 抛 + 零网络）──

  it('generateText 被拦：budget 失败行（token ABSENT / identity 全透传）+ 抛 BudgetExceededError + fetch 零触达', async () => {
    setBudgetGate(blockedGate());
    const err = await generateText(
      openaiModel(),
      { ...BASE_REQUEST, taskType: 'writer-draft', sessionKey: 'chain:abc1:writer' },
      { lane: 'background' },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(fetchMock).not.toHaveBeenCalled(); // 门在请求发起前——run 不执行
    expect(records).toHaveLength(1); // 失败不黑洞：被拦调用如实落账
    const rec = records[0]!;
    expect(rec.success).toBe(false);
    expect(rec.errorKind).toBe('budget');
    expect(rec.errorMessage).toContain('Monthly LLM budget exceeded');
    expectNoTokenKeys(rec);
    expect(rec.latencyMs).toBe(0); // 未发起请求
    expect(rec.stream).toBe(false);
    expect(rec.protocol).toBe('openai-compatible');
    expect(rec.keyId).toBe('k1');
    expect(rec.modelId).toBe('totally-unknown-model');
    expect(rec.taskType).toBe('writer-draft');
    expect(rec.lane).toBe('background');
    expect(rec.sessionKey).toBe('chain:abc1:writer');
    expect(typeof rec.callId).toBe('string'); // withLedgerCallContext 归一保证
  });

  it('generateTextStream 被拦：stream=true 失败行 + 抛（流式同门）', async () => {
    setBudgetGate(blockedGate());
    const err = await generateTextStream(openaiModel(), BASE_REQUEST, undefined, () => {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(records).toHaveLength(1);
    expect(records[0]!.stream).toBe(true);
    expect(records[0]!.errorKind).toBe('budget');
    expectNoTokenKeys(records[0]!);
  });

  it('generateEmbeddings 被拦：ctx.taskType 通道照落行 + 抛', async () => {
    setBudgetGate(blockedGate());
    const err = await generateEmbeddings(
      openaiModel(),
      { input: ['a', 'b'] },
      { taskType: 'kb-index-embed' },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(records).toHaveLength(1);
    expect(records[0]!.taskType).toBe('kb-index-embed');
    expect(records[0]!.errorKind).toBe('budget');
    expectNoTokenKeys(records[0]!);
  });

  it('generateImage 被拦：imageCount（request.n）失败行照带（请求侧事实与成败无关）+ 抛', async () => {
    setBudgetGate(blockedGate());
    const err = await generateImage(
      openaiModel(),
      { model: 'm', prompt: 'a cover', n: 3 },
      { taskType: 'image-gen' },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(records).toHaveLength(1);
    expect(records[0]!.imageCount).toBe(3);
    expect(records[0]!.errorKind).toBe('budget');
    expectNoTokenKeys(records[0]!);
  });

  it('rerank 被拦：同门同形态 + 抛', async () => {
    setBudgetGate(blockedGate());
    const err = await rerank(
      openaiModel(),
      { query: 'q', documents: ['d1', 'd2'] },
      { taskType: 'kb-rerank' },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(records).toHaveLength(1);
    expect(records[0]!.taskType).toBe('kb-rerank');
    expect(records[0]!.errorKind).toBe('budget');
  });

  // ── 放行路径（gate allowed / gate throw 降级 → 请求照常发起）──

  it('gate throw 降级放行：请求照常成功 + 成功行落账（wrapper 内无 budget 痕迹）', async () => {
    setBudgetGate(() => {
      throw new Error('prefs boom');
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const result = await generateText(openaiModel(), BASE_REQUEST);
    expect(result.text).toBe('hello');
    expect(records).toHaveLength(1);
    expect(records[0]!.success).toBe(true);
    expect(records[0]!.errorKind).toBeUndefined();
    expect(records[0]!.totalTokens).toBe(15);
  });

  it('gate blocked → 放行翻转（上限调大/清空后同进程恢复）', async () => {
    setBudgetGate(blockedGate());
    await generateText(openaiModel(), BASE_REQUEST).catch(() => undefined);
    expect(records[0]!.errorKind).toBe('budget');
    setBudgetGate(() => ({ allowed: true }));
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    await generateText(openaiModel(), BASE_REQUEST);
    expect(records).toHaveLength(2);
    expect(records[1]!.success).toBe(true);
  });
});
