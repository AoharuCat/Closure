import type { ReusableAgentNodeContract, ArcBeat, ArchiveIssue, ChapterAcceptArtifact, ChapterAcceptResult, CompileReport, EscalateFinding, ResearchSuspension, RevisionGuardArtifact, NovelStorySyncPayload, StoryTimeDriftWarning } from '@orison/shared-contracts';
import type { ChainNodeDonePauseKind, SessionState } from '../types';
import type { GenerateFn } from '../nodes/llm-node';
import type { SessionPermissionMode } from '../runtime/toolPolicy';

// ── Story 4.0 写章战术链段：RunSnapshot + 节点契约接口 + runChain 选项类型 ──
//
// 本文件是 AgentNode 链段的「契约层」——RunSnapshot（artifact 流转载体）+ 节点接口（AgentNode /
// NodeResult / NodeRunInput）+ runChain 驱动器选项（ChainNodeDef / RunChainOptions / RunChainDeps /
// RunSnapshotSummary）。AgentNode/NodeResult 在 Step 4.1 从 nodes/base.ts 挪入此处（与 RunSnapshot /
// NodeRunInput 同处，清理前置：base.ts 仅留节点工厂，接口归契约层）。
//
// type-only import 避循环依赖：contracts/run.ts ⇄ nodes/llm-node.ts 互引类型（GenerateFn / AgentNode），
// 均为 `import type`（编译期擦除，无运行时循环）。SessionState 来自 types.ts（无反向依赖）。
//
// 期望下游消费者（design §5 下游预期接口）：
// - Story 4.0 Step 4：runChain 驱动器（runtime/chainRunner.ts）消费 RunChainOptions/RunChainDeps。
// - Story 4.0 Step 5：createChapterChainNodes 装配 ChainNodeDef[] + WorkflowRuntime.runChapterChain。
// - Story 4.1/4.2/4.3/4.5/6.6：节点 run() 升级 / 新节点接入（reads/owns 契约复用）。

export interface RunSnapshot {
  runId: string;
  status: string;
  currentNodeId: string | null;
  projectPath: string;
  completedNodes: string[];
  pendingNodes: string[];
  artifacts: Record<string, unknown>;
  review: { verdict?: string; summary?: string; reasons?: string[] } | null;
  archive: { versionId: string; archivedAt?: string; promptFiles?: string[] } | null;
  delivery: { deliveryId: string } | null;
  feedback: { feedbackId: string } | null;
  /**
   * 链段运行中累积的错误/告警信息（DAG 依赖缺失 / 节点 error artifact / revision cap 超限等）。
   * additive optional（Step 4.1 新增，零 migration）——summarizeRunSnapshot 抽取给 leader（context isolation：
   * 只回 summary 不回内部 trace）。节点正常产出不写此项。
   */
  errors?: string[];
  /**
   * 链流程重排（09-13 W1a）：灰区 escalate-pause 标记（additive optional）。chainRunner 在 through 节点判
   * escalate / 环 cap 超限强制 escalate 时置 true 并以 status='paused' 退出——与 stage 人审暂停（brief/draft/
   * verdict checkpoint 形态）共用 paused 形态但 resume 路径不同（裁决 accept→resume 续跑 / revise→resume redo
   * 回环），消费面（write_chapter 入口层 / summarize）据此区分两条 pause 路径。persist 随 chainSnapshot 全量
   * 存活（RunStateStore.setChainSnapshot 存整个 RunSnapshot）。非 escalate-pause 缺省。
   */
  escalatePause?: true;
  /**
   * 链流程重排（09-13 W2）：自审环迭代数（route-agent 环每次回环 +1 盖戳；首圈直过 accept = 缺省 0）。
   * 终稿 checkpoint 载荷（reviewSummary.loopCount）与 hardEscalate 处置上报消费。additive optional
   * （零 migration）。规划环计数不进本字段（终稿卡只关自审环收敛轮数）。
   */
  revisionCount?: number;
}

/**
 * 链内回环配置（链流程重排 design §1 双环）。
 *
 * - 生产链两环（W1d 装配，W1c 按同 id 产节点工厂）：
 *   - 规划环：`{from:'brief-compiler-node', through:'brief-reviewer-node', cap:2}`——through 产
 *     `plan_review` artifact（verdict 词表 pass/revise/escalate）。
 *   - 自审环：`{from:'revision-optimizer-node', through:'route-agent', cap:3}`——through 产 `route_decision`
 *     artifact（decision 词表 auto_revise/accept_as_truth/escalate_user）。
 * - verdict 判读（chainRunner readLoopVerdict 单源，词汇映射纯机械）：`auto_revise`/`revise` → 回环；
 *   `escalate_user`/`escalate` → escalate-pause；`accept_as_truth` → 自审环终态（onAccept + verdict
 *   checkpoint）；`pass` → 规划环 pass-through（正常前进）。
 * - 约束：每环 from index <= through index（环体 = chain 连续前向切片 [from..through]）；cap >= 0（超限
 *   强制 escalate-pause，ADR-17 防死循环）。
 */
