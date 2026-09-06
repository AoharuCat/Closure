/**
 * 手艺页纯视图 helpers（E10.2b W5，design §3 三视图）——零 React 零 IPC，可直测。
 *
 * - **置信三档 chip**（用户 2026-09-05 mockup 修订拍板）：LLM 置信不显示原始小数（假精确
 *   ——LLM 不可能用统一标准生成小数），只显示低/中/高三档；**分界 0.5/0.8 是临时常量**
 *   （W6 校准后定，design §3 注记）；原值进 tooltip（不丢信息）。
 * - **相似度保留原值**（merge review 的 similarity 是纯代码 embedding 余弦测量值——与
 *   LLM 自报置信性质不同，非假精确）。
 * - 队列 = 需人审注意的卡（pending_review / 分歧 / 讲法 stale）+ 并排任务排前 + 置信
 *   低排前（R5 人审负担控制——「低置信/有重复候选/有分歧排前」）。
 * - 蒸馏徽章 = 台账（distill-status 源）+ progress 事件（运行中相位/耗时）合成（事件
 *   新于台账拉取时以事件为准；事件 best-effort 可丢——读侧兜底归 slice 打开 force）。
 *   done 态携带台账 stats 全量 + error note（tooltip「落库可见」，CR-2b-10）。
 */
import type {
  CraftCardCategory,
  CraftCardStatus,
  CraftCardSummary,
  CraftDistillLedger,
  CraftDistillPhase,
  CraftDistillProgressEvent,
  CraftDistillStats,
  CraftMergeReview,
  CraftTerm,
} from '@orison/shared-contracts';

// ── 置信三档（临时常量——W6 校准后修订，勿内联字面量）──

/** 置信 < 0.5 → 低档（W6 校准注记：mockup 拍板的临时分界，真实语料校准后定）。 */
export const CRAFT_CONFIDENCE_LOW_MAX = 0.5;
/** 置信 < 0.8 → 中档（同上——W6 校准）。 */
export const CRAFT_CONFIDENCE_MID_MAX = 0.8;

export type CraftConfidenceTier = 'low' | 'mid' | 'high';

export function craftConfidenceTier(confidence: number): CraftConfidenceTier {
  if (confidence < CRAFT_CONFIDENCE_LOW_MAX) return 'low';
  if (confidence < CRAFT_CONFIDENCE_MID_MAX) return 'mid';
  return 'high';
}

// ── 客户端过滤（全量卡一次装载，tab/tag/material 过滤零重拉）──

export type CraftCardClientFilter = {
  status?: CraftCardStatus;
  /** 自由标签 OR 过滤（任一命中——R10 chips 点击过滤）。 */
  tags?: string[];
  /** 来源材料过滤（N 卡跳转 / 按材料分批）。 */
  materialId?: string;
};

export function filterCraftCards(
  cards: readonly CraftCardSummary[],
  filter: CraftCardClientFilter,
): CraftCardSummary[] {
  const tags = filter.tags && filter.tags.length > 0 ? filter.tags : null;
  return cards.filter((c) => {
    if (filter.status !== undefined && c.status !== filter.status) return false;
    if (filter.materialId !== undefined && !c.materialIds.includes(filter.materialId)) return false;
    if (tags !== null && !c.tags.some((t) => tags.includes(t))) return false;
    return true;
  });
}

/** 并排待决任务过滤（同 tag/material 语义——newClaim 侧字段）。 */
export function filterCraftMergeReviews(
  reviews: readonly CraftMergeReview[],
  filter: CraftCardClientFilter,
): CraftMergeReview[] {
  const tags = filter.tags && filter.tags.length > 0 ? filter.tags : null;
  return reviews.filter((r) => {
    if (r.resolution !== null) return false;
    if (filter.materialId !== undefined && r.newClaim.materialId !== filter.materialId) return false;
    if (tags !== null && !r.newClaim.tags.some((t) => tags.includes(t))) return false;
    return true;
  });
}

// ── 待阅队列（排序 + 按材料分组）──

/**
 * 队列排序比较器（R5「低置信/有重复候选/有分歧排前」）：
 * 有待决并排任务 > 分歧 > 置信升序（低置信省力先审）> 最近更新。
 */
