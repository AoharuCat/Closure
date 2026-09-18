import type {
  GenerateFallbackEntry,
  ModelRef,
  SlotAssignment,
  SlotFallbackEntry,
  TaskModelSlot,
  ThinkingControl,
  ThinkingKind,
} from '@orison/shared-contracts';
import { resolveModelInfo } from '@orison/shared-contracts';

/**
 * Maps a task-routing slot to its configured assignment (model ref + optional
 * thinking policy, S1 slotAssignmentSchema). Returns undefined for an
 * unconfigured slot — the caller passes the `.modelRef` on as the provider
 * default sentinel and shell resolveModel auto-picks (the pre-routing
 * behavior); the thinking policy rides the assignment as a whole (design §1.2:
 * never a selfcheck model + draft thinking-policy hybrid).
 *
 * 注：S1 落地的 slotAssignmentSchema 是 `modelRefSchema.extend({...})` 的**平铺**形态
 *（keyId/modelId 在顶层，无 .modelRef 嵌套）——取窄引用走 assignmentModelRef 单源，
 * 不各处手写 { keyId, modelId } 投影。
 */
export type TaskSlotResolver = (slot: TaskModelSlot) => SlotAssignment | undefined;

// Injection seam (mirror of provider setGenerateTextFn): the agent runtime
// never reads disk config itself (ADR-2 all-injection boundary) — the shell
// injects a resolver backed by a fresh read of the task-models sidecar per
// call, so slot changes take effect on the next turn / next chain assembly
// without a restart.
let _resolver: TaskSlotResolver | undefined;

export function setTaskSlotResolver(fn: TaskSlotResolver | undefined): void {
  _resolver = fn;
}

/**
 * Narrow the flat SlotAssignment to the ModelRef pair for generate
 * opts.modelRef / llmDeps.modelRef（不把 thinking/thinkingCustom 键渗进 IPC
 * ref 载荷——shell 只读 keyId/modelId，但保持 wire 体字节干净）。
 */
export function assignmentModelRef(assignment: SlotAssignment | undefined): ModelRef | undefined {
  if (!assignment) return undefined;
  return { keyId: assignment.keyId, modelId: assignment.modelId };
}

/**
 * S4c（task 08-25 design §4.1）：assignment → 上下文窗口 token 数（registry limits 单源，
 * basename 二轮同带）。未配置 / 未知模型（无 limits）→ undefined——调用方诚实回落缺省
 *（runLoop / makeAgentLoop 的 S4a 接收面均 1M），不猜窗口。
 *
 * 09-12 子3 §4.4：shell resolver 闭包的 enrichment 值（`contextWindowTokens`，源自 key 级
 * `models[].defaults.contextWindow`）优先——用户手填窗口对未知模型/CLI 形态生效；无
 * enriched 值回 registry 单源；双无 → undefined（AC3 的 agent 面单源）。
 *
 * CR-4（09-12 子3 CR 批）belt：enriched 值非正整数（0/负/小数——三处链路毒化的末端
 * 形态）不注入，回落 registry——`(x ?? 0) > 0` 语义（shell 读侧 + enrichSlotAssignment
 * 注入侧是前两道闸，本函数是链路末端的最后一道）。
 */
export function assignmentContextWindowTokens(assignment: SlotAssignment | undefined): number | undefined {
  if (!assignment) return undefined;
  const override = assignment.contextWindowTokens;
  if (override !== undefined && Number.isInteger(override) && override > 0) return override;
  return resolveModelInfo(assignment.modelId).limits?.contextWindow;
}

/**
 * CR-008（08-25 BMad CR）：assignment → 模型思考 kind（registry 单源，basename 二轮同带）。
 * leader 车道 send 装配时注入 LoopOptions.thinkingKind——required 档
 * （reasoningRoundTrip==='required'，kimi-k3 / deepseek-v4 族）驱动压缩升级路径的保底区段。
 * 未配置 / 未知模型 → undefined（无 required 义务，现行为）。
 */
