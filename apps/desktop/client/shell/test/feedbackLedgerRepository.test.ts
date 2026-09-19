import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror worldStateRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-feedback-ledger-repo');

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

import { closeDb, getDb } from '../main/db/index';
import {
  readEpisodeFeedback,
  readFeedbackLedger,
  upsertFeedbackLedger,
} from '../main/db/feedbackLedgerRepository';

// better-sqlite3 ABI gate (mirror worldStateRepository.test.ts): skip the SQL suite
// instead of failing when the native addon cannot load under plain-Node vitest.
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
  rmBestEffort(TEST_HOME);
}

const PID = '00001';

describe.skipIf(!sqliteUsable)('feedbackLedgerRepository (Story 7.4 §2.2)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('creates the closure_feedback_ledger table + index on initSchema', () => {
    const db = getDb();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(tables.has('closure_feedback_ledger')).toBe(true);

    const indexes = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(indexes.has('idx_closure_feedback_ledger_proj_ep')).toBe(true);
  });

  it('upsertFeedbackLedger writes + readFeedbackLedger reads back (roundtrip)', () => {
    const payload = {
      verdict: 'revise',
      dimensions: [{ name: 'ConStory', severity: 'warn', findings: [{ quote: '原文' }] }],
      summary: '需修订',
    };
    upsertFeedbackLedger(PID, 'ep1', 'review.latest', payload);

    const entry = readFeedbackLedger(PID, 'ep1', 'review.latest');
    expect(entry).toBeDefined();
    expect(entry!.episodeId).toBe('ep1');
    expect(entry!.artifactKey).toBe('review.latest');
    expect(entry!.payload).toEqual(payload);
    expect(entry!.producedAt).toBeTruthy(); // ISO timestamp
  });

  it('readFeedbackLedger returns undefined for missing record', () => {
    const entry = readFeedbackLedger(PID, 'ep-nonexistent', 'review.latest');
    expect(entry).toBeUndefined();
  });

  it('upsertFeedbackLedger is idempotent (same key upsert overwrites)', () => {
    const payload1 = { verdict: 'pass', summary: 'v1' };
    const payload2 = { verdict: 'revise', summary: 'v2 (updated)' };

    upsertFeedbackLedger(PID, 'ep2', 'review.latest', payload1);
    const ts1 = readFeedbackLedger(PID, 'ep2', 'review.latest')!.producedAt;

    upsertFeedbackLedger(PID, 'ep2', 'review.latest', payload2);
    const entry = readFeedbackLedger(PID, 'ep2', 'review.latest');

    expect(entry!.payload).toEqual(payload2);
    // producedAt updated (newer or equal — fast tests may have same ms but string differs via toISOString)
    expect(entry!.producedAt).toBeTruthy();
    expect(typeof entry!.producedAt).toBe('string');
    // timestamp format sanity (ISO)
    expect(entry!.producedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('upsertFeedbackLedger isolates by episode + key (composite PK)', () => {
    upsertFeedbackLedger(PID, 'ep3', 'review.latest', { data: 'ep3-review' });
    upsertFeedbackLedger(PID, 'ep3', 'emotion_verify_result', { data: 'ep3-emotion' });
    upsertFeedbackLedger(PID, 'ep4', 'review.latest', { data: 'ep4-review' });

    expect(readFeedbackLedger(PID, 'ep3', 'review.latest')!.payload).toEqual({ data: 'ep3-review' });
    expect(readFeedbackLedger(PID, 'ep3', 'emotion_verify_result')!.payload).toEqual({
      data: 'ep3-emotion',
    });
    expect(readFeedbackLedger(PID, 'ep4', 'review.latest')!.payload).toEqual({ data: 'ep4-review' });
  });

  it('upsertFeedbackLedger isolates by project_id (composite PK)', () => {
    const PID2 = '00002';
    upsertFeedbackLedger(PID2, 'ep1', 'review.latest', { data: 'project2-ep1' });
    upsertFeedbackLedger(PID, 'ep1', 'review.latest', { data: 'project1-ep1' });

    expect(readFeedbackLedger(PID2, 'ep1', 'review.latest')!.payload).toEqual({
      data: 'project2-ep1',
    });
    expect(readFeedbackLedger(PID, 'ep1', 'review.latest')!.payload).toEqual({
      data: 'project1-ep1',
    });
  });

  it('readEpisodeFeedback returns all keys for an episode', () => {
    upsertFeedbackLedger(PID, 'ep-all', 'review.latest', { v: 1 });
    upsertFeedbackLedger(PID, 'ep-all', 'emotion_verify_result', { v: 2 });
    upsertFeedbackLedger(PID, 'ep-all', 'completeness_verify_result', { v: 3 });

    const entries = readEpisodeFeedback(PID, 'ep-all');
    expect(entries).toHaveLength(3);
    const keys = entries.map((e) => e.artifactKey).sort();
    expect(keys).toEqual(['completeness_verify_result', 'emotion_verify_result', 'review.latest']);
  });

  it('readEpisodeFeedback returns empty array for episode with no records', () => {
    const entries = readEpisodeFeedback(PID, 'ep-empty');
    expect(entries).toEqual([]);
  });

  it('payload JSON.parse failure is graceful (marks corruptPayload, not crash, not masked as empty)', () => {
    // Manually insert a row with malformed JSON payload to simulate corrupt data.
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO closure_feedback_ledger (project_id, episode_id, artifact_key, payload, produced_at) VALUES (?, ?, ?, ?, ?)',
    ).run(PID, 'ep-corrupt', 'review.latest', '{malformed json', '2026-01-01T00:00:00.000Z');

    // BMad CR-011：readFeedbackLedger should not crash — deserializeFeedbackPayload returns undefined,
    // rowToEntry marks corruptPayload=true（不 ?? {} 折叠空对象掩盖）。caller 见 corrupt → warn + 当空处理。
    const entry = readFeedbackLedger(PID, 'ep-corrupt', 'review.latest');
    expect(entry).toBeDefined();
    expect(entry!.corruptPayload).toBe(true);
    expect(entry!.payload).toBeUndefined(); // 坏 JSON 不造假空对象
    expect(entry!.episodeId).toBe('ep-corrupt'); // 其余字段仍有效
  });
});
