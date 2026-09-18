import { describe, expect, it } from 'vitest';
import {
  addCliUsage,
  applyCliLine,
  createCliTurnAccumulator,
  emptyCliUsage,
  finishCliTurn,
} from '../src/antigravityCli/events';
// 软拒 matcher 与 denied_actions 谓词住 bridgeTurn（消费侧单源）——本文件以 W0 样本钉其判据。
import { hasMcpDeniedAction, isMcpSoftDenyToolError } from '../src/antigravityCli/bridgeTurn';

function feed(lines: string[]) {
  let acc = createCliTurnAccumulator();
  const deltas: string[] = [];
  const toolSteps: number[] = [];
  const inits: string[] = [];
  const unknowns: string[] = [];
  for (const line of lines) {
    const applied = applyCliLine(acc, line);
    acc = applied.acc;
    if (applied.effect?.textDelta !== undefined) deltas.push(applied.effect.textDelta);
    if (applied.effect?.toolStepStarted !== undefined) toolSteps.push(applied.effect.toolStepStarted.stepIndex);
    if (applied.effect?.init !== undefined) inits.push(JSON.stringify(applied.effect.init));
    if (applied.effect?.unknownEvent !== undefined) unknowns.push(applied.effect.unknownEvent.type);
  }
  return { acc, deltas, toolSteps, inits, unknowns };
}

