import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// E10.3b W7：decon 金标评测测试（AC9）——deconGoldenEval runner 机制面 + fixture 阈值全过。
// 纯函数面（yaml 容错解析 / 实体与场景断言判别）无 db；全链面跑 fine job 后对产物断言
// （合成 fixtures——真金标 dogfood 回填注记见 runner 头注）。ABI 门控 + throwaway home。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-golden');
const EVAL_DIR = path.join(TEST_HOME, 'evals', 'decon');

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
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
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
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { deleteDeconProductsByMaterial } from '../main/db/closure-decon';
import {
  assertDeconGoldenEntity,
  assertDeconGoldenScene,
  listDeconGoldenFiles,
  parseDeconGoldenYaml,
  runDeconGoldenEval,
} from '../main/decon/deconGoldenEval';
import { buildChainHandlers, createDeconChainFixture, zeroChainCounts, type ChainMockCounts } from './deconChainFixture';

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

const FX = createDeconChainFixture('mat-0000000000f8', '8');

/** 合成金标 yaml（fixture 数据基——A 的实体/幻觉用例产品化 + 场景关键词对）。 */
const GOLDEN_YAML = [
  'entities:',
  '  - id: li-xiaoyao',
  '    name: 李逍遥',
  '    type: person',
  '  - id: zhao-linger',
  '    name: 赵灵儿',
  '    type: person',
  '  - id: qingyun-guan',
  '    name: 青云观',
  '    type: place',
  '  - id: gu-bei',
  '    name: 古碑',
  '    type: item',
  '  - id: huan-ying-zhen-ren',
  '    name: 幻影真人',
  '    expect: filtered',
  'scenes:',
  '  - id: ch1-qidaigan',
  '    chapter: 1',
  '    dimension: qidaigan',
  '    keywords: [期待感, 钩]',
].join('\n');

// ── 纯函数面（无 db）──

describe('parseDeconGoldenYaml（yaml 容错解析）', () => {
  it('合法两段全 parse：entities（含 type 省略 / expect: filtered）/ scenes（含 keywords 省略）', () => {
    const parsed = parseDeconGoldenYaml(GOLDEN_YAML);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.entityCases).toHaveLength(5);
    expect(parsed.entityCases[0]).toMatchObject({ id: 'li-xiaoyao', name: '李逍遥', mode: 'exists', expectedType: 'person' });
    expect(parsed.entityCases[4]).toMatchObject({ id: 'huan-ying-zhen-ren', name: '幻影真人', mode: 'filtered', expectedType: null });
    expect(parsed.sceneCases).toEqual([{ id: 'ch1-qidaigan', chapterIndex: 1, dimensionId: 'qidaigan', keywords: ['期待感', '钩'] }]);
    expect(parsed.skipped).toBe(0);
  });

  it('BOM 剥离（Windows 编辑器）+ 空 yaml / 非对象根 → null（文件级坏）/ 零 case（不 throw）', () => {
    const withBom = `${String.fromCharCode(0xfeff)}${GOLDEN_YAML}`;
    expect(parseDeconGoldenYaml(withBom)?.entityCases).toHaveLength(5);
    expect(parseDeconGoldenYaml('')).toBeNull(); // yaml.load('') → undefined → 文件级坏
    expect(parseDeconGoldenYaml('entities:')).not.toBeNull(); // 空段 → 零 case
    expect(parseDeconGoldenYaml('entities: [\n')) .toBeNull(); // 语法坏 → null（文件级）
  });

  it('per-case 容错：坏条目跳过计数不丢全集（id/name 缺 / type 越枚举 / expect 词形坏 / chapter 负 / dimension 非手艺维〔style 拒〕）', () => {
    const yamlText = [
      'entities:',
      '  - name: 无id实体',
      '  - id: ok-entity',
      '    name: 正常实体',
      '  - id: bad-type',
      '    name: 类型越枚举',
      '    type: immortal',
      '  - id: bad-expect',
      '    name: 期望词形坏',
      '    expect: gone',
      'scenes:',
      '  - id: bad-chapter',
      '    chapter: -1',
      '    dimension: qidaigan',
      '  - id: style-scene',
      '    chapter: 0',
      '    dimension: style',
      '  - id: unknown-dim',
      '    chapter: 0',
      '    dimension: feizao',
      '  - id: ok-scene',
      '    chapter: 2',
      '    dimension: qingxu',
      '    keywords: []',
    ].join('\n');
    const parsed = parseDeconGoldenYaml(yamlText);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.entityCases.map((c) => c.id)).toEqual(['ok-entity']);
    expect(parsed.sceneCases).toEqual([{ id: 'ok-scene', chapterIndex: 2, dimensionId: 'qingxu', keywords: [] }]);
    expect(parsed.skipped).toBe(6);
  });

  it('段非数组 → 整段跳过 + skipped 计数（warn 留痕——VITEST 守卫静音）', () => {
    const parsed = parseDeconGoldenYaml('entities: 不是数组\nscenes: 7\n');
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.entityCases).toHaveLength(0);
    expect(parsed.sceneCases).toHaveLength(0);
    expect(parsed.skipped).toBe(2);
  });
});