export interface ChainLoopConfig {
  /** 回环体重跑起始节点 id（自审环 = revision-optimizer-node；规划环 = brief-compiler-node）。 */
  from: string;
  /** 回环体末节点 id——产出回环 verdict artifact（自审环 = route-agent；规划环 = brief-reviewer-node）。 */
  through: string;
  /** 回环次数上限（超限强制 escalate-pause；人审 redo 重入后计数重置——每 runChain 调用独立计数）。 */
  cap: number;
}

export interface NodeRunInput {
  run: RunSnapshot;
  requirement: string;
}

/** 节点 run() 产出：写入 run.artifacts[stateKey] = artifact（design §4 数据流）。 */
export interface NodeResult {
  stateKey: string;
  artifact: unknown;
}

/**
 * AgentNode：链段节点契约（ADR-4 explicit contracts）。
 * - contract: 节点元数据（reads requiredArtifactKeys / owns producedArtifactKeys / sideEffects），可 null（临时节点）。
 * - run(input): 读 input.run.artifacts → 执行（LLM / 纯代码）→ 返 {stateKey, artifact}。
 *
 Step 4.1 从 nodes/base.ts 挪入此处（与 RunSnapshot/NodeRunInput 同处）。
 */
export interface AgentNode {
  contract: ReusableAgentNodeContract | null;
  run(input: NodeRunInput): Promise<NodeResult>;
}

/**
 * checkpoint 阶段（design §4.6 三类设点 + Story 7.2 revision-guard + 链流程重排 W2 'final'）。
 *
 * - brief-reviewer→'brief'（brief 落定①——A2 规划审核后：人审的是独立审核过的卡）/
 *   draft-writer→'draft'（写手单位置声明——W2 后不再是 scheduled 停点（deriveCheckpointPolicy 已不含
 *   'draft'），但保留声明：出发核查挂起（researchSuspension）动态 pause 与 #93 草稿档案落盘都挂本 stage
 *   fire）/ route→'final'（W2 重映射——终稿人审：route accept 后、E 段提取前；正文可编辑 + accept 可携
 *   editedDraft；旧 'verdict' 停点退役）/ 'verdict'（枚举保留——mock 链测试与旧快照兼容；生产链不再声明）。
 * - Story 7.2：revision-guard→'revision-guard'（段落级改稿保义门，**动态 pause**——onCheckpoint 闭包读
 *   revision_guard.verdict，仅 soft-violation 才 pause；clean/hard-violation/skipped 不 pause 零打扰。
 *   非 deriveCheckpointPolicy 静态 pauseStages——revision-guard pause 由 verdict 驱动非 mode 驱动。
 *
 * 链流程重排 W2 档位重映射（R4）：auto=[] / suggest=['final'] / readonly=['brief','final']——旧
 * 'draft'/'verdict' scheduled 停点退役（write_chapter W0-5 拦截门随之激活废弃旧快照）。
 */
export type CheckpointStage = 'brief' | 'draft' | 'final' | 'verdict' | 'revision-guard';

/**
 * 链段节点定义：id（链内唯一标识，用于 checkpoint stage 识别 + loops from/through 引用）+ node。
 *
 * `checkpointStage`（CR-13）：显式声明该节点触发的 checkpoint 阶段（brief/draft/verdict），取代早期
 * 的 nodeId 子串推断（`includes('brief'|'route'|'draft')` 脆弱——未来节点 id 含这些子串会假触发）。
 * 链装配（chapter-chain.ts）按 design §4.6 三类设点标注；chainRunner 用 `def.checkpointStage` 而非子串。
 * 不声明 → 该节点不触发 checkpoint（如 revision-optimizer/multi-review/world-* 等中间节点——
 * targeted-revision 已随链流程重排 W1d 退役）。
 */
export interface ChainNodeDef {
  id: string;
  node: AgentNode;
  /** 显式 checkpoint 阶段（design §4.6 三类设点）；缺省 → 该节点不触发 onCheckpoint（CR-13）。 */
  checkpointStage?: CheckpointStage;
}

/**
 * Story 4.3 onCheckpoint 返回的决策（design §3.2 D2，4.3 升 async 返决策）。
 *
 * - continue：链段继续下一节点（4.0 全自动 fire-and-forget 行为，零回归）。
 * - pause：链段在当前 checkpoint 中断（status='paused' + currentNodeId 停该 checkpoint 节点 + break +
 *   返 snapshot；runChapterChain 检测后交还 leader，design §2 Option A break-complete-callback）。
 *
 * 范式判据（ADR-3）：pause 决策由纯代码机械判（policy.pauseStages.includes），非 LLM 语义判断。
 */
export type CheckpointDecision = { action: 'continue' } | { action: 'pause' };

