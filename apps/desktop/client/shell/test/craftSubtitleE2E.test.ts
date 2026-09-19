import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CraftDistillProgressEvent,
  ResolvedModel,
} from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// E10.2b CR-2b-21：字幕材料全链 e2e（AC9——e10-2a 软依赖已激活后的端到端验证）。
//
// 自制 .srt fixture（含停顿分节）→ registerMaterial（生产入口·全局车道；**LLM 整理不可用**
// → 字幕降级纯拼合，材料照 ready）→ distillMaterial（mock generateText 切条/归类；无 embed
// 模型 → 去重关全新建）→ 落卡断言：**锚定基面 = 降级拼合派生 .md**（anchor char span 切片
// 真实含引文）+ provenance 形状（medium='video' / author=null / 标题注入切条 prompt）。
//
// 全链经生产入口（registerMaterial = ingest + closure_material 登记 + 双车道 chunk 索引），
// srt 走字幕分支零 doc 解析依赖。ABI 门控 + throwaway home（mirror craftDistillPipeline.test.ts）。
// 全部 fixture 自制样文（AC11 版权红线）。
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-craft-subtitle-e2e');
const MATERIALS_ROOT = path.join(TEST_HOME, '.orison', 'materials');

const state = vi.hoisted(() => ({ embedModel: null as ResolvedModel | null }));

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
  CATEGORIZATION_SYSTEM_PROMPT,
  CLAIM_EXTRACTION_SYSTEM_PROMPT,
  __clearCraftDistillInflightForTest,
  __clearCraftDistillLlmCoreForTest,
  distillMaterial,
  type CraftDistillDeps,
  type CraftDistillGenerateText,
} from '../main/ipc/toolHandlers/craftDistillPipeline';
import {
  __clearMaterialLLMCoreForTest,
  normalizeMaterialText,
  stripChapterMarkerLines,
} from '../main/ipc/toolHandlers/materialIngest';
import { getMaterialRow, registerMaterial } from '../main/db/materialIndexer';
import { insertCraftTerm } from '../main/db/closureCraftTermRepository';
import { getCraftCard, listCraftCards } from '../main/db/closureCraftCardRepository';
import { getCraftDistillLedger } from '../main/db/closureCraftDistillRepository';
import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 ABI gate（mirror craftDistillPipeline.test.ts）：plain-Node vitest 下 skip。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

// ── 自制 srt fixture（两段：段内 cue 紧邻 gap 0.2s < 1.5s 停顿阈；段间停顿 4s > 阈分节）──

const SRT_FILE = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  '开篇要先压住主角',
  '',
  '2',
  '00:00:02,200 --> 00:00:04,000',
  '压三拍之后再给回报',
  '',
  '3',
  '00:00:08,000 --> 00:00:10,000',
  '情绪落差本身就是爽点',
  '',
  '4',
  '00:00:10,200 --> 00:00:12,000',
  '回报要干脆不拖泥带水',
  '',
].join('\n');

/** 降级拼合基面（joinSubtitleCues 产物——CJK 边界直拼、段间空行）。 */
const PARA_1 = '开篇要先压住主角压三拍之后再给回报';
const PARA_2 = '情绪落差本身就是爽点回报要干脆不拖泥带水';

const MATERIAL_NAME = '写作经验谈';
const TERM_QINGXU = 'term-00000001';

// ── 蒸馏 LLM mock（slot+system 路由——mirror craftDistillPipeline.test.ts 形态）──

interface GenCall {
  system?: string;
  user: string;
}
let genCalls: GenCall[] = [];
let extractionPayload = '[]';
let categorizationQueue: string[] = [];

const generateMock: CraftDistillGenerateText = async (input) => {
  genCalls.push({ system: input.system, user: input.user });
  if (input.system === CLAIM_EXTRACTION_SYSTEM_PROMPT) {
    return { text: extractionPayload };
  }
  if (input.system === CATEGORIZATION_SYSTEM_PROMPT) {
    const next = categorizationQueue.shift();
    if (next === undefined) throw new Error('categorizationQueue exhausted — fixture 未配置归类响应');
    return { text: next };
  }
  throw new Error(`unexpected system prompt: ${(input.system ?? '(none)').slice(0, 30)}`);
};

