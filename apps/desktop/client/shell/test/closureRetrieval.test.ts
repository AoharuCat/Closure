import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched. Distinct dir from the other suites so they never collide.
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-closure-retrieval');

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
  // modelGatewayIpc imports ipcMain at module load (only used inside
  // registerModelGatewayIpc, which the tests never call). Provide a no-op so
  // the import resolves without pulling in the real Electron runtime.
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

// Story 2.1: searchClosure now calls the shared rerank stage (rerankCandidates),
// whose default resolveRerankModel reads the on-disk ModelConfig. Mock
// modelGatewayIpc so the suite is HERMETIC: rerank defaults to null (skipped) ->
// the existing RRF-only assertions hold without depending on the dev machine's
// ~/.orison/model config. The rerank-available path is exercised explicitly in
// the "rerank stage" test below via the DI seam.
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called in this suite');
  },
}));

import {
  computeRrfScore,
  sanitizeFtsTerm,
  searchClosure,
  shouldRetryFtsOnly,
  RRF_K,
} from '../main/db/closureRetrieval';
import { buildRerankDoc } from '../main/db/closureRerank';
import { EMBED_DIM, floatArrayToBuffer } from '../main/db/closureIndexer';
import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';

// better-sqlite3 is a native addon rebuilt against Electron's ABI for the app;
// under plain-Node vitest its ABI may not match (NODE_MODULE_VERSION mismatch),
// so the SQL integration suite skips instead of failing the run (same gate as
// closureIndexer.test.ts / closureSchema.test.ts). The Electron one-shot smoke
// (throwaway, run under `electron`) is the runtime gate-G4 evidence.
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  // Close the handle first: Windows refuses to delete a locked db file.
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

// A stub ResolvedModel used by the DI seam. The stubbed `embed` below returns a
// chosen vector regardless of the model, so no network is ever hit.
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

// Unit 1024-dim vectors with a single nonzero slot. cosine distance ignores
// magnitude, so no explicit normalization is needed. Distinct slots -> the vec
// arm can target a specific entry.
function vecSlot(slot: number): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[slot] = 1.0;
  return v;
}
const VEC_A = vecSlot(0); // matches a query embedded to slot 0
const VEC_B = vecSlot(1); // matches a query embedded to slot 1
const VEC_C = vecSlot(2);

// ── Pure-logic unit tests (RUN under plain vitest, no DB) ──
describe('closureRetrieval pure logic (VS1 R4)', () => {
  describe('sanitizeFtsTerm', () => {
    it('wraps a clean query as a double-quoted phrase', () => {
      expect(sanitizeFtsTerm('texas ranger')).toBe('"texas ranger"');
      expect(sanitizeFtsTerm('德克萨斯')).toBe('"德克萨斯"');
    });

    it('returns null for empty / whitespace-only input', () => {
      expect(sanitizeFtsTerm('')).toBeNull();
      expect(sanitizeFtsTerm('   ')).toBeNull();
      expect(sanitizeFtsTerm('\t\n')).toBeNull();
    });

    it('strips FTS5-special chars so user input cannot inject query syntax', () => {
      // `"` would close the phrase early; `*` is a prefix glob; `:` is a column
      // filter. All stripped to spaces, then collapsed.
      expect(sanitizeFtsTerm('a"b*c:d')).toBe('"a b c d"');
      // A query of ONLY special chars sanitizes to empty -> null (vec-only path
      // in the both-arms logic).
      expect(sanitizeFtsTerm('""**::')).toBeNull();
      expect(sanitizeFtsTerm('*')).toBeNull();
    });

    it('collapses internal whitespace', () => {
      expect(sanitizeFtsTerm('texas   ranger\ttrail')).toBe('"texas ranger trail"');
    });
  });

  describe('computeRrfScore', () => {
    it('sums both arms when both ranks present (consensus > single-arm)', () => {
      const both = computeRrfScore(1, 1); // best in both arms
      const ftsOnly = computeRrfScore(1, null);
      const vecOnly = computeRrfScore(null, 1);
      expect(both).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1), 10);
      expect(ftsOnly).toBeCloseTo(1 / (RRF_K + 1), 10);
      expect(vecOnly).toBeCloseTo(1 / (RRF_K + 1), 10);
      // Consensus (both arms) beats a single-arm hit at the same rank.
      expect(both).toBeGreaterThan(ftsOnly);
      expect(both).toBeGreaterThan(vecOnly);
    });

    it('a better (lower) rank contributes more', () => {
      const first = computeRrfScore(1, null);
      const second = computeRrfScore(2, null);
      expect(first).toBeGreaterThan(second);
    });

    it('null ranks on both arms -> 0', () => {
      expect(computeRrfScore(null, null)).toBe(0);
    });

    it('honors custom k and weights', () => {
      const score = computeRrfScore(2, 3, 100, 0.5, 2.0);
      expect(score).toBeCloseTo(0.5 / (100 + 2) + 2.0 / (100 + 3), 10);
    });
  });

  describe('shouldRetryFtsOnly (CR-04 runtime vec failure)', () => {
    // The retry DECISION is pure (no DB), so it runs under plain vitest. The
    // retry EXECUTION lives in the DB path (skips on ABI mismatch); the
    // throwaway Electron smoke is the runtime evidence if ever needed.
    it('vec + fts (Case 1 failed) -> retry FTS-only to recover the FTS hits', () => {
      expect(shouldRetryFtsOnly(true, '"texas ranger"')).toBe(true);
    });

    it('vec-only (Case 3, no FTS arm) -> an FTS-only retry has nothing to run', () => {
      expect(shouldRetryFtsOnly(true, null)).toBe(false);
    });

    it('fts-only already failed (Case 2) -> retrying the same query throws identically', () => {
      expect(shouldRetryFtsOnly(false, '"texas ranger"')).toBe(false);
    });

    it('structured-only (Case 4, no arms) -> no FTS arm to retry', () => {
      expect(shouldRetryFtsOnly(false, null)).toBe(false);
    });
  });

  describe('buildRerankDoc (Story 8.7 rerank doc prefix)', () => {
    it('prefixes the 【name】summary header before the body', () => {
      expect(
        buildRerankDoc({ name: '李玄', summaryText: '青云峰大师兄', bodyText: '正文' }),
      ).toBe('【李玄】青云峰大师兄\n正文');
    });

    it('name only / summary only / neither degrade gracefully to the pre-8.7 body', () => {
      expect(buildRerankDoc({ name: '李玄', bodyText: '正文' })).toBe('【李玄】\n正文');
      expect(buildRerankDoc({ summaryText: '简述', bodyText: '正文' })).toBe('简述\n正文');
      expect(buildRerankDoc({ bodyText: '正文' })).toBe('正文');
    });
  });
});

