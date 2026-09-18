import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyEntry, ModelConfig } from '@orison/shared-contracts';
import { ModelSettingsPage } from '../src/features/model-settings/ModelSettingsPage';
import { useAppStore } from '../src/shared/store/appStore';

// ── 09-12 子3 W4：设置页参数面渲染（常用直出 + 高级折叠 / CLI 形态隐藏）+ applyDraft
// 前置校验与 schema 拒收的 notice 通道（design §5.2/§6）。──

const baseKey: ApiKeyEntry = {
  id: 'key_001',
  name: 'GPT-4o',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-test',
  customHeaders: { 'X-Route-Tag': 'closure' },
  models: [
    {
      id: 'gpt-4o',
      alias: 'GPT-4o Omni',
      capability: 'text',
      enabled: true,
      defaults: { temperature: 0.7 },
    },
  ],
};

const cliKey: ApiKeyEntry = {
  id: 'key_agy',
  name: 'Antigravity',
  protocol: 'antigravity-cli',
  cliExecutable: 'C:/agy/bin/agy.exe',
  models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro', capability: 'text', enabled: true }],
};

function buildConfig(keys: ApiKeyEntry[]): ModelConfig {
  return { keys };
}

const tFake = (key: string) => key;

async function selectKey(name: RegExp) {
  const row = screen.getByRole('button', { pressed: false, name });
  await userEvent.click(row);
}

