/**
 * materials 页 i18n 齐平守卫（Story 10.1 Wave D；mirror settingPageI18n /
 * worldStateI18n 谱）。
 *
 * 1. **zh/en 键集完全相等**（结构性 diff——加键漏一侧即红）。
 * 2. **所有叶子值非空字符串**（interpolate 契约）。
 * 3. **页面壳键逐键在位**（组件实际消费清单——缺键显裸键名；**只守活键不保死键**——
 *    CR-012 清理的零消费键反向断言在位，防回流）。
 * 4. **medium/tier/format/method/confidence/rejectedKind 词表齐平**（与 contracts/material.ts
 *    + ipc.ts 拒收词表〔六档：格式/超大/超批量/stem 冲突/敏感源/源缺失——CR-001/011〕对拍
 *    ——开放词表 UI 全呈现纪律）。
 * 5. **插值占位完整**（count/name/done/total/message 等占位丢失 = 渲染裸模板）。
 * 6. **nav.materials 两 locale 在位** + translate 通道冒烟（eager glob 真见到新文件）。
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import zhRaw from '../src/shared/i18n/zh-CN/materials.yaml?raw';
import enRaw from '../src/shared/i18n/en-US/materials.yaml?raw';
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
flattenEntries(zhDoc.materials, '', zhEntries);
flattenEntries(enDoc.materials, '', enEntries);

// 页面壳键（组件实际消费清单——MaterialsPage/MaterialRow/ProvenanceForm 引用面）。
const SHELL_KEYS = [
  'title',
  'scope.project',
  'scope.global',
  'scope.projectDisabledHint',
  'list.name',
  'list.medium',
  'list.quality',
  'list.chapters',
  'list.chars',
  'list.time',
  'list.empty',
  'list.loading',
  'list.error',
  'list.retry',
  ...(['txt', 'md', 'docx', 'pdf', 'epub', 'srt', 'ass', 'vtt'] as const).map((f) => `format.${f}`),
  ...([
    'novel_text', 'lecture', 'interview', 'criticism', 'wiki', 'other',
    'game_files', 'community_data', 'runtime_hook', 'screen_capture', 'video',
  ] as const).map((m) => `medium.${m}`),
  ...(['original', 'community', 'criticism', 'unspecified'] as const).map((v) => `tier.${v}`),
  'quality.scanned',
  'quality.nonUtf8',
  'quality.ok',
  'quality.failed',
  'chapter.count',
  ...(['regex', 'llm-fallback', 'manual', 'none'] as const).map((m) => `chapter.method.${m}`),
  ...(['high', 'medium', 'low', 'manual'] as const).map((c) => `chapter.confidence.${c}`),
  'chapter.lowConfidenceBadge',
  'chapter.lowConfidenceHint',
  'action.delete',
  'action.deleteConfirmTitle',
  'action.deleteConfirmMessage',
  'action.deleteConfirmLabel',
  'action.reingest',
  'action.openDerived',
  'action.revealDerived',
  'action.editProvenance',
  'action.refresh',
  'import.dropzone',
  'import.dropzoneActive',
  'import.browse',
  'import.progress',
  'import.summary',
  'import.rejectedSummary',
  'import.failedSummary',
  ...(
    [
      'unsupported-format', 'too-large', 'batch-overflow',
      'stem-conflict', 'sensitive', 'missing',
    ] as const
  ).map((k) => `import.rejectedKind.${k}`),
  'import.failedTitle',
  'import.source.title',
  'import.source.skipMedium',
  'import.source.skipTier',
  'import.source.saved',
  'import.sourceSaveFailed',
  'provenance.title',
  'provenance.nameLabel',
  'provenance.medium',
  'provenance.tier',
  'provenance.author',
  'provenance.lang',
  'provenance.originDate',
  'provenance.description',
  'provenance.mediumPlaceholder',
  'provenance.tierPlaceholder',
  'provenance.saved',
  'provenance.nameSaved',
  'provenance.saveFailed',
  'provenance.loading',
  'provenance.loadFailed',
  'toast.deleted',
  'toast.deleteFailed',
  'toast.reingested',
  'toast.reingestFailed',
  'toast.openDerivedFailed',
  'toast.derivedMissing',
  'toast.pathCopied',
  'toast.pathUnavailable',
];

// CR-012 清理的死键（零消费——表单 blur/change 落盘无 save/close 钮、列表无 format 列、
// 拒收/失败清单无标题行）。反向断言在位防回流：只守活键，不保死键。
const DEAD_KEYS = [
  'list.format',
  'provenance.save',
  'provenance.close',
  'import.rejectedList',
  'import.failedList',
];

describe('materials 页 i18n 齐平（zh/en）', () => {
  it('两 locale 键集完全相等（加键漏一侧即红）', () => {
    expect(zhEntries.size).toBeGreaterThan(80);
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

  it('死键不回流（CR-012 清理的零消费键——只守活键不保死键）', () => {
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const key of DEAD_KEYS) {
        expect(entries.has(key), `${locale} 死键回流入库 ${key}（零消费——若重新启用须先进组件再进此清单）`).toBe(false);
      }
    }
  });

  it('插值占位完整（两侧——丢占位 = 渲染裸模板）', () => {
    const placeholders: Array<[string, string]> = [
      ['chapter.count', '{count}'],
      ['action.deleteConfirmMessage', '{name}'],
      ['import.progress', '{done}'],
      ['import.progress', '{total}'],
      ['import.summary', '{count}'],
      ['import.rejectedSummary', '{count}'],
      ['import.failedSummary', '{count}'],
      ['import.failedTitle', '{message}'],
      ['import.sourceSaveFailed', '{message}'],
      ['provenance.saveFailed', '{message}'],
      ['provenance.loadFailed', '{message}'],
      ['list.error', '{message}'],
      ['toast.deleted', '{name}'],
      ['toast.deleteFailed', '{message}'],
      ['toast.reingested', '{name}'],
      ['toast.reingestFailed', '{message}'],
      ['toast.pathCopied', '{path}'],
    ];
    for (const [locale, entries] of [['zh-CN', zhEntries], ['en-US', enEntries]] as const) {
      for (const [key, placeholder] of placeholders) {
        expect(String(entries.get(key)), `${locale} ${key} 丢 ${placeholder} 占位`).toContain(placeholder);
      }
    }
  });
});

describe('nav.materials（icon-rail 新钮）', () => {
  it('两 locale 在位非空（yaml 直读）', () => {
    const navZh = yaml.load(navZhRaw) as { nav?: Record<string, unknown> };
    const navEn = yaml.load(navEnRaw) as { nav?: Record<string, unknown> };
    for (const [locale, doc] of [['zh-CN', navZh], ['en-US', navEn]] as const) {
      const val = doc.nav?.materials;
      expect(typeof val, `${locale} nav.materials 缺失`).toBe('string');
      expect(String(val).trim().length, `${locale} nav.materials 不得为空`).toBeGreaterThan(0);
    }
  });

  it('translate 通道可解析（eager glob 加载链真见到新文件）', () => {
    expect(translate('zh-CN', 'nav.materials')).not.toBe('nav.materials');
    expect(translate('en-US', 'nav.materials')).not.toBe('nav.materials');
    expect(translate('zh-CN', 'materials.title')).not.toBe('materials.title');
    expect(translate('en-US', 'materials.medium.game_files')).not.toBe('materials.medium.game_files');
  });
});
