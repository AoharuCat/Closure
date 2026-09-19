import { generateEmbeddings } from '@orison/model-protocols';
import { isVectorArmDegraded, type ResolvedModel } from '@orison/shared-contracts';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { ensureEntryVecDim, getCurrentVecDim } from './closureIndexer';
import { getCurrentCraftVecDim } from './craftVecDim';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import { reindexAllForChangedModel } from '../ipc/configIpc';
import { runWithEmbeddingSweepGate, isEmbeddingSweepInflight } from './embeddingSweepGate';
import { getLogger } from '../logger';

// CR-T2-005：扫闸查询面经本模块再导出（dispatch 约定 reconcile 是查询函数的挂点；实现在
// ./embeddingSweepGate——见该模块 docstring 的防环说明）。
export { isEmbeddingSweepInflight };

/**
 * dogfood #39（T2 Batch C1，2026-08-25）——embedding 派生索引启动对账。
 *
 * 根因链（台账 #39 实录）：换 embedding 模型 → `config:save-model` 触发
 * `reindexAllForChangedModel` 自动重建 → dim probe 失败（dev 断连/主进程未重启时段）→
 * warn「left as-is」**无重试、无 UI 信号** → 向量臂静默 FTS-only。唯一自愈路径是
 * 「下次换模型再触发 designation 比对」——看运气的半吊子自愈，正是本模块要消灭的。
 *
 * 机制（dispatch 拍板的 a 案「启动再扫」；b 案失败重试不另做——亚启动粒度的瞬时抖动
 * 由下次启动兜底，FTS-only 是设计内降级，损失有界；理由详见 task implement.md Batch C）：
 * app 启动时（main/index.ts，链在 craft KB 启动扫描之后串行 embed 流量）检测
 * 「已配置 embedding 模型 ↔ 派生向量表实际状态」失配 → 自动重跑重建扫。等于把
 * designation 比对的触发点从「save-model 时」扩到「每次启动」。
 *
 * 判定 = `isVectorArmDegraded`（shared-contracts 单源谓词，与 `closure:index-status`
 * 状态面同一判定——自动触发与 UI 信号不漂移）：
 * - pending 积压（content_hash IS NULL 的行，含 #39 实录的「重建失败后全行改写为
 *   pending、provenance 归 NULL」形态——纯 provenance 比对抓不到该形态，pending 是
 *   必要信号）；
 * - 存量 provenance 含其他模型（几何空间失效；含 auto-detect 换启用模型这类不经
 *   designation 比对的静默漂移路径）。
 *
 * 修复形态两档：
 * - stale 时先**单次探测**当前模型实际输出维度并 `ensureEntryVecDim` 修正共享 `entry_vec`
 *   表维度——表级 dim 错着时任何逐行重嵌都过不了维度门（#39 的核心僵死态），且纯卡项目
 *   走不到 `reindexAll` 的探测点（F2 缺口），这里补上唯一入口。
 * - **force 分档**：存量含其他模型 → force 全量重嵌（授权迁移语义）；仅 pending 积压、
 *   模型一致 → force=false，健康行 hash-skip 零成本只重试待补行（dim 修正刚清过 hash
 *   的行自然全部成为待补行，收敛性不受影响）。
 *
 * F1 增补：降级判定纳入**实测表维度对账**——entry_vec / closure_craft_vec 两张向量表服务
 * 同一配置模型，但各自独立迁移，实测维度（CREATE DDL 里的 float[N]）互相矛盾 = 至少一侧
 * 没跟上模型迁移，行面 pending/model 信号可以全干净。维度定谳以实测表 DDL 为准，记账/meta
 * 值与实际表维度可能漂移，单看一张表（或任何记录值）当定谳会漏掉另一张的残留。
 *
 * 防重复触发/启动风暴（dispatch 注意事项）：主进程 `app.whenReady()` 只跑一次（无
 * React StrictMode 双调面——那是渲染层效应），fire-and-forget 不阻启动；每启动至多一扫；
 * 探测失败即放弃本次（warn 留痕，重建也必失败，不空跑全扫），下次启动再试。
 *
 * 范式判据 (ADR-3)：计数/比对/维度修正是纯代码机械；零语义判断。
 */

/** 探测文本——内容无关，只要模型原生输出维度（mirror reindexAll 的 probe 惯例）。 */
const DIM_PROBE_TEXT = 'embedding-dim-probe';

/**
 * 单次 embed 探测模型输出维度。mirror closureIndexer.defaultEmbed 的 CR-06 超时护栏：
 * 30s AbortSignal.timeout，挂死端点不得挂死启动对账。
 */
async function probeEmbeddingDim(model: ResolvedModel): Promise<number> {
  const res = await generateEmbeddings(
    model,
    { input: [DIM_PROBE_TEXT] },
    { signal: AbortSignal.timeout(30_000) },
  );
  return res.embeddings[0]?.length ?? 0;
}

/** 全库信号（story 全项目 + craft 全局）。表缺失/db 不可用 → null（无东西可对账）。 */
type ReconcileSignals = {
  storyPending: number;
  craftPending: number;
  storyModels: string[];
  craftModels: string[];
};

