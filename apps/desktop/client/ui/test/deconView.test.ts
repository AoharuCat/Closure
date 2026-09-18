/**
 * deconView 纯函数测试（E10.3b W6——零 React 零 IPC）。
 *
 * 覆盖：
 * - 状态横幅判定（闸门暂停优先——review 行 pending 区分「等审」与用户暂停，design §6）；
 * - pass_state 聚合（千 unit 行 → 按 pass done/total；多态计数）+ U18/CR-6 化石过滤（契约
 *   非法清单单源——数字/ch:/arc:/域 unit 族 + 化石-only pass 整行不呈现）；
 * - 材料过滤（F-12：low-confidence 分章/零章/pending/failed 不可拆——排除 + 提示面）；
 * - 档位 × 维度校验客户端 mirror（coarse⊆{style} / fine 1-3 / deep 全 12）+ 档位可见目录
 *   （粗拆只显风格维——拍板②）+ deep 预填；
 * - 成本预估行（byPass 展开 + P1 继承打折**注记行**——旗标驱动不依赖 byPass 行存在，CR-18；
 *   p4:<dim> 归 'p4' 茎不误标）+ CR-17 预估说明键路由；
 * - pass/unit/report-unit 标签路由（CR-1 拍板 B：章 unit 优先 chapterLabels 真实章标字面量，
 *   缺键回落「材料第 {index} 章」原始 index；arc/scene 1 基；arcs/stats 专项键 progress/
 *   report 两路径单源——CR-17）；resume 落点（CR-8 条件化）+ ETA（CR-7 中位数韧性）；
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
  deconChapterUnitLabel,
  deconDimensionSelectionIsValid,
  deconDimensionsForTier,
  deconDeepPrefilledDimensions,
  deconEligibleMaterials,
  deconEstimateNoteKey,
  deconEstimateRows,
  deconPassEtaMs,
  deconPassLabel,
  deconPendingReview,
  deconReportUnitLabel,
  deconResumeNextChapter,
  deconUnitLabel,
  isDeconCanonPayloadLike,
  isDeconFindingsLike,
  isDeconStylePayloadLike,
  isDeconStyleStatsLike,
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

  it("U18/CR-6 化石防御：契约非法清单 pass 的 (all,failed) 行不计入分母/红点（判据单源 DECON_ILLEGAL_ALL_UNIT_PASSES——数字/ch:/arc:/域 unit 族全覆盖）", () => {
    // 数字 unit 族（p1b——R3 竞态化石 98 章全 done + ('p1b','all','failed')）。
    const rows = [
      ...Array.from({ length: 98 }, (_, i) => passStateFixture('p1b', String(i), 'done')),
      passStateFixture('p1b', 'all', 'failed'),
    ];
    let summaries = summarizeDeconPassStates(rows);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ total: 98, done: 98, failed: 0 });
    // ch: unit 族（p5:chapter_review）与 arc: unit 族（p4:fubi）化石同样过滤（首现序）。
    summaries = summarizeDeconPassStates([
      passStateFixture('p5:chapter_review', 'ch:0', 'done'),
      passStateFixture('p5:chapter_review', 'all', 'failed'),
      passStateFixture('p4:fubi', 'arc:0', 'done'),
      passStateFixture('p4:fubi', 'all', 'failed'),
    ]);
    expect(summaries.map((s) => s.pass)).toEqual(['p5:chapter_review', 'p4:fubi']);
    expect(summaries[0]).toMatchObject({ total: 1, done: 1, failed: 0 });
    expect(summaries[1]).toMatchObject({ total: 1, done: 1, failed: 0 });
    // 域 unit 族（p2——纯预检失败 job 只剩 ('p2','all','failed') 一行）：化石-only pass 整行不呈现。
    summaries = summarizeDeconPassStates([passStateFixture('p2', 'all', 'failed')]);
    expect(summaries).toEqual([]);
    // p3b（arcs/stats 两行形态——'all' 非法）化石过滤。
    summaries = summarizeDeconPassStates([
      passStateFixture('p3b', 'arcs', 'done'),
      passStateFixture('p3b', 'all', 'failed'),
    ]);
    expect(summaries[0]).toMatchObject({ total: 1, done: 1, failed: 0 });
  });

  it('CR-6 防误伤：单 unit pass（p1a/p1c/p6/p4:style/p5:book_reading 的 all 是唯一合法 unit）不受过滤影响', () => {
    const summaries = summarizeDeconPassStates([
      passStateFixture('p1a', 'all', 'failed'),
      passStateFixture('p1c', 'all', 'done'),
      passStateFixture('p6', 'all', 'failed'),
      passStateFixture('p4:style', 'all', 'capped'),
      passStateFixture('p5:book_reading', 'all', 'done'),
      passStateFixture('p2', 'world', 'done'),
    ]);
    expect(summaries).toHaveLength(6);
    for (const summary of summaries) {
      expect(summary).toMatchObject({ total: 1 });
    }
    expect(summaries.find((s) => s.pass === 'p1a')).toMatchObject({ failed: 1 });
    expect(summaries.find((s) => s.pass === 'p1c')).toMatchObject({ done: 1 });
    expect(summaries.find((s) => s.pass === 'p6')).toMatchObject({ failed: 1 });
    expect(summaries.find((s) => s.pass === 'p4:style')).toMatchObject({ capped: 1 });
  });
});

describe('failed 续跑落点 / pass ETA（C7 / U4 / CR-7 / CR-8）', () => {
  it('CR-8：落点章仅在失败点确在 p1b（存在非 done 章号行）时给出——N = 最大 done + 1（无 done 章 → 0 首章）', () => {
    // 失败在 p1b 第 14 章（done 最大 13）→ 落点 14。
    expect(
      deconResumeNextChapter([
        passStateFixture('p1b', '0', 'done'),
        passStateFixture('p1b', '13', 'done'),
        passStateFixture('p1b', '14', 'failed'),
        passStateFixture('p3a', '50', 'done'), // 异 pass 不算
        passStateFixture('p1b', 'all', 'failed'), // 化石行不算（非章号 unit）
      ]),
    ).toBe(14);
    // 失败在 p1b 首章（零 done）→ 落点 0（首章即重入点——不假造 null）。
    expect(deconResumeNextChapter([passStateFixture('p1b', '0', 'pending')])).toBe(0);
    // p1b 章号行全 done（失败在后续 pass）→ null（中性「继续拆解」）。
    expect(
      deconResumeNextChapter([
        passStateFixture('p1b', '0', 'done'),
        passStateFixture('p1b', '1', 'done'),
        passStateFixture('p3a', '2', 'failed'),
      ]),
    ).toBeNull();
    // 无 p1b 行（预检失败）→ null。
    expect(deconResumeNextChapter([])).toBeNull();
  });

  it('CR-7 passEtaMs：区间中位数 × 剩余（pending/running）；capped/failed 不进分母；离群慢区间不拉爆；样本不足/同拍/无剩余 → null', () => {
    const base = Date.parse('2026-09-05T08:00:00.000Z');
    // 4 done 间隔 60s + 剩余 2 pending → median 60s × 2 = 120000。
    const rows = [
      ...[0, 1, 2, 3].map((i) => ({
        ...passStateFixture('p1b', String(i), 'done'),
        updatedAt: new Date(base + i * 60_000).toISOString(),
      })),
      passStateFixture('p1b', '4', 'pending'),
      passStateFixture('p1b', '5', 'pending'),
    ];
    expect(deconPassEtaMs(rows, 'p1b')).toBe(120_000);
    // capped/failed 行不进剩余分母（暂停数小时后不虚报）——同数据 + 2 行 capped/failed 仍 120000。
    expect(
      deconPassEtaMs(
        [...rows, passStateFixture('p1b', '6', 'capped'), passStateFixture('p1b', '7', 'failed')],
        'p1b',
      ),
    ).toBe(120_000);
    // 离群慢区间（一次暂停数小时）不再拉爆估计——median 取中位区间。
    const withOutlier = [
      ...[0, 1, 2, 3].map((i) => ({
        ...passStateFixture('p1b', String(i), 'done'),
        updatedAt: new Date(
          base + i * 60_000 + (i === 3 ? 4 * 3_600_000 : 0), // 第 4 个 done 前停了 4h。
        ).toISOString(),
      })),
      passStateFixture('p1b', '4', 'pending'),
    ];
    // 区间 = [60s, 60s, 4h+60s] → median 60s × 剩余 1 = 60s（均值口径会给 ~1.5h）。
    expect(deconPassEtaMs(withOutlier, 'p1b')).toBe(60_000);
    // 样本不足（done < 3）。
    expect(deconPassEtaMs(rows.slice(2), 'p1b')).toBeNull();
    // 零跨度（同拍时间戳——无序列真值，不假造）。
    const sameTs = ['0', '1', '2'].map((u) => passStateFixture('p1b', u, 'done'));
    expect(deconPassEtaMs(sameTs, 'p1b')).toBeNull();
    // pass 已完成（无 pending/running 剩余；capped/failed 不算剩余）。
    const complete = [
      ...['0', '1', '2'].map((u, i) => ({
        ...passStateFixture('p1b', u, 'done'),
        updatedAt: new Date(base + i * 60_000).toISOString(),
      })),
      passStateFixture('p1b', '3', 'failed'),
    ];
    expect(deconPassEtaMs(complete, 'p1b')).toBeNull();
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

  it('CR-1 拍板 B unit 标签：章 unit（数字/ch:）优先 chapterLabels 真实章标字面量；缺键/未装载回落「材料第 {index} 章」键（原始 index 零算术）；arc/scene 1 基；all/arcs/stats 专项键；字面回落 null', () => {
    const labels: Record<number, string> = { 0: '简介（卷首）', 3: '第 3 章 古碑微光', 12: '正文（无章标）' };
    // chapterLabels 命中 → 真实章标字面量。
    expect(deconUnitLabel('0', labels)).toEqual({ literal: '简介（卷首）' });
    expect(deconUnitLabel('3', labels)).toEqual({ literal: '第 3 章 古碑微光' });
    expect(deconUnitLabel('ch:12', labels)).toEqual({ literal: '正文（无章标）' });
    // 缺键（7 不在表）→ i18n 键回落。
    expect(deconUnitLabel('7', labels)).toEqual({ key: 'decon.unit.materialChapter', index: 7 });
    // 未装载（undefined）→ 全回落（旧观感「材料第 0 章」守 detail 载荷）。
    expect(deconUnitLabel('0')).toEqual({ key: 'decon.unit.materialChapter', index: 0 });
    // 非章 unit 不受 chapterLabels 影响。
    expect(deconUnitLabel('arc:2')).toEqual({ key: 'decon.unit.arc', index: 3 });
    expect(deconUnitLabel('scene:5')).toEqual({ key: 'decon.unit.scene', index: 6 });
    expect(deconUnitLabel('all')).toEqual({ key: 'decon.unit.all' });
    expect(deconUnitLabel('arcs')).toEqual({ key: 'decon.unit.arcs' });
    expect(deconUnitLabel('stats')).toEqual({ key: 'decon.unit.stats' });
    expect(deconUnitLabel('world')).toBeNull(); // p2 域名字面——调用方回落原样
  });

  it('deconChapterUnitLabel：章标签单源（命中字面量 / 缺键键回落；空串视为缺键）', () => {
    expect(deconChapterUnitLabel(2, { 2: '第 2 章' })).toEqual({ literal: '第 2 章' });
    expect(deconChapterUnitLabel(2, { 2: '' })).toEqual({ key: 'decon.unit.materialChapter', index: 2 });
    expect(deconChapterUnitLabel(2)).toEqual({ key: 'decon.unit.materialChapter', index: 2 });
  });

  it('report unit：章 unit 同 chapterLabels 单制；all/arcs/stats 专项键；字面回落 literal 键', () => {
    const labels: Record<number, string> = { 12: '第 12 章' };
    expect(deconReportUnitLabel('all')).toEqual({ key: 'decon.unit.all' });
    expect(deconReportUnitLabel('arcs')).toEqual({ key: 'decon.unit.arcs' });
    expect(deconReportUnitLabel('stats')).toEqual({ key: 'decon.unit.stats' });
    expect(deconReportUnitLabel('ch:12', labels)).toEqual({ literal: '第 12 章' });
    expect(deconReportUnitLabel('ch:13', labels)).toEqual({ key: 'decon.unit.materialChapter', index: 13 });
    expect(deconReportUnitLabel('scene:3')).toEqual({ key: 'decon.unit.scene', index: 4 });
    expect(deconReportUnitLabel('world')).toEqual({ key: 'decon.unit.literal' });
  });

  it('CR-17 预估说明键路由：p4 茎归一 / p4:style 特化 / p5 kind 取首词段 / 其余直键', () => {
    expect(deconEstimateNoteKey('p1b')).toBe('decon.wizard.estimateNote.p1b');
    expect(deconEstimateNoteKey('p3a')).toBe('decon.wizard.estimateNote.p3a');
    expect(deconEstimateNoteKey('p4:huoke')).toBe('decon.wizard.estimateNote.p4');
    expect(deconEstimateNoteKey('p4:style')).toBe('decon.wizard.estimateNote.p4style');
    expect(deconEstimateNoteKey('p5:book_reading')).toBe('decon.wizard.estimateNote.p5book');
    expect(deconEstimateNoteKey('p5:chapter_review')).toBe('decon.wizard.estimateNote.p5chapter');
    expect(deconEstimateNoteKey('p5:scene_annotation')).toBe('decon.wizard.estimateNote.p5scene');
    expect(deconEstimateNoteKey('p6')).toBe('decon.wizard.estimateNote.p6');
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

  it('canon payload 守卫（U2——passthrough 最小结构守卫）：对象通过 / null·数组·原始值拒收', () => {
    expect(isDeconCanonPayloadLike({ evidence: 'exact', summary: 's' })).toBe(true);
    expect(isDeconCanonPayloadLike({})).toBe(true); // 域内字段逐个守卫——空对象合法（全折叠）
    expect(isDeconCanonPayloadLike(null)).toBe(false);
    expect(isDeconCanonPayloadLike('text')).toBe(false);
    expect(isDeconCanonPayloadLike([1, 2])).toBe(false);
  });

  it('styleStats 守卫（F18——p3b stats 行回落数据源）：分布五字段全有限数 + ratio 0-1', () => {
    const dist = { count: 10, min: 1, avg: 5.5, max: 20, sigma: 3.2 };
    expect(isDeconStyleStatsLike({ sentenceChars: dist, paragraphChars: dist, dialogueLineRatio: 0.42 })).toBe(true);
    expect(isDeconStyleStatsLike({ sentenceChars: dist, paragraphChars: { ...dist, avg: 'x' }, dialogueLineRatio: 0.42 })).toBe(false);
    expect(isDeconStyleStatsLike({ sentenceChars: dist, paragraphChars: dist, dialogueLineRatio: 1.5 })).toBe(false);
    expect(isDeconStyleStatsLike(null)).toBe(false);
  });
});
