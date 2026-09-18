import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';

const { handle, safeStorage } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  // 08-25 背景：registerConfigIpc 注册期 allowPath(userData/wallpaper) → mock getPath。
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

// CR-25 测试缝：configIpc 的盘上键层尚未持久化 customHeaders/verifySsl（子3 在途，
// 该文件归批B）——本文件只测 resolveListModelsRequest 的**合并契约**（凡
// readModelConfigFromDisk 返回的键带 customHeaders/verifySsl，keyId 路径必须并车），
// 故 partial-mock 该导出为可注入；真实现挂 hoisted holder（vi.mock 工厂提升早于
// 顶层 let 初始化——直接模块级 let 会 TDZ），缺省透传（既有 keyId 存取测试走真盘）。
const configIpcMocks = vi.hoisted(() => ({
  readModelConfigFromDisk: vi.fn(),
  realReadModelConfigFromDisk: undefined as undefined | (() => import('@orison/shared-contracts').ModelConfig),
}));
vi.mock('../main/ipc/configIpc', async (importOriginal) => {
  const original = await importOriginal<typeof import('../main/ipc/configIpc')>();
  configIpcMocks.realReadModelConfigFromDisk = original.readModelConfigFromDisk;
  return { ...original, readModelConfigFromDisk: configIpcMocks.readModelConfigFromDisk };
});

import { _setModelConfigDirForTest, registerConfigIpc } from '../main/ipc/configIpc';
import { registerModelProviderIpc } from '../main/ipc/modelProviderIpc';

const ORIGINAL_FETCH = globalThis.fetch;
const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-provider');

const SAMPLE_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_001',
      name: 'Main relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-from-disk',
      baseUrl: 'https://relay.example.com',
      models: [
        { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
      ],
    },
  ],
};

function mockJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('model provider IPC', () => {
  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    // 缺省透传真实现（partial-mock 只在 CR-25 注入用例里改写返回值）。
    configIpcMocks.readModelConfigFromDisk.mockReset();
    configIpcMocks.readModelConfigFromDisk.mockImplementation(() => {
      const real = configIpcMocks.realReadModelConfigFromDisk;
      if (!real) throw new Error('real readModelConfigFromDisk not captured by mock factory');
      return real();
    });
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('fetches model list from /v1/models with Bearer auth', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-image-1' }],
    }));

    registerModelProviderIpc();

    expect(handle).toHaveBeenCalledWith('model:list-remote-models', expect.any(Function));

    const [, handler] = handle.mock.calls[0]!;
    await expect(handler({}, {
      protocol: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example.com',
    })).resolves.toEqual([
      { id: 'gpt-4o-mini', capability: 'text', alias: 'GPT-4o mini' },
      { id: 'gpt-image-1', capability: 'image', alias: 'GPT Image 1' },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sk-test' }),
      }),
    );
  });

  it('fetches Anthropic-compatible model list using protocol-specific auth', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      data: [{ id: 'claude-3-5-sonnet-latest' }],
    }));

    registerModelProviderIpc();

    const [, handler] = handle.mock.calls[0]!;
    await expect(handler({}, {
      protocol: 'anthropic-compatible',
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com',
    })).resolves.toEqual([
      { id: 'claude-3-5-sonnet-latest', capability: 'text', alias: 'Claude 3-5-sonnet-latest' },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'sk-ant' }),
      }),
    );
  });

  it('lists cross-vendor ids through a relay with correct capability inference', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      data: [
        { id: 'claude-3-5-sonnet-latest' },
        { id: 'gemini-2.5-pro' },
        { id: 'gpt-4o' },
      ],
    }));

    registerModelProviderIpc();
    const [, handler] = handle.mock.calls[0]!;

    await expect(handler({}, {
      apiKey: 'sk-relay',
      baseUrl: 'https://newapi.example.com',
    })).resolves.toEqual([
      { id: 'claude-3-5-sonnet-latest', capability: 'text', alias: 'Claude 3-5-sonnet-latest' },
      { id: 'gemini-2.5-pro', capability: 'text', alias: 'Gemini 2.5-pro' },
      { id: 'gpt-4o', capability: 'text', alias: 'GPT-4o' },
    ]);
  });

  it('can list remote models using only keyId so apiKey stays in the main process', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1]({}, SAMPLE_CONFIG);
    handle.mockClear();

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      data: [{ id: 'gpt-4o-mini' }],
    }));

    registerModelProviderIpc();
    const [, handler] = handle.mock.calls[0]!;

    await expect(handler({}, {
      keyId: 'key_001',
    })).resolves.toEqual([
      { id: 'gpt-4o-mini', capability: 'text', alias: 'GPT-4o mini' },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sk-from-disk' }),
      }),
    );
    // 无 verifySsl 的键：init 不携带 dispatcher 字段（零透传——默认校验路径字节不变）。
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect('dispatcher' in init).toBe(false);
  });

  // ── CR-25（09-12 子3 §3⑦）：listModels 键发现请求并入 customHeaders/verifySsl ──

  it('CR-25: keyId 路径读盘合并键 customHeaders/verifySsl（网关鉴权键的模型发现不再恒 401/431）', async () => {
    // 注入带传输面的键（盘层 round-trip 归子3 在途波次——此处钉合并契约本身）。
    configIpcMocks.readModelConfigFromDisk.mockReturnValue({
      ...SAMPLE_CONFIG,
      keys: [{
        ...SAMPLE_CONFIG.keys[0]!,
        customHeaders: { 'X-Gateway-Auth': 'gw-token', 'X-Route': 'pool-a' },
        verifySsl: true,
      }],
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      data: [{ id: 'gpt-4o-mini' }],
    }));

    registerModelProviderIpc();
    const [, handler] = handle.mock.calls[0]!;

    await expect(handler({}, { keyId: 'key_001' })).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer sk-from-disk',
          'X-Gateway-Auth': 'gw-token',
          'X-Route': 'pool-a',
        }),
      }),
    );
    // verifySsl=true → 不安全 undici dispatcher 进 fetch init（per-request，不装全局）。
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
  });

  it('CR-25: ad-hoc 路径（首键设置）请求自带 customHeaders/verifySsl 同样上车', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({
      data: [{ id: 'gpt-4o-mini' }],
    }));

    registerModelProviderIpc();
    const [, handler] = handle.mock.calls[0]!;

    await expect(handler({}, {
      protocol: 'openai-compatible',
      apiKey: 'sk-adhoc',
      baseUrl: 'https://gw.example.com',
      customHeaders: { 'X-Gateway-Auth': 'adhoc-token' },
      verifySsl: true,
    })).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gw.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer sk-adhoc',
          'X-Gateway-Auth': 'adhoc-token',
        }),
      }),
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
  });
});
