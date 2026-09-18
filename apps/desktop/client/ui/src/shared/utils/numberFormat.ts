/**
 * 数值格式化（09-12 子5 CR-13：formatTokenCount 自 UsageSettingsPage 上提共享——
 * AgentPanel 余量条 title 与用量页两处消费，单源防漂移）。
 *
 * 纪律：**拒绝 locale API**（`toLocaleString` 在不同 node ICU / 浏览器环境下分组符
 * 漂移）——regex 手工千分位分组，确定性实现不依赖运行环境 locale。
 */

/** 千分位分组（1,234,567）。 */
export function formatTokenCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
