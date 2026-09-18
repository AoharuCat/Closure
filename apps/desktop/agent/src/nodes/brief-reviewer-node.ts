import { z } from 'zod';
import {
  episodeOutlineSchema,
  type EpisodeOutline,
  type ReusableAgentNodeContract,
} from '@orison/shared-contracts';
import { createLlmNode, type LlmNodeDeps } from './llm-node';
import { extractJson } from './extract-json';
import { resolveEpisodeId } from './chapter-nodes';
import { logger } from '../logger';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';

// ── 链流程重排 W1c（task 09-13-chain-flow-restructure）：规划环 A2 位节点工厂 ──
//
// brief-reviewer-node = 独立视角规划审核（design §1 规划环 cap 2）：brief-compiler（A1）编出任务卡后、
// 写手动笔（B）前，以「拿到这张卡的写手/责编」视角审卡——六维度 verdict + findings。verdict=revise →
// 回 A1 重编（findings 作重编意图）；verdict=escalate → 规划层灰区（escalate-pause 统一机制，W1a/W1d 消费）。
//
// **本文件只产工厂 + 契约**：链装配（chapter-chain.ts 接 A1→A2 位 + loops 数组规划环）归 W1d；
// 环回判据（plan_review.verdict 消费 + cap 2）归 W1a。W1c 交付面 = createBriefReviewerNode +
// plan_review artifact schema 形态（软硬划界内嵌 severity）。
//
// 输入面 = W0-9 最小充分集（research/w0-resolved.md §9）：chapter_brief（主载荷，六维数据多已折叠进
// brief）+ episode_outlines（本章 ±1 邻章，机械截取非全量）+ emotion_curve + genreContract——全部是
// A2 位现成 artifact（assembleChapterChainArtifacts / caller optional 注入），零新取数。
//
// 范式判据（ADR-3）：六维判分（戏剧质量/契合/节奏/红线…）= 语义判断归 LLM（本节点 generate，
// prompts/brief-reviewer-agent.yaml 契约）；vars 组装 / 邻章窗口截取 / verdict+dimension 归一 / severity
// 收敛 = 纯代码机械。
//
// expected_downstream_consumers:
// - W1d（chapter-chain.ts）：装配规划环 [brief-compiler-node, brief-reviewer-node]，checkpointStage='brief'
//   挪 A2 后——readonly 档人审的是独立审核过的卡，卡附 reviewer findings。
// - W1a（chainRunner loops 数组化）：plan_review.verdict 驱动规划环回环（revise→回 A1）+ cap 2 超限
//   escalate-pause。软维度 findings 不触发回环（severity 消费侧判据，design §1 软硬划界 M8）。
// - 子3（UI）：终稿卡/任务卡附注呈现软维度 findings。

/** plan_review artifact key（链段 artifact，W1a/W1d/子3 消费面）。 */
export const PLAN_REVIEW_KEY = 'plan_review';

const BRIEF_REVIEWER_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'brief-reviewer-node',
  displayName: 'Brief Reviewer Node',
  inputSchemaName: 'chapterBriefSchema',
  outputSchemaName: 'planReview',
  requiredArtifactKeys: ['chapter_brief'],
  producedArtifactKeys: [PLAN_REVIEW_KEY],
  sideEffects: ['call_model'],
};

// ════════════════════════════════════════════════════════════════════════════
// 输出契约：plan_review artifact（design §1 A2 段 + W1c dispatch schema 定稿）
// ════════════════════════════════════════════════════════════════════════════

/**
 * verdict 三档（机械控制信号——W1a 环判据消费，须归一为 canonical 值）。
 *
 * - pass：无硬维度 finding，进 B 写作。
 * - revise：存在 hard finding，回 A1 重编（findings 作重编意图）。
 * - escalate：规划层灰区（escalate-pause 统一机制）。
 */
export const PLAN_REVIEW_VERDICTS = ['pass', 'revise', 'escalate'] as const;
export type PlanReviewVerdict = (typeof PLAN_REVIEW_VERDICTS)[number];

