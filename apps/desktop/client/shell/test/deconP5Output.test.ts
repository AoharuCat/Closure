import { createHash } from 'node:crypto';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconChapterLabels, DeconFacts, DeconSpan, Material } from '@orison/shared-contracts';
import { DECON_CRAFT_DIMENSION_IDS } from '@orison/shared-contracts';

// E10.3b W4：P5 输出装配测试——纯函数面（scene 候选确定性/窗口选择/prompt 装配/hash 单源/
// 网文语境 grep 守卫）+ db 编排面（三 kind 落库与 meta 读面/tier 门矩阵/断点续跑零重付/
// capped 预算门前置+length 权威停因/report 写侧门拒坏行/findings 聚合读/中断韧性/stale）。
// dogfood R3 修复批（W1b）：R1/F19 章标真值（buildDeconChapterHeadingInfos 有/无简介伪章
// 两形态 + 渲染对拍零序号算术 + 回查纯函数）+ C3 截断升帽重试两径 + C4 材料读点重试。
// ABI 门控 + throwaway home（mirror deconP3Label.test.ts）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-p5');

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
  getDeconReport,
  listDeconReportMetas,
  upsertDeconChapterFacts,
  upsertDeconJob,
  upsertDeconProduct,
  upsertDeconReport,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob, transitionDeconJob } from '../main/decon/deconJob';
import { estimateDeconCallTokens } from '../main/decon/deconRun';
import {
  DECON_P5_BOOK_GROUP_SYSTEM_PROMPT,
  DECON_P5_BOOK_INPUT_CHAR_LIMIT,
  DECON_P5_BOOK_READING_MAX_TOKENS,
  DECON_P5_BOOK_SYSTEM_PROMPT,
  DECON_P5_CHAPTER_SYSTEM_PROMPT,
  DECON_P5_SCENE_ANNOTATION_MAX_TOKENS,
  DECON_P5_SCENE_BEAT_WEIGHT,
  DECON_P5_SCENE_DENSITY_WEIGHT,
  DECON_P5_SCENE_INTENSE_BEAT_WEIGHT,
  DECON_P5_SCENE_KERNEL_WEIGHT,
  DECON_P5_SCENE_MAX_WINDOW_CHARS,
  DECON_P5_SCENE_SYSTEM_PROMPT,
  buildDeconBookReadingUserPrompt,
  buildDeconBookSynthesisUserPrompt,
  buildDeconChapterReviewUserPrompt,
  buildDeconSceneAnnotationUserPrompt,
  checkDeconChapterReferences,
  deconBookArcContributions,
  hashDeconReportOutput,
  pickDeconSceneWindow,
  runDeconP5,
  runDeconP5ChapterReview,
  runDeconP5SceneAnnotation,
  scoreDeconSceneChapters,
  selectDeconSceneCandidates,
} from '../main/decon/p5Output';
import {
  buildChapterHeadings as buildDeconChapterHeadingInfos,
  parseChapterHeadingNumber as parseDeconChapterNumber,
} from '../main/db/chapterHeadings';
import { splitDeconArcGroups } from '../main/decon/p4Craft';
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

// ── fixtures（composeDerivedText 单源构基——章 span 与派生文本坐标自洽）──
// R1/F19：章正文首行 = 真实章标行（「第N章 标题」）——与生产材料同形态（boundary.start =
// 章标行行首），chapters[].title = 章标行尾（不含「第N章」前缀）。

