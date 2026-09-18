import type { ReusableAgentNodeContract } from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput } from '../contracts/run';
import { registry } from '../tool/registry';
import { logger } from '../logger';

// ── Story 8.1 ChapterStateSummary 物化节点（design §2 / ADR-3）──
//
// chapter-chain 链段**纯代码薄节点**（无 LLM generate，mirror feedback-ledger-node / emotion-verify-node
// 机械节点）。挂 promise-emergence-node 后、story-sync-agent 前（revision 闭环切片外，跑一次）：
// 读 chapter_brief_input 解析 episodeId → 调 materialize_chapter_summary builtin（remoteToolProxy →
// toolExecution IPC → shell worldStateHandlers.materializeChapterSummaryHandler：db + project.yaml 组装 →
// assembleChapterStateSummary 纯函数 → 单 WAL 事务 upsert closure_chapter_summary + 机会式 checkpoint）。
//
// **物化时机（design §2 链位理由；链流程重排 W1d 后 = 提取段 E6）**：summary 六字段含「伏笔状态变更/
// 未解决承诺/下章回收清单」——须在 promise-emergence（E4 写 promise_registry）之后取数才新鲜，故挂
// E4 后、E7 storytime-drift 前（提取段内部相对序由取数新鲜度决定）。route 终态（accept）后自然前进
// 进提取段 → 本节点对**最终稿**一次物化；redo 重跑（orchestration-pattern 语义 2：重跑到链尾全部）
// → 幂等 upsert last-write-wins，终轮摘要即终态（mirror world 提取器 slice.id idempotent 哲学）；
// 自审环 [revision-optimizer..route] 不含本节点 → auto_revise 环内回环不重复物化。
//
// 🔑 范式判据（ADR-3）：本节点 = 纯代码机械中转（读 episodeId → 调工具 → 记计数 artifact），无 LLM /
// 无语义判断。六字段汇编全在 shell 侧纯函数（assembleChapterStateSummary）——「查询/汇编/确定性计算」
// 归纯代码，语义裁判留给消费方（审核 LLM 读摘要判矛盾/漂移，prd 关键判断）。
//
// graceful 三态（mirror feedback-ledger-node「增强非硬约束」哲学，summary 是 DERIVED 可 backfill 重建）：
// - episodeId 缺（chapter_brief_input 无 episodeId：测试环境 / bypass 路径）→ 跳过物化（warn，链不破）。
// - materialize_chapter_summary 工具未注册（测试环境 registry 空）→ 跳过物化（warn，链不破）。
// - execute 抛错 / 返回 ok:false（IPC 失败 / 未注册项目 / 物化失败）→ warn + artifact 落 ok:false +
//   reason（mirror world-merge write 失败模式：writeErrors 记 artifact 不破链，链继续）。
//   注意：**不产 `{error:true}` artifact**——那是 chainRunner isErrorArtifact 终态形态（break 链），
//   物化失败是增强降级非硬错误（本章正文/审核不受影响，摘要可 backfill 补）。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror feedback-ledger-node / emotion-verify-node / storySync
// 先例——经 createChapterChainNodes 装配，不进 agentContracts.ts CONTRACTS[]（orchestration-pattern.md
// 链段节点不进 CONTRACTS[] 约定）。
//
// expected_downstream_consumers:
// - Story 8.2：completeness-verify 切分弧/折叠快照 reader（消费 query_chapter_summary 读本节点物化的摘要）。
// - Story 8.1 Step 5/6：fetch 切换 + backfill「仅补 summary」路径（复用同一 handler）。

/** 节点产出 artifact key（链段 pass-through 计数形态，mirror feedback_ledger 非 downstream 硬依赖）。 */
const CHAPTER_SUMMARY_NODE_KEY = 'chapter_summary_result';

const CHAPTER_SUMMARY_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'chapter-summary-node',
  displayName: 'Chapter Summary Node',
  inputSchemaName: 'chapterSummaryInput',
  outputSchemaName: 'chapterSummaryResult',
  // graceful：requiredArtifactKeys=[]——chapter_brief_input 缺 / episodeId 缺不阻断链（跳过物化）。
  // pause/abort/escalate 早停时 artifact 不全，列 required 会致 chainRunner blocked。
  requiredArtifactKeys: [],
  producedArtifactKeys: [CHAPTER_SUMMARY_NODE_KEY],
  // 写 closure_chapter_summary / closure_world_checkpoint 派生表（DB 副作用）；'persist_artifact'
  // 是枚举内最接近的（无 'write_db' 项，mirror world-merge-node WORLD_MERGE_CONTRACT 注释）。
  sideEffects: ['persist_artifact'],
};

