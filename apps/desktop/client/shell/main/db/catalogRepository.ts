import { getDb } from './index';

// ── Story 8.7 S6：closure_entry 目录查询 repository（design §4.1 / catalog.ts 契约）──
//
// 实体目录的可穷举面查询（薄行 + 下钻全文）：先过滤（entry_type/status/visibility）后翻页
// （offset/limit），total 独立 COUNT 显式返回（绝不静默截断红线，catalog.ts JSDoc 单源）。
// mirror mentionLedgerRepository 模式：每函数 `const db = getDb()` → prepare → all/get →
// 返类型化 record；同步保持同步（db-repository.md 惯例）。纯读——零写路径（读工具零持久化
// 副作用红线，agent-tools.md「读工具零持久化副作用」Convention）。
//
// mention 聚合（章数/最后出场章）不在本 repository——handler 经 mentionLedgerRepository
// getMentionAggregates 单查询组装（聚合属 mention 账面，账本自管）。
//
// project_id = registry 5 位 id（handler 层解析后传入，mirror closure_entry 全家族）。

type AnyRow = Record<string, unknown>;

/** 目录薄行（closure_entry 投影；summaryLine 截断与 mention 聚合拼装归 handler）。 */
export interface CatalogEntryRow {
  entryId: string;
  entryType: string;
  name: string;
  /** 简述（frontmatter 策展 / 索引时生成）；NULL = 未生成（setting_md/craft 未跑简述层）。 */
  summaryText: string | null;
}

/** get_entry 下钻全文行。status：卡状态（draft/active/...）；设定散文/参考文档无状态概念 → null。 */
export interface CatalogEntryDetail extends CatalogEntryRow {
  bodyText: string;
  status: string | null;
  visibility: string;
}

/** 过滤条件（先过滤后翻页；全部 optional = 不过滤）。 */
export interface CatalogFilter {
  entryType?: string;
  status?: string;
  visibility?: string;
  offset: number;
  limit: number;
}

/**
 * 目录面排除（Story 8.3 design §2.2 复审缺漏 #2）：章正文 chunk 行
 * （source_kind='chapter'，一章可产数百-数千段行）与章摘要行
 * （'chapter_summary'）不是实体——不排除会把实体目录淹没（total 虚高 + 翻页全段行 +
 * get_entry 把段当实体档案）。**排除式**（NOT IN）而非列举式：未来新「段类」来源
 * 自动排除，实体类新增自动入目录。检索面（searchClosure/query_story）不受影响——
 * 它们不按 source_kind 过滤，正文段落照样可查（query_story 消费），只是不进实体目录。
 * Story 10.1 Wave C：加 `'material'`（材料 chunk 行——外部材料段，非项目实体，同理
 * 排除；材料检索走 query_story 混合检索天然含它）。
 */
const CATALOG_EXCLUDED_SOURCE_KINDS = ['chapter', 'chapter_summary', 'material'] as const;

function catalogConditions(projectId: string, filter: CatalogFilter): {
  where: string;
  params: unknown[];
} {
  const placeholders = CATALOG_EXCLUDED_SOURCE_KINDS.map(() => '?').join(', ');
  const conditions = [
    'project_id = ?',
    `source_kind NOT IN (${placeholders})`,
  ];
  const params: unknown[] = [projectId, ...CATALOG_EXCLUDED_SOURCE_KINDS];
  if (filter.entryType !== undefined) {
    conditions.push('entry_type = ?');
    params.push(filter.entryType);
  }
  if (filter.status !== undefined) {
    // status 过滤对 NULL 行（setting_md/craft 无状态概念）天然不命中——语义正确：过滤「该状态的卡」。
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.visibility !== undefined) {
    conditions.push('visibility = ?');
    params.push(filter.visibility);
  }
  return { where: conditions.join(' AND '), params };
}

/**
 * 目录薄行分页查询 + **显式 total**（独立 COUNT，与 offset/limit 无关的过滤后完整计数——
 * catalogEntriesResultSchema.total 契约）。排序 entry_type → entry_id 升序（确定性 + 翻页稳定：
 * 同一过滤条件下后续页不漂移）。
 */
export function listCatalogEntries(
  projectId: string,
  filter: CatalogFilter,
): { total: number; rows: CatalogEntryRow[] } {
  const db = getDb();
  const { where, params } = catalogConditions(projectId, filter);

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM closure_entry WHERE ${where}`).get(...params) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT entry_id, entry_type, name, summary_text
       FROM closure_entry
       WHERE ${where}
       ORDER BY entry_type ASC, entry_id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as AnyRow[];

  return {
    total,
    rows: rows.map((row) => ({
      entryId: row.entry_id as string,
      entryType: row.entry_type as string,
      name: row.name as string,
      summaryText: (row.summary_text as string | null) ?? null,
    })),
  };
}

/**
 * 单条目下钻全文（get_entry）。`project_id` 双条件 belt：entry_id 是全局 PK，但 2.7 起卡类
 * entry_id 用 raw card.id 存在跨项目碰撞 latent 风险——双条件确保只读本项目的行（碰撞行
 * 他项目读不到，诚实缺位好过串数据）。Story 8.3：章源排除与目录面一致——chunk/摘要行
 * 不是实体档案，排除后对 chunk entry_id 自然 miss（handler 出友好文案；正文核对走
 * chapter_read + 段级出处）。
 *
 * @returns 条目详情；不存在（他项目 id / 未入索引 / 章源段行）→ undefined（handler 出友好 miss）。
 */
export function getCatalogEntry(projectId: string, entryId: string): CatalogEntryDetail | undefined {
  const db = getDb();
  const placeholders = CATALOG_EXCLUDED_SOURCE_KINDS.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT entry_id, entry_type, name, summary_text, body_text, status, visibility
       FROM closure_entry
       WHERE project_id = ? AND entry_id = ?
         AND source_kind NOT IN (${placeholders})`,
    )
    .get(projectId, entryId, ...CATALOG_EXCLUDED_SOURCE_KINDS) as AnyRow | undefined;
  if (row === undefined) return undefined;
  return {
    entryId: row.entry_id as string,
    entryType: row.entry_type as string,
    name: row.name as string,
    summaryText: (row.summary_text as string | null) ?? null,
    bodyText: row.body_text as string,
    status: (row.status as string | null) ?? null,
    visibility: row.visibility as string,
  };
}
