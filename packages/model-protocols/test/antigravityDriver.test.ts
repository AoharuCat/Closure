import { describe, expect, it } from 'vitest';
import type { GenerationMessage, ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import {
  ProtocolContextOverflowError,
  ProtocolHttpError,
  ProtocolSchemaError,
  ProtocolTimeoutError,
} from '../src/errors';
import { classifyCliError, createAntigravityCliDriver, isBuiltinToolAutoDeny, type AntigravityCliDriver } from '../src/antigravityCli/driver';
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

  it('空 SUCCESS 单次重试：首轮空 → 重试整 turn 成功（会话车道，冷重启全量重发）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '' });
        else proc.scriptSuccessTurn('重试后的正文', { input: 1, output: 1 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 's1' });
    const r = await driver.generateText(cliModel(), req);
    expect(r.text).toBe('重试后的正文');
    // 重试 = 首轮镜像已提交 → 零尾段分歧 → 冷重启新进程全量重发（同 spec 全新尝试）。
    expect(env.spawns).toHaveLength(2);
    expect(parseWrittenLine(env.spawns[1]!)).toBe(expectedFullTurn(req));
    // 重试前恰一条观测 warn。
    expect(env.warns.filter((w) => w.includes('retrying the whole turn once'))).toHaveLength(1);
    driver.dispose();
  });

  it('空 SUCCESS 单次重试：oneshot 车道同过此缝（即用即弃形态保持）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '' });
        else proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(r.text).toBe('ok');
    expect(env.spawns).toHaveLength(2);
    // oneshot 收尾形态不变：两个进程都优雅关停 + 临时目录清理。
    expect(env.spawns.every((p) => p.stdinEnded)).toBe(true);
    expect(env.removedDirs).toContain(env.spawns[1]!.spawnArgs.cwd);
    driver.dispose();
  });

  it('空 SUCCESS 重试恰一次：两次都空 → 现行 502 空响应错误原样上抛', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '' });
    });
    const driver = createAntigravityCliDriver(env.deps);
    await expect(driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 502,
      message: 'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
    });
    expect(env.spawns).toHaveLength(2);
    expect(env.warns.filter((w) => w.includes('retrying the whole turn once'))).toHaveLength(1);
    driver.dispose();
  });

  it('认证以空 SUCCESS 终态（F3 形态）不重试：401 指引即时上抛，不烧第二轮', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitStderr('status: 401\n');
        proc.emitStderr('error: authentication failed or timed out\n');
        proc.emitEvent({ type: 'result', conversation_id: 'conv-1', status: 'SUCCESS', response: '' });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    await expect(driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 401,
    });
    expect(env.spawns).toHaveLength(1);
    expect(env.warns.some((w) => w.includes('retrying the whole turn once'))).toBe(false);
    driver.dispose();
  });

  it('内置工具自动拒的空 SUCCESS 照常重试：重试拿到正文则 412 不再出现', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const isFirst = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (isFirst) {
          proc.emitStderr(
            'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n',
          );
          proc.emitEvent({ type: 'result', conversation_id: 'conv-1', status: 'SUCCESS', response: '' });
        } else {
          proc.scriptSuccessTurn('正文照常', { input: 1, output: 1 });
        }
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(r.text).toBe('正文照常');
    expect(env.spawns).toHaveLength(2);
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

  it('认证失败以 SUCCESS 空响应终态（F3）→ 认证错误 401 + 指引，非空响应谜语', async () => {
    // 真机形态：agy 凭据失效 → stderr 打登录引导 + 60s 等待超时 → 仍以 SUCCESS
    // 收尾零文本。stderr 先于 result 到达（分类缝全文可见）。
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitStderr('status: 401\n');
        proc.emitStderr('Authentication required. Please visit the URL to log in: https://example.invalid\n');
        proc.emitStderr('Waiting for authentication (timeout 60s)…\n');
        proc.emitStderr('Error: authentication timed out.\n');
        proc.emitStderr('error: authentication failed or timed out\n');
        proc.emitEvent({ type: 'result', conversation_id: 'conv-1', status: 'SUCCESS', response: '' });
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
    expect((rejection as ProtocolHttpError).status).toBe(401);
    expect((rejection as ProtocolHttpError).message).toContain('terminal');
    expect((rejection as ProtocolHttpError).message).not.toContain('produced no response text');
    // stderr 原文保留在 excerpt 作证据。
    expect((rejection as ProtocolHttpError).bodyExcerpt).toContain('authentication failed or timed out');
    driver.dispose();
  });

  it('SUCCESS 空响应且 stderr 无认证信号 → 空响应守卫原样兜底（502 谜语原文保留）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitStderr('unrelated chatter\n');
        proc.emitEvent({ type: 'result', conversation_id: 'conv-1', status: 'SUCCESS', response: '' });
      };
    });
    const driver = createAntigravityCliDriver(env.deps);
    await expect(driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]))).rejects.toMatchObject({
      name: 'ProtocolHttpError',
      status: 502,
      message: 'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
    });
    driver.dispose();
  });

  it('内置工具权限自动拒以 SUCCESS 空响应终态 → 412 能力指引，非空响应谜语', async () => {
    // 真机形态：消息带「引用文件+路径」块 → 模型改用内置工具读文件 → headless 弹不出
    // 权限窗自动拒绝 → stderr 打 jetski 通知，agy 仍以 SUCCESS 零文本收尾。
    const env = fakePoolEnv((proc) => {
      proc.responder = () => {
        proc.emitStderr(
          'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n',
        );
        proc.emitEvent({ type: 'result', conversation_id: 'conv-1', status: 'SUCCESS', response: '' });
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
    expect((rejection as ProtocolHttpError).status).toBe(412);
    expect((rejection as ProtocolHttpError).message).toContain('built-in agy tool');
    expect((rejection as ProtocolHttpError).message).toContain('MCP bridge tools');
    expect((rejection as ProtocolHttpError).message).not.toContain('produced no response text');
    // stderr 原文通知保留在 excerpt 作证据（与认证落法同口径）。
    expect((rejection as ProtocolHttpError).bodyExcerpt).toContain('auto-denied');
    driver.dispose();
  });
});

describe('antigravityCli 错误分类表（design §3.7）', () => {
  it('authentication → 401 + 人话指引（message 不再透传原始终态文本）', () => {
    const err = classifyCliError('authentication required', '');
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(401);
    expect((err as ProtocolHttpError).message).toContain('terminal');
  });

  it('SUCCESS 零文本终态 + stderr 认证信号 → 认证错误（三类信号逐一命中，非空响应谜语）', () => {
    const emptyBoilerplate =
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)';
    const signals = [
      'Authentication required. Please visit the URL to log in: https://example.invalid',
      'error: authentication failed or timed out',
      'status: 401',
    ];
    for (const signal of signals) {
      const err = classifyCliError(emptyBoilerplate, signal);
      expect(err).toBeInstanceOf(ProtocolHttpError);
      expect((err as ProtocolHttpError).status).toBe(401);
      expect((err as ProtocolHttpError).message).toContain('terminal');
      expect((err as ProtocolHttpError).message).toContain('agy');
      expect((err as ProtocolHttpError).message).not.toContain('produced no response text');
      expect((err as ProtocolHttpError).bodyExcerpt).toBe(signal);
    }
  });

  it('SUCCESS 零文本终态 + stderr 无认证信号 → 泛化空响应兜底不变（502 原文透传）', () => {
    const emptyBoilerplate =
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)';
    const err = classifyCliError(emptyBoilerplate, 'some unrelated stderr chatter');
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(502);
    expect((err as ProtocolHttpError).message).toBe(emptyBoilerplate);
  });

  it('SUCCESS 零文本终态 + stderr 内置工具拒绝信号 → 412 能力指引（三信号逐一命中，非空响应谜语）', () => {
    const emptyBoilerplate =
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)';
    // 真机 jetski 通知原形 + 两个稳定子串单独命中形态。
    const signals = [
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
      'a tool was auto-denied',
      'that headless mode cannot prompt for',
    ];
    for (const signal of signals) {
      const err = classifyCliError(emptyBoilerplate, signal);
      expect(err).toBeInstanceOf(ProtocolHttpError);
      expect((err as ProtocolHttpError).status).toBe(412);
      expect((err as ProtocolHttpError).message).toContain('built-in agy tool');
      expect((err as ProtocolHttpError).message).toContain('MCP bridge tools');
      expect((err as ProtocolHttpError).message).not.toContain('produced no response text');
      expect((err as ProtocolHttpError).bodyExcerpt).toBe(signal);
    }
  });

  it('R6/F9 主语分派（两向 + 防过度匹配）：mcp 主体走 MCP 专属行 / 内置主体走内置行 / 无主体文本皆不命中', () => {
    const emptyBoilerplate =
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)';
    // ① MCP 主体软拒（F9 反向）：'mcp' 主体 → **MCP 专属合成 412 行**（会话授权事实，
    // 不烧链）——文案指向 MCP 预授权出路；绝不落内置工具指引（旧针的归因错误）。
    const mcpSoftDeny = classifyCliError(
      emptyBoilerplate,
      'jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. mcp(<target>)).',
    );
    expect(mcpSoftDeny).toBeInstanceOf(ProtocolHttpError);
    expect((mcpSoftDeny as ProtocolHttpError).status).toBe(412);
    expect((mcpSoftDeny as ProtocolHttpError).message).toContain('MCP');
    expect((mcpSoftDeny as ProtocolHttpError).message).toContain('pre-authorization');
    expect((mcpSoftDeny as ProtocolHttpError).message).not.toContain('built-in agy tool');
    expect((mcpSoftDeny as ProtocolHttpError).message).not.toContain('produced no response text');
    expect((mcpSoftDeny as ProtocolHttpError).bodyExcerpt).toContain('"mcp" permission');
    // ② 内置工具主体（F13 形态——error.message 前缀取名）：仍走内置工具 412 族（行为不变）。
    const builtinDeny = classifyCliError(
      'something broke',
      'step 2: permission check failed for read_file "C:/tmp/x": user denied permission for read_file(C:/tmp/x)',
    );
    expect(builtinDeny).toBeInstanceOf(ProtocolHttpError);
    expect((builtinDeny as ProtocolHttpError).status).toBe(412);
    expect((builtinDeny as ProtocolHttpError).message).toContain('built-in agy tool');
    expect((builtinDeny as ProtocolHttpError).message).not.toContain('pre-authorization');
    // ③ 两族皆不匹配的无主体文本 → 502 兜底原语义（防过度匹配）。
    expect((classifyCliError('something broke', 'some unrelated stderr chatter') as ProtocolHttpError).status).toBe(502);
  });

  it('CR-3 主体优先级（去装饰 + MCP 优先）：族谓词与行分派两处共用同一规则，不落内置工具族', () => {
    // ① 装饰主体（stderr 引号内带括号/斜杠装饰）→ 归一到 'mcp'：旧行为会把它当内置主体。
    const decorated = 'jetski: no output produced — a tool required the "mcp(novel-writing/*)" permission that headless mode cannot prompt for, so it was auto-denied.';
    expect(isBuiltinToolAutoDeny(decorated)).toBe(false);
    const decoratedErr = classifyCliError('something broke', decorated);
    expect((decoratedErr as ProtocolHttpError).status).toBe(412);
    expect((decoratedErr as ProtocolHttpError).message).toContain('pre-authorization');
    expect((decoratedErr as ProtocolHttpError).message).not.toContain('built-in agy tool');
    // ② 混合 haystack（内置主体 + MCP 主体各在一条形态里）→ MCP 行（判据与文本顺序无关，
    // 两形态同时命中时不得「首次命中胜出」——那会让归因随样本顺序静默翻转）。
    const mixed = [
      'step 2: permission check failed for read_file "C:/tmp/x": user denied permission for read_file(C:/tmp/x)',
      'jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.',
    ].join('\n');
    expect(isBuiltinToolAutoDeny(mixed)).toBe(false);
    const mixedErr = classifyCliError('something broke', mixed);
    expect((mixedErr as ProtocolHttpError).status).toBe(412);
    expect((mixedErr as ProtocolHttpError).message).toContain('pre-authorization');
    expect((mixedErr as ProtocolHttpError).message).not.toContain('built-in agy tool');
    // ③ 反向排布同判（MCP 在前/内置在后）——优先级是显式规则，不是位置。
    const mixedReversed = [
      'permission check failed for mcp "novel-writing/write_chapter": denied',
      'jetski: a tool required the "command" permission that headless mode cannot prompt for',
    ].join('\n');
    expect(isBuiltinToolAutoDeny(mixedReversed)).toBe(false);
    // ④ 只有内置主体时族谓词照旧为真（优先级不吞非 mcp 形态）。
    expect(isBuiltinToolAutoDeny('permission check failed for read_file "C:/tmp/x": denied')).toBe(true);
  });

  it('判定顺序：认证 > 内置工具拒绝（一条 stderr 同含两类信号，认证更终结优先）', () => {
    const err = classifyCliError(
      'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\nstatus: 401',
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(401);
    expect((err as ProtocolHttpError).message).toContain('terminal');
  });

  it('判定顺序：瞬态（quota）> 内置工具拒绝——turn 真死于 quota 时照常 429（链可推进）', () => {
    const err = classifyCliError(
      'rate limit exceeded',
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
    );
    expect(err).toBeInstanceOf(ProtocolHttpError);
    expect((err as ProtocolHttpError).status).toBe(429);
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
