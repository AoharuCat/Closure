import type { z } from 'zod';
import type { ReusableAgentNodeContract } from '@orison/shared-contracts';
import {
  buildCompileReport,
  buildStoryPlanSegment,
  chapterBriefSchema,
  computeReadiness,
  episodeOutlineSchema,
  isSceneInEpisode,
  manipulationDirectiveSchema,
  readGrowthCurves,
  readSettingsCompileSegments,
  type BriefCharacterProgression,
  type BriefPlotPoint,
  type BriefPromiseTask,
  type BriefReadiness,
  type BriefEmotionTarget,
  type ChapterBrief,
  type InfoReleaseMap,
  type ManipulationDirective,
  type PromiseBeat,
  type PromiseEntry,
  type PromiseRegistry,
  type SceneGraph,
  type SceneNode,
  type StoryDecision,
  type WorldStateSnapshot,
  collectRelevantDecisions } from '@orison/shared-contracts';
import { fetchWorldStateSnapshotsViaTool } from './world-state-query';
import type { AgentNode, NodeResult, NodeRunInput } from '../contracts/run';
import { logger } from '../logger';

// ── Story 4.0 写章战术链段：brief 编译节点（纯代码，design §4.3 / implement.md 3.1）──
//
// brief 是主笔真正拿在手里的东西（conclusions §3.9）。本节点 = 「把 leader 填的 LLM 段 + 从
// scene_graph 汇编的纯代码段 #6 组装成完整 ChapterBrief」的纯代码编译器（无 LLM/fs/db）。
//
// 段切分（design §3 表 / .trellis/spec/core/creative-vs-mechanical.md）：
// - LLM 段 #1-5,10（goal/参数/信息控制/节奏/禁写/情绪目标）= leader 上游填 → 从 chapter_brief_input 透传。
// - 纯代码段 #6 关键剧情点 = 本节点汇编：filter scene_graph.nodes 命中本章（episodeId）的场 +
//   presentationSpans M:N 连续性标注（Story 1.8）。state-at-T = Story 6.6 Phase D 接通（8.1 Step 5 批量化）：
//   fetchWorldStateSnapshotsViaTool 一次批量 IPC 得本章各场 snapshot（checkpoint-backed）→ 按场 storyTime
//   贴回（「该场前已建立状态」反哺 Writer）。
// - 纯代码段 #8 未决决策警告 = 本节点汇编（4.1 Step 3）：filter story_decisions artifact 的 open 决策
//   （relatedEpisodeId 命中本章或全局 open）→ 投影 {id,summary,risk}。源 = project.yaml novel.story_decisions[]。
// - 纯代码段 #7 Promise 任务 = compilePromiseTasks（from promise_registry，6.5 接通）：filter 本章相关
//   beats（episodeId 匹配 OR sceneRef ∈ 本章 scenes）+ 所在 Promise 非 abandoned → join promise 主体
//   → BriefPromiseTask[]。archived 场与 abandoned 线不下发（system.md:209）。
// - （非段）characterProgressions = 本节点汇编（Story 8.5 R3 编译通道，design §4.2）：episode_outlines
//   本章 episode 的 character_progressions 主源 + growth_curve 转折点 join（linked_episode_ids 命中本章 →
//   附 turningPoint 一句）+ asset_cards character 卡 id→name 解析（写手可读显示名）。compileCharacterProgressions
//   同 #6/#7/#8 纯代码 filter+join 单 producer（leader stray 被编译值覆盖）。「不进 brief」原则合规：只携本章
//   特有 from→to + 至多一句命中转折点，弧全量归可查询 field（growth_curve）。chapterTask = 整个 brief JSON →
//   本字段自动直达 draft-writer（schema 字段路线，mirror emotionTarget）+ arc-emergence {{chapterBrief}} 对照位
//   （8.2 写时声明即获设计 vs 正文对照，design §4.4 白捡）。
//   ⚠️ 链上/IPC 双路径：growth_curve / asset_cards artifact 依赖 write_chapter post-assemble 注入（4.4/5.3 既有
//   注入点）——本节点在链中 assemble+注入之后运行，同源可读；**shell IPC 路径（closureChainIpc）不注入这两
//   artifact → 编译仅 episode 源**（join 增强 + 名字解析降级，零回归，mirror 4.4/5.3 agent-only 哲学）。
//
// **controller 2026-07-31 核实 + 2026-08-01 Step 2 更新**：scene-graph-analytics 现已提供 `isSceneInEpisode`
// （按 episode 匹配 scene 的单源 helper，Story 4.1 Step 2 统一）→ 本节点改 import 共用，不再内联
// （filter 条件 `n.episodeId === episodeId || n.presentationSpans?.some(...)`，Story 1.8 M:N presentationSpans）。
//
// chapter_brief_input artifact shape（链段装配 Step 5 / write_chapter Step 6 产）：
//   { episodeId: string, brief: ChapterBrief }
// - episodeId = 本章目标 episode（承载树原子，refs episode_outlines[].id）。brief = leader 填的 LLM 段。
// - 兼容 raw ChapterBrief（缺 episodeId 包装时）+ requirement fallback（requirement 作 episodeId 不可靠，
//   仅兜底；Step 5/6 应优先用结构化 {episodeId, brief}）。
//
// episode_outlines（可选 artifact）：连续性标注（从前章续入 / 本章 / 续到后章 / 跨章场）需要 episode
// index 排序。episode_outlines 提供 index（episodeOutlineSchema.index）。缺省 → continuity 派不出
// （undefined，诚实不造假）。链段装配 Step 5 可选注入（additive：不注入则连续性降级，场列表仍准确）。
//
// expected_downstream_consumers:
// - Story 4.0 Step 5：createChapterChainNodes 装配本节点为链段首节点（initial artifacts → chapter_brief）。
// - Story 4.1：填完整段 + status 就绪阶梯（本节点 #7/8 留空处接入）。
// - Story 6.6 Phase D：状态引擎 reduce 产 #6 state-at-T（本节点 compilePlotPoints 接通——前章 events per
//   scene storyTime 反哺；Story 8.1 Step 5 切 fetchWorldStateSnapshotsViaTool 批量 checkpoint-backed）。
// - Story 6.5：产 #7 Promise 任务（compilePromiseTasks from promise_registry，filter 本章非 abandoned beats
//   join promise 主体 → BriefPromiseTask[]；Reader-Audit promise-landing 维消费同一 promise_registry artifact）。

export const BRIEF_COMPILER_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'brief-compiler-node',
  displayName: 'Brief Compiler Node',
  inputSchemaName: 'chapterBriefInput',
  outputSchemaName: 'chapterBriefSchema',
  requiredArtifactKeys: ['chapter_brief_input', 'scene_graph'],
  // Story 8.4 B1/B2：compile_report 伴生 artifact（may-produce，mirror revision-guard producedArtifactKeys
  // 语义——每次都产；主产出仍是 chapter_brief）。
  producedArtifactKeys: ['chapter_brief', 'compile_report'],
  sideEffects: [],
};

/** chapter_brief_input 的结构化形态（leader / write_chapter 工具产）。 */
export interface ChapterBriefInput {
  episodeId: string;
  brief: ChapterBrief;
}

/** episode_outlines 条目（EpisodeOutline type 未显式导出，故本地 z.infer 推导）。 */
type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

interface ResolvedBriefInput {
  episodeId?: string;
  brief: ChapterBrief;
}

