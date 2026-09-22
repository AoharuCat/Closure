import { createHash } from 'node:crypto';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CraftCard,
  CraftTerm,
  DeconFindings,
  Material,
  ResolvedModel,
} from '@orison/shared-contracts';
import {
  DECON_P6_SYSTEM_PROMPT,
  buildDeconP6UserPrompt,
  collectDeconP6Candidates,
  hashDeconP6Output,
  runDeconP6,
  verifyDeconP6Anchors,
  type DeconP6Candidate,
} from '../main/decon/p6Craft';

// E10.3b W5：P6 craft 落卡测试——候选集收集（teachingId 确定性）/ 锚点终验丢条 / additive 字段
// 往返（originKind/bookTitle/evidence）/ 落卡幂等（重跑零重复 teaching——hash skip + teachingId
// 双保险）/ dedup 三档（挂/新建/merge-review 行；无 embed 模型全部新建）/ 词目校验降级
// （CR-14 清单外 pending 提报非丢弃）/ 分批落库（CR-6 无硬上限全落 + 批失败挂该批）/ 边界停走
// （CR-22 pass_state pending + 已落批保留续跑零重付）/ append 目标被删降级（CR-21）。
// ABI 门控 + throwaway home（mirror craftDistillPipeline.test.ts）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-p6');

const state = vi.hoisted(() => ({
  embedModel: null as ResolvedModel | null,
}));

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
  resolveEmbeddingModel: () => state.embedModel,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));
vi.mock('@orison/desktop-agent', () => ({
  resolveTaskModel: vi.fn(),
  assignmentThinkingControl: vi.fn(),
}));
vi.mock('@orison/model-protocols', () => ({
  generateText: vi.fn(),
  generateEmbeddings: vi.fn(),
}));

import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { EMBED_DIM } from '../main/db/closureIndexer';
import {
  insertCraftTerm,
  listCraftTerms,
  proposedCraftTermId,
} from '../main/db/closureCraftTermRepository';
import {
  getCraftCard,
  insertCraftCard,
  listCraftCards,
  deleteCraftCardRow,
} from '../main/db/closureCraftCardRepository';
import { listCraftMergeReviews } from '../main/db/closureCraftMergeReviewRepository';
import {
  deleteDeconProductsByMaterial,
  getDeconJob,
  getDeconPassState,
  upsertDeconProduct,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import {
  createDeconJob,
  startDeconJob,
  transitionDeconJob,
  type DeconJobDeps,
} from '../main/decon/deconJob';
import { teachingIdFor } from '../main/ipc/toolHandlers/craftDistillPipeline';
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

function stubModel(modelId = 'embed-model-a'): ResolvedModel {
  return {
    keyId: 'k1',
    modelId,
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:0',
    apiKey: 'stub',
    capability: 'embedding',
  };
}

function vec1024(slot = 0): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[slot] = 1.0;
  return v;
}

/** 给定 cosine 的单位向量（去重三档边界构造——mirror craftDistillPipeline.test.ts）。 */
function vecAtCosine(cosv: number): number[] {
  const rest = Math.sqrt(Math.max(0, 1 - cosv * cosv));
  const v = new Array(EMBED_DIM).fill(0);
  v[0] = cosv;
  v[1] = rest;
  return v;
}

// ── fixtures ──

