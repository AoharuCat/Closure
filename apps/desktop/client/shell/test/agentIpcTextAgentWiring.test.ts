import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';

const { handle, warn, info, notifyUI, getAllWindows } = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  notifyUI: vi.fn(),
  // CR-3：投递前提探测——事件面只在有窗时消费单次旗（零窗口 = toast 必失，旗留下次）。
  getAllWindows: vi.fn(() => [{}]),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  BrowserWindow: { getAllWindows },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

// toolNotify partial mock：真实 ToolEvent union 保留（类型面），notifyUI 换 spy——降级
// 事件面（W4）经 console.warn 拦截推 { type: 'cli:text-agent-fallback' }，断言推送载荷
// 与单次旗（toolNotify 自身零逻辑改动）。
vi.mock('../main/ipc/toolNotify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/toolNotify')>();
  return {
    ...actual,
    notifyUI,
  };
});

// readModelConfigFromDisk 钉死零 key 确定性替身——resolver 的 key 门先决，断言零机器态
// 依赖（真实机器有/无 agy CLI key、agent 文件是否在位都不影响本测试）。
vi.mock('../main/ipc/configIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/configIpc')>();
  return {
    ...actual,
    readModelConfigFromDisk: () => ({ keys: [] }) as ReturnType<typeof actual.readModelConfigFromDisk>,
  };
});

// Partial mock of the agent package: seam functions stay REAL; 只有重量级 runtime 工厂
// 被 stub（mirror agentIpcAgyBridgeWiring 先例——同形态并行文件，避免占用该在途文件）。
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return {
    ...actual,
    createWorkflowRuntime: vi.fn(() => ({ __stub: 'agentIpcTextAgentWiring' })),
  };
});

vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));

import { __getAntigravityCliTextAgentResolverForTest, createAntigravityCliDriver } from '@orison/model-protocols';
import {
  __isTextAgentDegradationFaceInstalledForTest,
  _resetTextAgentDegradationFaceForTest,
  installTextAgentDegradationEventFace,
  registerAgentIpc,
} from '../main/ipc/agentIpc';
import { cliTestModel, cliTestRequest, fakeDriverEnv } from './agyDriverHarness';

// ── 09-19 CLI 白名单 W3：agentIpc 文本 agent resolver 注入接线钉死 ──
//
// agentIpc 的 `setAntigravityCliTextAgentResolver(createTextAgentResolverProduction())`
// 一行 wiring 若被删除，纯文本 spawn 静默回无 agent 路径（行为等价旧状——γ 兜底恒在，
// 但注入缝失明）且零测试红。本文件经协议层自身探针断言注入在位（mirror
// agentIpcAgyBridgeWiring 的 CR-001 姿态）：删除接线行 → 探针 undefined → 红。

describe('agentIpc 文本 agent resolver 注入接线（09-19 白名单 W3）', () => {
  beforeAll(() => {
    registerAgentIpc(() => null);
  });

  it('resolver 已注入（生产实现——函数形态）', () => {
    expect(typeof __getAntigravityCliTextAgentResolverForTest()).toBe('function');
  });

  it('注入的 resolver 是生产实现：无 agy CLI key → undefined（确定性降级路径，零机器读）', () => {
    const resolver = __getAntigravityCliTextAgentResolverForTest();
    expect(resolver).toBeDefined();
    // key 门先决（readModelConfigFromDisk 已钉死零 key）→ undefined，不触 consent store
    // 与真实 home——CI/开发机两态断言一致。
    expect(resolver!()).toBeUndefined();
  });
});

// ── 09-19 CLI 白名单 W4：降级事件面接线钉死 ──
//
// agentIpc 的 `installTextAgentDegradationEventFace(notifyUI)` 装配行若被删除，driver
// 降级带 warn 恒只有 console.warn 落盘、renderer 永远看不到一次性 toast 且零测试红。
// 本 describe 断言：①安装探针 true（删装配行 → false → 红）；②签名 warn 命中 → 推
// `{ type: 'cli:text-agent-fallback' }` 恰一次（进程级单次旗）；③非签名 warn 原样放行
// 不触发。签名串 = driver.ts 降级带 warn 前缀 + 标记（「built-in tool step」语义——
// 归因 2026-09-19 F12 真机实证纠正；文案变更须同步，R10 升级回归项）。