export function assignmentThinkingKind(assignment: SlotAssignment | undefined): ThinkingKind | undefined {
  if (!assignment) return undefined;
  return resolveModelInfo(assignment.modelId).thinking;
}

/**
 * Inter-slot fallback chain (09-13 chain-flow restructure R1b): the
 * review-lineage FINE slots fall back to the coarse `review-judge` assignment
 * when the fine slot itself is unconfigured. W0-8: pre-R1b resolution was pure
 * per-slot passthrough (zero inter-slot fallback); the only precedent was the
 * assembly-side `writer-selfcheck ?? writer-draft` cascade (chapter-chain.ts),
 * mirrored here as `fine ?? review-judge ?? undefined` centralized in this
 * single point so every consumer (chain assembly closure, yaml-dispatch single
 * point, lint probe) shares one chain. Semantics: the fallback takes the
 * review-judge assignment as a WHOLE — model ref + thinking policy + fallback
 * chain, never a fine-model + coarse-policy hybrid (design §1.2 discipline).
 * Both unconfigured → undefined → provider default sentinel → shell auto-pick
 * (byte-identical to the pre-routing path; there is no explicit global slot
 * to point at). Depth is exactly one: `review-judge` itself has no entry, so
 * the chain cannot cycle.
 */
const TASK_SLOT_FALLBACK: Readonly<Partial<Record<TaskModelSlot, TaskModelSlot>>> = {
  'plan-review': 'review-judge',
  'multi-review': 'review-judge',
  'route-judge': 'review-judge',
  'revision-guard': 'review-judge',
};

/**
 * Resolve the assignment for a task slot. No resolver injected, or the slot is
 * unconfigured → undefined → the caller passes `.modelRef` on as the provider
 * default sentinel and shell resolveModel auto-picks. That is byte-identical to
 * the pre-routing "empty model selector" path — which also means "wiring
 * missing" and "user didn't configure" are indistinguishable here, so the
 * wiring tests must assert the modelRef that generate actually receives
 * (design §7 red line).
 *
 * 09-13 R1b: review-lineage fine slots carry the inter-slot fallback above —
 * an unconfigured fine slot resolves through the coarse `review-judge`
 * assignment (as a whole) before yielding undefined.
 */
export function resolveTaskModel(slot: TaskModelSlot): SlotAssignment | undefined {
  const own = _resolver?.(slot);
  if (own !== undefined) return own;
  const fallbackSlot = TASK_SLOT_FALLBACK[slot];
  return fallbackSlot !== undefined ? _resolver?.(fallbackSlot) : undefined;
}

/**
 * Slot resolution for the yaml-contract dispatch single point
 * (workflow.ts runChildAgentWithExplicitSystem). Unknown names route nothing —
 * see the YAML_AGENT_SLOT contract below.
 */
export function resolveTaskModelForAgent(agentName: string): SlotAssignment | undefined {
  // Object.hasOwn guards the prototype-key lookup hole: a name like 'toString'
  // or '__proto__' must hit "not registered", never an inherited property.
  if (!Object.hasOwn(YAML_AGENT_SLOT, agentName)) return undefined;
  return resolveTaskModel(YAML_AGENT_SLOT[agentName]);
}

/**
 * S4b（task 08-25 design §1.2）：assignment → 请求位 ThinkingControl 归一。
 * - `thinkingCustom` 有值 → `{level:'custom', custom}`（design §1.2「有值即 custom」，custom 优先）
 * - `thinking` 有值且非 'auto' → `{level}`（'auto' = 显式自动 = 不注入，与缺省同义）
 * - 都无 / undefined assignment → undefined（不传 = auto，字节级零变化）
 */
