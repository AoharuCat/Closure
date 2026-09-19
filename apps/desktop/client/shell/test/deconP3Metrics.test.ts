import { createHash } from 'node:crypto';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconChapterLabels, DeconFacts, DeconSpan, Material } from '@orison/shared-contracts';
import {
  DECON_ARC_BOUNDARY_CONFIDENCE,
  DECON_ARC_MAX_CHARS,
  DECON_ARC_MIN_CHARS,
  DECON_ARC_SPLIT_CONFIDENCE,
} from '../main/decon/p3Metrics';

// E10.3b W2：P3b 纯代码算数测试——纯函数面（卷界探测/弧切分守卫族/统计族/复算一致 AC2/
// 章字数两指针）+ db 编排面（两 unit 落库/断点 skip/边界停走/stale）。零 LLM——无 mock
// generateText 面。ABI 门控 + throwaway home（mirror deconP1Extract.test.ts）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-p3b');

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
}));

vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));
vi.mock('@orison/desktop-agent', () => ({ resolveTaskModel: vi.fn(), assignmentThinkingControl: vi.fn() }));
vi.mock('@orison/model-protocols', () => ({ generateText: vi.fn(), generateEmbeddings: vi.fn() }));

import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';
import {
  deleteDeconProductsByMaterial,
  getDeconJob,
  getDeconPassState,
  getDeconProduct,
  upsertDeconChapterFacts,
  upsertDeconProduct,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob, transitionDeconJob } from '../main/decon/deconJob';
import {
  DECON_VOLUME_TITLE_RE,
  chapterCharCounts,
  computeDeconStats,
  deconDistribution,
  detectVolumeBoundaries,
  runDeconP3b,
  segmentDeconArcs,
  type DeconStatsComputeInput,
} from '../main/decon/p3Metrics';
import { composeDerivedText, splitParagraphBlocks } from '../main/ipc/toolHandlers/materialIngest';

let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

// ── fixtures ──

