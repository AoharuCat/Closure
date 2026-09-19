import { createHash } from 'node:crypto';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Material } from '@orison/shared-contracts';
import type { DeconProgressEvent } from '@orison/shared-contracts';

// E10.3a W6（收官）：P0→P2 全链集成测试——IPC 通道族（create/start/pause/cancel/delete/get/list）
// × 后台管线编排（runDeconPassSequence）× 合成 fixture 材料（别名对/幻觉实体名/flashback
// 时间线回退/kernel 事件）全链跑通。覆盖：六域+词典+实体+facts 齐全且锚定可验 / done→start
// 幂等 / 同指纹新 job P1 零重算（F-07）/ capped 挂起→start 调预算续跑 / 三档预估单调 /
// 材料校对→get 返回 stale / decon:delete per-job 级联（事实层三表保留）/ materials:delete
// 级联四清接线 / decon:progress 事件序列。
// E10.3b W3b 随迁+增补：phases 动态化（coarse 无闸序列 = A 四 pass + p3a/p3b）+ 人审闸门
// 三 checkpoint 到点暂停→approve-review 续跑零重付 + craft 闸门前置（coarse 不空停）+
// 维度×档位序列矩阵（buildDeconPhaseSteps 纯函数）。ABI 门控 + throwaway home。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-ipc');

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
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
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
  getDeconProduct,
  listDeconChapterFacts,
  listDeconEntities,
  listDeconPassStates,
  listDeconProducts,
  listDeconReviews,
  upsertDeconJob,
  upsertDeconProduct,
  upsertDeconReport,
  upsertDeconReview,
} from '../main/db/closure-decon';
// namespace 面：CR-12 用 vi.spyOn 模拟闸门行初始化中途失败（mirror closureChainIpc 对
// projectWriteLock 的 spyOn 先例——Vite transform 下具名导入经同一模块对象路由，spy 可拦截）。
import * as closureDeconDb from '../main/db/closure-decon';
import { listDeconCanonEntries } from '../main/db/closure-canon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { estimateDeconCost } from '../main/decon/deconBudget';
import { reconcileStaleDeconJobsOnStartup } from '../main/decon/deconJob';
import type { DeconGenerateText } from '../main/decon/deconLlmCore';
import {
  buildDeconPhaseSteps,
  runDeconPassSequence,
  type DeconPassSequenceResult,
  type DeconPhaseStep,
} from '../main/ipc/deconIpc';
import { createDeconIpcHandlers, type DeconIpcHandlers } from '../main/ipc/deconIpc';
import { createMaterialIpcHandlers } from '../main/ipc/materialIpc';
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

// ── fixtures（3 章——别名对〔灵儿/赵灵兒〕+ 幻觉实体名〔幻影真人〕+ flashback 事件 + kernel 事件 + 规则段）──

