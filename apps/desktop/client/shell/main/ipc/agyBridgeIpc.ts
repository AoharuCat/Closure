import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import os from 'node:os';
import {
  AgyBridgeConsentRequiredError,
  type AgyBridgeModeDecision,
  type AgyBridgeModeResolver,
  type AgyBridgeTurnFn,
  type BridgeTurnOutcome,
  type BridgeTurnRequest,
} from '@orison/desktop-agent';
import { runAgyBridgeTurn, BRIDGE_MCP_SERVER_NAME } from '@orison/model-protocols';
import type {
  AgyBridgeConsentResult,
  AgyBridgeConsentState,
  AgyBridgeConsentValue,
  AgyBridgeRevokeResult,
  AgyBridgeStatusView,
  ModelRef,
  ResolvedModel,
} from '@orison/shared-contracts';
import { resolveModel } from './modelGatewayIpc';
import {
  defaultAgyBridgeHomeRoot,
  getProductionAgyBridgeConsentStore,
  getProductionAgyBridgeRegistry,
  type AgyBridgeRegistry,
} from './agyBridge';
import {
  detectPreauthConflicts,
  readAgyBridgeStatusView,
  readAgySettingsFromDisk,
  resolveAgyBridgeConsentState,
  revokeAgyBridgeConsent,
  type AgyBridgeConsentStore,
} from './agyBridgeConsent';
import { getLogger } from '../logger';

// ── agy MCP 工具桥 IPC + 车道生产实现（子4 W4）──
//
// 本文件 owns：
//   - `resolveAgyBridgeLaneModeProduction`：agent 注入的模式判定实现（design §5.1——
//     protocol ≠ cli → off；declined → off（AC6 降级）；missing-consent/conflict → 类型化
//     征询；ok → bridge）。每次现读（同意态与用户手改 settings 即时反映——design §10）。
//   - `runAgyBridgeTurnProduction`：agent 注入的桥 turn 执行实现——**consent 硬门（CR-27）
//     先于一切**：非 ok 即类型化拒绝（declined/conflict/missing-consent 三态——declined 的
//     用户选择不得被任何入口绕过，lane resolver 只是第一道，seam 直调也拦）；模型解析 →
//     注册表幂等预开 + 调用记录 live 监听（executor 即刻持久化工具对）→ runAgyBridgeTurn；
//     abort 族 → revoke 注册表会话（管道关闭 + token 吊销——design §3.3 桥会话销毁）。
//   - `registerAgyBridgeIpc`：同意/状态/关闭回收三通道（四处同步：ipc.ts enum + 接口 +
//     preload + 本 handler + securitySurface 白名单 + registerAllIpc 行）。
//   - `wasAgyBridgeUsed`：will-quit 有界等待判据（mirror wasAntigravityCliUsed——CR-15）。
//
// 测试缝：deps（resolveModelRef / registry / consentStore / realHome）全注入——单测零真
// agy / 零真实 ~/.gemini 写（readAgySettingsFromDisk 只读）。

const logger = getLogger();

export interface AgyBridgeProductionDeps {
  resolveModelRef: (ref: ModelRef) => ResolvedModel;
  registry: () => AgyBridgeRegistry | undefined;
  consentStore: () => AgyBridgeConsentStore;
  /**
   * 真实用户 home（settings 只读源；测试传 temp 根）。getter 形态供 register-once 场景
   * （IPC 注册是 app 生命周期一次，闭包捕获的测试 holder 需逐用例换根）。
   */
  realHome?: string | (() => string);
}

function depsRealHome(deps: AgyBridgeProductionDeps): string {
  const v = deps.realHome;
  if (typeof v === 'function') return v();
  return v ?? os.homedir();
}

/** 生产 deps（modelGatewayIpc resolveModel + agyBridge 单例；测试注入替身）。 */
export function agyBridgeProductionDeps(overrides: Partial<AgyBridgeProductionDeps> = {}): AgyBridgeProductionDeps {
  return {
    resolveModelRef: resolveModel,
    registry: getProductionAgyBridgeRegistry,
    consentStore: getProductionAgyBridgeConsentStore,
    ...overrides,
  };
}

// ── 同意门（lane resolver 与 turn 硬门共读；每次现读不信缓存）──

interface ConsentGate {
  state: AgyBridgeConsentState;
  conflicts: string[];
}

