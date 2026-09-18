import type { StateCreator } from 'zustand';
import type {
  BalancedAskCategory,
  ImageAttachment,
  ModelConfig,
  ParticipationGear,
} from '@orison/shared-contracts';
import {
  BALANCED_ASK_CATEGORIES_DEFAULT,
  PARTICIPATION_GEAR_DEFAULT,
  TRUST_ADJUDICATION_DEFAULT,
} from '@orison/shared-contracts';
import type { AgentMode, AgentBehaviorMode } from './types';
import type { ChainRunState } from './chainStreamBuffer';
import type { Attachment, FileAttachment } from '../types/attachment';
import {
  createAgentSession,
  fetchAgentSession,
  setAgentSessionMode,
  setAgentSessionBehaviorMode,
  setAgentSessionParticipationGear,
  deleteAgentSession as deleteSession,
  truncateAgentSession as truncateSession,
  type TruncateSessionResult,
  listAgentSessions,
  streamAgentMessage,
  type AgentMessage,
  type AgentSessionMeta,
} from '../api/agent';
import {
  classifyImportRejections,
  dialogueModelRefFromConfig,
  generateAttachmentDescription,
  importFilesToInbox,
  NON_UTF8_ATTACHMENT_ADVISORY,
  pathForUploadFile,
  readInboxMaterialText,
  resolveInboxAttachment,
  shouldSkipAttachmentDescription,
  storeAttachmentDescription,
} from '../api/inboxAttachments';
import {
  compressChatImage,
  imageFileStem,
  saveChatImage,
  sha256Hex,
  type ChatImageCompressResult,
} from '../api/chatImages';
import type { ResolveInboxAttachmentResult } from '@orison/shared-contracts';
import { randomUUID } from '../util/id';
import { registerProjectReset } from './resetRegistry';
import { storage } from './storage';
import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';
import {
  rememberSessionMode,
  rememberSessionProject,
  forgetSessionTrack,
  getSessionProject,
  type AgentRunState,
  type AgentRunStatePatch,
  type ModelFallbackNotice,
  type BridgeNotice,
  type ContextUsageSnapshot,
} from './agentEvents';
import { forgetSessionStreams } from './agentStreamBuffer';
import { forgetChainRunBuffer } from './chainStreamBuffer';
// 09-13 子3 W2：写作页运行时间线 + escalate findings 路由缓存（chainTimeline 模块持写入面，
// 本 slice 只持字段 + 清理钩）。
import { forgetChainTimeline, type ChainTimelineState, type EscalateFindingsEntry } from './chainTimeline';
import { sameProjectPath, showRunBusyToast } from './projectRunBusy';

const AGENT_MODE_KEY = 'agentMode';
const VALID_MODES: AgentMode[] = ['readonly', 'suggest', 'auto'];
function readPersistedMode(): AgentMode {
  const v = storage.getString(AGENT_MODE_KEY, 'suggest') as AgentMode;
  return VALID_MODES.includes(v) ? v : 'suggest';
}

// Story 3.1: leader behavior mode persistence (normal/discuss/plan). Orthogonal
// to the permission mode above — persisted independently so the two axes don't
// clobber each other. Default 'normal' (execute directly).
const AGENT_BEHAVIOR_KEY = 'agentBehaviorMode';
const VALID_BEHAVIORS: AgentBehaviorMode[] = ['normal', 'discuss', 'plan'];
function readPersistedBehavior(): AgentBehaviorMode {
  const v = storage.getString(AGENT_BEHAVIOR_KEY, 'normal') as AgentBehaviorMode;
  return VALID_BEHAVIORS.includes(v) ? v : 'normal';
}

// Story 3.5: participation gear persistence (smart/steer/balanced/hands_off) —
// the third orthogonal axis (gear = what/when to ask; permissionMode = tool
// execution rights; behaviorMode = per-turn style). Mirrors the behavior-mode
// persistence pattern exactly. The balanced ask-categories / hands_off trust
// toggle are gear-scoped preferences materialized to their contract defaults
// (all three categories / false) so the UI never deals in undefined.
const AGENT_GEAR_KEY = 'agentParticipationGear';
const VALID_GEARS: ParticipationGear[] = ['smart', 'steer', 'balanced', 'hands_off'];
function readPersistedGear(): ParticipationGear {
  const v = storage.getString(AGENT_GEAR_KEY, PARTICIPATION_GEAR_DEFAULT) as ParticipationGear;
  return VALID_GEARS.includes(v) ? v : PARTICIPATION_GEAR_DEFAULT;
}

const AGENT_GEAR_CATEGORIES_KEY = 'agentBalancedAskCategories';
function readPersistedGearCategories(): BalancedAskCategory[] {
  const v = storage.get<BalancedAskCategory[]>(AGENT_GEAR_CATEGORIES_KEY, BALANCED_ASK_CATEGORIES_DEFAULT);
  return Array.isArray(v) && v.every((c) => BALANCED_ASK_CATEGORIES_DEFAULT.includes(c))
    ? v
    : BALANCED_ASK_CATEGORIES_DEFAULT;
}

const AGENT_TRUST_KEY = 'agentTrustAdjudication';
function readPersistedTrust(): boolean {
  return storage.get<boolean>(AGENT_TRUST_KEY, TRUST_ADJUDICATION_DEFAULT) === true;
}

/**
 * Options that differ from the contract defaults → the value to sync to the
 * backend session; undefined = still default, skip the IPC payload (create-session
 * only carries the gear itself). Exported for tests.
 */
export function gearOptionsIfChanged(
  categories: BalancedAskCategory[],
  trustAdjudication: boolean,
  explicitSync = false,
): { balancedAskCategories: BalancedAskCategory[]; trustAdjudication: boolean } | undefined {
  const categoriesAreDefault =
    categories.length === BALANCED_ASK_CATEGORIES_DEFAULT.length &&
    BALANCED_ASK_CATEGORIES_DEFAULT.every((c) => categories.includes(c));
  const isDefault = categoriesAreDefault && trustAdjudication === TRUST_ADJUDICATION_DEFAULT;
  // CR-009：显式同步过的 session 即便改回默认也始终发送 options（后端 additive setter 无法
  // 区分「默认未设」与「显式默认」，不发 -> 陈旧窄化值残留撤销用户操作）。
  if (isDefault && !explicitSync) return undefined;
  return { balancedAskCategories: categories, trustAdjudication };
}

export type { AgentMessage, AgentSessionMeta };

/**
 * 09-01 A3（inbox 附件上传）：上传/解析 chip 状态机相位（design §1.2 D-I）。
 * uploading（importFiles 拷入中）→ parsing（resolve 预解析/哈希中）→ ready（挂载完成，
 * 键迁移为附件 id=derivedPath）| error（扫描件/解析失败——指引 + 可移除，原件保留 inbox/）。
 */
export type AttachmentUploadPhase = 'uploading' | 'parsing' | 'ready' | 'error';

/**
 * attachmentUploadStates 的条目（在途态携带 label 供 chip 渲染——附件对象尚未存在）。
 * 09-01 B4（B 波图片线）additive：`variant:'image'` 条目走图片专用文案 + 缩略图直显
 * （thumbDataUrl = 压缩后 dataUrl，进件即显、ready 迁移保留）；errorKind 扩图片三档
 * （非白名单 / 压不动超限 / 解码失败）。
 */
export type InboxUploadEntry = {
  state: AttachmentUploadPhase;
  /** chip 显示名（上传原文件名 / inbox 材料段点选的文件名）。 */
  label: string;
  /**
   * error 细分：scanned 扫描件 PDF（指引文案不同，AC3）；B4 图片三档见
   * ChatImageCompressResult；CR-018 importFiles 拒收三档（扩展名 / 超 50MB / 超单批）。
   */
  errorKind?: 'scanned' | 'not-image' | 'too-large' | 'decode-failed'
    | 'rejected-format' | 'rejected-size' | 'rejected-batch';
  /** B4：image 线条目标记（chip 分流渲染——缩略图 + 图专用状态/拒收文案）。 */
  variant?: 'image';
  /** B4：压缩后 dataUrl（chip 缩略图直显；压缩完成即挂、ready 迁移保留，随发送整体清场）。 */
  thumbDataUrl?: string;
  /**
   * CR-010②：resolve 解析备注首项（非 UTF-8 转换提示 / 端点降级备注等）——ready 条目
   * 迁移携带，chip tooltip 消费（用户侧提示面；模型侧走 preview 的机器提示文案）。
   */
  note?: string;
};

