import { describe, expect, it, vi, beforeAll } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

const { handle, warn, info, resolveModel, abortBridgeSessionMock, abortRunMock, turnProductionDepsSpy } = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  resolveModel: vi.fn(),
  abortBridgeSessionMock: vi.fn(),
  abortRunMock: vi.fn(async () => true),
  turnProductionDepsSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

// 09-20 F17 W3（design §4-1）：abort-run 联动桥会话的接线钉死——abortBridgeSession 换 spy
//（真实现单测在 agyBridge.test.ts；此处只钉 agentIpc handler 的调用接线），其余导出保持
// 真身（agyBridgeIpc 链上消费 defaultAgyBridgeHomeRoot / getProductionAgyBridgeRegistry 等）。
vi.mock('../main/ipc/agyBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/agyBridge')>();
  return { ...actual, abortBridgeSession: abortBridgeSessionMock };
});

// CR-20（子4 CR 批）：resolveModel 显式钉死——不 mock 时断言走真实机器配置
//（readModelConfigFromDisk 读盘 + default key auto-pick），CI 机器的默认 key 恰为 CLI
// 形态时会真验 ~/.gemini 且断言翻红。此处注入确定性替身（已知非 CLI key / 已知抛错），
// 断言零机器态依赖；其余导出保持真身（agentIpc 的 generateText 分派面不在本测试作用面）。
vi.mock('../main/ipc/modelGatewayIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/modelGatewayIpc')>();
  return {
    ...actual,
    resolveModel: resolveModel as typeof actual.resolveModel,
  };
});

// Partial mock of the agent package: seam functions + 探针 stay REAL so the wiring
// under test is exercised against the module state the runtime actually reads.
// Only the heavyweight runtime factory is stubbed (mirror agentIpcTaskSlotWiring
// 先例——同形态并行文件，避免占用该在途文件)。
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return {
    ...actual,
    // abortRun：agent:abort-run handler 调用（F17 W3 联动测试需要可调用/可断言）。
    createWorkflowRuntime: vi.fn(() => ({ __stub: 'agentIpcAgyBridgeWiring', abortRun: abortRunMock })),
  };
});

vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));

// 09-20 F17 W0/W3（implement 遗留 b 项裁决）：agentIpc 装配点的 agentRuntime/getWin 注入
// 线钉测——createAgyBridgeTurnProduction 换透传 spy 包装（真实现原样转发，resolver 行为
// 断言不受影响），捕获 registerAgentIpc 传入的 deps。**turn fn 从不被调用**——零 consent
// store / 零 ~/.gemini 读盘（implement 期未钉测的顾虑即在此，本形态绕开）。
vi.mock('../main/ipc/agyBridgeIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/agyBridgeIpc')>();
  return {
    ...actual,
    createAgyBridgeTurnProduction: (deps: Parameters<typeof actual.createAgyBridgeTurnProduction>[0]) => {
      turnProductionDepsSpy(deps);
      return actual.createAgyBridgeTurnProduction(deps);
    },
  };
});

import { __getAgyBridgeModeResolverForTest, __getAgyBridgeTurnFnForTest } from '@orison/desktop-agent';
import { registerAgentIpc } from '../main/ipc/agentIpc';

// ── 子4 W4：agentIpc 桥 seam 注入接线钉死 ──
//
// agentIpc 的 `setAgyBridgeModeResolver(...)` / `setBridgeTurnFn(...)` 两行 wiring 若被
// 删除，桥车道静默回 runLoop 纯文本路径（resolver 未装配 = off——fail-safe 方向）且零
// 测试红。本文件读 agent 包自身模块状态断言注入在位（mirror agentIpcTaskSlotWiring 的
// CR-001 姿态）：删除任一接线行 → 探针 undefined → 红。

/** 已知非 CLI 模型（确定性 fixture——协议分支唯一断言输入）。 */
const HTTP_RESOLVED: ResolvedModel = {
  keyId: 'key-http-wiring',
  modelId: 'gpt-x',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  capability: 'text',
};