function readConsentGate(deps: AgyBridgeProductionDeps): ConsentGate {
  const consent = deps.consentStore().read();
  const parsed = readAgySettingsFromDisk(depsRealHome(deps));
  const settings = parsed.ok ? parsed.value : undefined;
  return {
    state: resolveAgyBridgeConsentState({
      consent,
      settings,
      serverName: BRIDGE_MCP_SERVER_NAME,
    }),
    conflicts: settings !== undefined ? detectPreauthConflicts(settings, BRIDGE_MCP_SERVER_NAME) : [],
  };
}

/** 模式判定生产实现（agentIpc setAgyBridgeModeResolver 注入）。 */
export function createAgyBridgeLaneModeResolver(deps: AgyBridgeProductionDeps): AgyBridgeModeResolver {
  return (input): AgyBridgeModeDecision => {
    let resolved: ResolvedModel | undefined;
    try {
      resolved = deps.resolveModelRef(input.modelRef);
    } catch (err) {
      // 模型解析失败（未配置/病态 sidecar）：按 not-cli 降级——HTTP 车道本就各自解析失败，
      // 桥判定不放大错误面（真 CLI 模型解析失败会在 turn 入口响亮报）。
      logger.info(
        { err: err instanceof Error ? err.message : String(err) },
        'agy-bridge lane mode: model resolve failed — treating as off',
      );
      return { mode: 'off', reason: 'not-cli' };
    }
    if (resolved?.protocol !== 'antigravity-cli') {
      return { mode: 'off', reason: 'not-cli' };
    }
    const gate = readConsentGate(deps);
    if (gate.state === 'declined') {
      // AC6：declined = 用户选择——降级纯文本（会话不中断），绝不静默重启征询。
      return { mode: 'off', reason: 'declined' };
    }
    if (gate.state === 'conflict') {
      return { mode: 'rejected', state: 'conflict', conflicts: gate.conflicts };
    }
    if (gate.state === 'missing-consent') {
      return { mode: 'rejected', state: 'missing-consent', conflicts: [] };
    }
    return { mode: 'bridge' };
  };
}

// ── 桥 turn 生产实现（agentIpc setBridgeTurnFn 注入）──

let bridgeUsed = false;

/** will-quit 有界等待判据（本会话起过桥 turn 即 true——mirror wasAntigravityCliUsed）。 */
export function wasAgyBridgeUsed(): boolean {
  return bridgeUsed;
}

/** 测试复位。 */
export function __resetAgyBridgeUsedForTest(): void {
  bridgeUsed = false;
}

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * 桥 turn 执行生产实现。consent 硬门（CR-27）三态全拦——lane resolver 的 declined 降级
 * 只是第一道；直接调 seam（未来其他调用方）也拦在门口，declined 用户选择零绕过面。
 */
