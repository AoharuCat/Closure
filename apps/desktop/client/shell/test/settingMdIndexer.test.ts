import { createHash } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is never
// touched. Distinct dir from the other suites so they never collide.
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-setting-md-indexer');
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
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

import {
  SETTING_MD_SOURCE_KIND,
  settingEntryId,
  reindexSettingMd,
  reindexSettingMdDelete,
  reindexAllSettingMd,
} from '../main/db/settingMdIndexer';
import { EMBED_DIM, floatArrayToBuffer } from '../main/db/closureIndexer';
import { listSettingMdFiles } from '../main/db/settingMdPaths';
import { closeDb, getDb } from '../main/db/index';
import { ensureProject, getProject } from '../main/db/projectRepository';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 is a native addon rebuilt against Electron's ABI; under plain-Node
// vitest its ABI may not match, so the SQL integration suite skips (same gate as
// closureIndexer / closureCraftIndexer / assetCardsIndexer suites).
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

/** Stub TEXT-capability model for the summary seam (Story 8.7 §3.1). */
function stubSummaryModel(): ResolvedModel {
  return {
    keyId: 'k1',
    modelId: 'gpt-test-summary',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:0',
    apiKey: 'stub',
    capability: 'text',
  };
}

function vec1024(slot = 0): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[slot] = 1.0;
  return v;
}

/** Create + register the project so getProject(path) resolves a registry
 *  projectId (the namespace query_story / reindexAssetCards / reindexSettingMd
 *  use - mirror 2.7 as-built). setting_md reads settings/*.md (NOT project.yaml),
 *  so no saveProject is needed. */
function seedProject(): string {
  mkdirSync(PROJECT_DIR, { recursive: true });
  ensureProject({
    name: 'Test',
    type: 'novel',
    localFingerprint: path.resolve(PROJECT_DIR),
    path: path.resolve(PROJECT_DIR),
  });
  return PROJECT_DIR;
}

function writeSettingDoc(projectDir: string, fileName: string, frontmatter: string, body: string): string {
  const settingsDir = path.join(projectDir, 'settings');
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  const filePath = path.join(settingsDir, fileName);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, 'utf-8');
  return filePath;
}

/** Clear the settings/ dir before each test so scans see only the docs the test
 *  writes (the db persists across tests - beforeAll/afterAll clean - but the scan's
 *  orphan cleanup deletes stale setting_md rows whose files are gone). */
function cleanSettingsDir() {
  const settingsDir = path.join(PROJECT_DIR, 'settings');
  rmBestEffort(settingsDir);
}

