import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  CRAFT_TERM_SEEDS,
  craftTermSchema,
  type CraftCardCategory,
  type CraftTerm,
  type CraftTermStatus,
} from '@orison/shared-contracts';
import { getDb } from './index';
import { rewriteCraftCardEntryRow } from './closureCraftCardRepository';

// ── E10.2b（task 09-05）Wave 2：closure_craft_term 词目表 repository（两级词表的可增长级）──
//
// 两级词表（design §1.2）：大类（13 受控常量，shared-contracts CRAFT_CARD_CATEGORIES——
// 永不在本表增长）+ 词目（本表 data，可增长）。**「待并词表」= status='pending' 行**（AI 归类
// 词表外命中 → 提案 pending 词目，卡 termId 指向它进人审——flomo「积累后再整理」）；人审两
// 动作：核准（→active）/ 归并（→merged 留痕 + 卡 termId 改指目标 + category 随新 term 自动改
// ——F-15 单源 + entry 检索行重写）。
//
// 种子 = 五个白话散并位（epics.md:881 指派全承接，W1 契约 CRAFT_TERM_SEEDS）。termId 确定性
// 派生（sha256(category\0name) 前 8 hex）——幂等可重放；实施期 D 样例校准补充（W6）+ 男频
// 打法词目先验同途（题材中性红线：只进词目不进大类）。
//
// expected_downstream_consumers:
// - W3 归类缝（active 词目清单注入 + pending 词目提案落行 + 越界词目回查）。
// - W4/W5 IPC（craft:term-list/approve/merge——result 联合 error 码与 ipc.ts 契约对齐）。

// ── 行映射 ──

interface CraftTermSqlRow {
  term_id: string;
  category: string;
  name: string;
  status: string;
  merged_into: string | null;
  note: string | null;
}

const CRAFT_TERM_COLS = 'term_id, category, name, status, merged_into, note';

function rowToCraftTerm(r: CraftTermSqlRow): CraftTerm | null {
  try {
    return craftTermSchema.parse({
      termId: r.term_id,
      category: r.category,
      name: r.name,
      status: r.status,
      mergedInto: r.merged_into,
      note: r.note,
    });
  } catch {
    // tolerant（mirror rowToMaterial CR-E6）：坏行跳过不崩调用方。词目行是分类轴单源，
    // 坏行仅在库被手改时出现——列表缺席即最诚实的呈现。
    return null;
  }
}

function getTermRow(db: Database.Database, termId: string): CraftTerm | null {
  const row = db
    .prepare(`SELECT ${CRAFT_TERM_COLS} FROM closure_craft_term WHERE term_id=?`)
    .get(termId) as CraftTermSqlRow | undefined;
  return row === undefined ? null : rowToCraftTerm(row);
}

// ── 种子（幂等——确定性 termId + INSERT OR IGNORE）──

/** 种子词目 id：sha256(category\0name) 前 8 hex（确定性——跨重启幂等重放同 id）。 */
function seedTermId(category: string, name: string): string {
  return `term-${createHash('sha256').update(`${category}\0${name}`).digest('hex').slice(0, 8)}`;
}

/**
 * 蒸馏归类提案（pending 词目）的确定性 id（E10.2b W3）——seedTermId 同式派生：重跑同提案
 * （同 category+name）同 id，find-first 复用语义下天然幂等。
 */
export function proposedCraftTermId(category: string, name: string): string {
  return seedTermId(category, name);
}

/**
 * 落词目初始种子（五个白话散并位，active 起板）。幂等：确定性 id + UNIQUE(category,name)
 * + INSERT OR IGNORE——重复调用零重复行（用户删种子后重放会补回：种子是词表基线非用户态，
 * 与 keys/*.yaml「用户态永保」二分不冲突——种子行删除无策展语义）。
 */
export function seedCraftTerms(): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO closure_craft_term (term_id, category, name, status, merged_into, note)
     VALUES (?, ?, ?, 'active', NULL, NULL)`,
  );
  db.transaction(() => {
    for (const s of CRAFT_TERM_SEEDS) {
      insert.run(seedTermId(s.category, s.name), s.category, s.name);
    }
  })();
}

/** 懒种子守卫（读面前置——首查词表时种子就位；已种子 = 一条 EXISTS 读，零写）。 */
function ensureCraftTermSeeds(): void {
  const db = getDb();
  const first = CRAFT_TERM_SEEDS[0];
  if (first === undefined) return;
  const has = db
    .prepare('SELECT 1 FROM closure_craft_term WHERE name=? LIMIT 1')
    .get(first.name);
  if (has === undefined) seedCraftTerms();
}

// ── 读面 ──

/** 词目清单（craft:term-list 取数面——UI 补全 chips / 待并词表视图；含 pending）。 */
export function listCraftTerms(
  input: { status?: CraftTermStatus; category?: CraftCardCategory } = {},
): CraftTerm[] {
  const db = getDb();
  ensureCraftTermSeeds();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    clauses.push('status = ?');
    params.push(input.status);
  }
  if (input.category !== undefined) {
    clauses.push('category = ?');
    params.push(input.category);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT ${CRAFT_TERM_COLS} FROM closure_craft_term ${where} ORDER BY category, name`)
    .all(...params) as CraftTermSqlRow[];
  return rows.flatMap((r) => {
    const t = rowToCraftTerm(r);
    return t === null ? [] : [t];
  });
}

