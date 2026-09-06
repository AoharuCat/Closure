/**
 * craft 页 i18n 齐平守卫（E10.2b W5.5；mirror materialsI18n 谱）。
 *
 * 1. **zh/en 键集完全相等**（结构性 diff——加键漏一侧即红）。
 * 2. **所有叶子值非空字符串**（interpolate 契约）。
 * 3. **页面壳键逐键在位**（组件实际消费清单——缺键显裸键名；只守活键）。
 * 4. **词表键对拍**：大类 13（CRAFT_CARD_CATEGORIES 常量穷举——开放面全呈现纪律）/
 *    状态三态 / rank 三档 / phase 四相位 / skip 四原因——契约枚举原样。
 * 5. **插值占位完整**（count/value/message 等占位丢失 = 渲染裸模板）。
 * 6. **nav.craft 两 locale 在位** + translate 通道冒烟（eager glob 真见到新文件）。
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  CRAFT_CARD_CATEGORY_VALUES,
  CRAFT_CARD_STATUSES,
  CRAFT_TEACHING_RANKS,
} from '@orison/shared-contracts';
import { CRAFT_DISTILL_PHASES } from '@orison/shared-contracts';
import zhRaw from '../src/shared/i18n/zh-CN/craft.yaml?raw';
import enRaw from '../src/shared/i18n/en-US/craft.yaml?raw';
import navZhRaw from '../src/shared/i18n/zh-CN/nav.yaml?raw';
import navEnRaw from '../src/shared/i18n/en-US/nav.yaml?raw';
import { translate } from '../src/shared/i18n/useI18n';

function flattenEntries(node: unknown, prefix: string, out: Map<string, unknown>): void {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') flattenEntries(value, path, out);
      else out.set(path, value);
    }
  }
}

const zhDoc = yaml.load(zhRaw) as Record<string, unknown>;
const enDoc = yaml.load(enRaw) as Record<string, unknown>;
const zhEntries = new Map<string, unknown>();
const enEntries = new Map<string, unknown>();
flattenEntries(zhDoc.craft, '', zhEntries);
flattenEntries(enDoc.craft, '', enEntries);

// 页面壳键（组件实际消费清单——CraftPage/CraftQueueView/CraftCardRow/CraftCardDetail/
// CraftMergeReviewView/CraftTermsView + 材料页联动引用面）。
const SHELL_KEYS = [
  'title',
  ...(['queue', 'all', 'rejected', 'terms'] as const).map((t) => `tabs.${t}`),
  ...CRAFT_CARD_STATUSES.map((s) => `status.${s}`),
  'badge.stale',
  'badge.staleHint',
  'badge.dispute',
  'badge.disputeHint',
  'badge.mergeCandidate',
  ...(['low', 'mid', 'high'] as const).map((c) => `confidence.${c}`),
  'confidence.tooltip',
  ...CRAFT_CARD_CATEGORY_VALUES.map((c) => `category.${c}`),
  ...CRAFT_TEACHING_RANKS.map((r) => `rank.${r}`),
  ...CRAFT_DISTILL_PHASES.map((p) => `phase.${p}`),
  ...(['pending', 'verified', 'rejected', 'pendingTerms', 'dispute'] as const).map((s) => `stats.${s}`),
  'list.loading',
  'list.error',
  'list.empty',
  'queue.unlinkedMaterial',
  'queue.groupCount',
  'queue.empty',
  'rejected.empty',
  'card.back',
  'card.verify',
  'card.reject',
  'card.rejectConfirm',
  'card.rejectReasonLabel',
  'card.rejectReasonShown',
  'card.recover',
  'card.title',
  'card.term',
  'card.disputeToggle',
  'card.disputeOn',
  'card.disputeOff',
  'card.tags',
  'card.tagPlaceholder',
  'card.tagAdd',
  'card.tagRemove',
  'card.condensed',
  'card.points',
  'card.scenarios',
  'card.counterexamples',
  'card.listFieldPlaceholder',
  'card.teachingCount',
  'card.teachings',
  'card.unknownAuthor',
  'card.staleHint',
  'card.anchorJump',
  'card.anchorHint',
  'card.anchorOpened',
  'card.anchorMissing',
  'card.anchorOpenFailed',
  'card.anchorPathCopied',
  'tagFilterHint',
  'merge.title',
  'merge.pendingTitle',
  'merge.rowTitle',
  'merge.newClaim',
  'merge.existing',
  'merge.similarity',
  'merge.similarityHint',
  'merge.disputePredicted',
  'merge.noDispute',
  'merge.disputeUnavailable',
  'merge.existingGone',
  'merge.merge',
  'merge.independent',
  'merge.dismiss',
  'merge.reviewGone',
  'terms.pendingTitle',
  'terms.pendingEmpty',
  'terms.approve',
  'terms.merge',
  'terms.mergeTargetPlaceholder',
  'terms.allTitle',
  'terms.mergedInto',
  'terms.pendingSuffix',
  'distill.run',
  'distill.jump',
  'distill.idleBadge',
  'distill.pendingBadge',
  'distill.runningBadge',
  'distill.runningTooltip',
  'distill.doneBadge',
  'distill.doneTooltip',
  'distill.doneTooltipStats',
  'distill.doneErrorNote',
  'distill.failedBadge',
  'distill.deletedBadge',
  'distill.notDistillable',
  'distill.queuedToast',
  'distill.failedToast',
  'distill.batchHead',
  'distill.batchCount',
  'distill.batchRun',
  'distill.batchRunHint',
  'distill.batchEmpty',
  'distill.batchQueuedToast',
  ...(['not-found', 'not-ready', 'already-running', 'hash-unchanged'] as const).map(
    (r) => `distill.skip.${r}`,
  ),
  'action.refresh',
  'toast.saved',
  'toast.savedDowngraded',
  'toast.saveFailed',
  'toast.reviewFailed',
  'toast.verified',
  'toast.rejected',
  'toast.recovered',
  'toast.rankSaved',
  'toast.mergeMerged',
  'toast.mergeIndependent',
  'toast.mergeDismissed',
  'toast.mergeFailed',
  'toast.termApproved',
  'toast.termMerged',
  'toast.termFailed',
];

describe('craft 页 i18n 齐平（zh/en）', () => {
  it('两 locale 键集完全相等（加键漏一侧即红）', () => {
    expect(zhEntries.size).toBeGreaterThan(100);
    expect(enEntries.size).toBe(zhEntries.size);
    expect([...zhEntries.keys()].sort()).toEqual([...enEntries.keys()].sort());
  });

  it('所有叶子值均为非空字符串', () => {
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const [key, value] of entries) {
        expect(typeof value, `${locale} ${key} 值须为字符串`).toBe('string');
        expect(String(value).trim().length, `${locale} ${key} 存在空文案值`).toBeGreaterThan(0);
      }
    }
  });

  it('页面壳键逐键在位（组件实际消费清单——缺键显裸键名）', () => {
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const key of SHELL_KEYS) {
        expect(entries.has(key), `${locale} 缺页面壳键 ${key}`).toBe(true);
      }
    }
  });

  it('大类 13 词表键与 CRAFT_CARD_CATEGORIES 常量穷举对拍（受控词表全呈现）', () => {
    expect(CRAFT_CARD_CATEGORY_VALUES.length).toBe(13);
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const category of CRAFT_CARD_CATEGORY_VALUES) {
        expect(entries.has(`category.${category}`), `${locale} 缺大类键 ${category}`).toBe(true);
      }
    }
  });

  it('插值占位完整（两侧——丢占位 = 渲染裸模板）', () => {
    const placeholders: Array<[string, string]> = [
      ['confidence.tooltip', '{value}'],
      ['stats.pending', '{count}'],
      ['stats.verified', '{count}'],
      ['stats.rejected', '{count}'],
      ['stats.pendingTerms', '{count}'],
      ['stats.dispute', '{count}'],
      ['list.error', '{message}'],
      ['queue.groupCount', '{count}'],
      ['merge.pendingTitle', '{count}'],
      ['merge.similarity', '{value}'],
      ['merge.disputePredicted', '{reason}'],
      ['card.rejectReasonShown', '{reason}'],
      ['card.tagRemove', '{tag}'],
      ['card.teachingCount', '{count}'],
      ['card.teachings', '{count}'],
      ['card.anchorOpened', '{para}'],
      ['card.anchorHint', '{para}'],
      ['card.anchorHint', '{chars}'],
      ['card.anchorPathCopied', '{path}'],
      ['terms.pendingTitle', '{count}'],
      ['terms.allTitle', '{count}'],
      ['terms.mergedInto', '{target}'],
      ['distill.runningBadge', '{phase}'],
      ['distill.runningBadge', '{elapsed}'],
      ['distill.runningTooltip', '{phase}'],
      ['distill.runningTooltip', '{elapsed}'],
      ['distill.doneBadge', '{count}'],
      ['distill.doneTooltip', '{newCards}'],
      ['distill.doneTooltip', '{mergedAuto}'],
      ['distill.doneTooltipStats', '{claims}'],
      ['distill.doneTooltipStats', '{anchored}'],
      ['distill.doneTooltipStats', '{droppedNoAnchor}'],
      ['distill.doneTooltipStats', '{droppedMalformed}'],
      ['distill.doneTooltipStats', '{droppedNoCategory}'],
      ['distill.doneErrorNote', '{note}'],
      ['distill.failedToast', '{message}'],
      ['distill.batchCount', '{count}'],
      ['distill.batchRunHint', '{count}'],
      ['distill.batchQueuedToast', '{count}'],
      ['toast.saveFailed', '{message}'],
      ['toast.reviewFailed', '{message}'],
      ['toast.mergeFailed', '{message}'],
      ['toast.termApproved', '{name}'],
      ['toast.termMerged', '{name}'],
      ['toast.termMerged', '{count}'],
      ['toast.termFailed', '{message}'],
      ['badge.staleHint', '{count}'],
    ];
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const [key, placeholder] of placeholders) {
        expect(String(entries.get(key)), `${locale} ${key} 丢 ${placeholder} 占位`).toContain(placeholder);
      }
    }
  });
});

describe('nav.craft（icon-rail 新钮）', () => {
  it('两 locale 在位非空（yaml 直读）', () => {
    const navZh = yaml.load(navZhRaw) as { nav?: Record<string, unknown> };
    const navEn = yaml.load(navEnRaw) as { nav?: Record<string, unknown> };
    for (const [locale, doc] of [['zh-CN', navZh], ['en-US', navEn]] as const) {
      const val = doc.nav?.craft;
      expect(typeof val, `${locale} nav.craft 缺失`).toBe('string');
      expect(String(val).trim().length, `${locale} nav.craft 不得为空`).toBeGreaterThan(0);
    }
  });

  it('translate 通道可解析（eager glob 加载链真见到新文件）', () => {
    expect(translate('zh-CN', 'nav.craft')).not.toBe('nav.craft');
    expect(translate('en-US', 'nav.craft')).not.toBe('nav.craft');
    expect(translate('zh-CN', 'craft.title')).not.toBe('craft.title');
    expect(translate('zh-CN', 'craft.category.renshe')).not.toBe('craft.category.renshe');
    expect(translate('en-US', 'craft.distill.doneBadge')).not.toBe('craft.distill.doneBadge');
  });
});
