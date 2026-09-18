import { z } from 'zod';
import type { NormalizedSkill } from './skill/types';
import type { SessionPermissionMode } from './runtime/toolPolicy';
import type { SerializedSkillRunState } from './runtime/skillRunState';
import type { RunSnapshotSummary } from './contracts/run';
import type { AgentBehaviorMode, BatchKind, BalancedAskCategory, ModelFallbackSwitchEvent, ParticipationGear } from '@orison/shared-contracts';

// ── Agent Config ──

const _agentConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  model: z.object({
    keyId: z.string(),
    modelId: z.string(),
  }).optional(),
  maxSteps: z.number().int().positive().default(50),
  temperature: z.number().min(0).max(2).optional(),
});

export type AgentConfig = z.infer<typeof _agentConfigSchema>;

// ── Tool Types ──

export interface SkillExecutionResult {
  skill: string;
  outputs: string[];
  checkpoints: string[];
  pendingConfirmations: Array<{ name: string }>;
  nested: Array<{ skill: string }>;
}

export interface SkillExecutorInvokeOptions {
  abort?: AbortSignal;
  spawnDepth?: number;
  emitChildEvent?: (event: ChildStreamEvent) => void;
  /** Surface a skill's pending tool confirmation to the UI as it arises. */
  emitConfirmation?: (pending: PendingConfirmationState) => void;
}

