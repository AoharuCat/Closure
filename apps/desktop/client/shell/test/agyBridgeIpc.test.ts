import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRef, ResolvedModel } from '@orison/shared-contracts';

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
// R9 观测：导出换「记调用 + 真实现（注入收集 sink）」包装——取景时机由 cliLogCalls 断，
// 行内容由 cliLogLines 断（真定位 / 真归类 / 真降级路径全在链上跑，非 mock 掉断言）。
const { cliLogCalls, cliLogLines } = vi.hoisted(() => ({
  cliLogCalls: vi.fn(),
  cliLogLines: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
}));

vi.mock('../main/ipc/agyCliLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/agyCliLog')>();
  return {
    ...actual,
    observeAgyCliAgentState: (input: Parameters<typeof actual.observeAgyCliAgentState>[0]) => {
      cliLogCalls(input);
      return actual.observeAgyCliAgentState({ ...input, sink: cliLogLines });
    },
  };
});

// Partial mock：runAgyBridgeTurn 换 spy（零真 agy / 零真池），其余导出保持真身
//（BRIDGE_MCP_SERVER_NAME 等被 agyBridge/modelGatewayIpc 链消费）。
vi.mock('@orison/model-protocols', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/model-protocols')>();
  return {
    ...actual,
    runAgyBridgeTurn: vi.fn(),
  };
});

import { classifyCliError, runAgyBridgeTurn, BRIDGE_MCP_SERVER_NAME } from '@orison/model-protocols';
import {
  __resetAgyBridgeUsedForTest,
  createAgyBridgeLaneModeResolver,
  createAgyBridgeTurnProduction,
  registerAgyBridgeIpc,
  wasAgyBridgeUsed,
  type AgyBridgeProductionDeps,
} from '../main/ipc/agyBridgeIpc';
import { createAgyBridgeRegistry, defaultAgyBridgeHomeRoot } from '../main/ipc/agyBridge';
import { agyCliLogDirFor } from '../main/ipc/agyCliLog';
import {
  createAgyBridgeConsentStore,
  type AgyBridgeConsentStore,
} from '../main/ipc/agyBridgeConsent';
import { rmBestEffort } from './rmBestEffort';
import type { BridgeTurnRequest } from '@orison/desktop-agent';

// ── 子4 W4：桥车道生产实现 + IPC 三通道测试 ──
//
// 覆盖面：模式判定矩阵（not-cli/declined/missing-consent/conflict/ok）、turn 生产入口
// consent 硬门（CR-27——declined 零绕过红线）、ok 路径装配（cliExecutable 解析 + 注册表
// 预开 + live 监听 + abort → revoke）、IPC handler 形态（模式 A）。零真 agy / 零真实
// `~/.gemini` 写（settings 只读 fixture 在 temp 根）。

const CLI_RESOLVED: ResolvedModel = {
  keyId: 'key-cli',
  modelId: 'gemini-3.8-pro-high',
  protocol: 'antigravity-cli',
  baseUrl: '',
  apiKey: '',
  capability: 'text',
  cliExecutable: 'C:/agy/bin/agy.exe',
};
const HTTP_RESOLVED: ResolvedModel = {
  keyId: 'key-http',
  modelId: 'gpt-x',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  capability: 'text',
};

/** temp 夹具登记（顶层 afterEach 统一 rmBestEffort——测试不留残）。 */
const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmBestEffort(dir);
});

