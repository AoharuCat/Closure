import type { GenerateFallbackEntry, SceneGraph, ThinkingControl } from '@orison/shared-contracts';
import { mergeWorldEvents, type AxisExtraction, type MergedWorldWrite, type PerAxisEvents } from './world-state-merge';
import { createWorldExtractorNode, type WorldWriter } from './world-extractor-node';
import type { GenerateFn, LlmNodeDeps } from './llm-node';
import type { AgentNode, NodeRunInput, RunSnapshot } from '../contracts/run';
import type { WorldPatchAxis } from '@orison/shared-contracts';
import { logger } from '../logger';

// ── Story 3.4（C-A1）：旧章 world-state 补提取入口（design §3 / implement.md 1.1）──
//
// 旧章（链段接通前已写好的正文）无 world state events（extractor 只在 chapter-chain 内跑，
// redo 不重提）→ 涟漪诊断（design §2.3 graceful）对这些场标 degraded「无实际轨数据」。
// 本模块提供 standalone 补提取入口：对旧章正文跑 5 轴 createWorldExtractorNode + merge，
// mirror chapter-chain 内 world-extractor-<axis> + world-merge-node 的组合，但在 chain 外组装。
//
// 复用资产（design §3 / implement.md 1.1）：
// - createWorldExtractorNode(axis, deps)（world-extractor-node.ts）：LLM 单轴提取，不改其行为。
// - mergeWorldEvents(perAxis, episodeId)（world-state-merge.ts 纯函数）：机械组装 5 轴 → writes。
// - WorldWriter（= write_world_events builtin 调用，mirror chapter-chain.ts 装配）：落表。
//
// **幂等性**（design §3 硬要求）：per-slice idempotency —— insertWorldSlice(source='derived') 删同
// slice.id 全 patches（derived + amendment）再插。稳定 slice.id = `${episodeId}:${storyTime}`
// （mergeWorldEvents 产）。重跑同 episode 产同 slice.id → 替换不累积。**全量 clean backfill**
// （删已删章的 orphan slices）由 caller 调 resetWorldState（worldStateRepository.ts:476）先清——
// 本函数不调 resetWorldState（它是 shell db 函数，agent 侧不直碰 db；caller 负责）。
//
// **范式判据（ADR-3）**：本模块纯编排（组装 artifacts → 复用 extractor 节点 → merge → writer）。
// 提取 = LLM 语义（createWorldExtractorNode 内）；merge / 写表 = 纯代码机械。本模块零语义判断。
//
// **触发时机**（design §3）：「诊断前置检查：若无 world state 则触发 backfill」——Phase 2 ripple-diagnosis
// 节点（或 leader 侧诊断 precheck）查 world state 存在性，无则调本函数。本 Phase 1 只落核心函数 +
// 幂等测试；磁盘读 + episode→chapter 解析 + resetWorldState 触发接线的 caller 见下方 TODO。

// ════════════════════════════════════════════════════════════════════════════
// TODO（Phase 2 ripple-diagnosis 接线）：磁盘 → episode → prose 解析 + resetWorldState 触发
// ════════════════════════════════════════════════════════════════════════════
// 本模块的 backfillWorldState(input, deps) 接受**已解析**的 episode prose（caller 从磁盘读好）。
// 完整的「项目磁盘 → episode→chapter 映射 → prose 读取 → resetWorldState → backfill」orchestrator
// 属 Phase 2 ripple-diagnosis 节点（或 leader 侧诊断 precheck），因为：
// 1. **generate fn 来源**：extractor 需要 LLM generate。Phase 2 诊断节点有 generate deps（mirror
//    completeness-verify-node / Reader-Audit composite 节点的 deps 注入），自然能传给本函数。
// 2. **project 上下文**：诊断节点经 RunSnapshot.artifacts 已有 scene_graph；episode→chapter 映射
//    （resolveChapterIdForEpisode，chapter-integration.ts:231）+ chapters/*.md prose 读取在该层
//    组装（或经 scene_graph_read / chapter_read tool）。
// 3. **resetWorldState 触发**：shell db 函数，诊断节点经 write_world_events builtin 通道（registry）
//    无法直接调 resetWorldState；需 Phase 2 加一个 IPC 或在诊断前置检查（shell 侧）调。
//
// 拿不准的地方不瞎猜产坏 events：本核心函数只接受已解析的 episode prose + episodeId（机械组装），
// 不做磁盘解析推断。caller 保证 episodeId 与 prose 对齐（同一章）。

