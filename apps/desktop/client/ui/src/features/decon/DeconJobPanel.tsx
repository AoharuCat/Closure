/**
 * 拆解会话面板（E10.3b W6，design §8 ③④⑤——右列详情）。
 *
 * 结构（自上而下）：
 * - 头行：材料名 + 档位 chip + 状态徽章 + 实际成本 + 动作排（暂停/继续〔capped 带调预算〕/
 *   取消/删除）；
 * - 状态横幅：running（当前 pass/unit + elapsedMs——progress 事件驱动，事件可丢时 get 兜底）
 *   / 闸门暂停（review 行 pending = 待人工确认——design §6「UI 按 review 行区分等审」）/
 *   capped（提示调预算）/ stale（「确认重跑」动作——W7 小补③，以新材料整体重拆）/ failed
 *   （error 文案）；
 * - 人审闸门卡（design §8 ④）：dictionary → 实体/词典展示；canon → 六域抽查；craft →
 *   decon:products p4:* findings 按维分组（insight/elaboration/evidence 引文）；确认按钮 →
 *   approve-review（slice 内确认即续跑——start 续跑零重付）；
 * - pass 进度：pass_state 按 pass 聚合（千 unit 行不整面灌——deconView.summarizeDeconPassStates）
 *   + 当前相位行；
 * - 产出阅读五 tab（读法/章评/细批/风格/canon）+ 手艺卡跳转区 + 风格导出（写前确认列节——
 *   design §8 风格导出）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  parseDeconMaterialRef,
  type DeconReportKind,
  type DeconReportMeta,
  type DeconReviewCheckpoint,
} from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useConfirmStore } from '../../shared/store/confirmStore';
import { useToastStore } from '../../shared/store/toastStore';
import { listCraftCards } from '../../shared/api/craft';
import {
  deconBannerKind,
  deconDimensionLabelKey,
  deconPassLabel,
  deconPendingReview,
  deconReportUnitLabelKey,
  deconStatusBadgeClass,
  deconStatusKey,
  deconTierLabelKey,
  deconUnitLabelKey,
  formatElapsedMs,
  isDeconFindingsLike,
  isDeconStylePayloadLike,
  summarizeDeconPassStates,
} from './deconView';

/** 产出 tab × 报告 kind 映射（canon tab 走 detail.canon 非 report 面）。 */
const TAB_KINDS: Partial<Record<string, DeconReportKind>> = {
  reading: 'book_reading',
  chapters: 'chapter_review',
  scenes: 'scene_annotation',
  style: 'style_report',
};

const OUTPUT_TABS: ReadonlyArray<{ id: 'reading' | 'chapters' | 'scenes' | 'style' | 'canon'; labelKey: string }> = [
  { id: 'reading', labelKey: 'decon.output.tabReading' },
  { id: 'chapters', labelKey: 'decon.output.tabChapters' },
  { id: 'scenes', labelKey: 'decon.output.tabScenes' },
  { id: 'style', labelKey: 'decon.output.tabStyle' },
  { id: 'canon', labelKey: 'decon.output.tabCanon' },
];

