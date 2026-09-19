import { useCallback, useEffect, useState } from 'react';
import type { AgyTextAgentFileState, AgyTextAgentStatusView } from '@orison/shared-contracts';
import { useToastStore } from '../../shared/store/toastStore';
import {
  disableAgyTextAgent,
  enableAgyTextAgent,
  fetchAgyTextAgentStatus,
} from '../../shared/api/agyTextAgent';

/**
 * 设置页「Closure 文本 Agent」小节（09-19 CLI 白名单 W4，prd R4/R6 + design §1.3/§3.2）。
 * 挂在模型设置页 agy 区（桥卡/探测卡一带；存在 CLI 形态 key 时渲染——纯文本车道只在
 * 有 agy CLI 模型时存在）。
 *
 * - 🔑 默认开启（opt-out，用户拍板 2026-09-19）：无 declined 记录 = 开启；本卡是唯一
 *   知情面——行为披露常显（写什么文件/放哪里〔路径取自 IPC status，不前端硬编码〕/
 *   每次启动版本对账注入最新/关闭即删自有文件/与桥同意相互独立），无首用阻塞对话框。
 * - 开关：关闭直接翻转（披露已常显，confirm 可省）→ disable（删自有文件 + 记住）；
 *   开启 → enable（失败错误面如实——外来冲突 / 写失败分流，冲突块就地呈现 + 重拉）。
 * - 「立即写入」次级钮（CR-9①）：enabled 且 missing/stale 时在位——不必等下次启动对账
 *   / 先关再开，一键补写最新（复用 enable 通道：清 declined〔no-op〕+ 写文件）。
 * - 文件四态行（current/stale/missing/foreign）+ foreign 冲突块（完整路径 + 「不代删」
 *   指引）+ `shadowedBy` 非空警示块（同名 agent 与 Closure 文本 Agent 静默竞速——
 *   加载结果未定义〔探针未定谳胜者〕；列路径，建议改名，不代删）。
 * - 状态刷新：进设置页挂载拉一次；动作后用回显视图/重拉收敛。无轮询（启动对账 +
 *   动作后刷新足够——follow 既有卡片刷新模式）。
 *
 * 独立组件本地 state（mirror AgyBridgeSection / AgyProbeSection 形态：机器级瞬态读面，
 * 不建 slice）。
 */

/** 文件四态 → 徽标配色：current=成功色 / stale=警示色 / missing=中性 / foreign=错误色。 */
const FILE_STATE_CHIP_CLASS: Record<AgyTextAgentFileState, string> = {
  current: 'is-ok',
  stale: 'is-warn',
  missing: 'is-neutral',
  foreign: 'is-conflict',
};

const FILE_STATE_LABEL_KEY: Record<AgyTextAgentFileState, string> = {
  current: 'agyTextAgent.stateCurrent',
  stale: 'agyTextAgent.stateStale',
  missing: 'agyTextAgent.stateMissing',
  foreign: 'agyTextAgent.stateForeign',
};

type Props = { t: (key: string, vars?: Record<string, string | number>) => string };

