import type { AgentContract } from '@orison/shared-contracts';
import { getAgentContract } from './agentContracts';

interface NodeRegistryEntry {
  id: string;
  config: {
    outputs: { stateKey: string; artifactType: string };
    inputs: { fromState: string[] };
  };
  contract: AgentContract | null;
}

/**
 * Legacy DEFAULT_CHAIN / EXTENDED_CHAIN 的 stateKey 映射（OrisonSpace dormant 骨架）。
 *
 * ⚠️ 链段（chapter-chain，Story 4.0）**不用本 map**——链段节点用 `ReusableAgentNodeContract.
 * producedArtifactKeys`（节点契约，单源真值）。本 map 仅服务于 `createNodeRegistry` /
 * `createExtendedNodeRegistry`（dormant DEFAULT_CHAIN，仅 registryContractMatch.test.ts 消费）。
 *
 * CR-3 ADR-4 drift 注记：链段（chapter-chain，Story 4.0）**不用本 map**——链段节点用
 * `ReusableAgentNodeContract.producedArtifactKeys`（节点契约，单源真值）。本 map 仅服务于
 * `createNodeRegistry` / `createExtendedNodeRegistry`（dormant DEFAULT_CHAIN，仅
 * registryContractMatch.test.ts 消费）。
 *
 * 链流程重排（09-13 W1d）迁移注记：'targeted-revision-agent' → 'revision.output' 条目已删——
 * 节点从生产链退役（职能被环内 C1 编译 + 写手 directive 重跑覆盖；DEFAULT_CHAIN /
 * EXTENDED_CHAIN 本就不含该 id，条目无消费者）。CR-25（09-13 CR 修复批）：prompts yaml /
 * tool wrapper / UI 词表 / i18n / 单测 + dormant 工厂 createTargetedRevisionNode +
 * agentContracts 条目已全量清除（grep 零代码残留）。summarizeRunSnapshot 的 revision.output
 * 死 fallback 已删（chainRunner.ts，CR-3）。
 */
const STATE_KEY_MAP: Record<string, string> = {
  'intake-agent': 'creative_brief',
  'asset-loader-agent': 'assets.projectContext',
  'story-planner-agent': 'planning.storyPlan',
  'episode-planner-agent': 'episode_outlines',
  'chapter-task-agent': 'chapter_tasks',
  // Story 8.4（A2/A9 agent 化）：draft-writer 升级为节点内两阶段 agent 循环（writer-node.ts），主产物
  // stateKey 不变（'draft.initial'）；自查副产物 research_brief 经节点契约 producedArtifactKeys 声明
  // （ReusableAgentNodeContract 层，chapter-nodes.ts DRAFT_WRITER_CONTRACT），不进本 legacy map。
  'draft-writer-agent': 'draft.initial',
  'continuity-memory-agent': 'memory.continuity',
  'multi-review-agent': 'review.latest',
  // Story 4.0 Step 5：route-agent 反馈路由节点产 route_decision（链段临时 artifact，ADR-4 双重表示同步）。
  'route-agent': 'route_decision',
};

const DEFAULT_CHAIN = [
  'intake-agent',
  'asset-loader-agent',
  'story-planner-agent',
  'chapter-task-agent',
  'draft-writer-agent',
  'continuity-memory-agent',
  'multi-review-agent',
];

const EXTENDED_CHAIN = [
  'intake-agent',
  'asset-loader-agent',
  'story-planner-agent',
  'episode-planner-agent',
  'chapter-task-agent',
  'draft-writer-agent',
  'continuity-memory-agent',
  'multi-review-agent',
];

function buildEntry(id: string): NodeRegistryEntry {
  const contract = getAgentContract(id) ?? null;
  return {
    id,
    config: {
      outputs: { stateKey: STATE_KEY_MAP[id] ?? id, artifactType: id },
      inputs: { fromState: contract?.reads ?? [] },
    },
    contract,
  };
}

export function createNodeRegistry(): NodeRegistryEntry[] {
  return DEFAULT_CHAIN.map(buildEntry);
}

export function createExtendedNodeRegistry(): NodeRegistryEntry[] {
  return EXTENDED_CHAIN.map(buildEntry);
}
