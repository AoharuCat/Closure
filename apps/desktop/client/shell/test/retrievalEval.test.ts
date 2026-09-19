import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChapterStateSummary, ResolvedModel } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S8：fiction eval 集 smoke（design §6b / prd AC-8）——框架端到端跑通断言，
// 不产真实结论（真实 eval 集 dogfood 填）。mirror retrievalScale.test.ts 全套模式：
// 确定性合成（seeded LCG）/ stub embed 簇结构（同簇近 / 异簇远 → 已知 ground-truth 最近邻）/
// Electron-as-Node 真跑 + ABI gate skip / throwaway TEST_HOME / 零网络（modelGateway mock 兜
// 默认路径——误走真端点即响亮失败）。
//
// fixture：3 章 + 3 卡 + 3 章摘要行，全部经真索引器落库（reindexChapter /
// reindexChapterSummaryEntry / reindexAssetCards）。簇标记（唯一 token → 专属簇心）：
//   - `簇章002` 只出现在第 2 章一个段落 → 该章唯一含标记 chunk 独占簇 ch:002；
//   - `簇卡K0` 只在 eval-card-0 拼料 → 卡独占簇 card:K0；
//   - `簇摘001` 只在 ep-001 摘要行出场角色名 → 摘要行独占簇 sum:001。
// 每个「应命中」case 的查询词同时拿 FTS 唯一命中（rn=1）+ vec 簇心 exact（rn=1）→ RRF 双臂
// 2/61 稳居 rank 1——手算锚：recall@5 = 3/4 = 0.75，MRR = (1+1+1+0)/4 = 0.75。
//
// evals/ 布置：retrieval.yaml（4 case）+ broken.yaml（1 坏条目：expected 空）+ work/zz-nested.yaml
//（跨文件重复 id——顺带断言递归扫描 + 去重；⚠️ 命名须排在 retrieval.yaml 之后：runner 按排序路径
// 处理、重复 id 保先到，排前的重复份会反客为主改写期望锚）。→ caseCount 4 / skippedCases 2。
//
// Electron-as-Node 真跑（better-sqlite3 按 Electron ABI 重建，plain-Node vitest 下本 suite 会被
// ABI gate skip）：
//   cd apps/desktop/client/shell
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/retrievalEval.test.ts
// ─────────────────────────────────────────────────────────────────────────────

// Registry 指向 throwaway home——真 ~/.orison 永不被碰（mirror retrievalScale / worldStateScale）。
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-retrieval-eval');
const PROJECT_DIR = path.join(TEST_HOME, 'eval-proj');

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
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));
// loadProject mock（mirror retrievalScale）：episode↔chapter 映射 + asset_cards 都在合成 DOC 上锚定。
const { loadProject } = vi.hoisted(() => ({ loadProject: vi.fn() }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import { closeDb, getDb } from '../main/db/index';
import { reindexChapter } from '../main/db/chapterChunkIndexer';
import { reindexChapterSummaryEntry } from '../main/db/chapterSummaryIndexer';
import { reindexAssetCards } from '../main/db/assetCardsIndexer';
import { type RetrievalDeps } from '../main/db/closureRetrieval';
import { evalSetFromYaml, listEvalFiles, runRetrievalEval } from '../main/db/retrievalEval';
import { EMBED_DIM } from '../main/db/closureIndexer';
import { upsertChapterSummary } from '../main/db/worldStateRepository';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { ensureProject, getProject } from '../main/db/projectRepository';

// better-sqlite3 ABI gate（mirror retrievalScale）：plain-Node vitest 下原生 addon ABI 不匹配时
// skip 而非 fail。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

// ── 确定性合成文本（seeded LCG + 唯一簇标记，mirror retrievalScale 词池形态）──

const EPISODES = 3;
const LCG_SEED = 0x5eed_ea01;

const WORDS = [
  '孤城', '钟声', '旧约', '血债', '渡鸦', '集市', '王座', '密信', '雨夜', '掌柜',
  '玉珏', '灯笼', '更夫', '码头', '盐商', '镖师',
] as const;
const ENDERS = ['。', '。', '！', '？', '…'] as const;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashString(text: string): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193) >>> 0;
  }
  return h >>> 0;
}

