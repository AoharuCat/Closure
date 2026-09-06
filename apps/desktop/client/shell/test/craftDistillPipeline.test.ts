import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CraftCard,
  CraftDistillProgressEvent,
  CraftTerm,
  GenerationFinishReason,
  Material,
  ResolvedModel,
} from '@orison/shared-contracts';

// E10.2b W3.5：蒸馏管线全链测试（全 mock generateText/embed——mirror materialLLMWiring 形态）。
// ABI 门控 + throwaway home（mirror closureCraftCardRepository.test.ts）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-craft-distill');
const MATERIALS_ROOT = path.join(TEST_HOME, '.orison', 'materials');

const state = vi.hoisted(() => ({
  embedModel: null as ResolvedModel | null,
}));

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

import {
  CLAIM_EXTRACTION_MAX_TOKENS,
  CLAIM_EXTRACTION_SYSTEM_PROMPT,
  CATEGORIZATION_SYSTEM_PROMPT,
  CATEGORIZATION_MAX_TOKENS,
  CRAFT_DISTILL_PROGRESS_TICK_MS,
  DEDUP_AUTO_SIMILARITY,
  DEDUP_REVIEW_SIMILARITY,
  DISPUTE_SYSTEM_PROMPT,
  MAX_CLAIMS_PER_MATERIAL,
  __clearCraftDistillInflightForTest,
  __clearCraftDistillLlmCoreForTest,
  distillMaterial,
  evaluateCraftDistillGate,
  evaluateCraftDistillGateSync,
  resolveTermTombstone,
  runCraftDistillBatch,
  teachingIdFor,
  type CraftDistillDeps,
  type CraftDistillGenerateText,
  type DistillMaterialResult,
} from '../main/ipc/toolHandlers/craftDistillPipeline';
import {
  insertCraftTerm,
  findCraftTermByName,
  mergeCraftTerm,
  proposedCraftTermId,
} from '../main/db/closureCraftTermRepository';
import { getCraftCard, insertCraftCard, listCraftCards } from '../main/db/closureCraftCardRepository';
import { getCraftDistillLedger } from '../main/db/closureCraftDistillRepository';
import { listCraftMergeReviews } from '../main/db/closureCraftMergeReviewRepository';
import { deleteMaterialRows, getMaterialRow, upsertMaterialRow } from '../main/db/materialIndexer';
import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { EMBED_DIM } from '../main/db/closureIndexer';
import { createCraftIpcHandlers } from '../main/ipc/craftIpc';

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

/** 给定 cosine 的 1024 维单位向量（与 e0 夹角 cos=cosv——去重三档边界构造）。 */
function vecAtCosine(cosv: number): number[] {
  const rest = Math.sqrt(Math.max(0, 1 - cosv * cosv));
  const v = new Array(EMBED_DIM).fill(0);
  v[0] = cosv;
  v[1] = rest;
  return v;
}

/** 同上但正交分量落在指定维（构造「同对基线 cosine、彼此互异」的向量对——批内互不干扰）。 */
function vecAtCosineOn(cosv: number, dim: number): number[] {
  const rest = Math.sqrt(Math.max(0, 1 - cosv * cosv));
  const v = new Array(EMBED_DIM).fill(0);
  v[0] = cosv;
  v[dim] = rest;
  return v;
}

// ── fixtures ──

const MATERIAL_ID = 'mat-aabbccddeeff';
const TERM_QINGXU = 'term-00000001';

const DERIVED_TEXT = ['先压三拍再给回报。', '情绪落差本身即是爽点，需要在前文持续压制。', '结尾不要拖，兑现要干脆。'].join(
  '\n\n',
);

function mkMaterial(over: Partial<Material> = {}): Material {
  return {
    materialId: MATERIAL_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '情绪落差讲义',
    format: 'txt',
    provenance: {
      medium: 'other',
      tier: 'unspecified',
      sourcePath: '讲义.txt',
      via: 'builtin-text',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-05T10:00:00.000Z',
      author: '某作者',
      lang: null,
      originDate: null,
      description: '讲情绪落差与回报节奏',
    },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: DERIVED_TEXT.length,
      chapterDetection: { method: 'none', confidence: 'low', matchedFormats: [] },
    },
    chapters: [],
    chunkSpans: [],
    contentHash: `sha256:${'a'.repeat(64)}`,
    status: 'ready',
    ...over,
  };
}

function seedMaterial(over: Partial<Material> = {}): Material {
  const material = mkMaterial(over);
  upsertMaterialRow(material);
  writeFileSync(path.join(MATERIALS_ROOT, '.derived', '讲义.md'), DERIVED_TEXT, 'utf-8');
  return material;
}

function seedQingxuTerm(): void {
  const term: CraftTerm = {
    termId: TERM_QINGXU,
    category: 'qingxu',
    name: '先抑后扬',
    status: 'active',
    mergedInto: null,
    note: null,
  };
  insertCraftTerm(term);
}

/** 切条输出条目（quote/paraRange 默认锚定段 0）。 */
function claimItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paraRange: { start: 0, end: 1 },
    quote: '先压三拍再给回报。',
    condensed: '压低起手再给回报，让情绪落差本身成为爽点',
    points: ['起手压三拍'],
    scenarios: ['开篇'],
    counterexamples: [],
    tags: ['情绪', '开篇'],
    ...over,
  };
}

// ── generateText / embed mocks（slot+system 路由）──

interface GenCall {
  slot: string;
  system?: string;
  user: string;
  maxTokens?: number;
}