describe('assertDeconGoldenEntity / assertDeconGoldenScene（断言判别纯函数）', () => {
  const entities = [
    { canonicalName: '李逍遥', type: 'person' as const, audit: {} },
    { canonicalName: '幻影真人', type: 'person' as const, audit: { hallucinationFiltered: true } },
  ];

  it('exists：命中 + 类型一致过；缺失 / 类型不符各带定位原因 fail', () => {
    expect(assertDeconGoldenEntity({ id: 'a', name: '李逍遥', mode: 'exists', expectedType: 'person' }, entities).pass).toBe(true);
    expect(assertDeconGoldenEntity({ id: 'a', name: '李逍遥', mode: 'exists', expectedType: null }, entities).pass).toBe(true);
    const missing = assertDeconGoldenEntity({ id: 'a', name: '不存在的人', mode: 'exists', expectedType: null }, entities);
    expect(missing.pass).toBe(false);
    expect(missing.message).toContain('不在聚合产物中');
    const wrongType = assertDeconGoldenEntity({ id: 'a', name: '李逍遥', mode: 'exists', expectedType: 'place' }, entities);
    expect(wrongType.pass).toBe(false);
    expect(wrongType.message).toContain('≠ 期望 place');
  });

  it('filtered：缺席过 / 过滤留痕过 / 未过滤在场 fail（幻觉漏网）', () => {
    expect(assertDeconGoldenEntity({ id: 'a', name: '根本没立行', mode: 'filtered', expectedType: null }, entities).pass).toBe(true);
    expect(assertDeconGoldenEntity({ id: 'a', name: '幻影真人', mode: 'filtered', expectedType: null }, entities).pass).toBe(true);
    const leak = assertDeconGoldenEntity({ id: 'a', name: '李逍遥', mode: 'filtered', expectedType: null }, entities);
    expect(leak.pass).toBe(false);
    expect(leak.message).toContain('未过滤');
  });

  const findingsPayload = (insight: string): { unit: string; payload: unknown } => ({
    unit: 'ch:1',
    payload: {
      findings: [{ insight, elaboration: '展开。', evidence: [{ paraRange: { start: 4, end: 5 }, quote: 'q' }], craftHint: null }],
      synthesis: '',
    },
  });

  it('scene：unit 行缺失 / 零 findings / 关键词不中 各 fail；any-of 命中过', () => {
    const sceneCase = { id: 's', chapterIndex: 1, dimensionId: 'qidaigan', keywords: ['期待感', '钩'] };
    expect(assertDeconGoldenScene(sceneCase, [findingsPayload('开篇用人物情感钩立期待感')]).pass).toBe(true);
    expect(assertDeconGoldenScene(sceneCase, []).pass).toBe(false); // 产品行缺失
    expect(assertDeconGoldenScene(sceneCase, [{ unit: 'ch:1', payload: { findings: [], synthesis: '' } }]).pass).toBe(false); // 零 findings
    const noHit = assertDeconGoldenScene(sceneCase, [findingsPayload('结构规整节奏平稳')]);
    expect(noHit.pass).toBe(false);
    expect(noHit.message).toContain('无一命中关键词');
    // keywords 空 = 只查有 findings。
    expect(
      assertDeconGoldenScene({ ...sceneCase, keywords: [] }, [findingsPayload('任何结论')]).pass,
    ).toBe(true);
    // 坏 payload 行（写侧门外防御）不计 findings——按零 findings fail。
    expect(assertDeconGoldenScene(sceneCase, [{ unit: 'ch:1', payload: { broken: true } }]).pass).toBe(false);
  });
});

describe('listDeconGoldenFiles（目录枚举）', () => {
  it('目录缺失 → []（never throw）；非 yaml 文件不收录', () => {
    expect(listDeconGoldenFiles(path.join(TEST_HOME, 'nope'))).toEqual([]);
    mkdirSync(path.join(TEST_HOME, 'mixed'), { recursive: true });
    writeFileSync(path.join(TEST_HOME, 'mixed', 'golden.yaml'), 'entities: []\n', 'utf-8');
    writeFileSync(path.join(TEST_HOME, 'mixed', 'readme.txt'), 'x', 'utf-8');
    expect(listDeconGoldenFiles(path.join(TEST_HOME, 'mixed'))).toEqual([
      path.join(TEST_HOME, 'mixed', 'golden.yaml'),
    ]);
  });
});

// ── 全链面（db——fixture 阈值全过 AC9 + no-eval-set graceful + 负面 case 可红）──

const maybe = sqliteUsable ? describe : describe.skip;

