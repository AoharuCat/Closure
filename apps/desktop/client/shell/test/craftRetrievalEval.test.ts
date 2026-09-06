import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CraftHit, ResolvedModel } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// E10.2b W6.2：craft eval runner 单元面——映射/参数提取/接线（mock searchCraft，零 db）。
// 金标语料真跑（ABI 门控 + 合成种子卡）在 test/craftRetrievalEvalGolden.test.ts。
//
// vi.mock 整替 closureCraftRetrieval 模块（DI seam 的模块级形态——runner 的 import 被截，
// 不触 db/electron 模块图）；runner 语义（yaml 容错/去重/参数透传/entryId 对齐）全部可断言。
// ─────────────────────────────────────────────────────────────────────────────

const searchCraftMock = vi.fn();
vi.mock('../main/db/closureCraftRetrieval', () => ({
  searchCraft: (...args: unknown[]) => searchCraftMock(...args) as unknown,
}));

import {
  craftEvalParamsFromRaw,
  craftHitToEntryHit,
  listCraftEvalFiles,
  parseCraftEvalYaml,
  runCraftEval,
} from '../main/db/craftRetrievalEval';
import type { RetrievalDeps } from '../main/db/closureRetrieval';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'craft-eval-unit-'));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function stubHit(over: Partial<CraftHit> = {}): CraftHit {
  return {
    craftId: 'card:card-0123456789ab',
    craftType: 'qingxu',
    sourceKind: 'craft_card',
    name: '先抑后扬三层回报',
    bodyText: '词目：先抑后扬\n主张：……',
    score: 0.0328,
    ...over,
  };
}

describe('craftRetrievalEval — hit 映射（CraftHit → EntryHit，scoreEvalCases 消费形状）', () => {
  it('entryId=craftId / craftType→entryType / 全局库 sentinel（projectId 空串 + visibility known）', () => {
    const hit = craftHitToEntryHit(stubHit());
    expect(hit.entryId).toBe('card:card-0123456789ab');
    expect(hit.entryType).toBe('qingxu');
    expect(hit.sourceKind).toBe('craft_card');
    expect(hit.name).toBe('先抑后扬三层回报');
    expect(hit.score).toBe(0.0328);
    // craft KB 全局无项目域；craft 全公开——sentinel 值钉住（打分不消费，但形态防漂移）。
    expect(hit.projectId).toBe('');
    expect(hit.visibility).toBe('known');
  });

  it('可选键二态纪律：在场才写，无值键不出现', () => {
    const bare = craftHitToEntryHit(stubHit());
    expect('ftsRank' in bare).toBe(false);
    expect('vecDistance' in bare).toBe(false);
    expect('rerankScore' in bare).toBe(false);
    expect('summaryText' in bare).toBe(false);
    expect('vectorKind' in bare).toBe(false);

    const full = craftHitToEntryHit(
      stubHit({ ftsRank: 1, vecDistance: 0.002, rerankScore: 0.9, summaryText: '简述', vectorKind: 'claim' }),
    );
    expect(full.ftsRank).toBe(1);
    expect(full.vecDistance).toBe(0.002);
    expect(full.rerankScore).toBe(0.9);
    expect(full.summaryText).toBe('简述');
    expect(full.vectorKind).toBe('claim');
  });
});

describe('craftRetrievalEval — craft 侧 yaml 参数提取（craftEvalParamsFromRaw）', () => {
  it('craft_type / tags 提取 + 无参数条目不入 map', () => {
    const raw = {
      cases: [
        { id: 'a', query: 'q', expected: [{ entryId: 'e' }], craft_type: 'qingxu', tags: ['都市', '悬疑'] },
        { id: 'b', query: 'q', expected: [{ entryId: 'e' }] },
      ],
    };
    const params = craftEvalParamsFromRaw(raw);
    expect(params.size).toBe(1);
    expect(params.get('a')).toEqual({ craftType: 'qingxu', tags: ['都市', '悬疑'] });
    expect(params.has('b')).toBe(false);
  });

  it('坏形状静默跳过（craft_type 非 string / tags 混入非 string / tags 空数组）', () => {
    const raw = {
      cases: [
        { id: 'a', craft_type: 123, tags: ['ok', 5, null] },
        { id: 'b', craft_type: '  ', tags: [] },
        { id: 'c', tags: 'not-an-array' },
      ],
    };
    const params = craftEvalParamsFromRaw(raw);
    // a 的 tags 过滤后仍有一条合法值 → 只带 tags；b 全空 → 无参数；c 的 tags 非 array → 无参数。
    expect(params.get('a')).toEqual({ tags: ['ok'] });
    expect(params.has('b')).toBe(false);
    expect(params.has('c')).toBe(false);
  });

  it('重复 id first-wins + 根非对象/cases 非数组 → 空 map', () => {
    const dup = {
      cases: [
        { id: 'a', craft_type: 'qingxu' },
        { id: 'a', craft_type: 'fubi' },
      ],
    };
    expect(craftEvalParamsFromRaw(dup).get('a')).toEqual({ craftType: 'qingxu' });
    expect(craftEvalParamsFromRaw(null).size).toBe(0);
    expect(craftEvalParamsFromRaw('str').size).toBe(0);
    expect(craftEvalParamsFromRaw([1, 2]).size).toBe(0);
    expect(craftEvalParamsFromRaw({}).size).toBe(0);
    expect(craftEvalParamsFromRaw({ cases: 'nope' }).size).toBe(0);
  });
});

