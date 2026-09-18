import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import {
  assembleChapterChainArtifacts,
  assertBriefReady,
  arcAuditResultSchema,
  arcBeatSchema,
  autoCreatedChapterFileContent,
  buildAcceptStoryDecisions,
  chapterBriefSchema,
  computeReadiness,
  BriefNotReadyError,
  buildChapterAccept,
  describeAcceptSkip,
  detectArcStagnation,
  detectVolumeClosure,
  deriveArcSpan,
  parseAdjudication,
  parseDirectorInfoRelease,
  parseDirectorEmotion,
  parseDirectorAtomicEdits,
  parseDirectorStoryDecisions,
  expandAtomicEditOp,
  validateAtomicEditOps,
  planAutoCreateChapter,
  collectCreatedSceneIds,
  collectRelevantDecisions,
  isSceneInEpisode,
  resolveChapterIdForEpisode,
  storyDecisionSchema,
  transformForeshadowToPromise,
  findSettingCoverageGaps,
  countCharacterCards,
  findUnanchoredCharacterProgressions,
  type AdjudicationSuggestion,
  type ArcAuditFinding,
  type ArcAuditResult,
  type ArcBeat,
  type AtomicEditProposal,
  type ChapterAcceptArtifact,
  type ChapterAcceptResult,
  type ChapterAcceptSkipReason,
  type ChapterBrief,
  type ChapterChainProjectInput,
  type DirectorInfoReleaseEntry,
  type DirectorEmotionOutput,
  type EmotionCurve,
  type EmotionPoint,
  type EpisodeOutline,
  type ForeshadowMigrationInput,
  type InfoReleaseMap,
  type ProjectThemeInput,
  type ResolvableChapter,
  type ResearchSuspension,
  type RevisionIntent,
  type SceneGraph,
  type SceneNode,
} from '@orison/shared-contracts';
import { defineTool } from './define';
import { logger } from '../logger';
import { CHAIN_RUN_SENTINEL_NODE_ID, type ToolContext } from '../types';
import { getSession } from '../agent/session';
import { CHAIN_RUN_ACTIVE_ERROR_PREFIX, deriveCheckpointPolicy, type RunSnapshotSummary } from '../contracts/run';
import { fetchWorldStateSnapshotViaTool, fetchCognitionSnapshotViaTool, fetchPresenceSignalViaTool } from '../nodes/world-state-query';
import { writeLintChapterLedger } from '../lint/lintLedger';
import { extractJson } from '../nodes/extract-json';
// dogfood R2 #105 缝①（R2.1）：stableStringify 单源复用（writer-node 章档案 briefHash 同款——key 序
// 无关的稳定序列化，快照 brief 与本次 brief 比对不受 zod parse 后 key 插入序漂移影响）。
import { stableStringify } from '../nodes/writer-node';
import { buildStyleContext, readStyleCardBody } from './style-card';
import { registry } from './registry';
import { findActiveBatchRun, upsertBatchRun } from './batch-state';

// ── Story 4.0 写章战术链段：leader `write_chapter` tool（design §4.8 / implement.md 6.1）──
//
// leader runLoop 调此 tool 触发写章链段（subgraph）。tool 职责 = 组 initialArtifacts + 调
// runtime.runChapterChain（mirror spawn_agent：经 ctx.skillExecutor 拿 runtime 引用）。
//
// runtime 访问模式（implement.md 6.1 verify-point）：spawn_agent.ts 用 ctx.skillExecutor.runSubagent —— 本 tool
// 同模式用 ctx.skillExecutor.runChapterChain。skillExecutor 在 workflow.ts runLoop 调用处被注入为 runtime
// （WorkflowRuntime，Step 5.2 已实现 runChapterChain）。types.ts SkillExecutorRef 加 runChapterChain 方法签名。
//
// project.yaml 读取（implement.md 6.1 verify-point）：agent 不能 import local-bff loadProject（layering：
// shared-contracts ← agent ← shell，local-bff 是 shell 层），故直读 project.yaml + js-yaml 解析（mirror
// workflow.ts:1150 buildRuntimeSystemPrompt 读 project.yaml + agentPrompt.ts BOM-strip 防御）。dogfood IPC
// （shell）用 loadProject 带迁移；本 tool 直读当前状态（project.yaml 已由 local-bff 写入时迁移过）。
// 真正的组装逻辑（settings_context 编译 / artifact key 约定）抽到 shared assembleChapterChainArtifacts
// （DRY：两入口共用）。
//
// classifyTool 归类（implement.md 6.1 verify-point）：tool id `write_chapter` —— PermissionService DEFAULT_RULES
// `/^write_/` → action='ask'（触发生成前用户确认，合理）。toolPolicy classifyTool 未列 WRITE_TOOLS → 默认 'read'
// （mirror spawn_agent：可见于 readonly/suggest/auto，执行时 permission ask 把关）。不改 toolPolicy / permission。
//
// ⚠️ leader 交互式触发 UX（工作台「写章 N」对话）= Story 4.1 Step 5（design §3.4）：
// DEFAULT_ORISON_PROMPT 加 write_chapter 引导 + ChapterListPanel「生成」按钮 → sendAgentMessage
// → leader runLoop 凭引导调本工具。E3 工作台完整横切工作面仍 defer。dogfood 走 closure:run-chapter-chain IPC。
//
// expected_downstream_consumers:
// - Story 4.0 Step 6.1：builtin.ts 注册本工具 → leader runLoop 可调。
// - Story 4.1 Step 5（已接）：工作台「生成」按钮 + leader prompt 引导 → 本工具被 exercised。
//   accept_as_truth → field_patch chapter_candidate metadata → UI PatchReviewPanel accept →
//   applyAgentFieldPatch IPC → acceptChapterCandidateCore 写 chapters/*.md + project.yaml。
// - Epic 3：工作台完整横切工作面（校验议题进 chat / chat-fatigue）。

const BOM_CHAR_CODE = 0xfeff;

const writeChapterParams = z.object({
  episodeId: z.string().describe('本章目标 episode id（承载树原子，refs episode_outlines[].id）'),
  chapterBrief: chapterBriefSchema.optional().describe(
    '本章 brief 的 LLM 段（目标/参数/信息控制/节奏/禁写/情绪目标）；' +
    '关键剧情点/伏笔任务/未决决策等纯代码段由系统自动汇编，无需你填',
  ),
  sceneIds: z.array(z.string()).optional().describe(
    '可选：本章涉及的场 id 过滤（4.0 未用——brief-compiler 按 episodeId 匹配场；预留 4.1 细化）',
  ),
  // 4.1 Step 4：用户工作台选章直传 chapterId（优先，绕过 episode.index→sort_order 映射推断）。
  chapterId: z.string().optional().describe(
    '可选：目标 chapter id（用户工作台选章直传，优先于 episode.index→sort_order 映射推断）',
  ),
});

// ── dogfood R2 #105 缝①（R2.1）：write_chapter 自家租约重入分派 helper ──
//
// chain_run_active busy 错误串形态 = `chain_run_active|heldBy=<holderSessionId>`（workflow.ts 守卫
// 产出，contracts/run.ts CHAIN_RUN_ACTIVE_ERROR_PREFIX 单源）。解析失败（形态漂移）→ undefined →
// caller 按「他 session 持有」保守处理（维持 busy 文案，与修前行为一致）。
function parseChainRunActiveHolder(errors: string[] | undefined): string | undefined {
  const busy = (errors ?? []).find((e) => e.startsWith(CHAIN_RUN_ACTIVE_ERROR_PREFIX));
  if (!busy) return undefined;
  const match = /^chain_run_active\|heldBy=(.+)$/.exec(busy);
  return match ? match[1] : undefined;
}

/**
 * 从 chainSnapshot 抽 chapter_brief_input.brief（快照 brief 比对源，R2.1 分派规则用）。
 * mirror brief-compiler-node resolveBriefInput 的两形态兼容：
 * - 结构化 `{episodeId, brief}`（canonical，assembleChapterChainArtifacts 产）→ 抽 .brief；
 * - raw ChapterBrief（缺包装）→ 整体作 brief。
 * 快照缺 / artifacts 缺 / 形态不对 → undefined（caller 语义 = 拿不到快照 brief → 保守走 resume）。
 */
function briefFromChapterBriefInput(
  snapshot: { artifacts?: Record<string, unknown> } | undefined,
): ChapterBrief | undefined {
  const input = snapshot?.artifacts?.['chapter_brief_input'];
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  if ('brief' in obj && obj.brief && typeof obj.brief === 'object') return obj.brief as ChapterBrief;
  return obj as ChapterBrief;
}

// ── 链流程重排（09-13 W1a + W2 激活，W0-5 结论）：旧 stage 停点快照废弃拦截 ──
//
// 旧链的 draft 停（currentNodeId='draft-writer-agent'，checkpointStage='draft'）与 verdict 停
// （currentNodeId='route-agent'，checkpointStage='verdict'）在重排后的链序/档位映射下退役。拦截在
// resume 分派前（clearChainSnapshot + 废弃提示重跑）；W2 档位重映射（draft/verdict 退出全部
// deriveCheckpointPolicy 输出）后激活。**W2 与新停点的区分**（防误拦活形态）：
// - draft-writer-agent 停：挂起动态 pause（research_brief.suspended 在）是**活**形态（W2 后仍全档位
//   挂起暂停）——仅「无挂起载荷的纯 stage 停」是 legacy draft 停。
// - route-agent 停：新终稿 checkpoint（W2，stage='final'）停在此且**不带 chapter_accept**（onAccept 已
//   移 E 段完成后）；escalate-pause（escalatePause=true）也是活形态（其 chapter_accept 是裁决材料）。
//   仅「非 escalate-pause 且 artifacts 带 chapter_accept」= legacy verdict 停（旧 onAccept-先于-pause 产物）。
const LEGACY_PAUSE_STAGES_BY_NODE: Partial<Record<string, 'draft' | 'verdict'>> = {
  'draft-writer-agent': 'draft',
  'route-agent': 'verdict',
};

/** 全部档位的活 scheduled 停点集合（deriveCheckpointPolicy 单源派生；动态 revision-guard 不属 stage 停点）。 */
function liveCheckpointStages(): Set<string> {
  return new Set<string>([
    ...deriveCheckpointPolicy('auto').pauseStages,
    ...deriveCheckpointPolicy('suggest').pauseStages,
    ...deriveCheckpointPolicy('readonly').pauseStages,
  ]);
}

/**
 * 判 paused 快照是否落在已废弃的旧 stage 停点（true = 应 clearChainSnapshot + 废弃提示重跑，
 * 必须在 resume 分派前调用）。W2 细化判据（见上方块注释）：挂起 pause 与终稿/escalate-pause 是活形态
 * 不拦——只拦「纯 legacy stage 停」。 currentNodeId 非 legacy 停点 node → false（正常分派）。
 */
function isDiscardedLegacyPause(
  snapshot: { status?: string; currentNodeId?: string | null; escalatePause?: true; artifacts?: Record<string, unknown> } | undefined,
): boolean {
  if (!snapshot || snapshot.status !== 'paused') return false;
  // escalate-pause（灰区裁决暂停）是活形态（W1a 起常驻），永不拦。
  if (snapshot.escalatePause === true) return false;
  const nodeId = typeof snapshot.currentNodeId === 'string' ? snapshot.currentNodeId : null;
  if (!nodeId) return false;
  const stage = LEGACY_PAUSE_STAGES_BY_NODE[nodeId];
  if (stage === undefined) return false;
  if (nodeId === 'draft-writer-agent') {
    // 挂起动态 pause（suspended 在）是活形态——仅纯 stage 停（无挂起载荷）是 legacy；且 'draft' 已退出
    // 活停点集（W2 重映射激活点）。
    const suspended = (snapshot.artifacts?.['research_brief'] as { suspended?: unknown } | undefined)?.suspended;
    return suspended === undefined && !liveCheckpointStages().has('draft');
  }
  // route-agent：legacy verdict 停 = 旧 onAccept-先于-pause 产物（chapter_accept 在）；新终稿 pause 无候选
  // （onAccept 移 E 段后）。
  return (
    Object.prototype.hasOwnProperty.call(snapshot.artifacts ?? {}, 'chapter_accept') &&
    !liveCheckpointStages().has('verdict')
  );
}

// ── 链流程重排 CR-8（09-13 CR 修复批）：环 cap 耗尽判定精确化 ──
//
// chainRunner 环 cap error 形态 = `loop cap (<cap>) reached at "<through 节点 id>"; forced escalate`
// （chainRunner.ts pushError）——自审环 through = route-agent、规划环 through = brief-reviewer-node。
// 旧子串匹配 `e.includes('loop cap')` 会把**规划环** cap 误当**自审环** capExhausted 处置
// （auto-resume / 终弃文案错环）——规划环 cap 走 planEscalate 路径（CR-2b），勿入 capExhausted 分支。
// 🔁 平行实现纪律：closureChainIpc leader-notify 的 loopUnconverged 投影同判据（agent index 未导出
// 本 helper——簇文件边界，两处同步；mirror run.ts/ipc.ts 平行 type B01 纪律）。
const AUDIT_LOOP_THROUGH_NODE_ID = 'route-agent';
const PLAN_LOOP_THROUGH_NODE_ID = 'brief-reviewer-node';

/** 自审环（route-agent through）cap 耗尽判定——精确匹配 loop 节点 id，规划环 cap 不误报。 */
function isAuditLoopCapError(error: string): boolean {
  return error.includes('loop cap') && error.includes(`"${AUDIT_LOOP_THROUGH_NODE_ID}"`);
}

/** 规划环（brief-reviewer through）cap 耗尽判定（planEscalate 硬停信号，CR-2b）。 */
function isPlanLoopCapError(error: string): boolean {
  return error.includes('loop cap') && error.includes(`"${PLAN_LOOP_THROUGH_NODE_ID}"`);
}

// ── 链流程重排 CR-2b（R4b 补全）：规划环 escalate-pause 载荷读取 ──
//
// 簇 1 在 summarizeRunSnapshot 新增 summary.planEscalate（规划环 escalate-pause 载荷，additive）：
// `{verdict:'escalate', summary, findings, loopLabel:'plan'}`——findings = plan_review 保留版
// （brief-reviewer-node PlanReviewFinding：dimension/severity('hard'|'soft')/grounding/note）。
// 规划环灰区无 routeDecision（route-agent 未跑），老 gate（routeDecision==='escalate_user'）对齐
// 旧形态零消费 → 真全自动档在规划环 pause 停摆。此处防御式读取（簇 1 类型未落地前编译零依赖），
// per-element 守性投影（坏条目单独丢，mirror summarizeRunSnapshot 投影哲学）。
interface PlanEscalateRawPayload {
  verdict?: unknown;
  summary?: unknown;
  findings?: unknown;
  loopLabel?: unknown;
}

/** planEscalate.findings 守性投影形态（PlanReviewFinding 对齐）。 */
interface PlanEscalateFinding {
  dimension: string;
  severity: string;
  grounding: string;
  note: string;
}

function readPlanEscalate(summary: RunSnapshotSummary): { summary: string; findings: PlanEscalateFinding[] } | null {
  const raw = (summary as { planEscalate?: PlanEscalateRawPayload }).planEscalate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.verdict !== 'escalate') return null;
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).flatMap((f): PlanEscalateFinding[] => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return [];
    const o = f as Record<string, unknown>;
    if (typeof o.dimension !== 'string' || typeof o.note !== 'string') return [];
    return [{
      dimension: o.dimension,
      severity: typeof o.severity === 'string' ? o.severity : 'soft',
      grounding: typeof o.grounding === 'string' ? o.grounding : '',
      note: o.note,
    }];
  });
  return { summary: typeof raw.summary === 'string' ? raw.summary : '', findings };
}

/**
 * 读 project.yaml 并解析为链段组装所需字段（agent 直读，无 local-bff 迁移）。
 *
 * 4.1 Step 4：额外抽 `novel.chapters`（chapterId 映射目标，onAccept 闭包用 resolveChapterIdForEpisode）。
 * 返回 ChapterChainProjectInput & { novelChapters? }——assemble 用前者，onAccept 用 novelChapters + episode_outlines。
 * Story 8.2：额外抽 `outline.phases`（卷弧候选——arc-emergence-node 写时声明 volume 弧对号 phase id；
 * 本地 intersection 扩展 outlinePhases，非 ChapterChainProjectInput 字段，post-assemble 直注 artifact
 * mirror growth_curve caller-fetch 模式）。
 *
 * 防御（mirror agentPrompt.ts「degrade, don't drop」）：BOM-strip + malformed yaml → warn + 返回 null
 * （tool 报错给 leader 而非崩）。
 */
async function loadChainProjectInput(
  projectPath: string,
): Promise<(ChapterChainProjectInput & { novelChapters?: ResolvableChapter[]; outlinePhases?: unknown[] }) | null> {
  const filePath = path.join(projectPath, 'project.yaml');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, 'write_chapter: project.yaml unreadable');
    return null;
  }

  const bomStripped = raw.charCodeAt(0) === BOM_CHAR_CODE ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = yaml.load(bomStripped);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), projectPath }, 'write_chapter: project.yaml malformed yaml');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  // 只抽链段组装所需字段；透传给 assembleChapterChainArtifacts（其内部 safeParse scene_graph / promise_registry）。
  const input: ChapterChainProjectInput & { novelChapters?: ResolvableChapter[]; outlinePhases?: unknown[] } = {};
  if (obj.creative_brief && typeof obj.creative_brief === 'object') input.creative_brief = obj.creative_brief as ChapterChainProjectInput['creative_brief'];
  if (obj.world_setting && typeof obj.world_setting === 'object') input.world_setting = obj.world_setting as ChapterChainProjectInput['world_setting'];
  if (Array.isArray(obj.asset_cards)) input.asset_cards = obj.asset_cards as ChapterChainProjectInput['asset_cards'];
  if (obj.scene_graph && typeof obj.scene_graph === 'object') input.scene_graph = obj.scene_graph as ChapterChainProjectInput['scene_graph'];
  // Story 6.5：foreshadow_registry → promise_registry（Phase A renamed ChapterChainProjectInput field）。
  // B3 fix（CR-B3）：agent 直读 project.yaml 不经 local-bff loadProject 迁移——legacy disk 含 foreshadow_registry
  // （无 promise_registry）时 input.promise_registry 会 undefined（chain 无 Promise 数据，brief#7/Reader-Audit
  // graceful 降级）。加 foreshadow→promise fallback 迁移（mirror localProjectRepository 迁移块 :239-248）：
  // 优先 promise_registry（新项目 / 已迁移）；次选 foreshadow_registry（legacy）→ transformForeshadowToPromise
  // （per-element 容错，Phase A 已落地）。shell/dogfood IPC 路径经 loadProject（已迁移），agent 路径补齐 → 两路径一致。
  // transform 输出恒为合法 PromiseRegistry（promiseRegistrySchema.parse 校验，Phase A 保证），免本 tool 再守门。
  if (obj.promise_registry && typeof obj.promise_registry === 'object') {
    input.promise_registry = obj.promise_registry as ChapterChainProjectInput['promise_registry'];
  } else if (obj.foreshadow_registry && typeof obj.foreshadow_registry === 'object') {
    input.promise_registry = transformForeshadowToPromise(
      obj.foreshadow_registry as ForeshadowMigrationInput,
    );
  }
  // Story 6.3：read info_release_map（6.1 creative field，project.yaml 顶层）。assemble 统一从此读
  // （safeParse infoReleaseMapSchema 降级空 map，故形状不信任时仍 graceful）。R2 Director（dispatchDirectorAndAuthorInfoRelease）
  // 读 initialArtifacts['info_release_map'].entries 作 existingInfoRelease var（idempotent）+ mergeDirectorEntries
  // 合入既有 entry——agent 直读 project.yaml 须补此读取，否则 Director 在 agent 路径看不到既有 plan（shell IPC 路径
  // 经 loadProject 返 full doc 含此字段，两路径一致）。mirror promise_registry 直读模式（无 fallback——无 legacy sibling）。
  if (obj.info_release_map && typeof obj.info_release_map === 'object') {
    input.info_release_map = obj.info_release_map as ChapterChainProjectInput['info_release_map'];
  }
  // Story 5.2：read emotion_curve（5.1 creative field，project.yaml 顶层）。assemble 统一从此读
  // （safeParse emotionCurveSchema 降级空 curve，故形状不信任时仍 graceful）。Director 读 existingEmotionCurve var
  // （idempotent）+ mergeDirectorEmotionPoints 合入既有 point——agent 直读 project.yaml 须补此读取，否则 Director 在
  // agent 路径看不到既有情绪目标弧（shell IPC 路径经 loadProject 返 full doc 含此字段，两路径一致）。mirror info_release_map 直读模式。
  if (obj.emotion_curve && typeof obj.emotion_curve === 'object') {
    input.emotion_curve = obj.emotion_curve as ChapterChainProjectInput['emotion_curve'];
  }
  // Story 4.4：read growth_curve（1.1 creative field，project.yaml 顶层）+ meta.theme（项目级主题字符串）。
  // completeness-verify-node L1 候选汇编消费（角色弧 under-developed + 主题挣得 数据源，design §4）。assemble 不注入
  // 此字段进 artifact——write_chapter post-assemble 直接注入 initialArtifacts（mirror asset_cards optional 注入模式
  // :691-693，caller fetch 哲学）。growth_curve raw 形态多样（单条/array/Record<id,curve>），readGrowthCurves 守卫统一
  // 归一为 GrowthCurve[]（arc-coverage.ts 单源，L1 内处理）。meta.theme 作 declaredThemes 主源（creative_brief.theme 作 sibling，write_chapter
  // buildProjectTheme 合并）。shell IPC 路径（closureChainIpc）未注此字段（R2 范围 agent-only，mirror asset_cards 哲学）
  // → IPC 路径 completeness-verify L1 降级空候选（arc/theme 类跳过），零回归（graceful，design §8）。
  if (obj.growth_curve !== undefined) {
    input.growth_curve = obj.growth_curve;
  }
  if (obj.meta && typeof obj.meta === 'object') {
    const meta = obj.meta as { theme?: unknown };
    if (typeof meta.theme === 'string' && meta.theme.length > 0) {
      input.project_theme = meta.theme;
    }
  }
  if (Array.isArray(obj.episode_outlines)) input.episode_outlines = obj.episode_outlines as ChapterChainProjectInput['episode_outlines'];
  // Story 8.2：read outline.phases（卷弧候选——arc-emergence-node 写时声明 volume 弧要对号 phase id；
  // 用户修正定案「卷 = 阶段 = outline phase 合并实体」）。outline 坏形态 / phases 非数组 → 不设
  // （arc-emergence 卷弧候选降级空，线弧/成长弧照常，graceful）。
  if (obj.outline && typeof obj.outline === 'object') {
    const outline = obj.outline as { phases?: unknown };
    if (Array.isArray(outline.phases)) {
      input.outlinePhases = outline.phases;
    }
  }
  // story_decisions 嵌于 novel 下（mirror project.yaml novel 顶层；design §3.5 落库点）。read novel.story_decisions[]
  // → flat input.story_decisions（assemble 统一从此读，4.1 Step 3）。novel 缺 / story_decisions 非数组 → 不设（assemble safeParse 降级 []）。
  // 4.1 Step 4：同 read novel.chapters[]（chapterId 映射目标，onAccept 用）。
  if (obj.novel && typeof obj.novel === 'object') {
    const novel = obj.novel as Record<string, unknown>;
    if (Array.isArray(novel.story_decisions)) {
      input.story_decisions = novel.story_decisions as ChapterChainProjectInput['story_decisions'];
    }
    if (Array.isArray(novel.chapters)) {
      input.novelChapters = novel.chapters as ResolvableChapter[];
    }
  }
  return input;
}

/**
 * Story 4.6：派发裁决器子 agent（多角度初审）+ parse 建议（design §2 / D5）。
 *
 * 流程：dispatch adjudicator（无工具纯判断）→ parseAdjudication 解析 → 返建议。任何失败 → null
 * （graceful 降级 D5——裁决器是增强非硬约束，失败时 output 仍带 findings grounding + route，链段不崩）。
 *
 * 工具限制（D2）：allowedTools=[]——裁决器无工具纯判断，判「哪个更好」基于 findings+draft+brief 已够
 * （查 canon/设定矛盾是 Reader-Audit 的活，已抓）；无写工具（无副作用风险）。
 *
 * spawn depth：leader→裁决器（depth+1）兄弟于 leader→chain（depth+1），非嵌套（同 4.5 retrieval）。
 *
 * Story 8.2 链感知扩展（design §5 gray 档）：optional `arcContext` 参数——弧审灰区 findings 派裁决器时
 * 附弧上下文段（arcSynopsis + gray findings，4.6 时 epics 点名「裁决器无弧语境」的补全）。最小侵入：
 * 既有调用（route=escalate_user）不传 → arcContext 空串（adjudicator-agent.yaml 空段照常裁决，零回归）。
 */
async function dispatchAdjudicator(
  summary: RunSnapshotSummary,
  chapterBrief: ChapterBrief | undefined,
  ctx: ToolContext,
  initialArtifacts: Record<string, unknown>,
  arcContext?: string,
): Promise<AdjudicationSuggestion | null> {
  if (!ctx.skillExecutor?.runAgentWithExplicitSystem) return null;

  // Story 2.6 R4b：既有创作决策（open+decided 投影）喂裁决器——裁决「正文 vs 计划哪个更好 / 偏离后
  // 怎么写」时参考既有决策（4.6 D6 预留「随手可得则带」）：决策支持正文偏离 = 有据偏离；决策禁止此偏离
  // = 计划更可信。CR-A02：safeParse + 单源 collectRelevantDecisions（排 superseded/dropped 终态——
  // 裁决参考的是现行方向，终态是历史）+ newestFirst cap（防长篇数百条 prompt 无界，mirror Reader-Audit
  // DECIDED_CAP）。includeEpisodeScoped：裁决器无本章 episodeId 视角，episode-scoped 决策同样参考
  // （CR-E03 同教训：不传会把 episode-scoped 全滤掉）。投影 {id,summary,status,reason}（裁决参考非
  // idempotency，reason 比 Director vars 版多带）。decided 证据优先（cap 8）+ open 悬置提醒（cap 4）。
  const allDecisions = ((initialArtifacts['story_decisions'] as unknown[] | undefined) ?? []).flatMap((d) => {
    const r = storyDecisionSchema.safeParse(d);
    return r.success ? [r.data] : [];
  });
  const relevantDecisions = [
    ...collectRelevantDecisions(allDecisions, { status: 'decided', newestFirst: true, includeEpisodeScoped: true }).slice(0, 8),
    ...collectRelevantDecisions(allDecisions, { status: 'open', newestFirst: true, includeEpisodeScoped: true }).slice(0, 4),
  ];
  const existingDecisions = JSON.stringify(
    relevantDecisions.map((d) => ({ id: d.id, summary: d.summary, status: d.status, reason: d.reason })),
  );

  const vars: Record<string, string> = {
    chapterBrief: JSON.stringify(chapterBrief ?? {}),
    draftText: summary.draftText ?? '',
    escalateFindings: JSON.stringify(summary.escalateFindings ?? []),
    existingDecisions,
    // Story 8.2：弧审灰区 findings 的弧上下文段（synopsis + gray findings）；空 = 本章 escalate 常规
    // 裁决（无弧语境，4.6 既有行为零回归）。
    arcContext: arcContext ?? '',
  };

  try {
    const result = await ctx.skillExecutor.runAgentWithExplicitSystem(
      ctx.sessionId,
      'adjudicator-agent',
      vars,
      {
        abort: ctx.abort,
        ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
        ...(ctx.emitChildEvent ? { emitChildEvent: ctx.emitChildEvent } : {}), // R2 #3 二段：child 事件透传
        allowedTools: [],
      },
    );
    return parseAdjudication(result.content);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'write_chapter: adjudicator dispatch failed → graceful skip adjudication block',
    );
    return null;
  }
}

// ── Story 7.4 Step 2：cross-chapter feedback ledger 读（激活 Director 5.3/4.4/7.3 三段）──
//
// write_chapter chain-start（dispatchDirectorAndAuthorInfoRelease）读上一章链段 artifact（review.latest /
// emotion_verify_result / completeness_verify_result），填 Director feedback var。Step 1 建好读写通道
// （feedback-ledger-node 链尾写 + feedback_ledger_read toolHandler + feedbackLedgerRepository），Step 2 接通消费。
//
// 经 registry feedback_ledger_read builtin（remoteToolProxy → toolExecution IPC → shell feedbackLedgerHandlers），
// 非直连 db（agent 包无 db 访问，守 module-boundaries）。mirror fetchWorldPatchesViaTool（nodes/world-state-query.ts）
// 「leader 侧 / chain 调 db read tool」既有模式——graceful undefined / registry 空 / metadata 抽取。
//
// 范式判据（ADR-3）：ledger 读 = 纯代码确定性记账（episode→artifact 查找机械），不裁判语义。payload 格式化 = 机械
// 字段抽取（过滤 + 投影），「这个 finding 值不值得结构编辑 / 该怎么调整情绪」归 Director LLM。
//
// graceful（mirror fetchWorldPatchesViaTool + Director 既有占位哲学）：
// - 工具未注册（测试环境 registry 空 / 未 registerBuiltinTools）→ undefined（三 var 空串，Director 照常规划）。
// - 工具调用抛错（IPC 失败 / project 未注册 / handler 抛）→ undefined（不造假、不崩 chain）。
// - 无记录（第一章 / 新项目 / 上章无 artifact）→ 三字段均 undefined（三 var 空串，零回归）。
// - 第一章 / index gap 无上章 → 不调 ledger read（index 守卫早返 undefined，免无谓 IPC）。