/**
 * Story 4.3 三模式 checkpoint 策略（design §3.1 / §4 映射表 / KD2）。
 *
 * - pauseStages：scheduled pause 的 checkpoint 阶段集合（半自动 / 微操模式在此停→交还 leader→人检→resume 续跑）。
 *   全自动 → `[]`（不 scheduled pause，连续跑完 = 4.0 行为零回归）。
 * - escalateMode：灰区 escalate（route=escalate_user）如何处理——`auto-trust` 采信裁决器 recommendation skip
 *   ask_user / `ask` 走 4.6 既有 PatchReview 裁决（design §3.8 / KD2「细分 ask_user = reactive escalate mode-dependent」）。
 *
 * escalateMode 字段本 step（2）落 type + derive，**消费点在 chainRunner route=escalate 分支 = Step 6 接通**
 * （本 step runChapterChain 只消费 pauseStages，escalateMode 暂透传不消费，design §3.8 / Step 6 mode-gating）。
 */
export interface CheckpointPolicy {
  pauseStages: CheckpointStage[];
  escalateMode: 'auto-trust' | 'ask';
}

/**
 * Story 4.3 三模式 checkpoint 策略（design §3.1 / §4 映射表 / KD2）。链流程重排 W2 档位重映射（R4）。
 *
 * - pauseStages：scheduled pause 的 checkpoint 阶段集合。
 *   - `auto`（全权/全自动）→ `[]`（终稿不停——收敛失败处置归 session.hardEscalatePolicy 子开关，
 *     write_chapter 编排层消费）+ 灰区 `auto-trust`。
 *   - `suggest`（半自动缺省）→ `['final']`（每章**终稿**人审一次，避 chat-fatigue ADR-17——4.3「每章
 *     prose review 一次」密度哲学保持，位置从 draft 后移终稿：AI 自审环先收敛，人只在终稿花一次注意力）。
 *   - `readonly`（微操）→ `['brief','final']`（写前任务卡审〔A2 审核过的卡〕+ 终稿审；旧 verdict 停点
 *     职能由 escalate 动态叫人替代）。
 *   - 旧 'draft'/'verdict' scheduled 停点退役（W2）；draft-writer 仍声明 stage='draft' 供挂起动态 pause +
 *     #93 草稿档案落盘 fire，但任何档位不再静态停。
 * - escalateMode：灰区 escalate（route=escalate_user）如何处理——`auto-trust` 采信裁决器 recommendation skip
 *   ask_user / `ask` 走 4.6 既有 PatchReview 裁决。auto 档的收敛失败细化（cap 超限两支 / 裁决失败保守采信）
 *   归 hardEscalatePolicy（session 字段，缺省 'ask' 停下叫人），非本 policy 面。
 *
 * 复用 permissionMode 作密度信号（KD1：读值非用 tool-gating，不加新 UI 旋钮）。范式判据（ADR-3）：mode→checkpoint
 * 密度映射是用户偏好（UX/控制），pause/resume 机制纯代码（确定性）。
 *
 * 消费点：write_chapter tool / closureChainIpc 入口从 `session.permissionMode` 推导后传 runChapterChain `options.mode`
 * （Step 3 wiring）。
 */
export function deriveCheckpointPolicy(mode: SessionPermissionMode): CheckpointPolicy {
  switch (mode) {
    case 'auto':
      return { pauseStages: [], escalateMode: 'auto-trust' };
    case 'suggest':
      return { pauseStages: ['final'], escalateMode: 'ask' };
    case 'readonly':
      return { pauseStages: ['brief', 'final'], escalateMode: 'ask' };
  }
}

/**
 * Story 8.4 Step 4（A8）：checkpoint pause 判定**单源**（workflow.ts runChapterChain onCheckpoint 闭包
 * 调用；此前闭包内联判定，7.2 revision-guard 动态 pause 与 4.3 mode 驱动 pauseStages 两段逻辑散在
 * 闭包里，8.4 加第三段时收敛为纯函数——机械判定可单测，防闭包内联漂移）。
 *
 * 判定（顺序即优先级；链流程重排 W2 动态 pause 按档位分流 R4）：
 * 1. **revision-guard 动态 pause**（Story 7.2，verdict 驱动）：stage='revision-guard' 且
 *    `artifacts['revision_guard'].verdict==='soft-violation'`——W2 按档位分流：suggest/readonly / 无
 *    policy → pause（art-mode 卡，7.2 原语义）；**auto 档 → continue = 自动回退改前稿**（R4 翻 7.2
 *    全档位 pause，2026-09-13 拍板「安全自决」：soft-violation 时 guard 本就不 splice，draft.initial
 *    保持改前整章，continue 即「该圈修订作废、环对改前稿再判」，回退比带病放行安全；cap 兜底防死循环）。
 *    auto 档识别 = policy.escalateMode==='auto-trust'（deriveCheckpointPolicy 唯一 auto 产出）。
 *    clean/hard-violation/skipped → continue（clean 零打扰；hard-violation 已是 error artifact 链段停）。
 * 2. **出发核查挂起 pause**（Story 8.4，suspension 驱动）：stage='draft' 且
 *    `artifacts['research_brief'].suspended` 存在 → pause——**全档位（含 auto）**：auto 档的「跳章+
 *    标记」处置在**入口层**（write_chapter 消费 paused+researchSuspension summary 后终止链+批量标记，
 *    R4 安全自决），链层保持 pause 单一出口（不在链内臆造跳章语义）。挂起时 draft.initial 不存在，
 *    continue 会跳过 draft-writer 撞下游 DAG blocked——恢复只有 redo（resumeOptions=['redo','abort']）。
 * 3. **mode 驱动静态 pauseStages**（Story 4.3 / W2 重映射：suggest=['final']、readonly=['brief','final']）：
 *    policy.pauseStages.includes(stage) → pause。
 *    policy 缺省（4.0 既有 / 无 onCheckpoint 消费方）→ 恒 continue（全自动零回归）。
 *
 * 范式判据（ADR-3）：三层全是纯代码机械判定（artifact 字段存在性 / 枚举匹配 / 集合包含）——pause 与否
 * 的**内容性判断**（矛盾真伪 / 该不该改）归人（leader 核实 + 用户决断），不在此编码。
 */
