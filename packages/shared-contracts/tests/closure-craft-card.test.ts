import { describe, expect, it } from 'vitest';
import {
  CRAFT_CARD_CATEGORIES,
  CRAFT_CARD_CATEGORY_VALUES,
  CRAFT_CARD_STATUSES,
  CRAFT_TEACHING_RANKS,
  CRAFT_TERM_SEEDS,
  CRAFT_TERM_STATUSES,
  craftCardCategorySchema,
  craftCardSchema,
  craftClaimSchema,
  craftTeachingSchema,
  craftTermSchema,
  formatCraftCardCategories,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// E10.2b Wave 1（W1.1/W1.2）：手艺卡域 schema + 受控大类词表。
// 重点：category 封闭 13 类（R2 红线——与 craft_type open string 刻意相反，doc 级
// slug 不得泄漏进条目级）/ rank 三档 / 状态机三态字段 / tags 自由数组 / anchor 半开
// 区间字段（mirror materialChunkSpan 减 chunkIndex）/ id 格式钉死。
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_TEACHING = {
  teachingId: 'tea-0123456789ab',
  materialId: 'mat-0123456789ab',
  materialContentHash: `sha256:${'a'.repeat(64)}`,
  author: '某位作者',
  quote: '开篇三章内必须让读者看见主角的核心欲望与即时回报……',
  anchor: { chapterIndex: 0, charStart: 10, charEnd: 120, paraStart: 2, paraEnd: 5 },
  rank: 'normal',
  note: null,
  stale: false,
};

function sampleCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardId: 'card-0123456789ab',
    category: 'qiaoduan',
    termId: 'term-01234567',
    title: '黄金三章',
    claim: {
      condensed: '开篇三章建立主角核心欲望与即时回报，锁住读者。',
      points: ['第一章内亮出金手指'],
      scenarios: ['新书开篇'],
      counterexamples: ['慢热文艺向开篇'],
    },
    tags: ['网文', '开篇'],
    teachings: [{ ...SAMPLE_TEACHING }],
    dispute: false,
    status: 'pending_review',
    rejectReason: null,
    confidence: 0.72,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

// ── 受控大类词表（W1.2：大类穷举 = 13——F-01 修订后的 design/prd 同步断言）──

describe('CRAFT_CARD_CATEGORIES — 受控 13 大类（R2 红线）', () => {
  it('恰好 13 大类（穷举断言——多一类少一类都红）', () => {
    expect(CRAFT_CARD_CATEGORIES).toHaveLength(13);
    expect(CRAFT_CARD_CATEGORY_VALUES).toHaveLength(13);
  });

  it('value 唯一 + 与 CRAFT_CARD_CATEGORY_VALUES 双向覆盖（词表↔enum 零漂移）', () => {
    const values = CRAFT_CARD_CATEGORIES.map((c) => c.value);
    expect(new Set(values).size).toBe(13);
    for (const v of CRAFT_CARD_CATEGORY_VALUES) {
      expect(values, `enum 值 ${v} 必须有词表条目`).toContain(v);
    }
    for (const v of values) {
      expect(CRAFT_CARD_CATEGORY_VALUES, `词表值 ${v} 必须在 enum 内`).toContain(v);
    }
  });

  it('gloss 全非空（prompt 注入面完整性）', () => {
    for (const c of CRAFT_CARD_CATEGORIES) {
      expect(c.gloss.trim().length, `${c.value} gloss 非空`).toBeGreaterThan(0);
    }
  });

  it('epics.md:881 关键类在场：人设承接位 renshe + 素材 sucai + 新六类', () => {
    const values = CRAFT_CARD_CATEGORY_VALUES as readonly string[];
    // 原五类
    for (const v of ['qingxu', 'xinxicha', 'fubi', 'qiaoduan', 'jiegou']) expect(values).toContain(v);
    // 新六类
    for (const v of ['huoke', 'qidaigan', 'jiegoudafa', 'zaogeng', 'shijieguan', 'manzu']) {
      expect(values).toContain(v);
    }
    // 散并承接 + 素材
    expect(values).toContain('renshe');
    expect(values).toContain('sucai');
  });

  it('craftCardCategorySchema 封闭：doc 级 craft_type slug（character/uncategorized/playbook）均拒', () => {
    for (const v of CRAFT_CARD_CATEGORY_VALUES) {
      expect(craftCardCategorySchema.safeParse(v).success, v).toBe(true);
    }
    // 8 类 craft_type 词表里不在 13 大类内的值——分层并存不同 slug 空间，禁互串
    for (const leaked of ['character', 'uncategorized', 'playbook', 'jiezou', 'liliang', 'shuangdian']) {
      expect(craftCardCategorySchema.safeParse(leaked).success, leaked).toBe(false);
    }
  });

  it('formatCraftCardCategories：13 值全注入 + 受控措辞（与 craft_type 先验措辞刻意相反）', () => {
    const text = formatCraftCardCategories();
    for (const c of CRAFT_CARD_CATEGORIES) {
      expect(text).toContain(c.value);
    }
    expect(text).toContain('受控');
    expect(text).toContain('禁自造类目');
  });
});

// ── 主张四件套（W1.1）──

describe('craftClaimSchema — 四件套', () => {
  it('合法样例 parse 通过', () => {
    expect(() =>
      craftClaimSchema.parse({
        condensed: '先抑后扬需要回报密度匹配。',
        points: ['抑点每章不超过两个'],
        scenarios: ['情绪回报线'],
        counterexamples: ['连续三章纯抑无扬'],
      }),
    ).not.toThrow();
  });

  it('condensed 非空是硬底；points/scenarios/counterexamples 允许空数组（语义完整性归 prompt/人审）', () => {
    expect(() =>
      craftClaimSchema.parse({ condensed: 'x', points: [], scenarios: [], counterexamples: [] }),
    ).not.toThrow();
    expect(() => craftClaimSchema.parse({ condensed: '', points: [], scenarios: [], counterexamples: [] })).toThrow();
  });

  it('数组元素非空串（空要点 = 坏条目）', () => {
    expect(() =>
      craftClaimSchema.parse({ condensed: 'x', points: [''], scenarios: [], counterexamples: [] }),
    ).toThrow();
  });
});

// ── 讲法（W1.1：rank 三档 + anchor 半开区间字段 + id/hash 格式）──

describe('craftTeachingSchema — Wikidata statement 形态', () => {
  it('合法样例 parse 通过', () => {
    expect(() => craftTeachingSchema.parse(SAMPLE_TEACHING)).not.toThrow();
  });

  it('rank 三档全 parse；Wikidata 原词（preferred/deprecated）与非法值均拒（slug 空间自洽）', () => {
    for (const rank of CRAFT_TEACHING_RANKS) {
      expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, rank })).not.toThrow();
    }
    for (const bad of ['preferred', 'deprecated', 'unknown']) {
      expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, rank: bad })).toThrow();
    }
  });

  it('teachingId 格式钉死 tea-<12hex>：13 位/大写/无前缀均拒', () => {
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, teachingId: 'tea-abc123def456' })).not.toThrow();
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, teachingId: 'tea-abc123def4567' })).toThrow();
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, teachingId: 'tea-ABC123DEF456' })).toThrow();
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, teachingId: 'abc123def456' })).toThrow();
  });

  it('materialId / materialContentHash 格式沿材料域契约（mat-<12hex> / sha256:<64hex>）', () => {
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, materialId: 'mat-fff000000000' })).not.toThrow();
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, materialId: 'mat-fff00000000' })).toThrow();
    expect(() =>
      craftTeachingSchema.parse({ ...SAMPLE_TEACHING, materialContentHash: `sha256:${'0'.repeat(63)}` }),
    ).toThrow();
  });

  it('anchor 半开区间字段：负整数 / 非整数均拒（mirror materialChunkSpan 减 chunkIndex）', () => {
    const anchor = (patch: Record<string, unknown>) => ({ ...SAMPLE_TEACHING, anchor: { ...SAMPLE_TEACHING.anchor, ...patch } });
    expect(() => craftTeachingSchema.parse(anchor({}))).not.toThrow();
    expect(() => craftTeachingSchema.parse(anchor({ charStart: -1 }))).toThrow();
    expect(() => craftTeachingSchema.parse(anchor({ paraEnd: 1.5 }))).toThrow();
    expect(() => craftTeachingSchema.parse(anchor({ chapterIndex: -0 }))).not.toThrow();
  });

  it('author/note nullable 恒在（出处未知 = null 非 undefined 缺键）', () => {
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, author: null, note: null })).not.toThrow();
    const bad = { ...SAMPLE_TEACHING } as Record<string, unknown>;
    delete bad.author;
    expect(() => craftTeachingSchema.parse(bad)).toThrow();
  });

  it('quote 非空 + stale 布尔必填（引文快照冗余存——锚空转防线）', () => {
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, quote: '' })).toThrow();
    expect(() => craftTeachingSchema.parse({ ...SAMPLE_TEACHING, stale: true })).not.toThrow();
    const bad = { ...SAMPLE_TEACHING } as Record<string, unknown>;
    delete bad.stale;
    expect(() => craftTeachingSchema.parse(bad)).toThrow();
  });
});

