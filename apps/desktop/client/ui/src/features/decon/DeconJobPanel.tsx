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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { renderMarkdown } from '../../shared/utils/markdown';
import { listCraftCards } from '../../shared/api/craft';
import {
  deconBannerKind,
  deconChapterUnitLabel,
  deconDimensionLabelKey,
  deconPassEtaMs,
  deconPassLabel,
  deconPendingReview,
  deconReportUnitLabel,
  deconResumeNextChapter,
  deconStatusBadgeClass,
  deconStatusKey,
  deconTierLabelKey,
  deconUnitLabel,
  formatElapsedMs,
  isDeconCanonPayloadLike,
  isDeconFindingsLike,
  isDeconStylePayloadLike,
  isDeconStyleStatsLike,
  summarizeDeconPassStates,
  type DeconUnitLabel,
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
  const reportMetasLoadedFor = useAppStore((s) => s.deconReportMetasLoadedFor);
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
  /** canon 产出 tab「AI 视图」开关（U2/F17——默认人读卡片；开 = JSON 直出，同人消费面）。 */
  const [canonAiView, setCanonAiView] = useState(false);
  /** 已自动开过首报告的 jobId:tab（F15 latch——防切 tab 清空后 effect 重置回第一篇劫持用户选择）。 */
  const autoOpenedRef = useRef<Set<string>>(new Set());

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

  // ── CR-19：U4 pass 覆盖辅行数据面（done===total 的 pass 数 / 聚合后 pass 总数）。──
  const passesCompleted = useMemo(
    () => passSummaries.filter((s) => s.done === s.total).length,
    [passSummaries],
  );

  // ── U4 总进度条数据面：主条 = 当前 pass done/total（running 事件 pass + passStates 聚合）；
  //    ETA = 已 done 单位 updatedAt 均摊 × 剩余（诚实线性外推，样本不足/已完成省略）。──
  const currentPassSummary =
    liveEvent !== undefined && liveEvent.status === 'running' && liveEvent.pass !== null
      ? passSummaries.find((s) => s.pass === liveEvent.pass) ?? null
      : null;
  const currentPassEtaMs =
    currentPassSummary !== null && detail !== null
      ? deconPassEtaMs(detail.passStates, currentPassSummary.pass)
      : null;

  // ── C7/F11：failed 续跑落点章（CR-8 条件化——仅失败点确在 p1b〔存在非 done 章号行〕时
  //    带章号；失败在后续 pass → null 中性「继续拆解」。后端 decon:start 对 failed→retry，
  //    pass_state 重入零重付）。──
  const resumeNextChapter = detail !== null ? deconResumeNextChapter(detail.passStates) : null;

  const passText = (pass: string): string => {
    const label = deconPassLabel(pass);
    return [t(label.stemKey), ...label.suffixKeys.map((k) => t(k))].join('·');
  };

  // ── CR-1 拍板 B：章引用标签单制——detail.chapterLabels（真实章标，壳侧 chapterHeadings
  //    单源）优先；缺键/detail 未装载回落「材料第 {index} 章」（deconChapterUnitLabel 单源）。──
  const chapterLabels = detail?.chapterLabels;

  const chapterText = (chapterIndex: number): string => {
    const label = deconChapterUnitLabel(chapterIndex, chapterLabels);
    return 'literal' in label
      ? label.literal
      : label.index !== undefined
        ? t(label.key, { index: label.index })
        : t(label.key);
  };

  const unitLabelText = (parsed: DeconUnitLabel): string =>
    'literal' in parsed
      ? parsed.literal
      : parsed.index !== undefined
        ? t(parsed.key, { index: parsed.index })
        : t(parsed.key);

  const unitText = (unit: string): string => {
    const parsed = deconUnitLabel(unit, chapterLabels);
    if (parsed === null) return unit; // 字面 unit（p2 域名等）原样回显
    return unitLabelText(parsed);
  };

  const reportText = (meta: DeconReportMeta): string =>
    unitLabelText(deconReportUnitLabel(meta.unit, chapterLabels));

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

  // ── F15/U3：done 后自动开首报告（latch 防切 tab 劫持用户选择）。条件全齐才触发：
  //    选中 job + done + 当前 tab 有对应报告 kind + meta 已装载（loadedFor 对齐——防旧 job
  //    meta 窗口期误开）+ 无已开内容 + 该 jobId:tab 未自动开过。──
  useEffect(() => {
    if (jobId === null || job?.status !== 'done') return;
    const kind = TAB_KINDS[outputTab];
    if (kind === undefined) return; // canon tab 走 detail.canon 非 report 面
    if (reportContentKey !== null || reportMetasLoadedFor !== jobId) return;
    const first = reportMetas.find((m) => m.kind === kind);
    if (first === undefined) return;
    const latchKey = `${jobId}:${outputTab}`;
    if (autoOpenedRef.current.has(latchKey)) return;
    autoOpenedRef.current.add(latchKey);
    openReport(first);
  }, [jobId, job?.status, outputTab, reportContentKey, reportMetas, reportMetasLoadedFor, openReport]);

  // ── U34：完成横幅「打开读法」——切 reading tab + 开首份书级读法（与自动开共用 openReport；
  //    用户显式点击不受 latch 约束；meta 未装载时由上方 effect 到点接力）。──
  const handleOpenReading = useCallback(() => {
    setOutputTab('reading');
    clearDeconReportContent();
    const first = reportMetas.find((m) => m.kind === 'book_reading');
    if (first !== undefined) openReport(first);
  }, [setOutputTab, clearDeconReportContent, reportMetas, openReport]);

  // ── F18：风格 tab 无 style_report（粗拆档不产）时回落 p3b stats 行的 styleStats 摘要。
  //    拉取走 fetchDeconProducts 缓存键 `${jobId}:p3b`（handleExportStyle 同款手法）。──
  const styleMetas = tabMetas('style');
  const styleStatsKey = `${jobId ?? ''}:p3b`;
  const styleStatsRows = productsCache[styleStatsKey];
  useEffect(() => {
    if (jobId === null || outputTab !== 'style') return;
    if (styleMetas.length > 0 || styleStatsRows !== undefined) return;
    void fetchDeconProducts(jobId, { pass: 'p3b' }).catch(() => {
      // 拉取失败回落 styleEmpty 空态（服务端数据为准）。
    });
  }, [jobId, outputTab, styleMetas.length, styleStatsRows, fetchDeconProducts]);
  const styleStats = useMemo(() => {
    if (styleMetas.length > 0) return null;
    const statsRow = (styleStatsRows ?? []).find((row) => row.unit === 'stats');
    if (statsRow === undefined) return null;
    if (!isDeconCanonPayloadLike(statsRow.payload)) return null;
    return isDeconStyleStatsLike(statsRow.payload.styleStats) ? statsRow.payload.styleStats : null;
  }, [styleMetas.length, styleStatsRows]);

  // ── 报告详情正文（U1——markdown 渲染：renderMarkdown〔shared 单源，必过 DOMPurify〕+
  //    锚点区——CR-25 E2E「锚点可追」落物）：报告行 anchors 的章标〔chapterText——CR-1 真实
  //    章标优先，缺键回落材料第 N 章〕/段落区间列表 + 引文摘要（有则显示——契约 DeconSpan
  //    今日不带 quote 字段，防御读留「有则显示」面）。scene_annotation/style_report 的 anchors
  //    同一落位（四 kind 共用单取行）。──
  const reportHtml = useMemo(
    () => (reportContent !== null ? renderMarkdown(reportContent.contentMd) : null),
    [reportContent],
  );

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
                      chapter: chapterText(anchor.chapterIndex),
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
        <div
          className="decon-reportmd agent-msg-md"
          data-decon-report-md="true"
          dangerouslySetInnerHTML={{ __html: reportHtml ?? '' }}
        />
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

  // ── U2/F17：canon 按域字段卡片。payload 是 `{evidence} + passthrough`（域内形状落注释
  //    不实施）——逐字段形态守卫，字段不在即折叠，勿假设必在；「AI 视图」开关回 JSON 直出
  //    （同人消费面）。生产形状（p2Canon）：character 画像字段嵌 `portrait`（无则平铺兜底）、
  //    relationship 嵌 `pair`、timeline 带 consistency/events/conflictNote。──
  const canonText = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

  const renderCanonField = (slug: string, labelKey: string, value: string) => (
    <div key={slug} className="decon-canonfield" data-decon-canon-field={slug}>
      <span className="decon-canonfield-label">{t(labelKey)}</span>
      <span className="decon-canonfield-value">{value}</span>
    </div>
  );

  const CANON_TEXT_FIELDS: ReadonlyArray<readonly [string, string]> = [
    ['identity', 'decon.canonCard.identity'],
    ['speechPattern', 'decon.canonCard.speechPattern'],
    ['abilities', 'decon.canonCard.abilities'],
    ['arc', 'decon.canonCard.arc'],
    ['coreTrauma', 'decon.canonCard.coreTrauma'],
    ['pillars', 'decon.canonCard.pillars'],
    ['voiceAnchors', 'decon.canonCard.voiceAnchors'],
    ['antiVoice', 'decon.canonCard.antiVoice'],
    ['neverDo', 'decon.canonCard.neverDo'],
  ];

  const renderCanonEntryFields = (domain: string, payload: Record<string, unknown>): ReactNode => {
    switch (domain) {
      case 'world': {
        const summary = canonText(payload.summary);
        return summary !== null ? renderCanonField('summary', 'decon.canonCard.summary', summary) : null;
      }
      case 'rule': {
        const statement = canonText(payload.statement) ?? canonText(payload.summary);
        return statement !== null ? renderCanonField('statement', 'decon.canonCard.statement', statement) : null;
      }
      case 'tone': {
        const baseline = canonText(payload.baseline) ?? canonText(payload.summary);
        return baseline !== null ? renderCanonField('baseline', 'decon.canonCard.baseline', baseline) : null;
      }
      case 'relationship': {
        const pair = isDeconCanonPayloadLike(payload.pair) ? payload.pair : null;
        if (pair === null) return null;
        const from = canonText(pair.from);
        const to = canonText(pair.to);
        const kind = canonText(pair.kind);
        if (from === null || to === null) return null;
        const nodes: ReactNode[] = [
          renderCanonField('pair', 'decon.canonCard.pair', `${from} → ${to}${kind !== null ? `·${kind}` : ''}`),
        ];
        const pairEvidence = isDeconCanonPayloadLike(pair.evidence) ? pair.evidence : null;
        const edgeCount =
          pairEvidence !== null &&
          typeof pairEvidence.edgeCount === 'number' &&
          Number.isFinite(pairEvidence.edgeCount)
            ? pairEvidence.edgeCount
            : null;
        if (edgeCount !== null) {
          nodes.push(
            renderCanonField('edgeCount', 'decon.canonCard.edgeCount', t('decon.canonCard.edgeCountValue', { count: edgeCount })),
          );
        }
        return nodes;
      }
      case 'timeline': {
        const nodes: ReactNode[] = [];
        const consistency = canonText(payload.consistency);
        const consistencyKey =
          consistency === 'exact' ? 'decon.canonCard.consistencyExact'
            : consistency === 'intentional_loose' ? 'decon.canonCard.consistencyLoose'
              : consistency === 'conflict' ? 'decon.canonCard.consistencyConflict'
                : null;
        if (consistencyKey !== null) {
          nodes.push(renderCanonField('consistency', 'decon.canonCard.consistency', t(consistencyKey)));
        }
        const conflictNote = canonText(payload.conflictNote);
        if (conflictNote !== null) {
          nodes.push(renderCanonField('conflictNote', 'decon.canonCard.conflictNote', conflictNote));
        }
        if (Array.isArray(payload.events) && payload.events.length > 0) {
          const rows = payload.events
            .slice(0, 20)
            .map((raw): string | null => {
              if (raw === null || typeof raw !== 'object') return null;
              const ev = raw as Record<string, unknown>;
              if (typeof ev.chapterIndex !== 'number' || !Number.isFinite(ev.chapterIndex)) return null;
              const label = canonText(ev.storyTimeLabel);
              return label !== null
                ? t('decon.canonCard.eventRow', { chapter: ev.chapterIndex, label })
                : t('decon.canonCard.eventUnannotated', { chapter: ev.chapterIndex });
            })
            .filter((row): row is string => row !== null);
          nodes.push(
            <div className="decon-canonfield" data-decon-canon-field="events" key="events">
              <span className="decon-canonfield-label">
                {t('decon.canonCard.events', { count: payload.events.length })}
              </span>
              <div className="decon-canonlist">
                {rows.map((row, i) => (
                  <div key={i} className="decon-canonlist-row">{row}</div>
                ))}
              </div>
            </div>,
          );
          if (payload.events.length > 20) nodes.push(renderTruncated(payload.events.length, 20));
        }
        return nodes;
      }
      case 'character': {
        const nodes: ReactNode[] = [];
        const portrait = isDeconCanonPayloadLike(payload.portrait) ? payload.portrait : payload;
        for (const [slug, labelKey] of CANON_TEXT_FIELDS) {
          const value = canonText(portrait[slug]);
          if (value !== null) nodes.push(renderCanonField(slug, labelKey, value));
        }
        const traits: Array<{ name: string; mutability: string; note: string | null }> = [];
        if (Array.isArray(portrait.traits)) {
          for (const raw of portrait.traits) {
            if (raw === null || typeof raw !== 'object') continue;
            const tr = raw as Record<string, unknown>;
            const name = canonText(tr.name);
            if (name === null) continue;
            traits.push({
              name,
              mutability: typeof tr.mutability === 'string' ? tr.mutability : '',
              note: canonText(tr.note),
            });
          }
        }
        if (traits.length > 0) {
          nodes.push(
            <div className="decon-canonfield" data-decon-canon-field="traits" key="traits">
              <span className="decon-canonfield-label">{t('decon.canonCard.traits')}</span>
              <div className="decon-canontraits">
                {traits.map((tr, i) => (
                  <div key={`${tr.name}-${i}`} className="decon-canontrait" data-decon-canon-trait={tr.name}>
                    <span className="decon-canontrait-name">{tr.name}</span>
                    {(tr.mutability === 'immutable' || tr.mutability === 'evolvable') && (
                      <span className="materials-chip materials-chip--muted">
                        {t(
                          tr.mutability === 'immutable'
                            ? 'decon.canonCard.traitImmutable'
                            : 'decon.canonCard.traitEvolvable',
                        )}
                      </span>
                    )}
                    {tr.note !== null && <span className="decon-canontrait-note">{tr.note}</span>}
                  </div>
                ))}
              </div>
            </div>,
          );
        }
        const aliases = Array.isArray(payload.aliases)
          ? payload.aliases.filter((a): a is string => typeof a === 'string' && a.length > 0)
          : [];
        if (aliases.length > 0) {
          nodes.push(renderCanonField('aliases', 'decon.canonCard.aliases', aliases.join('、')));
        }
        const mentions = isDeconCanonPayloadLike(payload.mentions) ? payload.mentions : null;
        if (
          mentions !== null &&
          typeof mentions.total === 'number' &&
          Number.isFinite(mentions.total) &&
          mentions.total > 0
        ) {
          nodes.push(renderCanonField('mentions', 'decon.canonCard.mentions', String(mentions.total)));
        }
        if (payload.portraitDegraded === true) {
          nodes.push(
            <div className="decon-canonfield" data-decon-canon-field="portraitDegraded" key="portraitDegraded">
              <span className="decon-canonfield-value decon-canonfield-value--muted">
                {t('decon.canonCard.portraitDegraded')}
              </span>
            </div>,
          );
        }
        return nodes;
      }
      default:
        return null;
    }
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
            <div className="decon-canonviewtoggle">
              <button
                type="button"
                className={`materials-crafttag${canonAiView ? ' is-active' : ''}`}
                onClick={() => setCanonAiView((v) => !v)}
                data-decon-canon-view={canonAiView ? 'ai' : 'human'}
              >
                {t('decon.canonCard.aiView')}
              </button>
            </div>
            {[...domains.entries()].map(([domain, entries]) => (
              <div key={domain} className="decon-gate-domain">
                <div className="craft-grouphead">
                  <span className="craft-grouphead-name">
                    {t('decon.review.canonEntries', { domain: t(`decon.canonDomain.${domain}`), count: entries.length })}
                  </span>
                </div>
                {entries.map((entry) => {
                  const payloadOk = isDeconCanonPayloadLike(entry.payload);
                  return (
                    <div key={`${domain}-${entry.name}`} className="decon-canonentry" data-decon-canon-entry={entry.name}>
                      <div className="decon-canonentry-head">
                        <span className="decon-canonentry-name">{entry.name}</span>
                        <span
                          className={`materials-chip${entry.payload.evidence === 'exact' ? ' materials-chip--tier' : ' materials-chip--muted'}`}
                          data-decon-canon-evidence={entry.payload.evidence}
                        >
                          {t(
                            entry.payload.evidence === 'exact'
                              ? 'decon.canonCard.evidenceExact'
                              : 'decon.canonCard.evidenceInferred',
                          )}
                        </span>
                      </div>
                      {canonAiView ? (
                        <span className="decon-canonentry-payload">{JSON.stringify(entry.payload)}</span>
                      ) : (
                        payloadOk && renderCanonEntryFields(domain, entry.payload)
                      )}
                      <div className="decon-canonmeta" data-decon-canon-meta="true">
                        {t('decon.canonCard.anchorsCount', { count: entry.anchors.length })}
                        {entry.provenance.bookTitle !== null
                          ? `·${t('decon.canonCard.provenance', { book: entry.provenance.bookTitle })}`
                          : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      }
      case 'style': {
        return (
          <>
            {styleMetas.length === 0 ? (
              // F18：无 style_report（粗拆档不产）→ 回落 p3b stats 行的 styleStats 三数字摘要。
              styleStats !== null ? (
                <div className="decon-stylestats" data-decon-style-stats="true">
                  <div className="craft-grouphead">
                    <span className="craft-grouphead-name">{t('decon.output.styleStatsTitle')}</span>
                  </div>
                  <div className="decon-canonfield" data-decon-style-stat="sentence">
                    <span className="decon-canonfield-label">{t('decon.output.styleSentenceLabel')}</span>
                    <span className="decon-canonfield-value">
                      {t('decon.output.styleDistribution', {
                        count: styleStats.sentenceChars.count,
                        avg: Math.round(styleStats.sentenceChars.avg),
                        max: styleStats.sentenceChars.max,
                      })}
                    </span>
                  </div>
                  <div className="decon-canonfield" data-decon-style-stat="paragraph">
                    <span className="decon-canonfield-label">{t('decon.output.styleParagraphLabel')}</span>
                    <span className="decon-canonfield-value">
                      {t('decon.output.styleDistribution', {
                        count: styleStats.paragraphChars.count,
                        avg: Math.round(styleStats.paragraphChars.avg),
                        max: styleStats.paragraphChars.max,
                      })}
                    </span>
                  </div>
                  <div className="decon-canonfield" data-decon-style-stat="dialogue">
                    <span className="decon-canonfield-label">{t('decon.output.styleDialogueLabel')}</span>
                    <span className="decon-canonfield-value">
                      {t('decon.output.styleDialogueRatio', {
                        ratio: Math.round(styleStats.dialogueLineRatio * 100),
                      })}
                    </span>
                  </div>
                  <div className="materials-form-loading" data-decon-style-needs-fine="true">
                    {t('decon.output.styleNeedsFine')}
                  </div>
                </div>
              ) : (
                <div className="materials-empty" data-decon-tab-empty="style">{t('decon.output.styleEmpty')}</div>
              )
            ) : (
              <div className="decon-reportview">
                <div className="decon-reportlist">
                  {styleMetas.map((meta) => (
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
          return (
            <div className="materials-empty" data-decon-tab-empty={outputTab}>
              {t(emptyKey)}
              {/* U5：粗拆档会话的章评/细批空态注明档位解锁（章评细拆+ / 细批深度档）。 */}
              {job?.tier === 'coarse' && (outputTab === 'chapters' || outputTab === 'scenes') && (
                <div className="materials-form-loading" data-decon-coarse-locked="true">
                  {t('decon.output.coarseLockedHint')}
                </div>
              )}
            </div>
          );
        }
        // U5：reading 正文区空态 hint（点行才加载——F15 自动开为正路，hint 作 belt）。
        const hintKey = outputTab === 'reading' ? 'decon.output.selectReport'
          : outputTab === 'chapters' ? 'decon.output.selectChapter'
            : 'decon.output.selectScene';
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
              {!reportContentLoading && reportContent === null && (
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
        {(job?.status === 'pending' || job?.status === 'paused' || job?.status === 'capped' || job?.status === 'failed') && (
          <button type="button" className="materials-browsebtn" disabled={actionBusy} onClick={() => { void handleStart(); }} data-decon-action="resume">
            {job?.status === 'pending'
              ? t('decon.wizard.start')
              : job?.status === 'failed'
                // CR-8：失败点确在 p1b 才带章号（chapterText 真实章标——CR-1）；后续 pass 失败
                // 用中性「继续拆解」（重入点归后端 pass_state 台账，不假造章号）。
                ? (resumeNextChapter !== null
                    ? t('decon.action.resumeFromChapter', { chapter: chapterText(resumeNextChapter) })
                    : t('decon.action.resumeDecon'))
                : t('decon.action.resume')}
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
        {/* 删除降次按钮（U35——失败恢复动线里「继续」是主 CTA，删除是破坏性兜底）。 */}
        <button
          type="button"
          className="materials-browsebtn decon-action--secondary"
          disabled={actionBusy}
          onClick={() => { void handleDelete(); }}
          data-decon-action="delete"
        >
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
          {banner === 'done' && (
            <>
              {t('decon.banner.done')}
              {/* U34：完成横幅内嵌「打开读法」——切 reading tab + 开首份书级读法（与 F15
                  自动开共用 openReport）。 */}
              <button
                type="button"
                className="decon-banner-open"
                onClick={handleOpenReading}
                data-decon-action="open-reading"
              >
                {t('decon.banner.openReading')}
              </button>
            </>
          )}
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

          {/* pass 进度（U4 总进度条 + 聚合行 + 当前相位）。 */}
          <div className="decon-progress" data-decon-progress={passSummaries.length}>
            {currentPassSummary !== null && (
              <div className="decon-progress-total" data-decon-progress-total={currentPassSummary.pass}>
                <div
                  className="decon-progress-total-bar"
                  style={{
                    width: `${
                      currentPassSummary.total === 0
                        ? 0
                        : Math.round((currentPassSummary.done / currentPassSummary.total) * 100)
                    }%`,
                  }}
                />
                <span className="decon-progress-total-text">
                  {t('decon.progress.total', {
                    done: currentPassSummary.done,
                    total: currentPassSummary.total,
                  })}
                  {currentPassEtaMs !== null
                    ? `·${t('decon.progress.eta', { eta: formatElapsedMs(currentPassEtaMs) })}`
                    : ''}
                </span>
              </div>
            )}
            {liveEvent !== undefined && liveEvent.status === 'running' && liveEvent.pass !== null && (
              <div className="decon-progress-current" data-decon-progress-current={liveEvent.pass}>
                <span className="material-symbols-outlined" aria-hidden="true">progress_activity</span>
                {passText(liveEvent.pass)}
                {liveEvent.unit != null && liveEvent.unit !== ''
                  ? `·${
                      currentPassSummary !== null && /^[0-9]+$/.test(liveEvent.unit)
                        ? t('decon.progress.unitOfTotal', {
                            unit: unitText(liveEvent.unit),
                            total: currentPassSummary.total,
                          })
                        : unitText(liveEvent.unit)
                    }`
                  : ''}
                {`·${formatElapsedMs(liveEvent.elapsedMs ?? 0)}`}
              </div>
            )}
            {/* CR-19：U4 pass 覆盖辅行（已完成 pass 数/总 pass 数——X = done===total 的 pass，
                Y = 聚合后 pass 总数；化石-only pass 已在聚合层滤除）。 */}
            {passSummaries.length > 0 && (
              <div
                className="decon-progress-coverage"
                data-decon-progress-passes={`${passesCompleted}/${passSummaries.length}`}
              >
                {t('decon.progress.passCoverage', {
                  done: passesCompleted,
                  total: passSummaries.length,
                })}
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
