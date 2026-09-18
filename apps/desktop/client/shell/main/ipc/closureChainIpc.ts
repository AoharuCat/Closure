/**
 * Closure chapter-chain dogfood IPC (Story 4.0 §4.8 / implement.md 6.2).
 *
 * `closure:run-chapter-chain` is the workbench-free entry point for triggering the
 * write-chapter subgraph: dogfood (real-LLM run of《超时空辉夜姬》) + Step 7 e2e
 * tests. The leader `write_chapter` tool (agent) is the interactive mirror; both
 * share `assembleChapterChainArtifacts` so the artifact shape stays identical.
 *
 * Flow (mirror closureIndexIpc 模式 A for the no-project error, but throws on
 * chain failure so the dogfood caller sees the real error — unlike rebuild, which
 * reports stable error codes, this handler is dev/test-only):
 * 1. `loadProject(projectPath)` from local-bff (migration + schema-validated) → doc.
 * 2. Create a stub parent session (dogfood has no leader session; dispatchSubagent
 *    needs a parentSessionId for both adjudicator/revision-optimizer dispatch +
 *    runChapterChain).
 * 3. `assembleChapterChainArtifacts(doc, episodeId, chapterBrief)` → initialArtifacts.
 * 4. Readiness gate + `runtime.runChapterChain(parent.id, initialArtifacts)` → RunSnapshot summary.
 *
 * Runtime access: the singleton is created inside registerAgentIpc; this handler
 * imports `getAgentRuntime()` lazily (invoked well after registration).
 */
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ChapterDerivationStatusResult,
  CompileRevisionIntentInput,
  CompileRevisionIntentResult,
  FieldPatchEntry,
  NovelStorySyncPayload,
  ReExtractChapterResult,
  ResumeChapterChainInput,
  RunChapterChainInput,
  RunChapterChainSummary,
} from '@orison/shared-contracts';
import {
  assembleChapterChainArtifacts,
  assertBriefReady,
  autoCreatedChapterFileContent,
  BriefNotReadyError,
  buildAcceptStoryDecisions,
  buildChapterAccept,
  buildCognitionSnapshot,
  buildPresenceSignal,
  buildSelectionAnchor,
  chapterDerivationStatusInputSchema,
  compileRevisionIntentInputSchema,
  computeReadiness,
  describeAcceptSkip,
  parseAdjudication,
  parseRevisionIntent,
  planAutoCreateChapter,
  reExtractChapterInputSchema,
  resolveChapterIdForEpisode,
  resolveEpisodeIdForChapter,
  resumeChapterChainInputSchema,
  runChapterChainInputSchema,
  type AdjudicationSuggestion,
  type ChapterAcceptArtifact,
  type ChapterAcceptResult,
  type ChapterAcceptSkipReason,
  type ChapterBrief,
  type ChapterChainProjectInput,
  type CognitionSnapshot,
  type PresenceSignal,
  type ResolvableChapter,
  type ResolvableEpisode,
  type RevisionIntent,
  type SceneGraph,
  type StoryDecision,
  type WorldStateSnapshot,
} from '@orison/shared-contracts';
// Story 4.3 Step 3：deriveCheckpointPolicy 从 agent 包导入（contracts/run.ts 落，index.ts 出）——shell 入口
// 从 session.permissionMode 推 checkpoint 策略（design §3.1 / §4）。layering OK：shell → agent → shared-contracts。
// Story 4.3 Step 6：CheckpointPolicy 类型同导入（handleEscalateAutoTrust 参数签名用）。
// Story 2.2 WP-E（CR-08-16-201）：STORY_SYNC_REVIEW_CAP + formatStorySyncChapterLabel——resume 终态
// story-sync 消费 mirror write_chapter applier 的档位判定与章节出处（单源，防两处 cap/文案漂移）。
// 风格卡片 MVP CR-026（08-28 BMad CR auditor#3）：style_context 消费单源从 agent 包导入
// （readStyleCardBody + buildStyleContext——与 leader write_chapter 路径同一对函数，layering OK：
// shell → agent → shared-contracts，同 deriveCheckpointPolicy 先例）。
import { deriveCheckpointPolicy, formatStorySyncChapterLabel, STORY_SYNC_REVIEW_CAP, CHAIN_RUN_SENTINEL_NODE_ID, readStyleCardBody, buildStyleContext, applyEditedDraft, type ChainCompletedEventPayload, type ChainStreamEvent, type CheckpointPolicy } from '@orison/desktop-agent';
import { getAgentRuntime, acquireProjectRun, CHAIN_RUN_LEASE_ID, registerStreamAbortController, unregisterStreamAbortController } from './agentIpc';
import { assertSafePath } from './pathGuard';
import { getLogger } from '../logger';
import { withProjectLock } from '../fs/projectWriteLock';
// Story 2.2 WP-E（CR-08-16-201）：resume 终态直调 story-sync applier 的 shell handler（同进程，
// 直调也吃 cap / 白名单 / merge-only / 版本锁机械门——「直调 handler 也拦」语义）。
import { storySyncApplyHandler } from './toolHandlers/storySyncHandlers';
// dogfood R2 #107 / R1.1：no-chapter 自动建章的落盘通道——直调 chapter_write 的 shell handler
// （同进程，mirror storySyncApplyHandler 直调先例；handler 自带 snapshotToLocalHistory +
// atomicWrite + 主动 notifyUI（chapter:changed + file:changed）→ renderer 300ms debounce →
// derive → sync-chapters-meta 注册闭环现成）。
import { chapterWriteHandler } from './toolHandlers/chapterHandlers';
// Story 6.6 Phase D（8.1 Step 5 checkpoint 化）：world_state_snapshot 一致基底——shell 直调
// worldStateRepository（同进程 db，无 IPC 往返，mirror queryStoryHandler 直调 reduceClosure* 的姿态）。
// snapshot 注入 initialArtifacts 供 Reader-Audit 消费。
import { getProject } from '../db/projectRepository';
import { buildWorldSnapshotCheckpointed, listChapterSummaries, listWorldPatches } from '../db/worldStateRepository';
// 链流程重排 W4（R6）：derivation-status 查询的持久 stale 判据（mention 降档 hook 在每次章正文写盘点
// 追记的 degradedNote 文案——mentionLedgerRepository 单源，防两处字面量漂移）。
import { MENTION_SYNOPSIS_STALE_NOTE } from '../db/mentionLedgerRepository';

// ── 链流程重排 CR-14（09-13 CR 修复批）：leader-notify loopUnconverged 投影判据 ──
//
// 自审环 cap 耗尽的机械标记 = chainRunner 环 cap error 形态 `loop cap (<cap>) reached at
// "<through 节点 id>"; forced escalate`——自审环 through = "route-agent"、规划环 through =
// "brief-reviewer-node"。精确匹配 loop 节点 id（规划环 cap 不误报——resume 车道的规划环裁决
// 采信非「环未收敛」语义）。🔁 平行实现纪律：单源 = agent write-chapter.ts isAuditLoopCapError
// （agent index 未导出该 helper——簇文件边界，两处判据同步；mirror run.ts/ipc.ts 平行 type B01）。
function isAuditLoopCapErrorIpc(error: string): boolean {
  return error.includes('loop cap') && error.includes('"route-agent"');
}

// ── Story 6.6 Phase D（8.1 Step 5 checkpoint 化）：world_state_snapshot 一致基底 fetch（shell 直调 db）──
//
// mirror write_chapter agent 路径的 fetchWorldStateSnapshotViaTool（build_world_snapshot builtin → shell
// buildWorldSnapshotCheckpointed）——shell 入口直调**同一 repository 函数**（同进程 db，无 IPC 往返，更高效）。
// checkpoint-backed fold 与旧「listWorldSlices 全集 + buildWorldStateSnapshot 纯函数 fold」输出语义等价
// （Step 2 repository 等价性测试锚；IPC 传输从 O(总 patches) 降为 O(snapshot)，design §6）。snapshot 在
// chain 启动前取——此时 closure_world_state 仅含前章 events（本章提取器在 draft 后跑），故 snapshot 自然
// 反映「已建立状态」基底。graceful：project 未注册 / 无数据 / 抛错 → undefined（不注入 artifact，
// Reader-Audit buildPrompt 降级空段）。
async function fetchWorldStateSnapshotForIpc(projectPath: string): Promise<WorldStateSnapshot | undefined> {
  try {
    // CR-E4：path.resolve 对齐 worldStateHandlers.resolveProjectId（local_fingerprint == path.resolve(projectDir)，
    // ensureProject 约定）。不 resolve 会致 getProject 查不到记录（路径形态不一致）→ snapshot 永远 undefined。
    const projectId = getProject(path.resolve(projectPath))?.projectId;
    if (!projectId) return undefined; // project 未注册到 db（首跑 / 未 ensureProject）→ graceful。
    const snapshot = buildWorldSnapshotCheckpointed(projectId, undefined);
    if (snapshot.subjects.length === 0) return undefined; // 首章 / 无前章状态 → graceful。
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { projectPath, err: msg },
      'closure-chain-ipc: world_state_snapshot fetch failed → graceful skip (Reader-Audit degrades)',
    );
    return undefined;
  }
}

// ── Story 6.2（8.1 Step 5 shell 侧投影）：cognition_snapshot 一致基底 fetch（mirror cognition 投影 handler）──
//
// mirror write_chapter agent 路径的 fetchCognitionSnapshotViaTool（build_world_snapshot {projection:'cognition'}）。
// Step 3 handler 的 cognition 投影组合 = listWorldPatches 全量取回（in-process，免全集 IPC）→
// buildCognitionSnapshot（shared-contracts 纯函数：filter cognitive + per-character reduceSubject +
// projectBeliefStatus）——本入口直调**同一 repository 函数 + 同一纯函数**（与 handler 同组合，零逻辑复制）。
// snapshot 在 chain 启动前取——此时 closure_world_state 仅含前章 events，故 snapshot 自然反映「截至本章前的
// 角色认知状态」。graceful：project 未注册 / 无 cognitive patches / 抛错 → undefined（不注入 artifact，
// Reader-Audit buildPrompt 降级空段）。
async function fetchCognitionSnapshotForIpc(projectPath: string): Promise<CognitionSnapshot | undefined> {
  try {
    // CR-E4：path.resolve 对齐 worldStateHandlers.resolveProjectId（mirror fetchWorldStateSnapshotForIpc）。
    const projectId = getProject(path.resolve(projectPath))?.projectId;
    if (!projectId) return undefined; // project 未注册到 db（首跑 / 未 ensureProject）→ graceful。
    const patches = listWorldPatches(projectId);
    if (patches.length === 0) return undefined; // 首章 / 无前章状态 → graceful。
    return buildCognitionSnapshot(patches);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { projectPath, err: msg },
      'closure-chain-ipc: cognition_snapshot fetch failed → graceful skip (Reader-Audit degrades)',
    );
    return undefined;
  }
}

// ── Story 6.4 D1（6.2 DW-1，8.1 Step 5 shell 侧投影）：presence_signal 在场性预筛 fetch ──
//
// mirror write_chapter agent 路径 fetchPresenceSignalViaTool（build_world_snapshot {projection:'presence'}）+
// mirror fetchCognitionSnapshotForIpc——与 Step 3 handler presence 投影同一组合：listWorldPatches →
// buildPresenceSignal（shared-contracts 纯函数：filter cognitive evidenceSceneId + reduce physical
// presence_scene → 比对产「A 表现知情但不在 fact 揭露场」信号）。graceful：project 未注册/无 evidenceSceneId
// cognitive/无 physical presence/抛错 → undefined（不注入，info-gap 降级 6.2 既有纯语义判路径，零回归）。
// 范式判据：纯代码；裁判归 L2。
async function fetchPresenceSignalForIpc(projectPath: string): Promise<PresenceSignal[] | undefined> {
  try {
    const projectId = getProject(path.resolve(projectPath))?.projectId;
    if (!projectId) return undefined; // project 未注册 → graceful。
    const patches = listWorldPatches(projectId);
    if (patches.length === 0) return undefined;
    const signals = buildPresenceSignal(patches);
    return signals.length > 0 ? signals : undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { projectPath, err: msg },
      'closure-chain-ipc: presence_signal fetch failed → graceful skip (info-gap degrades to semantic-only)',
    );
    return undefined;
  }
}

/**
 * Story 4.6：派发裁决器子 agent（多角度初审）+ parse 建议（mirror write_chapter agent 路径的 dispatchAdjudicator）。
 *
 * 流程：dispatch adjudicator（无工具纯判断，allowedTools=[]）→ parseAdjudication 解析 → 返建议。任何失败 → null
 * （graceful 降级 D5——裁决器是增强非硬约束，失败时 summary 仍带 findings grounding + route，链段不崩）。
 *
 * 两入口一致（design §3.8「两入口一致」）：agent write_chapter + dogfood IPC 同一裁决器派发模式 + 同一 parse 源
 * （共享 parseAdjudication，DRY）。layering OK：runtime.runAgentWithExplicitSystem（4.5 落地）经 IPC 可达。
 */