describe('craftRetrievalEval — yaml 容错解析（parseCraftEvalYaml）', () => {
  it('合法 yaml：cases（shared 容错单源）+ params（raw 提取）同源一次 load', () => {
    const text = [
      'cases:',
      '  - id: a',
      '    query: 先抑后扬怎么安排',
      '    craft_type: qingxu',
      '    tags:',
      '      - 都市',
      '    expected:',
      '      - entryId: "card:card-0123456789ab"',
      '  - id: bad',
      '    query: 缺期望',
      '    expected: []',
    ].join('\n');
    const parsed = parseCraftEvalYaml(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.cases).toHaveLength(1);
    expect(parsed!.cases[0]).toMatchObject({ id: 'a', query: '先抑后扬怎么安排' });
    expect(parsed!.skipped).toBe(1);
    expect(parsed!.params.get('a')).toEqual({ craftType: 'qingxu', tags: ['都市'] });
    // 坏条目（schema 拒收）的参数不存在——case 都没进集，参数无从挂靠。
    expect(parsed!.params.has('bad')).toBe(false);
  });

  it('BOM 容忍（Windows 编辑器）+ yaml 语法坏 → null（整文件级，runner 计 skippedFiles）', () => {
    const bom = parseCraftEvalYaml(
      String.fromCharCode(0xfeff) + 'cases:\n  - id: a\n    query: q\n    expected:\n      - entryId: e\n',
    );
    expect(bom?.cases).toHaveLength(1);
    expect(parseCraftEvalYaml('cases: [unclosed')).toBeNull();
  });
});

describe('craftRetrievalEval — 文件枚举（listCraftEvalFiles）', () => {
  it('递归枚举 yaml/yml（子目录分档不静默忽略）+ 缺目录 → []', () => {
    const dir = path.join(TMP_ROOT, 'list-evals');
    mkdirSync(path.join(dir, 'work'), { recursive: true });
    writeFileSync(path.join(dir, 'golden.yaml'), 'cases: []\n', 'utf-8');
    writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf-8');
    writeFileSync(path.join(dir, 'work', 'extra.yml'), 'cases: []\n', 'utf-8');
    const files = listCraftEvalFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith(path.join('work', 'extra.yml')))).toBe(true);
    expect(listCraftEvalFiles(path.join(TMP_ROOT, 'no-such-dir'))).toEqual([]);
  });

  it('CR-2b-30：深度帽 4（第 4 层 yaml 收录、第 5 层不下探）+ 目录 symlink 不跟随（循环链接不悬挂）', () => {
    const dir = path.join(TMP_ROOT, 'guard-evals');
    // a=第 1 层 → b=2 → c=3 → d=4 → e=5。
    mkdirSync(path.join(dir, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    writeFileSync(path.join(dir, 'root.yaml'), 'cases: []\n', 'utf-8');
    writeFileSync(path.join(dir, 'a', 'b', 'c', 'd', 'deep-ok.yaml'), 'cases: []\n', 'utf-8');
    writeFileSync(path.join(dir, 'a', 'b', 'c', 'd', 'e', 'too-deep.yaml'), 'cases: []\n', 'utf-8');
    const files = listCraftEvalFiles(dir);
    expect(files.some((f) => f.endsWith(path.join('d', 'deep-ok.yaml')))).toBe(true); // 第 4 层——仍收录
    expect(files.some((f) => f.endsWith('too-deep.yaml'))).toBe(false); // 第 5 层——不下探

    // 循环目录 symlink（a/loop → 根）：跟随形态（原 statSync）下无限递归；lstat 跳过。
    // Windows 无开发者模式/管理员特权时 symlink 创建 EPERM——环境限制非代码失败，跳过链接断言。
    let linked = false;
    try {
      symlinkSync(dir, path.join(dir, 'a', 'loop'));
      linked = true;
    } catch {
      linked = false;
    }
    if (linked) {
      const again = listCraftEvalFiles(dir); // 不悬挂即通过（循环链接被 lstat 剪掉）
      expect(again.some((f) => f.split(path.sep).includes('loop'))).toBe(false);
      expect(again.some((f) => f.endsWith(path.join('d', 'deep-ok.yaml')))).toBe(true);
    }
  });
});

