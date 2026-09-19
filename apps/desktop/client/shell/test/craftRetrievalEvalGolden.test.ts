import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CraftCard, CraftCardCategory, CraftTeaching, ResolvedModel } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// E10.2b W6.2：craft 金标 eval harness 机制面（design §4 / prd R8·AC7·AC10）——合成种子卡
// 语料 + 金标 yaml fixtures + 真跑 ABI 全链出分。mirror retrievalEval.test.ts 全套模式：
// 确定性合成（seeded LCG + 唯一情境标记 → 专属簇心）/ stub embed 簇结构 / Electron-as-Node
// 真跑 + ABI gate skip / throwaway TEST_HOME / 零网络（modelGateway mock 兜默认路径）。
//
// 语料（全部经生产写入面落库——insertCraftCardRowSync / term repository / seedCraft doc 行）：
//   - 26 张大类卡（13 大类 × 2）——每卡 condensed 带唯一「写作情境」标记短语（= 该 case 的
//     query，FTS 唯一命中 + vec 簇心 exact → 双臂 RRF rank 1 确定）；17 张有专属 case，其余
//     为同类干扰卡（证明大类内多卡不互相吞）。
//   - X1/X2/X3（共享标记 MX）→ tags 单标签 / 多标签 any-of / craft_type 过滤三 case；
//   - Z1/Z2（共享标记 MZ）→ tags+craft_type 组合 case；
//   - Y1/Y2（共享标记 MY）→ craft_type 过滤 case；
//   - 1 张窗口目标卡（标记 MT，tag 窗口外样本）+ 45 张填充卡（标记 MW）→ F-08 构造：目标卡
//     标签命中但向量距离排在 45 张填充卡之后 = 默认 vec KNN 窗口（topN*2=40）外，tags 在场
//     ×4（160）放宽后才进融合集（AC10「tag 命中在 vec 窗口外」用例，mirror W4.3 测试构造）；
//   - 2 条 doc 行（既有 craft 文档，noise 向量干扰项）——证卡/doc 同索引共存不扰动卡命中。
//
// 手算锚：24 case，23 hit（全部 rank 1）+ 1 故意 miss → recall@5 = MRR = 23/24。回归门 =
// 管线变更后断言**不低于**该基线（≥ 而非精确等值——改进不红、退化红，CR-2b-17；真金标
// W6.1 用户主审后回填同形 yaml 替换语料）。
//
// evals 布置：golden.yaml（24 case）+ broken.yaml（1 坏条目：expected 空）+ work/zz-dup.yaml
//（跨文件重复 id——顺带断言递归扫描 + 去重 first-wins；命名排在 golden.yaml 之后）。
// → caseCount 24 / skippedCases 2。
//
// Electron-as-Node 真跑（better-sqlite3 按 Electron ABI 重建，plain-Node vitest 下本 suite 会被
// ABI gate skip）：
//   cd apps/desktop/client/shell
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/craftRetrievalEvalGolden.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-craft-eval-golden');
const EVAL_DIR = path.join(TEST_HOME, 'craft-evals');

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
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

import { closeDb, getDb } from '../main/db/index';
import { searchCraft } from '../main/db/closureCraftRetrieval';
import type { RetrievalDeps } from '../main/db/closureRetrieval';
import {
  cardCraftId,
  insertCraftCardRowSync,
  type ClaimEmbedOutcome,
} from '../main/db/closureCraftCardRepository';
import {
  findCraftTermByName,
  insertCraftTerm,
  proposedCraftTermId,
} from '../main/db/closureCraftTermRepository';
import { runCraftEval, parseCraftEvalYaml } from '../main/db/craftRetrievalEval';
import { EMBED_DIM, floatArrayToBuffer } from '../main/db/closureIndexer';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 ABI gate（mirror retrievalEval）：plain-Node vitest 下原生 addon ABI 不匹配时
// skip 而非 fail。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

// ── 确定性合成文本（seeded LCG + 唯一情境标记，mirror retrievalEval 词池形态）──

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

// ── 情境标记（= case query，同时是 vec 簇键——索引/查询共用 stubVec 单源）──

