import {
  castDeclarationSchema,
  isSceneInEpisode,
  type CastDeclaration,
  type MentionSignal,
  type ReusableAgentNodeContract,
  type SceneGraph,
} from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';
import { registry } from '../tool/registry';
import { logger } from '../logger';

// ── Story 8.7 S8（design §2.2/§2.3）：mention 共现账汇账节点（纯代码薄节点）──
//
// chapter-chain 链段纯代码节点（无 LLM generate，mirror chapter-summary-node / storytime-drift-node
// 「纯代码薄节点 → 调 builtin → 记计数 artifact」模式）。挂 storytime-drift-node 后、story-sync-agent
// 前（design §2.2 链位：chapter-summary 物化之后——synopsis 回填的前提；route（through 节点）之前——
// through-break 后 post-through 节点结构性不可达）：
//
// 读链内 artifacts（cast_declaration / draft.initial / scene_graph / chapter_brief_input）→ 投影组装
// （declaration + draftText + plannedAssetRefs——db 侧取不到的三件，链内 artifact 是唯一来源）→ 调
// record_episode_mentions builtin（remoteToolProxy → toolExecution IPC → shell
// mentionLedgerHandlers → mentionLedgerMaterialize 组装核心：本章 patches + subject 卡桥 + 卡索引自取
// → S3 纯函数家族四通道合并 → upsertEpisodeMentions 单 WAL 事务 + synopsis 回填 UPDATE）。
//
// 🔑 范式判据（ADR-3）：本节点 = 纯代码机械中转（artifact 投影 → 调工具 → 记 artifact），无 LLM / 无
// 语义判断。汇账七步全在 shared-contracts 纯函数 + shell 组装核心（查询/汇编/计数）；申报的语义内容
// （谁真登场了、梗概写什么）归写手 LLM（writer-node 阶段 2.5 已产 cast_declaration）。
//
// **修订降档接线退役（链流程重排 W1d，design §2.3 语义的结构性收编）**：原
// createTargetedRevisionWithMentionDegrade 包装（targeted-revision 修订落盘 → degrade_episode_mentions
// 降保守档 + synopsis 标 stale）随 targeted-revision 节点退役删除。理由（三条，非省略）：
// ① 7.4 候选④后 wrapper 实际已 dormant（redo 恒清 review.latest → targeted-revision 恒 shouldSkip）；
// ② 新链序下 mention 账恒在**终稿后**计算——mention-ledger（E8）在 route 终态后、自审环外，环内
// 改稿期间账尚未存在，无 stale 可降；redo 重跑从写手位到链尾必经 E8 重收（per-episode 全量替换），
// 修订落定后账必然新鲜；③ 落盘后手改的 stale 面归 R6/W4 re-extract-chapter（degrade_episode_mentions
// 工具本体保留注册，供 W4 重提取/保守化消费）。
//
// graceful 契约（mirror chapter-summary-node「增强非硬约束」，mention 账是 DERIVED 可重收）：
// - episodeId 缺（chapter_brief_input 无）→ 跳过记账（warn，链不破）。
// - 工具未注册（测试环境 registry 空）→ 跳过记账（warn，链不破）。
// - 无申报（cast_declaration 缺 / degraded 形态 / declaration 字段坏）→ 保守账（纯代码通道兜底，
//   handler 侧 source 全 conservative）——非降级非失败，是 design §2.2 的合法形态。
// - 无 patches / 无 plannedAssetRefs / 空 draftText → 对应通道全零（handler 侧 graceful，不报错）。
// - execute 抛错 / handler ok:false → warn + ok:false artifact（不产 {error:true}——那是 chainRunner
//   isErrorArtifact 终态形态，记账失败是增强降级非硬错误，mirror chapter-summary 哲学）。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror chapter-summary / storytime-drift 先例。redo 每轮重跑
// （orchestration-pattern 语义 2）→ per-episode 全量替换幂等（终轮账即终态）；自审环
// [revision-optimizer..route] 不含本节点（链流程重排 W1d 后 = 提取段 E8，route 终态后）→ auto_revise
// 环内回环不重复记账。
//
// expected_downstream_consumers:
// - Story 8.7 S9：mention_signals artifact → leader 议题注入段（mirror 3.3 结构 issues 注入先例；
//   hard_miss/soft_miss/plan_deviation/new_face/alias_suggestion 五类信号文案组装）。
// - Story 8.7 S6（已接）：query_mentions / catalog_entries 读 closure_mention（目录行出场统计）。

/** 节点产出 artifact key（链段 pass-through 计数形态，mirror chapter_summary_result）。 */
export const MENTION_SIGNALS_NODE_KEY = 'mention_signals';

