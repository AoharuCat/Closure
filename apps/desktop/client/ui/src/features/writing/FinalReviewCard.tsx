import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ChapterReviewMetadata } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { TiptapEditor } from '../editor/TiptapEditor';
import { countChars } from './chainTimelineView';
import { countEditRegions } from './reviewPhase';
import { RevisionIntentConfirmCard } from './RevisionIntentConfirmCard';

/**
 * 09-13 子3 W5（design §4.1 + mockup §2）：终稿审阅卡（stage='final' 全幅）——写作页审阅相位
 * 的终稿形态，自 ChapterReviewPanel final 分支升级迁出（面板 interim 只读形态退役）。
 *
 * - **编辑器**：TiptapEditor editable + markdown + 查找（disableFind 不设）+ 字数实时重算
 *   （countChars 非空白口径）；限宽 760 居中由 CSS（.writing-final-editor-wrap）承载。
 * - **手改追踪**：edited（本地）vs draftContent → countEditRegions 纯 UI 计数 → dirty 指示 +
 *   接受钮「携 N 处手改」；无变化不发送 editedDraft（IPC 无载荷 = 接受 AI 原稿）。
 *   手改清空正文（whitespace-only）→ 接受禁用 + 提示走放弃（contracts refine 空白串防线同源）。
 * - **自审摘要折叠区**：reviewSummary{verdict/reasons/loopCount/capExhausted} + lintReport
 *   digest pre 直出（degraded 占位串如实显示）；载荷缺席 → 「无自审摘要」如实行（不造数）。
 * - **动作**（design §4.1）：
 *   - 接受并继续 → slice `reviewAcceptFinal`（和解 slice 化——busy/中断/paused/完成收尾全在
 *     chapterReviewSlice，#105 done-probe 守卫经 reviewResuming 键同享）。
 *   - 打回重写 → 意见必填（D-c：空意见禁用提交——防修订方向偏移）+ 快捷理由 chips 点填 →
 *     `reviewRedo(feedback)`。
 *   - 放弃本章 → 确认弹层 → `reviewAbort`。
 * - **选区精修**（W4 键控 API 的新交互形态）：选中浮层「✎ 指令精修」→ 指令卡（quote 预填 +
 *   粗指令）→ compileIntent（draftText = 当前编辑器文本——选区 from/to 与 quote 同源对齐）→
 *   RevisionIntentConfirmCard（JSON 可编辑）→ confirmRedoWithIntent。
 * - **编辑器内容同步**：editable 编辑器不跟随 content prop（TiptapEditor F4 修复只盖 readonly）——
 *   pausedReview 对象引用变化（下一 checkpoint 重建 / redo 后新终稿）时 bump epoch 重挂编辑器
 *   + 清本地手改/面板态（新审阅轮次）。
 */
