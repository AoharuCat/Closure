/**
 * 并排对比视图（E10.2b W5，design §3 视图 3——mockup 定稿新形态组件）。
 *
 * merge_review 两方各半（craft-compare 两栏）：左 = newClaim 全载荷（condensed 四件套 +
 * 引文 + author + 词目/大类 + tags + 置信三档 chip）；右 = 既有卡（title + condensed +
 * 讲法展开——合并挂入后新讲法与这些并列）。相似度**保留原值**（纯代码测量——design §3
 * mockup 修订注记：与 LLM 自报置信的假精确不同）。
 *
 * 三动作（merge-review-resolve，AC3 专属用例）：并入（newClaim 挂讲法到既有卡——产物卡回
 * 待审）/ 分立（新建卡）/ 驳回（丢弃该主张留痕）。已裁决记录再 resolve = invalid-state
 * （服务端守卫，UI 错误 toast）。
 *
 * **CR-2b-8（既有卡 mid-run 删除死局——UI 半）**：getCraftCard 回 null（卡已删）→ 右栏
 * 「既有卡已被删除」错误态（不再永久转圈）+ 并入钮禁用（服务端对该组合必返 not-found）
 * ——引导读左栏新主张后改判分立/驳回。
 *
 * **CR-2b-D1（LLM 分歧预判展示）**：disputeHint 可选键二态纪律（在场 = 判定成功，缺省 =
 * 判定不可用）——dispute=true 置顶警示块（含 reason）；false 次要行；缺席灰色小字。
 *
 * 既有卡取数：组件本地 effect 调 getCraftCard（视图局部瞬态——不占 craftCardDetail 编辑槽，
 * mirror MaterialsPage 直调 api 先例）。
 */
import { useEffect, useState } from 'react';
import type { CraftCard, CraftMergeReview } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { Tooltip } from '../../shared/components/Tooltip';
import { getCraftCard } from '../../shared/api/craft';
import { craftConfidenceTier, craftRankLabelKey, termDisplay } from './craftView';