/** 上一章三段 feedback payload（deserialize 后的链段 artifact；undefined 字段 = 上章无该 artifact 记录）。 */
interface PrevEpisodeFeedback {
  /** review.latest payload（Director 重规划段读作 auditFindings）。 */
  auditFindings?: Record<string, unknown>;
  /** emotion_verify_result payload（Director 情绪反馈段读作 emotionVerifyFeedback）。 */
  emotionVerifyFeedback?: Record<string, unknown>;
  /** completeness_verify_result payload（Director 完整性反馈段读作 completenessFeedback）。 */
  completenessFeedback?: Record<string, unknown>;
}

/**
 * 经 feedback_ledger_read builtin 读单 episode 全 key 的 feedback 记录（mirror fetchWorldPatchesViaTool）。
 *
 * @param projectPath    项目路径（handler 从此解析 projectId 5 位，mirror query_world_slice）。
 * @param prevEpisodeId  上一章 episode id（caller 从 episode_outlines index-1 推导）。
 * @returns              三字段 feedback payload；undefined = 工具未注册/调用失败（caller 降级空串）。
 */
async function fetchPrevEpisodeFeedback(
  projectPath: string,
  prevEpisodeId: string,
): Promise<PrevEpisodeFeedback | undefined> {
  const tool = registry.get('feedback_ledger_read');
  if (!tool) {
    // 测试环境 registry 空 / 未 registerBuiltinTools → graceful undefined（caller 降级空串，Director 照常规划）。
    return undefined;
  }
  try {
    const result = await tool.execute(
      { episodeId: prevEpisodeId },
      {
        // feedback_ledger_read handler 仅用 projectDir（resolveProjectId），sessionId 走 toolExecution 通道不读；
        // 此处同 fetchWorldPatchesViaTool 传空串 placeholder（handler 忽略）。
        sessionId: '',
        projectPath,
        abort: new AbortController().signal,
      },
    );
    const entries = (result.metadata as { entries?: unknown } | undefined)?.entries;
    if (!Array.isArray(entries)) return undefined;
    // 按 artifactKey 抽 payload（逐条守性校验，mirror fetchWorldPatchesViaTool patches 抽取）。
    // artifactKey → feedback var 名映射（FEEDBACK_LEDGER_ARTIFACT_KEYS 源）：
    //   'review.latest' → auditFindings / 'emotion_verify_result' → emotionVerifyFeedback /
    //   'completeness_verify_result' → completenessFeedback。
    const payloadByKey = new Map<string, Record<string, unknown>>();
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const entry = e as { artifactKey?: unknown; payload?: unknown; corruptPayload?: unknown };
      // BMad CR-011：corrupt payload（坏 JSON）→ warn + skip（不喂 Director 坏数据，当空处理）。
      // 旧 repository ?? {} 折叠空对象掩盖坏 JSON → Director 收空对象误认有 feedback。现 corrupt 标记让两态可区分。
      if (entry.corruptPayload === true) {
        logger.warn(
          { artifactKey: entry.artifactKey },
          'fetchPrevEpisodeFeedback: ledger payload corrupt (bad JSON) → skip (treat as empty)',
        );
        continue;
      }
      if (typeof entry.artifactKey !== 'string') continue;
      if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) continue;
      payloadByKey.set(entry.artifactKey, entry.payload as Record<string, unknown>);
    }
    const feedback: PrevEpisodeFeedback = {};
    const reviewPayload = payloadByKey.get('review.latest');
    if (reviewPayload) feedback.auditFindings = reviewPayload;
    const emotionPayload = payloadByKey.get('emotion_verify_result');
    if (emotionPayload) feedback.emotionVerifyFeedback = emotionPayload;
    const completenessPayload = payloadByKey.get('completeness_verify_result');
    if (completenessPayload) feedback.completenessFeedback = completenessPayload;
    return feedback;
  } catch (err) {
    // IPC 失败 / project 未注册 / handler 抛 → graceful undefined（caller 降级空串，不崩 chain）。
    logger.warn(
      { projectPath, prevEpisodeId, err: err instanceof Error ? err.message : String(err) },
      'fetchPrevEpisodeFeedback: feedback_ledger_read failed → graceful undefined',
    );
    return undefined;
  }
}

/**
 * 解析上一章 episodeId + 读 feedback ledger（design §2.2 / interface-contracts 外键 index convention）。
 *
 * 上章 = episode_outlines 中 index = 本章 index - 1 的 episode。**真实存在查找**（find by index），非数组位置
 * 假设（`episodeOutlines[currentIndex - 1]`）——interface-contracts「外键 index 不保证连续」convention：
 * 删章留 gap / 1-based / 重编号都可能，数组位置假设会误读错章。gap 时 find 返 undefined → 无上章 → 空串
 * （诚实，非误读错章）。
 *
 * @returns 三字段 feedback payload；undefined = 无上章 / 工具未注册 / 读失败（caller 降级空串，零回归）。
 */
async function resolvePrevEpisodeFeedback(
  episodeId: string,
  episodeOutlines: ChapterChainProjectInput['episode_outlines'],
  projectPath: string,
): Promise<PrevEpisodeFeedback | undefined> {
  if (!Array.isArray(episodeOutlines) || episodeOutlines.length === 0) return undefined;
  const currentOutline = episodeOutlines.find((e) => e?.id === episodeId);
  const currentIndex = currentOutline?.index;
  // 第一章（index=0）/ index 缺 / index 非数 → 无上章（不调 ledger read，免无谓 IPC）。
  if (typeof currentIndex !== 'number' || currentIndex <= 0) return undefined;
  // 上章 = index === currentIndex - 1（真实存在查找，非数组位置——gap 时 find 返 undefined → 无上章 → 空串零回归）。
  const prevEpisodeId = episodeOutlines.find((e) => typeof e?.index === 'number' && e.index === currentIndex - 1)?.id;
  if (!prevEpisodeId) return undefined;
  return fetchPrevEpisodeFeedback(projectPath, prevEpisodeId);
}

/**
 * Story 7.4：从 review.latest payload 抽 block+warn findings 格式化给 Director（auditFindings var）。
 *
 * mirror chainRunner extractEscalateFindings 哲学（drop info 噪声 + grounding 硬要求 quote/location/explanation），
 * 附 dimension name 供 Director 知 finding 归属维（判「哪个 finding 值得结构编辑」参考）。Director 重规划段需全量
 * 结构问题（非仅灰区）——block+warn 给 Director 判哪个值得原子操作修复，info 噪声丢。
 *
 * 范式判据：纯机械投影（过滤 + 字段抽取），不判「值不值得」（归 Director LLM）。
 */
function formatAuditFindingsFromReview(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  const dimensions = payload.dimensions;
  if (!Array.isArray(dimensions)) return '';
  const findings: Array<Record<string, unknown>> = [];
  for (const dim of dimensions) {
    if (!dim || typeof dim !== 'object') continue;
    const d = dim as { name?: unknown; findings?: unknown };
    if (!Array.isArray(d.findings)) continue;
    for (const f of d.findings) {
      if (!f || typeof f !== 'object') continue;
      const finding = f as { severity?: unknown; quote?: unknown; location?: unknown; explanation?: unknown; subClass?: unknown };
      if (finding.severity !== 'block' && finding.severity !== 'warn') continue; // drop info 噪声
      const quote = typeof finding.quote === 'string' ? finding.quote : '';
      const location = typeof finding.location === 'string' ? finding.location : '';
      const explanation = typeof finding.explanation === 'string' ? finding.explanation : '';
      if (!quote || !location || !explanation) continue; // grounding 硬要求（mirror extractEscalateFindings CR-Edge-6）
      const entry: Record<string, unknown> = {
        dimension: typeof d.name === 'string' ? d.name : '',
        severity: finding.severity,
        quote,
        location,
        explanation,
      };
      if (typeof finding.subClass === 'string') entry.subClass = finding.subClass;
      findings.push(entry);
    }
  }
  return findings.length > 0 ? JSON.stringify(findings) : '';
}

/**
 * Story 7.4：从 emotion_verify_result payload 格式化给 Director（emotionVerifyFeedback var）。
 *
 * Director 情绪反馈段期望「flag 列表」（director-agent.yaml）+ adjustedSetpoints（emotion-verify schema 注「反哺下一轮
 * Director」）。抽 {flags, adjustedSetpoints?, degraded?}——drop characterArcs/readerTopology.directions 噪声
 * （Director 只需 flag 知方向 + setpoints 反哺，逐角色弧 metric 是统计细节非规划所需）。
 *
 * 范式判据：纯机械字段抽取，不判语义。无 flag 且无 setpoint → 空串（Director 照常规划，无信号需调整）。
 */
function formatEmotionVerifyFeedback(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  const flagsRaw = payload.flags;
  const flags = Array.isArray(flagsRaw) ? flagsRaw.filter((f): f is string => typeof f === 'string') : [];
  const setpointsRaw = payload.adjustedSetpoints;
  const adjustedSetpoints = Array.isArray(setpointsRaw)
    ? setpointsRaw.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && !Array.isArray(s))
    : [];
  if (flags.length === 0 && adjustedSetpoints.length === 0) return '';
  const out: Record<string, unknown> = { flags };
  if (adjustedSetpoints.length > 0) out.adjustedSetpoints = adjustedSetpoints;
  if (typeof payload.degraded === 'boolean') out.degraded = payload.degraded;
  return JSON.stringify(out);
}

/**
 * Story 7.4：从 completeness_verify_result payload 格式化给 Director（completenessFeedback var）。
 *
 * Director 完整性反馈段期望「finding 列表 + suggestedFix」（director-agent.yaml）。抽 findings 全量——每条带
 * category/verdict/entityId/entityLabel/quote/location/explanation/suggestedFix（completeness-candidates.ts schema）。
 *
 * 范式判据：纯机械字段抽取（per-element 守性 filter），不判语义。无 finding → 空串。
 */
function formatCompletenessFeedback(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  const findingsRaw = payload.findings;
  const findings = Array.isArray(findingsRaw)
    ? findingsRaw.filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null && !Array.isArray(f))
    : [];
  if (findings.length === 0) return '';
  return JSON.stringify(findings);
}

// ── Story 8.2 Step 4：弧生命周期 post-settle（关口大审 + 停滞触发 + 三档路由 + Director 反哺，design §2/§5）──
//
// 范式判据（ADR-3 / creative-vs-mechanical）：
// - 纯代码（本块）：关口判定（detectVolumeClosure 集合查询）/ 停滞检测（detectArcStagnation 计数）/
//   span 派生（deriveArcSpan min/max）/ 防重（stagnation 行 toEpisodeIndex 比对）/ findings 格式投影。
// - LLM（arc-audit-agent）：通读审判（卷摘要 + 六维 findings）+ route 三档分类（defect/deviation/gray
//   是语义判断非规则，design §5）。
// - 三档路由机械分派（design §5）：defect → surface 文案（人导演定位，过往章重写 = 涟漪大手术作者手动
//   触发 7.x，AI 不自动回改历史）/ deviation → auto 档 agent 审内直调 story_decisions_update
//   （allowedTools 含 + yaml 指令，mirror Director autoApplyFlag 双档）/ gray → 裁决器附弧上下文
//   （dispatchAdjudicator arcContext，4.6 链感知扩展）。
//
// graceful（mirror adjudicator D5）：dispatch/parse 失败 → warn + 文案告知（不假 pass 不破链）。
// 串行纪律（feedback-api-concurrency-no-parallel）：停滞弧逐个 for-await 派发，不并行。
//
// 经 registry builtin（query_arc / query_arc_summary / record_arc_audit → toolExecution IPC → shell
// arcLedgerHandlers），非直连 db（agent 包无 db 访问，守 module-boundaries，mirror feedback_ledger_read）。

/** query_arc_summary 返行归一（ArcSummaryRow 投影；corruptPayload 行跳过不喂下游，mirror CR-011）。 */
interface ArcAuditRow {
  arcRef: string;
  auditKind: string;
  fromEpisodeIndex: number;
  toEpisodeIndex: number;
  producedAt: string;
  result?: { findings?: ArcAuditFinding[]; arcSummary?: NonNullable<ArcAuditResult['arcSummary']>; degraded?: boolean };
}

/**
 * 经 query_arc_summary builtin 取全部已物化弧审行（每弧最新）。graceful：工具未注册（测试 registry 空）/
 * 调用失败 / metadata 坏形态 → undefined（caller 降级：反哺空 / 防重失能保守跳过判定须 caller 自慎）。
 */
async function fetchArcAuditRowsViaTool(projectPath: string): Promise<ArcAuditRow[] | undefined> {
  const tool = registry.get('query_arc_summary');
  if (!tool) return undefined;
  try {
    const result = await tool.execute(
      {},
      {
        sessionId: '',
        projectPath,
        abort: new AbortController().signal,
      },
    );
    const rows = (result.metadata as { summaries?: unknown } | undefined)?.summaries;
    if (!Array.isArray(rows)) return undefined;
    const out: ArcAuditRow[] = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const row = r as Record<string, unknown>;
      if (typeof row.arcRef !== 'string' || typeof row.auditKind !== 'string') continue;
      if (row.corruptPayload === true) continue; // 坏 JSON 行不喂下游（mirror fetchPrevEpisodeFeedback CR-011）
      const resultRec =
        row.result && typeof row.result === 'object' && !Array.isArray(row.result)
          ? (row.result as ArcAuditRow['result'])
          : undefined;
      out.push({
        arcRef: row.arcRef,
        auditKind: row.auditKind,
        fromEpisodeIndex: typeof row.fromEpisodeIndex === 'number' ? row.fromEpisodeIndex : 0,
        toEpisodeIndex: typeof row.toEpisodeIndex === 'number' ? row.toEpisodeIndex : 0,
        producedAt: typeof row.producedAt === 'string' ? row.producedAt : '',
        result: resultRec,
      });
    }
    return out;
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'fetchArcAuditRowsViaTool: query_arc_summary failed → graceful undefined',
    );
    return undefined;
  }
}

/**
 * 经 query_arc builtin 取全量弧节拍（关口 span 派生 + 停滞检测输入）。graceful：工具未注册/失败 →
 * undefined（caller 跳过弧审 post-settle——无 beats 无法判关口/停滞，不假跑）。
 */
async function fetchArcBeatsViaTool(
  projectPath: string,
  narrow?: { arcRef?: string },
): Promise<ArcBeat[] | undefined> {
  const tool = registry.get('query_arc');
  if (!tool) return undefined;
  try {
    const result = await tool.execute(
      narrow?.arcRef !== undefined ? { arcRef: narrow.arcRef } : {},
      { sessionId: '', projectPath, abort: new AbortController().signal },
    );
    const meta = result.metadata as { beats?: unknown } | undefined;
    if (!meta || !Array.isArray(meta.beats)) return undefined;
    return meta.beats.flatMap((b) => {
      const parsed = arcBeatSchema.safeParse(b);
      return parsed.success ? [parsed.data] : [];
    });
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'fetchArcBeatsViaTool: query_arc failed → graceful undefined',
    );
    return undefined;
  }
}

/**
 * Story 8.2 Req 6：最近一次弧审的 findings（Director {{arcFeedback}} 反哺源）。多弧取 producedAt 最新
 * 一行（「最近弧审」，design §2 折叠消费——cross-chapter 非逐弧倾倒）。纯机械选取 + 投影。
 */
async function fetchLatestArcAuditFindings(projectPath: string): Promise<ArcAuditFinding[] | undefined> {
  const rows = await fetchArcAuditRowsViaTool(projectPath);
  if (!rows || rows.length === 0) return undefined;
  const withFindings = rows.filter((r) => Array.isArray(r.result?.findings));
  if (withFindings.length === 0) return undefined;
  const latest = withFindings.reduce((a, b) => (a.producedAt >= b.producedAt ? a : b));
  const findings = latest.result?.findings;
  if (!findings || findings.length === 0) return undefined;
  return findings;
}

/**
 * Story 8.2 Req 6：弧审 findings → Director arcFeedback var（纯机械投影 JSON，mirror
 * formatCompletenessFeedback——不判「值不值得反哺」归 Director）。无 findings → 空串（Director 照常规划）。
 */
function formatArcFeedback(findings: ArcAuditFinding[] | undefined): string {
  if (!findings || findings.length === 0) return '';
  return JSON.stringify(findings);
}

/**
 * Story 8.2 Req 4/AC6：最近卷弧摘要的紧凑投影（4.4 completeness-verify {{arcSnapshot}} var 源）。
 * synopsis + lineSections 支线段 + openThreads 遗留钩子（导航地图——浅雷达的长程视野注入，8.1 design §9
 * 「分弧/折叠快照 reader」的落地）。无卷摘要（closure 行缺/无 arcSummary）→ undefined（节点降级空串）。
 * 纯机械投影。
 */
async function fetchLatestArcSnapshotProjection(projectPath: string): Promise<string | undefined> {
  const rows = await fetchArcAuditRowsViaTool(projectPath);
  if (!rows) return undefined;
  const closures = rows.filter((r) => r.auditKind === 'closure' && r.result?.arcSummary !== undefined);
  if (closures.length === 0) return undefined;
  const latest = closures.reduce((a, b) => (a.producedAt >= b.producedAt ? a : b));
  const arcSummary = latest.result!.arcSummary!;
  return JSON.stringify({
    arcRef: latest.arcRef,
    span: { fromEpisodeIndex: latest.fromEpisodeIndex, toEpisodeIndex: latest.toEpisodeIndex },
    synopsis: arcSummary.synopsis,
    lineSections: arcSummary.lineSections,
    openThreads: arcSummary.openThreads,
  });
}

/** arc_audit 输出 content schema（arcRef/arcKind/span 机械字段 caller 派生后覆写，不信 LLM 回显——mirror 7.1 F2）。 */
const ARC_AUDIT_CONTENT_SCHEMA = arcAuditResultSchema.omit({ arcRef: true, arcKind: true, span: true });

/**
 * 解析 arc-audit-agent 输出（extractJson 三路径鲁棒 mirror 4.5 P2 + safeParse + 机械字段覆写）。
 * parse 失败 / schema 违 → null（caller graceful 告知，不假 pass）。
 */
function parseArcAuditOutput(
  content: string,
  derived: { arcRef: string; arcKind: 'volume' | 'line' | 'growth'; span: { fromEpisodeIndex: number; toEpisodeIndex: number } },
): ArcAuditResult | null {
  let root: unknown;
  try {
    root = JSON.parse(extractJson(content));
  } catch {
    return null;
  }
  const parsed = ARC_AUDIT_CONTENT_SCHEMA.safeParse(root);
  if (!parsed.success) return null;
  return { ...parsed.data, arcRef: derived.arcRef, arcKind: derived.arcKind, span: derived.span };
}

/** 本章 episodeIndex 解析（真实存在查找 by id，mirror resolvePrevEpisodeFeedback 外键 convention）。 */
function resolveCurrentEpisodeIndex(
  episodeOutlines: ChapterChainProjectInput['episode_outlines'],
  episodeId: string,
): number | undefined {
  if (!Array.isArray(episodeOutlines)) return undefined;
  const current = episodeOutlines.find((e) => e?.id === episodeId);
  return typeof current?.index === 'number' ? current.index : undefined;
}

/**
 * 构造 arc-audit-agent 的 arcContext var（弧结构 + 章清单 JSON，design §2 输入上下文）。纯机械投影——
 * volume 弧附 phase 结构（goal/climax/hook 对照判挣得）/ line 弧附 line 结构（mice_type/convergence_target）/
 * growth 弧附 characterId（`growth:<id>` 前缀剥离——角色卡详情 agent 可经既有读工具自查）；章清单 =
 * span 区间 episodes（id/index/title，导航 + 通读范围）。
 */
function buildArcAuditContext(args: {
  arcRef: string;
  arcKind: 'volume' | 'line' | 'growth';
  span: { fromEpisodeIndex: number; toEpisodeIndex: number };
  episodeOutlines: ChapterChainProjectInput['episode_outlines'];
  sceneGraph: SceneGraph | undefined;
  outlinePhases: unknown;
  chaptersSinceLastBeat?: number;
}): string {
  const chapterList = (Array.isArray(args.episodeOutlines) ? args.episodeOutlines : [])
    .filter(
      (e) =>
        typeof e?.index === 'number' && e.index >= args.span.fromEpisodeIndex && e.index <= args.span.toEpisodeIndex,
    )
    .map((e) => ({ id: e.id, index: e.index, title: e.title }));
  const structure =
    args.arcKind === 'volume'
      ? {
          phase:
            (Array.isArray(args.outlinePhases) ? args.outlinePhases : []).find(
              (p) => p && typeof p === 'object' && (p as { id?: unknown }).id === args.arcRef,
            ) ?? null,
        }
      : args.arcKind === 'growth'
        ? { characterId: args.arcRef.startsWith('growth:') ? args.arcRef.slice('growth:'.length) : args.arcRef }
        : {
            line: args.sceneGraph?.lines.find((l) => l && typeof l === 'object' && l.id === args.arcRef) ?? null,
          };
  return JSON.stringify({
    auditTarget: {
      arcRef: args.arcRef,
      arcKind: args.arcKind,
      span: args.span,
      ...(args.chaptersSinceLastBeat !== undefined ? { chaptersSinceLastBeat: args.chaptersSinceLastBeat } : {}),
    },
    structure,
    chapterList,
  });
}

/**
 * 派发 arc-audit-agent（AGENT-009 长程连贯 owner，runAgentWithExplicitSystem，await mirror adjudicator）。
 * allowedTools（design §1）：chapter_list/chapter_read（逐章通读跨 turn）/query_chapter_summary（章摘要
 * 地图）/query_arc_summary（前卷摘要折叠）/outline_read/scene_graph_read/query_promise + **auto 档加
 * story_decisions_update**（deviation findings 审内登记 source='arc-audit'，yaml 指令 + requirement 注明；
 * 非自动档不配——readonly/suggest 下子 agent 拿写工具 = 越权，mirror Director D8 mode-conditional）。
 * graceful：skillExecutor 缺 / dispatch 抛 / parse 失败 → null（caller 文案告知不假 pass）。
 */
async function dispatchArcAudit(args: {
  ctx: ToolContext;
  auditKind: 'closure' | 'stagnation';
  arcRef: string;
  arcKind: 'volume' | 'line' | 'growth';
  span: { fromEpisodeIndex: number; toEpisodeIndex: number };
  arcContext: string;
  requirement: string;
  autoApplyFlag: boolean;
}): Promise<ArcAuditResult | null> {
  const skillExecutor = args.ctx.skillExecutor;
  if (!skillExecutor?.runAgentWithExplicitSystem) return null;

  // 前弧摘要折叠（design §2 折叠消费——免重读全史；本弧旧行也含，agent 覆盖语义）。
  const priorRows = await fetchArcAuditRowsViaTool(args.ctx.projectPath);
  const priorSummaries = (priorRows ?? [])
    .map((r) => ({
      arcRef: r.arcRef,
      auditKind: r.auditKind,
      span: { fromEpisodeIndex: r.fromEpisodeIndex, toEpisodeIndex: r.toEpisodeIndex },
      synopsis: r.result?.arcSummary?.synopsis ?? '',
      findingsCount: r.result?.findings?.length ?? 0,
      degraded: r.result?.degraded === true,
    }));
  const priorSummariesVar = priorSummaries.length > 0 ? JSON.stringify(priorSummaries) : '（无已物化弧摘要——首次弧审）';

  const autoApplyNote = args.autoApplyFlag
    ? '（autoApply=true：deviation finding 直接调 story_decisions_update 登记，op=register + source=arc-audit + risk 必填）'
    : '（人审档：不调写工具——deviation 只列 findings，工作台会呈「建议登记的决策」给人审）';
  const vars: Record<string, string> = {
    arcContext: args.arcContext,
    priorSummaries: priorSummariesVar,
    requirement: `${args.requirement}${autoApplyNote}`,
  };

  try {
    const result = await skillExecutor.runAgentWithExplicitSystem(
      args.ctx.sessionId,
      'arc-audit-agent',
      vars,
      {
        abort: args.ctx.abort,
        ...(args.ctx.spawnDepth !== undefined ? { spawnDepth: args.ctx.spawnDepth } : {}),
        ...(args.ctx.emitChildEvent ? { emitChildEvent: args.ctx.emitChildEvent } : {}), // R2 #3 二段：child 事件透传
        allowedTools: args.autoApplyFlag
          ? ['chapter_list', 'chapter_read', 'query_chapter_summary', 'query_arc_summary', 'outline_read', 'scene_graph_read', 'query_promise', 'story_decisions_update']
          : ['chapter_list', 'chapter_read', 'query_chapter_summary', 'query_arc_summary', 'outline_read', 'scene_graph_read', 'query_promise'],
      },
    );
    return parseArcAuditOutput(result.content, args);
  } catch (err) {
    logger.warn(
      { arcRef: args.arcRef, auditKind: args.auditKind, err: err instanceof Error ? err.message : String(err) },
      'write_chapter: arc-audit dispatch failed → graceful skip (surface text only)',
    );
    return null;
  }
}

/**
 * 弧审产物落 closure_arc_summary（record_arc_audit builtin → shell upsert，DERIVED autoApply 语义）。
 * graceful：工具未注册/失败 → false（caller 文案告知——快照未落但 findings 仍 surface，不静默）。
 */
async function recordArcAuditViaTool(
  ctx: ToolContext,
  auditKind: 'closure' | 'stagnation',
  result: ArcAuditResult,
): Promise<boolean> {
  const tool = registry.get('record_arc_audit');
  if (!tool) {
    logger.warn({ arcRef: result.arcRef }, 'write_chapter: record_arc_audit tool not registered → arc audit snapshot not persisted');
    return false;
  }
  try {
    const res = await tool.execute(
      { auditKind, result },
      { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort },
    );
    return (res.metadata as { ok?: boolean } | undefined)?.ok === true;
  } catch (err) {
    logger.warn(
      { arcRef: result.arcRef, err: err instanceof Error ? err.message : String(err) },
      'write_chapter: record_arc_audit failed → arc audit snapshot not persisted',
    );
    return false;
  }
}

/** 弧审三档路由文案（design §5：defect surface / deviation 决策登记提示 / gray 裁决器附弧上下文）。 */
async function routeArcAuditFindings(args: {
  result: ArcAuditResult;
  auditKind: 'closure' | 'stagnation';
  ctx: ToolContext;
  autoApplyFlag: boolean;
  summary: RunSnapshotSummary;
  chapterBrief: ChapterBrief | undefined;
  initialArtifacts: Record<string, unknown>;
}): Promise<string[]> {
  const { result, auditKind, ctx, autoApplyFlag, summary, chapterBrief, initialArtifacts } = args;
  const lines: string[] = [];
  const defectFindings = result.findings.filter((f) => f.route === 'defect');
  const deviationFindings = result.findings.filter((f) => f.route === 'deviation');
  const grayFindings = result.findings.filter((f) => f.route === 'gray');
  const kindLabel = auditKind === 'closure' ? '卷弧闭合大审' : '停滞专注审';

  // defect 档：surface 文案（人导演定位——过往章重写是涟漪大手术，作者手动触发 7.x，AI 不自动回改）。
  for (const f of defectFindings) {
    lines.push(`  · [defect/${f.category}/${f.verdict}] ${f.entityLabel} — ${f.explanation}`);
    lines.push(`    "${f.quote}"（${f.location}）；修复参考：${f.suggestedFix}`);
  }

  // deviation 档：auto 档 agent 审内直调 story_decisions_update（allowedTools + yaml 指令，此处不重复
  // 程序化登记——登记语义已在 agent 工具调用内）；人审档只 surface「建议登记的决策」（不产 envelope——
  // 弧审 finding 非本章 field_patch 语义，人审后由 leader/用户按文案登记）。
  if (deviationFindings.length > 0) {
    if (autoApplyFlag) {
      lines.push(`  · deviation ${deviationFindings.length} 条——arc-audit 已被授权审内登记创作决策（story_decisions_update，source='arc-audit'）；登记是否落成以工作台决策记录为准（子 agent 工具调用失败不阻断本审）。`);
      for (const f of deviationFindings) {
        lines.push(`    [deviation/${f.category}] ${f.entityLabel} — ${f.explanation}（修复参考：${f.suggestedFix}）`);
      }
    } else {
      lines.push(`  · 建议登记的决策（deviation ${deviationFindings.length} 条——正文走了另一条路且走得通，人审后登记 StoryDecision）：`);
      for (const f of deviationFindings) {
        lines.push(`    [deviation/${f.category}] ${f.entityLabel} — ${f.explanation}（"${f.quote}" @ ${f.location}）`);
      }
    }
  }

  // gray 档：裁决器附弧上下文（4.6 链感知扩展——arcSynopsis + gray findings 一批一次派发，串行纪律）。
  if (grayFindings.length > 0) {
    const synopsis = result.arcSummary?.synopsis;
    const arcContext = JSON.stringify({
      auditKind: kindLabel,
      arcRef: result.arcRef,
      span: result.span,
      ...(synopsis !== undefined ? { arcSynopsis: synopsis } : {}),
      grayFindings,
    });
    const adjudication = await dispatchAdjudicator(summary, chapterBrief, ctx, initialArtifacts, arcContext);
    if (adjudication) {
      lines.push(`  · 灰区 ${grayFindings.length} 条——弧语境裁决器初审：${adjudication.analysis}`);
      lines.push(`    倾向：${adjudication.recommendation === 'accept' ? '接受为真相' : '改稿'} —— ${adjudication.recommendationReason || '（无理由）'}`);
      for (const f of grayFindings) {
        lines.push(`    [gray/${f.category}] ${f.entityLabel} — ${f.explanation}（"${f.quote}" @ ${f.location}）`);
      }
    } else {
      lines.push(`  · 灰区 ${grayFindings.length} 条——裁决器暂不可用（parse 失败/超时），请你直接裁决：`);
      for (const f of grayFindings) {
        lines.push(`    [gray/${f.category}] ${f.entityLabel} — ${f.explanation}（"${f.quote}" @ ${f.location}）`);
      }
    }
  }
  return lines;
}

