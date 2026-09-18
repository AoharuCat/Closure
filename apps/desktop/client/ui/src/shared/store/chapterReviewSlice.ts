import type { StateCreator } from 'zustand';
import type {
  ChapterReviewMetadata,
  ProjectFieldPatch,
  RevisionIntent,
  RunChapterChainSummary,
} from '@orison/shared-contracts';
import { compileRevisionIntent, resumeChapterChain } from '../api/agent';
import type { SelectionInfo } from '../../features/editor/TiptapEditor';
import { registerProjectReset } from './resetRegistry';
import { useToastStore } from './toastStore';
import { getSessionProject } from './agentEvents';
import { parseChainBusyError, showChainRunBusyToast, showRunBusyToast } from './projectRunBusy';
import { translate } from '../i18n/useI18n';
// 09-13 子3 W2（design §2.2/F5）：escalate findings resume fallback 的条目级防御投影
//（chainTimeline 模块——escalate-pause 不产 pausedReview，裁决卡数据源走独立键）。
import { projectEscalateFindingItems } from './chainTimeline';

// ── Types ──

/**
 * Story 4.3 Step 4（design §3.6 / §5）：draft checkpoint prose-review state.
 *
 * 当写章链段（write_chapter / closure:run-chapter-chain）在 checkpoint pause（半自动/微操模式），
 * leader write_chapter tool 产 `chapter_review` metadata 挂 tool result（mirror 4.6 chapter_accept→
 * field_patch metadata 模式）。agentSessionSlice 的 tool-result 路由据 `meta.type==='chapter_review'`
 * 派发到本 slice 的 `setPausedReview`（落 pausedReview），写作页 ChapterReviewPanel 渲染
 * 正文 + 三动作（continue/redo/abort）。
 *
 * 三动作走结构化 IPC `closure:resume-chapter-chain`（mirror 4.6 PatchReview accept/reject——UI 直接
 * 调结构化入口，非经 leader LLM 解释，design §3.5 D7）。IPC 返 RunChapterChainSummary：
 * - status='paused' → 链段在下一 checkpoint 又停，更新 pausedReview 渲染新载荷。
 * - status='completed'|'aborted'|'error'（或其他）→ 链段终结，清 pausedReview（panel 卸载）。
 *
 * Story 7.1 B1（design §4.2）：draft stage 选区指挥精修扩展。
 * - `reviewSelection`：TipTap onSelectionChange 产的当前选区（draft prose 内）。
 * - `compiledIntent` / `intentCompiling` / `intentCompileError`：revision-optimizer 子 agent 编译状态。
 * - `compileIntent` 调 `closure:compile-revision-intent` IPC 派优化 Agent。
 * - `confirmRedoWithIntent` 调 resume-chapter-chain redo + revisionIntent（段落级改稿执行）。
 *
 * 09-13 子3 W4（design §5.3/F2）：五单槽本地态 BySession 键控 + 七动作尾参 `sessionId?`（缺省 =
 * Deps.agentSessionId 兼容——既有视图会话调用点零改动）。写作页审批迁移后同屏可审多会话
 * （后台会话直审不切走），单槽会让 A 会话的 resuming/intent 顶掉 B 会话；done-probe（agentEvents）
 * 同批改读键控面。
 *
 * 范式判据（ADR-3）：mode 选择 = 用户偏好（UX/控制）；pause/resume 机制 = 纯代码（确定性 IPC 分派）；
 * 意图编译归 LLM（revision-optimizer），UI/slice 只做机械控制信号派发。
 * 本 slice 不做语义判断——只路由 metadata + 派发机械控制信号。
 */