/**
 * 从 chapter_brief_input artifact 解析 episodeId（mirror feedback-ledger-node / world-extractor-node
 * resolveEpisodeId）。用于把物化 summary 关联到本章 episode（PK 维度 chapter = episode，design §4）。
 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

/** materialize handler metadata 的最小 shape 预检（graceful 解析，坏 metadata 降级 reason 记录）。 */
function asMetadata(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/**
 * 构造 chapter-summary 节点（纯代码，无 LLM generate，design §2 物化流）。
 *
 * run 流程：
 *  1. 解析 episodeId（从 chapter_brief_input，mirror feedback-ledger / world-extractor）。
 *  2. episodeId 缺 → 跳过物化 + warn（summary 须关联 episode，无 episode 无法物化）。
 *  3. registry.get('materialize_chapter_summary')；未注册 → 跳过 + warn（测试环境 registry 空）。
 *  4. execute({episodeId})（handler 从 projectDir 解析 projectId；参数 schema = shared-contracts
 *     materializeChapterSummaryRequestSchema 单源）。
 *  5. 产 chapter_summary_result artifact（计数形态：episodeId / ok / tokenEstimate / truncated /
 *     checkpointCount / degradedNote? / 失败 reason——消费方据 ok:false 降级，不阻断下游）。
 */
export function createChapterSummaryNode(): AgentNode {
  return {
    contract: CHAPTER_SUMMARY_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // ── 1. episodeId（本章 episode，mirror feedback-ledger / world-extractor）──
      const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      if (!episodeId) {
        logger.warn(
          { projectPath: run.projectPath },
          'chapter-summary-node: episodeId missing → skip materialization (summary requires episode association)',
        );
        return {
          stateKey: CHAPTER_SUMMARY_NODE_KEY,
          artifact: { runId: run.runId, episodeId: null, ok: false, reason: 'no_episodeId', summary: 'skip: no episodeId' },
        };
      }

      // ── 2. materialize_chapter_summary 工具可用性 ──
      const tool = registry.get('materialize_chapter_summary');
      if (!tool) {
        // 测试环境 registry 空 / 未 registerBuiltinTools → 跳过物化（mirror fetchWorldPatchesViaTool graceful）。
        logger.warn(
          { episodeId },
          'chapter-summary-node: materialize_chapter_summary tool not registered → skip materialization (chain continues)',
        );
        return {
          stateKey: CHAPTER_SUMMARY_NODE_KEY,
          artifact: { runId: run.runId, episodeId, ok: false, reason: 'tool_not_registered', summary: 'skip: tool not registered' },
        };
      }

      // ── 3. 调工具物化（handler：db + project.yaml 组装 → 纯函数汇编 → WAL 事务 upsert）──
      try {
        const result = await tool.execute(
          { episodeId },
          {
            projectPath: run.projectPath,
            // 节点无 sessionId（chain node 不持 session 引用），传空串 placeholder（handler 只读 projectDir，
            // mirror feedback-ledger-node / fetchWorldPatchesViaTool）。
            sessionId: '',
            abort: new AbortController().signal,
          },
        );
        const meta = asMetadata(result.metadata);
        // handler 成功形：metadata {ok:true, episodeId, tokenEstimate, truncated, checkpointCount, summary}；
        // graceful 失败形：{ok:false, reason, error?}（invalid_params / project_not_registered / materialize_failed）。
        if (meta && meta.ok === true) {
          const summaryMeta = asMetadata(meta.summary);
          return {
            stateKey: CHAPTER_SUMMARY_NODE_KEY,
            artifact: {
              runId: run.runId,
              episodeId,
              ok: true,
              tokenEstimate: typeof meta.tokenEstimate === 'number' ? meta.tokenEstimate : 0,
              truncated: meta.truncated === true,
              checkpointCount: typeof meta.checkpointCount === 'number' ? meta.checkpointCount : 0,
              ...(summaryMeta && typeof summaryMeta.degradedNote === 'string'
                ? { degradedNote: summaryMeta.degradedNote }
                : {}),
              summary: `materialized ${episodeId}`,
            },
          };
        }
        // ok:false / metadata 缺 → warn + 降级记录（不破链，mirror world-merge writeErrors 模式）。
        const reason = meta && typeof meta.reason === 'string' ? meta.reason : 'unknown';
        const detail = meta && typeof meta.error === 'string' ? `: ${meta.error}` : '';
        logger.warn(
          { episodeId, reason },
          `chapter-summary-node: materialize returned ok=false (${reason}) → degraded (chain continues)`,
        );
        return {
          stateKey: CHAPTER_SUMMARY_NODE_KEY,
          artifact: {
            runId: run.runId,
            episodeId,
            ok: false,
            reason: `handler_${reason}${detail}`,
            summary: `degraded: ${reason}`,
          },
        };
      } catch (err) {
        // execute 抛错（IPC 失败 / 未初始化）→ warn + 降级记录（增强非硬约束，链不破）。
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { episodeId, err: msg },
          'chapter-summary-node: materialize_chapter_summary failed → degraded (chain continues)',
        );
        return {
          stateKey: CHAPTER_SUMMARY_NODE_KEY,
          artifact: { runId: run.runId, episodeId, ok: false, reason: `execute_failed: ${msg}`, summary: `degraded: ${msg}` },
        };
      }
    },
  };
}