export type AgentSessionSlice = {
  agentMode: AgentMode;
  setAgentMode: (mode: AgentMode) => void;
  /** Story 3.1: leader behavior mode (normal/discuss/plan), orthogonal to agentMode. */
  agentBehaviorMode: AgentBehaviorMode;
  setAgentBehaviorMode: (mode: AgentBehaviorMode) => void;
  /**
   * Story 3.5: participation gear (smart/steer/balanced/hands_off) + its two
   * gear-scoped options — orthogonal to agentMode (execution rights) and
   * agentBehaviorMode (per-turn style).
   */
  agentParticipationGear: ParticipationGear;
  agentBalancedAskCategories: BalancedAskCategory[];
  agentTrustAdjudication: boolean;
  setAgentParticipationGear: (
    gear: ParticipationGear,
    options?: { balancedAskCategories?: BalancedAskCategory[]; trustAdjudication?: boolean },
  ) => void;

  agentSessionId: string | null;
  agentMessages: AgentMessage[];
  /**
   * dogfood R2 #11（findings #11⑤，2026-08-25）：跨组件直出信号——直出钮从消息正文
   * 底部挪到输入行（AgentInput），经此单调递增 tick 通知正在流式的 AgentMessageItem
   * 拉满 displayLen + 头部快照（CR-T1-043 reveal 语义的搬家版）。消费方 effect 跳过
   * 初始值（挂载不误触发）；瞬态信号不随项目/会话重置（tick 语义只看增量）。
   */
  streamRevealTick: number;
  /** 直出请求：tick +1（AgentInput 输入行直出钮 onClick）。 */
  requestStreamReveal: () => void;
  /**
   * dogfood T1 Stage 3（design §5.3 / r8）：agentLoading 语义三分——本字段是
   * **视图运行态**（isActiveSessionRunning：当前视图会话的 run 在途；AgentInput 发送/停止
   * 钮、档位禁用、intent 按钮门、StatusBar 等视图语义读它）。
   * - 「该项目任一会话在运行」（生成闸/accept 闸）→ `isProjectRunActive` 选择器（agentRunStates 派生）。
   * - 「切换加载中」→ `sessionSwitching`（switchAgentSession fetch 期间，独立视觉态）。
   */
  activeSessionRunning: boolean;
  /** 切换会话加载中（独立于运行态——switchAgentSession fetch 期间的输入禁用/视觉态）。 */
  sessionSwitching: boolean;
  agentError: string | null;
  /**
   * 返回是否**已派发**本轮消息（CR-012，08-28 风格卡 BMad CR）：false = 早退未发
   * （无当前项目 / 视图 run 在途 / 同项目他 run 占用 / 会话创建失败 / 途切项目）——
   * 调用方据此可保草稿重开输入面，而非静默丢消息。true 只表示 invoke 已发出
   * （终态失败经既有 error/runState 面呈现，与本返回值无关）。
   */
  sendAgentMessage: (content: string) => Promise<boolean>;
  /**
   * 从此截断（dogfood 2026-08-21）：丢弃该条及其后全部消息（UI 态 + runtime 内存 +
   * JSONL/索引一致）。纯对话尾巴专用——UI 侧先做同款闸门（按钮只对纯对话尾巴出现），
   * runtime 侧二次把关（not-found/running/tool-activity → 拒绝且 UI 态不动）。
   */
  truncateAgentMessages: (messageId: string) => Promise<TruncateSessionResult>;
  cancelAgent: () => void;
  newAgentSession: () => Promise<void>;
  /** Reset all agent conversation state when the active project changes. */
  resetAgentForProjectSwitch: () => void;

  /**
   * dogfood T1 Stage 3（design §5.2）：per-session run 态（徽标 running 数据源 +
   * isProjectRunActive 派生源）。**不注册项目重置**——跨项目切换存活（切回旧项目徽标
   * 仍在，design §5.2 自审补）；事件驱动（agentEvents dispatcher 写入）。
   */
  agentRunStates: Record<string, AgentRunState>;
  setAgentRunState: (sessionId: string, patch: AgentRunStatePatch) => void;
  clearAgentRunState: (sessionId: string) => void;

  /**
   * dogfood T1 Stage 6（design §4 / §7.5）：per-session 写章链运行态（ChainRunCard 数据源）。
   * 写入方 = chainStreamBuffer（chain-delta 节流 flush + chain-node-done 步进；模块级缓冲
   * 不进 store 的部分见该文件）。**不注册项目重置**——session 维度态跨项目切换存活
   *（mirror agentRunStates；卡片只对当前视图会话挂载，旧条目无渲染面）。
   */
  chainRunBySession: Record<string, ChainRunState>;

  /**
   * dogfood T1 CR-T1-048（decision 2A「项目级虚拟锚」）：归一 projectPath → 链运行态所属
   * sessionId。dogfood 链车道每 run 新建 stub 会话（≠ 视图会话）——chainRunBySession[stubId]
   * 永不被 AgentMessages 挂载门命中（链卡结构性不可见）；链通道事件经 agentEvents
   * anchorChainRun 在此登记，挂载门在本会话无活跃卡时查锚兜底。**不注册项目重置**（mirror
   * chainRunBySession——挂起/终态卡跨项目存活，切回再现）；deleteAgentSession 清指向该
   * 会话的锚（防悬空）。
   */
  chainRunAnchorByProject: Record<string, string>;

  /**
   * 09-13 子3 W2（design §2.1）：写作页运行时间线（写入方 chainTimeline 模块——reasoning
   * 节流 flush + artifact/tool/done 直写，经 agentEvents dispatcher 接线；此 slice 只持字段）。
   * **不注册项目重置**（mirror chainRunBySession——session 维度 run 态跨项目切换存活，切回
   * 回看；渲染面按 sessionId 键控隔离）；随 deleteAgentSession 清（forgetChainTimeline 同点
   * + 本键删除）。
   */
  chainTimelineBySession: Record<string, ChainTimelineState>;

  /**
   * 09-13 子3 W2（design §2.2/F5）：escalate findings 路由缓存（escalate-pause 不产
   * pausedReview——写作页裁决卡唯一数据源；写入方 agentEvents metadata.findings 路由 +
   * chapterReviewSlice resume IPC fallback）。**项目重置按 owner 归属保留**（mirror
   * pausedReview——挂起态按定义不再产事件，销毁即永久丢）：有归属键跨项目存活，仅清无归属
   * 残键；随 deleteAgentSession 清。
   */
  escalateFindingsBySession: Record<string, EscalateFindingsEntry>;

  /**
   * 09-12 子2 fallback chains（design §8②⑤）：per-session 回退通知（cap 5；写入方
   * agentEvents 'model-fallback' / child 冒泡分支）+ 对话车道「当前模型」chip 翻转源
   *（activeModelBySession——leader 车道切换事件的 to 家）。通知每次 send 重置（本次
   * run 的切换记录）；两图随 deleteAgentSession 清。**不注册项目重置**（mirror
   * agentRunStates——session 维度态跨项目切换存活）。
   */
  modelFallbackNotices: Record<string, ModelFallbackNotice[]>;
  activeModelBySession: Record<string, { keyId: string; modelId: string }>;

  /**
   * 09-12 子4 W6（design §8）：per-session 桥运行期通知（bridge-notice 事件面；写入方
   * agentEvents 'bridge-notice' case，此 slice 只持字段）。每次 send 重置（本次 run 的
   * 通知）+ 随 deleteAgentSession 清（mirror modelFallbackNotices）；**不注册项目重置**
   * （session 维度态跨项目切换存活，同族）。
   */
  bridgeNoticesBySession: Record<string, BridgeNotice[]>;

  /**
   * 09-12 子5 R6（design §11）：per-session leader 上下文占用 last 值（写入方
   * agentEvents 'context-usage' case，此 slice 只持字段）。会话重载后无事件 → 条隐藏
   *（MVP：首条消息后出现）；windowTokens null = 无窗口信息（AgentPanel 隐藏条）。
   * 每次 sendAgentMessage 重置（CR-14——mirror 回退通知重置位：新 run 的首帧未到前
   * 不显示上轮余量 stale bar）+ 随 deleteAgentSession 清（mirror activeModelBySession）；
   * **不注册项目重置**（session 维度态跨项目切换存活，同 agentRunStates 族）。
   */
  contextUsageBySession: Record<string, ContextUsageSnapshot>;

  pendingAttachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;

  /**
   * 09-01 A3（inbox 附件上传，design D-I / 复查 M3）：上传/解析 chip 状态机。进
   * store 独立字段而非组件本地态——AgentPanel 不随项目切换卸载，组件态会跨项目
   * 残留转圈。在途键 = `upload-<uuid>` 临时 id；挂载成功后条目迁移为 ready（键 =
   * 附件 id=derivedPath）。`newAgentSession` / `resetAgentForProjectSwitch` /
   * 发送消费三处同步清；所有异步完成回调带 isCurrentProject 守卫。
   */
  attachmentUploadStates: Record<string, InboxUploadEntry>;
  /** 上传入口（隐藏 file input onchange）：拷入 inbox/ → 逐文件 resolve 挂载。 */
  uploadInboxFiles: (files: File[]) => Promise<void>;
  /**
   * 09-01 B4（R2.1/R2.2 / dogfood #45）：chat 图片三入口统一 action（选择器按钮 / 剪贴板
   * 粘贴 / AgentPanel drop zone 三入口共用）。逐图 canvas 预检压缩 → `inbox/images/` 落盘
   * （notify=true）→ 挂 `ImageAttachment`（指针 + b64hash，形态与 shell B3 逐字对齐）。
   */
  uploadChatImages: (files: File[]) => Promise<void>;
  /** attach 菜单「inbox 材料」段入口（R1.8）：项目内已存在材料直接 resolve 挂载。 */
  attachInboxMaterial: (relPath: string, displayName: string) => Promise<void>;
  /** 移除上传 chip（在途移除 = 完成回调弃挂；error 态移除 = 清指引）。 */
  removeAttachmentUpload: (uploadId: string) => void;

  agentSessions: AgentSessionMeta[];
  /**
   * dogfood R2 #14（2026-08-25）：「新会话」草稿视图标记——newAgentSession 置 true（懒建
   * 语义不变：会话在首条消息才真建），历史列表据此在顶部渲染草稿行（当前视图即新会话，
   * 发送首条消息后由真条目接替——sendAgentSession 建会话时清标记 + 刷新列表）。切会话/
   * 切项目清（显式用户意图标记，不随派生状态闪烁）。
   */
  draftSession: boolean;
  loadAgentSessions: () => Promise<void>;
  /**
   * CR-37③：`opts.autoResume = true` 标记本次切换来自项目重开自动接续——fetch 失败（latest
   * 会话损坏 / 断连）时静默回落空白视图（清 agentError，视同无会话），不打错误横幅；手动
   * 切换（缺省）照旧报错。additive optional，既有单参调用零变。
   */
  switchAgentSession: (sessionId: string, opts?: { autoResume?: boolean }) => Promise<void>;
  deleteAgentSession: (sessionId: string) => Promise<void>;
};

type Deps = AgentSessionSlice & {
  currentProject: { path?: string } | null;
  activeChapterId: string | null;
  resolvedLocale?: string;
  /** 跨 slice 清理面（cancelAgent / deleteAgentSession 清对应会话的键控挂起卡）。 */
  clearSessionPending: (sessionId: string) => void;
  clearPausedReviewFor: (sessionId: string) => void;
  clearPendingPatchFor: (sessionId: string) => void;
  /** 09-13 子3 W4：五审阅本地态键（reviewResuming/selection/intent 族）随会话消亡清理。 */
  clearReviewLocalStateFor: (sessionId: string) => void;
};

/**
 * r8 设计要点 2：「该项目任一会话在运行」选择器——NovelWorkbench / ChapterListPanel
 * 生成闸、ReviewFindingsCard 等 accept 闸消费（「有 run 在途勿动」语义）。
 */
export function isProjectRunActive(
  s: { agentRunStates: Record<string, AgentRunState>; currentProject: { path?: string } | null },
): boolean {
  const projectPath = s.currentProject?.path;
  return Object.values(s.agentRunStates).some(
    // CR-T1-026：归一比较（分隔符/尾斜杠/盘符大小写漂移不再漏判/误判）。
    (r) => r.phase === 'running' && (r.projectPath === undefined || sameProjectPath(r.projectPath, projectPath)),
  );
}