export type ChapterReviewSlice = {
  /**
   * dogfood T1 Stage 3（r8 设计要点 5「第 5 个隐形单槽」）：pausedReview per-session 键控。
   * chainSnapshot 按 parentSessionId 键（shell 侧），UI 侧对称键控——多会话并发时各自
   * pause 互不顶。写入点（agentEvents dispatcher 的 chapter_review 路由 / runResume）都握
   * sessionId；ChapterReviewPanel 只渲染传入会话（缺省视图会话）的键。
   */
  pausedReviewBySession: Record<string, ChapterReviewMetadata | undefined>;
  /** W4 键控：resume IPC flight 标记（per-session；键缺席 = false）。 */
  reviewResumingBySession: Record<string, boolean>;
  /** W4 键控：draft prose 内的当前选区（键缺席 = 无选区）。 */
  reviewSelectionBySession: Record<string, SelectionInfo | undefined>;
  /** W4 键控：编译出的 RevisionIntent（键缺席 = 未编译 / 已清除 / 编译失败）。 */
  compiledIntentBySession: Record<string, RevisionIntent | undefined>;
  /** W4 键控：编译中 loading（键缺席 = false）。 */
  intentCompilingBySession: Record<string, boolean>;
  /** W4 键控：编译失败原因（键缺席 = 无错误）。 */
  intentCompileErrorBySession: Record<string, string | undefined>;
  setPausedReview: (sessionId: string, meta: ChapterReviewMetadata | null) => void;
  /** 清某会话的 pausedReview 键（deleteAgentSession / cancelAgent 用）。 */
  clearPausedReviewFor: (sessionId: string) => void;
  /** W4 键控：更新选区（TipTap onSelectionChange 回调；null = 清该会话选区）。 */
  setReviewSelection: (sessionId: string, selection: SelectionInfo | null) => void;
  /** W4 键控：清某会话的五本地态键（deleteAgentSession 清理链，mirror clearPausedReviewFor）。 */
  clearReviewLocalStateFor: (sessionId: string) => void;
  reviewContinue: (sessionId?: string) => Promise<void>;
  reviewRedo: (feedback?: string, sessionId?: string) => Promise<void>;
  reviewAbort: (sessionId?: string) => Promise<void>;
  /**
   * Story 7.1 B1：调 revision-optimizer 子 agent 编译 RevisionIntent。
   *
   * selectedPassage = 用户选中的正文段（render revision-optimizer yaml {{selectedPassage}}）；
   * userInstruction = 用户粗指令原文（render {{userInstruction}}，也作 rawUserInstruction ground truth）；
   * chapterContext = optional 本章 brief JSON 串（帮 optimizer 判锁定项背景）。
   *
   * 🔑 BMad CR F2：selectionFrom/selectionTo + draftText 透传给 IPC——IPC 层纯代码构造 scope.anchor
   * （buildSelectionAnchor 切 prefix/suffix + rangeHint），LLM 不产 anchor。
   *
   * 返 {intent} 非空 → 落 compiledIntent（确认关用）；返 null 或 throw → 落 intentCompileError（graceful，
   * 不假信心不静默 fail，mirror revision-optimizer dispatch 的 graceful 哲学）。
   */
  compileIntent: (
    selectedPassage: string,
    userInstruction: string,
    selectionFrom: number,
    selectionTo: number,
    draftText: string,
    chapterContext?: string,
    sessionId?: string,
  ) => Promise<void>;
  /**
   * 09-13 子3 W5（design §4.1）：终稿 checkpoint accept——slice 化（自 ChapterReviewPanel 的
   * CR-18 interim 本地 handler 迁入，键控形态 + #105 done-probe 守卫同享）。可携 `editedDraft`
   * 手改全文（IPC action='accept' 专属载荷；无变化不传）；和解分支 mirror 三动作
   * （busy 保留面板 / aborted·error 被动中断保留面板可重试 / paused 重建 / completed 清面板
   * + chapter_accept envelope 路由 + i18n 完成文案 agent.reviewFinalAccepted*）。
   * CR-5：第三参 `feedback`——escalate 灰区全接受裁决的勾选意见（synthesizeEscalateFeedback 合成
   * 串，supplement 非空时并入）随 accept 载荷透传（IPC feedback 通道无 action 限制）。
   */
  reviewAcceptFinal: (editedDraft?: string, sessionId?: string, feedback?: string) => Promise<void>;
  /**
   * Story 7.1 B1：确认 RevisionIntent → 调 resume-chapter-chain redo + revisionIntent（段落级改稿执行）。
   *
   * 清除 B1 trigger 状态（compiledIntent / reviewSelection / intentCompileError）后走 runResume redo path，
   * IPC revisionIntent 字段透传到 runChapterChain redo → revision_intent artifact 注入 → draft-writer
   * 段落级 directive → splice 回整章 draft.initial.text（design §3.2 Route 1）。
   */
  confirmRedoWithIntent: (intent: RevisionIntent, sessionId?: string) => Promise<void>;
  /**
   * Story 7.2 art-mode：revision-guard soft-violation pause 后作者「强行放行」。
   *
   * 调 resume-chapter-chain **redo** + guardOverride='force-accept'（redo.nodeId=revision-guard-agent 在
   * IPC 层据 guardOverride 切，重跑 guard splice soft-violation 稿）。design §1.5 + implement 风险点②：
   * soft-violation pause 时 revision-guard 已在 completedNodes，continue 会跳过 → 必须 redo 重跑。
   */
  forceAcceptGuard: (sessionId?: string) => Promise<void>;
  /** Story 7.1 B1：清除编译结果（取消确认关 / 重新编译前重置）。 */
  clearCompiledIntent: (sessionId?: string) => void;
};

type Deps = ChapterReviewSlice & {
  currentProject: { path?: string } | null;
  agentSessionId: string | null;
  /** dogfood T1 CR-T1-027：busy 拒绝 toast 的一键跳转（project_run_active 占用者会话）。 */
  switchAgentSession: (sessionId: string) => Promise<void>;
  /** Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺 envelope 组路由进 PatchReview（creativeFieldsSlice 实现）。 */
  setPendingPatch: (sessionId: string, patch: import('@orison/shared-contracts').ProjectFieldPatch | null) => void;
  /**
   * 09-13 子3 W2（design §2.2/F5）：escalate findings 路由缓存键（agentSessionSlice 持字段，
   * agentEvents metadata.findings 路由是主写入方）。可选——最小测试 store 缺省 = 本 slice
   * 的 resume fallback 不写（set 前守卫）。
   */
  escalateFindingsBySession?: Record<string, import('./chainTimeline').EscalateFindingsEntry>;
};

// ── Implementation ──

/**
 * 从 paused 的 RunChapterChainSummary 重建 ChapterReviewMetadata（resume 后链段在下一 checkpoint
 * 又停时，把新 checkpoint 的载荷渲染进 panel）。shape 单源 = ChapterReviewMetadata（与 write-chapter.ts
 * 的 metadata 组装对齐，design §3.5/§3.6）。09-13 子3 W4（design §4.3）：从 slice 私有升为导出——
 * ChapterReviewPanel 迁 features/writing 后终稿 accept 的 paused 防御分支复用（单源收敛，删 interim 镜像）。
 *
 * summary 不回传 chapterId（IPC resume 不复写）——chapterId 由 caller 从上一轮 pausedReview 保留透传。
 *
 * dogfood R2 #83/#84（2026-08-28）：挂起载荷透传——resume 后再挂起（同矛盾再核实 / 新矛盾）时旧实现
 * 丢 researchSuspension + 恒给三钮，把写前挂起渲染成可「继续写」的草稿审阅卡（死循环入口）。现 mirror
 * write-chapter.ts 组装：researchSuspension 在 → resumeOptions=['redo','abort']（挂起无正文可续，恢复
 * 只有 redo——continue 会撞下游 DAG blocked）；挂起载荷随卡透传（决断卡数据源）。
 *
 * 09-13 子3 W4（design §4.3）：final 扩展——pausedStage='final' → stage + reviewSummary + lintReport +
 * resumeOptions 注入 'accept'（interim 版缺 accept 注入，本版一并补；终稿审阅卡 accept 动作依赖）。
 */
