import { createHash } from 'node:crypto';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Material } from '@orison/shared-contracts';

// E10.3a W3：P1a 实体词典预扫描测试——纯函数面（三通道候选召回 / 约束式解析）+ db 编排面
// （落库/重入 skip 零重调/capped 不烧 token/拒收重试/stale/跨 job 继承）。
// ABI 门控 + throwaway home（mirror closureDeconRepository.test.ts）。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-decon-p1a');

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
// deconLlmCore 生产装配链的四个静态依赖全 mock（本文件恒注入 deps.generateText，生产内核零执行；
// mirror deconLlmWiring.test.ts 面——防 desktop-agent barrel 重量级加载）。
vi.mock('@orison/desktop-agent', () => ({ resolveTaskModel: vi.fn(), assignmentThinkingControl: vi.fn() }));
vi.mock('@orison/model-protocols', () => ({ generateText: vi.fn(), generateEmbeddings: vi.fn() }));

import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';
import {
  deleteDeconProductsByMaterial,
  getDeconDictionary,
  getDeconJob,
  getDeconPassState,
} from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { createDeconJob, hashDeconDictionaryOutput, startDeconJob, transitionDeconJob } from '../main/decon/deconJob';
import type { DeconGenerateText } from '../main/decon/deconLlmCore';
import {
  DECON_P1A_CLASSIFY_MAX_TOKENS,
  buildDeconNameCandidates,
  parseDeconDictionaryClassifyResponse,
  runDeconP1a,
} from '../main/decon/p1Dictionary';

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

const MAT_ID = 'mat-000000000002';
const MAT_REF = `global:${MAT_ID}`;
const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;

/** 三通道全命中底稿：ngram（李逍遥×6/青云观×5）、命名（赵灵儿/酒剑仙）、对话（灵儿 PRE×2/李逍遥 POST×2）、排行（张三×2）。 */
const P1A_TEXT = [
  '李逍遥在青云观里醒来。李逍遥揉了揉眼睛，李逍遥的剑还在桌上放着。',
  '青云观的晨钟响了，青云观的老道人开始扫地，青云观的山门外雾气很重。',
  '山下的姑娘名叫赵灵儿，赵灵儿喜欢在溪边唱歌。',
  '李逍遥买了酒回青云观，掌柜笑他：「又是你啊？」李逍遥说道：「再来一坛。」',
  '「你的剑法是谁教的？」李逍遥说道：「梦里学的。」',
  '灵儿说：「山上冷。」灵儿说：「要多穿衣服。」',
  '众人给他起了绰号，唤作酒剑仙。',
  '山下的张三也来打酒，张三笑了两声。',
].join('\n');

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

const NOW = new Date('2026-09-05T12:00:00.000Z');
const jobDeps = (derivedHash: string) => ({
  readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash }),
  now: () => NOW,
});

function mkMaterial(derivedText: string): Material {
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '候选测试小说',
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
      charCount: derivedText.length,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters: [
      {
        index: 0,
        title: '第一章',
        charStart: 0,
        charEnd: derivedText.length,
        paraStart: 0,
        paraEnd: 1,
        confidence: 'high',
        method: 'regex',
      },
    ],
    chunkSpans: [],
    contentHash: CONTENT_HASH,
    status: 'ready',
  };
}

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

describe('buildDeconNameCandidates（纯代码三通道候选）', () => {
  it('三通道召回：ngram/命名/对话/排行 + 别名对（赵灵儿/灵儿）全命中', () => {
    const build = buildDeconNameCandidates(P1A_TEXT);
    const names = build.candidates.map((c) => c.name);
    for (const expected of ['李逍遥', '青云观', '赵灵儿', '灵儿', '酒剑仙', '张三']) {
      expect(names).toContain(expected);
    }
    expect(build.truncated).toBe(0);
  });

  it('停用过滤：候选名不含停用字/停用词', () => {
    const { candidates } = buildDeconNameCandidates(P1A_TEXT);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.name).not.toContain('的');
      expect(c.name).not.toBe('什么');
    }
  });

  it('确定性：同输入两次构建结果相等（频次降序 + 名字升序 tiebreak）', () => {
    expect(buildDeconNameCandidates(P1A_TEXT)).toEqual(buildDeconNameCandidates(P1A_TEXT));
  });

  it('top-N 截断：超预算按频次截断并诚实回报截断数（最高频者保留）', () => {
    const full = buildDeconNameCandidates(P1A_TEXT);
    expect(full.candidates.length).toBeGreaterThanOrEqual(4);
    const capped = buildDeconNameCandidates(P1A_TEXT, 3);
    expect(capped.candidates).toHaveLength(3);
    expect(capped.truncated).toBe(full.candidates.length - 3);
    expect(capped.candidates.map((c) => c.name)).toContain('李逍遥'); // ngram 6 次最高频
  });
});

