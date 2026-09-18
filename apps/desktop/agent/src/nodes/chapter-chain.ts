import { gzipSync } from 'node:zlib';
import type { ChainLoopConfig, ChainNodeDef } from '../contracts/run';
import type { SessionState } from '../types';
import type { GenerateFn, LlmNodeDeps } from './llm-node';
import { createBriefCompilerNode } from './brief-compiler-node';
import { createBriefReviewerNode } from './brief-reviewer-node';
import { createRevisionOptimizerNode } from './revision-optimizer-node';
import {
  createReaderAuditNode,
  createRevisionGuardNode,
  createRouteNode,
} from './chapter-nodes';
import { createWriterNode, type WriterNodeDeltaPayload, type WriterNodeDeps } from './writer-node';
import { createResearchVerifier } from './research-verifier';
import { createStorySyncNode } from './story-sync-agent';
import {
  createWorldExtractorNode,
  createWorldMergeNode,
  type WorldWriter,
} from './world-extractor-node';
import { createPromiseEmergenceNode } from './promise-emergence-node';
import { createArcEmergenceNode } from './arc-emergence-node';
import { createEmotionVerifyNode } from './emotion-verify-node';
import { createLintNode } from './lint-node';
import { createCompletenessVerifyNode } from './completeness-verify-node';
import { createFeedbackLedgerNode, FEEDBACK_LEDGER_NODE_ID } from './feedback-ledger-node';
import { createChapterSummaryNode } from './chapter-summary-node';
import { createStoryTimeDriftNode } from './storytime-drift-node';
import { createMentionLedgerNode } from './mention-ledger-node';
import { tagChinese } from '../audit/pos-tagger';
import { registry } from '../tool/registry';
import { logger } from '../logger';
import type { SlotAssignment, TaskModelSlot, WriteWorldStateRequest } from '@orison/shared-contracts';
import type { ModelFallbackEventData, ChainToolEventData } from '../types';
import { withNodeArtifact, type ChainNodeArtifactEmit } from './chain-node-artifact';
import { assignmentContextWindowTokens, assignmentFallbackChain, assignmentModelRef, assignmentThinkingControl } from '../runtime/taskModelRouting';
import { readContextPolicy } from '../runtime/contextPolicy';

/**
 * C3.2 任务路由 + S4b 思考策略：链装配的每节点 slot 解析闭包（workflow.ts runChapterChain
 * 注入，生产装配 = `(slot) => resolveTaskModel(slot)`）。返回 **assignment 整体**
 *（modelRef + thinking 策略，S1 slotAssignmentSchema）——模型与思考策略同源随档（design
 * §1.2「不杂交」）。缺省/空档 undefined → modelRef=undefined（provider default 哨兵自动选择）
 * + thinking=undefined（auto 不注入）= 未配置任务档的现状路径（字节级零变化）。
 */
export type ChainSlotResolver = (slot: TaskModelSlot) => SlotAssignment | undefined;

// ── 链流程重排（09-13 W1d，task 09-13-chain-flow-restructure）：写章链装配新序 ──
//
// createChapterChainNodes 装配「规划环 → 写手 → 自审环（环内收敛）→ 提取段（对最终稿一次）」的
// 链段。每个节点是一个 AgentNode（纯代码编译器 / 观测节点或 createLlmNode / composite LLM 节点），
// 按 ChainNodeDef 数组顺序驱动（chainRunner.runChain）。
//
// 链序（design §1 权威序，W1d 落地形态）：
//   规划环（cap 2）[brief-compiler → brief-reviewer] → revision-optimizer → draft-writer →
//   自审环（cap 3）[revision-optimizer → draft-writer → revision-guard → lint → multi-review →
//   completeness → route] → 提取段 E1-E10（world×5 → merge → emotion → promise → arc → summary →
//   storytime → mention → story-sync → feedback-ledger）。
//
// **写手单位置进环体**（M3「单位置语义等价」拍板的落地形态）：draft-writer-agent 一个数组位
// （revision-optimizer 紧后）同时承担 B（整章首写——首圈 C1 no-op，写手无 intent 走整章路径）与
// C2（环内改稿——C1 编译 revision_intent 后写手带 directive 重跑）。design §1 图示的 B/C2「同 id
// 双位置」在此收敛为单位置：环体 from='revision-optimizer-node' 在写手**前**，环回 pointer 跳回
// C1 后写手在环体内重跑（AC5「环体 7 节点」= C1-C7 含写手）；redo 按 id 移除写手 → 前缀跳步停在
// 写手位重跑到链尾（M3 语义，W1d 测试钉死）。W1c optimizer 契约随位调整 requiredArtifactKeys=[]
// （C1 在写手前，首圈 no-op 不读稿——draft.initial 不进 required）。
//
// 节点 deps（generate + per-slot modelRef）由 runChapterChain（Step 5.2）从 WorkflowRuntime 注入——
// LLM 节点经 createLlmNode / composite 工厂用单次 generate；modelRef 经 C3.2/R1b 任务路由按节点
// 档位各自解析（llmDepsFor(slot)，见下）。session 供节点读 projectPath 等。
//
// targeted-revision-agent 退役（W0-1 三关联面）：① 装配位移除——「读 review.latest 整段改稿」职能
// 被环内 C1 编译 + 写手 directive 重跑覆盖；② mention 降档包装退役（mention-ledger-node.ts 注释）；
// ③ legacy STATE_KEY_MAP 条目移除（registry.ts 注释）。W4 F-1 + CR 批清理：prompts/targeted-revision-agent.yaml
// / tool/revision-optimizer.ts wrapper / UI 词表 / i18n / 单测 + dormant 工厂（chapter-nodes.ts）与
// agentContracts.ts CONTRACTS 条目**全部删除**（零残留——grep 守门）。
//
// expected_downstream_consumers:
// - workflow.ts runChapterChain：调本装配 + CHAPTER_CHAIN_LOOPS。
// - Story 8.4：核实子循环在 draft-writer 节点内派发（createWriterNode deps.verifier），非链内独立节点。

