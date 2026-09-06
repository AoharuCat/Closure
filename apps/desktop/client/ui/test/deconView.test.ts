/**
 * deconView 纯函数测试（E10.3b W6——零 React 零 IPC）。
 *
 * 覆盖：
 * - 状态横幅判定（闸门暂停优先——review 行 pending 区分「等审」与用户暂停，design §6）；
 * - pass_state 聚合（千 unit 行 → 按 pass done/total；多态计数）；
 * - 材料过滤（F-12：low-confidence 分章/零章/pending/failed 不可拆——排除 + 提示面）；
 * - 档位 × 维度校验客户端 mirror（coarse⊆{style} / fine 1-3 / deep 全 12）+ 档位可见目录
 *   （粗拆只显风格维——拍板②）+ deep 预填；
 * - 成本预估行（byPass 展开 + P1 继承打折**注记行**——旗标驱动不依赖 byPass 行存在，CR-18；
 *   p4:<dim> 归 'p4' 茎不误标）；
 * - pass/unit/report-unit 标签路由（数字形态 0 基索引 1 基呈现——CR-2；arcs/stats 专项键
 *   progress/report 两路径单源——CR-17）；
 * - payload 形态守卫（findings / style 14 节——纯代码三节必出镜像契约 refine）。
 */
import { describe, expect, it } from 'vitest';
import type {
  DeconJob,
  DeconPassState,
  DeconReviewRow,
  MaterialSummary,
} from '@orison/shared-contracts';
import {
  deconBannerKind,
  deconDimensionSelectionIsValid,
  deconDimensionsForTier,
  deconDeepPrefilledDimensions,
  deconEligibleMaterials,
  deconEstimateRows,
  deconPassLabel,
  deconPendingReview,
  deconReportUnitLabelKey,
  deconUnitLabelKey,
  isDeconFindingsLike,
  isDeconStylePayloadLike,
  parseDeconBudgetInput,
  summarizeDeconPassStates,
} from '../src/features/decon/deconView';