// ── 手艺卡（W1.1：状态机字段 + teachings min(1) 无锚即丢不变量）──

describe('craftCardSchema — 卡主体', () => {
  it('合法样例 parse 通过（三状态全 parse）', () => {
    expect(() => craftCardSchema.parse(sampleCard())).not.toThrow();
    for (const status of CRAFT_CARD_STATUSES) {
      expect(() => craftCardSchema.parse(sampleCard({ status }))).not.toThrow();
    }
    expect(() => craftCardSchema.parse(sampleCard({ status: 'draft' }))).toThrow();
  });

  it('cardId 格式钉死 card-<12hex>：13 位/大写/无前缀均拒', () => {
    expect(() => craftCardSchema.parse(sampleCard({ cardId: 'card-fff111222333' }))).not.toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ cardId: 'card-fff1112223334' }))).toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ cardId: 'card-FFF111222333' }))).toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ cardId: 'fff111222333' }))).toThrow();
  });

  it('category 受控：词表外值拒（含 doc 级 slug 泄漏）', () => {
    expect(() => craftCardSchema.parse(sampleCard({ category: 'renshe' }))).not.toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ category: 'character' }))).toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ category: '未知类' }))).toThrow();
  });

  it('teachings 至少一条（无锚即丢的必然——无来源主张不可落卡）', () => {
    expect(() => craftCardSchema.parse(sampleCard({ teachings: [] }))).toThrow();
    expect(() =>
      craftCardSchema.parse(sampleCard({ teachings: [{ ...SAMPLE_TEACHING }, { ...SAMPLE_TEACHING, teachingId: 'tea-ffffffffffff' }] })),
    ).not.toThrow();
  });

  it('confidence 收 0-1（边界含）；只排序不自动批准——超界拒', () => {
    expect(() => craftCardSchema.parse(sampleCard({ confidence: 0 }))).not.toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ confidence: 1 }))).not.toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ confidence: 1.01 }))).toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ confidence: -0.01 }))).toThrow();
  });

  it('tags 自由数组（任意字符串维度）+ rejectReason nullable', () => {
    expect(() => craftCardSchema.parse(sampleCard({ tags: ['男频', '都市', '任意自由维度#1'] }))).not.toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ tags: [] }))).not.toThrow();
    expect(() => craftCardSchema.parse(sampleCard({ rejectReason: '与既有卡重复' }))).not.toThrow();
  });
});

