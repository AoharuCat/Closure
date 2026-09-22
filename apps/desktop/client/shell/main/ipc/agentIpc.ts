import { ipcMain, BrowserWindow } from 'electron';
import {
  createWorkflowRuntime,
  setGenerateTextFn,
  setTaskSlotResolver,
  setContextPolicyProvider,
  setExecuteToolFn,
  registerBuiltinTools,
  listSkillPackages,
  setPackageEnabled,
  setSkillEnabled,
  updateSessionStatus,
  type WorkflowRuntime,
  type CreateSessionInput,
  type ExecuteSkillRequest,
  type GenerateTextFn,
  type GenerateTextRequest,
  type ExecuteToolFn,
  assignmentContextWindowTokens,
  setBridgeTurnFn,
  setAgyBridgeModeResolver,
  // 09-21-subagent-bg-decouple W3：后台任务注册表消费面（启动对账 + bg 车道帽常量对齐）——
  // mirror deriveCheckpointPolicy 的 shell→agent 导出姿态（能力面单源在 agent 包，shell 只挂接）。
  getBgTaskRegistry,
  MAX_BG_PER_PROJECT,
} from '@orison/desktop-agent';
// 子4 W4（09-12 agy MCP 工具桥）：dialogue 桥车道生产实现（consent 硬门 + 模型解析 +
// 注册表 live 监听）——本文件只做注入接线（mirror setGenerateTextFn 装配形态）。
import { agyBridgeProductionDeps, createAgyBridgeLaneModeResolver, createAgyBridgeTurnProduction } from './agyBridgeIpc';
// 09-20 F17 W3（design §4-1）：abort-run 联动——UI 停止钮同时掐桥会话的在途本地工具执行
// （write_chapter 整链持有 record.abortController.signal）。agyBridge 不反向 import 本文件
//（无环），abortBridgeSession 读桥生产注册表单例。
import { abortBridgeSession } from './agyBridge';
// 09-19 CLI 白名单（W3）：纯文本车道零工具 agent 解析器生产实现 + 协议层注入缝。
import { createTextAgentResolverProduction } from './agyTextAgentIpc';
import { setAntigravityCliTextAgentResolver } from '@orison/model-protocols';
import { enrichSlotAssignment, handleGenerateText, handleGenerateTextStream, resolveModel } from './modelGatewayIpc';
import { installAgentImagePartsCore } from './agentImageParts';
import { prepareVisionImage } from '../research/visionAnalysis';
import { readModelConfigFromDisk, readTaskModelSlots, readUserPreferencesFromDisk } from './configIpc';
import { handleToolExecute } from './toolExecution';
import { normalizeProjectKey } from './pathGuard';
import { getLogger } from '../logger';
import { notifyUI, type ToolEvent } from './toolNotify';
import {
  generateTextPayloadSchema,
  type GenerateTextPayload,
} from '@orison/shared-contracts';

const logger = getLogger();

// ── 09-19 CLI 白名单（W4）：文本 Agent 降级带 warn → 事件面上浮（一次性 toast）──
//
// 协议层 driver.ts 零改动：生产 deps.warn = console.warn（driver.ts defaultAgyPoolDeps
// 的箭头函数每次调用现取 console.warn），此处包装 console.warn 拦截降级带签名串后委托
// 原实现。签名串 = 协议层降级带 warn 的前缀 + 标记（driver.ts W3；归因 2026-09-19 F12
// 真机实证纠正——工具 step 不等于 agent 未加载，见 driver.ts 降级带注）——
// **跨包文案耦合（shell → 协议层单向，常量不可共享）：由交叉校验测试守门**——
// agentIpcTextAgentWiring.test.ts 跑真 driver 产出真实降级 warn（真 defaultAgyPoolDeps
// warn → 真 console.warn），断言本拦截层命中；driver 文案变更而此处不同步 = 该测试红，
// 不是 toast 静默消失。升级回归清单项（docs/antigravity-cli-upgrade-regression.md §3）。
// 防骚扰收敛在 shell 单点（mirror cli:auth-dead「只弹转变」）：降级带按会话首 turn 各
// 触发一次，多会话链（蒸馏/拆书逐章）会连发——进程级只推一次，renderer 只弹不二次去重。
const TEXT_AGENT_DEGRADED_WARN_PREFIX = '[antigravity-cli] text agent ';
const TEXT_AGENT_DEGRADED_WARN_MARKER = 'built-in tool step';
let textAgentDegradationNotified = false;
let textAgentDegradationFaceInstalled = false;

/**
 * 降级 toast 的投递前提探测（CR-3）：零 BrowserWindow（冷启动后台蒸馏先于首窗）时投递
 * 必然丢失——此时**不消费**进程单次旗（旗留给首个窗口出现后的下次触发）。探测本身失败
 * （electron mock / 环境异常）按「有窗」处理——事件面 best-effort，绝不阻断原 warn。
 */
function hasWindowTargetForTextAgentToast(): boolean {
  try {
    return BrowserWindow.getAllWindows().length > 0;
  } catch {
    return true;
  }
}

/**
 * 安装文本 Agent 降级事件面（registerAgentIpc 装配恰一次）。返回还原函数（测试用；
 * 生产忽略）。通知面失败不阻断原 warn（best-effort 事件面——降级已自愈，toast 只是
 * 知情面）。CR-3 幂等守卫：已安装状态下重复安装直接返回 no-op restore——防 registerAgentIpc
 * 双跑 / 多装配点把 console.warn wrapper 层层堆叠（每层都拦一遍 + restore 只剥顶层）。
 */
export function installTextAgentDegradationEventFace(
  notify: (event: ToolEvent) => void,
): () => void {
  if (textAgentDegradationFaceInstalled) {
    return () => {}; // 幂等：单例 wrapper 已在位，不再堆叠（restore 也无从还原——没动过）
  }
  const originalWarn = console.warn.bind(console);
  const patchedWarn = (...args: unknown[]) => {
    try {
      const first = args[0];
      if (
        !textAgentDegradationNotified
        && hasWindowTargetForTextAgentToast()
        && typeof first === 'string'
        && first.startsWith(TEXT_AGENT_DEGRADED_WARN_PREFIX)
        && first.includes(TEXT_AGENT_DEGRADED_WARN_MARKER)
      ) {
        textAgentDegradationNotified = true;
        try {
          notify({ type: 'cli:text-agent-fallback' });
        } catch {
          // 通知面抛错吞掉——原 warn 必须原样出去
        }
      }
    } finally {
      originalWarn(...args);
    }
  };
  console.warn = patchedWarn;
  textAgentDegradationFaceInstalled = true;
  return () => {
    console.warn = originalWarn;
    textAgentDegradationFaceInstalled = false;
  };
}

/** wiring 测试探针：事件面已安装（agentIpc 装配行被删 = false → 红）。 */
export function __isTextAgentDegradationFaceInstalledForTest(): boolean {
  return textAgentDegradationFaceInstalled;
}

/** 测试缝：复位单次旗（module-level state 不得跨测试泄漏）。 */
export function _resetTextAgentDegradationFaceForTest(): void {
  textAgentDegradationNotified = false;
}