/**
 * 双环配置（design §1 / 链流程重排 W1d）。
 *
 * - 规划环 {from: brief-compiler, through: brief-reviewer, cap 2}：plan_review.verdict=revise（hard
 *   findings）→ 回 A1 重编；cap 超限 / LLM 判 escalate → escalate-pause（R4b）。软维度 findings 不
 *   抬档（verdict 归一在 brief-reviewer 节点 parseOutput 单源）。
 * - 自审环 {from: revision-optimizer, through: route, cap 3}：route decision=auto_revise → 链内回环
 *   （翻 7.4 候选④——环体含意图编译 + 保义护栏，不再 break 交 leader）；环体 7 节点（C1-C7 含写手，
 *   AC5 环瘦身：提取段 E1-E10 在环外零重跑）；cap 超限 → 强制 escalate-pause；accept → onAccept +
 *   verdict checkpoint 后自然前进进提取段。
 */
export const CHAPTER_CHAIN_LOOPS: readonly ChainLoopConfig[] = [
  { from: 'brief-compiler-node', through: 'brief-reviewer-node', cap: 2 },
  { from: 'revision-optimizer-node', through: 'route-agent', cap: 3 },
] as const;

/**
 * 链段节点 id 顺序（链装配权威序，供测试 + 链序守门；UI CHAIN_NODE_ORDER 镜像同步）。
 *
 * 提取段整体后置（design §4：对最终稿一次提取）：world 五轴/promise/arc/summary/mention/story-sync
 * 全部在 route 终态（accept）后跑——派生索引只从定稿派生（ADR-14 哲学更贴）；redo 重跑到链尾时
 * 幂等覆盖（slice.id 替换 / 自然键 upsert / per-episode 全量替换，W0-2 核实）。
 */
export const CHAPTER_CHAIN_NODE_IDS = [
  // ── A 规划环（cap 2）──
  'brief-compiler-node',
  // A2 独立视角规划审核（W1c 工厂）：六维 verdict+findings；checkpointStage='brief' 挪本节点——
  // readonly 档人审的是独立审核过的卡（卡附 reviewer findings）。软硬划界（severity）在此归一。
  'brief-reviewer-node',
  // ── 自审环 C1-C7（环体 7 节点，from/through 见 CHAPTER_CHAIN_LOOPS[1]）──
  // C1 改稿意图编译 in-chain 化（W1c 工厂）：首圈无 review.latest → no-op 直通（写手走整章首写）；
  // 环回圈读 review.latest 编译 revision_intent（source 机械盖戳 audit-finding）；**scope 机械构造
  // （CR-4）**——findings quote 命中段落经 buildSelectionAnchor 构 anchor（定位不到 → anchorless
  // 整章降级 + 附注）；外部预置意图（redo 注入 user-directive/redo-feedback）原样透传不稀释（M2）。
  // 在写手**前**：环回 pointer 跳到这里后写手在环体内重跑（环内改稿执行者）。
  'revision-optimizer-node',
  // B/C2 写手单位置（M3）：首圈整章两阶段写作（8.4 自查 + researchSuspension 动态 pause）；
  // 环回圈带 C1 编译的 revision_intent 重跑——anchored〔C1 机械定位 / redo 选区注入〕→ 段落级
  // passageText + guard splice；anchorless〔引文不可定位降级 / 整章 redo〕→ 整章 directive 重写。
  // checkpointStage='draft' 保留——W2 后非 scheduled 停点（deriveCheckpointPolicy 不含 'draft'），
  // 但挂起动态 pause 与 #93 草稿档案落盘都挂本 stage fire。
  'draft-writer-agent',
  // C3 保义护栏（每圈）：anchored intent → L1+L2 判定 + splice（环回圈默认形态——C1 机械构造
  // anchor 后主路径每圈有护栏，AC6 红 2）；anchorless/首写 → 整章路径 skip（7.2 既有语义，CR-4
  // 后仅降级路径与整章 redo 走此）。
  // checkpointStage='revision-guard' 动态 pause（soft-violation 才停）。
  'revision-guard-agent',
  // C4 去 AI 味静态扫描（每圈跑，纯代码）：draft.initial 落定后扫终版正文 → lint_report 喂 C5 L2 软信号。
  'lint-node',
  // C5 Reader-Audit 14 维审读（每圈）：对照源 = 启动前快照 + brief（提取后移后本章自提物不再进审读，
  // story.sync 已移出 requiredArtifactKeys〔W0-3〕+ continuityMemory var 已删〔W3 R5〕）。
  'multi-review-agent',
  // C6 cross-arc 完整性审核（每圈；W2 前 keep 环内位）。
  'completeness-verify-node',
  // C7 路由判决（环 through）：auto_revise=回环【W3 落去味门禁】/ accept=终稿 checkpoint（W2 起
  // stage='final'——route accept 后、E 段前唯一人审点）后自然前进提取段 / escalate=灰区
  // escalate-pause；cap 超限强制 escalate。
  'route-agent',
  // ── E 提取段（对最终稿一次，零 checkpoint；accept 后自然前进）──
  // E1 五轴 world-state 提取（物理串行，feedback-api-concurrency-no-parallel）。
  'world-extractor-physical',
  'world-extractor-cognitive',
  'world-extractor-emotional',
  'world-extractor-relational',
  'world-extractor-factional',
  // E2 五轴 patches 机械组装 + write_world_events 落表（稳定 slice.id 幂等替换不累积）。
  'world-merge-node',
  // E3 情绪轨迹校验（纯代码 VAD 数学；须 world-merge 落表后读 emotional patches）。
  'emotion-verify-node',
  // E4 Promise 涌现登记（gap 检测纯代码 + LLM 语义涌现；自然键 upsert 幂等）。
  'promise-emergence-node',
  // E5 写时弧节拍声明（候选纯代码 + LLM 判 advance/close；对终稿声明）。
  'arc-emergence-node',
  // E6 ChapterStateSummary 物化（六字段取数须在 promise 登记后新鲜；upsert last-write-wins）。
  'chapter-summary-node',
  // E7 storyTime 漂移守卫（纯代码观测；chapter-summary 旁）。
  'storytime-drift-node',
  // E8 mention 共现账汇账（四通道 → per-episode 全量替换幂等；对终稿正粗筛 + 终轮申报）。
  'mention-ledger-node',
  // E9 story-sync 反哺提取（WP-E；对终稿提取，patches 供收尾 applier）。
  'story-sync-agent',
  // E10 feedback-ledger 终态一次写（三输入 review.latest/completeness/emotion 在此点齐——环终态 + E3）。
  FEEDBACK_LEDGER_NODE_ID,
] as const;

