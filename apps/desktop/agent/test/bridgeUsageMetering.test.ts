import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeExecutorOptions } from '../src/agent/bridgeExecutor';
import {
  __clearBridgeSeamsForTest,
  __getBridgeUsageSinkForTest,
  runBridgeExecutor,
  setBridgeTurnFn,
  setBridgeUsageSink,
  type BridgeTurnOutcome,
  type BridgeUsageRecord,
} from '../src/agent/bridgeExecutor';

// ── C3.1 W2b：桥车道第 4 计量面（B1）——桥 turn settle 发射缝单测（stub sink）──
//
// 覆盖面（implement.md W2b 测试项）：成功/失败各恰一行（usage 已知则记 / 未知 ABSENT——
// CR-18 两态）；失败分类 mirror 词表（abort/auth/quota/timeout/server/other）；未装配
// no-op 零行为 + sink 抛错零影响；两车道 taskType 各自正确（dialogue / 未来链桥 chain）；
// sessionKey/sessionId 照实到达 + callId 每 turn 一枚。
// 装配端到端（sink → insertUsageLog → closure_llm_log 落表）在 shell usageLedgerWiring
// 真跑——本文件只钉 agent 缝自身语义。

function makeOutcome(overrides: Partial<BridgeTurnOutcome> = {}): BridgeTurnOutcome {
  return {
    text: '终文。',
    usage: undefined,
    presentResultCalled: false,
    presentResultAwaiting: undefined,
    sentBack: false,
    secondPassMissedPresentResult: false,
    mcpSoftDenied: false,
    bridgeToolCalls: 0,
    ...overrides,
  };
}

function executorOpts(overrides: Partial<BridgeExecutorOptions> = {}): BridgeExecutorOptions {
  return {
    sessionId: 'sess-1',
    projectPath: 'C:/proj',
    messages: [],
    systemPrompt: 'SYSTEM',
    tools: [],
    modelRef: { keyId: 'k1', modelId: 'm1' },
    sessionKey: 'dialogue:sess-1',
    permissionMode: 'suggest',
    behaviorMode: undefined,
    abort: new AbortController().signal,
    onMessage: () => {},
    ...overrides,
  };
}

afterEach(() => {
  __clearBridgeSeamsForTest();
});

