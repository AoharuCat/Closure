import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildCognitionSnapshot,
  buildPresenceSignal,
  chunkChapter,
  type ChapterStateSummary,
  type ResolvedModel,
  type WorldPatchInput,
  type WorldSubject,
} from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S6：检索规模压测 suite（design §7 / prd AC-1/2/7）——「百万字规模下检索不崩」
// 的 AC 本体站。mirror worldStateScale.test.ts 全套模式：确定性合成（seeded LCG，无
// Math.random / Date.now）/ 断言主体 = 计数与结构（防 flake）/ wall-time 只做记录性输出 +
// 宽上限断言（防架构回归，非精确性能断言）/ Electron-as-Node 真跑 + ABI gate skip /
// throwaway TEST_HOME。
//
// 断言七组（design §7 清单）：
//   ① 召回：构造性最近邻（seeded 簇结构 embed stub）recall@10 = 100%（暴力精确）+ per-chunk
//      各占席（同章多 chunk 独立排名）+ 摘要/卡独立簇 + setting_md 双向量单席（vec_best
//      per-entry dedupe 双语义）。
//   ② FTS：中文 trigram 正文原句唯一命中（针语 needle）+ 章梗概语义词经 index_text prefix
//      命中正文段（contextual prefix 的 FTS 路径；返回 bodyText = 原文非组料）+ RRF 双臂
//      命中项 score > 单臂项（融合序正确）。
//   ③ CR-005 修复验证：deprecated 占多数（48:4）的当铺卡簇上 status:'active' 检索的 vec 臂
//      召回 = 基线（4/4 完全——KNN 内 metadata 预剪枝；chunk/setting_md 的 '' sentinel 不混入）
//      + 饥饿几何实锤（未过滤 KNN top-40 全 deprecated——8.7「post-KNN 过滤 + vecK 补偿」形态
//      在此几何下必然塌缩，证明本断言有牙齿）。
//   3b 目录面排除：catalog total 只含实体行（60 卡 + 2 设定散文 = 62；数百 chunk 行不淹没）
//      + get_entry 对 chunk entry_id 友好 miss。
//   ④ gap_stats 规模观测：S5 聚合函数行数（per-subject / per-entry / 轻列窗）vs 全量行数
//      数量级断言（行为对拍由 gapStatsFetchParity.test.ts 守，本站只做规模面）。
//   ⑥ chunk 索引管线：400 章经真 reindexChapter 落库（分块→事务→FTS/vec 全链）行数 = Σ分块
//      数 + 章重写幂等（hash skip 零重嵌——stub 调用计数）+ 章删除 orphan 清行 + 灌库吞吐
//      （记录性）。
//   ⑦ F 块观测与判定（design §6 判定框架）：cognition/presence 投影（S5 轴预过滤取数 + 纯函数
//      fold）输入量与 P95 + query_world_slice 等价全量载波 payload/耗时 → evaluateRetrievalScaleGate
//      阈值闸出结论（checkpoint / 窗收窄 / 维持 defer——S7 条件站依据）。
//      S7 终局记档（2026-08-20，主上下文裁决路径 A「调用内增量折叠」，否决 per-axis checkpoint
//      ——checkpoint 帮不了消费已取回 patches 的纯函数）：buildPresenceSignal per-subject 增量折叠
//      （认知查询点去重升序 + physical 史 storyTime 排序单次扫描逐窗 applyPatches(seed, window)
//      折叠，等价原语 = 8.1 seeded reduce「seed + (prevAt, at] 窗 ≡ 全史 fold」，worldStateAsOfAudit /
//      as-of-invariants 全套背书）。演进数字：原 per-cog-patch 全量扫描 129.79ms → groupBy(subjectId)
//      预分组 116.3ms（残项 = Σ cog×phys_{subject} 逐认知 patch 重折叠；fixture hero 独占 800
//      physical × 800 认知 ≈ 320k 次折叠为最坏形态）→ 增量折叠后 ~7.0ms（折叠总量 320k → 800 次，
//      presence 投影成本 ≈ 双轴取数本身）≤ 20ms。cognition 7.2ms（groupBy 已足，cap 12 限流无
//      逐查询点乘积，不为达标硬改）+ 载波 1.01MB·~9ms 达标 → **gate 全指标达标：checkpoint 不
//      触发、窗收窄不触发、维持 defer（实测值记 deferred-work 收档）**。对拍锚 =
//      shared tests/cognition.test.ts S7 基线（修前实现内嵌 reference，deep-equal 全 fixture）。
//   ⑤ 延迟 + ANN 记档：KNN 规模曲线（1k / 实际档 / 5k / 20k / 50k，median×5）+ 50k 全
//      searchClosure 比率宽上限（≤ max(5k×15, 5s)，R6 撤 CI 环境分叉）+ 100k/1M 线性外推
//      → 「ANN 不需要」实测数据（结论落 epics 归收尾站，本站只出数据）。
//
// fixture（确定性合成，零网络零 LLM——全 DI seam stub）：
//   - 400 章 `ch_NNN.md`：段落 30-200 字分布 + 每 5 章显式转场标记（--- / *** / * * *）+ 每 7
//     章一个 620+ 字超长段（句读递归路径）+ 每 3 章对话段（多行块，不腰斩路径）+ 每章一个
//     唯一针语段（`针语NNN`——FTS 唯一命中锚）。分块基准 = S2 chunkChapter 直跑（期望单源）。
//   - embed stub 簇结构：文本内标记 → 簇心（seeded ±1 向量）+ 文本 hash 噪声。同章 chunk 同簇
//     近（cos 距离 ~0.001）、跨章/卡/摘要异簇远（~1.0）——查询向量 = 簇心 → 已知 ground-truth
//     最近邻。deprecated 卡噪声更小（更近簇心）构造 ③ 的饥饿几何。
//   - 条目：52 当铺卡（4 active + 48 deprecated）+ 8 常客卡 + 2 setting_md 长文（#body/#identity
//     双向量 → dedupe 断言）+ 400 章摘要行（synopsis 含章标 → chunk prefix 组料）。
//   - F 块：400 slices × 12 patches（cognitive 带 evidenceSceneId / physical /presence_scene /
//     emotional / relational，6 subjects ≈ 4800 patches）+ 40 mention 行。
//   - 50k 上限档 = 扩量 INSERT（xpad 段行，closure_entry + FTS trigger + entry_vec 三面同写）；
//     链端到端（分块→事务）由基础档 400 章走真索引器覆盖——扩量部分直接 INSERT 是时长取舍
//     （50k 走索引器 = 5 万次全文生成 + hash，对本站断言面零增益，见 ⑤ 内注释）。
//
// ⚠️ seeding 时序（级联失效）：insertWorldSlice 会按 episode_index>= / storyTime 镜像删已物化
// 章摘要（8.1 CR-5）——fixture 必须逐章交错「slice → summary → chunk 索引 → 摘要行」（mirror
// worldStateScale 的 write→materialize interleave），不能先种全量摘要再写 slices。
//
// 运行成本：本文件 Electron-as-Node 真跑实测见 afterAll 观测输出（预算 ~2.5 分钟；worldStateScale
// ~21s 是基础档参照，50k 灌库是本站大头）。
//
// Electron-as-Node 真跑（better-sqlite3 按 Electron ABI 重建，plain-Node vitest 下本 suite 会被
// ABI gate skip）：
//   cd apps/desktop/client/shell
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/retrievalScale.test.ts
// ─────────────────────────────────────────────────────────────────────────────

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateScale.test.ts / chapterChunkIndexer.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-retrieval-scale');
const PROJECT_DIR = path.join(TEST_HOME, 'scale-proj');

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
// loadProject mock（mirror chapterChunkIndexer.test.ts）：episode↔chapter 映射 + asset_cards
// 都在合成 DOC 上锚定（免写盘 project.yaml 整档）。
const { loadProject } = vi.hoisted(() => ({ loadProject: vi.fn() }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));