const DEGRADED_WARN =
  "[antigravity-cli] text agent 'closure-text' lane produced a built-in tool step (a tool step is not evidence the agent failed to load — the declarative agent narrows, but does not zero, agy's built-in tool face) — retrying this turn without --agent (once); session stays on the no-agent lane key=k1 model=m1";

describe('agentIpc 文本 agent 降级事件面（09-19 白名单 W4）', () => {
  beforeAll(() => {
    registerAgentIpc(() => null);
  });

  beforeEach(() => {
    notifyUI.mockClear();
    _resetTextAgentDegradationFaceForTest();
    getAllWindows.mockReturnValue([{}]);
  });

  it('事件面已安装（装配行被删 = 探针 false → 红）', () => {
    expect(__isTextAgentDegradationFaceInstalledForTest()).toBe(true);
  });

  it('签名 warn → 推一次 cli:text-agent-fallback（进程级单次旗），原 warn 委托不丢', () => {
    const warnSpy = vi.spyOn(console, 'warn'); // passthrough 包裹已安装的拦截层
    console.warn(DEGRADED_WARN);
    expect(notifyUI).toHaveBeenCalledTimes(1);
    expect(notifyUI).toHaveBeenCalledWith({ type: 'cli:text-agent-fallback' });
    // 委托链完整：拦截层把原 warn 原样放行（console.warn 语义零变化）。
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // 多会话链连发（第二签名 warn）→ 单次旗收敛，不再推。
    console.warn(DEGRADED_WARN);
    expect(notifyUI).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('非签名 warn（默认 57 工具面合法行为等）原样放行不触发', () => {
    console.warn('unrelated warn from elsewhere');
    console.warn('[antigravity-cli] text agent loaded fine');
    expect(notifyUI).not.toHaveBeenCalled();
  });

  it('CR-3 零窗口不消费单次旗：warn 照常委托不推送；窗口就位后同签名 warn 照推一次', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    getAllWindows.mockReturnValue([]);
    console.warn(DEGRADED_WARN);
    expect(notifyUI).not.toHaveBeenCalled(); // 零窗口 = toast 必失——旗未耗
    expect(warnSpy).toHaveBeenCalledTimes(1); // 原 warn 委托不受影响
    getAllWindows.mockReturnValue([{}]);
    console.warn(DEGRADED_WARN);
    expect(notifyUI).toHaveBeenCalledTimes(1); // 旗留给下次——窗口出现即推
    warnSpy.mockRestore();
  });

  it('CR-3 幂等守卫：重复安装返回 no-op restore（console.warn 不堆叠 wrapper）', () => {
    const before = console.warn;
    const restore = installTextAgentDegradationEventFace(notifyUI);
    expect(console.warn).toBe(before); // 已在位——未再包一层
    restore();
    expect(console.warn).toBe(before); // no-op restore 不剥在位的单例 wrapper
    console.warn(DEGRADED_WARN);
    expect(notifyUI).toHaveBeenCalledTimes(1); // 单层 wrapper 语义不变
  });

  it('跨包交叉校验：真 driver 产出的降级 warn 命中拦截层（协议层文案漂移 = 红）', async () => {
    // 治前形态靠手抄 DEGRADED_WARN 样张自证：driver 改文案，样张照绿、toast 静默消失。
    // 这里跑真 driver（fake spawn 零真进程）+ 真 defaultAgyPoolDeps warn（→ 真 console.warn
    // → 本文件在位的拦截层）——前缀 / 标记两段必须与**真实降级文案**对齐。
    const env = fakeDriverEnv((proc) => {
      proc.responder = () => {
        if (proc.spawnArgs.args.includes('--agent')) {
          proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'grep_search' } });
          proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '首试正文' });
        } else {
          proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '降级正文' });
        }
      };
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, { resolveTextAgent: () => 'closure-text' });
    try {
      const result = await driver.generateText(cliTestModel(), cliTestRequest());
      expect(result.text).toBe('降级正文');
      expect(env.spawns[0]!.spawnArgs.args).toContain('--agent');
      expect(env.spawns[1]!.spawnArgs.args).not.toContain('--agent'); // 降级重跑换 spec
      expect(notifyUI).toHaveBeenCalledTimes(1);
      expect(notifyUI).toHaveBeenCalledWith({ type: 'cli:text-agent-fallback' });
    } finally {
      driver.dispose();
    }
  });
});
