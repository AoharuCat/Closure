import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  DeconCanonEntry,
  DeconChapterFacts,
  DeconDictionary,
  DeconEntity,
  DeconJob,
  DeconProductRow,
  DeconReportRow,
  DeconReviewRow,
} from '@orison/shared-contracts';
import { deconMaterialRef, parseDeconMaterialRef } from '@orison/shared-contracts';

// E10.3a W1+W2：拆解表族 repository 往返 + createDeconJob 编排（在途守卫/P1 继承/双指纹
// stale/done 幂等）+ 级联四清。ABI 门控 + throwaway home（mirror closureCraftCardRepository.test.ts）。
// 测试间用 deleteDeconProductsByMaterial / 直删清残留（材料级行会跨 job 影响后续 create 断言）。
// E10.3b W1：+ child B 三表（product/report/review）往返 + 写侧 zod 门 + 级联三处
// （deleteDeconJobCascade / materials:delete / resetDeconRerunState——stale→rerun 复位语义）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-decon-repo');

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
}));

vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));

import { closeDb, getDb } from '../main/db/index';
import { isSqliteVecAvailable, resetSqliteVecState } from '../main/db/sqliteVecLoader';
import {
  deleteDeconJobCascade,
  deleteDeconProductsByMaterial,
  findInflightDeconJobByMaterial,
  getDeconChapterFacts,
  getDeconDictionary,
  getDeconJob,
  getDeconPassState,
  getDeconProduct,
  getDeconReport,
  getDeconReview,
  listDeconChapterFacts,
  listDeconEntities,
  listDeconJobs,
  listDeconJobsByMaterial,
  listDeconPassStates,
  listDeconProducts,
  listDeconReportMetas,
  listDeconReviews,
  replaceDeconEntities,
  resetDeconRerunState,
  upsertDeconChapterFacts,
  upsertDeconDictionary,
  upsertDeconJob,
  upsertDeconPassState,
  upsertDeconProduct,
  upsertDeconReport,
  upsertDeconReview,
} from '../main/db/closure-decon';
import {
  deleteDeconCanonEntriesByMaterial,
  listDeconCanonEntries,
  replaceDeconCanonEntries,
} from '../main/db/closure-canon';
import { registerInflightDeconPipeline } from '../main/decon/deconInflight';
import {
  checkDeconJobFreshness,
  confirmDeconRerun,
  createDeconJob,
  decideDeconPassReentry,
  hashDeconDictionaryOutput,
  hashDeconEntitiesOutput,
  hashDeconFactsOutput,
  startDeconJob,
  transitionDeconJob,
} from '../main/decon/deconJob';

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
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

// ── fixtures ──