maybe('deconGoldenEval 全链（合成 fixtures 阈值断言）', () => {
  let counts: ChainMockCounts = zeroChainCounts();

  beforeAll(() => {
    rmBestEffort(TEST_HOME);
    getDb();
  });
  afterAll(clean);

  beforeEach(() => {
    deleteDeconProductsByMaterial(FX.matId);
    upsertMaterialRow(FX.material());
    mkdirSync(EVAL_DIR, { recursive: true });
    writeFileSync(path.join(EVAL_DIR, 'golden.yaml'), GOLDEN_YAML, 'utf-8');
    counts = zeroChainCounts();
  });

  it('fine 全链跑完后金标全过（实体 5 case + 场景 1 case——AC9 阈值断言）', async () => {
    const built = buildChainHandlers(FX, counts, { now: () => new Date('2026-09-05T19:00:00.000Z') });
    const created = await built.handlers.createDecon({ materialId: FX.matId, tier: 'fine', dimensions: ['qidaigan'], reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await built.handlers.startDecon({ jobId: created.job.jobId });
    const result = await built.pipelineDone();
    expect(result.status).toBe('done');

    const report = runDeconGoldenEval({
      evalDir: EVAL_DIR,
      materialRef: FX.matRef,
      derivedHash: FX.derivedHash,
      jobId: created.job.jobId,
    });
    expect(report.ok).toBe(true);
    if (!report.ok || !report.ran) return;
    expect(report.run.entityCaseCount).toBe(5);
    expect(report.run.sceneCaseCount).toBe(1);
    expect(report.run.skippedCases).toBe(0);
    // 阈值断言：合成 fixtures 全过（真金标 dogfood 回填后阈值随语料校准对钉此处）。
    expect(report.run.failed).toBe(0);
    expect(report.run.passed).toBe(6);
    expect(report.run.entityResults.every((r) => r.pass)).toBe(true);
    expect(report.run.sceneResults.every((r) => r.pass)).toBe(true);
  });

  it('金标可红：类型错配 / 缺失实体 / 关键词不中的 case 如实 fail（非恒过）', async () => {
    const built = buildChainHandlers(FX, counts, { now: () => new Date('2026-09-05T19:10:00.000Z') });
    const created = await built.handlers.createDecon({ materialId: FX.matId, tier: 'fine', dimensions: ['qidaigan'], reviewCheckpoints: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await built.handlers.startDecon({ jobId: created.job.jobId });
    await built.pipelineDone();

    writeFileSync(
      path.join(EVAL_DIR, 'bad.yaml'),
      [
        'entities:',
        '  - id: wrong-type',
        '    name: 李逍遥',
        '    type: item',
        '  - id: missing-entity',
        '    name: 不存在的角色',
        'scenes:',
        '  - id: no-keyword-hit',
        '    chapter: 1',
        '    dimension: qidaigan',
        '    keywords: [完全不相关的关键词]',
      ].join('\n'),
      'utf-8',
    );
    const report = runDeconGoldenEval({
      evalDir: EVAL_DIR,
      materialRef: FX.matRef,
      derivedHash: FX.derivedHash,
      jobId: created.job.jobId,
    });
    expect(report.ok).toBe(true);
    if (!report.ok || !report.ran) return;
    // golden.yaml 的好 case 照过 + bad.yaml 的三个坏 case 全红（跨文件合跑 per-case 判别）。
    expect(report.run.failed).toBe(3);
    const failedIds = [...report.run.entityResults, ...report.run.sceneResults].filter((r) => !r.pass).map((r) => r.caseId);
    expect(failedIds).toEqual(['wrong-type', 'missing-entity', 'no-keyword-hit']);
  });

  it('未建评估集 → no-eval-set graceful（非错误 + 指引文案）；跨文件重复 id first-wins', () => {
    rmBestEffort(EVAL_DIR);
    const report = runDeconGoldenEval({
      evalDir: EVAL_DIR,
      materialRef: FX.matRef,
      derivedHash: FX.derivedHash,
      jobId: 'decon-0000000000f8',
    });
    expect(report).toMatchObject({ ok: true, ran: false, reason: 'no-eval-set', filesFound: 0 });

    mkdirSync(EVAL_DIR, { recursive: true });
    // 两文件同 id 不同 name——first-wins 后保留 a.yaml 的「甲重复实体」（beforeEach 已清
    // 材料级实体行，两 name 均缺席 → 单 case 如实 fail 且 message 指向 a.yaml 的 name——
    // 判别「哪份赢了」不依赖 db 残留态）。
    writeFileSync(path.join(EVAL_DIR, 'a.yaml'), 'entities:\n  - id: dup\n    name: 甲重复实体\n', 'utf-8');
    writeFileSync(path.join(EVAL_DIR, 'b.yaml'), 'entities:\n  - id: dup\n    name: 乙重复实体\n', 'utf-8');
    const dup = runDeconGoldenEval({
      evalDir: EVAL_DIR,
      materialRef: FX.matRef,
      derivedHash: FX.derivedHash,
      jobId: 'decon-0000000000f8',
    });
    expect(dup.ok).toBe(true);
    if (!dup.ok || !dup.ran) return;
    expect(dup.run.entityCaseCount).toBe(1); // a.yaml 保留
    expect(dup.run.skippedCases).toBe(1); // b.yaml 重复 id 计数
    expect(dup.run.entityResults).toHaveLength(1);
    expect(dup.run.entityResults[0]!.message).toContain('甲重复实体'); // first-wins 判别
  });
});
