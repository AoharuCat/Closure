// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子3 W2（design §2.3 / §3）：写章链节点目录单源表。
//
// mirror `CHAIN_NODE_ORDER`（chainStreamBuffer——agent 包 CHAPTER_CHAIN_NODE_IDS 的 UI 镜像）
// 23 节点：id → { i18nKey, icon, tier, segment }。对拍 gate（键集 === CHAIN_NODE_ORDER）在
// test/chainTimeline.test.ts 守门——agent 侧改链序 / 本表漏节点即红。
//
// 三档（四档模板的档位依据，design §3 归档表）：
// - writer：唯一——draft-writer（思考 phase 分层 + 调查工具行 + 宽幅正文流）。
// - analysis：LLM 节点（reasoning 开流 + 五 kind 产出卡）。
// - quick：纯代码节点 8 位（无思考层，单行摘要；brief-compiler 的 brief-card 紧凑展开）。
// ─────────────────────────────────────────────────────────────────────────────

export type ChainNodeTier = 'writer' | 'analysis' | 'quick';
export type ChainNodeSegment = 'plan' | 'loop' | 'extract';

export type ChainNodeCatalogEntry = {
  /** 节点名 i18n key（`chain.node.<id>`——W7 两 locale 落值）。 */
  i18nKey: string;
  /** material-symbols-outlined 图标名（W3 段结构 / 节点行渲染）。 */
  icon: string;
  tier: ChainNodeTier;
  segment: ChainNodeSegment;
};

/** 段序与段标题 i18n key（W3 段标题行 + 未跑灰预览 per nodeCatalog 序）。 */
export const CHAIN_NODE_SEGMENTS: ReadonlyArray<{ id: ChainNodeSegment; i18nKey: string }> = [
  { id: 'plan', i18nKey: 'chain.segment.plan' },
  { id: 'loop', i18nKey: 'chain.segment.loop' },
  { id: 'extract', i18nKey: 'chain.segment.extract' },
];

export const CHAIN_NODE_CATALOG: Record<string, ChainNodeCatalogEntry> = {
  // ── 规划环（plan）──
  'brief-compiler-node': { i18nKey: 'chain.node.brief-compiler-node', icon: 'checklist', tier: 'quick', segment: 'plan' },
  'brief-reviewer-node': { i18nKey: 'chain.node.brief-reviewer-node', icon: 'rate_review', tier: 'analysis', segment: 'plan' },
  // ── 自审环（loop，环体 7 节点）──
  'revision-optimizer-node': { i18nKey: 'chain.node.revision-optimizer-node', icon: 'tune', tier: 'analysis', segment: 'loop' },
  'draft-writer-agent': { i18nKey: 'chain.node.draft-writer-agent', icon: 'edit_note', tier: 'writer', segment: 'loop' },
  'revision-guard-agent': { i18nKey: 'chain.node.revision-guard-agent', icon: 'shield', tier: 'analysis', segment: 'loop' },
  'lint-node': { i18nKey: 'chain.node.lint-node', icon: 'mop', tier: 'quick', segment: 'loop' },
  'multi-review-agent': { i18nKey: 'chain.node.multi-review-agent', icon: 'fact_check', tier: 'analysis', segment: 'loop' },
  'completeness-verify-node': { i18nKey: 'chain.node.completeness-verify-node', icon: 'rule', tier: 'analysis', segment: 'loop' },
  'route-agent': { i18nKey: 'chain.node.route-agent', icon: 'alt_route', tier: 'analysis', segment: 'loop' },
  // ── 提取段（extract，E1-E10）──
  'world-extractor-physical': { i18nKey: 'chain.node.world-extractor-physical', icon: 'travel_explore', tier: 'analysis', segment: 'extract' },
  'world-extractor-cognitive': { i18nKey: 'chain.node.world-extractor-cognitive', icon: 'travel_explore', tier: 'analysis', segment: 'extract' },
  'world-extractor-emotional': { i18nKey: 'chain.node.world-extractor-emotional', icon: 'travel_explore', tier: 'analysis', segment: 'extract' },
  'world-extractor-relational': { i18nKey: 'chain.node.world-extractor-relational', icon: 'travel_explore', tier: 'analysis', segment: 'extract' },
  'world-extractor-factional': { i18nKey: 'chain.node.world-extractor-factional', icon: 'travel_explore', tier: 'analysis', segment: 'extract' },
  'world-merge-node': { i18nKey: 'chain.node.world-merge-node', icon: 'merge', tier: 'quick', segment: 'extract' },
  'emotion-verify-node': { i18nKey: 'chain.node.emotion-verify-node', icon: 'mood', tier: 'quick', segment: 'extract' },
  'promise-emergence-node': { i18nKey: 'chain.node.promise-emergence-node', icon: 'auto_awesome', tier: 'analysis', segment: 'extract' },
  'arc-emergence-node': { i18nKey: 'chain.node.arc-emergence-node', icon: 'show_chart', tier: 'analysis', segment: 'extract' },
  'chapter-summary-node': { i18nKey: 'chain.node.chapter-summary-node', icon: 'subject', tier: 'quick', segment: 'extract' },
  'storytime-drift-node': { i18nKey: 'chain.node.storytime-drift-node', icon: 'schedule', tier: 'quick', segment: 'extract' },
  'mention-ledger-node': { i18nKey: 'chain.node.mention-ledger-node', icon: 'group', tier: 'quick', segment: 'extract' },
  'story-sync-agent': { i18nKey: 'chain.node.story-sync-agent', icon: 'sync', tier: 'analysis', segment: 'extract' },
  'feedback-ledger-node': { i18nKey: 'chain.node.feedback-ledger-node', icon: 'history_edu', tier: 'quick', segment: 'extract' },
};

/** 目录查询（未知 nodeId → undefined——渲染层兜底机械去后缀名）。 */
export function nodeCatalogEntry(nodeId: string): ChainNodeCatalogEntry | undefined {
  return CHAIN_NODE_CATALOG[nodeId];
}
