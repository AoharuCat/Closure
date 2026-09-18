import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ChapterReviewMetadata } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { ChainRunState } from '../../shared/store/chainStreamBuffer';
import type { ChainTimelineState, EscalateFindingsEntry } from '../../shared/store/chainTimeline';
import { ChainTimelineFeed } from './ChainTimeline';
import { ChapterReviewPanel } from './ChapterReviewPanel';
import { EscalateAdjudicationCard } from './EscalateAdjudicationCard';
import { FinalReviewCard } from './FinalReviewCard';
import { PENDING_PAUSE_WINDOW_MS, resolveReviewPauseKind } from './reviewPhase';

/**
 * 09-13 子3 W5（design §1.3/§4）：写作页审阅相位容器——主区双相位的 review 侧。
 *
 * 结构：ReviewTopBar（暂停理由 pill + 章名 + 收敛信息〔final〕+ 「▤ 时间线」侧抽屉开关 +
 * 「收起审阅」手动出口）+ 卡片区（形态随 pauseKind 切换——resolveReviewPauseKind 派生：
 * final=FinalReviewCard / escalate=EscalateAdjudicationCard / brief·挂起·护栏·draft=
 * ChapterReviewPanel 既有形态 / stub=降级卡）+ 时间线侧抽屉（320px，复用 ChainTimelineFeed
 * 紧凑回看——投影层零新逻辑）。
 *
 * stub 链降级卡（design §1.3「dogfood 直跑链」）：paused 无 pausedReview/escalateFindings
 * 条目 → 裸动作钮卡（继续/放弃——mirror AgentMessages handleChainResume 兜底，但走 slice
 * reviewContinue/reviewAbort：和解除（busy toast/被动中断保留/下一 checkpoint 建卡）比裸
 * handler 完备）。
 *
 * 「收起审阅」= 手动优先语义的出口（writingPageSlice.writingPhase='run'）——链仍 paused 不
 * 反复强切（上升沿触发见 WritingPage 相位机 effect）。
 */
