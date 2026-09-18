import {
  episodeOutlinesSchema,
  resolvePromiseFulfillment,
  runEmotionVerify,
  type CharacterCardForEmotion,
  type EmotionCurve,
  type EmotionVerifyResult,
  type PayoffEvent,
  type PromiseBeat,
  type PromiseRegistry,
  type ReusableAgentNodeContract,
  type WorldPatch,
} from '@orison/shared-contracts';
import type { z } from 'zod';
import type { AgentNode, NodeResult, NodeRunInput } from '../contracts/run';
import { fetchWorldPatchesViaTool } from './world-state-query';
import { logger } from '../logger';

/** episode_outlines 条目（EpisodeOutline type 未显式导出，故本地 z.infer 推导，mirror brief-compiler-node）。 */
type EpisodeOutline = z.infer<(typeof episodeOutlinesSchema)>[number];

// ── Story 5.3 R2：emotion-verify-node（design §1-§3 / ADR-3 / AGENT-005）──
//
// chapter-chain 内事后 verify-loop **纯代码节点**（无 LLM generate，mirror world-state-merge 机械组装节点 /
// promise-emergence-node 段 1）。挂 `world-merge-node` 后、`promise-emergence-node` 前（design §3）：
// emotional extractor + merge 产实际情绪 patches（写 closure_world_state）→ 本节点消费（目标 + 实际 + payoff）→
// promise-emergence（读 world-state patches 登记 Promise）。emotion-verify 在 emergence 前确保 payoff 联动读到
// 的 promise_registry 是当前章截止态（emergence 本章登记的 payoff 同章不反向影响 setpoint，避循环，design §3）。
//
// 🔑 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md「EmotionArc」条）：本节点 = 纯代码机械组装——
// 取 4 数据源（emotion_curve / emotional patches / promise_registry / asset_cards）+ 调 runEmotionVerify 纯函数
// aggregator（setpoint 衰减 / topology / DTW / payoff 联动 / refId dedupe 全确定性数学，emotion-verify.ts）。
// **不裁判语义**：偏离后「重规划成什么」归 Director（7.3/8.1）；turning point 识别 / VAD 缺失语义距离归 LLM
// （5.4 Reader-Audit）。**正交于 6.x「对比归语义」**（5.3 DTW 是 VAD 形状统计指纹不裁判落地）。
//
// **不 rollup 选代表情绪**（5.2 硬约束，brief-compiler-node.ts:553-555）：per-scene points 直传 runEmotionVerify
// 做 DTW/衰减序列，不机械选章级代表情绪。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror world-merge-node / promise-emergence-node 先例——链段节点经
// createChapterChainNodes 装配，不进 agentContracts.ts CONTRACTS[]（orchestration-pattern.md 子 agent / 链段节点
// 不进 CONTRACTS[] 约定）。requiredArtifactKeys=[]（design §10 graceful：emotion_curve artifact 缺也不阻断链，
// runEmotionVerify 内部降级 degraded result）。
//
// expected_downstream_consumers:
// - Story 7.3/8.1：Director 重规划段读 emotion_verify_result.flags（偏离 flag 反哺下一轮 Director，5.3 产 flag
//   不实写重规划）。flag 经 write_chapter emotionVerifyFeedback var 透传（管道先建，cross-chapter 持久化 defer）。
// - Story 5.4：Reader-Audit 情绪维可选预筛信号（读 emotion_verify_result，场景情绪落地检查辅信号）。
// - Epic 3/10：ledger 统计指纹 → dashboard 可视化（滞后做）。

/** 节点产出 artifact key（链段，mirror route_decision 形态，非 creative field，不进 project.yaml）。 */
export const EMOTION_VERIFY_RESULT_KEY = 'emotion_verify_result';

const EMOTION_VERIFY_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'emotion-verify-node',
  displayName: 'Emotion Verify Node',
  inputSchemaName: 'emotionVerifyInput',
  outputSchemaName: 'emotionVerifyResult',
  // design §10 graceful：requiredArtifactKeys=[]——emotion_curve artifact 缺也不阻断链（runEmotionVerify
  // 内部降级 degraded result）。emotion_curve 由 assembleChapterChainArtifacts 总注入（至少空 default），
  // 但 bypass-assemble 直测路径可能缺；列 required 会致 chainRunner blocked（design §10「不阻断链」违）。
  // 消费源（读 run.artifacts / db 经 builtin）在 run() 内自行 graceful。
  requiredArtifactKeys: [],
  producedArtifactKeys: [EMOTION_VERIFY_RESULT_KEY],
  sideEffects: [],
};

