import { createHash } from 'node:crypto';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Material } from '@orison/shared-contracts';
import { deconStylePayloadSchema } from '@orison/shared-contracts';
import { parseStyleSections } from '@orison/desktop-agent';

// E10.3b W3b：P4 风格维测试——纯函数面（stats 渲染数字单源 / 节选 800-2000 选段 / 抽样段
// 首中尾+高潮对照 / 节解析容错 / 14 节标题与 agent parseStyleSections 键对齐）+ db 编排面
// （payload+report 双落 / 契约往返 / 断点零重调 / p3b 原料缺失诚实挂起）。ABI 门控 +
// throwaway home（mirror deconP3Label.test.ts）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-p4style');

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
vi.mock('@orison/model-protocols', () => ({ generateText: vi.fn(), generateEmbeddings: vi.fn() }));
// 注意：@orison/desktop-agent 的 parseStyleSections 是真实现消费（键对齐断言）——只 mock
// resolveTaskModel/assignmentThinkingControl（deconLlmCore 依赖面）。
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return { ...actual, resolveTaskModel: vi.fn(), assignmentThinkingControl: vi.fn() };
});

import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';
import {
  deleteDeconProductsByMaterial,
  getDeconPassState,
  getDeconProduct,
  getDeconReport,
  upsertDeconProduct,
} from '../main/db/closure-decon';
import { replaceDeconCanonEntries } from '../main/db/closure-canon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob } from '../main/decon/deconJob';
import type { DeconGenerateText } from '../main/decon/deconLlmCore';
import {
  buildChapterHeadings as buildDeconChapterHeadings,
  chapterShortLabel as deconChapterShortLabel,
} from '../main/db/chapterHeadings';
import { composeDerivedText, splitParagraphBlocks } from '../main/ipc/toolHandlers/materialIngest';
import {
  DECON_P4_STYLE_EXCERPT_MAX_CHARS,
  DECON_P4_STYLE_SAMPLES_TOTAL_CAP,
  DECON_P4_STYLE_SYSTEM_PROMPT,
  DECON_STYLE_SECTION_HEADINGS,
  collectDeconStyleSamples,
  parseDeconStyleSectionsResponse,
  renderDeconStyleReportMd,
  renderDeconStyleStats,
  runDeconP4Style,
  selectDeconStyleExcerpt,
} from '../main/decon/p4Style';
import type { DeconArc, DeconChapterLabels, DeconStatsPayload, DeconStylePayload } from '@orison/shared-contracts';

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

// ── fixtures（3 章 × 3 段；章 1 打标带爽点段作节选种子）──