export interface SkillExecutorRef {
  loadSkill?(sessionId: string, skillName: string): Promise<NormalizedSkill | undefined>;
  executeSkillByName(
    sessionId: string,
    skillName: string,
    request?: string | { input?: string },
    options?: SkillExecutorInvokeOptions,
  ): Promise<SkillExecutionResult>;
  runSubagent(
    parentSessionId: string,
    role: string,
    prompt: string,
    options?: SkillExecutorInvokeOptions,
  ): Promise<{ content: string }>;
  /**
   * Story 4.5：leader 侧工具子 agent 派发 seam（yaml 契约驱动，design §3.3 / D1-b）。
   *
   * runChildAgent 变体——区别在 system/user 来源：runChildAgent/loadAgentDefinition 读 `.md`
   * agent definition（systemPrompt + allowedTools frontmatter）；本方法读 `prompts/<role>.yaml`
   * （ADR-4 单契约源：system 段 + user 段 mustache 模板），caller 传 vars 渲染 user 段 + allowedTools
   * 限制可见工具（caller 责任收窄白名单，防子 agent 拿写工具）。
   *
   * 派发机制同 runChapterChain：经 SubagentRuntime.dispatch（createChildSession + narrowPermission +
   * evict），child session 跑 runLoop（system = yaml system + baseRuntimeSystemPrompt；tools =
   * allowedTools 过滤；maxSteps 30）。只返 `{content}`（context isolation：子 agent 只回最终内容）。
   *
   * @param parentSessionId  leader 会话（dispatchSubagent 父）。
   * @param role             prompts/<role>.yaml 的 role（如 'director-agent'）。
   * @param vars             user 段 `{{var}}` 渲染变量（renderTemplate）。
   * @param options.abort    子 agent abort 信号。
   * @param options.spawnDepth 入口 spawnDepth（leader→子 agent 兄弟于 leader→chain，depth+1）。
   * @param options.allowedTools 可见工具白名单（缺省→全工具，慎用）。
   * @returns `{content}` —— 子 agent assistant 内容（caller 按 role 的输出契约 parse）。
   */
  runAgentWithExplicitSystem(
    parentSessionId: string,
    role: string,
    vars: Record<string, string>,
    options?: SkillExecutorInvokeOptions & { allowedTools?: string[] },
  ): Promise<{ content: string }>;
  /**
   * Story 4.0：leader `write_chapter` tool 经此派发写章战术链段（design §4.7/§4.8 / implement.md 6.1）。
   * runtime（WorkflowRuntime）实现此方法（Step 5.2 已建）；leader runLoop 的 tool ctx.skillExecutor 即
   * runtime，故 local tool 可经 ctx.skillExecutor.runChapterChain(...) 触发链段（mirror spawn_agent 模式）。
   *
   * 4.1 Step 4：options.onAccept（accept 分支产 chapter_accept，不写盘）+ options.nowISO（入口注入时间戳）。
   *
   * 4.3 Step 1（CR-2）：options.resume.fromSnapshot=true 时，runChapterChain 读 runState.getChainSnapshot
   * （parentSessionId）→ 推导 resumedCompletedNodes + initialArtifacts → runChain 跳过已完成节点（design §3.3）。
   * 缺省（不传 / fromSnapshot=false）→ 从头跑（4.0 行为，向后兼容）。chainSnapshot 缺/损坏 → graceful 降级
   * （从头跑 + warn 日志，AC7 不静默认错）。leader 再派 resume directive 经 options 传——IPC 接通留 Step 3。
   */
  runChapterChain(
    parentSessionId: string,
    initialArtifacts: Record<string, unknown>,
    options?: {
      requirement?: string;
      abort?: AbortSignal;
      onAccept?: (
        snapshot: import('./contracts/run').RunSnapshot,
        ctx: { nowISO: string },
      ) => import('@orison/shared-contracts').ChapterAcceptResult | undefined;
      nowISO?: string;
      /** 4.3 Step 1 / CR-2：resume 读回 directive（additive optional，缺省 = 从头跑）。 */
      resume?: {
        fromSnapshot?: boolean;
        /**
         * 链流程重排 W2（R3 终稿手改通道）：人手改正文**全文**（resume-chapter-chain action='accept'
         * 携带）。runChapterChain resume 读回处经 applyEditedDraft 单源覆写 draft.initial（text +
         * wordCount 机械重算 + 申报类 stale 清理）——E 段续跑对改后正文提取。shell resume 入口 F1a
         * 立即落正文也用同一 helper 组候选（两入口单源）。
         */
        editedDraft?: string;
      };
      /**
       * 4.3 Step 2：checkpoint 策略（CheckpointPolicy，additive optional）。pauseStages 决定链段在哪些 checkpoint
       * scheduled pause（半自动/微操模式交还 leader 人检）。入口层（write_chapter / closureChainIpc）从
       * session.permissionMode 经 deriveCheckpointPolicy 推导后传入。缺省 = 全自动 no-pause（零回归）。
       */
      mode?: import('./contracts/run').CheckpointPolicy;
      /**
       * 4.3 Step 3：redo directive（design §3.4，additive optional）。配合 resume——移除 redo.nodeId 出
       * resumedCompletedNodes 让其重跑 + feedback 注入 draft-writer {{revisionFeedback}}。消费点 =
       * resume-chapter-chain IPC redo action（write_chapter 不直接用，签名对齐 runtime）。
       *
       * Story 7.1/7.2/7.4：revisionIntent / guardOverride / loopNodes additive optional（与 workflow.ts
       * WorkflowRuntime.runChapterChain redo 签名同步）。write_chapter auto_revise leader redo 用 revisionIntent
       * + loopNodes（闭环四节点）；IPC redo action 用 feedback / revisionIntent / guardOverride。
       */
      redo?: {
        nodeId: string;
        feedback?: string;
        revisionIntent?: import('@orison/shared-contracts').RevisionIntent;
        guardOverride?: 'force-accept';
        loopNodes?: string[];
      };
      /**
       * dogfood T1 Stage 6（design §4 / r1）：链事件通道（chain-delta / chain-node-done）——
       * additive optional。leader 路径 write_chapter 传 ctx.emitChainEvent（streamMessage 装配处
       * 注入 sendEvent 包装）；dogfood 路径 closureChainIpc 构造（getWin webContents.send）。
       * 缺省不开（测试 / 非流式车道零事件，零回归）。
       */
      emitChainEvent?: (event: ChainStreamEvent) => void;
    },
  ): Promise<RunSnapshotSummary>;
  /**
   * dogfood R2 #105 缝①（R2.1）：write_chapter 自家租约重入分派所需的快照 seam。
   *
   * runtime（WorkflowRuntime）已实现两方法（resume IPC abort 入口 / RunStateStore 读回的既有
   * 成员）；leader runLoop 的 tool ctx.skillExecutor 即 runtime，结构化类型天然满足。
   *
   * write_chapter busy 检测点解析 `chain_run_active|heldBy=<id>` 识别自家 paused 链时：
   * - getChainSnapshot 读快照 chapter_brief_input.brief 与本次 chapterBrief 比对——有差异（①②改卡
   *   语义）→ clearChainSnapshot 释放租约 + fresh 重跑（briefHash 变 → cardChanged=true → 全量重查）；
   * - 无差异 / 无 brief / 拿不到快照（③维持原案默认语义）→ resume:{fromSnapshot:true} 裸 continue
   *   重调（挂起 belt 自动转重查 + approvedDeviations 绑定）。
   *
   * optional——mock / 旧 runtime 不实现时 write_chapter 拿不到快照 → 按缺省语义保守走 resume。
   */
  getChainSnapshot?(sessionId: string): import('./contracts/run').RunSnapshot | undefined;
  /** R2.1 分派规则 fresh 车道用（mirror runtime.clearChainSnapshot：释放活动链守卫 + 清快照）。 */
  clearChainSnapshot?(sessionId: string): boolean;
  /**
   * Story 3.4（C-A1 backfill 接线）：leader `diagnose_impacts` tool 经此触发旧章 world-state 补提取
   * （design §3 / world-state-backfill.ts:146）。mirror runChapterChain 模式——runtime 持 generateImpl +
   * 能构造 writeWorldEvents writer（registry.get('write_world_events')），故 local tool 经
   * ctx.skillExecutor.runBackfill(...) 触发。
   *
   * 流程：读 project.yaml → 对每个已写 episode 解析 chapterId（resolveChapterIdForEpisode）→ 读 prose →
   * 组装 BackfillInput → backfillWorldState（5 轴 extractor + merge + writer）。
   *
   * **幂等**：per-slice idempotency（稳定 slice.id `${episodeId}:${storyTime}` 替换不累积）。
   * **graceful**：generateImpl 不可用 / 无旧章 / 读盘失败 → {ok:false, reason}（不崩，caller 继续 degrade）。
   * **context isolation**：只返汇总计数（episodesProcessed/Written/totalPatches）+ ok/reason，不灌全 writes。
   *
   * optional——旧 runtime / mock 不实现此方法时 diagnose_impacts 走 graceful degrade 路径（mirror loadSkill?）。
   *
   * @param parentSessionId leader 会话（resolve projectPath）。
   * @param options.abort   backfill abort 信号。
   * @returns               摘要（context isolation——汇总计数 + ok/reason）。
   */
  runBackfill?(
    parentSessionId: string,
    options?: { abort?: AbortSignal },
  ): Promise<{
    ok: boolean;
    episodesProcessed?: number;
    episodesWritten?: number;
    totalPatches?: number;
    degraded?: boolean;
    reason?: string;
    /**
     * Story 8.1 Step 6：summary 重建 pass 成功物化数（重提取落表后逐 episode materialize）。
     * 仅当 materialize_chapter_summary 工具已注册（pass 真跑）才携带——旧 wiring 返回形状零变。
     */
    summariesMaterialized?: number;
    /**
     * Story 8.1 Step 6：per-episode 物化失败明细（容错不中断整批；有失败才携带）。
     * summary 是二级 DERIVED 缓存——其失败不翻 ok/degraded/reason，只经此字段透传。
     */
    summaryFailed?: Array<{ episodeId: string; error: string }>;
  }>;
  listSkillNames?(sessionId: string): Promise<string[]>;
}

