import { describe, expect, it } from 'vitest';
import type { GenerationMessage, ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import {
  ProtocolContextOverflowError,
  ProtocolHttpError,
  ProtocolSchemaError,
  ProtocolTimeoutError,
} from '../src/errors';
import { classifyCliError, createAntigravityCliDriver, type AntigravityCliDriver } from '../src/antigravityCli/driver';
import { buildTurnSegments, composeTurnText, splitSystemMessages } from '../src/antigravityCli/compose';
import type { FakePoolEnv, FakeAgyProcess } from './antigravityCliFakes';
import { fakePoolEnv } from './antigravityCliFakes';

function cliModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'agy-key',
    modelId: 'gemini-3.8-pro-high',
    protocol: 'antigravity-cli',
    baseUrl: '',
    apiKey: '',
    capability: 'text',
    cliExecutable: 'C:\\agy\\bin\\agy.exe',
    ...overrides,
  };
}

function request(messages: GenerationMessage[], overrides: Partial<TextGenerationRequest> = {}): TextGenerationRequest {
  return {
    model: 'gemini-3.8-pro-high',
    messages,
    ...overrides,
  };
}

function parseWrittenLine(proc: FakeAgyProcess, index = 0): string {
  return (JSON.parse(proc.writtenLines[index]!) as { message: { content: string } }).message.content;
}

/** 组装期望 turn 文本（冷启动全量口径）。 */
function expectedFullTurn(req: TextGenerationRequest): string {
  const { system, rest } = splitSystemMessages(req.messages);
  return composeTurnText(buildTurnSegments(system, rest));
}

