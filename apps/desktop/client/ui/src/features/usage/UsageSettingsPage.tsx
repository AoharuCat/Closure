/**
 * 「用量」settings page（09-12 子5 W3，design §5 七区块）。Mirror
 * ResearchSettingsPage 形态（mount 拉取 + 组件本地 state + shared/api wrapper；
 * **不建 zustand slice**——machine 级瞬态读面、无项目态、无 push 事件，slice 三要件
 * 一个不占）。刷新模型 = 打开拉取 + 手动刷新钮 + 清空后重拉（新鲜度兜底走打开时
 * force 同哲学；无事件源即无事件刷新三件套义务）。
 *
 * 七区块：①聚合瓦片（今日/近7日/累计=保留窗内，¥ 小字恒带「仅供参考」）②per-model
 * 分解表（近7日，无单价行金额 cell 空——不硬造 0）③按档位分解 ④最近调用 20 条
 * （NULL token cell =「—」，CR-18 未上报 ≠ 0）⑤治理区（保留天数可编辑输入 blur 落盘
 * + 清空）⑥配额外链组（纯合规，URL 常量本页唯一定义）⑦ToS 备注（共享组件，文案
 * 单源 = settings.cliTosRiskNote）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  USAGE_RETENTION_DAYS_MAX,
  USAGE_RETENTION_DAYS_MIN,
  clampUsageRetentionDays,
  type BudgetStatus,
  type UsageOverview,
  type UsageRecentCall,
  type UsageWindowTotals,
} from '@orison/shared-contracts';
import {
  fetchUsageOverview,
  clearUsage,
  openExternalLink,
  saveBudgetCaps,
  saveUsageRetentionDays,
} from '../../shared/api/usagePanel';
import { useToastStore } from '../../shared/store/toastStore';
import { useConfirmStore } from '../../shared/store/confirmStore';
import { AgyTosRiskNote } from '../../shared/components/AgyTosRiskNote';
import { formatTokenCount } from '../../shared/utils/numberFormat';

type Props = { t: (key: string, vars?: Record<string, string | number>) => string };

// ── 配额外链 URL 常量（全仓唯一定义点——W4 grep 守门：不得出现第二处字面量）──
/** 月度 AI credits——官方网页端唯一可查的配额面（月度 credits 余额与历史）。 */
const GOOGLE_ONE_AI_ACTIVITY_URL = 'https://one.google.com/ai/activity';
/** 5 小时/周窗口查看指引——官方口径 = IDE 设置页或 CLI /usage（无网页查询通道）。 */
const AGY_USAGE_GUIDE_URL = 'https://antigravity.google/docs/cli/commands/usage/';
/** Gemini 聊天用量设置——仅 Gemini 聊天产品配额，不含 Antigravity。 */
const GEMINI_SETTINGS_URL = 'https://gemini.google.com/';

// ── 纯格式化 helper（导出供测试断言；确定性实现，不依赖运行环境 locale）──

