/**
 * 材料行（Story 10.1 Wave D，design §5.2）——列表行渲染：名称 / 格式徽章 / 来源类别
 * （medium 开放词表——未知值原样呈现不谎报）/ 质量徽章（扫描件·编码可疑·**摄取失败**，
 * AC8 诚实标注；**parseNotes 服务器原文进徽章 tooltip**——LLM 兜底挂起原因/端点降级原因
 * 可见，CR-012 契约兑现）/ 分章状态与置信（**low-confidence = 章界挂起琥珀徽章 + tooltip
 * 说明——检索照常**，F-09 章界与检索解耦；**method='none' 伪章是常态终态**——不挂琥珀
 * 徽章、走中性「未分章」chip，CR-015）/ 字数 / 摄取时间 + 行操作（打开派生 .md / reveal /
 * 出处信息 / 重摄取 / 删除）。
 *
 * E10.2b W5 蒸馏联动：名称列 += 蒸馏状态徽章（未蒸馏/排队/运行中·相位·耗时/已蒸馏·产出 N
 * 〔= 新建卡 + 自动并入讲法合计——CR-2b-11 不虚称「N 卡」；点击跳手艺页该材料过滤〕/失败
 * 〔点击重试〕/材料已删——distill-status + progress 事件源，合成单源
 * craftView.materialDistillBadge；done tooltip = 台账 stats + 产出分解 + error note
 * 〔CR-2b-10 AC1「落库可见」〕）；操作列 += 「蒸馏」按钮（pending/failed 材料与运行中
 * 禁用——not-ready/already-running 契约语义的客户端前置）。
 *
 * 纯展示 + 回调上抛（操作编排归 MaterialsPage——mirror SettingCardList/CardSummary 分层）。
 */
import { useEffect, useRef } from 'react';
import type { MaterialSummary } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { Tooltip } from '../../shared/components/Tooltip';
import {
  craftDoneTooltipLines,
  craftPhaseLabelKey,
  formatElapsedMs,
  type CraftDistillBadge,
} from '../craft/craftView';

/** medium 受控词表（V1 六值 + R1 五值预留——i18n 全呈现；未知值在 ProvenanceForm 原样补 option）。 */
export const MATERIAL_MEDIUM_OPTIONS = [
  'novel_text',
  'lecture',
  'interview',
  'criticism',
  'wiki',
  'other',
  'game_files',
  'community_data',
  'runtime_hook',
  'screen_capture',
  'video',
] as const;

export function mediumLabel(medium: string, t: (k: string) => string): string {
  const key = `materials.medium.${medium}`;
  const label = t(key);
  return label === key ? medium : label; // 开放词表：未知值原样（不谎报成「其他」）
}

export interface MaterialRowProps {
  row: MaterialSummary;
  /** provenance 表单展开态（展开行渲染在行下）。 */
  expanded: boolean;
  onToggleProvenance: () => void;
  onReingest: () => void;
  onDelete: () => void;
  onOpenDerived: () => void;
  onReveal: () => void;
  busy?: boolean;
  /** E10.2b 蒸馏徽章（null = 未装载——隐藏徽章，不谎报「未蒸馏」）。 */
  distill?: CraftDistillBadge | null;
  /** 「蒸馏」入队（含失败徽章点击重试）。 */
  onDistill?: () => void;
  /** 已蒸馏·N 卡点击 → 手艺页该材料过滤。 */
  onOpenCraft?: () => void;
}

