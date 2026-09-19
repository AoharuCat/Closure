import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Point the SQLite registry at a throwaway home so the real ~/.orison db is
// never touched (mirror mentionLedgerRepository.test.ts).
const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-catalog-repo');

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
import { getCatalogEntry, listCatalogEntries } from '../main/db/catalogRepository';

// better-sqlite3 ABI gate (mirror mentionLedgerRepository.test.ts): skip the SQL
// suite instead of failing when the native addon cannot load under plain-Node
// vitest. Electron-as-Node real-run command (testing-discipline Pattern):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
//     node_modules/vitest/vitest.mjs run test/catalogRepository.test.ts
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

// 每测试独立 project id（跨项目隔离，mirror mentionLedgerRepository.test 哲学）。
const PID_LIST = '00081';
const PID_GET = '00082';
const PID_EXCLUDE = '00083';

interface SeedRow {
  entryId: string;
  entryType: string;
  name: string;
  summaryText?: string | null;
  status?: string | null;
}

/** 直插 closure_entry（绕过 indexer——索引器写路径归 S4 既有 suite；此处只测读查询）。 */
function seedEntries(projectId: string, rows: SeedRow[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO closure_entry
       (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, summary_text, status)
     VALUES (?, ?, ?, 'asset_card', ?, ?, 'known', ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.entryId,
      projectId,
      row.entryType,
      row.name,
      `body of ${row.name}`,
      row.summaryText ?? null,
      row.status ?? null,
    );
  }
}