describe('craftRetrievalEval — runner 接线（mock searchCraft：参数透传 + entryId 对齐打分）', () => {
  const deps: RetrievalDeps = {
    resolveModel: () => ({ keyId: 'k', modelId: 'm', protocol: 'openai-compatible', baseUrl: 'http://x', apiKey: 's', capability: 'embedding' } as ResolvedModel),
    embed: async () => [0, 1],
    resolveRerankModel: () => null,
  };

  beforeEach(() => {
    searchCraftMock.mockReset();
  });

  it('query/k/参数透传 + craftId→entryId 对齐：命中 any-of / 不齐 miss', async () => {
    const dir = path.join(TMP_ROOT, 'wire-evals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'golden.yaml'),
      [
        'cases:',
        '  - id: hit-single',
        '    query: 先抑后扬的回报节奏怎么安排',
        '    expected:',
        '      - entryId: "card:card-0123456789ab"',
        '  - id: hit-anyof',
        '    query: 开篇钩子',
        '    expected:',
        '      - entryId: "card:card-111111111111"',
        '      - entryId: "card:card-222222222222"',
        '  - id: miss',
        '    query: 完全不存在的标记',
        '    craft_type: fubi',
        '    tags:',
        '      - 都市',
        '    expected:',
        '      - entryId: "card:card-333333333333"',
      ].join('\n'),
      'utf-8',
    );

    // 按查询分流：单命中 / 双命中（any-of 双候选）/ 零命中（miss 诊断面）。
    searchCraftMock.mockImplementation(async (query: string) => {
      if (query === '先抑后扬的回报节奏怎么安排') return [stubHit()];
      if (query === '开篇钩子')
        return [
          stubHit({ craftId: 'card:card-999999999999', name: '无关卡' }),
          stubHit({ craftId: 'card:card-222222222222', name: 'any-of 第二候选' }),
        ];
      return [];
    });

    const report = await runCraftEval(dir, { k: 5 }, deps);
    expect(report.ok).toBe(true);
    expect(report.ran).toBe(true);
    if (!report.ok || !report.ran) throw new Error('eval should have run');

    // searchCraft 恰好每 case 一次；query/k/参数/deps 全透传（craft_type+tags 只在声明 case 带）。
    expect(searchCraftMock).toHaveBeenCalledTimes(3);
    expect(searchCraftMock).toHaveBeenNthCalledWith(
      1,
      '先抑后扬的回报节奏怎么安排',
      { k: 5 },
      deps,
    );
    expect(searchCraftMock).toHaveBeenNthCalledWith(2, '开篇钩子', { k: 5 }, deps);
    expect(searchCraftMock).toHaveBeenNthCalledWith(3, '完全不存在的标记', { k: 5, craftType: 'fubi', tags: ['都市'] }, deps);

    const byId = new Map(report.run.perCase.map((p) => [p.caseId, p]));
    const hitSingle = byId.get('hit-single')!;
    expect(hitSingle.hit).toBe(true);
    expect(hitSingle.firstRank).toBe(1);
    expect(hitSingle.matchedExpected).toEqual({ entryId: 'card:card-0123456789ab' });
    expect(hitSingle.topHits[0]).toMatchObject({
      craftId: 'card:card-0123456789ab',
      craftType: 'qingxu',
      sourceKind: 'craft_card',
    });

    // any-of：无关卡 rank 1 不命中，第二候选 rank 2 命中——entryId 精确对齐的正面证明。
    const anyOf = byId.get('hit-anyof')!;
    expect(anyOf.hit).toBe(true);
    expect(anyOf.firstRank).toBe(2);
    expect(anyOf.matchedExpected).toEqual({ entryId: 'card:card-222222222222' });

    const miss = byId.get('miss')!;
    expect(miss.hit).toBe(false);
    expect('firstRank' in miss).toBe(false);
    expect(miss.topHits).toEqual([]); // 零结果——诊断面为空数组
    // 参数回显进 perCase 明细（yaml 校对面）。
    expect(miss.craftType).toBe('fubi');
    expect(miss.tags).toEqual(['都市']);
    expect(hitSingle.craftType).toBeUndefined();
    expect(hitSingle.tags).toBeUndefined();

    // 手算锚：3 case 2 hit（rank 1 + rank 2）——recall = 2/3，MRR = (1 + 1/2 + 0)/3 = 0.5。
    expect(report.run.recallAtK).toBeCloseTo(2 / 3, 10);
    expect(report.run.mrr).toBeCloseTo(0.5, 10);
    expect(report.run.caseCount).toBe(3);
    expect(report.run.skippedCases).toBe(0);
    expect(report.run.files).toEqual(['golden.yaml']);
  });

  it('未建评估集 graceful：ran=false reason=no-eval-set，零检索调用', async () => {
    const dir = path.join(TMP_ROOT, 'empty-evals');
    mkdirSync(dir, { recursive: true });
    const report = await runCraftEval(dir, {}, deps);
    expect(report.ok).toBe(true);
    expect(report.ran).toBe(false);
    if (!report.ok || report.ran) throw new Error('expected no-eval-set');
    expect(report.reason).toBe('no-eval-set');
    expect(report.filesFound).toBe(0);
    expect(searchCraftMock).not.toHaveBeenCalled();
  });
});
