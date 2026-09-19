/**
 * Closure 文本 Agent 状态面 API shell（09-19 CLI 白名单 W4）。
 * Mirror `shared/api/agyBridge.ts` —— 每个 IPC 调用都走 `window.orisonDesktop`
 * （UI 纪律：组件不直碰桥）。三通道（W3 已就位，本包只消费）：
 * - `fetchAgyTextAgentStatus`：开关维 + CLI key 前提 + 文件四态 + name 遮蔽警示 + 路径。
 *   返回 null = 调用失败（调用方转提示态）。
 * - `enableAgyTextAgent`：开启（清 declined + 立即写入最新 agent 文件；外来同名文件压住
 *   → 'foreign-conflict' 拒写不覆盖）。成功附写后状态视图。
 * - `disableAgyTextAgent`：关闭（记 declined + 删自有 agent 文件——验标记才删）。
 */
import type {
  AgyTextAgentDisableResult,
  AgyTextAgentEnableResult,
  AgyTextAgentStatusView,
} from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

export async function fetchAgyTextAgentStatus(): Promise<AgyTextAgentStatusView | null> {
  try {
    return (await api()?.agyTextAgentStatus()) ?? null;
  } catch {
    return null;
  }
}

export async function enableAgyTextAgent(): Promise<AgyTextAgentEnableResult | null> {
  try {
    return (await api()?.agyTextAgentEnable()) ?? null;
  } catch {
    return null;
  }
}

export async function disableAgyTextAgent(): Promise<AgyTextAgentDisableResult | null> {
  try {
    return (await api()?.agyTextAgentDisable()) ?? null;
  } catch {
    return null;
  }
}