describe.skipIf(!sqliteUsable)('settingMdIndexer DB integration (Story 2.3)', () => {
  beforeAll(clean);
  afterAll(clean);
  beforeEach(cleanSettingsDir);

  it('reindexSettingMd writes closure_entry (entry_id namespaced, source_kind=setting_md) + entry_fts + entry_vec', async () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(
      projectDir,
      'magic.md',
      'id: magic-system\ntype: magic_system\ntags: [魔法]\nsource: test',
      '# 魔法体系\n即时魔法 / 仪式魔法 / 禁忌魔法',
    );

    let embedCalls = 0;
    const written = await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    });
    expect(written).toBe(true);
    // Story 8.7 §3.2 dual vector: body + identity (setting_md is a long doc).
    expect(embedCalls).toBe(2);

    const entryId = settingEntryId(projectId, 'magic-system');
    const entry = db
      .prepare(
        'SELECT entry_id, project_id, entry_type, source_kind, name, body_text, content_hash, model, dim FROM closure_entry WHERE entry_id=?',
      )
      .get(entryId) as {
        entry_id: string; project_id: string; entry_type: string; source_kind: string;
        name: string; body_text: string; content_hash: string; model: string | null; dim: number | null;
      };
    // 🔑 entry_id is namespaced `${projectId}:${settingId}` (NOT raw settingId) -
    // avoids the cross-project PK collision risk Story 2.7's raw card.id has.
    expect(entry.entry_id).toBe(`${projectId}:magic-system`);
    expect(entry.project_id).toBe(projectId);
    expect(entry.entry_type).toBe('magic_system');
    expect(entry.source_kind).toBe(SETTING_MD_SOURCE_KIND);
    expect(entry.source_kind).toBe('setting_md');
    expect(entry.name).toBe('魔法体系');
    expect(entry.body_text).toContain('即时魔法');
    expect(entry.content_hash.length).toBe(64); // sha256 hex
    expect(entry.model).toBe('text-embedding-3-test');
    expect(entry.dim).toBe(EMBED_DIM);

    // entry_fts MATCH finds a body term (proves AFTER INSERT trigger). The
    // trigram tokenizer needs a 3+ char query (mirror closureCraftIndexer test).
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('即时魔法') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain(entryId);

    if (vecAvailable) {
      const rows = db
        .prepare(
          `SELECT entry_id, distance FROM entry_vec WHERE project_id = ? AND embedding MATCH ? AND k = 1 ORDER BY distance`,
        )
        .all(projectId, floatArrayToBuffer(vec1024())) as { entry_id: string; distance: number }[];
      expect(rows.map((r) => r.entry_id)).toContain(entryId);
    }
  });

  it('projectId is the REGISTRY id (query_story namespace), a 5-digit zero-padded string', async () => {
    const db = getDb();
    const projectDir = seedProject();
    const filePath = writeSettingDoc(projectDir, 'faction.md', 'id: faction-bg\ntype: faction', '# 势力\n罗德岛');
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => null, // FTS-only, no embed needed for this assertion
      embed: async () => vec1024(),
    });
    const row = db
      .prepare('SELECT project_id FROM closure_entry WHERE entry_id=?')
      .get(settingEntryId(getProject(path.resolve(projectDir))!.projectId, 'faction-bg')) as { project_id: string };
    // Registry project_id is a 5-digit zero-padded string (mirror assetCardsIndexer
    // namespace test). This is the namespace query_story / reindexAsset use.
    expect(row.project_id).toMatch(/^\d{5}$/);
  });

  it('content-hash skip: unchanged doc does not re-embed', async () => {
    const projectDir = seedProject();
    const filePath = writeSettingDoc(projectDir, 'lore.md', 'id: lore-bg\ntype: lore', '# 传说\n古老神话');
    let embedCalls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    };
    expect(await reindexSettingMd(projectDir, filePath, deps)).toBe(true);
    expect(embedCalls).toBe(2); // body + identity (Story 8.7 dual vector)
    expect(await reindexSettingMd(projectDir, filePath, deps)).toBe(false); // unchanged -> skip
    expect(embedCalls).toBe(2);
  });

  it('CR-craft-kb-005 (mirrored): a frontmatter-only edit (type reclassify) triggers reindex', async () => {
    const projectDir = seedProject();
    const filePath = writeSettingDoc(projectDir, 'reclassify.md', 'id: reclassify\ntype: magic_system', '# Reclassify\nsame body');
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    };
    await reindexSettingMd(projectDir, filePath, deps);
    const db = getDb();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    let row = db
      .prepare('SELECT entry_type FROM closure_entry WHERE entry_id=?')
      .get(settingEntryId(projectId, 'reclassify')) as { entry_type: string };
    expect(row.entry_type).toBe('magic_system');

    // Edit ONLY the frontmatter (type -> faction), body unchanged.
    writeFileSync(
      filePath,
      '---\nid: reclassify\ntype: faction\n---\n# Reclassify\nsame body',
      'utf-8',
    );

    await reindexSettingMd(projectDir, filePath, deps);

    // The hash now includes frontmatter, so the frontmatter-only edit reindexes
    // (previously a body-only hash would skip -> stale entry_type=magic_system).
    row = db
      .prepare('SELECT entry_type FROM closure_entry WHERE entry_id=?')
      .get(settingEntryId(projectId, 'reclassify')) as { entry_type: string };
    expect(row.entry_type).toBe('faction');
  });

  it('no model -> FTS-only (closure_entry + fts present, vec absent, pending_embed)', async () => {
    const db = getDb();
    const projectDir = seedProject();
    const filePath = writeSettingDoc(projectDir, 'rule.md', 'id: world-rule\ntype: world_rule', '# 世界规则\n魔法守恒律');
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => null,
      embed: async () => vec1024(), // must NOT be called
    });
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const entry = db
      .prepare('SELECT model, dim, content_hash FROM closure_entry WHERE entry_id=?')
      .get(settingEntryId(projectId, 'world-rule')) as { model: string | null; dim: number | null; content_hash: string | null };
    expect(entry.model).toBeNull();
    expect(entry.dim).toBeNull();
    expect(entry.content_hash).toBeNull(); // pending_embed
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('魔法守恒律') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain(settingEntryId(projectId, 'world-rule'));
  });

  it('embed failure -> FTS-only (pending_embed, no throw)', async () => {
    const projectDir = seedProject();
    const filePath = writeSettingDoc(projectDir, 'location.md', 'id: loc-lore\ntype: location_lore', '# 地点\n龙门城');
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => stubModel(),
      embed: async () => {
        throw new Error('network down');
      },
    });
    const db = getDb();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const entry = db
      .prepare('SELECT model, content_hash FROM closure_entry WHERE entry_id=?')
      .get(settingEntryId(projectId, 'loc-lore')) as { model: string | null; content_hash: string | null };
    expect(entry.model).toBeNull();
    expect(entry.content_hash).toBeNull();
  });

  it('reindexSettingMdDelete clears closure_entry + fts (+ vec)', async () => {
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(projectDir, 'char-extra.md', 'id: char-extra\ntype: character_extra', '# 角色补充\n背景故事');
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    const entryId = settingEntryId(projectId, 'char-extra');
    expect(db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get(entryId)).toBeDefined();

    reindexSettingMdDelete(projectId, 'char-extra');

    expect(db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get(entryId)).toBeUndefined();
    const ftsHits = db
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('背景故事') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).not.toContain(entryId);
    if (vecAvailable) {
      const vecRows = db
        .prepare('SELECT entry_id FROM entry_vec WHERE entry_id=?')
        .all(entryId) as { entry_id: string }[];
      expect(vecRows).toHaveLength(0);
    }
  });

  it('reindexSettingMd on a missing file throws ENOENT (file source, not table -> no silent delete delegation)', async () => {
    // Mirror closureCraftIndexer: reindexSettingMd reads a FILE -> a missing file
    // throws. Orphan cleanup is the SCAN's job (reindexAllSettingMd, tested below),
    // the correct layering for a file-sourced index.
    const projectDir = seedProject();
    const filePath = writeSettingDoc(projectDir, 'temp.md', 'id: temp-doc\ntype: world_rule', '# Temp\nbody');
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    rmSync(filePath, { force: true });
    await expect(
      reindexSettingMd(projectDir, filePath, {
        resolveModel: () => stubModel(),
        embed: async () => vec1024(),
      }),
    ).rejects.toThrow();
  });

  it('reindexAllSettingMd: scans settings dir, reindexes new docs, deletes orphans', async () => {
    const db = getDb();
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;

    // Seed an orphan (indexed but no file on disk).
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text) VALUES (?, ?, 'world_rule', 'setting_md', 'orphan', 'orphan body')`,
    ).run(settingEntryId(projectId, 'orphan-doc'), projectId);

    // Write two real docs.
    writeSettingDoc(projectDir, 'magic-a.md', 'id: magic-a\ntype: magic_system', '# 魔法A\n即时魔法体系');
    writeSettingDoc(projectDir, 'faction-a.md', 'id: faction-a\ntype: faction', '# 势力A\n组织背景');

    const { reindexed, orphaned } = await reindexAllSettingMd(projectDir, {
      resolveModel: () => null, // FTS-only
      embed: async () => vec1024(),
    });
    expect(reindexed).toBe(2);
    expect(orphaned).toBe(1);

    // Orphan deleted.
    expect(
      db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get(settingEntryId(projectId, 'orphan-doc')),
    ).toBeUndefined();
    // New docs indexed.
    expect(
      db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get(settingEntryId(projectId, 'magic-a')),
    ).toBeDefined();
    expect(
      db.prepare('SELECT entry_id FROM closure_entry WHERE entry_id=?').get(settingEntryId(projectId, 'faction-a')),
    ).toBeDefined();
  });

  it('orphan cleanup does not touch project_assets (asset_card) or asset_cards (setting_card) rows', async () => {
    const db = getDb();
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    writeSettingDoc(projectDir, 'keep.md', 'id: keep-doc\ntype: magic_system', '# Keep\nbody');

    // Insert a project_assets-derived row (source_kind='asset_card') + an
    // asset_cards-derived row (source_kind='setting_card') manually to simulate
    // coexistence in the shared closure_entry table.
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text) VALUES (?, ?, 'character', 'asset_card', 'proj-asset', 'should survive')`,
    ).run('proj-asset-Y', projectId);
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text) VALUES (?, ?, 'character', 'setting_card', 'card-row', 'should survive too')`,
    ).run('card-row-Z', projectId);

    await reindexAllSettingMd(projectDir, { resolveModel: () => null, embed: async () => vec1024() });

    // Both non-setting_md rows survive - orphan cleanup only touches source_kind='setting_md'.
    const survivorA = db
      .prepare('SELECT source_kind FROM closure_entry WHERE entry_id=?')
      .get('proj-asset-Y') as { source_kind: string };
    expect(survivorA.source_kind).toBe('asset_card');
    const survivorB = db
      .prepare('SELECT source_kind FROM closure_entry WHERE entry_id=?')
      .get('card-row-Z') as { source_kind: string };
    expect(survivorB.source_kind).toBe('setting_card');
  });

  it('F9 (mirrored): entry_id colliding with a non-setting_md row is skipped, not clobbered', async () => {
    const db = getDb();
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    // A setting doc whose namespaced entry_id happens to match a pre-existing
    // project_assets row (simulated). Without the F9 guard, the setting upsert's
    // ON CONFLICT would flip source_kind to 'setting_md' + overwrite the body.
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, source_kind, name, body_text) VALUES (?, ?, 'character', 'asset_card', 'file-asset', 'file-asset-body')`,
    ).run(settingEntryId(projectId, 'collide-id'), projectId);

    const filePath = writeSettingDoc(projectDir, 'collide.md', 'id: collide-id\ntype: magic_system', '# Collide\nsetting body');
    const written = await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => null,
      embed: async () => vec1024(),
    });
    expect(written).toBe(false); // skipped, not clobbered
    const row = db
      .prepare('SELECT source_kind, body_text FROM closure_entry WHERE entry_id=?')
      .get(settingEntryId(projectId, 'collide-id')) as { source_kind: string; body_text: string };
    // source_kind stays 'asset_card' (NOT clobbered to 'setting_md').
    expect(row.source_kind).toBe('asset_card');
    // body_text stays the file-asset body (NOT overwritten with the setting body).
    expect(row.body_text).toBe('file-asset-body');
  });

  it('unregistered project (no registry row) -> no-op, never throws', async () => {
    // Create a project dir with a settings doc but do NOT call ensureProject.
    // getProject(path) returns undefined -> reindexSettingMd / reindexAllSettingMd
    // skip (docs would be unqueryable without a registry id).
    const unregisteredDir = path.join(TEST_HOME, 'unregistered');
    mkdirSync(unregisteredDir, { recursive: true });
    writeSettingDoc(unregisteredDir, 'ghost.md', 'id: ghost-doc\ntype: magic_system', '# Ghost\nbody');

    await expect(
      reindexSettingMd(unregisteredDir, path.join(unregisteredDir, 'settings', 'ghost.md'), {
        resolveModel: () => null,
        embed: async () => vec1024(),
      }),
    ).resolves.toBe(false);
    await expect(
      reindexAllSettingMd(unregisteredDir, { resolveModel: () => null, embed: async () => vec1024() }),
    ).resolves.toEqual({ reindexed: 0, orphaned: 0 });
  });

  // ── F1 (mirrored): reindexed counts only actual writes; hash-skip no-op NOT counted ──
  it('F1: first call reindexed===doc count; second (hash-skip) reindexed===0; force reindexed===full', async () => {
    const projectDir = seedProject();
    writeSettingDoc(projectDir, 'f1.md', 'id: f1-doc\ntype: magic_system', '# F1\nbody');
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    };
    // First call: doc has no prior hash -> written -> reindexed=1.
    const r1 = await reindexAllSettingMd(projectDir, deps);
    expect(r1.reindexed).toBe(1);
    // Second call WITHOUT force: body unchanged -> hash-skip no-op -> reindexed=0.
    const r2 = await reindexAllSettingMd(projectDir, deps);
    expect(r2.reindexed).toBe(0);
    // Third call WITH force: bypasses hash-skip -> re-embedded -> reindexed=1 (full).
    const r3 = await reindexAllSettingMd(projectDir, { ...deps, force: true });
    expect(r3.reindexed).toBe(1);
  });

  // ── F5 (mirrored): concurrent reindexAllSettingMd on the same project serialize ──
  it('F5: concurrent reindexAllSettingMd on the same project serialize (embed calls do not overlap)', async () => {
    const projectDir = seedProject();
    writeSettingDoc(projectDir, 'ser-a.md', 'id: ser-a\ntype: magic_system', '# A\nbody');
    writeSettingDoc(projectDir, 'ser-b.md', 'id: ser-b\ntype: faction', '# B\nbody');
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
      reindexAllSettingMd(projectDir, { ...deps, force: true }),
      reindexAllSettingMd(projectDir, { ...deps, force: true }),
    ]);
    // Serialized: no overlapping embed calls (also honors the API-concurrency guard).
    expect(maxConcurrent).toBe(1);
  });

  it('settingEntryId namespaces `${projectId}:${settingId}` (avoids 2.7 raw-id cross-project collision)', () => {
    expect(settingEntryId('00001', 'magic-system')).toBe('00001:magic-system');
    expect(settingEntryId('00002', 'magic-system')).toBe('00002:magic-system');
    // Two projects' same-named doc get distinct entry_ids (the whole point of
    // namespacing - Story 2.7's raw card.id would collide here).
    expect(settingEntryId('00001', 'magic-system')).not.toBe(settingEntryId('00002', 'magic-system'));
  });
});

