import { randomUUID } from 'node:crypto';
import {
  COMPLETENESS_VERIFY_CONTRACT,
  COMPLETENESS_VERIFY_RESULT_KEY,
  completenessVerifyResultSchema,
  computeCompletenessCandidates,
  type EmotionCurve,
  type EmotionVerifyResult,
  type PromiseRegistry,
  type ProjectThemeInput,
  type SceneGraph,
} from '@orison/shared-contracts';
import { isAbortError, MAX_ATTEMPTS, type LlmNodeDeps } from './llm-node';
import { extractJson } from './extract-json';
import { resolveAnchorStoryTime } from './research-verifier';
import { fetchAppearanceGapStatsViaTools } from './mention-query';
import { loadAgentPrompt } from '../prompt/agentPrompt';
import { renderTemplate } from '../prompt/template';
import { logger } from '../logger';
import type { SessionMessage } from '../types';
import type { GenerationDelta } from '../provider/ipc-provider';
import type { AgentNode, NodeResult, RunSnapshot } from '../contracts/run';

// ── Story 4.4 R2：completeness-verify-node（design §1-§5 / ADR-3 / creative-vs-mechanical §4.4）──
//
// chapter-chain 内事后 **cross-arc 完整性 verify composite 节点**（L1 候选汇编 → L2 LLM 语义挣得裁判）。
// 挂 `route-agent` 后（design §2 挂点，CHAPTER_CHAIN_NODE_IDS chain 末段）——cross-arc verify 在 revision
// 闭环外（4.4 不改本章稿，verdict 发 Director 影响后章规划，非走 route→revision）。
//
// 🔑 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md「Cross-arc 完整性维」条）：
// - L1 step = 纯代码候选汇编（computeCompletenessCandidates）：5 类候选 + 机械事实（枚举/
//   resolvePromiseFulfillment 派生/覆盖率统计/5.3 flag 透传）。**永不直接判 missing/under-developed**
//   （假信心门红线：词库命中→极性加权→pass/fail 是假信心，feedback-l1-entity-extraction-false-confidence-gate）。
// - L2 step = LLM 语义挣得裁判：判「该挣得的有没有挣得 / 该兑现的有没有真兑现 / 该推进的有没有真推进」。
//   这是创作判断（类比 4.6 灰区裁决器「哪个更好」），机械测不出。
// - Story 8.7 S9（design §2.4 编译面）：L1 加**出场间隔计数**（appearanceGaps——buildAppearanceGapStats
//   shared 单源纯函数，弹药/工具统计视图同源）。纯计数不判意义：「N 章未露面」进 L1 输入，「该不该出场/
//   是否被遗忘」归 L2 语义层（mirror promise deadlinePassed 机械事实喂法）。
//
// 与 5.x / 6.5 正交（design §11 / AC5）：
// - 5.3 emotion-verify 数学指纹 + 5.4 Emotion.unlanded 场级落地 = 机械化层 / per-chapter 层；4.4 = cross-arc
//   语义挣得层（情绪弧挣得消费 5.3 flag + 跨弧 emotion_curve 做语义裁判，与 5.4 场级落地正交）。
// - 6.5 promise-landing per-chapter 节拍落地；4.4 cross-arc 兑现（Promise 生命周期是否兑现，非本章 beat 落地）。
// - 4.2 Reader-Audit 5 维全 per-chapter scope；4.4 只 cross-arc。
//
// composite 节点（非 createLlmNode 单体）：因 L1→L2 是节点内部两步数据流（L1 先算候选 → 喂 L2 prompt），
// mirror createReaderAuditNode（chapter-nodes.ts:314）composite 模式。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror emotion-verify-node / promise-emergence-node 先例——链段节点经
// createChapterChainNodes 装配，不进 agentContracts.ts CONTRACTS[]（orchestration-pattern.md 子 agent / 链段节点
// 不进 CONTRACTS[] 约定）。requiredArtifactKeys=[]（design §2 graceful：累积数据源缺失不阻断链，L1 降级空候选
// + L2 跳过该类 + degraded=true 标注，mirror emotion-verify-node.ts:62）。
//
// 反馈通道（D2 mirror emotionVerifyFeedback）：completeness_verify_result artifact 经 write_chapter
// completenessFeedback var 透传 Director user 段作「本章规划参考」（suggestedFix 反哺，**非实写重规划**——
// Director 重规划段是 placeholder 归 7.3/8.1，4.4 不越界）。cross-chapter 持久化 defer 7.3/8.1（与 5.3 同命运）。
//
// expected_downstream_consumers:
// - Story 7.3/8.1：Director 重规划段读 completeness_verify_result.findings（suggestedFix 反哺下一轮 Director，
//   4.4 产 finding 不实写重规划）。
// - Epic 3/10：ledger 缺漏统计 → dashboard 可视化（滞后做）。

