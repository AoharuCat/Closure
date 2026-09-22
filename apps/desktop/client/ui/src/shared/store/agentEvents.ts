import { patchFieldSchema } from '@orison/shared-contracts';
import type { ChapterReviewMetadata, FieldPatchEntry, ProjectFieldPatch } from '@orison/shared-contracts';
import type { AgentMode } from './types';
import type { SelectionAnchor } from '../types/attachment';
import type { AgentMessage, AgentStreamEvent } from '../api/agent';
import { fetchAgentSession } from '../api/agent';
import { normalizeProjectPathForCompare, sameProjectPath } from './projectRunBusy';
import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';
import { WRITE_TOOLS, type PendingDiff, type PendingToolConfirm } from './agentDiffSlice';
// W4（09-21-subagent-bg-decouple）：toast role 人话化（toolMeta 纯映射——无 store 依赖不成环）。
import { roleLabel } from '../../features/agent-panel/toolMeta';
import { bufferStreamDelta, bufferChildStreamDelta, childTagPrefix, discardChildStartedPlaceholder, ensureChildStartedPlaceholder, purgeSessionStreams, settleStreamPlaceholder } from './agentStreamBuffer';
import { applyChainDelta, applyChainModelFallback, applyChainNodeDone, chainNodeLabel, finalizeChainRun, CHAIN_RUN_SENTINEL_NODE_ID, type ChainRunState } from './chainStreamBuffer';
// 09-13 子3 W2（design §2.2）：写作页运行时间线 + escalate findings 路由（chainTimeline 模块
// 持 apply/投影/写入面——本 dispatcher 只接线）。
import {
  applyTimelineArtifact,
  applyTimelineChainDelta,
  applyTimelineNodeDone,
  applyTimelineTool,
  extractEscalateFindingsFromMetadata,
  finalizeChainTimeline,
  setEscalateFindings,
  type ChainTimelineState,
  type EscalateFindingsEntry,
} from './chainTimeline';
import { recoverSelectionAnchorFromMessages } from './passageAnchor';
import { parseAgyBridgeConsentError, useAgyBridgeStore } from './agyBridgeStore';
import { randomUUID } from '../util/id';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 3（design §5.2 / r7）：store 级全局事件监听。
//
// 现状是 per-invocation 订阅（每次发送建一个 listener、8 处清理点防漏——r7 全表）；
// D3「切会话不 abort」后后台 run 继续产事件，per-invocation 模式下切走即丢且无法回放。
// 本模块改为**一次注册永不清退**的单例订阅（挂 appStore 组装层，WeakSet 按 store 实例
// 幂等——React 18 StrictMode 双挂载 / HMR 重执行免疫，mirror projectSubscription 判重法）。
//
// 分发谓词：`ev.sessionId === agentSessionId && ev.projectPath === currentProject.path`
// → 活跃视图（照旧写 agentMessages / 视图 loading / agentError / compaction toast）；
// 否则 → 后台态（键控槽照写——后台会话的确认卡/diff 挂起即徽标数据源，切回再现；
// 消息不追——切回 fetch 对账补齐）。会话 run 态存 store 的 `agentRunStates`（不注册
// 项目重置，跨项目切换存活——切回旧项目徽标仍在，design §5.2 自审补）。
// ─────────────────────────────────────────────────────────────────────────────

/** 全局监听订阅面（preload 注入；测试经 window.orisonDesktop mock）。 */
type StreamEventApi = {
  onAgentStreamEvent: (callback: (event: unknown) => void) => () => void;
};

/**
 * 主进程 `agent:stream-event` 载荷：RuntimeEventPayload + sessionId + projectPath（S2 增补）。
 * W3（09-21-subagent-bg-decouple）additive `sessionRole`：onRuntimeEvent 泵路径附带会话角色
 * （'child' = bg 子会话专属通道事件——同步子代理事件冒泡进 leader 流不经此泵）。消费者 W4 接：
 * isProjectRunActive 口径排除（bg 会话不进「项目有活跃 run」）+ 子会话检视图路由。
 */
export type AgentStreamWireEvent = AgentStreamEvent & {
  sessionId?: string;
  projectPath?: string;
  sessionRole?: 'primary' | 'child' | 'fork';
};

export type AgentRunPhase = 'running' | 'idle' | 'error';

/** 单会话 run 态（徽标数据源；跨项目切换存活——不随项目重置清）。 */
export type AgentRunState = {
  sessionId: string;
  phase: AgentRunPhase;
  /** 事件载荷携带的项目路径（projectPath 隔离 + isProjectRunActive 派生用）。 */
  projectPath?: string;
  /** 后台活动摘要（child 事件 `source:role` / 链节点名）——徽标「谁在跑」。 */
  activity?: string;
  /**
   * W4（09-21-subagent-bg-decouple）：会话角色——bg 子会话专属通道事件（wire `sessionRole`
   * = 'child'）登记时写入。isProjectRunActive 口径排除的数据源（bg 子会话不进「项目有活跃
   * run」，输入面/生成闸语义绑 leader——W3 移交项①）。undefined = leader/legacy（照进口径，
   * 零回归）。
   */
  sessionRole?: 'primary' | 'child' | 'fork';
  updatedAt: number;
};

export type AgentRunStatePatch = {
  phase?: AgentRunPhase;
  projectPath?: string;
  activity?: string;
  sessionRole?: 'primary' | 'child' | 'fork';
};

/**
 * CR-09-20-dogfood-1（小残留 b 二次修）：per-session run 终态正向观测——error 事件 →
 * 'error'；UI stop/abort 请求（agentSessionSlice.cancelAgent）→ 'aborted'；done 事件且
 * 无先行 abort/error 标记 → 'ok'（不覆写已置标记——abort 回合的 done 不携 error）；send
 * 重置（键删除 = null）。消费方：AgentMessages 桥警示条结局收敛（settledOk）。
 * 动机：旧判定读视图级 `error === null`——切走切回（switchAgentSession 清 error 而通知
 * 残留）与 abort 回合（done 不写 error）都会误标「本轮已成功收场」。
 */
export type AgentRunOutcome = 'ok' | 'error' | 'aborted';

/**
 * 09-12 子2 fallback chains（design §8②）：一次模型切换的 per-session 通知（cap
 * MODEL_FALLBACK_NOTICE_CAP；每次 send 重置——「本次 run 的切换记录」，随会话 forget 链清）。
 * scopeLabel = 链车道节点标签 / child 面子代理角色；leader 对话车道缺席。
 */
export type ModelFallbackNotice = {
  id: string;
  from: { keyId: string; modelId: string };
  to: { keyId: string; modelId: string };
  reason: string;
  attempt: number;
  at: number;
  scopeLabel?: string;
};

export const MODEL_FALLBACK_NOTICE_CAP = 5;

/**
 * 09-12 子4 W6（design §8）：桥车道运行期通知（bridge-notice 事件的 per-session 记录，
 * cap BRIDGE_NOTICE_CAP；每次 send 重置——「本次 run 的通知」，随会话 forget 链清，
 * mirror ModelFallbackNotice 全套生命周期）。四信号：sendback / sendback-missed /
 * soft-denied（**MCP 主体**软拒 = 预授权缺失诊断入口，AC7）+ builtin-tool-started
 * （R5：模型发起 agy 内置工具调用 = 离开了桥工具族——纯观测相位，不断言该调用失败）
 * + builtin-tool-denied（R6/F13：该内置调用被 headless 权限拦下）。
 */
export type BridgeNoticeKind =
  | 'sendback'
  | 'sendback-missed'
  | 'soft-denied'
  | 'builtin-tool-started'
  | 'builtin-tool-denied';

export type BridgeNotice = {
  id: string;
  notice: BridgeNoticeKind;
  /** `builtin-tool-started` / `builtin-tool-denied`：模型调用的内置工具名（其余信号缺席）。 */
  toolName?: string;
  at: number;
};

export const BRIDGE_NOTICE_CAP = 5;

// ── W4（09-21-subagent-bg-decouple）：后台任务条状态面 ──

/** 后台任务状态（mirror agent 包 BgTaskStatus；aborted = 用户主动取消，UI 标「已取消」）。 */
export type AgentBgTaskStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';

/**
 * 后台任务条单条目（键 = childSessionId——taskId 在 child lane 事件先到、spawn 工具结果/
 * bg-update 未到前未知，child sid 是全生命周期稳定键）。写入方 = 本 dispatcher（child lane
 * 事件 / spawn_agent_bg 工具结果 metadata / bg-update 终态）+ agentSessionSlice.loadAgentBgTasks
 * （`agent:bg-tasks` hydrate——重启后 interrupted 如实呈现）。
 */
export type AgentBgTaskView = {
  taskId: string | null;
  childSessionId: string;
  parentSessionId: string | null;
  role: string;
  projectPath?: string;
  status: AgentBgTaskStatus;
  notify: 'toast' | 'wake' | 'silent';
  digest?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
};

export type AgentBgTaskPatch = Partial<Omit<AgentBgTaskView, 'childSessionId'>> & {
  childSessionId: string;
};

/**
 * 09-12 子5 R6（design §11）：leader 会话上下文窗口占用快照（context-usage 事件的
 * per-session last 值）。usedTokens/windowTokens/redlinePercent 原样透传 agent 侧估算
 * （口径与压缩触发同源——prepareContext loadTokens × 校准比）；windowTokens = null =
 * 注入原值无窗口信息（assignment 未配 limits）——UI 收 null 隐藏条不显示假数。
 */
export type ContextUsageSnapshot = {
  usedTokens: number;
  windowTokens: number | null;
  redlinePercent: number;
  updatedAt: number;
};

/**
 * dispatcher 所需的 store 结构面（appStore 的 AppState 结构满足；结构性类型避免
 * appStore ↔ slice ↔ dispatcher 循环 import）。
 */