/** 金额：最多 4 位小数、去尾零（单价 per-1M 折算后常是小数；整数不带点）。 */
export function formatCost(n: number): string {
  return n
    .toFixed(4)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

/** 耗时：<1s 毫秒整数，≥1s 一位小数秒。 */
export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 本地时间「YYYY-MM-DD HH:mm」（CR-13：弃 toLocaleString——对齐 formatTokenCount
 * 拒 locale API 先例，不同 node ICU 下形态不漂移）。
 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 协议 → 既有 i18n 键（settings.protocol*，两 locale 已有）；未知协议回落原文。 */
function protocolLabel(protocol: string, t: Props['t']): string {
  switch (protocol) {
    case 'openai-compatible':
      return t('settings.protocolOpenAICompatible');
    case 'anthropic-compatible':
      return t('settings.protocolAnthropicCompatible');
    case 'antigravity-cli':
      return t('settings.protocolAntigravityCli');
    default:
      return protocol;
  }
}

// ── 行渲染零件 ──

/** 聚合 NULL 形态符号（CR-2：窗口/行组「有调用未上报」的瓦片主数字与细分区段标记）。 */
const UNREPORTED_MARK = '?';

/**
 * token 计数 NULL cell（CR-18/CR-2）：null → mark（默认「—」行级未上报；聚合面传
 * 「?」——窗口/行组内有调用但全程未上报）+ title 说明；数字 → 千分位。
 */
function TokenCell({ t, value, mark = '—' }: { t: Props['t']; value: number | null; mark?: string }) {
  if (value === null) {
    return (
      <span className="usage-cell-null" title={t('usagePanel.tokensUnreported')}>{mark}</span>
    );
  }
  return <>{formatTokenCount(value)}</>;
}

/** tokens 细分行（瓦片内次行：输入/输出/思考/缓存读 四段小字；NULL 分量 → 「?」+ title）。 */
function TokenBreakdown({ t, totals }: { t: Props['t']; totals: UsageWindowTotals }) {
  const part = (label: string, value: number | null) =>
    value === null ? (
      <span title={t('usagePanel.tokensUnreported')}>{`${label} ${UNREPORTED_MARK}`}</span>
    ) : (
      <span>{`${label} ${formatTokenCount(value)}`}</span>
    );
  return (
    <span className="usage-tile-breakdown">
      {part(t('usagePanel.input'), totals.inputTokens)}
      {part(t('usagePanel.output'), totals.outputTokens)}
      {part(t('usagePanel.thinking'), totals.thinkingTokens)}
      {part(t('usagePanel.cacheRead'), totals.cacheReadTokens)}
    </span>
  );
}

/** 聚合瓦片（kb-index 瓦片语汇：大数字 + 小标签；口径备注作标签行内弱化后缀；
 * 金额行虚线分隔后置 + 「仅供参考」chip 降权）。CR-2：全 NULL 窗口主数字「?」
 * + 未上报 title（不显示假 0）。 */
function UsageTile({
  t,
  windowLabel,
  totals,
  windowNote,
}: {
  t: Props['t'];
  windowLabel: string;
  totals: UsageWindowTotals;
  windowNote?: string;
}) {
  return (
    <div className="usage-tile" data-testid="usage-tile">
      <span className="usage-tile-window">
        {windowLabel}
        {windowNote ? <span className="usage-tile-note">{windowNote}</span> : null}
      </span>
      <span className="usage-tile-value-row">
        {totals.totalTokens === null ? (
          <span className="usage-tile-value" title={t('usagePanel.tokensUnreported')}>{UNREPORTED_MARK}</span>
        ) : (
          <span className="usage-tile-value">{formatTokenCount(totals.totalTokens)}</span>
        )}
        <span className="usage-tile-unit">{t('usagePanel.tokens')}</span>
      </span>
      <span className="usage-tile-calls">
        {`${t('usagePanel.calls', { n: totals.calls })} · ${t('usagePanel.failedCalls', { n: totals.failedCalls })}`}
      </span>
      <TokenBreakdown t={t} totals={totals} />
      {totals.estimatedCost !== undefined ? (
        <span className="usage-tile-cost">
          {t('usagePanel.costEstimate', { amount: formatCost(totals.estimatedCost) })}
          <span className="usage-cost-tag">{t('usagePanel.costNoteShort')}</span>
        </span>
      ) : null}
    </div>
  );
}

/** 失败行 error_kind 短徽标（title = 错误摘要）；成功行绿「成功」。
 * 配色对（success/diff-add-bg、error/error-bg）均为既有 chip 语汇。 */
function StatusCell({ t, row }: { t: Props['t']; row: UsageRecentCall }) {
  if (row.success) {
    return <span className="usage-status-chip is-ok">{t('usagePanel.statusOk')}</span>;
  }
  return (
    <span
      className="usage-status-chip is-fail"
      title={row.errorMessage ?? row.errorKind ?? undefined}
    >
      {row.errorKind ?? t('usagePanel.statusFailed')}
    </span>
  );
}

function openExternal(url: string): void {
  openExternalLink(url);
}

// ── 预算区（C3.2 W3：软警硬拦）──

/**
 * 过线一次性通知（渲染端最小形态）：localStorage 键 `budgetNotified:<YYYY-MM>:<state>:<cap>`
 * ——月切（月份段变）或阈值改（cap 值进键）自动重置；每线每月至多一次。同一载荷双线
 * 皆过时只报当前最严态（soft 线或已在早前载荷提醒过，或由面板状态常显——双 toast 噪声）。
 * localStorage 不可用（隐私模式等）→ 静默跳过（通知是 best-effort 面）。
 */
export function notifyBudgetOnce(
  budget: BudgetStatus,
  t: Props['t'],
  showToast: (message: string, level?: 'info' | 'success' | 'error') => void,
): void {
  if (budget.state === 'ok') return;
  const cap = budget.state === 'hard' ? budget.hardCny : budget.softCny;
  const d = new Date();
  const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const key = `budgetNotified:${monthKey}:${budget.state}:${cap ?? ''}`;
  try {
    if (window.localStorage.getItem(key) !== null) return;
    window.localStorage.setItem(key, '1');
  } catch {
    return;
  }
  showToast(
    budget.state === 'hard'
      ? t('usagePanel.budgetHardToast', { amount: formatCost(budget.monthSpentCny) })
      : t('usagePanel.budgetSoftToast', { amount: formatCost(budget.monthSpentCny) }),
    budget.state === 'hard' ? 'error' : 'info',
  );
}

/** 单线进度条（spent/cap 比例填充；过线填充转警示色——soft 线 warning / hard 线 error，
 * 由 data-crossed 区分；状态文字色语义在 chip 同态）。 */
function BudgetBar({ t, label, kind, cap, spent, crossed }: {
  t: Props['t'];
  label: string;
  kind: 'soft' | 'hard';
  cap: number;
  spent: number;
  crossed: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (spent / cap) * 100));
  return (
    <div className="usage-budget-line" data-testid="usage-budget-line" data-crossed={crossed ? kind : undefined}>
      <span className="usage-budget-line-label">{label}</span>
      <span className="usage-budget-bar">
        <span className="usage-budget-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="usage-budget-line-amount">
        {t('usagePanel.budgetOf', { spent: formatCost(spent), cap: formatCost(cap) })}
      </span>
    </div>
  );
}

