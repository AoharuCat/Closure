import {
  buildSelectionAnchor,
  parseRevisionIntent,
  REVIEW_ATTRIBUTION_VALUES,
  type EscalateFinding,
  type ReusableAgentNodeContract,
  type RevisionIntent,
  type SelectionAnchor,
} from '@orison/shared-contracts';
import { createLlmNode, type LlmNodeDeps } from './llm-node';
import { readRevisionIntent } from './chapter-nodes';
import { logger } from '../logger';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';

// ── 链流程重排 W1c（task 09-13-chain-flow-restructure）：自审环 C1 位节点工厂 ──
//
// revision-optimizer-node = 改稿意图编译的 **in-chain 化**（design §2：7.4 候选④ leader 驱动 redo 的
// 「revision-optimizer 编译 RevisionIntent」段收进链内）。读 review.latest findings + chapter_brief +
// draft → 产 `revision_intent` artifact（RevisionIntent schema 既有，shared-contracts）。
//
// **复用既有 prompts/revision-optimizer-agent.yaml**（ADR-4 单契约源，不新建）——vars 形态
// selectedPassage/userInstruction/chapterContext/auditFindings 与 leader 侧 A-trigger
// （write-chapter.ts dispatchRevisionOptimizer）对齐：userInstruction=机械指令（A-trigger 非人指令，
// audit-finding source 在 rationale 标注）。**selectedPassage 差异（CR-4）**：leader 侧 A-trigger 传整稿；
// 本节点机械定位 findings quote 命中段落作 selectedPassage（定位不到才降级整稿）——「scope 由系统构造」
// 的 in-chain 落地。差异：leader 侧是带 query_story 工具的子 agent（runAgentWithExplicitSystem），本节点是链内单发
// generate（createLlmNode 骨架，无工具——意图编译主输入已全在 vars，查设定增强缺省可接受）。
//
// **消费侧已全 artifact 化**（W0-6）：draft-writer（buildDraftWriterVars 的 formatRevisionIntent）
// 与 revision-guard 均读 run.artifacts['revision_intent']——本节点以 stateKey='revision_intent'
// 产出即接通，C2/C3 零改动。chainRunner :177 对 run.artifacts 赋值与 redo 注入同视。
//
// **no-op 直通**（design §2 / M2 + W0-6 + CR-20）三条件：
//  1. 无 review.latest（首圈直通——C1 在链序上先于 C5 multi-review，首轮 review 未产）。
//  2. revision_intent 已为外部预置（rationale.source ≠ 'audit-finding'——终稿/裁决 redo 注入
//     'user-directive'/'redo-feedback'）→ 不二次编译稀释人指令。
//  3. draft.initial 正文为空/缺（CR-20——corrupt resume 快照下 review.latest 在而正文空：不驱动
//     空态段落编译，skip 让 C2 走无 intent 整章首写路径恢复）。
// 命中任一 → 跳过 LLM 直通（外部预置原样透传不覆盖；其余 → no-op 标记）。
//
// **scope 机械构造（CR-4）**：design「scope 由系统构造」落地——findings quote 在 draft.initial.text
// 中机械定位（首次命中），引文所在段（\n 边界扩展）为段落级改稿单元，经 buildSelectionAnchor（F2
// 既有纯代码单源）构造 scope.anchor；selectedPassage 同源命中段。C2 写手据 anchor 做段落级改稿、
// C3 guard 有 anchor 真跑护栏（L1+L2+splice）——环体主路径每圈有护栏覆盖（AC6 红 2）。降级链：
// 全部 findings quote 不可定位（LLM 引文非逐字）→ anchorless 整章路径维持（guard skip 语义留），
// intent 附注 anchorless 机械降级原因（可观测）。
//
// **编译失败 graceful**：初试+重试均败 → 产 `optimizer_failed` 信号 artifact（route 据此升级
// escalate，永不静默——R6① 不假 pass：绝不编造 RevisionIntent 填给 C2，错误意图比无意图更害改稿，
// mirror tool/revision-optimizer.ts graceful 哲学）。**信号消费归 W1a 环机制**，本节点只产信号。
//
// expected_downstream_consumers:
// - W1d（chapter-chain.ts）：装配自审环 C1 位（loops 数组 from='revision-optimizer-node'）。
// - W1a（chainRunner）：optimizer_failed → route 升级 escalate；no-op 判据测试钉死（M3 环计数重置）。
// - C2 draft-writer / C3 revision-guard：读 revision_intent（既有消费面零改动）。

