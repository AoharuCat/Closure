import { createHash } from 'node:crypto';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Material } from '@orison/shared-contracts';

// E10.3b W3b：P4 手艺层 runner 测试——纯函数面（findings 解析容错 / 弧分组 sansheng 纪律 /
// 同类场景聚类 / 章级窗口 / 锚定核验无锚即丢）+ db 编排面（happy path 双粒度 unit / 编造
// 证据拦截 / 断点续跑零重调 / >80K 弧拆组 / 零手艺维直接 done）。ABI 门控 + throwaway home
// （mirror deconP3Label.test.ts）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-decon-p4');

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
  listDeconProducts,
  upsertDeconChapterFacts,
  upsertDeconProduct,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob } from '../main/decon/deconJob';
import type { DeconGenerateText } from '../main/decon/deconLlmCore';
import {
  DECON_HUOKE_CHAPTER_WINDOW,
  DECON_P4_ARC_GROUP_MAX,
  DECON_P4_ARC_GROUP_MIN,
  buildDeconP4Appearances,
  buildDeconP4ArcChapterBlock,
  buildDeconP4ArcUserPrompt,
  buildDeconP4ChapterUserPrompt,
  clusterDeconSameScenes,
  deconP4ChapterUnits,
  parseDeconFindingsResponse,
  runDeconP4Craft,
  splitDeconArcGroups,
  verifyDeconFindings,
} from '../main/decon/p4Craft';
import { composeDerivedText, splitParagraphBlocks, type MaterialParagraphBlock } from '../main/ipc/toolHandlers/materialIngest';
import type { DeconArc, DeconArcsPayload, DeconChapterLabels, DeconFacts, DeconStatsPayload } from '@orison/shared-contracts';

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

// ── fixtures（3 章 × 3 段——facts/arcs/stats 种子行用真实锚）──

const MAT_ID = 'mat-000000000007';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;

const P4_BODIES = [
  [
    '李逍遥在青云观的后院醒来，发现自己躺在一张竹床上。',
    '山下的集市人来人往，他买了一坛酒，遇见了赵灵儿。',
    '两人约好明日一同去后山，李逍遥心里隐约不安。',
  ].join('\n\n'),
  [
    '赵灵儿约李逍遥去后山看瀑布，两人一前一后上了山。',
    '瀑布下的水潭边有一块古碑，李逍遥伸手触碰古碑。',
    '古碑忽然发出了微弱的光，两人对视一眼。',
  ].join('\n\n'),
  [
    '夜里，老道人找到了他们，说山中有妖物出没。',
    '李逍遥决定留下来查清楚古碑的来历。',
    '两人在观中客房住下，约好明日一早去后山深处。',
  ].join('\n\n'),
];

function composeFixture(bodies: readonly string[]): { derived: string; chapters: Material['chapters'] } {
  const normalized = bodies.join('\n\n');
  let off = 0;
  const boundaries = bodies.map((body, i) => {
    const start = off;
    off += body.length + (i < bodies.length - 1 ? 2 : 0);
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

const FIXTURE = composeFixture(P4_BODIES);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T14:00:00.000Z');
const jobDeps = () => ({ readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: DERIVED_HASH }), now: () => NOW });

function mkMaterial(chapters: Material['chapters'] = FIXTURE.chapters, derived: string = DERIVED): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '手艺层测试小说',
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
      charCount: derived.length,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters,
    chunkSpans: [],
    contentHash: CONTENT_HASH,
    status: 'ready',
  };
}

/** 章 k 第 j 段的全局块号（fixture 每章恒 3 段）。 */
function blockOf(chapterIndex: number, k: number): number {
  return chapterIndex * 3 + k;
}

function spanOf(chapterIndex: number, k: number) {
  const bi = blockOf(chapterIndex, k);
  return { chapterIndex, charStart: BLOCKS[bi]!.start, charEnd: BLOCKS[bi]!.end, paraStart: bi, paraEnd: bi + 1 };
}