const MAT_ID = 'mat-0000000000c6'; // hex 12（teachingId/craftTeachingSchema 派生输入）
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'c'.repeat(64)}`;
const TERM_QIDAIGAN = 'term-000000a1';

const P6_BODIES = [
  [
    '李逍遥在青云观的后院醒来，心里隐约不安。',
    '他去山下集市买酒，遇见了在溪边唱歌的赵灵儿。',
    '两人约好明日同去后山看瀑布。',
  ].join('\n\n'),
  [
    '后山瀑布下有一块古碑，碑上字迹模糊。',
    '李逍遥伸手触碰古碑，古碑忽然发出微弱的光。',
    '夜里老道人警告山中妖物出没。',
  ].join('\n\n'),
  ['李逍遥决定留下查明古碑来历。', '赵灵儿表示要一起留下。', '两人在观中客房住下。'].join('\n\n'),
];

function composeFixture(bodies: readonly string[]): {
  derived: string;
  chapters: Material['chapters'];
} {
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

const FIXTURE = composeFixture(P6_BODIES);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T13:00:00.000Z');
const jobDeps: DeconJobDeps = {
  readCurrentFingerprints: () => ({
    materialContentHash: CONTENT_HASH,
    derivedHash: DERIVED_HASH,
  }),
  now: () => NOW,
};

function mkMaterial(): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '落卡测试小说',
    format: 'txt',
    provenance: {
      medium: 'novel_text',
      tier: 'original',
      sourcePath: 'novel.txt',
      via: 'direct-read',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-05T00:00:00.000Z',
      author: '测试作者',
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
      charCount: DERIVED.length,
      chapterDetection: {
        method: 'regex',
        confidence: 'high',
        matchedFormats: [],
      },
    },
    chapters: FIXTURE.chapters,
    chunkSpans: [],
    contentHash: CONTENT_HASH,
    status: 'ready',
  };
}

function seedQidaiganTerm(): void {
  const term: CraftTerm = {
    termId: TERM_QIDAIGAN,
    category: 'qidaigan',
    name: '期待感节奏',
    status: 'active',
    mergedInto: null,
    note: null,
  };
  insertCraftTerm(term);
}

/** findings payload（evidence 默认锚定段 0+3；over 覆盖任意 finding 字段）。 */
function findingsPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
  const quote3 = DERIVED.slice(BLOCKS[3]!.start, BLOCKS[3]!.end);
  return {
    findings: [
      {
        insight: '开篇用人物情感钩立期待，钩子出现早且间隔短',
        elaboration: '第一章即埋人物情感钩，第二章触碑回收，蓄放间隔一章。',
        evidence: [
          { paraRange: { start: 0, end: 1 }, quote: quote0 },
          { paraRange: { start: 3, end: 4 }, quote: quote3 },
        ],
        craftHint: {
          category: 'qidaigan',
          termHint: '期待感节奏',
          tags: ['开篇', '期待感'],
        },
        ...over,
      },
    ],
    synthesis: '期待感建立快。',
  };
}

// ── generateText / embed mocks ──

const CONDENSED_TEXT = '开篇早埋人物情感钩，短间隔回收，让期待快速立起来';

interface P6GenCall {
  system?: string;
  user: string;
}

let genCalls: P6GenCall[] = [];
let condenseQueue: string[] = [];

const generateMock = async (input: { system?: string; user: string }) => {
  genCalls.push({ system: input.system, user: input.user });
  if ((input.system ?? '') === DECON_P6_SYSTEM_PROMPT) {
    const next = condenseQueue.shift();
    if (next === undefined) throw new Error('condenseQueue exhausted — fixture 未配置落卡响应');
    return { text: next };
  }
  throw new Error(`unexpected system prompt: ${(input.system ?? '(none)').slice(0, 24)}`);
};

let embedVectors = new Map<string, number[]>();
const embedMock = async (_m: ResolvedModel, text: string): Promise<number[]> => {
  const explicit = embedVectors.get(text);
  if (explicit !== undefined) return explicit;
  return vec1024(((text.length % 16) + 1) % EMBED_DIM);
};

function resetLlmFixtures(): void {
  genCalls = [];
  condenseQueue = [
    JSON.stringify({
      category: 'qidaigan',
      termId: TERM_QIDAIGAN,
      condensed: CONDENSED_TEXT,
      points: ['第一章内埋钩'],
      scenarios: ['开篇'],
      counterexamples: [],
      tags: ['开篇'],
      confidence: 0.8,
    }),
  ];
  embedVectors = new Map();
  state.embedModel = null;
}

/** 建会话（fine + qidaigan）→ start 翻 running → 种 p4 findings product 行。 */
function seedRunningJob(
  seeds: ReadonlyArray<{
    pass?: string;
    unit?: string;
    payload: Record<string, unknown>;
  }>,
): string {
  upsertMaterialRow(mkMaterial());
  const created = createDeconJob(
    { materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] },
    jobDeps,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('seed job failed');
  const started = startDeconJob(created.job.jobId, jobDeps);
  expect(started.ok).toBe(true);
  for (const seed of seeds) {
    const ok = upsertDeconProduct({
      jobId: created.job.jobId,
      pass: seed.pass ?? 'p4:qidaigan',
      unit: seed.unit ?? 'ch:0',
      payload: seed.payload,
      updatedAt: NOW.toISOString(),
    });
    expect(ok).toBe(true);
  }
  return created.job.jobId;
}

const baseDeps = () => ({
  generateText: generateMock,
  readDerivedText: () => DERIVED,
  now: () => NOW,
});

// ── 大候选量 fixture（CR-6/CR-22 分批落库用——段数参数化，每 10 段一章）──

interface BigFixture {
  derived: string;
  chapters: Material['chapters'];
  blocks: ReturnType<typeof splitParagraphBlocks>;
  derivedHash: string;
}

function buildBigFixture(paragraphCount: number): BigFixture {
  const paragraphs: string[] = [];
  for (let i = 0; i < paragraphCount; i += 1) {
    paragraphs.push(
      `段${i}：李逍遥在青云观后院做第${i}次早课，心里盘算古碑的来历与山下集市的传闻。`,
    );
  }
  const bodies: string[] = [];
  for (let i = 0; i < paragraphs.length; i += 10) {
    bodies.push(paragraphs.slice(i, i + 10).join('\n\n'));
  }
  const fixture = composeFixture(bodies);
  return {
    derived: fixture.derived,
    chapters: fixture.chapters,
    blocks: splitParagraphBlocks(fixture.derived),
    derivedHash: sha(fixture.derived),
  };
}

/** N 候选 findings payload（段 i = 候选 i 的单证据锚——teachingId 全互异）。 */
function bigFindingsPayload(big: BigFixture, count: number): Record<string, unknown> {
  const findings = [];
  for (let i = 0; i < count; i += 1) {
    const quote = big.derived.slice(big.blocks[i]!.start, big.blocks[i]!.end);
    findings.push({
      insight: `发现${i}`,
      elaboration: '分批落库测试发现。',
      evidence: [{ paraRange: { start: i, end: i + 1 }, quote }],
      craftHint: { category: 'qidaigan', termHint: '期待感节奏', tags: [] },
    });
  }
  return { findings, synthesis: '' };
}

function bigCondenseResponses(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      JSON.stringify({
        category: 'qidaigan',
        termId: TERM_QIDAIGAN,
        condensed: `分批主张${i}`,
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.5,
      }),
    );
  }
  return out;
}

function seedBigRunningJob(big: BigFixture, count: number): string {
  const base = mkMaterial();
  upsertMaterialRow({
    ...base,
    chapters: big.chapters,
    quality: { ...base.quality, charCount: big.derived.length },
  });
  const deps: DeconJobDeps = {
    readCurrentFingerprints: () => ({
      materialContentHash: CONTENT_HASH,
      derivedHash: big.derivedHash,
    }),
    now: () => NOW,
  };
  const created = createDeconJob(
    { materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] },
    deps,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('seed big job failed');
  const started = startDeconJob(created.job.jobId, deps);
  expect(started.ok).toBe(true);
  const ok = upsertDeconProduct({
    jobId: created.job.jobId,
    pass: 'p4:qidaigan',
    unit: 'ch:0',
    payload: bigFindingsPayload(big, count),
    updatedAt: NOW.toISOString(),
  });
  expect(ok).toBe(true);
  return created.job.jobId;
}

/** 双候选 findings payload（不同引文→不同 teachingId；CR-21/CR-22 review 幂等用）。 */
function twoCandidateFindingsPayload(): Record<string, unknown> {
  const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
  const quote3 = DERIVED.slice(BLOCKS[3]!.start, BLOCKS[3]!.end);
  return {
    findings: [
      {
        insight: '发现甲',
        elaboration: 'x',
        evidence: [{ paraRange: { start: 0, end: 1 }, quote: quote0 }],
        craftHint: { category: 'qidaigan', termHint: '期待感节奏' },
      },
      {
        insight: '发现乙',
        elaboration: 'y',
        evidence: [{ paraRange: { start: 3, end: 4 }, quote: quote3 }],
        craftHint: { category: 'qidaigan', termHint: '期待感节奏' },
      },
    ],
    synthesis: '',
  };
}

function mkCandidate(
  evidence: DeconFindings['findings'][number]['evidence'],
): Parameters<typeof verifyDeconP6Anchors>[0] {
  return {
    dimensionId: 'qidaigan',
    unit: 'ch:0',
    insight: 'i',
    elaboration: 'e',
    evidence,
    craftHint: { termHint: 't' },
    teachingId: 'tea-0000000000c6',
  };
}

describe.skipIf(!sqliteUsable)('deconP6Craft 纯函数面', () => {
  beforeEach(() => {
    resetLlmFixtures();
    clean();
    getDb(); // 触发 schema init + vec 扩展装载
    seedQidaiganTerm();
  });
  afterEach(() => {
    clean();
  });

  it('collectDeconP6Candidates：craftHint 过滤 + teachingId 确定性 + 批内同引文去重 + style 排除', () => {
    const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
    // p4:style 种合法 14 节 payload（写侧门按 pass 分派——findings 形态会被拒）。
    const stylePayload = {
      sections: {
        stats: '统计',
        excerpt: '```text\n原文\n```',
        appendix: '来源注记',
      },
      excerptAnchors: [{ chapterIndex: 0, charStart: 0, charEnd: 5, paraStart: 0, paraEnd: 1 }],
      bookTitle: '落卡测试小说',
      materialId: MAT_ID,
    };
    const jobId = seedRunningJob([
      { pass: 'p4:qidaigan', unit: 'ch:0', payload: findingsPayload() },
      {
        pass: 'p4:qingxu',
        unit: 'arc:0',
        payload: {
          findings: [
            {
              insight: '无提示发现',
              elaboration: 'x',
              evidence: [{ paraRange: { start: 0, end: 1 }, quote: quote0 }],
              craftHint: null,
            },
            {
              insight: '同引文重复发现',
              elaboration: 'y',
              evidence: [{ paraRange: { start: 0, end: 1 }, quote: quote0 }],
              craftHint: { termHint: 'dup' },
            },
          ],
          synthesis: '',
        },
      },
      { pass: 'p4:style', unit: 'all', payload: stylePayload }, // 风格维不落 craft 卡
    ]);
    const collected = collectDeconP6Candidates(jobId, MAT_ID, CONTENT_HASH);
    expect(collected.candidates).toHaveLength(1); // 无 hint 过滤 + 同引文去重 + style 排除
    expect(collected.findingsWithoutHint).toBe(1);
    const c = collected.candidates[0]!;
    expect(c.dimensionId).toBe('qidaigan');
    expect(c.teachingId).toBe(teachingIdFor(MAT_ID, CONTENT_HASH, quote0));
    expect(hashDeconP6Output([c.teachingId])).toBe(hashDeconP6Output([c.teachingId])); // 确定性 hash
  });

  it('verifyDeconP6Anchors：集外 paraRange 丢 / 引文不匹配丢 / 主锚 = 首个过验证据', () => {
    const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
    const verified = verifyDeconP6Anchors(
      mkCandidate([
        { paraRange: { start: 0, end: 1 }, quote: quote0 },
        { paraRange: { start: 999, end: 1000 }, quote: quote0 }, // 集外（编造 span）
        { paraRange: { start: 3, end: 4 }, quote: '原文里没有的编造引文' }, // 引文不匹配
      ]),
      BLOCKS,
      FIXTURE.chapters,
      DERIVED,
    );
    expect(verified).not.toBeNull();
    expect(verified!.anchors).toHaveLength(1);
    expect(verified!.droppedEvidence).toBe(2);
    expect(verified!.mainAnchor.paraStart).toBe(0);
    expect(verified!.mainAnchor.chapterIndex).toBe(0);

    const broken = verifyDeconP6Anchors(
      mkCandidate([{ paraRange: { start: 500, end: 501 }, quote: quote0 }]),
      BLOCKS,
      FIXTURE.chapters,
      DERIVED,
    );
    expect(broken).toBeNull(); // 主锚 broken → 整条候选丢（无锚即丢）
  });
});

describe('DECON_P6 prompt 网文语境 grep 守卫（feedback-webnovel-framing-no-classical）', () => {
  it('system + user prompt 零古典例零学院名号零反向禁令', () => {
    const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
    const candidate: DeconP6Candidate = {
      dimensionId: 'qidaigan',
      unit: 'ch:0',
      insight: '开篇用人物情感钩立期待，钩子出现早且间隔短',
      elaboration: '第一章即埋人物情感钩，第二章触碑回收，蓄放间隔一章。',
      evidence: [{ paraRange: { start: 0, end: 1 }, quote: quote0 }],
      craftHint: {
        category: 'qidaigan',
        termHint: '期待感节奏',
        tags: ['开篇', '期待感'],
      },
      teachingId: teachingIdFor(MAT_ID, CONTENT_HASH, quote0),
    };
    const user = buildDeconP6UserPrompt({
      bookTitle: '落卡测试小说',
      candidate,
      activeTerms: [
        {
          termId: TERM_QIDAIGAN,
          category: 'qidaigan',
          name: '期待感节奏',
          status: 'active',
          mergedInto: null,
          note: null,
        },
      ],
      corrective: false,
    });
    const corpus = [DECON_P6_SYSTEM_PROMPT, user].join('\n');
    expect(corpus).not.toMatch(
      /亚里士多德|红楼梦|水浒|三国|西游记|金瓶梅|儒林外史|麦基|热奈特|查特曼|申丹|普罗普|格雷马斯|托多罗夫|托尔斯泰|陀思妥|卡夫卡|博尔赫斯|普鲁斯特|乔伊斯|叙事学|叙述学|文学理论|经典文学|严肃文学|传统文学|纯文学|评点|起承转合|蒙太奇|戏剧反讽|价值极性/,
    );
    expect(corpus).not.toMatch(
      /不是[^。\n]{0,12}文学|(摒弃|拒绝|排斥)[^。\n]{0,10}(学院|学术|古典|传统)|(不采用|不使用|不用)[^。\n]{0,10}(理论|学院|古典)/,
    );
  });
});

describe.skipIf(!sqliteUsable)('deconP6Craft 落卡编排', () => {
  beforeEach(() => {
    resetLlmFixtures();
    clean();
    getDb();
    seedQidaiganTerm();
  });
  afterEach(() => {
    clean();
  });

  it('happy path：新建卡 + additive 字段往返（originKind/bookTitle/evidence strong）+ prompt 约束注入', async () => {
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats).toMatchObject({
      candidates: 1,
      newCards: 1,
      appended: 0,
      mergeReviews: 0,
      dedupOff: true,
    });

    // prompt 断言：13 大类受控注入 + active 词目清单 + 材料信息 + 落卡提示预注。
    expect(genCalls).toHaveLength(1);
    expect(genCalls[0]!.system).toBe(DECON_P6_SYSTEM_PROMPT);
    expect(DECON_P6_SYSTEM_PROMPT).toContain('手艺卡大类词表');
    expect(DECON_P6_SYSTEM_PROMPT).toContain('qingxu：情绪手法');
    expect(genCalls[0]!.user).toContain(`${TERM_QIDAIGAN} | qidaigan | 期待感节奏`);
    expect(genCalls[0]!.user).toContain('书名：落卡测试小说');
    expect(genCalls[0]!.user).toContain('建议大类：qidaigan');

    const cards = listCraftCards({ materialId: MAT_ID });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe('pending_review'); // R3 红线：全量人过
    expect(cards[0]!.category).toBe('qidaigan');
    expect(cards[0]!.termId).toBe(TERM_QIDAIGAN);
    expect(cards[0]!.condensed).toBe(CONDENSED_TEXT);
    const card = getCraftCard(cards[0]!.cardId)!; // zod 全量往返（additive 字段含内）
    expect(card.teachings).toHaveLength(1);
    const t = card.teachings[0]!;
    const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
    expect(t.teachingId).toBe(teachingIdFor(MAT_ID, CONTENT_HASH, quote0));
    expect(t.originKind).toBe('decon_instance');
    expect(t.bookTitle).toBe('落卡测试小说');
    expect(t.author).toBe('测试作者');
    expect(t.quote).toBe(quote0);
    expect(t.evidence).toBeDefined();
    expect(t.evidence!.anchors).toHaveLength(2); // 双证据全过验
    expect(t.evidence!.level).toBe('strong');
    expect(t.evidence!.derivedHash).toBe(DERIVED_HASH);
    expect(t.anchor.paraStart).toBe(0);
    // pass_state done 台账（outputRef 表:键式）。
    expect(getDeconPassState(jobId, 'p6', 'all')?.status).toBe('done');
    expect(getDeconPassState(jobId, 'p6', 'all')?.outputRef).toBe('craft:all');
  });

  it('幂等双保险：done+hash skip 零重付；状态行丢失（崩溃模拟）→ teachingId 命中零重复零 LLM', async () => {
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);
    await runDeconP6(jobId, baseDeps());
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(1);

    // ① done + 候选集 hash 一致 → skip（零 LLM）。
    genCalls = [];
    const again = await runDeconP6(jobId, baseDeps());
    expect(again.status).toBe('done');
    if (again.status !== 'done') return;
    expect(again.stats.skippedLanded).toBe(1);
    expect(genCalls).toHaveLength(0);
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(1);

    // ② 崩溃模拟：状态行没写成 → 重跑 teachingId 命中 no-op（批内 pre-landing 双保险）。
    getDb().prepare(`DELETE FROM closure_decon_pass_state WHERE job_id=? AND pass='p6'`).run(jobId);
    genCalls = [];
    const third = await runDeconP6(jobId, baseDeps());
    expect(third.status).toBe('done');
    if (third.status !== 'done') return;
    expect(third.stats.skippedLanded).toBe(1);
    expect(genCalls).toHaveLength(0);
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(1); // 零重复卡
    const card = getCraftCard(listCraftCards({ materialId: MAT_ID })[0]!.cardId)!;
    expect(card.teachings).toHaveLength(1); // 零重复讲法
  });

  it('锚点终验：编造 paraRange（集外）→ 候选丢弃 + 零落卡 + 零 LLM（核验前置于调用）', async () => {
    const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
    const jobId = seedRunningJob([
      {
        payload: {
          findings: [
            {
              insight: '编造锚点的发现',
              elaboration: 'paraRange 指向不存在的段。',
              evidence: [{ paraRange: { start: 999, end: 1000 }, quote: quote0 }],
              craftHint: { category: 'qidaigan' },
            },
          ],
          synthesis: '',
        },
      },
    ]);
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoAnchor).toBe(1);
    expect(result.stats.newCards).toBe(0);
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(0);
    expect(genCalls).toHaveLength(0);
  });

  it('CR-14 词目校验降级：清单外 termId 且库内无此词目 → pending 提报非丢弃（词表外命中走人审）', async () => {
    const jobId = seedRunningJob([
      {
        payload: findingsPayload({
          craftHint: { category: 'qidaigan', termHint: '全新词目甲', tags: [] },
        }),
      },
    ]);
    condenseQueue = [
      JSON.stringify({
        category: 'qidaigan',
        termId: 'term-doesnotexist',
        condensed: '清单外主张',
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.6,
      }),
    ];
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoCategory).toBe(0); // 非丢弃——降级提报
    expect(result.stats.newCards).toBe(1);
    expect(genCalls).toHaveLength(1); // 集外不再触发矫正重试（降级即受）
    const pendingTerms = listCraftTerms({ status: 'pending' });
    expect(pendingTerms).toHaveLength(1);
    expect(pendingTerms[0]!.name).toBe('全新词目甲'); // 提报名取落卡提示词目
    expect(pendingTerms[0]!.note).toContain('降级提案');
    const cards = listCraftCards({ materialId: MAT_ID });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.termId).toBe(proposedCraftTermId('qidaigan', '全新词目甲'));
  });

  it('CR-14 清单外 termId 命中库内 pending 词目 → DB 现查复用（active 快照外不再拒收）', async () => {
    insertCraftTerm({
      termId: 'term-00000099',
      category: 'qidaigan',
      name: '待并词目乙',
      status: 'pending',
      mergedInto: null,
      note: null,
    });
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);
    condenseQueue = [
      JSON.stringify({
        category: 'qidaigan',
        termId: 'term-00000099',
        condensed: '复用待并词目',
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.6,
      }),
    ];
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoCategory).toBe(0);
    const cards = listCraftCards({ materialId: MAT_ID });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.termId).toBe('term-00000099'); // 挂库内既有 pending 词目
    expect(listCraftTerms({ status: 'pending' })).toHaveLength(1); // 复用不重插
  });

  it('CR-14 proposedTerm 显式提案：pending 词目落行 + 卡挂提案 id（10.2 同语义，解析零 DB 读）', async () => {
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);
    condenseQueue = [
      JSON.stringify({
        proposedTerm: { category: 'zaogeng', name: '梗目录入法' },
        condensed: '提案主张',
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.7,
      }),
    ];
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    const cards = listCraftCards({ materialId: MAT_ID });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.category).toBe('zaogeng');
    expect(cards[0]!.termId).toBe(proposedCraftTermId('zaogeng', '梗目录入法'));
    expect(listCraftTerms({ status: 'pending' })[0]!.name).toBe('梗目录入法');
  });

  it('约束式归类：坏 JSON 两次 → per-claim 丢弃（pass 不炸；第二次带矫正注记）', async () => {
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);
    condenseQueue = ['这不是 JSON', '仍然不是 JSON'];
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoCategory).toBe(1);
    expect(result.stats.newCards).toBe(0);
    expect(genCalls).toHaveLength(2);
    expect(genCalls[1]!.user).toContain('注意：上一次输出不可解析或大类越界');
  });

  it('CR-16：空回复纠偏重试的 attempt-1 花费不丢——先累计再 continue（cost.calls 含两笔）', async () => {
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);
    condenseQueue = [
      '', // attempt-1 空回复（helper 已记 actual 落 job 行——本地 cost 不跟进会在 attempt-2 覆写丢笔）
      JSON.stringify({
        category: 'qidaigan',
        termId: TERM_QIDAIGAN,
        condensed: CONDENSED_TEXT,
        points: ['第一章内埋钩'],
        scenarios: ['开篇'],
        counterexamples: [],
        tags: ['开篇'],
        confidence: 0.8,
      }),
    ];
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoCategory).toBe(0); // 第二次成功——非丢弃
    expect(genCalls).toHaveLength(2); // 空回复 → 纠偏重试一次
    // 旧 bug：attempt-2 以旧 cost 快照 writeDeconCost 覆写（replace 语义）→ attempt-1 花费丢、calls 只剩 1。
    expect(getDeconJob(jobId)?.cost.byPass.p6?.calls).toBe(2);
  });

  it('CR-6 分批落库：220 候选（超旧 200 硬 ceiling）分批全落——done 不 fail、零丢弃零截断', async () => {
    const COUNT = 220;
    const big = buildBigFixture(COUNT);
    const jobId = seedBigRunningJob(big, COUNT);
    condenseQueue = bigCondenseResponses(COUNT);
    const result = await runDeconP6(jobId, {
      generateText: generateMock,
      readDerivedText: () => big.derived,
      now: () => NOW,
    });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats).toMatchObject({
      candidates: COUNT,
      newCards: COUNT,
      skippedLanded: 0,
      droppedNoCategory: 0,
      batchesFailed: 0,
      dedupOff: true,
    });
    expect(genCalls).toHaveLength(COUNT);
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(COUNT); // 全落（5 批：50×4+20）
    expect(getDeconPassState(jobId, 'p6', 'all')?.status).toBe('done');
  });

  it('CR-22 边界停走：批间暂停 → pass_state 回写 pending + 已落批保留；resume 零重付已落批', async () => {
    const COUNT = 120; // 3 批（50/50/20）
    const big = buildBigFixture(COUNT);
    const jobId = seedBigRunningJob(big, COUNT);
    let pauseAt: number | null = 60; // 第 60 次 LLM 调用后翻 paused（候选 61 边界停走）
    const runGenCalls: P6GenCall[] = [];
    const pausingGenerate = async (input: { system?: string; user: string }) => {
      runGenCalls.push({ system: input.system, user: input.user });
      const next = condenseQueue.shift();
      if (next === undefined) throw new Error('condenseQueue exhausted — fixture 未配置落卡响应');
      if (pauseAt !== null && runGenCalls.length >= pauseAt) transitionDeconJob(jobId, 'pause');
      return { text: next };
    };
    condenseQueue = bigCondenseResponses(COUNT);
    const run1 = await runDeconP6(jobId, {
      generateText: pausingGenerate,
      readDerivedText: () => big.derived,
      now: () => NOW,
    });
    expect(run1.status).toBe('paused');
    expect(runGenCalls).toHaveLength(60);
    // 已落批保留：批 1（50 候选）已提交；批 2 在途 10 候选弃（续跑重付仅限本批）。
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(50);
    // pass_state 回写 pending（非留 running——CR-22 关键断言面）。
    expect(getDeconPassState(jobId, 'p6', 'all')?.status).toBe('pending');

    // resume：paused → running → 续跑（70 次 LLM = 在途 10 + 未跑 60；已落 50 零重付）。
    const deps: DeconJobDeps = {
      readCurrentFingerprints: () => ({
        materialContentHash: CONTENT_HASH,
        derivedHash: big.derivedHash,
      }),
      now: () => NOW,
    };
    const started = startDeconJob(jobId, deps);
    expect(started.ok).toBe(true);
    pauseAt = null;
    runGenCalls.length = 0;
    condenseQueue = bigCondenseResponses(70);
    const run2 = await runDeconP6(jobId, {
      generateText: pausingGenerate,
      readDerivedText: () => big.derived,
      now: () => NOW,
    });
    expect(run2.status).toBe('done');
    expect(runGenCalls).toHaveLength(70); // 零重付已落批
    if (run2.status === 'done') {
      expect(run2.stats).toMatchObject({
        candidates: COUNT,
        skippedLanded: 50,
        newCards: 70,
      });
    }
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(COUNT);
    expect(getDeconPassState(jobId, 'p6', 'all')?.status).toBe('done');
  });

  it('CR-6 批失败只挂该批：批 1 事务失败（词目 id 冲突）→ 计数继续批 2 → 部分 landed + 诚实 failed（重试续落）', async () => {
    const COUNT = 51; // 2 批（50+1）
    const big = buildBigFixture(COUNT);
    // 占位词目抢占候选 1 提案的确定性 id（同 id 异 (category,name)——find-first 查重 miss，
    // 批落库 insertCraftTerm PK 冲突 → 批 1 事务失败）。手改库级异常的受控注入。
    insertCraftTerm({
      termId: proposedCraftTermId('zaogeng', '梗名甲'),
      category: 'zaogeng',
      name: '占位词目',
      status: 'pending',
      mergedInto: null,
      note: null,
    });
    const jobId = seedBigRunningJob(big, COUNT);
    const responses = bigCondenseResponses(COUNT);
    responses[0] = JSON.stringify({
      category: 'zaogeng',
      proposedTerm: { category: 'zaogeng', name: '梗名甲' },
      condensed: '批一提案主张',
      points: [],
      scenarios: [],
      counterexamples: [],
      tags: [],
      confidence: 0.5,
    });
    condenseQueue = responses;
    const result = await runDeconP6(jobId, { generateText: generateMock, readDerivedText: () => big.derived, now: () => NOW });
    expect(result.status).toBe('failed'); // batchesFailed>0 → 诚实 failed（非静默 done）
    if (result.status !== 'failed') return;
    expect(result.message).toContain('1/2 批事务失败');
    expect(result.stats.batchesFailed).toBe(1);
    expect(result.stats.newCards).toBe(1); // 批 2 照落（批 1 回滚零 landed）
    expect(genCalls).toHaveLength(COUNT); // 全候选照跑（失败批不中断后续批）
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(1);
    expect(getDeconPassState(jobId, 'p6', 'all')?.status).toBe('failed');
    expect(listCraftTerms({ status: 'pending' })).toHaveLength(1); // 仅占位词目（批 1 提案已回滚）
  });

  it('前置：coarse（零手艺维）→ 直接 done 零调用（belt——phases 静态过滤外的直调面）', async () => {
    upsertMaterialRow(mkMaterial());
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', dimensions: [] }, jobDeps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    startDeconJob(created.job.jobId, jobDeps);
    const result = await runDeconP6(created.job.jobId, baseDeps());
    expect(result.status).toBe('done');
    expect(genCalls).toHaveLength(0);
  });

  it('前置：手艺维在但零 craftHint findings → 诚实完成不空停', async () => {
    const quote0 = DERIVED.slice(BLOCKS[0]!.start, BLOCKS[0]!.end);
    const jobId = seedRunningJob([
      {
        payload: {
          findings: [
            {
              insight: '无提示发现',
              elaboration: 'x',
              evidence: [{ paraRange: { start: 0, end: 1 }, quote: quote0 }],
              craftHint: null,
            },
          ],
          synthesis: '',
        },
      },
    ]);
    const result = await runDeconP6(jobId, baseDeps());
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.candidates).toBe(0);
    expect(result.stats.findingsWithoutHint).toBe(1);
    expect(genCalls).toHaveLength(0);
  });
});

// ── dedup 三档（需 sqlite-vec——mirror craftDistillPipeline 去重三档段）──

describe.skipIf(!sqliteUsable)('deconP6Craft 去重三档（需 sqlite-vec）', () => {
  beforeEach(() => {
    resetLlmFixtures();
    clean();
    getDb();
    seedQidaiganTerm();
    state.embedModel = stubModel('embed-a');
  });
  afterEach(() => {
    clean();
  });

  /** 既有卡种子（embed 向量——KNN 对比基）。 */
  async function seedExistingCard(vector: number[]): Promise<string> {
    const card: CraftCard = {
      cardId: 'card-0000000000b6',
      category: 'qidaigan',
      termId: TERM_QIDAIGAN,
      title: '既有招式',
      claim: {
        condensed: '基线主张',
        points: [],
        scenarios: [],
        counterexamples: [],
      },
      tags: [],
      teachings: [
        {
          teachingId: 'tea-0000000000aa',
          materialId: 'mat-ffffffffffff',
          materialContentHash: `sha256:${'f'.repeat(64)}`,
          author: '旧作者',
          quote: '旧引文',
          anchor: {
            chapterIndex: 0,
            charStart: 0,
            charEnd: 4,
            paraStart: 0,
            paraEnd: 1,
          },
          rank: 'normal',
          note: null,
          stale: false,
        },
      ],
      dispute: false,
      status: 'pending_review',
      rejectReason: null,
      confidence: 0.9,
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    };
    await insertCraftCard(card, {
      resolveModel: () => stubModel('embed-a'),
      embed: async () => vector,
    });
    return card.cardId;
  }

  it('高置信档（sim ≥ 0.98）：挂既有卡候选——讲法 append + 相似度 note + originKind 落讲法', async () => {
    if (!isSqliteVecAvailable()) return;
    const existingCardId = await seedExistingCard(vec1024(0));
    embedVectors.set(CONDENSED_TEXT, vec1024(0)); // 同向量 → sim 1.0
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);

    const result = await runDeconP6(jobId, {
      ...baseDeps(),
      resolveModel: () => stubModel('embed-a'),
      embed: embedMock,
    });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.appended).toBe(1);
    expect(result.stats.newCards).toBe(0);
    expect(result.stats.dedupOff).toBe(false);

    const card = getCraftCard(existingCardId)!;
    expect(card.teachings).toHaveLength(2);
    const appended = card.teachings[1]!;
    expect(appended.materialId).toBe(MAT_ID);
    expect(appended.originKind).toBe('decon_instance'); // 挂载讲法也带 additive 溯源
    expect(appended.bookTitle).toBe('落卡测试小说');
    expect(appended.note).toContain('相似度');
    expect(appended.note).toContain('落卡测试小说');
    expect(card.status).toBe('pending_review'); // append 降级语义（10.2 均一）
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(1); // 挂候选不新建
  });

  it('中置信档（0.85 ≤ sim < 0.98）：建 merge-review 行（newClaim 全载荷 + similarity 记录）', async () => {
    if (!isSqliteVecAvailable()) return;
    const existingCardId = await seedExistingCard(vec1024(0));
    embedVectors.set(CONDENSED_TEXT, vecAtCosine(0.9));
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);

    const result = await runDeconP6(jobId, {
      ...baseDeps(),
      resolveModel: () => stubModel('embed-a'),
      embed: embedMock,
    });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.mergeReviews).toBe(1);
    expect(result.stats.newCards).toBe(0);
    expect(listCraftCards({ materialId: MAT_ID })).toHaveLength(0);

    const reviews = listCraftMergeReviews();
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.existingCardId).toBe(existingCardId);
    expect(review.similarity).toBeGreaterThan(0.85);
    expect(review.similarity).toBeLessThan(0.98);
    expect(review.resolution).toBeNull();
    expect(review.newClaim.claim.condensed).toBe(CONDENSED_TEXT);
    expect(review.newClaim.materialId).toBe(MAT_ID);
    expect(review.newClaim.termId).toBe(TERM_QIDAIGAN);
    // W7 小补①：newClaim 携带 additive 三字段——裁决成卡时 decon 实例身份透传不丢（AC4）。
    expect(review.newClaim.originKind).toBe('decon_instance');
    expect(review.newClaim.bookTitle).toBe('落卡测试小说');
    expect(review.newClaim.evidence).toBeDefined();
    expect(review.newClaim.evidence!.level).toBe('strong');
    expect(review.newClaim.evidence!.derivedHash).toBe(DERIVED_HASH);
    // pass_state done 照落（review 行 = 该候选的落点形态）。
    expect(getDeconPassState(jobId, 'p6', 'all')?.status).toBe('done');
  });

  it('低置信档（sim < 0.85）：新建卡（claim 向量同落——去重面常驻）', async () => {
    if (!isSqliteVecAvailable()) return;
    await seedExistingCard(vec1024(0));
    embedVectors.set(CONDENSED_TEXT, vecAtCosine(0.1)); // 正交近似
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);

    const result = await runDeconP6(jobId, {
      ...baseDeps(),
      resolveModel: () => stubModel('embed-a'),
      embed: embedMock,
    });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.newCards).toBe(1);
    const cards = listCraftCards({ materialId: MAT_ID });
    expect(cards).toHaveLength(1);
    const cardRow = getDb()
      .prepare('SELECT claim_model FROM closure_craft_card WHERE card_id=?')
      .get(cards[0]!.cardId) as { claim_model: string | null };
    expect(cardRow.claim_model).toBe('embed-a'); // 新卡 claim 向量落库（去重面常驻）
  });

  it('CR-21 append 目标卡在调度后被删 → 批落库降级转新建卡（不回滚整批、计数诚实）', async () => {
    if (!isSqliteVecAvailable()) return;
    const existingCardId = await seedExistingCard(vec1024(0));
    embedVectors.set(CONDENSED_TEXT, vec1024(0)); // 同向量 → sim 1.0 → 候选 1 排 append 动作
    const jobId = seedRunningJob([{ payload: twoCandidateFindingsPayload() }]);
    condenseQueue = [
      JSON.stringify({
        category: 'qidaigan',
        termId: TERM_QIDAIGAN,
        condensed: CONDENSED_TEXT,
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.5,
      }),
      JSON.stringify({
        category: 'qidaigan',
        termId: TERM_QIDAIGAN,
        condensed: CONDENSED_TEXT,
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.5,
      }),
    ];
    let calls = 0;
    const deletingGenerate = async (input: { system?: string; user: string }) => {
      calls += 1;
      genCalls.push({ system: input.system, user: input.user });
      // 候选 1 的 append 动作已排程（KNN 命中时目标卡还在）→ 候选 2 的调用中删目标卡。
      if (calls === 2) deleteCraftCardRow(existingCardId);
      const next = condenseQueue.shift();
      if (next === undefined) throw new Error('condenseQueue exhausted — fixture 未配置落卡响应');
      return { text: next };
    };
    const result = await runDeconP6(jobId, {
      generateText: deletingGenerate,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      resolveModel: () => stubModel('embed-a'),
      embed: embedMock,
    });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.appended).toBe(0);
    expect(result.stats.appendTargetGone).toBe(1); // 候选 1 降级计数
    expect(result.stats.newCards).toBe(2); // 候选 1 降级新建 + 候选 2（KNN 已无目标）新建
    expect(result.stats.batchesFailed).toBe(0); // 不回滚整批
    expect(getCraftCard(existingCardId)).toBeNull();
    const cardsFull = listCraftCards({ materialId: MAT_ID }).map((s) => getCraftCard(s.cardId)!);
    expect(cardsFull).toHaveLength(2);
    const degraded = cardsFull.find((c) => (c.teachings[0]!.note ?? '').includes('降级转新建卡'));
    expect(degraded).toBeDefined(); // 降级讲法带降级注记
    expect(degraded!.teachings[0]!.materialId).toBe(MAT_ID);
    expect(degraded!.category).toBe('qidaigan');
  });

  it('CR-22 review 落点幂等：review 落卡后状态行丢失（崩溃模拟）→ 重跑零 LLM 零重复 review', async () => {
    if (!isSqliteVecAvailable()) return;
    await seedExistingCard(vec1024(0));
    embedVectors.set('主张甲', vecAtCosine(0.9));
    embedVectors.set('主张乙', vecAtCosine(0.9));
    const jobId = seedRunningJob([{ payload: twoCandidateFindingsPayload() }]);
    condenseQueue = [
      JSON.stringify({
        category: 'qidaigan',
        termId: TERM_QIDAIGAN,
        condensed: '主张甲',
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.5,
      }),
      JSON.stringify({
        category: 'qidaigan',
        termId: TERM_QIDAIGAN,
        condensed: '主张乙',
        points: [],
        scenarios: [],
        counterexamples: [],
        tags: [],
        confidence: 0.5,
      }),
    ];
    const result = await runDeconP6(jobId, {
      ...baseDeps(),
      resolveModel: () => stubModel('embed-a'),
      embed: embedMock,
    });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.mergeReviews).toBe(2);
    expect(listCraftMergeReviews()).toHaveLength(2);

    // 崩溃模拟：p6 状态行没写成 → 重跑时 review 落点也占幂等面（零重付零重复并排任务）。
    getDb().prepare(`DELETE FROM closure_decon_pass_state WHERE job_id=? AND pass='p6'`).run(jobId);
    genCalls = [];
    condenseQueue = []; // 空——任何 LLM 调用即 throw（零调用断言面）
    const again = await runDeconP6(jobId, {
      ...baseDeps(),
      resolveModel: () => stubModel('embed-a'),
      embed: embedMock,
    });
    expect(again.status).toBe('done');
    if (again.status !== 'done') return;
    expect(again.stats.skippedLanded).toBe(2);
    expect(genCalls).toHaveLength(0);
    expect(listCraftMergeReviews()).toHaveLength(2); // 零重复
  });

  it('无 embed 模型：去重关 → 全部新建（dedupOff 诚实标注）', async () => {
    state.embedModel = null;
    const jobId = seedRunningJob([{ payload: findingsPayload() }]);
    const result = await runDeconP6(jobId, baseDeps()); // deps 不带 resolveModel/embed → 生产面（null）
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.newCards).toBe(1);
    expect(result.stats.dedupOff).toBe(true);
  });
});

afterAll(() => {
  rmBestEffort(TEST_HOME);
});