/** 5 轴顺序（mirror chapter-chain.ts CHAPTER_CHAIN_NODE_IDS 物理串行序）。 */
const BACKFILL_AXES: readonly WorldPatchAxis[] = [
  'physical',
  'cognitive',
  'emotional',
  'relational',
  'factional',
];

/** 单个旧章的补提取输入（caller 从磁盘解析好）。 */
export interface BackfillEpisodeInput {
  /** 本章 episode id（稳定 slice.id 前缀 `${episodeId}:${storyTime}`；空串 → merge 返 [] 不写）。 */
  episodeId: string;
  /** 本章正文 prose（从 chapters/{chapterId}.md 读取）。空串 → extractor 产空 extraction。 */
  prose: string;
}

/** 补提取总输入。 */
export interface BackfillInput {
  /** 待补提取的旧章集合（已解析 episodeId + prose）。按 episode.index 升序传以保 storyTime 序。 */
  episodes: BackfillEpisodeInput[];
  /**
   * 项目级 scene_graph（所有 episode 共享；extractor 经 selectScenesForEpisode 按 episodeId 精选本章场）。
   * 缺省 → extractor 拿空 sceneGraph（prompt 注入「未提供」提示，仍能从 prose 提取，storyTime 退 0）。
   */
  sceneGraph?: SceneGraph;
}

/** 补提取 deps（mirror chapter-chain.ts llmDeps + writer 装配）。 */
export interface BackfillDeps {
  /** LLM 生成函数（createWorldExtractorNode 用）。 */
  generate: GenerateFn;
  /** 模型引用（optional，同 createLlmNode deps）。 */
  modelRef?: { keyId: string; modelId: string };
  /** S4b：档位思考策略（extraction assignment 整体，与 modelRef 同源）。 */
  thinking?: ThinkingControl;
  /** 09-12 子2 fallback chains（H2 透传面）：extraction 档回退链 → extractor 节点。 */
  fallbacks?: GenerateFallbackEntry[];
  /**
   * 09-12 usage-panel：任务档位/流程标签（workflow 装配传 'extraction'——与路由同
   * slot 名；透传 LlmNodeDeps.taskType 进 generate opts → ledger task_type 列）。
   */
  taskType?: string;
  /** 链段 abort 信号（optional，缺省建永不 abort controller，同 createLlmNode）。 */
  signal?: AbortSignal;
  /**
   * 世界状态写入器（mirror WorldWriter / chapter-chain.ts writeWorldEvents 装配）。
   * 生产：caller 注入「调 write_world_events builtin」（registry.get('write_world_events')）。
   * 缺省 → 只产 writes 摘要不落表（graceful，同 world-merge-node 测试用 / 工具未注册）。
   */
  writeWorldEvents?: WorldWriter;
}

/** 单个 episode 补提取结果。 */
export interface BackfillEpisodeResult {
  episodeId: string;
  /** merge 产出的 writes（每个 = 一个 slice 的 storyTime + patch 数 + subject 数）。 */
  writes: MergedWorldWrite[];
  /** merge 是否跳过（episodeId 空串 / 全空 patches → writes=[]）。 */
  skipped: boolean;
  /** 跳过/失败原因（skipped=true 或 error 时填）。 */
  reason?: string;
}

/** 补提取总结果。 */
export interface BackfillResult {
  /** 处理的 episode 数（含跳过/失败的）。 */
  episodesProcessed: number;
  /** 有 writes 落表的 episode 数（非 skipped）。 */
  episodesWritten: number;
  /** 总 writes 数（跨 episode）。 */
  totalWrites: number;
  /** 总 patches 数（跨 writes）。 */
  totalPatches: number;
  /** 总 subjects 数（跨 writes）。 */
  totalSubjects: number;
  /** 逐 episode 结果。 */
  episodes: BackfillEpisodeResult[];
  /** 写入失败的 slice + 错误（writer 抛错时记；不崩，继续下一 write，mirror world-merge-node）。 */
  writeErrors: Array<{ episodeId: string; sliceId: string; error: string }>;
}