/** 每章 facts（事件/伏笔带真实 span——弧级引文窗口来源）。 */
function factsFor(chapterIndex: number): DeconFacts {
  return {
    synopsis: `【第${chapterIndex}章】李逍遥与赵灵儿的后山之行推进。`,
    entities: [
      { name: '李逍遥', type: 'person', span: spanOf(chapterIndex, 0) },
      { name: '赵灵儿', type: 'person', span: spanOf(chapterIndex, 0) },
    ],
    events: [
      {
        what: chapterIndex === 1 ? '触碰古碑引异象' : '推进主线',
        span: spanOf(chapterIndex, 1),
        ...(chapterIndex === 1 ? { kernel: true } : {}),
      },
    ],
    relationshipEdges: [],
    foreshadowPlanted: chapterIndex === 1 ? [{ hint: '古碑来历不明', span: spanOf(chapterIndex, 1) }] : [],
    infoGap: [{ type: '悬疑未知', span: spanOf(chapterIndex, 2) }],
  };
}

function seedFacts(): void {
  for (let ci = 0; ci < 3; ci++) {
    upsertDeconChapterFacts({ materialRef: MAT_REF, derivedHash: DERIVED_HASH, chapterIndex: ci, facts: factsFor(ci) });
  }
}

const ARC: DeconArc = {
  index: 0,
  title: null,
  fromChapter: 0,
  toChapter: 2,
  chapterCount: 3,
  charCount: DERIVED.length,
  origin: 'single',
};

const ARCS_PAYLOAD: DeconArcsPayload = {
  arcs: [ARC],
  audit: { source: 'single', volumeBoundaries: [], candidatesTotal: 0, candidatesUsed: 0, arcsMerged: 0, arcsSplit: 0 },
};

const STATS_PAYLOAD: DeconStatsPayload = {
  book: {
    chapterCount: 3,
    charCount: DERIVED.length,
    chapterChars: { count: 3, min: 50, avg: 60, max: 70, sigma: 2 },
    highlightCount: 1,
    highlightChars: { count: 1, min: 20, avg: 20, max: 20, sigma: 0 },
    highlightIntervalChapters: { count: 0, min: 0, avg: 0, max: 0, sigma: 0 },
    hooksByType: {},
    transitionsByType: {},
    emotionalBeatsByType: {},
    infoGapByType: { 悬疑未知: 3 },
    foreshadowPlantedCount: 1,
    foreshadowDensityPer10k: 1,
    expositionChars: { count: 0, min: 0, avg: 0, max: 0, sigma: 0 },
    hookToKernelChapterSpan: { count: 0, min: 0, avg: 0, max: 0, sigma: 0 },
  },
  arcs: [
    {
      index: 0,
      fromChapter: 0,
      toChapter: 2,
      chapterCount: 3,
      charCount: DERIVED.length,
      chapterChars: { count: 3, min: 50, avg: 60, max: 70, sigma: 2 },
      hookCount: 1,
      transitionCount: 0,
      highlightCount: 1,
      emotionalBeatCount: 1,
      infoGapCount: 3,
      foreshadowPlantedCount: 1,
      plotPhaseCounts: { 拉仇恨: 1, 积蓄: 0, 释放: 0, 落袋为安: 0 },
    },
  ],
  styleStats: {
    sentenceChars: { count: 10, min: 10, avg: 20, max: 30, sigma: 4 },
    paragraphChars: { count: 9, min: 20, avg: 25, max: 30, sigma: 2 },
    dialogueLineRatio: 0.2,
  },
};

/** p3a labels 种子（章 1 带爽点段——弧级聚合引文窗口不依赖它，此处仅章级预注面）。 */
const LABELS: DeconChapterLabels = {
  hooks: [{ type: '人物情感钩', span: spanOf(1, 0) }],
  transitions: [],
  emotionalBeats: [],
  plotPhase: '积蓄',
  highlightSpans: [spanOf(1, 1)],
  expositionSpans: [],
  arcBoundary: null,
};