export function MaterialRow({
  row,
  expanded,
  onToggleProvenance,
  onReingest,
  onDelete,
  onOpenDerived,
  onReveal,
  busy = false,
  distill = null,
  onDistill,
  onOpenCraft,
}: MaterialRowProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  // F1 belt（dogfood R3）：busy（重摄取/删除 await 窗）期间分章列冻结预 busy 值——事件
  // 驱动的清单重拉若读到中间态不闪「0 章」。根治在 shell belt（markers=0 不落 0 章中间行，
  // W3b）；此处 UI 纵深防御，busy 结束即回清新鲜值。质量徽章（failed）保持实时——诚实态。
  //
  // CR-20 seenIdle 守卫：组件可能在 busy 窗内挂载（scope 切换/页面重进——MaterialsPage 的
  // actionBusyId 存活而列表行重挂），此时挂载瞬间的行本身就是中间态快照，冻结它等于把假值
  // 钉死。只有见过非 busy 瞬照（用户看到的真实预值）后才启用冻结；挂载即 busy → 如实呈现
  // 实时行（shell belt 已保证 0 章中间行不再产生，实时是诚实的）。
  const preBusyRowRef = useRef<MaterialSummary | null>(null);
  const seenIdleRef = useRef(false);
  useEffect(() => {
    if (!busy) {
      seenIdleRef.current = true;
      preBusyRowRef.current = row;
    }
  }, [busy, row]);
  const frozenRow = busy && seenIdleRef.current ? preBusyRowRef.current : null;
  const chapterRow = frozenRow ?? row;
  // CR-015：method='none' 伪章 = 讲义/访谈类常态终态（F-09：<2 万字语义类直进，非待校验）
  // ——不挂「章界待校对」琥珀徽章（走中性「未分章」muted chip）；status='low-confidence'
  // （登记行显式挂起）仍挂徽章。判定随 F1 belt 用冻结值（busy 期间分章面整体一致冻结）。
  const lowConfidence =
    chapterRow.status === 'low-confidence' ||
    (chapterRow.chapterConfidence === 'low' && chapterRow.chapterMethod !== 'none');
  const failed = row.status === 'failed';
  // CR-012：parseNotes 服务器原文（LLM 挂起原因/端点降级原因等）进质量徽章 tooltip；
  // data-quality-notes 锚 = tooltip 组料单源（测试/调试可断言）。
  const qualityNotes = row.parseNotes.length > 0 ? row.parseNotes.join('；') : null;
  const time = (() => {
    try {
      return new Date(row.ingestedAt).toLocaleString(resolvedLocale === 'zh-CN' ? 'zh-CN' : undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return row.ingestedAt;
    }
  })();

  // E10.2b：蒸馏可入队前置（not-ready 契约语义客户端面——pending/failed 不可蒸）+ 运行中
  // 禁重复入队（already-running）。服务端仍强制（客户端门只是省一次往返 + 即时禁用态）。
  const distillInFlight = distill !== null && (distill.state === 'running' || distill.state === 'pending');
  const distillNotDistillable = row.status === 'pending' || row.status === 'failed';

  /** 蒸馏徽章（E10.2b W5——合成单源 craftView.materialDistillBadge；done 点击跳手艺页、failed 点击重试）。 */
  const renderDistillBadge = () => {
    if (distill === null) return null;
    switch (distill.state) {
      case 'idle':
        return (
          <span className="materials-chip materials-chip--muted" data-distill-badge="idle">
            {t('craft.distill.idleBadge')}
          </span>
        );
      case 'pending':
        return (
          <span className="materials-badge materials-badge--amber" data-distill-badge="pending">
            {t('craft.distill.pendingBadge')}
          </span>
        );
      case 'running':
        return (
          <Tooltip
            label={t('craft.distill.runningTooltip', {
              phase: t(craftPhaseLabelKey(distill.phase)),
              elapsed: formatElapsedMs(distill.elapsedMs),
            })}
            placement="top"
          >
            <span className="materials-badge materials-badge--amber" data-distill-badge="running" data-distill-phase={distill.phase}>
              {t('craft.distill.runningBadge', {
                phase: t(craftPhaseLabelKey(distill.phase)),
                elapsed: formatElapsedMs(distill.elapsedMs),
              })}
            </span>
          </Tooltip>
        );
      case 'done':
        return (
          <Tooltip label={craftDoneTooltipLines(distill, t).join('\n')} placement="top" multiline>
            <button
              type="button"
              className="materials-chip materials-crafttag is-active"
              onClick={onOpenCraft}
              title={t('craft.distill.jump')}
              data-distill-badge="done"
              data-distill-card-count={distill.cardCount}
            >
              {t('craft.distill.doneBadge', { count: distill.cardCount })}
            </button>
          </Tooltip>
        );
      case 'failed':
        return (
          <Tooltip label={distill.error ?? t('craft.distill.failedBadge')} placement="top">
            <button
              type="button"
              className="materials-badge materials-badge--danger"
              onClick={onDistill}
              data-distill-badge="failed"
            >
              {t('craft.distill.failedBadge')}
            </button>
          </Tooltip>
        );
      case 'material-deleted':
        return (
          <span className="materials-badge materials-badge--ok" data-distill-badge="material-deleted">
            {t('craft.distill.deletedBadge')}
          </span>
        );
    }
  };

  return (
    <div
      className={`materials-row${expanded ? ' materials-row--expanded' : ''}${busy ? ' materials-row--busy' : ''}`}
      data-material-id={row.materialId}
    >
      <div className="materials-cell materials-cell--name" title={row.sourcePath}>
        <span className="materials-name">{row.name}</span>
        <span className="materials-format">{t(`materials.format.${row.format}`)}</span>
        {renderDistillBadge()}
      </div>
      <div className="materials-cell materials-cell--medium">
        <span className="materials-chip">{mediumLabel(row.medium, t)}</span>
        {row.tier !== 'unspecified' && (
          <span className="materials-chip materials-chip--tier">{t(`materials.tier.${row.tier}`)}</span>
        )}
      </div>
      <div className="materials-cell materials-cell--quality">
        {(() => {
          // 徽章簇（单源渲染，两形态复用）：failed 红徽章（CR-030，列可见性——登记行落
          // failed 是组 2 的面）优先呈现，「质量正常」不与失败并排（矛盾态）。
          const renderBadges = (extraProps?: { 'data-quality-notes'?: string }) => (
            <span className="materials-quality" {...extraProps}>
              {failed && (
                <span className="materials-badge materials-badge--danger" data-failed="true">
                  {t('materials.quality.failed')}
                </span>
              )}
              {row.scanned && <span className="materials-badge materials-badge--warn">{t('materials.quality.scanned')}</span>}
              {row.nonUtf8 && <span className="materials-badge materials-badge--warn">{t('materials.quality.nonUtf8')}</span>}
              {!failed && !row.scanned && !row.nonUtf8 && (
                <span className="materials-badge materials-badge--ok">{t('materials.quality.ok')}</span>
              )}
            </span>
          );
          if (qualityNotes === null) return renderBadges();
          // parseNotes 非空 → 徽章簇挂 tooltip（data-quality-notes 锚 = tooltip 组料单源）。
          return (
            <Tooltip label={qualityNotes} placement="top" multiline>
              {renderBadges({ 'data-quality-notes': qualityNotes })}
            </Tooltip>
          );
        })()}
      </div>
      <div className="materials-cell materials-cell--chapters">
        <span className="materials-chip">{t('materials.chapter.count', { count: chapterRow.chapterCount })}</span>
        {lowConfidence ? (
          <Tooltip label={t('materials.chapter.lowConfidenceHint')} placement="top">
            <span className="materials-badge materials-badge--amber" data-low-confidence="true">
              {t('materials.chapter.lowConfidenceBadge')}
            </span>
          </Tooltip>
        ) : (
          <span className="materials-chip materials-chip--muted">
            {t(`materials.chapter.method.${chapterRow.chapterMethod}`)}·{t(`materials.chapter.confidence.${chapterRow.chapterConfidence}`)}
          </span>
        )}
      </div>
      <div className="materials-cell materials-cell--chars">{row.charCount.toLocaleString()}</div>
      <div className="materials-cell materials-cell--time">{time}</div>
      <div className="materials-cell materials-cell--actions">
        <Tooltip label={t('materials.action.openDerived')} placement="top">
          <button
            type="button"
            className="materials-iconbtn"
            aria-label={t('materials.action.openDerived')}
            onClick={onOpenDerived}
          >
            <span className="material-symbols-outlined" aria-hidden="true">article</span>
          </button>
        </Tooltip>
        <Tooltip label={t('materials.action.revealDerived')} placement="top">
          <button
            type="button"
            className="materials-iconbtn"
            aria-label={t('materials.action.revealDerived')}
            onClick={onReveal}
          >
            <span className="material-symbols-outlined" aria-hidden="true">folder_open</span>
          </button>
        </Tooltip>
        <Tooltip label={t('materials.action.editProvenance')} placement="top">
          <button
            type="button"
            className={`materials-iconbtn${expanded ? ' materials-iconbtn--active' : ''}`}
            aria-label={t('materials.action.editProvenance')}
            onClick={onToggleProvenance}
          >
            <span className="material-symbols-outlined" aria-hidden="true">sell</span>
          </button>
        </Tooltip>
        <Tooltip label={t('materials.action.reingest')} placement="top">
          <button
            type="button"
            className="materials-iconbtn"
            aria-label={t('materials.action.reingest')}
            onClick={onReingest}
            disabled={busy}
          >
            <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
          </button>
        </Tooltip>
        {/* E10.2b 蒸馏入队（徽章见名称列；disabled 态 tooltip 诚实说明原因）。 */}
        <Tooltip
          label={distillNotDistillable ? t('craft.distill.notDistillable') : t('craft.distill.run')}
          placement="top"
        >
          <button
            type="button"
            className="materials-iconbtn"
            aria-label={t('craft.distill.run')}
            onClick={onDistill}
            disabled={busy || distillInFlight || distillNotDistillable}
            data-distill-run="true"
          >
            <span className="material-symbols-outlined" aria-hidden="true">science</span>
          </button>
        </Tooltip>
        <Tooltip label={t('materials.action.delete')} placement="top">
          <button
            type="button"
            className="materials-iconbtn materials-iconbtn--danger"
            aria-label={t('materials.action.delete')}
            onClick={onDelete}
            disabled={busy}
          >
            <span className="material-symbols-outlined" aria-hidden="true">delete</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
