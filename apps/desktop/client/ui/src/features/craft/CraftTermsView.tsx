/**
 * 词表管理视图（E10.2b W5，design §3——两级词表的人审面）。
 *
 * 待并词表（status='pending'——AI 归类词表外命中的提案，flomo「积累后再整理」）：核准
 * （→active）/ 归并（→merged + 挂卡改指目标词目、category 跟随、movedCardCount 反馈）。
 * 全部词目（active 呈现 + merged 留痕箭头——审计回看；大类受控 13 类不在此编辑——
 * shared-contracts 常量单源）。
 */
import { useState } from 'react';
import type { CraftTerm } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';

export function CraftTermsView() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const terms = useAppStore((s) => s.craftTerms);
  const termsLoading = useAppStore((s) => s.craftTermsLoading);
  const approveCraftTerm = useAppStore((s) => s.approveCraftTerm);
  const mergeCraftTerm = useAppStore((s) => s.mergeCraftTerm);
  const showToast = useToastStore((s) => s.showToast);
  /** 每个待并词目的归并目标选择（termId → target termId；空 = 未选）。 */
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});

  const pendingTerms = terms.filter((x) => x.status === 'pending');
  const activeTerms = terms.filter((x) => x.status === 'active');
  const mergedTerms = terms.filter((x) => x.status === 'merged');

  const termById = (id: string): CraftTerm | undefined => terms.find((x) => x.termId === id);

  const handleApprove = async (term: CraftTerm) => {
    try {
      const result = await approveCraftTerm(term.termId);
      if (result.ok) {
        showToast(t('craft.toast.termApproved', { name: term.name }), 'success');
      } else {
        showToast(t('craft.toast.termFailed', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(t('craft.toast.termFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  const handleMerge = async (term: CraftTerm) => {
    const target = mergeTargets[term.termId];
    if (target === undefined || target.length === 0) return;
    try {
      const result = await mergeCraftTerm(term.termId, target);
      if (result.ok) {
        showToast(t('craft.toast.termMerged', { name: term.name, count: result.movedCardCount }), 'success');
        setMergeTargets((prev) => {
          const next = { ...prev };
          delete next[term.termId];
          return next;
        });
      } else {
        showToast(t('craft.toast.termFailed', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(t('craft.toast.termFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  return (
    <div className="materials-listwrap">
      {/* ── 待并词表（pending 提案——核准/归并两动作）── */}
      <div className="craft-grouphead">
        <span className="material-symbols-outlined" aria-hidden="true">call_merge</span>
        <span className="craft-grouphead-name">{t('craft.terms.pendingTitle', { count: pendingTerms.length })}</span>
      </div>
      {termsLoading && terms.length === 0 && <div className="materials-empty">{t('craft.list.loading')}</div>}
      {pendingTerms.length === 0 && !termsLoading && (
        <div className="materials-empty" data-craft-empty="terms">{t('craft.terms.pendingEmpty')}</div>
      )}
      {pendingTerms.map((term) => (
        <div key={term.termId} className="materials-form" data-craft-pending-term={term.termId}>
          <div className="materials-form-row">
            <span className="materials-name">{term.name}</span>
            <span className="materials-chip materials-chip--muted">{t(`craft.category.${term.category}`)}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="materials-browsebtn"
              onClick={() => { void handleApprove(term); }}
              data-craft-action="term-approve"
            >
              {t('craft.terms.approve')}
            </button>
            <select
              className="materials-form-select"
              value={mergeTargets[term.termId] ?? ''}
              onChange={(e) => setMergeTargets((prev) => ({ ...prev, [term.termId]: e.target.value }))}
              data-craft-term-target={term.termId}
            >
              <option value="">{t('craft.terms.mergeTargetPlaceholder')}</option>
              {activeTerms
                .filter((x) => x.termId !== term.termId)
                .map((x) => (
                  <option key={x.termId} value={x.termId}>
                    {x.name}·{t(`craft.category.${x.category}`)}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="materials-browsebtn"
              disabled={(mergeTargets[term.termId] ?? '').length === 0}
              onClick={() => { void handleMerge(term); }}
              data-craft-action="term-merge"
            >
              {t('craft.terms.merge')}
            </button>
          </div>
        </div>
      ))}

      {/* ── 全部词目（active 呈现 + merged 留痕）── */}
      <div className="craft-grouphead">
        <span className="material-symbols-outlined" aria-hidden="true">menu_book</span>
        <span className="craft-grouphead-name">{t('craft.terms.allTitle', { count: activeTerms.length })}</span>
      </div>
      {[...activeTerms, ...mergedTerms].map((term) => (
        <div key={term.termId} className="materials-row materials-row--craft" style={{ cursor: 'default' }}>
          <div className="materials-cell materials-cell--name">
            <span className="materials-name">{term.name}</span>
          </div>
          <div className="materials-cell">
            <span className="materials-chip materials-chip--muted">{t(`craft.category.${term.category}`)}</span>
          </div>
          <div className="materials-cell">
            {term.status === 'merged' && term.mergedInto !== null && (
              <span className="materials-chip">
                {t('craft.terms.mergedInto', {
                  target: termById(term.mergedInto)?.name ?? term.mergedInto,
                })}
              </span>
            )}
            {term.status === 'pending' && (
              <span className="materials-badge materials-badge--amber">{t('craft.terms.pendingSuffix')}</span>
            )}
          </div>
          <div className="materials-cell" />
          <div className="materials-cell" />
          <div className="materials-cell" />
          <div className="materials-cell" />
        </div>
      ))}
    </div>
  );
}