/**
 * 从 chapter_brief_input artifact 解析 {episodeId, brief}（design §4.3）。
 * 兼容两种形态：
 * - 结构化 {episodeId, brief}（canonical，Step 5/6 产）
 * - raw ChapterBrief（episodeId 退到 requirement fallback）
 * 缺省 / 非对象 → 空 brief + requirement 作 episodeId 兜底。
 */
function resolveBriefInput(raw: unknown, requirement: string): ResolvedBriefInput {
  const fallbackId = requirement.trim().length > 0 ? requirement.trim() : undefined;
  if (!raw || typeof raw !== 'object') {
    return { episodeId: fallbackId, brief: {} };
  }
  const obj = raw as Record<string, unknown>;
  if ('brief' in obj && obj.brief && typeof obj.brief === 'object') {
    return {
      episodeId: typeof obj.episodeId === 'string' && obj.episodeId.length > 0 ? obj.episodeId : fallbackId,
      brief: obj.brief as ChapterBrief,
    };
  }
  // raw ChapterBrief 形态
  return { episodeId: fallbackId, brief: obj as ChapterBrief };
}

/**
 * 从 presentationSpans 推连续性标注（design §4.3「从 N-1 续 / 本章结束 / 续到 N+1」）。
 *
 * 需 episode index 排序（ episode_outlines 提供）。无 M:N spans → 单章场（1.1 行为）→ '本章内'。
 * 无 index 解析 → undefined（诚实：连续性需 episode 序，缺则不造假）。
 *
 * 标签语义（N = 本章 episode index）：
 * - spans 仅 [N] → '本章内'
 * - spans 含前章 (<N) 且含 N → '从前章续入'
 * - spans 含 N 且含后章 (>N) → '续到后章'
 * - spans 含前章 + 后章（跨 N）→ '跨章场'
 *
 * 优化：若所有 spans 都指向本章（无跨章 episode），无需 index 解析即可判 '本章内'（spans 形态本身
 * 表明单章发布）。只有存在跨章 span 时才需 episode index 排前后序。
 */
function deriveContinuity(
  scene: SceneNode,
  targetEpisodeId: string,
  targetIdx: number | undefined,
  episodeIndexById: Map<string, number>,
): string | undefined {
  const spans = scene.presentationSpans ?? [];
  // 无 M:N spans = 单章场（1.1 行为，episodeId 直挂）→ 本章内
  if (spans.length === 0) {
    return '本章内';
  }
  // 所有 spans 都指向本章（M:N 形态但实际单章发布）→ 本章内（无需 index 解析）
  const crossEpisodeIds = spans.filter((s) => s.episodeId !== targetEpisodeId).map((s) => s.episodeId);
  if (crossEpisodeIds.length === 0) {
    return '本章内';
  }
  // 有跨章 span → 需 episode 序判前后；无 index 解析 → 派不出，不造假
  if (targetIdx === undefined) return undefined;

  const spanIndices: number[] = [];
  for (const epId of crossEpisodeIds) {
    const idx = episodeIndexById.get(epId);
    if (idx !== undefined) spanIndices.push(idx);
  }
  const hasBefore = spanIndices.some((i) => i < targetIdx);
  const hasAfter = spanIndices.some((i) => i > targetIdx);

  if (hasBefore && hasAfter) return '跨章场';
  if (hasBefore) return '从前章续入';
  if (hasAfter) return '续到后章';
  return '本章内';
}

/**
 * 汇编 #6 plotPoints（纯代码段，from scene_graph）。filter 本章涉及的场 + 连续性标注 + state-at-T。
 * scene_graph / episodeId 缺省 → 空数组（链段下游 graceful：draft-writer 读 populated、忽略空）。
 *
 * Story 6.6 Phase D：stateAtT 占位 → reduce 填充。Story 8.1 Step 5：取数批量化——本函数不再自取 patches，
 * 改收 per-storyTime snapshot Map（run() 一次 `build_world_snapshot {ats}` 批量 IPC 得，checkpoint-backed，
 * design §6）；每场按其 storyTime 贴回 snapshot（同 storyTime 场共享同一条）。reduce 在 brief-compiler 节点
 * （chain 首节点）跑——此时 closure_world_state 仅含**前章** events（本章提取器在 draft 后跑），故 stateAtT
 * 自然反映「该场 storyTime 前已建立状态」（落地公理：Writer 写该场知已建立什么）。
 *
 * @param snapshotByStoryTime  per-storyTime snapshot（fetchWorldStateSnapshotsViaTool 产，项 undefined = 该
 *                             截断点 subjects 空）；undefined = 状态引擎不可用（graceful，stateAtT 全 undefined）。
 */
function compilePlotPoints(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
  episodeOutlines: EpisodeOutline[],
  snapshotByStoryTime: Map<number, WorldStateSnapshot> | undefined,
): BriefPlotPoint[] {
  if (!sceneGraph || !episodeId) return [];

  const episodeIndexById = new Map<string, number>();
  for (const ep of episodeOutlines) episodeIndexById.set(ep.id, ep.index);
  const targetIdx = episodeIndexById.get(episodeId);

  return sceneGraph.nodes
    .filter((n) => isSceneInEpisode(n, episodeId))
    .map((n) => ({
      sceneId: n.id,
      continuity: deriveContinuity(n, episodeId, targetIdx, episodeIndexById),
      // stateAtT：reduce 该场 storyTime 前已建立状态（WorldStateSnapshot，z.unknown() 容纳）。
      // snapshot Map 缺 / 该项 undefined（subjects 空）→ undefined（graceful，不造假）。
      stateAtT: compileSceneStateAtT(n, snapshotByStoryTime),
    }));
}

/**
 * Story 6.6 Phase D / 8.1 Step 5：贴回单场 storyTime 前已建立状态为 stateAtT（BriefPlotPoint.stateAtT，z.unknown()）。
 *
 * snapshotByStoryTime 缺（状态引擎不可用）→ undefined（graceful）。snapshot.subjects 空（该 storyTime 前无
 * populated 状态）→ undefined（fetch 层已按「subjects 空→undefined」归一；贴回层再守一次防上游形态漂移）。
 * snapshot 非空 → 返 snapshot（{ at, subjects:[{subjectId,state,issueCount}] }），Writer 据此知已建立状态。
 *
 * 范式判据（ADR-3）：reduce = 纯代码（shell 侧 checkpointed fold / fallback buildWorldStateSnapshot）；
 * stateAtT 注入 brief = 副作用数据流（snapshot 经 IPC builtin 取，brief 反哺）。无语义判断（「该状态够不够」
 * 归 LLM Writer，非纯代码）。
 */
function compileSceneStateAtT(
  scene: SceneNode,
  snapshotByStoryTime: Map<number, WorldStateSnapshot> | undefined,
): BriefPlotPoint['stateAtT'] {
  if (snapshotByStoryTime === undefined) return undefined;
  const snapshot = snapshotByStoryTime.get(scene.storyTime);
  if (!snapshot || snapshot.subjects.length === 0) return undefined;
  return snapshot;
}

/**
 * 收集本章各场 storyTime（去重，首见序）——Story 8.1 Step 5 批量 ats 的输入（一次 IPC 得本章各场 snapshot；
 * 同 storyTime 场共享同 snapshot，去重控请求规模）。scene_graph / episodeId 缺 → 空数组（无场即无 ats）。
 */
function collectChapterStoryTimes(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
): number[] {
  if (!sceneGraph || !episodeId) return [];
  const seen = new Set<number>();
  const ats: number[] = [];
  for (const n of sceneGraph.nodes) {
    if (!isSceneInEpisode(n, episodeId)) continue;
    if (!seen.has(n.storyTime)) {
      seen.add(n.storyTime);
      ats.push(n.storyTime);
    }
  }
  return ats;
}

