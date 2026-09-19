import { createHash } from 'node:crypto';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconChapterFacts, DeconFacts, Material } from '@orison/shared-contracts';

// E10.3a W5：P1c 跨章聚合消歧测试——纯函数面（观测构建/聚类三档/桥接阻断/约束式裁决解析）
// + db 编排面（别名归并/类型投票/幻觉过滤 audit 行/集体词丢弃/断点 skip/capped/stale/缺 facts）。
// ABI 门控 + throwaway home（mirror deconP1Extract.test.ts）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-p1c');

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

vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));
vi.mock('@orison/desktop-agent', () => ({ resolveTaskModel: vi.fn(), assignmentThinkingControl: vi.fn() }));
vi.mock('@orison/model-protocols', () => ({ generateText: vi.fn(), generateEmbeddings: vi.fn() }));

import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';
import {
  deleteDeconProductsByMaterial,
  getDeconJob,
  getDeconPassState,
  listDeconEntities,
  upsertDeconChapterFacts,
  upsertDeconJob,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, startDeconJob, transitionDeconJob } from '../main/decon/deconJob';
import { estimateDeconCallTokens } from '../main/decon/deconRun';
import {
  DECON_P1C_ADJUDICATE_MAX_TOKENS,
  DECON_P1C_ADJUDICATE_SYSTEM_PROMPT,
  buildDeconEntityObservations,
  clusterDeconAliasCandidates,
  isDeconEditDistanceAtMostOne,
  majorityDeconObservationType,
  mergeDeconAliasGroups,
  parseDeconAdjudicationResponse,
  runDeconP1c,
  type DeconEntityObservation,
} from '../main/decon/p1Aggregate';
import { composeDerivedText, splitParagraphBlocks } from '../main/ipc/toolHandlers/materialIngest';

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

// ── fixtures（3 章——别名对 赵灵儿/灵儿〔containment〕+ 赵灵儿/赵灵兒〔lev-1〕+ 幻觉名 + 集体词）──