// ════════════════════════════════════════════════════════════════════════════
// artifact shape 守卫（mirror brief-compiler-node isValidPromiseRegistry / world-merge artifactAsRecord）
// ════════════════════════════════════════════════════════════════════════════

/** 轻量 promise_registry 形态守卫（mirror brief-compiler-node isValidPromiseRegistry）。 */
function isValidPromiseRegistry(v: unknown): v is PromiseRegistry {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as { promises?: unknown; beats?: unknown };
  return Array.isArray(r.promises) && Array.isArray(r.beats);
}

/**
 * 从 chapter_brief_input artifact 解析 episodeId（mirror world-extractor-node / promise-emergence-node）。
 * 用于 payoff deadline 判定（deadlineEpisodeId < currentEpisodeId index → 未兑现）。
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
 * 安全取 emotion_curve artifact（过滤非对象/数组，runEmotionVerify 内 safeParse 容错，此处只挡 gross misshape）。
 * assemble 总注入合法 EmotionCurve（safeParse 降级空 curve）；bypass 路径可能缺/坏 → undefined（runEmotionVerify 降级）。
 */
function readEmotionCurve(raw: unknown): EmotionCurve | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as { points?: unknown };
  if (!Array.isArray(c.points)) return undefined;
  return raw as EmotionCurve;
}

// ════════════════════════════════════════════════════════════════════════════
// payoff 事件派生（AGENT-005 2.4，纯代码，design §2.1）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 判 promise.deadlineEpisodeId 是否已过（预期 payoff 未现 → 未兑现 setpoint 压低信号）。
 *
 * 纯代码机械比对（episode index 排序），非语义：
 * - deadlineEpisodeId 缺 → 无 deadline 概念 → false（不判未兑现）。
 * - deadlineEpisodeId === currentEpisodeId → deadline 是本章（本章尚在写，payoff 仍可能现）→ false（未过）。
 * - episodeOutlines 缺 → 无 index 排序无法判前后 → false（graceful，不造假「已过」）。
 * - deadlineIdx < currentIdx → deadline 在前章且仍 open → true（已过，未兑现）。
 * - deadlineIdx >= currentIdx → deadline 在后章 → false（未到）。
 *
 * @param deadlineEpisodeId  promise 逾期 episode id（NeuroBook deadlineChapterId 概念）。
 * @param currentEpisodeId   本章 episode id（resolveEpisodeId 从 chapter_brief_input 抽）。
 * @param episodeOutlines    episode 索引表（提供 index 排序；缺 → 无法判前后）。
 */
function isDeadlinePassed(
  deadlineEpisodeId: string | undefined,
  currentEpisodeId: string | undefined,
  episodeOutlines: readonly EpisodeOutline[],
): boolean {
  if (!deadlineEpisodeId || !currentEpisodeId) return false;
  if (deadlineEpisodeId === currentEpisodeId) return false; // 本章尚在写，payoff 仍可能现
  if (episodeOutlines.length === 0) return false; // 无 index 排序 → graceful 不判
  const idxById = new Map<string, number>();
  for (const ep of episodeOutlines) idxById.set(ep.id, ep.index);
  const deadlineIdx = idxById.get(deadlineEpisodeId);
  const currentIdx = idxById.get(currentEpisodeId);
  if (deadlineIdx === undefined || currentIdx === undefined) return false; // id 不在表内 → graceful
  return deadlineIdx < currentIdx;
}

