import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  installAgyBridgeCore,
  uninstallAgyBridgeCoreForTest,
  runAgyBridgeTurn,
  bridgeFaceHash,
  bridgeHomeDirFor,
  bridgePoolSessionKey,
  BRIDGE_MCP_SERVER_NAME,
  BRIDGE_OUTPUT_DIRECTIVE,
  BRIDGE_BUILTIN_TOOL_CORRECTION_MESSAGE,
  type AgyBridgeCore,
  type AgyBridgePhaseEvent,
  type BridgeToolFaceEntry,
  type BridgeTurnInput,
} from '../src/antigravityCli/bridgeTurn';
import { buildTurnSegments, composeMessageSegment } from '../src/antigravityCli/compose';
import { hashSegment, hashSegments } from '../src/antigravityCli/mirror';
import { AgyFakeHomeCollisionError } from '../src/antigravityCli/sessions';
import { AGY_MCP_DISPATCHER_TOOL_NAME, BRIDGE_MCP_SERVER_NAME as AGENTS_BRIDGE_MCP_SERVER_NAME, CLOSURE_BRIDGE_AGENT, CLOSURE_BRIDGE_AGENT_LAYOUT } from '../src/antigravityCli/agents';
import { fakePoolEnv, type FakeAgyProcess, type FakePoolEnv } from './antigravityCliFakes';

// ── 子4 W1：桥 turn 编排集成测试（fake 子进程 + fake 内核——零真 agy / 零真管道）──
//
// 覆盖面（implement.md W1）：打回恰好一次 / 二次未调接受+警告 / 面变更→新进程键 /
// 假宿准备失败→spawn 失败 / 软拒诊断 / env·print-timeout·池键装配。
// 09-19 白名单 W2 增补：spawn 恒挂 --agent（布局常量激活值）+ 载荷 agentMarkdown 透传。

const FACE: BridgeToolFaceEntry[] = [
  { name: 'present_result', description: '呈现结果并声明本轮结束。', inputSchema: { type: 'object' } },
  { name: 'write_chapter', description: '为指定章节触发完整写作流程。', inputSchema: { type: 'object' } },
];

const HOME_ROOT = '/fake-bridge-home';

/**
 * 内核携带的 agent 内容哨兵（非真实渲染输出）：钉「协议层只透传、零内容生成」契约——
 * 内容单源在协议层 agents.ts，由 shell 装配处经 renderAgentMarkdown 填充（shell 测试钉）。
 */
const BRIDGE_AGENT_MD_SENTINEL = 'FAKE-BRIDGE-AGENT-MD';

interface CoreSpy {
  homeWrites: Array<{ homeDir: string; sessionId: string; pipeName: string; token: string; agentMarkdown: string }>;
  openedSessions: string[];
}

function fakeCore(env: FakePoolEnv): { core: AgyBridgeCore; spy: CoreSpy } {
  const spy: CoreSpy = { homeWrites: [], openedSessions: [] };
  const pipes = new Map<string, { pipeName: string; token: string }>();
  const core: AgyBridgeCore = {
    homeRoot: HOME_ROOT,
    bridgeAgentMarkdown: BRIDGE_AGENT_MD_SENTINEL,
    writeHomePayload: async (input) => {
      spy.homeWrites.push({ homeDir: input.homeDir, sessionId: input.sessionId, pipeName: input.pipeName, token: input.token, agentMarkdown: input.agentMarkdown });
    },
    openBridgeSession: async (input) => {
      spy.openedSessions.push(input.sessionId);
      const existing = pipes.get(input.sessionId);
      if (existing !== undefined) return existing;
      const created = { pipeName: `pipe-${input.sessionId}`, token: `tok-${input.sessionId}` };
      pipes.set(input.sessionId, created);
      return created;
    },
    poolDeps: env.deps,
    warn: (message) => { env.warns.push(message); },
    info: (message) => { env.infos.push(message); },
  };
  return { core, spy };
}

function makeInput(overrides: Partial<BridgeTurnInput> = {}): BridgeTurnInput {
  return {
    cliExecutable: 'agy',
    keyId: 'key-cli',
    modelId: 'gemini-3.8-pro-high',
    system: '你是写作助手。',
    messages: [{ role: 'user', content: '写第一章' }],
    sessionKey: 'chain:abc:dialogue',
    sessionId: 'session-uuid-1',
    projectDir: 'C:/proj',
    permissionMode: 'suggest',
    face: FACE,
    requirePresentResult: true,
    lane: 'dialogue',
    ...overrides,
  };
}

/** 简单成功 turn 事件流（带 step usage + 正文）。 */
function scriptPlainSuccess(proc: FakeAgyProcess, text: string): void {
  proc.emitEvent({ type: 'init', cwd: proc.spawnArgs.cwd, tools: [], permission_mode: 'request-review', model: 'gemini-3.8-pro-high' });
  proc.emitEvent({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: text, usage: { input: 100, output: 5, total: 105 } });
  proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: text });
}

/** present_result 收尾 turn（MCP 派发步 + 正文）。 */
function scriptPresentResultTurn(proc: FakeAgyProcess, text: string, awaiting: boolean): void {
  proc.emitEvent({ type: 'init', cwd: proc.spawnArgs.cwd, tools: [], permission_mode: 'request-review', model: 'gemini-3.8-pro-high' });
  proc.emitEvent({
    type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool',
    tool_info: { name: 'call_mcp_tool', parameters: { ServerName: BRIDGE_MCP_SERVER_NAME, ToolName: 'present_result', Arguments: { awaiting_intent_confirmation: awaiting } } },
  });
  proc.emitEvent({ type: 'step_update', step_index: 2, state: 'DONE', step_type: 'tool', usage: { input: 50, output: 2, total: 52 } });
  proc.emitEvent({ type: 'step_update', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: text, usage: { input: 30, output: 4, total: 34 } });
  proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: text });
}

afterEach(() => {
  uninstallAgyBridgeCoreForTest();
});

