import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registry } from '../src/tool/registry';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionMessage, ToolDefinition } from '../src/types';
import {
  AgyBridgeConsentRequiredError,
  BRIDGE_TOOL_FACE,
  BRIDGE_TOOL_FACE_TIER1,
  BRIDGE_TOOL_FACE_TIER2,
  __clearBridgeSeamsForTest,
  buildBridgeFaceEntries,
  bridgeFaceToolIds,
  resolveAgyBridgeDialogueLane,
  runBridgeExecutor,
  sessionMessagesToWire,
  setAgyBridgeModeResolver,
  setBridgeTurnFn,
  type BridgeFaceEntry,
  type BridgeTurnOutcome,
  type BridgeTurnRequest,
} from '../src/agent/bridgeExecutor';
import { rmBestEffort } from './rmBestEffort';

// ── 子4 W4：dialogue 桥车道 executor 测试（fake seam——零真 agy / 零 shell 依赖）──
//
// 覆盖面（implement.md W4）：面策展 ∩ policy / 持久化映射同构（与 runLoop 产物 shape
// 对拍）/ kind 盖章（aborted_partial 落盘门）/ 降级路径 / 类型化征询 / 相位事件与通知 /
// wire 映射。车道级集成（streamMessage 分支接线）见文末 describe（mirror
// runtime.laneWiring.test.ts 的 runtime 级 fake generate 形态）。

function makeTool(id: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id,
    description: `工具 ${id} 描述。`,
    parameters: z.object({ q: z.string().optional() }),
    execute: async () => ({ title: id, output: 'ok' }),
    ...extra,
  };
}

/** 全量工具 fixture：桥面内（Tier1/Tier2 各取样）+ 桥面外（本地工具/未策展）。 */
function fullTools(): ToolDefinition[] {
  return [
    makeTool('present_result'),
    makeTool('write_chapter'),
    makeTool('query_story'),
    makeTool('outline_update'), // Tier 2 diff
    makeTool('memory_update'), // Tier 2 write
    makeTool('spawn_agent'), // 本地工具（结构性排除——不在策展表）
    makeTool('read_file'), // 未策展的 remote 工具
  ];
}

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

afterEach(() => {
  __clearBridgeSeamsForTest();
});

describe('面策展（design §7 分层表）', () => {
  beforeEach(() => {
    registry.__clearForTest();
  });

  it('策展常量：Tier1 + Tier2 = 全量 24 id，零重复', () => {
    expect(BRIDGE_TOOL_FACE).toHaveLength(24);
    expect(new Set(BRIDGE_TOOL_FACE).size).toBe(24);
    expect([...BRIDGE_TOOL_FACE_TIER1, ...BRIDGE_TOOL_FACE_TIER2]).toEqual([...BRIDGE_TOOL_FACE]);
    // Tier1 锚点（design §7 逐项）。
    for (const id of ['present_result', 'write_chapter', 'query_story', 'web_search', 'wiki_search']) {
      expect(BRIDGE_TOOL_FACE_TIER1).toContain(id);
    }
    // Tier2 diff 家族（W5 入面）。
    for (const id of ['outline_update', 'memory_update', 'setting_md_update', 'asset_cards_update']) {
      expect(BRIDGE_TOOL_FACE_TIER2).toContain(id);
    }
  });

  it('bridgeFaceToolIds：策展 ∩ policy——suggest 档含 diff（Tier2）剔 write；readonly 档只剩 read 类', () => {
    const tools = fullTools();
    expect(bridgeFaceToolIds(tools, 'suggest')).toEqual([
      'present_result', 'write_chapter', 'query_story', 'outline_update',
    ]);
    // memory_update 是 write 类——suggest 档被 policy 面剔除。
    expect(bridgeFaceToolIds(tools, 'suggest')).not.toContain('memory_update');
    // readonly 档：diff 家族也剔（outline_update）——只剩 read 分类（write_chapter 现行
    // classifyTool 归 read——随现行 policy 单源，不在策展层覆写）。
    expect(bridgeFaceToolIds(tools, 'readonly')).toEqual(['present_result', 'write_chapter', 'query_story']);
    // auto 档全量。
    expect(bridgeFaceToolIds(tools, 'auto')).toEqual([
      'present_result', 'write_chapter', 'query_story', 'outline_update', 'memory_update',
    ]);
    // 桥面外工具（spawn_agent/read_file）任何档不入面（结构性排除——策展表不含）。
    for (const mode of ['readonly', 'suggest', 'auto'] as const) {
      const ids = bridgeFaceToolIds(tools, mode);
      expect(ids).not.toContain('spawn_agent');
      expect(ids).not.toContain('read_file');
    }
  });

  it('buildBridgeFaceEntries：描述改写单源 + JSON Schema 1:1（$schema 剥除）', () => {
    const entries = buildBridgeFaceEntries(fullTools(), 'suggest');
    const byName = new Map(entries.map((e) => [e.name, e]));
    // 写作域措辞改写（w0-findings §8 两例基线——剥离工作台/产品名/实现词）。
    expect(byName.get('present_result')!.description).not.toContain('工作台');
    expect(byName.get('write_chapter')!.description).toContain('完整写作流程');
    // 未列改写的工具沿用 registry 描述。
    expect(byName.get('query_story')!.description).toBe('工具 query_story 描述。');
    // inputSchema = zodToJsonSchema 产物（$schema 剥除）。
    const schema = byName.get('query_story')!.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect('$schema' in schema).toBe(false);
  });
});