export function DeconJobPanel({ materialNames }: { materialNames: Record<string, string> }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const currentProject = useAppStore((s) => s.currentProject);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const jobId = useAppStore((s) => s.deconSelectedJobId);
  const detail = useAppStore((s) => s.deconDetail);
  const detailLoading = useAppStore((s) => s.deconDetailLoading);
  const detailError = useAppStore((s) => s.deconDetailError);
  const loadDeconJobDetail = useAppStore((s) => s.loadDeconJobDetail);
  const loadDeconReportMetas = useAppStore((s) => s.loadDeconReportMetas);
  const progressMap = useAppStore((s) => s.deconProgress);
  const startDeconJob = useAppStore((s) => s.startDeconJob);
  const pauseDeconJob = useAppStore((s) => s.pauseDeconJob);
  const cancelDeconJob = useAppStore((s) => s.cancelDeconJob);
  const deleteDeconJob = useAppStore((s) => s.deleteDeconJob);
  const approveDeconReview = useAppStore((s) => s.approveDeconReview);
  const confirmRerunDecon = useAppStore((s) => s.confirmRerunDecon);
  const outputTab = useAppStore((s) => s.deconOutputTab);
  const setOutputTab = useAppStore((s) => s.setDeconOutputTab);
  const productsCache = useAppStore((s) => s.deconProducts);
  const fetchDeconProducts = useAppStore((s) => s.fetchDeconProducts);
  const reportMetas = useAppStore((s) => s.deconReportMetas);
  const reportContent = useAppStore((s) => s.deconReportContent);
  const reportContentKey = useAppStore((s) => s.deconReportContentKey);
  const reportContentLoading = useAppStore((s) => s.deconReportContentLoading);
  const fetchDeconReport = useAppStore((s) => s.fetchDeconReport);
  const clearDeconReportContent = useAppStore((s) => s.clearDeconReportContent);
  const exportDeconStyle = useAppStore((s) => s.exportDeconStyle);
  const openCraftForMaterial = useAppStore((s) => s.openCraftForMaterial);
  const showToast = useToastStore((s) => s.showToast);

  const [actionBusy, setActionBusy] = useState(false);
  /** capped 调预算续跑展开态。 */
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');

  // 详情/报告 meta 装载（belt——selectDeconJob/createDeconJob 主路径之外的自取数面：
  // mirror CraftCardDetail mount effect 形态；slice loadedFor/详情非空守卫去重）。
  useEffect(() => {
    if (jobId === null) return;
    void loadDeconJobDetail(jobId, false);
    void loadDeconReportMetas(jobId, false);
  }, [jobId, loadDeconJobDetail, loadDeconReportMetas]);

  const job = detail?.job ?? null;
  const reviews = detail?.reviews ?? [];
  const banner = job !== null ? deconBannerKind(job, reviews) : null;
  const pendingReview = deconPendingReview(reviews);
  const liveEvent = jobId !== null ? progressMap[jobId] : undefined;

  const materialId = job !== null ? parseDeconMaterialRef(job.materialRef)?.materialId ?? null : null;
  const materialName =
    materialId !== null ? materialNames[materialId] ?? `${materialId.slice(0, 8)}…` : '';

  // ── craft 闸门 / 产出阅读 findings：p4:* products（CR-8——**按茎拉取**：passStem 'p4'
  //    走通道前缀过滤〔壳面已落——不再全量拉+客户端过滤〕；'p4' 含 p4:style，风格维排除归
  //    本消费面按维分组时滤掉）。──
  const gateProductsKey = `${jobId ?? ''}:p4`;
  const gateProducts = productsCache[gateProductsKey];
  useEffect(() => {
    if (jobId === null || pendingReview?.checkpoint !== 'craft') return;
    if (gateProducts !== undefined) return;
    void fetchDeconProducts(jobId, { passStem: 'p4' }).catch(() => {
      // 拉取失败闸门卡呈空态——确认按钮仍在（服务端数据为准）。
    });
  }, [jobId, pendingReview?.checkpoint, gateProducts, fetchDeconProducts]);

  const craftFindings = useMemo(() => {
    const rows = gateProducts ?? [];
    const byDim = new Map<string, DeconCraftFindingGroup>();
    for (const row of rows) {
      if (!row.pass.startsWith('p4:') || row.pass === 'p4:style') continue;
      if (!isDeconFindingsLike(row.payload)) continue;
      const dim = row.pass.slice(3);
      const group = byDim.get(dim) ?? { dim, findings: [] };
      group.findings.push(...row.payload.findings);
      byDim.set(dim, group);
    }
    return [...byDim.values()];
  }, [gateProducts]);

  // ── 手艺卡跳转区：job done 后查本书材料的手艺卡数（craft:card-list materialId 过滤）。──
  const [craftCount, setCraftCount] = useState<number | null>(null);
  useEffect(() => {
    if (job?.status !== 'done' || materialId === null) {
      setCraftCount(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cards = await listCraftCards({ materialId });
        if (!cancelled) setCraftCount(cards.length);
      } catch {
        if (!cancelled) setCraftCount(null);
      }
    })();
    return () => { cancelled = true; };
  }, [job?.status, materialId]);

  // ── 动作 ──

  const runTransition = async (
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const result = await fn();
      if (!result.ok) {
        showToast(t('decon.toast.transitionFailed', { message: result.message ?? result.error ?? '' }), 'error');
      }
    } catch (err) {
      showToast(
        t('decon.toast.transitionFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async () => {
    if (job === null) return;
    const confirmed = await useConfirmStore.getState().requestConfirm({
      title: t('decon.deleteConfirmTitle'),
      message: t('decon.deleteConfirmMessage'),
      confirmLabel: t('decon.deleteConfirmLabel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await runTransition(async () => {
      const result = await deleteDeconJob(job.jobId);
      if (result.ok) showToast(t('decon.toast.deleted'), 'success');
      else showToast(t('decon.toast.deleteFailed', { message: result.message ?? result.error }), 'error');
      return result;
    });
  };

  const handleApprove = async (checkpoint: DeconReviewCheckpoint) => {
    if (job === null || actionBusy) return;
    setActionBusy(true);
    try {
      const result = await approveDeconReview(job.jobId, checkpoint);
      if (result.ok) {
        showToast(t('decon.toast.gateApproved'), 'success');
      } else {
        showToast(t('decon.toast.gateApproveFailed', { message: result.message }), 'error');
      }
    } catch (err) {
      showToast(
        t('decon.toast.gateApproveFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleResumeWithBudget = async () => {
    if (job === null) return;
    const parsed = Number(budgetInput.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setBudgetOpen(false);
    await runTransition(() => startDeconJob(job.jobId, { totalTokens: Math.round(parsed) }));
  };

  // stale 确认重跑（W7 小补③——shell 侧 confirm+start 一体：刷新指纹 + 复位产物后续跑，
  // 同指纹事实层自动复用；不再引导「删除后重拆」）。
  const handleConfirmRerun = async () => {
    if (job === null) return;
    setActionBusy(true);
    try {
      const result = await confirmRerunDecon(job.jobId);
      if (result.ok) {
        showToast(t('decon.toast.confirmRerunStarted'), 'success');
      } else {
        showToast(t('decon.toast.confirmRerunFailed', { message: result.message }), 'error');
      }
    } catch (err) {
      showToast(
        t('decon.toast.confirmRerunFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleStart = async () => {
    if (job === null) return;
    await runTransition(async () => {
      const result = await startDeconJob(job.jobId);
      if (result.ok) showToast(result.noop ? t('decon.toast.startNoop') : t('decon.toast.started'), 'success');
      return result;
    });
  };

  // ── 风格导出（写前确认列节——design §8；无 p4:style payload 走 IPC 的
  //    style-payload-missing 诚实报错，此处预检省一次注定失败的写）。──
  const handleExportStyle = async () => {
    const projectId = currentProject?.projectId;
    if (job === null || projectId === undefined || projectId === null) return;
    try {
      const rows = await fetchDeconProducts(job.jobId, { pass: 'p4:style' });
      const styleRow = rows.find((r) => r.unit === 'all');
      if (styleRow === undefined || !isDeconStylePayloadLike(styleRow.payload)) {
        showToast(t('decon.output.styleExportFailed', { message: t('decon.output.styleEmpty') }), 'warning');
        return;
      }
      const sections = Object.keys(styleRow.payload.sections);
      const confirmed = await useConfirmStore.getState().requestConfirm({
        title: t('decon.output.styleExportConfirmTitle'),
        message: `${t('decon.output.styleExportConfirmBody', { count: sections.length })}\n${sections.join('、')}`,
        confirmLabel: t('decon.output.styleExport'),
      });
      if (!confirmed) return;
      const result = await exportDeconStyle(job.jobId, projectId);
      if (result.ok) {
        showToast(t('decon.output.styleExportDone', { count: result.writtenSections.length }), 'success');
      } else {
        showToast(t('decon.output.styleExportFailed', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(
        t('decon.output.styleExportFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    }
  };

  // ── pass 进度聚合 ──
  const passSummaries = useMemo(
    () => (detail !== null ? summarizeDeconPassStates(detail.passStates) : []),
    [detail],
  );

  const passText = (pass: string): string => {
    const label = deconPassLabel(pass);
    return [t(label.stemKey), ...label.suffixKeys.map((k) => t(k))].join('·');
  };

  const unitText = (unit: string): string => {
    const parsed = deconUnitLabelKey(unit);
    if (parsed === null) return unit; // 字面 unit（p2 域名等）原样回显
    return parsed.index !== undefined ? t(parsed.key, { index: parsed.index }) : t(parsed.key);
  };

  const reportText = (meta: DeconReportMeta): string => {
    const label = deconReportUnitLabelKey(meta.unit);
    return label.index !== undefined ? t(label.key, { index: label.index }) : t(label.key);
  };

  const kindText = (kind: string): string => t(`decon.reportKind.${kind}`);

  const tabMetas = (tab: string): DeconReportMeta[] => {
    const kind = TAB_KINDS[tab];
    if (kind === undefined) return [];
    return reportMetas.filter((m) => m.kind === kind);
  };

  const openReport = useCallback(
    (meta: DeconReportMeta) => {
      if (jobId === null) return;
      void fetchDeconReport(jobId, meta.kind, meta.unit).catch(() => {
        showToast(t('decon.output.reportFailed', { message: meta.unit }), 'error');
      });
    },
    [jobId, fetchDeconReport, showToast, t],
  );

  // ── 报告详情正文（md + 锚点区——CR-25 E2E「锚点可追」落物）：报告行 anchors 的
  //    章号〔0 基 +1——CR-2〕/段落区间列表 + 引文摘要（有则显示——契约 DeconSpan 今日不带
  //    quote 字段，防御读留「有则显示」面）。scene_annotation/style_report 的 anchors 同一
  //    落位（四 kind 共用单取行）。──
  const renderReportBody = () => {
    if (reportContentLoading) {
      return <div className="materials-form-loading">{t('decon.output.loading')}</div>;
    }
    if (reportContent === null) return null;
    return (
      <>
        {reportContent.anchors.length > 0 && (
          <div className="decon-anchors" data-decon-report-anchors={reportContent.anchors.length}>
            <div className="craft-grouphead">
              <span className="craft-grouphead-name">{t('decon.output.anchorsTitle')}</span>
            </div>
            {reportContent.anchors.map((anchor, idx) => {
              const quote = (anchor as { quote?: unknown }).quote;
              return (
                <div key={idx} className="decon-anchor" data-decon-anchor={idx}>
                  <span className="decon-anchor-range">
                    {t('decon.output.anchorRow', {
                      chapter: anchor.chapterIndex + 1,
                      start: anchor.paraStart,
                      end: anchor.paraEnd,
                    })}
                  </span>
                  {typeof quote === 'string' && quote.length > 0 && (
                    <blockquote className="craft-compare-quote">{quote}</blockquote>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <pre className="decon-reportmd">{reportContent.contentMd}</pre>
      </>
    );
  };

  // ── 闸门卡内容渲染 ──

  /** 截断提示行（CR-11 诚实人层面：截断展示后补「+N 条未展示」——确认前知悉存在未见项）。 */
  const renderTruncated = (total: number, shown: number) => {
    if (total <= shown) return null;
    return (
      <div className="decon-truncated" data-decon-truncated={total - shown}>
        {t('decon.review.truncatedHint', { count: total - shown })}
      </div>
    );
  };

  const renderGateBody = (checkpoint: DeconReviewCheckpoint) => {
    if (checkpoint === 'dictionary') {
      const dictionary = detail?.dictionary ?? null;
      const entities = detail?.entities ?? [];
      return (
        <>
          <div className="decon-gate-section" data-decon-gate-dictionary={dictionary?.entries.length ?? 0}>
            <div className="craft-grouphead">
              <span className="craft-grouphead-name">
                {t('decon.review.dictionaryEntries', { count: dictionary?.entries.length ?? 0 })}
              </span>
            </div>
            <div className="materials-cell">
              {(dictionary?.entries ?? []).slice(0, 50).map((entry, idx) => (
                <span key={`${entry.name}-${idx}`} className="materials-chip">
                  {t('decon.review.dictionaryRow', { name: entry.name, type: t(`decon.entityType.${entry.type}`) })}
                </span>
              ))}
              {renderTruncated(dictionary?.entries.length ?? 0, 50)}
            </div>
          </div>
          <div className="decon-gate-section" data-decon-gate-entities={entities.length}>
            <div className="craft-grouphead">
              <span className="craft-grouphead-name">{t('decon.review.entities', { count: entities.length })}</span>
            </div>
            <div className="materials-cell">
              {entities.slice(0, 50).map((entity) => (
                <span key={entity.canonicalName} className="materials-chip">
                  {t('decon.review.entityRow', {
                    name: entity.canonicalName,
                    type: t(`decon.entityType.${entity.type}`),
                    count: entity.mentionsTotal,
                  })}
                </span>
              ))}
              {renderTruncated(entities.length, 50)}
            </div>
          </div>
        </>
      );
    }
    if (checkpoint === 'canon') {
      const canon = detail?.canon ?? [];
      const domains = new Map<string, typeof canon>();
      for (const entry of canon) {
        const bucket = domains.get(entry.domain) ?? [];
        bucket.push(entry);
        domains.set(entry.domain, bucket);
      }
      return (
        <div className="decon-gate-section" data-decon-gate-canon={canon.length}>
          {[...domains.entries()].map(([domain, entries]) => (
            <div key={domain} className="decon-gate-domain">
              <div className="craft-grouphead">
                <span className="craft-grouphead-name">
                  {t('decon.review.canonEntries', { domain: t(`decon.canonDomain.${domain}`), count: entries.length })}
                </span>
              </div>
              <div className="materials-cell">
                {entries.slice(0, 20).map((entry) => (
                  <span key={entry.name} className="materials-chip" title={entry.name}>
                    {entry.name}
                  </span>
                ))}
                {renderTruncated(entries.length, 20)}
              </div>
            </div>
          ))}
          {canon.length === 0 && <div className="materials-form-loading">{t('decon.output.canonEmpty')}</div>}
        </div>
      );
    }
    // craft：p4 findings 按维分组（insight/elaboration/evidence 引文）。
    return (
      <div className="decon-gate-section" data-decon-gate-craft={craftFindings.length}>
        {craftFindings.map((group) => (
          <div key={group.dim} className="decon-gate-domain">
            <div className="craft-grouphead">
              <span className="craft-grouphead-name">
                {t('decon.review.findingsFor', { dim: t(deconDimensionLabelKey(group.dim)), count: group.findings.length })}
              </span>
            </div>
            {group.findings.map((finding, idx) => (
              <div key={idx} className="decon-finding" data-decon-finding={`${group.dim}:${idx}`}>
                <div className="decon-finding-insight">{finding.insight}</div>
                <div className="decon-finding-elaboration">{finding.elaboration}</div>
                {finding.evidence.map((ev, evIdx) => (
                  <blockquote key={evIdx} className="craft-compare-quote">
                    {ev.quote}
                    <span className="decon-finding-para">
                      {t('decon.review.evidencePara', { start: ev.paraRange.start, end: ev.paraRange.end })}
                    </span>
                  </blockquote>
                ))}
                {finding.craftHint !== null && finding.craftHint.category !== undefined && (
                  <span className="materials-chip materials-chip--tier">
                    {t('decon.review.craftHintChip', { category: t(`craft.category.${finding.craftHint.category}`) })}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
        {craftFindings.length === 0 && (
          <div className="materials-form-loading">{t('decon.review.noFindings')}</div>
        )}
      </div>
    );
  };

  // ── 产出 tab 内容渲染 ──
  const renderTabContent = () => {
    switch (outputTab) {
      case 'canon': {
        const canon = detail?.canon ?? [];
        const domains = new Map<string, typeof canon>();
        for (const entry of canon) {
          const bucket = domains.get(entry.domain) ?? [];
          bucket.push(entry);
          domains.set(entry.domain, bucket);
        }
        if (canon.length === 0) {
          return <div className="materials-empty" data-decon-tab-empty="canon">{t('decon.output.canonEmpty')}</div>;
        }
        return (
          <div className="decon-canonbrowse" data-decon-canon-domains={domains.size}>
            {[...domains.entries()].map(([domain, entries]) => (
              <div key={domain} className="decon-gate-domain">
                <div className="craft-grouphead">
                  <span className="craft-grouphead-name">
                    {t('decon.review.canonEntries', { domain: t(`decon.canonDomain.${domain}`), count: entries.length })}
                  </span>
                </div>
                {entries.map((entry) => (
                  <div key={`${domain}-${entry.name}`} className="decon-canonentry" data-decon-canon-entry={entry.name}>
                    <span className="decon-canonentry-name">{entry.name}</span>
                    <span className="decon-canonentry-payload">{JSON.stringify(entry.payload)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      }
      case 'style': {
        const metas = tabMetas('style');
        return (
          <>
            {metas.length === 0 ? (
              <div className="materials-empty" data-decon-tab-empty="style">{t('decon.output.styleEmpty')}</div>
            ) : (
              <div className="decon-reportview">
                <div className="decon-reportlist">
                  {metas.map((meta) => (
                    <button
                      key={`${meta.kind}:${meta.unit}`}
                      type="button"
                      className={`decon-reportrow${reportContentKey === `${meta.kind}:${meta.unit}` ? ' is-active' : ''}`}
                      onClick={() => openReport(meta)}
                      data-decon-report-row={`${meta.kind}:${meta.unit}`}
                    >
                      {kindText(meta.kind)}
                    </button>
                  ))}
                </div>
                <div className="decon-reportbody">{renderReportBody()}</div>
              </div>
            )}
            {/* 风格导出（F-06——无当前项目禁用 + 提示；写前确认列节）。 */}
            <div className="decon-styleexport" data-decon-style-export="true">
              <button
                type="button"
                className="materials-browsebtn"
                disabled={currentProject === null}
                title={currentProject === null ? t('decon.output.styleExportNoProject') : undefined}
                onClick={() => { void handleExportStyle(); }}
                data-decon-action="export-style"
              >
                {t('decon.output.styleExport')}
              </button>
              {currentProject === null && (
                <span className="materials-form-loading">{t('decon.output.styleExportNoProject')}</span>
              )}
            </div>
          </>
        );
      }
      case 'reading':
      case 'chapters':
      case 'scenes': {
        const metas = tabMetas(outputTab);
        if (metas.length === 0) {
          const emptyKey =
            outputTab === 'reading' ? 'decon.output.readingEmpty'
              : outputTab === 'chapters' ? 'decon.output.chaptersEmpty'
                : 'decon.output.scenesEmpty';
          return <div className="materials-empty" data-decon-tab-empty={outputTab}>{t(emptyKey)}</div>;
        }
        const hintKey = outputTab === 'chapters' ? 'decon.output.selectChapter'
          : outputTab === 'scenes' ? 'decon.output.selectScene' : null;
        return (
          <div className="decon-reportview">
            <div className="decon-reportlist">
              {metas.map((meta) => (
                <button
                  key={`${meta.kind}:${meta.unit}`}
                  type="button"
                  className={`decon-reportrow${reportContentKey === `${meta.kind}:${meta.unit}` ? ' is-active' : ''}`}
                  onClick={() => openReport(meta)}
                  data-decon-report-row={`${meta.kind}:${meta.unit}`}
                >
                  {reportText(meta)}
                </button>
              ))}
            </div>
            <div className="decon-reportbody">
              {!reportContentLoading && reportContent === null && hintKey !== null && (
                <div className="materials-empty">{t(hintKey)}</div>
              )}
              {renderReportBody()}
            </div>
          </div>
        );
      }
    }
  };

  if (jobId === null) return null;

  return (
    <div className="decon-jobpanel" data-decon-panel={jobId}>
      {/* 头行：材料 + 档位 + 状态 + 成本 + 动作排。 */}
      <div className="materials-toolbar">
        <h3 className="materials-title">{materialName}</h3>
        {job !== null && (
          <>
            <span className="materials-chip materials-chip--tier">{t(deconTierLabelKey(job.tier))}</span>
            <span className={`materials-badge ${deconStatusBadgeClass(job.status)}`} data-decon-status={job.status}>
              {t(deconStatusKey(job.status))}
            </span>
            <span className="materials-chip materials-chip--muted">
              {t('decon.costLabel', { tokens: job.cost.totalTokens.toLocaleString() })}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {job?.status === 'running' && (
          <button type="button" className="materials-browsebtn" disabled={actionBusy} onClick={() => { void runTransition(() => pauseDeconJob(job.jobId)); }} data-decon-action="pause">
            {t('decon.action.pause')}
          </button>
        )}
        {(job?.status === 'pending' || job?.status === 'paused' || job?.status === 'capped') && (
          <button type="button" className="materials-browsebtn" disabled={actionBusy} onClick={() => { void handleStart(); }} data-decon-action="resume">
            {job?.status === 'pending' ? t('decon.wizard.start') : t('decon.action.resume')}
          </button>
        )}
        {job?.status === 'capped' && (
          <button type="button" className="materials-browsebtn" disabled={actionBusy} onClick={() => setBudgetOpen((v) => !v)} data-decon-action="resume-budget">
            {t('decon.action.resumeWithBudget')}
          </button>
        )}
        {(job?.status === 'running' || job?.status === 'paused') && (
          <button type="button" className="materials-browsebtn" disabled={actionBusy} onClick={() => { void runTransition(() => cancelDeconJob(job.jobId)); }} data-decon-action="cancel">
            {t('decon.action.cancel')}
          </button>
        )}
        {job?.status === 'stale' && (
          <button type="button" className="materials-browsebtn" disabled={actionBusy} onClick={() => { void handleConfirmRerun(); }} data-decon-action="confirm-rerun">
            {t('decon.action.confirmRerun')}
          </button>
        )}
        <button type="button" className="materials-browsebtn" disabled={actionBusy} onClick={() => { void handleDelete(); }} data-decon-action="delete">
          {t('decon.action.delete')}
        </button>
      </div>

      {/* capped 调预算续跑展开行。 */}
      {budgetOpen && job?.status === 'capped' && (
        <div className="materials-form" data-decon-budget-form="true">
          <div className="materials-form-row">
            <label className="materials-form-field" style={{ flex: 1 }}>
              <span className="materials-form-label">{t('decon.budgetPrompt')}</span>
              <input
                type="number"
                className="materials-form-input"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                data-decon-field="resume-budget"
              />
            </label>
            <button type="button" className="materials-browsebtn" onClick={() => { void handleResumeWithBudget(); }} data-decon-action="budget-apply">
              {t('decon.budgetApply')}
            </button>
          </div>
        </div>
      )}

      {/* 状态横幅（运行相位可见硬要求——闸门暂停优先）。 */}
      {banner !== null && (
        <div className={`decon-banner decon-banner--${banner}`} data-decon-banner={banner}>
          {banner === 'pending' && t('decon.banner.pending')}
          {banner === 'running' && liveEvent !== undefined && liveEvent.pass !== null && (
            <>
              {t('decon.banner.running', {
                phase: `${passText(liveEvent.pass)}${liveEvent.unit != null && liveEvent.unit !== '' ? `·${unitText(liveEvent.unit)}` : ''}`,
                elapsed: formatElapsedMs(liveEvent.elapsedMs ?? 0),
              })}
            </>
          )}
          {banner === 'running' && (liveEvent === undefined || liveEvent.pass === null) && t('decon.status.running')}
          {banner === 'gate-paused' && pendingReview !== null && (
            t('decon.banner.gate-paused', { checkpoint: t(`decon.review.${pendingReview.checkpoint}`) })
          )}
          {banner === 'paused' && t('decon.banner.paused')}
          {banner === 'capped' && t('decon.banner.capped')}
          {banner === 'stale' && t('decon.banner.stale')}
          {banner === 'failed' && t('decon.banner.failed', { message: job?.error ?? '' })}
          {banner === 'done' && t('decon.banner.done')}
          {banner === 'cancelled' && t('decon.banner.cancelled')}
          {/* note 软提示（CR-10——闸门暂停「待人工确认」等常规预期态注记）：事件 best-effort
              可丢——丢则只有上行判定文案；error 只显真失败（failed/capped 横幅），互不混用。 */}
          {liveEvent?.note != null && liveEvent.note !== '' && (
            <div className="decon-banner-note" data-decon-banner-note="true">{liveEvent.note}</div>
          )}
        </div>
      )}

      {detailLoading && detail === null && <div className="materials-empty">{t('decon.list.loading')}</div>}
      {detailError !== null && (
        <div className="materials-empty materials-empty--error">{t('decon.list.error', { message: detailError })}</div>
      )}
      {detail !== null && (
        <>
          {/* 人审闸门卡（pending 闸门 + 暂停态——审阅 + 确认即续跑）。 */}
          {banner === 'gate-paused' && pendingReview !== null && (
            <div className="decon-gate materials-form" data-decon-gate={pendingReview.checkpoint}>
              <div className="materials-toolbar">
                <span className="materials-form-title">
                  {t('decon.review.gateTitle', { checkpoint: t(`decon.review.${pendingReview.checkpoint}`) })}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="materials-browsebtn"
                  disabled={actionBusy}
                  onClick={() => { void handleApprove(pendingReview.checkpoint); }}
                  data-decon-action="approve-review"
                >
                  {t('decon.review.approve')}
                </button>
              </div>
              {renderGateBody(pendingReview.checkpoint)}
            </div>
          )}

          {/* pass 进度（聚合行 + 当前相位）。 */}
          <div className="decon-progress" data-decon-progress={passSummaries.length}>
            {liveEvent !== undefined && liveEvent.status === 'running' && liveEvent.pass !== null && (
              <div className="decon-progress-current" data-decon-progress-current={liveEvent.pass}>
                <span className="material-symbols-outlined" aria-hidden="true">progress_activity</span>
                {passText(liveEvent.pass)}
                {liveEvent.unit != null && liveEvent.unit !== '' ? `·${unitText(liveEvent.unit)}` : ''}
                {`·${formatElapsedMs(liveEvent.elapsedMs ?? 0)}`}
              </div>
            )}
            {passSummaries.map((summary) => (
              <div key={summary.pass} className="decon-progress-row" data-decon-pass={summary.pass}>
                <span className="decon-progress-name">{passText(summary.pass)}</span>
                <span className="decon-progress-count">
                  {summary.done}/{summary.total}
                </span>
                <span
                  className={`decon-progress-dot decon-progress-dot--${
                    summary.failed > 0 ? 'failed'
                      : summary.capped > 0 ? 'capped'
                        : summary.running > 0 ? 'running'
                          : summary.done === summary.total ? 'done'
                            : 'pending'
                  }`}
                />
              </div>
            ))}
            {passSummaries.length === 0 && (
              <div className="materials-form-loading">{t('decon.list.loading')}</div>
            )}
          </div>

          {/* 产出阅读五 tab。 */}
          <div className="materials-scopetabs" role="tablist">
            {OUTPUT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={outputTab === tab.id}
                className={`materials-scopetab${outputTab === tab.id ? ' is-active' : ''}`}
                onClick={() => {
                  setOutputTab(tab.id);
                  clearDeconReportContent();
                }}
                data-decon-tab={tab.id}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
          {renderTabContent()}

          {/* 手艺卡跳转区（craft 条目 → 手艺页人审）。 */}
          <div className="decon-craftzone" data-decon-craft-zone="true">
            <span className="craft-grouphead-name">{t('decon.output.craftZoneTitle')}</span>
            {craftCount !== null ? (
              <>
                <span className="materials-chip">{t('decon.output.craftZoneCount', { count: craftCount })}</span>
                <button
                  type="button"
                  className="materials-browsebtn"
                  disabled={materialId === null}
                  onClick={() => {
                    if (materialId === null) return;
                    openCraftForMaterial(materialId);
                    setActivePage('craft');
                  }}
                  data-decon-action="jump-craft"
                >
                  {t('decon.output.craftZoneJump')}
                </button>
              </>
            ) : (
              <span className="materials-form-loading">{t('decon.output.craftZoneEmpty')}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** craft 闸门分组（dim → findings 聚合——同维多 unit 行合并展示）。 */
type DeconCraftFindingGroup = {
  dim: string;
  findings: DeconFindingLike[];
};

type DeconFindingLike = {
  insight: string;
  elaboration: string;
  evidence: Array<{ paraRange: { start: number; end: number }; quote: string }>;
  craftHint: { category?: string; termHint?: string; tags?: string[] } | null;
};
