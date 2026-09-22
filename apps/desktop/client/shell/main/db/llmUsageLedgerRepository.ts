import type { UsageModelKeyRow, UsageRecentCall, UsageTaskBreakdown } from '@orison/shared-contracts';
import { clampUsageRetentionDays } from '@orison/shared-contracts';
import type { GenerationCallRecord } from '@orison/model-protocols';
import { getDb } from './index';
import { getLogger } from '../logger';

// ── 09-12 usage-panel W1：closure_llm_log 计量账 repository（design §2/§3）──────────
//
// 纯函数 repository（mirror feedbackLedgerRepository / mentionLedgerRepository 模式）：
// 每函数内 `const db = getDb()` → prepare/run/all → 类型化 record；同步保持同步
// （db-repository 反模式「把 repository 同步函数改成 async」）。聚合全部 GROUP BY 下推
// SQL（db-repository 纪律：禁全表拉取内存 reduce）——窗口边界值（本地午夜 epoch ms）由
// 调用方 JS 算好传入（usageIpc，W3）；SUM 对 NULL 天然跳过、空集 COALESCE→0（CR-18）。
//
// 写入单源：insertUsageLog（never-throws——sink 适配经 dispatchGenerationCallRecord 已
// best-effort，这里再兜一层 db 错误：计量失败 warn 不阻生成，mirror mention-ledger 降级
// hook 哲学）。**全仓唯一 insert 调用面** = main/index.ts whenReady 装配的 sink 适配 +
// 本文件测试（W4 grep 守门：插桩无第二落点）。
//
// 行类型 = model-protocols GenerationCallRecord（type-only import——shell → model-
// protocols 是 module-boundaries 合法方向；直接复用而非结构孪生，字段漂移编译期即红）。
// snake_case 列 ↔ camelCase record 映射集中在下方两个转换器；undefined 绑定值一律
// `?? null`（better-sqlite3 拒绝 undefined 绑定——NULL 语义由 CR-18 钉死）。

type AnyRow = Record<string, unknown>;

/** better-sqlite3 绑定兼容视图：optional → NULL，boolean → 0/1。 */
function toInsertBindings(record: GenerationCallRecord): Array<string | number | null> {
  return [
    record.ts,
    record.protocol,
    record.keyId,
    record.modelId,
    record.taskType ?? null,
    record.lane ?? null,
    record.sessionKey ?? null,
    record.stream ? 1 : 0,
    record.success ? 1 : 0,
    record.errorKind ?? null,
    record.errorMessage ?? null,
    record.inputTokens ?? null,
    record.outputTokens ?? null,
    record.thinkingTokens ?? null,
    record.cacheReadTokens ?? null,
    record.totalTokens ?? null,
    record.latencyMs,
    record.firstDeltaMs ?? null,
    record.callId ?? null,     // C3.1：逻辑调用分组 id
    record.sessionId ?? null,  // C3.1：逻辑会话 id
    record.imageCount ?? null, // C3.1：生图张数（仅生图行）
  ];
}

function rowToRecentCall(row: AnyRow): UsageRecentCall {
  return {
    id: row.id as number,
    ts: row.ts as number,
    protocol: row.protocol as UsageRecentCall['protocol'],
    keyId: row.keyId as string,
    modelId: row.modelId as string,
    taskType: (row.taskType as string | null) ?? null,
    sessionKey: (row.sessionKey as string | null) ?? null,
    stream: row.stream === 1,
    success: row.success === 1,
    errorKind: (row.errorKind as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    inputTokens: (row.inputTokens as number | null) ?? null,
    outputTokens: (row.outputTokens as number | null) ?? null,
    thinkingTokens: (row.thinkingTokens as number | null) ?? null,
    cacheReadTokens: (row.cacheReadTokens as number | null) ?? null,
    totalTokens: (row.totalTokens as number | null) ?? null,
    latencyMs: row.latencyMs as number,
    firstDeltaMs: (row.firstDeltaMs as number | null) ?? null,
    imageCount: (row.imageCount as number | null) ?? null,
  };
}

// ── 写入 ──

/**
 * 落一行生成调用计量（每 attempt 一行）。token 列 CR-18 v2：**未知才 ABSENT**（NULL）——
 * 计数器在场即记（含失败/被弃 attempt 的已知消耗）；total 缺席不合成。C3.1 三新列
 * （call_id/session_id/image_count）optional 透传，ABSENT 落 NULL。
 * never-throws：db 错误 warn 不上抛（计量绝不阻生成）。
 */
export function insertUsageLog(record: GenerationCallRecord): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO closure_llm_log (
         ts, protocol, key_id, model_id, task_type, lane, session_key,
         stream, success, error_kind, error_message,
         input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens,
         latency_ms, first_delta_ms,
         call_id, session_id, image_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...toInsertBindings(record));
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'closure_llm_log insert failed (usage metering is best-effort; generation unaffected)',
    );
  }
}

// ── 聚合查询（GROUP BY 下推；窗口边界调用方传入）──