/**
 * dogfood T1 Stage 2（design §3.1 / #27①）：增量 delta 事件载荷。messageId = runLoop 预分配的
 * assistantId——终帧 assistant 消息/事件用同一 id（消除「占位消息→终帧合并」的 id 漂移，r4 坑 5）。
 * channel 区分正文与深度思考（#27② reasoning 穿线）。additive：既有消费者不认识 delta 变体照旧忽略。
 * dogfood R2 #30：channel 增 `tool`——工具参数流活性（正文毕、参数仍在流的静默窗指示）；
 * toolName 仅该调用首块携带。
 */
export interface StreamDeltaData {
  messageId: string;
  channel: 'text' | 'reasoning' | 'tool';
  delta: string;
  /** `tool` 通道：调用首块携带的工具名。 */
  toolName?: string;
}

/**
 * 子4 W4（09-12 agy MCP 工具桥）：桥车道运行期通知载荷。`soft-denied` = MCP 工具软拒
 * 三形态任一信号命中（预授权缺失——W0 §2 matcher）；`sendback` / `sendback-missed` =
 * present_result 打回一次 / 二次未调接受（§5.3）。
 */
export interface AgyBridgeNoticeData {
  notice: 'sendback' | 'sendback-missed' | 'soft-denied';
}

/**
 * 09-12 子5 R6（design §11）：leader 会话上下文窗口占用快照载荷。usedTokens =
 * prepareContext loadTokens × 校准比（估算口径与压缩触发同源——同一份计算，非两处
 * 公式各自维护）；windowTokens = **注入原值**（contextWindowTokens 未注入 → null——
 * UI 收 null 隐藏条，不得用 1M 缺省充数，那是压缩行为的防御回落不是显示真相，与
 * assignmentContextWindowTokens「不猜窗口」语义一致）；redlinePercent = clamp 后生效
 * 红线（UI 红线变色消费——与红线压缩触发同值）。仅 leader 对话流式车道发射
 * （child/chain 事件不含本变体；非流式 sendMessage 无事件面不发）。
 */
export interface ContextUsageEventData {
  usedTokens: number;
  windowTokens: number | null;
  redlinePercent: number;
}

/**
 * 09-12 子2 fallback chains（design §7）：一次模型切换的运行期事件载荷。from/to 是网关
 * 环回传的**真实身份**（from = 失败家的解析身份，to = 接管条目 ref）；`attempt` 为 1-based
 * 失败 attempt 序号。链车道（ChainStreamEvent 同型变体）由 chapter-chain 装配处补
 * nodeId/role（链节点运行卡按它翻转「当前模型」chip）；leader/child 车道不携带。
 * additive：既有消费者不认识 'model-fallback' 变体照旧忽略。
 *
 * CR-15（09-12 子2 CR 批）：载荷单源 = shared-contracts `ModelFallbackSwitchEvent`
 *（contracts/generation.ts）+ 链车道扩展（nodeId/role）——RuntimeEventPayload /
 * ChildInnerEvent / ChainStreamEvent 三变体共用本接口；shell 侧 FallbackSwitchEvent 与
 * provider 缝 ModelFallbackSwitch 同引契约类型。
 */
export interface ModelFallbackEventData extends ModelFallbackSwitchEvent {
  /** 链车道专用：发生切换的链节点（链卡 chip 定位）；leader/child 车道缺席。 */
  nodeId?: string;
  /** 链车道专用：节点角色（与 chain-delta 的 role 同源）。 */
  role?: string;
}