/**
 * 从 promise_registry 派生 payoff 事件（caller 组装 runEmotionVerify 输入，design §2.1 / AGENT-005 2.4）。
 *
 * 纯代码（resolvePromiseFulfillment 派生 + index 比对，非语义）：
 * - fulfilled（resolvePromiseFulfillment 返 'fulfilled'，有有效 payoff beat）→ { fulfilled: true }（setpoint 上调信号）。
 * - open + deadlineEpisodeId 已过（isDeadlinePassed）→ { fulfilled: false }（setpoint 压低信号，创伤）。
 * - 其他（open + 未到 deadline / abandoned / 无 deadline）→ 不产事件（setpoint 不变）。
 *
 * abandoned 是作者意图终态（resolvePromiseFulfillment 返 'abandoned'）→ 不计 payoff（既非兑现也非未兑现创伤）。
 * autoFulfill=false 的 promise（resolvePromiseFulfillment 返原 status）→ 按 status 判（fulfilled/open 同上）。
 *
 * 🔑 **本章截止态**（design §3）：emotion-verify 在 promise-emergence 前，读的 promise_registry artifact 是
 * assemble 在 chain 启动前从 project.yaml 拍的快照（前章累积 beats），本章 emergence 登记的 payoff 同章不进
 * 此快照（避循环：本章 payoff 不反向抬 setpoint 影响本章 verify）。
 *
 * @param promiseRegistry   promise_registry artifact（assemble safeParse 注入，形状可信；bypass 路径防御）。
 * @param currentEpisodeId  本章 episode id（deadline 判定用）；undefined → 仅兑现判定，不判未兑现。
 * @param episodeOutlines   episode 索引表（deadline 前后判定用）；空 → 仅兑现判定。
 * @returns                 PayoffEvent[]（兑现 + 过期未兑现；空 = 无 payoff 信号，setpoint 不变）。
 */
export function derivePayoffEvents(
  promiseRegistry: PromiseRegistry | undefined,
  currentEpisodeId: string | undefined,
  episodeOutlines: readonly EpisodeOutline[],
): PayoffEvent[] {
  if (!promiseRegistry || promiseRegistry.promises.length === 0) return [];
  const events: PayoffEvent[] = [];
  const beats: readonly PromiseBeat[] = promiseRegistry.beats;
  for (const promise of promiseRegistry.promises) {
    const status = resolvePromiseFulfillment(promise, beats);
    if (status === 'fulfilled') {
      events.push({ fulfilled: true });
    } else if (status === 'open') {
      // open + deadline 已过 → 预期 payoff 未现 → 未兑现（创伤信号）。
      if (isDeadlinePassed(promise.deadlineEpisodeId, currentEpisodeId, episodeOutlines)) {
        events.push({ fulfilled: false });
      }
    }
    // abandoned / open-未到-deadline → 不产事件（setpoint 不变）。
  }
  return events;
}

// ════════════════════════════════════════════════════════════════════════════
// 角色卡抽取（emotionElasticity 消费源，design §4）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 从 asset_cards artifact 抽 character 卡子集（id + personality.emotionElasticity，computeSetpoint 消费）。
 *
 * asset_cards 由 write_chapter post-assemble 注入 initialArtifacts['asset_cards']（mirror world_state_snapshot
 * optional artifact 注入模式）。shell IPC 路径未注入 → undefined → runEmotionVerify 用默认 τ（graceful，
 * design §10）。只读 character 卡（type='character'），其余类型跳过（emotionElasticity 只挂角色卡 personality）。
 *
 * 结构上兼容 CharacterCardForEmotion（{id, personality?{emotionElasticity?}}）——完整角色卡是超集，直传即可。
 * 坏条目（非对象 / 缺 id / personality 非 object）跳过（不抛，mirror CR-4.1-07 坏条目单独丢哲学）。
 *
 * @param assetCardsRaw  asset_cards artifact（write_chapter 注入；undefined/非数组 → 空数组，runEmotionVerify 用默认 τ）。
 * @returns              CharacterCardForEmotion[]（character 卡子集；空 = 无角色卡，computeSetpoint 全用默认 τ）。
 */
export function extractCharacterCards(assetCardsRaw: unknown): CharacterCardForEmotion[] {
  if (!Array.isArray(assetCardsRaw)) return [];
  const cards: CharacterCardForEmotion[] = [];
  for (const card of assetCardsRaw) {
    if (!card || typeof card !== 'object') continue;
    const c = card as { type?: unknown; id?: unknown; personality?: unknown };
    if (c.type !== 'character') continue;
    if (typeof c.id !== 'string' || c.id.length === 0) continue;
    // personality 非对象（含 null/undefined）→ 不带 personality（computeSetpoint 视为 elasticity 缺失，用默认 τ）。
    if (c.personality && typeof c.personality === 'object' && !Array.isArray(c.personality)) {
      cards.push({ id: c.id, personality: c.personality as CharacterCardForEmotion['personality'] });
    } else {
      cards.push({ id: c.id });
    }
  }
  return cards;
}