async function dispatchAdjudicatorForIpc(
  runtime: ReturnType<typeof getAgentRuntime>,
  parentSessionId: string,
  summary: RunChapterChainSummary,
  chapterBrief: ChapterBrief | undefined,
): Promise<AdjudicationSuggestion | null> {
  // 裁决器不可用（旧 runtime 无此方法 / 未接线）→ graceful：返 null（D5）。
  if (typeof runtime.runAgentWithExplicitSystem !== 'function') return null;

  const vars: Record<string, string> = {
    chapterBrief: JSON.stringify(chapterBrief ?? {}),
    draftText: summary.draftText ?? '',
    escalateFindings: JSON.stringify(summary.escalateFindings ?? []),
  };
  try {
    const result = await runtime.runAgentWithExplicitSystem(
      parentSessionId,
      'adjudicator-agent',
      vars,
      { allowedTools: [] },
    );
    return parseAdjudication(result.content);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'closure-chain-ipc: adjudicator dispatch failed → graceful skip adjudication',
    );
    return null;
  }
}

/**
 * Story 7.1 Route 1：派 revision-optimizer 子 agent 编译改稿意图（mirror dispatchAdjudicatorForIpc）。
 *
 * B trigger 选区指挥精修——UI 用户选段 + 粗指令 → 本 helper 派 revision-optimizer-agent（allowedTools=
 * ['query_story'] 带只读查询帮判锁定项背景，mirror retrieval 4.5）→ parseRevisionIntent（shared-contracts
 * 三路径鲁棒）→ RevisionIntent。任何失败 → 不返 intent，返分因 outcome（graceful，mirror 裁决器 D5——
 * revision-optimizer 是增强非硬约束，失败不假信心编造意图；#90 起失败分因可观测：unavailable /
 * dispatch-failed / parse-failed，IPC 层据此出分因文案 + parse 失败 raw 落 warn 日志）。layering OK：
 * runtime.runAgentWithExplicitSystem 经 IPC 可达（同 retrieval/adjudicator）。
 *
 * 🔑 BMad CR F2（范式订正）：scope.anchor 由本 helper **纯代码构造**（buildSelectionAnchor，from/to +
 * draftText 切片），注入 intent.scope——LLM 不产 anchor（原 design 让 LLM 产 → 无 draft body/位置 →
 * hallucinate 空 prefix/suffix → 重复 quote 永远 ambiguous，blind-002/edge-002）。anchor = 非语义机械活
 * 归纯代码；LLM 只编译 change/locks/rationale/provenance。
 */
// dogfood R2 #90：revision-optimizer 编译失败分因（observability）。此前 dispatchRevisionOptimizerForIpc
// 三因（optimizer 不可用 / dispatch 抛错 / parse 失败）一律返 null——parse 失败路径完全静默（raw content
// 无处可查、IPC error 文本三因混一句，用户实碰后无法归因）。现按实际失败因分类返回，IPC 层据此出可自诊文案。
type RevisionOptimizerOutcome =
  | { status: 'ok'; intent: RevisionIntent }
  /** 旧 runtime 无 runAgentWithExplicitSystem / 未接线。 */
  | { status: 'optimizer-unavailable' }
  /** runAgentWithExplicitSystem 抛错（dispatch 层失败；message 供 error 文本摘要）。 */
  | { status: 'dispatch-failed'; message: string }
  /** optimizer 返了内容但过不了 revisionIntentSchema（raw 已截断记 warn 日志）。 */
  | { status: 'parse-failed'; contentLength: number };

/** #90：parse 失败 warn 的 raw content 截断上限（~2000 字——防超长 assistant 输出分岔/打爆单条日志行）。 */
const OPTIMIZER_RAW_LOG_CAP = 2000;

async function dispatchRevisionOptimizerForIpc(
  runtime: ReturnType<typeof getAgentRuntime>,
  input: CompileRevisionIntentInput,
): Promise<RevisionOptimizerOutcome> {
  // revision-optimizer 不可用（旧 runtime 无此方法 / 未接线）→ graceful：分类「不可用」（#90 分因）。
  if (typeof runtime.runAgentWithExplicitSystem !== 'function') {
    return { status: 'optimizer-unavailable' };
  }

  const vars: Record<string, string> = {
    selectedPassage: input.selectedPassage,
    userInstruction: input.userInstruction,
    chapterContext: input.chapterContext ?? '',
    auditFindings: input.auditFindings ?? '',
  };
  try {
    const result = await runtime.runAgentWithExplicitSystem(
      input.sessionId,
      'revision-optimizer-agent',
      vars,
      { allowedTools: ['query_story'] },
    );
    const intent = parseRevisionIntent(result.content);
    if (!intent) {
      // dogfood R2 #90：parse 失败此前完全静默。落 warn：raw content 截断（OPTIMIZER_RAW_LOG_CAP）+
      // 原文全长——「optimizer 输出过不了 revisionIntentSchema」可从主进程日志归因（真实失败已发生过一次）。
      getLogger().warn(
        {
          sessionId: input.sessionId,
          contentLength: result.content.length,
          raw: result.content.slice(0, OPTIMIZER_RAW_LOG_CAP),
        },
        'closure:compile-revision-intent: revision-optimizer output failed RevisionIntent parse (raw truncated in log)',
      );
      return { status: 'parse-failed', contentLength: result.content.length };
    }
    // F2：纯代码构造 scope.anchor 注入 intent（LLM 不产 scope）。caller 透传 from/to + draftText。
    const anchor = buildSelectionAnchor(
      input.draftText,
      input.selectedPassage,
      input.selectionFrom,
      input.selectionTo,
      input.anchorContextChars,
    );
    return { status: 'ok', intent: { ...intent, scope: { anchor } } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { sessionId: input.sessionId, err: message },
      'closure:compile-revision-intent: revision-optimizer dispatch failed → graceful null',
    );
    return { status: 'dispatch-failed', message };
  }
}

/**
 * Story 4.3 Step 6：escalate mode-gating（design §3.8）——两 IPC 入口共用（run-chapter-chain + resume-chapter-chain）。
 *
 * route=escalate_user 时按 policy.escalateMode 分派：
 * - ask（半自动/微操）→ 不动（返原 summary + autoTrustAction=null；persistChapterAcceptIfNeeded 走 4.6 degrade）。
 * - auto-trust（全自动）→ 采信裁决器 recommendation（skip 人裁决）：
 *   · accept → 返原 summary（chapter_accept 已在）+ autoTrustAction='accept'（persist 真落盘，**复用 4.6 accept 路径**）。
 *   · revise → 触发改稿重跑（mirror redo：runChapterChain resume+redo，feedback=adjudication.analysis）→ 返 redo summary。
 *   · 裁决器 null（parse 失败/超时）→ graceful fallback（返原 summary + autoTrustAction=null，**不假 pass**）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：mode-gating 分派 + redo 触发 = 纯代码机械；recommendation = LLM 语义
 * （4.6 裁决器产，不改）；auto-trust 应用 recommendation = 机械执行 LLM 判定。与 write_chapter agent 路径对齐
 * （两入口一致）。chainRunner 不消费 escalateMode（escalate 处理在入口层，design §3.8）。
 *
 * @returns { summary, autoTrustAction }——caller 用 summary 继续（可能 redo 替换）；autoTrustAction='accept' 时
 *   caller 传 autoTrustAccept=true 给 persistChapterAcceptIfNeeded（让 escalate chapter_accept 真落盘）。
 */
async function handleEscalateAutoTrust(
  runtime: ReturnType<typeof getAgentRuntime>,
  parentSessionId: string,
  summary: RunChapterChainSummary,
  policy: CheckpointPolicy,
  episodeId: string,
  chapterBrief: ChapterBrief | undefined,
  onAccept: (
    snapshot: { runId: string; artifacts: Record<string, unknown> },
    ctx: { nowISO: string },
  ) => ChapterAcceptResult,
  logTag: string,
  /** dogfood T1 Stage 6：auto-trust revise 的 redo 重跑同样流链事件（入口透传）。 */
  emitChainEvent?: (event: ChainStreamEvent) => void,
): Promise<{ summary: RunChapterChainSummary; autoTrustAction: 'accept' | 'revise' | null }> {
  // ask 模式 → 4.6 既有 IPC 路径（无裁决 UI → degrade 不落盘；**不派裁决器**保持 4.6 IPC 行为，免无消费者 LLM 调用）。
  // auto-trust 模式才派裁决器（dogfood IPC 消费 recommendation auto-apply，design §3.8）。
  if (policy.escalateMode !== 'auto-trust') {
    return { summary, autoTrustAction: null };
  }

  const adjudication = await dispatchAdjudicatorForIpc(runtime, parentSessionId, summary, chapterBrief);
  // 裁决器无建议（parse 失败/超时/方法缺）→ graceful fallback（**不假 pass**，degrade 4.6 路径）。
  if (!adjudication) {
    getLogger().warn(
      { parentSessionId },
      `${logTag}: auto-trust but adjudicator returned no suggestion → degrade (no silent accept)`,
    );
    return { summary, autoTrustAction: null };
  }

  if (adjudication.recommendation === 'accept') {
    // 链重排 W1a（R4b auto-trust→链内继续）：escalate-pause 形态（summary.status='paused'——链停在
    // route 后、E 段未跑、快照未清）下 accept 不能只采信落盘——resume 链内继续：E 段跑完 + 完成时
    // onAccept 补产候选，caller persist 路径照常（autoTrustAccept=true → direct）。mirror leader 车道
    // write_chapter 裁决 accept 的 resume 分派。终态 summary（历史形态 / redo 后再 escalate 的降级腿）
    // 维持 4.6 直接采信行为不 resume（无暂停快照可续）。
    if (summary.status === 'paused') {
      try {
        const acceptSummary = await runtime.runChapterChain(parentSessionId, {}, {
          requirement: episodeId,
          onAccept,
          mode: policy,
          resume: { fromSnapshot: true },
          ...(emitChainEvent ? { emitChainEvent } : {}),
        });
        getLogger().info(
          { parentSessionId, recommendation: adjudication.recommendation, reason: adjudication.recommendationReason, resumedStatus: acceptSummary.status },
          `${logTag}: auto-trust accept → resumed chain in-place (E segment runs, candidate produced on completion)`,
        );
        return { summary: acceptSummary, autoTrustAction: 'accept' };
      } catch (err) {
        // resume 失败 → graceful fallback（不假 pass，mirror revise 分支 degrade 姿态）：链保持暂停，
        // 不落盘不静默采信——caller 按 autoTrustAction=null 走 4.6 degrade 路径。
        const msg = err instanceof Error ? err.message : String(err);
        getLogger().warn(
          { err: msg, parentSessionId },
          `${logTag}: auto-trust accept resume failed → degrade (chain stays paused, no silent accept)`,
        );
        return { summary, autoTrustAction: null };
      }
    }
    // auto-trust accept（终态形态）：复用 4.6 accept 路径（chapter_accept → 持久化）；autoTrustAction='accept' 让 persist 落盘。
    getLogger().info(
      { parentSessionId, recommendation: adjudication.recommendation, reason: adjudication.recommendationReason },
      `${logTag}: auto-trust accept → persisting chapter_accept per adjudicator recommendation`,
    );
    return { summary, autoTrustAction: 'accept' };
  }

  // recommendation === 'revise' → 触发改稿重跑（mirror redo，design §3.8）。
  // resume 读 chainSnapshot（verdict checkpoint 持久）+ redo 移除 draft-writer-agent 让其重跑 + feedback 注入。
  // redo 再次 escalate 不再 auto-trust（caller 不再调本 helper；redo-escalate 走 persistChapterAcceptIfNeeded degrade）。
  // CR-2c：redoFrom 落点 = resume 载荷（簇 1 workflow 消费：redo 边界节点移除 + redo 清理集；与
  // options.redo 可共存）。本 helper 只在 route escalate（audit 环）下被调，规划环 pause 无
  // routeDecision 不入此门 → redoFrom 恒 'draft-writer-agent'。
  try {
    const redoSummary = await runtime.runChapterChain(parentSessionId, {}, {
      requirement: episodeId,
      onAccept,
      mode: policy,
      resume: { fromSnapshot: true, redoFrom: 'draft-writer-agent' },
      redo: { nodeId: 'draft-writer-agent', feedback: adjudication.analysis },
      ...(emitChainEvent ? { emitChainEvent } : {}),
    });
    getLogger().info(
      { parentSessionId, redoRoute: redoSummary.routeDecision?.decision },
      `${logTag}: auto-trust revise → redo chain rerun completed`,
    );
    return { summary: redoSummary, autoTrustAction: 'revise' };
  } catch (err) {
    // redo 失败 → graceful fallback（不崩 IPC）：返原 escalate summary + autoTrustAction=null（degrade，**不假 pass**）。
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(
      { err: msg, parentSessionId },
      `${logTag}: auto-trust revise redo failed → degrade to 4.6 escalate path (no silent accept)`,
    );
    return { summary, autoTrustAction: null };
  }
}