describe.skipIf(!sqliteUsable)('字幕材料全链 e2e（CR-2b-21——AC9）', () => {
  beforeEach(() => {
    genCalls = [];
    extractionPayload = '[]';
    categorizationQueue = [];
    state.embedModel = null;
    __clearCraftDistillLlmCoreForTest();
    __clearCraftDistillInflightForTest();
    __clearMaterialLLMCoreForTest();
    closeDb();
    resetSqliteVecState();
    rmBestEffort(TEST_HOME);
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    mkdirSync(MATERIALS_ROOT, { recursive: true }); // 全局车道根（srt 原件落此）
    getDb(); // 触发 schema init + vec 扩展装载
    insertCraftTerm({
      termId: TERM_QINGXU,
      category: 'qingxu',
      name: '先抑后扬',
      status: 'active',
      mergedInto: null,
      note: null,
    });
  });

  afterEach(() => {
    closeDb();
    resetSqliteVecState();
    rmBestEffort(TEST_HOME);
  });

  it('srt → 摄取（LLM 不可用降级拼合）→ 蒸馏（mock LLM）→ 落卡（锚定基面=降级拼合派生 .md + provenance 形状）', async () => {
    // ── 1) 摄取：自制 srt 经生产入口（全局车道 registerMaterial）——LLM 整理不可用 → 降级。──
    writeFileSync(path.join(MATERIALS_ROOT, `${MATERIAL_NAME}.srt`), SRT_FILE, 'utf-8');
    const reg = await registerMaterial({ scope: 'global' }, `${MATERIAL_NAME}.srt`);
    expect(reg.outcome).toBe('registered');
    const materialId = reg.materialId!;
    expect(materialId).toMatch(/^mat-[0-9a-f]{12}$/);

    const row = getMaterialRow(materialId);
    expect(row).not.toBeNull();
    expect(row!.format).toBe('srt');
    expect(row!.provenance.medium).toBe('video'); // provenance 形状（e10-2a 元数据接缝）
    expect(row!.provenance.author).toBeNull(); // 摄取期缺省——author 是 provenance 表单后补面
    expect(row!.status).toBe('ready'); // 降级不失败（检索照常）
    expect(row!.quality.parseNotes.join('\n')).toContain('字幕未经书面化整理');
    expect(row!.quality.parseNotes.join('\n')).toContain('LLM 整理内核未装配');

    // 派生 .md = 降级拼合（剥 mat-chapter 标记后 = 两段拼合文本——本测试的锚定基面即此文件）。
    const derived = normalizeMaterialText(
      readFileSync(path.join(MATERIALS_ROOT, '.derived', `${MATERIAL_NAME}.md`), 'utf-8'),
    );
    expect(stripChapterMarkerLines(derived)).toBe(`${PARA_1}\n\n${PARA_2}`);

    // ── 2) 蒸馏：mock 切条（两条主张，quote 取自拼合段落）+ 归类（known term）。──
    extractionPayload = JSON.stringify([
      {
        paraRange: { start: 0, end: 1 },
        quote: '压三拍之后再给回报',
        condensed: '开篇先压三拍再给回报，让落差本身成为爽点',
        points: ['起手压三拍'],
        scenarios: ['开篇'],
        counterexamples: [],
        tags: ['开篇', '情绪'],
      },
      {
        paraRange: { start: 1, end: 2 },
        quote: '回报要干脆不拖泥带水',
        condensed: '回报兑现要干脆利落，拖泥带水会稀释爽点',
        points: [],
        scenarios: ['低谷章'],
        counterexamples: ['高潮章前的关键兑现'],
        tags: ['回报'],
      },
    ]);
    categorizationQueue = [
      `{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.8}`,
      `{"category":"qingxu","termId":"${TERM_QINGXU}","confidence":0.7}`,
    ];
    const events: CraftDistillProgressEvent[] = [];
    const deps: CraftDistillDeps = {
      generateText: generateMock,
      resolveModel: () => state.embedModel, // null → 去重关（全部新建卡 + 诚实 note）
      notify: (e) => events.push(e),
      now: () => new Date('2026-09-05T12:00:00.000Z'),
    };
    const result = await distillMaterial(materialId, deps);
    expect(result.ok).toBe(true);

    // 切条 prompt 注入材料元数据（标题——provenance 摘要缝 F-11/AC9 对字幕材料的形状）。
    const extractionCall = genCalls.find((c) => c.system === CLAIM_EXTRACTION_SYSTEM_PROMPT)!;
    expect(extractionCall).toBeDefined();
    expect(extractionCall.user).toContain('【材料信息】');
    expect(extractionCall.user).toContain(`标题：${MATERIAL_NAME}`);
    expect(extractionCall.user).toContain('【P0】'); // 段号标记注入

    // 台账 done + stats 全景（两条主张全锚定零丢弃、全新建）。
    const ledger = getCraftDistillLedger(materialId)!;
    expect(ledger.status).toBe('done');
    expect(ledger.stats).toEqual({
      claims: 2,
      anchored: 2,
      droppedNoAnchor: 0,
      droppedMalformed: 0,
      droppedNoCategory: 0,
      mergedAuto: 0,
      mergeReviews: 0,
      newCards: 2,
      disputes: 0,
    });
    expect(ledger.error).toContain('去重不可用'); // 无 embed 模型诚实 note
    expect(events[events.length - 1]!.status).toBe('done');

    // ── 3) 落卡断言：锚定基面 = 降级拼合派生 .md（span 切片真实含引文——AC1 锚定核验闭环）。──
    const cards = listCraftCards({ materialId });
    expect(cards).toHaveLength(2);
    for (const summary of cards) {
      const card = getCraftCard(summary.cardId)!;
      expect(card.status).toBe('pending_review'); // 蒸馏产物待人审（F-06——无 entry 检索行）
      expect(card.termId).toBe(TERM_QINGXU);
      expect(card.teachings).toHaveLength(1);
      for (const t of card.teachings) {
        expect(t.materialId).toBe(materialId);
        expect(t.materialContentHash).toBe(row!.contentHash); // 字幕身份 = 确定性拼合 hash
        expect(t.author).toBeNull(); // provenance.author 透传（摄取期 null）
        expect(t.anchor.paraStart).toBeLessThan(t.anchor.paraEnd);
        const span = derived.slice(t.anchor.charStart, t.anchor.charEnd);
        expect(span).toContain(t.quote); // 锚定基面断言——span 真实含引文
      }
    }
    // 两条主张各挂一段（para 0 / para 1——停顿分节与锚定段落对齐）。
    const paras = cards
      .flatMap((c) => getCraftCard(c.cardId)!.teachings.map((t) => t.anchor.paraStart))
      .sort();
    expect(paras).toEqual([0, 1]);
  });
});
