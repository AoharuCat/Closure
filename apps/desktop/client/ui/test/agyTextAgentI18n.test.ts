/**
 * 「Closure 文本 Agent」卡片 i18n 装配断言（mirror agyProbeI18n.test.ts 手法）。
 *
 * 用 `translate` 通道（真实装配 i18n/<locale>/*.yaml，非 mock t）断言 zh/en 双语
 * 全键在位——键缺失时 translate 回落键名本身，断言「≠ 键名」即装配守门（ui/testing
 * 纪律：i18n 键必须有穷尽断言，漏一侧 = 红）；另断言关键文案要素（行为披露四件套、
 * 四态、冲突/遮蔽指引、降级 toast）如实。
 *
 * 键清单 = AgyTextAgentSection.tsx 实际消费集（组件消费面清单守卫——死键/漏键都红），
 * 与 settings.yaml `agyTextAgent.*` 键族 1:1；降级 toast 键在 workspace.yaml
 * `notifications.cliTextAgentFallback`（useToolEvents 消费）。
 */
import { describe, expect, it } from 'vitest';

import { translate } from '../src/shared/i18n/useI18n';

/** 文本 Agent 卡片全键清单（settings.yaml 顶层组 agyTextAgent* 键族，34 键 = 组件消费集）。
 *  CR-9③：noKeyNote 随死分支修剪删除（gate 已保证有 key 才渲染）；CR-9① 增 writeNow/
 *  writeNowDone（「立即写入」次级钮）。 */
const TEXT_AGENT_KEYS = [
  'sectionTitle',
  'sectionSubtitle',
  'loading',
  'statusFailed',
  'recheck',
  'stateEnabled',
  'stateDisabled',
  'disclosureFile',
  'disclosureReconcile',
  'disclosureDisable',
  'disclosureIndependent',
  'filePathLabel',
  'fileStateLabel',
  'stateCurrent',
  'stateStale',
  'stateMissing',
  'stateForeign',
  'noteCurrent',
  'noteStale',
  'noteMissing',
  'disabledNote',
  'writeNow',
  'writeNowDone',
  'foreignTitle',
  'foreignHint',
  'shadowTitle',
  'shadowHint',
  'enable',
  'disable',
  'enableDone',
  'enableForeignConflict',
  'enableFailed',
  'disableDone',
  'disableFailed',
] as const;

describe('AgyTextAgentSection i18n 装配（真实 yaml，translate 通道）', () => {
  it('卡片标题双语在位且用词一致（Closure 文本 Agent）', () => {
    expect(translate('zh-CN', 'agyTextAgent.sectionTitle')).toBe('Closure 文本 Agent');
    expect(translate('en-US', 'agyTextAgent.sectionTitle')).toBe('Closure text agent');
  });

  it.each(TEXT_AGENT_KEYS)('agyTextAgent.%s zh/en 双语在位（回落键名 = 缺键）', (key) => {
    const fullKey = `agyTextAgent.${key}`;
    expect(translate('zh-CN', fullKey), `zh-CN 缺键 ${fullKey}`).not.toBe(fullKey);
    expect(translate('en-US', fullKey), `en-US 缺键 ${fullKey}`).not.toBe(fullKey);
  });

  it('行为披露四件套要素如实：写文件 / 启动对账 / 关闭即删 / 与桥独立（zh/en）', () => {
    expect(translate('zh-CN', 'agyTextAgent.disclosureFile')).toContain('agent');
    expect(translate('zh-CN', 'agyTextAgent.disclosureReconcile')).toContain('启动');
    expect(translate('zh-CN', 'agyTextAgent.disclosureDisable')).toContain('删除');
    expect(translate('zh-CN', 'agyTextAgent.disclosureIndependent')).toContain('独立');
    expect(translate('en-US', 'agyTextAgent.disclosureReconcile')).toContain('startup');
    expect(translate('en-US', 'agyTextAgent.disclosureDisable')).toContain('deletes');
    expect(translate('en-US', 'agyTextAgent.disclosureIndependent')).toContain('Independent');
  });

  it('冲突/遮蔽指引语义如实：外来不覆盖不代删、同名静默竞速且加载结果未定义（zh/en）', () => {
    expect(translate('zh-CN', 'agyTextAgent.foreignHint')).toContain('不覆盖、不代删');
    // CR-11 文案校准：不再用「零警告静默覆盖」这种确定性表述（探针 n=1 未定谳胜者）
    // ——改为「静默竞速 + 加载结果未定义」。
    expect(translate('zh-CN', 'agyTextAgent.shadowHint')).toContain('静默竞速');
    expect(translate('zh-CN', 'agyTextAgent.shadowHint')).toContain('未定义');
    expect(translate('zh-CN', 'agyTextAgent.shadowHint')).not.toContain('覆盖');
    expect(translate('en-US', 'agyTextAgent.shadowHint')).toContain('race silently');
    expect(translate('en-US', 'agyTextAgent.shadowHint')).toContain('undefined');
  });

  it('CR-9「立即写入」键在位：noteMissing/noteStale 指向该钮；noKeyNote 死键已删（zh/en）', () => {
    expect(translate('zh-CN', 'agyTextAgent.writeNow')).toBe('立即写入');
    expect(translate('en-US', 'agyTextAgent.writeNow')).toBe('Write now');
    expect(translate('zh-CN', 'agyTextAgent.noteMissing')).toContain('立即写入');
    expect(translate('en-US', 'agyTextAgent.noteMissing')).toContain('Write now');
    // 死键删除：translate 回落键名本身（现值应恒为键名 = 已不在词表）。
    expect(translate('zh-CN', 'agyTextAgent.noKeyNote')).toBe('agyTextAgent.noKeyNote');
    expect(translate('en-US', 'agyTextAgent.noKeyNote')).toBe('agyTextAgent.noKeyNote');
  });

  it('降级 toast 键双语在位（workspace.notifications 键族，useToolEvents 消费）', () => {
    const fullKey = 'notifications.cliTextAgentFallback';
    expect(translate('zh-CN', fullKey)).not.toBe(fullKey);
    expect(translate('en-US', fullKey)).not.toBe(fullKey);
    expect(translate('zh-CN', fullKey)).toContain('文本 Agent');
  });
});