/** revision_intent artifact key（与 redo 注入路径同 key——chainRunner 视角同源）。 */
export const REVISION_INTENT_KEY = 'revision_intent';
/** optimizer_failed 信号 artifact key（W1a route 消费：编译失败 → 升级 escalate）。 */
export const OPTIMIZER_FAILED_KEY = 'optimizer_failed';

/**
 * optimizer_failed 信号形态（机械信号非语义——「编译失败」纯代码可判，W1a 环判据消费）。
 *
 * 产此信号时 revision_intent **不被本节点改写**（保持上一轮产物或缺省）——失败圈内 C2 是否
 * 消费 stale intent / 是否提前 break，归 W1a 环机制决断（本节点只产信号，不越权清账）。
 */
export interface OptimizerFailedSignal {
  optimizer_failed: true;
  nodeId: string;
  message: string;
}

/** artifact 是否 optimizer_failed 信号（W1a/W1d 判据 + 测试用机械判定）。 */
export function isOptimizerFailedSignal(artifact: unknown): artifact is OptimizerFailedSignal {
  return (
    Boolean(artifact) &&
    typeof artifact === 'object' &&
    (artifact as { optimizer_failed?: unknown }).optimizer_failed === true
  );
}

const REVISION_OPTIMIZER_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'revision-optimizer-node',
  displayName: 'Revision Optimizer Node',
  inputSchemaName: 'revisionOptimizerInput',
  outputSchemaName: 'revisionIntentSchema',
  // 链流程重排 W1d 位调整：C1 在链序上位于 draft-writer **前**（环 from——写手单位置进环体的前提，
  // chapter-chain.ts 文件头注），首圈 no-op（无 review.latest）不读稿 → draft.initial 不进 required
  // （进则首圈 DAG blocked 断链）。环回圈 review.latest 在时 buildPrompt 才读 draft.initial——
  // 届时写手上一圈已产稿，恒在场。chapter_brief optional graceful。
  requiredArtifactKeys: [],
  // may-produce（mirror revision_guard 声明惯例，非「每次都写」）：编译成功 → 'revision_intent'；
  // no-op 直通 → 'revision_intent'（透传/标记）；编译失败 → 'optimizer_failed'。
  producedArtifactKeys: [REVISION_INTENT_KEY, OPTIMIZER_FAILED_KEY],
  sideEffects: ['call_model'],
};

// ── helpers（mirror chapter-nodes / world-extractor 本地小件惯例）──

