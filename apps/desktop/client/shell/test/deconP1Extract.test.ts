import { createHash } from 'node:crypto';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconDictionaryEntry, Material } from '@orison/shared-contracts';

// E10.3a W4：P1b 逐章提取测试——纯函数面（分段/解析/锚定映射）+ db 编排面（全章跑通/词典+
// 滑窗注入/编造 span·引文拦截/断点续跑零重调/capped 不烧 token/超长章段内串行/stale/词典缺失）。
// ABI 门控 + throwaway home（mirror closureDeconRepository.test.ts）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-decon-p1b');

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
  getDeconDictionary,
  getDeconJob,
  getDeconPassState,
  listDeconChapterFacts,
  upsertDeconDictionary,
  upsertDeconJob,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob, transitionDeconJob } from '../main/decon/deconJob';
import { estimateDeconCallTokens } from '../main/decon/deconRun';
import {
  DECON_P1B_FACTS_MAX_TOKENS,
  DECON_P1B_SYSTEM_PROMPT,
  buildChapterSegments,
  buildDeconAnchor,
  buildDeconFactsUserPrompt,
  capDeconSynopsisToContract,
  parseDeconFactsSegmentResponse,
  runDeconP1b,
  type DeconP1bSegment,
} from '../main/decon/p1Extract';
import { composeDerivedText, splitParagraphBlocks, type MaterialParagraphBlock } from '../main/ipc/toolHandlers/materialIngest';

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