function seedUpstream(jobId: string): void {
  seedFacts();
  upsertDeconProduct({ jobId, pass: 'p3b', unit: 'arcs', payload: ARCS_PAYLOAD, updatedAt: NOW.toISOString() });
  upsertDeconProduct({ jobId, pass: 'p3b', unit: 'stats', payload: STATS_PAYLOAD, updatedAt: NOW.toISOString() });
  upsertDeconProduct({ jobId, pass: 'p3a', unit: '1', payload: LABELS, updatedAt: NOW.toISOString() });
}

/** findings 响应构造（好锚 = 块文本前 8 字；可选追加编造条目）。 */
function findingsJson(items: ReadonlyArray<{ paraRange: { start: number; end: number }; quote: string }>): string {
  return JSON.stringify({
    findings: items.map((it) => ({
      insight: '钩子立在章首，期待感建立快',
      elaboration: '钩子出现早且第二章即回收，间隔短密度高，适合快节奏开篇借鉴。',
      evidence: [{ paraRange: it.paraRange, quote: it.quote }],
      craftHint: { category: 'qidaigan', termHint: '期待感' },
    })),
    synthesis: '本章期待感建立快。',
  });
}

function goodEvidence(chapterIndex: number, k: number): { paraRange: { start: number; end: number }; quote: string } {
  const bi = blockOf(chapterIndex, k);
  return { paraRange: { start: bi, end: bi + 1 }, quote: DERIVED.slice(BLOCKS[bi]!.start, BLOCKS[bi]!.start + 8) };
}

/** 弧级响应（引文取自 @P 窗口的原文——mock 从 user prompt 抽取回放）。 */
function arcFindingsFromPrompt(user: string): string {
  const m = /「(.+?)」@P(\d+)–P(\d+)/.exec(user);
  if (m === null) {
    // 兜底：章级形态（【P#】行首 8 字）。
    const cm = /【P(\d+)】(.)/.exec(user);
    if (cm === null) return findingsJson([]);
    const bi = Number(cm[1]);
    return findingsJson([{ paraRange: { start: bi, end: bi + 1 }, quote: DERIVED.slice(BLOCKS[bi]!.start, BLOCKS[bi]!.start + 8) }]);
  }
  return findingsJson([{ paraRange: { start: Number(m[2]), end: Number(m[3]) + 1 }, quote: m[1]! }]);
}

beforeAll(() => {
  if (sqliteUsable) {
    rmBestEffort(TEST_HOME);
    getDb();
  }
});

afterAll(() => {
  clean();
});

const maybe = sqliteUsable ? describe : describe.skip;

// ── 纯函数面 ──

describe('parseDeconFindingsResponse（条目级容错）', () => {
  it('合法应答全解析（evidence/craftHint 保形）', () => {
    const parsed = parseDeconFindingsResponse(findingsJson([goodEvidence(0, 0)]));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.droppedMalformed).toBe(0);
    expect(parsed.itemCount).toBe(1);
    expect(parsed.output.findings[0]?.craftHint).toEqual({ category: 'qidaigan', termHint: '期待感' });
  });

  it('条目坏形状丢+计数（缺 insight / 坏 paraRange 连坐整条 / evidence 空 / 空壳 craftHint）', () => {
    const raw = JSON.stringify({
      findings: [
        { insight: '', elaboration: 'x', evidence: [{ paraRange: { start: 0, end: 1 }, quote: 'q' }] },
        { insight: 'a', elaboration: 'b', evidence: [{ paraRange: { start: -1, end: 1 }, quote: 'q' }] },
        { insight: 'a', elaboration: 'b', evidence: [] },
        { insight: 'a', elaboration: 'b', evidence: [{ paraRange: { start: 0, end: 1 }, quote: 'q' }], craftHint: {} },
        { insight: 'a', elaboration: 'b', evidence: [{ paraRange: { start: 0, end: 1 }, quote: 'q' }], craftHint: 'bad' },
      ],
      synthesis: 's',
    });
    const parsed = parseDeconFindingsResponse(raw);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    // 缺 insight=1；坏 evidence 条=1 + 连坐整条=1；evidence 空=1；空壳 hint=1；非对象 hint=1 → 6。
    expect(parsed.droppedMalformed).toBe(6);
    // 坏 craftHint 只作废 hint 保条（证据合法不连坐）——两项存活且 hint 为 null。
    expect(parsed.output.findings).toHaveLength(2);
    expect(parsed.output.findings.every((f) => f.craftHint === null)).toBe(true);
  });

  it('craftHint category 越出受控词表 → hint 作废保条（证据合法不连坐）', () => {
    const raw = JSON.stringify({
      findings: [
        {
          insight: 'a',
          elaboration: 'b',
          evidence: [{ paraRange: { start: 0, end: 1 }, quote: 'q' }],
          craftHint: { category: '自造大类' },
        },
      ],
      synthesis: '',
    });
    const parsed = parseDeconFindingsResponse(raw);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.droppedMalformed).toBe(1);
    expect(parsed.output.findings).toHaveLength(1);
    expect(parsed.output.findings[0]?.craftHint).toBeNull();
  });

  it('顶层坏（非 JSON / findings 与 synthesis 双缺）→ null 整体拒收', () => {
    expect(parseDeconFindingsResponse('不是 JSON')).toBeNull();
    expect(parseDeconFindingsResponse('{"foo":1}')).toBeNull();
    // findings 坏但 synthesis 在场 → 容错解析（findings 空集 + synthesis 保留）。
    expect(parseDeconFindingsResponse('{"findings":"x","synthesis":"y"}')).not.toBeNull();
  });
});