import { closeDb, getDb } from '../main/db/index';
import {
  CHAPTER_SOURCE_KIND,
  chapterEntryId,
  reindexChapter,
} from '../main/db/chapterChunkIndexer';
import { reindexChapterSummaryEntry } from '../main/db/chapterSummaryIndexer';
import { reindexAssetCards } from '../main/db/assetCardsIndexer';
import { reindexSettingMd } from '../main/db/settingMdIndexer';
import { searchClosure } from '../main/db/closureRetrieval';
import { EMBED_DIM, floatArrayToBuffer } from '../main/db/closureIndexer';
import { getCatalogEntry, listCatalogEntries } from '../main/db/catalogRepository';
import {
  evaluateRetrievalScaleGate,
  SCALE_GATE_THRESHOLDS,
} from '../main/db/retrievalScaleGate';
import {
  insertWorldSlice,
  listEpisodeStoryTimeWindows,
  listLastPatchFacts,
  listWorldPatches,
  upsertChapterSummary,
} from '../main/db/worldStateRepository';
import {
  aggregateMentionAppearance,
  upsertEpisodeMentions,
  type MentionRowInsert,
} from '../main/db/mentionLedgerRepository';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { ensureProject, getProject } from '../main/db/projectRepository';

// better-sqlite3 ABI gate（mirror worldStateScale.test.ts）：plain-Node vitest 下原生 addon
// ABI 不匹配时 skip 而非 fail。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

// ── fixture 规模参数（全确定性：seeded LCG + index 派生，无 Date.now / Math.random）──
const EPISODES = 400;
const LCG_SEED = 0x5eed_8103;
const PID_K1 = 'K1CURVE'; // 1k 曲线采样专属 partition（vec0 按 project_id 隔离 KNN 扫描面）

const PAWN_ACTIVE = 4;
const PAWN_DEPRECATED = 48;
const MISC_CARDS = 8;

const HERO_ID = 'hero-01';
const CORE_IDS = Array.from({ length: 5 }, (_, k) => `core-0${k + 1}`);

const pad3 = (n: number): string => String(n).padStart(3, '0');
const episodeId = (i: number): string => `ep-${pad3(i)}`;
const chapterId = (i: number): string => `ch_${pad3(i)}`;

/** Numerical Recipes LCG（imul + >>>0 无浮点漂移，跨平台确定性；mirror worldStateScale）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** FNV-1a 32-bit 字符串 hash → LCG seed（噪声向量按文本内容确定派生）。 */
function hashString(text: string): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193) >>> 0;
  }
  return h >>> 0;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function p95(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
}

// ── 合成中文文本生成器（词池 + seeded rng；词池不含任何保留标记词，针语/章标甲/卡档/设定档编号 唯一）──

const WORDS = [
  '孤城', '钟声', '旧约', '血债', '渡鸦', '枢机', '蛰伏', '集市', '王座', '密信',
  '当铺', '铁盒', '雨夜', '掌柜', '玉珏', '灯笼', '更夫', '码头', '盐商', '镖师',
] as const;
const ENDERS = ['。', '。', '。', '！', '？', '…'] as const;

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

/** 对话段（多行连续非空行 = 单一段落块——S2 对话不腰斩路径覆盖）。 */
function buildDialogue(rng: () => number): string {
  return [
    `「${buildSentence(rng, 6, 18)}」掌柜压低了声音。`,
    `「${buildSentence(rng, 6, 18)}」对方摇头。`,
    `「${buildSentence(rng, 6, 14)}」`,
  ].join('\n');
}

/** 620+ 字超长段（句读递归降级路径覆盖——单段 > CHUNK_MAX_CHARS 500）。 */
function buildLongParagraph(i: number): string {
  const rng = makeRng((LCG_SEED ^ (Math.imul(i + 7, 0x85eb_ca6b) >>> 0)) >>> 0);
  const parts: string[] = [];
  let len = 0;
  while (len < 620) {
    const s = buildSentence(rng, 12, 30);
    parts.push(s);
    len += s.length;
  }
  return parts.join('');
}

/** 每章唯一针语段（FTS trigram 唯一命中锚——`针语NNN` 全库只出现一次）。 */
function needleParagraph(i: number): string {
  return `巷口的更夫压低嗓子提起针语${pad3(i)}，又立刻噤声，仿佛那两个字会引来灾祸。`;
}

/** 章正文（每章 ~2-3k 字：标题段 + 14-18 正文段 + 可选转场标记/超长段/对话段/针语段）。 */
function genChapter(i: number): string {
  const rng = makeRng((LCG_SEED ^ (Math.imul(i + 1, 0x9e37_77b9) >>> 0)) >>> 0);
  const blocks: string[] = [
    `# 第${i + 1}章 ${WORDS[(i * 3) % WORDS.length]}${WORDS[(i * 7 + 5) % WORDS.length]}`,
  ];
  const paraCount = 14 + (i % 5);
  for (let k = 0; k < paraCount; k++) {
    if (k === 4 && i % 5 === 0) blocks.push(i % 10 === 0 ? '***' : '---'); // 显式转场标记（两形态）
    if (k === 9 && i % 10 === 3) blocks.push('* * *'); // 第三形态标记
    if (k === 6) {
      blocks.push(needleParagraph(i));
      continue;
    }
    if (k === 8 && i % 7 === 0) {
      blocks.push(buildLongParagraph(i));
      continue;
    }
    if (k === 11 && i % 3 === 0) {
      blocks.push(buildDialogue(rng));
      continue;
    }
    blocks.push(buildParagraph(rng, 30 + Math.floor(rng() * 171))); // 30-200 字段落分布
  }
  return blocks.join('\n\n');
}

/** 章梗概（含章簇标记 `章标甲NNN`——chunk index_text prefix 与摘要行共享的簇锚）。 */
function synopsisFor(i: number): string {
  return `临在${WORDS[(i * 3) % WORDS.length]}查访${WORDS[(i * 11 + 2) % WORDS.length]}的下落，旧约的线索再度浮出水面。章标甲${pad3(i)}。`;
}