// ════════════════════════════════════════════════════════════════════════════
// emotion-verify-node 节点（纯代码：取 4 源 + 调 runEmotionVerify aggregator）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 构造 emotion-verify 节点（纯代码，无 LLM generate，design §1-§3）。
 *
 * run 流程：
 *  1. 读 `emotion_curve` artifact（Director 产目标弧，assembleChapterChainArtifacts 注入）→ readEmotionCurve 守卫。
 *  2. 解析 `currentEpisodeId`（从 chapter_brief_input，mirror world-extractor / promise-emergence）——提前到 fetch
 *     前：fetch 取跨章全集后需按本章 sliceId prefix filter（step 3）。
 *  3. 读 emotional patches（6.6 写后抽取）via fetchWorldPatchesViaTool（query_world_slice builtin，mirror
 *     promise-emergence / brief-compiler stateAtT 取 patches）。工具未注册 / IPC 失败 / 无数据 → undefined
 *     （DTW 跳过，runEmotionVerify 降级，不崩）。**只读不写**——fetch 取**跨章**全集 patches（含 emotional 轴，
 *     fetchWorldPatchesViaTool 无过滤，promise-emergence / brief-compiler 也依赖全集，不改共用函数），本端 filter
 *     本章（sliceId prefix `${currentEpisodeId}:`，6.6 稳定 slice.id 约定 world-state-merge.ts:160）+ runEmotionVerify
 *     内部 filter axis='emotional'。🔑 **本章 filter 必要（design §2.1 章级偏离指纹）**：DTW 比对 本章
 *     emotion_curve（本章目标 per-scene）vs actual patches——actual 必须限本章，否则跨章 actual vs 本章 target =
 *     多章项目语义错位（DTW 距离无意义）。currentEpisodeId 缺 → 不 filter（graceful，全集 = 本章集，单章/首章/测试 OK）。
 *  4. 读 `promise_registry` artifact（assemble 注入）→ isValidPromiseRegistry 守卫 + derivePayoffEvents 派生
 *     payoff 事件（resolvePromiseFulfillment + deadline index 比对）。
 *  5. 读 `asset_cards` artifact（write_chapter post-assemble 注入；IPC 路径可能缺）→ extractCharacterCards
 *     抽 character 卡 emotionElasticity。
 *  6. 调 runEmotionVerify({emotionCurve, emotionalPatches, payoffEvents, characterCards}) → EmotionVerifyResult。
 *  7. 产 `emotion_verify_result` artifact（链段，mirror route_decision 形态，不进 project.yaml）。
 *
 * graceful（design §10 / mirror promise-emergence-node CR-E3）：任一数据源缺/坏 → 降级（degraded result /
 * 跳过该源），**不抛、不阻断链**。emotion-verify 是增强非硬约束——失败只意味着本章无 verify 指纹，链段照跑
 * （draft / review / route 等硬约束节点不受影响）。runEmotionVerify 自身 graceful（emotion_curve 空 → degraded
 * result）；本节点 additional try/catch 兜底 fetch / derive 抛错（defensive，违注释承诺「不崩链」）。
 *
 * 范式判据：取 4 源 + 调纯函数 aggregator = 纯代码机械（无 LLM/无 db 写/无副作用）。fetch = 副作用（IPC 读 db）
 * 但只读；setpoint/topology/DTW/payoff 数学全在 runEmotionVerify 纯函数（ADR-3 确定性计算归纯代码）。
 */