export type AgentDispatchState = {
  agentSessionId: string | null;
  agentMessages: AgentMessage[];
  activeSessionRunning: boolean;
  agentError: string | null;
  currentProject: { path?: string } | null;
  agentRunStates: Record<string, AgentRunState>;
  setAgentRunState: (sessionId: string, patch: AgentRunStatePatch) => void;
  /** dogfood T1 Stage 6：链运行态（chainStreamBuffer 写入面）。 */
  chainRunBySession: Record<string, ChainRunState>;
  /**
   * dogfood T1 CR-T1-048（decision 2A「项目级虚拟锚」）：归一 projectPath → 链运行态所属
   * sessionId。dogfood 链车道每 run 新建 stub 会话（≠ 视图会话）——chainRunBySession[stubId]
   * 永不被视图挂载门命中；链通道事件在此登记项目锚，AgentMessages 挂载门兜底查锚。可选——
   * 最小测试 store 可缺省（anchorChainRun 防御性访问）。
   */
  chainRunAnchorByProject?: Record<string, string>;
  /**
   * 09-12 子2 fallback chains（design §8②⑤）：per-session 回退通知（cap 5，send 重置）
   * + 对话车道「当前模型」chip 翻转源（leader 车道 model-fallback 事件的 to 家）。
   * 可选面——最小测试 store 可缺省（缺省 = 通知/chip 不写，事件不炸）。
   */
  modelFallbackNotices?: Record<string, ModelFallbackNotice[]>;
  activeModelBySession?: Record<string, { keyId: string; modelId: string }>;
  /**
   * 09-12 子4 W6（design §8）：per-session 桥运行期通知（写入方本模块 'bridge-notice'
   * case；每次 send 重置 + 随 deleteAgentSession 清，mirror modelFallbackNotices）。
   * 可选面——最小测试 store 可缺省（缺省 = 不写，事件不炸）。
   */
  bridgeNoticesBySession?: Record<string, BridgeNotice[]>;
  /**
   * CR-09-20-dogfood-1：per-session run 终态正向观测（写入方本模块 done/error case +
   * agentSessionSlice.cancelAgent 置 'aborted'；send 重置 + deleteAgentSession 清）。
   * 可选面——最小测试 store 可缺省（缺省 = 不追踪，事件不炸，mirror bridgeNoticesBySession）。
   */
  runOutcomeBySession?: Record<string, AgentRunOutcome>;
  /**
   * 09-12 子5 R6（design §11）：per-session 上下文占用 last 值（写入方本模块
   * 'context-usage' case）。可选面——最小测试 store 可缺省（缺省 = 不写，事件不炸）。
   * 随 deleteAgentSession 清（agentSessionSlice，mirror activeModelBySession）。
   */
  contextUsageBySession?: Record<string, ContextUsageSnapshot>;
  /**
   * 09-13 子3 W2（design §2）：写作页运行时间线（chainTimeline 模块写入——reasoning 节流
   * flush + artifact/tool/done 直写，经本 dispatcher 接线）。可选面——最小测试 store 可缺省
   *（缺省 = 时间线不写，链事件不炸，mirror bridgeNoticesBySession 守卫形态）。
   */
  chainTimelineBySession?: Record<string, ChainTimelineState>;
  /**
   * 09-13 子3 W2（design §2.2/F5）：escalate findings 路由缓存（escalate-pause 不产
   * pausedReview——裁决卡唯一数据源；写入方 = 本 dispatcher 的 metadata.findings 路由 +
   * chapterReviewSlice resume IPC fallback）。可选面同上。
   */
  escalateFindingsBySession?: Record<string, EscalateFindingsEntry>;
  /**
   * W4（09-21-subagent-bg-decouple）：后台任务条（键 = childSessionId）。写入方本 dispatcher
   * （child lane 事件 / spawn_agent_bg 工具结果 metadata / bg-update 终态）+ slice 的
   * loadAgentBgTasks hydrate。可选面——最小测试 store 可缺省（缺省 = 条目不写，事件不炸，
   * mirror bridgeNoticesBySession 守卫形态）。随项目重置 / deleteAgentSession（父或子）清。
   */
  bgTasksByChildSession?: Record<string, AgentBgTaskView>;
  setPendingToolConfirm: (sessionId: string, value: PendingToolConfirm | null) => void;
  pushPendingDiff: (sessionId: string, diff: PendingDiff) => void;
  setPausedReview: (sessionId: string, meta: ChapterReviewMetadata | null) => void;
  setPendingPatch: (sessionId: string, patch: ProjectFieldPatch | null) => void;
  fieldMetadata: Record<string, { version: number } | undefined>;
  /**
   * dogfood R2 #18-B：locale（patchArrived toast 文案——agentEvents 是纯 store 模块不能调
   * useI18n hook，经 translate 非 hook 译者取文案；appStore 组装层由 settingsSlice 恒有值，
   * 最小测试 store 可缺省回退 zh-CN，mirror agentDiffSlice 同款读法）。
   */
  resolvedLocale?: string;
};

export type AgentDispatchStore<S extends AgentDispatchState = AgentDispatchState> = {
  getState: () => S;
  setState: (partial: Partial<S> | ((state: S) => Partial<S>)) => void;
};

// ── 模块级追踪（跨项目切换存活；不进 store 的高频/低价值数据） ──

/** sessionId → projectPath。事件/发送/切换时记录；项目重置按归属过滤键控槽的数据源。 */
const sessionProjectPaths = new Map<string, string>();

/** sessionId → 发送时捕获的 permission mode（后台会话 tool 事件路由的 readonly/auto gate 用）。 */
const sessionModes = new Map<string, AgentMode>();

/**
 * sessionId → delta 活性计数（S3 只驱动 run 态——收到 delta 即「仍在跑」；正文流式
 * 渲染是 S4，计数不进 store，防每 delta 一次 zustand set 打爆渲染，r4/r7 一致结论）。
 */
const sessionDeltaActivity = new Map<string, { count: number; lastAt: number }>();

/**
 * dogfood T1 CR-T1-036：child 组（分组前缀 tag 维度）最近事件时刻——组级「仍在跑」
 * 迟滞数据源。child 多 turn 循环每 turn 间隙（工具执行 / 下一轮首 token 前）streaming
 * 占位被终帧替换翻转，live-only 判定会把「跑完收起」错做成 turn 级（组反复收起 +
 * doneFlash 假完成绿闪 + 徽标打 null）。design §6.4「跑完收起」是**整次派发级**：live
 * 占位在，或 leader run 在途且该组迟滞窗内有事件 → 组仍活跃。仅活跃视图分支记录
 *（徽标/组组件只消费视图会话的组）。键 = childTagPrefix（source:role:depth）。
 */
const childGroupLastEventAt = new Map<string, number>();

/**
 * W4（09-21-subagent-bg-decouple）：分组前缀 tag → childSessionId（组卡钻取入口的映射暴露
 * ——childSessionId 此前只在 dispatcher 占位逻辑里）。**仅缺席写入（CR-12）**：同 tag 双派发
 * 时 last-wins 会把所有组卡钻取都指向最近一次子会话（误钻取）——首派发者占位后不再覆盖。
 * 同步子会话完成后 memory evict 但 jsonl/meta 在盘——钻取视图 fetch 对账照常工作（空流/部分
 * 流，best-effort 面）。键随 __clearAgentEventTracks 清。
 */
const childTagSessionIds = new Map<string, string>();

/** tag → 最近一次派发的 childSessionId（无记录 = 该组尚未收到 child 事件，不显钻取钮）。 */
export function getChildSessionIdForTag(tag: string): string | undefined {
  return childTagSessionIds.get(tag);
}

/**
 * 组级活跃迟滞窗：覆盖 child turn 间隙（工具执行 + 下一轮 generate 首 token 前的
 * 时间-to-first-token）。leader run 终态（done/error）时迟滞即失效（runRunning=false
 * 立即收起），窗口只在「leader 还在跑」时兜 turn 间隙。
 */
export const CHILD_DISPATCH_GRACE_MS = 10_000;

/** 组级「仍在跑」判定（live 占位优先；否则 leader 在途 + 迟滞窗内有事件）。 */
export function isChildGroupDispatchActive(
  tag: string,
  live: boolean,
  leaderRunning: boolean,
  now: number = Date.now(),
): boolean {
  if (live) return true;
  if (!leaderRunning) return false;
  const last = childGroupLastEventAt.get(tag);
  return last !== undefined && now - last < CHILD_DISPATCH_GRACE_MS;
}

/** 迟滞窗剩余毫秒（无记录 = 0）——组件到期定时复核用。 */
export function childGroupGraceRemainingMs(tag: string, now: number = Date.now()): number {
  const last = childGroupLastEventAt.get(tag);
  if (last === undefined) return 0;
  return Math.max(CHILD_DISPATCH_GRACE_MS - (now - last), 0);
}

export function rememberSessionProject(sessionId: string, projectPath: string | undefined | null): void {
  if (!projectPath) return;
  const known = sessionProjectPaths.get(sessionId);
  if (known === undefined) sessionProjectPaths.set(sessionId, projectPath);
  else if (known !== projectPath) sessionProjectPaths.set(sessionId, projectPath);
}

export function getSessionProject(sessionId: string): string | undefined {
  return sessionProjectPaths.get(sessionId);
}

export function rememberSessionMode(sessionId: string, mode: AgentMode | undefined): void {
  if (!mode) return;
  sessionModes.set(sessionId, mode);
}

export function getSessionMode(sessionId: string): AgentMode | undefined {
  return sessionModes.get(sessionId);
}

export function getSessionDeltaActivity(sessionId: string): { count: number; lastAt: number } | undefined {
  return sessionDeltaActivity.get(sessionId);
}

/**
 * dogfood T1 CR-T1-029：已删会话 tombstone——runtime.deleteSession 不 abort 在途 run，
 * 主进程事件还会继续到达；分发器若照常处理会为已删 id 重建 run 态/键控条目（僵尸复活）。
 * 删除成功后登记，handleAgentStreamEvent 顶部整体丢弃（UUID 不复用，无误杀面）。
 */
const deletedSessionIds = new Set<string>();

/** 删除会话成功后登记 tombstone（分发器丢弃该 id 后续事件）。 */
export function rememberDeletedSession(sessionId: string): void {
  deletedSessionIds.add(sessionId);
}

/** tombstone 查询（CR-11：检视返回键 / 回父导航防切进已删会话的死胡同——fetch 会报错）。 */
export function isSessionDeleted(sessionId: string): boolean {
  return deletedSessionIds.has(sessionId);
}

/** dogfood T1 CR-T1-033：会话消亡时修剪模块级追踪 Map（UUID 键纯慢泄漏）。 */
export function forgetSessionTrack(sessionId: string): void {
  sessionProjectPaths.delete(sessionId);
  sessionModes.delete(sessionId);
  sessionDeltaActivity.delete(sessionId);
  deletedSessionIds.add(sessionId);
}

