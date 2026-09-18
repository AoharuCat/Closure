import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { GUARD_DRIFT_PATTERN_LABELS_ZH } from '@orison/shared-contracts';
import type { RevisionIntent } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { TiptapEditor } from '../editor/TiptapEditor';
import { SideBySideDiff } from '../agent-panel/SideBySideDiff';
import { InsightCard } from '../agent-panel/InsightCard';
// 09-13 子3 W5（design §4.1/§4.2）：final 分支迁 FinalReviewCard + 确认卡提取共用组件；
// interim 终稿 accept 本地 handler 退役（slice reviewAcceptFinal 接管）。
import { RevisionIntentConfirmCard } from './RevisionIntentConfirmCard';

/**
 * Story 4.3 Step 4（design §3.6 / §5）：draft checkpoint prose-review 面板。
 * Story 7.1 B1（design §4.2）：draft stage 选区指挥精修扩展。
 *
 * 写章链段在 checkpoint pause 时（半自动/微操模式），leader write_chapter 产 chapter_review
 * metadata → chapterReviewSlice.setPausedReview → 本面板渲染正文 + 三动作（continue/redo/abort）。
 *
 * 09-13 子3 W4（design §5.1）：迁移 features/agent-panel → features/writing（审批迁写作页宽区），
 * props `sessionId?` 化（缺省兜底 = 视图会话 agentSessionId——键控读取 + 动作尾参传该 sid，
 * 后台会话直审不切走）。**样式类名不动**（chapter-review* 族仍在 agent-panel.css 原位生效）。
 *
 * 09-13 子3 W5（design §4.2）：写作页审阅相位的卡片路由（ReviewPhaseView）按 pauseKind 分派——
 * **stage='final' 迁 FinalReviewCard**（终稿全幅可编辑 + 手改追踪 + accept slice 化），本面板
 * 承载 brief / 挂起（researchSuspension）/ 护栏（revision-guard）/ legacy draft 四形态；final
 * 载荷防御性渲染 null（路由侧不派发，旧挂载点直挂时零重复）。
 *
 * 三动作调 chapterReviewSlice 的 reviewContinue/reviewRedo/reviewAbort（尾参传 sid）→ 结构化 IPC
 * `closure:resume-chapter-chain`（mirror 4.6 PatchReview accept/reject，非 leader LLM 解释）。
 *
 * brief stage：渲染 briefContent 摘要 + continue/abort（design §5 brief 软门 = Step 5）。
 *
 * 范式判据（ADR-3）：本面板只渲染 review 载荷 + 派发机械控制信号；意图编译归 LLM revision-optimizer
 * （IPC 内部 dispatch）；语义判断（draft 好不好 / 锁定项推断）归 LLM。
 * RevisionIntent.scope.anchor 由 revision-optimizer 产（IPC 内构造），UI 只透 selectedPassage（quote）。
 *
 * Story 7.2 art-mode（design §1.5）：revision-guard soft-violation pause → art-mode 确认卡（本面板
 * stage='revision-guard' 分支）。作者三档：强行放行（forceAcceptGuard→redo+guardOverride 重跑 guard
 * splice 落稿）/ 改指令（reviewAbort 回草稿重选重编译）/ 取消（reviewAbort）。findings 用 6 类漂移模式
 * 策展词表 GUARD_DRIFT_PATTERN_LABELS_ZH 展示（词表外值显原文，语义分类归 L2 非 UI 门禁）。
 *
 * Story 3.7（design D6/D7）：
 * - #4 guard findings 换 InsightCard 列表（title=pattern 标签+violatedScope / grounding=before→after /
 *   展开态 explanation）——per-finding **纯展示降级卡**（无 onApply/onIgnore：per-finding 无执行语义，
 *   卡级三档才是决策单位）；卡级三档 + SideBySideDiff 原位不动。
 * - #6 RevisionIntent 确认卡视觉对齐 insight-* class 族（来源/authority badge 位 + 按钮共用 class）；
 *   全部内容字段与三按钮行为零变更；不折叠（确认卡信息即操作上下文，D7 明确不硬塞折叠范式）。
 *   09-13 子3 W5：确认卡提取 RevisionIntentConfirmCard 共用组件（draft 精修与终稿卡指令精修两消费面）。
 */

