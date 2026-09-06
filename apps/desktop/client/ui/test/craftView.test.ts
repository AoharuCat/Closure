/**
 * craftView 纯函数测试（E10.2b W5.6）。
 *
 * 覆盖：
 * - 置信三档 chip 映射（0.5/0.8 临时分界——W6 校准注记；边界值钉死防漂移）；
 * - 待阅队列排序（有并排任务 > 分歧 > 置信升序 > 最近更新）与队列成员判定
 *   （pending_review / dispute / staleTeachingCount>0；纯 verified 不进队列）；
 * - 按材料分组（多来源卡出现在每个材料组；无材料卡归未关联组末位；组序 = 首现序）；
 * - 客户端过滤（status/materialId/tags OR——任一命中）；
 * - 统计头聚合（含 pendingTerms）；
 * - 蒸馏徽章合成（progress 运行态优先于台账；done 含 stats 全量 + error note——产出合计 =
 *   newCards + mergedAuto；无台账行 = 未蒸馏；台账 running 兜底〔事件可丢〕）；
 * - done tooltip 组料（CR-2b-10——台账 stats 行 + 产出分解行 + error note 行三态）；
 * - 耗时格式化。
 */
import { describe, expect, it } from 'vitest';
import type {
  CraftCardSummary,
  CraftDistillLedger,
  CraftDistillProgressEvent,
  CraftMergeReview,
  CraftTerm,
} from '@orison/shared-contracts';
import {
  CRAFT_CONFIDENCE_LOW_MAX,
  CRAFT_CONFIDENCE_MID_MAX,
  craftConfidenceTier,
  craftDoneTooltipLines,
  craftQueueCards,
  craftStats,
  filterCraftCards,
  filterCraftMergeReviews,
  formatElapsedMs,
  groupCraftCardsByMaterial,
  materialDistillBadge,
} from '../src/features/craft/craftView';

