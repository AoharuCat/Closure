/**
 * Agent 设置页 = 模型分工三段（dogfood 2026-08-21 #43 迁自模型配置页）：
 * 任务模型档位路由（C3.2 六档 + 09-13 R1b 审核族细档四档）+ 向量/重排 sidecar 选择器。
 * 原「补丁模式」死开关（autoApplyPatches，零消费者）已整链退役，不再有对应 UI。
 *
 * 纯 props 渲染（t + modelConfig + setModelConfig）+ 唯一 store 读（U7：agyBridgeStore
 * 桥授权态——CLI 徽标两态文案；jsdom 下桥缺席 fetch 返 null 不写状态，零 IPC 依赖）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyEntry, ModelConfig } from '@orison/shared-contracts';
import { AgentSettingsPage } from '../src/shared/components/settings/AgentSettingsPage';
import { __resetAgyBridgeStoreForTest, useAgyBridgeStore } from '../src/shared/store/agyBridgeStore';

const baseKey: ApiKeyEntry = {
  id: 'key_001',
  name: 'GPT-4o',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-test',
  models: [
    {
      id: 'gpt-4o',
      alias: 'GPT-4o Omni',
      capability: 'text',
      enabled: true,
    },
  ],
};

function buildConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { keys: overrides.keys ?? [baseKey], ...overrides };
}

const tFake = (key: string) => key;

// The task-routing slot label keys (C3.2 + 09-13 R1b 审核族细档), in DEFS order.
const TASK_SLOT_LABEL_KEYS = [
  'settings.taskSlotWriterSelfcheck',
  'settings.taskSlotWriterDraft',
  'settings.taskSlotReviewJudge',
  'settings.taskSlotPlanReview',
  'settings.taskSlotMultiReview',
  'settings.taskSlotRouteJudge',
  'settings.taskSlotRevisionGuard',
  'settings.taskSlotExtraction',
  'settings.taskSlotDispatch',
  'settings.taskSlotDialogue',
] as const;

afterEach(() => {
  cleanup();
  __resetAgyBridgeStoreForTest();
});

describe('AgentSettingsPage 模型分工（迁自模型配置页，dogfood #43）', () => {
  describe('task model slots', () => {
    it('renders ten slot selects (six + R1b fine review slots), each defaulting to Auto with an empty value', () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(<AgentSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);

      expect(TASK_SLOT_LABEL_KEYS).toHaveLength(10);
      for (const labelKey of TASK_SLOT_LABEL_KEYS) {
        const select = screen.getByLabelText(labelKey) as HTMLSelectElement;
        // "Auto" is the first option and carries the empty value.
        expect(select.options[0]?.value).toBe('');
        expect(select.value).toBe('');
      }
    });

    it('reflects an existing taskModels designation as the selected value', () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({
            taskModels: { 'writer-draft': { keyId: 'key_001', modelId: 'gpt-4o' } },
          })}
          setModelConfig={setModelConfig}
        />,
      );

      const draftSelect = screen.getByLabelText('settings.taskSlotWriterDraft') as HTMLSelectElement;
      expect(draftSelect.value).toBe('key_001::gpt-4o');
      const dialogueSelect = screen.getByLabelText('settings.taskSlotDialogue') as HTMLSelectElement;
      expect(dialogueSelect.value).toBe('');
    });

    it('selecting a model persists the parsed ref into taskModels', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(<AgentSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);

      await userEvent.selectOptions(
        screen.getByLabelText('settings.taskSlotWriterSelfcheck'),
        'key_001::gpt-4o',
      );

      expect(setModelConfig).toHaveBeenCalledTimes(1);
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.taskModels).toEqual({
        'writer-selfcheck': { keyId: 'key_001', modelId: 'gpt-4o' },
      });
      // The rest of the config rides along untouched.
      expect(arg.keys).toHaveLength(1);
    });

    it('switching a slot back to Auto removes only that key, no empty entries', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({
            taskModels: {
              'writer-draft': { keyId: 'key_001', modelId: 'gpt-4o' },
              dialogue: { keyId: 'key_001', modelId: 'gpt-4o' },
            },
          })}
          setModelConfig={setModelConfig}
        />,
      );

      await userEvent.selectOptions(screen.getByLabelText('settings.taskSlotWriterDraft'), '');

      expect(setModelConfig).toHaveBeenCalledTimes(1);
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.taskModels).toEqual({
        dialogue: { keyId: 'key_001', modelId: 'gpt-4o' },
      });
    });

    it('picking Auto on an unset slot performs no write', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(<AgentSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);

      await userEvent.selectOptions(screen.getByLabelText('settings.taskSlotDialogue'), '');

      expect(setModelConfig).not.toHaveBeenCalled();
    });

    // ── CR-006: dangling designation lifecycle ──

    it('CR-006: a designation whose model left the enabled options renders an explicit stale option (not a fake Auto)', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({
            taskModels: { 'writer-draft': { keyId: 'key_001', modelId: 'gpt-4o-mini' } }, // gpt-4o-mini not enabled
          })}
          setModelConfig={setModelConfig}
        />,
      );

      const draftSelect = screen.getByLabelText('settings.taskSlotWriterDraft') as HTMLSelectElement;
      // The select SHOWS the configured ref — not an empty value masquerading as Auto.
      expect(draftSelect.value).toBe('key_001::gpt-4o-mini');
      expect(
        screen.getByText('settings.taskModelStale: key_001 / gpt-4o-mini'),
      ).toBeInTheDocument();

      // Still changeable: clearing back to Auto writes the removal.
      await userEvent.selectOptions(draftSelect, '');
      expect(setModelConfig).toHaveBeenCalledTimes(1);
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.taskModels).toEqual({});
    });

    it('CR-006: with every key deleted the section stays rendered — dangling designations visible and clearable', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={{
            keys: [],
            taskModels: { dialogue: { keyId: 'key_001', modelId: 'gpt-4o' } },
          }}
          setModelConfig={setModelConfig}
        />,
      );

      // Section survived the empty key list (no silent vanish).
      expect(screen.getByText('settings.taskModels')).toBeInTheDocument();
      const dialogueSelect = screen.getByLabelText('settings.taskSlotDialogue') as HTMLSelectElement;
      expect(dialogueSelect.value).toBe('key_001::gpt-4o');
      expect(screen.getByText('settings.taskModelStale: key_001 / gpt-4o')).toBeInTheDocument();

      await userEvent.selectOptions(dialogueSelect, '');
      expect(setModelConfig).toHaveBeenCalledTimes(1);
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.taskModels).toEqual({});
    });

    // ── CR-007: malformed non-empty change values are ignored ──

    it('CR-007: a non-empty value without the :: separator is ignored — never written, never treated as Auto', () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({
            taskModels: { dialogue: { keyId: 'key_001', modelId: 'gpt-4o' } },
          })}
          setModelConfig={setModelConfig}
        />,
      );

      // Real options never emit a separator-less value, and the DOM sanitizes a
      // synthetic one back to '' — so inject a bogus <option> to make the change
      // event actually carry the malformed value into the handler. It must be
      // dropped entirely: not parsed as a designation, not treated as an Auto
      // clear (which would delete the existing dialogue designation).
      const select = screen.getByLabelText('settings.taskSlotDialogue') as HTMLSelectElement;
      const bogus = document.createElement('option');
      bogus.value = 'garbage-no-separator';
      bogus.textContent = 'bogus';
      select.appendChild(bogus);
      fireEvent.change(select, { target: { value: 'garbage-no-separator' } });

      expect(setModelConfig).not.toHaveBeenCalled();
    });

    // ── 09-12 agy provider W4：CLI（antigravity-cli）模型进任务档指派面 ──

    it('CLI model options carry the no-tools form badge and stay assignable to a slot', async () => {
      const cliKey: ApiKeyEntry = {
        id: 'key_cli',
        name: 'Antigravity',
        protocol: 'antigravity-cli',
        cliExecutable: 'C:/agy/bin/agy.exe',
        models: [
          { id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true },
        ],
      };
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({ keys: [baseKey, cliKey] })}
          setModelConfig={setModelConfig}
        />,
      );

      const draftSelect = screen.getByLabelText('settings.taskSlotWriterDraft') as HTMLSelectElement;
      const cliOption = Array.from(draftSelect.options).find((o) => o.value === 'key_cli::gemini-3.8-pro-high');
      // 形态标识（H3 可见性的设置面防线）：指派时即知该形态无 Closure 工具面。
      expect(cliOption?.textContent).toBe('Antigravity - Gemini 3.8 Pro (High) · settings.cliNoToolsBadge');
      // HTTP 选项不带标识。
      const httpOption = Array.from(draftSelect.options).find((o) => o.value === 'key_001::gpt-4o');
      expect(httpOption?.textContent).toBe('GPT-4o - GPT-4o Omni');

      await userEvent.selectOptions(draftSelect, 'key_cli::gemini-3.8-pro-high');
      expect(setModelConfig).toHaveBeenCalledTimes(1);
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.taskModels).toEqual({
        'writer-draft': { keyId: 'key_cli', modelId: 'gemini-3.8-pro-high' },
      });
    });

    // ── U7（dogfood R4）：CLI 徽标按桥授权态两态渲染 ──
    // 桥已授权（同意态 ok）时 CLI 模型经 MCP 桥有写作工具面——「无工具调用」徽标与模型
    // 配置页桥小节「工具在模型自己的回合里执行」正对打架，改「工具经 MCP 桥」；未授权/
    // 缺席态维持原文。判定源 = agyBridgeStore 既有状态面（本处直接 seed，不接 IPC）。

    it('U7: bridge-authorized state swaps the CLI option badge to the via-bridge copy; unauthorized keeps the no-tools copy', () => {
      const cliKey: ApiKeyEntry = {
        id: 'key_cli',
        name: 'Antigravity',
        protocol: 'antigravity-cli',
        cliExecutable: 'C:/agy/bin/agy.exe',
        models: [
          { id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true },
        ],
      };
      const setModelConfig = vi.fn().mockResolvedValue(undefined);

      // 未授权（store 缺席 = 默认）：原文徽标。
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({ keys: [baseKey, cliKey] })}
          setModelConfig={setModelConfig}
        />,
      );
      const draftSelect = screen.getByLabelText('settings.taskSlotWriterDraft') as HTMLSelectElement;
      const cliOption = Array.from(draftSelect.options).find((o) => o.value === 'key_cli::gemini-3.8-pro-high');
      expect(cliOption?.textContent).toBe('Antigravity - Gemini 3.8 Pro (High) · settings.cliNoToolsBadge');
      cleanup();

      // 桥已授权（status.state = 'ok'）：徽标翻「工具经 MCP 桥」。
      useAgyBridgeStore.setState({
        status: {
          state: 'ok',
          conflicts: [],
          consent: 'allowed',
          homeRoot: 'C:/u/.orison/agy-bridge/home',
          consentFilePath: 'C:/u/.orison/agy-bridge/consent.json',
        },
      });
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({ keys: [baseKey, cliKey] })}
          setModelConfig={setModelConfig}
        />,
      );
      const draftSelect2 = screen.getByLabelText('settings.taskSlotWriterDraft') as HTMLSelectElement;
      const cliOption2 = Array.from(draftSelect2.options).find((o) => o.value === 'key_cli::gemini-3.8-pro-high');
      expect(cliOption2?.textContent).toBe('Antigravity - Gemini 3.8 Pro (High) · settings.cliBridgeToolsBadge');
      // HTTP 形态不受桥授权态影响（徽标只挂 CLI 模型）。
      const httpOption2 = Array.from(draftSelect2.options).find((o) => o.value === 'key_001::gpt-4o');
      expect(httpOption2?.textContent).toBe('GPT-4o - GPT-4o Omni');
    });
  });

  // ── thinking adapters task（S5，design §3.1）：档位思考策略选择器 ──
  // 模型能力轴经 renderer 直读 registry（resolveModelInfo + THINKING_PROFILES）：
  // 无档案模型控件隐藏；offLegal=false「关」灰置；gemini 仅 auto + 透传未确证说明；
  // 自定义值经 validateCustom 校验，非法不落盘不发送（PRD 验收 1/3）。
  describe('thinking policy controls (thinking adapters task)', () => {
    const mixedKey: ApiKeyEntry = {
      id: 'key_multi',
      name: 'Mixed',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      models: [
        { id: 'gpt-4o', alias: 'GPT-4o', capability: 'text', enabled: true },
        { id: 'glm-5.3', alias: 'GLM 5.3', capability: 'text', enabled: true },
        { id: 'glm-5.2', alias: 'GLM 5.2', capability: 'text', enabled: true },
        { id: 'glm-4.7', alias: 'GLM 4.7', capability: 'text', enabled: true },
        { id: 'deepseek-v4', alias: 'DeepSeek', capability: 'text', enabled: true },
        { id: 'gemini-3-pro', alias: 'Gemini 3 Pro', capability: 'text', enabled: true },
        { id: 'claude-opus-4-5', alias: 'Claude Opus 4.5', capability: 'text', enabled: true },
        { id: 'o3', alias: 'o3', capability: 'text', enabled: true },
      ],
    };
    // CR-006：claude 族也在 openai 兼容 key 上挂一份（中转场景）——同模型挂对/挂错
    // 协议的对照面；协议正确的指派走 key_anthropic。
    const anthropicKey: ApiKeyEntry = {
      id: 'key_anthropic',
      name: 'Anthropic relay',
      protocol: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test',
      models: [
        { id: 'claude-opus-4-5', alias: 'Claude Opus 4.5', capability: 'text', enabled: true },
      ],
    };

    function buildMixedConfig(taskModels: ModelConfig['taskModels']): ModelConfig {
      return { keys: [mixedKey, anthropicKey], taskModels };
    }

    function slotRow(labelKey: string): HTMLElement {
      const select = screen.getByLabelText(labelKey) as HTMLSelectElement;
      return select.closest('.model-task-slot') as HTMLElement;
    }

    function thinkingSelect(row: HTMLElement): HTMLSelectElement {
      return within(row).getByLabelText('settings.thinkingLevel') as HTMLSelectElement;
    }

    /**
     * 状态回环 harness：真 store 里 setModelConfig 会更新 modelConfig prop、组件
     * 受控重渲染。vi.fn() 死 mock 不回写，select 值回弹 auto——「重选同档 no-op /
     * 回 auto 清策略 / 自定义值回显」这类写后读交互必须走真实回环。
     */
    function renderStateful(initial: ModelConfig) {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      function Harness() {
        const [config, setConfig] = useState<ModelConfig>(initial);
        return (
          <AgentSettingsPage
            t={tFake}
            modelConfig={config}
            setModelConfig={(next) => {
              setModelConfig(next);
              setConfig(next);
              return Promise.resolve();
            }}
          />
        );
      }
      render(<Harness />);
      return { setModelConfig };
    }

    it('无思考档案的模型 / Auto 档：思考控件整行隐藏', () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      // 未指派（Auto 档）——全局无控件。
      render(<AgentSettingsPage t={tFake} modelConfig={buildMixedConfig(undefined)} setModelConfig={setModelConfig} />);
      expect(screen.queryByLabelText('settings.thinkingLevel')).toBeNull();

      // 指派了无档案模型（gpt-4o 无 registry thinking 条目）——该档行内无控件。
      cleanup();
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_multi', modelId: 'gpt-4o' } })}
          setModelConfig={setModelConfig}
        />,
      );
      expect(within(slotRow('settings.taskSlotDialogue')).queryByLabelText('settings.thinkingLevel')).toBeNull();
    });

    it('offLegal=false（glm-5.3 强制思考）：「关」灰置带原因，选项 = auto + levels + 自定义', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_multi', modelId: 'glm-5.3' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      const select = thinkingSelect(row);
      expect(select.value).toBe('auto');
      const optionValues = Array.from(select.options).map((o) => o.value);
      expect(optionValues).toEqual(['auto', 'off', 'low', 'medium', 'high', 'max', 'custom']);
      const offOption = Array.from(select.options).find((o) => o.value === 'off')!;
      expect(offOption.disabled).toBe(true);
      expect(offOption.title).toBe('settings.thinkingForcedReason');
      // 外显形态徽标（reasoning-field → 返回思考内容）+ 输出上限（默认顶满）。
      expect(row.textContent).toContain('settings.thinkingExternalReturns');
      expect(row.textContent).toContain('settings.thinkingOutputLimit');
    });

    it('offLegal=true（glm-5.2 动态可关）：「关」可选', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_multi', modelId: 'glm-5.2' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const select = thinkingSelect(slotRow('settings.taskSlotDialogue'));
      expect(Array.from(select.options).find((o) => o.value === 'off')!.disabled).toBe(false);
    });

    it('gemini：levels 为空 → 仅 auto + 透传未确证说明；无外显徽标（unknown）但有输出上限', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_multi', modelId: 'gemini-3-pro' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      const select = thinkingSelect(row);
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['auto']);
      expect(within(row).getByText('settings.thinkingPassthroughUnverified')).toBeInTheDocument();
      expect(row.textContent).not.toContain('settings.thinkingExternalReturns');
      expect(row.textContent).not.toContain('settings.thinkingExternalNone');
      expect(row.textContent).toContain('settings.thinkingOutputLimit');
    });

    it('外显形态 none（o 系）：标「不返回思考内容」', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_multi', modelId: 'o3' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      expect(row.textContent).toContain('settings.thinkingExternalNone');
      expect(row.textContent).not.toContain('settings.thinkingExternalReturns');
    });

    it('选统一档落 thinking 字段；回 auto 清策略位；重复选择不写', async () => {
      const { setModelConfig } = renderStateful(
        buildMixedConfig({ 'writer-draft': { keyId: 'key_multi', modelId: 'glm-5.2' } }),
      );
      const row = slotRow('settings.taskSlotWriterDraft');
      await userEvent.selectOptions(thinkingSelect(row), 'high');
      expect(setModelConfig).toHaveBeenCalledTimes(1);
      expect((setModelConfig.mock.calls[0][0] as ModelConfig).taskModels).toEqual({
        'writer-draft': { keyId: 'key_multi', modelId: 'glm-5.2', thinking: 'high' },
      });
      // 回环后 select 显示 high；重选同档 no-op（无 change 事件）。
      expect(thinkingSelect(row).value).toBe('high');
      await userEvent.selectOptions(thinkingSelect(row), 'high');
      expect(setModelConfig).toHaveBeenCalledTimes(1);

      // 回 auto：payload 只剩 ref（thinking/thinkingCustom 全清）。
      await userEvent.selectOptions(thinkingSelect(row), 'auto');
      expect(setModelConfig).toHaveBeenCalledTimes(2);
      expect((setModelConfig.mock.calls[1][0] as ModelConfig).taskModels).toEqual({
        'writer-draft': { keyId: 'key_multi', modelId: 'glm-5.2' },
      });
      expect(thinkingSelect(row).value).toBe('auto');
    });

    it('已存策略回显（含 custom 草稿值）；无效存量不标红', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({
            dialogue: { keyId: 'key_multi', modelId: 'deepseek-v4', thinkingCustom: 'xhigh' },
          })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      expect(thinkingSelect(row).value).toBe('custom');
      const input = within(row).getByLabelText('settings.thinkingCustomLabel') as HTMLInputElement;
      expect(input.value).toBe('xhigh');
      expect(within(row).queryByText('settings.thinkingCustomInvalid')).toBeNull();
      // enum 型 datalist 建议清单挂上（校验同源 customEnumValues）。
      const datalist = document.getElementById('thinking-custom-options-dialogue');
      expect(datalist).toBeTruthy();
      expect(datalist!.querySelectorAll('option').length).toBeGreaterThan(0);
    });

    it('enum 自定义：非法值不落盘（标红提示），合法厂商档名才保存', async () => {
      const { setModelConfig } = renderStateful(
        buildMixedConfig({ dialogue: { keyId: 'key_multi', modelId: 'deepseek-v4' } }),
      );
      const row = slotRow('settings.taskSlotDialogue');
      await userEvent.selectOptions(thinkingSelect(row), 'custom');
      const input = within(row).getByLabelText('settings.thinkingCustomLabel');
      expect(setModelConfig).not.toHaveBeenCalled();

      await userEvent.type(input, 'bogus');
      expect(setModelConfig).not.toHaveBeenCalled();
      expect(within(row).getByText('settings.thinkingCustomInvalid')).toBeInTheDocument();

      await userEvent.clear(input);
      await userEvent.type(input, 'xhigh');
      expect(setModelConfig).toHaveBeenCalledTimes(1);
      expect((setModelConfig.mock.calls[0][0] as ModelConfig).taskModels).toEqual({
        dialogue: { keyId: 'key_multi', modelId: 'deepseek-v4', thinkingCustom: 'xhigh' },
      });
      // 落盘后 select 仍停在 custom，输入回显已存值。
      expect(thinkingSelect(row).value).toBe('custom');
      expect((within(row).getByLabelText('settings.thinkingCustomLabel') as HTMLInputElement).value).toBe('xhigh');
    });

    it('numeric 自定义：区间外数值拒收，区间内落 thinkingCustom 数字串', async () => {
      const { setModelConfig } = renderStateful(
        buildMixedConfig({ extraction: { keyId: 'key_anthropic', modelId: 'claude-opus-4-5' } }),
      );
      const row = slotRow('settings.taskSlotExtraction');
      await userEvent.selectOptions(thinkingSelect(row), 'custom');
      const input = within(row).getByLabelText('settings.thinkingCustomLabel') as HTMLInputElement;
      expect(input.type).toBe('number');
      // 未非法时展示数值区间提示。
      expect(within(row).getByText('settings.thinkingCustomNumericHint')).toBeInTheDocument();

      await userEvent.type(input, '500'); // < 1024 → 拒收
      expect(setModelConfig).not.toHaveBeenCalled();
      expect(within(row).getByText('settings.thinkingCustomInvalid')).toBeInTheDocument();

      await userEvent.clear(input);
      await userEvent.type(input, '8192');
      expect(setModelConfig).toHaveBeenCalledTimes(1);
      expect((setModelConfig.mock.calls[0][0] as ModelConfig).taskModels).toEqual({
        extraction: { keyId: 'key_anthropic', modelId: 'claude-opus-4-5', thinkingCustom: '8192' },
      });
    });

    it('换模型重置思考策略为 auto（策略合法性按模型，不留旧模型非法组合）', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({
            dialogue: { keyId: 'key_multi', modelId: 'glm-5.2', thinking: 'high' },
          })}
          setModelConfig={setModelConfig}
        />,
      );
      await userEvent.selectOptions(screen.getByLabelText('settings.taskSlotDialogue'), 'key_multi::gpt-4o');
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.taskModels).toEqual({ dialogue: { keyId: 'key_multi', modelId: 'gpt-4o' } });
    });

    // ── CR-006（UI 半）：kind × protocol 组合过滤——挂错协议时档位整组不可注入 ──

    it('CR-006: claude kind 挂 openai-compatible key → 仅 auto + 协议路径说明', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_multi', modelId: 'claude-opus-4-5' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      const select = thinkingSelect(row);
      // 档位（含自定义）整组不渲染——非法组合不可选，只有 auto 可发。
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['auto']);
      expect(within(row).getByText('settings.thinkingProtocolUnsupported')).toBeInTheDocument();
      // 不可注入的是协议路径——外显形态等模型元信息照常展示（claude-budget 无
      // limits 数据，输出上限一行本就不出）。
      expect(row.textContent).toContain('settings.thinkingExternalReturns');
    });

    it('CR-006: glm kind 挂 anthropic-compatible key → 同款拦截', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_anthropic', modelId: 'glm-5.2' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      expect(Array.from(thinkingSelect(row).options).map((o) => o.value)).toEqual(['auto']);
      expect(within(row).getByText('settings.thinkingProtocolUnsupported')).toBeInTheDocument();
    });

    it('CR-006: 协议正确（claude on anthropic）与双路径（deepseek on anthropic）→ 全选项', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_anthropic', modelId: 'claude-opus-4-5' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const claudeSelect = thinkingSelect(slotRow('settings.taskSlotDialogue'));
      expect(Array.from(claudeSelect.options).map((o) => o.value)).toEqual([
        'auto', 'off', 'low', 'medium', 'high', 'max', 'custom',
      ]);
      expect(within(slotRow('settings.taskSlotDialogue')).queryByText('settings.thinkingProtocolUnsupported')).toBeNull();

      cleanup();
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_anthropic', modelId: 'deepseek-v4' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const deepseekSelect = thinkingSelect(slotRow('settings.taskSlotDialogue'));
      expect(Array.from(deepseekSelect.options).map((o) => o.value)).toEqual([
        'auto', 'off', 'low', 'medium', 'high', 'max', 'custom',
      ]);
    });

    it('CR-006: 档位为空的 gemini 不进协议拦截——仍走透传未确证说明（两路径原因不同）', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({ dialogue: { keyId: 'key_anthropic', modelId: 'gemini-3-pro' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      expect(Array.from(thinkingSelect(row).options).map((o) => o.value)).toEqual(['auto']);
      expect(within(row).getByText('settings.thinkingPassthroughUnverified')).toBeInTheDocument();
      expect(within(row).queryByText('settings.thinkingProtocolUnsupported')).toBeNull();
    });

    // ── CR-016（UI 半）：存量非法组合回显兜底（读侧丢键后的防御纵深） ──

    it('CR-016: 存量 off 挂强制思考模型 → select 回显 auto（不停在灰置项）+ 一次性提示', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({
            dialogue: { keyId: 'key_multi', modelId: 'glm-5.3', thinking: 'off' },
          })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      const select = thinkingSelect(row);
      expect(select.value).toBe('auto');
      expect(within(row).getByText('settings.thinkingStoredPolicyDropped')).toBeInTheDocument();
      // 「关」仍灰置（offLegal=false 的能力事实不变）。
      expect(Array.from(select.options).find((o) => o.value === 'off')!.disabled).toBe(true);
    });

    it('CR-016: customHint:none 模型的存量 custom → 回显 auto，不出「自定义」面', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildMixedConfig({
            dialogue: { keyId: 'key_multi', modelId: 'glm-4.7', thinkingCustom: '8192' },
          })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const row = slotRow('settings.taskSlotDialogue');
      const select = thinkingSelect(row);
      expect(select.value).toBe('auto');
      // 无 custom option、无自定义输入框、无「自定义…」标签——只有 auto 可见。
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        'auto', 'off', 'low', 'medium', 'high', 'max',
      ]);
      expect(within(row).queryByLabelText('settings.thinkingCustomLabel')).toBeNull();
      expect(within(row).getByText('settings.thinkingStoredPolicyDropped')).toBeInTheDocument();
    });
  });

  // dogfood 2026-08-21（#40/#41）：KB sidecar 指派选择器（向量/重排）。
  describe('sidecar designation pickers (embedding / rerank)', () => {
    it('renders both pickers; rerank defaults to Auto and persists a parsed ref on select', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(<AgentSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);

      const embed = screen.getByLabelText('settings.embeddingModel') as HTMLSelectElement;
      const rerank = screen.getByLabelText('settings.rerankModel') as HTMLSelectElement;
      expect(embed.value).toBe('');
      expect(rerank.value).toBe('');

      await userEvent.selectOptions(rerank, 'key_001::gpt-4o');
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.rerankModel).toEqual({ keyId: 'key_001', modelId: 'gpt-4o' });
      // 其余配置原样随行。
      expect(arg.keys).toHaveLength(1);
    });

    it('reflects an existing designation and clears it back to Auto', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({
            embeddingModel: { keyId: 'key_001', modelId: 'gpt-4o' },
            rerankModel: { keyId: 'key_001', modelId: 'gpt-4o' },
          })}
          setModelConfig={setModelConfig}
        />,
      );

      const embed = screen.getByLabelText('settings.embeddingModel') as HTMLSelectElement;
      const rerank = screen.getByLabelText('settings.rerankModel') as HTMLSelectElement;
      expect(embed.value).toBe('key_001::gpt-4o');
      expect(rerank.value).toBe('key_001::gpt-4o');

      await userEvent.selectOptions(rerank, '');
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.rerankModel).toBeUndefined();
      // 只动 rerank，embedding 指派不受牵连。
      expect(arg.embeddingModel).toEqual({ keyId: 'key_001', modelId: 'gpt-4o' });
    });

    // ── CR-006: dangling designation lifecycle（出生即带 + embedding 回填） ──

    it('CR-006: stale rerank designation renders an explicit stale option, not a fake Auto; still clearable', async () => {
      const setModelConfig = vi.fn().mockResolvedValue(undefined);
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({ rerankModel: { keyId: 'key_001', modelId: 'bge-reranker-x' } })}
          setModelConfig={setModelConfig}
        />,
      );

      const rerank = screen.getByLabelText('settings.rerankModel') as HTMLSelectElement;
      // 显示脏 ref 本身——不是伪装成「自动」的空值。
      expect(rerank.value).toBe('key_001::bge-reranker-x');
      expect(screen.getByText('settings.taskModelStale: key_001 / bge-reranker-x')).toBeInTheDocument();

      await userEvent.selectOptions(rerank, '');
      const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
      expect(arg.rerankModel).toBeUndefined();
    });

    it('CR-006: stale embedding designation renders an explicit stale option（回填同款缺陷）', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={buildConfig({ embeddingModel: { keyId: 'key_001', modelId: 'gpt-4o-mini' } })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );

      const embed = screen.getByLabelText('settings.embeddingModel') as HTMLSelectElement;
      expect(embed.value).toBe('key_001::gpt-4o-mini');
      expect(screen.getByText('settings.taskModelStale: key_001 / gpt-4o-mini')).toBeInTheDocument();
    });

    it('CR-006: picker survives an empty key list while a designation dangles', () => {
      render(
        <AgentSettingsPage
          t={tFake}
          modelConfig={{ keys: [], embeddingModel: { keyId: 'key_001', modelId: 'gpt-4o' } }}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );

      // 段不随 key 清空而消失——悬空指派可见、可清除。
      const embed = screen.getByLabelText('settings.embeddingModel') as HTMLSelectElement;
      expect(embed.value).toBe('key_001::gpt-4o');
      expect(screen.getByText('settings.taskModelStale: key_001 / gpt-4o')).toBeInTheDocument();
    });
  });

  it('dogfood #43：原「补丁模式」死开关已退役——页面不再渲染补丁模式 UI', () => {
    render(<AgentSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByText('settings.agentPatchMode')).toBeNull();
    expect(screen.queryByText('settings.patchModeSuggest')).toBeNull();
    expect(screen.queryByText('settings.patchModeAuto')).toBeNull();
  });
});