describe('splitDeconArcGroups（sansheng 分组纪律——>80K 拆 3-5 组）', () => {
  it('总量 ≤ 上限 → 单组', () => {
    expect(splitDeconArcGroups([100, 200, 300])).toEqual([[0, 1, 2]]);
    expect(splitDeconArcGroups([])).toEqual([]);
  });

  it('超上限 → 组数钳制在 [3,5]，全章覆盖不重不漏（确定性）', () => {
    const contributions = Array.from({ length: 40 }, () => 3_000); // 120K > 80K
    const groups = splitDeconArcGroups(contributions);
    expect(groups.length).toBeGreaterThanOrEqual(DECON_P4_ARC_GROUP_MIN);
    expect(groups.length).toBeLessThanOrEqual(DECON_P4_ARC_GROUP_MAX);
    expect(groups.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    // 每组连续（区间无交叉）。
    for (const g of groups) {
      for (let i = 1; i < g.length; i++) expect(g[i]).toBe(g[i - 1]! + 1);
    }
    // 极端超限（8×80K=640K → ceil=8 → 钳 5）。
    const huge = splitDeconArcGroups(Array.from({ length: 80 }, () => 8_000));
    expect(huge.length).toBe(DECON_P4_ARC_GROUP_MAX);
  });

  it('少量巨章超限也满足 3 组下限（钳制带保底——组数不超章数）', () => {
    const groups = splitDeconArcGroups([50_000, 50_000, 50_000]); // 150K → ceil(1.875)=2 → 钳 3
    expect(groups.length).toBe(3);
    expect(groups.flat().sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

describe('clusterDeconSameScenes（duizhao 预注——Jaccard 归组）', () => {
  it('实体集相似章归组 + 共同阵容交集；不相似不并', () => {
    const groups = clusterDeconSameScenes([
      { index: 0, entities: [{ name: '李逍遥' }, { name: '赵灵儿' }] },
      { index: 1, entities: [{ name: '李逍遥' }, { name: '赵灵儿' }, { name: '古碑' }] },
      { index: 2, entities: [{ name: '酒馆掌柜' }, { name: '说书人' }] },
    ]);
    expect(groups).toEqual([{ chapters: [0, 1], sharedEntities: ['李逍遥', '赵灵儿'] }]);
  });

  it('单章不成组；空实体章跳过', () => {
    expect(clusterDeconSameScenes([{ index: 0, entities: [{ name: 'a' }] }, { index: 1, entities: [] }])).toEqual([]);
  });
});

describe('deconP4ChapterUnits（粒度窗口——huoke 开篇子集）', () => {
  it('huoke = 前 min(12, 章数)；其余维全章', () => {
    expect(deconP4ChapterUnits('huoke', 30)).toHaveLength(DECON_HUOKE_CHAPTER_WINDOW);
    expect(deconP4ChapterUnits('huoke', 5)).toEqual([0, 1, 2, 3, 4]);
    expect(deconP4ChapterUnits('qingxu', 5)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('buildDeconP4ChapterUserPrompt / buildDeconP4ArcUserPrompt（注入装配）', () => {
  it('章级：正文【P段号】+ 事实/打标预注 + 范围注记；窗口 = 章块范围', () => {
    const built = buildDeconP4ChapterUserPrompt({
      derived: DERIVED,
      blocks: BLOCKS,
      chapterIndex: 1,
      blockStart: 3,
      blockEnd: 6,
      facts: factsFor(1),
      labels: LABELS,
    });
    expect(built.prompt).toContain('【P3】');
    expect(built.prompt).toContain('章概要');
    expect(built.prompt).toContain('伏笔埋点：古碑来历不明');
    expect(built.prompt).toContain('钩子：人物情感钩');
    expect(built.prompt).toContain('P3–P5');
    expect(built.windows).toEqual([{ blockStart: 3, blockEnd: 6, chapterIndex: 1 }]);
  });

  it('弧级：概要+统计+出场退场+引文窗口+聚类；「@P段号」窗口随行', () => {
    const chapterBlocks = [0, 1, 2].map((ci) =>
      buildDeconP4ArcChapterBlock({ index: ci, title: `第${ci + 1}章`, facts: factsFor(ci) }, DERIVED),
    );
    const built = buildDeconP4ArcUserPrompt({
      derived: DERIVED,
      blocks: BLOCKS,
      arc: ARC,
      arcStat: STATS_PAYLOAD.arcs[0]!,
      chapterBlocks,
      appearances: buildDeconP4Appearances(
        ARC,
        new Map<number, DeconFacts>([0, 1, 2].map((ci) => [ci, factsFor(ci)])),
      ),
      clusters: [{ chapters: [0, 1], sharedEntities: ['李逍遥', '赵灵儿'] }],
      sampleBlocks: [],
    });
    expect(built.prompt).toContain('弧计量统计');
    expect(built.prompt).toContain('钩子 1 次');
    expect(built.prompt).toContain('出场退场表');
    expect(built.prompt).toContain('李逍遥：弧内出现第 1、2、3 章');
    expect(built.prompt).toContain('「@P段号」');
    expect(built.prompt).toContain('同类场景聚类');
    // 引文窗口 = 各章事件/伏笔 span 窗口（章 1 伏笔 span = 块 4）。
    expect(built.windows).toContainEqual({ blockStart: 4, blockEnd: 5, chapterIndex: 1 });
  });
});

describe('verifyDeconFindings（锚定核验——无锚即丢）', () => {
  const windows = [{ blockStart: 3, blockEnd: 6, chapterIndex: 1 }];

  it('窗口内 + 引文匹配 → 保；集外/引文编造 → 丢 evidence/丢条', () => {
    const response = {
      findings: [
        {
          insight: 'a',
          elaboration: 'b',
          evidence: [{ paraRange: { start: 4, end: 5 }, quote: DERIVED.slice(BLOCKS[4]!.start, BLOCKS[4]!.start + 6) }],
          craftHint: null,
        },
        {
          insight: 'c',
          elaboration: 'd',
          evidence: [{ paraRange: { start: 99, end: 100 }, quote: '编造引文' }],
          craftHint: null,
        },
        {
          insight: 'e',
          elaboration: 'f',
          evidence: [
            { paraRange: { start: 99, end: 100 }, quote: '坏锚' },
            { paraRange: { start: 3, end: 4 }, quote: DERIVED.slice(BLOCKS[3]!.start, BLOCKS[3]!.start + 6) },
          ],
          craftHint: null,
        },
      ],
      synthesis: 's',
    };
    const verified = verifyDeconFindings(response, windows, BLOCKS, DERIVED);
    expect(verified.findings).toHaveLength(2); // 第三条坏锚 evidence 丢但好锚保 → 条存活
    expect(verified.droppedFindings).toBe(1);
    expect(verified.droppedEvidence).toBe(2);
    expect(verified.findings[1]?.evidence).toHaveLength(1);
  });
});

// ── db 编排面 ──

maybe('runDeconP4Craft（db 编排）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
  });

  it('happy path（qidaigan 章+弧双粒度）：unit 落 product + pass_state done + cost 按 p4:<dim> 记账', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    seedUpstream(jobId);

    let calls = 0;
    const gen: DeconGenerateText = async (input) => {
      calls += 1;
      if (input.user.includes('【本章正文')) {
        return { text: findingsJson([goodEvidence(0, 0)]) };
      }
      return { text: arcFindingsFromPrompt(input.user) };
    };
    const result = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW }, 'qidaigan');
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats).toMatchObject({ dimensions: 1, units: 4, skipped: 0, analyzed: 4, arcGroups: 1 });
    expect(calls).toBe(4); // 3 章级 + 1 弧级（≤80K 单组）

    for (const unit of ['ch:0', 'ch:1', 'ch:2', 'arc:0']) {
      expect(getDeconProduct(jobId, 'p4:qidaigan', unit)).not.toBeNull();
      expect(getDeconPassState(jobId, 'p4:qidaigan', unit)?.status).toBe('done');
    }
    expect(getDeconProduct(jobId, 'p4:qidaigan', 'ch:0')?.payload).toMatchObject({
      findings: [{ insight: expect.any(String), evidence: [expect.objectContaining({ paraRange: { start: 0, end: 1 } })] }],
    });
    // cost 按 pass 全值记账（p4:qidaigan 茎下）。
    const jobRow = getDeconJob(jobId);
    expect(jobRow?.cost.byPass['p4:qidaigan']?.calls).toBe(4);
  });

  it('编造证据拦截：好锚条存活 + 编造条整条丢 + 计数', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['qingxu'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    seedUpstream(jobId);

    const gen: DeconGenerateText = async () => ({
      text: findingsJson([
        goodEvidence(0, 1),
        { paraRange: { start: 900, end: 901 }, quote: '正文里根本没有这句' },
      ]),
    });
    const result = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW }, 'qingxu');
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoAnchorFindings).toBeGreaterThanOrEqual(3); // 章级 3 单元 × 各 1 编造条
    expect(result.stats.analyzed).toBe(4);
    const row = getDeconProduct(jobId, 'p4:qingxu', 'ch:0');
    expect((row?.payload as { findings: unknown[] }).findings).toHaveLength(1);
  });

  it('断点续跑：重入全 skip 零 LLM 重调（mock 计数不变）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['wenbi'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    seedUpstream(jobId);

    let calls = 0;
    const gen: DeconGenerateText = async () => {
      calls += 1;
      return { text: findingsJson([goodEvidence(0, 0)]) };
    };
    const first = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW }, 'wenbi');
    expect(first.status).toBe('done');
    expect(calls).toBe(3); // wenbi 仅章面 ×3

    // 模拟中断后续跑：paused → start → 重入（状态翻 paused 需先手动转移）。
    const rerun = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW }, 'wenbi');
    expect(rerun.status).toBe('done');
    if (rerun.status !== 'done') return;
    expect(rerun.stats.skipped).toBe(3);
    expect(calls).toBe(3); // 零重付
  });

  it('>80K 弧分组：fubi 弧面拆 3-5 组组内串行（调用数 = 组数）', async () => {
    // 30 章大弧 fixture：facts synopsis 撑贡献量（章块本身小）。
    const bodies = Array.from({ length: 30 }, (_, i) => `第${i}章正文内容。`);
    const big = composeFixture(bodies);
    const bigBlocks = splitParagraphBlocks(big.derived);
    const bigMaterial = mkMaterial(big.chapters, big.derived);
    upsertMaterialRow(bigMaterial);
    const bigDerivedHash = sha(big.derived);

    const created = createDeconJob(
      { materialId: MAT_ID, tier: 'fine', dimensions: ['fubi'] },
      { readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: bigDerivedHash }), now: () => NOW },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    const bigDeps = { readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: bigDerivedHash }), now: () => NOW };
    expect(startDeconJob(jobId, bigDeps).ok).toBe(true);

    // 长 synopsis facts（每章 ~4.2K → 总 ~128K > 80K → ceil(1.6)=2 钳 3 组）。
    for (let ci = 0; ci < 30; ci++) {
      const bi = ci; // 每章 1 块
      upsertDeconChapterFacts({
        materialRef: MAT_REF,
        derivedHash: bigDerivedHash,
        chapterIndex: ci,
        facts: {
          synopsis: `【第${ci}章】${'概要内容很长。'.repeat(600)}`,
          entities: [],
          events: [
            {
              what: `事件${ci}`,
              span: { chapterIndex: ci, charStart: bigBlocks[bi]!.start, charEnd: bigBlocks[bi]!.end, paraStart: bi, paraEnd: bi + 1 },
            },
          ],
          relationshipEdges: [],
          foreshadowPlanted: [],
          infoGap: [],
        },
      });
    }
    upsertDeconProduct({
      jobId,
      pass: 'p3b',
      unit: 'arcs',
      payload: {
        arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 29, chapterCount: 30, charCount: big.derived.length, origin: 'single' }],
        audit: { source: 'single', volumeBoundaries: [], candidatesTotal: 0, candidatesUsed: 0, arcsMerged: 0, arcsSplit: 0 },
      },
      updatedAt: NOW.toISOString(),
    });

    let calls = 0;
    const gen: DeconGenerateText = async (input) => {
      calls += 1;
      return { text: arcFindingsFromPrompt(input.user) };
    };
    const result = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => big.derived, now: () => NOW }, 'fubi');
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.arcGroups).toBeGreaterThanOrEqual(DECON_P4_ARC_GROUP_MIN);
    expect(result.stats.arcGroups).toBeLessThanOrEqual(DECON_P4_ARC_GROUP_MAX);
    expect(calls).toBe(result.stats.arcGroups); // 组内串行 = 每组一调
    expect(getDeconPassState(jobId, 'p4:fubi', 'arc:0')?.status).toBe('done');
    deleteDeconProductsByMaterial(MAT_ID); // 大弧 facts 清场（材料级键控跨用例防串）
    upsertMaterialRow(mkMaterial());
  });

  it('CR-15 按组核验：组 1 finding 引组 3 段落 → 丢（「证据在模型实际输入内」不变量）', async () => {
    // 同 >80K 大弧形态（30 章等贡献 → 3 组）：组 1（章 0-9 窗口）应答里混一条引组 3 章 25 块
    // 的 finding——池化核验会放行（组 3 窗口在池内），按组核验必丢。
    const bodies = Array.from({ length: 30 }, (_, i) => `第${i}章正文内容。`);
    const big = composeFixture(bodies);
    const bigBlocks = splitParagraphBlocks(big.derived);
    upsertMaterialRow(mkMaterial(big.chapters, big.derived));
    const bigDerivedHash = sha(big.derived);
    const bigDeps = { readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: bigDerivedHash }), now: () => NOW };
    const created = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['fubi'] }, bigDeps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, bigDeps).ok).toBe(true);

    for (let ci = 0; ci < 30; ci++) {
      upsertDeconChapterFacts({
        materialRef: MAT_REF,
        derivedHash: bigDerivedHash,
        chapterIndex: ci,
        facts: {
          synopsis: `【第${ci}章】${'概要内容很长。'.repeat(600)}`,
          entities: [],
          events: [
            {
              what: `事件${ci}`,
              span: { chapterIndex: ci, charStart: bigBlocks[ci]!.start, charEnd: bigBlocks[ci]!.end, paraStart: ci, paraEnd: ci + 1 },
            },
          ],
          relationshipEdges: [],
          foreshadowPlanted: [],
          infoGap: [],
        },
      });
    }
    upsertDeconProduct({
      jobId,
      pass: 'p3b',
      unit: 'arcs',
      payload: {
        arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 29, chapterCount: 30, charCount: big.derived.length, origin: 'single' }],
        audit: { source: 'single', volumeBoundaries: [], candidatesTotal: 0, candidatesUsed: 0, arcsMerged: 0, arcsSplit: 0 },
      },
      updatedAt: NOW.toISOString(),
    });

    const crossInsight = '跨组段落引用应被丢弃';
    let call = 0;
    const gen: DeconGenerateText = async (input) => {
      call += 1;
      if (call === 1) {
        // 组 1：好锚条（本组窗口引文）+ 跨组锚条（组 3 章 25 块——真实原文但不在本组输入内）。
        const own = JSON.parse(arcFindingsFromPrompt(input.user)) as { findings: unknown[] };
        const cross = {
          insight: crossInsight,
          elaboration: '引文真实存在，但只在组 3 的输入里展示过。',
          evidence: [
            { paraRange: { start: 25, end: 26 }, quote: big.derived.slice(bigBlocks[25]!.start, bigBlocks[25]!.start + 8) },
          ],
          craftHint: null,
        };
        return { text: JSON.stringify({ findings: [...own.findings, cross], synthesis: '' }) };
      }
      return { text: arcFindingsFromPrompt(input.user) };
    };
    const result = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => big.derived, now: () => NOW }, 'fubi');
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.arcGroups).toBeGreaterThanOrEqual(DECON_P4_ARC_GROUP_MIN);
    expect(result.stats.arcGroups).toBeLessThanOrEqual(DECON_P4_ARC_GROUP_MAX);
    expect(result.stats.droppedNoAnchorFindings).toBe(1); // 跨组 finding 整条丢（evidence 全灭）
    expect(result.stats.droppedEvidence).toBe(1);
    const row = getDeconProduct(jobId, 'p4:fubi', 'arc:0');
    const findings = (row?.payload as { findings: Array<{ insight: string }> }).findings;
    expect(findings).toHaveLength(result.stats.arcGroups); // 每组好锚存活
    expect(findings.map((f) => f.insight)).not.toContain(crossInsight);
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
  });

  it('零手艺维（style-only job 直调）→ 直接 done 零调用', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', dimensions: ['style'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let calls = 0;
    const gen: DeconGenerateText = async () => {
      calls += 1;
      return { text: '{}' };
    };
    const result = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    expect(calls).toBe(0);
    expect(listDeconProducts(jobId)).toHaveLength(0);
  });

  it('CR-16 空弧守卫：弧内零可锚窗口（无 facts/无抽样段）→ 跳过+计数不烧 LLM（不落状态行）', async () => {
    // 清他例 facts（材料级键控跨用例防串——空弧前提 = 弧内全部章无 facts）。
    getDb().prepare('DELETE FROM closure_decon_facts').run();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['fubi'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    // 只挂弧切分/统计产物——facts 全空 → 章块零引文窗口；fubi 非细读维无抽样段。
    upsertDeconProduct({ jobId, pass: 'p3b', unit: 'arcs', payload: ARCS_PAYLOAD, updatedAt: NOW.toISOString() });
    upsertDeconProduct({ jobId, pass: 'p3b', unit: 'stats', payload: STATS_PAYLOAD, updatedAt: NOW.toISOString() });

    let calls = 0;
    const gen: DeconGenerateText = async () => {
      calls += 1;
      return { text: findingsJson([]) };
    };
    const result = await runDeconP4Craft(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW }, 'fubi');
    expect(result.status).toBe('done'); // 空弧不 fail 整 pass
    if (result.status !== 'done') return;
    expect(result.stats.emptyArcUnits).toBe(1);
    expect(result.stats.analyzed).toBe(0);
    expect(calls).toBe(0); // 零 LLM 调用（问题单必全灭核验——不烧 writer/review-judge 费）
    expect(getDeconProduct(jobId, 'p4:fubi', 'arc:0')).toBeNull(); // 不落 product 行
    expect(getDeconPassState(jobId, 'p4:fubi', 'arc:0')).toBeNull(); // 不落 running 残留状态行
    expect(getDeconJob(jobId)?.status).toBe('running'); // job 未被翻 failed
  });
});
