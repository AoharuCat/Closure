import type Database from 'better-sqlite3';

/**
 * `closure_craft_vec` embedding-dimension reader（leaf 模块，E10.2b Wave 2 抽出）。
 *
 * 原住 `closureCraftIndexer.ts`。E10.2b 卡索引侧（closureCraftCardRepository）需要读 dim 做
 * 向量长度预检，而 closureCraftIndexer 的 `reindexAllCraft` 需要 import 卡侧的 `reindexAllCards`
 * sweep（F-05 模型迁移同点位）——互指即成环（depcircular 反模式）。抽成无依赖 leaf，两侧各自
 * 单向引用；closureCraftIndexer re-export 保持既有 import 点（materialIndexer / 检索侧）零改动。
 */

/**
 * Read the current `closure_craft_vec` embedding dimension from the live schema.
 * null when the table is absent (vec extension not loaded, or not yet created).
 */
export function getCurrentCraftVecDim(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='closure_craft_vec'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) return null;
  const m = row.sql.match(/float\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}