/**
 * Story 8.2 弧生命周期 post-settle 编排（design §2 两触发 + §5 三档路由）。
 *
 * 1. **关口判定**：detectVolumeClosure（本章 beats 卷弧 close）命中 → 派 arc-audit-agent 大审（closure，
 *    双产出：卷摘要 + findings 六维）；span = deriveArcSpan（全量 beats 该弧首末 beat episode 区间——随
 *    实际节拍走，规划 estimated_chapters 漂移自然被吸收）。
 * 2. **停滞触发**（独立于关口）：detectArcStagnation（全量 beats，线/成长弧未闭合 + 距末拍 > N 章）→
 *    逐弧专注审（stagnation，只产 findings 无摘要）。**防重**：query_arc_summary 已有该弧 stagnation 行
 *    且 span.toEpisodeIndex >= lastBeatEpisodeIndex（同一停滞窗审过）→ 跳过（防每章重派同一停滞弧）。
 * 3. 产物经 record_arc_audit 落 closure_arc_summary（DERIVED）+ 三档路由文案返 caller append。
 *
 * graceful 全程：query_arc 不可用 / span 不可派 / dispatch 失败 → warn + 文案告知（不假 pass 不破链，
 * mirror adjudicator）。paused 不跑（resume 路径非本 tool 职域，mirror storySync gate）。
 *
 * 纯代码编排（范式判据 ✓）：判定/派生/防重/分派全机械；审判语义归 arc-audit LLM。
 */
async function runArcAuditPostSettle(args: {
  summary: RunSnapshotSummary;
  ctx: ToolContext;
  episodeId: string;
  episodeOutlines: ChapterChainProjectInput['episode_outlines'];
  sceneGraph: SceneGraph | undefined;
  outlinePhases: unknown;
  autoApplyFlag: boolean;
  chapterBrief: ChapterBrief | undefined;
  initialArtifacts: Record<string, unknown>;
}): Promise<string[]> {
  const { summary, ctx, episodeId, episodeOutlines, sceneGraph, outlinePhases, autoApplyFlag, chapterBrief, initialArtifacts } = args;
  const lines: string[] = [];

  // 全量 beats（关口 span + 停滞检测输入）。query_arc 不可用（测试 registry 空 / 旧 shell）→ 跳过整个
  // 弧审 post-settle（无 beats 无法判关口/停滞；arc_emergence beats 只覆盖本章非全量）。
  const allBeats = await fetchArcBeatsViaTool(ctx.projectPath);
  if (allBeats === undefined) return lines;

  // ── 1. 关口大审（本章卷弧 close beat → 通读全卷判所有弧 + 产卷摘要）──
  const closeBeat = detectVolumeClosure(summary.arcEmergenceBeats ?? [], episodeId);
  if (closeBeat) {
    // span 派生用 **per-arc 收窄查询**（终审 F1 修）：无收窄的全量读窗（200 beats）在长卷下会截掉该弧
    // 早期 beats → deriveArcSpan 静默算出偏晚的 span（大审只读卷尾却以为读完整卷——比 skip 更糟）。
    // per-arc 窗（单弧 200 beats ≈ 数百章余量）覆盖整卷；收窄查询失败 → 退回全量窗仍不可解析才 honest skip。
    const arcBeats = await fetchArcBeatsViaTool(ctx.projectPath, { arcRef: closeBeat.arcRef });
    const span = deriveArcSpan(arcBeats ?? allBeats, closeBeat.arcRef);
    if (span === undefined) {
      // close beat 的弧在全量 beats 无区间（query_arc 最近窗截断丢早期 beat / registry 不一致）——
      // 不假跑（span 是大审通读范围），warn + 告知（永不静默 fail）。
      logger.warn(
        { arcRef: closeBeat.arcRef, episodeId },
        'write_chapter: volume close beat detected but span unresolvable (query_arc window truncation?) → skip closure audit',
      );
      lines.push('');
      lines.push(`弧审核：本章声明卷弧「${closeBeat.arcRef}」闭合，但全量节拍区间不可解析（读窗截断？）——关口大审未执行，请检查 arc_registry。`);
    } else {
      const arcContext = buildArcAuditContext({
        arcRef: closeBeat.arcRef,
        arcKind: 'volume',
        span,
        episodeOutlines,
        sceneGraph,
        outlinePhases,
      });
      const requirement =
        `卷弧闭合关口大审（audit_kind=closure）：通读该卷 span 全部正文（chapter_read 逐章，跨 turn 累积），` +
        '先立卷摘要 arcSummary（通读撰写非折叠章摘要，含支线段/成长弧状态/情绪与主题观察/遗留钩子），' +
        '后批判 findings 六维（volume-arc/arc-drift/foreshadow-payoff/theme-earning/character-arc/emotion-arc），' +
        '每条 route 三档分类（defect/deviation/gray）+ quote/location grounding 硬要求。';
      const result = await dispatchArcAudit({
        ctx,
        auditKind: 'closure',
        arcRef: closeBeat.arcRef,
        arcKind: 'volume',
        span,
        arcContext,
        requirement,
        autoApplyFlag,
      });
      if (result) {
        const persisted = await recordArcAuditViaTool(ctx, 'closure', result);
        lines.push('');
        const defectCount = result.findings.filter((f) => f.route === 'defect').length;
        const deviationCount = result.findings.filter((f) => f.route === 'deviation').length;
        const grayCount = result.findings.filter((f) => f.route === 'gray').length;
        lines.push(
          `弧审核：卷弧「${result.arcRef}」闭合关口大审完成——span #${span.fromEpisodeIndex}-#${span.toEpisodeIndex}，` +
            `findings ${result.findings.length}（defect ${defectCount}/deviation ${deviationCount}/gray ${grayCount}）` +
            `${result.arcSummary ? '，卷摘要已物化（含支线段 + 遗留钩子，供后续章导航）' : ''}${persisted ? '' : '——⚠ 快照落盘失败（findings 仍呈上）'}${result.degraded ? `；⚠ degraded：${result.degradationNote ?? ''}` : ''}。`,
        );
        lines.push(...(await routeArcAuditFindings({ result, auditKind: 'closure', ctx, autoApplyFlag, summary, chapterBrief, initialArtifacts })));
      } else {
        // 永不假 pass：dispatch/parse 失败 → 告知（不静默、不编造「审过没问题」）。
        lines.push('');
        lines.push(`弧审核：卷弧「${closeBeat.arcRef}」闭合触发关口大审，但派发/解析失败——本次未审，下一卷闭合或手动重试（详见日志）。`);
      }
    }
  }

  // ── 2. 停滞触发（线弧/成长弧连续 N 章无节拍 → 专注审；独立于关口）──
  const currentEpisodeIndex = resolveCurrentEpisodeIndex(episodeOutlines, episodeId);
  if (currentEpisodeIndex !== undefined) {
    const stagnant = detectArcStagnation(allBeats, currentEpisodeIndex);
    if (stagnant.length > 0) {
      // 防重：已物化 stagnation 行覆盖同一停滞窗（span.toEpisodeIndex >= lastBeatEpisodeIndex）→ 跳过。
      // 不覆盖（弧在旧审后又推进了 beats 再停滞）→ 重审（新停滞窗）。
      const priorRows = (await fetchArcAuditRowsViaTool(ctx.projectPath)) ?? [];
      for (const s of stagnant) {
        const alreadyAudited = priorRows.some(
          (r) => r.arcRef === s.arcRef && r.auditKind === 'stagnation' && r.toEpisodeIndex >= s.lastBeatEpisodeIndex,
        );
        if (alreadyAudited) {
          logger.info(
            { arcRef: s.arcRef, lastBeatEpisodeIndex: s.lastBeatEpisodeIndex },
            'write_chapter: stagnant arc already audited for this window → skip (防重)',
          );
          continue;
        }
        // span 精取（终审 F1 修，同关口分支）：detectArcStagnation 的 s.span 派生自全量读窗（200 beats），
        // 多弧并行时长弧早期 beats 可能被截——per-arc 收窄查询重派（失败退回窗内 span，停滞审语义容忍——
        // 它主判「近期为何不动」非「弧全貌」）。
        const arcBeats = await fetchArcBeatsViaTool(ctx.projectPath, { arcRef: s.arcRef });
        const span = (arcBeats !== undefined ? deriveArcSpan(arcBeats, s.arcRef) : undefined) ?? s.span;
        const arcContext = buildArcAuditContext({
          arcRef: s.arcRef,
          arcKind: s.arcKind, // 'line' | 'growth'——诚实标注（终审 F2 修：ArcAuditResult.arcKind 扩 growth，不再错标 line）
          span,
          episodeOutlines,
          sceneGraph,
          outlinePhases,
          chaptersSinceLastBeat: s.chaptersSinceLastBeat,
        });
        const requirement =
          `停滞专注审（audit_kind=stagnation）：弧「${s.arcRef}」已连续 ${s.chaptersSinceLastBeat} 章无新节拍` +
          `（末拍 episode #${s.lastBeatEpisodeIndex}，当前 #${currentEpisodeIndex}）——通读其节拍区间正文，` +
          '判停滞是「故意的长线铺垫」还是「漂移/遗忘」（arc-drift 维为主，verdict=stalled）。只产 findings 不产 arcSummary。';
        const result = await dispatchArcAudit({
          ctx,
          auditKind: 'stagnation',
          arcRef: s.arcRef,
          arcKind: s.arcKind,
          span,
          arcContext,
          requirement,
          autoApplyFlag,
        });
        if (result) {
          await recordArcAuditViaTool(ctx, 'stagnation', result);
          lines.push('');
          lines.push(`弧审核：停滞弧「${s.arcRef}」专注审完成（${s.chaptersSinceLastBeat} 章无节拍，span #${span.fromEpisodeIndex}-#${span.toEpisodeIndex}，findings ${result.findings.length}${result.degraded ? '，degraded' : ''}）：`);
          lines.push(...(await routeArcAuditFindings({ result, auditKind: 'stagnation', ctx, autoApplyFlag, summary, chapterBrief, initialArtifacts })));
        } else {
          lines.push('');
          lines.push(`弧审核：停滞弧「${s.arcRef}」专注审派发/解析失败——本次未审（详见日志）。`);
        }
      }
    }
  }

  return lines;
}

/**
 * Story 6.3：派发 Director 子 agent（per-scene 信息差操控）+ 合入 initialArtifacts.info_release_map（design §3 段① / D1）。
 *
 * 流程：dispatch Director（读 query_cognition/graph + LLM 产 ManipulationDirective + **持久化 via
 * info_release_map_update autoApply**）→ parseDirectorInfoRelease 解析 → mergeDirectorEntries 合入
 * initialArtifacts['info_release_map']（in-memory，brief-compiler compileInfoRelease R1 已接通消费 → brief #3 +
 * manipulationDirectives[]）。任何失败 → return（InfoReleaseMap 保持 assembled 原样，链段照跑——Director 是增强
 * 非硬约束，mirror retrieval D4 graceful）。
 *
 * **双输出（DW-4 + R2 in-memory，R3 Step 7b 落地）**：Director runLoop 自然做工具调用 + 最终 JSON 输出（同 retrieval
 * 做 query_story + JSON）。Director 持久化 directives via `info_release_map_update(autoApply=true)` → onFieldEdited
 * 直接落盘 InfoReleaseMap creative field（权威源：工作台 review + 后章 idempotency）；同时输出 entries JSON（本函数
 * parseDirectorInfoRelease + mergeDirectorEntries 注入本场链段 in-memory brief #3）。两路径携带同一份 directive
 * （持久化 = 磁盘/未来/工作台权威；in-memory = 当前链段权威）。Director 持久化失败（locked/save fail）不阻断——
 * 仍输出 JSON（in-memory 链段照跑，仅落盘失败），由本函数 graceful 处理（mirror retrieval D4）。
 *
 * 工具限制（硬规矩）：allowedTools=['query_cognition','query_cognition_graph','info_release_map_update']——Director
 * 读 perspective 状态 + 持久化自身 directives（autoApply=true，DW-4 自动 authoring）。无其他写工具 / spawn_agent /
 * skill（mirror retrieval/adjudicator 收窄；info_release_map_update 是 Director 唯一写工具，bounded action 限 creative field）。
 *
 * 不进 CONTRACTS[]（leader 侧子 agent，mirror retrieval/adjudicator/world-amender/promise-emergence）。
 * spawn depth：leader→Director（depth+1）兄弟于 leader→chain（depth+1），非嵌套（同 retrieval/adjudicator）。
 *
 * merge precedence（design §6）：Director 产 directive 合入 InfoReleaseMap——既有 entry（同 sceneRef）补 directive
 * （保留 id + reveal/withhold/dramaticIrony），新场追加 entry（id=`director:<sceneRef>`）。brief #3 merge precedence
 * （leader 已填优先）在 brief-compiler compileInfoRelease 处理（R1）——本函数只产 InfoReleaseMap 数据源。
 */
async function dispatchDirectorAndAuthorInfoRelease(
  episodeId: string,
  leaderBrief: ChapterBrief | undefined,
  initialArtifacts: Record<string, unknown>,
  ctx: ToolContext,
  autoApplyFlag: boolean,
  episodeOutlines: ChapterChainProjectInput['episode_outlines'],
): Promise<{ infoReleaseMap: InfoReleaseMap | null; emotionCurve: EmotionCurve | null; atomicEdits: DirectorAtomicEditResult | null; storyDecisionPatch: unknown; decisionNote: string | null } | null> {
  // Director 不可用（skillExecutor 缺 / 旧 mock 无此方法）→ graceful：InfoReleaseMap + emotion_curve 保持 assembled 原样。
  const skillExecutor = ctx.skillExecutor;
  if (!skillExecutor?.runAgentWithExplicitSystem) {
    return null;
  }

  // vars 构建：chapterScenes（本章场景 id+summary，Director 逐场用）+ existingInfoRelease / existingEmotionCurve
  // （既有 entries / points JSON，idempotent 参考）+ brief 意图（含 emotionTarget，Director 参考 leader 已填目标）（mirror retrieval vars 抽法）。
  const sceneGraph = initialArtifacts['scene_graph'] as SceneGraph | undefined;
  const chapterScenes = (sceneGraph?.nodes ?? [])
    .filter((n) => isSceneInEpisode(n, episodeId))
    .map((n) => ({ id: n.id, summary: summarizeSceneForDirector(n) }));
  const chapterSceneIds = new Set(chapterScenes.map((s) => s.id));
  const existingMap = initialArtifacts['info_release_map'] as InfoReleaseMap | undefined;
  const existingCurve = initialArtifacts['emotion_curve'] as EmotionCurve | undefined;
  const briefParamsObj: Record<string, string> = {};
  if (leaderBrief?.pov) briefParamsObj.pov = leaderBrief.pov;
  if (leaderBrief?.tone) briefParamsObj.tone = leaderBrief.tone;

  // Story 7.4 Step 2：读上一章 cross-chapter feedback ledger 填 Director feedback var（激活 5.3/4.4/7.3 三段）。
  // 上章 episodeId 从 episode_outlines index-1 推导（interface-contracts 外键 index convention：真实存在查找）。
  // 任何失败（无上章 / 工具未注册 / 读失败 / payload 坏）→ 各 var 独立降级空串（Director 照常规划，零回归）。
  const prevFeedback = await resolvePrevEpisodeFeedback(episodeId, episodeOutlines, ctx.projectPath);

  // Story 8.2 Req 6：最近一次弧审 findings（{{arcFeedback}} 反哺源——fetchLatestArcAuditFindings 经
  // query_arc_summary builtin 取最近弧审行，纯机械选取 + 投影）。空（无弧审 / 首弧前 / 工具未注册）→
  // 空串（Director 照常规划，director-agent.yaml 弧审反馈段约定）。
  const arcAuditFindings = await fetchLatestArcAuditFindings(ctx.projectPath);

  const vars: Record<string, string> = {
    episodeId,
    chapterScenes: JSON.stringify(chapterScenes),
    existingInfoRelease: JSON.stringify(existingMap?.entries ?? []),
    existingEmotionCurve: JSON.stringify(existingCurve?.points ?? []),
    briefGoal: leaderBrief?.goal ?? '',
    briefParams: Object.keys(briefParamsObj).length > 0 ? JSON.stringify(briefParamsObj) : '',
    briefDoNotWrite: leaderBrief?.doNotWrite ?? '',
    briefEmotionTarget: leaderBrief?.emotionTarget ? JSON.stringify(leaderBrief.emotionTarget) : '',
    autoApplyFlag: String(autoApplyFlag),
    // Story 5.3（7.4 Step 2 ledger 接通）：上章 emotion_verify_result flag + adjustedSetpoints（Director 本章
    // 情绪规划参考）。feedback-ledger-node 链尾写 / 此处 chain-start 读上一章（cross-chapter，非 project.yaml）。
    // 空=首章 / 上章无 flag / 工具未注册 / 读失败 → Director 忽略此段照常规划（director-agent.yaml prompt 约定）。
    emotionVerifyFeedback: formatEmotionVerifyFeedback(prevFeedback?.emotionVerifyFeedback),
    // Story 4.4（7.4 Step 2 ledger 接通）：上章 completeness_verify_result findings + suggestedFix（Director 本章
    // 完整性规划参考）。空=首章 / 上章无 finding / 读失败 → Director 忽略此段照常规划。
    completenessFeedback: formatCompletenessFeedback(prevFeedback?.completenessFeedback),
    // Story 7.3（7.4 Step 2 ledger 接通）：上章 review.latest block+warn findings（Director 重规划段产
    // atomicEditProposals 用）。🔑 时序：Director 在 chain start 跑，本章 audit 尚未生成 → auditFindings 只能来自
    // 上一章 review（cross-chapter）。空=首章 / 上章无 block+warn finding / 读失败 → Director 不产 atomicEditProposals。
    auditFindings: formatAuditFindingsFromReview(prevFeedback?.auditFindings),
    // Story 8.2 Req 6（弧审反哺）：最近一次弧审 findings 六维 + suggestedFix（Director 本章规划的有限重规划
    // 参考——弧漂移发现 + 修复建议，mirror completenessFeedback 段措辞）。空=无弧审 / 工具未注册 →
    // Director 忽略此段照常规划（director-agent.yaml 弧审反馈段约定）。
    arcFeedback: formatArcFeedback(arcAuditFindings),
    // Story 2.6：既有创作决策（idempotent 参考——Director 已有同 id 不重复登记 + 避免与既有方向冲突）。
    // 投影 {id,summary,status,source}（防 prompt 撑大；risk/reason 等细节非 Director idempotency 所需）。
    existingDecisions: JSON.stringify(
      ((initialArtifacts['story_decisions'] as { id?: unknown; summary?: unknown; status?: unknown; source?: unknown }[] | undefined) ?? [])
        .filter((d) => d && typeof d === 'object')
        .map((d) => ({ id: d.id, summary: d.summary, status: d.status, source: d.source })),
    ),
  };

  let directorContent: string;
  try {
    const result = await skillExecutor.runAgentWithExplicitSystem(
      ctx.sessionId,
      'director-agent',
      vars,
      {
        abort: ctx.abort,
        ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
        ...(ctx.emitChildEvent ? { emitChildEvent: ctx.emitChildEvent } : {}), // R2 #3 二段：child 事件透传
        allowedTools: autoApplyFlag
          ? ['query_cognition', 'query_cognition_graph', 'info_release_map_update', 'emotion_curve_update']
          : ['query_cognition', 'query_cognition_graph'],
      },
    );
    directorContent = result.content;
  } catch (err) {
    // Director 抛错（agent 失败 / 超时 / abort）→ graceful（不抛、不上发，InfoReleaseMap + emotion_curve 保持原样）。
    logger.warn(
      { episodeId, err: err instanceof Error ? err.message : String(err) },
      'write_chapter: director dispatch failed → graceful skip info-release/emotion authoring',
    );
    return null;
  }

  // ═─ Story 6.3 InfoRelease 段（既有逻辑不动）──
  const parsed = parseDirectorInfoRelease(directorContent);

  // CR-inforelease-steer-4（BMad CR）：过滤幻觉 sceneRef。Director 产 sceneRef 不在本章场景集 → 丢，
  // 免 mergeDirectorEntries stamp episodeId 后变 relevant（compileInfoRelease relevance 是 OR：
  // episodeId OR sceneRef∈chapterScenes）→ 幻觉 sceneRef 经 stamp episodeId 编进本章 brief #3 + L2 误判。
  // merge 前 filter：只保留 sceneRef ∈ chapterSceneIds 的 entry。丢的 entry warn（不抛）。
  const validParsed = parsed.filter((entry) => chapterSceneIds.has(entry.sceneRef));
  const droppedCount = parsed.length - validParsed.length;
  if (droppedCount > 0) {
    logger.warn(
      { episodeId, droppedCount, total: parsed.length, droppedSceneRefs: parsed.filter((e) => !chapterSceneIds.has(e.sceneRef)).map((e) => e.sceneRef) },
      'write_chapter: dropped Director entries with hallucinated sceneRef (not in chapter scenes)',
    );
  }

  // assemble 总会注入 initialArtifacts['info_release_map']（至少空 default，含 updatedBy）；fallback 仅防御
  // 直测 / 坏 artifact 路径。updatedBy='agent'（mirror infoReleaseMapSchema default；R2 in-memory 未落盘）。
  let mergedMap: InfoReleaseMap | null = null;
  if (validParsed.length > 0) {
    const baseMap: InfoReleaseMap = existingMap ?? { entries: [], version: 0, updatedBy: 'agent' };
    mergedMap = mergeDirectorEntries(baseMap, validParsed, episodeId);
    initialArtifacts['info_release_map'] = mergedMap;
  }

  // ═─ Story 5.2 emotion 段（mirror InfoRelease 段，additive）──
  const emotionOutput: DirectorEmotionOutput = parseDirectorEmotion(directorContent);
  // 幻觉 refId filter（mirror CR-inforelease-steer-4）：Director 产 emotionPoint.refId 不在本章场景集 → 丢，
  // 免 mergeDirectorEmotionPoints 编进 emotion_curve 后被 compileEmotionTarget 误纳入本章 brief #10。
  const validEmotionPoints = emotionOutput.emotionPoints.filter((p) => chapterSceneIds.has(p.refId));
  const droppedEmotionCount = emotionOutput.emotionPoints.length - validEmotionPoints.length;
  if (droppedEmotionCount > 0) {
    logger.warn(
      { episodeId, droppedEmotionCount, total: emotionOutput.emotionPoints.length, droppedRefIds: emotionOutput.emotionPoints.filter((p) => !chapterSceneIds.has(p.refId)).map((p) => p.refId) },
      'write_chapter: dropped Director emotionPoints with hallucinated refId (not in chapter scenes)',
    );
  }

  let mergedCurve: EmotionCurve | null = null;
  if (validEmotionPoints.length > 0) {
    // assemble 总会注入 initialArtifacts['emotion_curve']（至少空 default unit:scene）；fallback 仅防御直测路径。
    const baseCurve: EmotionCurve = existingCurve ?? { unit: 'scene', points: [], emotional_promises: [], catharsis_points: [] };
    mergedCurve = mergeDirectorEmotionPoints(baseCurve, validEmotionPoints);
    initialArtifacts['emotion_curve'] = mergedCurve;
  }

  // 章级 emotionTarget 注入 initialArtifacts（供 brief-compiler compileEmotionTarget leader-priority merge）。
  // emotionTarget 不持久化（章级目标 ephemeral，编译进 brief #10 in-memory，mirror InfoRelease #3 不持久化）。
  if (emotionOutput.emotionTarget !== undefined) {
    initialArtifacts['director_emotion_target'] = emotionOutput.emotionTarget;
  }

  // ═─ Story 7.3 atomic-edit 段（audit 驱动结构编辑提议，design §4/§5）──
  // Director 单次 runLoop 输出四段同对象（含 atomicEditProposals），此处 parse + 过滤幻觉 + expand + validate。
  // 🔑 时序：auditFindings 来自上一章 review（cross-chapter ledger 未接 → 现 auditFindings 空串 → Director 不产
  // proposals → parseDirectorAtomicEdits 返 []）。本段建管道（parse/expand/validate），ledger 接通即激活（mirror
  // emotionVerifyFeedback / completenessFeedback「管道先建数据后接」哲学）。proposals 非空时 expand+validate，
  // clean 的 sceneGraphActions/promiseActions 落地 defer 7.4（prose 重生成闭环）——7.3 只产 validated expansion 供
  // 工作台/dashboard 可见 + 后续 7.4 落地消费。
  const atomicProposals = parseDirectorAtomicEdits(directorContent);
  let atomicEdits: DirectorAtomicEditResult | null = null;
  if (atomicProposals.length > 0) {
    // 过滤幻觉 sceneRef（mirror CR-inforelease-steer-4）：proposal 引用的 sceneId 不在本章场景集也不在既有 graph → 丢。
    const sceneGraph = initialArtifacts['scene_graph'] as SceneGraph | undefined;
    const allSceneIds = new Set<string>(chapterSceneIds);
    if (sceneGraph?.nodes) {
      for (const n of sceneGraph.nodes) allSceneIds.add(n.id);
    }
    // CR-009（7.3 DEFER 补，Story 7.4 design §5）：batch-aware filter——proposal B 锚 proposal A 创的新场
    //（如 B 的 atSceneId = A 的 bridgeScene.id）不应被当幻觉滤掉。先收集批次全部 proposal 将创建的新场 id，
    // 合入 allSceneIds 后再过滤。低概率（LLM 被指示锚既有场）但 7.3 明确 defer 7.4 补。
    const createdSceneIds = collectCreatedSceneIds(atomicProposals.map((p) => p.op));
    for (const id of createdSceneIds) allSceneIds.add(id);
    const validProposals = atomicProposals.filter((p) => proposalAnchorsExistingScene(p, allSceneIds));
    const droppedAtomicCount = atomicProposals.length - validProposals.length;
    if (droppedAtomicCount > 0) {
      logger.warn(
        { episodeId, droppedAtomicCount, total: atomicProposals.length },
        'write_chapter: dropped Director atomicEditProposals anchoring non-existent scene (hallucinated sceneId)',
      );
    }
    // CR-005：validProposals.length===0 时（全滤幻觉）不赋 atomicEdits——否则空对象破「null=no-surface」契约
    // （caller 误日志「Director 产 atomicEditProposals」但 0 条）。gate 在 validProposals.length>0。
    if (validProposals.length > 0) {
      // expand + validate（纯代码，design §3）。
      const ops = validProposals.map((p) => p.op);
      const ctx2 = sceneGraph ? { sceneGraph } : { sceneGraph: { nodes: [], edges: [], lines: [], art_overrides: [], version: 0, updatedBy: 'agent' as const } };
      const validation = validateAtomicEditOps(ops, ctx2);
      const expansions = ops.map((op) => expandAtomicEditOp(op, ctx2));
      const sceneGraphActions = expansions.flatMap((e) => e.sceneGraphActions);
      const promiseActions = expansions.flatMap((e) => e.promiseActions);
      atomicEdits = {
        proposals: validProposals,
        sceneGraphActions,
        promiseActions,
        validation,
      };
      // 校验 blocking 不静默落地（落地公理延伸，mirror 7.2 hard-violation）：blocking 时 atomicEdits 仍返（供工作台
      // 可见 + 人审/Director 重提议），但不进 initialArtifacts 落盘路径（7.4 闭环接落地时据 validation.valid 决定）。
      if (validation.blockingIssues.length > 0) {
        logger.warn(
          { episodeId, blockingCount: validation.blockingIssues.length, codes: validation.blockingIssues.map((i) => i.code) },
          'write_chapter: Director atomicEditProposals 展开后引入图约束违规（blocking）——不落盘，待 Director 重提议/art_override/人审',
        );
      }
    }
  }

  // ═─ Story 2.6 决策登记段（重大创作分叉留痕，register 语义）──
  // Director 输出 storyDecisions JSON（第 5 段），parse 强制 source='director' + 既有 id 过滤（idempotent，
  // mirror CR-inforelease-steer-4 幻觉 filter）。落盘双档统一走 story_decisions_update handler（mirror
  // atomicEdit 落盘模式）：auto 档 autoApply=true 直落 novel.story_decisions；non-auto 档 handler 产
  // field_patch envelope 返 caller → write_chapter metadata.storyDecisionsPatch → PatchReview 人审。
  // 决策无链段内 in-memory 消费者（影响下一章 brief #8 via 磁盘），故不注 initialArtifacts。
  const existingDecisionIds = new Set(
    ((initialArtifacts['story_decisions'] as { id?: unknown }[] | undefined) ?? [])
      .filter((d) => d && typeof d === 'object' && typeof d.id === 'string')
      .map((d) => d.id as string),
  );
  const directorDecisions = parseDirectorStoryDecisions(directorContent, existingDecisionIds);
  let storyDecisionPatch: unknown = null;
  // decisionNote：非 envelope 路径的决策 surface（readonly 档文字建议 / 守卫拒告知，CR-E01/E04）。
  let decisionNote: string | null = null;
  if (directorDecisions.length > 0) {
    // readonly 档（R6，mirror story-sync readonly 降级）：只文字呈现，不调工具不 stage envelope——
    // 此处是程序化 execute（绕过 toolPolicy readonly 门），若照走 suggest 会产永不兑现的「工作台
    // 审阅」承诺（UI readonly 档 drop field_patch envelope，CR-E04）。
    const permissionMode = getSession(ctx.sessionId)?.permissionMode ?? 'suggest';
    if (permissionMode === 'readonly') {
      const summaries = directorDecisions.map((d) => `${d.id}（${d.status}）：${d.summary}`).join('；');
      decisionNote = `导演建议登记 ${directorDecisions.length} 条创作决策（readonly 档只呈现不落盘）：${summaries}`;
      logger.info(
        { episodeId, decisionCount: directorDecisions.length },
        'write_chapter: Director storyDecisions readonly 档 → 文字建议（不调工具不 stage）',
      );
    } else {
      const tool = registry.get('story_decisions_update');
      if (tool) {
        try {
          const res = await tool.execute(
            {
              actions: directorDecisions.map((decision) => ({ op: 'register' as const, decision })),
              autoApply: autoApplyFlag,
            },
            { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort },
          );
          const meta = res.metadata as { applied?: boolean; type?: string; field?: string } | undefined;
          if (autoApplyFlag && meta?.applied === true) {
            logger.info(
              { episodeId, decisionCount: directorDecisions.length },
              'write_chapter: Director storyDecisions auto 落盘（novel.story_decisions）',
            );
          } else if (!autoApplyFlag && meta?.type === 'field_patch') {
            storyDecisionPatch = meta; // non-auto：envelope 供 caller surface PatchReview 人审
          } else {
            // 守卫拒 / auto 落盘失败 = handler 正常返回非 throw（metadata 无 type/applied，CR-E01）——
            // 不留无观察静默吞：log + decisionNote surface 告知（决策 vanishing 无痕迹是反留痕目标本身）。
            logger.warn(
              { episodeId, output: res.output },
              'write_chapter: Director storyDecisions 登记被拒（guard / 落盘失败）',
            );
            decisionNote = `导演创作决策登记未落盘：${res.output}`;
          }
        } catch (err) {
          // handler 失败（守卫拒 / IPC 失败）→ warn 不破 chain（决策是留痕增强非硬约束，mirror graceful）。
          logger.warn(
            { autoApply: autoApplyFlag, err: err instanceof Error ? err.message : String(err) },
            'write_chapter: story_decisions_update handler 调用失败 → graceful skip Director decision 登记',
          );
          decisionNote = '导演创作决策登记未落盘（handler 调用失败，详见日志）';
        }
      } else {
        logger.warn({ episodeId }, 'write_chapter: story_decisions_update 未注册 → graceful skip Director decision 登记');
      }
    }
  }

  // 三段皆空（Director 全文无操控无情绪无结构编辑 / parse 失败）→ 返 null（caller 据 null 不 surface field_patch）。
  if (
    mergedMap === null && mergedCurve === null && emotionOutput.emotionTarget === undefined &&
    atomicEdits === null && storyDecisionPatch === null && decisionNote === null
  ) {
    return null;
  }
  return { infoReleaseMap: mergedMap, emotionCurve: mergedCurve, atomicEdits, storyDecisionPatch, decisionNote };
}

