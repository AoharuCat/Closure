import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BREATH_THRESHOLD,
  computeL1SignalReport,
  computePacingBreathHotspot,
  computeRevisionGuardL1,
  emptyRevisionGuardL1Report,
  parseRevisionGuard,
  selectScenesForEpisode,
  splicePassage,
  type ChapterBrief,
  type GuardFinding,
  type GuardVerdict,
  type L1SignalReport,
  type ReusableAgentNodeContract,
  type RevisionGuardL1Report,
  type RevisionIntent,
  type SceneGraph,
  type SelectionAnchor,
  type TagChineseFn,
  type ThinkingControl,
  collectRelevantDecisions,
  REVIEW_ATTRIBUTION_VALUES,
} from '@orison/shared-contracts';
import type { GenerateFallbackEntry, StoryDecision } from '@orison/shared-contracts';
import { createLlmNode, isAbortError, MAX_ATTEMPTS, type GenerateFn, type LlmNodeDeps } from './llm-node';
import { collectChapterSceneIds, filterPromiseRegistryForChapter } from './brief-compiler-node';
import { extractJson } from './extract-json';
import { loadAgentPrompt } from '../prompt/agentPrompt';
import { renderTemplate } from '../prompt/template';
import { isPosTaggerAvailable } from '../audit/pos-tagger';
import { projectLintReportForL2 } from '../lint/lintL2Signal';
import { logger } from '../logger';
import type { SessionMessage } from '../types';
import type { GenerationDelta } from '../provider/ipc-provider';
import type { AgentNode, NodeResult, RunSnapshot } from '../contracts/run';

// ── Story 4.0 写章战术链段：LLM 节点实例化（design §4.2/§4.4 / implement.md 3.2/3.5）──
//
// draft-writer / multi-review / route = createLlmNode 工厂实例化。
// 每节点只提供 {role, contract, buildPrompt, parseOutput}，复用 createLlmNode 的「load yaml system +
// renderTemplate user 段 + 单次 generate + parse 失败重试 + 兜底 error artifact」骨架（Step 2 已建）。
// 链流程重排（09-13 W1d + CR 批清理）：targeted-revision-agent 已全量退役删除（「读 review.latest
// 整段改稿」职能被环内 C1 revision-optimizer 编译 + 写手 directive 重跑覆盖——新节点工厂在
// brief-reviewer-node.ts / revision-optimizer-node.ts；dormant 工厂 / CONTRACTS 条目 / yaml 已一并清零）。
//
// artifact key 约定（design §4 数据流 / STATE_KEY_MAP）：
// - draft-writer 读 chapter_brief + scene_graph + settings_context → 产 'draft.initial' {title,text,wordCount,chapterId}
// - multi-review 读 draft.initial + scene_graph + chapter_brief → 产 'review.latest' {verdict,summary,dimensions,reasons}
//   （'story.sync' 已随链流程重排 W1d 移出 requiredArtifactKeys——story-sync 后移 E9，W0-3）
// - route 读 review.latest + chapter_brief + draft.initial → 产 'route_decision' {decision,reason}
//
// STATE_KEY_MAP（engine/registry.ts）：'draft-writer-agent'→'draft.initial' / 'multi-review-agent'→'review.latest' /
// 'route-agent'→'route_decision'（'targeted-revision-agent'→'revision.output' 条目已随 09-13 W1d 退役删除）。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：四节点全 LLM 创造性/裁判节点
// （生成 / 审核 / 改稿 / 路由判决）——非确定性工作。纯代码段（brief 编译 / storySync）在别处。
//
// buildPrompt 把 artifact 序列化为字符串注入 yaml `{{var}}`——JSON.stringify(structured) 让 LLM 读结构化
// 上下文，String(scalar) 取标量。parseOutput = JSON.parse + Zod 校验（inline schema，因 draftOutputSchema /
// reviewOutputSchema 等仅契约元数据名，非实际 Zod schema——核实 grep 无定义）。
//
// expected_downstream_consumers:
// - Story 4.0 Step 5：createChapterChainNodes 用 createDraftWriterNode(deps) 等装配链段。
// - Story 4.2：multi-review 升级 5→14 维（Reader-Audit）——替换 reviewOutputSchema + multi-review yaml。
// - Story 4.6：route escalate_user 路径深化（灰区裁决器 agent）。

/**
 * 四 LLM 节点共享的 deps 形态（透传给 createLlmNode + createReaderAuditNode）。
 *
 * Story 4.2：加 `tagChinese` + `compress` 两 DI seams——仅 Reader-Audit composite 节点消费（L1 stylometry
 * 注入，ADR-2）。draft-writer / route 经 createLlmNode
 * 只读 generate/modelRef/signal，忽略这两个字段（结构兼容）。chapter-chain 装配处从 agent native
 * 模块（pos-tagger）+ node:zlib 注入。
 */
export interface ChapterLlmNodeDeps extends LlmNodeDeps {
  generate: GenerateFn;
  /** Reader-Audit L1 中文 POS tagger（@node-rs/jieba，agent 注入）。缺 → POS-gram/CR:PoS skip（design §10 rollback）。 */
  tagChinese?: TagChineseFn;
  /** Reader-Audit L1 gzip 压缩函数（agent node:zlib 注入）。缺 → CR-words/CR:PoS skip。 */
  compress?: (input: string) => number;
}

// ── helper：安全取 artifact 字段（artifact 可能 undefined / error artifact 形态）──

function artifactAsRecord(run: RunSnapshot, key: string): Record<string, unknown> | undefined {
  const raw = run.artifacts[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function scalarOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

// ── helper：draft-writer storyPlan 精选（4.1 §3.1）──
//
// 4.0 storyPlan = `JSON.stringify(scene_graph 全量)`（粗 dump）。4.1 改为 `selectScenesForEpisode` 精选本章
// 涉及场的结构面（无正文/无全量 dump，承接 1.6 deferred：scene 召回消费点 = Writer compiled context，纯代码
// 结构查询不进 closure_*）。episodeId 从 chapter_brief_input artifact 解析（mirror brief-compiler resolveBriefInput
// 的 episodeId 抽取——`{episodeId, brief}` 形态）；buildPrompt 只拿到 run（无 requirement），故无 requirement fallback
// （链段实际运行 assembleChapterChainArtifacts 总产 chapter_brief_input 含 episodeId）。缺省 → undefined →
// selectScenesForEpisode graceful 返 []（同 brief-compiler plotPoints 缺 episodeId 行为）。

/**
 * 从 chapter_brief_input artifact 解析 episodeId（mirror brief-compiler resolveBriefInput 的 episodeId 抽取）。
 * 仅从结构化 `{episodeId, brief}` 形态取 episodeId；缺省 / 非对象 / 无 episodeId → undefined。
 *
 * Story 8.4：export 供 writer-node.ts 复用（briefHash 章档案按 episodeId 索引）。
 */
export function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// draft-writer 节点
// ════════════════════════════════════════════════════════════════════════════

// Story 8.4：export 供 writer-node.ts（节点内两阶段 agent 循环封装）复用同一节点契约——链装配的
// draft-writer-agent 位换 createWriterNode（chapter-chain.ts 装配行），本契约单源不复制。
export const DRAFT_WRITER_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'draft-writer-agent',
  displayName: 'Draft Writer Node',
  inputSchemaName: 'chapterBriefSchema',
  outputSchemaName: 'draftOutputSchema',
  requiredArtifactKeys: ['chapter_brief', 'scene_graph', 'settings_context'],
  // Story 8.4：draft.initial 每次（两阶段 agent 化 / 降级直写 / 段落级改稿路径全形态）都写；
  // research_brief 是 may-produce——自查成功 / 复用存档时 mutate 写（NodeResult 单 stateKey，mirror
  // revision_guard mutate 先例）；降级路径写 {degraded, reason} 形态（design §5 可观测标注）。
  // Story 8.7：cast_declaration 同为 may-produce mutate 写——阶段 2.5 申报成功 {declaration, source} /
  // 降级 {degraded, reason} / 降级直写与段落级路径不写（S8 汇账处理 undefined = 保守账）。
  producedArtifactKeys: ['draft.initial', 'research_brief', 'cast_declaration'],
  sideEffects: ['call_model'],
};

/**
 * draft-writer 输出 shape（prompts/draft-writer-agent.yaml 契约：title/text/wordCount/chapterId）。
 *
 * CR-8：wordCount `z.coerce.number().optional()`——LLM 常省略或返字符串（"2800"），coerce 容忍；
 * title/text 仍 required（正文核心，缺则真不合格→重试）。
 *
 * Story 7.1 Route 1（段落级 splice）：加 `passageText?` optional——revision_intent 触发段落级改稿时
 * draft-writer 只输出改后段落（passageText），节点 parseOutput splice 回完整 text（design §3.2）。
 * 无 revision_intent 时（首写 / 整章 redo）passageText 缺，text 是完整正文（既有行为零回归）。
 *
 * BMad CR F3a：refine text|passageText 非空——段落级 directive 让 LLM 留空 text 只填 passageText，
 * 若 LLM 误把 passageText 也留空（或返空串）→ refine 拒 → createLlmNode 重试（防 empty draft 静默入库）。
 */
const draftOutputSchema = z
  .object({
    title: z.string(),
    text: z.string(),
    wordCount: z.coerce.number().optional(),
    chapterId: z.string().optional(),
    // Story 7.1 Route 1：段落级输出（revision_intent 触发时 draft-writer 只输出改后段落）。
    passageText: z.string().optional(),
  })
  .refine(
    (d) => (d.text ?? '').trim().length > 0 || (d.passageText ?? '').trim().length > 0,
    { message: 'draft-writer 输出 text 与 passageText 均空——正文核心缺失（段落级改稿时 passageText 必填）' },
  );

/** draft artifact shape（draft.initial；段落级改稿形态 text=改前整章 + passageText=改后段）。 */
export type DraftArtifact = z.infer<typeof draftOutputSchema>;

/**
 * draft-writer user 模板 vars 抽取（原 createDraftWriterNode.buildPrompt 内联，Story 8.4 抽出供
 * writer-node.ts 两阶段路径复用——稳定前缀 = renderTemplate(userTemplate, 本函数结果)，两处单源防漂移）。
 */
export function buildDraftWriterVars(run: RunSnapshot): Record<string, string> {
  return {
    chapterTask: JSON.stringify(run.artifacts['chapter_brief'] ?? {}),
    storyPlan: JSON.stringify(
      selectScenesForEpisode(
        run.artifacts['scene_graph'] as SceneGraph | undefined,
        resolveEpisodeId(run.artifacts['chapter_brief_input']),
      ),
    ),
    projectContext: scalarOf(run.artifacts['settings_context']),
    // 风格卡片 MVP（B 路 R5）：style_context artifact（write_chapter post-assemble 注入，含自带开场
    // 说明——非空时即完整指令块）→ yaml `{{styleContext}}` slot（无卡 = artifact 缺 → 空串塌空行，
    // 零回归 mirror revisionFeedback）。writer-selfcheck（writer-node.ts 阶段一）复用同一稳定前缀
    // （renderTemplate(userTemplate, 本函数)）——风格卡天然同供两阶段，无需另接线。
    styleContext: scalarOf(run.artifacts['style_context']),
    // Story 4.3 Step 3：redo feedback → revisionFeedback directive block（空串当无反馈，零回归）。
    revisionFeedback: formatRevisionFeedback(run.artifacts['revision_feedback']),
    // Story 7.1 Route 1：RevisionIntent（段落级改稿指令）→ revisionIntent directive block。
    // revision_intent artifact 由 runChapterChain redo path 注入（caller = resume-chapter-chain IPC
    // redo action 携 revisionIntent）。非空 → 渲染段落级改稿 directive（只改选区段 + 锁定 lockedItems
    // + 只输出 passageText）；空/缺 → ''（零回归，首写/无 intent 整章路径不变）。
    revisionIntent: formatRevisionIntent(run.artifacts['revision_intent']),
  };
}

/**
 * draft-writer 输出解析（原 createDraftWriterNode.parseOutput 内联，Story 8.4 抽出供 writer-node.ts
 * 阶段二复用——同一 draftOutputSchema + 7.2 段落级保改前逻辑单源）。抛错（parse/Zod 失败）→ caller
 * 重试（mirror createLlmNode 语义）。
 */
export function parseDraftOutput(content: string, run: RunSnapshot): NodeResult {
  const parsed = draftOutputSchema.parse(JSON.parse(extractJson(content)));
  // Story 7.2：段落级 splice **从 draft-writer 移到 revision-guard 节点**（design §0.2/§1.4）。
  // 7.1 splice 在此 parseOutput 内（同步），但 7.2 护栏需 pre-commit（splice 前 L2 判定 + soft 越界
  // pause），L2 是异步 LLM 塞不进同步 parseOutput → splice 拆出，draft-writer 段落级时只产 passageText
  // + 保改前整章 text，revision-guard 节点判定后 splice。
  //
  // 段落级（passageText + revision_intent.scope.anchor）：**不 splice**，落
  // `{ ...parsed, text: previousText, passageText }`——text 显式保改前整章（防 parsed 覆盖丢改前），
  // passageText 保改后段落留给 revision-guard splice。previousText 从 run.artifacts['draft.initial'].text
  // 读（redo resume 时上一轮完整正文，chainRunner 在 parseOutput 返回后才 overwrite :177，7.1 既有不变）。
  const intent = readRevisionIntent(run.artifacts['revision_intent']);
  if (parsed.passageText && intent?.scope?.anchor) {
    const previousDraft = artifactAsRecord(run, 'draft.initial');
    const previousText = scalarOf(previousDraft?.text);
    if (!previousText) {
      // 异常：段落级 intent 但无 previousText（redo resume 无前稿？）→ error artifact（防空 text 入库，
      // mirror 7.1 F1 永不静默数据丢失）。revision-guard 也会再守一层，但 draft-writer 是第一道。
      return {
        stateKey: 'draft.initial',
        artifact: {
          error: true,
          nodeId: 'draft-writer-agent',
          message: '段落级改稿但无 previousText（draft.initial.text 缺），无法保改前整章——请重试',
        },
      };
    }
    // 保改前整章 text + passageText（改后段）留给 revision-guard splice。title/wordCount 保 parsed。
    return {
      stateKey: 'draft.initial',
      artifact: { ...parsed, text: previousText, passageText: parsed.passageText },
    };
  }
  return { stateKey: 'draft.initial', artifact: parsed };
}

// ── 链流程重排 W2（R3 终稿手改通道 + R4c 落盘拆两步）：editedDraft 覆写单源 ──

/**
 * W2（plan-review L2）：editedDraft 覆写后的 wordCount 机械重算——终稿卡编辑面只有正文全文，
 * LLM 自报 wordCount 对手改稿必 stale。非空白字符计数（CJK 习惯口径）。纯代码机械。
 */
export function recountDraftWordCount(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/**
 * W2（R3）：终稿 checkpoint 人手改正文全文 → 覆写 artifacts 集（resume.editedDraft 消费单源——
 * workflow.ts resume 读回与 shell resume IPC F1a 候选组装共用）。
 *
 * 机械动作（mirror「stale 清理不变式」）：
 * 1. `draft.initial`：text = editedDraft + wordCount = recountDraftWordCount + 剥 passageText
 *    （段落级残留对终稿无意义——终稿是整稿形态）。draft.initial 缺（防御：终稿 pause 必有）→ 不覆写
 *    （caller 语义 = 无稿可改，resume 续跑原稿）。
 * 2. **申报类 stale 清理**：人改正文后写手上一轮的申报不再可信——清 `cast_declaration`（写手阶段
 *    2.5 的登场申报，mention-ledger 申报通道降级保守账 = 设计意图）+ 剥 `research_brief.suspended`
 *    （挂起载荷与终稿互斥，防御性清理）。title 保留（终稿卡编辑面只有正文，title 不 stale）。
 *
 * 范式判据（ADR-3）：整稿覆写 + 字段删除 = 纯机械（人改是最高权威，不走 optimizer 意图编译）。
 */
export function applyEditedDraft(
  artifacts: Record<string, unknown>,
  editedText: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...artifacts };
  const draft = next['draft.initial'];
  if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
    const { passageText: _stale, ...restDraft } = draft as Record<string, unknown>;
    void _stale;
    next['draft.initial'] = {
      ...restDraft,
      text: editedText,
      wordCount: recountDraftWordCount(editedText),
    };
  }
  delete next['cast_declaration'];
  const researchBrief = next['research_brief'];
  if (researchBrief && typeof researchBrief === 'object' && !Array.isArray(researchBrief)) {
    const { suspended: _s, ...restBrief } = researchBrief as Record<string, unknown>;
    void _s;
    next['research_brief'] = restBrief;
  }
  return next;
}