let genCalls: GenCall[] = [];
let extractionPayload = '[]';
let extractionFinishReason: GenerationFinishReason | undefined;
let categorizationQueue: string[] = [];
let disputePayload = '{"dispute":false,"reason":"同向"}';

function genCallsBy(system: string): GenCall[] {
  return genCalls.filter((c) => c.system === system);
}

const generateMock: CraftDistillGenerateText = async (input) => {
  genCalls.push({ ...input });
  if (input.system === CLAIM_EXTRACTION_SYSTEM_PROMPT) {
    return extractionFinishReason !== undefined
      ? { text: extractionPayload, finishReason: extractionFinishReason }
      : { text: extractionPayload };
  }
  if (input.system === CATEGORIZATION_SYSTEM_PROMPT) {
    const next = categorizationQueue.shift();
    if (next === undefined) {
      throw new Error('categorizationQueue exhausted — test fixture 未配置归类响应');
    }
    return { text: next };
  }
  if (input.system === DISPUTE_SYSTEM_PROMPT) {
    return { text: disputePayload };
  }
  throw new Error(`unexpected system prompt: ${(input.system ?? '(none)').slice(0, 30)}`);
};

let embedVectors = new Map<string, number[]>();
let autoSlot = 0;
const embedMock = async (_m: ResolvedModel, text: string): Promise<number[]> => {
  const explicit = embedVectors.get(text);
  if (explicit !== undefined) return explicit;
  autoSlot = (autoSlot + 1) % EMBED_DIM;
  return vec1024(autoSlot);
};

function mkDeps(): { deps: CraftDistillDeps; events: CraftDistillProgressEvent[] } {
  const events: CraftDistillProgressEvent[] = [];
  const deps: CraftDistillDeps = {
    generateText: generateMock,
    resolveModel: () => state.embedModel,
    embed: embedMock,
    notify: (e) => events.push(e),
    now: () => new Date('2026-09-05T12:00:00.000Z'),
  };
  return { deps, events };
}

function resetLlmFixtures(): void {
  genCalls = [];
  extractionPayload = JSON.stringify([claimItem()]);
  extractionFinishReason = undefined;
  categorizationQueue = [`{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.8}`];
  disputePayload = '{"dispute":false,"reason":"同向"}';
  embedVectors = new Map();
  autoSlot = 0;
  state.embedModel = null;
}