function summaryFor(i: number): ChapterStateSummary {
  return {
    episodeId: episodeId(i),
    episodeIndex: i,
    storyTimeStart: i * 100 + 5,
    storyTimeEnd: i * 100 + 10,
    characterEndStates: [{ subjectId: HERO_ID, name: '临', type: 'character', state: { '/mood': '疑' } }],
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

// ── 合成条目（卡 / setting_md）──

interface FixtureCard {
  id: string;
  type: string;
  name: string;
  summary: string;
  status: string;
}

const pawnActiveIds = Array.from({ length: PAWN_ACTIVE }, (_, n) => `card-pawn-a${n}`);
const pawnDeprecatedIds = Array.from({ length: PAWN_DEPRECATED }, (_, n) => `card-pawn-d${n}`);
const miscCardIds = Array.from({ length: MISC_CARDS }, (_, m) => `card-misc-${m}`);

function fixtureCards(): FixtureCard[] {
  const cards: FixtureCard[] = [];
  for (let n = 0; n < PAWN_ACTIVE; n++) {
    cards.push({
      id: pawnActiveIds[n]!,
      type: 'character',
      name: `当铺守夜人${n}`,
      summary: `守夜人的来历与当铺交织。卡档押A${pad3(n)}。`,
      status: 'active',
    });
  }
  for (let n = 0; n < PAWN_DEPRECATED; n++) {
    cards.push({
      id: pawnDeprecatedIds[n]!,
      type: 'prop',
      name: `旧当票${n}`,
      summary: `一张盖了火印的旧当票。卡档押D${pad3(n)}。`,
      status: 'deprecated',
    });
  }
  for (let m = 0; m < MISC_CARDS; m++) {
    cards.push({
      id: miscCardIds[m]!,
      type: m < 5 ? 'character' : 'location',
      name: `常客${m}`,
      summary: `常客的习性记录。卡档典${pad3(m)}。`,
      status: 'draft',
    });
  }
  return cards;
}

/** setting_md 长文（#body + #identity 双向量 → ① dedupe 断言对象）。 */
const SETTING_DOCS: Array<{ file: string; id: string; title: string }> = [
  { file: 'pawnshop-rules.md', id: 'pawnshop-rules', title: '当铺典守（设定档编号Y0）' },
  { file: 'night-market.md', id: 'night-market', title: '夜市三巷（设定档编号Y1）' },
];

function settingDocContent(doc: { id: string; title: string }): string {
  const rng = makeRng(hashString(doc.id));
  const paras = Array.from({ length: 4 }, () => buildParagraph(rng, 120 + Math.floor(rng() * 120)));
  return [`---`, `id: ${doc.id}`, `type: world_rule`, `---`, ``, `# ${doc.title}`, ``, paras.join('\n\n')].join('\n');
}

// ── F 块 fixture（patches / mentions）──

/** 每 episode 12 patches：cognitive×7（带 evidenceSceneId）/ physical×2（presence_scene + hp）/ emotional×1 / relational×2。 */
function fixturePatches(i: number): WorldPatchInput[] {
  const patches: WorldPatchInput[] = [
    { subjectId: HERO_ID, path: '/knows/旧约', op: 'replace', value: '知', axis: 'cognitive', evidenceSceneId: `sc-${i}-odd` },
    { subjectId: HERO_ID, path: `/knows/线索${i % 3}`, op: 'replace', value: '疑', axis: 'cognitive', evidenceSceneId: `sc-${i}-odd` },
    { subjectId: HERO_ID, path: '/presence_scene', op: 'replace', value: `sc-${i}-even`, axis: 'physical' },
    { subjectId: HERO_ID, path: '/hp', op: 'replace', value: 40, axis: 'physical' },
    { subjectId: HERO_ID, path: '/mood', op: 'replace', value: '怒', axis: 'emotional' },
    ...CORE_IDS.map(
      (id) =>
        ({
          subjectId: id,
          path: '/knows/旧约',
          op: 'replace',
          value: '闻',
          axis: 'cognitive',
          evidenceSceneId: `sc-${i}-odd`,
        }) satisfies WorldPatchInput,
    ),
    { subjectId: 'core-01', path: '/trust', op: 'increment', value: 1, axis: 'relational', summary: '信任加深' },
    { subjectId: 'core-02', path: '/trust', op: 'increment', value: -1, axis: 'relational', summary: '生出嫌隙' },
  ];
  return patches;
}

function mentionRow(entryId: string): MentionRowInsert {
  return {
    entryId,
    presence: 'present',
    declared: 1,
    presenceShot: 0,
    coarseHit: 1,
    planLinked: 0,
    coarseCount: 1,
    stateChanged: 0,
    source: 'full',
  };
}

// ── embed stub（簇结构构造——已知 ground-truth 最近邻的可断言形态）──
//
// 文本标记 → 簇：`[梗概：` 前缀 + `章标甲NNN` → 章 N 的 chunk 簇；裸 `章标甲NNN`（摘要行 body
// 以 synopsis 领衔、无前缀）→ 摘要独立簇；`卡档押A/D`（同簇当铺卡，D 噪声更小 = 更近簇心——③
// 饥饿几何）；`卡档典` → 常客卡簇；`设定档编号Y` → 设定文档簇。簇心 = seeded ±1 向量（1024 维），
// 同簇 cos 距离 ~0.001，异簇 ~1.0——查询向量 = 簇心（exact）即得确定性的 top-k 排序。

let chapterEmbedBatches = 0; // reindexChapter 的 embedBatch 调用数（⑥ hash-skip 零重嵌断言）
let summaryEmbedBatches = 0; // reindexChapterSummaryEntry 的 embedBatch 调用数
let singleEmbedCalls = 0; // 卡 / setting_md 的单条 embed 调用数
let unknownClusterTexts = 0; // stub 收到无法分类的文本数（⑥ 断言 = 0——标记布放零漂移）

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

interface ClusterAssignment {
  cluster: string;
  noise: number;
}

const MARKER_CHAPTER = /章标甲(\d{3})/;
const MARKER_PAWN = /卡档押([AD])\d{3}/;
const MARKER_MISC = /卡档典\d{3}/;
const MARKER_SETTING = /设定档编号Y(\d)/;

function classifyText(text: string): ClusterAssignment | undefined {
  const ch = text.match(MARKER_CHAPTER);
  if (ch !== null) {
    // chunk 组料带 `[梗概：` prefix；摘要行 body 直接以 synopsis 领衔——同标记双簇分流。
    return text.startsWith('[梗概：')
      ? { cluster: `ch:${ch[1]}`, noise: 0.08 }
      : { cluster: 'summaries', noise: 0.06 };
  }
  const pawn = text.match(MARKER_PAWN);
  if (pawn !== null) {
    // deprecated（D）噪声 0.02 ≪ active（A）0.08 → 更近簇心——③ 的饥饿几何。
    return { cluster: 'card:pawn', noise: pawn[1] === 'A' ? 0.08 : 0.02 };
  }
  if (MARKER_MISC.test(text)) return { cluster: 'card:misc', noise: 0.08 };
  const setting = text.match(MARKER_SETTING);
  if (setting !== null) return { cluster: `setting:${setting[1]}`, noise: 0.08 };
  return undefined;
}

function stubVec(text: string): number[] {
  const cls = classifyText(text);
  if (cls === undefined) {
    unknownClusterTexts += 1;
    return noiseVec(text, 0.08); // 兜底：仍落确定性向量（⑥ 的 unknown=0 断言会抓到漂移）
  }
  const base = centroid(cls.cluster);
  const nz = noiseVec(text, cls.noise);
  return base.map((v, i) => v + nz[i]!);
}

/** 查询向量（searchClosure deps.embed 用）：簇心 exact（deprecated 饥饿几何的参照点）。 */
function queryVec(clusterKey: string): number[] {
  return centroid(clusterKey).slice();
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

// ── 50k 扩量（⑤ 上限档）──
//
// 扩量行直接 INSERT（closure_entry + FTS trigger + entry_vec 三面同写，单事务分批）。取舍：
// 50k 走真 reindexChapter = 5 万次全文生成 + 分块 + hash——对本站断言面（KNN 扫描成本 + 全查询
// 管线随规模的行为）零增益，链端到端真实性已由基础档 400 章覆盖（design §7「基础 400 章走索引器 +
// 扩量部分直接 INSERT」预案）。

const EXP_CLUSTERS = 40;
const expNoisePool: number[][] = Array.from({ length: 128 }, (_, j) => noiseVec(`exp-noise:${j}`, 0.08));

function expVec(n: number): number[] {
  const base = centroid(`exp:${n % EXP_CLUSTERS}`);
  const nz = expNoisePool[n % expNoisePool.length]!;
  return base.map((v, i) => v + nz[i]!);
}

let expansionN = 0;

function vecRowCount(pid: string): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM entry_vec WHERE project_id = ?').get(pid) as {
      n: number;
    }
  ).n;
}

