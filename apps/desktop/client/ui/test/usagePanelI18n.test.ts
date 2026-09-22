/**
 * 09-12 子5（应用内用量面板）：i18n 真实 yaml 装配断言（design §5 键清单）。
 *
 * 用 `translate` 通道（真实装配 i18n/<locale>/*.yaml，非 mock t）断言 zh/en 双语
 * 全键在位——键缺失时 translate 回落键名本身，断言「≠ 键名」即装配守门。另断言
 * zh/en 键集对齐（单侧漏键 = 漂移）。
 */
import { describe, expect, it } from 'vitest';

import { translate } from '../src/shared/i18n/useI18n';

/** design §5 键清单（nav 键 + usagePanel.* 全套 + R6 两键 + 实施补列的表头键）。 */
const USAGE_PANEL_KEYS = [
  'pageSubtitle',
  'today',
  'last7d',
  'total',
  'totalRetentionNote',
  'tilesSection',
  'modelMultiKeys',
  'calls',
  'failedCalls',
  'callsColumn',
  'tokens',
  'input',
  'output',
  'thinking',
  'cacheRead',
  'tokensUnreported',
  'costEstimate',
  'costEstimateHeader',
  'costNoteShort',
  'costNote',
  'byModel',
  'byTask',
  'taskColumn',
  'taskUnlabeled',
  'recent',
  'recentEmpty',
  'timeColumn',
  'protocolColumn',
  'latency',
  'firstDelta',
  'imageCount',
  'statusColumn',
  'statusOk',
  'statusFailed',
  'retention',
  'retentionLabel',
  'retentionUnit',
  'retentionRangeWarn',
  'retentionInvalidWarn',
  'retentionSaveFailed',
  'retentionHint',
  'clear',
  'clearConfirmTitle',
  'clearConfirmBody',
  'clearDone',
  'clearFailed',
  'loading',
  'loadFailed',
  'empty',
  'refresh',
  'linksTitle',
  'linkCredits',
  'linkCreditsNote',
  'linkUsageGuide',
  'linkUsageGuideNote',
  'linkGemini',
  'linkGeminiNote',
  'contextBarLabel',
  'contextBarEstimated',
] as const;

describe('usagePanel i18n 装配（真实 yaml，translate 通道）', () => {
  it('nav 键 settings.usage 双语在位', () => {
    expect(translate('zh-CN', 'settings.usage')).toBe('用量');
    expect(translate('en-US', 'settings.usage')).toBe('Usage');
  });

  it.each(USAGE_PANEL_KEYS)('usagePanel.%s zh/en 双语在位（回落键名 = 缺键）', (key) => {
    const fullKey = `usagePanel.${key}`;
    expect(translate('zh-CN', fullKey), `zh-CN 缺键 ${fullKey}`).not.toBe(fullKey);
    expect(translate('en-US', fullKey), `en-US 缺键 ${fullKey}`).not.toBe(fullKey);
  });

  it('插值键带 {n}/{amount}/{ms} 占位（变量不被吞）', () => {
    expect(translate('zh-CN', 'usagePanel.calls', { n: 3 })).toContain('3');
    expect(translate('zh-CN', 'usagePanel.costEstimate', { amount: '1.5' })).toContain('1.5');
    expect(translate('zh-CN', 'usagePanel.firstDelta', { ms: '320ms' })).toContain('320ms');
    expect(translate('en-US', 'usagePanel.failedCalls', { n: 2 })).toContain('2');
  });

  it('外链标注如实：Gemini 不含 Antigravity / 5h 周窗无网页通道（zh 关键词）', () => {
    expect(translate('zh-CN', 'usagePanel.linkGeminiNote')).toContain('Antigravity');
    expect(translate('zh-CN', 'usagePanel.linkUsageGuideNote')).toContain('/usage');
    expect(translate('zh-CN', 'usagePanel.costNote')).toContain('仅供参考');
  });

  it('ToS 共享文案键（子1 落地单源）双语在位', () => {
    expect(translate('zh-CN', 'settings.cliTosRiskNote')).not.toBe('settings.cliTosRiskNote');
    expect(translate('en-US', 'settings.cliTosRiskNote')).not.toBe('settings.cliTosRiskNote');
  });
});
