import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GenerationCallRecord } from '@orison/model-protocols';

// 09-12 usage-panel W1：closure_llm_log repository round-trip——成功/失败/NULL taskType/
// 缺 counter（NULL token）行 → 三窗汇总（usageByKeyModelSince）+ byKeyModel + byTask +
// recent 断言（NULL-safe SUM；缺 total 行不得由 input+output 合成）；prune 只删过期；
// clear 清全表。mirror mentionLedgerRepository.test.ts 形态。

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror mentionLedgerRepository.test.ts / closureSchema.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-llm-usage-ledger');

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
  clearLedger,
  insertUsageLog,
  pruneExpiredLedger,
  recentUsageLogs,
  usageByKeyModelSince,
  usageByTaskSince,
} from '../main/db/llmUsageLedgerRepository';

// better-sqlite3 ABI gate (mirror mentionLedgerRepository.test.ts): skip the SQL
// suite instead of failing when the native addon cannot load under plain-Node
// vitest. Electron-as-Node real-run command (testing-discipline Pattern):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/llmUsageLedgerRepository.test.ts
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

const NOW = 1_780_000_000_000; // 固定锚（窗口边界断言的确定性）

/** 最小合法 record（字段缺省面按用例覆盖）。 */
function rec(over: Partial<GenerationCallRecord> = {}): GenerationCallRecord {
  return {
    ts: NOW,
    protocol: 'openai-compatible',
    keyId: 'k1',
    modelId: 'model-a',
    stream: false,
    success: true,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    latencyMs: 120,
    ...over,
  };
}