describe('antigravityCli driver（全链集成，fake 子进程事件流）', () => {
  it('冷启动全量：spawn 参数正确 + stdin 全量 turn + usage/文本映射 + 单发即弃', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('第一章正文', { input: 100, output: 20, thinking: 5, cache_read: 30 });
    });
    const driver: AntigravityCliDriver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: '写第一章' }], { sessionKey: 'chain:run-1' });

    const response = await driver.generateText(cliModel(), req);

    expect(env.spawns).toHaveLength(1);
    const proc = env.spawns[0]!;
    expect(proc.spawnArgs.executable).toBe('C:\\agy\\bin\\agy.exe');
    expect(proc.spawnArgs.args).toContain('--model');
    expect(proc.spawnArgs.args).toContain('gemini-3.8-pro-high');
    // 冷启动 turn = 指令块 + 全部消息段。
    expect(parseWrittenLine(proc)).toBe(expectedFullTurn(req));
    // 终帧映射。
    expect(response).toEqual({
      model: 'gemini-3.8-pro-high',
      text: '第一章正文',
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, thinkingTokens: 5, cacheReadTokens: 30 },
    });
    driver.dispose();
  });

  it('无 sessionKey = 单发冷路径：即用即弃（stdin 关停 + 目录清理）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 10, output: 2 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    await driver.generateText(cliModel(), request([{ role: 'user', content: 'hi' }]));
    expect(env.spawns).toHaveLength(1);
    expect(env.spawns[0]!.stdinEnded).toBe(true);
    expect(env.removedDirs).toContain(env.spawns[0]!.spawnArgs.cwd);
    driver.dispose();
  });

  it('tools 剥离：warn 含工具名清单，stdin turn 不含任何工具定义（design §5）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: '写作' }], {
      tools: [
        { type: 'function', function: { name: 'query_world', description: 'd', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'read_material', description: 'd', parameters: { type: 'object' } } },
      ],
    });
    const response = await driver.generateText(cliModel(), req);
    expect(response.text).toBe('ok'); // 调用完成（非 fail-loud）
    const warnText = env.warns.join('\n');
    expect(warnText).toContain('query_world');
    expect(warnText).toContain('read_material');
    // stdin 载荷零工具痕迹。
    const line = env.spawns[0]!.writtenLines[0]!;
    expect(line).not.toContain('query_world');
    expect(line).not.toContain('read_material');
    expect(line).not.toContain('"tools"');
  });

  it('tools 剥离 warn 路径防非 function 形态崩溃（CR-9）：垃圾形状标 unknown，调用照常完成', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    // agent 缝 `as any` 直调豁免 zod parse——运行时垃圾形状可抵达协议层。
    const garbageTools = [{ type: 'function' }] as unknown as TextGenerationRequest['tools'];
    const response = await driver.generateText(
      cliModel(),
      request([{ role: 'user', content: 'x' }], { tools: garbageTools }),
    );
    expect(response.text).toBe('ok');
    expect(env.warns.join('\n')).toContain('unknown');
  });

  it('thinking → --effort / lane → --print-timeout 进 spawn 参数', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    await driver.generateText(
      cliModel(),
      request([{ role: 'user', content: 'x' }], { lane: 'background', thinking: { level: 'high' } }),
    );
    const args = env.spawns[0]!.spawnArgs.args;
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('12m');
  });

  it('增量命中缓存：第 2 轮只发新增尾段（同进程，无冷重启）', async () => {
    const env = fakePoolEnv((proc) => {
      let turn = 0;
      proc.responder = () => {
        turn += 1;
        if (turn === 1) proc.scriptSuccessTurn('第一轮回答', { input: 5000, output: 100 });
        else proc.scriptSuccessTurn('第二轮回答', { input: 300, output: 80, cache_read: 4800 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const msgs1: GenerationMessage[] = [{ role: 'user', content: '第一问' }];
    const req1 = request(msgs1, { sessionKey: 'chain:r1' });
    const r1 = await driver.generateText(cliModel(), req1);
    expect(r1.text).toBe('第一轮回答');

    // 第 2 轮：历史追加（assistant 回答 + 新 user 消息）。
    const msgs2: GenerationMessage[] = [...msgs1, { role: 'assistant', content: '第一轮回答' }, { role: 'user', content: '第二问' }];
    const req2 = request(msgs2, { sessionKey: 'chain:r1' });
    const r2 = await driver.generateText(cliModel(), req2);
    expect(r2.text).toBe('第二轮回答');

    // 同进程（缓存命中路径的形态学证据）。
    expect(env.spawns).toHaveLength(1);
    const secondTurn = parseWrittenLine(env.spawns[0]!, 1);
    // 只含尾段：新 assistant + 新 user；不含旧首轮内容与指令块。
    expect(secondTurn).toContain('第一轮回答');
    expect(secondTurn).toContain('第二问');
    expect(secondTurn).not.toContain('第一问');
    expect(secondTurn).not.toContain('【系统指令】');
    expect(secondTurn).not.toContain('【输出要求】');
    // 第 2 轮 usage 带缓存读信号。
    expect(r2.usage?.cacheReadTokens).toBe(4800);
  });

  it('历史分歧（system 变化）→ 优雅关停旧进程 + 冷启动全量', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req1 = request([
      { role: 'system', content: '旧系统指令' },
      { role: 'user', content: '问' },
    ], { sessionKey: 's1' });
    await driver.generateText(cliModel(), req1);

    const req2 = request([
      { role: 'system', content: '新系统指令（压缩/改写后的历史）' },
      { role: 'user', content: '问' },
    ], { sessionKey: 's1' });
    await driver.generateText(cliModel(), req2);

    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.stdinEnded).toBe(true); // 优雅关停
    expect(env.spawns[0]!.killed).toBe(false);
    // 新进程冷启动 = 全量 turn。
    expect(parseWrittenLine(env.spawns[1]!)).toBe(expectedFullTurn(req2));
  });

  it('零尾段（重复请求，复核 M5）→ 冷重启全量重发，不静默复用旧 result', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('每次重新生成', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: '同一问' }], { sessionKey: 's1' });
    const r1 = await driver.generateText(cliModel(), req);
    const r2 = await driver.generateText(cliModel(), req);
    expect(r1.text).toBe('每次重新生成');
    expect(r2.text).toBe('每次重新生成'); // 重新生成（非复用）
    expect(env.spawns).toHaveLength(2); // 冷重启
    expect(parseWrittenLine(env.spawns[1]!)).toBe(expectedFullTurn(req)); // 全量重发
  });

  it('进程崩溃（exit 无 result）→ 502 + stderr 摘要 + 会话作废', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) {
          proc.emitStderr('agy: fatal boom');
          proc.exit(1);
        } else {
          proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
        }
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 's1' });
    await expect(driver.generateText(cliModel(), req)).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 502,
      bodyExcerpt: 'agy: fatal boom',
    });
    // 作废：下次冷启动新进程（新进程 responder 已在 spawn 脚本分支内置好）。
    const r = await driver.generateText(cliModel(), req);
    expect(r.text).toBe('ok');
    expect(env.spawns).toHaveLength(2);
    driver.dispose();
  });

  it('stdin 写失败（EPIPE）→ 502 + 作废', async () => {
    // spawn 即死（可执行闪退形态）——驱动器首条写行撞 EPIPE。
    const env = fakePoolEnv((proc) => {
      proc.exit(1);
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: 'a' }], { sessionKey: 's1' });
    await expect(driver.generateText(cliModel(), req)).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 502,
    });
    driver.dispose();
  });

  it('在途 turn abort → kill + 会话作废 + AbortError', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        /* 不回 result——turn 悬挂等 abort */
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const controller = new AbortController();
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 's1' });
    const pending = driver.generateText(cliModel(), req, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // 等 turn 真正进入执行（spawn 完成 + 写行完成 + abort 监听武装）再中止——
    // spawn 阶段就 abort 会被 acquire 的入口守卫直接拒绝（会话未启动、无需作废）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assertion;
    expect(env.spawns[0]!.killed).toBe(true);
    driver.dispose();
  });

  it('外层兜底超时（print-timeout + 60s）→ kill + ProtocolTimeoutError', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        /* 无 result：belt 到点 */
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 's1' });
    const pending = driver.generateText(cliModel(), req);
    const assertion = expect(pending).rejects.toBeInstanceOf(ProtocolTimeoutError);
    // 等驱动器进到 turn executor（belt 定时器已注册）再触发。
    await new Promise((resolve) => setTimeout(resolve, 0));
    // lane 缺省 → print-timeout 5m + 60s = 360s belt。
    env.fireTimers();
    await assertion;
    expect(env.spawns[0]!.killed).toBe(true);
    driver.dispose();
  });

  it('坏 JSON 行容忍：垃圾行后正常收敛 result', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitLine('garbage{{{');
        proc.emitLine('');
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '正' });
        proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '正文' });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(r.text).toBe('正文');
    driver.dispose();
  });

  it('CANCELED → abort 语义 + 作废会话（下次冷启动）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) proc.scriptErrorTurn('CANCELED', 'canceled by user');
        else proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 's1' });
    await expect(driver.generateText(cliModel(), req)).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.spawns[0]!.killed).toBe(true);
    const r = await driver.generateText(cliModel(), req);
    expect(r.text).toBe('ok');
    expect(env.spawns).toHaveLength(2);
    driver.dispose();
  });

  it('流式：text_delta 逐段外发 onDelta（顺序保持）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '第一' });
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '段' });
        proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '第一段' });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const deltas: Array<{ type: string; delta: string }> = [];
    const r = await driver.generateText(
      cliModel(),
      request([{ role: 'user', content: 'x' }]),
      undefined,
      (d) => deltas.push({ type: d.type, delta: d.delta }),
    );
    expect(deltas).toEqual([
      { type: 'text', delta: '第一' },
      { type: 'text', delta: '段' },
    ]);
    expect(r.text).toBe('第一段');
    driver.dispose();
  });

  it('cliExecutable 缺失 → 配置错（协议层防御）', async () => {
    const env = fakePoolEnv();
    const driver = createAntigravityCliDriver(env.deps);
    await expect(
      driver.generateText(cliModel({ cliExecutable: undefined }), request([{ role: 'user', content: 'x' }])),
    ).rejects.toMatchObject({ name: 'ProtocolHttpError', status: 500 });
    expect(env.spawns).toHaveLength(0);
    driver.dispose();
  });

  it('agy 自带工具步 → warn 观测（不中断 turn）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'grep_search' } });
        proc.emitEvent({ type: 'step_update', step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ok' });
        proc.emitEvent({ type: 'result', status: 'SUCCESS', response: 'ok' });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(r.text).toBe('ok');
    expect(env.warns.some((w) => w.includes('built-in tool'))).toBe(true);
    driver.dispose();
  });

  it('init 事件落观测 info：tools 数 / permission_mode / model（CR-17）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    const init = env.infos.find((m) => m.includes('process init'));
    expect(init).toBeDefined();
    expect(init).toContain('model=gemini-test');
    expect(init).toContain('permission_mode=request-review');
    expect(init).toContain('tools=0');
    driver.dispose();
  });

  it('未知 event 类型 → warn 观测（每类型每 turn 一次，CR-17）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitEvent({ type: 'checkpoint', something: true });
        proc.emitEvent({ type: 'checkpoint', something: true }); // 同类型第二次不刷
        proc.emitEvent({ type: 'future_event', x: 1 });
        proc.emitEvent({ type: 'result', status: 'SUCCESS', response: 'ok' });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(r.text).toBe('ok');
    expect(env.warns.filter((w) => w.includes("unknown stream event type 'checkpoint'"))).toHaveLength(1);
    expect(env.warns.some((w) => w.includes("unknown stream event type 'future_event'"))).toBe(true);
    driver.dispose();
  });

  it('usage 缺席字段：响应 usage 键 ABSENT——0 与未上报可分（CR-18）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input: 42, output: 7 } });
        proc.emitEvent({ type: 'result', status: 'SUCCESS', response: 'ok' });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(r.usage).toEqual({ promptTokens: 42, completionTokens: 7 });
    expect('thinkingTokens' in (r.usage ?? {})).toBe(false);
    expect('cacheReadTokens' in (r.usage ?? {})).toBe(false);
    expect('totalTokens' in (r.usage ?? {})).toBe(false);
    driver.dispose();
  });

  it('SUCCESS 空响应零 delta → 502（空白生成可检，CR-6）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '' });
    });
    const driver = createAntigravityCliDriver(env.deps);
    await expect(driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 502,
    });
    driver.dispose();
  });

  it('已退进程的退出观察同步回调不撞 TDZ——类型化 502 保持（CR-2）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.exit(1); // spawn 即死：setExitObserver 注册时进程已退 → sessions 同步回调路径
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 's1' });
    // 修复前：belt 后置 const 的 TDZ ReferenceError 顶掉类型化 502。
    await expect(driver.generateText(cliModel(), req)).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 502,
      message: expect.stringContaining('process exited'),
    });
    driver.dispose();
  });

  it('stdin 写阶段悬挂：外层兜底 belt 照常解救（CR-3——写阶段被看门狗罩住）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        /* 无 result：写悬挂 + belt 到点 */
      };
      proc.writeLine = () => new Promise(() => {}); // 背压写永不 resolve（挂死形态）
    });
    const driver = createAntigravityCliDriver(env.deps);
    const pending = driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }], { sessionKey: 's1' }));
    const assertion = expect(pending).rejects.toBeInstanceOf(ProtocolTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等 executor 武装 belt（写悬挂中）
    env.fireTimers();
    await assertion;
    expect(env.spawns[0]!.killed).toBe(true);
    driver.dispose();
  });

  it('stdin 写阶段悬挂：abort 解救（AbortError + kill，CR-3）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        /* 无 result */
      };
      proc.writeLine = () => new Promise(() => {});
    });
    const driver = createAntigravityCliDriver(env.deps);
    const controller = new AbortController();
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 's1' });
    const pending = driver.generateText(cliModel(), req, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等 abort 监听武装（写悬挂中）
    controller.abort();
    await assertion;
    expect(env.spawns[0]!.killed).toBe(true);
    driver.dispose();
  });

  it('onDelta 消费者 throw 不逃逸：warn 观测，turn 正常完成（CR-8）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('正文', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(
      cliModel(),
      request([{ role: 'user', content: 'x' }]),
      undefined,
      () => {
        throw new Error('consumer bug');
      },
    );
    expect(r.text).toBe('正文'); // 终帧正文以 result.response 为权威
    expect(env.warns.some((w) => w.includes('onDelta consumer threw'))).toBe(true);
    driver.dispose();
  });

  it('stderr 环形上限 ≈200KB：长诊断流只保尾部（CR-8）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitStderr('A'.repeat(150_000));
        proc.emitStderr('B'.repeat(150_000));
        proc.emitStderr('TAIL-MARK');
        proc.exit(1); // 退出无 result → 502 + stderr 尾部摘要
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const rejection = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }])).then(
      () => {
        throw new Error('expected rejection');
      },
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(ProtocolHttpError);
    const excerpt = (rejection as ProtocolHttpError).bodyExcerpt ?? '';
    expect(excerpt.endsWith('TAIL-MARK')).toBe(true);
    expect(excerpt.startsWith('B')).toBe(true); // 环形截尾后 150KB 的 A 段已丢弃
    expect(excerpt.length).toBeLessThanOrEqual(2_000);
    driver.dispose();
  });
});