function buildSentence(rng: () => number, minChars: number, maxChars: number): string {
  let out = '';
  while (out.length < minChars) out += WORDS[Math.floor(rng() * WORDS.length)]!;
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out + ENDERS[Math.floor(rng() * ENDERS.length)]!;
}

function buildParagraph(rng: () => number, targetLen: number): string {
  const parts: string[] = [];
  let len = 0;
  while (len < targetLen) {
    const s = buildSentence(rng, 8, 24);
    parts.push(s);
    len += s.length;
  }
  return parts.join('');
}

const episodeId = (i: number): string => `ep-${String(i).padStart(3, '0')}`;
const chapterId = (i: number): string => `ch_${String(i).padStart(3, '0')}`;

/** 章正文（~900 字：标题 + 9 段 60-150 字；第 2 章第 2 段是簇章002 标记段）。 */
function genChapter(i: number): string {
  const rng = makeRng((LCG_SEED ^ Math.imul(i + 1, 0x9e37_77b9)) >>> 0);
  const blocks = [`# 第${i + 1}章 夜雨旧约`];
  for (let p = 0; p < 9; p++) {
    if (i === 2 && p === 2) {
      blocks.push('此章记号：簇章002，更夫只在雨夜里提过一次便再没开过口。');
      continue;
    }
    blocks.push(buildParagraph(rng, 60 + Math.floor(rng() * 90)));
  }
  return blocks.join('\n\n');
}

/** 章梗概（无簇标记——摘要行不进章簇；chunk prefix 带它但同样无标记，簇归属只由正文段决定）。 */
function synopsisFor(i: number): string {
  return `第${i + 1}章梗概：夜雨里旧约的线索再度浮出水面，临查访当铺的来路。`;
}

function summaryFor(i: number): ChapterStateSummary {
  return {
    episodeId: episodeId(i),
    episodeIndex: i,
    storyTimeStart: i * 100 + 5,
    storyTimeEnd: i * 100 + 10,
    // ep-001 的出场角色名带唯一簇标记——只进该章摘要行拼料（「出场角色：…」段）。
    characterEndStates: [
      {
        subjectId: 'hero-01',
        name: i === 1 ? '孤客簇摘001' : '临',
        type: 'character',
        state: { '/mood': '疑' },
      },
    ],
    oracleDormant: [],
    relationshipChanges: [],
    foreshadowChanges: [],
    newEntities: [],
    openPromises: [],
    nextChapterPayoffs: [],
    truncated: false,
    synopsis: synopsisFor(i),
  };
}

interface FixtureCard {
  id: string;
  type: string;
  name: string;
  summary: string;
  status: string;
}

const CARDS: FixtureCard[] = [
  { id: 'eval-card-0', type: 'character', name: '守夜人甲', summary: '当铺守夜人的来历与夜行习性。簇卡K0。', status: 'draft' },
  { id: 'eval-card-1', type: 'location', name: '城南当铺', summary: '一间只收夜货的老当铺。', status: 'active' },
  { id: 'eval-card-2', type: 'prop', name: '铁盒', summary: '一只上了三道锁的铁盒。', status: 'draft' },
];

// ── embed stub（簇结构——mirror retrievalScale 形态：标记 → 专属簇心 + 文本 hash 噪声）──

const centroidCache = new Map<string, number[]>();
function centroid(key: string): number[] {
  let c = centroidCache.get(key);
  if (c === undefined) {
    const rng = makeRng(hashString(key));
    c = Array.from({ length: EMBED_DIM }, () => (rng() < 0.5 ? -1 : 1));
    centroidCache.set(key, c);
  }
  return c;
}

function noiseVec(seedKey: string, scale: number): number[] {
  const rng = makeRng(hashString(seedKey));
  return Array.from({ length: EMBED_DIM }, () => (rng() * 2 - 1) * scale);
}

function vecNear(clusterKey: string, text: string, noiseScale: number): number[] {
  const nz = noiseVec(text, noiseScale);
  return centroid(clusterKey).map((v, i) => v + nz[i]!);
}

const MARKER_CHAPTER = /簇章(\d{3})/;
const MARKER_SUMMARY = /簇摘(\d{3})/;
const MARKER_CARD = /簇卡(K\d)/;