/** 取词目（含懒种子——种子 id 确定性，调用方可按 seedTermId 同式预测）。 */
export function getCraftTerm(termId: string): CraftTerm | null {
  const db = getDb();
  ensureCraftTermSeeds();
  return getTermRow(db, termId);
}

/** 按业务键查词目（归类缝的 pending 提案查重——同 (category, name) 复用既有行）。 */
export function findCraftTermByName(category: CraftCardCategory, name: string): CraftTerm | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT ${CRAFT_TERM_COLS} FROM closure_craft_term WHERE category=? AND name=?`)
    .get(category, name) as CraftTermSqlRow | undefined;
  return row === undefined ? null : rowToCraftTerm(row);
}

// ── 写面 ──

/**
 * 落词目行（W3 pending 提案 / 种子补充）。PK 冲突抛错（提案先走 findCraftTermByName 查重，
 * 复用既有行不重插）。状态由调用方给（提案 = 'pending'）。
 */
export function insertCraftTerm(term: CraftTerm): void {
  getDb()
    .prepare(
      `INSERT INTO closure_craft_term (term_id, category, name, status, merged_into, note)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(term.termId, term.category, term.name, term.status, term.mergedInto, term.note);
}

/** 词目操作 result（error 码与 ipc.ts craft:term-* 契约对齐——handler 补 operation-failed）。 */
export type CraftTermOpResult =
  | { ok: true; term: CraftTerm }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'invalid-state' };

/** 归并 result（success 额外带 movedCardCount——ipc 契约「N 张卡已改挂」反馈面）。 */
export type CraftTermMergeResult =
  | { ok: true; term: CraftTerm; movedCardCount: number }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'invalid-state' };

/**
 * 核准待并词目（pending → active）。核准已 active/merged 词目 = invalid-state（ipc 契约）。
 * 核准后挂它的卡无需迁移（termId 不变，只是词目状态翻面——卡 category 本就跟随本词目）。
 */
export function approveCraftTerm(termId: string): CraftTermOpResult {
  const db = getDb();
  ensureCraftTermSeeds();
  const existing = getTermRow(db, termId);
  if (existing === null) return { ok: false, error: 'not-found' };
  if (existing.status !== 'pending') return { ok: false, error: 'invalid-state' };
  db.prepare(`UPDATE closure_craft_term SET status='active' WHERE term_id=?`).run(termId);
  const term = getTermRow(db, termId);
  return term === null ? { ok: false, error: 'not-found' } : { ok: true, term };
}

/**
 * 归并词目（待并词表的归并动作）：source → status='merged' + merged_into 留痕；**挂它的卡
 * termId 改指目标 + category 随新 term 自动改（F-15 单源）+ 已核卡 entry 检索行重写**（body
 * 含词目名——归并后检索面必须说新词目的话）。归并不降级卡（词目级动作，非卡内容编辑——
 * design §1.2/ipc 契约均无降级语义）；claim 向量不动（condensed 未变）。
 *
 * 约束：两词目须存在且互异（invalid-input）；source/target 均不可已是 merged（invalid-state
 * ——merged 是墓碑不参与再归并，链式归并一律先指最终目标）。
 */
export function mergeCraftTerm(
  termId: string,
  mergeIntoTermId: string,
): CraftTermMergeResult {
  const db = getDb();
  ensureCraftTermSeeds();
  if (termId === mergeIntoTermId) return { ok: false, error: 'invalid-input' };
  const source = getTermRow(db, termId);
  if (source === null) return { ok: false, error: 'not-found' };
  const target = getTermRow(db, mergeIntoTermId);
  if (target === null) return { ok: false, error: 'not-found' };
  if (source.status === 'merged' || target.status === 'merged') {
    return { ok: false, error: 'invalid-state' };
  }

  // 受影响卡先取（改挂后无法再按 source termId 圈定——目标词目既有卡也会混入）。
  const affected = db
    .prepare('SELECT card_id FROM closure_craft_card WHERE term_id=?')
    .all(termId) as Array<{ card_id: string }>;

  db.transaction(() => {
    db.prepare(
      `UPDATE closure_craft_term SET status='merged', merged_into=? WHERE term_id=?`,
    ).run(mergeIntoTermId, termId);
    // 卡改挂 + category 跟随新 term 单源（人审不独立编辑大类的落点——F-15）。
    db.prepare('UPDATE closure_craft_card SET term_id=?, category=? WHERE term_id=?').run(
      mergeIntoTermId,
      target.category,
      termId,
    );
    // 已核卡 entry 检索行重写（verified 重写含新词目名 body；其余卡无行幂等）。
    for (const { card_id } of affected) {
      rewriteCraftCardEntryRow(card_id);
    }
  })();

  const term = getTermRow(db, termId);
  return term === null
    ? { ok: false, error: 'not-found' }
    : { ok: true, term, movedCardCount: affected.length };
}