export type ChildInnerEvent =
  | {
    type: 'assistant';
    data: {
      id: string;
      content: string;
      toolCalls?: ToolCall[];
      /**
       * dogfood T1 Stage 5（#27② child 侧补齐）：child 终帧 reasoning 透传——child 占位
       * 流式期折叠块在终帧后不丢（mirror leader assistant 事件 additive 字段）。
       */
      reasoning?: string;
      /**
       * BMad CR-T1-017：child 终帧 kind 透传（mirror leader assistant 事件 additive 字段——
       * S5 给 reasoning 修过同型缺口，kind 漏修）。aborted_partial 在子 agent 面可辨（UI 直出
       * 跳过打字机，PRD AC「标记可辨」无车道限定）。
       */
      kind?: SessionMessage['kind'];
    };
  }
  | { type: 'tool'; data: { id: string; results: ToolCallResult[] } }
  /** dogfood T1 Stage 2：子 agent 增量 delta（走既有 child 包装带 source/role/depth，design §3.1）。 */
  | { type: 'delta'; data: StreamDeltaData }
  /**
   * dogfood 第二轮 findings #3（子 agent 派发起点零信号）：子会话装配完、child runLoop 启动前
   * 发一次的起点信号（无载荷）——派发到首批 LLM 输出之间（慢首字节端点可达分钟级）此前零事件，
   * UI 全空窗被误判卡死。additive：既有消费者不认识该变体照旧忽略。
   */
  | { type: 'started'; data: Record<string, never> }
  /**
   * 09-12 子2 fallback chains（design §7）：子 agent 循环内的模型切换事件——走既有 child
   * 包装（source/role/depth）冒泡进子代理组头部。additive：既有消费者不认识照旧忽略。
   */
  | { type: 'model-fallback'; data: ModelFallbackEventData };

export interface ChildStreamEvent {
  source: 'subagent' | 'skill';
  role: string;
  sessionId: string;
  depth: number;
  event: ChildInnerEvent;
}

/**
 * dogfood T1 Stage 6（design §4 / r1）：写章链节点事件载荷。`chain-delta` = 节点流增量
 * （seq = 该 nodeId 在本会话的流式轮次计数，redo/loopNodes 重跑 +1——UI 按 (nodeId, seq)
 * 拼接防旧流混入，r1 坑）；`chain-node-done` = 节点边界步进（status：
 * 'done' | 'error' | 'blocked'，以及 `CHAIN_RUN_SENTINEL_NODE_ID` 终态帧的 run status）。
 * additive：既有消费者不认识这两变体照旧忽略。
 *
 * 09-13 子2 W1（design §1）：`channel` 双通道——text = 正文增量（现状仅 draft-writer 阶段二，
 * 语义不变）；reasoning = 思考流增量（W1 起逐 LLM 节点开）。缺省 'text'（旧事件无此字段 =
 * 正文流，additive 零破坏）。
 */
export interface ChainNodeDeltaData {
  nodeId: string;
  role: string;
  /**
   * 产出阶段标注：draft-writer 相位 'research' | 'writing' | 'declaration'（design §1 H2
   * phase union——子3「写作三层」分层锚）；单发 JSON 节点缺省不带。
   */
  phase?: string;
  /** 流通道（缺省 'text'——正文流语义与既有 UI 解信封依赖不变）。 */
  channel?: 'text' | 'reasoning';
  /** 该轮 assistantId（与 makeAgentLoop / llm-node 预分配的轮消息同 id——UI 侧轮次分段用）。 */
  messageId: string;
  delta: string;
  /** 流式轮次计数（同一 nodeId 每 run 首条 delta 时 +1）。 */
  seq: number;
}

/**
 * 哨兵 paused 帧暂停理由枚举（09-13 子2 W4 design §4）：五暂停面——'escalate'（灰区裁决
 * escalate-pause）/ 'brief'（readonly 档规划卡人审）/ 'draft'（出发核查挂起 researchSuspension
 * 动态 pause）/ 'revision-guard'（保义护栏 soft-violation 动态 pause）/ 'final'（终稿人审
 * checkpoint）。
 */
export type ChainNodeDonePauseKind = 'final' | 'escalate' | 'brief' | 'draft' | 'revision-guard';

export interface ChainNodeDoneData {
  nodeId: string;
  status: string;
  /**
   * 09-13 子2 W4（design §4）：哨兵 paused 帧的暂停理由（additive——仅 `CHAIN_RUN_SENTINEL_NODE_ID`
   * 终态帧携带，普通节点 done 帧不带）。时间线（子3）暂停瞬间可显理由——现有 metadata/summary
   * 通道是 run 结束后的，不够即时（prd R4）。投影单源 = workflow `deriveSentinelPauseKind`
   * （五暂停面；escalatePause 优先于 stage 解析——escalate-pause 的 currentNodeId 停在 through
   * 节点，stage 会误报 'final'/'brief'）。边界声明（design §4）：escalate 的 findings/裁决理由
   * **不入链事件面**（走 metadata/summary 通道——子3 暂停档从 chapter_review metadata / IPC
   * summary 取）。非 paused 终态不携带。
   */
  pauseKind?: ChainNodeDonePauseKind;
}

/**
 * 09-13 子2 W3（design §2）：节点产出快照摘要（`chain-node-artifact` 事件载荷）五 kind。
 *
 * 装配处投影包装（`nodes/chain-node-artifact.ts` 发射形态表单源）在**节点 run 终态后**从 artifact
 * 机械投影产 summary——不侵入节点实现（快照是投影非节点职责）。全部投影 unknown 安全读取
 * （recordOf 防御），缺字段降级 line『（快照缺失）』不造数据；error / blocked 终态走通用行
 * （M4——投影守卫前置判 `{error:true}` 先于产物投影）。
 *
 * UI 镜像同步纪律：`client/ui/src/shared/store/chainStreamBuffer.ts` 平行镜像本 union
 * （CHAIN_NODE_ORDER 先例——UI 包不依赖 agent 包）。
 */