function makeDeps(opts: {
  resolved?: ResolvedModel;
  consent?: 'allowed' | 'declined';
  settings?: string;
} = {}): {
  deps: AgyBridgeProductionDeps;
  store: AgyBridgeConsentStore;
  realHome: string;
  homeRoot: string;
} {
  const realHome = makeTempDir('agy-bridge-ipc-home-');
  // R9 观测面的假宿根（观测模块按它定位本会话日志；缺省真根是用户家目录——测试一律 temp）。
  const homeRoot = makeTempDir('agy-bridge-ipc-fakehome-');
  const store = createAgyBridgeConsentStore({
    filePath: path.join(makeTempDir('agy-bridge-ipc-consent-'), 'consent.json'),
  });
  if (opts.consent !== undefined) store.set(opts.consent);
  if (opts.settings !== undefined) {
    mkdirSync(path.join(realHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(
      path.join(realHome, '.gemini', 'antigravity-cli', 'settings.json'),
      opts.settings,
      'utf8',
    );
  }
  const deps: AgyBridgeProductionDeps = {
    resolveModelRef: vi.fn(() => opts.resolved ?? HTTP_RESOLVED) as unknown as (ref: ModelRef) => ResolvedModel,
    registry: () => createAgyBridgeRegistry(),
    consentStore: () => store,
    realHome,
    homeRoot,
  };
  return { deps, store, realHome, homeRoot };
}

// ── R9 观测断言面（真实现 + 收集 sink 包装）──

type CliLogCallInput = { homeRoot: string; sessionId: string; reason: string };

const cliLogReasons = (): string[] => cliLogCalls.mock.calls.map(([i]) => (i as CliLogCallInput).reason);
const cliLogCount = (reason: string): number => cliLogReasons().filter((r) => r === reason).length;
const cliLogPayloads = (reason: string): Record<string, unknown>[] =>
  [...cliLogLines.info.mock.calls, ...cliLogLines.warn.mock.calls]
    .map(([p]) => p as Record<string, unknown>)
    .filter((p) => p.reason === reason);

const REF: ModelRef = { keyId: 'key-cli', modelId: 'gemini-3.8-pro-high' };

function makeRequest(overrides: Partial<BridgeTurnRequest> = {}): BridgeTurnRequest {
  return {
    modelRef: REF,
    system: 'SYSTEM',
    messages: [{ role: 'user', content: '写第一章' }],
    sessionKey: 'dialogue:s1',
    sessionId: 'sess-1',
    projectDir: 'C:/proj',
    permissionMode: 'suggest',
    face: [{ name: 'present_result', description: '呈现结果。', inputSchema: { type: 'object' } }],
    requirePresentResult: false,
    ...overrides,
  };
}

describe('模式判定生产实现（createAgyBridgeLaneModeResolver）', () => {
  it('protocol 非 CLI → off（HTTP 模型零同意面）', () => {
    const { deps } = makeDeps({ resolved: HTTP_RESOLVED, consent: 'allowed' });
    const resolver = createAgyBridgeLaneModeResolver(deps);
    expect(resolver({ modelRef: REF })).toEqual({ mode: 'off', reason: 'not-cli' });
  });

  it('resolveModel 抛错（未配置/病态）→ off（不放大错误面）', () => {
    const { deps } = makeDeps();
    (deps.resolveModelRef as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('no keys configured');
    });
    const resolver = createAgyBridgeLaneModeResolver(deps);
    expect(resolver({ modelRef: REF })).toEqual({ mode: 'off', reason: 'not-cli' });
  });

  it('declined → off（AC6 降级纯文本——用户选择不重启征询）', () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'declined' });
    const resolver = createAgyBridgeLaneModeResolver(deps);
    expect(resolver({ modelRef: REF })).toEqual({ mode: 'off', reason: 'declined' });
  });

  it('未同意 → rejected missing-consent；deny/ask 压制 → rejected conflict（规则原文随行）', () => {
    const noConsent = makeDeps({ resolved: CLI_RESOLVED });
    expect(createAgyBridgeLaneModeResolver(noConsent.deps)({ modelRef: REF }))
      .toEqual({ mode: 'rejected', state: 'missing-consent', conflicts: [] });

    const conflicted = makeDeps({
      resolved: CLI_RESOLVED,
      consent: 'allowed',
      settings: JSON.stringify({ permissions: { deny: ['mcp(novel-writing/*)'], ask: ['mcp(*)'] } }),
    });
    expect(createAgyBridgeLaneModeResolver(conflicted.deps)({ modelRef: REF }))
      .toEqual({ mode: 'rejected', state: 'conflict', conflicts: ['mcp(novel-writing/*)', 'mcp(*)'] });
  });

  it('ok：已同意 + 无冲突 → bridge', () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    expect(createAgyBridgeLaneModeResolver(deps)({ modelRef: REF })).toEqual({ mode: 'bridge' });
  });
});

