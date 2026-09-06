import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CraftCard, CraftHit } from '@orison/shared-contracts';

// Mirror of queryStoryHandler.test.ts: mock the handler's only real dependencies
// (searchCraft + logger) so the suite runs under plain vitest with NO DB / network.
// Story 10.1 check（F-02 消费缝）：materialIndexer 经 handler 内 lazy 动态引入消费——此处
// mock 之（vi.mock 对动态 import 同样拦截），保持本套件零 db/electron 模块图。
// E10.2b W4.1：closureCraftCardRepository / closureCraftTermRepository 同为 lazy 动态引入
// 消费——同法 mock（decodeCardCraftId 是纯 regex 解码，直接内联真实现防测试与生产漂移）。
const { searchCraft, warn, lookupMaterialChunkSpans, getMaterialRow, getCraftCard, getCraftTerm } =
  vi.hoisted(() => ({
    searchCraft: vi.fn(),
    warn: vi.fn(),
    lookupMaterialChunkSpans: vi.fn(),
    getMaterialRow: vi.fn(),
    getCraftCard: vi.fn(),
    getCraftTerm: vi.fn(),
  }));

vi.mock('../main/db/closureCraftRetrieval', () => ({ searchCraft }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));
vi.mock('../main/db/materialIndexer', () => ({ lookupMaterialChunkSpans, getMaterialRow }));
vi.mock('../main/db/closureCraftCardRepository', () => ({
  // 真实现内联（regex 解码无依赖——mock 工厂里手抄会漂移）。
  decodeCardCraftId: (craftId: string) => {
    const m = /^card:(card-[0-9a-f]{12})$/.exec(craftId);
    return m === null ? null : m[1]!;
  },
  getCraftCard,
  craftCategoryGlossLabel: (category: string) => (category === 'qingxu' ? '情绪手法' : category),
}));
vi.mock('../main/db/closureCraftTermRepository', () => ({ getCraftTerm }));

import { queryCraftHandler, formatCraftHitsForLlm } from '../main/ipc/toolHandlers/closureCraftHandlers';

function makeHit(overrides: Partial<CraftHit> = {}): CraftHit {
  return {
    craftId: 'shuangdian-catalog',
    craftType: 'shuangdian',
    sourceKind: 'user',
    name: '爽点目录',
    bodyText: '爽点三层：即时/累积/终极',
    score: 0.0328,
    ...overrides,
  };
}

