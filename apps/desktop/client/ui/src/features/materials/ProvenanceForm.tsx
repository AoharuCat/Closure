/**
 * provenance 后补表单（Story 10.1 Wave D，design §5.2 / F-05）——medium/tier/author/lang/
 * originDate 五字段轻量单行表单（**不用 schema-driven-forms**——那是 asset 卡全字段引擎，
 * 此处五字段自建更轻，dispatch D 波明确豁免）。
 *
 * E10.2a 扩展（design §3.3）：+=「标题」单行（name 列，materialId 路径身份不变——视频标题
 * 等显示名后补）+「简介」多行（provenance.description——来源级元数据，10.2b 蒸馏作文档级
 * 上下文消费）。name 非证明列：走独立 `materials:update-name` IPC（与 provenance patch
 * 语义分离，design §3.1），不并入 patch。
 *
 * 落盘纪律（spec/ui/schema-driven-forms 同款，mirror 设定页表单引擎先例）：
 * - **键盘字段 blur 落盘 + 离散字段 change 落盘**（name/author/lang/originDate/description
 *   blur；medium/tier select change）——每次只 patch 改动字段（partial patch，缺省不动）。
 * - **回声抑制保草稿**：materialDetail 服务器刷新（保存回读 / material:changed 事件）只在
 *   **无未存改动**时重置草稿基线——用户正在编辑时事件驱动的 detail 刷新不覆写输入中的值
 *   （dirty 旗门控）；保存成功后 dirty 按字段实际分歧重算（CR-5，见下）→ 无残留分歧时下
 *   一轮刷新自然对齐服务器真相。**基线含 name**（detail.material.name）与 description
 *   ——10.2a 新字段同门控覆盖。
 * - 空串归一 null（清空语义——「未知」即 null，schema nullable 契约）。**name 例外**：非空
 *   约束（shell 校验 trim + 非空），空串 blur = 拒绝并回显存量（mirror 设定页 CR P17 卡名
 *   rejectEmpty 先例），不发 IPC；拒绝后 dirty 按字段实际分歧重算（CR-4——空名分歧已消，
 *   他字段无草稿则回声抑制解除，服务器刷新恢复接收）。
 * - name 长度上限 = MATERIAL_NAME_MAX_CHARS（200）/ description 上限 =
 *   MATERIAL_DESCRIPTION_MAX_CHARS（2000，CR-6 三处齐的 UI 面）——shared-contracts 单源，
 *   UI maxlength 与 handler 校验同源。
 * - **dirty 按字段实际分歧重算（CR-5）**：任一保存成功（saveName/saveField）后**不整体清零**
 *   ——已存字段对齐新基线，其他字段未 blur 草稿仍分歧时保持回声抑制（detail force 重拉不吞
 *   跨字段草稿）；toast 分键：name 专属 `nameSaved`，provenance 域 `saved`。
 *
 * 组件按 materialId 由父级 key 重建（切换行 = 草稿重置，无跨行泄漏）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MATERIAL_DESCRIPTION_MAX_CHARS,
  MATERIAL_NAME_MAX_CHARS,
  type Material,
  type MaterialProvenancePatchInput,
} from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { MATERIAL_MEDIUM_OPTIONS } from './MaterialRow';

type TierValue = 'original' | 'community' | 'criticism' | 'unspecified';

const TIER_OPTIONS: readonly TierValue[] = ['original', 'community', 'criticism', 'unspecified'];

/** 草稿形态（文本字段空串承载 null——输入框无 null 态）。 */
type ProvenanceDraft = {
  name: string;
  medium: string;
  tier: TierValue;
  author: string;
  lang: string;
  originDate: string;
  description: string;
};

/**
 * 草稿 ↔ 服务器基线的字段级分歧判定（CR-4/CR-5：dirty 按实际分歧重算，非整体清零）。
 * 未 trim 对照：输入中的原样草稿（含首尾空白）与服务器值不等即分歧——保草稿优先
 * （落盘 blur 侧有 trim 对照零误发 IPC）。
 */
function draftDiffersFrom(d: ProvenanceDraft, m: Material): boolean {
  const p = m.provenance;
  return (
    d.name !== m.name ||
    d.medium !== p.medium ||
    d.tier !== p.tier ||
    d.author !== (p.author ?? '') ||
    d.lang !== (p.lang ?? '') ||
    d.originDate !== (p.originDate ?? '') ||
    d.description !== (p.description ?? '')
  );
}