/**
 * 汇编 #8 openDecisions（纯代码段，from story_decisions artifact，4.1 Step 3 / design §3.5）。
 *
 * filter `status:'open'` 决策 + relatedEpisodeId 命中本章 episodeId **或** relatedEpisodeId 缺省（= 全局
 * open 决策，所有章都警告，conclusions §3.9 第 8 段），投影到 brief #8 警告子集 `{id, summary, risk}`。
 *
 * 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical）：filter + 投影 = 纯代码查询，非语义裁断。
 * 不判「这条决策重不重要」（归 LLM / 人写 story_decisions 时定），只 filter open + 按 episode 命中。
 *
 * story_decisions 缺 / 空 / 非数组 → []（graceful，不造假、不抛）。源由 assembleChapterChainArtifacts
 * safeParse storyDecisionSchema.array() 防御，故数组项形状可信（status / relatedEpisodeId / id / summary
 * / risk 字段齐）。
 */
function compileOpenDecisions(
  storyDecisions: StoryDecision[] | undefined,
  episodeId: string | undefined,
): Array<{ id: string; summary: string; risk: string }> {
  // Story 2.6：filter 单源化——collectRelevantDecisions（与 Reader-Audit decidedDecisions 同一纯函数，
  // 防两处各写一遍漂移）。行为零变：status open + relatedEpisodeId 命中本章或全局（无 newestFirst，
  // 保持原输出序）。投影 {id, summary, risk} 不变。
  return collectRelevantDecisions(storyDecisions, {
    status: 'open',
    ...(episodeId !== undefined ? { episodeId } : {}),
  }).map((d) => ({ id: d.id, summary: d.summary, risk: d.risk }));
}

/**
 * Story 6.5 §7：轻量 promise_registry 形态守卫（对象 + promises/beats 数组）。
 *
 * assembleChapterChainArtifacts safeParse promiseRegistrySchema 后形状可信，但本节点防御坏 artifact
 * （直测 / 未走 assemble 的链段 / 坏 IPC payload）→ undefined（compilePromiseTasks 降级 []，不造假）。
 * mirror story_decisions 的 `Array.isArray` 守门，多一层嵌套数组校验（registry 是 {promises,beats} 对象）。
 */
function isValidPromiseRegistry(v: unknown): v is PromiseRegistry {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as { promises?: unknown; beats?: unknown };
  return Array.isArray(r.promises) && Array.isArray(r.beats);
}

/**
 * Story 6.3 §3 段②：轻量 info_release_map 形态守卫（对象 + entries 数组）。
 *
 * assembleChapterChainArtifacts safeParse infoReleaseMapSchema 后形状可信，但本节点防御坏 artifact
 * （直测 / 未走 assemble 的链段 / 坏 IPC payload）→ undefined（compileInfoRelease 降级空，不造假）。
 * mirror isValidPromiseRegistry 的嵌套数组校验（registry 是 {promises,beats}，map 是 {entries,...}）。
 */
function isValidInfoReleaseMap(v: unknown): v is InfoReleaseMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as { entries?: unknown };
  return Array.isArray(m.entries);
}

/**
 * CR-inforelease-steer-3（BMad CR）：#3 merge precedence 的「已填」判据 helper。
 *
 * design §6「已填」= 非空 intent（非空串 ''）。`??` 视空串 '' 为已填（blocks Director 的值）--
 * leader 上游可能产空串 intent（toolParam 空档 / placeholder）。本 helper：非空串（trim 后 length>0）
 * -> 返原值（leader 已填优先）；空串 / 非串 / undefined -> 返 undefined（Director 补）。
 *
 * 纯代码机械投影（范式判据 ✓）--只判字符串非空，非语义。
 */
function nonEmpty(s: string | undefined): string | undefined {
  return typeof s === 'string' && s.trim().length > 0 ? s : undefined;
}

/**
 * 收集本章涉及场的 id 集合（isSceneInEpisode 单源，mirror compilePlotPoints filter 逻辑）。
 *
 * scene_graph / episodeId 缺 → 空集（compilePromiseTasks 仅 episodeId 匹配路径，实际也空 → 无 beat）。
 *
 * E6 fix：导出供 Reader-Audit chapter-nodes 复用（promiseLedger var filter 本章 beats 需同一 sceneIds 集合，
 * mirror compilePromiseTasks filter，避免全 registry scope 泄漏——design §8.2 / research reader-audit-landing-check §Q4）。
 */
export function collectChapterSceneIds(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!sceneGraph || !episodeId) return ids;
  for (const n of sceneGraph.nodes) {
    if (isSceneInEpisode(n, episodeId)) ids.add(n.id);
  }
  return ids;
}

/**
 * Story 6.5 §7/§8（E6 fix）：filter promise_registry 到本章自洽子集（promises + beats）。
 *
 * 纯代码查询（design §7 filter 逻辑单源，DRY）：本章相关 beats（episodeId 匹配 OR sceneRef ∈ 本章 scenes）
 * + 所属 Promise（非 abandoned，system.md:209）→ 自洽子集 { promises, beats }（命中的 beats + 拥有这些 beats
 * 的非 abandoned promises）。无本章 beat 的 promise 不返回（不属于本章「活跃 Promise」）。
 *
 * 复用消费者（E6 DRY，两消费者同 filter 单源）：
 * - brief-compiler #7 compilePromiseTasks：filter 后 map 成 BriefPromiseTask[]（下发给 Writer）。
 * - Reader-Audit chapter-nodes promiseLedger var：filter 后 JSON.stringify 喂 L2（mirror compilePromiseTasks
 *   filter，避免 scope 泄漏——全 registry 会让 LLM 误报后章 Promise 为 missing-payoff / 跨章干扰，design §8.2）。
 *
 * archived 场不下发（system.md:209）：SceneNode 当前无 status 字段（scene-archived 概念未落地），故本 filter
 * 现等效「全部非 archived」——待 Scene status 字段引入后在此加 `sceneStatus !== 'archived'` 过滤（deferred
 * 不造假：现状无 archived 场概念，filter 透传，Reader-Audit 落地检查仍守 per-chapter scope）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：filter = 纯代码结构查询（按 episodeId/sceneRef + status 结构
 * 过滤），非语义。不判「这条 Promise 本章该不该推进 / 节拍合不合理」（归 promise-emergence-node LLM 登记
 * + 人工作台 authoring）。
 *
 * graceful：registry 缺 / 非 registry 形态 / promises 或 beats 空 → 空子集（不造假、不抛，mirror #6/#8
 * 缺源降级）。assembleChapterChainArtifacts safeParse promiseRegistrySchema 后形状可信，本函数对 unknown
 * 入参再防御一层（直测 / 未走 assemble 的链段 / 坏 IPC payload）。
 *
 * @param promiseRegistry  promise_registry artifact（assembleChapterChainArtifacts 注入）或任意 unknown 值。
 * @param episodeId        本章目标 episode id；undefined → 仅 sceneIds 命中路径。
 * @param sceneIds         本章涉及场 id 集合（collectChapterSceneIds 从 sceneGraph 算；isSceneInEpisode 单源）。
 * @returns                自洽子集 { promises, beats }（本章相关 beats + 所属非 abandoned promises；空 = 无本章节拍）。
 */
