import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHECKPOINT_MIN_PATCH_DELTA,
  buildCognitionSnapshot,
  buildCompileReport,
  buildPresenceSignal,
  buildWorldStateSnapshot,
  collectAsOfInvariantViolations,
  collectChapterWindowViolations,
  DEFAULT_COMPILE_THRESHOLDS,
  estimateSettingsSegments,
  sceneNodeSchema,
  type ChapterBrief,
  type PinnedPrefixItem,
  type SceneNode,
  type WorldPatchInput,
  type WorldSubject,
} from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.1 Step 7：合成规模压测——AC「百万字规模成本有界」的证明（implement.md Step 7）。
//
// 断言主体是 **fold/观测计数**（patchesFolded / 行数 / token 估算），非 wall-time（防 flake）；
// wall-time 仅记录性输出（8.3 评估数据）。七组断言：
//   B1 checkpoint 稳态后高频 subject 单次 reduce 的 fold 窗 ≤ CHECKPOINT_MIN_PATCH_DELTA +
//      单章窗增量（对照：同 at 无 checkpoint 世界要 fold O(全史) patches）
//   B2 成本与总史解耦：第 50 章 vs 第 350 章物化后观测同量级（全量 fold 侧同期 ~7x 线性涨）
//   B3 summary 行数 = episode 数 + token 有界 + truncated 比例 + dormant 不进终态 + 新实体/⑤⑥ spot
//   B4 全链等价抽查：3 个 at 点 checkpointed snapshot vs 全量 fold snapshot deep-equal
//   B5 吞吐观测（记录性）：整批物化 + 采样 fold 总量 + cognition/presence 全 fold 输入规模
//      （defer 8.3 的决策数据，design §7/§10）+ checkpoint 行数 ≈ O(patches/25)
//   B6 同切点互恰（Story 8.4 C2/C3，design §3.4 断言①）：400 章合成数据抽切点跑 INV-1/2/3/5
//      ——对拍器单源 import shared `collectAsOfInvariantViolations` / `collectChapterWindowViolations`
//      （Step 9 从 tests/as-of-invariants.test.ts 提升的纯函数，不复制粘贴断言逻辑）+ 非空转
//      证明（各不变量输入面在合成数据非空，防空 fixture 恒真过）。
//   B7 总额有界（Story 8.4 B 段，design §3.4 断言②）：满配热层（多角色多场——12 场 × 12-subject
//      真实 400 章末状态快照 + 20 伏笔任务 + 30 未决决策 + 20 操控指令 + 20 弧走向 + 设定侧 30 卡
//      满配前缀）buildCompileReport total < DEFAULT_COMPILE_THRESHOLDS.warn——证「正常写作永不触发
//      降级」（B2 阈值=机械异常量级定位）的规模侧背书。
//
// fixture 规模参数（确定性合成，无 LLM / 无 Date.now / 无 Math.random——seeded LCG + index 派生）：
//   400 episodes × 2-4 slices × 3-8 patches（8.4 扩展后实测 1100 slices / 5419 patches ≈ 13.5/ep；8.1
//   原版 938/5019——增量来自下方 8.4 扩展的 hero presence patch），5 轴混合，
//   31 subjects：hero（每章在场 2-4 patches，全史 ~1200）/ 5 cores（2/3 章在场）/ 15 mids（每 15 章
//   一章，稀疏长程——累积窗 ~195 章才触达 25 阈值，窗口锯齿周期长，B5 观测）/ 5 cycles（4/12 章在场 →
//   休眠缺口 ≥ 3 章）/ 5 dragons（全书 1-2 章蛰伏出场）。写入走真 insertWorldSlice（含 episode_id 列），
//   物化走真 materializeChapterSummaryCore（per-episode 逐章，mirror 链上 chapter-summary-node 节奏）；
//   只 mock project.yaml 边界（@orison/desktop-local-bff loadProject，mirror worldStateBackfillSummary.test.ts）。
//
//   Story 8.4 B6/B7 fixture 扩展（增量、确定性不变）：scene_graph 每章 2 场（ss-<i>-a@i*100+10 /
//   ss-<i>-b@i*100+30，episodeId 直挂）+ cognitive patch 携 evidenceSceneId（slice storyTime ≤ +20 → a、
//   ≥ +30 → b——证据场恒 ≤ patch storyTime，INV-2 诚实数据）+ hero 每章 1 条 /presence_scene（值随章
//   a/b 交替——INV-3 presence 信号面非空）。scene id 前缀 ss- 与既有 beat sceneRef（sc-a..sc-i）零碰撞，
//   materialize beat 归属不受影响（beat 全带 episodeId 直挂）。
//
// 运行成本控制：本文件 Electron-as-Node 真跑实测 ~7s（fixture 写入 + 400 章物化 ~4.7s + 断言），
// 远在 implement.md Step 7 的 ~2 分钟预算内——episode 数保持 400 不降档。
//
// 🔑 实测校准结论（design §10「最终值待压测校准」的数据回填，详 B5 观测输出）：
//   - 窗口界对**全部** subject 成立（不只高频）：阈值判的是「自上一 checkpoint 的累积窗」，稀疏 subject
//     锯齿推进（mid-01：18@ch149 → ep~195 推进 → 0@ch199 → 20@ch349 → ep~390 推进 → 0@ch399），
//     任意 at 的 fold 窗 ≤ CHECKPOINT_MIN_PATCH_DELTA - 1 + 单章窗增量。
//   - checkpoint 行数 8.1 实测 210 ≈ 5019/25 = 201（8.4 扩展后 223 ≈ 5419/25 = 217，O(patches/25) 阶不变）。
//   - token 实测分布 723-1444（median ~1310）——design §3.3 的 ~500 token 预算需字段 cap 校准（8.3）。
//
// Electron-as-Node 真跑（better-sqlite3 按 Electron ABI 重建，plain-Node vitest 下本 suite 会被
// ABI gate skip）：
//   cd apps/desktop/client/shell
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     ./node_modules/vitest/vitest.mjs run test/worldStateScale.test.ts
// ─────────────────────────────────────────────────────────────────────────────

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateCheckpoint.test.ts / worldStateBackfillSummary.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-world-state-scale');

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

// dogfood #104-b：materialize hook 的无 deps 生产接线（正确形态，不动）会兜底到
// resolveEmbeddingModel——经 configIpc 读真实 ~/.orison/model 配置 → defaultEmbedBatch
// 真打 ${baseUrl}/embeddings（400 章排干队列 = 401 ×N 实录）。mock 掉模型解析层（逐字
// mirror chapterSummaryHookWiring.test.ts:22-29）：resolveEmbeddingModel=null 在 indexer
// 的 `if (model && …)` 处短路整个 embed 块，「无模型→FTS-only」降级语义不变，零网络。
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

