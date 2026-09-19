import { useCallback, useEffect, useState } from 'react';
import type { AgyBridgeConsentState } from '@orison/shared-contracts';
import { useToastStore } from '../../shared/store/toastStore';
import { useConfirmStore } from '../../shared/store/confirmStore';
import { useAgyBridgeStore } from '../../shared/store/agyBridgeStore';
import { fetchAgyBridgeStatus, revokeAgyBridge, setAgyBridgeConsent } from '../../shared/api/agyBridge';

/**
 * 设置页「MCP 工具桥」小节（09-12 子4 W6，design §4.4/§8 交付清单 2）。挂在模型
 * 设置页（存在 CLI 形态 key 时渲染——桥只服务 CLI 模型的对话车道）。
 *
 * - 状态机四态徽标（ok / missing-consent / conflict / declined）+ 冲突规则原文与指引
 *   （不代删用户规则）+ 副本根目录路径展示（status.homeRoot 实显）。
 * - 「立即授权」：设置面自含披露摘要（副标题 + 各态提示行），点击直写同意；declined
 *   态文案说明纯文本降级后果 + 「重新授权」翻转（design §4.3：设置页可翻转重询）。
 * - 「关闭工具桥」（仅 ok 态）：confirm（danger）→ revoke——活动桥会话存在 →
 *   'active-sessions' 提示如实说明释放条件（会话闲置超时后自动回收，见
 *   BRIDGE_SESSION_IDLE_TTL_MINUTES；R11：不再给「先结束对话」这一做不到的指引）；
 *   成功 = 状态翻回未配置（真实全局零写入，无条目移除面）。挂载即拉状态（shell 每次
 *   现读，用户手改 agy settings 即时反映）。
 *
 * 独立组件本地 state（mirror UsageSettingsPage 形态：machine 级瞬态读面，不建 slice）。
 */
type Props = { t: (key: string, vars?: Record<string, string | number>) => string };

/**
 * 桥会话 idle 回收阈值（分钟）——shell 侧常量 `BRIDGE_SESSION_IDLE_TTL_MS`
 *（`apps/desktop/client/shell/main/ipc/agyBridge.ts`，默认 30min，60s 清扫一次）的 UI 镜像：
 *「关闭工具桥」被活动会话拦下时，提示必须如实说出真正的释放条件（闲置超时自动回收），
 * 所以这个数只能跟着 TTL 走——改 TTL 时两处同步校准（对称 AgyBridgeConsentDialog 的
 * AGY_GEMINI_COPY_SIZE_HINT_MB 同注同源先例），不在文案里手抄数字。
 */
export const BRIDGE_SESSION_IDLE_TTL_MINUTES = 30;

const STATE_CHIP_CLASS: Record<AgyBridgeConsentState, string> = {
  ok: 'is-ok',
  conflict: 'is-conflict',
  'missing-consent': 'is-neutral',
  declined: 'is-neutral',
};

const STATE_LABEL_KEY: Record<AgyBridgeConsentState, string> = {
  ok: 'agyBridge.stateOk',
  conflict: 'agyBridge.stateConflict',
  'missing-consent': 'agyBridge.stateMissingConsent',
  declined: 'agyBridge.stateDeclined',
};