describe('turn 生产入口（createAgyBridgeTurnProduction）', () => {
  beforeEach(() => {
    vi.mocked(runAgyBridgeTurn).mockReset();
    cliLogCalls.mockReset();
    cliLogLines.info.mockReset();
    cliLogLines.warn.mockReset();
    __resetAgyBridgeUsedForTest();
  });

  afterEach(() => {
    __resetAgyBridgeUsedForTest();
  });

  it('consent 硬门（CR-27）：declined / missing-consent 直调 seam 也拦——零绕过面', async () => {
    const declined = makeDeps({ resolved: CLI_RESOLVED, consent: 'declined' });
    const turn = createAgyBridgeTurnProduction(declined.deps);
    await expect(turn(makeRequest())).rejects.toThrow('agy_bridge_consent|state=declined');
    expect(runAgyBridgeTurn).not.toHaveBeenCalled();

    const missing = makeDeps({ resolved: CLI_RESOLVED });
    await expect(createAgyBridgeTurnProduction(missing.deps)(makeRequest()))
      .rejects.toThrow('agy_bridge_consent|state=missing-consent');
    expect(runAgyBridgeTurn).not.toHaveBeenCalled();
  });

  it('ok 路径：cliExecutable 解析注入 + 注册表预开 + live 监听接线 + wasUsed 置位', async () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    const seenCalls: unknown[] = [];
    vi.mocked(runAgyBridgeTurn).mockImplementation(async (input) => {
      seenCalls.push(input);
      // live 监听在 turn 期间有效：注册表记录回调直达 executor。
      const record = registry.getSession('sess-1');
      expect(record).toBeDefined();
      record!.callListener?.({
        id: 1, toolId: 'query_story', arguments: { q: 'x' }, ok: true, output: '结果', metadata: { m: 1 },
        gate: 'face', at: Date.now(),
      });
      return {
        text: '终文', usage: undefined, presentResultCalled: false, presentResultAwaiting: undefined,
        sentBack: false, secondPassMissedPresentResult: false, mcpSoftDenied: false, bridgeToolCalls: 1,
        toolSteps: [],
      };
    });
    const toolCalls: unknown[] = [];
    const turn = createAgyBridgeTurnProduction(deps);
    const outcome = await turn(makeRequest({ onToolCall: (c) => toolCalls.push(c) }));

    expect(outcome.text).toBe('终文');
    expect(wasAgyBridgeUsed()).toBe(true);
    expect(runAgyBridgeTurn).toHaveBeenCalledTimes(1);
    // 协议层入参：cliExecutable 来自 resolveModel；sessionKey/face 原样透传。
    expect(seenCalls[0]).toMatchObject({
      cliExecutable: 'C:/agy/bin/agy.exe',
      keyId: 'key-cli',
      sessionKey: 'dialogue:s1',
    });
    // live 监听直达（executor 即刻持久化素材）——CR-17 锚：gate 标记经 shell
    // BridgeCallRecord → callListener → agent BridgeToolCallRecord 结构缝完整透传
    //（三道闸拦截可观测，非死字段）。
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolId: 'query_story', ok: true, gate: 'face' });
    // turn 结束后监听清除（后续管道帧不再回调——listener/owner 字段复位）。
    expect(registry.getSession('sess-1')!.callListener).toBeUndefined();
    expect(registry.getSession('sess-1')!.callOwner).toBeUndefined();
    registry.disposeAll();
  });

  it('并发桥 turn 同 sessionId（CR-9）：owner token 守卫——先退 turn 不清后到 turn 的 live 监听', async () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const outcomeOf = (text: string) => ({
      text, usage: undefined, presentResultCalled: false, presentResultAwaiting: undefined,
      sentBack: false, secondPassMissedPresentResult: false, mcpSoftDenied: false, bridgeToolCalls: 0,
      toolSteps: [],
    });
    vi.mocked(runAgyBridgeTurn)
      .mockImplementationOnce(async () => outcomeOf('A')) // A 先完成
      .mockImplementationOnce(async () => {
        await gateB; // B 在途挂起（并发形态）
        return outcomeOf('B');
      });
    const turn = createAgyBridgeTurnProduction(deps);
    const callsA: unknown[] = [];
    const callsB: unknown[] = [];
    const doneA = turn(makeRequest({ onToolCall: (c) => callsA.push(c) }));
    const pendingB = turn(makeRequest({ onToolCall: (c) => callsB.push(c) }));
    // B 后到覆盖监听（last-writer-wins 单槽）——B 的 owner 持有。
    const listenerB = registry.getSession('sess-1')!.callListener;
    expect(listenerB).toBeDefined();
    await doneA; // A 先退：owner 比对不符（= B）→ **不清 B 的监听**（旧实现 finally 无主清理 = B 失联）。
    expect(registry.getSession('sess-1')!.callListener).toBe(listenerB);
    expect(registry.getSession('sess-1')!.callOwner).toBeDefined();
    releaseB();
    await pendingB; // B 退：清自己那份。
    expect(registry.getSession('sess-1')!.callListener).toBeUndefined();
    expect(registry.getSession('sess-1')!.callOwner).toBeUndefined();
    registry.disposeAll();
  });

  it('abort 族 → 注册表会话 revoke（管道关闭 + token 吊销）；非 abort 错误保留会话', async () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.mocked(runAgyBridgeTurn).mockRejectedValueOnce(abortError);
    await expect(createAgyBridgeTurnProduction(deps)(makeRequest())).rejects.toThrow(/aborted/);
    expect(registry.getSession('sess-1')).toBeUndefined(); // revoked

    vi.mocked(runAgyBridgeTurn).mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(createAgyBridgeTurnProduction(deps)(makeRequest())).rejects.toThrow(/quota/);
    // 运行失败保留会话（进程存活可复用——pool 侧语义）。
    expect(registry.getSession('sess-1')).toBeDefined();
    registry.disposeAll();
  });

  it('registry 未装配 → 响亮失败（startup wiring 漏装不静默）', async () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    deps.registry = () => undefined;
    await expect(createAgyBridgeTurnProduction(deps)(makeRequest())).rejects.toThrow(/installShellAgyBridgeCore/);
  });

  // ── R9 观测取景（三时机；真实现链上跑——记调用断取景，收集 sink 断行内容）──

  const okOutcome = (text = '终文') => ({
    text, usage: undefined, presentResultCalled: false, presentResultAwaiting: undefined,
    sentBack: false, secondPassMissedPresentResult: false, mcpSoftDenied: false, bridgeToolCalls: 0,
    toolSteps: [],
  });
  const writeLoadedLog = (root: string, sessionId: string): string => {
    const logDir = agyCliLogDirFor(root, sessionId);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      path.join(logDir, 'cli-20260919_191305.log'),
      [
        'I0919 19:13:05.112423       1 conversation_manager.go:451] Starting new conversation (agent=true)',
        'I0919 19:13:05.112423       1 server.go:1142] Creating new cascade trajectory (agentScript=true)',
      ].join('\n'),
      'utf8',
    );
    return logDir;
  };

  it('R9 取景①：桥会话开启恰读一次（同会话后续 turn 不重读；homeRoot 取自 deps）', async () => {
    const { deps, homeRoot } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    vi.mocked(runAgyBridgeTurn).mockImplementation(async () => okOutcome());
    const turn = createAgyBridgeTurnProduction(deps);
    await turn(makeRequest());
    await turn(makeRequest());
    expect(cliLogCount('session-open')).toBe(1);
    expect(cliLogCalls).toHaveBeenCalledWith({ homeRoot, sessionId: 'sess-1', reason: 'session-open' });
    registry.disposeAll();
  });

  it('R9 取景 homeRoot：deps 未注入 → 缺省 defaultAgyBridgeHomeRoot()（与生产装配同源）', async () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    delete deps.homeRoot;
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    vi.mocked(runAgyBridgeTurn).mockImplementation(async () => okOutcome());
    await createAgyBridgeTurnProduction(deps)(makeRequest());
    expect(cliLogCalls).toHaveBeenCalledWith({
      homeRoot: defaultAgyBridgeHomeRoot(),
      sessionId: 'sess-1',
      reason: 'session-open',
    });
    registry.disposeAll();
  });

  it('R9 取景②：空回合失败读一次；非空回合失败（abort/quota）不读，失败语义原样上抛', async () => {
    const { deps, homeRoot } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    vi.mocked(runAgyBridgeTurn).mockResolvedValueOnce(okOutcome());
    const turn = createAgyBridgeTurnProduction(deps);
    await turn(makeRequest()); // 首 turn 正常完成（取景① + ③）

    // 空回合失败族①：内置工具无头自动拒（真实分类产物 412）。
    vi.mocked(runAgyBridgeTurn).mockRejectedValueOnce(
      classifyCliError('', 'jetski: no output produced — the "read_file" permission that headless mode cannot prompt for'),
    );
    await expect(turn(makeRequest())).rejects.toThrow(/auto-denied/);
    expect(cliLogCount('empty-turn-failure')).toBe(1);
    expect(cliLogCalls).toHaveBeenCalledWith({ homeRoot, sessionId: 'sess-1', reason: 'empty-turn-failure' });

    // 空回合失败族②：空 SUCCESS 终态（协议层 EMPTY 原文）。
    vi.mocked(runAgyBridgeTurn).mockRejectedValueOnce(
      classifyCliError(
        'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
        '',
      ),
    );
    await expect(turn(makeRequest())).rejects.toThrow(/produced no response text/);
    expect(cliLogCount('empty-turn-failure')).toBe(2);

    // 非空回合失败（quota）不读——取景只对齐空回合。
    vi.mocked(runAgyBridgeTurn).mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(turn(makeRequest())).rejects.toThrow(/quota/);
    expect(cliLogCount('empty-turn-failure')).toBe(2);
    registry.disposeAll();
  });

  it('R9 取景③：首个正常完成的 turn 恰读一次（info 级）；同会话后续 turn 不重读', async () => {
    const { deps, homeRoot } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    vi.mocked(runAgyBridgeTurn).mockImplementation(async () => okOutcome());
    const turn = createAgyBridgeTurnProduction(deps);
    await turn(makeRequest());
    await turn(makeRequest());
    await turn(makeRequest());
    expect(cliLogCount('first-turn-completed')).toBe(1);
    expect(cliLogCalls).toHaveBeenCalledWith({ homeRoot, sessionId: 'sess-1', reason: 'first-turn-completed' });
    // 健康会话专道走 info（警示面只留空回合失败）。
    expect(cliLogPayloads('first-turn-completed')).toHaveLength(1);
    expect(
      cliLogLines.warn.mock.calls.filter(([p]) => (p as { reason?: string }).reason === 'first-turn-completed'),
    ).toHaveLength(0);
    registry.disposeAll();
  });

  it('R9 取景③：首 turn 失败不记账——首个「正常完成」的 turn 才读', async () => {
    const { deps } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    vi.mocked(runAgyBridgeTurn).mockRejectedValueOnce(new Error('quota exceeded'));
    const turn = createAgyBridgeTurnProduction(deps);
    await expect(turn(makeRequest())).rejects.toThrow(/quota/);
    expect(cliLogCount('first-turn-completed')).toBe(0);
    vi.mocked(runAgyBridgeTurn).mockResolvedValueOnce(okOutcome());
    await turn(makeRequest());
    expect(cliLogCount('first-turn-completed')).toBe(1);
    registry.disposeAll();
  });

  it('R9 取景③：日志缺失 / 格式漂移 → 仍落行且 agentState=unknown，turn 正常返回不受影响', async () => {
    const { deps, homeRoot } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    vi.mocked(runAgyBridgeTurn).mockImplementation(async () => okOutcome('救回正文'));
    const turn = createAgyBridgeTurnProduction(deps);

    // ① 日志缺失（假宿内空无一物）——仍落行，unknown。
    const first = await turn(makeRequest());
    expect(first.text).toBe('救回正文');
    expect(cliLogPayloads('first-turn-completed')[0]).toMatchObject({
      sessionId: 'sess-1',
      agentState: 'unknown',
      logDir: agyCliLogDirFor(homeRoot, 'sess-1'),
    });

    // ② 格式漂移（认不出任何三态）——换会话验证（取景③ 每会话恰一次）。
    const logDir = agyCliLogDirFor(homeRoot, 'sess-2');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, 'cli-20260919_191305.log'), 'unrelated line\nanother\n', 'utf8');
    const second = await turn(makeRequest({ sessionId: 'sess-2' }));
    expect(second.text).toBe('救回正文');
    expect(cliLogPayloads('first-turn-completed').at(-1)).toMatchObject({
      sessionId: 'sess-2',
      agentState: 'unknown',
      logFile: path.join(logDir, 'cli-20260919_191305.log'),
    });
    registry.disposeAll();
  });

  it('R9 取景③ 正例：假宿日志含 agent=true → 落行 agentState=agent-loaded（真定位 / 真归类在链上）', async () => {
    const { deps, homeRoot } = makeDeps({ resolved: CLI_RESOLVED, consent: 'allowed' });
    const registry = createAgyBridgeRegistry();
    deps.registry = () => registry;
    vi.mocked(runAgyBridgeTurn).mockImplementation(async () => okOutcome());
    const logDir = writeLoadedLog(homeRoot, 'sess-1');
    await createAgyBridgeTurnProduction(deps)(makeRequest());
    expect(cliLogPayloads('first-turn-completed')[0]).toMatchObject({
      sessionId: 'sess-1',
      agentState: 'agent-loaded',
      logDir,
    });
    registry.disposeAll();
  });
});

