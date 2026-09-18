import type { ReusableAgentNodeContract } from '@orison/shared-contracts';
import {
  computeChapterSceneWindow,
  detectStoryTimeDrift,
  type SceneGraph,
  type StoryTimeDriftWarning,
} from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput } from '../contracts/run';
import { logger } from '../logger';

// ── Story 8.4 C2（design §3.3）：提取器 storyTime 漂移守卫节点（纯代码薄节点）──
//
// chapter-chain 链段纯代码观察节点（无 LLM / 无 db / 无工具调用——全输入来自链内 artifacts）：
// 读本章提取 slices 的 storyTime 集（`world_state.events` artifact 的 writes[]，world-merge 节点产）
// + 本章场 storyTime 窗（`scene_graph` × episodeId，`isSceneInEpisode` 单源）→ detectStoryTimeDrift
// 纯函数比对 → 产 `storytime_drift` artifact。窗外 → warnings（**零阻断**——warning 不进 errors 不停链）。
//
// **链位理由（design §3.3 定的 chapter-summary 链位旁，挂其紧后；链流程重排 W1d 后 = 提取段 E7）**：
// 1. 输入就绪时序：`world_state.events` 自 world-merge-node（E2）已产——守卫在其后任意位
//    皆可跑；与 chapter-summary 同族（「提取落表后的机械观测步骤」：summary 物化状态账 / 本节点审
//    提取 storyTime 漂移），邻位聚拢可读。
// 2. route 终态（accept）后自然前进进提取段 → 本节点对**最终稿**一次守卫；自审环
//    [revision-optimizer..route] 不含本节点 → auto_revise 环内回环不重复守卫；redo 重跑
//    到链尾全部（orchestration-pattern 语义 2）→ 本节点重跑幂等（纯函数 over artifacts，无副作用，
//    warnings 覆盖重写）。
//
// **warning 去向（3.3 校验议题通道，mirror Story 8.4 Step 3 档案议题接线形态）**：本节点产
// `storytime_drift` artifact → summarizeRunSnapshot 抽 `summary.driftWarnings`（deliverable 豁免
// context isolation，mirror archiveIssues）→ write_chapter output 文案行呈现 → leader 主动提 +
// 对话解决（不造新通道）。**零噪音**：无 slices / 本章无归属场 / 全在窗内 → warnings 空，summary
// 不带空载荷（零痕迹）。
//
// 范式判据（ADR-3）：本节点 = 纯代码机械中转（读 artifacts → 纯函数比对 → 记录 artifact），零语义。
// 「漂移怎么处理」归人（核对 scene_graph storyTime / 重提取该章），守卫只报不判。
//
// graceful 三态（mirror chapter-summary-node「增强非硬约束」哲学）：
// - episodeId 缺（chapter_brief_input 无）→ 跳过守卫（skipped:'no_episodeId'，链不破）。
// - `world_state.events` artifact 缺（旧链 resume / bypass 路径）→ 跳过（skipped:'no_world_events'）。
// - 坏形态 writes（非数组 / 坏条目丢好条目留，per-element 哲学）→ 只守可读条目。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror chapter-summary-node / feedback-ledger-node 先例。

/** 节点产出 artifact key。 */
export const STORYTIME_DRIFT_NODE_KEY = 'storytime_drift';

const STORYTIME_DRIFT_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'storytime-drift-node',
  displayName: 'StoryTime Drift Guard Node',
  inputSchemaName: 'storyTimeDriftInput',
  outputSchemaName: 'storyTimeDriftResult',
  // graceful：requiredArtifactKeys=[]——episodeId 缺 / world_state.events 缺不阻断链（跳过守卫）。
  // pause/abort/escalate 早停时 artifact 不全，列 required 会致 chainRunner blocked（mirror
  // chapter-summary-node 注释）。
  requiredArtifactKeys: [],
  producedArtifactKeys: [STORYTIME_DRIFT_NODE_KEY],
  // 纯观测节点无副作用——sideEffects 枚举最小面用空数组（无 'none' 项；比谎报 persist 更诚实，
  // mirror brief-compiler-node sideEffects: [] 先例）。
  sideEffects: [],
};

/** storytime_drift artifact 形态（pass-through 观测记录，mirror chapter_summary_result 计数形态）。 */
export interface StoryTimeDriftArtifact {
  runId: string;
  episodeId: string | null;
  /** 守卫是否实际跑了（false + skipped = 跳过原因：无 episodeId / 无 world_state.events）。 */
  checked: boolean;
  skipped?: 'no_episodeId' | 'no_world_events';
  /** 本章场 storyTime 窗（checked 时必在——窗不可算时 detectStoryTimeDrift 返空且 checked 仍 true，
   * 消费方据 warnings 空判零漂移；窗字段缺失 = 本章无归属场场景）。 */
  windowMin?: number;
  windowMax?: number;
  warnings: StoryTimeDriftWarning[];
  summary: string;
}