const M = {
  qingxuA: '读者情绪先压后放的节奏怎么排',
  qingxuB: '高潮前让读者松一口气的写法',
  xinxichaA: '读者比角色先知道秘密的手法',
  xinxichaB: '关键信息压到哪一章再揭开',
  fubiA: '长线伏笔怎么埋才不突兀',
  fubiB: '伏笔回收前的三次提醒怎么摆',
  qiaoduanA: '误会型桥段的进出场设计',
  qiaoduanB: '拷问戏怎么写出信息增量',
  jiegouA: '双线交错的章节切换节奏',
  jiegouB: '单章内起承转合的切分',
  huokeA: '书名怎么点出核心卖点',
  huokeB: '简介前三行怎么留住读者',
  qidaiganA: '期待感的兑现不能拖过三章',
  qidaiganB: '垫场章节怎么维持读者耐心',
  jiegoudafaA: '同类打斗场景怎么写出变奏',
  jiegoudafaB: '固定调度模式的复用边界',
  zaogengA: '名场面台词怎么造梗传播',
  zaogengB: '读者社区互动的梗回收',
  shijieguanA: '新设定怎么并入既有世界观',
  shijieguanB: '世界观扩容不掉读者',
  manzuA: '即时满足与长线满足怎么配比',
  manzuB: '终极满足的前置条件设计',
  rensheA: '人物对照组怎么设',
  rensheB: '角色声纹的口语标记怎么立',
  sucaiA: '冷兵器打斗的描写词汇',
  sucaiB: '雨夜街景的气氛素材',
  mx: '都市开篇金手指怎么摆',
  mz: '开篇钩子的强度档位选择',
  my: '情绪反差的读者落差设计',
  mw: '群像配角调度怎么不散',
  mt: '长线配额兑现的分层回报',
} as const;

/** 窗口外 case 的 query（填充卡与查询共享的情境标记）。 */
const MW = M.mw;
/** 故意 miss 的 query——不出现在任何卡 body，也不是注册簇键。 */
const MISS_QUERY = '完全不存在的写作情境标记词九九九';

const MARKERS: readonly string[] = Object.values(M);

// ── embed stub（簇结构——mirror retrievalEval 形态：标记 → 专属簇心 + 文本 hash 噪声）──

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

/**
 * 索引/查询共用：文本含注册标记 → 专属簇心 + 小噪声（同簇 cos 距离 ~0.001）；无标记 → 纯噪声
 * （0.3——与一切簇心距离 ~1.0）。query 与目标卡共享标记 → 查询向量 ≈ 目标簇心（exact），
 * FTS 唯一命中 + vec rn=1 → 双臂 rank 1 确定。
 */
