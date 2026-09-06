import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CraftCard,
  CraftDistillLedger,
  CraftMergeReview,
  CraftTerm,
  CraftTeaching,
  Material,
} from '@orison/shared-contracts';

// E10.2b W5（task 09-05）：craftIpc 手艺卡人审面九通道测试。
//
//   - card-list：过滤参数透传（status/category/termId/tags OR/materialId LIKE + 置信排序）
//     + 摘要投影形状（termName join / teachingCount / materialIds）+ 坏枚举 throw（模式 B）。
//   - card-get：整卡往返 / 未知 id → null / 坏 id 形态 throw。
//   - card-patch：**编辑即降级双断言**（verified 卡 patch → status pending_review + entry 检索行
//     删——F-06）+ rejected-card / not-found / invalid-input 校验态 + termId 改挂 category 跟随。
//   - card-review：verify 写 entry / reject 删 entry / recover 救回 + 非法转换 invalid-state +
//     讲法 rank 改（不降级）+ 双缺省 invalid-input + 坏枚举。
//   - merge-review-list/resolve：三动作（merge 挂讲法幂等键派生 + independent 建卡词目墓碑跟随
//     + dismiss 零卡面动作）+ **重复 resolve 拒绝（invalid-state 幂等闸）** + 既有卡已删 not-found。
//   - term-list/approve/merge：懒种子 + pending 过滤 / 核准状态机 / 归并卡改挂 + category 跟随 +
//     **verified 卡 entry 行重写（body 换新词目名）** + movedCardCount。
//   - registerCraftIpc：11 通道恰好各注册一次。
//
// mock 形态 mirror closureCraftCardRepository.test.ts：electron app.getPath → TEST_HOME、
// modelGatewayIpc resolveEmbeddingModel → null（claim 向量 pending——零网络）、真跑 db（ABI 门控）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-craft-ipc');

const registeredChannels: string[] = [];

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
  ipcMain: {
    handle: (channel: string) => {
      registeredChannels.push(channel);
    },
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

// CR-2b-4 用（部分 mock 蒸馏管线模块）：evaluateCraftDistillGateSync 对指定材料抛错（模拟
// db 坏行中断 claim 循环），其余导出透传真身——同文件其它用例零影响（只对该 id 生效）。
const { GATE_THROW_ID } = vi.hoisted(() => ({ GATE_THROW_ID: 'mat-999badf00d11' }));
vi.mock('../main/ipc/toolHandlers/craftDistillPipeline', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../main/ipc/toolHandlers/craftDistillPipeline')
  >();
  return {
    ...actual,
    evaluateCraftDistillGateSync: (materialId: string) => {
      if (materialId === GATE_THROW_ID) throw new Error('gate db boom');
      return actual.evaluateCraftDistillGateSync(materialId);
    },
  };
});

import { createCraftIpcHandlers, registerCraftIpc } from '../main/ipc/craftIpc';
import {
  __clearCraftDistillInflightForTest,
  teachingIdFor,
} from '../main/ipc/toolHandlers/craftDistillPipeline';
import {
  cardCraftId,
  deleteCraftCardRow,
  getCraftCard,
  insertCraftCard,
} from '../main/db/closureCraftCardRepository';
import { insertCraftTerm, mergeCraftTerm } from '../main/db/closureCraftTermRepository';
import {
  insertCraftMergeReview,
  markCraftMergeReviewResolved,
} from '../main/db/closureCraftMergeReviewRepository';
import { upsertCraftDistillLedger } from '../main/db/closureCraftDistillRepository';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 ABI gate（mirror closureCraftCardRepository.test.ts）：plain-Node vitest 下 skip。
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

// ── fixtures ──

const T1 = 'term-00000001'; // qingxu 先抑后扬（active）
const T2 = 'term-00000002'; // qiaoduan 桥段甲（active）
const T3 = 'term-00000003'; // qingxu 待并词目（pending → 测试内 approve/merge）
const T4 = 'term-00000004'; // qingxu 已归并墓碑（beforeAll 直落 merged——resolve 墓碑跟随用例）

const CARD_A = 'card-0000000000a1';
const CARD_B = 'card-0000000000b2';
const CARD_C = 'card-0000000000c3';
const CARD_D = 'card-0000000000d4';
const CARD_E = 'card-0000000000e5';

function mkTeaching(over: Partial<CraftTeaching> = {}): CraftTeaching {
  return {
    teachingId: 'tea-000000000001',
    materialId: 'mat-000000000001',
    materialContentHash: `sha256:${'a'.repeat(64)}`,
    author: null,
    quote: '压三拍起手再回报，落差即爽点',
    anchor: { chapterIndex: 0, charStart: 0, charEnd: 12, paraStart: 0, paraEnd: 1 },
    rank: 'normal',
    note: null,
    stale: false,
    ...over,
  };
}