// ── Story 8.7 S4：简述三态 + hashPayload 扩 + 双向量 + linked_entities 关系物化 ──
describe.skipIf(!sqliteUsable)('settingMdIndexer Story 8.7 S4 (summary layer / dual vector / setting_link)', () => {
  beforeAll(clean);
  afterAll(clean);
  beforeEach(cleanSettingsDir);

  /** Persist a project.yaml with asset_cards so buildCardLookup can resolve
   *  linked_entities refs (mirror assetCardsIndexer.test seedProject). */
  async function seedCards(cards: unknown[]): Promise<string> {
    const { saveProject } = await import('@orison/desktop-local-bff');
    mkdirSync(PROJECT_DIR, { recursive: true });
    const now = new Date().toISOString();
    saveProject(PROJECT_DIR, {
      meta: { id: 'uuid-test', name: 'Test', type: 'novel', version: 1, created_at: now, updated_at: now },
      storyboard: { shots: [] },
      asset_cards: cards as never,
    } as never);
    ensureProject({
      name: 'Test',
      type: 'novel',
      localFingerprint: path.resolve(PROJECT_DIR),
      path: path.resolve(PROJECT_DIR),
    });
    return PROJECT_DIR;
  }

  function summaryRow(entryId: string): {
    summary_text: string | null; summary_source: string | null; summary_hash: string | null;
  } {
    return getDb()
      .prepare('SELECT summary_text, summary_source, summary_hash FROM closure_entry WHERE entry_id=?')
      .get(entryId) as { summary_text: string | null; summary_source: string | null; summary_hash: string | null };
  }

  it('summary state 1 (curated): frontmatter summary wins, no LLM call, hash recorded', async () => {
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(
      projectDir,
      'curated.md',
      'id: curated-doc\ntype: magic_system\nsummary: 以代价驱动的硬魔法体系',
      '# 魔法体系\n咏唱需要等价交换',
    );
    let summaryCalls = 0;
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => null,
      resolveSummaryModel: () => stubSummaryModel(),
      generateSummary: async () => {
        summaryCalls++;
        return '不该被调用的生成简述';
      },
    });
    expect(summaryCalls).toBe(0); // curated value wins outright
    const row = summaryRow(settingEntryId(projectId, 'curated-doc'));
    expect(row.summary_text).toBe('以代价驱动的硬魔法体系');
    expect(row.summary_source).toBe('curated');
    expect(row.summary_hash).toHaveLength(64); // body fingerprint recorded (unified change detection)
    expect(row.summary_hash).toBe(createHash('sha256').update('# 魔法体系\n咏唱需要等价交换').digest('hex'));
  });

  it('summary state 2 (generated + fingerprint cache): generates once; type-only edit reuses without a second LLM call', async () => {
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(projectDir, 'gen.md', 'id: gen-doc\ntype: magic_system', '# 魔法体系\n塔罗体系详解');
    let summaryCalls = 0;
    const deps = {
      resolveModel: () => null,
      resolveSummaryModel: () => stubSummaryModel(),
      generateSummary: async () => {
        summaryCalls++;
        return '这是生成的简述';
      },
    };
    await reindexSettingMd(projectDir, filePath, deps);
    expect(summaryCalls).toBe(1);
    let row = summaryRow(settingEntryId(projectId, 'gen-doc'));
    expect(row.summary_text).toBe('这是生成的简述');
    expect(row.summary_source).toBe('generated');
    expect(row.summary_hash).toHaveLength(64);

    // Type-only frontmatter edit (body unchanged) -> reindex proceeds (type is
    // in the hash), but the summary fingerprint cache hits -> NO second LLM call
    // + the generated summary is carried over (not lost to nulls).
    writeFileSync(filePath, '---\nid: gen-doc\ntype: faction\n---\n# 魔法体系\n塔罗体系详解', 'utf-8');
    await reindexSettingMd(projectDir, filePath, deps);
    expect(summaryCalls).toBe(1); // fingerprint cache
    row = summaryRow(settingEntryId(projectId, 'gen-doc'));
    expect(row.summary_text).toBe('这是生成的简述');
    expect(row.summary_source).toBe('generated');
  });

  it('summary state 3 (no model): columns stay empty, retrieval unaffected (graceful)', async () => {
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(projectDir, 'nomodel.md', 'id: nomodel-doc\ntype: lore', '# 传说\n远古纪元');
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => null,
      resolveSummaryModel: () => null,
    });
    const row = summaryRow(settingEntryId(projectId, 'nomodel-doc'));
    expect(row.summary_text).toBeNull();
    expect(row.summary_source).toBeNull();
    expect(row.summary_hash).toBeNull();
    // The doc itself still indexed (FTS works).
    const ftsHits = getDb()
      .prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ?')
      .all('远古纪元') as { entry_id: string }[];
    expect(ftsHits.map((h) => h.entry_id)).toContain(settingEntryId(projectId, 'nomodel-doc'));
  });

  it('hashPayload 扩（summary）: a curated-summary-only edit reindexes (no stale summary_text)', async () => {
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(
      projectDir,
      'sumedit.md',
      'id: sumedit\ntype: magic_system\nsummary: 旧简述',
      '# Body\nsame body',
    );
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    expect(summaryRow(settingEntryId(projectId, 'sumedit')).summary_text).toBe('旧简述');

    // Edit ONLY the frontmatter summary; body unchanged.
    writeFileSync(filePath, '---\nid: sumedit\ntype: magic_system\nsummary: 新简述\n---\n# Body\nsame body', 'utf-8');
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    expect(summaryRow(settingEntryId(projectId, 'sumedit')).summary_text).toBe('新简述');
  });

  it('dual vector: long doc writes #body + #identity rows with vector_kind + entry_id backfill + composition', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(
      projectDir,
      'dualvec.md',
      'id: dualvec\ntype: magic_system\nsummary: 简述值',
      '# 魔法体系\n即时魔法',
    );
    const embedInputs: string[] = [];
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => stubModel(),
      embed: async (_m, input) => {
        embedInputs.push(input);
        return vec1024();
      },
    });
    const entryId = settingEntryId(projectId, 'dualvec');
    const rows = db
      .prepare('SELECT vector_id, entry_id, vector_kind, status, visibility FROM entry_vec WHERE entry_id=?')
      .all(entryId) as {
      vector_id: string;
      entry_id: string;
      vector_kind: string;
      status: string;
      visibility: string;
    }[];
    expect(rows.map((r) => r.vector_id).sort()).toEqual([`${entryId}#body`, `${entryId}#identity`]);
    expect(rows.every((r) => r.vector_kind === 'body' || r.vector_kind === 'identity')).toBe(true);
    expect(new Set(rows.map((r) => r.vector_kind))).toEqual(new Set(['body', 'identity']));
    // Story 8.3 CR-005: metadata columns mirror the closure_entry values —
    // setting_md rows carry NO status, so both rows get the '' sentinel (vec0
    // rejects NULL; '' never matches a concrete status filter, same rows the
    // closure_entry belt drops); visibility mirrors the 'known' literal.
    expect(rows.every((r) => r.status === '' && r.visibility === 'known')).toBe(true);

    // Composition: first embed = full body; second embed = identity (name +
    // entry_type + summary_text, design §1.3).
    expect(embedInputs[0]).toBe('# 魔法体系\n即时魔法');
    expect(embedInputs[1]).toBe(['魔法体系', 'magic_system', '简述值'].join('\n'));
  });

  it('dual vector: without a summary the identity vector degrades to name+type (never skipped)', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const projectDir = seedProject();
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(projectDir, 'weaksid.md', 'id: weaksid\ntype: faction', '# 势力\n组织架构');
    const embedInputs: string[] = [];
    await reindexSettingMd(projectDir, filePath, {
      resolveModel: () => stubModel(),
      embed: async (_m, input) => {
        embedInputs.push(input);
        return vec1024();
      },
    });
    expect(embedInputs).toHaveLength(2); // weak identity vector still built
    expect(embedInputs[1]).toBe(['势力', 'faction'].join('\n'));
    const entryId = settingEntryId(projectId, 'weaksid');
    const rows = getDb()
      .prepare('SELECT vector_kind FROM entry_vec WHERE entry_id=?')
      .all(entryId) as { vector_kind: string }[];
    expect(rows.map((r) => r.vector_kind).sort()).toEqual(['body', 'identity']);
  });

  it('delete path removes BOTH vector rows and the doc\'s setting_link edges', async () => {
    const db = getDb();
    const projectDir = await seedCards([
      { id: 'card-del-1', type: 'character', name: '李玄' },
    ]);
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(
      projectDir,
      'delpath.md',
      'id: delpath\ntype: magic_system\nlinked_entities: [李玄]',
      '# Delete\nbody',
    );
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    const entryId = settingEntryId(projectId, 'delpath');
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM closure_relation WHERE src_entry_id=? AND source='setting_link'").get(entryId) as { n: number }).n,
    ).toBe(1);

    reindexSettingMdDelete(projectId, 'delpath');

    if (isSqliteVecAvailable()) {
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM entry_vec WHERE entry_id=?').get(entryId) as { n: number }).n,
      ).toBe(0);
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM closure_relation WHERE src_entry_id=? AND source='setting_link'").get(entryId) as { n: number }).n,
    ).toBe(0);
  });

  it('linked_entities materializes closure_relation edges (tolerant name/alias/id resolution, unresolved skipped)', async () => {
    const db = getDb();
    const projectDir = await seedCards([
      { id: 'card-a', type: 'character', name: '李玄', basics: { aliases: ['三师叔'] } },
      { id: 'card-b', type: 'character', name: '王五' },
    ]);
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(
      projectDir,
      'links.md',
      'id: links-doc\ntype: magic_system\nlinked_entities: [李玄, 三师叔, card-b, 鬼影]',
      '# Linked\nbody',
    );
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });

    const entryId = settingEntryId(projectId, 'links-doc');
    const rows = db
      .prepare("SELECT relation_id, tgt_entry_id, relation_type, source FROM closure_relation WHERE src_entry_id=? AND source='setting_link'")
      .all(entryId) as { relation_id: string; tgt_entry_id: string; relation_type: string; source: string }[];
    // 李玄 + 三师叔 dedupe to card-a; card-b via raw id; 鬼影 unresolved (warned + skipped).
    expect(rows.map((r) => r.tgt_entry_id).sort()).toEqual(['card-a', 'card-b']);
    expect(rows.every((r) => r.relation_type === 'setting_link' && r.source === 'setting_link')).toBe(true);
    expect(rows[0].relation_id).toContain('setting_link:');
  });

  it('setting_link orphan cleanup: removing a link from frontmatter drops its edge (per-doc replacement)', async () => {
    const db = getDb();
    const projectDir = await seedCards([
      { id: 'card-o1', type: 'character', name: '赵六' },
      { id: 'card-o2', type: 'character', name: '钱七' },
    ]);
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(
      projectDir,
      'orphanlink.md',
      'id: orphanlink\ntype: magic_system\nlinked_entities: [赵六, 钱七]',
      '# Orphan\nbody',
    );
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    const entryId = settingEntryId(projectId, 'orphanlink');
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM closure_relation WHERE src_entry_id=? AND source='setting_link'").get(entryId) as { n: number }).n,
    ).toBe(2);

    // Drop 钱七 from the frontmatter links.
    writeFileSync(
      filePath,
      '---\nid: orphanlink\ntype: magic_system\nlinked_entities: [赵六]\n---\n# Orphan\nbody',
      'utf-8',
    );
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    const rows = db
      .prepare("SELECT tgt_entry_id FROM closure_relation WHERE src_entry_id=? AND source='setting_link'")
      .all(entryId) as { tgt_entry_id: string }[];
    expect(rows.map((r) => r.tgt_entry_id)).toEqual(['card-o1']);
  });

  it('relation scope isolation: setting_md reindex never clears graph-source rows', async () => {
    const db = getDb();
    const projectDir = await seedCards([{ id: 'card-iso', type: 'character', name: '孙八' }]);
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    // A graph-indexer row (source='graph') for the same project.
    db.prepare(
      `INSERT INTO closure_relation (relation_id, project_id, src_entry_id, tgt_entry_id, relation_type, source)
       VALUES ('graph-e-iso', ?, 'card-iso', 'card-other', 'rivalry', 'graph')`,
    ).run(projectId);
    const filePath = writeSettingDoc(
      projectDir,
      'iso.md',
      'id: iso-doc\ntype: magic_system\nlinked_entities: [孙八]',
      '# Iso\nbody',
    );
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    // The setting_link edge landed AND the graph row survived untouched.
    const graphRow = db
      .prepare("SELECT tgt_entry_id, relation_type, source FROM closure_relation WHERE relation_id='graph-e-iso'")
      .get() as { tgt_entry_id: string; relation_type: string; source: string };
    expect(graphRow).toEqual({ tgt_entry_id: 'card-other', relation_type: 'rivalry', source: 'graph' });
    const linkRows = db
      .prepare("SELECT COUNT(*) AS n FROM closure_relation WHERE src_entry_id=? AND source='setting_link'")
      .get(settingEntryId(projectId, 'iso-doc')) as { n: number };
    expect(linkRows.n).toBe(1);
  });

  it('hashPayload 扩（linked_entities）: a links-only frontmatter edit reindexes (edges materialize)', async () => {
    const db = getDb();
    const projectDir = await seedCards([{ id: 'card-he', type: 'character', name: '周九' }]);
    const projectId = getProject(path.resolve(projectDir))!.projectId;
    const filePath = writeSettingDoc(projectDir, 'hashlink.md', 'id: hashlink\ntype: magic_system', '# Hash\nsame body');
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    const entryId = settingEntryId(projectId, 'hashlink');
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM closure_relation WHERE src_entry_id=? AND source='setting_link'").get(entryId) as { n: number }).n,
    ).toBe(0);

    // Add linked_entities with the body unchanged — without linked_entities in
    // the hashPayload this would hash-skip and the edges would never materialize.
    writeFileSync(
      filePath,
      '---\nid: hashlink\ntype: magic_system\nlinked_entities: [周九]\n---\n# Hash\nsame body',
      'utf-8',
    );
    await reindexSettingMd(projectDir, filePath, { resolveModel: () => null });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM closure_relation WHERE src_entry_id=? AND source='setting_link'").get(entryId) as { n: number }).n,
    ).toBe(1);
  });
});