describe('桥 turn 计量发射缝（C3.1 W2b）', () => {
  it('成功行：usage 在场 → token 如实映射；taskType/sessionKey/sessionId/callId 照实', async () => {
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    setBridgeTurnFn(async () =>
      makeOutcome({ usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } }));
    const result = await runBridgeExecutor(executorOpts({ taskType: 'bridge-dialogue' }));

    expect(result.map((m) => m.role)).toEqual(['assistant']); // turn 结果零变化
    expect(records).toHaveLength(1); // 成功恰一行
    const rec = records[0]!;
    expect(rec.protocol).toBe('antigravity-cli');
    expect(rec.keyId).toBe('k1');
    expect(rec.modelId).toBe('m1');
    expect(rec.taskType).toBe('bridge-dialogue');
    expect(rec.sessionKey).toBe('dialogue:sess-1');
    expect(rec.sessionId).toBe('sess-1');
    expect(typeof rec.callId).toBe('string');
    expect(rec.callId!.length).toBeGreaterThan(0);
    expect(rec.stream).toBe(false);
    expect(rec.success).toBe(true);
    expect(rec.inputTokens).toBe(11);
    expect(rec.outputTokens).toBe(7);
    expect(rec.totalTokens).toBe(18);
    expect(rec.errorKind).toBeUndefined(); // 成功行 ABSENT
    expect(rec.errorMessage).toBeUndefined();
    expect(typeof rec.latencyMs).toBe('number');
    expect(rec.latencyMs).toBeGreaterThanOrEqual(0); // m1：发射点计时必填不悬空
  });

  it('成功行 usage 缺席 → token 键 ABSENT（≠0，两态纪律）；usage 分量部分在场 → 只带在场的', async () => {
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    setBridgeTurnFn(async () => makeOutcome()); // usage: undefined
    await runBridgeExecutor(executorOpts());

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(true);
    expect('inputTokens' in rec).toBe(false);
    expect('outputTokens' in rec).toBe(false);
    expect('thinkingTokens' in rec).toBe(false);
    expect('cacheReadTokens' in rec).toBe(false);
    expect('totalTokens' in rec).toBe(false);

    records.length = 0;
    setBridgeTurnFn(async () => makeOutcome({ usage: { promptTokens: 5 } })); // 只报 prompt
    await runBridgeExecutor(executorOpts());
    expect(records[0]!.inputTokens).toBe(5);
    expect('totalTokens' in records[0]!).toBe(false); // 缺席不合成（CR-18）
  });

  it('失败行：turn 拒绝 → 恰一行 success=false + errorKind other + token ABSENT + 错误原样重抛', async () => {
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    setBridgeTurnFn(async () => {
      throw new Error('桥循环失败');
    });
    await expect(runBridgeExecutor(executorOpts({ taskType: 'bridge-dialogue' }))).rejects.toThrow(
      '桥循环失败',
    );

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.success).toBe(false);
    expect(rec.errorKind).toBe('other'); // 非 HTTP 形态保守归 other
    expect(rec.errorMessage).toBe('桥循环失败');
    expect('inputTokens' in rec).toBe(false); // 失败 usage 未知 → ABSENT
    expect('totalTokens' in rec).toBe(false);
    expect(rec.taskType).toBe('bridge-dialogue'); // 失败行同样携带标注
    expect(rec.sessionKey).toBe('dialogue:sess-1');
  });

  it('失败分类 mirror 词表：HTTP status duck-type（auth/quota/timeout/server/other）+ timeout/network 族（CR-3）+ abort 两形态', async () => {
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    const cases: Array<{ err: unknown; abortBySignal?: boolean; want: string }> = [
      { err: Object.assign(new Error('x'), { status: 401 }), want: 'auth' },
      { err: Object.assign(new Error('x'), { status: 403 }), want: 'auth' },
      { err: Object.assign(new Error('x'), { status: 429 }), want: 'quota' },
      { err: Object.assign(new Error('x'), { status: 402 }), want: 'quota' },
      { err: Object.assign(new Error('x'), { status: 408 }), want: 'timeout' },
      { err: Object.assign(new Error('x'), { status: 502 }), want: 'server' },
      { err: Object.assign(new Error('x'), { status: 400 }), want: 'other' },
      { err: new Error('no status shape'), want: 'other' },
      // CR-3（C3.1 复核）补族：timeout = ProtocolTimeoutError name duck 判（零
      // model-protocols import）；network = TypeError 本体 / cause 链保守判。
      { err: Object.assign(new Error('first-event window elapsed'), { name: 'ProtocolTimeoutError' }), want: 'timeout' },
      { err: new TypeError('fetch failed'), want: 'network' },
      {
        // cause 链形态：外层包装 Error（消息无签名）→ 内层 TypeError('fetch failed')。
        err: Object.assign(new Error('request failed'), { cause: new TypeError('fetch failed') }),
        want: 'network',
      },
      {
        // undici 连接超时命名形态（嵌在 cause 链上）。
        err: Object.assign(new Error('wrapped'), {
          cause: Object.assign(new Error('connect timeout'), { name: 'ConnectTimeoutError' }),
        }),
        want: 'network',
      },
      // 信号已断 + 错误形态非 AbortError → 按 abort 语义归类（CR-3 同形态：kill 级联下
      // exit-observer 的 502 可能先于 abort listener settle，错误形态不可信）。
      { err: new Error('exit-observer 502'), abortBySignal: true, want: 'abort' },
      // AbortError 形态错误（信号未断）→ 同 abort。
      { err: Object.assign(new Error('x'), { name: 'AbortError' }), want: 'abort' },
    ];
    for (const c of cases) {
      records.length = 0;
      setBridgeTurnFn(async () => {
        throw c.err;
      });
      const opts = executorOpts();
      if (c.abortBySignal) {
        const ctrl = new AbortController();
        ctrl.abort();
        opts.abort = ctrl.signal;
      }
      await expect(runBridgeExecutor(opts)).rejects.toBeDefined();
      expect(records[0]!.success).toBe(false);
      expect(records[0]!.errorKind).toBe(c.want);
    }
  });

  it('stream 两态照实（CR-2）：emitDelta 在场 = 流式行（成功/失败两发射点同判）；缺席 = 非流', async () => {
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    setBridgeTurnFn(async () => makeOutcome({ text: '终文。' }));

    // emitDelta 在场 → 桥行 stream=true（成功发射点）。
    await runBridgeExecutor(executorOpts({ emitDelta: () => {} }));
    expect(records[0]!.stream).toBe(true);

    // emitDelta 缺席（测试直调形态）→ 非流（既有断言同面）。
    await runBridgeExecutor(executorOpts());
    expect(records[1]!.stream).toBe(false);

    // 失败发射点同判：emitDelta 在场 + turn 失败 → 失败行 stream=true。
    setBridgeTurnFn(async () => {
      throw new Error('流式车道桥失败');
    });
    await expect(runBridgeExecutor(executorOpts({ emitDelta: () => {} }))).rejects.toThrow('流式车道桥失败');
    expect(records[2]!.success).toBe(false);
    expect(records[2]!.stream).toBe(true);
  });

  it('未装配 no-op：缺省零发射零行为（turn 正常完成）；setBridgeUsageSink(undefined) 同', async () => {
    // 缺省（未 set）——探针 undefined + turn 正常完成。
    expect(__getBridgeUsageSinkForTest()).toBeUndefined();
    setBridgeTurnFn(async () => makeOutcome({ text: '正文。' }));
    const result = await runBridgeExecutor(executorOpts());
    expect(result.map((m) => m.role)).toEqual(['assistant']);

    // 显式卸载同形。
    setBridgeUsageSink(undefined);
    await expect(runBridgeExecutor(executorOpts())).resolves.toBeDefined();
  });

  it('sink 抛错 → best-effort 不阻 turn（成功结果照常返回；失败路径错误语义不变）', async () => {
    setBridgeUsageSink(() => {
      throw new Error('sink boom');
    });
    setBridgeTurnFn(async () => makeOutcome({ text: '正文。' }));
    const result = await runBridgeExecutor(executorOpts());
    expect(result.map((m) => m.role)).toEqual(['assistant']); // 成功路径不受影响

    // 失败路径：sink 抛错不顶替原错误。
    setBridgeTurnFn(async () => {
      throw new Error('原始失败');
    });
    await expect(runBridgeExecutor(executorOpts())).rejects.toThrow('原始失败');
  });

  it('两车道 taskType 各自正确（装配点逐点标注——dialogue / 链桥 chain）', async () => {
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    setBridgeTurnFn(async () => makeOutcome());

    await runBridgeExecutor(executorOpts({ taskType: 'bridge-dialogue', sessionKey: 'dialogue:sess-1' }));
    await runBridgeExecutor(executorOpts({ taskType: 'bridge-chain', sessionKey: 'chain:abc1:writer' }));

    expect(records.map((r) => r.taskType)).toEqual(['bridge-dialogue', 'bridge-chain']);
    expect(records.map((r) => r.sessionKey)).toEqual(['dialogue:sess-1', 'chain:abc1:writer']);
  });

  it('callId 每 turn 一枚（两 turn 两枚不同、均非空）；未标注 taskType → 键 ABSENT', async () => {
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    setBridgeTurnFn(async () => makeOutcome());

    await runBridgeExecutor(executorOpts());
    await runBridgeExecutor(executorOpts());

    expect(records).toHaveLength(2);
    expect(records[0]!.callId).toBeTruthy();
    expect(records[1]!.callId).toBeTruthy();
    expect(records[0]!.callId).not.toBe(records[1]!.callId);
    expect('taskType' in records[0]!).toBe(false); // 未标注 = NULL 组（键不出现）
  });

  it('errorMessage ≤500 截断（error_message 列口径同族）；modelRef 缺省 → default 哨兵与 turn 请求同源', async () => {
    const requests: Array<{ keyId: string; modelId: string }> = [];
    const records: BridgeUsageRecord[] = [];
    setBridgeUsageSink((rec) => records.push(rec));
    setBridgeTurnFn(async (req) => {
      requests.push(req.modelRef);
      throw new Error('x'.repeat(1200));
    });
    await expect(runBridgeExecutor(executorOpts({ modelRef: undefined }))).rejects.toThrow();

    expect(requests[0]).toEqual({ keyId: 'default', modelId: 'default' }); // turn 请求哨兵
    expect(records[0]!.keyId).toBe('default'); // 计量行同源
    expect(records[0]!.modelId).toBe('default');
    expect(records[0]!.errorMessage).toHaveLength(500);
  });
});
