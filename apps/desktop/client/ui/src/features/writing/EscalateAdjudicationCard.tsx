import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { EscalateFindingsEntry } from '../../shared/store/chainTimeline';
import { findingToneOf, severityLabel } from './chainTimelineView';
import { synthesizeEscalateFeedback } from './reviewPhase';

/**
 * 09-13 子3 W5（design §4.2 / D-d）：escalate 灰区裁决卡——写作页审阅相位的 escalate 形态。
 *
 * **数据源 = `escalateFindingsBySession[sid]`**（F5 定谳：escalate-pause 非 stage pause、不产
 * pausedReview——勿读 chapter_review metadata）。写入方两路：dispatcher metadata.findings 松散
 * 通道（write-chapter.ts 裁决载荷）+ resume IPC summary fallback（chapterReviewSlice）。
 *
 * 逐条三态勾选（接受为真相 / 修订 / 忽略）+ 补充说明框（可选）：
 * - **勾选即意见**：合成结构化 feedback（「#N [quote 摘] 接受为真相；#M …修订」——synthesizeEscalateFeedback
 *   单源，中文固定串：LLM 载荷非 UI 铬件）。
 * - **路由**：含修订 → reviewRedo(合成 feedback)；全接受 → reviewAcceptFinal（resume action='accept'
 *   ——escalate-pause 下 shell 侧 isFinalAccept 直落 + StoryDecision 自动登记 escalate_accepted〔deviation
 *   =true 时，buildAcceptStoryDecisions 单源——实测核实，UI 零登记代码〕）；全部未勾或全忽略 →
 *   提交禁用（不给 AI 任何处置信息 = 无效裁决）。
 * - **无「信任自决」钮**（D-h 拍板：handleEscalateAutoTrust 是 auto 档链内自动逻辑，无 UI 通道——
 *   defer 记档）。另有放弃（abort）。
 */
type EscalatePick = 'accept' | 'revise' | 'ignore';

export function EscalateAdjudicationCard({ sessionId }: { sessionId: string }) {
  const {
    entry,
    reviewResuming,
    reviewAcceptFinal,
    reviewRedo,
    reviewAbort,
    resolvedLocale,
  } = useAppStore(useShallow((s) => ({
    entry: s.escalateFindingsBySession[sessionId] as EscalateFindingsEntry | undefined,
    reviewResuming: s.reviewResumingBySession[sessionId] === true,
    reviewAcceptFinal: s.reviewAcceptFinal,
    reviewRedo: s.reviewRedo,
    reviewAbort: s.reviewAbort,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);
  const [picks, setPicks] = useState<Record<number, EscalatePick | undefined>>({});
  const [supplement, setSupplement] = useState('');

  if (!entry || entry.items.length === 0) return null;

  const items = entry.items;
  const acceptCount = items.filter((_, i) => picks[i] === 'accept').length;
  const reviseCount = items.filter((_, i) => picks[i] === 'revise').length;
  const decided = acceptCount + reviseCount;
  const inFlight = reviewResuming;

  const pick = (idx: number, choice: EscalatePick) => {
    setPicks((prev) => {
      const next = { ...prev };
      // 再点同钮 = 取消勾选（三态互斥 + 可回退未勾）。
      if (next[idx] === choice) delete next[idx];
      else next[idx] = choice;
      return next;
    });
  };

  const handleSubmit = () => {
    if (decided === 0 || inFlight) return;
    // CR-5：合成 feedback 无条件先行——含修订走 redo；全接受也携带（supplement 非空时并入了
    // 用户补充说明，不接受静默丢输入；空勾选全接受时 feedback 为空串 → 载荷不带）。
    const feedback = synthesizeEscalateFeedback(
      items,
      items.map((_, i) => picks[i]),
      supplement,
    );
    if (reviseCount > 0) {
      void reviewRedo(feedback, sessionId);
    } else {
      // 全接受：resume accept（无 editedDraft——escalate 无终稿编辑面）+ feedback（含 supplement）。
      void reviewAcceptFinal(undefined, sessionId, feedback || undefined);
    }
  };

  return (
    <section
      className="writing-escalate"
      role="region"
      aria-label={t('writing.review.escalate.title')}
      data-escalate-review
    >
      <header className="writing-escalate-head">
        <span className="writing-escalate-tag">ESCALATE</span>
        <strong className="writing-escalate-title">{t('writing.review.escalate.title')}</strong>
        {inFlight ? <span className="writing-escalate-resuming">{t('agent.reviewResuming')}</span> : null}
      </header>
      <p className="writing-escalate-hint">{t('writing.review.escalate.hint')}</p>
      {entry.route ? <p className="writing-escalate-route">{t('writing.review.escalate.route', { route: entry.route })}</p> : null}

      <div className="writing-escalate-items">
        <div className="writing-escalate-items-title">
          {t('writing.review.escalate.itemsTitle')}
          <span className="writing-escalate-count">{t('writing.review.escalate.itemsCount', { n: items.length })}</span>
        </div>
        <ul className="writing-escalate-list">
          {items.map((item, idx) => {
            const tone = findingToneOf(item.severity);
            const current = picks[idx];
            return (
              <li key={idx} className="writing-escalate-pick" data-pick={current ?? 'none'}>
                <div className="writing-escalate-fx">
                  <span className={`writing-finding-sev writing-finding-sev--${tone}`}>
                    {severityLabel(item.severity, t)}
                  </span>
                  <span className="writing-escalate-note">
                    {item.subClass ? <b>{item.subClass}</b> : null}
                    {item.subClass && item.explanation ? ' —— ' : ''}
                    {item.explanation}
                    <span className="writing-finding-quote">「{item.quote}」</span>
                    {item.location ? <span className="writing-escalate-loc">{item.location}</span> : null}
                  </span>
                </div>
                <div className="writing-escalate-pc" role="group" aria-label={`#${idx + 1}`}>
                  {(['accept', 'revise', 'ignore'] as const).map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      className={`writing-escalate-pc-btn writing-escalate-pc-btn--${choice}${current === choice ? ' is-on' : ''}`}
                      onClick={() => pick(idx, choice)}
                      disabled={inFlight}
                      aria-pressed={current === choice}
                    >
                      {t(`writing.review.escalate.pick.${choice}`)}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <textarea
        className="writing-escalate-supplement"
        value={supplement}
        onChange={(e) => setSupplement(e.target.value)}
        placeholder={t('writing.review.escalate.supplementPlaceholder')}
        disabled={inFlight}
        rows={2}
      />

      <footer className="writing-escalate-actions">
        {decided === 0 ? (
          <span className="writing-escalate-hint-note">{t('writing.review.escalate.submitDisabledHint')}</span>
        ) : null}
        <span className="writing-final-grow" />
        <button
          type="button"
          className="writing-final-btn writing-final-btn--danger"
          onClick={() => void reviewAbort(sessionId)}
          disabled={inFlight}
        >
          {t('writing.review.escalate.abort')}
        </button>
        <button
          type="button"
          className="writing-final-btn writing-final-btn--primary"
          onClick={handleSubmit}
          disabled={inFlight || decided === 0}
        >
          {t('writing.review.escalate.submit')}
          {t('writing.review.escalate.submitCounts', { accept: acceptCount, revise: reviseCount })}
        </button>
      </footer>
    </section>
  );
}
