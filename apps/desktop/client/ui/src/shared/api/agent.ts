import type { AgentMode, AgentBehaviorMode } from '../store/types';
import type {
  BalancedAskCategory,
  BatchKind,
  CompileRevisionIntentInput,
  CompileRevisionIntentResult,
  ImageAttachment,
  ModelFallbackSwitchEvent,
  ParticipationGear,
  ResumeChapterChainInput,
  RunChapterChainSummary,
  StreamAgentMessageResult,
  // 09-13 子3 W6：章卡衍生状态面契约（derivation-status 查询 + 链外重提取）。
  ChapterDerivationStatusResult,
  ReExtractChapterResult,
} from '@orison/shared-contracts';
import type { Attachment } from '../types/attachment';
// 09-13 子2 W3：chain-node-artifact 载荷镜像（chainStreamBuffer 是链类型镜像 home——
// CHAIN_NODE_ORDER 先例；agent 包 types.ts 单源）。W4 增 chain-tool / pauseKind 同 home 镜像。
import type { ChainNodeArtifactData, ChainNodeDonePauseKind, ChainToolEventData } from '../store/chainStreamBuffer';

/**
 * CR-15（09-12 子2 CR 批）：回退事件载荷单源 = shared-contracts
 * `ModelFallbackSwitchEvent`（from/to/reason/attempt）+ 链车道扩展（nodeId/role）——
 * mirror agent 包 ModelFallbackEventData 的同款扩展形态（UI 包不依赖 agent 包，
 * 本地投影一次；下方 child/顶层两事件变体共用，不再各持 inline 副本）。
 */
type ModelFallbackEventData = ModelFallbackSwitchEvent & {
  nodeId?: string;
  role?: string;
};

const api = window.orisonDesktop;

/**
 * 09-01 B4（R2.6 / dogfood #45）：UI 侧消息引用类型——image 变体可携带**内存态**
 * `dataUrl`（发送时刻 uploadStates 里的压缩后 dataUrl，乐观消息气泡缩略图直显）。
 * 该字段只活在 renderer 内存：不进 streamAgentMessage 的 attachments（IPC 保持纯
 * 指针不夹带 MB 级 b64）、不落会话 jsonl——重载会话由 ImageReferenceThumb 经
 * readFileBinary 盘读还原。非 image 变体零变化（纯联合扩展）。
 */
export type AgentMessageReference = Attachment | (ImageAttachment & { dataUrl?: string });

export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolResults?: Array<{ toolCallId?: string; toolId?: string; toolName?: string; output: string; metadata?: unknown }>;
  references?: AgentMessageReference[];
  /**
   * dogfood T1 Stage 2/4：'aborted_partial' = abort/流中断时已流出部分文本的落盘标记
   * （design §3.3）——UI 直出跳过打字机动画。
   *
   * dogfood R2 #16：'intent_restate'（Story 3.3 线 D 意图复述标记）已删——快捷按钮移除后
   * 零消费者，agent 侧停止盖章。字面量保留仅为读旧会话 jsonl 兼容。
   *
   * system 稳定化（09-12）：'session_state_note' = turn 开始追加的 interaction 状态注记
   *（user-role 系统消息，给 LLM 的状态广播）——UI 静默不渲染（jsonl 落盘保留审计）。
   */
  kind?: 'intent_restate' | 'aborted_partial' | 'session_state_note';
  /**
   * dogfood T1 #27②（design §6.3）：深度思考终帧聚合值（delta reasoning 流的终态）。
   * additive optional——旧消息无字段零迁移。只展示 + 持久化，不回传模型。
   */
  reasoning?: string;
  /**
   * dogfood T1 Stage 4（design §6.2 / r4 方案 a）：真流式占位标记——delta 驱动的消息
   * content 增长期间为 true，渲染走 250ms MD 快照轨（绕过 typewriter）；终帧
   * assistant 事件同 id 整条替换后为 false（renderedHtml 收敛）。不持久化（内存态）。
   */
  streaming?: boolean;
  /**
   * dogfood T1 CR-T1-038a：流停滞标记——60s（agentStreamBuffer.STREAM_STALL_MS）无新 delta
   * 时 flush 置位（UI 停滞提示，破「caret 永闪」假活）；新 delta 到达后自动摘标。
   * 仅在 streaming=true 期间有意义；不持久化（内存态）。
   */
  stalled?: boolean;
  /**
   * dogfood R2 #30：工具参数流指示——模型正文输出完毕、tool-call 参数仍在流式期间，
   * 该消息标「正在准备工具调用：X」（agentStreamBuffer markStreamingTool 写入；终帧
   * assistant 替换整条消息即消失）。不持久化（内存态）。
   */
  streamingToolName?: string;
  /**
   * dogfood R2 #50（2026-08-26）：「已落定历史自动接续」标记——重开项目/刷新 UI 的
   * autoResume hydration 落进视图的消息盖章（switchAgentSession 映射处，手动切会话
   * 不盖）。末条 assistant 不走打字机历史回放：重开项目是回到现场而非主动浏览历史，
   * 每次重播末条=噪音，且空泡首帧打断跳底量高（#50 根因半）。不持久化（内存态）。
   */
  settledHistory?: true;
  /**
   * Story 3.5 渐进披露（additive optional，旧消息无字段 → 不分组，向后兼容）：
   * 运行时纯代码盖章（活跃批量存在时 agent 侧 stampBatchOnMessage）。`<BatchGroup>` 按契约字段
   * 分组（非文本正则）；batchKind='report' 的消息渲染 `<BatchReportCard>`（L0 全景）。
   */
  batchId?: string;
  batchKind?: BatchKind;
  /**
   * 09-12 子2 fallback chains（design §7.2）：本条 assistant 消息实际由哪个模型生成
   * （backend SessionMessage.generatedBy 透传——fetch 对账/历史装载路径携带；流式终帧
   * 事件不带，回合结束对账后补上）。UI 终态徽标「实际模型 B · 回退自 A」数据源；
   * additive optional——旧消息无字段零迁移。
   */
  generatedBy?: {
    keyId: string;
    modelId: string;
    /** 仅发生过回退时携带（≥1 条逐家失败记录）。 */
    fallbackFrom?: Array<{ keyId: string; modelId: string; reason: string }>;
  };
  createdAt: number;
};