const MENTION_LEDGER_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'mention-ledger-node',
  displayName: 'Mention Ledger Node',
  inputSchemaName: 'mentionLedgerInput',
  outputSchemaName: 'mentionSignals',
  // dispatch 指定：draft.initial（粗筛源）+ scene_graph（计划对拍源）硬依赖；chapter_brief_input 读
  // episodeId（mirror 既有 resolveEpisodeId 消费族，optional 不列 required——缺则跳过记账不阻断链，
  // pause/abort/escalate 早停时 artifact 不全列 required 会致 chainRunner blocked）。
  // 链位保证：world-extractor（requiredArtifactKeys 同含两 key）在本节点前已跑——二者恒在场。
  requiredArtifactKeys: ['draft.initial', 'scene_graph'],
  producedArtifactKeys: [MENTION_SIGNALS_NODE_KEY],
  // 写 closure_mention / 回填 closure_chapter_summary.synopsis（DB 副作用）——链上写节点定位
  // （mirror chapter-summary-node；「读工具零持久化副作用」红线不适用于本节点）。
  sideEffects: ['persist_artifact'],
};

/** mention_signals artifact 形态（计数 + 信号明细，mirror chapter_summary_result 计数形态）。 */
export interface MentionLedgerArtifact {
  runId: string;
  episodeId: string | null;
  /** 记账是否实际落库（false + reason = 跳过/降级）。 */
  ok: boolean;
  reason?: 'no_episodeId' | 'tool_not_registered' | 'handler_rejected' | 'execute_failed';
  /** 落库行数（(章, 实体) 一行；0 = 本章零命中零申报——合法空账）。 */
  rowCount?: number;
  /** 对拍差异信号（五类；S9 leader 注入段消费——本轮只产结构化 artifact 不接 leader）。 */
  signals: MentionSignal[];
  /** synopsis 回填结果（applied / no_declaration / no_summary_row）。 */
  synopsis?: 'applied' | 'no_declaration' | 'no_summary_row';
  /** 输入面降级注记（asset_cards 缺 / summary 行缺等；空 = 无）。 */
  degradedReasons?: string[];
  summary: string;
}

/**
 * 从 chapter_brief_input artifact 解析 episodeId（mirror chapter-summary / storytime-drift
 * resolveEpisodeId——同一解析逻辑第 N 消费者，内联同形不抽公共模块〔口径漂移由链段装配测试兜住〕）。
 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

/** 安全取 artifact record（过滤非对象/数组，mirror promise-emergence artifactAsRecord）。 */
function artifactAsRecord(run: RunSnapshot, key: string): Record<string, unknown> | undefined {
  const raw = run.artifacts[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * 读 cast_declaration artifact 的 declaration 字段（writer-node 阶段 2.5 产）。
 *
 * 三态：正常 {declaration, source:'declared'} → declaration；降级 {degraded, reason} / 缺 → undefined
 * （保守账，非失败）；declaration 字段坏形态（snapshot 跨版本等）→ safeParse 拒收 undefined + warn
 * （不把垃圾往 IPC 送——schema 边界钉死，mirror 测试纪律「呈现位替换必须 fresh 读」哲学）。
 */
function readDeclaration(run: RunSnapshot): CastDeclaration | undefined {
  const artifact = artifactAsRecord(run, 'cast_declaration');
  if (artifact === undefined || artifact.declaration === undefined) return undefined;
  const parsed = castDeclarationSchema.safeParse(artifact.declaration);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues.length },
      'mention-ledger-node: cast_declaration.declaration malformed → treat as no declaration (conservative ledger)',
    );
    return undefined;
  }
  return parsed.data;
}

/**
 * 本章计划登场卡 id 集（scene_graph 本章场 SceneNode.assetRefs 展开，isSceneInEpisode 单源——
 * episodeId 直挂 / presentationSpans M:N 都算）。去重 + 排序（确定性，测试可断言）；全空 → undefined
 * （二态字段纪律：空集不传字段，mirror handler 侧省略语义）。
 */
function collectPlannedAssetRefs(sceneGraph: unknown, episodeId: string): string[] | undefined {
  const graph = sceneGraph as SceneGraph | undefined;
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) return undefined;
  const refs = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object') continue;
    if (!isSceneInEpisode(node as SceneGraph['nodes'][number], episodeId)) continue;
    const assetRefs = (node as { assetRefs?: unknown }).assetRefs;
    if (!Array.isArray(assetRefs)) continue; // optional 字段缺省（旧项目未填）→ 该场无计划 refs
    for (const ref of assetRefs) {
      if (typeof ref === 'string' && ref.length > 0) refs.add(ref);
    }
  }
  if (refs.size === 0) return undefined;
  return [...refs].sort();
}

/** 工具调用 ctx（mirror chapter-summary-node：节点无 sessionId，传空串 placeholder，handler 只读 projectDir）。 */
function makeToolContext(projectPath: string) {
  return {
    projectPath,
    sessionId: '',
    abort: new AbortController().signal,
  };
}