export function decideCheckpointPause(
  stage: CheckpointStage,
  snapshot: RunSnapshot,
  policy: CheckpointPolicy | undefined,
): CheckpointDecision {
  // 1. Story 7.2：revision-guard soft-violation 动态 pause（verdict 驱动）——W2 按档位分流（R4）：
  //    auto 档 continue = 回退改前稿（splice 不发生即回退）；suggest/readonly / 无 policy 维持暂停叫人。
  if (stage === 'revision-guard') {
    const guard = snapshot.artifacts['revision_guard'] as { verdict?: string } | undefined;
    if (guard?.verdict !== 'soft-violation') return { action: 'continue' };
    return policy?.escalateMode === 'auto-trust' ? { action: 'continue' } : { action: 'pause' };
  }
  // 2. Story 8.4 Step 4（A8）：出发核查挂起全档位暂停（suspension 驱动；auto 无例外——结构性矛盾
  //    不带病开写）。presence 判定（非 schema parse）：suspended 字段在即挂起意图成立（载荷由
  //    writer-node 机械构造，summarize 侧 safeParse 守形）。
  if (stage === 'draft') {
    const research = snapshot.artifacts['research_brief'] as { suspended?: unknown } | undefined;
    if (research !== undefined && research.suspended !== undefined) {
      return { action: 'pause' };
    }
  }
  // 3. Story 4.3：mode 驱动静态 pauseStages。
  return policy?.pauseStages.includes(stage) ? { action: 'pause' } : { action: 'continue' };
}

/**
 * 链段 abort 时抛出的错误（design §4.1 abort/resume）。
 * - name='AbortError'：与 runLoop/DOMException 取消语义一致（isAbortError 判定）。
 * - 携带 snapshot：runChapterChain（Step 5）catch 后可读 .snapshot 持久化到 RunStateStore.chainSnapshot，
 *   实现 ADR-17「RunSnapshot + 编排状态一起持久」（resume 不丢上下文）。
 */
export class ChainAbortedError extends Error {
  constructor(public readonly snapshot: RunSnapshot) {
    super('chain run aborted');
    this.name = 'AbortError';
  }
}

/**
 * runChain 选项（design §4.1）。
 *
 * - chain: 顺序节点数组（按 DAG 拓扑序排好；4.0 用简单顺序驱动，非完整图引擎——spec line 126「先 subgraph 模式」）。
 * - initialArtifacts: leader 注入的上游 artifact（scene_graph / settings_context / chapter_brief_input；
 *   链段不从 intake 重跑，spec line 35/124）。
 * - requirement: 本章需求描述（brief-compiler 作 episodeId 兜底等）。
 * - loops: 链内回环配置数组（链流程重排 design §1 双环——规划环 [brief-compiler→brief-reviewer] + 自审环
 *   [revision-optimizer→route]，多环并存；链内回环不 break 交 leader，环 cap 超限强制 escalate-pause）。
 *   - 每环 {from, through, cap}：from/through 见 ChainLoopConfig；约束 from index <= through index
 *     （环体 = 连续前向切片，装配按此排节点序）；cap 超限强制 escalate（防死循环，ADR-17）。
 *   - 旧单环 `revisionLoop` 选项已退役（09-13 W1a 数组化取代）。
 * - onCheckpoint: 三类设点回调（brief/draft/verdict，design §4.6）。Stage 由 ChainNodeDef.checkpointStage 显式
 *   声明（CR-13，取代旧 nodeId 子串推断）。4.0 全自动模式默认不 pause（只 resumable-abort）；pause-at-checkpoint 半自动 = Story 4.3。
 *   **Story 4.3 Step 2（design §3.2 D2）**：升级为 **async 返 CheckpointDecision**（4.0 同步 fire-and-forget → 4.3
 *   `Promise<{action:'continue'} | {action:'pause'}>`）。返 `{action:'pause'}` → runChain status='paused' + break +
 *   交还 leader（design §2 Option A）；返 `{action:'continue'}` → 续跑（全自动零回归 = 4.0 行为）。旧同步调用方
 *   包 async（workflow.ts onCheckpoint 闘包已升 async，design §3.4）。
 * - resumedCompletedNodes: resume 恢复用——已完成的节点 id 列表（initialArtifacts 须含其产出），
 *   runChain 跳过这些节点（节点重跑须 idempotent，ADR-17 警示；LLM 节点重跑产出可能不同，4.0 接受）。
 */