export type AgentSessionMeta = {
  id: string;
  title: string;
  projectPath: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  permissionMode?: AgentMode;
  /** Story 3.1: persisted leader behavior mode (normal/discuss/plan). */
  behaviorMode?: AgentBehaviorMode;
  /**
   * W4（09-21-subagent-bg-decouple U6）：会话角色（IPC additive——SessionMeta 既有字段
   * 首次透出）。'child' 行已被 shell `agent:list-sessions` 默认过滤，本字段在 UI 侧是
   * 防御面（auto-resume 守卫消费——isPrimaryListableSession 住 projectRunBusy，见其注）。
   */
  sessionRole?: 'primary' | 'child' | 'fork';
  /** W4：agent 名（链 stub parent 过滤的 UI 侧防御判据——mirror shell isListableSession）。 */
  agentName?: string;
};

export type AgentChildStreamEvent = {
  source: 'subagent' | 'skill';
  role: string;
  sessionId: string;
  depth: number;
  event:
    | { type: 'assistant'; data: { id: string; content: string; toolCalls?: unknown[]; reasoning?: string } }
    | { type: 'tool'; data: { id: string; results: unknown[] } }
    /**
     * dogfood T1 Stage 5（design §3.1/§6.4，D5）：子 agent 增量 delta——S2 落在 agent 侧
     * （makeChildOnDelta，messageId = child loop 预分配 assistantId），UI 此处消费（child
     * 占位消息进 ChildExecutionGroup 组内流式）。
     */
    | { type: 'delta'; data: { messageId: string; channel: 'text' | 'reasoning' | 'tool'; delta: string; toolName?: string } }
    /**
     * dogfood 第二轮 findings #3（子 agent 派发起点零信号）：child runLoop 启动前的起点信号
     * （无载荷，agent 侧 emitChildStarted）——UI 据此建 started live 占位（agentEvents 活跃
     * 分支 → agentStreamBuffer.ensureChildStartedPlaceholder）。additive：旧消费者忽略。
     */
    | { type: 'started'; data: Record<string, never> }
    /**
     * 09-12 子2 fallback chains（design §7）：子 agent 循环内的模型切换（child 通道冒泡）。
     * additive：旧消费者忽略。载荷引用 shared-contracts 单源（CR-15——回退事件形状
     * 五处结构复制收敛；from/to/reason/attempt + 链车道 nodeId/role 同一 data 接口）。
     */
    | { type: 'model-fallback'; data: ModelFallbackEventData };
};

