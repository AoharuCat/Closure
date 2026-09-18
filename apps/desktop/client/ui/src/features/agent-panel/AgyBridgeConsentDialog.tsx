import { useCallback, useEffect, useRef, useState } from 'react';
import { useDialogA11y } from '../../shared/hooks/useDialogA11y';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { useAgyBridgeStore } from '../../shared/store/agyBridgeStore';
import { fetchAgyBridgeStatus, setAgyBridgeConsent } from '../../shared/api/agyBridge';
import { AgyTosRiskNote } from '../../shared/components/AgyTosRiskNote';

/**
 * 披露「约 17MB」的尺度来源（CR-18，子4 CR 批）：W0 装机实测快照（2026-09-12，
 * agy 1.2.2 的 `~/.gemini` 体积）——**探测常量单源**（shell 侧披露常量
 * AGY_GEMINI_COPY_SIZE_HINT_MB 同注同源），agy 升级后体积漂移须两处同步校准，
 * 不在文案里手抄数字。
 */
export const AGY_GEMINI_COPY_SIZE_HINT_MB = 17;

/**
 * agy MCP 工具桥知情同意对话框（09-12 子4 W6，design §4.3/§8 交付清单 1）。
 *
 * 触发链：agent 对话流 lane rejected → error 事件（`agy_bridge_consent|state=...` 前缀）
 * → agentEvents 分发器解析 → agyBridgeStore.ask → App 层条件挂载本组件（mirror
 * StyleInputDialog 的 App 级 modal——对话流可能在任何视图触发，勿挂 AgentPanel）。
 *
 * 两态两路（dispatch 拍板：对话框只有「立即授权」/「暂不启用」两路，关闭 = 记住拒绝，
 * 无其他绕过面）：
 * - missing-consent：披露四件（拷贝内容〔含缓存登录凭据〕/ 落点〔副本根路径实显〕/
 *   生命周期/全局零写入）+ ToS 备注（共享组件 AgyTosRiskNote——文案单源
 *   settings.cliTosRiskNote，不立第二文案源）。「立即授权」= allowed（写后若用户
 *   deny/ask 规则压住 → 翻冲突态展示指引）；「暂不启用」/Esc/遮罩/X = declined
 *   （持久记住——AC6 纯文本降级 + 提示；重开只经设置页，无绕过面）。
 * - conflict：列冲突规则原文 + 指引用户自行调整（不代删用户规则）；仅「关闭」
 *   （纯收起，不持久化任何同意值——冲突不是同意问题的答案）。
 *
 * 同意后本次运行**不自动重试**（design §4.3——同意动作与生成动作解耦）：toast 指引
 * 用户重发；错误条的既有重试钮即重发入口。
 *
 * CR-11（子4 CR 批）：busy 期间（in-flight authorize/decline）Esc/遮罩/X 不得触发
 * declined 并发写——与 authorize 竞速会把用户刚点的「允许」翻成「拒绝」落盘。
 * 用 ref 守卫（React state 在同事件批内不即时可见，ref 同步置位零竞窗）。
 */