export interface RunChainOptions {
  chain: ChainNodeDef[];
  initialArtifacts: Record<string, unknown>;
  requirement: string;
  loops?: readonly ChainLoopConfig[];
  onCheckpoint?: (stage: CheckpointStage, snapshot: RunSnapshot) => Promise<CheckpointDecision>;
  /**
   * dogfood T1 Stage 6（design §4，r1）：**每节点**边界回调（additive optional）——onCheckpoint
   * 只在声明 checkpointStage 的节点 fire（brief/draft/revision-guard/verdict 四处），不能驱动
   * 全链步进；本回调在每个节点终态时同步 fire：成功 = 'done'（artifact 写入 + completedNodes
   * 记录后）、error artifact / 节点 throw 合成 = 'error'、DAG requiredArtifactKeys 缺失 = 'blocked'。
   * resume 跳过的节点不 fire（前一 run 已 fire 过）。消费方 = workflow runChapterChain（转
   * chain-node-done 事件，链 UI 步进条数据源）。缺省不调（零回归）。
   *
   * 09-13 子2 CR 批（CR-7）：第三参 `pauseKind` additive optional——workflow 闭包对 **run 级哨兵
   * 终态帧**（nodeId=CHAIN_RUN_SENTINEL_NODE_ID 且 status='paused'）携带暂停理由
   * （deriveSentinelPauseKind 五暂停面投影）。chainRunner 的节点边界调用恒两参（普通节点 done
   * 帧不带 pauseKind）——闭包实现已三参（workflow.ts onNodeDone），此处声明与运行形态对齐。
   */
  onNodeDone?: (nodeId: string, status: 'done' | 'error' | 'blocked', pauseKind?: ChainNodeDonePauseKind) => void;
  /**
   * 09-13 子2 W3（design §2 M4）：blocked 终态的产出快照回调（additive optional）——DAG
   * requiredArtifactKeys 缺失时节点 run **不被调**（无 artifact 可投影），装配层 withNodeArtifact
   * 包装结构性看不到 blocked，故由 chainRunner 在 blocked 分支携带完整 message 调本回调
   *（**先于同节点 onNodeDone('blocked')**——AC2「artifact 事件先于 node-done」顺序对 blocked
   * 同样成立）。消费方 = workflow runChapterChain（转 chain-node-artifact 通用受阻行）。缺省不调（零回归）。
   */
  onNodeBlocked?: (nodeId: string, message: string) => void;
  /**
   * 09-13 子2 CR 批（CR-3）：through verdict 强制覆写后的快照重发回调（additive optional）——
   * chainRunner 覆写 route_decision / plan_review（环 cap 超限 / optimizer_failed 强制升级 /
   * CR-10 未知 verdict / CR-1 空转断路）后携带 (nodeId, run, 覆写后 result) 调用。消费方 =
   * workflow runChapterChain（经 emitChainNodeArtifactFor 按发射形态表重投影转 chain-node-artifact
   * 帧——时间线末帧姿态与真实终态一致）。缺省不调（mock 链零回归）。
   */
  onVerdictOverwritten?: (
    nodeId: string,
    run: RunSnapshot,
    result: { stateKey: string; artifact: unknown },
  ) => void;
  resumedCompletedNodes?: string[];
  /**
   * 4.1 Step 4（CR-15b）：accept 分支回调。route=accept_as_truth 时调，产 `chapter_accept` artifact
   * （{chapterId, candidate, storyDecisions?, runId}）写入 run.artifacts['chapter_accept']。**链段不写盘**
   * （纯驱动 + 可测；持久化在入口层 IPC/leader）。
   *
   * 回调由入口层（write-chapter tool / closureChainIpc）提供，闭包捕获 project 数据（novel.chapters +
   * episode_outlines）做 chapterId 解析。返回 undefined（draft 缺 / chapterId 映射失败）→ 不写 chapter_accept
   * （accept 持久化阻断，入口层据 summary.chapter_accept 缺省返明确报错）。
   *
   * `ctx.nowISO` = 入口注入 ISO 时间戳（StoryDecision.createdAt 用；纯函数无 Date，入口注入）。
   */
  onAccept?: (
    snapshot: RunSnapshot,
    ctx: { nowISO: string },
  ) => ChapterAcceptResult | undefined;
  /**
   * 4.1 Step 4：入口注入的 ISO 时间戳（onAccept ctx.nowISO 源；纯函数无 Date）。workflow.ts runChapterChain
   * 入口生成（`new Date().toISOString()`），threading 进 runChain opts。缺省 → ''（onAccept/buildChapterAccept
   * 收到空串 → CR-4.1-09：返 skipReason:'no-nowiso' 跳过 StoryDecision 登记，不产 invalid createdAt 违
   * `z.string().min(1)`；旧 docstring「闭包兜底」不存在，已校准）。生产路径 workflow.ts 总会注入。
   */
  nowISO?: string;
}

