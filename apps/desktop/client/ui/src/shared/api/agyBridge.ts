/**
 * agy MCP 工具桥同意状态面 API shell（09-12 子4 W6，design §4/§8）。
 * Mirror `shared/api/usagePanel.ts` —— 每个 IPC 调用都走 `window.orisonDesktop`
 * （UI 纪律：组件不直碰桥）。三通道（W4 已就位，本包只消费）：
 * - `fetchAgyBridgeStatus`：状态机四态 + 冲突规则原文 + 副本根/同意文件路径。
 *   返回 null = 桥缺席/调用失败（调用方转提示态）。
 * - `setAgyBridgeConsent`：同意写（allowed/declined——拒绝也记住，AC6）；成功附写后
 *   状态视图。模式 A 结果原样透传。
 * - `revokeAgyBridge`：关闭回收（状态翻转回未配置；活动桥会话存在 → 'active-sessions'）。
 */
import type {
  AgyBridgeConsentResult,
  AgyBridgeConsentValue,
  AgyBridgeRevokeResult,
  AgyBridgeStatusView,
} from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

export async function fetchAgyBridgeStatus(): Promise<AgyBridgeStatusView | null> {
  try {
    return (await api()?.agyBridgeStatus()) ?? null;
  } catch {
    return null;
  }
}

export async function setAgyBridgeConsent(
  consent: AgyBridgeConsentValue,
): Promise<AgyBridgeConsentResult | null> {
  try {
    return (await api()?.agyBridgeSetConsent({ consent })) ?? null;
  } catch {
    return null;
  }
}

export async function revokeAgyBridge(): Promise<AgyBridgeRevokeResult | null> {
  try {
    return (await api()?.agyBridgeRevoke()) ?? null;
  } catch {
    return null;
  }
}
