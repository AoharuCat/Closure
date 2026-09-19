import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyEntry, ModelConfig } from '@orison/shared-contracts';
import { ModelSettingsPage } from '../src/features/model-settings/ModelSettingsPage';
import { useAppStore } from '../src/shared/store/appStore';
import { __resetAgyBridgeStoreForTest, useAgyBridgeStore } from '../src/shared/store/agyBridgeStore';
import type { AgyBridgeStatusView } from '@orison/shared-contracts';

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

// dogfood #43（2026-08-21）：任务模型/向量/重排三段已迁往 Agent 页
// （test/agentSettingsPage.test.tsx）——本页回归纯「供应商管理」。

describe('ModelSettingsPage', () => {
  beforeEach(() => {
    useAppStore.setState({ outputEntries: [], appendOutputEntry: vi.fn() } as any);
    (window as any).orisonDesktop = {
      listRemoteModels: vi.fn().mockResolvedValue([
        { id: 'gpt-4o', capability: 'text', alias: 'GPT-4o Omni' },
        { id: 'gpt-image-1', capability: 'image', alias: 'GPT Image 1' },
      ]),
      // 09-12 agy provider W4：CLI 发现端点默认桩（CLI 测试各自覆写）。
      listCliModels: vi.fn().mockResolvedValue({
        ok: true,
        resolvedExecutable: 'C:/agy/bin/agy.exe',
        models: [],
      }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders empty state when no keys exist', () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />
    );
    expect(screen.getByText('settings.emptyTitle')).toBeTruthy();
    expect(screen.getByText('settings.emptyHint')).toBeTruthy();
  });

  it('opens the profile editor from the empty state add action', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));

    expect(screen.getByLabelText('settings.profileName')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.modelProtocol')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.baseUrl')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
  });

  it('shows the no-selection state when keys exist but none is being edited', () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);

    expect(screen.getByText('settings.selectProfileHint')).toBeInTheDocument();
  });

  it('shows enabled-model summary and count on key rows', () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    const row = screen.getByRole('button', { pressed: false, name: /GPT-4o/ });
    expect(row.textContent).toContain('GPT-4o Omni');
    expect(row.textContent).toContain('1');
  });

  it('selecting a key and applying a name change persists via setModelConfig', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    const row = screen.getByRole('button', { pressed: false, name: /GPT-4o/ });
    await userEvent.click(row);

    const nameInput = screen.getByLabelText('settings.profileName');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed');

    const applyButton = screen.getByRole('button', { name: 'settings.applyChanges' });
    expect(applyButton.hasAttribute('disabled')).toBe(false);
    await userEvent.click(applyButton);

    await waitFor(() => expect(setModelConfig).toHaveBeenCalled());
    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    expect(arg.keys[0].name).toBe('Renamed');
  });

  it('opens delete confirm dialog and persists deletion on confirm', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));

    await userEvent.click(screen.getByRole('button', { name: 'settings.deleteModel' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('settings.deleteConfirmTitle')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.deleteConfirmAction' }));

    await waitFor(() => expect(setModelConfig).toHaveBeenCalled());
    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    expect(arg.keys).toHaveLength(0);
  });

  it('refreshing models merges discovered entries into the draft', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));

    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      expect((window as any).orisonDesktop.listRemoteModels).toHaveBeenCalled();
      // The newly discovered image model is added to the editor's model list.
      expect(screen.getByText('gpt-image-1')).toBeInTheDocument();
    });
  });

  it('refreshing a new anthropic-compatible key forwards the selected protocol', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'anthropic-compatible');
    await userEvent.type(screen.getByLabelText('settings.baseUrl'), 'https://api.anthropic.com');
    await userEvent.type(screen.getByLabelText('settings.apiKey'), 'sk-ant-test');

    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      expect((window as any).orisonDesktop.listRemoteModels).toHaveBeenCalledWith({
        protocol: 'anthropic-compatible',
        apiKey: 'sk-ant-test',
        baseUrl: 'https://api.anthropic.com',
      });
    });
  });

  it('refresh failure surfaces banner with error message', async () => {
    (window as any).orisonDesktop.listRemoteModels = vi
      .fn()
      .mockRejectedValue(new Error('Network down'));
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));

    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain('Network down');
    });
  });

  it('cancelling delete dialog leaves config unchanged', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));
    await userEvent.click(screen.getByRole('button', { name: 'settings.deleteModel' }));

    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'projects.cancel' }));

    expect(setModelConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // dogfood #43：迁走后的模型配置页不再渲染任务模型/向量/重排三段（在 Agent 页）。
  it('dogfood #43：模型分工三段已迁走——本页不再渲染任务模型/向量/重排选择器', () => {
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByLabelText('settings.embeddingModel')).toBeNull();
    expect(screen.queryByLabelText('settings.rerankModel')).toBeNull();
    expect(screen.queryByLabelText('settings.taskSlotDialogue')).toBeNull();
    expect(screen.queryByText('settings.taskModels')).toBeNull();
  });

  // dogfood #41：重新拉取刷新既有条目的派生字段（alias/capability），保留 enabled。
  it('refreshing models heals stale derived fields of existing entries (alias/capability), keeps enabled', async () => {
    (window as any).orisonDesktop.listRemoteModels = vi.fn().mockResolvedValue([
      { id: 'gpt-4o', capability: 'embedding', alias: 'GPT-4o Omni v2' },
      { id: 'gpt-image-1', capability: 'image', alias: 'GPT Image 1' },
    ]);
    const staleConfig = buildConfig({
      keys: [
        {
          ...baseKey,
          // 旧 registry 时代的脏数据形态：截断 alias + 错标 capability（盘上实录）。
          models: [{ id: 'gpt-4o', alias: 'Embedding gpt-4', capability: 'text', enabled: true }],
        },
      ],
    });
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={staleConfig} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    // 既有条目的 alias 换新（截断形态消失），capability 修正为 embedding。
    // 断言圈定编辑器列表（.model-entry-list 是本页刷新后的草稿面）。
    await waitFor(() => expect(screen.getByText('GPT-4o Omni v2')).toBeInTheDocument());
    const entryList = document.querySelector('.model-entry-list') as HTMLElement;
    expect(entryList).toBeTruthy();
    expect(within(entryList).queryByText('Embedding gpt-4')).toBeNull();
    expect(within(entryList).getByText('embedding')).toBeInTheDocument();
    // enabled 保留：gpt-4o 行的勾选态不被重置（新发现的 gpt-image-1 默认不勾）。
    const row = screen.getByText('GPT-4o Omni v2').closest('.model-entry-row') as HTMLElement | null;
    expect(row).toBeTruthy();
    expect((row!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    const newRow = screen.getByText('gpt-image-1').closest('.model-entry-row') as HTMLElement | null;
    expect((newRow!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });

  // ── 09-12 agy provider W4：CLI 形态（Antigravity CLI）设置面 ──

  it('switching to the CLI protocol swaps the form: path field in, baseUrl/apiKey out, risk note visible', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'antigravity-cli');

    expect(screen.getByLabelText('settings.cliExecutable')).toBeInTheDocument();
    expect(screen.queryByLabelText('settings.baseUrl')).toBeNull();
    expect(screen.queryByLabelText('settings.apiKey')).toBeNull();
    // ToS 灰区风险备注行（用户拍板；子5 统一常量时替换）。
    expect(screen.getByText('settings.cliTosRiskNote')).toBeInTheDocument();
  });

  it('fetching CLI models hits the discovery endpoint, backfills the resolved executable, and applies a CLI-shaped key', async () => {
    (window as any).orisonDesktop.listCliModels = vi.fn().mockResolvedValue({
      ok: true,
      resolvedExecutable: 'C:/Users/u/AppData/Local/agy/bin/agy.exe',
      models: [
        { id: 'gemini-3.8-pro-high', capability: 'text', alias: 'Gemini 3.8 Pro (High)' },
        { id: 'claude-sonnet-4-6', capability: 'text', alias: 'Claude Sonnet 4.6' },
      ],
    });
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'antigravity-cli');
    // 留空路径 = 自动探测：请求带空 cliExecutable，成功后回填 resolvedExecutable。
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    expect(window.orisonDesktop.listCliModels).toHaveBeenCalledWith({ cliExecutable: '' });
    await waitFor(() => {
      expect(screen.getByText('gemini-3.8-pro-high')).toBeInTheDocument();
    });
    expect((screen.getByLabelText('settings.cliExecutable') as HTMLInputElement).value).toBe(
      'C:/Users/u/AppData/Local/agy/bin/agy.exe',
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.applyChanges' }));
    await waitFor(() => expect(setModelConfig).toHaveBeenCalled());
    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    const key = arg.keys[0]!;
    expect(key.protocol).toBe('antigravity-cli');
    expect(key.cliExecutable).toBe('C:/Users/u/AppData/Local/agy/bin/agy.exe');
    // 形态互斥载荷：CLI 键不带 baseUrl；apiKey 走 save-face '' 哨兵。
    expect(key.baseUrl).toBeUndefined();
    expect(key.apiKey).toBe('');
    expect(key.models.map((m) => m.id)).toEqual(['gemini-3.8-pro-high', 'claude-sonnet-4-6']);
  });

  it('editing an existing CLI key loads the form in CLI mode with its executable', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    const cliKey: ApiKeyEntry = {
      id: 'key_001',
      name: 'Antigravity',
      protocol: 'antigravity-cli',
      cliExecutable: 'C:/agy/bin/agy.exe',
      models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true }],
    };
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [cliKey] }} setModelConfig={setModelConfig} />,
    );

    await userEvent.click(screen.getByRole('button', { pressed: false, name: /Antigravity/ }));
    expect((screen.getByLabelText('settings.cliExecutable') as HTMLInputElement).value).toBe('C:/agy/bin/agy.exe');
    expect(screen.queryByLabelText('settings.baseUrl')).toBeNull();
    expect(screen.getByText('settings.cliTosRiskNote')).toBeInTheDocument();
  });

  it('not-logged-in discovery shows the inline login hint without an error banner', async () => {
    (window as any).orisonDesktop.listCliModels = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'not-logged-in' });
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'antigravity-cli');
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      expect(screen.getByText('settings.cliLoginHint')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('executable-not-found discovery surfaces a readable error banner', async () => {
    (window as any).orisonDesktop.listCliModels = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'executable-not-found', detail: 'tried: D:/x/agy.exe' });
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'antigravity-cli');
    await userEvent.type(screen.getByLabelText('settings.cliExecutable'), 'D:/x/agy.exe');
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain('settings.cliExecutableNotFound');
    });
  });

  it('applying a CLI key with a cleared executable path is blocked with a notice', async () => {
    (window as any).orisonDesktop.listCliModels = vi.fn().mockResolvedValue({
      ok: true,
      resolvedExecutable: 'C:/agy/bin/agy.exe',
      models: [{ id: 'gemini-3.8-pro-high', capability: 'text', alias: 'Gemini 3.8 Pro (High)' }],
    });
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'antigravity-cli');
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));
    await waitFor(() => {
      expect(screen.getByText('gemini-3.8-pro-high')).toBeInTheDocument();
    });

    // 清空已回填的路径再应用——schema min(1) 的 UI 前置守卫。
    await userEvent.clear(screen.getByLabelText('settings.cliExecutable'));
    await userEvent.click(screen.getByRole('button', { name: 'settings.applyChanges' }));

    expect(await screen.findByText('settings.cliExecutableMissing')).toBeInTheDocument();
    expect(setModelConfig).not.toHaveBeenCalled();
  });

  // ── CR-10（09-12 agy provider CR 批）：发现回填不覆盖用户并发输入 ──
  it('CLI discovery in flight: concurrent model-list edits survive the backfill merge (CR-10)', async () => {
    let resolveDiscovery!: (value: unknown) => void;
    (window as any).orisonDesktop.listCliModels = vi.fn(
      () => new Promise((res) => { resolveDiscovery = res; }),
    );
    const cliKey: ApiKeyEntry = {
      id: 'key_001',
      name: 'Antigravity',
      protocol: 'antigravity-cli',
      cliExecutable: 'C:/agy/bin/agy.exe',
      models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true }],
    };
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [cliKey] }} setModelConfig={setModelConfig} />,
    );
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /Antigravity/ }));

    // 发现请求发出后保持挂起——期间用户取消勾选既有模型（并发输入）。
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));
    const checkbox = document.querySelector(
      '.model-entry-row input[type="checkbox"]',
    ) as HTMLInputElement;
    await userEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    // 发现结算：同一模型被「重新发现」——合并基线必须是 updater 的 prev（用户取消勾选
    // 存活），旧实现按渲染闭包旧 models 合并会把勾选静默回滚。
    await act(async () => {
      resolveDiscovery({
        ok: true,
        resolvedExecutable: 'C:/agy/bin/agy.exe',
        models: [{ id: 'gemini-3.8-pro-high', capability: 'text', alias: 'Gemini 3.8 Pro (High)' }],
      });
    });
    await waitFor(() => {
      const row = screen.getByText('gemini-3.8-pro-high').closest('.model-entry-row') as HTMLElement;
      expect((row.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    });
    expect((screen.getByLabelText('settings.cliExecutable') as HTMLInputElement).value).toBe(
      'C:/agy/bin/agy.exe',
    );
  });

  // ── CR-25（09-12 agy provider CR 批）：IPC 原始错误不透进本地化横幅 ──
  it('discovery-failed detail stays out of the banner; raw detail lands in the output log (CR-25)', async () => {
    (window as any).orisonDesktop.listCliModels = vi.fn().mockResolvedValue({
      ok: false,
      error: 'discovery-failed',
      detail: 'boom: something broke',
    });
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'antigravity-cli');
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain('settings.cliDiscoveryFailed');
      expect(banner.textContent).not.toContain('boom');
    });
    // 诊断面：原始 detail 进输出日志（key 维度兜底——横幅本地化、日志保真）。
    expect(useAppStore.getState().appendOutputEntry).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'boom: something broke' }),
    );
  });

  it('models-refreshed notice uses native {count} interpolation (CR-25)', async () => {
    (window as any).orisonDesktop.listCliModels = vi.fn().mockResolvedValue({
      ok: true,
      resolvedExecutable: 'C:/agy/bin/agy.exe',
      models: [
        { id: 'gemini-3.8-pro-high', capability: 'text', alias: 'Gemini 3.8 Pro (High)' },
        { id: 'claude-sonnet-4-6', capability: 'text', alias: 'Claude Sonnet 4.6' },
      ],
    });
    const tVars = (key: string, vars?: Record<string, string | number>) =>
      (vars ? `${key}|${JSON.stringify(vars)}` : key);
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tVars} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'antigravity-cli');
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    // t() 第二参（{count}）确实传给了翻译层——不再是手拼 replace。
    expect(await screen.findByText('settings.modelsRefreshed|{"count":2}')).toBeInTheDocument();
  });

  // ── CR-19（子3 CR 批）：桥小节渲染 gate 含 consent 态（防孤儿 consent 的入口收回） ──
  describe('CR-19: AgyBridgeSection render gate', () => {
    const bridgeStatusView = (state: AgyBridgeStatusView['state']): AgyBridgeStatusView => ({
      state,
      conflicts: [],
      consent: state === 'missing-consent' ? undefined : state === 'declined' ? 'declined' : 'allowed',
      homeRoot: 'C:/home/.orison/agy-bridge/home',
      consentFilePath: 'C:/home/.orison/agy-bridge/consent.json',
    });

    beforeEach(() => {
      __resetAgyBridgeStoreForTest();
      (window as any).orisonDesktop.agyBridgeStatus = vi.fn().mockResolvedValue(bridgeStatusView('ok'));
    });

    afterEach(() => {
      __resetAgyBridgeStoreForTest();
    });

    it('无 CLI key 但 consent 已记录（ok）→ 小节仍渲染（孤儿 consent 可查可关）', () => {
      useAgyBridgeStore.setState({ status: bridgeStatusView('ok') });
      render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={vi.fn().mockResolvedValue(undefined)} />);
      expect(screen.getByText('settings.modelConfig')).toBeTruthy();
      expect(document.querySelector('.agy-bridge-section')).toBeTruthy();
    });

    it('无 CLI key 且状态快照缺失（null）→ 小节不渲染（未知态退回 key presence 判定）', () => {
      render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={vi.fn().mockResolvedValue(undefined)} />);
      expect(document.querySelector('.agy-bridge-section')).toBeNull();
    });

    it('无 CLI key 且 missing-consent（无同意记录）→ 小节不渲染', () => {
      useAgyBridgeStore.setState({ status: bridgeStatusView('missing-consent') });
      render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={vi.fn().mockResolvedValue(undefined)} />);
      expect(document.querySelector('.agy-bridge-section')).toBeNull();
    });
  });

  // ── 「反重力状态探测」卡片接线：桥卡片之后并列，仅存在 CLI key 时渲染 ──
  describe('AgyProbeSection wiring', () => {
    const cliKey: ApiKeyEntry = {
      id: 'key_agy',
      name: 'Antigravity',
      protocol: 'antigravity-cli',
      cliExecutable: 'C:/agy/bin/agy.exe',
      models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro', capability: 'text', enabled: true }],
    };

    it('有 CLI key → 探测卡片渲染，且位于桥卡片之后', async () => {
      (window as any).orisonDesktop.cliProbeStatus = vi.fn().mockResolvedValue({});
      render(
        <ModelSettingsPage
          t={tFake}
          modelConfig={buildConfig({ keys: [cliKey] })}
          setModelConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      const bridge = await waitFor(() => {
        const el = document.querySelector('.agy-bridge-section');
        expect(el).not.toBeNull();
        return el as Element;
      });
      const probe = document.querySelector('.agy-probe-section') as Element | null;
      expect(probe).not.toBeNull();
      // probe 在 bridge 之后（bridge.compareDocumentPosition(probe) 含 FOLLOWING 位）。
      expect(bridge.compareDocumentPosition(probe!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // 页面级守卫全文只此一处探测卡片。
      expect(document.querySelectorAll('.agy-probe-section')).toHaveLength(1);
    });

    it('仅 HTTP key → 探测卡片不渲染', () => {
      render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={vi.fn().mockResolvedValue(undefined)} />);
      expect(document.querySelector('.agy-probe-section')).toBeNull();
    });
  });
});
