import { useEffect, useMemo, useState } from 'react';
import type { RemoteModel } from '@orison/shared-contracts';
import { EditorBanner } from './EditorBanner';
import { EditorFooter } from './EditorFooter';
import { ModelDefaultsPanel } from './ModelDefaultsPanel';
import type { KeyDraft, KeyDraftHeader, KeyDraftModel } from './utils';
import { AgyTosRiskNote } from '../../shared/components/AgyTosRiskNote';

/** 超过此数自动折叠模型列表（dogfood 2026-08-21：大供应商几十个模型平铺太长）。 */
const MODEL_ENTRY_COLLAPSE_THRESHOLD = 10;

// ── CR-12（09-12 子3 CR 批）：行 key = identity，非数组 index ──
// header 行无持久 id——按对象引用经 WeakMap 派生稳定行键：增删行时幸存行的对象引用
// 不变（map/filter 都保留未触及元素的原引用）→ 键稳定 → 输入焦点不因删上面一行而
// 丢/重绑；编辑某行只替换该行对象，其余行键原样。
const headerRowKeyMap = new WeakMap<object, string>();
let headerRowSeq = 0;
function headerRowKey(header: KeyDraftHeader): string {
  let key = headerRowKeyMap.get(header);
  if (key === undefined) {
    headerRowSeq += 1;
    key = `header-row-${headerRowSeq}`;
    headerRowKeyMap.set(header, key);
  }
  return key;
}

