import { createHash } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-closure-craft-indexer');

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
  reindexCraftDoc,
  reindexCraftDelete,
  reindexAllCraft,
  scanAndReindexCraftKb,
  getCurrentCraftVecDim,
  EMBED_DIM,
} from '../main/db/closureCraftIndexer';
import { floatArrayToBuffer } from '../main/db/closureIndexer';
import { _setCraftKbUserDirForTest, listCraftMdFiles } from '../main/db/craftKbPaths';
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

const CRAFT_DIR = path.join(TEST_HOME, '.orison', 'craft-kb');

function writeCraftDoc(fileName: string, frontmatter: string, body: string): string {
  if (!existsSync(CRAFT_DIR)) mkdirSync(CRAFT_DIR, { recursive: true });
  const filePath = path.join(CRAFT_DIR, fileName);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, 'utf-8');
  return filePath;
}

describe.skipIf(!sqliteUsable)('closureCraftIndexer DB integration (Story 2.1)', () => {
  beforeAll(clean);
  afterAll(clean);

  it('reindexCraftDoc writes closure_craft_entry + closure_craft_fts + closure_craft_vec (no projectId)', async () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    const filePath = writeCraftDoc(
      'shuangdian.md',
      'id: shuangdian-catalog\ncraft_type: shuangdian\ntags: [爽点]\nsource: test',
      '# 爽点目录\n即时爽点 / 累积爽点 / 终极爽点',
    );

    let embedCalls = 0;
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    });

    // Story 8.7 §3.2 dual vector: body + identity (craft docs are long docs).
    expect(embedCalls).toBe(2);

    const entry = db
      .prepare('SELECT craft_id, craft_type, source_kind, name, body_text, tags, source, content_hash, model, dim FROM closure_craft_entry WHERE craft_id=?')
      .get('shuangdian-catalog') as {
        craft_id: string; craft_type: string; source_kind: string; name: string;
        body_text: string; tags: string | null; source: string | null;
        content_hash: string; model: string | null; dim: number | null;
      };
    expect(entry.craft_id).toBe('shuangdian-catalog');
    expect(entry.craft_type).toBe('shuangdian');
    expect(entry.source_kind).toBe('user');
    expect(entry.name).toBe('爽点目录');
    expect(entry.body_text).toContain('即时爽点');
    // CR-craft-kb-012: frontmatter tags (JSON array) + source are persisted.
    expect(JSON.parse(entry.tags ?? '[]')).toEqual(['爽点']);
    expect(entry.source).toBe('test');
    expect(entry.content_hash.length).toBe(64); // sha256 hex
    expect(entry.model).toBe('text-embedding-3-test');
    expect(entry.dim).toBe(EMBED_DIM);

    // closure_craft_fts MATCH finds a body term (proves AFTER INSERT trigger).
    // NOTE: the trigram tokenizer needs a 3+ char query (a 2-char CJK term like
    // '即时' yields no trigrams -> no match); VS1's closureIndexer test uses the
    // 6-char ASCII 'silent' for the same reason. Use the 4-char body term here.
    const ftsHits = db
      .prepare('SELECT craft_id FROM closure_craft_fts WHERE closure_craft_fts MATCH ?')
      .all('即时爽点') as { craft_id: string }[];
    expect(ftsHits.map((h) => h.craft_id)).toContain('shuangdian-catalog');

    if (vecAvailable) {
      const rows = db
        .prepare(
          `SELECT craft_id, distance FROM closure_craft_vec WHERE embedding MATCH ? AND k = 1 ORDER BY distance`,
        )
        .all(floatArrayToBuffer(vec1024())) as { craft_id: string; distance: number }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].craft_id).toBe('shuangdian-catalog');
    }
  });

  it('content-hash skip: unchanged body does not re-embed', async () => {
    const filePath = writeCraftDoc('jinzhi.md', 'id: jinzhi\ncraft_type: jinzhishao', '# 金手指\n七类八字段');
    let embedCalls = 0;
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vec1024();
      },
    };
    await reindexCraftDoc(filePath, 'user', deps);
    expect(embedCalls).toBe(2); // body + identity (Story 8.7 dual vector)
    await reindexCraftDoc(filePath, 'user', deps); // unchanged -> skip
    expect(embedCalls).toBe(2);
  });

  it('no model -> FTS-only (closure_craft_entry + fts present, vec absent, pending_embed)', async () => {
    const db = getDb();
    const filePath = writeCraftDoc('qiaoduan.md', 'id: qiaoduan\ncraft_type: qiaoduan', '# 桥段\nPolti36');
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => null,
      embed: async () => vec1024(), // must NOT be called
    });
    const entry = db
      .prepare('SELECT model, dim, content_hash FROM closure_craft_entry WHERE craft_id=?')
      .get('qiaoduan') as { model: string | null; dim: number | null; content_hash: string | null };
    expect(entry.model).toBeNull();
    expect(entry.dim).toBeNull();
    expect(entry.content_hash).toBeNull(); // pending_embed
    const ftsHits = db
      .prepare('SELECT craft_id FROM closure_craft_fts WHERE closure_craft_fts MATCH ?')
      .all('Polti36') as { craft_id: string }[];
    expect(ftsHits.map((h) => h.craft_id)).toContain('qiaoduan');
  });

  it('embed failure -> FTS-only (pending_embed, no throw)', async () => {
    const filePath = writeCraftDoc('jiezou.md', 'id: jiezou\ncraft_type: jiezou', '# 节奏\n黄金300字');
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async () => {
        throw new Error('network down');
      },
    });
    const db = getDb();
    const entry = db
      .prepare('SELECT model, content_hash FROM closure_craft_entry WHERE craft_id=?')
      .get('jiezou') as { model: string | null; content_hash: string | null };
    expect(entry.model).toBeNull();
    expect(entry.content_hash).toBeNull();
  });

  it('reindexCraftDelete clears closure_craft_entry + fts (+ vec)', async () => {
    const db = getDb();
    const vecAvailable = isSqliteVecAvailable();
    const filePath = writeCraftDoc('liliang.md', 'id: liliang\ncraft_type: liliang', '# 力量\n四范式');
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('liliang'),
    ).toBeDefined();

    reindexCraftDelete('liliang');

    expect(db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('liliang')).toBeUndefined();
    const ftsHits = db
      .prepare('SELECT craft_id FROM closure_craft_fts WHERE closure_craft_fts MATCH ?')
      .all('四范式') as { craft_id: string }[];
    expect(ftsHits.map((h) => h.craft_id)).not.toContain('liliang');
    if (vecAvailable) {
      const vecRows = db
        .prepare('SELECT craft_id FROM closure_craft_vec WHERE craft_id=?')
        .all('liliang') as { craft_id: string }[];
      expect(vecRows).toHaveLength(0);
    }
  });

  it('reindexCraftDoc on a missing file throws ENOENT (file source, not table -> no silent delete delegation)', async () => {
    // Unlike reindexAsset (table source -> missing row delegates to the delete
    // path), reindexCraftDoc reads a FILE -> a missing file throws. Orphan
    // cleanup is the SCAN's job (scanAndReindexCraftKb, tested below), which is
    // the correct layering for a file-sourced index.
    const filePath = writeCraftDoc('pattern.md', 'id: pattern\ncraft_type: pattern', '# Pattern\n六结构');
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    rmSync(filePath, { force: true });
    await expect(
      reindexCraftDoc(filePath, 'user', {
        resolveModel: () => stubModel(),
        embed: async () => vec1024(),
      }),
    ).rejects.toThrow();
  });

  it('scanAndReindexCraftKb: scans user dir, reindexes new docs, deletes orphans', async () => {
    _setCraftKbUserDirForTest(CRAFT_DIR);
    const db = getDb();

    // Seed an orphan (indexed but no file on disk).
    db.prepare(
      `INSERT INTO closure_craft_entry (craft_id, craft_type, source_kind, name, body_text) VALUES (?, ?, ?, ?, ?)`,
    ).run('orphan-doc', 'uncategorized', 'user', 'orphan', 'orphan body');

    // Write two real docs.
    writeCraftDoc('char-oc.md', 'id: char-oc\ncraft_type: character', '# 角色设计\n原型/弧模式');
    writeCraftDoc('playbook.md', 'id: playbook\ncraft_type: playbook', '# 题材\n都市/玄幻');

    await scanAndReindexCraftKb({
      resolveModel: () => null, // FTS-only
      embed: async () => vec1024(),
    });

    // Orphan deleted.
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('orphan-doc'),
    ).toBeUndefined();
    // New docs indexed.
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('char-oc'),
    ).toBeDefined();
    expect(
      db.prepare('SELECT craft_id FROM closure_craft_entry WHERE craft_id=?').get('playbook'),
    ).toBeDefined();
  });

  it('CR-craft-kb-005: a frontmatter-only edit (craft_type reclassify) triggers reindex', async () => {
    // First index with craft_type=shuangdian.
    const filePath = writeCraftDoc(
      'reclassify.md',
      'id: reclassify\ncraft_type: shuangdian',
      '# Reclassify\nsame body',
    );
    const deps = {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    };
    await reindexCraftDoc(filePath, 'user', deps);
    const db = getDb();
    let row = db
      .prepare('SELECT craft_type FROM closure_craft_entry WHERE craft_id=?')
      .get('reclassify') as { craft_type: string };
    expect(row.craft_type).toBe('shuangdian');

    // Edit ONLY the frontmatter (craft_type -> playbook), body unchanged.
    writeFileSync(
      filePath,
      '---\nid: reclassify\ncraft_type: playbook\n---\n# Reclassify\nsame body',
      'utf-8',
    );

    await reindexCraftDoc(filePath, 'user', deps);

    // The hash now includes frontmatter, so the frontmatter-only edit reindexes
    // (previously the body-only hash would skip -> stale craft_type=shuangdian).
    row = db
      .prepare('SELECT craft_type FROM closure_craft_entry WHERE craft_id=?')
      .get('reclassify') as { craft_type: string };
    expect(row.craft_type).toBe('playbook');
  });

  it('CR-craft-kb-009: an embed failure on an edited doc clears the stale vector', async () => {
    const vecAvailable = isSqliteVecAvailable();
    if (!vecAvailable) return; // vec0 gate: nothing to assert when vec unloaded

    const db = getDb();
    const filePath = writeCraftDoc('stalevec.md', 'id: stalevec\ncraft_type: qiaoduan', '# Stale\nbodyA');
    // First index: successful embed -> vec row present.
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(0),
    });
    let vecRows = db
      .prepare('SELECT craft_id FROM closure_craft_vec WHERE craft_id=?')
      .all('stalevec') as { craft_id: string }[];
    expect(vecRows).toHaveLength(2); // Story 8.7 dual vector (body + identity)

    // Edit the body, then reindex with a FAILING embed. The old vector (which
    // KNN-matches bodyA) must be cleared so it is not JOINed to the new bodyB.
    writeFileSync(filePath, '---\nid: stalevec\ncraft_type: qiaoduan\n---\n# Stale\nbodyB', 'utf-8');
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async () => {
        throw new Error('transient embed failure');
      },
    });

    vecRows = db
      .prepare('SELECT craft_id FROM closure_craft_vec WHERE craft_id=?')
      .all('stalevec') as { craft_id: string }[];
    expect(vecRows).toHaveLength(0); // stale vector cleared, not left dangling
  });

  it('CR-craft-kb-010: reindexAllCraft recreates a missing closure_craft_vec table', async () => {
    const vecAvailable = isSqliteVecAvailable();
    if (!vecAvailable) return; // vec0 gate: nothing to recreate when vec unloaded

    const db = getDb();
    _setCraftKbUserDirForTest(CRAFT_DIR);
    writeCraftDoc('missingvec.md', 'id: missingvec\ncraft_type: pattern', '# Missing\nbody');

    // DROP the vec table to simulate "absent while sqlite-vec IS loaded"
    // (previously reindexAllCraft would silently complete FTS-only in this state).
    db.exec('DROP TABLE IF EXISTS closure_craft_vec');

    const result = await reindexAllCraft({
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    expect(result.reindexed).toBeGreaterThanOrEqual(1);

    // The vec table was recreated at the probe dim -> the doc's vectors landed
    // (Story 8.7: BOTH vector kinds, proving the inline CREATE in
    // reindexAllCraft is the multi-vector DDL — a stale single-vector CREATE
    // here would flip-flop with initSchema and drop vectors).
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='closure_craft_vec'")
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('closure_craft_vec');
    const tableSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_craft_vec'").get() as
        { sql: string }
    ).sql;
    expect(tableSql).toContain('vector_id TEXT PRIMARY KEY');
    expect(tableSql).toContain('vector_kind');
    const vecRows = db
      .prepare('SELECT vector_id FROM closure_craft_vec WHERE craft_id=?')
      .all('missingvec') as { vector_id: string }[];
    expect(vecRows.map((r) => r.vector_id).sort()).toEqual(['missingvec#body', 'missingvec#identity']);
  });

  it('content-hash is stable for an unchanged body, sensitive to a change', () => {
    const hash = (body: string) => createHash('sha256').update(body).digest('hex');
    expect(hash('# 节奏\n黄金300字')).toBe(hash('# 节奏\n黄金300字'));
    expect(hash('# 节奏\n黄金300字')).not.toBe(hash('# 节奏\n黄金500字'));
  });
});