/**
 * Story 7.3：Director atomic-edit dispatch 结果（validated expansion，供工作台可见 + 7.4 落地消费）。
 * - proposals：过滤幻觉 sceneRef 后的有效提议（AtomicEditProposal[]）。
 * - sceneGraphActions / promiseActions：展开成既有 bounded actions（喂既有 handler 落地的输入）。
 * - validation：validateAtomicEditOps 结果（valid=false 时 blockingIssues 非空，不落盘）。
 *
 * 落地（apply 到 project.yaml）defer 7.4（prose 重生成闭环）；7.3 只产 validated expansion。
 */
interface DirectorAtomicEditResult {
  proposals: AtomicEditProposal[];
  sceneGraphActions: import('@orison/shared-contracts').SceneGraphAction[];
  promiseActions: import('@orison/shared-contracts').PromiseAction[];
  validation: import('@orison/shared-contracts').AtomicEditValidation;
}

/**
 * Story 7.4 Step 3+4：Director atomic-edit apply 落盘 + scene_graph 刷新（design §3.1 落盘 + §3.2 时序耦合）。
 *
 * directorAtomicEdits（7.3 validated expansion）→ leader 调度 scene_graph_update + promise_ledger_update
 * handler 落盘。**D8 mode-conditional**（mirror 6.5 emergence / 6.3 DW-4）：auto mode（permissionMode='auto'）
 * → handler autoApply=true 直接 onFieldEdited(source:'agent') 落盘（version bump）；non-auto mode → handler
 * autoApply=false 产 field_patch envelope 供 write_chapter output metadata 携带（PatchReview 人审）。
 *
 * **落盘后刷新 initialArtifacts['scene_graph']**（design §3.2 关键耦合）：assemble 时取的旧 graph 须刷新，
 * 否则 draft-writer（selectScenesForEpisode）/ brief-compiler（compileSceneStateAtT）消费旧 graph → 单轮闭环
 * 失败（落盘了 graph 但 prose 反映旧结构）。🔑 **只 auto mode 刷新**（non-auto patch 未 accept，draft-writer
 * 用旧 graph，patch 经人审 accept 后下轮 redo 才消费新 graph——mirror "non-auto 未 accept → 不刷新"）。
 *
 * 范式判据（ADR-3）：handler 落盘 / onFieldEdited / applySceneGraphActions = 纯代码机械；"哪个 issue 用哪个
 * op" 归 Director LLM（7.3）。blocking 校验归 caller gate（validation.valid）；本 helper 落盘失败 graceful
 * warn 不破 chain（atomic-edit 是增强非硬约束，mirror 6.6 world-state 增强哲学）。
 *
 * @returns sceneGraphRefreshed（新 graph 供 caller 刷新 initialArtifacts；null=未落盘/non-auto/失败）+
 *          sceneGraphPatch / promisePatch（non-auto field_patch envelope 供 metadata；null=auto mode/未产）。
 */
async function applyDirectorAtomicEdits(
  directorAtomicEdits: DirectorAtomicEditResult,
  autoApply: boolean,
  ctx: ToolContext,
): Promise<{
  sceneGraphRefreshed: SceneGraph | null;
  sceneGraphPatch: unknown;
  promisePatch: unknown;
}> {
  const outcome: { sceneGraphRefreshed: SceneGraph | null; sceneGraphPatch: unknown; promisePatch: unknown } = {
    sceneGraphRefreshed: null,
    sceneGraphPatch: null,
    promisePatch: null,
  };
  const toolCtx = { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort };

  // scene_graph actions 非空 → 调 scene_graph_update handler（7.4 加 autoApply 双模式，mirror DW-4）。
  if (directorAtomicEdits.sceneGraphActions.length > 0) {
    const tool = registry.get('scene_graph_update');
    if (tool) {
      try {
        const res = await tool.execute(
          { actions: directorAtomicEdits.sceneGraphActions, autoApply },
          toolCtx,
        );
        const meta = res.metadata as
          | { applied?: boolean; data?: SceneGraph; type?: string; field?: string; action?: string }
          | undefined;
        if (autoApply && meta?.applied === true && meta.data) {
          // auto mode：handler 直接落盘 → data 是 projected graph，供 caller 刷新 initialArtifacts 单轮闭环。
          outcome.sceneGraphRefreshed = meta.data;
        } else if (!autoApply && meta?.type === 'field_patch') {
          // non-auto mode：handler 产 field_patch envelope → 供 write_chapter output metadata 携带（PatchReview 人审）。
          outcome.sceneGraphPatch = meta;
        }
      } catch (err) {
        // handler 调用失败（IPC / project 未注册 / onFieldEdited throw 已被 handler 内部 catch）→ warn 不破 chain。
        logger.warn(
          { autoApply, err: err instanceof Error ? err.message : String(err) },
          'write_chapter: scene_graph_update handler 调用失败 → graceful skip atomic-edit scene_graph apply',
        );
      }
    }
  }

  // promise actions 非空 → 调 promise_ledger_update handler（6.5 已建 autoApply 双模式，emergence 用）。
  if (directorAtomicEdits.promiseActions.length > 0) {
    const tool = registry.get('promise_ledger_update');
    if (tool) {
      try {
        const res = await tool.execute(
          { actions: directorAtomicEdits.promiseActions, autoApply },
          toolCtx,
        );
        const meta = res.metadata as
          | { applied?: boolean; type?: string; field?: string; action?: string; data?: unknown }
          | undefined;
        if (!autoApply && meta?.type === 'field_patch') {
          // non-auto mode：field_patch envelope 供 metadata（PatchReview 人审）。
          outcome.promisePatch = meta;
        }
        // auto mode：handler 直接落盘 promise_registry（meta.applied===true）。promise_registry 不需刷新
        // initialArtifacts（draft-writer 不直读 promise_registry artifact；brief-compiler #7 已 assemble 进
        // chapter_brief，本次 run 不重跑 brief-compiler 的 #7 消费——promise 落盘为下章 ledger 读服务）。
      } catch (err) {
        logger.warn(
          { autoApply, err: err instanceof Error ? err.message : String(err) },
          'write_chapter: promise_ledger_update handler 调用失败 → graceful skip atomic-edit promise apply',
        );
      }
    }
  }

  return outcome;
}

/**
 * Story 7.4 §1.6：环 B 结构编辑触发的 prose 重生成注入的 minimal revision_intent（structuralEdit=true）。
 *
 * atomic-edit 落盘 + scene_graph 刷新后，draft-writer 消费新 graph 单轮重写正文。注入 revision_intent 带
 * structuralEdit=true 作 revision-guard §1.6 放行码数据通道（段落级结构改稿时 L2 放行故意结构改动）。
 *
 * 🔑 **零回归**：此 intent 无 scope.anchor（整章重写非段落精修）→ draft-writer formatRevisionIntent skip
 * （不灌改稿指令段，走正常整章路径）+ revision-guard 整章路径 skip（无 before/after 可比）。flag 仅作数据
 * 通道标记 + 为 Step 5 段落级结构 auto_revise 预留（届时带 scope.anchor，L2 真跑放行码）。
 */
function buildStructuralEditIntent(): RevisionIntent {
  return {
    change: { summary: '结构编辑（Director atomic-edit）后按新场景图重新生成正文' },
    lockedItems: [],
    rationale: {
      source: 'audit-finding',
      note: 'Director 据上章 cross-chapter 审核提议原子编辑，落盘后刷新 scene_graph 触发正文重生成',
    },
    provenance: {
      rawUserInstruction: '(Director 自动提议的结构编辑，非用户直选)',
      compilerNote: 'structuralEdit: scene_graph 已更新（atomic-edit 落盘），正文按新结构生成',
    },
    structuralEdit: true,
  };
}

// ── Story 7.4 Step 6：isomorphic-git 版本节点（ADR-8 回退 + FR-293 traceability，design §4.1 + §4.2）──
//
// 修订落地后复用 git_commit tool（builtin.ts:521 既有 + gitCommitHandler）建版本节点。落地点两处：
//   环 A：leader redo 循环内 revision-guard clean splice 落定后（段落级保义改稿）。
//   环 B：atomic-edit apply 落盘 + scene_graph 刷新后（结构编辑）。
//
// **不每节点 commit**（chat-fatigue + git 历史噪音）——只在「修订落定」的 2 个点 commit。**首写（无修订）
// 不 commit**（既有行为，零回归——write_chapter / chain 现不 commit）。
//
// **revision_guard findings 不入 feedback_ledger**（design §4.2）：feedback_ledger 是 cross-chapter Director
// 反馈专用；revision_guard findings 是本章护栏结果（Director 不读它做下章规划）。FR-293 精神由 git message
// （drift/findings 摘要可查回溯）+ 链段 artifact revision_guard（完整 findings 可检视）满足。完整 RevisionPass/Fix
// 记录表归不存在的 13.5——7.4 不建表。
//
// 经 registry.get('git_commit')（mirror feedback_ledger_read / scene_graph_update 调用模式，agent 不直连 git/fs，
// 守 module-boundaries）。graceful：git_commit 未注册/调用失败/无 working tree 变更 → warn/skip 不破 chain
// （git 版本节点是 traceability 增强非硬约束，mirror 6.6 world-state 增强哲学）。
//
// 范式判据（ADR-3）：git commit 调度/message 拼接 = 纯代码机械；不判语义。

/**
 * 修订落地后建 git 版本节点（design §4.1）。
 *
 * 先经 git_status 查 working tree 有无变更——无变更 skip（防空 commit 噪音，design「不每节点 commit」+
 * 「chat-fatigue」哲学；环 A redo splice 纯 in-memory 时自然 skip）。有变更 → git_commit 建 version node。
 *
 * graceful：git_commit/git_status 未注册（测试环境 registry 空）或调用失败 → warn/skip 不破 chain。
 */
async function commitRevisionNode(message: string, ctx: ToolContext): Promise<void> {
  const gitCommit = registry.get('git_commit');
  if (!gitCommit) {
    // 测试环境 registry 空 / 未 registerBuiltinTools → graceful skip（mirror fetchPrevEpisodeFeedback）。
    return;
  }
  // 防空 commit 噪音：先查 working tree 有无变更，无则 skip。
  // 环 A redo splice 纯 in-memory（chain artifact 无 disk 写）→ 环 A 落地点 count=0 自然 skip；
  // 环 B atomic-edit 落盘（scene_graph persisted）→ count>0 commit。Director autoApply 持久化的 info/emotion
  // 变更也在 working tree → 环 A 落地点若 Director 落了盘也会 commit（cumulative write_chapter 变更）。
  const gitStatus = registry.get('git_status');
  if (gitStatus) {
    try {
      const statusRes = await gitStatus.execute(
        {},
        { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort },
      );
      const count = (statusRes.metadata as { count?: unknown } | undefined)?.count;
      if (typeof count !== 'number' || count === 0) {
        // 无 working tree 变更 → skip 空 commit。
        return;
      }
    } catch {
      // git_status 失败 → 不阻断 commit（可能 status 工具问题但 commit 可用），fall through 试 commit。
    }
  }
  try {
    await gitCommit.execute(
      { message },
      { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort },
    );
    logger.info({ message }, 'write_chapter: revision version node committed (ADR-8 回退 + FR-293 traceability)');
  } catch (err) {
    // git_commit 失败（无 git repo / IPC 失败 / 空仓库）→ warn 不破 chain（traceability 增强非硬约束）。
    logger.warn(
      { message, err: err instanceof Error ? err.message : String(err) },
      'write_chapter: git_commit 失败 → graceful skip revision version node',
    );
  }
}

/**
 * 构建修订版本节点 message（design §4.1 + §4.2 FR-293 精神）。
 *
 * 格式：`revision: <类型> (<触发源>)` + 可选 findings 摘要（drift/findings 可查回溯）。
 * - 现存触发源 = 结构编辑（Director-atomic-edit，环 B 落盘点）；「段落级保义改稿 (auto_revise)」变体
 *   随 leader redo 编排段退役（09-13 W1a）——修订落定的版本节点收口随新链落盘拆两步（F1a/F1b）归
 *   后续波次，届时按需复用。
 * - revision_guard 6 类 drift findings 留链段 artifact 可检视，**不入 message 也不入 feedback_ledger**。
 *
 * 纯代码机械拼接（范式判据 ✓）。findings 数量 cap（5 条）防 message 过长。
 */
function buildRevisionCommitMessage(
  type: '段落级保义改稿' | '结构编辑',
  trigger: 'auto_revise' | 'Director-atomic-edit',
  findings?: ReadonlyArray<{ severity?: string; quote?: string; explanation?: string }>,
): string {
  const lines = [`revision: ${type} (${trigger})`];
  if (findings && findings.length > 0) {
    lines.push('');
    lines.push('Reader-Audit findings（触发本次修订）:');
    for (const f of findings.slice(0, 5)) {
      const sev = f.severity ?? '?';
      const quote = f.quote ?? '';
      const expl = f.explanation ?? '';
      lines.push(`  · [${sev}] "${quote}" — ${expl}`);
    }
    if (findings.length > 5) {
      lines.push(`  · ... 及另外 ${findings.length - 5} 条`);
    }
  }
  return lines.join('\n');
}

/**
 * Story 7.3：检查 proposal 引用的 sceneId 是否锚既有场景（本章场景集 ∪ 既有 graph nodes）。
 * 纯代码机械（mirror CR-inforelease-steer-4 hallucinated-sceneRef filter），非语义判断。
 * 锚不定的 proposal（LLM 幻觉不存在的 sceneId）→ 丢（免 expand 出 dangling edge 落盘污染图）。
 */
function proposalAnchorsExistingScene(proposal: AtomicEditProposal, sceneIds: Set<string>): boolean {
  const op = proposal.op;
  switch (op.op) {
    case 'add_plot_bridge':
      return sceneIds.has(op.between.fromSceneId) && sceneIds.has(op.between.toSceneId);
    case 'add_suspense':
      // atSceneId + resolveTowardsSceneId 须锚既有；suspenseScene 是新钩子场（允许不在既有集，expand 后加进图）。
      return sceneIds.has(op.atSceneId) && sceneIds.has(op.resolveTowardsSceneId);
    case 'add_foreshadow':
      return sceneIds.has(op.plantBeatSceneId) && sceneIds.has(op.payoffBeatSceneId);
    case 'insert_twist':
      return sceneIds.has(op.afterSceneId) && op.rewireEdgesTo.every((id) => sceneIds.has(id));
    case 'revise_event':
      return sceneIds.has(op.sceneId);
  }
}

/**
 * 构建场景结构摘要串供 Director chapterScenes var（Story 6.3）。
 *
 * 纯代码机械投影（范式判据 ✓）——把 SceneNode 的结构描述字段（storyTimeLabel/storyTime/role/outcomeType/
 * pacingRole）拼成可读摘要。Director 拿场景 id 查 query_cognition_graph 取 perspective 状态，摘要只供
 * 识别场与理解其结构功能（无正文——SceneNode 无 prose 字段）。
 *
 * mirror selectScenesForEpisode 的结构面投影哲学（不 dump 全量，只取写作结构子集）。
 */
function summarizeSceneForDirector(n: SceneNode): string {
  const parts: string[] = [];
  if (n.storyTimeLabel) {
    parts.push(n.storyTimeLabel);
  } else {
    parts.push(`storyTime=${n.storyTime}`);
  }
  if (n.role && n.role !== 'normal') parts.push(n.role);
  if (n.outcomeType) parts.push(`outcome=${n.outcomeType}`);
  if (n.pacingRole) parts.push(`pacing=${n.pacingRole}`);
  return parts.join('；');
}

/**
 * Story 4.4：构建 project_theme artifact（ProjectThemeInput）供 completeness-verify-node L1 候选汇编消费。
 *
 * 纯代码机械汇编（非语义判断）：合并 declaredThemes（project.meta.theme + creative_brief.theme 去重）+
 * themeMappings（asset_cards type='visual_motif' 的 themeMapping 表/中/深收集）。completeness-verify-node
 * collectThemeCandidates 消费此 + scene_graph.lines[].themeRef 做 L1 主题候选汇编。
 *
 * graceful：缺 creative_brief / 缺 asset_cards / 无 visual_motif 卡 / themeMapping 字段全空 → declaredThemes
 * + themeMappings 均空。两源均空时返 null（不注入 artifact，L1 降级空候选，theme 类跳过，零回归）。
 *
 * 范式判据（ADR-3）：字符串去重 + 字段提取 = 纯代码；主题挣得裁判归 L2 LLM。
 *
 * @param project  loaded ChapterChainProjectInput（含 creative_brief / asset_cards / project_theme 字段）。
 * @returns        ProjectThemeInput 或 null（两源全空时）。
 */
function buildProjectTheme(project: ChapterChainProjectInput): ProjectThemeInput | null {
  // declaredThemes 合并去重：meta.theme (project.project_theme) + creative_brief.theme。
  const declaredThemesSet = new Set<string>();
  if (typeof project.project_theme === 'string' && project.project_theme.trim().length > 0) {
    declaredThemesSet.add(project.project_theme.trim());
  }
  const briefTheme = project.creative_brief?.theme;
  if (typeof briefTheme === 'string' && briefTheme.trim().length > 0) {
    declaredThemesSet.add(briefTheme.trim());
  }
  const declaredThemes = Array.from(declaredThemesSet);

  // themeMappings：asset_cards type='visual_motif' 的 themeMapping 表/中/深收集。
  // 宽容坏条目（非对象 / 缺 id / themeMapping 全空 跳过），mirror extractCharacterCards 哲学。
  const themeMappings: ProjectThemeInput['themeMappings'] = [];
  if (Array.isArray(project.asset_cards)) {
    for (const card of project.asset_cards) {
      if (!card || typeof card !== 'object') continue;
      const c = card as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        themeMapping?: unknown;
      };
      if (c.type !== 'visual_motif') continue;
      if (typeof c.id !== 'string' || c.id.length === 0) continue;
      // themeMapping 形态：{surface?, middle?, deep?}（全 optional/nullish，CR-002 nullish 容错）。
      let tm: { surface?: string; middle?: string; deep?: string } | null = null;
      if (c.themeMapping && typeof c.themeMapping === 'object' && !Array.isArray(c.themeMapping)) {
        const rawTm = c.themeMapping as Record<string, unknown>;
        const surface = typeof rawTm.surface === 'string' ? rawTm.surface.trim() : '';
        const middle = typeof rawTm.middle === 'string' ? rawTm.middle.trim() : '';
        const deep = typeof rawTm.deep === 'string' ? rawTm.deep.trim() : '';
        if (surface || middle || deep) {
          tm = {};
          if (surface) tm.surface = surface;
          if (middle) tm.middle = middle;
          if (deep) tm.deep = deep;
        }
      }
      if (tm) {
        themeMappings.push({
          cardId: c.id,
          cardName: typeof c.name === 'string' ? c.name : c.id,
          ...tm,
        });
      }
    }
  }

  if (declaredThemes.length === 0 && themeMappings.length === 0) return null;
  return { declaredThemes, themeMappings };
}

/**
 * 把 Director 产的 per-scene directives 合入 InfoReleaseMap（pure function，Story 6.3）。
 *
 * merge 策略（design §6 merge precedence 的数据源侧）：
 * - 既有 entry（同 sceneRef）→ 补 directive（spread 保留 id + episodeId + reveal/withhold/dramaticIrony/notes，
 *   仅覆写 directive 字段）。
 * - 新场（无既有 entry）→ 追加 {id:`director:<sceneRef>`, sceneRef, episodeId, directive}。
 *
 * 范式判据（ADR-3）：by-sceneRef 结构合并 = 纯代码机械（非语义裁判）。brief #3 的 leader-vs-Director
 * merge precedence 在 brief-compiler compileInfoRelease（R1）处理——本函数只产 InfoReleaseMap entries 数据源。
 *
 * version/updatedBy 不变（R2 in-memory，未落盘；落盘时 R3 handler 管 version bump）。
 */
function mergeDirectorEntries(
  map: InfoReleaseMap,
  parsed: DirectorInfoReleaseEntry[],
  episodeId: string,
): InfoReleaseMap {
  if (parsed.length === 0) return map;
  const entries = [...map.entries];
  for (const { sceneRef, directive } of parsed) {
    const existingIdx = entries.findIndex((e) => e.sceneRef === sceneRef);
    if (existingIdx >= 0) {
      // 既有 entry：保留 id + reveal/withhold/dramaticIrony/notes，仅覆写 directive。
      entries[existingIdx] = { ...entries[existingIdx], directive };
    } else {
      // 新场：追加 entry（id 前缀 `director:` 标识 Director 产，避免与手写/既有 id 碰撞）。
      entries.push({
        id: `director:${sceneRef}`,
        sceneRef,
        episodeId,
        directive,
      });
    }
  }
  return { ...map, entries };
}

/**
 * 把 Director 产的 per-scene emotion points 合入 EmotionCurve（pure function，Story 5.2，mirror mergeDirectorEntries）。
 *
 * merge 策略（design §3.5 merge precedence 的数据源侧）：
 * - 既有 point（同 refId）→ 覆写（Director 刷新该场情绪目标，spread 保留 refId）。
 * - 新场（无既有 point）→ 追加。
 *
 * 范式判据（ADR-3）：by-refId 结构合并 = 纯代码机械（非语义裁判）。brief #10 的 leader-vs-Director emotionTarget
 * merge precedence 在 brief-compiler compileEmotionTarget 处理——本函数只产 emotion_curve.points[] 数据源。
 * unit/emotional_promises/catharsis_points 透传不动（mirror mergeDirectorEntries version/updatedBy 不变）。
 *
 * @param curve   既有 EmotionCurve（assembled default 或 project.yaml 既有）。
 * @param parsed  Director 产的合法 emotion points（parseDirectorEmotion 后 + 幻觉 refId filter 后）。
 * @returns       合入后的 EmotionCurve（points by-refId 覆写/追加）。
 */
function mergeDirectorEmotionPoints(curve: EmotionCurve, parsed: EmotionPoint[]): EmotionCurve {
  if (parsed.length === 0) return curve;
  const points = [...curve.points];
  for (const point of parsed) {
    const existingIdx = points.findIndex((p) => p.refId === point.refId);
    if (existingIdx >= 0) {
      // 既有 point：Director 刷新该场情绪目标，覆写。
      points[existingIdx] = point;
    } else {
      // 新场：追加。
      points.push(point);
    }
  }
  return { ...curve, points };
}

/**
 * Story 2.2 WP-D（design §4 gate 消费）：needs_world_anchor 拦截消息的设定覆盖缺口附注。
 *
 * 同一 `findSettingCoverageGaps` 单源（与 workflow.ts loadSettingCoverageForLeader leader 注入段共用，
 * design §4「单源」约束）——用 initialArtifacts 已 safeParse 的 sceneGraph（assemble 产，失败降级空图
 * → 本函数自然空附注）+ loadChainProjectInput 读的 project.asset_cards。过滤到本章 episode 涉及场：
 * 本章场集 = `isSceneInEpisode`（episodeId 直挂 + presentationSpans M:N，selectScenesForEpisode 同一
 * 判定器，单源 DRY）命中的 nodes；gap.sceneIds 命中任一本章场即算涉及。
 *
 * 只拼 dangling_ref（warning）——「本章场景引用的设定卡 X 不存在」是「缺什么」的具体化；scene_no_refs
 * 是 info 级弱结构信号（改 scene_graph_update 非设定债），不进 gate 消息。
 *
 * 范式判据（ADR-3）：纯代码 id 存在性检测 + episode 过滤（机械汇编进拦截文案）；不新增 gate 档位、
 * 不越权 block（prd R4：warning 附注，needs_world_anchor 本身已是阻断档）。
 *
 * @returns warning 附注串（无缺口/无本章涉及场 → ''，caller 拼接时零痕迹）。
 */
function formatChapterCoverageGaps(
  sceneGraph: SceneGraph | undefined,
  assetCards: ChapterChainProjectInput['asset_cards'],
  episodeId: string,
  episode: EpisodeOutline | undefined,
): string {
  // 本章场集（episode 直挂 + presentationSpans M:N）。可为空——dangling 部分随之空，
  // 集纲人物悬空不受场集空挡（21B：两个引用源独立）。
  const chapterSceneIds = new Set(
    (sceneGraph?.nodes ?? []).filter((n) => isSceneInEpisode(n, episodeId)).map((n) => n.id),
  );
  const gaps = chapterSceneIds.size > 0
    ? findSettingCoverageGaps(sceneGraph, assetCards).filter(
        (g) => g.kind === 'dangling_ref' && g.sceneIds.some((id) => chapterSceneIds.has(id)),
      )
    : [];
  // dogfood R2 #21B：集纲人物段悬空（character_progressions 声明的人物无卡——id 存在性，与
  // dangling_ref 同型的第二引用源）随同附注。无 progressions / 全有卡 → 零行。
  const unanchored = findUnanchoredCharacterProgressions(episode, assetCards)
    .map((id) => `· 本章集纲为人物「${id}」排了进展，但没有对应角色卡——建基础卡或修引用（asset_cards_update）。`);
  if (gaps.length === 0 && unanchored.length === 0) return '';
  // CR-08-16-109：条数上限 mirror loadSettingCoverageForLeader 的 top-5 + 总数截断（Edge-002 幻影
  // 回归教训同源）——空卡库 + 大量 assetRefs 的结构会把拦截消息撑到无界。
  const GAP_LINE_CAP = 5;
  const shown = gaps.slice(0, GAP_LINE_CAP).map((g) => `· ${g.message}`);
  if (gaps.length > GAP_LINE_CAP) shown.push(`· ……等共 ${gaps.length} 条缺口（此处列前 ${GAP_LINE_CAP} 条）`);
  return `\n本章设定缺口（warning 附注）：\n${[...shown, ...unanchored].join('\n')}`;
}