const MAT_ID = 'mat-000000000007';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'d'.repeat(64)}`;

const P3B_BODIES = [
  [
    '李逍遥在青云观的后院醒来，发现自己躺在一张竹床上。',
    '他想起了师父临走前说的话，心里一阵发紧。',
    '山下的集市人来人往，李逍遥买了一坛酒，遇见了赵灵儿。',
  ].join('\n\n'),
  [
    '「你真的要去后山吗？」赵灵儿皱着眉问。',
    '瀑布下的水潭边有一块古碑，碑上的字迹已经模糊。',
    '李逍遥伸手触碰古碑，古碑忽然发出了微弱的光。',
  ].join('\n\n'),
  [
    '夜里，青云观的老道人找到了他们，说山中有妖物出没。',
    '李逍遥决定留下来查清楚古碑的来历，赵灵儿表示要一起。',
    '两人在观中客房住下，约好明日一早去后山深处。',
  ].join('\n\n'),
];

function composeFixture(bodies: readonly string[]): { derived: string; chapters: Material['chapters'] } {
  const normalized = bodies.join('');
  let off = 0;
  const boundaries = bodies.map((body, i) => {
    const start = off;
    off += body.length;
    return { start, end: off, title: `第${i + 1}章` };
  });
  const { derived, spans } = composeDerivedText(normalized, boundaries, 'regex', 'high');
  const chapters: Material['chapters'] = spans.map((s, i) => ({
    index: i,
    title: `第${i + 1}章`,
    charStart: s.charStart,
    charEnd: s.charEnd,
    paraStart: 0,
    paraEnd: 0,
    confidence: 'high',
    method: 'regex',
  }));
  return { derived, chapters };
}

const FIXTURE = composeFixture(P3B_BODIES);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T12:00:00.000Z');
const LATER = new Date('2026-09-05T13:00:00.000Z');
const jobDeps = (derivedHash: string = DERIVED_HASH) => ({
  readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash }),
  now: () => NOW,
});

function mkMaterial(chapters: Material['chapters'] = FIXTURE.chapters): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '算数测试小说',
    format: 'txt',
    provenance: {
      medium: 'novel_text',
      tier: 'original',
      sourcePath: 'novel.txt',
      via: 'direct-read',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-05T00:00:00.000Z',
      author: null,
      lang: null,
      originDate: null,
      description: null,
    },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: DERIVED.length,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters,
    chunkSpans: [],
    contentHash: CONTENT_HASH,
    status: 'ready',
  };
}

// ── 纯函数面 ──

describe('DECON_VOLUME_TITLE_RE / detectVolumeBoundaries（卷界探测）', () => {
  it('「第X卷/X卷/卷X/篇/部」命中；「第X章」不命中；index 0 是书起点非切点', () => {
    expect(DECON_VOLUME_TITLE_RE.test('第一卷 风起')).toBe(true);
    expect(DECON_VOLUME_TITLE_RE.test('第二部：潮涌')).toBe(true);
    expect(DECON_VOLUME_TITLE_RE.test('卷三 南征')).toBe(true);
    expect(DECON_VOLUME_TITLE_RE.test('上篇 序幕')).toBe(true);
    expect(DECON_VOLUME_TITLE_RE.test('第一章 初入江湖')).toBe(false);
    expect(DECON_VOLUME_TITLE_RE.test('后山的秘密')).toBe(false);
    expect(DECON_VOLUME_TITLE_RE.test('3卷 风云')).toBe(true);

    const chapters = [
      { index: 0, title: '第一卷 风起' },
      { index: 1, title: '第一章 初入江湖' },
      { index: 2, title: null },
      { index: 3, title: '第二卷 潮涌' },
    ];
    expect(detectVolumeBoundaries(chapters)).toEqual([{ chapterIndex: 3, title: '第二卷 潮涌' }]);
  });
});

describe('chapterCharCounts（章字数两指针——干净文本口径）', () => {
  it('每章 = 相交块长度合计（标记行不占块——与 buildChapterSegments 同一交集）', () => {
    expect(BLOCKS).toHaveLength(9);
    const counts = chapterCharCounts(BLOCKS, FIXTURE.chapters);
    expect(counts).toHaveLength(3);
    for (let c = 0; c < 3; c++) {
      const ch = FIXTURE.chapters[c]!;
      let expected = 0;
      for (const b of BLOCKS) {
        const s = Math.max(b.start, ch.charStart);
        const e = Math.min(b.end, ch.charEnd);
        if (e > s) expected += e - s;
      }
      expect(counts[c]).toBe(expected);
    }
    // 空章（区间与块不相交）→ 0。
    expect(chapterCharCounts(BLOCKS, [{ charStart: DERIVED.length, charEnd: DERIVED.length }])).toEqual([0]);
  });
});

describe('segmentDeconArcs（弧切分守卫族）', () => {
  const mkChapters = (n: number, titles?: (string | null)[]): Array<{ index: number; title: string | null }> =>
    Array.from({ length: n }, (_, i) => ({ index: i, title: titles?.[i] ?? `第${i + 1}章` }));
  const flat = (n: number, per: number): number[] => Array.from({ length: n }, () => per);
  const labelsWith = (entries: Record<number, { isCandidate: boolean; confidence: number }>): Map<number, DeconChapterLabels> => {
    const map = new Map<number, DeconChapterLabels>();
    const empty = (): DeconChapterLabels => ({
      hooks: [],
      transitions: [],
      emotionalBeats: [],
      plotPhase: null,
      highlightSpans: [],
      expositionSpans: [],
      arcBoundary: null,
    });
    for (const [chapterIndex, ab] of Object.entries(entries)) {
      map.set(Number(chapterIndex), { ...empty(), arcBoundary: ab });
    }
    return map;
  };

  it('卷界优先：两卷题切两弧（origin=volume、卷名取章题、无并拆）', () => {
    const chapters = mkChapters(10, ['第一卷 风起', '第2章', '第3章', '第4章', '第5章', '第二卷 潮涌', '第7章', '第8章', '第9章', '第10章']);
    const payload = segmentDeconArcs(chapters, flat(10, 10_000), new Map());
    expect(payload.arcs).toHaveLength(2);
    expect(payload.arcs[0]).toMatchObject({ title: '第一卷 风起', fromChapter: 0, toChapter: 4, origin: 'volume', charCount: 50_000 });
    expect(payload.arcs[1]).toMatchObject({ title: '第二卷 潮涌', fromChapter: 5, toChapter: 9, origin: 'volume', charCount: 50_000 });
    expect(payload.audit).toMatchObject({ source: 'volume', arcsMerged: 0, arcsSplit: 0 });
  });

  it('卷界过小并弧：两卷各 25K（< 30K）→ 并成单弧（审计计数）+ 卷名取弧首章题', () => {
    const chapters = mkChapters(10, ['第一卷 风起', '第2章', '第3章', '第4章', '第5章', '第二卷 潮涌', '第7章', '第8章', '第9章', '第10章']);
    const payload = segmentDeconArcs(chapters, flat(10, 5_000), new Map());
    expect(payload.arcs).toHaveLength(1);
    expect(payload.arcs[0]).toMatchObject({ title: '第一卷 风起', fromChapter: 0, toChapter: 9, charCount: 50_000 });
    expect(payload.audit.arcsMerged).toBe(1);
  });

  it('无卷界 → 候选聚合：两个强候选切三弧（origin=boundary、审计候选数）', () => {
    const chapters = mkChapters(10);
    const payload = segmentDeconArcs(chapters, flat(10, 12_000), labelsWith({ 4: { isCandidate: true, confidence: 0.9 }, 7: { isCandidate: true, confidence: 0.8 } }));
    expect(payload.arcs).toHaveLength(3);
    expect(payload.arcs.map((a) => [a.fromChapter, a.toChapter])).toEqual([
      [0, 3],
      [4, 6],
      [7, 9],
    ]);
    expect(payload.arcs.every((a) => a.origin === 'boundary' && a.title === null)).toBe(true);
    expect(payload.audit).toMatchObject({ source: 'boundary', candidatesTotal: 2, candidatesUsed: 2 });
  });

  it('相邻候选合并：ch4/ch5 两强候选 → 单切点留先者', () => {
    const chapters = mkChapters(10);
    const payload = segmentDeconArcs(chapters, flat(10, 12_000), labelsWith({ 4: { isCandidate: true, confidence: 0.9 }, 5: { isCandidate: true, confidence: 0.8 } }));
    expect(payload.audit.candidatesTotal).toBe(2);
    expect(payload.audit.candidatesUsed).toBe(1);
    expect(payload.arcs.map((a) => [a.fromChapter, a.toChapter])).toEqual([
      [0, 3],
      [4, 9],
    ]);
  });

  it('置信阈值门：弱候选（< 0.6）不作切点 → 单弧（80K 守卫带内不拆）', () => {
    const chapters = mkChapters(10);
    const payload = segmentDeconArcs(chapters, flat(10, 8_000), labelsWith({ 4: { isCandidate: true, confidence: 0.5 } }));
    expect(payload.audit).toMatchObject({ source: 'single', candidatesTotal: 1, candidatesUsed: 0 });
    expect(payload.arcs).toHaveLength(1);
    expect(payload.arcs[0]).toMatchObject({ origin: 'single', fromChapter: 0, toChapter: 9 });
  });

  it('无卷无候选 → 单弧兜底（origin=single）', () => {
    const payload = segmentDeconArcs(mkChapters(5), flat(5, 8_000), new Map());
    expect(payload.arcs).toHaveLength(1);
    expect(payload.arcs[0]).toMatchObject({ origin: 'single', fromChapter: 0, toChapter: 4, charCount: 40_000, title: null });
    expect(payload.audit.source).toBe('single');
  });

  it('过大拆弧（无候选）：120K 单弧 > 100K → 半量章拆两段（arcsSplit 计数）', () => {
    const payload = segmentDeconArcs(mkChapters(20), flat(20, 6_000), new Map());
    expect(payload.arcs).toHaveLength(2);
    expect(payload.arcs.map((a) => [a.fromChapter, a.toChapter])).toEqual([
      [0, 9],
      [10, 19],
    ]);
    expect(payload.arcs.every((a) => a.charCount <= DECON_ARC_MAX_CHARS)).toBe(true);
    expect(payload.audit.arcsSplit).toBe(1);
  });

  it('过大拆弧（有弱候选）：120K 单弧在候选点（ch8 conf 0.4 ≥ 0.3）拆', () => {
    const payload = segmentDeconArcs(mkChapters(20), flat(20, 6_000), labelsWith({ 8: { isCandidate: true, confidence: 0.4 } }));
    // 弱候选不作切点（< 0.6）→ 单弧 120K；拆点池含 ch8（≥ 0.3）→ 恰半量 60K 在 ch10，
    // 候选 ch8（48K 处）距半量 12K；普通章 ch10 距 0——无候选才走普通章，有候选走候选点。
    expect(payload.arcs.map((a) => [a.fromChapter, a.toChapter])).toEqual([
      [0, 7],
      [8, 19],
    ]);
    expect(payload.audit).toMatchObject({ source: 'single', arcsSplit: 1, candidatesTotal: 1, candidatesUsed: 0 });
    expect(DECON_ARC_SPLIT_CONFIDENCE).toBeLessThan(DECON_ARC_BOUNDARY_CONFIDENCE);
  });

  it('复算一致（AC2）：同输入两跑同输出', () => {
    const chapters = mkChapters(10, ['第一卷 风起', '第2章', '第3章', '第4章', '第5章', '第二卷 潮涌', '第7章', '第8章', '第9章', '第10章']);
    const labels = labelsWith({ 3: { isCandidate: true, confidence: 0.7 } });
    const one = segmentDeconArcs(chapters, flat(10, 9_000), labels);
    const two = segmentDeconArcs(chapters, flat(10, 9_000), labels);
    expect(one).toEqual(two);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('守卫参数带注记（推测值——dogfood 标定面）', () => {
    expect(DECON_ARC_MIN_CHARS).toBe(30_000);
    expect(DECON_ARC_MAX_CHARS).toBe(100_000);
    expect(DECON_ARC_BOUNDARY_CONFIDENCE).toBe(0.6);
  });
});

describe('deconDistribution（分布摘要）', () => {
  it('min/avg/max/σ（总体）；空集全 0', () => {
    expect(deconDistribution([2, 4, 6])).toEqual({ count: 3, min: 2, avg: 4, max: 6, sigma: Math.sqrt(8 / 3) });
    expect(deconDistribution([5])).toEqual({ count: 1, min: 5, avg: 5, max: 5, sigma: 0 });
    expect(deconDistribution([])).toEqual({ count: 0, min: 0, avg: 0, max: 0, sigma: 0 });
  });
});

describe('computeDeconStats（统计族——AC2 可复算）', () => {
  const SPAN = (chapterIndex: number, charStart: number, charEnd: number): DeconSpan => ({
    chapterIndex,
    charStart,
    charEnd,
    paraStart: 0,
    paraEnd: 1,
  });
  const labels = (over: Partial<DeconChapterLabels>): DeconChapterLabels => ({
    hooks: [],
    transitions: [],
    emotionalBeats: [],
    plotPhase: null,
    highlightSpans: [],
    expositionSpans: [],
    arcBoundary: null,
    ...over,
  });
  const facts = (over: Partial<DeconFacts>): DeconFacts => ({
    synopsis: 's',
    entities: [],
    events: [],
    relationshipEdges: [],
    foreshadowPlanted: [],
    infoGap: [],
    ...over,
  });

  const input: DeconStatsComputeInput = {
    chapters: [{ index: 0 }, { index: 1 }, { index: 2 }],
    chapterChars: [1000, 1200, 800],
    labelsByChapter: new Map<number, DeconChapterLabels>([
      [
        0,
        labels({
          hooks: [{ type: '人物情感钩', span: SPAN(0, 0, 10) }],
          emotionalBeats: [{ beat: '拉扯', span: SPAN(0, 10, 20) }],
          highlightSpans: [SPAN(0, 0, 100), SPAN(0, 200, 300)],
          expositionSpans: [SPAN(0, 400, 600)],
        }),
      ],
      [1, labels({ plotPhase: '积蓄', transitions: [{ type: '阻碍转折', span: SPAN(1, 0, 10) }] })],
      [2, labels({ hooks: [{ type: 'other', span: SPAN(2, 0, 10) }], plotPhase: '释放' })],
    ]),
    factsByChapter: new Map<number, DeconFacts>([
      [0, facts({ infoGap: [{ type: '悬疑未知', span: SPAN(0, 0, 10) }], foreshadowPlanted: [{ hint: 'x', span: SPAN(0, 0, 10) }, { hint: 'y', span: SPAN(0, 0, 10) }], events: [{ what: 'e', kernel: true, span: SPAN(0, 0, 10) }] })],
      [1, facts({ infoGap: [{ type: '悬疑未知', span: SPAN(1, 0, 10) }] })],
      [2, facts({ events: [{ what: 'e2', span: SPAN(2, 0, 10) }] })],
    ]),
    arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 2, chapterCount: 3, charCount: 3000, origin: 'single' }],
    derivedText: ['他推开门。「你来了。」她说道。', '雨还在下，山路的尽头一片模糊。', '「走吧。」他说。'].join('\n\n'),
  };

  it('书级：章字数分布 / by 型全键列齐 / infoGap 消费 P1b / 伏笔密度 / 铺垫-高潮跨度', () => {
    const payload = computeDeconStats(input);
    expect(payload.book.chapterCount).toBe(3);
    expect(payload.book.charCount).toBe(3000);
    expect(payload.book.chapterChars).toEqual({ count: 3, min: 800, avg: 1000, max: 1200, sigma: deconDistribution([1000, 1200, 800]).sigma });
    // by 型全键列齐（11+other=12 / 9+other=10 / 7 / 6——零计型在场面）。
    expect(Object.keys(payload.book.hooksByType)).toHaveLength(12);
    expect(Object.keys(payload.book.transitionsByType)).toHaveLength(10);
    expect(Object.keys(payload.book.emotionalBeatsByType)).toHaveLength(7);
    expect(Object.keys(payload.book.infoGapByType)).toHaveLength(6);
    expect(payload.book.hooksByType['人物情感钩']).toBe(1);
    expect(payload.book.hooksByType['other']).toBe(1);
    expect(payload.book.transitionsByType['阻碍转折']).toBe(1);
    expect(payload.book.emotionalBeatsByType['拉扯']).toBe(1);
    // infoGap 消费 P1b facts（F-08 不重打）。
    expect(payload.book.infoGapByType['悬疑未知']).toBe(2);
    expect(payload.book.foreshadowPlantedCount).toBe(2);
    expect(payload.book.foreshadowDensityPer10k).toBeCloseTo(2 / 0.3, 5);
    // 爽点：2 段同在 ch0 → 间隔 [0]；字数 [100, 100]。
    expect(payload.book.highlightCount).toBe(2);
    expect(payload.book.highlightChars).toMatchObject({ count: 2, min: 100, max: 100 });
    expect(payload.book.highlightIntervalChapters).toEqual({ count: 1, min: 0, avg: 0, max: 0, sigma: 0 });
    // 设定段字数分布（ch0 一段 200 字）。
    expect(payload.book.expositionChars).toEqual({ count: 1, min: 200, avg: 200, max: 200, sigma: 0 });
    // 铺垫-高潮跨度：ch0 钩子 → ch0 kernel（同章兑现=0）；ch2 钩子无后续 kernel 不计。
    expect(payload.book.hookToKernelChapterSpan).toEqual({ count: 1, min: 0, avg: 0, max: 0, sigma: 0 });
  });

  it('弧级：聚合计数 + 相位分布；style_stats：句长/段落/对话行占比', () => {
    const payload = computeDeconStats(input);
    expect(payload.arcs).toHaveLength(1);
    expect(payload.arcs[0]).toMatchObject({
      fromChapter: 0,
      toChapter: 2,
      chapterCount: 3,
      hookCount: 2,
      transitionCount: 1,
      highlightCount: 2,
      infoGapCount: 2,
      foreshadowPlantedCount: 2,
    });
    expect(payload.arcs[0]?.plotPhaseCounts).toEqual({ 拉仇恨: 0, 积蓄: 1, 释放: 1, 落袋为安: 0 });
    // style_stats：3 非空行中 2 行含对话引号 → 0.667；段落 3 块。
    expect(payload.styleStats.paragraphChars.count).toBe(3);
    expect(payload.styleStats.dialogueLineRatio).toBeCloseTo(2 / 3, 5);
    expect(payload.styleStats.sentenceChars.count).toBeGreaterThan(0);
  });

  it('复算一致（AC2）：同输入两跑同输出（含浮点）', () => {
    const one = computeDeconStats(input);
    const two = computeDeconStats(input);
    expect(one).toEqual(two);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('零标签零 facts（空书容错）：分布空集约定 + 全零记录', () => {
    const payload = computeDeconStats({
      chapters: [{ index: 0 }],
      chapterChars: [500],
      labelsByChapter: new Map(),
      factsByChapter: new Map(),
      arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 0, chapterCount: 1, charCount: 500, origin: 'single' }],
      derivedText: '只有一句话。',
    });
    expect(payload.book.chapterChars).toEqual({ count: 1, min: 500, avg: 500, max: 500, sigma: 0 });
    expect(payload.book.highlightChars.count).toBe(0);
    expect(payload.book.hookToKernelChapterSpan.count).toBe(0);
    expect(payload.book.foreshadowDensityPer10k).toBe(0);
    expect(payload.book.infoGapByType['悬疑未知']).toBe(0);
  });
});

// ── db 编排面 ──

const maybeDb = sqliteUsable ? describe : describe.skip;

maybeDb('runDeconP3b（db 编排——零 LLM 两 unit）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
  });

  function seedFacts(): void {
    const span = (chapterIndex: number): DeconSpan => ({ chapterIndex, charStart: 0, charEnd: 10, paraStart: 0, paraEnd: 1 });
    for (let ci = 0; ci < 3; ci++) {
      upsertDeconChapterFacts({
        materialRef: MAT_REF,
        derivedHash: DERIVED_HASH,
        chapterIndex: ci,
        facts: {
          synopsis: `第${ci}章概要。`,
          entities: [],
          events: ci === 0 ? [{ what: '触碰古碑', kernel: true, span: span(ci) }] : [],
          relationshipEdges: [],
          foreshadowPlanted: ci === 0 ? [{ hint: '古碑来历', span: span(ci) }] : [],
          infoGap: ci === 1 ? [{ type: '悬疑未知', span: span(ci) }] : [],
        },
      });
    }
  }

  function seedLabels(jobId: string): void {
    const t = NOW.toISOString();
    const empty = (): DeconChapterLabels => ({
      hooks: [],
      transitions: [],
      emotionalBeats: [],
      plotPhase: null,
      highlightSpans: [],
      expositionSpans: [],
      arcBoundary: null,
    });
    upsertDeconProduct({
      jobId,
      pass: 'p3a',
      unit: '0',
      payload: { ...empty(), hooks: [{ type: '人物情感钩', span: { chapterIndex: 0, charStart: 0, charEnd: 12, paraStart: 0, paraEnd: 1 } }] },
      updatedAt: t,
    });
    upsertDeconProduct({
      jobId,
      pass: 'p3a',
      unit: '2',
      payload: { ...empty(), arcBoundary: { isCandidate: true, confidence: 0.9, signal: '新地图' } },
      updatedAt: t,
    });
  }

  it('两 unit 落库：arcs（候选聚合路径）+ stats 全族 + pass_state done 同事务', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    seedLabels(jobId);
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const result = await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats).toMatchObject({ chapters: 3, labelRows: 2, factsRows: 3 });

    // arcs：候选聚合切点 ch2 → 两段（全书 ~150 字远小于 30K → 守卫并回单弧，审计留痕）。
    const arcsRow = getDeconProduct(jobId, 'p3b', 'arcs');
    expect(arcsRow?.payload).toMatchObject({
      audit: { source: 'boundary', candidatesTotal: 1, candidatesUsed: 1, arcsMerged: 1 },
    });
    const arcsPayload = arcsRow?.payload as { arcs: Array<{ fromChapter: number; toChapter: number; origin: string }> };
    expect(arcsPayload.arcs).toEqual([expect.objectContaining({ fromChapter: 0, toChapter: 2, origin: 'boundary' })]);
    expect(result.stats.arcs).toBe(1);
    expect(result.stats.arcSource).toBe('boundary');

    // stats：infoGap 消费 P1b / 伏笔密度 / 钩子计数。
    const statsRow = getDeconProduct(jobId, 'p3b', 'stats');
    const statsPayload = statsRow?.payload as {
      book: { hooksByType: Record<string, number>; infoGapByType: Record<string, number>; foreshadowPlantedCount: number };
      styleStats: { paragraphChars: { count: number } };
    };
    expect(statsPayload.book.hooksByType['人物情感钩']).toBe(1);
    expect(statsPayload.book.infoGapByType['悬疑未知']).toBe(1);
    expect(statsPayload.book.foreshadowPlantedCount).toBe(1);
    expect(statsPayload.styleStats.paragraphChars.count).toBe(9);

    // pass_state 两行 done（outputRef 契约形）。
    expect(getDeconPassState(jobId, 'p3b', 'arcs')).toMatchObject({ status: 'done', outputRef: 'product:p3b:arcs' });
    expect(getDeconPassState(jobId, 'p3b', 'stats')).toMatchObject({ status: 'done', outputRef: 'product:p3b:stats' });
  });

  it('断点重入：全 done 再跑 → skip 零重算（updatedAt 不动）+ done', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    seedLabels(jobId);
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const first = await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('done');
    const arcsBefore = getDeconProduct(jobId, 'p3b', 'arcs');
    const statsBefore = getDeconProduct(jobId, 'p3b', 'stats');

    const second = await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => LATER });
    expect(second.status).toBe('done');
    // skip 路径不重写（updatedAt 保持首跑时刻——重算免费但保持幂等面统一）。
    expect(getDeconProduct(jobId, 'p3b', 'arcs')?.updatedAt).toBe(arcsBefore?.updatedAt);
    expect(getDeconProduct(jobId, 'p3b', 'stats')?.updatedAt).toBe(statsBefore?.updatedAt);
    expect(getDeconProduct(jobId, 'p3b', 'arcs')?.payload).toEqual(arcsBefore?.payload);
  });

  it('复算一致（AC2）：删除产物重跑 → 逐字节同输出', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    seedLabels(jobId);
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => NOW });
    const arcs1 = JSON.stringify(getDeconProduct(jobId, 'p3b', 'arcs')?.payload);
    const stats1 = JSON.stringify(getDeconProduct(jobId, 'p3b', 'stats')?.payload);

    // 清产物 + 状态行 → 全重算。
    getDb().prepare('DELETE FROM closure_decon_product WHERE job_id=? AND pass=?').run(jobId, 'p3b');
    getDb().prepare('DELETE FROM closure_decon_pass_state WHERE job_id=? AND pass=?').run(jobId, 'p3b');
    const rerun = await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => LATER });
    expect(rerun.status).toBe('done');
    expect(JSON.stringify(getDeconProduct(jobId, 'p3b', 'arcs')?.payload)).toBe(arcs1);
    expect(JSON.stringify(getDeconProduct(jobId, 'p3b', 'stats')?.payload)).toBe(stats1);
  });

  it('中断韧性：arcs unit 完成后 stats 前暂停 → paused（stats 零落）→ resume 补齐', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    seedLabels(jobId);
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const notify = vi.fn(() => {
      // arcs unit 开跑时翻 pause——同步计算完成落库，stats unit 边界感知停。
      transitionDeconJob(jobId, 'pause');
    });
    const paused = await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => NOW, notify });
    expect(paused.status).toBe('paused');
    expect(getDeconPassState(jobId, 'p3b', 'arcs')?.status).toBe('done');
    expect(getDeconProduct(jobId, 'p3b', 'stats')).toBeNull();

    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const done = await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => LATER });
    expect(done.status).toBe('done');
    expect(getDeconPassState(jobId, 'p3b', 'stats')?.status).toBe('done');
  });

  it('派生 .md 现值 hash ≠ job 快照 → stale（F-02）', async () => {
    const OTHER_HASH = sha(DERIVED + '校对后');
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(OTHER_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(OTHER_HASH)).ok).toBe(true);
    const result = await runDeconP3b(jobId, { readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('stale');
    expect(getDeconJob(jobId)?.status).toBe('stale');
  });

  it('派生 .md 不可读 → failed（诚实挂起）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const result = await runDeconP3b(jobId, { readDerivedText: () => null, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('派生');
  });
});

beforeAll(() => {
  if (sqliteUsable) {
    rmBestEffort(TEST_HOME);
    getDb();
  }
});

afterAll(() => {
  clean();
});
