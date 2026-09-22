/**
 * 「材料」页（Story 10.1 Wave D，D7 独立左导航页；design §5.2）——摄取基座材料库管理面。
 *
 * 结构：顶部工具栏（scope 切换「本项目 ↔ 全局库」+ 刷新）/ 批量拖入导入区（拖拽 + 文件
 * 选择；进度可见 + 三档拒收回报 + failed 清单）/ 材料列表（MaterialRow 徽章行 + 行操作）/
 * provenance 展开行（ProvenanceForm 单行表单）。
 *
 * 数据流（事件刷新三件套，spec/ui/state-management）：
 * - 读 = materialsSlice.loadMaterialsList（mount 装载 + 去重）；
 * - 刷新 = material:changed 事件（slice 可见性门控 + 150ms 聚合窗）+ 打开 force 补偿
 *   （App.tsx 接线 onMaterialsPageVisibility）；
 * - 写 = deleteMaterialById（D8 四清——确认弹窗在本层，IPC 层不二次确认）/ reingest /
 *   importMaterialFiles / patchMaterialProvenance（ProvenanceForm 内）。
 *
 * 打开派生 .md（校对入口）：项目车道 = readFile + openFile 进应用内 tab（autosave +
 * watcher 重索引闭环，AC4 E2E 路径）；全局车道文件不在路径闸允许根内（reveal/open 会被
 * shell 静默拒）→ clipboard 复制路径 + toast 提示（dispatch D 波明确兜底形态）。
 */
import { useEffect, useRef, useState } from 'react';
import type { MaterialSummary } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useConfirmStore } from '../../shared/store/confirmStore';
import { useToastStore } from '../../shared/store/toastStore';
import { normalizePath } from '../../shared/utils/paths';
import { readFile } from '../../shared/api/filesystem';
import {
  copyMaterialPath,
  getMaterialDetail,
  pathForImportFile,
  revealInFolder,
} from '../../shared/api/materials';
import { MaterialRow } from './MaterialRow';
import { ImportSourcePicker } from './ImportSourcePicker';
import { OnlineImportDialog } from './OnlineImportDialog';
import { ProvenanceForm } from './ProvenanceForm';
import { materialDistillBadge } from '../craft/craftView';
import type { CraftDistillSkipReason } from '@orison/shared-contracts';

/** 浏览按钮 accept 面（白名单同 shell MATERIAL_ALLOWED_EXTENSIONS——shell 侧仍强制；10.2a += 字幕 srt/ass/vtt）。 */
const MATERIALS_IMPORT_ACCEPT = '.txt,.md,.markdown,.docx,.pdf,.epub,.srt,.ass,.vtt';

