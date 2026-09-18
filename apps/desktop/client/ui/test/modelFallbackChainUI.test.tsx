/**
 * 09-12 子2 fallback chains W5：UI 面测试。
 *
 * 覆盖（implement.md W5 清单）：
 * - 链编辑 round-trip（add/remove/move/换模型/条目 thinking）+ 写侧两态（空链不落
 *   fallbacks 键）+ 已选禁用 + auto 档结构性无链。
 * - AgentMessages：回退通知条渲染（含 scopeLabel）/ 当前模型 chip 三态（自动 / dialogue
 *   派生初值 / model-fallback 翻转）。
 * - AgentMessageItem：generatedBy 徽标新旧消息两态（有字段渲染「实际模型」/ 无字段零渲染）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ApiKeyEntry, ModelConfig, SlotAssignment } from '@orison/shared-contracts';
import { AgentSettingsPage } from '../src/shared/components/settings/AgentSettingsPage';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { AgentMessageItem } from '../src/features/agent-panel/AgentMessageItem';
import { useAppStore } from '../src/shared/store/appStore';
// CR-1：真 yaml 装配的 t（useI18n 的非 hook 通道——同一 locale cache，eager glob 解析
// 真实 settings.yaml）。jsdom 测试若注 fake t（返回键名），键误挂子块（如挂进
// settings.update）永远测不出——生产 UI 渲染原始键串而测试照绿。
import { translate } from '../src/shared/i18n/useI18n';

const apiMocks = vi.hoisted(() => ({
  resumeChapterChain: vi.fn(async () => ({ status: 'paused', errors: [] })),
}));
vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});

const twoModelKey: ApiKeyEntry = {
  id: 'key_001',
  name: '主中转',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  models: [
    { id: 'gpt-4o', alias: 'GPT 4o', capability: 'text', enabled: true },
    { id: 'glm-5.3', alias: 'GLM 5.3', capability: 'text', enabled: true },
    // CR-23 回流测试需要第二个带 registry 思考档案的模型（换模型后条目思考行仍在）。
    { id: 'glm-5.2', alias: 'GLM 5.2', capability: 'text', enabled: true },
    { id: 'qwen-max', alias: 'Qwen Max', capability: 'text', enabled: true },
  ],
};

function buildConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { keys: overrides.keys ?? [twoModelKey], ...overrides };
}

const tZh = (key: string, vars?: Record<string, string | number>) => translate('zh-CN', key, vars);

afterEach(() => cleanup());

// ═══ 0. i18n 键位守卫（CR-1 防再犯——fake t 时代测不出的键误挂）═══

describe('回退链 i18n 键位守卫（CR-1）', () => {
  const FALLBACK_CHAIN_KEYS = [
    'fallbackChain',
    'fallbackChainHint',
    'fallbackAdd',
    'fallbackRemove',
    'fallbackMoveUp',
    'fallbackMoveDown',
    'fallbackEntryModel',
  ] as const;

  it.each(['zh-CN', 'en-US'])('%s：七键必须挂在 settings 根级可解析（误挂子块 → 渲染原始键串）', (locale) => {
    for (const key of FALLBACK_CHAIN_KEYS) {
      expect(translate(locale, `settings.${key}`), `${locale} settings.${key}`).not.toBe(`settings.${key}`);
    }
  });
});

// ═══ 1. 链编辑 round-trip（AgentSettingsPage → ModelAssignmentSections）═══

describe('回退链编辑器（settings §8①）', () => {
  it('auto 档（无显式指派）不渲染链子区；显式指派档渲染（结构性无链保证）', () => {
    render(
      <AgentSettingsPage
        t={tZh}
        modelConfig={buildConfig({
          taskModels: { 'writer-draft': { keyId: 'key_001', modelId: 'gpt-4o' } },
        })}
        setModelConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // 六档中只有 writer-draft 配了指派 → 链子区恰一处（其余五档 auto 无链）。
    //（链子区 label 是 span 文本非表单 label——getAllByText 断言；真 yaml 文案。）
    expect(screen.getAllByText('回退链')).toHaveLength(1);
  });

  it('添加回退模型：取首个未选模型追加（主指派已选不重复）', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsPage
        t={tZh}
        modelConfig={buildConfig({
          taskModels: { 'writer-draft': { keyId: 'key_001', modelId: 'gpt-4o' } },
        })}
        setModelConfig={setModelConfig}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '添加回退模型' }));

    expect(setModelConfig).toHaveBeenCalledTimes(1);
    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    const assignment = arg.taskModels?.['writer-draft'] as SlotAssignment;
    expect(assignment.fallbacks).toEqual([{ keyId: 'key_001', modelId: 'glm-5.3' }]);
    // 主指派不变。
    expect(assignment.keyId).toBe('key_001');
    expect(assignment.modelId).toBe('gpt-4o');
  });

  it('已选禁用去重：主指派与前序条目在后续条目 select 中 disabled（本条目自身可回显）', () => {
    render(
      <AgentSettingsPage
        t={tZh}
        modelConfig={buildConfig({
          taskModels: {
            'writer-draft': {
              keyId: 'key_001',
              modelId: 'gpt-4o',
              fallbacks: [
                { keyId: 'key_001', modelId: 'glm-5.3' },
                { keyId: 'key_001', modelId: 'qwen-max' },
              ],
            },
          },
        })}
        setModelConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // 第二条目的模型 select：主指派（gpt-4o）与条目 1（glm-5.3）disabled；自身（qwen-max）可选。
    const entrySelects = screen.getAllByLabelText('模型') as HTMLSelectElement[];
    expect(entrySelects).toHaveLength(2);
    const second = entrySelects[1]!;
    const optionByValue = (value: string) =>
      [...second.options].find((o) => o.value === value)!;
    expect(optionByValue('key_001::gpt-4o').disabled).toBe(true);
    expect(optionByValue('key_001::glm-5.3').disabled).toBe(true);
    expect(optionByValue('key_001::qwen-max').disabled).toBe(false);
    // 回显：两条目各自选中自己的值。
    expect(entrySelects[0]!.value).toBe('key_001::glm-5.3');
    expect(entrySelects[1]!.value).toBe('key_001::qwen-max');
  });

  it('删除末条 → 空链不落 fallbacks 键（写侧两态）', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsPage
        t={tZh}
        modelConfig={buildConfig({
          taskModels: {
            'writer-draft': {
              keyId: 'key_001',
              modelId: 'gpt-4o',
              fallbacks: [{ keyId: 'key_001', modelId: 'glm-5.3' }],
            },
          },
        })}
        setModelConfig={setModelConfig}
      />,
    );
    await userEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!);

    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    const assignment = arg.taskModels?.['writer-draft'] as SlotAssignment;
    expect('fallbacks' in assignment).toBe(false);
  });

  it('上移重排序（序即回退优先级）', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsPage
        t={tZh}
        modelConfig={buildConfig({
          taskModels: {
            'writer-draft': {
              keyId: 'key_001',
              modelId: 'gpt-4o',
              fallbacks: [
                { keyId: 'key_001', modelId: 'glm-5.3' },
                { keyId: 'key_001', modelId: 'qwen-max' },
              ],
            },
          },
        })}
        setModelConfig={setModelConfig}
      />,
    );
    // 条目 2 上移 → qwen-max 进链首。
    await userEvent.click(screen.getAllByRole('button', { name: '上移' })[1]!);
    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    expect((arg.taskModels?.['writer-draft'] as SlotAssignment).fallbacks?.map((e) => e.modelId)).toEqual([
      'qwen-max',
      'glm-5.3',
    ]);
  });

  // CR-23：旧版此测试自称验证「换模型 → thinking 重置」但 setModelConfig 是 mock，
  // 写入不回流组件——断言打在陈旧渲染上（原注释自认）。现用回流 harness（写入即
  // 重渲）真验：切换条目 = fresh 条目（thinking/thinkingCustom 丢）+ custom 草稿清。
  it('CR-23: 条目换模型 → custom thinking 草稿与已存策略一并重置（真实回流断言）', async () => {
    const writes: ModelConfig[] = [];
    function FeedbackSettingsPage({ initial }: { initial: ModelConfig }) {
      const [config, setConfig] = useState(initial);
      const write = (next: ModelConfig) => {
        writes.push(next);
        setConfig(next);
        return Promise.resolve();
      };
      return <AgentSettingsPage t={tZh} modelConfig={config} setModelConfig={write} />;
    }

    render(
      <FeedbackSettingsPage
        initial={buildConfig({
          taskModels: {
            'writer-draft': {
              keyId: 'key_001',
              modelId: 'gpt-4o',
              fallbacks: [{ keyId: 'key_001', modelId: 'glm-5.3', thinking: 'low' }],
            },
          },
        })}
      />,
    );

    // ① 条目（glm-5.3，customHint=enum）选「自定义…」→ 入草稿态；键入合法值落配置。
    const entryThinking = screen.getAllByLabelText('思考')[0] as HTMLSelectElement;
    await userEvent.selectOptions(entryThinking, 'custom');
    const customInput = screen.getByLabelText('自定义值') as HTMLInputElement;
    await userEvent.type(customInput, 'high');
    // 唯一一次合法写入（中间态 h/hi/hig 均非法不发）。
    expect(writes).toHaveLength(1);
    expect(writes[0]!.taskModels?.['writer-draft']?.fallbacks?.[0]).toEqual({
      keyId: 'key_001',
      modelId: 'glm-5.3',
      thinkingCustom: 'high',
    });
    // 回流后 select 停在 custom、草稿值可回显。
    expect((screen.getAllByLabelText('思考')[0] as HTMLSelectElement).value).toBe('custom');

    // ② 换模型（glm-5.3 → glm-5.2）→ fresh 条目（策略丢）+ 草稿清（select 回 auto、
    // 自定义输入整行消失）。
    const entrySelect = screen.getAllByLabelText('模型')[0] as HTMLSelectElement;
    await userEvent.selectOptions(entrySelect, 'key_001::glm-5.2');
    expect(writes[1]!.taskModels?.['writer-draft']?.fallbacks?.[0]).toEqual({
      keyId: 'key_001',
      modelId: 'glm-5.2',
    });
    expect((screen.getAllByLabelText('思考')[0] as HTMLSelectElement).value).toBe('auto');
    expect(screen.queryByLabelText('自定义值')).toBeNull();

    // ③ 重选统一档 → 落在新模型条目上（per-entry thinking 正常路径）。
    await userEvent.selectOptions(screen.getAllByLabelText('思考')[0] as HTMLSelectElement, 'low');
    expect(writes[2]!.taskModels?.['writer-draft']?.fallbacks?.[0]).toEqual({
      keyId: 'key_001',
      modelId: 'glm-5.2',
      thinking: 'low',
    });
  });
});

// ═══ 2. AgentMessages：通知条 + 当前模型 chip ═══

describe('AgentMessages 运行期模型可见性（§8②⑤）', () => {
  beforeEach(() => {
    useAppStore.setState({
      currentProject: { path: '/proj-a' },
      pausedReviewBySession: {},
      chainRunBySession: {},
      chainRunAnchorByProject: {},
    } as never);
    useAppStore.setState({
      agentSessionId: 'sess-a',
      agentMessages: [],
      activeSessionRunning: true,
      modelFallbackNotices: {},
      activeModelBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({
      chainRunBySession: {},
      chainRunAnchorByProject: {},
      agentSessionId: null,
      activeSessionRunning: false,
      currentProject: null,
      modelFallbackNotices: {},
      activeModelBySession: {},
    } as never);
  });

  // ⚠️ 真组件走 useI18n——默认 resolvedLocale = en-US（settingsSlice 默认），断言用英文文案。
  it('当前模型 chip：无指派 → Auto；dialogue 指派 → 模型别名；事件翻转 → 接管模型', () => {
    const { rerender } = render(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.getByText('Current model')).toBeTruthy();
    expect(screen.getByText('Auto')).toBeTruthy();

    // dialogue 档指派 → chip 初值 = 指派模型别名。
    useAppStore.setState({
      modelConfig: buildConfig({
        taskModels: { dialogue: { keyId: 'key_001', modelId: 'gpt-4o' } },
      }),
    } as never);
    rerender(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.getByText('GPT 4o')).toBeTruthy();

    // model-fallback 翻转：activeModelBySession = 接管家（B 别名覆盖）。
    useAppStore.setState({
      activeModelBySession: { 'sess-a': { keyId: 'key_001', modelId: 'qwen-max' } },
    } as never);
    rerender(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.getByText('Qwen Max')).toBeTruthy();
    expect(screen.queryByText('GPT 4o')).toBeNull();
  });

  it('chip 非生成中不渲染（运行阶段可见性——idle 不占屏）', () => {
    useAppStore.setState({ activeSessionRunning: false } as never);
    render(<AgentMessages messages={[]} loading={false} error={null} />);
    expect(screen.queryByText('Current model')).toBeNull();
  });

  it('回退通知条：渲染 from/to 显示名 + kind 短标签 + 链节点 scopeLabel（en-US 默认文案）', () => {
    useAppStore.setState({
      modelConfig: buildConfig(),
      modelFallbackNotices: {
        'sess-a': [
          {
            id: 'n1',
            from: { keyId: 'key_001', modelId: 'gpt-4o' },
            to: { keyId: 'key_001', modelId: 'qwen-max' },
            reason: 'quota: HTTP 429',
            attempt: 1,
            at: Date.now(),
            scopeLabel: 'draft-writer',
          },
        ],
      },
    } as never);
    render(<AgentMessages messages={[]} loading error={null} />);
    // en-US 模板 "{from} failed ({reason}) → switched to {to}"；reason kind → 短标签。
    const strip = document.querySelector('.agent-fallback-notice');
    expect(strip?.textContent).toContain('GPT 4o failed (quota or rate limit) → switched to Qwen Max');
    expect(strip?.textContent).toContain('draft-writer');
  });
});

// ═══ 3. AgentMessageItem：generatedBy 徽标新旧消息两态 ═══

describe('AgentMessageItem 终态徽标（§8③）', () => {
  it('无 generatedBy（旧消息）→ 零渲染；有 → 「实际模型」+ 回退来源', () => {
    useAppStore.setState({
      modelConfig: buildConfig(),
      resolvedLocale: 'zh-CN',
    } as never);
    const { rerender } = render(
      <AgentMessageItem
        message={{ id: 'm1', role: 'assistant', content: '旧消息', createdAt: Date.now() }}
      />,
    );
    expect(document.querySelector('.agent-msg-generated-by')).toBeNull();

    rerender(
      <AgentMessageItem
        message={{
          id: 'm2',
          role: 'assistant',
          content: '回退后消息',
          createdAt: Date.now(),
          generatedBy: {
            keyId: 'key_001',
            modelId: 'qwen-max',
            fallbackFrom: [{ keyId: 'key_001', modelId: 'gpt-4o', reason: 'quota: x' }],
          },
        }}
      />,
    );
    const badge = document.querySelector('.agent-msg-generated-by');
    expect(badge?.textContent).toContain('Qwen Max');
    expect(badge?.textContent).toContain('GPT 4o');
  });

  // CR-24：多失败全列——fallbackFrom ≥2 条时逐家显示名都在（不只 [0]，漏显会让
  // 用户误判失败面）。
  it('CR-24: 多失败徽标全列（fallbackFrom 逐家显示名，不只首条）', () => {
    useAppStore.setState({
      modelConfig: buildConfig(),
      resolvedLocale: 'zh-CN',
    } as never);
    render(
      <AgentMessageItem
        message={{
          id: 'm3',
          role: 'assistant',
          content: '链尽前一家接住的消息',
          createdAt: Date.now(),
          generatedBy: {
            keyId: 'key_001',
            modelId: 'qwen-max',
            fallbackFrom: [
              { keyId: 'key_001', modelId: 'gpt-4o', reason: 'quota: 429' },
              { keyId: 'key_001', modelId: 'glm-5.3', reason: 'timeout: 60s' },
            ],
          },
        }}
      />,
    );
    const badge = document.querySelector('.agent-msg-generated-by');
    expect(badge?.textContent).toContain('Qwen Max');
    expect(badge?.textContent).toContain('GPT 4o');
    expect(badge?.textContent).toContain('GLM 5.3');
  });
});
