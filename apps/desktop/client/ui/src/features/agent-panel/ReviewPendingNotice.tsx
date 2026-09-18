import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';

/**
 * 09-13 子3 W4（design §5 / 拍板 D2+D-g）：对话栏审阅瘦身——轻量提示卡。
 *
 * 全尺寸审阅卡（ChapterReviewPanel 五形态 / chapter_candidate 落盘审阅）随审批迁移落写作页
 * 宽区；对话栏挂载位只留本提示（ChapterReviewPanel 的旧位 + pendingPatch 的 chapter_candidate
 * 过滤位）。
 *
 * 09-13 子3 W5（design §5.3）：跳转接线补全——setActivePage('writing') + setSelectedChainSessionId
 * （该链会话在 chainRunBySession 有键时选中——写作页观察链切到目标）+ chapter-review kind 额外
 * setWritingPhase('review')（直接进审阅相位；chapter-patch kind 不动相位——待落盘审阅挂相位区
 * 下方，两相位均可见）。
 *
 * 多张待审逐条挂载（AgentPanel 按各自判定渲染多个实例）；kind 区分两文案族：
 * - 'chapter-review'：写章链 checkpoint 暂停等待审阅（原 ChapterReviewPanel 挂载位）。
 * - 'chapter-patch'：链产出 chapter_candidate 待落盘（对话栏 patch 过滤位——D-g 切分）。
 *
 * 范式判据（ADR-3）：纯呈现 + 机械跳转，零语义判断。
 */
export type ReviewPendingNoticeKind = 'chapter-review' | 'chapter-patch';

export function ReviewPendingNotice({ kind, sessionId }: { kind: ReviewPendingNoticeKind; sessionId?: string | null }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const { t } = useI18n(resolvedLocale);
  const isReview = kind === 'chapter-review';

  const handleJump = () => {
    const s = useAppStore.getState();
    s.setActivePage('writing');
    // 目标链会话有 chainRun 键才写显式选择（键缺席 = 链已清——缺省项目锚解析即可，勿写失效指针）。
    if (sessionId && s.chainRunBySession[sessionId] !== undefined) {
      s.setSelectedChainSessionId(sessionId);
    }
    if (isReview) s.setWritingPhase('review');
  };

  return (
    <div className="review-pending-notice" role="status" data-review-pending-kind={kind}>
      <span className="material-symbols-outlined review-pending-notice-icon" aria-hidden="true">
        {isReview ? 'rate_review' : 'pending_actions'}
      </span>
      <div className="review-pending-notice-body">
        <strong className="review-pending-notice-title">
          {t(isReview ? 'agent.reviewPendingReviewTitle' : 'agent.reviewPendingPatchTitle')}
        </strong>
        <span className="review-pending-notice-text">
          {t(isReview ? 'agent.reviewPendingReviewBody' : 'agent.reviewPendingPatchBody')}
        </span>
      </div>
      <button
        type="button"
        className="review-pending-notice-jump"
        onClick={handleJump}
      >
        {t('agent.reviewPendingJump')}
      </button>
    </div>
  );
}