// ── DB-integration tests (skip under plain vitest on ABI mismatch) ──
// Run under the Electron ABI (via the throwaway smoke) for the real gate-G4
// evidence. Here they exercise the conditional RRF SQL + DI seam with a STUBBED
// embed (known 1024-vector) so NO real endpoint is hit.
describe.skipIf(!sqliteUsable)('closureRetrieval DB integration (VS1 R4)', () => {
  // beforeEach (not beforeAll): tests reuse entry_id 'A'/'B'/... and several
  // assert an EXACT hit set (e.g. structured-only expects exactly its 2 entries).
  // A shared DB across tests accumulates rows and pollutes those assertions
  // (UNIQUE constraint on re-seed + stale hits). getDb() re-creates the data dir
  // + schema on the next call, so cleaning before every test gives each a fresh
  // derived index. (Story 2.1: also makes the new rerank-stage tests hermetic.)
  beforeEach(clean);
  afterAll(clean);

  // Story 8.7 multi-vector seeding (S5 fix for the S4 schema change): one
  // entry_vec row per vector — vector_id `${entryId}#${kind}` is the PK and the
  // vector_kind column carries the kind (mirror of the S4 indexers' write
  // shape). The positional `vec` defaults to the #body row; `opts.identityVec`
  // adds the #identity row (long-doc shape); `opts.vectorKind` retags the
  // positional vec for single-identity-row seeds (never combine with
  // identityVec). `opts.summaryText` / `opts.status` seed the 8.7 entry columns.
  function seedEntry(
    entryId: string,
    projectId: string,
    entryType: string,
    name: string,
    body: string,
    vec: number[] | null,
    opts?: {
      vectorKind?: 'body' | 'identity';
      identityVec?: number[] | null;
      summaryText?: string;
      status?: string;
    },
  ) {
    const db = getDb();
    db.prepare(
      `INSERT INTO closure_entry (entry_id, project_id, entry_type, name, body_text, summary_text, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entryId, projectId, entryType, name, body, opts?.summaryText ?? null, opts?.status ?? null);
    if (!isSqliteVecAvailable()) return;
    // Story 8.3: entry_vec carries the status/visibility metadata columns — they
    // are NOT optional in vec0 (omitting/NULL-ing a TEXT metadata column throws
    // "Expected text"), and the production indexers write the '' sentinel for a
    // NULL closure_entry status (same rows the final WHERE belt drops).
    const insertVec = db.prepare(
      `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'known', ?)`,
    );
    const vecStatus = opts?.status ?? '';
    if (vec) {
      const kind = opts?.vectorKind ?? 'body';
      insertVec.run(
        `${entryId}#${kind}`,
        projectId,
        entryId,
        entryType,
        'asset_card',
        kind,
        vecStatus,
        floatArrayToBuffer(vec),
      );
    }
    if (opts?.identityVec) {
      insertVec.run(
        `${entryId}#identity`,
        projectId,
        entryId,
        entryType,
        'asset_card',
        'identity',
        vecStatus,
        floatArrayToBuffer(opts.identityVec),
      );
    }
  }

  // Story 8.3 S4: chapter-source chunk row seeding (mirror of the S3 indexer's
  // write shape — source_kind='chapter', entry_type='chapter', span columns,
  // index_text FTS material, and ONE entry_vec row per chunk with
  // vector_kind='chunk' + the '' status sentinel for the NULL closure status).
  function seedChunk(
    projectId: string,
    chapterId: string,
    chunkIndex: number,
    opts: {
      chapterIndex?: number | null;
      name?: string;
      body?: string;
      indexText?: string | null;
      vec?: number[] | null;
      charStart?: number;
      charEnd?: number;
      paraStart?: number;
      paraEnd?: number;
    } = {},
  ) {
    const db = getDb();
    const entryId = `${projectId}:${chapterId}#c${chunkIndex}`;
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status,
          chapter_id, chapter_index, char_start, char_end, para_start, para_end, index_text)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
    ).run(
      entryId,
      projectId,
      'chapter',
      'chapter',
      opts.name ?? `第${(opts.chapterIndex ?? 0) + 1}章·段${chunkIndex + 1}`,
      opts.body ?? `第${chapterId}章正文段${chunkIndex + 1}`,
      'known',
      // 8 bound + NULL literal (status) + 6 bound = 15 columns; S10 discipline:
      // count them — entry_id/project_id/entry_type/source_kind/name/body_text/
      // visibility | status=NULL | chapter_id/chapter_index/char_start/char_end/
      // para_start/para_end/index_text.
      chapterId,
      opts.chapterIndex ?? 0,
      opts.charStart ?? 10 * chunkIndex,
      opts.charEnd ?? 10 * chunkIndex + 100,
      opts.paraStart ?? chunkIndex * 2,
      opts.paraEnd ?? chunkIndex * 2 + 2,
      opts.indexText ?? null,
    );
    if (!isSqliteVecAvailable() || !opts.vec) return;
    db.prepare(
      `INSERT INTO entry_vec (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      entryId,
      projectId,
      entryId,
      'chapter',
      'chapter',
      'chunk',
      '', // '' sentinel for the NULL closure_entry status (S1 probe contract)
      'known',
      floatArrayToBuffer(opts.vec),
    );
  }

  it('FTS-only path (no model): body-term query returns the matching entry, no vecDistance', async () => {
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    const pid = 'ret-fts';
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger\ntexas ranger silent hunter', VEC_A);
    seedEntry('B', pid, 'character', 'Scout', 'Scout\noregon trail', VEC_B);

    const hits = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => null, // offline: no embedding model -> vec arm skipped
      embed: async () => VEC_A, // must NOT be called when model is null
    });

    const ids = hits.map((h) => h.entryId);
    expect(ids).toContain('A'); // body contains "texas"
    expect(ids).not.toContain('B'); // body has no "texas"
    // Vec arm skipped -> no vecDistance on any hit; ftsRank present.
    const a = hits.find((h) => h.entryId === 'A')!;
    expect(a.vecDistance).toBeUndefined();
    expect(a.ftsRank).toBeDefined();
    // Parent-doc return: name + body_text present.
    expect(a.name).toBe('Ranger');
    expect(a.bodyText).toContain('texas ranger');
  });

  it('both-arms RRF: consensus hit ranks first, FTS and vec single-arm hits both present', async () => {
    const pid = 'ret-both';
    // A: FTS hit (body has "texas"), vec = VEC_A (orthogonal to query VEC_B).
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger\ntexas ranger silent hunter', VEC_A);
    // B: vec hit (vec = VEC_B = query), no "texas" in body.
    seedEntry('B', pid, 'character', 'Scout', 'Scout\noregon trail wanderer', VEC_B);
    // C: distractor (no "texas", vec = VEC_C orthogonal).
    seedEntry('C', pid, 'location', 'Stronghold', 'Stronghold\nmountain pass fortress', VEC_C);
    // D: consensus (body has "texas" AND vec = VEC_B = query).
    seedEntry('D', pid, 'character', 'Sentinel', 'Sentinel\ntexas consensus guard', VEC_B);

    const hits = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B, // query embeds to VEC_B -> vec arm hits B and D
    });

    expect(hits.length).toBeGreaterThan(0);
    // Consensus hit D ranks first (matches both arms -> highest RRF score).
    expect(hits[0].entryId).toBe('D');
    expect(hits[0].ftsRank).toBeDefined();
    expect(hits[0].vecDistance).toBeDefined();
    // D outranks the vec-only hit B and the FTS-hit A.
    const dScore = hits[0].score;
    const bHit = hits.find((h) => h.entryId === 'B');
    const aHit = hits.find((h) => h.entryId === 'A');
    expect(bHit).toBeDefined();
    expect(aHit).toBeDefined();
    expect(dScore).toBeGreaterThan(bHit!.score);
    expect(dScore).toBeGreaterThan(aHit!.score);
    // B is a vec hit (vecDistance present).
    expect(bHit!.vecDistance).toBeDefined();
    // A is an FTS hit (ftsRank present).
    expect(aHit!.ftsRank).toBeDefined();
  });

  it('entry_type filter excludes other types (applied in both arms + final WHERE)', async () => {
    const pid = 'ret-et';
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger\ntexas ranger', VEC_B);
    seedEntry('L', pid, 'location', 'Lone Star', 'Lone Star\ntexas location', VEC_B);

    // No filter: both A (character) and L (location) match "texas" via FTS.
    const noFilter = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(noFilter.map((h) => h.entryId).sort()).toEqual(['A', 'L']);

    // Filter to character: L (location) excluded by the final closure_entry
    // WHERE (and by the vec0 metadata filter when the vec arm runs).
    const charOnly = await searchClosure(pid, 'texas', { k: 10, entryType: 'character' }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(charOnly.map((h) => h.entryId)).toEqual(['A']);
    expect(charOnly.every((h) => h.entryType === 'character')).toBe(true);
  });

  it('vec-only path: special-char query sanitizes to null FTS, vec arm still returns hits', async () => {
    const pid = 'ret-vec';
    seedEntry('B', pid, 'character', 'Scout', 'Scout\noregon trail', VEC_B);
    seedEntry('C', pid, 'location', 'Stronghold', 'Stronghold\nmountain pass', VEC_C);

    // Query "*" -> query.trim() is "*" (truthy -> embed runs) but sanitizeFtsTerm
    // strips "*" -> null -> FTS arm skipped -> vec-only path.
    const hits = await searchClosure(pid, '*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    // Vec arm returns B (distance 0) and C (orthogonal, distance 1). B ranks
    // first. No ftsRank on any hit (FTS arm skipped).
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entryId).toBe('B');
    expect(hits[0].vecDistance).toBeDefined();
    expect(hits[0].ftsRank).toBeUndefined();
    expect(hits.every((h) => h.ftsRank === undefined)).toBe(true);
  });

  it('structured-only fallback: empty query + no model returns entries (score 0)', async () => {
    const pid = 'ret-struct';
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger\ntexas ranger', null);
    seedEntry('B', pid, 'character', 'Scout', 'Scout\noregon trail', null);

    const hits = await searchClosure(pid, '', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });

    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.score === 0)).toBe(true);
    expect(hits.every((h) => h.ftsRank === undefined && h.vecDistance === undefined)).toBe(true);
    // Parent fields still present.
    expect(hits.map((h) => h.name).sort()).toEqual(['Ranger', 'Scout']);
  });

  it('parent-doc return: hits carry closure_entry fields, not just ids', async () => {
    const pid = 'ret-parent';
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger\ntexas ranger silent hunter', VEC_A);

    const hits = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    const a = hits.find((h) => h.entryId === 'A')!;
    expect(a.projectId).toBe(pid);
    expect(a.entryType).toBe('character');
    expect(a.sourceKind).toBe('asset_card');
    expect(a.visibility).toBe('known');
    expect(a.name).toBe('Ranger');
    expect(a.bodyText).toBe('Ranger\ntexas ranger silent hunter');
  });

  // ── Story 2.1: shared rerank stage is ADDITIVE to searchClosure ──
  it('rerank stage re-orders RRF hits by rerankScore + attaches rerankScore (additive, EntryHit shape unchanged)', async () => {
    const pid = 'ret-rerank';
    // Two FTS hits for "texas"; RRF ranks D (consensus) above A.
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedEntry('D', pid, 'character', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const rerankModel = {
      keyId: 'k1',
      modelId: 'bge-reranker-stub',
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:0',
      apiKey: 'stub',
      capability: 'rerank' as const,
    };
    // Stub rerank: score A higher than D so the rerank stage flips the order.
    const rerankStub = async (_m: ResolvedModel, _q: string, docs: string[]) =>
      docs.map((d) => (d.includes('Ranger') ? 0.99 : 0.1));

    const hits = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => null, // FTS-only (no embed model) -> RRF surfaces A + D
      embed: async () => VEC_A,
      resolveRerankModel: () => rerankModel,
      rerank: rerankStub,
    });

    // RRF would rank D first (consensus), but rerank flips A to the top.
    expect(hits[0].entryId).toBe('A');
    expect(hits[0].rerankScore).toBe(0.99);
    expect(hits[1].entryId).toBe('D');
    expect(hits[1].rerankScore).toBe(0.1);
    // EntryHit shape unchanged: the pre-2.1 fields are still present.
    expect(hits[0].score).toBeDefined();
    expect(hits[0].ftsRank).toBeDefined();
  });

  it('rerank stage degrades to RRF order when rerank endpoint fails (additive, never blocks)', async () => {
    const pid = 'ret-rerank-fail';
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger\ntexas ranger', VEC_A);
    seedEntry('D', pid, 'character', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const rerankModel = {
      keyId: 'k1',
      modelId: 'bge-reranker-stub',
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:0',
      apiKey: 'stub',
      capability: 'rerank' as const,
    };

    const hits = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
      resolveRerankModel: () => rerankModel,
      rerank: async () => {
        throw new Error('rerank endpoint down');
      },
    });

    // Degrade: RRF order preserved, no rerankScore attached.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.rerankScore === undefined)).toBe(true);
  });

  // ── Story 8.7 S5: dual-vector retrieval + pre-filter extension ──

  it('dual-vector: identity-row hit passes vectorKind="identity" + summaryText; body-row hit "body"; both-hit entry dedupes to the nearer row', async () => {
    const pid = 'ret-dual';
    // IDOC: body vector orthogonal to the query, identity vector = query vec.
    seedEntry('IDOC', pid, 'setting', 'Magic Tower', 'Magic Tower\nancient tower lore', VEC_A, {
      identityVec: VEC_B,
      summaryText: '一座会吃人的高塔',
    });
    // BDOC: only a body vector matching the query (card-style single row).
    seedEntry('BDOC', pid, 'setting', 'Deep Well', 'Deep Well\nwell body', VEC_B);
    // BOTH: both rows in the KNN pool; the identity row is nearer (distance 0
    // vs 1) so it must win the kind AND the entry must surface exactly once.
    seedEntry('BOTH', pid, 'setting', 'Twin Shrine', 'Twin Shrine\nshrine body', VEC_C, {
      identityVec: VEC_B,
    });

    // '*' sanitizes to a null FTS term -> vec-only path, so every hit is a vec
    // hit with a defined kind (query embeds to VEC_B).
    const hits = await searchClosure(pid, '*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });

    expect(hits.length).toBeGreaterThanOrEqual(3);
    const idoc = hits.find((h) => h.entryId === 'IDOC')!;
    expect(idoc.vectorKind).toBe('identity');
    expect(idoc.summaryText).toBe('一座会吃人的高塔');
    const bdoc = hits.find((h) => h.entryId === 'BDOC')!;
    expect(bdoc.vectorKind).toBe('body');
    expect(bdoc.summaryText).toBeUndefined();
    // Dedupe: BOTH's two pool rows collapse into one hit carrying the NEARER
    // (identity) row's kind — one entry = one vec rank, no duplicate slots.
    const both = hits.filter((h) => h.entryId === 'BOTH');
    expect(both).toHaveLength(1);
    expect(both[0].vectorKind).toBe('identity');
    expect(both[0].vecDistance).toBeDefined();
  });

  it('rerank doc carries the 【name】summary header before the body (Story 8.7 identity aid)', async () => {
    const pid = 'ret-doc';
    seedEntry('A', pid, 'character', 'Ranger Tower', 'Ranger\ntexas ranger', VEC_A, {
      summaryText: '游侠的居所',
    });
    // Second FTS hit: the rerank stage early-returns on a 1-hit pool, so a
    // two-hit pool is needed for the doc build to actually run.
    seedEntry('D', pid, 'character', 'Sentinel', 'Sentinel\ntexas consensus', VEC_B);

    const rerankModel = {
      keyId: 'k1',
      modelId: 'bge-reranker-stub',
      protocol: 'openai-compatible' as const,
      baseUrl: 'http://localhost:0',
      apiKey: 'stub',
      capability: 'rerank' as const,
    };
    const seenDocs: string[] = [];
    const hits = await searchClosure(pid, 'texas', { k: 10 }, {
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
    // Exact doc shape: 【name】summary\nbody — the cross-encoder gets the
    // entry's identity before the body text. Docs are input-order aligned, so
    // both shapes are asserted.
    expect(seenDocs).toContain('【Ranger Tower】游侠的居所\nRanger\ntexas ranger');
    expect(seenDocs).toContain('【Sentinel】\nSentinel\ntexas consensus');
    // The hit's own bodyText is NOT mutated by the prefix (doc build is
    // per-call inside the rerank stage only).
    const a = hits.find((h) => h.entryId === 'A')!;
    expect(a.bodyText).toBe('Ranger\ntexas ranger');
  });

  it('status / visibility pre-filter: closure_entry WHERE (post-KNN belt); NULL status never matches', async () => {
    const pid = 'ret-status';
    seedEntry('D1', pid, 'character', 'Draftling', 'Draftling\ntexas draft', VEC_A, { status: 'draft' });
    seedEntry('A1', pid, 'character', 'Activeson', 'Activeson\ntexas active', VEC_B, { status: 'active' });
    // N1 seeds no status (long-doc-style row) — never matches a status filter.
    seedEntry('N1', pid, 'setting', 'Nulla Shrine', 'Nulla Shrine\ntexas null', VEC_A);

    // FTS arm, no filter: all three match "texas".
    const base = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(base.map((h) => h.entryId).sort()).toEqual(['A1', 'D1', 'N1']);

    // status filter (FTS arm): only the active row; NULL-status N1 excluded.
    const activeOnly = await searchClosure(pid, 'texas', { k: 10, status: 'active' }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(activeOnly.map((h) => h.entryId)).toEqual(['A1']);

    // status filter on the VEC arm too (post-KNN belt — status is not a vec0
    // metadata column, so it filters the JOINed closure_entry rows): '*' forces
    // vec-only; the query vec hits A1 (0) + D1/N1 (1), then status keeps A1.
    const vecActive = await searchClosure(pid, '*', { k: 10, status: 'active' }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });
    expect(vecActive.map((h) => h.entryId)).toEqual(['A1']);
    expect(vecActive[0].vectorKind).toBe('body');

    // visibility filter: seeds default to 'known' (schema default).
    const visKnown = await searchClosure(pid, 'texas', { k: 10, visibility: 'known' }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(visKnown.map((h) => h.entryId).sort()).toEqual(['A1', 'D1', 'N1']);
    const visSecret = await searchClosure(pid, 'texas', { k: 10, visibility: 'secret' }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(visSecret).toEqual([]);
  });

  // ── Story 8.3 CR-005 structural fix: status/visibility pre-prune INSIDE the vec0 KNN ──
  it('CR-005 structural fix: majority-deprecated project keeps surfacing the active entry (KNN pre-prune, not post-KNN starvation)', async () => {
    const pid = 'ret-veck';
    // 11 deprecated entries nearest to the query vec (VEC_A, cosine distance 0)
    // + 1 active entry at distance 1 (VEC_B). topN=5 -> candidateLimit=5 ->
    // vecK = topN*2 = 10 (the 8.7 x2/x4 compensation is RETIRED — k now counts
    // only net candidates because status prunes INSIDE the KNN via the vec0
    // metadata column). Pre-8.3 semantics (post-KNN belt, uncompensated
    // vecK=10 < 12 rows) would return 10 deprecated rows from the KNN, drop
    // them ALL in the final WHERE -> 0 hits. Structural fix: the 11 deprecated
    // rows never consume k, the active row IS the KNN pool -> surfaces.
    for (let i = 0; i < 11; i += 1) {
      seedEntry(`Dep${i}`, pid, 'character', `Deprecated ${i}`, `draft body ${i}`, VEC_A, { status: 'draft' });
    }
    seedEntry('Act0', pid, 'character', 'Active One', 'active body', VEC_B, { status: 'active' });

    // '*' sanitizes to a null FTS term -> Case 3 (vec-only): the vec arm alone
    // decides, isolating the pre-prune effect from any FTS rescue.
    const hits = await searchClosure(pid, '*', { k: 5, topN: 5, status: 'active' }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(hits.map((h) => h.entryId)).toEqual(['Act0']);
    expect(hits[0].vecDistance).toBeDefined(); // surfaced by the vec arm

    // Control: same project without the filter — the 11 nearer deprecated
    // entries crowd out the active one (k=5 keeps only the nearest 5). The
    // filtered query BEATING its own unfiltered baseline is the whole point:
    // filtering must lose nothing that is eligible, not merely rank it lower.
    const unfiltered = await searchClosure(pid, '*', { k: 5, topN: 5 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(unfiltered).toHaveLength(5);
    expect(unfiltered.every((h) => h.entryId.startsWith('Dep'))).toBe(true);
  });

  it('CR-005 pre-prune is INSIDE the KNN: deprecated rows beyond vecK cannot starve the active entry (post-KNN belt could not recover these)', async () => {
    const pid = 'ret-veck-deep';
    // 25 deprecated rows (> vecK = topN*2 = 10): under post-KNN-belt semantics
    // the KNN would return 10 deprecated rows (of 25), the status WHERE drops
    // all 10, and the active row NEVER entered the pool -> []. With the vec0
    // metadata pre-prune the KNN candidate set excludes the deprecated rows
    // entirely, so the active row is reachable regardless of depth.
    for (let i = 0; i < 25; i += 1) {
      seedEntry(`Dep${i}`, pid, 'character', `Deprecated ${i}`, `draft body ${i}`, VEC_A, { status: 'draft' });
    }
    seedEntry('Act0', pid, 'character', 'Active One', 'active body', VEC_B, { status: 'active' });

    const hits = await searchClosure(pid, '*', { k: 5, topN: 5, status: 'active' }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(hits.map((h) => h.entryId)).toEqual(['Act0']);
  });

  // ── Story 8.3 S4: chapter chunk rows through the retrieval pipeline ──

  it('chunk hits via the vec arm: span/chapterId passthrough + vectorKind="chunk" + per-chunk independence (same chapter, separate slots)', async () => {
    const pid = 'ret-chunk-vec';
    // One chapter, three chunks: two match the query vec (slots 0/1), one is
    // orthogonal (slot 2). A dual-vector CARD shares the pool to prove the
    // per-entry dedupe keeps BOTH semantics: card = one slot, chunks = one
    // slot EACH (design §2.4 — chunk entries own a single vector row).
    seedChunk(pid, 'ch_001', 0, { vec: VEC_A, charStart: 0, charEnd: 120, paraStart: 0, paraEnd: 2, chapterIndex: 3 });
    seedChunk(pid, 'ch_001', 1, { vec: VEC_B, charStart: 120, charEnd: 260, paraStart: 2, paraEnd: 5, chapterIndex: 3 });
    seedChunk(pid, 'ch_001', 2, { vec: VEC_C, charStart: 260, charEnd: 380, paraStart: 5, paraEnd: 7, chapterIndex: 3 });
    seedEntry('CARD', pid, 'character', 'Ranger', 'Ranger\ncard body', VEC_A, { identityVec: VEC_B });

    // '*' -> vec-only path; query embeds to VEC_A: hits chunk#0 + CARD (body
    // row VEC_A). Embedding to VEC_B in the same test: chunk#1 + CARD's
    // identity row. Both runs keep per-chunk and per-entry slots distinct.
    const byA = await searchClosure(pid, '*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(byA.map((h) => h.entryId)).toContain(`${pid}:ch_001#c0`);
    expect(byA.map((h) => h.entryId)).toContain('CARD'); // deduped to its #body row
    expect(byA.filter((h) => h.entryId === 'CARD')).toHaveLength(1);

    const byB = await searchClosure(pid, '*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });
    // chunk#1 surfaces as its own hit; CARD dedupes to the nearer identity row.
    const c1 = byB.find((h) => h.entryId === `${pid}:ch_001#c1`)!;
    expect(c1).toBeDefined();
    expect(c1.vectorKind).toBe('chunk');
    expect(c1.sourceKind).toBe('chapter');
    expect(c1.entryType).toBe('chapter');
    // Span passthrough (rowToHit 二态: chapter keys present, values from columns).
    expect(c1.chapterId).toBe('ch_001');
    expect(c1.chapterIndex).toBe(3);
    expect(c1.charStart).toBe(120);
    expect(c1.charEnd).toBe(260);
    expect(c1.paraStart).toBe(2);
    expect(c1.paraEnd).toBe(5);
    const card = byB.find((h) => h.entryId === 'CARD')!;
    expect(card.vectorKind).toBe('identity');
    // Non-chapter hit carries NO chapter keys (二态纪律).
    expect(card.chapterId).toBeUndefined();
    expect(card.paraStart).toBeUndefined();

    // Per-chunk independence: query near the chapter (slot 0 + 0.5 mixes) —
    // construct one by seeding an extra chunk of the SAME chapter near VEC_A
    // and querying VEC_A: two chunks of ch_001 must BOTH hold slots.
    seedChunk(pid, 'ch_001', 3, { vec: VEC_A, chapterIndex: 3 });
    const both = await searchClosure(pid, '*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    const chunkIds = both.filter((h) => h.sourceKind === 'chapter').map((h) => h.entryId);
    expect(chunkIds).toContain(`${pid}:ch_001#c0`);
    expect(chunkIds).toContain(`${pid}:ch_001#c3`);
    expect(chunkIds.filter((id) => id === `${pid}:ch_001#c0`)).toHaveLength(1);
  });

  it('chunk hits via the FTS arm: body substring + synopsis prefix word (contextual prefix FTS path)', async () => {
    const pid = 'ret-chunk-fts';
    // index_text = synopsis prefix + body (S3 indexer shape): a word that ONLY
    // exists in the synopsis must still surface the chunk (Anthropic-style
    // context material in the BM25 arm). Body-only word hits as usual.
    seedChunk(pid, 'ch_001', 0, {
      body: '雨下了整夜，当铺的木门被敲响三下，掌柜从柜台后抬起头。',
      indexText: '[梗概：祖传铁盒牵出旧年悬案]\n雨下了整夜，当铺的木门被敲响三下，掌柜从柜台后抬起头。',
      vec: null,
    });
    seedChunk(pid, 'ch_002', 0, {
      body: '完全无关的另一章正文，讲的是码头的风。',
      indexText: null, // 未带 prefix 的退化形态（synopsis 缺失章）
      vec: null,
    });

    const bodyHit = await searchClosure(pid, '敲响三下', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(bodyHit.map((h) => h.entryId)).toEqual([`${pid}:ch_001#c0`]);

    const prefixHit = await searchClosure(pid, '祖传铁盒', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(prefixHit.map((h) => h.entryId)).toEqual([`${pid}:ch_001#c0`]); // prefix-only word
    // The prefix word must NOT leak into the hit's returned text: bodyText is
    // the ORIGINAL prose (回答 LLM 看原文), never the index material.
    expect(prefixHit[0].bodyText).not.toContain('祖传铁盒');
  });

  it('status filter never matches chunk rows: "" sentinel (NULL closure status) excluded, visibility:"known" includes them', async () => {
    const pid = 'ret-chunk-status';
    seedChunk(pid, 'ch_001', 0, { vec: VEC_A });
    seedEntry('Act0', pid, 'character', 'Active One', 'active body', VEC_B, { status: 'active' });

    // status:'active' — chunk rows carry NULL closure status (vec0 '' sentinel):
    // they must be excluded in BOTH the KNN pre-prune and the closure belt.
    const activeOnly = await searchClosure(pid, '*', { k: 10, status: 'active' }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A, // nearer to the chunk — the filter must still drop it
    });
    expect(activeOnly.map((h) => h.entryId)).toEqual(['Act0']);

    // No filter: the chunk (distance 0) outranks Act0 (distance 1).
    const noFilter = await searchClosure(pid, '*', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(noFilter.map((h) => h.entryId)).toEqual([`${pid}:ch_001#c0`, 'Act0']);

    // visibility:'known' — chunks are always-written prose ('known' literal):
    // they match a visibility filter like any other visible entry.
    const visKnown = await searchClosure(pid, '*', { k: 10, visibility: 'known' }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_A,
    });
    expect(visKnown.map((h) => h.entryId)).toEqual([`${pid}:ch_001#c0`, 'Act0']);
  });

  it('both-arms + status filter (Case 1 × filter): active consensus hit carries BOTH ftsRank and vecDistance; deprecated dropped in both arms', async () => {
    const pid = 'ret-both-status';
    // A(active) + D(deprecated): identical two-arm shape (body term + query vec).
    seedEntry('A', pid, 'character', 'Activeson', 'texas consensus guard', VEC_B, { status: 'active' });
    seedEntry('D', pid, 'character', 'Deprecatotron', 'texas consensus guard too', VEC_B, { status: 'deprecated' });

    const hits = await searchClosure(pid, 'texas', { k: 10, status: 'active' }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
    });
    // Filter applied in BOTH arms: FTS surfaces only A (belt), vec KNN pool
    // holds only A's rows (pre-prune) -> single consensus hit.
    expect(hits.map((h) => h.entryId)).toEqual(['A']);
    expect(hits[0].ftsRank).toBeDefined();
    expect(hits[0].vecDistance).toBeDefined();
  });

  it('structured-only + entryType filter (Case 4 × filter): registry fallback respects the type filter', async () => {
    const pid = 'ret-struct-et';
    seedEntry('A', pid, 'character', 'Ranger', 'Ranger body', null);
    seedEntry('L', pid, 'location', 'Lone Star', 'Lone Star body', null);

    const locOnly = await searchClosure(pid, '', { k: 10, entryType: 'location' }, {
      resolveModel: () => null,
      embed: async () => VEC_A,
    });
    expect(locOnly.map((h) => h.entryId)).toEqual(['L']);
    expect(locOnly.every((h) => h.score === 0)).toBe(true);
  });

  it('degradation chain (Story 8.7): no model -> FTS-only (identity arm equally absent); rerank off -> RRF-of-FTS+vec', async () => {
    const pid = 'ret-degrade';
    // Long-doc-style entry: identity vector matches the query, but its body has
    // no "texas" — without the vec arm it must NOT surface at all.
    seedEntry('L1', pid, 'setting', 'Shrine of Echoes', '神殿\n回声长廊', VEC_C, {
      identityVec: VEC_B,
      summaryText: '回声之神的居所',
    });
    seedEntry('C1', pid, 'character', 'Ranger', 'Ranger\ntexas ranger', VEC_A);

    // 1. No embedding model -> vec arm (identity AND body) skipped entirely:
    //    only the FTS hit C1 surfaces; vectorKind undefined on every hit.
    const ftsOnly = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => null,
      embed: async () => VEC_B,
    });
    expect(ftsOnly.map((h) => h.entryId)).toEqual(['C1']);
    expect(ftsOnly.every((h) => h.vectorKind === undefined)).toBe(true);

    // 2. Vec arm on (L1's identity row matches), rerank unavailable -> the
    //    RRF-of-FTS+vec conditional structure holds: L1 surfaces via its
    //    identity vector with kind + distance, no rerankScore anywhere.
    const rrf = await searchClosure(pid, 'texas', { k: 10 }, {
      resolveModel: () => stubModel(),
      embed: async () => VEC_B,
      resolveRerankModel: () => null,
    });
    const l1 = rrf.find((h) => h.entryId === 'L1');
    expect(l1?.vectorKind).toBe('identity');
    expect(l1?.vecDistance).toBeDefined();
    expect(l1?.ftsRank).toBeUndefined();
    expect(rrf.every((h) => h.rerankScore === undefined)).toBe(true);
  });
});