let runtime: WorkflowRuntime;

/**
 * Story 4.0：expose the singleton agent runtime so co-registered dogfood IPC
 * (closure:run-chapter-chain) can call `runChapterChain` without re-creating it.
 * Lazily resolved inside handler invocation — registerAgentIpc runs before any
 * invoke (registerAllIpc order), so the runtime is initialised by then.
 */
export function getAgentRuntime(): WorkflowRuntime {
  if (!runtime) {
    throw new Error('agent runtime not initialised — registerAgentIpc must run first');
  }
  return runtime;
}

/**
 * In-flight stream abort controllers, keyed by sessionId, for agent:abort-run.
 *
 * dogfood T1 CR-T1-022：值是 **Set**（同 session 重叠 invoke 各持一个 controller）——旧单槽
 * `Map<sessionId, AbortController>` 在第二次 invoke 时覆盖、先退者 delete，幸存 run 失 abort
 * 通道。abort-run abort 全部；finally 只删自己的那个（空集才删键——启动对账的
 * `has(sessionId)`「活跃流」判据语义不变：非空集 = 活跃）。
 */
const streamAbortControllers = new Map<string, Set<AbortController>>();

export function registerStreamAbortController(sessionId: string, controller: AbortController): void {
  const set = streamAbortControllers.get(sessionId);
  if (set) set.add(controller);
  else streamAbortControllers.set(sessionId, new Set([controller]));
}

export function unregisterStreamAbortController(sessionId: string, controller: AbortController): void {
  const set = streamAbortControllers.get(sessionId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) streamAbortControllers.delete(sessionId);
}

// ─── dogfood T1 Stage 3（design §5.4 D4）：per-project 单 run 注册表 ───
//
// 同项目同时只允许一个 run（两会话同项目 run 竞争 project.yaml/章节文件/git 提交 +
// 渲染层键控前的单槽互顶雷区）；跨项目自由并行。key = normalizeProjectKey(projectPath)
// （pathGuard 同款 resolve + win32 大小写归一——防 `C:\a` / `c:/a/` 双 key 漏闸）。
// 闸点 = agent:stream-message + closureChainIpc 两链 IPC 入口 + agent:execute-skill（子
// agent 派发经父 run 同项目，不另拦）+ agent:compact-session（手动压缩也发 LLM 摘要调用，
// trellis-check 补接——占用时 false + warn 而非结构化 rejected，布尔契约通道）；**释放 =
// 各入口 handler 的 finally（经 acquire 返回的 handle.release）**。注册表纯内存——崩溃后
// 随进程消亡，无持久锁死。
//
// dogfood T1 CR-T1-012/021（租约引用计数）：旧「同 sessionId 即放行 + release 按
// sessionId 整键删除」两缺陷——① 同 session 重叠 invoke（cancelAgent 后立刻重发 /
// write_chapter paused → resume 与 leader 收尾并发）先退者的 finally 会释放后者的租约；
// ② runState.beginRun 抛错路的 finally 仍释放第一路租约。现改为 **handle 记账**：
// acquire 返 `{ok:true, release}`，内部按 (projectKey, leaseId) 引用计数；同 sessionId
// 重入 refCount+1；release 幂等只衰减一次，归零才真删键。调用方一律 `finally { release() }`，
// 不再持 sessionId 二次释放。

type ProjectRunLease = { sessionId: string; projectPath: string };

// 09-21-subagent-bg-decouple W3（design §4.1 / D7）：租约**车道化**——值结构扩双桶。
// - leader 车道（stream-message / execute-skill / compact / 链两车道）：`lease` + `refCount`
//   语义**字节级不变**（同项目 leader 车道互斥、同 sessionId 重入引用计数、幂等 release）。
//   bg-only 期间（后台子会话在跑、无 leader run）`lease` 为 null。
// - bg 车道：`bgSessions`（childSessionId → 引用计数）独立计数，帽 MAX_BG_PER_PROJECT——
//   与 leader 车道/彼此并存，互不触发对方拒绝。
// 写安全依据（research/write-safety-anchors.md）：并发写防护的真不变量在 fs 层 withProjectLock
// （project.yaml 读-改-写全锚）+ 章节原子写 + git_commit 补闸（gitHandlers.ts）——租约是粗粒度
// 前置闸，bg 车道豁免 leader 互斥不破写安全。
type ProjectRunLeaseEntry = {
  /** leader 车道租约；null = 仅 bg 车道占键（后台子会话存活、无 leader run）。 */
  lease: ProjectRunLease | null;
  /** leader 车道活跃句柄数（同 sessionId 重叠 invoke 各持一个）——归零且 bg 空才删键。 */
  refCount: number;
  /** bg 车道：后台子会话引用计数（childSessionId → count），帽 = MAX_BG_PER_PROJECT（distinct sessions）。 */
  bgSessions: Map<string, number>;
};

const projectActiveRuns = new Map<string, ProjectRunLeaseEntry>();

/**
 * 链 IPC（closure:run-chapter-chain）的租约 id 前缀——dogfood 路径无 leader 会话，stub
 * parent 在 gate 之后才创建（拒绝时不留半成品 session）。CR-T1-020：**每次 invoke 生成
 * 唯一 id**（`${CHAIN_RUN_LEASE_ID}:${uuid}`）——旧常量 id 会让同项目两条并发链第二路
 * 恒放行 + 先完成者 finally 删掉后者租约。前缀保留（`chain-run:closure:`）供 UI 识别
 * 「链占用」形态（toast 换文案不提供跳转钮——stub 会话不在会话列表，跳转必失败）。
 */
export const CHAIN_RUN_LEASE_ID = 'chain-run:closure';

/**
 * W4（09-21-subagent-bg-decouple U6 存量债）：会话列表可列判定（`agent:list-sessions`
 * 默认过滤）。排除两类非用户会话：
 * ① sessionRole='child'——子会话检视只经钻取/后台任务条进入（防空壳/后台行污染列表）；
 * ② 链 stub parent——closureChainIpc 两入口建的 dogfood/重提取桩（非视图会话；spec
 *    ipc-handlers「stub 会话不在会话列表」的既定意图）。字面量与创建点耦合（closureChainIpc.ts
 *    :885/:1668），mirror :1432 既有字面量判断形态——新增 stub agentName 须两处同步。
 * undefined/null role = 旧 primary 会话（sessionRole 列后加的历史行）——照列。
 */
const STUB_CHAIN_AGENT_NAMES = new Set(['chapter-chain-dogfood', 'chapter-reextract']);

export function isListableSession(s: { sessionRole?: string | null; agentName: string }): boolean {
  if (s.sessionRole === 'child') return false;
  return !STUB_CHAIN_AGENT_NAMES.has(s.agentName);
}

export type ProjectRunGateResult =
  | { ok: true; release: () => void }
  | { ok: false; held: ProjectRunLease };

/** bg 车道闸结果（mirror ProjectRunGateResult 句柄形态；拒绝族新成员 `bg_capacity`）。 */
export type BgRunGateResult =
  | { ok: true; release: () => void }
  | { ok: false; code: 'bg_capacity'; runningCount: number; cap: number; projectPath: string };