/**
 * E 段装配 deps（链流程重排 W4 / R6：buildExtractionSegment 消费——链装配与链外重提取单源）。
 */
export interface ExtractionSegmentDeps {
  /** extraction 档 llmDeps（E 段全部 LLM 位共用——world×5 / promise 段2 / arc 段2 / story-sync）。 */
  llmDeps: LlmNodeDeps;
  /** world-state 写入器（E2 world-merge 落表；mirror chapter-chain 装配 writeWorldEvents）。 */
  writeWorldEvents: WorldWriter;
  /** story-sync loadStorySyncContext 的 projectPath（读 project.yaml 组提取 context）。 */
  projectPath: string;
  /** 节点流增量回调（09-13 子2 可观测；缺省不开零回归）。E 段 JSON 节点无 phase 标注。 */
  onNodeDelta?: (data: { nodeId: string; role: string; phase?: string; channel?: 'text' | 'reasoning'; messageId: string; delta: string }) => void;
}

/**
 * 构造 E 提取段节点数组（E1-E10，链序段内权威——链流程重排 W4 抽出，双消费单源）：
 *
 * 1. **链装配**（createChapterChainNodes 尾段 spread）——对最终稿一次提取（route accept 后自然前进；
 *    redo 重跑幂等覆盖：slice.id 替换 / 自然键 upsert / per-episode 全量替换，W0-2）。
 * 2. **链外重提取**（workflow.ts reExtractChapter）——盘上正文 → standalone runChain 驱动本段（E1-E9，
 *    feedback-ledger 由 caller filter 掉：三输入含环终态 review/completeness，重提取语境不存在）。
 *
 * 节点构造与链装配逐字一致（slot/streaming/writer 同形）——改 E 段节点集只改本工厂一处。
 */
export function buildExtractionSegment(deps: ExtractionSegmentDeps): ChainNodeDef[] {
  // 节点流包装（mirror createChapterChainNodes withNodeStreaming 的无 phase 形态——E 段 JSON 节点
  // 恒不带 phaseOf）。onNodeDelta 缺省 → deps 原样（零回归）。
  const streamWrap = (nodeId: string, role: string, d: LlmNodeDeps): LlmNodeDeps =>
    deps.onNodeDelta
      ? {
          ...d,
          onDelta: (delta: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) =>
            deps.onNodeDelta!({ nodeId, role, ...delta }),
        }
      : d;
  return [
    // ── E 提取段（对最终稿一次，零 checkpoint；route accept 后自然前进；redo 重跑幂等覆盖）──
    // E1 五轴 world-state 提取（LLM，物理串行顺序跑）：axis 强制注入每条 patch（不信 LLM 标注）。
    // 09-13 子2 W2a：开流（五轴提取 reasoning 思考流；role=event-extractor-<axis>——工厂 config 的
    // yaml prompt 名，与节点 id world-extractor-<axis> 有意区分）。
    { id: 'world-extractor-physical', node: createWorldExtractorNode('physical', streamWrap('world-extractor-physical', 'event-extractor-physical', deps.llmDeps)) },
    { id: 'world-extractor-cognitive', node: createWorldExtractorNode('cognitive', streamWrap('world-extractor-cognitive', 'event-extractor-cognitive', deps.llmDeps)) },
    { id: 'world-extractor-emotional', node: createWorldExtractorNode('emotional', streamWrap('world-extractor-emotional', 'event-extractor-emotional', deps.llmDeps)) },
    { id: 'world-extractor-relational', node: createWorldExtractorNode('relational', streamWrap('world-extractor-relational', 'event-extractor-relational', deps.llmDeps)) },
    { id: 'world-extractor-factional', node: createWorldExtractorNode('factional', streamWrap('world-extractor-factional', 'event-extractor-factional', deps.llmDeps)) },
    // E2 merge 写表（纯代码）：五轴 world_events 机械组装 + write_world_events 落表（幂等替换）。
    { id: 'world-merge-node', node: createWorldMergeNode({ writeWorldEvents: deps.writeWorldEvents }) },
    // E3 emotion-verify 纯代码节点（world-merge 后、promise-emergence 前——emotional patches 须落表
    // 后可读；payoff 联动读 promise_registry 截止态避循环）。graceful：任一源缺陷降级不阻断链。
    // 不声明 checkpointStage（增强非硬约束节点，mirror E 段全部提取节点）。
    { id: 'emotion-verify-node', node: createEmotionVerifyNode() },
    // E4 Promise 涌现登记（段 1 纯代码 gap 检测 + 段 2 LLM 涌现）→ promise_ledger_update 写
    // promise_registry（自然键 upsert 幂等，W0-2）。graceful：失败不破链（增强非硬约束）。
    // 09-13 子2 W2a：开流（段 2 LLM 涌现登记 reasoning 思考流——段 1 纯代码无 LLM 零事件）。
    { id: 'promise-emergence-node', node: createPromiseEmergenceNode(streamWrap('promise-emergence-node', 'promise-emergence-agent', deps.llmDeps)) },
    // E5 写时弧节拍登记（段 1 纯代码候选 + 段 2 LLM 声明）→ arc_ledger_update（autoApply）写
    // arc_registry（自然键幂等，W0-2）。对终稿声明（提取后移语义：人审后的正文）。
    // 09-13 子2 W2a：开流（段 2 LLM 弧节拍声明 reasoning 思考流——段 1 纯代码无 LLM 零事件）。
    { id: 'arc-emergence-node', node: createArcEmergenceNode(streamWrap('arc-emergence-node', 'arc-emergence-agent', deps.llmDeps)) },
    // E6 ChapterStateSummary 物化（纯代码薄节点）：summary 六字段须在 promise 登记后取数新鲜
    // （E4 后）。graceful：episodeId 缺/工具未注册/失败 → warn 降级不破链（DERIVED 可 backfill）。
    { id: 'chapter-summary-node', node: createChapterSummaryNode() },
    // E7 storyTime 漂移守卫（纯代码观测）：读 world_state.events × scene_graph 场窗比对 →
    // storytime_drift artifact → summarize driftWarnings 透出。零阻断零噪音。
    { id: 'storytime-drift-node', node: createStoryTimeDriftNode() },
    // E8 mention 共现账汇账（纯代码薄节点）：四通道合并 → record_episode_mentions（per-episode
    // 全量替换幂等）+ synopsis 回填（E6 物化在前由链序保证）。
    // 链流程重排（W1d）：targeted-revision 降档包装退役——新链 mention 账恒在终稿后计算
    // （提取后置 + redo 重跑到链尾必经本节点重收），环内改稿不再留 stale 账窗口（详
    // mention-ledger-node.ts 退役注释）。
    { id: 'mention-ledger-node', node: createMentionLedgerNode() },
    // E9 story-sync 节点（WP-E）：对终稿提取 → story.sync artifact（patches 供收尾 applier——
    // W3 收尾时序已移 E 段完成：summary 到达入口层时 E9 已对终稿提取）。graceful：LLM/parse 失败 → rules 兜底
    // （空 patches）链不破。
    // 09-13 子2 W2b：开流（LLM 提取 reasoning 思考流——单发无重试环）。
    { id: 'story-sync-agent', node: createStorySyncNode({ llm: streamWrap('story-sync-agent', 'story-sync-agent', deps.llmDeps), projectPath: deps.projectPath }) },
    // E10 feedback-ledger 终态一次写（纯代码薄节点）：读 review.latest（环终态）+
    // emotion_verify_result（E3 产）+ completeness_verify_result（C6 终态）三输入——提取后移后
    // 三者在 E 段末点齐（design §1 E10 链位理由）。graceful：artifact 不全/工具未注册 → warn 继续。
    { id: FEEDBACK_LEDGER_NODE_ID, node: createFeedbackLedgerNode() },
  ];
}