/** 测试 helper：清模块级追踪（sessionProjectPaths / sessionModes / delta 活性 / child 组
 * 活性 / tag→childSessionId / tombstone）。 */
export function __clearAgentEventTracks(): void {
  sessionProjectPaths.clear();
  sessionModes.clear();
  sessionDeltaActivity.clear();
  childGroupLastEventAt.clear();
  childTagSessionIds.clear();
  deletedSessionIds.clear();
}

// ── 徽标状态机（design §5.5 / §7.4；数据链在 S3，完整视觉打磨在 S4/S5） ──

export type SessionBadgeState = 'running' | 'awaiting_confirm' | 'awaiting_review' | 'idle';

/** 徽标派生输入（结构性——组件传 useAppStore 的 state 切片即可）。 */
export type BadgeStateInput = {
  agentRunStates: Record<string, AgentRunState>;
  pendingToolConfirmBySession: Record<string, unknown>;
  pendingDiffsBySession: Record<string, unknown[] | undefined>;
  pendingPatchBySession: Record<string, unknown>;
  pausedReviewBySession: Record<string, unknown>;
};

/**
 * 会话徽标状态机：awaiting_confirm（pendingToolConfirm 键非空）> awaiting_review
 * （pendingPatch / pendingDiffs / pausedReview 任一键非空）> running（run 态 Map）> idle。
 * 挂起优先于 running：confirm_required 到达时 run 活着但在等人——徽标语义是「需要你」。
 */
export function deriveSessionBadge(state: BadgeStateInput, sessionId: string): SessionBadgeState {
  if (state.pendingToolConfirmBySession[sessionId] !== undefined) return 'awaiting_confirm';
  if (
    state.pendingPatchBySession[sessionId] !== undefined
    || (state.pendingDiffsBySession[sessionId]?.length ?? 0) > 0
    || state.pausedReviewBySession[sessionId] !== undefined
  ) return 'awaiting_review';
  if (state.agentRunStates[sessionId]?.phase === 'running') return 'running';
  return 'idle';
}


/**
 * 泛型 S 下「具体字面量 => Partial<S>」不可证（TS 无法排除 S 对属性进一步收窄）——本模块
 * 写面单一收口：partial 按 AgentDispatchState 写（dispatcher 只写这些字段），cast 到 store 的
 * setState（S extends AgentDispatchState 保证运行时安全）。
 */
function writeState<S extends AgentDispatchState>(
  store: AgentDispatchStore<S>,
  partial: Partial<AgentDispatchState> | ((state: AgentDispatchState) => Partial<AgentDispatchState>),
): void {
  (store.setState as unknown as (p: typeof partial) => void)(partial);
}

// ── 全局监听初始化（单例；一次注册永不清退） ──

const initedStores = new WeakSet<object>();

/**
 * 挂 appStore 组装层（appStore.ts，installProjectSubscription 之后）。幂等：同一 store
 * 实例重复调用不产生双订阅（preload scoped-removal 语义下并存 listener = 静默双写，
 * StrictMode 双挂载 / 重复 init 都由 WeakSet 挡住）。
 *
 * dogfood T1 CR-T1-034（HMR，dev-only）：本模块随 appStore import 链失效重执行时，
 * 旧模块实例的 listener **永不清退**（订阅与 app 生命周期同长），而 toastStore 不在失效
 * 链上被新旧实例共享 → compaction 等带 toast 的分支重复弹。解法 = **最新订阅 wins**：
 * 安装前退订上一份（token 挂 window——模块级变量随模块失效丢失，跨失效链只有全局对象稳定；
 * 生产单次 init 行为零变化）。
 */
type WindowWithAgentEventsToken = Window & { __agentEventsUnsubscribe?: () => void };

export function initAgentEvents<S extends AgentDispatchState>(store: AgentDispatchStore<S>): void {
  const api = (typeof window !== 'undefined' ? (window as unknown as { orisonDesktop?: StreamEventApi }).orisonDesktop : undefined);
  if (!api?.onAgentStreamEvent) return;
  if (initedStores.has(store)) return;
  initedStores.add(store);
  const tokenWindow = window as WindowWithAgentEventsToken;
  tokenWindow.__agentEventsUnsubscribe?.(); // HMR：退订旧模块实例的 listener（最新 wins）
  tokenWindow.__agentEventsUnsubscribe = api.onAgentStreamEvent((event) => {
    handleAgentStreamEvent(store, event as AgentStreamWireEvent);
  });
  // 故意不保留 unsubscribe：订阅与 app 生命周期同长（r7「退订生命周期反转」；HMR 面走
  // window token，见上）。
}

// ── 事件分发（活跃视图 / 后台双分支） ──

/**
 * dogfood T1 CR-T1-048（decision 2A「项目级虚拟锚」）：链通道事件（chain-delta /
 * chain-node-done / 哨兵）登记项目锚——dogfood 链车道每 run 新建 stub 会话（≠ 视图会话），
 * chainRunBySession[stubId] 永不被视图挂载门命中（ChainRunCard 结构性不可见）；锚让
 * AgentMessages 在本会话无活跃卡时兜底挂卡。值比对守卫——高频 chain-delta 不产生 store 写
 *（每 run 至多一次锚翻转）；键走 normalizeProjectPathForCompare（跨项目隔离，CR-T1-026 同源）。
 */
function anchorChainRun<S extends AgentDispatchState>(
  store: AgentDispatchStore<S>,
  sid: string,
  projectPath: string | undefined,
): void {
  if (projectPath === undefined) return;
  const key = normalizeProjectPathForCompare(projectPath);
  const anchors = store.getState().chainRunAnchorByProject;
  if (anchors?.[key] === sid) return;
  writeState(store, (s) => ({
    chainRunAnchorByProject: { ...s.chainRunAnchorByProject, [key]: sid },
  }));
}

/**
 * W4（09-21-subagent-bg-decouple）：后台任务条条目 upsert（merge 语义——child lane 事件先到
 * 建 running 条目〔无 taskId〕，spawn 工具结果 metadata / bg-update 依次补全；hydrate 覆盖
 * 盘面权威值）。可选面守卫：store 无该字段（最小测试 store）跳写不炸。
 */
function upsertBgTaskEntry<S extends AgentDispatchState>(
  store: AgentDispatchStore<S>,
  patch: AgentBgTaskPatch,
): void {
  if (store.getState().bgTasksByChildSession === undefined) return;
  const prev = store.getState().bgTasksByChildSession?.[patch.childSessionId];
  // 值等跳写（mirror setAgentRunState 的 delta 频率防护）：bg child lane 事件是 delta 级高频——
  // 每事件 upsert 不变 material 字段时不得产生 store 写（r7「勿每 delta 一次 set」）。updatedAt
  // 不参与判定（running 条目的耗时在渲染侧按 Date.now() 计，不依赖逐事件刷新）。
  if (
    prev
    && (patch.taskId ?? prev.taskId) === prev.taskId
    && (patch.role ?? prev.role) === prev.role
    && (patch.status ?? prev.status) === prev.status
    && (patch.notify ?? prev.notify) === prev.notify
    && (patch.digest ?? prev.digest) === prev.digest
    && (patch.error ?? prev.error) === prev.error
    && (patch.projectPath ?? prev.projectPath) === prev.projectPath
  ) return;
  writeState(store, (s) => {
    const current = s.bgTasksByChildSession?.[patch.childSessionId];
    const now = Date.now();
    const next: AgentBgTaskView = {
      ...patch,
      taskId: patch.taskId ?? current?.taskId ?? null,
      parentSessionId: patch.parentSessionId ?? current?.parentSessionId ?? null,
      role: patch.role ?? current?.role ?? '',
      status: patch.status ?? current?.status ?? 'running',
      notify: patch.notify ?? current?.notify ?? 'toast',
      ...(patch.projectPath !== undefined ? { projectPath: patch.projectPath } : current?.projectPath !== undefined ? { projectPath: current.projectPath } : {}),
      ...(patch.digest !== undefined ? { digest: patch.digest } : current?.digest !== undefined ? { digest: current.digest } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : current?.error !== undefined ? { error: current.error } : {}),
      startedAt: patch.startedAt ?? current?.startedAt ?? now,
      updatedAt: now,
    };
    return { bgTasksByChildSession: { ...(s.bgTasksByChildSession ?? {}), [patch.childSessionId]: next } };
  });
}

/**
 * W4（09-21-subagent-bg-decouple §5）：bg 子会话专属通道事件处理（wire `sessionRole='child'`
 * ——外层 sessionId 即 child 自身 sid，shell 泵附带双键）。
 *
 * - 两分支共通：run 态登记（phase running + sessionRole 'child'——isProjectRunActive 口径
 *   排除的数据源，W3 移交项①）+ 后台任务条 running 条目 upsert + delta 活性计数。
 * - 活跃检视图（用户切进该 child 会话）：inner 事件**原生路由**（mirror leader 分支形态、
 *   无 tag 前缀——child 自身落盘 jsonl 无前缀，实时流与 catch-up fetch 同形，F2/F4「渲染
 *   与订阅零改」的兑现点）。started 占位不建（检视图起点信号由 run 态 activity 承载，
 *   catch-up fetch 补历史——tag 占位会把 child 自身流错装进组卡）。
 */
