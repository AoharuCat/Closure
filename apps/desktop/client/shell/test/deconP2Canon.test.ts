import { createHash } from 'node:crypto';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconCanonEntry, DeconChapterFacts, DeconEntity, DeconFacts, DeconSpan, Material } from '@orison/shared-contracts';

// E10.3a W5：P2 canon 六域装配测试——纯函数面（召回/画像/时间线解析 + 回退扫描 + 归纳锚定核验）
// + db 编排面（六域非空全锚定/幻觉实体排除/别名归 canonical 关系对/intentional_loose 与
// conflict 两档分开/P1c 门/per-domain 断点 skip/LLM 不可用挂起）。
// ABI 门控 + throwaway home（mirror deconP1Aggregate.test.ts）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-decon-p2');

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
  replaceDeconEntities,
  upsertDeconChapterFacts,
  upsertDeconJob,
} from '../main/db/closure-decon';
import { listDeconCanonEntries } from '../main/db/closure-canon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob, transitionDeconJob } from '../main/decon/deconJob';
import type { DeconGenerateText } from '../main/decon/deconLlmCore';
import {
  DECON_P2_RULE_KEYWORDS,
  DECON_P2_WORLD_KEYWORDS,
  buildDeconAliasMap,
  buildDeconRecallEntries,
  mapDeconBlocksToChapters,
  parseDeconPortraitResponse,
  parseDeconRecallResponse,
  parseDeconTimelineAnnotationResponse,
  parseDeconTimelineReviewResponse,
  recallDeconCandidateParagraphs,
  runDeconP2,
  sanitizeDeconCanonEntries,
  scanDeconTimelineInversions,
  type DeconRecalledParagraph,
} from '../main/decon/p2Canon';
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

// ── fixtures（3 章——别名簇赵灵儿〔灵儿/赵灵兒〕+ 幻觉实体 + flashback 事件 + 规则段）──

