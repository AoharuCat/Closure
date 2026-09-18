/**
 * 新建拆解向导（E10.3b W6，design §8 ①②——模态覆盖层）。
 *
 * 流程：材料选择（materials 读侧——F-12 过滤：low-confidence 分章/零章排除 + 提示先重摄取
 * 或校对）→ 档位三卡（粗拆/细拆/深度）→ 维度选择器（DECON_DIMENSIONS 目录渲染；**粗拆档
 * 只显示风格维**〔拍板②〕/ 细拆手艺维 1-3 + style 不计 / 深度预填全 12）→ 人审闸门 toggle
 * （默认开——拍板①）→ 预算可选 → create 回执**成本预估卡**（byPass 明细 + P1 复用打折
 * 标记——F-07）→ 启动。
 *
 * 维度合法性客户端预检（deconView.deconDimensionSelectionIsValid——shell
 * validateDeconDimensions 的 UI mirror，省一次 IPC 往返；服务端仍是权威）。
 */
import { useEffect, useMemo, useState } from 'react';
import { DECON_DIMENSIONS, type DeconTier, type MaterialSummary } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { listMaterials } from '../../shared/api/materials';
import {
  deconDimensionGranularityKey,
  deconDimensionLabelKey,
  deconDimensionSelectionIsValid,
  deconDimensionsForTier,
  deconDeepPrefilledDimensions,
  deconEligibleMaterials,
  deconEstimateNoteKey,
  deconEstimateRows,
  deconPassLabel,
  parseDeconBudgetInput,
} from './deconView';

const DECON_TIERS: ReadonlyArray<DeconTier> = ['coarse', 'fine', 'deep'];