describe.skipIf(!sqliteUsable)('llmUsageLedgerRepository (09-12 usage-panel W1)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('insert + recentUsageLogs：成功/失败/NULL 缺席列 round-trip + 布尔/NULL 映射 + 倒序', () => {
    clearLedger();
    insertUsageLog(rec({ ts: NOW - 2_000, taskType: 'writer-draft', lane: 'background', sessionKey: 'chain:a:w' }));
    insertUsageLog(
      rec({
        ts: NOW - 1_000,
        modelId: 'model-b',
        success: false,
        errorKind: 'quota',
        errorMessage: 'HTTP 429: rate limited',
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      }),
    );
    insertUsageLog(rec({ ts: NOW, protocol: 'antigravity-cli', keyId: 'agy', stream: true, firstDeltaMs: 850, thinkingTokens: 28, cacheReadTokens: 49043 }));

    const rows = recentUsageLogs(10);
    expect(rows).toHaveLength(3);
    // id DESC = 最新在前。
    expect(rows.map((r) => r.keyId)).toEqual(['agy', 'k1', 'k1']);
    const agyRow = rows[0]!;
    expect(agyRow.protocol).toBe('antigravity-cli');
    expect(agyRow.stream).toBe(true);
    expect(agyRow.success).toBe(true);
    expect(agyRow.firstDeltaMs).toBe(850);
    expect(agyRow.thinkingTokens).toBe(28);
    expect(agyRow.taskType).toBeNull(); // 未标注 = NULL（非 ''）
    const failedRow = rows[1]!;
    expect(failedRow.success).toBe(false);
    expect(failedRow.errorKind).toBe('quota');
    expect(failedRow.errorMessage).toBe('HTTP 429: rate limited');
    expect(failedRow.inputTokens).toBeNull(); // 失败行 token 恒 NULL
    expect(failedRow.totalTokens).toBeNull();
    const okRow = rows[2]!;
    expect(okRow.taskType).toBe('writer-draft');
    expect(okRow.sessionKey).toBe('chain:a:w');
    expect(okRow.stream).toBe(false);
    expect(okRow.firstDeltaMs).toBeNull();

    // limit 截断。
    expect(recentUsageLogs(2)).toHaveLength(2);
  });

  it('usageByKeyModelSince：(key, model, protocol) 行组 + 窗口边界 + failedCalls', () => {
    clearLedger();
    insertUsageLog(rec({ keyId: 'k1', modelId: 'model-a', inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
    insertUsageLog(rec({ keyId: 'k1', modelId: 'model-a', success: false, errorKind: 'server', inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }));
    // 同 modelId 异 key：独立行组（¥ 计价需 per-key 单价——design §3）。
    insertUsageLog(rec({ keyId: 'k2', modelId: 'model-a', protocol: 'anthropic-compatible', inputTokens: 7, outputTokens: 3, totalTokens: 10 }));
    // 窗外行（sinceMs 边界排除）。
    insertUsageLog(rec({ ts: NOW - 10_000, keyId: 'k1', modelId: 'model-old', inputTokens: 999, totalTokens: 999 }));

    const groups = usageByKeyModelSince(NOW - 1_000);
    expect(groups).toHaveLength(2);
    const g1 = groups.find((g) => g.keyId === 'k1' && g.modelId === 'model-a')!;
    expect(g1.protocol).toBe('openai-compatible');
    expect(g1.calls).toBe(2);
    expect(g1.failedCalls).toBe(1);
    expect(g1.inputTokens).toBe(100); // 失败行 NULL 不贡献（NULL-safe SUM）
    expect(g1.outputTokens).toBe(50);
    expect(g1.totalTokens).toBe(150);
    const g2 = groups.find((g) => g.keyId === 'k2')!;
    expect(g2.modelId).toBe('model-a');
    expect(g2.protocol).toBe('anthropic-compatible');
    expect(g2.calls).toBe(1);
    expect(g2.totalTokens).toBe(10);
    // 窗外 key1/model-old 不在结果。
    expect(groups.some((g) => g.modelId === 'model-old')).toBe(false);

    // 全窗（含 NOW-10_000）三组。
    expect(usageByKeyModelSince(NOW - 20_000)).toHaveLength(3);
    // 空窗 = 空集（COALESCE 语义在行组层不出现——空集无行）。
    expect(usageByKeyModelSince(NOW + 100_000)).toEqual([]);
  });

  it('usageByTaskSince：task_type 分组 + NULL 组（未标注）+ totalTokens DESC 排序', () => {
    clearLedger();
    insertUsageLog(rec({ taskType: 'writer-draft', totalTokens: 100 }));
    insertUsageLog(rec({ taskType: 'writer-draft', totalTokens: 50 }));
    insertUsageLog(rec({ taskType: 'decon', totalTokens: 500 }));
    insertUsageLog(rec({ taskType: undefined, totalTokens: 200 })); // 未标注
    insertUsageLog(rec({ ts: NOW - 10_000, taskType: 'writer-draft', totalTokens: 999 })); // 窗外

    const byTask = usageByTaskSince(NOW - 1_000);
    expect(byTask.map((t) => t.taskType)).toEqual(['decon', null, 'writer-draft']);
    const draft = byTask.find((t) => t.taskType === 'writer-draft')!;
    expect(draft.calls).toBe(2);
    expect(draft.totalTokens).toBe(150);
    const unlabeled = byTask.find((t) => t.taskType === null)!;
    expect(unlabeled.calls).toBe(1);
    expect(unlabeled.totalTokens).toBe(200);
  });

  it('CR-18：缺 total 行不得由 input+output 合成（SUM 跳 NULL；CR-2 全 NULL 行组透传 null 非 0）', () => {
    clearLedger();
    // input 10 + output 5 但 total 未上报——聚合 totalTokens 必须 null（不合成 15、不归 0）。
    insertUsageLog(rec({ inputTokens: 10, outputTokens: 5, totalTokens: undefined, thinkingTokens: undefined }));
    const [group] = usageByKeyModelSince(0);
    expect(group!.inputTokens).toBe(10);
    expect(group!.outputTokens).toBe(5);
    expect(group!.totalTokens).toBeNull();
    const [task] = usageByTaskSince(0);
    expect(task!.totalTokens).toBeNull();
    const [row] = recentUsageLogs(1);
    expect(row!.totalTokens).toBeNull(); // 行级原样 NULL
  });

  it('pruneExpiredLedger：只删过期行 + 返删除数 + retention 带外 clamp（0/1e9 → [7,730]）', () => {
    clearLedger();
    // ⚠️ prune 以真实 Date.now() 算 cutoff——fixture 必须用相对当前时刻的 ts
    //（固定 NOW 锚会被真实钟漂移误删）。
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    insertUsageLog(rec({ ts: now - 100 * DAY, keyId: 'k-old' }));
    insertUsageLog(rec({ ts: now, keyId: 'k-new' }));

    const deleted = pruneExpiredLedger(90);
    expect(deleted).toBe(1);
    expect(recentUsageLogs(10).map((r) => r.keyId)).toEqual(['k-new']);

    // clamp：0 天带外 → 7 天窗；1e9 带外 → 730 天窗。
    insertUsageLog(rec({ ts: now - 3 * DAY, keyId: 'k-3d' }));
    expect(pruneExpiredLedger(0)).toBe(0); // clamp 到 7：3 天前行保留
    expect(recentUsageLogs(10).some((r) => r.keyId === 'k-3d')).toBe(true);
    expect(pruneExpiredLedger(1e9)).toBe(0); // clamp 到 730：全部保留
    expect(recentUsageLogs(10)).toHaveLength(2);
  });

  it('clearLedger：清全表 + 返删除数 + 幂等', () => {
    clearLedger();
    insertUsageLog(rec({ keyId: 'a' }));
    insertUsageLog(rec({ keyId: 'b' }));
    expect(clearLedger()).toBe(2);
    expect(recentUsageLogs(10)).toEqual([]);
    expect(clearLedger()).toBe(0); // 幂等
  });

  it('insertUsageLog never-throws：表被外部 drop 后 warn 不上抛', () => {
    getDb().exec('DROP TABLE closure_llm_log');
    expect(() => insertUsageLog(rec({}))).not.toThrow();
  });
});

// ── C3.1（09-20）三新列迁移（call_id/session_id/image_count，design §3.2）──────────
// 旧行迁移幸存三列 NULL + 新行三列 round-trip + 迁移幂等（内省守卫——无守卫的裸 ALTER
// 在二次启动必抛 duplicate column）。新列读面走 SQL 直读（recentUsageLogs 的列清单属
// W4 M3 三触点面，W1 不动）。
describe.skipIf(!sqliteUsable)('closure_llm_log C3.1 三列迁移（call_id/session_id/image_count）', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    // 模拟 09-12 旧库：无三新列的旧形态表 + 一条旧行。raw Database 直开，先 close 释放
    // 句柄（WAL/Windows 文件锁纪律）再交 getDb() 走 initSchema 迁移路径。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const raw = new Database(path.join(TEST_HOME, '.orison', 'data', 'projects.db'));
    raw.exec(`
      CREATE TABLE closure_llm_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        protocol      TEXT NOT NULL,
        key_id        TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        task_type     TEXT,
        lane          TEXT,
        session_key   TEXT,
        stream        INTEGER NOT NULL DEFAULT 0,
        success       INTEGER NOT NULL CHECK(success IN (0,1)),
        error_kind    TEXT,
        error_message TEXT,
        input_tokens       INTEGER,
        output_tokens      INTEGER,
        thinking_tokens    INTEGER,
        cache_read_tokens  INTEGER,
        total_tokens       INTEGER,
        latency_ms     INTEGER NOT NULL,
        first_delta_ms INTEGER
      );
    `);
    raw.prepare(
      `INSERT INTO closure_llm_log (ts, protocol, key_id, model_id, task_type, stream, success, input_tokens, total_tokens, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(NOW, 'openai-compatible', 'legacy', 'model-legacy', 'writer-draft', 0, 1, 11, 17, 90);
    raw.close();
    getDb(); // CREATE IF NOT EXISTS no-op → 内省 ALTER 三列
  });
  afterAll(clean);

  it('旧行迁移幸存 + 三新列 NULL（零回填，缺席 ≠ 0）', () => {
    const rows = recentUsageLogs(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyId).toBe('legacy');
    expect(rows[0]!.taskType).toBe('writer-draft');
    expect(rows[0]!.inputTokens).toBe(11);
    const migrated = getDb()
      .prepare('SELECT call_id, session_id, image_count FROM closure_llm_log WHERE key_id = ?')
      .get('legacy') as { call_id: string | null; session_id: string | null; image_count: number | null };
    expect(migrated.call_id).toBeNull();
    expect(migrated.session_id).toBeNull();
    expect(migrated.image_count).toBeNull();
  });

  it('新行三列 round-trip：INSERT 落列 → SQL 读回；ABSENT 字段落 NULL 非 0', () => {
    clearLedger();
    insertUsageLog(rec({ keyId: 'k-new', callId: 'call-1', sessionId: 'sess-1' }));
    insertUsageLog(rec({ keyId: 'k-img', callId: 'call-2', imageCount: 3 }));
    insertUsageLog(rec({ keyId: 'k-bare' })); // 三新字段全 ABSENT

    const rows = getDb()
      .prepare(
        `SELECT key_id AS keyId, call_id AS callId, session_id AS sessionId, image_count AS imageCount
           FROM closure_llm_log ORDER BY id`,
      )
      .all() as Array<{ keyId: string; callId: string | null; sessionId: string | null; imageCount: number | null }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ keyId: 'k-new', callId: 'call-1', sessionId: 'sess-1', imageCount: null });
    expect(rows[1]).toMatchObject({ keyId: 'k-img', callId: 'call-2', sessionId: null, imageCount: 3 });
    expect(rows[2]).toMatchObject({ keyId: 'k-bare', callId: null, sessionId: null, imageCount: null });
  });

  it('迁移幂等：closeDb → getDb 二次启动不重复 ALTER（内省守卫）且数据幸存', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    expect(recentUsageLogs(10).map((r) => r.keyId).sort()).toEqual(['k-bare', 'k-img', 'k-new']);
  });
});