/** 无项目归属（不应发生）时的空句柄——不闸，保持既有行为。 */
function noopRelease(): void { /* no-op */ }

export function acquireProjectRun(projectPath: string | undefined, sessionId: string): ProjectRunGateResult {
  if (!projectPath) return { ok: true, release: noopRelease };
  const key = normalizeProjectKey(projectPath);
  const entry = projectActiveRuns.get(key);
  // leader 车道互斥只看 leader 桶——bg 会话在场不拦 leader（车道并存，W3）。
  if (entry && entry.lease && entry.lease.sessionId !== sessionId) {
    return { ok: false, held: entry.lease };
  }
  if (entry && entry.lease) {
    entry.refCount += 1;
  } else if (entry) {
    // bg-only 键：leader 车道空置——收编租约（语义等价新建）。
    entry.lease = { sessionId, projectPath };
    entry.refCount = 1;
  } else {
    projectActiveRuns.set(key, { lease: { sessionId, projectPath }, refCount: 1, bgSessions: new Map() });
  }
  let released = false;
  return {
    ok: true,
    // CR-T1-021：句柄幂等（双 finally / 手滑双调不二次衰减）+ 只衰减自己那一份。
    release: () => {
      if (released) return;
      released = true;
      const current = projectActiveRuns.get(key);
      if (!current || current.lease?.sessionId !== sessionId) return;
      current.refCount -= 1;
      if (current.refCount <= 0) {
        // W3：bg 会话仍占键时只摘 leader 租约（保留 bg 桶），全空才删键。
        if (current.bgSessions.size === 0) projectActiveRuns.delete(key);
        else current.lease = null;
      }
    },
  };
}

/**
 * bg 车道闸（W3，design §4.1）：后台子会话 per-project 独立计数，帽 MAX_BG_PER_PROJECT
 * （与 agent 包 BgTaskRegistry.dispatchBg 的 BgCapacityError 同常量对齐——agent 侧是工具面
 * 权威拒绝（spawn_agent_bg 超帽响亮拒绝），本闸是 shell 侧结构化记账面 + 拒绝族
 * `bg_capacity|heldBy=...` 形态 mirror）。与 leader 车道/彼此并存。
 *
 * 挂接：onRuntimeEvent 泵（本文件）在首个 bg 子会话事件登记、`bg-update` 终态事件释放——
 * agent 包 dispatchBackground 无 IPC 入口，shell 经运行时事件泵感知 bg 子会话生命周期。
 */
export function acquireBgRun(projectPath: string | undefined, childSessionId: string): BgRunGateResult {
  if (!projectPath) return { ok: true, release: noopRelease };
  const key = normalizeProjectKey(projectPath);
  let entry = projectActiveRuns.get(key);
  if (!entry) {
    entry = { lease: null, refCount: 0, bgSessions: new Map() };
    projectActiveRuns.set(key, entry);
  }
  const prev = entry.bgSessions.get(childSessionId) ?? 0;
  if (prev === 0 && entry.bgSessions.size >= MAX_BG_PER_PROJECT) {
    return {
      ok: false,
      code: 'bg_capacity',
      runningCount: entry.bgSessions.size,
      cap: MAX_BG_PER_PROJECT,
      projectPath,
    };
  }
  entry.bgSessions.set(childSessionId, prev + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      releaseBgRun(projectPath, childSessionId);
    },
  };
}

/** bg 车道释放（幂等；bg-only 键随最后一个 bg 会话释放删除——mirror leader 车道句柄语义）。 */
export function releaseBgRun(projectPath: string | undefined, childSessionId: string): void {
  if (!projectPath) return;
  const key = normalizeProjectKey(projectPath);
  const entry = projectActiveRuns.get(key);
  if (!entry) return;
  const count = (entry.bgSessions.get(childSessionId) ?? 0) - 1;
  if (count <= 0) entry.bgSessions.delete(childSessionId);
  else entry.bgSessions.set(childSessionId, count);
  if (entry.bgSessions.size === 0 && !entry.lease) projectActiveRuns.delete(key);
}

/**
 * 诊断/测试：强制释放某项目键上该会话的**全部**引用（整键删除）。正常路径一律走
 * `acquire().release`——本函数只用于测试复位与对账兜底。W3：仅摘 leader 桶（bg 桶不动，
 * bg 空且无 leader 租约才整键删）。
 */
export function releaseProjectRun(projectPath: string | undefined, sessionId: string): void {
  if (!projectPath) return;
  const key = normalizeProjectKey(projectPath);
  const entry = projectActiveRuns.get(key);
  if (entry && entry.lease?.sessionId === sessionId) {
    entry.lease = null;
    entry.refCount = 0;
    if (entry.bgSessions.size === 0) projectActiveRuns.delete(key);
  }
}

/** 测试/诊断：当前注册表快照（只读；值为 {lease|null, refCount, bgSessions} 结构）。 */
export function getProjectActiveRuns(): ReadonlyMap<string, ProjectRunLeaseEntry> {
  return projectActiveRuns;
}

/**
 * D4 启动对账：注册表在内存（启动恒空，无持久锁死）；磁盘 status='running' 的崩溃残留
 * 会话会让 runtime 的 mode-setter 永拒（`session.status === 'running'` guard）+ UI 磁盘
 * 兜底误显运行——逐项目核对归位 idle 并清非活跃注册表项。registerAgentIpc 时异步跑
 * （vitest 环境跳过——测试直调本函数驱动，避免测试进程触真实 machine db）。
 *
 * W3 扩双车道（design §4.1/§4.2）：
 * - bg-tasks.json 启动对账——`getBgTaskRegistry().reconcileInterrupted(project.path)` 把
 *   磁盘 running 行改 interrupted 回写 + 全量 hydrate 进内存（completed/failed/aborted 行
 *   照常可查——「历史可检视」；不复活不谎报 running，design D6/R7）。
 * - 子会话面覆盖——W1 起 bg 子会话有真 running 磁盘态（dispatchBackground updateStatus），
 *   下方逐会话循环天然覆盖 child role（listSessions 无 role 过滤在此恰是正确行为）。
 * - 注册表清扫扩 bg 桶：bg 条目以 streamAbortControllers(childSid)（onRuntimeEvent 登记，
 *   本进程活体判据同 leader 车道）为准——无活体的 stale 条目清除。
 */