// ── Story 8.7 S4：简述三态 + hashPayload 扩（summary） + 双向量 ──
describe.skipIf(!sqliteUsable)('closureCraftIndexer Story 8.7 S4 (summary layer / dual vector)', () => {
  beforeAll(clean);
  afterAll(clean);

  function summaryRow(craftId: string): {
    summary_text: string | null; summary_source: string | null; summary_hash: string | null;
  } {
    return getDb()
      .prepare('SELECT summary_text, summary_source, summary_hash FROM closure_craft_entry WHERE craft_id=?')
      .get(craftId) as { summary_text: string | null; summary_source: string | null; summary_hash: string | null };
  }

  it('summary state 1 (curated): frontmatter summary wins, no LLM call', async () => {
    const filePath = writeCraftDoc(
      's7curated.md',
      'id: s7curated\ncraft_type: shuangdian\nsummary: 爽点先抑后扬的节奏手册',
      '# 爽点\n先抑后扬三段式',
    );
    let summaryCalls = 0;
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => null,
      resolveSummaryModel: () => stubSummaryModel(),
      generateSummary: async () => {
        summaryCalls++;
        return '不该被调用的生成简述';
      },
    });
    expect(summaryCalls).toBe(0);
    const row = summaryRow('s7curated');
    expect(row.summary_text).toBe('爽点先抑后扬的节奏手册');
    expect(row.summary_source).toBe('curated');
    expect(row.summary_hash).toHaveLength(64);
  });

  it('summary state 2 (generated + fingerprint cache): generates once; craft_type-only edit reuses without a second LLM call', async () => {
    const filePath = writeCraftDoc('s7gen.md', 'id: s7gen\ncraft_type: jinzhi', '# 金手指\n七类八字');
    let summaryCalls = 0;
    const deps = {
      resolveModel: () => null,
      resolveSummaryModel: () => stubSummaryModel(),
      generateSummary: async () => {
        summaryCalls++;
        return '金手指设计速查';
      },
    };
    await reindexCraftDoc(filePath, 'user', deps);
    expect(summaryCalls).toBe(1);
    let row = summaryRow('s7gen');
    expect(row.summary_text).toBe('金手指设计速查');
    expect(row.summary_source).toBe('generated');

    // craft_type-only edit (body unchanged) -> reindex proceeds, cache hits ->
    // no second LLM call + the generated summary carries over.
    writeFileSync(filePath, '---\nid: s7gen\ncraft_type: qiaoduan\n---\n# 金手指\n七类八字', 'utf-8');
    await reindexCraftDoc(filePath, 'user', deps);
    expect(summaryCalls).toBe(1);
    row = summaryRow('s7gen');
    expect(row.summary_text).toBe('金手指设计速查');
    expect(row.summary_source).toBe('generated');
  });

  it('summary state 3 (no model / generate failure): columns stay empty, retrieval unaffected (graceful)', async () => {
    const filePath = writeCraftDoc('s7nomodel.md', 'id: s7nomodel\ncraft_type: jiezou', '# 节奏\n黄金三百字');
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => null,
      resolveSummaryModel: () => null,
    });
    const row = summaryRow('s7nomodel');
    expect(row.summary_text).toBeNull();
    expect(row.summary_source).toBeNull();
    expect(row.summary_hash).toBeNull();
    const ftsHits = getDb()
      .prepare('SELECT craft_id FROM closure_craft_fts WHERE closure_craft_fts MATCH ?')
      .all('黄金三百字') as { craft_id: string }[];
    expect(ftsHits.map((h) => h.craft_id)).toContain('s7nomodel');

    // Generate FAILURE (not just no-model) also degrades to empty columns.
    const failPath = writeCraftDoc('s7fail.md', 'id: s7fail\ncraft_type: jiezou', '# 节奏\n卡点设计');
    await reindexCraftDoc(failPath, 'user', {
      resolveModel: () => null,
      resolveSummaryModel: () => stubSummaryModel(),
      generateSummary: async () => {
        throw new Error('summary endpoint down');
      },
    });
    const failRow = summaryRow('s7fail');
    expect(failRow.summary_text).toBeNull();
    expect(failRow.summary_source).toBeNull();
    expect(failRow.summary_hash).toBeNull();
  });

  it('hashPayload 扩（summary，S1 复核订正点）: a curated-summary-only edit reindexes (no stale summary_text)', async () => {
    // The craft hashPayload is a FIXED field list — without `summary` explicitly
    // added, a summary-only frontmatter edit would hash-skip and leave a stale
    // curated value (design §3.1 S1 correction note).
    const filePath = writeCraftDoc(
      's7sumedit.md',
      'id: s7sumedit\ncraft_type: pattern\nsummary: 旧手册简述',
      '# Pattern\nsame body',
    );
    await reindexCraftDoc(filePath, 'user', { resolveModel: () => null });
    expect(summaryRow('s7sumedit').summary_text).toBe('旧手册简述');

    writeFileSync(
      filePath,
      '---\nid: s7sumedit\ncraft_type: pattern\nsummary: 新手册简述\n---\n# Pattern\nsame body',
      'utf-8',
    );
    await reindexCraftDoc(filePath, 'user', { resolveModel: () => null });
    expect(summaryRow('s7sumedit').summary_text).toBe('新手册简述');
  });

  it('dual vector: craft writes #body + #identity rows with vector_kind + composition (name+craft_type+summary)', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    const filePath = writeCraftDoc(
      's7dual.md',
      'id: s7dual\ncraft_type: qiaoduan\nsummary: 双向量组料测试',
      '# 桥段\nPolti36 全解',
    );
    const embedInputs: string[] = [];
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async (_m, input) => {
        embedInputs.push(input);
        return vec1024();
      },
    });
    const rows = db
      .prepare('SELECT vector_id, craft_id, vector_kind FROM closure_craft_vec WHERE craft_id=?')
      .all('s7dual') as { vector_id: string; craft_id: string; vector_kind: string }[];
    expect(rows.map((r) => r.vector_id).sort()).toEqual(['s7dual#body', 's7dual#identity']);
    expect(new Set(rows.map((r) => r.vector_kind))).toEqual(new Set(['body', 'identity']));
    expect(rows.every((r) => r.craft_id === 's7dual')).toBe(true);

    // Composition: first embed = full body; second = identity (name +
    // craft_type + summary_text, design §1.3).
    expect(embedInputs[0]).toBe('# 桥段\nPolti36 全解');
    expect(embedInputs[1]).toBe(['桥段', 'qiaoduan', '双向量组料测试'].join('\n'));
  });

  it('dual vector: without a summary the identity vector degrades to name+craft_type (never skipped)', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const filePath = writeCraftDoc('s7weak.md', 'id: s7weak\ncraft_type: jinzhi', '# 金手指\n限制条款');
    const embedInputs: string[] = [];
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async (_m, input) => {
        embedInputs.push(input);
        return vec1024();
      },
    });
    expect(embedInputs).toHaveLength(2);
    expect(embedInputs[1]).toBe(['金手指', 'jinzhi'].join('\n'));
  });

  it('reindexCraftDelete clears BOTH vector rows', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    const filePath = writeCraftDoc('s7del.md', 'id: s7del\ncraft_type: qiaoduan', '# Delete\nbody');
    await reindexCraftDoc(filePath, 'user', {
      resolveModel: () => stubModel(),
      embed: async () => vec1024(),
    });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM closure_craft_vec WHERE craft_id=?').get('s7del') as { n: number }).n,
    ).toBe(2);

    reindexCraftDelete('s7del');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM closure_craft_vec WHERE craft_id=?').get('s7del') as { n: number }).n,
    ).toBe(0);
  });
});