export function DeconNewJobWizard({ onClose }: { onClose: () => void }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const currentProject = useAppStore((s) => s.currentProject);
  const createDeconJob = useAppStore((s) => s.createDeconJob);
  const startDeconJob = useAppStore((s) => s.startDeconJob);
  const showToast = useToastStore((s) => s.showToast);

  // ── 表单态 ──
  const [materialId, setMaterialId] = useState('');
  const [tier, setTier] = useState<DeconTier>('coarse');
  const [dims, setDims] = useState<string[]>([]);
  const [reviewGates, setReviewGates] = useState(true);
  const [budgetInput, setBudgetInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** U8：粗拆档「12 手艺维预览」展开态（默认折叠——可见性引导非默认可见）。 */
  const [dimPreviewOpen, setDimPreviewOpen] = useState(false);
  /** create 回执（ok 面——预估卡数据源；null = 未创建）。 */
  const [created, setCreated] = useState<{
    jobId: string;
    totalTokens: number;
    rows: ReturnType<typeof deconEstimateRows>;
  } | null>(null);

  // ── 材料池（两车道合并 by id——craft 批量池同款；F-12 过滤归 deconView 纯函数）──
  const [pool, setPool] = useState<MaterialSummary[] | null>(null);
  const projectId = currentProject?.projectId ?? null;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const merged = [...(await listMaterials({ scope: 'global' }))];
        if (projectId !== null) {
          merged.push(...(await listMaterials({ scope: 'project', projectId })));
        }
        const byId = new Map<string, MaterialSummary>();
        for (const m of merged) byId.set(m.materialId, m);
        if (!cancelled) setPool([...byId.values()]);
      } catch {
        if (!cancelled) setPool([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const { eligible, excluded } = useMemo(
    () => deconEligibleMaterials(pool ?? []),
    [pool],
  );

  // 档位切换 → 维度重置（coarse/fine 清空；deep 预填全 12 手艺维——style 可选不预选）。
  const switchTier = (next: DeconTier) => {
    if (next === tier) return;
    setTier(next);
    setDims(next === 'deep' ? deconDeepPrefilledDimensions() : []);
  };

  const visibleDims = deconDimensionsForTier(tier);
  const dimsValid = deconDimensionSelectionIsValid(tier, dims);
  const craftCount = dims.filter((d) => d !== 'style').length;
  /** U8：12 手艺维目录（粗拆档预览数据源——granularity 字段契约现成）。 */
  const craftDimCatalog = useMemo(() => DECON_DIMENSIONS.filter((d) => d.id !== 'style'), []);

  const toggleDim = (id: string) => {
    setDims((current) => (current.includes(id) ? current.filter((d) => d !== id) : [...current, id]));
  };

  const canCreate = !busy && materialId !== '' && dimsValid && created === null;

  const handleCreate = async () => {
    if (!canCreate) return;
    // 预算校验（CR-23——NaN 不静默吞，纯函数单源 parseDeconBudgetInput）：非数字/非正数显式
    // 提示拒收；留空 = 无预算。
    const parsedBudget = parseDeconBudgetInput(budgetInput);
    if (!parsedBudget.ok) {
      showToast(
        t(parsedBudget.reason === 'nan' ? 'decon.wizard.budgetNaN' : 'decon.wizard.budgetInvalid'),
        'warning',
      );
      return;
    }
    const budget = parsedBudget.budget;
    setBusy(true);
    try {
      const result = await createDeconJob({
        materialId,
        tier,
        dimensions: dims,
        reviewCheckpoints: reviewGates,
        ...(budget !== null ? { budget: { totalTokens: Math.round(budget) } } : {}),
      });
      if (!result.ok) {
        showToast(t('decon.wizard.createFailed', { message: result.message }), 'error');
        return;
      }
      setCreated({
        jobId: result.job.jobId,
        totalTokens: result.estimate.totalTokens,
        rows: deconEstimateRows(result.estimate, result.inheritedP1),
      });
    } catch (err) {
      showToast(
        t('decon.wizard.createFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    if (created === null || busy) return;
    setBusy(true);
    // F7 belt（点即关）：乐观 onClose 前置——启动结果由 job 面板横幅/红点/进度条承载，模态
    // 留守无信息增量（R3 观察「job 已 running 而模态留守」与静态代码矛盾，真机复现窗口留
    // 验收观察；点即关行为本身正确）。失败 toast 仍发（全局 toast store，不随组件卸载丢）。
    onClose();
    try {
      const result = await startDeconJob(created.jobId);
      if (result.ok) {
        showToast(result.noop ? t('decon.toast.startNoop') : t('decon.toast.started'), 'success');
      } else {
        showToast(t('decon.toast.startFailed', { message: result.message }), 'error');
      }
    } catch (err) {
      showToast(
        t('decon.toast.startFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    }
  };

  return (
    <div className="decon-modal" data-decon-wizard="true" role="dialog" aria-label={t('decon.wizard.title')}>
      <div className="decon-modal-body materials-form">
        <div className="materials-toolbar">
          <h3 className="materials-form-title">{t('decon.wizard.title')}</h3>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="materials-iconbtn"
            aria-label={t('decon.wizard.cancel')}
            onClick={onClose}
            data-decon-action="wizard-close"
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>

        {created === null ? (
          <>
            {/* ① 材料（F-12 过滤 + 排除提示）。 */}
            <div className="materials-form-row">
              <label className="materials-form-field">
                <span className="materials-form-label">{t('decon.wizard.material')}</span>
                <select
                  className="materials-form-select"
                  value={materialId}
                  onChange={(e) => setMaterialId(e.target.value)}
                  data-decon-field="material"
                >
                  <option value="">
                    {pool === null ? t('decon.list.loading') : t('decon.wizard.materialPlaceholder')}
                  </option>
                  {eligible.map((m) => (
                    <option key={m.materialId} value={m.materialId}>
                      {t('decon.wizard.materialOption', { name: m.name, chapters: m.chapterCount })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {pool !== null && eligible.length === 0 && (
              <div className="materials-empty" data-decon-material-empty="true">
                {t('decon.wizard.materialEmpty')}
              </div>
            )}
            {excluded.length > 0 && (
              <div className="materials-form-loading" data-decon-material-excluded={excluded.length}>
                {t('decon.wizard.materialExcludedHint', { count: excluded.length })}
              </div>
            )}

            {/* ② 档位三卡。 */}
            <div className="materials-form-row">
              <span className="materials-form-label">{t('decon.wizard.tier')}</span>
            </div>
            <div className="decon-tiercards">
              {DECON_TIERS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`decon-tiercard${tier === id ? ' is-active' : ''}`}
                  onClick={() => switchTier(id)}
                  data-decon-tier={id}
                >
                  <span className="decon-tiercard-name">{t(`decon.tier.${id}`)}</span>
                  <span className="decon-tiercard-hint">{t(`decon.tier.${id}Hint`)}</span>
                </button>
              ))}
            </div>

            {/* ③ 维度选择器（粗拆档只显风格维——拍板②；U8：chip 附 granularity 说明 title——
                CR-14 i18n 键路由，en 用户不再见裸中文契约注记）。 */}
            <div className="materials-form-row">
              <span className="materials-form-label">{t('decon.wizard.dimensions')}</span>
            </div>
            <div className="decon-dimgrid" data-decon-dim-tier={tier}>
              {visibleDims.map((dim) => (
                <button
                  key={dim.id}
                  type="button"
                  className={`materials-crafttag${dims.includes(dim.id) ? ' is-active' : ''}`}
                  onClick={() => toggleDim(dim.id)}
                  title={t(deconDimensionGranularityKey(dim.id))}
                  data-decon-dim={dim.id}
                >
                  {t(deconDimensionLabelKey(dim.id))}
                </button>
              ))}
            </div>
            <div className="materials-form-loading" data-decon-dim-hint={tier}>
              {tier === 'coarse'
                ? t('decon.wizard.dimCoarseHint')
                : tier === 'deep'
                  ? t('decon.wizard.dimDeepHint')
                  : t('decon.wizard.dimFineCount', { count: craftCount })}
            </div>
            {/* U8：粗拆档「12 手艺维在细拆档解锁」可见性引导 + 可展开预览（granularity 现成）。 */}
            {tier === 'coarse' && (
              <div className="decon-dimpreview" data-decon-dim-preview={dimPreviewOpen ? 'open' : 'closed'}>
                <span className="decon-dimpreview-hint">
                  {t('decon.wizard.dimCoarseMore', { count: craftDimCatalog.length })}
                </span>
                <button
                  type="button"
                  className="materials-browsebtn"
                  onClick={() => setDimPreviewOpen((v) => !v)}
                  data-decon-action="dim-preview"
                >
                  {t(dimPreviewOpen ? 'decon.wizard.dimPreviewHide' : 'decon.wizard.dimPreviewShow')}
                </button>
                {dimPreviewOpen && (
                  <div className="decon-dimpreview-list">
                    {craftDimCatalog.map((dim) => (
                      <div key={dim.id} className="decon-dimpreview-row" data-decon-dim-preview-item={dim.id}>
                        <span className="decon-dimpreview-name">{t(deconDimensionLabelKey(dim.id))}</span>
                        <span className="decon-dimpreview-gran">{t(deconDimensionGranularityKey(dim.id))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!dimsValid && (
              <div className="materials-form-error" data-decon-dim-invalid="true">
                {t('decon.wizard.invalidDims')}
              </div>
            )}

            {/* ④ 人审闸门 toggle（默认开——拍板①）。 */}
            <div className="materials-form-row">
              <label className="materials-form-field">
                <span className="materials-form-label">{t('decon.wizard.reviewGates')}</span>
                <button
                  type="button"
                  className={`materials-crafttag${reviewGates ? ' is-active' : ''}`}
                  onClick={() => setReviewGates((v) => !v)}
                  data-decon-field="review-gates"
                  data-decon-review-gates={reviewGates ? 'on' : 'off'}
                >
                  {reviewGates ? t('decon.wizard.gatesOn') : t('decon.wizard.gatesOff')}
                </button>
              </label>
            </div>

            {/* ⑤ 预算（可选）。 */}
            <div className="materials-form-row">
              <label className="materials-form-field">
                <span className="materials-form-label">{t('decon.wizard.budget')}</span>
                <input
                  type="number"
                  className="materials-form-input"
                  placeholder={t('decon.wizard.budgetPlaceholder')}
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  data-decon-field="budget"
                />
              </label>
            </div>

            <div className="materials-form-row">
              <span style={{ flex: 1 }} />
              <button type="button" className="materials-browsebtn" onClick={onClose}>
                {t('decon.wizard.cancel')}
              </button>
              <button
                type="button"
                className="materials-browsebtn"
                disabled={!canCreate}
                onClick={() => { void handleCreate(); }}
                data-decon-action="create"
              >
                {t('decon.wizard.create')}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* ⑥ 成本预估卡（byPass 明细 + P1 复用打折标记——F-07；CR-17 每 pass 一句通俗
                说明——R3 第二子项，网文作者受众、讲清钱花在哪/什么在推高费用）。 */}
            <div className="craft-grouphead">
              <span className="material-symbols-outlined" aria-hidden="true">payments</span>
              <span className="craft-grouphead-name">{t('decon.wizard.estimateTitle')}</span>
            </div>
            <div className="decon-estimate" data-decon-estimate="true">
              {created.rows.map((row) => {
                const label = deconPassLabel(row.pass);
                const passText = [t(label.stemKey), ...label.suffixKeys.map((k) => t(k))].join('·');
                return (
                  <div key={row.pass} className="decon-estimate-row" data-decon-estimate-pass={row.pass}>
                    <div className="decon-estimate-line">
                      <span className="decon-estimate-pass">{passText}</span>
                      <span className="decon-estimate-tokens">{row.tokens.toLocaleString()}</span>
                      {row.inherited && (
                        <span className="materials-badge materials-badge--ok">{t('decon.wizard.estimateInherited')}</span>
                      )}
                    </div>
                    <div className="decon-estimate-note" data-decon-estimate-note={row.pass}>
                      {t(deconEstimateNoteKey(row.pass))}
                    </div>
                  </div>
                );
              })}
              <div className="decon-estimate-row decon-estimate-row--total" data-decon-estimate-total={created.totalTokens}>
                <span className="decon-estimate-pass">{t('decon.wizard.estimateTotal', { tokens: created.totalTokens.toLocaleString() })}</span>
              </div>
            </div>
            <div className="materials-form-row">
              <span style={{ flex: 1 }} />
              <button type="button" className="materials-browsebtn" onClick={onClose}>
                {t('decon.wizard.cancel')}
              </button>
              <button
                type="button"
                className="materials-browsebtn"
                disabled={busy}
                onClick={() => { void handleStart(); }}
                data-decon-action="start"
              >
                {t('decon.wizard.start')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