describe('parseDeconDictionaryClassifyResponse（约束式校验——spec Pattern mirror）', () => {
  const names = new Set(['李逍遥', '青云观', '赵灵儿']);

  it('候选内全合法 → 解析；重复名去重保首', () => {
    const raw =
      '[{"name":"李逍遥","type":"person","confidence":0.9},{"name":"李逍遥","type":"person","confidence":0.5},{"name":"青云观","type":"place","confidence":0.8}]';
    expect(parseDeconDictionaryClassifyResponse(raw, names)).toEqual([
      { name: '李逍遥', type: 'person', confidence: 0.9 },
      { name: '青云观', type: 'place', confidence: 0.8 },
    ]);
  });

  it('自创新名（候选外）→ 整体拒收 null（集外不部分采纳）', () => {
    const raw =
      '[{"name":"李逍遥","type":"person","confidence":0.9},{"name":"不存在的名字","type":"person","confidence":0.9}]';
    expect(parseDeconDictionaryClassifyResponse(raw, names)).toBeNull();
  });

  it('坏形状（枚举外 type / confidence 越界）→ null', () => {
    expect(parseDeconDictionaryClassifyResponse('[{"name":"李逍遥","type":"god","confidence":0.9}]', names)).toBeNull();
    expect(parseDeconDictionaryClassifyResponse('[{"name":"李逍遥","type":"person","confidence":1.5}]', names)).toBeNull();
  });

  it('空数组 = 诚实零实体负判（合法）', () => {
    expect(parseDeconDictionaryClassifyResponse('[]', names)).toEqual([]);
  });

  it('前后缀噪声容忍（首个 [ 到末个 ] 切片）；非 JSON → null', () => {
    const noisy = '以下是分类：\n[{"name":"李逍遥","type":"person","confidence":0.9}]\n完毕';
    expect(parseDeconDictionaryClassifyResponse(noisy, names)).toHaveLength(1);
    expect(parseDeconDictionaryClassifyResponse('no json here', names)).toBeNull();
  });
});

// ── db 编排面 ──

