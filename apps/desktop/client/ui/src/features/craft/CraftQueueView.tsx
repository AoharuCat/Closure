/**
 * 待阅队列视图（E10.2b W5，design §3 视图 1——mockup 定稿）。
 *
 * 结构：批量蒸馏入口（CR-2b-20——R9 批量队列的 UI 生产者：distill-status 清单驱动的
 * 「未蒸馏/蒸馏失败」材料一键入队；无可蒸馏材料置灰 + tooltip 诚实说明）/ 并排待决
 * （merge review pending——「有重复候选排前」的具象化：待决并排任务置顶呈现，点击进
 * 并排对比视图）/ 按材料分批卡组（组头 = 材料名 + 卡数 + 运行中相位徽章；组内低置信/
 * 分歧排前——排序单源 craftView.craftQueueCards）。
 *
 * 过滤（materialId + tags OR）作用于并排任务与卡组两段（材料页 N 卡跳转落点）。
 * 卡行/审阅行键盘可达（CR-2b-29——role="button" + tabIndex + Enter/Space）。
 */
import type { CraftCardSummary, CraftDistillProgressEvent, CraftMergeReview, CraftTerm } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { Tooltip } from '../../shared/components/Tooltip';
import {
  craftConfidenceTier,
  craftPhaseLabelKey,
  filterCraftCards,
  filterCraftMergeReviews,
  formatElapsedMs,
  groupCraftCardsByMaterial,
  craftQueueCards,
  termDisplay,
} from './craftView';
import { CraftCardRow } from './CraftCardRow';

export interface CraftQueueViewProps {
  cards: CraftCardSummary[];
  mergeReviews: CraftMergeReview[];
  terms: CraftTerm[];
  materialNames: Record<string, string>;
  progress: Record<string, CraftDistillProgressEvent>;
  tagFilter: string[];
  materialFilter: string | null;
  onOpenCard: (cardId: string) => void;
  onOpenReview: (reviewId: string) => void;
  onToggleTag: (tag: string) => void;
  /** 批量蒸馏目标清单（CR-2b-20——未蒸馏/蒸馏失败且材料就绪；空 = 按钮置灰）。 */
  batchTargets: string[];
  /** 批量入队在途（防重复点击）。 */
  batchBusy: boolean;
  /** 批量入队（编排归 CraftPage——craftDistillRun + toast + 台账回读）。 */
  onBatchDistill: () => void;
}