/**
 * draft-writer 节点：读 chapter_brief + scene_graph + settings_context → 单次 generate → JSON parse 出初稿。
 * stateKey='draft.initial'（STATE_KEY_MAP）。buildPrompt 抽 chapterTask/storyPlan/projectContext 三 var
 * （对齐 prompts/draft-writer-agent.yaml 的 {{chapterTask}}/{{storyPlan}}/{{projectContext}}）。
 *
 * Story 4.1 §3.1：storyPlan 从 scene_graph 全量 dump 升级为 `selectScenesForEpisode` 精选（本章涉及场的结构面，
 * episodeId 从 chapter_brief_input 解析）——瘦身上下文 + 承接 1.6 deferred（scene 召回消费点）。
 *
 * Story 4.3 Step 3（design §3.4 redo directive）：读 run.artifacts['revision_feedback']（redo 时 runChapterChain
 * 注入）→ revisionFeedback var。非空 → 渲染「改稿反馈」directive block 注入 user prompt（prompt 用户审阅后重写
 * 本章的指令）；空/缺 → ''（renderTemplate 替换为空，yaml {{revisionFeedback}} 行塌成空行，零回归）。
 * revision_feedback 由 runChapterChain options.redo.feedback 注入（caller = resume-chapter-chain IPC redo action /
 * leader write_chapter redo 路径）。draft-writer 是当前唯一消费者（最小实现；其他节点忽略此 artifact）。
 *
 * Story 8.4（A2/A9）：链装配的 draft-writer 位换 writer-node.ts `createWriterNode`（节点内两阶段 agent 循环
 * ——阶段一自查产调查简报 / 阶段二写作）。本单发节点保留作其**降级直写引擎**（工具环境不可用 / 段落级改稿
 * 路径，design §1.1 边界 + §5 兼容）——零行为变化，既有 draft-writer 测试全绿。
 */
export function createDraftWriterNode(deps: ChapterLlmNodeDeps): AgentNode {
  return createLlmNode(
    {
      nodeId: 'draft-writer-agent',
      role: 'draft-writer-agent',
      contract: DRAFT_WRITER_CONTRACT,
      buildPrompt: buildDraftWriterVars,
      parseOutput: parseDraftOutput,
    },
    deps,
  );
}

/**
 * Story 4.3 Step 3：把 redo feedback artifact 渲染为 draft-writer user prompt 的 directive block。
 *
 * 非空字符串 → 「改稿反馈」段落（明示用户审阅后要求重写 + 反馈正文），让 draft-writer 据反馈调整（其余
 * chapterTask/storyPlan/projectContext 指令不变）。空/缺 → ''（yaml {{revisionFeedback}} 塌成空行，零回归）。
 * 纯字符串格式化（非语义判断——反馈内容由用户给，本函数只包装成 prompt 段）。
 */
function formatRevisionFeedback(feedback: unknown): string {
  if (typeof feedback !== 'string' || feedback.trim().length === 0) return '';
  return `\n---\n【改稿反馈】用户审阅初稿后要求重写本章，请按以下反馈调整（其余指令不变）：\n${feedback.trim()}\n`;
}

// ── Story 7.1 Route 1：RevisionIntent 段落级改稿 directive（design §3.2）──

/**
 * 安全读 revision_intent artifact 为 typed RevisionIntent（shape 守卫，非语义裁判）。
 *
 * revision_intent 由 runChapterChain redo path 注入（caller IPC 携 RevisionIntent → initialArtifacts）。
 * 非 RevisionIntent shape（缺 change/lockedItems/provenance 等必填）→ undefined（graceful，当无 intent）。
 *
 * BMad CR F7：守卫对齐 formatRevisionIntent 读取的字段——rationale.note / provenance.compilerNote /
 * change.details（数组）一并校验，防坏 artifact 致 directive 渲染 TypeError 崩 buildPrompt → error artifact
 * 崩整链（IPC 路径已 revisionIntentSchema safeParse 过，此处是防御未来 in-process 构造路径如 7.4 A trigger）。
 *
 * Story 7.4 §1.6：新增 structuralEdit optional boolean 守卫。BMad CR-007：非布尔值（LLM 常 "true"
 * 字符串）→ strip flag（视为未设=保守正常护栏），保 intent 其余有效字段（旧 return undefined 丢整个 intent）。
 *
 * Story 8.4：export 供 writer-node.ts 复用（段落级改稿 intent → 修订轮跳过自查的边界判定，单源）。
 */
export function readRevisionIntent(raw: unknown): RevisionIntent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const change = obj.change as Record<string, unknown> | undefined;
  if (!change || typeof change.summary !== 'string') return undefined;
  // change.details 可选；有则须数组（formatRevisionIntent .join）。
  if (change.details !== undefined && !Array.isArray(change.details)) return undefined;
  if (!Array.isArray(obj.lockedItems)) return undefined;
  const rationale = obj.rationale as Record<string, unknown> | undefined;
  if (!rationale || typeof rationale.note !== 'string') return undefined;
  const provenance = obj.provenance as Record<string, unknown> | undefined;
  if (!provenance || typeof provenance.rawUserInstruction !== 'string') return undefined;
  if (typeof provenance.compilerNote !== 'string') return undefined;
  // scope.anchor 可选（整章 intent 无 scope）；有则校验 quote。
  const scope = obj.scope as Record<string, unknown> | undefined;
  if (scope) {
    const anchor = scope.anchor as Record<string, unknown> | undefined;
    if (!anchor || typeof anchor.quote !== 'string') return undefined;
  }
  // Story 7.4 §1.6（BMad CR-007）：structuralEdit 非布尔（LLM 常 "true" 字符串）→ strip（视为未设=保守正常
  // 护栏），保 intent 其余有效字段。旧 return undefined 丢整个 intent → redo 跑但无修订指令浪费迭代。
  // 守保：非布尔 = 未设（undefined），intent 其余有效。in-place delete（obj 是 raw 的 cast 同引用，非 copy）。
  if (obj.structuralEdit !== undefined && typeof obj.structuralEdit !== 'boolean') {
    delete obj.structuralEdit;
  }
  return raw as RevisionIntent;
}

/**
 * Story 7.1 Route 1：把 RevisionIntent 渲染为 draft-writer user prompt 的段落级改稿 directive。
 *
 * 非空 RevisionIntent（带 scope.anchor = 选区触发）→ 「段落级改稿」段落：明示只改选区段（quote）+ 目标
 * （change）+ 锁定项（lockedItems 硬锁/软锁 + 来源标注）+ **只输出 passageText 不输出整章**。下发两层
 * 三层权威：rawUserInstruction（硬）+ compilerNote（软标 LLM 理解）+ lockedItems 权威分层（design §2.3）。
 *
 * 无 scope（整章 intent / A trigger 无选区）→ 仍渲染 directive 但要求整章 text（非 passageText）；当前 7.1
 * B1 trigger 必带 scope，A trigger 归 7.4，此处整章分支预留。
 *
 * undefined / shape 不符 → ''（yaml {{revisionIntent}} 塌空行，零回归，首写/无 intent 整章路径不变）。
 * 纯字符串格式化（非语义判断——意图内容由 revision-optimizer LLM 产，本函数只包装成 prompt 段）。
 */
