import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import yaml from 'js-yaml';
import type { ReusableAgentNodeContract, CreativeFieldKey, ThinkingControl } from '@orison/shared-contracts';
import { creativeFieldKeys } from '@orison/shared-contracts';
import {
  buildStorySyncMessages,
  parseStorySyncResponse,
  SYSTEM_PROMPT,
  type FieldVersionMap,
} from '@orison/story-sync';
import type { AgentNode, NodeResult, NodeRunInput } from '../../contracts/run';
import { deriveStorySyncByRules } from './rules';
import { isAbortError, type GenerateFn } from '../llm-node';
import type { GenerationDelta } from '../../provider/ipc-provider';
import { logger } from '../../logger';

// ── Story 2.2 WP-E（design §5.5.1）：story-sync 节点真跑 LLM 提取（激活空转件）──
//
// 现状三层断链（prd Background ④）：提取件全建好（packages/story-sync prompt/safety/parser）但链上节点
// 空壳（LLM 路径无上游产出 llmPatches / rules 路径 6.5 后返空）→ story.sync 恒空 patches，writer 自由
// 发挥的设定无人回收。本步激活 = 接线非新建：
//
// - **LLM 路径（新增，deps.llm.generate 注入时走）**：mirror world-extractor-node 注入 generate 形态
//   （chapter-chain.ts 装配传 llmDeps）。输入组装：candidate = draft.initial（.text/.chapterId）+
//   context = loadStorySyncContext 读 project.yaml（creativeBrief/worldSetting/assetCards/relationshipGraph/
//   episodeOutlines/growthCurve/pacingCurve/emotionCurve + fieldVersions from field_metadata，mirror
//   prompt.ts userPayload 期望形态）→ buildStorySyncMessages + 单次 generate + parseStorySyncResponse
//   （内含 enforceSafety：白名单/merge-only/版本锁/generatedBy 强制，语义全保留不改）。
//   **graceful catch（mirror CR-E3 world-extractor）**：LLM fail / parse fail → warn 日志 + 降级既有
//   dispatcher 路径（rules 兜底返空），链不破——story-sync 是增强非硬约束节点。AbortError 传播（取消语义）。
// - **dispatcher 路径（保留，缺省零回归）**：deps 缺省（旧测试 / 无 generate 注入）时走既有逻辑——
//   draft.initial.llmPatches defensive 透传（4.0 链段无上游产出但保留）+ rules 兜底。
// - **CR-E7 belt（防线双保险）**：promise_registry patches 在节点层机械过滤（prompt 规则 7 禁提取 +
//   parser 白名单含 promise_registry 不拦——此处兜底丢弃，mirror 6.5 track-conflation 防线）。
// - 产出 story.sync artifact 形态不变（patches + summary）。链流程重排 W3：本节点挂 E9（终稿后一次
//   提取），multi-review 不再消费（continuityMemory var 已删）——唯一消费 = 终态反哺经
//   summarizeRunSnapshot deliverable 豁免（chainRunner，Story 2.2 WP-E）。
//
// 范式判据（ADR-3）：提取 = 语义判断（哪些结构性设定在正文出现）归 LLM；组装/prompt 构建/安全过滤 =
// 纯代码机械。状态变化禁提取（归 6.6 五轴）在 prompt 规则 8 编码（track-conflation 防线）。
//
// expected_downstream_consumers:
// - Story 2.2 WP-E applier（write-chapter.ts）：终态读 summary.storySync patches 转 story_sync_apply
//   （链流程重排 W3：收尾时序 = E9 提取段完成后）。

const CREATIVE_SET = new Set<string>(creativeFieldKeys);

export const STORY_SYNC_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'story-sync-agent',
  displayName: 'Story Sync Agent',
  inputSchemaName: 'storySyncInput',
  outputSchemaName: 'storySyncOutput',
  requiredArtifactKeys: ['draft.initial'],
  producedArtifactKeys: ['story.sync'],
  sideEffects: ['apply_patch'],
};

/** draft.initial artifact 的可读形态（DraftArtifact + 可选 llmPatches，defensive 容忍额外字段）。 */
interface DraftLike {
  text?: string;
  content?: string;
  chapterId?: string;
  llmPatches?: unknown;
}

