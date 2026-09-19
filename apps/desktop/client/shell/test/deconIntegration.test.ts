import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CraftCard } from '@orison/shared-contracts';
import { deconFindingsSchema } from '@orison/shared-contracts';

// E10.3b W7：decon 集成验收（prd AC1/2/3/4/6/7/8——mock LLM 全链）。
//   - AC1 三档差异：同 fixture 材料 coarse/fine/deep 三 job——维度数差 / 细批 deep 独有 /
//     **P1 复用**（第二三 job 事实层 mock 计数=0，F-07）。
//   - AC2 计量复算：done 后崩溃模拟（翻 running + 删 p3b 台账行）重入管线——LLM pass 全
//     skip 零重付 + p3b 两跑同输出（重入路径的集成面；纯函数面 W2 已钉）。
//   - AC3 findings 全带验锚：全链产物遍历——evidence 非空 + paraRange 集内 + 引文在派生
//     .md 对应 span 内（isQuoteInSpan 单源复验）。
//   - AC4 craft 落卡+并排：p6 落卡 pending_review → 人审 verify 写 entry → searchCraft
//     同词目下教程卡与拆书卡并排命中 + originKind/bookTitle 落库。
//   - AC6 全流程状态序列：闸门开 create→start→dictionary 暂停→approve→canon 暂停→
//     approve→craft 暂停→approve→done；**progress 事件丢弃模拟**（不订阅）→ invoke get
//     兜底读态正确。
//   - AC7 导出映射：p4:style 产物 → export-style 写临时项目——payload 节落位 + 手写节保留。
//   - AC8 闸门零重付：approve 续跑后已完成的 pass mock 计数不增。
// AC5（10.2 回归）/AC9（金标，另文件）/AC10（typecheck+全量测试）由全量套件覆盖。
// ABI 门控 + throwaway home（mirror deconPipelineIpc.test.ts）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-integration');
const PROJECT_DIR = path.join(TEST_HOME, 'proj-export-target');

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
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  // partial mock：styleExport 消费 agent 包导出的 parseStyleSections（W1 入口补挂）——
  // 保留真实导出，只覆写 LLM 解析面（mirror deconStyleExport.test.ts 同款）。
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return { ...actual, resolveTaskModel: vi.fn(), assignmentThinkingControl: vi.fn() };
});
vi.mock('@orison/model-protocols', () => ({ generateText: vi.fn(), generateEmbeddings: vi.fn() }));

import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import {
  deleteDeconProductsByMaterial,
  getDeconJob,
  getDeconPassState,
  listDeconProducts,
  upsertDeconJob,
} from '../main/db/closure-decon';
import {
  getCraftCard,
  insertCraftCard,
  listCraftCards,
  reviewCraftCard,
} from '../main/db/closureCraftCardRepository';
import { listCraftTerms } from '../main/db/closureCraftTermRepository';
import { searchCraft } from '../main/db/closureCraftRetrieval';
import { ensureProject } from '../main/db/projectRepository';
import { runDeconPassSequence } from '../main/ipc/deconIpc';
import { allowPath } from '../main/ipc/pathGuard';
import { isQuoteInSpan } from '../main/decon/p1Extract';
import { buildChainHandlers, createDeconChainFixture, mkChainGenerate, zeroChainCounts, type ChainMockCounts } from './deconChainFixture';

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

const FX = createDeconChainFixture('mat-0000000000f7', '7');
const NOW = () => new Date('2026-09-05T20:00:00.000Z');
const ALL_CRAFT_DIMS = [
  'huoke', 'qidaigan', 'jiegou', 'renshe', 'shijieguan', 'qingxu',
  'wenbi', 'zaogeng', 'xinxicha', 'shijian', 'fubi', 'duizhao',
];

/** 全链跑一档（闸门关——进度/闸门面另有专项用例）。 */
async function runTier(
  counts: ChainMockCounts,
  tier: 'coarse' | 'fine' | 'deep',
  dimensions: string[],
): Promise<string> {
  const built = buildChainHandlers(FX, counts, { now: NOW });
  const created = await built.handlers.createDecon({ materialId: FX.matId, tier, dimensions, reviewCheckpoints: false });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('createDecon failed');
  await built.handlers.startDecon({ jobId: created.job.jobId });
  const result = await built.pipelineDone();
  expect(result.status).toBe('done');
  return created.job.jobId;
}

