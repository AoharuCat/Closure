import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is never
// touched. Distinct dir from the other suites so they never collide.
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-asset-cards-indexer');
const PROJECT_DIR = path.join(TEST_HOME, 'my-project');

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

import {
  ASSET_CARD_SOURCE_KIND,
  materializeAssetCardBody,
  reindexAssetCards,
} from '../main/db/assetCardsIndexer';
import { EMBED_DIM, floatArrayToBuffer, getCurrentVecDim } from '../main/db/closureIndexer';
import { closeDb, getDb } from '../main/db/index';
import { ensureProject } from '../main/db/projectRepository';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 is a native addon rebuilt against Electron's ABI; under plain-Node
// vitest its ABI may not match, so the SQL integration suite skips (same gate as
// closureIndexer / closureCraftIndexer suites).
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

function vec1024(slot = 0): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[slot] = 1.0;
  return v;
}

// A unit 512-dim vector (for the F2 dim-change model-swap test: 1024 -> 512).
function vec512(slot = 0): number[] {
  const v = new Array(512).fill(0);
  v[slot] = 1.0;
  return v;
}

/** Build + persist a project.yaml with the given asset_cards, register it so
 *  getProject(path) resolves a registry projectId (the namespace query_story uses). */
async function seedProject(cards: unknown[]): Promise<string> {
  const { saveProject } = await import('@orison/desktop-local-bff');
  mkdirSync(PROJECT_DIR, { recursive: true });
  const now = new Date().toISOString();
  saveProject(PROJECT_DIR, {
    meta: { id: 'uuid-test', name: 'Test', type: 'novel', version: 1, created_at: now, updated_at: now },
    storyboard: { shots: [] },
    asset_cards: cards as never,
  } as never);
  // Register so reindexAssetCards can resolve the registry project_id.
  ensureProject({
    name: 'Test',
    type: 'novel',
    localFingerprint: path.resolve(PROJECT_DIR),
    path: path.resolve(PROJECT_DIR),
  });
  return PROJECT_DIR;
}

// ── materializeAssetCardBody pure-logic tests (RUN under plain vitest, no DB) ──
describe('materializeAssetCardBody (pure, Story 2.7 R3)', () => {
  it('flattens a character card: name + summary + basics.aliases + typed fields + details + tags', () => {
    const body = materializeAssetCardBody({
      id: 'c1',
      type: 'character',
      name: '德克萨斯',
      summary: '罗德岛干员',
      basics: { aliases: ['德狗子', 'Texas'], gender: '女', occupation: '先锋' },
      personality: { coreTraits: ['冷静', '忠诚'], surface: '寡言' },
      tags: ['核心', '前期'],
      details: { customNote: '喜欢甜品' },
    } as never);
    // headline
    expect(body).toContain('德克萨斯');
    expect(body).toContain('罗德岛干员');
    // aliases flattened (entity-search discoverable)
    expect(body).toContain('德狗子');
    expect(body).toContain('Texas');
    // typed scalar fields
    expect(body).toContain('女');
    expect(body).toContain('先锋');
    expect(body).toContain('冷静');
    expect(body).toContain('寡言');
    // customFields (details)
    expect(body).toContain('喜欢甜品');
    // tags joined as a labeled free-text line
    expect(body).toContain('标签：核心 / 前期');
  });

  it('minimal card (id+type+name) → body is just the name (missing fields tolerated)', () => {
    const body = materializeAssetCardBody({ id: 'c1', type: 'rule', name: '魔法守恒' } as never);
    expect(body).toBe('魔法守恒');
  });

  it('skips empty / null / undefined leaves (no blank lines, no "undefined")', () => {
    const body = materializeAssetCardBody({
      id: 'c2',
      type: 'location',
      name: '龙门',
      summary: '',
      basics: { aliases: [], scale: '大型城市' },
      environment: { moodKeywords: [], palette: '灰蓝' },
    } as never);
    expect(body).toContain('龙门');
    expect(body).toContain('大型城市');
    expect(body).toContain('灰蓝');
    expect(body).not.toContain('undefined');
    // no blank lines (empty arrays / strings dropped)
    expect(body.split('\n')).not.toContain('');
  });

  it('flattens nested objects recursively (golden_finger limitations hard limit)', () => {
    const body = materializeAssetCardBody({
      id: 'gf1',
      type: 'golden_finger',
      name: '系统',
      limitations: { hardLimits: '不能复活死者', usageCost: '每日三次' },
    } as never);
    expect(body).toContain('不能复活死者');
    expect(body).toContain('每日三次');
  });

  it('boolean + number leaves are stringified (golden_finger.basics.unique)', () => {
    const body = materializeAssetCardBody({
      id: 'gf2',
      type: 'golden_finger',
      name: '血脉觉醒',
      basics: { unique: true, awakeningTime: '第三章' },
    } as never);
    expect(body).toContain('true');
    expect(body).toContain('第三章');
  });

  it('ASSET_CARD_SOURCE_KIND distinguishes setting cards from project_assets', () => {
    expect(ASSET_CARD_SOURCE_KIND).toBe('setting_card');
    expect(ASSET_CARD_SOURCE_KIND).not.toBe('asset_card');
  });
});

