/**
 * decon 页 i18n 齐平守卫（E10.3b W6；mirror craftI18n 谱）。
 *
 * 1. **zh/en 键集完全相等**（结构性 diff——加键漏一侧即红）。
 * 2. **所有叶子值非空字符串**（interpolate 契约）。
 * 3. **页面壳键逐键在位**（组件实际消费清单——缺键显裸键名；只守活键）。
 * 4. **词表键对拍**：维度 13（DECON_DIMENSION_IDS 穷举）/ 状态七态（DECON_JOB_STATUSES）/
 *    reportKind 四 kind / 实体五类 / canon 六域 / 闸门三 checkpoint——契约枚举原样。
 * 5. **插值占位完整**（count/message/tokens 等占位丢失 = 渲染裸模板）。
 * 6. **nav.decon 两 locale 在位** + translate 通道冒烟（eager glob 真见到新文件）。
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  DECON_CANON_DOMAINS,
  DECON_DIMENSION_IDS,
  DECON_ENTITY_TYPES,
  DECON_JOB_STATUSES,
  DECON_REPORT_KINDS,
  DECON_REVIEW_CHECKPOINTS,
} from '@orison/shared-contracts';
import zhRaw from '../src/shared/i18n/zh-CN/decon.yaml?raw';
import enRaw from '../src/shared/i18n/en-US/decon.yaml?raw';
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
flattenEntries(zhDoc.decon, '', zhEntries);
flattenEntries(enDoc.decon, '', enEntries);

// 页面壳键（组件实际消费清单——DeconPage/DeconNewJobWizard/DeconJobPanel）。
const SHELL_KEYS = [
  'title',
  ...(['loading', 'error', 'empty', 'retry', 'newJob'] as const).map((k) => `list.${k}`),
  ...(['coarse', 'fine', 'deep'] as const).map((k) => `tier.${k}`),
  ...(['coarseHint', 'fineHint', 'deepHint'] as const).map((k) => `tier.${k}`),
  ...DECON_DIMENSION_IDS.map((d) => `dim.${d}`),
  ...DECON_JOB_STATUSES.map((s) => `status.${s}`),
  ...(['pending', 'running', 'gate-paused', 'paused', 'capped', 'stale', 'failed', 'done', 'cancelled'] as const).map(
    (k) => `banner.${k}`,
  ),
  ...(['p1a', 'p1b', 'p1c', 'p2', 'p3a', 'p3b', 'p4', 'p5', 'p6'] as const).map((p) => `pass.${p}`),
  ...(['chapter', 'arc', 'scene', 'all', 'arcs', 'stats', 'literal'] as const).map((u) => `unit.${u}`),
  ...([
    'title', 'material', 'materialPlaceholder', 'materialEmpty', 'materialExcludedHint', 'tier',
    'dimensions', 'dimFineCount', 'dimCoarseHint', 'dimDeepHint', 'invalidDims', 'reviewGates',
    'gatesOn', 'gatesOff', 'budget', 'budgetPlaceholder', 'budgetNaN', 'budgetInvalid', 'create',
    'cancel', 'estimateTitle', 'estimateTotal', 'estimateInherited', 'start', 'createFailed',
  ] as const).map((k) => `wizard.${k}`),
  ...DECON_REVIEW_CHECKPOINTS.map((c) => `review.${c}`),
  ...([
    'gateTitle', 'approve', 'entities', 'entityRow', 'dictionaryEntries', 'dictionaryRow',
    'canonEntries', 'findingsFor', 'evidencePara', 'craftHintChip', 'noFindings', 'truncatedHint',
    'approved', 'off', 'approveFailed',
  ] as const).map((k) => `review.${k}`),
  ...([
    'tabReading', 'tabChapters', 'tabScenes', 'tabStyle', 'tabCanon', 'loading', 'readingEmpty',
    'chaptersEmpty', 'scenesEmpty', 'styleEmpty', 'canonEmpty', 'selectChapter', 'selectScene',
    'styleExport', 'styleExportNoProject', 'styleExportConfirmTitle', 'styleExportConfirmBody',
    'styleExportDone', 'styleExportFailed', 'craftZoneTitle', 'craftZoneCount', 'craftZoneEmpty',
    'craftZoneJump', 'reportFailed', 'anchorsTitle', 'anchorRow',
  ] as const).map((k) => `output.${k}`),
  ...DECON_REPORT_KINDS.map((k) => `reportKind.${k}`),
  ...DECON_ENTITY_TYPES.map((t) => `entityType.${t}`),
  ...DECON_CANON_DOMAINS.map((d) => `canonDomain.${d}`),
  ...(['refresh', 'pause', 'resume', 'resumeWithBudget', 'cancel', 'delete', 'confirmRerun'] as const).map(
    (a) => `action.${a}`,
  ),
  'deleteConfirmTitle',
  'deleteConfirmMessage',
  'deleteConfirmLabel',
  'budgetPrompt',
  'budgetApply',
  'costLabel',
  'materialMissing',
  ...([
    'started', 'startNoop', 'startFailed', 'transitionFailed', 'deleted', 'deleteFailed',
    'gateApproved', 'gateApproveFailed', 'confirmRerunStarted', 'confirmRerunFailed',
  ] as const).map((k) => `toast.${k}`),
];

describe('decon 页 i18n 齐平（zh/en）', () => {
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

  it('词表键与契约枚举穷举对拍（维度 13/状态八态/kind 四/实体五类/六域/三闸门）', () => {
    expect(DECON_DIMENSION_IDS.length).toBe(13);
    expect(DECON_JOB_STATUSES.length).toBe(8);
    expect(DECON_REPORT_KINDS.length).toBe(4);
    expect(DECON_ENTITY_TYPES.length).toBe(5);
    expect(DECON_CANON_DOMAINS.length).toBe(6);
    expect(DECON_REVIEW_CHECKPOINTS.length).toBe(3);
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const id of DECON_DIMENSION_IDS) {
        expect(entries.has(`dim.${id}`), `${locale} 缺维度键 ${id}`).toBe(true);
      }
      for (const status of DECON_JOB_STATUSES) {
        expect(entries.has(`status.${status}`), `${locale} 缺状态键 ${status}`).toBe(true);
      }
      for (const kind of DECON_REPORT_KINDS) {
        expect(entries.has(`reportKind.${kind}`), `${locale} 缺报告 kind 键 ${kind}`).toBe(true);
      }
      for (const type of DECON_ENTITY_TYPES) {
        expect(entries.has(`entityType.${type}`), `${locale} 缺实体类型键 ${type}`).toBe(true);
      }
      for (const domain of DECON_CANON_DOMAINS) {
        expect(entries.has(`canonDomain.${domain}`), `${locale} 缺 canon 域键 ${domain}`).toBe(true);
      }
      for (const checkpoint of DECON_REVIEW_CHECKPOINTS) {
        expect(entries.has(`review.${checkpoint}`), `${locale} 缺闸门键 ${checkpoint}`).toBe(true);
      }
    }
  });

  it('插值占位完整（两侧——丢占位 = 渲染裸模板）', () => {
    const placeholders: Array<[string, string]> = [
      ['list.error', '{message}'],
      ['banner.running', '{phase}'],
      ['banner.running', '{elapsed}'],
      ['banner.gate-paused', '{checkpoint}'],
      ['banner.failed', '{message}'],
      ['unit.chapter', '{index}'],
      ['unit.arc', '{index}'],
      ['unit.scene', '{index}'],
      ['unit.literal', '{unit}'],
      ['wizard.materialExcludedHint', '{count}'],
      ['wizard.dimFineCount', '{count}'],
      ['wizard.estimateTotal', '{tokens}'],
      ['wizard.createFailed', '{message}'],
      ['review.gateTitle', '{checkpoint}'],
      ['review.entities', '{count}'],
      ['review.entityRow', '{name}'],
      ['review.entityRow', '{type}'],
      ['review.entityRow', '{count}'],
      ['review.dictionaryEntries', '{count}'],
      ['review.dictionaryRow', '{name}'],
      ['review.dictionaryRow', '{type}'],
      ['review.canonEntries', '{domain}'],
      ['review.canonEntries', '{count}'],
      ['review.findingsFor', '{dim}'],
      ['review.findingsFor', '{count}'],
      ['review.evidencePara', '{start}'],
      ['review.evidencePara', '{end}'],
      ['review.truncatedHint', '{count}'],
      ['review.craftHintChip', '{category}'],
      ['review.approveFailed', '{message}'],
      ['output.styleExportConfirmBody', '{count}'],
      ['output.styleExportDone', '{count}'],
      ['output.styleExportFailed', '{message}'],
      ['output.craftZoneCount', '{count}'],
      ['output.reportFailed', '{message}'],
      ['output.anchorRow', '{chapter}'],
      ['output.anchorRow', '{start}'],
      ['output.anchorRow', '{end}'],
      ['costLabel', '{tokens}'],
      ['toast.startFailed', '{message}'],
      ['toast.transitionFailed', '{message}'],
      ['toast.deleteFailed', '{message}'],
      ['toast.gateApproveFailed', '{message}'],
      ['toast.confirmRerunFailed', '{message}'],
    ];
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const [key, placeholder] of placeholders) {
        expect(String(entries.get(key)), `${locale} ${key} 丢 ${placeholder} 占位`).toContain(placeholder);
      }
    }
  });

  it('craft 来源徽章两键两 locale 在位（craft.yaml additive）', async () => {
    const craftZh = yaml.load(
      (await import('../src/shared/i18n/zh-CN/craft.yaml?raw')).default,
    ) as { craft?: Record<string, unknown> };
    const craftEn = yaml.load(
      (await import('../src/shared/i18n/en-US/craft.yaml?raw')).default,
    ) as { craft?: Record<string, unknown> };
    for (const [locale, doc] of [['zh-CN', craftZh], ['en-US', craftEn]] as const) {
      const card = (doc.craft as Record<string, unknown>)?.card as Record<string, unknown> | undefined;
      expect(typeof card?.originDecon, `${locale} craft.card.originDecon 缺失`).toBe('string');
      expect(typeof card?.originDeconNoTitle, `${locale} craft.card.originDeconNoTitle 缺失`).toBe('string');
      expect(String(card?.originDecon)).toContain('{book}');
    }
  });
});

describe('nav.decon（icon-rail 新钮）', () => {
  it('两 locale 在位非空（yaml 直读）', () => {
    const navZh = yaml.load(navZhRaw) as { nav?: Record<string, unknown> };
    const navEn = yaml.load(navEnRaw) as { nav?: Record<string, unknown> };
    for (const [locale, doc] of [['zh-CN', navZh], ['en-US', navEn]] as const) {
      const val = doc.nav?.decon;
      expect(typeof val, `${locale} nav.decon 缺失`).toBe('string');
      expect(String(val).trim().length, `${locale} nav.decon 不得为空`).toBeGreaterThan(0);
    }
  });

  it('translate 通道可解析（eager glob 加载链真见到新文件）', () => {
    expect(translate('zh-CN', 'nav.decon')).not.toBe('nav.decon');
    expect(translate('en-US', 'nav.decon')).not.toBe('nav.decon');
    expect(translate('zh-CN', 'decon.title')).not.toBe('decon.title');
    expect(translate('zh-CN', 'decon.dim.renshe')).not.toBe('decon.dim.renshe');
    expect(translate('en-US', 'decon.banner.gate-paused')).not.toBe('decon.banner.gate-paused');
  });
});