/**
 * Story 2.2 WP-E（CR-08-16-201）+ 链流程重排 W4（R6 / plan-review L5）：story-sync 反哺 patches 档位
 * 分流单源（resume 终态消费 applyStorySyncOnResume + 链外重提取 re-extract-chapter 双消费）。
 *
 * mirror applyStorySyncFeedback 档位判定（write_chapter 同源 cap `STORY_SYNC_REVIEW_CAP` + 出处 label
 * helper，防两处漂移）：
 *
 * - **auto 档**：story_sync_apply(autoApply=true) 直落（语义背书 = 接受正文为真相，同 leader 路径；
 *   超 cap 强转人审）→ {landed}（UI toast 告知，非静默）。
 * - **suggest / readonly 档**：投影 envelope 组 {review} 返 UI → PatchReview 人审（readonly 在无文字
 *   建议通道的路径同样进人审：PatchReview accept 是作者动作非 agent 写入）。
 * - 直调 storySyncApplyHandler（shell 同进程 handler；cap / 白名单 / merge-only / 版本锁机械门照常
 *   生效）。graceful：反哺失败只 warn 返 undefined（增强非硬约束）。
 *
 * @returns {landed} / {review} / undefined（全部被机械门拒——投影拒绝详情在 res.output，log 可查）。
 */
async function stageStorySyncFeedback(args: {
  patches: NovelStorySyncPayload['patches'];
  runId: string;
  chapterId: string;
  projectPath: string;
  sessionId: string;
  permissionMode: 'readonly' | 'suggest' | 'auto';
}): Promise<
  | { kind: 'landed'; landed: { note: string; fields: string[] } }
  | { kind: 'review'; review: { note: string; patches: FieldPatchEntry[] } }
  | undefined
> {
  const { patches, projectPath, sessionId, permissionMode } = args;
  const label = args.chapterId;
  const note = `${formatStorySyncChapterLabel(label)} story-sync 提取`;
  const overCap = patches.length > STORY_SYNC_REVIEW_CAP;
  const autoApply = permissionMode === 'auto' && !overCap;

  try {
    const res = await storySyncApplyHandler({
      params: {
        runId: args.runId,
        patches,
        ...(autoApply ? { autoApply: true } : {}),
        chapterNote: note,
      },
      projectDir: projectPath,
      sessionId,
      // repo 惯例占位（llm-node.ts:115 同款）——本 handler 不消费 abort。
      abort: new AbortController().signal,
    });
    const meta = res.metadata as
      | {
          applied?: boolean;
          appliedFields?: string[];
          patches?: Array<{ field: string; action: string; data: unknown; fieldVersion?: number; note?: string }>;
        }
      | undefined;

    if (meta?.applied === true) {
      return { kind: 'landed', landed: { note, fields: meta.appliedFields ?? [] } };
    }
    const envelopes = Array.isArray(meta?.patches) ? meta!.patches! : [];
    if (envelopes.length > 0) {
      // mirror agentSessionSlice storySyncPatches 路由的 FieldPatchEntry 形态（generatedBy 标真实出处）。
      return {
        kind: 'review',
        review: {
          note,
          patches: envelopes.map((e): FieldPatchEntry => ({
            field: e.field as FieldPatchEntry['field'],
            action: 'set',
            data: e.data,
            fieldVersion: typeof e.fieldVersion === 'number' ? e.fieldVersion : 0,
            generatedBy: 'story-sync-agent',
          })),
        },
      };
    }
    // 全部被机械门拒（applied=false 且零 envelope）：投影拒绝详情已在 res.output（log 可查）；
    // 与 write_chapter「全拒=零事件」的文案面等价——不造静默 toast。
    getLogger().info(
      { projectPath, sessionId, note, output: res.output },
      'closureChainIpc: story-sync patches all rejected in projection (feedback not staged)',
    );
    return undefined;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectPath, sessionId },
      'closureChainIpc: story-sync apply failed (feedback not landed, caller continues)',
    );
    return undefined;
  }
}

/**
 * Story 2.2 WP-E（CR-08-16-201）：resume 终态 story-sync 反哺消费（resume-chapter-chain 专用）。
 *
 * suggest 档（缺省档）链段必在 draft checkpoint pause——终态提取只经 resume IPC 回到落盘点，
 * write_chapter 的 applier 对 paused 早退（write-chapter.ts `isPaused → null`），不在此消费 =
 * 缺省档每章补丁静默丢弃（三层 reviewer 收敛的 HIGH）。档位分流单源 = stageStorySyncFeedback
 * （W4 抽出，与链外重提取共用；cap / 出处 label / 机械门零漂移）：
 *
 * - **gate**：completed + route 终态（accept_as_truth / escalate+放手采信 autoTrustAccept）才消费；
 *   再 pause → 下一轮 resume 处理；aborted/error / escalate 待裁决（ask 档）跳过——裁决材料呈现
 *   归 4.6，补丁数据留在 summary.storySync 随裁决可见（mirror write_chapter escalate 呈现形态）。
 */
async function applyStorySyncOnResume(args: {
  summary: RunChapterChainSummary;
  projectPath: string;
  sessionId: string;
  permissionMode: 'readonly' | 'suggest' | 'auto';
  chapterId: string | undefined;
  autoTrustAccepted: boolean;
}): Promise<void> {
  const { summary, projectPath, sessionId, permissionMode, chapterId, autoTrustAccepted } = args;
  const patches = summary.storySync?.patches;
  if (!patches || patches.length === 0) return;
  if (summary.status !== 'completed') return;
  const decision = summary.routeDecision?.decision;
  const isTerminal =
    decision === 'accept_as_truth' || (decision === 'escalate_user' && autoTrustAccepted);
  if (!isTerminal) return;

  const staged = await stageStorySyncFeedback({
    patches,
    runId: summary.storySync?.runId ?? 'story-sync-resume',
    chapterId: summary.chapter_accept?.chapterId ?? chapterId ?? summary.storySync?.chapterId ?? '',
    projectPath,
    sessionId,
    permissionMode,
  });
  if (staged?.kind === 'landed') {
    summary.storySyncLanded = staged.landed;
    return;
  }
  if (staged?.kind === 'review') {
    summary.storySyncReview = staged.review;
    return;
  }
  // 全拒（undefined）：投影拒绝详情已在 stageStorySyncFeedback log；与 write_chapter「全拒=零事件」
  // 文案面等价——resume 路径无 leader 文字通道，不造静默 toast。
  // dogfood R2 #93 已核隔离：本函数只消费 summary.storySync 反馈补丁，拒绝**不殃及**
  // chapter_accept envelope（独立 key，review 档随 summary 返 UI 人审）——两股互不影响。
}

/**
 * #107 R1.1 自动建章判定的入口上下文（run/resume 两车道各自组装，persistChapterAcceptIfNeeded 消费）。
 *
 * - episodeId / episodeOutlines / novelChapters / directChapterId：判定输入（planAutoCreateChapter 单源）。
 * - runId：onAccept 闭包捕获的链段 runId（no-chapter skip 发生时留档）——补产 envelope 的
 *   last_run_id / StoryDecision id 源；闭包未跑（mock / paused-resume continue 路径 route 被跳过）
 *   → 调用方兜底 randomUUID。
 */
interface ChapterAutoCreateContext {
  episodeId: string;
  episodeOutlines?: ReadonlyArray<ResolvableEpisode>;
  novelChapters?: ReadonlyArray<ResolvableChapter>;
  directChapterId?: string;
  runId?: string;
}

/**
 * Story 4.3 Step 3：chapter_accept 持久化 + accept/escalate 文案 helper（run-chapter-chain + resume-chapter-chain 共用）。
 *
 * 抽自 run-chapter-chain 既有内联块（行为不变，DRY——两入口 resume 续跑 accept 也须持久化，否则 dogfood resume
 * 路径丢工作）。mutates summary.errors（持久化失败 / escalate 候选未落盘 / accept 章映射失败告知）。
 *
 * - **#107 R1.1 前置（dogfood R2 首章冷启动）**：no-chapter（skipReason 或兜底）+ 空位判定（planAutoCreateChapter
 *   单源：未显式传 chapterId + 0 命中 + R1.1d 落位守卫）+ draftText 在 → 经 chapterWriteHandler 建
 *   `chapters/<stem>.md`。**模式门（用户拍板）**：mode='direct' 建全文（正文=采信稿）；mode='review' 只建
 *   骨架（frontmatter+标题无正文——review「写内容须人批」语义不破）。建后补产 summary.chapter_accept
 *   envelope（chapterId=stem，candidate.content=完整文件形态保 frontmatter——accept 落盘整体覆盖写，
 *   body-only 会抹掉 order 致派生重排错位），含 storyDecisions（R1.1c：summary.routeDecision.deviation
 *   投影 + buildAcceptStoryDecisions 单源，不静默降级）。
 * - accept_as_truth + chapter_accept → acceptChapterCandidate（经 withProjectLock 串行，CR-4.1-03）写盘。
 *   **direct + 自动建章时容忍失败**：注册是 renderer 驱动（派生 300ms debounce 未至），acceptChapterCandidate
 *   在注册前调用必 throw「chapter not found」——文件即落点（与 #107 救场实录一致），注册等 app 打开项目后
 *   由派生补上；chapterPersisted=true 告知 UI 免二次 stage。
 * - escalate_user → 不落盘（dogfood IPC 无裁决 UI；正文在 summary.draftText，findings 在 escalateFindings），
 *   **除非** autoTrustAccept=true（Story 4.3 Step 6：全自动模式 auto-trust accept 复用 4.6 accept 路径真落盘）。
 * - accept 但 chapter_accept 缺省 → describeAcceptSkip 文案（CR-4.1-08）。
 *
 * dogfood R2 #93（P0-2，2026-08-28）`mode` 参数——resume 入口的落盘语义按会话档位分派：
 * - `'direct'`（run 入口恒用 / resume 入口 auto 档或 dogfood stub 会话——stub 车道无审核面板消费面，
 *   链卡 resume 钮不消费 envelope）：既有行为——accept 直落 chapters/（成功置
 *   `summary.chapterPersisted = true` 供 UI 免双 stage）。
 * - `'review'`（resume 入口 suggest/readonly leader 会话）：**不直落**——envelope 留 summary.chapter_accept
 *   返 UI，chapterReviewSlice.runResume stage 进 pendingPatch 人审（mirror leader write_chapter 的
 *   metadata field_patch 路径——resume 车道跑在 leader 工具调用生命周期外，envelope 只能经 resume summary
 *   返 UI；此前无条件直落 = suggest 档绕过人审 + UI 侧零感知）。escalate+ask 档也不加「dogfood 无裁决 UI」
 *   degrade 文案（UI PatchReview 就是裁决面）；accept/escalate 无候选时仍 errors 告知（skipReason 文案）。
 *
 * @param logTag           调用方 channel 名（日志辨识）。
 * @param autoTrustAccept  Story 4.3 Step 6：auto-trust accept 时传 true → escalate chapter_accept 真落盘（design §3.8）。
 * @param mode             #93 P0-2：'direct'（直落，缺省）| 'review'（envelope 返 UI 人审）。兼作 #107 模式门
 *                         （direct 建全文 / review 建骨架）——同档位语义，一源两用。
 * @param autoCreate       #107 R1.1：判定上下文（episodeId + project 数据 + 闭包捕获 runId）。缺省（旧调用方 /
 *                         测试）不自动建，行为零回归。
 */