export const createAgentSessionSlice: StateCreator<Deps, [], [], AgentSessionSlice> = (set, get) => {
  const initialMode = readPersistedMode();
  const initialBehavior = readPersistedBehavior();
  const initialGear = readPersistedGear();
  const initialGearCategories = readPersistedGearCategories();
  const initialTrust = readPersistedTrust();
  let projectEpoch = 0;
  let sessionListToken = 0;
  let sessionSwitchToken = 0;
  // CR-37②（dogfood R2 BMad CR）：自动接续竞争 token——显式用户动作（sendAgentMessage /
  // newAgentSession / switchAgentSession）入口 bump；自动接续 IIFE 与 switchAgentSession 完成帧
  // 持捕获值比对，不等即弃权（在途 send 的建会话/显式「新会话」草稿不被旧接管帧踹掉）。
  let autoResumeToken = 0;
  // CR-37④：loadAgentSessions 并发去重——自动接续 load 与历史面板 load 双拉共享同一 in-flight
  // fetch（仅当在途 fetch 仍是当前 token——无 reset 插队——时共享）。
  let sessionListInFlight: { promise: Promise<void>; token: number } | null = null;
  let modeSwitchToken = 0;
  let confirmedMode = initialMode;
  let confirmedModeSessionId: string | null = null;
  // Story 3.1: behavior-mode switch tracking — mirrors mode-switch (own token so
  // a permission-mode rollback doesn't clobber a behavior-mode switch and vice
  // versa). confirmedBehavior is the last value the backend acknowledged.
  let behaviorSwitchToken = 0;
  let confirmedBehavior = initialBehavior;
  let confirmedBehaviorSessionId: string | null = null;
  // Story 3.5: gear switch tracking — mirrors behavior-mode switching (own token
  // + confirmed triple so rollbacks restore the whole gear config, not just the
  // enum). confirmedGear* is the last config the backend acknowledged.
  let gearSwitchToken = 0;
  let confirmedGear = initialGear;
  let confirmedGearCategories = initialGearCategories;
  let confirmedGearTrust = initialTrust;
  let confirmedGearSessionId: string | null = null;
  // CR-009：一旦某 session 显式同步过非默认 options（balancedAskCategories 或 trustAdjudication
  // 偏离默认），后续即便改回默认也**始终显式发送 options**（后端无法区分「默认未设」与「显式默认」，
  // 不发 -> 陈旧的窄化值残留撤销用户操作）。flag 按 session 跟踪（newAgentSession / 切项目重置）。
  let gearOptionsExplicitSync = false;
  // CR-009：创建期补投 options 失败（{ok:false} 被吞）-> 保留待下次 setAgentParticipationGear 或
  // session load 时重试一次的载荷。null = 无待重试。
  let pendingGearOptionsRetry: { sessionId: string; gear: ParticipationGear; categories: BalancedAskCategory[]; trust: boolean } | null = null;
  let modeSwitchQueue: Promise<void> = Promise.resolve();
  let behaviorSwitchQueue: Promise<void> = Promise.resolve();
  let gearSwitchQueue: Promise<void> = Promise.resolve();

  const isCurrentProjectScope = (epoch: number, projectPath: string | undefined) => (
    projectEpoch === epoch && get().currentProject?.path === projectPath
  );

  /**
   * D4 同项目单 run 闸的 UI 通知（dogfood T1 CR-T1-030：链租约占用者换文案不提供跳转钮——
   * stub 会话不在会话列表，跳转必失败；文案/跳转逻辑单源 projectRunBusy.showRunBusyToast）。
   * 本地预检（agentRunStates）与 shell 结构化拒绝（projectActiveRuns）共用本出口。
   */
  const notifyProjectRunBusy = (heldBySessionId: string | undefined, projectPath: string | undefined): void => {
    const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
    showRunBusyToast({
      heldBySessionId,
      projectPath,
      locale,
      onJump: (sessionId) => { void get().switchAgentSession(sessionId); },
    });
  };

  // ── 09-01 A3：inbox 附件上传（uploading → parsing → ready | error 状态机）──

  /** description 异步回填串行链（API 并发纪律——多 fresh 附件逐个生成，不并发突刺）。 */
  let inboxDescriptionQueue: Promise<void> = Promise.resolve();

  const setUploadEntry = (uploadId: string, patch: Partial<InboxUploadEntry>) =>
    set((s) => {
      const prev = s.attachmentUploadStates[uploadId];
      // 在途移除守卫：chip 已被用户移除 → 不复活（完成回调据此弃挂）。
      if (!prev) return s;
      return { attachmentUploadStates: { ...s.attachmentUploadStates, [uploadId]: { ...prev, ...patch } } };
    });

  const deleteUploadEntry = (uploadId: string) =>
    set((s) => {
      if (!(uploadId in s.attachmentUploadStates)) return s;
      const next = { ...s.attachmentUploadStates };
      delete next[uploadId];
      return { attachmentUploadStates: next };
    });

  /**
   * fresh 描述异步回填（R1.2b / design D-B'，AC6e）：读派生材料前 ~8K 字 → 直调
   * model:generate-text（ref = dialogue 档，C3.2 单控制面）一句话定性 ≤50 字 → 回填
   * 附件对象 + storeAttachmentDescription 写回 sidecar（下次直命中，AC6f）。
   * never-throws：失败/超时（~10s）静默降级 preview-only；回填守卫 = 附件仍在
   * pendingAttachments + isCurrentProject（已发送/已移除/已切项目 → 丢弃）。
   * CR-010③：生成前 U+FFFD 替换率 ≥3% 跳过（preview-only 降级——防 LLM 对乱码编造
   * 定性）。CR-013：写回 sidecar 带 capturedMtime（resolve 时 mtime，shell 比对现盘
   * 更新即拒——防过期描述挂新哈希、staleness 恒假）。
   */
  const backfillInboxDescription = async (args: {
    projectPath: string;
    epoch: number;
    attachmentId: string;
    derivedPath: string;
    /** resolve 返回的 mtime（= 附件 fileMtime）——CR-013 TOCTOU 守卫载荷。 */
    capturedMtime?: number;
  }): Promise<void> => {
    const { projectPath, epoch, attachmentId, derivedPath, capturedMtime } = args;
    try {
      const content = await readInboxMaterialText(projectPath, derivedPath);
      if (!content || !isCurrentProjectScope(epoch, projectPath)) return;
      // CR-010③：乱码守卫（生成输入同窗检测，纯代码判定）——跳过生成不报错。
      if (shouldSkipAttachmentDescription(content)) return;
      // 跨 slice 读（state-management spec 惯例：typed cleanup tracked）。
      const modelConfig = (get() as unknown as { modelConfig?: ModelConfig }).modelConfig;
      const description = await generateAttachmentDescription({
        modelRef: dialogueModelRefFromConfig(modelConfig),
        content,
      });
      if (description === null) return; // 失败/超时静默（preview 兜底，不报错不影响发送）
      if (!isCurrentProjectScope(epoch, projectPath)) return;
      if (!get().pendingAttachments.some((a) => a.id === attachmentId)) return; // 已发送/已移除
      const describedAt = Date.now();
      set((s) => ({
        pendingAttachments: s.pendingAttachments.map((a) =>
          a.id === attachmentId && a.type === 'file' ? { ...a, description, describedAt } : a,
        ),
      }));
      // 写回 sidecar（fire-and-forget；失败静默——缓存可再生，重新挂载时会重新生成）。
      void storeAttachmentDescription({ projectPath, filePath: derivedPath, description, capturedMtime }).catch(() => {});
    } catch {
      /* never-throws */
    }
  };

  /**
   * 挂附件协议消费端（上传与 inbox 材料段两入口共用）：resolve → 成功挂 file 指针
   * （preview/description/describedAt/fileMtime 四元数据齐填，A3b 字段）+ 条目迁移
   * ready（键 = 附件 id=derivedPath）；fresh（无描述）→ 入队 description 异步回填。
   * 失败 → error 态（scanned 带指引文案，AC3；原件保留 inbox/ 不静默删）。
   */
  const resolveAndAttachInboxFile = async (args: {
    projectPath: string;
    epoch: number;
    /** null = 无对应 chip（导入数超 chip 数的兜底路径），直接挂载不经状态机。 */
    uploadId: string | null;
    relPath: string;
    label: string;
  }): Promise<void> => {
    const { projectPath, epoch, uploadId, relPath, label } = args;
    if (uploadId) setUploadEntry(uploadId, { state: 'parsing' });
    let result: ResolveInboxAttachmentResult;
    try {
      result = await resolveInboxAttachment({ projectPath, filePath: relPath });
    } catch {
      if (uploadId && isCurrentProjectScope(epoch, projectPath)) {
        setUploadEntry(uploadId, { state: 'error' });
      }
      return;
    }
    if (!isCurrentProjectScope(epoch, projectPath)) return; // 复查 M3：切项目守卫
    if (!result.ok) {
      if (uploadId) {
        setUploadEntry(uploadId, {
          state: 'error',
          errorKind: result.kind === 'scanned' ? 'scanned' : undefined,
        });
      }
      return;
    }
    if (uploadId && !(uploadId in get().attachmentUploadStates)) return; // 在途移除守卫
    const attachment: FileAttachment = {
      type: 'file',
      id: result.derivedPath,
      label,
      // CR-010①：preview 被编码检测抑制为空（非 UTF-8/GBK）且带解析备注 → 填机器提示
      // 文案（指针块「预览:」行保门控成立——模型侧引导可达；与引导行同语言域，不走 i18n）。
      preview: result.preview
        || (result.notes && result.notes.length > 0 ? NON_UTF8_ATTACHMENT_ADVISORY : undefined),
      description: result.description,
      describedAt: result.describedAt,
      fileMtime: result.mtime,
    };
    get().addAttachment(attachment);
    if (uploadId) {
      // 条目迁移 ready（键 = 附件 id；chip 转由 pendingAttachments 侧渲染）。CR-010②：
      // 备注首项随迁移携带（chip tooltip 消费——用户侧提示面）。
      set((s) => {
        const next = { ...s.attachmentUploadStates };
        delete next[uploadId];
        next[result.derivedPath] = {
          state: 'ready',
          label,
          ...(result.notes && result.notes.length > 0 ? { note: result.notes[0] } : {}),
        };
        return { attachmentUploadStates: next };
      });
    }
    if (!result.description) {
      // 入队 thunk（非已启动的 promise）——真正串行：上一个回填完成后才发起下一个
      // generateText（API 并发纪律）。CR-013：携带 resolve 时 mtime 供 sidecar 写回守卫。
      inboxDescriptionQueue = inboxDescriptionQueue
        .then(() => backfillInboxDescription({
          projectPath,
          epoch,
          attachmentId: result.derivedPath,
          derivedPath: result.derivedPath,
          capturedMtime: result.mtime,
        }))
        .catch(() => {});
    }
  };

  // The agent conversation is keyed to a project path; drop it on switch so
  // messages, session id and pending cards can't bleed into the new
  // project. Delegates to the slice's own resetAgentForProjectSwitch action.
  registerProjectReset(() => {
    get().resetAgentForProjectSwitch();
  });

  // 09-13 子3 W2：escalate findings 挂起键按 owner 归属保留（mirror pausedReview 的
  // CR-T1-025 语义——escalate-pause 链停在等裁决，清了就永久丢：主进程 run 死等只能 abort
  // 救）。有归属（getSessionProject 已知）的键跨项目存活，渲染面按 sessionId 键控隔离；
  // 仅清无归属残键。
  registerProjectReset(() => {
    set((s) => {
      const next: Record<string, EscalateFindingsEntry> = {};
      for (const sid of Object.keys(s.escalateFindingsBySession)) {
        if (getSessionProject(sid) !== undefined) next[sid] = s.escalateFindingsBySession[sid];
      }
      return { escalateFindingsBySession: next };
    });
  });

  return {
  agentMode: initialMode,
  setAgentMode: (mode) => {
    const state = get();
    if (state.activeSessionRunning && !state.agentSessionId) return;
    storage.set(AGENT_MODE_KEY, mode);
    set({ agentMode: mode });
    const sessionId = state.agentSessionId;
    if (!sessionId) {
      confirmedMode = mode;
      confirmedModeSessionId = null;
      return;
    }
    if (confirmedModeSessionId !== sessionId) {
      confirmedMode = state.agentMode;
      confirmedModeSessionId = sessionId;
    }
    const token = ++modeSwitchToken;
    const epoch = projectEpoch;
    const projectPath = state.currentProject?.path;
    modeSwitchQueue = modeSwitchQueue.then(async () => {
      if (!isCurrentProjectScope(epoch, projectPath) || get().agentSessionId !== sessionId) return;
      try {
        const { ok } = await setAgentSessionMode(sessionId, projectPath, mode);
        if (!isCurrentProjectScope(epoch, projectPath) || get().agentSessionId !== sessionId) return;
        if (ok) {
          confirmedMode = mode;
        } else if (token === modeSwitchToken) {
          storage.set(AGENT_MODE_KEY, confirmedMode);
          set({ agentMode: confirmedMode, agentError: 'agent.modeSwitchFailed' });
        }
      } catch {
        if (
          token === modeSwitchToken
          && isCurrentProjectScope(epoch, projectPath)
          && get().agentSessionId === sessionId
        ) {
          storage.set(AGENT_MODE_KEY, confirmedMode);
          set({ agentMode: confirmedMode, agentError: 'agent.modeSwitchFailed' });
        }
      }
    });
  },
  agentBehaviorMode: initialBehavior,
  setAgentBehaviorMode: (behaviorMode) => {
    // Story 3.1: mirrors setAgentMode's rollback pattern exactly — optimistic
    // store + persist, IPC persist, roll back to the last confirmed value when
    // the runtime refuses (e.g. session gone) or the call throws. Own switch
    // token / confirmed tracker so it is independent of permission-mode and
    // model switches (the three axes are orthogonal). Queued so rapid switches
    // apply in order; a switch made while a turn is running is applied to the
    // next turn (ok === true).
    const state = get();
    if (state.activeSessionRunning && !state.agentSessionId) return;
    storage.set(AGENT_BEHAVIOR_KEY, behaviorMode);
    set({ agentBehaviorMode: behaviorMode });
    const sessionId = state.agentSessionId;
    if (!sessionId) {
      confirmedBehavior = behaviorMode;
      confirmedBehaviorSessionId = null;
      return;
    }
    if (confirmedBehaviorSessionId !== sessionId) {
      confirmedBehavior = state.agentBehaviorMode;
      confirmedBehaviorSessionId = sessionId;
    }
    const token = ++behaviorSwitchToken;
    const epoch = projectEpoch;
    const projectPath = state.currentProject?.path;
    behaviorSwitchQueue = behaviorSwitchQueue.then(async () => {
      if (!isCurrentProjectScope(epoch, projectPath) || get().agentSessionId !== sessionId) return;
      try {
        const { ok } = await setAgentSessionBehaviorMode(sessionId, projectPath, behaviorMode);
        if (!isCurrentProjectScope(epoch, projectPath) || get().agentSessionId !== sessionId) return;
        if (ok) {
          confirmedBehavior = behaviorMode;
        } else if (token === behaviorSwitchToken) {
          storage.set(AGENT_BEHAVIOR_KEY, confirmedBehavior);
          set({ agentBehaviorMode: confirmedBehavior, agentError: 'agent.behaviorSwitchFailed' });
        }
      } catch {
        if (
          token === behaviorSwitchToken
          && isCurrentProjectScope(epoch, projectPath)
          && get().agentSessionId === sessionId
        ) {
          storage.set(AGENT_BEHAVIOR_KEY, confirmedBehavior);
          set({ agentBehaviorMode: confirmedBehavior, agentError: 'agent.behaviorSwitchFailed' });
        }
      }
    });
  },
  agentParticipationGear: initialGear,
  agentBalancedAskCategories: initialGearCategories,
  agentTrustAdjudication: initialTrust,
  setAgentParticipationGear: (gear, options) => {
    // Story 3.5: mirrors setAgentBehaviorMode's rollback pattern — optimistic
    // store + persist, IPC persist, roll the WHOLE config (gear + categories +
    // trust) back to the last confirmed triple when the runtime refuses (e.g.
    // a run is in flight or the session is gone) or the call throws. Own switch
    // token / queue so it never interleaves with the other three axes. UI
    // entry points are disabled mid-run; mid-run switching is the leader's
    // set_participation_gear tool (chat command), which updates mid-run.
    const state = get();
    if (state.activeSessionRunning && !state.agentSessionId) return;
    const nextCategories = options?.balancedAskCategories ?? state.agentBalancedAskCategories;
    const nextTrust = options?.trustAdjudication ?? state.agentTrustAdjudication;
    storage.set(AGENT_GEAR_KEY, gear);
    storage.set(AGENT_GEAR_CATEGORIES_KEY, nextCategories);
    storage.set(AGENT_TRUST_KEY, nextTrust);
    set({
      agentParticipationGear: gear,
      agentBalancedAskCategories: nextCategories,
      agentTrustAdjudication: nextTrust,
    });
    const sessionId = state.agentSessionId;
    if (!sessionId) {
      confirmedGear = gear;
      confirmedGearCategories = nextCategories;
      confirmedGearTrust = nextTrust;
      confirmedGearSessionId = null;
      return;
    }
    if (confirmedGearSessionId !== sessionId) {
      confirmedGear = state.agentParticipationGear;
      confirmedGearCategories = state.agentBalancedAskCategories;
      confirmedGearTrust = state.agentTrustAdjudication;
      confirmedGearSessionId = sessionId;
    }
    const token = ++gearSwitchToken;
    const epoch = projectEpoch;
    const projectPath = state.currentProject?.path;
    // CR-009：options 的显式发送判定加入 explicitSync 维度——一旦曾显式同步过非默认值，
    // 即便改回默认也始终发送（防陈旧窄化值残留撤销用户操作）。
    const ipcOptions = gearOptionsIfChanged(nextCategories, nextTrust, gearOptionsExplicitSync);
    const optionsNowDiffer = ipcOptions !== undefined;
    gearSwitchQueue = gearSwitchQueue.then(async () => {
      if (!isCurrentProjectScope(epoch, projectPath) || get().agentSessionId !== sessionId) return;
      try {
        const { ok } = await setAgentSessionParticipationGear(sessionId, projectPath, gear, ipcOptions);
        if (!isCurrentProjectScope(epoch, projectPath) || get().agentSessionId !== sessionId) return;
        if (ok) {
          confirmedGear = gear;
          confirmedGearCategories = nextCategories;
          confirmedGearTrust = nextTrust;
          if (optionsNowDiffer) gearOptionsExplicitSync = true;
          if (pendingGearOptionsRetry && pendingGearOptionsRetry.sessionId === sessionId) {
            pendingGearOptionsRetry = null;
          }
        } else if (token === gearSwitchToken) {
          storage.set(AGENT_GEAR_KEY, confirmedGear);
          storage.set(AGENT_GEAR_CATEGORIES_KEY, confirmedGearCategories);
          storage.set(AGENT_TRUST_KEY, confirmedGearTrust);
          set({
            agentParticipationGear: confirmedGear,
            agentBalancedAskCategories: confirmedGearCategories,
            agentTrustAdjudication: confirmedGearTrust,
            agentError: 'agent.gearSwitchFailed',
          });
        }
      } catch {
        if (
          token === gearSwitchToken
          && isCurrentProjectScope(epoch, projectPath)
          && get().agentSessionId === sessionId
        ) {
          storage.set(AGENT_GEAR_KEY, confirmedGear);
          storage.set(AGENT_GEAR_CATEGORIES_KEY, confirmedGearCategories);
          storage.set(AGENT_TRUST_KEY, confirmedGearTrust);
          set({
            agentParticipationGear: confirmedGear,
            agentBalancedAskCategories: confirmedGearCategories,
            agentTrustAdjudication: confirmedGearTrust,
            agentError: 'agent.gearSwitchFailed',
          });
        }
      }
    });
  },
  agentSessionId: null,
  agentMessages: [],
  // dogfood R2 #11⑤：输入行直出钮 → 流式消息拉满的跨组件信号（见类型注释）。
  streamRevealTick: 0,
  requestStreamReveal: () => set((s) => ({ streamRevealTick: s.streamRevealTick + 1 })),
  activeSessionRunning: false,
  sessionSwitching: false,
  agentError: null,
  agentRunStates: {},
  // dogfood T1 Stage 6：链运行态（写入方 chainStreamBuffer，此 slice 只持字段）。
  chainRunBySession: {},
  // dogfood T1 CR-T1-048：项目级链锚（写入方 agentEvents.anchorChainRun，此 slice 只持字段）。
  chainRunAnchorByProject: {},
  // 09-13 子3 W2：写作页运行时间线（写入方 chainTimeline 模块，此 slice 只持字段）。
  chainTimelineBySession: {},
  // 09-13 子3 W2：escalate findings 路由缓存（写入方 agentEvents / chapterReviewSlice
  // fallback，此 slice 只持字段 + 项目重置 owner 过滤）。
  escalateFindingsBySession: {},
  // 09-12 子2：回退通知 + 当前模型 chip（写入方 agentEvents，此 slice 只持字段）。
  modelFallbackNotices: {},
  activeModelBySession: {},
  // 09-12 子4：桥运行期通知（写入方 agentEvents，此 slice 只持字段）。
  bridgeNoticesBySession: {},
  // 09-12 子5 R6：上下文占用 last 值（写入方 agentEvents，此 slice 只持字段）。
  contextUsageBySession: {},

  setAgentRunState: (sessionId, patch) => set((s) => {
    const prev = s.agentRunStates[sessionId];
    const next: AgentRunState = {
      sessionId,
      phase: patch.phase ?? prev?.phase ?? 'idle',
      projectPath: 'projectPath' in patch ? patch.projectPath : prev?.projectPath,
      activity: 'activity' in patch ? patch.activity : prev?.activity,
      updatedAt: Date.now(),
    };
    // delta 频率防护：相位/活动/归属无变化则不写 store（r7「勿每 delta 一次 set」）。
    if (
      prev
      && prev.phase === next.phase
      && prev.activity === next.activity
      && prev.projectPath === next.projectPath
    ) return s;
    return { agentRunStates: { ...s.agentRunStates, [sessionId]: next } };
  }),

  clearAgentRunState: (sessionId) => set((s) => {
    if (!(sessionId in s.agentRunStates)) return s;
    const next = { ...s.agentRunStates };
    delete next[sessionId];
    return { agentRunStates: next };
  }),

  pendingAttachments: [],
  addAttachment: (attachment) =>
    set((s) => (
      s.pendingAttachments.some((a) => a.id === attachment.id && a.type === attachment.type)
        ? s
        : { pendingAttachments: [...s.pendingAttachments, attachment] }
    )),
  removeAttachment: (id) =>
    set((s) => {
      // 09-01 A3：连带清 ready 态上传条目（键 = 附件 id）。
      const nextStates = { ...s.attachmentUploadStates };
      delete nextStates[id];
      return {
        pendingAttachments: s.pendingAttachments.filter((a) => a.id !== id),
        attachmentUploadStates: nextStates,
      };
    }),
  clearAttachments: () =>
    set((s) => {
      // CR-009：连带清 ready 态条目（键 = 附件 id，与 removeAttachment 同形态）——ready
      // 条目持 MB 级 thumbDataUrl，pending 清空后成孤儿驻留。在途（uploading/parsing，
      // 完成回调由条目缺失守卫自理）与 error 指引条目（用户可见提示面）不受影响。
      const next: Record<string, InboxUploadEntry> = {};
      for (const [key, entry] of Object.entries(s.attachmentUploadStates)) {
        if (entry.state !== 'ready') next[key] = entry;
      }
      return { pendingAttachments: [], attachmentUploadStates: next };
    }),

  // ── 09-01 A3：inbox 附件上传状态机 ──

  attachmentUploadStates: {},

  async uploadInboxFiles(files) {
    const projectPath = get().currentProject?.path;
    if (!projectPath || files.length === 0) return;
    const epoch = projectEpoch;
    // 每 file 一 chip（uploading）——进件即有确定性反馈（design D-B）。
    const entries = files.map((file) => ({ uploadId: `upload-${randomUUID()}`, label: file.name }));
    set((s) => {
      const next = { ...s.attachmentUploadStates };
      for (const e of entries) next[e.uploadId] = { state: 'uploading', label: e.label };
      return { attachmentUploadStates: next };
    });
    // 换绝对路径（Electron 37 无 File.path——pathForFile 先例 FileTreeNode.tsx；
    // bridge 收口经 api 层）；取不到路径的（非 Electron 环境）直接落 error 态。
    const sourcePaths: string[] = [];
    files.forEach((file, i) => {
      const p = pathForUploadFile(file);
      if (p) sourcePaths.push(p);
      else setUploadEntry(entries[i].uploadId, { state: 'error' });
    });
    let imported: string[] = [];
    let rejected: string[] = [];
    if (sourcePaths.length > 0) {
      try {
        ({ imported, rejected } = await importFilesToInbox(projectPath, sourcePaths));
      } catch {
        /* 全批失败——下方 leftover 处理统一转 error 态 */
      }
    }
    if (!isCurrentProjectScope(epoch, projectPath)) return; // 复查 M3
    // CR-018：拒收三档分类（扩展名 / 超 50MB / 超单批）——带原因形态（SH-a 定型
    // `name (超过 50MB 上限)` 等）分流，toast 文案不再把大小/批量误说成「不支持的格式」。
    const rejectTiers = classifyImportRejections(rejected);
    if (rejected.length > 0) {
      const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
      const segments: string[] = [];
      if (rejectTiers.format.length > 0) {
        segments.push(translate(locale, 'agent.uploadRejectedFormat', {
          names: rejectTiers.format.slice(0, 5).join('、'),
        }));
      }
      if (rejectTiers.tooLarge.length > 0) {
        segments.push(translate(locale, 'agent.uploadRejectedTooLarge', {
          names: rejectTiers.tooLarge.slice(0, 5).join('、'),
        }));
      }
      if (rejectTiers.batchLimit.length > 0) {
        segments.push(translate(locale, 'agent.uploadRejectedBatchLimit', {
          names: rejectTiers.batchLimit.slice(0, 5).join('、'),
        }));
      }
      if (segments.length > 0) {
        useToastStore.getState().showToast(segments.join('；'), 'warning', 5000);
      }
    }
    // imported rel ↔ chip 对位（basename 命中；uniquePath 加序号的撞名件落顺序兜底）。
    const used = new Set<string>();
    const resolveQueue: { uploadId: string | null; rel: string }[] = [];
    const unmatched: string[] = [];
    for (const rel of imported) {
      const base = rel.split('/').pop() ?? rel;
      const hit = entries.find((e) => !used.has(e.uploadId) && e.label === base);
      if (hit) {
        used.add(hit.uploadId);
        resolveQueue.push({ uploadId: hit.uploadId, rel });
      } else {
        unmatched.push(rel);
      }
    }
    for (const rel of unmatched) {
      const free = entries.find((e) => !used.has(e.uploadId));
      if (free) used.add(free.uploadId);
      resolveQueue.push({ uploadId: free ? free.uploadId : null, rel });
    }
    // leftover（拒收之外的静默跳过：大小闸/拷贝失败）→ error 态明示（不静默吞）。
    // CR-018：拒收件按裸名对位 tier errorKind（chip 指引文案区分三档）；其余静默跳过
    // 保持通用 error 态。
    const rejectKindByBase = new Map<string, NonNullable<InboxUploadEntry['errorKind']>>();
    for (const n of rejectTiers.format) rejectKindByBase.set(n, 'rejected-format');
    for (const n of rejectTiers.tooLarge) rejectKindByBase.set(n, 'rejected-size');
    for (const n of rejectTiers.batchLimit) rejectKindByBase.set(n, 'rejected-batch');
    for (const e of entries) {
      if (!used.has(e.uploadId)) {
        setUploadEntry(e.uploadId, { state: 'error', errorKind: rejectKindByBase.get(e.label) });
      }
    }
    // 逐文件串行 resolve（解析可能走 docParser 端点——API 并发纪律）。
    for (const { uploadId, rel } of resolveQueue) {
      const label = entries.find((e) => e.uploadId === uploadId)?.label ?? (rel.split('/').pop() ?? rel);
      await resolveAndAttachInboxFile({ projectPath, epoch, uploadId, relPath: rel, label });
    }
  },

  // ── 09-01 B4：chat 图片附件（三入口统一；mirror uploadInboxFiles 状态机形态）──

  async uploadChatImages(files) {
    const projectPath = get().currentProject?.path;
    if (!projectPath || files.length === 0) return;
    const epoch = projectEpoch;
    // 每 file 一 chip（uploading，variant=image）——压缩/落盘在途即有确定性反馈。
    const entries = files.map((file) => ({
      uploadId: `upload-${randomUUID()}`,
      label: file.name || 'image',
      file,
    }));
    set((s) => {
      const next = { ...s.attachmentUploadStates };
      for (const e of entries) next[e.uploadId] = { state: 'uploading', label: e.label, variant: 'image' };
      return { attachmentUploadStates: next };
    });
    // 逐图串行：canvas 压缩 + 落盘 IPC（API 并发纪律 mirror A3 resolve 串行）。
    for (const e of entries) {
      let compressed: ChatImageCompressResult;
      try {
        compressed = await compressChatImage(e.file);
      } catch {
        compressed = { ok: false, reason: 'decode-failed' }; // never-throws 兜底（解码/环境异常）
      }
      if (!isCurrentProjectScope(epoch, projectPath)) return; // 复查 M3：切项目守卫
      if (!(e.uploadId in get().attachmentUploadStates)) continue; // 在途移除守卫（chip 已被用户移除）
      if (!compressed.ok) {
        setUploadEntry(e.uploadId, { state: 'error', errorKind: compressed.reason });
        continue;
      }
      // 缩小后的 ok 结果提为 const（下方 set 闭包保留 narrowing）。
      const image = compressed;
      // 压缩即显缩略图（仍在 uploading 态——落盘 IPC 在途 chip 已可预览，R2.6 pending 直显）。
      setUploadEntry(e.uploadId, { thumbDataUrl: image.dataUrl });
      // 🔴 b64hash 形态与 shell B3 逐字对齐（agentImageParts resolveImageBytes 以
      // `createHash('sha256').update(落盘字节).digest('hex')` 比对）：hash 输入 = 与
      // b64Json 载荷严格同源的字节（compressChatImage 契约），sha256Hex 见该模块头注释。
      // never-throws 兜底（WebCrypto 缺席等环境异常——error 态明示，不悬转圈）。
      let b64hash: string;
      try {
        b64hash = await sha256Hex(image.bytes);
      } catch {
        if (isCurrentProjectScope(epoch, projectPath) && e.uploadId in get().attachmentUploadStates) {
          setUploadEntry(e.uploadId, { state: 'error', errorKind: 'decode-failed' });
        }
        continue;
      }
      if (!isCurrentProjectScope(epoch, projectPath)) return;
      if (!(e.uploadId in get().attachmentUploadStates)) continue; // 在途移除守卫
      let saved: Awaited<ReturnType<typeof saveChatImage>>;
      try {
        saved = await saveChatImage(projectPath, compressed.b64, compressed.mimeType, imageFileStem(e.label));
      } catch {
        if (isCurrentProjectScope(epoch, projectPath) && e.uploadId in get().attachmentUploadStates) {
          setUploadEntry(e.uploadId, { state: 'error' }); // 落盘失败（IPC 拒绝等）——可移除重试
        }
        continue;
      }
      if (!isCurrentProjectScope(epoch, projectPath)) return; // 复查 M3
      if (!(e.uploadId in get().attachmentUploadStates)) continue; // 在途移除守卫
      const attachment: ImageAttachment = {
        type: 'image',
        id: saved.relativePath,
        label: e.label,
        path: saved.relativePath,
        b64hash,
      };
      get().addAttachment(attachment);
      // 条目迁移 ready（键 = 附件 id = 落盘相对路径；thumbDataUrl 随迁移保留——chip 由
      // pendingAttachments 侧渲染时经此查缩略图，发送时随状态机整体清场）。
      set((s) => {
        const next = { ...s.attachmentUploadStates };
        delete next[e.uploadId];
        next[saved.relativePath] = {
          state: 'ready',
          label: e.label,
          variant: 'image',
          thumbDataUrl: image.dataUrl,
        };
        return { attachmentUploadStates: next };
      });
    }
  },

  async attachInboxMaterial(relPath, displayName) {
    const projectPath = get().currentProject?.path;
    if (!projectPath) return;
    const epoch = projectEpoch;
    const uploadId = `upload-${randomUUID()}`;
    set((s) => ({
      attachmentUploadStates: { ...s.attachmentUploadStates, [uploadId]: { state: 'parsing', label: displayName } },
    }));
    await resolveAndAttachInboxFile({ projectPath, epoch, uploadId, relPath, label: displayName });
  },

  removeAttachmentUpload: (uploadId) => {
    deleteUploadEntry(uploadId);
  },

  agentSessions: [],
  // R2 #14：初始非草稿（挂载即空白视图 = 无会话状态，非用户点过「新会话」）。
  draftSession: false,

  async truncateAgentMessages(messageId) {
    const state = get();
    if (!state.agentSessionId || state.activeSessionRunning) return { ok: false, reason: 'running' };
    const index = state.agentMessages.findIndex((m) => m.id === messageId);
    if (index === -1) return { ok: false, reason: 'not-found' };
    // UI 侧同款纯对话尾巴闸门（按钮亲和性依据；runtime 是权威二次把关）。
    const tail = state.agentMessages.slice(index);
    const hasToolActivity = tail.some(
      (m) => m.role === 'tool' || (m.toolCalls?.length ?? 0) > 0 || (m.toolResults?.length ?? 0) > 0,
    );
    if (hasToolActivity) return { ok: false, reason: 'tool-activity' };
    const result = await truncateSession(state.agentSessionId, messageId);
    if (result.ok) {
      // dogfood T1 CR-T1-045：截断成功同步清 agentError——错误条所锚定的 run 尾部刚被
      // 移除，不清则重试钮（重发末条 user）锚点漂移到更早消息，用户答非所问。
      set({ agentMessages: state.agentMessages.slice(0, index), agentError: null });
    }
    return result;
  },

  async sendAgentMessage(content) {
    const state = get();
    const projectPath = state.currentProject?.path;
    if (!projectPath || state.activeSessionRunning) return false;
    const epoch = projectEpoch;
    const isCurrentScope = () => isCurrentProjectScope(epoch, projectPath);
    // CR-37②：显式发送 bump 接管 token——在途自动接续（load 后待切换 / 切换 fetch 在途）弃权，
    // 本轮建会话/视图不被旧接管帧覆盖；同时清切换加载视觉（发送即最新意图，被弃权的切换不得
    // 残留 sessionSwitching 卡输入）。
    autoResumeToken += 1;
    set({ activeSessionRunning: true, agentError: null, sessionSwitching: false });
    // 09-12 子2：新 run 起——清本会话回退通知 + 当前模型 chip（通知是「本次 run 的切换
    // 记录」；chip 回落 UI 派生初值）。仅清现有会话的条目（新建会话路径无旧条目）；
    // delete 语义（键控图不残留 undefined 条目）。子4：桥通知同批清（本次 run 的记录）；
    // 子5（CR-14，子4 CR 批）：上下文占用 last 值同批清——新一轮开始时上轮余量条是
    // stale bar（新 run 的首帧未到前不得显示旧值）。
    const resetSid = get().agentSessionId;
    if (resetSid !== null) {
      set((s) => {
        const nextNotices = { ...s.modelFallbackNotices };
        const nextActive = { ...s.activeModelBySession };
        const nextBridge = { ...s.bridgeNoticesBySession };
        const nextContext = { ...s.contextUsageBySession };
        const hadNotices = resetSid in nextNotices;
        const hadActive = resetSid in nextActive;
        const hadBridge = resetSid in nextBridge;
        const hadContext = resetSid in nextContext;
        if (hadNotices) delete nextNotices[resetSid];
        if (hadActive) delete nextActive[resetSid];
        if (hadBridge) delete nextBridge[resetSid];
        if (hadContext) delete nextContext[resetSid];
        if (!hadNotices && !hadActive && !hadBridge && !hadContext) return {};
        return {
          ...(hadNotices ? { modelFallbackNotices: nextNotices } : {}),
          ...(hadActive ? { activeModelBySession: nextActive } : {}),
          ...(hadBridge ? { bridgeNoticesBySession: nextBridge } : {}),
          ...(hadContext ? { contextUsageBySession: nextContext } : {}),
        };
      });
    }

    // Structured selection/chapter/file references pinned for this turn. They are
    // passed through the IPC channel (not flattened into text); the runtime renders
    // them into the prompt.
    const attachments = state.pendingAttachments;

    const messageContent = content;

    // dogfood T1 Stage 3 D4 本地预检：该项目另一会话在运行（agentRunStates 事件驱动）→
    // 不发 invoke，toast + 一键跳转（shell projectActiveRuns 仍是权威闸——链 IPC 等不经
    // 本函数的 run 对 UI run 态不可见，靠 invoke 结构化拒绝兜底）。
    const existingSid = state.agentSessionId;
    const busyRun = Object.values(get().agentRunStates).find(
      // CR-T1-026：归一比较（同 isProjectRunActive）。
      (r) => r.phase === 'running'
        && (r.projectPath === undefined || sameProjectPath(r.projectPath, projectPath))
        && r.sessionId !== existingSid,
    );
    if (busyRun) {
      set({ activeSessionRunning: false });
      notifyProjectRunBusy(busyRun.sessionId, projectPath);
      return false;
    }

    let sessionId = state.agentSessionId;
    try {
      if (!sessionId) {
        const session = await createAgentSession(
          projectPath,
          state.agentMode,
          state.agentBehaviorMode,
          state.agentParticipationGear,
        );
        if (!isCurrentScope()) return false;
        sessionId = session.id;
        confirmedMode = state.agentMode;
        confirmedModeSessionId = sessionId;
        confirmedBehavior = state.agentBehaviorMode;
        confirmedBehaviorSessionId = sessionId;
        confirmedGear = state.agentParticipationGear;
        confirmedGearCategories = state.agentBalancedAskCategories;
        confirmedGearTrust = state.agentTrustAdjudication;
        confirmedGearSessionId = sessionId;
        set({ agentSessionId: sessionId, draftSession: false });
        // R2 #14：懒建会话真落地的瞬间刷新历史列表——开着的历史面板立即看到新会话条目
        //（旧实现建完不刷，列表要等面板重挂才更新——「没有实时刷新」的直接根因之一）。
        void get().loadAgentSessions();
        // Story 3.5: create-session only carries the gear enum — the balanced
        // categories / trust toggle ride a follow-up setter when (and only
        // when) they differ from the contract defaults. Fire-and-forget with
        // a catch: a failed option sync must not fail the turn.
        const gearSyncOptions = gearOptionsIfChanged(state.agentBalancedAskCategories, state.agentTrustAdjudication);
        if (gearSyncOptions) {
          // CR-009 sid0 fixes TS type inference: outer `let sessionId: string|null`
          // but at this point we just set agentSessionId; lock non-null for closure type.
          const sid0 = sessionId as string;
          // CR-009：创建期 options 补投失败（{ok:false}）不吞--存 pendingGearOptionsRetry 待下次
          // setAgentParticipationGear 或 session load 时重试一次。
          void setAgentSessionParticipationGear(sid0, projectPath, state.agentParticipationGear, gearSyncOptions)
            .then(({ ok }: { ok: boolean }) => {
              if (!ok) {
                pendingGearOptionsRetry = {
                  sessionId: sid0,
                  gear: state.agentParticipationGear,
                  categories: state.agentBalancedAskCategories,
                  trust: state.agentTrustAdjudication,
                };
              } else {
                gearOptionsExplicitSync = true;
              }
            })
            .catch(() => {
              pendingGearOptionsRetry = {
                sessionId: sid0,
                gear: state.agentParticipationGear,
                categories: state.agentBalancedAskCategories,
                trust: state.agentTrustAdjudication,
              };
            });
        }
      }
    } catch (err) {
      if (!isCurrentScope()) return false;
      const message = err instanceof Error ? err.message : String(err);
      set({ agentError: `agent.sessionCreateFailed: ${message}`, activeSessionRunning: false });
      return false;
    }

    // 09-01 B4（R2.6）：乐观消息引用携带缩略 dataUrl（仅 UI 直显——下方 IPC attachments
    // 保持纯指针不夹带 MB 级 b64；重载会话走 ImageReferenceThumb 盘读还原）。非 image
    // 附件零变化。dataUrl 取自 uploadStates 的 ready 条目（发送后随状态机整体清场）。
    const references = attachments.length > 0
      ? attachments.map((a) => {
          if (a.type !== 'image') return a;
          const thumb = state.attachmentUploadStates[a.id]?.thumbDataUrl;
          return thumb ? { ...a, dataUrl: thumb } : a;
        })
      : undefined;

    const userMsg: AgentMessage = {
      id: randomUUID(),
      role: 'user',
      content,
      references,
      createdAt: Date.now(),
    };
    set((s) => ({
      agentMessages: [...s.agentMessages, userMsg],
      agentError: null,
      pendingAttachments: [],
      // 09-01 A3：附件随消息消费——上传状态机一并清（ready 条目随附件走，error 指引
      // chip 不跨发送残留在下一轮输入区）。
      attachmentUploadStates: {},
    }));

    const sid = sessionId;
    const mode = state.agentMode;

    // dogfood T1 Stage 3（r7）：per-invocation 订阅退役——流事件统一经 store 级全局监听
    // （agentEvents.initAgentEvents）按 sessionId+projectPath 分发。此处只做：run 态登记
    // （徽标 + 后台路由的 mode/project 归属记录）+ invoke（promise 兜底 + D4 拒绝分发）。
    rememberSessionProject(sid, projectPath);
    rememberSessionMode(sid, mode);
    get().setAgentRunState(sid, { phase: 'running', projectPath });

    const promise = streamAgentMessage(sid, messageContent, attachments);
    void promise.then((result) => {
      if (!isCurrentScope()) return;
      if (result && result.status === 'rejected') {
        // CR-T1-013：同会话自身 runState 已有活跃 run（重叠 invoke——cancelAgent 后立刻重发等）。
        // run 真的在跑（beginRun 抛错 ⟹ runState 活跃）——run 态**保持 running**（归 idle 会
        // 误开生成闸），只翻视图 spinner + 温和提示（无跳转——占用者就是本会话）；无 error
        // 事件（shell 侧已拦），不 purge 不横幅。
        if (result.code === 'session_run_active') {
          get().setAgentRunState(sid, { phase: 'running' });
          if (get().agentSessionId === sid) set({ activeSessionRunning: false });
          const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
          useToastStore.getState().showToast(translate(locale, 'agent.sessionRunBusy'), 'warning', 5000);
          return;
        }
        // D4 结构化拒绝：run 未启动——run 态归位 + toast（一键跳转占用会话；链租约占用者
        // 换文案无跳转，projectRunBusy 单源处理）。
        get().setAgentRunState(sid, { phase: 'idle', activity: undefined });
        if (get().agentSessionId === sid) set({ activeSessionRunning: false });
        notifyProjectRunBusy(result.heldBySessionId, result.projectPath);
        return;
      }
      // invoke 终态（completed/aborted/error）兜底：事件面（done/error）通常已翻 loading，
      // 此处防 invoke resolve 与最终事件的送达竞态（spinner 永卡防线，mirror 旧 promise.catch 哲学）。
      // CR-T1-024：终态对称清 agentRunStates——只清 activeSessionRunning 的话，事件丢失竞态
      //（窗口关闭期 sendEvent 被吞 / 切项目 return 跳过对账）下 isProjectRunActive 永久假真
      //（生成闸全禁）。事件面已归位时 setAgentRunState 变化守卫 no-op，零重复写。
      get().setAgentRunState(sid, {
        phase: result.status === 'error' ? 'error' : 'idle',
        activity: undefined,
      });
      if (get().agentSessionId === sid && get().activeSessionRunning) {
        set({ activeSessionRunning: false });
      }
    });
    promise.catch((err: unknown) => {
      // invoke reject 且无 error 事件（连接层失败等）——视图会话翻 loading 防永卡；后台
      // 会话（发送后切走）只落 run 态 error（切回不残留假 loading）。
      const message = err instanceof Error ? err.message : String(err);
      get().setAgentRunState(sid, { phase: 'error' });
      if (!isCurrentScope() || get().agentSessionId !== sid) return;
      set({ activeSessionRunning: false, agentError: message });
    });
    return true;
  },

  cancelAgent() {
    // dogfood T1 Stage 3 D3：语义 = 停**当前视图会话**的 run（仍调 abortAgentRun；不动全局
    // 订阅——订阅生命周期已与 app 同长）。键控后只清视图会话的挂起卡（后台会话的卡不波及）。
    const sid = get().agentSessionId;
    if (!sid) return;
    const projectPath = get().currentProject?.path;
    const epoch = projectEpoch;
    void window.orisonDesktop.abortAgentRun(sid);
    get().setAgentRunState(sid, { phase: 'idle', activity: undefined });
    // Clear any cards tied to the aborted run. Leaving them on screen lets the
    // user resolve a confirmation against a run that no longer exists, which
    // flips activeSessionRunning back on and re-strands the spinner.
    set({ activeSessionRunning: false });
    get().clearSessionPending(sid);
    // 取消 run 时可能仍有已持久化但未推送到 UI 的消息。从后端重新同步 session 消息补偿。
    void fetchAgentSession(sid, projectPath).then((session) => {
      if (!session || !isCurrentProjectScope(epoch, projectPath)) return;
      const current = get();
      if (current.agentSessionId === sid) {
        set({ agentMessages: session.messages });
      }
    });
  },

  async newAgentSession() {
    // dogfood T1 Stage 3 D3：新建**不再 abort** 当前会话在途 run（后台继续产事件进后台态，
    // 徽标可见）；只重置视图到空白会话。键控挂起卡不清（后台保留，切回再现）。
    confirmedMode = get().agentMode;
    confirmedModeSessionId = null;
    confirmedBehavior = get().agentBehaviorMode;
    confirmedBehaviorSessionId = null;
confirmedGear = get().agentParticipationGear;
    confirmedGearCategories = get().agentBalancedAskCategories;
    confirmedGearTrust = get().agentTrustAdjudication;
    confirmedGearSessionId = null;
    // CR-009：新会话重置显式同步 flag + 清待重试（旧 session 的待重试不再适用）。
    gearOptionsExplicitSync = false;
    pendingGearOptionsRetry = null;
    // CR-37①②：显式「新会话」意图——bump 接管 token（在途自动接续 load 后不再切换；在途
    // switchAgentSession fetch 完成帧比对 autoResumeToken 弃权），并清切换加载视觉（被弃权的
    // 切换不得残留 sessionSwitching 卡输入）。
    autoResumeToken += 1;
    set({
      agentSessionId: null,
      agentMessages: [],
      activeSessionRunning: false,
      agentError: null,
      pendingAttachments: [],
      // 09-01 A3（design D-I）：新会话清上传状态机——在途回调被 isCurrentScope/条目
      // 缺失守卫拦下，不把旧会话产物带进新会话输入区。
      attachmentUploadStates: {},
      sessionSwitching: false,
      // R2 #14：显式「新会话」意图 → 历史列表顶部出现草稿行（真会话建立/切换时清除）。
      draftSession: true,
    });
  },

  resetAgentForProjectSwitch() {
    // The agent session is keyed to a project path. When the active project
    // changes we must drop the previous project's VIEW state — otherwise its
    // messages / session id bleed into the new project. dogfood T1 Stage 3：
    // ① **不再 abort** 旧项目在途 run（D4 跨项目并行；事件继续进后台态，agentEvents 按
    //   projectPath 隔离不动新项目视图）；② agentRunStates 不清（跨项目存活——切回旧项目
    //   徽标仍在）；③ 键控挂起卡由各 slice 自己的项目重置回调按归属过滤清理。
    projectEpoch += 1;
    sessionListToken += 1;
    sessionSwitchToken += 1;
    modeSwitchToken += 1;
    behaviorSwitchToken += 1;
    gearSwitchToken += 1;
    confirmedMode = get().agentMode;
    confirmedModeSessionId = null;
    // Behavior mode is a UI preference persisted across projects (like the
    // permission mode); keep the persisted selection, just drop the per-session
    // confirmation so the next session re-persists it.
    confirmedBehavior = get().agentBehaviorMode;
    confirmedBehaviorSessionId = null;
    // Story 3.5: gear triple mirrors the behavior-mode preference treatment —
    // keep the persisted user preference, drop the per-session confirmation.
confirmedGear = get().agentParticipationGear;
    confirmedGearCategories = get().agentBalancedAskCategories;
    confirmedGearTrust = get().agentTrustAdjudication;
    confirmedGearSessionId = null;
    // CR-009：切项目重置显式同步 flag + 清待重试（旧项目的不再适用）。
    gearOptionsExplicitSync = false;
    pendingGearOptionsRetry = null;
    set({
      agentSessionId: null,
      agentMessages: [],
      activeSessionRunning: false,
      sessionSwitching: false,
      agentError: null,
      pendingAttachments: [],
      // 09-01 A3（复查 M3）：切项目清上传状态机——AgentPanel 不随项目切换卸载，组件
      // 本地态会跨项目残留转圈；在途回调由 isCurrentProjectScope(epoch) 守卫拦下，
      // 旧项目产物/chip 不泄漏进新项目视图（AC6b）。
      attachmentUploadStates: {},
      agentSessions: [],
      // R2 #14：项目重置不带草稿标记（新项目视图≠用户点了「新会话」）。
      draftSession: false,
    });
    // dogfood R2 #5（2026-08-25 用户拍板）：重开项目自动接续上次会话——列表非空时选中
    // 最近活跃会话（persistence ORDER BY updated_at DESC 首个），而不是空白新会话视图
    //（旧行为的「首条消息再懒建」正是「每次重开都自动建新会话」感知的来源）。空列表
    // 保持空白视图不变（首开项目零变化）。epoch/scope 双守卫防切换竞态抢新项目视图；
    // agentSessionId 非空检查防与用户先手选择/发送竞争（StrictMode 双调下靠幂等收敛）。
    // CR-37（dogfood R2 BMad CR）三重竞态加固：① draftSession 子句——显式「新会话」点击
    //（agentSessionId:null + draftSession:true）不再被接管踹掉；② autoResumeToken 守卫——load
    // 窗口内用户先手（发送/新会话/切换，均 bump）即弃权；③ autoResume 档切换失败静默回落
    // 空白视图（损坏 latest 会话不产生每次开项目的错误横幅）。复用 loadAgentSessions（自带
    // token 守卫 + in-flight 去重 + 会话归属/权限登记）+ switchAgentSession（与历史列表手点
    // 同一路径）。列表失败静默回落空白视图，不打错误横幅。
    void (async () => {
      const epoch = projectEpoch;
      const resumeToken = autoResumeToken;
      await get().loadAgentSessions();
      if (resumeToken !== autoResumeToken) return;
      if (epoch !== projectEpoch || !isCurrentProjectScope(epoch, get().currentProject?.path)) return;
      if (get().agentSessionId || get().draftSession) return;
      const latest = get().agentSessions[0];
      if (latest) await get().switchAgentSession(latest.id, { autoResume: true });
    })();
  },

  async loadAgentSessions() {
    const projectPath = get().currentProject?.path;
    if (!projectPath) { set({ agentSessions: [] }); return; }
    // CR-37④：并发去重——自动接续 load 与历史面板 load 同窗双拉共享同一 in-flight fetch
    //（免同项目同毫秒双 IPC + 双次列表落地闪烁）。仅当在途 fetch 仍是当前 token（无 reset /
    // 新调用插队）时共享，否则新拉（被 reset 作废的在途不得被新项目视图复用）。
    if (sessionListInFlight && sessionListInFlight.token === sessionListToken) {
      return sessionListInFlight.promise;
    }
    const epoch = projectEpoch;
    const token = ++sessionListToken;
    const promise = (async () => {
      try {
        const sessions = await listAgentSessions(projectPath);
        if (token !== sessionListToken || !isCurrentProjectScope(epoch, projectPath)) return;
        set({ agentSessions: sessions ?? [] });
        // 归属登记（agentEvents 模块级 Map）：项目重置按归属过滤键控槽的数据源 + 后台
        // tool 事件路由的 mode gate（会话列表带 permissionMode，未经发送即有值）。
        for (const s of sessions ?? []) {
          rememberSessionProject(s.id, s.projectPath ?? projectPath);
          if (s.permissionMode) rememberSessionMode(s.id, s.permissionMode);
        }
      } catch {
        if (token !== sessionListToken || !isCurrentProjectScope(epoch, projectPath)) return;
        set({ agentSessions: [] });
      }
    })();
    sessionListInFlight = { promise, token };
    try {
      await promise;
    } finally {
      if (sessionListInFlight?.token === token) sessionListInFlight = null;
    }
  },

  async switchAgentSession(sessionId, opts) {
    const projectPath = get().currentProject?.path;
    if (!projectPath) return;
    const epoch = projectEpoch;
    const token = ++sessionSwitchToken;
    // CR-37②：显式切换 bump 接管 token——更早的在途自动接续/切换完成帧比对不等即弃权；
    // 捕获 bump 后的值供自身完成帧比对（fetch 窗口内用户先手 send/new/switch → 本帧弃权，
    // mirror sessionSwitchToken 的手动切换互斥语义，扩展到 send/new 两类先手）。
    const resumeToken = ++autoResumeToken;
    // dogfood T1 Stage 3 D3：切换**不 abort** 在途 run（旧 :1042-1046 显式 abort 退役）；
    // 不清键控挂起卡（后台保留，切回再现——旧 :1106-1108 清三槽退役）。加载期独立
    // sessionSwitching 视觉态（旧复用 agentLoading 的「加载中」语义剥离，r8 设计要点 2）。
    set({ sessionSwitching: true, agentError: null });
    try {
      const session = await fetchAgentSession(sessionId, projectPath);
      if (
        token !== sessionSwitchToken
        || resumeToken !== autoResumeToken
        || !isCurrentProjectScope(epoch, projectPath)
      ) return;
      if (!session) throw new Error('Session not found');
      const permissionMode = session.permissionMode ?? 'suggest';
      const behaviorMode = session.behaviorMode ?? 'normal';
      storage.set(AGENT_MODE_KEY, permissionMode);
      confirmedMode = permissionMode;
      confirmedModeSessionId = sessionId;
      storage.set(AGENT_BEHAVIOR_KEY, behaviorMode);
      confirmedBehavior = behaviorMode;
      confirmedBehaviorSessionId = sessionId;
      // Story 3.5: read the session-persisted gear triple back into the UI
      // (mirror the behavior-mode read-back; missing fields → contract defaults).
      const participationGear = session.participationGear ?? PARTICIPATION_GEAR_DEFAULT;
      const balancedAskCategories = session.balancedAskCategories ?? BALANCED_ASK_CATEGORIES_DEFAULT;
      const trustAdjudication = session.trustAdjudication ?? TRUST_ADJUDICATION_DEFAULT;
      storage.set(AGENT_GEAR_KEY, participationGear);
      storage.set(AGENT_GEAR_CATEGORIES_KEY, balancedAskCategories);
      storage.set(AGENT_TRUST_KEY, trustAdjudication);
confirmedGear = participationGear;
      confirmedGearCategories = balancedAskCategories;
      confirmedGearTrust = trustAdjudication;
      confirmedGearSessionId = sessionId;
      // CR-009：session meta 持有非默认 options（balancedAskCategories 非空且非默认三项 /
      // trustAdjudication=true）= 该 session 曾显式同步过 -> 设 explicitSync=true 让后续改动
      // 即便改回默认也始终发送（防陈旧窄化值残留）。
      const persistedCatsNonDefault =
        session.balancedAskCategories !== undefined &&
        !(
          balancedAskCategories.length === BALANCED_ASK_CATEGORIES_DEFAULT.length &&
          BALANCED_ASK_CATEGORIES_DEFAULT.every((c) => balancedAskCategories.includes(c))
        );
      const persistedTrustNonDefault = session.trustAdjudication === true;
      gearOptionsExplicitSync = persistedCatsNonDefault || persistedTrustNonDefault;
      pendingGearOptionsRetry = null;
      // 归属登记（切回后台运行中的会话：后续事件按活跃视图路由 + mode gate 用）。
      rememberSessionProject(sessionId, projectPath);
      rememberSessionMode(sessionId, permissionMode);
      // 视图运行态 = 该会话 run 态（本 app 会话内事件驱动优先；磁盘 status 兜底——崩溃后
      // stale 'running' 由 shell D4 启动对账归位）。
      const runningFromEvents = get().agentRunStates[sessionId]?.phase === 'running';
      set({
        agentSessionId: sessionId,
        // R2 #14：切到真会话 → 草稿行退场（若此前点过「新会话」又改选历史）。
        draftSession: false,
        agentMode: permissionMode,
        agentBehaviorMode: behaviorMode,
        agentParticipationGear: participationGear,
        agentBalancedAskCategories: balancedAskCategories,
        agentTrustAdjudication: trustAdjudication,
        agentMessages: (session.messages ?? []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          toolResults: m.toolResults,
          // 透传 kind（aborted_partial 直出语义；intent_restate 旧数据兼容——R2 #16 删按钮后
          // 不再产生，历史会话回放不炸）。
          ...(m.kind ? { kind: m.kind } : {}),
          // dogfood T1 Stage 4 #27②（design §6.3 透传链三处——switch 手抄重映射两度踩坑史）：
          // 透传 reasoning——漏了历史消息丢「思考过程」折叠块（重载会话仍在，AC）。
          // streaming 是内存态不持久化，重映射刻意不带（fetch 回的消息无此字段）。
          ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
          // Story 3.5（mirror 3.3 Blind-002 教训）：透传批量分组标记——switch 手动重映射最易漏新字段，
          // 漏了历史批量消息退回扁平渲染（分组丢失）。
          ...(m.batchId !== undefined ? { batchId: m.batchId } : {}),
          ...(m.batchKind !== undefined ? { batchKind: m.batchKind } : {}),
          // 09-01 B4（R2.6）：references 透传（fetchAgentSession 已把 SessionMessage.images
          // 映射成 image 引用——B2 载荷形态）——switch 手动重映射漏字段家族（3.3 Blind-002
          // 同款坑），漏了重载会话气泡丢附件缩略图。内存态字段（dataUrl）读回时不存在。
          ...(m.references ? { references: m.references } : {}),
          createdAt: m.createdAt,
          // dogfood R2 #50：autoResume（重开项目/刷新自动接续）盖章「已落定历史」——
          // 末条 assistant 不打字机回放（回放空泡首帧打断跳底 + 重开项目每次重播是噪音）；
          // 手动切会话（AgentHistory 主动浏览）不盖，历史回放 + skip 钮语义保留。
          ...(opts?.autoResume ? { settledHistory: true as const } : {}),
        })),
        activeSessionRunning: runningFromEvents || session.status === 'running',
        sessionSwitching: false,
      });
    } catch (error) {
      if (token !== sessionSwitchToken || resumeToken !== autoResumeToken || !isCurrentProjectScope(epoch, projectPath)) return;
      // CR-37③：自动接续档失败（latest 会话损坏 / fetch 抛错 / session 为 null）→ 静默回落
      // 空白草稿态——清 agentError、视同无会话（损坏的 latest 不该每次开项目都打错误横幅）；
      // 视图字段显式归位（接续前本就是空白，幂等防御）。手动切换照旧报错。
      if (opts?.autoResume) {
        set({
          agentError: null,
          sessionSwitching: false,
          agentSessionId: null,
          agentMessages: [],
          activeSessionRunning: false,
          draftSession: false,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      set({ agentError: message, sessionSwitching: false });
    }
  },

  async deleteAgentSession(sessionId) {
    const projectPath = get().currentProject?.path;
    const epoch = projectEpoch;
    try {
      // CR-T1-029：runtime.deleteSession 不 abort 在途 run——best-effort 先停（主进程侧
      // 收尾异步，事件残流由下方 tombstone 兜底丢弃）。
      void window.orisonDesktop.abortAgentRun(sessionId);
      const deleted = await deleteSession(sessionId, projectPath);
      if (!isCurrentProjectScope(epoch, projectPath)) return;
      if (!deleted) return;
      set((s) => ({ agentSessions: s.agentSessions.filter((sess) => sess.id !== sessionId) }));
      // 键控挂起卡 + run 态随会话消亡（防徽标悬挂在已删会话上）。
      get().clearSessionPending(sessionId);
      get().clearPausedReviewFor(sessionId);
      get().clearPendingPatchFor(sessionId);
      // 09-13 子3 W4：五审阅本地态键同点清理（键控化后随会话消亡，mirror clearPausedReviewFor）。
      get().clearReviewLocalStateFor(sessionId);
      get().clearAgentRunState(sessionId);
      // CR-T1-029/033：模块级追踪/缓冲 + 链运行态 + tombstone 一并清理（dispatcher 丢弃该
      // id 后续事件——不清理则已删会话的事件重建条目「僵尸复活」+ UUID 键纯慢泄漏）。
      forgetSessionTrack(sessionId);
      forgetSessionStreams(sessionId);
      forgetChainRunBuffer(sessionId);
      // 09-13 子3 W2：时间线模块缓冲 + 两键控面同点清理（防悬空条目 / 跨 run 泄漏）。
      forgetChainTimeline(sessionId);
      set((s) => {
        const hadTimeline = sessionId in s.chainTimelineBySession;
        const hadEscalate = sessionId in s.escalateFindingsBySession;
        if (!hadTimeline && !hadEscalate) return s;
        const nextTimeline = { ...s.chainTimelineBySession };
        const nextEscalate = { ...s.escalateFindingsBySession };
        if (hadTimeline) delete nextTimeline[sessionId];
        if (hadEscalate) delete nextEscalate[sessionId];
        return { chainTimelineBySession: nextTimeline, escalateFindingsBySession: nextEscalate };
      });
      // 09-12 子2：回退通知 + 当前模型 chip 随会话消亡（防悬空条目）。
      set((s) => {
        const hadNotices = sessionId in s.modelFallbackNotices;
        const hadActive = sessionId in s.activeModelBySession;
        // 09-12 子5 R6：上下文占用 last 值同批清（同一防悬空语义）。
        const hadContext = sessionId in s.contextUsageBySession;
        // 09-12 子4：桥运行期通知同批清（mirror 回退通知）。
        const hadBridge = sessionId in s.bridgeNoticesBySession;
        if (!hadNotices && !hadActive && !hadContext && !hadBridge) return s;
        const nextNotices = { ...s.modelFallbackNotices };
        const nextActive = { ...s.activeModelBySession };
        const nextContext = { ...s.contextUsageBySession };
        const nextBridge = { ...s.bridgeNoticesBySession };
        if (hadNotices) delete nextNotices[sessionId];
        if (hadActive) delete nextActive[sessionId];
        if (hadContext) delete nextContext[sessionId];
        if (hadBridge) delete nextBridge[sessionId];
        return {
          modelFallbackNotices: nextNotices,
          activeModelBySession: nextActive,
          contextUsageBySession: nextContext,
          bridgeNoticesBySession: nextBridge,
        };
      });
      set((s) => {
        if (!(sessionId in s.chainRunBySession)) return s;
        const next = { ...s.chainRunBySession };
        delete next[sessionId];
        return { chainRunBySession: next };
      });
      // CR-T1-048：项目锚清理面覆盖——被删会话若持有某项目的链锚，一并清（防悬空锚指向
      // 已删条目；dogfood stub 会话虽不在常规清理路径，leader 会话删除断链时同款生效）。
      set((s) => {
        if (!Object.values(s.chainRunAnchorByProject).includes(sessionId)) return s;
        const next: Record<string, string> = {};
        for (const [key, owner] of Object.entries(s.chainRunAnchorByProject)) {
          if (owner !== sessionId) next[key] = owner;
        }
        return { chainRunAnchorByProject: next };
      });
      if (get().agentSessionId === sessionId) {
        set({ agentSessionId: null, agentMessages: [], activeSessionRunning: false });
      }
    } catch { /* ignore */ }
  },
  };
};