export type AgentStreamEvent =
  | { type: 'assistant'; data: { id: string; content: string; toolCalls?: unknown[]; kind?: 'intent_restate' | 'aborted_partial'; reasoning?: string; batchId?: string; batchKind?: BatchKind } }
  | { type: 'tool'; data: { id: string; results: unknown[]; batchId?: string; batchKind?: BatchKind } }
  | { type: 'confirm_required'; data: { sessionId?: string; callId: string; name: string; input: unknown; createdAt?: number } }
  | { type: 'done'; data: { status: string } }
  | { type: 'error'; data: { message: string } }
  | { type: 'child'; data: AgentChildStreamEvent }
  | { type: 'compaction'; data: { compactedCount: number } }
  /**
   * dogfood T1 Stage 2/3：delta / 链事件变体（RuntimeEventPayload additive 扩展，S2 落
   * agent 侧；UI 侧 Stage 3 只消费到「run 态计数」，正文流式渲染 S4（agentEvents 分发器）。
   */
  | { type: 'delta'; data: { messageId: string; channel: 'text' | 'reasoning' | 'tool'; delta: string; toolName?: string } }
  | { type: 'chain-delta'; data: { nodeId: string; role: string; phase?: string; channel?: 'text' | 'reasoning'; messageId: string; delta: string; seq: number } }
  /**
   * 09-13 子2 W4（design §4）：哨兵 paused 帧 additive 携带暂停理由（普通节点 done 帧不带——
   * 非 paused 终态不带）。additive：旧消费者不读该字段照旧。
   */
  | { type: 'chain-node-done'; data: { nodeId: string; status: string; pauseKind?: ChainNodeDonePauseKind } }
  /**
   * 09-13 子2 W3（design §2）：节点终态产出快照（五 kind summary）。additive：旧消费者忽略
   * （agentEvents dispatcher default 分支）；载荷类型 mirror 单源 = chainStreamBuffer（agent 包
   * types.ts 的 UI 镜像，CHAIN_NODE_ORDER 先例）。消费方 = 子3 写作页时间线。
   */
  | { type: 'chain-node-artifact'; data: ChainNodeArtifactData }
  /**
   * 09-13 子2 W4（design §3，B 定案）：链内工具调用（agent-loop 工具执行 seam；nodeId 当前恒
   * draft-writer-agent）。additive：旧消费者忽略（dispatcher default 分支）；载荷 mirror 单源 =
   * chainStreamBuffer。消费方 = 子3 写作页时间线（调查层）。
   */
  | { type: 'chain-tool'; data: ChainToolEventData }
  /**
   * 09-12 子2 fallback chains（design §7）：模型切换事件（leader 对话车道 / 链车道）。
   * additive：旧消费者忽略。from = 失败家解析身份，to = 接管条目；链车道带 nodeId/role。
   * 载荷引用 shared-contracts 单源（CR-15——与 child 通道变体同一 data 接口）。
   */
  | { type: 'model-fallback'; data: ModelFallbackEventData }
  /**
   * 09-12 子5 R6（design §11）：leader 会话上下文窗口占用量（估算口径与压缩触发同源
   * ——prepareContext loadTokens × 校准比；仅 leader 流式车道发射）。windowTokens 为
   * **注入原值**（assignment 未知窗口 → null——UI 收 null 隐藏条，不得用 1M 缺省充数）。
   * additive：旧消费者忽略。agent 侧发射源已接线（loop.ts onContextUsage →
   * streamMessage → 本变体；非流式 sendMessage 与桥车道不经 runLoop，不发射）。
   */
  | { type: 'context-usage'; data: { usedTokens: number; windowTokens: number | null; redlinePercent: number } }
  /**
   * 09-12 子4 W4（design §8）：桥车道运行期通知——`sendback`（present_result 打回重跑
   * 一次）/ `sendback-missed`（二次未调接受 + 警告）/ `soft-denied`（**MCP 主体**工具软拒
   * 三形态任一信号命中 = 预授权缺失，AC7 诊断入口）。additive：旧消费者忽略。
   * 09-19 工具面修复批 R5：增 `builtin-tool-started`——模型发起 agy 内置工具调用（离开桥
   * 工具族），`toolName` 携被调工具名；纯观测相位（不断言该调用失败）。
   * R6（F13）：增 `builtin-tool-denied`——该内置调用被 headless 权限拦下（软拒的内置工具
   * 主体侧，与 `soft-denied` 的 MCP 预授权语义分开）。载荷单源 mirror = agent 包 types.ts
   * 的 AgyBridgeNoticeData。
   */
  | {
      type: 'bridge-notice';
      data: {
        notice: 'sendback' | 'sendback-missed' | 'soft-denied' | 'builtin-tool-started' | 'builtin-tool-denied';
        toolName?: string;
      };
    }
  /**
   * W4（09-21-subagent-bg-decouple / W2 §3.1）：后台任务终态事件——任务到达终态时发一次
   * （外层 sessionId = 派发方 parent sid；条目键取 data.childSessionId）。notify 随载荷携带，
   * silent 不出 toast（呈现裁量在消费面）。additive：旧消费者忽略。
   * 载荷 mirror 单源 = agent 包 types.ts BgTaskUpdateEventData。
   */
  | {
      type: 'bg-update';
      data: {
        taskId: string;
        childSessionId: string;
        role: string;
        status: 'completed' | 'failed' | 'aborted';
        digest: string;
        notify: 'toast' | 'wake' | 'silent';
        /** 派发时刻（CR-14，agent 包 types.ts 同名字段镜像）——耗时显示防 ~0s 塌缩。 */
        startedAt: number;
        error?: string;
      };
    };

