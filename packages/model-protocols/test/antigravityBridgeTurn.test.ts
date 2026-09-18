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
  type AgyBridgeCore,
  type BridgeToolFaceEntry,
  type BridgeTurnInput,
} from '../src/antigravityCli/bridgeTurn';
import { AgyFakeHomeCollisionError } from '../src/antigravityCli/sessions';
import { fakePoolEnv, type FakeAgyProcess, type FakePoolEnv } from './antigravityCliFakes';

// ── 子4 W1：桥 turn 编排集成测试（fake 子进程 + fake 内核——零真 agy / 零真管道）──
//
// 覆盖面（implement.md W1）：打回恰好一次 / 二次未调接受+警告 / 面变更→新进程键 /
// 假宿准备失败→spawn 失败 / 软拒诊断 / env·print-timeout·池键装配。

const FACE: BridgeToolFaceEntry[] = [
  { name: 'present_result', description: '呈现结果并声明本轮结束。', inputSchema: { type: 'object' } },
  { name: 'write_chapter', description: '为指定章节触发完整写作流程。', inputSchema: { type: 'object' } },
];

const HOME_ROOT = '/fake-bridge-home';

interface CoreSpy {
  homeWrites: Array<{ homeDir: string; sessionId: string; pipeName: string; token: string }>;
  openedSessions: string[];
}

function fakeCore(env: FakePoolEnv): { core: AgyBridgeCore; spy: CoreSpy } {
  const spy: CoreSpy = { homeWrites: [], openedSessions: [] };
  const pipes = new Map<string, { pipeName: string; token: string }>();
  const core: AgyBridgeCore = {
    homeRoot: HOME_ROOT,
    writeHomePayload: async (input) => {
      spy.homeWrites.push({ homeDir: input.homeDir, sessionId: input.sessionId, pipeName: input.pipeName, token: input.token });
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

  it('onPhase（W4 相位事件）：桥面工具 started / agy 内置工具步不发 / sendback+missed / soft-denied 去重', async () => {
    // 软拒主信号 + 桥面派发 started（write_chapter）+ 内置工具步（run_command——不发）+
    // 打回（requirePresentResult=true 未调）→ 二次未调 missed。
    const env = fakePoolEnv((proc) => {
      proc.responder = (_line, index) => {
        if (index === 1) {
          proc.emitEvent({ type: 'init', cwd: proc.spawnArgs.cwd, tools: [], permission_mode: 'request-review' });
          // agy 内置工具步（非 novel-writing 派发）——相位不发改写后断言零 tool-started。
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
          // 打回二轮：仍未调 present_result（plain success → sendback-missed）。
          proc.emitEvent({ type: 'step_update', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '仍然直接回答。', usage: { input: 10, output: 2, total: 12 } });
          proc.emitEvent({ type: 'result', conversation_id: 'c1', status: 'SUCCESS', response: '仍然直接回答。' });
        }
      };
    });
    const { core } = fakeCore(env);
    installAgyBridgeCore(core);
    const phases: string[] = [];
    const result = await runAgyBridgeTurn(makeInput({
      onPhase: (p) => { phases.push(p.kind === 'tool-started' ? `tool-started:${p.toolName}` : p.kind); },
    }));

    expect(phases).toEqual([
      'tool-started:write_chapter', // 桥面派发步（软拒发生在 agy 侧，started 照发）
      'soft-denied',                // 主信号（流事件 error）——denied_actions 信号不重发（去重）
      'sendback',                   // 未调 present_result → 打回一次
      'sendback-missed',            // 二轮（responder 只编第一轮）仍未调
    ]);
    expect(result.mcpSoftDenied).toBe(true);
  });
});
