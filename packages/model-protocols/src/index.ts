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
  // 09-19 CLI 白名单（W3）：纯文本车道零工具 agent 解析器注入缝（shell agentIpc 装配；
  // 生产单例驱动器每 turn 消费；wiring 测试经 __get 探针钉死漏装配）。
  setAntigravityCliTextAgentResolver,
  __getAntigravityCliTextAgentResolverForTest,
} from './antigravityCli/driver';
export type {
  AntigravityCliDriver,
  AntigravityCliGenerateFn,
  ResolveTextAgentFn,
  AntigravityCliDriverOptions,
} from './antigravityCli/driver';
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
  isMcpSoftDenyStderr,
  isMcpSoftDenyToolError,
  hasMcpDeniedAction,
} from './antigravityCli/bridgeTurn';
// 09-19 工具面修复批 R6（F13 + F9 单点收口）：权限软拒族**主体判据**——桥侧三针与纯文本
// 车道 isBuiltinToolAutoDeny 共用（两车道按主体分派不漂移）；旧 mcp 特化针常量随泛化退役。
export {
  PERMISSION_SOFT_DENY_MESSAGE_PREFIX,
  MCP_PERMISSION_SUBJECT,
  parsePermissionSoftDenyMessageSubject,
  parsePermissionSoftDenyStderrSubject,
  findPermissionSoftDenySubject,
  hasMcpPermissionSoftDeny,
  isMcpPermissionSubject,
} from './antigravityCli/permissionSoftDeny';
export type { PermissionSoftDenySubject } from './antigravityCli/permissionSoftDeny';
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
// 09-19 CLI 内置工具白名单（W1 内容源 + W2 桥落盘消费）：agy 声明式 agent 单一来源——
// 布局常量 / 注册表名单（R7 升级回归用）/ 双 agent 定义 / 渲染 + hash 尾标记（自有认定
// 与版本检测）。内容常量归协议层、fs 归 shell（module-boundaries）：shell 消费
// renderAgentMarkdown + 布局常量做假宿（W2）/ 真实全局（W3）落盘——协议层不管 fs。
export * from './antigravityCli/agents';
export { defaultAgyPoolDeps } from './antigravityCli/driver';