describe('model-settings params face (09-12 子3 W4)', () => {
  beforeEach(() => {
    useAppStore.setState({ outputEntries: [], appendOutputEntry: vi.fn() } as any);
    (window as any).orisonDesktop = {
      listRemoteModels: vi.fn().mockResolvedValue([]),
      listCliModels: vi.fn().mockResolvedValue({ ok: true, resolvedExecutable: 'C:/agy/bin/agy.exe', models: [] }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('自定义请求头段：既有 header 成行渲染，添加/删除行直接驱动草稿', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={buildConfig([baseKey])} setModelConfig={setModelConfig} />,
    );
    await selectKey(/GPT-4o/);

    expect(screen.getByText('settings.customHeadersSection')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.customHeaderName')).toHaveValue('X-Route-Tag');
    expect(screen.getByLabelText('settings.customHeaderValue')).toHaveValue('closure');

    await userEvent.click(screen.getByRole('button', { name: 'settings.customHeaderAdd' }));
    expect(screen.getAllByLabelText('settings.customHeaderName')).toHaveLength(2); // 新增空行

    await userEvent.click(screen.getAllByRole('button', { name: 'settings.customHeaderRemove' })[1]!);
    expect(screen.getAllByLabelText('settings.customHeaderName')).toHaveLength(1);
  });

  it('key 级「高级设置」折叠：默认收起，展开后超时/流式禁用/证书三控件 + 提示文案', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={buildConfig([baseKey])} setModelConfig={setModelConfig} />,
    );
    await selectKey(/GPT-4o/);

    const fold = screen.getByRole('button', { name: 'settings.advancedSettings' });
    expect(screen.queryByLabelText('settings.keyTimeoutSeconds')).toBeNull(); // 默认收起
    await userEvent.click(fold);

    expect(screen.getByLabelText('settings.keyTimeoutSeconds')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.keyTimeoutSeconds')).toHaveValue('');
    expect(screen.queryByText('settings.keyStreamingDisabledHint')).toBeNull(); // 未勾选无提示
    await userEvent.click(screen.getByLabelText('settings.keyStreamingDisabled'));
    expect(screen.getByText('settings.keyStreamingDisabledHint')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('settings.keyVerifySsl'));
    expect(screen.getByText('settings.keyVerifySslHint')).toBeInTheDocument();
  });

  it('模型行展开 → 默认参数面板：常用直出 temperature+pricing 三价，高级折叠后 topP/双 penalty/窗口/上限/extraBody', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={buildConfig([baseKey])} setModelConfig={setModelConfig} />,
    );
    await selectKey(/GPT-4o/);

    await userEvent.click(screen.getByRole('button', { name: 'settings.modelDefaultsToggle' }));
    // 常用区直出（temperature 持久化默认 0.7 的 string 中间态）。
    expect(screen.getByLabelText('settings.modelTemperature')).toHaveValue('0.7');
    expect(screen.getByLabelText('settings.pricingInput')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.pricingOutput')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.pricingCachedInput')).toBeInTheDocument();
    // 高级区默认收起。
    expect(screen.queryByLabelText('settings.modelTopP')).toBeNull();

    // 面板内的高级折叠（与 key 级高级折叠同名——以面板 aria-label 收窄查询域）。
    const panel = screen.getByLabelText('settings.modelDefaultsSection');
    await userEvent.click(within(panel).getByRole('button', { name: 'settings.advancedSettings' }));
    expect(screen.getByLabelText('settings.modelTopP')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.modelFrequencyPenalty')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.modelPresencePenalty')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.modelContextWindow')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.modelMaxOutputTokens')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('{ "safe_prompt": true }')).toBeInTheDocument();
  });

  it('CLI 形态：传输面段与采样字段隐藏，默认参数面板仅 contextWindow', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={buildConfig([cliKey])} setModelConfig={setModelConfig} />,
    );
    await selectKey(/Antigravity/);

    // 传输面（headers 段 + key 级高级折叠）不渲染。
    expect(screen.queryByText('settings.customHeadersSection')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.advancedSettings' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'settings.modelDefaultsToggle' }));
    expect(screen.getByLabelText('settings.modelContextWindow')).toBeInTheDocument();
    expect(screen.queryByLabelText('settings.modelTemperature')).toBeNull();
    expect(screen.queryByLabelText('settings.modelTopP')).toBeNull();
    expect(screen.queryByLabelText('settings.modelMaxOutputTokens')).toBeNull();
    expect(screen.queryByPlaceholderText('{ "safe_prompt": true }')).toBeNull();
  });

  it('applyDraft 前置校验：坏 JSON extraBody → notice 且不触达 setModelConfig', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={buildConfig([baseKey])} setModelConfig={setModelConfig} />,
    );
    await selectKey(/GPT-4o/);
    await userEvent.click(screen.getByRole('button', { name: 'settings.modelDefaultsToggle' }));
    const panel = screen.getByLabelText('settings.modelDefaultsSection');
    await userEvent.click(within(panel).getByRole('button', { name: 'settings.advancedSettings' }));

    const textarea = within(panel).getByPlaceholderText('{ "safe_prompt": true }');
    fireEvent.change(textarea, { target: { value: '{"broken":' } });

    await userEvent.click(screen.getByRole('button', { name: 'settings.applyChanges' }));
    await waitFor(() => expect(screen.getByText('settings.extraBodyInvalid')).toBeInTheDocument());
    expect(setModelConfig).not.toHaveBeenCalled();
  });

  it('applyDraft schema 拒收 → notice（实修：此前 setModelConfig rejection 无人处理）', async () => {
    const setModelConfig = vi.fn().mockRejectedValue(new Error('Schema validation failed'));
    render(
      <ModelSettingsPage t={tFake} modelConfig={buildConfig([baseKey])} setModelConfig={setModelConfig} />,
    );
    await selectKey(/GPT-4o/);

    const nameInput = screen.getByLabelText('settings.profileName');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed');

    await userEvent.click(screen.getByRole('button', { name: 'settings.applyChanges' }));
    await waitFor(() => expect(setModelConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('settings.modelSaveRejected')).toBeInTheDocument());
    // 诊断 detail 落输出日志（appendOutputEntry mock 在 appStore setState 里）。
    await waitFor(() =>
      expect((useAppStore.getState() as any).appendOutputEntry).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'model', level: 'error' }),
      ),
    );
  });
});