async function persistChapterAcceptIfNeeded(
  projectPath: string,
  summary: RunChapterChainSummary,
  acceptSkipReason: ChapterAcceptSkipReason | undefined,
  logTag: string,
  autoTrustAccept = false,
  mode: 'direct' | 'review' = 'direct',
  autoCreate?: ChapterAutoCreateContext,
): Promise<void> {
  // ── #107 R1.1 前置：no-chapter 自动建章（判定 + 建文件 + envelope 补产）──
  // skipReason 兜底 'no-chapter'（mirror describeAcceptSkip 调用点兜底：mock / paused-resume continue
  // 路径闭包未跑但 chapter_accept 缺 + accept/escalate 终态，现实就是章未注册）。no-draft 明确排除。
  let autoCreated = false;
  if (!summary.chapter_accept && (acceptSkipReason ?? 'no-chapter') === 'no-chapter' && autoCreate) {
    const plan = planAutoCreateChapter({
      episodeId: autoCreate.episodeId,
      ...(autoCreate.episodeOutlines ? { episodeOutlines: autoCreate.episodeOutlines } : {}),
      ...(autoCreate.novelChapters ? { novelChapters: autoCreate.novelChapters } : {}),
      ...(autoCreate.directChapterId ? { directChapterId: autoCreate.directChapterId } : {}),
      ...(summary.draftTitle !== undefined ? { title: summary.draftTitle } : {}),
    });
    if (plan && summary.draftText !== undefined) {
      try {
        await chapterWriteHandler({
          params: {
            chapterId: plan.stem,
            content: mode === 'direct'
              ? autoCreatedChapterFileContent(plan, summary.draftText)
              : autoCreatedChapterFileContent(plan),
          },
          projectDir: projectPath,
          sessionId: 'closure-chain-auto-create',
          abort: new AbortController().signal,
        });
        autoCreated = true;
        // envelope 补产（onAccept 已在链内同步调用过不可重入，入口层组装——directChapterId=stem 语义）。
        // storyDecisions 补产（R1.1c 不降级）：summary.routeDecision.deviation 投影 + 单源构造器。
        const autoStoryDecisions = buildAcceptStoryDecisions({
          routeDecision: summary.routeDecision,
          episodeId: autoCreate.episodeId,
          runId: autoCreate.runId ?? randomUUID(),
          nowISO: new Date().toISOString(),
        });
        const envelope: ChapterAcceptArtifact = {
          chapterId: plan.stem,
          candidate: {
            title: plan.title,
            // 完整文件形态（frontmatter+标题+正文）：review 档人审 accept 落盘整体覆盖写——body-only
            // 候选会把 frontmatter 连 order 抹掉 → 派生重排错位（#107 最高风险事故）。
            content: autoCreatedChapterFileContent(plan, summary.draftText),
            ...(summary.draftWordCount !== undefined ? { wordCount: summary.draftWordCount } : {}),
          },
          runId: autoCreate.runId ?? randomUUID(),
          ...(autoStoryDecisions && autoStoryDecisions.length > 0 ? { storyDecisions: autoStoryDecisions } : {}),
        };
        summary.chapter_accept = envelope;
        getLogger().info(
          { projectPath, episodeId: autoCreate.episodeId, stem: plan.stem, episodeIndex: plan.episodeIndex, mode },
          `${logTag}: #107 auto-created chapter file（no-chapter 救场；frontmatter order = 登记载体，磁盘派生注册自动闭环）`,
        );
      } catch (autoErr) {
        // graceful：建文件失败不 fail resume/run——维持现状告警（describeAcceptSkip 文案指路手建）。
        getLogger().warn(
          { err: autoErr instanceof Error ? autoErr.message : String(autoErr), projectPath, episodeId: autoCreate.episodeId },
          `${logTag}: #107 auto-create chapter file failed → graceful（维持现状告警，不建）`,
        );
      }
    } else if (plan) {
      getLogger().info(
        { projectPath, episodeId: autoCreate.episodeId, stem: plan.stem },
        `${logTag}: #107 auto-create skipped — summary 无 draftText（候选无法组装）`,
      );
    }
  }

  const isEscalate = summary.routeDecision?.decision === 'escalate_user';
  if (summary.chapter_accept && (!isEscalate || autoTrustAccept)) {
    const ca = summary.chapter_accept;
    if (mode === 'review') {
      // #93 P0-2：review 档不落盘——envelope 随 summary 返 UI 进 pendingPatch（PatchReview accept 后经
      // applyAgentFieldPatch → acceptChapterCandidateCore 落 chapters/，与 leader 路径同一收口）。
      // #107：自动建的骨架章此时已注册（建文件 → notifyUI → 300ms debounce 派生；人审节奏 >> 300ms），
      // acceptChapterCandidateCore 按 id 命中；竞态输了也是 CR-4.1-04 显式 toast 非静默丢。
      getLogger().info(
        { projectPath, chapterId: ca.chapterId, runId: ca.runId, autoCreated },
        `${logTag}: chapter_accept envelope 返 UI 人审（review 档不直落——mirror write_chapter metadata 路径）`,
      );
      return;
    }
    try {
      const { acceptChapterCandidate } = await import('@orison/desktop-local-bff');
      // CR-4.1-03：acceptChapterCandidate 经 withProjectLock 串行化（mirror fieldSyncIpc field:apply-agent-patch）。
      // **return promise**：async 落盘异常经 withProjectLock 的 await 传到本 try/catch——块体语句形态
      // 会弃 promise 致 rejection 漂浮 unhandled（下方 catch 的 autoCreated 容忍分支永不触发）。
      await withProjectLock(projectPath, () =>
        acceptChapterCandidate(
          projectPath,
          ca.chapterId,
          ca.runId,
          ca.candidate,
          ca.storyDecisions,
        ),
      );
      // #93 P0-2：落盘去向标记（UI 据此免二次 stage——envelope 在但已落，stage 会双写）。
      summary.chapterPersisted = true;
      getLogger().info(
        { projectPath, chapterId: ca.chapterId, runId: ca.runId, autoTrustAccept },
        `${logTag}: chapter candidate persisted${autoTrustAccept ? ' (auto-trust accept)' : ''}`,
      );
    } catch (persistErr) {
      const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      if (autoCreated) {
        // #107 R1.1 容忍：direct 车道刚建的文件注册滞后（renderer 派生 300ms debounce 未至）→
        // acceptChapterCandidate 找不到章必 throw——**文件即落点**（含全文 + frontmatter order），
        // 注册等 app 打开项目后由派生补上（与 #107 救场实录一致）；storyDecisions 随下次注册补登。
        // chapterPersisted=true 告知 UI 正文已落（免二次 stage）。
        summary.chapterPersisted = true;
        getLogger().info(
          { projectPath, chapterId: ca.chapterId, err: pmsg },
          `${logTag}: chapter meta persist tolerated — #107 auto-created file is the landing point（注册滞后，派生后补）`,
        );
      } else {
        getLogger().error(
          { err: pmsg, projectPath, chapterId: ca.chapterId },
          `${logTag}: chapter candidate persistence failed`,
        );
        summary.errors = [...summary.errors, `chapter persist failed: ${pmsg}`];
      }
    }
  } else if (isEscalate && !autoTrustAccept) {
    if (mode === 'review') {
      // #93 P0-2：review 档 escalate——有候选则随 summary 返 UI（PatchReview accept=接受为真相 / reject=改稿，
      // mirror write_chapter 4.6 呈现语义）；无候选才 errors 告知（UI 终态 toast 消费，不静默）。
      if (!summary.chapter_accept) {
        summary.errors = [
          ...summary.errors,
          `灰区上发：无章节候选（${describeAcceptSkip(acceptSkipReason ?? 'no-chapter')}）——无法落盘，请在对话中裁决处理`,
        ];
      }
      return;
    }
    getLogger().info(
      { projectPath, hasChapterAccept: !!summary.chapter_accept, autoCreated, findingsCount: summary.escalateFindings?.length ?? 0 },
      `${logTag}: escalate → not persisting chapter_accept (dogfood no adjudication UI); summary returned`,
    );
    summary.errors = [...(summary.errors ?? []), autoCreated
      ? '灰区裁决：自动建章文件已落盘（#107），章节元数据待注册后补——裁决信息在 escalateFindings'
      : '灰区裁决：chapter_accept 候选未落盘（dogfood IPC 无裁决 UI）；正文在 summary.draftText，裁决信息在 escalateFindings'];
  } else if (summary.routeDecision?.decision === 'accept_as_truth') {
    summary.errors = [
      ...summary.errors,
      `accept 未持久化——${describeAcceptSkip(acceptSkipReason ?? 'no-chapter')}`,
    ];
  }
}

/**
 * dogfood T1 Stage 6（design §4，r1 坑「dogfood IPC 入口的窗引用」）：链事件发送器构造——
 * 复用 agentIpc 的 `agent:stream-event` 通道 + 载荷形态（{...event, sessionId, projectPath}，
 * S2 起含 projectPath——全局监听项目隔离消费同一形态）。try/catch 窗口关闭守卫照抄
 * agentIpc sendEvent（窗口重建由 getWin 懒解析兜底，mirror registerAgentIpc(getWin) 模式）。
 * getWin 缺省（旧调用方 / 测试）→ 返 undefined（链事件不开，链段行为零变化）。
 */
function makeChainEventSender(
  getWin: (() => BrowserWindow | null) | undefined,
  sessionId: string,
  projectPath: string,
): ((event: ChainStreamEvent) => void) | undefined {
  if (!getWin) return undefined;
  return (event) => {
    try {
      getWin()?.webContents.send('agent:stream-event', { ...event, sessionId, projectPath });
    } catch {
      // Window may have been closed（mirror agentIpc sendEvent 守卫）
    }
  };
}