/**
 * 索引/查询共用：文本含唯一簇标记 → 专属簇心 + 小噪声（同簇 cos 距离 ~0.001）；无标记 → 纯噪声
 * （0.3——与一切簇心距离 ~1.0，miss 查询的形态）。查询词与目标文档共享标记 → 查询向量 ≈ 目标簇心
 * （exact），FTS 唯一命中 + vec rn=1 → 双臂 rank 1 确定。
 */
function stubVec(text: string): number[] {
  const ch = text.match(MARKER_CHAPTER);
  if (ch !== null) return vecNear(`ch:${ch[1]}`, text, 0.05);
  const sm = text.match(MARKER_SUMMARY);
  if (sm !== null) return vecNear(`sum:${sm[1]}`, text, 0.05);
  const cd = text.match(MARKER_CARD);
  if (cd !== null) return vecNear(`card:${cd[1]}`, text, 0.05);
  return noiseVec(text, 0.3);
}

function stubModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'text-embedding-3-test',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:0',
    apiKey: 'stub',
    capability: 'embedding',
  };
}

let queryEmbedCalls = 0; // 零网络断言：runner 恰好每 case 一次 stub embed，无其它网络面

// ── describe 级共享 ──

let PID: string | undefined;
let chapter2Length = 0;

function clean(): void {
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

describe.skipIf(!sqliteUsable)('retrievalEval — fiction eval 框架合成 smoke（Story 8.3 S8）', () => {
  beforeAll(
    async () => {
      clean();
      mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
      mkdirSync(path.join(PROJECT_DIR, 'chapters'), { recursive: true });
      getDb();
      // vec 扩展是检索链核心对象：Electron 真跑下缺失 = 打包回归，响亮失败（mirror retrievalScale）。
      expect(isSqliteVecAvailable()).toBe(true);

      ensureProject({
        name: 'EvalFixture',
        type: 'novel',
        localFingerprint: path.resolve(PROJECT_DIR),
        path: path.resolve(PROJECT_DIR),
      });
      PID = getProject(path.resolve(PROJECT_DIR))!.projectId;
      loadProject.mockReturnValue({
        episode_outlines: Array.from({ length: EPISODES }, (_, i) => ({ id: episodeId(i), index: i })),
        novel: { chapters: Array.from({ length: EPISODES }, (_, i) => ({ id: chapterId(i), sort_order: i })) },
        asset_cards: CARDS,
      });

      const chapterDeps = {
        resolveModel: () => stubModel(),
        embedBatch: async (_m: ResolvedModel, texts: string[]) => texts.map(stubVec),
      };

      // 章文件 + 摘要行 + chunk 索引 + 摘要检索行（摘要先行——reindexChapter 的 prefix 组料读它）。
      for (let i = 0; i < EPISODES; i++) {
        const text = genChapter(i);
        if (i === 2) chapter2Length = text.length;
        writeFileSync(path.join(PROJECT_DIR, 'chapters', `${chapterId(i)}.md`), text, 'utf-8');
        upsertChapterSummary(PID!, {
          episodeId: episodeId(i),
          episodeIndex: i,
          storyTimeEnd: i * 100 + 10,
          summary: summaryFor(i),
          tokenEstimate: 120,
          truncated: false,
          patchRowidHigh: 0,
        });
        const res = await reindexChapter(PID!, PROJECT_DIR, chapterId(i), chapterDeps);
        expect(res.outcome).toBe('written');
        expect(res.chunkCount).toBeGreaterThan(0);
        await reindexChapterSummaryEntry(PID!, PROJECT_DIR, episodeId(i), chapterDeps);
      }

      // 卡（真索引器；marker 经 summary 进 body 拼料）。
      const cardReport = await reindexAssetCards(path.resolve(PROJECT_DIR), {
        resolveModel: () => stubModel(),
        embed: async (_m: ResolvedModel, body: string) => stubVec(body),
      });
      expect(cardReport.reindexed).toBe(CARDS.length);

      // 语料 sanity：三面齐（缺任何一面都会让下游命中断言假失败）。
      const db = getDb();
      const chapterRows = (
        db
          .prepare("SELECT COUNT(*) AS n FROM closure_entry WHERE project_id=? AND source_kind='chapter'")
          .get(PID!) as { n: number }
      ).n;
      expect(chapterRows).toBeGreaterThanOrEqual(EPISODES);
      const summaryRows = (
        db
          .prepare("SELECT COUNT(*) AS n FROM closure_entry WHERE project_id=? AND source_kind='chapter_summary'")
          .get(PID!) as { n: number }
      ).n;
      expect(summaryRows).toBe(EPISODES);
      const cardRows = (
        db
          .prepare("SELECT COUNT(*) AS n FROM closure_entry WHERE project_id=? AND source_kind='setting_card'")
          .get(PID!) as { n: number }
      ).n;
      expect(cardRows).toBe(CARDS.length);

      // 评估集布置：主集（4 case）+ 坏条目文件 + 子目录重复 id 文件（递归扫描 + 去重断言面）。
      // entryId 值含 ':' 与 '#'——yaml 引号包裹最稳（照抄给作者也无坑）。
      const mainYaml = `cases:
  - id: chapter-plot
    query: 簇章002
    expected:
      - chapterId: ch_002
        charSpan: [0, ${chapter2Length}]
    note: 按剧情记号查正文段（章级锚 + 全章区间加分）
  - id: card-entity
    query: 簇卡K0
    expected:
      - entryId: eval-card-0
  - id: summary-cast
    query: 簇摘001
    expected:
      - entryId: "${PID}:ep-001#summary"
  - id: deliberate-miss
    query: 簇缺999
    expected:
      - chapterId: ch_999
    note: 故意 miss——防 recall 虚高
`;
      mkdirSync(path.join(PROJECT_DIR, 'evals', 'work'), { recursive: true });
      writeFileSync(path.join(PROJECT_DIR, 'evals', 'retrieval.yaml'), mainYaml, 'utf-8');
      writeFileSync(
        path.join(PROJECT_DIR, 'evals', 'broken.yaml'),
        'cases:\n  - id: broken-empty-expected\n    query: 缺期望的坏条目\n    expected: []\n',
        'utf-8',
      );
      writeFileSync(
        path.join(PROJECT_DIR, 'evals', 'work', 'zz-nested.yaml'),
        'cases:\n  - id: card-entity\n    query: 簇卡K0\n    expected:\n      - entryId: eval-card-1\n',
        'utf-8',
      );
    },
    60_000,
  );

  afterAll(() => {
    clean();
  });

  it('evalSetFromYaml：合法 yaml 解析 + BOM 容忍 + yaml 语法坏 → null（整文件级，runner 计 skippedFiles）', () => {
    const parsed = evalSetFromYaml('cases:\n  - id: a\n    query: q\n    expected:\n      - entryId: e\n');
    expect(parsed?.cases).toHaveLength(1);
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.cases[0]).toMatchObject({ id: 'a', query: 'q' });

    // BOM（Windows 编辑器）先剥再 load——用码点拼接，不写字面 BOM 字符（mirror settingMd 惯例）。
    const bom = evalSetFromYaml(
      String.fromCharCode(0xfeff) + 'cases:\n  - id: b\n    query: q\n    expected:\n      - chapterId: ch_1\n',
    );
    expect(bom?.cases).toHaveLength(1);

    expect(evalSetFromYaml('cases: [unclosed')).toBeNull();
  });

  it('listEvalFiles：递归枚举（子目录 evals/work/ 也入列，分档文件不静默忽略）', () => {
    const files = listEvalFiles(PROJECT_DIR);
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith(path.join('work', 'zz-nested.yaml')))).toBe(true);
    expect(listEvalFiles(path.join(TEST_HOME, 'no-such-project'))).toEqual([]);
  });

  it(
    'runRetrievalEval：4 case 手算锚 recall@5=0.75 / MRR=0.75 + perCase 结构 + 容错计数 + DI stub 零网络',
    async () => {
      const deps: RetrievalDeps = {
        resolveModel: () => stubModel(),
        embed: async (_m: ResolvedModel, text: string) => {
          queryEmbedCalls += 1;
          return stubVec(text);
        },
        resolveRerankModel: () => null,
      };
      const report = await runRetrievalEval(PID!, PROJECT_DIR, {}, deps);
      expect(report.ok).toBe(true);
      expect(report.ran).toBe(true);
      if (!report.ok || !report.ran) throw new Error('eval should have run');

      // 容错计数：1 坏条目（expected 空）+ 1 跨文件重复 id（work/zz-nested.yaml 的 card-entity）。
      expect(report.run.caseCount).toBe(4);
      expect(report.run.skippedCases).toBe(2);
      expect(report.run.skippedFiles).toBe(0);
      expect(report.run.k).toBe(5);
      // 只有供出 case 的文件入列（broken/nested 全被跳过）。
      expect(report.run.files).toEqual([
        path.relative(PROJECT_DIR, path.join(PROJECT_DIR, 'evals', 'retrieval.yaml')),
      ]);

      // 手算锚（构造性最近邻 → 三命中均 rank 1，一故意 miss）：recall = 3/4，MRR = (1+1+1+0)/4。
      expect(report.run.recallAtK).toBe(0.75);
      expect(report.run.mrr).toBe(0.75);

      const byId = new Map(report.run.perCase.map((p) => [p.caseId, p]));
      // 正文段 case：章级锚 rank 1 命中 + charSpan 全章区间 → spanBonus true。
      const chapter = byId.get('chapter-plot')!;
      expect(chapter.hit).toBe(true);
      expect(chapter.firstRank).toBe(1);
      expect(chapter.spanBonus).toBe(true);
      expect(chapter.matchedExpected).toEqual({ chapterId: 'ch_002', charSpan: [0, chapter2Length] });
      expect(chapter.query).toBe('簇章002');
      expect(chapter.note).toContain('章级锚');
      // rank 1 必是章源 hit（簇章002 双臂唯一锚——正文段，非摘要行）。
      expect(chapter.topHits[0]!.chapterId).toBe('ch_002');
      expect(chapter.topHits[0]!.sourceKind).toBe('chapter');

      // 卡 case：entryId 精确锚 rank 1；无区间 → spanBonus 键不出现（二态）。
      const card = byId.get('card-entity')!;
      expect(card.hit).toBe(true);
      expect(card.firstRank).toBe(1);
      expect(card.topHits[0]!.entryId).toBe('eval-card-0');
      expect(card.matchedExpected).toEqual({ entryId: 'eval-card-0' });
      expect('spanBonus' in card).toBe(false);

      // 章摘要 case：摘要行 entryId 命中（出场角色名的召回路径）。
      const summary = byId.get('summary-cast')!;
      expect(summary.hit).toBe(true);
      expect(summary.firstRank).toBe(1);
      expect(summary.matchedExpected).toEqual({ entryId: `${PID}:ep-001#summary` });
      expect(summary.topHits[0]!.sourceKind).toBe('chapter_summary');

      // 故意 miss：hit=false + firstRank/matchedExpected 键不出现 + topHits 非空（诊断面可用）。
      const miss = byId.get('deliberate-miss')!;
      expect(miss.hit).toBe(false);
      expect('firstRank' in miss).toBe(false);
      expect('matchedExpected' in miss).toBe(false);
      expect(miss.topHits.length).toBeGreaterThanOrEqual(1);

      // 每个 case 都有 topHits（miss 诊断 + hit 核对面）。
      for (const detail of report.run.perCase) {
        expect(detail.topHits.length).toBeGreaterThanOrEqual(1);
      }

      // 零网络：stub embed 恰好每 case 一次（4）；modelGateway mock 的 resolveModel 若被误触会
      // 响亮 throw（默认路径全被 deps 覆盖）。
      expect(queryEmbedCalls).toBe(4);
    },
    60_000,
  );

  it('空目录 graceful：未建评估集 → ran=false reason=no-eval-set，零检索调用', async () => {
    const emptyDir = path.join(TEST_HOME, 'empty-proj');
    mkdirSync(emptyDir, { recursive: true });
    const report = await runRetrievalEval(PID!, emptyDir, {}, {
      resolveModel: () => stubModel(),
      embed: async (_m: ResolvedModel, text: string) => {
        queryEmbedCalls += 1;
        return stubVec(text);
      },
      resolveRerankModel: () => null,
    });
    expect(report.ok).toBe(true);
    expect(report.ran).toBe(false);
    if (!report.ok || report.ran) throw new Error('expected no-eval-set');
    expect(report.reason).toBe('no-eval-set');
    expect(report.filesFound).toBe(0);
    // 未跑任何检索（embed 计数不变——上一 it 的 4）。
    expect(queryEmbedCalls).toBe(4);
  });
});