/**
 * 双线输入（blur 落盘，mirror RetentionField 草稿/回声抑制/失败回滚纪律）：空 = 清线
 * （键不设）；soft > hard 响亮拒写（内联 warn 常显 + 不提交——shell save handler
 * validateBudgetCapsForSave 拒写是绕过表单面的兜底）；非法数字回显不落盘。
 * CR-13：0/负数同样内联拒——shell clamp 侧把非正数当「未设」静默清线，「硬线全拦」
 * 的意图会无声变「无执行」，必须在表单面拦下。
 */
function BudgetCapsFields({ t, soft, hard, onSaved }: {
  t: Props['t'];
  soft: number | undefined;
  hard: number | undefined;
  onSaved: () => void;
}) {
  const showToast = useToastStore((s) => s.showToast);
  const [softDraft, setSoftDraft] = useState(soft === undefined ? '' : String(soft));
  const [hardDraft, setHardDraft] = useState(hard === undefined ? '' : String(hard));
  const [saving, setSaving] = useState(false);
  const focusedRef = useRef(false);
  const lastSyncedRef = useRef({ soft, hard });

  useEffect(() => {
    if (focusedRef.current) return;
    if (soft !== lastSyncedRef.current.soft || hard !== lastSyncedRef.current.hard) {
      lastSyncedRef.current = { soft, hard };
      setSoftDraft(soft === undefined ? '' : String(soft));
      setHardDraft(hard === undefined ? '' : String(hard));
    }
  }, [soft, hard]);

  const softEmpty = softDraft.trim() === '';
  const hardEmpty = hardDraft.trim() === '';
  const parsedSoft = softEmpty ? undefined : Number(softDraft);
  const parsedHard = hardEmpty ? undefined : Number(hardDraft);
  const invalid = (softEmpty ? false : !Number.isFinite(parsedSoft)) ||
    (hardEmpty ? false : !Number.isFinite(parsedHard));
  const nonPositive = (!softEmpty && parsedSoft !== undefined && parsedSoft <= 0) ||
    (!hardEmpty && parsedHard !== undefined && parsedHard <= 0);
  const crossViolation =
    parsedSoft !== undefined && parsedHard !== undefined && parsedSoft > parsedHard;

  function draftOf(v: number | undefined): string {
    return v === undefined ? '' : String(v);
  }

  async function commit() {
    focusedRef.current = false;
    if (invalid || nonPositive) {
      // 非法数字 / 0·负数 → 回存量显示不落盘（RetentionField 同款；CR-13 拒 0/负——
      // 落盘面会把它 clamp 成「未设」，静默清掉用户刚设的线）。
      setSoftDraft(draftOf(soft));
      setHardDraft(draftOf(hard));
      return;
    }
    if (crossViolation) return; // 响亮拒写：warn 已内联常显，改到合法再保存。
    // 金额两位小数归一（元——分位精度与 ¥ 口径一致）。
    const nextSoft = parsedSoft !== undefined ? Math.round(parsedSoft * 100) / 100 : undefined;
    const nextHard = parsedHard !== undefined ? Math.round(parsedHard * 100) / 100 : undefined;
    if (nextSoft === lastSyncedRef.current.soft && nextHard === lastSyncedRef.current.hard) return;
    setSaving(true);
    const saved = await saveBudgetCaps(nextSoft, nextHard);
    setSaving(false);
    if (saved === null) {
      showToast(t('usagePanel.budgetSaveFailed'), 'error');
      return;
    }
    lastSyncedRef.current = { soft: nextSoft, hard: nextHard };
    onSaved();
  }

  return (
    <div className="usage-budget-fields">
      <span className="usage-retention-field">
        <label className="usage-retention-label" htmlFor="usage-budget-soft-input">
          {t('usagePanel.budgetSoftLabel')}
        </label>
        <input
          id="usage-budget-soft-input"
          type="number"
          className="usage-retention-input"
          min={0}
          step={1}
          value={softDraft}
          disabled={saving}
          onChange={(e) => setSoftDraft(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => void commit()}
        />
        <span className="usage-retention-unit">{t('usagePanel.budgetUnit')}</span>
      </span>
      <span className="usage-retention-field">
        <label className="usage-retention-label" htmlFor="usage-budget-hard-input">
          {t('usagePanel.budgetHardLabel')}
        </label>
        <input
          id="usage-budget-hard-input"
          type="number"
          className="usage-retention-input"
          min={0}
          step={1}
          value={hardDraft}
          disabled={saving}
          onChange={(e) => setHardDraft(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => void commit()}
        />
        <span className="usage-retention-unit">{t('usagePanel.budgetUnit')}</span>
      </span>
      {invalid ? (
        <span className="usage-retention-warn" role="status">
          {t('usagePanel.budgetInvalidWarn')}
        </span>
      ) : nonPositive ? (
        // CR-13：非正数先于 soft>hard 判定显示（非正值本身必拒——修掉它才轮到跨字段校验）。
        <span className="usage-retention-warn" role="status">
          {t('usagePanel.budgetPositiveWarn')}
        </span>
      ) : crossViolation ? (
        <span className="usage-retention-warn" role="alert">
          {t('usagePanel.budgetSoftRangeWarn')}
        </span>
      ) : null}
    </div>
  );
}

/** 预算区块：状态 chip（状态色）+ 本月已用 + 双线进度 + 截断守卫文案 + 双线输入。 */
export function BudgetSection({ t, budget, onCapsSaved }: {
  t: Props['t'];
  budget: BudgetStatus | undefined;
  onCapsSaved: () => void;
}) {
  const stateLabel = budget === undefined
    ? null
    : budget.state === 'hard'
      ? t('usagePanel.budgetStateHard')
      : budget.state === 'soft'
        ? t('usagePanel.budgetStateSoft')
        : t('usagePanel.budgetStateOk');
  return (
    <section className="usage-budget" aria-label={t('usagePanel.budget')} data-testid="usage-budget-section">
      <h3 className="settings-page-title">{t('usagePanel.budget')}</h3>
      {budget === undefined ? (
        <p className="usage-hint">{t('usagePanel.budgetNotSet')}</p>
      ) : (
        <div className="usage-budget-status" data-state={budget.state}>
          <span className="usage-budget-status-row">
            <span className={`usage-budget-chip is-${budget.state}`}>{stateLabel}</span>
            <span className="usage-budget-spent">
              {t('usagePanel.budgetMonthSpent', { amount: formatCost(budget.monthSpentCny) })}
            </span>
          </span>
          {budget.softCny !== undefined ? (
            <BudgetBar
              t={t}
              label={t('usagePanel.budgetSoftLine')}
              kind="soft"
              cap={budget.softCny}
              spent={budget.monthSpentCny}
              crossed={budget.state !== 'ok'}
            />
          ) : null}
          {budget.hardCny !== undefined ? (
            <BudgetBar
              t={t}
              label={t('usagePanel.budgetHardLine')}
              kind="hard"
              cap={budget.hardCny}
              spent={budget.monthSpentCny}
              crossed={budget.state === 'hard'}
            />
          ) : null}
          {budget.windowTruncated ? (
            <span className="usage-budget-truncated" role="status">
              {t('usagePanel.budgetTruncatedNote')}
            </span>
          ) : null}
        </div>
      )}
      <BudgetCapsFields t={t} soft={budget?.softCny} hard={budget?.hardCny} onSaved={onCapsSaved} />
      <p className="usage-hint">{t('usagePanel.budgetHint')}</p>
    </section>
  );
}

// ── 治理区：保留天数输入 ──

/** 保留天数可编辑输入。number = 键盘类（schema-driven-forms Pattern 2）——change 只进
 * 本地草稿，blur 才落盘（防逐键 IPC + 盘上中间值）；blur 语义 mirror setting 表单
 * FormNumberControl 纪律：空/非数 → 回存量显示不落盘；越界 → 钳到最近边界（带内
 * [7,730] 单源 = shared-contracts 常量）；聚焦期不回写外部值（回声抑制——保存后重拉
 * overview 回显的新值不覆盖用户草稿、回显写回也不再触发保存）。保存走
 * saveUsageRetentionDays（整对象单字段覆盖），成功后父层重拉 overview——「累计 =
 * 保留窗内」口径跟着新保留窗走，收紧时懒 prune 随读触发。 */
function RetentionField({
  t,
  value,
  onSaved,
}: {
  t: Props['t'];
  value: number;
  onSaved: () => void;
}) {
  const showToast = useToastStore((s) => s.showToast);
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const lastSyncedRef = useRef(value);
  const focusedRef = useRef(false);
  // CR-9（09-12 子5 CR 批）：prop 最新值 ref——保存失败回滚用 ref 值而非闭包值（await
  // 期间外部可能已重拉翻新 prop〔手动刷新等〕，闭包 value 是 stale，回滚会 clobber 新值）。
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (focusedRef.current) return;
    if (value !== lastSyncedRef.current) {
      lastSyncedRef.current = value;
      setDraft(String(value));
    }
  }, [value]);

  // 带内即时反馈（打字期可见，不打断输入）：空/非数 与 越界 各一句；归位/落盘后消失。
  const parsedDraft = draft.trim() === '' ? NaN : Number(draft);
  const warn = !Number.isFinite(parsedDraft)
    ? t('usagePanel.retentionInvalidWarn')
    : parsedDraft < USAGE_RETENTION_DAYS_MIN || parsedDraft > USAGE_RETENTION_DAYS_MAX
      ? t('usagePanel.retentionRangeWarn')
      : null;

  async function commit() {
    focusedRef.current = false;
    if (!Number.isFinite(parsedDraft)) {
      setDraft(String(value));
      return;
    }
    // 天数取整 + 带内钳制（钳制单源 clampUsageRetentionDays，与 shell 写侧同函数）。
    const next = clampUsageRetentionDays(Math.round(parsedDraft));
    setDraft(String(next));
    if (next === lastSyncedRef.current && value !== lastSyncedRef.current) {
      // 聚焦期用户未动而外部已翻新 → 收养外部值（防陈旧草稿 blur 反向覆盖回写）。
      lastSyncedRef.current = value;
      setDraft(String(value));
      return;
    }
    if (next === lastSyncedRef.current) return;
    lastSyncedRef.current = next;
    setSaving(true);
    const saved = await saveUsageRetentionDays(next);
    setSaving(false);
    if (saved === null) {
      showToast(t('usagePanel.retentionSaveFailed'), 'error');
      // CR-9：回滚读 ref 最新 prop（await 期间重拉翻新的值不被 stale 闭包 clobber）。
      lastSyncedRef.current = valueRef.current;
      setDraft(String(valueRef.current));
      return;
    }
    onSaved();
  }

  return (
    <>
      <span className="usage-retention-field">
        <label className="usage-retention-label" htmlFor="usage-retention-days-input">
          {t('usagePanel.retentionLabel')}
        </label>
        <input
          id="usage-retention-days-input"
          type="number"
          className="usage-retention-input"
          min={USAGE_RETENTION_DAYS_MIN}
          max={USAGE_RETENTION_DAYS_MAX}
          step={1}
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => void commit()}
        />
        <span className="usage-retention-unit">{t('usagePanel.retentionUnit')}</span>
      </span>
      {warn !== null ? (
        <span className="usage-retention-warn" role="status">
          {warn}
        </span>
      ) : null}
    </>
  );
}