export function assignmentThinkingControl(
  assignment: SlotAssignment | undefined,
): ThinkingControl | undefined {
  if (!assignment) return undefined;
  if (assignment.thinkingCustom) return { level: 'custom', custom: assignment.thinkingCustom };
  if (assignment.thinking && assignment.thinking !== 'auto') return { level: assignment.thinking };
  return undefined;
}

/**
 * 09-12 子2 fallback chains（design §2/§4）：assignment → wire 形态回退链（第三投影 helper，
 * 与 assignmentModelRef / assignmentThinkingControl 同族单源）。条目 → `{ref, thinking}`，
 * thinking 经 assignmentThinkingControl **逐条归一**（条目模型与主指派不同 kind 不同档，
 * 各自判定）；无链（assignment 缺席或 fallbacks 空缺）→ undefined（写侧 `...(len>0)` 二态
 * 纪律——空数组不占位，网关按缺席走零默认链快径）。
 *
 * 归一单源留在 agent 侧（design §12 权衡）：网关是纯执行器，防第二派生点漂移。
 */
export function assignmentFallbackChain(
  assignment: SlotAssignment | undefined,
): GenerateFallbackEntry[] | undefined {
  if (!assignment?.fallbacks?.length) return undefined;
  return assignment.fallbacks.map((entry: SlotFallbackEntry) => ({
    ref: { keyId: entry.keyId, modelId: entry.modelId },
    thinking: assignmentThinkingControl(entry),
  }));
}

/**
 * Slot lookup for the yaml-contract sub-agent dispatch single point
 * (workflow.ts runAgentWithExplicitSystem): the planner / director /
 * researcher / optimizer / diagnosis dispatch family → 'dispatch'; semantic
 * judges → the review lineage (coarse 'review-judge', or a fine slot per
 * 09-13 R1b — heterogeneous review: uncorrelated-model cross-examination
 * finds more gaps).
 *
 * Unknown agent names are deliberately NOT mapped — `YAML_AGENT_SLOT[name]`
 * yields undefined for them and resolveTaskModelForAgent returns undefined
 * (auto-pick), so a newly added yaml agent cannot silently inherit a wrong
 * slot; it must be registered here once its task semantics are decided.
 */
export const YAML_AGENT_SLOT: Readonly<Record<string, TaskModelSlot>> = {
  'story-planner-agent': 'dispatch',
  'episode-planner-agent': 'dispatch',
  'director-agent': 'dispatch',
  'researcher-agent': 'dispatch',
  'revision-optimizer-agent': 'dispatch',
  'ripple-diagnosis-agent': 'dispatch',
  // ── 审核族（09-13 链流程重排 R1b 细粒度化；细档未配回落 review-judge）──
  // 裁决器挂 route-judge（design §1：灰区裁决是链尾 route 判决语义的延伸）。
  'adjudicator-agent': 'route-judge',
  'arc-audit-agent': 'review-judge',
  // 读正文裁判世界状态修补一致性（nodes/world-amender.ts）——语义裁判族；
  // 当前无 leader tool 挂载（无活调用面），入表防未来接线时静默落自动选择。
  'world-amender-agent': 'review-judge',
  // 风格卡分析者（08-28 style-card-mvp A 路）——语义质量档：九遍扫描深分析，质量敏感。
  'style-analyzer-agent': 'review-judge',
  // 09-13 R1b：链节点名先行入表钉 slot 语义单源（装配行 re-slot 归 W1a/W1c 落）——
  // multi-review-agent（14 维审读）/ route-agent（路由判决）/ revision-guard-agent
  //（保义护栏）/ brief-reviewer-agent（规划审核，节点 W1c 建）。这些角色当前不经
  // runAgentWithExplicitSystem 派发面，行为零变化；入表防装配行 re-slot 时档位漂移。
  'multi-review-agent': 'multi-review',
  'route-agent': 'route-judge',
  'revision-guard-agent': 'revision-guard',
  'brief-reviewer-agent': 'plan-review',
};
