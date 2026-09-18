/**
 * 导入来源引导（dogfood R3 修复批 C9 / F3 / U22）——导入反馈区的「选来源（可跳过）」。
 *
 * 根因（research/materials-refresh.md §2）：摄取期 medium 缺省恒 'other'（五格式无采集
 * 时机）→ 列表来源徽章恒「其他」，导入动线上无就地补位入口。本组件在导入刚完成的反馈
 * 区逐份补：每份成功导入（materialId 在场）一行 medium + tier 下拉，选择即落库——复用
 * slice `patchMaterialProvenance` → `materials:update-provenance` partial patch（零新
 * 通道，AC8）；**不选 = 跳过零 IPC**，保持摄取缺省不强制。
 *
 * 词表纪律（design C9 拍板）：medium = `MATERIAL_MEDIUM_OPTIONS`（MaterialRow 单源）+
 * tier 四值（i18n `materials.tier.*` 现成）；**不新造「网文/出版/同人」枚举**（schema
 * 开放词表，medium+tier 组合已覆盖语义）。落库成功 slice force 重拉清单——列表徽章读
 * row.medium 立即可见，列表侧零改动。
 *
 * 失败语义：patch 失败 → 错误 toast + 该字段回跳「跳过」占位（下拉不谎报已存值——库内
 * 仍是摄取缺省）。materialId=null（orphaned——源在处理中消失，无行可 patch）不渲染。
 *
 * 批次语义（CR-13）：drafts/saved 标记是「本次导入批的引导态」，不是材料的全局事实——
 * 新一批导入反馈落地（store 换新 imported 数组 → items 引用变化）时全部重置回跳过占位，
 * 同文件重导不再显陈旧「已保存」/旧草稿。已保存字段可回跳占位（option 不禁用）：回跳是
 * 纯 UI 复位，零 patch——落库值不撤销，选新值仍即时落库。
 */
import { useState } from 'react';
import type { MaterialImportedItem, MaterialProvenancePatchInput } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { MATERIAL_MEDIUM_OPTIONS } from './MaterialRow';

type TierValue = 'original' | 'community' | 'criticism' | 'unspecified';

const TIER_OPTIONS: readonly TierValue[] = ['original', 'community', 'criticism', 'unspecified'];

/** 单份草稿（'' = 未选——跳过语义，不 patch）。 */
type SourceDraft = { medium: string; tier: string };

const EMPTY_DRAFT: SourceDraft = { medium: '', tier: '' };

export function ImportSourcePicker({ items }: { items: MaterialImportedItem[] }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const patchMaterialProvenance = useAppStore((s) => s.patchMaterialProvenance);
  const showToast = useToastStore((s) => s.showToast);

  const [drafts, setDrafts] = useState<Record<string, SourceDraft>>({});
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({});
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  // CR-13 批次重置：props 变化时调整 state（React 官方 render 期模式，无额外 Effect
  // 提交帧）。items 来自 store 的 materialsImportFeedback.imported——引用恒定到下一次
  // 导入批落新反馈为止，故引用比较即批次边界。
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    setDrafts({});
    setSavedIds({});
    setSavingIds({});
  }

  const patchable = items.filter(
    (item): item is MaterialImportedItem & { materialId: string } => item.materialId !== null,
  );
  if (patchable.length === 0) return null;

  const draftFor = (materialId: string): SourceDraft => drafts[materialId] ?? EMPTY_DRAFT;

  /** 选择即落库（partial patch 单字段）；失败回跳跳过占位 + 错误 toast。 */
  const saveField = async (
    materialId: string,
    field: keyof SourceDraft,
    patch: MaterialProvenancePatchInput['patch'],
  ) => {
    setSavingIds((prev) => ({ ...prev, [materialId]: true }));
    // 失败回跳「跳过」占位——下拉不谎报已存值（库内仍是摄取缺省）。functional 形式读最新
    // 草稿（连选 medium+tier 时一字段失败不吞另一字段的在途草稿）。
    const revert = () => {
      setDrafts((prev) => ({
        ...prev,
        [materialId]: { ...(prev[materialId] ?? EMPTY_DRAFT), [field]: '' },
      }));
    };
    try {
      const result = await patchMaterialProvenance(materialId, patch);
      if (result.ok) {
        setSavedIds((prev) => ({ ...prev, [materialId]: true }));
        return;
      }
      revert();
      showToast(t('materials.import.sourceSaveFailed', { message: result.message ?? result.error }), 'error');
    } catch (err) {
      revert();
      showToast(
        t('materials.import.sourceSaveFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setSavingIds((prev) => ({ ...prev, [materialId]: false }));
    }
  };

  /** 下拉 change：'' = 回跳跳过占位（纯 UI 复位零 patch——落库值不撤销）；非空即落库。 */
  const selectField = (
    materialId: string,
    field: keyof SourceDraft,
    next: string,
    patch: MaterialProvenancePatchInput['patch'],
  ) => {
    setDrafts((prev) => ({
      ...prev,
      [materialId]: { ...(prev[materialId] ?? EMPTY_DRAFT), [field]: next },
    }));
    if (next !== '') void saveField(materialId, field, patch);
  };

  return (
    <div className="materials-sourcepick" data-import-source-pick="true">
      <span className="materials-sourcepick-title">{t('materials.import.source.title')}</span>
      {patchable.map((item) => {
        const materialId = item.materialId;
        const draft = draftFor(materialId);
        const saving = savingIds[materialId] === true;
        return (
          <div key={materialId} className="materials-sourcerow" data-import-source-row={materialId}>
            <span className="materials-sourcerow-name" title={item.relPath}>{item.name}</span>
            <select
              className="materials-sourceselect"
              value={draft.medium}
              disabled={saving}
              aria-label={`${item.name} · ${t('materials.provenance.medium')}`}
              onChange={(e) => selectField(materialId, 'medium', e.target.value, { medium: e.target.value })}
              data-import-source-medium={materialId}
            >
              <option value="">{t('materials.import.source.skipMedium')}</option>
              {MATERIAL_MEDIUM_OPTIONS.map((m) => (
                <option key={m} value={m}>{t(`materials.medium.${m}`)}</option>
              ))}
            </select>
            <select
              className="materials-sourceselect"
              value={draft.tier}
              disabled={saving}
              aria-label={`${item.name} · ${t('materials.provenance.tier')}`}
              onChange={(e) => selectField(materialId, 'tier', e.target.value, { tier: e.target.value as TierValue })}
              data-import-source-tier={materialId}
            >
              <option value="">{t('materials.import.source.skipTier')}</option>
              {TIER_OPTIONS.map((v) => (
                <option key={v} value={v}>{t(`materials.tier.${v}`)}</option>
              ))}
            </select>
            {savedIds[materialId] === true && (
              <span className="materials-sourcerow-saved" data-import-source-saved={materialId}>
                {t('materials.import.source.saved')}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