// ── 页面 ──

export function UsageSettingsPage({ t }: Props) {
  const showToast = useToastStore((s) => s.showToast);
  const requestConfirm = useConfirmStore((s) => s.requestConfirm);

  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const view = await fetchUsageOverview();
    if (view) {
      setOverview(view);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // C3.2 W3：过线一次性通知（键含月份段 + cap 值——月切/阈值改自动重置；见 helper 注记）。
  useEffect(() => {
    if (overview?.budget) notifyBudgetOnce(overview.budget, t, showToast);
  }, [overview, t, showToast]);

  async function onClear() {
    const confirmed = await requestConfirm({
      title: t('usagePanel.clearConfirmTitle'),
      message: t('usagePanel.clearConfirmBody'),
      confirmLabel: t('usagePanel.clear'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setClearing(true);
    const result = await clearUsage();
    setClearing(false);
    if (result?.ok) {
      showToast(t('usagePanel.clearDone', { n: result.deleted }), 'success');
      await load();
    } else {
      showToast(t('usagePanel.clearFailed'), 'error');
    }
  }

  if (loadFailed) {
    return (
      <div className="settings-page usage-settings-page">
        <header className="settings-page-header">
          <div>
            <h3 className="settings-page-title">{t('settings.usage')}</h3>
            <p className="settings-page-subtitle">{t('usagePanel.pageSubtitle')}</p>
          </div>
        </header>
        <div className="usage-state-block" role="alert">
          <span className="material-symbols-outlined" aria-hidden="true">cloud_off</span>
          <p className="usage-hint">{t('usagePanel.loadFailed')}</p>
          <button type="button" className="usage-retry-button" onClick={() => void load()}>
            <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            {t('usagePanel.refresh')}
          </button>
        </div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="settings-page usage-settings-page">
        <div className="usage-state-block">
          <span className="material-symbols-outlined is-spinning" aria-hidden="true">
            progress_activity
          </span>
          <p className="usage-hint">{t('usagePanel.loading')}</p>
        </div>
      </div>
    );
  }

  const isEmpty = overview.total.calls === 0;

  return (
    <div className="settings-page usage-settings-page">
      <header className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.usage')}</h3>
          <p className="settings-page-subtitle">{t('usagePanel.pageSubtitle')}</p>
        </div>
        <button
          type="button"
          className="settings-save-button"
          onClick={() => void load()}
          disabled={refreshing}
        >
          <span
            className={`material-symbols-outlined${refreshing ? ' is-spinning' : ''}`}
            aria-hidden="true"
          >
            refresh
          </span>
          {t('usagePanel.refresh')}
        </button>
      </header>

      {/* ① 聚合瓦片（CR-13：section 标签用中性「用量概览」——三窗聚合非「累计」单窗） */}
      <section className="usage-tiles" aria-label={t('usagePanel.tilesSection')}>
        <UsageTile t={t} windowLabel={t('usagePanel.today')} totals={overview.today} />
        <UsageTile t={t} windowLabel={t('usagePanel.last7d')} totals={overview.last7d} />
        <UsageTile
          t={t}
          windowLabel={t('usagePanel.total')}
          totals={overview.total}
          windowNote={t('usagePanel.totalRetentionNote')}
        />
      </section>

      {/* ①′ 月度预算（C3.2 W3：软警硬拦——配置面 + 状态条；空台账也渲染，先设线后用量合法） */}
      <BudgetSection t={t} budget={overview.budget} onCapsSaved={() => void load()} />

      {isEmpty ? (
        <p className="usage-empty">
          {t('usagePanel.empty')}
          <span className="material-symbols-outlined" aria-hidden="true">monitoring</span>
        </p>
      ) : (
        <>
          {/* ② per-model 分解表（近 7 日；CR-3：(modelId, protocol) 折叠——同模型多键一行，
              键差异进 keyIds/title；CR-16：空窗显示空态提示，不渲染 header-only 空表） */}
          <section aria-label={t('usagePanel.byModel')}>
            <h3 className="settings-page-title">{t('usagePanel.byModel')}</h3>
            {overview.byModel.length === 0 ? (
              <p className="usage-hint">{t('usagePanel.recentEmpty')}</p>
            ) : (
              <>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t('settings.modelName')}</th>
                      <th className="usage-table-num">{t('usagePanel.callsColumn')}</th>
                      <th className="usage-table-num">{t('usagePanel.input')}</th>
                      <th className="usage-table-num">{t('usagePanel.output')}</th>
                      <th className="usage-table-num">{t('usagePanel.thinking')}</th>
                      <th className="usage-table-num">{t('usagePanel.cacheRead')}</th>
                      <th className="usage-table-num">{t('usagePanel.tokens')}</th>
                      <th className="usage-table-num">
                        {t('usagePanel.costEstimateHeader')}
                        <span className="usage-cost-tag">{t('usagePanel.costNoteShort')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.byModel.map((row) => (
                      <tr key={`${row.modelId}:${row.protocol}`}>
                        <td>
                          <span className="usage-model-cell">
                            <span
                              className="usage-model-id"
                              title={`${row.keyIds.join(' · ')} · ${row.modelId}`}
                            >
                              {row.modelId}
                            </span>
                            <span
                              className="usage-model-sub"
                              title={`${row.keyIds.join(' · ')} · ${protocolLabel(row.protocol, t)}`}
                            >
                              {`${row.keyIds.length === 1
                                ? row.keyIds[0]
                                : t('usagePanel.modelMultiKeys', { n: row.keyIds.length })} · ${protocolLabel(row.protocol, t)}${row.failedCalls > 0 ? ` · ${t('usagePanel.failedCalls', { n: row.failedCalls })}` : ''}`}
                            </span>
                          </span>
                        </td>
                        <td className="usage-table-num">{formatTokenCount(row.calls)}</td>
                        <td className="usage-table-num"><TokenCell t={t} value={row.inputTokens} mark="?" /></td>
                        <td className="usage-table-num"><TokenCell t={t} value={row.outputTokens} mark="?" /></td>
                        <td className="usage-table-num"><TokenCell t={t} value={row.thinkingTokens} mark="?" /></td>
                        <td className="usage-table-num"><TokenCell t={t} value={row.cacheReadTokens} mark="?" /></td>
                        <td className="usage-table-num"><TokenCell t={t} value={row.totalTokens} mark="?" /></td>
                        <td className="usage-table-num">
                          {row.estimatedCost !== undefined ? formatCost(row.estimatedCost) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="usage-hint">{t('usagePanel.costNote')}</p>
              </>
            )}
          </section>

          {/* ③ 按档位分解（近 7 日；CR-16：空窗空态提示同 byModel） */}
          <section aria-label={t('usagePanel.byTask')}>
            <h3 className="settings-page-title">{t('usagePanel.byTask')}</h3>
            {overview.byTask.length === 0 ? (
              <p className="usage-hint">{t('usagePanel.recentEmpty')}</p>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t('usagePanel.taskColumn')}</th>
                    <th className="usage-table-num">{t('usagePanel.callsColumn')}</th>
                    <th className="usage-table-num">{t('usagePanel.tokens')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.byTask.map((row, i) => (
                    <tr key={row.taskType ?? `__unlabeled_${i}`}>
                      <td>
                        {row.taskType === null ? (
                          <span className="usage-cell-null">{t('usagePanel.taskUnlabeled')}</span>
                        ) : (
                          row.taskType
                        )}
                      </td>
                      <td className="usage-table-num">{formatTokenCount(row.calls)}</td>
                      <td className="usage-table-num"><TokenCell t={t} value={row.totalTokens} mark="?" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ④ 最近调用列表（20 条；sessionKey 进 title 不占列；CR-4：tokens 细分四列
              ——NULL cell「—」与 byModel 表头同族，行级未上报形态） */}
          <section aria-label={t('usagePanel.recent')}>
            <h3 className="settings-page-title">{t('usagePanel.recent')}</h3>
            {overview.recent.length === 0 ? (
              <p className="usage-hint">{t('usagePanel.recentEmpty')}</p>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t('usagePanel.timeColumn')}</th>
                    <th>{t('usagePanel.protocolColumn')}</th>
                    <th>{t('settings.modelName')}</th>
                    <th>{t('usagePanel.taskColumn')}</th>
                    <th className="usage-table-num">{t('usagePanel.input')}</th>
                    <th className="usage-table-num">{t('usagePanel.output')}</th>
                    <th className="usage-table-num">{t('usagePanel.thinking')}</th>
                    <th className="usage-table-num">{t('usagePanel.cacheRead')}</th>
                    <th className="usage-table-num">{t('usagePanel.tokens')}</th>
                    <th className="usage-table-num">{t('usagePanel.latency')}</th>
                    <th>{t('usagePanel.statusColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent.map((row) => (
                    <tr key={row.id}>
                      <td className="usage-table-time" title={new Date(row.ts).toISOString()}>
                        {formatTime(row.ts)}
                      </td>
                      <td>{protocolLabel(row.protocol, t)}</td>
                      <td>
                        <span
                          className="usage-model-id"
                          title={row.sessionKey ? `${row.keyId} · ${row.sessionKey}` : row.keyId}
                        >
                          {row.modelId}
                        </span>
                        {/* C3.1 M3：生图张数（有值才显示——非生图行 NULL 不渲染；
                            token 列该行如实全「—」，张数是唯一量纲）。 */}
                        {row.imageCount !== null ? (
                          <span className="usage-model-sub">
                            {t('usagePanel.imageCount', { n: row.imageCount })}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {row.taskType === null ? (
                          <span className="usage-cell-null">{t('usagePanel.taskUnlabeled')}</span>
                        ) : (
                          row.taskType
                        )}
                      </td>
                      <td className="usage-table-num"><TokenCell t={t} value={row.inputTokens} /></td>
                      <td className="usage-table-num"><TokenCell t={t} value={row.outputTokens} /></td>
                      <td className="usage-table-num"><TokenCell t={t} value={row.thinkingTokens} /></td>
                      <td className="usage-table-num"><TokenCell t={t} value={row.cacheReadTokens} /></td>
                      <td className="usage-table-num">
                        <TokenCell t={t} value={row.totalTokens} />
                      </td>
                      <td className="usage-table-num">
                        {formatLatency(row.latencyMs)}
                        {row.stream && row.firstDeltaMs !== null
                          ? ` · ${t('usagePanel.firstDelta', { ms: formatLatency(row.firstDeltaMs) })}`
                          : ''}
                      </td>
                      <td><StatusCell t={t} row={row} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {/* ⑤ 治理区：保留天数（可编辑 blur 落盘，保存后重拉 overview——懒 prune 随读
          触发，「累计 = 保留窗内」跟着新值走）+ 清空。 */}
      <section aria-label={t('usagePanel.retention')}>
        <h3 className="settings-page-title">{t('usagePanel.retention')}</h3>
        <div className="usage-governance-row">
          <div className="usage-governance-info">
            <RetentionField t={t} value={overview.retentionDays} onSaved={() => void load()} />
            <span className="usage-hint">{t('usagePanel.retentionHint')}</span>
          </div>
          <button
            type="button"
            className="usage-clear-button"
            onClick={() => void onClear()}
            disabled={clearing}
          >
            <span className="material-symbols-outlined" aria-hidden="true">delete_forever</span>
            {t('usagePanel.clear')}
          </button>
        </div>
      </section>

      {/* ⑥ 配额外链组（R3 纯合规；标注如实——零灰色通道） */}
      <section className="usage-links" aria-label={t('usagePanel.linksTitle')}>
        <h3 className="settings-page-title">{t('usagePanel.linksTitle')}</h3>
        <div className="usage-link-row">
          <button
            type="button"
            className="usage-link-button"
            onClick={() => openExternal(GOOGLE_ONE_AI_ACTIVITY_URL)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            {t('usagePanel.linkCredits')}
          </button>
          <span className="usage-link-note">{t('usagePanel.linkCreditsNote')}</span>
        </div>
        <div className="usage-link-row">
          <button
            type="button"
            className="usage-link-button"
            onClick={() => openExternal(AGY_USAGE_GUIDE_URL)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            {t('usagePanel.linkUsageGuide')}
          </button>
          <span className="usage-link-note">{t('usagePanel.linkUsageGuideNote')}</span>
        </div>
        <div className="usage-link-row">
          <button
            type="button"
            className="usage-link-button"
            onClick={() => openExternal(GEMINI_SETTINGS_URL)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            {t('usagePanel.linkGemini')}
          </button>
          <span className="usage-link-note">{t('usagePanel.linkGeminiNote')}</span>
        </div>
      </section>

      {/* ⑦ ToS 风险备注行（共享组件；文案单源 = settings.cliTosRiskNote） */}
      <AgyTosRiskNote t={t} />
    </div>
  );
}
