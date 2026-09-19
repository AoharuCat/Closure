import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ResolvedModel,
  CraftCard,
  CraftMergeReview,
  CraftTerm,
  CraftTeaching,
} from '@orison/shared-contracts';

// E10.2b Wave 2（W2.4）：手艺卡四表往返 + entry 状态机同步 + #claim 向量同步 + 无模型降级。
// ABI 门控 + throwaway home（mirror closureSchema.test.ts 形态）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-craft-card-repo');

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

import {
  CRAFT_CARD_SOURCE_KIND,
  cardCraftId,
  insertCraftCard,
  insertCraftCardRowSync,
  getCraftCard,
  getCraftCardRow,
  listCraftCards,
  listCraftTeachingIdsByMaterial,
  patchCraftCard,
  reindexAllCards,
  reviewCraftCard,
  runCraftMergeResolveTransaction,
  updateCraftTeachingRank,
  appendCraftTeaching,
  deleteCraftCardRow,
} from '../main/db/closureCraftCardRepository';
import { insertCraftTerm } from '../main/db/closureCraftTermRepository';
import {
  upsertCraftDistillLedger,
  getCraftDistillLedger,
  listCraftDistillLedgers,
} from '../main/db/closureCraftDistillRepository';
import {
  getCraftMergeReview,
  insertCraftMergeReview,
  listCraftMergeReviews,
  markCraftMergeReviewResolved,
} from '../main/db/closureCraftMergeReviewRepository';
import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { floatArrayToBuffer, EMBED_DIM } from '../main/db/closureIndexer';

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

// ── fixtures ──

function mkTeaching(over: Partial<CraftTeaching> = {}): CraftTeaching {
  return {
    teachingId: 'tea-000000000001',
    materialId: 'mat-000000000001',
    materialContentHash: `sha256:${'a'.repeat(64)}`,
    author: null,
    quote: '压三拍起手再回报，落差即爽点',
    anchor: {
      chapterIndex: 0,
      charStart: 0,
      charEnd: 12,
      paraStart: 0,
      paraEnd: 1,
    },
    rank: 'normal',
    note: null,
    stale: false,
    ...over,
  };
}