// project.yaml 边界 mock：materializeChapterSummaryCore 经 dynamic import 读 loadProject——
// 合成 doc（episode_outlines 400 + promise_registry + 空 scene_graph），免写盘整档。
const { loadProjectMock } = vi.hoisted(() => ({ loadProjectMock: vi.fn() }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject: loadProjectMock }));

import { closeDb, getDb } from '../main/db/index';
import {
  buildWorldSnapshotCheckpointed,
  getLatestWorldCheckpoint,
  insertWorldSlice,
  listChapterSummaries,
  listWorldPatches,
  listWorldSlices,
  listWorldSubjects,
  reduceWorldSubject,
  reduceWorldSubjectCheckpointed,
} from '../main/db/worldStateRepository';
// CR-8（8.1 修复批）：materialize 核心已下潜 db/worldStateMaterialize（原住 worldStateHandlers）。
import { materializeChapterSummaryCore, waitForSummaryIndexQueue } from '../main/db/worldStateMaterialize';

// better-sqlite3 ABI gate（mirror worldStateCheckpoint.test.ts）：plain-Node vitest 下原生 addon
// ABI 不匹配时 skip 而非 fail。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

// ── fixture 规模参数 ──
const EPISODES = 400;
const PID = '00005'; // 本 suite 专属 project id（fresh db after clean；composite PK 跨 suite 隔离）
const PROJECT_DIR = '/proj/scale-fixture'; // loadProject 已 mock——只作透传标记
const LCG_SEED = 0x5eed_8101; // 固定 seed（确定性：同 seed 同 fixture，无 Date.now / Math.random）

const HERO_ID = 'hero-01';
const CORE_IDS = Array.from({ length: 5 }, (_, k) => `core-0${k + 1}`);
const MID_IDS = Array.from({ length: 15 }, (_, k) => `mid-${String(k + 1).padStart(2, '0')}`);
const CYCLE_IDS = Array.from({ length: 5 }, (_, k) => `cycle-0${k + 1}`);
const DRAGON_IDS = Array.from({ length: 5 }, (_, k) => `dragon-0${k + 1}`);

const episodeId = (i: number): string => `ep-${String(i).padStart(3, '0')}`;

// ── Story 8.4 B6/B7 fixture 扩展：scene_graph 场 + cognitive evidence + hero presence ──
//
// 每章 2 场（a@i*100+10 / b@i*100+30，episodeId 直挂单章场）；slice storyTime 为 i*100+(s+1)*10
// （s=0..3 → +10/+20/+30/+40）——evidence 映射「≤ +20 → a（+10）、≥ +30 → b（+30）」保证证据场
// storyTime 恒 ≤ patch storyTime（INV-2 诚实数据，非为过而过）。scene id 前缀 ss- 与既有 beat
// sceneRef（sc-a..sc-i）零碰撞（materialize beat 归属直挂 episodeId 不受影响）。

/** 本章 i 内偏移 → evidence scene id（slice storyTime ≤ +20 → a；≥ +30 → b）。 */
function evidenceSceneFor(i: number, sliceStoryTime: number): string {
  return sliceStoryTime - i * 100 <= 20 ? `ss-${i}-a` : `ss-${i}-b`;
}

/** hero 本章在场场（随章 a/b 交替——presence ≠ evidence 的组合必然出现，INV-3 信号面非空）。 */
function heroPresenceSceneFor(i: number): string {
  return `ss-${i}-${i % 2 === 0 ? 'a' : 'b'}`;
}

/** 合成 scene_graph 场节点（raw doc 形态——sceneNodeSchema-parseable；doc 与 B6 sceneById 单源）。 */
function makeSceneNodes(): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  for (let i = 0; i < EPISODES; i += 1) {
    nodes.push({
      id: `ss-${i}-a`,
      storyTime: i * 100 + 10,
      presentationOrder: { chapter: i, pos: 0 },
      role: 'normal',
      lineTags: [],
      episodeId: episodeId(i),
    });
    nodes.push({
      id: `ss-${i}-b`,
      storyTime: i * 100 + 30,
      presentationOrder: { chapter: i, pos: 1 },
      role: 'normal',
      lineTags: [],
      episodeId: episodeId(i),
    });
  }
  return nodes;
}

/** B6 用：场 id → SceneNode Map（sceneNodeSchema.parse 防御 + 类型化，doc 同源单源）。 */
function makeSceneById(): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  for (const raw of makeSceneNodes()) {
    const parsed = sceneNodeSchema.safeParse(raw);
    if (parsed.success) map.set(parsed.data.id, parsed.data);
  }
  return map;
}

/** Numerical Recipes LCG（imul + >>>0 无浮点漂移，跨平台确定性）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// subject 元数据（name/type 进 summary 的 ①①b/④ 字段——CJK 短名控制 token 观测）。
const SUBJECT_META: Record<string, { type: string; name: string }> = {};
SUBJECT_META[HERO_ID] = { type: 'character', name: '临' };
CORE_IDS.forEach((id, k) => (SUBJECT_META[id] = { type: 'character', name: `枢${k + 1}` }));
MID_IDS.forEach((id, k) => (SUBJECT_META[id] = { type: 'character', name: `间${k + 1}` }));
CYCLE_IDS.forEach((id, k) => (SUBJECT_META[id] = { type: 'character', name: `环${k + 1}` }));
DRAGON_IDS.forEach((id, k) => (SUBJECT_META[id] = { type: 'entity', name: `蛰${k + 1}` }));

/** 每 episode 的 subject 出场计划（全 index 派生，确定性）：id + 本章 patch 数。 */
function episodePlan(i: number): Array<{ id: string; count: number }> {
  const out: Array<{ id: string; count: number }> = [];
  // 高频长匣主角：每章必在场 2-4 patches（全史 ~1200 —— B1 对照断言的「全史 ≥ 300」数据源）。
  out.push({ id: HERO_ID, count: 2 + (i % 3) });
  // 核心配角：2/3 章在场，1-2 patches/次。
  CORE_IDS.forEach((id, c) => {
    if ((i + c + 1) % 3 !== 2) out.push({ id, count: 1 + ((i + c + 1) % 3) });
  });
  // 稀疏长程：每 15 章一章（累积窗 ~195 章才触达 25 阈值——窗口锯齿周期长，B5 观测数据源）。
  MID_IDS.forEach((id, m) => {
    if (i % 15 === m) out.push({ id, count: 2 });
  });
  // 休眠循环：4/12 章在场 → 休眠缺口 ≥ 3 章（B3 oracleDormant 断言数据源）。
  CYCLE_IDS.forEach((id, c) => {
    if (((i + 2 * (c + 1)) % 12) < 4) out.push({ id, count: 1 + ((i + c) % 2) });
  });
  // 蛰伏实体：全书 1-2 章出场（B3 ④ newEntities 断言数据源）。
  DRAGON_IDS.forEach((id, d) => {
    const first = 30 + d * 80;
    if (i === first || (d % 2 === 0 && i === first + 1)) out.push({ id, count: 3 });
  });
  return out;
}