function formatRevisionIntent(raw: unknown): string {
  const intent = readRevisionIntent(raw);
  if (!intent) return '';
  // Story 7.4 §1.6：structuralEdit-only intent（无 scope）是 revision-guard 的结构编辑标记，非 draft-writer
  // 改稿指令（环 B 整章重写由 draft-writer 消费新 scene_graph 重写，不应灌「段落级改稿指令」段）。返 '' 让
  // draft-writer 走正常整章路径（revision_intent 仅 revision-guard 读 structuralEdit flag）。零回归（今天
  // 无 structuralEdit intent；7.1 B-trigger 必带 scope 不进此分支）。
  if (intent.structuralEdit && !intent.scope?.anchor) return '';
  const hasScope = Boolean(intent.scope?.anchor);
  const lockLines = intent.lockedItems
    .map((item) => {
      const tag = item.authority === 'hard' ? '硬锁（用户原话）' : '软锁（AI 推断）';
      const ev = item.evidence ? `；依据：${item.evidence}` : '';
      return `  - [${tag}] ${item.field}${ev}`;
    })
    .join('\n');
  const scopeBlock = hasScope
    ? `\n【选区范围】只修改以下选中段落，其余正文一字不动：\n${intent.scope?.anchor.quote ?? ''}`
    : '\n【范围】整章范围（无选区）';
  const outputRule = hasScope
    ? '**只输出改后的该段落（passageText 字段），不要输出整章正文（text 字段留空串）。**'
    : '输出完整章节正文（text 字段）。';
  return `\n---\n【段落级改稿指令】${scopeBlock}
【改什么】${intent.change.summary}${
    intent.change.details && intent.change.details.length > 0
      ? `\n【细化】${intent.change.details.join('；')}`
      : ''
  }
【不改什么（锁定项，严禁越界改动）】
${lockLines || '  （无锁定项）'}
【用户原话（硬权威）】${intent.provenance.rawUserInstruction}
【AI 编译说明（软，标「LLM 理解非用户原话」）】${intent.provenance.compilerNote}
【触发原因】${intent.rationale.note}
【输出要求】${outputRule}
`;
}

// ════════════════════════════════════════════════════════════════════════════
// Reader-Audit 节点（Story 4.2：替换单 createLlmNode 的 5 维 multi-review）
// ════════════════════════════════════════════════════════════════════════════
//
// 双层引擎（design §2 / R3 §6.0 / ADR-7）：L1 纯代码 stylometry（computeL1SignalReport，soft signal
// hotspot）→ L2 LLM Reader-Audit（一致性维 ConStory 19 子类 + 叙事特征维 anti-slop 语义判定）。
// composite 节点（非 createLlmNode 单体）：因 L1→L2 是节点内部两步数据流（L1 先算一次 → 喂 L2 prompt）。
//
// 节点 id 保留 'multi-review-agent'（design §10「节点替换隔离」：stable artifact contract with route /
// registry STATE_KEY_MAP / CHAPTER_CHAIN_NODE_IDS / checkpointStage / revision loop 切片——换实现不换 id，
// ripple 最小）。工厂函数改名为 createReaderAuditNode（语义清晰）；yaml 文件 prompts/multi-review-agent.yaml
// 内容 rework 为 Reader-Audit（role/loadAgentPrompt 仍 'multi-review-agent' 找到该文件）。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：L2（本节点 generate）做语义判定
// （矛盾/意象陈腐/agency），L1（computeL1SignalReport，已落地）只做确定性统计/结构查——L2 不偷做 L1 该
// 做的机械活（如再算一遍 cliché 密度），只消费 L1 hotspot 做语义裁判。

const READER_AUDIT_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'multi-review-agent',
  displayName: 'Reader-Audit Node',
  inputSchemaName: 'reviewInput',
  outputSchemaName: 'reviewOutputSchema',
  // design §3：加 chapter_brief（喂 gap 白名单 intent——mustHide/hintOnly/doNotWrite + gap_whitelist）。
  // 链流程重排 W1d（W0-3 断链级适配）：移除 'story.sync'——story-sync 后移提取段 E9（route 后），
  // hard required 会让每章在 C5 审读位 blocked 断链。
  // 链流程重排 W3（R5 提取段后移适配）：continuityMemory var 已删（buildPrompt 不再读 story.sync——
  // 审读对照源 = 启动前快照 + 计划；本章自提物对照本章是循环论证，E9 在审读后也不存在本章提取物）。
  requiredArtifactKeys: ['draft.initial', 'scene_graph', 'chapter_brief'],
  producedArtifactKeys: ['review.latest'],
  sideEffects: ['call_model'],
};
// Story 6.6 Phase D：Reader-Audit 一致基底——`world_state_snapshot` artifact（caller 在 chain 启动前取
// snapshot 注入 initialArtifacts）作可选消费：buildPrompt 读 `run.artifacts['world_state_snapshot']` →
// worldStateContext var。**不在 requiredArtifactKeys**：snapshot 是增强基底（前章已建立状态供一致性对照），
// 首章 / 测试环境 / fetch 失败 / 工具未注册时 artifact 缺——hard required 会让 chainRunner DAG check 阻塞链段
// （status='blocked'），违 graceful。optional 消费 + buildPrompt graceful 缺失处理（?? '' → 空段，零回归），
// 照「现有 artifact 缺失处理」惯例（同 briefIntent 缺失降级）。范式判据（ADR-3）：snapshot
// 注入 = 数据流（reduce 已在前章纯代码算），「prose vs 已建立状态是否矛盾」归 L2 LLM 语义裁判（非纯代码 diff）。
//
// Story 6.5：Reader-Audit 加 promise-landing 维（落地公理）——`promise_registry` artifact（assembleChapterChainArtifacts
// 已注入）作可选消费，buildPrompt 读 `run.artifacts['promise_registry']` → promiseLedger var（mirror world_state_snapshot
// optional + graceful 哲学，buildPrompt 内 `?? ''`）。**不套 hasNarrativeFeatureBlock force-escalate guard**（:583-599）——
// promise-landing 维名不含 narrative|discourse|imagery|agency 关键字（guard 不命中），且落地缺失是内容缺陷 writer 能补
// （非 discourse 人导演域），severity=block/warn 走 route LLM 判常 auto_revise（design §8.3 / D8）。落地裁判归 L2 语义
// （「登记的 plant 是否正文真写」= 语义，mirror 6.6 snapshot L2 模式），L1 纯代码不参与。严守 per-chapter scope（design §9）：
// 只查本章登记节拍 plan↔prose 对齐，不查 4.4 cross-arc 兑现 / 6.2 认知状态机违背。
//
// Story 6.2：Reader-Audit 加 info-gap 维（认知状态机违背）——`cognition_snapshot` artifact（caller chain 启动前经
// fetchCognitionSnapshotViaTool / fetchCognitionSnapshotForIpc 注入 initialArtifacts）作可选消费，buildPrompt 读
// `run.artifacts['cognition_snapshot']` → cognitionContext var（mirror world_state_snapshot/promise_registry optional +
// graceful 哲学，buildPrompt 内 `?? ''`）。snapshot = per-character BeliefStatus 投影视图（projectBeliefStatus 纯函数，
// 认知轴自由 JSON → typed believes_true/unaware/suspects/believes_false + hasReaderPerceivedLayer 分层标记）。
// **范式判据（ADR-3 / design §4）**：snapshot 构造 + BeliefStatus 投影 = 纯代码（查询/汇编/结构 key→status 映射）；
// 违规「该段是否真在表现角色知情」（KNOWLEDGE_VIOLATION）/「后文是否真写成不知情」（FORGOTTEN_REVEAL）= 语义归 L2
// （mirror 6.6 snapshot L2 模式）。**L2 路径不依赖在场场数据**（scene_graph 无在场字段，design §11）；transmit 场/在场
// PlotLens 机械法 = DW-1 defer（前置=在场性建模，独立 story）。
// **不套 hasNarrativeFeatureBlock force-escalate**（:583-599）——info-gap 维名不含 narrative|discourse|imagery|agency
// 关键字（guard 不命中），认知违背是内容缺陷 writer 能补写（非 discourse 人导演域），severity=block/warn 走 route LLM
// 判常 auto_revise（design D5/D6）。严守 per-chapter scope（design §8 三边界）：只查本章 draft vs chain 注入的前章认知状态，
// **不查** cross-arc「该认知以后会不会反转」（4.4 范畴）/ **不改** promise-landing 维代码（6.5 done，机制独立）。
//
// Story 2.5：Reader-Audit 加 contract 维（承诺违背）——`genreContract` artifact（assembleChapterChainArtifacts
// safeParse creative_brief.{commitments,genre_tags} + world_setting.world_constitution 注入，mirror promise_registry
// 既有 creative-field 流）作可选消费，buildPrompt 读 `run.artifacts['genreContract']` → genreContract var
// （mirror promise_registry optional + graceful 哲学，buildPrompt 内 `?? ''`）。范式判据（ADR-3 / design §4.1）：
// artifact 组装 = 纯代码机械，「正文是否违背用户定的核心承诺 / 世界规则」= 语义归 L2（砍旧硬 BLOCK 纯代码引擎
// 假信心门）。白名单（design §4.1「Subvert execution, not contract」）：颠覆执行 vs 违背契约归 LLM 语义判
// （mirror briefIntent 故意惊喜白名单 :26-32）——颠覆 execution 不报，违背核心承诺才报。套路陈旧 WARN defer 9.4
// （design §5 F=(b)）。**不套 hasNarrativeFeatureBlock force-escalate**（:583-599）——contract 维名不含
// narrative|discourse|imagery|agency 关键字（guard 不命中），违背承诺 writer 能补写（非 discourse 人导演域），
// severity=block/warn 走 route LLM 判常 auto_revise（mirror promise-landing :55-56 逻辑）。严守 per-chapter scope：
// 只判本章正文 vs 用户定承诺，不查跨弧兑现（4.4 范畴）。
//
// Story 8.4 Step 6（A11 审核对照，design §1.9）：`research_brief` artifact（写手自查产，链内 writer mutate 写先于
// 本节点）作可选消费 → researchBrief var（mirror cognitionContext optional + graceful 哲学，buildPrompt 内 `?? ''`——
// 注入简报本体，degraded 形态无 brief 天然空）。有简报 → findings 可携 attribution 三态（execution_gap 执行漏 /
// planning_blind 规划盲 / plan_level 计划层——归因是 L2 语义，schema optional + .catch 容忍）；无简报（旧章/直写/
// 降级）降级零回归（attribution 不产出）。归因消费链：route/裁决器经 extractEscalateFindings 机械透传（chainRunner）。

/**
 * Reader-Audit 输出 shape（design §6 / R3 §1.2 ConStory-Checker grounding）。
 *
 * verdict `z.string()` 开放（同 1.9 叙事枚举惯例 / ADR-3）——route LLM 读 verdict 字符串作创作判断
 * （ADR-17 反馈路由），无纯代码机械 switch on verdict。封闭 enum 易被 LLM 变体打破→假信心判死。
 *
 * dimensions[].name 开放 string（design §6：'consistency' | 'narrative-feature' + 未来 'completeness' /
 * 'info-gap' / 'ooc' / 'genre'——dimensions[] 可扩展，下游接口预留 design §11）。
 *
 * findings[]：每条带 grounding（quote 正文原句 + location 段/句+offset）——R3 §1.2 ConStory-Checker
 * evidence-grounded 强制；无 grounding 的发现 L2 prompt 视为无效。subClass = ConStory 19 子类（一致性维），
 * 如 'Characterization.memory' / 'Timeline.causality'。severity 封闭 enum（block/warn/info）= 机械控制信号
 * （route defense guard + 下游消费需规范化值），非语义。
 *
 * 向后兼容（design §6）：review.latest 是链段 artifact（非持久化创作字段）→ 无 DB migration。chain 测试
 * 随 shape 变更更新（Step 8）。
 */