export function MaterialsPage() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const currentProject = useAppStore((s) => s.currentProject);
  const materialsScope = useAppStore((s) => s.materialsScope);
  const setMaterialsScope = useAppStore((s) => s.setMaterialsScope);
  const materialsList = useAppStore((s) => s.materialsList);
  const materialsListLoading = useAppStore((s) => s.materialsListLoading);
  const materialsListError = useAppStore((s) => s.materialsListError);
  const loadMaterialsList = useAppStore((s) => s.loadMaterialsList);
  const deleteMaterialById = useAppStore((s) => s.deleteMaterialById);
  const reingestMaterialById = useAppStore((s) => s.reingestMaterialById);
  const importMaterialFiles = useAppStore((s) => s.importMaterialFiles);
  const materialsImporting = useAppStore((s) => s.materialsImporting);
  const materialsImportProgress = useAppStore((s) => s.materialsImportProgress);
  const materialsImportFeedback = useAppStore((s) => s.materialsImportFeedback);
  const materialDetailId = useAppStore((s) => s.materialDetailId);
  const loadMaterialDetail = useAppStore((s) => s.loadMaterialDetail);
  const clearMaterialDetail = useAppStore((s) => s.clearMaterialDetail);
  const openFile = useAppStore((s) => s.openFile);
  // E10.2b W5 蒸馏联动：台账/进度（徽章源）+ 入队 + N 卡跳转（手艺页该材料过滤）。
  const craftDistillLedgers = useAppStore((s) => s.craftDistillLedgers);
  const craftDistillProgress = useAppStore((s) => s.craftDistillProgress);
  const loadCraftDistillLedgers = useAppStore((s) => s.loadCraftDistillLedgers);
  const runCraftDistill = useAppStore((s) => s.runCraftDistill);
  const openCraftForMaterial = useAppStore((s) => s.openCraftForMaterial);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const showToast = useToastStore((s) => s.showToast);
  const [dragOver, setDragOver] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  // E10.4 W4：在线导入弹窗开关（URL 直贴 / 关键词搜索两 tab）。
  const [onlineImportOpen, setOnlineImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 初装/项目切换装载（去重归 slice loadedFor；打开 force 补偿归 App visibility 接线）。
  useEffect(() => {
    void loadMaterialsList(false);
    // E10.2b：蒸馏台账装载（徽章源——craft 侧事件/打开补偿刷新，此处只管首装）。
    void loadCraftDistillLedgers(false);
  }, [loadMaterialsList, loadCraftDistillLedgers, currentProject?.path, currentProject?.projectId]);

  /**
   * 批量导入（拖入/浏览共用）：失败 throw → toast；ok:false → toast；成功回报入反馈区。
   * CR-026：拖了文件（rawCount>0）但一条绝对路径都没解析到 → pathUnavailable 警告（此前
   * 静默无反馈）；零文件零路径（空事件）静默返回不扰民。
   */
  const runImport = async (paths: string[], rawCount: number) => {
    if (paths.length === 0) {
      if (rawCount > 0) {
        showToast(t('materials.toast.pathUnavailable'), 'warning');
      }
      return;
    }
    try {
      const result = await importMaterialFiles(paths);
      if (!result.ok) {
        showToast(t('materials.import.failedTitle', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(t('materials.import.failedTitle', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  /** D8 删除：全局确认框（本层确认，IPC 层不二次确认）→ 四清 → toast。 */
  const handleDelete = async (row: MaterialSummary) => {
    const confirmed = await useConfirmStore.getState().requestConfirm({
      title: t('materials.action.deleteConfirmTitle'),
      message: t('materials.action.deleteConfirmMessage', { name: row.name }),
      confirmLabel: t('materials.action.deleteConfirmLabel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setActionBusyId(row.materialId);
    try {
      const result = await deleteMaterialById(row.materialId);
      if (result.ok) {
        showToast(t('materials.toast.deleted', { name: row.name }), 'success');
      } else {
        showToast(t('materials.toast.deleteFailed', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(t('materials.toast.deleteFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleReingest = async (row: MaterialSummary) => {
    setActionBusyId(row.materialId);
    try {
      const result = await reingestMaterialById(row.materialId);
      if (result.ok) {
        showToast(t('materials.toast.reingested', { name: row.name }), 'success');
      } else {
        showToast(t('materials.toast.reingestFailed', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(t('materials.toast.reingestFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setActionBusyId(null);
    }
  };

  /** 打开派生 .md（校对入口）：项目车道进应用内 tab；全局车道 clipboard 兜底。 */
  const handleOpenDerived = async (row: MaterialSummary) => {
    let detail;
    try {
      detail = await getMaterialDetail(row.materialId);
    } catch {
      detail = null;
    }
    const abs = detail?.derivedAbsPath ?? null;
    if (abs === null) {
      showToast(t('materials.toast.derivedMissing'), 'warning');
      return;
    }
    if (materialsScope === 'project' && currentProject !== null) {
      try {
        const content = await readFile(abs);
        // 读失败不开空 tab（mirror SettingDocsList CR P13——空内容一保存即截断有内容 md）。
        if (content === null) {
          showToast(t('materials.toast.derivedMissing'), 'warning');
          return;
        }
        const normalized = normalizePath(abs);
        openFile(normalized, normalized.split('/').pop() ?? `${row.name}.md`, content);
      } catch {
        showToast(t('materials.toast.openDerivedFailed'), 'error');
      }
      return;
    }
    const copied = await copyMaterialPath(abs);
    if (copied) {
      showToast(t('materials.toast.pathCopied', { path: abs }), 'info');
    } else {
      showToast(t('materials.toast.openDerivedFailed'), 'error');
    }
  };

  /** reveal：项目车道 showItemInFolder；全局车道（路径闸外）clipboard 兜底。 */
  const handleReveal = async (row: MaterialSummary) => {
    let detail;
    try {
      detail = await getMaterialDetail(row.materialId);
    } catch {
      detail = null;
    }
    const abs = detail?.sourceAbsPath ?? detail?.derivedAbsPath ?? null;
    if (abs === null) {
      showToast(t('materials.toast.derivedMissing'), 'warning');
      return;
    }
    if (materialsScope === 'project' && currentProject !== null) {
      revealInFolder(abs);
      return;
    }
    const copied = await copyMaterialPath(abs);
    if (copied) showToast(t('materials.toast.pathCopied', { path: abs }), 'info');
  };

  const handleToggleProvenance = (row: MaterialSummary) => {
    if (materialDetailId === row.materialId) {
      clearMaterialDetail();
    } else {
      void loadMaterialDetail(row.materialId, false);
    }
  };

  /** E10.2b：蒸馏入队（单材料——批量走手艺页/后续入口；跳过原因逐份 toast，模式 A 分文案）。 */
  const handleDistill = async (row: MaterialSummary) => {
    try {
      const result = await runCraftDistill([row.materialId]);
      if (!result.ok) {
        showToast(t('craft.distill.failedToast', { message: result.message ?? result.error }), 'error');
        return;
      }
      if (result.queued.includes(row.materialId)) {
        showToast(t('craft.distill.queuedToast'), 'success');
        return;
      }
      const skipped = result.skipped.find((s) => s.materialId === row.materialId);
      if (skipped !== undefined) {
        showToast(t(`craft.distill.skip.${skipped.reason as CraftDistillSkipReason}`), 'warning');
      }
    } catch (err) {
      showToast(t('craft.distill.failedToast', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  /** E10.2b：N 卡跳转——手艺页该材料过滤（队列 tab + materialFilter，craftSlice.openCraftForMaterial）。 */
  const handleOpenCraft = (row: MaterialSummary) => {
    openCraftForMaterial(row.materialId);
    setActivePage('craft');
  };

  const hasProject = currentProject !== null;
  const projectLaneDead = materialsScope === 'project' && !hasProject;

  return (
    <div className="materials-page" data-materials-scope={materialsScope}>
      <div className="materials-toolbar">
        <h2 className="materials-title">{t('materials.title')}</h2>
        <div className="materials-scopetabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={materialsScope === 'project'}
            className={`materials-scopetab${materialsScope === 'project' ? ' is-active' : ''}`}
            disabled={!hasProject}
            onClick={() => setMaterialsScope('project')}
          >
            {t('materials.scope.project')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={materialsScope === 'global'}
            className={`materials-scopetab${materialsScope === 'global' ? ' is-active' : ''}`}
            onClick={() => setMaterialsScope('global')}
          >
            {t('materials.scope.global')}
          </button>
        </div>
        <button
          type="button"
          className="materials-browsebtn"
          data-materials-online-import="true"
          onClick={() => setOnlineImportOpen(true)}
        >
          {t('materials.online.open')}
        </button>
        <button
          type="button"
          className="materials-iconbtn"
          aria-label={t('materials.action.refresh')}
          onClick={() => { void loadMaterialsList(true); }}
        >
          <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
        </button>
      </div>

      {/* E10.4 W4：在线导入弹窗（URL 直贴 / 关键词搜索；导入后经既有 material:changed
          事件面刷新 + 弹窗内终局 belt 重拉）。 */}
      {onlineImportOpen && <OnlineImportDialog onClose={() => setOnlineImportOpen(false)} />}

      {/* 批量拖入导入区（AC7：白名单 shell 侧强制；进度可见 + 三档拒收回报）。 */}
      <div
        className={`materials-dropzone${dragOver ? ' is-active' : ''}`}
        data-materials-dropzone="true"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files);
          const paths = files.map(pathForImportFile).filter((p) => p.length > 0);
          void runImport(paths, files.length);
        }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
      >
        <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
        <span className="materials-dropzone-label">
          {dragOver ? t('materials.import.dropzoneActive') : t('materials.import.dropzone')}
        </span>
        <button
          type="button"
          className="materials-browsebtn"
          onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
        >
          {t('materials.import.browse')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={MATERIALS_IMPORT_ACCEPT}
          className="materials-fileinput"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            const paths = files.map(pathForImportFile).filter((p) => p.length > 0);
            e.target.value = ''; // 同文件二次选择可重触发
            void runImport(paths, files.length);
          }}
        />
      </div>

      {/* 导入进度 + 三档拒收回报（反馈区呈现最近一次成功导入）+ 来源引导（C9——导入刚
          完成就地选来源可跳过，落库走 update-provenance；ImportSourcePicker 内自判空）。 */}
      {(materialsImporting || materialsImportFeedback !== null) && (
        <div className="materials-importfeedback" data-materials-import-feedback="true">
          {materialsImporting && materialsImportProgress !== null && (
            <div className="materials-importprogress" data-import-progress={`${materialsImportProgress.done}/${materialsImportProgress.total}`}>
              <div
                className="materials-importprogress-bar"
                style={{ width: `${materialsImportProgress.total === 0 ? 0 : Math.round((materialsImportProgress.done / materialsImportProgress.total) * 100)}%` }}
              />
              <span className="materials-importprogress-text">
                {t('materials.import.progress', { done: materialsImportProgress.done, total: materialsImportProgress.total })}
              </span>
            </div>
          )}
          {materialsImportFeedback !== null && (
            <div className="materials-importsummary">
              <span className="materials-importsummary-item">{t('materials.import.summary', { count: materialsImportFeedback.imported.length })}</span>
              {materialsImportFeedback.rejected.length > 0 && (
                <span className="materials-importsummary-item materials-importsummary-item--warn">
                  {t('materials.import.rejectedSummary', { count: materialsImportFeedback.rejected.length })}
                </span>
              )}
              {materialsImportFeedback.failed.length > 0 && (
                <span className="materials-importsummary-item materials-importsummary-item--warn">
                  {t('materials.import.failedSummary', { count: materialsImportFeedback.failed.length })}
                </span>
              )}
              {materialsImportFeedback.rejected.length > 0 && (
                <ul className="materials-importlist" data-rejected-list="true">
                  {materialsImportFeedback.rejected.map((r, idx) => (
                    // CR-027：key 加 idx——同名同类拒收项 React key 冲突。
                    <li key={`rej-${idx}-${r.name}-${r.kind}`}>
                      {r.name} — {t(`materials.import.rejectedKind.${r.kind}`)}
                    </li>
                  ))}
                </ul>
              )}
              {materialsImportFeedback.failed.length > 0 && (
                <ul className="materials-importlist" data-failed-list="true">
                  {materialsImportFeedback.failed.map((f, idx) => (
                    <li key={`fail-${idx}-${f.name}-${f.relPath}`}>
                      {f.name} — {f.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {materialsImportFeedback !== null && (
            <ImportSourcePicker items={materialsImportFeedback.imported} />
          )}
        </div>
      )}

      {/* 列表区。 */}
      <div className="materials-listwrap">
        {projectLaneDead ? (
          <div className="materials-empty" data-materials-empty="no-project">
            {t('materials.scope.projectDisabledHint')}
          </div>
        ) : materialsListLoading && materialsList.length === 0 ? (
          <div className="materials-empty" data-materials-empty="loading">{t('materials.list.loading')}</div>
        ) : materialsListError !== null ? (
          <div className="materials-empty materials-empty--error" data-materials-empty="error">
            {t('materials.list.error', { message: materialsListError })}
            <button type="button" className="materials-browsebtn" onClick={() => { void loadMaterialsList(true); }}>
              {t('materials.list.retry')}
            </button>
          </div>
        ) : materialsList.length === 0 ? (
          <div className="materials-empty" data-materials-empty="empty">{t('materials.list.empty')}</div>
        ) : (
          <div className="materials-list" role="list">
            <div className="materials-row materials-row--head" aria-hidden="true">
              <div className="materials-cell materials-cell--name">{t('materials.list.name')}</div>
              <div className="materials-cell materials-cell--medium">{t('materials.list.medium')}</div>
              <div className="materials-cell materials-cell--quality">{t('materials.list.quality')}</div>
              <div className="materials-cell materials-cell--chapters">{t('materials.list.chapters')}</div>
              <div className="materials-cell materials-cell--chars">{t('materials.list.chars')}</div>
              <div className="materials-cell materials-cell--time">{t('materials.list.time')}</div>
              <div className="materials-cell materials-cell--actions" />
            </div>
            {materialsList.map((row) => (
              <div role="listitem" key={row.materialId}>
                <MaterialRow
                  row={row}
                  expanded={materialDetailId === row.materialId}
                  busy={actionBusyId === row.materialId}
                  onToggleProvenance={() => handleToggleProvenance(row)}
                  onReingest={() => { void handleReingest(row); }}
                  onDelete={() => { void handleDelete(row); }}
                  onOpenDerived={() => { void handleOpenDerived(row); }}
                  onReveal={() => { void handleReveal(row); }}
                  distill={materialDistillBadge(row.materialId, craftDistillLedgers, craftDistillProgress)}
                  onDistill={() => { void handleDistill(row); }}
                  onOpenCraft={() => handleOpenCraft(row)}
                />
                {materialDetailId === row.materialId && <ProvenanceForm key={row.materialId} materialId={row.materialId} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