/** Story 2.2 WP-E：story-sync 节点 deps（全 optional——缺省走既有 dispatcher 路径，零回归）。 */
export interface StorySyncNodeDeps {
  /**
   * LLM deps（generate 注入，mirror world-extractor LlmNodeDeps 子集；chapter-chain.ts 装配传 llmDeps，
   * 其 tagChinese/compress 字段被本节点忽略——结构兼容）。缺省 → 不跑 LLM 提取（dispatcher 路径）。
   * thinking（S4b）与 modelRef 同源随档。
   */
  llm?: {
    generate: GenerateFn;
    modelRef?: { keyId: string; modelId: string };
    thinking?: ThinkingControl;
    /** 09-12 子2 fallback chains（H2 透传面）：extraction 档回退链（chapter-chain llmDepsFor 注入）。 */
    fallbacks?: import('@orison/shared-contracts').GenerateFallbackEntry[];
    /** 09-12 usage-panel：任务档位/流程标签（chapter-chain llmDepsFor 注入 'extraction'）。 */
    taskType?: string;
    signal?: AbortSignal;
    /**
     * 09-13 子2 W2b（思考流，design §1）：节点流回调——generate opts 透传 provider onDelta（单发
     * 无重试环：messageId 一次预分配；tool 通道滤除——防御性，本节点无工具）。装配侧由 chapter-chain
     * `withNodeStreaming` 注入（补 nodeId/role → workflow onNodeDelta）。缺省不开（零回归）。
     */
    onDelta?: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => void;
  };
  /**
   * 项目路径（chapter-chain.ts 装配传 session.projectPath）——loadStorySyncContext 读 project.yaml 组
   * context（设定字段 + field_metadata 版本）。缺省 → 空 context 降级（LLM 无设定参照/无版本锁，仍可提取）。
   */
  projectPath?: string;
}

/** loadStorySyncContext 产出：prompt.ts userPayload 期望的 context 子集 + fieldVersions。 */
export interface StorySyncProjectContext {
  chapterNumber?: number;
  novelTitle?: string;
  creativeBrief?: unknown;
  worldSetting?: unknown;
  assetCards?: unknown;
  relationshipGraph?: unknown;
  episodeOutlines?: unknown;
  growthCurve?: unknown;
  pacingCurve?: unknown;
  emotionCurve?: unknown;
  /** 各 creative field 当前 field_metadata.version（prompt 规则 4 版本回显源 + enforceSafety 版本锁源）。 */
  fieldVersions: FieldVersionMap;
}

const BOM_CHAR_CODE = 0xfeff;

/**
 * 读 project.yaml 组装 story-sync 提取 context（agent 直读，mirror write-chapter loadChainProjectInput /
 * diagnose-impacts loadDiagnoseProjectInput 的 BOM-strip + malformed → graceful 模式）。
 *
 * 范式判据（ADR-3）：纯代码机械读取（查询/汇编）——不做语义过滤，「提取什么」归 LLM prompt。
 * 文件不可读 / yaml 损坏 → 返 null（caller 降级空 context，链不破）。
 *
 * 导出供节点单测直接构造/断言（mirror world-state-query 导出模式）。
 */