export function CraftQueueView({
  cards,
  mergeReviews,
  terms,
  materialNames,
  progress,
  tagFilter,
  materialFilter,
  onOpenCard,
  onOpenReview,
  onToggleTag,
  batchTargets,
  batchBusy,
  onBatchDistill,
}: CraftQueueViewProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const filter = { tags: tagFilter, materialId: materialFilter ?? undefined };
  const pendingReviews = filterCraftMergeReviews(mergeReviews, filter);
  const queueCards = craftQueueCards(filterCraftCards(cards, filter), mergeReviews);
  const groups = groupCraftCardsByMaterial(queueCards);

  const materialLabel = (materialId: string | null): string => {
    if (materialId === null) return t('craft.queue.unlinkedMaterial');
    return materialNames[materialId] ?? `${materialId.slice(0, 8)}…`;
  };

  const runningBadge = (materialId: string | null) => {
    if (materialId === null) return null;
    const live = progress[materialId];
    if (live === undefined || (live.status !== 'running' && live.status !== 'pending')) return null;
    if (live.status === 'pending') {
      return (
        <span className="materials-badge materials-badge--amber" data-craft-distill-phase="pending">
          {t('craft.distill.pendingBadge')}
        </span>
      );
    }
    return (
      <Tooltip
        label={t('craft.distill.runningTooltip', {
          phase: t(craftPhaseLabelKey(live.phase ?? 'extracting')),
          elapsed: formatElapsedMs(live.elapsedMs),
        })}
        placement="top"
      >
        <span className="materials-badge materials-badge--amber" data-craft-distill-phase={live.phase ?? ''}>
          {t(craftPhaseLabelKey(live.phase ?? 'extracting'))}·{formatElapsedMs(live.elapsedMs)}
        </span>
      </Tooltip>
    );
  };

  return (
    <div className="materials-listwrap">
      {/* 批量蒸馏入口（CR-2b-20——R9 批量队列 UI 生产者；进度反馈走既有 progress 事件链
          （运行条/台账徽章），此处只入队。无可蒸馏材料置灰 + tooltip 诚实说明）。 */}
      <div className="craft-grouphead" data-craft-batch="true">
        <span className="material-symbols-outlined" aria-hidden="true">science</span>
        <span className="craft-grouphead-name">{t('craft.distill.batchHead')}</span>
        <span className="materials-chip materials-chip--muted">
          {t('craft.distill.batchCount', { count: batchTargets.length })}
        </span>
        <span style={{ flex: 1 }} />
        <Tooltip
          label={
            batchTargets.length === 0
              ? t('craft.distill.batchEmpty')
              : t('craft.distill.batchRunHint', { count: batchTargets.length })
          }
          placement="top"
        >
          <button
            type="button"
            className="materials-browsebtn"
            disabled={batchBusy || batchTargets.length === 0}
            onClick={onBatchDistill}
            data-craft-action="batch-distill"
          >
            {t('craft.distill.batchRun')}
          </button>
        </Tooltip>
      </div>

      {/* 并排待决（重复候选——中档去重人审任务置顶）。 */}
      {pendingReviews.length > 0 && (
        <div className="craft-grouphead" data-craft-review-count={pendingReviews.length}>
          <span className="material-symbols-outlined" aria-hidden="true">join_inner</span>
          <span className="craft-grouphead-name">{t('craft.merge.pendingTitle', { count: pendingReviews.length })}</span>
        </div>
      )}
      {pendingReviews.map((review) => {
        const tier = craftConfidenceTier(review.newClaim.confidence);
        return (
          <div
            key={review.reviewId}
            className="materials-row materials-row--craft"
            data-craft-review={review.reviewId}
            role="button"
            tabIndex={0}
            onClick={() => onOpenReview(review.reviewId)}
            onKeyDown={(e) => {
              // CR-2b-29：Enter/Space 开并排对比；e.target 守卫防行内按钮键盘事件串触发。
              if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                e.preventDefault();
                onOpenReview(review.reviewId);
              }
            }}
          >
            <div className="materials-cell materials-cell--name">
              <span className="materials-name">{t('craft.merge.rowTitle')}</span>
              <span className="materials-format">{review.newClaim.claim.condensed}</span>
            </div>
            <div className="materials-cell">
              <span className="materials-badge materials-badge--amber">{t('craft.badge.mergeCandidate')}</span>
            </div>
            <div className="materials-cell">
              <Tooltip
                label={t('craft.confidence.tooltip', { value: review.newClaim.confidence.toFixed(2) })}
                placement="top"
              >
                <span className="materials-chip" data-craft-confidence={tier}>
                  {t(`craft.confidence.${tier}`)}
                </span>
              </Tooltip>
              <span className="materials-chip materials-chip--muted">
                {t(`craft.category.${review.newClaim.category}`)}
              </span>
              <span className="materials-chip materials-chip--tier">{termDisplay(review.newClaim.termId, terms)}</span>
            </div>
            <div className="materials-cell">
              {/* 相似度保留原值（纯代码测量——非 LLM 自报置信，design §3 修订注记）。 */}
              <Tooltip label={t('craft.merge.similarityHint')} placement="top">
                <span className="materials-chip" data-craft-similarity={review.similarity.toFixed(2)}>
                  {t('craft.merge.similarity', { value: review.similarity.toFixed(2) })}
                </span>
              </Tooltip>
            </div>
            <div className="materials-cell">
              {review.newClaim.tags.map((tag) => (
                <span key={tag} className="materials-chip">#{tag}</span>
              ))}
            </div>
            <div className="materials-cell materials-cell--time">{materialLabel(review.newClaim.materialId)}</div>
            <div className="materials-cell materials-cell--actions" />
          </div>
        );
      })}

      {/* 按材料分批卡组（组序 = 首个最高优先级卡的出现序——craftQueueCards 单源）。 */}
      {groups.map((group) => (
        <div key={group.materialId ?? '__unlinked__'}>
          <div className="craft-grouphead" data-craft-group-material={group.materialId ?? ''}>
            <span className="material-symbols-outlined" aria-hidden="true">description</span>
            <span className="craft-grouphead-name" title={group.materialId ?? undefined}>
              {materialLabel(group.materialId)}
            </span>
            <span className="materials-chip materials-chip--muted">
              {t('craft.queue.groupCount', { count: group.cards.length })}
            </span>
            {runningBadge(group.materialId)}
          </div>
          {group.cards.map((card) => (
            <CraftCardRow
              key={`${group.materialId ?? 'un'}:${card.cardId}`}
              card={card}
              terms={terms}
              tagFilter={tagFilter}
              onOpen={() => onOpenCard(card.cardId)}
              onToggleTag={onToggleTag}
            />
          ))}
        </div>
      ))}

      {pendingReviews.length === 0 && queueCards.length === 0 && (
        <div className="materials-empty" data-craft-empty="queue">
          {t('craft.queue.empty')}
        </div>
      )}
    </div>
  );
}