export function filterPromiseRegistryForChapter(
  promiseRegistry: unknown,
  episodeId: string | undefined,
  sceneIds: ReadonlySet<string>,
): { promises: PromiseEntry[]; beats: PromiseBeat[] } {
  if (!isValidPromiseRegistry(promiseRegistry)) return { promises: [], beats: [] };
  if (promiseRegistry.promises.length === 0 || promiseRegistry.beats.length === 0) {
    return { promises: [], beats: [] };
  }

  // promise 主体 lookup（id → entry）；abandoned 线不下发（system.md:209）。
  const promiseById = new Map<string, PromiseEntry>();
  for (const p of promiseRegistry.promises) {
    if (p.status === 'abandoned') continue;
    promiseById.set(p.id, p);
  }
  if (promiseById.size === 0) return { promises: [], beats: [] };

  const filteredBeats: PromiseBeat[] = [];
  const ownerIds = new Set<string>();
  for (const beat of promiseRegistry.beats) {
    // 本章相关：episodeId 匹配 OR sceneRef ∈ 本章 scenes（design §7）。
    const relevant =
      (episodeId !== undefined && beat.episodeId === episodeId) || sceneIds.has(beat.sceneRef);
    if (!relevant) continue;
    const promise = promiseById.get(beat.promiseId);
    if (!promise) continue; // beat 的 Promise abandoned 或缺失 → 跳过（不下发）
    filteredBeats.push(beat);
    ownerIds.add(promise.id);
  }
  if (filteredBeats.length === 0) return { promises: [], beats: [] };

  // 自洽子集：只返回拥有命中 beats 的 promise（无本章 beat 的 promise 不返回）。
  const filteredPromises = [...promiseById.values()].filter((p) => ownerIds.has(p.id));
  return { promises: filteredPromises, beats: filteredBeats };
}

/**
 * 汇编 #7 promiseTasks（纯代码段，from promise_registry，Story 6.5 / design §7）。
 *
 * filter 本章相关的 beats（episodeId 匹配 OR sceneRef ∈ 本章 scenes）+ 所在 Promise 非 abandoned
 * （abandoned 线不下发，system.md:209）→ join promise 主体 → 产本章 Promise 任务节拍 BriefPromiseTask[]。
 *
 * filter 逻辑经 `filterPromiseRegistryForChapter` 单源（E6 fix：与 Reader-Audit promiseLedger var 同 filter，
 * 避免两消费者 filter 分叉致 scope 泄漏 / 误报）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：filter + join = 纯代码查询（按 episodeId/sceneRef 结构查询 +
 * promise status 结构过滤），非语义。不判「这条 Promise 本章该不该推进 / 节拍合不合理」（归
 * promise-emergence-node LLM 登记 + 人工作台 authoring）。
 *
 * graceful：registry 缺 / promises 或 beats 空 → []（不造假、不抛，mirror #6/#8 缺源降级）。源由
 * assembleChapterChainArtifacts safeParse promiseRegistrySchema 防御 + filterPromiseRegistryForChapter 内
 * isValidPromiseRegistry 守门，故 promises/beats 项形状可信（id/promiseId/sceneRef/kind/status/title/summary 字段齐）。
 *
 * @param promiseRegistry  promise_registry artifact（assembleChapterChainArtifacts 注入）；非合法形态 → []。
 * @param episodeId        本章目标 episode id；undefined → 仅 sceneIds 命中路径（实际 sceneIds 也空 → []）。
 * @param sceneIds         本章涉及场 id 集合（collectChapterSceneIds 从 sceneGraph 算；isSceneInEpisode 单源）。
 * @returns                BriefPromiseTask[]（本章 Promise 任务节拍；空 = 无本章登记节拍，draft-writer 正常写）。
 */
function compilePromiseTasks(
  promiseRegistry: PromiseRegistry | undefined,
  episodeId: string | undefined,
  sceneIds: ReadonlySet<string>,
): BriefPromiseTask[] {
  const { promises, beats } = filterPromiseRegistryForChapter(promiseRegistry, episodeId, sceneIds);
  if (promises.length === 0 || beats.length === 0) return [];

  const promiseById = new Map<string, PromiseEntry>();
  for (const p of promises) promiseById.set(p.id, p);

  const tasks: BriefPromiseTask[] = [];
  for (const beat of beats) {
    const promise = promiseById.get(beat.promiseId);
    if (!promise) continue;

    const task: BriefPromiseTask = {
      promiseId: promise.id,
      title: promise.title,
      summary: promise.summary,
      beatKind: beat.kind,
      sceneRef: beat.sceneRef,
    };
    // optional 字段仅在源 promise/beat 有值时带上（免空串/undefined 落入 brief 干扰 writer）。
    if (promise.category !== undefined) task.category = promise.category;
    if (beat.note !== undefined) task.note = beat.note;
    if (promise.payoffExpectation !== undefined) task.payoffExpectation = promise.payoffExpectation;
    tasks.push(task);
  }
  return tasks;
}

/**
 * Story 6.3 §3 段②：汇编 #3 信息控制 + manipulationDirectives（纯代码段，from info_release_map）。
 *
 * filter 本章相关的 entries（episodeId 匹配 OR sceneRef ∈ 本章 scenes，mirror filterPromiseRegistryForChapter
 * relevance）→ 每条 entry.directive 投影成 #3 自然语言字段（mode→字段结构映射 design §3 段② + §5 D7）+
 * 收集 manipulationDirectives[] structured（供 Reader-Audit L2 forbiddenMoves 裁判）。
 *
 * mode→字段映射（design §3 段②，纯代码结构映射非语义——「该透露什么」归 Director LLM 已在产 directive 时定）：
 * - reveal_first       → readerKnows（前置透露给读者）
 * - sustain_unknown    → mustHide（维持未知）
 * - method_foreseen    → hintOnly（方法预期，只暗示）
 * - subjective_mislead → mustHide + hintOnly（主观误导：隐瞒真相 + 引导误判）
 * actions/forbiddenMoves/target → 追加细节（forbiddenMoves → mustHide「禁止透露：...」精确可验供 L2；
 *   withhold → mustHide 保留 / plant → hintOnly 埋伏暗示 / release → readerKnows 释放 /
 *   dramatic_irony → readerKnows 读者先知 + hintOnly 对角色隐瞒）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：mode→字段映射 = 纯代码结构映射（enum→#3 字段 key），非语义。
 * 不判「该透露什么」（归 Director LLM 已判）。forbiddenMoves 违规裁判归 L2（6.3 段③，Reader-Audit 复用
 * 6.2 info-gap 维信号路径）。本函数只做机械结构投影，Director 决定的语义内容经 directive 携带来。
 *
 * graceful：map 缺 / entries 空 / 无本章匹配 / entry 无 directive → { infoControl: {}, directives: [] }
 * （mirror compilePromiseTasks 缺源降级，不造假、不抛）。caller 据 directives.length 决定是否填
 * manipulationDirectives（空 → undefined，免传空数组违 .min(1) 二态契约）。
 *
 * @param infoReleaseMap  info_release_map artifact（assembleChapterChainArtifacts 注入）；非合法形态 → 空。
 * @param episodeId       本章目标 episode id；undefined → 仅 sceneIds 命中路径。
 * @param sceneIds        本章涉及场 id 集合（collectChapterSceneIds 从 sceneGraph 算；isSceneInEpisode 单源）。
 * @returns               { infoControl: #3 字段 fragments（readerKnows/protagonistKnows/mustHide/hintOnly），
 *                         directives: ManipulationDirective[]（供 brief.manipulationDirectives） }。
 */
