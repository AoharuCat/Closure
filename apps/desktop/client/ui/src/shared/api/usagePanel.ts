/**
 * 用量面板 API shell（09-12 子5 W3，design §5）。Mirror `shared/api/researchConfig.ts`
 * —— 每个 IPC 调用都走 `window.orisonDesktop`（UI 纪律：组件不直碰桥）。
 *
 * - `fetchUsageOverview`：聚合读面单载荷（三窗 + byModel + byTask + recent + retention）。
 *   返回 null = 桥缺席/调用失败（调用方转错误态）。
 * - `clearUsage`：手动清空（确认对话框语义归调用方）；透传模式 A 结果。
 * - `saveUsageRetentionDays`：retention 落盘（config:save-user-preferences 单字段整存）。
 *   shell writeUserPreferences 是**全量覆盖写**——载荷缺键的偏好会打回默认，故先读
 *   当前盘面偏好、只覆盖 usageRetentionDays 后整体送存（settingsSlice buildPrefs 的
 *   盘面基线版；本页独立于 settings slice，不持其内存态）。钳制单源 =
 *   shared-contracts clampUsageRetentionDays（与 shell 写侧同一函数）；返回落盘后的
 *   钳制值，桥缺席/读写失败 → null（调用方 toast）。
 */
import {
  clampUsageRetentionDays,
  type UsageClearResult,
  type UsageOverview,
} from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

// ── CR-15（09-12 子5 CR 批）：retention 保存链 IPC 永挂兜底 ──
// 主进程 handler 若挂死（db 锁死等），await 永不 settle → saving 永真 → 输入永久
// 禁用。5s 竞速超时按失败处理（null → 调用方 toast + 输入解禁）；超时哨兵 = null
// （loadUserPreferences/saveUserPreferences 的真实返回不为 null——void/对象）。
const RETENTION_SAVE_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function fetchUsageOverview(): Promise<UsageOverview | null> {
  try {
    return (await api()?.usageOverview()) ?? null;
  } catch {
    return null;
  }
}

export async function clearUsage(): Promise<UsageClearResult | null> {
  try {
    return (await api()?.usageClear()) ?? null;
  } catch {
    return null;
  }
}

/** 保留天数落盘（返回钳制后的落盘值；失败/超时 null → 调用方 toast）。见文件头说明。 */
export async function saveUsageRetentionDays(days: number): Promise<number | null> {
  try {
    const bridge = api();
    if (!bridge?.loadUserPreferences || !bridge?.saveUserPreferences) return null;
    // CR-15：两跳各带 5s 竞速超时——任一 invoke 永挂即按失败返回（阻输入永久禁用）。
    const current = await withTimeout(bridge.loadUserPreferences(), RETENTION_SAVE_TIMEOUT_MS);
    if (current === null) return null;
    const next = clampUsageRetentionDays(days);
    const saved = await withTimeout(bridge.saveUserPreferences({ ...current, usageRetentionDays: next }), RETENTION_SAVE_TIMEOUT_MS);
    if (saved === null) return null;
    return next;
  } catch {
    return null;
  }
}

/** 配额外链跳转（shell 侧 https-only 强制；AboutSettingsPage 同款 openExternal 面）。 */
export function openExternalLink(url: string): void {
  api()?.openExternal?.(url);
}