/**
 * composite 节点 deps（mirror LlmNodeDeps——4.4 不消费 tagChinese/compress，故用基础 LlmNodeDeps：
 * generate/modelRef/signal 透传 L2 step）。
 */
export type CompletenessVerifyNodeDeps = LlmNodeDeps;

/** 从 chapter_brief_input artifact 解析 episodeId（mirror chapter-nodes.ts / emotion-verify-node.ts）。 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

/** 安全取 artifact 字段（mirror chapter-nodes.ts artifactAsRecord）。 */
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
 * 轻量 emotion_curve 守卫（mirror emotion-verify-node.ts readEmotionCurve）。
 * assemble 总注入合法 EmotionCurve（safeParse 降级空 curve）；bypass 路径可能缺/坏 → undefined。
 *
 * CR-001：points 元素形态守卫——元素须全为 object（points=['foo'] / [42] 的 bypass 坏数据 → undefined）。
 */
function readEmotionCurve(raw: unknown): EmotionCurve | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as { points?: unknown };
  if (!Array.isArray(c.points)) return undefined;
  if (!c.points.every((p) => p !== null && typeof p === 'object')) return undefined;
  return raw as EmotionCurve;
}

/**
 * 轻量 promise_registry 形态守卫（mirror emotion-verify-node.ts isValidPromiseRegistry）。
 */
function isValidPromiseRegistry(v: unknown): v is PromiseRegistry {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as { promises?: unknown; beats?: unknown };
  return Array.isArray(r.promises) && Array.isArray(r.beats);
}

/**
 * 轻量 project_theme 守卫（caller fetch 注入；bypass 路径可能缺 → undefined，L1 降级空候选）。
 *
 * CR-001：declaredThemes 元素类型守卫——须全为 string（[42, {}] 等坏数据 → undefined，L1 source-missing 降级）；
 * themeMappings 元素须全为 object。
 */
function readProjectTheme(raw: unknown): ProjectThemeInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const t = raw as { declaredThemes?: unknown; themeMappings?: unknown };
  const declaredThemes = t.declaredThemes;
  const themeMappings = t.themeMappings;
  const hasThemes = Array.isArray(declaredThemes);
  const hasMappings = Array.isArray(themeMappings);
  if (!hasThemes && !hasMappings) return undefined;
  if (hasThemes && !(declaredThemes as unknown[]).every((x) => typeof x === 'string')) return undefined;
  if (
    hasMappings &&
    !(themeMappings as unknown[]).every((m) => m !== null && typeof m === 'object' && !Array.isArray(m))
  ) {
    return undefined;
  }
  return raw as ProjectThemeInput;
}

/**
 * 已写章节派生结果（CR-005：reason 区分三路返空，让 renderWrittenChapters 区分「outlines 缺」vs
 * 「current 定位失败」消息）。
 */
interface WrittenEpisodeInfo {
  ids: string[];
  /** 返空原因（ids 非空时 undefined）：区分三种 graceful 返空路径，供 renderWrittenChapters 消息区分成因。 */
  reason?: 'no-outlines' | 'no-current' | 'no-current-index';
}