function compileInfoRelease(
  infoReleaseMap: InfoReleaseMap | undefined,
  episodeId: string | undefined,
  sceneIds: ReadonlySet<string>,
): {
  infoControl: { readerKnows?: string; protagonistKnows?: string; mustHide?: string; hintOnly?: string };
  directives: ManipulationDirective[];
} {
  if (!infoReleaseMap || infoReleaseMap.entries.length === 0) {
    return { infoControl: {}, directives: [] };
  }

  const readerKnowsParts: string[] = [];
  const mustHideParts: string[] = [];
  const hintOnlyParts: string[] = [];
  const directives: ManipulationDirective[] = [];

  for (const entry of infoReleaseMap.entries) {
    // 本章相关：episodeId 匹配 OR sceneRef ∈ 本章 scenes（mirror filterPromiseRegistryForChapter relevance）。
    const relevant =
      (episodeId !== undefined && entry.episodeId === episodeId) || sceneIds.has(entry.sceneRef);
    if (!relevant) continue;
    let directive = entry.directive;
    if (!directive) continue; // 无 directive 的 entry 跳过（无操控指令不下发）

    // CR-inforelease-steer-1（BMad CR）：per-entry directive shape 守卫。isValidInfoReleaseMap 只守 entries
    // 数组形态，不验 directive 子结构--bypass-assemble 路径（直测 / 坏 IPC payload / 未走 assemble 的链段）
    // 可能带坏 directive（缺 actions / 坏 mode / actions 非数组）-> 不守卫则 for-of directive.actions 抛
    // TypeError 违「不抛」，或 directives.push 坏 directive 致 chapterBriefSchema.safeParse 失败 poison brief。
    // mirror CR-4.1-07 坏条目单独丢不全丢：safeParse 失败 -> continue（丢该条 directive，好条目仍合入）。
    // 复赋 directive 为 validated data（let）-> 后续 mode/actions/forbiddenMoves/push 全用 validated 值。
    const directiveResult = manipulationDirectiveSchema.safeParse(directive);
    if (!directiveResult.success) continue;
    directive = directiveResult.data;

    const targetDesc = directive.target ?? '（未指定目标）';

    // mode→字段映射（design §3 段② + §5 D7，纯结构映射非语义）
    switch (directive.mode) {
      case 'reveal_first':
        readerKnowsParts.push(`${targetDesc} 已向读者前置透露`);
        break;
      case 'sustain_unknown':
        mustHideParts.push(`维持未知：${targetDesc}`);
        break;
      case 'method_foreseen':
        hintOnlyParts.push(`方法预期，仅暗示：${targetDesc}`);
        break;
      case 'subjective_mislead':
        mustHideParts.push(`主观误导，隐瞒真相：${targetDesc}`);
        hintOnlyParts.push(`引导误判：${targetDesc}`);
        break;
    }

    // actions → 追加细节（design §3 段② actions/forbiddenMoves/target → 追加 mustHide/hintOnly/readerKnows）
    for (const action of directive.actions) {
      switch (action) {
        case 'plant':
          hintOnlyParts.push(`埋伏：${targetDesc}`);
          break;
        case 'withhold':
          mustHideParts.push(`保留：${targetDesc}`);
          break;
        case 'release':
          readerKnowsParts.push(`释放：${targetDesc}`);
          break;
        case 'dramatic_irony':
          readerKnowsParts.push(`戏剧反讽（读者先知）：${targetDesc}`);
          hintOnlyParts.push(`对角色隐瞒：${targetDesc}`);
          break;
      }
    }

    // forbiddenMoves → mustHide「禁止透露：...」（精确可验，供 Reader-Audit L2 裁判，ADR-3 L133）
    if (directive.forbiddenMoves && directive.forbiddenMoves.length > 0) {
      mustHideParts.push(`禁止透露：${directive.forbiddenMoves.join('、')}`);
    }

    directives.push(directive);
  }

  const infoControl: {
    readerKnows?: string;
    protagonistKnows?: string;
    mustHide?: string;
    hintOnly?: string;
  } = {};
  if (readerKnowsParts.length > 0) infoControl.readerKnows = readerKnowsParts.join('；');
  if (mustHideParts.length > 0) infoControl.mustHide = mustHideParts.join('；');
  if (hintOnlyParts.length > 0) infoControl.hintOnly = hintOnlyParts.join('；');
  return { infoControl, directives };
}

/**
 * Story 5.2：汇编 brief #10 emotionTarget（章级情绪目标，mirror compileInfoRelease 的 leader-vs-Director merge）。
 *
 * **章级 emotionTarget 由 Director 独立产**（design §5 D2：steer 无 per-scene 源无法 rollup + 情绪整体性归 LLM），
 * 本函数**不做 per-scene points → 章级 rollup**（那会机械选「代表情绪」= 暗藏语义判断，违范式）。per-scene
 * emotion_curve.points[] 经 emotion_curve artifact 透传供 5.3 verify-loop arc 比对 + 5.4 Reader-Audit（本节点不编 per-scene 进 brief，
 * brief #10 是章级，per-scene 在 #6 plotPoints 体系外另走 emotion_curve 持久化）。
 *
 * merge precedence（mirror compileInfoRelease #3 nonEmpty merge，leader 已填字段优先 = 人意图硬约束）：
 * 字段级 merge（leader 非空串/非空对象优先，Director 补未填）—— emotion/emotionEnd/steer 用 nonEmpty（trim 非空串），
 * vad/vadEnd 用 truthy（非 null 对象；nullish 容 LLM 产 null 但不进 brief 干扰 Writer）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：nonEmpty merge = 纯代码机械字符串/对象判空（非语义）。不判
 * 「这个情绪目标好不好」（归 Director LLM 产 + Reader-Audit 5.4 裁）。emotion 语义词 + steer + VAD 投影皆 Director 已产。
 *
 * graceful：leader + Director emotionTarget 全缺 / 全空 → undefined（brief #10 optional，Writer 照写无情绪 steer）。
 * director_emotion_target artifact 缺（Director 未产 / parse 失败 / 跳过）→ 仅用 leader 的。
 *
 * @param leaderEmotionTarget   leader 填的章级 emotionTarget（leaderBrief.emotionTarget，人意图硬约束优先）。
 * @param directorEmotionTarget Director 产的章级 emotionTarget（initialArtifacts['director_emotion_target']，5.2）。
 * @returns                     merge 后的 BriefEmotionTarget（字段级 leader 优先），全空 → undefined。
 */
function compileEmotionTarget(
  leaderEmotionTarget: BriefEmotionTarget | undefined,
  directorEmotionTarget: BriefEmotionTarget | undefined,
): BriefEmotionTarget | undefined {
  const leader = leaderEmotionTarget ?? {};
  const director = directorEmotionTarget ?? {};
  const emotion = nonEmpty(leader.emotion) ?? nonEmpty(director.emotion);
  const emotionEnd = nonEmpty(leader.emotionEnd) ?? nonEmpty(director.emotionEnd);
  const steer = nonEmpty(leader.steer) ?? nonEmpty(director.steer);
  // vad/vadEnd 成对（BLIND-2/EDGE-3 fix）：取自同一 producer（leader 优先有 vad 的），免跨 producer 混搭
  // （leader.vad + director.vadEnd = 两情绪模型的起止拼接，语义不连贯）+ orphan vadEnd（有终点无起点）。
  // Director prompt 契约「vad 与 vadEnd 成对（有 vadEnd 必有 vad）」；5.1 schema 故意不耦合（vad?/vadEnd? 独立
  // optional，pairing 是创作 prompt 约束非 schema 门禁），此处 merge 层守成对。
  const leaderHasVad = leader.vad != null;
  const directorHasVad = director.vad != null;
  const vadSource = leaderHasVad ? leader : directorHasVad ? director : undefined;
  const vad = vadSource?.vad;
  const vadEnd = vadSource?.vadEnd;

  if (emotion === undefined && emotionEnd === undefined && steer === undefined && !vad && !vadEnd) {
    return undefined;
  }
  const result: BriefEmotionTarget = {};
  if (emotion !== undefined) result.emotion = emotion;
  if (emotionEnd !== undefined) result.emotionEnd = emotionEnd;
  if (steer !== undefined) result.steer = steer;
  if (vad) result.vad = vad;
  if (vadEnd) result.vadEnd = vadEnd;
  return result;
}