const MAT_ID = 'mat-000000000006';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'e'.repeat(64)}`;

const CH0 = [
  '李逍遥在青云观的后院醒来，李逍遥发现自己躺在一张竹床上。',
  '李逍遥在山下集市遇见了赵灵儿，赵灵儿正在溪边唱歌。',
  '李逍遥与赵灵儿约好明日一同去后山，李逍遥心里隐约不安。',
].join('\n\n');
const CH1 = [
  '赵灵儿约李逍遥去后山看瀑布，灵儿走在前面哼着歌。',
  '瀑布下的水潭边有一块古碑，李逍遥伸手触碰古碑，古碑忽然发出了微弱的光。',
  '夜里李逍遥回想起十年前的那个雨夜，师父冒雨背着他走过的山路。',
].join('\n\n');
const CH2 = [
  '赵灵兒被脚步声惊醒，赵灵兒披衣起身推开了房门。',
  '青云观的老道人找到了李逍遥他们，说山中有妖物出没。',
  '观中规矩：入夜后不可下山，弟子必须按时回房。',
].join('\n\n');

function composeFixture(bodies: readonly string[]): { derived: string; chapters: Material['chapters'] } {
  // 章间空行分隔——块严格落章内（mirror deconP2Canon.test.ts）。
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

const FIXTURE = composeFixture([CH0, CH1, CH2]);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T18:00:00.000Z');

function mkMaterial(): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '全链拆解测试小说',
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

/** 每章 facts 响应（真实锚定——paraRange/quote 取自块文本；raw 形态 = LLM 输出契约）。 */
function factsJsonForChapter(chapterIndex: number, seg: { blockStart: number }): string {
  const b = seg.blockStart;
  const q = (k: number): string => DERIVED.slice(BLOCKS[b + k]!.start, BLOCKS[b + k]!.end);
  const entityRows =
    chapterIndex === 0
      ? [
          { name: '李逍遥', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
          { name: '赵灵儿', type: 'person', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
          { name: '青云观', type: 'place', paraRange: { start: b, end: b + 1 }, quote: q(0) },
          { name: '幻影真人', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
        ]
      : chapterIndex === 1
        ? [
            { name: '李逍遥', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
            { name: '灵儿', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
            { name: '古碑', type: 'item', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
          ]
        : [
            { name: '李逍遥', type: 'person', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
            { name: '赵灵兒', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
            { name: '老道人', type: 'person', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
          ];
  const events =
    chapterIndex === 0
      ? [{ what: '集市初遇', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }]
      : chapterIndex === 1
        ? [
            { what: '触碰古碑引异象', paraRange: { start: b + 1, end: b + 2 }, quote: q(1), kernel: true },
            { what: '回忆起十年前的雨夜', paraRange: { start: b + 2, end: b + 3 }, quote: q(2) },
          ]
        : [{ what: '老道人示警妖物', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }];
  const edges =
    chapterIndex === 0
      ? [{ from: '李逍遥', to: '赵灵儿', kind: '相识', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }]
      : chapterIndex === 1
        ? [{ from: '灵儿', to: '李逍遥', kind: '同门', paraRange: { start: b, end: b + 1 }, quote: q(0) }]
        : [{ from: '赵灵兒', to: '李逍遥', kind: '同行', paraRange: { start: b, end: b + 1 }, quote: q(0) }];
  const foreshadow =
    chapterIndex === 1 ? [{ hint: '古碑来历不明', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }] : [];
  const infoGap =
    chapterIndex === 0
      ? [{ type: '爽感预期', paraRange: { start: b + 2, end: b + 3 }, quote: q(2) }]
      : chapterIndex === 1
        ? [{ type: '悬疑未知', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }]
        : [{ type: '信息前置', paraRange: { start: b + 2, end: b + 3 }, quote: q(2) }];
  return JSON.stringify({
    synopsis: `【第${chapterIndex}章】李逍遥与赵灵儿的故事推进。`,
    entities: entityRows,
    events,
    relationshipEdges: edges,
    foreshadowPlanted: foreshadow,
    infoGap,
  });
}

// ── 全链复合 LLM mock（按 system 标记分派；counts 按类型计数供断言）──

export interface ChainMockCounts {
  classify: number;
  facts: number;
  adjudicate: number;
  portrait: number;
  recall: number;
  timeline: number;
  review: number;
  /** E10.3b W3b：p3a 计量打标 / p4 手艺问题单调用计数。 */
  labels: number;
  p4: number;
  /** E10.3b W5：p5 三 kind 报告生成调用计数（phases 接线后 coarse 全链也过 book_reading）。 */
  p5book: number;
  p5chapter: number;
  p5scene: number;
}

function mkChainGenerate(counts: ChainMockCounts): DeconGenerateText {
  const DICT_TYPES: Record<string, string> = {
    李逍遥: 'person',
    赵灵儿: 'person',
    赵灵兒: 'person',
    灵儿: 'person',
    老道人: 'person',
    青云观: 'place',
    古碑: 'item',
  };
  return async (input) => {
    const system = input.system ?? '';
    const user = input.user;
    if (system.includes('实体词典分类器')) {
      counts.classify += 1;
      const candidates = [...user.matchAll(/^\d+ \| (.+?) \| \d+$/gm)].map((m) => m[1]!);
      const picked = candidates.filter((name) => DICT_TYPES[name] !== undefined);
      return { text: JSON.stringify(picked.map((name) => ({ name, type: DICT_TYPES[name], confidence: 0.9 }))) };
    }
    if (system.includes('事实层提取器')) {
      counts.facts += 1;
      const first = /【P(\d+)】/.exec(user);
      const blockStart = first === null ? 0 : Number(first[1]);
      const chapterIndex = Math.floor(blockStart / 3);
      return { text: factsJsonForChapter(chapterIndex, { blockStart }) };
    }
    if (system.includes('实体消歧')) {
      counts.adjudicate += 1;
      const pairIds = [...user.matchAll(/^(\d+) \| /gm)].map((m) => m[1]!);
      return { text: JSON.stringify(pairIds.map((pairId) => ({ pairId, sameEntity: true }))) };
    }
    if (system.includes('角色档案整理器')) {
      counts.portrait += 1;
      const names = [...user.matchAll(/^【角色】([^（\n]+)/gm)].map((m) => m[1]!.trim());
      return {
        text: JSON.stringify({
          characters: names.map((name) => ({
            name,
            identity: `${name}的身份概括`,
            traits: [{ name: '侠义心', mutability: 'immutable' }],
            arc: `${name}的成长弧`,
            neverDo: '欺辱弱者',
          })),
        }),
      };
    }
    if (system.includes('设定档案整理器')) {
      counts.recall += 1;
      const paras = [...user.matchAll(/^【P(\d+)】(.*)$/gm)].map((m) => ({ p: Number(m[1]), text: m[2]!.replace(/……$/, '') }));
      if (paras.length < 2) return { text: '{"entries":[]}' };
      return {
        text: JSON.stringify({
          entries: [
            {
              name: '召回条目A',
              summary: '直接引用条目',
              paraRanges: [{ start: paras[0]!.p, end: paras[0]!.p + 1 }],
              quote: paras[0]!.text.slice(0, 10),
            },
            { name: '召回条目B', summary: '归纳条目', paraRanges: [{ start: paras[1]!.p, end: paras[1]!.p + 1 }] },
          ],
        }),
      };
    }
    if (system.includes('时间线标注器')) {
      counts.timeline += 1;
      const events = [...user.matchAll(/^(e\d+) \| 第\d+章 \| (.+)$/gm)].map((m) => ({ id: m[1]!, what: m[2]!.split('，')[0]! }));
      return {
        text: JSON.stringify({
          events: events.map((e, i) =>
            e.what.includes('回忆')
              ? { id: e.id, storyTimeLabel: '十年前的雨夜', timeOrder: 0, device: 'flashback' }
              : { id: e.id, storyTimeLabel: `第${i + 1}日`, timeOrder: i + 1 },
          ),
        }),
      };
    }
    if (system.includes('矛盾复核裁判')) {
      counts.review += 1;
      const ids = [...user.matchAll(/^(e\d+) \| /gm)].map((m) => m[1]!);
      return { text: JSON.stringify(ids.map((id) => ({ id, intentional: true }))) };
    }
    if (system.includes('计量打标器')) {
      // E10.3b W2 p3a：最小合法空标签（锚定核验零条目直落）。
      counts.labels += 1;
      return {
        text: JSON.stringify({
          hooks: [],
          transitions: [],
          emotionalBeats: [],
          plotPhase: null,
          highlightSpans: [],
          expositionSpans: [],
          arcBoundary: null,
        }),
      };
    }
    if (system.includes('书级读法报告')) {
      // E10.3b W4/W5 p5:book_reading：最小合法 markdown 报告。**必须先于 p4 分支判别**——P5
      // 各 kind 的 system 前置共用立场段（DECON_P4_STANCE_PROMPT 含「手艺层分析师」），后判
      // 会被 p4 分支吞掉计数与响应。
      counts.p5book += 1;
      return { text: '# 《全链拆解测试小说》拆书读法\n\n## 整体结构判定\n\n递进阶梯式。' };
    }
    if (system.includes('写章评')) {
      // E10.3b W5 p5:chapter_review：最小合法章评 markdown（先判同理）。
      counts.p5chapter += 1;
      return { text: '## 章导读\n\n本章落在行动解决环节。\n\n## 章收束\n\n钩子布设干脆。' };
    }
    if (system.includes('做细批')) {
      // E10.3b W5 p5:scene_annotation：最小合法细批 markdown（先判同理）。
      counts.p5scene += 1;
      return { text: '## 场景定位\n\n水潭边，古碑初现。' };
    }
    if (system.includes('手艺层分析师')) {
      // E10.3b W3b p4：章级取【P 行首引文；弧级取「引文」@P 窗口回放——锚定可过。
      counts.p4 += 1;
      const chapter = /【P(\d+)】(.+)/.exec(user);
      if (chapter !== null) {
        return {
          text: JSON.stringify({
            findings: [
              {
                insight: '开篇用人物情感钩立期待',
                elaboration: '钩子出现早且第二章即回收，间隔短密度高。',
                evidence: [{ paraRange: { start: Number(chapter[1]), end: Number(chapter[1]) + 1 }, quote: chapter[2]!.slice(0, 8) }],
                craftHint: null,
              },
            ],
            synthesis: '本章期待感建立快。',
          }),
        };
      }
      const arc = /「(.+?)」@P(\d+)–P(\d+)/.exec(user);
      if (arc !== null) {
        return {
          text: JSON.stringify({
            findings: [
              {
                insight: '弧级蓄放结构清晰',
                elaboration: '压与放的章距拿捏得当，爽点兑现密度稳定。',
                evidence: [{ paraRange: { start: Number(arc[2]), end: Number(arc[3]) + 1 }, quote: arc[1] }],
                craftHint: null,
              },
            ],
            synthesis: '本弧期待管理稳定。',
          }),
        };
      }
      return { text: JSON.stringify({ findings: [], synthesis: '' }) };
    }
    return { text: '{}' };
  };
}

function zeroCounts(): ChainMockCounts {
  return {
    classify: 0,
    facts: 0,
    adjudicate: 0,
    portrait: 0,
    recall: 0,
    timeline: 0,
    review: 0,
    labels: 0,
    p4: 0,
    p5book: 0,
    p5chapter: 0,
    p5scene: 0,
  };
}

/** 手动 resolve 门（在途管线挂起面——竞态族测试用）。 */
function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ── harness（IPC 工厂 + 后台管线 promise 捕获）──

let currentDerived = DERIVED;
const progressEvents: DeconProgressEvent[] = [];

function buildHandlers(counts: ChainMockCounts): { handlers: DeconIpcHandlers; pipelineDone: () => Promise<DeconPassSequenceResult> } {
  let done: Promise<DeconPassSequenceResult> = Promise.resolve({ status: 'done' });
  const handlers = createDeconIpcHandlers({
    runPipeline: (jobId) => {
      const p = runDeconPassSequence(
        jobId,
        {
          generateText: mkChainGenerate(counts),
          readDerivedText: () => currentDerived,
          notify: (event) => progressEvents.push(event), // P1b 逐章 running 面（CR-8——经 emit stamp elapsedMs）
          now: () => NOW,
        },
        (event) => progressEvents.push(event),
      );
      done = p;
      return p;
    },
    readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: sha(currentDerived) }),
    // CR-1 拍板 B：getDecon 章 label 装配注入（生产 readDeconDerivedTextFor 读 fs——测试零文件依赖）。
    readMaterialDerivedText: () => currentDerived,
    now: () => NOW,
    notify: (event) => progressEvents.push(event),
  });
  return { handlers, pipelineDone: () => done };
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

maybe('decon IPC 全链（P0→P2）', () => {
  let counts = zeroCounts();
  let handlers = buildHandlers(counts).handlers;
  let pipelineDone = buildHandlers(counts).pipelineDone;

  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
    currentDerived = DERIVED;
    progressEvents.length = 0;
    counts = zeroCounts();
    const built = buildHandlers(counts);
    handlers = built.handlers;
    pipelineDone = built.pipelineDone;
  });

  it('create→start→跑完：六域产物 + 词典 + 实体 + facts 齐全且锚定可验 + 进度事件序列 + 幻觉过滤', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.inheritedP1).toEqual({ p1a: false, p1b: false, p1c: false }); // CR-17 per-pass 旗标
    expect(created.estimate.byPass.p1a).toBeGreaterThan(0);
    expect(created.estimate.byPass.p2).toBeGreaterThan(0);

    const started = await handlers.startDecon({ jobId: created.job.jobId });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.noop).toBe(false);
    const result = await pipelineDone();
    expect(result.status).toBe('done');
    const jobId = created.job.jobId;

    // job 终态 done + cost 按 pass 记账。
    const detail = await handlers.getDecon({ jobId });
    expect(detail?.job.status).toBe('done');
    expect(detail?.fresh).toBe(true);
    // CR-1 拍板 B：章标标签表随 detail 载荷（chapterHeadings 单源——fixture 章 title '第N章'
    // 充当章标行，chapterShortLabel 解析出「第 N 章」零序号算术）。
    expect(detail?.chapterLabels).toEqual({ 0: '第 1 章', 1: '第 2 章', 2: '第 3 章' });
    const costByPass = detail?.job.cost.byPass ?? {};
    expect(costByPass.p1a?.calls).toBeGreaterThan(0);
    expect(costByPass.p1b?.calls).toBe(3);
    expect(costByPass.p1c?.calls).toBeGreaterThan(0);
    expect(costByPass.p2?.calls).toBeGreaterThan(0);
    // AC4：实际 cost 与预估同 pass 结构、同量级带内（fixture 规模实际 < 预估常量底座）。
    expect(detail?.job.cost.totalTokens).toBeGreaterThan(0);
    expect(detail?.job.cost.totalTokens).toBeLessThanOrEqual(created.estimate.totalTokens);
    for (const pass of Object.keys(costByPass)) {
      expect(created.estimate.byPass[pass]).toBeDefined();
    }

    // 进度事件序列：每 pass 相位级 running（unit=null——CR-8 后另有 p1b 逐章 unit 事件）+ 终态 done。
    // E10.3b W5：phases 接线后 coarse = A 四 pass + p3 计量 + p5:book_reading（闸门关——本用例
    // 测无闸路径；零手艺维无 p6）。
    const phaseEvents = progressEvents.filter((e) => e.status === 'running' && e.unit === null);
    expect(phaseEvents.map((e) => e.pass)).toEqual(['p1a', 'p1b', 'p1c', 'p2', 'p3a', 'p3b', 'p5:book_reading']);
    expect(progressEvents.at(-1)).toMatchObject({ jobId, status: 'done', pass: null });

    // 词典 + 实体 + facts 齐全。
    const dictionary = getDeconDictionary(MAT_REF, DERIVED_HASH);
    expect(dictionary).not.toBeNull();
    expect(dictionary!.entries.length).toBeGreaterThan(0);
    const factsRows = listDeconChapterFacts(MAT_REF, DERIVED_HASH);
    expect(factsRows).toHaveLength(3);
    expect(factsRows[1]?.facts.events[0]?.kernel).toBe(true);
    expect(factsRows[1]?.facts.foreshadowPlanted[0]?.hint).toBe('古碑来历不明');
    expect(factsRows[2]?.facts.infoGap[0]?.type).toBe('信息前置');
    const entities = listDeconEntities(MAT_REF, DERIVED_HASH);
    const zhao = entities.find((e) => e.canonicalName === '赵灵儿');
    expect(zhao?.aliases.sort()).toEqual(['灵儿', '赵灵兒']); // 别名归并（containment + LLM 裁决）
    expect(entities.find((e) => e.canonicalName === '幻影真人')?.audit.hallucinationFiltered).toBe(true); // 幻觉过滤

    // 六域 canon 产物 + 全锚定可验（章区间包含 + 切片非空）。
    const canon = listDeconCanonEntries(jobId);
    const domains = new Set(canon.map((e) => e.domain));
    expect(domains).toEqual(new Set(['world', 'rule', 'character', 'tone', 'timeline', 'relationship']));
    for (const entry of canon) {
      expect(entry.anchors.length).toBeGreaterThanOrEqual(1);
      for (const anchor of entry.anchors) {
        const chapter = FIXTURE.chapters[anchor.chapterIndex]!;
        expect(anchor.charStart).toBeGreaterThanOrEqual(chapter.charStart);
        expect(anchor.charEnd).toBeLessThanOrEqual(chapter.charEnd);
        expect(DERIVED.slice(anchor.charStart, anchor.charEnd).length).toBeGreaterThan(0);
      }
    }
    const timeline = canon.find((e) => e.domain === 'timeline');
    expect(timeline?.payload.consistency).toBe('intentional_loose'); // flashback 复核确认
    // get 回执含人审取数面（canon + 词典 + 实体 + 断点行）。
    expect(detail?.canon.length).toBe(canon.length);
    expect(detail?.dictionary?.entries.length).toBe(dictionary!.entries.length);
    expect(detail?.entities.length).toBe(entities.length);
    expect(detail?.passStates.length).toBeGreaterThan(0);
  });

  it('done→start 幂等 no-op（不重跑）+ 同指纹新 job P1 零重算（F-07 跨 job 继承）', async () => {
    const first = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await handlers.startDecon({ jobId: first.job.jobId });
    await pipelineDone();
    expect((await handlers.getDecon({ jobId: first.job.jobId }))?.job.status).toBe('done');

    // done→start：指纹一致 → 幂等 no-op 返回既有结果（不重跑）。
    const restart = await handlers.startDecon({ jobId: first.job.jobId });
    expect(restart.ok).toBe(true);
    if (restart.ok) expect(restart.noop).toBe(true);

    // 同指纹新 job：P1 三表继承（inheritedP1 per-pass 旗标全真 + 预估打折——byPass 无 p1a/p1b/p1c）。
    const second = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.inheritedP1).toEqual({ p1a: true, p1b: true, p1c: true });
    expect(second.estimate.byPass.p1a).toBeUndefined();
    expect(second.estimate.byPass.p1b).toBeUndefined();
    expect(second.estimate.byPass.p1c).toBeUndefined();
    expect(second.estimate.byPass.p2).toBeGreaterThan(0);

    const before = { ...counts };
    await handlers.startDecon({ jobId: second.job.jobId });
    const result = await pipelineDone();
    expect(result.status).toBe('done');
    // P1 零重算（mock 计数不变——只有 P2 各面新增调用；AC12 集成面）。
    expect(counts.classify).toBe(before.classify);
    expect(counts.facts).toBe(before.facts);
    expect(counts.adjudicate).toBe(before.adjudicate);
    expect(counts.portrait).toBeGreaterThan(before.portrait);
    expect((await handlers.getDecon({ jobId: second.job.jobId }))?.job.status).toBe('done');
    // pass_state：新 job 的 p1a/p1b/p1c 在 create 时即预标 done（继承）。
    const states = listDeconPassStates(second.job.jobId);
    expect(states.find((s) => s.pass === 'p1a')?.status).toBe('done');
    expect(states.filter((s) => s.pass === 'p1b')).toHaveLength(3);
  });

  it('capped 实测：小预算挂起 → start 带 budget 调预算续跑完成', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false, budget: { totalTokens: 1, perPass: {} } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await handlers.startDecon({ jobId });
    const first = await pipelineDone();
    expect(first.status).toBe('capped');
    expect((await handlers.getDecon({ jobId }))?.job.status).toBe('capped');
    expect(counts.classify).toBe(0); // 预算门前置不烧 token

    // start 通道 budget 字段生效（capped-hold 重入语义）。
    const resumed = await handlers.startDecon({ jobId, budget: { totalTokens: 100_000_000, perPass: {} } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.noop).toBe(false);
    const second = await pipelineDone();
    expect(second.status).toBe('done');
    expect((await handlers.getDecon({ jobId }))?.job.status).toBe('done');
    expect(listDeconCanonEntries(jobId).length).toBeGreaterThanOrEqual(6);
  });

  it('材料校对（派生 .md 变更）→ get 返回 stale + 产物面不供给', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await handlers.startDecon({ jobId });
    await pipelineDone();
    expect((await handlers.getDecon({ jobId }))?.job.status).toBe('done');

    currentDerived = `${DERIVED}（人工校对追加）`;
    const detail = await handlers.getDecon({ jobId });
    expect(detail?.job.status).toBe('stale');
    expect(detail?.fresh).toBe(false);
    expect(detail?.canon).toEqual([]); // stale 产物不静默供给（F-02 读侧半边）
    expect(detail?.dictionary).toBeNull();
  });

  it('W7 小补③：stale → confirm-rerun（刷新指纹 + 复位产物 + 自动 start）→ 续跑到 done', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await handlers.startDecon({ jobId });
    await pipelineDone();
    expect((await handlers.getDecon({ jobId }))?.job.status).toBe('done');
    const countsAfterFirst = { ...counts };
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(3); // 首跑产物在

    // 材料校对（派生 .md 变更）→ get 读侧翻 stale。
    currentDerived = `${DERIVED}（人工校对追加）`;
    expect((await handlers.getDecon({ jobId }))?.job.status).toBe('stale');

    // 守卫①：非 stale 态 → invalid-state（stale 不算在途——同材料可建第二 job 探针）。
    const guardJob = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(guardJob.ok).toBe(true);
    if (guardJob.ok) {
      const badState = await handlers.confirmRerunDecon({ jobId: guardJob.job.jobId });
      expect(badState.ok).toBe(false);
      if (!badState.ok) expect(badState.error).toBe('invalid-state');
    }
    // 守卫②：job 不存在 → not-found；坏参 → invalid-input。
    const missing = await handlers.confirmRerunDecon({ jobId: 'decon-0000000000fe' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('not-found');
    const badInput = await handlers.confirmRerunDecon({});
    expect(badInput.ok).toBe(false);
    if (!badInput.ok) expect(badInput.error).toBe('invalid-input');
    // 守卫③：材料已删（指纹读取面 null）→ material-not-found（job 保持 stale 不被半改）。
    const goneHandlers = createDeconIpcHandlers({ readCurrentFingerprints: () => null, now: () => NOW });
    const gone = await goneHandlers.confirmRerunDecon({ jobId });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error).toBe('material-not-found');
    expect(getDeconJob(jobId)?.status).toBe('stale'); // 确认失败无副作用

    // 主链：confirm-rerun → 刷新双指纹现值 + 复位产物 → 自动 start（后台管线重入）。
    const confirmed = await handlers.confirmRerunDecon({ jobId });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.job.status).toBe('running'); // 确认即续跑（pending→running 已转移）
    expect(getDeconJob(jobId)?.derivedHash).toBe(sha(currentDerived)); // 指纹刷新为材料现值
    const result = await pipelineDone();
    expect(result.status).toBe('done');
    expect((await handlers.getDecon({ jobId }))?.job.status).toBe('done');
    // P1 按新指纹重跑（材料级产物键控旧 hash——不复用；mock 计数回增）+ 产物复位后重落。
    expect(counts.classify).toBeGreaterThan(countsAfterFirst.classify);
    expect(counts.facts).toBe(countsAfterFirst.facts + 3);
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(3);
    // 读侧恢复供给（新指纹一致 → fresh）。
    const detail = await handlers.getDecon({ jobId });
    expect(detail?.fresh).toBe(true);
    expect(detail?.dictionary).not.toBeNull();
  });

  it('decon:delete per-job 级联：job/pass_state/canon 清 + 事实层三表材料级保留（F-07）', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await handlers.startDecon({ jobId });
    await pipelineDone();

    const removed = await handlers.deleteDecon({ jobId });
    expect(removed.ok).toBe(true);
    expect(await handlers.getDecon({ jobId })).toBeNull();
    expect(listDeconCanonEntries(jobId)).toEqual([]);
    expect(listDeconPassStates(jobId)).toEqual([]);
    // 材料级三表保留（新 job 仍可继承）。
    expect(getDeconDictionary(MAT_REF, DERIVED_HASH)).not.toBeNull();
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(3);
    expect(listDeconEntities(MAT_REF, DERIVED_HASH).length).toBeGreaterThan(0);
    const again = await handlers.deleteDecon({ jobId });
    expect(again.ok).toBe(false); // 已删 → not-found
  });

  it('cancel：pending 态取消终态 + list 过滤面', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    const cancelled = await handlers.cancelDecon({ jobId });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.job.status).toBe('cancelled');

    const list = await handlers.listDecon({ materialId: MAT_ID });
    expect(list.map((j) => j.jobId)).toContain(jobId);
    const all = await handlers.listDecon({});
    expect(all.map((j) => j.jobId)).toContain(jobId);
    // cancelled 后 start → invalid-state（重拆走新 job）。
    const restart = await handlers.startDecon({ jobId });
    expect(restart.ok).toBe(false);
    if (!restart.ok) expect(restart.error).toBe('invalid-state');
  });

  it('create 守卫：坏 tier 拒收 + 在途 job 拒收并指向在途 id（F-11）', async () => {
    const bad = await handlers.createDecon({ materialId: MAT_ID, tier: '豪华' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('invalid-input');

    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const inflight = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(inflight.ok).toBe(false);
    if (!inflight.ok) {
      expect(inflight.error).toBe('inflight-exists');
      expect(inflight.inflightJobId).toBe(created.job.jobId);
    }
  });

  it('materials:delete 级联四清接线：材料删除后拆书产物全表零残留', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await handlers.startDecon({ jobId });
    await pipelineDone();
    expect(listDeconCanonEntries(jobId).length).toBeGreaterThanOrEqual(6);

    const materialHandlers = createMaterialIpcHandlers({ notify: () => undefined });
    const removed = await materialHandlers.deleteMaterial({ materialId: MAT_ID });
    expect(removed.ok).toBe(true);

    expect(await handlers.getDecon({ jobId })).toBeNull();
    expect(getDeconDictionary(MAT_REF, DERIVED_HASH)).toBeNull();
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toEqual([]);
    expect(listDeconEntities(MAT_REF, DERIVED_HASH)).toEqual([]);
    expect(listDeconCanonEntries(jobId)).toEqual([]);
    expect((await handlers.listDecon({ materialId: MAT_ID })).length).toBe(0);
  });

  it('三档预估对照：deep ≥ fine ≥ coarse（同材料——AC9 启动前可见面的计算半边）', async () => {
    const stats = { chapterCount: FIXTURE.chapters.length, charCount: DERIVED.length };
    const p1None = { p1a: false, p1b: false, p1c: false };
    const coarse = estimateDeconCost({ tier: 'coarse', dimensions: [], stats, p1Reusable: p1None });
    const fine = estimateDeconCost({ tier: 'fine', dimensions: ['qidaigan'], stats, p1Reusable: p1None });
    const deep = estimateDeconCost({
      tier: 'deep',
      dimensions: ['huoke', 'qidaigan', 'jiegou', 'renshe', 'shijieguan', 'qingxu', 'wenbi', 'zaogeng', 'xinxicha', 'shijianzhou', 'fubi', 'duizhao'],
      stats,
      p1Reusable: p1None,
    });
    expect(deep.totalTokens).toBeGreaterThanOrEqual(fine.totalTokens);
    expect(fine.totalTokens).toBeGreaterThanOrEqual(coarse.totalTokens);
    expect(deep.byPass['p5:scene_annotation']).toBeGreaterThan(0);
  });

  // ── CR-1 在途竞态族（三锚点：在途 no-op 不双跑 / 假 running 对账重启 / 在途 delete 不复活）──

  /** 在途挂起版链 mock：首个 p1b facts 调用挂到 gate 放行（调用后挂——响应已就绪再等门）。 */
  function mkGatedChain(counts: ChainMockCounts, gate: Promise<void>): DeconGenerateText {
    const base = mkChainGenerate(counts);
    return async (input) => {
      const response = await base(input);
      if ((input.system ?? '').includes('事实层提取器')) await gate;
      return response;
    };
  }

  it('CR-1：管线在途时再 start → no-op 不重派（防双管线并发烧 LLM——runPipeline 计数）', async () => {
    const gate = deferredVoid();
    const localCounts = zeroCounts();
    let pipelineCalls = 0;
    let lastPipeline: Promise<DeconPassSequenceResult> = Promise.resolve({ status: 'done' });
    const localHandlers = createDeconIpcHandlers({
      runPipeline: (jobId) => {
        pipelineCalls += 1;
        lastPipeline = runDeconPassSequence(
          jobId,
          { generateText: mkGatedChain(localCounts, gate.promise), readDerivedText: () => currentDerived, now: () => NOW },
          (event) => progressEvents.push(event),
        );
        return lastPipeline;
      },
      readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: sha(currentDerived) }),
      now: () => NOW,
      notify: (event) => progressEvents.push(event),
    });
    const created = await localHandlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    const first = await localHandlers.startDecon({ jobId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.noop).toBe(false);
    expect(pipelineCalls).toBe(1);
    await vi.waitFor(() => expect(localCounts.facts).toBe(1)); // p1b 首调用已发起且挂起中（真在途）

    const again = await localHandlers.startDecon({ jobId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.noop).toBe(true); // 在途管线权威——no-op
    expect(pipelineCalls).toBe(1); // 未派第二条管线

    gate.resolve();
    await expect(lastPipeline).resolves.toMatchObject({ status: 'done' });
    expect((await localHandlers.getDecon({ jobId }))?.job.status).toBe('done');
  });

  it('CR-1：kill 残留假 running（注册表无项）→ 启动对账翻 paused → start 续跑（AC2 IPC 路径）', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    // 模拟 kill/崩溃残留：无在途管线但 status='running'（旧实现 start no-op → 永远打不开）。
    const jobRow = getDeconJob(jobId);
    expect(jobRow).not.toBeNull();
    if (jobRow === null) return;
    upsertDeconJob({ ...jobRow, status: 'running' });

    // 启动对账（main/index.ts whenReady 面）：running → paused（可续跑态）。
    expect(reconcileStaleDeconJobsOnStartup()).toBe(1);
    expect(getDeconJob(jobId)?.status).toBe('paused');

    const started = await handlers.startDecon({ jobId });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.noop).toBe(false); // paused → running 续跑（IPC 面走通）
    const result = await pipelineDone();
    expect(result.status).toBe('done');
    expect((await handlers.getDecon({ jobId }))?.job.status).toBe('done');
  });

  it('CR-1：会话内假 running（异常吞掉残留）→ start 对账翻 paused 重启（不依赖进程重启）', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    const jobRow = getDeconJob(jobId);
    expect(jobRow).not.toBeNull();
    if (jobRow === null) return;
    upsertDeconJob({ ...jobRow, status: 'running' }); // 注册表无项（无管线在途）= 假 running

    const started = await handlers.startDecon({ jobId });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.noop).toBe(false); // 对账翻 paused → start（旧实现此处 no-op 卡死）
    const result = await pipelineDone();
    expect(result.status).toBe('done');
  });

  it('CR-1：在途 delete——管线静默退出不复活行（cost 回写哨兵 + 级联不回滚出孤儿）', async () => {
    const gate = deferredVoid();
    const localCounts = zeroCounts();
    let lastPipeline: Promise<DeconPassSequenceResult> = Promise.resolve({ status: 'done' });
    const localHandlers = createDeconIpcHandlers({
      runPipeline: (jobId) => {
        lastPipeline = runDeconPassSequence(
          jobId,
          { generateText: mkGatedChain(localCounts, gate.promise), readDerivedText: () => currentDerived, now: () => NOW },
          (event) => progressEvents.push(event),
        );
        return lastPipeline;
      },
      readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: sha(currentDerived) }),
      now: () => NOW,
      notify: (event) => progressEvents.push(event),
    });
    const created = await localHandlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await localHandlers.startDecon({ jobId });
    await vi.waitFor(() => expect(localCounts.facts).toBe(1)); // p1b 首调用挂起中

    // 在途删除：注册表取消旗标 + 级联删行。
    const removed = await localHandlers.deleteDecon({ jobId });
    expect(removed.ok).toBe(true);
    gate.resolve();
    await expect(lastPipeline).resolves.toMatchObject({ status: 'cancelled' }); // 静默退出
    expect(await localHandlers.getDecon({ jobId })).toBeNull(); // 不复活
    expect(getDeconJob(jobId)).toBeNull(); // cost 回写哨兵未把 `?? job` 兜底行写回
    expect(listDeconPassStates(jobId)).toEqual([]); // 无孤儿 pass_state
  });

  it('CR-7：在途 cancel——runner 边界如实报 cancelled（非误报 paused），job 保持 cancelled 终态', async () => {
    const gate = deferredVoid();
    const localCounts = zeroCounts();
    let lastPipeline: Promise<DeconPassSequenceResult> = Promise.resolve({ status: 'done' });
    const localHandlers = createDeconIpcHandlers({
      runPipeline: (jobId) => {
        lastPipeline = runDeconPassSequence(
          jobId,
          { generateText: mkGatedChain(localCounts, gate.promise), readDerivedText: () => currentDerived, now: () => NOW },
          (event) => progressEvents.push(event),
        );
        return lastPipeline;
      },
      readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: sha(currentDerived) }),
      now: () => NOW,
      notify: (event) => progressEvents.push(event),
    });
    const created = await localHandlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await localHandlers.startDecon({ jobId });
    await vi.waitFor(() => expect(localCounts.facts).toBe(1)); // 章 0 调用挂起中

    const cancelled = await localHandlers.cancelDecon({ jobId });
    expect(cancelled.ok).toBe(true);
    gate.resolve();
    await expect(lastPipeline).resolves.toMatchObject({ status: 'cancelled' }); // 边界判别如实（旧实现误报 paused）
    expect(getDeconJob(jobId)?.status).toBe('cancelled'); // 终态保持（不被 runner 翻回）
    // progress 事件序列含 cancelled（如实报——无 paused 误报尾巴）。
    expect(progressEvents.some((e) => e.status === 'cancelled')).toBe(true);
    expect(progressEvents.filter((e) => e.status === 'paused')).toHaveLength(0);
  });

  it('CR-8：progress 事件带 elapsedMs + P1b 逐章 running unit 事件', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await handlers.startDecon({ jobId });
    await pipelineDone();
    const chapterEvents = progressEvents.filter((e) => e.status === 'running' && e.pass === 'p1b' && e.unit !== null);
    expect(chapterEvents.map((e) => e.unit)).toEqual(['0', '1', '2']); // 逐章 running（CR-8）
    for (const event of progressEvents) {
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0); // 全事件带 elapsedMs（stamped）
    }
  });

  // ── E10.3b W3b：人审闸门（拍板①——默认开、可关；确认即续跑零重付）──

  it('闸门默认开：create 初始化三行 pending；到点暂停→approve 续跑→零重付（coarse：craft 前置不空停）', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse' }); // 不带 reviewCheckpoints = 默认开
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(listDeconReviews(jobId).map((r) => r.checkpoint)).toEqual(['dictionary', 'canon', 'craft']);

    await handlers.startDecon({ jobId });
    let result = await pipelineDone();
    expect(result.status).toBe('paused'); // dictionary 闸门到点
    expect(getDeconJob(jobId)?.status).toBe('paused');
    expect(listDeconReviews(jobId).find((r) => r.checkpoint === 'dictionary')?.status).toBe('pending');
    // 进度事件注记「待人工确认」（review 行区分「等审暂停」与用户暂停；CR-10——note 软提示
    // 通道承载，error 留给真失败不污染诊断面）。
    expect(progressEvents.at(-1)?.status).toBe('paused');
    expect(progressEvents.at(-1)?.note).toContain('待人工确认');
    // F14：闸门 note 零内部 IPC 通道名泄漏（decon:approve-review 等——用户面只说确认后自动续跑）。
    expect(progressEvents.at(-1)?.note).not.toContain('decon:');
    expect(progressEvents.at(-1)?.error).toBeUndefined();

    const countsAfterP1 = { ...counts };
    const approvedDict = await handlers.approveDeconReview({ jobId, checkpoint: 'dictionary' });
    expect(approvedDict.ok).toBe(true);
    result = await pipelineDone();
    expect(result.status).toBe('paused'); // canon 闸门到点
    expect(listDeconReviews(jobId).find((r) => r.checkpoint === 'dictionary')?.status).toBe('approved');
    // P1 零重付（mock 计数不变——台账 skip 已 done pass；p2 属首次运行不在零重付面）。
    expect(counts.classify).toBe(countsAfterP1.classify);
    expect(counts.facts).toBe(countsAfterP1.facts);
    expect(counts.adjudicate).toBe(countsAfterP1.adjudicate);

    const approvedCanon = await handlers.approveDeconReview({ jobId, checkpoint: 'canon' });
    expect(approvedCanon.ok).toBe(true);
    result = await pipelineDone();
    expect(result.status).toBe('done'); // craft 前置不满足（coarse 零手艺维）→ 不空停
    expect(getDeconJob(jobId)?.status).toBe('done');
    // P1 仍零重付；p3 计量在 canon 确认后跑过。
    expect(counts.classify).toBe(countsAfterP1.classify);
    expect(counts.facts).toBe(countsAfterP1.facts);
    expect(counts.labels).toBe(3);
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(3);
    expect(getDeconProduct(jobId, 'p3b', 'arcs')).not.toBeNull();
    // 闸门行终态：dictionary/canon approved；craft 仍 pending（前置不满足未触发）。
    const byCp = new Map(listDeconReviews(jobId).map((r) => [r.checkpoint, r.status]));
    expect(byCp.get('dictionary')).toBe('approved');
    expect(byCp.get('canon')).toBe('approved');
    expect(byCp.get('craft')).toBe('pending');
  });

  it('craft 闸门（fine）：findings 在场 → 到点暂停；approve 后续跑完成', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    // 前两闸门预确认（本用例聚焦 craft 闸门——upsert 覆盖 pending）。
    for (const cp of ['dictionary', 'canon'] as const) {
      upsertDeconReview({ jobId, checkpoint: cp, status: 'approved', note: null, updatedAt: NOW.toISOString() });
    }
    await handlers.startDecon({ jobId });
    const result = await pipelineDone();
    expect(result.status).toBe('paused'); // p4:qidaigan 有 findings → craft 闸门触发
    expect(getDeconJob(jobId)?.status).toBe('paused');
    expect(counts.p4).toBe(4); // qidaigan 章×3 + 弧×1
    expect(listDeconProducts(jobId, 'p4:qidaigan')).toHaveLength(4);
    expect(listDeconReviews(jobId).find((r) => r.checkpoint === 'craft')?.status).toBe('pending');

    const countsBeforeApprove = { ...counts };
    const approved = await handlers.approveDeconReview({ jobId, checkpoint: 'craft' });
    expect(approved.ok).toBe(true);
    const final = await pipelineDone();
    expect(final.status).toBe('done');
    expect(getDeconJob(jobId)?.status).toBe('done');
    // 确认续跑零重付（P4 不重调）。
    expect(counts.p4).toBe(countsBeforeApprove.p4);
    // E10.3b W5 phases 接线：fine 续跑段 = book_reading + chapter_review×3 + p6（零候选诚实完成）。
    expect(counts.p5book).toBe(1);
    expect(counts.p5chapter).toBe(3);
    const detail = await handlers.getDecon({ jobId });
    expect(detail?.reportCounts).toEqual({ book_reading: 1, chapter_review: 3 });
    expect(listDeconReviews(jobId).find((r) => r.checkpoint === 'craft')?.status).toBe('approved');
  });

  it('approve-review 守卫：坏 checkpoint / 不存在 job / 双重确认', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    const bad = await handlers.approveDeconReview({ jobId, checkpoint: '词典' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('invalid-input');
    const missing = await handlers.approveDeconReview({ jobId: 'decon-0000000000ff', checkpoint: 'canon' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('not-found');

    // 双重确认：pending → approved 后再 approve → invalid-state。approve 即 start 续跑
    // （后台管线排空到下一闸门——此处 await 排空避免悬挂 promise）。
    const approvedOnce = await handlers.approveDeconReview({ jobId, checkpoint: 'dictionary' });
    expect(approvedOnce.ok).toBe(true);
    const approvedTwice = await handlers.approveDeconReview({ jobId, checkpoint: 'dictionary' });
    expect(approvedTwice.ok).toBe(false);
    if (!approvedTwice.ok) expect(approvedTwice.error).toBe('invalid-state');
    await pipelineDone();
  });

  it('off 闸门（reviewCheckpoints:false）：三行 off + 不空停全程 done + approve 拒 invalid-state', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(listDeconReviews(jobId).map((r) => [r.checkpoint, r.status])).toEqual([
      ['dictionary', 'off'],
      ['canon', 'off'],
      ['craft', 'off'],
    ]);
    const result = await (async () => {
      await handlers.startDecon({ jobId });
      return pipelineDone();
    })();
    expect(result.status).toBe('done'); // 闸门全关——无暂停直通
    expect(getDeconJob(jobId)?.status).toBe('done');
    const offApprove = await handlers.approveDeconReview({ jobId, checkpoint: 'dictionary' });
    expect(offApprove.ok).toBe(false);
    if (!offApprove.ok) expect(offApprove.error).toBe('invalid-state');
  });

  // ── E10.3b W5：读面 handler（products/reports + get 回执 reviews/reportCounts + freshness 门）──

  it('W5 读面：products 投影与过滤 + reports meta 列表/单取 + get reviews/reportCounts + stale 门', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    await handlers.startDecon({ jobId });
    await pipelineDone();
    expect(counts.p5book).toBe(1); // phases 接线：coarse 含 p5:book_reading

    // products：全量投影（p3a×3 + p3b×2——findings/p3 产物行）+ pass/unit 过滤。
    const all = await handlers.productsDecon({ jobId });
    expect(all.fresh).toBe(true);
    expect(all.products.filter((p) => p.pass === 'p3a')).toHaveLength(3);
    expect(all.products.filter((p) => p.pass === 'p3b')).toHaveLength(2);
    const filtered = await handlers.productsDecon({ jobId, pass: 'p3a', unit: '0' });
    expect(filtered.products).toHaveLength(1);
    expect(filtered.products[0]!.pass).toBe('p3a');
    // 不存在的 job / 缺 jobId → 诚实空态（fresh=true + 空集）。
    expect((await handlers.productsDecon({ jobId: 'decon-0000000000ee' })).products).toEqual([]);

    // reports：列表只回 meta（无 contentMd）；单取回全文。
    const list = await handlers.reportsDecon({ jobId });
    expect(list.fresh).toBe(true);
    expect(list.report).toBeNull();
    expect(list.list.map((m) => `${m.kind}:${m.unit}`)).toEqual(['book_reading:all']);
    expect(list.list[0]).not.toHaveProperty('contentMd');
    const single = await handlers.reportsDecon({ jobId, kind: 'book_reading', unit: 'all' });
    expect(single.report).not.toBeNull();
    expect(single.report!.contentMd).toContain('拆书读法');
    const missKind = await handlers.reportsDecon({ jobId, kind: 'chapter_review', unit: 'ch:0' });
    expect(missKind.report).toBeNull(); // coarse 无章评

    // get 回执 additive：闸门行三行 off + reportCounts（kind → 行数）。
    const detail = await handlers.getDecon({ jobId });
    expect(detail?.reviews?.map((r) => [r.checkpoint, r.status])).toEqual([
      ['dictionary', 'off'],
      ['canon', 'off'],
      ['craft', 'off'],
    ]);
    expect(detail?.reportCounts).toEqual({ book_reading: 1 });

    // freshness 门：材料校对（派生 .md 变更）→ products/reports 不供给（stale + 空集）。
    currentDerived = `${DERIVED}（人工校对追加）`;
    const staleProducts = await handlers.productsDecon({ jobId });
    expect(staleProducts.fresh).toBe(false);
    expect(staleProducts.freshReason).toBe('stale');
    expect(staleProducts.products).toEqual([]);
    const staleReports = await handlers.reportsDecon({ jobId });
    expect(staleReports.fresh).toBe(false);
    expect(staleReports.list).toEqual([]);
    expect(staleReports.report).toBeNull();
  });

  it('CR-8：products passStem 前缀过滤（p4 匹配全部 p4:<dim> 含 p4:style——排除逻辑留 UI）', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    // 种子 product 行（p3a 空标签 / p4 手艺维 findings / p4:style 14 节 payload——写侧 zod 门过）。
    const emptyLabels = {
      hooks: [],
      transitions: [],
      emotionalBeats: [],
      plotPhase: null,
      highlightSpans: [],
      expositionSpans: [],
      arcBoundary: null,
    };
    const minStyle = {
      sections: {
        voice: '冷静克制。',
        stats: '句长均值 18 字。',
        excerpt: '```text\n风格测试第一章正文，句子平实。\n```',
        appendix: '来源：《全链拆解测试小说》。',
      },
      excerptAnchors: [{ chapterIndex: 0, charStart: 0, charEnd: 12, paraStart: 0, paraEnd: 1 }],
      bookTitle: '全链拆解测试小说',
      materialId: MAT_ID,
    };
    expect(upsertDeconProduct({ jobId, pass: 'p3a', unit: '0', payload: emptyLabels, updatedAt: NOW.toISOString() })).toBe(true);
    expect(upsertDeconProduct({ jobId, pass: 'p4:huoke', unit: 'ch:0', payload: { findings: [], synthesis: '' }, updatedAt: NOW.toISOString() })).toBe(true);
    expect(upsertDeconProduct({ jobId, pass: 'p4:style', unit: 'all', payload: minStyle, updatedAt: NOW.toISOString() })).toBe(true);

    // passStem='p4'：命中全部 p4:<dim> 行（含 p4:style——通道层不做维内裁剪，排除归 UI）。
    const p4 = await handlers.productsDecon({ jobId, passStem: 'p4' });
    expect(p4.fresh).toBe(true);
    expect(p4.products.map((p) => p.pass).sort()).toEqual(['p4:huoke', 'p4:style']);
    // passStem='p3'：跨后缀前缀命中（p3a——旧 pass 精确匹配无法表达的形态）。
    const p3 = await handlers.productsDecon({ jobId, passStem: 'p3' });
    expect(p3.products.map((p) => p.pass)).toEqual(['p3a']);
    // pass 精确 + passStem 同传 = AND（两过滤叠加）。
    const combined = await handlers.productsDecon({ jobId, pass: 'p4:huoke', passStem: 'p4' });
    expect(combined.products.map((p) => p.pass)).toEqual(['p4:huoke']);
    // 无命中茎 = 诚实空态（非错误）。
    const none = await handlers.productsDecon({ jobId, passStem: 'p9' });
    expect(none.fresh).toBe(true);
    expect(none.products).toEqual([]);
  });

  it('CR-12：闸门行初始化中途失败 → 回滚 job 行 + operation-failed（不留无闸门 job）', async () => {
    // 中途失败：dictionary 行落库（真实现）、canon 行抛（闸门检查把缺行当 legacy 照跑——
    // 不回滚 = 用户开的闸门静默失效）。
    const realUpsert = closureDeconDb.upsertDeconReview;
    const spy = vi
      .spyOn(closureDeconDb, 'upsertDeconReview')
      .mockImplementationOnce(realUpsert)
      .mockImplementationOnce(() => {
        throw new Error('review 表写坏（模拟中途失败）');
      });
    const before = await handlers.listDecon({ materialId: MAT_ID });
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse' });
    spy.mockRestore();

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).toBe('operation-failed');
      expect(created.message).toContain('闸门行初始化失败');
    }
    // job 行回滚零残留（per-job 级联含 review 行——无闸门 job 不留）。
    const after = await handlers.listDecon({ materialId: MAT_ID });
    expect(after).toEqual(before);
    // 回滚后同材料再 create 照常成功（无残留 job 挡路）。
    const retry = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(retry.ok).toBe(true);
  });

  it('CR-24：reports 坏 kind 串显式拒收（invalid-input——不静默降级全列表）', async () => {
    const created = await handlers.createDecon({ materialId: MAT_ID, tier: 'coarse', reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    // 种子一行合法报告（好 kind 路径对照）。
    expect(
      upsertDeconReport({ jobId, kind: 'book_reading', unit: 'all', contentMd: '# 拆书读法\n\n递进阶梯式。', anchors: [], dimension: null, updatedAt: NOW.toISOString() }),
    ).toBe(true);

    // 坏 kind 单取：显式 invalid-input（旧实现静默降级 list 形态回全列表）。
    const badSingle = await handlers.reportsDecon({ jobId, kind: '读法', unit: 'all' });
    expect(badSingle.error).toBe('invalid-input');
    expect(badSingle.message).toContain('读法');
    expect(badSingle.list).toEqual([]);
    expect(badSingle.report).toBeNull();
    // 坏 kind 列表模式同拒（kind 过滤面不吞坏串）。
    const badList = await handlers.reportsDecon({ jobId, kind: '读法' });
    expect(badList.error).toBe('invalid-input');
    expect(badList.list).toEqual([]);
    // 合法 kind 照常（列表过滤 + 单取全文）。
    const goodList = await handlers.reportsDecon({ jobId, kind: 'book_reading' });
    expect(goodList.error).toBeUndefined();
    expect(goodList.list.map((m) => m.kind)).toEqual(['book_reading']);
    const goodSingle = await handlers.reportsDecon({ jobId, kind: 'book_reading', unit: 'all' });
    expect(goodSingle.error).toBeUndefined();
    expect(goodSingle.report?.contentMd).toContain('拆书读法');
  });
});

// ── E10.3b W3b/W5：维度×档位序列矩阵（buildDeconPhaseSteps 纯函数——design §9 权威序）──

describe('buildDeconPhaseSteps（phases 动态化矩阵）', () => {
  const passLabels = (dims: readonly string[], tier?: 'coarse' | 'fine' | 'deep'): string[] =>
    buildDeconPhaseSteps(dims, tier)
      .filter((s): s is Extract<DeconPhaseStep, { kind: 'pass' }> => s.kind === 'pass')
      .map((s) => s.pass);
  const gateCheckpoints = (dims: readonly string[]): string[] =>
    buildDeconPhaseSteps(dims)
      .filter((s): s is Extract<DeconPhaseStep, { kind: 'gate' }> => s.kind === 'gate')
      .map((s) => s.checkpoint);
  const A_TAIL = ['p1a', 'p1b', 'p1c', 'p2', 'p3a', 'p3b'];

  it('coarse（零维）= A 四 pass + p3 计量 + p5:book_reading（无章评无 p6）+ 三闸门插点', () => {
    expect(passLabels([], 'coarse')).toEqual([...A_TAIL, 'p5:book_reading']);
    expect(gateCheckpoints([])).toEqual(['dictionary', 'canon', 'craft']);
    // 闸门插位：p1c 后 / p2 后 / craft 后接 P5。
    const kinds = buildDeconPhaseSteps([], 'coarse').map((s) => (s.kind === 'gate' ? `gate:${s.checkpoint}` : s.pass));
    expect(kinds.indexOf('gate:dictionary')).toBe(3); // p1a,p1b,p1c 之后
    expect(kinds.indexOf('gate:canon')).toBe(5); // p2 之后
    expect(kinds.indexOf('gate:craft')).toBe(8); // p3a,p3b 之后
    expect(kinds.at(-1)).toBe('p5:book_reading');
  });

  it('coarse+style = p4:style + p5:book_reading（零手艺维无 p4 复合步、无 p6）', () => {
    expect(passLabels(['style'], 'coarse')).toEqual([...A_TAIL, 'p4:style', 'p5:book_reading']);
  });

  it('fine（手艺维 + style）= 手艺维序逐维 + style 殿后 + book_reading + chapter_review + p6', () => {
    expect(passLabels(['qidaigan', 'qingxu', 'style'], 'fine')).toEqual([
      ...A_TAIL,
      'p4:qidaigan',
      'p4:qingxu',
      'p4:style',
      'p5:book_reading',
      'p5:chapter_review',
      'p6',
    ]);
  });

  it('deep 全 12 手艺维 + style 可选 + 三 P5 kind；用户序 style 在前也殿后（design §9 style 排末）', () => {
    const all12 = [
      'huoke', 'qidaigan', 'jiegou', 'renshe', 'shijieguan', 'qingxu',
      'wenbi', 'zaogeng', 'xinxicha', 'shijian', 'fubi', 'duizhao',
    ];
    expect(passLabels(all12, 'deep')).toEqual([
      ...A_TAIL,
      ...all12.map((d) => `p4:${d}`),
      'p5:book_reading',
      'p5:chapter_review',
      'p5:scene_annotation',
      'p6',
    ]);
    expect(passLabels(['style', 'fubi'], 'fine')).toEqual([...A_TAIL, 'p4:fubi', 'p4:style', 'p5:book_reading', 'p5:chapter_review', 'p6']);
  });

  it('tier 缺省（删行竞态）= coarse 下限（book_reading 无章评）——首 runner 运行门如实 cancelled', () => {
    expect(passLabels(['qidaigan'], undefined)).toEqual([...A_TAIL, 'p4:qidaigan', 'p5:book_reading', 'p6']);
  });
});