export function metadataFromPausedSummary(summary: RunChapterChainSummary): ChapterReviewMetadata {
  const stage = summary.pausedStage ?? 'draft';
  const suspension = summary.researchSuspension;
  const meta: ChapterReviewMetadata = {
    type: 'chapter_review',
    stage,
    resumeOptions: suspension
      ? ['redo', 'abort']
      : stage === 'final'
        ? ['accept', 'redo', 'abort']
        : ['continue', 'redo', 'abort'],
  };
  if (summary.draftContent !== undefined) meta.draftContent = summary.draftContent;
  if (summary.briefContent !== undefined) meta.briefContent = summary.briefContent;
  // Story 7.2：revision-guard pause 抽 revisionGuard 载荷（findings + 改前/改后 + L1 幅度）供 art-mode 卡。
  if (stage === 'revision-guard' && summary.revisionGuard) {
    meta.revisionGuard = summary.revisionGuard;
  }
  // 09-13 子3 W4（design §4.3）：final 终态载荷（自审收敛摘要 + 去 AI 味 digest）。
  if (stage === 'final') {
    if (summary.reviewSummary) meta.reviewSummary = summary.reviewSummary;
    if (summary.lintReport !== undefined) meta.lintReport = summary.lintReport;
  }
  // dogfood R2 #83/#84：挂起 pause 抽挂起载荷（矛盾/偏离明细——决断卡数据源）。
  if (suspension) meta.researchSuspension = suspension;
  return meta;
}

/**
 * dogfood R2 #105 缓①（2026-08-30）：resume 被动中断（continue/redo 返 aborted/error / IPC throw）
 * 的告知 toast。审阅卡按「原样保留」哲学不清场（mirror busy 分支 CR-T1-027）——文案注明重跑
 * 起点为上次审阅快照：保留的载荷是上一 pause 的旧数据（draft 可能落后于中断时已流出的文本，
 * 重试 continue/redo 从该快照续跑）。纯 store 模块不能调 useI18n hook——translate 非 hook 译者
 *（agentEvents #18-B 同款读法）。
 */
function showReviewInterruptedToast(locale: string, reason?: string): void {
  useToastStore.getState().showToast(
    reason
      ? translate(locale, 'agent.reviewInterruptedKeptWithReason', { reason })
      : translate(locale, 'agent.reviewInterruptedKept'),
    'warning',
    6000,
  );
}

/**
 * CR-16a：chapter_candidate envelope 构造单源——runResume 的 accept 专用分支与通用分支此前
 * 逐字段重复（field/action/data/fieldVersion/generatedBy 全同）。fieldVersion 恒 1（fieldMetadata
 * 不跟踪 chapter_candidate，PatchReview 仅展示用）；generatedBy mirror agentEvents field_patch
 * 路由对非 creative field 的取值。
 */
function chapterCandidateEnvelope(
  runId: string,
  accept: NonNullable<RunChapterChainSummary['chapter_accept']>,
): ProjectFieldPatch {
  return {
    runId,
    createdAt: new Date().toISOString(),
    patches: [{
      field: 'chapter_candidate',
      action: 'set',
      data: {
        chapterId: accept.chapterId,
        runId: accept.runId,
        candidate: accept.candidate,
        ...(accept.storyDecisions && accept.storyDecisions.length > 0
          ? { storyDecisions: accept.storyDecisions }
          : {}),
      },
      fieldVersion: 1,
      generatedBy: 'write_chapter',
    }],
  };
}

/** 项目重置时按键归属过滤（mirror pausedReviewBySession 的 owner 保留语义）。 */
function filterKeyed<T>(map: Record<string, T>, keep: (sid: string) => boolean): Record<string, T> {
  const next: Record<string, T> = {};
  for (const sid of Object.keys(map)) {
    if (keep(sid)) next[sid] = map[sid];
  }
  return next;
}

