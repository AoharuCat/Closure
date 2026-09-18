import path from 'node:path';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlatYaml, stringifyFlatYaml, type ModelConfig } from '@orison/shared-contracts';

// CR-005 test seam: node:fs's ESM namespace is frozen (vi.spyOn refuses), so a
// selective pass-through module mock stands in for the spy — it throws ONCE on
// the task-models sidecar removal while armed, everything else hits real fs.
const rmFailArmed = vi.hoisted(() => ({ armed: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: ((target: unknown, options: unknown) => {
      if (
        rmFailArmed.armed &&
        typeof target === 'string' &&
        target.endsWith(path.join('task-models.yaml'))
      ) {
        rmFailArmed.armed = false;
        throw new Error('EPERM: locked');
      }
      return actual.rmSync(target as Parameters<typeof actual.rmSync>[0], options as Parameters<typeof actual.rmSync>[1]);
    }) as typeof actual.rmSync,
  };
});

const { handle, safeStorage, reindexAll, reindexAllCraft, reindexAssetCards, reindexAllSettingMd, rebuildChapterChunks, listChapterSummaries, reindexChapterSummaryEntry, getProjectById, getProject, getDb, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  reindexAll: vi.fn(),
  reindexAllCraft: vi.fn(),
  // Story 2.7 GAP2: reindexAllForChangedModel now also reindexes asset_cards per
  // project (resolved via getProjectById). Mock both so the wiring test can assert
  // the call + the existing tests' incidental embeddingModel changes don't spawn a
  // real asset_cards reindex.
  reindexAssetCards: vi.fn(),
  // dogfood #39 (T2 C1): the sweep's recovery surface now covers the full five
  // story faces — setting_md + chapter chunks + per-episode chapter summaries
  // (mirror the manual rebuild). Mock the three new feeders.
  reindexAllSettingMd: vi.fn(),
  rebuildChapterChunks: vi.fn(),
  listChapterSummaries: vi.fn(),
  reindexChapterSummaryEntry: vi.fn(),
  getProjectById: vi.fn(),
  // settingMdIndexer.runReindexAllSettingMd 调 getProject（按 path 解析 projectId，与 getProjectById 不同）。
  // 缺此 mock 致 unhandled rejection（vi.mock 返 undefined → 调 undefined 抛）。返 undefined → projectId 缺 →
  // runReindexAllSettingMd 早返回 graceful（mirror getProjectById default undefined 模式，Story 2.7 GAP2）。
  getProject: vi.fn(),
  getDb: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  // 08-25 背景：registerConfigIpc 注册期 allowPath(userData/wallpaper) → mock getPath。
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

// CR-01: configIpc now imports reindexAll (closureIndexer) + reindexAllCraft
// (closureCraftIndexer, Story 2.1) + getDb (db/index) to trigger a reindex on an
// embedding-model change. Mock all three so (a) the existing tests that
// incidentally change embeddingModel don't touch the real DB / spawn a real
// reindex, and (b) the wiring test can assert reindexAll is called per distinct
// project_id. The logger is mocked so the reindex start/done/warn logs do not
// touch ~/.orison/logs.
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/chapterChunkIndexer', () => ({ rebuildChapterChunks }));
vi.mock('../main/db/chapterSummaryIndexer', () => ({ reindexChapterSummaryEntry }));
vi.mock('../main/db/worldStateRepository', () => ({ listChapterSummaries }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import { _setModelConfigDirForTest, registerConfigIpc, embeddingModelChanged, reindexAllForChangedModel, readTaskModelSlots, readModelConfigFromDisk } from '../main/ipc/configIpc';
import { isEmbeddingSweepInflight, runWithEmbeddingSweepGate } from '../main/db/embeddingSweepGate';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-model-config');

const SAMPLE_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_001',
      name: 'Main relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example.com/v1',
      models: [
        { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
      ],
    },
    {
      id: 'key_002',
      name: 'Image relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-image',
      baseUrl: 'https://relay.example.com/v1',
      models: [
        { id: 'gpt-image-1', alias: 'GPT Image 1', capability: 'image', enabled: true },
      ],
    },
  ],
};

// Root-level reset: the CR-01 mocks (reindexAll/getDb/warn/info) are shared
// across every describe in this file. Reset their call history before EACH test
// so fire-and-forget reindex calls from one test never bleed into the assertions
// of the next. `mockReset` also clears mockReturnValue/Implementation, so each
// describe's own beforeEach re-establishes the defaults it needs.
beforeEach(() => {
  reindexAll.mockReset();
  getDb.mockReset();
  warn.mockReset();
  info.mockReset();
  // CR-005 seam safety: never let an unconsumed armed rmSync failure from a
  // failed test bleed into the next one.
  rmFailArmed.armed = false;
  // Story 2.7 GAP2: reset the asset_cards wiring mocks too (shared across describes).
  reindexAssetCards.mockReset();
  getProjectById.mockReset();
  // dogfood #39 (T2 C1): reset the sweep's full-recovery-surface mocks (mirror the
  // GAP2 pattern — defaults resolve cleanly / return empty so incidental
  // embeddingModel changes in existing tests stay no-ops).
  reindexAllSettingMd.mockReset();
  reindexAllSettingMd.mockResolvedValue({ reindexed: 0, orphaned: 0 });
  rebuildChapterChunks.mockReset();
  rebuildChapterChunks.mockResolvedValue({ reindexed: 0, orphaned: 0 });
  listChapterSummaries.mockReset();
  listChapterSummaries.mockReturnValue([]);
  reindexChapterSummaryEntry.mockReset();
  reindexChapterSummaryEntry.mockResolvedValue(undefined);
});

describe('model config IPC', () => {
  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    // CR-01 mocks: default getDb returns no closure_entry projects (so any
    // incidental embeddingModel change in the existing tests is a no-op sweep),
    // reindexAll resolves cleanly, logs reset.
    getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
    reindexAll.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });
    // Story 2.1: reindexAllForChangedModel also reindexes the craft KB. Default
    // mock resolves cleanly so the existing tests' incidental embeddingModel
    // changes don't spawn a real craft reindex. Reset call history so the wiring
    // test can assert exactly one craft reindex (the fire-and-forget sweep from
    // prior tests would otherwise accumulate calls on this shared mock).
    reindexAllCraft.mockReset();
    reindexAllCraft.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });
    // Story 2.7 GAP2: default getProjectById returns undefined (no registry path)
    // so incidental embeddingModel changes in the existing tests skip the
    // asset_cards reindex path. reindexAssetCards resolves cleanly just in case.
    getProjectById.mockReturnValue(undefined);
    reindexAssetCards.mockResolvedValue({ reindexed: 0, orphaned: 0 });
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
  });

  it('writes one YAML file per key in keys/ directory', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    expect(saveCall).toBeTruthy();

    const [, saveHandler] = saveCall!;
    await saveHandler({}, SAMPLE_CONFIG);

    const keyFile = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'keys', 'key_001.yaml'), 'utf-8'));
    expect(keyFile).toMatchObject({
      id: 'key_001',
      name: 'Main relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example.com/v1',
      'models.0.id': 'gpt-4o-mini',
      'models.0.capability': 'text',
      'models.0.alias': 'GPT 4o mini',
      'models.0.enabled': true,
    });
  });

  // dogfood 2026-08-21（#41 追修）：读取时治愈存量脏派生字段——registry 修 bug 后
  // 旧配置（截断 alias、误标 capability）不靠用户重新拉取，加载即重算。
  it('load heals stale derived fields (truncated alias / wrong capability), keeps enabled', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const staleConfig: ModelConfig = {
      keys: [
        {
          ...SAMPLE_CONFIG.keys[0],
          models: [
            // 盘上实录形态：截断 alias + 误标 text 的 embedding/reranker。
            { id: 'Qwen/Qwen3-Embedding-8B', alias: 'Embedding Qwen/Qwen3-Embedd', capability: 'text', enabled: true },
            { id: 'Qwen/Qwen3-Reranker-8B', alias: 'Qwen/Qwen3-Reranker-8B', capability: 'text', enabled: false },
          ],
        },
      ],
    };
    await saveCall![1]({}, staleConfig satisfies ModelConfig);
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.keys[0].models[0]).toMatchObject({
      id: 'Qwen/Qwen3-Embedding-8B',
      alias: 'Qwen3-Embedding-8B',
      capability: 'embedding',
      enabled: true, // 用户 authored 状态保留
    });
    expect(result.keys[0].models[1]).toMatchObject({
      id: 'Qwen/Qwen3-Reranker-8B',
      alias: 'Qwen3-Reranker-8B',
      capability: 'rerank',
      enabled: false,
    });
  });

  it('round-trips save then load', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1]({}, SAMPLE_CONFIG);
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.keys).toHaveLength(2);
    expect(result.keys[0].id).toBe('key_001');
    expect(result.keys[0].models[0].id).toBe('gpt-4o-mini');
    expect(result.keys[1].id).toBe('key_002');
  });

  // 09-12 agy provider：CLI 键的盘面往返——写侧不落 HTTP 凭据（形态互斥的盘面镜像），
  // cliExecutable 是判别载荷；读回 strict face 原样通过。HTTP 键文件键集不变（零回归门）。
  it('round-trips an antigravity-cli key: cliExecutable persisted, no HTTP credentials on disk', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const config: ModelConfig = {
      keys: [
        ...SAMPLE_CONFIG.keys,
        {
          id: 'key_agy',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          // 渲染层 apiKey '' 哨兵（save face tolerate；CLI 分支写侧忽略该字段）。
          apiKey: '',
          cliExecutable: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe',
          models: [
            { id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (high)', capability: 'text', enabled: true },
          ],
        },
      ],
    };
    await saveCall![1]({}, config);

    const agyFile = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'keys', 'key_agy.yaml'), 'utf-8'));
    expect(agyFile).toMatchObject({
      id: 'key_agy',
      protocol: 'antigravity-cli',
      cliExecutable: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe',
      'models.0.id': 'gemini-3.8-pro-high',
    });
    // 不落 HTTP 凭据（键不存在，而非空串占位）。
    expect(Object.keys(agyFile)).not.toContain('baseUrl');
    expect(Object.keys(agyFile)).not.toContain('apiKey');

    // HTTP 键文件键集不变（既有写入序零回归）。
    const httpFile = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'keys', 'key_001.yaml'), 'utf-8'));
    expect(httpFile).toMatchObject({ protocol: 'openai-compatible', baseUrl: 'https://relay.example.com/v1' });
    expect(Object.keys(httpFile)).toContain('apiKey');

    // 读回：CLI 键 cliExecutable 在场；baseUrl undefined（盘上本就缺席）。apiKey ''
    // 是 renderer-facing redaction 形态（redactModelConfig 对所有键统一打 ''，非 CLI
    // 键特有——盘级断言已证键不存在）。
    const result = (await loadCall![1]({})) as ModelConfig;
    const agyKey = result.keys.find((k) => k.id === 'key_agy');
    expect(agyKey?.protocol).toBe('antigravity-cli');
    expect(agyKey?.cliExecutable).toContain('agy.exe');
    expect(agyKey?.baseUrl).toBeUndefined();
    expect(agyKey?.apiKey).toBe('');
  });

  // ── 09-12 子3 W3（design §7）：provider 参数面盘格式往返 + 旧格式字节不变 + lenient 读 ──
  it('round-trips the 子3 params face: headers 平铺 / timeout / 流式禁用 / 证书 / defaults / extraBody JSON-string / pricing', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const config: ModelConfig = {
      keys: [
        {
          id: 'key_p3rt',
          name: 'Params RT',
          protocol: 'openai-compatible',
          apiKey: 'sk-rt',
          baseUrl: 'https://relay.example.com/v1',
          customHeaders: { 'X-Route-Tag': 'closure', 'X-Num': '12345', 'X-Drift-Null': 'null', 'X-Drift-Yes': 'yes' },
          timeoutSeconds: 90,
          streamingDisabled: true,
          verifySsl: true,
          models: [
            {
              id: 'rt-model',
              alias: 'RT Model',
              capability: 'text',
              enabled: true,
              defaults: {
                temperature: 0.7,
                topP: 0.9,
                frequencyPenalty: -0.2,
                presencePenalty: 0.3,
                contextWindow: 131_072,
                maxOutputTokens: 16_384,
              },
              extraBody: { safe_prompt: true, vendor: { min_p: 0.05 } },
              pricing: { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.2 },
            },
          ],
        },
      ],
    };
    await saveCall![1]({}, config);

    const flat = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'keys', 'key_p3rt.yaml'), 'utf-8'));
    expect(flat).toMatchObject({
      'headers.X-Route-Tag': 'closure',
      // CR-6：header 字符串值写侧一律 flatQuoted（双引号 JSON 串）——裸写时精确数值/布尔
      // 族字符串会被 parseScalar 重释成 number/bool/null（'null' 直接丢头）。测试自身的
      // parseFlatYaml 因此读回 string（下方 load 断言钉逐字保真）。
      'headers.X-Num': '12345',
      'headers.X-Drift-Null': 'null',
      'headers.X-Drift-Yes': 'yes',
      timeoutSeconds: 90,
      streamingDisabled: true,
      verifySsl: true,
      'models.0.defaults.temperature': 0.7,
      'models.0.defaults.topP': 0.9,
      'models.0.defaults.frequencyPenalty': -0.2,
      'models.0.defaults.presencePenalty': 0.3,
      'models.0.defaults.contextWindow': 131_072,
      'models.0.defaults.maxOutputTokens': 16_384,
      'models.0.pricing.inputPerMillion': 1.5,
      'models.0.pricing.outputPerMillion': 7.5,
      'models.0.pricing.cachedInputPerMillion': 0.2,
    });
    // extraBody = 单键 JSON-string（嵌套/带点键不能展平为 dotted 子键）。
    expect(JSON.parse(flat['models.0.extraBody'] as string)).toEqual({
      safe_prompt: true,
      vendor: { min_p: 0.05 },
    });

    const result = (await loadCall![1]({})) as ModelConfig;
    const key = result.keys.find((k) => k.id === 'key_p3rt');
    expect(key?.customHeaders).toEqual({
      'X-Route-Tag': 'closure',
      'X-Num': '12345', // 数值形态读回还原 string（引号形态逐字保真）
      'X-Drift-Null': 'null', // CR-6：漂移族字符串逐字保真（裸写会被重释成 null 而丢头）
      'X-Drift-Yes': 'yes',
    });
    expect(key?.timeoutSeconds).toBe(90);
    expect(key?.streamingDisabled).toBe(true);
    expect(key?.verifySsl).toBe(true);
    expect(key?.models[0]?.defaults).toEqual({
      temperature: 0.7,
      topP: 0.9,
      frequencyPenalty: -0.2,
      presencePenalty: 0.3,
      contextWindow: 131_072,
      maxOutputTokens: 16_384,
    });
    expect(key?.models[0]?.extraBody).toEqual({ safe_prompt: true, vendor: { min_p: 0.05 } });
    expect(key?.models[0]?.pricing).toEqual({ inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.2 });
  });

  it('旧格式文件字节不变：无子3 字段的键写盘与既有序列化逐字节一致（零迁移硬门）', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    await saveCall![1]({}, {
      keys: [SAMPLE_CONFIG.keys[0]],
    } satisfies ModelConfig);

    const text = readFileSync(path.join(TEST_MODEL_DIR, 'keys', 'key_001.yaml'), 'utf-8');
    expect(text).toBe(
      [
        'id: key_001',
        'name: "Main relay"',
        'protocol: openai-compatible',
        'baseUrl: https://relay.example.com/v1',
        'apiKey: sk-test',
        'models.0.id: gpt-4o-mini',
        'models.0.capability: text',
        'models.0.alias: "GPT 4o mini"',
        'models.0.enabled: true',
        '',
      ].join('\n'),
    );
  });

  it('lenient 读：病态新键按缺席（坏 header 名/非数字 defaults/坏 JSON extraBody/非正整数超时），合法兄弟键存活', async () => {
    registerConfigIpc();
    const keysDir = path.join(TEST_MODEL_DIR, 'keys');
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(
      path.join(keysDir, 'key_hand.yaml'),
      [
        'id: key_hand',
        'name: Hand',
        'protocol: openai-compatible',
        'baseUrl: https://relay.example.com/v1',
        'apiKey: sk-hand',
        'headers.X-Good: fine',
        'headers.Bad.Name: dropped',
        'headers.X-Num: 12345',
        'timeoutSeconds: abc',
        'streamingDisabled: maybe',
        'verifySsl: true',
        'models.0.id: m1',
        'models.0.capability: text',
        'models.0.alias: m1',
        'models.0.enabled: true',
        'models.0.defaults.temperature: 0.5',
        'models.0.defaults.topP: xyz',
        'models.0.extraBody: {"broken":',
        'models.1.id: m2',
        'models.1.capability: text',
        'models.1.alias: m2',
        'models.1.enabled: true',
        'models.1.defaults.contextWindow: 131072',
        'models.1.pricing.inputPerMillion: 1.5',
      ].join('\n') + '\n',
      'utf8',
    );

    const config = readModelConfigFromDisk();
    const key = config.keys.find((k) => k.id === 'key_hand');
    expect(key).toBeTruthy();
    expect(key?.customHeaders).toEqual({ 'X-Good': 'fine', 'X-Num': '12345' }); // 病态名丢弃、数值形态还原
    expect(key?.timeoutSeconds).toBeUndefined(); // 非数字按缺席
    expect(key?.streamingDisabled).toBeUndefined(); // 非布尔按缺席
    expect(key?.verifySsl).toBe(true);
    expect(key?.models[0]?.defaults).toEqual({ temperature: 0.5 }); // topP 非数字丢弃、兄弟字段存活
    expect(key?.models[0]?.extraBody).toBeUndefined(); // 坏 JSON 按缺席
    expect(key?.models[1]?.defaults).toEqual({ contextWindow: 131_072 });
    expect(key?.models[1]?.pricing).toEqual({ inputPerMillion: 1.5 });
  });

  // ── CR-13（09-12 子3 CR 批）：清除 round-trip——populate → clear → save → reload ──
  // 写侧是从 parsed 键全量重建 flat（仅 apiKey 有 '' 哨兵合并），子3 字段全部条件展开
  // （缺席不落键）——clear 语义 = 删键。本测试钉死「不 merge-with-existing 复活已删字段」。
  it('CR-13: 清除 round-trip——populate → clear → save → reload 后子3 字段全缺席（无 merge 复活）', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    // populate：headers/timeout/流式/证书/defaults/extraBody/pricing 全配。
    await saveCall![1]({}, {
      keys: [{
        id: 'key_clr',
        name: 'Clear RT',
        protocol: 'openai-compatible',
        apiKey: 'sk-clr',
        baseUrl: 'https://relay.example.com/v1',
        customHeaders: { 'X-Route-Tag': 'closure' },
        timeoutSeconds: 90,
        streamingDisabled: true,
        verifySsl: true,
        models: [{
          id: 'm-clr',
          alias: 'M',
          capability: 'text',
          enabled: true,
          defaults: { temperature: 0.7, contextWindow: 131_072 },
          extraBody: { safe_prompt: true },
          pricing: { inputPerMillion: 1.5 },
        }],
      }],
    } satisfies ModelConfig);
    let seeded = (await loadCall![1]({})) as ModelConfig;
    expect(seeded.keys[0]?.customHeaders).toEqual({ 'X-Route-Tag': 'closure' });

    // clear：同键保存但子3 字段全部缺席（UI 清空后投影的二态空侧）。
    await saveCall![1]({}, {
      keys: [{
        id: 'key_clr',
        name: 'Clear RT',
        protocol: 'openai-compatible',
        apiKey: 'sk-clr',
        baseUrl: 'https://relay.example.com/v1',
        models: [{ id: 'm-clr', alias: 'M', capability: 'text', enabled: true }],
      }],
    } satisfies ModelConfig);

    const cleared = (await loadCall![1]({})) as ModelConfig;
    const key = cleared.keys.find((k) => k.id === 'key_clr');
    expect(key?.customHeaders).toBeUndefined();
    expect(key?.timeoutSeconds).toBeUndefined();
    expect(key?.streamingDisabled).toBeUndefined();
    // verifySsl 是 CLI 容忍字段且写侧分支外共写——本用例不设即不落键。
    expect(key?.verifySsl).toBeUndefined();
    expect(key?.models[0]?.defaults).toBeUndefined();
    expect(key?.models[0]?.extraBody).toBeUndefined();
    expect(key?.models[0]?.pricing).toBeUndefined();
    // 盘面断言：flat 键不残留（不是「读侧忽略」而是「写侧删键」）。
    const flat = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'keys', 'key_clr.yaml'), 'utf-8'));
    expect(Object.keys(flat).some((k) => k.startsWith('headers.'))).toBe(false);
    expect('timeoutSeconds' in flat).toBe(false);
    expect('streamingDisabled' in flat).toBe(false);
    expect('verifySsl' in flat).toBe(false);
    expect(Object.keys(flat).some((k) => k.includes('.defaults.'))).toBe(false);
    expect(Object.keys(flat).some((k) => k.endsWith('.extraBody'))).toBe(false);
    expect(Object.keys(flat).some((k) => k.includes('.pricing.'))).toBe(false);
  });

  // ── CR-2/3/5/7（09-12 子3 CR 批）：lenient 读侧三道闸 + 范围外丢弃 + warn 留痕 ──
  it('CR-2/3/5/7: 读侧守卫——blocked header 名/控制字符 header 值/越域 defaults/超界 timeout 丢弃且 warn，合法兄弟键存活', async () => {
    registerConfigIpc();
    const keysDir = path.join(TEST_MODEL_DIR, 'keys');
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(
      path.join(keysDir, 'key_guard.yaml'),
      [
        'id: key_guard',
        'name: Guard',
        'protocol: openai-compatible',
        'baseUrl: https://relay.example.com/v1',
        'apiKey: sk-guard',
        'headers.X-Good: fine',
        // CR-3：wire 序列化关键头黑名单（与 save 面同源常量集）——手改注入不得零过滤上
        // wire。（authorization 刻意不在黑名单——网关替代鉴权语义，契约测试钉过放行。）
        'headers.Content-Length: 99999',
        // CR-2：控制字符值（引号 JSON 转义读回真实 \t/\n）——undici Headers.set 会抛。
        'headers.X-Tab: "a\tb"',
        // 文件里是两字符转义 `\n`（JS 源双反斜杠）——parseScalar JSON 路径读回真实换行。
        'headers.X-Lf: "line1\\nline2"',
        // CR-7：超界 timeout（86400 上界外 = 数日级 abort 窗）。
        'timeoutSeconds: 9999999',
        'models.0.id: m1',
        'models.0.capability: text',
        'models.0.alias: m1',
        'models.0.enabled: true',
        // CR-7：范围外采样值（temperature 99 → 每请求 400）与 CR-4 的 0 值窗口。
        'models.0.defaults.temperature: 99',
        'models.0.defaults.contextWindow: 0',
        'models.0.defaults.topP: 0.9',
      ].join('\n') + '\n',
      'utf8',
    );

    const config = readModelConfigFromDisk();
    const key = config.keys.find((k) => k.id === 'key_guard');
    expect(key).toBeTruthy();
    // 合法兄弟键存活；三道闸各自拦截。
    expect(key?.customHeaders).toEqual({ 'X-Good': 'fine' });
    expect(key?.timeoutSeconds).toBeUndefined();
    expect(key?.models[0]?.defaults).toEqual({ topP: 0.9 });
    // CR-5：每类丢弃 warn 留痕（静默丢弃 = 配置神秘丢失无迹可查）。
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key_guard', name: 'Content-Length' }),
      expect.stringContaining('wire-serialization header'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key_guard', name: 'X-Tab' }),
      expect.stringContaining('illegal custom header value'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key_guard' }),
      expect.stringContaining('illegal timeoutSeconds'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key_guard', field: 'temperature' }),
      expect.stringContaining('illegal model default value'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key_guard', field: 'contextWindow' }),
      expect.stringContaining('illegal model default value'),
    );
  });

  // 09-12 agy provider W4：CLI 键的 alias 是 `agy models` TSV 的官方显示名——
  // healDerivedModelFields 不覆盖（registry 族名兜底会把 gemini-* 全落「Gemini」×N
  // 不可分辨）；capability 仍以 registry 重算。
  it('load keeps the provider-supplied alias for CLI keys while healing capability', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const config: ModelConfig = {
      keys: [
        {
          id: 'key_agy',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          apiKey: '',
          cliExecutable: 'C:/agy/bin/agy.exe',
          models: [
            { id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro (High)', capability: 'text', enabled: true },
            { id: 'claude-sonnet-4-6', alias: 'Claude Sonnet 4.6', capability: 'text', enabled: true },
          ],
        },
      ],
    };
    await saveCall![1]({}, config);
    const result = (await loadCall![1]({})) as ModelConfig;
    const models = result.keys[0]!.models;
    // TSV 显示名原样保留（旧 heal 行为会把两者分别改成「Gemini 3.8-pro-high」/
    // 「Claude sonnet-4-6」的 registry 族别名形态）。
    expect(models[0]).toMatchObject({
      id: 'gemini-3.8-pro-high',
      alias: 'Gemini 3.8 Pro (High)',
      capability: 'text',
    });
    expect(models[1]).toMatchObject({
      id: 'claude-sonnet-4-6',
      alias: 'Claude Sonnet 4.6',
      capability: 'text',
    });
  });

  it('CR-craft-kb-001: a rerank capability survives config reload (not downgraded to text)', async () => {
    // readCapability must keep 'rerank' in its allowlist, else an auto-detected
    // rerank model's capability is silently downgraded to 'text' on the first
    // reload -> resolveRerankModel never auto-detects it again.
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const configWithRerank: ModelConfig = {
      keys: [
        {
          ...SAMPLE_CONFIG.keys[0],
          models: [
            { id: 'bge-reranker-v2-m3', alias: 'BGE reranker v2 m3', capability: 'rerank', enabled: true },
          ],
        },
      ],
    };
    await saveCall![1]({}, configWithRerank satisfies ModelConfig);
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.keys[0].models[0].capability).toBe('rerank');
  });

  it('round-trips the embeddingModel preset via sidecar (VS1)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      {
        ...SAMPLE_CONFIG,
        embeddingModel: { keyId: 'key_001', modelId: 'gpt-4o-mini' },
      } satisfies ModelConfig,
    );
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.embeddingModel).toEqual({ keyId: 'key_001', modelId: 'gpt-4o-mini' });
  });

  it('clears the embeddingModel preset when a later save omits it', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, embeddingModel: { keyId: 'key_001', modelId: 'gpt-4o-mini' } } satisfies ModelConfig,
    );
    await saveCall![1]({}, SAMPLE_CONFIG); // no embeddingModel → sidecar removed
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.embeddingModel).toBeUndefined();
  });

  it('round-trips the rerankModel preset via sidecar (Story 2.1)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      {
        ...SAMPLE_CONFIG,
        rerankModel: { keyId: 'key_001', modelId: 'bge-reranker-v2-m3' },
      } satisfies ModelConfig,
    );
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.rerankModel).toEqual({ keyId: 'key_001', modelId: 'bge-reranker-v2-m3' });
  });

  it('clears the rerankModel preset when a later save omits it (Story 2.1)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, rerankModel: { keyId: 'key_001', modelId: 'bge-reranker-v2-m3' } } satisfies ModelConfig,
    );
    await saveCall![1]({}, SAMPLE_CONFIG); // no rerankModel → sidecar removed
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.rerankModel).toBeUndefined();
  });

  // Story 3.6 R9b: visionModel sidecar — mirror of the rerankModel round-trips.
  it('round-trips the visionModel preset via sidecar (Story 3.6)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      {
        ...SAMPLE_CONFIG,
        visionModel: { keyId: 'key_001', modelId: 'qwen-vl-max' },
      } satisfies ModelConfig,
    );
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.visionModel).toEqual({ keyId: 'key_001', modelId: 'qwen-vl-max' });
  });

  it('clears the visionModel preset when a later save omits it (Story 3.6)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, visionModel: { keyId: 'key_001', modelId: 'qwen-vl-max' } } satisfies ModelConfig,
    );
    await saveCall![1]({}, SAMPLE_CONFIG); // no visionModel → sidecar removed
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.visionModel).toBeUndefined();
  });

  // ── C3.2: taskModels sidecar — mirror of the embedding/rerank/vision round-trips ──

  it('round-trips the taskModels record via sidecar and readModelConfig aggregation (C3.2)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const taskModels = {
      'writer-selfcheck': { keyId: 'key_001', modelId: 'qwen-flash' },
      'writer-draft': { keyId: 'key_001', modelId: 'qwen-max' },
      'review-judge': { keyId: 'key_002', modelId: 'deepseek-r1' },
    };
    await saveCall![1]({}, { ...SAMPLE_CONFIG, taskModels } satisfies ModelConfig);
    // The load handler goes redactModelConfig(readModelConfig()) — passing here
    // means the aggregation AND the no-secret pass-through both carry the field.
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.taskModels).toEqual(taskModels);
    // Sidecar encoding: flat dotted keys per slot (same shape family as
    // `models.N.id` in the key files).
    const sidecar = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'task-models.yaml'), 'utf-8'));
    expect(sidecar).toMatchObject({
      'writer-selfcheck.keyId': 'key_001',
      'writer-selfcheck.modelId': 'qwen-flash',
      'writer-draft.modelId': 'qwen-max',
      'review-judge.keyId': 'key_002',
    });
  });

  it('clears the taskModels sidecar when a later save omits it (C3.2)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'qwen-max' } } } satisfies ModelConfig,
    );
    await saveCall![1]({}, SAMPLE_CONFIG); // no taskModels → sidecar removed
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.taskModels).toBeUndefined();
  });

  it('an empty taskModels record (every slot cleared back to Auto) also removes the sidecar (C3.2)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'qwen-max' } } } satisfies ModelConfig,
    );
    await saveCall![1]({}, { ...SAMPLE_CONFIG, taskModels: {} } satisfies ModelConfig);
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.taskModels).toBeUndefined();
    expect(existsSync(path.join(TEST_MODEL_DIR, 'task-models.yaml'))).toBe(false);
  });

  // ── 08-25 S3：task-models sidecar thinking 策略位（slot.thinking / slot.thinkingCustom）──

  it('round-trips slot thinking policy keys; ref-only entries stay policy-free (08-25)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const taskModels: NonNullable<ModelConfig['taskModels']> = {
      dialogue: { keyId: 'key_001', modelId: 'qwen-max', thinking: 'high' },
      'writer-draft': { keyId: 'key_001', modelId: 'glm-5.3', thinkingCustom: '8192' },
      'review-judge': { keyId: 'key_001', modelId: 'deepseek-v4-pro', thinking: 'off' },
      extraction: { keyId: 'key_001', modelId: 'gpt-4o-mini' },
    };
    await saveCall![1]({}, { ...SAMPLE_CONFIG, taskModels } satisfies ModelConfig);
    const result = (await loadCall![1]({})) as ModelConfig;

    // Load path = redactModelConfig(readModelConfig()) — passing means the
    // aggregation AND the sidecar read both carry the policy fields.
    expect(result.taskModels).toEqual(taskModels);
    const sidecar = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'task-models.yaml'), 'utf-8'));
    expect(sidecar).toMatchObject({
      'dialogue.keyId': 'key_001',
      'dialogue.thinking': 'high',
      // On-disk form is UNQUOTED (formatScalar's safe-charset passes digits), so
      // the test's own parseFlatYaml number-coerces it — the read side
      // canonicalizes back to the string '8192' (asserted by the toEqual above).
      'writer-draft.thinkingCustom': 8192,
      'review-judge.thinking': 'off',
    });
    // Ref-only slots write no policy keys (zero migration on the encoding side).
    expect(Object.keys(sidecar)).not.toContain('extraction.thinking');
    expect(Object.keys(sidecar)).not.toContain('extraction.thinkingCustom');
  });

  // ── 09-12 子2：fallback 链 sidecar 往返（flat 键 `${slot}.fallbacks.N.*`）──

  it('round-trips a slot fallback chain via sidecar flat keys; chain-free slots write no fallback keys (子2)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    const taskModels: NonNullable<ModelConfig['taskModels']> = {
      'writer-draft': {
        keyId: 'key_001',
        modelId: 'qwen-max',
        fallbacks: [
          { keyId: 'key_002', modelId: 'qwen-plus', thinking: 'low' },
          { keyId: 'key_001', modelId: 'qwen-flash', thinkingCustom: '4096' },
        ],
      },
      dialogue: { keyId: 'key_001', modelId: 'qwen-max' }, // chain-free slot
    };
    await saveCall![1]({}, { ...SAMPLE_CONFIG, taskModels } satisfies ModelConfig);
    // Load path = redactModelConfig(readModelConfig()) — passing means the
    // aggregation AND the sidecar read both carry the chain (kindless models
    // keep their per-entry policies read-side; numeric custom canonicalizes
    // back to the schema's string form, mirror of the 08-25 policy test).
    const result = (await loadCall![1]({})) as ModelConfig;
    expect(result.taskModels).toEqual(taskModels);

    const sidecar = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'task-models.yaml'), 'utf-8'));
    expect(sidecar).toMatchObject({
      'writer-draft.keyId': 'key_001',
      'writer-draft.fallbacks.0.keyId': 'key_002',
      'writer-draft.fallbacks.0.modelId': 'qwen-plus',
      'writer-draft.fallbacks.0.thinking': 'low',
      'writer-draft.fallbacks.1.keyId': 'key_001',
      'writer-draft.fallbacks.1.modelId': 'qwen-flash',
      'writer-draft.fallbacks.1.thinkingCustom': 4096, // unquoted numeric round-trips number-coerced
    });
    // Unset policy keys and chain-free slots stay absent (two-state write side).
    expect(Object.keys(sidecar)).not.toContain('writer-draft.fallbacks.1.thinking');
    expect(Object.keys(sidecar)).not.toContain('dialogue.fallbacks.0.keyId');
  });

  // ── 09-12 子2 CR 批（CR-18）：空 `fallbacks: []` 载荷的 lenient 归一 ──

  it('CR-18: slot 携 `fallbacks: []` 的 save 载荷 → lenient 归一为缺席再 parse（不砖死整次 save），sidecar 落链-free 形态', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    // 一个 slot 携空数组链（手编/装配边缘形态）+ 一个正常 slot 同载荷——空数组曾使
    // modelConfigSaveSchema.parse（.min(1) 拒收）砖死整次 save（用户连无关设置都存不了）。
    await saveCall![1](
      {},
      {
        ...SAMPLE_CONFIG,
        taskModels: {
          dialogue: { keyId: 'key_001', modelId: 'qwen-max', fallbacks: [] },
          extraction: { keyId: 'key_001', modelId: 'gpt-4o-mini' },
        },
      } as unknown as ModelConfig,
    );
    const result = (await loadCall![1]({})) as ModelConfig;

    // 归一语义 = 空链 ≡ 无链：slot 的 ref 保留、fallbacks 键缺席（二态契约空侧）。
    expect(result.taskModels).toEqual({
      dialogue: { keyId: 'key_001', modelId: 'qwen-max' },
      extraction: { keyId: 'key_001', modelId: 'gpt-4o-mini' },
    });
    const sidecar = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'task-models.yaml'), 'utf-8'));
    expect(sidecar['dialogue.keyId']).toBe('key_001');
    expect(Object.keys(sidecar).some((k) => k.startsWith('dialogue.fallbacks'))).toBe(false);
  });

  it('save path loudly rejects an illegal slot.thinking value (zod) — leniency is disk-read only (08-25)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');

    // 'bogus' is not a unified tier at all.
    await expect(
      saveCall![1]({}, { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'm', thinking: 'bogus' } } }),
    ).rejects.toThrow();
    // 'custom' IS in the request-side vocabulary (thinkingControlSchema) but is
    // deliberately NOT legal on the slot assignment (a non-empty thinkingCustom
    // means level=custom) — the most likely payload mistake; the save schema
    // must reject it loudly rather than silently storing a dead value.
    await expect(
      saveCall![1]({}, { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'm', thinking: 'custom' } } }),
    ).rejects.toThrow();
  });

  it('rejects an unknown slot key on the save path (loud zod reject) and leaves the sidecar untouched (C3.2)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    // Seed a valid designation first so "untouched" is observable.
    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'qwen-max' } } } satisfies ModelConfig,
    );
    // Unknown slot key ('multi-reader' is a retired GAP slot) →
    // modelConfigSaveSchema.parse throws → the handler rejects as an IPC
    // rejection. The disk read path is the lenient counterpart (see the
    // defensive-parsing describe below) — this contrast is the C3.2 contract.
    await expect(
      saveCall![1](
        {},
        { ...SAMPLE_CONFIG, taskModels: { 'multi-reader': { keyId: 'key_001', modelId: 'm' } } },
      ),
    ).rejects.toThrow();
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.taskModels).toEqual({ dialogue: { keyId: 'key_001', modelId: 'qwen-max' } });
  });

  it('redacts api keys from renderer-facing load-model results', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');

    await saveCall![1]({}, SAMPLE_CONFIG);
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.keys[0].apiKey).toBe('');
    expect(result.keys[1].apiKey).toBe('');
    expect(JSON.stringify(result)).not.toContain('sk-test');
    expect(JSON.stringify(result)).not.toContain('sk-image');
  });

  it('preserves the existing encrypted api key when renderer saves a redacted key unchanged', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');

    await saveCall![1]({}, SAMPLE_CONFIG);
    await saveCall![1]({}, {
      keys: [
        {
          ...SAMPLE_CONFIG.keys[0],
          name: 'Renamed relay',
          apiKey: '',
        },
      ],
    } satisfies ModelConfig);

    const keyFile = parseFlatYaml(readFileSync(path.join(TEST_MODEL_DIR, 'keys', 'key_001.yaml'), 'utf-8'));
    expect(keyFile).toMatchObject({
      id: 'key_001',
      name: 'Renamed relay',
      apiKey: 'sk-test',
    });
  });

  it('migrates old profile-based config on first read', async () => {
    // Seed old-style profiles directory
    const profilesDir = path.join(TEST_MODEL_DIR, 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(
      path.join(profilesDir, 'model_001.yaml'),
      stringifyFlatYaml({
        schemaVersion: 2,
        id: 'model_001',
        name: 'Legacy Profile',
        provider: 'openai',
        apiKey: 'legacy-key',
        baseUrl: 'https://relay.example.com/v1',
        'models.0.id': 'gpt-4o-mini',
        'models.0.alias': 'GPT 4o mini',
        'models.0.apiFormat': 'openai-chat-completions',
        'models.0.capabilities': 'text',
      }),
      'utf-8',
    );

    registerConfigIpc();
    const loadCall = handle.mock.calls.find(([channel]) => channel === 'config:load-model');
    const result = (await loadCall![1]({})) as ModelConfig;

    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toMatchObject({
      id: 'model_001',
      name: 'Legacy Profile',
      protocol: 'openai-compatible',
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
    });
    expect(result.keys[0].models[0]).toMatchObject({
      id: 'gpt-4o-mini',
      capability: 'text',
      enabled: true,
    });
  });
});