// ── DB-integration tests (skip under plain vitest on ABI mismatch) ──
describe.skipIf(!sqliteUsable)('reindexAssetCards DB integration (Story 2.7)', () => {
  beforeAll(clean);
  afterAll(clean);

  it('writes closure_entry (entry_type=card.type, source_kind=setting_card) + entry_fts + entry_vec', async () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    const projectPath = await seedProject([
      { id: 'card-A', type: 'character', name: 'Ranger', summary: 'texas ranger silent hunter' },
    ]);

    let embedCalls = 0;
    const { reindexed, orphaned } = await reindexAssetCards(projectPath, {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    });
    expect(reindexed).toBe(1);
    expect(orphaned).toBe(0);
    expect(embedCalls).toBe(1);

    const entry = db
      .prepare(
        'SELECT entry_type, source_kind, name, body_text, content_hash, model, dim FROM closure_entry WHERE entry_id=?',
      )
      .get('card-A') as {
      entry_type: string; source_kind: string; name: string; body_text: string;
      content_hash: string; model: string | null; dim: number | null;
    };
    expect(entry.entry_type).toBe('character');
    expect(entry.source_kind).toBe('setting_card');
    expect(entry.name).toBe('Ranger');
    expect(entry.body_text).toContain('Ranger');
    expect(entry.body_text).toContain('texas ranger');
    expect(entry.content_hash.length).toBe(64); // sha256 hex
    expect(entry.model).toBe('text-embedding-3-test');
    expect(entry.dim).toBe(EMBED_DIM);

    // entry_fts MATCH finds a body-only term (proves AFTER INSERT trigger). Use a
    // 6-char ASCII term (trigram tokenizer needs 3+ chars).
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('silent') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain('card-A');

    if (vecAvailable) {
      const projectIdRow = db
        .prepare('SELECT project_id FROM closure_entry WHERE entry_id=?')
        .get('card-A') as { project_id: string };
      const rows = db
        .prepare(
          `SELECT entry_id, distance FROM entry_vec WHERE project_id = ? AND embedding MATCH ? AND k = 1 ORDER BY distance`,
        )
        .all(projectIdRow.project_id, floatArrayToBuffer(vec1024())) as { entry_id: string; distance: number }[];
      // KNN finds the card by its vector (project_id scoping works regardless of
      // the specific registry id).
      expect(rows.map((r) => r.entry_id)).toContain('card-A');
    }
  });

  it('projectId is the REGISTRY id (query_story namespace), not project.yaml meta.id', async () => {
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'card-idns', type: 'location', name: 'Lungmen' },
    ]);
    await reindexAssetCards(projectPath, {
      resolveModel: () => null, // FTS-only, no embed needed for this assertion
      embed: async () => vec1024(),
    });
    const row = db
      .prepare('SELECT project_id FROM closure_entry WHERE entry_id=?')
      .get('card-idns') as { project_id: string };
    // Registry project_id is a 5-digit zero-padded string, NOT the yaml meta.id
    // ('uuid-test'). This is the namespace query_story / reindexAsset use.
    expect(row.project_id).toMatch(/^\d{5}$/);
    expect(row.project_id).not.toBe('uuid-test');
  });

  it('content-hash skip: unchanged card does not re-embed', async () => {
    const projectPath = await seedProject([
      { id: 'card-skip', type: 'prop', name: '打火机', summary: '银色打火机' },
    ]);
    let embedCalls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    };
    await reindexAssetCards(projectPath, deps);
    expect(embedCalls).toBe(1);
    await reindexAssetCards(projectPath, deps); // unchanged → skip
    expect(embedCalls).toBe(1);
  });

  it('no model → FTS-only (closure_entry + fts present, vec absent, pending_embed)', async () => {
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'card-nomodel', type: 'lore', name: '创世神话', summary: 'Polti36 范式' },
    ]);
    await reindexAssetCards(projectPath, {
      resolveModel: () => null,
      embed: async () => vec1024(), // must NOT be called
    });
    const entry = db
      .prepare('SELECT model, dim, content_hash FROM closure_entry WHERE entry_id=?')
      .get('card-nomodel') as { model: string | null; dim: number | null; content_hash: string | null };
    expect(entry.model).toBeNull();
    expect(entry.dim).toBeNull();
    expect(entry.content_hash).toBeNull(); // pending_embed
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('Polti36') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain('card-nomodel');
  });

  it('orphan cleanup: a deleted card (no longer in yaml) is removed from closure_entry', async () => {
    const db = getDb();
    // Seed two cards.
    const projectPath = await seedProject([
      { id: 'card-keep', type: 'organization', name: 'RhodesIsland' },
      { id: 'card-del', type: 'rule', name: '魔法规则' },
    ]);
    await reindexAssetCards(projectPath, {
      resolveModel: () => null,
      embed: async () => vec1024(),
    });
    expect(
      db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get('card-del'),
    ).toBeDefined();

    // Re-save yaml with only card-keep (card-del deleted).
    const { saveProject } = await import('@orison/desktop-local-bff');
    const now = new Date().toISOString();
    saveProject(projectPath, {
      meta: { id: 'uuid-test', name: 'Test', type: 'novel', version: 1, created_at: now, updated_at: now },
      storyboard: { shots: [] },
      asset_cards: [{ id: 'card-keep', type: 'organization', name: 'RhodesIsland' }] as never,
    } as never);

    const { orphaned } = await reindexAssetCards(projectPath, {
      resolveModel: () => null,
      embed: async () => vec1024(),
    });
    expect(orphaned).toBe(1);
    expect(
      db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get('card-del'),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get('card-keep'),
    ).toBeDefined();
  });

  it('does not touch project_assets rows (source_kind=asset_card) during orphan cleanup', async () => {
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'card-coexist', type: 'visual_motif', name: '红色围巾' },
    ]);
    // Run reindexAssetCards once so card-coexist lands + we know its project_id.
    await reindexAssetCards(projectPath, { resolveModel: () => null, embed: async () => vec1024() });
    const row = db
      .prepare('SELECT project_id FROM closure_entry WHERE entry_id=?')
      .get('card-coexist') as { project_id: string };
    // Insert a project_assets-derived row manually (source_kind='asset_card') to
    // simulate coexistence in the shared closure_entry table.
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text)
       VALUES (?, ?, 'character', 'asset_card', 'proj-asset', 'should survive')`,
    ).run('proj-asset-X', row.project_id);

    await reindexAssetCards(projectPath, { resolveModel: () => null, embed: async () => vec1024() });

    // The project_assets row survives — orphan cleanup only touches source_kind='setting_card'.
    const survivor = db
      .prepare('SELECT source_kind FROM closure_entry WHERE entry_id=?')
      .get('proj-asset-X') as { source_kind: string };
    expect(survivor.source_kind).toBe('asset_card');
  });

  it('unregistered project (no registry row) → no-op, never throws', async () => {
    // Write a project.yaml but do NOT call ensureProject. getProject(path) returns
    // undefined → reindexAssetCards skips (cards would be unqueryable without a
    // registry id).
    const { saveProject } = await import('@orison/desktop-local-bff');
    const unregisteredDir = path.join(TEST_HOME, 'unregistered');
    mkdirSync(unregisteredDir, { recursive: true });
    const now = new Date().toISOString();
    saveProject(unregisteredDir, {
      meta: { id: 'uuid-unreg', name: 'Unreg', type: 'novel', version: 1, created_at: now, updated_at: now },
      storyboard: { shots: [] },
      asset_cards: [{ id: 'card-unreg', type: 'character', name: 'Ghost' }] as never,
    } as never);

    await expect(
      reindexAssetCards(unregisteredDir, { resolveModel: () => null, embed: async () => vec1024() }),
    ).resolves.toEqual({ reindexed: 0, orphaned: 0 });
  });

  // ── F1 (BLIND-1=EDGE-1): reindexed counts only actual writes; hash-skip no-op NOT counted ──
  it('F1: first call reindexed===card count; second (hash-skip) reindexed===0; force reindexed===full', async () => {
    const projectPath = await seedProject([
      { id: 'card-f1', type: 'prop', name: '打火机', summary: '银色打火机' },
    ]);
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    };
    // First call: card has no prior hash -> written -> reindexed=1.
    const r1 = await reindexAssetCards(projectPath, deps);
    expect(r1.reindexed).toBe(1);
    // Second call WITHOUT force: body unchanged -> hash-skip no-op -> reindexed=0
    // (so the open-project backfill toast stays silent on reopen - AC8).
    const r2 = await reindexAssetCards(projectPath, deps);
    expect(r2.reindexed).toBe(0);
    // Third call WITH force: bypasses hash-skip -> re-embedded -> reindexed=1 (full
    // count, so the rebuild toast shows every card).
    const r3 = await reindexAssetCards(projectPath, { ...deps, force: true });
    expect(r3.reindexed).toBe(1);
  });

  // ── F2 (BLIND-3=ACCEPT-3): pure-card project + dim-change swap -> entry_vec rebuilt ──
  it('F2: pure-card project (no project_assets) + dim-change model swap -> entry_vec rebuilt at new dim, card vec lands (not FTS-only)', async () => {
    const db = getDb();
    if (!isSqliteVecAvailable()) return; // vec-specific behavior
    const projectPath = await seedProject([
      { id: 'card-dim', type: 'character', name: 'DimSwap', summary: 'dimension swap test' },
    ]);
    // First index under a 1024-dim model (force=true so the F2 probe ensures
    // entry_vec is at 1024 regardless of prior test state - clean baseline before
    // the dim-change swap).
    await reindexAssetCards(projectPath, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
      force: true,
    });
    expect(getCurrentVecDim(db)).toBe(1024);
    let entry = db
      .prepare('SELECT dim, content_hash FROM closure_entry WHERE entry_id=?')
      .get('card-dim') as { dim: number | null; content_hash: string | null };
    expect(entry.dim).toBe(1024);
    expect(entry.content_hash).not.toBeNull(); // vec landed (not pending_embed)

    // Swap to a 512-dim model (force=true, mirror reindexAllForChangedModel). A
    // pure-card project makes reindexAll early-return before its dim probe, so
    // reindexAssetCards must probe + ensureEntryVecDim itself (else the stale 1024
    // entry_vec degrades the 512-dim embed to FTS-only).
    await reindexAssetCards(projectPath, {
      resolveModel: () => stubModel(),
      embed: async () => vec512(),
      force: true,
    });
    expect(getCurrentVecDim(db)).toBe(512);
    entry = db
      .prepare('SELECT dim, content_hash FROM closure_entry WHERE entry_id=?')
      .get('card-dim') as { dim: number | null; content_hash: string | null };
    expect(entry.dim).toBe(512);
    expect(entry.content_hash).not.toBeNull(); // vec landed at new dim (not FTS-only)
  });

  // ── F5 (EDGE-2): concurrent reindexAssetCards on the same project serialize ──
  it('F5: concurrent reindexAssetCards on the same project serialize (embed calls do not overlap)', async () => {
    const projectPath = await seedProject([
      { id: 'card-ser-a', type: 'character', name: 'Alice' },
      { id: 'card-ser-b', type: 'character', name: 'Bob' },
    ]);
    let activeEmbeds = 0;
    let maxConcurrent = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => {
        activeEmbeds++;
        maxConcurrent = Math.max(maxConcurrent, activeEmbeds);
        await new Promise((r) => setTimeout(r, 10));
        activeEmbeds--;
        return vec1024();
      },
    };
    // Fire two concurrent reindexes (force=true so both embed, not hash-skip).
    await Promise.all([
      reindexAssetCards(projectPath, { ...deps, force: true }),
      reindexAssetCards(projectPath, { ...deps, force: true }),
    ]);
    // Serialized: no overlapping embed calls (also honors the API-concurrency guard).
    expect(maxConcurrent).toBe(1);
  });

  // ── F8 (EDGE-4): duplicate card ids -> last-wins (ON CONFLICT), warned (not silent) ──
  it('F8: duplicate card ids in yaml -> last-wins survivor, single row', async () => {
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'dup-id', type: 'character', name: 'First Card' },
      { id: 'dup-id', type: 'character', name: 'Second Card' },
    ]);
    await reindexAssetCards(projectPath, {
      resolveModel: () => null,
      embed: async () => vec1024(),
    });
    // ON CONFLICT last-wins: the second card's name is the survivor.
    const row = db
      .prepare('SELECT name FROM closure_entry WHERE entry_id=?')
      .get('dup-id') as { name: string };
    expect(row.name).toBe('Second Card');
    // Deduped to a single row (not two).
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM closure_entry WHERE entry_id=?')
      .get('dup-id') as { n: number };
    expect(count.n).toBe(1);
  });

  // ── F9 (EDGE-5): card.id colliding with a project_assets row -> skip, not clobber ──
  it('F9: card.id colliding with a project_assets row (source_kind=asset_card) is skipped, not clobbered', async () => {
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'collide-id', type: 'character', name: 'Card Version' },
    ]);
    // First, index the card normally (becomes source_kind='setting_card').
    await reindexAssetCards(projectPath, {
      resolveModel: () => null,
      embed: async () => vec1024(),
    });
    // Simulate a project_assets-derived row taking over the same entry_id
    // (source_kind='asset_card', different body).
    db.prepare(
      "UPDATE closure_entry SET source_kind='asset_card', body_text='file-asset-body' WHERE entry_id=?",
    ).run('collide-id');
    // Re-run reindexAssetCards. Without the F9 guard, the card upsert's ON CONFLICT
    // would flip source_kind to 'setting_card' + overwrite the body. With F9, the
    // card is skipped (warn + no clobber).
    await reindexAssetCards(projectPath, {
      resolveModel: () => null,
      embed: async () => vec1024(),
    });
    const row = db
      .prepare('SELECT source_kind, body_text FROM closure_entry WHERE entry_id=?')
      .get('collide-id') as { source_kind: string; body_text: string };
    // source_kind stays 'asset_card' (NOT clobbered to 'setting_card').
    expect(row.source_kind).toBe('asset_card');
    // body_text stays the file-asset body (NOT overwritten with the card body).
    expect(row.body_text).toBe('file-asset-body');
  });
});

// ── Story 8.7 S4：status 物化 + 卡类单 #body 向量 ──
describe.skipIf(!sqliteUsable)('reindexAssetCards Story 8.7 S4 (status materialization / single #body vector)', () => {
  beforeAll(clean);
  afterAll(clean);

  it('status is materialized into closure_entry (card schema default draft)', async () => {
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'card-st1', type: 'character', name: 'Status Default' },
      { id: 'card-st2', type: 'character', name: 'Status Explicit', status: 'deprecated' },
    ]);
    await reindexAssetCards(projectPath, { resolveModel: () => null, embed: async () => vec1024() });
    const st1 = db.prepare('SELECT status FROM closure_entry WHERE entry_id=?').get('card-st1') as { status: string | null };
    const st2 = db.prepare('SELECT status FROM closure_entry WHERE entry_id=?').get('card-st2') as { status: string | null };
    // saveProject runs the schema (status defaults 'draft'); the indexer
    // materializes it. Explicit status passes through.
    expect(st1.status).toBe('draft');
    expect(st2.status).toBe('deprecated');
  });

  it('a status-only edit reindexes (status is in the hash payload — no stale filter dimension)', async () => {
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'card-stflip', type: 'prop', name: 'Status Flip', summary: 'same body' },
    ]);
    await reindexAssetCards(projectPath, { resolveModel: () => null, embed: async () => vec1024() });
    expect(
      (db.prepare('SELECT status FROM closure_entry WHERE entry_id=?').get('card-stflip') as { status: string | null }).status,
    ).toBe('draft');

    // Re-save with ONLY the status changed (draft -> locked), body identical.
    const { saveProject } = await import('@orison/desktop-local-bff');
    const now = new Date().toISOString();
    saveProject(projectPath, {
      meta: { id: 'uuid-test', name: 'Test', type: 'novel', version: 1, created_at: now, updated_at: now },
      storyboard: { shots: [] },
      asset_cards: [
        { id: 'card-stflip', type: 'prop', name: 'Status Flip', summary: 'same body', status: 'locked' },
      ] as never,
    } as never);
    await reindexAssetCards(projectPath, { resolveModel: () => null, embed: async () => vec1024() });
    expect(
      (db.prepare('SELECT status FROM closure_entry WHERE entry_id=?').get('card-stflip') as { status: string | null }).status,
    ).toBe('locked');
  });

  it('card-type entries write a SINGLE #body vector row (no identity redundancy)', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    const projectPath = await seedProject([
      { id: 'card-vec1', type: 'character', name: 'Vec Single', summary: 'texas ranger' },
    ]);
    let embedCalls = 0;
    await reindexAssetCards(projectPath, {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    });
    // Single embed (the materialized body already contains name+summary —
    // design §1.3: an identity vector for cards is pure redundancy).
    expect(embedCalls).toBe(1);
    const rows = db
      .prepare('SELECT vector_id, entry_id, vector_kind, status, visibility FROM entry_vec WHERE entry_id=?')
      .all('card-vec1') as {
      vector_id: string;
      entry_id: string;
      vector_kind: string;
      status: string;
      visibility: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      vector_id: 'card-vec1#body',
      entry_id: 'card-vec1',
      vector_kind: 'body',
      // Story 8.3 CR-005: setting_card rows carry a REAL status (schema default
      // 'draft' — the only source with one, 8.7 §1.2) + the 'known' literal,
      // mirroring the closure_entry INSERT for KNN/belt agreement.
      status: 'draft',
      visibility: 'known',
    });
  });
});