function mkCard(over: Partial<CraftCard> = {}): CraftCard {
  return {
    cardId: CARD_A,
    category: 'qingxu',
    termId: T1,
    title: '先抑后扬',
    claim: {
      condensed: '压低起手再回报，让情绪落差本身成为爽点',
      points: ['起手压三拍'],
      scenarios: ['开篇'],
      counterexamples: [],
    },
    tags: ['开篇', '情绪'],
    teachings: [mkTeaching()],
    dispute: false,
    status: 'pending_review',
    rejectReason: null,
    confidence: 0.9,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

const MAT2 = 'mat-000000000002';
const HASH_B = `sha256:${'b'.repeat(64)}`;

function mkReview(reviewId: string, over: Partial<CraftMergeReview> = {}): CraftMergeReview {
  return {
    reviewId,
    newClaim: {
      claim: {
        condensed: '另一来源的同招式讲法：先抑后扬的核心是回报延迟',
        points: ['延迟三拍再给回报'],
        scenarios: ['开篇', '低谷章'],
        counterexamples: [],
      },
      quote: '回报要压住再给，落差即爽点',
      anchor: { chapterIndex: 0, charStart: 0, charEnd: 10, paraStart: 0, paraEnd: 1 },
      materialId: MAT2,
      materialContentHash: HASH_B,
      author: '作者乙',
      category: 'qingxu',
      termId: T1,
      tags: ['回报'],
      confidence: 0.7,
    },
    existingCardId: CARD_A,
    similarity: 0.91,
    resolution: null,
    createdAt: '2026-09-05T11:00:00.000Z',
    ...over,
  };
}

function cardEntryRow(cardId: string): { body_text: string; craft_type: string } | undefined {
  return getDb()
    .prepare('SELECT body_text, craft_type FROM closure_craft_entry WHERE craft_id=?')
    .get(cardCraftId(cardId)) as { body_text: string; craft_type: string } | undefined;
}

/** 材料登记行 fixture（distill-run 便宜门用——形态 mirror craftDistillPipeline.test.ts mkMaterial）。 */
function mkMaterialRow(over: Partial<Material> = {}): Material {
  return {
    materialId: 'mat-0000000000e1',
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '槽补偿材料',
    format: 'txt',
    provenance: {
      medium: 'other',
      tier: 'unspecified',
      sourcePath: '槽补偿材料.txt',
      via: 'builtin-text',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-05T10:00:00.000Z',
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
      charCount: 10,
      chapterDetection: { method: 'none', confidence: 'low', matchedFormats: [] },
    },
    chapters: [],
    chunkSpans: [],
    contentHash: `sha256:${'e'.repeat(64)}`,
    status: 'ready',
    ...over,
  };
}

describe.skipIf(!sqliteUsable)('craftIpc W5 九通道（真跑 db——ABI 门控）', () => {
  const handlers = createCraftIpcHandlers();

  beforeAll(async () => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    // 词目：T1/T2 active、T3 pending、T4 直落 merged 墓碑（mergeInto T1——resolve 墓碑跟随用例）。
    for (const t of [
      { termId: T1, category: 'qingxu', name: '先抑后扬', status: 'active' },
      { termId: T2, category: 'qiaoduan', name: '桥段甲', status: 'active' },
      { termId: T3, category: 'qingxu', name: '待并词目', status: 'pending' },
    ] as CraftTerm[]) {
      insertCraftTerm({ ...t, mergedInto: null, note: null });
    }
    insertCraftTerm({
      termId: T4,
      category: 'qingxu',
      name: '已归并词目',
      status: 'pending',
      mergedInto: null,
      note: null,
    });
    mergeCraftTerm(T4, T1); // 墓碑化：merged_into=T1（invalid-state 用例 + resolve 墓碑跟随共用）

    // 卡：A pending（merge-review 系目标）/ B verified（patch 降级用——entry 行就位）/
    // C rejected（rejected-card 用例 + recover 救回）/ D pending（rank 用）/ E pending 挂 T3（term-merge 用）。
    await insertCraftCard(mkCard({ cardId: CARD_A, confidence: 0.9, tags: ['开篇', '情绪'] }));
    await insertCraftCard(
      mkCard({
        cardId: CARD_B,
        category: 'qiaoduan',
        termId: T2,
        title: '桥段转场',
        tags: ['转场'],
        confidence: 0.5,
        status: 'verified',
        teachings: [mkTeaching({ teachingId: 'tea-000000000002', materialId: MAT2 })],
      }),
    );
    await insertCraftCard(
      mkCard({
        cardId: CARD_C,
        confidence: 0.2,
        tags: ['开篇'],
        status: 'rejected',
        rejectReason: '与既有卡重复',
      }),
    );
    await insertCraftCard(mkCard({ cardId: CARD_D, confidence: 0.4 }));
    await insertCraftCard(mkCard({ cardId: CARD_E, termId: T3, confidence: 0.6 }));

    // 并排任务：R0 已裁决（list includeResolved 用例）/ R1 merge→A / R2 independent / R2b independent
    // （termId=T4 墓碑跟随）/ R3 dismiss→A / R4 merge→B（既有卡删除用例）。
    insertCraftMergeReview(mkReview('mrev-000000000000'));
    markCraftMergeReviewResolved('mrev-000000000000', {
      action: 'dismiss',
      resolvedAt: '2026-09-05T11:30:00.000Z',
      note: null,
    });
    insertCraftMergeReview(mkReview('mrev-000000000001')); // merge → A
    insertCraftMergeReview(mkReview('mrev-000000000002')); // independent
    insertCraftMergeReview(
      mkReview('mrev-0000000000ab', {
        newClaim: {
          claim: {
            condensed: '墓碑词目讲法',
            points: [],
            scenarios: [],
            counterexamples: [],
          },
          quote: '墓碑词目引文',
          anchor: { chapterIndex: 0, charStart: 0, charEnd: 8, paraStart: 0, paraEnd: 1 },
          materialId: MAT2,
          materialContentHash: HASH_B,
          author: null,
          category: 'qingxu',
          termId: T4, // 墓碑（merged_into=T1）
          tags: [],
          confidence: 0.5,
        },
        existingCardId: CARD_A,
        similarity: 0.88,
        resolution: null,
        createdAt: '2026-09-05T11:00:00.000Z',
      }),
    );
    insertCraftMergeReview(mkReview('mrev-000000000003')); // dismiss → A
    insertCraftMergeReview(mkReview('mrev-000000000004', { existingCardId: CARD_B })); // merge → B
  });

  afterAll(clean);

  // ── craft:card-list / craft:card-get（读面——plain 返回 + 坏参 throw 模式 B）──

  it('card-list：全量 + 摘要投影形状（termName join / teachingCount / materialIds）', async () => {
    const rows = await handlers.cardList(null);
    // A/B/C/D/E 五卡（懒种子词目不算卡）。按 confidence-asc 默认排序：C(0.2) D(0.4) B(0.5) E(0.6) A(0.9)。
    expect(rows.map((r) => r.cardId)).toEqual([CARD_C, CARD_D, CARD_B, CARD_E, CARD_A]);
    const a = rows.find((r) => r.cardId === CARD_A)!;
    expect(a.termName).toBe('先抑后扬'); // join 词目表
    expect(a.category).toBe('qingxu');
    expect(a.condensed).toBe('压低起手再回报，让情绪落差本身成为爽点');
    expect(a.teachingCount).toBe(1);
    expect(a.staleTeachingCount).toBe(0);
    expect(a.materialIds).toEqual(['mat-000000000001']);
    expect(a.status).toBe('pending_review');
    expect(a.dispute).toBe(false);
    expect(a.tags).toEqual(['开篇', '情绪']);
    expect(a.rejectReason).toBeNull();
  });

  it('card-list：status/category/termId/tags OR/materialId 过滤 + updated-desc 排序', async () => {
    expect((await handlers.cardList({ status: 'pending_review' })).map((r) => r.cardId)).toEqual([
      CARD_D,
      CARD_E,
      CARD_A,
    ]);
    expect((await handlers.cardList({ category: 'qiaoduan' })).map((r) => r.cardId)).toEqual([CARD_B]);
    expect((await handlers.cardList({ termId: T1 })).map((r) => r.cardId)).toEqual([CARD_C, CARD_D, CARD_A]);
    // tags OR：单标签与多标签任一命中（D/E 用默认 tags 含「开篇」）。
    expect((await handlers.cardList({ tags: ['开篇'] })).map((r) => r.cardId)).toEqual([
      CARD_C,
      CARD_D,
      CARD_E,
      CARD_A,
    ]);
    expect((await handlers.cardList({ tags: ['转场', '不存在标签'] })).map((r) => r.cardId)).toEqual([CARD_B]);
    // materialId：讲法来源过滤（B 的讲法挂 MAT2）。
    expect((await handlers.cardList({ materialId: MAT2 })).map((r) => r.cardId)).toEqual([CARD_B]);
    const updatedDesc = await handlers.cardList({ sort: 'updated-desc' });
    expect(updatedDesc.length).toBe(5);
  });

  it('card-list：坏枚举/坏形态 throw（模式 B——显式坏参优于静默滤丢）', async () => {
    await expect(handlers.cardList({ status: 'bogus' })).rejects.toThrow(/status 须为/);
    await expect(handlers.cardList({ category: 'bogus' })).rejects.toThrow(/category 须为/);
    await expect(handlers.cardList({ sort: 'bogus' })).rejects.toThrow(/sort 须为/);
    await expect(handlers.cardList({ termId: 'not-a-term' })).rejects.toThrow(/termId 形态非法/);
    await expect(handlers.cardList({ materialId: 'mat-xx' })).rejects.toThrow(/materialId 形态非法/);
    await expect(handlers.cardList({ tags: '开篇' })).rejects.toThrow(/tags 须为/);
    await expect(handlers.cardList('not-an-object')).rejects.toThrow(/入参须为对象/);
  });

  it('card-get：整卡往返 / 未知 id → null / 坏形态 throw', async () => {
    const card = await handlers.cardGet({ cardId: CARD_A });
    expect(card?.cardId).toBe(CARD_A);
    expect(card?.teachings[0]?.teachingId).toBe('tea-000000000001');
    expect(await handlers.cardGet({ cardId: 'card-ffffffffffff' })).toBeNull();
    await expect(handlers.cardGet({ cardId: 'bad-id' })).rejects.toThrow(/形态非法/);
    await expect(handlers.cardGet({})).rejects.toThrow(/需要 cardId/);
  });

  // ── craft:card-patch（编辑即降级——状态 + entry 检索行双断言）──

  it('card-patch：verified 卡编辑 → 降级 pending_review + entry 检索行删（F-06 双断言）', async () => {
    expect(cardEntryRow(CARD_B)).toBeDefined(); // 前置：verified 卡 entry 行在
    const res = await handlers.cardPatch({
      cardId: CARD_B,
      patch: { title: '桥段转场·修订' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.card.status).toBe('pending_review'); // 降级
      expect(res.card.title).toBe('桥段转场·修订');
    }
    expect(getCraftCard(CARD_B)?.status).toBe('pending_review');
    expect(cardEntryRow(CARD_B)).toBeUndefined(); // 检索可见性收回
  });

  it('card-patch：termId 改挂 → category 跟随新词目单源（F-15）', async () => {
    const res = await handlers.cardPatch({ cardId: CARD_D, patch: { termId: T2 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.card.termId).toBe(T2);
      expect(res.card.category).toBe('qiaoduan'); // 恒跟随 term.category
    }
  });

  it('card-patch：rejected-card / not-found / invalid-input 校验态', async () => {
    const rejected = await handlers.cardPatch({ cardId: CARD_C, patch: { title: 'x' } });
    expect(rejected).toMatchObject({ ok: false, error: 'rejected-card' });
    const missing = await handlers.cardPatch({ cardId: 'card-ffffffffffff', patch: { title: 'x' } });
    expect(missing).toMatchObject({ ok: false, error: 'not-found' });
    const badTerm = await handlers.cardPatch({ cardId: CARD_A, patch: { termId: 'term-ffffffff' } });
    expect(badTerm).toMatchObject({ ok: false, error: 'invalid-input' }); // 词目不存在（形态合法——repo 档）
    expect(await handlers.cardPatch({ cardId: 'bad', patch: { title: 'x' } })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
    expect(await handlers.cardPatch({ cardId: CARD_A, patch: {} })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
    expect(await handlers.cardPatch({ cardId: CARD_A, patch: { title: '   ' } })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
    expect(
      await handlers.cardPatch({ cardId: CARD_A, patch: { claim: { condensed: '' } } }),
    ).toMatchObject({ ok: false, error: 'invalid-input' });
    expect(await handlers.cardPatch({ cardId: CARD_A, patch: { tags: [''] } })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
  });

  // ── craft:card-review（状态机 verify/reject/recover + 讲法 rank）──

  it('card-review verify：pending → verified + entry 检索行写（AC6 双断言）', async () => {
    const res = await handlers.cardReview({ cardId: CARD_A, action: 'verify' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.card.status).toBe('verified');
    const entry = cardEntryRow(CARD_A);
    expect(entry).toBeDefined();
    expect(entry?.craft_type).toBe('qingxu'); // craft_type = 大类 slug（F-10）
    expect(entry?.body_text).toContain('先抑后扬'); // 词目名进检索 body
  });

  it('card-review：非法转换 invalid-state（verified 再 verify / 非 rejected recover）', async () => {
    expect(await handlers.cardReview({ cardId: CARD_A, action: 'verify' })).toMatchObject({
      ok: false,
      error: 'invalid-state',
    });
    expect(await handlers.cardReview({ cardId: CARD_A, action: 'recover' })).toMatchObject({
      ok: false,
      error: 'invalid-state',
    });
  });

  it('card-review reject：verified → rejected + entry 行删 + 理由落库；recover 救回清理由', async () => {
    const res = await handlers.cardReview({ cardId: CARD_A, action: 'reject', rejectReason: '讲法不可靠' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.card.status).toBe('rejected');
      expect(res.card.rejectReason).toBe('讲法不可靠');
    }
    expect(cardEntryRow(CARD_A)).toBeUndefined(); // reject 删检索行
    const recovered = await handlers.cardReview({ cardId: CARD_A, action: 'recover' });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.card.status).toBe('pending_review');
      expect(recovered.card.rejectReason).toBeNull();
    }
  });

  it('card-review teachingRank：rank 改级不降级卡（verified 保持）+ note 落库；未知讲法 not-found', async () => {
    // D 在 verified 态改 rank——rank 是讲法级状态，与内容编辑（降级）正交（W1 契约注记）。
    await handlers.cardReview({ cardId: CARD_D, action: 'verify' });
    const res = await handlers.cardReview({
      cardId: CARD_D,
      teachingRank: { teachingId: 'tea-000000000001', rank: 'approved', note: '亲测有效' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.card.status).toBe('verified'); // 不触发降级——entry 检索可见性保持
      expect(res.card.teachings[0]?.rank).toBe('approved');
      expect(res.card.teachings[0]?.note).toBe('亲测有效');
    }
    expect(cardEntryRow(CARD_D)).toBeDefined(); // entry 行不动（rank 过滤归命中渲染）
    expect(
      await handlers.cardReview({
        cardId: CARD_D,
        teachingRank: { teachingId: 'tea-ffffffffffff', rank: 'normal' },
      }),
    ).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('card-review 校验态：双缺省 / 坏 action / 坏 rank / 坏 cardId / 未知卡', async () => {
    expect(await handlers.cardReview({ cardId: CARD_A })).toMatchObject({ ok: false, error: 'invalid-input' });
    expect(await handlers.cardReview({ cardId: CARD_A, action: 'bogus' })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
    expect(
      await handlers.cardReview({
        cardId: CARD_A,
        teachingRank: { teachingId: 'tea-000000000001', rank: 'bogus' },
      }),
    ).toMatchObject({ ok: false, error: 'invalid-input' });
    expect(await handlers.cardReview({ cardId: 'bad', action: 'verify' })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
    expect(await handlers.cardReview({ cardId: 'card-ffffffffffff', action: 'verify' })).toMatchObject({
      ok: false,
      error: 'not-found',
    });
  });

  // ── craft:merge-review-list / craft:merge-review-resolve（三动作 + 幂等闸）──

  it('merge-review-list：默认仅待审；includeResolved 含已裁决；坏形态 throw', async () => {
    const pending = await handlers.mergeReviewList({});
    expect(pending.map((r) => r.reviewId).sort()).toEqual([
      'mrev-000000000001',
      'mrev-000000000002',
      'mrev-000000000003',
      'mrev-000000000004',
      'mrev-0000000000ab',
    ]);
    const all = await handlers.mergeReviewList({ includeResolved: true });
    expect(all.length).toBe(6); // + mrev-000000000000（已裁决）
    expect(all.find((r) => r.reviewId === 'mrev-000000000000')?.resolution?.action).toBe('dismiss');
    await expect(handlers.mergeReviewList({ includeResolved: 'yes' })).rejects.toThrow(/须为 boolean/);
  });

  it('merge-review-resolve merge：讲法挂既有卡（幂等键派生 + 卡降级 + entry 删）+ review 落账', async () => {
    // A 现为 pending（recover 后）——先 verify 让 entry 行就位，merge 后降级删行全链断言。
    await handlers.cardReview({ cardId: CARD_A, action: 'verify' });
    expect(cardEntryRow(CARD_A)).toBeDefined();
    const res = await handlers.mergeReviewResolve({
      reviewId: 'mrev-000000000001',
      action: 'merge',
      note: '同一招式两个来源',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mergedIntoCardId).toBe(CARD_A);
      expect(res.review.resolution?.action).toBe('merge');
      expect(res.review.resolution?.note).toBe('同一招式两个来源');
    }
    const card = getCraftCard(CARD_A);
    expect(card?.status).toBe('pending_review'); // 挂讲法 = 内容编辑 → 降级
    expect(card?.teachings.length).toBe(2);
    // teachingId = teachingIdFor(materialId + contentHash + quote 归一) 幂等键派生（W1 契约）。
    expect(card?.teachings[1]?.teachingId).toBe(teachingIdFor(MAT2, HASH_B, '回报要压住再给，落差即爽点'));
    expect(card?.teachings[1]?.note).toBe('同一招式两个来源');
    expect(cardEntryRow(CARD_A)).toBeUndefined(); // 降级 → 检索可见性收回
  });

  it('merge-review-resolve：重复 resolve 拒绝（invalid-state 幂等闸）', async () => {
    const again = await handlers.mergeReviewResolve({ reviewId: 'mrev-000000000001', action: 'dismiss' });
    expect(again).toMatchObject({ ok: false, error: 'invalid-state' });
  });

  it('merge-review-resolve independent：新建卡 pending_review + 讲法/词目/标签落位 + 幂等键', async () => {
    const before = (await handlers.cardList({})).length;
    const res = await handlers.mergeReviewResolve({ reviewId: 'mrev-000000000002', action: 'independent' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.createdCardId).toBeDefined();
    expect(res.review.resolution?.action).toBe('independent');
    const card = getCraftCard(res.createdCardId!);
    expect(card?.status).toBe('pending_review'); // 裁决产物必须再过人审 verify 才进检索面
    expect(card?.claim.condensed).toBe('另一来源的同招式讲法：先抑后扬的核心是回报延迟');
    expect(card?.tags).toEqual(['回报']);
    expect(card?.termId).toBe(T1);
    expect(card?.teachings[0]?.materialId).toBe(MAT2);
    expect(card?.teachings[0]?.teachingId).toBe(teachingIdFor(MAT2, HASH_B, '回报要压住再给，落差即爽点'));
    expect((await handlers.cardList({})).length).toBe(before + 1);
  });

  it('merge-review-resolve independent：newClaim.termId 墓碑跟随 mergedInto（词目归并后裁决）', async () => {
    const res = await handlers.mergeReviewResolve({ reviewId: 'mrev-0000000000ab', action: 'independent' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const card = getCraftCard(res.createdCardId!);
    expect(card?.termId).toBe(T1); // T4 墓碑 → 跟随 merged_into=T1
    expect(card?.category).toBe('qingxu'); // category 随目标词目
  });

  it('merge-review-resolve dismiss：零卡面动作 + review 落账留痕', async () => {
    const before = (await handlers.cardList({})).length;
    const res = await handlers.mergeReviewResolve({ reviewId: 'mrev-000000000003', action: 'dismiss' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.review.resolution?.action).toBe('dismiss');
    expect((await handlers.cardList({})).length).toBe(before); // 无新建/无挂载
  });

  it('merge-review-resolve merge：既有卡已删 → not-found（裁决无落点）', async () => {
    deleteCraftCardRow(CARD_B);
    const res = await handlers.mergeReviewResolve({ reviewId: 'mrev-000000000004', action: 'merge' });
    expect(res).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('merge-review-resolve 校验态：坏 reviewId / 坏 action / 未知 review', async () => {
    expect(await handlers.mergeReviewResolve({ reviewId: 'bad', action: 'merge' })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
    expect(
      await handlers.mergeReviewResolve({ reviewId: 'mrev-000000000003', action: 'bogus' }),
    ).toMatchObject({ ok: false, error: 'invalid-input' });
    expect(
      await handlers.mergeReviewResolve({ reviewId: 'mrev-ffffffffffff', action: 'merge' }),
    ).toMatchObject({ ok: false, error: 'not-found' });
  });

  // ── E10.3b W7 小补①：decon 实例经并排裁决成卡——additive 三字段透传保留（AC4 语义完整性）──
  //（行在本测试体内插——不扰前面 merge-review-list 的固定队列断言。）

  /** decon 实例载荷版 review（newClaim 带 originKind/bookTitle/evidence——p6Craft 中档落点形态）。
   *  quote 换新——teachingId 幂等键（materialId+hash+quote）不与前面用例的教学三元组碰撞，
   *  append 走真追加而非幂等 no-op。 */
  function mkDeconInstanceReview(reviewId: string): CraftMergeReview {
    const base = mkReview(reviewId);
    return {
      ...base,
      newClaim: {
        ...base.newClaim,
        quote: '拆书实例引文：开篇早埋人物情感钩',
        originKind: 'decon_instance',
        bookTitle: '拆书来源小说',
        evidence: {
          anchors: [{ chapterIndex: 0, charStart: 0, charEnd: 10, paraStart: 0, paraEnd: 1 }],
          level: 'strong',
          derivedHash: HASH_B,
        },
      },
    };
  }

  it('merge-review-resolve independent：decon 实例独立成卡——讲法保留 originKind/bookTitle/evidence', async () => {
    insertCraftMergeReview(mkDeconInstanceReview('mrev-0000000000c1'));
    const res = await handlers.mergeReviewResolve({ reviewId: 'mrev-0000000000c1', action: 'independent' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.createdCardId).toBeDefined();
    const card = getCraftCard(res.createdCardId!);
    expect(card?.status).toBe('pending_review');
    const teaching = card?.teachings[0];
    expect(teaching?.originKind).toBe('decon_instance'); // 身份不丢（人审页来源徽章消费）
    expect(teaching?.bookTitle).toBe('拆书来源小说');
    expect(teaching?.evidence?.level).toBe('strong');
    expect(teaching?.evidence?.derivedHash).toBe(HASH_B);
  });

  it('merge-review-resolve merge：decon 实例挂既有教程卡——讲法并排且保留 originKind（词目下双来源）', async () => {
    insertCraftMergeReview(mkDeconInstanceReview('mrev-0000000000c2'));
    const res = await handlers.mergeReviewResolve({ reviewId: 'mrev-0000000000c2', action: 'merge' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mergedIntoCardId).toBe(CARD_A);
    const card = getCraftCard(CARD_A);
    const appended = card?.teachings.at(-1);
    expect(appended?.originKind).toBe('decon_instance'); // 10.2 教程卡上并排拆书讲法（溯源可见）
    expect(appended?.bookTitle).toBe('拆书来源小说');
    expect(appended?.evidence?.anchors).toHaveLength(1);
  });

  // ── craft:term-list / craft:term-approve / craft:term-merge ──

  it('term-list：懒种子落位 + pending 过滤 + 坏枚举 throw', async () => {
    const all = await handlers.termList({});
    const names = all.map((t) => t.name);
    // 五白话散并位种子（design §1.2）懒落位。
    for (const seed of ['同类场景变奏', '固定调度模式', '人物对照组', '角色声纹', '节奏调剂子型']) {
      expect(names).toContain(seed);
    }
    expect(names).toContain('待并词目'); // T3
    const pending = await handlers.termList({ status: 'pending' });
    expect(pending.map((t) => t.termId)).toEqual([T3]); // T4 已墓碑（merged）不在 pending
    const merged = await handlers.termList({ status: 'merged' });
    expect(merged.map((t) => t.termId)).toEqual([T4]);
    const byCategory = await handlers.termList({ category: 'qiaoduan' });
    expect(byCategory.every((t) => t.category === 'qiaoduan')).toBe(true);
    await expect(handlers.termList({ status: 'bogus' })).rejects.toThrow(/status 须为/);
    await expect(handlers.termList({ category: 'bogus' })).rejects.toThrow(/category 须为/);
  });

  it('term-approve：pending → active；已 active → invalid-state；未知 → not-found；坏形态 → invalid-input', async () => {
    const res = await handlers.termApprove({ termId: T3 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.term.status).toBe('active');
    expect(await handlers.termApprove({ termId: T1 })).toMatchObject({ ok: false, error: 'invalid-state' });
    expect(await handlers.termApprove({ termId: T4 })).toMatchObject({ ok: false, error: 'invalid-state' });
    expect(await handlers.termApprove({ termId: 'term-ffffffff' })).toMatchObject({
      ok: false,
      error: 'not-found',
    });
    expect(await handlers.termApprove({ termId: 'bad' })).toMatchObject({ ok: false, error: 'invalid-input' });
    expect(await handlers.termApprove({})).toMatchObject({ ok: false, error: 'invalid-input' });
  });

  it('term-merge：卡改挂 + category 跟随 + verified 卡 entry 行重写（body 换新词目名）+ movedCardCount', async () => {
    // E 挂 T3 → verify 让 entry 行就位（body 含旧词目名「待并词目」）→ merge T3 → T1 → entry 重写。
    await handlers.cardReview({ cardId: CARD_E, action: 'verify' });
    expect(cardEntryRow(CARD_E)?.body_text).toContain('待并词目');
    const res = await handlers.termMerge({ termId: T3, mergeIntoTermId: T1 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.term.status).toBe('merged');
      expect(res.term.mergedInto).toBe(T1);
      expect(res.movedCardCount).toBeGreaterThanOrEqual(1);
    }
    const card = getCraftCard(CARD_E);
    expect(card?.termId).toBe(T1); // 改挂
    expect(card?.category).toBe('qingxu');
    expect(cardEntryRow(CARD_E)?.body_text).toContain('先抑后扬'); // entry 重写——检索面说新词目的话
  });

  it('term-merge 校验态：同 id / 墓碑源 / 未知 / 坏形态', async () => {
    expect(await handlers.termMerge({ termId: T1, mergeIntoTermId: T1 })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
    expect(await handlers.termMerge({ termId: T4, mergeIntoTermId: T1 })).toMatchObject({
      ok: false,
      error: 'invalid-state',
    });
    expect(await handlers.termMerge({ termId: T1, mergeIntoTermId: 'term-ffffffff' })).toMatchObject({
      ok: false,
      error: 'not-found',
    });
    expect(await handlers.termMerge({ termId: 'bad', mergeIntoTermId: T1 })).toMatchObject({
      ok: false,
      error: 'invalid-input',
    });
  });

  // ── CR-2b 修复批（组 Q）：读面纪律归一 + distill 槽补偿 ──

  it('card-list tags 归一（CR-2b-26）：剥前导 # + trim + 去空去重（mirror searchCraft）；形态坏仍 throw', async () => {
    const plain = await handlers.cardList({ tags: ['开篇'] });
    // 命中渲染展示 `#tag` 形态——UI chips 点击过滤把展示形态原样传回是自然输入。
    expect((await handlers.cardList({ tags: ['#开篇'] })).map((r) => r.cardId).sort()).toEqual(
      plain.map((r) => r.cardId).sort(),
    );
    expect((await handlers.cardList({ tags: ['  开篇  '] })).map((r) => r.cardId).sort()).toEqual(
      plain.map((r) => r.cardId).sort(),
    );
    // 去重：# 前缀形态与裸形态同键。
    expect(await handlers.cardList({ tags: ['#开篇', '开篇'] })).toHaveLength(plain.length);
    // 归一后全空 = 无该过滤项（返回全部行——值抖动是预期输入非攻击面，不 throw）。
    expect(await handlers.cardList({ tags: ['', '#', '  '] })).toHaveLength(
      (await handlers.cardList({})).length,
    );
    // 形态坏（非数组 / 混非字符串）仍 throw（模式 B——读面坏参显式可见）。
    await expect(handlers.cardList({ tags: '开篇' })).rejects.toThrow(/tags 须为/);
    await expect(handlers.cardList({ tags: [1] })).rejects.toThrow(/tags 须为/);
  });

  it('distill-status（CR-2b-26）：materialIds 键形态坏 → 显式忽略该过滤键返回全部行（非静默吞）', async () => {
    const mkLedger = (materialId: string, status: 'done' | 'failed'): CraftDistillLedger => ({
      materialId,
      // contentHash 须合 schema 形态（sha256:<64hex>——坏形态行会被 rowToLedger 容错跳过）。
      contentHash: `sha256:${materialId.endsWith('d1') ? '1'.repeat(64) : '2'.repeat(64)}`,
      derivedHash: `sha256:${'d'.repeat(64)}`,
      status,
      stats: {
        claims: 1,
        anchored: 1,
        droppedNoAnchor: 0,
        droppedMalformed: 0,
        droppedNoCategory: 0,
        mergedAuto: 0,
        mergeReviews: 0,
        newCards: 1,
        disputes: 0,
      },
      phase: null,
      error: null,
      distilledAt: '2026-09-05T12:00:00.000Z',
    });
    upsertCraftDistillLedger(mkLedger('mat-0000000000d1', 'done'));
    upsertCraftDistillLedger(mkLedger('mat-0000000000d2', 'failed'));
    // 键在场但非数组 → 忽略该过滤键 = 全部行（无过滤=全部是保留语义；warn 留痕）。
    expect(
      (await handlers.distillStatus({ materialIds: 'not-an-array' })).map((r) => r.materialId).sort(),
    ).toEqual(['mat-0000000000d1', 'mat-0000000000d2']);
    // 数组内混非字符串：有效 id 照用、垃圾项过滤。
    expect(
      (await handlers.distillStatus({ materialIds: ['mat-0000000000d1', 42, null] })).map(
        (r) => r.materialId,
      ),
    ).toEqual(['mat-0000000000d1']);
  });

  it('distill-run（CR-2b-4）：claim 循环意外中断 → 已占位槽仍派发批量（per-item finally 释放）+ operation-failed', async () => {
    // 材料 A ready（过便宜门）；材料 B 触发 gate 抛错（db 坏行模拟——上方部分 mock 替身）。
    upsertMaterialRow(mkMaterialRow({ materialId: 'mat-0000000000e1' }));
    const runBatch = vi.fn(async (_materialIds: readonly string[]) => []);
    const probe = createCraftIpcHandlers({ runBatch });
    const res = await probe.distillRun({ materialIds: ['mat-0000000000e1', GATE_THROW_ID] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('operation-failed');
    // 已 claim 的材料 A 仍派发——真批量的 per-item finally 是唯一释放点（对预占位材料批内
    // 零 gate 调用，早退源被结构性绕开）；原实现中断即弃派发 → A 永久 already-running。
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch.mock.calls[0]![0]).toEqual(['mat-0000000000e1']);
    __clearCraftDistillInflightForTest(); // 清理：spy runBatch 不释放占位（真 runBatch 会）
  });

  // ── 注册面（11 通道恰好各一次——registerAllIpc 单点接线）──

  it('registerCraftIpc：11 通道各注册恰好一次', () => {
    registeredChannels.length = 0;
    registerCraftIpc();
    expect(registeredChannels.sort()).toEqual([
      'craft:card-get',
      'craft:card-list',
      'craft:card-patch',
      'craft:card-review',
      'craft:distill-run',
      'craft:distill-status',
      'craft:merge-review-list',
      'craft:merge-review-resolve',
      'craft:term-approve',
      'craft:term-list',
      'craft:term-merge',
    ]);
  });
});