/** E10.2b W4.1：craftCardSchema 合法形态的测试卡（overrides 浅并）。 */
function makeCard(overrides: Partial<CraftCard> = {}): CraftCard {
  return {
    cardId: 'card-0123456789ab',
    category: 'qingxu',
    termId: 'term-01234567',
    title: '先抑后扬三层回报',
    claim: {
      condensed: '先压低处境再给回报，回报强度与压抑时长成正比。',
      points: ['压抑段控制在一章内'],
      scenarios: ['开篇钩子'],
      counterexamples: ['全程压抑无回报'],
    },
    tags: ['爽文', '情绪'],
    teachings: [
      {
        teachingId: 'tea-0123456789ab',
        materialId: 'mat-0123456789ab',
        materialContentHash: `sha256:${'a'.repeat(64)}`,
        author: '老作者',
        quote: '先抑后扬的关键是压抑的度，不是压抑的时长。',
        anchor: { chapterIndex: 0, charStart: 120, charEnd: 480, paraStart: 3, paraEnd: 6 },
        rank: 'normal',
        note: null,
        stale: false,
      },
    ],
    dispute: false,
    status: 'verified',
    rejectReason: null,
    confidence: 0.8,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeCardHit(overrides: Partial<CraftHit> = {}): CraftHit {
  return makeHit({
    craftId: 'card:card-0123456789ab',
    craftType: 'qingxu',
    sourceKind: 'craft_card',
    name: '先抑后扬三层回报',
    bodyText: '词目：先抑后扬\n大类：情绪手法\n招式：先抑后扬三层回报\n主张：……',
    ...overrides,
  });
}

function ctx(params: Record<string, unknown>, projectDir = '/proj/alpha') {
  return {
    params,
    projectDir,
    sessionId: 's1',
    abort: new AbortController().signal,
  };
}

describe('queryCraftHandler (Story 2.1)', () => {
  beforeEach(() => {
    searchCraft.mockReset();
    warn.mockReset();
    lookupMaterialChunkSpans.mockReset();
    lookupMaterialChunkSpans.mockReturnValue(new Map());
    getMaterialRow.mockReset();
    getCraftCard.mockReset();
    getCraftTerm.mockReset();
  });

  it('query + hits -> output carries hit names, metadata.count + hits array (NO projectId resolved)', async () => {
    const hits = [
      makeHit(),
      makeHit({ craftId: 'jinzhishao-7types', name: '金手指7类', craftType: 'jinzhishao', score: 0.0164 }),
    ];
    searchCraft.mockResolvedValue(hits);

    const result = await queryCraftHandler(ctx({ query: '爽点设计' }));

    expect(result.title).toContain('query_craft');
    expect(result.output).toContain('爽点目录');
    expect(result.output).toContain('金手指7类');
    expect(result.metadata?.count).toBe(2);
    expect(result.metadata?.hits).toBe(hits);
    // searchCraft received the raw query + passthrough opts. NO projectId (global).
    expect(searchCraft).toHaveBeenCalledOnce();
    expect(searchCraft).toHaveBeenCalledWith('爽点设计', { craftType: undefined, k: 10 });
  });

  it('empty / whitespace query -> "请提供检索查询", count 0, no retrieval call', async () => {
    const empty = await queryCraftHandler(ctx({ query: '' }));
    expect(empty.output).toBe('请提供检索查询。');
    expect(empty.metadata?.count).toBe(0);

    const blank = await queryCraftHandler(ctx({ query: '   ' }));
    expect(blank.output).toBe('请提供检索查询。');
    expect(blank.metadata?.count).toBe(0);

    expect(searchCraft).not.toHaveBeenCalled();
  });

  it('searchCraft throws -> handler catches, returns error message, never rejects', async () => {
    searchCraft.mockRejectedValue(new Error('vec0 exploded'));

    const result = await queryCraftHandler(ctx({ query: '爽点' }));

    expect(result.output).toBe('检索失败: vec0 exploded');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.hits).toEqual([]);
    expect(result.metadata?.error).toBe('vec0 exploded');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes craft_type + k through to searchCraft as { craftType, k }', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: '金手指', craft_type: 'jinzhishao', k: 5 }));
    expect(searchCraft).toHaveBeenCalledWith('金手指', { craftType: 'jinzhishao', k: 5 });
  });

  // k validation (closureCraftQuerySchema clamps k to [1, 50], mirror CR-08)
  it('clamps k=-1 to 1', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x', k: -1 }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: undefined, k: 1 });
  });

  it('clamps k=999 down to 50', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x', k: 999 }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: undefined, k: 50 });
  });

  it('defaults k to 10 when omitted', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x' }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: undefined, k: 10 });
  });

  it('rejects malformed params (non-string query) with a friendly message, never throws', async () => {
    const result = await queryCraftHandler(ctx({ query: 12345 }));
    expect(result.output).toBe('检索参数无效，请提供查询文本。');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.hits).toEqual([]);
    expect(searchCraft).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('accepts a custom craft_type (non-closed enum - user self-registers new classes)', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: 'x', craft_type: 'custom-new-class' }));
    expect(searchCraft).toHaveBeenCalledWith('x', { craftType: 'custom-new-class', k: 10 });
  });

  // ── Story 10.1 check（F-02 消费缝，design §3.2）：材料 chunk 命中附 span 脚注 ──

  it('材料命中（craft_id `mat:` 前缀）→ lookupMaterialChunkSpans 回查 + 输出原文定位脚注', async () => {
    const craftId = 'mat:mat-0123456789ab.ch0#c1';
    const span = {
      chapterIndex: 0,
      chunkIndex: 1,
      charStart: 120,
      charEnd: 480,
      paraStart: 3,
      paraEnd: 6,
    };
    searchCraft.mockResolvedValue([makeHit({ craftId, craftType: 'material', name: '讲义·第1章·c1' })]);
    lookupMaterialChunkSpans.mockReturnValue(new Map([[craftId, span]]));
    const result = await queryCraftHandler(ctx({ query: '讲义' }));
    expect(lookupMaterialChunkSpans).toHaveBeenCalledWith([craftId]);
    expect(result.output).toContain('原文定位: 段落 3–6 · 字符 120–480');
  });

  it('无材料命中（零 mat: 前缀）→ 零回查开销（快径不触发动态引入链）', async () => {
    searchCraft.mockResolvedValue([makeHit()]);
    await queryCraftHandler(ctx({ query: '爽点' }));
    expect(lookupMaterialChunkSpans).not.toHaveBeenCalled();
  });

  it('回查抛错/登记行缺失 → 脚注缺席但命中照常渲染（best-effort 绝不阻渲染）', async () => {
    searchCraft.mockResolvedValue([makeHit({ craftId: 'mat:mat-ffffffffffff.ch0#c0', craftType: 'material' })]);
    lookupMaterialChunkSpans.mockReturnValue(new Map()); // 登记行缺失 → 空 map
    const result = await queryCraftHandler(ctx({ query: 'x' }));
    expect(result.output).toContain('## '); // 命中块照常渲染
    expect(result.output).not.toContain('原文定位');
    lookupMaterialChunkSpans.mockImplementation(() => {
      throw new Error('db down');
    });
    const result2 = await queryCraftHandler(ctx({ query: 'x' }));
    expect(result2.output).toContain('## ');
    expect(result2.output).not.toContain('原文定位');
  });

  // ── E10.2b W4.2（R10）：tags 参数透传 + 纯标签浏览 ──

  it('tags 透传 searchCraft（{craftType, tags, k}）', async () => {
    searchCraft.mockResolvedValue([]);
    await queryCraftHandler(ctx({ query: '情绪', tags: ['爽文', '都市'], k: 5 }));
    expect(searchCraft).toHaveBeenCalledWith('情绪', { craftType: undefined, tags: ['爽文', '都市'], k: 5 });
  });

  it('纯标签浏览：query 空 + tags 在场 → 守卫放行 + miss 文案按标签（title 同步）', async () => {
    searchCraft.mockResolvedValue([]);
    const result = await queryCraftHandler(ctx({ query: '', tags: ['都市'] }));
    expect(searchCraft).toHaveBeenCalledWith('', { craftType: undefined, tags: ['都市'], k: 10 });
    expect(result.output).toBe('未找到匹配标签 #都市 的 craft 条目。');
    expect(result.title).toContain('#都市');
  });

  it('query 与 tags 皆空 → 既有「请提供检索查询」拦截不变（零回归）', async () => {
    const result = await queryCraftHandler(ctx({ query: '   ' }));
    expect(result.output).toBe('请提供检索查询。');
    expect(searchCraft).not.toHaveBeenCalled();
  });

  it('空 tags 数组不构成纯标签浏览（视同无 tags，空 query 照拦）', async () => {
    const result = await queryCraftHandler(ctx({ query: '', tags: [] }));
    expect(result.output).toBe('请提供检索查询。');
    expect(searchCraft).not.toHaveBeenCalled();
  });

  // ── E10.2b W4.1：卡命中渲染（回查链 + 混合渲染 + 降级三分支）──

  it('卡/doc 混合命中 → 卡块（头部/四件套/标签行/讲法+锚点脚注）与 doc 块并存渲染', async () => {
    searchCraft.mockResolvedValue([makeCardHit(), makeHit()]);
    getCraftCard.mockReturnValue(makeCard());
    getCraftTerm.mockReturnValue({
      termId: 'term-01234567',
      category: 'qingxu',
      name: '先抑后扬',
      status: 'active',
      mergedInto: null,
      note: null,
    });
    getMaterialRow.mockReturnValue({
      materialId: 'mat-0123456789ab',
      name: '网文经验谈·第3期',
    });
    const result = await queryCraftHandler(ctx({ query: '先抑后扬' }));
    // 卡块：头部 = title（大类 gloss·词目名）。
    expect(result.output).toContain('## 先抑后扬三层回报（情绪手法·先抑后扬）');
    // 卡块：condensed 四件套。
    expect(result.output).toContain('主张：先压低处境再给回报，回报强度与压抑时长成正比。');
    expect(result.output).toContain('操作要点：');
    expect(result.output).toContain('- 压抑段控制在一章内');
    expect(result.output).toContain('反例：');
    // 卡块：tags 标注行（R10 标签发现机制）。
    expect(result.output).toContain('标签: #爽文 #情绪');
    // 卡块：讲法 author + 引文 + 锚点脚注（含材料名）。
    expect(result.output).toContain('「先抑后扬的关键是压抑的度，不是压抑的时长。」（老作者）');
    expect(result.output).toContain(
      '_原文定位: 段落 3–6 · 字符 120–480（材料「网文经验谈·第3期」派生 .md 基面，可回原文）_',
    );
    // doc 块零改动并存。
    expect(result.output).toContain('## 爽点目录 (shuangdian)');
    // 回查链调用形态。
    expect(getCraftCard).toHaveBeenCalledWith('card-0123456789ab');
    expect(getCraftTerm).toHaveBeenCalledWith('term-01234567');
    expect(getMaterialRow).toHaveBeenCalledWith('mat-0123456789ab');
  });

  it('卡失效（回查 null）→ 该命中降级跳过 + warn 留痕，其余 doc 命中照常', async () => {
    searchCraft.mockResolvedValue([makeCardHit(), makeHit()]);
    getCraftCard.mockReturnValue(null);
    const result = await queryCraftHandler(ctx({ query: 'x' }));
    expect(result.output).toContain('## 爽点目录 (shuangdian)');
    expect(result.output).not.toContain('先抑后扬三层回报');
    expect(result.output).not.toContain('命中的手艺卡已删除'); // 尚有 doc 块，非全空形态
    expect(warn).toHaveBeenCalled();
  });

  it('状态漂移（回查到非 verified 卡）→ 降级跳过（entry 行只应 verified 存在的 belt）', async () => {
    searchCraft.mockResolvedValue([makeCardHit()]);
    getCraftCard.mockReturnValue(makeCard({ status: 'pending_review' }));
    const result = await queryCraftHandler(ctx({ query: 'x' }));
    expect(result.output).toBe('命中的手艺卡已删除或审阅状态已变化，本次无可注入的手艺内容。');
    expect(warn).toHaveBeenCalled();
  });

  it('回查缝整体抛错 → 卡行走 entry body 兜底渲染（doc 形态，不静默丢块）', async () => {
    searchCraft.mockResolvedValue([makeCardHit()]);
    getCraftCard.mockImplementation(() => {
      throw new Error('db down');
    });
    const result = await queryCraftHandler(ctx({ query: 'x' }));
    expect(result.output).toContain('## 先抑后扬三层回报 (qingxu)');
    expect(result.output).toContain('词目：先抑后扬');
    expect(result.output).not.toContain('标签:');
  });

  it('词目行/材料行缺失 → 头部省词目段、脚注退基面形态（防御性 null）', async () => {
    searchCraft.mockResolvedValue([makeCardHit()]);
    getCraftCard.mockReturnValue(makeCard());
    getCraftTerm.mockReturnValue(null);
    getMaterialRow.mockReturnValue(null);
    const result = await queryCraftHandler(ctx({ query: 'x' }));
    expect(result.output).toContain('## 先抑后扬三层回报（情绪手法）');
    expect(result.output).toContain(
      '_原文定位: 段落 3–6 · 字符 120–480（材料派生 .md 基面，可回原文）_',
    );
  });

  it('零 card: 命中 → 零卡回查开销（快径不触发 lazy 引入链）', async () => {
    searchCraft.mockResolvedValue([makeHit()]);
    await queryCraftHandler(ctx({ query: '爽点' }));
    expect(getCraftCard).not.toHaveBeenCalled();
    expect(getMaterialRow).not.toHaveBeenCalled();
  });
});