// ── dogfood R4 F1：reindexAllCraft 结构维度自愈（无文件无卡也先修表再早退）──
// 事故形态：craft KB 零文档零卡，closure_craft_entry 里只有全局材料车道共栖的
// material_chunk 行；旧模型遗留维度（initSchema 缺省 float[1024]）遇上 4096 新模型——
// 旧实现的空库早退跳过整段结构重建，材料行重嵌永被维度门拒收，降级横幅常驻。
describe.skipIf(!sqliteUsable)('reindexAllCraft structural dim repair (dogfood R4 F1)', () => {
  beforeAll(clean);
  afterAll(clean);

  const MAT_CRAFT_ID = 'mat:mat-f067201a6b6a.ch0#c0';

  function vecOf(dim: number, slot = 0): number[] {
    const v = new Array(dim).fill(0);
    v[slot] = 1;
    return v;
  }

  /** 造一行「旧模型时代已落向量」的材料 chunk 行（model + content_hash 齐——清 hash UPDATE 的靶子）。 */
  function seedMaterialChunkRow(db: ReturnType<typeof getDb>): void {
    db.prepare(
      `INSERT INTO closure_craft_entry
         (craft_id, craft_type, source_kind, name, body_text, content_hash, model, dim)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(MAT_CRAFT_ID, 'uncategorized', 'material_chunk', '材料 chunk', '正文样例', 'a'.repeat(64), 'old-embed-1024', 1024);
  }

  function craftVecTableSql(db: ReturnType<typeof getDb>): string | undefined {
    return (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_craft_vec'").get() as
        | { sql: string }
        | undefined
    )?.sql;
  }

  it('无文件无卡 + 表维度不符 → 先重建表到探测维度再早退；清 hash UPDATE 连带材料 chunk 行', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    // 前置：craft KB 真空（bundled seeds 不存在的环境事实，显式钉住）；表在旧维度。
    expect(listCraftMdFiles()).toHaveLength(0);
    expect(getCurrentCraftVecDim(db)).toBe(1024);
    seedMaterialChunkRow(db);

    const result = await reindexAllCraft({
      resolveModel: () => stubModel(),
      embed: async () => vecOf(4096),
    });

    // 结构事件如实回报；reindexed 恒 0（无 craft 文档可枚举）。
    expect(result).toEqual({ reindexed: 0, dimChanged: true, newDim: 4096, cardsReembedded: 0 });
    // 表重建到探测维度 + 多向量 DDL 形态（内嵌 CREATE 与 initSchema 三处同步纪律）。
    const sql = craftVecTableSql(db)!;
    expect(sql).toContain('float[4096]');
    expect(sql).toContain('vector_id TEXT PRIMARY KEY');
    expect(sql).toContain('vector_kind');
    // 清 hash UPDATE 连带材料行：旧模型时代落过向量的行回到 pending（重嵌补回语义）。
    const row = db
      .prepare('SELECT content_hash, model FROM closure_craft_entry WHERE craft_id=?')
      .get(MAT_CRAFT_ID) as { content_hash: string | null; model: string };
    expect(row.content_hash).toBeNull();
    expect(row.model).toBe('old-embed-1024'); // 只清 hash，不动记账列
  });

  it('维度一致且表在 → 不重建零写零清（空库不空轮 DROP，历史返回形态原样）', async () => {
    if (!isSqliteVecAvailable()) return; // vec0 gate
    const db = getDb();
    expect(getCurrentCraftVecDim(db)).toBe(1024);
    seedMaterialChunkRow(db);
    const sqlBefore = craftVecTableSql(db);

    let embedCalls = 0;
    const result = await reindexAllCraft({
      resolveModel: () => stubModel(),
      embed: async () => {
        embedCalls++;
        return vecOf(1024);
      },
    });

    expect(result).toEqual({ reindexed: 0, dimChanged: false, newDim: null, cardsReembedded: 0 });
    // 探测照跑（维度一致性只能实测）——但表零重建、行零清。
    expect(embedCalls).toBe(1);
    expect(craftVecTableSql(db)).toBe(sqlBefore);
    const row = db
      .prepare('SELECT content_hash FROM closure_craft_entry WHERE craft_id=?')
      .get(MAT_CRAFT_ID) as { content_hash: string | null };
    expect(row.content_hash).toHaveLength(64);
  });
});

// ── listCraftMdFiles scan-path unit tests (CR-craft-kb-002/003/007) ──
// These cover the scan/dedup layer with NO DB dependency (listCraftMdFiles only
// reads the filesystem). Not gated on sqliteUsable for that reason.
describe('listCraftMdFiles scan path (CR-craft-kb-002/003/007)', () => {
  const SCAN_DIR = path.join(TEST_HOME, 'scan-test');

  beforeEach(() => {
    _setCraftKbUserDirForTest(SCAN_DIR);
    rmBestEffort(SCAN_DIR);
    mkdirSync(SCAN_DIR, { recursive: true });
  });
  afterEach(() => {
    _setCraftKbUserDirForTest(null);
    rmBestEffort(SCAN_DIR);
  });

  it('CR-craft-kb-003: recursively descends into subdirectories for .md docs', () => {
    mkdirSync(path.join(SCAN_DIR, 'shuangdian', 'deep'), { recursive: true });
    writeFileSync(
      path.join(SCAN_DIR, 'shuangdian', 'deep', 'nested.md'),
      '---\nid: nested\n---\n# Nested',
      'utf-8',
    );
    writeFileSync(path.join(SCAN_DIR, 'top.md'), '---\nid: top\n---\n# Top', 'utf-8');
    const ids = listCraftMdFiles()
      .map((f) => f.craftId)
      .sort();
    expect(ids).toEqual(['nested', 'top']);
  });

  it('CR-craft-kb-007: skips a doc whose derived craft_id is empty (`.md` filename)', () => {
    writeFileSync(path.join(SCAN_DIR, '.md'), '---\ncraft_type: x\n---\n# empty filename', 'utf-8');
    writeFileSync(path.join(SCAN_DIR, 'real.md'), '---\nid: real\n---\n# Real', 'utf-8');
    const ids = listCraftMdFiles().map((f) => f.craftId);
    expect(ids).toContain('real');
    expect(ids).not.toContain('');
  });

  it('CR-craft-kb-002: a user↔user craft_id collision keeps exactly one doc', () => {
    writeFileSync(path.join(SCAN_DIR, 'a.md'), '---\nid: collide\n---\n# A', 'utf-8');
    writeFileSync(path.join(SCAN_DIR, 'b.md'), '---\nid: collide\n---\n# B', 'utf-8');
    const colliding = listCraftMdFiles().filter((f) => f.craftId === 'collide');
    expect(colliding).toHaveLength(1);
  });
});