export type AgentSkillInfo = {
  name: string;
  description?: string;
  location: string;
  format: string;
  source?: 'project' | 'external';
};

export async function createAgentSession(
  projectPath: string,
  mode?: AgentMode,
  behaviorMode?: AgentBehaviorMode,
  participationGear?: ParticipationGear,
) {
  return api.createAgentSession({
    agentName: 'writer',
    projectPath,
    mode: mode ?? 'suggest',
    behaviorMode: behaviorMode ?? 'normal',
    participationGear: participationGear ?? undefined,
  }) as Promise<{ id: string; agentName: string; projectPath: string; status: string; messages: AgentMessage[] }>;
}

/** 会话消息的原始线形态（getAgentSession IPC 返回；images 为 B2 落 jsonl 的指针字段）。 */
type RawSessionMessage = AgentMessage & {
  images?: Array<{ path?: unknown; b64hash?: unknown; name?: unknown }>;
};

/**
 * 09-01 B4（R2.6 历史加载映射）：user 消息的 `SessionMessage.images` 指针
 * （`Array<{path, b64hash, name}>`，B2 载荷形态）→ `AgentMessage.references` 的 image
 * 附件（label=name，缺名回落路径 basename）。references 是 UI 内存态从不落 jsonl——
 * 重载/重启后气泡缩略图靠此映射重建（AC12 后半）；无 images 的消息原样返回零变化。
 */
function mapHistoryImagesToReferences(message: RawSessionMessage): AgentMessage {
  if (message.role !== 'user' || !Array.isArray(message.images) || message.images.length === 0) {
    return message;
  }
  const imageReferences: AgentMessageReference[] = message.images
    .filter((img): img is { path: string; b64hash?: unknown; name?: unknown } =>
      typeof img?.path === 'string' && img.path.length > 0)
    .map((img) => ({
      type: 'image' as const,
      id: img.path,
      label: typeof img.name === 'string' && img.name.length > 0 ? img.name : (img.path.split('/').pop() ?? img.path),
      path: img.path,
      b64hash: typeof img.b64hash === 'string' ? img.b64hash : '',
    }));
  if (imageReferences.length === 0) return message;
  return { ...message, references: [...(message.references ?? []), ...imageReferences] };
}

export async function fetchAgentSession(sessionId: string, projectPath?: string) {
  const session = await api.getAgentSession(sessionId, projectPath) as ({
    id: string;
    status: string;
    messages: RawSessionMessage[];
    permissionMode?: AgentMode;
    behaviorMode?: AgentBehaviorMode;
    /**
     * Story 3.5: session-persisted participation gear + balanced/hands_off options.
     */
    participationGear?: ParticipationGear;
    balancedAskCategories?: BalancedAskCategory[];
    trustAdjudication?: boolean;
    /**
     * W4（09-21-subagent-bg-decouple）：会话角色 + 父会话（SessionState 既有字段首次被
     * renderer 消费）——检视态标记（agentViewReadonly）与返回键（child → parent）推导源。
     */
    sessionRole?: 'primary' | 'child' | 'fork';
    parentId?: string;
  } | null);
  if (!session) return session;
  return { ...session, messages: (session.messages ?? []).map(mapHistoryImagesToReferences) };
}