describe('agy bridge turn 纯派生函数', () => {
  it('bridgePoolSessionKey：D9 后缀含 face hash——面变更即新键；同面稳定', () => {
    const a = bridgePoolSessionKey('chain:abc', FACE);
    const a2 = bridgePoolSessionKey('chain:abc', FACE);
    const faceChanged = bridgePoolSessionKey('chain:abc', [...FACE, { name: 'wiki_search', description: '', inputSchema: {} }]);
    expect(a).toBe(a2);
    expect(a).toMatch(/^chain:abc｜bridge｜face:[0-9a-f]{12}$/);
    expect(faceChanged).not.toBe(a);
    expect(bridgeFaceHash(FACE)).toHaveLength(12);
  });

  it('bridgeHomeDirFor：sessionId 净化（非法段替换）+ 空/点段拒绝', () => {
    expect(bridgeHomeDirFor('/root', 'abc-123')).toBe(path.join('/root', 'abc-123'));
    expect(bridgeHomeDirFor('/root', 'a/b\\c')).toBe(path.join('/root', 'a_b_c'));
    expect(bridgeHomeDirFor('/root', '///')).toBe(path.join('/root', '_')); // 连续非法段净化合并为一个 _
    expect(() => bridgeHomeDirFor('/root', '')).toThrow(/invalid bridge session id/);
    expect(() => bridgeHomeDirFor('/root', '.')).toThrow(/invalid bridge session id/);
  });

  it('BRIDGE_OUTPUT_DIRECTIVE 插值 BRIDGE_MCP_SERVER_NAME 单源（CR-24：改名单点生效）', () => {
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain(`MCP 服务器 ${BRIDGE_MCP_SERVER_NAME}`);
  });

  it('BRIDGE_MCP_SERVER_NAME 单源 = agents.ts 导出（W5：桥 agent 正文与桥指令同源插值）', () => {
    // W5 常量落内容源 agents.ts（桥 agent v2 正文插值用）；bridgeTurn 转发导出——
    // 两路径必须同一绑定，防止未来改动重新造出第二个字面量（CR-24 纪律）。
    expect(BRIDGE_MCP_SERVER_NAME).toBe(AGENTS_BRIDGE_MCP_SERVER_NAME);
  });

  it('BRIDGE_OUTPUT_DIRECTIVE 瘦身（AC9/W5）+ 条件式降级兜底句（CR-1）+ 通道分工句（F16）：死文无条件形态移除、协议常驻段只在 system', () => {
    // 保留：逐 turn 能水 + 路由最小句（工具纪律与 present_result 协议常驻段已上移
    // CLOSURE_BRIDGE_AGENT 正文——R5 分工：常驻归 system，逐 turn 归用户消息）。
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain('请完成最后一条消息所述的任务');
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain(`一律使用 MCP 服务器 ${BRIDGE_MCP_SERVER_NAME} 提供的工具`);
    // F16：旧「面向用户的最终正文直接以纯文本写出」与工具纪律拆台（真机 write_chapter
    // 零调用）⇒ 改通道分工句。双写逐字锁（CR-1 双写例外的机制守卫）：同一条分工句在
    // agent 正文与 per-turn 指令中逐字同在（该句是降级路径唯一防线，改字须两处同步）。
    const channelSplitClause =
      '章节正文、改稿结果这类作品内容一律由对应桥工具产出并写进作品；对话回复只用于讨论、说明、方案、评审意见、回答用户提问这类呈现性回复。';
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain(channelSplitClause);
    expect(CLOSURE_BRIDGE_AGENT.body).toContain(channelSplitClause);
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('面向用户的最终正文直接以纯文本写出');
    expect(CLOSURE_BRIDGE_AGENT.body).not.toContain('面向用户的最终正文直接以纯文本写出');
    // CR-1 兜底句三段正断言：①条件式框架（agent 生效时模型侧无内置工具 → 条件恒假
    // 句子失活）/ ②机制与后果（无头模式 → 权限系统自动拒 → 整轮空回合）/ ③正路改道。
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain('若你的可用工具中出现命令执行、浏览器、网页搜索等内置工具');
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain('无头模式');
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain('自动拒绝');
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain('整轮空回合');
    expect(BRIDGE_OUTPUT_DIRECTIVE).toContain(`你的写作工具只有 MCP 服务器 ${BRIDGE_MCP_SERVER_NAME} 提供的工具族`);
    // 协议常驻段只在 system（R5）：present_result 协议不进 per-turn 指令——逐 turn 协议
    // 面唯一合法形态是打回提示专缝（BRIDGE_SENDBACK_MESSAGE）。
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('present_result');
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('awaiting_intent_confirmation');
    // 移除核对（负断言按 CR-1 对账收窄）：宽子串「内置工具」「自动拒绝」已被条件式兜底
    // 句合法占用，负断言改钉旧死文专属形态——无条件括号列举、「在无头模式下会被」连续
    // 框架、祈使拒绝尾「绝不使用」；示例点名四工具照旧。
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('内置工具（命令/浏览器/搜索等）');
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('在无头模式下会被');
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('绝不使用');
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('read_file');
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('chapter_read');
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('query_story');
    expect(BRIDGE_OUTPUT_DIRECTIVE).not.toContain('web_search');
  });
});