function handleBgChildLaneEvent<S extends AgentDispatchState>(
  store: AgentDispatchStore<S>,
  event: AgentStreamWireEvent & { type: 'child' },
): void {
  const sid = event.sessionId;
  if (!sid) return; // wire 缺 sessionId（不应发生——handleAgentStreamEvent 顶部同款守卫）
  const { source, role, event: inner } = event.data;
  const state = store.getState();
  const isActiveView =
    sid === state.agentSessionId
    && (event.projectPath === undefined || sameProjectPath(event.projectPath, state.currentProject?.path));

  state.setAgentRunState(sid, {
    phase: 'running',
    sessionRole: 'child',
    activity: `${source}:${role}`,
    ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
  });
  // CR-9：条目必须带项目归属（projectPath 缺席 = 通配所有项目可见）——载荷缺 projectPath 时
  // 回落 store 既有的 session→project 映射；两处皆无则不建条目（防 wildcard 跨项目误现）。
  const entryProjectPath = event.projectPath ?? getSessionProject(sid);
  if (entryProjectPath !== undefined) {
    upsertBgTaskEntry(store, {
      childSessionId: sid,
      role,
      status: 'running',
      projectPath: entryProjectPath,
    });
  }

  if (inner.type === 'delta') {
    // mirror leader delta 分支：活性计数不进 store（徽标「仍在跑」）。
    const prev = sessionDeltaActivity.get(sid);
    sessionDeltaActivity.set(sid, { count: (prev?.count ?? 0) + 1, lastAt: Date.now() });
  }
  if (!isActiveView) return;

  switch (inner.type) {
    case 'assistant':
      // 终帧同 id 整条替换（mirror leader assistant 分支——无 tag 前缀的原生 content）。
      settleStreamPlaceholder(store, sid, {
        id: inner.data.id,
        role: 'assistant',
        content: inner.data.content ?? '',
        toolCalls: inner.data.toolCalls as AgentMessage['toolCalls'],
        ...(inner.data.reasoning !== undefined ? { reasoning: inner.data.reasoning } : {}),
        createdAt: Date.now(),
      });
      return;
    case 'tool':
      // native 路由（origin 缺省——无 `${role} 子代理` 标注；field_patch/审核面路由照常，
      // 键控落 child sid 自己的槽）。
      handleToolEvent(store, sid, true, { type: 'tool', data: inner.data });
      return;
    case 'delta':
      // mirror leader 正文流式轨（首条建占位 + 250ms flush；切走切回 CR-T1-037 重建逻辑复用）。
      bufferStreamDelta(
        store,
        sid,
        inner.data.messageId,
        inner.data.channel,
        inner.data.delta,
        inner.data.toolName,
      );
      return;
    case 'started':
      // 起点信号在检视图由 run 态承载（不建 tag 占位——见函数头注）。
      return;
    case 'model-fallback': {
      // mirror 同步 child 分支：通知面带子代理角色标签（scopeLabel），chip 不翻。
      if (store.getState().modelFallbackNotices === undefined) return;
      const notice: ModelFallbackNotice = {
        id: randomUUID(),
        from: inner.data.from,
        to: inner.data.to,
        reason: inner.data.reason,
        attempt: inner.data.attempt,
        at: Date.now(),
        scopeLabel: role,
      };
      writeState(store, (s) => ({
        modelFallbackNotices: {
          ...(s.modelFallbackNotices ?? {}),
          [sid]: [...(s.modelFallbackNotices?.[sid] ?? []), notice].slice(-MODEL_FALLBACK_NOTICE_CAP),
        },
      }));
      return;
    }
  }
}

/**
 * 单事件分发。导出供测试直接驱动（路由测试不经 preload 订阅面）。
 * 纯同步、无自有异步——对账 fetch 走 fire-and-forget（与旧 send 回调一致）。
 */