// ── listSettingMdFiles scan-path unit tests (CR-craft-kb-002/003/007 mirrored) ──
// These cover the scan layer with NO DB dependency (listSettingMdFiles only reads
// the filesystem). Not gated on sqliteUsable for that reason.
describe('listSettingMdFiles scan path (Story 2.3)', () => {
  const SCAN_PROJECT = path.join(TEST_HOME, 'scan-test-project');

  beforeEach(() => {
    rmBestEffort(SCAN_PROJECT);
    mkdirSync(SCAN_PROJECT, { recursive: true });
  });
  afterEach(() => {
    rmBestEffort(SCAN_PROJECT);
  });

  it('recursively descends into subdirectories for .md docs', () => {
    const settingsDir = path.join(SCAN_PROJECT, 'settings');
    mkdirSync(path.join(settingsDir, 'magic', 'deep'), { recursive: true });
    writeFileSync(
      path.join(settingsDir, 'magic', 'deep', 'nested.md'),
      '---\nid: nested\n---\n# Nested',
      'utf-8',
    );
    writeFileSync(path.join(settingsDir, 'top.md'), '---\nid: top\n---\n# Top', 'utf-8');
    const ids = listSettingMdFiles(SCAN_PROJECT)
      .map((f) => f.settingId)
      .sort();
    expect(ids).toEqual(['nested', 'top']);
  });

  it('returns [] when the settings/ dir is absent (project with no long-form prose)', () => {
    // No settings/ dir created -> empty list (the common case).
    expect(listSettingMdFiles(SCAN_PROJECT)).toEqual([]);
  });

  it('skips a doc whose derived settingId is empty (`.md` filename)', () => {
    const settingsDir = path.join(SCAN_PROJECT, 'settings');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(path.join(settingsDir, '.md'), '---\ntype: x\n---\n# empty filename', 'utf-8');
    writeFileSync(path.join(settingsDir, 'real.md'), '---\nid: real\n---\n# Real', 'utf-8');
    const ids = listSettingMdFiles(SCAN_PROJECT).map((f) => f.settingId);
    expect(ids).toContain('real');
    expect(ids).not.toContain('');
  });

  it('returns projectDir + filePath for each doc (project-scoped, not global)', () => {
    const settingsDir = path.join(SCAN_PROJECT, 'settings');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(path.join(settingsDir, 'a.md'), '---\nid: a\n---\n# A', 'utf-8');
    const files = listSettingMdFiles(SCAN_PROJECT);
    expect(files).toHaveLength(1);
    expect(files[0].projectDir).toBe(SCAN_PROJECT);
    expect(files[0].filePath).toBe(path.join(settingsDir, 'a.md'));
    expect(files[0].settingId).toBe('a');
  });
});