describe('车道判定（resolveAgyBridgeDialogueLane）', () => {
  it('面空 → off（resolver 不被调用——HTTP 模型零开销）', () => {
    const resolver = vi.fn(() => ({ mode: 'bridge' as const }));
    setAgyBridgeModeResolver(resolver);
    const lane = resolveAgyBridgeDialogueLane({ tools: [makeTool('read_file')], permissionMode: 'suggest', modelRef: { keyId: 'k', modelId: 'm' } });
    expect(lane).toEqual({ kind: 'off', reason: 'empty-face' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('resolver 未装配 → off（fail-safe 回 runLoop 纯文本）', () => {
    const lane = resolveAgyBridgeDialogueLane({ tools: fullTools(), permissionMode: 'suggest', modelRef: { keyId: 'k', modelId: 'm' } });
    expect(lane).toEqual({ kind: 'off', reason: 'resolver-not-installed' });
  });

  it('resolver off（declined/not-cli）→ off 透传 reason', () => {
    setAgyBridgeModeResolver(() => ({ mode: 'off', reason: 'declined' }));
    expect(resolveAgyBridgeDialogueLane({ tools: fullTools(), permissionMode: 'suggest', modelRef: { keyId: 'k', modelId: 'm' } }))
      .toEqual({ kind: 'off', reason: 'declined' });
  });

  it('resolver rejected（missing-consent / conflict）→ 类型化错误（机器可读前缀）', () => {
    setAgyBridgeModeResolver(() => ({ mode: 'rejected', state: 'missing-consent', conflicts: [] }));
    const lane = resolveAgyBridgeDialogueLane({ tools: fullTools(), permissionMode: 'suggest', modelRef: { keyId: 'k', modelId: 'm' } });
    expect(lane.kind).toBe('rejected');
    expect((lane as { error: AgyBridgeConsentRequiredError }).error.message).toBe('agy_bridge_consent|state=missing-consent');

    setAgyBridgeModeResolver(() => ({ mode: 'rejected', state: 'conflict', conflicts: ['mcp(*)'] }));
    const conflictLane = resolveAgyBridgeDialogueLane({ tools: fullTools(), permissionMode: 'suggest', modelRef: { keyId: 'k', modelId: 'm' } });
    expect((conflictLane as { error: AgyBridgeConsentRequiredError }).error.message)
      .toBe('agy_bridge_consent|state=conflict|rules=mcp(*)');
  });

  it('resolver bridge → 判定产物零 face（CR-12：判定路径零 schema 编译——面构造归车道分支点）', () => {
    const resolver = vi.fn(() => ({ mode: 'bridge' as const }));
    setAgyBridgeModeResolver(resolver);
    const lane = resolveAgyBridgeDialogueLane({ tools: fullTools(), permissionMode: 'suggest', modelRef: undefined });
    expect(lane.kind).toBe('bridge');
    expect('face' in lane).toBe(false); // 判定产物不携带面（构造单次化在 workflow）
    expect(resolver).toHaveBeenCalledWith({ modelRef: { keyId: 'default', modelId: 'default' } });
  });

  it('conflict 规则编码（CR-7）：含分隔符的用户规则 round-trip 不损坏', () => {
    // 用户 deny/ask 规则原文可含 '|' / ';'——未编码时 UI 侧 parse 按分隔符切开。
    const nasty = ['mcp(novel-writing/write_chapter); rm -rf', 'mcp(a)|state=hacked'];
    setAgyBridgeModeResolver(() => ({ mode: 'rejected', state: 'conflict', conflicts: nasty }));
    const lane = resolveAgyBridgeDialogueLane({ tools: fullTools(), permissionMode: 'suggest', modelRef: { keyId: 'k', modelId: 'm' } });
    const message = (lane as { error: AgyBridgeConsentRequiredError }).error.message;
    // 整体前缀结构不因规则内容破形：state 段恒第一、rules 恒一段。
    expect(message.startsWith('agy_bridge_consent|state=conflict|rules=')).toBe(true);
    expect(message.split('|')).toHaveLength(3);
    // 规则逐条编码后 join(';')——解码 round-trip 原文。
    const encoded = message.slice('agy_bridge_consent|state=conflict|rules='.length).split(';');
    expect(encoded.map(decodeURIComponent)).toEqual(nasty);
  });
});

describe('wire 映射（sessionMessagesToWire）', () => {
  it('assistant toolCalls / tool 逐 result / 带图 user 占位注记 / system 跳过', () => {
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: '写第一章', createdAt: 1 },
      {
        id: 'a1', role: 'assistant', content: '开始检索', createdAt: 2,
        toolCalls: [{ id: 'tc1', name: 'query_story', arguments: '{"q":"主角"}' }],
      },
      {
        id: 't1', role: 'tool', content: '结果A\n结果B', createdAt: 3,
        toolResults: [
          { toolCallId: 'tc1', toolName: 'query_story', output: '结果A' },
          { toolCallId: 'tc2', toolName: 'query_relations', output: '结果B' },
        ],
      },
      { id: 'u2', role: 'user', content: '看这张图', createdAt: 4, images: [{ path: 'a.png', b64hash: 'h1' }] },
    ];
    const wire = sessionMessagesToWire(messages);
    expect(wire).toEqual([
      { role: 'user', content: '写第一章' },
      { role: 'assistant', content: '开始检索', toolCalls: [{ id: 'tc1', name: 'query_story', arguments: '{"q":"主角"}' }] },
      { role: 'tool', toolCallId: 'tc1', content: '结果A' },
      { role: 'tool', toolCallId: 'tc2', content: '结果B' },
      { role: 'user', content: '看这张图\n[图片附件：本通道暂不支持图片输入，已省略]' },
    ]);
  });

  it('悬空 toolCalls 按 resultIds 过滤（CR-6：截断历史不上悬空 call——wire 拒收整 turn 的防线）', () => {
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: '查', createdAt: 1 },
      {
        // 一答一悬空（tc2 的 tool 消息在截断中丢失）；另有整条 assistant 的 toolCalls 全悬空。
        id: 'a1', role: 'assistant', content: '', createdAt: 2,
        toolCalls: [
          { id: 'tc1', name: 'query_story', arguments: '{}' },
          { id: 'tc2', name: 'query_relations', arguments: '{}' },
        ],
      },
      {
        id: 't1', role: 'tool', content: '结果A', createdAt: 3,
        toolResults: [{ toolCallId: 'tc1', toolName: 'query_story', output: '结果A' }],
      },
      {
        // 全悬空（崩溃落在持久化之间——后续轮次不得整 turn 被拒收）。
        id: 'a2', role: 'assistant', content: '继续', createdAt: 4,
        toolCalls: [{ id: 'tc9', name: 'write_chapter', arguments: '{}' }],
      },
      { id: 'u2', role: 'user', content: '下一步', createdAt: 5 },
    ];
    const wire = sessionMessagesToWire(messages);
    expect(wire).toEqual([
      { role: 'user', content: '查' },
      // a1：只保留有 result 的 tc1（tc2 悬空——过滤）。
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'query_story', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'tc1', content: '结果A' },
      // a2：toolCalls 全悬空 → 不带 toolCalls 键（不带空数组上 wire）。
      { role: 'assistant', content: '继续' },
      { role: 'user', content: '下一步' },
    ]);
  });
});