export function FinalReviewCard({ sessionId, chapterTitle }: { sessionId: string; chapterTitle: string | null }) {
  const {
    pausedReview,
    reviewResuming,
    reviewAcceptFinal,
    reviewRedo,
    reviewAbort,
    reviewSelection,
    compiledIntent,
    intentCompiling,
    intentCompileError,
    setReviewSelection,
    compileIntent,
    confirmRedoWithIntent,
    clearCompiledIntent,
    resolvedLocale,
  } = useAppStore(useShallow((s) => ({
    pausedReview: s.pausedReviewBySession[sessionId] as ChapterReviewMetadata | undefined,
    reviewResuming: s.reviewResumingBySession[sessionId] === true,
    reviewAcceptFinal: s.reviewAcceptFinal,
    reviewRedo: s.reviewRedo,
    reviewAbort: s.reviewAbort,
    reviewSelection: s.reviewSelectionBySession[sessionId],
    compiledIntent: s.compiledIntentBySession[sessionId],
    intentCompiling: s.intentCompilingBySession[sessionId] === true,
    intentCompileError: s.intentCompileErrorBySession[sessionId],
    setReviewSelection: s.setReviewSelection,
    compileIntent: s.compileIntent,
    confirmRedoWithIntent: s.confirmRedoWithIntent,
    clearCompiledIntent: s.clearCompiledIntent,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);

  // 本地态：手改文本（null = 未触碰）/ 打回面板 / 放弃确认 / 指令卡。
  const [edited, setEdited] = useState<string | null>(null);
  const [redoOpen, setRedoOpen] = useState(false);
  const [redoFeedback, setRedoFeedback] = useState('');
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [intentOpen, setIntentOpen] = useState(false);
  const [instructionInput, setInstructionInput] = useState('');
  const [editorEpoch, setEditorEpoch] = useState(0);

  // 新审阅轮次（pausedReview 引用变化）→ 编辑器重挂 + 本地面板态清（手改未提交视为丢弃）。
  const reviewRef = useRef(pausedReview);
  useEffect(() => {
    if (reviewRef.current === pausedReview) return;
    reviewRef.current = pausedReview;
    setEdited(null);
    setRedoOpen(false);
    setRedoFeedback('');
    setAbandonOpen(false);
    setIntentOpen(false);
    setInstructionInput('');
    setEditorEpoch((e) => e + 1);
  }, [pausedReview]);

  // 浮层 Esc 收口（指令卡/打回面板/放弃确认——mockup §2「Esc 取消」）。
  useEffect(() => {
    if (!intentOpen && !redoOpen && !abandonOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setIntentOpen(false);
      setRedoOpen(false);
      setAbandonOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [intentOpen, redoOpen, abandonOpen]);

  if (!pausedReview || pausedReview.stage !== 'final') return null;

  const draftContent = pausedReview.draftContent ?? '';
  const editedText = edited ?? draftContent;
  const editRegions = edited !== null ? countEditRegions(draftContent, edited) : 0;
  const dirty = edited !== null && edited !== draftContent;
  // 手改清空正文：accept 携 editedDraft 会被 contracts 空白串 refine 拒（CR-13）；不携则静默丢
  // 用户删除意图——两头都错，UI 侧禁用接受 + 指引走放弃（清空正文的正确出口）。
  const invalidEdit = dirty && editedText.trim().length === 0;
  const wordCount = countChars(editedText);
  const anyInFlight = reviewResuming || intentCompiling;

  const handleAccept = () => {
    if (anyInFlight || invalidEdit) return;
    // 无变化不发送 editedDraft（IPC action='accept' 无载荷 = 接受 AI 原稿——design §4.1）。
    void reviewAcceptFinal(dirty ? editedText : undefined, sessionId);
  };

  const handleRedoSubmit = () => {
    const fb = redoFeedback.trim();
    if (!fb) return; // D-c：空意见禁止提交（快捷理由 chips 点填引导）
    setRedoOpen(false);
    setRedoFeedback('');
    void reviewRedo(fb, sessionId);
  };

  const handleChip = (chip: string) => {
    // chips 点填：空则置入，非空则追加分号（多次点选累积方向）。
    setRedoFeedback((prev) => (prev.trim() === '' ? chip : `${prev.trim()}；${chip}`));
  };

  const handleCompileIntent = () => {
    const passage = reviewSelection?.text ?? '';
    const instr = instructionInput.trim();
    if (!passage || !instr) return;
    // draftText = 当前编辑器文本（选区 from/to 与 quote 出自同一 doc——锚构造同源对齐；
    // 手改后精修的 drift 由 quote 锚兜底）。
    void compileIntent(passage, instr, reviewSelection?.from ?? 0, reviewSelection?.to ?? 0, editedText, undefined, sessionId);
  };

  const handleConfirmIntent = () => {
    if (!compiledIntent) return;
    const intent = compiledIntent;
    setIntentOpen(false);
    setInstructionInput('');
    void confirmRedoWithIntent(intent, sessionId);
  };

  const handleCancelCompiled = () => {
    clearCompiledIntent(sessionId);
    setIntentOpen(false);
    setInstructionInput('');
  };

  const summary = pausedReview.reviewSummary;

  return (
    <section className="writing-final" role="region" aria-label={t('writing.review.final.title')} data-final-review>
      {/* ── 自审摘要折叠区（默认收起一行；degraded/缺席如实）── */}
      <details className="writing-final-summary">
        <summary>
          <span className="writing-final-summary-line">
            <span>{t('writing.review.final.summaryTitle')}</span>
            {summary ? (
              <>
                <span className="writing-final-summary-v">{summary.verdict}</span>
                <span>{t('writing.review.final.summaryReasons', { n: summary.reasons.length })}</span>
                {pausedReview.lintReport !== undefined ? (
                  <span>{t('writing.review.final.summaryLint')}</span>
                ) : null}
                <span className="writing-final-summary-loops">
                  {t(summary.capExhausted ? 'writing.review.final.loopsCapped' : 'writing.review.final.loops', { n: summary.loopCount })}
                </span>
              </>
            ) : (
              <span className="writing-final-summary-missing">{t('writing.review.final.summaryMissing')}</span>
            )}
          </span>
        </summary>
        <div className="writing-final-summary-body">
          {summary ? (
            <>
              <div><span className="k">{t('writing.review.final.summaryVerdictLabel')}</span>{summary.verdict}</div>
              {summary.reasons.length > 0 ? (
                <div>
                  <span className="k">{t('writing.review.final.summaryReasonsLabel')}</span>
                  <ul>
                    {summary.reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              ) : null}
              <div className="writing-final-summary-loops-line">
                {t(summary.capExhausted ? 'writing.review.final.loopsCapped' : 'writing.review.final.loops', { n: summary.loopCount })}
              </div>
            </>
          ) : (
            <div className="writing-final-summary-missing">{t('writing.review.final.summaryMissing')}</div>
          )}
          {pausedReview.lintReport !== undefined ? (
            <pre className="writing-final-lint">{pausedReview.lintReport}</pre>
          ) : null}
        </div>
      </details>

      {/* ── 编辑区（限宽 760 居中；滚动口在 wrap——编辑器自身不滚）── */}
      <div className="writing-final-editor-wrap">
        <div className="writing-final-editor">
          <h3 className="writing-final-doc-title">{chapterTitle ?? t('writing.run.fallbackTitle')}</h3>
          <p className="writing-final-doc-sub">{t('writing.review.final.docSub')}</p>
          <TiptapEditor
            key={editorEpoch}
            content={draftContent}
            format="markdown"
            editable
            onChange={(value) => { setEdited(value); }}
            onSelectionChange={(sel) => { setReviewSelection(sessionId, sel); }}
          />
        </div>
        {/* 选区浮层（sticky 钉编辑区底——选中即现，无选区/确认卡在场时退场）。 */}
        {reviewSelection && reviewSelection.text && !compiledIntent ? (
          <div className="writing-final-sel-float" role="toolbar" aria-label={t('writing.review.final.selectionBar')}>
            <button
              type="button"
              className="writing-final-sel-refine"
              onClick={() => setIntentOpen(true)}
              disabled={anyInFlight}
            >
              {t('writing.review.final.selectionRefine')}
            </button>
            <button
              type="button"
              onClick={() => { setReviewSelection(sessionId, null); setIntentOpen(false); }}
              disabled={anyInFlight}
            >
              {t('agent.clearSelection')}
            </button>
          </div>
        ) : null}
      </div>

      {/* ── 指令卡（选区精修粗指令——quote 预填 + 编译意图）── */}
      {intentOpen && !compiledIntent ? (
        <div className="writing-final-overlay writing-final-intent-card" role="region" aria-label={t('writing.review.final.intentCardTitle')}>
          <div className="writing-final-overlay-title">
            <span>{t('writing.review.final.intentCardTitle')}</span>
            <span className="writing-final-overlay-esc">{t('writing.review.final.escHint')}</span>
          </div>
          <pre className="writing-final-intent-quote">{reviewSelection?.text ?? ''}</pre>
          <textarea
            className="writing-final-intent-input"
            value={instructionInput}
            onChange={(e) => setInstructionInput(e.target.value)}
            placeholder={t('writing.review.final.intentPlaceholder')}
            disabled={anyInFlight}
            rows={3}
          />
          {intentCompileError ? (
            <p className="writing-final-intent-error">{t('agent.intentCompileFailed', { error: intentCompileError })}</p>
          ) : null}
          <div className="writing-final-overlay-actions">
            <button
              type="button"
              className="writing-final-btn writing-final-btn--ghost"
              onClick={() => { setIntentOpen(false); setInstructionInput(''); }}
              disabled={anyInFlight}
            >
              {t('agent.cancel')}
            </button>
            <button
              type="button"
              className="writing-final-btn writing-final-btn--primary"
              onClick={handleCompileIntent}
              disabled={anyInFlight || !instructionInput.trim()}
            >
              {intentCompiling ? t('agent.intentCompiling') : t('writing.review.final.compileIntent')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── RevisionIntent 确认卡（编译产物——JSON 可编辑；共用组件，draft stage 同源）── */}
      {compiledIntent ? (
        <div className="writing-final-overlay writing-final-confirm-slot">
          <RevisionIntentConfirmCard
            compiledIntent={compiledIntent}
            inFlight={anyInFlight}
            onConfirm={handleConfirmIntent}
            onCancel={handleCancelCompiled}
          />
        </div>
      ) : null}

      {/* ── 打回意见面板（D-c 意见必填——空意见禁用提交）── */}
      {redoOpen ? (
        <div className="writing-final-overlay writing-final-redo-panel" role="region" aria-label={t('writing.review.final.redoPanelTitle')}>
          <div className="writing-final-redo-title">
            {t('writing.review.final.redoPanelTitle')}
            <span className="writing-final-req">{t('writing.review.final.required')}</span>
          </div>
          <div className="writing-final-chip-row">
            {(['reason1', 'reason2', 'reason3', 'reason4'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className="writing-final-reason-chip"
                onClick={() => handleChip(t(`writing.review.final.${k}`))}
                disabled={anyInFlight}
              >
                {t(`writing.review.final.${k}`)}
              </button>
            ))}
          </div>
          <textarea
            className="writing-final-redo-input"
            value={redoFeedback}
            onChange={(e) => setRedoFeedback(e.target.value)}
            placeholder={t('writing.review.final.redoPlaceholder')}
            disabled={anyInFlight}
            rows={3}
          />
          <div className="writing-final-redo-foot">
            <span className={`writing-final-redo-hint${redoFeedback.trim() === '' ? ' writing-final-redo-hint--warn' : ''}`}>
              {redoFeedback.trim() === '' ? t('writing.review.final.redoRequiredHint') : t('writing.review.final.redoHint')}
            </span>
            <span className="writing-final-grow" />
            <button
              type="button"
              className="writing-final-btn writing-final-btn--ghost"
              onClick={() => { setRedoOpen(false); setRedoFeedback(''); }}
              disabled={anyInFlight}
            >
              {t('agent.cancel')}
            </button>
            <button
              type="button"
              className="writing-final-btn"
              onClick={handleRedoSubmit}
              disabled={anyInFlight || redoFeedback.trim() === ''}
            >
              {t('writing.review.final.redoSubmit')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 放弃确认弹层 ── */}
      {abandonOpen ? (
        <div className="writing-final-overlay writing-final-abandon" role="alertdialog" aria-label={t('writing.review.final.abandonTitle')}>
          <div className="writing-final-abandon-title">{t('writing.review.final.abandonTitle')}</div>
          <p className="writing-final-abandon-body">{t('writing.review.final.abandonBody')}</p>
          <div className="writing-final-overlay-actions">
            <button
              type="button"
              className="writing-final-btn writing-final-btn--ghost"
              onClick={() => setAbandonOpen(false)}
              disabled={anyInFlight}
            >
              {t('agent.cancel')}
            </button>
            <button
              type="button"
              className="writing-final-btn writing-final-btn--danger"
              onClick={() => { setAbandonOpen(false); void reviewAbort(sessionId); }}
              disabled={anyInFlight}
            >
              {t('writing.review.final.abandonConfirm')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 钉底动作条（backdrop-blur；字数 + dirty 指示 + 三动作）── */}
      <footer className="writing-final-actions">
        {reviewResuming ? <span className="writing-final-resuming">{t('agent.reviewResuming')}</span> : null}
        <span className="writing-final-wc">{t('agent.reviewWordCount', { count: wordCount })}</span>
        {invalidEdit ? (
          <span className="writing-final-dirty writing-final-dirty--invalid">{t('writing.review.final.invalidEdit')}</span>
        ) : dirty ? (
          <span className="writing-final-dirty">{t('writing.review.final.dirty')}</span>
        ) : null}
        <span className="writing-final-grow" />
        <button
          type="button"
          className="writing-final-btn writing-final-btn--ghost"
          onClick={() => setRedoOpen(true)}
          disabled={anyInFlight}
        >
          {t('writing.review.final.redo')}
        </button>
        <button
          type="button"
          className="writing-final-btn writing-final-btn--danger"
          onClick={() => setAbandonOpen(true)}
          disabled={anyInFlight}
        >
          {t('writing.review.final.abort')}
        </button>
        <button
          type="button"
          className="writing-final-btn writing-final-btn--primary"
          onClick={handleAccept}
          disabled={anyInFlight || invalidEdit}
        >
          {dirty && !invalidEdit
            ? t('writing.review.final.acceptWithEdits', { n: editRegions })
            : t('writing.review.final.accept')}
        </button>
      </footer>
    </section>
  );
}
