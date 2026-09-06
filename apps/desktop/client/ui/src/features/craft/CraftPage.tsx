/**
 * 「手艺」页（E10.2b W5，独立左导航页；design §3 mockup 定稿三视图）。
 *
 * 结构：工具栏（标题 + 四 tab：待阅队列/全部卡/废弃区/词表管理 + 刷新）/ 统计头（待审·
 * 已核·驳回·待并词目·分歧——card-list + term-list 客户端聚合，零额外 IPC）/ 过滤 chips
 * （材料 + tags——R10 人审侧标签面）/ 运行中材料条（相位 + 耗时——progress 事件驱动）/
 * 视图切换（卡详情/并排对比覆盖态优先；tab 内容态）。
 *
 * 数据流（事件刷新三件套，spec/ui/state-management——craftSlice）：
 * - 读 = 五清单 mount 装载（loaded 旗去重）；
 * - 刷新 = craft:distill-progress 终态事件（150ms 聚合窗 + 可见面门控）+ 关→开 force
 *   补偿（App.tsx 接线 onCraftSurfacesVisibility）；
 * - 写 = card-patch/card-review/merge-review-resolve/term-approve/merge（slice 持久化
 *   + 成功回读）。
 *
 * 批量蒸馏入口（CR-2b-20——R9 批量队列的 UI 生产者）：材料池组件本地直调 listMaterials
 * （视图局部瞬态——mirror CraftMergeReviewView getCraftCard 先例，不扩 slice）∩ 台账过滤
 * （无行 = 未蒸馏 / failed 行 = 重试；done/pending/running 跳过）→ 目标清单交队列头按钮；
 * 入队走 slice runCraftDistill（相位/终态反馈 = 既有 progress 事件链）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { CraftDistillSkipReason, MaterialSummary } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { Tooltip } from '../../shared/components/Tooltip';
import { listMaterials } from '../../shared/api/materials';
import type { CraftTab } from '../../shared/store/craftSlice';
import {
  craftPhaseLabelKey,
  craftStats,
  filterCraftCards,
  formatElapsedMs,
} from './craftView';
import { CraftQueueView } from './CraftQueueView';
import { CraftCardRow } from './CraftCardRow';
import { CraftCardDetail } from './CraftCardDetail';
import { CraftMergeReviewView } from './CraftMergeReviewView';
import { CraftTermsView } from './CraftTermsView';

const CRAFT_TABS: ReadonlyArray<{ id: CraftTab; labelKey: string }> = [
  { id: 'queue', labelKey: 'craft.tabs.queue' },
  { id: 'all', labelKey: 'craft.tabs.all' },
  { id: 'rejected', labelKey: 'craft.tabs.rejected' },
  { id: 'terms', labelKey: 'craft.tabs.terms' },
];

export function CraftPage() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const craftTab = useAppStore((s) => s.craftTab);
  const setCraftTab = useAppStore((s) => s.setCraftTab);
  const toggleCraftTagFilter = useAppStore((s) => s.toggleCraftTagFilter);
  const clearCraftFilters = useAppStore((s) => s.clearCraftFilters);
  const tagFilter = useAppStore((s) => s.craftTagFilter);
  const materialFilter = useAppStore((s) => s.craftMaterialFilter);
  const cards = useAppStore((s) => s.craftCards);
  const cardsLoading = useAppStore((s) => s.craftCardsLoading);
  const cardsError = useAppStore((s) => s.craftCardsError);
  const terms = useAppStore((s) => s.craftTerms);
  const mergeReviews = useAppStore((s) => s.craftMergeReviews);
  const materialNames = useAppStore((s) => s.craftMaterialNames);
  const progress = useAppStore((s) => s.craftDistillProgress);
  const ledgers = useAppStore((s) => s.craftDistillLedgers);
  const cardDetailId = useAppStore((s) => s.craftCardDetailId);
  const activeReviewId = useAppStore((s) => s.craftActiveReviewId);
  const loadCraftCard = useAppStore((s) => s.loadCraftCard);
  const openCraftMergeReview = useAppStore((s) => s.openCraftMergeReview);
  const loadCraftCards = useAppStore((s) => s.loadCraftCards);
  const loadCraftTerms = useAppStore((s) => s.loadCraftTerms);
  const loadCraftMergeReviews = useAppStore((s) => s.loadCraftMergeReviews);
  const loadCraftDistillLedgers = useAppStore((s) => s.loadCraftDistillLedgers);
  const loadCraftMaterialNames = useAppStore((s) => s.loadCraftMaterialNames);
  const runCraftDistill = useAppStore((s) => s.runCraftDistill);
  const currentProject = useAppStore((s) => s.currentProject);
  const showToast = useToastStore((s) => s.showToast);

  // 初装装载（loaded 旗去重归 slice；关→开 force 补偿归 App visibility 接线）。
  useEffect(() => {
    void loadCraftCards(false);
    void loadCraftTerms(false);
    void loadCraftMergeReviews(false);
    void loadCraftDistillLedgers(false);
    void loadCraftMaterialNames(false);
  }, [loadCraftCards, loadCraftTerms, loadCraftMergeReviews, loadCraftDistillLedgers, loadCraftMaterialNames]);

  // 批量蒸馏材料池（CR-2b-20——组件本地瞬态直调，mirror CraftMergeReviewView 先例）：
  // 两车道清单合并取「材料就绪」（ready/low-confidence——pending/failed 材料不可蒸，
  // not-ready 契约客户端面）；失败静默置空（按钮置灰不谎报）。刷新钮一并重载。
  const [batchPool, setBatchPool] = useState<MaterialSummary[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const projectId = currentProject?.projectId ?? null;
  const loadBatchPool = useCallback(async () => {
    try {
      const rows = await listMaterials({ scope: 'global' });
      const merged = [...rows];
      if (projectId !== null) {
        const projectRows = await listMaterials({ scope: 'project', projectId });
        merged.push(...projectRows);
      }
      // 两车道合并且按 materialId 去重（车道互斥是契约事实——Map 防御性归一）。
      const byId = new Map<string, MaterialSummary>();
      for (const m of merged) byId.set(m.materialId, m);
      setBatchPool(
        [...byId.values()].filter((m) => m.status === 'ready' || m.status === 'low-confidence'),
      );
    } catch {
      setBatchPool([]);
    }
  }, [projectId]);
  useEffect(() => {
    void loadBatchPool();
  }, [loadBatchPool]);

  /** 批量目标 = 池内「未蒸馏（无台账行）/ 蒸馏失败（failed 行 = 重试）」材料（CR-2b-20）。 */
  const batchTargets = (batchPool ?? []).flatMap((m) => {
    const ledger = ledgers.find((l) => l.materialId === m.materialId);
    return ledger === undefined || ledger.status === 'failed' ? [m.materialId] : [];
  });

  const handleBatchDistill = async () => {
    if (batchBusy || batchTargets.length === 0) return;
    setBatchBusy(true);
    try {
      const result = await runCraftDistill(batchTargets);
      if (result.ok) {
        if (result.queued.length > 0) {
          showToast(t('craft.distill.batchQueuedToast', { count: result.queued.length }), 'success');
        }
        for (const skip of result.skipped) {
          showToast(t(`craft.distill.skip.${skip.reason as CraftDistillSkipReason}`), 'warning');
        }
      } else {
        showToast(t('craft.distill.failedToast', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(
        t('craft.distill.failedToast', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setBatchBusy(false);
    }
  };

  const stats = craftStats(cards, terms);
  const filter = { tags: tagFilter, materialId: materialFilter ?? undefined };
  const runningEntries = Object.values(progress).filter(
    (e) => e.status === 'running' || e.status === 'pending',
  );
  // 台账兜底：progress 图缺事件的运行中材料（事件可丢）也上运行条（elapsed 未知显 0）。
  for (const ledger of ledgers) {
    if (
      (ledger.status === 'running' || ledger.status === 'pending') &&
      progress[ledger.materialId] === undefined &&
      !runningEntries.some((e) => e.materialId === ledger.materialId)
    ) {
      runningEntries.push({
        materialId: ledger.materialId,
        status: ledger.status,
        phase: ledger.phase,
        elapsedMs: 0,
      });
    }
  }

  const openCard = (cardId: string) => {
    void loadCraftCard(cardId, false);
  };

  const renderTab = () => {
    switch (craftTab) {
      case 'queue':
        return (
          <CraftQueueView
            cards={cards}
            mergeReviews={mergeReviews}
            terms={terms}
            materialNames={materialNames}
            progress={progress}
            tagFilter={tagFilter}
            materialFilter={materialFilter}
            onOpenCard={openCard}
            onOpenReview={openCraftMergeReview}
            onToggleTag={toggleCraftTagFilter}
            batchTargets={batchTargets}
            batchBusy={batchBusy}
            onBatchDistill={() => { void handleBatchDistill(); }}
          />
        );
      case 'all':
      case 'rejected': {
        // 全部卡 / 废弃区共用行渲染（rejected 含驳回理由 tooltip + 救回入口在详情视图）。
        const status = craftTab === 'rejected' ? ('rejected' as const) : undefined;
        const rows = filterCraftCards(cards, { ...filter, ...(status !== undefined ? { status } : {}) });
        return (
          <div className="materials-listwrap">
            {cardsError !== null && (
              <div className="materials-empty materials-empty--error" data-craft-empty="error">
                {t('craft.list.error', { message: cardsError })}
              </div>
            )}
            {cardsLoading && rows.length === 0 && <div className="materials-empty">{t('craft.list.loading')}</div>}
            {!cardsLoading && cardsError === null && rows.length === 0 && (
              <div className="materials-empty" data-craft-empty={craftTab}>
                {t(craftTab === 'rejected' ? 'craft.rejected.empty' : 'craft.list.empty')}
              </div>
            )}
            {rows.map((card) => (
              <CraftCardRow
                key={card.cardId}
                card={card}
                terms={terms}
                tagFilter={tagFilter}
                onOpen={() => openCard(card.cardId)}
                onToggleTag={toggleCraftTagFilter}
              />
            ))}
          </div>
        );
      }
      case 'terms':
        return <CraftTermsView />;
    }
  };

  return (
    <div className="materials-page" data-craft-page="true">
      {/* 覆盖态优先：卡详情 / 并排对比（back 落回 tab 内容态）。 */}
      {cardDetailId !== null ? (
        <CraftCardDetail cardId={cardDetailId} />
      ) : activeReviewId !== null ? (
        <CraftMergeReviewView reviewId={activeReviewId} />
      ) : (
        <>
          <div className="materials-toolbar">
            <h2 className="materials-title">{t('craft.title')}</h2>
            <div className="materials-scopetabs" role="tablist">
              {CRAFT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={craftTab === tab.id}
                  className={`materials-scopetab${craftTab === tab.id ? ' is-active' : ''}`}
                  onClick={() => setCraftTab(tab.id)}
                  data-craft-tab={tab.id}
                >
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <Tooltip label={t('craft.action.refresh')} placement="top">
              <button
                type="button"
                className="materials-iconbtn"
                aria-label={t('craft.action.refresh')}
                onClick={() => {
                  void loadCraftCards(true);
                  void loadCraftTerms(true);
                  void loadCraftMergeReviews(true);
                  void loadCraftDistillLedgers(true);
                  void loadBatchPool();
                }}
              >
                <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
              </button>
            </Tooltip>
          </div>

          {/* 统计头（card-list + term-list 聚合——省的面：单次装载零额外 IPC）。 */}
          <div className="craft-stats" data-craft-stats="true">
            <span>{t('craft.stats.pending', { count: stats.pending })}</span>
            <span>{t('craft.stats.verified', { count: stats.verified })}</span>
            <span>{t('craft.stats.rejected', { count: stats.rejected })}</span>
            <span>{t('craft.stats.pendingTerms', { count: stats.pendingTerms })}</span>
            <span>{t('craft.stats.dispute', { count: stats.dispute })}</span>
          </div>

          {/* 运行中材料条（运行阶段可见性硬要求——相位 + 耗时；台账兜底覆盖事件丢失）。 */}
          {runningEntries.length > 0 && (
            <div className="materials-cell" data-craft-running={runningEntries.length}>
              {runningEntries.map((entry) => (
                <Tooltip
                  key={entry.materialId}
                  label={materialNames[entry.materialId] ?? entry.materialId}
                  placement="top"
                >
                  <span className="materials-badge materials-badge--amber">
                    {materialNames[entry.materialId] ?? `${entry.materialId.slice(0, 8)}…`}
                    ·
                    {entry.status === 'pending'
                      ? t('craft.distill.pendingBadge')
                      : `${t(craftPhaseLabelKey(entry.phase ?? 'extracting'))}·${formatElapsedMs(entry.elapsedMs)}`}
                  </span>
                </Tooltip>
              ))}
            </div>
          )}

          {/* 过滤 chips（材料页 N 卡跳转 + R10 标签过滤的可见态/清除面）。 */}
          {(materialFilter !== null || tagFilter.length > 0) && (
            <div className="materials-cell" data-craft-filters="true">
              {materialFilter !== null && (
                <button
                  type="button"
                  className="materials-chip materials-crafttag is-active"
                  onClick={clearCraftFilters}
                  data-craft-filter-material={materialFilter}
                >
                  {materialNames[materialFilter] ?? `${materialFilter.slice(0, 8)}…`} ×
                </button>
              )}
              {tagFilter.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="materials-chip materials-crafttag is-active"
                  onClick={() => toggleCraftTagFilter(tag)}
                  data-craft-filter-tag={tag}
                >
                  #{tag} ×
                </button>
              ))}
            </div>
          )}

          {renderTab()}
        </>
      )}
    </div>
  );
}