export function ChapterReviewPanel({ sessionId: propsSessionId }: { sessionId?: string }) {
  const {
    pausedReview,
    reviewResuming,
    reviewContinue,
    reviewRedo,
    reviewAbort,
    // Story 7.1 B1 slice state + actions
    reviewSelection,
    compiledIntent,
    intentCompiling,
    intentCompileError,
    setReviewSelection,
    compileIntent,
    confirmRedoWithIntent,
    clearCompiledIntent,
    // Story 7.2 art-mode：revision-guard soft-violation 强行放行 action。
    forceAcceptGuard,
    agentSessionId,
    resolvedLocale,
  } = useAppStore(useShallow((s) => {
    // W4 键控：props.sessionId 优先（写作页后台会话直审），兜底视图会话（既有挂载形态零变化）。
    const sid = propsSessionId ?? s.agentSessionId;
    return {
      pausedReview: sid ? s.pausedReviewBySession[sid] : undefined,
      reviewResuming: sid ? s.reviewResumingBySession[sid] === true : false,
      reviewContinue: s.reviewContinue,
      reviewRedo: s.reviewRedo,
      reviewAbort: s.reviewAbort,
      reviewSelection: sid ? s.reviewSelectionBySession[sid] : undefined,
      compiledIntent: sid ? s.compiledIntentBySession[sid] : undefined,
      intentCompiling: sid ? s.intentCompilingBySession[sid] === true : false,
      intentCompileError: sid ? s.intentCompileErrorBySession[sid] : undefined,
      setReviewSelection: s.setReviewSelection,
      compileIntent: s.compileIntent,
      confirmRedoWithIntent: s.confirmRedoWithIntent,
      clearCompiledIntent: s.clearCompiledIntent,
      forceAcceptGuard: s.forceAcceptGuard,
      agentSessionId: s.agentSessionId,
      resolvedLocale: s.resolvedLocale,
    };
  }));
  // 动作尾参的目标会话（props 优先；未解析到会话时动作内部 no-op）。
  const sid = propsSessionId ?? agentSessionId;
  const { t } = useI18n(resolvedLocale);
  const [feedback, setFeedback] = useState('');
  // Story 7.1 B1: 本地 UI 状态——粗指令输入。
  const [instructionInput, setInstructionInput] = useState('');

  if (!pausedReview) return null;
  // W5：final 分支归 FinalReviewCard（ReviewPhaseView 路由）；防御性 null 防旧挂载点双卡。
  if (pausedReview.stage === 'final') return null;

  const stage = pausedReview.stage;
  const stageLabel =
    stage === 'draft' ? t('agent.reviewStageDraft')
      : stage === 'brief' ? t('agent.reviewStageBrief')
        : stage === 'revision-guard' ? t('agent.reviewStageRevisionGuard')
          : t('agent.reviewStageVerdict');

  // dogfood R2 #83/#84（2026-08-28）：写前挂起（出发核查矛盾/偏离，无草稿）——不是 draft review。
  // 旧实现按 stage='draft' 渲染草稿审阅卡（自述「无正文载荷」却给全部按钮）、「继续写」对挂起非法
  //（无正文可续）且不带偏离批准 → 用户被引导进死循环。现渲染挂起说明卡（矛盾/偏离明细 +
  // redo/abort——恢复只有 redo；leader 翻译+补丁的修复环是主出口，卡是结构化副出口）。
  const suspension = pausedReview.researchSuspension;
  const isSuspended = suspension !== undefined;

  const draftContent = pausedReview.draftContent ?? '';
  const wordCount = draftContent.length;

  // brief checkpoint 载荷是 chapter_brief artifact（unknown 形态）——字符串直接显，对象 JSON 序列化兜底，
  // 让用户至少看到 brief 内容（design §5 brief 软门对话形态是 Step 5，本步先能看 + 不崩）。
  const briefText = pausedReview.briefContent;
  const briefDisplay =
    typeof briefText === 'string' ? briefText
      : briefText == null ? ''
        : JSON.stringify(briefText, null, 2);

  const isDraft = stage === 'draft';
  const isRevisionGuard = stage === 'revision-guard';
  // 09-13 子3 W5（design §4.2 / D-c 意见必填）：挂起重跑 + brief 打回规划环 = 文字必填（空意见
  // 禁用提交——防 AI 瞎猜修订方向）；legacy draft redo 维持可选（既有行为）。guard 打回走 abort
  // 车道回草稿重编译（reviewAbort——abort 无 feedback IPC 通道，「必填指令」在重编译步兑现）。
  const isBrief = stage === 'brief';
  const redoRequired = isSuspended || isBrief;
  const redoFeedbackEmpty = feedback.trim() === '';
  // dogfood R2 #83/#84：按钮矩阵由载荷 resumeOptions 驱动（agentEvents/metadataFromPausedSummary 已
  // 透传——挂起卡 ['redo','abort']，真 checkpoint 三钮）。缺省三钮（旧载荷防御）。
  const options = pausedReview.resumeOptions.length > 0
    ? pausedReview.resumeOptions
    : (['continue', 'redo', 'abort'] as const);
  // soft-violation pause 时 revisionGuard 必在（slice metadataFromPausedSummary 保证 stage==='revision-guard'
  // && summary.revisionGuard → meta.revisionGuard）；TS optional → 消费处守卫（design §1.5）。
  const revisionGuard = isRevisionGuard ? pausedReview.revisionGuard : undefined;
  // 编译意图 / 确认 intent 时也视作 resuming（IPC flight），禁用动作按钮防重入。
  const anyInFlight = reviewResuming || intentCompiling;

  const handleRedo = () => {
    const fb = feedback.trim();
    if (redoRequired && fb === '') return; // D-c：必填门（按钮已禁用——程序化路径双 belt）
    setFeedback('');
    void reviewRedo(fb || undefined, sid ?? undefined);
  };

  // ── Story 7.1 B1：选区指挥精修 handlers ──

  const handleCompileIntent = () => {
    const passage = reviewSelection?.text ?? '';
    const instr = instructionInput.trim();
    if (!passage || !instr) return;
    // BMad CR F2：透传 selectionFrom/selectionTo + draftText——IPC 层纯代码构造 scope.anchor（非 LLM 产）。
    // from/to 来自 TipTap SelectionInfo（ProseMirror 权威位置），draftText 来自 pausedReview.draftContent。
    const from = reviewSelection?.from ?? 0;
    const to = reviewSelection?.to ?? 0;
    const draft = typeof draftContent === 'string' ? draftContent : '';
    // chapterContext = 本章 brief（若 pausedReview 带了 briefContent，stringify 作 optimizer 上下文）。
    const ctx = briefDisplay || undefined;
    void compileIntent(passage, instr, from, to, draft, ctx, sid ?? undefined);
  };

  const handleConfirmIntent = (intentToConfirm: RevisionIntent) => {
    setInstructionInput('');
    void confirmRedoWithIntent(intentToConfirm, sid ?? undefined);
  };

  const handleCancelCompiled = () => {
    if (sid) clearCompiledIntent(sid);
  };

  return (
    <section className="chapter-review" role="region" aria-label={t('agent.reviewTitle')}>
      <header className="chapter-review-header">
        <strong>{t('agent.reviewTitle')}</strong>
        <span className="chapter-review-stage" data-stage={stage}>{stageLabel}</span>
        {anyInFlight ? (
          <span className="chapter-review-resuming">{intentCompiling ? t('agent.intentCompiling') : t('agent.reviewResuming')}</span>
        ) : null}
      </header>

      {isSuspended && suspension ? (
        // dogfood R2 #83/#84：写前挂起说明卡（出发核查矛盾/偏离——#83 拍板「该场景走 leader 翻译+
        // 补丁+确认+重跑环，不弹审阅卡」的最低成本形态：无正文区、无选区精修、只 redo/abort）。
        // 明细文案 mirror write-chapter.ts formatResearchSuspensionDetail 的逐条形态（机械投影）。
        <div className="chapter-review-suspension" role="region" aria-label={t('agent.suspensionTitle')}>
          <p className="chapter-review-suspension-hint">
            {suspension.kind === 'verify_exhausted'
              ? t('agent.suspensionHintExhausted', { rounds: suspension.rounds })
              : t('agent.suspensionHintContradiction')}
          </p>
          <ul className="chapter-review-suspension-list">
            {(suspension.kind === 'verify_exhausted' ? suspension.gaps ?? [] : []).map((g, i) => (
              <li key={`gap-${i}`}>{t('agent.suspensionGapItem', { desc: g.desc, hint: g.source_hint })}</li>
            ))}
            {(suspension.kind === 'research_contradiction' ? suspension.evidence?.contradictions ?? [] : []).map((c, i) => (
              <li key={`contradiction-${i}`}>{t('agent.suspensionContradictionItem', { desc: c.desc })}</li>
            ))}
            {(suspension.kind === 'research_contradiction' ? suspension.evidence?.deviations ?? [] : []).map((d, i) => (
              <li key={`deviation-${i}`}>
                {t('agent.suspensionDeviationItem', {
                  scene: d.scene_ref,
                  plan: d.plan_says,
                  brief: d.brief_says,
                  reason: d.reason,
                })}
              </li>
            ))}
          </ul>
          <p className="chapter-review-suspension-note">{t('agent.suspensionNote')}</p>
        </div>
      ) : isDraft ? (
        draftContent ? (
          <div className="chapter-review-draft">
            {/* Story 7.1 B1：换 TipTap 只读 editor——支持选区监听（onSelectionChange），产出 SelectionInfo
                → 选区指挥精修入口。editable={false} 禁编辑（防用户改 checkpoint snapshot），保留 selection。 */}
            <TiptapEditor
              content={draftContent}
              format="markdown"
              editable={false}
              disableFind
              onSelectionChange={(sel) => { if (sid) setReviewSelection(sid, sel); }}
            />
            <p className="chapter-review-meta">{t('agent.reviewWordCount', { count: wordCount })}</p>
          </div>
        ) : (
          <p className="chapter-review-empty">{t('agent.reviewEmpty')}</p>
        )
      ) : stage === 'brief' ? (
        briefDisplay ? (
          <pre className="chapter-review-brief-content">{briefDisplay}</pre>
        ) : (
          <p className="chapter-review-empty">{t('agent.reviewEmpty')}</p>
        )
      ) : isRevisionGuard ? (
        // Story 7.2 art-mode 卡（design §1.5）：revision-guard soft-violation pause。
        // revisionGuard 必在（slice metadataFromPausedSummary 保证），TS optional → 守卫消费。
        revisionGuard ? (
          <div
            className="chapter-review-intent-card chapter-review-guard-card"
            role="region"
            aria-label={t('agent.reviewStageRevisionGuard')}
          >
            <h4 className="chapter-review-intent-card-title">{t('agent.reviewStageRevisionGuard')}</h4>
            <p className="chapter-review-meta chapter-review-guard-hint">{t('agent.guardCardHint')}</p>
            {revisionGuard.summary ? (
              <p className="chapter-review-guard-summary">{revisionGuard.summary}</p>
            ) : null}

            {revisionGuard.beforeText != null && revisionGuard.afterText != null ? (
              // Story 7.5：before/after 从两个 <pre> 升级为词级 diff（GitHub 式一眼看出 AI 漂移改了什么）。
              // readonly = 纯展示（卡级 force-accept/abort 在下方按钮，非 diff 内逐行 accept/reject）。
              // BMad CR Blind-004：保留「你的原稿 / AI 改的」语义标注（此卡核心 = 识别 AI 漂移，谁写的 是关键信号），
              // 经 leftLabel/rightLabel 传入（非通用 original/modified）。单侧 null 不渲染（Edge-007：避免单边 diff 误导）。
              <SideBySideDiff
                readonly
                oldContent={revisionGuard.beforeText}
                newContent={revisionGuard.afterText}
                fileName={t('agent.guardPassageLabel')}
                leftLabel={t('agent.guardBeforeLabel')}
                rightLabel={t('agent.guardAfterLabel')}
              />
            ) : null}
            {/* 09-13 子3 W5（design §4.2）：锚外零改动说明——diff 只覆盖锚定段落，其余正文未动。 */}
            <p className="chapter-review-meta chapter-review-guard-anchor-note">{t('agent.guardAnchorNote')}</p>

            <div className="chapter-review-intent-field">
              <strong>{t('agent.guardFindingsLabel')}</strong>
              {(revisionGuard.findings ?? []).length === 0 ? (
                <span className="chapter-review-intent-locked-empty">{t('agent.guardNoFindings')}</span>
              ) : (
                /* Story 3.7 #4（design D6）：per-finding InsightCard——纯展示降级卡（无 onApply/onIgnore：
                   per-finding 无执行语义，卡级三档才是决策单位）；无 severity 字段 → 中性色条（不造数据）。
                   title = pattern 标签+violatedScope（词表内标签/词表外原文，语义分类归 L2 非 UI 门禁）；
                   dimension = pattern 原文（与 title 不重复）；grounding before/after 体积大仅展开态
                   （InsightCard 契约：折叠态紧凑行只在有 quote 时显示）。 */
                <ul className="chapter-review-guard-findings">
                  {(revisionGuard.findings ?? []).map((finding, idx) => (
                    <li key={idx}>
                      <InsightCard
                        title={`${GUARD_DRIFT_PATTERN_LABELS_ZH[finding.pattern] ?? finding.pattern}：${finding.violatedScope}`}
                        source="agent.insight.sourceRevisionGuard"
                        dimension={finding.pattern}
                        grounding={{ before: finding.evidence.before, after: finding.evidence.after }}
                      >
                        {finding.evidence.explanation ? (
                          <div className="chapter-review-guard-finding-explanation">
                            {finding.evidence.explanation}
                          </div>
                        ) : null}
                      </InsightCard>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="chapter-review-intent-actions chapter-review-guard-actions">
              <button
                type="button"
                className="chapter-review-intent-confirm-btn primary chapter-review-guard-force-btn"
                onClick={() => void forceAcceptGuard(sid ?? undefined)}
                disabled={anyInFlight}
              >
                {t('agent.guardForceAccept')}
              </button>
              <button
                type="button"
                className="chapter-review-intent-edit-btn chapter-review-guard-revise-btn"
                onClick={() => void reviewAbort(sid ?? undefined)}
                disabled={anyInFlight}
                title={t('agent.guardReviseHint')}
              >
                {t('agent.guardReviseInstruction')}
              </button>
              <button
                type="button"
                className="chapter-review-intent-cancel-btn chapter-review-guard-cancel-btn"
                onClick={() => void reviewAbort(sid ?? undefined)}
                disabled={anyInFlight}
              >
                {t('agent.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <p className="chapter-review-empty">{t('agent.reviewEmpty')}</p>
        )
      ) : (
        // verdict stage：4.6 PatchReview 是 verdict 的结构化审阅入口（本面板不重复）。
        <p className="chapter-review-verdict-hint">{t('agent.reviewVerdictHint')}</p>
      )}

      {/* Story 7.1 B1：draft stage 选区指挥精修面板（design §4.2）。 */}
      {isDraft && reviewSelection && reviewSelection.text ? (
        <div className="chapter-review-selection-box">
          <p className="chapter-review-selection-hint">{t('agent.selectionHint')}</p>
          <pre className="chapter-review-selection-quote">{reviewSelection.text}</pre>
          <textarea
            className="chapter-review-instruction-input"
            value={instructionInput}
            onChange={(e) => setInstructionInput(e.target.value)}
            placeholder={t('agent.instructionInputPlaceholder')}
            disabled={anyInFlight}
            rows={3}
          />
          <div className="chapter-review-selection-actions">
            <button
              type="button"
              className="chapter-review-compile-btn primary"
              onClick={handleCompileIntent}
              disabled={anyInFlight || !instructionInput.trim()}
            >
              {t('agent.compileIntent')}
            </button>
            <button
              type="button"
              className="chapter-review-clear-selection-btn"
              onClick={() => { if (sid) setReviewSelection(sid, null); }}
              disabled={anyInFlight}
            >
              {t('agent.clearSelection')}
            </button>
          </div>
        </div>
      ) : null}

      {/* Story 7.1 B1：编译失败提示（graceful，不假信心不静默 fail）。 */}
      {isDraft && intentCompileError ? (
        <p className="chapter-review-intent-error">{t('agent.intentCompileFailed', { error: intentCompileError })}</p>
      ) : null}

      {/* Story 7.1 B1：RevisionIntent 确认卡片（design §1[3] / §4.2）。W5 提取共用组件
          （RevisionIntentConfirmCard——draft 精修与终稿卡指令精修两消费面，DOM/类名/键名零变更）。 */}
      {isDraft && compiledIntent ? (
        <RevisionIntentConfirmCard
          compiledIntent={compiledIntent}
          inFlight={anyInFlight}
          onConfirm={handleConfirmIntent}
          onCancel={handleCancelCompiled}
        />
      ) : null}

      {/* C trigger（redo 反馈升级 defer 7.1；现有路径保留——design §0）：textarea + Redo 按钮。
          W5（D-c 意见必填）：挂起/brief 的 redo 意见必填（空意见禁用——placeholder 引导方向）；
          legacy draft 维持可选。 */}
      {isDraft || isSuspended || isBrief ? (
        <div className="chapter-review-feedback-block">
          <textarea
            className="chapter-review-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t(
              isSuspended ? 'agent.suspensionRedoPlaceholder'
                : isBrief ? 'agent.briefRedoPlaceholder'
                  : 'agent.reviewRedoFeedback',
            )}
            disabled={anyInFlight}
            rows={3}
          />
          {redoRequired && redoFeedbackEmpty ? (
            <p className="chapter-review-feedback-required">{t('agent.reviewRedoRequired')}</p>
          ) : null}
        </div>
      ) : null}

      {/* Story 7.2：revision-guard art-mode 卡自带三档按钮（强行放行/改指令/取消），不重复默认 actions。 */}
      {/* dogfood R2 #83/#84：按钮由 resumeOptions 驱动——挂起卡 ['redo','abort']（无「继续写」：挂起无正文
          可续且不带偏离批准，continue 是死循环入口）；真 checkpoint 三钮照旧。redo 在 draft 审阅与挂起
          决断两态都给（挂起 redo = 维持原案/带指令重跑——章档案 approvedDeviations 机制使已亮牌偏离
          不再挂起，writer-node 单源）。W5：brief 亦给 redo（打回规划环——shell 侧 isPlanLoopPause 切
          brief-compiler 重编）。 */}
      {!isRevisionGuard ? (
        <div className="chapter-review-actions">
          {/* check 补：!isSuspended 双 belt——挂起卡恒无「继续写」不只靠上游载荷卫生（agentEvents 缺省
              回退三钮 / 旧回放载荷均可能带 continue），渲染层结构性封死 #84 死循环入口。 */}
          {/* W5：'accept' 钮随 final 分支迁 FinalReviewCard（本面板 stage 恒非 final——旧载荷防御位
              不再渲染 accept）。 */}
          {options.includes('continue') && !isSuspended ? (
            <button
              type="button"
              className="chapter-review-continue-btn primary"
              onClick={() => void reviewContinue(sid ?? undefined)}
              disabled={anyInFlight}
            >
              {t('agent.reviewContinue')}
            </button>
          ) : null}
          {options.includes('redo') && (isDraft || isSuspended || isBrief) ? (
            <button
              type="button"
              className="chapter-review-redo-btn"
              onClick={handleRedo}
              disabled={anyInFlight || (redoRequired && redoFeedbackEmpty)}
            >
              {isBrief ? t('agent.briefRedo') : t('agent.reviewRedo')}
            </button>
          ) : null}
          {options.includes('abort') ? (
            <button
              type="button"
              className="chapter-review-abort-btn"
              onClick={() => void reviewAbort(sid ?? undefined)}
              disabled={anyInFlight}
            >
              {t('agent.reviewAbort')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