export type ChainNodeArtifactSummary =
  /** 任务卡快照（brief-compiler：chapter_brief artifact 整体）。 */
  | { kind: 'brief-card'; brief: Record<string, unknown> }
  /**
   * 条目清单（world-extractor×5 / promise-emergence）：items 封顶 50（design §6 量控），
   * total = 全量计数（截断时 UI 可示「N/total」）。
   */
  | { kind: 'items'; label: string; items: string[]; total: number }
  /**
   * 审读发现（brief-reviewer / multi-review / completeness-verify）：quote/note 截断 200；
   * total = 全量计数（rows 封顶 50）。verdict = 源 artifact 判定串（completeness 无 verdict
   * 字段——缺省不造）。
   */
  | {
      kind: 'findings';
      verdict?: string;
      summary: string;
      findings: ChainNodeArtifactFindingRow[];
      total: number;
    }
  /** 路由判决（route-agent：decision + reason）。 */
  | { kind: 'route-decision'; decision: string; reason: string }
  /** 单行机械摘要（纯代码节点 / LLM 节点一行产出 / error·blocked·快照缺失降级通用行）。 */
  | { kind: 'line'; line: string };

/** findings kind 单行：label = 维度/实体标签，severity = 源 artifact 原值透传（机械控制信号）。 */
export interface ChainNodeArtifactFindingRow {
  /** 维度/实体标签（multi-review 维名〔+subClass〕/ plan 维度 / completeness 实体标签）。 */
  label: string;
  /** 严重度/判定标记（block|warn|info / hard|soft / missing|under-developed——源值透传）。 */
  severity: string;
  /** 正文或对照引文（截断 200）。 */
  quote: string;
  /** 一句话说明（源 explanation/note，截断 200）。 */
  note: string;
}

/**
 * 09-13 子2 W3（design §2 M6 定案）：节点产出快照事件载荷。发射点 = 装配处 withNodeArtifact
 * 包装（节点 run 终态后），结构性先于同节点 `chain-node-done`（AC2 顺序断言钉死）；环重跑每圈
 * run 终态都发一份（seq 锚归组，不 dedupe）。additive：既有消费者不认识本变体照旧忽略。
 */
export interface ChainNodeArtifactData {
  nodeId: string;
  role: string;
  /**
   * 发射时读该 (session, node) 流式轮次计数器**当前值快照（不消耗）**——与该节点本轮流式
   * delta 同 seq 归组；从未开流的节点（纯代码位 / no-op 圈）= -1（计数器算术零点——
   * `nextChainNodeSeq` 的 `(get(nodeId) ?? -1) + 1` 隐式当前值；UI 可辨「无 attempt 锚」）。
   * 环重跑同 run 共用同 seq（delta 每 run 首条才分配）；跨 run（redo）随 delta seq+1。
   */
  seq: number;
  summary: ChainNodeArtifactSummary;
}

/**
 * 链事件哨兵 nodeId：run 级终态帧（chain-node-done 的 data.nodeId === 本值时 status =
 * runChain 终态 status——'completed' | 'aborted' | 'error' | 'blocked' | 'paused'
 * 〔09-13 W1a 起含 escalate-pause 形态；'auto_revise_pending' 已随链内回环退役〕）。与普通节点
 * id 空间隔离（真实节点 id 不含双下划线前后缀）。
 */
export const CHAIN_RUN_SENTINEL_NODE_ID = '__chain_run__';

/**
 * 09-13 子2 W4（design §3，B 路线定案）：链内工具调用事件载荷。发射 seam = `nodes/agent-loop.ts`
 * 工具执行循环体（executeCallSafely 后）——链内唯一带工具的循环（写手两阶段+补查+申报 + 核实
 * 子循环；createLlmNode 系节点 tools=[] 传空零调用），「draft-writer 阶段一 research 工具为主」
 * 自动成立（AC3）。leader/child 车道不发射（本事件链专用——链内工具调用零消息车道痕迹，
 * A「消息车道复用」已核实不可行）。
 *
 * inputSummary = 归一后 call.arguments JSON 截断 200（agent-loop 单一常数两消费点——与畸形参数
 * 回显先例同形）；status = 输出 `Error:` 前缀机械判；resultCount = 输出字符数恒档（seam 现实：
 * executeCallSafely 只返回 output 字符串——不强改其返回结构透传 ToolResult metadata，结构化计数
 * 档机会主义）。
 *
 * UI 镜像同步纪律：`client/ui/src/shared/store/chainStreamBuffer.ts` 平行镜像本类型
 * （CHAIN_NODE_ORDER 先例——UI 包不依赖 agent 包）。dispatcher default 忽略（additive）。
 */
export interface ChainToolEventData {
  /** 工具调用发生的链节点（当前唯一 'draft-writer-agent'——写手+核实子循环都在该节点位）。 */
  nodeId: string;
  toolName: string;
  /** 调用参数摘要（归一 JSON 截断 200 + '…'）。 */
  inputSummary: string;
  /**
   * 结果规模（**输出字符数恒档**——design §3 定谳：executeCallSafely seam 只返回 output 字符串，
   * 结构化计数需 seam 升级透传 ToolResult metadata，机会主义不承诺）。发射侧恒携带
   * （`output.length`）；optional 形态留给消费面容错（旧事件 / 降级通道）。CR 批 CR-7：三层
   * （本类型 / AgentLoopDeps.onToolCall / UI 镜像）注释同源，形态差异 = 发射恒带 vs 消费容错。
   */
  resultCount?: number;
  status: 'ok' | 'error';
}

