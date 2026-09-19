import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-closure-craft-retrieval');

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

import { searchCraft } from '../main/db/closureCraftRetrieval';
import { insertCraftCard, reviewCraftCard } from '../main/db/closureCraftCardRepository';
import { EMBED_DIM, floatArrayToBuffer } from '../main/db/closureIndexer';
import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import type { CraftCard } from '@orison/shared-contracts';

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

function vecSlot(slot: number): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[slot] = 1.0;
  return v;
}
const VEC_A = vecSlot(0);
const VEC_B = vecSlot(1);
const VEC_C = vecSlot(2);

// Story 8.7 multi-vector seeding (S5 fix for the S4 schema change): one
// closure_craft_vec row per vector — vector_id `${craftId}#${kind}` is the PK
// and the vector_kind column carries the kind (mirror of reindexCraftDoc's
// write shape). Positional `vec` = the #body row; `opts.identityVec` adds the
// #identity row (craft docs are all long docs). `opts.summaryText` seeds the
// 8.7 doc column. Idempotent seed: prior rows for the craft_id are cleared
// first (closure_craft_entry delete fires AFTER DELETE, clearing FTS; the vec
// delete is gated on the extension — closure_craft_vec only exists when
// sqlite-vec loaded). Mirrors the production upsert intent (reindexCraftDoc
// uses ON CONFLICT; this helper seeds the derived tables directly).
function seedCraft(
  craftId: string,
  craftType: string,
  name: string,
  body: string,
  vec: number[] | null,
  opts?: { identityVec?: number[] | null; summaryText?: string; tags?: string[] },
) {
  const db = getDb();
  if (isSqliteVecAvailable()) {
    db.prepare('DELETE FROM closure_craft_vec WHERE craft_id=?').run(craftId);
  }
  db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=?').run(craftId);
  db.prepare(
    `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text, summary_text, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(craftId, craftType, 'user', name, body, opts?.summaryText ?? null, opts?.tags ? JSON.stringify(opts.tags) : null);
  if (!isSqliteVecAvailable()) return;
  const insertVec = db.prepare(
    `INSERT INTO closure_craft_vec (vector_id, craft_id, craft_type, source_kind, vector_kind, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  if (vec) {
    insertVec.run(`${craftId}#body`, craftId, craftType, 'user', 'body', floatArrayToBuffer(vec));
  }
  if (opts?.identityVec) {
    insertVec.run(
      `${craftId}#identity`,
      craftId,
      craftType,
      'user',
      'identity',
      floatArrayToBuffer(opts.identityVec),
    );
  }
}

describe.skipIf(!sqliteUsable)('closureCraftRetrieval DB integration (Story 2.1)', () => {
  // beforeEach (not beforeAll): each test seeds craft_ids 'A'/'B'/... and several
  // assert an EXACT hit set (e.g. structured-only expects exactly its 2 docs). A
  // shared DB across tests would accumulate rows and pollute those assertions.
  // getDb() re-creates the data dir + schema on the next call, so cleaning before
  // every test gives each a fresh derived index (the VS1 closureRetrieval suite
  // uses beforeAll and has the same accumulation latent under a real ABI run).
  beforeEach(clean);
  afterAll(clean);

  it('FTS-only path (no model): body-term query returns the matching craft doc, no vecDistance', async () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    seedCraft('A', 'shuangdian', '爽点目录', '爽点\ntexas ranger silent hunter', VEC_A);
    seedCraft('B', 'shuangdian', '金手指', '金手指\noregon trail', VEC_B);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });

    const ids = hits.map((h) => h.craftId);
    expect(ids).toContain('A');
    expect(ids).not.toContain('B');
    const a = hits.find((h) => h.craftId === 'A')!;
    expect(a.vecDistance).toBeUndefined();
    expect(a.ftsRank).toBeDefined();
    expect(a.name).toBe('爽点目录');
    expect(a.craftType).toBe('shuangdian');
  });

  it('both-arms RRF: consensus hit ranks first', async () => {
    // Story 8.7 note: D's body carries "texas" TWICE so its FTS rank is
    // decisively better than A's — the consensus margin must not hinge on
    // vec0's unspecified tie order between D and B's equal-distance vectors
    // (the multi-vector GROUP BY dedupe orders ties by id, which flipped the
    // knife-edge 1/61+1/63 vs 1/62+1/62 comparison of the old single-occurrence
    // seed).
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', VEC_B);
    seedCraft('C', 'playbook', 'Stronghold', 'Stronghold\nmountain pass', VEC_C);
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas texas consensus', VEC_B);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].craftId).toBe('D'); // consensus (FTS + vec)
    expect(hits[0].ftsRank).toBeDefined();
    expect(hits[0].vecDistance).toBeDefined();
  });

  it('craft_type filter excludes other types', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_B);
    seedCraft('L', 'playbook', 'Lone Star', 'Lone Star\ntexas playbook', VEC_B);

    const noFilter = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(noFilter.map((h) => h.craftId).sort()).toEqual(['A', 'L']);

    const shuangdianOnly = await searchCraft('texas', { k: 10, craftType: 'shuangdian' }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(shuangdianOnly.map((h) => h.craftId)).toEqual(['A']);
    expect(shuangdianOnly.every((h) => h.craftType === 'shuangdian')).toBe(true);
  });

  it('vec-only path: special-char query sanitizes to null FTS, vec arm still returns hits', async () => {
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', VEC_B);
    seedCraft('C', 'playbook', 'Stronghold', 'Stronghold\nmountain pass', VEC_C);

    const hits = await searchCraft('*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].craftId).toBe('B');
    expect(hits[0].vecDistance).toBeDefined();
    expect(hits[0].ftsRank).toBeUndefined();
  });

  it('structured-only fallback: empty query + no model returns docs (score 0)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', null);
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', null);

    const hits = await searchCraft('', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });

    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.score === 0)).toBe(true);
  });

  it('parent-doc return: hits carry closure_craft_entry fields (no projectId)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    const a = hits.find((h) => h.craftId === 'A')!;
    expect(a.craftType).toBe('shuangdian');
    expect(a.sourceKind).toBe('user');
    expect(a.name).toBe('Ranger');
    expect(a.bodyText).toBe('Ranger\ntexas ranger');
    // CraftHit has NO projectId field (global scope).
    expect((a as Record<string, unknown>).projectId).toBeUndefined();
  });

  it('rerank stage re-orders RRF hits by rerankScore (additive, shared stage)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const rerankModel = {
      keyId: 'k1',
      modelId: 'bge-reranker-stub',
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:0',
      apiKey: 'stub',
      capability: 'rerank' as const,
    };
    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null, // FTS-only RRF
      embed: async () => VEC_A,
      resolveRerankModel: () => rerankModel,
      rerank: async (_m, _q, docs) =>
        docs.map((d) => (d.includes('Ranger') ? 0.99 : 0.1)),
    });

    expect(hits[0].craftId).toBe('A');
    expect(hits[0].rerankScore).toBe(0.99);
    expect(hits[1].craftId).toBe('D');
    expect(hits[1].rerankScore).toBe(0.1);
  });

  it('rerank unavailable -> degrades to RRF order (no rerankScore, never blocks)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
      resolveRerankModel: () => null, // no rerank model -> degrade
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.rerankScore === undefined)).toBe(true);
  });

  // ── Story 8.7 S5: dual-vector retrieval (craft mirror) ──

  it('dual-vector: identity-row hit passes vectorKind="identity" + summaryText; body-row hit "body"', async () => {
    seedCraft('IDOC', 'shuangdian', '爽点目录', '爽点\ntexas body lore', VEC_A, {
      identityVec: VEC_B,
      summaryText: '网文爽点速查',
    });
    seedCraft('BDOC', 'playbook', 'Scout', 'Scout\noregon trail', VEC_B);

    // '*' sanitizes to a null FTS term -> vec-only path (query embeds to VEC_B):
    // IDOC's identity row (distance 0) beats its orthogonal body row.
    const hits = await searchCraft('*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    expect(hits.length).toBeGreaterThanOrEqual(2);
    const idoc = hits.find((h) => h.craftId === 'IDOC')!;
    expect(idoc.vectorKind).toBe('identity');
    expect(idoc.summaryText).toBe('网文爽点速查');
    const bdoc = hits.find((h) => h.craftId === 'BDOC')!;
    expect(bdoc.vectorKind).toBe('body');
    expect(bdoc.summaryText).toBeUndefined();
  });

  it('rerank doc carries the 【name】summary header before the body (craft mirror)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A, { summaryText: '游侠指南' });
    // Second FTS hit: the rerank stage early-returns on a 1-hit pool.
    seedCraft('D', 'shuangdian', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const rerankModel = {
      keyId: 'k1',
      modelId: 'bge-reranker-stub',
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:0',
      apiKey: 'stub',
      capability: 'rerank' as const,
    };
    const seenDocs: string[] = [];
    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null, // FTS-only -> RRF surfaces A + D
      embed: async () => VEC_A,
      resolveRerankModel: () => rerankModel,
      rerank: async (_m, _q, docs) => {
        seenDocs.push(...docs);
        return docs.map(() => 0.5);
      },
    });

    expect(hits.length).toBe(2);
    expect(seenDocs).toHaveLength(2);
    expect(seenDocs).toContain('【Ranger】游侠指南\nRanger\ntexas ranger');
    expect(seenDocs).toContain('【Sentinel】\nSentinel\ntexas consensus');
    // Hit bodyText untouched (prefix lives only in the rerank doc build).
    const a = hits.find((h) => h.craftId === 'A')!;
    expect(a.bodyText).toBe('Ranger\ntexas ranger');
  });

  it('degradation: no model -> FTS-only, vectorKind undefined on every hit (identity arm equally absent)', async () => {
    seedCraft('A', 'shuangdian', 'Ranger', 'Ranger\ntexas ranger', VEC_A, {
      identityVec: VEC_B,
      summaryText: '游侠指南',
    });
    seedCraft('B', 'shuangdian', 'Scout', 'Scout\noregon trail', VEC_B);

    // No embedding model -> vec arm (identity AND body) skipped: only the FTS
    // hit A surfaces; kind stays undefined though a #identity row exists.
    const hits = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(hits.map((h) => h.craftId)).toEqual(['A']);
    expect(hits.every((h) => h.vectorKind === undefined)).toBe(true);
    // Entry-level summary still passes through on the FTS-only path.
    expect(hits[0].summaryText).toBe('游侠指南');
  });

  // ── E10.2b W4.2（R10 / F-08）：tags 融合后过滤 ──

  it('tags 过滤：单标签只回标签命中行（无标签/NULL 标签行不误报不报错）', async () => {
    // T1 带目标标签；T2 无 tags 列值（NULL——材料 chunk 行生产形态）；T3 空标签数组。
    seedCraft('T1', 'shuangdian', 'Tagged', 'Tagged\ntexas ranger', null, { tags: ['都市'] });
    seedCraft('T2', 'shuangdian', 'NullTag', 'NullTag\ntexas ranger', null);
    seedCraft('T3', 'shuangdian', 'EmptyTag', 'EmptyTag\ntexas ranger', null, { tags: [] });

    const hits = await searchCraft('texas', { tags: ['都市'], k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(hits.map((h) => h.craftId)).toEqual(['T1']);
  });

  it('tags 多标签任一命中即召回（OR 语义）+ # 前缀容忍（命中渲染展示 #tag 形态）', async () => {
    seedCraft('U1', 'shuangdian', 'UA', 'UA\ntexas ranger', null, { tags: ['都市'] });
    seedCraft('U2', 'shuangdian', 'UB', 'UB\ntexas ranger', null, { tags: ['悬疑'] });
    seedCraft('U3', 'shuangdian', 'UC', 'UC\ntexas ranger', null, { tags: ['仙侠'] });

    const hits = await searchCraft('texas', { tags: ['#都市', '悬疑'], k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(hits.map((h) => h.craftId).sort()).toEqual(['U1', 'U2']);
  });

  it('tags 零命中 → 空结果（不抛错）', async () => {
    seedCraft('V1', 'shuangdian', 'VA', 'VA\ntexas ranger', null, { tags: ['都市'] });

    const hits = await searchCraft('texas', { tags: ['不存在的标签'], k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(hits).toEqual([]);
  });

  it('tags 与 query 文本组合：文本命中 + 标签命中双重收窄', async () => {
    seedCraft('W1', 'shuangdian', 'WA', 'WA\ntexas ranger', null, { tags: ['都市'] });
    seedCraft('W2', 'shuangdian', 'WB', 'WB\noregon trail', null, { tags: ['都市'] });

    // 两条都带标签，但只有 W1 的 body 命中 'texas'——组合 = FTS 命中 ∩ 标签命中。
    const hits = await searchCraft('texas', { tags: ['都市'], k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(hits.map((h) => h.craftId)).toEqual(['W1']);
  });

  it('tags 与 craft_type 组合（同 WHERE 两条件 AND）', async () => {
    seedCraft('X1', 'shuangdian', 'XA', 'XA\ntexas ranger', null, { tags: ['都市'] });
    seedCraft('X2', 'playbook', 'XB', 'XB\ntexas ranger', null, { tags: ['都市'] });

    const hits = await searchCraft('texas', { tags: ['都市'], craftType: 'playbook', k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(hits.map((h) => h.craftId)).toEqual(['X2']);
  });

  it('纯标签浏览：query 空 + tags 在场 → 结构化路径回标签命中（无 query 不拦）', async () => {
    seedCraft('Y1', 'shuangdian', 'YA', 'YA body', null, { tags: ['都市'] });
    seedCraft('Y2', 'shuangdian', 'YB', 'YB body', null);

    const hits = await searchCraft('', { tags: ['都市'], k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(hits.map((h) => h.craftId)).toEqual(['Y1']);
  });

  it('F-08 补偿：标签命中行在默认 vec KNN 窗口外 → tags 在场时窗口 ×4 放宽后召回（AC10 构造用例）', async () => {
    // 构造：45 条 filler（向量与 query 同向 = 全部近于标签行）+ 1 条标签行（正交向量 =
    // 距离最远，排名 46）。默认窗口 vecK = topN*2 = 40 向量行——标签行必然窗外；tags
    // 在场 ×4 → 160 ≥ 46，标签行进融合集后被 tags 过滤保留。
    // FTS 面：标签行 body 不含 'texas'——不做 vec 补偿时任何臂都捞不回它。
    for (let i = 0; i < 45; i++) {
      seedCraft(`F${String(i).padStart(2, '0')}`, 'shuangdian', `Filler${i}`, `Filler${i}\ntexas`, VEC_A);
    }
    seedCraft('RARE', 'shuangdian', 'RareTagged', 'RareTagged\nrare lore only', VEC_B, { tags: ['稀有'] });

    // 无 tags：标签行不可见（FTS 不命中 + 默认 vec 窗口外）。
    const noTags = await searchCraft('texas', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(noTags.map((h) => h.craftId)).not.toContain('RARE');
    expect(noTags).toHaveLength(10); // 窗口内 filler 撑满 k

    // tags 在场：×4 窗口把标签行捞回，融合后过滤只留标签命中行。
    const withTags = await searchCraft('texas', { tags: ['稀有'], k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(withTags.map((h) => h.craftId)).toEqual(['RARE']);
    expect(withTags[0].vecDistance).toBeDefined(); // vec 臂参与了该命中
  });

  // ── E10.2b W4.3：手艺卡检索可见性 = 人审状态（AC6——verify 前后）──

  function makeRetrievalCard(status: CraftCard['status']): CraftCard {
    return {
      cardId: 'card-0123456789ab',
      category: 'qingxu',
      termId: 'term-01234567',
      title: '先抑后扬三层回报',
      claim: {
        condensed: '先压低处境再给回报，回报强度与压抑时长成正比。',
        points: ['压抑段控制在一章内'],
        scenarios: ['开篇钩子'],
        counterexamples: [],
      },
      tags: ['爽文'],
      teachings: [
        {
          teachingId: 'tea-0123456789ab',
          materialId: 'mat-0123456789ab',
          materialContentHash: `sha256:${'a'.repeat(64)}`,
          author: '老作者',
          quote: '先抑后扬的关键是压抑的度。',
          anchor: { chapterIndex: 0, charStart: 120, charEnd: 480, paraStart: 3, paraEnd: 6 },
          rank: 'normal',
          note: null,
          stale: false,
        },
      ],
      dispute: false,
      status,
      rejectReason: null,
      confidence: 0.8,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
  }

  it('pending 卡不可检 → verify 后 query_craft 检回（entry 行 verify 时写——AC6）', async () => {
    const card = makeRetrievalCard('pending_review');
    await insertCraftCard(card, { resolveModel: () => null });

    const before = await searchCraft('先抑后扬', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(before.map((h) => h.craftId)).not.toContain(`card:${card.cardId}`);

    await reviewCraftCard(card.cardId, 'verify', {}, { resolveModel: () => null });

    const after = await searchCraft('先抑后扬', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(after.map((h) => h.craftId)).toContain(`card:${card.cardId}`);
    const hit = after.find((h) => h.craftId === `card:${card.cardId}`)!;
    expect(hit.craftType).toBe('qingxu'); // craft_type = 大类 slug（F-10）
    expect(hit.sourceKind).toBe('craft_card');
  });
});