export function AgyBridgeConsentDialog() {
  const ask = useAgyBridgeStore((s) => s.ask);
  const homeRoot = useAgyBridgeStore((s) => s.status?.homeRoot);
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const showToast = useToastStore((s) => s.showToast);
  const { t } = useI18n(resolvedLocale);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const open = ask !== null;
  const inConflict = ask?.state === 'conflict';

  const closeAsk = useAgyBridgeStore((s) => s.closeAsk);
  const openAsk = useAgyBridgeStore((s) => s.openAsk);
  const setStatus = useAgyBridgeStore((s) => s.setStatus);

  /** 拒绝 = 持久记住（AC6）：对话框的一切「不走授权」出口（暂不启用钮/X/Esc/遮罩）都收敛到这。 */
  const decline = useCallback(async () => {
    if (busyRef.current || useAgyBridgeStore.getState().ask === null) return;
    busyRef.current = true;
    setBusy(true);
    const result = await setAgyBridgeConsent('declined');
    busyRef.current = false;
    setBusy(false);
    if (result === null || !result.ok) {
      showToast(t('agyBridge.declineWriteFailed'), 'error');
      return;
    }
    setStatus(result.view);
    showToast(t('agyBridge.consentDeclinedDone'), 'info');
    closeAsk();
  }, [closeAsk, setStatus, showToast, t]);

  /** 关闭语义二分：冲突态 = 纯收起（不持久化）；征询态 = 拒绝记住。busy 期间一律不吃（CR-11）。 */
  const handleDismiss = useCallback(() => {
    if (busyRef.current) return; // CR-11：in-flight authorize/decline 期间的 Esc/遮罩/X 零并发写
    const current = useAgyBridgeStore.getState().ask;
    if (current === null) return;
    if (current.state === 'conflict') {
      closeAsk();
      return;
    }
    void decline();
  }, [closeAsk, decline]);

  useDialogA11y(dialogRef, handleDismiss);

  // 打开时拉状态面（每次现读同 shell 语义）：副本根路径实显 + 冲突面即时刷新
  //（征询期间用户/外部改了 agy settings → conflict 即时反映；cancelled 防在途落到已关对话框）。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchAgyBridgeStatus().then((view) => {
      if (cancelled || view === null) return;
      setStatus(view);
      if (view.state === 'conflict') {
        openAsk({ state: 'conflict', conflicts: view.conflicts });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, setStatus, openAsk]);

  async function authorize() {
    if (busyRef.current || ask === null) return;
    busyRef.current = true;
    setBusy(true);
    const result = await setAgyBridgeConsent('allowed');
    busyRef.current = false;
    setBusy(false);
    if (result === null || !result.ok) {
      showToast(t('agyBridge.consentWriteFailed'), 'error');
      return;
    }
    setStatus(result.view);
    if (result.view.state === 'conflict') {
      // 同意已落盘但用户 deny/ask 规则压住（allow 被压制）→ 翻冲突态：列规则原文 +
      // 指引自行调整（E2E 三态之「冲突（阻断 + 指引文案）」）。
      openAsk({ state: 'conflict', conflicts: result.view.conflicts });
      return;
    }
    showToast(t('agyBridge.consentAuthorizeDone'), 'success');
    closeAsk();
  }

  if (!open || ask === null) return null;

  return (
    <div
      className="agybridge-consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('agyBridge.consentTitle')}
      onClick={handleDismiss}
    >
      <div
        className="agybridge-consent-dialog"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="agybridge-consent-header">
          <h2>{t('agyBridge.consentTitle')}</h2>
          <button
            type="button"
            className="agybridge-consent-close"
            aria-label={t('agyBridge.close')}
            onClick={handleDismiss}
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </header>
        <p className="agybridge-consent-intro">{t('agyBridge.consentIntro')}</p>

        <div className="agybridge-consent-body">
          {inConflict ? (
            <div className="agybridge-consent-conflict" role="alert">
              <span className="agybridge-consent-conflict-title">{t('agyBridge.conflictTitle')}</span>
              <ul className="agybridge-conflict-rules">
                {(ask.conflicts.length > 0 ? ask.conflicts : ['mcp(*)']).map((rule) => (
                  <li key={rule}><code>{rule}</code></li>
                ))}
              </ul>
              <span className="agybridge-consent-hint">{t('agyBridge.conflictHint')}</span>
            </div>
          ) : (
            <>
              <dl className="agybridge-disclosure">
                <dt>{t('agyBridge.disclosureCopiesLabel')}</dt>
                {/* CR-18：MB 数走探测常量插值（单源注明来源——不手抄数字）。 */}
                <dd>{t('agyBridge.disclosureCopies', { sizeMb: AGY_GEMINI_COPY_SIZE_HINT_MB })}</dd>
              </dl>
              <dl className="agybridge-disclosure">
                <dt>{t('agyBridge.disclosureWhereLabel')}</dt>
                <dd>
                  {t('agyBridge.disclosureWhere')}
                  {homeRoot ? <span className="agybridge-disclosure-path" title={homeRoot}>{homeRoot}</span> : null}
                </dd>
              </dl>
              <dl className="agybridge-disclosure">
                <dt>{t('agyBridge.disclosureLifecycleLabel')}</dt>
                <dd>{t('agyBridge.disclosureLifecycle')}</dd>
              </dl>
              <dl className="agybridge-disclosure">
                <dt>{t('agyBridge.disclosureNoGlobalWriteLabel')}</dt>
                <dd>{t('agyBridge.disclosureNoGlobalWrite')}</dd>
              </dl>
              <AgyTosRiskNote t={t} className="agybridge-consent-tos" />
              <p className="agybridge-consent-hint">{t('agyBridge.declineHint')}</p>
            </>
          )}
        </div>

        <footer className="agybridge-consent-footer">
          {inConflict ? (
            <button type="button" disabled={busy} onClick={handleDismiss}>
              {t('agyBridge.close')}
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void decline()}>
                {t('agyBridge.decline')}
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void authorize()}>
                {t('agyBridge.authorize')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