export async function reconcileStaleProjectRuns(): Promise<void> {
  try {
    const { listProjects } = await import('../db/projectRepository');
    const projects = listProjects().filter((p) => p.path && !p.deletedAt);
    for (const project of projects) {
      // W3：后台任务注册表启动对账（先于会话循环——同 reconcile 时序，逐项目幂等）。
      try {
        getBgTaskRegistry().reconcileInterrupted(project.path!);
      } catch (bgErr) {
        const bgMsg = bgErr instanceof Error ? bgErr.message : String(bgErr);
        logger.warn({ err: bgMsg, projectPath: project.path }, 'projectRunGate: bg-tasks reconciliation failed (non-fatal)');
      }
      const sessions = runtime.listSessions(project.path!).sessions;
      for (const s of sessions) {
        if (s.status !== 'running') continue;
        if (streamAbortControllers.has(s.id)) continue; // 本进程活跃流（直调场景）——bg 子会话经 W3 onRuntimeEvent 登记同判据。
        const live = runtime.getSession(s.id, project.path!);
        if (live && live.status === 'running') {
          updateSessionStatus(s.id, 'idle');
          logger.info(
            { sessionId: s.id, projectPath: project.path },
            'projectRunGate: stale running session reconciled to idle',
          );
        }
      }
    }
    for (const [key, entry] of [...projectActiveRuns]) {
      if (entry.lease && !streamAbortControllers.has(entry.lease.sessionId)) {
        entry.lease = null;
        entry.refCount = 0;
      }
      for (const sid of [...entry.bgSessions.keys()]) {
        if (!streamAbortControllers.has(sid)) entry.bgSessions.delete(sid);
      }
      if (!entry.lease && entry.bgSessions.size === 0) projectActiveRuns.delete(key);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'projectRunGate: stale-run reconciliation failed (non-fatal)');
  }
}

// ─── W3：bg 子会话 shell 侧生命周期记账（design §4.1 车道化挂接 + §5 事件泵） ───
//
// agent 包 dispatchBackground 无 IPC 入口（bg 子 run 全程在 agent 包内进程执行）——shell 经
// onRuntimeEvent 泵（createWorkflowRuntime 装配回调）感知 bg 子会话生命周期：
// - 首个 child 车道事件（sessionRole='child'，bg 子会话专属通道——同步子代理事件冒泡进
//   leader sendEvent 不经此泵）→ acquireBgRun 登记 bg 桶 + 注册 shell AbortController
//   （streamAbortControllers：① 对账「本进程活跃流」判据承认活体 bg 子会话，防 stale 归位
//   误杀；② agent:abort-run 的 IPC 控制器循环可达。子 runLoop 实际停止走 D2 store 链
//   （runtime.abortRun(childSid)）与 registry.cancel——此 controller 是生命周期可见性面）。
// - `bg-update` 终态事件（任务终态恰一次，W2 outcome 链发射）→ 释放 bg 桶 + 注销 controller。
//
// 容量：帽 MAX_BG_PER_PROJECT 与 agent 包 BgCapacityError 同常量；泵路径满帽（理论不可达——
// agent 侧工具面先行拒绝）降级 warn 不破事件流。
const bgChildAbortControllers = new Map<string, AbortController>();

/**
 * CR-4：bg 桶登记时记 childSid → projectPath 映射（模块级）。bg-update 到达时父会话可能已删
 * / 现查 getSession 拿不到 projectPath——释放兜底用登记映射，防 bgSessions 桶泄漏（泄漏槽位
 * 永久占用 bg 车道帽直至重启）。随终态释放 / 测试复位一并清。
 */
const bgChildProjectPaths = new Map<string, string>();

/**
 * bg 子会话运行时事件记账（onRuntimeEvent 泵调用点；导出供测试直驱）。
 * 非子会话事件（leader / bg-update 载荷自身的 parent sid）只走 bg-update 终态分支。
 */
export function noteBgChildRuntimeEvent(
  sessionId: string,
  event: { type: string; data: unknown },
  session?: { sessionRole?: string; projectPath?: string },
): void {
  try {
    if (event.type === 'bg-update') {
      const data = event.data as { childSessionId?: string } | undefined;
      const childSessionId = data?.childSessionId;
      if (childSessionId) {
        // 终态信号 = 清账点：controller 登记与 projectPath 映射都清（controller 缺席〔漂移态/
        // 登记被拒〕不阻碍释放——releaseBgRun 幂等，多减下探为删除）。
        const controller = bgChildAbortControllers.get(childSessionId);
        if (controller) {
          bgChildAbortControllers.delete(childSessionId);
          unregisterStreamAbortController(childSessionId, controller);
        }
        // 反查项目键：终态载荷带 parent 的 projectPath——同键释放（bg-only 键随释放删除）。
        // CR-4 兜底：父会话已删/现查无 projectPath 时用登记映射（登记时值），防桶泄漏。
        const projectPath = session?.projectPath ?? bgChildProjectPaths.get(childSessionId);
        if (projectPath) releaseBgRun(projectPath, childSessionId);
        bgChildProjectPaths.delete(childSessionId);
      }
      return;
    }
    if (event.type !== 'child') return;
    if (session?.sessionRole !== 'child') return;
    if (bgChildAbortControllers.has(sessionId)) return; // 已登记（每子会话首事件登记一次）。
    const gate = acquireBgRun(session?.projectPath, sessionId);
    if (!gate.ok) {
      logger.warn(
        { childSessionId: sessionId, projectPath: session?.projectPath, runningCount: gate.runningCount, cap: gate.cap },
        'bgRunGate: bg lane capacity full at runtime-event registration (agent-side cap should have rejected earlier)',
      );
      return;
    }
    // ⚠ acquire 内部已计数——上面的 gate.release 若被调会错释放；此处只持有不释放
    // （释放唯一入口 = bg-update 终态分支）。为句柄语义正确，登记即视为长期持有。
    const controller = new AbortController();
    bgChildAbortControllers.set(sessionId, controller);
    if (session?.projectPath) bgChildProjectPaths.set(sessionId, session.projectPath);
    registerStreamAbortController(sessionId, controller);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, sessionId }, 'bgRunGate: runtime-event bookkeeping failed (non-fatal)');
  }
}

/** 测试/诊断：清空 bg 子会话记账（mirror 各注册表测试复位形态）。 */
export function _resetBgChildBookkeepingForTest(): void {
  for (const [childSessionId, controller] of [...bgChildAbortControllers]) {
    unregisterStreamAbortController(childSessionId, controller);
  }
  bgChildAbortControllers.clear();
  bgChildProjectPaths.clear();
  for (const [key, entry] of [...projectActiveRuns]) {
    entry.bgSessions.clear();
    if (!entry.lease) projectActiveRuns.delete(key);
  }
}

/**
 * 测试专用（CR-15 双簿记偏差场景构造）：摘除某 bg 子会话的 shell abort controller 登记而不清
 * bg 桶——模拟「bg-update 事件丢失且 controller 生命周期面已消失」的漂移态，供 reconcile
 * 收敛路径断言（偏差必经启动对账清扫收敛）。
 */
export function _unregisterBgChildControllerForTest(childSessionId: string): void {
  const controller = bgChildAbortControllers.get(childSessionId);
  if (!controller) return;
  bgChildAbortControllers.delete(childSessionId);
  unregisterStreamAbortController(childSessionId, controller);
}

let registered = false;