/**
 * 六维度 canonical 标识（dimension 开放 string——mirror reviewOutputSchema dimensions[].name 哲学，
 * 新维度仅 yaml 文档；本表是 yaml 契约的 canonical 值 + 归一目標，非封闭 enum 门）。
 *
 * 软硬划界（design §1 M8，判据消费归 W1d——**severity 才是分流标记**，本表仅文档化域归属）：
 * - 软维度〔戏剧质量/节奏/全书契合〕findings 不触发 auto revise，随任务卡附注呈现。
 * - 硬维度〔红线一致/可写性〕可判 revise。
 * - 信息差操控是**混合维度**：指令自相矛盾（写手无法同时满足）= hard；操控可更精准 = soft——
 *   severity 由 LLM 按 yaml 分级标准逐条判，不可由 dimension 机械推导。
 */
export const PLAN_REVIEW_DIMENSIONS = [
  'drama-quality',
  'book-fit',
  'pacing',
  'info-gap-control',
  'writability',
  'red-line',
] as const;
export type PlanReviewDimension = (typeof PLAN_REVIEW_DIMENSIONS)[number];

const PLAN_DIMENSION_ALIASES: Record<string, PlanReviewDimension> = {
  'drama-quality': 'drama-quality',
  戏剧质量: 'drama-quality',
  戏剧: 'drama-quality',
  'book-fit': 'book-fit',
  全书契合: 'book-fit',
  契合: 'book-fit',
  pacing: 'pacing',
  节奏: 'pacing',
  'info-gap-control': 'info-gap-control',
  信息差操控: 'info-gap-control',
  信息差: 'info-gap-control',
  writability: 'writability',
  可写性: 'writability',
  'red-line': 'red-line',
  红线一致: 'red-line',
  红线: 'red-line',
};

/**
 * verdict 别名归一（mirror normalizeRouteDecision 哲学——LLM 常返中文/变体，环判据需 canonical 值）。
 * 未识别 → undefined（parseOutput 抛 → createLlmNode 重试，machinery 不能驱动未知 verdict）。
 */
const PLAN_VERDICT_ALIASES: Record<string, PlanReviewVerdict> = {
  pass: 'pass',
  approve: 'pass',
  通过: 'pass',
  放行: 'pass',
  合格: 'pass',
  revise: 'revise',
  修订: 'revise',
  重编: 'revise',
  需改: 'revise',
  escalate: 'escalate',
  escalate_user: 'escalate',
  灰区: 'escalate',
  上报: 'escalate',
  升级: 'escalate',
};

export function normalizePlanReviewVerdict(raw: unknown): PlanReviewVerdict | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  if (PLAN_VERDICT_ALIASES[key]) return PLAN_VERDICT_ALIASES[key];
  if (key.includes('escalat') || key.includes('上报') || key.includes('灰区')) return 'escalate';
  if (key.includes('revis') || key.includes('修订') || key.includes('重编')) return 'revise';
  if (key.includes('pass') || key.includes('通过') || key.includes('放行')) return 'pass';
  return undefined;
}

/**
 * severity 归一：'hard'|'soft' canonical + multi-review 习惯值（block/warn）兼容。
 * 未识别 → 'soft'（保守默认：不触发 revise 回环——verdict 才是回环主信号，severity 是分流标记；
 * 坏值降级软档防误触发环，escalate 独立于 severity 不受影响）。
 */
export function normalizePlanReviewSeverity(raw: unknown): 'hard' | 'soft' {
  if (typeof raw !== 'string') return 'soft';
  const key = raw.trim().toLowerCase();
  if (key === 'hard' || key === 'block') return 'hard';
  return 'soft';
}

/** dimension 别名归一（中文/变体 → canonical 英文标识；未知值原样透传——开放 string 观测优先）。 */
function normalizePlanReviewDimension(raw: string): string {
  const key = raw.trim();
  if (!key) return key;
  return PLAN_DIMENSION_ALIASES[key] ?? PLAN_DIMENSION_ALIASES[key.toLowerCase()] ?? key;
}