export async function setAgentSessionMode(sessionId: string, projectPath: string | undefined, mode: AgentMode) {
  return api.setAgentSessionMode(sessionId, projectPath, mode);
}

/**
 * Story 3.1: persist the leader runLoop's behavior mode (normal/discuss/plan).
 * Like the permission mode, it is a session-level setting the runtime applies
 * to the next turn; refused while a run is in flight (ok === false).
 */
export async function setAgentSessionBehaviorMode(sessionId: string, projectPath: string | undefined, behaviorMode: AgentBehaviorMode) {
  return api.setAgentSessionBehaviorMode(sessionId, projectPath, behaviorMode);
}

/**
 * Story 3.5: set the leader's participation gear (smart/steer/balanced/hands_off)
 * plus the balanced 档 ask-categories / hands_off trustAdjudication options.
 * Session-level persistence; refused while a run is in flight (ok === false —
 * the next turn applies a retried change; mid-run switching goes through the
 * leader's set_participation_gear tool via chat).
 */
export async function setAgentSessionParticipationGear(
  sessionId: string,
  projectPath: string | undefined,
  gear: ParticipationGear,
  options?: { balancedAskCategories?: BalancedAskCategory[]; trustAdjudication?: boolean },
) {
  return api.setAgentSessionParticipationGear(sessionId, projectPath, gear, options);
}

export async function deleteAgentSession(sessionId: string, projectPath?: string) {
  return api.deleteAgentSession(sessionId, projectPath);
}

/**
 * 手动上下文压缩（thinking adapters task D 块触发 ①，design §3.2）：对指定会话立即
 * 跑一次摘要压缩。返回 false = 无可压缩内容 / 会话不存在 / 运行时未接线——按
 * 「不可用」呈现，不抛错。成功路径的提示由 compaction 流事件统一弹出（agentEvents）。
 */
export function compactAgentSession(sessionId: string): Promise<boolean> {
  return api.compactAgentSession(sessionId);
}

export type TruncateSessionResult =
  | { ok: true; removed: number }
  | { ok: false; reason: 'not-found' | 'running' | 'tool-activity' };

/** 从此截断（dogfood 2026-08-21）：纯对话尾巴专用，含工具痕迹由 runtime 拒绝。 */
export function truncateAgentSession(sessionId: string, messageId: string) {
  return api.truncateAgentSession(sessionId, messageId) as Promise<TruncateSessionResult>;
}

export async function listAgentSessions(projectPath: string, opts?: { includeAllRoles?: boolean }) {
  const result = await api.listAgentSessions(projectPath, opts) as { sessions: AgentSessionMeta[] };
  return result.sessions;
}

/**
 * W4（09-21-subagent-bg-decouple）：后台任务注册表行的 UI 镜像（agent 包 BgTaskRecord 的
 * 消费子集——UI 只读呈现，不镜像 Zod 层）。'running' 行无 result；终态行 completed 携
 * result.content（bg_task_result 领取面在 leader 工具侧，UI 不展示全文）。
 */
export type AgentBgTaskRecord = {
  taskId: string;
  parentSessionId: string;
  childSessionId: string;
  role: string;
  projectPath: string;
  promptDigest: string;
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';
  startedAt: number;
  updatedAt: number;
  notify: 'toast' | 'wake' | 'silent';
  result?: { content: string };
  error?: string;
  claimed?: boolean;
};

/** W4：后台任务注册表只读查询（`agent:bg-tasks`）——后台任务条 hydrate 数据源。 */
export async function listAgentBgTasks(projectPath: string): Promise<{ tasks: AgentBgTaskRecord[] }> {
  return api.listAgentBgTasks(projectPath) as Promise<{ tasks: AgentBgTaskRecord[] }>;
}

export async function listAgentSkills(projectPath: string) {
  const result = await api.listAgentSkills(projectPath);
  if (Array.isArray(result)) return result as AgentSkillInfo[];
  return ((result as any)?.skills ?? []) as AgentSkillInfo[];
}

export async function resolveAgentConfirmation(sessionId: string, callId: string, approved: boolean) {
  return api.resolveAgentConfirmation(sessionId, callId, approved);
}