export async function loadStorySyncContext(
  projectPath: string | undefined,
  episodeId: string | undefined,
): Promise<StorySyncProjectContext | null> {
  if (!projectPath) return null;
  let raw: string;
  try {
    raw = await readFile(path.join(projectPath, 'project.yaml'), 'utf8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'story-sync: project.yaml unreadable → degraded empty context',
    );
    return null;
  }
  const bomStripped = raw.charCodeAt(0) === BOM_CHAR_CODE ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = yaml.load(bomStripped);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'story-sync: project.yaml malformed yaml → degraded empty context',
    );
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const context: StorySyncProjectContext = { fieldVersions: {} };
  if (obj.creative_brief !== undefined) context.creativeBrief = obj.creative_brief;
  if (obj.world_setting !== undefined) context.worldSetting = obj.world_setting;
  if (Array.isArray(obj.asset_cards)) context.assetCards = obj.asset_cards;
  if (obj.relationship_graph !== undefined) context.relationshipGraph = obj.relationship_graph;
  if (Array.isArray(obj.episode_outlines)) {
    context.episodeOutlines = obj.episode_outlines;
    // chapterNumber：本章 episode 的 index（外键真实查找，非数组位置——interface-contracts convention）。
    if (episodeId) {
      const outline = (obj.episode_outlines as Array<Record<string, unknown>>).find(
        (e) => e && typeof e === 'object' && e.id === episodeId,
      );
      if (outline && typeof outline.index === 'number') context.chapterNumber = outline.index;
    }
  }
  if (obj.growth_curve !== undefined) context.growthCurve = obj.growth_curve;
  if (obj.pacing_curve !== undefined) context.pacingCurve = obj.pacing_curve;
  if (obj.emotion_curve !== undefined) context.emotionCurve = obj.emotion_curve;
  if (typeof obj.name === 'string' && obj.name.length > 0) context.novelTitle = obj.name;

  // fieldVersions：field_metadata 各 field 当前 version（prompt 规则 4「找不到用 0」——未记录的 field 不进
  // map，enforcePatchSafety 对未记录 field 不做版本锁，mirror 语义）。
  const fm = obj.field_metadata;
  if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
    for (const [field, meta] of Object.entries(fm as Record<string, unknown>)) {
      if (!CREATIVE_SET.has(field)) continue;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      const version = (meta as { version?: unknown }).version;
      if (typeof version === 'number' && Number.isFinite(version)) {
        context.fieldVersions[field as CreativeFieldKey] = version;
      }
    }
  }
  return context;
}

export function createStorySyncNode(deps?: StorySyncNodeDeps): AgentNode {
  return {
    contract: STORY_SYNC_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;
      const draft = run.artifacts['draft.initial'] as DraftLike | undefined;

      if (!draft) {
        return {
          stateKey: 'story.sync',
          artifact: {
            runId: run.runId,
            chapterId: '',
            summary: 'skip: no draft.initial',
            patches: [],
          },
        };
      }

      // Story 2.2 WP-E：LLM 提取路径（generate 注入时）。graceful：任何失败（LLM/parse/context）→ warn +
      // 降级 dispatcher 路径（rules 兜底返空），链不破（mirror world-extractor CR-E3 增强非硬约束哲学）。
      if (deps?.llm?.generate) {
        const llmResult = await runLlmExtraction(deps, run.runId, draft, input);
        if (llmResult) return llmResult;
        // fall through → dispatcher（LLM 路径失败降级）
      }

      // Try LLM patches first（defensive：4.0 链段无上游产出 llmPatches，但保留 dispatcher 逻辑）
      const llmPatches = draft.llmPatches;
      if (Array.isArray(llmPatches) && llmPatches.length > 0) {
        const allWhitelisted = llmPatches.every(
          (p: any) => p?.field && CREATIVE_SET.has(p.field),
        );
        if (!allWhitelisted) {
          return rulesPath(run, draft);
        }

        // Use LLM patches, override generatedBy（freshness 版本源已移除——旧 foreshadow_registry.version 源随
        // 6.5 废弃；creative-field freshness 归各 handler/fieldSyncBridge，非 story-sync 职责）。
        const patches = llmPatches.map((p: any) => ({
          ...p,
          generatedBy: 'story-sync-agent',
        }));

        return {
          stateKey: 'story.sync',
          artifact: {
            runId: run.runId,
            chapterId: draft.chapterId ?? '',
            summary: `${patches.length} llm patches applied`,
            patches,
          },
        };
      }

      return rulesPath(run, draft);
    },
  };
}

/**
 * LLM 提取单轮（Story 2.2 WP-E）。成功 → story.sync NodeResult；失败 → null（caller 降级 dispatcher）。
 * AbortError 重抛（取消语义，mirror createLlmNode）。
 */