export function AgyBridgeSection({ t }: Props) {
  const showToast = useToastStore((s) => s.showToast);
  const requestConfirm = useConfirmStore((s) => s.requestConfirm);
  const status = useAgyBridgeStore((s) => s.status);
  const setStatus = useAgyBridgeStore((s) => s.setStatus);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const view = await fetchAgyBridgeStatus();
      if (view !== null) {
        setStatus(view);
      }
      // 失败保留旧快照（敏感操作前置组件自行重拉；此处只降提示态）。
    } finally {
      // CR-19（子3 CR 批）：loading 复位走 finally——load 途中异常不得把小节永久钉在
      // 「读取中」态（fetchAgyBridgeStatus 自吞异常，但 setStatus 同步抛错会跳过复位）。
      setLoading(false);
    }
  }, [setStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  async function authorize() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await setAgyBridgeConsent('allowed');
      if (result === null || !result.ok) {
        showToast(t('agyBridge.consentWriteFailed'), 'error');
        return;
      }
      setStatus(result.view);
      if (result.view.state === 'conflict') {
        showToast(t('agyBridge.conflictBlocked'), 'warning');
        return;
      }
      showToast(t('agyBridge.authorizeDone'), 'success');
    } finally {
      // CR-19（子3 CR 批）：busy 复位走 finally——写路径异常不得把按钮永久钉死。
      setBusy(false);
    }
  }

  async function revoke() {
    if (busy) return;
    const confirmed = await requestConfirm({
      title: t('agyBridge.revokeConfirmTitle'),
      message: t('agyBridge.revokeConfirmBody'),
      confirmLabel: t('agyBridge.revoke'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await revokeAgyBridge();
      if (result === null) {
        showToast(t('agyBridge.statusFailed'), 'error');
        return;
      }
      if (!result.ok && result.error === 'active-sessions') {
        // R11（dogfood F15）：释放条件是 idle TTL（会话闲置超时自动回收），不是「对话结束」——
        // 旧文案指引用户「先结束相关对话」，照做仍关不掉（真机复现）。文案如实说释放条件。
        showToast(
          t('agyBridge.revokeActiveSessions', {
            n: result.activeSessions.length,
            minutes: BRIDGE_SESSION_IDLE_TTL_MINUTES,
          }),
          'warning',
        );
        return;
      }
      if (!result.ok && result.error === 'operation-failed') {
        // CR-8（子4 CR 批）：存储错误与活动会话占用分流——独立提示（不误导去结束会话）。
        showToast(t('agyBridge.revokeFailed'), 'error');
        return;
      }
      if (!result.ok) {
        showToast(t('agyBridge.statusFailed'), 'error');
        return;
      }
      showToast(t('agyBridge.revoked'), 'info');
      await load();
    } finally {
      // CR-19（子3 CR 批）：busy 复位走 finally（同 authorize）。
      setBusy(false);
    }
  }

  if (loading && status === null) {
    return (
      <section className="agy-bridge-section" aria-label={t('agyBridge.sectionTitle')}>
        <div className="agy-bridge-state-block">
          <span className="material-symbols-outlined is-spinning" aria-hidden="true">progress_activity</span>
          <span>{t('agyBridge.loading')}</span>
        </div>
      </section>
    );
  }

  if (status === null) {
    return (
      <section className="agy-bridge-section" aria-label={t('agyBridge.sectionTitle')}>
        <div className="agy-bridge-head">
          <h3 className="settings-page-title">{t('agyBridge.sectionTitle')}</h3>
        </div>
        <div className="agy-bridge-state-block" role="alert">
          <span className="material-symbols-outlined" aria-hidden="true">cloud_off</span>
          <span>{t('agyBridge.statusFailed')}</span>
          <button type="button" className="agy-bridge-recheck-button" onClick={() => void load()}>
            <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            {t('agyBridge.recheck')}
          </button>
        </div>
      </section>
    );
  }

  const state = status.state;

  return (
    <section className="agy-bridge-section" aria-label={t('agyBridge.sectionTitle')}>
      <div className="agy-bridge-head">
        <h3 className="settings-page-title">{t('agyBridge.sectionTitle')}</h3>
        <span className={`agy-bridge-state-chip ${STATE_CHIP_CLASS[state]}`}>
          {t(STATE_LABEL_KEY[state])}
        </span>
      </div>
      <p className="agy-bridge-section-subtitle">{t('agyBridge.sectionSubtitle')}</p>

      <div className="agy-bridge-fact">
        <span className="agy-bridge-fact-label">{t('agyBridge.homeRootLabel')}</span>
        <span className="agy-bridge-fact-value" title={status.homeRoot}>{status.homeRoot}</span>
      </div>

      {state === 'conflict' && (
        <div className="agy-bridge-conflict" role="alert">
          <span className="agy-bridge-conflict-title">{t('agyBridge.conflictTitle')}</span>
          {status.conflicts.length > 0 ? (
            <ul className="agy-bridge-conflict-rules">
              {status.conflicts.map((rule) => (
                <li key={rule}><code>{rule}</code></li>
              ))}
            </ul>
          ) : (
            // CR-19（子3 CR 批）：空 conflicts 如实展示「原因不可用」——不得伪造 ['mcp(*)']
            // 规则清单（假清单会误导用户去改一条可能根本不存在的规则）。
            <p className="agy-bridge-conflict-unavailable">{t('agyBridge.conflictReasonUnavailable')}</p>
          )}
          <span className="agy-bridge-hint">{t('agyBridge.conflictHint')}</span>
        </div>
      )}

      {state === 'declined' && (
        <p className="agy-bridge-hint">{t('agyBridge.declinedNote')}</p>
      )}
      {state === 'missing-consent' && (
        <p className="agy-bridge-hint">{t('agyBridge.missingConsentNote')}</p>
      )}
      {state === 'ok' && (
        <p className="agy-bridge-hint">{t('agyBridge.okNote')}</p>
      )}

      <div className="agy-bridge-actions">
        {state === 'ok' ? (
          <button type="button" className="agy-bridge-revoke-button" disabled={busy} onClick={() => void revoke()}>
            <span className="material-symbols-outlined" aria-hidden="true">power_settings_new</span>
            {t('agyBridge.revoke')}
          </button>
        ) : state === 'conflict' ? (
          <button type="button" className="agy-bridge-recheck-button" disabled={busy} onClick={() => void load()}>
            <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            {t('agyBridge.recheck')}
          </button>
        ) : (
          <button type="button" className="agy-bridge-authorize-button" disabled={busy} onClick={() => void authorize()}>
            <span className="material-symbols-outlined" aria-hidden="true">key</span>
            {state === 'declined' ? t('agyBridge.reauthorize') : t('agyBridge.authorize')}
          </button>
        )}
      </div>
    </section>
  );
}
