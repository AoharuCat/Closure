export { createWorkflowRuntime, isSessionNotFoundError } from './runtime/workflow';
export type {
  WorkflowRuntime,
  WorkflowRuntimeOptions,
  CreateSessionInput,
  SendMessageInput,
  StreamMessageInput,
  MessageAttachment,
  MessageSelectionAnchor,
  ExecuteSkillRequest,
  ExecuteSkillResponse,
  ContinuationSummary,
  RestoredContinuationResponse,
  // dogfood R2 #93：resume 续链完成回注 payload（shell closureChainIpc 组装后传
  // runtime.notifyLeaderChainCompleted——类型经包出口单源，防 shell 侧平行声明漂移）。
  ChainCompletedEventPayload,
} from './runtime/workflow';
export type { RuntimeStreamEvent, SessionState, SessionMessage, PendingConfirmationState, ConfirmationResolution, ChainStreamEvent, ChainNodeDeltaData, ChainNodeDoneData } from './types';
// dogfood T1 Stage 6（链节点流式）：CHAIN_RUN_SENTINEL_NODE_ID = 链 run 级终态帧的哨兵 nodeId
//（chain-node-done 的 data.nodeId === 本值时 status 为 run 终态）。UI / 测试消费同一单源。
export { CHAIN_RUN_SENTINEL_NODE_ID } from './types';
// dogfood T1 Stage 3（D4 启动对账）：shell 侧把崩溃残留的 stale 'running' 会话归位 idle
// （session.ts updateStatus 会 persistSession——内存 + meta.json + SQLite 三处一致）。
export { updateStatus as updateSessionStatus } from './agent/session';
export type { GenerateTextFn, GenerateTextRequest, GenerationDelta, GenerateTextCallbacks, GenerateTextUsage } from './provider/ipc-provider';
export type { ExecuteToolFn } from './tool/remote';
export { setGenerateTextFn } from './provider/ipc-provider';
// dogfood T1 Stage 1（流式缝）：generate 与 setGenerateTextFn 同源导出——shell 缝测试
// （agentIpcStreamDispatch）须从包外调用真实 generate 驱动已注入的 generateTextImpl，
// 才能钉住「callbacks 有无分派流式/非流式」这行 wiring（mirror resolveTaskModel 的 CR-001 姿态）。
export { generate } from './provider/ipc-provider';
export { setExecuteToolFn } from './tool/remote';
// dogfood #48：yaml 契约 prompts 基址注入缝——bundled 进 shell 后 import.meta.url
// heuristic 失配（ENOENT → degrade empty → researcher 丢 brief），shell 启动时注入真实基址。
export { setPromptsBaseDir } from './prompt/agentPrompt';
// C3.2 task-model routing: shell (agentIpc) injects the slot resolver through
// this seam — mirror of setGenerateTextFn above. The runtime never reads disk
// config itself (ADR-2 all-injection boundary); the injected resolver re-reads
// the task-models sidecar per call so slot changes apply without a restart.
// resolveTaskModel is exported alongside so the shell wiring test can pin the
// injection end-to-end (CR-001: deleting the agentIpc wiring line must go red).
export { setTaskSlotResolver, resolveTaskModel, assignmentThinkingControl, assignmentModelRef, assignmentContextWindowTokens, assignmentThinkingKind } from './runtime/taskModelRouting';
// S4b（task 08-25 design §4.1）：压缩红线策略注入缝——shell（agentIpc）注入
// readUserPreferences 现读闭包（mirror setTaskSlotResolver 形态）；workflow leader 车道
// 装配时现取注入 runLoop.redlinePercent。readContextPolicy 一并导出供 shell 接线测试钉注入。
export { setContextPolicyProvider, readContextPolicy } from './runtime/contextPolicy';
export { registerBuiltinTools } from './tool/builtin';
export { registry } from './tool/registry';
export { loadRuntimeConfig, listSkillPackages, setPackageEnabled, setSkillEnabled } from './runtime/config';
export type { SkillPackageInfo, SkillsConfig } from './runtime/config';
// Story 4.3 Step 3：deriveCheckpointPolicy + CheckpointPolicy 供 shell closureChainIpc / resumeChainIpc
// 入口从 session.permissionMode 推 checkpoint 策略（design §3.1 / §4 映射表）。纯函数 + type（无副作用）。
export { deriveCheckpointPolicy } from './contracts/run';
export type { CheckpointPolicy, CheckpointStage } from './contracts/run';
// Story 2.2 WP-E（CR-08-16-201）：resume IPC 消费 story-sync 反哺所需——cap 与 leader applier 单源
// （shell closureChainIpc 终态消费 mirror write_chapter applyStorySyncFeedback 档位判定），章节出处
// label helper 同源（「第 ch_1 章」畸形文案防线，CR-08-16-010）。
export { formatStorySyncChapterLabel, STORY_SYNC_REVIEW_CAP } from './tool/write-chapter';
// 风格卡片 MVP CR-026（08-28 BMad CR auditor#3）：style_context 消费单源导出——shell
// closureChainIpc 写章入口直调（mirror write_chapter agent 路径同一对函数，「零逻辑复制」
// 姿态同 lint/deriveCheckpointPolicy 先例）。readStyleCardBody = 读卡（无卡 ENOENT → undefined）；
// buildStyleContext = 全量版编译（纯函数）。style_context_brief 不导出——planner 派发侧
// （dispatch-planners）现读现编，非链内 artifact。
export { readStyleCardBody, buildStyleContext } from './tool/style-card';
// E10.3b（task 09-05）W1：14 节解析单源导出——shell decon:export-style（拆书风格维 → 目标
// 项目风格卡合并写）与 p4Style 特化面消费（语义键替换识别节/保留手写节，不复制匹配逻辑
// 防漂移——SECTION_DEFS 本体私有，解析经 parseStyleSections 已含键匹配）。
export { parseStyleSections } from './tool/style-card';
export type { StyleSectionKey } from './tool/style-card';
// C1.2 llmlint（Step 7 shell wiring）：lint 引擎面导出——shell lintIpc 直调（库形态内嵌，mirror
// closureChainIpc 直调 repository「零逻辑复制」姿态）。getLintEngine/aggregateFullReport = 纯读 +
// 纯聚合；writeLintChapterLedger = 账本写手单源（apply-fix 后刷新章账与 post-settle 共语义，防两处
// 写账漂移）；projectLintReportForL2 = agent 桶聚合封顶投影（classify 输入与 L2 prompt 注入同源）。
export { getLintEngine, aggregateFullReport, type LintEngine } from './lint/lintEngine';
export { writeLintChapterLedger, lintChapterLedgerPath } from './lint/lintLedger';
export { projectLintReportForL2, LINT_L2_FINDING_LIMITS } from './lint/lintL2Signal';