/**
 * 对旧章正文批量跑 5 轴 world-state 提取 + merge + 写表（standalone，chain 外）。
 *
 * 流程（per episode）：
 *  1. 构造 minimal RunSnapshot artifacts：`draft.initial={text: prose}` + `scene_graph` + `chapter_brief_input={episodeId}`。
 *     —— mirror extractor buildPrompt 读取的 3 artifact key（world-extractor-node.ts:232-241）。
 *  2. 5 轴顺序跑 createWorldExtractorNode(axis)（物理串行，mirror chapter-chain feedback-api-concurrency-no-parallel）。
 *  3. mergeWorldEvents(perAxis, episodeId) → MergedWorldWrite[]（机械组装，纯函数）。
 *  4. 逐 write 调 writeWorldEvents（若注入）；单 write 失败不崩（记 writeErrors 续跑，mirror world-merge-node）。
 *
 * **幂等**：重跑同 episode 产同 slice.id（`episodeId:storyTime`）→ insertWorldSlice(source='derived')
 * 替换不累积。全量 clean（orphan slices）caller 调 resetWorldState 先清。
 *
 * **graceful**：
 * - episodeId 空串 → merge 返 [] → skipped=true（CR-2 mirror，避 'unknown:storyTime' 跨章撞）。
 * - prose 空串 → extractor 产空 extraction（LLM 拿空 draftText）→ merge CR-E8 跳空组 → writes=[] skipped。
 * - writer 未注入 → 只产 writes 摘要（totalWrites 计数，但不落表）。
 *
 * @param input 旧章集合 + scene_graph。
 * @param deps  generate + writer。
 * @returns     总结果（逐 episode writes + 汇总计数 + writeErrors）。
 */
