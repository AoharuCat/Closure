import { describe, expect, it } from 'vitest';
import {
  CRAFT_DISTILL_PHASES,
  CRAFT_DISTILL_PROGRESS_CHANNEL,
  CRAFT_DISTILL_STATUSES,
  CRAFT_MERGE_REVIEW_ACTIONS,
  craftClaimExtractionOutputSchema,
  craftCategorizationOutputSchema,
  craftDisputeVerdictOutputSchema,
  craftDistillLedgerSchema,
  craftDistillStatsSchema,
  craftMergeReviewSchema,
  desktopIpcSchema,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// E10.2b Wave 1（W1.3/W1.4/W1.5）：蒸馏管线 schema（切条约束式输出 / 归类两态 /
// 冲突判定 / 台账双 hash / merge review）+ craft:* IPC 契约 parse。
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_CLAIM = {
  condensed: '每章结尾留一个未兑现的具体钩子，而不是抽象的紧张感。',
  points: ['钩子指向具体对象（信/人/日期）'],
  scenarios: ['连载中期保期待'],
  counterexamples: ['高潮章直给收束不留钩'],
};

const SAMPLE_EXTRACTION = [
  {
    ...SAMPLE_CLAIM,
    paraRange: { start: 3, end: 7 },
    quote: '章末的钩子必须是具体的……',
    tags: ['连载', '期待感'],
  },
  {
    ...SAMPLE_CLAIM,
    paraRange: { start: 20, end: 20 },
    quote: '另一条主张引文',
    tags: [],
  },
];

// ── 切条约束式输出（W1.3）──

describe('craftClaimExtractionOutputSchema — 切条约束式输出', () => {
  it('合法数组 parse 通过（claim 四件套自 craftClaimSchema extend——形状单源）', () => {
    expect(() => craftClaimExtractionOutputSchema.parse(SAMPLE_EXTRACTION)).not.toThrow();
    expect(craftClaimExtractionOutputSchema.parse(SAMPLE_EXTRACTION)).toHaveLength(2);
  });

  it('paraRange 引用全局段落号：负数 / 非整数均拒', () => {
    expect(() =>
      craftClaimExtractionOutputSchema.parse([{ ...SAMPLE_EXTRACTION[0], paraRange: { start: -1, end: 5 } }]),
    ).toThrow();
    expect(() =>
      craftClaimExtractionOutputSchema.parse([{ ...SAMPLE_EXTRACTION[0], paraRange: { start: 0.5, end: 5 } }]),
    ).toThrow();
  });

  it('quote / condensed 非空（引文与保义浓缩都是硬底——无锚即丢闸门的输入面）', () => {
    expect(() => craftClaimExtractionOutputSchema.parse([{ ...SAMPLE_EXTRACTION[0], quote: '' }])).toThrow();
    expect(() => craftClaimExtractionOutputSchema.parse([{ ...SAMPLE_EXTRACTION[0], condensed: '' }])).toThrow();
  });

  it('tags 自由标签：任意字符串维度不受控（R10 红线只约束类目不约束标签）', () => {
    expect(() =>
      craftClaimExtractionOutputSchema.parse([{ ...SAMPLE_EXTRACTION[0], tags: ['题材:都市', '强度#高', '任意'] }]),
    ).not.toThrow();
    expect(() => craftClaimExtractionOutputSchema.parse([{ ...SAMPLE_EXTRACTION[0], tags: [''] }])).toThrow();
  });

  it('空数组合法（一份材料零主张——锚定核验后可为空，计数落台账）', () => {
    expect(craftClaimExtractionOutputSchema.parse([])).toEqual([]);
  });
});

// ── 归类输出两态（W1.3）──

describe('craftCategorizationOutputSchema — 受控词表内选 / pending 提案', () => {
  it('已知词目形态 parse 通过（category + termId + confidence）', () => {
    const out = craftCategorizationOutputSchema.parse({ category: 'qidaigan', termId: 'term-abcd1234', confidence: 0.9 });
    expect(out).toMatchObject({ category: 'qidaigan', termId: 'term-abcd1234' });
  });

  it('提案形态 parse 通过（proposedTerm + confidence——R2 每建议带置信）', () => {
    const out = craftCategorizationOutputSchema.parse({
      proposedTerm: { category: 'jiegoudafa', name: '双线咬合' },
      confidence: 0.4,
    });
    expect(out).toMatchObject({ proposedTerm: { name: '双线咬合' } });
  });

  it('提案形态大类仍受控：doc 级 slug 泄漏 / 自造大类均拒（R2 红线）', () => {
    expect(() =>
      craftCategorizationOutputSchema.parse({ proposedTerm: { category: 'character', name: 'x' }, confidence: 0.4 }),
    ).toThrow();
    expect(() =>
      craftCategorizationOutputSchema.parse({ proposedTerm: { category: '自造大类', name: 'x' }, confidence: 0.4 }),
    ).toThrow();
  });

  it('已知形态 termId 格式钉死 + confidence 越界拒', () => {
    expect(() => craftCategorizationOutputSchema.parse({ category: 'fubi', termId: 'term-xyz', confidence: 0.5 })).toThrow();
    expect(() =>
      craftCategorizationOutputSchema.parse({ category: 'fubi', termId: 'term-abcd1234', confidence: 1.2 }),
    ).toThrow();
  });
});

// ── 冲突判定输出（W1.3）──

describe('craftDisputeVerdictOutputSchema — 冲突判定', () => {
  it('两态均要求 reason（无论 dispute 真假——LLM 判断可解释）', () => {
    expect(() => craftDisputeVerdictOutputSchema.parse({ dispute: true, reason: '两位作者对回报密度结论相反' })).not.toThrow();
    expect(() => craftDisputeVerdictOutputSchema.parse({ dispute: false, reason: '同一手法不同侧重' })).not.toThrow();
    expect(() => craftDisputeVerdictOutputSchema.parse({ dispute: true, reason: '' })).toThrow();
    expect(() => craftDisputeVerdictOutputSchema.parse({ dispute: true })).toThrow();
  });
});

// ── 蒸馏台账（W1.4：双 hash + 状态五值 + 相位四值）──

describe('craftDistillLedgerSchema — 材料级台账', () => {
  const SAMPLE_STATS = {
    claims: 12,
    anchored: 11,
    droppedNoAnchor: 1,
    droppedMalformed: 0,
    droppedNoCategory: 2,
    mergedAuto: 3,
    mergeReviews: 2,
    newCards: 6,
    disputes: 1,
  };

  const sampleLedger = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    materialId: 'mat-0123456789ab',
    contentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    status: 'done',
    stats: { ...SAMPLE_STATS },
    phase: null,
    error: null,
    distilledAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  });

  it('合法样例 parse 通过（五状态全 parse 含 material-deleted）', () => {
    expect(() => craftDistillLedgerSchema.parse(sampleLedger())).not.toThrow();
    for (const status of CRAFT_DISTILL_STATUSES) {
      expect(() => craftDistillLedgerSchema.parse(sampleLedger({ status }))).not.toThrow();
    }
    expect(() => craftDistillLedgerSchema.parse(sampleLedger({ status: 'cancelled' }))).toThrow();
  });

  it('运行态带相位（四相位全 parse）；终态 phase=null', () => {
    for (const phase of CRAFT_DISTILL_PHASES) {
      expect(() => craftDistillLedgerSchema.parse(sampleLedger({ status: 'running', phase }))).not.toThrow();
    }
    expect(() => craftDistillLedgerSchema.parse(sampleLedger({ phase: 'polishing' }))).toThrow();
  });

  it('双 hash 格式钉死（原件 + 派生各一枚 sha256）', () => {
    expect(() => craftDistillLedgerSchema.parse(sampleLedger({ derivedHash: 'not-a-hash' }))).toThrow();
    expect(() => craftDistillLedgerSchema.parse(sampleLedger({ contentHash: `sha256:${'c'.repeat(63)}` }))).toThrow();
  });

  it('stats 计数非负整数；camelCase 键必填（snake_case 换算归 W2 行映射）', () => {
    expect(() => craftDistillStatsSchema.parse(SAMPLE_STATS)).not.toThrow();
    expect(() => craftDistillStatsSchema.parse({ ...SAMPLE_STATS, droppedNoAnchor: -1 })).toThrow();
    expect(() => craftDistillStatsSchema.parse({ ...SAMPLE_STATS, claims: 1.5 })).toThrow();
    const snakeOnly = { ...SAMPLE_STATS } as Record<string, unknown>;
    delete snakeOnly.droppedNoAnchor;
    snakeOnly.dropped_no_anchor = 1;
    expect(() => craftDistillStatsSchema.parse(snakeOnly)).toThrow();
  });

  it('丢弃口径拆分键必填：droppedMalformed（坏形状）/ droppedNoCategory（归类失败）独立计数', () => {
    // 缺任一拆分键 = parse 拒（口径混淆防线——坏形状 ≠ 无锚，通过率失真）。
    const noMalformed = { ...SAMPLE_STATS } as Record<string, unknown>;
    delete noMalformed.droppedMalformed;
    expect(() => craftDistillStatsSchema.parse(noMalformed)).toThrow();
    const noNoCategory = { ...SAMPLE_STATS } as Record<string, unknown>;
    delete noNoCategory.droppedNoCategory;
    expect(() => craftDistillStatsSchema.parse(noNoCategory)).toThrow();
    expect(() => craftDistillStatsSchema.parse({ ...SAMPLE_STATS, droppedNoCategory: -1 })).toThrow();
    expect(() => craftDistillStatsSchema.parse({ ...SAMPLE_STATS, droppedMalformed: 0.5 })).toThrow();
  });

  it('error / distilledAt nullable（never-throws 失败态落台账 / 未完成 null）', () => {
    expect(() =>
      craftDistillLedgerSchema.parse(
        sampleLedger({ status: 'failed', error: 'LLM 缝不可用', distilledAt: null }),
      ),
    ).not.toThrow();
  });
});