/**
 * Story 8.5 R3：汇编 characterProgressions（非段·structured 字段，mirror manipulationDirectives 先例；
 * design §4.2 编译通道）。三源：
 *
 * 1. **主源**：episode_outlines 中本章 episodeId 对应 episode 的 character_progressions（`{characterId, from, to}`，
 *    episode-planner 设计的「本章角色从 X 走向 Y」）。episode 缺 / episodeId 缺 / progressions 空或缺 →
 *    undefined（**缺源不设字段** graceful，mirror #7 缺 promise_registry 的不造假哲学；区别于 #7 恒返 []
 *    ——本字段二态 = 缺失「无弧走向（默认，主笔照写）」/ ≥1「有走向」，episode 无 progressions 与字段缺失
 *    同态，故统一 undefined 非空数组）。
 * 2. **join 增强（可选源）**：growth_curve artifact（write_chapter post-assemble 注入，4.4 既有注入点）经
 *    readGrowthCurves 单源归一（arc-coverage.ts，三形态宽容读）→ 该角色 turning_points 中 linked_episode_ids
 *    命中**本章**的第一条 → 附 turningPoint（转折点原文一句，设计语境）。命中他章不串章；同角色多转折点
 *    命中本章取首现（机械「至多一句」，不判哪条更重要——那归弧设计 LLM）。artifact 缺（IPC 路径）/
 *    坏形态 / 无命中 → 不附（**仅 episode 源降级**，零回归）。
 * 3. **名字解析（可选源）**：asset_cards artifact（write_chapter post-assemble 注入，5.3 既有注入点）character
 *    卡（type='character'）id→name → 附 characterName（写手可读显示名）。卡片缺失 / 非 character 卡 / name
 *    非法 → characterName 不设字段（graceful，characterId 仍 traceable）。artifact 缺（IPC 路径）→ 全部不解析。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：filter episode + join 转折点 + id→name 查表 = 纯代码结构查询
 * （mirror compilePromiseTasks/compilePlotPoints 同构，design §1 表）。不判「这条走向好不好 / 转折点该不该
 * 本章兑现」（设计归 episode-planner/弧设计 LLM，正文兑现裁判归 4.4/8.2 弧维）。
 *
 * 防御（episode_outlines artifact 是 assemble raw 透传、无 safeParse；growth_curve readGrowthCurves 归一时
 * 坏条目结构直传）：per-entry 形态守卫——坏 progression 条目（缺 characterId/from/to）单独丢，好条目保留
 * （mirror CR-4.1-07）；全坏 → undefined（同缺源语义）。
 *
 * @param episodeOutlines  episode_outlines artifact（assemble optional 注入，raw 透传）。
 * @param episodeId        本章目标 episode id；undefined → undefined（无源）。
 * @param growthCurveRaw   growth_curve artifact（write_chapter post-assemble 注入；IPC 路径无 → join 降级）。
 * @param assetCardsRaw    asset_cards artifact（write_chapter post-assemble 注入；IPC 路径无 → 名字不解析）。
 * @returns                BriefCharacterProgression[]（本章角色弧走向）；undefined = 缺源（brief 不设字段）。
 */