function mkCard(over: Partial<CraftCard> = {}): CraftCard {
  return {
    cardId: 'card-000000000001',
    category: 'qingxu',
    termId: 'term-00000001',
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
    confidence: 0.8,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

function mkTerm(over: Partial<CraftTerm> = {}): CraftTerm {
  return {
    termId: 'term-00000001',
    category: 'qingxu',
    name: '先抑后扬',
    status: 'active',
    mergedInto: null,
    note: null,
    ...over,
  };
}

function seedTerms(): void {
  insertCraftTerm(mkTerm());
  insertCraftTerm(mkTerm({ termId: 'term-00000002', category: 'qiaoduan', name: '桥段甲' }));
}

interface CardEntryRow {
  craft_id: string;
  craft_type: string;
  source_kind: string;
  name: string;
  body_text: string;
  tags: string | null;
  content_hash: string | null;
  model: string | null;
  dim: number | null;
}

function cardEntryRow(cardId: string): CardEntryRow | undefined {
  return getDb()
    .prepare('SELECT * FROM closure_craft_entry WHERE craft_id=?')
    .get(cardCraftId(cardId)) as CardEntryRow | undefined;
}

function claimVecCount(cardId: string): number {
  const db = getDb();
  if (!isSqliteVecAvailable()) return -1;
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM closure_craft_vec WHERE craft_id=?')
      .get(cardCraftId(cardId)) as {
      n: number;
    }
  ).n;
}

describe.skipIf(!sqliteUsable)('closure_craft_card 四表 + 状态机 + 派生面同步（W2.4）', () => {
  beforeAll(clean);
  afterAll(clean);

  it('schema：四表存在 + CHECK 约束 + category 刻意无 CHECK（F-20）+ UNIQUE(category,name)', () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    seedTerms(); // 前置（词目 fixture——后续测试的 termName/分类依赖）
    const db = getDb();
    for (const t of [
      'closure_craft_card',
      'closure_craft_term',
      'closure_craft_distill',
      'closure_craft_merge_review',
    ]) {
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t),
        t,
      ).toBeTruthy();
    }
    const cardSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_craft_card'")
        .get() as {
        sql: string;
      }
    ).sql;
    // 状态 CHECK 三态（Guru 状态机 db 层强约束）；**全 DDL 仅此一个 CHECK**——category 不进
    // CHECK（F-20：zod 单源，未来加大类免表重建迁移）。
    expect(cardSql).toContain("status IN ('pending_review','verified','rejected')");
    // 全 DDL 仅此一个真 CHECK 约束（ASCII 括号锚定——注释里的「DDL CHECK（F-20）」不计）：
    // category 不进 CHECK（F-20：zod 单源，未来加大类免表重建迁移）。
    expect(cardSql.match(/CHECK\s*\(/g)?.length ?? 0).toBe(1);

    // CHECK 真拒坏值。
    expect(() =>
      db
        .prepare(
          "INSERT INTO closure_craft_card (card_id, category, term_id, title, claim_json, tags_json, teachings_json, status, confidence, created_at, updated_at) VALUES ('card-badbadbad01','qingxu','term-00000001','t','{}','[]','[]','bogus',0.5,'x','x')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO closure_craft_term (term_id, category, name, status) VALUES ('term-badbad1','qingxu','x','bogus')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO closure_craft_term (term_id, category, name, status) VALUES ('term-dupdupe1','qingxu','先抑后扬','pending')",
        )
        .run(),
    ).toThrow(); // UNIQUE(category,name)
    db.prepare('DELETE FROM closure_craft_card WHERE card_id=?').run('card-badbadbad01');
  });

  it('insertCraftCard：行往返 + #claim 向量落（去重面常驻）+ pending 无 entry 行（F-06）', async () => {
    const card = mkCard();
    const embedInputs: string[] = [];
    await insertCraftCard(card, {
      resolveModel: () => stubModel(),
      embed: async (_m, text) => {
        embedInputs.push(text);
        return vec1024(3);
      },
    });
    // 向量文本 = condensed（同形状去重面 F-09——非检索 body）。
    expect(embedInputs).toEqual([card.claim.condensed]);

    const stored = getCraftCard(card.cardId);
    expect(stored).toEqual(card);
    const row = getCraftCardRow(card.cardId);
    expect(row?.claimModel).toBe('embed-model-a');
    expect(row?.claimDim).toBe(EMBED_DIM);

    if (isSqliteVecAvailable()) {
      const db = getDb();
      const vecRows = db
        .prepare(
          'SELECT vector_id, vector_kind, craft_type, source_kind FROM closure_craft_vec WHERE craft_id=?',
        )
        .all(cardCraftId(card.cardId)) as Array<{
        vector_id: string;
        vector_kind: string;
        craft_type: string;
        source_kind: string;
      }>;
      expect(vecRows).toHaveLength(1);
      expect(vecRows[0]).toEqual({
        vector_id: `${cardCraftId(card.cardId)}#claim`,
        vector_kind: 'claim',
        craft_type: 'qingxu',
        source_kind: 'craft_card',
      });
      // KNN 可命中。
      const knn = db
        .prepare(
          `SELECT craft_id FROM closure_craft_vec WHERE embedding MATCH ? AND k = 1 AND vector_kind='claim'`,
        )
        .all(floatArrayToBuffer(vec1024(3))) as { craft_id: string }[];
      expect(knn.map((r) => r.craft_id)).toContain(cardCraftId(card.cardId));
    }

    // pending 起板——检索面零行（检索可见性 = 人审状态）。
    expect(cardEntryRow(card.cardId)).toBeUndefined();
  });

  it('无 embed 模型 → claim 向量 pending 不写（claim_model NULL）+ entry 行照写 FTS-only（裁定降级）', async () => {
    const card = mkCard({
      cardId: 'card-000000000002',
      termId: 'term-00000002',
      category: 'qiaoduan',
    });
    await insertCraftCard(card, {
      resolveModel: () => null,
      embed: async () => vec1024(),
    });
    const row = getCraftCardRow(card.cardId);
    expect(row?.claimModel).toBeNull();
    expect(row?.claimDim).toBeNull();
    expect(claimVecCount(card.cardId)).toBe(isSqliteVecAvailable() ? 0 : -1);

    // verify 照写 entry 行（FTS-only——model/dim null + content_hash null pending_embed）。
    const res = await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    expect(res.ok).toBe(true);
    const entry = cardEntryRow(card.cardId);
    expect(entry?.model).toBeNull();
    expect(entry?.dim).toBeNull();
    expect(entry?.content_hash).toBeNull();
    const ftsHits = getDb()
      .prepare('SELECT craft_id FROM closure_craft_fts WHERE closure_craft_fts MATCH ?')
      .all('桥段甲') as { craft_id: string }[];
    expect(ftsHits.map((h) => h.craft_id)).toContain(cardCraftId(card.cardId));
  });

  it('prevailing mismatch → claim 向量 pending + warn 不抛（mirror reindexCraftDoc 门）', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text, model, dim)
       VALUES ('prevailing-holder', 'qiaoduan', 'user', 'holder', 'body', 'model-prevailing', ${EMBED_DIM})`,
    ).run();
    const card = mkCard({ cardId: 'card-000000000003' });
    await insertCraftCard(card, {
      resolveModel: () => stubModel('model-resolved'),
      embed: async () => vec1024(),
    });
    const row = getCraftCardRow(card.cardId);
    expect(row?.claimModel).toBeNull(); // mismatch → pending
    expect(claimVecCount(card.cardId)).toBe(isSqliteVecAvailable() ? 0 : -1);
    db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=?').run('prevailing-holder');
  });

  it('listCraftCards：过滤（status/category/termId/tags OR/materialId）+ 排序 + 摘要投影', async () => {
    const t2 = mkTeaching({
      teachingId: 'tea-000000000002',
      materialId: 'mat-000000000002',
      stale: true,
    });
    await insertCraftCard(
      mkCard({
        cardId: 'card-000000000004',
        termId: 'term-00000002',
        category: 'qiaoduan',
        title: '桥段乙',
        tags: ['开篇'],
        confidence: 0.4,
        teachings: [mkTeaching(), t2],
      }),
      { resolveModel: () => null },
    );
    await insertCraftCard(
      mkCard({
        cardId: 'card-000000000005',
        title: '已核卡',
        status: 'verified',
        confidence: 0.9,
      }),
      { resolveModel: () => null },
    );

    // 全量。
    const all = listCraftCards();
    expect(all.map((c) => c.cardId).sort()).toEqual([
      'card-000000000001',
      'card-000000000002',
      'card-000000000003',
      'card-000000000004',
      'card-000000000005',
    ]);
    // 默认排序 confidence-asc（低置信排前 R5）。
    expect(all.map((c) => c.confidence)).toEqual(
      [...all.map((c) => c.confidence)].sort((a, b) => a - b),
    );

    expect(
      listCraftCards({ status: 'verified' })
        .map((c) => c.cardId)
        .sort(),
    ).toEqual([
      'card-000000000002', // test 2 内已 verify
      'card-000000000005',
    ]);
    expect(
      listCraftCards({ category: 'qiaoduan' })
        .map((c) => c.cardId)
        .sort(),
    ).toEqual(['card-000000000002', 'card-000000000004']);
    expect(
      listCraftCards({ termId: 'term-00000002' })
        .map((c) => c.cardId)
        .sort(),
    ).toEqual(['card-000000000002', 'card-000000000004']);

    // tags OR：单标签命中 / 多标签任一命中 / 零命中。
    expect(
      listCraftCards({ tags: ['情绪'] })
        .map((c) => c.cardId)
        .sort(),
    ).toEqual(['card-000000000001', 'card-000000000002', 'card-000000000003', 'card-000000000005']);
    expect(listCraftCards({ tags: ['情绪', '开篇'] }).map((c) => c.cardId)).toHaveLength(5);
    expect(listCraftCards({ tags: ['不存在的标签'] })).toEqual([]);

    // materialId 过滤（按文档分批分组键）。
    expect(listCraftCards({ materialId: 'mat-000000000002' }).map((c) => c.cardId)).toEqual([
      'card-000000000004',
    ]);

    // 摘要投影字段。
    const s = listCraftCards({ termId: 'term-00000002' }).find(
      (c) => c.cardId === 'card-000000000004',
    );
    expect(s).toBeTruthy();
    expect(s?.termName).toBe('桥段甲');
    expect(s?.condensed).toContain('压低起手');
    expect(s?.teachingCount).toBe(2);
    expect(s?.staleTeachingCount).toBe(1);
    expect(s?.materialIds).toEqual(['mat-000000000001', 'mat-000000000002']);

    // sort 覆盖。
    expect(
      listCraftCards({ sort: 'updated-desc' })[0]?.updatedAt >=
        listCraftCards({ sort: 'updated-desc' })[4]?.updatedAt,
    ).toBe(true);
  });

  it('listCraftTeachingIdsByMaterial：JSON 键值锚定（CR-13）——引文文本含 materialId 子串不误命中', () => {
    // 真：讲法 materialId 恰为目标材料。
    insertCraftCardRowSync(
      mkCard({
        cardId: 'card-0000000000c6',
        teachings: [
          mkTeaching({
            teachingId: 'tea-0000000000c6',
            materialId: 'mat-0000000000c6',
          }),
        ],
      }),
      { vector: null, modelId: null },
    );
    // 陷阱 A：讲法属其他材料，但引文文本里出现目标 materialId 裸字样（旧裸子串 LIKE 误命中
    // → 幂等面误判「已落库」→ 合法重落被静默跳过 = 无计数数据丢失）。
    insertCraftCardRowSync(
      mkCard({
        cardId: 'card-0000000000d6',
        teachings: [
          mkTeaching({
            teachingId: 'tea-0000000000d6',
            materialId: 'mat-ffffffffffff',
            quote: '他在笔记里抄下了 mat-0000000000c6 这个编号',
          }),
        ],
      }),
      { vector: null, modelId: null },
    );
    // 陷阱 B（手改库形态）：teachings_json 被嵌入携带目标键值对的嵌套对象（骗过键值锚定
    // 预筛——正常写路径引文内引号必被转义，此形态仅手改可达）——per-teaching materialId
    // 严配兜底。
    insertCraftCardRowSync(
      mkCard({
        cardId: 'card-0000000000e6',
        teachings: [
          mkTeaching({
            teachingId: 'tea-0000000000e6',
            materialId: 'mat-111111111111',
          }),
        ],
      }),
      { vector: null, modelId: null },
    );
    const tampered = JSON.parse(
      JSON.stringify([
        mkTeaching({
          teachingId: 'tea-0000000000e6',
          materialId: 'mat-111111111111',
        }),
      ]),
    ) as Array<Record<string, unknown>>;
    tampered[0]!.extra = { materialId: 'mat-0000000000c6' };
    getDb()
      .prepare('UPDATE closure_craft_card SET teachings_json=? WHERE card_id=?')
      .run(JSON.stringify(tampered), 'card-0000000000e6');
    expect(listCraftTeachingIdsByMaterial('mat-0000000000c6')).toEqual(['tea-0000000000c6']);
    expect(listCraftTeachingIdsByMaterial('mat-ffffffffffff')).toEqual(['tea-0000000000d6']);
    expect(listCraftTeachingIdsByMaterial('mat-111111111111')).toEqual(['tea-0000000000e6']);
    // 前缀相近的材料 id 不误命中（键值对闭引号锚定）。
    expect(listCraftTeachingIdsByMaterial('mat-0000000000c1')).toEqual([]);
  });

  it('verify 状态机：entry 行写（craft_type=大类 slug / body 五件 / tags / model 镜像）+ FTS 可检回', async () => {
    const card = mkCard({ cardId: 'card-000000000006' });
    await insertCraftCard(card, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(5),
    });
    const res = await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.card.status).toBe('verified');

    const entry = cardEntryRow(card.cardId);
    expect(entry).toBeTruthy();
    expect(entry?.craft_type).toBe('qingxu'); // F-10 大类 slug
    expect(entry?.source_kind).toBe(CRAFT_CARD_SOURCE_KIND);
    expect(entry?.name).toBe('先抑后扬'); // title
    // body = 词目名 + 大类 gloss 短标签 + title + condensed + 引文（F-10 词目级检索面）。
    expect(entry?.body_text).toContain('先抑后扬'); // 词目名（term-00000001 → 先抑后扬）
    expect(entry?.body_text).toContain('情绪手法'); // gloss 短标签
    expect(entry?.body_text).toContain('压低起手再回报'); // condensed
    expect(entry?.body_text).toContain('压三拍起手再回报，落差即爽点'); // 讲法引文
    expect(JSON.parse(entry?.tags ?? '[]')).toEqual(['开篇', '情绪']);
    expect(entry?.model).toBe('embed-model-a'); // 镜像卡行 claim 记账
    expect(entry?.dim).toBe(EMBED_DIM);
    expect(entry?.content_hash).toHaveLength(64);

    // FTS 臂 = entry 行既有 trigger。
    const ftsHits = getDb()
      .prepare('SELECT craft_id FROM closure_craft_fts WHERE closure_craft_fts MATCH ?')
      .all('压低起手再回报') as { craft_id: string }[];
    expect(ftsHits.map((h) => h.craft_id)).toContain(cardCraftId(card.cardId));

    // 非法转换：verified 再 verify = invalid-state。
    const again = await reviewCraftCard(card.cardId, 'verify');
    expect(again).toEqual({ ok: false, error: 'invalid-state' });
  });

  it('verify 补嵌重试：落卡时无模型 pending → verify 时模型就位 → vec 落 + entry 带记账', async () => {
    const card = mkCard({ cardId: 'card-000000000007' });
    await insertCraftCard(card, { resolveModel: () => null });
    expect(getCraftCardRow(card.cardId)?.claimModel).toBeNull();
    // prevailing = card-000000000001 的 'embed-model-a'（卡行记账兜底探针）——同模型补嵌。
    const res = await reviewCraftCard(
      card.cardId,
      'verify',
      {},
      {
        resolveModel: () => stubModel('embed-model-a'),
        embed: async () => vec1024(6),
      },
    );
    expect(res.ok).toBe(true);
    expect(getCraftCardRow(card.cardId)?.claimModel).toBe('embed-model-a');
    expect(claimVecCount(card.cardId)).toBe(isSqliteVecAvailable() ? 1 : -1);
    expect(cardEntryRow(card.cardId)?.model).toBe('embed-model-a');
  });

  it('reject：entry 行删 + claim 向量保留（去重面常驻全卡）+ recover 救回 + 再 verify 复活', async () => {
    const card = mkCard({ cardId: 'card-000000000008' });
    await insertCraftCard(card, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    expect(cardEntryRow(card.cardId)).toBeTruthy();

    const rej = await reviewCraftCard(card.cardId, 'reject', {
      rejectReason: '主张与原文不符',
    });
    expect(rej.ok).toBe(true);
    if (rej.ok) {
      expect(rej.card.status).toBe('rejected');
      expect(rej.card.rejectReason).toBe('主张与原文不符');
    }
    expect(cardEntryRow(card.cardId)).toBeUndefined(); // 检索可见性收回
    expect(claimVecCount(card.cardId)).toBe(isSqliteVecAvailable() ? 1 : -1); // ⚠️ 向量保留

    // rejected 再 reject = invalid-state。
    expect(await reviewCraftCard(card.cardId, 'reject')).toEqual({
      ok: false,
      error: 'invalid-state',
    });
    // 非 rejected recover = invalid-state。
    expect(await reviewCraftCard('card-000000000001', 'recover')).toEqual({
      ok: false,
      error: 'invalid-state',
    });

    const rec = await reviewCraftCard(card.cardId, 'recover');
    expect(rec.ok).toBe(true);
    if (rec.ok) {
      expect(rec.card.status).toBe('pending_review');
      expect(rec.card.rejectReason).toBeNull(); // 仅 rejected 落值（schema JSDoc）
    }
    expect(cardEntryRow(card.cardId)).toBeUndefined();
    const verified = await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    expect(verified.ok).toBe(true);
    expect(cardEntryRow(card.cardId)).toBeTruthy(); // 复活
  });

  it('patch 编辑即降级：verified → pending + entry 删；condensed 变更才重嵌；termId 改挂 category 跟随', async () => {
    const card = mkCard({ cardId: 'card-000000000009' });
    await insertCraftCard(card, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    expect(cardEntryRow(card.cardId)).toBeTruthy();

    let embedCalls = 0;
    // 非 condensed 编辑（tags/title）——claim 向量不重嵌（condensed 未变）。
    const p1 = await patchCraftCard(
      card.cardId,
      { tags: ['结构'], title: '先抑后扬·修订' },
      {
        resolveModel: () => stubModel(),
        embed: async () => {
          embedCalls++;
          return vec1024();
        },
      },
    );
    expect(p1.ok).toBe(true);
    if (p1.ok) {
      expect(p1.card.status).toBe('pending_review'); // 编辑即降级（uniform）
      expect(p1.card.title).toBe('先抑后扬·修订');
    }
    expect(cardEntryRow(card.cardId)).toBeUndefined(); // 降级 ⇒ 检索行删
    expect(embedCalls).toBe(0); // condensed 未变不重嵌
    expect(getCraftCardRow(card.cardId)?.claimModel).toBe('embed-model-a'); // 向量记账保持

    // termId 改挂 → category 随新 term（F-15 单源）。
    const p2 = await patchCraftCard(
      card.cardId,
      { termId: 'term-00000002' },
      { resolveModel: () => null },
    );
    expect(p2.ok).toBe(true);
    if (p2.ok) expect(p2.card.category).toBe('qiaoduan');

    // 词目不存在 → invalid-input。
    expect(await patchCraftCard(card.cardId, { termId: 'term-ffffffff' })).toEqual({
      ok: false,
      error: 'invalid-input',
    });

    // condensed 变更 → 重嵌 + 记账翻新（prevailing = embed-model-a——verify 落的 entry 记账；
    // 同模型 id 重嵌，测的是「condensed 变更触发重嵌 + 旧向量清除」非模型翻新）。
    const p3 = await patchCraftCard(
      card.cardId,
      { claim: { condensed: '修订后的保义浓缩主张' } },
      {
        resolveModel: () => stubModel('embed-model-a'),
        embed: async () => {
          embedCalls++;
          return vec1024(9);
        },
      },
    );
    expect(p3.ok).toBe(true);
    expect(embedCalls).toBe(1);
    expect(getCraftCardRow(card.cardId)?.claimModel).toBe('embed-model-a');
    // 旧向量被清、新向量就位（CR-craft-kb-009 同款）。
    if (isSqliteVecAvailable()) {
      const db = getDb();
      const knn = db
        .prepare(
          `SELECT craft_id FROM closure_craft_vec WHERE embedding MATCH ? AND k = 5 AND vector_kind='claim'`,
        )
        .all(floatArrayToBuffer(vec1024(9))) as { craft_id: string }[];
      expect(knn.map((r) => r.craft_id)).toContain(cardCraftId(card.cardId));
    }
  });

  it('patch rejected 卡 → rejected-card（编辑入口禁用，必须先 recover）', async () => {
    const card = mkCard({ cardId: 'card-00000000000a' });
    await insertCraftCard(card, { resolveModel: () => null });
    await reviewCraftCard(card.cardId, 'reject', { rejectReason: '不要' });
    expect(await patchCraftCard(card.cardId, { title: 'x' })).toEqual({
      ok: false,
      error: 'rejected-card',
    });
    expect(getCraftCard(card.cardId)?.title).toBe('先抑后扬'); // 未被改
  });

  it('讲法 rank 改级：不降级 / 不动 entry / note 持久', async () => {
    const card = mkCard({ cardId: 'card-00000000000b' });
    await insertCraftCard(card, { resolveModel: () => null });
    await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    const afterVerify = getCraftCard(card.cardId);
    const before = cardEntryRow(card.cardId);

    const res = updateCraftTeachingRank(
      card.cardId,
      'tea-000000000001',
      'rejected',
      '作者后来推翻',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.card.status).toBe('verified'); // 讲法级动作不降级
      expect(res.card.teachings[0]?.rank).toBe('rejected');
      expect(res.card.teachings[0]?.note).toBe('作者后来推翻');
    }
    expect(getCraftCard(card.cardId)?.updatedAt).toBe(afterVerify?.updatedAt); // 不动 updated_at
    const after = cardEntryRow(card.cardId);
    expect(after?.body_text).toBe(before?.body_text); // 检索面不动（rank 过滤归渲染）
    expect(after?.model).toBe(before?.model);

    expect(updateCraftTeachingRank(card.cardId, 'tea-ffffffffffff', 'approved')).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('appendCraftTeaching：幂等键命中 no-op / 新讲法降级 + entry 删', async () => {
    const card = mkCard({ cardId: 'card-00000000000c' });
    await insertCraftCard(card, { resolveModel: () => null });
    await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    expect(cardEntryRow(card.cardId)).toBeTruthy();

    // 同 teachingId 再挂 = no-op（F-04 幂等键）。
    const dup = appendCraftTeaching(card.cardId, mkTeaching());
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.card.teachings).toHaveLength(1);
    expect(getCraftCard(card.cardId)?.status).toBe('verified'); // no-op 不降级

    // 新讲法 = 内容编辑 → 降级 + 检索行删。
    const appended = appendCraftTeaching(
      card.cardId,
      mkTeaching({
        teachingId: 'tea-000000000009',
        materialId: 'mat-000000000009',
        quote: '第二来源的讲法',
      }),
    );
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.card.status).toBe('pending_review');
      expect(appended.card.teachings).toHaveLength(2);
    }
    expect(cardEntryRow(card.cardId)).toBeUndefined();
    expect(appendCraftTeaching('card-ffffffffffff', mkTeaching())).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('deleteCraftCardRow：三面全清 + craft 文档行不受扰（F-01 反向）', async () => {
    const db = getDb();
    const card = mkCard({ cardId: 'card-00000000000d' });
    await insertCraftCard(card, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });
    // 邻居：doc 行 + 材料 chunk 行（同表共存者不得被卡删除带走）。
    db.prepare(
      `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text) VALUES ('neighbor-doc', 'qiaoduan', 'user', 'n', 'doc body')`,
    ).run();
    db.prepare(
      `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text) VALUES ('mat:mat-000000000003.ch0#c0', 'material', 'material_chunk', 'm', 'chunk body')`,
    ).run();

    deleteCraftCardRow(card.cardId);
    expect(getCraftCard(card.cardId)).toBeNull();
    expect(cardEntryRow(card.cardId)).toBeUndefined();
    expect(claimVecCount(card.cardId)).toBe(isSqliteVecAvailable() ? 0 : -1);
    // 邻居行原样在。
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('neighbor-doc'),
    ).toBeTruthy();
    expect(
      db
        .prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?')
        .get('mat:mat-000000000003.ch0#c0'),
    ).toBeTruthy();
    db.prepare('DELETE FROM closure_craft_entry WHERE craft_id IN (?,?)').run(
      'neighbor-doc',
      'mat:mat-000000000003.ch0#c0',
    );
  });

  it('蒸馏台账往返：upsert 覆盖 / get / list 按 materialIds / snake_case stats 双向', () => {
    const ledger = {
      materialId: 'mat-000000000010',
      contentHash: `sha256:${'1'.repeat(64)}`,
      derivedHash: `sha256:${'2'.repeat(64)}`,
      status: 'done' as const,
      stats: {
        claims: 10,
        anchored: 8,
        droppedNoAnchor: 2,
        droppedMalformed: 1,
        droppedNoCategory: 0,
        mergedAuto: 1,
        mergeReviews: 3,
        newCards: 4,
        disputes: 1,
      },
      phase: null,
      error: null,
      distilledAt: '2026-09-05T12:00:00.000Z',
    };
    upsertCraftDistillLedger(ledger);
    upsertCraftDistillLedger({
      ...ledger,
      status: 'running',
      phase: 'dedup',
      stats: { ...ledger.stats, claims: 12 },
      distilledAt: null,
    });
    const stored = getCraftDistillLedger(ledger.materialId);
    expect(stored?.status).toBe('running');
    expect(stored?.phase).toBe('dedup');
    expect(stored?.stats.claims).toBe(12);
    expect(stored?.stats.droppedNoAnchor).toBe(2);
    expect(stored?.stats.droppedMalformed).toBe(1); // 拆分键 snake_case 双向（dropped_malformed）
    expect(stored?.stats.droppedNoCategory).toBe(0); // dropped_no_category
    expect(getCraftDistillLedger('mat-ffffffffffff')).toBeNull();
    upsertCraftDistillLedger({
      ...ledger,
      materialId: 'mat-000000000011',
      status: 'failed',
      phase: null,
      error: 'boom',
    });
    expect(
      listCraftDistillLedgers()
        .map((l) => l.materialId)
        .sort(),
    ).toEqual(['mat-000000000010', 'mat-000000000011']);
    expect(listCraftDistillLedgers(['mat-000000000011']).map((l) => l.status)).toEqual(['failed']);
  });

  it('merge review 往返：待审清单 / includeResolved / resolve 幂等闸', () => {
    const review = {
      reviewId: 'mrev-000000000001',
      newClaim: {
        claim: {
          condensed: '并排对比的新主张',
          points: [],
          scenarios: [],
          counterexamples: [],
        },
        quote: '引文',
        anchor: {
          chapterIndex: 0,
          charStart: 0,
          charEnd: 2,
          paraStart: 0,
          paraEnd: 1,
        },
        materialId: 'mat-000000000012',
        materialContentHash: `sha256:${'3'.repeat(64)}`,
        author: null,
        category: 'qingxu' as const,
        termId: 'term-00000001',
        tags: [],
        confidence: 0.9,
      },
      existingCardId: 'card-000000000001',
      similarity: 0.91,
      resolution: null,
      createdAt: '2026-09-05T11:00:00.000Z',
    };
    insertCraftMergeReview(review);
    expect(listCraftMergeReviews().map((r) => r.reviewId)).toEqual(['mrev-000000000001']);
    expect(listCraftMergeReviews({ includeResolved: true })).toHaveLength(1);

    expect(
      markCraftMergeReviewResolved('mrev-000000000001', {
        action: 'merge',
        resolvedAt: '2026-09-05T11:05:00.000Z',
        note: '同主张',
      }),
    ).toEqual({ ok: true });
    expect(listCraftMergeReviews()).toEqual([]); // 已裁决出待审队列
    const resolved = listCraftMergeReviews({ includeResolved: true })[0];
    expect(resolved?.resolution?.action).toBe('merge');
    // 幂等闸：已裁决再 resolve = invalid-state（裁决后不可改）。
    expect(
      markCraftMergeReviewResolved('mrev-000000000001', {
        action: 'dismiss',
        resolvedAt: '2026-09-05T11:06:00.000Z',
        note: null,
      }),
    ).toEqual({ ok: false, error: 'invalid-state' });
    expect(
      markCraftMergeReviewResolved('mrev-ffffffffffff', {
        action: 'dismiss',
        resolvedAt: 'x',
        note: null,
      }),
    ).toEqual({ ok: false, error: 'not-found' });
  });

  // ── CR-2b 修复批（组 Q）：落卡 dim 竞态 / patch 并发覆写 / resolve 单事务 / sweep 计数 ──

  it('落卡 dim 竞态（CR-2b-7）：预嵌向量与当前 vec 表 dim 不符 → 降 pending 不裸抛回滚', () => {
    const card = mkCard({ cardId: 'card-00000000000e' });
    // 模拟竞态终态：claim 向量按旧 dim 预嵌（长度 ≠ closure_craft_vec 的 float[N]——reindex
    // 换 dim 后的形态）。原实现 vec0 insert 原生抛 → 整笔材料事务回滚；修后卡照落 + 记账压
    // pending（verify/sweep 补嵌自愈）。
    const wrongDimVec = new Array(EMBED_DIM + 8).fill(0);
    wrongDimVec[0] = 1;
    expect(() =>
      insertCraftCardRowSync(card, {
        vector: wrongDimVec,
        modelId: 'embed-stale',
      }),
    ).not.toThrow();
    const row = getCraftCardRow(card.cardId);
    expect(row).not.toBeNull();
    expect(row!.claimModel).toBeNull(); // pending 记账（不谎称有向量）
    expect(row!.claimDim).toBeNull();
    expect(claimVecCount(card.cardId)).toBe(isSqliteVecAvailable() ? 0 : -1);
    expect(getCraftCard(card.cardId)).not.toBeNull(); // 卡行在——材料不因向量竞态丢卡
  });

  it('patch 并发覆写防护（CR-2b-6）：condensed 重嵌窗口的并发编辑不被旧快照全行 UPDATE 吞', async () => {
    const cardId = 'card-00000000000f';
    await insertCraftCard(mkCard({ cardId }), { resolveModel: () => null });
    // 第一路：condensed 变更（触发 embed 网络窗口）；窗口内第二路并发改 tags/title。
    // better-sqlite3 同步——嵌套 patch 落库时第一路尚未开终事务（embed 在事务外）。
    let concurrentRan = false;
    const res = await patchCraftCard(
      cardId,
      { claim: { condensed: '并发窗口后的新主张表述' } },
      {
        resolveModel: () => stubModel('embed-model-a'),
        embed: async () => {
          if (!concurrentRan) {
            concurrentRan = true;
            const nested = await patchCraftCard(
              cardId,
              { tags: ['并发标签'], title: '并发改的标题' },
              { resolveModel: () => null },
            );
            expect(nested.ok).toBe(true);
          }
          return vec1024(11);
        },
      },
    );
    expect(res.ok).toBe(true);
    const after = getCraftCard(cardId)!;
    expect(after.claim.condensed).toBe('并发窗口后的新主张表述'); // 本路 condensed 落
    expect(after.tags).toEqual(['并发标签']); // 并发编辑存活（原实现被旧快照全行 UPDATE 吞）
    expect(after.title).toBe('并发改的标题');
    expect(after.status).toBe('pending_review');
  });

  it('runCraftMergeResolveTransaction（CR-2b-1）：resolution 落账失败 → 卡动作同事务回滚（无幻影卡）', async () => {
    const mkReviewRow = (reviewId: string): CraftMergeReview => ({
      reviewId,
      newClaim: {
        claim: {
          condensed: 'x',
          points: [],
          scenarios: [],
          counterexamples: [],
        },
        quote: 'q',
        anchor: {
          chapterIndex: 0,
          charStart: 0,
          charEnd: 1,
          paraStart: 0,
          paraEnd: 1,
        },
        materialId: 'mat-0000000000aa',
        materialContentHash: `sha256:${'c'.repeat(64)}`,
        author: null,
        category: 'qingxu',
        termId: 'term-00000001',
        tags: [],
        confidence: 0.5,
      },
      existingCardId: 'card-000000000001',
      similarity: 0.9,
      resolution: null,
      createdAt: '2026-09-05T12:00:00.000Z',
    });

    // 前置：已裁决的 review 行——事务内 mark 幂等闸 invalid-state → independent 新建卡须回滚。
    insertCraftMergeReview(mkReviewRow('mrev-0000000000aa'));
    markCraftMergeReviewResolved('mrev-0000000000aa', {
      action: 'dismiss',
      resolvedAt: '2026-09-05T11:30:00.000Z',
      note: null,
    });
    const ghostCardId = 'card-000000000012';
    const res = await runCraftMergeResolveTransaction(
      { kind: 'independent', card: mkCard({ cardId: ghostCardId }) },
      'mrev-0000000000aa',
      {
        action: 'independent',
        resolvedAt: '2026-09-05T12:00:00.000Z',
        note: null,
      },
    );
    expect(res).toEqual({ ok: false, error: 'invalid-state' });
    expect(getCraftCard(ghostCardId)).toBeNull(); // 幻影卡未残留（原实现两写分离——卡先落、落账后炸）

    // merge 侧：目标卡不存在 → not-found 且 review 不落账（动作失败不落账，可重试）。
    insertCraftMergeReview(mkReviewRow('mrev-0000000000bb'));
    const res2 = await runCraftMergeResolveTransaction(
      { kind: 'merge', cardId: 'card-ffffffffffff', teaching: mkTeaching() },
      'mrev-0000000000bb',
      { action: 'merge', resolvedAt: '2026-09-05T12:00:00.000Z', note: null },
    );
    expect(res2).toEqual({ ok: false, error: 'not-found' });
    expect(getCraftMergeReview('mrev-0000000000bb')?.resolution).toBeNull();

    // dismiss happy path：零卡面动作 + 落账。
    insertCraftMergeReview(mkReviewRow('mrev-0000000000cc'));
    const res3 = await runCraftMergeResolveTransaction({ kind: 'dismiss' }, 'mrev-0000000000cc', {
      action: 'dismiss',
      resolvedAt: '2026-09-05T12:00:00.000Z',
      note: null,
    });
    expect(res3.ok).toBe(true);
    expect(getCraftMergeReview('mrev-0000000000cc')?.resolution?.action).toBe('dismiss');
  });

  it('reindexAllCards（CR-2b-16）：只计实际重嵌成功——一成一败返回 1（原实现报全部清扫数）', async () => {
    if (!isSqliteVecAvailable()) return; // sweep 重嵌本旨依赖 vec 扩展
    // 两张专属 condensed 卡（避开前面用例的 mkCard 默认主张——embed mock 按文本分流）。
    await insertCraftCard(
      mkCard({
        cardId: 'card-000000000010',
        claim: {
          condensed: 'CR16 重嵌成功主张',
          points: [],
          scenarios: [],
          counterexamples: [],
        },
      }),
      {
        resolveModel: () => stubModel('embed-a'),
        embed: async () => vec1024(1),
      },
    );
    await insertCraftCard(
      mkCard({
        cardId: 'card-000000000011',
        claim: {
          condensed: 'CR16 重嵌失败主张',
          points: [],
          scenarios: [],
          counterexamples: [],
        },
      }),
      {
        resolveModel: () => stubModel('embed-a'),
        embed: async () => vec1024(2),
      },
    );
    const reembedded = await reindexAllCards({
      resolveModel: () => stubModel('embed-a'),
      embed: async (_m, text) => {
        if (text === 'CR16 重嵌成功主张') return vec1024(3);
        throw new Error('embed endpoint down'); // 其余全失败（含前面用例遗留卡——不计入）
      },
    });
    expect(reembedded).toBe(1); // 只计实际落地 1 张（零重嵌不报成功）
    expect(getCraftCardRow('card-000000000010')?.claimModel).toBe('embed-a');
    expect(getCraftCardRow('card-000000000011')?.claimModel).toBeNull(); // 失败 → pending 记账
    expect(claimVecCount('card-000000000010')).toBe(1);
  });
});
