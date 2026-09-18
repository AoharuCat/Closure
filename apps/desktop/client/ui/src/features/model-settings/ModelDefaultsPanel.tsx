import { useState } from 'react';
import { resolveModelInfo, MODEL_DEFAULT_RANGES } from '@orison/shared-contracts';
import { formatParamRangeLabel } from './utils';
import type { KeyDraftModel, KeyDraftModelDefaults, KeyDraftModelPricing } from './utils';

type Props = {
  model: KeyDraftModel;
  /** CLI 形态（antigravity-cli）：采样/上限/extraBody 无参数面（refine 拒）——仅 contextWindow。 */
  isCli: boolean;
  onChange: (values: Partial<KeyDraftModel>) => void;
  /** t 支持原生 {var} 插值（useI18n 同签名）。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
};

/**
 * 模型条目的默认参数子面板（09-12 子3 W4，design §5.2/§9.1「常用直出 + 高级折叠」）：
 * 常用区 = temperature + pricing 三价（写作手感与看钱）；「高级设置」折叠区（默认收起）
 * = topP / 双 penalty / contextWindow / 输出上限 / extraBody。registry 已知窗口值作
 * placeholder 提示（仅提示不强制）；一层折叠不嵌套、展开态随表单会话记忆（不持久化）。
 */
export function ModelDefaultsPanel({ model, isCli, onChange, t }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const limits = resolveModelInfo(model.id).limits;
  const windowPlaceholder = limits?.contextWindow
    ? t('settings.registryValuePlaceholder', { value: limits.contextWindow })
    : '';
  const outputPlaceholder = limits?.maxOutputTokens
    ? t('settings.registryValuePlaceholder', { value: limits.maxOutputTokens })
    : '';
  // CR-15：range 占位从域常量派生（formatParamRangeLabel——单一真相源随 zod 域联动）。
  const temperaturePlaceholder = formatParamRangeLabel(MODEL_DEFAULT_RANGES.temperature);
  const topPPlaceholder = formatParamRangeLabel(MODEL_DEFAULT_RANGES.topP);
  const penaltyPlaceholder = formatParamRangeLabel(MODEL_DEFAULT_RANGES.frequencyPenalty);

  const setDefault = (field: keyof KeyDraftModelDefaults) => (e: { target: { value: string } }) =>
    onChange({ defaults: { ...model.defaults, [field]: e.target.value } });
  const setPricing = (field: keyof KeyDraftModelPricing) => (e: { target: { value: string } }) =>
    onChange({ pricing: { ...model.pricing, [field]: e.target.value } });

  return (
    <div className="model-defaults-panel" aria-label={t('settings.modelDefaultsSection')}>
      {isCli ? (
        // CLI 形态：唯一有意义的默认参数——手填窗口让 agent 压缩红线对 agy 真实上限有效。
        <label className="form-field-input-row">
          <span className="form-field-input-label">{t('settings.modelContextWindow')}</span>
          <input
            className="form-field-input"
            inputMode="numeric"
            value={model.defaults.contextWindow}
            placeholder={windowPlaceholder}
            onChange={setDefault('contextWindow')}
          />
        </label>
      ) : (
        <>
          {/* 常用区（直出） */}
          <label className="form-field-input-row">
            <span className="form-field-input-label">{t('settings.modelTemperature')}</span>
            <input
              className="form-field-input"
              inputMode="decimal"
              value={model.defaults.temperature}
              placeholder={temperaturePlaceholder}
              onChange={setDefault('temperature')}
            />
          </label>
          <label className="form-field-input-row">
            <span className="form-field-input-label">{t('settings.pricingInput')}</span>
            <input
              className="form-field-input"
              inputMode="decimal"
              value={model.pricing.inputPerMillion}
              placeholder="0.00"
              onChange={setPricing('inputPerMillion')}
            />
          </label>
          <label className="form-field-input-row">
            <span className="form-field-input-label">{t('settings.pricingOutput')}</span>
            <input
              className="form-field-input"
              inputMode="decimal"
              value={model.pricing.outputPerMillion}
              placeholder="0.00"
              onChange={setPricing('outputPerMillion')}
            />
          </label>
          <label className="form-field-input-row">
            <span className="form-field-input-label">{t('settings.pricingCachedInput')}</span>
            <input
              className="form-field-input"
              inputMode="decimal"
              value={model.pricing.cachedInputPerMillion}
              placeholder="0.00"
              onChange={setPricing('cachedInputPerMillion')}
            />
          </label>

          <button
            type="button"
            className="settings-fold-button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {advancedOpen ? 'expand_less' : 'expand_more'}
            </span>
            {t('settings.advancedSettings')}
          </button>

          {advancedOpen ? (
            <div className="model-defaults-advanced">
              <label className="form-field-input-row">
                <span className="form-field-input-label">{t('settings.modelTopP')}</span>
                <input
                  className="form-field-input"
                  inputMode="decimal"
                  value={model.defaults.topP}
                  placeholder={topPPlaceholder}
                  onChange={setDefault('topP')}
                />
              </label>
              <label className="form-field-input-row">
                <span className="form-field-input-label">{t('settings.modelFrequencyPenalty')}</span>
                <input
                  className="form-field-input"
                  inputMode="decimal"
                  value={model.defaults.frequencyPenalty}
                  placeholder={penaltyPlaceholder}
                  onChange={setDefault('frequencyPenalty')}
                />
              </label>
              <label className="form-field-input-row">
                <span className="form-field-input-label">{t('settings.modelPresencePenalty')}</span>
                <input
                  className="form-field-input"
                  inputMode="decimal"
                  value={model.defaults.presencePenalty}
                  placeholder={penaltyPlaceholder}
                  onChange={setDefault('presencePenalty')}
                />
              </label>
              <label className="form-field-input-row">
                <span className="form-field-input-label">{t('settings.modelContextWindow')}</span>
                <input
                  className="form-field-input"
                  inputMode="numeric"
                  value={model.defaults.contextWindow}
                  placeholder={windowPlaceholder}
                  onChange={setDefault('contextWindow')}
                />
              </label>
              <label className="form-field-input-row">
                <span className="form-field-input-label">{t('settings.modelMaxOutputTokens')}</span>
                <input
                  className="form-field-input"
                  inputMode="numeric"
                  value={model.defaults.maxOutputTokens}
                  placeholder={outputPlaceholder}
                  onChange={setDefault('maxOutputTokens')}
                />
              </label>
              <label className="form-field-input-column">
                <span className="form-field-input-label">{t('settings.modelExtraBody')}</span>
                <textarea
                  className="form-field-textarea"
                  rows={4}
                  spellCheck={false}
                  value={model.extraBody}
                  placeholder={'{ "safe_prompt": true }'}
                  onChange={(e) => onChange({ extraBody: e.target.value })}
                />
                <span className="form-field-hint">{t('settings.modelExtraBodyHint')}</span>
              </label>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