export function ReviewPhaseView({ sessionId, run, timeline, chapterTitle }: {
  sessionId: string;
  run: ChainRunState | undefined;
  timeline: ChainTimelineState | undefined;
  chapterTitle: string | null;
}) {
  const {
    pausedReview,
    escalateFindings,
    setWritingPhase,
    reviewContinue,
    reviewAbort,
    reviewResuming,
    resolvedLocale,
  } = useAppStore(useShallow((s) => ({
    pausedReview: s.pausedReviewBySession[sessionId] as ChapterReviewMetadata | undefined,
    escalateFindings: s.escalateFindingsBySession[sessionId] as EscalateFindingsEntry | undefined,
    setWritingPhase: s.setWritingPhase,
    reviewContinue: s.reviewContinue,
    reviewAbort: s.reviewAbort,
    reviewResuming: s.reviewResumingBySession[sessionId] === true,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // CR-10（09-18 CR 批 B）：pending 窗（两键皆缺但刚转 paused——chapter_review metadata 在途）
  // 过期后重投影降 stub。一次性定时器驱动（挂一次性 8s 重渲不犯 CR-16b 的每秒重渲病）。
  const [nowMs, setNowMs] = useState(() => Date.now());
  const kind = resolveReviewPauseKind({
    paused: run?.status === 'paused',
    pausedReview,
    escalateFindings,
    pausedUpdatedAt: run?.updatedAt,
    now: nowMs,
  });
  const pendingWindow = kind === 'pending';
  useEffect(() => {
    if (!pendingWindow) return;
    const waitMs = Math.max(50, (run?.updatedAt ?? 0) + PENDING_PAUSE_WINDOW_MS - Date.now() + 50);
    const timer = setTimeout(() => setNowMs(Date.now()), waitMs);
    return () => clearTimeout(timer);
  }, [pendingWindow, run?.updatedAt]);

  if (kind === null) return null; // 未 paused（相位机下降沿将回 run——防御位）

  const kindLabelKey = `writing.review.pauseKind.${kind}`;
  const summary = kind === 'final' ? pausedReview?.reviewSummary : undefined;

  return (
    <div className="writing-review" data-writing-review data-review-kind={kind}>
      <header className="writing-review-top">
        <span className="writing-review-pill" data-review-kind={kind}>{t(kindLabelKey)}</span>
        <strong className="writing-review-title">{chapterTitle ?? t('writing.run.fallbackTitle')}</strong>
        {summary ? (
          <span className="writing-review-converge">
            {t(summary.capExhausted ? 'writing.review.final.loopsCapped' : 'writing.review.final.loops', { n: summary.loopCount })}
          </span>
        ) : null}
        <span className="writing-final-grow" />
        <button
          type="button"
          className="writing-review-tl-toggle"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-expanded={drawerOpen}
        >
          {t('writing.review.tlToggle')}
        </button>
        <button
          type="button"
          className="writing-review-collapse"
          onClick={() => setWritingPhase('run')}
        >
          {t('writing.review.collapse')}
        </button>
      </header>

      <div className="writing-review-body">
        {kind === 'final' ? (
          /* 终稿卡自管滚动（编辑区滚 + 动作条钉底）——不进 scroll 层。 */
          <div className="writing-review-card">
            <FinalReviewCard sessionId={sessionId} chapterTitle={chapterTitle} />
          </div>
        ) : (
          <div className="writing-review-card">
            <div className="writing-review-scroll">
              {kind === 'escalate' ? (
                <EscalateAdjudicationCard sessionId={sessionId} />
              ) : kind === 'pending' ? (
                // CR-10：临时 pending 占位（chapter_review metadata 在途——生产链哨兵 paused 帧
                // 先于 metadata 到达的传输窗；stub 卡瞬闪防）。超窗降 stub（上方定时器重投影）。
                <section className="writing-stub" data-stub-review="pending" role="status" aria-label={t('writing.review.pauseKind.pending')}>
                  <h4 className="writing-stub-title">{t('writing.review.pauseKind.pending')}</h4>
                  <p className="writing-stub-body">{t('writing.review.pending.body')}</p>
                </section>
              ) : kind === 'stub' ? (
                // stub 链降级卡：无审阅载荷（直跑链车道）——pauseKind 事件字段不持久化，理由显
                // 通用「已暂停」+ 裸动作钮。
                <section className="writing-stub" data-stub-review role="region" aria-label={t('writing.review.stub.title')}>
                  <h4 className="writing-stub-title">{t('writing.review.stub.title')}</h4>
                  <p className="writing-stub-body">{t('writing.review.stub.body')}</p>
                  {reviewResuming ? <span className="writing-escalate-resuming">{t('agent.reviewResuming')}</span> : null}
                  <div className="writing-stub-actions">
                    <button
                      type="button"
                      className="writing-final-btn writing-final-btn--primary"
                      onClick={() => void reviewContinue(sessionId)}
                      disabled={reviewResuming}
                    >
                      {t('writing.review.stub.resume')}
                    </button>
                    <button
                      type="button"
                      className="writing-final-btn writing-final-btn--danger"
                      onClick={() => void reviewAbort(sessionId)}
                      disabled={reviewResuming}
                    >
                      {t('writing.review.stub.abort')}
                    </button>
                  </div>
                </section>
              ) : pausedReview ? (
                // brief / 挂起（suspension）/ 护栏（guard）/ legacy draft——ChapterReviewPanel 既有形态
                //（final 分支已迁 FinalReviewCard，此处 stage 恒非 final）。
                <ChapterReviewPanel sessionId={sessionId} />
              ) : null}
            </div>
          </div>
        )}

        {drawerOpen ? (
          <aside className="writing-review-drawer" data-review-drawer aria-label={t('writing.review.drawerTitle')}>
            <div className="writing-review-drawer-title">{t('writing.review.drawerTitle')}</div>
            <ChainTimelineFeed timeline={timeline} run={run} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