export type ChainStreamEvent =
  | { type: 'chain-delta'; data: ChainNodeDeltaData }
  | { type: 'chain-node-done'; data: ChainNodeDoneData }
  /**
   * 09-13 子2 W3（design §2）：节点产出快照事件——节点 run 终态后从 artifact 机械投影的
   * 五 kind summary（发射形态表单源 = `nodes/chain-node-artifact.ts`）。additive：既有消费者
   * 不认识本变体照旧忽略（UI dispatcher default 分支已核实零改动）。
   */
  | { type: 'chain-node-artifact'; data: ChainNodeArtifactData }
  /**
   * 09-13 子2 W4（design §3，B 路线定案）：链内工具调用事件（agent-loop 工具执行 seam 发射；
   * chapter-chain 装配方补 nodeId）。additive：既有消费者不认识本变体照旧忽略（UI dispatcher
   * default 分支零改动——已核实）。
   */
  | { type: 'chain-tool'; data: ChainToolEventData }
  /**
   * 09-12 子2 fallback chains（design §7/§8⑤）：链节点 LLM 的模型切换事件——data 带
   * nodeId/role（链节点运行卡据此翻转「当前模型」chip）。载荷单源 ModelFallbackEventData；
   * leader 的 RuntimeEventPayload 同型变体共用同一 data 接口。additive。
   */
  | { type: 'model-fallback'; data: ModelFallbackEventData };

/**
 * 09-12 稳定化 C 批 CR-P12：压缩摘要调用的流程标签 taskType 单源。runLoop 摘要 seam
 * （agent/loop.ts summarizationGenerate）恒携本值；leader 两车道装配闭包（workflow.ts
 * sendMessage / streamMessage）的 cacheControl 门控以本常量比对——此前生产/门控三处
 * 裸串复制，rename 任一处即静默失效（摘要重付 cache 写溢价且零测试红）。链段摘要
 * （nodes/agent-loop.ts gateSummarizationGenerate）走独立 seam 不经该门控，字面量保留
 *（writer 链红线文件零交集）。
 */
export const CONTEXT_SUMMARY_TASK_TYPE = 'context-summary';

export interface ToolContext {
  sessionId: string;
  projectPath: string;
  abort: AbortSignal;
  skillExecutor?: SkillExecutorRef;
  spawnDepth?: number;
  emitChildEvent?: (event: ChildStreamEvent) => void;
  /**
   * dogfood T1 Stage 6（design §4）：写章链事件通道（chain-delta / chain-node-done）——
   * 与 emitChildEvent 同模式由 streamMessage 装配处注入（sendEvent 包装）；write_chapter
   * 等 leader 工具转发给 runChapterChain（options.emitChainEvent）。缺省不开（mock / 非
   * 流式车道零事件）。
   */
  emitChainEvent?: (event: ChainStreamEvent) => void;
  /** Surface a tool's (e.g. skill's) pending confirmation to the UI. */
  emitConfirmation?: (pending: PendingConfirmationState) => void;
}

export const MAX_SPAWN_DEPTH = 5;

export class SpawnDepthExceededError extends Error {
  constructor(public readonly depth: number, public readonly limit: number = MAX_SPAWN_DEPTH) {
    super(`Spawn depth ${depth} exceeds limit ${limit}; refusing further nesting.`);
    this.name = 'SpawnDepthExceededError';
  }
}

export interface ToolResult {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
  /**
   * 标记该结果即为面向用户的最终答复。为 true 时，agent 主循环不再就此结果
   * 追加生成新一轮回复——用于 skill 这类「输出本身就是回答」的工具，避免
   * skill 已经对用户说完话后，父模型又把同样内容复述一遍。
   */
  terminal?: boolean;
}

export interface ToolDefinition<TParams = any> {
  id: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams, ctx: ToolContext) => Promise<ToolResult>;
}

// ── Skill Types ──

export interface SkillInfo {
  name: string;
  description?: string;
  location: string;
  content: string;
}

// ── Session Types ──

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type RetentionPriority = 'critical' | 'normal' | 'compressible';

/**
 * 消息携带图片的指针形态（task 09-01 B 波 R2.3 / dogfood #45）：path = 项目相对路径
 * （`inbox/images/<file>`，字节已落盘）；b64hash = 落盘字节 sha256 指纹（shell 转述
 * 缓存 key）；name = 展示名（附件 label）。**不内嵌 b64**——jsonl 防膨胀 + agent 零
 * FS（ADR-2），指针→字节的解析/归一/vision 路由收在 shell generate 缝。
 */
