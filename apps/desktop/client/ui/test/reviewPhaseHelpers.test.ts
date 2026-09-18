/**
 * 09-13 子3 W5（design §1.3/§4）：审阅相位纯投影层测试。
 *
 * - resolveReviewPauseKind：数据键 → 暂停卡形态派生（pausedReview 优先/escalate 空 items 归
 *   stub/未 paused 恒 null）。
 * - countEditRegions：终稿手改计数（全等 0 / 单段改 1 / 散点多段各计 1 / 段落重排收敛）。
 * - synthesizeEscalateFeedback：勾选合成结构化 feedback 格式（#N [quote 摘] 接受为真相/修订 +
 *   补充说明尾行；忽略与未勾不出现；quote 截断 30）。
 */
import { describe, expect, it } from 'vitest';
import {
  countEditRegions,
  resolveReviewPauseKind,
  synthesizeEscalateFeedback,
} from '../src/features/writing/reviewPhase';
import type { ChapterReviewMetadata } from '@orison/shared-contracts';
import type { EscalateFindingsEntry } from '../src/shared/store/chainTimeline';

const meta = (over: Partial<ChapterReviewMetadata>): ChapterReviewMetadata => ({
  type: 'chapter_review',
  stage: 'draft',
  resumeOptions: ['continue', 'redo', 'abort'],
  ...over,
});

const escalateEntry = (items: EscalateFindingsEntry['items']): EscalateFindingsEntry => ({
  source: 'reader-audit',
  route: 'escalate_user',
  items,
  at: 1,
});

describe('resolveReviewPauseKind（design §4.2 卡形态派生）', () => {
  it('未 paused → null（相位机不进审阅——aborted/error/completed/running 全不切）', () => {
    for (const status of ['running', 'completed', 'error', 'aborted']) {
      expect(resolveReviewPauseKind({ paused: false, pausedReview: meta({ stage: 'final' }), escalateFindings: undefined })).toBeNull();
      expect(status).toBeTruthy(); // 形态占位——判据是 paused 布尔非 status 字符串
    }
  });

  it('pausedReview.stage 派生：final/brief/revision-guard + researchSuspension 优先于 stage', () => {
    expect(resolveReviewPauseKind({ paused: true, pausedReview: meta({ stage: 'final' }), escalateFindings: undefined })).toBe('final');
    expect(resolveReviewPauseKind({ paused: true, pausedReview: meta({ stage: 'brief' }), escalateFindings: undefined })).toBe('brief');
    expect(resolveReviewPauseKind({ paused: true, pausedReview: meta({ stage: 'revision-guard' }), escalateFindings: undefined })).toBe('guard');
    // 挂起：stage='draft' + researchSuspension → suspension（#83/#84 挂起卡非草稿审）。
    expect(resolveReviewPauseKind({
      paused: true,
      pausedReview: meta({
        stage: 'draft',
        researchSuspension: { kind: 'research_contradiction', rounds: 1 } as never,
      }),
      escalateFindings: undefined,
    })).toBe('suspension');
    // legacy draft/verdict 快照 → draft。
    expect(resolveReviewPauseKind({ paused: true, pausedReview: meta({ stage: 'draft' }), escalateFindings: undefined })).toBe('draft');
    expect(resolveReviewPauseKind({ paused: true, pausedReview: meta({ stage: 'verdict' }), escalateFindings: undefined })).toBe('draft');
  });

  it('pausedReview 优先于 escalateFindings（同一 write_chapter 结果上两 metadata 互斥——stale 面防御）', () => {
    expect(resolveReviewPauseKind({
      paused: true,
      pausedReview: meta({ stage: 'final' }),
      escalateFindings: escalateEntry([{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }]),
    })).toBe('final');
  });

  it('无 pausedReview：escalateFindings 有 items → escalate；空 items（已审核锚点）/皆缺 → stub', () => {
    expect(resolveReviewPauseKind({
      paused: true,
      pausedReview: undefined,
      escalateFindings: escalateEntry([{ severity: 'warn', quote: 'q', location: 'l', explanation: 'e' }]),
    })).toBe('escalate');
    expect(resolveReviewPauseKind({
      paused: true,
      pausedReview: undefined,
      escalateFindings: escalateEntry([]),
    })).toBe('stub');
    expect(resolveReviewPauseKind({ paused: true, pausedReview: undefined, escalateFindings: undefined })).toBe('stub');
  });

  // CR-10（09-18 CR 批 B）：两键皆缺但链刚从 running 转 paused（updatedAt 距今 < 8s 窗）
  // → 临时 pending（chapter_review metadata 在途——生产链 stub 卡瞬闪防）；超窗仍 stub。
  it('CR-10 pending 窗：两键皆缺 + updatedAt 距今 < 8s → pending；超窗 → stub（两态）', () => {
    const now = 1_000_000_000_000;
    const base = { paused: true, pausedReview: undefined, escalateFindings: undefined as undefined };
    // 窗内（2s 前）→ pending 占位（非 stub 卡——渲染「正在准备审阅…」）。
    expect(resolveReviewPauseKind({ ...base, pausedUpdatedAt: now - 2_000, now })).toBe('pending');
    // 窗边界内（恰 < 8s）→ pending。
    expect(resolveReviewPauseKind({ ...base, pausedUpdatedAt: now - 7_999, now })).toBe('pending');
    // 超窗（10s 前）→ stub 降级卡（真直跑链，无 metadata 会到）。
    expect(resolveReviewPauseKind({ ...base, pausedUpdatedAt: now - 10_000, now })).toBe('stub');
    // 恰在窗界（= 8s）→ 超窗 stub。
    expect(resolveReviewPauseKind({ ...base, pausedUpdatedAt: now - 8_000, now })).toBe('stub');
    // 窗口参数缺席（旧调用方 back-compat）→ 恒 stub（不猜时间）。
    expect(resolveReviewPauseKind(base)).toBe('stub');
    // 异常时间戳（clock 漂移成负差）→ 不进 pending，落 stub。
    expect(resolveReviewPauseKind({ ...base, pausedUpdatedAt: now + 5_000, now })).toBe('stub');
    // pending 窗不抢权威键：有 pausedReview/escalateFindings 时照常派生真实形态。
    expect(resolveReviewPauseKind({ ...base, pausedReview: meta({ stage: 'final' }), pausedUpdatedAt: now - 100, now })).toBe('final');
    expect(resolveReviewPauseKind({ ...base, escalateFindings: escalateEntry([{ severity: 'block', quote: 'q', location: 'l', explanation: 'e' }]), pausedUpdatedAt: now - 100, now })).toBe('escalate');
  });
});