/**
 * 装配写章链段节点数组（design §1 链序权威 / implement.md W1d）。
 *
 * @param generate LLM 生成函数（GenerateFn，与 provider generate 兼容子集；runChapterChain 注入 generateImpl）。
 * @param resolveSlot C3.2/R1b 任务路由：每节点 slot 解析闭包——各 LLM 节点装配行按档位表各自调
 *   resolveSlot(<slot>)；缺省 undefined → 全 undefined（自动选择现状）。
 * @param _session 派发链段的 child session（4.0 LLM 节点不直接用，签名预留供未来节点读 projectPath 等）。
 * @param signal  链段 abort 信号（CR-001 接线：runChain deps 持有的取消信号在此**同源透传给节点构造 deps**，
 *   写手 agent 循环（阶段一自查/补查/阶段二）与资料员核实子循环的取消窗口从「makeAgentLoop 兜底自建
 *   永不 abort 的 signal」变为真可中断。缺省 = 各节点内部自建永不 abort 的 signal（4.0 既有行为））。
 * @returns ChainNodeDef[]——按链序排好的节点（A1 → A2 → C1-C7 → E1-E10）。
 */
export function createChapterChainNodes(
  generate: GenerateFn,
  resolveSlot: ChainSlotResolver | undefined,
  session: SessionState,
  signal?: AbortSignal,
  /**
   * dogfood T1 Stage 6（design §4 / r1）→ 09-13 子2 W1 双通道：节点流增量回调（runChapterChain
   * 注入；装配处补 nodeId/role/channel/phase——draft-writer 阶段二正文 text + 各 LLM 位思考流
   * reasoning）。缺省不开（零回归）。
   */
  onNodeDelta?: (data: { nodeId: string; role: string; phase?: string; channel?: 'text' | 'reasoning'; messageId: string; delta: string }) => void,
  /**
   * 09-12 子2 fallback chains（design §7）：链内模型切换事件回调（runChapterChain 注入
   * emitChainEvent 包装；本装配方补 nodeId/role 后转 ChainStreamEvent 'model-fallback'）。
   * 覆盖面 = writer 两阶段循环 + 核实子循环（链上唯一有运行期事件面的 LLM 位）；单发
   * JSON 节点（brief-reviewer/revision-guard/route 等）无事件面，靠网关 logger.warn
   * 兜底（design §7 如实接受）。缺省不开（零回归）。
   */
  onModelFallback?: (event: ModelFallbackEventData) => void,
  /**
   * 09-13 子2 W3（design §2 产出快照）：节点终态产出快照发射回调（runChapterChain 注入——
   * workflow 侧补 seq 快照后转 ChainStreamEvent 'chain-node-artifact'）。本装配方对全链
   * 23 节点统一应用 withNodeArtifact 包装（发射形态表单源 = nodes/chain-node-artifact.ts）
   * ——节点 run 终态后从 artifact 机械投影 summary，不侵入节点实现。缺省不开 → 包装恒
   * identity（测试 / 链外 reExtractChapter 车道零回归）。
   */
  onNodeArtifact?: ChainNodeArtifactEmit,
  /**
   * 09-13 子2 W4（design §3，B 路线定案）：链内工具调用事件回调（runChapterChain 注入
   * emitChainEvent 包装）。覆盖面 = 写手三循环 + 核实子循环（链内唯一带工具的循环——
   * createLlmNode 系节点 tools=[] 传空零调用，「阶段一 research 工具为主」自动成立）；
   * 本装配方补 nodeId（draft-writer-agent——工具调用全发生在该节点位）转 ChainStreamEvent
   * 'chain-tool'。leader/child 车道不经本装配不发射。缺省不开（测试 / 非流式车道零事件
   * 零回归）。
   */
  onChainToolCall?: (data: ChainToolEventData) => void,
): ChainNodeDef[] {
  // C3.2 任务路由（design §2 档位表 canonical）：单份 llmDeps 拆为 llmDepsFor(slot)——每个 LLM 节点
  // 装配行各自解析（接线漏了 = 恒走 fallback，与未配置不可观测区分 → 接线测试钉 generate 实收
  // opts.modelRef，task-model-routing.wiring.test.ts）。装配时解析一次（每章 run 一次——改档下一次
  // 链装配生效，design §1「链车道下一次链装配」语义）。
  // S4b：assignment 整体随档——llmDeps 增 thinking（assignmentThinkingControl 归一：custom 优先、
  // 非 auto 档位 {level}、否则 undefined=auto 不注入）。
  // R1b（09-13）：审核族细档（plan-review/multi-review/route-judge/revision-guard）——细档未配回落
  // review-judge 的档间回落链在 resolveTaskModel 单源（taskModelRouting.ts），装配侧直用细档名。
  const resolveAssignment = (slot: TaskModelSlot): SlotAssignment | undefined => resolveSlot?.(slot);
  // Story 4.2：tagChinese + compress 注入 Reader-Audit L1（ADR-2 DI seams）。draft-writer/route 等
  // 经 createLlmNode 忽略这两个字段（只读 generate/modelRef/signal）。compress 用 gzip level 9（同
  // stylometry.test.ts fixture 形态）。tagChinese native binding 缺时 isPosTaggerAvailable()=false，L1 跳过
  // POS 信号（design §10 rollback，余 7 信号仍上）。
  const llmDepsFor = (slot: TaskModelSlot) => {
    const assignment = resolveAssignment(slot);
    const fallbacks = assignmentFallbackChain(assignment);
    return {
      generate,
      modelRef: assignmentModelRef(assignment),
      thinking: assignmentThinkingControl(assignment),
      // 09-12 usage-panel：taskType = 节点档位名（writer-draft / review-judge / extraction…
      // 与路由同 slot 单源——byTask 分解的六档词面即此）。
      taskType: slot,
      // 09-12 子2：slot 回退链随档（H2 透传——空链不占位，网关走零默认链快径）。
      ...(fallbacks?.length ? { fallbacks } : {}),
      // CR-001：真 abort signal 进 llmDeps——写手 agent 循环（loopDeps 透传 makeAgentLoop）与全部
      // createLlmNode 系节点（legacy 直写引擎 / Reader-Audit / revision-guard / brief-reviewer /
      // revision-optimizer / route）共享同一取消信号（runChain deps.signal 同源）。缺省 undefined →
      // 各节点自建永不 abort 的 signal（4.0 既有行为，测试装配零回归）。
      ...(signal !== undefined ? { signal } : {}),
      tagChinese,
      compress: (s: string) => gzipSync(s, { level: 9 }).length,
    };
  };
  // C3.2 design §2 软回退链：自查档空 → 跟随 writer-draft 档（S5 定案「两阶段同模型」既有默认）→
  // 自动选择。**assignment 粒度回退**（S4b，design §1.2）：取整 assignment（模型+思考策略同源），
  // 不出现 selfcheck 模型 + draft 思考策略的杂交。writer-selfcheck 档的**全部**调用面（Phase1
  // 自查/补查 loop + 资料员核实子循环）共用此值——核实器不得绕过回退链单独落自动选择（否则只配
  // draft 时自查阶段被劈成两个模型）。
  const writerSelfcheckAssignment = resolveAssignment('writer-selfcheck') ?? resolveAssignment('writer-draft');
  // CR-14（09-12 子2 CR 批）：自查档链投影单次求值（writer 两阶段循环与核实子循环两处
  // 消费同一份——spread 条件+取值双写 = TOCTOU + 复制粘贴面）。
  const selfcheckFallbackChain = assignmentFallbackChain(writerSelfcheckAssignment);
  // S4c（design §4.1「makeAgentLoop 补闸门」接线）：写手两阶段循环 + 资料员核实子循环的 pre-gate
  // 窗口/红线——窗口取各自 loop 所用 assignment 的模型 limits（Phase2 写作/2.5 申报 = writer-draft；
  // Phase1 自查/补查 + 核实 = selfcheck 回退链整体）；红线链装配时 readContextPolicy() 现读
  //（seam 由 shell 注入，与 slot 同「下一次链装配生效」语义）。链段单发 createLlmNode 节点无会话史，
  // 不涉闸门（design §4.1）。未配置/未知模型 → undefined → S4a 接收面回落 1M。
  const writerDraftAssignment = resolveAssignment('writer-draft');
  const selfcheckWindowTokens = assignmentContextWindowTokens(writerSelfcheckAssignment);
  const draftWindowTokens = assignmentContextWindowTokens(writerDraftAssignment);
  const chainRedlinePercent = readContextPolicy()?.redlinePercent;
  // Story 6.6 Phase C1：world-state 写入器——经 registry 查 write_world_events builtin 工具（remoteToolProxy
  // → toolExecution IPC → shell worldStateHandlers）。工具未注册（测试环境 registry 空 / 未 registerBuiltinTools）
  // → 跳过落表 + warn 日志（graceful，merge 节点仍产 artifact）。生产路径 registerBuiltinTools 已注册该工具。
  // session 提供 projectPath / sessionId（handler 从 projectDir 解析 projectId；sessionId 走 toolExecution 通道）。
  const writeWorldEvents: WorldWriter = async (req: WriteWorldStateRequest) => {
    const tool = registry.get('write_world_events');
    if (!tool) {
      logger.warn(
        { sliceId: req.slice.id },
        'chapter-chain: write_world_events tool not registered → skip world-state write (merge node still produces artifact)',
      );
      return;
    }
    await tool.execute(req, {
      projectPath: session.projectPath,
      sessionId: session.id,
      abort: new AbortController().signal,
    });
  };
  // 09-12 子2：draft-writer 节点的模型切换事件包装（mirror onNodeDelta 的 nodeId/role 补齐
  // 形态）——writer 两阶段循环 + 核实子循环共用（同节点位，chip 同卡翻转）。
  const draftNodeFallbackEmit = onModelFallback
    ? (event: { from: { keyId: string; modelId: string }; to: { keyId: string; modelId: string }; reason: string; attempt: number }) =>
        onModelFallback({ ...event, nodeId: 'draft-writer-agent', role: 'draft-writer-agent' })
    : undefined;
  // 09-13 子2 W4（design §3）+ CR 批 CR-11：链内工具调用事件包装（mirror
  // draftNodeFallbackEmit 形态——seam 级回调补 nodeId）——写手循环与核实子循环共用。
  // CR-11：nodeId 改读 loop deps 透传值（writer 三循环 / 核实子循环在各自 makeAgentLoop
  // deps 注入节点位，agent-loop 发射并入载荷）——wrapper 不再硬编码，缺省兜底
  // 'draft-writer-agent'（直构测试未传 nodeId 形态）。第二工具节点接入时复用本 wrapper 不误标。
  const draftNodeToolCallEmit = onChainToolCall
    ? (d: { nodeId?: string; toolName: string; inputSummary: string; resultCount?: number; status: 'ok' | 'error' }) => {
        const { nodeId: emittedNodeId, ...rest } = d;
        onChainToolCall({ ...rest, nodeId: emittedNodeId ?? 'draft-writer-agent' });
      }
    : undefined;
  // ── 09-13 子2 W1（design §1 可观测通道骨架）：节点开流装配工厂——节点层流回调闭包补
  //    nodeId/role（channel 透传）投影成 workflow onNodeDelta 形态。接线现状（W2b 收满 15 LLM 位）：
  //    - createLlmNode 单发位 **全 10 位接满**（W1 先例 brief-reviewer + W2a 批量 9 位：
  //      revision-optimizer / route / world-extractor×5 / promise 段2 / arc 段2）：注入
  //      deps.onDelta（llm-node 每次尝试预分配 messageId）；phaseOf 静态标注可选（JSON
  //      节点缺省不带 phase）；
  //    - writer composite 位（draft-writer）：注入 deps.onNodeDelta（writer 自带 phase
  //      union + channel 投影透传）+ 核实子循环 onDelta（phase 静态标 'research'）。
  //    - composite 4 位（W2b）：revision-guard L2 / multi-review L2 / completeness L2 /
  //      story-sync——节点 deps 消费 onDelta（每次尝试预分配 messageId + tool 通道滤除，
  //      mirror llm-node）经本工厂注入。事件面稀疏位说明：revision-guard L2 条件执行
  //      （整章路径 skip——事件只在 anchored 改稿圈出现，no-op 语义非接线缺失）；
  //      revision-optimizer 首圈 no-op 不调 generate 零事件同理。
  //    节点层通道政策（text 仅 draft-writer 阶段二）在节点内滤（writer-node /
  //    research-verifier）——本工厂只投影不过滤。onNodeDelta 缺省（测试 / 非流式车道）→
  //    deps 原样返回（零回归）。
  // ──
  const withNodeStreaming = (
    nodeId: string,
    role: string,
    deps: LlmNodeDeps,
    phaseOf?: string,
  ): LlmNodeDeps =>
    onNodeDelta
      ? {
          ...deps,
          onDelta: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) =>
            onNodeDelta({ nodeId, role, ...(phaseOf !== undefined ? { phase: phaseOf } : {}), ...d }),
        }
      : deps;
  const withWriterNodeStreaming = (nodeId: string, role: string, deps: WriterNodeDeps): WriterNodeDeps =>
    onNodeDelta
      ? {
          ...deps,
          onNodeDelta: (d: WriterNodeDeltaPayload) => onNodeDelta({ nodeId, role, ...d }),
        }
      : deps;
  // 核实子循环（createResearchVerifier）reasoning-only 流：phase 静态标 'research'（核实与
  // 调查同层，子3「写作三层」锚；text 已在 research-verifier 内滤——verdict JSON 不开正文流）。
  const verifyDeltaEmit = onNodeDelta
    ? (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) =>
        onNodeDelta({ nodeId: 'draft-writer-agent', role: 'draft-writer-agent', phase: 'research', ...d })
    : undefined;
  // 09-13 子2 W3（design §2 产出快照）：装配处统一应用 withNodeArtifact 投影包装——全链 23 节点
  // （含 E 段 spread 行）一处 map 覆盖，发射形态表单源在 nodes/chain-node-artifact.ts（按 def.id
  // 查表；表外 id / emit 缺省 → identity 返回零回归）。发射顺序结构性先于同节点 node-done
  //（包装内先发再 return——chainRunner 的 onNodeDone 在 run 返回后才调）。
  const defs: ChainNodeDef[] = [
    // ── A 规划环（CHAPTER_CHAIN_LOOPS[0]：[brief-compiler..brief-reviewer] cap 2）──
    // A1 纯代码编译器：leader 上游意图 + 结构化数据汇编成 ChapterBrief。checkpointStage **不**在
    // 本节点——挪 A2（brief-reviewer）后：readonly 档人审的是独立审核过的卡（design §1 A2 段）。
    { id: 'brief-compiler-node', node: createBriefCompilerNode() },
    // A2 独立视角规划审核（W1c 工厂，prompts/brief-reviewer-agent.yaml）：读 chapter_brief（+
    // optional episode_outlines/emotion_curve/genreContract——W0-9 最小充分集）→ 六维 verdict+findings。
    // plan_review.verdict 驱动规划环（revise→回 A1 / escalate→escalate-pause / pass→进写手）；
    // 软硬划界归一在此节点 parseOutput 单源（soft-only revise → pass+附注，防确定性空转环）。
    // slot=plan-review（R1b 细档，未配回落 review-judge）。CR-E3 graceful wrapper：LLM 失败 →
    // skipped pass-through 直通写作（非 clean pass，观测可辨）。
    // 09-13 子2 W1：withNodeStreaming 开流（createLlmNode 路线先例——reasoning 思考流经
    // llm-node onDelta → chain-delta channel='reasoning'；JSON 节点无 phase 标注）。
    { id: 'brief-reviewer-node', node: createBriefReviewerNode(withNodeStreaming('brief-reviewer-node', 'brief-reviewer-agent', llmDepsFor('plan-review'))), checkpointStage: 'brief' },
    // ── 自审环（CHAPTER_CHAIN_LOOPS[1]：[revision-optimizer..route] cap 3，环体 7 节点含写手）──
    // C1 改稿意图编译 in-chain 化（W1c 工厂，复用 revision-optimizer-agent.yaml）：环回圈读
    // review.latest block/warn findings 编译 RevisionIntent（source 机械盖戳 'audit-finding'）+
    // **scope 机械构造（CR-4）**——findings quote 命中段落经 buildSelectionAnchor 构 anchor（selectedPassage
    // 同源命中段；定位不到 → anchorless 整章降级 + intent 附注）；首圈无 review.latest → no-op 直通；
    // 正文空（corrupt resume，CR-20）→ no-op 守卫；外部预置意图（redo 注入）原样透传不稀释（M2）。
    // 编译失败 → optimizer_failed 信号（chainRunner W1a：失败圈 through 判决强制 escalate-pause，
    // 永不静默）。anchored intent 是环体主路径（C3 护栏真跑的前提）。
    // slot 维持现状粗档 review-judge——意图编译归审核族但未细拆 fine slot（R1b 表 revision-optimizer-agent
    // 仍挂 dispatch 供 leader 侧），回落 review-judge 语义。
    // 09-13 子2 W2a：withNodeStreaming 开流（环回圈编译轮 reasoning 思考流；首圈 shouldSkip
    // no-op 不调 generate 零事件——事件面稀疏是 no-op 语义非接线缺失）。
    { id: 'revision-optimizer-node', node: createRevisionOptimizerNode(withNodeStreaming('revision-optimizer-node', 'revision-optimizer-agent', llmDepsFor('review-judge'))) },
    // B/C2 写手单位置（M3「单位置语义等价」落地，见文件头注）：createWriterNode 节点内两阶段
    // agent 循环（阶段一自查产调查简报 / 阶段二写作产 draft.initial）+ 注入资料员核实器
    // （createResearchVerifier——retrieval-agent.yaml 转岗核实员，独立子循环对照任务卡核简报产
    // verdict；escalate/超限 → pause 型挂起载荷 research_brief.suspended → workflow onCheckpoint
    // decideCheckpointPause 全档位暂停，8.4 Step 4）。段落级改稿 intent（C1 机械构造 anchor / redo
    // 选区注入）→ 节点内部降级单发直写（design §5 零回归）。**在环体内**（revision-optimizer 紧后）：
    // auto_revise 环回时带 C1 编译的 revision_intent 重跑 = 环内改稿执行者（7.4 targeted-revision
    // 退役后的继任）。redo 按 id 移除本节点 → 前缀跳步停在此位重跑到链尾。
    // checkpointStage='draft' 保留（W2 重映射 'final'——本波不动 checkpoint 策略）。
    {
      id: 'draft-writer-agent',
      // C3.2：写手双档（design §2）——deps.modelRef = writer-draft 档（Phase2 写作/2.5 申报/legacy
      // 直写引擎共用）；selfcheckModelRef = writer-selfcheck 档（Phase1 自查/补查 + 资料员核实子循环，
      // 8.4 阶段一核实回路），空档软回退 writer-draft 档（writerSelfcheckRef，见上）。writer-node 内
      // buildLoop 按 phase 取用。
      // dogfood T1 Stage 6 → 09-13 子2 W1：withWriterNodeStreaming 开流（composite 路线先例——
      // writer 四调用点全相位：reasoning 全放行 + text 仅阶段二，phase union 投影；seq 由 workflow
      // runChapterChain 包装时分配）。
      node: createWriterNode(withWriterNodeStreaming('draft-writer-agent', 'draft-writer-agent', {
        ...llmDepsFor('writer-draft'),
        selfcheckModelRef: assignmentModelRef(writerSelfcheckAssignment),
        selfcheckThinking: assignmentThinkingControl(writerSelfcheckAssignment),
        // 09-12 子2：自查档回退链成对（selfcheck ?? draft assignment 整体，不杂交）+ 节点位
        // 切换事件（writer 两阶段循环 + 降级直写引擎经 deps.fallbacks 同受链保护）。
        selfcheckFallbacks: selfcheckFallbackChain,
        ...(draftNodeFallbackEmit ? { onModelFallback: draftNodeFallbackEmit } : {}),
        // 09-13 子2 W4（design §3）：链内工具调用观测（写手三循环——自查/补查/写作/申报全相位）。
        ...(draftNodeToolCallEmit ? { onToolCall: draftNodeToolCallEmit } : {}),
        // S4c pre-gate 注入（见上方 writerSelfcheckAssignment 注释块的 S4c 段）。
        ...(draftWindowTokens !== undefined ? { contextWindowTokens: draftWindowTokens } : {}),
        ...(selfcheckWindowTokens !== undefined ? { selfcheckContextWindowTokens: selfcheckWindowTokens } : {}),
        ...(chainRedlinePercent !== undefined ? { redlinePercent: chainRedlinePercent } : {}),
        // 09-12 agy provider（design §3.1 装配点②）+ CR-21：写手循环的逻辑会话键——按
        // 逻辑会话命名空间分键（chain:<childSessionId>:writer，与核实子循环 :verify 分池）：
        // 同模型场景下两循环交替共键 = 每次交替判镜像分歧冷重启，缓存红利蒸发。
        // childSession 是 dispatchSubagent 每次 run 新建的（resume/redo 同样新 dispatch）→
        // 每链 run 唯一；两阶段循环（自查/写作/申报）同键进 generate opts。
        sessionKey: `chain:${session.id}:writer`,
        verifier: createResearchVerifier({
          generate,
          modelRef: assignmentModelRef(writerSelfcheckAssignment),
          thinking: assignmentThinkingControl(writerSelfcheckAssignment),
          // 09-12 usage-panel：核实子循环 = writer-selfcheck 档（与 selfcheckModelRef 同
          // assignment——空档软回退 draft 档模型，但流程标签恒标自查档）。
          taskType: 'writer-selfcheck',
          // 09-12 子2：核实子循环随自查档链 + 同节点位切换事件。
          ...(selfcheckFallbackChain?.length ? { fallbacks: selfcheckFallbackChain } : {}),
          ...(draftNodeFallbackEmit ? { onFallback: draftNodeFallbackEmit } : {}),
          // 09-13 子2 W4（design §3）：核实子循环工具调用观测（同节点位 draft-writer-agent）。
          ...(draftNodeToolCallEmit ? { onToolCall: draftNodeToolCallEmit } : {}),
          ...(selfcheckWindowTokens !== undefined ? { contextWindowTokens: selfcheckWindowTokens } : {}),
          ...(chainRedlinePercent !== undefined ? { redlinePercent: chainRedlinePercent } : {}),
          // CR-001：核实子循环同源 signal（与写手循环 / runChain deps 同一取消信号）。
          ...(signal !== undefined ? { signal } : {}),
          // 09-13 子2 W1：核实子循环 reasoning-only 思考流（phase='research'——makeAgentLoop
          // 路线第四个补传调用点；text 在 research-verifier 内滤）。
          ...(verifyDeltaEmit ? { onDelta: verifyDeltaEmit } : {}),
          // 09-12 agy provider + CR-21：核实子循环独立会话键（chain:<id>:verify）——
          // 与写手循环分池（见上方 writer 装配注释）。
          sessionKey: `chain:${session.id}:verify`,
          projectPath: session.projectPath,
        }),
      })),
      checkpointStage: 'draft',
    },
    // C3 保义护栏（每圈）：anchored intent → L1（纯代码幅度核对）+ L2（6 类漂移裁判）→ clean
    // splice 落 draft.initial / soft-violation 动态 pause（art-mode）/ hard-violation error。
    // **环体主路径每圈有护栏（CR-4）**：C1 机械构造 anchor 后 lint/review findings 驱动的 auto_revise
    // 改稿恒 anchored；anchorless intent（引文不可定位降级）/ 整章首写 → 整章路径 skip（7.2 既有
    // 语义——护栏的对象是段落级 splice 的选区改写，整章重写的保义靠 RevisionIntent 编译 lockedItems
    // + 再审）。
    // checkpointStage='revision-guard'——pause 是**动态**的（workflow.ts onCheckpoint 闭包读
    // revision_guard.verdict，仅 'soft-violation' 返 pause）。slot=revision-guard（R1b 细档）。
    // 09-13 子2 W2b：withNodeStreaming 开流（anchored 改稿圈 L2 判决 reasoning 思考流；整章路径
    // skip L2 零事件——条件执行位，事件面稀疏是 no-op 语义非接线缺失）。无 phase 标注（单发 JSON）。
    { id: 'revision-guard-agent', node: createRevisionGuardNode(withNodeStreaming('revision-guard-agent', 'revision-guard-agent', llmDepsFor('revision-guard'))), checkpointStage: 'revision-guard' },
    // C4 lint-node 静态扫描（纯代码，无 LLM）——draft.initial → llmlint 静态引擎 agent 桶扫描 →
    // lint_report artifact（C5 L2 叙事特征维软信号消费，静态命中≠定罪）。**每圈跑**（提取后移后
    // 本节点在环体内，auto_revise 每圈重扫改后稿——出环门禁 W3 落 route 判据）。不声明
    // checkpointStage。graceful：引擎缺位/draft 缺位/异常 → 空 report 降级不破链。
    { id: 'lint-node', node: createLintNode() },
    // C5 Reader-Audit composite（Story 4.2：L1 stylometry → L2 LLM 双层审核）。节点 id 仍
    // 'multi-review-agent'（stable artifact contract）。requiredArtifactKeys 已移除 'story.sync'
    // （W0-3 断链级适配：story-sync 后移 E9，hard required 会让每章在 C5 位 blocked）；continuityMemory
    // var 已删（W3 R5——buildPrompt 不再读 story.sync）。slot=multi-review（R1b 细档）。
    // 09-13 子2 W2b：withNodeStreaming 开流（L2 审读 reasoning 思考流——每圈；重试轮 messageId
    // 分层在节点内 attemptMessageId 预分配）。无 phase 标注（单发 JSON）。
    { id: 'multi-review-agent', node: createReaderAuditNode(withNodeStreaming('multi-review-agent', 'multi-review-agent', llmDepsFor('multi-review'))) },
    // C6 completeness-verify（cross-arc 完整性）：L1 纯代码候选汇编 + L2 语义挣得裁判。环体内
    // （每圈跑，route 前——through 可达性）。slot 并 multi-review 档（design §1 审核族同族不碎片化）。
    // 不声明 checkpointStage（增强非硬约束节点）。graceful：数据源缺 → 降级 degraded 不阻断链。
    // 09-13 子2 W2b：withNodeStreaming 开流（L2 挣得裁判 reasoning 思考流）。role=completeness-verify-agent
    //（yaml prompt 名，与节点 id completeness-verify-node 有意区分——mirror world-extractor 命名）。
    { id: 'completeness-verify-node', node: createCompletenessVerifyNode(withNodeStreaming('completeness-verify-node', 'completeness-verify-agent', llmDepsFor('multi-review'))) },
    // C7 路由通过环 through 节点（每圈判）：auto_revise=回环【W3 落去味门禁】/ accept_as_truth=终稿
    // checkpoint（W2：stage='final'——route accept 后、E 段提取前唯一人审点；onAccept 移 E 段完成后）
    // / escalate_user=escalate-pause；cap 超限强制 escalate。slot=route-judge（R1b 细档）。
    // 09-13 子2 W2a：withNodeStreaming 开流（每圈路由判决 reasoning 思考流）。
    { id: 'route-agent', node: createRouteNode(withNodeStreaming('route-agent', 'route-agent', llmDepsFor('route-judge'))), checkpointStage: 'final' },
    // ── E 提取段（对最终稿一次，零 checkpoint；route accept 后自然前进；redo 重跑幂等覆盖）──
    // W4 抽出 buildExtractionSegment 单源工厂（链装配 + 链外重提取 reExtractChapter 双消费）——
    // 节点构造/注释随工厂走，本处只装配：extraction 档 llmDeps + writeWorldEvents + session 路径 +
    // 节点流回调（mirror 抽出前逐节点 withNodeStreaming 形态）。
    ...buildExtractionSegment({
      llmDeps: llmDepsFor('extraction'),
      writeWorldEvents,
      projectPath: session.projectPath,
      ...(onNodeDelta ? { onNodeDelta } : {}),
    }),
  ];
  return defs.map((def) => withNodeArtifact(def, onNodeArtifact));
}