const MAT_ID = 'mat-000000000005';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'d'.repeat(64)}`;

const P2_BODIES = [
  [
    '李逍遥在青云观的后院醒来，发现自己躺在一张竹床上。',
    '李逍遥在山下集市遇见了赵灵儿，赵灵儿正在溪边唱歌。',
    '两人约好明日一同去后山，李逍遥心里隐约不安。',
  ].join('\n\n'),
  [
    '赵灵儿约李逍遥去后山看瀑布，灵儿走在前面哼着歌。',
    '瀑布下的水潭边有一块古碑，李逍遥伸手触碰古碑，古碑忽然发出了微弱的光。',
    '夜里李逍遥回想起十年前的那个雨夜，师父冒雨背着他走过的山路。',
  ].join('\n\n'),
  [
    '赵灵兒被脚步声惊醒，披衣起身推开了房门。',
    '青云观的老道人找到了他们，说山中有妖物出没，须当小心。',
    '观中规矩：入夜后不可下山，弟子必须按时回房。',
  ].join('\n\n'),
];

function composeFixture(bodies: readonly string[]): { derived: string; chapters: Material['chapters'] } {
  // 章间用空行分隔（镜像真实派生 .md 形态——末段不与下章标记行粘连成块，块严格落章内）。
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

const FIXTURE = composeFixture(P2_BODIES);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T16:00:00.000Z');
const jobDeps = () => ({
  readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: DERIVED_HASH }),
  now: () => NOW,
});

function mkMaterial(): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '拆解canon测试小说',
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

function blockSpan(chapterIndex: number, k: number) {
  const i = chapterIndex * 3 + k;
  return { chapterIndex, charStart: BLOCKS[i]!.start, charEnd: BLOCKS[i]!.end, paraStart: i, paraEnd: i + 1 };
}

function mkFacts(over: {
  chapterIndex: number;
  entities: Array<[string, string]>;
  events: Array<{ what: string; kernel?: boolean; k: number }>;
  edges: Array<{ from: string; to: string; kind: string; k: number }>;
}): DeconFacts {
  return {
    synopsis: `第${over.chapterIndex}章概要。`,
    entities: over.entities.map(([name, type]) => ({ name, type: type as DeconFacts['entities'][number]['type'], span: blockSpan(over.chapterIndex, 0) })),
    events: over.events.map((e) => ({ what: e.what, span: blockSpan(over.chapterIndex, e.k), ...(e.kernel ? { kernel: true } : {}) })),
    relationshipEdges: over.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, span: blockSpan(over.chapterIndex, e.k) })),
    foreshadowPlanted: [],
    infoGap: [],
  };
}

function seedFacts(): void {
  const rows: DeconChapterFacts[] = [
    {
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 0,
      facts: mkFacts({
        chapterIndex: 0,
        entities: [
          ['李逍遥', 'person'],
          ['赵灵儿', 'person'],
          ['青云观', 'place'],
        ],
        events: [{ what: '集市初遇', k: 1 }],
        edges: [{ from: '李逍遥', to: '赵灵儿', kind: '相识', k: 1 }],
      }),
    },
    {
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 1,
      facts: mkFacts({
        chapterIndex: 1,
        entities: [
          ['李逍遥', 'person'],
          ['灵儿', 'person'],
          ['古碑', 'item'],
        ],
        events: [
          { what: '触碰古碑引异象', kernel: true, k: 1 },
          { what: '回忆起十年前的雨夜', k: 2 },
        ],
        edges: [{ from: '灵儿', to: '李逍遥', kind: '同门', k: 0 }],
      }),
    },
    {
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 2,
      facts: mkFacts({
        chapterIndex: 2,
        entities: [
          ['李逍遥', 'person'],
          ['赵灵兒', 'person'],
          ['老道人', 'person'],
        ],
        events: [{ what: '老道人示警妖物', k: 1 }],
        edges: [{ from: '赵灵兒', to: '李逍遥', kind: '同行', k: 1 }],
      }),
    },
  ];
  for (const row of rows) upsertDeconChapterFacts(row);
}

function mkEntity(name: string, type: DeconEntity['type'], aliases: string[] = [], hallucinated = false, mentions: Array<[number, number]> = [[0, 1]]): DeconEntity {
  return {
    materialRef: MAT_REF,
    derivedHash: DERIVED_HASH,
    canonicalName: name,
    type,
    aliases,
    mentions: mentions.map(([chapterIndex, count]) => ({ chapterIndex, count })),
    audit: hallucinated ? { hallucinationFiltered: true } : {},
  };
}

function seedEntities(): void {
  replaceDeconEntities(MAT_REF, DERIVED_HASH, [
    mkEntity('李逍遥', 'person', [], false, [[0, 1], [1, 1], [2, 1]]),
    mkEntity('赵灵儿', 'person', ['灵儿', '赵灵兒'], false, [[0, 1], [1, 2], [2, 1]]),
    mkEntity('青云观', 'place', [], false, [[0, 1], [2, 1]]),
    mkEntity('古碑', 'item', [], false, [[1, 1]]),
    mkEntity('老道人', 'person', [], false, [[2, 1]]),
    mkEntity('幻影真人', 'person', [], true, [[0, 1]]),
  ]);
}

// ── LLM mock（按 system prompt 标记分派——真实锚定：quote/paraRange 全取自 prompt 内文）──

/** 从 prompt 提取候选段（【P段号】文本 行）。 */
function parseRecallParagraphs(user: string): Array<{ p: number; text: string }> {
  const out: Array<{ p: number; text: string }> = [];
  for (const m of user.matchAll(/^【P(\d+)】(.*)$/gm)) {
    out.push({ p: Number(m[1]), text: m[2]!.replace(/……$/, '') });
  }
  return out;
}

/** 从画像 prompt 提取角色名（【角色】名（别名：…） 行——名截到别名括注或行尾）。 */
function parsePortraitNames(user: string): string[] {
  const names: string[] = [];
  for (const m of user.matchAll(/^【角色】([^（\n]+)/gm)) {
    names.push(m[1]!.trim());
  }
  return names;
}

/** 从时间线 prompt 提取事件（id | 章号 | 事件 行）。 */
function parseTimelineEvents(user: string): Array<{ id: string; what: string }> {
  const out: Array<{ id: string; what: string }> = [];
  for (const m of user.matchAll(/^(e\d+) \| 第\d+章 \| (.+)$/gm)) {
    out.push({ id: m[1]!, what: m[2]!.split('，')[0]! });
  }
  return out;
}

/**
 * P2 全域 mock：timelineVariant='flashback' 时回忆事件带 device（→ intentional_loose）；
 * 'no-device' 时回退无标记（→ conflict）；portraitSeen/recallSeen 等调用计数供断言。
 */
interface P2MockStats {
  calls: { slot: string; system: string }[];
}
function mkP2Generate(timelineVariant: 'flashback' | 'no-device', stats: P2MockStats): DeconGenerateText {
  return async (input) => {
    stats.calls.push({ slot: input.slot, system: input.system ?? '' });
    const system = input.system ?? '';
    const user = input.user;
    if (system.includes('角色档案整理器')) {
      const names = parsePortraitNames(user);
      return {
        text: JSON.stringify({
          characters: names.map((name) => ({
            name,
            identity: `${name}的身份概括`,
            speechPattern: null,
            traits: [
              { name: '侠义心', mutability: 'immutable' },
              { name: '重情', mutability: 'evolvable', note: '随师门变故演变' },
            ],
            abilities: null,
            arc: `${name}的成长弧`,
            coreTrauma: null,
            pillars: '护住身边人',
            voiceAnchors: '短句收束',
            antiVoice: null,
            neverDo: '欺辱弱者',
          })),
        }),
      };
    }
    if (system.includes('设定档案整理器')) {
      const paras = parseRecallParagraphs(user);
      const first = paras[0];
      const second = paras[1];
      if (first === undefined || second === undefined) return { text: '{"entries":[]}' };
      return {
        text: JSON.stringify({
          entries: [
            {
              name: '召回条目A',
              summary: '直接引用条目（quote 核验通过）',
              paraRanges: [{ start: first.p, end: first.p + 1 }],
              quote: first.text.slice(0, 10),
            },
            {
              name: '召回条目B',
              summary: '归纳条目（无 quote → inferred）',
              paraRanges: [{ start: second.p, end: second.p + 1 }],
            },
          ],
        }),
      };
    }
    if (system.includes('时间线标注器')) {
      const events = parseTimelineEvents(user);
      return {
        text: JSON.stringify({
          events: events.map((e, i) => {
            if (e.what.includes('回忆')) {
              return {
                id: e.id,
                storyTimeLabel: '十年前的雨夜',
                timeOrder: 0,
                ...(timelineVariant === 'flashback' ? { device: 'flashback' } : {}),
              };
            }
            return { id: e.id, storyTimeLabel: `第${i + 1}日`, timeOrder: i + 1 };
          }),
        }),
      };
    }
    if (system.includes('矛盾复核裁判')) {
      const ids = [...user.matchAll(/^(e\d+) \| /gm)].map((m) => m[1]!);
      return { text: JSON.stringify(ids.map((id) => ({ id, intentional: true }))) };
    }
    return { text: '{}' };
  };
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

describe('parseDeconRecallResponse（归纳解析——条目级容错）', () => {
  it('合法条目解析 + 坏形状丢条计数', () => {
    const raw = JSON.stringify({
      entries: [
        { name: '青云观', summary: '山间道观', paraRanges: [{ start: 1, end: 2 }], quote: '青云观' },
        { name: '', summary: '无名条', paraRanges: [{ start: 1, end: 2 }] },
        { name: '坏区间', summary: '无区间', paraRanges: [] },
        { name: '纯归纳', summary: '无引文也合法', paraRanges: [{ start: 3, end: 4 }] },
      ],
    });
    const parsed = parseDeconRecallResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.entries).toHaveLength(2);
    expect(parsed!.droppedMalformed).toBe(2);
    expect(parsed!.entries[0]?.quote).toBe('青云观');
    expect(parsed!.entries[1]?.quote).toBeNull();
  });

  it('顶层坏（无 entries / 非 JSON）→ null 整体拒收', () => {
    expect(parseDeconRecallResponse('{"foo":1}')).toBeNull();
    expect(parseDeconRecallResponse('不是 JSON')).toBeNull();
  });
});

describe('parseDeconPortraitResponse（画像解析——集外名整体拒收 + 字段容错）', () => {
  const allowed = new Set(['李逍遥']);

  it('合法画像 + 坏 trait 条目丢弃（不弃角色）', () => {
    const raw = JSON.stringify({
      characters: [
        {
          name: '李逍遥',
          identity: '观中弟子',
          traits: [{ name: '侠义', mutability: 'immutable' }, { name: '坏档', mutability: '玄学' }, { name: 123, mutability: 'evolvable' }],
          pillars: null,
        },
      ],
    });
    const parsed = parseDeconPortraitResponse(raw, allowed);
    expect(parsed).not.toBeNull();
    const portrait = parsed!.get('李逍遥')!;
    expect(portrait.identity).toBe('观中弟子');
    expect(portrait.traits).toEqual([{ name: '侠义', mutability: 'immutable' }]);
    expect(portrait.pillars).toBeNull();
  });

  it('集外角色名 → null 整体拒收（约束式）', () => {
    const raw = JSON.stringify({ characters: [{ name: '幻影真人', identity: 'x' }] });
    expect(parseDeconPortraitResponse(raw, allowed)).toBeNull();
  });
});

describe('scanDeconTimelineInversions（回退检出 + 章内/跨章分类 + device 分流）', () => {
  const events = [
    { eventId: 'e0', chapterIndex: 0, annotation: { storyTimeLabel: '第1日', timeOrder: 1 } },
    { eventId: 'e1', chapterIndex: 1, annotation: { storyTimeLabel: '第2日', timeOrder: 2 } },
    { eventId: 'e2', chapterIndex: 1, annotation: { storyTimeLabel: '十年前', timeOrder: 0, device: 'flashback' as const } },
    { eventId: 'e3', chapterIndex: 2, annotation: { storyTimeLabel: '当年当夜', timeOrder: 1 } },
  ];

  it('带 device 的回退进复核队列；无 device 的进真矛盾；章内/跨章分类正确', () => {
    const { inversions, unexplained } = scanDeconTimelineInversions(events);
    expect(inversions).toHaveLength(1);
    expect(inversions[0]).toMatchObject({ eventId: 'e2', chapterIndex: 1, withinChapter: true, device: 'flashback' });
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]).toMatchObject({ eventId: 'e3', chapterIndex: 2, withinChapter: false });
  });

  it('无回退 → 双空（exact）', () => {
    const forward = [
      { eventId: 'e0', chapterIndex: 0, annotation: { storyTimeLabel: 'a', timeOrder: 1 } },
      { eventId: 'e1', chapterIndex: 1, annotation: { storyTimeLabel: 'b', timeOrder: 3 } },
    ];
    expect(scanDeconTimelineInversions(forward)).toEqual({ inversions: [], unexplained: [] });
  });
});

describe('parseDeconTimelineAnnotationResponse / parseDeconTimelineReviewResponse（约束式）', () => {
  it('标注：合法解析；集外 id / 坏 timeOrder 整体拒收；device 集外宽容为缺省', () => {
    const ok = parseDeconTimelineAnnotationResponse(
      '{"events":[{"id":"e0","storyTimeLabel":"第1日","timeOrder":1},{"id":"e1","storyTimeLabel":"x","timeOrder":2,"device":"幻觉档"}]}',
      new Set(['e0', 'e1']),
    );
    expect(ok).not.toBeNull();
    expect(ok!.get('e0')!.timeOrder).toBe(1);
    expect(ok!.get('e1')!.device).toBeUndefined();
    expect(parseDeconTimelineAnnotationResponse('{"events":[{"id":"e9","storyTimeLabel":"x","timeOrder":1}]}', new Set(['e0']))).toBeNull();
    expect(parseDeconTimelineAnnotationResponse('{"events":[{"id":"e0","storyTimeLabel":"x","timeOrder":"一"}]}', new Set(['e0']))).toBeNull();
  });

  it('复核：合法解析；集外 id / 坏 intentional 拒收', () => {
    const ok = parseDeconTimelineReviewResponse('[{"id":"e2","intentional":true}]', new Set(['e2']));
    expect(ok).not.toBeNull();
    expect(ok!.get('e2')).toBe(true);
    expect(parseDeconTimelineReviewResponse('[{"id":"zz","intentional":true}]', new Set(['e2']))).toBeNull();
    expect(parseDeconTimelineReviewResponse('[{"id":"e2","intentional":"yes"}]', new Set(['e2']))).toBeNull();
  });
});

describe('buildDeconRecallEntries（锚定核验——无锚即丢）', () => {
  const paragraphs: DeconRecalledParagraph[] = [
    { paraIndex: 0, chapterIndex: 0, charStart: 0, charEnd: 10, text: '青云观的后院' },
    { paraIndex: 1, chapterIndex: 0, charStart: 10, charEnd: 20, text: '李逍遥醒来' },
  ];

  it('集内 paraRange → 条目（quote 命中 exact / 无 quote inferred）；集外段号与编造引文丢弃', () => {
    const built = buildDeconRecallEntries(
      'job-x',
      'world',
      [
        { name: '青云观', summary: '山间道观', paraRanges: [{ start: 0, end: 1 }], quote: '青云观的后院' },
        { name: '归纳条', summary: '纯归纳', paraRanges: [{ start: 1, end: 2 }], quote: null },
        { name: '集外条', summary: '编造段号', paraRanges: [{ start: 5, end: 6 }], quote: null },
        { name: '编造引文', summary: '引文不在锚定文本', paraRanges: [{ start: 0, end: 1 }], quote: '完全不存在的引文' },
      ],
      paragraphs,
      '青云观的后院李逍遥醒来',
      { source: 'decon', materialId: 'mat-000000000005', bookTitle: 'x' },
    );
    expect(built.entries).toHaveLength(2);
    expect(built.droppedNoAnchor).toBe(2);
    expect(built.entries[0]).toMatchObject({ domain: 'world', name: '青云观' });
    expect(built.entries[0]!.payload.evidence).toBe('exact');
    expect(built.entries[0]!.anchors[0]).toMatchObject({ chapterIndex: 0, paraStart: 0, paraEnd: 1, charStart: 0, charEnd: 10 });
    expect(built.entries[1]!.payload.evidence).toBe('inferred');
  });
});

describe('buildDeconAliasMap / recallDeconCandidateParagraphs / mapDeconBlocksToChapters（纯代码面）', () => {
  it('aliasMap 含别名、排除幻觉簇；sample 均匀采样；块到章映射', () => {
    const aliasMap = buildDeconAliasMap([mkEntity('赵灵儿', 'person', ['灵儿']), mkEntity('幻影真人', 'person', [], true)]);
    expect(aliasMap.get('灵儿')).toBe('赵灵儿');
    expect(aliasMap.has('幻影真人')).toBe(false);
    const chapterOf = mapDeconBlocksToChapters(BLOCKS, FIXTURE.chapters);
    expect(chapterOf).toHaveLength(BLOCKS.length);
    expect(chapterOf[0]).toBe(0);
    expect(chapterOf[4]).toBe(1);
    const sampled = recallDeconCandidateParagraphs(DERIVED, BLOCKS, chapterOf, { kind: 'sample', max: 3 });
    expect(sampled).toHaveLength(3);
    const keywords = recallDeconCandidateParagraphs(DERIVED, BLOCKS, chapterOf, {
      kind: 'keywords',
      keywords: ['规矩', '不可'],
      max: 5,
    });
    expect(keywords.length).toBeGreaterThanOrEqual(1);
    expect(keywords[0]!.text).toContain('规矩');
  });

  it('CR-6：召回实体名主通道（×2 权重 > 关键词 ×1）——实体名段排在仅关键词段前', () => {
    const chapterOf = mapDeconBlocksToChapters(BLOCKS, FIXTURE.chapters);
    const picked = recallDeconCandidateParagraphs(DERIVED, BLOCKS, chapterOf, {
      kind: 'keywords',
      keywords: ['世界'],
      entityNames: ['青云观'],
      max: 2,
    });
    // 含实体名「青云观」的段（score 2）排在仅命中关键词的段（score ≤1）前。
    expect(picked[0]!.text).toContain('青云观');
  });

  it('CR-6 题材中性红线：world/rule 召回词表不含仙侠武侠题材词（硬编码词表退役）', () => {
    const genreWords = ['门派', '宗门', '世家', '帮派', '教派', '秘境', '江湖', '朝廷', '境界', '修炼', '功法', '戒律', '皇朝'];
    for (const word of genreWords) {
      expect(DECON_P2_WORLD_KEYWORDS).not.toContain(word);
      expect(DECON_P2_RULE_KEYWORDS).not.toContain(word);
    }
  });
});

describe('sanitizeDeconCanonEntries（CR-4 写侧 zod 门 + 同域去重——直测）', () => {
  const provenance = { source: 'decon' as const, materialId: 'mat-000000000005', bookTitle: 'x' };
  const span = { chapterIndex: 0, charStart: 0, charEnd: 10, paraStart: 0, paraEnd: 1 };
  const mk = (name: string, anchors: DeconSpan[] = [span]): DeconCanonEntry => ({
    jobId: 'decon-000000000001',
    domain: 'world',
    name,
    payload: { evidence: 'inferred', summary: 's' },
    anchors,
    provenance,
  });

  it('零锚条目（zod 不过）丢弃 + 计数——读侧面与落库面同基（不再永久重烧）；重名保首去重（PK 违约防线）', () => {
    const audit: Record<string, number> = {};
    const out = sanitizeDeconCanonEntries('decon-000000000001', audit, 'world', [
      mk('有效条'),
      mk('零锚条', []),
      mk('有效条'), // 重名——保首丢弃
      mk('另一有效条'),
    ]);
    expect(out.map((e) => e.name)).toEqual(['有效条', '另一有效条']);
    expect(audit.canonDroppedInvalid).toBe(1);
    expect(audit.canonDroppedDuplicateNames).toBe(1);
  });
});

// ── db 编排面 ──

maybe('runDeconP2（db 编排）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
    seedFacts();
    seedEntities();
  });

  it('happy path：六域非空全锚定 + 幻觉实体排除 + 别名归 canonical 关系对 + flashback → intentional_loose', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const stats = { calls: [] as { slot: string; system: string }[] };
    const result = await runDeconP2(jobId, {
      generateText: mkP2Generate('flashback', stats),
      readDerivedText: () => DERIVED,
      now: () => NOW,
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.domains).toBe(6);
    expect(result.stats.skippedDomains).toBe(0);

    // slot 纪律：归纳/画像/标注 = extraction；复核 = review-judge。
    const slots = new Set(stats.calls.map((c) => c.slot));
    expect(slots).toEqual(new Set(['extraction', 'review-judge']));
    expect(stats.calls.filter((c) => c.slot === 'review-judge').every((c) => c.system.includes('矛盾复核'))).toBe(true);

    // 六域产物。
    const byDomain = new Map(listDeconCanonEntries(jobId).map((e) => [e.domain, e]));
    for (const domain of ['world', 'rule', 'character', 'tone', 'timeline', 'relationship'] as const) {
      expect(byDomain.get(domain), `域 ${domain} 非空`).toBeDefined();
    }

    // 全部条目锚定可验：charStart/charEnd 落在章区间内且切片非空。
    for (const entry of listDeconCanonEntries(jobId)) {
      expect(entry.anchors.length).toBeGreaterThanOrEqual(1);
      for (const anchor of entry.anchors) {
        const chapter = FIXTURE.chapters[anchor.chapterIndex]!;
        expect(anchor.charStart).toBeGreaterThanOrEqual(chapter.charStart);
        expect(anchor.charEnd).toBeLessThanOrEqual(chapter.charEnd);
        expect(DERIVED.slice(anchor.charStart, anchor.charEnd).length).toBeGreaterThan(0);
      }
    }

    // character：三名真人（幻觉实体排除）+ C7 mutability 槽 + 纯代码面（aliases/mentions/relationships）。
    const characters = listDeconCanonEntries(jobId, 'character');
    expect(characters.map((c) => c.name).sort()).toEqual(['李逍遥', '老道人', '赵灵儿']);
    const zhao = characters.find((c) => c.name === '赵灵儿')!;
    expect(zhao.payload.aliases).toEqual(['灵儿', '赵灵兒']);
    const zhaoPortrait = (zhao.payload as { portrait?: { traits?: unknown } }).portrait;
    expect(zhaoPortrait?.traits).toEqual([
      { name: '侠义心', mutability: 'immutable' },
      { name: '重情', mutability: 'evolvable', note: '随师门变故演变' },
    ]);
    expect((zhao.payload as { relationships?: unknown[] }).relationships).toContainEqual({ with: '李逍遥', kind: '相识' });

    // relationship：别名（灵儿/赵灵兒）经 aliasMap 归 canonical 赵灵儿——单一角色对条目。
    // 主导方向 = 赵灵儿→李逍遥（2/3 边）；主导 kind 三种各 1 票 → 码点序最小「同行」（确定性）。
    const relations = listDeconCanonEntries(jobId, 'relationship');
    expect(relations.map((r) => r.name)).toEqual(['李逍遥 × 赵灵儿']);
    expect(relations[0]!.payload.pair).toMatchObject({ from: '赵灵儿', to: '李逍遥', kind: '同行' });
    expect(relations[0]!.payload.evidence).toBe('exact');

    // world/rule/tone：候选供给式条目（exact + inferred 各一）。
    for (const domain of ['world', 'rule', 'tone'] as const) {
      const entries = listDeconCanonEntries(jobId, domain);
      expect(entries.map((e) => e.payload.evidence).sort()).toEqual(['exact', 'inferred']);
    }
    const rule = listDeconCanonEntries(jobId, 'rule').find((e) => e.payload.evidence === 'exact')!;
    expect(rule.payload.statement).toContain('直接引用');

    // timeline：flashback 回退经复核确认 → intentional_loose（不落 conflict）+ 章序 events。
    const timeline = byDomain.get('timeline')!;
    expect(timeline.payload.consistency).toBe('intentional_loose');
    expect(timeline.payload.events).toHaveLength(4);
    expect(timeline.payload.conflictNote).toContain('1 处有意时序装置');
    expect(timeline.payload.conflictNote).toContain('0 处真矛盾');

    // per-domain pass_state done 同事务落库。
    for (const domain of ['world', 'rule', 'character', 'tone', 'timeline', 'relationship'] as const) {
      expect(getDeconPassState(jobId, 'p2', domain)).toMatchObject({ status: 'done', outputRef: `canon:${domain}` });
    }
    expect(getDeconJob(jobId)?.cost.byPass.p2?.calls).toBeGreaterThan(0);
  });

  it('真矛盾（回退无 device）→ conflict 且 job 不 failed', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const result = await runDeconP2(jobId, {
      generateText: mkP2Generate('no-device', { calls: [] }),
      readDerivedText: () => DERIVED,
      now: () => NOW,
    });
    expect(result.status).toBe('done'); // conflict 是 canon 层记录，不使 job failed
    const timeline = listDeconCanonEntries(jobId, 'timeline')[0];
    expect(timeline?.payload.consistency).toBe('conflict');
    expect(timeline?.payload.conflictNote).toContain('1 处真矛盾');
    expect(getDeconJob(jobId)?.status).toBe('running'); // 未被翻 failed
  });

  it('断点重入：二次跑六域全 skip 零 LLM 调用', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    await runDeconP2(jobId, { generateText: mkP2Generate('flashback', stats), readDerivedText: () => DERIVED, now: () => NOW });
    const firstCalls = stats.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    const second = await runDeconP2(jobId, { generateText: mkP2Generate('flashback', stats), readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    if (second.status !== 'done') return;
    expect(second.stats.skippedDomains).toBe(6);
    expect(stats.calls.length).toBe(firstCalls); // 零重调
  });

  it('中断韧性：域 LLM 调用中途 pause 翻态 → 当前域完成落库后域边界优雅停 → resume 续跑余域', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    // 第一个域（world）的归纳调用期间用户暂停——本域照常完成落库，下一域边界感知停。
    const stats = { calls: [] as { slot: string; system: string }[] };
    const base = mkP2Generate('flashback', stats);
    const pausesMidDomain: DeconGenerateText = async (input) => {
      if ((input.system ?? '').includes('设定档案整理器')) {
        expect(transitionDeconJob(jobId, 'pause').ok).toBe(true);
      }
      return base(input);
    };
    const paused = await runDeconP2(jobId, { generateText: pausesMidDomain, readDerivedText: () => DERIVED, now: () => NOW });
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    expect(getDeconJob(jobId)?.status).toBe('paused'); // job 行保持 paused（不误翻 failed）
    // world 域已落库 done；其余五域未开跑（域边界感知停——pause 后不再烧 token）。
    expect(getDeconPassState(jobId, 'p2', 'world')?.status).toBe('done');
    for (const domain of ['rule', 'character', 'tone', 'timeline', 'relationship'] as const) {
      expect(getDeconPassState(jobId, 'p2', domain)).toBeNull();
    }
    const callsWhenPaused = stats.calls.length;

    // resume：paused → running；world 域断点 skip，余五域续跑。
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const resumed = await runDeconP2(jobId, { generateText: base, readDerivedText: () => DERIVED, now: () => NOW });
    expect(resumed.status).toBe('done');
    if (resumed.status !== 'done') return;
    expect(resumed.stats.skippedDomains).toBe(1);
    expect(stats.calls.length).toBeGreaterThan(callsWhenPaused);
    for (const domain of ['world', 'rule', 'character', 'tone', 'timeline', 'relationship'] as const) {
      expect(getDeconPassState(jobId, 'p2', domain)).toMatchObject({ status: 'done' });
    }
  });

  it('P1c 未完成 → failed 提示先跑 P1c', async () => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
    seedFacts(); // 有 facts 无实体（P1c 未跑）
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    const result = await runDeconP2(jobId, { generateText: mkP2Generate('flashback', stats), readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('P1c');
    expect(stats.calls).toHaveLength(0);
  });

  it('LLM 内核未装配 → failed 诚实挂起（不硬给 canon）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const result = await runDeconP2(jobId, { readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('未装配');
    expect(getDeconJob(jobId)?.status).toBe('failed');
  });

  it('capped：小预算画像调用挂起（不烧 token）→ 调预算续跑完成', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', budget: { totalTokens: 1, perPass: {} } }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    const first = await runDeconP2(jobId, { generateText: mkP2Generate('flashback', stats), readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('capped');
    expect(stats.calls).toHaveLength(0); // 预算门前置不烧 token
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p2', 'world')?.status).toBe('capped');

    // 调大预算续跑（capped → retry → running）。
    const jobRow = getDeconJob(jobId);
    expect(jobRow).not.toBeNull();
    if (jobRow === null) return;
    upsertDeconJob({ ...jobRow, budget: { totalTokens: 100_000_000, perPass: {} } });
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const second = await runDeconP2(jobId, { generateText: mkP2Generate('flashback', stats), readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    if (second.status !== 'done') return;
    expect(second.stats.skippedDomains).toBe(0); // capped 域重跑（world 未落库）
    expect(listDeconCanonEntries(jobId).length).toBeGreaterThanOrEqual(6);
  });

  it('CR-4（共享脚手架）：finishReason=length → 升帽 ×2 重试一次 → 重试通过域照常完成（note 相位可见）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const stats = { calls: [] as { slot: string; system: string }[] };
    const base = mkP2Generate('flashback', stats);
    const notes: string[] = [];
    let recallCalls = 0;
    const caps: number[] = [];
    const gen: DeconGenerateText = async (input) => {
      if ((input.system ?? '').includes('设定档案整理器')) {
        recallCalls += 1;
        caps.push(input.maxTokens ?? -1);
        if (recallCalls === 1) return { text: '{"entries":', finishReason: 'length' as const }; // world 域首调截断
      }
      return base(input);
    };
    const result = await runDeconP2(jobId, {
      generateText: gen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      notify: (event) => {
        if (event.note !== undefined) notes.push(event.note);
      },
    });
    expect(result.status).toBe('done');
    // world 域 1+1 调（截断→升帽重试过）+ rule/tone 各 1 调。
    expect(recallCalls).toBe(4);
    expect(caps[1]).toBe(caps[0]! * 2); // 重试帽 ×DECON_LLM_RETRY_ESCALATE
    expect(notes.some((n) => n.includes('升帽重试'))).toBe(true); // 重试相位 note 可见
    expect(getDeconJob(jobId)?.cost.byPass.p2?.calls).toBeGreaterThanOrEqual(4); // actual 各记各的
    expect(getDeconPassState(jobId, 'p2', 'world')?.status).toBe('done');
  });

  it('CR-4（共享脚手架）：length 重试仍截断 → failed（canon 语义面）+ 两笔各记账 + 域挂起', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const stats = { calls: [] as { slot: string; system: string }[] };
    const base = mkP2Generate('flashback', stats);
    let recallCalls = 0;
    const gen: DeconGenerateText = async (input) => {
      if ((input.system ?? '').includes('设定档案整理器')) {
        recallCalls += 1;
        return { text: '{"entries":', finishReason: 'length' as const };
      }
      return base(input);
    };
    const result = await runDeconP2(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed'); // P2 截断语义 = failed（半程产物不可续），非 capped
    if (result.status === 'failed') {
      expect(result.message).toContain('截断');
      expect(result.message).toContain('不落半程产物');
    }
    expect(recallCalls).toBe(2); // 升帽重试一次后诚实挂起
    expect(getDeconPassState(jobId, 'p2', 'world')?.status).toBe('failed');
    expect(getDeconJob(jobId)?.status).toBe('failed');
    expect(getDeconJob(jobId)?.cost.byPass.p2?.calls).toBe(2); // 两笔 actual 各记（重试不绕记账）
  });

  it('CR-3：画像分批——10 锚定角色 → 2 批串行（每批 ≤8）且全员带画像（单 prompt 装 25+ 角色的 length 炸域防线）', async () => {
    const persons = Array.from({ length: 10 }, (_, i) => `角色${i}`);
    replaceDeconEntities(MAT_REF, DERIVED_HASH, persons.map((name, i) => mkEntity(name, 'person', [], false, [[i % 3, 1]])));
    for (let ci = 0; ci < 3; ci++) {
      upsertDeconChapterFacts({
        materialRef: MAT_REF,
        derivedHash: DERIVED_HASH,
        chapterIndex: ci,
        facts: mkFacts({
          chapterIndex: ci,
          entities: persons.filter((_, i) => i % 3 === ci).map((n) => [n, 'person'] as [string, string]),
          events: [{ what: `第${ci}章事件`, k: 1 }],
          edges: [],
        }),
      });
    }
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    const result = await runDeconP2(jobId, { generateText: mkP2Generate('flashback', stats), readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(stats.calls.filter((c) => c.system.includes('角色档案整理器'))).toHaveLength(2); // 8 + 2
    const characters = listDeconCanonEntries(jobId, 'character');
    expect(characters).toHaveLength(10);
    for (const c of characters) {
      expect((c.payload as { portrait?: unknown }).portrait).toBeDefined();
      expect((c.payload as { portraitDegraded?: boolean }).portraitDegraded).toBeUndefined();
    }
  });

  it('CR-3：画像批失败降级——画像字段空 + portraitDegraded 标记 + 审计计数，域仍落纯代码聚合（不炸 job）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    const base = mkP2Generate('flashback', stats);
    const badPortrait: DeconGenerateText = async (input) => {
      if ((input.system ?? '').includes('角色档案整理器')) {
        return { text: '{"characters":[{"name":"不存在的角色","identity":"x"}]}' }; // 集外名 → 两次整体拒收
      }
      return base(input);
    };
    const result = await runDeconP2(jobId, { generateText: badPortrait, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done'); // 降级非 fail
    if (result.status !== 'done') return;
    expect(result.stats.audit?.portraitDegradedCharacters).toBe(3); // 三角色一批全降级
    const characters = listDeconCanonEntries(jobId, 'character');
    expect(characters.map((c) => c.name).sort()).toEqual(['李逍遥', '老道人', '赵灵儿']); // 纯代码聚合照落
    for (const c of characters) {
      expect((c.payload as { portrait?: unknown }).portrait).toBeUndefined();
      expect((c.payload as { portraitDegraded?: boolean }).portraitDegraded).toBe(true);
    }
    const zhao = characters.find((c) => c.name === '赵灵儿')!;
    expect(zhao.payload.aliases).toEqual(['灵儿', '赵灵兒']);
    expect((zhao.payload as { relationships?: unknown[] }).relationships).toContainEqual({ with: '李逍遥', kind: '相识' });
  });

  it('CR-4：归纳条目同域重名 → 写侧去重不炸 PK 落库事务 + 审计计数（保首）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    const base = mkP2Generate('flashback', stats);
    const dupRecall: DeconGenerateText = async (input) => {
      if ((input.system ?? '').includes('设定档案整理器')) {
        const paras = parseRecallParagraphs(input.user);
        const first = paras[0];
        const second = paras[1];
        if (first === undefined || second === undefined) return { text: '{"entries":[]}' };
        return {
          text: JSON.stringify({
            entries: [
              { name: '重名条目', summary: '第一份', paraRanges: [{ start: first.p, end: first.p + 1 }], quote: first.text.slice(0, 10) },
              { name: '重名条目', summary: '第二份（重名——PK 违约源）', paraRanges: [{ start: second.p, end: second.p + 1 }] },
            ],
          }),
        };
      }
      return base(input);
    };
    const result = await runDeconP2(jobId, { generateText: dupRecall, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done'); // 旧实现：INSERT 撞 PK(job,domain,name) 炸落库事务 → 域 failed
    if (result.status !== 'done') return;
    for (const domain of ['world', 'rule', 'tone'] as const) {
      expect(listDeconCanonEntries(jobId, domain).map((e) => e.name)).toEqual(['重名条目']); // 保首去重
    }
    expect(result.stats.audit?.canonDroppedDuplicateNames).toBe(3); // 三域各 1
    expect(getDeconPassState(jobId, 'p2', 'world')?.status).toBe('done');
  });

  it('CR-16：timeline 漏答事件——按章序回退排布带 unannotated 标记 + 计数（不静默丢）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    const base = mkP2Generate('flashback', stats);
    const partial: DeconGenerateText = async (input) => {
      if ((input.system ?? '').includes('时间线标注器')) {
        const events = parseTimelineEvents(input.user);
        const answered = events.slice(1); // 漏答首个事件（e0 集市初遇）
        return {
          text: JSON.stringify({
            events: answered.map((e, i) =>
              e.what.includes('回忆')
                ? { id: e.id, storyTimeLabel: '十年前的雨夜', timeOrder: 0, device: 'flashback' }
                : { id: e.id, storyTimeLabel: `第${i + 1}日`, timeOrder: i + 1 },
            ),
          }),
        };
      }
      return base(input);
    };
    const result = await runDeconP2(jobId, { generateText: partial, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.audit?.timelineUnannotated).toBe(1);
    const timeline = listDeconCanonEntries(jobId, 'timeline')[0]!;
    const events = timeline.payload.events as Array<{ chapterIndex: number; storyTimeLabel?: string; unannotated?: boolean }>;
    expect(events).toHaveLength(4); // 全部 selected 按章序保留（旧实现静默丢成 3）
    expect(events[0]).toMatchObject({ chapterIndex: 0, unannotated: true }); // 漏答项带标记、无 storyTimeLabel
    expect('storyTimeLabel' in events[0]!).toBe(false);
    expect(events[1]?.storyTimeLabel).toBeDefined();
  });

  it('CR-14e：关系边端点未解析成实体（ghost pair）→ 丢边 + 计数（无孤儿关系行）', async () => {
    // 常规 seed + 一条端点未知的边（路人甲不在实体表——aliasMap 不命中）。
    const rows: DeconChapterFacts[] = [
      {
        materialRef: MAT_REF,
        derivedHash: DERIVED_HASH,
        chapterIndex: 0,
        facts: {
          ...mkFacts({
            chapterIndex: 0,
            entities: [
              ['李逍遥', 'person'],
              ['赵灵儿', 'person'],
            ],
            events: [{ what: '集市初遇', k: 1 }],
            edges: [
              { from: '李逍遥', to: '赵灵儿', kind: '相识', k: 1 },
              { from: '路人甲', to: '李逍遥', kind: '同路', k: 1 },
            ],
          }),
        },
      },
    ];
    for (const row of rows) upsertDeconChapterFacts(row);
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const stats = { calls: [] as { slot: string; system: string }[] };
    const result = await runDeconP2(jobId, { generateText: mkP2Generate('flashback', stats), readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.audit?.ghostPairEdgesDropped).toBe(1);
    const relations = listDeconCanonEntries(jobId, 'relationship');
    expect(relations.map((r) => r.name)).toEqual(['李逍遥 × 赵灵儿']); // ghost pair 不产出（旧实现产「李逍遥 × 路人甲」孤儿行）
  });
});