describe('formatCraftHitsForLlm (Story 2.1)', () => {
  it('empty hits -> explicit "no matches" line quoting the query', () => {
    expect(formatCraftHitsForLlm('爽点', [])).toBe('未找到与 "爽点" 相关的 craft 文档。');
  });

  it('renders a hit block with name + craft_type + relevance footer', () => {
    const out = formatCraftHitsForLlm('爽点', [
      makeHit({ score: 0.0328, vecDistance: 0.001, rerankScore: 0.9 }),
    ]);
    expect(out).toContain('## 爽点目录 (shuangdian)');
    expect(out).toContain('爽点三层');
    expect(out).toContain('_相关性: 0.0328 vec=0.001 rerank=0.900_');
  });

  it('omits vec/rerank segments when those arms did not run', () => {
    const out = formatCraftHitsForLlm('爽点', [makeHit({ score: 0.0164 })]);
    expect(out).toContain('_相关性: 0.0164_');
    expect(out).not.toContain('vec=');
    expect(out).not.toContain('rerank=');
  });

  it('caps body_text at ~800 chars with an ellipsis', () => {
    const long = 'x'.repeat(900);
    const out = formatCraftHitsForLlm('q', [makeHit({ bodyText: long })]);
    expect(out).toContain('x'.repeat(800) + '…');
    expect(out).not.toContain('x'.repeat(900));
  });

  // ── Story 10.1 check（F-02）：spanNotes 参数形态（纯函数——缺省不出脚注 / 命中出脚注）──

  it('spanNotes 命中 → 脚注行（段落/字符区间 + 材料派生 .md 基面说明）；缺省参数无脚注', () => {
    const craftId = 'mat:mat-0123456789ab.ch2#c0';
    const hit = makeHit({ craftId, craftType: 'material', name: '讲义·第3章·c0' });
    const span = { chapterIndex: 2, chunkIndex: 0, charStart: 900, charEnd: 1300, paraStart: 8, paraEnd: 11 };
    const out = formatCraftHitsForLlm('讲义', [hit], new Map([[craftId, span]]));
    expect(out).toContain('_原文定位: 段落 8–11 · 字符 900–1300（材料派生 .md 基面，可回原文）_');
    // 缺省（无材料命中场景）与 map 未命中同形——不出脚注。
    expect(formatCraftHitsForLlm('讲义', [hit])).not.toContain('原文定位');
    expect(formatCraftHitsForLlm('讲义', [hit], new Map())).not.toContain('原文定位');
  });

  // ── E10.2b W4.1（纯函数）：卡块 rank 过滤三分支 + 渲染边界 ──

  function cardCtxOf(card: CraftCard, materialNames: ReadonlyMap<string, string | null> = new Map()) {
    return {
      notes: new Map([['card:card-0123456789ab', { card, termName: '先抑后扬', categoryGloss: '情绪手法' }]]),
      materialNames,
    };
  }

  function teachingOf(overrides: Partial<CraftCard['teachings'][number]> = {}): CraftCard['teachings'][number] {
    return {
      teachingId: 'tea-0123456789ab',
      materialId: 'mat-0123456789ab',
      materialContentHash: `sha256:${'a'.repeat(64)}`,
      author: null,
      quote: '引文甲',
      anchor: { chapterIndex: 0, charStart: 0, charEnd: 10, paraStart: 0, paraEnd: 1 },
      rank: 'normal',
      note: null,
      stale: false,
      ...overrides,
    };
  }

  it('rank 全 normal → 讲法并排（各自带锚点脚注）', () => {
    const card = makeCard({
      teachings: [
        teachingOf({ teachingId: 'tea-000000000001', author: '作者A', quote: '讲法一引文' }),
        teachingOf({ teachingId: 'tea-000000000002', author: '作者B', quote: '讲法二引文' }),
      ],
    });
    const out = formatCraftHitsForLlm('q', [makeCardHit()], undefined, cardCtxOf(card));
    expect(out).toContain('1. 「讲法一引文」（作者A）');
    expect(out).toContain('2. 「讲法二引文」（作者B）');
  });

  it('rank 有 approved → 只注 approved（normal 不注）', () => {
    const card = makeCard({
      teachings: [
        teachingOf({ teachingId: 'tea-000000000001', rank: 'approved', author: '作者A', quote: '认可讲法' }),
        teachingOf({ teachingId: 'tea-000000000002', rank: 'normal', author: '作者B', quote: '普通讲法' }),
      ],
    });
    const out = formatCraftHitsForLlm('q', [makeCardHit()], undefined, cardCtxOf(card));
    expect(out).toContain('认可讲法');
    expect(out).not.toContain('普通讲法');
  });

  it('rank rejected 不注（保留在卡表但注入面缺席）；全 rejected → 无讲法段（卡仍渲染）', () => {
    const card = makeCard({
      teachings: [
        teachingOf({ teachingId: 'tea-000000000001', rank: 'normal', quote: '普通讲法' }),
        teachingOf({ teachingId: 'tea-000000000002', rank: 'rejected', quote: '不认可讲法', note: '过时' }),
      ],
    });
    const out = formatCraftHitsForLlm('q', [makeCardHit()], undefined, cardCtxOf(card));
    expect(out).toContain('普通讲法');
    expect(out).not.toContain('不认可讲法');

    const allRejected = makeCard({
      teachings: [teachingOf({ teachingId: 'tea-000000000003', rank: 'rejected', quote: '唯一讲法' })],
    });
    const out2 = formatCraftHitsForLlm('q', [makeCardHit()], undefined, cardCtxOf(allRejected));
    expect(out2).toContain('## 先抑后扬三层回报（情绪手法·先抑后扬）'); // 卡块仍渲染
    expect(out2).not.toContain('讲法：');
  });

  it('卡块各段空集省略：空 tags 无标签行 / 空要点场景反例无对应段', () => {
    const card = makeCard({
      tags: [],
      claim: { condensed: '只有主张', points: [], scenarios: [], counterexamples: [] },
    });
    const out = formatCraftHitsForLlm('q', [makeCardHit()], undefined, cardCtxOf(card));
    expect(out).toContain('主张：只有主张');
    expect(out).not.toContain('标签:');
    expect(out).not.toContain('操作要点');
    expect(out).not.toContain('适用场景');
    expect(out).not.toContain('反例');
  });

  it('讲法引文超 120 字截断（片段形态）+ condensed 超 800 截断', () => {
    const card = makeCard({
      claim: { condensed: '主'.repeat(900), points: [], scenarios: [], counterexamples: [] },
      teachings: [teachingOf({ quote: '引'.repeat(200) })],
    });
    const out = formatCraftHitsForLlm('q', [makeCardHit()], undefined, cardCtxOf(card));
    expect(out).toContain(`「${'引'.repeat(120)}…」`);
    expect(out).not.toContain('引'.repeat(121));
    expect(out).toContain(`主张：${'主'.repeat(800)}…`);
  });

  it('cardCtx 缺省（回查缝失败形态）→ 卡行 doc 兜底渲染；note 缺席（卡删/漂移）→ 跳过成全空文案', () => {
    const hit = makeCardHit();
    const fallback = formatCraftHitsForLlm('q', [hit]);
    expect(fallback).toContain(`## ${hit.name} (${hit.craftType})`); // doc 形态
    const skipped = formatCraftHitsForLlm('q', [hit], undefined, { notes: new Map(), materialNames: new Map() });
    expect(skipped).toBe('命中的手艺卡已删除或审阅状态已变化，本次无可注入的手艺内容。');
  });
});