describe('executor：持久化同构映射（与 runLoop 产物 shape 对拍）', () => {
  it('工具对 live 落盘（assistant.toolCalls + tool.toolResults 成对）+ 终文 assistant（同 delta messageId 锚）', async () => {
    const requests: BridgeTurnRequest[] = [];
    const deltas: Array<{ channel: string; delta: string; toolName?: string }> = [];
    const notices: string[] = [];
    const persisted: SessionMessage[] = [];
    setBridgeTurnFn(async (req) => {
      requests.push(req);
      req.onDelta?.({ type: 'text', delta: '检索中' });
      req.onPhase?.({ kind: 'tool-started', toolName: 'query_story', stepIndex: 1 });
      req.onToolCall?.({
        toolId: 'query_story',
        arguments: { q: '主角' },
        ok: true,
        output: '结果A',
        metadata: { someMeta: 1 },
      });
      req.onPhase?.({ kind: 'sendback' });
      req.onPhase?.({ kind: 'soft-denied' });
      req.onDelta?.({ type: 'text', delta: '。终文' });
      return makeOutcome({ text: '终文。' });
    });
    const result = await runBridgeExecutor({
      sessionId: 's1',
      projectPath: 'C:/proj',
      messages: [{ id: 'u1', role: 'user', content: '写第一章', createdAt: 1 }],
      systemPrompt: 'SYSTEM',
      tools: fullTools(),
      modelRef: { keyId: 'k', modelId: 'm' },
      sessionKey: 'dialogue:s1',
      permissionMode: 'suggest',
      behaviorMode: 'plan',
      abort: new AbortController().signal,
      onMessage: (msg) => persisted.push(msg),
      emitDelta: (event) => deltas.push({ channel: event.channel, delta: event.delta, toolName: event.toolName }),
      onNotice: (n) => notices.push(n.notice),
    });

    // seam 请求形态：system 原样（无工具描述拼接）、wire 消息、requirePresentResult 按
    // behaviorMode=plan、面 = suggest 档策集。
    expect(requests).toHaveLength(1);
    expect(requests[0]!.system).toBe('SYSTEM');
    expect(requests[0]!.messages).toEqual([{ role: 'user', content: '写第一章' }]);
    expect(requests[0]!.requirePresentResult).toBe(true);
    expect(requests[0]!.face.map((f) => f.name)).toEqual(['present_result', 'write_chapter', 'query_story', 'outline_update']);
    expect(requests[0]!.sessionKey).toBe('dialogue:s1');

    // delta 流：text 两段 + tool 相位一次（「正在调用 X」）。
    expect(deltas.filter((d) => d.channel === 'text').map((d) => d.delta).join('')).toBe('检索中。终文');
    const toolPhase = deltas.find((d) => d.channel === 'tool');
    expect(toolPhase?.toolName).toBe('query_story');

    // 通知：sendback + soft-denied（相位 → bridge-notice 面）。
    expect(notices).toEqual(['sendback', 'soft-denied']);

    // 持久化 shape 对拍（与 runLoop 产物同构）：
    //   [assistant(toolCalls), tool(toolResults+metadata), assistant 终文]
    expect(persisted.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    const callAssistant = persisted[0]!;
    expect(callAssistant.content).toBe('');
    expect(callAssistant.toolCalls).toHaveLength(1);
    const callName = callAssistant.toolCalls![0]!.name;
    const callId = callAssistant.toolCalls![0]!.id;
    expect(callName).toBe('query_story');
    expect(JSON.parse(callAssistant.toolCalls![0]!.arguments)).toEqual({ q: '主角' });
    const toolMsg = persisted[1]!;
    expect(toolMsg.toolResults).toHaveLength(1);
    expect(toolMsg.toolResults![0]!).toMatchObject({ toolCallId: callId, toolName: 'query_story', output: '结果A' });
    expect(toolMsg.toolResults![0]!.metadata).toEqual({ someMeta: 1 });
    expect(toolMsg.content).toBe('结果A');
    // 终文与 delta 流同 messageId 锚（UI 占位→终帧替换）。
    expect(persisted[2]!.content).toBe('终文。');
    expect(result.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(result[2]!.id).toBe(persisted[2]!.id);
  });

  it('失败工具结果 = "Error: " 前缀（gate 拒绝/执行异常同形——mirror runLoop 惯例）；metadata 不携带', async () => {
    const persisted: SessionMessage[] = [];
    setBridgeTurnFn(async (req) => {
      req.onToolCall?.({ toolId: 'outline_update', ok: false, error: '工具 outline_update 不在本次会话可用的工具面内', gate: 'face' });
      return makeOutcome({ text: 'done' });
    });
    await runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persisted.push(m),
    });
    const toolMsg = persisted.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toBe('Error: 工具 outline_update 不在本次会话可用的工具面内');
    expect(toolMsg.toolResults![0]!.metadata).toBeUndefined();
  });

  it('Tier 2 envelope 透传：metadata.field_patch 随 tool result 落盘（UI 捕获层素材——AC8 agent 面）', async () => {
    const persisted: SessionMessage[] = [];
    setBridgeTurnFn(async (req) => {
      req.onToolCall?.({
        toolId: 'outline_update',
        arguments: { autoApply: false },
        ok: true,
        output: '已提议修改，等待作者审阅。',
        metadata: { type: 'field_patch', field: 'outline', patches: [{ op: 'add', path: '/phases/0', value: {} }] },
      });
      return makeOutcome({ text: '已提议。' });
    });
    await runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persisted.push(m),
    });
    const toolMsg = persisted.find((m) => m.role === 'tool')!;
    expect(toolMsg.toolResults![0]!.metadata).toMatchObject({ type: 'field_patch', field: 'outline' });
  });

  it('abort 中断落盘门：delta 已流 → aborted_partial（预分配锚）；零流 → 不落（!text && !reasoning 丢弃）', async () => {
    const makeAbortError = (): Error => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return err;
    };
    // 已流文本。
    const persistedA: SessionMessage[] = [];
    setBridgeTurnFn(async (req) => {
      req.onDelta?.({ type: 'text', delta: '部分正文' });
      throw makeAbortError();
    });
    await expect(runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persistedA.push(m),
      emitDelta: () => {},
    })).rejects.toThrow(/aborted/);
    expect(persistedA).toHaveLength(1);
    expect(persistedA[0]!.kind).toBe('aborted_partial');
    expect(persistedA[0]!.content).toBe('部分正文');

    // 零流文本。
    const persistedB: SessionMessage[] = [];
    setBridgeTurnFn(async () => {
      throw makeAbortError();
    });
    await expect(runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persistedB.push(m),
    })).rejects.toThrow(/aborted/);
    expect(persistedB).toHaveLength(0);
  });

  it('非 abort 错误原样上抛且不落 partial（error 语义不变）', async () => {
    const persisted: SessionMessage[] = [];
    setBridgeTurnFn(async (req) => {
      req.onDelta?.({ type: 'text', delta: '已流' });
      throw new Error('quota exceeded');
    });
    await expect(runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persisted.push(m),
      emitDelta: () => {},
    })).rejects.toThrow(/quota/);
    expect(persisted).toHaveLength(0);
  });

  it('abort 竞态（CR-3）：exit-observer 形态错误 + signal 已断 → 按 abort 语义落 aborted_partial', async () => {
    // kill 级联下 502 可能先于 abort listener settle——错误形态非 AbortError 但 signal 已断。
    const controller = new AbortController();
    const persisted: SessionMessage[] = [];
    setBridgeTurnFn(async (req) => {
      req.onDelta?.({ type: 'text', delta: '竞态中已流文本' });
      controller.abort(); // 错误上抛前 signal 已断（exit-observer 抢跑形态）
      const err = new Error('antigravity-cli process exited (code 1) before the turn result');
      err.name = 'ProtocolHttpError';
      throw err;
    });
    await expect(runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: controller.signal, onMessage: (m) => persisted.push(m),
      emitDelta: () => {},
    })).rejects.toThrow(/exited/); // 原错误原样上抛（形态不被改写）
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.kind).toBe('aborted_partial');
    expect(persisted[0]!.content).toBe('竞态中已流文本');
  });

  it('终文持久化 throw 不翻 error 态（CR-4：成功 turn 照常返回 + 错误留日志）', async () => {
    setBridgeTurnFn(async () => makeOutcome({ text: '终文。' }));
    const result = await runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal,
      onMessage: (m) => {
        if (m.role === 'assistant' && m.content === '终文。') throw new Error('jsonl append failed');
      },
    });
    // turn 不 reject：result 仍含终文（onMessage 失败不吞结果）。
    expect(result.map((m) => m.role)).toEqual(['assistant']);
    expect(result[0]!.content).toBe('终文。');
  });

  it('onNotice 消费者 throw 不中断桥 turn（CR-5：记 warn 后继续）', async () => {
    setBridgeTurnFn(async (req) => {
      req.onPhase?.({ kind: 'sendback' });
      req.onPhase?.({ kind: 'soft-denied' });
      return makeOutcome({ text: '照常完成。' });
    });
    const persisted: SessionMessage[] = [];
    const result = await runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persisted.push(m),
      onNotice: () => { throw new Error('UI dispatcher exploded'); },
    });
    expect(result[result.length - 1]!.content).toBe('照常完成。');
    expect(persisted).toHaveLength(1);
  });

  it('空终文且有工具对 → 跳过终文 broadcast（CR-15：不产空气泡）', async () => {
    const persisted: SessionMessage[] = [];
    setBridgeTurnFn(async (req) => {
      req.onToolCall?.({ toolId: 'query_story', arguments: {}, ok: true, output: '结果' });
      return makeOutcome({ text: '' }); // agy 侧只产工具调用不落正文
    });
    const result = await runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persisted.push(m),
    });
    expect(result.map((m) => m.role)).toEqual(['assistant', 'tool']); // 无终文 assistant
    expect(persisted.map((m) => m.role)).toEqual(['assistant', 'tool']);
  });

  it('空终文且零工具对 → 终文照常 broadcast（CR-15 只收空+有工具对的交集面）', async () => {
    const persisted: SessionMessage[] = [];
    setBridgeTurnFn(async () => makeOutcome({ text: '' }));
    await runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: (m) => persisted.push(m),
    });
    expect(persisted.map((m) => m.role)).toEqual(['assistant']); // 现行为保持（非 CR 面）
  });

  it('face 注入优先（CR-12：车道判定处单次构造直传——executor 零重编译）', async () => {
    const injected: BridgeFaceEntry[] = [
      { name: 'present_result', description: '注入面标记。', inputSchema: { type: 'object', marker: 'injected' } },
    ];
    const requests: BridgeTurnRequest[] = [];
    setBridgeTurnFn(async (req) => {
      requests.push(req);
      return makeOutcome({ text: 'ok' });
    });
    await runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: () => {},
      face: injected,
    });
    expect(requests[0]!.face).toBe(injected); // 引用直传（非重算副本）
  });

  it('seam 未装配 → 响亮失败（wiring 漏装配不静默）', async () => {
    await expect(runBridgeExecutor({
      sessionId: 's1', projectPath: 'p', messages: [], systemPrompt: '', tools: fullTools(),
      modelRef: undefined, sessionKey: 'k', permissionMode: 'suggest', behaviorMode: 'normal',
      abort: new AbortController().signal, onMessage: () => {},
    })).rejects.toThrow(/setBridgeTurnFn first/);
  });
});