describe('agy bridge turn（fake 子进程 + fake 内核）', () => {
  it('未装配内核 → 响亮失败（wiring 漏装配不静默）', async () => {
    await expect(runAgyBridgeTurn(makeInput())).rejects.toThrow(/not installed/);
  });

  it('成功 turn：env 指假宿 + print-timeout 30m + 四件套编排 + usage 口径', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => scriptPlainSuccess(proc, '初稿完成。');
    });
    const { core, spy } = fakeCore(env);
    installAgyBridgeCore(core);
    const deltas: string[] = [];
    const result = await runAgyBridgeTurn(makeInput({
      onDelta: (d) => { if (d.type === 'text') deltas.push(d.delta); },
    }));

    expect(result.text).toBe('初稿完成。');
    // 两 cycle 各 100/5/105（打回重跑也计费——求和口径）。
    expect(result.usage).toMatchObject({ promptTokens: 200, completionTokens: 10, totalTokens: 210 });
    expect(result.presentResultCalled).toBe(false);
    expect(result.sentBack).toBe(true); // requirePresentResult=true 且未调 → 打回
    expect(result.secondPassMissedPresentResult).toBe(true); // 重跑仍未调 → 接受 + 警告
    expect(result.bridgeToolCalls).toBe(0);

    // β 通道 env 双变量 + 假宿路径。
    const homeDir = path.join(HOME_ROOT, 'session-uuid-1');
    expect(env.spawns[0]!.spawnArgs.env).toEqual({ USERPROFILE: homeDir, HOME: homeDir });
    expect(env.spawns[0]!.spawnArgs.args).toContain('30m');
    expect(spy.homeWrites).toHaveLength(1);
    expect(spy.homeWrites[0]).toMatchObject({ homeDir, sessionId: 'session-uuid-1', pipeName: 'pipe-session-uuid-1', token: 'tok-session-uuid-1' });
    // 会话注册先于 turn。
    expect(spy.openedSessions).toEqual(['session-uuid-1']);
    // 流式 delta 只发首轮（CR-5：打回二轮不再发——UI 占位不得重放双份）。
    expect(deltas).toEqual(['初稿完成。']);
  });

  it('09-19 白名单 W2：spawn 恒挂 --agent（布局常量激活值）+ 载荷 agentMarkdown 透传', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => scriptPlainSuccess(proc, 'ok');
    });
    const { core, spy } = fakeCore(env);
    installAgyBridgeCore(core);
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));

    // spawn args：--agent 恒挂（桥假宿 agent 文件系本方每会话必写，无未启用态）。激活值
    // 取 agents.ts 布局常量单源。MCP 继承与 --agent 正交（研究报告 §5 P5/P6 实证——
    // call_mcp_tool 经继承通道注入，不在 frontmatter）——此处断言参数拼装面即可，无需真机。
    const args = env.spawns[0]!.spawnArgs.args;
    const agentIdx = args.indexOf('--agent');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(args[agentIdx + 1]).toBe(CLOSURE_BRIDGE_AGENT_LAYOUT.agentName);
    // --agent 与既有桥参数共存（print-timeout 桥档 / stream-json 双向 / slash 禁用）。
    expect(args).toContain('30m');

    // 载荷透传：agentMarkdown = 内核装配值原样（协议层零内容生成；真实内容 =
    // renderAgentMarkdown(CLOSURE_BRIDGE_AGENT) 的等式断言归 shell 装配/落盘测试）。
    expect(spy.homeWrites).toHaveLength(1);
    expect(spy.homeWrites[0]!.agentMarkdown).toBe(BRIDGE_AGENT_MD_SENTINEL);
  });

  it('present_result 已调（首 turn）→ 不打回；awaiting 从 MCP 派发参数读出', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) scriptPresentResultTurn(proc, '这是呈现。', true);
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const result = await runAgyBridgeTurn(makeInput());
    expect(result.presentResultCalled).toBe(true);
    expect(result.presentResultAwaiting).toBe(true);
    expect(result.sentBack).toBe(false);
    expect(env.spawns[0]!.writtenLines).toHaveLength(1); // 无打回行
    expect(result.bridgeToolCalls).toBe(1); // started 派发步计数
    expect(result.usage).toMatchObject({ promptTokens: 80, completionTokens: 6, totalTokens: 86 }); // 50+30 / 2+4
  });

  it('打回恰好一次：首 turn 未调 → 同会话增量行重跑 → 调了即收', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) scriptPlainSuccess(proc, '直接回答。');
        if (index === 2) scriptPresentResultTurn(proc, '重新呈现并用 present_result 收尾。', false);
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const result = await runAgyBridgeTurn(makeInput());

    expect(result.sentBack).toBe(true);
    expect(result.secondPassMissedPresentResult).toBe(false);
    expect(result.presentResultCalled).toBe(true);
    expect(result.presentResultAwaiting).toBe(false);
    expect(env.spawns).toHaveLength(1); // 同会话（无新进程）
    expect(env.spawns[0]!.writtenLines).toHaveLength(2);
    // 第二行 = 打回提示（合成 user 消息）。
    const sendback = JSON.parse(env.spawns[0]!.writtenLines[1]!) as { event: string; message: { content: string } };
    expect(sendback.event).toBe('user');
    expect(sendback.message.content).toContain('present_result');
    expect(result.text).toBe('重新呈现并用 present_result 收尾。');
  });

  it('二次仍未调 → 接受结果 + 警告（不无限打回）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index >= 1) scriptPlainSuccess(proc, '仍然直接回答。');
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const result = await runAgyBridgeTurn(makeInput());
    expect(result.sentBack).toBe(true);
    expect(result.secondPassMissedPresentResult).toBe(true);
    expect(result.presentResultCalled).toBe(false);
    expect(env.spawns[0]!.writtenLines).toHaveLength(2); // 恰好一次打回
    expect(env.warns.some((w) => w.includes('still not called'))).toBe(true);
  });

  it('打回重跑失败（quota 族）→ 接受首轮有效结果 + 警告（CR-5：不把成功变硬失败）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) scriptPlainSuccess(proc, '首轮有效答案。');
        if (index === 2) proc.scriptErrorTurn('ERROR', 'quota exceeded for today');
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const deltas: string[] = [];
    const result = await runAgyBridgeTurn(makeInput({
      onDelta: (d) => { if (d.type === 'text') deltas.push(d.delta); },
    }));
    // 首轮答案保住：text/usage 均按首轮（失败二轮零 usage 计入）。
    expect(result.text).toBe('首轮有效答案。');
    expect(result.sentBack).toBe(true);
    expect(result.secondPassMissedPresentResult).toBe(true);
    expect(result.usage).toMatchObject({ promptTokens: 100, completionTokens: 5, totalTokens: 105 });
    expect(deltas).toEqual(['首轮有效答案。']); // 首轮 delta 照发 + 二轮零重发
    expect(env.warns.some((w) => w.includes('sendback retry failed'))).toBe(true);
    expect(env.spawns[0]!.writtenLines).toHaveLength(2); // 打回行确实写了
  });

  it('打回重跑期间用户 abort → 照常上抛（CR-5：中断不是可吞失败）', async () => {
    const controller = new AbortController();
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) scriptPlainSuccess(proc, '首轮。');
        if (index === 2) {
          controller.abort(); // 二轮写行前已中断
          proc.scriptErrorTurn('ERROR', 'quota exceeded');
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    await expect(runAgyBridgeTurn(makeInput({ signal: controller.signal }))).rejects.toThrow();
  });

  it('sanitize 撞段防护（CR-10）：两 sessionId 净化到同 homeDir → 第二会话 typed 拒绝', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => scriptPlainSuccess(proc, 'ok');
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false, sessionId: 'a/b', sessionKey: 'chain:a' }));
    expect(env.spawns).toHaveLength(1);
    // 'a/b' 与 'a_b' 净化到同一段——不同 owner 落同 homeDir 即 typed 拒绝（引用计数
    // 跳过 prepareHome 的窗口里绝不静默读错首会话 mcp_config）。
    expect(bridgeHomeDirFor(HOME_ROOT, 'a/b')).toBe(bridgeHomeDirFor(HOME_ROOT, 'a_b'));
    await expect(runAgyBridgeTurn(makeInput({
      requirePresentResult: false, sessionId: 'a_b', sessionKey: 'chain:b',
    }))).rejects.toThrow(AgyFakeHomeCollisionError);
    expect(env.spawns).toHaveLength(1); // 撞段会话零 spawn 占位
  });

  it('requirePresentResult=false（normal/auto 档）→ 未调也不打回', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => scriptPlainSuccess(proc, '正常回答。');
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));
    expect(result.sentBack).toBe(false);
    expect(env.spawns[0]!.writtenLines).toHaveLength(1);
  });

  it('AC3（W7）：mid-turn abort → kill + 会话作废 + 假宿删除 + 临时 cwd 清理（fake 子进程三保险的可测面）', async () => {
    // fake 进程对首行**不回任何事件**（在途 turn 挂起形态）→ abort → runBridgeCycle 的
    // abort 分支 reject + session.invalidate('abort')。生产映射：invalidate → CliChild.kill
    // = spawnRealCli 树杀（win taskkill /T /F / posix kill(-pid)——antigravitySpawnReal/
    // treeKillDispatch 测试钉分支）；孙进程另两保险 = mcpServer stdin EOF 自退（资产测试
    // 覆盖）+ agy 会话结束关 server stdin（官方 EOF——W0 §5 实测，不可本地复现）。
    const controller = new AbortController();
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      spawnCount += 1;
      // 首进程不设 responder（在途 turn 挂起）；冷启动的第二进程正常应答（turn 可收尾）。
      if (spawnCount > 1) proc.responder = () => scriptPlainSuccess(proc, '冷启动回答。');
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const pending = runAgyBridgeTurn(makeInput({ requirePresentResult: false, signal: controller.signal }));
    // CR-16（子4 CR 批）：等可观测信号（spawn 到位 + 首行 stdin 已写）而非固定
    // sleep(10)——负载 CI 下固定窗口与微任务时序赛跑（行未写完即 abort = 假失败面）。
    await vi.waitFor(() => {
      expect(env.spawns.length).toBeGreaterThanOrEqual(1);
      expect(env.spawns[0]!.writtenLines.length).toBeGreaterThanOrEqual(1);
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);

    // 杀树 + 作废：fake 进程被 kill；会话出表（下次冷启动——再跑 turn 即新进程）。
    expect(env.spawns[0]!.killed).toBe(true);
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));
    expect(env.spawns).toHaveLength(2);
    // 假宿 + 临时 cwd 清理：两进程退出（kill/自退）→ 引用归零 → removeDir 各自命中。
    const homeDir = path.join(HOME_ROOT, 'session-uuid-1');
    expect(env.removedDirs).toContain(homeDir);
    expect(env.removedDirs).toContain(env.spawns[0]!.spawnArgs.cwd);
  });

  it('面变更 → 新进程键（D9）：追加消息复用同进程，换面 spawn 新进程', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => scriptPlainSuccess(proc, 'ok');
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    // 第二 turn 追加一条消息（纯重复请求会走零尾段→分歧冷重启，mirror 语义，与本测无关）。
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));
    await runAgyBridgeTurn(makeInput({
      requirePresentResult: false,
      messages: [{ role: 'user', content: '写第一章' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: '继续' }],
    }));
    expect(env.spawns).toHaveLength(1); // 同面追加 → 增量 turn 复用进程
    const biggerFace = [...FACE, { name: 'wiki_search', description: '检索设定维基。', inputSchema: { type: 'object' } }];
    await runAgyBridgeTurn(makeInput({
      requirePresentResult: false,
      face: biggerFace,
      messages: [{ role: 'user', content: '写第一章' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: '继续' }],
    }));
    expect(env.spawns).toHaveLength(2); // 面变更 → 新池键 → 新进程
  });

  it('假宿准备失败 → spawn 失败（调用方收原错误，零进程占位）', async () => {
    const env = fakePoolEnv();
    const { core, spy } = fakeCore(env);
    core.writeHomePayload = async () => { throw new Error('.gemini copy failed'); };
    installAgyBridgeCore(core);
    await expect(runAgyBridgeTurn(makeInput())).rejects.toThrow('.gemini copy failed');
    expect(env.spawns).toHaveLength(0);
    expect(spy.homeWrites).toHaveLength(0);
  });

  it('软拒诊断：W0 §2 主信号（流事件 tool_info.error）+ denied_actions 兜底 + 零桥面调用', async () => {
    // 主信号样本（w0-findings §2 样本②，flat 化——nested 形态在 events 测试钉）。
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        proc.emitEvent({ type: 'step_update', step_index: 4, state: 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { text: 'hi' }, ServerName: BRIDGE_MCP_SERVER_NAME, ToolName: 'write_chapter' }, error: { type: 'TOOL_ERROR', message: 'permission check failed for mcp "novel-writing/write_chapter": user denied permission for mcp(novel-writing/write_chapter)' } } });
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '工具不可用，已放弃。', denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }] });
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));
    expect(result.mcpSoftDenied).toBe(true);
    expect(result.bridgeToolCalls).toBe(0); // started 步零计数（软拒在派发前，agy 侧）
    expect(result.text).toBe('工具不可用，已放弃。');
  });

  it('软拒兜底①（stderr 通知）单独命中也置位', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        proc.emitStderr('jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. mcp(<target>)).');
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文' });
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));
    expect(result.mcpSoftDenied).toBe(true);
  });

  it('R6/F13 内置工具软拒（ERROR 步，主体 = read_file）→ builtin-tool-denied 相位；MCP 主体判定不置位', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) {
          // F8 §2.1 逐字形态：内置工具 ACTIVE（R5 相位）→ 同 step ERROR（error.message 主体
          // 是权限能力名 read_file，不是工具名 list_dir——旧三针 `mcp "` 在此全打空）。
          proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { DirectoryPath: 'C:/tmp/marker' } } });
          proc.emitEvent({
            type: 'step_update', step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'list_dir',
            tool_info: {
              name: 'list_dir',
              parameters: { DirectoryPath: 'C:/tmp/marker' },
              error: { type: 'TOOL_ERROR', message: 'permission check failed for read_file "C:/tmp/marker": user denied permission for read_file(C:/tmp/marker)' },
            },
          });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '改用桥内工具。' });
          return;
        }
        if (index === 2) {
          // R7 纠正续跑轮（内置工具步触发注入——判据行与终态同轮到达的实测形态）。
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '已改用桥内工具作答。' });
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const phases: AgyBridgePhaseEvent[] = [];
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => phases.push(p) }));

    expect(phases).toEqual([
      { kind: 'builtin-tool-started', toolName: 'list_dir', stepIndex: 2 },
      { kind: 'builtin-tool-denied', toolName: 'list_dir', stepIndex: 2 },
    ]);
    // F9 反向：内置工具软拒不污染 MCP 软拒面（mcpSoftDenied 只认 'mcp' 主体）。
    expect(result.mcpSoftDenied).toBe(false);
    // R7：前置轮（软拒 + 无产出）被纠正轮取代——只认纠正后那轮的正文。
    expect(result.text).toBe('已改用桥内工具作答。');
  });

  it('R6 三信号去重：流事件 error 先到（有名）→ stderr + denied_actions 不重发', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) {
          // R7：**只到达 ERROR 步**（无前置 ACTIVE 的内置工具步形态——判定不得依赖 ACTIVE
          // 先到；此处兼作纠正续跑第二触发点的集成覆盖）。
          proc.emitEvent({
            type: 'step_update', step_index: 3, state: 'ERROR', step_type: 'tool', tool_name: 'grep_search',
            tool_info: { name: 'grep_search', error: { message: 'permission check failed for ListDir "C:/tmp/x": user denied permission for ListDir(C:/tmp/x)' } },
          });
          proc.emitStderr('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.');
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '放弃检索。', denied_actions: [{ action: 'read_file', display_name: 'ListDir' }] });
          return;
        }
        if (index === 2) {
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '改走桥内检索。' });
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const phases: AgyBridgePhaseEvent[] = [];
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => phases.push(p) }));

    expect(phases).toEqual([{ kind: 'builtin-tool-denied', toolName: 'grep_search', stepIndex: 3 }]);
    expect(result.mcpSoftDenied).toBe(false);
    expect(result.text).toBe('改走桥内检索。');
  });

  it('R6 stderr 兜底单独命中（无流事件步）→ 相位无名（stepIndex/toolName 键缺席）；CR-2 旁证门', async () => {
    const stderrOnly = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        proc.emitStderr('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.');
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文' });
      };
    });
    const a = fakeCore(stderrOnly);
    installAgyBridgeCore(a.core);
    const stderrPhases: AgyBridgePhaseEvent[] = [];
    const stderrResult = await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => stderrPhases.push(p) }));
    expect(stderrPhases).toEqual([{ kind: 'builtin-tool-denied' }]);
    // 缺席即不带键（undefined 不混进相位载荷——消费侧 `in` 判定干净）。
    expect('toolName' in stderrPhases[0]!).toBe(false);
    expect('stepIndex' in stderrPhases[0]!).toBe(false);
    expect(stderrResult.mcpSoftDenied).toBe(false);
    uninstallAgyBridgeCoreForTest();

    // CR-2：denied_actions 是**终态字段**，单独命中不构成归因（正常出文的成功回合同样可能
    // 携带非 mcp 项——单凭它发「被拒」通知正是本批要消灭的假归因类）⇒ 无旁证不发相位。
    const deniedActionsOnly = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文', denied_actions: [{ action: 'ListDir', display_name: 'ListDir' }] });
      };
    });
    const b = fakeCore(deniedActionsOnly);
    installAgyBridgeCore(b.core);
    const deniedPhases: AgyBridgePhaseEvent[] = [];
    const deniedResult = await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => deniedPhases.push(p) }));
    expect(deniedPhases).toEqual([]);
    expect(deniedResult.mcpSoftDenied).toBe(false);
    uninstallAgyBridgeCoreForTest();

    // 同字段 + 旁证（本 turn 确有内置工具步）→ 发相位（兜底路不带名/步号，键缺席）。
    const corroborated = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) {
          proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { DirectoryPath: 'C:/tmp/x' } } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文', denied_actions: [{ action: 'ListDir', display_name: 'ListDir' }] });
          return;
        }
        if (index === 2) {
          // R7 纠正轮（内置工具步必然触发注入）：其 result 携带 denied_actions 且为终态。
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文', denied_actions: [{ action: 'ListDir', display_name: 'ListDir' }] });
        }
      };
    });
    const c = fakeCore(corroborated);
    installAgyBridgeCore(c.core);
    const corroboratedPhases: AgyBridgePhaseEvent[] = [];
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => corroboratedPhases.push(p) }));
    expect(corroboratedPhases).toEqual([
      { kind: 'builtin-tool-started', toolName: 'list_dir', stepIndex: 1 },
      { kind: 'builtin-tool-denied' },
    ]);
  });

  it('CR-2 旁证门（DONE 步计入，队长裁决 2026-09-19）：DONE-only 内置步发 / MCP DONE 帧不旁证 / 无 deny 项静默', async () => {
    // ① DONE-only 内置工具步（无 ACTIVE / ERROR 帧——旁证不得依赖帧相位先到；R8 真机形态
    // 「同 turn 既调桥件又调内置且都成功」）+ 非 mcp denied_actions → **发** deny 相位
    //（兜底路不带名/步号，键缺席）。
    const doneOnly = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', output: 'marker.txt' } });
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文', denied_actions: [{ action: 'ListDir', display_name: 'ListDir' }] });
      };
    });
    const a = fakeCore(doneOnly);
    installAgyBridgeCore(a.core);
    const donePhases: AgyBridgePhaseEvent[] = [];
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => donePhases.push(p) }));
    expect(donePhases).toEqual([{ kind: 'builtin-tool-denied' }]);
    uninstallAgyBridgeCoreForTest();

    // ② MCP 派发器的 DONE 帧（名字 = 派发器；DONE 帧不携 parameters，纯参数判据会误中）
    // + 同形 denied_actions → **不**旁证 ⇒ 静默（CR-8 名字兜底在 DONE 路径同样生效）。
    const mcpDone = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        proc.emitEvent({ type: 'step_update', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: AGY_MCP_DISPATCHER_TOOL_NAME, tool_info: { name: AGY_MCP_DISPATCHER_TOOL_NAME, output: 'ok' } });
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文', denied_actions: [{ action: 'ListDir', display_name: 'ListDir' }] });
      };
    });
    const b = fakeCore(mcpDone);
    installAgyBridgeCore(b.core);
    const mcpDonePhases: AgyBridgePhaseEvent[] = [];
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => mcpDonePhases.push(p) }));
    expect(mcpDonePhases).toEqual([]);
    uninstallAgyBridgeCoreForTest();

    // ③ DONE-only 内置步 + 无 deny 项 → 静默（旁证只开门，不自行归因）。
    const doneOnlyNoDeny = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', output: 'marker.txt' } });
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '回复正文' });
      };
    });
    const c = fakeCore(doneOnlyNoDeny);
    installAgyBridgeCore(c.core);
    const noDenyPhases: AgyBridgePhaseEvent[] = [];
    await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => noDenyPhases.push(p) }));
    expect(noDenyPhases).toEqual([]);
  });

  it('R6 防过度匹配：无主体软拒文本（unknown tool 形态）→ 两族相位皆不发', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        // R10 形态：未知工具名（DONE + error，非权限软拒）——判据不得命中。
        proc.emitEvent({
          type: 'step_update', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'totally_fake_xyz',
          tool_info: { name: 'totally_fake_xyz', error: { message: 'unknown tool: "totally_fake_xyz" — check spelling' } },
        });
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '正常收尾。' });
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const phases: AgyBridgePhaseEvent[] = [];
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => phases.push(p) }));
    expect(phases).toEqual([]);
    expect(result.mcpSoftDenied).toBe(false);
  });

  it('终态 ERROR → driver 错误分类表映射（classifyCliError 同源）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) proc.scriptErrorTurn('ERROR', 'quota exceeded for today');
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    // 注意：ERROR 终态不打回（打回门只看 SUCCESS 后的 present_result 缺席）。
    await expect(runAgyBridgeTurn(makeInput())).rejects.toThrow(/quota/);
    expect(env.spawns[0]!.writtenLines).toHaveLength(1);
  });

  it('onPhase（W4/R5 相位事件）：桥面工具 started / 内置工具步 builtin-tool-started / 纠正续跑 / sendback+missed / soft-denied 去重', async () => {
    // 软拒主信号 + 桥面派发 started（write_chapter）+ 内置工具步（run_command——R5 起发
    // builtin-tool-started，与桥相位分开）+ R7 纠正续跑（同轮空终态 → 注入 → 纠正轮收尾）
    // + 打回（requirePresentResult=true 未调）→ 二次未调 missed。
    let writeSeq = 0;
    const env = fakePoolEnv((proc) => {
      // 本 turn 的写入序（跨进程计数）：1 = 首轮、2 = R7 纠正行、3 = 打回行。打回行落冷
      // 重启的新进程（镜像含纠正段 → 判分歧），进程内索引会从 1 重来，故按写入序区分。
      proc.responder = (_line, index) => {
        writeSeq += 1;
        if (index === 1) {
          if (writeSeq >= 3) {
            // 打回二轮：仍未调 present_result → sendback-missed。
            proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '打回后仍然直接回答。' });
            return;
          }
          proc.emitEvent({ type: 'init', cwd: proc.spawnArgs.cwd, tools: [], permission_mode: 'request-review' });
          // agy 内置工具步（非 MCP 派发）——R5：发独立相位（tool-started 不放宽，防 UI 把内置
          // 工具当桥件显示「正在调用 X」）。
          proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { command: 'dir' } } });
          proc.emitEvent({ type: 'step_update', step_index: 1, state: 'DONE', step_type: 'tool' });
          // 桥面派发步（软拒 ERROR 形态——started 已发，error 携主信号）。
          proc.emitEvent({
            type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool',
            tool_info: { name: 'call_mcp_tool', parameters: { ServerName: BRIDGE_MCP_SERVER_NAME, ToolName: 'write_chapter', Arguments: { episodeId: 'ep1' } } },
          });
          proc.emitEvent({
            type: 'step_update', step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool',
            tool_info: { name: 'call_mcp_tool', error: { message: 'permission check failed for mcp "novel-writing/write_chapter": denied' } },
          });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '放弃。', denied_actions: [{ action: 'mcp' }] });
          return;
        }
        if (index === 2) {
          // R7 纠正轮：仍未调 present_result（本轮 result 即终态 → 打回门照走）。
          proc.emitEvent({ type: 'step_update', step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '仍然直接回答。', usage: { input: 10, output: 2, total: 12 } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '仍然直接回答。' });
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const phases: string[] = [];
    const result = await runAgyBridgeTurn(makeInput({
      onPhase: (p) => {
        phases.push(
          p.kind === 'tool-started' || p.kind === 'builtin-tool-started' ? `${p.kind}:${p.toolName}` : p.kind,
        );
      },
    }));

    expect(phases).toEqual([
      'builtin-tool-started:run_command', // 内置工具步（R5 新相位——非桥工具族）
      'tool-started:write_chapter',       // 桥面派发步（软拒发生在 agy 侧，started 照发）
      'soft-denied',                      // 主信号（流事件 error）——denied_actions 信号不重发（去重）
      'sendback',                         // R7 纠正轮收尾后未调 present_result → 打回一次
      'sendback-missed',                  // 打回二轮仍未调
    ]);
    expect(result.mcpSoftDenied).toBe(true);
    // 首进程写入 = 首行 + 恰一次纠正行（纠正轮不再注入——≤1 封顶；打回行落在冷重启的新进程）。
    expect(env.spawns[0]!.writtenLines).toHaveLength(2);
    expect(JSON.parse(env.spawns[0]!.writtenLines[1]!) as { message: { content: string } }).toMatchObject({
      message: { content: `【用户】\n${BRIDGE_BUILTIN_TOOL_CORRECTION_MESSAGE}` },
    });
  });

  it('R5 相位分类边界：内置步携 stepIndex / 桥步不发新相位 / 无派发参数的裸步同属内置族', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) {
          // ① 内置工具步——工具名只在 tool_info.name（tool_name 缺省；events 两跳兜底）。
          proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'list_dir' } });
          // ② 桥面派发步——唯一应发 tool-started 的形态。
          proc.emitEvent({
            type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool',
            tool_info: { name: 'call_mcp_tool', parameters: { ServerName: BRIDGE_MCP_SERVER_NAME, ToolName: 'read_file' } },
          });
          // ③ 无名无派发参数的裸步——同属内置工具族（有工具名但解析不出 MCP 派发 = 非桥件，
          // 判定面与相位面共用 isBuiltinToolStep 单源），相位不发（无名步无可辨识信息）。
          // R7 纠正续跑在此同样触发（② 的桥步不触发、③ 的裸步触发——两向边界）。
          proc.emitEvent({ type: 'step_update', step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_info: { parameters: { command: 'dir' } } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '好了。' });
          return;
        }
        if (index === 2) {
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '已改走桥内工具。' });
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const phases: AgyBridgePhaseEvent[] = [];
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => phases.push(p) }));

    expect(phases).toEqual([
      { kind: 'builtin-tool-started', toolName: 'list_dir', stepIndex: 1 },
      { kind: 'tool-started', toolName: 'read_file', stepIndex: 2 },
    ]);
    // R7 两向断言：② 桥步不触发注入（首轮结果不被延后）；③ 裸步触发恰一次注入。
    // 段形态与既有消息一致（【用户】角色标记由 composeMessageSegment 生成，Wire 与历史消息同形）。
    expect(env.spawns[0]!.writtenLines).toHaveLength(2);
    expect(JSON.parse(env.spawns[0]!.writtenLines[1]!) as { message: { content: string } }).toMatchObject({
      message: { content: `【用户】\n${BRIDGE_BUILTIN_TOOL_CORRECTION_MESSAGE}` },
    });
    expect(result.text).toBe('已改走桥内工具。');
  });

  it('R7 纠正续跑：内置工具步触发 → stdin 恰一次纠正行（位置/内容）+ 镜像记账序列含纠正段', async () => {
    let correctionText: string | undefined;
    const env = fakePoolEnv((proc) => {
      proc.responder = (line, index) => {
        if (index === 1) {
          // R6 主样本形态：内置工具步（ACTIVE）后同轮空终态（模型不再产出）。
          proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { DirectoryPath: 'C:/tmp/marker' } } });
          proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', error: { message: 'permission check failed for read_file "C:/tmp/marker": user denied permission for read_file(C:/tmp/marker)' } } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '' });
          return;
        }
        if (index === 2) {
          // 纠正行被受理为下一轮：产出实质回答（R6 实证形态）。
          correctionText = JSON.parse(line).message.content as string;
          proc.emitEvent({ type: 'step_update', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '已改用桥内工具作答。', usage: { input: 40, output: 6, total: 46 } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '已改用桥内工具作答。' });
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const deltas: string[] = [];
    const result = await runAgyBridgeTurn(makeInput({
      requirePresentResult: false,
      onDelta: (d) => { if (d.type === 'text') deltas.push(d.delta); },
    }));

    // ① stdin：首行（turn）+ 纠正行（恰两条；纠正行内容 = 常量单源 + 【用户】角色标记，
    // 与既有消息段同形；注入点就在内置步之后）。
    const writes = env.spawns[0]!.writtenLines;
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]!) as { event: string }).toMatchObject({ event: 'user' });
    expect(correctionText).toBe(`【用户】\n${BRIDGE_BUILTIN_TOOL_CORRECTION_MESSAGE}`);
    // 措辞纪律：点名本会话工具族 + 改道路径；不下禁令式措辞（present_result 协议撞车教训）。
    expect(correctionText).toContain(BRIDGE_MCP_SERVER_NAME);
    expect(correctionText).toContain('novel-writing');
    expect(correctionText).not.toContain('不要调用');
    expect(correctionText).not.toContain('绝不使用');

    // ② 镜像记账：以**本 cycle 全序列 + 纠正段**提交（缺席则写作 '[]'+'[correction]' 半截序列）。
    // 恰两段：首行路径 commit（基准）+ 纠正 commit（基准 + 纠正段）——基准不重复补交；同值重复
    // 提交在 commitSeenHashes 的**绝对赋值**语义下反而会把终态覆盖回半截（bridgeTurn.ts 注）。
    const segments = buildTurnSegments('你是写作助手。', [{ role: 'user', content: '写第一章' }], {
      outputDirective: BRIDGE_OUTPUT_DIRECTIVE,
    });
    const correctionSegment = composeMessageSegment({ role: 'user', content: BRIDGE_BUILTIN_TOOL_CORRECTION_MESSAGE });
    const baseHashes = hashSegments(segments);
    const correctionHash = hashSegment(correctionSegment);
    expect(env.commitCalls).toEqual([baseHashes, [...baseHashes, correctionHash]]);
    // 既有单点断言保持：末次提交即最终态（含纠正 hash）。
    expect(env.commitCalls.at(-1)).toEqual([...baseHashes, correctionHash]);

    // ③ settle 延后：终文 = 纠正后那一轮的产出（前置空轮不得作终态）。
    expect(result.text).toBe('已改用桥内工具作答。');
    // usage 只记纠正后那一轮（前置轮聚合器已复位——打回二轮独立聚合的同源语义）。
    expect(result.usage).toMatchObject({ promptTokens: 40, completionTokens: 6, totalTokens: 46 });
    // delta 口径不变（R7 不另立门）：两轮正文照发，终文以 result 为权威。
    expect(deltas).toEqual(['已改用桥内工具作答。']);
    expect(env.infos.some((m) => m.includes('list_dir'))).toBe(true); // 观测行含被判定的工具名
  });

  it('R7 纠正后续跑仍走内置工具 → 不二次注入，settle 认纠正后那轮的 result 收场', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) {
          proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { command: 'dir' } } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '' });
          return;
        }
        if (index === 2) {
          // 纠正后仍触发内置工具步——不再注入（≤1 封顶），settle 认本轮的 result。
          proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { command: 'whoami' } } });
          proc.emitEvent({ type: 'step_update', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '这是纯文本回答。', usage: { input: 20, output: 3, total: 23 } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '这是纯文本回答。' });
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));

    expect(env.spawns[0]!.writtenLines).toHaveLength(2); // 首行 + 恰一次纠正行
    expect(result.text).toBe('这是纯文本回答。');
    // 两轮 step 记录都在（started×2），但注入只有一次——二次触发走既有收场路径，不递归。
    expect(result.toolSteps.filter((s) => s.phase === 'started')).toHaveLength(2);
  });

  it('R7 纠正行写失败：不吞——不重试写（写失败作废会话）', async () => {
    // 纠正行（第 2 次写入）注入式失败：进程仍活、结果流照常——失败只可能来自 writeLine，
    // 排除「退出观察先 settle」把本路径遮蔽成另一个错误面。
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        // 首行已写成功 → 武装一次性写失败：下一次写入（ACTIVE 事件触发的纠正行）必失败。
        // 仅首轮（首进程）武装——冷启动的新进程照常可写（后续轮断言面）。
        if (env.spawns.length === 1) proc.writeFailureBudget = 1;
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { DirectoryPath: 'C:/tmp/x' } } });
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '空。' });
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    // requirePresentResult=false：本用例只查纠正写失败一面——开着打回会让「打回重跑失败」
    // 的吞并路径（CR-5）承接本拒绝，混淆断言面。
    let caught: unknown;
    try {
      await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof Error ? caught.message : String(caught)).toMatch(/corrective stdin write failed/);
    expect(env.warns.some((w) => w.includes('correction-write-failed'))).toBe(true);
    // 失败不吞：恰一次写入尝试（不重试写）+ 会话作废（下次冷启动）。
    expect(env.spawns[0]!.writtenLines).toHaveLength(1);
  });

  it('CR-1 纠正写失败落在外层 settle 之后 → 失败仍被观察（warn 记账），不重写已定结局', async () => {
    // 同一同步段内：纠正行写失败武装 + ACTIVE 内置步（触发注入）+ 进程退出。退出观察先
    // settle（reject 502），纠正写的 rejection 随后到达——旧实现此处 settle 短路、回调不
    // 执行，失败被静默丢弃（写失败不吞在短路路径上落空）。
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        if (env.spawns.length === 1) proc.writeFailureBudget = 1;
        proc.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { DirectoryPath: 'C:/tmp/x' } } });
        proc.exit(1);
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    let caught: unknown;
    try {
      await runAgyBridgeTurn(makeInput({ requirePresentResult: false }));
    } catch (err) {
      caught = err;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    // 结局 = 先 settle 者的形态（退出 502）——纠正在途写失败不重写已定结局。
    expect(message).toMatch(/exited/);
    expect(message).not.toMatch(/corrective stdin write failed/);
    // 但失败不再无声：短路路径落一条 warn（可观测）。
    expect(env.warns.some((w) => w.includes('corrective stdin write failed after this cycle had already settled'))).toBe(true);
  });

  it('CR-8 派发器退化步（call_mcp_tool 无 parameters）→ 不算内置工具步：零纠正注入、当轮 result 即终态', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index !== 1) return;
        // 派发器 ERROR 步的退化形态（tool_info 无 parameters——W0 §2 样本的缺参变体）：
        // 解析不出 ServerName/ToolName，但模型用的正是桥派发通道，不是内置工具。
        proc.emitEvent({
          type: 'step_update', step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool',
          tool_info: { name: 'call_mcp_tool', error: { message: 'tool invocation failed: missing required parameter ServerName' } },
        });
        proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '已直接用文本作答。' });
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const phases: AgyBridgePhaseEvent[] = [];
    const result = await runAgyBridgeTurn(makeInput({ requirePresentResult: false, onPhase: (p) => phases.push(p) }));

    expect(phases).toEqual([]); // 两相位皆不发（非桥件目标、也非内置工具）
    expect(env.spawns[0]!.writtenLines).toHaveLength(1); // 零纠正注入（第二行缺席）
    // 当轮 result 即终态（旧判据会注入纠正文并把本 result 当「前置轮」丢弃——整轮挂到 belt）。
    expect(result.text).toBe('已直接用文本作答。');
    // 步记录照常（观测面不吞）。
    expect(result.toolSteps).toHaveLength(1);
  });
});