export function handleAgentStreamEvent<S extends AgentDispatchState>(store: AgentDispatchStore<S>, event: AgentStreamWireEvent): void {
  const sid = event.sessionId;
  if (!sid) return;
  // CR-T1-029：已删会话的事件整体丢弃（runtime.deleteSession 不 abort 在途 run——不丢则
  // 为已删 id 重建 run 态/键控条目，僵尸复活）。
  if (deletedSessionIds.has(sid)) return;
  if (event.projectPath !== undefined) rememberSessionProject(sid, event.projectPath);

  const state = store.getState();
  const isActiveView =
    sid === state.agentSessionId
    // CR-T1-026：归一比较（分隔符/尾斜杠/盘符大小写漂移不再失配）；事件无 projectPath
    // 维持通配语义。
    && (event.projectPath === undefined || sameProjectPath(event.projectPath, state.currentProject?.path));

  switch (event.type) {
    case 'assistant': {
      if (!isActiveView) return;
      // dogfood T1 Stage 4（design §6.1）：终帧同 id 整条替换占位（streaming:false +
      // 透传 reasoning/kind）——无占位（非流式路径）照旧 append。#27② reasoning 折叠块
      // 数据源；kind 含 aborted_partial（abort 部分落盘终帧，UI 直出跳过动画）。
      settleStreamPlaceholder(store, sid, {
        id: event.data.id,
        role: 'assistant',
        content: event.data.content,
        toolCalls: event.data.toolCalls as AgentMessage['toolCalls'],
        // kind 透传（aborted_partial abort 部分落盘直出；intent_restate 仅旧数据兼容，R2 #16 起不再产生）。
        ...(event.data.kind ? { kind: event.data.kind } : {}),
        // dogfood T1 #27②：透传 reasoning 终帧（UI 折叠块数据源）。
        ...(event.data.reasoning !== undefined ? { reasoning: event.data.reasoning } : {}),
        // Story 3.5：透传批量分组标记（BatchGroup 按契约字段分组，非文本正则）。
        ...(event.data.batchId !== undefined ? { batchId: event.data.batchId } : {}),
        ...(event.data.batchKind !== undefined ? { batchKind: event.data.batchKind } : {}),
        createdAt: Date.now(),
      });
      return;
    }
    case 'tool': {
      handleToolEvent(store, sid, isActiveView, event);
      return;
    }
    case 'confirm_required': {
      // 键控写入（两分支同款）：后台会话的确认卡落自己的键——徽标 awaiting_confirm +
      // 切回再现（r8 坑「后台确认卡漏前台」的解）。
      state.setPendingToolConfirm(sid, event.data);
      if (isActiveView) writeState(store, { activeSessionRunning: false });
      // CR-T1-023：后台分支 run 态补 projectPath——缺省 undefined 通配所有项目（running 条目
      // 跳过后续写入，delta 无法回补）→ isProjectRunActive 全项目误真、生成闸全禁。载荷恒带（S2）。
      else state.setAgentRunState(sid, {
        phase: 'running',
        ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
      });
      return;
    }
    case 'child': {
      const { source, role, depth, sessionId: childSessionId, event: inner } = event.data;
      const tag = childTagPrefix({ source, role, depth });
      // W4（09-21-subagent-bg-decouple §5）：bg 子会话专属通道分流——wire `sessionRole='child'`
      // 的事件经 shell onRuntimeEvent 泵广播，外层 sessionId 即 child 自身 sid（同步冒泡路径
      // 外层 sid 恒为 leader，二者互斥）。检视图活跃时原生路由（无 tag 前缀——child 自身流/
      // 落盘 jsonl 同形，F2 渲染零改），非活跃时只记 run 态（徽标 + 后台任务条 running 条目）。
      if (event.sessionRole === 'child') {
        handleBgChildLaneEvent(store, event);
        return;
      }
      // W4：tag → childSessionId 映射登记（组卡钻取入口数据源；同步路径同样可钻——子会话
      // jsonl/meta 在盘，fetch 对账 best-effort）。仅缺席写入（CR-12）：同 tag 双派发 last-wins
      // 会把全部组卡钻取误指向最近子会话。
      if (!childTagSessionIds.has(tag)) childTagSessionIds.set(tag, childSessionId);
      // dogfood R2 #18-A：child tool 事件复用 leader tool 路由（handleToolEvent）——子代理按
      // 指令调 outline_update 等写工具，shell handler 产的 field_patch envelope（metadata）随
      // child 通道冒泡（makeChildOnMessage 透传完整 toolResults），旧实现只 append 组内消息
      // 不解析 metadata → pendingPatch 永不写、审核卡永不出现（哑弹）。inner.data 形态
      // { id, results } 与顶层 tool 事件 data 同构，直接路由；sid 是外层 leader 会话（child
      // 冒泡目标）——mode gate 取 leader 发送时捕获档、patch 落 pendingPatchBySession[leaderSid]。
      // 放 isActiveView 分流前：后台 leader 会话的子代理 patch 同样落键控槽（切回徽标
      // awaiting_review 再现，mirror 后台 leader tool 事件语义）；消息 append 由 handleToolEvent
      // 内 isActiveView 门统一做。防重：子会话的工具结果只走 child 通道，不与顶层 tool 事件
      // 同 payload 双发。
      if (inner.type === 'tool') {
        handleToolEvent(store, sid, isActiveView, { type: 'tool', data: inner.data }, {
          tag,
          // 来源标注拼进 generatedBy（`${toolId}（${role} 子代理）`——审核卡呈现真实出处）。
          originLabel: `${role} 子代理`,
        });
      }
      if (!isActiveView) {
        // 后台：不进消息（切回 fetch 对账），只更新 run 态活动摘要（徽标「谁在跑」）。
        // CR-T1-023：补 projectPath（同 confirm 分支——undefined 通配所有项目的坑）。
        state.setAgentRunState(sid, {
          phase: 'running',
          activity: `${source}:${role}`,
          ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
        });
        return;
      }
      // CR-T1-036：活跃视图的每个 child 事件（assistant 终帧 / tool / delta）刷新组级
      // 活性迟滞窗（isChildGroupDispatchActive 消费——turn 间隙不误判完成）。
      childGroupLastEventAt.set(tag, Date.now());
      if (inner.type === 'assistant') {
        // dogfood 第二轮 findings #3：首批输出是终帧（非流式车道无 delta）→ 显式废弃 started
        // 占位（起点信号使命完成；settleStreamPlaceholder 不知道 childSessionId，废弃在分发层做）。
        discardChildStartedPlaceholder(store, sid, childSessionId);
        // dogfood T1 Stage 5（design §6.4，D5）：child 终帧同 id 整条替换 delta 占位
        //（mirror leader settleStreamPlaceholder；无占位照旧 append 非流式零回归）。
        // reasoning 为 S5 补齐的 additive 透传（child 占位流式期折叠块终帧后不丢）。
        settleStreamPlaceholder(store, sid, {
          id: inner.data.id,
          role: 'assistant',
          content: `${tag} ${inner.data.content ?? ''}`.trimEnd(),
          toolCalls: inner.data.toolCalls as AgentMessage['toolCalls'],
          ...(inner.data.reasoning !== undefined ? { reasoning: inner.data.reasoning } : {}),
          createdAt: Date.now(),
        });
      } else if (inner.type === 'tool') {
        // dogfood R2 #18-A：已在上方 isActiveView 分流前路由 handleToolEvent（消息 append +
        // field_patch 键控写入统一在那里）——此处不再自己 append，防同事件双条 tool 消息；
        // toolMsg content 携 tag 维持 groupChildTags 分组识别（见 handleToolEvent origin）。
      } else if (inner.type === 'delta') {
        // dogfood T1 Stage 5：child delta 入 per-child 缓冲（childSessionId 维度废弃规则）——
        // 首条建带分组前缀的占位（groupChildTags 识别 → ChildExecutionGroup 组内流式 +
        // 活跃自动展开），250ms flush 更新 content，child 终帧 assistant 同 id 替换。
        bufferChildStreamDelta(
          store,
          sid,
          { childSessionId, source, role, depth },
          inner.data.messageId,
          inner.data.channel,
          inner.data.delta,
          inner.data.toolName,
        );
      } else if (inner.type === 'started') {
        // dogfood 第二轮 findings #3：child runLoop 启动前的起点信号 → 建 started live 占位
        //（派发→首批输出间的组级信号；首批 delta 经废弃规则自动接管）。后台分支已在上方
        // return（run 态 activity 摘要对 started 同样生效），此处仅活跃视图。
        ensureChildStartedPlaceholder(store, sid, { childSessionId, source, role, depth });
      } else if (inner.type === 'model-fallback') {
        // 09-12 子2（design §8②）：子代理循环内的模型切换 → 通知面带子代理角色标签
        //（scopeLabel）——组头部/通知条可见「谁家换了模型」；chip 不翻（对话占位 chip 是
        // leader 车道语义，child 面由通知条承载）。
        if (store.getState().modelFallbackNotices === undefined) return;
        const notice: ModelFallbackNotice = {
          id: randomUUID(),
          from: inner.data.from,
          to: inner.data.to,
          reason: inner.data.reason,
          attempt: inner.data.attempt,
          at: Date.now(),
          scopeLabel: role,
        };
        writeState(store, (s) => ({
          modelFallbackNotices: {
            ...(s.modelFallbackNotices ?? {}),
            [sid]: [...(s.modelFallbackNotices?.[sid] ?? []), notice].slice(-MODEL_FALLBACK_NOTICE_CAP),
          },
        }));
      }
      return;
    }
    case 'delta':
    case 'chain-delta': {
      // dogfood T1 Stage 3：delta 驱动 run 态计数（徽标「仍在跑」）。高频事件不进
      // zustand——计数存模块级 Map，run 态仅在相位翻转时写 store。
      // dogfood T1 Stage 4（design §6.1）：活跃会话的 leader delta（type:'delta'）另入
      // per-session 缓冲——首条建 streaming 占位，250ms flush 更新 content（正文流式
      // 渲染）。chain-delta 是 S6（ChainRunCard），此处仍只计数。
      const prev = sessionDeltaActivity.get(sid);
      sessionDeltaActivity.set(sid, { count: (prev?.count ?? 0) + 1, lastAt: Date.now() });
      if (store.getState().agentRunStates[sid]?.phase !== 'running') {
        store.getState().setAgentRunState(sid, {
          phase: 'running',
          ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
        });
      }
      if (event.type === 'delta') {
        // R2 #30：tool 通道（工具参数流活性）+ toolName 一并透传 buffer（首块标
        // streamingToolName → UI「正在准备工具调用」指示）。
        if (isActiveView) {
          bufferStreamDelta(
            store,
            sid,
            event.data.messageId,
            event.data.channel,
            event.data.delta,
            event.data.toolName,
          );
        }
      } else {
        // dogfood T1 Stage 6（design §4/§6.2）：链 delta 入 (nodeId, seq) 缓冲——250ms flush
        // 写 chainRunBySession[sid].streamText（ChainRunCard 正文区；后台会话照写——卡片只对
        // 视图会话挂载，切回即见实时态）。CR-T1-048：链事件同步登记项目锚（值守卫——高频
        // delta 不产生额外 store 写）。
        anchorChainRun(store, sid, event.projectPath);
        // 09-13 子3 W2（design §2.2）：时间线双写——reasoning 通道喂 chainTimeline pending
        // 缓冲（text 不喂——正文流 streamText 单源）。先于 applyChainDelta：时间线的新 run
        // 边界判定自持 runEnded 记忆（不读 chainRunBySession），此处顺序仅保持「时间线面
        // 先进」的一致接线纪律。
        applyTimelineChainDelta(store, sid, event.data);
        applyChainDelta(store, sid, event.data);
      }
      return;
    }
    case 'model-fallback': {
      // 09-12 子2（design §7/§8②⑤）：模型切换事件。通知面（cap 5）两车道都写；
      // chip 面 = leader 对话车道（无 nodeId）翻 activeModelBySession，链车道
      //（带 nodeId）写链卡 modelSwitch + 项目锚（mirror chain-delta 分支）。
      const data = event.data;
      if (store.getState().agentRunStates[sid]?.phase !== 'running') {
        store.getState().setAgentRunState(sid, {
          phase: 'running',
          ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
        });
      }
      const { nodeId } = data;
      if (nodeId !== undefined) {
        anchorChainRun(store, sid, event.projectPath);
        applyChainModelFallback(store, sid, { ...data, nodeId });
      } else if (store.getState().activeModelBySession !== undefined) {
        writeState(store, (s) => ({
          activeModelBySession: { ...(s.activeModelBySession ?? {}), [sid]: data.to },
        }));
      }
      if (store.getState().modelFallbackNotices === undefined) return;
      const notice: ModelFallbackNotice = {
        id: randomUUID(),
        from: data.from,
        to: data.to,
        reason: data.reason,
        attempt: data.attempt,
        at: Date.now(),
        ...(nodeId !== undefined ? { scopeLabel: chainNodeLabel(nodeId) } : {}),
      };
      writeState(store, (s) => ({
        modelFallbackNotices: {
          ...(s.modelFallbackNotices ?? {}),
          [sid]: [...(s.modelFallbackNotices?.[sid] ?? []), notice].slice(-MODEL_FALLBACK_NOTICE_CAP),
        },
      }));
      return;
    }
    case 'chain-node-done': {
      // CR-T1-048：链事件登记项目锚（同 chain-delta 分支）。
      anchorChainRun(store, sid, event.projectPath);
      // 09-13 子3 W2（design §2.2）：时间线双写——节点 attempt 收口 / 哨兵终态帧（pending
      // 尾巴 force 落 + runEnded 标记）。先于 applyChainNodeDone（时间线边界判定自持记忆，
      // 顺序仅保持接线纪律一致）。
      applyTimelineNodeDone(store, sid, event.data);
      // 哨兵 = run 级终态帧：run 态归位（resume / dogfood 链车道不经 leader streamMessage，
      // 无 done 事件兜底——sentinel 后 phase 'running' 不清会永久占住 isProjectRunActive
      // （生成闸全禁）+ 徽标永久 running）。paused 视作本轮 run 结束（审阅等待由键控槽
      // awaiting_review 承载）；error 归 error 相位（mirror error 事件处理）。
      if (event.data.nodeId === CHAIN_RUN_SENTINEL_NODE_ID) {
        const status = event.data.status;
        // CR-22（W-CR 批）：'auto_revise_pending' 是 09-13 W1a 前的 legacy 哨兵终态值（环收敛 break
        // 交 leader 的中转态）——dev 热重载 / 持久化时间线回放会重放旧帧，落 error 会把健康的复跑
        // 卡错标失败（生产链已不再产该值，此处只是白名单兼容映射）。
        const settle: 'idle' | 'error' =
          status === 'completed' || status === 'paused' || status === 'aborted' || status === 'auto_revise_pending'
            ? 'idle'
            : 'error';
        store.getState().setAgentRunState(sid, {
          phase: settle,
          activity: undefined,
          ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
        });
        applyChainNodeDone(store, sid, event.data);
        return;
      }
      store.getState().setAgentRunState(sid, {
        phase: 'running',
        activity: event.data.nodeId,
        ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
      });
      // dogfood T1 Stage 6：节点步进 / run 级终态帧（哨兵 nodeId）驱动链卡状态机。
      applyChainNodeDone(store, sid, event.data);
      return;
    }
    case 'compaction': {
      // design §5.2 自审补：compaction toast 仅活跃会话弹（后台会话压缩静默——徽标态已可承载）。
      if (!isActiveView) return;
      const { compactedCount } = event.data;
      useToastStore.getState().showToast(
        `上下文已自动压缩，压缩了 ${compactedCount} 条历史消息`,
        'info',
        3000,
      );
      return;
    }
    case 'done': {
      // CR-09-20-dogfood-1：run 终态正向观测——done 且无先行 abort/error 标记 → 'ok'。
      // 不覆写已置标记：abort 回合的 done 不携 error，覆写即把中止误标成功（旧视图级
      // error 读法的失真面之一）。后台会话照写（键控槽，切回可见）；已置标记时零写入。
      if (store.getState().runOutcomeBySession !== undefined) {
        const prev = store.getState().runOutcomeBySession?.[sid];
        if (prev !== 'aborted' && prev !== 'error') {
          writeState(store, (s) => ({
            runOutcomeBySession: { ...(s.runOutcomeBySession ?? {}), [sid]: 'ok' },
          }));
        }
      }
      // dogfood T1 Stage 4（design §6.1 兜底）：清残余流式占位（打回丢弃的废稿等不到终帧）；
      // 移除后与后端消息数出现长度差 → 下方对账 fetch 权威替换。
      purgeSessionStreams(store, sid);
      // ── dogfood R2 #105 假中断根治（2026-08-30）：done 兜底 finalize 前置守卫 ──
      //
      // resume 链事件按同一 leader sessionId 广播、跑在 leader turn 生命周期外（resume IPC 长跑
      // 至下一 checkpoint/终态）——任何 leader turn 在此期间结束（done）不构成「链被掐」证据
      //（服务端从未 abort，台账「中断原因未上日志」即此机理：UI 侧误终态化，服务端无 abort 可
      // 记）。在途判据（跨 slice 结构面读——AgentDispatchState 不含 review 面，最小测试 store
      // 可缺省字段，缺省 = 无在途，兜底照旧）：chapterReviewSlice.reviewResumingBySession[sid] === true
      // 且 pausedReviewBySession[sid] **或 escalateFindingsBySession[sid]** 存在（第二条件 = CR-9：
      // escalate 暂停不产 pausedReview、resume 载荷落 escalate 键——无此腿 escalate 车道的
      // accept/redo flight 窗口会被 leader done 误标 aborted；双条件防 reviewResuming 残值误放行）。
      // 在途 → 不 finalize（不误标 aborted 不删 chainBuffers）也不归位 run 态（链事件持续维持
      // running；终态由哨兵帧 / resume IPC summary 和解定）。
      const resumeProbe = store.getState() as AgentDispatchState & {
        // 09-13 子3 W4（design §5.3/F2）：reviewResuming 单槽 → BySession 键控同批改读（漏改 =
        // #105 假中断回归——他会在途 resume 被本会话 done 误终态化）。
        reviewResumingBySession?: Record<string, boolean | undefined>;
        pausedReviewBySession?: Record<string, unknown>;
        escalateFindingsBySession?: Record<string, unknown>;
      };
      const resumeInFlight =
        resumeProbe.reviewResumingBySession?.[sid] === true
        && (resumeProbe.pausedReviewBySession?.[sid] !== undefined
          || resumeProbe.escalateFindingsBySession?.[sid] !== undefined);
      if (!resumeInFlight) {
        // dogfood T1 Stage 6：链 run 仍 running = 中途被掐（正常完成哨兵帧先到）→ 标「已中断」
        //（abort 半 JSON 不落盘——已流出文本保留在链卡，r1）。
        finalizeChainRun(store, sid, 'aborted');
        // 09-13 子3 W2：时间线同点兜底终态（pending 尾巴落 + runEnded 标记——entries 保留
        // 回看；镜像 finalizeChainRun 的调用位/守卫位）。
        finalizeChainTimeline(store, sid);
        store.getState().setAgentRunState(sid, { phase: 'idle', activity: undefined });
      }
      if (!isActiveView) return;
      writeState(store, { activeSessionRunning: false });
      // stream 结束后与后端对账，补偿可能因 IPC 时序丢失的消息（后台会话不追——
      // 切回时 switchAgentSession 的 fetch 兜底，design §5.4「切回 fetch 对账」）。
      const projectPath = store.getState().currentProject?.path;
      void fetchAgentSession(sid, projectPath).then((session) => {
        if (!session) return;
        const current = store.getState();
        if (current.agentSessionId !== sid) return;
        if (current.currentProject?.path !== projectPath) return;
        if (session.messages.length > current.agentMessages.length) {
          writeState(store, { agentMessages: session.messages });
        }
      });
      return;
    }
    case 'error': {
      // CR-09-20-dogfood-1：run 终态正向观测——error 事件 → 'error'（后台会话照写）。
      if (store.getState().runOutcomeBySession !== undefined) {
        writeState(store, (s) => ({
          runOutcomeBySession: { ...(s.runOutcomeBySession ?? {}), [sid]: 'error' },
        }));
      }
      // dogfood T1 Stage 4：同 done 兜底清残余流式占位/缓冲（错误终态后不再有终帧）。
      purgeSessionStreams(store, sid);
      // dogfood T1 Stage 6：链 run 兜底标失败（哨兵帧未到即流错误）。
      finalizeChainRun(store, sid, 'error');
      // 09-13 子3 W2：时间线同点兜底终态（mirror done 兜底——错误终态后不再有终帧）。
      finalizeChainTimeline(store, sid);
      store.getState().setAgentRunState(sid, { phase: 'error' });
      // 子4 W6（design §4.3）：桥同意拦截——`agy_bridge_consent|state=...` 前缀错误（lane
      // rejected / turn 硬门 CR-27）转知情同意对话框，错误条落人话键（前缀串是机器可读
      // 形态，直出是实现词泄露）。declined 不开对话框——已拒绝是用户的既定选择（AC6：
      // 不再征询，仅留人话错误条）。对话框是机器级面（与视图无关都开——后台会话的征询
      // 同样要答）；agentError 只落活跃视图。
      const consentAsk = parseAgyBridgeConsentError(event.data.message);
      if (consentAsk !== null) {
        if (consentAsk.state !== 'declined') {
          useAgyBridgeStore.getState().openAsk({
            state: consentAsk.state,
            conflicts: consentAsk.conflicts,
          });
        }
        if (!isActiveView) return;
        writeState(store, {
          agentError: consentAsk.state === 'conflict'
            ? 'agent.bridgeConsentConflict'
            : consentAsk.state === 'declined'
              ? 'agent.bridgeConsentDeclined'
              : 'agent.bridgeConsentNeeded',
          activeSessionRunning: false,
        });
        return;
      }
      if (!isActiveView) return;
      writeState(store, { agentError: event.data.message, activeSessionRunning: false });
      return;
    }
    case 'bridge-notice': {
      // 子4 W6（design §8）：桥车道运行期通知（打回 / 二次未调 / 软拒）——运行阶段可见性
      // 纪律：不静默。后台会话照写（键控槽，切回可见，mirror 回退通知）；最小测试 store
      // 缺省字段不炸。R5 起含内置工具步信号、R6 起含内置工具被拒信号（toolName 条件展开
      // ——缺席即不带键，防 undefined 混进渲染面）。
      if (store.getState().bridgeNoticesBySession === undefined) return;
      const notice: BridgeNotice = {
        id: randomUUID(),
        notice: event.data.notice,
        ...(event.data.toolName !== undefined ? { toolName: event.data.toolName } : {}),
        at: Date.now(),
      };
      writeState(store, (s) => ({
        bridgeNoticesBySession: {
          ...(s.bridgeNoticesBySession ?? {}),
          [sid]: [...(s.bridgeNoticesBySession?.[sid] ?? []), notice].slice(-BRIDGE_NOTICE_CAP),
        },
      }));
      return;
    }
    case 'context-usage': {
      // 09-12 子5 R6（design §11）：leader 每步 generate 落定 → per-session last 值刷新
      //（后台会话照写——切回即见当前占用；AgentPanel 按 agentSessionId 选择器消费）。
      // 值等跳过 store 写（每 generate 步一事件，重复渲染零收益）；字段缺席（最小测试
      // store）不写（mirror modelFallbackNotices 守卫——事件不炸）。
      const state0 = store.getState();
      if (state0.contextUsageBySession === undefined) return;
      const { usedTokens, windowTokens, redlinePercent } = event.data;
      const prev = state0.contextUsageBySession[sid];
      if (
        prev
        && prev.usedTokens === usedTokens
        && prev.windowTokens === windowTokens
        && prev.redlinePercent === redlinePercent
      ) return;
      writeState(store, (s) => ({
        contextUsageBySession: {
          ...(s.contextUsageBySession ?? {}),
          [sid]: { usedTokens, windowTokens, redlinePercent, updatedAt: Date.now() },
        },
      }));
      return;
    }
    case 'chain-node-artifact': {
      // 09-13 子3 W2（design §2.2）：节点产出快照（五 kind）——写作页时间线首个消费者
      //（子2 落地时 dispatcher default 忽略；本波接线）。低频直写不经缓冲；attempt 语义
      //（每 attempt 新 entry / 同 attempt 覆写取末帧）在 chainTimeline。项目锚 mirror 既有
      // 链事件机制。
      anchorChainRun(store, sid, event.projectPath);
      applyTimelineArtifact(store, sid, event.data);
      return;
    }
    case 'chain-tool': {
      // 09-13 子3 W2（design §2.2）：链内工具调用（调查层累积）——同上接线形态。
      anchorChainRun(store, sid, event.projectPath);
      applyTimelineTool(store, sid, event.data);
      return;
    }
    case 'bg-update': {
      // W4（09-21-subagent-bg-decouple / W2 §3.1）：后台任务终态事件（taskId 即 dedupeKey，
      // 任务终态恰一次）。外层 sessionId = 派发方 parent sid（载荷自描述）；条目键仍取
      // data.childSessionId（全生命周期稳定键，见 AgentBgTaskView 注）。载荷类型镜像单源
      // = api/agent.ts AgentStreamEvent 'bg-update' 变体（mirror agent 包 types.ts）。
      const data = event.data;
      // CR-10：子会话已删（tombstone）→ 短路不重建条目/不复活 run 态（僵尸卡防复建）。父已删
      // 场景由本函数顶部 tombstone 整体丢弃覆盖（外层 sid 即父）。
      if (deletedSessionIds.has(data.childSessionId)) return;
      upsertBgTaskEntry(store, {
        childSessionId: data.childSessionId,
        taskId: data.taskId,
        role: data.role,
        status: data.status,
        notify: data.notify,
        digest: data.digest,
        // CR-14：startedAt 消费——首知即终态场景（child lane 事件丢失/迟到）耗时显示不塌缩 ~0s。
        startedAt: data.startedAt,
        ...(data.error !== undefined ? { error: data.error } : {}),
        ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
      });
      // 子会话 run 态归位 + 残余占位/缓冲清（检视图 spinner 收 + 打字机轨收敛——bg 子 run
      // 无 leader 式 done/error 事件，终态信号唯一来源即本事件）。
      store.getState().setAgentRunState(data.childSessionId, {
        phase: data.status === 'failed' ? 'error' : 'idle',
        activity: undefined,
        ...(event.projectPath !== undefined ? { projectPath: event.projectPath } : {}),
      });
      purgeSessionStreams(store, data.childSessionId);
      // toast 裁量（W4 item 6）：仅 toast 通道的 completed/failed 出通知——aborted 是用户
      // 主动取消（不打扰）；wake 有唤醒汇报面、silent 只记账（R3 三通道呈现分域）。
      // role 过 roleLabel 译人话（词表外回落原文 id；toolMeta 纯映射无 store 依赖，不成环）。
      if (data.notify === 'toast' && (data.status === 'completed' || data.status === 'failed')) {
        const locale = store.getState().resolvedLocale ?? 'zh-CN';
        useToastStore.getState().showToast(
          translate(
            locale,
            data.status === 'completed' ? 'agent.bgTaskCompletedToast' : 'agent.bgTaskFailedToast',
            { role: roleLabel(data.role, (key) => translate(locale, key)) },
          ),
          data.status === 'failed' ? 'warning' : 'info',
          5000,
        );
      }
      return;
    }
    default:
      return;
  }
}