const MAT_ID = 'mat-000000000008';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'b'.repeat(64)}`;

const STYLE_BODIES = [
  [
    '李逍遥在青云观的后院醒来，发现自己躺在一张竹床上。',
    '山下的集市人来人往，他买了一坛酒，遇见了赵灵儿。',
    '两人约好明日一同去后山，李逍遥心里隐约不安。',
  ].join('\n\n'),
  [
    '赵灵儿约李逍遥去后山看瀑布，两人一前一后上了山。',
    '瀑布下的水潭边有一块古碑，李逍遥伸手触碰古碑，古碑忽然发出了微弱的光。',
    '两人对视一眼，都从对方眼里看到了惊讶。',
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

const FIXTURE = composeFixture(STYLE_BODIES);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T15:00:00.000Z');
const jobDeps = () => ({ readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: DERIVED_HASH }), now: () => NOW });

function mkMaterial(): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '风格测试小说',
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
    chapters: FIXTURE.chapters,
    chunkSpans: [],
    contentHash: CONTENT_HASH,
    status: 'ready',
  };
}

function blockOf(chapterIndex: number, k: number): number {
  return chapterIndex * 3 + k;
}

function spanOf(chapterIndex: number, k: number) {
  const bi = blockOf(chapterIndex, k);
  return { chapterIndex, charStart: BLOCKS[bi]!.start, charEnd: BLOCKS[bi]!.end, paraStart: bi, paraEnd: bi + 1 };
}

const LABELS_BY_CHAPTER = new Map<number, DeconChapterLabels>([
  [
    0,
    { hooks: [], transitions: [], emotionalBeats: [], plotPhase: null, highlightSpans: [spanOf(0, 1)], expositionSpans: [], arcBoundary: null },
  ],
  [
    1,
    {
      hooks: [],
      transitions: [],
      emotionalBeats: [],
      plotPhase: '积蓄',
      highlightSpans: [spanOf(1, 1)],
      expositionSpans: [],
      arcBoundary: null,
    },
  ],
]);

const STYLE_STATS: DeconStatsPayload['styleStats'] = {
  sentenceChars: { count: 100, min: 8, avg: 18.5, max: 42, sigma: 6.2 },
  paragraphChars: { count: 60, min: 20, avg: 25.5, max: 60, sigma: 8.1 },
  dialogueLineRatio: 0.34,
};

const STATS_PAYLOAD: DeconStatsPayload = {
  book: {
    chapterCount: 3,
    charCount: DERIVED.length,
    chapterChars: { count: 3, min: 50, avg: 60, max: 70, sigma: 2 },
    highlightCount: 2,
    highlightChars: { count: 2, min: 20, avg: 25, max: 30, sigma: 5 },
    highlightIntervalChapters: { count: 1, min: 1, avg: 1, max: 1, sigma: 0 },
    hooksByType: {},
    transitionsByType: {},
    emotionalBeatsByType: {},
    infoGapByType: {},
    foreshadowPlantedCount: 0,
    foreshadowDensityPer10k: 0,
    expositionChars: { count: 0, min: 0, avg: 0, max: 0, sigma: 0 },
    hookToKernelChapterSpan: { count: 0, min: 0, avg: 0, max: 0, sigma: 0 },
  },
  arcs: [],
  styleStats: STYLE_STATS,
};

const ARCS: DeconArc[] = [{ index: 0, title: null, fromChapter: 0, toChapter: 2, chapterCount: 3, charCount: DERIVED.length, origin: 'single' }];

/** 全空打标（零爽点/零钩/零拍——合法 P3a 输出形态）。 */
const EMPTY_LABELS: DeconChapterLabels = {
  hooks: [],
  transitions: [],
  emotionalBeats: [],
  plotPhase: null,
  highlightSpans: [],
  expositionSpans: [],
  arcBoundary: null,
};

const LLM_SECTIONS_JSON = JSON.stringify({
  sections: {
    voice: '叙述者贴近主角的有限视角，语气平实里带一点暖。',
    syntax: '多用短句推进，紧张处连续动词起句。',
    prohibitions: '避免大段静态描写，情绪不直陈。',
  },
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

const maybe = sqliteUsable ? describe : describe.skip;

// ── 纯函数面 ──

describe('renderDeconStyleStats（② 机械统计——数字单源渲染）', () => {
  it('三行渲染（句长/段长/对话占比——数字来自 style_stats）', () => {
    const text = renderDeconStyleStats(STYLE_STATS);
    expect(text).toContain('均值 18.5 字');
    expect(text).toContain('均值 25.5 字');
    expect(text).toContain('对话行占比：34.0%');
  });
});

describe('selectDeconStyleExcerpt（⑬ 节选——纯代码选段）', () => {
  it('短材料：全选（<800 字接受——连续原文逐字）+ 锚可定位', () => {
    const excerpt = selectDeconStyleExcerpt(DERIVED, BLOCKS, FIXTURE.chapters, LABELS_BY_CHAPTER);
    expect(excerpt).not.toBeNull();
    if (excerpt === null) return;
    expect(excerpt.text.length).toBeGreaterThan(0);
    expect(DERIVED.slice(excerpt.anchor.charStart, excerpt.anchor.charEnd)).toBe(excerpt.text);
    expect(excerpt.anchor.chapterIndex).toBeGreaterThanOrEqual(0);
  });

  it('长材料：扩展到 ≥800 且 ≤2000（覆盖爽点种子的连续块）', () => {
    // 合成长文：5 章 × 每章 10 块 × 300 字。
    const paras: string[] = [];
    const chapters: Array<{ index: number; charStart: number; charEnd: number }> = [];
    let off = 0;
    for (let c = 0; c < 5; c++) {
      const start = off;
      for (let k = 0; k < 10; k++) {
        const p = `第${c}章第${k}段。${'很长的一段正文内容。'.repeat(22)}`;
        paras.push(p);
        off += p.length + 2;
      }
      chapters.push({ index: c, charStart: start, charEnd: off });
    }
    const longDerived = paras.join('\n\n');
    const longBlocks = splitParagraphBlocks(longDerived);
    const midBlock = 25;
    const labels = new Map<number, DeconChapterLabels>([
      [
        2,
        {
          hooks: [],
          transitions: [],
          emotionalBeats: [],
          plotPhase: null,
          highlightSpans: [
            {
              chapterIndex: 2,
              charStart: longBlocks[midBlock]!.start,
              charEnd: longBlocks[midBlock]!.end,
              paraStart: midBlock,
              paraEnd: midBlock + 1,
            },
          ],
          expositionSpans: [],
          arcBoundary: null,
        },
      ],
    ]);
    const excerpt = selectDeconStyleExcerpt(longDerived, longBlocks, chapters, labels);
    expect(excerpt).not.toBeNull();
    if (excerpt === null) return;
    expect(excerpt.text.length).toBeGreaterThanOrEqual(800);
    expect(excerpt.text.length).toBeLessThanOrEqual(DECON_P4_STYLE_EXCERPT_MAX_CHARS);
    expect(excerpt.text).toContain('第2章第5段');
    expect(longDerived.slice(excerpt.anchor.charStart, excerpt.anchor.charEnd)).toBe(excerpt.text);
  });
});

describe('collectDeconStyleSamples（抽样段——每弧首/中/尾 + 高潮对照）', () => {
  // C5：章号标签走真实章标行映射（fixture title 即「第N章」形态——title 充当章标行）。
  const HEADINGS = buildDeconChapterHeadings(DERIVED, FIXTURE.chapters);
  const chShort = (ci: number): string => deconChapterShortLabel(HEADINGS.get(ci), ci);

  it('单弧 → 首/中/尾章样本 + 高潮对照段；总上限裁剪计数', () => {
    const { samples, droppedForCap } = collectDeconStyleSamples(DERIVED, BLOCKS, FIXTURE.chapters, ARCS, LABELS_BY_CHAPTER, chShort);
    expect(samples.map((s) => s.label)).toEqual(
      expect.arrayContaining(['弧 0-2 章 · 第 1 章（弧首）', '弧 0-2 章 · 第 2 章（弧中）', '弧 0-2 章 · 第 3 章（弧尾）', '高潮对照 · 第 1 章（爽点段峰值章）']),
    );
    expect(droppedForCap).toBe(0);
    expect(samples[0]?.text.length).toBeGreaterThan(0);
  });

  it('超总上限 → 弃段计数留痕（不静默）', () => {
    // 合成长文材料：3 章各 1 块 ~1300 字（抽样段按 SAMPLE_CHAR_CAP 截 1200——61 段 > 15K）。
    const paras: string[] = [];
    const chapters: Array<{ index: number; charStart: number; charEnd: number }> = [];
    let off = 0;
    for (let c = 0; c < 3; c++) {
      const start = off;
      const p = `第${c}章。${'很长的正文段落内容。'.repeat(110)}`;
      paras.push(p);
      off += p.length + 2;
      chapters.push({ index: c, charStart: start, charEnd: off });
    }
    const longDerived = paras.join('\n\n');
    const longBlocks = splitParagraphBlocks(longDerived);
    const manyArcs: DeconArc[] = Array.from({ length: 20 }, (_, i) => ({
      index: i,
      title: null,
      fromChapter: 0,
      toChapter: 2,
      chapterCount: 3,
      charCount: longDerived.length,
      origin: 'single',
    }));
    // 合成章无 title/章标行——标签函数本测试不断言，给确定性占位即可。
    const { samples, droppedForCap } = collectDeconStyleSamples(longDerived, longBlocks, chapters, manyArcs, LABELS_BY_CHAPTER, (ci) => `第 ${ci + 1} 章`);
    const total = samples.reduce((s, x) => s + x.text.length, 0);
    expect(total).toBeLessThanOrEqual(DECON_P4_STYLE_SAMPLES_TOTAL_CAP);
    expect(samples.length).toBeGreaterThan(0);
    expect(droppedForCap).toBeGreaterThan(0);
  });

  it('全书零爽点段打标（合法 P3a 输入）→ 高潮对照诚实跳过不崩（W7 集成验收发现的空 reduce 修复）', () => {
    const emptyLabels = new Map<number, DeconChapterLabels>(FIXTURE.chapters.map((c) => [c.index, EMPTY_LABELS]));
    const { samples, droppedForCap } = collectDeconStyleSamples(DERIVED, BLOCKS, FIXTURE.chapters, ARCS, emptyLabels, chShort);
    // 弧首/中/尾样本照出；高潮对照段无峰值可取——跳过（无「高潮对照」标签），不 throw。
    expect(samples.map((s) => s.label)).toEqual(
      expect.arrayContaining(['弧 0-2 章 · 第 1 章（弧首）', '弧 0-2 章 · 第 3 章（弧尾）']),
    );
    expect(samples.some((s) => s.label.includes('高潮对照'))).toBe(false);
    expect(droppedForCap).toBe(0);
  });

  it('C5 真实章标对拍：简介伪章形态的样本标签用真章号（index+1 错位根治）', () => {
    // 真实摄取形态：简介伪章 index 0 + 真·第N章 index=N（旧 index+1 会把第2章标成「第 3 章」）。
    const parts = [
      '书名：无法告白\n\n开篇前的简介正文，自成一章。',
      '第1章 预付两百万\n\n他预付了两百万日元，转身走进了雨夜。',
      '第2章 手稿\n\n正文内容持续了相当长的一段时间。',
      '第3章 古碑\n\n两人在观中客房住下，约好明日一早去后山深处。',
    ];
    const derived = parts.join('');
    const blocks = splitParagraphBlocks(derived);
    const chapters: Array<{ index: number; title: string | null; charStart: number; charEnd: number }> = [];
    let off = 0;
    parts.forEach((p, i) => {
      chapters.push({ index: i, title: i === 0 ? null : parts[i]!.split(' ')[1] ?? null, charStart: off, charEnd: off + p.length });
      off += p.length;
    });
    const headings = buildDeconChapterHeadings(derived, chapters);
    const chShortReal = (ci: number): string => deconChapterShortLabel(headings.get(ci), ci);
    const arcs: DeconArc[] = [{ index: 0, title: null, fromChapter: 1, toChapter: 3, chapterCount: 3, charCount: derived.length, origin: 'single' }];
    // 爽点峰值在 index 3（真·第3章）——高潮对照标签必须用真章号。
    const labels = new Map<number, DeconChapterLabels>([
      [1, EMPTY_LABELS],
      [2, EMPTY_LABELS],
      [3, { ...EMPTY_LABELS, highlightSpans: [{ chapterIndex: 3, charStart: chapters[3]!.charStart + 5, charEnd: chapters[3]!.charStart + 25, paraStart: 0, paraEnd: 1 }] }],
    ]);
    const { samples } = collectDeconStyleSamples(derived, blocks, chapters, arcs, labels, chShortReal);
    expect(samples.map((s) => s.label)).toEqual(
      expect.arrayContaining(['弧 1-3 章 · 第 1 章（弧首）', '弧 1-3 章 · 第 2 章（弧中）', '弧 1-3 章 · 第 3 章（弧尾）', '高潮对照 · 第 3 章（爽点段峰值章）']),
    );
    // 错位章号（index+1 旧算术的产物——弧首会错成「第 2 章」）绝不出现在标签里。
    expect(samples.some((s) => s.label.includes('第 4 章'))).toBe(false);
  });
});

describe('parseDeconStyleSectionsResponse（节解析容错）', () => {
  it('合法节解析 + 键集外/空串丢弃计数', () => {
    const parsed = parseDeconStyleSectionsResponse(
      JSON.stringify({ sections: { voice: 'v', syntax: '', bogus: 'x', stats: '不该出现的代码节' } }),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.sections).toEqual({ voice: 'v' });
    expect(parsed.dropped).toBe(3); // 空串 + 键集外 + 代码节键（LLM 契约不含 stats）
  });

  it('顶层坏 / 零可用节 → null 整体拒收', () => {
    expect(parseDeconStyleSectionsResponse('不是 JSON')).toBeNull();
    expect(parseDeconStyleSectionsResponse('{"sections":{}}')).toBeNull();
    expect(parseDeconStyleSectionsResponse('{"sections":"x"}')).toBeNull();
  });
});

describe('DECON_STYLE_SECTION_HEADINGS ↔ agent parseStyleSections（14 节键对齐——防漂移）', () => {
  it('标准 14 节标题经 agent 解析全命中且键序一致', () => {
    const keys = Object.keys(DECON_STYLE_SECTION_HEADINGS) as Array<keyof typeof DECON_STYLE_SECTION_HEADINGS>;
    expect(keys).toHaveLength(14);
    const body = keys.map((k) => `${DECON_STYLE_SECTION_HEADINGS[k]}\n\n${k} 节内容。`).join('\n\n');
    const sections = parseStyleSections(body);
    expect(sections.map((s) => s.key)).toEqual(keys);
  });
});

describe('DECON_P4_STYLE_SYSTEM_PROMPT（网文语境 + 三代码节不进 LLM 契约）', () => {
  it('11 节键注入 + 立场（只依据材料）；不含古典例/反向禁令', () => {
    for (const key of ['"voice"', '"prohibitions"', '声音画像', '禁则']) {
      expect(DECON_P4_STYLE_SYSTEM_PROMPT).toContain(key);
    }
    expect(DECON_P4_STYLE_SYSTEM_PROMPT).toContain('机械统计、节选、附录三节由系统生成');
    // 网文语境 grep 守卫（feedback-webnovel-framing-no-classical）——标题声明的守卫实体化：
    // 零古典例零学院名号零反向禁令（mirror deconP5Output.test 的 corpus 守卫）。
    expect(DECON_P4_STYLE_SYSTEM_PROMPT).not.toMatch(
      /亚里士多德|红楼梦|水浒|三国|西游记|金瓶梅|儒林外史|麦基|热奈特|查特曼|申丹|普罗普|格雷马斯|托多罗夫|托尔斯泰|陀思妥|卡夫卡|博尔赫斯|普鲁斯特|乔伊斯|叙事学|叙述学|文学理论|经典文学|严肃文学|传统文学|纯文学|评点|起承转合|蒙太奇|戏剧反讽|价值极性/,
    );
    expect(DECON_P4_STYLE_SYSTEM_PROMPT).not.toMatch(
      /不是[^。\n]{0,12}文学|(摒弃|拒绝|排斥)[^。\n]{0,10}(学院|学术|古典|传统)|(不采用|不使用|不用)[^。\n]{0,10}(理论|学院|古典)/,
    );
  });
});

describe('renderDeconStyleReportMd（报告渲染）', () => {
  it('标准 14 节标题序渲染——存在的节才出', () => {
    const md = renderDeconStyleReportMd('测试书', {
      sections: { voice: '声音内容。', stats: '- 统计', excerpt: '```text\n原文\n```', appendix: '来源注记。' },
      excerptAnchors: [spanOf(0, 0)],
      bookTitle: '测试书',
      materialId: MAT_ID,
    });
    expect(md.startsWith('# 《测试书》风格拆解报告')).toBe(true);
    expect(md.indexOf('## ① 声音画像')).toBeGreaterThan(-1);
    expect(md.indexOf('## ② 机械统计')).toBeGreaterThan(md.indexOf('## ① 声音画像'));
    expect(md).toContain('```text');
    expect(md).not.toContain('## ③ 句法'); // 缺省节不出
  });
});