/**
 * SUM 列清单——窗口汇总 / byKeyModel / byTask 三查询同型（单源防漂移）。
 * CR-2（09-12 子5 CR 批）：五个 token SUM **不 COALESCE**——全 NULL 行组透传 NULL
 * （「有调用但全程未上报」≠ 0），空值归并在 handler 的 fold 层（空窗 = 真零 0）。
 * failedCalls 的 CASE 恒产 0/1（组内至少一行），SUM 不为 NULL。
 */
const TOKEN_SUM_COLUMNS = `
  COUNT(*) AS calls,
  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failedCalls,
  SUM(input_tokens) AS inputTokens,
  SUM(output_tokens) AS outputTokens,
  SUM(thinking_tokens) AS thinkingTokens,
  SUM(cache_read_tokens) AS cacheReadTokens,
  SUM(total_tokens) AS totalTokens`;

/** token SUM 列的 NULL 透传映射（NULL = 全程未上报，CR-2；number = 真值和）。 */
function nullableSum(row: AnyRow, key: string): number | null {
  return (row[key] as number | null) ?? null;
}

/**
 * 窗口内 per-(key_id, model_id, protocol) 行组（design §3：窗口汇总与 byModel 展示同源
 * ——handler 由该结果同时导出窗口合计与折叠后的 byModel 表；¥ 计价必须按行组，同
 * modelId 在不同 key 下单价可不同）。estimatedCost 由 handler 经 estimateUsageCost
 * 注入，本查询不产。ORDER BY 保证折叠（usageIpc foldModelRows）与 keyIds 顺序确定。
 */
export function usageByKeyModelSince(sinceMs: number): UsageModelKeyRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT key_id AS keyId, model_id AS modelId, protocol, ${TOKEN_SUM_COLUMNS}
         FROM closure_llm_log WHERE ts >= ?
        GROUP BY key_id, model_id, protocol
        ORDER BY model_id, key_id, protocol`,
    )
    .all(sinceMs) as AnyRow[];
  return rows.map((row) => ({
    keyId: row.keyId as string,
    modelId: row.modelId as string,
    protocol: row.protocol as UsageModelKeyRow['protocol'],
    calls: row.calls as number,
    failedCalls: row.failedCalls as number,
    inputTokens: nullableSum(row, 'inputTokens'),
    outputTokens: nullableSum(row, 'outputTokens'),
    thinkingTokens: nullableSum(row, 'thinkingTokens'),
    cacheReadTokens: nullableSum(row, 'cacheReadTokens'),
    totalTokens: nullableSum(row, 'totalTokens'),
  }));
}

/** 窗口内按档位/流程标签分解（task_type 自由值；NULL 组 = 未标注，UI 映射标签）。 */
export function usageByTaskSince(sinceMs: number): UsageTaskBreakdown[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT task_type AS taskType, ${TOKEN_SUM_COLUMNS}
         FROM closure_llm_log WHERE ts >= ?
        GROUP BY task_type
        ORDER BY totalTokens DESC`,
    )
    .all(sinceMs) as AnyRow[];
  return rows.map((row) => ({
    taskType: (row.taskType as string | null) ?? null,
    calls: row.calls as number,
    failedCalls: row.failedCalls as number,
    inputTokens: nullableSum(row, 'inputTokens'),
    outputTokens: nullableSum(row, 'outputTokens'),
    thinkingTokens: nullableSum(row, 'thinkingTokens'),
    cacheReadTokens: nullableSum(row, 'cacheReadTokens'),
    totalTokens: nullableSum(row, 'totalTokens'),
  }));
}

/** 最近调用（倒序，缺省由调用方取 20）。NULL cell 语义原样透出（呈现层渲染「—」）。 */
export function recentUsageLogs(limit: number): UsageRecentCall[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, ts, protocol, key_id AS keyId, model_id AS modelId, task_type AS taskType,
              session_key AS sessionKey, stream, success,
              error_kind AS errorKind, error_message AS errorMessage,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              thinking_tokens AS thinkingTokens, cache_read_tokens AS cacheReadTokens,
              total_tokens AS totalTokens, latency_ms AS latencyMs, first_delta_ms AS firstDeltaMs,
              image_count AS imageCount
         FROM closure_llm_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as AnyRow[];
  return rows.map(rowToRecentCall);
}

// ── 治理（R5：滚动保留 + 手动清空）──

/**
 * 滚动保留窗裁剪：`DELETE WHERE ts < now - retentionDays 天`，返删除行数。
 * retentionDays 先经 clampUsageRetentionDays 归位（[7, 730] 单源——手改带外值不放大删除面）。
 * 触发点 = 启动期（main/index.ts whenReady）+ retention 变更保存时 + 清空后（W2/W3 接线）。
 */
export function pruneExpiredLedger(retentionDays: number): number {
  const db = getDb();
  const days = clampUsageRetentionDays(retentionDays);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.prepare('DELETE FROM closure_llm_log WHERE ts < ?').run(cutoff).changes;
}

/** 手动清空全表（usage:clear），返删除行数。 */
export function clearLedger(): number {
  const db = getDb();
  return db.prepare('DELETE FROM closure_llm_log').run().changes;
}