function jobFixture(over: Partial<DeconJob> = {}): DeconJob {
  return {
    jobId: 'decon-aaaaaaaaaaaa',
    materialRef: 'global:mat-aaaaaaaaaaaa',
    tier: 'fine',
    dimensions: ['qingxu'],
    status: 'running',
    budget: { totalTokens: null, perPass: {} },
    cost: { totalTokens: 0, calls: 0, byPass: {}, estimated: true },
    materialContentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    error: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

function reviewFixture(
  checkpoint: DeconReviewRow['checkpoint'],
  status: DeconReviewRow['status'],
): DeconReviewRow {
  return {
    jobId: 'decon-aaaaaaaaaaaa',
    checkpoint,
    status,
    note: null,
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

function passStateFixture(pass: string, unit: string, status: DeconPassState['status']): DeconPassState {
  return {
    jobId: 'decon-aaaaaaaaaaaa',
    pass,
    unit,
    status,
    outputRef: null,
    outputHash: null,
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

function materialFixture(over: Partial<MaterialSummary> = {}): MaterialSummary {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '小说一',
    format: 'txt',
    medium: 'novel',
    tier: 'unspecified',
    author: null,
    lang: null,
    originDate: null,
    sourcePath: 'materials/novel.txt',
    status: 'ready',
    charCount: 120000,
    chapterCount: 40,
    chapterMethod: 'regex',
    chapterConfidence: 'high',
    scanned: false,
    nonUtf8: false,
    parseNotes: [],
    ingestedAt: '2026-09-05T08:00:00.000Z',
    ...over,
  };
}

describe('状态横幅判定（闸门暂停优先）', () => {
  it('paused + review pending → gate-paused（等审与用户暂停区分靠 review 行）', () => {
    const job = jobFixture({ status: 'paused' });
    expect(deconBannerKind(job, [reviewFixture('dictionary', 'pending')])).toBe('gate-paused');
    expect(deconBannerKind(job, [reviewFixture('canon', 'approved'), reviewFixture('craft', 'pending')])).toBe('gate-paused');
  });

  it('paused + 全 approved/off → paused（用户暂停）', () => {
    const job = jobFixture({ status: 'paused' });
    expect(deconBannerKind(job, [reviewFixture('dictionary', 'approved')])).toBe('paused');
    expect(deconBannerKind(job, [])).toBe('paused');
  });

  it('其余状态直通（review 行不影响）', () => {
    for (const status of ['running', 'done', 'capped', 'stale', 'failed', 'cancelled'] as const) {
      expect(deconBannerKind(jobFixture({ status }), [reviewFixture('dictionary', 'pending')])).toBe(status);
    }
  });

  it('deconPendingReview 取首个 pending 行', () => {
    expect(deconPendingReview(undefined)).toBeNull();
    expect(deconPendingReview([reviewFixture('dictionary', 'off')])).toBeNull();
    const pending = reviewFixture('canon', 'pending');
    expect(deconPendingReview([reviewFixture('dictionary', 'approved'), pending])).toBe(pending);
  });
});

describe('pass_state 聚合', () => {
  it('同 pass 多 unit 行聚合 done/total（保持首现序）', () => {
    const rows = [
      passStateFixture('p1b', '0', 'done'),
      passStateFixture('p1b', '1', 'done'),
      passStateFixture('p1b', '2', 'running'),
      passStateFixture('p2', 'world', 'done'),
      passStateFixture('p1b', '3', 'pending'),
    ];
    const summaries = summarizeDeconPassStates(rows);
    expect(summaries.map((s) => s.pass)).toEqual(['p1b', 'p2']);
    expect(summaries[0]).toMatchObject({ total: 4, done: 2, running: 1, pending: 1 });
    expect(summaries[1]).toMatchObject({ total: 1, done: 1 });
  });

  it('空集 → 空数组', () => {
    expect(summarizeDeconPassStates([])).toEqual([]);
  });
});

describe('材料过滤（F-12）', () => {
  it('ready + 有章 + 非 low-confidence → eligible；其余排除', () => {
    const pool = deconEligibleMaterials([
      materialFixture(), // eligible
      materialFixture({ materialId: 'mat-bbbbbbbbbbbb', chapterConfidence: 'low' }), // 分章低置信
      materialFixture({ materialId: 'mat-cccccccccccc', chapterCount: 0 }), // 零章（伪单章）
      materialFixture({ materialId: 'mat-dddddddddddd', status: 'pending' }), // 未就绪
      materialFixture({ materialId: 'mat-eeeeeeeeeeee', status: 'failed' }), // 摄取失败
    ]);
    expect(pool.eligible.map((m) => m.materialId)).toEqual(['mat-aaaaaaaaaaaa']);
    expect(pool.excluded.map((m) => m.materialId)).toEqual([
      'mat-bbbbbbbbbbbb',
      'mat-cccccccccccc',
      'mat-dddddddddddd',
      'mat-eeeeeeeeeeee',
    ]);
  });
});

describe('档位 × 维度选择', () => {
  it('粗拆档可见目录只显风格维（拍板②）', () => {
    expect(deconDimensionsForTier('coarse').map((d) => d.id)).toEqual(['style']);
    expect(deconDimensionsForTier('fine').length).toBe(13);
    expect(deconDimensionsForTier('deep').length).toBe(13);
  });

  it('deep 预填 = 全 12 手艺维（style 不预选）', () => {
    const prefilled = deconDeepPrefilledDimensions();
    expect(prefilled.length).toBe(12);
    expect(prefilled).not.toContain('style');
  });

  it('合法性 mirror：coarse⊆{style} / fine 手艺 1-3 / deep 全 12', () => {
    // coarse。
    expect(deconDimensionSelectionIsValid('coarse', [])).toBe(true);
    expect(deconDimensionSelectionIsValid('coarse', ['style'])).toBe(true);
    expect(deconDimensionSelectionIsValid('coarse', ['qingxu'])).toBe(false);
    // fine。
    expect(deconDimensionSelectionIsValid('fine', ['qingxu'])).toBe(true);
    expect(deconDimensionSelectionIsValid('fine', ['qingxu', 'style'])).toBe(true); // style 不计入
    expect(deconDimensionSelectionIsValid('fine', ['qingxu', 'fubi', 'jiegou', 'renshe'])).toBe(false);
    expect(deconDimensionSelectionIsValid('fine', [])).toBe(false);
    expect(deconDimensionSelectionIsValid('fine', ['style'])).toBe(false); // style 不算手艺维
    // deep。
    const all12 = deconDeepPrefilledDimensions();
    expect(deconDimensionSelectionIsValid('deep', all12)).toBe(true);
    expect(deconDimensionSelectionIsValid('deep', [...all12, 'style'])).toBe(true);
    expect(deconDimensionSelectionIsValid('deep', all12.slice(1))).toBe(false);
    // 集外 id 拒收。
    expect(deconDimensionSelectionIsValid('fine', ['nonexistent'])).toBe(false);
  });
});

describe('成本预估行', () => {
  it('真实数据形态：继承 pass 不在 byPass → 按旗标合成注记行（tokens=0 + inherited；CR-18）', () => {
    const rows = deconEstimateRows(
      { totalTokens: 100, byPass: { 'p1b': 20, 'p4:huoke': 40, 'p5:book_reading': 30 } },
      { p1a: true, p1b: false, p1c: false },
    );
    const byPass = new Map(rows.map((r) => [r.pass, r]));
    // p1a 不在 byPass（shell estimateDeconCost 对 p1Reusable 省行）——注记行由旗标合成。
    expect(byPass.get('p1a')).toEqual({ pass: 'p1a', tokens: 0, inherited: true });
    expect(byPass.get('p1b')?.inherited).toBe(false);
    expect(byPass.get('p1b')?.tokens).toBe(20);
    expect(byPass.get('p4:huoke')?.inherited).toBe(false); // 'p4' 非 P1 茎
    expect(byPass.get('p4:huoke')?.tokens).toBe(40);
  });

  it('防御：byPass 恰含继承同茎行 → 徽标注在该行（不重复合成）', () => {
    const rows = deconEstimateRows(
      { totalTokens: 100, byPass: { 'p1a': 10 } },
      { p1a: true, p1b: false, p1c: false },
    );
    expect(rows).toEqual([{ pass: 'p1a', tokens: 10, inherited: true }]);
  });
});

describe('pass/unit/report-unit 标签路由', () => {
  it('pass 茎直键；p4:/p5: 带后缀键', () => {
    expect(deconPassLabel('p1b')).toEqual({ stemKey: 'decon.pass.p1b', suffixKeys: [] });
    expect(deconPassLabel('p4:huoke')).toEqual({
      stemKey: 'decon.pass.p4',
      suffixKeys: ['decon.dim.huoke'],
    });
    expect(deconPassLabel('p5:book_reading')).toEqual({
      stemKey: 'decon.pass.p5',
      suffixKeys: ['decon.reportKind.book_reading'],
    });
  });

  it('unit 数字/ch:/arc:/scene: 0 基索引 → 1 基呈现（CR-2）；all/arcs/stats 专项键（CR-17）；字面回落 null', () => {
    expect(deconUnitLabelKey('3')).toEqual({ key: 'decon.unit.chapter', index: 4 });
    expect(deconUnitLabelKey('ch:12')).toEqual({ key: 'decon.unit.chapter', index: 13 });
    expect(deconUnitLabelKey('arc:2')).toEqual({ key: 'decon.unit.arc', index: 3 });
    expect(deconUnitLabelKey('scene:5')).toEqual({ key: 'decon.unit.scene', index: 6 });
    expect(deconUnitLabelKey('all')).toEqual({ key: 'decon.unit.all' });
    expect(deconUnitLabelKey('arcs')).toEqual({ key: 'decon.unit.arcs' });
    expect(deconUnitLabelKey('stats')).toEqual({ key: 'decon.unit.stats' });
    expect(deconUnitLabelKey('world')).toBeNull(); // p2 域名字面——调用方回落原样
  });

  it('report unit：数字前缀 1 基；all/arcs/stats 专项键；字面回落', () => {
    expect(deconReportUnitLabelKey('all')).toEqual({ key: 'decon.unit.all' });
    expect(deconReportUnitLabelKey('arcs')).toEqual({ key: 'decon.unit.arcs' });
    expect(deconReportUnitLabelKey('stats')).toEqual({ key: 'decon.unit.stats' });
    expect(deconReportUnitLabelKey('ch:12')).toEqual({ key: 'decon.unit.chapter', index: 13 });
    expect(deconReportUnitLabelKey('scene:3')).toEqual({ key: 'decon.unit.scene', index: 4 });
  });
});

describe('向导预算输入解析（CR-23——NaN 不静默吞）', () => {
  it('空 → 无预算；正数通过；NaN → nan 拒收；非正/非有限 → invalid 拒收', () => {
    expect(parseDeconBudgetInput('')).toEqual({ ok: true, budget: null });
    expect(parseDeconBudgetInput('   ')).toEqual({ ok: true, budget: null });
    expect(parseDeconBudgetInput('500000')).toEqual({ ok: true, budget: 500000 });
    expect(parseDeconBudgetInput('abc')).toEqual({ ok: false, reason: 'nan' });
    expect(parseDeconBudgetInput('-5')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDeconBudgetInput('0')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDeconBudgetInput('1e999')).toEqual({ ok: false, reason: 'invalid' }); // Number → Infinity
  });
});

describe('payload 形态守卫（unknown seam）', () => {
  it('findings：合法通过 / 缺字段 / 空证据 / 坏 evidence 拒收', () => {
    const valid = {
      findings: [
        {
          insight: '结论',
          elaboration: '展开',
          evidence: [{ paraRange: { start: 0, end: 2 }, quote: '原文' }],
          craftHint: null,
        },
      ],
      synthesis: '小结',
    };
    expect(isDeconFindingsLike(valid)).toBe(true);
    expect(isDeconFindingsLike(null)).toBe(false);
    expect(isDeconFindingsLike({ findings: [], synthesis: '' })).toBe(true); // 空 findings 合法（无发现）
    expect(
      isDeconFindingsLike({ findings: [{ insight: 'a', elaboration: 'b', evidence: [] }], synthesis: '' }),
    ).toBe(false); // 空证据（无锚即丢红线——守卫面拒收）
    expect(
      isDeconFindingsLike({
        findings: [{ insight: 'a', elaboration: 'b', evidence: [{ paraRange: { start: 0 }, quote: 'x' }] }],
        synthesis: '',
      }),
    ).toBe(false); // paraRange 缺 end
  });

  it('style payload：sections 值皆字符串 + 纯代码三节必出', () => {
    const valid = {
      sections: { voice: 'a', stats: 'b', excerpt: 'c', appendix: 'd' },
      excerptAnchors: [],
      bookTitle: '书名',
      materialId: 'mat-aaaaaaaaaaaa',
    };
    expect(isDeconStylePayloadLike(valid)).toBe(true);
    expect(isDeconStylePayloadLike({ ...valid, sections: { voice: 'a' } })).toBe(false); // 缺纯代码三节
    expect(isDeconStylePayloadLike({ ...valid, sections: { ...valid.sections, voice: 1 } })).toBe(false); // 非字符串值
    expect(isDeconStylePayloadLike(null)).toBe(false);
  });
});