function ClaimList({ titleKey, items, t }: { titleKey: string; items: string[]; t: (k: string) => string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="materials-form-label">{t(titleKey)}</span>
      <ul className="materials-importlist">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function CraftMergeReviewView({ reviewId }: { reviewId: string }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const reviews = useAppStore((s) => s.craftMergeReviews);
  const terms = useAppStore((s) => s.craftTerms);
  const resolveCraftMergeReview = useAppStore((s) => s.resolveCraftMergeReview);
  const closeCraftMergeReview = useAppStore((s) => s.closeCraftMergeReview);
  const showToast = useToastStore((s) => s.showToast);
  const [existingCard, setExistingCard] = useState<CraftCard | null>(null);
  const [existingError, setExistingError] = useState<string | null>(null);
  /** 既有卡已删除（CR-2b-8——getCraftCard null ≠ 失败 ≠ 加载中：错误态 + 并入钮禁用）。 */
  const [existingMissing, setExistingMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const review: CraftMergeReview | undefined = reviews.find((r) => r.reviewId === reviewId);
  // 既有卡 id（dep 只按值——review 对象随清单刷新换引用，勿列对象本身防重取循环）。
  const existingCardId = review?.existingCardId ?? null;

  // 既有卡取数（视图局部瞬态——不占编辑详情槽）。null = 卡已删（CR-2b-8 错误态非转圈）。
  useEffect(() => {
    if (existingCardId === null) return;
    let cancelled = false;
    setExistingCard(null);
    setExistingError(null);
    setExistingMissing(false);
    getCraftCard(existingCardId)
      .then((card) => {
        if (cancelled) return;
        if (card === null) setExistingMissing(true);
        else setExistingCard(card);
      })
      .catch((err: unknown) => {
        if (!cancelled) setExistingError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [existingCardId]);

  if (review === undefined) {
    return (
      <div className="materials-page">
        <div className="materials-toolbar">
          <button type="button" className="materials-iconbtn" aria-label={t('craft.card.back')} onClick={closeCraftMergeReview}>
            <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
          </button>
        </div>
        <div className="materials-empty" data-craft-empty="review-gone">{t('craft.merge.reviewGone')}</div>
      </div>
    );
  }

  const tier = craftConfidenceTier(review.newClaim.confidence);
  const claim = review.newClaim.claim;

  const resolve = async (action: 'merge' | 'independent' | 'dismiss') => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await resolveCraftMergeReview({ reviewId, action });
      if (result.ok) {
        const toastKey =
          action === 'merge'
            ? 'craft.toast.mergeMerged'
            : action === 'independent'
              ? 'craft.toast.mergeIndependent'
              : 'craft.toast.mergeDismissed';
        showToast(t(toastKey), 'success');
        closeCraftMergeReview();
      } else {
        showToast(t('craft.toast.mergeFailed', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(t('craft.toast.mergeFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="materials-page" data-craft-review-view={reviewId}>
      <div className="materials-toolbar">
        <Tooltip label={t('craft.card.back')} placement="top">
          <button type="button" className="materials-iconbtn" aria-label={t('craft.card.back')} onClick={closeCraftMergeReview}>
            <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
          </button>
        </Tooltip>
        <h2 className="materials-title">{t('craft.merge.title')}</h2>
        {/* 相似度原值（纯代码测量值——保留原值显示，mockup 修订注记）。 */}
        <Tooltip label={t('craft.merge.similarityHint')} placement="top">
          <span className="materials-chip" data-craft-similarity={review.similarity.toFixed(2)}>
            {t('craft.merge.similarity', { value: review.similarity.toFixed(2) })}
          </span>
        </Tooltip>
        <span style={{ flex: 1 }} />
        {/* 并入需既有卡在位（CR-2b-8：卡已删时服务端必返 not-found——禁用引导分立/驳回）。 */}
        <button
          type="button"
          className="materials-browsebtn"
          disabled={busy || existingMissing}
          data-craft-action="merge"
          onClick={() => { void resolve('merge'); }}
        >
          {t('craft.merge.merge')}
        </button>
        <button type="button" className="materials-browsebtn" disabled={busy} data-craft-action="independent" onClick={() => { void resolve('independent'); }}>
          {t('craft.merge.independent')}
        </button>
        <button type="button" className="materials-browsebtn" disabled={busy} data-craft-action="dismiss" onClick={() => { void resolve('dismiss'); }}>
          {t('craft.merge.dismiss')}
        </button>
      </div>

      <div className="materials-listwrap">
        {/* LLM 分歧预判（CR-2b-D1）：在场 dispute=true 置顶警示块；在场 false 次要行；
            缺席 = 判定不可用灰色小字（可选键二态纪律——不写暗示已检查的标记）。 */}
        {review.disputeHint !== undefined && review.disputeHint.dispute && (
          <div
            className="craft-dispute-prediction craft-dispute-prediction--disputed"
            data-craft-dispute-hint="disputed"
          >
            {t('craft.merge.disputePredicted', { reason: review.disputeHint.reason })}
          </div>
        )}
        {review.disputeHint !== undefined && !review.disputeHint.dispute && (
          <div
            className="craft-dispute-prediction craft-dispute-prediction--clean"
            data-craft-dispute-hint="no-dispute"
          >
            {t('craft.merge.noDispute')}
          </div>
        )}
        {review.disputeHint === undefined && (
          <div
            className="craft-dispute-prediction craft-dispute-prediction--unavailable"
            data-craft-dispute-hint="unavailable"
          >
            {t('craft.merge.disputeUnavailable')}
          </div>
        )}
        <div className="craft-compare">
          {/* 左：新主张（全载荷——三动作裁决依据）。 */}
          <div className="craft-compare-col craft-compare-col--new" data-craft-compare-side="new">
            <div className="materials-cell">
              <span className="materials-form-title">{t('craft.merge.newClaim')}</span>
              <span style={{ flex: 1 }} />
              <Tooltip label={t('craft.confidence.tooltip', { value: review.newClaim.confidence.toFixed(2) })} placement="top">
                <span className="materials-chip" data-craft-confidence={tier}>
                  {t(`craft.confidence.${tier}`)}
                </span>
              </Tooltip>
            </div>
            <div className="materials-cell">
              <span className="materials-chip materials-chip--muted">{t(`craft.category.${review.newClaim.category}`)}</span>
              <span className="materials-chip materials-chip--tier">{termDisplay(review.newClaim.termId, terms)}</span>
              <span className="materials-chip">{review.newClaim.author ?? t('craft.card.unknownAuthor')}</span>
            </div>
            <blockquote className="craft-compare-quote">{claim.condensed}</blockquote>
            <ClaimList titleKey="craft.card.points" items={claim.points} t={t} />
            <ClaimList titleKey="craft.card.scenarios" items={claim.scenarios} t={t} />
            <ClaimList titleKey="craft.card.counterexamples" items={claim.counterexamples} t={t} />
            <div className="materials-cell">
              {review.newClaim.tags.map((tag) => (
                <span key={tag} className="materials-chip">#{tag}</span>
              ))}
            </div>
            <blockquote className="craft-compare-quote" data-craft-new-quote={true}>{review.newClaim.quote}</blockquote>
          </div>

          {/* 右：既有卡（摘要 + 讲法展开——合并后新讲法与这些并列）。 */}
          <div className="craft-compare-col" data-craft-compare-side="existing">
            <div className="materials-cell">
              <span className="materials-form-title">{t('craft.merge.existing')}</span>
              <span style={{ flex: 1 }} />
              {existingCard !== null && (
                <span
                  className={`materials-badge ${
                    existingCard.status === 'pending_review'
                      ? 'materials-badge--amber'
                      : existingCard.status === 'rejected'
                        ? 'materials-badge--danger'
                        : 'materials-badge--ok'
                  }`}
                  data-craft-status={existingCard.status}
                >
                  {t(`craft.status.${existingCard.status}`)}
                </span>
              )}
            </div>
            {existingError !== null && (
              <div className="materials-form-error">{t('craft.list.error', { message: existingError })}</div>
            )}
            {/* CR-2b-8：既有卡已删——错误态替代永久转圈（读左栏新主张改判分立/驳回）。 */}
            {existingMissing && (
              <div className="materials-form-error" data-craft-existing-gone="true">
                {t('craft.merge.existingGone')}
              </div>
            )}
            {existingCard === null && existingError === null && !existingMissing && (
              <div className="materials-form-loading">{t('craft.list.loading')}</div>
            )}
            {existingCard !== null && (
              <>
                <div className="materials-cell">
                  <span className="materials-name">{existingCard.title}</span>
                </div>
                <div className="materials-cell">
                  <span className="materials-chip materials-chip--muted">{t(`craft.category.${existingCard.category}`)}</span>
                  <span className="materials-chip materials-chip--tier">{termDisplay(existingCard.termId, terms)}</span>
                </div>
                <blockquote className="craft-compare-quote">{existingCard.claim.condensed}</blockquote>
                <ClaimList titleKey="craft.card.points" items={existingCard.claim.points} t={t} />
                <ClaimList titleKey="craft.card.scenarios" items={existingCard.claim.scenarios} t={t} />
                <ClaimList titleKey="craft.card.counterexamples" items={existingCard.claim.counterexamples} t={t} />
                <div className="materials-cell">
                  {existingCard.tags.map((tag) => (
                    <span key={tag} className="materials-chip">#{tag}</span>
                  ))}
                </div>
                {existingCard.teachings.map((teaching) => (
                  <div key={teaching.teachingId} className="craft-teaching" data-craft-teaching={teaching.teachingId}>
                    <div className="materials-cell">
                      <span className="materials-chip materials-chip--tier">
                        {teaching.author ?? t('craft.card.unknownAuthor')}
                      </span>
                      {teaching.stale && (
                        <span className="materials-badge materials-badge--amber" data-craft-stale="true">
                          {t('craft.badge.stale')}
                        </span>
                      )}
                      <span style={{ flex: 1 }} />
                      <span className="materials-chip materials-chip--muted">{t(craftRankLabelKey(teaching.rank))}</span>
                    </div>
                    <blockquote className="craft-compare-quote">{teaching.quote}</blockquote>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