// ── C3.2: task-models sidecar defensive parsing (hand-edit tolerance) ──
//
// The disk file is the ONE lenient face of the slot contract: bad entries are
// skipped, not fatal (contrast the zod save path above, which loudly rejects
// unknown slot keys). These tests seed hand-edited yaml directly and call the
// exported reader — the same function agentIpc injects as the slot resolver.
describe('readTaskModelSlots defensive parsing (C3.2)', () => {
  beforeEach(() => {
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
  });

  it('missing file → undefined (every slot auto-picks)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    expect(readTaskModelSlots()).toBeUndefined();
  });

  it('skips bad entries without failing the whole read; valid siblings survive with trim', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    // Hand-edited file covering the whole bad-entry family: an unknown slot key
    // ('multi-reader' — a retired GAP slot, never read), a blank-after-trim
    // keyId, a missing keyId line, a non-string (numeric) keyId — none of these
    // may break the one valid sibling, whose padded values must come back trimmed.
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'writer-selfcheck.keyId: "  key_001  "',
        'writer-selfcheck.modelId: "  qwen-flash  "',
        'multi-reader.keyId: key_001',
        'multi-reader.modelId: m',
        'writer-draft.keyId: "   "',
        'writer-draft.modelId: qwen-max',
        'extraction.modelId: glm-4',
        'review-judge.keyId: 42',
        'review-judge.modelId: judge-m',
      ].join('\n') + '\n',
      'utf-8',
    );

    expect(readTaskModelSlots()).toEqual({
      'writer-selfcheck': { keyId: 'key_001', modelId: 'qwen-flash' },
    });
  });

  it('all entries bad → undefined (normalized away, not an empty record)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      'reverse-outline.keyId: key_001\nreverse-outline.modelId: m\n',
      'utf-8',
    );
    expect(readTaskModelSlots()).toBeUndefined();
  });

  // ── 08-25 S3：策略键的读侧按键容错——坏值只丢该策略字段（warn），slot 的 ref 存活 ──

  it('a legacy sidecar without policy keys loads as plain refs (zero migration)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      'dialogue.keyId: key_001\ndialogue.modelId: qwen-max\n',
      'utf-8',
    );
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'qwen-max' } });
  });

  it('illegal thinking policy values drop just the field (warn); the slot ref survives', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    // Hand-edit family: a non-tier string, the request-vocabulary leak 'custom'
    // (NOT legal on slots — thinkingCustom presence means custom), a boolean
    // custom value, and an empty custom value (YAML null). None may break the
    // slot's ref or its OTHER policy field. NOTE the unquoted number 16384 is
    // NOT in the illegal family — parseFlatYaml number-coerces it and the
    // reader canonicalizes back to the schema's string form (numeric budgets
    // are legitimate; see the round-trip test).
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'dialogue.keyId: key_001',
        'dialogue.modelId: qwen-max',
        'dialogue.thinking: turbo',
        'dialogue.thinkingCustom: "8192"',
        'writer-draft.keyId: key_001',
        'writer-draft.modelId: glm-5.2',
        'writer-draft.thinking: custom',
        'review-judge.keyId: key_001',
        'review-judge.modelId: judge-m',
        'review-judge.thinking: high',
        'review-judge.thinkingCustom: 16384',
        'extraction.keyId: key_001',
        'extraction.modelId: m',
        'extraction.thinking: high',
        'extraction.thinkingCustom:',
        'dispatch.keyId: key_001',
        'dispatch.modelId: m',
        'dispatch.thinking: low',
        'dispatch.thinkingCustom: true',
      ].join('\n') + '\n',
      'utf-8',
    );

    expect(readTaskModelSlots()).toEqual({
      dialogue: { keyId: 'key_001', modelId: 'qwen-max', thinkingCustom: '8192' },
      'writer-draft': { keyId: 'key_001', modelId: 'glm-5.2' },
      'review-judge': { keyId: 'key_001', modelId: 'judge-m', thinking: 'high', thinkingCustom: '16384' },
      extraction: { keyId: 'key_001', modelId: 'm', thinking: 'high' },
      dispatch: { keyId: 'key_001', modelId: 'm', thinking: 'low' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dialogue' }),
      expect.stringContaining('illegal slot.thinking'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'writer-draft' }),
      expect.stringContaining('illegal slot.thinking'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'extraction' }),
      expect.stringContaining('illegal slot.thinkingCustom'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dispatch' }),
      expect.stringContaining('illegal slot.thinkingCustom'),
    );
  });

  it('comment-contaminated thinkingCustom drops with a warn; the sibling thinking field survives', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    // parseFlatYaml does not treat value-position `#` as a comment — both the
    // inline tail and the comment-only value arrive as string garbage and must
    // be rejected by the reader (CR-008 family).
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'dialogue.keyId: key_001',
        'dialogue.modelId: qwen-max',
        'dialogue.thinking: high',
        'dialogue.thinkingCustom: xhigh # my tier',
        'extraction.keyId: key_001',
        'extraction.modelId: m',
        'extraction.thinkingCustom: # note',
      ].join('\n') + '\n',
      'utf-8',
    );

    expect(readTaskModelSlots()).toEqual({
      dialogue: { keyId: 'key_001', modelId: 'qwen-max', thinking: 'high' },
      extraction: { keyId: 'key_001', modelId: 'm' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dialogue' }),
      expect.stringContaining('illegal slot.thinkingCustom'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'extraction' }),
      expect.stringContaining('illegal slot.thinkingCustom'),
    );
  });

  // ── CR-016（2026-08-25）：per-model 合法性第二层（registry kind → THINKING_PROFILES）──

  it('CR-016: per-model illegal policy values drop the field (warn); kindless models keep theirs', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    // glm-5.3（强制思考 offLegal=false）：'off' 丢、'low' 与 enum custom 存活；
    // gemini-3-pro（levels 恒空）：任何档位丢；glm-4.7（customHint=none）：
    // thinkingCustom 丢、档位存活；qwen-max（registry 无档案）：策略原样保留
    // ——registry 沉默不是合法性判定（协议层对未知 kind 不注入兜底）。
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'dialogue.keyId: key_001',
        'dialogue.modelId: glm-5.3',
        'dialogue.thinking: off',
        'dispatch.keyId: key_001',
        'dispatch.modelId: glm-5.3',
        'dispatch.thinking: low',
        'dispatch.thinkingCustom: max',
        'writer-draft.keyId: key_001',
        'writer-draft.modelId: gemini-3-pro',
        'writer-draft.thinking: high',
        'extraction.keyId: key_001',
        'extraction.modelId: glm-4.7',
        'extraction.thinking: high',
        'extraction.thinkingCustom: "4096"',
        'review-judge.keyId: key_001',
        'review-judge.modelId: qwen-max',
        'review-judge.thinkingCustom: "8192"',
      ].join('\n') + '\n',
      'utf-8',
    );

    expect(readTaskModelSlots()).toEqual({
      dialogue: { keyId: 'key_001', modelId: 'glm-5.3' },
      dispatch: { keyId: 'key_001', modelId: 'glm-5.3', thinking: 'low', thinkingCustom: 'max' },
      'writer-draft': { keyId: 'key_001', modelId: 'gemini-3-pro' },
      extraction: { keyId: 'key_001', modelId: 'glm-4.7', thinking: 'high' },
      'review-judge': { keyId: 'key_001', modelId: 'qwen-max', thinkingCustom: '8192' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dialogue', modelId: 'glm-5.3', value: 'off' }),
      expect.stringContaining('slot.thinking value not legal for this model'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'writer-draft', modelId: 'gemini-3-pro' }),
      expect.stringContaining('slot.thinking value not legal for this model'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'extraction', modelId: 'glm-4.7' }),
      expect.stringContaining('slot.thinkingCustom not supported by this model'),
    );
  });

  // ── 09-12 子2：fallback 链读侧防御（连续扫描 / 重复 drop / 坏行链止 / 逐条 thinking 合法性）──

  it('reads a hand-edited chain; an index gap stops the scan (contiguous 0..N, 子2)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'dialogue.keyId: key_001',
        'dialogue.modelId: qwen-max',
        'dialogue.fallbacks.0.keyId: key_002',
        'dialogue.fallbacks.0.modelId: qwen-plus',
        // index 1 deleted by hand → chain stops; index 2 is NEVER read (a gap
        // is a missing entry, not a reason to keep scanning).
        'dialogue.fallbacks.2.keyId: key_001',
        'dialogue.fallbacks.2.modelId: qwen-flash',
      ].join('\n') + '\n',
      'utf-8',
    );
    expect(readTaskModelSlots()).toEqual({
      dialogue: {
        keyId: 'key_001',
        modelId: 'qwen-max',
        fallbacks: [{ keyId: 'key_002', modelId: 'qwen-plus' }],
      },
    });
  });

  it('duplicate entries (vs the main assignment / an earlier entry) drop with a warn; later entries survive (子2)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'dialogue.keyId: key_001',
        'dialogue.modelId: qwen-max',
        'dialogue.fallbacks.0.keyId: key_001',
        'dialogue.fallbacks.0.modelId: qwen-max', // dup of the MAIN assignment
        'dialogue.fallbacks.1.keyId: key_002',
        'dialogue.fallbacks.1.modelId: qwen-plus',
        'dialogue.fallbacks.2.keyId: key_002',
        'dialogue.fallbacks.2.modelId: qwen-plus', // dup of entry 1
        'dialogue.fallbacks.3.keyId: key_003',
        'dialogue.fallbacks.3.modelId: deepseek-r1',
      ].join('\n') + '\n',
      'utf-8',
    );
    expect(readTaskModelSlots()).toEqual({
      dialogue: {
        keyId: 'key_001',
        modelId: 'qwen-max',
        fallbacks: [
          { keyId: 'key_002', modelId: 'qwen-plus' },
          { keyId: 'key_003', modelId: 'deepseek-r1' },
        ],
      },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dialogue', entry: 0 }),
      expect.stringContaining('duplicate fallback entry'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dialogue', entry: 2 }),
      expect.stringContaining('duplicate fallback entry'),
    );
  });

  it('a comment-contaminated entry stops the chain (warn); the slot ref and earlier entries survive (子2)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'extraction.keyId: key_001',
        'extraction.modelId: qwen-max',
        'extraction.fallbacks.0.keyId: key_002',
        'extraction.fallbacks.0.modelId: qwen-plus',
        'extraction.fallbacks.1.keyId: key_003 # 备用',
        'extraction.fallbacks.1.modelId: deepseek-r1',
        'extraction.fallbacks.2.keyId: key_004',
        'extraction.fallbacks.2.modelId: glm-5.3',
      ].join('\n') + '\n',
      'utf-8',
    );
    expect(readTaskModelSlots()).toEqual({
      extraction: {
        keyId: 'key_001',
        modelId: 'qwen-max',
        fallbacks: [{ keyId: 'key_002', modelId: 'qwen-plus' }],
      },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'extraction', entry: 1 }),
      expect.stringContaining('trailing comment'),
    );
  });

  it('per-entry thinking legality is judged against EACH entry model — off on a forced kind drops; kindless keeps (子2)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    // Entry 0 targets glm-5.3 (forced thinking, offLegal=false) with 'off' →
    // dropped with a per-entry warn; entry 1 targets a kindless model and keeps
    // its policy (registry silence is not a legality verdict, CR-016).
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'dialogue.keyId: key_001',
        'dialogue.modelId: qwen-max',
        'dialogue.fallbacks.0.keyId: key_002',
        'dialogue.fallbacks.0.modelId: glm-5.3',
        'dialogue.fallbacks.0.thinking: off',
        'dialogue.fallbacks.1.keyId: key_003',
        'dialogue.fallbacks.1.modelId: qwen-plus',
        'dialogue.fallbacks.1.thinking: low',
      ].join('\n') + '\n',
      'utf-8',
    );
    expect(readTaskModelSlots()).toEqual({
      dialogue: {
        keyId: 'key_001',
        modelId: 'qwen-max',
        fallbacks: [
          { keyId: 'key_002', modelId: 'glm-5.3' },
          { keyId: 'key_003', modelId: 'qwen-plus', thinking: 'low' },
        ],
      },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dialogue', entry: 0, modelId: 'glm-5.3', value: 'off' }),
      expect.stringContaining('not legal for this model'),
    );
  });

  it('fallback keys under a slot with no valid main assignment are never read (the chain hangs off the assignment, 子2)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'task-models.yaml'),
      [
        'dialogue.keyId: "   "', // blank-after-trim → slot skipped entirely
        'dialogue.modelId: qwen-max',
        'dialogue.fallbacks.0.keyId: key_002',
        'dialogue.fallbacks.0.modelId: qwen-plus',
      ].join('\n') + '\n',
      'utf-8',
    );
    expect(readTaskModelSlots()).toBeUndefined();
  });

  it('an unreadable sidecar (name occupied by a directory) → undefined, never throws', () => {
    mkdirSync(path.join(TEST_MODEL_DIR, 'task-models.yaml'), { recursive: true });
    expect(readTaskModelSlots()).toBeUndefined();
  });
});