/**
 * 从 episode_outlines 派生已写章节 id 集合 + episode index map（per design §3 候选覆盖率统计 +
 * Promise deadline 已过判定用）。
 *
 * 纯代码机械（episode index 排序 + id 集合提取，非语义）。4.4 候选汇编用此集做「turning_point.linked_episode_ids
 * 覆盖已写章节」等统计；CR-002 起 `collectPromiseCandidates` 的 deadlinePassed 改用 indexByEpisodeId 做
 * 严格 `<` 比较（替代旧 writtenSet.has 集合法），同此派生。
 *
 * 🔑 已写章节判定 = episode.index <= currentEpisodeId's index（mirror 5.3 emotion-verify-node isDeadlinePassed
 * 的 index 排序哲学，emotion-verify-node.ts:120-134）。episode_outlines 是项目规划全集，**不可全量当「已写」**——
 * 否则未来 episode 的 Promise deadline 会误报 deadlinePassed=true（L2 信任 deadlinePassed 机械事实，会产假
 * Promise.missing-payoff finding）。currentEpisodeId 含（本章尚在写，场/转折点可能已触及）；index > current 的
 * 未来 episode 不计。
 *
 * graceful：currentEpisodeId 缺 / 不在 outlines / episode 缺 index → 返空集（coverage 降级 0 + deadline 不判
 * 过期，mirror 5.3 isDeadlinePassed graceful「无 index 排序 → 不造假设过」）。**8.2 升级点**（design §9）：
 * 替换为分弧/折叠快照 reader（节点入参形态不变）。
 *
 * @returns `{ ids, reason, indexById }`：ids 已写章节集；reason 三路返空区分（CR-005）；
 *          indexById id→index map（CR-002 collectPromiseCandidates 严格 index 比对用）。
 */
function deriveWrittenEpisodeIds(
  episodeOutlines: unknown,
  currentEpisodeId: string | undefined,
): WrittenEpisodeInfo & { indexById: Map<string, number> } {
  if (!Array.isArray(episodeOutlines)) return { ids: [], reason: 'no-outlines', indexById: new Map() };
  // Build (id, index) pairs（episodeOutlineSchema：id + index 均 required）。
  const parsed: Array<{ id: string; index: number }> = [];
  for (const ep of episodeOutlines) {
    if (!ep || typeof ep !== 'object') continue;
    const e = ep as { id?: unknown; index?: unknown };
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    if (typeof e.index !== 'number' || !Number.isFinite(e.index)) continue;
    parsed.push({ id: e.id, index: e.index });
  }
  const indexById = new Map(parsed.map((p) => [p.id, p.index]));
  if (currentEpisodeId === undefined) return { ids: [], reason: 'no-current', indexById };
  const currentIdx = parsed.find((p) => p.id === currentEpisodeId)?.index;
  if (currentIdx === undefined) {
    return { ids: [], reason: 'no-current-index', indexById };
  }
  return { ids: parsed.filter((p) => p.index <= currentIdx).map((p) => p.id), indexById };
}

/**
 * 把 writtenEpisodeIds 渲染为 L2 prompt 的 writtenChapters 上下文段（统一对象数组形态，CR-005）。
 *
 * 纯代码格式化（非语义判断）。L2 据此 + draftText + candidates 判「该已写章节触及时是否真推进」（语义归 L2）。
 * mirror implement.md Step 3.2「writtenChapters 已写章节上下文摘要/索引」——附 title 让 L2 知道各 episode 是什么，
 * 非 only-id（裸 id 上下文不足 L2 判推进）。
 *
 * CR-005：统一返对象数组形态 `[{id, title?, note?}]`，去掉旧三异构（中文字符串/对象数组/裸 id 字符串数组）。
 * - ids 空时：返 `[{id:'（无数据）', note:'<reason 消息>'}]`（outlines 缺 vs current 定位失败消息区分）。
 * - outlines 条目缺 title/不全：fallback `ids.map(id => ({id}))` 补齐（非裸 id 字符串数组）。
 */