/**
 * runChain 依赖注入（design §4.1 RunChainDeps）。
 *
 * - generate: LLM 生成函数（GenerateFn from nodes/llm-node.ts，与 provider generate 兼容子集签名）。
 *   透传给 createLlmNode（Step 5 装配时 deps 注入）；runChain 自身不直接调 generate（节点内部调），
 *   保留在 deps 供 Step 5 createChapterChainNodes 透传 + 未来节点直接消费。
 * - sessionContext: 派发链段的 child session（SubagentRuntime.dispatch 产）——projectPath 等来源。
 * - signal: 链段 abort 信号（RunStateStore.beginRun 返；abort → 存 checkpoint + 抛 ChainAbortedError）。
 */
export interface RunChainDeps {
  generate: GenerateFn;
  sessionContext: SessionState;
  signal: AbortSignal;
}

/**
 * BMad CR-T1-056：per-project 活动链守卫 busy 拒绝的 errors[0] 机器可读前缀——
 * `chain_run_active|heldBy=<holderSessionId>`（mirror D4 project_run_active 消费语义：leader 据
 * 工具结果自察 / dogfood IPC 透传 UI 提示「该项目另一条链正在运行或暂停待审阅」）。
 */
export const CHAIN_RUN_ACTIVE_ERROR_PREFIX = 'chain_run_active';

/**
 * RunSnapshot 摘要（context isolation，design §4.3 / ADR-17）。
 *
 * 链段只回摘要给 leader，**不抽内部 trace / 全量 artifacts**（防 leader 长程上下文爆炸——spec line 29
 * 「链段只回 RunSnapshot 摘要，不灌 leader context」）。leader 据摘要决定下一步（继续/改/问用户）。
 *
 * - status: running/completed/blocked/error/aborted/**paused**(4.3 stage 人审暂停 / 09-13 W1a escalate-pause
 *   共用形态——escalatePause 字段区分两条 resume 路径)。
 * - routeDecision: route 节点判决（auto_revise/accept_as_truth/escalate_user）。
 * - reviewVerdict: multi-review verdict（pass/revise/escalate）。
 * - draftTitle/draftWordCount: 初稿或修订稿的标题/字数（draft.initial 优先，否则 revision.output）。
 * - draftText: 初稿/修订稿正文（CR-15a 落地公理——prose 是 deliverable 非 internal trace，豁免 context
 *   isolation：链段产出须抵达读者/dogfood 检视）。持久化到 chapter .md defer 4.1（CR-15b）。
 * - pausedStage/draftContent/briefContent: Story 4.3 pause-review payload（status='paused' 且非
 *   escalate-pause 时抽，design §3.4；escalate-pause 走 escalatePause + escalateFindings/chapter_accept 载荷）。
 * - errors: 链段错误累积（DAG 缺失 / error artifact / cap 超限）。
 */