const MAT_ID = 'mat-000000000001';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'1'.repeat(64)}`;
const DERIVED_HASH = `sha256:${'2'.repeat(64)}`;
const OTHER_DERIVED_HASH = `sha256:${'3'.repeat(64)}`;

const FP = { materialContentHash: CONTENT_HASH, derivedHash: DERIVED_HASH };
const FP_OTHER = {
  materialContentHash: CONTENT_HASH,
  derivedHash: OTHER_DERIVED_HASH,
};
const NOW = new Date('2026-09-05T10:00:00.000Z');
const deps = { readCurrentFingerprints: () => ({ ...FP }), now: () => NOW };
const depsOther = {
  readCurrentFingerprints: () => ({ ...FP_OTHER }),
  now: () => NOW,
};

function insertMaterialRow(
  over: {
    materialId?: string;
    status?: string;
    chaptersJson?: string;
    contentHash?: string;
  } = {},
): void {
  const chapters =
    over.chaptersJson ??
    JSON.stringify(
      [0, 1, 2].map((i) => ({
        index: i,
        title: `第${i + 1}章`,
        charStart: i * 3000,
        charEnd: (i + 1) * 3000,
        paraStart: i * 10,
        paraEnd: (i + 1) * 10,
        confidence: 'high',
        method: 'regex',
      })),
    );
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO closure_material
         (material_id, scope, project_id, kind, name, source_path, format, provenance_json,
          quality_json, chapters_json, chunk_spans_json, content_hash, char_count, status, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
    )
    .run(
      over.materialId ?? MAT_ID,
      'global',
      null,
      'prose',
      '测试小说',
      'book.txt',
      'txt',
      JSON.stringify({
        medium: 'novel_text',
        tier: 'original',
        sourcePath: 'book.txt',
        via: 'direct-read',
        extractor: 'builtin-text',
        ingestedAt: '2026-09-05T00:00:00.000Z',
        author: null,
        lang: null,
        originDate: null,
        description: null,
      }),
      JSON.stringify({
        ok: true,
        scanned: false,
        nonUtf8: false,
        parseNotes: [],
        charCount: 9000,
        chapterDetection: {
          method: 'regex',
          confidence: 'high',
          matchedFormats: [],
        },
      }),
      chapters,
      '[]',
      over.contentHash ?? CONTENT_HASH,
      9000,
      over.status ?? 'ready',
    );
}

function mkFacts(synopsis: string): DeconChapterFacts['facts'] {
  return {
    synopsis,
    entities: [
      {
        name: '李三',
        type: 'person',
        span: {
          chapterIndex: 0,
          charStart: 0,
          charEnd: 2,
          paraStart: 0,
          paraEnd: 1,
        },
      },
    ],
    events: [
      {
        what: '挖出旧物',
        span: {
          chapterIndex: 0,
          charStart: 10,
          charEnd: 30,
          paraStart: 1,
          paraEnd: 2,
        },
        kernel: true,
      },
    ],
    relationshipEdges: [
      {
        from: '李三',
        to: '王五',
        kind: '师徒',
        span: {
          chapterIndex: 0,
          charStart: 40,
          charEnd: 60,
          paraStart: 2,
          paraEnd: 3,
        },
      },
    ],
    foreshadowPlanted: [
      {
        hint: '旧物来历不明',
        span: {
          chapterIndex: 0,
          charStart: 70,
          charEnd: 90,
          paraStart: 3,
          paraEnd: 4,
        },
      },
    ],
    infoGap: [
      {
        type: '悬疑未知',
        span: {
          chapterIndex: 0,
          charStart: 100,
          charEnd: 120,
          paraStart: 4,
          paraEnd: 5,
        },
      },
    ],
  };
}

function mkEntity(canonicalName: string): DeconEntity {
  return {
    materialRef: MAT_REF,
    derivedHash: DERIVED_HASH,
    canonicalName,
    type: 'person',
    aliases: canonicalName === '李三' ? ['三哥'] : [],
    mentions: [{ chapterIndex: 0, count: 3 }],
    audit: { typeVotes: { person: 3 } },
  };
}

function mkCanonEntry(
  name: string,
  domain: DeconCanonEntry['domain'],
  over: Partial<DeconCanonEntry> = {},
): DeconCanonEntry {
  return {
    jobId: 'decon-00000000000a',
    domain,
    name,
    payload: { evidence: 'inferred', summary: `${name} 概要` },
    anchors: [{ chapterIndex: 0, charStart: 0, charEnd: 20, paraStart: 0, paraEnd: 1 }],
    provenance: { source: 'decon', materialId: MAT_ID, bookTitle: '测试小说' },
    ...over,
  };
}

/** 直插 job 行（绕 createDeconJob 的在途守卫——B 三表纯往返/复位测试不依赖编排面）。 */
function mkJobRow(jobId: string): DeconJob {
  return {
    jobId,
    materialRef: MAT_REF,
    tier: 'coarse',
    dimensions: [],
    status: 'pending',
    budget: { totalTokens: null, perPass: {} },
    cost: { totalTokens: 0, calls: 0, byPass: {}, estimated: true },
    materialContentHash: CONTENT_HASH,
    derivedHash: DERIVED_HASH,
    error: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
}

beforeAll(() => {
  if (sqliteUsable) {
    rmBestEffort(TEST_HOME);
    getDb(); // 触发 initSchema（六表建表验证即首轮往返）。
  }
});

afterAll(() => {
  clean();
});

const maybe = sqliteUsable ? describe : describe.skip;

maybe('deconMaterialRef / parseDeconMaterialRef（轨+id 拼装往返）', () => {
  it('global / project 两轨往返 + 坏形 null', () => {
    const g = deconMaterialRef({
      scope: 'global',
      projectId: null,
      materialId: MAT_ID,
    });
    expect(g).toBe(`global:${MAT_ID}`);
    expect(parseDeconMaterialRef(g)).toEqual({
      scope: 'global',
      projectId: null,
      materialId: MAT_ID,
    });
    const p = deconMaterialRef({
      scope: 'project',
      projectId: '00123',
      materialId: MAT_ID,
    });
    expect(p).toBe(`project:00123:${MAT_ID}`);
    expect(parseDeconMaterialRef(p)).toEqual({
      scope: 'project',
      projectId: '00123',
      materialId: MAT_ID,
    });
    expect(parseDeconMaterialRef('nonsense')).toBeNull();
  });
});

maybe('closure_decon_job / pass_state 往返', () => {
  it('job upsert → get/list 全字段往返（含双指纹/error/维度）', () => {
    const job: DeconJob = {
      jobId: 'decon-aaaaaaaaaaaa',
      materialRef: MAT_REF,
      tier: 'fine',
      dimensions: ['qidaigan', 'jiegou'],
      status: 'capped',
      budget: { totalTokens: 100_000, perPass: { p1b: 50_000 } },
      cost: {
        totalTokens: 101_000,
        calls: 7,
        byPass: { p1b: { tokens: 60_000, calls: 5 } },
        estimated: true,
      },
      materialContentHash: CONTENT_HASH,
      derivedHash: DERIVED_HASH,
      error: '预算超限挂起',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T11:00:00.000Z',
    };
    upsertDeconJob(job);
    expect(getDeconJob(job.jobId)).toEqual(job);
    expect(listDeconJobsByMaterial(MAT_ID).map((j) => j.jobId)).toContain(job.jobId);
    expect(listDeconJobs()).toHaveLength(1);
    deleteDeconProductsByMaterial(MAT_ID);
  });

  it('pass_state upsert → get/list（UNIQUE(job_id,pass,unit) 冲突替换）', () => {
    const base = {
      jobId: 'decon-aaaaaaaaaaaa',
      pass: 'p1b',
      unit: '3',
      status: 'done' as const,
      outputRef: 'facts:3',
      outputHash: `sha256:${'a'.repeat(64)}`,
      updatedAt: '2026-09-05T10:00:00.000Z',
    };
    upsertDeconPassState(base);
    upsertDeconPassState({
      ...base,
      status: 'running',
      outputRef: null,
      outputHash: null,
    });
    expect(getDeconPassState(base.jobId, 'p1b', '3')).toMatchObject({
      status: 'running',
      outputRef: null,
    });
    upsertDeconPassState({ ...base, pass: 'p4:qidaigan', unit: 'qidaigan' });
    expect(listDeconPassStates(base.jobId)).toHaveLength(2);
    getDb().prepare('DELETE FROM closure_decon_pass_state WHERE job_id=?').run(base.jobId);
  });

  it('inflight 守卫查询：pending→running→done 全程在途，done 后清零', () => {
    insertMaterialRow();
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(findInflightDeconJobByMaterial(MAT_ID)?.jobId).toBe(created.job.jobId);
    expect(transitionDeconJob(created.job.jobId, 'start', undefined, deps).ok).toBe(true);
    expect(findInflightDeconJobByMaterial(MAT_ID)?.jobId).toBe(created.job.jobId);
    expect(transitionDeconJob(created.job.jobId, 'finish', undefined, deps).ok).toBe(true);
    expect(findInflightDeconJobByMaterial(MAT_ID)).toBeNull();
    deleteDeconProductsByMaterial(MAT_ID);
  });
});

maybe('事实层三表 + canon 往返', () => {
  it('facts upsert → get/list（同指纹同章替换；异指纹隔离 F-07 键控）', () => {
    upsertDeconChapterFacts({
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 0,
      facts: mkFacts('第一章一句话'),
    });
    upsertDeconChapterFacts({
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 1,
      facts: mkFacts('第二章一句话'),
    });
    upsertDeconChapterFacts({
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 0,
      facts: mkFacts('第一章重写'),
    });
    expect(getDeconChapterFacts(MAT_REF, DERIVED_HASH, 0)?.facts.synopsis).toBe('第一章重写');
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(2);
    expect(listDeconChapterFacts(MAT_REF, OTHER_DERIVED_HASH)).toHaveLength(0);
  });

  it('entity replaceDeconEntities 整组替换（重算不留 stale 行）', () => {
    replaceDeconEntities(MAT_REF, DERIVED_HASH, [mkEntity('李三'), mkEntity('王五')]);
    expect(
      listDeconEntities(MAT_REF, DERIVED_HASH)
        .map((e) => e.canonicalName)
        .sort(),
    ).toEqual(['李三', '王五']);
    replaceDeconEntities(MAT_REF, DERIVED_HASH, [mkEntity('李三')]);
    expect(listDeconEntities(MAT_REF, DERIVED_HASH)).toHaveLength(1);
  });

  it('dictionary upsert → get（异指纹隔离）', () => {
    const dict: DeconDictionary = {
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      entries: [
        { name: '李三', type: 'person', confidence: 0.9 },
        { name: '青云观', type: 'place', confidence: 0.7 },
      ],
    };
    upsertDeconDictionary(dict);
    expect(getDeconDictionary(MAT_REF, DERIVED_HASH)).toEqual(dict);
    expect(getDeconDictionary(MAT_REF, OTHER_DERIVED_HASH)).toBeNull();
  });

  it('canon per (job,domain) 全量替换 + 域过滤清单 + json_extract 按材料清', () => {
    const jobId = 'decon-00000000000a';
    replaceDeconCanonEntries(jobId, 'world', [
      mkCanonEntry('大陆', 'world'),
      mkCanonEntry('魔道', 'world'),
    ]);
    replaceDeconCanonEntries(jobId, 'timeline', [
      mkCanonEntry('主线', 'timeline', {
        payload: { evidence: 'exact', consistency: 'intentional_loose' },
      }),
    ]);
    expect(listDeconCanonEntries(jobId, 'world')).toHaveLength(2);
    expect(listDeconCanonEntries(jobId)).toHaveLength(3);
    replaceDeconCanonEntries(jobId, 'world', [mkCanonEntry('大陆', 'world')]);
    expect(listDeconCanonEntries(jobId, 'world')).toHaveLength(1);
    expect(listDeconCanonEntries(jobId)).toHaveLength(2);
    deleteDeconCanonEntriesByMaterial(MAT_ID);
    expect(listDeconCanonEntries(jobId)).toHaveLength(0);
    // 材料级三表清残留（后续 create 断言 inheritedP1=false 的前提）。
    deleteDeconProductsByMaterial(MAT_ID);
  });
});

maybe('createDeconJob 编排（P0 落库）', () => {
  it('material-not-found / material-not-ready（F-12 low-confidence 与零章拒绝）', () => {
    const missing = createDeconJob({ materialId: 'mat-ffffffffffff', tier: 'coarse' }, deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('material-not-found');

    insertMaterialRow({ status: 'low-confidence' });
    const lowConf = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(lowConf.ok).toBe(false);
    if (!lowConf.ok) expect(lowConf.error).toBe('material-not-ready');

    insertMaterialRow({ chaptersJson: '[]' });
    const zeroChapter = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(zeroChapter.ok).toBe(false);
    if (!zeroChapter.ok) expect(zeroChapter.error).toBe('material-not-ready');

    insertMaterialRow(); // 恢复 ready 3 章。
  });

  it('invalid-dimensions：coarse 带维度 / fine 空（档位 × 维度约束在 create 前置）', () => {
    const coarseWithDim = createDeconJob(
      { materialId: MAT_ID, tier: 'coarse', dimensions: ['d1'] },
      deps,
    );
    expect(coarseWithDim.ok).toBe(false);
    if (!coarseWithDim.ok) expect(coarseWithDim.error).toBe('invalid-dimensions');
    const fineEmpty = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: [] }, deps);
    expect(fineEmpty.ok).toBe(false);
    if (!fineEmpty.ok) expect(fineEmpty.error).toBe('invalid-dimensions');
  });

  it('成功落库 pending + 在途守卫：二连 create 拒绝并指向在途 job id（F-11）', () => {
    const first = createDeconJob(
      { materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.job.jobId).toMatch(/^decon-[0-9a-f]{12}$/);
    expect(first.job.status).toBe('pending');
    expect(first.job.materialRef).toBe(MAT_REF);
    expect(first.job.materialContentHash).toBe(CONTENT_HASH);
    expect(first.job.derivedHash).toBe(DERIVED_HASH);
    expect(first.job.budget).toEqual({ totalTokens: null, perPass: {} });
    expect(first.job.cost).toEqual({
      totalTokens: 0,
      calls: 0,
      byPass: {},
      estimated: true,
    });
    expect(first.inheritedP1).toEqual({ p1a: false, p1b: false, p1c: false });

    const second = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe('inflight-exists');
      expect(second.inflightJobId).toBe(first.job.jobId);
    }
    deleteDeconProductsByMaterial(MAT_ID);
  });

  it('P1 材料级继承（F-07）：同指纹三表产物 → pass 预标 done；断点重入判定 skip', () => {
    const dict: DeconDictionary = {
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      entries: [{ name: '李三', type: 'person', confidence: 0.9 }],
    };
    upsertDeconDictionary(dict);
    for (let i = 0; i < 3; i++) {
      upsertDeconChapterFacts({
        materialRef: MAT_REF,
        derivedHash: DERIVED_HASH,
        chapterIndex: i,
        facts: mkFacts(`第${i + 1}章一句话`),
      });
    }
    replaceDeconEntities(MAT_REF, DERIVED_HASH, [mkEntity('李三'), mkEntity('王五')]);

    const created = createDeconJob(
      { materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] },
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.inheritedP1).toEqual({ p1a: true, p1b: true, p1c: true });

    const jobId = created.job.jobId;
    const p1a = getDeconPassState(jobId, 'p1a', 'all');
    expect(p1a?.status).toBe('done');
    expect(p1a?.outputRef).toBe('dictionary:all');
    expect(decideDeconPassReentry(p1a, hashDeconDictionaryOutput(dict))).toBe('skip');
    for (let i = 0; i < 3; i++) {
      const st = getDeconPassState(jobId, 'p1b', String(i));
      expect(st?.status).toBe('done');
      const facts = getDeconChapterFacts(MAT_REF, DERIVED_HASH, i);
      expect(decideDeconPassReentry(st, facts ? hashDeconFactsOutput(facts.facts) : null)).toBe(
        'skip',
      );
    }
    const p1c = getDeconPassState(jobId, 'p1c', 'all');
    expect(p1c?.status).toBe('done');
    expect(
      decideDeconPassReentry(
        p1c,
        hashDeconEntitiesOutput(listDeconEntities(MAT_REF, DERIVED_HASH)),
      ),
    ).toBe('skip');
    expect(decideDeconPassReentry(p1c, `sha256:${'f'.repeat(64)}`)).toBe('rerun');
    deleteDeconProductsByMaterial(MAT_ID);
  });
});

maybe('startDeconJob / stale / confirm-rerun / cancel 编排', () => {
  it('pending → running（start）；running × 在途管线 → no-op；注册表释放后的 running 残留 → 对账重启（CR-1）；暂停后派生被校对 → 重入醒 stale（F-02）→ confirm-rerun 刷新指纹', () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;

    const started = startDeconJob(jobId, deps);
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.job.status).toBe('running');

    // CR-1：running × 注册表有项（真在途管线）→ no-op 不重派。
    const release = registerInflightDeconPipeline(jobId, {
      cancel: () => undefined,
    });
    expect(release).not.toBeNull();
    const reStart = startDeconJob(jobId, deps);
    expect(reStart.ok).toBe(true);
    if (reStart.ok) expect(reStart.noop).toBe(true);
    release?.();

    // CR-1：注册表释放后的 running（无在途）= 假 running 残留 → 对账翻 paused 续跑（非 no-op）。
    const residue = startDeconJob(jobId, deps);
    expect(residue.ok).toBe(true);
    if (residue.ok) {
      expect(residue.noop).toBe(false);
      expect(residue.job.status).toBe('running');
    }

    expect(transitionDeconJob(jobId, 'pause', undefined, deps).ok).toBe(true);
    const staleStart = startDeconJob(jobId, depsOther);
    expect(staleStart.ok).toBe(false);
    if (!staleStart.ok) expect(staleStart.error).toBe('stale-fingerprints');
    expect(getDeconJob(jobId)?.status).toBe('stale');
    expect(getDeconJob(jobId)?.error).toContain('双指纹');

    const staleAgain = startDeconJob(jobId, depsOther);
    expect(staleAgain.ok).toBe(false);
    // stale 态再 start：指纹仍失配 → 持续报 stale 原因（比 invalid-state 更可诊断）；
    // 指纹恢复一致才会走到转移表拒绝（confirm-rerun 前置）。
    if (!staleAgain.ok) expect(staleAgain.error).toBe('stale-fingerprints');

    const confirmed = confirmDeconRerun(jobId, depsOther);
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.job.status).toBe('pending');
      expect(confirmed.job.derivedHash).toBe(OTHER_DERIVED_HASH);
    }
    expect(getDeconJob(jobId)?.status).toBe('pending');
    deleteDeconProductsByMaterial(MAT_ID);
  });

  it('done → start 幂等 no-op（指纹一致返回既有结果；失配仍醒 stale——F-11×F-02 两全）', () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, deps).ok).toBe(true);
    expect(transitionDeconJob(jobId, 'finish', undefined, deps).ok).toBe(true);
    expect(getDeconJob(jobId)?.status).toBe('done');

    const noop = startDeconJob(jobId, deps);
    expect(noop.ok).toBe(true);
    if (noop.ok) {
      expect(noop.noop).toBe(true);
      expect(noop.job.status).toBe('done');
    }

    const staleNoop = startDeconJob(jobId, depsOther);
    expect(staleNoop.ok).toBe(false);
    if (!staleNoop.ok) expect(staleNoop.error).toBe('stale-fingerprints');
    deleteDeconProductsByMaterial(MAT_ID);
  });

  it('cap/fail 诚实挂起 note 落库；capped/failed 可 retry 续跑；cancel 终态；read 侧 checkDeconJobFreshness 失配落 stale', () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, deps).ok).toBe(true);

    const capped = transitionDeconJob(jobId, 'cap', 'p1b 预算超限（pass 累计 61k > 60k）', deps);
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.job.status).toBe('capped');
      expect(capped.job.error).toContain('预算超限');
    }
    const resumed = startDeconJob(jobId, deps);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.job.status).toBe('running');
    expect(getDeconJob(jobId)?.error).toBeNull();

    expect(transitionDeconJob(jobId, 'fail', 'LLM 不可用', deps).ok).toBe(true);
    expect(getDeconJob(jobId)?.status).toBe('failed');
    const retried = startDeconJob(jobId, deps);
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.job.status).toBe('running');

    const cancelled = transitionDeconJob(jobId, 'cancel', undefined, deps);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.job.status).toBe('cancelled');
    expect(startDeconJob(jobId, deps).ok).toBe(false);

    const created2 = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created2.ok).toBe(true);
    if (!created2.ok) return;
    const job2 = getDeconJob(created2.job.jobId)!;
    // CR-9：freshness 判别带原因（fresh / stale）。
    expect(checkDeconJobFreshness(job2, deps)).toEqual({ fresh: true });
    expect(checkDeconJobFreshness(job2, depsOther)).toEqual({
      fresh: false,
      reason: 'stale',
    });
    expect(getDeconJob(job2.jobId)?.status).toBe('stale');
    deleteDeconProductsByMaterial(MAT_ID);
  });
});

maybe('级联四清（F-02——materials:delete 的 repository 面）', () => {
  it('deleteDeconProductsByMaterial 清九表零残留（E10.3b：+ B 三表）；材料行不动（10.1 四清自理材料面）', () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created.ok).toBe(true);
    upsertDeconChapterFacts({
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 0,
      facts: mkFacts('s'),
    });
    replaceDeconEntities(MAT_REF, DERIVED_HASH, [mkEntity('李三')]);
    upsertDeconDictionary({
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      entries: [{ name: '李三', type: 'person', confidence: 0.9 }],
    });
    if (created.ok) {
      expect(startDeconJob(created.job.jobId, deps).ok).toBe(true);
      replaceDeconCanonEntries(created.job.jobId, 'world', [
        mkCanonEntry('大陆', 'world', { jobId: created.job.jobId }),
      ]);
      seedJobBTables(created.job.jobId);
    }

    deleteDeconProductsByMaterial(MAT_ID);
    expect(listDeconJobs()).toHaveLength(0);
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(0);
    expect(listDeconEntities(MAT_REF, DERIVED_HASH)).toHaveLength(0);
    expect(getDeconDictionary(MAT_REF, DERIVED_HASH)).toBeNull();
    if (created.ok) {
      expect(listDeconPassStates(created.job.jobId)).toHaveLength(0);
      expect(listDeconCanonEntries(created.job.jobId)).toHaveLength(0);
      // E10.3b：B 三表（job 键控——经 job 集反查，先于 job 行删除谓词仍有效）。
      expect(listDeconProducts(created.job.jobId)).toHaveLength(0);
      expect(listDeconReportMetas(created.job.jobId)).toHaveLength(0);
      expect(listDeconReviews(created.job.jobId)).toHaveLength(0);
    }
    const mat = getDb()
      .prepare('SELECT COUNT(*) AS n FROM closure_material WHERE material_id=?')
      .get(MAT_ID) as { n: number };
    expect(mat.n).toBe(1);
  });
});

// ── E10.3b W1：child B 三表（product / report / review）repository + 级联 ──

const B_NOW = '2026-09-05T12:00:00.000Z';

/** 合法 P3a 打标 payload（全字段空集 + 一个 other 钩——写侧 zod 门的最小合法形状）。 */
function mkLabelsPayload(): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'other',
        span: {
          chapterIndex: 0,
          charStart: 0,
          charEnd: 9,
          paraStart: 0,
          paraEnd: 1,
        },
      },
    ],
    transitions: [],
    emotionalBeats: [],
    plotPhase: null,
    highlightSpans: [],
    expositionSpans: [],
    arcBoundary: null,
  };
}

/** 合法 P4 findings payload（evidence ≥1——无锚即丢红线的合法半边）。 */
function mkFindingsPayload(): Record<string, unknown> {
  return {
    findings: [
      {
        insight: '开篇三章用人物情感钩立期待',
        elaboration: '钩子在首章出现且第二章回收，间隔短、密度高。',
        evidence: [{ paraRange: { start: 2, end: 5 }, quote: '他想起了师父的话' }],
        craftHint: { category: 'qidaigan' },
      },
    ],
    synthesis: '开篇期待感建立快。',
  };
}

/** 合法 p4:style 14 节风格 payload（纯代码三节在场 + LLM 节 + 锚/来源——E10.3b W3b）。 */
function mkStylePayload(): Record<string, unknown> {
  return {
    sections: {
      voice: '叙述者贴近主角的有限视角。',
      stats: '- 句子长度：均值 18.0 字',
      excerpt: '```text\n原文节选\n```',
      appendix: '来源：《测试小说》（材料 mat-000000000001）。',
    },
    excerptAnchors: [{ chapterIndex: 0, charStart: 0, charEnd: 9, paraStart: 0, paraEnd: 1 }],
    bookTitle: '测试小说',
    materialId: 'mat-000000000001',
  };
}

/** 合法 P3b 弧切分 payload（单弧 + 审计留痕——E10.3b W2 载荷契约）。 */
function mkArcsPayload(): Record<string, unknown> {
  return {
    arcs: [
      {
        index: 0,
        title: '第一卷 初入江湖',
        fromChapter: 0,
        toChapter: 41,
        chapterCount: 42,
        charCount: 58_000,
        origin: 'volume',
      },
    ],
    audit: {
      source: 'volume',
      volumeBoundaries: [{ chapterIndex: 0, title: '第一卷 初入江湖' }],
      candidatesTotal: 0,
      candidatesUsed: 0,
      arcsMerged: 0,
      arcsSplit: 0,
    },
  };
}

/** 合法 P3b 统计族 payload（书/弧/styleStats 三段——E10.3b W2 载荷契约）。 */
function mkStatsPayload(): Record<string, unknown> {
  const dist = (values: number[]): Record<string, number> => {
    const count = values.length;
    if (count === 0) return { count: 0, min: 0, avg: 0, max: 0, sigma: 0 };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((s, v) => s + v, 0) / count;
    const sigma = Math.sqrt(values.reduce((s, v) => s + (v - avg) * (v - avg), 0) / count);
    return { count, min, avg, max, sigma };
  };
  return {
    book: {
      chapterCount: 42,
      charCount: 58_000,
      chapterChars: dist([1400, 1380, 1420]),
      highlightCount: 2,
      highlightChars: dist([120, 160]),
      highlightIntervalChapters: dist([3]),
      hooksByType: { 被迫压力钩: 1, other: 0 },
      transitionsByType: { 阻碍转折: 1, other: 0 },
      emotionalBeatsByType: { 拉扯: 1, 推动: 0 },
      infoGapByType: { 悬疑未知: 1, 信息前置: 0 },
      foreshadowPlantedCount: 3,
      foreshadowDensityPer10k: 0.5,
      expositionChars: dist([200, 300]),
      hookToKernelChapterSpan: dist([0, 2]),
    },
    arcs: [
      {
        index: 0,
        fromChapter: 0,
        toChapter: 41,
        chapterCount: 42,
        charCount: 58_000,
        chapterChars: dist([1400, 1380, 1420]),
        hookCount: 1,
        transitionCount: 1,
        highlightCount: 2,
        emotionalBeatCount: 1,
        infoGapCount: 1,
        foreshadowPlantedCount: 3,
        plotPhaseCounts: { 拉仇恨: 1, 积蓄: 0 },
      },
    ],
    styleStats: {
      sentenceChars: dist([18, 22, 31]),
      paragraphChars: dist([90, 120]),
      dialogueLineRatio: 0.42,
    },
  };
}

function mkProductRow(jobId: string, over: Partial<DeconProductRow> = {}): DeconProductRow {
  return {
    jobId,
    pass: 'p3a',
    unit: '0',
    payload: mkLabelsPayload(),
    updatedAt: B_NOW,
    ...over,
  };
}

function mkReportRow(jobId: string, over: Partial<DeconReportRow> = {}): DeconReportRow {
  return {
    jobId,
    kind: 'chapter_review',
    unit: 'ch:0',
    contentMd: '## 章导读\n开篇做对了什么：立钩快。',
    anchors: [],
    dimension: null,
    updatedAt: B_NOW,
    ...over,
  };
}

function mkReviewRow(
  jobId: string,
  checkpoint: DeconReviewRow['checkpoint'],
  status: DeconReviewRow['status'],
): DeconReviewRow {
  return { jobId, checkpoint, status, note: null, updatedAt: B_NOW };
}

/** 给 job 撒 B 三表行（级联/复位断言的输入面）。 */
function seedJobBTables(jobId: string): void {
  upsertDeconProduct(mkProductRow(jobId));
  upsertDeconProduct(
    mkProductRow(jobId, {
      pass: 'p4:huoke',
      unit: 'ch:0',
      payload: mkFindingsPayload(),
    }),
  );
  upsertDeconReport(mkReportRow(jobId));
  upsertDeconReview(mkReviewRow(jobId, 'dictionary', 'pending'));
  upsertDeconReview(mkReviewRow(jobId, 'canon', 'pending'));
  upsertDeconReview(mkReviewRow(jobId, 'craft', 'off'));
}

maybe('closure_decon_product 往返 + 写侧 zod 门（CR-4 Pattern 单行粒度版）', () => {
  it('p3a labels 合法落库 → get/list 往返（UNIQUE 冲突替换）', () => {
    const jobId = 'decon-bbbbbbbbbbbb';
    upsertDeconJob(mkJobRow(jobId));
    expect(upsertDeconProduct(mkProductRow(jobId))).toBe(true);
    const stored = getDeconProduct(jobId, 'p3a', '0');
    expect(stored?.payload).toEqual(mkLabelsPayload());
    // 同键替换（重跑覆写非并存）。
    expect(upsertDeconProduct(mkProductRow(jobId, { updatedAt: '2026-09-05T13:00:00.000Z' }))).toBe(
      true,
    );
    expect(getDeconProduct(jobId, 'p3a', '0')?.updatedAt).toBe('2026-09-05T13:00:00.000Z');
    expect(listDeconProducts(jobId)).toHaveLength(1);
    deleteDeconJobCascade(jobId);
  });

  it('p4:<dim> findings 合法落库；pass/unit 过滤面', () => {
    const jobId = 'decon-cccccccccccc';
    upsertDeconJob(mkJobRow(jobId));
    upsertDeconProduct(
      mkProductRow(jobId, {
        pass: 'p4:qingxu',
        unit: 'ch:0',
        payload: mkFindingsPayload(),
      }),
    );
    upsertDeconProduct(
      mkProductRow(jobId, {
        pass: 'p4:qingxu',
        unit: 'arc:0',
        payload: mkFindingsPayload(),
      }),
    );
    expect(listDeconProducts(jobId, 'p4:qingxu')).toHaveLength(2);
    expect(listDeconProducts(jobId, 'p4:qingxu', 'arc:0')).toHaveLength(1);
    expect(listDeconProducts(jobId, 'p3a')).toHaveLength(0);
    deleteDeconJobCascade(jobId);
  });

  it('写侧 zod 门：p3b 两行（arcs/stats）E10.3b W2 已登记——合法落库往返', () => {
    const jobId = 'decon-dddddddddddd';
    upsertDeconJob(mkJobRow(jobId));
    const arcsPayload = mkArcsPayload();
    const statsPayload = mkStatsPayload();
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p3b',
          unit: 'arcs',
          payload: arcsPayload,
        }),
      ),
    ).toBe(true);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p3b',
          unit: 'stats',
          payload: statsPayload,
        }),
      ),
    ).toBe(true);
    expect(getDeconProduct(jobId, 'p3b', 'arcs')?.payload).toEqual(arcsPayload);
    expect(getDeconProduct(jobId, 'p3b', 'stats')?.payload).toEqual(statsPayload);
    // p3b 只认 arcs|stats 两 unit 词形——章号形拒收。
    expect(
      upsertDeconProduct(mkProductRow(jobId, { pass: 'p3b', unit: '0', payload: arcsPayload })),
    ).toBe(false);
    deleteDeconJobCascade(jobId);
  });

  it('写侧 zod 门：per-pass unit 词形（CR-19）——p3a 须纯章号 / p4:style 须 all / p4:<dim> 须 ch:N|arc:N|all，错形拒收', () => {
    const jobId = 'decon-d4d4d4d4d4d4';
    upsertDeconJob(mkJobRow(jobId));
    // p3a：章号合法；'all' / 'ch:3'（过全局 envelope 但非本 pass 词形）拒收。
    expect(upsertDeconProduct(mkProductRow(jobId, { unit: '0' }))).toBe(true);
    expect(upsertDeconProduct(mkProductRow(jobId, { unit: 'all' }))).toBe(false);
    expect(upsertDeconProduct(mkProductRow(jobId, { unit: 'ch:3' }))).toBe(false);
    // p4:style：'all' 合法；'ch:3' / 裸章号拒收。
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:style',
          unit: 'all',
          payload: mkStylePayload(),
        }),
      ),
    ).toBe(true);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:style',
          unit: 'ch:3',
          payload: mkStylePayload(),
        }),
      ),
    ).toBe(false);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:style',
          unit: '0',
          payload: mkStylePayload(),
        }),
      ),
    ).toBe(false);
    // p4:<dim>：ch:N / arc:N / all 合法；'arcs' / 'stats' / 裸章号（p3b/p3a 词形串门）拒收。
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:huoke',
          unit: 'ch:3',
          payload: mkFindingsPayload(),
        }),
      ),
    ).toBe(true);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:huoke',
          unit: 'arc:1',
          payload: mkFindingsPayload(),
        }),
      ),
    ).toBe(true);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:huoke',
          unit: 'all',
          payload: mkFindingsPayload(),
        }),
      ),
    ).toBe(true);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:huoke',
          unit: 'arcs',
          payload: mkFindingsPayload(),
        }),
      ),
    ).toBe(false);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:huoke',
          unit: 'stats',
          payload: mkFindingsPayload(),
        }),
      ),
    ).toBe(false);
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:huoke',
          unit: '5',
          payload: mkFindingsPayload(),
        }),
      ),
    ).toBe(false);
    // 错形零落库（只落 5 行合法）。
    expect(listDeconProducts(jobId)).toHaveLength(5);
    deleteDeconJobCascade(jobId);
  });

  it('写侧 zod 门：p4:style 14 节风格 payload（E10.3b W3b 转正）合法落库；坏形/缺纯代码三节拒收；未登记 pass（p6）拒收', () => {
    const jobId = 'decon-d2d2d2d2d2d2';
    upsertDeconJob(mkJobRow(jobId));
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:style',
          unit: 'all',
          payload: mkStylePayload(),
        }),
      ),
    ).toBe(true);
    expect(listDeconProducts(jobId)).toHaveLength(1);
    // 坏形（扁平 sections / 缺纯代码三节 refine）拒收零落库。
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:style',
          unit: 'all',
          payload: { voice: 'x' },
        }),
      ),
    ).toBe(false);
    const missingStats = mkStylePayload();
    delete (missingStats.sections as Record<string, unknown>).stats;
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:style',
          unit: 'all',
          payload: missingStats,
        }),
      ),
    ).toBe(false);
    expect(listDeconProducts(jobId)).toHaveLength(1);
    // 未登记 pass（p6 不落 product 行）拒收。
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p6',
          unit: 'all',
          payload: mkStylePayload(),
        }),
      ),
    ).toBe(false);
    expect(listDeconProducts(jobId)).toHaveLength(1);
    deleteDeconJobCascade(jobId);
  });

  it('写侧 zod 门：p3b payload 形状违约（arcs 缺审计 / stats 坏分布）拒收零落库', () => {
    const jobId = 'decon-d3d3d3d3d3d3';
    upsertDeconJob(mkJobRow(jobId));
    const badArcs = { arcs: mkArcsPayload().arcs }; // 缺 audit
    expect(
      upsertDeconProduct(mkProductRow(jobId, { pass: 'p3b', unit: 'arcs', payload: badArcs })),
    ).toBe(false);
    const badStats = {
      ...mkStatsPayload(),
      book: {
        ...(mkStatsPayload().book as Record<string, unknown>),
        chapterChars: { count: 1, min: -1, avg: 0, max: 0, sigma: 0 },
      },
    };
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p3b',
          unit: 'stats',
          payload: badStats,
        }),
      ),
    ).toBe(false);
    expect(listDeconProducts(jobId)).toHaveLength(0);
    deleteDeconJobCascade(jobId);
  });

  it('写侧 zod 门：payload 形状违约（p3a 缺 span / p4 空 evidence）拒收零落库（防 hash 永不匹配的永久重烧）', () => {
    const jobId = 'decon-eeeeeeeeeeee';
    upsertDeconJob(mkJobRow(jobId));
    const badLabels = { ...mkLabelsPayload(), hooks: [{ type: 'other' }] }; // 缺 span
    expect(upsertDeconProduct(mkProductRow(jobId, { payload: badLabels }))).toBe(false);
    const badFindings = {
      findings: [{ insight: 'x', elaboration: 'y', evidence: [], craftHint: null }],
      synthesis: '',
    };
    expect(
      upsertDeconProduct(
        mkProductRow(jobId, {
          pass: 'p4:huoke',
          unit: 'ch:0',
          payload: badFindings,
        }),
      ),
    ).toBe(false);
    expect(listDeconProducts(jobId)).toHaveLength(0);
    deleteDeconJobCascade(jobId);
  });
});

maybe('closure_decon_report / closure_decon_review 往返', () => {
  it('report upsert → get/meta 清单（kind 过滤；列表不回 contentMd）；坏 kind 拒收', () => {
    const jobId = 'decon-ffffffffffff';
    upsertDeconJob(mkJobRow(jobId));
    expect(upsertDeconReport(mkReportRow(jobId))).toBe(true);
    expect(upsertDeconReport(mkReportRow(jobId, { kind: 'book_reading', unit: 'all' }))).toBe(true);
    const stored = getDeconReport(jobId, 'chapter_review', 'ch:0');
    expect(stored?.contentMd).toContain('章导读');
    const metas = listDeconReportMetas(jobId);
    expect(metas).toHaveLength(2);
    expect(metas.map((m) => m.kind).sort()).toEqual(['book_reading', 'chapter_review']);
    expect(metas[0]).not.toHaveProperty('contentMd'); // meta 投影不带全文
    expect(listDeconReportMetas(jobId, 'chapter_review')).toHaveLength(1);
    // 坏行（kind 越界）写侧拒收——DDL CHECK 的 zod 前置。
    const badKind = 'margin_note' as unknown as DeconReportRow['kind'];
    expect(upsertDeconReport(mkReportRow(jobId, { kind: badKind }))).toBe(false);
    expect(listDeconReportMetas(jobId)).toHaveLength(2);
    deleteDeconJobCascade(jobId);
  });

  it('review upsert → get；listDeconReviews 按管线序（dictionary → canon → craft，非字母序）', () => {
    const jobId = 'decon-909090909090';
    upsertDeconJob(mkJobRow(jobId));
    // 倒序写入（craft 先落）验证 list 排序按常量序。
    upsertDeconReview(mkReviewRow(jobId, 'craft', 'off'));
    upsertDeconReview(mkReviewRow(jobId, 'canon', 'approved'));
    upsertDeconReview(mkReviewRow(jobId, 'dictionary', 'pending'));
    expect(getDeconReview(jobId, 'canon')?.status).toBe('approved');
    expect(listDeconReviews(jobId).map((r) => r.checkpoint)).toEqual([
      'dictionary',
      'canon',
      'craft',
    ]);
    deleteDeconJobCascade(jobId);
  });
});

maybe('级联三处——job 级删除 / stale 重跑复位（E10.3b W1）', () => {
  it('deleteDeconJobCascade：pass_state + B 三表 + job + canon 单事务清零；材料级事实层保留（F-07）', () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, deps).ok).toBe(true);
    upsertDeconChapterFacts({
      materialRef: MAT_REF,
      derivedHash: DERIVED_HASH,
      chapterIndex: 0,
      facts: mkFacts('s'),
    });
    replaceDeconCanonEntries(jobId, 'world', [mkCanonEntry('大陆', 'world', { jobId })]);
    seedJobBTables(jobId);
    upsertDeconPassState({
      jobId,
      pass: 'p1b',
      unit: '0',
      status: 'done',
      outputRef: 'facts:0',
      outputHash: DERIVED_HASH,
      updatedAt: B_NOW,
    });

    deleteDeconJobCascade(jobId);
    expect(getDeconJob(jobId)).toBeNull();
    expect(listDeconPassStates(jobId)).toHaveLength(0);
    expect(listDeconProducts(jobId)).toHaveLength(0);
    expect(listDeconReportMetas(jobId)).toHaveLength(0);
    expect(listDeconReviews(jobId)).toHaveLength(0);
    expect(listDeconCanonEntries(jobId)).toHaveLength(0);
    // 材料级三表保留（其他 job 仍可继承同指纹 P1 产物）。
    expect(listDeconChapterFacts(MAT_REF, DERIVED_HASH)).toHaveLength(1);
    deleteDeconProductsByMaterial(MAT_ID);
  });

  it('stale → confirmDeconRerun：旧 product/report 零残留 + approved 闸门复位 pending + off 常设保留（M2）', () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, deps).ok).toBe(true);
    // p2+ 断点行 + B 三表 + 闸门（dictionary 已确认 / canon 等审 / craft 用户关）。
    upsertDeconPassState({
      jobId,
      pass: 'p2',
      unit: 'world',
      status: 'done',
      outputRef: 'canon:world',
      outputHash: DERIVED_HASH,
      updatedAt: B_NOW,
    });
    upsertDeconPassState({
      jobId,
      pass: 'p1b',
      unit: '0',
      status: 'done',
      outputRef: 'facts:0',
      outputHash: DERIVED_HASH,
      updatedAt: B_NOW,
    });
    seedJobBTables(jobId);
    upsertDeconReview(mkReviewRow(jobId, 'dictionary', 'approved'));

    expect(transitionDeconJob(jobId, 'pause', undefined, deps).ok).toBe(true);
    const staleStart = startDeconJob(jobId, depsOther);
    expect(staleStart.ok).toBe(false);
    if (!staleStart.ok) expect(staleStart.error).toBe('stale-fingerprints');

    const confirmed = confirmDeconRerun(jobId, depsOther);
    expect(confirmed.ok).toBe(true);
    // B 两产物表清零（旧指纹 findings/报告不滞留 UI）。
    expect(listDeconProducts(jobId)).toHaveLength(0);
    expect(listDeconReportMetas(jobId)).toHaveLength(0);
    // 闸门复位：approved → pending（新产物应再过闸）；off 保留（常设配置不因重跑复活）。
    const reviews = listDeconReviews(jobId);
    expect(reviews.map((r) => [r.checkpoint, r.status])).toEqual([
      ['dictionary', 'pending'],
      ['canon', 'pending'],
      ['craft', 'off'],
    ]);
    // p2+ 断点清零、P1 行保留（新指纹下产物现值缺失自然 rerun——CR-5 语义）。
    expect(getDeconPassState(jobId, 'p2', 'world')).toBeNull();
    expect(getDeconPassState(jobId, 'p1b', '0')?.status).toBe('done');
    deleteDeconProductsByMaterial(MAT_ID);
  });

  it('resetDeconRerunState 直测：off 不翻 + pending 保持（复位谓词只打 approved）', () => {
    const jobId = 'decon-0a0a0a0a0a0a';
    upsertDeconJob(mkJobRow(jobId));
    upsertDeconReview(mkReviewRow(jobId, 'dictionary', 'approved'));
    upsertDeconReview(mkReviewRow(jobId, 'canon', 'pending'));
    upsertDeconReview(mkReviewRow(jobId, 'craft', 'off'));
    resetDeconRerunState(jobId, B_NOW);
    const byCheckpoint = new Map(listDeconReviews(jobId).map((r) => [r.checkpoint, r.status]));
    expect(byCheckpoint.get('dictionary')).toBe('pending'); // approved → pending
    expect(byCheckpoint.get('canon')).toBe('pending'); // pending 原样
    expect(byCheckpoint.get('craft')).toBe('off'); // off 常设
    deleteDeconJobCascade(jobId);
  });
});