function compileCharacterProgressions(
  episodeOutlines: EpisodeOutline[],
  episodeId: string | undefined,
  growthCurveRaw: unknown,
  assetCardsRaw: unknown,
): BriefCharacterProgression[] | undefined {
  if (episodeId === undefined) return undefined;
  const episode = episodeOutlines.find((ep) => ep?.id === episodeId);
  if (!episode) return undefined;
  // episode.character_progressions schema 有 .default([])，但 artifact 是 raw 透传（bypass-parse 路径可能缺字段）
  // → Array.isArray 守卫。空数组（过场章确无进展）与字段缺失同态 → undefined。
  const progressions = episode.character_progressions;
  if (!Array.isArray(progressions) || progressions.length === 0) return undefined;

  // join 增强：growth_curve 归一 → per-character 本章命中转折点（首现）。readGrowthCurves 坏形态 → undefined
  // → 空曲线集（join 降级，不抛）；归一的结构直传条目 turning_points 可能非数组 → Array.isArray 守卫兜底
  // （mirror collectArcCandidates CR-001）。
  const turningPointByCharacter = new Map<string, string>();
  for (const curve of readGrowthCurves(growthCurveRaw) ?? []) {
    if (turningPointByCharacter.has(curve.character_id)) continue; // 首现已定（首现序）
    const tps = Array.isArray(curve.turning_points) ? curve.turning_points : [];
    const hit = tps.find(
      (tp) =>
        Array.isArray(tp?.linked_episode_ids) &&
        tp.linked_episode_ids.includes(episodeId) && // 命中他章不串章（strict includes 本章 id）
        typeof tp.turning_point === 'string' &&
        tp.turning_point.length > 0,
    );
    if (hit) turningPointByCharacter.set(curve.character_id, hit.turning_point);
  }

  // 名字解析：asset_cards character 卡 id→name（mirror emotion-verify extractCharacterCards 守卫：type='character'
  // + id/name 字符串；坏条目跳过不抛）。非 character 卡不参与（防 location/prop 卡同名误解析）。
  const nameByCharacterId = new Map<string, string>();
  if (Array.isArray(assetCardsRaw)) {
    for (const card of assetCardsRaw) {
      if (!card || typeof card !== 'object') continue;
      const c = card as { type?: unknown; id?: unknown; name?: unknown };
      if (c.type !== 'character') continue;
      if (typeof c.id !== 'string' || c.id.length === 0) continue;
      if (typeof c.name === 'string' && c.name.length > 0) {
        if (!nameByCharacterId.has(c.id)) nameByCharacterId.set(c.id, c.name);
      }
    }
  }

  const out: BriefCharacterProgression[] = [];
  for (const progression of progressions) {
    // per-entry 守卫（raw 透传）：坏条目单独丢，好条目保留（mirror CR-4.1-07）。
    if (!progression || typeof progression !== 'object') continue;
    const { characterId, from, to } = progression as {
      characterId?: unknown;
      from?: unknown;
      to?: unknown;
    };
    if (typeof characterId !== 'string' || characterId.length === 0) continue;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    const entry: BriefCharacterProgression = { characterId, from, to };
    const name = nameByCharacterId.get(characterId);
    if (name !== undefined) entry.characterName = name;
    const turningPoint = turningPointByCharacter.get(characterId);
    if (turningPoint !== undefined) entry.turningPoint = turningPoint;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** W2 遗留①：recompileHints 注入上限（防坏 plan_review 大 findings 阵列撑爆 brief；reviewer 输出本就少）。 */
const RECOMPILE_HINTS_CAP = 8;

/**
 * W2 遗留①：从上一轮 `plan_review` artifact 抽 hard findings 作重编意图（规划环 revise 回环的实质
 * 输入——brief-compiler 纯代码确定性，无注入则原样重编空转）。仅 verdict='revise' 时注入（pass/escalate
 * 无回环语义；soft-only revise 已被 A2 parseOutput 归一为 pass）；坏形态防御性丢（mirror per-element
 * 哲学）。纯机械投影（dimension/grounding/note 三字段直取）。
 */
function collectRecompileHints(
  planReview: unknown,
): Array<{ dimension: string; grounding: string; note: string }> {
  if (!planReview || typeof planReview !== 'object' || Array.isArray(planReview)) return [];
  const review = planReview as { verdict?: unknown; findings?: unknown };
  if (review.verdict !== 'revise' || !Array.isArray(review.findings)) return [];
  const hints: Array<{ dimension: string; grounding: string; note: string }> = [];
  for (const f of review.findings) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const finding = f as { severity?: unknown; dimension?: unknown; grounding?: unknown; note?: unknown };
    if (finding.severity !== 'hard') continue;
    if (
      typeof finding.dimension !== 'string' || finding.dimension.length === 0 ||
      typeof finding.grounding !== 'string' || finding.grounding.length === 0 ||
      typeof finding.note !== 'string' || finding.note.length === 0
    ) {
      continue;
    }
    hints.push({ dimension: finding.dimension, grounding: finding.grounding, note: finding.note });
    if (hints.length >= RECOMPILE_HINTS_CAP) break;
  }
  return hints;
}

/**
 * brief 编译节点工厂。读 chapter_brief_input + scene_graph（+ 可选 episode_outlines）→ 输出 chapter_brief。
 * 纯函数（无 LLM/fs/db）—— chapterBriefSchema.parse 确保 shape（leader brief 可能带额外字段，parse 剥离）。
 */
export function createBriefCompilerNode(): AgentNode {
  return {
    contract: BRIEF_COMPILER_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run, requirement } = input;
      const sceneGraph = run.artifacts['scene_graph'] as SceneGraph | undefined;
      const episodeOutlines =
        (run.artifacts['episode_outlines'] as EpisodeOutline[] | undefined) ?? [];
      const { episodeId, brief: leaderBrief } = resolveBriefInput(
        run.artifacts['chapter_brief_input'],
        requirement,
      );

      // Story 8.1 Step 5：一次批量 IPC 得本章各场 snapshot（fetchWorldStateSnapshotsViaTool 经
      // build_world_snapshot builtin，checkpoint-backed——IPC 传 snapshot 非全量 patches，design §6）。
      // brief-compiler 是 chain 首节点——此时 closure_world_state 仅含前章 events（本章提取器在 draft 后跑），
      // 故 stateAtT 自然反映「该场 storyTime 前已建立状态」。工具未注册 / IPC 失败 / 无数据 → snapshots
      // undefined（graceful，stateAtT 全 undefined，4.1 既有状态不造假）。同 storyTime 场共享同一 snapshot
      // （fetchWorldStateSnapshotsViaTool 去重 ats，Map 贴回）。**stateAtT 语义零变**（Step 5 等价重构）。
      const chapterStoryTimes = collectChapterStoryTimes(sceneGraph, episodeId);
      const snapshots = await fetchWorldStateSnapshotsViaTool(run.projectPath, chapterStoryTimes);
      // 项 undefined（该截断点 subjects 空）不进 Map——.get 返 undefined，贴回层同判 stateAtT undefined。
      const snapshotByStoryTime =
        snapshots === undefined
          ? undefined
          : new Map(
              chapterStoryTimes.flatMap((at, i) =>
                snapshots[i] ? ([[at, snapshots[i]]] as const) : [],
              ),
            );

      const plotPoints = compilePlotPoints(sceneGraph, episodeId, episodeOutlines, snapshotByStoryTime);

      // story_decisions artifact（assembleChapterChainArtifacts 注入，safeParse 防御后形状可信；
      // 4.1 Step 3）。非数组 → undefined（compileOpenDecisions 降级 []）。
      const storyDecisionsArtifact = run.artifacts['story_decisions'];
      const storyDecisions: StoryDecision[] | undefined = Array.isArray(storyDecisionsArtifact)
        ? (storyDecisionsArtifact as StoryDecision[])
        : undefined;
      const openDecisions = compileOpenDecisions(storyDecisions, episodeId);

      // Story 6.5 #7：promise_registry artifact（assembleChapterChainArtifacts safeParse 注入，形状可信）。
      // 防御坏形态 → undefined（compilePromiseTasks 降级 []，不造假）。本章场 id 集合复用 isSceneInEpisode
      // 单源（同 compilePlotPoints filter 逻辑），供 beat sceneRef 命中判 + 后续 Reader-Audit 落地检查。
      const promiseRegistry = isValidPromiseRegistry(run.artifacts['promise_registry'])
        ? run.artifacts['promise_registry']
        : undefined;
      const chapterSceneIds = collectChapterSceneIds(sceneGraph, episodeId);
      const promiseTasks = compilePromiseTasks(promiseRegistry, episodeId, chapterSceneIds);

      // Story 6.3 #3：info_release_map artifact（assembleChapterChainArtifacts safeParse 注入，形状可信）。
      // 防御坏形态 → undefined（compileInfoRelease 降级空，不造假）。optional graceful（mirror cognition_snapshot
      // 模式，不进 requiredArtifactKeys）。本章场 id 集合复用 chapterSceneIds（同 compilePlotPoints filter 逻辑），
      // 供 entry.sceneRef 命中判。leader 已填 #3 字段优先（design §6 merge precedence，见下组装处）。
      const infoReleaseMap = isValidInfoReleaseMap(run.artifacts['info_release_map'])
        ? run.artifacts['info_release_map']
        : undefined;
      const { infoControl, directives } = compileInfoRelease(infoReleaseMap, episodeId, chapterSceneIds);

      // Story 5.2 #10 emotionTarget：章级情绪目标。director_emotion_target artifact（write_chapter dispatch 注入，
      // Director 章级独立产非 rollup）+ leader 已填 emotionTarget merge（leader 字段优先，mirror #3 nonEmpty）。
      // per-scene emotion_curve.points[] 不在本节点消费（5.3 verify-loop / 5.4 Reader-Audit 经持久化 emotion_curve
      // 字段读，非 brief artifact；brief #10 是章级，per-scene 在 #6 plotPoints 体系外）。
      const directorEmotionTarget = run.artifacts['director_emotion_target'] as BriefEmotionTarget | undefined;
      const emotionTarget = compileEmotionTarget(leaderBrief.emotionTarget, directorEmotionTarget);

      // Story 8.5 R3：characterProgressions 编译（非段·structured，mirror manipulationDirectives）。
      // 三源 = episode_outlines 本章 progressions（主源）+ growth_curve 转折点 join（write_chapter post-assemble
      // 注入 artifact，4.4 既有注入点）+ asset_cards character 卡 id→name（5.3 既有注入点）。IPC 路径
      // （closureChainIpc）不注入后两 artifact → 仅 episode 源编译（join/名字降级，零回归，见函数 JSDoc）。
      // 单 producer：编译值覆盖 leader stray（mirror plotPoints/promiseTasks overwrite 哲学）。
      const characterProgressions = compileCharacterProgressions(
        episodeOutlines,
        episodeId,
        run.artifacts['growth_curve'],
        run.artifacts['asset_cards'],
      );

      // settings_context artifact（assembleChapterChainArtifacts 产的设定前缀渲染串）非空 = 设定锚点存在。
      // brief-compiler 无 project 全貌，故从 settings_context 间接判设定 presence（纯结构信号，范式合规）。
      const settingsContext = run.artifacts['settings_context'];
      const settingsPresent = typeof settingsContext === 'string' && settingsContext.trim().length > 0;

      // ── 链流程重排 W2（遗留①：规划环 revise 重编意图注入）──
      //
      // brief-compiler 是纯代码编译器（同输入确定性重编）——规划环 revise 回环若不注入新输入，只会
      // 原样重编 → A2 复判 → 空转到 cap（W1d parsePlanReviewOutput 注释已标）。本处读上一轮
      // `plan_review` artifact 的 **hard findings**（revise verdict 时）机械投影为 chapter_brief
      // .recompileHints（shared schema additive 字段）——A2 复审在卡面可见（brief JSON 自带）+ 写手
      // 随 chapterTask JSON 同读（据 hints 自查/规避），环有实质输入。首圈 plan_review 缺 → 零注入
      // （零回归）；软维度 findings 不注入（revise 归一已保证 revise verdict 必有 hard finding）。
      // 纯投影不判语义（范式判据 ✓——判分归 A2 LLM）。
      const recompileHints = collectRecompileHints(run.artifacts['plan_review']);

      // 组装：LLM 段 #1-5,10 透传 leaderBrief + #6 plotPoints 汇编 + #7 promiseTasks 汇编（6.5）
      // + #8 openDecisions 汇编（4.1 Step 3）+ readiness（4.1 §3.2 就绪阶梯，纯代码算）。
      // #3 merge precedence（6.3 design §6，CRITICAL）：leader 已填字段优先（人意图硬约束），
      // Director compileInfoRelease 只补未填字段（augment 非覆盖）。manipulationDirectives[] structured
      // 供 Reader-Audit L2 forbiddenMoves 裁判（与 #3 自然语言字段并行——#3 给 Writer 读，本字段给 L2 精确裁判）。
      // #10 emotionTarget merge（5.2）：leader 字段优先，Director 补（mirror #3 nonEmpty merge）。
      const readiness: BriefReadiness = computeReadiness(leaderBrief, sceneGraph, episodeId, settingsPresent);
      const chapterBrief: ChapterBrief = {
        ...leaderBrief,
        plotPoints,
        promiseTasks,
        openDecisions,
        readiness,
        // #3 merge：leader 已填优先，Director 补未填（人意图硬约束）。
        // CR-inforelease-steer-3（BMad CR）：design §6「已填」= 非空 intent，非空串 ''。原 `??` 视 leader 空串 ''
        // 为已填（blocks Director 的值）-> 改 nonEmpty trim 检查：leader 非空串优先，空串/undefined -> Director 补。
        readerKnows: nonEmpty(leaderBrief.readerKnows) ?? infoControl.readerKnows,
        protagonistKnows: nonEmpty(leaderBrief.protagonistKnows) ?? infoControl.protagonistKnows,
        mustHide: nonEmpty(leaderBrief.mustHide) ?? infoControl.mustHide,
        hintOnly: nonEmpty(leaderBrief.hintOnly) ?? infoControl.hintOnly,
        manipulationDirectives: directives.length > 0 ? directives : undefined,
        // #10 emotionTarget（5.2）：leader + Director merge（leader 字段优先）；全空 → undefined（brief #10 optional）。
        emotionTarget,
        // #characterProgressions（8.5 R3）：episode 主源 + growth_curve join + 名字解析；缺源 → undefined
        // （brief 二态「缺失=无弧走向，主笔照写」；空 [] schema 合法但本编译不产——episode 无 progressions
        // 与字段缺失同态，统一 undefined，见 compileCharacterProgressions JSDoc）。
        characterProgressions,
        // W2 遗留①：规划环 revise 回环的重编意图（上一轮 plan_review hard findings 机械投影）。
        ...(recompileHints.length > 0 ? { recompileHints } : {}),
      };

      // Zod safeParse 确保 shape（CR-6：失败返 error artifact 走 runChain error-artifact 路径，链段不崩——
      // 与 assembleChapterChainArtifacts 的 safeParse 姿态一致；不用 .parse 抛，免绕过 error-artifact 契约）。
      // 防御 leader brief 带额外字段 / 坏类型；chapterBriefSchema 全 optional 容忍，仅在结构破坏时 reject。
      const result = chapterBriefSchema.safeParse(chapterBrief);
      if (!result.success) {
        const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return {
          stateKey: 'chapter_brief',
          artifact: {
            error: true,
            nodeId: 'brief-compiler-node',
            message: `brief schema reject: ${msg}`,
          },
        };
      }

      // ── Story 8.4 B1/B2（design §2.1/§2.2）：热层度量 + 三级降级梯（**总额判定汇总点 D3**）──
      //
      // settings_context（assemble 产，settings_context_report 段报告随 initialArtifacts 携带）与
      // chapter_brief（本节点刚编译）两编译点在此汇合：汇总两段报告 → 判总额档（L0/L1/L2）→ 降级
      // （L1 stateAtT 收窄 / L2 纯代码汇编段移出——铁律段 goal/信息控制/禁写/情绪目标等 LLM 意图段
      // 一件不动）→ compile_report 伴生 artifact。**两编译点不各自判总额**（防各判各的漏加）；判定落
      // 本节点 = leader 工具与 shell IPC 两条写章入口统一生效（mirror D2 briefHash 落点论证，
      // writer-node.ts 头注释：编译后 brief 只在链内此汇合点可见）。
      //
      // 报告经 mutate `run.artifacts['compile_report']` 伴生落盘（NodeResult 单 stateKey + mutate 写第二
      // artifact = 7.2 revision-guard load-bearing invariant：(a) chainRunner 单 key 赋值不覆盖异 key /
      // (b) 无 snapshot-restore / (c) mutate 在 persistChainSnapshot 前）。阈值 = 机械异常量级（bug 保险丝），
      // 正常写作 L0 恒真——brief 原引用返回（产物逐字节相同，零回归）。
      // R2-盲5：story_plan 段（写手稳定前缀第三块 {{storyPlan}} = selectScenesForEpisode 整段 JSON 直注）
      // 并入计量——此前不在两编译点任何一侧，场元数据机械膨胀时降级梯结构性失明。投影与
      // buildDraftWriterVars 同源（selectScenesForEpisode shared 单源 + 同 JSON 序列化；episodeId 同本节点
      // 编译用源——链上 chapter_brief_input 恒结构化形态，两处一致）。
      const settingsSegments = readSettingsCompileSegments(run.artifacts['settings_context_report']);
      const compiled = buildCompileReport(
        result.data,
        [...settingsSegments, buildStoryPlanSegment(sceneGraph, episodeId)],
      );
      run.artifacts['compile_report'] = compiled.report;
      // R2-盲1：字段级二态判定（undefined = 无降级；非空数组 = 有）——报告 degraded 恒不落空 []（schema
      // .min(1)），空数组 truthy 误 warn 的形态已不可达。
      if (compiled.report.degraded !== undefined) {
        // 降级发生 = 机械异常量级线被越过（正常写作永不触发）——warn 可观测（bug 保险丝亮灯非质量评分）。
        logger.warn(
          {
            tier: compiled.tier,
            total: compiled.report.total,
            overloaded: compiled.report.overloaded,
            actions: compiled.report.degraded.map((d) => `${d.segment}:${d.action}`).join(' | '),
          },
          'brief-compiler: 热层降级梯触发（机械异常量级——检查编译产物是否爆炸/重复注入）',
        );
      }

      return {
        stateKey: 'chapter_brief',
        artifact: compiled.brief,
      };
    },
  };
}