function readSignals(): ReconcileSignals | null {
  try {
    const db = getDb();
    const storyPending = (
      db.prepare('SELECT COUNT(*) AS n FROM closure_entry WHERE content_hash IS NULL').get() as
        | { n: number }
        | undefined
    )?.n;
    const craftPending = (
      db
        .prepare('SELECT COUNT(*) AS n FROM closure_craft_entry WHERE content_hash IS NULL')
        .get() as { n: number } | undefined
    )?.n;
    const storyModels = (
      db.prepare('SELECT DISTINCT model FROM closure_entry WHERE model IS NOT NULL').all() as Array<{
        model: string;
      }>
    ).map((r) => r.model);
    const craftModels = (
      db
        .prepare('SELECT DISTINCT model FROM closure_craft_entry WHERE model IS NOT NULL')
        .all() as Array<{ model: string }>
    ).map((r) => r.model);
    return {
      storyPending: Number(storyPending ?? 0),
      craftPending: Number(craftPending ?? 0),
      storyModels,
      craftModels,
    };
  } catch (err) {
    // CR-T2-015：区分「库/表真读不了」与「尚未索引」。catch 只在 db 异常（表损坏/库关闭/
    // db 不可用）时到达——表未建时 prepare/get 返回空而非抛。warn 留痕让静默失效可观测；
    // 返回 null 的语义不变（无东西可对账，调用方 info 路径保留给真正「尚无派生表」形态）。
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'embedding reconcile: derived-index signals unreadable (db error, not "nothing indexed")',
    );
    return null;
  }
}

/**
 * 启动对账入口（fire-and-forget，永不抛——调用方 belt-and-suspenders catch 亦在）。
 * 见模块 docstring 的机制说明。
 */
export async function reconcileEmbeddingIndexOnStartup(): Promise<void> {
  const log = getLogger();
  if (!isSqliteVecAvailable()) {
    // 无向量扩展 = 结构性无向量臂（entry_vec 表都不存在），pending 是常态且重建不可治——
    // 不触发（每次启动空跑探测 + 全员必败重试没有意义）。
    log.info('embedding reconcile: sqlite-vec unavailable — no vector arm, nothing to reconcile');
    return;
  }
  const model = resolveEmbeddingModel();
  if (!model) {
    log.info('embedding reconcile: no embedding model configured — FTS-only is the expected state');
    return;
  }
  const signals = readSignals();
  if (!signals) {
    log.info('embedding reconcile: derived tables unavailable — nothing indexed yet');
    return;
  }
  // F1：实测表维度对账（纯 db 读，零网络——健康态不引入探测成本）。两张向量表的 float[N]
  // 互相矛盾即视为维度漂移，按维度变化语义走迁移扫（迁移扫内 reindexAllCraft 自带探测 +
  // 按探测维度重建——结构修复点在那边）。
  const db = getDb();
  const previousDim = getCurrentVecDim(db);
  const craftVecDim = getCurrentCraftVecDim(db);
  const craftDimDrifted = previousDim !== null && craftVecDim !== null && craftVecDim !== previousDim;
  const storyDegraded = isVectorArmDegraded({
    configuredModelId: model.modelId,
    pending: signals.storyPending,
    storedModels: signals.storyModels,
  });
  const craftDegraded = isVectorArmDegraded({
    configuredModelId: model.modelId,
    pending: signals.craftPending,
    storedModels: signals.craftModels,
  });
  if (!storyDegraded && !craftDegraded && !craftDimDrifted) {
    log.info(
      {
        model: model.modelId,
        storyPending: signals.storyPending,
        craftPending: signals.craftPending,
      },
      'embedding reconcile: derived vector index healthy — no rebuild needed',
    );
    return;
  }

  // Stale：上次模型迁移/重建失败的余波（或离线积压）。先单探测修正 entry_vec 表维度
  // （#39 僵死态的唯一解锁点），再重跑重建扫。
  let probedDim: number;
  try {
    probedDim = await probeEmbeddingDim(model);
    // 空向量载荷（embeddings:[]）= 端点畸形响应——按探测失败处理，不得拿 0 维去
    // 重建 entry_vec（float[0] 退化表）。
    if (!Number.isFinite(probedDim) || probedDim < 1) {
      throw new Error(`embedding endpoint returned an empty/invalid vector (dim=${probedDim})`);
    }
  } catch (err) {
    // 探测失败（端点断/key 坏）= 此刻重建必失败——不空跑全扫（每项目逐行 embed 全失败
    // 只是刷屏），warn 留痕，下次启动再试。这正是本机制替代的「等下次换模型」运气的
    // 确定性版本。
    log.warn(
      { err: err instanceof Error ? err.message : String(err), model: model.modelId },
      'embedding reconcile: dim probe failed — rebuild deferred to next launch (dogfood #39)',
    );
    return;
  }
  const dimFixed = ensureEntryVecDim(db, probedDim);
  // force 分档：存量含其他模型（几何空间失效）→ 全量重嵌；仅 pending 积压、模型一致 →
  // 只重试待补行。注意 ensureEntryVecDim 刚 DROP 过表时全库 hash 已清（E1），所有行都
  // 是待补行——force=false 语义不受影响。
  const force =
    signals.storyModels.some((m) => m !== model.modelId) ||
    signals.craftModels.some((m) => m !== model.modelId);
  log.warn(
    {
      model: model.modelId,
      probedDim,
      previousDim,
      craftVecDim,
      craftDimDrifted,
      dimFixed,
      force,
      storyPending: signals.storyPending,
      craftPending: signals.craftPending,
    },
    'embedding reconcile: stale vector index detected — re-running rebuild sweep (dogfood #39)',
  );
  // CR-T2-005：扫全程置闸（手动重建/save-model 触发点查 isEmbeddingSweepInflight 互斥——
  // 并发重嵌竞争 entry_vec DROP/重建）。configuredModelId 透传给扫内 craft 分档谓词
  // （CR-T2-003①，本函数已解析的模型单源，免 configIpc 反向 import modelGatewayIpc 成环）。
  await runWithEmbeddingSweepGate(() =>
    reindexAllForChangedModel({ force, configuredModelId: model.modelId }),
  );
  log.info({ force }, 'embedding reconcile: rebuild sweep finished');
}
