export * from './types';
export * from './errors';
export { normalizeImageResponse } from './imageNormalize';
export { listModels } from './listModels';
export {
  generateText,
  generateTextStream,
  generateImage,
  generateEmbeddings,
  createProvider,
  applyThinkingControls,
  // 09-12 子3：per-key 超时窗口值源（纯函数，单测直测 + shell 网关后续消费）。
  streamWindowMs,
} from './generate';
export type { GenerationDelta } from './generate';
export { rerank } from './rerank';
// 09-12 usage-panel：生成调用计量 sink——两公共入口 wrapper 组装 GenerationCallRecord
// 后经 dispatchGenerationCallRecord 分发（缺省 no-op）；shell main whenReady 装配
// setGenerationUsageSink(insertUsageLog 适配) 落库 machine 级 closure_llm_log。
export {
  setGenerationUsageSink,
  dispatchGenerationCallRecord,
} from './usageSink';
export type { GenerationCallRecord, GenerationUsageSink } from './usageSink';
// 09-12 agy provider：CLI 形态驱动器（generate.ts 两分派点经 antigravityCliGenerateText
// 早退分派；setAntigravityCliGenerateForTest 是 generate.ts 分派的测试覆写缝；
// disposeAntigravityCliDriver 供 Electron main 退出关停单例会话池（W4 接线）；
// isAuthError 是 CLI 未登录短语族单源——driver 错误分类与 shell models 发现共用）。
export {
  antigravityCliGenerateText,
  setAntigravityCliGenerateForTest,
  createAntigravityCliDriver,
  classifyCliError,
  disposeAntigravityCliDriver,
  isAuthError,
} from './antigravityCli/driver';
export type { AntigravityCliDriver, AntigravityCliGenerateFn } from './antigravityCli/driver';
// 09-12 子4 agy MCP 工具桥：桥 turn 编排（W4 executor 经注入 seam 消费；shell
// installShellAgyBridgeCore 装配内核——wiring 测试钉死漏装配）。桥 turn 不经 generate
// 两分派点（design §6 边界），独立导出块。
export {
  runAgyBridgeTurn,
  installAgyBridgeCore,
  uninstallAgyBridgeCoreForTest,
  disposeAgyBridgeRuntime,
  __getAgyBridgeCoreForTest,
  bridgePoolSessionKey,
  bridgeFaceHash,
  bridgeHomeDirFor,
  BRIDGE_MCP_SERVER_NAME,
  BRIDGE_OUTPUT_DIRECTIVE,
  BRIDGE_SENDBACK_MESSAGE,
  MCP_SOFT_DENY_TOOL_MESSAGE_NEEDLE,
  MCP_SOFT_DENY_STDERR_NEEDLE,
  isMcpSoftDenyStderr,
  isMcpSoftDenyToolError,
  hasMcpDeniedAction,
} from './antigravityCli/bridgeTurn';
export type {
  AgyBridgeCore,
  BridgeToolFaceEntry,
  BridgeTurnInput,
  BridgeTurnResult,
  BridgeToolStepRecord,
  BridgeHomePayload,
  BridgeSessionOpenInput,
  BridgePermissionMode,
  AgyBridgePhaseEvent,
} from './antigravityCli/bridgeTurn';
export { defaultAgyPoolDeps } from './antigravityCli/driver';