describe('antigravityCli 错误分类表（design §3.7）', () => {
  it('authentication → 401', () => {
    const err = classifyCliError('authentication required', '');
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(401);
  });

  it('quota / rate limit → 429', () => {
    expect((classifyCliError('rate limit exceeded', '') as ProtocolHttpError).status).toBe(429);
    expect((classifyCliError('quota exceeded', '') as ProtocolHttpError).status).toBe(429);
  });

  it('invalid model → ProtocolSchemaError（配置错，不可回退类）', () => {
    expect(classifyCliError('invalid model selection: foo', '')).toBeInstanceOf(ProtocolSchemaError);
  });

  it('context overflow 短语族 → ProtocolContextOverflowError（runLoop 压缩重试兼容）', () => {
    expect(classifyCliError('prompt is too long: context_length_exceeded', '')).toBeInstanceOf(ProtocolContextOverflowError);
    expect(classifyCliError('this exceeds the context window', '')).toBeInstanceOf(ProtocolContextOverflowError);
  });

  it('其余 ERROR → 502 兜底', () => {
    const err = classifyCliError('something broke', 'stderr tail');
    expect((err as ProtocolHttpError).status).toBe(502);
    expect((err as ProtocolHttpError).bodyExcerpt).toBe('stderr tail');
  });
});
