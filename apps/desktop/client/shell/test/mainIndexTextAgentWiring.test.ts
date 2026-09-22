import { describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 09-19 CLI 白名单 CR-8：main/index.ts whenReady 装配序列——文本 Agent 启动对账调用
// 在位钉死（mirror registryInitFailure.test.ts 的 import '../main/index' 先例）。
//
// 病根面：`reconcileTextAgentAtStartupProduction()` 调用块若被删除（重构/合并冲突），
// 「每次启动版本对账」的 α 生命周期承诺静默失效——陈旧/缺失文件不再被启动补写，用户
// 面零信号且零测试红。本套直跑 whenReady 全序列（whenReady 立即 resolve）——除被断言
// 的两点外全部装配面 mock 成 spy（不触 db/native/fs/网络），断言启动对账恰被调用一次
// + registerAllIpc 的注册行同在。删调用块 → spy 零调用 → 红。
// ─────────────────────────────────────────────────────────────────────────────

const { reconcileSpy, registerTextAgentIpcSpy } = vi.hoisted(() => {
  // wireAgentPromptsDir 打包态候选取 process.resourcesPath——plain Node 无此全局，
  // 不设则 path.join(undefined) 抛（本套跑真 registerAllIpc，该分支非 mock 面）。
  (process as unknown as { resourcesPath?: string }).resourcesPath = process.cwd();
  return { reconcileSpy: vi.fn(), registerTextAgentIpcSpy: vi.fn() };
});

// 基础面（mirror registryInitFailure：打包态跳过 CDP 块 + db/updater 隔离）。
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    // 立即 resolve：whenReady 装配序列真跑（本套的断言对象就在序列里）。
    whenReady: () => Promise.resolve(),
    getVersion: () => '0.0.0-test',
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    on: vi.fn(),
    exit: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  },
  BrowserWindow: class {
    webContents = {
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
    };
    on = vi.fn();
    once = vi.fn();
    maximize = vi.fn();
    loadFile = vi.fn();
    loadURL = vi.fn();
  },
  dialog: { showErrorBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  protocol: { handle: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

vi.mock('electron-updater', () => ({ default: {} }));
vi.mock('../main/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), fatal: vi.fn(), error: vi.fn() }),
  getLogsDirPath: () => process.cwd(),
  installGlobalErrorHandlers: vi.fn(),
}));
vi.mock('../main/db', () => ({ getDb: vi.fn(() => ({})), closeDb: vi.fn() }));
vi.mock('../main/windowState', () => ({ loadWindowState: () => null, trackWindowState: vi.fn() }));
vi.mock('../main/orisonFileProtocol', () => ({ fetchOrisonFile: vi.fn() }));