describe('antigravityCli events reducer', () => {
  it('init 观测 effect（tools 数/permission_mode/model，CR-17）→ result SUCCESS 聚合', () => {
    const { acc, deltas, inits, outcome } = (() => {
      const fed = feed([
        JSON.stringify({ type: 'init', tools: ['a', 'b'], permission_mode: 'request-review', model: 'gemini-3.8-pro-high' }),
        JSON.stringify({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '你好' }),
        JSON.stringify({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '，世界' }),
        JSON.stringify({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '你好，世界', num_turns: 1 }),
      ]);
      return { ...fed, outcome: finishCliTurn(fed.acc) };
    })();

    expect(inits).toEqual([JSON.stringify({ toolsCount: 2, permissionMode: 'request-review', model: 'gemini-3.8-pro-high' })]);
    expect(deltas).toEqual(['你好', '，世界']);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.text).toBe('你好，世界'); // result.response 权威全文
      expect(outcome.sawStepUsage).toBe(false);
    }
    // init 不再改动聚合器（观测走 effect——死状态 sawInit/initModel 已删）。
    expect(acc.result?.conversationId).toBe('c1');
  });

  it('usage 口径：单 turn 记账 = 全部 step DONE 求和（缺席字段保持缺席，CR-18）', () => {
    const { acc, outcome } = (() => {
      const fed = feed([
        JSON.stringify({
          type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response',
          usage: { input: 13116, output: 100, thinking: 20, cache_read: 0, total: 13236 },
        }),
        JSON.stringify({
          type: 'step_update', step_index: 2, state: 'DONE', step_type: 'tool',
          usage: { input: 50, output: 10, thinking: 0, cache_read: 0, total: 60 },
        }),
        JSON.stringify({
          type: 'step_update', step_index: 3, state: 'DONE', step_type: 'agent_response',
          usage: { input: 13272, output: 200, thinking: 40, cache_read: 49043, total: 13512 },
        }),
        // result.usage = 会话累计——无 per-call 消费者，不进聚合器（CR-17 删除）。
        JSON.stringify({
          type: 'result', status: 'SUCCESS', response: 'ok',
          usage: { input: 99999, output: 310, thinking: 60, cache_read: 49043, total: 99999 },
        }),
      ]);
      return { ...fed, outcome: finishCliTurn(fed.acc) };
    })();

    expect(acc.stepUsageSum).toEqual({ input: 26438, output: 310, thinking: 60, cacheRead: 49043, total: 26808 });
    // 26438 = 13116+50+13272（三步求和）；cacheRead 只计 step 求和一次（result 不重复计入）。
    expect(acc.stepUsageSum.cacheRead).toBe(49043);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.usage.input).toBe(26438);
      expect(outcome.usage.thinking).toBe(60);
      expect(outcome.sawStepUsage).toBe(true);
    }
  });

  it('usage 零伪造（CR-18）：未上报计数器保持 undefined 不补 0（0 与未知可分）', () => {
    const fed = feed([
      // agy 只报了 input/output——thinking/cache_read/total 未上报。
      JSON.stringify({
        type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response',
        usage: { input: 13116, output: 29 },
      }),
      JSON.stringify({ type: 'result', status: 'SUCCESS', response: 'ok' }),
    ]);
    const { acc } = fed;
    const outcome = finishCliTurn(fed.acc);
    expect(acc.stepUsageSum).toEqual({ input: 13116, output: 29, thinking: undefined, cacheRead: undefined, total: undefined });
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.usage.thinking).toBeUndefined();
      expect(outcome.usage.cacheRead).toBeUndefined();
      expect(outcome.usage.total).toBeUndefined();
      // 实报 0 与未上报仍可分。
      expect(outcome.usage.input).toBe(13116);
    }

    // usage 对象全垃圾（非数值）→ 视同未上报（不进求和、不置 sawStepUsage）。
    const garbage = feed([
      JSON.stringify({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input: 'x' } }),
      JSON.stringify({ type: 'result', status: 'SUCCESS', response: 'ok' }),
    ]);
    expect(garbage.acc.sawStepUsage).toBe(false);
  });

  it('tool 步 ACTIVE → toolStepStarted effect（观测不中断）；DONE 无 delta 不重复计文本', () => {
    const { toolSteps, deltas } = feed([
      JSON.stringify({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'grep_search' } }),
      JSON.stringify({ type: 'step_update', step_index: 2, state: 'DONE', step_type: 'tool', usage: { input: 5, total: 5 } }),
    ]);
    expect(toolSteps).toEqual([2]);
    expect(deltas).toEqual([]);
  });

  it('终态分类：ERROR → error；CANCELED/INTERRUPTED → canceled；WAITING/RUNNING/INVALID → error', () => {
    const err = feed([JSON.stringify({ type: 'result', status: 'ERROR', response: 'quota exceeded' })]);
    expect(finishCliTurn(err.acc)).toMatchObject({ kind: 'error', status: 'ERROR', message: 'quota exceeded' });

    const canceled = feed([JSON.stringify({ type: 'result', status: 'CANCELED' })]);
    expect(finishCliTurn(canceled.acc).kind).toBe('canceled');

    const interrupted = feed([JSON.stringify({ type: 'result', status: 'INTERRUPTED' })]);
    expect(finishCliTurn(interrupted.acc).kind).toBe('canceled');

    const waiting = feed([JSON.stringify({ type: 'result', status: 'WAITING' })]);
    expect(finishCliTurn(waiting.acc)).toMatchObject({ kind: 'error', status: 'WAITING' });

    const none = feed([]);
    expect(finishCliTurn(none.acc).kind).toBe('no-result');
  });

  it('SUCCESS 空响应（CR-6）：空/缺席/纯空白 response 且零 delta → error EMPTY（不静默空成功）', () => {
    const empty = feed([JSON.stringify({ type: 'result', status: 'SUCCESS', response: '' })]);
    expect(finishCliTurn(empty.acc)).toMatchObject({ kind: 'error', status: 'EMPTY' });

    const absent = feed([JSON.stringify({ type: 'result', status: 'SUCCESS' })]);
    expect(finishCliTurn(absent.acc)).toMatchObject({ kind: 'error', status: 'EMPTY' });

    const whitespace = feed([
      JSON.stringify({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '   ' }),
      JSON.stringify({ type: 'result', status: 'SUCCESS', response: ' \n ' }),
    ]);
    expect(finishCliTurn(whitespace.acc)).toMatchObject({ kind: 'error', status: 'EMPTY' });

    // 有 delta 无 response → 仍成功（delta 回落路径不变）；空白 delta + 有实 response → 成功。
    const deltaOnly = feed([
      JSON.stringify({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '正文' }),
      JSON.stringify({ type: 'result', status: 'SUCCESS' }),
    ]);
    expect(finishCliTurn(deltaOnly.acc)).toMatchObject({ kind: 'success', text: '正文' });
    const blankDelta = feed([
      JSON.stringify({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: ' ' }),
      JSON.stringify({ type: 'result', status: 'SUCCESS', response: '正文' }),
    ]);
    expect(finishCliTurn(blankDelta.acc)).toMatchObject({ kind: 'success', text: '正文' });
  });

  it('坏行容忍：坏 JSON / CRLF / 空行 全部忽略不炸流；未知 event → unknownEvent effect', () => {
    const { acc, unknowns } = feed([
      '',
      'not-json{{',
      JSON.stringify({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ok' }) + '\r',
      JSON.stringify({ type: 'checkpoint', something: true }),
      JSON.stringify({ no_type_field: true }),
      JSON.stringify({ type: 'result', status: 'SUCCESS', response: 'ok' }) + '\r',
    ]);
    expect(acc.sawStepUsage).toBe(false);
    const outcome = finishCliTurn(acc);
    expect(outcome.kind).toBe('success');
    // CRLF 剥除后 delta 生效。
    if (outcome.kind === 'success') expect(outcome.text).toBe('ok');
    // 未知 event 类型观测（缺 type 字段 → '(untyped)'）。
    expect(unknowns).toEqual(['checkpoint', '(untyped)']);
  });

  it('addCliUsage 逐字段相加：双侧缺席保持缺席；emptyCliUsage 全缺席', () => {
    expect(emptyCliUsage()).toEqual({ input: undefined, output: undefined, thinking: undefined, cacheRead: undefined, total: undefined });
    expect(
      addCliUsage({ input: 1, output: 2, thinking: 3, cacheRead: 4, total: 5 }, { input: 10, output: 20, thinking: 30, cacheRead: 40, total: 50 }),
    ).toEqual({ input: 11, output: 22, thinking: 33, cacheRead: 44, total: 55 });
    expect(addCliUsage(emptyCliUsage(), { input: 7 })).toEqual({ input: 7, output: undefined, thinking: undefined, cacheRead: undefined, total: undefined });
    expect(addCliUsage(emptyCliUsage(), emptyCliUsage())).toEqual(emptyCliUsage());
  });

  // ── 子4 E2：tool step 结构化透出 + W0 fixture（nested 形态归一 + 软拒样本）──

  it('flat 形态 tool 步：toolStepStarted 扩展 toolName/toolInfo（仅新增字段，原步号语义不变）', () => {
    const fed = feed([
      JSON.stringify({
        type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool',
        tool_name: 'grep_search', tool_info: { name: 'grep_search' },
      }),
      JSON.stringify({ type: 'step_update', step_index: 2, state: 'DONE', step_type: 'tool', usage: { input: 5, total: 5 } }),
    ]);
    expect(fed.toolSteps).toEqual([2]);
    expect(fed.deltas).toEqual([]);
  });

  it('W0 §2 样本② 逐字（nested 形态软拒 ERROR 步）→ toolStepError + toolInfo 结构化透出', () => {
    // w0-findings §2 样本② 逐字（唯一改动：外层套 JSON.stringify）。
    const line = JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 4, state: 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool',
        tool_info: {
          name: 'call_mcp_tool',
          parameters: { Arguments: { text: 'hello-global' }, ServerName: 'w0dummy', ToolName: 'echo' },
          error: {
            type: 'TOOL_ERROR',
            message: 'permission check failed for mcp "w0dummy/echo": user denied permission for mcp(w0dummy/echo)',
          },
        },
      },
    });
    let acc = createCliTurnAccumulator();
    const effects: unknown[] = [];
    const applied = applyCliLine(acc, line);
    acc = applied.acc;
    effects.push(applied.effect);
    const err = applied.effect?.toolStepError;
    expect(err).toBeDefined();
    expect(err?.stepIndex).toBe(4);
    expect(err?.toolName).toBe('call_mcp_tool');
    expect((err?.toolInfo?.error as { message: string }).message).toContain('permission check failed for mcp "');
    expect(err?.toolInfo?.parameters).toMatchObject({ ServerName: 'w0dummy', ToolName: 'echo' });
    // 软拒 matcher 主信号命中。
    expect(isMcpSoftDenyToolError(err?.toolInfo)).toBe(true);
    expect(applied.effect?.toolStepStarted).toBeUndefined();
  });

  it('nested 形态全链归一（init/agent_response/result——W0 §10 产品形态）与 flat 零分歧', () => {
    const nested = feed([
      JSON.stringify({ event: 'init', init: { tools: [], permission_mode: 'request-review', model: 'gemini-3.8-pro-high' } }),
      JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '你好' } }),
      JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '，世界', usage: { input: 100, output: 5, total: 105 } } }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '你好，世界', denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }] } }),
    ]);
    expect(nested.deltas).toEqual(['你好', '，世界']);
    expect(nested.inits).toEqual([JSON.stringify({ toolsCount: 0, permissionMode: 'request-review', model: 'gemini-3.8-pro-high' })]);
    const outcome = finishCliTurn(nested.acc);
    expect(outcome.kind).toBe('success');
    // 兜底③信号：denied_actions action 名解析。
    expect(nested.acc.result?.deniedActions).toEqual(['mcp']);
    expect(hasMcpDeniedAction(nested.acc.result?.deniedActions)).toBe(true);
  });

  it('tool 步 DONE 带 tool_info.output（W0 §10 happy path）→ toolStepResult；无 tool_info 的 DONE 不透出', () => {
    let acc = createCliTurnAccumulator();
    const results: unknown[] = [];
    for (const line of [
      JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', output: 'W0-DUMMY-REPLY {"text":"hello-happy"}' }, usage: { input: 50, total: 50 } } }),
      JSON.stringify({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'tool', usage: { input: 1, total: 1 } } }),
    ]) {
      const applied = applyCliLine(acc, line);
      acc = applied.acc;
      results.push(applied.effect?.toolStepResult ?? null);
    }
    expect(results[0]).toMatchObject({ stepIndex: 3, toolName: 'call_mcp_tool', toolInfo: { output: 'W0-DUMMY-REPLY {"text":"hello-happy"}' } });
    expect(results[1]).toBeNull();
    // usage 求和照常（DONE 步语义不因 tool_info 缺席漂移）。
    expect(acc.stepUsageSum).toEqual({ input: 51, total: 51 });
  });

  it('裸 ERROR 工具步（无名无 tool_info）不透出 toolStepError（纯噪音）', () => {
    const fed = feed([
      JSON.stringify({ type: 'step_update', step_index: 5, state: 'ERROR', step_type: 'tool' }),
    ]);
    // 喂入无 effect 即无观测——feed 只收集已知 effect，此处直接断言 applyCliLine。
    let acc = createCliTurnAccumulator();
    const applied = applyCliLine(acc, JSON.stringify({ type: 'step_update', step_index: 5, state: 'ERROR', step_type: 'tool' }));
    acc = applied.acc;
    expect(applied.effect).toBeUndefined();
  });

  // ── CR-24 收紧：嵌套解包按方言标记 + 限定键（上游漂移显式呛死）──

  it('flat 方言同名列不误判嵌套（type 标记一律 flat——同名对象列不是载荷）', () => {
    const fed = feed([
      // flat 标记 + 同名 "result" 列恰好是 object——收紧后保持 flat：同名列**不被解包**
      //（顶层无 status → 记 UNKNOWN，终态以 error 呈现），不静默吃嵌套内容伪装成功。
      JSON.stringify({ type: 'result', result: { status: 'SUCCESS', response: 'x' } }),
    ]);
    expect(fed.acc.result?.status).toBe('UNKNOWN');
    expect(fed.acc.result?.response).toBeUndefined();
    expect(finishCliTurn(fed.acc)).toMatchObject({ kind: 'error', status: 'UNKNOWN' });
    // flat 同名 step_update 列同理：顶层 text_delta 缺席 → 零 delta（嵌套内容不被吸收）。
    const step = feed([
      JSON.stringify({ type: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'X' } }),
    ]);
    expect(step.deltas).toEqual([]);
  });

  it('nested 方言已知键缺同名载荷 = 上游漂移——unknownEvent 显式呛死（不静默按 flat 吞）', () => {
    // event 标记（nested 方言）+ result 键但缺同名载荷：收紧后呛死（可见 warn），
    // 不再静默按 flat 造出 status=UNKNOWN 的垃圾终态。
    const fed = feed([
      JSON.stringify({ event: 'result' }),
    ]);
    expect(fed.unknowns).toEqual(['result (nested payload missing)']);
    expect(fed.acc.result).toBeUndefined();
    expect(finishCliTurn(fed.acc).kind).toBe('no-result');
    // step_update 同形态：零 delta + 呛死观测。
    const step = feed([
      JSON.stringify({ event: 'step_update', step_type: 'agent_response', text_delta: 'X' }),
    ]);
    expect(step.deltas).toEqual([]);
    expect(step.unknowns).toEqual(['step_update (nested payload missing)']);
  });

  it('未知嵌套键保持 flat（unknownEvent 观测）；嵌套载荷非对象（数组）同样呛死', () => {
    const fed = feed([
      JSON.stringify({ event: 'checkpoint', checkpoint: { at: 1 } }),
    ]);
    expect(fed.unknowns).toEqual(['checkpoint']);
    const arrPayload = feed([
      JSON.stringify({ event: 'result', result: ['not', 'an', 'object'] }),
    ]);
    expect(arrPayload.unknowns).toEqual(['result (nested payload missing)']);
    expect(arrPayload.acc.result).toBeUndefined();
  });
});