function renderWrittenChapters(
  episodeOutlines: unknown,
  info: WrittenEpisodeInfo,
): string {
  if (info.ids.length === 0) {
    const reasonMsg =
      info.reason === 'no-outlines'
        ? '无 episode_outlines 数据'
        : info.reason === 'no-current'
          ? '无 currentEpisodeId（无法定位本章）'
          : info.reason === 'no-current-index'
            ? 'currentEpisodeId 不在 episode_outlines 内'
            : '无已写章节';
    return JSON.stringify([{ id: '（无数据）', note: `覆盖率统计降级：${reasonMsg}` }]);
  }
  const writtenSet = new Set(info.ids);
  const entries: Array<{ id: string; title?: string }> = [];
  if (Array.isArray(episodeOutlines)) {
    for (const ep of episodeOutlines) {
      if (!ep || typeof ep !== 'object') continue;
      const e = ep as { id?: unknown; title?: unknown };
      if (typeof e.id !== 'string' || !writtenSet.has(e.id)) continue;
      entries.push({
        id: e.id,
        ...(typeof e.title === 'string' && e.title.length > 0 ? { title: e.title } : {}),
      });
    }
  }
  // entries 可能因 outlines 缺 title/条目不全而短于 writtenSet；fallback {id} 对象补齐（CR-005：非裸 id 字符串数组）。
  if (entries.length === 0) return JSON.stringify(info.ids.map((id) => ({ id })));
  return JSON.stringify(entries);
}

/**
 * 构造 completeness-verify 节点（composite L1 候选汇编 → L2 LLM 语义挣得裁判，design §2-§5）。
 *
 * run 流程（mirror createReaderAuditNode chapter-nodes.ts:322-495）：
 *  1. 读累积 artifacts（growth_curve/scene_graph/emotion_curve/emotion_verify_result/promise_registry/project_theme/
 *     episode_outlines/draft.initial），全 graceful（artifactAsRecord + 守卫 + ?? '' 模式）。
 *  2. L1：`computeCompletenessCandidates(...)`（try/catch 降级空候选，mirror :336-349）。
 *  3. L2：loadAgentPrompt('completeness-verify-agent') + renderTemplate + generate + parse
 *     （completenessVerifyResultSchema）+ retry（MAX_ATTEMPTS）。
 *  4. fallback：parse 失败 → escalate artifact（mirror :478-493，AC6 永不假 pass——产 summary='parse 失败需人工'
 *     + findings=[] + degraded=true，Director 见空 findings + degraded 知失败，不静默 pass）。
 *
 * DI（ADR-2）：generate/modelRef/signal 透传 L2 step（mirror createReaderAuditNode DI 哲学，4.4 不消费 tagChinese/
 * compress 故不要求这两字段）。
 *
 * contract requiredArtifactKeys=[]（design §2 graceful，mirror emotion-verify-node.ts:62）。consumes 全 optional。
 */