// patch 内容生成：轴/路径固定小集（状态 JSON 有界，checkpoint 不过胀）；数值路径首用 replace 后
// increment（增量有基准，不产 broken-relative 噪音）；关系轴带自然语言 summary（② 字段内容源）。
const AXES: ReadonlyArray<WorldPatchInput['axis']> = [
  'physical',
  'cognitive',
  'emotional',
  'relational',
  'factional',
];
const NUMERIC_PATHS: Partial<Record<WorldPatchInput['axis'], ReadonlyArray<string>>> = {
  physical: ['/hp', '/stamina'],
  relational: ['/trust'],
  factional: ['/standing'],
};
const STRING_PATHS: Partial<Record<WorldPatchInput['axis'], ReadonlyArray<string>>> = {
  cognitive: ['/knows/f1', '/knows/f2'],
  emotional: ['/mood'],
  factional: ['/rank'],
};
const STRING_VALUES: Record<string, ReadonlyArray<string>> = {
  cognitive: ['知', '疑', '误', '闻'],
  emotional: ['怒', '惧', '安', '哀'],
  factional: ['卒', '校', '将'],
};
const RELATIONAL_SUMMARIES = ['信任加深', '生出嫌隙', '立场靠近', '貌合神离'];

/** n 个 patch 分成 k 片（每片 3-8；jitter 由 rng 驱动。fixture 结构保证 n ∈ [2*3, 4*8]）。 */
function pickSliceSizes(rng: () => number, n: number, k: number): number[] {
  const sizes = new Array<number>(k).fill(Math.floor(n / k));
  for (let r = n - sizes.reduce((a, b) => a + b, 0); r > 0; r -= 1) sizes[r % k]! += 1;
  for (let r = 0; r < k * 3; r += 1) {
    const a = Math.floor(rng() * k);
    const b = Math.floor(rng() * k);
    if (a !== b && sizes[a]! > 3 && sizes[b]! < 8) {
      sizes[a]! -= 1;
      sizes[b]! += 1;
    }
  }
  return sizes;
}

/** project.yaml 合成 doc（episode_outlines + promise_registry + 空 scene_graph）。 */
function makeProjectDoc(): Record<string, unknown> {
  const promises: Array<Record<string, unknown>> = [];
  for (let k = 1; k <= 24; k += 1) {
    promises.push({ id: `pm-${String(k).padStart(2, '0')}`, title: `誓约${k}`, summary: `誓约${k}待兑现`, status: 'open' });
  }
  // 2 open 带 deadline（⑥ 下章回收清单的 deadline 路径——落在 ep-050 / ep-200）。
  promises.push({ id: 'dm-01', title: '血债', summary: '血债须偿', status: 'open', deadlineEpisodeId: episodeId(50) });
  promises.push({ id: 'dm-02', title: '旧约', summary: '旧约将尽', status: 'open', deadlineEpisodeId: episodeId(200) });
  // 2 终态（⑤ 排除路径 sanity）。
  promises.push({ id: 'fm-01', title: '已了', summary: '已了之约', status: 'fulfilled' });
  promises.push({ id: 'fm-02', title: '已弃', summary: '已弃之约', status: 'abandoned' });

  const beats: Array<Record<string, unknown>> = [
    { id: 'bt-001', promiseId: 'pm-01', sceneRef: 'sc-a', episodeId: episodeId(0), kind: 'plant' },
    { id: 'bt-002', promiseId: 'pm-01', sceneRef: 'sc-b', episodeId: episodeId(50), kind: 'advance' },
    { id: 'bt-003', promiseId: 'pm-01', sceneRef: 'sc-c', episodeId: episodeId(398), kind: 'payoff' },
    { id: 'bt-004', promiseId: 'pm-02', sceneRef: 'sc-d', episodeId: episodeId(10), kind: 'plant' },
    { id: 'bt-005', promiseId: 'pm-02', sceneRef: 'sc-e', episodeId: episodeId(100), kind: 'advance' },
    { id: 'bt-006', promiseId: 'pm-02', sceneRef: 'sc-f', episodeId: episodeId(200), kind: 'setback' },
    { id: 'bt-007', promiseId: 'pm-02', sceneRef: 'sc-g', episodeId: episodeId(390), kind: 'payoff' },
    { id: 'bt-008', promiseId: 'pm-03', sceneRef: 'sc-h', episodeId: episodeId(30), kind: 'plant' },
  ];
  for (let k = 0; k < 16; k += 1) {
    beats.push({ id: `bt-a${String(k).padStart(2, '0')}`, promiseId: 'pm-04', sceneRef: 'sc-i', episodeId: episodeId(k * 25), kind: 'advance' });
  }

  return {
    episode_outlines: Array.from({ length: EPISODES }, (_, i) => ({
      id: episodeId(i),
      index: i,
      title: `第${i + 1}章`,
    })),
    promise_registry: { promises, beats, version: 1, updatedBy: 'agent' },
    // Story 8.4 B6：scene_graph 每章 2 场（INV-2 evidence / INV-3 presence 的场 storyTime 表；
    // ss- 前缀与 beat sceneRef sc-a..sc-i 零碰撞，beat 归属不受影响）。
    scene_graph: { nodes: makeSceneNodes() },
  };
}