export function ProvenanceForm({ materialId }: { materialId: string }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const detail = useAppStore((s) => s.materialDetail);
  const detailLoading = useAppStore((s) => s.materialDetailLoading);
  const detailError = useAppStore((s) => s.materialDetailError);
  const loadMaterialDetail = useAppStore((s) => s.loadMaterialDetail);
  const patchMaterialProvenance = useAppStore((s) => s.patchMaterialProvenance);
  const updateMaterialName = useAppStore((s) => s.updateMaterialName);
  const showToast = useToastStore((s) => s.showToast);

  const provenance = detail?.material.provenance ?? null;
  const [draft, setDraft] = useState<ProvenanceDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  /** 在途 patch 计数（连发 blur 期间抑制回声重置——save settle 前 detail 刷新是旧值）。 */
  const savingRef = useRef(0);
  /**
   * draft 镜像 ref（CR-4/CR-5）：异步 save 回调重算 dirty 时读**最新**草稿——闭包捕获的
   * detail/draft 在 await 期间会过期（用户连打字 / detail 已被 slice force 重拉翻新）。
   * useCallback 稳定引用：回声抑制 effect 可安全列 dep。
   */
  const draftRef = useRef<ProvenanceDraft | null>(null);
  const updateDraft = useCallback((next: ProvenanceDraft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  // 初装/行切换装载（幂等去重归 slice；force=false 防事件刷新链重复 IPC）。
  useEffect(() => {
    void loadMaterialDetail(materialId, false);
  }, [materialId, loadMaterialDetail]);

  // 回声抑制基线重置：detail 刷新只在（无未存改动 && 无在途保存）时重置草稿。
  // 基线含 name（detail.material.name——10.2a）与 description（provenance.description）。
  useEffect(() => {
    if (detail === null || dirty || savingRef.current > 0) return;
    updateDraft({
      name: detail.material.name,
      medium: detail.material.provenance.medium,
      tier: detail.material.provenance.tier,
      author: detail.material.provenance.author ?? '',
      lang: detail.material.provenance.lang ?? '',
      originDate: detail.material.provenance.originDate ?? '',
      description: detail.material.provenance.description ?? '',
    });
  }, [detail, dirty, updateDraft]);

  /** patch 单字段（blur/change 落盘）；空串归一 null。 */
  const saveField = async (patch: MaterialProvenancePatchInput['patch']) => {
    savingRef.current += 1;
    try {
      const result = await patchMaterialProvenance(materialId, patch);
      if (result.ok) {
        showToast(t('materials.provenance.saved'), 'success');
        // CR-5：dirty 按字段实际分歧重算（非整体清零）——已存字段对齐 result.material 新
        // 基线；其他字段未 blur 草稿仍分歧时保持抑制（slice force 重拉 detail 不吞跨字段草稿）。
        const d = draftRef.current;
        setDirty(d !== null && draftDiffersFrom(d, result.material));
      } else {
        showToast(
          t('materials.provenance.saveFailed', { message: result.message ?? result.error }),
          'error',
        );
      }
    } catch (err) {
      showToast(t('materials.provenance.saveFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      savingRef.current -= 1;
    }
  };

  /** 标题落盘（独立 `materials:update-name` 通道——name 非 provenance 域，design §3.1）。 */
  const saveName = async (name: string) => {
    savingRef.current += 1;
    try {
      const result = await updateMaterialName(materialId, name);
      if (result.ok) {
        // CR-5：name 专属 toast（「出处信息已更新」对标题编辑是错位文案）。
        showToast(t('materials.provenance.nameSaved'), 'success');
        // CR-5：dirty 按字段实际分歧重算——name 已存回（result.material 含新名），其他字段
        // 未 blur 草稿不被 setDirty(false) 后的基线重置吞掉。
        const d = draftRef.current;
        setDirty(d !== null && draftDiffersFrom(d, result.material));
      } else {
        showToast(
          t('materials.provenance.saveFailed', { message: result.message ?? result.error }),
          'error',
        );
      }
    } catch (err) {
      showToast(t('materials.provenance.saveFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      savingRef.current -= 1;
    }
  };

  /** 文本字段 blur：与服务器基线不同才落盘（无改动零 IPC；空串归一 null）。 */
  const blurTextField = (field: 'author' | 'lang' | 'originDate' | 'description') => () => {
    if (provenance === null || draft === null) return;
    const serverValue = provenance[field] ?? '';
    const next = draft[field].trim();
    if (next === serverValue) return;
    const normalized = next === '' ? null : next;
    const patch: MaterialProvenancePatchInput['patch'] =
      field === 'author'
        ? { author: normalized }
        : field === 'lang'
          ? { lang: normalized }
          : field === 'originDate'
            ? { originDate: normalized }
            : { description: normalized };
    void saveField(patch);
  };

  /**
   * 标题 blur：与服务器基线不同才落盘；**空串拒绝**（name 非空约束——shell 校验 trim +
   * 非空）——回显存量不落盘不发 IPC（mirror 设定页 CR P17 卡名 rejectEmpty 先例）。
   */
  const blurName = () => {
    if (detail === null || draft === null) return;
    const serverValue = detail.material.name;
    const next = draft.name.trim();
    if (next === serverValue) return;
    if (next === '') {
      const reverted = { ...draft, name: serverValue };
      updateDraft(reverted);
      // CR-4：拒绝后按字段实际分歧重算 dirty（原实现只回显不清 dirty → 回声抑制永久武装，
      // 服务器刷新全被吞）。空名分歧已消：他字段无未存草稿 → dirty 归零（刷新恢复接收）；
      // 他字段草稿仍在 → 保持抑制（保草稿优先）。
      setDirty(draftDiffersFrom(reverted, detail.material));
      return;
    }
    void saveName(next);
  };

  const textField = (field: 'author' | 'lang' | 'originDate', labelKey: string) => (
    <label className="materials-form-field">
      <span className="materials-form-label">{t(labelKey)}</span>
      <input
        type="text"
        className="materials-form-input"
        value={draft?.[field] ?? ''}
        placeholder="—"
        disabled={draft === null}
        onChange={(e) => {
          if (draft === null) return;
          setDirty(true);
          updateDraft({ ...draft, [field]: e.target.value });
        }}
        onBlur={blurTextField(field)}
        data-provenance-field={field}
      />
    </label>
  );

  // medium 下拉选项 = 受控词表 + 当前未知值原样补位（开放词表不谎报）。
  const mediumOptions = useMemo(() => {
    const options: string[] = [...MATERIAL_MEDIUM_OPTIONS];
    if (provenance !== null && !options.includes(provenance.medium)) {
      options.push(provenance.medium);
    }
    return options;
  }, [provenance]);

  return (
    <div className="materials-form" data-material-form={materialId}>
      <div className="materials-form-head">
        <span className="materials-form-title">{t('materials.provenance.title')}</span>
      </div>
      {detailLoading && draft === null && <div className="materials-form-loading">{t('materials.provenance.loading')}</div>}
      {detailError !== null && <div className="materials-form-error">{t('materials.provenance.loadFailed', { message: detailError })}</div>}
      <div className="materials-form-row">
        {/* 标题（name 列——10.2a 首字段；独立 update-name 通道，空串拒绝回显存量）。 */}
        <label className="materials-form-field">
          <span className="materials-form-label">{t('materials.provenance.nameLabel')}</span>
          <input
            type="text"
            className="materials-form-input"
            value={draft?.name ?? ''}
            placeholder="—"
            maxLength={MATERIAL_NAME_MAX_CHARS}
            disabled={draft === null}
            onChange={(e) => {
              setDirty(true);
              if (draft === null) return;
              updateDraft({ ...draft, name: e.target.value });
            }}
            onBlur={blurName}
            data-provenance-field="name"
          />
        </label>
        <label className="materials-form-field">
          <span className="materials-form-label">{t('materials.provenance.medium')}</span>
          <select
            className="materials-form-select"
            value={draft?.medium ?? ''}
            disabled={draft === null}
            onChange={(e) => {
              if (draft === null || provenance === null) return;
              const next = e.target.value;
              setDirty(true);
              updateDraft({ ...draft, medium: next });
              if (next !== provenance.medium) void saveField({ medium: next });
            }}
            data-provenance-field="medium"
          >
            <option value="" disabled>{t('materials.provenance.mediumPlaceholder')}</option>
            {mediumOptions.map((m) => (
              <option key={m} value={m}>{t(`materials.medium.${m}`)}</option>
            ))}
          </select>
        </label>
        <label className="materials-form-field">
          <span className="materials-form-label">{t('materials.provenance.tier')}</span>
          <select
            className="materials-form-select"
            value={draft?.tier ?? 'unspecified'}
            disabled={draft === null}
            onChange={(e) => {
              if (draft === null || provenance === null) return;
              const next = e.target.value as TierValue;
              setDirty(true);
              updateDraft({ ...draft, tier: next });
              if (next !== provenance.tier) void saveField({ tier: next });
            }}
            data-provenance-field="tier"
          >
            {TIER_OPTIONS.map((v) => (
              <option key={v} value={v}>{t(`materials.tier.${v}`)}</option>
            ))}
          </select>
        </label>
        {textField('author', 'materials.provenance.author')}
        {textField('lang', 'materials.provenance.lang')}
        {textField('originDate', 'materials.provenance.originDate')}
      </div>
      {/* 简介（多行——10.2a；provenance.description，blur 落盘走既有 patch 面，空串归 null）。 */}
      <div className="materials-form-row">
        <label className="materials-form-field">
          <span className="materials-form-label">{t('materials.provenance.description')}</span>
          <textarea
            className="materials-form-input"
            rows={2}
            value={draft?.description ?? ''}
            placeholder="—"
            maxLength={MATERIAL_DESCRIPTION_MAX_CHARS}
            disabled={draft === null}
            onChange={(e) => {
              setDirty(true);
              if (draft === null) return;
              updateDraft({ ...draft, description: e.target.value });
            }}
            onBlur={blurTextField('description')}
            data-provenance-field="description"
          />
        </label>
      </div>
    </div>
  );
}