function artifactAsRecord(run: RunSnapshot, key: string): Record<string, unknown> | undefined {
  const raw = run.artifacts[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function scalarOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * revision_intent 是否外部预置（no-op 判据 2）：合法 RevisionIntent shape 且 rationale.source ≠
 * 'audit-finding'。本节点自产恒 'audit-finding'（parseOutput 机械盖戳），故 source 判别 = 「自己上圈
 * 产物」vs「终稿/裁决 redo 注入」（W0-6 落点建议原文）。
 */
function isExternallyPlacedIntent(raw: unknown): boolean {
  const intent = readRevisionIntent(raw);
  return intent !== undefined && intent.rationale.source !== 'audit-finding';
}

/** auditFindings 控量上限（mirror chainRunner extractEscalateFindings cap 8——防编译 prompt 爆）。 */
const MAX_AUDIT_FINDINGS = 8;

/** draft.initial.text 读取（CR-20 空稿守卫 + CR-4 机械定位共用）。 */
function draftTextOf(run: RunSnapshot): string {
  return scalarOf(artifactAsRecord(run, 'draft.initial')?.text);
}

/**
 * CR-4（W-CR 批）：从 review.latest findings 机械定位段落级选区——design「scope 由系统构造」落地。
 *
 * 遍历 projectAuditFindings（block/warn + grounding 已滤的 actionable findings），取**首个 quote 可在
 * draft.initial.text 中逐字定位（indexOf 首次命中）**的 finding——引文命中处所在段落（`\n` 边界扩展；
 * 引文跨段时含全部涉及段）即段落级改稿单元 + 合理上下文窗，经 buildSelectionAnchor（F2 既有纯代码
 * 单源：quote + prefix/suffix 消歧 + rangeHint）构造 scope.anchor。纯机械（quote 字面命中判源，
 * 零语义判断——范式判据 ADR-3：「哪段需要改」的定位权留纯代码记账，意图编译仍归 LLM）。
 *
 * 全部 findings 的 quote 均不可定位（LLM 引文非逐字 / stale snapshot）→ undefined（caller 降级
 * anchorless 整章路径——guard skip 语义留，intent 附注降级原因）。
 *
 * expected_downstream_consumers:
 * - buildPrompt（selectedPassage = 命中段落）+ parseOutput（scope.anchor 构造）——同输入确定性
 *   双算（字符串 ops，廉），不改 yaml 契约（optimizer 仍不产 scope）。
 */
function locateAuditFindingPassage(
  run: RunSnapshot,
): { anchor: SelectionAnchor; passage: string } | undefined {
  const draftText = draftTextOf(run);
  if (!draftText) return undefined;
  for (const finding of projectAuditFindings(run.artifacts['review.latest'])) {
    const idx = draftText.indexOf(finding.quote);
    if (idx < 0) continue; // 引文非逐字命中 → 试下一个 finding（首个「可定位」的 actionable finding）
    // 段落边界扩展（命中段落 + 上下文窗）：命中处向前到段首、向后到段尾（跨段引文含全部涉及段）。
    const from = draftText.lastIndexOf('\n', idx) + 1;
    const nlAfter = draftText.indexOf('\n', idx + finding.quote.length);
    const to = nlAfter === -1 ? draftText.length : nlAfter;
    const passage = draftText.slice(from, to);
    if (passage.trim().length === 0) continue; // 防御：空段（理论不可达——quote 命中在段内）
    return { anchor: buildSelectionAnchor(draftText, passage, from, to), passage };
  }
  return undefined;
}

/**
 * review.latest → auditFindings 投影（block/warn drop info + grounding 硬要求 + cap 8）。
 *
 * **机械投影 mirror chainRunner extractEscalateFindings**（刻意不 import：chainRunner 是 W1a 改造区，
 * 本节点自带投影防跨波文件耦合——两处 shape 同源 EscalateFinding 契约，W1a 环改造后如收止单源再并）。
 * 输入形态对齐退役前的 leader 侧 A-trigger（auditFindings var 同投影产物，yaml 契约零改的代价）。
 */
function projectAuditFindings(reviewArt: unknown): EscalateFinding[] {
  if (!reviewArt || typeof reviewArt !== 'object') return [];
  const review = reviewArt as { dimensions?: unknown };
  if (!Array.isArray(review.dimensions)) return [];
  const findings: EscalateFinding[] = [];
  for (const dim of review.dimensions) {
    if (!dim || typeof dim !== 'object') continue;
    const d = dim as { findings?: unknown };
    if (!Array.isArray(d.findings)) continue;
    for (const f of d.findings) {
      if (!f || typeof f !== 'object') continue;
      const finding = f as Record<string, unknown>;
      const severity = finding.severity;
      if (severity !== 'block' && severity !== 'warn') continue; // drop info 噪声
      const quote = typeof finding.quote === 'string' ? finding.quote : '';
      const location = typeof finding.location === 'string' ? finding.location : '';
      const explanation = typeof finding.explanation === 'string' ? finding.explanation : '';
      if (!quote || !location || !explanation) continue; // grounding 硬要求（mirror CR-Edge-6）
      if (findings.length >= MAX_AUDIT_FINDINGS) return findings;
      const attribution = REVIEW_ATTRIBUTION_VALUES.find((v) => v === finding.attribution);
      findings.push({
        severity,
        quote,
        location,
        explanation,
        ...(typeof finding.subClass === 'string' ? { subClass: finding.subClass } : {}),
        ...(attribution !== undefined ? { attribution } : {}),
      });
    }
  }
  return findings;
}

// ════════════════════════════════════════════════════════════════════════════
// 节点工厂
// ════════════════════════════════════════════════════════════════════════════

/**
 * revision-optimizer 节点工厂（C1 in-chain 化）。
 *
 * - no-op 直通（shouldSkip）：无 review.latest **或** revision_intent 外部预置（source≠'audit-finding'）
 *   **或** draft.initial 正文空（CR-20 corrupt resume 守卫）→ skipResult：预置意图原样透传（identity
 *   写不覆盖不稀释）；其余 → no-op 标记（非 RevisionIntent shape，下游 readRevisionIntent → undefined
 *   → C2 走无 intent 路径）。
 * - 编译路径：单次 generate（复用 revision-optimizer-agent.yaml）→ parseRevisionIntent（三路径
 *   鲁棒）→ **source 机械盖戳 'audit-finding'**（不信 LLM 标注——mirror world-extractor axis 强制
 *   注入：本节点唯一职能是 A-trigger 编译，no-op 判别不变式依赖此值）→ **scope 机械构造（CR-4）**：
 *   findings quote 命中段落经 buildSelectionAnchor 构 anchor（LLM 自报 scope 覆盖）；定位不到 →
 *   anchorless + compilerNote 附注降级原因 → revision_intent artifact。
 * - 编译失败 graceful wrapper（mirror world-extractor CR-E3）：createLlmNode 兜底 error artifact →
 *   转 optimizer_failed 信号（stateKey='optimizer_failed'，route 据此升级 escalate 永不静默）。
 *   AbortError 在 createLlmNode 内重抛（取消语义不吞成信号）。
 *
 * @param deps LLM deps（generate/modelRef/signal/thinking/fallbacks/taskType，createLlmNode 用）。
 */
export function createRevisionOptimizerNode(deps: LlmNodeDeps): AgentNode {
  const innerNode = createLlmNode(
    {
      nodeId: 'revision-optimizer-node',
      role: 'revision-optimizer-agent',
      contract: REVISION_OPTIMIZER_CONTRACT,
      shouldSkip: (run: RunSnapshot) =>
        !run.artifacts['review.latest'] ||
        isExternallyPlacedIntent(run.artifacts['revision_intent']) ||
        draftTextOf(run).trim().length === 0,
      skipResult: (run: RunSnapshot): NodeResult => {
        const existing = readRevisionIntent(run.artifacts['revision_intent']);
        if (existing) {
          // 外部预置（终稿/裁决 redo 注入）原样透传——同值回写（identity），不编译不稀释（M2）。
          return { stateKey: REVISION_INTENT_KEY, artifact: existing };
        }
        // 无 review.latest（首圈直通）或正文空（CR-20 corrupt resume 守卫）→ no-op 标记
        // （非 RevisionIntent shape：readRevisionIntent 守卫 → undefined → C2/C3 当无 intent
        // 处理，draft-writer 整章路径）。
        return {
          stateKey: REVISION_INTENT_KEY,
          artifact: {
            optimizerNoOp: true,
            nodeId: 'revision-optimizer-node',
            reason: run.artifacts['review.latest'] ? 'empty-draft-initial' : 'no-review-latest',
          },
        };
      },
      buildPrompt: (run: RunSnapshot) => {
        // CR-4：selectedPassage = 机械定位的命中段落（findings quote 所在段——段落级改稿单元 +
        // 上下文窗）；定位不到（全部引文非逐字）→ 降级整稿（anchorless 整章路径，C2 整章重写）。
        const located = locateAuditFindingPassage(run);
        return {
          selectedPassage: located?.passage ?? draftTextOf(run),
          // 机械指令（A-trigger 非人指令——与 leader 侧逐字对齐，audit-finding source 标真实来源）。
          userInstruction: '据 Reader-Audit 审核发现修订本章明确缺陷（auto_revise route decision）',
          chapterContext: JSON.stringify(run.artifacts['chapter_brief'] ?? {}),
          auditFindings: JSON.stringify(projectAuditFindings(run.artifacts['review.latest'])),
        };
      },
      parseOutput: (content: string, run: RunSnapshot) => {
        const intent = parseRevisionIntent(content);
        if (!intent) {
          // 三路径鲁棒解析（fence/brace/whole）后仍无合法 RevisionIntent → 抛触发 createLlmNode
          // 重试（错误回灌）；重试仍败 → wrapper 转 optimizer_failed（永不编造 intent）。
          throw new Error('parseRevisionIntent 返 null（无合法 RevisionIntent JSON 或 shape 不符）');
        }
        // CR-4：scope 由本节点机械构造——LLM 自报 scope 一律不信（F2 范式订正：yaml 契约「不产
        // scope」，LLM 无 draft body / 字符坐标，自报 anchor 是幻觉源）。命中 → 机械 anchor 覆盖；
        // 定位不到 → 剥 scope（anchorless 整章路径）+ provenance.compilerNote 附注机械降级原因
        // （〔机械附注〕前缀与 LLM 编译说明区分，可观测非静默）。
        const { scope: _llmScope, ...rest } = intent;
        void _llmScope;
        // source 机械盖戳（no-op 判别不变式：C1 自产恒 'audit-finding'——LLM 误标 'user-directive'
        // 会让下圈误判「外部预置」跳过编译，破坏环；机械控制信号归一，mirror axis 强制注入先例）。
        const located = locateAuditFindingPassage(run);
        const artifact: RevisionIntent = located
          ? {
              ...rest,
              rationale: { ...rest.rationale, source: 'audit-finding' },
              scope: { anchor: located.anchor },
            }
          : {
              ...rest,
              rationale: { ...rest.rationale, source: 'audit-finding' },
              provenance: {
                ...rest.provenance,
                compilerNote: `${rest.provenance.compilerNote}〔机械附注〕findings 引文未能在正文逐字定位段落选区——降级整章改稿路径（revision-guard 整章 skip 语义）`,
              },
            };
        return { stateKey: REVISION_INTENT_KEY, artifact };
      },
    },
    deps,
  );

  // graceful wrapper：编译失败（error artifact）→ optimizer_failed 信号（route 升级 escalate 的
  // 机械依据；本节点绝不假信心编造 intent——R6①）。
  return {
    contract: innerNode.contract,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const result = await innerNode.run(input);
      const artifact = result.artifact;
      if (
        Boolean(artifact) &&
        typeof artifact === 'object' &&
        (artifact as { error?: unknown }).error === true
      ) {
        const message =
          typeof (artifact as { message?: unknown }).message === 'string'
            ? (artifact as { message: string }).message
            : 'unknown error';
        logger.warn(
          { nodeId: 'revision-optimizer-node', message },
          'revision-optimizer: LLM failed after retries → optimizer_failed signal (route escalates, never silent)',
        );
        const signal: OptimizerFailedSignal = {
          optimizer_failed: true,
          nodeId: 'revision-optimizer-node',
          message,
        };
        return { stateKey: OPTIMIZER_FAILED_KEY, artifact: signal };
      }
      return result;
    },
  };
}
