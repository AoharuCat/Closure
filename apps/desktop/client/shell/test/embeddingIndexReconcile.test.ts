import { beforeEach, describe, expect, it, vi } from 'vitest';

// dogfood #39（T2 Batch C1/C3，2026-08-25）：embedding 派生索引启动对账。
//
// 剧本：换 embedding 模型 → config:save-model 触发的自动重建扫 dim probe 失败 →
// warn「left as-is」无重试无信号 → 向量臂静默 FTS-only。本模块把「designation 比对」
// 触发点扩到每次启动：stale 判定（isVectorArmDegraded 单源谓词）→ 单探测修 entry_vec
// 表维度 → 重跑重建扫（force 分档）。全部依赖 mock，零网络零真 db。

const {
  getDb,
  isSqliteVecAvailable,
  resolveEmbeddingModel,
  reindexAllForChangedModel,
  ensureEntryVecDim,
  getCurrentVecDim,
  getCurrentCraftVecDim,
  generateEmbeddings,
  warn,
  info,
} = vi.hoisted(() => ({
  getDb: vi.fn(),
  isSqliteVecAvailable: vi.fn(),
  resolveEmbeddingModel: vi.fn(),
  reindexAllForChangedModel: vi.fn(),
  ensureEntryVecDim: vi.fn(),
  getCurrentVecDim: vi.fn(),
  getCurrentCraftVecDim: vi.fn(),
  generateEmbeddings: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../main/db/closureIndexer', () => ({ ensureEntryVecDim, getCurrentVecDim }));
vi.mock('../main/db/craftVecDim', () => ({ getCurrentCraftVecDim }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/db/sqliteVecLoader', () => ({ isSqliteVecAvailable }));
vi.mock('../main/ipc/modelGatewayIpc', () => ({ resolveEmbeddingModel }));
vi.mock('../main/ipc/configIpc', () => ({ reindexAllForChangedModel }));
vi.mock('@orison/model-protocols', () => ({ generateEmbeddings }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import { reconcileEmbeddingIndexOnStartup, isEmbeddingSweepInflight } from '../main/db/embeddingIndexReconcile';

/** 按信号面构造 getDb mock：pending 计数（.get）+ DISTINCT 模型（.all）。 */
function dbMock(signals: {
  storyPending?: number;
  craftPending?: number;
  storyModels?: string[];
  craftModels?: string[];
}) {
  return {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes('FROM closure_craft_entry')) return { n: signals.craftPending ?? 0 };
        if (sql.includes('FROM closure_entry')) return { n: signals.storyPending ?? 0 };
        return { n: 0 };
      },
      all: () => {
        if (sql.includes('FROM closure_craft_entry')) {
          return (signals.craftModels ?? []).map((m) => ({ model: m }));
        }
        if (sql.includes('FROM closure_entry')) {
          return (signals.storyModels ?? []).map((m) => ({ model: m }));
        }
        return [];
      },
    }),
  };
}

function vecOf(dim: number): number[] {
  return new Array(dim).fill(0);
}

describe('reconcileEmbeddingIndexOnStartup (dogfood #39 T2 C1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 健康基线：vec 扩展可用、配置了 embed-m、全库无 pending、存量模型一致、两张向量表实测维度一致（4096）。
    isSqliteVecAvailable.mockReturnValue(true);
    resolveEmbeddingModel.mockReturnValue({ modelId: 'embed-m' });
    getDb.mockReturnValue(dbMock({ storyModels: ['embed-m'], craftModels: ['embed-m'] }));
    getCurrentVecDim.mockReturnValue(4096);
    getCurrentCraftVecDim.mockReturnValue(4096);
    generateEmbeddings.mockResolvedValue({ embeddings: [vecOf(4096)] });
    ensureEntryVecDim.mockReturnValue(false);
    reindexAllForChangedModel.mockResolvedValue(undefined);
  });

  it('未配置模型 → 跳过（FTS-only 是预期态）——不探测不重建', async () => {
    resolveEmbeddingModel.mockReturnValue(null);

    await reconcileEmbeddingIndexOnStartup();

    expect(generateEmbeddings).not.toHaveBeenCalled();
    expect(reindexAllForChangedModel).not.toHaveBeenCalled();
  });

  it('健康态（无 pending、存量模型一致）→ 不探测不重建，只留健康日志', async () => {
    await reconcileEmbeddingIndexOnStartup();

    expect(generateEmbeddings).not.toHaveBeenCalled();
    expect(reindexAllForChangedModel).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'embed-m' }),
      expect.stringContaining('healthy'),
    );
  });

  it('#39 实录形态：pending 积压（provenance 归 NULL）→ 探测修正表维度 + 非 force 重扫', async () => {
    // 台账 #39：重建扫失败后全卡/全文档改写为 pending（content_hash NULL、model NULL），
    // entry_vec 仍是旧模型的 1024 维——纯 provenance 比对抓不到该形态，pending 是必要信号。
    getDb.mockReturnValue(dbMock({ storyPending: 12, storyModels: [], craftModels: [] }));
    getCurrentVecDim.mockReturnValue(1024);

    await reconcileEmbeddingIndexOnStartup();

    // 单探测拿到当前模型真实维度（4096），并修正共享 entry_vec 表维度（#39 僵死态的
    // 唯一解锁点——表级 dim 错着时任何逐行重嵌都过不了维度门）。
    expect(generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(ensureEntryVecDim).toHaveBeenCalledWith(expect.anything(), 4096);
    // 存量无其他模型 → force=false（健康行 hash-skip 零成本，只重试待补行）。configuredModelId
    // 透传给扫内 craft 分档谓词（CR-T2-003①）。
    expect(reindexAllForChangedModel).toHaveBeenCalledWith({ force: false, configuredModelId: 'embed-m' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ force: false, storyPending: 12 }),
      expect.stringContaining('stale vector index'),
    );
  });

  it('存量含其他模型（几何空间失效）→ force 全量重扫', async () => {
    getDb.mockReturnValue(dbMock({ storyModels: ['embed-m', 'embed-old'] }));

    await reconcileEmbeddingIndexOnStartup();

    expect(reindexAllForChangedModel).toHaveBeenCalledWith({ force: true, configuredModelId: 'embed-m' });
  });

  it('craft 侧降级（craft pending / craft 存量模型不符）也触发重扫', async () => {
    getDb.mockReturnValue(dbMock({ craftPending: 3, storyModels: ['embed-m'], craftModels: ['embed-m'] }));

    await reconcileEmbeddingIndexOnStartup();

    expect(reindexAllForChangedModel).toHaveBeenCalledWith({ force: false, configuredModelId: 'embed-m' });
  });

  it('F2：行面信号全健康但两表实测维度矛盾 → 仍触发迁移扫（维度定谳以实测表 DDL 为准）', async () => {
    // 事故形态：entry_vec 已迁 4096、closure_craft_vec 残留旧维度 1024，pending/model 两信号
    // 全干净——单看一张表（或任何记账值）当维度定谳会漏掉另一张的残留。实测维度互相矛盾
    // 即按维度变化语义走迁移扫（扫内 reindexAllCraft 自带探测 + 按探测维度重建）。
    getDb.mockReturnValue(dbMock({ storyModels: ['embed-m'], craftModels: ['embed-m'] }));
    getCurrentVecDim.mockReturnValue(4096);
    getCurrentCraftVecDim.mockReturnValue(1024);

    await reconcileEmbeddingIndexOnStartup();

    expect(reindexAllForChangedModel).toHaveBeenCalledWith({ force: false, configuredModelId: 'embed-m' });
    // 迁移原因可观测：warn 载荷带两表实测维度 + 漂移旗标。
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ previousDim: 4096, craftVecDim: 1024, craftDimDrifted: true }),
      expect.stringContaining('stale vector index'),
    );
  });

  it('dim probe 失败（端点断/key 坏）→ warn 放弃本次，不空跑重建扫（下次启动再试）', async () => {
    getDb.mockReturnValue(dbMock({ storyPending: 5, storyModels: [] }));
    generateEmbeddings.mockRejectedValue(new Error('401 Token is invalid'));

    await reconcileEmbeddingIndexOnStartup();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'embed-m' }),
      expect.stringContaining('dim probe failed'),
    );
    expect(ensureEntryVecDim).not.toHaveBeenCalled();
    expect(reindexAllForChangedModel).not.toHaveBeenCalled();
  });

  it('sqlite-vec 不可用 → 跳过（结构性无向量臂，重建不可治，不空跑）', async () => {
    isSqliteVecAvailable.mockReturnValue(false);

    await reconcileEmbeddingIndexOnStartup();

    expect(resolveEmbeddingModel).not.toHaveBeenCalled();
    expect(reindexAllForChangedModel).not.toHaveBeenCalled();
  });

  it('getDb 抛（派生表缺失/库不可用）→ 不重建、永不 reject；CR-T2-015：warn 区分「库损坏」与「尚未索引」', async () => {
    getDb.mockImplementation(() => {
      throw new Error('no such table: closure_entry');
    });

    await expect(reconcileEmbeddingIndexOnStartup()).resolves.toBeUndefined();
    expect(reindexAllForChangedModel).not.toHaveBeenCalled();
    // CR-T2-015：catch 只在 db 异常时到达——静默吞改为 warn 留痕（调用方的「nothing
    // indexed yet」info 保留给真正空库形态）。
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('derived-index signals unreadable'),
    );
  });

  // ── CR-T2-005（2026-08-25）：扫全程置闸（手动重建/save-model 触发点互斥查）──

  it('CR-T2-005: 扫在途时 sweepInflight=true，扫结束清旗', async () => {
    getDb.mockReturnValue(dbMock({ storyPending: 5, storyModels: [] }));
    let releaseSweep!: () => void;
    reindexAllForChangedModel.mockImplementation(
      () => new Promise<void>((resolve) => { releaseSweep = resolve; }),
    );

    const run = reconcileEmbeddingIndexOnStartup();
    await vi.waitFor(() => expect(isEmbeddingSweepInflight()).toBe(true));

    releaseSweep();
    await run;
    expect(isEmbeddingSweepInflight()).toBe(false);
  });
});