// ── whenReady 序列的装配面全量 spy（唯一真身 = 本套断言的两点）──
vi.mock('../main/ipc/agyTextAgentIpc', () => ({
  reconcileTextAgentAtStartupProduction: reconcileSpy,
  registerAgyTextAgentIpc: registerTextAgentIpcSpy,
}));
vi.mock('../main/ipc/projectIpc', () => ({ registerProjectIpc: vi.fn() }));
vi.mock('../main/ipc/pathGuard', () => ({ initProjectsRoot: vi.fn() }));
vi.mock('../main/ipc/windowIpc', () => ({ registerWindowIpc: vi.fn() }));
vi.mock('../main/ipc/configIpc', () => ({
  registerConfigIpc: vi.fn(),
  readUserPreferencesFromDisk: () => ({}),
  applyResearchProxyFromDisk: vi.fn(),
}));
vi.mock('../main/ipc/fieldSyncIpc', () => ({ registerFieldSyncIpc: vi.fn() }));
vi.mock('../main/ipc/toolNotify', () => ({ notifyUI: vi.fn() }));
vi.mock('@orison/desktop-local-bff', () => ({ subscribeProjectSaved: vi.fn() }));
vi.mock('../main/ipc/modelProviderIpc', () => ({ registerModelProviderIpc: vi.fn() }));
vi.mock('../main/ipc/modelCliDiscoveryIpc', () => ({ registerModelCliDiscoveryIpc: vi.fn() }));
vi.mock('../main/ipc/modelCliProbeIpc', () => ({
  registerModelCliProbeIpc: vi.fn(),
  probeConfiguredCliKeysOnStartup: vi.fn(async () => {}),
}));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  registerModelGatewayIpc: vi.fn(),
  wasAntigravityCliUsed: () => false,
}));
vi.mock('../main/ipc/agyBridge', () => ({
  installShellAgyBridgeCore: vi.fn(() => ({ activeSessions: () => [] })),
  setProductionAgyBridgeRuntime: vi.fn(),
  sweepStaleBridgeHomes: vi.fn(async () => {}),
  defaultAgyBridgeHomeRoot: () => process.cwd(),
  getProductionAgyBridgeRegistry: () => undefined,
}));
vi.mock('../main/fs/agyTempSweep', () => ({ sweepStaleAgyTempSessionDirs: vi.fn() }));
vi.mock('../main/ipc/agyBridgeIpc', () => ({ registerAgyBridgeIpc: vi.fn(), wasAgyBridgeUsed: () => false }));
vi.mock('../main/ipc/usageIpc', () => ({ installUsageMeteringProduction: vi.fn(), installBudgetGateProduction: vi.fn(), registerUsageIpc: vi.fn() }));
vi.mock('../main/db/llmUsageLedgerRepository', () => ({ pruneExpiredLedger: () => 0 }));
vi.mock('../main/ipc/storySyncIpc', () => ({ registerStorySyncIpc: vi.fn() }));
vi.mock('../main/ipc/taskIpc', () => ({ registerTaskIpc: vi.fn() }));
vi.mock('../main/ipc/assetIpc', () => ({ registerAssetIpc: vi.fn() }));
vi.mock('../main/ipc/logIpc', () => ({ registerLogIpc: vi.fn() }));
vi.mock('../main/ipc/updateIpc', () => ({ registerUpdateIpc: vi.fn(), checkForUpdateOnStartup: vi.fn() }));
vi.mock('../main/ipc/gitIpc', () => ({ registerGitIpc: vi.fn() }));
vi.mock('../main/ipc/agentIpc', () => ({ registerAgentIpc: vi.fn() }));
vi.mock('../main/ipc/closureCraftIpc', () => ({ registerClosureCraftIpc: vi.fn() }));
vi.mock('../main/ipc/closureIndexIpc', () => ({ registerClosureIndexIpc: vi.fn() }));
vi.mock('../main/ipc/closureChainIpc', () => ({ registerClosureChainIpc: vi.fn() }));
vi.mock('../main/ipc/settingMdIpc', () => ({ registerSettingMdIpc: vi.fn() }));
vi.mock('../main/ipc/authorProfileIpc', () => ({ registerAuthorProfileIpc: vi.fn() }));
vi.mock('../main/ipc/researchConfigIpc', () => ({ registerResearchConfigIpc: vi.fn() }));
vi.mock('../main/ipc/lintIpc', () => ({ registerLintIpc: vi.fn() }));
vi.mock('../main/ipc/worldIpc', () => ({ registerWorldIpc: vi.fn() }));
vi.mock('../main/ipc/toolHandlers/parseDocumentHandlers', () => ({ registerInboxAttachmentIpc: vi.fn() }));
vi.mock('../main/ipc/materialIpc', () => ({ registerMaterialIpc: vi.fn() }));
vi.mock('../main/ipc/toolHandlers/materialLLMCore', () => ({ installMaterialLLMCoreProduction: vi.fn() }));
vi.mock('../main/ipc/toolHandlers/craftDistillLlmCore', () => ({ installCraftDistillLlmCoreProduction: vi.fn() }));
vi.mock('../main/decon/deconLlmCore', () => ({ installDeconLlmCoreProduction: vi.fn() }));
vi.mock('../main/decon/deconJob', () => ({ reconcileStaleDeconJobsOnStartup: () => 0 }));
vi.mock('../main/db/closureCraftDistillRepository', () => ({ closeStaleRunningDistills: () => 0 }));
vi.mock('../main/ipc/craftIpc', () => ({ registerCraftIpc: vi.fn() }));
vi.mock('../main/ipc/deconIpc', () => ({ registerDeconIpc: vi.fn() }));
vi.mock('../main/db/materialIndexer', () => ({ backfillGlobalMaterials: vi.fn(async () => {}) }));
vi.mock('../main/db/materialWatcher', () => ({
  startGlobalMaterialWatcher: vi.fn(),
  stopGlobalMaterialWatcher: vi.fn(),
  stopProjectMaterialWatcher: vi.fn(),
}));
vi.mock('../main/db/closureCraftIndexer', () => ({ scanAndReindexCraftKb: vi.fn(async () => {}) }));
vi.mock('../main/db/embeddingIndexReconcile', () => ({ reconcileEmbeddingIndexOnStartup: vi.fn(async () => {}) }));
vi.mock('../main/db/craftKbWatcher', () => ({ startCraftKbWatcher: vi.fn(), stopCraftKbWatcher: vi.fn() }));
vi.mock('../main/db/assetCardsWatcher', () => ({ stopAssetCardsWatcher: vi.fn() }));
vi.mock('../main/db/settingMdWatcher', () => ({ stopSettingMdWatcher: vi.fn() }));
vi.mock('../main/db/chapterChunkWatcher', () => ({ stopChapterChunkWatcher: vi.fn() }));

// 触发 whenReady 装配序列（import 即注册 .then 回调——promise 立刻 resolve）。
import '../main/index';

describe('main/index whenReady 装配序列——文本 Agent 启动对账接线（CR-8）', () => {
  it('启动对账在装配序列在位（删调用块 → 零调用 → 红）', async () => {
    await vi.waitFor(() => {
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });
    // registerAllIpc 的注册行同批钉死（删注册行 → 三通道不可达）。
    expect(registerTextAgentIpcSpy).toHaveBeenCalledTimes(1);
  });
});