// ── Story 2.2 WP-E（design §5.5.2）：story-sync 反哺 applier（链流程重排 W3 收尾时序适配）──
//
// 链上 story-sync-agent 节点（E9，提取段——对终稿一次提取）产的 story.sync patches 经
// summarizeRunSnapshot deliverable 豁免透传（summary.storySync）——此处收尾转出：
// - **收尾时序 = E 段完成后**（链流程重排 W3：提取后移 E9，summary 到达本入口层时提取已发生——
//   patches 天然针对最终接受的正文，旧「route 终态 gate」前提〔auto_revise 中间轮重提取〕随环内
//   收敛 + E9 单次执行消失）；paused 不收尾（escalate-pause 时 E9 未跑 patches 恒空；stage pause
//   resume 经 IPC 车道，非本 tool 职域）。
// - **档位映射**（R6，KD1 复用 permissionMode 同源推导——与 Director autoApplyFlag 同一 session 信号）：
//   auto → story_sync_apply(autoApply=true) 直落；suggest → envelope 组挂 metadata.storySyncPatches
//   走 PatchReview 人审；readonly → 只文字呈现（R6）。**escalate 档「随裁决材料」路径已退役**
//   （W3：裁决在终稿前、E9 在裁决 accept 续跑后——decision='escalate_user' 且链 completed 即裁决已
//   采信，反哺按正常档位分流，与 accept 同路）。
// - **patch 条数 cap**（上限 8，mirror 3.5 成本 cap）：超 cap 强制转 envelope 人审并注明原因——
//   auto 直落批量上限的机械兜底。
// - 转译层在 shell handler（storySyncHandlers：asset_cards → update_card/add_card 浅合并 mirror
//   assetCardsHandlers；其他 field → 对象 merge + per-field schema 校验；fieldVersion 乐观锁 + locked 永拒
//   由 onFieldEdited / applyFieldPatchesWithSkipped 既有机制执行，非此处重复实现）。
// - graceful（mirror retrieval D4 / world-state 增强哲学）：工具未注册（测试 registry 空）/ 调用失败 →
//   文案告知不假 pass 不崩 tool；空 patches 零痕迹（不添行不挂 metadata）。

/** story-sync 反哺单次收尾的 auto 直落上限（超限强制转 envelope 人审，mirror 3.5 成本 cap）。 */
export const STORY_SYNC_REVIEW_CAP = 8;

/**
 * 章节出处 label（CR-08-16-010）：chapterId 形如 'ch_1'/'ep1'（非纯数字）——「第 N 章」模板会产
 * 「第 ch_1 章」畸形文案并经 onFieldEdited reason 持久化进 sync event。纯数字 → 「第 N 章」；
 * 非数字 id 原样保留（「章节 ch_1」）；空 → 「本章」。resume IPC 消费侧（closureChainIpc）同源引用。
 */
export function formatStorySyncChapterLabel(label: string): string {
  if (/^\d+$/.test(label)) return `第 ${label} 章`;
  if (label.length > 0) return `章节 ${label}`;
  return '本章';
}

/** applier 结果（additive；null = 零痕迹——无 patches / 非终态 / paused）。 */
interface StorySyncOutcome {
  /** suggest / 超 cap 强制人审档：投影 envelope 组（挂 metadata.storySyncPatches → UI PatchReview）。 */
  patches?: Array<{ type: 'field_patch'; field: string; action: string; data: unknown; fieldVersion?: number; note?: string }>;
  /** leader 文案行（auto 落盘结果 / readonly 文字建议 / 降级告知）。 */
  lines: string[];
}

/**
 * story-sync 反哺收尾（收尾时序 = E9 提取段完成后，见上方块注释）。纯机械调度（范式判据 ADR-3：
 * 提取/落盘语义已归链段 LLM + shell handler 机械门，此处只判终态/档位/上限）。
 */
async function applyStorySyncFeedback(args: {
  summary: RunSnapshotSummary;
  ctx: ToolContext;
  permissionMode: 'readonly' | 'suggest' | 'auto';
  chapterId: string | undefined;
  isPaused: boolean;
}): Promise<StorySyncOutcome | null> {
  const { summary, ctx, permissionMode, chapterId, isPaused } = args;
  const patches = summary.storySync?.patches;
  // 空 patches 零痕迹（不添行不挂 metadata——空提取是常态非事件）。
  if (!patches || patches.length === 0) return null;
  // paused 不收尾（escalate-pause 时 E9 未跑、patches 恒空——此守卫防御 mock/旧路径；stage pause
  // resume 经 IPC 路径续跑，非本 tool 职域）。
  if (isPaused) return null;
  const decision = summary.routeDecision?.decision;
  // 只在终态收尾：accept_as_truth / escalate_user（链流程重排后者的链 completed 形态 = 裁决已采信
  // 续跑完成——E9 对裁决后终稿提取，反哺按正常档位分流，W3 退役「随裁决材料」路径）。
  // 非 accept/escalate 的只有 auto_revise 中间轮（链内回环，summary 不会以此态到达）/ 缺省。
  if (decision !== 'accept_as_truth' && decision !== 'escalate_user') return null;

  const label = chapterId ?? (summary.storySync?.chapterId || '');
  const note = `${formatStorySyncChapterLabel(label)} story-sync 提取`;
  const fieldList = [...new Set(patches.map((p) => p.field))].join(', ');

  // readonly 档（R6）：只文字建议，不调工具不 stage。
  if (permissionMode === 'readonly') {
    return {
      lines: [
        '',
        `正文反哺（只读模式，仅建议）：本章提取 ${patches.length} 条设定补丁（${fieldList}）——切到建议/全权档后可落地。`,
      ],
    };
  }

  const tool = registry.get('story_sync_apply');
  if (!tool) {
    // 工具未注册（测试 registry 空 / 未 registerBuiltinTools）→ 不静默丢（永不静默数据丢失），文案告知。
    logger.warn(
      { patchCount: patches.length },
      'write_chapter: story_sync_apply tool not registered → story-sync patches surfaced as text only',
    );
    return {
      lines: ['', `正文反哺：本章提取 ${patches.length} 条设定补丁（${fieldList}），但落盘工具暂不可用——补丁未呈现，可重跑本章回收。`],
    };
  }

  const overCap = patches.length > STORY_SYNC_REVIEW_CAP;
  const autoApply = permissionMode === 'auto' && !overCap;
  try {
    const res = await tool.execute(
      {
        runId: summary.storySync?.runId ?? 'story-sync',
        patches,
        ...(autoApply ? { autoApply: true } : {}),
        chapterNote: note,
      },
      { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort },
    );
    const meta = res.metadata as
      | { applied?: boolean; appliedFields?: string[]; patches?: StorySyncOutcome['patches']; skipped?: Array<{ field: string; reason: string }> }
      | undefined;
    const skippedNote =
      meta?.skipped && meta.skipped.length > 0
        ? `（拒 ${meta.skipped.length} 条：${meta.skipped.map((s) => s.field).join(', ')}）`
        : '';

    if (meta?.applied === true) {
      // auto 档直落（route=accept_as_truth 语义背书 + shell 机械门）。note = 章节出处（AC5——
      // envelope note 不进 FieldPatchEntry schema，落盘侧经 onFieldEdited reason 持久化出处）。
      const fields = meta.appliedFields?.join(', ') ?? '';
      return {
        lines: ['', `正文反哺（${note}）：${meta.appliedFields?.length ?? 0} 个设定字段已自动落盘（${fields || '无'}，source='agent'）${skippedNote}。`],
      };
    }

    const envelopes = Array.isArray(meta?.patches) ? meta!.patches! : [];
    if (!envelopes || envelopes.length === 0) {
      return {
        lines: ['', `正文反哺（${note}）：${patches.length} 条补丁在投影中全部被拒${skippedNote}——未落盘（补丁与当前字段不可合并/版本过期）。`],
      };
    }
    // suggest 档 / 超 cap 强制人审档：envelope 组挂 metadata → PatchReview。行首带章节出处（AC5：
    // FieldPatchEntry 无 note 字段，PatchReview 卡面不显出处——出处锚定在本行 + envelope.note + 落盘 sync event）。
    return {
      patches: envelopes,
      lines: [
        '',
        `正文反哺（${note}）：本章提取的设定变更已生成 ${envelopes.length} 个字段补丁（${envelopes.map((e) => e.field).join(', ')}）` +
          `${overCap ? `——超单次上限 ${STORY_SYNC_REVIEW_CAP} 条，已强制转人工审阅` : ''}${skippedNote}，等待你在工作台审阅后落盘。`,
      ],
    };
  } catch (err) {
    // 调用失败 → graceful：不假 pass、不崩 tool（反哺是增强非硬约束，mirror Director graceful）。
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), patchCount: patches.length },
      'write_chapter: story_sync_apply failed → graceful text-only surface',
    );
    return {
      lines: ['', `正文反哺：${patches.length} 条设定补丁（${fieldList}）转出失败——本章反哺未落地，可重跑本章回收。`],
    };
  }
}

// ── Story 8.4 Step 4（A7/A8，design §1.7）：出发核查挂起的 leader 呈现 + 批量挂起标记 ──
//
// 挂起（verify_exhausted / research_contradiction）经链段 pause（全档位含 auto——结构性矛盾不带病开写）
// 到达 write_chapter（summary.researchSuspension，deliverable 豁免 context isolation）。本工具职责：
// ① 文案呈现挂起明细 + 建议动作（leader 可读——核实的语义归人，机械证据在此机械投影，mirror
// escalateFindings 呈现哲学）；② chapter_review metadata（resumeOptions 不含 continue——挂起无正文可续，
// continue 会跳过 draft-writer 撞下游 DAG blocked，恢复只有 redo）；③ 批量模式挂起章标
// suspendedSceneIds（机械记账纯代码，batch 继续他章，prd A5）。
//
// 范式判据（ADR-3）：明细投影/批量标记 = 纯代码机械；矛盾真伪核实 + 决断 = leader LLM + 用户。

/** 挂起明细文案（矛盾/偏离或缺漏清单——机械投影，mirror suspension 明细格式）。 */
function formatResearchSuspensionDetail(suspension: ResearchSuspension): string[] {
  const lines: string[] = [];
  if (suspension.kind === 'verify_exhausted') {
    lines.push(`本章出发核查 ${suspension.rounds} 轮仍未通过（verify_exhausted）——写手在动笔前的调查简报始终有缺漏未清空，本章挂起：`);
    for (const g of suspension.gaps ?? []) {
      lines.push(`  · 缺漏：${g.desc}（补查线索：${g.source_hint}）`);
    }
    if ((suspension.gaps ?? []).length === 0) {
      // CR-004：pass=false ⇒ gaps 非空已由 schema refine 钉死——verify_exhausted 载荷恒携末轮非空清单，
      // 空 gaps 是防御性兜底形态（正常不可输），用中性措辞不指认任何具体失败原因（防误导排查方向）。
      lines.push('  ·（挂起载荷未附缺漏清单——防御性兜底形态，正常路径不应出现）');
    }
  } else {
    lines.push('本章动笔前自查发现任务卡与资料矛盾 / 写前偏离（research_contradiction）——结构性问题不带病开写，本章挂起，须作者决断：');
    for (const i of suspension.evidence?.contradictions ?? []) {
      lines.push(`  · 矛盾：${i.desc}`);
    }
    for (const d of suspension.evidence?.deviations ?? []) {
      lines.push(`  · 偏离：${d.scene_ref}——计划 ${d.plan_says} / 写手拟 ${d.brief_says}（${d.reason}）`);
    }
    if (
      (suspension.evidence?.contradictions ?? []).length === 0 &&
      (suspension.evidence?.deviations ?? []).length === 0
    ) {
      lines.push('  ·（证据清单为空——核查器升级判定，见日志）');
    }
  }
  return lines;
}

/**
 * 批量模式挂起章标记（deliverable 4，prd A5「挂起该章继续他章」）：活跃批量存在且本章在批量
 * chapterMap 内 → 该章全部场并入 suspendedSceneIds（机械记账，不靠 LLM 自觉；batch_status 据此把
 * 挂起场剔出待推进 + 呈报）。幂等（已标不重复写）；CR-008 upsert 拒写（batches.json 不可读）→ graceful
 * warn 不破 tool result（挂起呈现照常，批量标记缺失可 batch_status 对账补）。
 */
async function markSuspendedChapterInBatch(
  ctx: ToolContext,
  chapterId: string | undefined,
  suspension: ResearchSuspension,
): Promise<string[]> {
  if (!chapterId) return []; // 无 chapterId（非批量直调形态）→ 无从对章，零标记（挂起呈现照常）。
  const active = findActiveBatchRun(ctx.projectPath, ctx.sessionId);
  if (!active) return [];
  const scenes = Object.entries(active.chapterMap)
    .filter(([, ch]) => ch === chapterId)
    .map(([sceneId]) => sceneId);
  if (scenes.length === 0) return []; // 本章不在批量内（单章直写）→ 零标记。
  const existing = new Set(active.suspendedSceneIds ?? []);
  if (scenes.every((s) => existing.has(s))) return []; // 幂等：已标不重复写。
  try {
    upsertBatchRun(ctx.projectPath, {
      ...active,
      suspendedSceneIds: [...existing, ...scenes.filter((s) => !existing.has(s))],
      updatedAt: Date.now(),
    });
  } catch (err) {
    logger.warn(
      { chapterId, err: err instanceof Error ? err.message : String(err) },
      'write_chapter: batch suspension mark failed → graceful skip（batch_status 对账仍可见挂起章未推进）',
    );
    return [];
  }
  return [
    `批量标记：本章 ${scenes.length} 场已标挂起（${suspension.kind === 'research_contradiction' ? '矛盾/偏离' : '核查未过'}）——批量继续其他章，作者决断后重写本章。`,
  ];
}

// ── 链流程重排 W2（R4 / hardEscalate 处置矩阵）：auto 档挂起跳章 + 同章连续挂起计数 ──
//
// auto 档安全自决（prd R4 拍板，翻 8.4 全档位暂停）：单次 researchSuspension → **跳章+标记**（终止链
// 释放租约 + markSuspendedChapterInBatch 复用 + 上报——批量 suspendedSceneIds 机械记账，单章场景 =
// 终止即终态）；suggest/readonly 维持暂停叫人（8.4 原语义，现状零变化）。
//
// **同章连续挂起 ≥2**（design §3「强难 = 收敛失败机械信号」）：跨 write_chapter 调用计数（内存
// module-level Map，key=`${sessionId}:${episodeId}`——挂起跳章 +1 / 该章成功落地清零）。≥2 时按
// hardEscalatePolicy 分流：'ask'（缺省）→ 不再跳章，暂停叫人（快照保留，人决断）；'auto'（真全自动）
// → 终弃+标记上报（mirror cap 超限终弃形态）。计数是 best-effort 内存态（进程重启归零——重跑计数
// 保守偏低，安全向）。测试隔离：__resetSuspensionStreaks 清表。
//
// CR-15（09-13）：计数条目带 lastAt 时间戳 + 24h 衰减窗——「连续」按时间邻接判：上次挂起距今超
// 24h 的条目视为过期清零后再计（防跨月旧计数把新一次挂起直接顶到 hard-stop/终弃）。终弃
// （abandonChapterForHardStop）时 clearSuspensionStreak——终弃已把问题上报作者，重跑须从满额
// 计数重启（否则重跑首次挂起即再 hard-stop/终弃，章永久不可写）。
interface SuspensionStreakEntry {
  count: number;
  /** 最近一次挂起时间戳（Date.now()）——24h 衰减窗判据。 */
  lastAt: number;
}

/** 挂起「连续」语义的时间邻接窗：上次挂起距今超此时长 → 计数过期清零（CR-15）。 */
const SUSPENSION_STREAK_DECAY_MS = 24 * 60 * 60 * 1000;

const suspensionStreaks = new Map<string, SuspensionStreakEntry>();

/** 测试 helper：清挂起连续计数（module 状态隔离）。 */
export function __resetSuspensionStreaks(): void {
  suspensionStreaks.clear();
}

/**
 * 测试 helper：注入挂起连续计数（CR-15 测试面——衰减窗 / 终弃清零 / 文案分派用例的 seeding；
 * lastAtAgeMs 缺省 0 = 刚发生）。生产代码不调。
 */
export function __seedSuspensionStreak(sessionId: string, episodeId: string, count: number, lastAtAgeMs = 0): void {
  suspensionStreaks.set(`${sessionId}:${episodeId}`, { count, lastAt: Date.now() - lastAtAgeMs });
}

/** 挂起连续计数查询（含测试观察面）；衰减感知——过期条目惰性清零后返 0（CR-15）。 */
export function peekSuspensionStreak(sessionId: string, episodeId: string): number {
  return readSuspensionStreak(sessionId, episodeId);
}

/** 衰减感知读：过期（上次挂起 > 24h）→ 清条目返 0（「连续」按时间邻接判，跨天旧挂起不算）。 */
function readSuspensionStreak(sessionId: string, episodeId: string, now = Date.now()): number {
  const key = `${sessionId}:${episodeId}`;
  const entry = suspensionStreaks.get(key);
  if (!entry) return 0;
  if (now - entry.lastAt > SUSPENSION_STREAK_DECAY_MS) {
    suspensionStreaks.delete(key);
    return 0;
  }
  return entry.count;
}

function bumpSuspensionStreak(sessionId: string, episodeId: string): number {
  const key = `${sessionId}:${episodeId}`;
  const next = readSuspensionStreak(sessionId, episodeId) + 1; // 衰减感知：过期先归零再 +1
  suspensionStreaks.set(key, { count: next, lastAt: Date.now() });
  return next;
}

/** 该章成功落地（或人决断重跑）→ 连续计数清零（「连续」语义：成功即断链）。 */
function clearSuspensionStreak(sessionId: string, episodeId: string): void {
  suspensionStreaks.delete(`${sessionId}:${episodeId}`);
}

/**
 * 终弃该章（hardEscalate='auto' 收敛失败处置：去味门禁未过的 cap 超限 / 连续矛盾≥2）：
 * 不产 chapter_accept + 清链快照（释放租约）+ 批量挂起标记（复用 suspendedSceneIds 机械记账）+ 上报文案。
 * 返回 leader 呈现行（机械投影，永不静默——无孤儿发现红线）。
 *
 * CR-15：终弃时 clearSuspensionStreak——终弃已把问题完整上报作者，作者改卡/改设定后重跑须从满额
 * 计数重启（终弃前 streak 常已 ≥2，不清则重跑首次挂起即再 hard-stop/终弃，章永久不可写）。
 */
async function abandonChapterForHardStop(args: {
  ctx: ToolContext;
  chapterId: string | undefined;
  episodeId: string;
  reason: string;
}): Promise<string[]> {
  const { ctx, chapterId, episodeId, reason } = args;
  ctx.skillExecutor?.clearChainSnapshot?.(ctx.sessionId);
  clearSuspensionStreak(ctx.sessionId, episodeId);
  const active = findActiveBatchRun(ctx.projectPath, ctx.sessionId);
  if (chapterId && active) {
    const scenes = Object.entries(active.chapterMap)
      .filter(([, ch]) => ch === chapterId)
      .map(([sceneId]) => sceneId)
      .filter((s) => !(active.suspendedSceneIds ?? []).includes(s));
    if (scenes.length > 0) {
      try {
        upsertBatchRun(ctx.projectPath, {
          ...active,
          suspendedSceneIds: [...(active.suspendedSceneIds ?? []), ...scenes],
          updatedAt: Date.now(),
        });
      } catch (err) {
        logger.warn(
          { chapterId, err: err instanceof Error ? err.message : String(err) },
          'write_chapter: batch abandon mark failed → graceful skip（batch_status 对账仍可见）',
        );
      }
    }
  }
  return [
    '',
    `【本章已终弃】${reason}——按真全自动档（强难停点关）的安全处置：未落盘、无章节候选。作者过目决断后可重跑该章（调整任务卡或切回强难停点开档让系统停下叫人）。`,
  ];
}

