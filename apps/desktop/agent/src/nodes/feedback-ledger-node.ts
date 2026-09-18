import type { ReusableAgentNodeContract, FeedbackArtifactKey } from '@orison/shared-contracts';
import { FEEDBACK_LEDGER_ARTIFACT_KEYS } from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput } from '../contracts/run';
import { registry } from '../tool/registry';
import { logger } from '../logger';

// ── Story 7.4 cross-chapter feedback ledger 节点（design §2.2 / ADR-3）──
//
// chapter-chain 链尾**纯代码节点**（无 LLM generate，mirror storySync / emotion-verify-node 机械节点）。
// 挂 completeness-verify-node 后（idx16，revision 闭环外，跑一次不参与改稿重跑）。读 run.artifacts 三 key
// （review.latest / emotion_verify_result / completeness_verify_result）→ 经 feedback_ledger_write builtin 写
// closure_feedback_ledger 表（per-episode per-artifact upsert）。
//
// **为什么不放 workflow.ts complete 回调**：RunSnapshotSummary 经 summarizeRunSnapshot（chainRunner.ts）
// context isolation 裁剪——只抽 reviewVerdict/escalateFindings/draftText，完整 review.latest /
// emotion_verify_result / completeness_verify_result 不回传 leader（设计意图）。故 leader 侧拿不到完整 artifact
// 写 ledger。chain 内节点天然持 run.artifacts 完整对象（同 storySync 节点读 draft），经 toolHandler 写 ledger
// 最干净（design §2.2）。
//
// 🔑 范式判据（ADR-3）：本节点 = 纯代码机械中转（读 artifact → serialize → 写 db），无 LLM / 无语义判断。
// ledger 读写是确定性记账，不裁判意义。
//
// graceful（mirror emotion-verify-node / promise-emergence-node CR-E3 增强非硬约束哲学）：
// - 三 artifact 任一缺（falsy 守卫：pause/abort/escalate 早停时三 artifact 不全）→ 跳过该 key 不崩。
// - episodeId 缺（chapter_brief_input 无 episodeId：测试环境 / bypass 路径）→ 跳过全部写入（warn）。
// - feedback_ledger_write 工具未注册（测试环境 registry 空）→ 跳过写入（warn）。
// - 工具调用失败 → warn 不阻断链（feedback ledger 是增强，mirror 6.6 world-state 增强哲学）。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror storySync / emotion-verify-node / promise-emergence-node 先例
// ——链段节点经 createChapterChainNodes 装配，不进 agentContracts.ts CONTRACTS[]（orchestration-pattern.md
// 子 agent / 链段节点不进 CONTRACTS[] 约定）。
//
// expected_downstream_consumers:
// - Story 7.4 Step 2：write_chapter chain-start（dispatchDirectorAndAuthorInfoRelease）读上一章 ledger 填
//   Director feedback var（auditFindings / emotionVerifyFeedback / completenessFeedback），激活 5.3/4.4/7.3 三段。

/** 节点产出 artifact key（链段 pass-through，mirror story.sync 非下游消费的 summary key）。 */
const FEEDBACK_LEDGER_NODE_KEY = 'feedback_ledger';

/**
 * 节点 id 单源——chapter-chain 链装配（CHAPTER_CHAIN_NODE_IDS + 装配行）与 workflow reExtractChapter
 * 的 standalone 过滤（链外重提取不产环终态输入，剔除该节点）两侧共用，防字面量漂移。
 */
export const FEEDBACK_LEDGER_NODE_ID = 'feedback-ledger-node' as const;

const FEEDBACK_LEDGER_CONTRACT: ReusableAgentNodeContract = {
  nodeId: FEEDBACK_LEDGER_NODE_ID,
  displayName: 'Feedback Ledger Node',
  inputSchemaName: 'feedbackLedgerInput',
  outputSchemaName: 'feedbackLedgerOutput',
  // graceful：requiredArtifactKeys=[]——三 artifact 任一缺也不阻断链（falsy 守卫跳过该 key）。
  // pause/abort/escalate 早停时 artifact 不全，列 required 会致 chainRunner blocked。
  requiredArtifactKeys: [],
  producedArtifactKeys: [FEEDBACK_LEDGER_NODE_KEY],
  sideEffects: ['persist_artifact'],
};