/**
 * Story 4.3 Step 4：resume / redo / abort a paused chapter chain via structured IPC
 * （mirror 4.6 PatchReview accept/reject——UI 直接调结构化入口，非经 leader LLM 解释，design §3.5 D7）。
 * 前置：write_chapter paused → chapter_review metadata → chapterReviewSlice.setPausedReview。
 * 三动作 continue/redo/abort 调此 fn → `closure:resume-chapter-chain` IPC → runChapterChain 续跑/重跑/弃链段。
 * 返 RunChapterChainSummary：caller（chapterReviewSlice）据 status 和解 pausedReview。
 */
export async function resumeChapterChain(input: ResumeChapterChainInput): Promise<RunChapterChainSummary> {
  return api.resumeChapterChain(input);
}

// ── 链流程重排 W4（R6 / 09-13 子3 W6）：章卡衍生状态面（shell handler 在位、本波补 preload
// 暴露——两通道的 UI api 封装归本文件，resumeChapterChain 同族归属）。──

/**
 * 查询注册章的衍生状态新鲜度（`closure:chapter-derivation-status` IPC）。轻量 best-effort：
 * 查询侧失败返空 chapters（不 throw）——章卡 stale 徽标 / 重提取按钮态数据源。
 */
export async function chapterDerivationStatus(
  input: { projectPath: string; chapterId?: string },
): Promise<ChapterDerivationStatusResult> {
  return api.chapterDerivationStatus(input);
}

/**
 * 链外重提取（`closure:re-extract-chapter` IPC）：盘上该章正文 standalone 重跑提取段
 * （E1-E9 幂等写），修复「落盘后手改 / E 段失败章标」的衍生状态漂移。autonomy 缺省
 * 'suggest'（shell 侧默认保守——story-sync 反哺补丁默认人审，mirror resume 终态分流）。
 */
export async function reExtractChapter(
  input: { projectPath: string; chapterId: string; autonomy?: 'readonly' | 'suggest' | 'auto' },
): Promise<ReExtractChapterResult> {
  return api.reExtractChapter(input);
}

/**
 * Story 7.1 Route 1：B trigger 选区指挥精修——编译改稿意图（design §1[2] / §4.2）。
 *
 * draft checkpoint pause 后，用户在 TipTap 选段 + 写粗指令 → 调本 fn → `closure:compile-revision-intent`
 * IPC → revision-optimizer 子 agent 编译 → 返 RevisionIntent（用户确认关用）OR null（编译失败 graceful）。
 * 确认后 UI 调 resumeChapterChain({ action: 'redo', revisionIntent: 确认后的 intent, ... }) 触发段落级改稿。
 */
export async function compileRevisionIntent(
  input: CompileRevisionIntentInput,
): Promise<CompileRevisionIntentResult> {
  return api.compileRevisionIntent(input);
}

/**
 * dogfood T1 Stage 3（r7 全局监听重构）：流事件消费统一走 store 级全局监听
 * （agentEvents.initAgentEvents——一次注册永不清退，按 sessionId+projectPath 分发活跃/
 * 后台）。本函数只负责 **invoke**——不再自带 per-invocation 订阅（旧 activeAbort 8 处
 * 清理点随之退役），返回 promise 供发送方做「invoke reject 且无 error 事件」的兜底
 * （防 spinner 永卡）+ D4 结构化拒绝（status:'rejected'）的分发。
 *
 * `attachments` are structured (selection / chapter / file) references the runtime
 * renders into the prompt — NOT flattened into the content string.
 * To abort, call window.orisonDesktop.abortAgentRun(sessionId).
 */
// dogfood T1 CR-T1-031：拒绝形态契约同步——shared-contracts OrisonDesktopApi 已扩
// StreamAgentMessageResult（status:'rejected' + code/heldBySessionId/projectPath，含
// CR-T1-013 的 session_run_active）。本包自立类型退役，re-export 契约单源（既有 import
// 消费点零改动）。
export type { StreamAgentMessageResult };

export function streamAgentMessage(
  sessionId: string,
  content: string,
  attachments?: Attachment[],
): Promise<StreamAgentMessageResult> {
  return api.streamAgentMessage({ sessionId, content, attachments });
}

/** W4：后台任务取消（`agent:abort-run` 既有通道，child sid 键控）——组件经此收口（boundary rule）。 */
export function abortAgentRun(sessionId: string): Promise<boolean> {
  return api.abortAgentRun(sessionId);
}