// ── db 编排面 ──

maybe('runDeconP4Style（db 编排）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
  });

  it('happy path：payload（14 节结构化）+ report（style_report md）双落同事务 + 契约往返', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', dimensions: ['style'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    upsertDeconProduct({ jobId, pass: 'p3b', unit: 'stats', payload: STATS_PAYLOAD, updatedAt: NOW.toISOString() });
    upsertDeconProduct({
      jobId,
      pass: 'p3b',
      unit: 'arcs',
      payload: { arcs: ARCS, audit: { source: 'single', volumeBoundaries: [], candidatesTotal: 0, candidatesUsed: 0, arcsMerged: 0, arcsSplit: 0 } },
      updatedAt: NOW.toISOString(),
    });
    upsertDeconProduct({ jobId, pass: 'p3a', unit: '1', payload: LABELS_BY_CHAPTER.get(1)!, updatedAt: NOW.toISOString() });
    replaceDeconCanonEntries(jobId, 'tone', [
      {
        jobId,
        domain: 'tone',
        name: '基调',
        payload: { evidence: 'inferred', baseline: '平实带暖的少年感' },
        anchors: [spanOf(0, 0)],
        provenance: { source: 'decon', materialId: MAT_ID, bookTitle: '风格测试小说' },
      },
    ]);

    const users: string[] = [];
    let calls = 0;
    const gen: DeconGenerateText = async (input) => {
      calls += 1;
      users.push(input.user);
      return { text: LLM_SECTIONS_JSON };
    };
    const result = await runDeconP4Style(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.llmSections).toBe(3);
    expect(calls).toBe(1);

    // 输入面：机械统计数字 + tone 基线 + 抽样段标记在场。
    expect(users[0]).toContain('均值 18.5 字');
    expect(users[0]).toContain('平实带暖的少年感');
    expect(users[0]).toContain('弧首');

    // product：p4:style / unit='all'——契约往返（写侧 zod 门同 schema）。
    const row = getDeconProduct(jobId, 'p4:style', 'all');
    expect(row).not.toBeNull();
    const parsed = deconStylePayloadSchema.safeParse(row?.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const payload = parsed.data as DeconStylePayload;
      expect(payload.sections.voice).toContain('有限视角');
      expect(payload.sections.stats).toContain('对话行占比：34.0%'); // ② 数字直落——LLM 不编
      expect(payload.sections.excerpt).toContain('```text'); // ⑬ fenced
      expect(payload.sections.appendix).toContain('mat-000000000008'); // ⑭ 来源注记
      expect(payload.excerptAnchors.length).toBeGreaterThanOrEqual(1);
      expect(payload.materialId).toBe(MAT_ID);
    }
    expect(getDeconPassState(jobId, 'p4:style', 'all')?.status).toBe('done');

    // report：kind='style_report' / unit='all' / dimension='style'。
    const report = getDeconReport(jobId, 'style_report', 'all');
    expect(report).not.toBeNull();
    expect(report?.dimension).toBe('style');
    expect(report?.contentMd).toContain('## ① 声音画像');
    expect(report?.contentMd).toContain('## ⑬ 节选（few-shot）');
    expect(report?.anchors.length).toBeGreaterThanOrEqual(1);
  });

  it('断点续跑：重入 skip 零重调', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', dimensions: ['style'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    upsertDeconProduct({ jobId, pass: 'p3b', unit: 'stats', payload: STATS_PAYLOAD, updatedAt: NOW.toISOString() });

    let calls = 0;
    const gen: DeconGenerateText = async () => {
      calls += 1;
      return { text: LLM_SECTIONS_JSON };
    };
    const deps = { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW };
    expect((await runDeconP4Style(jobId, deps)).status).toBe('done');
    const second = await runDeconP4Style(jobId, deps);
    expect(second.status).toBe('done');
    expect(calls).toBe(1); // 重入零重付
  });

  it('p3b 统计产物缺失 → 诚实挂起 failed（不编数字）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', dimensions: ['style'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const result = await runDeconP4Style(jobId, { generateText: async () => ({ text: LLM_SECTIONS_JSON }), readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('p3b');
    expect(getDeconProduct(jobId, 'p4:style', 'all')).toBeNull();
    expect(getDb().prepare('SELECT status FROM closure_decon_job WHERE job_id=?').get(jobId)).toMatchObject({ status: 'failed' });
  });
});