/** plan_review finding（design §1 A2：dimension + 软硬标记 + grounding + note）。 */
export interface PlanReviewFinding {
  /** 六维 canonical 标识（开放 string，归一后值见 PLAN_REVIEW_DIMENSIONS）。 */
  dimension: string;
  /** 软硬分流标记（W1a/W1d 环判据消费：hard 才触发回环；mixed 维度逐条判）。 */
  severity: 'hard' | 'soft';
  /** 对照输入的哪条字段（如 chapterBrief.mustHide / genreContract.commitments[0]）——grounding 硬要求。 */
  grounding: string;
  /** 问题说明 + 可执行的重编方向。 */
  note: string;
}

/** plan_review artifact shape（brief-reviewer-node 产，规划环 verdict 源）。 */
export interface PlanReviewArtifact {
  verdict: PlanReviewVerdict;
  summary: string;
  findings: PlanReviewFinding[];
  /**
   * graceful 失败标记（CR-E3 mirror wrapper 写入）：规划审核 LLM 失败 → 空 pass-through 直通写作，
   * **非 clean pass**——观测面（summarize/UI/测试）据 skipped 区分「审核通过」与「未审核」。
   */
  skipped?: true;
}

/** LLM 原始输出 schema（severity 宽收 string，parseOutput 归一收敛——坏值降 'soft' 不丢 finding）。 */
const planReviewRawSchema = z.object({
  verdict: z.string().min(1),
  summary: z.string(),
  findings: z
    .array(
      z.object({
        dimension: z.string().min(1),
        severity: z.string(),
        grounding: z.string().min(1),
        note: z.string().min(1),
      }),
    )
    .default([]),
});

// ════════════════════════════════════════════════════════════════════════════
// buildPrompt vars（W0-9 最小充分集，全部 A2 位现成 artifact）
// ════════════════════════════════════════════════════════════════════════════

/** episode_outlines 邻章窗口载荷（currentEpisodeId 帮 LLM 定位本章，episodes = 本章 ±1）。 */
interface EpisodeOutlineWindow {
  currentEpisodeId: string;
  episodes: EpisodeOutline[];
}

/**
 * 机械截取本章 + ±1 邻章（W0-9「机械截取非全量」——全书契合维只需邻章对照，防全量集纲灌爆 prompt）。
 *
 * per-element safeParse（mirror CR-4.1-07 哲学：坏条目单独丢）；episodeId 缺 / 本章 entry 不在 →
 * 空窗口（yaml「空 = 全书契合维跳过」，graceful 降级零回归，mirror reader-audit optional 哲学）。
 */
export function selectEpisodeOutlineWindow(
  raw: unknown,
  episodeId: string | undefined,
): EpisodeOutline[] {
  if (!Array.isArray(raw) || !episodeId) return [];
  const outlines = raw.flatMap((ep) => {
    const parsed = episodeOutlineSchema.safeParse(ep);
    return parsed.success ? [parsed.data] : [];
  });
  const current = outlines.find((ep) => ep.id === episodeId);
  if (!current) return [];
  return outlines
    .filter((ep) => Math.abs(ep.index - current.index) <= 1)
    .sort((a, b) => a.index - b.index);
}