export const createChapterReviewSlice: StateCreator<Deps, [], [], ChapterReviewSlice> = (set, get) => {
  // ── W4 键控写 helper（五本地态：设值 / 删键归缺省） ──

  const setResuming = (sid: string, value: boolean) => set((s) => {
    if (value) {
      if (s.reviewResumingBySession[sid] === true) return s;
      return { reviewResumingBySession: { ...s.reviewResumingBySession, [sid]: true } };
    }
    if (!(sid in s.reviewResumingBySession)) return s;
    const next = { ...s.reviewResumingBySession };
    delete next[sid];
    return { reviewResumingBySession: next };
  });

  const setCompiling = (sid: string, value: boolean) => set((s) => {
    if (value) {
      if (s.intentCompilingBySession[sid] === true) return s;
      return { intentCompilingBySession: { ...s.intentCompilingBySession, [sid]: true } };
    }
    if (!(sid in s.intentCompilingBySession)) return s;
    const next = { ...s.intentCompilingBySession };
    delete next[sid];
    return { intentCompilingBySession: next };
  });

  const setCompiledIntent = (sid: string, value: RevisionIntent | null) => set((s) => {
    if (value === null) {
      if (!(sid in s.compiledIntentBySession)) return s;
      const next = { ...s.compiledIntentBySession };
      delete next[sid];
      return { compiledIntentBySession: next };
    }
    return { compiledIntentBySession: { ...s.compiledIntentBySession, [sid]: value } };
  });

  const setIntentError = (sid: string, value: string | null) => set((s) => {
    if (value === null) {
      if (!(sid in s.intentCompileErrorBySession)) return s;
      const next = { ...s.intentCompileErrorBySession };
      delete next[sid];
      return { intentCompileErrorBySession: next };
    }
    return { intentCompileErrorBySession: { ...s.intentCompileErrorBySession, [sid]: value } };
  });

  /**
   * CR-3：escalate 裁决卡失效清键（裁决消费点 = reviewAcceptFinal/reviewRedo 完成 resume
   * 返回后；新 run 重置点在 chainTimeline.resetIfNewRun）。缺省面守卫——最小测试 store
   * 无 escalateFindingsBySession 时 no-op。
   */
  const clearEscalateFindings = (sid: string) => set((s) => {
    if (!s.escalateFindingsBySession || !(sid in s.escalateFindingsBySession)) return s;
    const next = { ...s.escalateFindingsBySession };
    delete next[sid];
    return { escalateFindingsBySession: next };
  });

  /** B1 trigger 态三键同清（三动作入口 / 确认 redo 前——防下一 checkpoint 残留旧 intent 卡）。 */
  const clearB1State = (sid: string) => set((s) => {
    if (
      !(sid in s.compiledIntentBySession)
      && !(sid in s.reviewSelectionBySession)
      && !(sid in s.intentCompileErrorBySession)
    ) return s;
    const nextIntent = { ...s.compiledIntentBySession };
    const nextSelection = { ...s.reviewSelectionBySession };
    const nextError = { ...s.intentCompileErrorBySession };
    delete nextIntent[sid];
    delete nextSelection[sid];
    delete nextError[sid];
    return {
      compiledIntentBySession: nextIntent,
      reviewSelectionBySession: nextSelection,
      intentCompileErrorBySession: nextError,
    };
  });

  // 项目级状态：切项目必须清——否则上个项目 paused 的 review 泄漏到新项目，三动作会调错项目的
  // resume IPC（写错项目章节，同 agentDiffSlice pendingDiffs 项目隔离硬约束）。[[state-management]]
  // dogfood T1 CR-T1-025：pausedReview 是「等待用户」挂起键（按定义不再产事件）——批3 的
  // owner==当前项目过滤会把离开项目的挂起卡销毁，切回后审阅面板永久丢（主进程 run 死等只能
  // abort 救）。改「按 owner 归属保留」：有归属的键跨项目存活（mirror agentRunStates；渲染面
  // 按 sessionId 键控隔离——ChapterReviewPanel 只读传入会话的键），仅清无归属残键。
  // W4：五本地态同 owner 过滤（resume/编译在途的会话键跨项目存活——CR-002 丢弃守卫兜结果侧）。
  registerProjectReset(() => {
    const keep = (sid: string): boolean => getSessionProject(sid) !== undefined;
    set({
      pausedReviewBySession: filterKeyed(get().pausedReviewBySession, keep),
      reviewResumingBySession: filterKeyed(get().reviewResumingBySession, keep),
      reviewSelectionBySession: filterKeyed(get().reviewSelectionBySession, keep),
      compiledIntentBySession: filterKeyed(get().compiledIntentBySession, keep),
      intentCompilingBySession: filterKeyed(get().intentCompilingBySession, keep),
      intentCompileErrorBySession: filterKeyed(get().intentCompileErrorBySession, keep),
    });
  });

  /**
   * 三动作共享驱动：调 closure:resume-chapter-chain IPC，据返回 summary 和解 pausedReview。
   * - paused → 更新 pausedReview（下一 checkpoint）。
   * - completed → 清 pausedReview（panel 卸载，#93 envelope 路由收尾）。
   * - aborted/error（continue/redo/accept）→ **保留 pausedReview** + toast 告知（dogfood R2 #105 缓①，
   *   2026-08-30——被动中断/失败清场会把三动作入口一起清掉，用户只剩链卡重试；chainSnapshot
   *   只在 abort IPC / deleteSession 清，被动中断后滞留 → continue/redo 可再续）。
   *   W5：accept 同款保留（接受是用户决策但中断是被动——interim 面板 handler 行为迁入）。
   * - aborted/error（action=abort，用户主动放弃）→ 清 pausedReview（用户已做完决策）。
   * - busy 拒绝 → pausedReview 原样保留 + busy toast（CR-T1-027）。
   * - IPC throw → 同款按 action 分流（continue/redo/accept 保留可重试；abort 清场）。
   *
   * chapterId 透传：从当前 pausedReview 取（IPC resume 不复写；leader write_chapter 初次 pause 时
   * 由 params.chapterId 写入 metadata）。无 chapterId 时 IPC 接受缺省（runChapterChain resume 据
   * chainSnapshot 续跑，不依赖 chapterId）。
   *
   * W4：sid 尾参（缺省 = Deps.agentSessionId）——写作页多会话直审场景按目标会话键控读写；
   * resume 绑目标会话的 pausedReview 键（owner = 该 sid，IPC sessionId 同参）。
   *
   * Story 7.1 B1：revisionIntent optional 透传——confirmRedoWithIntent 用此 path 触发段落级改稿
   * （design §3.2 Route 1）；其他两动作（continue/abort）不传 revisionIntent。
   *
   * 09-13 子3 W5（design §4.1）：action='accept'（终稿 checkpoint 专属）+ editedDraft optional
   * （人手改正文全文——contracts refine：仅 accept 合法 + 空白串拒收；caller 侧「无变化不发送」）。
   */
  async function runResume(
    action: 'continue' | 'redo' | 'abort' | 'accept',
    feedback?: string,
    revisionIntent?: RevisionIntent,
    guardOverride?: 'force-accept',
    sessionIdParam?: string,
    editedDraft?: string,
  ): Promise<void> {
    const sessionId = sessionIdParam ?? get().agentSessionId;
    // CR-004：store 层 guard 兜底——程序化双触发（快捷键 / 双 Enter / 非 UI 调用）在首 IPC 未 set
    // reviewResuming 重渲染前竞态，UI 按钮禁用挡不住程序化路径。guard 在 set 前读，单 IPC 进 flight。
    // W4 键控：guard 只看**目标会话**的 flight 键（A 会话在途不挡 B 会话动作）。
    if (!sessionId || get().reviewResumingBySession[sessionId] === true) return;
    const project = get().currentProject;
    const meta = get().pausedReviewBySession[sessionId];
    if (!project?.path) return;
    // CR-002：capture projectPath 在 await 前——await 期间若用户切项目（registerProjectReset 清了
    // pausedReview + 翻 currentProject），IPC 返后写回老项目 pausedReview 会泄漏到新项目（跨项目 resume/写）。
    // post-await 复核 currentProject.path 与 capture 的 path，不等 → 丢弃结果（取消 token 语义）。
    const projectPath = project.path;

    const setPaused = (value: ChapterReviewMetadata | null) => {
      set((s) => {
        if (!value) {
          if (!(sessionId in s.pausedReviewBySession)) return s;
          const next = { ...s.pausedReviewBySession };
          delete next[sessionId];
          return { pausedReviewBySession: next };
        }
        return { pausedReviewBySession: { ...s.pausedReviewBySession, [sessionId]: value } };
      });
    };

    setResuming(sessionId, true);
    try {
      const summary = await resumeChapterChain({
        projectPath,
        sessionId,
        ...(meta?.chapterId ? { chapterId: meta.chapterId } : {}),
        action,
        ...(feedback && (action === 'redo' || action === 'accept') ? { feedback } : {}),
        // Story 7.1 B1：revisionIntent 仅 redo path 透传（continue/abort 无段落级改稿语义）。
        ...(action === 'redo' && revisionIntent ? { revisionIntent } : {}),
        // Story 7.2 art-mode：guardOverride 仅 redo path 透传（force-accept 重跑 revision-guard splice）。
        ...(action === 'redo' && guardOverride ? { guardOverride } : {}),
        // W5（design §4.1）：editedDraft 仅 accept path 透传（终稿手改全文；contracts refine 同款约束）。
        ...(action === 'accept' && editedDraft !== undefined ? { editedDraft } : {}),
      });
      // CR-002：await 后、写 state 前复核项目未切——切了则丢弃结果（新项目不该见老链段结果：
      // 不写 pausedReview、不 toast，仅翻 reviewResuming:false 释放 guard）。
      if (get().currentProject?.path !== projectPath) {
        setResuming(sessionId, false);
        return;
      }
      if (summary.status === 'paused') {
        const next = metadataFromPausedSummary(summary);
        // chapterId 保留透传（resume summary 不回传；保留前一轮的避免丢失追踪）。
        if (!next.chapterId && meta?.chapterId) next.chapterId = meta.chapterId;
        setPaused(next);
        // CR-3：accept/redo 的裁决消费点——resume 已返回，旧裁决卡随之失效（若新 checkpoint
        // 仍 escalate，下方 fallback / metadata 通道立即重写新载荷）。busy / 被动中断分支在
        // 裁决未被消费前不清（重试时卡须还在）。continue/abort 不在此清。
        if (action === 'accept' || action === 'redo') clearEscalateFindings(sessionId);
        // 09-13 子3 W2（design §2.2/F5）：escalate-pause 载荷 fallback 缓存——resume 车道跑在
        // leader 工具调用生命周期外，write_chapter 的 metadata.findings 通道走不到（escalate-pause
        // 又不产 pausedReview）→ 裁决卡数据源只能从本 summary 取（escalateFindings 只在
        // route=escalate_user 时附带）。条目级防御投影（坏条目单独丢，mirror agent
        // extractEscalateFindings 语义）。
        if (summary.escalateFindings !== undefined) {
          // CR-13：source/route 从 summary 实际可得字段推断，不硬编码——planEscalate 在场 =
          // 规划环灰区（write-chapter 裁决分派把 plan_review findings 投影进 escalateFindings，
          // reader-audit 硬编码误标 plan-review 家族）；routeDecision 在场 = 自审环灰区（route =
          // 当前 decision，mirror metadata 通道取值）；都缺则省略可选字段（不造数据）。
          const planEscalate = (summary as { planEscalate?: unknown }).planEscalate;
          const identity = planEscalate != null
            ? { source: 'plan-review' as const, route: 'escalate' }
            : summary.routeDecision !== undefined
              ? { source: 'reader-audit' as const, route: summary.routeDecision.decision }
              : {};
          set((s) => ({
            escalateFindingsBySession: {
              ...(s.escalateFindingsBySession ?? {}),
              [sessionId]: {
                ...identity,
                ...(meta?.chapterId ? { chapterId: meta.chapterId } : {}),
                items: projectEscalateFindingItems(summary.escalateFindings),
                at: Date.now(),
              },
            },
          }));
        }
        setResuming(sessionId, false);
      } else {
        // dogfood T1 CR-T1-027：busy 拒绝（run 未启动——shell D4 闸 / agent 层链守卫）优先于
        // 终态和解：chainSnapshot 与 pausedReview **原样保留**（面板在，busy run 结束后可重试），
        // 只翻 reviewResuming；文案/跳转与 chat 路径同款（projectRunBusy 单源——链租约 id 换
        // 文案无跳转）。旧实现 errors.join(';') 原样透出机器串 + 误清 pausedReview（面板消失丢
        // resume 能力）。
        const busy = summary.status === 'error' ? parseChainBusyError(summary.errors) : undefined;
        if (busy) {
          setResuming(sessionId, false);
          const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
          if (busy.kind === 'chain_run_active') {
            // agent 层链守卫：占用者是真实会话但链在跑——文案提示等待，无跳转钮。
            showChainRunBusyToast(locale);
          } else {
            showRunBusyToast({
              heldBySessionId: busy.heldBySessionId,
              projectPath: busy.projectPath,
              locale,
              onJump: (sid) => { void get().switchAgentSession(sid); },
            });
          }
          return;
        }
        // ── dogfood R2 #105 缓①（2026-08-30）：终态和解按「中断是否用户主动」分流 ──
        //
        // continue/redo/accept 返 aborted/error = 链被动中断/失败（流被掐 / 链段跑崩）——不是用户决策。
        // 旧实现一律 setPaused(null) 把审阅卡连同三动作入口一起清掉（用户只剩链卡重试钮，
        // resume 能力丢失）。mirror busy 分支（:244-259）的「原样保留」哲学：pausedReview 不动
        // + reviewResuming 复位 + toast 告知。已核实 chainSnapshot 只在 abort IPC / deleteSession
        // 清——被动中断后滞留，continue/redo 可从 snapshot 校验路径（closureChainIpc resume
        // handler）再续。保留的载荷是上一 pause 的旧快照（draft 可能落后于中断时已流出的文本，
        // toast 文案注明「重跑起点」语义）。abort（用户主动放弃）→ 维持 setPaused(null)。
        if (
          (action === 'continue' || action === 'redo' || action === 'accept')
          && (summary.status === 'aborted' || summary.status === 'error')
        ) {
          setResuming(sessionId, false);
          const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
          showReviewInterruptedToast(
            locale,
            summary.status === 'error' && summary.errors.length > 0 ? summary.errors.join('; ') : undefined,
          );
          return;
        }
        setPaused(null);
        setResuming(sessionId, false);
        // CR-3：终态和解 = 裁决消费完成（busy / 被动中断分支已在上方 return，卡片保留）——
        // accept/redo 的旧裁决卡随之失效。
        if (action === 'accept' || action === 'redo') clearEscalateFindings(sessionId);
        // ── dogfood R2 #93（P0-2/P0-3，2026-08-28）：resume 终态收尾路由 ──
        //
        // P0-2 chapter_accept envelope → pendingPatch：resume 车道跑在 leader 工具调用生命周期外，
        // write_chapter 的 metadata field_patch 通道走不到（链完成只回 IPC 调用方，审核卡永不出现 →
        // 章节永不落盘）。shell #93 修复后 review 档（suggest/readonly 会话）不直落、envelope 留
        // summary 返 UI——此处 mirror leader 路径的 agentEvents field_patch 路由（field/action/data
        // 形态与 write-chapter.ts metadata 组装逐字段对齐），用户 PatchReview accept 后经
        // applyAgentFieldPatch → acceptChapterCandidateCore 落 chapters/（既有收口，无新持久化路径）。
        // chapterPersisted（auto 档 shell 已直落）→ 不 stage（防双写），toast 告知落盘去向。
        //
        // P0-3 链完成回报：resume 完成此前对用户零痕迹（leader 已在 pause 前终态、无回调机制，对话面
        // 静默）。最小侵入 = 完成卡落审核面（pendingPatch 即「写章完成 · 待审阅」面）+ toast 摘要
        // （routeDecision + 字数 + 下一步动作）。leader 回注机制不存在（write_chapter 工具调用已返回，
        // 无 runLoop 再入通道）——UI 卡是本轮拍板形态，记档待未来 leader 回注设计。
        // ── 09-13 子3 W5（design §4.1）：终稿 accept 的完成收尾（interim 面板 handler 迁入）──
        //
        // 文案走 i18n（agent.reviewFinalAccepted* 族——「已落盘 / 待审阅后落盘」两态）；envelope
        // 路由（chapterPersisted=false 时 setPendingPatch 进写作页待落盘审阅）与下方通用块同形。
        // 无候选且未落盘的 skip 形态（accept 被上游 skip）不进本分支——落到通用块的 error toast
        // （不静默：用户须知道稿没落盘和为什么）。
        const accept = summary.chapter_accept;
        if (action === 'accept' && (accept !== undefined || summary.chapterPersisted)) {
          const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
          const title = summary.draftTitle ?? accept?.chapterId ?? meta?.chapterId
            ?? translate(locale, 'agent.reviewFinalFallback');
          if (accept && !summary.chapterPersisted) {
            // CR-16a：envelope 构造单源（chapterCandidateEnvelope——与下方通用分支同形）。
            get().setPendingPatch(sessionId, chapterCandidateEnvelope(sessionId, accept));
            useToastStore
              .getState()
              .showToast(translate(locale, 'agent.reviewFinalAcceptedReview', { title }), 'info', 6000);
          } else {
            useToastStore
              .getState()
              .showToast(translate(locale, 'agent.reviewFinalAccepted', { title }), 'success', 6000);
          }
        } else if (accept && !summary.chapterPersisted) {
          // CR-16a：envelope 构造单源（chapterCandidateEnvelope——与上方 accept 分支同形）。
          get().setPendingPatch(sessionId, chapterCandidateEnvelope(sessionId, accept));
          const titlePart = summary.draftTitle ? `《${summary.draftTitle}》` : `章节 ${accept.chapterId}`;
          const wordPart = summary.draftWordCount !== undefined ? `（${summary.draftWordCount} 字）` : '';
          useToastStore
            .getState()
            .showToast(
              summary.routeDecision?.decision === 'escalate_user'
                ? `写章完成：${titlePart}${wordPart}——灰区裁决：审阅卡 accept=接受为真相 / reject=改稿`
                : `写章完成：${titlePart}${wordPart}——章节候选待审阅后落盘`,
              'info',
            );
        } else if (summary.chapterPersisted) {
          const titlePart = summary.draftTitle ? `《${summary.draftTitle}》` : `章节 ${accept?.chapterId ?? ''}`;
          const wordPart = summary.draftWordCount !== undefined ? `（${summary.draftWordCount} 字）` : '';
          useToastStore
            .getState()
            .showToast(`写章完成：${titlePart}${wordPart}——已直接落盘 chapters/（全自动档）`, 'success');
        } else if (
          summary.status === 'completed' &&
          (summary.routeDecision?.decision === 'accept_as_truth' ||
            summary.routeDecision?.decision === 'escalate_user')
        ) {
          // accept/escalate 但无 envelope（skip：no-draft/no-chapter/no-nowiso——shell 已把 describeAcceptSkip
          // 细节附进 errors：accept 走既有 skip 文案 / review 档 escalate 走「灰区上发：无章节候选」文案；
          // check 补含 escalate 分支——否则 review 档 escalate 无候选时 shell 声称「UI 终态 toast 消费」
          // 实则零分支吃它 → 静默）→ toast 告知（不静默——用户须知道稿没落盘和为什么）。
          useToastStore
            .getState()
            .showToast(`写章完成但未生成章节候选：${summary.errors.join('; ')}`, 'error');
        } else if (action === 'accept') {
          // CR-8：accept 分支的静默路径兜底——接受已完成、无 envelope、未持久化，且非上方
          // skip 文案路径（routeDecision 缺席/非 accept·escalate 等）。面板此刻已清场，零反馈
          // = 用户无从知道接受是否生效。运行阶段可见性纪律：警示 toast 告知无落盘凭证。
          const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
          useToastStore
            .getState()
            .showToast(translate(locale, 'agent.reviewAcceptNoOutcome'), 'warning', 7000);
        }
        // Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺路由（shell applyStorySyncOnResume 产出——
        // suggest 档链段必 pause，终态提取只经 resume IPC 回 UI，write_chapter 的 metadata 路由走不到）。
        // storySyncReview（suggest/readonly 人审档）→ setPendingPatch 进 PatchReview（mirror
        // agentSessionSlice storySyncPatches 路由落点；creativeFieldsSlice merge 语义跨批不丢）；
        // storySyncLanded（auto 直落档）→ toast 告知（非静默——auto 落盘无 chat 行）。缺省零动作。
        if (summary.storySyncReview && summary.storySyncReview.patches.length > 0) {
          get().setPendingPatch(sessionId, {
            runId: sessionId,
            createdAt: new Date().toISOString(),
            patches: summary.storySyncReview.patches,
          });
          useToastStore
            .getState()
            .showToast(
              `正文反哺（${summary.storySyncReview.note}）：${summary.storySyncReview.patches.length} 个设定补丁待审阅`,
              'info',
            );
        } else if (summary.storySyncLanded && summary.storySyncLanded.fields.length > 0) {
          useToastStore
            .getState()
            .showToast(
              `正文反哺（${summary.storySyncLanded.note}）：${summary.storySyncLanded.fields.join('、')} 已自动落盘`,
              'success',
            );
        }
        // error summary（IPC Zod/路径校验失败 / loadProject 失败 / 链段跑崩）→ toast 告知（不静默）。
        if (summary.status === 'error' && summary.errors.length > 0) {
          useToastStore.getState().showToast(`链段续跑失败: ${summary.errors.join('; ')}`, 'error');
        }
      }
    } catch (err) {
      // CR-002：catch 路径同样复核项目未切——切了则静默丢弃（不 toast 老项目错误到新项目）。
      if (get().currentProject?.path !== projectPath) {
        setResuming(sessionId, false);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      // dogfood R2 #105 缓①：catch 路径同款分流——continue/redo/accept 的 IPC throw（网关掐流 /
      // IPC 下线）不是用户决策，保留面板可重试；abort（用户主动放弃）维持清场 + 既有失败 toast。
      if (action === 'continue' || action === 'redo' || action === 'accept') {
        setResuming(sessionId, false);
        const locale = (get() as unknown as { resolvedLocale?: string }).resolvedLocale ?? 'zh-CN';
        showReviewInterruptedToast(locale, msg);
        return;
      }
      setPaused(null);
      setResuming(sessionId, false);
      useToastStore.getState().showToast(`链段续跑失败: ${msg}`, 'error');
    }
  }

  /**
   * Story 7.1 B1：调 closure:compile-revision-intent IPC 派 revision-optimizer 子 agent 编译意图。
   *
   * 范式判据（ADR-3）：意图编译归 LLM（IPC 内部 dispatch revision-optimizer 子 agent）；本函数只机械
   * 派发 + 状态和（compiledIntent / intentCompileError），不做语义判断。
   *
   * 项目隔离 + 重入 guard mirror runResume：await 期间切项目丢弃结果；intentCompiling=true 时 no-op
   * （防双触发）。W4：sid 尾参键控（缺省 = Deps.agentSessionId）。
   */
  async function doCompileIntent(
    selectedPassage: string,
    userInstruction: string,
    selectionFrom: number,
    selectionTo: number,
    draftText: string,
    chapterContext?: string,
    sessionIdParam?: string,
  ): Promise<void> {
    const sessionId = sessionIdParam ?? get().agentSessionId;
    if (!sessionId || get().intentCompilingBySession[sessionId] === true) return;
    const project = get().currentProject;
    if (!project?.path) return;
    const projectPath = project.path;

    setCompiling(sessionId, true);
    setIntentError(sessionId, null);
    setCompiledIntent(sessionId, null);
    try {
      const result = await compileRevisionIntent({
        projectPath,
        sessionId,
        selectedPassage,
        userInstruction,
        selectionFrom,
        selectionTo,
        draftText,
        ...(chapterContext ? { chapterContext } : {}),
      });
      // CR-002 同款：await 后复核项目未切——切了则丢弃结果（新项目不该见老 compiledIntent）。
      if (get().currentProject?.path !== projectPath) {
        setCompiling(sessionId, false);
        return;
      }
      if (result.intent) {
        setCompiledIntent(sessionId, result.intent);
        setCompiling(sessionId, false);
        setIntentError(sessionId, null);
      } else {
        // IPC 返 null intent（optimizer parse 失败 / dispatch 失败 / 无 invalid input）→ 落 error。
        // 不假信心、不静默 fail（mirror revision-optimizer graceful）。
        setCompiledIntent(sessionId, null);
        setCompiling(sessionId, false);
        setIntentError(sessionId, result.error ?? '意图编译失败，请重述或手改');
      }
    } catch (err) {
      if (get().currentProject?.path !== projectPath) {
        setCompiling(sessionId, false);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setCompiledIntent(sessionId, null);
      setCompiling(sessionId, false);
      setIntentError(sessionId, msg);
    }
  }

  return {
  pausedReviewBySession: {},
  reviewResumingBySession: {},
  reviewSelectionBySession: {},
  compiledIntentBySession: {},
  intentCompilingBySession: {},
  intentCompileErrorBySession: {},
  setPausedReview: (sessionId, meta) => set((s) => {
    if (!meta) {
      if (!(sessionId in s.pausedReviewBySession)) return s;
      const next = { ...s.pausedReviewBySession };
      delete next[sessionId];
      return { pausedReviewBySession: next };
    }
    return { pausedReviewBySession: { ...s.pausedReviewBySession, [sessionId]: meta } };
  }),
  clearPausedReviewFor: (sessionId) => set((s) => {
    if (!(sessionId in s.pausedReviewBySession)) return s;
    const next = { ...s.pausedReviewBySession };
    delete next[sessionId];
    return { pausedReviewBySession: next };
  }),
  setReviewSelection: (sessionId, selection) => set((s) => {
    if (selection === null) {
      if (!(sessionId in s.reviewSelectionBySession)) return s;
      const next = { ...s.reviewSelectionBySession };
      delete next[sessionId];
      return { reviewSelectionBySession: next };
    }
    return { reviewSelectionBySession: { ...s.reviewSelectionBySession, [sessionId]: selection } };
  }),
  clearReviewLocalStateFor: (sessionId) => set((s) => {
    const hadAny =
      sessionId in s.reviewResumingBySession
      || sessionId in s.reviewSelectionBySession
      || sessionId in s.compiledIntentBySession
      || sessionId in s.intentCompilingBySession
      || sessionId in s.intentCompileErrorBySession;
    if (!hadAny) return s;
    return {
      reviewResumingBySession: filterKeyed(s.reviewResumingBySession, (sid) => sid !== sessionId),
      reviewSelectionBySession: filterKeyed(s.reviewSelectionBySession, (sid) => sid !== sessionId),
      compiledIntentBySession: filterKeyed(s.compiledIntentBySession, (sid) => sid !== sessionId),
      intentCompilingBySession: filterKeyed(s.intentCompilingBySession, (sid) => sid !== sessionId),
      intentCompileErrorBySession: filterKeyed(s.intentCompileErrorBySession, (sid) => sid !== sessionId),
    };
  }),

    reviewContinue: (sessionId) => {
      // BMad CR F5：plain continue/redo/abort 也清 B1 trigger 状态（避免下一 checkpoint pause 残留旧 intent 卡片
      // / 旧选区——stale anchor 指向已变 draft → splice 失败 silent，edge-005）。
      const sid = sessionId ?? get().agentSessionId;
      if (sid) clearB1State(sid);
      return runResume('continue', undefined, undefined, undefined, sessionId);
    },
    reviewRedo: (feedback, sessionId) => {
      const sid = sessionId ?? get().agentSessionId;
      if (sid) clearB1State(sid);
      return runResume('redo', feedback, undefined, undefined, sessionId);
    },
    reviewAbort: (sessionId) => {
      const sid = sessionId ?? get().agentSessionId;
      if (sid) clearB1State(sid);
      return runResume('abort', undefined, undefined, undefined, sessionId);
    },

    reviewAcceptFinal: (editedDraft, sessionId, feedback) => {
      // W5（design §4.1）：终稿 accept——B1 trigger 态清理 mirror 三动作（防下一 checkpoint 残留
      // 旧 intent 卡/旧选区），重入 guard mirror confirmRedoWithIntent 哲学（guard 先于 clear，
      // guard 拒时不清用户状态）。CR-5：feedback 尾参（escalate 全接受携带补充说明——不接受
      // 静默丢用户输入；IPC feedback 通道本就任意 action 可带）。
      const sid = sessionId ?? get().agentSessionId;
      if (sid && get().reviewResumingBySession[sid] === true) return Promise.resolve();
      if (sid) clearB1State(sid);
      return runResume('accept', feedback, undefined, undefined, sessionId, editedDraft);
    },

    compileIntent: (selectedPassage, userInstruction, selectionFrom, selectionTo, draftText, chapterContext, sessionId) =>
      doCompileIntent(selectedPassage, userInstruction, selectionFrom, selectionTo, draftText, chapterContext, sessionId),

    confirmRedoWithIntent: (intent, sessionId) => {
      // BMad CR F6：guard first（runResume 内 reviewResuming 检查）then clear——若先 clear 再 guard，
      // guard 拒时（reviewResuming=true 重入）compiledIntent 已丢但 IPC 没发，用户确认的 intent 丢失。
      // runResume 内 set reviewResuming=true 原子保护；先调 runResume，clear 在其 guard 通过后由其内部
      // 流程推进（但 compiledIntent 须在 IPC 发出前清避下一 pause 残留——故 runResume 调用前 clear，
      // 但 runResume 内 guard 失败时 no-op 不发 IPC，此时 clear 已发生 = 用户 intent 丢失）。
      // 折中：本地 guard（同 runResume 逻辑）先查，通过才 clear + runResume。
      const sid = sessionId ?? get().agentSessionId;
      if (sid && get().reviewResumingBySession[sid] === true) return Promise.resolve();
      if (sid) clearB1State(sid);
      return runResume('redo', undefined, intent, undefined, sessionId);
    },

    forceAcceptGuard: (sessionId) => {
      // Story 7.2 art-mode：soft-violation 强行放行。redo + guardOverride（IPC 据 guardOverride 切
      // redo.nodeId=revision-guard-agent 重跑 guard splice）。同 confirmRedoWithIntent 的重入 guard 哲学。
      const sid = sessionId ?? get().agentSessionId;
      if (sid && get().reviewResumingBySession[sid] === true) return Promise.resolve();
      if (sid) clearB1State(sid);
      return runResume('redo', undefined, undefined, 'force-accept', sessionId);
    },

    clearCompiledIntent: (sessionId) => {
      const sid = sessionId ?? get().agentSessionId;
      if (!sid) return;
      setCompiledIntent(sid, null);
      setIntentError(sid, null);
    },
  };
};