function cardFixture(over: Partial<CraftCardSummary> = {}): CraftCardSummary {
  return {
    cardId: 'card-aaaaaaaaaaaa',
    category: 'qingxu',
    termId: 'term-aaaaaaaa',
    termName: '先抑后扬',
    title: '先抑后扬',
    condensed: '压低再抬高的回报模式',
    tags: [],
    status: 'pending_review',
    dispute: false,
    confidence: 0.9,
    teachingCount: 1,
    staleTeachingCount: 0,
    materialIds: ['mat-aaaaaaaaaaaa'],
    rejectReason: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

function ledgerFixture(over: Partial<CraftDistillLedger> = {}): CraftDistillLedger {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    contentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    status: 'done',
    stats: {
      claims: 5,
      anchored: 4,
      droppedNoAnchor: 1,
      droppedMalformed: 0,
      droppedNoCategory: 0,
      mergedAuto: 1,
      mergeReviews: 1,
      newCards: 3,
      disputes: 0,
    },
    phase: null,
    error: null,
    distilledAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

function termFixture(over: Partial<CraftTerm> = {}): CraftTerm {
  return {
    termId: 'term-aaaaaaaa',
    category: 'qingxu',
    name: '先抑后扬',
    status: 'active',
    mergedInto: null,
    note: null,
    ...over,
  };
}

describe('置信三档 chip 映射（mockup 修订——0.5/0.8 临时分界）', () => {
  it('边界值钉死（W6 校准前防漂移）', () => {
    expect(CRAFT_CONFIDENCE_LOW_MAX).toBe(0.5);
    expect(CRAFT_CONFIDENCE_MID_MAX).toBe(0.8);
  });

  it('三档映射含边界（< 0.5 低 / [0.5,0.8) 中 / ≥ 0.8 高）', () => {
    expect(craftConfidenceTier(0)).toBe('low');
    expect(craftConfidenceTier(0.49)).toBe('low');
    expect(craftConfidenceTier(0.5)).toBe('mid');
    expect(craftConfidenceTier(0.79)).toBe('mid');
    expect(craftConfidenceTier(0.8)).toBe('high');
    expect(craftConfidenceTier(1)).toBe('high');
  });
});

describe('待阅队列（成员判定 + 排序）', () => {
  const reviewFixture = (existingCardId: string): CraftMergeReview =>
    ({
      reviewId: 'mrev-aaaaaaaaaaaa',
      newClaim: {
        claim: { condensed: 'x', points: [], scenarios: [], counterexamples: [] },
        quote: 'q',
        anchor: { chapterIndex: 0, charStart: 0, charEnd: 1, paraStart: 0, paraEnd: 0 },
        materialId: 'mat-bbbbbbbbbbbb',
        materialContentHash: `sha256:${'c'.repeat(64)}`,
        author: null,
        category: 'qingxu',
        termId: 'term-aaaaaaaa',
        tags: [],
        confidence: 0.5,
      },
      existingCardId,
      similarity: 0.9,
      resolution: null,
      createdAt: '2026-09-05T00:00:00.000Z',
    }) as CraftMergeReview;

  it('纯 verified 卡不进队列；dispute / stale / pending 进', () => {
    const cards = [
      cardFixture({ cardId: 'card-000000000001', status: 'verified' }),
      cardFixture({ cardId: 'card-000000000002', status: 'verified', dispute: true }),
      cardFixture({ cardId: 'card-000000000003', status: 'verified', staleTeachingCount: 2 }),
      cardFixture({ cardId: 'card-000000000004', status: 'pending_review' }),
    ];
    const ids = craftQueueCards(cards, []).map((c) => c.cardId);
    expect(ids).toEqual(['card-000000000002', 'card-000000000003', 'card-000000000004']);
  });

  it('排序：有并排任务 > 分歧 > 置信升序 > 最近更新', () => {
    const cards = [
      cardFixture({ cardId: 'card-00000000000a', confidence: 0.2, updatedAt: '2026-09-05T01:00:00.000Z' }),
      cardFixture({ cardId: 'card-00000000000b', confidence: 0.1, dispute: true }),
      cardFixture({ cardId: 'card-00000000000c', confidence: 0.9 }),
      cardFixture({ cardId: 'card-00000000000d', confidence: 0.3, updatedAt: '2026-09-05T02:00:00.000Z' }),
    ];
    // c 有待决并排任务（existingCardId 指向它）——置顶压过分歧与低置信。
    const ids = craftQueueCards(cards, [reviewFixture('card-00000000000c')]).map((c) => c.cardId);
    expect(ids).toEqual([
      'card-00000000000c', // 并排候选最前
      'card-00000000000b', // 分歧次之
      'card-00000000000a', // 低置信（0.2 < 0.3）
      'card-00000000000d',
    ]);
  });

  it('resolved 并排任务不算候选（resolution 非空不计入 reviewCardIds）', () => {
    const resolved = { ...reviewFixture('card-00000000000c'), resolution: { action: 'merge' as const, resolvedAt: '2026-09-05T00:00:00.000Z', note: null } };
    const cards = [cardFixture({ cardId: 'card-00000000000c', confidence: 0.9 })];
    const ids = craftQueueCards(cards, [resolved]).map((c) => c.cardId);
    expect(ids).toEqual(['card-00000000000c']);
  });
});

describe('按材料分组', () => {
  it('多来源卡出现在每个材料组；无材料卡归未关联组末位', () => {
    const cards = [
      cardFixture({ cardId: 'card-000000000001', materialIds: ['mat-aaaaaaaaaaaa', 'mat-bbbbbbbbbbbb'] }),
      cardFixture({ cardId: 'card-000000000002', materialIds: ['mat-cccccccccccc'] }),
      cardFixture({ cardId: 'card-000000000003', materialIds: [] }),
    ];
    const groups = groupCraftCardsByMaterial(cards);
    expect(groups.map((g) => g.materialId)).toEqual(['mat-aaaaaaaaaaaa', 'mat-bbbbbbbbbbbb', 'mat-cccccccccccc', null]);
    expect(groups[0].cards.map((c) => c.cardId)).toEqual(['card-000000000001']);
    expect(groups[3].cards.map((c) => c.cardId)).toEqual(['card-000000000003']);
  });
});

describe('客户端过滤', () => {
  it('tags 任一命中即召回（OR）；materialId/status AND 组合', () => {
    const cards = [
      cardFixture({ cardId: 'card-000000000001', tags: ['都市', '爽点'], status: 'verified' }),
      cardFixture({ cardId: 'card-000000000002', tags: ['仙侠'], status: 'pending_review' }),
      cardFixture({ cardId: 'card-000000000003', tags: [], status: 'pending_review', materialIds: ['mat-bbbbbbbbbbbb'] }),
    ];
    expect(filterCraftCards(cards, { tags: ['都市', '仙侠'] }).map((c) => c.cardId)).toEqual([
      'card-000000000001',
      'card-000000000002',
    ]);
    expect(
      filterCraftCards(cards, { status: 'pending_review', materialId: 'mat-bbbbbbbbbbbb' }).map((c) => c.cardId),
    ).toEqual(['card-000000000003']);
    // 空标签数组 = 无过滤。
    expect(filterCraftCards(cards, { tags: [] }).length).toBe(3);
  });

  it('并排任务过滤（pending only + newClaim materialId/tags）', () => {
    const make = (reviewId: string, materialId: string, tags: string[], resolution: CraftMergeReview['resolution'] = null): CraftMergeReview =>
      ({
        reviewId,
        newClaim: {
          claim: { condensed: 'x', points: [], scenarios: [], counterexamples: [] },
          quote: 'q',
          anchor: { chapterIndex: 0, charStart: 0, charEnd: 1, paraStart: 0, paraEnd: 0 },
          materialId,
          materialContentHash: `sha256:${'c'.repeat(64)}`,
          author: null,
          category: 'qingxu',
          termId: 'term-aaaaaaaa',
          tags,
          confidence: 0.5,
        },
        existingCardId: 'card-aaaaaaaaaaaa',
        similarity: 0.9,
        resolution,
        createdAt: '2026-09-05T00:00:00.000Z',
      }) as CraftMergeReview;
    const reviews = [
      make('mrev-000000000001', 'mat-aaaaaaaaaaaa', ['都市']),
      make('mrev-000000000002', 'mat-bbbbbbbbbbbb', []),
      make('mrev-000000000003', 'mat-aaaaaaaaaaaa', [], { action: 'merge', resolvedAt: 't', note: null }),
    ];
    expect(filterCraftMergeReviews(reviews, {}).map((r) => r.reviewId)).toEqual([
      'mrev-000000000001',
      'mrev-000000000002',
    ]);
    expect(filterCraftMergeReviews(reviews, { materialId: 'mat-aaaaaaaaaaaa' }).map((r) => r.reviewId)).toEqual([
      'mrev-000000000001',
    ]);
    expect(filterCraftMergeReviews(reviews, { tags: ['都市'] }).map((r) => r.reviewId)).toEqual(['mrev-000000000001']);
  });
});

describe('统计头聚合', () => {
  it('待审/已核/驳回/分歧/待并词目计数', () => {
    const cards = [
      cardFixture({ cardId: 'c1', status: 'pending_review', dispute: true }),
      cardFixture({ cardId: 'c2', status: 'pending_review' }),
      cardFixture({ cardId: 'c3', status: 'verified' }),
      cardFixture({ cardId: 'c4', status: 'rejected' }),
    ];
    const terms = [
      termFixture({ termId: 'term-aaaaaaaa' }),
      termFixture({ termId: 'term-bbbbbbbb', status: 'pending', name: '新提案' }),
      termFixture({ termId: 'term-cccccccc', status: 'merged', mergedInto: 'term-aaaaaaaa' }),
    ];
    expect(craftStats(cards, terms)).toEqual({
      pending: 2,
      verified: 1,
      rejected: 1,
      dispute: 1,
      pendingTerms: 1,
    });
  });
});

describe('蒸馏徽章合成（台账 + progress 事件）', () => {
  it('无台账无事件 = 未蒸馏', () => {
    expect(materialDistillBadge('mat-aaaaaaaaaaaa', [], {})).toEqual({ state: 'idle' });
  });

  it('progress 运行态优先（相位 + 耗时来自事件——新鲜于台账拉取）', () => {
    const ledgers = [ledgerFixture({ status: 'done' })];
    const progress: Record<string, CraftDistillProgressEvent> = {
      'mat-aaaaaaaaaaaa': {
        materialId: 'mat-aaaaaaaaaaaa',
        status: 'running',
        phase: 'dedup',
        elapsedMs: 63000,
      },
    };
    expect(materialDistillBadge('mat-aaaaaaaaaaaa', ledgers, progress)).toEqual({
      state: 'running',
      phase: 'dedup',
      elapsedMs: 63000,
    });
  });

  it('progress pending 态 → 排队徽章（无相位）', () => {
    const progress: Record<string, CraftDistillProgressEvent> = {
      'mat-aaaaaaaaaaaa': { materialId: 'mat-aaaaaaaaaaaa', status: 'pending', phase: null, elapsedMs: 0 },
    };
    expect(materialDistillBadge('mat-aaaaaaaaaaaa', [], progress)).toEqual({ state: 'pending' });
  });

  it('终态事件已删（slice 语义）→ 回落台账：done 携 stats 全量 + error（CR-2b-10/11）', () => {
    const stats = {
      claims: 5,
      anchored: 5,
      droppedNoAnchor: 0,
      droppedMalformed: 0,
      droppedNoCategory: 0,
      mergedAuto: 2,
      mergeReviews: 0,
      newCards: 3,
      disputes: 0,
    };
    const ledgers = [ledgerFixture({ stats, error: null })];
    expect(materialDistillBadge('mat-aaaaaaaaaaaa', ledgers, {})).toEqual({
      state: 'done',
      cardCount: 5, // 产出合计 = newCards(3) + mergedAuto(2)——「产出 N」语义
      newCards: 3,
      mergedAuto: 2,
      stats,
      error: null,
    });
    // done 态 error 非 null = 诚实备注（去重不可用/超限挂起等）随徽章携带。
    const withNote = [ledgerFixture({ stats, error: '去重不可用：未配置 embedding 模型' })];
    const withNoteBadge = materialDistillBadge('mat-aaaaaaaaaaaa', withNote, {});
    if (withNoteBadge.state !== 'done') throw new Error('expected done');
    expect(withNoteBadge.error).toBe('去重不可用：未配置 embedding 模型');
  });

  it('failed 带 error；material-deleted；台账 running 兜底（事件可丢）', () => {
    expect(materialDistillBadge('mat-aaaaaaaaaaaa', [ledgerFixture({ status: 'failed', error: 'LLM 不可用' })], {})).toEqual({
      state: 'failed',
      error: 'LLM 不可用',
    });
    expect(materialDistillBadge('mat-aaaaaaaaaaaa', [ledgerFixture({ status: 'material-deleted' })], {})).toEqual({
      state: 'material-deleted',
    });
    expect(materialDistillBadge('mat-aaaaaaaaaaaa', [ledgerFixture({ status: 'running', phase: 'extracting' })], {})).toEqual({
      state: 'running',
      phase: 'extracting',
      elapsedMs: 0,
    });
  });
});

describe('done tooltip 组料（CR-2b-10——AC1「落库可见」）', () => {
  /** 假 t：键名 + 有序值串（断言组料行内容与插值次序）。 */
  const fakeT = (key: string, vars?: Record<string, string | number>): string =>
    vars === undefined ? key : `${key}:${Object.values(vars).join(',')}`;

  it('error 为 null：两行（台账 stats 行 + 产出分解行）', () => {
    const badge = materialDistillBadge('mat-aaaaaaaaaaaa', [ledgerFixture()], {});
    if (badge.state !== 'done') throw new Error('expected done');
    const lines = craftDoneTooltipLines(badge, fakeT);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('craft.distill.doneTooltipStats:5,4,1,0,0');
    expect(lines[1]).toBe('craft.distill.doneTooltip:3,1');
  });

  it('error 非 null：第三行台账备注（去重不可用/派生已变更等诚实 note）', () => {
    const ledgers = [ledgerFixture({ error: '派生已变更——讲法待复核' })];
    const badge = materialDistillBadge('mat-aaaaaaaaaaaa', ledgers, {});
    if (badge.state !== 'done') throw new Error('expected done');
    const lines = craftDoneTooltipLines(badge, fakeT);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('craft.distill.doneErrorNote:派生已变更——讲法待复核');
  });
});

describe('耗时格式化', () => {
  it('秒/分级两形态', () => {
    expect(formatElapsedMs(0)).toBe('0s');
    expect(formatElapsedMs(12000)).toBe('12s');
    expect(formatElapsedMs(63000)).toBe('1m03s');
    expect(formatElapsedMs(-5)).toBe('0s');
  });
});