function buildBriefReviewerVars(run: RunSnapshot): Record<string, string> {
  const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
  const outlineWindow: EpisodeOutlineWindow = {
    currentEpisodeId: episodeId ?? '',
    episodes: selectEpisodeOutlineWindow(run.artifacts['episode_outlines'], episodeId),
  };
  return {
    chapterBrief: JSON.stringify(run.artifacts['chapter_brief'] ?? {}),
    episodeOutlines: JSON.stringify(outlineWindow),
    emotionCurve: JSON.stringify(run.artifacts['emotion_curve'] ?? ''),
    genreContract: JSON.stringify(run.artifacts['genreContract'] ?? ''),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// parseOutput + graceful wrapper
// ════════════════════════════════════════════════════════════════════════════

function parsePlanReviewOutput(content: string): NodeResult {
  const raw = planReviewRawSchema.parse(JSON.parse(extractJson(content)));
  let verdict = normalizePlanReviewVerdict(raw.verdict);
  if (!verdict) {
    throw new Error(
      `unrecognized plan review verdict "${raw.verdict}" (expected pass/revise/escalate or alias)`,
    );
  }
  const findings = raw.findings.map((f) => ({
    dimension: normalizePlanReviewDimension(f.dimension),
    severity: normalizePlanReviewSeverity(f.severity),
    grounding: f.grounding,
    note: f.note,
  }));
  // ── 软硬划界归一（链流程重排 W1d 落点：**本处单源**）──
  // design §1 M8「软维度 findings 不触发 auto revise」的消费侧实现。chainRunner readLoopVerdict
  // 只读 verdict 字段（机械控制信号，severity 过滤不能放环判据层）——故 soft-only（或零 findings）
  // 的 revise 建议在此 normalize 为 pass + 附注：软维度 findings 保留在 artifact 里随任务卡呈现
  //（终稿卡/时间线，子3 消费面），不进回环。escalate 独立于 severity 不受影响（灰区语义）。
  // 防确定性空转环：brief-compiler 是纯代码编译器（当前不读 plan_review findings），revise 回环
  // 若无 hard 依据只会原样重编 → review 再判 → 空转到 cap——归一为 pass 是安全侧。
  let summary = raw.summary;
  if (verdict === 'revise' && !findings.some((f) => f.severity === 'hard')) {
    verdict = 'pass';
    summary = `${raw.summary}（soft-only findings——无 hard 缺陷不触发重编回环，随任务卡附注呈现）`;
  }
  const artifact: PlanReviewArtifact = { verdict, summary, findings };
  return { stateKey: PLAN_REVIEW_KEY, artifact };
}

/** createLlmNode 兜底 error artifact 判定（mirror world-extractor CR-E3 wrapper）。 */
function isErrorArtifact(artifact: unknown): artifact is { error: true; message?: string } {
  return (
    Boolean(artifact) &&
    typeof artifact === 'object' &&
    (artifact as { error?: unknown }).error === true
  );
}

/**
 * brief-reviewer 节点工厂：读 chapter_brief（+ optional episode_outlines/emotion_curve/genreContract）
 * → 单次 generate → plan_review artifact。
 *
 * **CR-E3 graceful wrapper**（mirror world-extractor）：规划审核是**增强非硬约束**——LLM 失败（初试+
 * 重试均败的 error artifact）不破链，转空 pass-through 直通写作（verdict='pass' + findings=[]）。
 * 但**永不假 pass 须区分**：failure 标 `skipped: true` 供观测（summarize/UI/测试辨「未审核」≠「审核
 * 通过」）。AbortError 已在 createLlmNode 内重抛（取消语义不吞成 pass-through）。
 *
 * 范式判据（ADR-3）：六维判分归 LLM；本工厂只做 vars 组装 + parse + 归一 + graceful 包装。
 *
 * @param deps LLM deps（generate/modelRef/signal/thinking/fallbacks/taskType，createLlmNode 用）。
 */
export function createBriefReviewerNode(deps: LlmNodeDeps): AgentNode {
  const innerNode = createLlmNode(
    {
      nodeId: 'brief-reviewer-node',
      role: 'brief-reviewer-agent',
      contract: BRIEF_REVIEWER_CONTRACT,
      buildPrompt: buildBriefReviewerVars,
      parseOutput: parsePlanReviewOutput,
    },
    deps,
  );

  return {
    contract: innerNode.contract,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const result = await innerNode.run(input);
      if (isErrorArtifact(result.artifact)) {
        const message =
          typeof result.artifact.message === 'string' ? result.artifact.message : 'unknown error';
        logger.warn(
          { nodeId: 'brief-reviewer-node', message },
          'brief-reviewer: LLM failed after retries → skipped pass-through (chain continues, not a clean pass)',
        );
        return {
          stateKey: PLAN_REVIEW_KEY,
          artifact: {
            verdict: 'pass',
            summary: `规划审核失败（${message}），跳过审核直通写作——skipped 标记，非 clean pass`,
            findings: [],
            skipped: true,
          },
        };
      }
      return result;
    },
  };
}