export const writeChapterTool = defineTool({
  id: 'write_chapter',
  description:
    '为指定 episode 触发写章战术链段（subgraph）：brief 编译 → draft-writer 生成初稿 → 自审环链内收敛' +
    '（审读 → route 判 auto_revise/accept_as_truth/escalate_user，环内改稿不假人手）→ 终态（accept 候选 / ' +
    '灰区 escalate-pause 裁决）。链段只回 RunSnapshot 摘要（标题/字数/verdict/route_decision）。' +
    'scene_graph/设定/promise_registry 从 project.yaml 自动读取；chapterBrief 传本章 LLM 段（目标/参数/信息控制/节奏/禁写/情绪目标）。',
  parameters: writeChapterParams,
  async execute(params, ctx) {
    if (!ctx.skillExecutor?.runChapterChain) {
      return {
        title: `write_chapter: ${params.episodeId}`,
        output: 'Chapter chain dispatch is unavailable in this context (no runtime bound).',
      };
    }

    const project = await loadChainProjectInput(ctx.projectPath);
    if (!project) {
      return {
        title: `write_chapter: ${params.episodeId}`,
        output: `Cannot start chapter chain: project.yaml at ${ctx.projectPath} is missing or unreadable.`,
      };
    }

    // 4.1 §3.2 运行时 gate：跑链段前算 brief readiness，non-ready 阻断 + 返「缺什么」给 leader（不跑链段）。
    // 用 initialArtifacts（assemble 已 safeParse scene_graph + 渲染 settings_context）直接算——不跑全链段，
    // computeReadiness 纯函数独立可调（design §3.2 / implement.md Step 1）。settingsPresent = settings_context
    // 渲染串非空（与 brief-compiler-node 运行时判定同信号，单源一致）。
    //
    // 先 assemble（raw leader brief）——settings_context / scene_graph 是 gate 信号源。
    const initialArtifacts = assembleChapterChainArtifacts(
      project,
      params.episodeId,
      params.chapterBrief as ChapterBrief | undefined,
    );

    // **BMad CR P1（Blind+Edge medium）**：gate 在子 agent 派发（Director 等）**之前**——它们是多步 LLM
    // 调用，non-ready brief 时 gate 阻断会把派发结果整个弃掉，白烧算力。computeReadiness 只看
    // scene_graph / settings / goal / episode 匹配，故 gate-first 与派发无序耦合——先 gate 安全。
    // 两入口（agent tool + IPC）一致用 raw leaderBrief 算 gate（trellis-check #1）。
    const sceneGraph = initialArtifacts['scene_graph'] as SceneGraph | undefined;
    const settingsContext = initialArtifacts['settings_context'];
    const settingsPresent = typeof settingsContext === 'string' && settingsContext.trim().length > 0;
    const rawLeaderBrief = (params.chapterBrief as ChapterBrief | undefined) ?? {};
    const readiness = computeReadiness(rawLeaderBrief, sceneGraph, params.episodeId, settingsPresent);
    try {
      assertBriefReady({ ...rawLeaderBrief, readiness });
    } catch (err) {
      if (err instanceof BriefNotReadyError) {
        // Story 2.2 WP-D（design §4 gate 消费）：needs_world_anchor 的「缺什么」从「设定全空」升级为
        // 具体缺卡——同一 findSettingCoverageGaps 单源（leader coverage 注入段共用），过滤到本章
        // episode 涉及场，dangling_ref 作 warning 附注（不新增 gate 档位、不越权 block）。leader 引导段
        // （workflow.ts 设定深化能力段 §6 gate 补救路由）教 leader 据此提议补卡后重跑。
        // needs_plot/needs_world_context/needs_chapter_brief 分支不动。
        // dogfood R2 #21B：附注扩含集纲人物悬空（findUnanchoredCharacterProgressions 单源）。
        const gateEpisode = project.episode_outlines?.find((e) => e.id === params.episodeId);
        const coverageNote = err.readiness === 'needs_world_anchor'
          ? formatChapterCoverageGaps(sceneGraph, project.asset_cards, params.episodeId, gateEpisode)
          : '';
        return {
          title: `write_chapter: ${params.episodeId}`,
          output: `Brief 未就绪，无法开始写章（${err.readiness}）：${err.missing}${coverageNote}`,
        };
      }
      throw err;
    }

    // Story 6.3（design §3 段① / D1 / implement.md Step 5）：**gate 过后、assemble 之后**派 Director 子 agent →
    // per-scene 产 ManipulationDirective → merge 进 initialArtifacts['info_release_map']（in-memory）。Director 读
    // CognitionGraph perspective 状态（query_cognition_graph 三视角 gap，conclusions §3.6/3.7）+ brief 意图 + 既有
    // InfoReleaseMap → 决定本场透露/隐瞒什么（语义创作判断归 LLM）→ directive 合入 InfoReleaseMap。
    //
    // brief-compiler compileInfoRelease（R1 已接通）读 initialArtifacts['info_release_map'] → 编译 brief #3
    // （mode→字段纯代码映射 + leader 已填字段优先 merge）+ manipulationDirectives[]（供 Reader-Audit L2 forbiddenMoves
    // 裁判）。**R2 = in-memory steer ONLY**——Director directive 经 vars 回传合入 initialArtifacts（非持久化）；
    // 持久化落 project.yaml（info_release_map_update autoApply handler）= R3 Step 7（DW-4）。
    //
    // graceful 降级（mirror retrieval D4）：Director 是增强非硬约束——任何失败（agent 抛错 / parse 失败 / 方法缺失 /
    // 超时 / abort）→ InfoReleaseMap 保持 assembled 原样，链段照跑。不上发、不抛（Director 缺则 brief #3 无人补，
    // Writer 照写——leader 仍可手填 #3 / 工作台手 authoring InfoReleaseMap）。
    //
    // 工具受限（硬约束）：allowedTools=['query_cognition','query_cognition_graph','info_release_map_update']
    // ——Director 读 perspective 状态（query_cognition/graph）+ 持久化 directives 到 InfoReleaseMap creative field
    // （info_release_map_update，autoApply=true，R3 Step 7b DW-4 自动 authoring）。无其他写工具 / spawn_agent / skill
    // （info_release_map_update 是 Director 唯一写工具，bounded action 限 creative field；mirror retrieval/adjudicator 收窄）。
    // 不进 CONTRACTS[]（子 agent）。
    //
    // **BMad CR P1 同 retrieval**：Director 在 gate 之后（gate-first 防白烧 Director 算力，non-ready brief 不派），
    // 且在 assemble 之后（initialArtifacts['info_release_map'] + scene_graph 存在，Director 读 entries + 场景列表）
    // + runChapterChain 之前（brief-compiler 见 Director 合入的 directives）。mirror retrieval post-assemble 时序。
    //
    // CR-inforelease-steer-6（BMad CR / D8 mode-conditional autoApply）：autoApplyFlag 从 leader session.permissionMode
    // 推（KD1 复用 permissionMode 不加旋钮，mirror deriveCheckpointPolicy）。auto mode -> Director 自动落盘
    // （autoApply=true，DW-4）；non-auto mode（suggest/readonly）-> Director 不调写工具，write_chapter 转
    // field_patch 人审 PatchReview（direction-first 人审，D8 拒绝「全 autoApply」）。返 mergedMap 供 execute
    // 决定是否 surface field_patch（见下 metadata 构造处）。
    const directorPermissionMode = getSession(ctx.sessionId)?.permissionMode ?? 'suggest';
    const directorAutoApplyFlag = directorPermissionMode === 'auto';
    const directorResult = await dispatchDirectorAndAuthorInfoRelease(
      params.episodeId,
      params.chapterBrief as ChapterBrief | undefined,
      initialArtifacts,
      ctx,
      directorAutoApplyFlag,
      project.episode_outlines,
    );
    // dispatch 返 {infoReleaseMap, emotionCurve, atomicEdits}（Story 7.3 加 atomic-edit 段）；null = Director 不可用/全失败。
    // auto mode Director 已持久化 via tools；non-auto mode 转 field_patch 人审（见下 metadata 构造处）。
    const directorMergedMap = directorResult?.infoReleaseMap ?? null;
    const directorEmotionCurve = directorResult?.emotionCurve ?? null;
    const directorAtomicEdits = directorResult?.atomicEdits ?? null;
    // Story 2.6：Director 决策登记段 non-auto envelope（auto 档 handler 已直落，无 patch 可 surface）。
    const directorStoryDecisionPatch = directorResult?.storyDecisionPatch ?? null;
    // 2.6 CR-E01/E04：决策非 envelope 路径 surface（readonly 档文字建议 / 守卫拒/失败告知）。
    const directorDecisionNote = directorResult?.decisionNote ?? null;
    // Story 7.4 Step 3+4：Director 产 validated atomicEditProposals → leader 调度 scene_graph_update +
    // promise_ledger_update handler 落盘（D8 mode-conditional）+ 刷新 initialArtifacts['scene_graph']（design §3.2
    // 时序耦合）+ 注入 structuralEdit revision_intent（§1.6 放行码数据通道）。non-auto mode 产 field_patch
    // envelope（pendingSceneGraphPatch / pendingPromisePatch）供下方 metadata 携带 PatchReview 人审。
    let pendingSceneGraphPatch: unknown = null;
    let pendingPromisePatch: unknown = null;
    if (directorAtomicEdits) {
      if (directorAtomicEdits.validation.valid) {
        const applyResult = await applyDirectorAtomicEdits(directorAtomicEdits, directorAutoApplyFlag, ctx);
        if (applyResult.sceneGraphRefreshed) {
          // design §3.2 关键耦合：落盘后刷新 initialArtifacts['scene_graph'] → draft-writer（selectScenesForEpisode）
          // + brief-compiler（compileSceneStateAtT）消费新 graph → 单轮闭环 prose 反映结构变更。只 auto mode 刷新
          // （non-auto patch 未 accept，draft-writer 用旧 graph，patch 人审 accept 后下轮 redo 才消费新 graph）。
          initialArtifacts['scene_graph'] = applyResult.sceneGraphRefreshed;
          // 环 B structuralEdit 标记注入：atomic-edit 落盘 + scene_graph 刷新触发 prose 重生成 → 注入 revision_intent
          // 带 structuralEdit=true（revision-guard §1.6 放行码数据通道）。🔑 零回归：无 scope.anchor → draft-writer
          // formatRevisionIntent skip（不灌改稿指令）+ revision-guard 整章路径 skip（无 before/after）。flag 为
          // Step 5 段落级结构 auto_revise 预留（届时带 scope.anchor，L2 真跑放行码）。
          initialArtifacts['revision_intent'] = buildStructuralEditIntent();
          logger.info(
            { episodeId: params.episodeId, sceneCount: applyResult.sceneGraphRefreshed.nodes.length, proposalCount: directorAtomicEdits.proposals.length },
            'write_chapter: Director atomicEdit 落盘 + scene_graph 刷新 + structuralEdit revision_intent 注入（单轮闭环 prose 将反映结构变更）',
          );
          // Story 7.4 Step 6 环 B：atomic-edit 落盘 + scene_graph 刷新后建 git 版本节点（ADR-8 回退 + FR-293）。
          // commitRevisionNode 内 git_status 守卫确认 working tree 有变更（scene_graph persisted）才 commit。
          await commitRevisionNode(
            buildRevisionCommitMessage('结构编辑', 'Director-atomic-edit'),
            ctx,
          );
        } else {
          logger.info(
            { episodeId: params.episodeId, proposalCount: directorAtomicEdits.proposals.length, autoMode: directorAutoApplyFlag },
            directorAutoApplyFlag
              ? 'write_chapter: Director atomicEditProposals 落盘调用未返 applied（handler 未注册/落盘失败）→ graceful skip'
              : 'write_chapter: Director atomicEditProposals non-auto mode → field_patch 待 PatchReview 人审',
          );
        }
        // non-auto mode field_patch envelope 收集（供下方 write_chapter output metadata 携带，PatchReview 人审）。
        pendingSceneGraphPatch = applyResult.sceneGraphPatch;
        pendingPromisePatch = applyResult.promisePatch;
      } else {
        // blocking validation（7.3 CR-003 保障 issueKey 含 severity）→ 不落盘（7.3 已 warn，不改）。
        logger.warn(
          { episodeId: params.episodeId, blockingCount: directorAtomicEdits.validation.blockingIssues.length, codes: directorAtomicEdits.validation.blockingIssues.map((i) => i.code) },
          'write_chapter: Director atomicEditProposals 含 blocking 违规 → 不落盘（待 Director 重提议/art_override/人审）',
        );
      }
    }

    // ── 风格卡片 MVP（task 08-28-style-card-mvp B 路，R5/D7 注入面矩阵）：settings/style.md 存在 →
    // 产 `style_context` artifact（mirror world_state_snapshot post-assemble optional 注入模式）：
    // ①-⑫ 节全量（⑫ 禁则 CR-003 纳入）+ ⑬ fenced 节选（cap 2000 常量，D2）——draft-writer /
    // writer-selfcheck 消费（chapter-nodes buildDraftWriterVars `{{styleContext}}`
    // slot；selfcheck 复用同一稳定前缀天然同供，writer-node.ts 两阶段同一 buildVars 单源）。
    // **不产 style_context_brief**（CR-006）：精简版的真实消费路径是 dispatch-planners **派发时
    // 现读 settings/style.md 现编**（executePlannerDispatch 内 readStyleCardBody → buildStyleBrief →
    // vars.styleBrief）——规划派发不走链段，链内放该 artifact 只会零消费（此前注入即此误）。
    // **无卡零 artifact**（readStyleCardBody ENOENT/空白 → undefined，不注入任何 key——AC3 零回归：
    // 无卡项目 initialArtifacts 与旧版逐字节一致）；不设就绪门（风格卡纯增益不阻塞，needs_* 阶梯不动）。
    // 提取/截断纯函数单源在 style-card.ts（本目录邻近，implement.md「可独立测试、不开新包」）。
    // shell IPC 路径（closureChainIpc）同口径注入 style_context（CR-026：经 agent 包导出的
    // readStyleCardBody + buildStyleContext 同一对单源函数，有卡才注入、无卡零 key）。
    // 范式判据（ADR-3）：文件读取 + 节定位 + 截断 = 纯代码机械；「挑哪段做节选」归 A 路分析者 LLM。
    const styleCardBody = await readStyleCardBody(ctx.projectPath);
    if (styleCardBody) {
      const styleContext = buildStyleContext(styleCardBody);
      if (styleContext) initialArtifacts['style_context'] = styleContext;
    }

    // Story 6.6 Phase D：world_state_snapshot 一致基底注入（Reader-Audit 一致性维对照已建立状态找矛盾）。
    // gate 后取 snapshot（gate 阻断时不浪费 IPC）：fetchWorldStateSnapshotViaTool 经 query_world_slice
    // builtin 取前章 events → buildWorldStateSnapshot reduce。**chain 启动前捕获**——此时 closure_world_state
    // 仅含前章 events（本章提取器在 draft 后跑），故 snapshot 自然反映「已建立状态」基底（无本章 draft 循环
    // 自证）。graceful（fetch 失败/无数据/工具未注册 → undefined → 不注入 artifact；Reader-Audit buildPrompt
    // 读 run.artifacts['world_state_snapshot'] ?? '' 降级空段，照现有 artifact 缺失处理）。mirror Director
    // post-assemble 注入 initialArtifacts 模式。
    const worldStateSnapshot = await fetchWorldStateSnapshotViaTool(ctx.projectPath);
    if (worldStateSnapshot) {
      initialArtifacts['world_state_snapshot'] = worldStateSnapshot;
    }

    // Story 6.2：cognition_snapshot 注入（Reader-Audit 认知状态机维数据源，mirror world_state_snapshot caller 注入）。
    // gate 后取 snapshot（gate 阻断时不浪费 IPC）：fetchCognitionSnapshotViaTool 复用 fetchWorldPatchesViaTool 取
    // 全集 patches → buildCognitionSnapshot 纯代码投影（filter cognitive + per-character reduceSubject + projectBeliefStatus）。
    // **chain 启动前捕获**——此时 closure_world_state 仅含前章 events（本章认知提取器在 draft 后跑），故 snapshot 自然
    // 反映「截至本章前的角色认知状态」（前章累积 believes_true 等），L2 对照本章 draft 判 FORGOTTEN_REVEAL（前章已知 vs
    // 本章写不知）无循环自证（mirror snapshot 基底逻辑）。graceful（fetch 失败/无 cognitive patches/工具未注册 →
    // undefined → 不注入 artifact；Reader-Audit buildPrompt 读 run.artifacts['cognition_snapshot'] ?? '' 降级空段，
    // 照现有 artifact 缺失处理）。mirror world_state_snapshot post-assemble 注入 initialArtifacts 模式。
    const cognitionSnapshot = await fetchCognitionSnapshotViaTool(ctx.projectPath);
    if (cognitionSnapshot) {
      initialArtifacts['cognition_snapshot'] = cognitionSnapshot;
    }

    // Story 6.4 D1（6.2 DW-1）：presence_signal 注入（Reader-Audit info-gap 在场性预筛数据源，mirror cognition_snapshot）。
    // fetchPresenceSignalViaTool 复用 fetchWorldPatchesViaTool 取全集 patches → buildPresenceSignal（filter cognitive
    // evidenceSceneId + reduce physical presence_scene → 比对）。graceful：无 evidenceSceneId cognitive/无 physical
    // presence/失败 → undefined（不注入，info-gap 降级纯语义判路径，零回归）。mirror cognition_snapshot optional 哲学。
    const presenceSignal = await fetchPresenceSignalViaTool(ctx.projectPath);
    if (presenceSignal) {
      initialArtifacts['presence_signal'] = presenceSignal;
    }

    // Story 5.3：asset_cards 注入（emotion-verify-node 角色层 setpoint τ 消费源，emotionElasticity）。
    // post-assemble optional 注入（mirror world_state_snapshot/cognition_snapshot/presence_signal 模式）——assemble
    // 只把 asset_cards 编进 settings_context 渲染串（draft-writer {{projectContext}} 消费），未直注 artifact；
    // emotion-verify-node 需直读 character 卡 personality.emotionElasticity（computeSetpoint τ 映射），故补注。
    // source = loadChainProjectInput 已读的 project.asset_cards（raw array，未经 safeParse；extractCharacterCards
    // 内部逐条守性 type='character' + id + personality 形态，坏条目跳过不抛）。graceful：缺/非数组 → 不注入 →
    // emotion-verify-node extractCharacterCards 返空 → runEmotionVerify computeSetpoint 全用默认 τ（design §10）。
    // ⚠ shell IPC 路径（closureChainIpc）未注此项（R2 范围 agent-only）→ IPC 路径 emotion-verify 用默认 τ，零回归。
    if (Array.isArray(project.asset_cards)) {
      initialArtifacts['asset_cards'] = project.asset_cards;
    }

    // Story 4.4：growth_curve + project_theme 注入（completeness-verify-node L1 候选汇编数据源，design §4）。
    // post-assemble optional 注入（mirror asset_cards / world_state_snapshot 模式）——assemble 不处理这两字段
    // （4.4 节点需直读 raw），故 write_chapter post-assemble 补注。graceful：缺/坏 → 不注入 → completeness-verify
    // L1 降级空候选（arc/theme 类跳过），零回归（design §8）。
    //
    // growth_curve：project.yaml 顶层 raw（loadChainProjectInput 已读，形态多样：单条/array/Record<id,curve>）。
    // completeness-verify-node readGrowthCurves 守卫归一为 GrowthCurve[]（arc-coverage.ts 单源，L1 候选汇编用）。
    if (project.growth_curve !== undefined) {
      initialArtifacts['growth_curve'] = project.growth_curve;
    }
    // project_theme：buildProjectTheme 从 project.creative_brief.theme + project.project_theme（meta.theme）
    // + asset_cards visual_motif themeMapping 合成 ProjectThemeInput（declaredThemes + themeMappings）。
    // 纯代码汇编（非语义判断），completeness-verify-node L1 collectThemeCandidates 消费。无 visual_motif / 无
    // creative_brief / 无 meta.theme → declaredThemes/themeMappings 均空（L1 降级空候选，theme 类跳过）。
    const projectTheme = buildProjectTheme(project);
    if (projectTheme) {
      initialArtifacts['project_theme'] = projectTheme;
    }

    // Story 8.2：outline_phases 注入（arc-emergence-node 卷弧候选——volume 弧 arcRef 对号 phase id；
    // mirror growth_curve caller-fetch 模式，assemble 不处理此字段）。graceful：缺 → 不注入 → 卷弧候选
    // 降级空（线弧/成长弧照常，节点内 graceful）。⚠ shell IPC 路径（closureChainIpc）未注此字段（agent-only
    // 消费面，mirror growth_curve/project_theme 哲学）→ IPC 路径卷弧声明降级，零回归。
    if (Array.isArray(project.outlinePhases)) {
      initialArtifacts['outline_phases'] = project.outlinePhases;
    }

    // Story 8.2 Req 4/AC6：arc_snapshot 注入（4.4 completeness-verify {{arcSnapshot}} var 源——最近卷弧
    // 摘要的 synopsis+支线段+遗留钩子紧凑投影，浅雷达的长程视野注入）。graceful：无卷摘要 / 工具未注册 /
    // 读失败 → 不注入 → 节点降级空串（4.4 照常 per-chapter 浅审，零回归）。mirror project_theme optional
    // 注入模式；chain 启动前捕获（本链段不产弧摘要——关口大审在 post-settle）。
    const arcSnapshot = await fetchLatestArcSnapshotProjection(ctx.projectPath);
    if (arcSnapshot) {
      initialArtifacts['arc_snapshot'] = arcSnapshot;
    }

    try {
      // 4.1 Step 4：onAccept 闭包——accept 分支产 chapter_accept artifact（不写盘）。闭包捕获 project 数据
      // （episode_outlines + novelChapters）做 chapterId 解析（buildChapterAccept）；chapterId 直传优先。
      // ctx.nowISO 由 workflow.ts runChapterChain 入口注入（onAccept signature 经 runChain threading）。
      // CR-4.1-08：闭包捕获 skipReason（no-draft/no-chapter/no-nowiso），accept 但 chapter_accept 缺省时
      // 据此出对应文案（非旧统一「章未注册」误导——no-draft 是 draft-writer 没写正文 ≠ 章未注册）。
      const episodeOutlines = project.episode_outlines;
      const novelChapters = project.novelChapters;
      const directChapterId = params.chapterId;
      let acceptSkipReason: ChapterAcceptSkipReason | undefined;
      // dogfood R2 #107 / R1.1c：no-chapter skip 发生时链段 runId 留档——入口层补产
      // chapter_accept（chapterId=自动建章 stem）的 runId 源（last_run_id / StoryDecision id
      // `accept-<runId>` 与正常路径同构）。只在 no-chapter 捕获（no-draft/no-nowiso 无候选可补）。
      let acceptSkipRunId: string | undefined;
      const onAccept = (snapshot: { runId: string; artifacts: Record<string, unknown> }, ctx: { nowISO: string }): ChapterAcceptResult => {
        const result = buildChapterAccept(snapshot, {
          nowISO: ctx.nowISO,
          episodeId: params.episodeId,
          ...(episodeOutlines ? { episodeOutlines } : {}),
          ...(novelChapters ? { novelChapters } : {}),
          ...(directChapterId ? { directChapterId } : {}),
        });
        if ('skipReason' in result) {
          acceptSkipReason = result.skipReason;
          if (result.skipReason === 'no-chapter') acceptSkipRunId = snapshot.runId;
        }
        return result;
      };

      // Story 4.3 Step 3（design §3.5 / §4 映射表）：mode 从 leader session.permissionMode 推（KD1 复用
      // permissionMode 不加新旋钮）。session 不在内存（异常）→ 兜底 'suggest'（半自动 draft pause，安全默认）。
      // mode.pauseStages 决定链段在哪些 checkpoint scheduled pause（auto=[] 连续跑 / suggest=[draft] /
      // readonly=[brief,draft,verdict]）。escalateMode 透传，Step 6 route=escalate 分支消费（auto-trust vs ask）。
      // dogfood R2 #107 / R1.1：permissionMode 单读复用——自动建章模式门（auto → direct 全文 /
      // suggest+readonly → review 骨架）与 shell persistChapterAcceptIfNeeded 的 persistMode 档位映射同源。
      const sessionPermissionMode = getSession(ctx.sessionId)?.permissionMode ?? 'suggest';
      const policy = deriveCheckpointPolicy(sessionPermissionMode);
      // dogfood T1 Stage 6（design §4）：链事件转发——ctx.emitChainEvent（streamMessage 装配的 sendEvent
      // 包装）透传给 runChapterChain（chain-delta / chain-node-done 同通道广播）。多次 run 调用共用
      //（首跑 + escalate 裁决 resume/redo 续跑——resume/redo 重跑同样要流）。缺省不开（零回归）。
      const emitChainEvent = ctx.emitChainEvent;
      // `let`：Story 4.3 Step 6 auto-trust revise 可能 redo 重跑后重新赋值（mirror redo，design §3.8）。
      let summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
        requirement: params.episodeId,
        abort: ctx.abort,
        onAccept,
        mode: policy,
        ...(emitChainEvent ? { emitChainEvent } : {}),
      });

      // BMad CR-T1-056 + dogfood R2 #105 缝①（R2.1）：per-project 活动链守卫拒绝分派（workflow.ts
      // runChapterChain 入口闸——同项目已有活动链：单轮并行双 write_chapter / 上一条链 paused 滞留期间
      // 新链）。机器可读前缀 mirror D4 project_run_active 语义（leader 据工具结果自察，下轮告知用户）。
      //
      // **#105 缝①修法（design §2.1）**：守卫本就放行「holder=自己 + resume 入口」（isResumeEntry）——
      // 此前拦死 leader 只因 write_chapter 重入从不带 resume 选项，与挂起指引「决断后重调 write_chapter」
      // 承诺脱节。现按持有者分派：
      // - 他 session 持有 → 维持 busy 早退（busy 无链产物——不进 auto_revise 循环与 post-settle，也
      //   **不发链哨兵**——另一条链的链卡/流不得被本次拒绝误终态化）。
      // - 自家租约（heldBy === ctx.sessionId，即本会话 paused 链滞留）→ 按分派规则转 resume/fresh：
      //   ① 链流程重排 W1a（W0-5）：快照停在已废弃的旧 stage 停点（draft/verdict，重排后档位映射退出）→
      //     clearChainSnapshot（释放租约）+ fresh 重跑 + 文案告知废弃（必须在 resume 分派前拦截——verdict
      //     快照带 chapter_accept 候选，不拦会机械走完绕过新终稿停点；draft 停旧稿另有章档案安全副本，
      //     重跑成本 = 自审环起不伤正文）。
      //   ② 本次带 chapterBrief 且与快照 chapter_brief_input.brief 有差异（stableStringify 比对）=
      //     指引①②「改了任务卡/改设定」语义 → clearChainSnapshot（abort 释放租约）+ 用本次已装配的
      //     initialArtifacts（含新 brief）fresh 重跑——briefHash 变 → writer-node cardChanged=true → 全量重查。
      //   ③ 无 brief / 无差异 / 拿不到快照 brief = 指引③「维持原案」默认语义 → resume:{fromSnapshot:true}
      //     裸 continue 重调（**不显式 redo**——挂起态由 workflow continue-belt 自动转 draft-writer 重查 +
      //     approvedDeviations 绑定（挂起无正文可续，重查重写是唯一合法继续形态）；普通 checkpoint pause
      //     带草稿续审（不动草稿的自然语义）；显式 redo 对 draft-pause 会丢草稿重写，语义错）。
      //   残留风险（design §6 权衡）：改设定但未改 brief 的暗变走 resume 拿旧 settings_context——指引
      //   文案已注明「改了设定请在重调时同步更新任务卡摘要」，不引入设定 diff 探测。
      let discardedLegacyPauseStage: string | null = null;
      if (summary.status === 'error' && (summary.errors ?? []).some((e) => e.startsWith(CHAIN_RUN_ACTIVE_ERROR_PREFIX))) {
        const heldBy = parseChainRunActiveHolder(summary.errors);
        if (heldBy !== ctx.sessionId) {
          return {
            title: `write_chapter: ${params.episodeId}`,
            output: [
              `status: ${summary.status}`,
              `errors: ${summary.errors.join('; ')}`,
              '',
              '本章未能开始：该项目已有一条活动写章链（正在运行或暂停待审阅）。请先等待其完成，或在工作台审阅面板继续/放弃该链后再重试本章。',
            ].join('\n'),
          };
        }

        // 自家租约 → 分派（快照经 ctx.skillExecutor seam 读，runtime 已实现 getChainSnapshot/
        // clearChainSnapshot；mock/旧 runtime 缺方法 → 拿不到快照 → 保守走 resume，维持原案默认语义）。
        const pausedSnapshot = ctx.skillExecutor.getChainSnapshot?.(ctx.sessionId);
        // W1a W0-5：旧 stage 停点废弃拦截（详上方块注释①）——在 resume 分派前。
        if (isDiscardedLegacyPause(pausedSnapshot)) {
          discardedLegacyPauseStage =
            LEGACY_PAUSE_STAGES_BY_NODE[typeof pausedSnapshot?.currentNodeId === 'string' ? pausedSnapshot.currentNodeId : ''] ?? null;
          ctx.skillExecutor.clearChainSnapshot?.(ctx.sessionId);
          logger.info(
            { sessionId: ctx.sessionId, episodeId: params.episodeId, stage: discardedLegacyPauseStage, currentNodeId: pausedSnapshot?.currentNodeId },
            'write_chapter: paused chain at retired legacy stage → snapshot discarded + fresh rerun（W0-5 迁移拦截）',
          );
        }
        const snapBrief = briefFromChapterBriefInput(pausedSnapshot);
        const nextBrief = params.chapterBrief as ChapterBrief | undefined;
        const briefChanged =
          nextBrief !== undefined &&
          snapBrief !== undefined &&
          stableStringify(nextBrief) !== stableStringify(snapBrief);
        if (discardedLegacyPauseStage !== null) {
          // 废弃拦截 → fresh 重跑（resume 车道不走——快照已清）；文案在 output 段统一告知。
        } else if (briefChanged) {
          ctx.skillExecutor.clearChainSnapshot?.(ctx.sessionId);
          logger.info(
            { sessionId: ctx.sessionId, episodeId: params.episodeId },
            'write_chapter: self-held paused chain + changed chapterBrief → abort snapshot + fresh rerun（改卡全量重查）',
          );
        } else {
          logger.info(
            { sessionId: ctx.sessionId, episodeId: params.episodeId, hasSnapshot: Boolean(pausedSnapshot) },
            'write_chapter: self-held paused chain + unchanged/no brief → resume continue（维持原案：belt 自动转重查 + approvedDeviations 绑定）',
          );
        }
        summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
          requirement: params.episodeId,
          abort: ctx.abort,
          onAccept,
          mode: policy,
          ...(briefChanged || discardedLegacyPauseStage !== null ? {} : { resume: { fromSnapshot: true } }),
          ...(emitChainEvent ? { emitChainEvent } : {}),
        });
        // 重试后仍 busy（防御性：理论上自家 resume/fresh 入口必放行，此为异常路径兜底）→ 早退 busy 文案。
        if (summary.status === 'error' && (summary.errors ?? []).some((e) => e.startsWith(CHAIN_RUN_ACTIVE_ERROR_PREFIX))) {
          return {
            title: `write_chapter: ${params.episodeId}`,
            output: [
              `status: ${summary.status}`,
              `errors: ${summary.errors.join('; ')}`,
              '',
              '本章未能开始：该项目已有一条活动写章链（正在运行或暂停待审阅）。请先等待其完成，或在工作台审阅面板继续/放弃该链后再重试本章。',
            ].join('\n'),
          };
        }
      }

      // ── 链流程重排（09-13 W1a）：auto_revise leader 驱动 redo 编排段退役（翻 7.4 候选④）──
      //
      // chainRunner loops 链内回环取代 break 交 leader——环体（新链 C1-C7 含意图编译 + 保义护栏）在链内
      // 收敛，leader 侧 AUTO_REVISE cap 编排 / revision-optimizer dispatch 一轮 / CR-004 splice 落盘收尾
      // 随之退役。环收敛后 route 终态直达本入口层：accept → chapter_accept 候选；escalate / cap 超限 →
      // escalate-pause（status='paused' + escalatePause 标记，R4b）。W0-4 核实：suggest 档旧
      // auto_revise_pending surface 无「不经 redo 的接受」路径（无结构化卡无候选），退役无数据面损失；
      // 修订落定的 git 版本节点收口随新链落盘拆两步（F1a/F1b）归后续波次。

      // ── 链流程重排（09-13 W1a，R4b）：escalate-pause 裁决 resume 分派（入口层裁决编排改造）──
      //
      // escalate_user 从「链终结 + 入口层裁决」改为链内暂停形态（chainRunner escalatePause 标记）——
      // 本段消费 escalate summary（escalate-pause 优先；completed+escalate 旧形态兼容）：派裁决器
      // （adjudicator agent 本体零触碰）→ 裁决结果驱动 resume 而非链后补处理：
      // - accept → escalate-pause 时 resume:{fromSnapshot} 续跑（旧链无剩节点即完成；新链续 D→E→F）；
      //   链已终态（completed+escalate）则只打透明文案（无 resume 可做）。
      // - revise → resume + redo（nodeId=draft-writer-agent 断 completed 前缀 → 环体到链尾重跑；
      //   feedback=裁决 analysis 注入 {{revisionFeedback}}；A1/A2 规划环节点保留 completed——人审反馈
      //   针对正文非任务卡，design §2 M3）。
      // - 未 opt-in / 裁决器 null（dispatch 缺/抛/parse 失败——W0-7：机械可判）→ **不假 pass**，呈
      //   findings + 裁决建议给 leader/用户裁决；resume 由用户决断驱动（接受=重调 write_chapter 即续跑
      //   收尾 / 改稿=工作台 redo 或告知意见）。
      // redo re-escalate 不再 auto-trust（autoTrustAction 已定不重入，防死循环）。
      //
      // CR-001 fix（2026-08-14）双机械门保留前置：① 仅会话 hands_off+trust=true 显式 opt-in 才采信
      // （smart/steer/balanced 及 hands_off+trust=false 一律上呈，裁决器建议仍呈 leader chat 但不自动执行）；
      // ② escalate findings 含 severity='block' 级 → 任何配置永不 auto-trust，必走上呈（硬违规不豁免，
      // 与 §4 硬性打断穿透纪律一致）。session 缺（getSession undefined）→ 兜底 smart（最保守——必须上呈）。
      // 范式判据（ADR-3 / creative-vs-mechanical）：resume 分派 / opt-in 判定 = 纯代码机械；
      // recommendation = LLM 语义判断（4.6 裁决器产，不改）；应用 recommendation = 机械执行 LLM 判定。
      const escalatePauseAtDispatch = summary.status === 'paused' && summary.escalatePause === true;
      const autoTrustSession = getSession(ctx.sessionId);
      const autoTrustGear = autoTrustSession?.participationGear ?? 'smart';
      const autoTrustTrust = autoTrustSession?.trustAdjudication ?? false;
      const hasBlockFinding = (summary.escalateFindings ?? []).some((f) => f.severity === 'block');
      // ── 链流程重排 W2（R4 / design §3 矩阵）：hardEscalatePolicy 子开关 + 强难（收敛失败）信号 ──
      //
      // 强难 = 收敛失败机械信号（纯代码判，范式判据友好）：环 cap 超限（errors 含 loop cap）/
      // 同章连续 researchSuspension ≥2（suspensionStreaks 跨调用计数）。裁决失败空输出（adjudication
      // null）在下方 auto-trust 分支内判（W0-7：dispatchAdjudicator 返 null 即机械信号）。
      //
      // 处置（**仅 auto 档消费**——hardEscalatePolicy 是 auto 档子开关，suggest/readonly escalate-pause
      // 恒上呈）：
      // - 'ask'（缺省，强难停点开）：强难 → 停下叫人（不 auto-trust、不派裁决器——链以 escalate-pause
      //   滞留，快照保留，人决断驱动 resume）。
      // - 'auto'（真全自动）：cap 超限两支——去味门禁未过（summary.lintUnresolved = 终轮 review 含
      //   L2 确认的 lint 来源条目，W3 真判决——判真伪归 multi-review L2，summarize 判源不判义）→
      //   **终弃该章**+标记上报（永不带病落盘红线）；已过 → **采信终稿**（resume 续跑落盘）+
      //   标「环未收敛」上报；连续矛盾 ≥2 → 终弃。**BLOCK 永不 auto-trust 机械门前置**（CR-001 既有
      //   门，两分支共用）：block findings 到达 → 任何配置走上呈。
      const hardEscalate = sessionPermissionMode === 'auto' ? (autoTrustSession?.hardEscalatePolicy ?? 'ask') : 'ask';
      // CR-8：capExhausted 精确匹配自审环 through 节点 id（route-agent）——规划环 cap
      // （brief-reviewer-node）走 planEscalate 路径（CR-2b），勿入本矩阵（旧 'loop cap' 子串
      // 匹配会把两环混同 → auto-resume/终弃文案错环）。
      const capExhausted = (summary.errors ?? []).some(isAuditLoopCapError);
      const planCapExhausted = (summary.errors ?? []).some(isPlanLoopCapError);
      const suspensionStreakAtDispatch = peekSuspensionStreak(ctx.sessionId, params.episodeId);
      const hardStopSignal = capExhausted || suspensionStreakAtDispatch >= 2;
      const autoTrustOptIn = autoTrustGear === 'hands_off' && autoTrustTrust && !hasBlockFinding;
      let autoTrustAction: 'accept' | 'revise' | null = null;
      let loopUnconvergedAccepted = false;
      let chapterAbandoned = false;
      let adjudication: AdjudicationSuggestion | null = null;
      // ── 链流程重排 CR-2b（R4b 补全）：规划环 escalate-pause 裁决编排 ──
      //
      // 规划环（brief-reviewer）灰区/cap 超限 → escalate-pause **无 routeDecision**（route-agent 未跑），
      // 上方 gate 只认 routeDecision==='escalate_user' → 裁决器不派发 / findings 不透传 / auto-trust
      // 不 resume / hardEscalate 矩阵不可达——真全自动档在规划环 pause 停摆。此处消费簇 1 的
      // planEscalate 载荷触发**同一套老裁决编排**（裁决器派发 / findings metadata / 引导行 /
      // auto-trust resume / hardEscalatePolicy 矩阵）；裁决材料 = planEscalate.findings（plan_review
      // 保留版——环判据/重编 hints 各自消费 plan_review artifact 不受影响）。redo 目标按 pauseKind
      // 分派（CR-2c）：规划环 revise 回 A1（brief-compiler-node），audit revise 回 draft-writer（上方）。
      // hard finding（plan_review 软硬划界的 hard 维）mirror CR-001 BLOCK 门：永不 auto-trust。
      const planEscalateAtDispatch = readPlanEscalate(summary);
      let planAdjudication: AdjudicationSuggestion | null = null;
      let planAutoTrustAction: 'accept' | 'revise' | null = null;
      let planUnconvergedAccepted = false;
      if (planEscalateAtDispatch && escalatePauseAtDispatch && summary.routeDecision?.decision !== 'escalate_user') {
        const planHardStop = planCapExhausted;
        const planHasHardFinding = planEscalateAtDispatch.findings.some((f) => f.severity === 'hard');
        if (planHardStop && hardEscalate === 'auto' && !planHasHardFinding) {
          // 真全自动：规划环 cap 耗尽不停摆——保守采信当前任务卡 resume 续跑（进 B 写稿）+
          // 「规划环未收敛」标记上报（终弃不适用于规划环：无正文可弃，任务卡两轮未收敛按
          // best-available 卡继续写 + 告知作者）。resume 失败 → degrade 上呈（不假 pass）。
          try {
            summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
              requirement: params.episodeId,
              abort: ctx.abort,
              onAccept,
              mode: policy,
              resume: { fromSnapshot: true },
              ...(emitChainEvent ? { emitChainEvent } : {}),
            });
            planUnconvergedAccepted = summary.status === 'completed';
            planAutoTrustAction = 'accept';
          } catch (resumeErr) {
            const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
            logger.warn({ err: resumeMsg }, 'write_chapter: hardEscalate=auto plan-cap conservative accept resume failed → degrade to escalate surface');
          }
        } else {
          // 其余规划灰区（普通灰区 / 强难+'ask' 停下叫人）——派裁决器供呈现参考（mirror audit 路）；
          // auto-trust 行为 gate 排除「强难+'ask'」（停下叫人）与 hard finding（BLOCK 同族门）。
          planAdjudication = await dispatchAdjudicator(
            { ...summary, escalateFindings: planEscalateAtDispatch.findings as unknown as RunSnapshotSummary['escalateFindings'] },
            params.chapterBrief as ChapterBrief | undefined,
            ctx,
            initialArtifacts,
          );
          const planTrustEligible = autoTrustOptIn && !(planHardStop && hardEscalate === 'ask') && !planHasHardFinding;
          if (planTrustEligible && planAdjudication) {
            if (planAdjudication.recommendation === 'accept') {
              // 裁决 accept → resume 续跑（A2 的进 B 写稿；链内收尾照常）。
              try {
                summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
                  requirement: params.episodeId,
                  abort: ctx.abort,
                  onAccept,
                  mode: policy,
                  resume: { fromSnapshot: true },
                  ...(emitChainEvent ? { emitChainEvent } : {}),
                });
                planAutoTrustAction = 'accept';
              } catch (resumeErr) {
                const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
                logger.warn({ err: resumeMsg }, 'write_chapter: plan auto-trust accept resume failed → degrade to escalate surface');
              }
            } else {
              // 裁决 revise → resume redo 回规划环 A1（brief-compiler-node——重编任务卡，plan_review
              // hard findings 作 recompileHints 机械投影）。CR-2c：redoFrom 落点 = resume 载荷（簇 1
              // workflow 消费：redo 边界节点移除〔A1/A2 之后全部重跑〕+ redo 清理集；与 options.redo
              // 可共存——nodeId 同 target 双保险 + feedback 走 redo 注入）。types.ts 签名未同步该字段
              // ——spread 透传不依赖类型在位。
              planAutoTrustAction = 'revise';
              const planRedoFromExtra: Record<string, unknown> = { redoFrom: 'brief-compiler-node' };
              try {
                summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
                  requirement: params.episodeId,
                  abort: ctx.abort,
                  onAccept,
                  mode: policy,
                  resume: { fromSnapshot: true, ...planRedoFromExtra },
                  redo: { nodeId: 'brief-compiler-node', feedback: planAdjudication.analysis },
                  ...(emitChainEvent ? { emitChainEvent } : {}),
                });
              } catch (redoErr) {
                const redoMsg = redoErr instanceof Error ? redoErr.message : String(redoErr);
                logger.warn({ err: redoMsg }, 'write_chapter: plan auto-trust revise redo failed → degrade to escalate surface');
                planAutoTrustAction = null;
              }
            }
          }
        }
      }
      if (summary.routeDecision?.decision === 'escalate_user') {
        if (hardStopSignal && hardEscalate === 'auto' && !hasBlockFinding && escalatePauseAtDispatch) {
          // W2：真全自动（强难停点关）收敛失败安全处置——**机械分派不派裁决器**（两支判定全是机械
          // 信号：lint 门禁代理 + 连续计数；范式判据 ✓），永不停但**永不带病落盘**。
          if (suspensionStreakAtDispatch >= 2 || summary.lintUnresolved === true) {
            // 同章连续矛盾 ≥2（挂起明细在下方 suspension 分支已呈现——escalate 路径 belt）/ cap 超限 +
            // 去味门禁未过（AI 味清不掉就是卡点）→ 终弃该章 + 标记上报。
            chapterAbandoned = true;
          } else {
            // cap 超限但去味门禁已过（审读仍不满）→ 采信终稿：resume 续跑（E 段 + 完成收尾 + 落盘）
            // + 章 status 标「环未收敛」（loopUnconvergedAccepted 上报行；不改链行为）。
            try {
              summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
                requirement: params.episodeId,
                abort: ctx.abort,
                onAccept,
                mode: policy,
                resume: { fromSnapshot: true },
                ...(emitChainEvent ? { emitChainEvent } : {}),
              });
              loopUnconvergedAccepted = summary.status === 'completed';
            } catch (resumeErr) {
              const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
              logger.warn({ err: resumeMsg }, 'write_chapter: hardEscalate=auto cap-accept resume failed → degrade to escalate surface');
            }
          }
        } else {
          // 其余 escalate（普通灰区 / 强难+'ask' 停下叫人形态）——**派裁决器供呈现参考**（ask 模式 4.6
          // 既有初审块消费；强难+'ask' 的裁决建议同样呈人参考，不自动执行）。auto-trust 行为 gate 在
          // autoTrustEligible：强难 + 'ask'（缺省，强难停点开）→ 不 auto-trust——收敛失败停下叫人，
          // resume 由人决断驱动；普通灰区维持 hands_off+trust 显式 opt-in 既有语义。
          adjudication = await dispatchAdjudicator(summary, params.chapterBrief as ChapterBrief | undefined, ctx, initialArtifacts);
          const autoTrustEligible = autoTrustOptIn && !(hardStopSignal && hardEscalate === 'ask');
          if (autoTrustEligible && adjudication) {
            if (adjudication.recommendation === 'accept') {
              // 裁决 accept → resume 续跑（链内收尾：旧链 route 后无剩节点即完成；新链 D→E→F）。
              // CR-005：传真 initialArtifacts（write_chapter assemble 的，在 scope）非 {}——runChapterChain
              // 内 resumeArtifacts ?? initialArtifacts：snapshot 在则覆盖（resume 续跑），snapshot 缺则真
              // from-head（空 {} 会致 brief-compiler requiredArtifactKeys 缺 status='blocked'）。
              // escalatePauseAtDispatch gate：completed+escalate 旧形态（链已终态，测试/mock 路径）无
              // resume 可做——只置 autoTrustAction（mirror W1a 既有行为）。
              if (escalatePauseAtDispatch) {
                try {
                  summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
                    requirement: params.episodeId,
                    abort: ctx.abort,
                    onAccept,
                    mode: policy,
                    resume: { fromSnapshot: true },
                    ...(emitChainEvent ? { emitChainEvent } : {}),
                  });
                } catch (resumeErr) {
                  // resume 失败 → graceful fallback（不崩 tool）：维持原 escalate summary 走上呈路径。
                  const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
                  logger.warn({ err: resumeMsg }, 'write_chapter: auto-trust accept resume failed → degrade to escalate surface');
                }
              }
              autoTrustAction = 'accept';
            } else {
              // 裁决 revise → resume redo 回环（feedback=裁决 analysis；draft-writer 断前缀，规划环节点保留）。
              // CR-2c：redoFrom = resume 载荷 additive 参数（簇 1 workflow 消费：redo 边界节点移除 +
              // redo 清理集生效——resume.redoFrom 落点，与 options.redo 可共存）。types.ts（skillExecutor
              // 签名）未同步该字段——spread 透传不依赖类型在位。
              autoTrustAction = 'revise';
              const auditRedoFromExtra: Record<string, unknown> = { redoFrom: 'draft-writer-agent' };
              try {
                summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
                  requirement: params.episodeId,
                  abort: ctx.abort,
                  onAccept,
                  mode: policy,
                  resume: { fromSnapshot: true, ...auditRedoFromExtra },
                  redo: { nodeId: 'draft-writer-agent', feedback: adjudication.analysis },
                  ...(emitChainEvent ? { emitChainEvent } : {}),
                });
              } catch (redoErr) {
                // redo 失败 → graceful fallback（不崩 tool）：撤销 autoTrustAction，用原 escalate summary 走上呈路径。
                const redoMsg = redoErr instanceof Error ? redoErr.message : String(redoErr);
                logger.warn({ err: redoMsg }, 'write_chapter: auto-trust revise redo failed → degrade to escalate surface');
                autoTrustAction = null;
              }
            }
          } else if (autoTrustEligible && !adjudication && hardEscalate === 'auto' && escalatePauseAtDispatch) {
            // W2：真全自动 + 裁决失败/空输出（W0-7 机械信号：dispatchAdjudicator 返 null）→ **保守采信**
            // + 标记（design §3「裁决器判不了→保守采信+标记」）——loopUnconvergedAccepted 上报行标注
            // 保守采信。resume 失败 → degrade 上呈（不假 pass）。
            try {
              summary = await ctx.skillExecutor.runChapterChain(ctx.sessionId, initialArtifacts, {
                requirement: params.episodeId,
                abort: ctx.abort,
                onAccept,
                mode: policy,
                resume: { fromSnapshot: true },
                ...(emitChainEvent ? { emitChainEvent } : {}),
              });
              loopUnconvergedAccepted = summary.status === 'completed';
              autoTrustAction = 'accept';
            } catch (resumeErr) {
              const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
              logger.warn({ err: resumeMsg }, 'write_chapter: hardEscalate=auto adjudication-null conservative accept resume failed → degrade to escalate surface');
            }
          }
        }
      }

      // 链段只回摘要（context isolation）——把 routeDecision/draft/verdict 摘要格式化给 leader。
      // W1a：裁决 resume/redo 可能已替换 summary——escalate-pause 判定按**当前** summary 重算
      //（escalatePauseAtDispatch 只服务裁决分派时刻的决策）。
      const isEscalatePause = summary.status === 'paused' && summary.escalatePause === true;
      const lines: string[] = [`status: ${summary.status}`];
      if (summary.draftTitle) lines.push(`draft: ${summary.draftTitle} (${summary.draftWordCount ?? 0} 字)`);
      if (summary.reviewVerdict) lines.push(`review verdict: ${summary.reviewVerdict}`);
      if (summary.routeDecision) {
        lines.push(`route: ${summary.routeDecision.decision} — ${summary.routeDecision.reason}`);
      }
      if (summary.errors.length > 0) lines.push(`errors: ${summary.errors.join('; ')}`);

      // 链流程重排 W1a（W0-5）：旧 stage 停点快照废弃告知——该链停点已随链序/档位重排退役，快照已
      // 清并 fresh 重跑本章（不resume 旧快照——verdict 快照带旧候选，机械续跑会绕过新终稿停点）。
      if (discardedLegacyPauseStage !== null) {
        lines.push('');
        lines.push(`【快照迁移】上一条暂停链停在旧 ${discardedLegacyPauseStage} 停点（链流程重排后已退役）——已废弃该快照并按本次任务卡重新开跑本章。`);
      }

      // dogfood R2 #21B：零角色卡回顾行（机械计数 countCharacterCards 单源）。leader 侧雷达行是开写
      // 前主信号；此行是链结算时的兜底可见性——写手本章对人物的把握全凭大纲/集纲转述，作者看到
      // 结算才知道下一章前该建卡。不 block 不重试（轻装档语义保留，A 案已把档位文案收窄）。
      if (countCharacterCards(project.asset_cards) === 0) {
        lines.push(
          `【设定提示】本章写作时项目还没有任何角色卡——写手对人物的把握只能来自大纲与集纲的转述。建议下一章前为出场人物各建一张一句话基础卡（asset_cards_update），提升人物刻画的一致性。`,
        );
      }

      // Story 8.4 B2/B3（design §2.2 L3）：复杂场景标记——降级后仍超机械警戒线 → leader 一行（B 段唯一
      // leader 侧改动，轻量）。mirror loadStructureIssuesForLeader 注入形态（纯代码机械事实 + 建议动作 +
      // 人裁收尾——「建议拆章」不自动拦截不静默砍；阈值定位 = bug 保险丝非质量评分，正常写作永不触发）。
      if (summary.compileReport?.overloaded) {
        lines.push(
          `【复杂场景信号】本章任务卡与设定在自动瘦身（收窄状态快照、移出可自查段落）后规模估算仍约 ${summary.compileReport.total} tokens，超过机械警戒线——通常意味着本章场景过多或数据异常膨胀，不是质量问题。建议与作者商议拆章或清理膨胀数据；由人裁决，系统不会自动拦截。`,
        );
      }

      // Story 4.3 Step 3：paused summary（半自动/微操模式 checkpoint pause）→ chapter_review metadata + 文案。
      // 链流程重排 W1a：paused 有两形态——**stage 人审暂停**（brief/draft/verdict checkpoint，ChapterReviewPanel
      // 三动作 continue/redo/abort 消费）与 **escalate-pause**（灰区裁决暂停，R4b——裁决 accept→resume 续跑 /
      // revise→redo 回环，不走 chapter_review 卡）。isStagePause 门槛据此区分两条 resume 路径。
      const isPaused = summary.status === 'paused';
      const isStagePause = isPaused && !isEscalatePause;
      // W2：auto 档挂起跳章后链快照已清——chapter_review 审阅卡（三动作）不再产（链已终态）。
      let suspensionDisposedInAuto = false;
      if (isPaused && summary.researchSuspension) {
        // Story 8.4 Step 4（A8）：出发核查挂起 pause——文案 = 挂起明细 + 建议动作（替代通用 pause 文案：
        // continue 对挂起非法——draft.initial 不存在，恢复只有 redo）。挂起全档位发生（含全自动——结构性
        // 矛盾不带病开写），任何档位都须呈报作者决断，不静默绕过。
        const suspension = summary.researchSuspension;
        lines.push('');
        lines.push(
          `【本章挂起——出发核查${suspension.kind === 'research_contradiction' ? '发现任务卡与资料矛盾 / 写前偏离' : '多轮仍未通过'}，本章尚未动笔】`,
        );
        lines.push(...formatResearchSuspensionDetail(suspension));
        // ── 链流程重排 W2（R4 auto 档安全自决，翻 8.4 全档位暂停）：挂起按档位分流 ──
        //
        // - suggest/readonly：维持暂停叫人（现状零变化）——快照保留，人决断驱动 resume。
        // - auto 单次挂起：**跳章+标记**（clearChainSnapshot 终止链释放租约 + 批量 suspendedSceneIds
        //   机械标记 + 上报）——批量继续他章，单章场景 = 终止即终态。
        // - auto 同章连续 ≥2（suspensionStreaks 跨调用计数）：'ask'（缺省）→ 不再跳章，保持暂停叫人
        //   （强难停点）；'auto'（真全自动）→ 终弃该章 + 标记上报（abandonChapterForHardStop 共用）。
        if (sessionPermissionMode === 'auto') {
          const nextStreak = bumpSuspensionStreak(ctx.sessionId, params.episodeId);
          if (nextStreak >= 2 && hardEscalate === 'ask') {
            lines.push('');
            lines.push(
              `本章已是第 ${nextStreak} 次挂起（同章连续矛盾 ≥2——强难信号）：按强难停点设置（缺省）停下叫人，不再自动跳章。请作者决断（改任务卡 / 改设定 / 工作台 redo 重跑 / abort 放弃）。`,
            );
          } else if (nextStreak >= 2) {
            // 真全自动：连续矛盾 ≥2 → 终弃（mirror cap 超限终弃形态，abandonChapterForHardStop 上报）。
            lines.push(...(await abandonChapterForHardStop({
              ctx,
              chapterId: params.chapterId,
              episodeId: params.episodeId,
              reason: `同章连续 ${nextStreak} 次出发核查挂起（任务卡与资料反复矛盾）`,
            })));
            suspensionDisposedInAuto = true;
          } else {
            // 单次挂起：跳章 + 标记（快照清——章节恢复靠作者决断后重跑，非 resume 续跑）。
            ctx.skillExecutor.clearChainSnapshot?.(ctx.sessionId);
            lines.push(...(await markSuspendedChapterInBatch(ctx, params.chapterId, suspension)));
            lines.push(
              '本章已按全自动档安全自决跳过（挂起章标记完成）：批量继续其他章；作者决断后重调 write_chapter 重写本章。',
            );
            suspensionDisposedInAuto = true;
          }
        } else {
          // suggest/readonly：维持暂停叫人——R2-盲2 措辞与系统行为对齐（选项③「维持原案」= 已亮牌
          // 偏离获批，重跑同偏离不再挂起、新偏离照常上报）。
          // dogfood R2 #105 缝①（R2.1）：重调已可行（自家租约自动转 resume/fresh 车道）——①② 的
          // fresh 车道靠 chapterBrief 差异触发，故补残留风险一句：改设定须同步更新任务卡摘要一并
          // 传入，否则走 resume 沿用快照上的旧设定上下文（design §6 权衡：不引入设定 diff 探测）。
          lines.push(
            '请核实以上证据后呈给作者决断：① 改任务卡（怎么改）② 改设定（先修档案）③ 维持原案（写手重新调查，已亮牌的偏离按批准方案写）。' +
            '决断后重调 write_chapter 重写本章：①②改了会自动重新调查——改了设定请同步更新任务卡（chapterBrief）摘要一并传入，否则重跑会沿用快照上的旧任务卡/设定上下文；③维持原案也会重新调查，但你未改任务卡即视为已亮牌偏离获批——同一偏离不会再触发挂起（新的偏离仍会照常上报）；工作台可改稿重跑（redo）/ 放弃（abort），不可直接续写。',
          );
          lines.push(...(await markSuspendedChapterInBatch(ctx, params.chapterId, suspension)));
        }
      } else if (isStagePause) {
        // 链流程重排 W2：终稿 checkpoint（stage='final'）= 唯一正文人审停点——动作 accept（可携
        // editedDraft 手改全文，编辑面归子3）/ redo（带意见回环 C1）/ abort。其余 stage（brief /
        // revision-guard）沿用 continue/redo/abort。
        const stageLabel =
          summary.pausedStage === 'final' ? '终稿'
            : summary.pausedStage === 'draft' ? '草稿'
              : summary.pausedStage === 'brief' ? 'brief'
                : summary.pausedStage === 'verdict' ? '裁决'
                  : 'checkpoint';
        if (summary.pausedStage === 'final') {
          const loopCount = summary.reviewSummary?.loopCount ?? 0;
          lines.push(
            `终稿 checkpoint：自审环已收敛（迭代 ${loopCount} 轮${summary.reviewSummary ? `，审读结论 ${summary.reviewSummary.verdict || '（无）'}` : ''}）。请终审正文：接受（accept，可在审阅卡直接手改正文——手改稿将先落盘再提取）/ 带意见打回（redo）/ 放弃（abort）。`,
          );
        } else {
          lines.push(`链段在 ${stageLabel} checkpoint 暂停，等待你审阅：继续写（continue）/ 改稿重跑（redo）/ 放弃（abort）。`);
        }
      }

      // Story 4.3 Step 6：auto-trust 透明文案（显式 opt-in 采信裁决器建议，非静默）。
      // CR-001：auto-trust 现为一个“放手档 + trustAdjudication”组合中的 hands-off 选项。“全自动采信”标签保留以兼容
      // 既有测试与用户认知（从 auto-trust 时代沿用），但行为仅由 participationGear+hands_off+trust 驱动。
      // W2：保守采信路径（loopUnconvergedAccepted 且无裁决建议）走下方「环未收敛」行——本块只呈裁决器
      // 建议驱动的采信。CR-2b：规划环同款透明文案（planAutoTrustAction 与 audit autoTrustAction 互斥）。
      if (planAutoTrustAction === 'accept' && !planUnconvergedAccepted) {
        lines.push('');
        lines.push(`【全自动采信】规划灰区裁决器初审建议「接受当前任务卡」——已按放手档（hands_off + 信裁决器初审）采信续跑写稿（${planAdjudication?.recommendationReason || '无理由'}）。`);
      } else if (planAutoTrustAction === 'revise') {
        lines.push('');
        lines.push(`【全自动采信】规划灰区裁决器初审建议「改任务卡」——已按放手档触发规划环重编重跑（反馈：${planAdjudication?.analysis ?? ''}），重跑结果 route=${summary.routeDecision?.decision ?? '?'}。`);
      } else if (autoTrustAction === 'accept' && !loopUnconvergedAccepted) {
        lines.push('');
        lines.push(`【全自动采信】灰区裁决器初审建议「接受为真相」——已按放手档（hands_off + 信裁决器初审）采信（${adjudication?.recommendationReason || '无理由'}）。`);
      } else if (autoTrustAction === 'revise') {
        lines.push('');
        lines.push(`【全自动采信】灰区裁决器初审建议「改稿」——已按放手档触发改稿重跑（反馈：${adjudication?.analysis ?? ''}），重跑结果 route=${summary.routeDecision?.decision ?? '?'}。`);
      }

      // Story 4.6 / 4.3 Step 6：route=escalate_user 时呈 findings grounding + 裁决建议给 leader chat。
      // auto-trust accept → 已采信（跳过 findings 噪声，决策已定）；auto-trust revise + redo-accept → 非 escalate（跳过）；
      // auto-trust revise + redo-escalate / auto-trust parse 失败 / ask 模式 → 呈 findings（4.6 既有 + degrade）。
      // graceful 降级（D5）：裁决器失败/方法缺 → output 仍带 findings grounding + route（**不假 pass**）。
      // 注：adjudication 在上方 auto-trust 块内一次性派发（不再此处重复 dispatch）；ask 模式 + auto-trust parse
      // 失败均经此块呈 findings + 对应文案（4.6 既有裁决建议 / 全自动采信失败告知）。
      const isEscalate = summary.routeDecision?.decision === 'escalate_user';
      if (isEscalate && autoTrustAction !== 'accept') {
        // CR-Edge-3：escalate 总派裁决器（即便 findings 空——Reader-Audit parse 失败 fallback dimensions=[] /
        // 全 info 过滤 / grounding 缺时 findings 空，此时用户最需指引，裁决器据 draft + brief + route reason 判）。
        if (summary.escalateFindings && summary.escalateFindings.length > 0) {
          lines.push('');
          lines.push('灰区 findings（Reader-Audit 抓出，带正文原句）：');
          for (const f of summary.escalateFindings) {
            lines.push(`  · [${f.severity}] "${f.quote}"（${f.location}）—— ${f.explanation}`);
          }
        } else {
          lines.push('');
          lines.push('灰区上发：Reader-Audit route 判 escalate（难断灰区），但未抓出具体 findings（可能解析失败/全 info 被过滤）——见裁决器初审。');
        }
        if (hasBlockFinding) {
          // CR-001 BLOCK 机械门：任何配置（hands_off+trust 含 BLOCK 在内）均永不 auto-trust——
          // 硬违规不豁免（§4 硬性打断穿透纪律）。无论 optIn 与否都明确告知「未自动采信」，
          // 牵引用户执行人裁。adjudication 为辅助（BLOCK 必上呈既定——裁决器建议仅参考，不替代用户）。
          lines.push('');
          if (adjudication) {
            // 呈裁决建议作为参考（真上呈仍交用户；裁决器不豁免 BLOCK）。
            lines.push(`【灰区裁决器初审（参考——BLOCK 硬违规不豁免自动采信）】`);
            lines.push(`分析：${adjudication.analysis}`);
            lines.push(`倾向：${adjudication.recommendation === 'accept' ? '接受为真相' : '改稿'} —— ${adjudication.recommendationReason || '（无理由）'}`);
            lines.push('选项（供你裁决）：');
            for (const opt of adjudication.options) {
              lines.push(`  · ${opt.label}：${opt.reason}`);
            }
          }
          lines.push('【硬违规不豁免】BLOCK 级 escalate findings 到达——任何档位（含放手档+信裁决器）均未自动采信，请你裁决。');
        } else if (autoTrustOptIn) {
          // auto-trust 但裁决器无有效建议（parse 失败/null）或 redo 后仍 escalate → 不假 pass，告知 leader 裁决。
          // redo-escalate：autoTrustAction='revise'，adjudication 是原稿的（redo 稿不同），不重复呈；leader 据 redo findings + route 裁决。
          // CR-001：auto-trust 失败文案仅在显式 opt-in 时呈（无 opt-in 场景走 ask 路径下方的裁决器建议呈现块）。
          lines.push('');
          lines.push(autoTrustAction === 'revise'
            ? '【放手采信】改稿重跑后仍 escalate——未再次自动采信（防死循环），请你裁决。'
            : '【放手采信失败】灰区裁决器初审无有效建议（parse 失败/超时）——未自动采信，请你裁决。');
        } else if (adjudication) {
          // ask 模式：呈裁决建议给 leader chat（4.6 既有路径，PatchReviewPanel 人裁决）。
          lines.push('');
          lines.push('【灰区裁决器初审】');
          lines.push(`分析：${adjudication.analysis}`);
          lines.push(`倾向：${adjudication.recommendation === 'accept' ? '接受为真相' : '改稿'} —— ${adjudication.recommendationReason || '（无理由）'}`);
          lines.push('选项（供你裁决）：');
          for (const opt of adjudication.options) {
            lines.push(`  · ${opt.label}：${opt.reason}`);
          }
        } else {
          // 无 optIn + 裁决器 parse 失败 / 不可达：仅呈 findings + 明示需用户裁（不假 pass）。
          lines.push('');
          lines.push('【灰区上发】裁决器初审暂不可用（parse 失败/超时）——未自动采信，请你裁决。');
        }
        // 链流程重排 W1a（R4b）：escalate-pause 待裁决指引——链以暂停形态滞留（快照已持久），裁决驱动
        // resume：接受 → 重调 write_chapter（自家租约自动转 resume 续跑收尾，收尾后章节候选照常呈现落盘）；
        // 改稿 → 工作台改稿重跑（redo）或告知修改意见由我转达重调。
        if (isEscalatePause && autoTrustAction === null) {
          lines.push('');
          lines.push('本章链段已暂停待裁决（快照已保存）：裁决「接受为真相」→ 直接重调 write_chapter 即续跑收尾并生成章节候选；裁决「改稿」→ 在工作台改稿重跑（redo）或告知我修改意见。');
        }
      }

      // ── 链流程重排 CR-2b：规划环 escalate-pause 呈现（mirror audit escalate 块形态）──
      //
      // planAutoTrustAction='accept'（含 cap 耗尽保守采信）→ 已采信（跳过 findings 噪声，决策已定）；
      // 其余（ask 档 / 无 opt-in / 裁决器 null / hard finding 拦采信 / redo 后再 escalate）→ 呈
      // plan findings + 裁决建议 + 待裁决指引（不假 pass，永不静默）。findings 行形态按 plan_review
      // 字段（dimension/severity/grounding/note——无正文 quote，对照源是任务卡字段）。
      const planEscalateCurrent = readPlanEscalate(summary);
      if (planEscalateCurrent && planAutoTrustAction !== 'accept') {
        lines.push('');
        if (planEscalateCurrent.findings.length > 0) {
          lines.push('规划审核灰区（brief-reviewer 对任务卡判 escalate，带对照与重编方向）：');
          for (const f of planEscalateCurrent.findings) {
            lines.push(`  · [${f.severity}] ${f.dimension} — ${f.note}${f.grounding ? `（对照：${f.grounding}）` : ''}`);
          }
        } else {
          lines.push('规划审核灰区：brief-reviewer 判任务卡 escalate（难断灰区），但未抓出具体 findings（载荷空/解析降级）——见裁决器初审。');
        }
        if (planAdjudication) {
          lines.push('');
          lines.push('【规划灰区裁决器初审】');
          lines.push(`分析：${planAdjudication.analysis}`);
          lines.push(`倾向：${planAdjudication.recommendation === 'accept' ? '接受当前任务卡' : '改任务卡'} —— ${planAdjudication.recommendationReason || '（无理由）'}`);
          lines.push('选项（供你裁决）：');
          for (const opt of planAdjudication.options) {
            lines.push(`  · ${opt.label}：${opt.reason}`);
          }
        } else if (autoTrustOptIn) {
          lines.push('');
          lines.push('【放手采信失败】规划灰区裁决器初审无有效建议（parse 失败/超时）——未自动采信，请你裁决。');
        } else {
          lines.push('');
          lines.push('【规划灰区上发】裁决器初审暂不可用（parse 失败/超时）——未自动采信，请你裁决。');
        }
        if (planEscalateCurrent.findings.some((f) => f.severity === 'hard') && autoTrustOptIn) {
          // mirror CR-001 BLOCK 门透明文案：hard 维度（红线一致/可写性/信息差指令自相矛盾）拦截
          // auto-trust 时明确告知「未自动采信」（不静默跳过）——裁决建议仅参考不替代用户。
          lines.push('');
          lines.push('【硬维度不豁免】plan findings 含 hard 级（红线一致/可写性/信息差指令自相矛盾家族）——任何档位均未自动采信，请你裁决。');
        }
        if (isEscalatePause && planAutoTrustAction === null) {
          lines.push('');
          lines.push('本章链段已暂停待裁决（规划环，快照已保存）：裁决「接受任务卡」→ 直接重调 write_chapter 即续跑写稿；裁决「改任务卡」→ 告知我修改意见（将回规划环重编任务卡）。');
        }
      }
      if (planUnconvergedAccepted) {
        lines.push('');
        lines.push('【规划环未收敛·保守采信】brief-reviewer 两轮重编仍未收敛——按真全自动档（强难停点关）采信当前任务卡续跑写稿；作者过目后可决定重跑。');
      }

      // ── 链流程重排 W2（R4 hardEscalate 处置矩阵上报面）──
      //
      // 终弃（chapterAbandoned）：不产 chapter_accept + 链快照已清（abandonChapterForHardStop 内）+
      // 批量标记 + 本上报行（leader 呈作者）——永不静默（无孤儿发现红线）。采信终稿（'auto' 形态
      // cap 超限去味已过 / 裁决失败保守采信）：resume 已续跑，本章按采信落盘 + 「环未收敛」上报行
      // （作者可过目后决定重跑）。强难+'ask'（缺省）停下叫人：强难停点说明行。
      if (chapterAbandoned) {
        // CR-16：终弃文案按**实际触发信号**分派（旧三元 capExhausted 优先——streak≥2 且 lint 干净
        // 时误报「去味门禁未过」）。终弃内分支的可达条件 = lintUnresolved（去味卡点）或 streak≥2
        // （连续矛盾），两信号可并存（文案并陈）。
        const abandonReasons: string[] = [];
        if (summary.lintUnresolved === true) abandonReasons.push('自审环迭代上限耗尽且去味门禁未过（AI 味未清）');
        if (suspensionStreakAtDispatch >= 2) abandonReasons.push(`同章连续出发核查挂起 ${suspensionStreakAtDispatch} 次（任务卡与资料反复矛盾）`);
        lines.push(...(await abandonChapterForHardStop({
          ctx,
          chapterId: summary.chapter_accept?.chapterId ?? params.chapterId,
          episodeId: params.episodeId,
          reason: abandonReasons.join('；') || '自审环收敛失败（强难信号）',
        })));
      }
      if (loopUnconvergedAccepted) {
        lines.push('');
        lines.push(
          `【环未收敛·保守采信】${capExhausted ? '自审环达迭代上限（去味门禁已过）' : '灰区裁决器初审不可用'}——按真全自动档（强难停点关）采信终稿续跑落盘；章状态已标「环未收敛」，作者过目后可决定重跑。`,
        );
      }
      if (
        hardStopSignal && hardEscalate === 'ask' && sessionPermissionMode === 'auto' &&
        summary.routeDecision?.decision === 'escalate_user' && autoTrustAction === null
      ) {
        // CR-16：强难停点说明行同款按实际信号列（两信号并存时并陈，不偏报其一）。
        const hardStopSignals = [
          ...(capExhausted ? ['自审环迭代上限耗尽'] : []),
          ...(suspensionStreakAtDispatch >= 2 ? [`同章连续挂起 ${suspensionStreakAtDispatch} 次`] : []),
        ].join(' + ');
        lines.push('');
        lines.push(
          `【强难停点】收敛失败信号到达（${hardStopSignals}）——按强难停点设置（缺省）未自动采信，请你裁决。`,
        );
      }

      // ── 链流程重排 W2（R4c 落盘拆两步 / AC2c）：E 段提取失败 post-hoc 兜底 ──
      //
      // derivationStale = route accept 已过（终稿已定）但 E 节点 error 中断（summarize 机械判）。处置：
      // 正文 post-hoc 落盘（chapter_write body-only——handler preserveChapterFrontmatter 守 frontmatter，
      // #107 同款通道）+ 章标 stale 上报 + 重提取指路（re-extract-chapter 修复通道，W4 落地；E 段幂等
      // 重跑也可从快照 resume）。仅落**已注册**章（chapterId 映射 + novel.chapters 命中）——未注册章
      // 无 frontmatter 载体，维持报告指路（#107 建章路径不经此处）。auto/suggest 同处置（正文安全
      // 优先于档位语义——人审成果〔终稿〕已定，不带病丢失）。
      if (summary.derivationStale === true) {
        const landedChapterId = directChapterId ??
          resolveChapterIdForEpisode(episodeOutlines, novelChapters, params.episodeId);
        const chapterRegistered = landedChapterId !== undefined &&
          (novelChapters ?? []).some((ch) => ch?.id === landedChapterId);
        let landedNote = '';
        if (landedChapterId && chapterRegistered && summary.draftText !== undefined) {
          const chapterWrite = registry.get('chapter_write');
          if (chapterWrite) {
            try {
              await chapterWrite.execute(
                { chapterId: landedChapterId, content: summary.draftText },
                { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort },
              );
              landedNote = `正文已先落盘 chapters/${landedChapterId}.md（终稿不随提取中断丢失）`;
              logger.info(
                { sessionId: ctx.sessionId, episodeId: params.episodeId, chapterId: landedChapterId },
                'write_chapter: derivationStale → post-hoc prose landing（F1a 兜底：E 段失败正文先落盘）',
              );
            } catch (landErr) {
              logger.warn(
                { err: landErr instanceof Error ? landErr.message : String(landErr), chapterId: landedChapterId },
                'write_chapter: derivationStale post-hoc chapter_write failed → report only（正文在链快照/摘要中，可重试）',
              );
            }
          }
        }
        lines.push('');
        lines.push(
          `【提取中断】终稿已定（route accept）但提取段中途失败——${landedNote || '正文仍在链快照与摘要中（draftText），未被丢弃'}。世界事件/伏笔/弧/摘要等衍生状态未更新（章标 stale）：待修复后对该章触发重提取（re-extract-chapter，W4 落地）或重跑收尾。`,
        );
        if (summary.errors.length > 0) {
          lines.push(`提取段错误：${summary.errors.join('; ')}`);
        }
      }

      // 4.1 Step 4（CR-15b）：route=accept_as_truth 且 chapter_accept 存在 → 转 field_patch metadata
      // （chapter_candidate 类型，复用既有 chapterCandidatePatchSchema）。leader runLoop 收 toolResult.metadata →
      // 既有 patch review 流（UI agentSessionSlice L318 field_patch handling → 人审 → applyFieldPatches 写盘，
      // 经 acceptChapterCandidateCore 持久化 chapters/*.md + project.yaml + story_decisions）。
      // **layering 合规**：agent 不直写 project.yaml（data-model L31），转 patch 走结构化 IPC。
      // **UI 接收/显示 defer Step 5**——本 step 只产 metadata（agentSessionSlice WRITE_TOOLS 接线 = Step 5）。
      //
      // Story 4.6 D4：escalate_user 且有 draft 时 chain 也产 chapter_accept（chainRunner D4 扩展）→ 此处同样
      // 转 field_patch。PatchReview 作裁决 UI：accept=接受为真相（+StoryDecision）/ reject=改稿。chapter_accept
      // 是候选载荷，StoryDecision 登记在 acceptChapterCandidateCore（PatchReview accept 后），reject 不登记。
      // Story 2.2 WP-E（链流程重排 W3 收尾时序）：story-sync 反哺收尾（E9 提取段完成后的 summary 到达
      // 此处——applier 详 applyStorySyncFeedback 块注释）。permissionMode 复用 Director 同源推导
      // （KD1——同一 session 信号，不二次 getSession）。null = 零痕迹。
      const storySyncOutcome = await applyStorySyncFeedback({
        summary,
        ctx,
        permissionMode: directorPermissionMode,
        chapterId: summary.chapter_accept?.chapterId ?? params.chapterId,
        isPaused,
      });

      // ── dogfood R2 #107 / R1.1：no-chapter 链侧自动建章（首章冷启动修复）──
      //
      // novel.chapters 的出生源是 chapters/*.md 磁盘派生（renderer 闭环），首章未建时链 accept 的
      // chapterId 映射恒 no-chapter → 正文悬空于章档案（dogfood R2 #107 实录）。修法 = 判定过 → 经
      // `chapter_write` builtin 程序化 execute 建章文件（CR-004 splice 落盘同款通道；shell handler 自带
      // snapshotToLocalHistory + atomicWrite + **主动 notifyUI** → UI 300ms debounce → derive →
      // sync-chapters-meta 注册闭环现成，UI/派生/注册三层零改动）。幂等 = 同 stem 同内容 chapter_write
      // 早退（chapterHandlers existedBefore 分支），重跑安全。
      //
      // 判定（design §1.1，planAutoCreateChapter 单源）：skipReason==='no-chapter'（no-draft 无正文 /
      // no-nowiso 无候选可补，不触发）+ 未显式传 params.chapterId + sort_order 0 命中空位（>1 歧义维持
      // 现报错）+ R1.1d 落位守卫过（order 有洞/混排不建，防错位章）。paused 不建（readonly verdict
      // pause 时 onAccept 已跑但终局未至——resume 完成后由 resume 车道补）。
      //
      // **模式门（用户拍板 Key Decision 1）**：auto 档（=落盘语义 direct，mirror shell persistMode 档位
      // 映射）建全文（正文=采信稿）；suggest/readonly（=review）只建**骨架章**（frontmatter+标题、无正文）
      // ——review「写内容须人批」语义不破，正文仍走候选→PatchReview 人审→acceptChapterCandidateCore
      // 落盘。candidate.content = **完整文件形态**（frontmatter+标题+正文）：accept 落盘是整体覆盖写，
      // body-only 候选会把 frontmatter 连 order 一起抹掉 → 派生重排错位。
      let autoCreatedAccept: ChapterAcceptArtifact | undefined;
      if (!isPaused && !summary.chapter_accept && acceptSkipReason === 'no-chapter') {
        const autoPlan = planAutoCreateChapter({
          episodeId: params.episodeId,
          ...(episodeOutlines ? { episodeOutlines } : {}),
          ...(novelChapters ? { novelChapters } : {}),
          ...(directChapterId ? { directChapterId } : {}),
          ...(summary.draftTitle !== undefined ? { title: summary.draftTitle } : {}),
        });
        if (!autoPlan) {
          logger.info(
            { episodeId: params.episodeId, hasDirectChapterId: directChapterId !== undefined },
            'write_chapter: #107 auto-create not planned（守卫未过/显式 chapterId/episode 缺）→ 维持现状告警',
          );
        } else if (summary.draftText === undefined) {
          // no-chapter 在 buildChapterAccept 里必然有 draft（no-draft 先 skip）——此分支只防 mock /
          // 旧路径（acceptSkipReason 兜底态）无正文时空建骨架孤儿章。
          logger.info(
            { episodeId: params.episodeId, stem: autoPlan.stem },
            'write_chapter: #107 auto-create skipped — summary 无 draftText（候选无法组装）',
          );
        } else {
          const chapterWrite = registry.get('chapter_write');
          if (!chapterWrite) {
            logger.warn(
              { episodeId: params.episodeId, stem: autoPlan.stem },
              'write_chapter: #107 auto-create skipped — chapter_write builtin 未注册（registry 空）→ graceful 维持现状告警',
            );
          } else {
            const isDirectLanding = sessionPermissionMode === 'auto';
            const fullFileContent = autoCreatedChapterFileContent(autoPlan, summary.draftText);
            try {
              await chapterWrite.execute(
                {
                  chapterId: autoPlan.stem,
                  content: isDirectLanding ? fullFileContent : autoCreatedChapterFileContent(autoPlan),
                },
                { sessionId: ctx.sessionId, projectPath: ctx.projectPath, abort: ctx.abort },
              );
              // 候选补产（onAccept 已在链内同步调用过不可重入，入口层手工组装——directChapterId=stem 语义）。
              // storyDecisions 补产（R1.1c，不静默降级）：buildAcceptStoryDecisions 单源 + summary 的
              // deviation 投影（summarizeRunSnapshot #107 增补）。runId：onAccept 闭包捕获的链段 runId
              // （StoryDecision id `accept-<runId>` 与正常路径同构）；闭包未跑（mock/旧路径）→ 兜底。
              const autoRunId = acceptSkipRunId ?? summary.storySync?.runId ?? 'auto-chapter';
              const autoStoryDecisions = buildAcceptStoryDecisions({
                routeDecision: summary.routeDecision,
                episodeId: params.episodeId,
                runId: autoRunId,
                nowISO: new Date().toISOString(),
              });
              autoCreatedAccept = {
                chapterId: autoPlan.stem,
                candidate: {
                  title: autoPlan.title,
                  content: fullFileContent,
                  ...(summary.draftWordCount !== undefined ? { wordCount: summary.draftWordCount } : {}),
                },
                runId: autoRunId,
                ...(autoStoryDecisions && autoStoryDecisions.length > 0 ? { storyDecisions: autoStoryDecisions } : {}),
              };
              logger.info(
                { episodeId: params.episodeId, stem: autoPlan.stem, episodeIndex: autoPlan.episodeIndex, mode: isDirectLanding ? 'direct' : 'review' },
                'write_chapter: #107 auto-created chapter file（frontmatter order = 登记载体，磁盘派生注册自动闭环）',
              );
            } catch (autoErr) {
              // graceful：建文件失败不崩 tool——维持现状告警（describeAcceptSkip 文案如实指路手建）。
              logger.warn(
                { err: autoErr instanceof Error ? autoErr.message : String(autoErr), episodeId: params.episodeId, stem: autoPlan.stem },
                'write_chapter: #107 auto-create chapter_write failed → graceful（维持现状告警）',
              );
            }
          }
        }
      }

      const metadata: Record<string, unknown> = { summary };
      // Story 3.7 #2（design D5）：Reader-Audit findings 结构化透传——tool result metadata 附
      // findings 字段（additive：leader 文字呈现一字不动，上方文案块零改动；UI 侧 AgentMessageItem
      // 判 metadata.findings?.source==='reader-audit' 渲染 ReviewFindingsCard per-finding InsightCard）。
      // 覆盖 escalate 呈现路径（含 escalate-pause 待裁决 / 放手采信失败降级；auto_revise surface 已随
      // 链内回环退役）；**stage pause 路径不加**（ChapterReviewPanel 已结构化呈现 chapter_review，卡内
      // 重复列 findings 双源）——escalate-pause 不是 stage pause，findings 照附（裁决 UI 消费面，子3）。
      // findings 空时仍附（items: []）——「已审核」锚点：UI 新鲜度门（D5b）按 chapterId 取同章最新卡，
      // 空审核结果也让旧卡降级。EscalateFinding 既有 schema 零改动；metadata 是松散透传通道
      // （mirror chapter_review/field_patch 消费侧判别，不进 shared-contracts zod——不造平行结构）。
      if (!isStagePause && isEscalate && autoTrustAction !== 'accept') {
        // route 取（可能 redo 后的）当前 decision——redo 仍 escalate 时 UI 应挂 redo 的 findings。
        metadata.findings = {
          source: 'reader-audit',
          route: summary.routeDecision?.decision ?? 'escalate_user',
          ...(params.chapterId ? { chapterId: params.chapterId } : {}),
          items: summary.escalateFindings ?? [],
        };
      } else if (!isStagePause && planEscalateCurrent && planAutoTrustAction !== 'accept') {
        // CR-2b：规划环 escalate-pause 的 findings metadata（mirror reader-audit 通道形态；source 区分
        // 规划审核家族——items = plan_review 保留版 findings 投影，裁决 UI 消费面归子3）。
        metadata.findings = {
          source: 'plan-review',
          route: 'escalate',
          ...(params.chapterId ? { chapterId: params.chapterId } : {}),
          items: planEscalateCurrent.findings,
        };
      }
      if (isStagePause && !suspensionDisposedInAuto) {
        // Story 4.3 Step 3（design §3.5 / §3.6）：stage pause → chapter_review metadata（UI Step 4 消费）。
        // shape = ChapterReviewMetadata（shared-contracts）：type/stage/chapterId/draftContent|briefContent/resumeOptions。
        // draftContent（draft/final pause 的正文）/ briefContent（brief pause 的 chapter_brief）豁免 context isolation
        // （同 CR-15a prose 是 deliverable）。resumeOptions 机械控制信号（UI 渲染按钮）。
        // 链流程重排 W1a：escalate-pause 不产 chapter_review（resume 路径是裁决分派非三动作审阅卡）。
        // 链流程重排 W2：final pause——resumeOptions = accept/redo/abort（accept 可携 editedDraft 手改全文，
        // resumeChapterChainInputSchema refine 守卫）；载荷附 reviewSummary（审读摘要）+ lintReport（去味
        // 终态，子3 终稿卡消费面）。auto 档挂起跳章/终弃（suspensionDisposedInAuto）不产卡——链已终态。
        metadata.type = 'chapter_review';
        if (summary.pausedStage) metadata.stage = summary.pausedStage;
        if (params.chapterId) metadata.chapterId = params.chapterId;
        if (summary.draftContent !== undefined) metadata.draftContent = summary.draftContent;
        if (summary.briefContent !== undefined) metadata.briefContent = summary.briefContent;
        // Story 8.4 Step 4（A8）：挂起 pause——resumeOptions 不含 continue（挂起无正文可续，continue 会跳过
        // draft-writer 撞下游 DAG blocked，恢复只有 redo）+ 挂起载荷（ChapterReviewMetadata.researchSuspension，
        // UI 决断卡数据源）。
        if (summary.researchSuspension) {
          metadata.researchSuspension = summary.researchSuspension;
          metadata.resumeOptions = ['redo', 'abort'];
        } else if (summary.pausedStage === 'final') {
          // W2（R3）：终稿卡——draftContent 是可编辑正文源（TipTap editable 归子3）；reviewSummary +
          // lintReport 字段级 additive 清单（plan-review M5）。
          if (summary.reviewSummary) metadata.reviewSummary = summary.reviewSummary;
          if (summary.lintReport !== undefined && summary.lintReport.length > 0) {
            metadata.lintReport = summary.lintReport;
          }
          metadata.resumeOptions = ['accept', 'redo', 'abort'];
        } else {
          metadata.resumeOptions = ['continue', 'redo', 'abort'];
        }
      } else if (!isEscalatePause && !suspensionDisposedInAuto && (summary.chapter_accept || autoCreatedAccept)) {
        // 链流程重排 W2：章节候选产出 = 该章成功落地路径——同章连续挂起计数清零（「连续」语义：成功
        // 即断链）。
        clearSuspensionStreak(ctx.sessionId, params.episodeId);
        // #107 R1.1：autoCreatedAccept = no-chapter 自动建章后补产的候选（与正常 chapter_accept 同形，
        // 走同一 field_patch 通道——PatchReview 人审 / meta 收口现成）。
        const ca = summary.chapter_accept ?? autoCreatedAccept!;
        metadata.type = 'field_patch';
        metadata.field = 'chapter_candidate';
        metadata.action = 'set';
        metadata.data = {
          chapterId: ca.chapterId,
          runId: ca.runId,
          candidate: ca.candidate,
          ...(ca.storyDecisions && ca.storyDecisions.length > 0 ? { storyDecisions: ca.storyDecisions } : {}),
        };
        // #107 R1.4 告知行：自动建章事实透明化（stem + 模式语义——review 骨架待人审 / direct 全文已落）。
        if (autoCreatedAccept) {
          lines.push(
            `已自动建章 chapters/${autoCreatedAccept.chapterId}.md 并经磁盘派生登记（章未注册救场）：` +
              `${sessionPermissionMode === 'auto' ? 'auto 档正文已随文件直落' : '骨架章——正文随候选在工作台审阅落盘'}。`,
          );
        }
        // Story 4.6 / 4.3 Step 6：文案区分（裁决语义 vs 全自动采信 vs 改稿重跑 vs 直接落盘）。
        if (autoTrustAction === 'accept') {
          lines.push(`已生成章节候选（chapter ${ca.chapterId}）——全自动采信裁决器「接受为真相」建议，等待落盘。`);
        } else if (autoTrustAction === 'revise') {
          lines.push(`已生成章节候选（chapter ${ca.chapterId}）——全自动改稿重跑后的候选，等待落盘。`);
        } else if (isEscalate) {
          lines.push(`已生成章节候选（chapter ${ca.chapterId}）——灰区裁决：工作台 PatchReview accept=接受为真相 / reject=改稿（reject 后告诉我怎么改，我重跑）。`);
        } else {
          lines.push(`已生成章节候选（chapter ${ca.chapterId}），等待你在工作台审阅后落盘。`);
        }
      } else if (isEscalate) {
        // Story 4.6 / 4.3 Step 6：escalate 无 chapter_accept（无 draft 或章映射失败）→ 无候选可裁决/落盘，告知用户。
        if (autoTrustAction === 'revise') {
          lines.push(`全自动改稿重跑后仍 escalate 且无候选——请你裁决。`);
        } else {
          lines.push(`灰区裁决：但无章节候选（${describeAcceptSkip(acceptSkipReason ?? 'no-chapter')}）——无法裁决落盘。`);
        }
      } else if (summary.routeDecision?.decision === 'accept_as_truth') {
        // CR-4.1-08：accept 但 chapter_accept 缺省 → 据 skipReason 出对应文案（非旧统一「章未注册」误导）。
        // skipReason 由 onAccept 闭包捕获；兜底 'no-chapter'（闭包未跑 / 4.0 旧路径 / mock 不经闭包）。
        lines.push(`warning: accept 未持久化——${describeAcceptSkip(acceptSkipReason ?? 'no-chapter')}。`);
      }

      if (directorMergedMap && !directorAutoApplyFlag) {
        metadata.infoReleasePatch = {
          type: 'field_patch',
          field: 'info_release_map',
          action: 'set',
          data: directorMergedMap,
        };
        lines.push('');
        lines.push(`已生成信息释放计划（info_release_map，${directorMergedMap.entries.length} 条 entry）--导演产出的信息操控指令，等待你在工作台审阅后落盘。`);
      }

      // Story 5.2：non-auto mode Director emotion 段转 field_patch 人审（mirror infoReleasePatch，D8 direction-first）。
      // auto mode Director 已调 emotion_curve_update(autoApply=true) 持久化，不 surface。emotionTarget 不 surface
      // （章级目标 ephemeral，编译进 brief #10 in-memory 非持久化 creative field，mirror InfoRelease #3 不 surface）。
      if (directorEmotionCurve && !directorAutoApplyFlag) {
        metadata.emotionCurvePatch = {
          type: 'field_patch',
          field: 'emotion_curve',
          action: 'set',
          data: directorEmotionCurve,
        };
        lines.push('');
        lines.push(`已生成情绪目标弧（emotion_curve，${directorEmotionCurve.points.length} 个 point）--导演产出的逐场情绪目标，等待你在工作台审阅后落盘。`);
      }

      // Story 7.4：non-auto mode Director atomic-edit 落盘转 field_patch 人审（mirror infoReleasePatch/emotionCurvePatch，
      // D8 direction-first）。auto mode handler 已 autoApply=true 直接落盘 + scene_graph 已刷新（draft-writer 消费新 graph），
      // 不 surface patch。field_patch 子字段路由（agentSessionSlice scene_graph + promise_registry）归 UI Story / dogfood。
      if (pendingSceneGraphPatch) {
        metadata.sceneGraphPatch = pendingSceneGraphPatch;
        lines.push('');
        lines.push(`已生成场景图结构编辑（scene_graph，Director atomic-edit）--导演据上章审核提议的场景结构修订，等待你在工作台审阅后落盘。`);
      }
      if (pendingPromisePatch) {
        metadata.promiseRegistryPatch = pendingPromisePatch;
        lines.push('');
        lines.push(`已生成读者债账本编辑（promise_registry，Director atomic-edit）--导演据上章审核提议的伏笔/反转修订，等待你在工作台审阅后落盘。`);
      }

      // Story 2.6：non-auto mode Director 决策登记转 field_patch 人审（mirror pendingSceneGraphPatch 模式）。
      // auto mode handler 已 autoApply 直落 novel.story_decisions（dispatch 内日志），不 surface patch。
      if (directorStoryDecisionPatch) {
        metadata.storyDecisionsPatch = directorStoryDecisionPatch;
        lines.push('');
        lines.push(`已登记导演创作决策（story_decisions）--导演本章执导中的重大创作分叉留痕，等待你在工作台审阅后落盘。`);
      }
      // 2.6 CR-E01/E04：决策登记的非 envelope 表面（readonly 档文字建议 / 守卫拒/失败告知）——决策
      // vanishing 无痕迹 = 反留痕目标本身，至少 output 一行可见。
      if (directorDecisionNote) {
        lines.push('');
        lines.push(directorDecisionNote);
      }

      // Story 2.2 WP-E：story-sync 反哺 envelope 组挂 metadata（UI agentSessionSlice storySyncPatches 双路由
      // → PatchReview 人审，mirror infoReleasePatch/emotionCurvePatch CR-6a 同通道——story-sync patches 全是
      // creative fields，PatchReviewPanel 既有能力直接消费，无新卡片）；文案行 append（auto 落盘结果 /
      // escalate 裁决材料呈现 / readonly 建议 / 降级告知）。空 patches 零痕迹（storySyncOutcome null）。
      if (storySyncOutcome) {
        if (storySyncOutcome.patches) metadata.storySyncPatches = storySyncOutcome.patches;
        lines.push(...storySyncOutcome.lines);
      }

      // Story 8.4 Step 3（A7 档案议题通道）：出发核查（资料员）verdict.archive_issues → leader chat 呈现。
      // 3.3 校验议题进 chat 同通道（tool result → leader 主动提 + 对话解决，不造新通道）；资料员无档案
      // 写权限（只报告），处理归 leader/用户（改卡 / 记议题 / 维持）。空零痕迹（summary 不带空载荷）。
      if (summary.archiveIssues && summary.archiveIssues.length > 0) {
        lines.push('');
        lines.push(`出发核查发现 ${summary.archiveIssues.length} 条档案议题（设定卡疑似过时或与正文矛盾——核查员只报告不改档案）：`);
        for (const iss of summary.archiveIssues) {
          lines.push(`  · ${iss.card_ref}：${iss.problem}`);
        }
        lines.push('可与我讨论如何处理（改设定卡 / 暂记不理）。');
      }

      // Story 8.4 C2（design §3.3）：storyTime 漂移 warning → leader chat 呈现（3.3 校验议题进 chat
      // 同通道，mirror 上方档案议题形态——tool result → leader 主动提 + 对话解决，不造新通道）。
      // 漂移 = 本章提取的世界状态事件时间落在本章场景时间窗之外（提取误差 / 场景图 storyTime 过时 /
      // 跨章事件误归属，机械层不区分）——守卫只报不判，处理归 leader/用户（核对场景图 / 重提取该章）。
      // 零阻断（warning 不停链已到此处）+ 零噪音（对齐/无数据章 summary 不带空载荷）。
      if (summary.driftWarnings && summary.driftWarnings.length > 0) {
        lines.push('');
        lines.push(`发现 ${summary.driftWarnings.length} 处故事时间漂移（本章提取的事件时间落在本章场景时间窗 [${summary.driftWarnings[0].windowMin}, ${summary.driftWarnings[0].windowMax}] 之外）：`);
        for (const w of summary.driftWarnings) {
          lines.push(`  · ${w.sliceId}（storyTime ${w.storyTime}，在场景时间窗${w.direction === 'before' ? '之前' : '之后'}）`);
        }
        lines.push('可与我讨论如何处理（核对场景图的故事时间 / 重提取该章世界状态）。');
      }

      // Story 8.2 Step 4：弧生命周期 post-settle（关口大审 + 停滞触发 + 三档路由，design §2/§5）。
      // 读 summary.arcEmergenceBeats（本章写时声明，arc-emergence-node 透传）→ detectVolumeClosure 关口
      // 判定 → arc-audit-agent 通读大审；独立停滞触发（detectArcStagnation 全量 beats）。产物经
      // record_arc_audit 落 closure_arc_summary + defect/deviation/gray 三档路由文案 append。
      // autoApplyFlag 复用 Director 同源推导（KD1——同一 session 信号，deviation 登记 auto 档授权）。
      // paused 不跑（resume 路径非本 tool 职域，mirror storySync gate）；无 close beat 且无停滞弧 →
      // 零派发零成本（AC2）。graceful 全程（warn + 文案告知，不假 pass 不破链）。
      if (!isPaused) {
        const arcAuditLines = await runArcAuditPostSettle({
          summary,
          ctx,
          episodeId: params.episodeId,
          episodeOutlines: project.episode_outlines,
          sceneGraph: initialArtifacts['scene_graph'] as SceneGraph | undefined,
          outlinePhases: project.outlinePhases,
          autoApplyFlag: directorAutoApplyFlag,
          chapterBrief: params.chapterBrief as ChapterBrief | undefined,
          initialArtifacts,
        });
        lines.push(...arcAuditLines);

        // C1.2 R6（design §3.3）：lint 终稿账 post-settle——单章重扫落 `.orison/lint/<chapterId>.json`
        // （last-write-wins 幂等；全量桶，异于链段 lint_report 的 agent 桶 L2 软信号职能）。
        // 独立重扫（不经链段 artifact）——redo 中间轮的 lint_report 不污染终稿账，终轮结算覆盖即终态。
        // graceful：chapterId/draftText 缺位 / 引擎缺位 / 写盘异常 → skip 不破章结算（lintLedger 内
        // try/catch + warn，mirror arcAudit graceful 哲学）。零 output 行（DERIVED 派生缓存，issues
        // 呈报走链段 L2 / C1.3 报告面，此处只记账）。paused 不跑（章未结算，mirror arcAudit gate）。
        await writeLintChapterLedger({
          projectPath: ctx.projectPath,
          // #107 R1.1：自动建章的 lint 账也记到补产 stem（draftText 在即有账可记）。
          chapterId: summary.chapter_accept?.chapterId ?? autoCreatedAccept?.chapterId ?? params.chapterId,
          text: summary.draftText,
        });
      }

      return {
        title: `write_chapter: ${params.episodeId}`,
        output: lines.join('\n'),
        metadata,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // BMad CR-T1-053：leader 路径硬抛错补发 error 链哨兵（mirror dogfood 路径 c2ee0b8 形态——
      // closureChainIpc catch 的 emitChainEvent 哨兵）。缺哨兵时 leader done 事件兜底
      // finalizeChainRun('aborted')——infra 硬错误被误标成用户中断。
      ctx.emitChainEvent?.({
        type: 'chain-node-done',
        data: { nodeId: CHAIN_RUN_SENTINEL_NODE_ID, status: 'error' },
      });
      return {
        title: `write_chapter: ${params.episodeId}`,
        output: `Chapter chain failed: ${message}`,
      };
    }
  },
});