export interface SessionImagePointer {
  path: string;
  b64hash: string;
  name: string;
  /**
   * 指针所在项目根（session.projectPath，CR-001 决议 b / BMad CR 2026-09-01）：随线上
   * image part 透出，shell generate 缝据它**精确定位**读盘项目根（免注册库多候选扫描
   * 与跨项目同名歧义）。additive optional——旧消息无此字段缺省，shell 回落既有 fallback
   *（注册库候选根扫描 + b64hash 指纹消歧）。
   */
  projectPath?: string;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolCallResult[];
  createdAt: number;
  retention?: RetentionPriority;
  /**
   * 'aborted_partial' = 流式 abort/中断时已流出部分文本的保留（dogfood T1 §3.3——UI 直出跳过
   * 打字机）。additive optional（旧消息无 kind 照常）。
   *
   * dogfood R2 #16：'intent_restate'（Story 3.3 线 D 意图复述标记）已删——UI 快捷按钮移除后
   * 零消费者，loop 停止盖章。字面量保留仅为读旧会话 jsonl 兼容。
   *
   * dogfood R2 #93（2026-08-28）：'chain_completed_event' = resume 续链完成系统事件回注
   * （notifyLeaderChainCompleted 产）——role 是 'user'（该轮 user 侧输入即此事件），kind 标记
   * 「非作者发言」（jsonl 落盘可审计，防伪造用户消息）。UI 对 user 消息不消费 kind（普通
   * 气泡渲染）；LLM payload 组装（messagesToPayload）只看 role/content，kind 不进模型。
   *
   * system 稳定化（09-12）：'session_state_note' = interaction 会话状态注记（十三路 leader
   * 信号快照，turn 开始 diff 追加在消息尾）。同族语义：非作者发言 + jsonl 落盘审计 + kind
   * 不进模型（messagesToPayload 只看 role/content）。区别：UI 对此 kind **静默**（不渲染
   * 普通气泡——它是给 LLM 的状态广播，非对话内容）。
   */
  kind?: 'intent_restate' | 'aborted_partial' | 'chain_completed_event' | 'session_state_note';
  /**
   * dogfood T1（#27② / design §6.3）：深度思考全文（终帧聚合值，与 delta 流独立）。
   * additive optional——旧 JSONL 无字段读回 undefined 零迁移。持久化 + 展示；
   * S4b（task 08-25 design §5.2）起**多轮回传**——messagesToPayload 装配 assistant
   * 消息时以 `reasoning_content` 字段回传（DeepSeek+tools / Kimi K3 硬义务；GLM 标准
   * API 忽略——无害），Anthropic 侧由协议层组 thinking 块。
   */
  reasoning?: string;
  /**
   * S4b（task 08-25 design §5.1/§5.2）：Anthropic thinking 块签名——工具循环须原样回传
   * （厂商校验签名；缺失时协议层跳过 thinking 块而非伪造）。与 reasoning 同生命周期
   *（终帧聚合 + 持久化；非 Anthropic 路径恒 undefined）。additive optional 零迁移。
   */
  reasoningSignature?: string;
  /**
   * Story 3.5 渐进披露：批量分组标记（additive optional，旧消息无字段 → 不分组，向后兼容）。
   * 运行时纯代码盖章（活跃批量存在时 workflow streamMessage/sendMessage 路径），不靠 LLM 自觉——
   * 范式：盖章=记账=纯代码。UI `<BatchGroup>` 按契约字段分组（非文本正则）。
   */
  batchId?: string;
  /** progress=批量中过程消息 / report=锚点收尾全景（end_batch 后同 turn 消息盖 report）。 */
  batchKind?: BatchKind;
  /**
   * Chat 图片附件指针（task 09-01 B 波 R2.3 / dogfood #45）：createUserMessage 从
   * image 附件提取；messagesToPayload 组 user 消息时按此出 image parts（指针形态）。
   * additive optional——旧消息无字段读回 undefined 零迁移（jsonl 形态守卫只查 role，
   * 读回天然兼容，persistence 无需改）。指针不内嵌 b64：见 {@link SessionImagePointer}。
   */
  images?: SessionImagePointer[];
  /**
   * 09-12 子2 fallback chains（design §7.2）：本条 assistant 消息**实际由哪个模型生成**——
   * 网关环成功注记的 modelRef（解析真实身份，auto-pick 时非 {default,default} 哨兵）+
   * 发生过回退时的逐家失败记录。只在回退机械真正运行过（档位配了链）时由 runLoop 盖章；
   * additive optional——旧消息无字段读回 undefined 零迁移（images 同型先例）。
   * UI 终态徽标（「实际模型 B · 回退自 A」）消费面。
   */
  generatedBy?: {
    keyId: string;
    modelId: string;
    /** 仅发生过回退时携带（二态——与响应 fallbackTrace 同语义）。 */
    fallbackFrom?: Array<{ keyId: string; modelId: string; reason: string }>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  output: string;
  metadata?: Record<string, unknown>;
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error' | 'aborted';

export type WorkflowRunStatus = SessionStatus;

export interface PendingConfirmationState {
  sessionId: string;
  callId: string;
  name: string;
  input: unknown;
  createdAt: number;
}

export interface ConfirmationResolution {
  callId: string;
  approved: boolean;
}

export type RuntimeEventPayload =
  | { type: 'assistant'; data: { id: string; content: string; toolCalls?: ToolCall[]; reasoning?: string } }
  | { type: 'tool'; data: { id: string; results: ToolCallResult[] } }
  | { type: 'confirm_required'; data: PendingConfirmationState }
  | { type: 'done'; data: { status: WorkflowRunStatus } }
  | { type: 'error'; data: { message: string } }
  | { type: 'child'; data: ChildStreamEvent }
  | { type: 'compaction'; data: { compactedCount: number } }
  // dogfood T1 Stage 2（design §3.1）以下三变体 additive——delta = leader 对话增量流（终帧
  // assistant 事件之前的正文/reasoning 增量）；chain-delta / chain-node-done = 写章链节点事件
  //（S6 接线，载荷单源 ChainNodeDeltaData / ChainNodeDoneData，r1）。
  | { type: 'delta'; data: StreamDeltaData }
  | { type: 'chain-delta'; data: ChainNodeDeltaData }
  | { type: 'chain-node-done'; data: ChainNodeDoneData }
  // 09-13 子2 W3（design §2）：节点产出快照（链车道经 emitChainEvent 直发同通道——leader 路径
  // write_chapter 的 emitChainEvent 即本 sendEvent，故 union 须含本变体；additive 忽略）。
  | { type: 'chain-node-artifact'; data: ChainNodeArtifactData }
  // 09-13 子2 W4（design §3）：链内工具调用（链车道经 emitChainEvent 直发同通道——同上 union
  // 须含本变体；additive 忽略）。
  | { type: 'chain-tool'; data: ChainToolEventData }
  // 09-12 子2 fallback chains（design §7）：模型切换事件（leader 对话车道经 onFallback →
  // sendEvent 发射；链车道经 ChainStreamEvent 同型变体）。additive：既有消费者不认识照旧忽略。
  | { type: 'model-fallback'; data: ModelFallbackEventData }
  // 子4 W4（09-12 agy MCP 工具桥，design §8）：桥车道运行期通知——present_result 打回 /
  // 二次未调接受 / MCP 软拒（预授权缺失诊断）。additive：既有消费者不认识照旧忽略；
  // UI 消费面（打回相位提示 + 软拒指向预授权设置）归 W6。
  | { type: 'bridge-notice'; data: AgyBridgeNoticeData }
  // 09-12 子5 R6（design §11）：leader 会话上下文占用快照——runLoop 每步 prepareContext
  // 落定后经 onContextUsage 发射（streamMessage 装配接线 sendEvent）。additive：既有消费者
  // 不认识照旧忽略。
  | { type: 'context-usage'; data: ContextUsageEventData };

export type RuntimeStreamEvent = RuntimeEventPayload;

export interface SessionState {
  id: string;
  agentName: string;
  projectPath: string;
  status: SessionStatus;
  permissionMode?: SessionPermissionMode;
  /**
   * Story 3.1: leader runLoop behavior mode (normal/discuss/plan), orthogonal to
   * permissionMode. Controls how the agent behaves per turn via a prompt segment
   * injected in buildMainRunConfig. See design.md WP1. Undefined → 'normal'.
   */
  behaviorMode?: AgentBehaviorMode;
  /**
   * Story 3.5: 参与档位（smart/steer/balanced/hands_off），与 permissionMode（执行权）/
   * behaviorMode（单 turn 风格）正交的第三值组——管「问什么 / 何时问」。Undefined → 'smart'
   * （消费端 PARTICIPATION_GEAR_DEFAULT）。Session 级持久化，随时调档（批量中途切下一场生效）。
   */
  participationGear?: ParticipationGear;
  /**
   * Story 3.5: balanced 档圈定的必问类别。Undefined → 三项全（BALANCED_ASK_CATEGORIES_DEFAULT）。
   */
  balancedAskCategories?: BalancedAskCategory[];
  /**
   * Story 3.5: hands_off 档灰区处置。false（缺省）= 仍停下问（安全默认）；true = 信任裁决器初审继续。
   * BLOCK 硬违规任何配置都不豁免（§4 硬性打断与档位解耦）。
   */
  trustAdjudication?: boolean;
  /**
   * 链流程重排 W2（R4 / design §3 矩阵，mirror trustAdjudication 先例）：auto 档「强难停点」子开关——
   * 只管**收敛失败**处置（环 cap 超限 / 裁决失败空输出 / 同章连续挂起≥2），权限/环流程/去味门禁/落盘
   * 零差异（不加档先例：hands_off gear trustAdjudication 同构）。'ask'（缺省）= 强难停点开——收敛失败
   * escalate-pause 停下叫人；'auto' = 真全自动——cap 超限两支（去味门禁未过→终弃该章+标记上报 /
   * 已过→采信终稿落盘+标「环未收敛」）+ 裁决失败保守采信+标记 + 连续矛盾≥2 终弃。BLOCK 硬违规任何
   * 配置永不 auto-trust（机械门前置）。UI 设置/会话头钮归子3；本波落字段 + 链消费 + 持久化。
   */
  hardEscalatePolicy?: 'ask' | 'auto';
  messages: SessionMessage[];
  parentId?: string;
  children: string[];
  branchFromMessageId?: string;
  sessionRole?: 'primary' | 'child' | 'fork';
  createdAt: number;
  updatedAt: number;
  error?: string;
  skillRunState?: SerializedSkillRunState;
  contextState?: {
    compactedSummary?: string;
    compactionCount: number;
    lastCompactionAt?: number;
    totalCompactedMessages: number;
    tokenCalibrationRatio: number;
    lastSessionStateNoteHash?: string;
  };
  pinnedContext?: import('./context/pinnedContext').PinnedContextItem[];
}
