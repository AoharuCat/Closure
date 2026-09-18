import { useState } from 'react';
import { revisionIntentSchema } from '@orison/shared-contracts';
import type { RevisionIntent } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';

/**
 * 09-13 子3 W5（design §4.1 选区精修迁移）：RevisionIntent 确认卡——自 ChapterReviewPanel 提取
 * 的共用组件（draft stage 选区精修与终稿卡指令精修两消费面，零复制）。
 *
 * 自持 edit mode 本地态（JSON textarea / parse 错误——组件私有，两消费面语义同构）；内容字段、
 * 三按钮（确认改稿/编辑 JSON/取消）与 Story 3.7 #6 的 insight-* 视觉对齐零变更（类名/键名原位）。
 * 确认路径：view mode 直确认 compiledIntent；edit mode parse + schema 校验（坏 JSON/坏 shape
 * 显错不清卡）。取消走 caller onCancel（clearCompiledIntent + 消费面本地态清理）。
 */
export function RevisionIntentConfirmCard({ compiledIntent, inFlight, onConfirm, onCancel }: {
  compiledIntent: RevisionIntent;
  /** IPC flight（reviewResuming / intentCompiling）——禁用三按钮防重入。 */
  inFlight: boolean;
  onConfirm: (intent: RevisionIntent) => void;
  onCancel: () => void;
}) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const [editMode, setEditMode] = useState(false);
  const [editedJson, setEditedJson] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const handleConfirmFromEdit = () => {
    if (!editMode) {
      onConfirm(compiledIntent);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(editedJson);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
      return;
    }
    const validation = revisionIntentSchema.safeParse(parsed);
    if (!validation.success) {
      setEditError(validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    onConfirm(validation.data);
  };

  const handleEditToggle = () => {
    if (!editMode) {
      setEditedJson(JSON.stringify(compiledIntent, null, 2));
      setEditError(null);
      setEditMode(true);
    } else {
      setEditedJson('');
      setEditError(null);
      setEditMode(false);
    }
  };

  return (
    <div className="chapter-review-intent-card" role="region" aria-label={t('agent.intentCardTitle')}>
      {/* Story 3.7 #6（design D7）：来源 badge（修订指令）并入标题行——视觉对齐 InsightCard header
          语言；纯展示加法，内容与操作零变更，不折叠（确认卡信息即操作上下文）。 */}
      <div className="chapter-review-intent-card-title-row">
        <h4 className="chapter-review-intent-card-title">{t('agent.intentCardTitle')}</h4>
        <span className="insight-card-badge insight-card-badge--source">
          {t('agent.insight.sourceRevisionIntent')}
        </span>
      </div>

      <div className="chapter-review-intent-field">
        <strong>{t('agent.intentChangeLabel')}</strong>
        <span>{compiledIntent.change.summary}</span>
        {compiledIntent.change.details && compiledIntent.change.details.length > 0 ? (
          <ul className="chapter-review-intent-details">
            {compiledIntent.change.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="chapter-review-intent-field">
        <strong>{t('agent.intentLockedLabel')}</strong>
        {compiledIntent.lockedItems.length === 0 ? (
          <span className="chapter-review-intent-locked-empty">{t('agent.intentNoLocked')}</span>
        ) : (
          <ul className="chapter-review-intent-locked-list">
            {compiledIntent.lockedItems.map((item, i) => (
              <li key={i} className={`chapter-review-intent-locked-item is-${item.authority}`}>
                {/* Story 3.7 #6（design D7）：authority 标签并入 badge 位（insight-card-badge 基座 +
                    hard/soft 语义色 modifier，原 is-hard/is-soft token 色分保留）。 */}
                <span className={`insight-card-badge insight-card-badge--${item.authority}`}>
                  {item.authority === 'hard' ? t('agent.intentHardLock') : t('agent.intentSoftLock')}
                </span>
                <span className="chapter-review-intent-locked-field">{item.field}</span>
                {item.evidence ? (
                  <span className="chapter-review-intent-locked-evidence">{item.evidence}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="chapter-review-intent-field">
        <strong>{t('agent.intentRationaleLabel')}</strong>
        <span>{compiledIntent.rationale.note}</span>
      </div>

      <div className="chapter-review-intent-field">
        <strong>{t('agent.intentProvenanceLabel')}</strong>
        <div className="chapter-review-intent-provenance">
          <p>
            <span className="insight-card-badge insight-card-badge--hard">{t('agent.intentHardTag')}</span>
            {compiledIntent.provenance.rawUserInstruction}
          </p>
          <p>
            <span className="insight-card-badge insight-card-badge--soft">{t('agent.intentSoftTag')}</span>
            {compiledIntent.provenance.compilerNote}
          </p>
        </div>
      </div>

      {/* Edit mode：JSON textarea（人改 intent，动锁定项或调整 change）。 */}
      {editMode ? (
        <div className="chapter-review-intent-edit">
          <label htmlFor="chapter-review-intent-json">{t('agent.intentEditJson')}</label>
          <textarea
            id="chapter-review-intent-json"
            className="chapter-review-intent-json"
            value={editedJson}
            onChange={(e) => {
              setEditedJson(e.target.value);
              setEditError(null);
            }}
            disabled={inFlight}
            rows={10}
          />
          {editError ? (
            <p className="chapter-review-intent-error">{t('agent.intentEditParseFailed', { error: editError })}</p>
          ) : null}
        </div>
      ) : null}

      <div className="chapter-review-intent-actions">
        {/* Story 3.7 #6（design D7）：三按钮并入 InsightCard 按钮语言（共用 insight-card-btn class
            族：主操作=apply 填充 / 编辑·取消=secondary 描边）——纯 class 组合，事件处理零变更。 */}
        <button
          type="button"
          className="chapter-review-intent-confirm-btn insight-card-btn insight-card-btn--apply"
          onClick={handleConfirmFromEdit}
          disabled={inFlight}
        >
          {t('agent.intentConfirmRedo')}
        </button>
        <button
          type="button"
          className="chapter-review-intent-edit-btn insight-card-btn insight-card-btn--secondary"
          onClick={handleEditToggle}
          disabled={inFlight}
        >
          {editMode ? t('agent.intentExitEdit') : t('agent.intentRevise')}
        </button>
        <button
          type="button"
          className="chapter-review-intent-cancel-btn insight-card-btn insight-card-btn--secondary"
          onClick={onCancel}
          disabled={inFlight}
        >
          {t('agent.cancel')}
        </button>
      </div>
    </div>
  );
}