export function craftQueueCards(
  cards: readonly CraftCardSummary[],
  pendingReviews: readonly CraftMergeReview[],
): CraftCardSummary[] {
  const reviewCardIds = new Set(pendingReviews.map((r) => r.existingCardId));
  return cards
    .filter((c) => c.status === 'pending_review' || c.dispute || c.staleTeachingCount > 0)
    .sort((a, b) => {
      const aReview = reviewCardIds.has(a.cardId) ? 1 : 0;
      const bReview = reviewCardIds.has(b.cardId) ? 1 : 0;
      if (aReview !== bReview) return bReview - aReview;
      if (a.dispute !== b.dispute) return a.dispute ? -1 : 1;
      if (a.confidence !== b.confidence) return a.confidence - b.confidence;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

/** 按材料分批分组（R5 按文档分批——卡出现在其每个来源材料组；无来源 → 未关联组末位）。 */
export type CraftCardGroup = { materialId: string | null; cards: CraftCardSummary[] };

export function groupCraftCardsByMaterial(
  cards: readonly CraftCardSummary[],
): CraftCardGroup[] {
  const groups = new Map<string | null, CraftCardSummary[]>();
  for (const card of cards) {
    const keys: Array<string | null> = card.materialIds.length > 0 ? card.materialIds : [null];
    for (const key of keys) {
      const bucket = groups.get(key);
      if (bucket !== undefined) bucket.push(card);
      else groups.set(key, [card]);
    }
  }
  // 组序 = 首次出现序（入参已按队列优先级排好——最高优先级卡的材料组先呈现）；
  // 未关联材料组（null）恒末位。
  const ordered: CraftCardGroup[] = [];
  let unlinked: CraftCardGroup | null = null;
  for (const [materialId, bucket] of groups) {
    if (materialId === null) unlinked = { materialId: null, cards: bucket };
    else ordered.push({ materialId, cards: bucket });
  }
  if (unlinked !== null) ordered.push(unlinked);
  return ordered;
}

// ── 统计头（card-list 聚合——省的面：单一装载零额外 IPC）──

export type CraftStats = {
  pending: number;
  verified: number;
  rejected: number;
  pendingTerms: number;
  dispute: number;
};

export function craftStats(cards: readonly CraftCardSummary[], terms: readonly CraftTerm[]): CraftStats {
  let pending = 0;
  let verified = 0;
  let rejected = 0;
  let dispute = 0;
  for (const c of cards) {
    if (c.status === 'pending_review') pending += 1;
    else if (c.status === 'verified') verified += 1;
    else if (c.status === 'rejected') rejected += 1;
    if (c.dispute) dispute += 1;
  }
  return { pending, verified, rejected, dispute, pendingTerms: terms.filter((t) => t.status === 'pending').length };
}

// ── 蒸馏徽章（材料页联动 + 手艺页运行条共用——distill-status 源 + progress 事件新鲜度覆盖）──

export type CraftDistillBadge =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'running'; phase: CraftDistillPhase; elapsedMs: number }
  | {
      state: 'done';
      /** 产出合计（newCards + mergedAuto——「产出 N」语义，不虚称「N 卡」，CR-2b-11）。 */
      cardCount: number;
      newCards: number;
      mergedAuto: number;
      /** 台账 stats 全量（done tooltip 的 AC1「落库可见」面，CR-2b-10）。 */
      stats: CraftDistillStats;
      /** 台账 error note（done 态非 null = 去重不可用/超限挂起等诚实备注——CR-2b-10）。 */
      error: string | null;
    }
  | { state: 'failed'; error: string | null }
  | { state: 'material-deleted' };

/**
 * 材料蒸馏徽章合成：progress 事件里的运行态（pending/running——事件驱动，新鲜于台账拉取）
 * 优先；否则台账行（done 含 stats——产出合计 = 新建 + 自动并入〔本材料贡献的讲法/卡〕 +
 * 台账 stats/error note 供 tooltip「落库可见」）。台账无行 = 未蒸馏。
 */
export function materialDistillBadge(
  materialId: string,
  ledgers: readonly CraftDistillLedger[],
  progress: Record<string, CraftDistillProgressEvent>,
): CraftDistillBadge {
  const live = progress[materialId];
  if (live !== undefined && (live.status === 'running' || live.status === 'pending')) {
    if (live.status === 'running' && live.phase !== null) {
      return { state: 'running', phase: live.phase, elapsedMs: live.elapsedMs };
    }
    return { state: 'pending' };
  }
  const ledger = ledgers.find((l) => l.materialId === materialId);
  if (ledger === undefined) return { state: 'idle' };
  switch (ledger.status) {
    case 'pending':
      return { state: 'pending' };
    case 'running':
      return ledger.phase !== null
        ? { state: 'running', phase: ledger.phase, elapsedMs: 0 }
        : { state: 'pending' };
    case 'done':
      return {
        state: 'done',
        cardCount: ledger.stats.newCards + ledger.stats.mergedAuto,
        newCards: ledger.stats.newCards,
        mergedAuto: ledger.stats.mergedAuto,
        stats: ledger.stats,
        error: ledger.error,
      };
    case 'failed':
      return { state: 'failed', error: ledger.error };
    case 'material-deleted':
      return { state: 'material-deleted' };
  }
}

/**
 * done 徽章 tooltip 组料（CR-2b-10——AC1「锚定核验通过率落库可见」的 UI 面）：
 * 台账 stats 行（主张/落锚/三档丢弃）+ 产出分解行（新建/自动并入）+ 台账 error note 行
 * （去重不可用/派生已变更/超限挂起等——done 态非 null 时呈现）。消费侧 join('\n') 交
 * multiline tooltip（pre-line）。
 */
export function craftDoneTooltipLines(
  badge: Extract<CraftDistillBadge, { state: 'done' }>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string[] {
  const lines = [
    t('craft.distill.doneTooltipStats', {
      claims: badge.stats.claims,
      anchored: badge.stats.anchored,
      droppedNoAnchor: badge.stats.droppedNoAnchor,
      droppedMalformed: badge.stats.droppedMalformed,
      droppedNoCategory: badge.stats.droppedNoCategory,
    }),
    t('craft.distill.doneTooltip', { newCards: badge.newCards, mergedAuto: badge.mergedAuto }),
  ];
  if (badge.error !== null) lines.push(t('craft.distill.doneErrorNote', { note: badge.error }));
  return lines;
}

/** 运行耗时格式化（ms → 「12s」/「1m03s」——运行阶段可见性硬要求）。 */
export function formatElapsedMs(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

// ── 词表标签出口（i18n 键路由单源——组件不散落硬编码）──

export function craftCategoryLabelKey(category: CraftCardCategory): string {
  return `craft.category.${category}`;
}

export function craftStatusBadgeKey(status: CraftCardStatus): string {
  return `craft.status.${status}`;
}

export function craftRankLabelKey(rank: string): string {
  return `craft.rank.${rank}`;
}

export function craftPhaseLabelKey(phase: string): string {
  return `craft.phase.${phase}`;
}

/** 词目 select/展示用名（i18n 回落词目名原样——开放数据非词表键）。 */
export function termDisplay(termId: string, terms: readonly CraftTerm[]): string {
  const term = terms.find((t) => t.termId === termId);
  return term?.name ?? termId;
}