export function AgyTextAgentSection({ t }: Props) {
  const showToast = useToastStore((s) => s.showToast);
  const [status, setStatus] = useState<AgyTextAgentStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const view = await fetchAgyTextAgentStatus();
      if (view !== null) {
        setStatus(view);
      }
      // 失败保留旧快照（敏感操作前置组件自行重拉；此处只降提示态）。
    } finally {
      // CR-19 同款纪律：loading 复位走 finally——load 途中异常不得把小节永久钉死。
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function turnOn() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await enableAgyTextAgent();
      if (result === null) {
        showToast(t('agyTextAgent.statusFailed'), 'error');
        return;
      }
      if (!result.ok) {
        // 失败错误面如实分流：外来冲突（拒写不覆盖）与写失败各自成文案；重拉状态让
        // 冲突块/陈旧块就地呈现（enable 的错误结果不带视图）。
        showToast(
          result.error === 'foreign-conflict'
            ? t('agyTextAgent.enableForeignConflict')
            : t('agyTextAgent.enableFailed'),
          'error',
        );
        await load();
        return;
      }
      setStatus(result.view);
      showToast(t('agyTextAgent.enableDone'), 'success');
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (busy) return;
    // 无 confirm：行为披露常显（关闭即删自有文件、外来文件绝不触碰），直接翻转。
    setBusy(true);
    try {
      const result = await disableAgyTextAgent();
      if (result === null) {
        showToast(t('agyTextAgent.statusFailed'), 'error');
        return;
      }
      if (!result.ok) {
        // CR-9②：失败也重拉状态（mirror turnOn——disable 失败不带视图，重拉让卡面
        // 收敛到盘上真相，不留陈旧开关/文件态）+ 错误 toast。
        showToast(t('agyTextAgent.disableFailed'), 'error');
        await load();
        return;
      }
      setStatus(result.view);
      showToast(t('agyTextAgent.disableDone'), 'info');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 「立即写入」（CR-9①）：enabled 且 missing/stale 时在位——复用 enable 通道
   *（清 declined〔此态下 no-op〕+ 立即补写最新），语义 toast 区分于「开启」。
   */
  async function writeNow() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await enableAgyTextAgent();
      if (result === null) {
        showToast(t('agyTextAgent.statusFailed'), 'error');
        return;
      }
      if (!result.ok) {
        showToast(
          result.error === 'foreign-conflict'
            ? t('agyTextAgent.enableForeignConflict')
            : t('agyTextAgent.enableFailed'),
          'error',
        );
        await load();
        return;
      }
      setStatus(result.view);
      showToast(t('agyTextAgent.writeNowDone'), 'success');
    } finally {
      setBusy(false);
    }
  }

  if (loading && status === null) {
    return (
      <section className="agy-text-agent-section" aria-label={t('agyTextAgent.sectionTitle')}>
        <div className="agy-bridge-state-block">
          <span className="material-symbols-outlined is-spinning" aria-hidden="true">progress_activity</span>
          <span>{t('agyTextAgent.loading')}</span>
        </div>
      </section>
    );
  }

  if (status === null) {
    return (
      <section className="agy-text-agent-section" aria-label={t('agyTextAgent.sectionTitle')}>
        <div className="agy-text-agent-head">
          <h3 className="settings-page-title">{t('agyTextAgent.sectionTitle')}</h3>
        </div>
        <div className="agy-bridge-state-block" role="alert">
          <span className="material-symbols-outlined" aria-hidden="true">cloud_off</span>
          <span>{t('agyTextAgent.statusFailed')}</span>
          <button type="button" className="agy-bridge-recheck-button" onClick={() => void load()}>
            <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            {t('agyTextAgent.recheck')}
          </button>
        </div>
      </section>
    );
  }

  const enabled = status.enabled;
  const fileState = status.fileState;

  return (
    <section className="agy-text-agent-section" aria-label={t('agyTextAgent.sectionTitle')}>
      <div className="agy-text-agent-head">
        <h3 className="settings-page-title">{t('agyTextAgent.sectionTitle')}</h3>
        <span className={`agy-text-agent-state-chip ${enabled ? 'is-ok' : 'is-neutral'}`}>
          {t(enabled ? 'agyTextAgent.stateEnabled' : 'agyTextAgent.stateDisabled')}
        </span>
      </div>
      <p className="agy-text-agent-section-subtitle">{t('agyTextAgent.sectionSubtitle')}</p>

      {/* 行为披露（常显——α 默认开启的知情面；mirror 桥对话框四件套语汇，紧凑一档）。 */}
      <ul className="agy-text-agent-disclosure">
        <li>{t('agyTextAgent.disclosureFile')}</li>
        <li>{t('agyTextAgent.disclosureReconcile')}</li>
        <li>{t('agyTextAgent.disclosureDisable')}</li>
        <li>{t('agyTextAgent.disclosureIndependent')}</li>
      </ul>

      {/* 写入位置（路径单源 = IPC status.agentFilePath，不前端硬编码）。 */}
      <div className="agy-text-agent-fact">
        <span className="agy-text-agent-fact-label">{t('agyTextAgent.filePathLabel')}</span>
        <span className="agy-text-agent-fact-value" title={status.agentFilePath}>
          {status.agentFilePath}
        </span>
      </div>

      {/* 文件四态行。 */}
      <div className="agy-text-agent-fact">
        <span className="agy-text-agent-fact-label">{t('agyTextAgent.fileStateLabel')}</span>
        <span className={`agy-text-agent-state-chip ${FILE_STATE_CHIP_CLASS[fileState]}`}>
          {t(FILE_STATE_LABEL_KEY[fileState])}
        </span>
      </div>

      {enabled && fileState === 'current' && (
        <p className="agy-text-agent-hint">{t('agyTextAgent.noteCurrent')}</p>
      )}
      {enabled && fileState === 'stale' && (
        <p className="agy-text-agent-hint">{t('agyTextAgent.noteStale')}</p>
      )}
      {enabled && fileState === 'missing' && (
        <p className="agy-text-agent-hint">{t('agyTextAgent.noteMissing')}</p>
      )}
      {!enabled && <p className="agy-text-agent-hint">{t('agyTextAgent.disabledNote')}</p>}
      {/* CR-9③：noKeyNote 死分支已删——本小节由 ModelSettingsPage 的 `cliKeys.length > 0`
          门控渲染，status.cliKeyPresent 恒 true，无键态不可达。 */}

      {/* 外来文件冲突块（路径级：我方写入位置被无 Closure 标记的文件占用）。 */}
      {fileState === 'foreign' && (
        <div className="agy-text-agent-conflict" role="alert">
          <span className="agy-text-agent-conflict-title">{t('agyTextAgent.foreignTitle')}</span>
          <code>{status.agentFilePath}</code>
          <span className="agy-text-agent-hint">{t('agyTextAgent.foreignHint')}</span>
        </div>
      )}

      {/* 同名遮蔽警示块（frontmatter name 级：agy 对同名零警告静默竞速——加载结果
          未定义〔探针未定谳胜者〕，路径级 foreign 检测罩不住的形态）。shadowedBy
          非空即显著警示。 */}
      {status.shadowedBy.length > 0 && (
        <div className="agy-text-agent-conflict" role="alert">
          <span className="agy-text-agent-conflict-title">{t('agyTextAgent.shadowTitle')}</span>
          <ul className="agy-text-agent-conflict-paths">
            {status.shadowedBy.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
          <span className="agy-text-agent-hint">{t('agyTextAgent.shadowHint')}</span>
        </div>
      )}

      <div className="agy-text-agent-actions">
        {/* CR-9①：「立即写入」次级钮——enabled 且 missing/stale 时在位（不必先关再开，
            不必等下次启动对账；复用 enable 通道补写最新）。 */}
        {enabled && (fileState === 'missing' || fileState === 'stale') && (
          <button
            type="button"
            className="agy-text-agent-enable-button"
            disabled={busy}
            onClick={() => void writeNow()}
          >
            <span className="material-symbols-outlined" aria-hidden="true">save</span>
            {t('agyTextAgent.writeNow')}
          </button>
        )}
        {enabled ? (
          <button
            type="button"
            className="agy-text-agent-disable-button"
            disabled={busy}
            onClick={() => void turnOff()}
          >
            <span className="material-symbols-outlined" aria-hidden="true">power_settings_new</span>
            {t('agyTextAgent.disable')}
          </button>
        ) : (
          <button
            type="button"
            className="agy-text-agent-enable-button"
            disabled={busy}
            onClick={() => void turnOn()}
          >
            <span className="material-symbols-outlined" aria-hidden="true">key</span>
            {t('agyTextAgent.enable')}
          </button>
        )}
      </div>
    </section>
  );
}