const maybe = sqliteUsable ? describe : describe.skip;

maybe('decon 集成验收（E10.3b W7——AC1/2/3/4/6/7/8）', () => {
  let counts: ChainMockCounts = zeroChainCounts();
  let tutorialTermId = '';

  beforeAll(async () => {
    rmBestEffort(TEST_HOME);
    getDb();
    // AC4 教程卡前置：懒种子词目「节奏调剂子型」（与 p6 落卡 mock 同词目——词目下并排）
    // + 一张 verified 教程卡（originKind 缺省 = doc_claim 语义，entry 检索行就位）。
    const term = listCraftTerms({ status: 'active' }).find((t) => t.name === '节奏调剂子型');
    expect(term).toBeDefined();
    tutorialTermId = term!.termId;
    const tutorialCard: CraftCard = {
      cardId: 'card-0000000000f7',
      category: term!.category,
      termId: term!.termId,
      title: '教程讲法：期待感早立',
      claim: {
        condensed: '教程主张：开篇早埋钩子立期待感，短间隔回收让期待兑现。',
        points: ['开篇三章内埋钩'],
        scenarios: ['开篇'],
        counterexamples: [],
      },
      tags: ['教程'],
      teachings: [
        {
          teachingId: 'tea-0000000000f7',
          materialId: 'mat-fffffffffff1',
          materialContentHash: `sha256:${'1'.repeat(64)}`,
          author: '教程作者',
          quote: '教程引文',
          anchor: { chapterIndex: 0, charStart: 0, charEnd: 4, paraStart: 0, paraEnd: 1 },
          rank: 'normal',
          note: null,
          stale: false,
        },
      ],
      dispute: false,
      status: 'verified',
      rejectReason: null,
      confidence: 0.9,
      createdAt: '2026-09-05T09:00:00.000Z',
      updatedAt: '2026-09-05T09:00:00.000Z',
    };
    await insertCraftCard(tutorialCard);
  });
  afterAll(clean);

  beforeEach(() => {
    deleteDeconProductsByMaterial(FX.matId);
    upsertMaterialRow(FX.material());
    counts = zeroChainCounts();
  });

  it('AC1：三档差异（维度数 / 细批 deep 独有 / p4:style）+ P1 复用零重付（F-07）', async () => {
    // ── coarse：零维——A 四 pass + p3 计量 + book_reading；无 p4/章评/细批/落卡。
    const coarseJob = await runTier(counts, 'coarse', []);
    expect(listDeconProducts(coarseJob).filter((p) => p.pass.startsWith('p4:'))).toHaveLength(0);
    expect(counts.p4).toBe(0);
    expect(counts.style).toBe(0);
    expect(counts.p5book).toBe(1);
    expect(counts.p5chapter).toBe(0);
    expect(counts.p5scene).toBe(0);
    expect(counts.p6).toBe(0);
    const coarseDetail = await buildChainHandlers(FX, counts, { now: NOW }).handlers.getDecon({ jobId: coarseJob });
    expect(coarseDetail?.reportCounts).toEqual({ book_reading: 1 });

    // ── fine（qidaigan）：P1 复用（事实层 mock 计数零增）+ 单维 p4 行 + 章评。
    const afterCoarse = { ...counts };
    const fineJob = await runTier(counts, 'fine', ['qidaigan']);
    expect(counts.classify).toBe(afterCoarse.classify); // AC1 P1 复用——词典/事实/消歧零重付
    expect(counts.facts).toBe(afterCoarse.facts);
    expect(counts.adjudicate).toBe(afterCoarse.adjudicate);
    const fineP4 = listDeconProducts(fineJob).filter((p) => p.pass.startsWith('p4:'));
    expect(fineP4.map((p) => `${p.pass}:${p.unit}`).sort()).toEqual(['p4:qidaigan:arc:0', 'p4:qidaigan:ch:0', 'p4:qidaigan:ch:1', 'p4:qidaigan:ch:2']);
    expect(counts.p5chapter).toBe(3);
    expect(counts.p5scene).toBe(0);
    const fineDetail = await buildChainHandlers(FX, counts, { now: NOW }).handlers.getDecon({ jobId: fineJob });
    expect(fineDetail?.reportCounts).toEqual({ book_reading: 1, chapter_review: 3 });

    // ── deep（全 12 + style）：P1 仍复用 + 全维 p4 + style 14 节 + 三 P5 kind（细批独有）+ p6。
    const afterFine = { ...counts };
    const deepJob = await runTier(counts, 'deep', [...ALL_CRAFT_DIMS, 'style']);
    expect(counts.classify).toBe(afterFine.classify); // 第三档 P1 仍零重付
    expect(counts.facts).toBe(afterFine.facts);
    expect(counts.adjudicate).toBe(afterFine.adjudicate);
    const deepP4 = listDeconProducts(deepJob).filter((p) => p.pass.startsWith('p4:'));
    const deepP4Passes = new Set(deepP4.map((p) => p.pass));
    expect(deepP4Passes.size).toBe(13); // 12 手艺维 + style（AC1 维度数差）
    expect(deepP4Passes.has('p4:style')).toBe(true);
    expect(listDeconProducts(deepJob, 'p4:style', 'all')).toHaveLength(1); // 14 节 payload 落位
    expect(deepP4.length).toBeGreaterThan(fineP4.length);
    expect(counts.style).toBe(1);
    expect(counts.p5scene).toBeGreaterThanOrEqual(1); // 细批 deep 独有
    const deepDetail = await buildChainHandlers(FX, counts, { now: NOW }).handlers.getDecon({ jobId: deepJob });
    expect(deepDetail?.reportCounts).toMatchObject({
      book_reading: 1,
      chapter_review: 3,
      scene_annotation: expect.any(Number),
    });
    expect(deepDetail!.reportCounts!.scene_annotation!).toBeGreaterThanOrEqual(1);
    // p6 落卡在（deep 手艺维 findings 有 craftHint——AC4 详查）。
    expect(getDeconPassState(deepJob, 'p6', 'all')?.status).toBe('done');
  });

  it('AC2：计量复算——崩溃模拟（删 p3b 台账）重入管线：LLM pass 全 skip 零重付 + p3b 同输出', async () => {
    const jobId = await runTier(counts, 'coarse', []);
    const statsBefore = JSON.stringify(listDeconProducts(jobId, 'p3b').map((r) => ({ unit: r.unit, payload: r.payload })));
    expect(statsBefore).not.toBe('[]');

    // 崩溃模拟：p3b 台账行丢失（产物在、状态行没写成）+ 假 running 残留（CR-1 家族形态）。
    const before = { ...counts };
    const jobRow = getDeconJob(jobId);
    expect(jobRow).not.toBeNull();
    if (jobRow === null) return;
    upsertDeconJob({ ...jobRow, status: 'running' });
    getDb().prepare(`DELETE FROM closure_decon_pass_state WHERE job_id=? AND pass='p3b'`).run(jobId);

    // 重入管线：注入链 mock（A 的 p2 runner 在 per-domain skip 前**前置**解析 LLM 内核
    // ——全 skip 的 job 不注入会撞「内核未装配」误红；p5/p6 已是惰性判定〔CR-10〕，p2 是
    // A 边界遗留，零重付证明由 counts 断言承载）。p3b 纯代码重算只需派生文本。
    const result = await runDeconPassSequence(jobId, {
      generateText: mkChainGenerate(FX, counts),
      readDerivedText: () => FX.derived,
      now: NOW,
    });
    expect(result.status).toBe('done');
    // 全部 LLM pass 台账 skip（p1a/p1b/p1c/p2/p3a/p5 的 output_hash 与产物现值一致）。
    expect(counts.classify).toBe(before.classify);
    expect(counts.facts).toBe(before.facts);
    expect(counts.adjudicate).toBe(before.adjudicate);
    expect(counts.portrait).toBe(before.portrait);
    expect(counts.labels).toBe(before.labels);
    expect(counts.p5book).toBe(before.p5book);
    // p3b 重算同输出（纯代码复算 AC2——同输入两跑同输出，集成面经管线重入路径）。
    const statsAfter = JSON.stringify(listDeconProducts(jobId, 'p3b').map((r) => ({ unit: r.unit, payload: r.payload })));
    expect(statsAfter).toBe(statsBefore);
    expect(getDeconJob(jobId)?.status).toBe('done');
  });

  it('AC3：findings 全带验锚——全链产物遍历 evidence 非空且锚点在派生 .md（无锚即丢红线集成面）', async () => {
    const jobId = await runTier(counts, 'deep', [...ALL_CRAFT_DIMS, 'style']);
    const findingsRows = listDeconProducts(jobId).filter((p) => p.pass.startsWith('p4:') && p.pass !== 'p4:style');
    expect(findingsRows.length).toBeGreaterThan(0);
    let totalFindings = 0;
    for (const row of findingsRows) {
      const parsed = deconFindingsSchema.safeParse(row.payload);
      expect(parsed.success, `${row.pass}:${row.unit} payload 形坏`).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.findings.length).toBeGreaterThan(0);
      for (const finding of parsed.data.findings) {
        totalFindings += 1;
        expect(finding.evidence.length).toBeGreaterThanOrEqual(1); // AC3 evidence 非空
        for (const ev of finding.evidence) {
          const { start, end } = ev.paraRange;
          expect(start).toBeGreaterThanOrEqual(0);
          expect(end).toBeGreaterThan(start);
          expect(end).toBeLessThanOrEqual(FX.blocks.length); // paraRange 集内
          const spanText = FX.derived.slice(FX.blocks[start]!.start, FX.blocks[end - 1]!.end);
          expect(isQuoteInSpan(ev.quote, spanText), `${row.pass}:${row.unit} 引文不在 span 内`).toBe(true); // 引文在派生 .md
        }
      }
    }
    expect(totalFindings).toBeGreaterThanOrEqual(13); // 12 维 + arc 面至少各一条
  });

  it('AC4：craft 落卡 + 并排——p6 落 pending_review 卡（originKind/bookTitle）→ verify 写 entry → searchCraft 同词目教程/拆书并排', async () => {
    const jobId = await runTier(counts, 'deep', [...ALL_CRAFT_DIMS, 'style']);

    // p6 落卡（无 embed 模型 → dedupOff 全部新建，pending_review 起板）。
    const deconCards = listCraftCards({ materialId: FX.matId });
    expect(deconCards.length).toBeGreaterThanOrEqual(1);
    for (const summary of deconCards) {
      expect(summary.status).toBe('pending_review'); // R3 红线：全量人过
      expect(summary.termId).toBe(tutorialTermId); // 与教程卡同词目（并排前提）
    }
    const target = deconCards[0]!;
    const landed = getCraftCard(target.cardId)!;
    const teaching = landed.teachings[0]!;
    expect(teaching.originKind).toBe('decon_instance'); // AC4 溯源落库
    expect(teaching.bookTitle).toBe('全链集成测试小说');
    expect(teaching.evidence).toBeDefined();
    expect(teaching.evidence!.derivedHash).toBe(FX.derivedHash);

    // 落卡状态机行为与 10.2 一致：pending → verify 写 entry 检索行（检索可见性 = 人审）。
    expect((await reviewCraftCard(target.cardId, 'verify')).ok).toBe(true);
    expect(getCraftCard(target.cardId)?.status).toBe('verified');

    // 并排查询面：searchCraft 同查询命中教程卡 + 拆书卡（词目下两来源并排——AC4）。
    const hits = await searchCraft('期待感', { k: 10 });
    const hitCardIds = hits.map((h) => h.craftId);
    expect(hitCardIds).toContain(`card:${'card-0000000000f7'}`); // 教程卡（doc_claim）
    const deconHit = hits.find((h) => {
      const card = getCraftCard(h.craftId.replace(/^card:/, ''));
      return card?.teachings.some((t) => t.originKind === 'decon_instance') === true;
    });
    expect(deconHit).toBeDefined(); // 拆书卡（decon_instance）
    if (deconHit !== undefined) {
      expect(deconHit.sourceKind).toBeDefined();
    }
  });

  it('AC6+AC8：闸门全流程状态序列（progress 丢弃模拟 + invoke get 兜底）+ approve 续跑零重付', async () => {
    // captureEvents=false：不注入 notify——生产 sendDeconProgress 广播无订阅者即丢
    //（AC6「progress 广播丢失后 invoke 兜底可恢复」的模拟面；读态全走 getDecon）。
    const built = buildChainHandlers(FX, counts, { now: NOW, captureEvents: false });
    const created = await built.handlers.createDecon({ materialId: FX.matId, tier: 'deep', dimensions: [...ALL_CRAFT_DIMS, 'style'] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;

    await built.handlers.startDecon({ jobId });
    let result = await built.pipelineDone();
    expect(result.status).toBe('paused'); // dictionary 闸门
    let detail = await built.handlers.getDecon({ jobId }); // 兜底读态（事件已丢）
    expect(detail?.job.status).toBe('paused');
    expect(detail?.reviews?.find((r) => r.checkpoint === 'dictionary')?.status).toBe('pending');
    const countsAfterP1 = { ...counts };

    expect((await built.handlers.approveDeconReview({ jobId, checkpoint: 'dictionary' })).ok).toBe(true);
    result = await built.pipelineDone();
    expect(result.status).toBe('paused'); // canon 闸门
    detail = await built.handlers.getDecon({ jobId });
    expect(detail?.job.status).toBe('paused');
    expect(detail?.reviews?.find((r) => r.checkpoint === 'canon')?.status).toBe('pending');
    // AC8 零重付（前段）：P1 不重调（台账 skip）。
    expect(counts.classify).toBe(countsAfterP1.classify);
    expect(counts.facts).toBe(countsAfterP1.facts);
    const countsAfterP2 = { ...counts };

    expect((await built.handlers.approveDeconReview({ jobId, checkpoint: 'canon' })).ok).toBe(true);
    result = await built.pipelineDone();
    expect(result.status).toBe('paused'); // craft 闸门（deep findings 在场）
    detail = await built.handlers.getDecon({ jobId });
    expect(detail?.job.status).toBe('paused');
    expect(detail?.reviews?.find((r) => r.checkpoint === 'craft')?.status).toBe('pending');
    expect(counts.portrait).toBe(countsAfterP2.portrait); // AC8 零重付（canon 后 P2 不重调）
    expect(counts.p4).toBeGreaterThan(0);
    const countsAfterP4 = { ...counts };

    expect((await built.handlers.approveDeconReview({ jobId, checkpoint: 'craft' })).ok).toBe(true);
    result = await built.pipelineDone();
    expect(result.status).toBe('done');
    detail = await built.handlers.getDecon({ jobId });
    expect(detail?.job.status).toBe('done');
    expect(detail?.reviews?.map((r) => [r.checkpoint, r.status])).toEqual([
      ['dictionary', 'approved'],
      ['canon', 'approved'],
      ['craft', 'approved'],
    ]);
    // AC8 零重付（craft 后）：P4 不重调（approve 续跑只补 P5/P6 尾段）。
    expect(counts.p4).toBe(countsAfterP4.p4);
    expect(detail?.reportCounts).toMatchObject({ book_reading: 1, chapter_review: 3, scene_annotation: expect.any(Number) });
  });

  it('AC7：导出映射——p4:style 产物 → export-style 写临时项目（payload 节落位 + 手写节保留）', async () => {
    const jobId = await runTier(counts, 'fine', ['qidaigan', 'style']);
    expect(listDeconProducts(jobId, 'p4:style', 'all')).toHaveLength(1);

    // 临时项目 + 预写手写卡（作者手记——导出不许动）。
    mkdirSync(PROJECT_DIR, { recursive: true });
    allowPath(PROJECT_DIR); // pick-directory 先例（mirror deconStyleExport.test.ts）
    const record = ensureProject({ name: '导出目标项目', type: 'novel', localFingerprint: PROJECT_DIR, path: PROJECT_DIR });
    const stylePath = path.join(PROJECT_DIR, 'settings', 'style.md');
    mkdirSync(path.join(PROJECT_DIR, 'settings'), { recursive: true });
    writeFileSync(stylePath, ['# 风格卡片', '', '## 作者手记', '', '我的手写节，导出不许动。', ''].join('\n'), 'utf-8');

    const built = buildChainHandlers(FX, counts, { now: NOW });
    const result = await built.handlers.exportStyleDecon({ jobId, projectId: record.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writtenSections).toEqual(['voice', 'stats', 'syntax', 'prohibitions', 'excerpt', 'appendix']); // 标准节序
    const written = readFileSync(stylePath, 'utf-8');
    expect(written).toContain('## 作者手记'); // 手写节保留
    expect(written).toContain('我的手写节，导出不许动。');
    expect(written).toContain('叙述者贴近主角的有限视角'); // payload voice 落位
    expect(written).toContain('## ② 机械统计'); // 纯代码三节（stats 直落数字）
    expect(written).toContain('```text'); // ⑬ 节选 fenced
    expect(written).toContain('全链集成测试小说'); // ⑭ 来源注记（书名）
    rmBestEffort(PROJECT_DIR);
  });
});