function stubVec(text: string): number[] {
  const marker = MARKERS.find((m) => text.includes(m));
  if (marker !== undefined) return vecNear(`m:${marker}`, text, 0.05);
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

let queryEmbedCalls = 0; // 零网络断言：每 case 恰一次 stub embed

const EVAL_DEPS: RetrievalDeps = {
  resolveModel: () => stubModel(),
  embed: async (_m: ResolvedModel, text: string) => {
    queryEmbedCalls += 1;
    return stubVec(text);
  },
  resolveRerankModel: () => null,
};

// ── 合成种子卡（生产写入面：closure_craft_card + #claim 向量 + verified entry 行）──

/** 每大类两个词目（与大类卡一一对应；X/Z/Y/W/填充卡复用）。 */
const TERM_NAMES: Record<CraftCardCategory, [string, string]> = {
  qingxu: ['先抑后扬', '情绪回报节奏'],
  xinxicha: ['信息释放时序', '认知落差操控'],
  fubi: ['长线伏笔', '伏笔回收节奏'],
  qiaoduan: ['误会型桥段', '拷问戏信息增量'],
  jiegou: ['双线交错', '单章四段切分'],
  huoke: ['书名卖点', '简介悬念'],
  qidaigan: ['期待兑现窗口', '垫场调剂'],
  jiegoudafa: ['同类场景变奏', '固定调度模式'],
  zaogeng: ['名场面造梗', '社区梗回收'],
  shijieguan: ['世界观扩容', '设定并入'],
  manzu: ['三层满足感', '终极满足前置'],
  renshe: ['人物对照组', '角色声纹'],
  sucai: ['打斗词汇', '场景素材'],
};

function ensureTerm(category: CraftCardCategory, name: string): string {
  const existing = findCraftTermByName(category, name);
  if (existing !== null) return existing.termId;
  const termId = proposedCraftTermId(category, name);
  insertCraftTerm({ termId, category, name, status: 'active', mergedInto: null, note: null });
  return termId;
}

function teachingFor(n: number, extra = ''): CraftTeaching {
  const h = createHash('sha256').update(`${n}\0${extra}`).digest('hex');
  return {
    teachingId: `tea-${h.slice(0, 12)}`,
    materialId: `mat-${h.slice(12, 24)}`,
    materialContentHash: `sha256:${'a'.repeat(64)}`,
    author: n % 2 === 0 ? '老作者甲' : null,
    quote: `这条经验出自讲义第${n}节，重点是执行的度。`,
    anchor: { chapterIndex: 0, charStart: 0, charEnd: 24, paraStart: 0, paraEnd: 1 },
    rank: 'normal',
    note: null,
    stale: false,
  };
}

const TAILS = [
  '核心是把强度与铺垫长度挂钩，先蓄势再释放。',
  '要点在节奏与信息密度的交替，避免单点过载。',
  '适用边界取决于读者耐心与章内负担，宁欠勿溢。',
  '反例是只堆场面不给兑现，读者会弃书。',
] as const;

const POINTS = ['执行时先定总量再切分', '每次只动一个变量'] as const;
const SCENARIOS = ['开篇段与高潮前的过渡段', '调剂位的使用时机'] as const;
const COUNTERS = ['读者已疲劳时禁用', '单章内重复使用两次以上不适用'] as const;

function hexId(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

interface SeedSpec {
  n: number;
  category: CraftCardCategory;
  /** 词目序（TERM_NAMES[category][termIdx]）。 */
  termIdx: 0 | 1;
  title: string;
  marker: string;
  tags: string[];
  /** condensed 尾注（缺省轮换 TAILS；填充卡传专属尾注保证向量噪声互异）。 */
  tail?: string;
  /** 额外讲法数（多来源讲法形态——qingxu-a 带两条证合并卡可检回）。 */
  extraTeachings?: number;
}

function buildCard(spec: SeedSpec): CraftCard {
  const [t0, t1] = TERM_NAMES[spec.category];
  const termId = ensureTerm(spec.category, spec.termIdx === 0 ? t0! : t1!);
  const teachings = [teachingFor(spec.n)];
  for (let i = 0; i < (spec.extraTeachings ?? 0); i++) {
    teachings.push(teachingFor(spec.n * 1000 + i + 1, `x${i}`));
  }
  return {
    cardId: `card-${hexId(spec.n, 12)}`,
    category: spec.category,
    termId,
    title: spec.title,
    claim: {
      condensed: `${spec.marker}——${spec.tail ?? TAILS[spec.n % TAILS.length]}`,
      points: [...POINTS],
      scenarios: [...SCENARIOS],
      counterexamples: [...COUNTERS],
    },
    tags: spec.tags,
    teachings,
    dispute: false,
    status: 'verified',
    rejectReason: null,
    confidence: 0.55 + (spec.n % 5) * 0.08,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

/** 落卡走生产写入面（预嵌 claim 向量——同形状去重面的真实形态）。 */
function seedCard(spec: SeedSpec): CraftCard {
  const card = buildCard(spec);
  const claim: ClaimEmbedOutcome = {
    vector: stubVec(card.claim.condensed),
    modelId: stubModel().modelId,
  };
  insertCraftCardRowSync(card, claim);
  return card;
}

/** doc 行（既有 craft 文档干扰项——raw 派生表播种，mirror closureCraftRetrieval.test seedCraft）。 */
function seedCraftDoc(craftId: string, craftType: string, name: string, body: string): void {
  const db = getDb();
  db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=?').run(craftId);
  db.prepare(
    `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text, summary_text, tags)
     VALUES (?, ?, 'user', ?, ?, NULL, NULL)`,
  ).run(craftId, craftType, name, body);
  if (!isSqliteVecAvailable()) return;
  db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(craftId);
  const insertVec = db.prepare(
    `INSERT INTO closure_craft_vec (vector_id, craft_id, craft_type, source_kind, vector_kind, embedding)
     VALUES (?, ?, ?, 'user', ?, ?)`,
  );
  insertVec.run(`${craftId}#body`, craftId, craftType, 'body', floatArrayToBuffer(noiseVec(body, 0.3)));
  insertVec.run(
    `${craftId}#identity`,
    craftId,
    craftType,
    'identity',
    floatArrayToBuffer(noiseVec(`${body}#i`, 0.3)),
  );
}

// ── 语料表（26 大类卡 + 3 X 卡 + 2 Z 卡 + 2 Y 卡 + 1 窗口目标 + 45 填充 = 79 卡）──

const CATEGORY_CARDS: SeedSpec[] = [
  { n: 1, category: 'qingxu', termIdx: 0, title: '先抑后扬三层回报', marker: M.qingxuA, tags: ['爽文', '开篇'], extraTeachings: 1 },
  { n: 2, category: 'qingxu', termIdx: 1, title: '高潮前松一口气', marker: M.qingxuB, tags: [] },
  { n: 3, category: 'xinxicha', termIdx: 0, title: '读者先知的秘密', marker: M.xinxichaA, tags: ['悬疑'] },
  { n: 4, category: 'xinxicha', termIdx: 1, title: '信息压章揭盖', marker: M.xinxichaB, tags: ['群像'] },
  { n: 5, category: 'fubi', termIdx: 0, title: '长线伏笔三埋法', marker: M.fubiA, tags: ['长线'] },
  { n: 6, category: 'fubi', termIdx: 1, title: '伏笔回收三提醒', marker: M.fubiB, tags: ['长线', '高潮'] },
  { n: 7, category: 'qiaoduan', termIdx: 0, title: '误会桥段进出场', marker: M.qiaoduanA, tags: ['打斗', '群像'] },
  { n: 8, category: 'qiaoduan', termIdx: 1, title: '拷问戏信息增量', marker: M.qiaoduanB, tags: [] },
  { n: 9, category: 'jiegou', termIdx: 0, title: '双线交错切换', marker: M.jiegouA, tags: ['双线'] },
  { n: 10, category: 'jiegou', termIdx: 1, title: '单章四段切分', marker: M.jiegouB, tags: ['单章'] },
  { n: 11, category: 'huoke', termIdx: 0, title: '书名卖点提炼', marker: M.huokeA, tags: ['书名'] },
  { n: 12, category: 'huoke', termIdx: 1, title: '简介三行悬念', marker: M.huokeB, tags: ['简介', '开篇'] },
  { n: 13, category: 'qidaigan', termIdx: 0, title: '期待三章兑现', marker: M.qidaiganA, tags: ['开篇'] },
  { n: 14, category: 'qidaigan', termIdx: 1, title: '垫场耐心维持', marker: M.qidaiganB, tags: ['过渡'] },
  { n: 15, category: 'jiegoudafa', termIdx: 0, title: '打斗变奏三型', marker: M.jiegoudafaA, tags: ['打斗'] },
  { n: 16, category: 'jiegoudafa', termIdx: 1, title: '调度模式复用边界', marker: M.jiegoudafaB, tags: ['复用'] },
  { n: 17, category: 'zaogeng', termIdx: 0, title: '名场面造梗', marker: M.zaogengA, tags: ['社区'] },
  { n: 18, category: 'zaogeng', termIdx: 1, title: '社区梗回收', marker: M.zaogengB, tags: ['社区', '回收'] },
  { n: 19, category: 'shijieguan', termIdx: 0, title: '设定并入手册', marker: M.shijieguanA, tags: ['设定'] },
  { n: 20, category: 'shijieguan', termIdx: 1, title: '世界观扩容护栏', marker: M.shijieguanB, tags: ['设定'] },
  { n: 21, category: 'manzu', termIdx: 0, title: '即时长线配比', marker: M.manzuA, tags: ['爽文'] },
  { n: 22, category: 'manzu', termIdx: 1, title: '终极满足前置', marker: M.manzuB, tags: ['终局'] },
  { n: 23, category: 'renshe', termIdx: 0, title: '人物对照组设定', marker: M.rensheA, tags: ['群像'] },
  { n: 24, category: 'renshe', termIdx: 1, title: '角色声纹口语标记', marker: M.rensheB, tags: ['对话'] },
  { n: 25, category: 'sucai', termIdx: 0, title: '冷兵器打斗词汇', marker: M.sucaiA, tags: ['打斗', '素材'] },
  { n: 26, category: 'sucai', termIdx: 1, title: '雨夜街景素材', marker: M.sucaiB, tags: ['场景', '素材'] },
];

const FILLER_COUNT = 45;

// ── describe 级共享 ──

let cardQingxuA: CraftCard;
let cardX1: CraftCard;
let cardX3: CraftCard;
let cardY1: CraftCard;
let cardWindowTarget: CraftCard;
let goldenYamlText = '';

function clean(): void {
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

/** 金标 yaml 生成器（W6.1 回填模板——craft 侧扩展键 craft_type/tags 见 runner 头注）。 */
function buildGoldenYaml(): string {
  const lines: string[] = ['cases:'];
  const addCase = (c: {
    id: string;
    query: string;
    expected: string[];
    craftType?: string;
    tags?: string[];
    note?: string;
  }): void => {
    lines.push(`  - id: ${c.id}`);
    lines.push(`    query: ${c.query}`);
    if (c.craftType !== undefined) lines.push(`    craft_type: ${c.craftType}`);
    if (c.tags !== undefined) {
      lines.push('    tags:');
      for (const t of c.tags) lines.push(`      - '${t}'`);
    }
    lines.push('    expected:');
    for (const e of c.expected) lines.push(`      - entryId: "${e}"`);
    if (c.note !== undefined) lines.push(`    note: ${c.note}`);
  };
  const cardEntry = (card: CraftCard): string => cardCraftId(card.cardId);
  /** 期望 entryId = entry 行 craft_id = `card:card-<12hex>`（cardCraftId 形态）。 */
  const cardRef = (n: number): string => cardCraftId(`card-${hexId(n, 12)}`);

  // 17 张大类卡专属 case（覆盖 13 大类——qingxu/jiegou/huoke/renshe 双卡）。
  addCase({ id: 'qingxu-a', query: M.qingxuA, expected: [cardEntry(cardQingxuA)], note: '情绪回报模式（多讲法合并卡）' });
  addCase({ id: 'qingxu-b', query: M.qingxuB, expected: [cardRef(2)] });
  addCase({ id: 'xinxicha-a', query: M.xinxichaA, expected: [cardRef(3)] });
  addCase({ id: 'fubi-a', query: M.fubiA, expected: [cardRef(5)] });
  addCase({ id: 'qiaoduan-a', query: M.qiaoduanA, expected: [cardRef(7)] });
  addCase({ id: 'jiegou-a', query: M.jiegouA, expected: [cardRef(9)] });
  addCase({ id: 'jiegou-b', query: M.jiegouB, expected: [cardRef(10)] });
  addCase({ id: 'huoke-a', query: M.huokeA, expected: [cardRef(11)] });
  addCase({ id: 'huoke-b', query: M.huokeB, expected: [cardRef(12)] });
  addCase({ id: 'qidaigan-a', query: M.qidaiganA, expected: [cardRef(13)] });
  addCase({ id: 'jiegoudafa-a', query: M.jiegoudafaA, expected: [cardRef(15)] });
  addCase({ id: 'zaogeng-a', query: M.zaogengA, expected: [cardRef(17)] });
  addCase({ id: 'shijieguan-a', query: M.shijieguanA, expected: [cardRef(19)] });
  addCase({ id: 'manzu-a', query: M.manzuA, expected: [cardRef(21)] });
  addCase({ id: 'renshe-a', query: M.rensheA, expected: [cardRef(23)] });
  addCase({ id: 'renshe-b', query: M.rensheB, expected: [cardRef(24)] });
  addCase({ id: 'sucai-a', query: M.sucaiA, expected: [cardRef(25)] });

  // tags 组合（R10/AC10）：单标签 / 多标签 any-of / tags+craft_type 组合。
  addCase({
    id: 'tags-single',
    query: M.mx,
    tags: ['都市'],
    expected: [cardEntry(cardX1)],
    note: 'tags 单标签收窄（同标记三卡只回标签命中行）',
  });
  addCase({
    id: 'tags-multitag-anyof',
    query: M.mx,
    tags: ['#都市', '悬疑'],
    expected: [cardEntry(cardX1), cardEntry(cardX3)],
    note: '多标签 OR 召回 + any-of 期望（井号前缀照抄命中渲染形态）',
  });
  addCase({
    id: 'tags-ct-combo',
    query: M.mz,
    tags: ['都市'],
    craftType: 'huoke',
    expected: [cardRef(111)],
    note: 'tags ∩ craft_type 双重收窄（Z1 huoke 胜出，Z2 qidaigan 被大类滤除）',
  });

  // craft_type 大类过滤（≥2 对）。
  addCase({
    id: 'ct-qingxu',
    query: M.my,
    craftType: 'qingxu',
    expected: [cardEntry(cardY1)],
    note: '大类过滤（同标记两卡只回 qingxu 侧）',
  });
  addCase({
    id: 'ct-huoke-anyof',
    query: M.mx,
    craftType: 'huoke',
    expected: [cardRef(102), cardRef(103)],
    note: '大类过滤 any-of（X2/X3 同属 huoke）',
  });

  // F-08 构造（AC10）：标签命中在默认 vec 窗口外，×4 补偿后召回。
  addCase({
    id: 'vec-window-tags',
    query: MW,
    tags: ['窗口外样本'],
    expected: [cardEntry(cardWindowTarget)],
    note: '目标卡向量距离排 45 张填充卡之后 = 默认窗口（40）外；tags ×4（160）放宽后经融合集标签过滤召回',
  });

  // 故意 miss——防 recall 虚高（期望 id 形态合法但语料中不存在）。
  addCase({
    id: 'deliberate-miss',
    query: MISS_QUERY,
    expected: [cardCraftId('card-ffffffffffff')],
    note: '语料中不存在的标记——miss 诊断面',
  });
  return `${lines.join('\n')}\n`;
}

describe.skipIf(!sqliteUsable)('craftRetrievalEval — 金标 harness 机制面（E10.2b W6.2，合成种子卡语料）', () => {
  beforeAll(
    () => {
      clean();
      mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
      getDb();
      // vec 扩展是检索链核心对象：Electron 真跑下缺失 = 打包回归，响亮失败（mirror retrievalEval）。
      expect(isSqliteVecAvailable()).toBe(true);

      // 1. 大类卡（26——全 verified，经生产写入面带 #claim 向量 + entry 行）。
      const cards = CATEGORY_CARDS.map(seedCard);
      cardQingxuA = cards[0]!;

      // 2. 组卡（X1/X2/X3 共享 MX；Z1/Z2 共享 MZ；Y1/Y2 共享 MY）。
      cardX1 = seedCard({ n: 101, category: 'qiaoduan', termIdx: 0, title: '都市金手指开篇摆位', marker: M.mx, tags: ['都市'] });
      seedCard({ n: 102, category: 'huoke', termIdx: 0, title: '仙侠开篇转化位', marker: M.mx, tags: ['仙侠'] });
      cardX3 = seedCard({ n: 103, category: 'huoke', termIdx: 1, title: '悬疑开篇钩位', marker: M.mx, tags: ['悬疑'] });
      seedCard({ n: 111, category: 'huoke', termIdx: 1, title: '开篇钩子强度档', marker: M.mz, tags: ['都市'] });
      seedCard({ n: 112, category: 'qidaigan', termIdx: 1, title: '钩子强度的期待侧', marker: M.mz, tags: ['都市'] });
      cardY1 = seedCard({ n: 121, category: 'qingxu', termIdx: 0, title: '反差落差的 Reader 侧', marker: M.my, tags: ['落差'] });
      seedCard({ n: 122, category: 'qidaigan', termIdx: 0, title: '反差落差的期待侧', marker: M.my, tags: ['落差'] });

      // 3. F-08 构造：窗口目标卡（标记 MT——查询 MW 不出现在其 body，FTS miss；tag 窗口外样本
      //    唯一）+ 45 张填充卡（标记 MW——FTS+vec 双近，把窗口目标挤到默认 vec 窗口外）。
      cardWindowTarget = seedCard({
        n: 131,
        category: 'manzu',
        termIdx: 1,
        title: '分层回报配额卡',
        marker: M.mt,
        tags: ['窗口外样本'],
      });
      for (let i = 0; i < FILLER_COUNT; i++) {
        const rng = makeRng((LCG_SEED ^ Math.imul(i + 1, 0x9e37_77b9)) >>> 0);
        const fillerPara = `${buildSentence(rng, 20, 40)}${buildSentence(rng, 20, 40)}`;
        // 专属尾注保证填充卡 condensed/向量噪声互异（同标记簇 m:MW 内不同距离——rank 确定且互不重叠）。
        seedCard({
          n: 201 + i,
          category: 'sucai',
          termIdx: 1,
          title: `填充卡${i}`,
          marker: MW,
          tags: ['填充'],
          tail: `填充样本${i}号——${fillerPara}`,
        });
      }

      // 4. doc 干扰行（既有 craft 文档与卡同索引共存）。
      seedCraftDoc('golden-doc-a', 'playbook', '题材手册·武侠', '武侠题材的开篇节奏参考与三章留人要点。');
      seedCraftDoc('golden-doc-b', 'shuangdian', '爽点清单', '三层满足感的即时反馈与累积回报清单。');

      // 5. 语料 sanity：卡 entry 行 79（26+3+2+2+1+45）+ doc 行 2；claim vec 行 79 + doc 4。
      const db = getDb();
      const cardRows = (
        db.prepare("SELECT COUNT(*) AS n FROM closure_craft_entry WHERE source_kind='craft_card'").get() as { n: number }
      ).n;
      expect(cardRows).toBe(79);
      const docRows = (
        db.prepare("SELECT COUNT(*) AS n FROM closure_craft_entry WHERE source_kind='user'").get() as { n: number }
      ).n;
      expect(docRows).toBe(2);
      const claimVecRows = (
        db.prepare("SELECT COUNT(*) AS n FROM closure_craft_vec WHERE vector_kind='claim'").get() as { n: number }
      ).n;
      expect(claimVecRows).toBe(79);

      // 6. 评估集布置：golden.yaml（24 case）+ broken.yaml（坏条目）+ work/zz-dup.yaml（重复 id）。
      goldenYamlText = buildGoldenYaml();
      mkdirSync(path.join(EVAL_DIR, 'work'), { recursive: true });
      writeFileSync(path.join(EVAL_DIR, 'golden.yaml'), goldenYamlText, 'utf-8');
      writeFileSync(
        path.join(EVAL_DIR, 'broken.yaml'),
        'cases:\n  - id: broken-empty-expected\n    query: 缺期望的坏条目\n    expected: []\n',
        'utf-8',
      );
      writeFileSync(
        path.join(EVAL_DIR, 'work', 'zz-dup.yaml'),
        `cases:\n  - id: qingxu-a\n    query: ${M.qingxuA}\n    expected:\n      - entryId: "card:deadbeefdead"\n`,
        'utf-8',
      );
    },
    60_000,
  );

  afterAll(() => {
    clean();
  });

  it('金标 yaml fixture 本身可执行：24 case 全解析 + 6 条带 craft 检索参数（W6.1 回填模板面）', () => {
    const parsed = parseCraftEvalYaml(goldenYamlText);
    expect(parsed).not.toBeNull();
    expect(parsed!.cases).toHaveLength(24);
    expect(parsed!.skipped).toBe(0);
    expect(parsed!.params.size).toBe(6);
    // 参数抽查：any-of 多标签（含 # 前缀照抄形态）+ 组合 case 双参数。
    expect(parsed!.params.get('tags-multitag-anyof')).toEqual({ tags: ['#都市', '悬疑'] });
    expect(parsed!.params.get('tags-ct-combo')).toEqual({ craftType: 'huoke', tags: ['都市'] });
    // 大类覆盖面：17 张专属 case 的期望卡 id 形态全对（cardCraftId 形态 `card:card-<12hex>`）。
    for (const c of parsed!.cases) {
      expect(c.expected.length).toBeGreaterThanOrEqual(1);
      for (const e of c.expected) expect(e.entryId).toMatch(/^card:card-[0-9a-f]{12}$/);
    }
  });

  it(
    'runCraftEval：24 case 手算锚 recall@5=MRR=23/24（23 hit 全 rank1 + 1 故意 miss）+ 容错计数 + 零网络',
    async () => {
      const report = await runCraftEval(EVAL_DIR, {}, EVAL_DEPS);
      expect(report.ok).toBe(true);
      expect(report.ran).toBe(true);
      if (!report.ok || !report.ran) throw new Error('eval should have run');

      // 容错计数：1 坏条目（expected 空）+ 1 跨文件重复 id（work/zz-dup.yaml 的 qingxu-a）。
      expect(report.run.caseCount).toBe(24);
      expect(report.run.skippedCases).toBe(2);
      expect(report.run.skippedFiles).toBe(0);
      expect(report.run.k).toBe(5);
      expect(report.run.files).toEqual(['golden.yaml']);

      // 手算锚（**回归下限**，CR-2b-17：断言 ≥ 基线而非精确等值——toBeCloseTo 是变化检测器，
      // 检索侧的合法改进〔rank 提升等〕也会红；只有退化才红）：基线 = 23 命中全 rank1 +
      // 1 故意 miss → recall = MRR = 23/24。
      expect(report.run.recallAtK).toBeGreaterThanOrEqual(23 / 24);
      expect(report.run.mrr).toBeGreaterThanOrEqual(23 / 24);

      const byId = new Map(report.run.perCase.map((p) => [p.caseId, p]));

      // 大类卡 case：entryId 精确锚 rank 1（多讲法合并卡可检回）+ 卡源 hit 形态。
      const qingxuA = byId.get('qingxu-a')!;
      expect(qingxuA.hit).toBe(true);
      expect(qingxuA.firstRank).toBe(1);
      expect(qingxuA.matchedExpected).toEqual({ entryId: cardCraftId(cardQingxuA.cardId) });
      expect(qingxuA.topHits[0]).toMatchObject({
        craftId: cardCraftId(cardQingxuA.cardId),
        craftType: 'qingxu',
        sourceKind: 'craft_card',
      });
      expect(qingxuA.note).toContain('多讲法');

      // tags 单标签：同标记三卡只回标签命中行（X1 rank 1，期望兑现）。
      const tagsSingle = byId.get('tags-single')!;
      expect(tagsSingle.hit).toBe(true);
      expect(tagsSingle.firstRank).toBe(1);
      expect(tagsSingle.matchedExpected).toEqual({ entryId: cardCraftId(cardX1.cardId) });
      expect(tagsSingle.tags).toEqual(['都市']);

      // tags 多标签 OR + any-of：X1/X3 任一兑现（rank 1 必是其一）。
      const multiTag = byId.get('tags-multitag-anyof')!;
      expect(multiTag.hit).toBe(true);
      expect(multiTag.firstRank).toBe(1);
      expect([cardCraftId(cardX1.cardId), cardCraftId(cardX3.cardId)]).toContain(
        multiTag.matchedExpected?.entryId,
      );

      // tags ∩ craft_type 组合：Z1（huoke）胜出。
      const combo = byId.get('tags-ct-combo')!;
      expect(combo.hit).toBe(true);
      expect(combo.firstRank).toBe(1);
      expect(combo.matchedExpected).toEqual({ entryId: cardCraftId(`card-${hexId(111, 12)}`) });

      // craft_type 过滤：Y1（qingxu 侧）rank 1。
      const ctQingxu = byId.get('ct-qingxu')!;
      expect(ctQingxu.hit).toBe(true);
      expect(ctQingxu.firstRank).toBe(1);
      expect(ctQingxu.matchedExpected).toEqual({ entryId: cardCraftId(cardY1.cardId) });
      expect(ctQingxu.craftType).toBe('qingxu');

      // craft_type any-of：X2/X3 同属 huoke。
      const ctHuoke = byId.get('ct-huoke-anyof')!;
      expect(ctHuoke.hit).toBe(true);
      expect([cardCraftId(`card-${hexId(102, 12)}`), cardCraftId(`card-${hexId(103, 12)}`)]).toContain(
        ctHuoke.matchedExpected?.entryId,
      );

      // F-08 窗口外 case：×4 补偿后经标签过滤召回（AC10 构造用例）。
      const windowCase = byId.get('vec-window-tags')!;
      expect(windowCase.hit).toBe(true);
      expect(windowCase.firstRank).toBe(1);
      expect(windowCase.matchedExpected).toEqual({ entryId: cardCraftId(cardWindowTarget.cardId) });

      // 故意 miss：hit=false + firstRank/matchedExpected 键不出现 + topHits 诊断面可用。
      const miss = byId.get('deliberate-miss')!;
      expect(miss.hit).toBe(false);
      expect('firstRank' in miss).toBe(false);
      expect('matchedExpected' in miss).toBe(false);
      expect(miss.topHits.length).toBeGreaterThanOrEqual(1);

      // 每个 case 都有 query 回显；hit case 的 topHits 首条即期望卡或同标记卡。
      for (const detail of report.run.perCase) {
        expect(detail.query.length).toBeGreaterThan(0);
      }

      // 零网络：stub embed 恰好每 case 一次（24）；modelGateway mock 的默认路径若被误触会响亮 throw。
      expect(queryEmbedCalls).toBe(24);
    },
    60_000,
  );

  it(
    'F-08 边界实证：同一查询不带 tags → 目标卡在默认 vec 窗口（40）外不可见；带 tags → ×4 窗口召回 + vec 臂参与',
    async () => {
      // 该 case 的意义锚：若目标卡不在默认窗口外，金标 hit 就不是 ×4 补偿捞回的（用例退化）。
      const noTags = await searchCraft(MW, { k: 5 }, EVAL_DEPS);
      expect(noTags.map((h) => h.craftId)).not.toContain(cardCraftId(cardWindowTarget.cardId));
      expect(noTags).toHaveLength(5); // 窗口内填充卡撑满 k

      const withTags = await searchCraft(MW, { k: 5, tags: ['窗口外样本'] }, EVAL_DEPS);
      expect(withTags.map((h) => h.craftId)).toEqual([cardCraftId(cardWindowTarget.cardId)]);
      expect(withTags[0]!.vecDistance).toBeDefined(); // vec 臂参与了该命中（×4 窗口捞回）

      // 零网络累计：上一 it 24 + 本 it 2。
      expect(queryEmbedCalls).toBe(26);
    },
    60_000,
  );

  it('评估集落盘完整性：golden.yaml 回读与生成模板一致（fixture 即 W6.1 回填模板的实物）', () => {
    // 读回落盘的 golden.yaml 与内存模板一致（W6.1 回填照此文件换语料——yaml 形状即模板）。
    expect(readFileSync(path.join(EVAL_DIR, 'golden.yaml'), 'utf-8')).toBe(goldenYamlText);
  });
});