describe.skipIf(!sqliteUsable)('craftDistillPipeline 蒸馏全链（W3.5）', () => {
  beforeEach(() => {
    resetLlmFixtures();
    __clearCraftDistillLlmCoreForTest();
    __clearCraftDistillInflightForTest();
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    mkdirSync(path.join(MATERIALS_ROOT, '.derived'), { recursive: true });
    getDb(); // 触发 schema init + vec 扩展装载
    seedQingxuTerm();
  });
  afterEach(() => {
    clean();
  });

  it('切条全链 happy path：段号/provenance 注入断言 + 落卡 + 台账 + 进度相位序列', async () => {
    const material = seedMaterial();
    const { deps, events } = mkDeps();

    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 切条 prompt 注入断言：全局段号 + provenance（标题/作者/简介——F-11/F-16）。
    const extractionCall = genCallsBy(CLAIM_EXTRACTION_SYSTEM_PROMPT);
    expect(extractionCall).toHaveLength(1);
    expect(extractionCall[0]!.slot).toBe('extraction');
    expect(extractionCall[0]!.maxTokens).toBe(CLAIM_EXTRACTION_MAX_TOKENS);
    expect(extractionCall[0]!.user).toContain('【P0】先压三拍再给回报。');
    expect(extractionCall[0]!.user).toContain('【P1】情绪落差本身即是爽点');
    expect(extractionCall[0]!.user).toContain('标题：情绪落差讲义');
    expect(extractionCall[0]!.user).toContain('作者：某作者');
    expect(extractionCall[0]!.user).toContain('简介：讲情绪落差与回报节奏');
    expect(extractionCall[0]!.user).toContain('段落号范围 P0–P2');

    // 台账 done + stats + 双 hash。
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.status).toBe('done');
    expect(ledger.phase).toBeNull();
    expect(ledger.stats).toEqual({
      claims: 1,
      anchored: 1,
      droppedNoAnchor: 0,
      droppedMalformed: 0,
      droppedNoCategory: 0,
      mergedAuto: 0,
      mergeReviews: 0,
      newCards: 1,
      disputes: 0,
    });
    expect(ledger.contentHash).toBe(material.contentHash);
    expect(ledger.derivedHash).toBe(
      `sha256:${createHash('sha256').update(DERIVED_TEXT, 'utf-8').digest('hex')}`,
    );
    expect(ledger.distilledAt).toBe('2026-09-05T12:00:00.000Z');

    // 落卡：pending_review 起板 + 讲法锚点（段 0 char span [0,9)）+ 幂等键。
    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe('pending_review');
    expect(cards[0]!.category).toBe('qingxu');
    expect(cards[0]!.termId).toBe(TERM_QINGXU);
    expect(cards[0]!.condensed).toBe('压低起手再给回报，让情绪落差本身成为爽点');
    const card = getCraftCard(cards[0]!.cardId)!;
    expect(card.teachings).toHaveLength(1);
    expect(card.teachings[0]!.anchor).toEqual({
      chapterIndex: 0,
      charStart: 0,
      charEnd: 9,
      paraStart: 0,
      paraEnd: 1,
    });
    expect(card.teachings[0]!.teachingId).toBe(
      teachingIdFor(MATERIAL_ID, material.contentHash, '先压三拍再给回报。'),
    );
    expect(card.teachings[0]!.author).toBe('某作者');
    expect(card.teachings[0]!.rank).toBe('normal');
    expect(card.tags).toEqual(['情绪', '开篇']);

    // 进度相位序列（运行可见性硬要求）。
    expect(events.map((e) => [e.status, e.phase])).toEqual([
      ['running', 'extracting'],
      ['running', 'categorizing'],
      ['running', 'dedup'],
      ['running', 'landing'],
      ['done', null],
    ]);

    // 无 embed 模型 → 去重不可用诚实 note（ledger.error 双职——W1 契约注记）。
    expect(ledger.error).toContain('去重不可用');
  });

  it('无锚即丢：引文不在 span / paraRange 越界 / 坏形状条目 → 各自丢弃 + 口径拆分计数（CR-2b-12）', async () => {
    seedMaterial();
    extractionPayload = JSON.stringify([
      claimItem(),
      claimItem({ quote: '这句引文根本不在原文里', paraRange: { start: 0, end: 1 } }),
      claimItem({ paraRange: { start: 5, end: 6 } }),
      { garbage: true },
    ]);
    const { deps } = mkDeps();

    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(true);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.claims).toBe(3); // 坏形状不计 claims（无有效主张即无锚）
    expect(ledger.stats.anchored).toBe(1);
    expect(ledger.stats.droppedNoAnchor).toBe(2); // 引文不匹配 + paraRange 越界（纯锚定失败）
    expect(ledger.stats.droppedMalformed).toBe(1); // 坏形状条目独立计数（≠ 无锚——通过率不失真）
    expect(listCraftCards({ materialId: MATERIAL_ID })).toHaveLength(1);
  });

  it('引文空白归一容忍：quote 与原文空白差异不误杀（锚定仍通过）', async () => {
    seedMaterial();
    extractionPayload = JSON.stringify([
      claimItem({ quote: '先压 三拍\n再给回报。', paraRange: { start: 0, end: 3 } }),
    ]);
    const { deps } = mkDeps();
    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(true);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.anchored).toBe(1);
    expect(ledger.stats.droppedNoAnchor).toBe(0);
  });

  it('批内同引文两条只落一次（teaching 幂等键——F-04 belt）', async () => {
    seedMaterial();
    extractionPayload = JSON.stringify([claimItem(), claimItem()]);
    const { deps } = mkDeps();
    await distillMaterial(MATERIAL_ID, deps);
    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards).toHaveLength(1);
    expect(getCraftCard(cards[0]!.cardId)!.teachings).toHaveLength(1);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.claims).toBe(2);
    expect(ledger.stats.newCards).toBe(1);
  });

  it('主张数超 200 → 材料级挂起（台账 failed + 诚实 note，不静默截断——F-17）', async () => {
    seedMaterial();
    extractionPayload = JSON.stringify(
      Array.from({ length: MAX_CLAIMS_PER_MATERIAL + 1 }, (_, i) =>
        claimItem({ condensed: `主张${i}`, quote: `第${i}条引文` }),
      ),
    );
    const { deps, events } = mkDeps();
    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(false);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.status).toBe('failed');
    expect(ledger.error).toContain('200');
    expect(listCraftCards({ materialId: MATERIAL_ID })).toHaveLength(0);
    // 挂起在切条相位后——categorizing 零调用（不烧后续 LLM）。
    expect(genCallsBy(CATEGORIZATION_SYSTEM_PROMPT)).toHaveLength(0);
    expect(events[events.length - 1]!.status).toBe('failed');
  });

  it('切条输出截断（finishReason=length 权威停因——E10.2a CR-2）→ 材料级失败', async () => {
    seedMaterial();
    extractionFinishReason = 'length';
    const { deps } = mkDeps();
    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(false);
    expect(getCraftDistillLedger(MATERIAL_ID)!.error).toContain('finishReason=length');
    expect(listCraftCards({ materialId: MATERIAL_ID })).toHaveLength(0);
  });

  it('LLM 内核未装配 → llm-unavailable 失败挂起（诚实失败非静默）', async () => {
    seedMaterial();
    const events: CraftDistillProgressEvent[] = [];
    const result = await distillMaterial(MATERIAL_ID, {
      resolveModel: () => null,
      notify: (e) => events.push(e),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('llm-unavailable');
    expect(getCraftDistillLedger(MATERIAL_ID)!.status).toBe('failed');
    expect(events[events.length - 1]!.status).toBe('failed');
  });

  it('归类越界 → 整体重试一次 → 提案形态落地 pending 词目 + 卡挂提案', async () => {
    seedMaterial();
    categorizationQueue = [
      '{"category":"qingxu","termId":"term-deadbeef","confidence":0.5}',
      '{"proposedTerm":{"category":"qingxu","name":"情绪反差"},"confidence":0.6}',
    ];
    const { deps } = mkDeps();
    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(true);

    const catCalls = genCallsBy(CATEGORIZATION_SYSTEM_PROMPT);
    expect(catCalls).toHaveLength(2); // 越界重试一次
    expect(catCalls[1]!.user).toContain('注意：上一次输出的 termId 不在词目清单内'); // 纠偏指令注入
    expect(catCalls[0]!.maxTokens).toBe(CATEGORIZATION_MAX_TOKENS);
    // CR-2b-19：归类 user prompt 同注入 provenance 块（标题/作者/简介——AC9 装配断言扩到归类）。
    expect(catCalls[0]!.user).toContain('标题：情绪落差讲义');
    expect(catCalls[0]!.user).toContain('作者：某作者');
    expect(catCalls[0]!.user).toContain('简介：讲情绪落差与回报节奏');

    // pending 词目行（确定性 id）+ 卡挂它。
    const term = findCraftTermByName('qingxu', '情绪反差')!;
    expect(term.status).toBe('pending');
    expect(term.termId).toBe(proposedCraftTermId('qingxu', '情绪反差'));
    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards[0]!.termId).toBe(term.termId);
    expect(getCraftCard(cards[0]!.cardId)!.confidence).toBe(0.6); // 提案带 confidence（AC2）
  });

  it('归类两次越界 → per-claim 丢弃不炸材料（CR-2b-2）：其余主张照常落卡 + 计数 + 台账 note', async () => {
    seedMaterial();
    extractionPayload = JSON.stringify([
      claimItem({ condensed: '病态主张甲，两次越界' }),
      claimItem({ condensed: '好主张乙，正常归类', quote: '结尾不要拖，兑现要干脆。', paraRange: { start: 2, end: 3 } }),
    ]);
    categorizationQueue = [
      '{"category":"qingxu","termId":"term-deadbeef","confidence":0.5}', // 甲越界 → 重试
      '{"category":"qingxu","termId":"term-feedface","confidence":0.5}', // 甲再越界 → 丢弃该条
      `{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.8}`, // 乙正常
    ];
    const { deps } = mkDeps();

    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(true); // 不炸材料（原样材料级 failed = 永久卡死 + 重试重烧全部 LLM）
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.status).toBe('done');
    expect(ledger.stats.droppedNoCategory).toBe(1);
    expect(ledger.stats.newCards).toBe(1);
    expect(ledger.error).toContain('归类失败已丢弃');
    expect(ledger.error).toContain('病态主张甲'); // note 列明丢条目摘要
    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.condensed).toBe('好主张乙，正常归类'); // 不编造词目名——甲被丢弃乙照常落卡
  });

  it('词目墓碑链跟随（CR-2b-9）：A→B→C 归并链后提案命中墓碑 A → 卡挂最终活词目 C', async () => {
    seedMaterial();
    // 链构造：A/B/C 三活词目 → merge A→B → merge B→C（A、B 墓碑，链尾 C 活）。
    for (const [tid, name] of [
      ['term-0000000a', '链起点词目'],
      ['term-0000000b', '链中词目'],
      ['term-0000000c', '链尾词目'],
    ] as const) {
      insertCraftTerm({ termId: tid, category: 'qingxu', name, status: 'active', mergedInto: null, note: null });
    }
    mergeCraftTerm('term-0000000a', 'term-0000000b');
    mergeCraftTerm('term-0000000b', 'term-0000000c');
    categorizationQueue = ['{"proposedTerm":{"category":"qingxu","name":"链起点词目"},"confidence":0.6}'];
    const { deps } = mkDeps();

    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(true);
    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards[0]!.termId).toBe('term-0000000c'); // 全链跟随（原单跳挂死 B——词表不可见死词目）
    expect(cards[0]!.category).toBe('qingxu');
  });

  it('resolveTermTombstone 单元：环防护不悬挂 + 未知/活词目原样返回', () => {
    // A→B→A 环（数据病理态）：不悬挂，返回环上可达词目（保守）。
    insertCraftTerm({
      termId: 'term-0000000d',
      category: 'qingxu',
      name: '环甲',
      status: 'merged',
      mergedInto: 'term-0000000e',
      note: null,
    });
    insertCraftTerm({
      termId: 'term-0000000e',
      category: 'qingxu',
      name: '环乙',
      status: 'merged',
      mergedInto: 'term-0000000d',
      note: null,
    });
    const cycled = resolveTermTombstone('term-0000000d');
    expect(cycled !== null).toBe(true);
    expect(['term-0000000d', 'term-0000000e']).toContain(cycled!.termId);
    // 未知 id → null；活词目原样。
    expect(resolveTermTombstone('term-ffffffff')).toBeNull();
    expect(resolveTermTombstone(TERM_QINGXU)!.termId).toBe(TERM_QINGXU);
  });

  it('相位内周期发射（CR-2b-5）：tick 重复发同相位 running（elapsed 递增）；终态停发', async () => {
    seedMaterial();
    const { deps, events } = mkDeps();
    const slowGenerate: CraftDistillGenerateText = async (input) => {
      if (input.system === CLAIM_EXTRACTION_SYSTEM_PROMPT) {
        await new Promise((resolve) => setTimeout(resolve, 45)); // 长相位窗口（~4 个 tick）
      }
      return generateMock(input);
    };

    await distillMaterial(MATERIAL_ID, { ...deps, generateText: slowGenerate, progressTickMs: 10 });
    const extracting = events.filter((e) => e.phase === 'extracting');
    expect(extracting.length).toBeGreaterThanOrEqual(2); // 相位切换首发 + ≥1 tick（不再全程冻结 0s）
    expect(extracting[extracting.length - 1]!.elapsedMs).toBeGreaterThan(extracting[0]!.elapsedMs); // elapsed 递增
    expect(CRAFT_DISTILL_PROGRESS_TICK_MS).toBe(1000); // 生产默认 ~1s（测试注入 10ms 加速）
    // 终态最后 + 终态后零事件（无相位可重发——ticker 终止停发）。
    expect(events[events.length - 1]!.status).toBe('done');
    const countAtEnd = events.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.length).toBe(countAtEnd);
  });

  it('gate 单源分档（CR-2b-15）：便宜门零 IO（已蒸馏材料放行归批内兜底）；全量门 hash-unchanged', async () => {
    seedMaterial();
    const { deps } = mkDeps();
    await distillMaterial(MATERIAL_ID, deps);
    // 便宜门（craft:distill-run invoke 循环用）无 readFileSync+SHA256——不确认双 hash，放行；
    // 批内 distillMaterial 内部判定兜底 skip（结果数组回报，台账徽章读 distill-status 真相源）。
    expect(evaluateCraftDistillGateSync(MATERIAL_ID).ok).toBe(true);
    // 全量门（batch worker 异步路径专用）含 IO——hash-unchanged 同步可判。
    expect(evaluateCraftDistillGate(MATERIAL_ID)).toEqual({
      ok: false,
      reason: 'hash-unchanged',
      message: expect.any(String),
    });
  });

  it('台账三态①：done 双 hash 匹配 → 幂等 skip（gate 与 distillMaterial 双面）', async () => {
    seedMaterial();
    const { deps } = mkDeps();
    await distillMaterial(MATERIAL_ID, deps);
    expect(evaluateCraftDistillGate(MATERIAL_ID)).toEqual({ ok: false, reason: 'hash-unchanged', message: expect.any(String) });
    const again = await distillMaterial(MATERIAL_ID, deps);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('hash-unchanged');
    expect(listCraftCards({ materialId: MATERIAL_ID })).toHaveLength(1); // 零重复增生
  });

  it('台账三态②：原件 hash 变 → 全量重蒸（旧讲法 stale + 新讲法落卡，无模型去重关）', async () => {
    const material = seedMaterial();
    const { deps } = mkDeps();
    await distillMaterial(MATERIAL_ID, deps);
    const firstCardId = listCraftCards({ materialId: MATERIAL_ID })[0]!.cardId;

    // 原件变更（contentHash 换新）→ 重蒸。
    const newHash = `sha256:${createHash('sha256').update('新内容', 'utf-8').digest('hex')}`;
    upsertMaterialRow({ ...material, contentHash: newHash });
    extractionPayload = JSON.stringify([
      claimItem({ condensed: '压低起手再给回报，让情绪落差本身成为爽点' }), // 同主张重蒸
    ]);
    categorizationQueue = [`{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.8}`];
    const rerun = await distillMaterial(MATERIAL_ID, deps);
    expect(rerun.ok).toBe(true);

    // 去重关（无模型）→ 新建卡；旧卡讲法 stale（contentHash 已变——stale 判定锚）。
    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards).toHaveLength(2);
    const oldCard = getCraftCard(firstCardId)!;
    expect(oldCard.teachings[0]!.stale).toBe(true);
    expect(oldCard.teachings[0]!.materialContentHash).toBe(material.contentHash);
    const newCard = getCraftCard(cards.find((c) => c.cardId !== firstCardId)!.cardId)!;
    expect(newCard.teachings[0]!.stale).toBe(false);
    expect(newCard.teachings[0]!.materialContentHash).toBe(newHash);
  });

  it('台账三态③：派生 .md 校对编辑（原件 hash 不变）→ 讲法 stale 复核不重蒸（F-07）', async () => {
    const material = seedMaterial();
    const { deps, events } = mkDeps();
    await distillMaterial(MATERIAL_ID, deps);
    const firstEvents = events.length;

    // 派生编辑（contentHash 不变——校对场景）。
    writeFileSync(
      path.join(MATERIALS_ROOT, '.derived', '讲义.md'),
      `${DERIVED_TEXT}\n\n校对后新增的段落。`,
      'utf-8',
    );
    const rerun = await distillMaterial(MATERIAL_ID, deps);
    expect(rerun.ok).toBe(true);
    if (rerun.ok) expect(rerun.outcome).toBe('derived-stale-marked');

    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards).toHaveLength(1); // 零重蒸零新卡
    expect(getCraftCard(cards[0]!.cardId)!.teachings[0]!.stale).toBe(true);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.status).toBe('done');
    expect(ledger.error).toContain('派生 .md 已变更');
    expect(ledger.derivedHash).toBe(
      `sha256:${createHash('sha256').update(`${DERIVED_TEXT}\n\n校对后新增的段落。`, 'utf-8').digest('hex')}`,
    );
    expect(material.contentHash).toBe(ledger.contentHash); // 原件 hash 未动
    // 零 LLM 调用增量 + 零进度事件（未蒸馏——事件面留给真运行）。
    expect(genCalls.length).toBe(2); // 首轮 extraction+category 各一
    expect(events.length).toBe(firstEvents);
  });

  it('failed 半程重跑干净：切条不可解析落台账 failed → 修复后重跑零重复卡（单事务 + gate 放行）', async () => {
    seedMaterial();
    // 归类失败已改 per-claim 丢弃（CR-2b-2 不再产 failed 态）——材料级失败路径用切条不可解析构造。
    extractionPayload = 'this is not a json array';
    const { deps } = mkDeps();
    const first = await distillMaterial(MATERIAL_ID, deps);
    expect(first.ok).toBe(false);
    expect(getCraftDistillLedger(MATERIAL_ID)!.status).toBe('failed');
    expect(listCraftCards({ materialId: MATERIAL_ID })).toHaveLength(0);

    // 修复（重新装好切条载荷）→ 重跑（failed ≠ done，gate 放行）。
    extractionPayload = JSON.stringify([claimItem()]);
    categorizationQueue = [`{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.8}`];
    const rerun = await distillMaterial(MATERIAL_ID, deps);
    expect(rerun.ok).toBe(true);
    expect(listCraftCards({ materialId: MATERIAL_ID })).toHaveLength(1);
    expect(getCraftDistillLedger(MATERIAL_ID)!.status).toBe('done');
  });

  it('材料删除联动钩子：deleteMaterialRows → 讲法 stale + 台账 material-deleted（F-07③）', async () => {
    seedMaterial();
    const { deps } = mkDeps();
    await distillMaterial(MATERIAL_ID, deps);
    const cardId = listCraftCards({ materialId: MATERIAL_ID })[0]!.cardId;

    deleteMaterialRows(MATERIAL_ID);
    expect(getMaterialRow(MATERIAL_ID)).toBeNull();
    const card = getCraftCard(cardId)!; // 卡保留（快照仍在——防孤儿卡）
    expect(card.teachings[0]!.stale).toBe(true);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.status).toBe('material-deleted');
    expect(ledger.phase).toBeNull();
  });

  it('runCraftDistillBatch：门后执行 + 收尾释放槽（二跑 gate skip）', async () => {
    seedMaterial();
    const { deps } = mkDeps();
    const first = await runCraftDistillBatch([MATERIAL_ID], deps);
    expect(first).toHaveLength(1);
    expect(first[0]!.ok).toBe(true);
    const second = await runCraftDistillBatch([MATERIAL_ID], deps);
    expect(second).toHaveLength(0); // hash-unchanged gate skip
  });

  it('craftIpc distillRun：过门分类回报 + 后台批量派发；distillStatus 台账取数', async () => {
    seedMaterial();
    const runBatch = vi.fn(async (_materialIds: readonly string[]) => [] as DistillMaterialResult[]);
    const handlers = createCraftIpcHandlers({ runBatch });

    const runResult = await handlers.distillRun({ materialIds: [MATERIAL_ID, 'mat-0000000000ff'] });
    expect(runResult).toEqual({
      ok: true,
      queued: [MATERIAL_ID],
      skipped: [{ materialId: 'mat-0000000000ff', reason: 'not-found' }],
    });
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch.mock.calls[0]![0]).toEqual([MATERIAL_ID]);

    // 真批量执行（handler 占位槽被消费释放——不泄漏 already-running）。
    const { deps } = mkDeps();
    await runCraftDistillBatch([MATERIAL_ID], deps);
    expect(getCraftDistillLedger(MATERIAL_ID)!.status).toBe('done');

    const statusRows = await handlers.distillStatus({ materialIds: [MATERIAL_ID] });
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]!.materialId).toBe(MATERIAL_ID);
    expect(await handlers.distillStatus({})).toHaveLength(1); // 省略 = 全部行

    const bad = await handlers.distillRun({ materialIds: [] });
    expect(bad.ok).toBe(false);
  });

  it('not-ready 门：pending/failed 材料不可蒸（章界挂起与蒸馏正交——low-confidence 可蒸）', async () => {
    seedMaterial({ status: 'pending' });
    expect(evaluateCraftDistillGate(MATERIAL_ID)).toEqual({
      ok: false,
      reason: 'not-ready',
      message: expect.any(String),
    });
    const { deps } = mkDeps();
    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-ready');

    // low-confidence 可蒸（F-09 语义）。
    upsertMaterialRow(mkMaterial({ status: 'low-confidence' }));
    expect(evaluateCraftDistillGate(MATERIAL_ID).ok).toBe(true);
  });
});