// ── tool 事件路由（从 agentSessionSlice send 回调整体迁来，按键控改写） ──

type ToolResultShape = {
  toolCallId?: string;
  toolName?: string;
  toolId?: string;
  output?: string;
  metadata?: unknown;
};

/**
 * dogfood R2 #18-A：child tool 事件路由的来源标注——子代理 envelope 进 leader 审核面。
 * tag = child 分组前缀（childTagPrefix 产物）：toolMsg content 携 tag 维持 groupChildTags
 * 对 content 前缀正则的分组识别（mirror settleStreamPlaceholder 的 `${tag} ${content}` 模式，
 * 丢 tag 则子代理 tool 消息掉出 ChildExecutionGroup 组）；originLabel 拼进 generatedBy
 * （审核卡呈现「子代理自己调的写工具」）。leader 路径不传（既有行为零变化）。
 */
type ToolEventOrigin = {
  tag: string;
  originLabel: string;
};

function handleToolEvent<S extends AgentDispatchState>(
  store: AgentDispatchStore<S>,
  sid: string,
  isActiveView: boolean,
  event: AgentStreamWireEvent & { type: 'tool' },
  origin?: ToolEventOrigin,
): void {
  const results = event.data.results as ToolResultShape[];

  // W4（09-21-subagent-bg-decouple）：spawn_agent_bg 工具结果 → 后台任务条 running 条目
  // upsert（taskId/role/notify 权威源——child lane 事件先到时在此补全 taskId/parent）。
  // 与 isActiveView 无关：后台 leader 会话派发的 bg 任务同样入条（键控面，切回再现）。
  for (const result of results) {
    const bgMeta = result.metadata as
      | { taskId?: unknown; childSessionId?: unknown; role?: unknown; status?: unknown; notify?: unknown }
      | undefined;
    if (
      !bgMeta
      || typeof bgMeta.taskId !== 'string'
      || typeof bgMeta.childSessionId !== 'string'
      || bgMeta.status !== 'running'
    ) continue;
    // CR-9：spawn 工具事件先行时常无 projectPath → 回落 store session→project 映射（remember
    // SessionProject 在事件顶部分支已记）；两处皆无则不建 wildcard 条目（跨项目可见 = 误现）。
    const projectPath = event.projectPath ?? getSessionProject(sid);
    if (projectPath === undefined) continue;
    upsertBgTaskEntry(store, {
      childSessionId: bgMeta.childSessionId,
      taskId: bgMeta.taskId,
      ...(typeof bgMeta.role === 'string' ? { role: bgMeta.role } : {}),
      parentSessionId: sid,
      status: 'running',
      notify: bgMeta.notify === 'wake' || bgMeta.notify === 'silent' ? bgMeta.notify : 'toast',
      projectPath,
    });
  }

  // 消息面：仅活跃视图（后台会话消息切回 fetch 对账）。
  if (isActiveView) {
    const toolMsg: AgentMessage = {
      id: event.data.id,
      role: 'tool',
      // dogfood R2 #18-A：child 路由（origin 携 tag）的 tool 消息 content 携分组前缀——
      // groupChildTags 按 content 前缀分组；leader 路径缺省 ''（零变化）。
      content: origin?.tag ?? '',
      toolResults: event.data.results as AgentMessage['toolResults'],
      // Story 3.5：tool 消息同享批量盖章（BatchGroup 折叠组含 tool 消息）。
      ...(event.data.batchId !== undefined ? { batchId: event.data.batchId } : {}),
      ...(event.data.batchKind !== undefined ? { batchKind: event.data.batchKind } : {}),
      createdAt: Date.now(),
    };
    writeState(store, (s) => ({ agentMessages: [...s.agentMessages, toolMsg] }));
  }

  // ── chapter_review 路由（Story 4.3 Step 4）：三模式恒路由（含 readonly——微操模式恰是
  // pause 密度最高，gate 在 readonly 内会丢 review 面板；write_chapter 是 read-class 不被
  // readonly 阻断）。键控落 pausedReviewBySession[sid]。
  for (const result of results) {
    const toolId = result.toolName ?? result.toolId ?? '';
    if (!WRITE_TOOLS.includes(toolId)) continue;
    // 09-13 子3 W2（design §2.2/F5）：escalate findings 松散通道路由——write-chapter.ts 裁决
    // 载荷 metadata.findings {source:'reader-audit'|'plan-review', route, chapterId?, items}
    //（escalate-pause 非 stage pause 不产 chapter_review——findings 只走本通道；resume 车道
    // 走不到时由 chapterReviewSlice 的 IPC summary fallback 补）。三模式恒路由（mirror
    // chapter_review——裁决卡是 read-class 载荷）+ 后台会话照写（键控，切回再现）。条目级
    // 防御投影在 chainTimeline（坏条目单独丢，items 空 = 已审核锚点仍写）。
    const escalateEntry = extractEscalateFindingsFromMetadata(result.metadata);
    if (escalateEntry) setEscalateFindings(store, sid, escalateEntry);
    const reviewMetaRaw = result.metadata as
      | (ChapterReviewMetadata & { type?: string })
      | undefined;
    if (reviewMetaRaw?.type === 'chapter_review') {
      store.getState().setPausedReview(sid, {
        type: 'chapter_review',
        stage: reviewMetaRaw.stage ?? 'draft',
        ...(reviewMetaRaw.chapterId ? { chapterId: reviewMetaRaw.chapterId } : {}),
        ...(reviewMetaRaw.draftContent !== undefined ? { draftContent: reviewMetaRaw.draftContent } : {}),
        ...(reviewMetaRaw.briefContent !== undefined ? { briefContent: reviewMetaRaw.briefContent } : {}),
        // dogfood R2 #83/#84（2026-08-28）：researchSuspension 透传 + resumeOptions 尊重载荷——写前挂起
        //（无草稿）不是 draft review，旧实现两丢（挂起载荷 + ['redo','abort'] 控制信号）把它渲染成带
        // 「继续写」的草稿审阅卡：continue 对挂起非法（无正文可续，workflow belt 强制 redo）且不带偏离
        // 批准 → 用户被引导进「点继续→再核实→再挂起」死循环。缺省回退三钮（旧载荷兼容）。
        ...(reviewMetaRaw.researchSuspension ? { researchSuspension: reviewMetaRaw.researchSuspension } : {}),
        resumeOptions: reviewMetaRaw.resumeOptions && reviewMetaRaw.resumeOptions.length > 0
          ? reviewMetaRaw.resumeOptions
          : ['continue', 'redo', 'abort'],
      });
    } else if (toolId === 'write_chapter') {
      // CR-003：write_chapter 跑完未产 chapter_review（completed/aborted/escalate 非 paused）→ 清 stale
      // pausedReview。否则老 pausedReview 残留：新 write_chapter（full-auto 不产 chapter_review）覆盖
      // chainSnapshot 单槽（keyed by parentSessionId）但不清 pausedReview → 跨章 resume 用老 chapterId
      // 映射错章。只 write_chapter 触发清/设（勿清 outline_update 等非 write_chapter 工具的 review）。
      store.getState().setPausedReview(sid, null);
    }
  }

  // per-session permission mode（发送时捕获；后台会话路由同款 gate——readonly 只读档不建
  // diff/patch，auto 档不建 chapter diff）。缺省 'suggest'（与事件前行为一致的安全档）。
  const mode = getSessionMode(sid) ?? 'suggest';
  if (mode === 'readonly') return;

  // The agent emits ToolCallResult with `toolName`; older shapes used `toolId`.
  // Structured field patches (outline_update / overview_update) accumulate
  // across this result batch, then surface once in the patch-review panel.
  const state = store.getState();
  const fieldPatchEntries: FieldPatchEntry[] = [];
  for (const result of results) {
    const toolId = result.toolName ?? result.toolId ?? '';
    if (!WRITE_TOOLS.includes(toolId)) continue;
    // dogfood R2 #18-A：child 路由（origin 携标注）的 patch 呈现真实出处
    //（`${toolId}（${role} 子代理）`）；leader 路径 origin 缺省原样 toolId（零变化）。
    const generatedBy = origin ? `${toolId}（${origin.originLabel}）` : toolId;

    const meta = result.metadata as
      | {
          type?: string;
          fileName?: string; content?: string; chapterId?: string;
          filePath?: string; replacement?: string; originalText?: string; originalQuote?: string;
          field?: string; action?: string; data?: unknown;
          anchor?: SelectionAnchor;
          previousContent?: string | null; existedBefore?: boolean;
          // Story 6.3 CR-6a：Director 的 info_release_map plan（non-auto mode）与链段
          // pause 的 metadata.type='chapter_review' 共存--两者不能同占 metadata.type，故
          // Director patch 走独立 infoReleasePatch 字段。结构同 field_patch（下文路由）。
          infoReleasePatch?: { type: 'field_patch'; field: string; action: string; data: unknown };
          // Story 5.2：Director 的 emotion_curve 目标弧 plan（non-auto mode，mirror infoReleasePatch）。
          emotionCurvePatch?: { type: 'field_patch'; field: string; action: string; data: unknown };
          // Story 2.5：leader genre_contract_update 工具产的 world_setting patch（与 creative_brief
          // field_patch 共存于同一 metadata，mirror infoReleasePatch/emotionCurvePatch）。
          worldConstitutionPatch?: { type: 'field_patch'; field: string; action: string; data: unknown };
          // Story 2.6：Director 决策登记段 non-auto envelope（write_chapter metadata 子字段，
          // mirror infoReleasePatch/emotionCurvePatch/worldConstitutionPatch）。
          storyDecisionsPatch?: { type: 'field_patch'; field: string; action: string; data: unknown };
          // Story 2.2 WP-E：story-sync 反哺 envelope 组（write_chapter route 终态产，shell
          // storySyncApplyHandler 投影后的 FULL 数据 action:'set'——非 merge fragment，accept 经
          // syncField REPLACE 落盘语义正确）。mirror infoReleasePatch/emotionCurvePatch 子字段模式。
          storySyncPatches?: Array<{ type: 'field_patch'; field: string; action: string; data: unknown; fieldVersion?: number; note?: string }>;
        }
      | undefined;
    if (!meta) continue;

    // Structured field patch (outline / overview / genre_contract_update): route to the
    // patch-review flow instead of applying or building a text diff.
    if (meta.type === 'field_patch' && meta.field) {
      // Story 2.6 CR-4.1-15 收口：field 经 schema 运行时校验（旧 `as` cast 是 type-lie——
      // IPC 边界来的 metadata.field 只是 string，union 由 safeParse 保证）。非法 field 不 push
      // 主 entry，但下方子字段 patch 路由照走（子 patch 是独立 field，不随主 field 生死）。
      const fieldCheck = patchFieldSchema.safeParse(meta.field);
      const action = (meta.action === 'merge' || meta.action === 'delete') ? meta.action : 'set';
      if (fieldCheck.success) {
        const currentVersion = state.fieldMetadata[meta.field]?.version ?? 0;
        fieldPatchEntries.push({
          field: fieldCheck.data,
          action,
          data: meta.data,
          fieldVersion: currentVersion + 1,
          generatedBy,
        });
      }
      // Story 2.5 BMad CR-007：field_patch metadata 上挂的子字段 patch（worldConstitutionPatch /
      // infoReleasePatch / emotionCurvePatch）必须在 continue 前路由——否则静默丢失。
      // 真实情况：这三种子 patch 都可能共占 field_patch metadata——
      //   worldConstitutionPatch：genre_contract_update 恒产（field_patch + 子 world_setting）。
      //   infoReleasePatch / emotionCurvePatch：write_chapter 的 chapter_accept 路径产
      //     （write-chapter.ts，metadata.type='field_patch' + field='chapter_candidate' +
      //      无条件挂 director 的 info/emotion patch）——此组合下 continue 会丢这两个 patch
      //     （pre-existing bug，BMad CR 顺带修；paused 路径 metadata.type='chapter_review' 不进本
      //     分支，走上方独立块，不受影响）。mirror 三者路由模式（field/version/data 同构）。
      if (meta.worldConstitutionPatch) {
        const wsVersion = state.fieldMetadata['world_setting']?.version ?? 0;
        fieldPatchEntries.push({
          field: 'world_setting',
          action: 'set',
          data: meta.worldConstitutionPatch.data,
          fieldVersion: wsVersion + 1,
          generatedBy,
        });
      }
      if (meta.infoReleasePatch) {
        const currentVersion = state.fieldMetadata['info_release_map']?.version ?? 0;
        fieldPatchEntries.push({
          field: 'info_release_map',
          action: 'set',
          data: meta.infoReleasePatch.data,
          fieldVersion: currentVersion + 1,
          generatedBy,
        });
      }
      if (meta.emotionCurvePatch) {
        const currentVersion = state.fieldMetadata['emotion_curve']?.version ?? 0;
        fieldPatchEntries.push({
          field: 'emotion_curve',
          action: 'set',
          data: meta.emotionCurvePatch.data,
          fieldVersion: currentVersion + 1,
          generatedBy,
        });
      }
      // Story 2.2 WP-E：story-sync 反哺 envelope 组路由（chapter_accept field_patch 分支内）。
      // envelope 携带 shell 投影时的下一版本号（diskVersion+1，mirror 下方 currentVersion+1 约定）
      // ——有效数字优先用之，缺省回退 store 当前版本 +1。generatedBy='story-sync-agent' 标真实
      // 出处（write_chapter 只是转出通道）。
      if (meta.storySyncPatches && meta.storySyncPatches.length > 0) {
        for (const env of meta.storySyncPatches) {
          if (!env || typeof env.field !== 'string') continue;
          const currentVersion = state.fieldMetadata[env.field]?.version ?? 0;
          fieldPatchEntries.push({
            field: env.field as FieldPatchEntry['field'],
            action: 'set',
            data: env.data,
            fieldVersion: typeof env.fieldVersion === 'number' ? env.fieldVersion : currentVersion + 1,
            generatedBy: 'story-sync-agent',
          });
        }
      }
      // Story 2.6：Director 决策登记 non-auto envelope 子字段路由（CR-007 continue 前路由防丢，
      // mirror 上方三子字段）。story_decisions 非 creative field 无 fieldMetadata——fieldVersion
      // 恒 0+1（该 patch 走 applyAgentFieldPatch IPC 独立分支持久化，不走 syncField）。
      if (meta.storyDecisionsPatch) {
        fieldPatchEntries.push({
          field: 'story_decisions',
          action: 'set',
          data: meta.storyDecisionsPatch.data,
          fieldVersion: 1,
          generatedBy: 'director-agent',
        });
      }
      continue;
    }

    // Story 6.3 CR-6a / 5.2：infoReleasePatch / emotionCurvePatch 的独立路由块——仅 write_chapter
    // **paused** 路径（metadata.type='chapter_review'，不进上方 field_patch 分支）走到这里。
    // chapter_accept 路径（metadata.type='field_patch'）已在上方分支内路由（BMad CR-007 修 pre-existing
    // continue 丢失 bug）。两路径互补无重复。
    if (meta.infoReleasePatch) {
      const currentVersion = state.fieldMetadata['info_release_map']?.version ?? 0;
      fieldPatchEntries.push({
        field: 'info_release_map',
        action: 'set',
        data: meta.infoReleasePatch.data,
        fieldVersion: currentVersion + 1,
        generatedBy,
      });
    }

    // Story 5.2：Director emotion_curve 目标弧 plan（non-auto mode，mirror infoReleasePatch CR-6a）。
    // 同上：独立块仅 chapter_review paused 路径走；chapter_accept 路径在上方分支内路由。
    if (meta.emotionCurvePatch) {
      const currentVersion = state.fieldMetadata['emotion_curve']?.version ?? 0;
      fieldPatchEntries.push({
        field: 'emotion_curve',
        action: 'set',
        data: meta.emotionCurvePatch.data,
        fieldVersion: currentVersion + 1,
        generatedBy,
      });
    }

    // Story 2.2 WP-E：story-sync 反哺 envelope 组的独立路由块——write_chapter 非 chapter_accept
    // 路径（metadata.type 无 field_patch，如超 cap 强制人审而无候选）走这里；chapter_accept 路径
    // 已在上方分支内路由（mirror infoReleasePatch/emotionCurvePatch 双路由互补模式）。
    if (meta.storySyncPatches && meta.storySyncPatches.length > 0) {
      for (const env of meta.storySyncPatches) {
        if (!env || typeof env.field !== 'string') continue;
        const currentVersion = state.fieldMetadata[env.field]?.version ?? 0;
        fieldPatchEntries.push({
          field: env.field as FieldPatchEntry['field'],
          action: 'set',
          data: env.data,
          fieldVersion: typeof env.fieldVersion === 'number' ? env.fieldVersion : currentVersion + 1,
          generatedBy: 'story-sync-agent',
        });
      }
    }

    // Story 2.6：Director 决策登记段独立路由块——write_chapter 非 chapter_accept 路径
    // （escalate 无候选 / paused 等 metadata.type 非 field_patch）走这里；chapter_accept 路径
    // 已在上方分支内路由（mirror infoReleasePatch/emotionCurvePatch 双路由互补）。
    // leader 工具 story_decisions_update 产的 envelope（meta.type='field_patch' +
    // field='story_decisions'）走上方泛化路由，不经此块。
    if (meta.storyDecisionsPatch) {
      fieldPatchEntries.push({
        field: 'story_decisions',
        action: 'set',
        data: meta.storyDecisionsPatch.data,
        fieldVersion: 1,
        generatedBy: 'director-agent',
      });
    }

    // Story 2.5：worldConstitutionPatch 仅 genre_contract_update 产（恒 field_patch），已在上方
    // field_patch 分支内路由，无独立块。

    // Passage-level rewrite: never auto-apply blindly; build a passage diff.
    if (meta.type === 'passage') {
      const sourceType: 'chapter' | 'file' = meta.chapterId ? 'chapter' : 'file';
      const originalText = meta.originalText ?? meta.originalQuote ?? meta.anchor?.quote ?? '';
      if (!originalText || meta.replacement == null) continue;
      // Backfill the anchor from the sent selection when the runtime omits it,
      // so passage relocation can disambiguate duplicate matches. 仅视图会话可靠
      // （agentMessages 是视图消息；后台会话消息不在 store——锚回补留到切回后 accept 时
      // 的 agentDiffSlice 兜底路径）。
      const anchor = isActiveView
        ? (meta.anchor ?? recoverSelectionAnchorFromMessages(store.getState().agentMessages, originalText, meta.chapterId, meta.filePath))
        : meta.anchor;
      store.getState().pushPendingDiff(sid, {
        kind: 'passage',
        id: randomUUID(),
        toolId,
        sourceType,
        chapterId: meta.chapterId,
        filePath: meta.filePath,
        originalText,
        replacement: meta.replacement!,
        anchor,
      });
      continue;
    }

    // Whole-chapter rewrite.
    if (meta.content) {
      if (mode !== 'auto') {
        store.getState().pushPendingDiff(sid, {
          kind: 'chapter',
          id: randomUUID(),
          toolId,
          toolCallId: result.toolCallId,
          fileName: meta.fileName ?? 'unknown',
          content: meta.content!,
          chapterId: meta.chapterId,
          // Snapshot for suggest-mode reject (tool already wrote to disk).
          previousContent: meta.previousContent,
          existedBefore: meta.existedBefore,
          filePath: meta.filePath,
        });
      }
      // In auto mode the tool already wrote to disk at execution time;
      // the file watcher reconciles any open .md tab, so there is no
      // in-memory chapter view to keep in sync here.
    }
  }

  // Surface accumulated structured patches for review. Merge with any
  // pending patch from a prior batch in this run so none are dropped.
  // dogfood T1 Stage 3：键控落 pendingPatchBySession[sid]（runId=会话 id，同 run merge
  // 语义 CR-013 不变——merge 按 runId 自然 per-session 隔离）。
  if (fieldPatchEntries.length > 0) {
    store.getState().setPendingPatch(sid, {
      runId: sid,
      createdAt: new Date().toISOString(),
      patches: fieldPatchEntries,
    });
    // dogfood R2 #18-B：审核卡到达可见性——静止小卡会被活跃大区淹没（#18② 实录：
    // outline_update 审核卡已写入渲染，隔 8 分钟子代理长跑，用户感知「快结束才弹」）。
    // 写入成功 + 活跃视图时 toast 一条 3s info；后台会话不弹（切回时徽标 awaiting_review
    // 承载）。纯 store 模块不能调 useI18n hook——translate 非 hook 译者（openWriting.ts 同款）。
    if (isActiveView) {
      useToastStore.getState().showToast(
        translate(store.getState().resolvedLocale ?? 'zh-CN', 'agent.patchArrived'),
        'info',
        3000,
      );
    }
  }
}