async function runLlmExtraction(
  deps: StorySyncNodeDeps,
  runId: string,
  draft: DraftLike,
  input: NodeRunInput,
): Promise<NodeResult | null> {
  const llm = deps.llm;
  if (!llm) return null; // unreachable（caller 已守卫 generate 存在）；防御性早返
  const chapterId = draft.chapterId ?? '';
  const content = draft.text ?? draft.content ?? '';
  const episodeId = resolveEpisodeId(input.run.artifacts['chapter_brief_input']);

  try {
    const context = (await loadStorySyncContext(deps.projectPath, episodeId)) ?? { fieldVersions: {} };
    const messages = buildStorySyncMessages({
      runId,
      chapterId,
      // candidate 形态 mirror 旧链消费（content/chapterId）——prompt userPayload 原样透传给 LLM。
      candidate: { content, chapterId },
      context: context as unknown as Record<string, unknown>,
    });
    // buildStorySyncMessages 返 [system, user]；GenerateFn 契约是 (user messages, system, ...)——
    // system 从消息组抽出单传（SYSTEM_PROMPT 单源导出，非复制副本）。
    const userContent = messages
      .filter((m) => m.role !== 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    // 09-13 子2 W2b（思考流）：onDelta 透传（单发无重试环：messageId 一次预分配；tool 通道滤除
    //——防御性，本节点无工具）。缺省不占位（非流式路径零回归）。
    const attemptMessageId = randomUUID();
    const result = await llm.generate(
      [{ id: randomUUID(), role: 'user', content: userContent, createdAt: Date.now() }],
      SYSTEM_PROMPT,
      [],
      llm.signal ?? new AbortController().signal,
      llm.modelRef || llm.thinking || llm.fallbacks?.length || llm.taskType || llm.onDelta
        ? {
            ...(llm.modelRef ? { modelRef: llm.modelRef } : {}),
            ...(llm.thinking ? { thinking: llm.thinking } : {}),
            // 09-12 子2（H2）：fallbacks 透传（空链不占位）。
            ...(llm.fallbacks?.length ? { fallbacks: llm.fallbacks } : {}),
            // 09-12 usage-panel：taskType 透传（未标注不占位）。
            ...(llm.taskType ? { taskType: llm.taskType } : {}),
            ...(llm.onDelta
              ? {
                  onDelta: (d: GenerationDelta) => {
                    if (d.type === 'tool') return;
                    llm.onDelta!({ messageId: attemptMessageId, channel: d.type, delta: d.delta });
                  },
                }
              : {}),
          }
        : undefined,
    );

    const parsed = parseStorySyncResponse(result.content, {
      runId,
      chapterId,
      fieldVersions: context.fieldVersions,
    });
    if (!parsed.ok) {
      logger.warn({ runId, reason: parsed.reason }, 'story-sync: LLM parse failed → rules fallback (empty)');
      return null;
    }
    // CR-E7 belt：promise_registry 机械过滤（prompt 规则 7 禁提取；parser 白名单不拦此处兜底）。
    const patches = parsed.payload.patches.filter((p) => p.field !== 'promise_registry');
    const dropped = parsed.payload.patches.length - patches.length;
    if (dropped > 0) {
      logger.warn(
        { runId, dropped },
        'story-sync: dropped promise_registry patches (CR-E7 防线——读者债走 promise-emergence-node)',
      );
    }
    return {
      stateKey: 'story.sync',
      artifact: {
        runId,
        chapterId,
        summary: parsed.payload.summary,
        patches,
      },
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    logger.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      'story-sync: LLM extraction failed → rules fallback (empty, chain continues)',
    );
    return null;
  }
}

/** 从 chapter_brief_input artifact 解析 episodeId（mirror world-extractor resolveEpisodeId）。 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

function rulesPath(run: any, draft: DraftLike): NodeResult {
  const chapterId = draft.chapterId ?? '';
  const result = deriveStorySyncByRules({
    chapterId,
    content: draft.text ?? draft.content ?? '',
    chapterNumber: 0,
  });

  return {
    stateKey: 'story.sync',
    artifact: {
      runId: run.runId,
      chapterId,
      summary: `${result.patches.length} patches from rules`,
      patches: result.patches,
    },
  };
}