export function registerClosureChainIpc(getWin?: () => BrowserWindow | null) {
  ipcMain.handle(
    'closure:run-chapter-chain',
    async (_, input: RunChapterChainInput): Promise<RunChapterChainSummary> => {
      // CR-7：IPC 入口 Zod 校验（mirror write_chapter agent tool 的 chapterBriefSchema 校验，两入口一致）。
      // 复用 runChapterChainInputSchema（chapterBriefSchema.optional() 单源真值）。失败按 spec 模式 A 返
      // {status:'error', errors:[...]}（非抛——dogfood 调用方收到结构化错误）。
      const parsed = runChapterChainInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: 'error',
          errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        };
      }
      const { projectPath, episodeId, chapterBrief, chapterId, autonomy } = parsed.data;

      // CR-10：loadProject 前路径守卫（mirror sceneGraphHandlers / closureIndexIpc 等既有 closure IPC 姿态）。
      // assertSafePath 抛 → catch 路径返回 error（防 IPC 读 OrisonSpace 根外文件）。
      try {
        assertSafePath(projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', errors: [`projectPath rejected: ${msg}`] };
      }

      // dogfood T1 Stage 3（design §5.4 D4）：同项目单 run 闸——占用时结构化拒绝（errors 首条
      // 机器可读前缀 project_run_active，含占用者 id + 项目路径）。**释放 = handler finally
      // （经 acquire 返回的 handle）**。
      // CR-T1-020：**每次 invoke 生成唯一租约 id**（`${CHAIN_RUN_LEASE_ID}:${uuid}`）——旧常量
      // id 下同项目两条并发链第二路恒放行（acquire 按 sessionId 判重入）+ 先完成者 finally 删掉
      // 后者租约。唯一 id 让两路互斥；前缀保留供 UI 识别「链占用」（跳转钮换文案）。
      const chainLeaseId = `${CHAIN_RUN_LEASE_ID}:${randomUUID()}`;
      const runGate = acquireProjectRun(projectPath, chainLeaseId);
      if (!runGate.ok) {
        getLogger().info(
          { projectPath, heldBy: runGate.held.sessionId },
          'closure:run-chapter-chain rejected: another run active in this project',
        );
        return {
          status: 'error',
          errors: [`project_run_active|heldBy=${runGate.held.sessionId}|project=${runGate.held.projectPath}`],
        };
      }
      try {
        const runtime = getAgentRuntime();

        // Load project via local-bff (migration + schema validation — authoritative read,
        // mirror sceneGraphHandlers.readSceneGraph). null = corrupt/missing project.
        let doc: Record<string, unknown> | null;
        try {
          const { loadProject } = await import('@orison/desktop-local-bff');
          doc = loadProject(projectPath) as Record<string, unknown> | null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          getLogger().error({ err: msg, projectPath }, 'closure:run-chapter-chain: loadProject threw');
          return { status: 'error', errors: [`loadProject failed: ${msg}`] };
        }
        if (!doc) {
          return {
            status: 'error',
            errors: [`project.yaml at ${projectPath} could not be loaded (corrupt or missing)`],
          };
        }

        // Create a stub parent session (dogfood has no leader session). dispatchSubagent
        // inside runChapterChain / runAgentWithExplicitSystem creates the real child session
        // from this parent. Chain LLM models come from the C3.2 task-model slots
        // (unconfigured slots → provider default sentinel → shell auto-pick).
        //
        // Story 4.5：stub parent 在 assemble 前创建——retrieval dispatch 需要 parentSessionId
        // （mirror write_chapter agent 路径：leader session 即 retrieval 的 parent）。
        const parent = runtime.createSession({
          agentName: 'chapter-chain-dogfood',
          projectPath,
          // Story 4.3：stub 用 IPC 传入的 autonomy（default 'auto' 全自动——dogfood 端到端完成零回归；
          // 传 'suggest'/'readonly' 可测 pause+resume）。mode 经此流入 stub session → deriveCheckpointPolicy
          // 推（与 leader write_chapter 读 session.permissionMode 一致，KD1）。
          mode: autonomy,
        });

        const initialArtifacts = assembleChapterChainArtifacts(
          {
            // doc = loadProject 产出（full ProjectDocument，schema 已校验；含 novel.story_decisions[]，
            // 4.1 Step 3 design §3.5 落库点）。ChapterChainProjectInput.story_decisions 是 flat 字段
            // （assemble 统一从此读），故从 doc.novel 抽出注入（mirror write-chapter loadChainProjectInput）。
            ...(doc as ChapterChainProjectInput),
            story_decisions: (doc as { novel?: { story_decisions?: StoryDecision[] } }).novel?.story_decisions,
          },
          episodeId,
          chapterBrief,
        );

        // 4.1 §3.2 运行时 gate：跑链段前算 brief readiness，non-ready 阻断 + 返「缺什么」（mirror write_chapter
        // agent tool 两入口一致）。computeReadiness 纯函数用 initialArtifacts 直接算，不跑链段。
        //
        // **BMad CR P1（Blind+Edge medium）**：gate 在子 agent 派发（裁决器/revision-optimizer）**之前**——
        // 它们是多步 LLM 调用，non-ready brief 时 gate 阻断会把派发结果整个弃掉，白烧算力。
        // computeReadiness 只看 scene_graph / settings / goal / episode 匹配，故 gate-first 与派发
        // 无序耦合——先 gate 安全。用 raw chapterBrief 算 gate，两入口一致（trellis-check #1）。
        const sceneGraph = initialArtifacts['scene_graph'] as SceneGraph | undefined;
        const settingsContext = initialArtifacts['settings_context'];
        const settingsPresent = typeof settingsContext === 'string' && settingsContext.trim().length > 0;
        const rawLeaderBrief = chapterBrief ?? {};
        const readiness = computeReadiness(rawLeaderBrief, sceneGraph, episodeId, settingsPresent);
        try {
          assertBriefReady({ ...rawLeaderBrief, readiness });
        } catch (err) {
          if (err instanceof BriefNotReadyError) {
            return {
              status: 'error',
              errors: [`Brief 未就绪，无法开始写章（${err.readiness}）：${err.missing}`],
            };
          }
          throw err;
        }

        // Story 6.6 Phase D：world_state_snapshot 一致基底注入（mirror write_chapter agent 路径）。gate 后取
        // snapshot（gate 阻断时不浪费 db 查询）。graceful——fetch 失败/无数据/项目未注册 → undefined → 不注入
        // artifact（Reader-Audit buildPrompt 降级空段，照现有 artifact 缺失处理）。
        const worldStateSnapshot = await fetchWorldStateSnapshotForIpc(projectPath);
        if (worldStateSnapshot) {
          initialArtifacts['world_state_snapshot'] = worldStateSnapshot;
        }

        // Story 6.2：cognition_snapshot 注入（Reader-Audit 认知状态机维数据源，mirror world_state_snapshot caller 注入 +
        // mirror write_chapter agent 路径）。gate 后取 snapshot（gate 阻断时不浪费 db 查询）。graceful——fetch 失败/无
        // cognitive patches/项目未注册 → undefined → 不注入 artifact（Reader-Audit buildPrompt 降级空段）。
        const cognitionSnapshot = await fetchCognitionSnapshotForIpc(projectPath);
        if (cognitionSnapshot) {
          initialArtifacts['cognition_snapshot'] = cognitionSnapshot;
        }

        // Story 6.4 D1（6.2 DW-1）：presence_signal 注入（info-gap 在场性预筛数据源，mirror cognition_snapshot caller 注入 +
        // mirror write_chapter agent 路径）。graceful——无 evidenceSceneId cognitive/无 physical presence/失败 → undefined
        // → 不注入 artifact（info-gap 降级纯语义判，零回归）。
        const presenceSignal = await fetchPresenceSignalForIpc(projectPath);
        if (presenceSignal) {
          initialArtifacts['presence_signal'] = presenceSignal;
        }

        // 风格卡片 MVP CR-026（08-28 BMad CR auditor#3）：style_context 注入——IPC 孪生入口此前
        // 漏注（write-chapter.ts B 路注释曾明示 agent-only），dogfood 直跑链写手无风格上下文。
        // 与 leader write_chapter 路径**同口径**：agent 包 readStyleCardBody + buildStyleContext
        // 单源直调（零逻辑复制，mirror deriveCheckpointPolicy 导入先例）。无卡/空卡体/读失败 →
        // undefined → 不注入 artifact（无卡项目 IPC 输出与旧版一致，零回归）；不注入
        // style_context_brief——planner 派发侧（dispatch-planners）现读现编，非链内 artifact（CR-006）。
        const styleCardBody = await readStyleCardBody(projectPath);
        if (styleCardBody) {
          const styleContext = buildStyleContext(styleCardBody);
          if (styleContext) initialArtifacts['style_context'] = styleContext;
        }

        // 4.1 Step 4（CR-15b）：onAccept 闭包——accept 分支产 chapter_accept artifact（不写盘）。闭包捕获
        // doc 数据（episode_outlines + novel.chapters）做 chapterId 解析（buildChapterAccept）；chapterId 直传优先。
        // doc = full ProjectDocument（loadProject 产出，含 episode_outlines + novel.chapters），满足 Resolvable 类型。
        const episodeOutlines = (doc as { episode_outlines?: ResolvableEpisode[] }).episode_outlines;
        const novelChapters = (doc as { novel?: { chapters?: ResolvableChapter[] } }).novel?.chapters;
        // CR-4.1-08：onAccept 闭包捕获 skipReason（no-draft/no-chapter/no-nowiso），accept 但 chapter_accept
        // 缺省时据此出对应文案（非旧统一「章未注册」误导——no-draft 是 draft-writer 没写正文 ≠ 章未注册）。
        // #107 R1.1c：no-chapter skip 发生时链段 runId 留档——补产 envelope 的 last_run_id /
        // StoryDecision id 源（与正常路径同构）。
        let acceptSkipReason: ChapterAcceptSkipReason | undefined;
        let acceptSkipRunId: string | undefined;
        const onAccept = (
          snapshot: { runId: string; artifacts: Record<string, unknown> },
          ctx: { nowISO: string },
        ): ChapterAcceptResult => {
          const result = buildChapterAccept(snapshot, {
            nowISO: ctx.nowISO,
            episodeId,
            ...(episodeOutlines ? { episodeOutlines } : {}),
            ...(novelChapters ? { novelChapters } : {}),
            ...(chapterId ? { directChapterId: chapterId } : {}),
          });
          if ('skipReason' in result) {
            acceptSkipReason = result.skipReason;
            if (result.skipReason === 'no-chapter') acceptSkipRunId = snapshot.runId;
          }
          return result;
        };

        // Story 4.3 Step 3（design §3.5 / §4 映射表）：mode 从 stub parent session.permissionMode 推（KD1）。
        // stub 默认 'suggest'（createSession 兜底）→ pauseStages=['draft']（dogfood 检视草稿 + resume 续跑）。
        // 两入口一致：mirror leader write_chapter 从 session.permissionMode 推（design §3.5）。escalateMode 透传，
        // Step 6 route=escalate 分支消费（auto-trust 采信裁决器建议 / ask 走 4.6 degrade）。
        const policy = deriveCheckpointPolicy(parent.permissionMode ?? 'suggest');

        // dogfood T1 Stage 6：链事件发送器（sessionId = stub parent——与 leader 路径的 leader 会话
        // 同语义，事件按 parentSessionId 广播）。getWin 缺省 → undefined（零事件零回归）。
        const emitChainEvent = makeChainEventSender(getWin, parent.id, projectPath);

        try {
          // 显式 ipc type（mirror resume handler）：runtime 返 agent RunSnapshotSummary（结构兼容），
          // 本 handler 要挂 chapterPersisted / derivationStale 等 ipc 侧 additive 字段。
          let summary: RunChapterChainSummary = await runtime.runChapterChain(parent.id, initialArtifacts, {
            requirement: episodeId,
            onAccept,
            mode: policy,
            ...(emitChainEvent ? { emitChainEvent } : {}),
          });

          // Story 4.3 Step 6（design §3.8）：escalate mode-gating。route=escalate_user 时按 policy.escalateMode 分派
          // （auto-trust 采信裁决器 recommendation / ask 走 4.6 degrade）。两入口一致（mirror write_chapter agent 路径）。
          // auto-trust accept → 复用 4.6 accept 路径真落盘（autoTrustAccept=true）；revise → redo 重跑；parse 失败 → degrade（不假 pass）。
          let autoTrustAccept = false;
          if (summary.routeDecision?.decision === 'escalate_user') {
            const result = await handleEscalateAutoTrust(
              runtime,
              parent.id,
              summary,
              policy,
              episodeId,
              chapterBrief,
              onAccept,
              'closure:run-chapter-chain',
              emitChainEvent,
            );
            summary = result.summary;
            autoTrustAccept = result.autoTrustAction === 'accept';
          }

          // 4.1 Step 4（CR-15b）/ Story 4.3 Step 3/6：accept 持久化经共享 helper（resume 入口复用，DRY）。
          // autoTrustAccept=true → escalate chapter_accept 真落盘（auto-trust accept 复用 4.6 accept 路径）。
          // #107 R1.1：run 入口恒 direct（#93 拍板——stub 车道无审核面板消费面）→ 自动建章 = 全文直落；
          // autoCreate 上下文 = 判定输入（doc 数据 + episodeId/chapterId）+ 闭包捕获 runId。
          await persistChapterAcceptIfNeeded(projectPath, summary, acceptSkipReason, 'closure:run-chapter-chain', autoTrustAccept, 'direct', {
            episodeId,
            ...(episodeOutlines ? { episodeOutlines } : {}),
            ...(novelChapters ? { novelChapters } : {}),
            ...(chapterId ? { directChapterId: chapterId } : {}),
            ...(acceptSkipRunId !== undefined ? { runId: acceptSkipRunId } : {}),
          });

          // ── 链流程重排 W2（R4c / AC2c）：E 段提取失败 post-hoc 落正文（mirror write_chapter 兜底）──
          //
          // derivationStale = 终稿已定（route accept）但提取段 error 中断——正文先落盘（终稿不随提取
          // 中断丢失），章标 stale 随 summary 返 UI（重提取修复通道归 W4）。仅落已注册章（body-only
          // chapterWriteHandler——preserveChapterFrontmatter 守 frontmatter）；失败/未注册 → summary
          // 仍带 derivationStale + draftText（观察面如实，正文在链快照中不丢）。
          if (summary.derivationStale === true && summary.draftText !== undefined) {
            const staleChapterId = chapterId ?? resolveChapterIdForEpisode(episodeOutlines, novelChapters, episodeId);
            if (staleChapterId && (novelChapters ?? []).some((ch) => ch?.id === staleChapterId)) {
              try {
                await chapterWriteHandler({
                  params: { chapterId: staleChapterId, content: summary.draftText },
                  projectDir: projectPath,
                  // run 入口的 stub parent 会话 id（resume 入口才直接持 sessionId）。
                  sessionId: parent.id,
                  abort: new AbortController().signal,
                });
                summary.chapterPersisted = true;
                getLogger().info(
                  { projectPath, chapterId: staleChapterId, episodeId },
                  'closure:run-chapter-chain: derivationStale → post-hoc prose landing（E 段失败正文先落盘）',
                );
              } catch (staleErr) {
                getLogger().warn(
                  { err: staleErr instanceof Error ? staleErr.message : String(staleErr), projectPath, chapterId: staleChapterId },
                  'closure:run-chapter-chain: derivationStale post-hoc landing failed → summary only（draftText 在链快照中）',
                );
              }
            }
          }

          getLogger().info(
            {
              projectPath,
              episodeId,
              status: summary.status,
              routeDecision: summary.routeDecision?.decision,
              reviewVerdict: summary.reviewVerdict,
              persisted: !!summary.chapter_accept,
              autoTrustAccept,
            },
            'closure:run-chapter-chain: chain completed',
          );
          return summary;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          getLogger().error({ err: msg, projectPath, episodeId }, 'closure:run-chapter-chain: chain failed');
          // dogfood T1 check：硬 throw 路径（runChain 外围 infra 失败——dispatch/落盘等，
          // 非 ChainAbortedError）无哨兵终态帧且链车道无 done 事件兜底——补发 error 哨兵，
          // 防 UI 链卡 + agentRunStates 永久挂 running（isProjectRunActive 全项目闸死）。
          emitChainEvent?.({ type: 'chain-node-done', data: { nodeId: CHAIN_RUN_SENTINEL_NODE_ID, status: 'error' } });
          return { status: 'error', errors: [`chapter chain failed: ${msg}`] };
        }

      } finally {
        runGate.release();
      }
    },
  );

  // ── Story 4.3 Step 3：closure:resume-chapter-chain（resume/redo/abort 结构化 IPC，design §3.5）──
  //
  // resume/redo/abort 走结构化 IPC（非 leader LLM 解释用户消息）——mirror 4.6 PatchReview accept/reject 模式。
  // leader 已决策「写这章」（初始 write_chapter），resume/redo/abort 是该决策的战术续跑，结构化可靠。
  // sessionId = chainSnapshot 所在 parent 会话（leader session / dogfood stub parent）。
  //
  // - continue：runChapterChain({resume}) → 跳已完成节点续跑。
  // - redo：runChapterChain({resume, redo:{nodeId:'draft-writer-agent', feedback}}) → draft-writer 重跑带 feedback。
  // - abort：runtime.clearChainSnapshot(sessionId) → 弃链段（返 aborted summary）。
  ipcMain.handle(
    'closure:resume-chapter-chain',
    async (_, input: ResumeChapterChainInput): Promise<RunChapterChainSummary> => {
      // CR-7 mirror：Zod 校验。失败按 spec 模式 A 返 {status:'error', errors:[...]}。
      const parsed = resumeChapterChainInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: 'error',
          errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        };
      }
      const { projectPath, sessionId, chapterId, action, feedback, revisionIntent, guardOverride, editedDraft } = parsed.data;

      // CR-13（09-13 CR 修复批）：whitespace-only editedDraft 拒收——schema min(1) 拦不住空白串（' \n\t'
      // 可过），而 F1a truthy 判会把它覆写为空白正文 / resume 腿 applyEditedDraft 的 trim 判会静默丢
      // 编辑（双口径）。IPC 入口统一 trim 判拒（结构化 error 回执——不静默丢编辑也不误写空白）；
      // schema refine（trim 非空）归 shared-contracts 簇（resumeChapterChainInputSchema）。
      if (editedDraft !== undefined && editedDraft.trim().length === 0) {
        return {
          status: 'error',
          errors: ['editedDraft 不能为空白——不改正文直接 accept（不带该字段）；想放弃本次修改请 abort 后重跑。'],
        };
      }

      // CR-10 mirror：路径守卫。
      try {
        assertSafePath(projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', errors: [`projectPath rejected: ${msg}`] };
      }

      const runtime = getAgentRuntime();

      // abort：清 chainSnapshot + 返 aborted 确认（不跑链段）。caller 据 status='aborted' 出文案。
      if (action === 'abort') {
        const cleared = runtime.clearChainSnapshot(sessionId);
        getLogger().info(
          { projectPath, sessionId, hadSnapshot: cleared },
          'closure:resume-chapter-chain: abort → chainSnapshot cleared',
        );
        // dogfood T1 CR-T1-052：abort 补发哨兵终态帧——本分支在 resume 车道 emitChainEvent 构造前
        // return，链车道零事件 → UI 链卡停在 paused 僵尸态（finalizeChainRun 见 paused 早退，永无
        // 终态可清）。仅在确有 paused 链被清时发（cleared=false 无链可中止，不误翻既有链态）；
        // 哨兵形态 mirror run 入口 catch 路径（c2ee0b8 / 批2 error 哨兵）。
        if (cleared) {
          makeChainEventSender(getWin, sessionId, projectPath)?.({
            type: 'chain-node-done',
            data: { nodeId: CHAIN_RUN_SENTINEL_NODE_ID, status: 'aborted' },
          });
        }
        return {
          status: 'aborted',
          errors: cleared ? [] : ['no paused chain to abort (chainSnapshot absent)'],
        };
      }

      // dogfood T1 Stage 3（D4）：continue/redo 是真 run——同项目单 run 闸（上方 abort 分支不闸：
      // 清 paused snapshot 非运行）。占用 → 结构化拒绝（机器可读前缀同 run 入口）。
      // CR-T1-021：resume 用**真实 sessionId** acquire（刻意非唯一链租约 id）——write_chapter
      // paused 时 leader streamMessage 仍持有项目（同 sessionId），重入语义 + 引用计数让 resume
      // 放行且互不误释放；释放经 handle（finally）只衰减自己那份。
      const resumeGate = acquireProjectRun(projectPath, sessionId);
      if (!resumeGate.ok) {
        getLogger().info(
          { projectPath, sessionId, heldBy: resumeGate.held.sessionId },
          'closure:resume-chapter-chain rejected: another run active in this project',
        );
        return {
          status: 'error',
          errors: [`project_run_active|heldBy=${resumeGate.held.sessionId}|project=${resumeGate.held.projectPath}`],
        };
      }
      try {
        // continue / redo：需 onAccept 闭包（续跑 accept 分支持久化）。episodeId 从 chainSnapshot 读
        // （chapter_brief_input.episodeId——链段初始注入，design §3.3「snapshot 是链段状态源」）。
        // CR-005：continue/redo 是续跑前置 pause 写过 snapshot——snapshot 缺/形态错 → 返明确 error（不调
        // runChapterChain({})——空 initialArtifacts 致 brief-compiler requiredArtifactKeys 缺 → status='blocked'，
        // 非 AC7 宣称的「从头跑」；resume 无 snapshot 应是「无可 resume」错非 from-head 尝试）。abort 无 snapshot
        // 既有处理（上文返 aborted+errors），保持。形态校验 mirror runChapterChain 内部 (:723-728)。
        const snap = runtime.getChainSnapshot(sessionId);
        if (
          !snap ||
          !Array.isArray(snap.completedNodes) ||
          !snap.artifacts ||
          typeof snap.artifacts !== 'object' ||
          Array.isArray(snap.artifacts)
        ) {
          getLogger().warn(
            { projectPath, sessionId, action },
            'closure:resume-chapter-chain: no paused chain to resume (chainSnapshot absent) → error',
          );
          return {
            status: 'error',
            errors: ['no paused chain to resume (chainSnapshot absent)'],
          };
        }
        const briefInput = snap?.artifacts?.['chapter_brief_input'] as
          | { episodeId?: string; brief?: ChapterBrief }
          | undefined;
        const episodeId = briefInput?.episodeId ?? '';
        // Story 4.3 Step 6：resume 续跑若 escalate，裁决器需原 chapterBrief 判「正文 vs 计划哪个更好」——从 snapshot 读。
        const chapterBrief = briefInput?.brief;

        // ── CR-6（09-13 CR 修复批）：legacy verdict 停点废弃拦截（mirror write-chapter isDiscardedLegacyPause
        // route-agent 分支——单源在 agent tool/write-chapter.ts，两处判据同步）──
        //
        // 旧链 verdict 停 = route-agent 停 + **非 escalate-pause + artifacts 带 chapter_accept**（旧
        // onAccept-先于-pause 产物；新终稿 pause 无候选——onAccept 移 E 段完成后，escalate-pause 的
        // 候选是裁决材料由 escalatePause 标记区分）。不拦则 action=continue 被下方 isFinalStagePause
        // 当终稿 accept 直接 F1a `persistMode:'direct'` 落盘——绕过 PatchReview 人审信封（AC7 迁移门
        // 此前只盖 leader 车道）。处置 mirror write-chapter 同款废弃：清快照 + 结构化 error 提示重跑。
        const isLegacyVerdictPause =
          snap.status === 'paused' &&
          snap.escalatePause !== true &&
          snap.currentNodeId === 'route-agent' &&
          Object.prototype.hasOwnProperty.call(snap.artifacts ?? {}, 'chapter_accept');
        if (isLegacyVerdictPause) {
          runtime.clearChainSnapshot(sessionId);
          getLogger().info(
            { projectPath, sessionId, action, currentNodeId: snap.currentNodeId },
            'closure:resume-chapter-chain: legacy verdict pause → snapshot discarded + rerun prompt（旧停点废弃拦截）',
          );
          // 链卡僵尸态防线（mirror abort 分支哨兵）：paused 链被清 → 补 aborted 终态帧。
          makeChainEventSender(getWin, sessionId, projectPath)?.({
            type: 'chain-node-done',
            data: { nodeId: CHAIN_RUN_SENTINEL_NODE_ID, status: 'aborted' },
          });
          return {
            status: 'error',
            errors: ['该暂停链停在旧 verdict 停点（链流程重排后已退役）——快照已废弃，请重新发起写章（write_chapter / run-chapter-chain）生成新链。'],
          };
        }

        // loadProject（onAccept 闭包需 episode_outlines + novel.chapters 做 chapterId 映射；directChapterId 优先）。
        let doc: Record<string, unknown> | null = null;
        try {
          const { loadProject } = await import('@orison/desktop-local-bff');
          doc = loadProject(projectPath) as Record<string, unknown> | null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          getLogger().error({ err: msg, projectPath }, 'closure:resume-chapter-chain: loadProject threw');
          return { status: 'error', errors: [`loadProject failed: ${msg}`] };
        }
        if (!doc) {
          return {
            status: 'error',
            errors: [`project.yaml at ${projectPath} could not be loaded (corrupt or missing)`],
          };
        }

        const episodeOutlines = (doc as { episode_outlines?: ResolvableEpisode[] }).episode_outlines;
        const novelChapters = (doc as { novel?: { chapters?: ResolvableChapter[] } }).novel?.chapters;
        // CR-4.1-08 + #107 R1.1c mirror run 入口：skipReason / no-chapter runId 闭包捕获。
        let acceptSkipReason: ChapterAcceptSkipReason | undefined;
        let acceptSkipRunId: string | undefined;
        const onAccept = (
          snapshot: { runId: string; artifacts: Record<string, unknown> },
          ctx: { nowISO: string },
        ): ChapterAcceptResult => {
          const result = buildChapterAccept(snapshot, {
            nowISO: ctx.nowISO,
            episodeId,
            ...(episodeOutlines ? { episodeOutlines } : {}),
            ...(novelChapters ? { novelChapters } : {}),
            ...(chapterId ? { directChapterId: chapterId } : {}),
          });
          if ('skipReason' in result) {
            acceptSkipReason = result.skipReason;
            if (result.skipReason === 'no-chapter') acceptSkipRunId = snapshot.runId;
          }
          return result;
        };

        // mode 从 sessionId 会话 permissionMode 推（中途切模式反映到续跑 checkpoint 密度）。session 不在内存
        // （异常 / stub 已逐出）→ 兜底 'suggest'。redo：nodeId 固定 draft-writer-agent（最常见用例，design §3.4
        // 最小实现；feedback optional）。
        const session = runtime.getSession(sessionId, projectPath);
        const mode = deriveCheckpointPolicy(session?.permissionMode ?? 'suggest');

        // ── 链流程重排 W2（R3 终稿 checkpoint / R4c 落盘拆两步）：终稿 accept 的 F1a 立即落正文 ──
        //
        // action='accept'（终稿卡专属动作；final-stage continue 兼容旧 caller）= 作者已批正文：
        // 1. **F1a 立即落正文**（人审成果即时持久，H3——E 段失败不再滞留）：editedDraft 先经
        //    applyEditedDraft 单源覆写（text + wordCount 机械重算 + 申报类 stale 清理）→ onAccept 组
        //    chapter_accept 候选 → acceptChapterCandidate 直落（人工已批 = direct 语义，非 envelope）。
        //    仅落已注册章（novel.chapters 命中）——未注册章（首章冷启动）无 frontmatter 载体，F1a 跳过
        //    （#107 自动建章路径在 post-persist 兜底）。失败 graceful：跳过 F1a 走 post-persist。
        // 2. resume 续跑腿携 editedDraft（runChapterChain resume 读回再覆写一次——同一 helper 单源），
        //    E 段对改后正文提取；E 失败 → 正文已落（F1a）+ derivationStale 章标 + 重提取指路（AC2c）。
        // 3. F1a 已落 → post-persist 跳过（防 acceptChapterCandidate 双写 + StoryDecision 双登记），
        //    chapterPersisted=true 告知 UI。
        const isFinalStagePause =
          snap.escalatePause !== true && snap.currentNodeId === 'route-agent';
        const isFinalAccept = action === 'accept' || (action === 'continue' && isFinalStagePause);
        let finalAcceptLanded = false;
        if (isFinalAccept) {
          const acceptSnap = editedDraft
            ? { runId: snap.runId, artifacts: applyEditedDraft(snap.artifacts, editedDraft) }
            : { runId: snap.runId, artifacts: snap.artifacts };
          const acceptResult = onAccept(acceptSnap, { nowISO: new Date().toISOString() });
          if (
            'chapterId' in acceptResult &&
            (novelChapters ?? []).some((ch) => ch?.id === acceptResult.chapterId)
          ) {
            try {
              const { acceptChapterCandidate } = await import('@orison/desktop-local-bff');
              // CR-4.1-03 同款：acceptChapterCandidate 经 withProjectLock 串行。**return promise**
              //（async 落盘异常经 withProjectLock 的 await 传到本 try/catch——块体语句形态会弃
              // promise 致 rejection 漂浮 unhandled，F1a graceful catch 永不触发）。
              await withProjectLock(projectPath, () =>
                acceptChapterCandidate(
                  projectPath,
                  acceptResult.chapterId,
                  acceptResult.runId,
                  acceptResult.candidate,
                  acceptResult.storyDecisions,
                ),
              );
              finalAcceptLanded = true;
              getLogger().info(
                { projectPath, sessionId, chapterId: acceptResult.chapterId, hasEditedDraft: editedDraft !== undefined },
                'closure:resume-chapter-chain: final accept F1a 立即落正文（人审成果先于 E 段持久）',
              );
            } catch (f1aErr) {
              // graceful：F1a 失败（章注册竞态 / 落盘异常）→ 跳过，post-persist 兜底（review 语义降级可接受）。
              const msg = f1aErr instanceof Error ? f1aErr.message : String(f1aErr);
              getLogger().warn(
                { err: msg, projectPath, sessionId },
                'closure:resume-chapter-chain: final accept F1a landing failed → fall through to post-persist',
              );
            }
          }
        }

        // Story 7.1 Route 1：redo 携 revisionIntent（B trigger 选区精修，revision_intent artifact 注入）。
        // feedback（C trigger 整章自由文本）/ revisionIntent（B trigger 结构化意图）可共存，各走各 artifact。
        // 两者均从 parsed.data 解构（:673），此处组装 redoOpts。
        //
        // Story 7.2 art-mode：guardOverride（force-accept）时 redo.nodeId = 'revision-guard-agent'（只重跑
        // guard，不动 draft-writer——passageText 已在 snapshot）。soft-violation pause 时 revision-guard 已在
        // completedNodes（chainRunner 节点 run 完 → 加 completedNodes → 才 checkpoint pause），故 force-accept
        // 必须 redo 移除 revision-guard 让其重跑（continue 会跳过 guard → splice 不发生）。guardOverride 注入
        // revision_guard_override artifact → guard 重跑时 force-accept splice。
        // CR-2c（09-13 CR 修复批）：redo 目标按 pauseKind 分派——规划环停点（brief-reviewer-node：
        // plan escalate-pause 或 brief stage pause）的 redo 回 A1 重编任务卡（brief-compiler-node——
        // plan_review hard findings 经 collectRecompileHints 机械投影为重编意图）；其余（终稿/裁决
        // audit pause 等）维持 draft-writer-agent。redoFrom 落点 = **resume 载荷**（簇 1 workflow
        // 消费：redo 边界节点移除 + redo 清理集；与 options.redo 可共存——nodeId 同 target 双保险 +
        // feedback 注入走 redo）。guardOverride 微重跑（只重跑 revision-guard）不携 redoFrom——非环回环。
        const isPlanLoopPause = snap.currentNodeId === 'brief-reviewer-node';
        const redoNodeId = guardOverride ? 'revision-guard-agent' : (isPlanLoopPause ? 'brief-compiler-node' : 'draft-writer-agent');
        const resumeRedoFrom = action === 'redo' && !guardOverride ? redoNodeId : undefined;
        const redoOpts = action === 'redo'
          ? {
              redo: {
                nodeId: redoNodeId,
                ...(feedback ? { feedback } : {}),
                ...(revisionIntent ? { revisionIntent } : {}),
                ...(guardOverride ? { guardOverride } : {}),
              },
            }
          : {};

        // dogfood T1 Stage 6：resume/redo 重跑同样流链事件（sessionId = 原 parent 会话——seq 计数
        // 跨 run 递增，redo 重跑的 delta 不与旧流混淆）。声明在 try 外——catch 也要发 error 哨兵
        //（硬 throw 路径链卡/run 态不得永久挂 running）。
        const emitChainEvent = makeChainEventSender(getWin, sessionId, projectPath);
        try {
          // Story 2.2 WP-E（CR-08-16-201）：显式 ipc 类型——runtime 返 agent RunSnapshotSummary（结构
          // 兼容），下方 applyStorySyncOnResume 要挂 storySyncReview/storySyncLanded（ipc type 字段）。
          let summary: RunChapterChainSummary = await runtime.runChapterChain(sessionId, {}, {
            requirement: episodeId,
            // W2：final accept 携 editedDraft（resume 读回 applyEditedDraft 覆写 → E 段对改后正文提取）。
            // CR-2c：resumeRedoFrom（redo 按 pauseKind 分派的目标——plan pause 回 A1 / audit pause 回
            // draft-writer；簇 1 workflow 消费 redo 边界移除）。
            resume: {
              fromSnapshot: true,
              ...(editedDraft !== undefined ? { editedDraft } : {}),
              ...(resumeRedoFrom !== undefined ? { redoFrom: resumeRedoFrom } : {}),
            },
            onAccept,
            mode,
            ...redoOpts,
            ...(emitChainEvent ? { emitChainEvent } : {}),
          });

          // Story 4.3 Step 6（design §3.8）：escalate mode-gating（两入口一致，mirror write_chapter agent +
          // run-chapter-chain）。resume 续跑后若 route=escalate_user，按 mode.escalateMode 分派。
          // auto-trust accept → 复用 4.6 accept 路径真落盘；revise → redo 重跑；parse 失败 → degrade（不假 pass）。
          let autoTrustAccept = false;
          if (summary.routeDecision?.decision === 'escalate_user') {
            const result = await handleEscalateAutoTrust(
              runtime,
              sessionId,
              summary,
              mode,
              episodeId,
              chapterBrief,
              onAccept,
              'closure:resume-chapter-chain',
              emitChainEvent,
            );
            summary = result.summary;
            autoTrustAccept = result.autoTrustAction === 'accept';
          }

          // dogfood R2 #93（P0-2，2026-08-28）：resume 终态 chapter_accept 落盘语义按会话档位分派——
          // auto 档（dogfood stub 会话 / auto-trust 采信）→ 'direct' 直落（既有行为）；suggest/readonly
          // （leader 会话）→ 'review' 不直落，envelope 留 summary 返 UI 进 pendingPatch 人审（mirror
          // write_chapter metadata field_patch 路径）。修复：resume 车道跑在 leader 工具调用生命周期外，
          // envelope 此前无事件通道通往审核面（accept_as_truth + persisted:false 宿命，章节永不落盘）。
          // autoTrustAccept 蕴含 auto-trust 档（escalateMode 只在 auto 档产生）→ 归 direct。
          // check 补：dogfood stub 会话（run 入口建的 chapter-chain-dogfood parent）恒 direct——stub 车道
          // 无 leader 也无审核面板消费面（链卡 resume 钮 CR-T1-048 只处理 error/busy，不消费 envelope），
          // review 档返 envelope 无人接 = #93 症状①换道复发（章节永不落盘）。默认 autonomy=auto 已 direct；
          // 此补覆盖手输 autonomy='suggest'/'readonly' 建的 stub（链卡 resume 走得到）。
          const isStubChainSession = session?.agentName === 'chapter-chain-dogfood';
          const persistMode: 'direct' | 'review' =
            session?.permissionMode === 'auto' || autoTrustAccept || isStubChainSession || isFinalAccept ? 'direct' : 'review';
          // #107 R1.1：autoCreate 上下文 mirror run 入口（doc 数据 + episodeId/chapterId + 闭包 runId）。
          // persistMode 兼作模式门（direct 建全文 / review 建骨架——同档位语义一源两用）。
          // W2：F1a 已落（finalAcceptLanded）→ post-persist 跳过（防 acceptChapterCandidate 双写 +
          // StoryDecision 双登记），chapterPersisted=true 告知 UI；F1a 未落（失败/未注册章）照常走。
          if (finalAcceptLanded) {
            summary.chapterPersisted = true;
          } else {
            await persistChapterAcceptIfNeeded(projectPath, summary, acceptSkipReason, 'closure:resume-chapter-chain', autoTrustAccept, persistMode, {
              episodeId,
              ...(episodeOutlines ? { episodeOutlines } : {}),
              ...(novelChapters ? { novelChapters } : {}),
              ...(chapterId ? { directChapterId: chapterId } : {}),
              ...(acceptSkipRunId !== undefined ? { runId: acceptSkipRunId } : {}),
            });
          }

          // Story 2.2 WP-E（CR-08-16-201）：resume 终态 story-sync 反哺消费（详 applyStorySyncOnResume
          // 块注释——缺省档链段必 pause，终态提取只经此回到落盘点）。mutates summary（storySyncReview /
          // storySyncLanded 供 UI 路由），失败 graceful 不 fail resume。
          await applyStorySyncOnResume({
            summary,
            projectPath,
            sessionId,
            permissionMode: session?.permissionMode ?? 'suggest',
            chapterId,
            autoTrustAccepted: autoTrustAccept,
          });

          getLogger().info(
            {
              projectPath,
              sessionId,
              action,
              status: summary.status,
              routeDecision: summary.routeDecision?.decision,
              // #93 P0-2：落盘诊断三元组——envelope 在不在（chapter_accept）、落没落（chapterPersisted）、
              // 为何没落（acceptSkipReason——no-draft/no-chapter/no-nowiso，此前日志不暴露致 persisted:false 无从归因）。
              envelope: !!summary.chapter_accept,
              persisted: summary.chapterPersisted === true,
              acceptSkipReason: acceptSkipReason ?? null,
              sessionMode: session?.permissionMode ?? 'suggest(fallback)',
              autoTrustAccept,
            },
            'closure:resume-chapter-chain: action completed',
          );

          // dogfood R2 #93 追加拍板（2026-08-28）：链完成事件回注 leader——续链跑在 leader 工具调用
          // 生命周期外（write_chapter 暂停时工具早已返回、leader runLoop 已终结），leader 无从知晓
          // 完成事实。completed 终态时把结构化事实回注 leader 会话并触发一轮汇报（leader 用自己的
          // 话向作者总结本章；守卫矩阵详 agent 侧 notifyLeaderChainCompleted）。fire-and-forget：
          // 失败只记日志，绝不影响既有完成路径（resume summary 照常返 UI——toast/审核卡通道与本
          // 回注双通道并存）。stub 会话（run 入口建的 chapter-chain-dogfood parent）无 leader 对话
          // 消费面——跳过。runId 取 chapter_accept / storySync 的稳定 run 标识（都缺则本次唯一——
          // 幂等守卫降级为仅防同 summary 双发，resume 流程本无同 run 二次完成路径）。
          if (summary.status === 'completed' && session && session.agentName !== 'chapter-chain-dogfood') {
            const notifyLeader = (
              runtime as {
                notifyLeaderChainCompleted?: (sessionId: string, payload: ChainCompletedEventPayload) => Promise<boolean>;
              }
            ).notifyLeaderChainCompleted;
            if (typeof notifyLeader === 'function') {
              const resolvedChapterId = chapterId ?? summary.chapter_accept?.chapterId;
              const notifyPayload: ChainCompletedEventPayload = {
                runId: summary.chapter_accept?.runId ?? summary.storySync?.runId ?? randomUUID(),
                ...(summary.draftTitle !== undefined ? { chapterTitle: summary.draftTitle } : {}),
                ...(resolvedChapterId !== undefined ? { chapterId: resolvedChapterId } : {}),
                ...(summary.draftWordCount !== undefined ? { wordCount: summary.draftWordCount } : {}),
                ...(summary.routeDecision
                  ? { routeDecision: summary.routeDecision.decision, routeReason: summary.routeDecision.reason }
                  : {}),
                ...(summary.reviewVerdict !== undefined ? { reviewVerdict: summary.reviewVerdict } : {}),
                ...(summary.chapterPersisted === true ? { chapterPersisted: true } : {}),
                ...(summary.chapter_accept && summary.chapterPersisted !== true ? { acceptPendingReview: true } : {}),
                ...(acceptSkipReason !== undefined ? { acceptSkipReason } : {}),
                ...(summary.storySync?.patches ? { storySyncPatchCount: summary.storySync.patches.length } : {}),
                ...(summary.storySyncLanded ? { storySyncLandedFields: summary.storySyncLanded.fields } : {}),
                // W2 完成事实扩展：提取统计（弧节拍数）+ E 段失败章标（leader 汇报如实转达重提取指路）。
                ...((summary.arcEmergenceBeats ?? []).length > 0 ? { arcBeatCount: summary.arcEmergenceBeats!.length } : {}),
                ...(summary.derivationStale === true ? { derivationStale: true } : {}),
                // CR-14：环未收敛接线——渲染分支+单测在位（renderChainCompletedEventMessage /
                // leader-chain-completed-notify.test）但 payload 从未携带（只加了 arcBeatCount /
                // derivationStale）。机械信号 = completed 终态 errors 含**自审环** cap 耗尽标记
                // （escalate-pause 时已入 errors，人/裁决采信 resume 到 completed 携带至今——按
                // 保守采信语义标「环未收敛」上报）。终弃（chapterAbandoned）无 payload 字段：终弃
                // 是 write_chapter 入口层处置（清快照 + 非 completed 终态），leader 侧经工具结果行
                // 同步上报，完成事件车道结构性不可达——payload 契约不设该字段（删不留标记）。
                ...(
                  summary.status === 'completed' &&
                  (summary.errors ?? []).some(isAuditLoopCapErrorIpc)
                    ? { loopUnconverged: true as const }
                    : {}
                ),
                ...(summary.errors.length > 0 ? { errors: summary.errors } : {}),
              };
              // API 契约不抛；Promise.resolve 包一层防形态漂移（旧 runtime/mock 返非 Promise 时
              // 同步 TypeError 会误伤完成路径），.catch 防 unhandled rejection——handler 不等报告轮；
              // 失败只 warn（resume 已完成——toast/审核卡通道不受影响，报告轮丢失可归因）。
              void Promise.resolve(notifyLeader.call(runtime, sessionId, notifyPayload)).catch((notifyErr) => {
                getLogger().warn(
                  {
                    err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
                    sessionId,
                    runId: notifyPayload.runId,
                  },
                  'closure:resume-chapter-chain: leader chain-completed notify failed (resume already completed — toast/review channel unaffected)',
                );
              });
            } else {
              getLogger().info(
                { sessionId },
                'closure:resume-chapter-chain: notifyLeaderChainCompleted unavailable (old runtime) → skip leader report',
              );
            }
          }
          return summary;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          getLogger().error({ err: msg, projectPath, sessionId, action }, 'closure:resume-chapter-chain: failed');
          // dogfood T1 check：硬 throw 路径补发 error 哨兵（同 run 入口——resume 车道无
          // done 事件兜底，run 态/链卡不得永久挂 running）。
          emitChainEvent?.({ type: 'chain-node-done', data: { nodeId: CHAIN_RUN_SENTINEL_NODE_ID, status: 'error' } });
          return { status: 'error', errors: [`chapter chain resume failed: ${msg}`] };
        }

      } finally {
        resumeGate.release();
      }
    },
  );

  // Story 7.1 Route 1：B trigger 选区指挥精修——编译改稿意图（design §1[2] / §4.2）。
  // UI 在 draft checkpoint pause 后用户选段 + 粗指令 → 本 IPC 派 revision-optimizer → 返 RevisionIntent
  // （用户确认关用）OR null（编译失败 graceful）。确认后 UI 调 resumeChapterChain(action=redo, revisionIntent)。
  ipcMain.handle(
    'closure:compile-revision-intent',
    async (_, input: CompileRevisionIntentInput): Promise<CompileRevisionIntentResult> => {
      const parsed = compileRevisionIntentInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          intent: null,
          error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        };
      }
      const { projectPath } = parsed.data;
      try {
        assertSafePath(projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { intent: null, error: `projectPath rejected: ${msg}` };
      }
      const runtime = getAgentRuntime();
      const outcome = await dispatchRevisionOptimizerForIpc(runtime, parsed.data);
      // dogfood R2 #90：error 文本按实际失败因分三类（此前「optimizer 不可用 / dispatch 失败 / parse 失败」
      // 三因混一句，用户实碰后无法自诊）。UI 侧 intentCompileError 直显本字符串（i18n 模板透传，零 UI 改动）。
      if (outcome.status === 'optimizer-unavailable') {
        return { intent: null, error: '意图编译失败：revision-optimizer 不可用（运行时未接线或版本过旧），请重启应用或手改' };
      }
      if (outcome.status === 'dispatch-failed') {
        // err.message 摘要（截 300 字防超长堆栈文本糊死提示行；全文已在 dispatch warn 日志）。
        const brief = outcome.message.length > 300 ? `${outcome.message.slice(0, 300)}…` : outcome.message;
        return { intent: null, error: `意图编译失败：优化器派发失败（${brief}），请重试或手改` };
      }
      if (outcome.status === 'parse-failed') {
        return {
          intent: null,
          error: `意图编译失败：优化器输出不符合 RevisionIntent 结构（原文 ${outcome.contentLength} 字已截断记入主进程日志，可查日志归因），请重述或手改`,
        };
      }
      return { intent: outcome.intent };
    },
  );

  // ── 链流程重排 W4（R6 / design §5）：closure:re-extract-chapter（链外重提取）──
  //
  // 落盘后手改正文的衍生状态修复通道（覆盖：accept 落盘→编辑器改 md 全档位 / auto 档直落盘后手改 /
  // E 段失败 derivationStale 章标）。流程：盘上读该章正文（剥 frontmatter）→ runtime.reExtractChapter
  // standalone 跑 E 段（E1-E9，world×5→merge→emotion→promise→arc→summary→storytime→mention→story-sync）
  // → 幂等写（W0-2：slice.id 替换 / 自然键 upsert / per-episode 全量替换）。
  //
  // - **story-sync 反哺档位分流**（plan-review L5）：重提取再产 patches 走 autonomy 档位——auto 直落 /
  //   suggest+readonly envelope PatchReview 人审（stageStorySyncFeedback 单源，与 resume 终态消费零漂移）。
  //   重提取无自然 leader 会话可读 permissionMode → autonomy 入参缺省 'suggest'（保守——补丁默认人审）。
  // - D4 同项目单 run 闸（唯一租约 id，CR-T1-020 同款）——重提取与链 run/resume 互斥（衍生状态写并发
  //   会交错覆盖）。
  // - 失败 graceful：章不存在/正文空/映射失败 → runtime 返 {ok:false, reason}（明确报错非静默）；
  //   handler 外围 catch → reason 透传。
  // - stub parent session（mirror run 入口）——reExtractChapter 经会话解析 projectPath；session 不入
  //   leader 对话消费面（不回注 notifyLeaderChainCompleted——重提取是维护动作非章完成事件）。
  ipcMain.handle(
    'closure:re-extract-chapter',
    async (_, input): Promise<ReExtractChapterResult> => {
      const parsed = reExtractChapterInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        };
      }
      const { projectPath, chapterId, autonomy } = parsed.data;

      // CR-10 mirror：路径守卫。
      try {
        assertSafePath(projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `projectPath rejected: ${msg}`, chapterId };
      }

      // D4 同项目单 run 闸（唯一租约 id——与 run 入口同款，防并发衍生状态写交错）。
      const reExtractLeaseId = `${CHAIN_RUN_LEASE_ID}:${randomUUID()}`;
      const runGate = acquireProjectRun(projectPath, reExtractLeaseId);
      if (!runGate.ok) {
        getLogger().info(
          { projectPath, chapterId, heldBy: runGate.held.sessionId },
          'closure:re-extract-chapter rejected: another run active in this project',
        );
        return {
          ok: false,
          reason: `project_run_active|heldBy=${runGate.held.sessionId}|project=${runGate.held.projectPath}`,
          chapterId,
        };
      }
      try {
        const runtime = getAgentRuntime();
        // CR-19①（09-13 CR 修复批）：IPC 建 AbortController → abort signal 透传（workflow
        // reExtractChapter 签名已收 options.abort——signal 穿透 runChain 的 7+ LLM 调用与 world 写，
        // 持租约期间可取消；abort 后 reExtractChapter 返 {ok:false, reason:'已中断（abort）'}）。
        // controller 生命周期 = 本 invoke（finally 随租约一起释放）；注册进 streamAbortControllers
        // 后用户 agent:abort-run 即为取消触发面（stub 会话 id 既是 abort-run 入参也是注册键）。
        const abortController = new AbortController();
        // stub parent（mirror run 入口 chapter-chain-dogfood 形态；mode 只为 createSession 签名完整，
        // story-sync 分流用 autonomy 显式传 stageStorySyncFeedback）。
        const parent = runtime.createSession({
          agentName: 'chapter-reextract',
          projectPath,
          mode: autonomy,
        });
        // CR-19①取消触发面：controller 注册进 agent:abort-run 的 streamAbortControllers——用户对该
        // 会话 abort 即取消重提取（agentIpc 导出注册/注销，与 LLM 流 controller 同一取消面）。
        registerStreamAbortController(parent.id, abortController);
        try {
          const result = await runtime.reExtractChapter(parent.id, { chapterId, abort: abortController.signal });

          // story-sync 档位分流（L5）：重提取再产 patches → autonomy 路由挂载（auto landed / 其余 review）。
          if (result.ok && result.storySync && result.storySync.patches.length > 0) {
            const staged = await stageStorySyncFeedback({
              patches: result.storySync.patches,
              runId: result.storySync.runId,
              chapterId: result.chapterId ?? chapterId,
              projectPath,
              sessionId: parent.id,
              permissionMode: autonomy,
            });
            if (staged?.kind === 'landed') result.storySyncLanded = staged.landed;
            if (staged?.kind === 'review') result.storySyncReview = staged.review;
          }

          getLogger().info(
            { projectPath, chapterId, autonomy, ok: result.ok, reason: result.reason ?? null, stats: result.stats ?? null },
            'closure:re-extract-chapter: completed',
          );
          return result;
        } finally {
          // CR-19①注销 + ②stub 会话 finally 删除——每次 invoke 新建（agentName 'chapter-reextract'），
          // 不删则 session 注册表无界增长。stub 无对话消费面（不回注 leader），删无副作用；
          // 防御式调用（旧 runtime/mock 缺方法不炸——mirror notifyLeaderChainCompleted typeof 先例）。
          unregisterStreamAbortController(parent.id, abortController);
          try {
            if (typeof runtime.deleteSession === 'function') runtime.deleteSession(parent.id);
          } catch (delErr) {
            getLogger().warn(
              { err: delErr instanceof Error ? delErr.message : String(delErr), sessionId: parent.id },
              'closure:re-extract-chapter: stub session cleanup failed（best-effort，不影响结果返回）',
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        getLogger().error({ err: msg, projectPath, chapterId }, 'closure:re-extract-chapter failed');
        return { ok: false, reason: `chapter re-extract failed: ${msg}`, chapterId };
      } finally {
        runGate.release();
      }
    },
  );

  // ── 链流程重排 W4（R6）：closure:chapter-derivation-status（章卡 stale 查询面——UI 归子3）──
  //
  // 轻量查询：注册章的衍生状态新鲜度（供子3 章卡「重提取」按钮态）。两个持久信号合成（derivationStale
  // summary 章标是瞬态——查询面须可判数据源）：
  // - `synopsisStale`：closure_chapter_summary.summary.degradedNote 含 MENTION_SYNOPSIS_STALE_NOTE
  //   （degradeMentionLedgerForChapterFile 在**每次**章正文写盘点 fire——手改/落盘后均标，8.7 CR-001 机制）。
  // - `!summaryPresent`：E6 章摘要从未物化（链前旧章 / E 段失败中断）。
  // project 未注册 db（无 projectId）→ summaries 空 → 全章 summaryPresent=false（如实：从未提取）。
  ipcMain.handle(
    'closure:chapter-derivation-status',
    async (_, input): Promise<ChapterDerivationStatusResult> => {
      const parsed = chapterDerivationStatusInputSchema.safeParse(input);
      if (!parsed.success) {
        return { chapters: [] };
      }
      const { projectPath, chapterId } = parsed.data;
      try {
        assertSafePath(projectPath);
      } catch {
        return { chapters: [] };
      }
      try {
        const { loadProject } = await import('@orison/desktop-local-bff');
        const doc = loadProject(projectPath) as Record<string, unknown> | null;
        if (doc === null) return { chapters: [] };

        // episodes/chapters defensive 抽取（mirror mentionLedgerDegrade 抽取形态）。
        const rawEpisodes = doc.episode_outlines;
        const rawChapters = (doc.novel as { chapters?: unknown } | undefined)?.chapters;
        if (!Array.isArray(rawChapters)) return { chapters: [] };
        const episodes = Array.isArray(rawEpisodes)
          ? rawEpisodes
              .map((ep) => ep as { id?: unknown; index?: unknown })
              .filter((ep): ep is { id: string; index: number } => typeof ep.id === 'string' && typeof ep.index === 'number')
          : [];
        const chapters = rawChapters
          .map((ch) => ch as { id?: unknown })
          .filter((ch): ch is { id: string } => typeof ch.id === 'string');

        // db 章摘要行（projectId 未注册 → 空 = 全章未提取，如实）。
        const projectId = getProject(path.resolve(projectPath))?.projectId;
        const summaries = projectId ? listChapterSummaries(projectId) : [];
        const summaryByEpisode = new Map(summaries.map((row) => [row.episodeId, row]));

        const entries = chapters
          .filter((ch) => chapterId === undefined || ch.id === chapterId)
          .map((ch) => {
            const episodeId = resolveEpisodeIdForChapter(episodes, chapters, ch.id);
            const row = episodeId !== undefined ? summaryByEpisode.get(episodeId) : undefined;
            const synopsisStale =
              typeof row?.summary.degradedNote === 'string' &&
              row.summary.degradedNote.includes(MENTION_SYNOPSIS_STALE_NOTE);
            const summaryPresent = row !== undefined;
            return {
              chapterId: ch.id,
              ...(episodeId !== undefined ? { episodeId } : {}),
              summaryPresent,
              synopsisStale,
              stale: synopsisStale || !summaryPresent,
            };
          });
        return { chapters: entries };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        getLogger().warn({ err: msg, projectPath }, 'closure:chapter-derivation-status failed → empty (best-effort query)');
        return { chapters: [] };
      }
    },
  );
}