/**
 * 从 chapter_brief_input artifact 解析 episodeId（mirror chapter-summary-node / world-extractor
 * resolveEpisodeId——同一解析逻辑第三消费者，保持内联同形不抽公共模块（三处各 8 行，抽公共件
 * 反增耦合面；口径漂移由链段装配测试兜住）。
 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

/**
 * 从 `world_state.events` artifact 提取本章 slices 的 {sliceId, storyTime}（防御性：非对象 /
 * writes 非数组 → 跳过守卫；坏条目丢好条目留——per-element 哲学，mirror parseAxisExtraction）。
 */
function extractSliceStoryTimes(worldEvents: unknown): { sliceId: string; storyTime: number }[] | undefined {
  if (!worldEvents || typeof worldEvents !== 'object' || Array.isArray(worldEvents)) return undefined;
  const writes = (worldEvents as { writes?: unknown }).writes;
  if (!Array.isArray(writes)) return undefined;
  const out: { sliceId: string; storyTime: number }[] = [];
  for (const w of writes) {
    if (!w || typeof w !== 'object') continue;
    const sliceId = (w as { sliceId?: unknown }).sliceId;
    const storyTime = (w as { storyTime?: unknown }).storyTime;
    if (typeof sliceId !== 'string' || sliceId.length === 0) continue;
    if (typeof storyTime !== 'number' || !Number.isInteger(storyTime)) continue;
    out.push({ sliceId, storyTime });
  }
  return out;
}

/**
 * 构造 storyTime 漂移守卫节点（纯代码，无 LLM / 无 db）。
 *
 * run 流程：解析 episodeId → 提取本章 slices storyTime 集 → 读 scene_graph → detectStoryTimeDrift
 * 纯函数比对 → 产 storytime_drift artifact（warnings 空 = 零漂移零噪音）。永不返 error artifact
 * （守卫是观测非门禁，任何输入缺失都降级跳过，链不破）。
 */
export function createStoryTimeDriftNode(): AgentNode {
  return {
    contract: STORYTIME_DRIFT_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // ── 1. episodeId（本章 episode，mirror chapter-summary / world-extractor）──
      const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      if (!episodeId) {
        logger.warn(
          { projectPath: run.projectPath },
          'storytime-drift-node: episodeId missing → skip drift guard (no episode association)',
        );
        return {
          stateKey: STORYTIME_DRIFT_NODE_KEY,
          artifact: {
            runId: run.runId,
            episodeId: null,
            checked: false,
            skipped: 'no_episodeId',
            warnings: [],
            summary: 'skip: no episodeId',
          } satisfies StoryTimeDriftArtifact,
        };
      }

      // ── 2. 本章提取 slices（world_state.events.writes——world-merge 节点产）──
      const slices = extractSliceStoryTimes(run.artifacts['world_state.events']);
      if (slices === undefined) {
        logger.warn(
          { episodeId },
          'storytime-drift-node: world_state.events artifact missing/malformed → skip drift guard (chain continues)',
        );
        return {
          stateKey: STORYTIME_DRIFT_NODE_KEY,
          artifact: {
            runId: run.runId,
            episodeId,
            checked: false,
            skipped: 'no_world_events',
            warnings: [],
            summary: 'skip: no world_state.events',
          } satisfies StoryTimeDriftArtifact,
        };
      }

      // ── 3. 纯函数比对（scene_graph 场窗 × slices storyTime 集）──
      const sceneGraph = run.artifacts['scene_graph'] as SceneGraph | undefined;
      const warnings = detectStoryTimeDrift(sceneGraph, episodeId, slices);
      if (warnings.length > 0) {
        // 漂移信号可观测（warn 日志——观测亮灯非失败；链照常继续，warning 不进 errors 零阻断）。
        logger.warn(
          {
            episodeId,
            count: warnings.length,
            drift: warnings.map((w) => `${w.sliceId}@${w.storyTime}${w.direction === 'before' ? '<' : '>'}win`).join(' | '),
          },
          'storytime-drift-node: 提取 storyTime 漂移（slices 落在本章场 storyTime 窗外——进校验议题，人核对）',
        );
      }

      // 窗字段（呈现给人核对用，computeChapterSceneWindow 与 detectStoryTimeDrift 单源）：本章无
      // 归属场时窗不可算 → 字段缺（warnings 恒空零噪音路径）。
      const window = computeChapterSceneWindow(sceneGraph, episodeId);
      return {
        stateKey: STORYTIME_DRIFT_NODE_KEY,
        artifact: {
          runId: run.runId,
          episodeId,
          checked: true,
          ...(window !== undefined ? { windowMin: window.min, windowMax: window.max } : {}),
          warnings,
          summary:
            warnings.length > 0
              ? `drift: ${warnings.length} slice(s) outside chapter scene storyTime window`
              : 'ok: all slices within chapter scene storyTime window',
        } satisfies StoryTimeDriftArtifact,
      };
    },
  };
}
