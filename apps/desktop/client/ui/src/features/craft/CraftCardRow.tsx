/**
 * 手艺卡摘要行（E10.2b W5，design §3 视图 1）——纯展示 + 回调上抛（mirror MaterialRow 分层）。
 *
 * 七列 grid（复用 materials-row 七列骨架）：招式名+浓缩预览 / 状态徽章（待审/已核/驳回 +
 * stale·分歧——mirror MaterialRow 徽章形态）/ 置信三档 chip（低/中/高，原值 tooltip——
 * mockup 修订拍板）+ 大类 + 词目 / 讲法计数 / tags chips（**点击 = 按标签过滤**——R10
 * 人审侧标签面）/ 更新时间 /（操作列空——行点击开详情）。
 *
 * **键盘可达（CR-2b-29）**：整行可激活语义 = role="button"（非 listitem——listitem 不承载
 * 交互语义且无 list 父容器；button + tabIndex + Enter/Space 与原生按钮键盘契约一致）；
 * 行内 chips 是原生 button（e.target ≠ 行自身——键盘不串触发开卡）；focus 样式见 craft.css。
 */
import type { CraftCardSummary, CraftTerm } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { Tooltip } from '../../shared/components/Tooltip';
import { craftConfidenceTier, craftStatusBadgeKey } from './craftView';

export interface CraftCardRowProps {
  card: CraftCardSummary;
  terms: CraftTerm[];
  /** 标签过滤态（chips 高亮在过滤内的标签）。 */
  tagFilter: string[];
  onOpen: () => void;
  onToggleTag: (tag: string) => void;
}

export function CraftCardRow({ card, terms, tagFilter, onOpen, onToggleTag }: CraftCardRowProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const tier = craftConfidenceTier(card.confidence);
  const termName = card.termName ?? terms.find((x) => x.termId === card.termId)?.name ?? card.termId;
  const time = (() => {
    try {
      return new Date(card.updatedAt).toLocaleString(resolvedLocale === 'zh-CN' ? 'zh-CN' : undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return card.updatedAt;
    }
  })();

  return (
    <div
      className="materials-row materials-row--craft"
      data-craft-card={card.cardId}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // CR-2b-29：Enter/Space 开卡；e.target 守卫防行内 chips/button 键盘事件串触发。
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="materials-cell materials-cell--name" title={card.title}>
        <span className="materials-name">{card.title}</span>
        <span className="materials-format">{card.condensed}</span>
      </div>
      <div className="materials-cell">
        <span
          className={`materials-badge ${
            card.status === 'pending_review'
              ? 'materials-badge--amber'
              : card.status === 'rejected'
                ? 'materials-badge--danger'
                : 'materials-badge--ok'
          }`}
          data-craft-status={card.status}
        >
          {t(craftStatusBadgeKey(card.status))}
        </span>
        {card.staleTeachingCount > 0 && (
          <Tooltip label={t('craft.badge.staleHint', { count: card.staleTeachingCount })} placement="top">
            <span className="materials-badge materials-badge--amber" data-craft-stale="true">
              {t('craft.badge.stale')}
            </span>
          </Tooltip>
        )}
        {card.dispute && (
          <Tooltip label={t('craft.badge.disputeHint')} placement="top">
            <span className="materials-badge materials-badge--warn" data-craft-dispute="true">
              {t('craft.badge.dispute')}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="materials-cell">
        <Tooltip label={t('craft.confidence.tooltip', { value: card.confidence.toFixed(2) })} placement="top">
          <span className="materials-chip" data-craft-confidence={tier}>
            {t(`craft.confidence.${tier}`)}
          </span>
        </Tooltip>
        <span className="materials-chip materials-chip--muted">{t(`craft.category.${card.category}`)}</span>
        <span className="materials-chip materials-chip--tier">{termName}</span>
      </div>
      <div className="materials-cell">
        <span className="materials-chip">{t('craft.card.teachingCount', { count: card.teachingCount })}</span>
      </div>
      <div className="materials-cell">
        {card.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`materials-chip materials-crafttag${tagFilter.includes(tag) ? ' is-active' : ''}`}
            data-craft-tag={tag}
            title={t('craft.tagFilterHint')}
            onClick={(e) => {
              e.stopPropagation(); // 行点击开详情，标签点击过滤——两动作不串
              onToggleTag(tag);
            }}
          >
            #{tag}
          </button>
        ))}
      </div>
      <div className="materials-cell materials-cell--time">{time}</div>
      <div className="materials-cell materials-cell--actions" />
    </div>
  );
}
