import { useEffect, useState } from 'react';
import type { ApiKeyEntry, CliProbeSnapshot } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { fetchCliProbeStatus, runCliProbe } from '../../shared/api/generation';

/**
 * 设置页「反重力状态探测」小节：每个 CLI 形态 key 一行，展示最近一次凭据探测
 * 结果（未探测 / 连接正常 / 登录已失效 / 探测失败），行内「测试连接」手动重测。
 *
 * - 数据面：快照按 keyId 存 shell 内存（从不落盘），挂载即拉一次最近结果；
 *   读取失败静默留空——各行如实显示「未探测」，点按钮即可现测。
 * - 探测 = 对该 key 真实跑一次迷你生成（约数秒）；预期内的失败（未登录/超时/
 *   崩溃）不抛错，以 error/auth-dead 快照回传，只更新本行。
 * - 「登录已失效」行附指引（切换账号，或在终端运行 agy 重新登录）；「探测失败」
 *   的原始摘要走 tooltip，不进界面正文。
 * - IPC 通道本身抛错（桥不可用等意外路径）→ toast 提示 + 原始 detail 进输出日志。
 *
 * 独立组件本地 state（mirror AgyBridgeSection 形态：机器级瞬态读面，不建 slice）。
 */

/** 探针时间戳 → HH:mm（本地时区）。无效时间戳给空串——快照由 shell 生成，ISO 恒合法；纯防御。 */
function formatProbeTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 徽标配色：连接正常 = 成功色；登录失效/探测失败 = 错误色；未探测 = 中性 chip。 */
function chipClassOf(snapshot: CliProbeSnapshot | undefined): string {
  if (!snapshot) return 'is-neutral';
  if (snapshot.status === 'ok') return 'is-ok';
  return 'is-error';
}

function statusTextOf(snapshot: CliProbeSnapshot | undefined, t: Props['t']): string {
  if (!snapshot) return t('settings.cliProbeUnprobed');
  if (snapshot.status === 'ok') {
    return t('settings.cliProbeStatusOk', { time: formatProbeTime(snapshot.probedAt) });
  }
  if (snapshot.status === 'auth-dead') return t('settings.cliProbeAuthDead');
  return t('settings.cliProbeFailed');
}

type Props = {
  /** 本页已保存的 CLI 形态 key（每行一个；空数组不渲染——探针只对已保存 key 有意义）。 */
  cliKeys: ApiKeyEntry[];
  /** t 支持原生 {var} 插值（useI18n 同签名）。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
};

export function AgyProbeSection({ cliKeys, t }: Props) {
  const showToast = useToastStore((s) => s.showToast);
  const appendOutputEntry = useAppStore((s) => s.appendOutputEntry);
  const [snapshots, setSnapshots] = useState<Record<string, CliProbeSnapshot>>({});
  const [probingIds, setProbingIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  // key 集合变化（新增/删除 CLI key）→ 重拉探针状态：新 key 若只挂在 mount 拉一次，
  // 会恒显示「未探测」的漂移态——shell 内存里可能已有它的快照（启动扫先于设置页打开）。
  // 依赖用 key-id 拼接串（不用数组本身——渲染期新建数组会让 effect 每次渲染都重跑）。
  const cliKeyIds = cliKeys.map((k) => k.id).join('\n');
  useEffect(() => {
    let cancelled = false;
    fetchCliProbeStatus()
      .then((statusMap) => {
        if (!cancelled) setSnapshots(statusMap);
      })
      // 读取失败静默留空：各行如实显示「未探测」，可手动测（不弹错误打断设置页）。
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cliKeyIds]);

  async function probe(keyId: string) {
    if (probingIds.has(keyId)) return;
    setProbingIds((prev) => new Set(prev).add(keyId));
    try {
      const snapshot = await runCliProbe({ keyId });
      setSnapshots((prev) => ({ ...prev, [keyId]: snapshot }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputEntry({
        scope: 'model',
        level: 'error',
        message: 'CLI credential probe failed',
        detail: message,
      });
      showToast(t('settings.cliProbeRunFailed'), 'error');
    } finally {
      setProbingIds((prev) => {
        const next = new Set(prev);
        next.delete(keyId);
        return next;
      });
    }
  }

  if (cliKeys.length === 0) return null;

  return (
    <section className="agy-probe-section" aria-label={t('settings.cliProbeSectionTitle')}>
      <div className="agy-probe-head">
        <h3 className="settings-page-title">{t('settings.cliProbeSectionTitle')}</h3>
      </div>
      <p className="agy-probe-section-subtitle">{t('settings.cliProbeSectionSubtitle')}</p>

      <div className="agy-probe-rows">
        {cliKeys.map((key) => {
          const snapshot = snapshots[key.id];
          const probing = probingIds.has(key.id);
          const errorDetail = snapshot?.status === 'error' ? snapshot.detail ?? '' : '';
          return (
            <div key={key.id} className="agy-probe-row">
              <div className="agy-probe-row-main">
                <span className="agy-probe-key-name">{key.name}</span>
                <span
                  className={`agy-probe-chip ${chipClassOf(snapshot)}`}
                  title={errorDetail || undefined}
                >
                  {statusTextOf(snapshot, t)}
                </span>
                <button
                  type="button"
                  className="agy-probe-test-button"
                  onClick={() => void probe(key.id)}
                  disabled={probing}
                  aria-label={t('settings.cliProbeButton')}
                  title={t('settings.cliProbeButton')}
                >
                  <span
                    className={`material-symbols-outlined${probing ? ' is-spinning' : ''}`}
                    aria-hidden="true"
                  >
                    sync
                  </span>
                  {t('settings.cliProbeButton')}
                </button>
              </div>
              {snapshot?.status === 'auth-dead' ? (
                <p className="agy-probe-hint">{t('settings.cliProbeAuthDeadHint')}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