/**
 * 从 chapter_brief_input artifact 解析 episodeId（mirror emotion-verify-node resolveEpisodeId /
 * promise-emergence-node）。用于把 ledger 记录关联到本章 episode（Director 下一章读上一章）。
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
 * 判 artifact 是否为可序列化对象（非 null/undefined/原始值/数组——payload 契约是 plain object）。
 * feedbackLedgerPayloadSchema = z.record(z.unknown()) 的 gross-shape 预检（serialize 前防腐）。
 */
function isSerializableObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 构造 feedback-ledger 节点（纯代码，无 LLM generate，design §2.2）。
 *
 * run 流程：
 *  1. 解析 episodeId（从 chapter_brief_input，mirror emotion-verify / promise-emergence）。
 *  2. episodeId 缺 → 跳过全部写入 + warn（ledger 记录须关联 episode，无 episode 无法写）。
 *  3. 遍历 FEEDBACK_LEDGER_ARTIFACT_KEYS：读 run.artifacts[key]，falsy / 非对象 → 跳过（falsy 守卫）。
 *  4. 调 registry.get('feedback_ledger_write') 写 ledger（per-key，serialize 在 handler 侧 repository）。
 *  5. 产 feedback_ledger summary artifact（pass-through，非下游消费的 summary，mirror story.sync）。
 *
 * graceful：工具未注册 / 单 key 调用失败 → warn 继续（不阻断链，不丢其他 key）。
 */
export function createFeedbackLedgerNode(): AgentNode {
  return {
    contract: FEEDBACK_LEDGER_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // ── 1. episodeId（本章 episode，mirror emotion-verify / promise-emergence）──
      const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
      if (!episodeId) {
        logger.warn(
          { projectPath: run.projectPath },
          'feedback-ledger-node: episodeId missing → skip all writes (ledger requires episode association)',
        );
        return {
          stateKey: FEEDBACK_LEDGER_NODE_KEY,
          artifact: { runId: run.runId, episodeId: null, written: [], summary: 'skip: no episodeId' },
        };
      }

      // ── 2. feedback_ledger_write 工具可用性 ──
      const writeTool = registry.get('feedback_ledger_write');
      if (!writeTool) {
        // 测试环境 registry 空 / 未 registerBuiltinTools → 跳过写入（mirror fetchWorldPatchesViaTool graceful）。
        logger.warn(
          { episodeId },
          'feedback-ledger-node: feedback_ledger_write tool not registered → skip writes (chain continues)',
        );
        return {
          stateKey: FEEDBACK_LEDGER_NODE_KEY,
          artifact: { runId: run.runId, episodeId, written: [], summary: 'skip: tool not registered' },
        };
      }

      // ── 3. 遍历三 key，falsy 守卫 + 逐 key 写 ledger ──
      const written: FeedbackArtifactKey[] = [];
      for (const artifactKey of FEEDBACK_LEDGER_ARTIFACT_KEYS) {
        const artifact = run.artifacts[artifactKey];
        // falsy 守卫：pause/abort/escalate 早停时三 artifact 不全，缺则跳过该 key（不崩、不造假）。
        if (!isSerializableObject(artifact)) {
          continue;
        }
        try {
          await writeTool.execute(
            { episodeId, artifactKey, payload: artifact },
            {
              projectPath: run.projectPath,
              // 节点无 sessionId（chain node 不持 session 引用），传空串 placeholder（handler 不读 sessionId，
              // mirror fetchWorldPatchesViaTool / world-merge-node writeWorldEvents）。
              sessionId: '',
              abort: new AbortController().signal,
            },
          );
          written.push(artifactKey);
        } catch (err) {
          // 单 key 写入失败 → warn 继续（不丢其他 key，不阻断链，mirror 增强非硬约束哲学）。
          logger.warn(
            {
              episodeId,
              artifactKey,
              err: err instanceof Error ? err.message : String(err),
            },
            'feedback-ledger-node: feedback_ledger_write failed → skip this key (chain continues)',
          );
        }
      }

      // ── 4. 产 summary artifact（pass-through，非下游消费，mirror story.sync）──
      return {
        stateKey: FEEDBACK_LEDGER_NODE_KEY,
        artifact: {
          runId: run.runId,
          episodeId,
          written,
          summary: `${written.length}/${FEEDBACK_LEDGER_ARTIFACT_KEYS.length} artifacts persisted to feedback ledger`,
        },
      };
    },
  };
}
