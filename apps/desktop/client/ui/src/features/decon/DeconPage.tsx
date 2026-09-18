/**
 * 「拆书」页（E10.3b W6，design §8 六段——独立左导航页）。
 *
 * 结构：左列 = 拆解会话清单（decon:list——材料名 + 档位 chip + 状态徽章）+「新建拆解」入口；
 * 右列 = 选中会话面板（DeconJobPanel：状态横幅/人审闸门卡/pass 进度/产出阅读五 tab）。
 *
 * 数据流（事件刷新三件套，spec/ui/state-management——deconSlice）：
 * - 读 = 会话清单 mount 装载（loaded 旗去重）；
 * - 刷新 = decon:progress 终态事件（150ms 聚合窗 + 可见性门控）+ 关→开 force 补偿
 *   （App.tsx 接线 onDeconPageVisibility）；
 * - 写 = create/start/pause/cancel/delete/approve-review（slice 成功回读清单+详情）。
 *
 * 材料名解析：组件本地瞬态直调 listMaterials 两车道合并（mirror CraftPage 批量池先例——
 * 视图局部数据不扩 slice）；失败静默回落 jobId/materialRef 短形。
 */
import { useCallback, useEffect, useState } from 'react';
import type { DeconJob, MaterialSummary } from '@orison/shared-contracts';
import { parseDeconMaterialRef } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { listMaterials } from '../../shared/api/materials';
import {
  deconStatusBadgeClass,
  deconStatusKey,
  deconTierLabelKey,
} from './deconView';
import { DeconJobPanel } from './DeconJobPanel';
import { DeconNewJobWizard } from './DeconNewJobWizard';

export function DeconPage() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const currentProject = useAppStore((s) => s.currentProject);
  const jobs = useAppStore((s) => s.deconJobs);
  const jobsLoading = useAppStore((s) => s.deconJobsLoading);
  const jobsError = useAppStore((s) => s.deconJobsError);
  const loadDeconJobs = useAppStore((s) => s.loadDeconJobs);
  const selectedJobId = useAppStore((s) => s.deconSelectedJobId);
  const selectDeconJob = useAppStore((s) => s.selectDeconJob);
  const wizardOpen = useAppStore((s) => s.deconWizardOpen);
  const setDeconWizardOpen = useAppStore((s) => s.setDeconWizardOpen);

  useEffect(() => {
    void loadDeconJobs(false);
  }, [loadDeconJobs]);

  // 材料名解析（两车道合并 by materialId——craft 池同款；失败静默回落短形）。
  const projectId = currentProject?.projectId ?? null;
  const [materialNames, setMaterialNames] = useState<Record<string, string>>({});
  const loadMaterialNames = useCallback(async () => {
    try {
      const merged: MaterialSummary[] = [...(await listMaterials({ scope: 'global' }))];
      if (projectId !== null) {
        merged.push(...(await listMaterials({ scope: 'project', projectId })));
      }
      const names: Record<string, string> = {};
      for (const m of merged) names[m.materialId] = m.name;
      setMaterialNames(names);
    } catch {
      setMaterialNames({});
    }
  }, [projectId]);
  useEffect(() => {
    void loadMaterialNames();
  }, [loadMaterialNames]);

  const nameForJob = (job: DeconJob): string => {
    const parsed = parseDeconMaterialRef(job.materialRef);
    if (parsed === null) return job.materialRef;
    return materialNames[parsed.materialId] ?? `${parsed.materialId.slice(0, 8)}…`;
  };

  // U7：createdAt 本地化时间戳（数据在 decon:list 行——纯渲染；坏 ISO 串防御回落原样）。
  const formatJobTime = (iso: string): string => {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return iso;
    return new Date(ts).toLocaleString(resolvedLocale);
  };

  return (
    <div className="materials-page decon-page" data-decon-page="true">
      <div className="decon-layout">
        {/* 左列：会话清单 + 新建入口。 */}
        <div className="decon-sidebar">
          <div className="materials-toolbar">
            <h2 className="materials-title">{t('decon.title')}</h2>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="materials-iconbtn"
              aria-label={t('decon.action.refresh')}
              onClick={() => {
                void loadDeconJobs(true);
                void loadMaterialNames();
              }}
              data-decon-action="refresh"
            >
              <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            </button>
            <button
              type="button"
              className="materials-browsebtn"
              onClick={() => setDeconWizardOpen(true)}
              data-decon-action="new-job"
            >
              {t('decon.list.newJob')}
            </button>
          </div>
          <div className="materials-listwrap">
            {jobsError !== null && (
              <div className="materials-empty materials-empty--error" data-decon-empty="error">
                {t('decon.list.error', { message: jobsError })}
                <button
                  type="button"
                  className="materials-browsebtn"
                  onClick={() => { void loadDeconJobs(true); }}
                >
                  {t('decon.list.retry')}
                </button>
              </div>
            )}
            {jobsLoading && jobs.length === 0 && (
              <div className="materials-empty" data-decon-empty="loading">{t('decon.list.loading')}</div>
            )}
            {!jobsLoading && jobsError === null && jobs.length === 0 && (
              <div className="materials-empty" data-decon-empty="empty">{t('decon.list.empty')}</div>
            )}
            <div className="decon-joblist" role="list" data-decon-job-count={jobs.length}>
              {jobs.map((job) => (
                <button
                  key={job.jobId}
                  type="button"
                  role="listitem"
                  className={`decon-jobrow${selectedJobId === job.jobId ? ' is-active' : ''}`}
                  onClick={() => selectDeconJob(job.jobId)}
                  data-decon-job={job.jobId}
                >
                  <span className="decon-jobrow-name">{nameForJob(job)}</span>
                  <span className="materials-cell">
                    <span className="materials-chip materials-chip--tier">{t(deconTierLabelKey(job.tier))}</span>
                    <span className={`materials-badge ${deconStatusBadgeClass(job.status)}`} data-decon-job-status={job.status}>
                      {t(deconStatusKey(job.status))}
                    </span>
                  </span>
                  {/* U7：创建时间（本地化）。 */}
                  <span className="decon-jobrow-meta">
                    <span className="decon-jobrow-time" data-decon-job-created={job.createdAt}>
                      {formatJobTime(job.createdAt)}
                    </span>
                  </span>
                  {/* U17：failed 态 error 一行截断摘要（全文在详情横幅/title 悬浮）。 */}
                  {job.status === 'failed' && job.error !== null && job.error !== '' && (
                    <span className="decon-jobrow-error" data-decon-job-error="true" title={job.error}>
                      {job.error}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 右列：选中会话面板（无选中 = 引导空态）。 */}
        <div className="decon-main">
          {selectedJobId !== null ? (
            <DeconJobPanel materialNames={materialNames} />
          ) : (
            <div className="materials-empty" data-decon-empty="no-selection">
              {t('decon.list.empty')}
            </div>
          )}
        </div>
      </div>

      {/* 新建拆解向导（模态覆盖层）。 */}
      {wizardOpen && <DeconNewJobWizard onClose={() => setDeconWizardOpen(false)} />}
    </div>
  );
}