export function createEmotionVerifyNode(): AgentNode {
  return {
    contract: EMOTION_VERIFY_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // ── 1. emotion_curve artifact（目标轨，Director 产）──
      const emotionCurve = readEmotionCurve(run.artifacts['emotion_curve']);

      // ── 2. currentEpisodeId（本章 episode，mirror world-extractor / promise-emergence）──
      // 提前到 fetch 前：fetch 取跨章全集后需按本章 sliceId prefix filter（见 step 3），graceful 缺 → 不 filter。
      const currentEpisodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);

      // ── 3. emotional patches（实际轨，6.6 写后抽取，经 db builtin 读 + 本章 filter）──
      // mirror promise-emergence fetchWorldPatchesViaTool（query_world_slice 取全集 patches）。工具未注册（测试
      // 环境 registry 空）/ IPC 失败 / 无数据 → undefined（runEmotionVerify 跳过 DTW，降级，不崩）。
      // 不改 6.6 提取器（design §1 零回归，消费侧读）。
      //
      // 🔑 **本章 filter 必要（design §2.1 章级偏离指纹）**：fetchWorldPatchesViaTool 取**跨章**全集（无
      // subjectIds/type/at 过滤，promise-emergence / brief-compiler 也依赖全集，不改共用函数）。DTW 在本端
      // emotion_curve（本章 Director 产的目标 per-scene）vs actual patches 比对——actual 必须限本章，否则
      // 跨章 actual vs 本章 target = 多章项目语义错位（DTW 距离无意义）。filter 用 6.6 稳定 slice.id 约定
      // `${episodeId}:${storyTime}`（world-state-merge.ts:160 / world-extractor-node.ts:47）的 prefix
      // `${currentEpisodeId}:`。currentEpisodeId 缺（chapter_brief_input 无 episodeId：单章项目 / 首章 / 测试
      // 环境）→ 不 filter（graceful，全集 = 本章集，DTW 正常）。
      let emotionalPatches: readonly WorldPatch[] | undefined;
      try {
        const allPatches = await fetchWorldPatchesViaTool(run.projectPath);
        if (allPatches && currentEpisodeId) {
          const prefix = `${currentEpisodeId}:`;
          emotionalPatches = allPatches.filter((p) => p.sliceId.startsWith(prefix));
        } else {
          // currentEpisodeId 缺 → 不 filter（全集，单章/首章/测试 graceful）；allPatches undefined → 透传 undefined。
          emotionalPatches = allPatches;
        }
      } catch (err) {
        logger.warn(
          { projectPath: run.projectPath, err: err instanceof Error ? err.message : String(err) },
          'emotion-verify-node: fetchWorldPatchesViaTool threw → graceful undefined (DTW skipped)',
        );
      }

      // ── 4. promise_registry artifact → payoff 事件（deadline 判定需 episodeId + episodeOutlines）──
      const promiseRegistry = isValidPromiseRegistry(run.artifacts['promise_registry'])
        ? run.artifacts['promise_registry']
        : undefined;
      const episodeOutlines = Array.isArray(run.artifacts['episode_outlines'])
        ? (run.artifacts['episode_outlines'] as EpisodeOutline[])
        : [];
      let payoffEvents: PayoffEvent[] = [];
      try {
        payoffEvents = derivePayoffEvents(promiseRegistry, currentEpisodeId, episodeOutlines);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'emotion-verify-node: derivePayoffEvents threw → graceful empty payoff (setpoint 不变)',
        );
      }

      // ── 5. asset_cards artifact → character 卡 emotionElasticity ──
      // write_chapter post-assemble 注入（mirror world_state_snapshot optional 注入）；shell IPC 路径未注入 →
      // 空数组 → runEmotionVerify computeSetpoint 全用默认 τ（graceful，design §4/§10）。
      const characterCards = extractCharacterCards(run.artifacts['asset_cards']);

      // ── 6. 调 runEmotionVerify 纯函数 aggregator（design §1-§3，全确定性数学）──
      let result: EmotionVerifyResult;
      try {
        result = runEmotionVerify({
          emotionCurve,
          emotionalPatches,
          payoffEvents,
          characterCards,
        });
      } catch (err) {
        // defensive：runEmotionVerify 自身 graceful 不抛，但违「不崩链」承诺须兜底（mirror fetchCognitionSnapshotViaTool
        // try/catch 哲学）。降级最小 result（degraded=true），链段照跑。
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'emotion-verify-node: runEmotionVerify threw → graceful degraded result (chain continues)',
        );
        result = {
          flags: [],
          characterArcs: [],
          readerTopology: { directions: [], maxConsecutiveRise: 0, maxConsecutiveFlat: 0, degraded: true },
          adjustedSetpoints: [],
          degraded: true,
          degradationNote: `runEmotionVerify 内部异常：${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // ── 7. 产 emotion_verify_result artifact（链段，非 creative field，不进 project.yaml）──
      return { stateKey: EMOTION_VERIFY_RESULT_KEY, artifact: result };
    },
  };
}

// 重新导出 runEmotionVerify + derivePayoffEvents 便利（测试 + 未来 ledger/dashboard 消费共用同形态单源）。
export { runEmotionVerify };
