import { randomUUID } from 'node:crypto';
import { ipcMain, BrowserWindow } from 'electron';
import os from 'node:os';
import {
  AgyBridgeConsentRequiredError,
  type AgyBridgeModeDecision,
  type AgyBridgeModeResolver,
  type AgyBridgeTurnFn,
  type BridgeTurnOutcome,
  type BridgeTurnRequest,
  type ChainStreamEvent,
  type ChildStreamEvent,
  type WorkflowRuntime,
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
  type BridgeSessionRecord,
} from './agyBridge';
import {
  detectPreauthConflicts,
  readAgyBridgeStatusView,
  readAgySettingsFromDisk,
  resolveAgyBridgeConsentState,
  revokeAgyBridgeConsent,
  type AgyBridgeConsentStore,
} from './agyBridgeConsent';
import { isEmptyTurnFailure, observeAgyCliAgentState } from './agyCliLog';
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
//   - 观测（R9）：桥会话开启 + 本会话首个 turn 正常完成 + 桥 turn 以空回合失败，各读一次
//     agy CLI 日志并落一行（定位 / 三态判定在 `agyCliLog.ts`）——**观测面**，不参与业务
//     控制流（读不到 → unknown 静默）。
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
  /**
   * 假宿根（R9 观测面定位本会话 agy CLI 日志；缺省 `defaultAgyBridgeHomeRoot()`——与生产
   * 装配 `installShellAgyBridgeCore()` 的缺省同源）。getter 形态同 realHome。观测面专用：
   * 与 consent/管道/注册表零耦合。
   */
  homeRoot?: string | (() => string);
  /**
   * 09-20 F17 W0（桥车道工具对等 design §1.3）：本地执行缝 skillExecutor 取件——lazy 取
   * agent 库 runtime 单例。生产值由 agentIpc 装配点注入（`getAgentRuntime` 在 agentIpc 内，
   * 此处静态 import 会成 agyBridgeIpc → agentIpc 环——agentIpc → agyBridgeIpc 既有边，
   * mirror deps.registry() 注入缝形态避环）。缺席 → 本地工具 ctx 省略 skillExecutor
   * （工具 graceful 降级 "no runtime bound"，同 HTTP 车道 mock 语义）。测试注入 stub。
   */
  agentRuntime?: () => WorkflowRuntime;
  /**
   * 09-20 F17 W3（design §3）：chain/child 事件发送器的 webContents 句柄——发送器随
   * `attachBridgeRecordEventSenders` 挂到桥会话记录，广播 `agent:stream-event`（mirror
   * closureChainIpc makeChainEventSender 的窗口获取形态：懒解析，窗口重建由 getWin 兜底）。
   * 生产值由 agentIpc 装配点注入（registerAgentIpc 的 getWin 参数）；缺席 → 发送器不挂
   * （工具 ctx 省略事件通道，行为同现状）。测试注入 stub。
   */
  getWin?: () => BrowserWindow | null | undefined;
}

function depsRealHome(deps: AgyBridgeProductionDeps): string {
  const v = deps.realHome;
  if (typeof v === 'function') return v();
  return v ?? os.homedir();
}