const reviewOutputSchema = z.object({
  verdict: z.string(),
  summary: z.string(),
  dimensions: z
    .array(
      z.object({
        name: z.string(),
        findings: z
          .array(
            z.object({
              subClass: z.string().optional(),
              // E9（CR patch）：.catch('warn') 非 .default——容忍非法 enum 值（如 'critical'）降级 'warn'，
              // 避免单坏值丢全 review（.default 只管 undefined 不忍非法值；.catch 两者皆容）。
              severity: z.enum(['block', 'warn', 'info']).catch('warn'),
              // E3（CR patch）：.min(1) 拒空串——grounding 硬要求 defense-in-depth（R3 §1.2 evidence-grounded），
              // 空串过 Zod = 无 grounding 发现，违 ConStory-Checker 硬要求。
              quote: z.string().min(1),
              location: z.string().min(1),
              explanation: z.string(),
              // Story 8.4 Step 6（A11 审核对照归因，design §1.9）：三态枚举单源 shared REVIEW_ATTRIBUTION_VALUES
              // （EscalateFinding.attribution 平行同步）。optional——无调查简报（旧章/直写/自查降级）或与计划
              // 无关的 finding 不带；.catch(undefined) mirror severity E9 容忍——非法值降级「无归因」丢字段
              // 不丢 finding（单坏值不掀翻整个 review）。
              attribution: z.enum(REVIEW_ATTRIBUTION_VALUES).optional().catch(undefined),
              // 链流程重排 W3（R2 去味门禁 H2）：finding 来源标记。'lint' = 该条是 Reader-Audit 对
              // lintReport 静态命中清单（lint-node 产）逐组判真后的确认条目——prompt 契约约束 L2 只对
              // 清单来源的真阳携带（机械豁免判据：hasNarrativeFeatureBlock 与 summarize.lintUnresolved
              // 按 source==='lint' 判源不判义——豁免依据是「来源=机械引擎命中」非内容判断，范式安全）。
              // 非 lint 来源（L2 自判 / semantic 8 条判定任务）不携带——semantic 判定无机械确认，仍归
              // 人导演域硬规则。optional + .catch(undefined) mirror attribution 容忍——非法值降级
              // 「无来源」丢字段不丢 finding（单坏值不掀翻整个 review）。
              source: z.enum(['lint', 'agent']).optional().catch(undefined),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  reasons: z.array(z.string()).default([]),
});

/** review artifact shape（review.latest；route 节点读 verdict + dimensions + reasons 路由）。 */
export type ReviewArtifact = z.infer<typeof reviewOutputSchema>;

/**
 * Reader-Audit composite 节点：L1 纯代码 stylometry → L2 LLM 双层审核 → review.latest（design §3/§5）。
 *
 * run 流程（design §3）：
 *  1. draft = artifacts['draft.initial'].text
 *  2. l1 = computeL1SignalReport({draftText, sceneGraph, episodeId, deps:{tagChinese, compress}})
 *     ——纯代码（POS/CR/句长/词汇/cliché/crutch/filter/标点/storyTime fold），soft signal hotspot。
 *  3. userPrompt = renderTemplate(yaml.user, {draftText, l1Hotspots, storyPlan, briefIntent})
 *  4. generate(system, userPrompt, modelRef) ——复用 createLlmNode 的 generate+retry+abort 骨架（design §3）。
 *  5. parsed = reviewOutputSchema.parse(JSON.parse(extractJson(content)))
 *  6. parse 失败 ×MAX_ATTEMPTS → **fallback verdict='escalate'**（R6① 永不假 pass / 静默 fail）。
 *
 * DI（ADR-2）：tagChinese + compress 经 ChapterLlmNodeDeps 注入（agent native 模块，shared-contracts
 * native-free）。缺省 → L1 跳过 POS/CR 信号（design §10 rollback），L2 仍跑。
 *
 * contract requiredArtifactKeys 加 chapter_brief（喂 gap 白名单 intent）。episodeId 从 chapter_brief_input
 * 解析（optional——缺则 storyTimeContext 缺省，L1 一致性 hint 降级，L2 仍跑）。
 *
 * stateKey='review.latest'（STATE_KEY_MAP 不变）。
 *
 * expected_downstream_consumers:
 * - route 节点：读 review.latest.verdict + dimensions（R6② defense guard 查 narrative-feature block）。
 * - revision-optimizer（链流程重排 C1，revision-optimizer-node.ts）：读 review.latest block/warn
 *   findings 编译 RevisionIntent（targeted-revision 退役后的环内改稿继任）。
 * - 4.6 裁决器 / Epic 7 改稿护栏：消费 findings[]{quote,location,severity} 定位改稿（grounding 复用）。
 */
export function createReaderAuditNode(deps: ChapterLlmNodeDeps): AgentNode {
  const { generate, modelRef, thinking, signal, compress, fallbacks, taskType, onDelta } = deps;
  const nodeId = 'multi-review-agent';
  // B2（CR patch）：tagger 注入前查可用性——binding 不可用时 tagChinese=undefined → stylometry `!tagger` 分支
  // 给诚实 'skipped: tagger 未注入' note（否则 tagger 返 [] 产伪 '文本过短' / lexical 'word-level' note，撒谎）。
  // isPosTaggerAvailable() 在此消费（不再是死代码——生产路径 chapter-chain 注入 native tagChinese）。
  const tagChinese = isPosTaggerAvailable() ? deps.tagChinese : undefined;

  return {
    contract: READER_AUDIT_CONTRACT,
    async run(input): Promise<NodeResult> {
      const { run } = input;

      // ── L1：纯代码 stylometry（design §3/§4）。DI 注入 tagger/compress（ADR-2 seam）──
      const draft = artifactAsRecord(run, 'draft.initial');
      const draftText = scalarOf(draft?.text);
      const sceneGraph = run.artifacts['scene_graph'] as SceneGraph | undefined;
      const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      // E1（CR patch）：L1 compute 包 try/catch——抛错降级空 report，继续 L2（不崩链）。L1 是软 hint，失败
      // 降级空 report 即可；R6①「永不假 pass / 永不崩链」由 L2 escalate fallback 兜底（L1 失败不绕 escalate，
      // L2 仍跑，仅缺 L1 hotspot 提示）。pos-tagger E1（tagger 内部 try/catch）+ 此处外层 = 双重防线。
      let l1: L1SignalReport;
      try {
        l1 = computeL1SignalReport({
          draftText,
          sceneGraph,
          episodeId,
          deps: { tagChinese, compress },
        });
      } catch (err) {
        logger.warn(
          { nodeId, err: err instanceof Error ? err.message : String(err) },
          'createReaderAuditNode.run: L1 compute threw → degrade to empty report, continue to L2',
        );
        l1 = { signals: [], hotspots: [] };
      }

      // ── L2：render prompt + generate + parse（复用 loadAgentPrompt + renderTemplate + extractJson）──
      const { system, userTemplate } = await loadAgentPrompt(nodeId);
      // Story 5.4：复用 selectScenesForEpisode 结果——storyPlan（JSON 序列化喂 prompt）+ pacingBreath（纯代码
      // 连续高强度计数消费同一结构面，避免二次算 selectScenesForEpisode）。chapterScenes 是 SceneStructureDigest[]，
      // computePacingBreathHotspot 结构兼容消费（只需 {id, pacingRole?}）。
      const chapterScenes = selectScenesForEpisode(sceneGraph, episodeId);
      const storyPlan = JSON.stringify(chapterScenes);
      // 链流程重排 W3（R5）：continuityMemory（story.sync 序列化）var 已删——story-sync 后移 E9（审读
      // 后），C5 位无本章提取物；审读对照源 = 启动前快照（world_state/promise/cognition）+ 计划（brief）。
      const briefIntent = JSON.stringify(run.artifacts['chapter_brief'] ?? ({} as ChapterBrief));
      // Story 6.6 Phase D：world_state_snapshot 一致基底（chapter-level，前章已建立状态）—— caller 在 chain
      // 启动前取 snapshot 注入 initialArtifacts（write_chapter tool / closureChainIpc）。graceful：artifact 缺
      // （测试环境 / fetch 失败 / 首章无前章状态）→ 空串（renderTemplate 塌空行，零回归，Reader-Audit 不崩）。
      // snapshot 非空 → 序列化主体状态供 L2 一致性维对照已建立状态找矛盾（prose vs 已 reduce 状态）。
      const worldStateContext = JSON.stringify(run.artifacts['world_state_snapshot'] ?? '');
      // Story 6.5：promise_registry（本章登记的读者债节拍）→ promise-landing 维数据源。**复用 assembleChapterChainArtifacts
      // 已注入的 promise_registry artifact**（Option A，非新建 promise_ledger_snapshot fetch helper）——promise_registry
      // 是 creative field 落 project.yaml（异于 closure_world_state 在 db 需单独 fetch），assemble 阶段已 safeParse 注入
      // initialArtifacts，chainRunner 透传 run.artifacts（同 scene_graph / story_decisions 既有流）。emergence 节点经
      // builtin 写盘**不改 run.artifacts**（disk path），故此 artifact 全程为 chain 启动前快照 = 本章应落地的计划节拍
      // （brief-compiler #7 compilePromiseTasks 读同一源——compile 与 audit 数据源一致）。graceful：artifact 缺 / 空
      // registry → 空串（renderTemplate 塌空行，promise-landing 维无数据，零回归；不在 requiredArtifactKeys，mirror
      // world_state_snapshot optional 哲学 chapter-nodes.ts:208-214）。落地裁判归 L2 语义（非 L1 纯代码，design §8.2）。
      //
      // E6 fix（CR-E6）：promiseLedger var **filter 本章自洽子集**（mirror compilePromiseTasks filter 单源，复用
      // filterPromiseRegistryForChapter + collectChapterSceneIds），非全 registry。理由：Reader-Audit 只判「本章登记的
      // 节拍是否正文落地」（per-chapter scope，design §9），全 registry 会让 LLM 误报后章 Promise 为 missing-payoff /
      // 跨章干扰（scope 泄漏，research reader-audit-landing-check §Q4）。filter 后两消费者（brief #7 + audit var）
      // 数据源一致 + 语义更准（只看本章该落地的节拍）。
      const chapterSceneIdsForAudit = collectChapterSceneIds(sceneGraph, episodeId);
      const promiseLedgerSubset = filterPromiseRegistryForChapter(
        run.artifacts['promise_registry'],
        episodeId,
        chapterSceneIdsForAudit,
      );
      const promiseLedger = JSON.stringify(promiseLedgerSubset);
      // Story 6.2：cognition_snapshot（前章累积角色认知 BeliefStatus 投影视图）→ info-gap 维数据源。caller 在 chain
      // 启动前取 snapshot 注入 initialArtifacts（write_chapter tool fetchCognitionSnapshotViaTool / closureChainIpc
      // fetchCognitionSnapshotForIpc，mirror world_state_snapshot 模式）。snapshot = per-character CharacterBeliefView
      // （projectBeliefStatus 投影：knows/believes→believes_true / suspects→suspects / misunderstands→believes_false /
      // absent→unaware + hasReaderPerceivedLayer 分层标记）。graceful：artifact 缺（测试环境 / fetch 失败 / 首章无前章
      // 认知）→ 空串（renderTemplate 塌空行，info-gap 维无数据，零回归；不在 requiredArtifactKeys，mirror
      // world_state_snapshot/promise_registry optional 哲学 chapter-nodes.ts:208-214）。违规裁判归 L2 语义（非 L1 纯代码，
      // design §4 范式切分：投影纯代码，「是否真表现知情」归 L2）。
      const cognitionContext = JSON.stringify(run.artifacts['cognition_snapshot'] ?? '');
      // Story 6.4 D1（6.2 DW-1）：presence_signal（在场性预筛信号）→ info-gap 维辅助。A 表现知情 fact 但不在
      // fact 揭露场（cognitive evidenceSceneId ≠ physical presence_scene）的机械信号，KNOWLEDGE_VIOLATION 嫌疑增强。
      // graceful：artifact 缺 → 空串（info-gap 维降级纯语义判，零回归；不在 requiredArtifactKeys，mirror cognition_snapshot）。
      const presenceContext = JSON.stringify(run.artifacts['presence_signal'] ?? '');
      // Story 5.4：emotion_curve（5.2 Director 前向产的目标轨 per-scene 情绪，chapter-chain 透传）→ 情绪维
      // Emotion.unlanded 数据源。points[] per-scene（refId→SceneNode.id + sceneMood 读者层语义 + characters[]
      // 角色层 emotion/emotionEnd + 可选 sceneVad）。graceful：artifact 缺（测试/首章无 Director 情绪产物）
      // → 空串（情绪维降级跳过 unlanded，零回归，mirror presenceContext optional + graceful 哲学）。**不在
      // requiredArtifactKeys**——emotion_curve 是增强信号（5.2 Director 产），缺则 L2 跳过 unlanded 不报。
      // 范式判据（ADR-3）：目标情绪落地裁判 = L2 语义（「读者是否感受到目标情绪」= 语义），纯代码只做数据透传。
      const emotionCurve = JSON.stringify(run.artifacts['emotion_curve'] ?? '');
      // Story 5.4：pacingBreath（纯代码连续高强度 hotspot）→ 情绪维 Emotion.pacing-breath 数据源（机械 hint）。
      // 复用 chapterScenes（selectScenesForEpisode 已算，避免二次算）。computePacingBreathHotspot 是纯函数
      // （pacingRole vocab 精确匹配计数，不解意义），breached=true 是 hint（同 L1 hotspot 软信号），是否真致麻木
      // 归 L2 语义裁判。graceful（mirror L1 compute 降级 :341-347，R6① 永不崩链）：compute 抛错 → try/catch
      // 降级空 signal（breached=false + note='compute-failed'），情绪维跳过 pacing-breath 不报，零回归。
      let pacingBreathSignal;
      try {
        pacingBreathSignal = computePacingBreathHotspot(chapterScenes);
      } catch (err) {
        logger.warn(
          { nodeId, err: err instanceof Error ? err.message : String(err) },
          'createReaderAuditNode.run: computePacingBreathHotspot threw → degrade to empty signal, continue to L2',
        );
        pacingBreathSignal = {
          breached: false,
          maxConsecutiveIntense: 0,
          threshold: BREATH_THRESHOLD,
          intenseRuns: [],
          note: 'compute-failed',
        };
      }
      const pacingBreath = JSON.stringify(pacingBreathSignal);
      // Story 2.5：genreContract（用户定的题材承诺契约——commitments 核心承诺 / genre_tags 题材标签 /
      // world_constitution 世界规则）→ contract 维数据源。**复用 assembleChapterChainArtifacts 已注入的
      // genreContract artifact**（mirror promise_registry 既有流——creative_brief / world_setting 是 project.yaml
      // creative field，assemble 阶段已 safeParse 注入 initialArtifacts，chainRunner 透传 run.artifacts）。
      // graceful：artifact 缺（测试环境）/ 三字段全空（用户未定承诺）→ 空串（renderTemplate 塌空行，contract
      // 维无数据零回归；不在 requiredArtifactKeys，mirror promise_registry optional 哲学 chapter-nodes.ts:208-214）。
      // 范式判据（ADR-3 / design §4.1）：违背判断归 L2 LLM 语义（「正文是否违背用户定的核心承诺」= 语义），
      // 纯代码只做 artifact 透传（砍旧硬 BLOCK 纯代码引擎假信心门）。严守 per-chapter scope：只判本章正文 vs
      // 用户定承诺，非跨弧兑现（4.4 范畴）。route 边界（design §1 / ADR-17）：contract 维 dim name 不含
      // narrative|discourse 等 hasNarrativeFeatureBlock 正则词 → block 走 route LLM 判常 auto_revise（不强制 escalate）。
      const genreContract = JSON.stringify(run.artifacts['genreContract'] ?? '');
      // Story 2.6：decidedDecisions（决策落地维数据源）——collectRelevantDecisions 单源 filter
      // status:'decided'（superseded/dropped/open 天然排除）+ relatedEpisodeId 命中本章或全局 + newestFirst
      // （cap 截断用：新决策优先，旧 decided 大概率已落地稳定）。cap 10 + 截断标注（mirror 3.3 top-N
      // 「前 N/共 M」教训：防 L2 低估总数）。graceful：artifact 缺（测试环境 / 旧项目无决策）→ 空数组
      // （renderTemplate 塌空行，决策落地维无数据零回归，mirror genreContract optional 哲学）。
      // 范式判据（ADR-3）：filter/排序/截断 = 纯代码查询；「decided 决策是否落地到正文」= L2 LLM 语义。
      const allDecisions = run.artifacts['story_decisions'] as StoryDecision[] | undefined;
      const relevantDecided = collectRelevantDecisions(allDecisions, {
        status: 'decided',
        ...(episodeId ? { episodeId } : {}),
        newestFirst: true,
      });
      const DECIDED_CAP = 10;
      const cappedDecided = relevantDecided.slice(0, DECIDED_CAP);
      const decidedDecisions = JSON.stringify({
        decisions: cappedDecided,
        truncated: relevantDecided.length > DECIDED_CAP,
        total: relevantDecided.length,
      });
      // Story 8.4 Step 6（A11 审核对照，design §1.9）：research_brief artifact（写手自查两阶段节点 mutate 写，
      // mirror 7.2 revision_guard 第二 artifact 先例——chainRunner 单 key 赋值不 snapshot/restore，链内
      // draft-writer 先于本节点跑故 run.artifacts 直读，**零装配透传**——write_chapter tool 与 shell IPC 两
      // 入口都经同一链内 writer，装配点无需另注入 initialArtifacts）。注入**简报本体**（含 execution_plan
      // 写作执行案 + deviations 亮牌——归因对照的意图档案，三层审计链「计划→意图→事实」的意图层）。
      // graceful（mirror cognitionContext optional 哲学）：artifact 缺（测试环境/旧链）/ degraded 形态
      // （{degraded:true, reason} 无 brief——工具环境降级/直写路径）/ brief 字段缺 → 空串
      // （renderTemplate 塌空，审核降级零回归，attribution 不产出；不在 requiredArtifactKeys）。
      const researchBrief = JSON.stringify(
        (artifactAsRecord(run, 'research_brief')?.brief as object | undefined) ?? '',
      );
      // C1.2 R6（design §3.2）：lint_report artifact（lint-node 产，revision-guard 紧后链位——本节点前
      // 恒在场）→ **机会主义消费**：projectLintReportForL2 按规则聚合封顶（mirror 上游
      // collectRepairFindings 25 规则/3 引文/40 字）注入 L2 prompt 作 L1 同族软信号（静态命中≠定罪，
      // 真阳/误报/修复方向归 L2 结合语境判）。**不在 requiredArtifactKeys**——lint_report 是链段
      // artifact 非 creative field，老链/旧 snapshot/bypass 直测路径无此 key，required 门会让
      // chainRunner blocked 断链（mirror world_state_snapshot optional + graceful 哲学 chapter-nodes.ts:396-402）；
      // 缺/坏形态 → 空串（renderTemplate 塌空行，现状 stylometry-only 零回归）。
      const lintReport = JSON.stringify(projectLintReportForL2(run.artifacts['lint_report']) ?? '');
      const l1Hotspots = JSON.stringify({
        signals: l1.signals,
        hotspots: l1.hotspots,
        storyTimeContext: l1.storyTimeContext,
      });
      const userPrompt = renderTemplate(userTemplate, {
        draftText,
        l1Hotspots,
        storyPlan,
        briefIntent,
        worldStateContext,
        promiseLedger,
        cognitionContext,
        presenceContext,
        emotionCurve,
        pacingBreath,
        genreContract,
        decidedDecisions,
        researchBrief,
        lintReport,
      });
      const messages: SessionMessage[] = [
        { id: randomUUID(), role: 'user', content: userPrompt, createdAt: Date.now() },
      ];
      const abortSignal = signal ?? new AbortController().signal;

      // generate + retry（mirror createLlmNode MAX_ATTEMPTS + error-feedback 重试语义，design §3）。
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          // 09-12 子2（H2）：fallbacks 透传（空链不占位）。
          // 09-12 usage-panel：taskType 透传（未标注不占位）。
          // 09-13 子2 W2b（思考流，design §1）：onDelta 随 opts 透传——每次尝试预分配轮 messageId
          //（mirror llm-node attemptMessageId：重试轮换 id，UI 侧按轮分段防重试混流）；tool 通道
          // 滤除（R2 #30 同款——链卡正文只有文本）。缺省不占位（非流式路径零回归）。
          const attemptMessageId = randomUUID();
          const result = await generate(messages, system, [], abortSignal, {
            modelRef,
            thinking,
            taskType,
            ...(fallbacks?.length ? { fallbacks } : {}),
            ...(onDelta
              ? {
                  onDelta: (d: GenerationDelta) => {
                    if (d.type === 'tool') return;
                    onDelta({ messageId: attemptMessageId, channel: d.type, delta: d.delta });
                  },
                }
              : {}),
          });
          const parsed = reviewOutputSchema.parse(JSON.parse(extractJson(result.content)));
          return { stateKey: 'review.latest', artifact: parsed };
        } catch (err) {
          if (isAbortError(err)) throw err; // 取消语义：传播，不吞成 fallback artifact
          lastErr = err;
          logger.warn(
            { nodeId, attempt, err: err instanceof Error ? err.message : String(err) },
            'createReaderAuditNode.run: attempt failed',
          );
          // 重试时把 parse/校验错误回灌成 user 消息（mirror createLlmNode 畸形 JSON 修复语义）。
          if (attempt < MAX_ATTEMPTS) {
            const errMsg = err instanceof Error ? err.message : String(err);
            messages.push({
              id: randomUUID(),
              role: 'user',
              content: `你上次的输出无法解析为有效 JSON（错误：${errMsg}）。请只输出符合契约的纯 JSON 对象，不要包含任何解释文字、markdown 代码围栏或多余内容。`,
              createdAt: Date.now(),
            });
          }
        }
      }

      // R6① fallback（design §7① / §3）：parse 失败 → verdict='escalate'（**永不假 pass / 静默 fail**）。
      // 链段不崩；route LLM 读 verdict='escalate' → 走 escalate_user 路径上发用户。
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
      logger.error(
        { nodeId, message },
        'createReaderAuditNode.run: all attempts failed → escalate fallback (R6①)',
      );
      return {
        stateKey: 'review.latest',
        artifact: {
          verdict: 'escalate',
          summary: `Reader-Audit 解析失败，需人工介入（${MAX_ATTEMPTS} 次尝试均失败：${message}）`,
          dimensions: [],
          reasons: ['reader-audit-parse-failure'],
        },
      };
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// targeted-revision 节点——已随链流程重排（09-13 W1d）+ CR 批清理全量退役删除：
// dormant 工厂 createTargetedRevisionNode / TARGETED_REVISION_CONTRACT / revisionOutputSchema
// 连同 agentContracts.ts CONTRACTS 条目一并清零（职能 = 环内 C1 revision-optimizer 编译 +
// 写手 directive 重跑，见 revision-optimizer-node.ts / chapter-chain.ts 头注）。
// ═════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// revision-guard 节点（Story 7.2 meaning-preservation 护栏，design §1.3）
// ════════════════════════════════════════════════════════════════════════════

//
// revision-guard = 段落级改稿（B-trigger splice）的 pre-commit 保义门。draft-writer 段落级时只产 passageText
// + 保改前整章 text（§1.4 拆 splice），本节点判定后 splice：
//  1. 读 revision_intent；缺 OR 无 scope → pass-through（整章路径零回归，draft.initial 原样）。
//  2. L1（computeRevisionGuardL1，纯代码零依赖）：选区范围幅度核对（lengthRatio + n-gram Jaccard），hint。
//  3. L2（revision-guard-agent，mirror createReaderAuditNode generate+retry+escalate）：6 类漂移检查 + 逐词对照。
//  4. 三层处置（design §0.2）：
//     - clean → splice 落 draft.initial（splice 从 draft-writer 搬到此）+ guard 报告 mutate revision_guard。
//     - soft-violation → 不 splice（draft.initial 保改前），guard artifact，触发 checkpoint pause（art-mode gate）。
//     - hard-violation → error artifact（强制拦，mirror 7.1 F1）。
//
// 🔑 NodeResult 单 stateKey（contracts/run.ts:47，chainRunner:177 只写 result.stateKey）。clean 需写两 artifact
// （splice 后 draft.initial + guard 报告 revision_guard）→ guard 报告经直接 mutate run.artifacts['revision_guard']
// （不同 key，chainRunner :177 不覆盖），return draft.initial（下游主读）。soft/hard-violation return revision_guard
// （draft.initial 不动保改前）。
//
// 不进 CONTRACTS[]（chain 内节点非 spawn 子 agent，mirror createReaderAuditNode / emotion-verify-node 等链段节点）。
// 产 revision_guard 链段 artifact（非持久化，mirror review.latest）。force-accept（art-mode）经 guardOverride
// 透传——resume 重跑本节点时读 revision_guard.verdict==='soft-violation' + guardOverride==='force-accept' → splice
// （design §1.5）。
//
// expected_downstream_consumers:
// - Story 7.2 onCheckpoint 闭包（workflow.ts）：读 revision_guard.verdict 驱动动态 pause（仅 soft-violation）。
// - Story 7.2 UI（ChapterReviewPanel）：soft-violation pause 时读 findings + before/after 展 art-mode 卡。
// - Story 7.4 A-trigger：复用本节点核心（换 trigger 零改，design §1.6）。
// - Story 7.5 词级 diff UI：消费 revision_guard.beforeText/afterText。

const REVISION_GUARD_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'revision-guard-agent',
  displayName: 'Revision Guard Node',
  inputSchemaName: 'revisionGuardInput',
  outputSchemaName: 'revisionGuardArtifact',
  requiredArtifactKeys: ['draft.initial'],
  // BMad CR CR-BLIND-004：producedArtifactKeys 是「节点可能写」的可观测性声明（may-produce），非「每次都写」：
  // - clean → 写 draft.initial（splice 后）+ mutate revision_guard。
  // - soft/hard-violation → 写 revision_guard（stateKey return）+ draft.initial 不动（保改前）。
  // 即 draft.initial 仅 clean 写；revision_guard 全形态写。下游消费者读 draft.initial 不依赖此声明（clean 才变）。
  // 🔑 NodeResult 单 stateKey（contracts/run.ts:47）——clean 需写两 key 时，revision_guard 经**直接 mutate
  // run.artifacts['revision_guard']**（chainRunner :177 只写 result.stateKey，不同 key 不覆盖），return draft.initial。
  // 此 mutate 依赖 chainRunner 三不变式（单 key 赋值 / 不 snapshot-restore artifacts / mutate 在 persistChainSnapshot
  // 前）——未来 chainRunner 加 transactional rollback / deep-clone 须同步更新此模式（load-bearing invariant）。
  producedArtifactKeys: ['draft.initial', 'revision_guard'],
  sideEffects: ['call_model'],
};

/**
 * revision-guard 节点工厂（design §1.3）。
 *
 * composite 节点（L1 纯代码 + L2 LLM + splice + 三层处置），手写 mirror createReaderAuditNode
 * （非 createLlmNode——后者只支持单 generate+parse，本节点有 L1+splice+三层处置复合逻辑）。
 *
 * @param deps generate/modelRef/signal（+ tagChinese/compress 经 ChapterLlmNodeDeps 注入但本节点不用——
 *             L1 零依赖；结构兼容 mirror createReaderAuditNode 装配处统一传 llmDeps）。
 */
export function createRevisionGuardNode(deps: ChapterLlmNodeDeps): AgentNode {
  const { generate, modelRef, thinking, signal, fallbacks, taskType, onDelta } = deps;
  const nodeId = 'revision-guard-agent';
  return {
    contract: REVISION_GUARD_CONTRACT,
    async run(input): Promise<NodeResult> {
      const { run } = input;

      // 1. 读 revision_intent；缺 OR 无 scope → pass-through（整章路径零回归）。
      //    force-accept（art-mode）：resume 重跑时 revision_guard.verdict==='soft-violation' + guardOverride 在 → splice。
      //    guardOverride 经 IPC redoOpts → workflow.ts redo merge → initialArtifacts['revision_guard_override']。
      const intent = readRevisionIntent(run.artifacts['revision_intent']);
      const forceAccept = run.artifacts['revision_guard_override'] === 'force-accept';

      // 既有 soft-violation pause 的 guard artifact 在（resume 重跑场景）+ forceAccept → 直接走 splice（art-mode 兑现）。
      const existingGuard = run.artifacts['revision_guard'] as
        | { verdict?: GuardVerdict; findings?: GuardFinding[]; beforeText?: string; afterText?: string }
        | undefined;
      if (forceAccept && existingGuard?.verdict === 'soft-violation' && intent?.scope?.anchor) {
        return forceAcceptSplice(run, intent.scope.anchor, existingGuard);
      }

      if (!intent?.scope?.anchor) {
        // 整章路径（首写 / 整章 redo / 无 intent）：draft.initial 已是完整正文（draft-writer 整章 text），
        // guard 不干预。mutate revision_guard 记 skipped（NodeResult 单 stateKey，见上注），return draft.initial 原样。
        run.artifacts['revision_guard'] = {
          verdict: 'clean',
          findings: [],
          summary: '整章路径（无段落级 revision_intent），护栏跳过',
          skipped: true,
        };
        return { stateKey: 'draft.initial', artifact: run.artifacts['draft.initial'] };
      }

      // 2. 取改前/改后 + previousFullText（splice 目标）。
      //    draft.initial 此时 = {text: 改前整章, passageText: 改后段}（draft-writer 段落级不 splice，§1.4）。
      const draft = artifactAsRecord(run, 'draft.initial');
      const previousFullText = scalarOf(draft?.text);
      const beforeText = intent.scope.anchor.quote;
      const afterText = scalarOf(draft?.passageText);
      if (!afterText || !previousFullText) {
        // 异常：段落级 intent 但 draft 缺 passageText / previousFullText → error artifact（防畸形/丢改前）。
        logger.warn(
          { nodeId, hasPassageText: !!afterText, hasPrevious: !!previousFullText },
          'revision-guard: 段落级 intent 但 draft 缺 passageText/previousFullText → error artifact',
        );
        return {
          stateKey: 'revision_guard',
          artifact: {
            error: true,
            nodeId,
            message: '段落级改稿但 draft 缺 passageText 或 previousFullText（draft-writer 未产段落输出？）',
          },
        };
      }

      // 3. L1（纯代码，零 native 依赖，失败降级空 report 继续 L2）。
      let l1: RevisionGuardL1Report;
      try {
        l1 = computeRevisionGuardL1({ beforeText, afterText });
      } catch (err) {
        logger.warn(
          { nodeId, err: err instanceof Error ? err.message : String(err) },
          'revision-guard: L1 compute threw → degrade to empty report, continue to L2',
        );
        l1 = emptyRevisionGuardL1Report();
      }

      // 4. L2（mirror createReaderAuditNode generate+retry+escalate fallback）。
      // Story 7.4 §1.6：structuralEdit=true → L2 收「结构操作允许范围」放行码（故意结构改动不报，只查顺手越界
      // 改锁定项 voice/结论/角色性格）。flag 缺/false → L2 正常 6 类全查 + 作者声音默认 soft 维度全保（零回归）。
      const l2 = await runGuardL2({
        beforeText,
        afterText,
        lockedItems: intent.lockedItems,
        chapterContext: buildGuardChapterContext(run),
        l1Hint: l1,
        userInstruction: intent.provenance.rawUserInstruction,
        compilerNote: intent.provenance.compilerNote,
        structuralEdit: intent.structuralEdit === true,
        generate,
        modelRef,
        thinking,
        taskType,
        signal,
        // 09-12 子2（H2）：fallbacks 透传进 L2 调用。
        ...(fallbacks?.length ? { fallbacks } : {}),
        // 09-13 子2 W2b（思考流）：onDelta 透传进 L2 调用（每次尝试预分配轮 messageId + tool
        // 通道滤除，mirror llm-node；条件执行位——整章路径 skip L2 零事件是 no-op 语义非接线缺失）。
        ...(onDelta ? { onDelta } : {}),
        nodeId,
      });

      // L2 parse 失败 escalate fallback → hard-violation（永不假 clean，design §1.2）。
      if (l2 === null) {
        logger.error({ nodeId }, 'revision-guard: L2 all attempts failed → hard-violation fallback (永不假 clean)');
        return {
          stateKey: 'revision_guard',
          artifact: {
            error: true,
            nodeId,
            message: `保义裁判失败（L2 ${MAX_ATTEMPTS} 次尝试均失败）——按硬锁越界处置（永不假通过），请人工核验或改指令重试`,
          },
        };
      }

      const { verdict, findings, summary } = l2;

      // 5. 三层处置。
      if (verdict === 'clean') {
        // clean → splice 落 draft.initial（splice 从 draft-writer 搬到此）+ guard 报告 mutate revision_guard。
        // BMad CR CR-BLIND-005：clean 时 L2 若不一致返了 findings（verdict/findings 矛盾），忽略 findings（clean
        // = 无越界），guard artifact 记空 findings。不把矛盾 findings 灌进 clean 报告误导可观测。
        const spliced = splicePassage(previousFullText, intent.scope.anchor, afterText);
        if (spliced.status === 'spliced') {
          run.artifacts['revision_guard'] = {
            verdict: 'clean',
            findings: [],
            l1Report: l1,
            beforeText,
            afterText,
            summary: summary || '保义通过',
          };
          return {
            stateKey: 'draft.initial',
            artifact: { ...draft, text: spliced.text, passageText: undefined },
          };
        }
        // clean 但 splice 失败（anchor 定位失败——draft 改了致选区漂移）→ error artifact（mirror 7.1 F1）。
        logger.warn({ nodeId, reason: spliced.reason }, 'revision-guard: clean 但 splice 定位失败 → error artifact');
        return {
          stateKey: 'revision_guard',
          artifact: {
            error: true,
            nodeId,
            message: `保义通过但段落定位失败（${spliced.reason}），选区在正文中找不到或重复——请重选后重试`,
          },
        };
      }

      if (verdict === 'hard-violation') {
        // hard → error artifact（强制拦，mirror 7.1 F1）。draft.initial 不动（保改前）。
        // chainRunner isErrorArtifact 检 {error:true} → status=error → toast。
        // BMad CR CR-003：hard-violation 不进 soft-violation 的 pause payload（isErrorArtifact 先 break），
        // findings 不会经 summary.revisionGuard 到 UI——故把越界明细拼进 message，让 toast/summary.errors
        // 呈现「越界了什么 + 逐词对照」（保义护栏的价值在告诉作者漂移在哪，非笼统「越界」）。
        const findingDetail = formatFindingDetail(findings);
        return {
          stateKey: 'revision_guard',
          artifact: {
            error: true,
            nodeId,
            message: `硬锁越界（作者显式锁定项被改，不可放行）——请改指令或取消${findingDetail}`,
            findings,
          },
        };
      }

      // soft-violation → 不 splice（draft.initial 保改前），产 guard artifact，触发 checkpoint pause（art-mode gate）。
      // pause 由 chainRunner onCheckpoint 在节点边界触发（checkpointStage='revision-guard' + 仅 soft-violation 时
      // workflow.ts onCheckpoint 闭包返 pause）。
      // BMad CR CR-BLIND-005：soft-violation 但 findings 空（L2 判 soft 却没给 finding）→ summary 补注「无具体越界
      // 明细」，UI art-mode 卡显「无 findings」占位（不空卡）。
      const softSummary = findings.length === 0
        ? (summary || '软锁越界但无具体明细（L2 未给 finding），请人工核验改前/改后')
        : (summary || '软锁越界，等作者 art-mode 决定');
      return {
        stateKey: 'revision_guard',
        artifact: {
          verdict: 'soft-violation',
          findings,
          l1Report: l1,
          beforeText,
          afterText,
          summary: softSummary,
        },
      };
    },
  };
}

/**
 * 格式化 findings 为 message 附加明细（CR-003，hard-violation 用）。
 *
 * 把 per-finding 的模式 + violatedScope + before→after 拼成短串附在 error message 后，让 toast/summary.errors
 * 呈现越界明细（hard-violation 不进 pause payload，findings 只能经 message 到 UI）。纯字符串拼接，非语义。
 */
function formatFindingDetail(findings: GuardFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.slice(0, 3).map((f) => {
    const arrow = f.evidence.before && f.evidence.after ? `${f.evidence.before} → ${f.evidence.after}` : '';
    return `  • [${f.authority}] ${f.violatedScope}（${f.pattern}）${arrow ? `：${arrow}` : ''}`;
  });
  const more = findings.length > 3 ? `\n  （另有 ${findings.length - 3} 条，详见审核）` : '';
  return `\n越界明细：\n${lines.join('\n')}${more}`;
}

/**
 * art-mode force-accept：resume 重跑时 soft-violation + guardOverride=force-accept → splice 落 draft.initial。
 *
 * 保留原 soft findings（forceAccepted:true 标记，可观测——7.5/Epic13 消费「作者强行放行了哪些越界」）。
 * draft.initial 此时仍持 {text:改前整章, passageText:改后段}（pause 时未 splice，snapshot 持久）。
 */
function forceAcceptSplice(
  run: RunSnapshot,
  anchor: SelectionAnchor,
  existingGuard: { verdict?: GuardVerdict; findings?: GuardFinding[]; beforeText?: string; afterText?: string; summary?: string },
): NodeResult {
  const nodeId = 'revision-guard-agent';
  const draft = artifactAsRecord(run, 'draft.initial');
  const previousFullText = scalarOf(draft?.text);
  const afterText = existingGuard.afterText ?? scalarOf(draft?.passageText);
  if (!previousFullText || !afterText) {
    return {
      stateKey: 'revision_guard',
      artifact: { error: true, nodeId, message: 'force-accept 但 draft 缺 previousFullText/passageText' },
    };
  }
  const spliced = splicePassage(previousFullText, anchor, afterText);
  if (spliced.status !== 'spliced') {
    return {
      stateKey: 'revision_guard',
      artifact: {
        error: true,
        nodeId,
        message: `force-accept splice 定位失败（${spliced.reason}）——请重选后重试`,
      },
    };
  }
  // splice 落 draft.initial + guard 报告标 forceAccepted（保留原 soft findings 可观测）。
  run.artifacts['revision_guard'] = {
    verdict: 'clean',
    findings: existingGuard.findings ?? [],
    forceAccepted: true,
    beforeText: existingGuard.beforeText ?? '',
    afterText,
    summary: '作者强行放行（art-mode），原软锁越界已记录',
  };
  return {
    stateKey: 'draft.initial',
    artifact: { ...draft, text: spliced.text, passageText: undefined },
  };
}

/**
 * 构 L2 chapterContext var（选区前后文 + brief，帮判「研究→拆要知道前文拆过」）。
 *
 * 纯代码组装（非语义）：取 chapter_brief 摘要 + draft.initial.text 的选区前后 N 字切片。brief 缺/短 →
 * 仅前后文切片。graceful：全缺 → 空串（L2 降级纯选区判，零回归）。
 */
function buildGuardChapterContext(run: RunSnapshot): string {
  const brief = run.artifacts['chapter_brief'];
  const briefStr =
    brief && typeof brief === 'object' ? JSON.stringify(brief).slice(0, 1200) : '';
  // 选区前后文：draft.initial.text 的前/后 200 字切片（机械，非语义）。
  const draft = artifactAsRecord(run, 'draft.initial');
  const fullText = scalarOf(draft?.text);
  const intent = readRevisionIntent(run.artifacts['revision_intent']);
  // BMad CR CR-002：rangeHint.from bounds clamp——anchor 可能针对旧 draft（前次 redo 改了长度），from 超
  // fullText.length 时 slice 会返空/错位「选区前文」误导 L2（CR-BLIND-006/CR-EDGE-004）。clamp 到 [0, len]。
  const rawFrom = intent?.scope?.anchor.rangeHint.from ?? 0;
  const anchorFrom = Math.max(0, Math.min(rawFrom, fullText.length));
  const contextStart = Math.max(0, anchorFrom - 200);
  const beforeCtx = fullText.slice(contextStart, anchorFrom);
  const afterCtx = fullText.slice(anchorFrom, Math.min(fullText.length, anchorFrom + 400));
  const ctxParts: string[] = [];
  if (briefStr) ctxParts.push(`【本章 brief】${briefStr}`);
  ctxParts.push(`【选区前文】${beforeCtx}`);
  ctxParts.push(`【选区及后文】${afterCtx}`);
  return ctxParts.join('\n');
}

/**
 * L2 派发（mirror createReaderAuditNode generate+retry+escalate fallback）。
 *
 * 流程：loadAgentPrompt('revision-guard-agent') → renderTemplate → generate(modelRef) → parseRevisionGuard
 * （三路径鲁棒）→ retry（畸形 JSON 回灌）→ escalate fallback（全失败返 null，caller → hard-violation）。
 * abort 传播（mirror reader-audit :614）。
 *
 * @returns {verdict, findings, summary} 或 null（全失败，caller escalate fallback → hard-violation）。
 */
async function runGuardL2(args: {
  beforeText: string;
  afterText: string;
  lockedItems: unknown;
  chapterContext: string;
  l1Hint: RevisionGuardL1Report;
  userInstruction: string;
  compilerNote: string;
  /** Story 7.4 §1.6：结构编辑触发的 prose 重生成 → L2 放行故意结构改动（只查顺手越界锁定项）。 */
  structuralEdit: boolean;
  generate: GenerateFn;
  modelRef: { keyId: string; modelId: string } | undefined;
  /** S4b：档位思考策略（ChapterLlmNodeDeps.thinking 透传）。 */
  thinking?: ThinkingControl;
  /** 09-12 子2（H2）：回退链透传（ChapterLlmNodeDeps.fallbacks）。 */
  fallbacks?: GenerateFallbackEntry[];
  /** 09-12 usage-panel：任务档位/流程标签（ChapterLlmNodeDeps.taskType 透传）。 */
  taskType?: string;
  signal?: AbortSignal;
  /**
   * 09-13 子2 W2b（思考流，design §1）：节点流回调——generate opts 透传 provider onDelta（每次
   * 尝试**预分配轮 messageId**，mirror llm-node attemptMessageId 模式；tool 通道滤除）。装配侧由
   * chapter-chain `withNodeStreaming` 注入（补 nodeId/role → workflow onNodeDelta）。缺省不开（零回归）。
   */
  onDelta?: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => void;
  nodeId: string;
}): Promise<{ verdict: GuardVerdict; findings: GuardFinding[]; summary: string } | null> {
  const { system, userTemplate } = await loadAgentPrompt('revision-guard-agent');
  const l1HintStr = args.l1Hint.rangeCheck.flagged
    ? `${args.l1Hint.rangeCheck.note}（聚焦参考，不下结论）`
    : '改动幅度正常（无聚焦 hint）';
  // Story 7.4 §1.6：structuralEdit=true → 注入放行码（L2 对故意结构改动放宽 6 类检查，只查顺手越界改
  // 锁定项 voice/结论/角色性格）。放行规则归 LLM prompt（revision-guard-agent.yaml 结构性改稿判定段），
  // 非纯代码规则匹配（ADR-3）。flag=false → 空（正常护栏行为，零回归）。
  const structuralEditContext = args.structuralEdit
    ? '【结构编辑标记】本次改稿是结构编辑（scene_graph 原子编辑后正文追平）——6 类检查对**故意的结构改动**放行（语义倒退/视角丢失/主体性消除/语气节奏删除/意象降级，凡因结构编辑本身需要的改动不报），**只查顺手越界改锁定项**（voice/结论/角色性格等作者显式锁定项）。即：结构编辑带来的正文重组是目标中的，不是漂移。'
    : '';
  const userPrompt = renderTemplate(userTemplate, {
    beforeText: args.beforeText,
    afterText: args.afterText,
    lockedItems: JSON.stringify(args.lockedItems ?? []),
    chapterContext: args.chapterContext,
    l1Hint: l1HintStr,
    userInstruction: args.userInstruction,
    compilerNote: args.compilerNote,
    structuralEditContext,
  });
  const messages: SessionMessage[] = [
    { id: randomUUID(), role: 'user', content: userPrompt, createdAt: Date.now() },
  ];
  const abortSignal = args.signal ?? new AbortController().signal;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // 09-12 子2（H2）：fallbacks 透传（空链不占位）+ 09-12 usage-panel：taskType 透传。
      // 09-13 子2 W2b（思考流）：onDelta 透传——每次尝试预分配轮 messageId（mirror llm-node
      // attemptMessageId：重试轮换 id，UI 侧按轮分段）；tool 通道滤除。缺省不占位（零回归）。
      const attemptMessageId = randomUUID();
      const result = await args.generate(messages, system, [], abortSignal, {
        modelRef: args.modelRef,
        thinking: args.thinking,
        taskType: args.taskType,
        ...(args.fallbacks?.length ? { fallbacks: args.fallbacks } : {}),
        ...(args.onDelta
          ? {
              onDelta: (d: GenerationDelta) => {
                if (d.type === 'tool') return;
                args.onDelta!({ messageId: attemptMessageId, channel: d.type, delta: d.delta });
              },
            }
          : {}),
      });
      const parsed = parseRevisionGuard(result.content);
      if (parsed) return parsed;
      // parse 返 null（无合法 JSON / shape 不符）→ 视为 parse 失败重试（mirror createReaderAuditNode）。
      throw new Error('parseRevisionGuard 返 null（无合法 guard JSON 或 shape 不符）');
    } catch (err) {
      if (isAbortError(err)) throw err; // 取消语义：传播，不吞成 hard-violation fallback
      lastErr = err;
      logger.warn(
        { nodeId: args.nodeId, attempt, err: err instanceof Error ? err.message : String(err) },
        'revision-guard L2: attempt failed',
      );
      if (attempt < MAX_ATTEMPTS) {
        const errMsg = err instanceof Error ? err.message : String(err);
        messages.push({
          id: randomUUID(),
          role: 'user',
          content: `你上次的输出无法解析为有效 JSON（错误：${errMsg}）。请只输出符合契约的纯 JSON 对象（verdict/findings/summary），不要包含任何解释文字、markdown 代码围栏或多余内容。`,
          createdAt: Date.now(),
        });
      }
    }
  }
  void lastErr; // escalate fallback（caller 据返 null → hard-violation，记 lastErr 已在上文 logger.warn）
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// route 节点（design §4.4 / ADR-17 反馈路由）
// ════════════════════════════════════════════════════════════════════════════

const ROUTE_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'route-agent',
  displayName: 'Route Decision Node',
  inputSchemaName: 'routeInput',
  outputSchemaName: 'routeDecisionSchema',
  requiredArtifactKeys: ['review.latest', 'chapter_brief', 'draft.initial'],
  producedArtifactKeys: ['route_decision'],
  sideEffects: ['call_model'],
};

/**
 * route 节点输出 shape（ADR-17 三档 route_decision）。
 *
 * decision 三档（LLM 按歧义度 + 创作意图判，**非预画线规则**——ADR-17 反馈路由 / ADR-3 假信心门）：
 * - auto_revise: 可自动改的明确缺陷（一致性违背 / 信息泄露 / 状态冲突 / 违反禁写）→ evaluator-optimizer 闭环
 * - accept_as_truth: 创造性偏离无错（正文比计划好的升级）→ 接受正文为真相 + 计划更新（StoryDecision 2.6 defer）
 * - escalate_user: 难断灰区（如 OOC bug-vs-feature）→ 上发 leader → PermissionService ask_user
 *
 * CR-8 / ADR-3：`decision: z.string()`（非封闭 enum）+ parse 端 `normalizeRouteDecision` 归一。
 * chainRunner 机械 switch on decision 值（readRouteDecision: `decision === 'auto_revise'`）需规范化
 * 三档之一——故 parseOutput 把 LLM 变体（"auto revise"/"自动修订"/"accept"/"通过"/"escalate"/"上报"）
 * 归一为 canonical enum，无法识别 → 抛 → 重试（machinery 不能驱动未知值，非假信心：是机械控制信号）。
 * verdict/review 走 z.string() 不归一（route LLM 读字符串作语义判断，无机械 switch）。
 *
 * 4.1 Step 4（CR-15b）：`deviation: z.boolean().optional()`——LLM 判正文是否偏离计划（创造性偏离，归
 * route LLM 语义判断，非纯代码推断）。route=accept_as_truth 且 deviation=true 时，链段 accept 分支
 * （onAccept → buildChapterAccept）建 decided StoryDecision 登记（source:'accept_as_truth'）。无偏离 /
 * 其他 route → deviation 缺省 / false，不登记。范式判据：偏离判定 = 语义 = LLM；本节点只机械读 boolean。
 */
const routeDecisionSchema = z.object({
  decision: z.string(),
  reason: z.string(),
  deviation: z.boolean().optional(),
});

/**
 * route decision 别名归一（CR-8）。LLM 常返变体（连字符/中文/缩写），归一为 canonical 三档。
 * lowercase + trim 后查别名表；未命中则按子串判（含 accept/revise/auto/escalate 关键字）。
 * 全不命中 → undefined（parseOutput 抛 → 重试，machinery 不能驱动未知 decision）。
 */
const ROUTE_DECISION_ALIASES: Record<string, 'auto_revise' | 'accept_as_truth' | 'escalate_user'> = {
  // auto_revise
  auto_revise: 'auto_revise',
  'auto-revise': 'auto_revise',
  autorevise: 'auto_revise',
  revise: 'auto_revise',
  自动修订: 'auto_revise',
  修订: 'auto_revise',
  // accept_as_truth
  accept_as_truth: 'accept_as_truth',
  'accept-as-truth': 'accept_as_truth',
  accept: 'accept_as_truth',
  accept_astruth: 'accept_as_truth',
  通过: 'accept_as_truth',
  接受: 'accept_as_truth',
  采纳: 'accept_as_truth',
  // escalate_user
  escalate_user: 'escalate_user',
  'escalate-user': 'escalate_user',
  escalate: 'escalate_user',
  升级: 'escalate_user',
  上报: 'escalate_user',
};

export function normalizeRouteDecision(raw: unknown): 'auto_revise' | 'accept_as_truth' | 'escalate_user' | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  if (ROUTE_DECISION_ALIASES[key]) return ROUTE_DECISION_ALIASES[key];
  // 子串判（兜底常见关键字）
  if (key.includes('accept') || key.includes('通过') || key.includes('采纳')) return 'accept_as_truth';
  if (key.includes('escalate') || key.includes('上报') || key.includes('升级')) return 'escalate_user';
  if (key.includes('revise') || key.includes('auto') || key.includes('修订')) return 'auto_revise';
  return undefined;
}

/**
 * CR-5（W-CR 批）：lint 来源标记**机械交叉核对**（design H2「机械标注非 LLM 自报」的落地面）。
 *
 * Reader-Audit L2 按 yaml 契约给清单来源真阳携带 `source:'lint'`——但 source 是 LLM 自报字段，
 * 直接信任它豁免（hasNarrativeFeatureBlock 的 lint 豁免 + summarize.lintUnresolved）= LLM 自贴
 * 「机器确认」标签绕过人导演域硬规则。本函数对 claim 做**机械确认**：finding 必须与 lint_report
 * 的机械命中清单匹配（任一命中即确认——判源不判义，范式判据 ADR-3）：
 * - **quote 互含**：finding.quote 与 issue 的 `match`（命中原句）/ `context.current`（命中行）/
 *   densityIssue 的 `samples`（密度样本）**任一**剥空白后互含（L2 引文包住机械命中片段，或
 *   恰引用命中片段本身；CJK 散文空白无语义——容忍 LLM 引文换行/空格排版漂移）；
 * - **rule id 相等**：finding.subClass（yaml 契约：lint 来源条目 subClass 填规则 id）与 issue/
 *   densityIssue 的 `ruleId` 相等。
 *
 * 不匹配（LLM 给非清单来源条目误标/自造 lint 标签）→ false（caller 按非 lint 来源处理——叙事特征
 * block 维持强制 escalate）。lint_report artifact 缺/坏形态 → false（无机械清单可核对 = 无机械确认，
 * 保守不豁免）。纯代码字符串匹配，零语义。
 *
 * expected_downstream_consumers:
 * - hasNarrativeFeatureBlock（本文件，route 侧 R6② guard 的 lint 豁免）。
 * - chainRunner hasConfirmedLintFinding（summarize.lintUnresolved 判据）——同款机械核对接线归
 *   chainRunner 改造波（本函数单源供消费，防两处判据漂移）。
 */
export function isLintSourceMechanicallyConfirmed(
  finding: { quote?: unknown; subClass?: unknown },
  lintReportArtifact: unknown,
): boolean {
  const quote = typeof finding.quote === 'string' ? finding.quote.replace(/\s+/g, '') : '';
  const subClass = typeof finding.subClass === 'string' ? finding.subClass.trim() : '';
  if (!quote && !subClass) return false;
  if (!lintReportArtifact || typeof lintReportArtifact !== 'object' || Array.isArray(lintReportArtifact)) {
    return false;
  }
  const report = lintReportArtifact as { issues?: unknown; densityIssues?: unknown };
  const contains = (a: string, b: string): boolean =>
    a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
  const matchText = (candidate: unknown): boolean => {
    if (typeof candidate !== 'string') return false;
    // CJK 散文空白无语义——全剥后互含（容忍 LLM 引文换行/加空格的排版漂移，非语义判断）。
    const norm = candidate.replace(/\s+/g, '');
    return norm.length > 0 && quote.length > 0 && contains(quote, norm);
  };
  if (Array.isArray(report.issues)) {
    for (const raw of report.issues) {
      if (!raw || typeof raw !== 'object') continue;
      const issue = raw as { ruleId?: unknown; match?: unknown; context?: { current?: unknown } };
      if (subClass && typeof issue.ruleId === 'string' && subClass === issue.ruleId) return true;
      if (matchText(issue.match)) return true;
      if (matchText(issue.context?.current)) return true;
    }
  }
  if (Array.isArray(report.densityIssues)) {
    for (const raw of report.densityIssues) {
      if (!raw || typeof raw !== 'object') continue;
      const density = raw as { ruleId?: unknown; samples?: unknown };
      if (subClass && typeof density.ruleId === 'string' && subClass === density.ruleId) return true;
      if (Array.isArray(density.samples)) {
        for (const sample of density.samples) {
          if (matchText(sample)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * R6② defense-in-depth guard：review.latest 是否含「叙事特征维」block 级 finding（design §7②）。
 *
 * 产品硬约束：叙事特征维（discourse 域）问题永不 auto_revise 给 writer——discourse 是人导演域，
 * 问题需用户结构重写（escalate_user）。Reader-Audit L2 prompt 已编码此约束（narrative-feature block
 * → 该维不触发 revise），本 helper 是 route 侧 defense-in-depth：route 读 review.latest 时若 LLM 误判
 * auto_revise 但 narrative-feature 维有 block finding → 强制 normalize 为 escalate_user。
 *
 * **ADR-17 边界**（design §7② / `.trellis/spec/agent/orchestration-pattern.md` 反模式）：这是「特定 finding
 * 类别（narrative-feature block）→ escalate」的**产品硬规则**（discourse 人导演域），**非** verdict→action
 * 启发式映射（OOC bug-vs-feature / consistency finding 仍归 route LLM 语义判）。不机械扩到其他维——
 * 仅 narrative-feature 维的 block finding 触发强制 escalate（warn/info 不触发，仍走 route LLM 判）。
 *
 * 链流程重排 W3（R2 去味门禁 H2 机械门豁免）+ CR-5（W-CR 批机械交叉核对）：source==='lint' 条目
 * 须经 `isLintSourceMechanicallyConfirmed` 机械核对（quote/ruleId 对 lint_report 命中清单匹配）才豁免
 * ——lint 来源的叙事特征 block 是「llmlint 静态命中经 L2 判真」的确认 AI 味，属机器可识别的明确缺陷
 * （有确定修复方向，writer 可自动修），走环内 auto_revise 去味非 escalate。**判源不判义**：豁免依据是
 * 「来源=机械引擎命中」经代码侧核对成立，非 LLM 自报 source 字段（design H2「机械标注非 LLM 自报」）；
 * 自报不匹配机械清单的条目按 agent 来源处理。非 lint 来源的叙事特征 block 维持强制 escalate（人导演域
 * 硬规则不动）；同维混有多种来源时，任一非 lint block 即触发（豁免只放行 lint 条目，不放行整个维度）。
 *
 * dim name 开放匹配（reviewOutputSchema dimensions[].name 为 z.string() 开放值，LLM 可能写中文/变体）：
 * E7（CR patch）：含 narrative / 叙事 / discourse / 话语 / anti-slop / 风格 / 文风 / imagery / agency / 骨架
 * 即视为叙事特征维（防 LLM 用同义词作 dim 名时 guard 漏触发）。severity='block' 为封闭 enum（机械控制信号）。
 */
function hasNarrativeFeatureBlock(reviewArtifact: unknown, lintReportArtifact: unknown): boolean {
  if (!reviewArtifact || typeof reviewArtifact !== 'object') return false;
  const review = reviewArtifact as { dimensions?: unknown };
  if (!Array.isArray(review.dimensions)) return false;
  for (const dim of review.dimensions) {
    if (!dim || typeof dim !== 'object') continue;
    const d = dim as { name?: unknown; findings?: unknown };
    const name = typeof d.name === 'string' ? d.name : '';
    if (!/narrative|叙事|discourse|话语|anti-slop|风格|文风|imagery|agency|骨架/.test(name)) continue;
    if (!Array.isArray(d.findings)) continue;
    for (const f of d.findings) {
      if (!f || typeof f !== 'object') continue;
      // W3 H2 + CR-5：lint 来源条目豁免（机械核对确认后才豁免——判源不判义，去味门禁）。
      if (
        (f as { source?: unknown }).source === 'lint' &&
        isLintSourceMechanicallyConfirmed(f as { quote?: unknown; subClass?: unknown }, lintReportArtifact)
      ) {
        continue;
      }
      if ((f as { severity?: unknown }).severity === 'block') return true;
    }
  }
  return false;
}

/** route artifact shape（route_decision；runChain 驱动 revision 闭环 + escalate 上发）。 */
export type RouteDecisionArtifact = z.infer<typeof routeDecisionSchema>;

/**
 * route 节点：读 review.latest（verdict+reasons）+ chapter_brief（创作意图）+ draft.initial（正文）
 * → LLM 判 route_decision。stateKey='route_decision'。
 *
 * **route 非规则**（ADR-17）：不硬编码「某类 verdict→上发」（OOC→escalate / 客观→闭环 是假信心门）。
 * OOC bug-vs-feature 是创作判断（软弱角色 A 突然硬气 = 目标中的成长 ≠ OOC）→ 归 LLM 判。route-agent.yaml
 * system 段编码三档判据 + 创作意图优先（AC「route 非规则」）。
 *
 * buildPrompt 抽 verdict/reasons/chapterBrief/draft 四 var（对齐 prompts/route-agent.yaml 的
 * {{verdict}}/{{reasons}}/{{chapterBrief}}/{{draft}}）。
 */
export function createRouteNode(deps: ChapterLlmNodeDeps): AgentNode {
  return createLlmNode(
    {
      nodeId: 'route-agent',
      role: 'route-agent',
      contract: ROUTE_CONTRACT,
      buildPrompt: (run: RunSnapshot) => {
        const review = artifactAsRecord(run, 'review.latest');
        const draft = artifactAsRecord(run, 'draft.initial');
        return {
          verdict: scalarOf(review?.verdict),
          reasons: JSON.stringify(review?.reasons ?? []),
          chapterBrief: JSON.stringify(run.artifacts['chapter_brief'] ?? {}),
          draft: scalarOf(draft?.text),
        };
      },
      parseOutput: (content: string, run: RunSnapshot) => {
        const raw = routeDecisionSchema.parse(JSON.parse(extractJson(content)));
        // CR-8：归一 LLM 变体为 canonical 三档（chainRunner 机械 switch 需规范化值）。
        // 无法识别 → 抛 → createLlmNode 重试/兜底（machinery 不能驱动未知 decision）。
        let decision = normalizeRouteDecision(raw.decision);
        if (!decision) {
          throw new Error(`unrecognized route decision "${raw.decision}" (expected auto_revise/accept_as_truth/escalate_user or alias)`);
        }
        // R6② defense-in-depth（design §7②）：narrative-feature 维 block finding → 强制 escalate_user。
        // 产品硬规则（discourse 人导演域永不 auto_revise 给 writer），非 verdict→action 启发式（ADR-17 边界，
        // 详 hasNarrativeFeatureBlock 注释）。route LLM 通常已据 prompt 约束判对，本 guard 是兜底防 LLM 误判。
        // E2（CR patch）：guard 覆盖任何**非 escalate_user** decision（auto_revise **或** accept_as_truth）——
        // narrative-feature block 时 accept_as_truth 也不该静默接受（discourse 问题需用户结构重写），强制 escalate。
        // 链流程重排 W3（R2 去味门禁 H2）+ CR-5：source='lint' 条目经 isLintSourceMechanicallyConfirmed
        // 机械核对后在 helper 内豁免（LLM 自报须对 lint_report 命中清单匹配——机械确认 AI 味可环内
        // auto_revise 去味；自报不匹配按 agent 来源强制 escalate）。
        if (
          decision !== 'escalate_user' &&
          hasNarrativeFeatureBlock(run.artifacts['review.latest'], run.artifacts['lint_report'])
        ) {
          decision = 'escalate_user';
        }
        // 4.1 Step 4：deviation 透传（LLM 判正文偏离计划；accept 分支 buildChapterAccept 读此登记 StoryDecision）。
        const artifact: { decision: string; reason: string; deviation?: boolean } = { decision, reason: raw.reason };
        if (raw.deviation !== undefined) artifact.deviation = raw.deviation;
        return { stateKey: 'route_decision', artifact };
      },
    },
    deps,
  );
}