describe.skipIf(!sqliteUsable)('worldState 合成规模压测（Story 8.1 Step 7 — 百万字成本有界）', () => {
  // ── beforeAll 一次性建 fixture + 逐章物化 + 记录观测（its 复用，控制运行成本）──
  const numericInitialized = new Set<string>(); // `${subjectId} ${path}` 数值路径首用 replace
  const registeredStoryTime = new Map<string, number>(); // subjectId → 首现 slice storyTime
  const subjectEpisodes = new Map<string, number[]>(); // subjectId → 有 patch 的 episode 序列（dormancy 期望计算）
  const subjectEpisodeCountMax = new Map<string, number>(); // subjectId → 单章最大 patch 数（bound 推导）
  const episodeEndAt: number[] = []; // 每章末 storyTime（= 末 slice storyTime，materialize 的 storyTimeEnd）
  const heroObs: Array<{ episode: number; patchesFolded: number; checkpointHit: boolean }> = [];
  const episodeTokens: number[] = [];
  let truncatedCount = 0;
  let batchMs = 0;

  function writeEpisode(i: number): void {
    const rng = makeRng((LCG_SEED ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
    const plan = episodePlan(i);
    const patches: WorldPatchInput[] = [];
    for (const entry of plan) {
      for (let k = 0; k < entry.count; k += 1) {
        const axis = AXES[Math.floor(rng() * AXES.length)]!;
        const numeric = NUMERIC_PATHS[axis] ?? [];
        const strings = STRING_PATHS[axis] ?? [];
        const useNumeric = numeric.length > 0 && (strings.length === 0 || rng() < 0.6);
        const relationalSummary =
          axis === 'relational' ? RELATIONAL_SUMMARIES[Math.floor(rng() * RELATIONAL_SUMMARIES.length)]! : undefined;
        let patch: WorldPatchInput;
        if (useNumeric) {
          const p = numeric[Math.floor(rng() * numeric.length)]!;
          const initKey = `${entry.id} ${p}`;
          if (!numericInitialized.has(initKey)) {
            numericInitialized.add(initKey);
            patch = { subjectId: entry.id, path: p, op: 'replace', value: 40 + Math.floor(rng() * 40), axis };
          } else {
            const delta = (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 5));
            patch = { subjectId: entry.id, path: p, op: 'increment', value: delta, axis };
          }
        } else {
          const p = strings[Math.floor(rng() * strings.length)]!;
          const vocab = STRING_VALUES[axis] ?? ['值'];
          patch = { subjectId: entry.id, path: p, op: 'replace', value: vocab[Math.floor(rng() * vocab.length)]!, axis };
        }
        patches.push(relationalSummary !== undefined ? { ...patch, summary: relationalSummary } : patch);
      }
      const eps = subjectEpisodes.get(entry.id) ?? [];
      eps.push(i);
      subjectEpisodes.set(entry.id, eps);
      subjectEpisodeCountMax.set(entry.id, Math.max(subjectEpisodeCountMax.get(entry.id) ?? 0, entry.count));
    }

    // Story 8.4 B6：hero 每章 1 条 /presence_scene（INV-3 presence 信号面非空；hero 本就每章在场，
    // 计划 patch 之外 +1——B1 界断言用 plan 计数推导，+1 在界内）。
    patches.push({
      subjectId: HERO_ID,
      path: '/presence_scene',
      op: 'replace',
      value: heroPresenceSceneFor(i),
      axis: 'physical',
    });

    const sliceCount = Math.max(2, Math.min(4, Math.ceil(patches.length / 6)));
    const sizes = pickSliceSizes(rng, patches.length, sliceCount);
    const epId = episodeId(i);
    let pos = 0;
    let endAt = i * 100 + 10;
    for (let s = 0; s < sliceCount; s += 1) {
      const chunk = patches.slice(pos, pos + sizes[s]!);
      pos += sizes[s]!;
      const storyTime = i * 100 + (s + 1) * 10;
      endAt = storyTime;
      // Story 8.4 B6：cognitive patch 携 evidenceSceneId（证据场 storyTime ≤ 本 slice storyTime——
      // INV-2 诚实数据；worldPatchInputSchema.evidenceSceneId 落表 round-trip）。
      const withEvidence = chunk.map((p) =>
        p.axis === 'cognitive' ? { ...p, evidenceSceneId: evidenceSceneFor(i, storyTime) } : p,
      );
      const sliceSubjects: WorldSubject[] = [];
      for (const patch of chunk) {
        if (!registeredStoryTime.has(patch.subjectId)) {
          registeredStoryTime.set(patch.subjectId, storyTime);
          sliceSubjects.push({
            id: patch.subjectId,
            type: SUBJECT_META[patch.subjectId]!.type,
            name: SUBJECT_META[patch.subjectId]!.name,
            firstSeenStoryTime: storyTime,
          });
        }
      }
      insertWorldSlice(
        PID,
        { id: `${epId}:${storyTime}`, storyTime, title: `${epId} 切面 ${s + 1}`, episodeId: epId },
        withEvidence,
        sliceSubjects,
        'derived',
      );
    }
    episodeEndAt[i] = endAt;
  }

  function clean(): void {
    closeDb();
    rmBestEffort(TEST_HOME);
  }

  /** subject ≤ at 的全史 patch 数（「无 checkpoint 世界」对照——mirror listWorldPatches 过滤语义的 COUNT）。 */
  function heroCountAt(at: number): number {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM closure_world_patch p
         JOIN closure_world_slice s ON s.id = p.slice_id
         WHERE p.project_id = ? AND p.subject_id = ? AND s.story_time <= ?`,
      )
      .get(PID, HERO_ID, at) as { n: number };
    return row.n;
  }

  function countRows(table: 'closure_world_checkpoint' | 'closure_chapter_summary' | 'closure_world_patch' | 'closure_world_slice'): number {
    return (
      getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(PID) as { n: number }
    ).n;
  }

  /** snapshot 形态采样的 per-subject fold 成本（subject 收集 SQL mirror buildWorldSnapshotCheckpointed）。 */
  function snapshotFoldBreakdown(at: number): Array<{ id: string; folded: number; hit: boolean }> {
    const rows = getDb()
      .prepare(
        `SELECT id FROM closure_world_subject WHERE project_id = ? AND first_seen_story_time <= ?
         ORDER BY first_seen_story_time ASC, id ASC LIMIT 12`,
      )
      .all(PID, at) as Array<{ id: string }>;
    return rows.map((r) => {
      const o = reduceWorldSubjectCheckpointed(PID, r.id, at, { writeCheckpoint: false });
      return { id: r.id, folded: o.patchesFolded, hit: o.checkpointHit };
    });
  }

  /** subject 在 ≤ upToEpisode 内最后一个有 patch 的 episode index（oracleDormant.lastChangedEpisodeId 期望）。 */
  function lastEpisodeWithPatch(subjectId: string, upToEpisode: number): number | null {
    let last: number | null = null;
    for (const e of subjectEpisodes.get(subjectId) ?? []) if (e <= upToEpisode) last = e;
    return last;
  }

  beforeAll(
    async () => {
      clean();
      mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
      getDb();
      loadProjectMock.mockReturnValue(makeProjectDoc());

      const t0 = performance.now();
      // 逐章「写 slices → 真物化 → hero 章末观测」（interleave，mirror 链上 chapter-summary-node 节奏）。
      // X1（CR 2026-08-20）：物化内摘要检索行索引已 fire-and-forget（后台串行链）——批计时不再含
      // 每章 embed 索引开销（S3 await 串行形态实测 ~21s / 每章 +~52ms；修复后回落 ~7s 量级，
      // 数字随修复批真跑记录）。队列在计时区外排空（后续 B 断言见终态 + closeDb 前零竞态）。
      for (let i = 0; i < EPISODES; i += 1) {
        writeEpisode(i);
        const res = await materializeChapterSummaryCore(PID, PROJECT_DIR, episodeId(i));
        const obs = reduceWorldSubjectCheckpointed(PID, HERO_ID, episodeEndAt[i]!, { writeCheckpoint: false });
        heroObs.push({ episode: i, patchesFolded: obs.patchesFolded, checkpointHit: obs.checkpointHit });
        episodeTokens.push(res.tokenEstimate);
        if (res.summary.truncated) truncatedCount += 1;
      }
      batchMs = performance.now() - t0;
      await waitForSummaryIndexQueue();
    },
    300_000,
  );

  afterAll(() => {
    // 观测汇总（记录性，8.3 评估数据）——真跑时在测试输出可见；plain-Node skip 时本 suite 不执行。
    const totalPatches = sqliteUsable ? countRows('closure_world_patch') : 0;
    const avgPatches = (episodeEndAt.length > 0 ? totalPatches / EPISODES : 0).toFixed(1);
    const heroBoundedMax = heroObs.length > 0 ? Math.max(...heroObs.map((o) => o.patchesFolded)) : 0;
    console.log(
      `[worldStateScale] fixture=${EPISODES} episodes / ${countRows('closure_world_slice')} slices / ` +
        `${totalPatches} patches (~${avgPatches}/ep) / ${subjectEpisodes.size} subjects\n` +
        `[worldStateScale] materialize batch=${Math.round(batchMs)}ms (~${Math.round(batchMs / EPISODES)}ms/episode，记录性非断言)\n` +
        `[worldStateScale] hero 章末观测 fold 最大=${heroBoundedMax}（阈值 ${CHECKPOINT_MIN_PATCH_DELTA}）；` +
        `checkpoint 行=${countRows('closure_world_checkpoint')}（≈O(patches/25)）；summary 行=${countRows('closure_chapter_summary')}`,
    );
    clean();
  });

  it(
    'B1 checkpoint 稳态：高频 subject 单次 reduce 的 fold 窗 ≤ 阈值 + 单章增量（与总史规模解耦）',
    () => {
      // (a) 400 章逐章物化后的章末采样：全部命中 checkpoint 且 fold 窗 < 阈值
      //     （≥ 25 会在该章物化时推进清零；未推进则残留 < 25——两分支都 < 25）。
      expect(heroObs).toHaveLength(EPISODES);
      for (const o of heroObs) {
        expect(o.checkpointHit).toBe(true);
        expect(o.patchesFolded).toBeLessThan(CHECKPOINT_MIN_PATCH_DELTA);
      }

      // (b) 章中 at 点采样（全部 400 章 slices 已写 + 已物化 → 窗 = 残留 + 本章已写增量）。
      const heroMaxChapter = subjectEpisodeCountMax.get(HERO_ID)!;
      for (const i of [50, 200, 350]) {
        const at = i * 100 + 25;
        const obs = reduceWorldSubjectCheckpointed(PID, HERO_ID, at, { writeCheckpoint: false });
        expect(obs.checkpointHit).toBe(true);
        expect(obs.patchesFolded).toBeLessThanOrEqual(CHECKPOINT_MIN_PATCH_DELTA + heroMaxChapter);
      }

      // (c) 对照：同 at 无 checkpoint 世界（fetchWorldPatchesViaTool + 全量 fold）的 patch 数——
      //     ch350 处全史 ≥ 300 且 > checkpointed fold 的 10 倍（O(全史) vs O(增量窗) 的差距证明）。
      const heroCheckpointedAt350 = reduceWorldSubjectCheckpointed(PID, HERO_ID, 350 * 100 + 25, {
        writeCheckpoint: false,
      }).patchesFolded;
      const heroFullAt350 = heroCountAt(350 * 100 + 40);
      expect(heroFullAt350).toBeGreaterThanOrEqual(300);
      expect(heroFullAt350).toBeGreaterThan(heroCheckpointedAt350 * 10);

      // (d) CR-10（8.1 修复批）：checkpoint 的 patchCountFolded 自**命中点**累计（无 latest 重查双计）——
      //     不变量：任意 checkpoint 的累计折叠数 ≡ 该 subject story_time <= at 的全量 patch 数（SQL COUNT
      //     独立对账；lazy 首建与阈值推进的分段累计在此不变量下闭合）。
      const heroCkpt = getLatestWorldCheckpoint(PID, HERO_ID);
      expect(heroCkpt).toBeDefined();
      const heroFoldedCount = (
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM closure_world_patch p
             JOIN closure_world_slice s ON s.id = p.slice_id
             WHERE p.project_id = ? AND p.subject_id = ? AND s.story_time <= ?`,
          )
          .get(PID, HERO_ID, heroCkpt!.atStoryTime) as { n: number }
      ).n;
      expect(heroCkpt!.patchCountFolded).toBe(heroFoldedCount);
    },
    60_000,
  );

  it(
    'B2 成本曲线与总史解耦：第 50 章 vs 第 350 章物化后观测同量级',
    () => {
      const maxOf = (from: number, to: number) =>
        Math.max(...heroObs.slice(from, to).map((o) => o.patchesFolded));
      // 两个 50 章带的 checkpointed fold 上限同为一个常数界（不随 episode 数涨）。
      const earlyMax = maxOf(0, 50);
      const lateMax = maxOf(350, EPISODES);
      expect(earlyMax).toBeLessThan(CHECKPOINT_MIN_PATCH_DELTA);
      expect(lateMax).toBeLessThan(CHECKPOINT_MIN_PATCH_DELTA);

      // 对照：同样两点的全史 fold 量线性涨 ~7x（增量 ~3 patches/章 × 300 章差）。
      const full50 = heroCountAt(episodeEndAt[49]!);
      const full350 = heroCountAt(episodeEndAt[349]!);
      expect(full350).toBeGreaterThan(full50 * 4);
    },
    60_000,
  );

  it(
    'B3 summary 物化完整性：行数 = episode 数 + token 有界 + truncated/dormant/newEntities/⑤⑥ spot',
    () => {
      const rows = listChapterSummaries(PID, { fromIndex: 0, toIndex: EPISODES - 1 });
      expect(rows).toHaveLength(EPISODES);

      // token 有界：全部 400 行 ≤ 2000（确定性 fixture 实测 max=1436，1.4x 余量；实际分布见 B5 观测）。
      // ⚠ 校准发现：design §3.3 的 ~500 token 预算在当前字段 cap 下达不到（median ~1300）——
      // cap 常量校准归 8.3（design §10），本断言只证「每章有界」非「≤500」。
      const tokens = rows.map((r) => r.tokenEstimate);
      const maxTok = Math.max(...tokens);
      expect(maxTok).toBeLessThanOrEqual(2000);
      // 稳态性：后 50 章 max ≤ 前 50 章 max × 2（不随总史涨——early 章含大量 ④ 新实体，天然 ≥ late）。
      const earlyTokMax = Math.max(...tokens.slice(0, 50));
      const lateTokMax = Math.max(...tokens.slice(350));
      expect(lateTokMax).toBeLessThanOrEqual(earlyTokMax * 2);

      // truncated 比例：open promises 26 > cap 20 → 每章 truncated（100%，记录性断言）。
      expect(rows.filter((r) => r.truncated)).toHaveLength(EPISODES);

      // dormant：cycle-01 在 ep-007 处于休眠缺口（最后 patch @ep-001，缺 6 章 ≥ 3）→
      //   oracleDormant 收录（含 lastChangedEpisodeId 回溯锚）且不进 characterEndStates（①b 语义）。
      const ep7 = rows.find((r) => r.episodeId === episodeId(7))!;
      expect(ep7.summary.characterEndStates.map((s) => s.subjectId)).not.toContain('cycle-01');
      expect(ep7.summary.characterEndStates.map((s) => s.subjectId)).toContain(HERO_ID);
      const dorm = ep7.summary.oracleDormant.find((d) => d.subjectId === 'cycle-01');
      expect(dorm).toBeDefined();
      expect(dorm?.lastChangedEpisodeId).toBe(episodeId(lastEpisodeWithPatch('cycle-01', 7)!));

      // ④ 新实体：dragon-01 首现章（ep-030）收录。
      const ep30 = rows.find((r) => r.episodeId === episodeId(30))!;
      expect(ep30.summary.newEntities.map((n) => n.subjectId)).toContain('dragon-01');

      // ⑤⑥ spot：ep-049 的 openPromises 满 cap 20；下章回收清单含 pm-01（beat 落 ep-050）+
      //   dm-01（deadlineEpisodeId = ep-050 到期）。
      const ep49 = rows.find((r) => r.episodeId === episodeId(49))!;
      expect(ep49.summary.openPromises).toHaveLength(20);
      const nextIds = ep49.summary.nextChapterPayoffs.map((p) => p.promiseId);
      expect(nextIds).toContain('pm-01');
      expect(nextIds).toContain('dm-01');
    },
    60_000,
  );

  it(
    'B4 全链等价抽查：3 个 at 点 checkpointed snapshot vs 全量 fold snapshot deep-equal（400 章规模复验）',
    () => {
      const allPatches = listWorldPatches(PID);
      const ats = [episodeEndAt[49]!, 200 * 100 + 25, episodeEndAt[399]!];
      const byId = (arr: { subjectId: string }[]) =>
        arr.slice().sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));
      for (const at of ats) {
        const shellSide = buildWorldSnapshotCheckpointed(PID, at);
        const pureSide = buildWorldStateSnapshot(allPatches, at);
        // 顺序规范化后比（两侧 first-seen 序 tie-break 不同，mirror worldStateCheckpoint.test.ts 注）。
        expect(shellSide.at).toBe(pureSide.at);
        expect(byId(shellSide.subjects)).toEqual(byId(pureSide.subjects));
      }
      // per-subject 深抽查：state + issueCount 全史等价（含稀疏 mid / 休眠 cycle 形态）。
      for (const at of ats) {
        for (const subjectId of [HERO_ID, 'core-01', 'cycle-02', 'mid-08']) {
          const cp = reduceWorldSubjectCheckpointed(PID, subjectId, at, { writeCheckpoint: false });
          const base = reduceWorldSubject(PID, subjectId, at);
          expect(cp.state).toEqual(base.state);
          expect(cp.issueCount).toBe(base.issues.length);
        }
      }
    },
    60_000,
  );

  it(
    'B5 吞吐观测（记录性）：物化批 fold 总量 + snapshot 采样 + cognition/presence 全 fold 规模（8.3 评估数据）',
    () => {
      const totalPatches = countRows('closure_world_patch');

      // snapshot 形态采样（mirror buildWorldSnapshotCheckpointed 的 12-subject 收集）。
      const sampleEpisodes = [49, 149, 249, 349, 399];
      const samples = sampleEpisodes.map((i) => ({ episode: i, breakdown: snapshotFoldBreakdown(episodeEndAt[i]!) }));

      // 🔑 通用界断言（实测校准结论）：阈值判的是「自上一 checkpoint 的累积窗」——任意 subject（含
      // 稀疏 mids / 蛰伏 dragons）在任意 at 的 fold 窗 ≤ 阈值 - 1 + 该 subject 单章窗增量。采样点是
      // 章末（全章已物化）→ 直接 ≤ 阈值 - 1 + 单章上界（宽松侧）。
      const globalMaxChapter = Math.max(...Array.from(subjectEpisodeCountMax.values()));
      for (const sample of samples) {
        expect(sample.breakdown.length).toBeGreaterThan(0);
        for (const b of sample.breakdown) {
          expect(b.folded).toBeLessThanOrEqual(CHECKPOINT_MIN_PATCH_DELTA + globalMaxChapter);
        }
      }

      // 稀疏长程 subject（mids）的窗口锯齿观测：累积窗触达 25 才推进 → 长周期锯齿（mid-01 实测
      // 18@ch149 → ep~195 推进 → 0@ch199 → 20@ch349 → ep~390 推进 → 0@ch399）。记录曲线——
      // CHECKPOINT_MIN_PATCH_DELTA 校准（design §10）的输入数据，不做趋势断言。
      const mid01Curve = [49, 149, 199, 299, 349, 399].map((i) => ({
        episode: i,
        folded: snapshotFoldBreakdown(episodeEndAt[i]!).find((b) => b.id === 'mid-01')?.folded,
      }));

      // 整批物化的 hero 观测 fold 总量 vs 「无 checkpoint 世界」同采样点全量 fold 总量（O(全史) 对照）。
      let heroObsTotal = 0;
      let fullWorldTotal = 0;
      for (let i = 0; i < EPISODES; i += 1) {
        heroObsTotal += heroObs[i]!.patchesFolded;
        fullWorldTotal += heroCountAt(episodeEndAt[i]!);
      }
      expect(fullWorldTotal).toBeGreaterThan(heroObsTotal * 10);

      // cognition/presence 全 fold 输入规模（per-character checkpoint 化 defer 8.3 的决策数据，
      // design §7/§10）：build_world_snapshot projection 取项目全集 patches —— O(总史) 线性。
      const proj50 = listWorldPatches(PID, undefined, episodeEndAt[49]!).length;
      const proj399 = listWorldPatches(PID, undefined, episodeEndAt[399]!).length;
      expect(proj399).toBeGreaterThan(proj50 * 4);

      // checkpoint 行数 ≈ O(总 patches / 25)（hero ~46 + cores ~150 + cycles ~50 + mids/dragons lazy）。
      const ckptRows = countRows('closure_world_checkpoint');
      expect(ckptRows).toBeGreaterThan(totalPatches / 60);
      expect(ckptRows).toBeLessThan(totalPatches / 8);

      console.log(
        `[worldStateScale] B5 采样 fold（12-subject snapshot 形态，通用界=${CHECKPOINT_MIN_PATCH_DELTA}+${globalMaxChapter}）：` +
          samples
            .map(
              (s) =>
                `\n  ch${s.episode}: Σ=${s.breakdown.reduce((a, b) => a + b.folded, 0)} ` +
                `max=${Math.max(0, ...s.breakdown.map((b) => b.folded))} ` +
                `per-subject={${s.breakdown.map((b) => `${b.id}:${b.folded}`).join(',')}}`,
            )
            .join('') +
          `\n[worldStateScale] mid-01 稀疏窗口锯齿=${JSON.stringify(mid01Curve)}` +
          `\n[worldStateScale] hero 观测 fold 总量=${heroObsTotal} vs 无 checkpoint 世界=${fullWorldTotal}（${(fullWorldTotal / Math.max(1, heroObsTotal)).toFixed(1)}x）` +
          `\n[worldStateScale] cognition/presence 全 fold 输入：ch49=${proj50} → ch399=${proj399}（${(proj399 / Math.max(1, proj50)).toFixed(1)}x 线性）` +
          `\n[worldStateScale] token 分布：max=${Math.max(...episodeTokens)} min=${Math.min(...episodeTokens)} ` +
          `median=${episodeTokens.slice().sort((a, b) => a - b)[Math.floor(EPISODES / 2)]}；truncated=${truncatedCount}/${EPISODES}`,
      );
    },
    60_000,
  );

  it(
    'B6 同切点互恰（Story 8.4 C2/C3，design §3.4 断言①）：400 章合成数据抽切点跑 INV-1/2/3/5 全过 + 非空转证明',
    () => {
      // 对拍器单源：shared collectAsOfInvariantViolations / collectChapterWindowViolations（Step 9 从
      // tests/as-of-invariants.test.ts 提升的纯函数——不复制粘贴断言逻辑；INVARIANT_LIST 登记处不变）。
      // 真面数据：patches 经 listWorldPatches(at) SQL 截断；worldSubjects 按 firstSeenStoryTime <= at
      // （mirror snapshot 收集语义）——INV-1 用全量 subject 表非 snapshot 12-subject 截断面（截断面会
      // 假阳性漏检：cognition 角色可能不在前 12）。
      const sceneById = makeSceneById();
      expect(sceneById.size).toBe(EPISODES * 2);

      // 抽 5 个切点（章末 3 + 章中 2——章中切点跨 slice 边界，INV-2 的 evidence 边界形态）。
      const ats = [episodeEndAt[49]!, 149 * 100 + 25, episodeEndAt[249]!, 349 * 100 + 25, episodeEndAt[399]!];
      const allSubjects = listWorldSubjects(PID);
      let cognitiveEvidencePatches = 0;
      let presenceSignals = 0;
      let cognitionCharacters = 0;
      for (const at of ats) {
        const patches = listWorldPatches(PID, undefined, at);
        const worldSubjects = new Set(
          allSubjects.filter((s) => s.firstSeenStoryTime <= at).map((s) => s.id),
        );
        expect(collectAsOfInvariantViolations({ sceneById, worldSubjects, patches }, at)).toEqual([]);

        // 非空转输入面累计（防「空数据恒真过」——三不变量各自的检查对象在合成数据非空）。
        cognitiveEvidencePatches += patches.filter(
          (p) => p.axis === 'cognitive' && p.evidenceSceneId !== undefined,
        ).length;
        presenceSignals += buildPresenceSignal(patches).length;
        cognitionCharacters += buildCognitionSnapshot(patches)?.characters.length ?? 0;
      }
      expect(cognitiveEvidencePatches).toBeGreaterThan(0); // INV-2 输入面非空
      expect(presenceSignals).toBeGreaterThan(0); // INV-3 输入面非空（presence ≠ evidence 组合存在）
      expect(cognitionCharacters).toBeGreaterThan(0); // INV-1 输入面非空

      // INV-5：早/中/晚 3 章 summary touched subjects × 本章窗 patches 对拍（episode 归属单源）。
      const rows = listChapterSummaries(PID, { fromIndex: 0, toIndex: EPISODES - 1 });
      const chaptersWithRelationships = rows.filter((r) => r.summary.relationshipChanges.length > 0).length;
      expect(chaptersWithRelationships).toBeGreaterThan(0); // INV-5 输入面非空（② 有背书数据）
      for (const i of [49, 199, 399]) {
        const row = rows.find((r) => r.episodeId === episodeId(i))!;
        const chapterSlices = listWorldSlices(PID, { episodeId: episodeId(i), withPatches: true });
        const windowSubjects = new Set(
          chapterSlices.flatMap((s) => (s.patches ?? []).map((p) => p.subjectId)),
        );
        const touched = [
          ...row.summary.relationshipChanges.map((r) => r.subjectId),
          ...row.summary.newEntities.map((n) => n.subjectId),
        ];
        expect(collectChapterWindowViolations(touched, windowSubjects)).toEqual([]);
      }

      console.log(
        `[worldStateScale] B6 同切点互恰：5 切点 INV-1/2/3 全过（输入面：cognitive evidence ` +
          `${cognitiveEvidencePatches} patches / presence signals ${presenceSignals} / cognition chars ` +
          `${cognitionCharacters}）；INV-5 3 章（${chaptersWithRelationships}/${EPISODES} 章含关系变化）`,
      );
    },
    60_000,
  );

  it(
    'B7 总额有界（Story 8.4 B 段，design §3.4 断言②）：满配热层 buildCompileReport total < TH_WARN（正常写作永不触发降级）',
    () => {
      // 满配 brief：12 场（多场景）× 各场 12-subject 真实 400 章末状态快照（stateAtT 是随总史增长的
      // 最大段——规模侧的关键背书对象）+ 20 Promise 任务 + 30 未决决策 + 20 操控指令 + 20 弧走向 +
      // LLM 意图段全填（goal/参数/信息控制/节奏/禁写/情绪目标，每段 ~150-350 CJK 字符的真实体量）。
      // 设定侧：30 core 卡（每卡 ~1100 字符）+ 全书目录（400 章）+ world_setting + creative_brief。
      const fill = (n: number, seed: number): string => {
        const vocab = ['孤城', '钟声', '旧约', '血债', '渡鸦', '枢机', '蛰伏', '集市', '王座', '密信'];
        let out = '';
        let k = seed;
        while (out.length < n) {
          out += vocab[k % vocab.length];
          k += 1;
        }
        return out.slice(0, n);
      };

      // 12 场 storyTimes：39910..40020（末章尾 + 越界 80——snapshot 取全史终态，满配最重形态）。
      const sceneTimes = Array.from({ length: 12 }, (_, k) => 39910 + k * 10);
      const plotPoints = sceneTimes.map((at, k) => ({
        sceneId: `full-${k}`,
        continuity: k === 0 ? '从前章续入' : k === 11 ? '续到后章' : '本章内',
        // 真实快照（checkpoint-backed snapshot 同款形态：{at, subjects:[{subjectId,state,issueCount}]}，
        // 12-subject 收集面——buildWorldSnapshotCheckpointed 的 fetch 通道缺省面）。
        stateAtT: buildWorldSnapshotCheckpointed(PID, at),
      }));

      const brief: ChapterBrief = {
        goal: fill(350, 1),
        ending: fill(120, 2),
        pov: '第三人称限知（临）',
        tone: fill(100, 3),
        readerKnows: fill(180, 4),
        protagonistKnows: fill(180, 5),
        mustHide: fill(200, 6),
        hintOnly: fill(150, 7),
        pacing: fill(120, 8),
        opening: fill(100, 9),
        nextHook: fill(100, 10),
        doNotWrite: fill(200, 11),
        gap_whitelist: [
          { location: `full-${5}`, reason: fill(40, 12) },
          { location: `full-${9}`, reason: fill(40, 13) },
        ],
        emotionTarget: { emotion: '紧张→震动', emotionEnd: '疑虑', steer: fill(150, 14) },
        readiness: 'ready',
        plotPoints,
        promiseTasks: Array.from({ length: 20 }, (_, k) => ({
          promiseId: `pm-${String(k + 1).padStart(2, '0')}`,
          title: `誓约${k + 1}`,
          summary: fill(80, k + 20),
          category: 'setup_payoff',
          beatKind: (['plant', 'advance', 'setback', 'payoff'] as const)[k % 4],
          note: fill(80, k + 40),
          sceneRef: `full-${k % 12}`,
          payoffExpectation: fill(60, k + 60),
        })),
        openDecisions: Array.from({ length: 30 }, (_, k) => ({
          id: `sd-${k}`,
          summary: fill(90, k + 80),
          risk: fill(60, k + 110),
        })),
        manipulationDirectives: Array.from({ length: 20 }, (_, k) => ({
          mode: (['reveal_first', 'sustain_unknown', 'method_foreseen', 'subjective_mislead'] as const)[k % 4],
          actions: (['plant', 'withhold', 'release', 'dramatic_irony'] as const).slice(k % 3, (k % 3) + 1),
          ...(k % 2 === 0 ? { forbiddenMoves: [fill(40, k + 140), fill(40, k + 150)] } : {}),
          target: `subject://core-0${(k % 5) + 1}`,
        })),
        characterProgressions: Array.from({ length: 20 }, (_, k) => ({
          characterId: k < 6 ? `core-0${k + 1}` : `mid-${String(k + 1).padStart(2, '0')}`,
          characterName: `角色${k + 1}`,
          from: fill(60, k + 160),
          to: fill(60, k + 180),
          turningPoint: fill(80, k + 200),
        })),
      };

      // 设定侧满配前缀（estimateSettingsSegments 逐 item 一段——与 assemble 产 settings_context_report
      // 同一估算基）：30 core 卡 + 全书目录 + world_setting + creative_brief。
      const settingsItems: PinnedPrefixItem[] = [
        { label: '全书目录', content: fill(3200, 300), priority: 90, type: 'custom' },
        { label: '世界设定', content: fill(1500, 301), priority: 80, type: 'custom' },
        { label: '创作简报', content: fill(1200, 302), priority: 85, type: 'custom' },
        ...Array.from({ length: 30 }, (_, k) => ({
          label: `设定卡·${k + 1}`,
          content: fill(1100, k + 310),
          priority: 60,
          type: 'custom' as const,
        })),
      ];
      const settingsSegments = estimateSettingsSegments(settingsItems);

      const { report, tier } = buildCompileReport(brief, settingsSegments);

      // 核心断言（AC-12 后半 + B2 定位「阈值=机械异常量级，正常写作永不触发」的规模侧背书）：
      // 满配 total < TH_WARN → L0（仅度量报告，零降级动作——铁律/汇编段一件没动）。
      expect(report.total).toBeLessThan(DEFAULT_COMPILE_THRESHOLDS.warn);
      expect(tier).toBe('L0');
      expect(report.degraded).toBeUndefined();
      expect(report.overloaded).toBe(false);
      // 非空转证明：满配载荷是真实体量（brief 12 场快照 + 90 段内容），非凑数小 brief 恒真过。
      expect(report.total).toBeGreaterThan(10_000);

      console.log(
        `[worldStateScale] B7 满配热层 total=${report.total} < TH_WARN=${DEFAULT_COMPILE_THRESHOLDS.warn} ` +
          `（余量 ${((1 - report.total / DEFAULT_COMPILE_THRESHOLDS.warn) * 100).toFixed(0)}%，tier=${tier}）；` +
          `段数=${report.segments.length}，top3=${report.segments
            .slice()
            .sort((a, b) => b.token_estimate - a.token_estimate)
            .slice(0, 3)
            .map((s) => `${s.name}:${s.token_estimate}`)
            .join(', ')}`,
      );
    },
    60_000,
  );
});