/**
 * CR-16（09-12 子2 CR 批）：agent 缝 body 的 schema 校验门——此前 `as any` 直传使畸形
 * 载荷（坏 thinking 投影的回退链条目等）绕过 generateTextPayloadSchema 直达协议层
 * （schema 存在但从未 parse 真实载荷）。校验语义（校验-only 门，非改写管线）：
 * - 严格 safeParse 直接过 → **原 body 原样过缝**（引用/未知键零改写——快径字节级语义
 *   不变；sessionKey 等两态归一 agent 装配侧已做，parse 产物不取代原 body）。
 * - 缝上载荷可含**指针形态 image part**（`{type:'image', image:{path, b64hash}}`——
 *   agent 零 FS，b64/转述归一在网关 resolveImageParts，generationPartSchema 只认归一
 *   后的 b64Json/mimeType 形态）：首轮失败后把 content 数组里的 image part 置为最小
 *   合法占位复跑一次——复跑成功 = 偏差仅在图片载荷 → 原样放行（指针必须存活到
 *   resolveImageParts；图片 part 自身的畸形由该层 degrade 语义兜底，非本门职责）。
 * - 仍失败 = 真畸形 → 抛（走既有错误路径：reject 上抛，agent 侧 generate 调用点 /
 *   runLoop catch 面不变）。
 */
function assertAgentGenerateBodyValid(body: GenerateTextRequest): void {
  const strict = generateTextPayloadSchema.safeParse(body);
  if (strict.success) return;
  const request = body.request;
  const probe = {
    ...body,
    ...(request === undefined
      ? {}
      : {
          request: {
            ...request,
            ...(Array.isArray(request.messages)
              ? { messages: request.messages.map(placeholderImageParts) }
              : {}),
          },
        }),
  };
  const retried = generateTextPayloadSchema.safeParse(probe);
  if (retried.success) return;
  throw new Error(
    `agent generate body failed schema validation: ${retried.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')}`,
  );
}

/** CR-16：图片 part 占位化——image part 的载荷整体换成最小合法形态（只用于复跑甄别，不进真实载荷）。 */
function placeholderImageParts(message: unknown): unknown {
  if (!message || typeof message !== 'object' || !Array.isArray((message as { content?: unknown }).content)) {
    return message;
  }
  return {
    ...message,
    content: (message as { content: unknown[] }).content.map((part) =>
      part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'image'
        ? { type: 'image', image: { b64Json: '__placeholder__', mimeType: 'application/octet-stream' } }
        : part,
    ),
  };
}

