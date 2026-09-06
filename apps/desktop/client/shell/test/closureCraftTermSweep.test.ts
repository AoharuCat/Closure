import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel, CraftCard, CraftTerm } from '@orison/shared-contracts';

// E10.2b Wave 2（W2.4）：词目种子 + 归并迁移（category 跟随 + entry 重写）+ 模型切换卡向量
// sweep（挂 reindexAllCraft 同点位）+ F-01 orphan 谓词值域（文档扫描跳过 card: 行）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-craft-term-sweep');

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

import { reindexAllCraft, reindexCraftDoc, scanAndReindexCraftKb, EMBED_DIM } from '../main/db/closureCraftIndexer';
import {
  listCraftTerms,
  seedCraftTerms,
  insertCraftTerm,
  approveCraftTerm,
  mergeCraftTerm,
} from '../main/db/closureCraftTermRepository';
import {
  insertCraftCard,
  reviewCraftCard,
  cardCraftId,
} from '../main/db/closureCraftCardRepository';
import { floatArrayToBuffer } from '../main/db/closureIndexer';
import { _setCraftKbUserDirForTest } from '../main/db/craftKbPaths';
import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

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
  _setCraftKbUserDirForTest(null);
  rmBestEffort(TEST_HOME);
}

function stubModel(modelId: string): ResolvedModel {
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

const CRAFT_DIR = path.join(TEST_HOME, '.orison', 'craft-kb');

function writeCraftDoc(fileName: string, body: string): string {
  if (!existsSync(CRAFT_DIR)) mkdirSync(CRAFT_DIR, { recursive: true });
  const filePath = path.join(CRAFT_DIR, fileName);
  writeFileSync(filePath, `---\nid: ${fileName.replace(/\.md$/, '')}\ncraft_type: qiaoduan\n---\n${body}`, 'utf-8');
  return filePath;
}

function mkTerm(over: Partial<CraftTerm> = {}): CraftTerm {
  return {
    termId: 'term-aaaa0001',
    category: 'qingxu',
    name: '先抑后扬',
    status: 'active',
    mergedInto: null,
    note: null,
    ...over,
  };
}

function mkCard(over: Partial<CraftCard> = {}): CraftCard {
  return {
    cardId: 'card-aaaa00000001',
    category: 'qingxu',
    termId: 'term-aaaa0001',
    title: '招式一',
    claim: { condensed: '卡甲的保义浓缩主张', points: [], scenarios: [], counterexamples: [] },
    tags: [],
    teachings: [
      {
        teachingId: 'tea-aaaa00000001',
        materialId: 'mat-aaaa00000001',
        materialContentHash: `sha256:${'a'.repeat(64)}`,
        author: null,
        quote: '来源引文甲',
        anchor: { chapterIndex: 0, charStart: 0, charEnd: 6, paraStart: 0, paraEnd: 1 },
        rank: 'normal',
        note: null,
        stale: false,
      },
    ],
    dispute: false,
    status: 'pending_review',
    rejectReason: null,
    confidence: 0.8,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

function cardEntry(cardId: string): { body_text: string; craft_type: string; model: string | null } | undefined {
  return getDb()
    .prepare('SELECT body_text, craft_type, model FROM closure_craft_entry WHERE craft_id=?')
    .get(cardCraftId(cardId)) as { body_text: string; craft_type: string; model: string | null } | undefined;
}

describe.skipIf(!sqliteUsable)('closure_craft_term 种子/归并 + 卡向量 sweep + F-01 谓词（W2.4）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
  });
  afterAll(clean);

  it('词目种子：懒种子落 5 个白话散并位（epics 指派类别）+ 幂等', () => {
    const terms = listCraftTerms(); // 首查触发懒种子
    const byName = new Map(terms.map((t) => [t.name, t]));
    expect(terms).toHaveLength(5);
    expect(byName.get('同类场景变奏')?.category).toBe('jiegoudafa');
    expect(byName.get('固定调度模式')?.category).toBe('jiegoudafa');
    expect(byName.get('人物对照组')?.category).toBe('renshe');
    expect(byName.get('角色声纹')?.category).toBe('renshe');
    expect(byName.get('节奏调剂子型')?.category).toBe('qidaigan');
    expect(terms.every((t) => t.status === 'active')).toBe(true);
    const idsBefore = terms.map((t) => t.termId).sort();

    seedCraftTerms(); // 确定性 id + OR IGNORE——重放零重复
    expect(listCraftTerms().map((t) => t.termId).sort()).toEqual(idsBefore);
  });

  it('approve：pending → active；核准已 active/merged = invalid-state；未知 id = not-found', () => {
    insertCraftTerm(mkTerm({ termId: 'term-cccc0003', name: '新提案词目', status: 'pending' }));
    const res = approveCraftTerm('term-cccc0003');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.term.status).toBe('active');
    expect(approveCraftTerm('term-cccc0003')).toEqual({ ok: false, error: 'invalid-state' }); // 已 active
    insertCraftTerm(mkTerm({ termId: 'term-dddd0004', name: '墓碑词目', status: 'merged', mergedInto: 'term-cccc0003' }));
    expect(approveCraftTerm('term-dddd0004')).toEqual({ ok: false, error: 'invalid-state' });
    expect(approveCraftTerm('term-ffff0001')).toEqual({ ok: false, error: 'not-found' });
  });

  it('merge：卡改挂 + category 跟随新 term + 已核卡 entry 重写（新词目名/新大类）+ 墓碑留痕', async () => {
    insertCraftTerm(mkTerm({ termId: 'term-eeee0005', name: '旧词目' }));
    insertCraftTerm(mkTerm({ termId: 'term-eeee0006', category: 'qidaigan', name: '新词目' }));
    await insertCraftCard(
      mkCard({ cardId: 'card-eeee00000001', termId: 'term-eeee0005', title: '招式乙' }),
      { resolveModel: () => null },
    );
    await reviewCraftCard('card-eeee00000001', 'verify', {}, { resolveModel: () => null });
    await insertCraftCard(
      mkCard({ cardId: 'card-eeee00000002', termId: 'term-eeee0005', title: '招式丙' }),
      { resolveModel: () => null },
    );
    // 归并前：entry body 含旧词目名。
    expect(cardEntry('card-eeee00000001')?.body_text).toContain('旧词目');

    const res = mergeCraftTerm('term-eeee0005', 'term-eeee0006');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.movedCardCount).toBe(2);
      expect(res.term.status).toBe('merged');
      expect(res.term.mergedInto).toBe('term-eeee0006');
    }
    const db = getDb();
    for (const cardId of ['card-eeee00000001', 'card-eeee00000002']) {
      const row = db.prepare('SELECT term_id, category FROM closure_craft_card WHERE card_id=?').get(cardId) as {
        term_id: string;
        category: string;
      };
      expect(row.term_id).toBe('term-eeee0006');
      expect(row.category).toBe('qidaigan'); // category 随新 term 自动改（F-15 单源）
    }
    // 已核卡 entry 重写：body 换新词目名 + craft_type 换新大类；pending 卡仍无 entry 行（F-06）。
    const entry = cardEntry('card-eeee00000001');
    expect(entry?.body_text).toContain('新词目');
    expect(entry?.body_text).not.toContain('旧词目');
    expect(entry?.craft_type).toBe('qidaigan');
    expect(cardEntry('card-eeee00000002')).toBeUndefined();

    // 已 merged 的 source / target 再参与归并 = invalid-state。
    expect(mergeCraftTerm('term-eeee0005', 'term-cccc0003')).toEqual({ ok: false, error: 'invalid-state' });
    expect(mergeCraftTerm('term-cccc0003', 'term-eeee0005')).toEqual({ ok: false, error: 'invalid-state' });
    // 自归并 = invalid-input；未知 id = not-found。
    expect(mergeCraftTerm('term-cccc0003', 'term-cccc0003')).toEqual({ ok: false, error: 'invalid-input' });
    expect(mergeCraftTerm('term-ffff0002', 'term-cccc0003')).toEqual({ ok: false, error: 'not-found' });
  });

  it('sweep（F-05）：reindexAllCraft 模型切换 → 全卡 #claim 重嵌 + entry 按卡状态重建 + doc 行为不回归', async () => {
    _setCraftKbUserDirForTest(CRAFT_DIR);
    const docPath = writeCraftDoc('sweepdoc.md', '# Sweep\nsweep doc body');
    // 阶段一：model-a / slot-2 建 doc + 两卡（一 verify 一 pending）。
    await reindexCraftDoc(docPath, 'user', {
      resolveModel: () => stubModel('embed-model-a'),
      embed: async () => vec1024(2),
    });
    insertCraftTerm(mkTerm({ termId: 'term-ffff0003', name: 'sweep 词目' }));
    await insertCraftCard(
      mkCard({ cardId: 'card-ffff00000001', termId: 'term-ffff0003', title: 'sweep 已核' }),
      { resolveModel: () => stubModel('embed-model-a'), embed: async () => vec1024(2) },
    );
    await reviewCraftCard('card-ffff00000001', 'verify', {}, { resolveModel: () => null });
    await insertCraftCard(
      mkCard({ cardId: 'card-ffff00000002', termId: 'term-ffff0003', title: 'sweep 待审' }),
      { resolveModel: () => stubModel('embed-model-a'), embed: async () => vec1024(2) },
    );
    expect(cardEntry('card-ffff00000001')?.model).toBe('embed-model-a');

    // 阶段二：模型切 model-b / slot-1 全量重建——sweep 同点位收尾。
    const result = await reindexAllCraft({
      resolveModel: () => stubModel('embed-model-b'),
      embed: async () => vec1024(1),
    });
    expect(result.reindexed).toBeGreaterThanOrEqual(1); // doc 既有行为不回归
    expect(result.cardsReembedded).toBeGreaterThanOrEqual(2);

    const db = getDb();
    for (const cardId of ['card-ffff00000001', 'card-ffff00000002']) {
      const row = db.prepare('SELECT claim_model FROM closure_craft_card WHERE card_id=?').get(cardId) as {
        claim_model: string | null;
      };
      expect(row.claim_model).toBe('embed-model-b'); // 含 pending 卡（去重面常驻全卡）
    }
    if (isSqliteVecAvailable()) {
      const knn = db
        .prepare(
          `SELECT craft_id FROM closure_craft_vec WHERE embedding MATCH ? AND k = 8 AND vector_kind='claim'`,
        )
        .all(floatArrayToBuffer(vec1024(1))) as { craft_id: string }[];
      const ids = knn.map((r) => r.craft_id);
      expect(ids).toContain(cardCraftId('card-ffff00000001'));
      expect(ids).toContain(cardCraftId('card-ffff00000002'));
    }
    // entry 按卡状态重建：verified 重写（新 model 记账）/ pending 仍无行（F-06）。
    const verifiedEntry = cardEntry('card-ffff00000001');
    expect(verifiedEntry?.model).toBe('embed-model-b');
    expect(cardEntry('card-ffff00000002')).toBeUndefined();
    // doc 行 model 同步翻新（既有语义）。
    expect(
      (db.prepare('SELECT model FROM closure_craft_entry WHERE craft_id=?').get('sweepdoc') as { model: string | null }).model,
    ).toBe('embed-model-b');
  });

  it('sweep 零文档形态：craft KB 空 + 有卡 → 探针回退卡 condensed，卡照常重嵌', async () => {
    const emptyDir = path.join(TEST_HOME, 'empty-craft-dir');
    rmBestEffort(emptyDir);
    mkdirSync(emptyDir, { recursive: true });
    _setCraftKbUserDirForTest(emptyDir); // 零文档（bundled dir 在 vitest 下不可用）

    const result = await reindexAllCraft({
      resolveModel: () => stubModel('embed-model-c'),
      embed: async () => vec1024(4),
    });
    expect(result.reindexed).toBe(0);
    expect(result.cardsReembedded).toBeGreaterThanOrEqual(2); // 早退修复：卡不被零文档短路

    const db = getDb();
    const row = db.prepare('SELECT claim_model FROM closure_craft_card WHERE card_id=?').get('card-ffff00000002') as {
      claim_model: string | null;
    };
    expect(row.claim_model).toBe('embed-model-c');
    if (isSqliteVecAvailable()) {
      const knn = db
        .prepare(`SELECT craft_id FROM closure_craft_vec WHERE embedding MATCH ? AND k = 8 AND vector_kind='claim'`)
        .all(floatArrayToBuffer(vec1024(4))) as { craft_id: string }[];
      expect(knn.map((r) => r.craft_id)).toContain(cardCraftId('card-ffff00000002'));
    }
  });

  it('F-01 orphan 谓词：craft 文档扫描跳过 card: 行（含材料行）+ 真 orphan doc 照删（正反两测）', async () => {
    _setCraftKbUserDirForTest(CRAFT_DIR); // sweepdoc.md 在盘上
    const db = getDb();
    // 邻居：真 orphan doc 行（盘上无对应文件——该被删，positive control）。
    db.prepare(
      `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text) VALUES ('orphan-doc-xyz', 'qiaoduan', 'user', 'o', 'orphan body')`,
    ).run();

    await scanAndReindexCraftKb({ resolveModel: () => null });

    // card: 行幸存（卡行生命周期归卡索引器——文档扫描领地之外）。
    expect(cardEntry('card-ffff00000001')).toBeTruthy();
    // 材料 chunk 行幸存（10.1 既有谓词不回归）。
    db.prepare(
      `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text) VALUES ('mat:mat-ffff00000001.ch0#c0', 'material', 'material_chunk', 'm', 'chunk')`,
    ).run();
    await scanAndReindexCraftKb({ resolveModel: () => null });
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('mat:mat-ffff00000001.ch0#c0'),
    ).toBeTruthy();
    // 真 orphan 删除（谓词收窄不是不删）。
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('orphan-doc-xyz'),
    ).toBeUndefined();
    // 盘上 doc 行幸存。
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('sweepdoc'),
    ).toBeTruthy();
    db.prepare('DELETE FROM closure_craft_entry WHERE craft_id=?').run('mat:mat-ffff00000001.ch0#c0');
  });
});

// beforeEach 复位 user dir（scan/sweep 测试各自设值，防泄漏到下一测试的 listCraftMdFiles）。
beforeEach(() => {
  if (sqliteUsable) _setCraftKbUserDirForTest(null);
});