type Props = {
  draft: KeyDraft;
  isDirty: boolean;
  onChange: (next: Partial<KeyDraft>) => void;
  onUpdateModelEntry: (index: number, values: Partial<KeyDraftModel>) => void;
  onRemoveModelEntry: (index: number) => void;
  onApply: () => void;
  onDelete: (() => void) | null;
  refreshing: boolean;
  refreshError: string | null;
  remoteModels: RemoteModel[];
  onRefreshModels: () => Promise<void>;
  notice: string | null;
  onDismissNotice: () => void;
  /** CLI 发现撞未登录态——行内登录引导旗（09-12 agy provider W4）。 */
  cliLoginHint: boolean;
  /** t 支持原生 {var} 插值（useI18n 同签名）。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
};

export function ProfileEditor({
  draft,
  isDirty,
  onChange,
  onUpdateModelEntry,
  onRemoveModelEntry,
  onApply,
  onDelete,
  refreshing,
  refreshError,
  remoteModels: _remoteModels,
  onRefreshModels,
  notice,
  onDismissNotice,
  cliLoginHint,
  t,
}: Props) {
  const [showApiKey, setShowApiKey] = useState(false);
  const isNew = draft.id === null;
  // CLI 形态（antigravity-cli）：cliExecutable 路径输入替换 baseUrl/apiKey 凭据面
  //（形态互斥——CLI 键无 HTTP 凭据）。
  const isCli = draft.protocol === 'antigravity-cli';
  const canApply = isDirty && draft.models.length > 0 && draft.models.every((m) => m.id.trim().length > 0);

  // 展示顺序：启用在前（组内保持发现序，稳定排序）。重排仅在花名册变化（切供应商/
  // 刷新模型）时发生——勾选启用/禁用不当场跳动（用户拍板：切换页面或刷新之后再生效）。
  // 排序只作用于渲染映射，draft.models 原序不动（update/remove 均按原始索引定位）。
  const rosterSignature = draft.models.map((m) => m.id).join('\n');
  const orderedIndices = useMemo(() => {
    const arr = draft.models;
    return arr
      .map((_, i) => i)
      .sort((a, b) => Number(Boolean(arr[b]!.enabled)) - Number(Boolean(arr[a]!.enabled)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id, rosterSignature]);

  const collapsible = draft.models.length > MODEL_ENTRY_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [draft.id, rosterSignature]);
  const visibleIndices = collapsible && !expanded
    ? orderedIndices.slice(0, MODEL_ENTRY_COLLAPSE_THRESHOLD)
    : orderedIndices;

  // CR-12：模型行 identity key——id 优先（重复 id 回落 id-index 消歧，空 id 回落序号）。
  // 展开态（expandedModelIds）与 React key 同源用它：删中间行后幸存行的键不变，展开态
  // 不再漂移到顶替了被删序号的另一行（旧 `${id}-${index}` 形态的 index 尾巴是漂移源）。
  const modelRowKeys: string[] = (() => {
    const seen = new Set<string>();
    return draft.models.map((m, i) => {
      const base = m.id.trim() || `model-${i}`;
      const key = seen.has(base) ? `${base}-${i}` : base;
      seen.add(base);
      return key;
    });
  })();

  // ── 09-12 子3 W4（design §5.2/§9.1「常用直出 + 高级折叠」）：key 级高级设置折叠 +
  // 模型行展开态。一层折叠不嵌套；展开态随表单会话记忆（useState，不持久化，MVP）。──
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(new Set());
  const toggleModelExpanded = (rowKey: string) => {
    setExpandedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const updateHeader = (index: number, values: Partial<KeyDraftHeader>) => {
    const customHeaders = draft.customHeaders.map((h, i) => (i === index ? { ...h, ...values } : h));
    onChange({ customHeaders });
  };
  const removeHeader = (index: number) => {
    onChange({ customHeaders: draft.customHeaders.filter((_, i) => i !== index) });
  };
  const addHeader = () => {
    onChange({ customHeaders: [...draft.customHeaders, { name: '', value: '' }] });
  };

  return (
    <section className="model-profile-editor" aria-label={t('settings.modelDetails')}>
      <header className="model-editor-header">
        <h4 className="model-editor-title">
          {isNew ? t('settings.addModel') : t('settings.modelDetails')}
        </h4>
      </header>

      {refreshError ? (
        <EditorBanner variant="error" message={`${t('settings.refreshFailedBanner')} — ${refreshError}`} />
      ) : null}
      {notice ? (
        <EditorBanner variant="notice" message={notice} onDismiss={onDismissNotice} />
      ) : null}

      <div className="model-editor-section">
        <span className="form-field-label">{t('settings.identitySection')}</span>

        <label className="form-field-input-row">
          <span className="form-field-input-label">{t('settings.profileName')}</span>
          <input
            className="form-field-input"
            value={draft.name}
            placeholder={t('settings.modelNamePlaceholder')}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>

        <label className="form-field-input-row">
          <span className="form-field-input-label">{t('settings.modelProtocol')}</span>
          <select
            className="form-field-input"
            value={draft.protocol}
            onChange={(e) => onChange({ protocol: e.target.value as KeyDraft['protocol'] })}
          >
            <option value="openai-compatible">{t('settings.protocolOpenAICompatible')}</option>
            <option value="anthropic-compatible">{t('settings.protocolAnthropicCompatible')}</option>
            <option value="antigravity-cli">{t('settings.protocolAntigravityCli')}</option>
          </select>
        </label>

        {isCli ? (
          <>
            <label className="form-field-input-row">
              <span className="form-field-input-label">{t('settings.cliExecutable')}</span>
              <input
                className="form-field-input"
                value={draft.cliExecutable}
                placeholder={t('settings.cliExecutablePlaceholder')}
                onChange={(e) => onChange({ cliExecutable: e.target.value })}
              />
            </label>
            <span className="form-field-hint">{t('settings.cliExecutableHint')}</span>
            {cliLoginHint ? (
              <span className="form-field-hint">{t('settings.cliLoginHint')}</span>
            ) : null}
            {/* ToS 灰区风险备注（用户 2026-09-12 拍板）——子5 统一为共享组件（09-12 子5
                design §6），文案单源 = settings.cliTosRiskNote，此处只消费。 */}
            <AgyTosRiskNote t={t} />
          </>
        ) : (
          <>
            <label className="form-field-input-row">
              <span className="form-field-input-label">{t('settings.baseUrl')}</span>
              <input
                className="form-field-input"
                value={draft.baseUrl}
                placeholder={draft.protocol === 'anthropic-compatible' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
                onChange={(e) => onChange({ baseUrl: e.target.value })}
              />
            </label>

            <label className="form-field-input-row">
              <span className="form-field-input-label">{t('settings.apiKey')}</span>
              <div className="form-field-input-group">
                <input
                  className="form-field-input"
                  type={showApiKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => onChange({ apiKey: e.target.value })}
                />
                <button
                  type="button"
                  className="settings-refresh-button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  aria-label={showApiKey ? t('settings.hideKey') : t('settings.showKey')}
                >
                  <span className="material-symbols-outlined">
                    {showApiKey ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </label>
          </>
        )}
      </div>

      {/* ── 09-12 子3 W4：自定义请求头（常用直出；CLI 形态无 HTTP 请求面不渲染）。
          随该 key 全部请求发送；同名覆盖内建头（覆盖鉴权头可能导致认证失败——提示说明）。── */}
      {!isCli ? (
        <div className="model-editor-section">
          <span className="form-field-label">{t('settings.customHeadersSection')}</span>
          {draft.customHeaders.length === 0 ? (
            <p className="model-editor-empty-hint">{t('settings.customHeadersEmpty')}</p>
          ) : (
            draft.customHeaders.map((header, index) => (
              <div key={headerRowKey(header)} className="headers-editor-row">
                <input
                  className="form-field-input"
                  value={header.name}
                  placeholder="X-Route-Tag"
                  aria-label={t('settings.customHeaderName')}
                  onChange={(e) => updateHeader(index, { name: e.target.value })}
                />
                <input
                  className="form-field-input"
                  value={header.value}
                  placeholder="closure"
                  aria-label={t('settings.customHeaderValue')}
                  onChange={(e) => updateHeader(index, { value: e.target.value })}
                />
                <button
                  type="button"
                  className="settings-refresh-button"
                  onClick={() => removeHeader(index)}
                  aria-label={t('settings.customHeaderRemove')}
                  title={t('settings.customHeaderRemove')}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            ))
          )}
          <button type="button" className="settings-fold-button" onClick={addHeader}>
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {t('settings.customHeaderAdd')}
          </button>
          <span className="form-field-hint">{t('settings.customHeadersHint')}</span>
        </div>
      ) : null}

      {/* ── 09-12 子3 W4：key 级「高级设置」折叠（超时 / 流式禁用 / 证书校验）。── */}
      {!isCli ? (
        <div className="model-editor-section">
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
                <span className="form-field-input-label">{t('settings.keyTimeoutSeconds')}</span>
                <input
                  className="form-field-input form-field-input-narrow"
                  inputMode="numeric"
                  value={draft.timeoutSeconds}
                  placeholder="60"
                  onChange={(e) => onChange({ timeoutSeconds: e.target.value })}
                />
              </label>
              <label className="form-field-toggle-row">
                <input
                  type="checkbox"
                  className="form-field-checkbox"
                  checked={draft.streamingDisabled}
                  onChange={(e) => onChange({ streamingDisabled: e.target.checked })}
                />
                <span className="form-field-input-label">{t('settings.keyStreamingDisabled')}</span>
              </label>
              {draft.streamingDisabled ? (
                <span className="form-field-hint">{t('settings.keyStreamingDisabledHint')}</span>
              ) : null}
              <label className="form-field-toggle-row">
                <input
                  type="checkbox"
                  className="form-field-checkbox"
                  checked={draft.verifySsl}
                  onChange={(e) => onChange({ verifySsl: e.target.checked })}
                />
                <span className="form-field-input-label">{t('settings.keyVerifySsl')}</span>
              </label>
              {draft.verifySsl ? (
                <span className="form-field-hint">{t('settings.keyVerifySslHint')}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="model-editor-section">
        <div className="model-editor-section-header">
          <span className="form-field-label">{t('settings.modelsSection')}</span>
          <button
            type="button"
            className="settings-refresh-button"
            onClick={() => void onRefreshModels()}
            disabled={refreshing}
            aria-label={t('settings.refreshModels')}
            title={t('settings.refreshModels')}
          >
            <span className={`material-symbols-outlined${refreshing ? ' spin' : ''}`}>sync</span>
          </button>
        </div>

        {draft.models.length === 0 ? (
          <p className="model-editor-empty-hint">{t('settings.noModelsHint')}</p>
        ) : (
          <div className="model-entry-list">
            {visibleIndices.map((index) => {
              const entry = draft.models[index]!;
              const rowKey = modelRowKeys[index]!;
              const modelExpanded = expandedModelIds.has(rowKey);
              return (
                <div key={rowKey} className="model-entry-block">
                  <div className="model-entry-row">
                    <label className="model-entry-toggle">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(e) => onUpdateModelEntry(index, { enabled: e.target.checked })}
                      />
                    </label>
                    <button
                      type="button"
                      className="model-entry-expand"
                      aria-expanded={modelExpanded}
                      aria-label={t('settings.modelDefaultsToggle')}
                      title={t('settings.modelDefaultsToggle')}
                      onClick={() => toggleModelExpanded(rowKey)}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">
                        {modelExpanded ? 'expand_less' : 'expand_more'}
                      </span>
                    </button>
                    <span className="model-entry-id">{entry.id}</span>
                    <span className="model-entry-alias">{entry.alias}</span>
                    <span className={`model-entry-cap model-entry-cap-${entry.capability}`}>
                      {entry.capability}
                    </span>
                    <button
                      type="button"
                      className="settings-refresh-button"
                      onClick={() => onRemoveModelEntry(index)}
                      aria-label={t('settings.removeModel')}
                      title={t('settings.removeModel')}
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                  {modelExpanded ? (
                    <ModelDefaultsPanel
                      model={entry}
                      isCli={isCli}
                      onChange={(values) => onUpdateModelEntry(index, values)}
                      t={t}
                    />
                  ) : null}
                </div>
              );
            })}
            {collapsible ? (
              <button
                type="button"
                className="model-entry-fold"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? t('settings.modelListCollapse') : t('settings.modelListExpand')}
              </button>
            ) : null}
          </div>
        )}
      </div>

      <EditorFooter
        isDirty={isDirty}
        isNew={isNew}
        canApply={canApply}
        onApply={onApply}
        onDelete={onDelete}
        t={t}
      />
    </section>
  );
}