const MAT_ID = 'mat-000000000009';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'e'.repeat(64)}`;

const P5_TAILS = ['后院醒来', '古碑微光', '夜访老道'] as const;
const P5_PROSE: readonly (readonly string[])[] = [
  [
    '李逍遥在青云观的后院醒来，发现自己躺在一张竹床上。',
    '他想起了师父临走前说的话，心里一阵发紧。',
    '山下的集市人来人往，李逍遥买了一坛酒，遇见了赵灵儿。',
  ],
  [
    '赵灵儿约李逍遥去后山看瀑布，两人一前一后上了山。',
    '瀑布下的水潭边有一块古碑，碑上的字迹已经模糊。',
    '李逍遥伸手触碰古碑，古碑忽然发出了微弱的光。',
  ],
  [
    '夜里，青云观的老道人找到了他们，说山中有妖物出没。',
    '李逍遥决定留下来查清楚古碑的来历，赵灵儿表示要一起。',
    '两人在观中客房住下，约好明日一早去后山深处。',
  ],
];
const P5_BODIES = P5_TAILS.map((tail, i) => [`第${i + 1}章 ${tail}`, ...P5_PROSE[i]!].join('\n\n'));

function composeFixture(
  bodies: readonly string[],
  titles: readonly (string | null)[],
): { derived: string; chapters: Material['chapters'] } {
  const normalized = bodies.join('');
  let off = 0;
  const boundaries = bodies.map((body, i) => {
    const start = off;
    off += body.length;
    return { start, end: off, title: titles[i] ?? null };
  });
  const { derived, spans } = composeDerivedText(normalized, boundaries, 'regex', 'high');
  const chapters: Material['chapters'] = spans.map((s, i) => ({
    index: i,
    title: titles[i] ?? null,
    charStart: s.charStart,
    charEnd: s.charEnd,
    paraStart: 0,
    paraEnd: 0,
    confidence: 'high',
    method: 'regex',
  }));
  return { derived, chapters };
}

const FIXTURE = composeFixture(P5_BODIES, [...P5_TAILS]);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

// 简介伪章形态（dogfood R3 无法告白同构）：chapters[0] = 简介伪章（title null、无章标行），
// 真章「第N章」的 index = N——index+1 渲染族整体偏移 1 的根因现场。
const INTRO_FIXTURE = composeFixture(
  [
    ['这是开书前的简介，交代故事底色与承诺。', '全书以都市异闻为幕，主角在雨夜登场。'].join('\n\n'),
    ['第1章 暗流', '他在雨夜接到第一通电话。', '电话那头只有雨声。'].join('\n\n'),
    ['第2章 涌动', '局面开始收拢。', '他决定赴约。'].join('\n\n'),
  ],
  [null, '暗流', '涌动'],
);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T12:00:00.000Z');
const jobDeps = (derivedHash: string = DERIVED_HASH) => ({
  readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash }),
  now: () => NOW,
});

function mkMaterial(chapters: Material['chapters'] = FIXTURE.chapters, derived: string = DERIVED): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '输出测试小说',
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
      url: null,
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

// ── 种子面（P5 消费上游产物——labels/findings/arcs/stats 坐标只读 para/char 字段）──

const SPAN = (ci: number): DeconSpan => ({ chapterIndex: ci, charStart: 0, charEnd: 10, paraStart: 0, paraEnd: 1 });

function emptyLabels(): DeconChapterLabels {
  return { hooks: [], transitions: [], emotionalBeats: [], plotPhase: null, highlightSpans: [], expositionSpans: [], arcBoundary: null };
}

function seedFacts(): void {
  for (let ci = 0; ci < 3; ci++) {
    upsertDeconChapterFacts({
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: ci,
      facts: {
        synopsis: `第${ci}章概要：李逍遥在青云观的历险推进，古碑之谜露出新线索。`,
        entities: [],
        events:
          ci === 1
            ? [
                { what: '古碑发光', kernel: true, span: SPAN(ci) },
                { what: '老道人夜里警告', kernel: true, span: SPAN(ci) },
              ]
            : ci === 0
              ? [{ what: '初见古碑', kernel: true, span: SPAN(ci) }]
              : [],
        relationshipEdges: [],
        foreshadowPlanted: ci === 0 ? [{ hint: '古碑来历未明', span: SPAN(0) }] : [],
        infoGap: ci === 1 ? [{ type: '悬疑未知', span: SPAN(1) }] : [],
      },
    });
  }
}

function seedLabels(jobId: string): void {
  const t = NOW.toISOString();
  const hl = (ci: number, block: number): DeconSpan => ({
    chapterIndex: ci,
    charStart: BLOCKS[block]!.start,
    charEnd: BLOCKS[block]!.end,
    paraStart: block,
    paraEnd: block + 1,
  });
  // 评分面：章 1 最强（爽点 + 双高唤起拍 + 双核心事件）；章 0/2 正分居后 → top1=章 1。
  // 块布局（含章标行块）：[0]=h0 [1-3]=ch0 prose [4]=h1 [5-7]=ch1 prose [8]=h2 [9-11]=ch2 prose。
  upsertDeconProduct({
    jobId,
    pass: 'p3a',
    unit: '0',
    updatedAt: t,
    payload: { ...emptyLabels(), highlightSpans: [hl(0, 1)], emotionalBeats: [{ beat: '拉扯', span: hl(0, 1) }] },
  });
  upsertDeconProduct({
    jobId,
    pass: 'p3a',
    unit: '1',
    updatedAt: t,
    payload: {
      ...emptyLabels(),
      highlightSpans: [hl(1, 5)],
      emotionalBeats: [
        { beat: '上行', span: hl(1, 5) },
        { beat: '层层递进', span: hl(1, 6) },
      ],
      plotPhase: '释放',
    },
  });
  upsertDeconProduct({
    jobId,
    pass: 'p3a',
    unit: '2',
    updatedAt: t,
    payload: { ...emptyLabels(), highlightSpans: [hl(2, 9)] },
  });
}

function seedFindings(jobId: string): void {
  const t = NOW.toISOString();
  upsertDeconProduct({
    jobId,
    pass: 'p4:qidaigan',
    unit: 'ch:0',
    updatedAt: t,
    payload: {
      findings: [
        {
          insight: '断章收在情绪高点，钩子型为人物情感钩',
          elaboration: '章末把悬念挂在新人物身上，读者带着「他是谁」翻下一章。',
          evidence: [{ paraRange: { start: 0, end: 1 }, quote: '李逍遥在青云观的后院醒来' }],
          craftHint: { category: 'qidaigan', termHint: '断章钩子' },
        },
      ],
      synthesis: '本章钩子布置干净，铺垫与兑现一章内闭环。',
    },
  });
  upsertDeconProduct({
    jobId,
    pass: 'p4:jiegou',
    unit: 'arc:0',
    updatedAt: t,
    payload: {
      findings: [
        {
          insight: '弧级骨架结论只应进弧面消费',
          elaboration: '此条用于断言章评输入不混入弧级 findings。',
          evidence: [{ paraRange: { start: 0, end: 1 }, quote: '弧级专用证据' }],
          craftHint: null,
        },
      ],
      synthesis: '',
    },
  });
}

function seedArcsStats(jobId: string): void {
  const t = NOW.toISOString();
  const d = (count: number, min: number, avg: number, max: number, sigma: number) => ({ count, min, avg, max, sigma });
  upsertDeconProduct({
    jobId,
    pass: 'p3b',
    unit: 'arcs',
    updatedAt: t,
    payload: {
      arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 2, chapterCount: 3, charCount: 150, origin: 'single' }],
      audit: { source: 'single', volumeBoundaries: [], candidatesTotal: 0, candidatesUsed: 0, arcsMerged: 0, arcsSplit: 0 },
    },
  });
  upsertDeconProduct({
    jobId,
    pass: 'p3b',
    unit: 'stats',
    updatedAt: t,
    payload: {
      book: {
        chapterCount: 3,
        charCount: 150,
        chapterChars: d(3, 40, 50, 60, 8.2),
        highlightCount: 3,
        highlightChars: d(3, 18, 20, 22, 1.6),
        highlightIntervalChapters: d(2, 0, 1, 2, 1),
        hooksByType: { 人物情感钩: 1 },
        transitionsByType: { 反差转折: 1 },
        emotionalBeatsByType: { 拉扯: 1, 上行: 1, 层层递进: 1 },
        infoGapByType: { 悬疑未知: 1 },
        foreshadowPlantedCount: 1,
        foreshadowDensityPer10k: 66.7,
        expositionChars: d(0, 0, 0, 0, 0),
        hookToKernelChapterSpan: d(1, 0, 0, 0, 0),
      },
      arcs: [
        {
          index: 0,
          fromChapter: 0,
          toChapter: 2,
          chapterCount: 3,
          charCount: 150,
          chapterChars: d(3, 40, 50, 60, 8.2),
          hookCount: 1,
          transitionCount: 1,
          highlightCount: 3,
          emotionalBeatCount: 3,
          infoGapCount: 1,
          foreshadowPlantedCount: 1,
          plotPhaseCounts: { 拉仇恨: 0, 积蓄: 0, 释放: 1, 落袋为安: 0 },
        },
      ],
      styleStats: { sentenceChars: d(9, 8, 12, 16, 2.5), paragraphChars: d(9, 15, 18, 22, 2), dialogueLineRatio: 0.2 },
    },
  });
}

// ── mock LLM（按 user prompt 分节标记分派回放文本）──

const BOOK_MD = '# 拆书读法\n\n## 整体结构判定\n\n递进阶梯式。\n\n## 主题\n\n讲的是守护。';
const CHAPTER_MD = '## 章导读\n\n这章落在困境阻碍一环。\n\n## 章收束\n\n断章钩子干净。';
const SCENE_MD = '## 场景定位\n\n古碑发光一场。\n\n## 逐词细读\n\n「微弱」一词见功力。';

function kindOf(user: string): 'book' | 'chapter' | 'scene' {
  if (user.includes('【书级问题单')) return 'book';
  if (user.includes('本场正文')) return 'scene';
  return 'chapter';
}

const MDS: Record<'book' | 'chapter' | 'scene', string> = { book: BOOK_MD, chapter: CHAPTER_MD, scene: SCENE_MD };

beforeAll(() => {
  if (sqliteUsable) {
    rmBestEffort(TEST_HOME);
    getDb();
  }
});

afterAll(() => {
  clean();
});

// ── 纯函数面：章标真值与章号解析（R1/F19）──

describe('parseDeconChapterNumber（阿拉伯/汉字数字——章号域）', () => {
  it('阿拉伯（含全角归一）与汉字数字（万级以内）', () => {
    expect(parseDeconChapterNumber('3')).toBe(3);
    expect(parseDeconChapterNumber('０３')).toBe(3);
    expect(parseDeconChapterNumber('12')).toBe(12);
    expect(parseDeconChapterNumber('十二')).toBe(12);
    expect(parseDeconChapterNumber('二十三')).toBe(23);
    expect(parseDeconChapterNumber('一百零三')).toBe(103);
    expect(parseDeconChapterNumber('两百零三')).toBe(203);
    expect(parseDeconChapterNumber('三千五百')).toBe(3500);
  });

  it('非法输入与汉字零 → null（阿拉伯 0 保留可核验）', () => {
    expect(parseDeconChapterNumber('x')).toBeNull();
    expect(parseDeconChapterNumber('')).toBeNull();
    expect(parseDeconChapterNumber('零')).toBeNull();
    expect(parseDeconChapterNumber('0')).toBe(0);
  });
});

describe('buildDeconChapterHeadingInfos（章标真值——R1/F19 渲染锚定）', () => {
  it('无简介形态：章标行原词 + 章号从章标行解析（chapters[0] 即第1章）', () => {
    const headings = buildDeconChapterHeadingInfos(DERIVED, FIXTURE.chapters);
    expect(headings.get(0)).toEqual({
      chapterIndex: 0,
      headingLine: '第1章 后院醒来',
      title: '后院醒来',
      label: '第1章 后院醒来',
      number: 1,
    });
    expect(headings.get(1)).toEqual({ chapterIndex: 1, headingLine: '第2章 古碑微光', title: '古碑微光', label: '第2章 古碑微光', number: 2 });
    expect(headings.get(2)).toEqual({ chapterIndex: 2, headingLine: '第3章 夜访老道', title: '夜访老道', label: '第3章 夜访老道', number: 3 });
  });

  it('简介伪章形态（dogfood R3 同构）：index 0 → 简介（卷首）；真章 index=N → 第N章（零序号算术）', () => {
    const headings = buildDeconChapterHeadingInfos(INTRO_FIXTURE.derived, INTRO_FIXTURE.chapters);
    expect(headings.get(0)).toEqual({ chapterIndex: 0, headingLine: null, title: null, label: '简介（卷首）', number: null });
    // 回归锚：旧 index+1 渲染会把 index 1 错标成「第 2 章」——真实章标是第1章。
    expect(headings.get(1)).toEqual({ chapterIndex: 1, headingLine: '第1章 暗流', title: '暗流', label: '第1章 暗流', number: 1 });
    expect(headings.get(2)).toEqual({ chapterIndex: 2, headingLine: '第2章 涌动', title: '涌动', label: '第2章 涌动', number: 2 });
  });

  it('无标题裸章标（第12章 无尾）→ 章标行在场、章号可解析；ATX 前缀剥离', () => {
    const bare = '第12章\n\n正文偏短。';
    const bareInfo = buildDeconChapterHeadingInfos(bare, [{ index: 0, title: null, charStart: 0, charEnd: bare.length }]);
    expect(bareInfo.get(0)).toEqual({ chapterIndex: 0, headingLine: '第12章', title: null, label: '第12章', number: 12 });
    const atx = '## 第5章 雨夜\n\n正文。';
    const atxInfo = buildDeconChapterHeadingInfos(atx, [{ index: 0, title: '雨夜', charStart: 0, charEnd: atx.length }]);
    expect(atxInfo.get(0)).toEqual({ chapterIndex: 0, headingLine: '第5章 雨夜', title: '雨夜', label: '第5章 雨夜', number: 5 });
  });

  it('章标行缺席回落：title 在场 → 《title》；单章无标书 → 正文（无章标）', () => {
    const proseOnly = '普通叙述首行，没有章标。\n\n正文继续。';
    const fallback = buildDeconChapterHeadingInfos(proseOnly, [
      { index: 0, title: '某题', charStart: 0, charEnd: proseOnly.length },
    ]);
    expect(fallback.get(0)).toEqual({ chapterIndex: 0, headingLine: null, title: '某题', label: '《某题》', number: null });
    const single = buildDeconChapterHeadingInfos(proseOnly, [
      { index: 0, title: null, charStart: 0, charEnd: proseOnly.length },
    ]);
    expect(single.get(0)?.label).toBe('正文（无章标）');
  });
});

// ── 纯函数面：章引用回查（R1/F19 后半——只标注不改写）──

describe('checkDeconChapterReferences（「第N章」引用对照真实章标核验）', () => {
  const CHECK_CHAPTERS = [
    { index: 0, title: '预付200万日元', charStart: 0, charEnd: 100, paraStart: 0, paraEnd: 2 },
    { index: 1, title: '深夜来电', charStart: 100, charEnd: 200, paraStart: 2, paraEnd: 4 },
    { index: 2, title: '初次交锋', charStart: 200, charEnd: 300, paraStart: 4, paraEnd: 6 },
  ];
  const CHECK_HEADINGS = new Map(
    CHECK_CHAPTERS.map((c, i) => {
      const headingLine = `第${i + 3}章 ${c.title}`;
      return [c.index, { chapterIndex: c.index, headingLine, title: null, label: headingLine, number: i + 3 }];
    }),
  );

  it('错位样本（dogfood R3）：引用号与标题指向不同章 → title-mismatch + 错位章 anchors + 末尾注记', () => {
    const md = '开篇钩子极强，第4章 预付200万日元 的桥段值得细读。';
    const result = checkDeconChapterReferences(md, CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      kind: 'title-mismatch',
      refNumber: 4,
      refTitle: '预付200万日元',
      actualChapterIndex: 0,
      actualLabel: '第3章 预付200万日元',
    });
    expect(result.anchors).toEqual([{ chapterIndex: 0, charStart: 0, charEnd: 100, paraStart: 0, paraEnd: 2 }]);
    expect(result.contentMd.startsWith(md)).toBe(true); // 正文原样（只标注不改写）
    expect(result.contentMd).toContain('【章引用校验】');
    expect(result.contentMd).toContain('实际章标是「第3章 预付200万日元」');
  });

  it('书名号形态（第4章《预付200万日元》）同样命中；重复错位去重为一条注记', () => {
    const md = '「第4章《预付200万日元》」直接封神。第4章《预付200万日元》再证一次。';
    const result = checkDeconChapterReferences(md, CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ kind: 'title-mismatch', actualChapterIndex: 0 });
    expect(result.contentMd.split('实际章标是').length - 1).toBe(1); // 注记只落一条
  });

  it('正例（章号与标题一致）与无引用文 → 零改动零锚零注记', () => {
    const ok = checkDeconChapterReferences('第3章 预付200万日元 是全书最强钩子。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(ok.mismatches).toEqual([]);
    expect(ok.anchors).toEqual([]);
    expect(ok.contentMd).toBe('第3章 预付200万日元 是全书最强钩子。');
    const none = checkDeconChapterReferences('整体呈递进阶梯式，中段换地图一次。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(none.mismatches).toEqual([]);
    expect(none.contentMd).toBe('整体呈递进阶梯式，中段换地图一次。');
  });

  it('越界/越下界章号（第99章/第0章）→ number-missing + 章号域注记，无锚', () => {
    const result = checkDeconChapterReferences('结尾的「第99章」收束仓促，「第0章」也未交代。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(result.mismatches).toHaveLength(2);
    expect(result.mismatches.map((m) => m.refNumber)).toEqual([99, 0]);
    expect(result.mismatches.every((m) => m.kind === 'number-missing' && m.actualChapterIndex === null)).toBe(true);
    expect(result.anchors).toEqual([]);
    expect(result.contentMd).toContain('在材料章标中不存在（材料「第N章」族章号 3-5）');
  });

  it('区间引用（第M-N章）两端各自核验', () => {
    const ok = checkDeconChapterReferences('第3-5章 构成第一幕。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(ok.mismatches).toEqual([]);
    const bad = checkDeconChapterReferences('第3-99章 跨度太大。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(bad.mismatches).toHaveLength(1);
    expect(bad.mismatches[0]).toMatchObject({ kind: 'number-missing', refNumber: 99 });
  });

  it('CR-10：区间连接符「到/全角－」——「第3章到第5章」不吞成伪标题尾（末号失验根因）', () => {
    const ok = checkDeconChapterReferences('第3章到第5章 构成第一幕。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(ok.mismatches).toEqual([]); // 两端 3/5 都在——区间正确解析
    // 旧 regex：到 不在连接符集 → 第99章 被吞进「第3章」的标题尾 → 末号零核验（漏报）。
    const bad = checkDeconChapterReferences('第3章到第99章 跨度太大。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(bad.mismatches).toHaveLength(1);
    expect(bad.mismatches[0]).toMatchObject({ kind: 'number-missing', refNumber: 99 });
    const full = checkDeconChapterReferences('第3章－第99章 跨度太大。', CHECK_CHAPTERS, CHECK_HEADINGS);
    expect(full.mismatches).toHaveLength(1);
    expect(full.mismatches[0]).toMatchObject({ kind: 'number-missing', refNumber: 99 });
  });

  it('CR-9：重复标题被多章持有 → 该标题退出核验（不 last-write-wins 归错章误报 title-mismatch）', () => {
    // 第1章 与 第5章 同题「上」——引用「第1章 上」号题一致；last-write-wins 会把它定位到
    // 末次持有章（第5章）→ 5≠1 误报 title-mismatch + 错锚。重复即弃 → 零错位。
    const chapters = [
      { index: 0, title: '上', charStart: 0, charEnd: 100, paraStart: 0, paraEnd: 2 },
      { index: 1, title: '上', charStart: 100, charEnd: 200, paraStart: 2, paraEnd: 4 },
    ];
    const headings = new Map([
      [0, { chapterIndex: 0, headingLine: '第1章 上', title: '上', label: '第1章 上', number: 1 }],
      [1, { chapterIndex: 1, headingLine: '第5章 上', title: '上', label: '第5章 上', number: 5 }],
    ]);
    const result = checkDeconChapterReferences('第1章 上 的开章立得住。', chapters, headings);
    expect(result.mismatches).toEqual([]);
    expect(result.anchors).toEqual([]);
    expect(result.contentMd).toBe('第1章 上 的开章立得住。');
  });

  it('CR-9：重复章号（卷/章共号）裸引用 → 存在性判定不受重复影响（不误报 number-missing）', () => {
    // 章号域存在性（Set）与标题归因（重复即弃）分立：第3章 与 第三卷 解析同号 3——引用
    // 「第3章」存在即过，不因重复被剔除出存在集。
    const chapters = [
      { index: 0, title: '甲', charStart: 0, charEnd: 100, paraStart: 0, paraEnd: 2 },
      { index: 1, title: '乙', charStart: 100, charEnd: 200, paraStart: 2, paraEnd: 4 },
    ];
    const headings = new Map([
      [0, { chapterIndex: 0, headingLine: '第3章 甲', title: '甲', label: '第3章 甲', number: 3 }],
      [1, { chapterIndex: 1, headingLine: '第三卷 乙', title: '乙', label: '第三卷 乙', number: 3 }],
    ]);
    const result = checkDeconChapterReferences('第3章 的钩子干净。', chapters, headings);
    expect(result.mismatches).toEqual([]);
    expect(result.contentMd).toBe('第3章 的钩子干净。');
  });

  it('材料无「第N章」族章标（序章体）→ 核验面不成立整体跳过', () => {
    const chapters = [{ index: 0, title: null, charStart: 0, charEnd: 50, paraStart: 0, paraEnd: 1 }];
    const headings = new Map([[0, { chapterIndex: 0, headingLine: '序章', title: null, label: '序章', number: null }]]);
    const md = '第5章 的伏笔未回收。';
    const result = checkDeconChapterReferences(md, chapters, headings);
    expect(result.mismatches).toEqual([]);
    expect(result.contentMd).toBe(md);
  });
});

// ── 纯函数面：scene 候选与窗口 ──

describe('scoreDeconSceneChapters / selectDeconSceneCandidates（候选=纯代码——确定性钉死）', () => {
  const span = (ci: number, len: number): DeconSpan => ({ chapterIndex: ci, charStart: 0, charEnd: len, paraStart: 0, paraEnd: 1 });
  const labelsWith = (over: Partial<DeconChapterLabels>): DeconChapterLabels => ({ ...emptyLabels(), ...over });
  const factsWith = (kernels: number, ci: number): DeconFacts => ({
    synopsis: 'x',
    entities: [],
    events: Array.from({ length: kernels }, () => ({ what: 'e', kernel: true, span: span(ci, 10) })),
    relationshipEdges: [],
    foreshadowPlanted: [],
    infoGap: [],
  });
  const chapters = [0, 1, 2, 3, 4].map((index) => ({ index }));
  const chapterChars = [100, 100, 100, 100, 100];
  const labelsMap = new Map<number, DeconChapterLabels>([
    [0, labelsWith({ highlightSpans: [span(0, 50)], emotionalBeats: [{ beat: '上行', span: span(0, 10) }] })],
    [1, labelsWith({ highlightSpans: [span(1, 45)] })],
    [3, labelsWith({ highlightSpans: [span(3, 20)] })],
    [4, labelsWith({ highlightSpans: [span(4, 10)] })],
  ]);
  const factsMap = new Map<number, DeconFacts>([
    [0, factsWith(1, 0)],
    [1, factsWith(1, 1)],
  ]);

  it('评分公式：密度×W密度 + 核心事件×W核心 + 高唤起拍×W强拍 + 其余拍×W拍', () => {
    const scored = scoreDeconSceneChapters(chapters, chapterChars, labelsMap, factsMap);
    // 章 0：0.5×3 + 1×2 + 1×1.5 + 0×0.5 = 5。
    expect(scored[0]?.score).toBe(
      0.5 * DECON_P5_SCENE_DENSITY_WEIGHT +
        1 * DECON_P5_SCENE_KERNEL_WEIGHT +
        1 * DECON_P5_SCENE_INTENSE_BEAT_WEIGHT +
        0 * DECON_P5_SCENE_BEAT_WEIGHT,
    );
    expect(scored[0]).toMatchObject({ kernelEvents: 1, intenseBeats: 1, otherBeats: 0 });
    // 章 2 零分量（无 labels/facts）→ score 0。
    expect(scored[2]?.score).toBe(0);
  });

  it('top N = max(1, round(章数×0.3))；非相邻章去重（相邻强章让位）；零分章不进池', () => {
    const picked = selectDeconSceneCandidates(chapters, chapterChars, labelsMap, factsMap);
    // N = round(5×0.3) = 2；序：0(5) → 1(3.35) 相邻跳过 → 3(0.6) 入选。
    expect(picked).toEqual([0, 3]);
  });

  it('同输入两跑同选择（确定性）', () => {
    const a = selectDeconSceneCandidates(chapters, chapterChars, labelsMap, factsMap);
    const b = selectDeconSceneCandidates(chapters, chapterChars, labelsMap, factsMap);
    expect(a).toEqual(b);
  });

  it('单章书 N 至少 1；全零分书零场景（诚实不硬选）', () => {
    const one = selectDeconSceneCandidates([{ index: 0 }], [100], labelsMap, factsMap);
    expect(one).toEqual([0]);
    const none = selectDeconSceneCandidates(chapters, chapterChars, new Map(), new Map());
    expect(none).toEqual([]);
  });
});

describe('pickDeconSceneWindow（窗口=纯代码——整章或峰值扩展）', () => {
  it('小章 → 整章窗口（含 span 全五元组）；章无相交块 → null', () => {
    const chapter = { index: 1, charStart: FIXTURE.chapters[1]!.charStart, charEnd: FIXTURE.chapters[1]!.charEnd };
    const win = pickDeconSceneWindow(BLOCKS, chapter, undefined, undefined);
    expect(win).not.toBeNull();
    if (win === null) return;
    // 块布局（含章标行块）：ch1 = 章标块 4 + 正文块 5-7 → 窗口 [4, 8)。
    expect([win.from, win.to]).toEqual([4, 8]);
    expect(win.span).toEqual({
      chapterIndex: 1,
      charStart: BLOCKS[4]!.start,
      charEnd: BLOCKS[7]!.end,
      paraStart: 4,
      paraEnd: 8,
    });
    const empty = pickDeconSceneWindow(BLOCKS, { index: 9, charStart: DERIVED.length, charEnd: DERIVED.length }, undefined, undefined);
    expect(empty).toBeNull();
  });

  it('大章 → 最大爽点段为峰锚，右先左右交替扩展至预算（块粒度不劈段）', () => {
    const para = '雨'.repeat(1_500);
    const big = Array.from({ length: 10 }, () => para).join('\n\n');
    const bigBlocks = splitParagraphBlocks(big);
    const chapter = { index: 0, charStart: 0, charEnd: big.length };
    const labels: DeconChapterLabels = {
      ...emptyLabels(),
      highlightSpans: [{ chapterIndex: 0, charStart: bigBlocks[5]!.start, charEnd: bigBlocks[5]!.end, paraStart: 5, paraEnd: 6 }],
    };
    const win = pickDeconSceneWindow(bigBlocks, chapter, labels, undefined);
    expect(win).not.toBeNull();
    if (win === null) return;
    // 峰块 5 在窗内；窗口不含峰的窗口 = 编造。
    expect(win.from).toBeLessThanOrEqual(5);
    expect(win.to).toBeGreaterThan(5);
    const chars = bigBlocks.slice(win.from, win.to).reduce((s, b) => s + (b.end - b.start), 0);
    expect(chars).toBeGreaterThanOrEqual(DECON_P5_SCENE_MAX_WINDOW_CHARS - 1_500);
    expect(chars).toBeLessThanOrEqual(DECON_P5_SCENE_MAX_WINDOW_CHARS + 1_500);
  });
});

// ── 纯函数面：prompt 装配（R1/F19——章标对照表 + 真实章标渲染，零序号算术）──

const HEADING_MAP = buildDeconChapterHeadingInfos(DERIVED, FIXTURE.chapters);
const INTRO_HEADING_MAP = buildDeconChapterHeadingInfos(INTRO_FIXTURE.derived, INTRO_FIXTURE.chapters);

describe('prompt 装配（纯函数）', () => {
  it('book：材料信息 + 章标对照表 + 弧聚合概要（真实章标行）+ 统计块 + 维1/3/5 书级问题单末置', () => {
    const user = buildDeconBookReadingUserPrompt({
      bookTitle: '输出测试小说',
      chapterCount: 3,
      charCount: 150,
      arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 2, chapterCount: 3, charCount: 150, origin: 'single' }],
      synopsesByChapter: new Map([
        [0, '第0章概要'],
        [1, '第1章概要'],
        [2, '第2章概要'],
      ]),
      stats: null,
      chapterHeadings: HEADING_MAP,
    });
    expect(user).toContain('书名：输出测试小说');
    expect(user).toContain('共 3 章 / 150 字');
    // R1/F19：章标对照表注入（引用真值源）+ 概要行用章标行原词。
    expect(user).toContain('【章节章标对照表');
    expect(user).toContain('- 第1章 后院醒来');
    expect(user).toContain('- 第2章 古碑微光');
    expect(user).toContain('【弧 0｜第 1-3 章｜3 章】'); // 章号自章标行解析（1..3）
    expect(user).toContain('- 第1章 后院醒来：第0章概要');
    expect(user).toContain('- 第3章 夜访老道：第2章概要');
    expect(user).not.toContain('【全书计量统计'); // stats null → 统计块省略（问题单 usage 文本提及不算块注入）
    expect(user).toContain('【书级问题单');
    // 维 1/3/5 问题单注入且按序末置。
    expect(user.indexOf('分析任务：获客漏斗')).toBeGreaterThan(0);
    expect(user.indexOf('分析任务：结构与多线')).toBeGreaterThan(user.indexOf('分析任务：获客漏斗'));
    expect(user.indexOf('分析任务：世界观容纳度')).toBeGreaterThan(user.indexOf('分析任务：结构与多线'));
    expect(user.indexOf('【书级问题单')).toBeLessThan(user.indexOf('分析任务：获客漏斗'));
  });

  it('book：简介伪章形态——弧头区间语义回落、概要行简介回落（index+1 偏移回归锚）', () => {
    const user = buildDeconBookReadingUserPrompt({
      bookTitle: '无法告白',
      chapterCount: 3,
      charCount: 200,
      arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 2, chapterCount: 3, charCount: 200, origin: 'single' }],
      synopsesByChapter: new Map([
        [0, '简介概要'],
        [1, '第1章概要'],
      ]),
      stats: null,
      chapterHeadings: INTRO_HEADING_MAP,
    });
    expect(user).toContain('- 简介（卷首）');
    expect(user).toContain('- 第1章 暗流'); // 对照表：index 1 的真实章标（旧 index+1 会错成「第 2 章」）
    expect(user).toContain('- 简介（卷首）：简介概要');
    expect(user).toContain('- 第1章 暗流：第1章概要');
    // 弧头：from 章无号（简介）→ 语义回落区间。
    expect(user).toContain('【弧 0｜从简介（卷首）到第2章 涌动｜3 章】');
  });

  it('synthesis：分组草稿 + 章标对照表 + 保留真实章标指令', () => {
    const user = buildDeconBookSynthesisUserPrompt({
      bookTitle: '输出测试小说',
      chapterCount: 3,
      charCount: 150,
      stats: null,
      groupDrafts: ['# 本组草稿\n\n覆盖若干段。'],
      chapterHeadings: HEADING_MAP,
    });
    expect(user).toContain('【章节章标对照表');
    expect(user).toContain('【分组草稿');
    expect(user).toContain('真实章标原词，不要按序号推算章号');
    expect(user).toContain('- 第2章 古碑微光');
  });

  it('chapter：概要/facts 摘要 + 打标 + findings 聚合（含证据段落号与引文）', () => {
    const span = SPAN(0);
    const user = buildDeconChapterReviewUserPrompt({
      bookTitle: '输出测试小说',
      chapterIndex: 0,
      chapterLabel: '第1章 后院醒来',
      facts: {
        synopsis: '章概要X',
        entities: [],
        events: [{ what: '古碑发光', kernel: true, span }],
        relationshipEdges: [],
        foreshadowPlanted: [{ hint: '古碑来历', span }],
        infoGap: [{ type: '悬疑未知', span }],
      },
      labels: {
        hooks: [{ type: '人物情感钩', span }],
        transitions: [],
        emotionalBeats: [],
        plotPhase: '积蓄',
        highlightSpans: [span],
        expositionSpans: [],
        arcBoundary: null,
      },
      findings: [
        {
          pass: 'p4:qidaigan',
          findings: {
            findings: [
              {
                insight: '断章干净',
                elaboration: '展开一句',
                evidence: [{ paraRange: { start: 0, end: 2 }, quote: '原文引文' }],
                craftHint: null,
              },
            ],
            synthesis: '小结',
          },
        },
      ],
    });
    expect(user).toContain('本章：第1章 后院醒来'); // R1/F19：真实章标原词定位
    expect(user).toContain('概要：章概要X');
    expect(user).toContain('古碑发光（P0，核心事件）');
    expect(user).toContain('伏笔埋点：古碑来历（P0）');
    expect(user).toContain('悬疑未知（P0）');
    expect(user).toContain('钩子：人物情感钩（P0）');
    expect(user).toContain('章主导相位：积蓄');
    expect(user).toContain('【期待感与铺垫】');
    expect(user).toContain('小结：小结');
    expect(user).toContain('断章干净');
    expect(user).toContain('P0-P1「原文引文」');
  });

  it('chapter：零输入面占位（无 facts / 无打标 / 无发现）', () => {
    const user = buildDeconChapterReviewUserPrompt({
      bookTitle: 'x',
      chapterIndex: 0,
      chapterLabel: '第1章 后院醒来',
      facts: null,
      labels: null,
      findings: [],
    });
    expect(user).toContain('（本章无事实提取记录。）');
    expect(user).toContain('（无打标记录。）');
    expect(user).toContain('（本章无手艺层发现');
  });

  it('scene：场次定位（真实章标）+ 【P段号】正文 + 范围注记 + 窗口内标签', () => {
    const win = pickDeconSceneWindow(
      BLOCKS,
      { index: 1, charStart: FIXTURE.chapters[1]!.charStart, charEnd: FIXTURE.chapters[1]!.charEnd },
      undefined,
      undefined,
    );
    expect(win).not.toBeNull();
    if (win === null) return;
    const user = buildDeconSceneAnnotationUserPrompt({
      bookTitle: '输出测试小说',
      sceneRank: 0,
      sceneTotal: 1,
      chapterIndex: 1,
      chapterLabel: '第2章 古碑微光',
      derived: DERIVED,
      blocks: BLOCKS,
      window: win,
      labels: null,
    });
    expect(user).toContain('本场：第2章 古碑微光 · 选定名场面第 1 场（共 1 场）'); // 章标原词 + 选定序自枚举
    expect(user).toContain('【P4】');
    expect(user).toContain('【P5】');
    expect(user).toContain('（本场景段落号范围 P4–P7');
    expect(user).toContain('（无打标记录。）');
    expect(user).toContain('瀑布下的水潭边有一块古碑'); // 窗口 = 章 1 全文（【P段号】标记形态）
  });
});

describe('system prompt（立场段前置共用 + 各 kind 输出骨架）', () => {
  it('三 kind 均含立场段（学优点默认/呼应证据）+ 各自骨架小节在场', () => {
    for (const p of [DECON_P5_BOOK_SYSTEM_PROMPT, DECON_P5_CHAPTER_SYSTEM_PROMPT, DECON_P5_SCENE_SYSTEM_PROMPT]) {
      expect(p).toContain('学优点');
      expect(p).toContain('呼应证据');
      expect(p).toContain('paraRange');
    }
    expect(DECON_P5_BOOK_SYSTEM_PROMPT).toContain('整体结构判定');
    expect(DECON_P5_BOOK_SYSTEM_PROMPT).toContain('核心节奏公式');
    expect(DECON_P5_BOOK_SYSTEM_PROMPT).toContain('换地图逻辑');
    expect(DECON_P5_BOOK_SYSTEM_PROMPT).toContain('四因总分解');
    expect(DECON_P5_CHAPTER_SYSTEM_PROMPT).toContain('章导读');
    expect(DECON_P5_CHAPTER_SYSTEM_PROMPT).toContain('章收束');
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).toContain('切入点');
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).toContain('场景结构');
    // CR-28 七问拆节：镜头语言/场景缝合/视角游移各一节（原「镜头语言与场景缝合…（视角游移）」
    // 合并节拆回逐项——design §4 逐项列举接线）。
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).toContain('## 镜头语言 ——');
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).toContain('## 场景缝合 ——');
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).toContain('## 视角游移 ——');
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).not.toContain('镜头语言与场景缝合');
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).toContain('对话三层');
    expect(DECON_P5_SCENE_SYSTEM_PROMPT).toContain('逐词细读');
  });

  it('R1/F19：书级读法/分组骨架强制真实章标原词引用 + 禁序号算术', () => {
    expect(DECON_P5_BOOK_SYSTEM_PROMPT).toContain('章标原词');
    expect(DECON_P5_BOOK_SYSTEM_PROMPT).toContain('禁止按材料内部序号自行推算章号');
    expect(DECON_P5_BOOK_GROUP_SYSTEM_PROMPT).toContain('照抄输入章标对照表里的章标原词');
  });

  it('反工具硬化行随立场段覆盖三 kind 与分组骨架', () => {
    for (const p of [
      DECON_P5_BOOK_SYSTEM_PROMPT,
      DECON_P5_CHAPTER_SYSTEM_PROMPT,
      DECON_P5_SCENE_SYSTEM_PROMPT,
      DECON_P5_BOOK_GROUP_SYSTEM_PROMPT,
    ]) {
      expect(p).toContain('不要使用任何工具（联网搜索、命令执行、浏览器等）');
    }
  });

  it('网文语境 grep 守卫（零古典例零学院名号零反向禁令——feedback-webnovel-framing-no-classical）', () => {
    const bookUser = buildDeconBookReadingUserPrompt({
      bookTitle: '输出测试小说',
      chapterCount: 3,
      charCount: 150,
      arcs: [{ index: 0, title: null, fromChapter: 0, toChapter: 2, chapterCount: 3, charCount: 150, origin: 'single' }],
      synopsesByChapter: new Map([[0, '概要']]),
      stats: null,
      chapterHeadings: HEADING_MAP,
    });
    const chapterUser = buildDeconChapterReviewUserPrompt({
      bookTitle: 'x',
      chapterIndex: 0,
      chapterLabel: '第1章 后院醒来',
      facts: null,
      labels: null,
      findings: [],
    });
    const win = pickDeconSceneWindow(BLOCKS, { index: 0, charStart: 0, charEnd: DERIVED.length }, undefined, undefined);
    const sceneUser =
      win === null
        ? ''
        : buildDeconSceneAnnotationUserPrompt({
            bookTitle: 'x',
            sceneRank: 0,
            sceneTotal: 1,
            chapterIndex: 0,
            chapterLabel: '第1章 后院醒来',
            derived: DERIVED,
            blocks: BLOCKS,
            window: win,
            labels: null,
          });
    const corpus = [
      DECON_P5_BOOK_SYSTEM_PROMPT,
      DECON_P5_CHAPTER_SYSTEM_PROMPT,
      DECON_P5_SCENE_SYSTEM_PROMPT,
      DECON_P5_BOOK_GROUP_SYSTEM_PROMPT,
      bookUser,
      chapterUser,
      sceneUser,
    ].join('\n');
    expect(corpus).not.toMatch(
      /亚里士多德|红楼梦|水浒|三国|西游记|金瓶梅|儒林外史|麦基|热奈特|查特曼|申丹|普罗普|格雷马斯|托多罗夫|托尔斯泰|陀思妥|卡夫卡|博尔赫斯|普鲁斯特|乔伊斯|叙事学|叙述学|文学理论|经典文学|严肃文学|传统文学|纯文学|评点|起承转合|蒙太奇|戏剧反讽|价值极性/,
    );
    expect(corpus).not.toMatch(
      /不是[^。\n]{0,12}文学|(摒弃|拒绝|排斥)[^。\n]{0,10}(学院|学术|古典|传统)|(不采用|不使用|不用)[^。\n]{0,10}(理论|学院|古典)/,
    );
  });
});

describe('hashDeconReportOutput（report 产物 hash 单源）', () => {
  it('同内容同 hash / 异内容异 hash / sha256 形', () => {
    const a1 = hashDeconReportOutput('md', [SPAN(0)]);
    const a2 = hashDeconReportOutput('md', [SPAN(0)]);
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashDeconReportOutput('md2', [SPAN(0)])).not.toBe(a1);
    expect(hashDeconReportOutput('md', [])).not.toBe(a1);
  });
});

// ── db 编排面 ──

const maybe = sqliteUsable ? describe : describe.skip;

maybe('runDeconP5（db 编排——三 kind / tier 门 / 断点 / 预算 / R1 回查 / C3 重试 / C4 读重试）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
  });

  it('deep happy path：三 kind 全落库 + meta 读面 + cost 分 pass 记账 + findings 聚合读 + 章标对照表注入', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'deep', dimensions: [...DECON_CRAFT_DIMENSION_IDS] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    seedLabels(jobId);
    seedFindings(jobId);
    seedArcsStats(jobId);
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const calls: string[] = [];
    const gen = async (input: { user: string }): Promise<{ text: string }> => {
      calls.push(input.user);
      return { text: MDS[kindOf(input.user)] };
    };
    const result = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats).toMatchObject({ chapters: 3, generated: 5, skipped: 0, skippedNoInput: 0, sceneCandidates: 1 });
    expect(calls).toHaveLength(5); // 1 读法 + 3 章评 + 1 细批

    // meta 读面（kind ASC / unit ASC——产出阅读列表面）。
    expect(listDeconReportMetas(jobId).map((m) => `${m.kind}:${m.unit}`)).toEqual([
      'book_reading:all',
      'chapter_review:ch:0',
      'chapter_review:ch:1',
      'chapter_review:ch:2',
      'scene_annotation:scene:0',
    ]);

    // pass_state done 同事务 + outputRef 契约形。
    expect(getDeconPassState(jobId, 'p5:book_reading', 'all')).toMatchObject({
      status: 'done',
      outputRef: 'report:book_reading:all',
    });
    expect(getDeconPassState(jobId, 'p5:chapter_review', 'ch:1')).toMatchObject({
      status: 'done',
      outputRef: 'report:chapter_review:ch:1',
    });
    expect(getDeconPassState(jobId, 'p5:scene_annotation', 'scene:0')).toMatchObject({
      status: 'done',
      outputRef: 'report:scene_annotation:scene:0',
    });

    // cost 分 pass 记账（p5 茎三键）。
    const byPass = getDeconJob(jobId)?.cost.byPass;
    expect(byPass?.['p5:book_reading']?.calls).toBe(1);
    expect(byPass?.['p5:chapter_review']?.calls).toBe(3);
    expect(byPass?.['p5:scene_annotation']?.calls).toBe(1);

    // scene = 章 1（评分最高）+ 窗口 span 锚（章 1 全窗口 = 章标块 4 + 正文块 5-7）。
    const sceneRow = getDeconReport(jobId, 'scene_annotation', 'scene:0');
    expect(sceneRow?.anchors).toHaveLength(1);
    expect(sceneRow?.anchors[0]).toMatchObject({ chapterIndex: 1, paraStart: 4, paraEnd: 8 });
    const sceneCall = calls.find((u) => u.includes('本场正文'));
    expect(sceneCall).toContain('【P4】');
    expect(sceneCall).toContain('P4–P7');
    expect(sceneCall).toContain('本场：第2章 古碑微光'); // R1/F19 章标原词
    expect(sceneCall).toContain('上行'); // 窗口内标签注入

    // book 输入：章标对照表 + 弧聚合（真实章标行）+ 统计 + 问题单注入。
    const bookCall = calls.find((u) => u.includes('【书级问题单'));
    expect(bookCall).toContain('书名：输出测试小说');
    expect(bookCall).toContain('【章节章标对照表');
    expect(bookCall).toContain('- 第3章 夜访老道');
    expect(bookCall).toContain('- 第2章 古碑微光：第1章概要');
    expect(bookCall).toContain('【全书计量统计');
    expect(bookCall).toContain('人物情感钩×1');
    expect(bookCall).toContain('分析任务：结构与多线');

    // R1/F19 回查 belt：happy 文本无章引用 → 正文零改动、anchors 空。
    const bookRow = getDeconReport(jobId, 'book_reading', 'all');
    expect(bookRow?.contentMd).toBe(BOOK_MD);
    expect(bookRow?.anchors).toEqual([]);

    // chapter 0 输入：findings 聚合读（章级 unit）+ 弧级 findings 不混入 + 章标原词定位。
    const ch0Call = calls.find((u) => u.includes('【本章概要与事实提取】') && u.includes('本章：第1章 后院醒来'));
    expect(ch0Call).toBeDefined();
    expect(ch0Call).toContain('期待感与铺垫');
    expect(ch0Call).toContain('断章收在情绪高点');
    expect(ch0Call).toContain('P0「李逍遥在青云观的后院醒来」');
    expect(ch0Call).not.toContain('弧级骨架结论');
    expect(ch0Call).not.toContain('弧级专用证据');
  });

  it('tier 门矩阵：coarse 只读法（belt 直调细批零调用）/ fine 读法+章评无细批', async () => {
    seedFacts();
    const coarse = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(coarse.ok).toBe(true);
    if (!coarse.ok) return;
    const coarseId = coarse.job.jobId;
    expect(startDeconJob(coarseId, jobDeps()).ok).toBe(true);
    let n = 0;
    const gen = async (input: { user: string }): Promise<{ text: string }> => {
      n += 1;
      return { text: MDS[kindOf(input.user)] };
    };
    const coarseResult = await runDeconP5(coarseId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(coarseResult.status).toBe('done');
    expect(n).toBe(1);
    expect(listDeconReportMetas(coarseId).map((m) => m.kind)).toEqual(['book_reading']);

    // belt：coarse job 直调细批 runner → tier 门跳过零调用。
    const beltGen = vi.fn(async (input: { user: string }): Promise<{ text: string }> => ({ text: MDS[kindOf(input.user)] }));
    const belt = await runDeconP5SceneAnnotation(coarseId, {
      generateText: beltGen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
    });
    expect(belt.status).toBe('done');
    expect(beltGen).toHaveBeenCalledTimes(0);
    expect(transitionDeconJob(coarseId, 'cancel').ok).toBe(true);

    const fine = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] }, jobDeps());
    expect(fine.ok).toBe(true);
    if (!fine.ok) return;
    const fineId = fine.job.jobId;
    seedLabels(fineId);
    expect(startDeconJob(fineId, jobDeps()).ok).toBe(true);
    let m = 0;
    const gen2 = async (input: { user: string }): Promise<{ text: string }> => {
      m += 1;
      return { text: MDS[kindOf(input.user)] };
    };
    const fineResult = await runDeconP5(fineId, { generateText: gen2, readDerivedText: () => DERIVED, now: () => NOW });
    expect(fineResult.status).toBe('done');
    expect(m).toBe(4); // 读法 + 3 章评；无细批
    expect(listDeconReportMetas(fineId).map((x) => x.kind)).toEqual([
      'book_reading',
      'chapter_review',
      'chapter_review',
      'chapter_review',
    ]);
  });

  it('断点续跑：章评章 0 失败 → 重跑 book 零重调（mock 计数）→ 补齐 + 细批；全 done 再入全 skip 零调用', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'deep', dimensions: [...DECON_CRAFT_DIMENSION_IDS] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    seedLabels(jobId);
    seedFindings(jobId);
    seedArcsStats(jobId);
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    let run1 = 0;
    const failing = async (input: { user: string }): Promise<{ text: string }> => {
      run1 += 1;
      if (run1 === 2) throw new Error('LLM 炸了'); // 章 0 章评失败（book 已成功）
      return { text: MDS[kindOf(input.user)] };
    };
    const first = await runDeconP5(jobId, { generateText: failing, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('failed');
    if (first.status === 'failed') expect(first.message).toContain('章评（第1章 后院醒来）'); // R1/F19 章标原词定位
    expect(getDeconJob(jobId)?.status).toBe('failed');
    expect(getDeconReport(jobId, 'book_reading', 'all')?.contentMd).toContain('拆书读法'); // book 已落
    expect(getDeconPassState(jobId, 'p5:chapter_review', 'ch:0')?.status).toBe('failed');

    // retry：book 断点 skip（hash 门零重调）；ch:0 重做 + ch:1/2 + 细批 = 4 调。
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let run2 = 0;
    const good = async (input: { user: string }): Promise<{ text: string }> => {
      run2 += 1;
      return { text: MDS[kindOf(input.user)] };
    };
    const second = await runDeconP5(jobId, { generateText: good, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    if (second.status !== 'done') return;
    expect(run2).toBe(4);
    expect(second.stats).toMatchObject({ skipped: 1, generated: 4 });
    expect(listDeconReportMetas(jobId)).toHaveLength(5);

    // 全 done 再入：5 unit 全 skip 零调用（LLM 内核未注入亦不 fail——CR-10 惰性面）。
    const third = await runDeconP5(jobId, { readDerivedText: () => DERIVED, now: () => NOW });
    expect(third.status).toBe('done');
    if (third.status !== 'done') return;
    expect(third.stats.skipped).toBe(5);
    expect(third.stats.generated).toBe(0);
  });

  it('R1/F19 回查 e2e：读法错位引用 → 正文原样 + 错位章 anchors + 末尾「章引用校验」注记（只标注不改写）', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    // 错位：fixture 里「后院醒来」实际是第1章——LLM 按旧 index+1 习惯错引成第4章。
    const BAD_BOOK_MD = '# 拆书读法\n\n「第4章 后院醒来」是全书最强开章。\n\n## 主题\n\n讲的是守护。';
    const gen = async (): Promise<{ text: string }> => ({ text: BAD_BOOK_MD });
    const result = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');

    const row = getDeconReport(jobId, 'book_reading', 'all');
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.contentMd.startsWith(BAD_BOOK_MD)).toBe(true); // 正文原样不改写
    expect(row.contentMd).toContain('【章引用校验】');
    expect(row.contentMd).toContain('实际章标是「第1章 后院醒来」');
    expect(row.anchors).toHaveLength(1);
    expect(row.anchors[0]).toEqual({
      chapterIndex: 0,
      charStart: FIXTURE.chapters[0]!.charStart,
      charEnd: FIXTURE.chapters[0]!.charEnd,
      paraStart: 0,
      paraEnd: 0,
    });
    expect(getDeconPassState(jobId, 'p5:book_reading', 'all')?.status).toBe('done');
  });

  it('capped：预算门前置拦（零调用不烧 token）→ 调预算续跑完成', async () => {
    seedFacts();
    const created = createDeconJob(
      { materialId: MAT_ID, tier: 'coarse', budget: { totalTokens: 10, perPass: {} } },
      jobDeps(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const gen = vi.fn(async (input: { user: string }): Promise<{ text: string }> => ({ text: MDS[kindOf(input.user)] }));
    const first = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('capped');
    if (first.status === 'capped') expect(first.message).toContain('预算超限');
    expect(gen).toHaveBeenCalledTimes(0); // 前置拦截不烧 token
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p5:book_reading', 'all')?.status).toBe('capped');
    expect(getDeconReport(jobId, 'book_reading', 'all')).toBeNull();

    const jobRow = getDeconJob(jobId);
    expect(jobRow).not.toBeNull();
    if (jobRow === null) return;
    upsertDeconJob({ ...jobRow, budget: { totalTokens: 100_000_000, perPass: {} } });
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true); // capped → retry → running
    const second = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    expect(gen).toHaveBeenCalledTimes(1);
    expect(listDeconReportMetas(jobId)).toHaveLength(1);
  });

  it("finishReason='length'：升帽重试一次（两调用各记账 + note 相位可见）→ 重试通过完成", async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const notes: string[] = [];
    let calls = 0;
    const gen = async (): Promise<{ text: string; finishReason?: 'length' }> => {
      calls += 1;
      return calls === 1 ? { text: BOOK_MD, finishReason: 'length' } : { text: BOOK_MD };
    };
    const result = await runDeconP5(jobId, {
      generateText: gen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      notify: (event) => {
        if (event.note !== undefined) notes.push(event.note);
      },
    });
    expect(result.status).toBe('done');
    expect(calls).toBe(2); // 截断 → 升帽重试一次 → 过
    expect(notes.some((n) => n.includes('升帽重试'))).toBe(true); // 重试相位 note 可见
    expect(getDeconJob(jobId)?.cost.byPass['p5:book_reading']?.calls).toBe(2); // actual 各记各的
    expect(getDeconPassState(jobId, 'p5:book_reading', 'all')?.status).toBe('done');
    expect(getDeconReport(jobId, 'book_reading', 'all')?.contentMd).toBe(BOOK_MD);
  });

  it("finishReason='length' 重试仍截断 → capped 诚实挂起不落半程报告（权威停因）", async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    let calls = 0;
    const gen = async (): Promise<{ text: string; finishReason?: 'length' }> => {
      calls += 1;
      return { text: BOOK_MD, finishReason: 'length' };
    };
    const result = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('capped');
    if (result.status === 'capped') {
      expect(result.message).toContain('截断');
      expect(result.message).toContain('升帽重试'); // 含升帽重试注记——诚实说明已试过
    }
    expect(calls).toBe(2);
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p5:book_reading', 'all')?.status).toBe('capped');
    expect(getDeconReport(jobId, 'book_reading', 'all')).toBeNull(); // 半程报告零落库
  });

  it('升帽重试 est 过预算门：预算卡在两档 est 之间 → 重试前拦下（零第二次调用）', async () => {
    seedFacts();
    // 第一遍：宽松预算 + 截断一次，捕获 user prompt 算 est 基线（同种子 → 同 prompt）。
    const probe = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    const probeId = probe.job.jobId;
    expect(startDeconJob(probeId, jobDeps()).ok).toBe(true);
    let capturedUser = '';
    let probeCalls = 0;
    const probeGen = async (input: { user: string }): Promise<{ text: string; finishReason?: 'length' }> => {
      probeCalls += 1;
      if (probeCalls === 1) {
        capturedUser = input.user;
        return { text: BOOK_MD, finishReason: 'length' };
      }
      return { text: BOOK_MD };
    };
    const probeRun = await runDeconP5(probeId, { generateText: probeGen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(probeRun.status).toBe('done');
    // runner 不做终态转移（归编排层）——手动翻出 running，防第二 job 撞 inflight 门。
    expect(transitionDeconJob(probeId, 'cancel').ok).toBe(true);

    // 第二遍：预算 = 首档 est + 5（首档过门）< 升帽 est（+maxTokens）→ 重试被预算门拦。
    const estBase = estimateDeconCallTokens(DECON_P5_BOOK_SYSTEM_PROMPT, capturedUser, DECON_P5_BOOK_READING_MAX_TOKENS);
    const created = createDeconJob(
      { materialId: MAT_ID, tier: 'coarse', budget: { totalTokens: estBase + 5, perPass: {} } },
      jobDeps(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let calls = 0;
    const gen = async (): Promise<{ text: string; finishReason?: 'length' }> => {
      calls += 1;
      return { text: BOOK_MD, finishReason: 'length' };
    };
    const result = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('capped');
    if (result.status === 'capped') expect(result.message).toContain('升帽重试预算超限');
    expect(calls).toBe(1); // 重试 est 过门失败——第二次调用未发出（不烧 token）
    expect(getDeconJob(jobId)?.cost.byPass['p5:book_reading']?.calls).toBe(1); // 只记首笔 actual
  });

  it('C4/F12 材料读点：pending 零章中间态 → 重试窗口内收敛后照常产出', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    // 行翻成 pending 零章中间态（重登记 upsert 相 A——F12 竞态窗口）。
    upsertMaterialRow({ ...mkMaterial(), status: 'pending', chapters: [] });

    let sleeps = 0;
    const gen = vi.fn(async (): Promise<{ text: string }> => ({ text: BOOK_MD }));
    const result = await runDeconP5(jobId, {
      generateText: gen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      sleep: async () => {
        sleeps += 1;
        upsertMaterialRow(mkMaterial()); // sleep 注入侧模拟重登记完成（行恢复）
      },
    });
    expect(result.status).toBe('done');
    expect(sleeps).toBe(1); // 第二次轮询读到恢复行
    expect(gen).toHaveBeenCalledTimes(1);
    expect(listDeconReportMetas(jobId)).toHaveLength(1);
  });

  it('C4/F12 材料读点：ready 零章稳定态 → 立即诚实失败（零重试零调用）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    upsertMaterialRow({ ...mkMaterial(), status: 'ready', chapters: [] }); // 真零章（稳定判定）

    let slept = false;
    const gen = vi.fn(async (): Promise<{ text: string }> => ({ text: BOOK_MD }));
    const result = await runDeconP5(jobId, {
      generateText: gen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      sleep: async () => {
        slept = true;
      },
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('零章');
    expect(slept).toBe(false); // 稳定态不进重试窗口
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconJob(jobId)?.status).toBe('failed');
  });

  it('C4/F16 写侧：chapter_review 材料级前置失败只 transitionDeconJob——不落 (pass,all,failed) 化石行（all 仅 book_reading 合法）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    upsertMaterialRow({ ...mkMaterial(), status: 'ready', chapters: [] }); // 稳定零章 → 立即失败

    const gen = vi.fn(async (): Promise<{ text: string }> => ({ text: BOOK_MD }));
    const result = await runDeconP5ChapterReview(jobId, {
      generateText: gen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      sleep: async () => {},
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('零章');
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconJob(jobId)?.status).toBe('failed');
    expect(getDeconJob(jobId)?.error).toContain('零章'); // job 行 error 承载错误面
    expect(getDeconPassState(jobId, 'p5:chapter_review', 'all')).toBeNull(); // 无化石行
  });

  it('report 写侧门：空白回复 failed 不落行；空 contentMd 直接 upsert 拒收', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const gen = async (): Promise<{ text: string }> => ({ text: '   \n  ' });
    const result = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('空回复');
    expect(getDeconReport(jobId, 'book_reading', 'all')).toBeNull();
    expect(
      upsertDeconReport({
        jobId,
        kind: 'book_reading',
        unit: 'all',
        contentMd: '',
        anchors: [],
        dimension: null,
        updatedAt: NOW.toISOString(),
      }),
    ).toBe(false);
  });

  it('中断韧性：书级读法调用期间 pause → 本 unit 完成落库后章评边界停 → resume 补齐', async () => {
    seedFacts();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'deep', dimensions: [...DECON_CRAFT_DIMENSION_IDS] }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    seedLabels(jobId);
    seedFindings(jobId);
    seedArcsStats(jobId);
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const gen = async (input: { user: string }): Promise<{ text: string }> => {
      if (kindOf(input.user) === 'book') {
        expect(transitionDeconJob(jobId, 'pause').ok).toBe(true); // 读法调用期间暂停
      }
      return { text: MDS[kindOf(input.user)] };
    };
    const paused = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(paused.status).toBe('paused');
    expect(getDeconJob(jobId)?.status).toBe('paused');
    expect(getDeconReport(jobId, 'book_reading', 'all')).not.toBeNull(); // book 完成落库
    expect(listDeconReportMetas(jobId)).toHaveLength(1); // 章评未开跑

    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let resumed = 0;
    const good = async (input: { user: string }): Promise<{ text: string }> => {
      resumed += 1;
      return { text: MDS[kindOf(input.user)] };
    };
    const done = await runDeconP5(jobId, { generateText: good, readDerivedText: () => DERIVED, now: () => NOW });
    expect(done.status).toBe('done');
    expect(resumed).toBe(4); // book skip + 3 章评 + 1 细批
    expect(listDeconReportMetas(jobId)).toHaveLength(5);
  });

  it('派生 .md 现值 hash ≠ job 快照 → stale（F-02 锚点漂移不静默沿用）', async () => {
    const OTHER_HASH = sha(DERIVED + '校对后');
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(OTHER_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(OTHER_HASH)).ok).toBe(true);

    const gen = vi.fn(async (input: { user: string }): Promise<{ text: string }> => ({ text: MDS[kindOf(input.user)] }));
    const result = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('stale');
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconJob(jobId)?.status).toBe('stale');
  });

  it('CR-7 大书分组：书级读法输入超限 → 按弧拆 3-5 组组内串行 + 汇总合成（调用数 = 组数+1）', async () => {
    // 12 章大书（每章一弧）：synopsis 各 ~16K 字 → 弧聚合 ~192K > 150K 上限——旧版此处硬失败。
    const bigBodies = Array.from({ length: 12 }, (_, i) =>
      [`第${i + 1}章 大章${i}`, `第${i + 1}章正文内容简短，规模由概要撑。`].join('\n\n'),
    );
    const big = composeFixture(bigBodies, Array.from({ length: 12 }, (_, i) => `大章${i}`));
    const bigDerivedHash = sha(big.derived);
    upsertMaterialRow(mkMaterial(big.chapters, big.derived));
    const bigDeps = {
      readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: bigDerivedHash }),
      now: () => NOW,
    };
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, bigDeps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, bigDeps).ok).toBe(true);

    const synopses = new Map<number, string>();
    for (let ci = 0; ci < 12; ci++) {
      synopses.set(ci, `第${ci}章概要头。${'章概要持续推进。'.repeat(2_000)}`);
      upsertDeconChapterFacts({
        materialRef: MAT_REF,
        derivedHash: bigDerivedHash,
        chapterIndex: ci,
        facts: {
          synopsis: synopses.get(ci)!,
          entities: [],
          events: [],
          relationshipEdges: [],
          foreshadowPlanted: [],
          infoGap: [],
        },
      });
    }
    const bigArcs = big.chapters.map((c) => ({
      index: c.index,
      title: null,
      fromChapter: c.index,
      toChapter: c.index,
      chapterCount: 1,
      charCount: 30,
      origin: 'single' as const,
    }));
    upsertDeconProduct({
      jobId,
      pass: 'p3b',
      unit: 'arcs',
      updatedAt: NOW.toISOString(),
      payload: {
        arcs: bigArcs,
        audit: { source: 'single' as const, volumeBoundaries: [], candidatesTotal: 0, candidatesUsed: 0, arcsMerged: 0, arcsSplit: 0 },
      },
    });

    const bigHeadings = buildDeconChapterHeadingInfos(big.derived, big.chapters);
    const groups = splitDeconArcGroups(deconBookArcContributions(bigArcs, synopses, bigHeadings), DECON_P5_BOOK_INPUT_CHAR_LIMIT);
    expect(groups.length).toBeGreaterThanOrEqual(3); // sansheng 钳制带（3-5 组）
    expect(groups.length).toBeLessThanOrEqual(5);

    const GROUP_MD = '# 本组草稿\n\n## 本组各段概览\n\n覆盖若干段，节奏递进。';
    const calls: string[] = [];
    const gen = async (input: { user: string }): Promise<{ text: string }> => {
      calls.push(input.user);
      if (input.user.includes('【书级问题单')) return { text: BOOK_MD }; // 汇总合成（问题单注入）
      return { text: GROUP_MD }; // 分组草稿
    };
    const result = await runDeconP5(jobId, { generateText: gen, readDerivedText: () => big.derived, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(calls).toHaveLength(groups.length + 1); // 组内串行 N 调 + 汇总合成 1 调
    // 前 N 调 = 分组草稿（本组弧级概要 + 分组注记 + 章标对照表，无问题单）；末调 = 汇总合成。
    expect(calls.slice(0, groups.length).every((u) => u.includes('【本组弧级概要'))).toBe(true);
    expect(calls.slice(0, groups.length).every((u) => u.includes('【章节章标对照表'))).toBe(true); // R1/F19 对照表进分组草稿
    expect(calls[0]).toContain('第 1 组');
    expect(calls[0]).toContain('- 第1章 大章0'); // 概要行 = 真实章标原词
    expect(calls.slice(0, groups.length).every((u) => !u.includes('【书级问题单'))).toBe(true);
    expect(calls.at(-1)).toContain('【分组草稿');
    expect(calls.at(-1)).toContain('【章节章标对照表'); // 汇总合成同样注入对照表
    expect(calls.at(-1)).toContain('【书级问题单');
    // 终稿 = 汇总调用产出（分组草稿不落 report 表）；断点粒度维持 unit='all' 单行。
    expect(getDeconReport(jobId, 'book_reading', 'all')?.contentMd).toBe(BOOK_MD);
    expect(listDeconReportMetas(jobId)).toHaveLength(1);
    expect(getDeconPassState(jobId, 'p5:book_reading', 'all')?.status).toBe('done');
    expect(getDeconJob(jobId)?.cost.byPass['p5:book_reading']?.calls).toBe(groups.length + 1);
    deleteDeconProductsByMaterial(MAT_ID); // 大书 facts/弧产物清场（材料级键控跨用例防串）
    upsertMaterialRow(mkMaterial());
  });

  it('细批 token 预算常量独立核算（scene > chapter——逐项协议面输出量大于章评）', () => {
    expect(DECON_P5_SCENE_ANNOTATION_MAX_TOKENS).toBeGreaterThan(4_096);
  });
});
