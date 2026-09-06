import { describe, expect, it } from 'vitest';
import {
  DECON_CANON_DOMAINS,
  DECON_CRAFT_DIMENSION_IDS,
  DECON_DIMENSIONS,
  DECON_DIMENSION_IDS,
  DECON_EMOTIONAL_BEATS,
  DECON_HOOK_TYPES,
  DECON_INFO_GAP_TYPES,
  DECON_JOB_INFLIGHT_STATUSES,
  DECON_JOB_STATUSES,
  DECON_PLOT_PHASES,
  DECON_PRODUCT_UNIT_PATTERN,
  DECON_REPORT_KINDS,
  DECON_REPORT_UNIT_PATTERN,
  DECON_REVIEW_CHECKPOINTS,
  DECON_REVIEW_STATUSES,
  DECON_STYLE_LLM_SECTION_KEYS,
  DECON_STYLE_SECTION_KEYS,
  DECON_TIMELINE_CONSISTENCY,
  DECON_TRANSITION_TYPES,
  deconArcsPayloadSchema,
  deconCanonEntrySchema,
  deconChapterFactsSchema,
  deconChapterLabelsSchema,
  deconDictionarySchema,
  deconDistributionSchema,
  deconEntitySchema,
  deconFindingsSchema,
  deconFactsSchema,
  deconJobSchema,
  deconMaterialRefSchema,
  deconPassStateSchema,
  deconProductRowSchema,
  deconReportRowSchema,
  deconReviewRowSchema,
  deconStatsPayloadSchema,
  deconStylePayloadSchema,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// E10.3a W1：拆解管线契约（job/pass 状态、canon 六域、事实层三表、信息差 6 型正典枚举、
// 无锚不立行 / 无锚即丢 的 schema 半边）。
// ─────────────────────────────────────────────────────────────────────────────

const SPAN = { chapterIndex: 0, charStart: 10, charEnd: 30, paraStart: 1, paraEnd: 2 };
const HASH = `sha256:${'a'.repeat(64)}`;
const MAT_REF = 'global:mat-000000000001';

function sampleJob(over: Record<string, unknown> = {}) {
  return {
    jobId: 'decon-000000000001',
    materialRef: MAT_REF,
    tier: 'fine',
    dimensions: ['qidaigan'],
    status: 'running',
    budget: { totalTokens: 100_000, perPass: { p1b: 50_000 } },
    cost: { totalTokens: 0, calls: 0, byPass: {} },
    materialContentHash: HASH,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    error: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

function sampleFacts(over: Record<string, unknown> = {}) {
  return {
    synopsis: '李三挖出旧物，来历不明。',
    entities: [{ name: '李三', type: 'person', span: SPAN }],
    events: [{ what: '挖出旧物', span: SPAN, kernel: true }],
    relationshipEdges: [{ from: '李三', to: '王五', kind: '师徒', span: SPAN }],
    foreshadowPlanted: [{ hint: '旧物来历不明', span: SPAN }],
    infoGap: [{ type: '悬疑未知', span: SPAN }],
    ...over,
  };
}

describe('deconJobSchema — 拆解会话行', () => {
  it('合法行 parse 通过（含双指纹/error/预算成本 JSON 域）', () => {
    const job = deconJobSchema.parse(sampleJob());
    expect(job.materialRef).toBe(MAT_REF);
    expect(job.budget.perPass.p1b).toBe(50_000);
  });

  it('档位/状态/指纹格式越界均拒（DDL CHECK 的 zod 单源面）', () => {
    expect(() => deconJobSchema.parse(sampleJob({ tier: 'ultra' }))).toThrow();
    expect(() => deconJobSchema.parse(sampleJob({ status: 'queued' }))).toThrow();
    expect(() => deconJobSchema.parse(sampleJob({ materialContentHash: 'deadbeef' }))).toThrow();
    expect(() => deconJobSchema.parse(sampleJob({ derivedHash: 'sha256:xyz' }))).toThrow();
    expect(() => deconJobSchema.parse(sampleJob({ jobId: 'job-1' }))).toThrow();
  });

  it('状态枚举含 W2 状态机全集；inflight 集是其子集（pending/running/paused/capped）', () => {
    expect(DECON_JOB_STATUSES).toEqual([
      'pending',
      'running',
      'paused',
      'done',
      'failed',
      'capped',
      'stale',
      'cancelled',
    ]);
    for (const s of DECON_JOB_INFLIGHT_STATUSES) expect(DECON_JOB_STATUSES).toContain(s);
    expect(DECON_JOB_INFLIGHT_STATUSES).not.toContain('done');
  });

  it('material_ref 轨+id 形态：global / project:<5位> 两轨合法，坏轨拒', () => {
    expect(deconMaterialRefSchema.safeParse('global:mat-000000000001').success).toBe(true);
    expect(deconMaterialRefSchema.safeParse('project:00123:mat-000000000001').success).toBe(true);
    expect(deconMaterialRefSchema.safeParse('project:123:mat-000000000001').success).toBe(false);
    expect(deconMaterialRefSchema.safeParse('mat-000000000001').success).toBe(false);
    expect(deconMaterialRefSchema.safeParse('global:card-000000000001').success).toBe(false);
  });
});

describe('deconPassStateSchema — 断点状态行', () => {
  function samplePass(over: Record<string, unknown> = {}) {
    return {
      jobId: 'decon-000000000001',
      pass: 'p1b',
      unit: '3',
      status: 'done',
      outputRef: 'facts:3',
      outputHash: HASH,
      updatedAt: '2026-09-05T10:00:00.000Z',
      ...over,
    };
  }

  it('child A 四 pass + child B 预留（p3a/p3b/p4:<dim>/p5:<kind>/p6）全合法', () => {
    for (const pass of ['p1a', 'p1b', 'p1c', 'p2', 'p3a', 'p3b', 'p6', 'p4:huoke', 'p5:scene_annotation']) {
      expect(deconPassStateSchema.safeParse(samplePass({ pass })).success).toBe(true);
    }
  });

  it('裸 p4/p5（缺后缀）与未声明 pass 拒', () => {
    for (const pass of ['p4', 'p5', 'p7', 'p1', 'p1d', 'p4:HUOKE', '']) {
      expect(deconPassStateSchema.safeParse(samplePass({ pass })).success).toBe(false);
    }
  });

  it('状态枚举封闭（pending/running/done/failed/capped）', () => {
    expect(() => deconPassStateSchema.parse(samplePass({ status: 'stale' }))).toThrow();
    expect(() => deconPassStateSchema.parse(samplePass({ status: 'paused' }))).toThrow();
  });
});

describe('deconFactsSchema — P1b 逐章事实（无锚即丢 schema 半边）', () => {
  it('合法 facts parse 通过（六段全带 span）', () => {
    const facts = deconFactsSchema.parse(sampleFacts());
    expect(facts.events[0]?.kernel).toBe(true);
  });

  it('无锚即丢：entities/events/relationshipEdges/foreshadowPlanted/infoGap 任一项缺 span 拒', () => {
    expect(() => deconFactsSchema.parse(sampleFacts({ entities: [{ name: '李三', type: 'person' }] }))).toThrow();
    expect(() => deconFactsSchema.parse(sampleFacts({ events: [{ what: '挖出旧物', kernel: true }] }))).toThrow();
    expect(() => deconFactsSchema.parse(sampleFacts({ foreshadowPlanted: [{ hint: '旧物' }] }))).toThrow();
    expect(() => deconFactsSchema.parse(sampleFacts({ infoGap: [{ type: '悬疑未知' }] }))).toThrow();
  });

  it('信息差 6 型正典枚举（中文词形）；越界值拒', () => {
    expect(DECON_INFO_GAP_TYPES).toHaveLength(6);
    for (const type of DECON_INFO_GAP_TYPES) {
      expect(deconFactsSchema.safeParse(sampleFacts({ infoGap: [{ type, span: SPAN }] })).success).toBe(true);
    }
    expect(deconFactsSchema.safeParse(sampleFacts({ infoGap: [{ type: '未知型', span: SPAN }] })).success).toBe(false);
  });

  it('kernel 可选（缺省非 unknown——不写暗示已判的标记）；synopsis 非空', () => {
    const facts = deconFactsSchema.parse(sampleFacts({ events: [{ what: '闲笔', span: SPAN }] }));
    expect(facts.events[0]?.kernel).toBeUndefined();
    expect(() => deconFactsSchema.parse(sampleFacts({ synopsis: '' }))).toThrow();
  });

  it('实体五类封闭枚举', () => {
    expect(() => deconFactsSchema.parse(sampleFacts({ entities: [{ name: 'x', type: 'idea', span: SPAN }] }))).toThrow();
  });

  it('deconChapterFactsSchema 材料级键控行（ref+hash+章号）', () => {
    const row = deconChapterFactsSchema.parse({
      materialRef: MAT_REF,
      derivedHash: HASH,
      chapterIndex: 2,
      facts: sampleFacts(),
    });
    expect(row.chapterIndex).toBe(2);
    expect(() =>
      deconChapterFactsSchema.parse({ materialRef: MAT_REF, derivedHash: 'nothash', chapterIndex: 2, facts: sampleFacts() }),
    ).toThrow();
  });
});

describe('deconEntitySchema / deconDictionarySchema — P1c/P1a 行', () => {
  it('聚合实体行（别名/出现/审计）parse 通过；类型 CHECK 枚举封闭', () => {
    const entity = deconEntitySchema.parse({
      materialRef: MAT_REF,
      derivedHash: HASH,
      canonicalName: '李三',
      type: 'person',
      aliases: ['三哥'],
      mentions: [{ chapterIndex: 0, count: 3 }],
      audit: { hallucinationFiltered: false, mergedFrom: ['李三', '三哥'], typeVotes: { person: 3 } },
    });
    expect(entity.audit.mergedFrom).toHaveLength(2);
    expect(() =>
      deconEntitySchema.parse({
        materialRef: MAT_REF,
        derivedHash: HASH,
        canonicalName: 'x',
        type: 'faction',
        aliases: [],
        mentions: [],
        audit: {},
      }),
    ).toThrow();
  });

  it('词典行（候选分类产物：五类 + 置信 0-1）', () => {
    const dict = deconDictionarySchema.parse({
      materialRef: MAT_REF,
      derivedHash: HASH,
      entries: [
        { name: '李三', type: 'person', confidence: 0.9 },
        { name: '青云观', type: 'place', confidence: 0 },
      ],
    });
    expect(dict.entries).toHaveLength(2);
    expect(() =>
      deconDictionarySchema.parse({
        materialRef: MAT_REF,
        derivedHash: HASH,
        entries: [{ name: '李三', type: 'person', confidence: 1.5 }],
      }),
    ).toThrow();
  });
});

describe('deconCanonEntrySchema — canon 六域（无锚不立行）', () => {
  function sampleCanon(over: Record<string, unknown> = {}) {
    return {
      jobId: 'decon-000000000001',
      domain: 'world',
      name: '大陆',
      payload: { evidence: 'inferred', summary: '东洲大陆' },
      anchors: [SPAN],
      provenance: { source: 'decon', materialId: 'mat-000000000001', bookTitle: '测试小说' },
      ...over,
    };
  }

  it('六域封闭枚举 + 时间线容错三档', () => {
    expect(DECON_CANON_DOMAINS).toEqual(['world', 'rule', 'character', 'tone', 'timeline', 'relationship']);
    expect(DECON_TIMELINE_CONSISTENCY).toEqual(['exact', 'intentional_loose', 'conflict']);
  });

  it('合法条目 parse 通过；payload 域内自由形状（passthrough）+ evidence 硬字段', () => {
    const entry = deconCanonEntrySchema.parse(
      sampleCanon({ domain: 'character', payload: { evidence: 'exact', traits: [{ name: '重情', mutability: 'immutable' }] } }),
    );
    expect(entry.payload).toMatchObject({ evidence: 'exact' });
  });

  it('无锚不立行：anchors 空数组拒（zod min(1) 强约束）', () => {
    expect(() => deconCanonEntrySchema.parse(sampleCanon({ anchors: [] }))).toThrow();
  });

  it('payload 缺 evidence 拒（F-13 证据分级硬字段）', () => {
    expect(() => deconCanonEntrySchema.parse(sampleCanon({ payload: { summary: '无证据字段' } }))).toThrow();
    expect(() => deconCanonEntrySchema.parse(sampleCanon({ payload: { evidence: 'maybe', summary: 'x' } }))).toThrow();
  });

  it("provenance：source 恒 'decon'（C8 原作出处）；异源拒", () => {
    expect(() =>
      deconCanonEntrySchema.parse(sampleCanon({ provenance: { source: 'community', materialId: 'mat-000000000001', bookTitle: null } })),
    ).toThrow();
    expect(() => deconCanonEntrySchema.parse(sampleCanon({ provenance: { source: 'decon', materialId: 'bad', bookTitle: null } }))).toThrow();
  });

  it('timeline 域 payload 预期形状（consistency 三档——契约注释预留的硬半边经 passthrough 可携带）', () => {
    const entry = deconCanonEntrySchema.parse(
      sampleCanon({
        domain: 'timeline',
        name: '主线',
        payload: { evidence: 'exact', consistency: 'intentional_loose', conflictNote: null },
      }),
    );
    expect(entry.payload.consistency).toBe('intentional_loose');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E10.3b W1：child B 契约——维度目录 / P3a 打标正典枚举 / P4 findings / 三表行。
// ─────────────────────────────────────────────────────────────────────────────

describe('DECON_DIMENSIONS — 维度目录（12 手艺维 + 风格维，拍板②）', () => {
  it('13 项目录：id 全集一致、style 殿后、label/粒度面非空', () => {
    expect(DECON_DIMENSIONS).toHaveLength(13);
    expect(DECON_DIMENSIONS.map((d) => d.id)).toEqual([...DECON_DIMENSION_IDS]);
    expect(DECON_DIMENSION_IDS[DECON_DIMENSION_IDS.length - 1]).toBe('style');
    for (const dim of DECON_DIMENSIONS) {
      expect(dim.label.length).toBeGreaterThan(0);
      expect(dim.granularity.length).toBeGreaterThan(0);
    }
  });

  it('手艺维全集排除 style（12 项——deep 必含集 / p6 落卡候选计数排除面）', () => {
    expect(DECON_CRAFT_DIMENSION_IDS).toHaveLength(12);
    expect(DECON_CRAFT_DIMENSION_IDS).not.toContain('style');
  });

  it('parent §6.0 矩阵 12 维成员逐行在场（id slug 稳定面——契约漂移守卫）', () => {
    const expected = [
      'huoke',
      'qidaigan',
      'jiegou',
      'renshe',
      'shijieguan',
      'qingxu',
      'wenbi',
      'zaogeng',
      'xinxicha',
      'shijian',
      'fubi',
      'duizhao',
    ];
    expect([...DECON_CRAFT_DIMENSION_IDS]).toEqual(expected);
  });
});

describe('P3a 打标正典枚举（词形权威 = 写作思维原理原文，mirror digest 单源）', () => {
  it('钩子 11 型 / 转折 9 型 / 情绪 7 拍 / 四相位——数目与正典词形', () => {
    expect(DECON_HOOK_TYPES).toHaveLength(11);
    expect(DECON_TRANSITION_TYPES).toHaveLength(9);
    expect(DECON_EMOTIONAL_BEATS).toHaveLength(7);
    expect(DECON_PLOT_PHASES).toEqual(['拉仇恨', '积蓄', '释放', '落袋为安']);
    // 抽样钉死词形（防翻译漂移/臆造——原文核对 txt:535-553/484-521/829-886）。
    expect(DECON_HOOK_TYPES[0]).toBe('被迫压力钩');
    expect(DECON_HOOK_TYPES[10]).toBe('信息预期钩');
    expect(DECON_TRANSITION_TYPES[0]).toBe('阻碍转折');
    expect(DECON_TRANSITION_TYPES[8]).toBe('动态转折');
    expect(DECON_EMOTIONAL_BEATS).toContain('持续动态');
  });
});

describe('deconChapterLabelsSchema — P3a 逐章打标', () => {
  function sampleLabels(over: Record<string, unknown> = {}) {
    return {
      hooks: [{ type: '人前显圣钩', span: SPAN }],
      transitions: [{ type: '反差转折', span: SPAN }],
      emotionalBeats: [{ beat: '层层递进', span: SPAN }],
      plotPhase: '释放',
      highlightSpans: [SPAN],
      expositionSpans: [SPAN],
      arcBoundary: { isCandidate: true, confidence: 0.8, signal: '卷终大高潮' },
      ...over,
    };
  }

  it('合法打标全字段往返（span 级轻枚举事实标记）', () => {
    const labels = deconChapterLabelsSchema.parse(sampleLabels());
    expect(labels.plotPhase).toBe('释放');
    expect(labels.arcBoundary?.confidence).toBe(0.8);
  });

  it('钩子/转折带 other 兜底（集外命中可观测计数，不静默编造型号）', () => {
    const labels = deconChapterLabelsSchema.parse(
      sampleLabels({ hooks: [{ type: 'other', span: SPAN }], transitions: [{ type: 'other', span: SPAN }] }),
    );
    expect(labels.hooks[0]?.type).toBe('other');
    expect(labels.transitions[0]?.type).toBe('other');
  });

  it('情绪拍/四相位封闭枚举：越界值拒（无 other——情绪轴正典 7 拍全闭）', () => {
    expect(() => deconChapterLabelsSchema.parse(sampleLabels({ emotionalBeats: [{ beat: 'other', span: SPAN }] }))).toThrow();
    expect(() => deconChapterLabelsSchema.parse(sampleLabels({ plotPhase: '蓄力' }))).toThrow();
    // 四相位词形与情绪拍不通用（落袋为安 ∈ 四相位 / ∉ 7 拍）。
    expect(() => deconChapterLabelsSchema.parse(sampleLabels({ emotionalBeats: [{ beat: '落袋为安', span: SPAN }] }))).toThrow();
  });

  it('plotPhase / arcBoundary 可 null（无主导相位 / 无弧界候选的章）；confidence 越界拒', () => {
    const labels = deconChapterLabelsSchema.parse(sampleLabels({ plotPhase: null, arcBoundary: null }));
    expect(labels.plotPhase).toBeNull();
    expect(labels.arcBoundary).toBeNull();
    expect(() => deconChapterLabelsSchema.parse(sampleLabels({ arcBoundary: { isCandidate: true, confidence: 1.5 } }))).toThrow();
  });

  it('打标条目缺 span 拒（存的是已核验 span 形态——无锚即丢红线）', () => {
    expect(() => deconChapterLabelsSchema.parse(sampleLabels({ hooks: [{ type: 'other' }] }))).toThrow();
    expect(() => deconChapterLabelsSchema.parse(sampleLabels({ highlightSpans: [{}] }))).toThrow();
  });
});

describe('deconArcsPayloadSchema — P3b 弧切分（unit=arcs）', () => {
  function sampleArcs(over: Record<string, unknown> = {}) {
    return {
      arcs: [
        { index: 0, title: '第一卷 风起', fromChapter: 0, toChapter: 41, chapterCount: 42, charCount: 58_000, origin: 'volume' },
        { index: 1, title: null, fromChapter: 42, toChapter: 80, chapterCount: 39, charCount: 61_000, origin: 'volume' },
      ],
      audit: {
        source: 'volume',
        volumeBoundaries: [{ chapterIndex: 42, title: '第二卷 潮涌' }],
        candidatesTotal: 3,
        candidatesUsed: 0,
        arcsMerged: 1,
        arcsSplit: 0,
      },
      ...over,
    };
  }

  it('合法弧切分往返（卷名可 null / origin 三态 / 审计留痕）', () => {
    const parsed = deconArcsPayloadSchema.parse(sampleArcs());
    expect(parsed.arcs).toHaveLength(2);
    expect(parsed.arcs[1]?.title).toBeNull();
    expect(parsed.audit.source).toBe('volume');
  });

  it('形状违约拒：缺审计段 / origin 越界 / chapterCount 零', () => {
    expect(() => deconArcsPayloadSchema.parse({ arcs: sampleArcs().arcs })).toThrow();
    expect(() => deconArcsPayloadSchema.parse(sampleArcs({ arcs: [{ ...sampleArcs().arcs[0], origin: 'guess' }] }))).toThrow();
    expect(() => deconArcsPayloadSchema.parse(sampleArcs({ arcs: [{ ...sampleArcs().arcs[0], chapterCount: 0 }] }))).toThrow();
  });
});

describe('deconStatsPayloadSchema — P3b 统计族（unit=stats）', () => {
  function dist(over: Record<string, unknown> = {}) {
    return { count: 2, min: 120, avg: 140, max: 160, sigma: 20, ...over };
  }

  function sampleStats(over: Record<string, unknown> = {}) {
    return {
      book: {
        chapterCount: 42,
        charCount: 58_000,
        chapterChars: dist(),
        highlightCount: 2,
        highlightChars: dist(),
        highlightIntervalChapters: dist({ count: 1, min: 3, avg: 3, max: 3, sigma: 0 }),
        hooksByType: { 被迫压力钩: 1, other: 0 },
        transitionsByType: { 阻碍转折: 1, other: 0 },
        emotionalBeatsByType: { 拉扯: 1, 推动: 0 },
        infoGapByType: { 悬疑未知: 1, 信息前置: 0 },
        foreshadowPlantedCount: 3,
        foreshadowDensityPer10k: 0.52,
        expositionChars: dist(),
        hookToKernelChapterSpan: dist({ count: 2, min: 0, avg: 1, max: 2, sigma: 1 }),
      },
      arcs: [
        {
          index: 0,
          fromChapter: 0,
          toChapter: 41,
          chapterCount: 42,
          charCount: 58_000,
          chapterChars: dist(),
          hookCount: 1,
          transitionCount: 1,
          highlightCount: 2,
          emotionalBeatCount: 1,
          infoGapCount: 1,
          foreshadowPlantedCount: 3,
          plotPhaseCounts: { 拉仇恨: 1, 积蓄: 2, 释放: 0, 落袋为安: 0 },
        },
      ],
      styleStats: {
        sentenceChars: dist(),
        paragraphChars: dist(),
        dialogueLineRatio: 0.42,
      },
      ...over,
    };
  }

  it('合法统计族往返（书/弧/styleStats 三段 + by 型记录）', () => {
    const parsed = deconStatsPayloadSchema.parse(sampleStats());
    expect(parsed.book.infoGapByType['悬疑未知']).toBe(1);
    expect(parsed.arcs[0]?.plotPhaseCounts['积蓄']).toBe(2);
    expect(parsed.styleStats.dialogueLineRatio).toBeCloseTo(0.42);
  });

  it('形状违约拒：分布负值 / 对话占比越界 / 缺 book 段', () => {
    expect(() => deconStatsPayloadSchema.parse(sampleStats({ book: { ...sampleStats().book, chapterChars: dist({ min: -1 }) } }))).toThrow();
    expect(() => deconStatsPayloadSchema.parse(sampleStats({ styleStats: { ...sampleStats().styleStats, dialogueLineRatio: 1.5 } }))).toThrow();
    expect(() => deconStatsPayloadSchema.parse({ arcs: [], styleStats: sampleStats().styleStats })).toThrow();
  });

  it('deconDistributionSchema 空集约定（count=0 全 0——调用方免 null 分支）', () => {
    const empty = deconDistributionSchema.parse({ count: 0, min: 0, avg: 0, max: 0, sigma: 0 });
    expect(empty.count).toBe(0);
    expect(() => deconDistributionSchema.parse({ count: -1, min: 0, avg: 0, max: 0, sigma: 0 })).toThrow();
  });
});

describe('deconFindingsSchema — P4 问题单应答产物', () => {
  function sampleFinding(over: Record<string, unknown> = {}) {
    return {
      insight: '连续三章用「解决能力钩」抬高期待后单章释放',
      elaboration: '钩子在 2-3 章内反复出现且间隔稳定，释放章字数明显更长。这是稳定的期待感调度。',
      evidence: [{ paraRange: { start: 12, end: 18 }, quote: '他摸出了那枚玉佩' }],
      craftHint: { category: 'qidaigan', termHint: '钩子间隔', tags: ['期待感'] },
      ...over,
    };
  }

  it('合法 findings 往返（含 craftHint 落卡路由提示）', () => {
    const parsed = deconFindingsSchema.parse({ findings: [sampleFinding()], synthesis: '期待感调度稳定。' });
    expect(parsed.findings[0]?.craftHint?.category).toBe('qidaigan');
  });

  it('无锚即丢：evidence 空数组拒（min(1) 硬约束——R7/R8 红线）', () => {
    expect(() => deconFindingsSchema.parse({ findings: [sampleFinding({ evidence: [] })], synthesis: 'x' })).toThrow();
  });

  it('craftHint 可 null（不落卡发现）；category 越出 13 大类受控词表拒', () => {
    expect(deconFindingsSchema.parse({ findings: [sampleFinding({ craftHint: null })], synthesis: '' }).findings[0]?.craftHint).toBeNull();
    expect(() =>
      deconFindingsSchema.parse({ findings: [sampleFinding({ craftHint: { category: 'made-up' } })], synthesis: 'x' }),
    ).toThrow();
  });

  it('insight/elaboration 非空（孤句不立说——空结论拒）', () => {
    expect(() => deconFindingsSchema.parse({ findings: [sampleFinding({ insight: '' })], synthesis: 'x' })).toThrow();
    expect(() => deconFindingsSchema.parse({ findings: [sampleFinding({ elaboration: '' })], synthesis: 'x' })).toThrow();
  });
});

describe('deconStylePayloadSchema — P4 风格维 14 节 payload（E10.3b W3b）', () => {
  function sampleStyle(over: Record<string, unknown> = {}) {
    return {
      sections: {
        voice: '叙述者贴近主角的有限视角，平实带暖。',
        syntax: '短句推进，紧张处连续动词起句。',
        stats: '- 句子长度：均值 18.0 字',
        excerpt: '```text\n原文节选\n```',
        appendix: '来源：《某书》（材料 mat-000000000001）。',
      },
      excerptAnchors: [{ chapterIndex: 0, charStart: 0, charEnd: 42, paraStart: 0, paraEnd: 1 }],
      bookTitle: '某书',
      materialId: 'mat-000000000001',
      ...over,
    };
  }

  it('14 节语义键全集（值对齐 agent StyleSectionKey——shell 侧 parseStyleSections 对拍防漂移）；LLM 节 = 14 - 纯代码 3', () => {
    expect(DECON_STYLE_SECTION_KEYS).toHaveLength(14);
    expect(DECON_STYLE_LLM_SECTION_KEYS).toHaveLength(11);
    for (const k of DECON_STYLE_SECTION_KEYS) expect(typeof k).toBe('string');
    expect(DECON_STYLE_LLM_SECTION_KEYS).not.toContain('stats');
    expect(DECON_STYLE_LLM_SECTION_KEYS).not.toContain('excerpt');
    expect(DECON_STYLE_LLM_SECTION_KEYS).not.toContain('appendix');
  });

  it('合法 payload 往返（LLM 节可缺省——宁缺毋滥；纯代码三节必出）', () => {
    const parsed = deconStylePayloadSchema.parse(sampleStyle());
    expect(parsed.sections.voice).toContain('有限视角');
    // 仅 LLM 节 + 纯代码三节的合法最小形。
    expect(deconStylePayloadSchema.safeParse(sampleStyle({ sections: { voice: 'v', stats: 's', excerpt: 'e', appendix: 'a' } })).success).toBe(true);
  });

  it('refine：缺纯代码三节任一拒（确定性产物不缺省）', () => {
    for (const key of ['stats', 'excerpt', 'appendix'] as const) {
      const sections = { ...sampleStyle().sections } as Record<string, unknown>;
      delete sections[key];
      expect(deconStylePayloadSchema.safeParse(sampleStyle({ sections })).success).toBe(false);
    }
  });

  it('形状违约拒：键集外 section 键 / 空 excerptAnchors / 坏 materialId', () => {
    expect(deconStylePayloadSchema.safeParse(sampleStyle({ sections: { bogus: 'x', stats: 's', excerpt: 'e', appendix: 'a' } })).success).toBe(false);
    expect(deconStylePayloadSchema.safeParse(sampleStyle({ excerptAnchors: [] })).success).toBe(false);
    expect(deconStylePayloadSchema.safeParse(sampleStyle({ materialId: 'mat-xyz' })).success).toBe(false);
  });
});

describe('child B 三表行 schema（product / report / review）', () => {
  it('DECON_REPORT_KINDS 四 kind（P5 三层 + 风格报告）；review 三 checkpoint / 三状态', () => {
    expect(DECON_REPORT_KINDS).toEqual(['book_reading', 'chapter_review', 'scene_annotation', 'style_report']);
    expect(DECON_REVIEW_CHECKPOINTS).toEqual(['dictionary', 'canon', 'craft']);
    expect(DECON_REVIEW_STATUSES).toEqual(['pending', 'approved', 'off']);
  });

  it('product 行：合法往返（payload 为 passthrough——形状按 pass 分派在写侧 zod 门）', () => {
    const row = deconProductRowSchema.parse({
      jobId: 'decon-000000000001',
      pass: 'p4:huoke',
      unit: 'ch:2',
      payload: { findings: [] },
      updatedAt: '2026-09-05T10:00:00.000Z',
    });
    expect(row.unit).toBe('ch:2');
    expect(() =>
      deconProductRowSchema.parse({
        jobId: 'decon-000000000001',
        pass: 'p4:huoke',
        unit: 'bogus:unit',
        payload: {},
        updatedAt: '2026-09-05T10:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      deconProductRowSchema.parse({
        jobId: 'not-a-job',
        pass: 'p4:huoke',
        unit: 'all',
        payload: {},
        updatedAt: '2026-09-05T10:00:00.000Z',
      }),
    ).toThrow();
  });

  it('product unit 词形：章号/arcs/stats/all/ch:N/arc:N 合法；坏形拒', () => {
    for (const unit of ['0', '12', 'arcs', 'stats', 'all', 'ch:0', 'arc:3']) {
      expect(DECON_PRODUCT_UNIT_PATTERN.test(unit)).toBe(true);
    }
    for (const unit of ['ch:', 'arc', 'scene:1', 'CH:2', 'arc:-1', '']) {
      expect(DECON_PRODUCT_UNIT_PATTERN.test(unit)).toBe(false);
    }
  });

  it('report 行：合法往返 + kind 越界拒 + unit 词形（all/ch:N/scene:N）', () => {
    const row = deconReportRowSchema.parse({
      jobId: 'decon-000000000001',
      kind: 'scene_annotation',
      unit: 'scene:7',
      contentMd: '# 细批\n切入点在对话层。',
      anchors: [],
      dimension: null,
      updatedAt: '2026-09-05T10:00:00.000Z',
    });
    expect(row.anchors).toEqual([]);
    expect(() =>
      deconReportRowSchema.parse({
        jobId: 'decon-000000000001',
        kind: 'margin_note',
        unit: 'all',
        contentMd: 'x',
        anchors: [],
        dimension: null,
        updatedAt: '2026-09-05T10:00:00.000Z',
      }),
    ).toThrow();
    expect(DECON_REPORT_UNIT_PATTERN.test('ch:12')).toBe(true);
    expect(DECON_REPORT_UNIT_PATTERN.test('arc:1')).toBe(false);
    expect(() =>
      deconReportRowSchema.parse({
        jobId: 'decon-000000000001',
        kind: 'book_reading',
        unit: 'all',
        contentMd: '',
        anchors: [],
        dimension: null,
        updatedAt: '2026-09-05T10:00:00.000Z',
      }),
    ).toThrow();
  });

  it('review 行：合法往返 + checkpoint/状态越界拒', () => {
    const row = deconReviewRowSchema.parse({
      jobId: 'decon-000000000001',
      checkpoint: 'canon',
      status: 'pending',
      note: null,
      updatedAt: '2026-09-05T10:00:00.000Z',
    });
    expect(row.status).toBe('pending');
    for (const bad of [
      { checkpoint: 'p1c', status: 'pending' },
      { checkpoint: 'craft', status: 'waiting' },
    ]) {
      expect(() =>
        deconReviewRowSchema.parse({
          jobId: 'decon-000000000001',
          note: null,
          updatedAt: '2026-09-05T10:00:00.000Z',
          ...bad,
        }),
      ).toThrow();
    }
  });
});