/** 把主项目扩到 targetTotal 向量行（xpad 段行三面同写；分批事务控内存；id 跨调用续位）。 */
function expandVecPoolTo(targetTotal: number): void {
  const db = getDb();
  const add = targetTotal - vecRowCount(PID!);
  expect(add).toBeGreaterThan(0);
  const insEntry = db.prepare(
    `INSERT INTO closure_entry
       (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, content_hash, model, dim, chapter_id, chapter_index)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insVec = db.prepare(
    `INSERT INTO entry_vec
       (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const start = expansionN; // id 续位：第二次调用（5k→20k→50k）不得从 0 重开（UNIQUE PK）
  for (let offset = 0; offset < add; offset += 2000) {
    const end = Math.min(offset + 2000, add);
    db.transaction(() => {
      for (let j = offset; j < end; j++) {
        const n = start + j;
        const stem = `xpad${String(n).padStart(6, '0')}`;
        const entryId = `${PID}:${stem}#c0`;
        insEntry.run(
          entryId,
          PID,
          'chapter',
          'chapter',
          `扩容段${n}`,
          '扩容载荷。',
          'known',
          `expansion-${n}`,
          'text-embedding-3-test',
          EMBED_DIM,
          stem,
          null,
        );
        insVec.run(
          entryId,
          PID,
          entryId,
          'chapter',
          'chapter',
          'chunk',
          '',
          'known',
          floatArrayToBuffer(expVec(n)),
        );
      }
    })();
  }
  expansionN += add;
}

/** 1k 曲线采样专属 partition（raw KNN 不 JOIN closure_entry——vec0 按 project_id 隔离扫描面）。 */
function seedCurvePartition(pid: string, rows: number): void {
  const db = getDb();
  const insVec = db.prepare(
    `INSERT INTO entry_vec
       (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  db.transaction(() => {
    for (let n = 0; n < rows; n++) {
      const id = `${pid}:c${n}`;
      insVec.run(id, pid, id, 'chapter', 'chapter', 'chunk', '', 'known', floatArrayToBuffer(expVec(500000 + n)));
    }
  })();
}

/** raw KNN 单查询 median（k=10 cosine；warmup 一次进页缓存后计时——记录稳态非冷启动）。 */
function knnMedianMs(pid: string, qvec: Buffer, rounds = 5): number {
  const stmt = getDb().prepare(
    'SELECT entry_id, distance FROM entry_vec WHERE embedding MATCH ? AND k = ? AND project_id = ?',
  );
  stmt.all(qvec, 10, pid);
  const times: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    stmt.all(qvec, 10, pid);
    times.push(performance.now() - t0);
  }
  return median(times);
}

// ── describe 级共享观测（beforeAll 产出，its 复用）──

let PID: string | undefined;
const expectedChunkCounts: number[] = [];
let chapterLoopMs = 0;
let fixtureTotalChunks = 0;
let baseVecRows = 0; // 基础档向量行数（beforeAll 末快照——⑤ 扩容后 afterAll 仍报基础档）

function clean(): void {
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

describe.skipIf(!sqliteUsable)('retrieval 合成规模压测（Story 8.3 S6 — 检索不崩 + ANN 记档）', () => {
  beforeAll(
    async () => {
      clean();
      mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
      mkdirSync(path.join(PROJECT_DIR, 'chapters'), { recursive: true });
      mkdirSync(path.join(PROJECT_DIR, 'settings'), { recursive: true });
      getDb();
      // vec 扩展是本 suite 的核心对象：Electron 真跑下缺失 = 打包回归（sqliteVecLoader
      // best-effort 契约），响亮失败而非静默降级后全 suite 假红。
      expect(isSqliteVecAvailable()).toBe(true);

      ensureProject({
        name: 'ScaleFixture',
        type: 'novel',
        localFingerprint: path.resolve(PROJECT_DIR),
        path: path.resolve(PROJECT_DIR),
      });
      PID = getProject(path.resolve(PROJECT_DIR))!.projectId;
      loadProject.mockReturnValue({
        episode_outlines: Array.from({ length: EPISODES }, (_, i) => ({ id: episodeId(i), index: i })),
        novel: { chapters: Array.from({ length: EPISODES }, (_, i) => ({ id: chapterId(i), sort_order: i })) },
        asset_cards: fixtureCards(),
      });

      const chapterDeps = {
        resolveModel: () => stubModel(),
        embedBatch: async (_m: ResolvedModel, texts: string[]) => {
          chapterEmbedBatches += 1;
          return texts.map(stubVec);
        },
      };
      const summaryDeps = {
        resolveModel: () => stubModel(),
        embedBatch: async (_m: ResolvedModel, texts: string[]) => {
          summaryEmbedBatches += 1;
          return texts.map(stubVec);
        },
      };

      // 章文件 + 期望分块单源（S2 分块器直跑——索引器行为对拍基准）。
      const chapterTexts: string[] = [];
      for (let i = 0; i < EPISODES; i++) {
        chapterTexts[i] = genChapter(i);
        writeFileSync(path.join(PROJECT_DIR, 'chapters', `${chapterId(i)}.md`), chapterTexts[i], 'utf-8');
        expectedChunkCounts[i] = chunkChapter(chapterTexts[i]).length;
      }
      fixtureTotalChunks = expectedChunkCounts.reduce((a, b) => a + b, 0);

      // 逐章交错（级联失效时序，见文件头）：slice → summary → chunk 索引 → 摘要行。
      const subjects: WorldSubject[] = [
        { id: HERO_ID, type: 'character', name: '临', firstSeenStoryTime: 10 },
        ...CORE_IDS.map((id, k) => ({ id, type: 'character', name: `枢${k + 1}`, firstSeenStoryTime: 10 })),
      ];
      const t0 = performance.now();
      for (let i = 0; i < EPISODES; i++) {
        insertWorldSlice(
          PID!,
          { id: `${episodeId(i)}:${i * 100 + 10}`, storyTime: i * 100 + 10, title: `第${i + 1}章切面`, episodeId: episodeId(i) },
          fixturePatches(i),
          i === 0 ? subjects : [],
          'derived',
        );
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
        await reindexChapterSummaryEntry(PID!, PROJECT_DIR, episodeId(i), summaryDeps);
      }
      chapterLoopMs = performance.now() - t0;

      // 条目：卡（reindexAssetCards 全量真索引器）+ setting_md（双向量）+ mention 账。
      const singleDeps = {
        resolveModel: () => stubModel(),
        embed: async (_m: ResolvedModel, body: string) => {
          singleEmbedCalls += 1;
          return stubVec(body);
        },
      };
      const cardReport = await reindexAssetCards(path.resolve(PROJECT_DIR), singleDeps);
      expect(cardReport.reindexed).toBe(PAWN_ACTIVE + PAWN_DEPRECATED + MISC_CARDS);
      for (const doc of SETTING_DOCS) {
        const filePath = path.join(PROJECT_DIR, 'settings', doc.file);
        writeFileSync(filePath, settingDocContent(doc), 'utf-8');
        const ok = await reindexSettingMd(PROJECT_DIR, filePath, {
          ...singleDeps,
          resolveSummaryModel: () => null,
        });
        expect(ok).toBe(true);
      }
      for (let k = 0; k < 5; k++) {
        upsertEpisodeMentions(PID!, episodeId(k * 80), miscCardIds.map(mentionRow));
      }
      baseVecRows = vecRowCount(PID!);
    },
    300_000,
  );

  afterAll(() => {
    if (sqliteUsable && PID !== undefined) {
      console.log(
        `[retrievalScale] fixture：${EPISODES} 章 → ${fixtureTotalChunks} chunks（slice+summary+chunk+摘要行 交错灌库 ${Math.round(chapterLoopMs)}ms，` +
          `stub embed：章批 ${chapterEmbedBatches} + 摘要 ${summaryEmbedBatches} + 单条 ${singleEmbedCalls}）` +
          `；基础档向量行 ${baseVecRows}（50k 扩量仅 ⑤ 内）`,
      );
    }
    clean();
  });

  it(
    '① 构造最近邻召回：同章 chunk 簇 recall@10=100%（暴力精确）+ per-chunk 各占席 + 摘要/卡独立簇 + setting_md 双向量单席（dedupe 双语义）',
    async () => {
      const target = 42;
      const expected = Array.from({ length: expectedChunkCounts[target]! }, (_, n) =>
        chapterEntryId(PID!, chapterId(target), n),
      );
      expect(expected.length).toBeGreaterThanOrEqual(4); // 非空转：目标章有足量 chunk

      const hits = await searchClosure(PID!, '*', { k: 10 }, {
        resolveModel: () => stubModel(),
        embed: async () => queryVec(`ch:${pad3(target)}`),
        resolveRerankModel: () => null,
      });
      // recall@10 = 100%（暴力精确——构造性最近邻）+ 同章多 chunk 各占席（per-chunk 独立排名）。
      const hitIds = hits.map((h) => h.entryId);
      expect(hitIds.filter((id) => expected.includes(id))).toHaveLength(expected.length);
      // 前 expected.length 席全是目标章 chunk（簇内距离 ~0.001 vs 异簇 ~1.0，排序确定）。
      expect(hitIds.slice(0, expected.length).every((id) => expected.includes(id))).toBe(true);
      for (const h of hits.slice(0, expected.length)) {
        expect(h.vectorKind).toBe('chunk');
        expect(h.sourceKind).toBe(CHAPTER_SOURCE_KIND);
        expect(h.entryType).toBe('chapter');
        expect(h.chapterId).toBe(chapterId(target));
        expect(h.chapterIndex).toBe(target);
        expect(h.charStart).toBeDefined();
        expect(h.charEnd).toBeDefined();
        expect(h.paraStart).toBeDefined();
        expect(h.paraEnd).toBeDefined();
        expect(h.bodyText).not.toContain('[梗概：'); // 返回原文非组料
      }

      // 摘要独立簇：摘要行查询命中 source_kind='chapter_summary'（与章 chunk 簇分离）。
      const sumHits = await searchClosure(PID!, '*', { k: 10 }, {
        resolveModel: () => stubModel(),
        embed: async () => queryVec('summaries'),
        resolveRerankModel: () => null,
      });
      expect(sumHits).toHaveLength(10);
      expect(sumHits.every((h) => h.sourceKind === 'chapter_summary')).toBe(true);
      expect(sumHits.every((h) => h.vectorKind === 'body')).toBe(true);

      // 卡独立簇：当铺卡簇命中卡行（status 过滤面归 ③）。
      const cardHits = await searchClosure(PID!, '*', { k: 10 }, {
        resolveModel: () => stubModel(),
        embed: async () => queryVec('card:misc'),
        resolveRerankModel: () => null,
      });
      expect(cardHits.length).toBeGreaterThanOrEqual(MISC_CARDS);
      expect(cardHits.slice(0, MISC_CARDS).every((h) => miscCardIds.includes(h.entryId))).toBe(true);

      // setting_md 双向量单席：entry_vec 两行（#body + #identity）→ vec_best per-entry dedupe →
      // 结果一席（卡类单 #body 的对偶面——dedupe 双语义）。
      const settingEntryId = `${PID}:pawnshop-rules`;
      const vecRows = getDb()
        .prepare('SELECT vector_id, vector_kind FROM entry_vec WHERE entry_id = ?')
        .all(settingEntryId) as Array<{ vector_id: string; vector_kind: string }>;
      expect(vecRows).toHaveLength(2);
      expect(new Set(vecRows.map((r) => r.vector_kind))).toEqual(new Set(['body', 'identity']));
      const setHits = await searchClosure(PID!, '*', { k: 10 }, {
        resolveModel: () => stubModel(),
        embed: async () => queryVec('setting:0'),
        resolveRerankModel: () => null,
      });
      expect(setHits.filter((h) => h.entryId === settingEntryId)).toHaveLength(1);
      expect(setHits[0]!.entryId).toBe(settingEntryId);

      console.log(
        `[retrievalScale] ① 召回：ch42 ${expected.length} chunks recall@10=${(hitIds.filter((id) => expected.includes(id)).length / expected.length) * 100}%；` +
          `摘要簇 top10 全 chapter_summary；setting_md 双向量 → 单席（vec_kind=${setHits[0]!.vectorKind}）`,
      );
    },
    60_000,
  );

  it(
    '② FTS trigram：正文原句唯一命中 + 梗概语义词经 prefix 命中正文段（返回原文非组料）+ RRF 双臂 score > 单臂',
    async () => {
      const target = 42;
      const expected = Array.from({ length: expectedChunkCounts[target]! }, (_, n) =>
        chapterEntryId(PID!, chapterId(target), n),
      );

      // 正文原句（needle）唯一命中：`针语042` 全库一处 → 恰一 chunk。
      const needleHits = await searchClosure(PID!, `针语${pad3(target)}`, { k: 10 }, { resolveModel: () => null });
      const needleMatched = needleHits.filter((h) => h.bodyText.includes(`针语${pad3(target)}`));
      expect(needleMatched).toHaveLength(1);
      expect(needleMatched[0]!.chapterId).toBe(chapterId(target));
      expect(needleMatched[0]!.bodyText).not.toContain('[梗概：');

      // 梗概语义词路径：`章标甲042` 只存在于 synopsis → 正文段经 index_text prefix 命中（返回
      // 原文不含该词）+ 摘要行本体以 synopsis 领衔直接命中（body 含词）——两路径一并锁死。
      const prefixHits = await searchClosure(PID!, `章标甲${pad3(target)}`, { k: 20 }, { resolveModel: () => null });
      const summaryEntryId = `${PID}:${episodeId(target)}#summary`;
      expect(prefixHits.map((h) => h.entryId).sort()).toEqual([...expected, summaryEntryId].sort());
      for (const h of prefixHits) {
        expect(h.ftsRank).toBeDefined();
        if (h.entryId === summaryEntryId) {
          expect(h.sourceKind).toBe('chapter_summary');
          expect(h.bodyText).toContain(`章标甲${pad3(target)}`); // 摘要行 body = synopsis 领衔拼料
        } else {
          expect(h.bodyText).not.toContain(`章标甲${pad3(target)}`); // 正文段返回原文——词只经 prefix 组料命中
        }
      }

      // RRF 融合序：needle chunk 双臂命中（FTS 唯一 rank1 + vec 臂同章簇）→ score > 任何单臂项。
      const dual = await searchClosure(PID!, `针语${pad3(target)}`, { k: 10 }, {
        resolveModel: () => stubModel(),
        embed: async () => queryVec(`ch:${pad3(target)}`),
        resolveRerankModel: () => null,
      });
      const dualItem = dual.find((h) => h.bodyText.includes(`针语${pad3(target)}`))!;
      expect(dualItem).toBeDefined();
      // ftsRank 暴露的是 FTS5 bm25 原始 rank（负值，越小越好——非 1-based rn）；needle 是
      // 唯一 FTS 命中 → rn=1，此处断言「双臂齐备」：bm25 rank 存在（<0）+ vec 距离存在。
      expect(dualItem.ftsRank).toBeLessThan(0);
      expect(dualItem.vecDistance).toBeDefined();
      const singleArmMax = Math.max(...dual.filter((h) => h !== dualItem).map((h) => h.score));
      expect(dualItem.score).toBeGreaterThan(singleArmMax);
      expect(dual[0]!.entryId).toBe(dualItem.entryId);

      console.log(
        `[retrievalScale] ② FTS：needle 唯一命中（${needleMatched[0]!.entryId}）；prefix 路径 ${expected.length} chunk（bodyText 原文零 prefix 词）+ 1 摘要行（body 本体含词）双路径命中；` +
          `RRF 双臂 score=${dualItem.score.toFixed(5)} > 单臂 max=${singleArmMax.toFixed(5)}`,
      );
    },
    60_000,
  );

  it(
    '③ CR-005：deprecated 多数簇（48:4）上 status:active 的 vec 召回 = 基线（4/4 完全，KNN 内预剪枝；sentinel 行不混入）',
    async () => {
      // 饥饿几何实锤：deprecated 噪声 0.02 ≪ active 0.08 → 未过滤 KNN top-40 全被 48 张
      // deprecated 占据——8.7「post-KNN 过滤 + vecK 补偿」形态在此几何下必然塌缩（补偿耗尽
      // 也捞不回 active）。本断言证明下方「active 全命中」有牙齿（不是随便都能过）。
      const raw = getDb()
        .prepare('SELECT entry_id FROM entry_vec WHERE embedding MATCH ? AND k = ? AND project_id = ?')
        .all(floatArrayToBuffer(queryVec('card:pawn')), 40, PID!) as Array<{ entry_id: string }>;
      expect(raw).toHaveLength(40);
      const deprecatedSet = new Set(pawnDeprecatedIds);
      expect(raw.every((r) => deprecatedSet.has(r.entry_id))).toBe(true);

      // 修复后（S4：status 进 vec0 metadata，KNN 内预剪枝）：k 预算只花在匹配行上——
      // active 检索召回 = 基线（4/4 完全）；FTS 词零命中（'枢纽问询' 不在任何索引文本）→ 纯 vec 臂。
      const activeHits = await searchClosure(PID!, '枢纽问询', { k: 10, status: 'active' }, {
        resolveModel: () => stubModel(),
        embed: async () => queryVec('card:pawn'),
        resolveRerankModel: () => null,
      });
      expect(activeHits.map((h) => h.entryId).sort()).toEqual(pawnActiveIds.slice().sort());
      // '' sentinel（chunk/setting_md/摘要）与 deprecated 都不混入——sourceKind 全卡行。
      expect(activeHits.every((h) => h.sourceKind === 'setting_card')).toBe(true);

      console.log(
        `[retrievalScale] ③ CR-005：未过滤 KNN top-40 全 deprecated（饥饿几何实锤，8.7 补偿形态必塌缩）；` +
          `status:'active' 检索召回 ${activeHits.length}/${PAWN_ACTIVE} = 基线（完全）——KNN 内 metadata 预剪枝生效`,
      );
    },
    60_000,
  );

  it('③b 目录面排除：catalog total 只含实体行（chunk/摘要不淹没）+ get_entry 对 chunk id miss', () => {
    const catalog = listCatalogEntries(PID!, { offset: 0, limit: 100 });
    // 实体 = 60 卡 + 2 setting_md；数百 chunk 行 + 400 摘要行不进目录。
    expect(catalog.total).toBe(PAWN_ACTIVE + PAWN_DEPRECATED + MISC_CARDS + SETTING_DOCS.length);
    expect(catalog.rows).toHaveLength(catalog.total);
    expect(catalog.rows.every((r) => r.entryType !== 'chapter' && r.entryType !== 'chapter_summary')).toBe(true);

    // get_entry：chunk entry_id 友好 miss（正文核对走 chapter_read + 段级出处）；卡正常下钻。
    expect(getCatalogEntry(PID!, chapterEntryId(PID!, chapterId(42), 0))).toBeUndefined();
    const card = getCatalogEntry(PID!, miscCardIds[0]!);
    expect(card).toBeDefined();
    expect(card!.status).toBe('draft');

    console.log(
      `[retrievalScale] 3b 目录排除：total=${catalog.total}（${fixtureTotalChunks} chunk 行 + ${EPISODES} 摘要行之外）；get_entry(chunk id) miss / get_entry(card) ok`,
    );
  });

  it('④ gap_stats 取数规模：per-subject/per-entry 聚合行 vs 全量行数量级（行为对拍归 S5 parity suite）', () => {
    const totalPatches = listWorldPatches(PID!).length;
    const facts = listLastPatchFacts(PID!);
    expect(facts).toHaveLength(6); // hero + 5 cores
    expect(totalPatches).toBeGreaterThan(6 * 100); // 数量级差：聚合行 ≪ 全量行

    const windows = listEpisodeStoryTimeWindows(PID!);
    expect(windows).toHaveLength(EPISODES); // 轻列窗行 = 章数（非 summary JSON 全文行）

    const mentionAggs = aggregateMentionAppearance(PID!);
    expect(mentionAggs).toHaveLength(MISC_CARDS); // per-entry 行 vs 40 全量 mention 行

    console.log(
      `[retrievalScale] ④ gap_stats 取数规模：patches ${totalPatches} 行 → per-subject ${facts.length} 行；` +
        `章摘要 ${windows.length} 轻列窗行；mention ${MISC_CARDS * 5} 行 → per-entry ${mentionAggs.length} 行` +
        `（deep-equal 对拍由 gapStatsFetchParity.test.ts 守，本站只证规模）`,
    );
  });

  it(
    '⑥ chunk 索引管线：行数 = Σ分块数 + hash-skip 零重嵌（embed 计数）+ 章删除 orphan 清行',
    async () => {
      const db = getDb();
      // 行数一致性：真 reindexChapter 灌库行数 = S2 分块器期望（ch_ 前缀章，不含扩量 xpad 行）。
      const chapterRows = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND substr(chapter_id,1,3)='ch_'",
          )
          .get(PID!) as { n: number }
      ).n;
      expect(chapterRows).toBe(fixtureTotalChunks);
      const chapterVecRows = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM entry_vec WHERE project_id=? AND source_kind='chapter' AND substr(entry_id, ?, 4)=':ch_'",
          )
          .get(PID!, PID!.length + 1) as { n: number }
      ).n;
      expect(chapterVecRows).toBe(fixtureTotalChunks);

      // 章重写幂等：同组料重跑 → hash-skip，embedBatch 零新增（stub 调用计数）。
      const batchesBefore = chapterEmbedBatches;
      for (const i of [0, 100, 200]) {
        const res = await reindexChapter(PID!, PROJECT_DIR, chapterId(i), {
          resolveModel: () => stubModel(),
          embedBatch: async (_m: ResolvedModel, texts: string[]) => {
            chapterEmbedBatches += 1;
            return texts.map(stubVec);
          },
        });
        expect(res.outcome).toBe('hash-skip');
      }
      expect(chapterEmbedBatches).toBe(batchesBefore);

      // 章删除 orphan 清行：文件 unlink → reindex → 行清（entry + vec + FTS trigger）。
      rmSync(path.join(PROJECT_DIR, 'chapters', `${chapterId(398)}.md`));
      const del = await reindexChapter(PID!, PROJECT_DIR, chapterId(398), {
        resolveModel: () => stubModel(),
        embedBatch: async (_m: ResolvedModel, texts: string[]) => texts.map(stubVec),
      });
      expect(del.outcome).toBe('missing');
      const afterRows = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM closure_entry WHERE project_id=? AND source_kind='chapter' AND chapter_id=?",
          )
          .get(PID!, chapterId(398)) as { n: number }
      ).n;
      expect(afterRows).toBe(0);
      const afterVec = (
        db.prepare('SELECT COUNT(*) AS n FROM entry_vec WHERE project_id=? AND entry_id LIKE ?').get(
          PID!,
          `${PID}:${chapterId(398)}#%`,
        ) as { n: number }
      ).n;
      expect(afterVec).toBe(0);

      // embed stub 分类零未知（标记布放零漂移——所有进 stub 的文本都落在预期簇）。
      expect(unknownClusterTexts).toBe(0);

      console.log(
        `[retrievalScale] ⑥ chunk 管线：${EPISODES} 章 → ${fixtureTotalChunks} 行（= Σ分块数，entry+vec+FTS 三面一致）；` +
          `hash-skip 零重嵌（embed 批 ${batchesBefore} 不变）；ch_398 unlink → 清行；交错灌库循环 ${Math.round(chapterLoopMs)}ms（${(chapterLoopMs / EPISODES).toFixed(1)}ms/章，stub embed，记录性）`,
      );
    },
    60_000,
  );

  it(
    '⑦ F 块观测与判定：cognition/presence 折叠输入量 + P95 + 载波 payload/fetch → 阈值闸结论（S7 条件站依据）',
    () => {
      // 投影采样：20 个 at 点（fetch〔S5 轴预过滤〕+ fold 合计 = 消费者真实成本形态）。
      const ats = Array.from({ length: 20 }, (_, k) => (k * 20 + 19) * 100 + 10);
      const cognitionMs: number[] = [];
      const presenceMs: number[] = [];
      let earlyCognitionInput = 0;
      let lateCognitionInput = 0;
      let lateDualInput = 0;
      let cognitionChars = 0;
      let presenceSignals = 0;
      for (let k = 0; k < ats.length; k++) {
        const at = ats[k]!;
        let t = performance.now();
        const cognitive = listWorldPatches(PID!, undefined, at, 'cognitive');
        const snap = buildCognitionSnapshot(cognitive);
        cognitionMs.push(performance.now() - t);
        t = performance.now();
        const dual = listWorldPatches(PID!, undefined, at, ['cognitive', 'physical']);
        presenceSignals = buildPresenceSignal(dual).length;
        presenceMs.push(performance.now() - t);
        if (k === 0) earlyCognitionInput = cognitive.length;
        lateCognitionInput = cognitive.length;
        lateDualInput = dual.length;
        if (snap) cognitionChars = snap.characters.length;
      }
      const cognitionP95 = p95(cognitionMs);
      const presenceP95 = p95(presenceMs);

      // 非空转 + 线性增长（计数断言——B5 形态的满配版：投影输入 O(总史) 线性涨）。
      expect(earlyCognitionInput).toBeGreaterThan(0);
      expect(lateCognitionInput).toBeGreaterThan(earlyCognitionInput * 4);
      expect(lateDualInput).toBeGreaterThan(lateCognitionInput);
      expect(cognitionChars).toBeGreaterThan(0);
      expect(presenceSignals).toBeGreaterThan(0);

      // 载波：fetchWorldPatchesViaTool 等价（全量行 JSON 字节 = IPC payload 形态）+ 全量取数耗时。
      const tFetch = performance.now();
      const allPatches = listWorldPatches(PID!);
      const fullFetchMs = performance.now() - tFetch;
      const payloadBytes = Buffer.byteLength(JSON.stringify(allPatches), 'utf8');
      expect(allPatches.length).toBe(EPISODES * 12);

      const verdict = evaluateRetrievalScaleGate({ cognitionP95Ms: cognitionP95, presenceP95Ms: presenceP95, payloadBytes, fullFetchMs });
      console.log(
        `[retrievalScale] F-block: projection P95=cognition ${cognitionP95.toFixed(2)}ms / presence ${presenceP95.toFixed(2)}ms ` +
          `(>20ms? ${verdict.checkpointNeeded ? 'YES → S7 checkpoint' : 'no → checkpoint 不触发'}), ` +
          `payload=${(payloadBytes / 1024 / 1024).toFixed(2)}MB, fetch=${fullFetchMs.toFixed(1)}ms ` +
          `(>5MB 或 >100ms? ${verdict.windowNarrowingNeeded ? 'YES → S7 窗收窄' : 'no → 窗收窄不触发'}) → ` +
          `${verdict.maintainDefer ? '维持 defer（实测值记 deferred-work 收档）' : '进入 S7 条件站'}`,
      );
      for (const reason of verdict.reasons) console.log(`[retrievalScale] F-block: ${reason}`);
      console.log(
        `[retrievalScale] F-block 输入量：ch19 cognitive=${earlyCognitionInput} → ch399 cognitive=${lateCognitionInput}` +
          `（${(lateCognitionInput / earlyCognitionInput).toFixed(1)}x 线性）/ 双轴=${lateDualInput}；cognition chars=${cognitionChars}，presence signals=${presenceSignals}`,
      );
      console.log(
        `[retrievalScale] F-block 口径注：fixture 轴分布按投影消费轴加权（cognitive×7+physical×2 / 12），` +
          `比 worldStateScale 均匀五轴形态重 ~2.6x。S7 终局（路径 A 调用内增量折叠）：presence ` +
          `${presenceP95.toFixed(2)}ms（演进：129.79 全量扫描 → 116.3 groupBy → 增量折叠，320k→800 次折叠）` +
          `——超阈与否按修后数字判，阈值 20ms 不变`,
      );

      // 判定闸牙齿（纯函数边界：超阈输入必翻转——供 S7 复用时的行为锚）。
      expect(
        evaluateRetrievalScaleGate({ cognitionP95Ms: 999, presenceP95Ms: 0, payloadBytes: 1, fullFetchMs: 1 })
          .checkpointNeeded,
      ).toBe(true);
      expect(
        evaluateRetrievalScaleGate({ cognitionP95Ms: 0, presenceP95Ms: 0, payloadBytes: 6 * 1024 * 1024, fullFetchMs: 1 })
          .windowNarrowingNeeded,
      ).toBe(true);
      expect(
        evaluateRetrievalScaleGate({
          cognitionP95Ms: SCALE_GATE_THRESHOLDS.projectionP95Ms,
          presenceP95Ms: 0,
          payloadBytes: SCALE_GATE_THRESHOLDS.payloadBytes,
          fullFetchMs: SCALE_GATE_THRESHOLDS.fullFetchMs,
        }).maintainDefer,
      ).toBe(true); // 恰等阈值 = 达标（> 才触发）
    },
    60_000,
  );

  it(
    '⑤ 延迟 + 规模曲线（1k/实际/5k/20k/50k）+ 50k 全查询比率宽上限（≤ max(5k×15, 5s)）+ ANN 记档外推',
    async () => {
      const q = floatArrayToBuffer(queryVec('curve:q')); // 独立簇心（不命中任何实体——纯扫描成本）

      // 曲线点 1k：专属 partition（vec0 KNN 按 project_id 隔离扫描面；raw KNN 不 JOIN）。
      seedCurvePartition(PID_K1, 1000);
      const curve: Array<{ label: string; rows: number; ms: number }> = [
        { label: '1k', rows: vecRowCount(PID_K1), ms: knnMedianMs(PID_K1, q) },
        { label: `实际档(${EPISODES}章)`, rows: vecRowCount(PID!), ms: knnMedianMs(PID!, q) },
      ];

      const medianFullSearchMs = async (): Promise<{ medianMs: number; hits: number }> => {
        const times: number[] = [];
        let hits = 0;
        for (let r = 0; r < 5; r++) {
          const t0 = performance.now();
          const res = await searchClosure(PID!, '针语007', { k: 10 }, {
            resolveModel: () => stubModel(),
            embed: async () => queryVec('ch:007'),
            resolveRerankModel: () => null,
          });
          times.push(performance.now() - t0);
          hits = res.length;
        }
        return { medianMs: median(times), hits };
      };

      // 5k 档（实际档扩容到整 5k——AC-2 的「实际规模档」）。
      expandVecPoolTo(5_000);
      const full5k = await medianFullSearchMs();
      curve.push({ label: '5k', rows: vecRowCount(PID!), ms: knnMedianMs(PID!, q) });

      // 20k / 50k 上限档。
      expandVecPoolTo(20_000);
      curve.push({ label: '20k', rows: vecRowCount(PID!), ms: knnMedianMs(PID!, q) });
      expandVecPoolTo(50_000);
      const knn50k = knnMedianMs(PID!, q);
      curve.push({ label: '50k', rows: vecRowCount(PID!), ms: knn50k });
      const full50k = await medianFullSearchMs();

      // 基线 sanity 前置（CR-016）：5k 正常 ~20ms 量级，2s 上限只拦病态——机器
      // 停顿把 5k 基线抬高时比率上限随之膨胀（full5k×15），50k 真回归会漏网
      // （比率断言失效开门）；基线病态先红本行再谈比率。
      expect(full5k.medianMs).toBeLessThan(2_000);
      // 宽上限断言（防架构回归——非精确性能断言；expected 量级 ~50-150ms）。比率形态：
      // ceiling = max(5k×15, 5s)。50k 行数 = 5k 的 10 倍，15 倍上限 ≈ 粗模 10 倍冗余
      // 线性保住；5s 宽绝对上限防挂死。同机自参照（5k 实测作基线）对 CI 共享 runner
      // 的负载噪声天然免疫（windows-latest 同负载可到本机 3-7×，环境分叉已撤）——
      // 量级保护不变（回归会到秒级/超时，比率/绝对双闸必拦）。
      const fullSearchCeiling = Math.max(full5k.medianMs * 15, 5_000);
      expect(full50k.medianMs).toBeLessThan(fullSearchCeiling);
      expect(full50k.hits).toBe(10);

      const extrapolate = (rows: number): number => (knn50k * rows) / 50_000;
      console.log(
        `[retrievalScale] ⑤ KNN 规模曲线（k=10 cosine，median×5）：` +
          curve.map((c) => `${c.label}=${c.ms.toFixed(1)}ms(${c.rows}行)`).join(' | '),
      );
      console.log(
        `[retrievalScale] ⑤ 全 searchClosure（k=10，stub rerank，median×5）：5k=${full5k.medianMs.toFixed(1)}ms / 50k=${full50k.medianMs.toFixed(1)}ms（比率宽上限 ≤ max(5k×15, 5s)=${fullSearchCeiling.toFixed(0)}ms 过，无环境分叉）`,
      );
      console.log(
        `[retrievalScale] ANN 记档：sqlite-vec 暴力 50k×1024 实测 ${knn50k.toFixed(1)}ms，线性外推 100k≈${extrapolate(100_000).toFixed(0)}ms / 1M≈${extrapolate(1_000_000).toFixed(0)}ms —— ` +
          `引 2026-07-23 选型复核裁决（维持 sqlite-vec 暴力、不换不等）+ 本次实测背书 → 「ANN 不需要」（数据供 8.3 定案注记落 epics，本站不写 epics）`,
      );
    },
    300_000,
  );
});