describe('countEditRegions（终稿手改计数）', () => {
  it('全等 → 0', () => {
    expect(countEditRegions('第一段。\n\n第二段。', '第一段。\n\n第二段。')).toBe(0);
  });

  it('单段内改词 → 1 处', () => {
    const a = '他把杯子放下，转身离开。\n\n第二段保持不变。\n\n第三段。';
    const b = '他把杯子放下了，转身走了。\n\n第二段保持不变。\n\n第三段。';
    expect(countEditRegions(a, b)).toBe(1);
  });

  it('散点多段手改各计一处', () => {
    const a = '第一段原文。\n\n中间段。\n\n第三段原文。\n\n尾段不变。';
    const b = '第一段已改。\n\n中间段。\n\n第三段也改了。\n\n尾段不变。';
    expect(countEditRegions(a, b)).toBe(2);
  });

  it('纯追加/纯删除各计 1 处（连续行收敛成块）', () => {
    expect(countEditRegions('第一段。\n\n第三段。', '第一段。\n\n插入的新段。\n\n第三段。')).toBe(1);
    expect(countEditRegions('第一段。\n\n将被删。\n\n第三段。', '第一段。\n\n第三段。')).toBe(1);
  });

  it('整稿重写（无公共行）→ 1 处（连续变更块）', () => {
    expect(countEditRegions('完全不同的旧文', '完全不同的新文')).toBe(1);
  });

  it('空串 ↔ 非空 = 1 处（dirty + invalid 判定的上游）', () => {
    expect(countEditRegions('', '新写的全部')).toBe(1);
    expect(countEditRegions('旧的全部', '')).toBe(1);
  });
});

describe('synthesizeEscalateFeedback（D-d 勾选即意见）', () => {
  const items = [
    { severity: 'block' as const, quote: '林晚秋知道保险柜密码', location: '第3场', explanation: '与第7章知情圈冲突' },
    { severity: 'warn' as const, quote: '瞒了七年的翻转线机会', location: '第5场', explanation: '叙事机会' },
    { severity: 'warn' as const, quote: '第三条', location: 'x', explanation: 'y' },
  ];

  it('合成格式：#N [quote 摘] 处置；忽略与未勾不出现', () => {
    const fb = synthesizeEscalateFeedback(items, ['accept', undefined, 'ignore'], '');
    expect(fb).toBe('#1 [林晚秋知道保险柜密码] 接受为真相');
  });

  it('混合勾选：接受 + 修订 并列分号；补充说明尾行', () => {
    const fb = synthesizeEscalateFeedback(items, ['accept', 'revise', 'ignore'], ' 修订方向：维持设定  ');
    expect(fb).toBe(
      '#1 [林晚秋知道保险柜密码] 接受为真相；#2 [瞒了七年的翻转线机会] 修订\n补充说明：修订方向：维持设定',
    );
  });

  it('长 quote 截断 30 字（尾省略号）', () => {
    const long = '很'.repeat(40);
    const fb = synthesizeEscalateFeedback(
      [{ severity: 'warn', quote: long, location: 'l', explanation: 'e' }],
      ['revise'],
      '',
    );
    expect(fb).toBe(`#1 [${'很'.repeat(30)}…] 修订`);
  });
});