describe.skipIf(!sqliteUsable)('catalogRepository (Story 8.7 S6)', () => {
  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    getDb();
  });
  afterAll(clean);

  it('listCatalogEntries：过滤（entry_type/status）+ 排序（entry_type→entry_id）+ 显式 total 独立于 limit', () => {
    seedEntries(PID_LIST, [
      { entryId: 'zeta', entryType: 'character', name: '泽塔', status: 'active' },
      { entryId: 'alpha', entryType: 'character', name: '阿尔法', summaryText: '一句简述', status: 'draft' },
      { entryId: 'tavern', entryType: 'location', name: '老酒馆', status: null },
      { entryId: 'rule-1', entryType: 'rule', name: '灵力守恒', status: 'active' },
      { entryId: 'rule-2', entryType: 'rule', name: '禁咒代价', status: 'deprecated' },
    ]);
    // 干扰行：他项目同 entry_type（project 隔离）。
    seedEntries('00089', [{ entryId: 'other-char', entryType: 'character', name: '他项目' }]);

    // 无过滤全量：total 5（他项目不计），排序 entry_type → entry_id。
    const all = listCatalogEntries(PID_LIST, { offset: 0, limit: 100 });
    expect(all.total).toBe(5);
    expect(all.rows.map((r) => r.entryId)).toEqual(['alpha', 'zeta', 'tavern', 'rule-1', 'rule-2']);

    // entry_type 过滤。
    const chars = listCatalogEntries(PID_LIST, { entryType: 'character', offset: 0, limit: 100 });
    expect(chars.total).toBe(2);
    expect(chars.rows.map((r) => r.entryId)).toEqual(['alpha', 'zeta']);

    // status 过滤：NULL 行（tavern 无状态概念）天然不命中。
    const active = listCatalogEntries(PID_LIST, { status: 'active', offset: 0, limit: 100 });
    expect(active.total).toBe(2);
    expect(active.rows.map((r) => r.entryId)).toEqual(['zeta', 'rule-1']);

    // 分页：total 与 offset/limit 无关；页内行按排序切窗。
    const page1 = listCatalogEntries(PID_LIST, { offset: 0, limit: 2 });
    expect(page1.total).toBe(5);
    expect(page1.rows.map((r) => r.entryId)).toEqual(['alpha', 'zeta']);
    const page2 = listCatalogEntries(PID_LIST, { offset: 2, limit: 2 });
    expect(page2.total).toBe(5);
    expect(page2.rows.map((r) => r.entryId)).toEqual(['tavern', 'rule-1']);
    const page3 = listCatalogEntries(PID_LIST, { offset: 4, limit: 2 });
    expect(page3.rows.map((r) => r.entryId)).toEqual(['rule-2']);

    // summaryText 透传（NULL → null）。
    expect(page1.rows[0]).toMatchObject({ entryId: 'alpha', summaryText: '一句简述' });
    expect(page1.rows[1]).toMatchObject({ entryId: 'zeta', summaryText: null });
  });

  it('getCatalogEntry：全字段下钻 + project 双条件 belt（他项目 id 读不到）', () => {
    seedEntries(PID_GET, [
      { entryId: 'erina', entryType: 'character', name: '艾琳', summaryText: '少女剑士', status: 'active' },
      { entryId: 'doc-1', entryType: 'rule', name: '魔法体系长文', summaryText: null, status: null },
    ]);
    // 注：entry_id 是全局 PK，跨项目同 id 行无法共存（INSERT 撞 UNIQUE）——2.7 raw card.id latent
    // 风险的实测确认。belt 双条件（project_id AND entry_id）的语义 = 即便经迁移/手工修库产生跨项目
    // 同 id 行，也只读本项目的行；本测试以「他项目独有 id 对本项目不可见」验证 project 过滤面。
    seedEntries('00088', [{ entryId: 'other-erina', entryType: 'character', name: '他项目角色' }]);

    const erina = getCatalogEntry(PID_GET, 'erina');
    expect(erina).toMatchObject({
      entryId: 'erina',
      entryType: 'character',
      name: '艾琳',
      summaryText: '少女剑士',
      bodyText: 'body of 艾琳',
      status: 'active',
      visibility: 'known',
    });

    // 设定散文形态：status null + summary null。
    expect(getCatalogEntry(PID_GET, 'doc-1')).toMatchObject({ status: null, summaryText: null });

    // project belt：他项目的行对本项目不可见；不存在的 id → undefined。
    expect(getCatalogEntry(PID_GET, 'other-erina')).toBeUndefined();
    expect(getCatalogEntry(PID_GET, 'nope')).toBeUndefined();
    expect(getCatalogEntry('00088', 'other-erina')).toMatchObject({ name: '他项目角色' });
  });

  // ── Story 8.3 S4：目录面排除（chunk/摘要行不是实体——防段行淹没目录，design §2.2 复审缺漏 #2）──
  it('章源行排除：chapter/chapter_summary 行不进目录 total/rows；get_entry 对 chunk entry_id 自然 miss', () => {
    const db = getDb();
    // ⚠️ entry_id 是全局 PK（suite 共库跨测试累积）——id 只属于本测试（'tavern' 已被
    // PID_LIST 测试占用，复用会撞 UNIQUE）。
    seedEntries(PID_EXCLUDE, [
      { entryId: 'hero-83', entryType: 'character', name: '主角', status: 'active' },
      { entryId: 'pawnshop-83', entryType: 'location', name: '当铺', status: null },
    ]);
    // 章正文 chunk 行（mirror S3 索引器写形态：source_kind='chapter' + span 列）。
    const insertChunk = db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status,
          chapter_id, chapter_index, char_start, char_end, para_start, para_end, index_text)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 30; i += 1) {
      insertChunk.run(
        `${PID_EXCLUDE}:ch_001#c${i}`, PID_EXCLUDE, 'chapter', 'chapter',
        `第1章·段${i + 1}`, `正文段${i}`, 'known', 'ch_001', 0, i * 100, i * 100 + 90, i * 2, i * 2 + 2, null,
      );
    }
    // 章摘要行（source_kind='chapter_summary'）。
    db.prepare(
      `INSERT INTO closure_entry
         (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status)
       VALUES (?,?,?,?,?,?,?,NULL)`,
    ).run(`${PID_EXCLUDE}:ep-1#summary`, PID_EXCLUDE, 'chapter_summary', 'chapter_summary', '第1章摘要', '梗概拼料', 'known');

    // 目录 total/rows 只含实体类两行——32 个章源行（30 chunk + 1 摘要）全排除。
    const all = listCatalogEntries(PID_EXCLUDE, { offset: 0, limit: 100 });
    expect(all.total).toBe(2);
    expect(all.rows.map((r) => r.entryId).sort()).toEqual(['hero-83', 'pawnshop-83']);

    // 过滤面同样排除：entry_type='chapter'（正文段类型）对目录恒空——排除先于过滤。
    const chapterType = listCatalogEntries(PID_EXCLUDE, { entryType: 'chapter', offset: 0, limit: 100 });
    expect(chapterType.total).toBe(0);

    // get_entry 下钻：chunk entry_id 与摘要 entry_id 均自然 miss（undefined →
    // handler 友好 miss 文案；正文核对走 chapter_read + 段级出处）。
    expect(getCatalogEntry(PID_EXCLUDE, `${PID_EXCLUDE}:ch_001#c0`)).toBeUndefined();
    expect(getCatalogEntry(PID_EXCLUDE, `${PID_EXCLUDE}:ep-1#summary`)).toBeUndefined();
    // 实体行不受影响。
    expect(getCatalogEntry(PID_EXCLUDE, 'hero-83')).toMatchObject({ name: '主角' });
  });
});
