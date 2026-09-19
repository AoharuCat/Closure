/**
 * 「反重力状态探测」卡片 i18n 装配断言（mirror usagePanelI18n.test.ts 手法）。
 *
 * 用 `translate` 通道（真实装配 i18n/<locale>/*.yaml，非 mock t）断言 zh/en 双语
 * 全键在位——键缺失时 translate 回落键名本身，断言「≠ 键名」即装配守门；另断言
 * 关键文案要素（插值变量、失效指引内容）如实。
 */
import { describe, expect, it } from 'vitest';

import { translate } from '../src/shared/i18n/useI18n';

/** 探针卡片全键清单（settings.cliProbe* 键族）。 */
const PROBE_KEYS = [
  'cliProbeSectionTitle',
  'cliProbeSectionSubtitle',
  'cliProbeUnprobed',
  'cliProbeStatusOk',
  'cliProbeAuthDead',
  'cliProbeAuthDeadHint',
  'cliProbeFailed',
  'cliProbeButton',
  'cliProbeRunFailed',
] as const;

describe('AgyProbeSection i18n 装配（真实 yaml，translate 通道）', () => {
  it('卡片标题双语在位且用词一致（反重力状态探测）', () => {
    expect(translate('zh-CN', 'settings.cliProbeSectionTitle')).toBe('反重力状态探测');
    expect(translate('en-US', 'settings.cliProbeSectionTitle')).toBe('Antigravity status probe');
  });

  it.each(PROBE_KEYS)('settings.%s zh/en 双语在位（回落键名 = 缺键）', (key) => {
    const fullKey = `settings.${key}`;
    expect(translate('zh-CN', fullKey), `zh-CN 缺键 ${fullKey}`).not.toBe(fullKey);
    expect(translate('en-US', fullKey), `en-US 缺键 ${fullKey}`).not.toBe(fullKey);
  });

  it('连接正常徽标带 {time} 插值（变量不被吞）', () => {
    expect(translate('zh-CN', 'settings.cliProbeStatusOk', { time: '09:30' })).toContain('09:30');
    expect(translate('en-US', 'settings.cliProbeStatusOk', { time: '09:30' })).toContain('09:30');
  });

  it('登录失效指引如实：切换账号 / 终端运行 agy 重新登录（zh/en 双语）', () => {
    expect(translate('zh-CN', 'settings.cliProbeAuthDeadHint')).toContain('切换账号');
    expect(translate('zh-CN', 'settings.cliProbeAuthDeadHint')).toContain('agy');
    expect(translate('en-US', 'settings.cliProbeAuthDeadHint')).toContain('account');
    expect(translate('en-US', 'settings.cliProbeAuthDeadHint')).toContain('agy');
  });

  it('副标题如实：真实探测 + 结果只存本机内存', () => {
    expect(translate('zh-CN', 'settings.cliProbeSectionSubtitle')).toContain('内存');
    expect(translate('en-US', 'settings.cliProbeSectionSubtitle')).toContain('memory');
  });
});