describe('车道级集成（streamMessage 分支接线——mirror runtime.laneWiring 形态）', () => {
  let projectPath = '';
  // 会话清理锚（不 resetModules——桥 seam 是 bridgeExecutor 模块级状态，reset 会让
  // runtime 的 import 与本文件的静态 import 分属两实例，seam 注入不可见〔假绿〕）。
  let createdSessionId: string | undefined;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-bridge-lane-'));
    createdSessionId = undefined;
    registry.__clearForTest();
    registry.register(makeTool('query_story'));
    registry.register(makeTool('read_file'));
  });

  afterEach(async () => {
    if (createdSessionId !== undefined) {
      const { deleteSession } = await import('../src/agent/session');
      try {
        deleteSession(createdSessionId, projectPath);
      } catch {
        /* best-effort 清理 */
      }
    }
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    __clearBridgeSeamsForTest();
  });

  async function makeRuntime(generate: ReturnType<typeof vi.fn<GenerateFn>>) {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    return createWorkflowRuntime({ generate });
  }

  it('resolver bridge → executor 接管（generate 零调用）；终文/工具对经 onMessage 落盘', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '不应到达', finishReason: 'stop' }));
    const runtime = await makeRuntime(generate);
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    createdSessionId = session.id;
    const events: string[] = [];
    const bridgeCalls: BridgeTurnRequest[] = [];
    setAgyBridgeModeResolver(() => ({ mode: 'bridge' }));
    setBridgeTurnFn(async (req) => {
      bridgeCalls.push(req);
      req.onToolCall?.({ toolId: 'query_story', arguments: {}, ok: true, output: '结果' });
      return makeOutcome({ text: '桥终文。' });
    });

    await runtime.streamMessage({
      sessionId: session.id,
      content: '查一下主角设定',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => events.push((event as { type: string }).type),
    });

    expect(generate).not.toHaveBeenCalled(); // runLoop 未接管
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]!.sessionKey).toBe(`dialogue:${session.id}`);
    // 会话历史：user 输入 + session_state_note 注记（system 稳定化——turn 开始追加，
    // 桥车道同样经过装配序）+ assistant(toolCalls) + tool + assistant 终文。
    const roles = runtime.getSession(session.id)!.messages.map((m) => m.kind ?? m.role);
    expect(roles).toEqual(['user', 'session_state_note', 'assistant', 'tool', 'assistant']);
    // 事件面：工具对（assistant/tool）+ 终文 assistant + done。
    expect(events).toContain('done');
    expect(events).toContain('assistant');
    expect(events).toContain('tool');
  });

  it('resolver off → runLoop 纯文本路径零变化（generate 被调，桥 fn 零调用）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '纯文本回答。', finishReason: 'stop' }));
    const runtime = await makeRuntime(generate);
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    createdSessionId = session.id;
    const bridgeFn = vi.fn(async () => makeOutcome());
    setAgyBridgeModeResolver(() => ({ mode: 'off', reason: 'not-cli' }));
    setBridgeTurnFn(bridgeFn);

    await runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: () => {},
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(bridgeFn).not.toHaveBeenCalled();
    // system 稳定化：注记同样在场（runLoop 车道装配序共享）。
    const roles = runtime.getSession(session.id)!.messages.map((m) => m.kind ?? m.role);
    expect(roles).toEqual(['user', 'session_state_note', 'assistant']);
  });

  it('resolver rejected → turn 失败（error 事件 + 会话 error 态——UI 波次按前缀消费）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '不应到达', finishReason: 'stop' }));
    const runtime = await makeRuntime(generate);
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    createdSessionId = session.id;
    const errors: string[] = [];
    setAgyBridgeModeResolver(() => ({ mode: 'rejected', state: 'missing-consent', conflicts: [] }));

    await expect(runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: (event) => {
        const e = event as { type: string; data?: { message?: string } };
        if (e.type === 'error') errors.push(e.data?.message ?? '');
      },
    })).rejects.toBeInstanceOf(AgyBridgeConsentRequiredError);
    expect(generate).not.toHaveBeenCalled();
    expect(errors).toEqual(['agy_bridge_consent|state=missing-consent']);
    expect(runtime.getSession(session.id)!.status).toBe('error');
  });
});
