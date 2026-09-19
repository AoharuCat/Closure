import { createHash } from 'node:crypto';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconProgressEvent, Material } from '@orison/shared-contracts';

// E10.3b W2：P3a 逐章打标测试——纯函数面（解析容错/段合并/prompt 装配）+ db 编排面
// （全章跑通/编造 span·引文拦截/断点续跑零重调/capped 预算门+length 停因/边界停走/
// stale/空章跳过/无词典照常）。ABI 门控 + throwaway home（mirror deconP1Extract.test.ts）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-p3a');

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
  listDeconProducts,
  upsertDeconDictionary,
  upsertDeconJob,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob, transitionDeconJob } from '../main/decon/deconJob';
import { estimateDeconCallTokens } from '../main/decon/deconRun';
import {
  DECON_P3A_LABELS_MAX_TOKENS,
  DECON_P3A_SYSTEM_PROMPT,
  buildDeconP3aUserPrompt,
  mergeDeconLabelsSegments,
  parseDeconLabelsSegmentResponse,
  runDeconP3a,
  type DeconLabelsSegmentOutput,
} from '../main/decon/p3Label';
import { buildChapterSegments, type DeconP1bSegment } from '../main/decon/p1Extract';
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

const MAT_ID = 'mat-000000000005';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'c'.repeat(64)}`;

const P3A_BODIES = [
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

const FIXTURE = composeFixture(P3A_BODIES);
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

function mkMaterial(chapters: Material['chapters'] = FIXTURE.chapters): Material {  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '打标测试小说',
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

/** 词典条目（seedDict 与 capped 用例的 user0 预算估算共用——注入面一致才不假 cap）。 */
const DICT_ENTRIES = [
  { name: '李逍遥', type: 'person' as const, confidence: 0.9 },
  { name: '赵灵儿', type: 'person' as const, confidence: 0.85 },
];

function seedDict(): void {
  upsertDeconDictionary({ materialRef: MAT_REF, derivedHash: DERIVED_HASH, entries: DICT_ENTRIES });
}

/** 预排调用序（章 × 段展开——mock 按序回放，与 runDeconP3a 的遍历序一致）。 */
function flatCalls(): Array<{ ci: number; seg: DeconP1bSegment }> {
  return FIXTURE.chapters.flatMap((c) => buildChapterSegments(BLOCKS, c).map((seg) => ({ ci: c.index, seg })));
}

/** 段级打标响应（paraRange/quote 全部真实锚定；引文取块前缀——逐字摘录子串）。 */
function labelsJsonFor(ci: number, seg: DeconP1bSegment): string {
  const b = seg.blockStart;
  const q = (k: number): string => DERIVED.slice(BLOCKS[b + k]!.start, BLOCKS[b + k]!.end).slice(0, 8);
  return JSON.stringify({
    hooks: [{ type: '人物情感钩', paraRange: { start: b, end: b + 1 }, quote: q(0) }],
    transitions: [{ type: '反差转折', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }],
    emotionalBeats: [{ beat: '层层递进', paraRange: { start: b, end: b + 2 }, quote: q(0) }],
    plotPhase: ci === 1 ? '积蓄' : null,
    highlightSpans: [{ paraRange: { start: b + 2, end: b + 3 }, quote: q(2) }],
    expositionSpans: ci === 0 ? [{ paraRange: { start: b, end: b + 1 }, quote: q(0) }] : [],
    arcBoundary: ci === 2 ? { isCandidate: true, confidence: 0.9, signal: '新地图开启' } : null,
  });
}

/** 追加两个编造条目（引文不在原文 / paraRange 越段）——双核验拦截用例。 */
function labelsJsonWithFabrication(ci: number, seg: DeconP1bSegment): string {
  const base = JSON.parse(labelsJsonFor(ci, seg)) as { hooks: unknown[] };
  const b = seg.blockStart;
  base.hooks.push(
    { type: '未知悬疑钩', paraRange: { start: b, end: b + 1 }, quote: '这句引文在正文中根本不存在真的' },
    { type: '排行贪欲钩', paraRange: { start: b + 99, end: b + 100 }, quote: DERIVED.slice(BLOCKS[b]!.start, BLOCKS[b]!.start + 8) },
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

describe('parseDeconLabelsSegmentResponse（段级解析——条目级容错）', () => {
  const seg: DeconP1bSegment = { blockStart: 0, blockEnd: 3 };

  it('七字段全合法 → 解析（plotPhase null / arcBoundary 带理由保留）+ itemCount = 五段条目合计', () => {
    const parsed = parseDeconLabelsSegmentResponse(labelsJsonFor(0, seg));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.droppedMalformed).toBe(0);
    // 章 0 fixture：hooks+transitions+beats+highlight+exposition 各 1 → 5。
    expect(parsed.itemCount).toBe(5);
    expect(parsed.output.plotPhase).toBeNull();
    expect(parsed.output.arcBoundary).toBeNull();
  });

  it('非零章 fixture：plotPhase / arcBoundary 解析保留', () => {
    const parsed = parseDeconLabelsSegmentResponse(labelsJsonFor(2, seg));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.output.arcBoundary).toEqual({ isCandidate: true, confidence: 0.9, signal: '新地图开启' });
  });

  it('条目坏形状 → 丢该条计数（坏枚举 / 缺 quote / 坏 paraRange / 坏 arcBoundary / 坏 plotPhase）', () => {
    const raw = JSON.stringify({
      hooks: [
        { type: '自造型钩', paraRange: { start: 0, end: 1 }, quote: 'x' },
        { type: 'other', paraRange: { start: 0, end: 1 }, quote: 'x' },
        { type: '人物情感钩', paraRange: { start: 0, end: 1 } },
        { type: '人物情感钩', paraRange: { start: -1, end: 1 }, quote: 'x' },
      ],
      transitions: [{ type: '阻碍转折', paraRange: { start: 0, end: 1 }, quote: 'x' }],
      emotionalBeats: [{ beat: '编造拍', paraRange: { start: 0, end: 1 }, quote: 'x' }],
      highlightSpans: [{ paraRange: { start: 0, end: 1 } }],
      plotPhase: '蓄力',
      arcBoundary: { isCandidate: true, confidence: 2 },
    });
    const parsed = parseDeconLabelsSegmentResponse(raw);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    // 3 坏钩（自造型枚举/缺 quote/坏 paraRange）+ 坏拍 + 坏爽点 + 坏 plotPhase + 坏 arcBoundary = 7。
    expect(parsed.droppedMalformed).toBe(7);
    expect(parsed.output.hooks).toHaveLength(1); // 'other' 兜底存活
    expect(parsed.output.transitions).toHaveLength(1);
    expect(parsed.output.emotionalBeats).toHaveLength(0);
    expect(parsed.output.highlightSpans).toHaveLength(0);
    expect(parsed.output.plotPhase).toBeNull();
    expect(parsed.output.arcBoundary).toBeNull();
  });

  it('顶层坏（非 JSON / 七字段全缺）→ null 整体拒收；空标签对象（键在场）合法', () => {
    expect(parseDeconLabelsSegmentResponse('不是 JSON')).toBeNull();
    expect(parseDeconLabelsSegmentResponse('{"foo":1}')).toBeNull();
    const empty = parseDeconLabelsSegmentResponse('{"hooks":[],"plotPhase":null,"arcBoundary":null}');
    expect(empty).not.toBeNull();
  });
});

describe('mergeDeconLabelsSegments（多段合并——章级标量归并）', () => {
  const mkPart = (over: Partial<DeconLabelsSegmentOutput>): DeconLabelsSegmentOutput => ({
    hooks: [],
    transitions: [],
    emotionalBeats: [],
    plotPhase: null,
    highlightSpans: [],
    expositionSpans: [],
    arcBoundary: null,
    ...over,
  });

  it('plotPhase 取最末非空段；arcBoundary 取置信最高的候选（非候选不取）', () => {
    const merged = mergeDeconLabelsSegments([
      mkPart({ plotPhase: '拉仇恨', arcBoundary: { isCandidate: true, confidence: 0.7, signal: 'a' } }),
      mkPart({ plotPhase: null, arcBoundary: { isCandidate: false, confidence: 0.99 } }),
      mkPart({ plotPhase: '释放', arcBoundary: { isCandidate: true, confidence: 0.9, signal: 'b' } }),
    ]);
    expect(merged.plotPhase).toBe('释放');
    expect(merged.arcBoundary).toEqual({ isCandidate: true, confidence: 0.9, signal: 'b' });
  });

  it('无候选段 → arcBoundary null（非候选高置信不冒充切点）', () => {
    const merged = mergeDeconLabelsSegments([mkPart({ arcBoundary: { isCandidate: false, confidence: 0.99 } })]);
    expect(merged.arcBoundary).toBeNull();
  });
});

describe('buildDeconP3aUserPrompt（注入装配——词典可选）', () => {
  it('词典在场 → 注入块 + 【P 全局段号】正文 + 范围注记', () => {
    const user = buildDeconP3aUserPrompt({
      dictionaryEntries: [{ name: '李逍遥', type: 'person', confidence: 0.9 }],
      derived: DERIVED,
      blocks: BLOCKS,
      segment: { blockStart: 3, blockEnd: 6 },
    });
    expect(user).toContain('实体词典');
    expect(user).toContain('李逍遥 | person');
    expect(user).toContain('【P3】');
    expect(user).toContain('（本片段段落号范围 P3–P5');
  });

  it('词典 null → 无词典块照常（P3a 打标不强依赖实体）', () => {
    const user = buildDeconP3aUserPrompt({
      dictionaryEntries: null,
      derived: DERIVED,
      blocks: BLOCKS,
      segment: { blockStart: 0, blockEnd: 3 },
    });
    expect(user).not.toContain('实体词典');
    expect(user).toContain('【P0】');
  });
});

describe('DECON_P3A_SYSTEM_PROMPT（正典枚举注入）', () => {
  it('钩子 11 型 / 转折 9 型 / 情绪 7 拍 / 四相位全词形注入 + 双核验声明', () => {
    for (const word of ['被迫压力钩', '信息预期钩', '阻碍转折', '动态转折', '拉扯', '层层递进', '拉仇恨', '落袋为安']) {
      expect(DECON_P3A_SYSTEM_PROMPT).toContain(word);
    }
    expect(DECON_P3A_SYSTEM_PROMPT).toContain('paraRange');
    expect(DECON_P3A_SYSTEM_PROMPT).toContain('quote');
    // 反工具硬化行：纯文本车道调内置工具会被无头权限拒收，整回合拖成空响应。
    expect(DECON_P3A_SYSTEM_PROMPT).toContain('不要使用任何工具（联网搜索、命令执行、浏览器等）');
  });
});

// ── db 编排面 ──

maybe('runDeconP3a（db 编排）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
  });

  it('happy path：全章打标落 product + pass_state done + cost 记账 p3a', async () => {
    seedDict();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const flat = flatCalls();
    expect(flat).toHaveLength(3);
    const calls: string[] = [];
    let idx = 0;
    const gen = async (input: { user: string }): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      calls.push(input.user);
      return { text: labelsJsonFor(ci, seg) };
    };
    const result = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats).toMatchObject({ chapters: 3, skipped: 0, labeled: 3, droppedNoAnchor: 0, droppedMalformed: 0 });

    const rows = listDeconProducts(jobId, 'p3a');
    expect(rows).toHaveLength(3);
    // 章 0：钩子锚定落全局坐标（块 0）+ 设定段在场；章 2：弧界候选。
    const row0 = getDeconProduct(jobId, 'p3a', '0');
    expect(row0?.payload).toMatchObject({
      hooks: [{ type: '人物情感钩', span: { chapterIndex: 0, paraStart: 0, charStart: BLOCKS[0]!.start } }],
    });
    const payload0 = row0?.payload as { expositionSpans: unknown[]; plotPhase: string | null };
    expect(payload0.expositionSpans).toHaveLength(1);
    expect(payload0.plotPhase).toBeNull();
    const payload2 = getDeconProduct(jobId, 'p3a', '2')?.payload as { arcBoundary: { isCandidate: boolean; confidence: number } };
    expect(payload2.arcBoundary).toEqual({ isCandidate: true, confidence: 0.9, signal: '新地图开启' });
    const payload1 = getDeconProduct(jobId, 'p3a', '1')?.payload as { plotPhase: string | null };
    expect(payload1.plotPhase).toBe('积蓄');

    // pass_state 同事务 done ×3（outputRef 契约形）。
    for (let i = 0; i < 3; i++) {
      expect(getDeconPassState(jobId, 'p3a', String(i))).toMatchObject({ status: 'done', outputRef: `product:p3a:${i}` });
    }
    // 词典注入（有词典章带块）。
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('实体词典');
    expect(getDeconJob(jobId)?.cost.byPass.p3a?.calls).toBe(3);
  });

  it('无锚即丢：编造引文 / 越段 paraRange → 双核验拦截丢弃 + 计数审计', async () => {
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
      return { text: labelsJsonWithFabrication(ci, seg) };
    };
    const result = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.droppedNoAnchor).toBe(6); // 每章 2 条 × 3 章
    for (const row of listDeconProducts(jobId, 'p3a')) {
      const payload = row.payload as { hooks: Array<{ type: string }> };
      expect(payload.hooks).toHaveLength(1); // 编造条目全被拦截
      expect(payload.hooks.map((h) => h.type)).not.toContain('未知悬疑钩');
    }
  });

  it('断点续跑：章 1 失败挂起 → 重跑章 0 零重调（mock 计数）→ 全章 done；再跑全 skip 零调用', async () => {
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
      return { text: labelsJsonFor(ci, seg) };
    };
    const first = await runDeconP3a(jobId, { generateText: failing, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('failed');
    if (first.status === 'failed') expect(first.message).toContain('第 2 章'); // C5：index 1 的真实章标
    expect(getDeconJob(jobId)?.status).toBe('failed');
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(1); // 章 0 已落
    expect(getDeconPassState(jobId, 'p3a', '0')?.status).toBe('done');
    expect(getDeconPassState(jobId, 'p3a', '1')?.status).toBe('failed');

    // 重跑：failed → retry → running；章 0 断点跳过（零重调），章 1/2 续跑。
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let run2 = 0;
    const good = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[run2 + 1]!; // flat[0]（章 0）被跳过——从 flat[1] 起回放
      run2 += 1;
      return { text: labelsJsonFor(ci, seg) };
    };
    const second = await runDeconP3a(jobId, { generateText: good, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    if (second.status !== 'done') return;
    expect(second.stats.skipped).toBe(1);
    expect(second.stats.labeled).toBe(2);
    expect(run2).toBe(2); // 章 0 零重调（AC8 mock 计数）
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(3);

    // 全 done 重入：全 skip 零调用（LLM 内核未注入亦不 fail——CR-10 惰性面）。
    const third = await runDeconP3a(jobId, { readDerivedText: () => DERIVED, now: () => NOW });
    expect(third.status).toBe('done');
    if (third.status !== 'done') return;
    expect(third.stats.skipped).toBe(3);
  });

  it('capped 挂起不烧 token：章 0 过、章 1 预算门前置拦（恰 1 次调用）→ 调预算续跑完成', async () => {
    seedDict();
    const user0 = buildDeconP3aUserPrompt({
      dictionaryEntries: DICT_ENTRIES,
      derived: DERIVED,
      blocks: BLOCKS,
      segment: flatCalls()[0]!.seg,
    });
    const est0 = estimateDeconCallTokens(DECON_P3A_SYSTEM_PROMPT, user0, DECON_P3A_LABELS_MAX_TOKENS);
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
      return { text: labelsJsonFor(ci, seg) };
    };
    const first = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('capped');
    if (first.status === 'capped') expect(first.message).toContain('第 2 章'); // C5：index 1 的真实章标
    expect(capped).toBe(1); // 章 0 恰一次；章 1 预算门前置拦截不烧 token
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p3a', '0')?.status).toBe('done');
    expect(getDeconPassState(jobId, 'p3a', '1')?.status).toBe('capped');

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
      return { text: labelsJsonFor(ci, seg) };
    };
    const second = await runDeconP3a(jobId, { generateText: resume, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    expect(resumed).toBe(2);
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(3);
  });

  it("finishReason='length' → capped 挂起不落半程产物（权威停因——P3a 走 capped 可续）", async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const gen = async (): Promise<{ text: string; finishReason?: 'length' }> => ({
      text: labelsJsonFor(0, flatCalls()[0]!.seg),
      finishReason: 'length',
    });
    const result = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('capped');
    if (result.status === 'capped') {
      expect(result.message).toContain('截断');
      // C3：升帽重试一次后仍截断才挂——两笔 actual 各记各的（重试不绕记账）。
      expect(result.message).toContain('已升帽重试一次仍截断');
    }
    expect(getDeconJob(jobId)?.cost.calls).toBe(2);
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p3a', '0')?.status).toBe('capped');
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(0); // 半程产物零落库
  });

  it('C3 截断升帽重试：首尝试 length → 升帽 ×2 重试成功 → 章照常落库（notify note 相位可见）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const notes: DeconProgressEvent[] = [];
    const flat = flatCalls();
    let calls = 0;
    const gen = async (input: { maxTokens?: number }): Promise<{ text: string; finishReason?: 'length' | 'stop' }> => {
      calls += 1;
      const { ci, seg } = flat[0]!;
      if (calls === 1) {
        return { text: labelsJsonFor(ci, seg), finishReason: 'length' };
      }
      // 重试调用帽必须升 ×2（DECON_LLM_RETRY_ESCALATE 语义）。
      if (calls === 2) expect(input.maxTokens).toBe(DECON_P3A_LABELS_MAX_TOKENS * 2);
      const target = calls <= 2 ? flat[0]! : flat[calls - 2]!;
      return { text: labelsJsonFor(target.ci, target.seg) };
    };
    const result = await runDeconP3a(jobId, {
      generateText: gen,
      readDerivedText: () => DERIVED,
      now: () => NOW,
      notify: (e) => notes.push(e),
    });
    expect(result.status).toBe('done');
    expect(calls).toBe(flat.length + 1); // 章 0 两笔（截断+重试）+ 其余章各一笔
    expect(notes.some((e) => e.note?.includes('升帽重试 1/1') && e.pass === 'p3a')).toBe(true);
    expect(getDeconJob(jobId)?.cost.calls).toBe(flat.length + 1);
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(flat.length);
  });

  it('中断韧性：章 1 调用期间 pause 翻态 → 本章完成落库后优雅停 → resume 续跑尾章', async () => {
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
        // 章 1 调用期间用户暂停（本章照常完成落库，下一章边界感知停）。
        expect(transitionDeconJob(jobId, 'pause').ok).toBe(true);
      }
      idx += 1;
      return { text: labelsJsonFor(ci, seg) };
    };
    const paused = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused') return;
    expect(paused.stats.labeled).toBe(2); // 章 0/1 完成落库；章 2 未开跑
    expect(getDeconJob(jobId)?.status).toBe('paused');
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(2);
    expect(getDeconPassState(jobId, 'p3a', '1')?.status).toBe('done');

    // resume：paused → running；章 0/1 断点跳过，仅章 2 一调。
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    let resumed = 0;
    const resume = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[resumed + 2]!;
      resumed += 1;
      return { text: labelsJsonFor(ci, seg) };
    };
    const done = await runDeconP3a(jobId, { generateText: resume, readDerivedText: () => DERIVED, now: () => NOW });
    expect(done.status).toBe('done');
    expect(resumed).toBe(1);
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(3);
  });

  it('CR-15 同款：纯标记/空白章（segments 空）跳过 + 计数——不 fail 整个 p3a', async () => {
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
    const good = async (): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      return { text: labelsJsonFor(ci, seg) };
    };
    const result = await runDeconP3a(jobId, { generateText: good, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done'); // 空章不 fail
    if (result.status !== 'done') return;
    expect(result.stats.emptySegmentChapters).toBe(1);
    expect(result.stats.labeled).toBe(3);
    expect(idx).toBe(3); // 空章零 LLM 调用
    expect(getDeconJob(jobId)?.status).toBe('running'); // job 未被翻 failed
    expect(getDeconPassState(jobId, 'p3a', '3')).toBeNull(); // 空章不落状态行
  });

  it('派生 .md 现值 hash ≠ job 快照 → stale（F-02 锚点漂移不静默沿用）', async () => {
    const OTHER_HASH = sha(DERIVED + '校对后');
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(OTHER_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(OTHER_HASH)).ok).toBe(true);

    const gen = vi.fn(async () => ({ text: '{}' }));
    const result = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('stale');
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconJob(jobId)?.status).toBe('stale');
  });

  it('无词典照常打标（词典可选——与 P1b 强依赖不同）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM closure_decon_dictionary').get()).toMatchObject({ n: 0 });

    const flat = flatCalls();
    const calls: string[] = [];
    let idx = 0;
    const gen = async (input: { user: string }): Promise<{ text: string }> => {
      const { ci, seg } = flat[idx]!;
      idx += 1;
      calls.push(input.user);
      return { text: labelsJsonFor(ci, seg) };
    };
    const result = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('done');
    expect(calls[0]).not.toContain('实体词典');
  });

  it('CR-5 合并帽：长章分段各 ≤ 帽但合并超限 → 该章 failed（段合计口径——不再落 2-N 倍帽）', async () => {
    // 单章 2 段（每段 ~14.4K 字——18K 装箱线拆 2 段）；每段各回 200 条（段内 ≤300 过）→
    // 合并 400 > 300 触发段合计帽（对齐契约注释「五段条目合计超限→unit 失败」+ P4 合并检查）。
    const longBody = [
      `长章第一段开头。${'很长的正文内容不断推进。'.repeat(1_200)}`,
      `长章第二段开头。${'很长的正文内容继续推进。'.repeat(1_200)}`,
    ].join('\n\n');
    const longFixture = composeFixture([longBody]);
    const longDerived = longFixture.derived;
    const longBlocks = splitParagraphBlocks(longDerived);
    const longHash = sha(longDerived);
    const segs = buildChapterSegments(longBlocks, longFixture.chapters[0]!);
    expect(segs).toHaveLength(2); // 确证「多段合并」前提
    upsertMaterialRow(mkMaterial(longFixture.chapters));

    const longDeps = { readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: longHash }), now: () => NOW };
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, longDeps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, longDeps).ok).toBe(true);

    const capJson = (seg: DeconP1bSegment): string => {
      const b = seg.blockStart;
      return JSON.stringify({
        hooks: Array.from({ length: 200 }, () => ({
          type: '人物情感钩',
          paraRange: { start: b, end: b + 1 },
          quote: '帽测试形状合法引文',
        })),
        plotPhase: null,
        arcBoundary: null,
      });
    };
    let calls = 0;
    const gen = async (): Promise<{ text: string }> => {
      const seg = segs[calls]!;
      calls += 1;
      return { text: capJson(seg) };
    };
    const result = await runDeconP3a(jobId, { generateText: gen, readDerivedText: () => longDerived, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.message).toContain('合并后共 400 条');
      expect(result.message).toContain('超过上限 300');
    }
    expect(calls).toBe(2); // 两段都烧完才在合并面拦截（合并帽语义——非段内提前拦）
    expect(getDeconPassState(jobId, 'p3a', '0')?.status).toBe('failed');
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(0); // 超帽章零落库
  });
});