/** tool 结果 metadata 的最小 shape 预检（graceful 解析，mirror chapter-summary-node asMetadata）。 */
function asMetadata(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** 跳过/降级形态统一产物（mirror chapter-summary-node reason 记录模式）。 */
function skippedResult(
  run: RunSnapshot,
  episodeId: string | null,
  reason: NonNullable<MentionLedgerArtifact['reason']>,
  summary: string,
): NodeResult {
  return {
    stateKey: MENTION_SIGNALS_NODE_KEY,
    artifact: {
      runId: run.runId,
      episodeId,
      ok: false,
      reason,
      signals: [],
      summary,
    } satisfies MentionLedgerArtifact,
  };
}

/**
 * 构造 mention-ledger 节点（纯代码，无 LLM generate）。
 *
 * run 流程：解析 episodeId → 读申报（三态）→ 投影 draftText + plannedAssetRefs → 调
 * record_episode_mentions builtin → handler metadata（rowCount/signals/synopsis/degradedReasons）落
 * mention_signals artifact。永不返 error artifact（记账是增强非门禁，任何输入缺失都降级跳过，链不破）。
 */
export function createMentionLedgerNode(): AgentNode {
  return {
    contract: MENTION_LEDGER_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // ── 1. episodeId（本章 episode，mirror chapter-summary / storytime-drift）──
      const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      if (!episodeId) {
        logger.warn(
          { projectPath: run.projectPath },
          'mention-ledger-node: episodeId missing → skip mention ledger (no episode association)',
        );
        return skippedResult(run, null, 'no_episodeId', 'skip: no episodeId');
      }

      // ── 2. 工具可用性（测试环境 registry 空 → 跳过，mirror chapter-summary）──
      const tool = registry.get('record_episode_mentions');
      if (!tool) {
        logger.warn(
          { episodeId },
          'mention-ledger-node: record_episode_mentions tool not registered → skip ledger (chain continues)',
        );
        return skippedResult(run, episodeId, 'tool_not_registered', 'skip: tool not registered');
      }

      // ── 3. 链内 artifact 投影（db 侧取不到的三件）──
      const declaration = readDeclaration(run);
      const draftText = (() => {
        const text = artifactAsRecord(run, 'draft.initial')?.text;
        return typeof text === 'string' ? text : '';
      })();
      const plannedAssetRefs = collectPlannedAssetRefs(run.artifacts['scene_graph'], episodeId);

      // ── 4. 调工具汇账（handler：db + project.yaml 取数 → 纯函数合并 → upsert + synopsis 回填）──
      try {
        const result = await tool.execute(
          {
            episodeId,
            ...(declaration !== undefined ? { declaration } : {}),
            draftText,
            ...(plannedAssetRefs !== undefined ? { plannedAssetRefs } : {}),
          },
          makeToolContext(run.projectPath),
        );
        const metaRecord = asMetadata((result as { metadata?: unknown } | undefined)?.metadata);
        if (metaRecord !== undefined && metaRecord.ok === true) {
          const signals = Array.isArray(metaRecord.signals) ? (metaRecord.signals as MentionSignal[]) : [];
          const degradedReasons = Array.isArray(metaRecord.degradedReasons)
            ? (metaRecord.degradedReasons as string[])
            : [];
          const synopsis = metaRecord.synopsis;
          return {
            stateKey: MENTION_SIGNALS_NODE_KEY,
            artifact: {
              runId: run.runId,
              episodeId,
              ok: true,
              rowCount: typeof metaRecord.rowCount === 'number' ? metaRecord.rowCount : 0,
              signals,
              ...(synopsis === 'applied' || synopsis === 'no_declaration' || synopsis === 'no_summary_row'
                ? { synopsis }
                : {}),
              ...(degradedReasons.length > 0 ? { degradedReasons } : {}),
              summary: `recorded ${episodeId}: ${typeof metaRecord.rowCount === 'number' ? metaRecord.rowCount : 0} row(s)`,
            } satisfies MentionLedgerArtifact,
          };
        }
        // ok:false / metadata 缺 → warn + 降级记录（不破链，mirror chapter-summary handler_ok:false 模式）。
        const reason = metaRecord !== undefined && typeof metaRecord.reason === 'string' ? metaRecord.reason : 'unknown';
        logger.warn(
          { episodeId, reason },
          `mention-ledger-node: record returned ok=false (${reason}) → degraded (chain continues)`,
        );
        return skippedResult(run, episodeId, 'handler_rejected', `degraded: ${reason}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { episodeId, err: msg },
          'mention-ledger-node: record_episode_mentions failed → degraded (chain continues)',
        );
        return skippedResult(run, episodeId, 'execute_failed', `degraded: ${msg}`);
      }
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 修订降档接线（design §2.3）——链流程重排 W1d 退役（结构性收编，见文件头注释三条理由）。
// createTargetedRevisionWithMentionDegrade 已删除：新链序 mention 账恒在终稿后计算（E8 提取后置
// + redo 重跑必经重收），环内改稿不再留 stale 账窗口；落盘后手改的保守化归 W4 re-extract-chapter。
// ════════════════════════════════════════════════════════════════════════════