// ── C3.2 CR-004/CR-005/CR-008: sidecar mtime cache + failure logging + comment tolerance ──
//
// The reader backs the agentIpc slot resolver (hot path: 12+ resolves per chain
// assembly, up to ~50 per dialogue turn), so it stat()-gates the read. These
// tests pin the semantics — fresh query (a change becomes visible), cached
// misses (no per-call warn spam), hand-edit comment tolerance, and the
// write-path rmSync guard — using utimesSync for deterministic stat keys
// (consecutive same-length writes can collide on mtimeMs alone).
describe('readTaskModelSlots mtime cache + logging (CR-004/CR-005/CR-008)', () => {
  const SIDECAR = () => path.join(TEST_MODEL_DIR, 'task-models.yaml');

  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
  });

  it('same mtime+size → cached record served; changed mtime → re-read (fresh-query semantics held)', () => {
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: model-one\n', 'utf8');
    const fixed = new Date(1_700_000_000_000);
    utimesSync(SIDECAR(), fixed, fixed);
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'model-one' } });

    // Same-length rewrite pinned to the SAME stat → the gate holds the cached
    // record (that staleness is itself the proof no disk re-read happened).
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: model-two\n', 'utf8');
    utimesSync(SIDECAR(), fixed, fixed);
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'model-one' } });

    // mtime bump → the rewrite becomes visible (a slot change takes effect immediately).
    const bumped = new Date(1_700_000_001_000);
    utimesSync(SIDECAR(), bumped, bumped);
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'model-two' } });
  });

  it('removing the sidecar invalidates the cache (cleared back to Auto → undefined)', () => {
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: m\n', 'utf8');
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'm' } });
    rmSync(SIDECAR(), { force: true });
    expect(readTaskModelSlots()).toBeUndefined();
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: m2\n', 'utf8');
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'm2' } });
  });

  it('save → read sees the new designation immediately (write path never serves a stale cache)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    const t0 = new Date(1_700_000_000_000);
    const t1 = new Date(1_700_000_001_000);
    // Consecutive same-length saves can collide on mtimeMs granularity — pin
    // distinct stat keys so the cache-invalidation correctness is deterministic.
    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'qwen-max' } } } satisfies ModelConfig,
    );
    utimesSync(SIDECAR(), t0, t0);
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'qwen-max' } });

    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'qwen-min' } } } satisfies ModelConfig,
    );
    utimesSync(SIDECAR(), t1, t1);
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'qwen-min' } });
  });

  it('an unreadable sidecar warns once per file change, not per call (CR-005)', () => {
    // Name occupied by a directory → statSync succeeds, readFileSync throws.
    mkdirSync(SIDECAR(), { recursive: true });
    expect(readTaskModelSlots()).toBeUndefined();
    expect(readTaskModelSlots()).toBeUndefined();
    // First call refreshed (warned); the cached miss serves the second silently.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('task-models sidecar read failed'));
  });

  it('a comment-contaminated entry is skipped with a warn; valid siblings survive (CR-008)', () => {
    writeFileSync(
      SIDECAR(),
      [
        'dialogue.keyId: key_001 # 主力中转',
        'dialogue.modelId: qwen-max',
        'extraction.keyId: key_001',
        'extraction.modelId: glm-4-flash',
      ].join('\n') + '\n',
      'utf8',
    );

    expect(readTaskModelSlots()).toEqual({ extraction: { keyId: 'key_001', modelId: 'glm-4-flash' } });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'dialogue' }),
      expect.stringContaining('trailing comment'),
    );
  });

  it('a failed sidecar removal during a clearing save warns but never blocks config:save-model (CR-005)', async () => {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    // Seed the sidecar so the clearing save takes the rmSync branch.
    await saveCall![1](
      {},
      { ...SAMPLE_CONFIG, taskModels: { dialogue: { keyId: 'key_001', modelId: 'm' } } } satisfies ModelConfig,
    );
    rmFailArmed.armed = true; // next task-models.yaml removal throws exactly once

    // Clearing save (no taskModels) must resolve despite the failed removal.
    await expect(saveCall![1]({}, SAMPLE_CONFIG)).resolves.toBeUndefined();
    expect(rmFailArmed.armed).toBe(false); // the armed throw was actually consumed
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('task-models sidecar removal failed'),
    );
  });
});

