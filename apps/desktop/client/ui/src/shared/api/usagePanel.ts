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

// ── CR-14（c3-2 CR 批）：偏好保存写链串行化 ──
// retention 与 budget 两条保存都是读改写（loadUserPreferences → 展开覆盖单键 →
// saveUserPreferences 整对象落盘）。两个保存窗并发时各自读到同一盘面基线，后写者
// 整体覆盖先写者的键 = 静默丢首写者。模块级 promise 链把读改写段排成串行——每段
// 读到的盘面必含前一段已落的键；前段失败不阻断本段（错误归调用方 promise）。
let prefsWriteChain: Promise<unknown> = Promise.resolve();

function enqueuePrefsWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = prefsWriteChain.then(task, task);
  prefsWriteChain = next.catch(() => undefined); // 链本身永不 reject
  return next;
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

/** 保留天数落盘（返回钳制后的落盘值；失败/超时 null → 调用方 toast）。见文件头说明。
 *  CR-14：读改写段进模块级写链串行（并发保存不丢首写者的键）。 */
export async function saveUsageRetentionDays(days: number): Promise<number | null> {
  try {
    return await enqueuePrefsWrite(async () => {
      const bridge = api();
      if (!bridge?.loadUserPreferences || !bridge?.saveUserPreferences) return null;
      // CR-15：两跳各带 5s 竞速超时——任一 invoke 永挂即按失败返回（阻输入永久禁用）。
      const current = await withTimeout(bridge.loadUserPreferences(), RETENTION_SAVE_TIMEOUT_MS);
      if (current === null) return null;
      const next = clampUsageRetentionDays(days);
      const saved = await withTimeout(bridge.saveUserPreferences({ ...current, usageRetentionDays: next }), RETENTION_SAVE_TIMEOUT_MS);
      if (saved === null) return null;
      return next;
    });
  } catch {
    return null;
  }
}

/**
 * 月度预算双线落盘（C3.2 W3，mirror saveUsageRetentionDays 读改写 + 超时竞速）：
 * undefined = 清线（键不写）。soft > hard 由**调用方预检**（表单内联 warn 拒提交——
 * shell save handler validateBudgetCapsForSave 拒写是绕过表单面的兜底）；盘面读回已经
 * readUserPreferences 归一，载荷键值即归一后形态。返回落盘后的双线值；失败/超时 null。
 * CR-14：读改写段进模块级写链串行（retention/budget 两保存并发不互冲）。
 */
export async function saveBudgetCaps(
  softCny: number | undefined,
  hardCny: number | undefined,
): Promise<{ softCny?: number; hardCny?: number } | null> {
  try {
    return await enqueuePrefsWrite(async () => {
      const bridge = api();
      if (!bridge?.loadUserPreferences || !bridge?.saveUserPreferences) return null;
      const current = await withTimeout(bridge.loadUserPreferences(), RETENTION_SAVE_TIMEOUT_MS);
      if (current === null) return null;
      const saved = await withTimeout(
        bridge.saveUserPreferences({ ...current, budgetSoftCny: softCny, budgetHardCny: hardCny }),
        RETENTION_SAVE_TIMEOUT_MS,
      );
      if (saved === null) return null;
      return { softCny, hardCny };
    });
  } catch {
    return null;
  }
}

/** 配额外链跳转（shell 侧 https-only 强制；AboutSettingsPage 同款 openExternal 面）。 */
export function openExternalLink(url: string): void {
  api()?.openExternal?.(url);
}