function depsHomeRoot(deps: AgyBridgeProductionDeps): string {
  const v = deps.homeRoot;
  if (typeof v === 'function') return v();
  return v ?? defaultAgyBridgeHomeRoot();
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

/**
 * R9 取景③ 记账：本会话首个**正常完成**的 turn 已读过日志（**每会话恰一次**）。以会话记录
 * 对象身份为键（WeakSet）——记录被 revoke 出表即随之失效（重建会话重新观测），随记录一起
 * 回收（零无界增长），且零新增字段 / 零会话生命周期改动。「判读 + 置位」同步无 await：
 * 同会话并发 turn（CR-9 形态）也恰好观测一次。
 */
const firstTurnObserved = new WeakSet<BridgeSessionRecord>();

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

// ── 09-20 F17 W3（design §3/§4-2）：桥会话记录的事件发送器 + 本地执行缝 runtime 注入 ──

/**
 * 把 chain/child 事件发送器与 skillExecutor 取件缝挂到桥会话记录上。装配落位说明
 * （design §3「record 装配时注入——按 deps 缝就近落位」）：桥 turn 执行器（本文件
 * createAgyBridgeTurnProduction）是 deps 与记录相遇的唯一缝——workflow 桥分支经
 * runBridgeExecutor → 注入的 turn fn 走到这里，BridgeTurnRequest 无事件字段（协议层
 * 契约），记录装配是认可落位。
 *
 * 发送器语义（mirror closureChainIpc makeChainEventSender + agentIpc sendEvent）：
 *   - touch 桥会话 idle 续活（design §4-2）——链内事件不经管道，发送器内 touch 是
 *     「30min 帧口径 idle 清扫误杀在途链」的第二道保险（第一道 = 本地工具执行起止 touch）；
 *   - getWin 广播 `agent:stream-event`，载荷 {...event, sessionId, projectPath}——与
 *     agent 车道同通道同载荷（workflow emitChainEvent → agentIpc sendEvent），写章链
 *     进度/产物/节点卡按 record.sessionId 进 UI 时间线（键位与 HTTP 车道同），dispatch_* /
 *     spawn_agent 的子 agent 组经 emitChildEvent 可见（dogfood R2 #3 同型缺口）。
 * getWin 缺席 → 发送器置 undefined（工具 ctx 省略事件通道，优雅零事件——mirror
 * makeChainEventSender 的 getWin 缺省返 undefined 形态）；agentRuntime 与窗口无关，
 * 独立注入。
 */
export function attachBridgeRecordEventSenders(
  record: BridgeSessionRecord,
  deps: AgyBridgeProductionDeps,
): void {
  const getWin = deps.getWin;
  const send = (event: ChainStreamEvent | ChildStreamEvent): void => {
    record.lastActivityAt = Date.now(); // idle 续活（design §4-2）
    if (getWin === undefined) return;
    try {
      getWin()?.webContents.send('agent:stream-event', {
        ...event,
        sessionId: record.sessionId,
        projectPath: record.projectDir,
      });
    } catch {
      // Window may have been closed（mirror agentIpc sendEvent / makeChainEventSender 守卫）
    }
  };
  record.emitChainEvent = getWin !== undefined ? send : undefined;
  record.emitChildEvent = getWin !== undefined ? send : undefined;
  record.agentRuntime = deps.agentRuntime;
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
    const openedNow = registry.getSession(request.sessionId) === undefined;
    registry.openSession({
      sessionId: request.sessionId,
      projectDir: request.projectDir,
      permissionMode: request.permissionMode,
      face: request.face,
    });
    if (openedNow) {
      // R9 取景时机①：桥会话开启各读一次 agy CLI 日志并落一行（agent 三态 + 日志路径）。
      // 此刻 agy 进程通常尚未 spawn（假宿随 spawn 才建）⇒ 本行多为 unknown + 落点路径，
      // 作用是留「本会话日志在哪」；真态读取由时机③（首个 turn 正常完成）/ ②（空回合失败）
      // 承担。观测面：读不到静默降级 unknown，绝不参与控制流（纪律见 agyCliLog 文件头）。
      observeAgyCliAgentState({
        homeRoot: depsHomeRoot(deps),
        sessionId: request.sessionId,
        reason: 'session-open',
      });
    }
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
    // 09-20 F17 W3（design §3）：chain/child 事件发送器 + 本地执行缝 runtime 挂记录——
    // 每次 turn 重挂（幂等；deps getter 形态保持最新），本地工具（write_chapter 整链 /
    // dispatch_* 子代理）在 turn 内经管道 call 帧执行时从记录取事件通道与 runtime。
    if (record !== undefined) {
      attachBridgeRecordEventSenders(record, deps);
    }
    try {
      if (record !== undefined && listener !== undefined) {
        record.callOwner = callOwner;
        record.callListener = listener;
      }
      const outcome = await runAgyBridgeTurn({
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
      if (record !== undefined && !firstTurnObserved.has(record)) {
        // R9 取景时机③：本会话首个**正常完成**的 turn 读一次（info 级）——健康会话里也拿得到
        // agent 三态（时机① 只留落点、时机② 只在故障时走）。恰一次：先置位后观测（本会话
        // 后续 turn 与并发 turn 均不重读）。读不到一律 unknown 静默降级，绝不影响本 turn
        // 的正常返回。record 缺席（注册表竞态）＝本 turn 不观测，下个 turn 补上（至多一次）。
        firstTurnObserved.add(record);
        observeAgyCliAgentState({
          homeRoot: depsHomeRoot(deps),
          sessionId: request.sessionId,
          reason: 'first-turn-completed',
        });
      }
      return outcome;
    } catch (err) {
      // design §3.3：桥会话销毁（abort/作废）→ 断连 + 吊销 token + 关管道。运行失败
      //（quota 族）保留会话（进程存活可复用——pool 侧语义）。
      if (isAbortLikeError(err) || request.signal?.aborted === true) {
        registry.revokeSession(request.sessionId);
      }
      if (isEmptyTurnFailure(err)) {
        // R9 取景时机②：桥 turn 以空回合失败 → 读一次日志并落一行（判 agent 三态 + 路径；
        // 空回合族 = 内置工具无头自动拒 412 / 空 SUCCESS 终态）。只读不判——失败语义原样
        // 上抛（不吞不换不延迟）。
        observeAgyCliAgentState({
          homeRoot: depsHomeRoot(deps),
          sessionId: request.sessionId,
          reason: 'empty-turn-failure',
        });
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