export function createCompletenessVerifyNode(deps: CompletenessVerifyNodeDeps): AgentNode {
  const { generate, modelRef, thinking, signal, fallbacks, taskType, onDelta } = deps;
  const nodeId = 'completeness-verify-node';
  const role = 'completeness-verify-agent'; // yaml 文件名（prompts/completeness-verify-agent.yaml）

  return {
    contract: COMPLETENESS_VERIFY_CONTRACT,
    async run(input): Promise<NodeResult> {
      const { run } = input;

      // ── 1. 读累积 artifacts（全 graceful，mirror createReaderAuditNode :328-331）──
      const draft = artifactAsRecord(run, 'draft.initial');
      const draftText = scalarOf(draft?.text);
      const sceneGraph = run.artifacts['scene_graph'] as SceneGraph | undefined;
      const currentEpisodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      const emotionCurve = readEmotionCurve(run.artifacts['emotion_curve']);
      // emotion_verify_result 是 EmotionVerifyResult（5.3 产，链段 artifact）。形态守卫（mirror readEmotionCurve）：
      // 非 object / 数组 → undefined；CR-001 flags 字段守卫——须为 Array（坏数据 `flags:'foo'` → undefined）。
      const emotionVerifyResultRaw = run.artifacts['emotion_verify_result'];
      const emotionVerifyResult = (() => {
        if (!emotionVerifyResultRaw || typeof emotionVerifyResultRaw !== 'object' || Array.isArray(emotionVerifyResultRaw)) {
          return undefined;
        }
        const r = emotionVerifyResultRaw as { flags?: unknown };
        if (!Array.isArray(r.flags)) return undefined;
        return emotionVerifyResultRaw as EmotionVerifyResult;
      })();
      const promiseRegistry = isValidPromiseRegistry(run.artifacts['promise_registry'])
        ? run.artifacts['promise_registry']
        : undefined;
      const projectTheme = readProjectTheme(run.artifacts['project_theme']);
      const growthCurveRaw = run.artifacts['growth_curve'];
      const episodeOutlines = run.artifacts['episode_outlines'];
      const writtenEpisodes = deriveWrittenEpisodeIds(episodeOutlines, currentEpisodeId);
      const writtenEpisodeIds = writtenEpisodes.ids;

      // ── 2. L1：纯代码候选汇编（design §3，try/catch 降级空候选，mirror createReaderAuditNode :336-349）──
      let candidates;
      try {
        candidates = computeCompletenessCandidates({
          growthCurveRaw,
          sceneGraph,
          emotionCurve,
          emotionVerifyResult,
          promiseRegistry,
          projectTheme,
          currentEpisodeId,
          writtenEpisodeIds,
          indexByEpisodeId: writtenEpisodes.indexById,
        });
      } catch (err) {
        logger.warn(
          { nodeId, err: err instanceof Error ? err.message : String(err) },
          'completeness-verify-node.run: L1 compute threw → degrade to empty candidates, continue to L2',
        );
        candidates = {
          arc: [],
          line: [],
          emotionArc: null,
          promise: [],
          theme: null,
          ...(currentEpisodeId ? { currentEpisodeId } : {}),
          writtenEpisodeIds,
          degraded: true,
          degradationNote: `L1 候选汇编异常：${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // ── 2b. Story 8.7 S9（design §2.4 编译面）：L1 出场间隔计数信号 ──
      // 调同一 buildAppearanceGapStats 单源纯函数（经 mention-query 组合面取数——出场账 mention 行优先
      // 〔提及也算露面〕，无账/窗缺退世界状态口径）。**纯计数不判意义（红线）**：只把「距本章开场 N」的
      // 机械事实（entryId/最后露面章/间隔/口径）并入 L1 candidates 输入——「该不该出场/是否被读者遗忘」
      // 归 L2 语义挣得裁判（假信心门红线，mirror deadlinePassed 机械事实喂法）。anchor = 本章开场
      // storyTime（resolveAnchorStoryTime 单源，与资料员弹药同锚）。graceful：anchor 缺 / 工具环境不可用 /
      // 零统计 → 不加 appearanceGaps 字段（二态字段纪律），链照常。
      const anchorStoryTime = resolveAnchorStoryTime(sceneGraph, currentEpisodeId);
      // spread 归一（CompletenessCandidateReport 是 interface——无隐式索引签名，直接赋 Record 不过 typecheck；
      // candidatesVar 序列化前无需区分原对象/扩展对象）。
      let candidatesVarObject: Record<string, unknown> = { ...candidates };
      if (anchorStoryTime !== undefined) {
        try {
          const gapFace = await fetchAppearanceGapStatsViaTools(run.projectPath, anchorStoryTime);
          if (gapFace.stats.length > 0) {
            candidatesVarObject = { ...candidates, appearanceGaps: gapFace.stats };
          } else if (gapFace.degradedReasons.length > 0) {
            // 数据源不可得如实标注（mirror L1 degraded 标注哲学——L2 知道「没查」而非「查了没有」）。
            candidatesVarObject = {
              ...candidates,
              appearanceGapNote: `出场间隔统计不可用：${gapFace.degradedReasons.join('；')}`,
            };
          }
        } catch (err) {
          logger.warn(
            { nodeId, err: err instanceof Error ? err.message : String(err) },
            'completeness-verify-node.run: appearance gap fetch threw → skip (candidates stand)',
          );
        }
      }

      // ── 3. L2：render prompt + generate + parse（复用 loadAgentPrompt + renderTemplate + extractJson）──
      const { system, userTemplate } = await loadAgentPrompt(role);
      const candidatesVar = JSON.stringify(candidatesVarObject);
      const writtenChaptersVar = renderWrittenChapters(episodeOutlines, writtenEpisodes);
      // Story 8.2 Req 4/AC6：arcSnapshot var（最近卷弧摘要折叠投影——synopsis + 支线段 + 遗留钩子，
      // write_chapter caller-fetch 注入 initialArtifacts['arc_snapshot']，mirror project_theme 模式）。
      // L2 浅雷达的长程视野：cross-arc 判「该推进的没推进」时对照卷级叙事语境（8.1 design §9「分弧/
      // 折叠快照 reader」预留的落地）。graceful：artifact 缺 → 空串（照常 per-chapter 浅审，零回归）。
      const arcSnapshotVar = scalarOf(run.artifacts['arc_snapshot']);
      const userPrompt = renderTemplate(userTemplate, {
        draftText,
        candidates: candidatesVar,
        writtenChapters: writtenChaptersVar,
        arcSnapshot: arcSnapshotVar,
      });
      const messages: SessionMessage[] = [
        { id: randomUUID(), role: 'user', content: userPrompt, createdAt: Date.now() },
      ];
      const abortSignal = signal ?? new AbortController().signal;

      // generate + retry（mirror createReaderAuditNode MAX_ATTEMPTS + error-feedback 重试语义）。
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          // 09-12 子2（H2）：fallbacks 透传（空链不占位）。
          // 09-12 usage-panel：taskType 透传（未标注不占位）。
          // 09-13 子2 W2b（思考流，design §1）：onDelta 随 opts 透传——每次尝试预分配轮 messageId
          //（mirror llm-node attemptMessageId：重试轮换 id，UI 侧按轮分段防重试混流）；tool 通道
          // 滤除（R2 #30 同款）。缺省不占位（非流式路径零回归）。
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
          const parsed = completenessVerifyResultSchema.parse(JSON.parse(extractJson(result.content)));
          return { stateKey: COMPLETENESS_VERIFY_RESULT_KEY, artifact: parsed };
        } catch (err) {
          if (isAbortError(err)) throw err; // 取消语义：传播，不吞成 fallback artifact
          lastErr = err;
          logger.warn(
            { nodeId, attempt, err: err instanceof Error ? err.message : String(err) },
            'completeness-verify-node.run: attempt failed',
          );
          // 重试时把 parse/校验错误回灌成 user 消息（mirror createReaderAuditNode :466-474 畸形 JSON 修复语义）。
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

      // AC6 fallback（mirror createReaderAuditNode :478-493 R6① 永不假 pass / 静默 fail）：
      // parse 失败 → findings=[] + degraded=true + summary 标注失败（Director 见空 findings + degraded 知失败，
      // 不静默 pass）。链段不崩。
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
      logger.error(
        { nodeId, message },
        'completeness-verify-node.run: all attempts failed → escalate fallback (AC6 永不假 pass)',
      );
      return {
        stateKey: COMPLETENESS_VERIFY_RESULT_KEY,
        artifact: {
          findings: [],
          summary: `创作完整性审核解析失败，需人工介入（${MAX_ATTEMPTS} 次尝试均失败：${message}）`,
          degraded: true,
          degradationNote: 'L2 parse 失败 fallback——candidate 缺漏未裁判，建议人工检查累积创作状态',
        },
      };
    },
  };
}