// ── 词目（W1.2：两级词表词目级 + 待并词表 = pending 行）──

describe('craftTermSchema — 词目', () => {
  const sampleTerm = {
    termId: 'term-01234567',
    category: 'qidaigan',
    name: '先抑后扬',
    status: 'active',
    mergedInto: null,
    note: null,
  };

  it('合法样例 parse 通过（三状态全 parse）', () => {
    expect(() => craftTermSchema.parse(sampleTerm)).not.toThrow();
    for (const status of CRAFT_TERM_STATUSES) {
      expect(() => craftTermSchema.parse({ ...sampleTerm, status })).not.toThrow();
    }
    expect(() => craftTermSchema.parse({ ...sampleTerm, status: 'archived' })).toThrow();
  });

  it('termId 格式钉死 term-<8hex>：9 位/大写/无前缀均拒', () => {
    expect(() => craftTermSchema.parse({ ...sampleTerm, termId: 'term-abcd1234' })).not.toThrow();
    expect(() => craftTermSchema.parse({ ...sampleTerm, termId: 'term-abcd12345' })).toThrow();
    expect(() => craftTermSchema.parse({ ...sampleTerm, termId: 'term-ABCD1234' })).toThrow();
    expect(() => craftTermSchema.parse({ ...sampleTerm, termId: 'abcd1234' })).toThrow();
  });

  it('mergedInto nullable：merged 态带目标 id，其余态 null', () => {
    expect(() =>
      craftTermSchema.parse({ ...sampleTerm, status: 'merged', mergedInto: 'term-ffffffff' }),
    ).not.toThrow();
    expect(() => craftTermSchema.parse({ ...sampleTerm, mergedInto: null })).not.toThrow();
  });

  it('category 同受控 13 类（词目不放大类自由度）', () => {
    expect(() => craftTermSchema.parse({ ...sampleTerm, category: 'sucai' })).not.toThrow();
    expect(() => craftTermSchema.parse({ ...sampleTerm, category: 'playbook' })).toThrow();
  });
});

describe('CRAFT_TERM_SEEDS — 五白话散并位（epics.md:881 指派全承接）', () => {
  it('五种子 + 名字唯一 + 类目合法', () => {
    expect(CRAFT_TERM_SEEDS).toHaveLength(5);
    const names = CRAFT_TERM_SEEDS.map((s) => s.name);
    expect(new Set(names).size).toBe(5);
    for (const seed of CRAFT_TERM_SEEDS) {
      expect(craftCardCategorySchema.safeParse(seed.category).success, seed.name).toBe(true);
    }
  });

  it('散并指派落位：人设×2 / 结构打法×2 / 期待感管理×1（节奏调剂子型对齐注记）', () => {
    const byCategory = new Map<string, string[]>();
    for (const s of CRAFT_TERM_SEEDS) {
      byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s.name]);
    }
    expect(byCategory.get('renshe')).toEqual(expect.arrayContaining(['人物对照组', '角色声纹']));
    expect(byCategory.get('jiegoudafa')).toEqual(expect.arrayContaining(['同类场景变奏', '固定调度模式']));
    expect(byCategory.get('qidaigan')).toEqual(['节奏调剂子型']);
  });
});