maybe('runDeconP1a（db 编排）', () => {
  beforeEach(() => {
    deleteDeconProductsByMaterial(MAT_ID);
    upsertMaterialRow(mkMaterial(P1A_TEXT));
  });

  it('happy path：分类落库 + pass_state done 同事务 + 重入 skip 零重调 + 跨 job 继承（F-07）', async () => {
    const DERIVED_HASH = sha(P1A_TEXT);
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(DERIVED_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(DERIVED_HASH)).ok).toBe(true);

    const entries = [
      { name: '李逍遥', type: 'person', confidence: 0.97 },
      { name: '青云观', type: 'place', confidence: 0.9 },
    ];
    const gen = vi.fn(async (_input: { slot: string; user: string }) => ({ text: JSON.stringify(entries) }));
    const result = await runDeconP1a(jobId, { generateText: gen, readDerivedText: () => P1A_TEXT, now: () => NOW });

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.skipped).toBe(false);
    expect(result.stats.classifyAttempts).toBe(1);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0]?.[0]?.slot).toBe('extraction'); // extraction 档温 0（deconLlmCore 契约注释面）

    const dict = getDeconDictionary(MAT_REF, DERIVED_HASH);
    expect(dict?.entries).toEqual(entries);
    const state = getDeconPassState(jobId, 'p1a', 'all');
    expect(state?.status).toBe('done');
    expect(state?.outputRef).toBe('dictionary:all');
    expect(state?.outputHash).toBe(dict === null ? null : hashDeconDictionaryOutput(dict));
    const jobRow = getDeconJob(jobId);
    expect(jobRow?.cost.byPass.p1a?.calls).toBe(1);
    expect(jobRow?.cost.totalTokens).toBeGreaterThan(0);

    // 重入：done + 词典 hash 一致 → skip（零重调 LLM）。
    const gen2 = vi.fn(async () => ({ text: '[]' }));
    const again = await runDeconP1a(jobId, { generateText: gen2, readDerivedText: () => P1A_TEXT, now: () => NOW });
    expect(again.status).toBe('done');
    if (again.status === 'done') expect(again.skipped).toBe(true);
    expect(gen2).toHaveBeenCalledTimes(0);

    // 跨 job 继承（F-07）：job1 收官后新 job 同指纹继承词典 → P1a 零重算。
    expect(transitionDeconJob(jobId, 'finish', undefined, jobDeps(DERIVED_HASH)).ok).toBe(true);
    const second = createDeconJob({ materialId: MAT_ID, tier: 'fine', dimensions: ['qidaigan'] }, jobDeps(DERIVED_HASH));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.inheritedP1).toEqual({ p1a: true, p1b: false, p1c: false }); // CR-17 per-pass：仅词典在
    expect(startDeconJob(second.job.jobId, jobDeps(DERIVED_HASH)).ok).toBe(true);
    const gen3 = vi.fn(async () => ({ text: '[]' }));
    const inherited = await runDeconP1a(second.job.jobId, {
      generateText: gen3,
      readDerivedText: () => P1A_TEXT,
      now: () => NOW,
    });
    expect(inherited.status).toBe('done');
    if (inherited.status === 'done') expect(inherited.skipped).toBe(true);
    expect(gen3).toHaveBeenCalledTimes(0);
  });

  it('C3 截断升帽：attempt 0 截断 → attempt 1 帽 ×2 重试成功落库（JSON 纠偏环保留 + 升帽）', async () => {
    const DERIVED_HASH = sha(P1A_TEXT);
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(DERIVED_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(DERIVED_HASH)).ok).toBe(true);

    const entries = [{ name: '李逍遥', type: 'person', confidence: 0.9 }];
    const caps: number[] = [];
    const gen: DeconGenerateText = async (input) => {
      caps.push(input.maxTokens ?? -1);
      return caps.length === 1
        ? { text: JSON.stringify(entries), finishReason: 'length' }
        : { text: JSON.stringify(entries), finishReason: 'stop' };
    };
    const result = await runDeconP1a(jobId, { generateText: gen, readDerivedText: () => P1A_TEXT, now: () => NOW });
    expect(result.status).toBe('done');
    expect(caps).toEqual([DECON_P1A_CLASSIFY_MAX_TOKENS, DECON_P1A_CLASSIFY_MAX_TOKENS * 2]); // attempt>0 升帽 ×2
    expect(getDeconJob(jobId)?.cost.byPass.p1a?.calls).toBe(2); // 两笔 actual 各记各的
  });

  it('capped 挂起不烧 token：预算门前置（generate 零调用）+ job/pass_state 双落 capped', async () => {
    const DERIVED_HASH = sha(P1A_TEXT);
    const created = createDeconJob(
      { materialId: MAT_ID, tier: 'coarse', budget: { totalTokens: 10, perPass: {} } },
      jobDeps(DERIVED_HASH),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(DERIVED_HASH)).ok).toBe(true);

    const gen = vi.fn(async () => ({ text: '[]' }));
    const result = await runDeconP1a(jobId, { generateText: gen, readDerivedText: () => P1A_TEXT, now: () => NOW });
    expect(result.status).toBe('capped');
    expect(gen).toHaveBeenCalledTimes(0); // 不烧 token
    expect(getDeconJob(jobId)?.status).toBe('capped');
    expect(getDeconPassState(jobId, 'p1a', 'all')?.status).toBe('capped');
  });

  it('约束式拒收 → 纠偏重试一次成功（attempts=2）；两次均自创新名 → 诚实挂起 failed', async () => {
    const DERIVED_HASH = sha(P1A_TEXT);
    const entries = [{ name: '李逍遥', type: 'person', confidence: 0.9 }];

    const first = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(DERIVED_HASH));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(startDeconJob(first.job.jobId, jobDeps(DERIVED_HASH)).ok).toBe(true);
    const genRetry = vi
      .fn()
      .mockImplementationOnce(async () => ({ text: '[{"name":"凭空捏造的人","type":"person","confidence":0.9}]' }))
      .mockImplementation(async () => ({ text: JSON.stringify(entries) }));
    const retryResult = await runDeconP1a(first.job.jobId, {
      generateText: genRetry,
      readDerivedText: () => P1A_TEXT,
      now: () => NOW,
    });
    expect(retryResult.status).toBe('done');
    if (retryResult.status === 'done') expect(retryResult.stats.classifyAttempts).toBe(2);
    expect(getDeconDictionary(MAT_REF, DERIVED_HASH)?.entries).toEqual(entries);
    expect(transitionDeconJob(first.job.jobId, 'finish', undefined, jobDeps(DERIVED_HASH)).ok).toBe(true);

    const second = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(sha(P1A_TEXT + '变体')));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 变体 hash 隔离词典行（F-07 键控）——上一 job 的词典不可见。
    expect(getDeconDictionary(MAT_REF, sha(P1A_TEXT + '变体'))).toBeNull();
    expect(startDeconJob(second.job.jobId, jobDeps(sha(P1A_TEXT + '变体'))).ok).toBe(true);
    const genBad = vi.fn(async () => ({ text: '[{"name":"又一个凭空捏造的人","type":"person","confidence":0.9}]' }));
    const failResult = await runDeconP1a(second.job.jobId, {
      generateText: genBad,
      readDerivedText: () => P1A_TEXT + '变体',
      now: () => NOW,
    });
    expect(failResult.status).toBe('failed');
    expect(genBad).toHaveBeenCalledTimes(2); // 重试一次后诚实挂起
    expect(getDeconJob(second.job.jobId)?.status).toBe('failed');
    expect(getDeconPassState(second.job.jobId, 'p1a', 'all')?.status).toBe('failed');
  });

  it('派生 .md 现值 hash ≠ job 快照 → stale（F-02 锚点漂移不静默沿用）', async () => {
    const OTHER_HASH = sha(P1A_TEXT + '校对后');
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(OTHER_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(OTHER_HASH)).ok).toBe(true);

    const gen = vi.fn(async () => ({ text: '[]' }));
    const result = await runDeconP1a(jobId, { generateText: gen, readDerivedText: () => P1A_TEXT, now: () => NOW });
    expect(result.status).toBe('stale');
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconJob(jobId)?.status).toBe('stale');
  });

  it('LLM 内核未装配 → failed 诚实挂起（不静默）', async () => {
    const DERIVED_HASH = sha(P1A_TEXT);
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(DERIVED_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(DERIVED_HASH)).ok).toBe(true);

    const result = await runDeconP1a(jobId, { readDerivedText: () => P1A_TEXT, now: () => NOW });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('未装配');
  });

  it('零候选：诚实负判——空词典落库 + done 零 LLM 调用（P1b 照跑 P1c 兜底）', async () => {
    const quietText = '他看了看天空，然后转身离开了此地。';
    upsertMaterialRow(mkMaterial(quietText));
    const QUIET_HASH = sha(quietText);
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse' }, jobDeps(QUIET_HASH));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.job.jobId;
    expect(startDeconJob(jobId, jobDeps(QUIET_HASH)).ok).toBe(true);

    const gen = vi.fn(async () => ({ text: '[]' }));
    const result = await runDeconP1a(jobId, { generateText: gen, readDerivedText: () => quietText, now: () => NOW });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.dictionary.entries).toEqual([]);
    expect(result.stats.candidateCount).toBe(0);
    expect(gen).toHaveBeenCalledTimes(0);
    expect(getDeconPassState(jobId, 'p1a', 'all')?.status).toBe('done');
  });
});