// ── merge review（W1.4：中档去重并排任务记录形态）──

describe('craftMergeReviewSchema — 并排对比任务', () => {
  const sampleReview = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    reviewId: 'mrev-0123456789ab',
    newClaim: {
      claim: { ...SAMPLE_CLAIM },
      quote: '章末的钩子必须是具体的……',
      anchor: { chapterIndex: 0, charStart: 10, charEnd: 120, paraStart: 2, paraEnd: 5 },
      materialId: 'mat-0123456789ab',
      materialContentHash: `sha256:${'a'.repeat(64)}`,
      author: null,
      category: 'qidaigan',
      termId: 'term-01234567',
      tags: ['连载'],
      confidence: 0.91,
    },
    existingCardId: 'card-0123456789ab',
    similarity: 0.91,
    resolution: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  });

  it('待审形态 parse 通过（resolution=null）', () => {
    expect(() => craftMergeReviewSchema.parse(sampleReview())).not.toThrow();
  });

  it('三动作裁决全 parse（merge/independent/dismiss——AC3 三动作）', () => {
    for (const action of CRAFT_MERGE_REVIEW_ACTIONS) {
      expect(() =>
        craftMergeReviewSchema.parse(
          sampleReview({ resolution: { action, resolvedAt: '2026-09-05T12:00:00.000Z', note: null } }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      craftMergeReviewSchema.parse(
        sampleReview({ resolution: { action: 'skip', resolvedAt: '2026-09-05T12:00:00.000Z', note: null } }),
      ),
    ).toThrow();
  });

  it('similarity 收 0-1（中档 0.85-0.98 是入队判定归 shell 常量，schema 只钉值域）', () => {
    expect(() => craftMergeReviewSchema.parse(sampleReview({ similarity: 0 }))).not.toThrow();
    expect(() => craftMergeReviewSchema.parse(sampleReview({ similarity: 1 }))).not.toThrow();
    expect(() => craftMergeReviewSchema.parse(sampleReview({ similarity: 1.01 }))).toThrow();
    expect(() => craftMergeReviewSchema.parse(sampleReview({ similarity: -0.01 }))).toThrow();
  });

  it('id 格式钉死：reviewId mrev-<12hex> / existingCardId card-<12hex>', () => {
    expect(() => craftMergeReviewSchema.parse(sampleReview({ reviewId: 'mrev-abc' }))).toThrow();
    expect(() => craftMergeReviewSchema.parse(sampleReview({ existingCardId: 'card-abc' }))).toThrow();
  });

  it('newClaim.category 受控 13 类（doc 级 slug 拒）', () => {
    const badClaim = {
      ...(sampleReview().newClaim as Record<string, unknown>),
      category: 'playbook',
    };
    expect(() => craftMergeReviewSchema.parse(sampleReview({ newClaim: badClaim }))).toThrow();
  });

  it('disputeHint 可选键二态（CR-2b-D1 拍板 a 案）：缺省合法（判定不可用）/ 在场须形整', () => {
    // 缺省 = LLM 分歧判定不可用——不写暗示已检查的标记。
    expect(() => craftMergeReviewSchema.parse(sampleReview())).not.toThrow();
    expect(craftMergeReviewSchema.parse(sampleReview()).disputeHint).toBeUndefined();
    // 在场 = 判定成功（dispute 真假均可能，reason 必随——mirror 冲突判定输出形状）。
    expect(() =>
      craftMergeReviewSchema.parse(
        sampleReview({ disputeHint: { dispute: true, reason: '一说压制起手，一说高开即爽' } }),
      ),
    ).not.toThrow();
    expect(() =>
      craftMergeReviewSchema.parse(sampleReview({ disputeHint: { dispute: false, reason: '同一手法不同侧重' } })),
    ).not.toThrow();
    // 坏形态拒：reason 空 / 缺 dispute / hint 非对象。
    expect(() =>
      craftMergeReviewSchema.parse(sampleReview({ disputeHint: { dispute: true, reason: '' } })),
    ).toThrow();
    expect(() => craftMergeReviewSchema.parse(sampleReview({ disputeHint: { reason: '缺 dispute' } }))).toThrow();
    expect(() => craftMergeReviewSchema.parse(sampleReview({ disputeHint: '疑似分歧' }))).toThrow();
  });
  it('newClaim additive 三字段（E10.3b W7——decon 实例经并排裁决不丢身份）：缺省合法（10.2 语义零迁移）/ 在场形整 / 坏形拒', () => {
    // 缺省 = 10.2 蒸馏语义（doc_claim），旧行零迁移。
    const baseline = craftMergeReviewSchema.parse(sampleReview());
    expect(baseline.newClaim.originKind).toBeUndefined();
    expect(baseline.newClaim.bookTitle).toBeUndefined();
    expect(baseline.newClaim.evidence).toBeUndefined();
    // 在场 = decon 实例完整载荷（resolve 成卡时透传进 teaching——AC4 语义完整性）。
    const deconClaim = {
      ...(sampleReview().newClaim as Record<string, unknown>),
      originKind: 'decon_instance',
      bookTitle: '拆书来源小说',
      evidence: {
        anchors: [{ chapterIndex: 0, charStart: 10, charEnd: 120, paraStart: 2, paraEnd: 5 }],
        level: 'strong',
        derivedHash: `sha256:${'b'.repeat(64)}`,
      },
    };
    const parsed = craftMergeReviewSchema.parse(sampleReview({ newClaim: deconClaim }));
    expect(parsed.newClaim.originKind).toBe('decon_instance');
    expect(parsed.newClaim.bookTitle).toBe('拆书来源小说');
    expect(parsed.newClaim.evidence?.level).toBe('strong');
    // 坏形拒：originKind 越枚举 / evidence 空 anchors / derivedHash 非 sha256。
    expect(() =>
      craftMergeReviewSchema.parse(
        sampleReview({ newClaim: { ...deconClaim, originKind: 'community' } }),
      ),
    ).toThrow();
    expect(() =>
      craftMergeReviewSchema.parse(
        sampleReview({ newClaim: { ...deconClaim, evidence: { ...deconClaim.evidence, anchors: [] } } }),
      ),
    ).toThrow();
    expect(() =>
      craftMergeReviewSchema.parse(
        sampleReview({ newClaim: { ...deconClaim, evidence: { ...deconClaim.evidence, derivedHash: 'md5:x' } } }),
      ),
    ).toThrow();
  });

  it('newClaim originTier additive（E10.4——来源材料三级经 merge 裁决不丢）：缺省合法 / 三值 parse / 越枚举拒', () => {
    // 缺省 = 旧行零迁移（unspecified 材料蒸馏透传为 absent——doc_claim 原语义不含 tier）。
    const baseline = craftMergeReviewSchema.parse(sampleReview());
    expect(baseline.newClaim.originTier).toBeUndefined();
    // 在场 = 批评/社区/原作来源讲法完整载荷（resolve 成卡时透传进 teaching——mirror originKind AC4）。
    const tieredClaim = {
      ...(sampleReview().newClaim as Record<string, unknown>),
      originTier: 'criticism',
    };
    const parsed = craftMergeReviewSchema.parse(sampleReview({ newClaim: tieredClaim }));
    expect(parsed.newClaim.originTier).toBe('criticism');
    for (const originTier of ['original', 'community'] as const) {
      expect(() =>
        craftMergeReviewSchema.parse(sampleReview({ newClaim: { ...tieredClaim, originTier } })),
      ).not.toThrow();
    }
    // 越枚举拒（unspecified 不入讲法级——absent 表达）。
    expect(() =>
      craftMergeReviewSchema.parse(sampleReview({ newClaim: { ...tieredClaim, originTier: 'unspecified' } })),
    ).toThrow();
  });
});

// ── IPC 契约 parse（W1.5）──

describe('craft:* IPC 契约 — desktopIpcSchema channel 枚举', () => {
  const CRAFT_INVOKE_CHANNELS = [
    'craft:distill-run',
    'craft:card-list',
    'craft:card-get',
    'craft:card-patch',
    'craft:card-review',
    'craft:merge-review-list',
    'craft:merge-review-resolve',
    'craft:term-list',
    'craft:term-approve',
    'craft:term-merge',
    'craft:distill-status',
  ];

  it('11 invoke 通道全进 enum（三层同步的契约半——preload/handler 归 W4/W5）', () => {
    expect(CRAFT_INVOKE_CHANNELS).toHaveLength(11);
    for (const channel of CRAFT_INVOKE_CHANNELS) {
      expect(desktopIpcSchema.safeParse({ channel }).success, channel).toBe(true);
    }
  });

  it('自造通道拒（craft:bogus / materials:distill 均不在面）', () => {
    expect(desktopIpcSchema.safeParse({ channel: 'craft:bogus' }).success).toBe(false);
    expect(desktopIpcSchema.safeParse({ channel: 'materials:distill' }).success).toBe(false);
  });

  it('push 通道 craft:distill-progress 不进 enum（mirror material:changed 先例——名单源 channels.ts）', () => {
    expect(CRAFT_DISTILL_PROGRESS_CHANNEL).toBe('craft:distill-progress');
    expect(desktopIpcSchema.safeParse({ channel: CRAFT_DISTILL_PROGRESS_CHANNEL }).success).toBe(false);
  });
});