export function createAgyBridgeTurnProduction(deps: AgyBridgeProductionDeps): AgyBridgeTurnFn {
  return async (request: BridgeTurnRequest): Promise<BridgeTurnOutcome> => {
    const gate = readConsentGate(deps);
    if (gate.state !== 'ok') {
      throw new AgyBridgeConsentRequiredError(gate.state, gate.conflicts);
    }
    const resolved = deps.resolveModelRef(request.modelRef);
    if (resolved.protocol !== 'antigravity-cli' || resolved.cliExecutable === undefined) {
      throw new Error(
        `agy bridge turn requested for non-CLI model ${request.modelRef.keyId}/${request.modelRef.modelId}`,
      );
    }
    const registry = deps.registry();
    if (registry === undefined) {
      throw new Error('agy bridge runtime not installed — shell must call installShellAgyBridgeCore at startup');
    }
    bridgeUsed = true;

    // 幂等预开（同输入直接复用管道/token；配置变更 CR-6 语义在 openSession 内）——为
    // live 监听取记录引用。runAgyBridgeTurn 内部的 openBridgeSession 同输入幂等命中。
    registry.openSession({
      sessionId: request.sessionId,
      projectDir: request.projectDir,
      permissionMode: request.permissionMode,
      face: request.face,
    });
    const record = registry.getSession(request.sessionId);
    const listener = request.onToolCall;
    // CR-19（子4 CR 批）：getSession 落空（注册表在 open 与 get 之间被 revoke 的竞态窗口）
    // 不再静默降级——warn 留 trace（live 工具对持久化缺席 = UI 中途工具卡缺失面）。
    if (record === undefined) {
      logger.warn(
        { component: 'agy-bridge', sessionId: request.sessionId },
        'agy-bridge: session record missing right after open — live tool-call persistence disabled for this turn',
      );
    }
    // CR-9（子4 CR 批）：owner token 守卫——并发桥 turn 同 sessionId 时 callListener 是
    // last-writer-wins 单槽，无主互斥则先退 turn 的 finally 会清掉后到 turn 的监听。
    // 每次 turn 持唯一 token；finally 只清理自己那份（owner 比对后清理）。
    const callOwner = randomUUID();
    try {
      if (record !== undefined && listener !== undefined) {
        record.callOwner = callOwner;
        record.callListener = listener;
      }
      return await runAgyBridgeTurn({
        cliExecutable: resolved.cliExecutable,
        keyId: request.modelRef.keyId,
        modelId: request.modelRef.modelId,
        thinking: request.thinking,
        system: request.system,
        messages: request.messages,
        sessionKey: request.sessionKey,
        sessionId: request.sessionId,
        projectDir: request.projectDir,
        permissionMode: request.permissionMode,
        face: request.face,
        requirePresentResult: request.requirePresentResult,
        onDelta: request.onDelta,
        onPhase: request.onPhase,
        signal: request.signal,
      });
    } catch (err) {
      // design §3.3：桥会话销毁（abort/作废）→ 断连 + 吊销 token + 关管道。运行失败
      //（quota 族）保留会话（进程存活可复用——pool 侧语义）。
      if (isAbortLikeError(err) || request.signal?.aborted === true) {
        registry.revokeSession(request.sessionId);
      }
      throw err;
    } finally {
      if (record !== undefined && record.callOwner === callOwner) {
        record.callListener = undefined;
        record.callOwner = undefined;
      }
    }
  };
}

// ── IPC 三通道（registerAllIpc 恰一次；machine 级读写，无窗口面无 pathGuard 面）──

function buildStatusView(deps: AgyBridgeProductionDeps): AgyBridgeStatusView {
  const store = deps.consentStore();
  const parsed = readAgySettingsFromDisk(depsRealHome(deps));
  return readAgyBridgeStatusView({
    consent: store.read(),
    settings: parsed.ok ? parsed.value : undefined,
    serverName: BRIDGE_MCP_SERVER_NAME,
    // 假宿根展示（design §8：设置页展示假宿根目录路径）——单源 defaultAgyBridgeHomeRoot。
    homeRoot: defaultAgyBridgeHomeRoot(),
    consentFilePath: store.filePath(),
  });
}

let registered = false;

export function registerAgyBridgeIpc(deps: AgyBridgeProductionDeps = agyBridgeProductionDeps()): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('agy-bridge:status', (): AgyBridgeStatusView => buildStatusView(deps));

  ipcMain.handle('agy-bridge:consent', (_event, input: { consent: AgyBridgeConsentValue }): AgyBridgeConsentResult => {
    if (input?.consent !== 'allowed' && input?.consent !== 'declined') {
      // IPC 边界校验（TS 注解运行时擦除——垃圾值不落盘）。
      return { ok: false, error: 'operation-failed' };
    }
    try {
      deps.consentStore().set(input.consent);
      return { ok: true, view: buildStatusView(deps) };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agy-bridge:consent write failed (consent store error)',
      );
      return { ok: false, error: 'operation-failed' };
    }
  });

  ipcMain.handle('agy-bridge:revoke', (): AgyBridgeRevokeResult => {
    try {
      return revokeAgyBridgeConsent({
        store: deps.consentStore(),
        activeSessionIds: () => (deps.registry()?.activeSessions() ?? []).map((r) => r.sessionId),
      });
    } catch (err) {
      // CR-8（子4 CR 批）：存储错误（consent 文件读写炸）≠ 活动会话占用——返回独立
      // 'operation-failed' 变体（原文已在上方 warn 留痕），不得伪装 'active-sessions'
      // 空列表误导用户去结束不存在的会话。
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agy-bridge:revoke failed (consent store error)',
      );
      return { ok: false, error: 'operation-failed' };
    }
  });
}