export async function backfillWorldState(input: BackfillInput, deps: BackfillDeps): Promise<BackfillResult> {
  const { episodes, sceneGraph } = input;
  const result: BackfillResult = {
    episodesProcessed: 0,
    episodesWritten: 0,
    totalWrites: 0,
    totalPatches: 0,
    totalSubjects: 0,
    episodes: [],
    writeErrors: [],
  };

  // 5 轴 extractor 节点（per-episode 复用同一组节点实例；buildPrompt 读 run.artifacts 故无状态）。
  const llmDeps: LlmNodeDeps = {
    generate: deps.generate,
    modelRef: deps.modelRef,
    ...(deps.thinking ? { thinking: deps.thinking } : {}),
    // 09-12 子2（H2）：extraction 档回退链透传（空链不占位）。
    ...(deps.fallbacks?.length ? { fallbacks: deps.fallbacks } : {}),
    // 09-12 usage-panel：taskType 透传（未标注不占位）。
    ...(deps.taskType ? { taskType: deps.taskType } : {}),
    signal: deps.signal,
  };
  const extractorNodes: Record<WorldPatchAxis, AgentNode> = {
    physical: createWorldExtractorNode('physical', llmDeps),
    cognitive: createWorldExtractorNode('cognitive', llmDeps),
    emotional: createWorldExtractorNode('emotional', llmDeps),
    relational: createWorldExtractorNode('relational', llmDeps),
    factional: createWorldExtractorNode('factional', llmDeps),
  };

  for (const ep of episodes) {
    result.episodesProcessed += 1;
    const epResult: BackfillEpisodeResult = { episodeId: ep.episodeId, writes: [], skipped: false };

    // CR-2 mirror：episodeId 空串 → merge 会返 []；提前标 skipped 避白跑 5 轴 LLM。
    if (!ep.episodeId) {
      epResult.skipped = true;
      epResult.reason = 'episodeId empty (avoid cross-chapter slice.id collision)';
      result.episodes.push(epResult);
      continue;
    }

    // 构造 minimal RunSnapshot（extractor buildPrompt 读 draft.initial.text + scene_graph + chapter_brief_input.episodeId）。
    const run = makeBackfillRun(ep, sceneGraph);
    // extractor 节点只读 input.run.artifacts（不读 requirement），但 NodeRunInput 类型要求 requirement。
    const nodeInput: NodeRunInput = { run, requirement: 'backfill' };

    // 5 轴物理串行提取（mirror chapter-chain 顺序驱动）。
    const perAxis: PerAxisEvents = {};
    for (const axis of BACKFILL_AXES) {
      const node = extractorNodes[axis];
      try {
        const nodeResult = await node.run(nodeInput);
        // createWorldExtractorNode 的 CR-E3 wrapper 保证：LLM 失败也产空 AxisExtraction（非 error artifact）。
        // 正常态产 AxisExtraction。类型 narrow 防御。
        const artifact = nodeResult.artifact as Partial<AxisExtraction> | undefined;
        if (artifact && typeof artifact === 'object' && 'storyTime' in artifact && Array.isArray(artifact.patches)) {
          perAxis[axis] = artifact as AxisExtraction;
        }
        // 非预期形态（理论上 CR-E3 wrapper 兜底了）→ 该轴缺省，merge 跳过。
      } catch (err) {
        // extractor 抛（仅 AbortError 传播语义；其他已被 CR-E3 wrapper 兜底）。记日志不崩该 episode。
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { episodeId: ep.episodeId, axis, err: msg },
          'backfillWorldState: extractor axis threw — skipping axis (continuing episode)',
        );
      }
    }

    // merge 5 轴 → writes（纯函数机械组装）。
    const writes = mergeWorldEvents(perAxis, ep.episodeId);
    epResult.writes = writes;

    if (writes.length === 0) {
      // merge 跳过（全空 patches / 无非空轴 / episodeId 空）—— 非错误，标 skipped。
      epResult.skipped = true;
      epResult.reason = 'merge produced no writes (empty extractions / all axes failed gracefully)';
      result.episodes.push(epResult);
      continue;
    }

    result.episodesWritten += 1;
    result.totalWrites += writes.length;
    for (const write of writes) {
      result.totalPatches += write.patches.length;
      result.totalSubjects += write.subjects.length;
      // 落表（writer 未注入 → skip，只计数）。
      if (deps.writeWorldEvents) {
        try {
          await deps.writeWorldEvents({
            // Story 8.1：episodeId 显式落列（merge 产，免 slice.id 前缀解析，design §4 写路径落列）。
            slice: { id: write.sliceId, episodeId: write.episodeId, storyTime: write.storyTime, ...(write.kind !== undefined && { kind: write.kind }), ...(write.summary !== undefined && { summary: write.summary }), title: write.title },
            patches: write.patches,
            subjects: write.subjects,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            { episodeId: ep.episodeId, sliceId: write.sliceId, err: msg },
            'backfillWorldState: writeWorldEvents failed for slice (continuing)',
          );
          result.writeErrors.push({ episodeId: ep.episodeId, sliceId: write.sliceId, error: msg });
        }
      }
    }
    result.episodes.push(epResult);
  }

  return result;
}

/**
 * 构造 standalone backfill 用的 minimal RunSnapshot（只填 extractor buildPrompt 读的 3 artifact key）。
 *
 * extractor buildPrompt（world-extractor-node.ts:232-241）读：
 * - `draft.initial`：{ text: prose }（scalarOf(draft?.text) 取正文）
 * - `scene_graph`：SceneGraph（selectScenesForEpisode + buildStoryTimeHint 用）
 * - `chapter_brief_input`：{ episodeId }（resolveEpisodeId 取 episode id）
 *
 * 其余 RunSnapshot 字段 extractor 不读，填机械默认（满足类型，mirror world-extractor.test.ts makeRun）。
 */
function makeBackfillRun(ep: BackfillEpisodeInput, sceneGraph: SceneGraph | undefined): RunSnapshot {
  return {
    runId: `backfill_${ep.episodeId}`,
    status: 'running',
    currentNodeId: null,
    projectPath: '/backfill',
    completedNodes: [],
    pendingNodes: [],
    artifacts: {
      'draft.initial': { text: ep.prose },
      ...(sceneGraph !== undefined ? { scene_graph: sceneGraph } : {}),
      chapter_brief_input: { episodeId: ep.episodeId },
    },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}