describe('agentIpc agy-bridge seam wiring（子4 W4）', () => {
  beforeAll(() => {
    resolveModel.mockReset();
    registerAgentIpc(() => null);
  });

  it('两个 seam 均已注入（生产实现——函数形态）', () => {
    expect(typeof __getAgyBridgeModeResolverForTest()).toBe('function');
    expect(typeof __getAgyBridgeTurnFnForTest()).toBe('function');
  });

  it('注入的 resolver 是生产实现：resolveModel 抛错（未配置 key）→ off（确定性降级路径）', () => {
    resolveModel.mockImplementation(() => {
      throw new Error(`Model ref points to unknown key 'no-such-key-bridge-wiring'`);
    });
    const resolver = __getAgyBridgeModeResolverForTest();
    expect(resolver).toBeDefined();
    const decision = resolver!({ modelRef: { keyId: 'no-such-key-bridge-wiring', modelId: 'no-such-model' } });
    // 生产实现 catch 后按 not-cli 降级 off——mock 钉死抛错，零机器态依赖。
    expect(decision.mode).toBe('off');
  });

  it('注入的 resolver 是生产实现：已知非 CLI 模型 → off not-cli（不进同意门——零 ~/.gemini 读）', () => {
    resolveModel.mockImplementation(() => HTTP_RESOLVED);
    const resolver = __getAgyBridgeModeResolverForTest();
    const decision = resolver!({ modelRef: { keyId: 'key-http-wiring', modelId: 'gpt-x' } });
    expect(decision).toEqual({ mode: 'off', reason: 'not-cli' });
  });

  it('abort-run 联动桥会话（F17 W3 design §4-1）：handler 掐断在途桥会话（接线钉死——删联动行 → 红）', async () => {
    abortBridgeSessionMock.mockReset();
    abortBridgeSessionMock.mockReturnValueOnce(true);
    abortRunMock.mockClear();
    const abortRunCalls = handle.mock.calls.filter(([channel]) => channel === 'agent:abort-run') as unknown as Array<
      [string, (_event: unknown, sessionId: string) => Promise<boolean>]
    >;
    expect(abortRunCalls.length).toBeGreaterThan(0);
    const handler = abortRunCalls[0]![1];
    const result = await handler({}, 'sess-bridge-abort');
    // 桥会话 abort 先于 runtime.abortRun（在途本地工具执行即刻掐断，不等 runtime 轮询）。
    // CR-9（09-21 三层 CR）：次序断言钉死——此前只断言「都调过」，注释宣称的先序无守门。
    expect(abortBridgeSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      abortRunMock.mock.invocationCallOrder[0],
    );
    expect(abortBridgeSessionMock).toHaveBeenCalledWith('sess-bridge-abort');
    expect(abortRunMock).toHaveBeenCalledWith('sess-bridge-abort');
    expect(result).toBe(true);
  });

  it('F17 W0/W3 装配注入线：turn 生产 deps 携 agentRuntime（= runtime 单例 getter）+ getWin（= registerAgentIpc 入参）', () => {
    // 删 agentIpc 的 { agentRuntime: getAgentRuntime, getWin } 覆写 → 两者 undefined → 红。
    expect(turnProductionDepsSpy).toHaveBeenCalled();
    const deps = turnProductionDepsSpy.mock.calls.at(-1)![0] as {
      agentRuntime?: () => unknown;
      getWin?: () => unknown;
    };
    // agentRuntime getter 解析到本 mock 环境的 runtime 单例（createWorkflowRuntime stub）。
    expect(typeof deps.agentRuntime).toBe('function');
    expect(deps.agentRuntime?.()).toMatchObject({ __stub: 'agentIpcAgyBridgeWiring' });
    // getWin 即 registerAgentIpc(() => null) 的窗口句柄入参（懒解析形态）。
    expect(typeof deps.getWin).toBe('function');
    expect(deps.getWin?.()).toBeNull();
  });
});