describe.skipIf(!sqliteUsable)('craftDistillPipeline 去重三档（需 sqlite-vec；W3.5）', () => {
  beforeEach(() => {
    resetLlmFixtures();
    __clearCraftDistillLlmCoreForTest();
    __clearCraftDistillInflightForTest();
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    mkdirSync(path.join(MATERIALS_ROOT, '.derived'), { recursive: true });
    getDb();
    seedQingxuTerm();
    state.embedModel = stubModel('embed-a');
  });
  afterEach(() => {
    clean();
  });

  /** 既有卡种子（embed e0 向量——KNN 对比基）。 */
  async function seedExistingCard(condensed: string, vector: number[]): Promise<string> {
    const card: CraftCard = {
      cardId: 'card-00000000000a',
      category: 'qingxu',
      termId: TERM_QINGXU,
      title: '既有招式',
      claim: { condensed, points: [], scenarios: [], counterexamples: [] },
      tags: [],
      teachings: [
        {
          teachingId: 'tea-00000000000a',
          materialId: 'mat-ffffffffffff',
          materialContentHash: `sha256:${'f'.repeat(64)}`,
          author: '旧作者',
          quote: '旧引文',
          anchor: { chapterIndex: 0, charStart: 0, charEnd: 4, paraStart: 0, paraEnd: 1 },
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

  it('高置信档（sim ≥ 0.98）：自动挂候选——讲法 append + 卡回 pending_review + 相似度 note', async () => {
    if (!isSqliteVecAvailable()) return; // vec 扩展不可用环境跳过（去重本旨依赖向量）
    const existingCardId = await seedExistingCard('压低起手再给回报，让情绪落差本身成为爽点', vec1024(0));
    seedMaterial();
    embedVectors.set('压低起手再给回报，让情绪落差本身成为爽点', vec1024(0)); // 同向量 → sim 1.0
    const { deps } = mkDeps();

    const result = await distillMaterial(MATERIAL_ID, deps);
    expect(result.ok).toBe(true);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.mergedAuto).toBe(1);
    expect(ledger.stats.newCards).toBe(0);

    const card = getCraftCard(existingCardId)!;
    expect(card.teachings).toHaveLength(2); // 合并 = 多来源讲法聚合非删成一条（R3）
    expect(card.teachings[1]!.materialId).toBe(MATERIAL_ID);
    expect(card.teachings[1]!.note).toContain('相似度');
    expect(card.status).toBe('pending_review');
    // 全库仍只有这一张卡（挂候选不新建——新讲法挂上既有卡，该卡因新讲法归属本材料）。
    expect(listCraftCards()).toHaveLength(1);
    expect(listCraftCards()[0]!.cardId).toBe(existingCardId);
  });

  it('边界值 0.985（>0.98）仍走高置信档；阈值常量校准锚（R3 推测值）', async () => {
    if (!isSqliteVecAvailable()) return;
    expect(DEDUP_AUTO_SIMILARITY).toBe(0.98);
    expect(DEDUP_REVIEW_SIMILARITY).toBe(0.85);
    await seedExistingCard('基线主张', vec1024(0));
    seedMaterial();
    extractionPayload = JSON.stringify([claimItem({ condensed: '相似主张A' })]);
    categorizationQueue = [`{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.8}`];
    embedVectors.set('相似主张A', vecAtCosine(0.985));
    const { deps } = mkDeps();
    await distillMaterial(MATERIAL_ID, deps);
    expect(getCraftDistillLedger(MATERIAL_ID)!.stats.mergedAuto).toBe(1);
  });

  it('中置信档（0.85 ≤ sim < 0.98）：建 merge_review 行（newClaim 全载荷 + similarity 记录）', async () => {
    if (!isSqliteVecAvailable()) return;
    const existingCardId = await seedExistingCard('基线主张', vec1024(0));
    seedMaterial();
    extractionPayload = JSON.stringify([claimItem({ condensed: '相似主张B' })]);
    categorizationQueue = [`{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.7}`];
    embedVectors.set('相似主张B', vecAtCosine(0.9));
    const { deps } = mkDeps();

    await distillMaterial(MATERIAL_ID, deps);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.mergeReviews).toBe(1);
    expect(ledger.stats.newCards).toBe(0);

    const reviews = listCraftMergeReviews();
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.existingCardId).toBe(existingCardId);
    expect(review.similarity).toBeGreaterThan(0.85);
    expect(review.similarity).toBeLessThan(0.98);
    expect(review.similarity).toBeCloseTo(0.9, 1);
    expect(review.resolution).toBeNull();
    expect(review.newClaim.claim.condensed).toBe('相似主张B');
    expect(review.newClaim.quote).toBe('先压三拍再给回报。');
    expect(review.newClaim.materialId).toBe(MATERIAL_ID);
    expect(review.newClaim.termId).toBe(TERM_QINGXU);
    expect(review.newClaim.author).toBe('某作者');
    expect(review.newClaim.confidence).toBe(0.7);
    // CR-2b-D1：judgeDispute verdict 随 review 行持久化（一档候选 → review 行带 hint——默认 fixture 无分歧）。
    expect(review.disputeHint).toEqual({ dispute: false, reason: '同向' });
  });

  it('review 档 disputeHint 二态（D1 + CR-2b-13）：dispute=true 落 hint；LLM 失败缺省（不写暗示）', async () => {
    if (!isSqliteVecAvailable()) return;
    await seedExistingCard('基线主张', vec1024(0));
    seedMaterial();
    // 两条主张同对基线 0.9（中档）但彼此互异（正交分量分维——互不进对方批内比对）；
    // quote 异（同 quote 会被 teaching 幂等键批内去重）。
    extractionPayload = JSON.stringify([
      claimItem({ condensed: '相似主张C' }),
      claimItem({ condensed: '相似主张D', quote: '结尾不要拖，兑现要干脆。', paraRange: { start: 2, end: 3 } }),
    ]);
    categorizationQueue = [
      `{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.7}`,
      `{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.7}`,
    ];
    embedVectors.set('相似主张C', vecAtCosineOn(0.9, 1));
    embedVectors.set('相似主张D', vecAtCosineOn(0.9, 2));
    let disputeCalls = 0;
    const { deps } = mkDeps();
    const riggedDispute: CraftDistillGenerateText = async (input) => {
      if (input.system === DISPUTE_SYSTEM_PROMPT) {
        disputeCalls += 1;
        return disputeCalls === 1
          ? { text: '{"dispute":true,"reason":"一说压制起手，一说高开即爽"}' } // C：真分歧
          : { text: '###not-json###' }; // D：LLM 失败（judgeDispute never-throws → null）
      }
      return generateMock(input);
    };

    await distillMaterial(MATERIAL_ID, { ...deps, generateText: riggedDispute });
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.mergeReviews).toBe(2);
    expect(ledger.stats.disputes).toBe(1); // 失败侧不计 dispute
    const reviews = listCraftMergeReviews();
    expect(reviews).toHaveLength(2);
    const hinted = reviews.find((r) => r.disputeHint !== undefined)!;
    expect(hinted.disputeHint).toEqual({ dispute: true, reason: '一说压制起手，一说高开即爽' });
    const unhinted = reviews.find((r) => r.disputeHint === undefined)!;
    expect(unhinted.disputeHint).toBeUndefined(); // 缺省 = 判定不可用（不写「无分歧」暗示）
  });

  it('auto 档分歧判定失败（CR-2b-13）：讲法 note 诚实标注不可用（不写暗示已检查的候选）', async () => {
    if (!isSqliteVecAvailable()) return;
    const existingCardId = await seedExistingCard('压低起手再给回报，让情绪落差本身成为爽点', vec1024(0));
    seedMaterial();
    embedVectors.set('压低起手再给回报，让情绪落差本身成为爽点', vec1024(0)); // sim 1.0 → auto 档
    disputePayload = '###not-json###'; // judgeDispute → null（LLM 失败）
    const { deps } = mkDeps();

    await distillMaterial(MATERIAL_ID, deps);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.mergedAuto).toBe(1);
    expect(ledger.stats.disputes).toBe(0); // 失败不计 dispute
    const card = getCraftCard(existingCardId)!;
    expect(card.teachings[1]!.note).toContain('分歧判定不可用');
    expect(card.teachings[1]!.note).toContain('LLM 失败');
    expect(card.dispute).toBe(false); // 未判成——不置卡级分歧位
  });

  it('命中卡 mid-run 被删（CR-2b-8，vec/卡行漂移竞态）→ 降新建卡档：不建指向已删卡的 review 行', async () => {
    if (!isSqliteVecAvailable()) return;
    const existingCardId = await seedExistingCard('基线主张', vec1024(0));
    seedMaterial();
    extractionPayload = JSON.stringify([claimItem({ condensed: '相似主张E' })]);
    categorizationQueue = [`{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.7}`];
    embedVectors.set('相似主张E', vecAtCosine(0.9)); // 0.85-0.98 档命中既有卡
    const { deps } = mkDeps();
    // 构造漂移：只删卡行留 vec 行（正常删除会清 vec——等效模拟 mid-run 删除竞态窗口）。
    getDb().prepare('DELETE FROM closure_craft_card WHERE card_id=?').run(existingCardId);

    await distillMaterial(MATERIAL_ID, deps);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.newCards).toBe(1); // 降「新建卡」档
    expect(ledger.stats.mergeReviews).toBe(0); // 不建指向已删卡的 review 行（原 fallthrough 会建死行）
    expect(listCraftMergeReviews()).toHaveLength(0);
    expect(listCraftCards({ materialId: MATERIAL_ID })).toHaveLength(1);
  });

  it('低置信档（sim < 0.85）+ 无相似命中：新建卡（claim 向量同落——去重面常驻）', async () => {
    if (!isSqliteVecAvailable()) return;
    await seedExistingCard('基线主张', vec1024(0));
    seedMaterial();
    embedVectors.set('压低起手再给回报，让情绪落差本身成为爽点', vecAtCosine(0.1)); // 正交近似
    const { deps } = mkDeps();

    await distillMaterial(MATERIAL_ID, deps);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.newCards).toBe(1);
    const cards = listCraftCards({ materialId: MATERIAL_ID });
    expect(cards).toHaveLength(1);
    // 新卡 claim 向量落库（model 记账——落卡单事务同嵌）。
    const vecRow = getDb()
      .prepare(`SELECT model FROM closure_craft_entry WHERE craft_id=?`)
      .get(`card:${cards[0]!.cardId}`) as { model: string | null } | undefined;
    expect(vecRow).toBeUndefined(); // pending 卡无 entry 检索行（F-06——检索可见性 = 人审状态）
    const cardRow = getDb()
      .prepare(`SELECT claim_model FROM closure_craft_card WHERE card_id=?`)
      .get(cards[0]!.cardId) as { claim_model: string | null };
    expect(cardRow.claim_model).toBe('embed-a');
  });

  it('冲突判定（review-judge 档）：语义相反 → dispute 标记 + 讲法 note + disputes 计数', async () => {
    if (!isSqliteVecAvailable()) return;
    const existingCardId = await seedExistingCard('压低起手再给回报，让情绪落差本身成为爽点', vec1024(0));
    seedMaterial();
    embedVectors.set('压低起手再给回报，让情绪落差本身成为爽点', vec1024(0));
    disputePayload = '{"dispute":true,"reason":"一说压制起手，一说高开即爽"}';
    const { deps } = mkDeps();

    await distillMaterial(MATERIAL_ID, deps);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.mergedAuto).toBe(1);
    expect(ledger.stats.disputes).toBe(1);
    const card = getCraftCard(existingCardId)!;
    expect(card.dispute).toBe(true); // dispute 标记落卡（LLM 判 + 人审确认面）
    expect(card.teachings[1]!.note).toContain('疑似分歧');
    expect(card.teachings[1]!.note).toContain('一说压制起手');
  });

  it('prevailing mismatch：模型与存量不一致 → 去重关（全部新建 + 诚实 note）', async () => {
    await seedExistingCard('基线主张', vec1024(0)); // 存量 claim_model='embed-a'
    seedMaterial();
    state.embedModel = stubModel('embed-b'); // 与 prevailing 不一致
    embedVectors.set('压低起手再给回报，让情绪落差本身成为爽点', vec1024(0));
    const { deps } = mkDeps();

    await distillMaterial(MATERIAL_ID, deps);
    const ledger = getCraftDistillLedger(MATERIAL_ID)!;
    expect(ledger.stats.newCards).toBe(1);
    expect(ledger.stats.mergedAuto).toBe(0);
    expect(ledger.error).toContain('向量模型与存量不一致');
  });
});