const MAT_ID = 'mat-000000000004';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'c'.repeat(64)}`;

const P1C_BODIES = [
  [
    '李逍遥在青云观的后院醒来，发现自己躺在一张竹床上。',
    '李逍遥想起了师父临走前说的话，山下集市人来人往。',
    '李逍遥买了一坛酒，遇见了赵灵儿，赵灵儿正在溪边唱歌。',
  ].join('\n\n'),
  [
    '赵灵儿约李逍遥去后山看瀑布，灵儿走在前面哼着歌。',
    '瀑布下的水潭边有一块古碑，碑上的字迹已经模糊。',
    '李逍遥伸手触碰古碑，古碑忽然发出了微弱的光。',
  ].join('\n\n'),
  [
    '赵灵兒夜里醒来，听见观外有脚步声，赵灵兒披衣起身。',
    '青云观的老道人找到了他们，说山中有妖物出没。',
    '观中规矩：入夜后不可下山，弟子必须按时回房。',
  ].join('\n\n'),
];

function composeFixture(bodies: readonly string[]): { derived: string; chapters: Material['chapters'] } {
  const normalized = bodies.join('');
  let off = 0;
  const boundaries = bodies.map((body, i) => {
    const start = off;
    off += body.length;
    return { start, end: off, title: `第${i + 1}章` };
  });
  const { derived, spans } = composeDerivedText(normalized, boundaries, 'regex', 'high');
  const chapters: Material['chapters'] = spans.map((s, i) => ({
    index: i,
    title: `第${i + 1}章`,
    charStart: s.charStart,
    charEnd: s.charEnd,
    paraStart: 0,
    paraEnd: 0,
    confidence: 'high',
    method: 'regex',
  }));
  return { derived, chapters };
}

const FIXTURE = composeFixture(P1C_BODIES);
const DERIVED = FIXTURE.derived;
const BLOCKS = splitParagraphBlocks(DERIVED);

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const DERIVED_HASH = sha(DERIVED);
const NOW = new Date('2026-09-05T14:00:00.000Z');
const jobDeps = (derivedHash: string = DERIVED_HASH) => ({
  readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash }),
  now: () => NOW,
});

function mkMaterial(chapters: Material['chapters'] = FIXTURE.chapters): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '聚合测试小说',
    format: 'txt',
    provenance: {
      medium: 'novel_text',
      tier: 'original',
      sourcePath: 'novel.txt',
      via: 'direct-read',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-05T00:00:00.000Z',
      author: null,
      lang: null,
      originDate: null,
      description: null,
    },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: DERIVED.length,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters,
    chunkSpans: [],
    contentHash: CONTENT_HASH,
    status: 'ready',
  };
}

/** 章内块区间 span（真实锚定——块坐标取自派生 .md）。 */
function blockSpan(chapterIndex: number, k: number) {
  const i = chapterIndex * 3 + k;
  return { chapterIndex, charStart: BLOCKS[i]!.start, charEnd: BLOCKS[i]!.end, paraStart: i, paraEnd: i + 1 };
}

function mkFacts(chapterIndex: number, entityNames: Array<[string, string]>): DeconFacts {
  return {
    synopsis: `第${chapterIndex}章概要。`,
    entities: entityNames.map(([name, type]) => ({ name, type: type as DeconFacts['entities'][number]['type'], span: blockSpan(chapterIndex, 0) })),
    events: [{ what: `第${chapterIndex}章事件`, span: blockSpan(chapterIndex, 1), kernel: chapterIndex === 1 }],
    relationshipEdges: [],
    foreshadowPlanted: [],
    infoGap: [],
  };
}

function seedFacts(): void {
  const rows: Array<[number, Array<[string, string]>]> = [
    [0, [['李逍遥', 'person'], ['赵灵儿', 'person'], ['青云观', 'place'], ['幻影真人', 'person'], ['众人', 'person']]],
    [1, [['李逍遥', 'person'], ['赵灵儿', 'person'], ['灵儿', 'person'], ['古碑', 'item']]],
    [2, [['李逍遥', 'person'], ['赵灵兒', 'person'], ['老道人', 'person']]],
  ];
  for (const [ci, names] of rows) {
    const facts = mkFacts(ci, names);
    const row: DeconChapterFacts = { materialRef: MAT_REF, derivedHash: DERIVED_HASH, chapterIndex: ci, facts };
    upsertDeconChapterFacts(row);
  }
}

/** 裁决 mock：对输入候选对全部判 same（赵灵儿/赵灵兒 型异体写法）。 */

beforeAll(() => {
  if (sqliteUsable) {
    rmBestEffort(TEST_HOME);
    getDb();
  }
});

afterAll(() => {
  clean();
});

const maybe = sqliteUsable ? describe : describe.skip;

// ── 纯函数面 ──

describe('isDeconEditDistanceAtMostOne（编辑距离 ≤1）', () => {
  it('异体写法/错字/删一字命中；距离 ≥2 或长度差 ≥2 不命中', () => {
    expect(isDeconEditDistanceAtMostOne('赵灵儿', '赵灵兒')).toBe(true);
    expect(isDeconEditDistanceAtMostOne('李逍遥', '李逍遥')).toBe(true);
    expect(isDeconEditDistanceAtMostOne('青云观', '青云')).toBe(true); // 删一字
    expect(isDeconEditDistanceAtMostOne('赵灵儿', '灵儿')).toBe(true); // 删「赵」= 距离 1（聚类面 containment 先命中同对）
    expect(isDeconEditDistanceAtMostOne('灵儿', '赵灵兒')).toBe(false); // 两字差异
    expect(isDeconEditDistanceAtMostOne('李逍遥', '赵灵儿')).toBe(false);
  });
});

describe('buildDeconEntityObservations（观测聚合）', () => {
  it('集体引用词观测整条丢弃 + 跨章条目数/类型票合并', () => {
    const rows = [
      { materialRef: MAT_REF, derivedHash: DERIVED_HASH, chapterIndex: 0, facts: mkFacts(0, [['李逍遥', 'person'], ['众人', 'person']]) },
      { materialRef: MAT_REF, derivedHash: DERIVED_HASH, chapterIndex: 1, facts: mkFacts(1, [['李逍遥', 'person'], ['李逍遥', 'person']]) },
      { materialRef: MAT_REF, derivedHash: DERIVED_HASH, chapterIndex: 2, facts: mkFacts(2, [['李逍遥', 'place']]) },
    ] as DeconChapterFacts[];
    const { observations, droppedCollective } = buildDeconEntityObservations(rows);
    expect(droppedCollective).toBe(1);
    expect(observations).toHaveLength(1);
    const obs = observations[0]!;
    expect(obs.chapters.get(0)).toBe(1);
    expect(obs.chapters.get(1)).toBe(2);
    expect(obs.typeVotes).toEqual({ person: 3, place: 1 });
    expect(majorityDeconObservationType(obs)).toBe('person'); // 多数票
  });
});

function obs(name: string, chapters: number[], type = 'person'): DeconEntityObservation {
  return {
    name,
    chapters: new Map(chapters.map((ch) => [ch, 1])),
    typeVotes: { [type]: chapters.length },
  };
}

describe('clusterDeconAliasCandidates（三档 + 共现复审 + 同位语通道）', () => {
  it('containment 兼容 → high 自动并；lev-1 兼容 → medium 待裁决', () => {
    const candidates = clusterDeconAliasCandidates([
      obs('赵灵儿', [0, 1]),
      obs('灵儿', [1]),
      obs('赵灵兒', [2]),
    ]);
    const decision = (x: string, y: string) =>
      candidates.decisions.find((d) => (d.a === x && d.b === y) || (d.a === y && d.b === x));
    expect(decision('灵儿', '赵灵儿')).toMatchObject({ tier: 'high', reason: 'containment' });
    expect(decision('赵灵兒', '赵灵儿')).toMatchObject({ tier: 'medium', reason: 'edit-distance-1' });
    expect(candidates.autoPairs).toContainEqual({ a: '灵儿', b: '赵灵儿' });
    expect(candidates.pendingAdjudication.map((p) => p.pairId)).toEqual(['0']);
  });

  it('类型冲突阻断（相似名但归属类型不同 → low 不并——仅存硬阻断之一）', () => {
    const candidates = clusterDeconAliasCandidates([obs('青云观', [0, 1], 'place'), obs('青云观人', [2], 'person')]);
    expect(candidates.decisions[0]).toMatchObject({ tier: 'low', reason: 'type-conflict' });
    expect(candidates.autoPairs).toHaveLength(0);
  });

  it('CR-11：高频同场共现的相似名对改走裁决（medium co-occurrence-review——不再硬阻断）', () => {
    const candidates = clusterDeconAliasCandidates([obs('沙僧', [0, 1, 2]), obs('沙僧八', [0, 1, 2])]);
    expect(candidates.decisions[0]).toMatchObject({ tier: 'medium', reason: 'co-occurrence-review' });
    expect(candidates.autoPairs).toHaveLength(0); // 不自动并——裁判定
    expect(candidates.pendingAdjudication).toHaveLength(1);
  });

  it('CR-11：同位语通道——不相似同型多章共现对（「二郎神/杨戬」型）按强度进 medium 裁决；单章/无共现/异型不进', () => {
    const candidates = clusterDeconAliasCandidates([
      obs('二郎神', [0, 1, 2]),
      obs('杨戬', [1, 2, 3]),
      obs('哪吒', [5]), // 单章——剪枝
      obs('东海龙王', [0, 9]), // 与二郎神共现 1 章（弱）
      obs('灌江口', [0, 1], 'place'), // 异型——排除
    ]);
    const appositions = candidates.decisions.filter((d) => d.reason === 'apposition');
    expect(appositions).toHaveLength(2);
    expect(appositions[0]).toMatchObject({ a: '二郎神', b: '杨戬', tier: 'medium' }); // 强度 2/3 最高在前
    expect(appositions[1]).toMatchObject({ a: '东海龙王', b: '二郎神', tier: 'medium' });
    // 全部进 pendingAdjudication（top-K 内）。
    expect(candidates.pendingAdjudication).toHaveLength(2);
  });

  it('不相似名对不满足通道条件时无判定（天然分离）', () => {
    const candidates = clusterDeconAliasCandidates([obs('李逍遥', [0]), obs('青云观', [0], 'place')]);
    expect(candidates.decisions).toHaveLength(0);
  });
});

describe('mergeDeconAliasGroups（并查集）', () => {
  it('approved 对并组 + 单名独立组；组内/组间字典序', () => {
    const groups = mergeDeconAliasGroups(['李逍遥', '赵灵儿', '灵儿', '古碑'], [
      { a: '灵儿', b: '赵灵儿' },
    ]);
    expect(groups).toEqual([['古碑'], ['李逍遥'], ['灵儿', '赵灵儿']]);
  });
});

describe('parseDeconAdjudicationResponse（约束式解析）', () => {
  const pairIds = new Set(['0', '1']);

  it('合法数组 → Map（漏答对缺省 false 由调用方处理）', () => {
    const verdicts = parseDeconAdjudicationResponse('[{"pairId":"0","sameEntity":true},{"pairId":"1","sameEntity":false}]', pairIds);
    expect(verdicts).not.toBeNull();
    expect(verdicts!.get('0')).toBe(true);
    expect(verdicts!.get('1')).toBe(false);
  });

  it('集外编号 / 坏形状 / 非 JSON / **重复 pairId**（CR-11：重复即裁判错乱）→ null 整体拒收（不部分采纳）', () => {
    expect(parseDeconAdjudicationResponse('[{"pairId":"9","sameEntity":true}]', pairIds)).toBeNull();
    expect(parseDeconAdjudicationResponse('[{"pairId":"0","sameEntity":"yes"}]', pairIds)).toBeNull();
    expect(parseDeconAdjudicationResponse('不是 JSON', pairIds)).toBeNull();
    expect(
      parseDeconAdjudicationResponse('[{"pairId":"0","sameEntity":true},{"pairId":"0","sameEntity":false}]', pairIds),
    ).toBeNull(); // 重复编号静默 last-wins 已废——整体拒收
  });
});

// ── db 编排面 ──

maybe('runDeconP1c（db 编排）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial());
    seedFacts();
  });

  it('happy path：containment 自动并 + lev-1 LLM 裁决并 → canonical 赵灵儿 + 别名/mentions 合并 + 幻觉 audit 行 + 集体词丢弃', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const users: string[] = [];
    const gen = async (input: { system?: string; user: string }): Promise<{ text: string }> => {
      users.push(input.user ?? '');
      return { text: '[{"pairId":"0","sameEntity":true}]' };
    };
    const result = await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.skipped).toBe(false);
    expect(result.stats.adjudicationApproved).toBe(1);
    expect(result.stats.droppedCollective).toBe(1);
    expect(result.stats.hallucinationFiltered).toBe(1);
    expect(result.stats.mergedClusters).toBe(1);

    // 裁决 prompt：约束式候选对输入（review-judge 面——名字对 + 上下文行）。
    expect(users).toHaveLength(1);
    expect(users[0]).toContain('赵灵兒');
    expect(users[0]).toContain('待判定的名字对');

    const entities = listDeconEntities(MAT_REF, DERIVED_HASH);
    const byName = new Map(entities.map((e) => [e.canonicalName, e]));
    // 归并簇：canonical 赵灵儿（总出现次数最高）+ 别名〔灵儿, 赵灵兒〕+ mentions 跨章合并。
    const zhao = byName.get('赵灵儿');
    expect(zhao).toBeDefined();
    expect(zhao?.type).toBe('person');
    expect([...(zhao?.aliases ?? [])].sort()).toEqual(['灵儿', '赵灵兒']);
    expect(zhao?.mentions).toEqual([
      { chapterIndex: 0, count: 1 },
      { chapterIndex: 1, count: 2 },
      { chapterIndex: 2, count: 1 },
    ]);
    expect(zhao?.audit.mergedFrom).toEqual(['灵儿', '赵灵兒']);
    expect(zhao?.audit.typeVotes).toEqual({ person: 4 });
    // 独立实体照旧。
    expect(byName.get('李逍遥')?.aliases).toEqual([]);
    expect(byName.get('青云观')?.type).toBe('place');
    expect(byName.get('古碑')?.type).toBe('item');
    // 幻觉实体：行保留 + audit 标记（下游消费排除面）。
    const phantom = byName.get('幻影真人');
    expect(phantom).toBeDefined();
    expect(phantom?.audit.hallucinationFiltered).toBe(true);
    // 集体词被丢弃（观测面）。
    expect(entities.some((e) => e.canonicalName === '众人')).toBe(false);
    // pass_state done 同事务落库。
    expect(getDeconPassState(jobId, 'p1c', 'all')).toMatchObject({ status: 'done', outputRef: 'entity:all' });
    expect(getDeconJob(jobId)?.cost.byPass.p1c?.calls).toBe(1);
  });

  it('断点重入：二次跑 skip 零 LLM 调用', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const gen = vi.fn(async () => ({ text: '[{"pairId":"0","sameEntity":true}]' }));
    await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(gen).toHaveBeenCalledTimes(1);

    // 二次跑（新 job 同指纹——F-07 继承面在 createDeconJob，此处直跑同 job 模拟重入）。
    const second = await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    if (second.status === 'done') expect(second.skipped).toBe(true);
    expect(gen).toHaveBeenCalledTimes(1); // 零重调（AC8 断点判定面）
  });

  it('capped：小预算裁决挂起（预算门前置不烧 token）→ 调预算续跑完成', async () => {
    // 预算 = 裁决调用预估的确定小值（est 恒数千级）——首调用前必超限，不烧 token。
    const est = estimateDeconCallTokens(DECON_P1C_ADJUDICATE_SYSTEM_PROMPT, 'x', DECON_P1C_ADJUDICATE_MAX_TOKENS);
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', budget: { totalTokens: Math.max(1, est - DECON_P1C_ADJUDICATE_MAX_TOKENS + 1), perPass: {} } }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);

    const gen = vi.fn(async () => ({ text: '[{"pairId":"0","sameEntity":true}]' }));
    const first = await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(first.status).toBe('capped');
    expect(gen).toHaveBeenCalledTimes(0); // 不烧 token
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p1c', 'all')?.status).toBe('capped');

    // 调大预算续跑（capped → retry → running）。
    const jobRow = getDeconJob(jobId);
    expect(jobRow).not.toBeNull();
    if (jobRow === null) return;
    upsertDeconJob({ ...jobRow, budget: { totalTokens: 100_000_000, perPass: {} } });
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const second = await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(second.status).toBe('done');
    expect(gen).toHaveBeenCalledTimes(1);
    expect(listDeconEntities(MAT_REF, DERIVED_HASH).length).toBeGreaterThan(0);
  });

  it('裁决两次整体拒收 → failed 诚实挂起（不硬给归并）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const gen = vi.fn(async () => ({ text: '[{"pairId":"999","sameEntity":true}]' }));
    const result = await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed');
    expect(gen).toHaveBeenCalledTimes(2); // 重试一次
    expect(getDeconJob(jobId)?.status).toBe('failed');
  });

  it('派生 .md 现值 hash ≠ job 快照 → stale（不静默沿用漂移锚点）', async () => {
    const OTHER_HASH = sha(DERIVED + '校对后');
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(OTHER_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(OTHER_HASH)).ok).toBe(true);
    const gen = vi.fn(async () => ({ text: '[]' }));
    const result = await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('stale');
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconJob(jobId)?.status).toBe('stale');
  });

  it('缺 facts（P1b 未跑）→ failed 提示先跑 P1b', async () => {
    deleteDeconProductsByMaterial(MAT_ID); // 清 facts
    upsertMaterialRow(mkMaterial());
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    const gen = vi.fn(async () => ({ text: '[]' }));
    const result = await runDeconP1c(jobId, { generateText: gen, readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('P1b');
    expect(gen).toHaveBeenCalledTimes(0);
  });

  it('pause 翻态后拒绝执行（job 门）——paused 态映射 paused 结果非 failed（事件面不误报）', async () => {
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps()).ok).toBe(true);
    expect(transitionDeconJob(jobId, 'pause').ok).toBe(true);
    const result = await runDeconP1c(jobId, { generateText: vi.fn(), readDerivedText: () => DERIVED, now: () => NOW });
    expect(result.status).toBe('paused'); // 非 running 门拒绝（paused 须先 start/resume；job 行保持 paused 不误翻）
  });
});