// ── C3.2 W2 多套预设：档位段顶预设条（chip + 切换 + 存为 + 删除）──
describe('AgentSettingsPage 任务档预设条（C3.2 W2）', () => {
  const PRESETS = [
    { name: 'cloud-quality', slotCount: 10, hasFallbacks: true },
    { name: 'all-localhost', slotCount: 3, hasFallbacks: false },
  ];

  function mockBridge(overrides: Partial<Record<string, unknown>> = {}) {
    (window as any).orisonDesktop = {
      listTaskPresets: vi.fn().mockResolvedValue(PRESETS),
      saveTaskPreset: vi.fn().mockResolvedValue({ ok: true }),
      applyTaskPreset: vi.fn().mockResolvedValue({ ok: true }),
      deleteTaskPreset: vi.fn().mockResolvedValue({ ok: true }),
      ...overrides,
    };
    return (window as any).orisonDesktop;
  }

  afterEach(() => {
    delete (window as any).orisonDesktop;
  });

  it('无 activePreset 时 chip 显示「自定义」；有则显示预设名', () => {
    mockBridge();
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig({ activePreset: undefined })}
        setModelConfig={vi.fn()}
        reloadConfig={reload}
      />,
    );
    expect(screen.getByText(/settings.presetCurrent/).textContent).toContain('settings.presetCustom');

    rerender(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig({ activePreset: 'cloud-quality' })}
        setModelConfig={vi.fn()}
        reloadConfig={reload}
      />,
    );
    expect(screen.getByText(/settings.presetCurrent/).textContent).toContain('cloud-quality');
  });

  it('挂载时拉取预设清单；切换预设调 applyTaskPreset 并经 reloadConfig 重读（不走 setModelConfig 回写）', async () => {
    const bridge = mockBridge();
    const reload = vi.fn().mockResolvedValue(undefined);
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig()}
        setModelConfig={setModelConfig}
        reloadConfig={reload}
      />,
    );

    await waitFor(() => expect(bridge.listTaskPresets).toHaveBeenCalled());
    const select = screen.getByLabelText('settings.presetApplyLabel') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'cloud-quality');

    await waitFor(() => expect(bridge.applyTaskPreset).toHaveBeenCalledWith({ name: 'cloud-quality' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(setModelConfig).not.toHaveBeenCalled();
  });

  it('apply 返回类型化错误时显示对应提示，不触发重读', async () => {
    const bridge = mockBridge({ applyTaskPreset: vi.fn().mockResolvedValue({ ok: false, error: 'not-found' }) });
    const reload = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig()}
        setModelConfig={vi.fn()}
        reloadConfig={reload}
      />,
    );

    await waitFor(() => expect(bridge.listTaskPresets).toHaveBeenCalled());
    await userEvent.selectOptions(screen.getByLabelText('settings.presetApplyLabel'), 'cloud-quality');

    await waitFor(() =>
      expect(screen.getByText('settings.presetNotFound')).toBeInTheDocument(),
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('存为预设：输入名称点保存 → saveTaskPreset 收到名称；类型化错误显提示', async () => {
    const bridge = mockBridge({ saveTaskPreset: vi.fn().mockResolvedValue({ ok: false, error: 'invalid-name' }) });
    render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig()}
        setModelConfig={vi.fn()}
        reloadConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(bridge.listTaskPresets).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText('settings.presetNamePlaceholder'), 'my-preset');
    await userEvent.click(screen.getByRole('button', { name: 'settings.presetSaveAction' }));

    await waitFor(() => expect(bridge.saveTaskPreset).toHaveBeenCalledWith({ name: 'my-preset' }));
    expect(screen.getByText('settings.presetInvalidName')).toBeInTheDocument();
  });

  it('同名覆盖走两段式确认：第一次点只亮确认文案，第二次才落 saveTaskPreset', async () => {
    const bridge = mockBridge();
    render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig()}
        setModelConfig={vi.fn()}
        reloadConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(bridge.listTaskPresets).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText('settings.presetNamePlaceholder'), 'cloud-quality');
    await userEvent.click(screen.getByRole('button', { name: 'settings.presetSaveAction' }));

    // 第一次点击：臂章态，未落盘。
    expect(bridge.saveTaskPreset).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'settings.presetOverwriteConfirm' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'settings.presetOverwriteConfirm' }));
    await waitFor(() => expect(bridge.saveTaskPreset).toHaveBeenCalledWith({ name: 'cloud-quality' }));
  });

  it('CR-4: 重名检查大小写不敏感（`foo` 撞既有 `Foo`）——NTFS 大小写不敏感，覆盖确认不可绕过', async () => {
    const bridge = mockBridge();
    render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig()}
        setModelConfig={vi.fn()}
        reloadConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(bridge.listTaskPresets).toHaveBeenCalled());
    // 既有预设 cloud-quality 全小写；输入仅大小写不同的变体（模拟撞 `Foo` 的形态——
    // 大小写差异本身在本 fixture 的既有清单里不存在合法命中等价项）。
    await userEvent.type(screen.getByPlaceholderText('settings.presetNamePlaceholder'), 'CLOUD-QUALITY');
    await userEvent.click(screen.getByRole('button', { name: 'settings.presetSaveAction' }));

    // 第一段：只亮确认臂章，未落盘（大小写不敏感比较命中既有 cloud-quality）。
    expect(bridge.saveTaskPreset).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'settings.presetOverwriteConfirm' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'settings.presetOverwriteConfirm' }));
    await waitFor(() => expect(bridge.saveTaskPreset).toHaveBeenCalledWith({ name: 'CLOUD-QUALITY' }));
  });

  it('CR-15: 未传 reloadConfig 时经 store 兜底刷新（bridge.loadModelConfig 被调）——apply 后 UI 不静默陈旧', async () => {
    const bridge = mockBridge({
      loadModelConfig: vi.fn().mockResolvedValue(buildConfig({ activePreset: 'cloud-quality' })),
    });
    // 注意：不传 reloadConfig prop——走组件内 useAppStore.getState().loadModelConfig 兜底。
    render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig()}
        setModelConfig={vi.fn()}
      />,
    );

    await waitFor(() => expect(bridge.listTaskPresets).toHaveBeenCalled());
    await userEvent.selectOptions(screen.getByLabelText('settings.presetApplyLabel'), 'cloud-quality');

    await waitFor(() => expect(bridge.applyTaskPreset).toHaveBeenCalledWith({ name: 'cloud-quality' }));
    await waitFor(() => expect(bridge.loadModelConfig).toHaveBeenCalled());
  });

  it('删除预设走确认对话；删的是活动档时触发重读（chip 回「自定义」）', async () => {
    const bridge = mockBridge();
    const reload = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsPage
        t={tFake}
        modelConfig={buildConfig({ activePreset: 'cloud-quality' })}
        setModelConfig={vi.fn()}
        reloadConfig={reload}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'settings.presetDeleteLabel: cloud-quality' })),
    );
    await userEvent.click(screen.getByRole('button', { name: 'settings.presetDeleteLabel: cloud-quality' }));

    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByText('settings.presetDeleteConfirmTitle'),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.presetDeleteConfirmAction' }));

    await waitFor(() => expect(bridge.deleteTaskPreset).toHaveBeenCalledWith({ name: 'cloud-quality' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