export interface RunSnapshotSummary {
  status: string;
  routeDecision?: {
    decision: string;
    reason: string;
    /**
     * dogfood R2 #107 / R1.1c：route 判正文偏离计划（deviation=true）时投影（源 route_decision
     * artifact 的 deviation boolean）。#107 no-chapter 自动建章时入口层（write_chapter /
     * closureChainIpc）补产 storyDecisions 的数据源（buildAcceptStoryDecisions 单源消费）——修前
     * summary 只有 decision+reason，补产只能静默降级不登记（用户拍板不降级）。只在 true 时出现
     * （false/缺省省略）。additive optional（零 migration）。镜像 shared ipc.ts
     * RunChapterChainSummary.routeDecision.deviation（两处平行 type 同步，B01 纪律）。
     */
    deviation?: true;
  };
  reviewVerdict?: string;
  draftTitle?: string;
  draftWordCount?: number;
  /** 初稿/修订稿正文（CR-15a：prose 是 deliverable，豁免 context isolation）。 */
  draftText?: string;
  /**
   * Story 4.3：status='paused' 时链段暂停的 checkpoint 阶段（brief/draft/verdict）。供 leader / UI 决定 review
   * 形态（draft→prose-review 面板 / brief→对话软门 / verdict→PatchReview）。非 paused 缺省。
   * additive optional（零 migration）。pausedStage 由 runChapterChain 从 currentNodeId 经 chain 的 checkpointStage
   * 解析后以 pauseHint 传入 summarize（summarize 无 chain 上下文，design §3.4「从 currentNodeId/checkpointStage 推」）。
   */
  pausedStage?: CheckpointStage;
  /**
   * Story 4.3：draft checkpoint pause 时的正文（review payload，豁免 context isolation 同 CR-15a prose 是 deliverable）。
   * 源 `artifacts['draft.initial'].text`（同 draftText 源，仅在 paused 时抽作 review 载荷）。非 paused 缺省。
   */
  draftContent?: string;
  /**
   * Story 4.3：brief checkpoint pause 时的 chapter_brief artifact（review payload，豁免 context isolation）。
   * 源 `artifacts['chapter_brief']`（object / 任意 shape，UI 据其渲染 brief 摘要供人确认）。非 paused 缺省。
   */
  briefContent?: unknown;
  /**
   * Story 7.2：revision-guard pause（soft-violation）时的保义门载荷。deliverable 非 trace（同 draftContent
   * 豁免 context isolation）——UI art-mode 卡据此展示 findings + 改前/改后，作者决定强行放行/改/取消。
   * 源 `artifacts['revision_guard']`。非 revision-guard pause 缺省。
   */
  revisionGuard?: RevisionGuardArtifact;
  /**
   * accept 持久化载荷（CR-15b / 4.1 Step 4：route=accept_as_truth 时，onAccept 产 chapter_accept artifact；
   * deliverable 非 trace，同 draftText 豁免 context isolation）。入口层据此持久化：IPC 调
   * acceptChapterCandidate 写盘 / leader 转 field_patch metadata 走 patch review。route 非 accept /
   * chapterId 映射失败 → 缺省。
   */
  chapter_accept?: ChapterAcceptArtifact;
  /**
   * route=escalate_user 时附带：Reader-Audit 灰区 findings grounding（quote/location/severity），
   * 供裁决器子 agent 初审 + 用户裁决（Story 4.6）。非 escalate 缺省。additive optional（零 migration）。
   */
  escalateFindings?: EscalateFinding[];
  /**
   * 链流程重排（09-13 W1a）：escalate-pause 标记——status='paused' 时区分「stage 人审暂停」（brief/draft/
   * verdict checkpoint，resume = continue/redo/abort 三动作）与「灰区裁决暂停」（through 节点判 escalate /
   * 环 cap 超限，resume = 裁决 accept→续跑 / revise→redo 回环）。write_chapter 入口层据此分派裁决编排
   * （R4b：裁决结果驱动 resume 非链后补处理）。非 escalate-pause 缺省。additive optional（零 migration）。
   */
  escalatePause?: true;
  /**
   * route 终态（accept_as_truth / escalate_user）时附带 story-sync 反哺提取载荷
   * （patches + summary，源 `artifacts['story.sync']`——E9 提取段对终稿一次提取）。deliverable 非
   * internal trace（同 chapter_accept / escalateFindings 豁免 context isolation）——write_chapter
   * applier 据此转 story_sync_apply 落盘（suggest 档 envelope 人审 / auto 档直落 / readonly 文字建议；
   * 链流程重排 W3：escalate 采信续跑后的 completed 形态按正常档位分流，「随裁决材料」路径退役）。
   * 空 patches 不抽（零痕迹）；auto_revise 中间轮不抽（非终态，防 summary 膨胀）。additive optional（零 migration）。
   */
  storySync?: NovelStorySyncPayload;
  /**
   * Story 8.2：本章写时声明的弧节拍（源 `artifacts['arc_emergence'].beats`，arc-emergence-node 产；
   * 无则空数组）。deliverable 非 internal trace（同 escalateFindings 豁免 context isolation）——
   * write_chapter post-settle 据此做关口判定（detectVolumeClosure：卷弧 close beat → 派 arc-audit-agent
   * 大审）+ 停滞检测兜底（本章零节拍可见）。additive optional（零 migration）。镜像 shared ipc.ts
   * RunChapterChainSummary.arcEmergenceBeats（两处平行 type 同步，B01 纪律）。
   */
  arcEmergenceBeats?: ArcBeat[];
  /**
   * Story 8.4 Step 3（A7 档案议题通道）：出发核查（资料员）verdict 的 archive_issues 透传（源
   * `artifacts['research_brief'].verdict.archive_issues`，writer-node 存档）。deliverable 非 internal trace
   * （同 escalateFindings 豁免 context isolation）——设定卡过时/矛盾须 leader/用户看见处理（人导演域，
   * 资料员无档案写权限）；呈现走 write_chapter output 文案行（3.3 校验议题进 chat 同通道：tool result →
   * leader 主动提 + 对话解决，不造新通道）。空/缺不抽（零痕迹）。additive optional（零 migration）。
   */
  archiveIssues?: ArchiveIssue[];
  /**
   * Story 8.4 C2（design §3.3）：提取器 storyTime 漂移 warning 透传（源
   * `artifacts['storytime_drift'].warnings`，storytime-drift-node 产——chapter-summary 链位旁守卫
   * 步骤）。deliverable 非 internal trace（同 archiveIssues 豁免 context isolation——3.3 校验议题
   * 进 chat 同通道：write_chapter 文案行呈现 → leader 主动提 + 对话解决，人核对 scene_graph 或
   * 重提取）。**零阻断零噪音**：warning 不进 errors 不停链；无 slices / 本章无归属场 / 全在窗内
   * → 空，缺省不抽（零痕迹）。additive optional（零 migration）。守卫容差 0 = 校准点 dogfood
   * （shared storytime-drift.ts STORYTIME_DRIFT_TOLERANCE 注释，deferred-work 记档）。
   */
  driftWarnings?: StoryTimeDriftWarning[];
  /**
   * Story 8.4 Step 4（A7/A8 矛盾暂停与挂起）：draft pause 因出发核查挂起（verify_exhausted /
   * research_contradiction）时的挂起载荷（源 `artifacts['research_brief'].suspended`，writer-node 产）。
   * deliverable 非 internal trace（同 escalateFindings 豁免 context isolation——用户决断所需证据：
   * 矛盾/偏离明细或缺漏清单）。**全档位暂停（含 auto）**——结构性问题不带病开写（mirror 3.5「BLOCK
   * 永不采信」哲学），挂起 ≠ 错误（errors 不计，恢复 = redo 重跑该章，design §1.7）。非挂起 pause /
   * 非 paused 缺省。additive optional（零 migration）。镜像 shared ipc.ts RunChapterChainSummary
   * .researchSuspension（两处平行 type 同步，B01 纪律——research-brief.ts researchSuspensionSchema 单源）。
   */
  researchSuspension?: ResearchSuspension;
  /**
   * 链流程重排 W2（plan-review M5）：终稿 checkpoint（pausedStage='final'）的审读摘要——verdict
   * （review.latest 审读结论）+ reasons（route 理由 + 审读 summary）+ loopCount（自审环迭代数，源
   * snapshot.revisionCount）+ capExhausted（errors 含 loop cap）。终稿卡（ChapterReviewMetadata
   * .reviewSummary）据此呈现「AI 自审收敛了几轮、结论如何」。非 final pause 缺省。镜像 shared ipc.ts
   * RunChapterChainSummary.reviewSummary（两处平行 type 同步，B01 纪律）。
   */
  reviewSummary?: { verdict: string; reasons: string[]; loopCount: number; capExhausted: boolean };
  /**
   * 链流程重排 W2（R2 去味门禁）：终稿 checkpoint 的 lint 终态报告 digest（`lint_report` artifact 机械
   * 投影——命中计数 + 高优命中摘录；degraded = 引擎缺位占位说明）。终稿卡（ChapterReviewMetadata
   * .lintReport）消费（UI 渲染归子3）。非 final pause 缺省。镜像 shared ipc.ts
   * RunChapterChainSummary.lintReport。
   */
  lintReport?: string;
  /**
   * 链流程重排（W2 引入 / W3 接真判决）：去味门禁信号——终轮 review.latest 含 L2 确认的 lint 来源
   * 条目（finding.source==='lint' 且 severity=block/warn——判真伪归 multi-review L2，此处判源不判义）。
   * hardEscalate='auto' 的 cap 超限两支（终弃 vs 采信）消费。缺省 = 门禁过 / 无 lint 确认（保守采信）。
   */
  lintUnresolved?: true;
  /**
   * 链流程重排 W2（R4c 落盘拆两步 / AC2c）：E 段提取失败章标——route accept 已过（route-agent 在
   * completedNodes）但链 status='error'（E 节点中断）。入口层据此 post-hoc 落正文 + 章标 stale + 指引
   * re-extract 修复通道（W4）。redo 腿（route 已移除出 completedNodes）不误报。
   */
  derivationStale?: true;
  /**
   * Story 8.4 B1（design §2.1）：热层编译报告透出（源 `artifacts['compile_report']`，brief-compiler-node
   * 汇总点产；mirror 章摘要 tokenEstimate 先例——观测 deliverable 非 internal trace）。segments 各段
   * token 估算 + total（装配点两编译点之和）+ degraded（降级动作记录，缺失 = 未降级 L0）+ overloaded
   * （L3 复杂场景标记——write_chapter 据此落 leader 一行「建议拆章」人审文案）。artifact 缺（旧链 /
   * bypass 路径）缺省。additive optional（零 migration）。镜像 shared ipc.ts RunChapterChainSummary
   * .compileReport（两处平行 type 同步，B01 纪律——research-brief.ts compileReportSchema 单源守形）。
   */
  compileReport?: CompileReport;
  errors: string[];
}