export function registerAgentIpc(getWin: () => BrowserWindow | null) {
  // Handlers register once for the app lifetime; a recreated window is resolved
  // lazily via getWin. Re-registering the same channel would throw.
  if (registered) {
    return;
  }
  registered = true;

  // Dogfood T1 Stage 1（流式缝）：按 callbacks 有无分派。只有显式传 onDelta 的
  // 调用方走流式路径（generateTextStream）；既有全部调用点（runLoop / 链节点 /
  // summarizer——都不传）原样留在非流式路径，零回归（design §2）。渲染层直调的
  // model:generate-text IPC 维持非流式不动。
  // dogfood R2 #7：body 原样过缝——request.lane（child/链车道 'background'）随 body
  // 进入两 handler，由 modelGatewayIpc 透传到 ProtocolCallContext（车道选窗 240s +
  // 有界回退；缺席 = interactive 60s 红线原样）。
  // 09-12 子2 fallback chains：onFallback 与 onDelta 同一 callbacks 对象过缝——
  // 非流式调用配链时切换事件同样可达（onFallback 单独在场也走第 3 参）。
  // CR-15（09-12 子2 CR 批）：onFallback 形态单源 ModelFallbackSwitchEvent
  //（shared-contracts contracts/generation.ts）——inline 结构 cast 撤除。
  // CR-16（09-12 子2 CR 批）：body 先过 generateTextPayloadSchema 校验门（见
  // assertAgentGenerateBodyValid）——`as any` 直传使畸形载荷（坏 thinking 投影的回退
  // 条目等）绕过 schema 直达协议层的缺口闭合（schema 存在且真实 parse）。
  const generateTextImpl: GenerateTextFn = async (body, abort, callbacks) => {
    assertAgentGenerateBodyValid(body);
    const onFallback = callbacks?.onFallback;
    const result = callbacks?.onDelta
      ? await handleGenerateTextStream(body as unknown as GenerateTextPayload, abort, callbacks.onDelta, onFallback)
      : await handleGenerateText(body as unknown as GenerateTextPayload, abort, onFallback);
    return result;
  };
  setGenerateTextFn(generateTextImpl);

  // 子4 W4（09-12 agy MCP 工具桥）：dialogue 桥车道注入 seam（mirror setGenerateTextFn——
  // agent 纯编排，桥 turn 执行在 shell 桥基座 agyBridgeIpc：consent 硬门〔CR-27〕+ 模型
  // 解析 + 注册表 live 监听）。wiring 测试钉死漏装配——删任一行桥车道静默回 runLoop
  // 纯文本路径（resolver 未装配 = off，fail-safe 方向）。
  // 09-20 F17 W0（design §1.3/§3）：agentRuntime / getWin 经装配点注入——两值都住在
  // agentIpc 作用域（getAgentRuntime 单例 + registerAgentIpc 的 getWin 参数），agyBridgeIpc
  // 静态 import 本文件会成环，故走 deps 覆写缝（mirror deps.registry() 避环形态）。
  const agyBridgeDeps = agyBridgeProductionDeps({ agentRuntime: getAgentRuntime, getWin });
  setAgyBridgeModeResolver(createAgyBridgeLaneModeResolver(agyBridgeDeps));
  setBridgeTurnFn(createAgyBridgeTurnProduction(agyBridgeDeps));

  // 09-19 CLI 白名单 W3：纯文本车道零工具 agent 解析器注入（mirror 桥 seam 注入形态——
  // 协议层驱动器每 turn 组 spec 时咨询；决策全在 shell 闭包：无 declined 记录 + 存在
  // agy CLI key + 文件 current → 布局常量激活值，否则 undefined 走 γ 反工具硬化兜底）。
  // wiring 测试钉死漏装配——删此行 spawn 静默回无 agent 路径（行为等价旧状，γ 兜底恒在，
  // 但注入缝失明）。
  setAntigravityCliTextAgentResolver(createTextAgentResolverProduction());

  // 09-19 CLI 白名单 W4：降级带 warn → 事件面上浮安装（一次性 toast 的 shell 补线——
  // 拦截 console.warn 降级签名串；wiring 测试钉死漏安装）。
  installTextAgentDegradationEventFace(notifyUI);

  // 09-01 附件 B3（design §2.3）：agentImageParts 防环注入内核装配——prepareImage
  // （visionAnalysis）/ resolveModelRef（modelGatewayIpc）/ readModelConfig（configIpc）
  // 三者都在既有依赖环上，经此处装配（mirror setGenerateTextFn 注入形态；wiring 由
  // agentIpcStreamDispatch.test 钉死）。CR-003a（决议 a）：转述进度广播发射器——mirror
  // notifyUI 的全窗 webContents.send 广播形态，专用通道 'image-relay-progress'、载荷
  // { current, total }（单窗口 app 无需 session 定向）；直传路/缓存全命中不发，UI 消费
  // 面后置按此载荷形态接入。
  installAgentImagePartsCore({
    prepareImage: prepareVisionImage,
    resolveModelRef: resolveModel,
    readModelConfig: readModelConfigFromDisk,
    notifyRelayProgress: (progress) => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('image-relay-progress', progress));
    },
  });

  // C3.2 task-model routing: inject the slot resolver next to the generate
  // seam (mirror of setGenerateTextFn — the agent runtime never reads disk
  // config itself). The closure queries readTaskModelSlots per resolve — an
  // mtime+size-gated read (CR-004) whose semantics stay "fresh": a slot change
  // in settings rewrites the sidecar and takes effect on the next dialogue
  // turn / next chain assembly without a restart. A missing/invalid sidecar
  // yields undefined → provider default sentinel → shell auto-pick (the
  // pre-routing path).
  // 09-12 子3 §4.4：闭包上叠 enrichSlotAssignment——key 级 defaults.contextWindow
  // 覆盖注入 assignment.contextWindowTokens（runtime-only，sidecar 永不落盘此字段；
  // 无值恒等返回——零配置键行为逐字节不变）。
  setTaskSlotResolver((slot) => enrichSlotAssignment(readTaskModelSlots()?.[slot]));

  // S4b（task 08-25 design §4.1，thinking-controls）：压缩红线策略注入——mirror
  // setTaskSlotResolver 的注入形态（agent 运行时按 ADR-2 不读盘，shell 注入现读闭包）。
  // readUserPreferencesFromDisk 每次现读（configIpc 现有读法，无进程级缓存）→ 用户改红线
  // 下一次 send 生效；preferences 缺 contextCompaction 时读路径回默认 95（configIpc 归一）。
  setContextPolicyProvider(() => readUserPreferencesFromDisk().contextCompaction);

  const executeToolImpl: ExecuteToolFn = async (toolId, params, ctx) => {
    return handleToolExecute({
      toolId,
      params: params as Record<string, unknown>,
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      abort: ctx.abort,
    });
  };
  setExecuteToolFn(executeToolImpl);

  registerBuiltinTools();

  // S4b（task 08-25 design §3.2）：runtime 无 stream 车道的方法（manualCompactSession 的
  // compaction 事件）经 onRuntimeEvent 广播——mirror streamMessage 的 sendEvent 形态
  //（agent:stream-event + sessionId/projectPath 附加字段，UI 全局监听同一通道消费）。
  // projectPath 每事件现查（手动压缩低频，getSession 内存 LRU 查询零盘 IO）。
  runtime = createWorkflowRuntime({
    onRuntimeEvent: (sessionId, event) => {
      try {
        const session = runtime.getSession(sessionId);
        const projectPath = session?.projectPath;
        // W3：bg 子会话 shell 侧生命周期记账（bg 车道桶 + abort 可达面）——先于广播，
        // 失败不破事件流（函数内自容错）。
        noteBgChildRuntimeEvent(sessionId, event, session);
        // W3 additive：载荷补 sessionRole——renderer 据此区分 bg 子会话事件（W4 消费：
        // isProjectRunActive 口径排除 + 检视图路由）。缺省字段不发送（undefined 不入载荷）。
        getWin()?.webContents.send('agent:stream-event', {
          ...event,
          sessionId,
          projectPath,
          ...(session?.sessionRole ? { sessionRole: session.sessionRole } : {}),
        });
      } catch {
        // Window may have been closed — mirror sendEvent 容错
      }
    },
  });

  // D4 启动对账（design §5.4 补强③）：stale 'running' 归位 idle + 清注册表。测试环境
  // 跳过（reconcileStaleProjectRuns 直调驱动），防 registerAgentIpc 的测试触真实 db。
  if (process.env.NODE_ENV !== 'test') {
    void reconcileStaleProjectRuns();
  }

  // ─── Request/Response handlers ───

  // Use the single shared `runtime` for the whole session lifecycle. Previously
  // create-session built a *separate* runtime carrying externalSkillRoots, while
  // get-session/execute-skill/stream-message used this module-level one — two
  // divergent instances with their own session caches and skill registries, so
  // external skills listed but wouldn't execute. The runtime's listSkills /
  // executeSkillByName / buildRuntimeSystemPrompt already load per-project
  // externalSkillRoots via loadRuntimeConfig, so a single instance suffices.
  ipcMain.handle('agent:create-session', async (_event, input: CreateSessionInput) => {
    return runtime.createSession(input);
  });

  ipcMain.handle('agent:get-session', async (_event, id: string, projectPath?: string) => {
    return runtime.getSession(id, projectPath) ?? null;
  });

  ipcMain.handle('agent:set-session-mode', async (_event, sessionId: string, projectPath: string | undefined, mode: 'readonly' | 'suggest' | 'auto') => {
    const session = runtime.getSession(sessionId, projectPath);
    if (!session) return { ok: false };
    const ok = runtime.setSessionPermissionMode(sessionId, mode);
    return { ok };
  });

  // Story 3.1: set leader runLoop behavior mode (normal/discuss/plan).
  ipcMain.handle('agent:set-session-behavior-mode', async (_event, sessionId: string, projectPath: string | undefined, behaviorMode: 'normal' | 'discuss' | 'plan') => {
    // CR-workbench-interaction-core-003: validate at the IPC boundary — TS
    // annotations are erased at runtime, so without this an invalid/garbage
    // behaviorMode would be persisted to session meta + disk (loadSession only
    // defaults on undefined, not on junk).
    if (behaviorMode !== 'normal' && behaviorMode !== 'discuss' && behaviorMode !== 'plan') {
      return { ok: false };
    }
    const session = runtime.getSession(sessionId, projectPath);
    if (!session) return { ok: false };
    const ok = runtime.setSessionBehaviorMode(sessionId, behaviorMode);
    return { ok };
  });

  // Story 3.5: set leader participation gear (smart/steer/balanced/hands_off) +
  // balanced 档圈类别 / hands_off trustAdjudication。mirror set-session-behavior-mode 的
  // IPC 边界校验（CR-003 教训：TS 注解运行时擦除，垃圾值会持久化到 session meta + 磁盘）。
  // runtime setter 另有第二防线（运行时 enum 校验）。
  // CR-011：空 `[]` 在 IPC/runtime/UI 三处都被拒（mirror zod .min(1)——空数组不属任一状态）。
  ipcMain.handle(
    'agent:set-session-participation-gear',
    async (
      _event,
      sessionId: string,
      projectPath: string | undefined,
      gear: string,
      options?: { balancedAskCategories?: string[]; trustAdjudication?: boolean },
    ) => {
      const VALID_GEARS = ['smart', 'steer', 'balanced', 'hands_off'];
      const VALID_CATEGORIES = ['protagonist_safety', 'information_gap', 'direction_turn'];
      if (typeof gear !== 'string' || !VALID_GEARS.includes(gear)) {
        return { ok: false };
      }
      if (
        options?.balancedAskCategories !== undefined &&
        (!Array.isArray(options.balancedAskCategories) ||
          options.balancedAskCategories.length < 1 ||
          !options.balancedAskCategories.every((c) => typeof c === 'string' && VALID_CATEGORIES.includes(c)))
      ) {
        return { ok: false };
      }
      if (options?.trustAdjudication !== undefined && typeof options.trustAdjudication !== 'boolean') {
        return { ok: false };
      }
      const session = runtime.getSession(sessionId, projectPath);
      if (!session) return { ok: false };
      const ok = runtime.setSessionParticipationGear(
        sessionId,
        gear as 'smart' | 'steer' | 'balanced' | 'hands_off',
        options as { balancedAskCategories?: ('protagonist_safety' | 'information_gap' | 'direction_turn')[]; trustAdjudication?: boolean } | undefined,
      );
      return { ok };
    },
  );

  ipcMain.handle('agent:list-sessions', async (_event, projectPath?: string, opts?: { includeAllRoles?: boolean }) => {
    const { sessions } = runtime.listSessions(projectPath);
    // W4（09-21-subagent-bg-decouple U6 存量债）：默认只列用户会话。runtime 层 listSessions
    // 保持无过滤（reconcileStaleProjectRuns 依赖全量——bg 子会话有真 running 磁盘态后须被
    // 对账覆盖），过滤收口在本 IPC 面。
    return { sessions: opts?.includeAllRoles ? sessions : sessions.filter(isListableSession) };
  });

  // W4（09-21-subagent-bg-decouple）：后台任务注册表只读查询——UI「后台任务」条 hydrate
  // 数据源（重启后 interrupted 行如实呈现；运行期增量走 bg-update 事件，本查询只在项目
  // 打开/面板挂载时调，低频）。getBgTaskRegistry 为 W3 已引依赖（零新增 import）。
  ipcMain.handle('agent:bg-tasks', async (_event, projectPath?: string) => {
    return { tasks: projectPath ? getBgTaskRegistry().listByProject(projectPath) : [] };
  });

  ipcMain.handle('agent:delete-session', async (_event, id: string, projectPath?: string) => {
    return runtime.deleteSession(id, projectPath);
  });

  // 从此截断（dogfood 2026-08-21）：丢弃 messageId 及其后全部（内存+JSONL+索引）。
  // 纯对话尾巴闸门在 runtime 内核（session.ts）——含工具痕迹/运行中拒绝。
  ipcMain.handle('agent:truncate-session', async (_event, sessionId: string, messageId: string) => {
    return runtime.truncateSessionFromMessage(sessionId, messageId);
  });

  ipcMain.handle('agent:resolve-confirmation', async (_event, sessionId: string, callId: string, approved: boolean) => {
    return runtime.resolveConfirmation(sessionId, callId, approved);
  });

  ipcMain.handle('agent:list-skills', async (_event, projectPath: string) => {
    return runtime.listSkills(projectPath);
  });

  // dogfood T1 CR-T1-032：第四 run 车道补 D4 同款闸（skill 执行也是同项目 run——与
  // stream-message/链入口共享 projectActiveRuns 注册表，防孤儿键绕闸）。会话缺失时不闸
  // （既有 'session not found' throw 路径不变）。拒绝形态 mirror stream-message 的
  // 结构化拒绝（status:'rejected' + code + 占用者）。
  ipcMain.handle('agent:execute-skill', async (_event, sessionId: string, skillName: string, request?: string | ExecuteSkillRequest) => {
    const session = runtime.getSession(sessionId);
    const gate = session
      ? acquireProjectRun(session.projectPath, sessionId)
      : ({ ok: true as const, release: noopRelease });
    if (!gate.ok) {
      logger.info(
        { projectPath: session?.projectPath, sessionId, heldBy: gate.held.sessionId },
        'agent execute-skill rejected: another run active in this project',
      );
      return {
        status: 'rejected',
        code: 'project_run_active',
        heldBySessionId: gate.held.sessionId,
        projectPath: gate.held.projectPath,
      };
    }
    try {
      return await runtime.executeSkillByName(sessionId, skillName, request);
    } finally {
      gate.release();
    }
  });

  ipcMain.handle('agent:list-continuations', async (_event, sessionId: string) => {
    return runtime.listContinuations(sessionId);
  });

  ipcMain.handle('agent:restore-continuation', async (_event, sessionId: string, continuationId: string) => {
    return runtime.restoreContinuation(sessionId, continuationId);
  });

  ipcMain.handle('agent:abort-run', async (_event, sessionId: string) => {
    // dogfood R2 #105 R2.5：用户显式中断（UI 停止钮）入口留痕——修前服务端 abort 路径全线零日志，
    // 「链为何中断」无从诊断。此行是区分「用户主动停」vs「链被动被掐」的关键证据（只记一行，
    // 其余不动）。
    logger.info({ sessionId }, 'agent:abort-run requested (UI stop)');
    // Abort the IPC-level controllers too, so streamMessage is interrupted even
    // outside the runtime's own run window (defense-in-depth on top of abortRun).
    // CR-T1-022：Set 形态——同 session 重叠 invoke 的全部 controller 一并 abort。
    for (const controller of streamAbortControllers.get(sessionId) ?? []) {
      controller.abort();
    }
    // 09-20 F17 W3（design §4-1）：桥会话 abort 联动——桥车道在途本地工具执行
    // （write_chapter 整链）持 record.abortController.signal，此处一并掐断（此前只 abort
    // runtime/IPC 控制器，桥上链会继续跑到完成/自身失败——UI 停止钮对桥车道失联）。
    // 无桥会话 → false（非桥模型/HTTP 车道，零副作用幂等）。
    if (abortBridgeSession(sessionId)) {
      logger.info({ sessionId }, 'agent:abort-run: aborted in-flight agy bridge session (local tool execution)');
    }
    return runtime.abortRun(sessionId);
  });

  // 08-25 上下文压缩三触发之「手动」入口（thinking-controls design §3.2）：leader 工具条
  // 「压缩上下文」按钮 → 本通道 → runtime 侧单次摘要压缩（红线 ② / 顶满 ③ 自动触发在
  // runtime 内部，不经此通道）。
  //
  // 防御式 seam 调用：`manualCompactSession(sessionId, opts?): Promise<boolean>` 由
  // agent 包 S4 落地（CR-005 起 opts.windowTokens = dialogue 档模型 registry 窗口，见下方
  // 调用位），本 handler 先行接线——方法缺位 → false + warn（不 throw，UI 可按
  // false 呈现「不可用」）。命名注记：runtime 既有 legacy 纯函数成员叫 `compactSession`
  // （确定性压缩，返回 CompactedConversation），S4 侧新方法定名 `manualCompactSession`
  // 避开同名冲突——因此这里用 type-erased 访问（方法未落地时 WorkflowRuntime 类型上无此
  // 成员，直接属性访问 typecheck 不过）+ 结果 boolean 守卫防形态漂移。
  //
  // D4 per-project run 闸（trellis-check 发现的漏接车道）：手动压缩发起一次 LLM 摘要调用
  // ——同项目链/流/skill 在途时并发跑压缩违反「同项目同时只允一个 run」不变式。占用 →
  // **false + warn**（本通道契约是布尔（模式 A），不抛 IPC rejection；渲染层拿 false 无从
  // 区分拒绝与不可用，日志是唯一可观测面，故 warn 而非 info）。会话缺失时不闸（seam 自身
  // 的 false 路径覆盖——mirror stream-message / execute-skill）。seam 内部的「同 session
  // running 拒绝」是另一层（idle-only 语义），与本项目级外层闸不冗余。释放 = finally 经
  // acquire 句柄（CR-T1-021 引用计数）。
  ipcMain.handle('agent:compact-session', async (_event, sessionId: string) => {
    const manualCompactSession = (runtime as {
      manualCompactSession?: (sessionId: string, opts?: { windowTokens?: number }) => unknown;
    }).manualCompactSession;
    if (typeof manualCompactSession !== 'function') {
      logger.warn(
        { sessionId },
        'agent compact-session: runtime manualCompactSession not wired up — returning false',
      );
      return false;
    }
    const session = runtime.getSession(sessionId);
    const gate = session
      ? acquireProjectRun(session.projectPath, sessionId)
      : { ok: true as const, release: noopRelease };
    if (!gate.ok) {
      logger.warn(
        { projectPath: session?.projectPath, sessionId, heldBy: gate.held.sessionId },
        'agent compact-session rejected: another run active in this project — returning false',
      );
      return false;
    }
    try {
      // CR-005（08-25 BMad CR）：窗口解析——dialogue 档 assignment（经既有 slot resolver
      // 单源 readTaskModelSlots，与 setTaskSlotResolver 注入闭包同一读口）的 registry
      // limits.contextWindow。无指派 / 未知模型（无 limits）→ 不传（seam 回落缺省目标
      // = 现行为——固定 500K 目标治不了小窗模型，压缩 true 返回后下次请求照样 400）。
      // 09-12 子3 §4.4：经 enrichSlotAssignment + assignmentContextWindowTokens（agent
      // 包单源）取窗——key 级 defaults.contextWindow 覆盖对手动压缩同样生效，且「assignment
      // → 窗口」推导与 agent 面零第二实现。
      const dialogueAssignment = enrichSlotAssignment(readTaskModelSlots()?.dialogue);
      const windowTokens = assignmentContextWindowTokens(dialogueAssignment);
      const result = await manualCompactSession.call(
        runtime,
        sessionId,
        windowTokens !== undefined ? { windowTokens } : undefined,
      );
      if (typeof result !== 'boolean') {
        // Shape-drift guard for the parallel-landing window: whatever the seam
        // returns must be this channel's boolean contract — never leak a wrong
        // payload to the renderer.
        logger.warn(
          { sessionId },
          'agent compact-session: runtime manualCompactSession returned a non-boolean — treating as not wired',
        );
        return false;
      }
      return result;
    } catch (err) {
      // Expected user-visible failures (missing session, compaction refused)
      // come back as `false` per the seam contract; a throw here is a mode-A
      // boundary — surface false + warn rather than an IPC rejection (the
      // renderer button must not error-toast on a normal miss).
      logger.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'agent compact-session: runtime manualCompactSession threw — returning false',
      );
      return false;
    } finally {
      gate.release();
    }
  });

  // ─── Skill package management ───

  ipcMain.handle('agent:list-skill-packages', async (_event, projectPath?: string) => {
    return listSkillPackages(projectPath);
  });

  ipcMain.handle('agent:set-package-enabled', async (_event, packageName: string, enabled: boolean) => {
    await setPackageEnabled(packageName, enabled);
    return { ok: true };
  });

  ipcMain.handle('agent:set-skill-enabled', async (_event, packageName: string, skillName: string, enabled: boolean) => {
    await setSkillEnabled(packageName, skillName, enabled);
    return { ok: true };
  });

  // ─── Streaming handler ───

  ipcMain.handle('agent:stream-message', async (_event, input: { sessionId: string; content: string; attachments?: unknown[] }) => {
    const abortController = new AbortController();

    // dogfood T1 Stage 2（design §3.1 / r7 坑 2）：事件 payload 补 projectPath——store 级全局
    // 监听项目隔离的硬前提。会话不在内存时 streamMessage 自身会抛 'session not found'，此处
    // 仅 best-effort 解析一次（每事件零重复查询）。Preload/UI 消费不动（additive 字段）。
    const session = runtime.getSession(input.sessionId);
    const projectPath = session?.projectPath;

    // dogfood T1 Stage 3（design §5.4 D4）：同项目单 run 闸——占用时结构化拒绝（含占用
    // 会话 id + 项目路径，UI toast + 一键跳转）。会话缺失时不闸（既有 'session not found'
    // error 路径不变）。**释放 = finally（经 acquire 返回的 handle——CR-T1-021 引用计数：
    // 同 session 重叠 invoke 先退者只衰减自己那份，不再误删后者租约）**。
    let gateRelease: (() => void) | null = null;
    if (session) {
      const gate = acquireProjectRun(projectPath, input.sessionId);
      if (!gate.ok) {
        logger.info(
          { projectPath, sessionId: input.sessionId, heldBy: gate.held.sessionId },
          'agent stream rejected: another run active in this project',
        );
        return {
          status: 'rejected',
          code: 'project_run_active',
          heldBySessionId: gate.held.sessionId,
          projectPath: gate.held.projectPath,
        };
      }
      gateRelease = gate.release;
    }

    // Track per session so agent:abort-run can cancel an in-flight stream.
    // 闸后注册：D4 拒绝路径无流在途——提前注册会泄漏 entry（finally 不覆盖早退 return），
    // 且 streamAbortControllers.has 被启动对账当「活跃流」判据，泄漏即误判。
    // CR-T1-022：Set 形态追加（非整键覆盖）——同 session 重叠 invoke 各持通道。
    registerStreamAbortController(input.sessionId, abortController);

    const sendEvent = (event: { type: string; data: unknown }) => {
      try {
        getWin()?.webContents.send('agent:stream-event', { ...event, sessionId: input.sessionId, projectPath });
      } catch {
        // Window may have been closed
      }
    };

    try {
      await runtime.streamMessage({
        sessionId: input.sessionId,
        content: input.content,
        attachments: input.attachments as Parameters<typeof runtime.streamMessage>[0]['attachments'],
        abortSignal: abortController.signal,
        sendEvent,
      });
      return { status: 'completed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAbortError(err)) {
        return { status: 'aborted', message };
      }
      // dogfood T1 CR-T1-013：同 session 重叠 invoke 撞 runtime runState 的
      // SessionRunAlreadyActiveError（agent 包 runState.ts 导出——未从包入口导出，此处按
      // 消息前缀判别，mirror workflow.ts isSessionNotFoundError 的消息判等先例）——它是
      // 「已有 run」语义非失败：返结构化 busy 结果（UI 按「已占用」处理），**不发 error
      // 事件**（旧通用分支会误 purge 渲染层在流占位 + 误显错误横幅）。
      if (message.startsWith('run already active for session')) {
        logger.info(
          { sessionId: input.sessionId },
          'agent stream rejected: session already has an active run (overlapping invoke)',
        );
        return {
          status: 'rejected',
          code: 'session_run_active',
          heldBySessionId: input.sessionId,
          projectPath,
        };
      }
      logger.error({ err: message, sessionId: input.sessionId }, 'agent stream error');
      sendEvent({ type: 'error', data: { message } });
      return { status: 'error', message };
    } finally {
      gateRelease?.();
      unregisterStreamAbortController(input.sessionId, abortController);
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}