// ── CR-01 (AC7): embedding-model change → reindexAll wiring ──
describe('embeddingModelChanged (pure predicate, CR-01)', () => {
  it('both absent → false (no change)', () => {
    expect(embeddingModelChanged(undefined, undefined)).toBe(false);
    expect(embeddingModelChanged(null, undefined)).toBe(false);
  });

  it('one absent → true (designation added or removed)', () => {
    const ref = { keyId: 'k1', modelId: 'm1' };
    expect(embeddingModelChanged(undefined, ref)).toBe(true);
    expect(embeddingModelChanged(ref, undefined)).toBe(true);
    expect(embeddingModelChanged(ref, null)).toBe(true);
  });

  it('same keyId + modelId → false', () => {
    expect(embeddingModelChanged({ keyId: 'k1', modelId: 'm1' }, { keyId: 'k1', modelId: 'm1' })).toBe(false);
  });

  it('different keyId OR modelId → true', () => {
    expect(embeddingModelChanged({ keyId: 'k1', modelId: 'm1' }, { keyId: 'k2', modelId: 'm1' })).toBe(true);
    expect(embeddingModelChanged({ keyId: 'k1', modelId: 'm1' }, { keyId: 'k1', modelId: 'm2' })).toBe(true);
  });
});

describe('reindexAllForChangedModel (CR-01 wiring)', () => {
  beforeEach(() => {
    // CR-T2-003：craft 分档断言（跳过/照跑）对共享 reindexAllCraft mock 敏感——上一
    // describe 的 fire-and-forget 扫会把调用累计进来（mirror 'model config IPC'
    // describe 的同款 reset 注释）。reindexAssetCards 补 resolved 默认值（root 只 reset）。
    reindexAllCraft.mockReset();
    reindexAllCraft.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });
    reindexAssetCards.mockResolvedValue({ reindexed: 0, orphaned: 0 });
  });

  it('calls reindexAll once per distinct REGISTERED project_id; ghost rows purged (CR-T2-003)', async () => {
    getDb.mockReturnValue({
      prepare: (sql: string) => ({
        all: () =>
          sql.includes('DISTINCT project_id')
            ? [{ project_id: 'p0' }, { project_id: 'p1' }, { project_id: 'p2' }, { project_id: 'p3' }]
            : [],
        get: () => ({ n: 0 }),
        run: () => ({ changes: 4 }),
      }),
      // better-sqlite3 语义：transaction(fn) 返回包装函数，调用它才执行（源码是
      // `db.transaction(...)()`）。
      transaction: (fn: () => unknown) => () => fn(),
    });
    reindexAll.mockResolvedValue({ reindexed: 5, dimChanged: false, newDim: 1024 });
    // p0 查无注册 path（已注销项目）→ 幽灵行清除；其余三项目正常重嵌。
    getProjectById.mockImplementation((id: string) => (id === 'p0' ? undefined : { path: `/projects/${id}` }));

    await reindexAllForChangedModel();

    expect(reindexAll).toHaveBeenCalledTimes(3);
    // dogfood #39 (T2 C1): default force=true (save-model trigger = authorized
    // model migration — full re-embed semantics unchanged).
    expect(reindexAll).toHaveBeenCalledWith('p1', { force: true });
    expect(reindexAll).toHaveBeenCalledWith('p2', { force: true });
    expect(reindexAll).toHaveBeenCalledWith('p3', { force: true });
    // CR-T2-003②：幽灵行清除留痕（其 pending 计入全局 degraded 判定，不清则 reconcile
    // 每次启动空转永不收敛）。
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p0', purged: 4 }),
      'closure reindexAll: ghost project rows purged (no registry entry) - continuing',
    );
    // Story 2.1: the craft KB reindex is also triggered (shares the embedding model;
    // configuredModelId 未传 → 保守跑 mirror 旧行为).
    expect(reindexAllCraft).toHaveBeenCalledTimes(1);
  });

  it('no closure_entry rows → reindexAll not called', async () => {
    getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });

    await reindexAllForChangedModel();

    expect(reindexAll).not.toHaveBeenCalled();
  });

  it('Story 2.7 GAP2: reindexes asset_cards per project when a registry path resolves (force=true)', async () => {
    getDb.mockReturnValue({
      prepare: () => ({ all: () => [{ project_id: 'p1' }, { project_id: 'p2' }] }),
    });
    reindexAll.mockResolvedValue({ reindexed: 5, dimChanged: false, newDim: 1024 });
    // p1 has a registered path; p2 does not (unregistered → asset_cards skipped).
    getProjectById.mockImplementation((id: string) =>
      id === 'p1' ? { path: '/projects/p1' } : undefined,
    );
    reindexAssetCards.mockResolvedValue({ reindexed: 3, orphaned: 0 });

    await reindexAllForChangedModel();

    // asset_cards reindexed only for the registered project, with force=true so the
    // content-hash skip is bypassed (vectors regenerate under the new model).
    expect(reindexAssetCards).toHaveBeenCalledTimes(1);
    expect(reindexAssetCards).toHaveBeenCalledWith('/projects/p1', { force: true });
  });

  it('Story 2.7 GAP2: an asset_cards reindex failure is logged and the sweep continues', async () => {
    getDb.mockReturnValue({
      prepare: () => ({ all: () => [{ project_id: 'p1' }] }),
    });
    reindexAll.mockResolvedValue({ reindexed: 1, dimChanged: false, newDim: 1024 });
    getProjectById.mockReturnValue({ path: '/projects/p1' });
    reindexAssetCards.mockRejectedValue(new Error('card embed down'));

    await expect(reindexAllForChangedModel()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1' }),
      'asset_cards reindex: failed after embedding-model change - continuing',
    );
  });

  // dogfood #39（T2 C1）：扫的恢复面补齐章源——entry_vec 的 dim 重建是全库事件（DROP 时
  // E1 迁移清 content_hash → 章源行 pending），reindexAll 只重嵌 project_assets，不补章源
  // 则扫后索引永远 stale（启动 reconcile 的 stale 判定会每次启动重扫、永不收敛）。
  it('dogfood #39: sweep 恢复面含章源（chunk force 随扫 + 摘要逐 episode 非 force）', async () => {
    getDb.mockReturnValue({
      prepare: () => ({ all: () => [{ project_id: 'p1' }] }),
    });
    reindexAll.mockResolvedValue({ reindexed: 1, dimChanged: false, newDim: 1024 });
    getProjectById.mockReturnValue({ path: '/projects/p1' });
    listChapterSummaries.mockReturnValue([{ episodeId: 'ep-1' }, { episodeId: 'ep-2' }]);

    await reindexAllForChangedModel();

    expect(rebuildChapterChunks).toHaveBeenCalledTimes(1);
    expect(rebuildChapterChunks).toHaveBeenCalledWith('p1', '/projects/p1', { force: true });
    expect(listChapterSummaries).toHaveBeenCalledWith('p1');
    expect(reindexChapterSummaryEntry).toHaveBeenCalledTimes(2);
    expect(reindexChapterSummaryEntry).toHaveBeenCalledWith('p1', '/projects/p1', 'ep-1');
  });

  it('dogfood #39: force=false（启动 reconcile 的仅积压形态）全链透传——健康行 hash-skip 只重试待补', async () => {
    getDb.mockReturnValue({
      prepare: () => ({ all: () => [{ project_id: 'p1' }] }),
    });
    reindexAll.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: 1024 });
    getProjectById.mockReturnValue({ path: '/projects/p1' });

    await reindexAllForChangedModel({ force: false });

    expect(reindexAll).toHaveBeenCalledWith('p1', { force: false });
    expect(reindexAssetCards).toHaveBeenCalledWith('/projects/p1', { force: false });
    expect(reindexAllSettingMd).toHaveBeenCalledWith('/projects/p1', { force: false });
    expect(rebuildChapterChunks).toHaveBeenCalledWith('p1', '/projects/p1', { force: false });
  });

  it('a per-project failure is logged and the loop continues (best-effort)', async () => {
    getDb.mockReturnValue({
      prepare: () => ({ all: () => [{ project_id: 'p1' }, { project_id: 'p2' }] }),
    });
    reindexAll.mockRejectedValueOnce(new Error('p1 embed down')).mockResolvedValueOnce({ reindexed: 2, dimChanged: false, newDim: 1024 });
    // CR-T2-003：projectPath 需可解析（幽灵项目现在被清除而非照跑 reindexAll）。
    getProjectById.mockReturnValue({ path: '/projects/p1' });

    await reindexAllForChangedModel();

    // p1 failed but p2 still ran — never abort the loop.
    expect(reindexAll).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1' }),
      'closure reindexAll: per-project reindex failed - continuing',
    );
  });

  // ── CR-T2-003①（2026-08-25）：craft 侧同谓词分档——真 degraded 才跑 reindexAllCraft ──

  it('CR-T2-003: configuredModelId 提供且 craft 库健康 → reindexAllCraft 跳过（不再每次启动全量重嵌）', async () => {
    getDb.mockReturnValue({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM closure_craft_entry') ? [{ model: 'embed-m' }] : []),
        get: () => ({ n: 0 }), // craft pending = 0
      }),
    });
    reindexAll.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });

    await reindexAllForChangedModel({ force: false, configuredModelId: 'embed-m' });

    expect(reindexAllCraft).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      'craft reindexAllCraft: skipped - craft vector index healthy (CR-T2-003 tiering)',
    );
  });

  it('CR-T2-003: craft 库真降级（存量模型 ≠ 配置）→ reindexAllCraft 照跑（授权迁移）', async () => {
    getDb.mockReturnValue({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM closure_craft_entry') ? [{ model: 'embed-old' }] : []),
        get: () => ({ n: 0 }),
      }),
    });
    reindexAll.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });

    await reindexAllForChangedModel({ configuredModelId: 'embed-new' });

    expect(reindexAllCraft).toHaveBeenCalledTimes(1);
  });

  it('CR-T2-003: craft pending 积压 → degraded → 照跑（pending 是必要信号）', async () => {
    getDb.mockReturnValue({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM closure_craft_entry') ? [{ model: 'embed-m' }] : []),
        get: () => ({ n: 3 }),
      }),
    });
    reindexAll.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });

    await reindexAllForChangedModel({ force: false, configuredModelId: 'embed-m' });

    expect(reindexAllCraft).toHaveBeenCalledTimes(1);
  });

  it('CR-T2-003: configuredModelId=null（designation 清空）→ craft 跳过（未配置 ≠ 降级）', async () => {
    getDb.mockReturnValue({
      prepare: (sql: string) => ({
        all: () => [],
        get: () => ({ n: 3 }),
      }),
    });

    await reindexAllForChangedModel({ configuredModelId: null });

    expect(reindexAllCraft).not.toHaveBeenCalled();
  });

  // ── CR-T2-013（2026-08-25）：摘要枚举抛错不得逃出循环（单项目失败不中止）──

  it('CR-T2-013: listChapterSummaries 枚举抛错 → 只弃该项目摘要面，后续项目与 craft 照常', async () => {
    getDb.mockReturnValue({ prepare: () => ({ all: () => [{ project_id: 'p1' }, { project_id: 'p2' }] }) });
    getProjectById.mockReturnValue({ path: '/projects/p' });
    reindexAll.mockResolvedValue({ reindexed: 1, dimChanged: false, newDim: null });
    reindexAssetCards.mockResolvedValue({ reindexed: 0, orphaned: 0 });
    listChapterSummaries.mockImplementation((id: string) => {
      if (id === 'p1') throw new Error('db closed');
      return [{ episodeId: 'ep-1' }];
    });

    await reindexAllForChangedModel();

    // p2 的五源扫不被 p1 的摘要枚举失败拖死。
    expect(reindexAll).toHaveBeenCalledTimes(2);
    expect(reindexChapterSummaryEntry).toHaveBeenCalledTimes(1);
    expect(reindexChapterSummaryEntry).toHaveBeenCalledWith('p2', '/projects/p', 'ep-1');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1' }),
      'chapter_summary reindex: cannot enumerate summaries - continuing with next project',
    );
    // craft 侧也不被拖死。
    expect(reindexAllCraft).toHaveBeenCalledTimes(1);
  });

  it('getDb throws (no derived tables yet) → swallows, never rejects', async () => {
    getDb.mockImplementation(() => {
      throw new Error('no such table: closure_entry');
    });

    await expect(reindexAllForChangedModel()).resolves.toBeUndefined();
    expect(reindexAll).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('config:save-model → reindexAll fire-and-forget (CR-01/AC7)', () => {
  // Helper: pull the registered config:save-model handler off the ipcMain mock.
  async function saveHandler(config: ModelConfig): Promise<unknown> {
    registerConfigIpc();
    const saveCall = handle.mock.calls.find(([channel]) => channel === 'config:save-model');
    return saveCall![1]({}, config);
  }

  beforeEach(() => {
    // Fresh dir each test so `before.embeddingModel` is a known baseline
    // (undefined). Otherwise the embeddingModel sidecar written by one test
    // bleeds into the next test's `before` and flips the changed/unchanged
    // assertion. Also reset the ipcMain handle mock so registerConfigIpc()
    // re-registers cleanly.
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    handle.mockReset();
    // Default: two projects with derived rows, reindexAll resolves cleanly.
    getDb.mockReturnValue({
      prepare: () => ({ all: () => [{ project_id: 'p1' }, { project_id: 'p2' }] }),
    });
    // CR-T2-003：注册 path（幽灵项目现在被清除而非照跑 reindexAll——本 describe 测的是
    // save-model 触发链路，不是幽灵清理）。
    getProjectById.mockReturnValue({ path: '/projects/p' });
    reindexAll.mockResolvedValue({ reindexed: 1, dimChanged: false, newDim: 1024 });
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
  });

  it('embeddingModel added → fires reindexAll for each project (after the IPC returns)', async () => {
    // Fresh dir → before.embeddingModel is undefined; save designates one.
    await saveHandler({ ...SAMPLE_CONFIG, embeddingModel: { keyId: 'key_001', modelId: 'text-embedding-3-small' } } satisfies ModelConfig);

    // Fire-and-forget: the handler returned without awaiting. Flush the
    // background microtask chain, then assert reindexAll ran per project.
    await vi.waitFor(() => {
      expect(reindexAll).toHaveBeenCalledTimes(2);
    });
    expect(reindexAll).toHaveBeenCalledWith('p1', { force: true });
    expect(reindexAll).toHaveBeenCalledWith('p2', { force: true });
  });

  it('embeddingModel UNCHANGED (none before, none after) → reindexAll NOT called', async () => {
    await saveHandler(SAMPLE_CONFIG); // no embeddingModel either side

    // Give the fire-and-forget path a chance to run (it shouldn't fire at all).
    await new Promise((resolve) => setImmediate(resolve));
    expect(reindexAll).not.toHaveBeenCalled();
  });

  it('config save returns immediately (does NOT await the slow reindex)', async () => {
    // Single project so the background sweep has exactly one reindexAll to drain.
    getDb.mockReturnValue({ prepare: () => ({ all: () => [{ project_id: 'p1' }] }) });
    // A slow-but-completing reindex: if the handler awaited it, the save would
    // only resolve after the reindex. Record when the reindex actually finishes
    // and assert the save returned BEFORE that — the true fire-and-forget
    // invariant. (A fixed `elapsed < 50ms` bound flakes under turbo parallel
    // load where the save itself legitimately takes tens of ms.)
    let reindexDoneAt = 0;
    reindexAll.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      reindexDoneAt = Date.now();
      return { reindexed: 1, dimChanged: false, newDim: 1024 };
    });

    const start = Date.now();
    await saveHandler({ ...SAMPLE_CONFIG, embeddingModel: { keyId: 'key_001', modelId: 'm-new' } } satisfies ModelConfig);
    const saveResolvedAt = Date.now();

    expect(reindexAll).toHaveBeenCalledWith('p1', { force: true });
    // Drain the background so its promise does not linger into the next test.
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1' }),
        'closure reindexAll: done (embedding model changed)',
      ),
    );

    // True fire-and-forget invariant, load-independent: the save resolved
    // BEFORE the (100ms-sleeping) reindex finished — the handler didn't await it.
    expect(saveResolvedAt - start).toBeLessThan(reindexDoneAt - start);
  });

  it('reindexAll rejects → save still succeeds, no unhandled rejection', async () => {
    reindexAll.mockRejectedValue(new Error('embed endpoint down'));

    await expect(
      saveHandler({ ...SAMPLE_CONFIG, embeddingModel: { keyId: 'key_001', modelId: 'm-new' } } satisfies ModelConfig),
    ).resolves.toBeUndefined();

    // The trailing .catch swallowed the rejection (warn logged).
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
  });

  // ── CR-T2-005（2026-08-25）：save-model 触发扫与在途扫互斥 ──

  it('CR-T2-005: sweep 在途时 save-model 不再触发第二路扫（跳过 + warn，下次启动 reconcile 兜底）', async () => {
    let releaseSweep!: () => void;
    const gated = runWithEmbeddingSweepGate(
      () => new Promise<void>((resolve) => { releaseSweep = resolve; }),
    );
    expect(isEmbeddingSweepInflight()).toBe(true);

    await saveHandler({ ...SAMPLE_CONFIG, embeddingModel: { keyId: 'key_001', modelId: 'm-x' } } satisfies ModelConfig);
    await new Promise((resolve) => setImmediate(resolve));

    // 并发重嵌竞争 entry_vec DROP/重建——第二路扫被跳过（defer 到下次启动 reconcile）。
    expect(reindexAll).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'closure reindexAll: sweep already in flight - deferring model-swap rebuild to next launch reconcile',
    );

    releaseSweep();
    await gated;
    expect(isEmbeddingSweepInflight()).toBe(false);
  });

  it('CR-T2-005: save-model 自身触发的扫也置闸（扫在途时手动重建/status 可见）', async () => {
    // 单项目：mock 的一发 pending promise 只被调用一次（两项目会让 resolver 被覆盖）。
    getDb.mockReturnValue({ prepare: () => ({ all: () => [{ project_id: 'p1' }] }) });
    let releaseSweep!: () => void;
    reindexAll.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseSweep = resolve; });
      return { reindexed: 1, dimChanged: false, newDim: 1024 };
    });

    await saveHandler({ ...SAMPLE_CONFIG, embeddingModel: { keyId: 'key_001', modelId: 'm-y' } } satisfies ModelConfig);
    await vi.waitFor(() => expect(reindexAll).toHaveBeenCalledTimes(1));
    // 扫全程在途（fire-and-forget 未完）。
    expect(isEmbeddingSweepInflight()).toBe(true);

    releaseSweep();
    await vi.waitFor(() => expect(isEmbeddingSweepInflight()).toBe(false));
  });
});
