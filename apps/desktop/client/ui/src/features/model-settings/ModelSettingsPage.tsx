import type { ModelConfig } from '@orison/shared-contracts';
import { ProfileList } from './ProfileList';
import { ProfileEditor } from './ProfileEditor';
import { ProfileEmptyState } from './ProfileEmptyState';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { AgyBridgeSection } from './AgyBridgeSection';
import { useModelLibrary } from './useModelLibrary';
import { useAgyBridgeStore } from '../../shared/store/agyBridgeStore';

type Props = {
  /** t 支持原生 {var} 插值（useI18n 同签名）——CR-25：弃手拼 replace。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig) => Promise<void>;
};

// dogfood 2026-08-21（#43 拍板）：任务模型/向量模型/重排模型三段迁往 Agent 页
// （ModelAssignmentSections）——本页回归纯「供应商管理」：连接（协议/密钥/baseUrl）
// 与模型启用面；「哪个环节用哪个模型」是 Agent 行为配置，不属供应商管理。

export function ModelSettingsPage({ t, modelConfig, setModelConfig }: Props) {
  const lib = useModelLibrary({ modelConfig, setModelConfig, t });
  const keys = modelConfig.keys;
  const showEmptyState = keys.length === 0 && lib.editorMode === 'idle';
  const showEditor = lib.editorMode === 'creating' || lib.editorMode === 'editing';
  // CR-19（子3 CR 批）：小节渲染 gate 含 consent 态非仅 CLI key presence——已授权用户
  // 删掉最后一个 CLI 键后小节必须留下（否则 consent 成孤儿：状态可查可关的入口消失，
  // 同意记录永远悬在盘上）。状态快照 null（未加载/读取失败）时退回 key presence 判定。
  const bridgeStatus = useAgyBridgeStore((s) => s.status);
  const bridgeConsentRecorded = bridgeStatus !== null && bridgeStatus.state !== 'missing-consent';
  const showBridgeSection = keys.some((k) => k.protocol === 'antigravity-cli') || bridgeConsentRecorded;

  return (
    <div className="settings-page model-library-page">
      <header className="settings-page-header model-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.modelConfig')}</h3>
          <p className="settings-page-subtitle">{t('settings.modelSubtitle')}</p>
        </div>
        <button type="button" className="settings-save-button" onClick={lib.startNewKey}>
          <span className="material-symbols-outlined" aria-hidden="true">add</span>
          {t('settings.addModel')}
        </button>
      </header>

      <div className="model-library-layout">
        {showEmptyState ? (
          <ProfileEmptyState variant="no-profiles" t={t} onAdd={lib.startNewKey} />
        ) : (
          <>
            <ProfileList
              keys={keys}
              activeKeyId={lib.draft.id}
              onSelectKey={lib.selectKey}
              onAddKey={lib.startNewKey}
              t={t}
            />
            {showEditor ? (
              <ProfileEditor
                draft={lib.draft}
                isDirty={lib.dirty}
                onChange={lib.updateDraft}
                onUpdateModelEntry={lib.updateModelEntry}
                onRemoveModelEntry={lib.removeModelEntry}
                onApply={() => void lib.applyDraft()}
                onDelete={lib.draft.id ? () => lib.requestDelete(lib.draft.id!) : null}
                refreshing={lib.refreshing}
                refreshError={lib.refreshError}
                remoteModels={lib.remoteModels}
                onRefreshModels={lib.refreshModels}
                notice={lib.notice}
                onDismissNotice={lib.dismissNotice}
                cliLoginHint={lib.cliLoginHint}
                t={t}
              />
            ) : (
              <ProfileEmptyState variant="no-selection" t={t} />
            )}
          </>
        )}
      </div>

      {/* 子4 W6（design §4.4）：「MCP 工具桥」小节——CLI 形态 key 编辑区旁（本页供应商
          管理面下方）；存在 CLI key 或 consent 已记录（ok/conflict/declined）时渲染
          （CR-19：防孤儿 consent 的入口收回）。 */}
      {showBridgeSection && <AgyBridgeSection t={t} />}

      <DeleteConfirmDialog
        open={lib.pendingDeleteId !== null}
        title={t('settings.deleteConfirmTitle')}
        description={
          lib.pendingDeleteKey
            ? t('settings.deleteConfirmDesc', { name: lib.pendingDeleteKey.name })
            : ''
        }
        confirmLabel={t('settings.deleteConfirmAction')}
        cancelLabel={t('projects.cancel')}
        onConfirm={() => void lib.confirmDelete()}
        onCancel={lib.cancelDelete}
      />
    </div>
  );
}