describe('IPC 三通道（registerAgyBridgeIpc）', () => {
  // register-once（模块 registered 守卫 mirror 生产 app 生命周期注册）——deps 经 holder
  // 逐用例换件（realHome/registry 走 getter 形态）。handle 的注册记录只在 beforeAll 留痕
  // 一次，**不 reset**（invoke 从注册调用记录取 handler）。
  const holder: {
    store: AgyBridgeConsentStore;
    realHome: string;
    registry: ReturnType<typeof createAgyBridgeRegistry> | undefined;
  } = {
    store: createAgyBridgeConsentStore({ filePath: path.join(os.tmpdir(), 'agy-bridge-ipc-once-consent.json') }),
    realHome: '',
    registry: undefined,
  };

  const invoke = <T>(channel: string, ...args: unknown[]): T => {
    const call = handle.mock.calls.find(([c]) => c === channel);
    if (call === undefined) throw new Error(`channel ${channel} not registered`);
    // handler 首参是 IpcMainInvokeEvent（约定不用）——invoke 传 undefined 占位。
    return (call[1] as (...a: unknown[]) => T)(undefined, ...args);
  };

  beforeAll(() => {
    registerAgyBridgeIpc({
      resolveModelRef: () => CLI_RESOLVED,
      registry: () => holder.registry,
      consentStore: () => holder.store,
      realHome: () => holder.realHome,
    });
  });

  beforeEach(() => {
    // 经 makeTempDir 登记（顶层 afterEach 统一清理）——本 describe 的 afterEach 只认
    // holder.store 当前值，而「存储错误」用例会把它换成 stub store ⇒ 原 consent 目录
    // 走占位清理会漏（历史泄漏：每跑一次留一个空目录）。
    holder.realHome = makeTempDir('agy-bridge-ipc-home-');
    holder.store = createAgyBridgeConsentStore({
      filePath: path.join(makeTempDir('agy-bridge-ipc-consent-'), 'consent.json'),
    });
    holder.registry = undefined;
  });

  afterEach(() => {
    holder.registry?.disposeAll();
    rmBestEffort(holder.realHome);
    rmBestEffort(path.dirname(holder.store.filePath()));
  });

  it('status：未同意 → missing-consent 态 + 路径字段', () => {
    const view = invoke<ReturnType<() => { state: string; homeRoot: string; consentFilePath: string }>>('agy-bridge:status');
    expect(view.state).toBe('missing-consent');
    expect(view.homeRoot).toContain('agy-bridge');
    expect(view.consentFilePath).toBe(holder.store.filePath());
  });

  it('consent：allowed 写入 + 回显视图；垃圾值 → operation-failed 不落盘', () => {
    const result = invoke<{ ok: boolean; view?: { state: string; consent: string } }>('agy-bridge:consent', { consent: 'allowed' });
    expect(result.ok).toBe(true);
    expect(result.view!.state).toBe('ok');
    expect(result.view!.consent).toBe('allowed');
    expect(holder.store.read()).toBe('allowed');

    const bad = invoke<{ ok: boolean; error?: string }>('agy-bridge:consent', { consent: 'hacked' });
    expect(bad).toEqual({ ok: false, error: 'operation-failed' });
    expect(holder.store.read()).toBe('allowed');
  });

  it('revoke：活动会话 → active-sessions 附 id（不翻转）；会话结束后 → ok + 翻转', () => {
    holder.store.set('allowed');
    holder.registry = createAgyBridgeRegistry();
    holder.registry.openSession({
      sessionId: 'live-1', projectDir: 'C:/p', permissionMode: 'suggest',
      face: [{ name: 'present_result', description: '', inputSchema: {} }],
    });
    const busy = invoke<{ ok: boolean; error?: string; activeSessions?: string[] }>('agy-bridge:revoke');
    expect(busy).toEqual({ ok: false, error: 'active-sessions', activeSessions: ['live-1'] });
    expect(holder.store.read()).toBe('allowed');

    holder.registry.revokeSession('live-1');
    const okResult = invoke<{ ok: boolean }>('agy-bridge:revoke');
    expect(okResult).toEqual({ ok: true });
    expect(holder.store.read()).toBeUndefined();
  });

  it('revoke：存储错误（CR-8）→ 独立 operation-failed 变体（不伪装 active-sessions 空列表）', () => {
    // stub store 的 filePath 指向独立 temp 目录（afterEach 按 dirname 清理——不得指宽路径）。
    const throwingDir = mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-ipc-throw-'));
    holder.store = {
      read: () => 'allowed' as const,
      set: () => {},
      clear: () => { throw new Error('EACCES: consent.json'); },
      filePath: () => path.join(throwingDir, 'consent.json'),
    };
    const result = invoke<{ ok: boolean; error?: string; activeSessions?: string[] }>('agy-bridge:revoke');
    expect(result).toEqual({ ok: false, error: 'operation-failed' });
    expect(result.activeSessions).toBeUndefined(); // 无会话 id 假载荷
  });
});

// 单源锚：server 名变更须同步 model-protocols BRIDGE_MCP_SERVER_NAME（预授权条目/冲突
// 检测/池面过滤全链单源）。
describe('fixture 自检', () => {
  it('server 名单源', () => {
    expect(BRIDGE_MCP_SERVER_NAME).toBe('novel-writing');
  });
});