const MAT_ID = 'mat-000000000003';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'b'.repeat(64)}`;

const P1B_BODIES = [
  [
    '李逍遥在青云观的后院醒来，发现自己躺在一张竹床上。',
    '他想起了师父临走前说的话，心里一阵发紧。',
    '山下的集市人来人往，李逍遥买了一坛酒，遇见了赵灵儿。',
  ].join('\n\n'),
  [
    '赵灵儿约李逍遥去后山看瀑布，两人一前一后上了山。',
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

const FIXTURE = composeFixture(P1B_BODIES);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T12:00:00.000Z');
const jobDeps = (derivedHash: string = DERIVED_HASH) => ({
  readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash }),
  now: () => NOW,
});

const DICT_ENTRIES: DeconDictionaryEntry[] = [
  { name: '李逍遥', type: 'person', confidence: 0.9 },
  { name: '赵灵儿', type: 'person', confidence: 0.85 },
];

function mkMaterial(chapters: Material['chapters'] = FIXTURE.chapters): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '拆解测试小说',
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

function seedDict(derivedHash: string = DERIVED_HASH): void {
  upsertDeconDictionary({ materialRef: MAT_REF, derivedHash, entries: DICT_ENTRIES });
}

/** 预排调用序（章 × 段展开——mock 按序回放，与 runDeconP1b 的遍历序一致）。 */
function flatCalls(): Array<{ ci: number; seg: DeconP1bSegment }> {
  return FIXTURE.chapters.flatMap((c) => buildChapterSegments(BLOCKS, c).map((seg) => ({ ci: c.index, seg })));
}

/** 段级 facts 响应（paraRange/quote 全部真实锚定；第二实体引文注入空白抖动测归一容忍）。 */
function factsJsonFor(derived: string, blocks: readonly MaterialParagraphBlock[], ci: number, seg: DeconP1bSegment): string {
  const b = seg.blockStart;
  const q = (k: number): string => derived.slice(blocks[b + k]!.start, blocks[b + k]!.end);
  const jitter = (k: number): string => {
    const t = q(k);
    return t.length > 4 ? `${t.slice(0, 4)} ${t.slice(4)}` : t;
  };
  return JSON.stringify({
    synopsis: `【第${ci}章概要标记】李逍遥与赵灵儿的故事推进。`,
    entities: [
      { name: '李逍遥', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
      { name: '赵灵儿', type: 'person', paraRange: { start: b + 2, end: b + 3 }, quote: jitter(2) },
    ],
    events: [{ what: '触碰古碑引异象', paraRange: { start: b + 1, end: b + 2 }, quote: q(1), kernel: true }],
    relationshipEdges: [{ from: '李逍遥', to: '赵灵儿', kind: '同行', paraRange: { start: b, end: b + 1 }, quote: q(0) }],
    foreshadowPlanted: [{ hint: '古碑来历不明', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }],
    infoGap: [{ type: '悬疑未知', paraRange: { start: b + 2, end: b + 3 }, quote: q(2) }],
  });
}

/** 追加两个编造条目（引文不在原文 / paraRange 越段）——双核验拦截用例。 */
function factsJsonWithFabrication(ci: number, seg: DeconP1bSegment): string {
  const base = JSON.parse(factsJsonFor(DERIVED, BLOCKS, ci, seg)) as { entities: unknown[] };
  const b = seg.blockStart;
  base.entities.push(
    { name: '幻影仙人', type: 'person', paraRange: { start: b, end: b + 1 }, quote: '这句引文在正文中根本不存在真的' },
    { name: '越界实体', type: 'person', paraRange: { start: b + 99, end: b + 100 }, quote: DERIVED.slice(BLOCKS[b]!.start, BLOCKS[b]!.end) },
  );
  return JSON.stringify(base);
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

describe('buildChapterSegments（章内分段——10.2 装箱同款）', () => {
  it('常规章：单段覆盖章内全部相交块（mat-chapter 标记行不占号）', () => {
    expect(BLOCKS).toHaveLength(9);
    const segs = buildChapterSegments(BLOCKS, FIXTURE.chapters[1]!);
    expect(segs).toEqual([{ blockStart: 3, blockEnd: 6 }]);
  });

  it('超长章：按块边界拆多段，段并集 = 章块区间（单块超限保持整段不硬截）', () => {
    const filler = Array.from(
      { length: 90 },
      (_, i) => `后山小径的第${i}段路程漫长，两侧是茂密的树林与缠绕的藤蔓，脚下的石阶布满青苔，走起来颇费脚力。`.repeat(5),
    );
    const fixture = composeFixture([P1B_BODIES[0]!, filler.join('\n\n'), P1B_BODIES[2]!]);
    const blocks = splitParagraphBlocks(fixture.derived);
    const segs = buildChapterSegments(blocks, fixture.chapters[1]!);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0]!.blockStart).toBe(3); // 章 0 占 3 块、标记行不占号
    expect(segs[segs.length - 1]!.blockEnd).toBe(3 + filler.length);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.blockStart).toBe(segs[i - 1]!.blockEnd); // 无缝
    }
  });

  it('空章（区间与块不相交）→ 空数组', () => {
    const len = DERIVED.length;
    expect(buildChapterSegments(BLOCKS, { charStart: len, charEnd: len })).toEqual([]);
  });
});

describe('parseDeconFactsSegmentResponse（段级解析——条目级容错）', () => {
  const seg: DeconP1bSegment = { blockStart: 0, blockEnd: 3 };

  it('六段全合法 → 解析（kernel:true 保留 / kernel:false 省略）+ itemCount', () => {
    const raw = factsJsonFor(DERIVED, BLOCKS, 0, seg);
    const parsed = parseDeconFactsSegmentResponse(raw);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.droppedMalformed).toBe(0);
    expect(parsed.itemCount).toBe(6);
    expect(parsed.output.synopsis).toContain('【第0章概要标记】');
    expect(parsed.output.entities).toHaveLength(2);
    expect(parsed.output.events[0]?.kernel).toBe(true);
  });

  it('条目坏形状 → 丢该条计数（坏 type 枚举 / 缺 quote / 坏 paraRange / 信息差枚举外）', () => {
    const raw = JSON.stringify({
      synopsis: '概要',
      entities: [
        { name: '甲', type: 'deity', paraRange: { start: 0, end: 1 }, quote: 'x' },
        { name: '乙', type: 'person', paraRange: { start: 0, end: 1 } },
        { name: '丙', type: 'person', paraRange: { start: -1, end: 1 }, quote: 'x' },
        { name: '丁', type: 'person', paraRange: { start: 0, end: 1 }, quote: 'x' },
      ],
      infoGap: [{ type: '自造型', paraRange: { start: 0, end: 1 }, quote: 'x' }],
    });
    const parsed = parseDeconFactsSegmentResponse(raw);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.droppedMalformed).toBe(4);
    expect(parsed.output.entities).toHaveLength(1);
    expect(parsed.output.infoGap).toHaveLength(0);
  });

  it('顶层坏（无 synopsis / 非 JSON）→ null 整体拒收', () => {
    expect(parseDeconFactsSegmentResponse('{"entities":[]}')).toBeNull();
    expect(parseDeconFactsSegmentResponse('不是 JSON')).toBeNull();
  });
});

describe('buildDeconAnchor（paraRange → span 映射 + 集内核验）', () => {
  const seg: DeconP1bSegment = { blockStart: 3, blockEnd: 6 };

  it('段内引用 → 全局坐标 span（与 10.2 craftTeachingAnchor 同基同形）', () => {
    const span = buildDeconAnchor({ start: 4, end: 6 }, seg, BLOCKS, 1);
    expect(span).toEqual({
      chapterIndex: 1,
      charStart: BLOCKS[4]!.start,
      charEnd: BLOCKS[5]!.end,
      paraStart: 4,
      paraEnd: 6,
    });
  });

  it('集外（end 越段 / start<end 退化）→ null（编造 span 拦截）', () => {
    expect(buildDeconAnchor({ start: 2, end: 4 }, seg, BLOCKS, 1)).toBeNull();
    expect(buildDeconAnchor({ start: 4, end: 4 }, seg, BLOCKS, 1)).toBeNull();
  });
});

describe('buildDeconFactsUserPrompt（注入装配）', () => {
  it('词典块 + 【P 全局段号】正文 + 范围注记', () => {
    const user = buildDeconFactsUserPrompt({
      dictionaryEntries: DICT_ENTRIES,
      prevSynopses: ['第 0 章：前情'],
      derived: DERIVED,
      blocks: BLOCKS,
      segment: { blockStart: 3, blockEnd: 6 },
    });
    expect(user).toContain('实体词典');
    expect(user).toContain('李逍遥 | person');
    expect(user).toContain('【P3】');
    expect(user).toContain('（本片段段落号范围 P3–P5');
    expect(user).toContain('第 0 章：前情');
  });
});

describe('capDeconSynopsisToContract（CR-14b——一句-三句契约压回）', () => {
  it('≤3 句原样合并（句末标点保留）；无标点尾段并作一句', () => {
    const two = capDeconSynopsisToContract(['本章推进了主线。', '埋下一个伏笔？']);
    expect(two.synopsis).toBe('本章推进了主线。埋下一个伏笔？');
    expect(two.droppedSentences).toBe(0);
    const noPunct = capDeconSynopsisToContract(['一句话没标点', '另一句']);
    expect(noPunct.synopsis).toBe('一句话没标点另一句');
    expect(noPunct.droppedSentences).toBe(0);
  });

  it('>3 句截断到前 3 句 + 计数丢弃句数（多段章合并不破契约）', () => {
    const capped = capDeconSynopsisToContract(['第一句。', '第二句！', '第三句？', '第四句。', '第五句。']);
    expect(capped.synopsis).toBe('第一句。第二句！第三句？');
    expect(capped.droppedSentences).toBe(2);
  });
});

// ── db 编排面 ──

maybe('runDeconP1b（db 编排）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
  });

  it('happy path：全章跑通 + 词典/滑窗注入 + 六段锚定落库 + 同事务 done', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const flat = flatCalls();
    expect(flat).toHaveLength(3); // 每章单段
    const calls: string[] = [];
    let idx = 0;
    const gen = async (input: { user: string }): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      calls.push(input.user);
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const result = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats).toMatchObject({ chapters: 3, skipped: 0, extracted: 3, droppedNoAnchor: 0 });

    const rows = listDeconChapterFacts(MAT_REF, DERIVED_HASH);
    expect(rows).toHaveLength(3);
    // 章 0：锚定落全局坐标（块 0）+ 空白抖动引文容忍（两实体全存活）。
    expect(rows[0]?.facts.synopsis).toContain('【第0章概要标记】');
    expect(rows[0]?.facts.entities).toHaveLength(2);
    expect(rows[0]?.facts.entities[0]?.span).toMatchObject({ chapterIndex: 0, paraStart: 0, charStart: BLOCKS[0]!.start });
    // 章 1：块 3 起（标记行不占号）；kernel 事件 + 信息差 6 型枚举落库。
    expect(rows[1]?.facts.entities[0]?.span).toMatchObject({ chapterIndex: 1, paraStart: 3 });
    expect(rows[1]?.facts.events[0]?.kernel).toBe(true);
    expect(rows[1]?.facts.infoGap[0]?.type).toBe('悬疑未知');
    expect(rows[2]?.facts.relationshipEdges[0]).toMatchObject({ from: '李逍遥', to: '赵灵儿', kind: '同行' });

    // pass_state 同事务 done ×3（outputRef 契约形）。
    for (let i = 0; i < 3; i++) {
      expect(getDeconPassState(jobId, 'p1b', String(i))).toMatchObject({ status: 'done', outputRef: `facts:${i}` });
    }
    // 词典注入 + 滑窗注入（章 1 的 prompt 含章 0 synopsis；章 2 含章 1）。
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('实体词典');
    expect(calls[0]).toContain('李逍遥 | person');
    expect(calls[0]).not.toContain('概要标记'); // 首章无前情块
    expect(calls[1]).toContain('【第0章概要标记】');
    expect(calls[2]).toContain('【第1章概要标记】');
    expect(getDeconJob(jobId)?.cost.byPass.p1b?.calls).toBe(3);
  });

  it('无锚即丢：编造引文 / 越段 paraRange → 双核验拦截丢弃 + 计数审计', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const flat = flatCalls();
    let idx = 0;
    const gen = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      return { text: factsJsonWithFabrication(ci, seg) };
    };
    const result = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoAnchor).toBe(6); // 每章 2 条 × 3 章
    const rows = listDeconChapterFacts(MAT_REF, DERIVED_HASH);
    for (const row of rows) {
      expect(row.facts.entities).toHaveLength(2); // 编造条目全被拦截
      expect(row.facts.entities.map((e) => e.name)).not.toContain('幻影仙人');
      expect(row.facts.entities.map((e) => e.name)).not.toContain('越界实体');
    }
  });

  it('断点续跑：章 1 失败挂起 → 重跑章 0 零重调（mock 计数）→ 全章 done', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const flat = flatCalls();
    let run1 = 0;
    const failing = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[run1]!;
      run1 += 1;
      if (run1 === 2) throw new Error('LLM 炸了'); // 章 1 的首次调用失败
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const first = await runDeconP1b(jobId, { generateText: failing, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('failed');
    if (first.status === 'failed') expect(first.message).toContain('第 2 章'); // C5：index 1 的真实章标
    expect(getDeconJob(jobId)?.status).toBe('failed');
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(1); // 章 0 已落
    expect(getDeconPassState(jobId, 'p1b', '0')?.status).toBe('done');
    expect(getDeconPassState(jobId, 'p1b', '1')?.status).toBe('failed');

    // 重跑：failed → retry → running；章 0 断点跳过（零重调），章 1/2 续跑。
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let run2 = 0;
    const users: string[] = [];
    const good = async (input: { user: string }): Promise<{ text: string }> => {
      const { ci, seg } = flat[run2 + 1]!; // flat[0]（章 0）被跳过——从 flat[1] 起回放
      run2 += 1;
      users.push(input.user);
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const second = await runDeconP1b(jobId, { generateText: good, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    if (second.status !== 'done') return;
    expect(second.stats.skipped).toBe(1);
    expect(second.stats.extracted).toBe(2);
    expect(run2).toBe(2); // 章 0 零重调（AC8 mock 计数）
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(3);
    // 重跑首调用（章 1）的滑窗从 db 读回章 0 synopsis。
    expect(users[0]).toContain('【第0章概要标记】');
  });

  it('capped 挂起不烧 token：章 0 过、章 1 拦（恰 1 次调用）→ 调预算续跑完成', async () => {
    seedDict();
    const user0 = buildDeconFactsUserPrompt({
      dictionaryEntries: DICT_ENTRIES,
      prevSynopses: [],
      derived: DERIVED,
      blocks: BLOCKS,
      segment: flatCalls()[0]!.seg,
    });
    const est0 = estimateDeconCallTokens(DECON_P1B_SYSTEM_PROMPT, user0, DECON_P1B_FACTS_MAX_TOKENS);
    const created = createDeconJob(
      { materialId: MAT_ID, tier: 'coarse', budget: { totalTokens: est0, perPass: {} } },
      jobDeps(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const flat = flatCalls();
    let capped = 0;
    const gen = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[capped]!;
      capped += 1;
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const first = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('capped');
    if (first.status === 'capped') expect(first.message).toContain('第 2 章'); // C5：index 1 的真实章标
    expect(capped).toBe(1); // 章 0 恰一次；章 1 预算门前置拦截不烧 token
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p1b', '0')?.status).toBe('done');
    expect(getDeconPassState(jobId, 'p1b', '1')?.status).toBe('capped');

    // 调大预算续跑：章 0 断点跳过，章 1/2 完成。
    const jobRow = getDeconJob(jobId);
    expect(jobRow).not.toBeNull();
    if (jobRow === null) return;
    upsertDeconJob({ ...jobRow, budget: { totalTokens: 100_000_000, perPass: {} } });
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true); // capped → retry → running
    let resumed = 0;
    const resume = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[resumed + 1]!;
      resumed += 1;
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const second = await runDeconP1b(jobId, { generateText: resume, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    expect(resumed).toBe(2);
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(3);
  });

  it('C4-F16 写侧：材料级前置失败（行删）只 transitionDeconJob——不写 (p1b,all,failed) 化石行', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    getDb().exec('DELETE FROM closure_material'); // 材料行删（真删除——重试窗口耗尽后诚实失败）
    const result = await runDeconP1b(jobId, {
      readDerivedText: () => DERIVED,
      now: () => NOW,
      waitMs: async () => {},
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('不存在');
    expect(getDeconJob(jobId)?.status).toBe('failed');
    expect(getDeconJob(jobId)?.error).toContain('不存在');
    // 'all' 非 p1b 合法 unit（章号十进制串）——材料级失败不再产生化石行（job 行 error 已承载）。
    expect(getDeconPassState(jobId, 'p1b', 'all')).toBeNull();
  });

  it('C4-F12 读重试：中间态零章（pending）在重试窗口内回填 → 照常提取零失败', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    // 相 A 中间行：pending + 零章（reingest 在途形态——F12 竞态窗口）。
    upsertMaterialRow({ ...mkMaterial([]), status: 'pending' });
    let converged = false;
    const waitMs = async (): Promise<void> => {
      if (converged) return;
      converged = true;
      upsertMaterialRow(mkMaterial()); // 相 B 回填：wait 窗口内收敛
    };
    const flat = flatCalls();
    let idx = 0;
    const gen = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const result = await runDeconP1b(jobId, {
      generateText: gen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      waitMs,
    });
    expect(result.status).toBe('done');
    expect(idx).toBe(flat.length); // 收敛后全章照常提取
    expect(getDeconJob(jobId)?.status).toBe('running'); // 未被翻 failed/capped
  });

  it('超长章：段内串行多调用 + 段 synopsis 合并落库', async () => {
    const filler = Array.from(
      { length: 90 },
      (_, i) => `后山小径的第${i}段路程漫长，两侧是茂密的树林与缠绕的藤蔓，脚下的石阶布满青苔，走起来颇费脚力。`.repeat(5),
    );
    const fixture = composeFixture([P1B_BODIES[0]!, filler.join('\n\n'), P1B_BODIES[2]!]);
    const derivedH = fixture.derived;
    const blocksH = splitParagraphBlocks(derivedH);
    const hashH = sha(derivedH);
    upsertMaterialRow(mkMaterial(fixture.chapters));
    seedDict(hashH);
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(hashH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(hashH)).ok).toBe(true);

    const flatH = fixture.chapters.flatMap((c) => buildChapterSegments(blocksH, c).map((seg) => ({ ci: c.index, seg })));
    expect(flatH).toHaveLength(4); // 章 0 单段 + 章 1 两段 + 章 2 单段
    let idx = 0;
    const gen = async (): Promise<{ text: string }> => {
      const { ci, seg } = flatH[idx]!;
      idx += 1;
      return { text: factsJsonFor(derivedH, blocksH, ci, seg) };
    };
    const result = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => derivedH, now: () => NOW });
    expect(result.status).toBe('done');
    expect(idx).toBe(4);
    const rows = listDeconChapterFacts(MAT_REF, hashH);
    expect(rows).toHaveLength(3);
    const chapter1 = rows.find((r) => r.chapterIndex === 1);
    // 两段 synopsis 合并压回一句-三句契约（CR-14b——句级拼接无换行，句数 ≤3）。
    expect(chapter1?.facts.synopsis).toContain('【第1章概要标记】');
    expect((chapter1?.facts.synopsis.match(/[。！？!?]/g) ?? []).length).toBe(2);
    expect(getDeconPassState(jobId, 'p1b', '1')?.status).toBe('done');
    upsertMaterialRow(mkMaterial()); // 恢复常规 fixture（后续用例 beforeEach 亦重置）
  });

  it('CR-15：纯标记/空白章（segments 空）跳过 + 计数——不 fail 整个 p1b 与 job', async () => {
    seedDict();
    // 第 4 章区间与派生 .md 段落块不相交（尾部空区间 = 纯标记章形态）。
    const chaptersWithEmpty = [
      ...FIXTURE.chapters,
      { index: 3, title: '第四章（空）', charStart: DERIVED.length, charEnd: DERIVED.length, paraStart: 0, paraEnd: 0, confidence: 'high' as const, method: 'regex' as const },
    ];
    upsertMaterialRow(mkMaterial(chaptersWithEmpty));
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const flat = flatCalls();
    let idx = 0;
    const good = async (input: { user: string }): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const result = await runDeconP1b(jobId, { generateText: good, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done'); // 空章不 fail（旧实现 failUnit 整 pass）
    if (result.status !== 'done') return;
    expect(result.stats.emptySegmentChapters).toBe(1);
    expect(result.stats.extracted).toBe(3);
    expect(idx).toBe(3); // 空章零 LLM 调用（跳过路径不烧 token）
    expect(getDeconJob(jobId)?.status).toBe('running'); // job 未被翻 failed
    expect(getDeconPassState(jobId, 'p1b', '3')).toBeNull(); // 空章不落状态行（重跑幂等廉价）
    upsertMaterialRow(mkMaterial());
  });

  it('CR-10：词典存在性检查移到重入判定之后——继承 facts 全 done 时不因词典缺失误 fail', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const flat = flatCalls();
    let idx = 0;
    const gen = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const first = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('done');
    // 词典行被清（模拟跨 job 继承面缺词典的边界）——全章 done 重入应 skip 完成，不误 fail。
    getDb().prepare('DELETE FROM closure_decon_dictionary').run();
    expect(getDeconDictionary(MAT_REF, DERIVED_HASH)).toBeNull();
    const second = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done'); // 旧实现：词典前置检查 → failed（CR-10 修正）
    if (second.status !== 'done') return;
    expect(second.stats.skipped).toBe(3);
    expect(idx).toBe(3); // 零重调
  });

  it('中断韧性：LLM 调用中途 pause 翻态 → 当前章完成落库后优雅停 → resume 续跑尾章', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const flat = flatCalls();
    let idx = 0;
    const gen = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      if (idx === 1) {
        // 章 1 调用期间用户暂停（W6 pause 翻状态——本章照常完成落库，下一章边界感知停）。
        expect(transitionDeconJob(jobId, 'pause').ok).toBe(true);
      }
      idx += 1;
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const paused = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    expect(paused.stats.extracted).toBe(2); // 章 0/1 完成落库；章 2 未开跑
    expect(getDeconJob(jobId)?.status).toBe('paused');
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(2);
    expect(getDeconPassState(jobId, 'p1b', '1')?.status).toBe('done');

    // resume：paused → running；章 0/1 断点跳过，仅章 2 一调。
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let resumed = 0;
    const resume = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[resumed + 2]!;
      resumed += 1;
      return { text: factsJsonFor(DERIVED, BLOCKS, ci, seg) };
    };
    const done = await runDeconP1b(jobId, { generateText: resume, readDerivedText: () => DERIVED, now: () => NOW });
    expect(done.status).toBe('done');
    expect(resumed).toBe(1);
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(3);
  });

  it('派生 .md 现值 hash ≠ job 快照 → stale（F-02 锚点漂移不静默沿用）', async () => {
    seedDict();
    const OTHER_HASH = sha(DERIVED + '校对后');
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(OTHER_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(OTHER_HASH)).ok).toBe(true);

    const gen = vi.fn(async () => ({ text: '{}' }));
    const result = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('stale');
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconJob(jobId)?.status).toBe('stale');
  });

  it('词典缺失（P1a 未跑）→ failed 提示先跑 P1a', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    expect(getDeconDictionary(MAT_REF, DERIVED_HASH)).toBeNull(); // 词典未种

    const gen = vi.fn(async () => ({ text: '{}' }));
    const result = await runDeconP1b(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('P1a');
    expect(gen).toHaveBeenCalledTimes(0);
  });
});
