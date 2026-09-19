import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { setPromptsBaseDir } from '@orison/desktop-agent';
import { INTERFACE_SCALE_DEFAULT, clampUsageRetentionDays } from '@orison/shared-contracts';
import { getLogger, getLogsDirPath, installGlobalErrorHandlers } from './logger';
import { registerProjectIpc } from './ipc/projectIpc';
import { initProjectsRoot } from './ipc/pathGuard';
import { loadWindowState, trackWindowState } from './windowState';
import { registerWindowIpc } from './ipc/windowIpc';
import { registerConfigIpc, readUserPreferencesFromDisk, applyResearchProxyFromDisk } from './ipc/configIpc';
import { registerFieldSyncIpc } from './ipc/fieldSyncIpc';
import { notifyUI } from './ipc/toolNotify';
import { subscribeProjectSaved } from '@orison/desktop-local-bff';
import { registerModelProviderIpc } from './ipc/modelProviderIpc';
// 09-12 agy provider W4：CLI 形态（agy）模型发现端点（spawn `agy models` TSV 解析，
// 独立于 modelProviderIpc 的 HTTP 发现路径）。
import { registerModelCliDiscoveryIpc } from './ipc/modelCliDiscoveryIpc';
// 09-12 agy provider W4：app 退出时关停 CLI 驱动器单例会话池（长驻 agy 进程 + 清扫
// 定时器不得活过 app 生命周期）。CR-15（09-12 agy provider CR 批）shell 半：
// wasAntigravityCliUsed 据此决定 quit 是否给 CLI 池的异步优雅关停留有界等待窗口。
import { disposeAntigravityCliDriver, disposeAgyBridgeRuntime } from '@orison/model-protocols';
import { wasAntigravityCliUsed } from './ipc/modelGatewayIpc';
import { registerModelGatewayIpc } from './ipc/modelGatewayIpc';
// 子4 agy MCP 工具桥（09-12-agy-mcp-tool-bridge W4）：桥内核装配（假宿四件套 + 管道注册
// 表注入 model-protocols bridgeTurn）+ 启动清扫守卫 + 同意/状态三通道 + 退出关停。
import {
  defaultAgyBridgeHomeRoot,
  getProductionAgyBridgeRegistry,
  installShellAgyBridgeCore,
  setProductionAgyBridgeRuntime,
  sweepStaleBridgeHomes,
} from './ipc/agyBridge';
// W5 R9（design D6）+ CR-6 加固批：os.tmpdir()/agy-* 启动清扫（实现与判定谓词在
// main/fs/agyTempSweep.ts——名形精确匹配 mkdtemp('agy-') 产物、非目录条目跳过、
// 陈旧判据取目录 + 直接子项最大 mtime）。
import { sweepStaleAgyTempSessionDirs } from './fs/agyTempSweep';
import { registerAgyBridgeIpc, wasAgyBridgeUsed } from './ipc/agyBridgeIpc';
// 09-12 usage-panel（子5 W3）：应用内用量面两通道（usage:overview / usage:clear）+
// 计量 sink 生产装配（installUsageMeteringProduction——协议层 wrapper → closure_llm_log
// 落行，全仓唯一装配点）。
import { installUsageMeteringProduction, registerUsageIpc } from './ipc/usageIpc';
// 09-12 usage-panel（子5 R5）：启动期滚动保留裁剪（retention 带外值 clamp 单源归位）。
import { pruneExpiredLedger } from './db/llmUsageLedgerRepository';
import { registerStorySyncIpc } from './ipc/storySyncIpc';
import { registerTaskIpc } from './ipc/taskIpc';
import { registerAssetIpc } from './ipc/assetIpc';
import { registerLogIpc } from './ipc/logIpc';
import { registerUpdateIpc, checkForUpdateOnStartup } from './ipc/updateIpc';
import { registerGitIpc } from './ipc/gitIpc';
import { registerAgentIpc } from './ipc/agentIpc';
import { registerClosureCraftIpc } from './ipc/closureCraftIpc';
import { registerClosureIndexIpc } from './ipc/closureIndexIpc';
import { registerClosureChainIpc } from './ipc/closureChainIpc';
import { registerSettingMdIpc } from './ipc/settingMdIpc';
import { registerAuthorProfileIpc } from './ipc/authorProfileIpc';
import { registerResearchConfigIpc } from './ipc/researchConfigIpc';
import { registerLintIpc } from './ipc/lintIpc';
import { registerWorldIpc } from './ipc/worldIpc';
// A 波 09-01：inbox 附件三通道（parse-inbox-doc / resolve-inbox-attachment /
// store-attachment-description）——handler 收在 parseDocumentHandlers.ts 同文件
// （design §1.2「收在 parseDocumentHandlers.ts 同文件」），共享解析内核。
import { registerInboxAttachmentIpc } from './ipc/toolHandlers/parseDocumentHandlers';
// Story 10.1 Wave D：材料库管理面六通道（materials:list/get/delete/reingest/import/
// update-provenance）。
import { registerMaterialIpc } from './ipc/materialIpc';
// Story 10.1 Wave C：材料 LLM 兜底生产装配（extraction 任务档 → resolveModel → generateText，
// materialIngest.ts JSDoc 指定链）+ 全局材料车道启动扫描/watcher（~/.orison/materials/）。
import { installMaterialLLMCoreProduction } from './ipc/toolHandlers/materialLLMCore';
// E10.2b（task 09-05）W3：蒸馏管线 LLM 缝生产装配（slot 路由 extraction/review-judge 档，
// craftDistillPipeline.ts JSDoc 指定链）+ 手艺蒸馏两通道（craft:distill-run/status）。
import { installCraftDistillLlmCoreProduction } from './ipc/toolHandlers/craftDistillLlmCore';
// E10.3a（task 09-05）W2：拆解管线 LLM 缝生产装配（slot 路由 extraction/review-judge/
// writer-draft 档——deconLlmCore.ts JSDoc 指定链，materialLLMCore 同型先装后用）。
import { installDeconLlmCoreProduction } from './decon/deconLlmCore';
// E10.3a（task 09-05，CR-1）：拆解 job 启动对账（kill/崩溃残留 running → paused 可续跑）。
import { reconcileStaleDeconJobsOnStartup } from './decon/deconJob';
import { registerCraftIpc } from './ipc/craftIpc';
// E10.3a（task 09-05）W6：拆解管线七通道（decon:create/start/pause/cancel/delete/get/list +
// decon:progress 广播埋点在 deconIpc 编排层）。
import { registerDeconIpc } from './ipc/deconIpc';
import { backfillGlobalMaterials } from './db/materialIndexer';
import {
  startGlobalMaterialWatcher,
  stopGlobalMaterialWatcher,
  stopProjectMaterialWatcher,
} from './db/materialWatcher';
import { fetchOrisonFile } from './orisonFileProtocol';
import { closeDb, getDb } from './db';
import { scanAndReindexCraftKb } from './db/closureCraftIndexer';
import { reconcileEmbeddingIndexOnStartup } from './db/embeddingIndexReconcile';
import { startCraftKbWatcher, stopCraftKbWatcher } from './db/craftKbWatcher';
import { stopAssetCardsWatcher } from './db/assetCardsWatcher';
import { stopSettingMdWatcher } from './db/settingMdWatcher';
import { stopChapterChunkWatcher } from './db/chapterChunkWatcher';

/* ── CSP ── */

/**
 * dev 口径单源（BMad CR 组4：isDev/isPackaged 双轨并存收敛）：一切「dev 才…」的
 * 判定一律用 `!app.isPackaged`。与 ELECTRON_RENDERER_URL 的关系——后者只在 vite dev
 * 启动器下被注入、指向 renderer dev server，它是 **loadURL 的数据来源**，不是 dev/
 * 打包判据：打包产物即使被注入该 env 也按打包态处理（CSP 不放开 unsafe-eval、
 * localhost 不进导航白名单），而 dev 实例直接加载 file:// 时仍是 dev（CDP 调试口照开）。
 * 下文 renderer 加载分支仍读该 env——那是取 URL 值，不是判态。
 */
const isDev = !app.isPackaged;

/**
 * CI 启动冒烟通道（W5 R8 / design D4）：ORISON_SMOKE=1 时走**正常全量 init 路径**
 * （db 打开、协议注册、IPC 注册、主窗口创建、ready-to-show）——冒烟的价值在真实启动
 * 路径，不走捷径分支。ready-to-show 后打 `ORISON_SMOKE_READY` marker → `app.exit(0)`。
 * 差异仅一处无人值守适配：注册库初始化失败的原生弹窗改 console.error（CI 无人可点，
 * 弹窗 = 挂死——#101② 先例的 CI 形态），退出码语义不变（exit(1)）。无网络依赖
 * （更新器本就 not-configured，且冒烟在 ready-to-show 即退、走不到 did-finish-load）。
 */
const smokeMode = process.env.ORISON_SMOKE === '1';
const SMOKE_READY_MARKER = 'ORISON_SMOKE_READY';

/**
 * CR-15（09-12 agy provider CR 批）：CLI 池退出等待窗口 = 池内 belt 硬杀时限
 *（antigravityCli/sessions.ts GRACEFUL_EXIT_KILL_MS = 5s）+ 1s 余量。窗口内优雅
 * 关停（close stdin → idle 进程秒退）/ belt 硬杀（在途 turn）都有时间发生；到点
 * app.exit(0) 强退兜底。
 */
const ANTIGRAVITY_CLI_QUIT_GRACE_MS = 6_000;

/**
 * dev-only CDP 调试口：e2e/dogfood 的附着式自检约定——Claude 经
 * playwright connectOverCDP 附着「用户正在看的这个 dev 实例」实时截图/驱动
 * 找 bug（工具侧 = apps/desktop/e2e/src/attach.ts）。打包产物不开
 * （isPackaged 守卫，见上方 isDev 单源）。ORISON_CDP_PORT 数值校验：仅接受十进制
 * 数字串且落在 1–65535；非法值 warn + 回落默认 9222（附着面失联必须可诊断，不静默）。
 * '0' 仍是显式关闭语义（合法通道）。
 */
if (!app.isPackaged) {
  const CDP_PORT_DEFAULT = '9222';
  const rawPort = process.env.ORISON_CDP_PORT;
  let cdpPort = CDP_PORT_DEFAULT;
  if (rawPort === undefined || rawPort === '') {
    // 未设 = 默认口（旧行为保持）。
  } else if (rawPort === '0') {
    cdpPort = ''; // 显式关闭
  } else if (/^\d+$/.test(rawPort)) {
    const portNum = Number(rawPort);
    if (portNum >= 1 && portNum <= 65535) {
      cdpPort = String(portNum); // 规范化前导零等写法
    } else {
      getLogger().warn(
        { value: rawPort },
        `ORISON_CDP_PORT out of range (1-65535) — falling back to ${CDP_PORT_DEFAULT}`,
      );
    }
  } else {
    getLogger().warn(
      { value: rawPort },
      `ORISON_CDP_PORT must be a decimal number (1-65535, or "0" to disable) — falling back to ${CDP_PORT_DEFAULT}`,
    );
  }
  if (cdpPort !== '') {
    app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
  }
}

// App icon (Windows/Linux runtime window + taskbar). macOS uses the bundled
// .icns from electron-builder, so a runtime icon is not needed there.
// `resources/` is copied next to the app via electron-builder `files`, and in
// dev it sits two levels up from dist/main. Prefer the .ico on Windows for
// crisp taskbar rendering, the .png elsewhere.
function resolveAppIcon(): string {
  const base = path.join(__dirname, '../../resources');
  return process.platform === 'win32'
    ? path.join(base, 'icon.ico')
    : path.join(base, 'icon.png');
}

const CSP = [
  "default-src 'self'",
  isDev ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'",
  // Fonts are bundled locally now (Material Symbols woff2 + system CJK
  // fallbacks), so no Google Fonts CDN is whitelisted. 'self' covers the
  // fingerprinted woff2 emitted into the build; data: kept for inlined assets.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: orison-file: https:",
  `connect-src 'self' ${isDev ? 'ws://localhost:* https:' : 'https:'}`,
].join('; ');

// The single live window. IPC handlers that need a window resolve it lazily via
// `getMainWindow()` so they can be registered ONCE for the app lifetime — a
// recreated window (macOS dock re-activate) is picked up automatically. Calling
// ipcMain.handle twice for the same channel throws, which previously crashed the
// app when a second window was created.
let mainWindow: BrowserWindow | null = null;
const getMainWindow = (): BrowserWindow | null => mainWindow;

let cspInstalled = false;
let ipcRegistered = false;

/**
 * dogfood #48：探测 agent 契约 prompts 真实基址并注入（setPromptsBaseDir）。
 * 候选：打包 resources/prompts（extraResources——release prep 待建，craft KB 同款债）；
 * dev 仓库布局 shell → ../../agent/prompts。全不中 → warn（yaml 契约将 degrade，
 * researcher/写章链节点拿到空 system+brief）。
 */
function wireAgentPromptsDir(): void {
  const log = getLogger();
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'prompts') : null,
    path.resolve(app.getAppPath(), '..', '..', 'agent', 'prompts'),
    // dogfood R2 #97：build 产物直启（electron dist/main/index.cjs，e2e harness 即此形态）
    // 时 getAppPath() 解析到 dist/main 而非 shell 根 → dev 布局候选落空、契约静默 degrade。
    // __dirname 候选两态皆中：build = dist/main（↑4 = apps/desktop）/ dev = shell/main
    // 源码（↑4 同样 = apps/desktop）→ + agent/prompts。existsSync 不中即跳过，零风险。
    path.resolve(__dirname, '..', '..', '..', '..', 'agent', 'prompts'),
  ].filter((p): p is string => p !== null);
  for (const dir of candidates) {
    if (existsSync(dir)) {
      setPromptsBaseDir(dir);
      log.info({ dir }, 'agent prompts base dir wired');
      return;
    }
  }
  log.warn({ candidates }, 'agent prompts base dir not found — yaml contracts degrade to empty');
}

/** Register every IPC handler exactly once. Window-bound ones use getMainWindow. */
function registerAllIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  // 文档目录用系统 Known Folder 解析（Windows 重定位文档后 homedir/Documents 失真），
  // 须在首个消费者（registerProjectIpc 的根目录 mkdir/picker defaultPath）之前生效。
  initProjectsRoot(app.getPath('documents'));
  // dogfood #48：yaml 契约 prompts 基址注入——agent 被打进 dist/main/index.cjs 后
  // agentPrompt 的 import.meta.url heuristic 解析到 shell/prompts（不存在）→ 全部
  // degrade empty（researcher 丢 brief 实录）。dev 仓库布局 / 打包 resources 两候选。
  wireAgentPromptsDir();
  registerProjectIpc();
  registerWindowIpc(getMainWindow);
  registerConfigIpc();
  registerModelProviderIpc();
  // 09-12 agy provider W4：CLI 形态（agy）模型发现（model:list-cli-models）。
  registerModelCliDiscoveryIpc();
  registerModelGatewayIpc();
  // 子4 agy MCP 工具桥（W4）：同意/状态/关闭回收三通道（machine 级，无窗口面）。
  registerAgyBridgeIpc();
  // 09-12 usage-panel（子5 W3）：应用内用量面（聚合读 + 清空；machine 级，无窗口面）。
  registerUsageIpc();
  registerStorySyncIpc();
  registerFieldSyncIpc();
  // dogfood R2 #77：creative fields 文档变更广播——盘上 project.yaml 是单一真相源，
  // UI 收敛（纯时间序 last-write-wins，不按写入方分优先级）。saveProject 是 yaml 唯一
  // 写入口（local-bff 订阅钩子），落盘后推 ToolEvent 孤儿类型 outline:changed（契约既有、
  // 此前零发射零消费）。刻意绕开 projectWatcher 的 file:changed——其自写抑制（tab 冲突
  // 保护）语义留给编辑器文件，本事件由写入口确定性发射。registerAllIpc 幂等 = 恰注册一次。
  subscribeProjectSaved((projectPath) => notifyUI({ type: 'outline:changed', projectPath }));
  registerTaskIpc();
  registerAssetIpc();
  registerLogIpc();
  registerUpdateIpc(getMainWindow);
  registerGitIpc();
  registerAgentIpc(getMainWindow);
  registerClosureCraftIpc();
  registerClosureIndexIpc();
  // dogfood T1 Stage 6：getMainWindow 透传——链 IPC 的 chain-delta/chain-node-done 事件经
  // agent:stream-event 广播（mirror registerAgentIpc(getWin) 模式，窗口重建懒解析）。
  registerClosureChainIpc(getMainWindow);
  registerSettingMdIpc();
  registerAuthorProfileIpc();
  registerResearchConfigIpc();
  // C1.2 llmlint：全稿静态扫描 / LLM 语境判断 / 机械修复应用（lintIpc 自含三 handler）。
  registerLintIpc();
  // dogfood R2 #92：世界状态面板读面三通道（world:overview / world:slice-detail /
  // world:subject-detail——纯读，无窗口面；world:changed 推送不经本注册器，发射埋三写入口
  // 经 worldNotify 全窗口广播）。
  registerWorldIpc();
  // A 波 09-01：inbox 附件（上传预解析 + 哈希身份 resolve + description 回写）。
  registerInboxAttachmentIpc();
  // Story 10.1 Wave D：材料库管理面（list/get/delete 四清/reingest/import/update-provenance
  // + material:changed 广播埋点）。
  registerMaterialIpc();
  // E10.2b（task 09-05）W3：手艺蒸馏管线两通道（craft:distill-run 批量入队 +
  // craft:distill-status 台账查询；review 侧九通道归 W4/W5 UI waves）。
  registerCraftIpc();
  // E10.3a（task 09-05）W6：拆解管线七通道（child A P0-P2 + 断点底座的控制面；
  // canon 浏览/reports 等消费面通道归 child B 增补）。
  registerDeconIpc();
}

function createWindow() {
  const isMac = process.platform === 'darwin';

  // 上次的窗口大小/位置/所在显示器（dogfood 2026-08-21）；显示器已拔/尺寸失真时
  // loadWindowState 返回 null → 走默认居中，绝不恢复到屏幕外。
  const savedWindowState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedWindowState?.width ?? 1440,
    height: savedWindowState?.height ?? 960,
    x: savedWindowState?.x,
    y: savedWindowState?.y,
    minWidth: 1100,
    minHeight: 720,
    // CI 冒烟（ORISON_SMOKE=1）：藏窗创建。ready-to-show（首帧渲染信号）只在隐藏
    // 窗上可靠发射——show:true 即显即绘不保证该事件（本机实测 120s 不发）；CI 也
    // 无需真实显示窗口。非冒烟态 true = 默认行为不变。
    show: !smokeMode,
    icon: isMac ? undefined : resolveAppIcon(),
    frame: isMac,                          // Windows/Linux 隐藏原生标题栏
    titleBarStyle: isMac ? 'hidden' : undefined, // macOS 保留红绿灯
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (savedWindowState?.isMaximized) mainWindow.maximize();
  trackWindowState(mainWindow);

  const win = mainWindow;

  // Inject CSP via response headers — only in production builds, and only once
  // (the listener is on the shared defaultSession, so re-adding it per window
  // would stack duplicate handlers).
  if (!isDev && !cspInstalled) {
    cspInstalled = true;
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      });
    });
  }

  // Prevent Chromium from swallowing shortcuts we handle in the renderer
  const passthroughKeys = new Set(['Tab', 'n', 'w', 't']);
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && passthroughKeys.has(input.key)) {
      event.preventDefault();
    }
  });

  // Navigation / popup hard guards — renderer must not open arbitrary URLs or
  // spawn windows. External links go through openExternal (https-only).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    // Allow the initial load and Vite HMR reloads in dev; block everything else.
    const allowed =
      url.startsWith('file:')
      || (isDev && (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')));
    if (!allowed) {
      event.preventDefault();
      getLogger().warn({ url }, 'blocked renderer navigation');
    }
  });

  // Guard window close — ask renderer to check for unsaved files
  let forceClose = false;
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    win.webContents.send('app:before-close');
  });
  const onCloseConfirmed = (event: Electron.IpcMainEvent) => {
    // Only react to the confirmation from this window's renderer.
    if (event.sender !== win.webContents) return;
    forceClose = true;
    win.close();
  };
  ipcMain.on('app:close-confirmed', onCloseConfirmed);
  win.on('closed', () => {
    ipcMain.removeListener('app:close-confirmed', onCloseConfirmed);
    if (mainWindow === win) mainWindow = null;
  });

  // R8 全局界面缩放：启动即读偏好整体缩放（Chromium 页面级 zoom，机制选型注释在
  // shared-contracts clampInterfaceScale / configIpc 施加点）。读路径已钳回合法带，
  // 缺键/非法值回默认——这里拿到的一定是可用数值；缺键回退走契约单一源
  // INTERFACE_SCALE_DEFAULT（BMad CR 组4：散布 `?? 1` 收敛）。
  win.webContents.setZoomFactor(
    readUserPreferencesFromDisk().interfaceScale ?? INTERFACE_SCALE_DEFAULT
  );

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // CI 启动冒烟（W5 R8 / design D4）：真实启动路径全量走到 renderer 首帧
  //（ready-to-show——BrowserWindow 级事件，非 webContents），打 marker 后强退
  //（app.exit 不走 will-quit——冒烟进程无在途状态需要善后，db 为 WAL 短连接、
  // 进程死即恢复）。stdout 接管道时 write 异步缓冲——flush 回调里再退防 marker
  // 被强退截杀；2s belt 防回调失联挂死（脚本侧另有 120s 超时兜底红）。
  if (smokeMode) {
    win.once('ready-to-show', () => {
      process.stdout.write(`${SMOKE_READY_MARKER}\n`, () => app.exit(0));
      setTimeout(() => app.exit(0), 2_000);
    });
  }

  // Silent update check on startup (packaged builds only). The renderer
  // surfaces a guided prompt only if a newer version is found. Delay so the
  // window/renderer is ready to receive the `update:event` stream.
  if (readUserPreferencesFromDisk().autoCheckUpdates !== false) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void checkForUpdateOnStartup(), 5000);
    });
  }
}

/* ── Custom protocol for serving local project files ── */
// Note: registerSchemesAsPrivileged was removed in Electron 18+ — protocol.handle() handles it natively

/**
 * dogfood R2 #101①：注册库初始化失败 = 启动关键路径断裂。旧实现是本文件 whenReady 回调内
 * 直接 `throw err`——`.then()` 回调里的 throw 变 unhandledRejection，而 installGlobalErrorHandlers
 * 只记不退 → registerAllIpc/createWindow 永不执行 = 无窗静默死（用户面零信号，仅两行日志）。
 * 修法：原生错误对话框承载可复制诊断（Windows 下 Ctrl+C 整框复制——UI 侧无 copy-diagnostics
 * 实现）+ `app.exit(1)` 非零码退出（Electron 原生出口，对 e2e/启动器可见）。showErrorBox
 * 同步模态天然给 pino 异步 flush（destination sync:false）留时，不加人为延时。
 * installGlobalErrorHandlers 的「只记不退」全局语义不动——运行期单点错误不杀 app，仅启动
 * 关键路径局部收紧。deps（getDb/showErrorBox/exit）注入供测试替换；返回 false 时调用方中止
 * 启动序列（不再注册 IPC / 开窗——与旧 throw 的中止语义等价但可诊断）。
 */
export function initProjectRegistryOrExit(
  deps: {
    getDb: () => unknown;
    showErrorBox: (title: string, content: string) => void;
    exit: (code: number) => void;
  } = {
    getDb,
    // 冒烟态（ORISON_SMOKE=1）：CI 无人可点原生弹窗——改 console.error 承载同一份
    // 可诊断文案，exit(1) 语义不变。默认 deps 每调用现构造，注入测试（registryInitFailure
    // 显式传 deps）不受此分支影响。
    showErrorBox: smokeMode
      ? (title, content) => {
          console.error(`${title}\n${content}`);
        }
      : (title, content) => dialog.showErrorBox(title, content),
    exit: (code) => app.exit(code),
  },
): boolean {
  try {
    deps.getDb();
    getLogger().info('project registry initialized');
    return true;
  } catch (err) {
    const logger = getLogger();
    logger.fatal({ err }, 'project registry initialization failed');
    const code = err !== null && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : null;
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    deps.showErrorBox(
      'Closure 启动失败',
      `项目注册库初始化失败，应用将以非零码退出。\n\n${code ? `code: ${code}\n` : ''}${detail}\n\n` +
        `日志目录：${getLogsDirPath()}\n` +
        '若刚切换过 node 版本或重装依赖：开发者模式请先运行 pnpm rebuild:native 重建原生模块。',
    );
    deps.exit(1);
    return false;
  }
}

app.whenReady().then(() => {
  // Register orison-file:// protocol to serve local files from sandbox
  protocol.handle('orison-file', (request) => {
    return fetchOrisonFile(request.url);
  });

  installGlobalErrorHandlers();
  const logger = getLogger();
  logger.info({ platform: process.platform, version: app.getVersion() }, 'desktop main starting');
  // 数据库迁移必须在 IPC 和窗口创建前完成，不能依赖项目页是否触发首次查询。
  // 这样旧表缺列会在启动阶段一次性修复，不会等到复制/删除时才暴露失败。
  // dogfood R2 #101①：失败路径弹原生错误框（详情+日志目录+重编指引）+ app.exit(1)；
  // 返回 false 即中止启动序列（不再注册 IPC / 开窗——与旧 throw 的中止语义等价但可诊断）。
  if (!initProjectRegistryOrExit()) return;
  // 09-12 usage-panel（子5 W3）：生成计量 sink 生产装配——协议层两公共入口 wrapper
  // （先行批已落）→ insertUsageLog 落 closure_llm_log。时序：db 已开（上一步）+ IPC
  // 注册前（任何 generate 都不漏计）；mirror installDeconLlmCoreProduction 先例。
  installUsageMeteringProduction();
  // R5 启动期滚动保留裁剪：过期行删除（读时过滤会让表无界增长）。retention 读侧
  // lenient——preferences 的 usageRetentionDays 经 readUserPreferencesFromDisk 读入并钳回
  // 合法带 [7,730]（缺键/带外 → clamp 默认 90）；prune best-effort（失败不阻启动）。
  try {
    const pruned = pruneExpiredLedger(
      clampUsageRetentionDays(readUserPreferencesFromDisk().usageRetentionDays),
    );
    if (pruned > 0) {
      getLogger().info({ pruned }, 'usage ledger: startup retention prune removed expired rows');
    }
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'usage ledger: startup retention prune failed (non-fatal)',
    );
  }
  // E10.3a（task 09-05，CR-1）：拆解 job 启动对账——kill/崩溃残留的 status='running' 拆解
  // job 翻 paused（可续跑态——pass_state 台账在，用户 start 即重入；否则 startDeconJob 的
  // running no-op 分支会让 AC2 的 IPC 断点路径永远打不开）。进程重启时在途注册表恒空，
  // running 必为残留（mirror reconcileStaleProjectRuns D4 先例）。best-effort。
  try {
    const flipped = reconcileStaleDeconJobsOnStartup();
    if (flipped > 0) {
      getLogger().info({ flipped }, 'decon: stale running jobs reconciled to paused on startup');
    }
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'decon: stale-job startup reconciliation failed (non-fatal)',
    );
  }
  // Story 3.6 WP2 (R13/D6; CR P2): apply the persisted research proxy tier
  // before any research network call can fire (all research outbound rides the
  // dedicated `research` partition session, so one setProxy covers netFetch +
  // the render sandbox while defaultSession stays untouched). Best-effort — a
  // proxy failure must never block launch; read-side degradation lands on the
  // `system` default anyway.
  try {
    applyResearchProxyFromDisk();
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'research proxy startup apply failed - continuing',
    );
  }
  // Story 10.1 Wave C：材料分章 LLM 兜底内核装配（watcher 链上的 ingestMaterial 在启动扫描
  // 期即可能触发兜底——先装后扫）。每调用现解析（档位/配置即时生效），安装期零副作用。
  installMaterialLLMCoreProduction();
  // E10.2b（task 09-05）W3：蒸馏管线 LLM 内核装配（materialLLMCore 同型——先装后用；蒸馏由
  // 用户触发非启动扫描，装配点在 registerAllIpc 之前即满足时序，与材料内核并列置此收口）。
  installCraftDistillLlmCoreProduction();
  // E10.3a（task 09-05）W2：拆解管线 LLM 内核装配（同上先装后用——拆解由用户触发，装配点在
  // registerAllIpc 之前即满足时序；温度随档契约见 deconLlmCore.ts）。
  installDeconLlmCoreProduction();
  // 子4 agy MCP 工具桥（W4）：桥内核装配（model-protocols bridgeTurn 内核注入——假宿
  // 四件套 + 管道注册表 + 桥会话池）+ 生产单例登记。时序：先于 registerAllIpc（agentIpc
  // 的桥 seam 注入经单例取注册表）且先于任何桥 turn。启动清扫守卫（design §2.4）：扫
  // `~/.orison/agy-bridge/home/*` 残留凭据副本——pid 死/无 marker/超龄即删（CR-4 参数：
  // 活跃集取刚装配注册表的快照，启动时恒空——ownPid 分支删除不会命中自家活动桥假宿）。
  // best-effort fire-and-forget（清扫失败不阻启动）。
  // CR-10（子4 CR 批）：装配失败降级桥 off（生产单例保持 undefined——turn 入口响亮拒、
  // lane resolver 未注入回纯文本），**不得断 whenReady 链**（IPC/窗口创建不得被桥拖死）。
  let agyBridgeRegistry: ReturnType<typeof installShellAgyBridgeCore> | undefined;
  try {
    agyBridgeRegistry = installShellAgyBridgeCore();
    setProductionAgyBridgeRuntime(agyBridgeRegistry);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'agy-bridge core install failed — bridge disabled for this run (non-fatal)',
    );
  }
  void sweepStaleBridgeHomes({
    homeRoot: defaultAgyBridgeHomeRoot(),
    activeSessionIds: new Set((agyBridgeRegistry?.activeSessions() ?? []).map((r) => r.sessionId)),
    warn: (message) => getLogger().warn({ component: 'agy-bridge' }, message),
  }).catch((err) => {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'agy-bridge: startup sweep of stale bridge homes failed (non-fatal)',
    );
  });
  // W5 R9（design D6）：纯文本 lane 的 agy 临时 cwd 同族清扫（桥假宿清扫只覆盖
  // ~/.orison/agy-bridge/home/*，os.tmpdir()/agy-* 归本函数）。同步执行——tmpdir
  // 扫描 + 少量 rm 为毫秒级，且就位在 marker 之前使冒烟路径也覆盖它。
  sweepStaleAgyTempSessionDirs();
  // Story 2.1: scan the global craft KB (~/.orison/craft-kb/ + bundled seeds) and
  // incrementally reindex new/changed docs into closure_craft_* on startup. Fire-
  // and-forget: craft reindex does async embeds (slow), must not block app launch.
  // Best-effort: per-doc failures are logged + skipped inside the scan.
  //
  // dogfood #39 (T2 Batch C1): chain the embedding-index reconcile AFTER the craft
  // scan — a previous model-change rebuild that failed (dim probe 失败 left-as-is)
  // left the vector arm silently FTS-only; the reconcile re-detects the mismatch at
  // every startup and re-runs the rebuild sweep, replacing the luck-based
  // "next model change" self-heal. Chained (not parallel) so the two startup embed
  // passes stay serialized; equally fire-and-forget + best-effort.
  //
  // 🔑 CR-005（BMad 2026-09-02）：全局材料车道 backfill + watcher 排在本链**末尾**串行——
  // craft 扫描的 vec dim-swap（ensureCraftVecDim 对 closure_craft_vec 的 DROP+reCREATE）与
  // 材料全局车道 INSERT 是跨 await 的两条异步链：并行时 dim-swap 窗口期（表已 DROP 未重建/
  // 旧维表）落材料 craft_vec 行 = 旧维污染或直接失败。better-sqlite3 单连接同步不救跨链交错
  // （同步语句在两条 async 链间仍会交错执行），故把材料 backfill/watcher 排进同一条 promise
  // 链消竞态（每段 catch 后恢复，后续段照跑——单段失败不阻断整链）。watcher 也压后：其事件
  // 链（registerMaterial → INSERT）与 dim-swap 同竞态面。仍 fire-and-forget：craft 全量
  // embed 慢，不阻窗口创建（mirror 原注释语义）。
  void scanAndReindexCraftKb()
    .catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'craft KB startup scan failed - continuing',
      );
    })
    .then(() => reconcileEmbeddingIndexOnStartup())
    .catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'embedding index startup reconcile failed - continuing',
      );
    })
    // Story 10.1 Wave C（F-16）：全局材料车道（~/.orison/materials/）启动扫描——覆盖「app 未
    // 运行时拷入」的无 watcher 事件场景（mirror craft 启动扫描先例）；orphan 清扫 + mtime
    // 快路幂等（未变原件零解析）+ failed 退避（CR-030）。best-effort。
    .then(() => backfillGlobalMaterials())
    .catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'material global-lane startup backfill failed - continuing',
      );
    })
    // 之后起全局车道 watcher（增量进件；Linux 递归 watch 不可用降级到本启动扫描 + 手动
    // 重摄取）。
    .then(() => {
      startGlobalMaterialWatcher();
    });
  // Story 2.1 CR-craft-kb-011: watch the user craft KB dir for incremental
  // edits / additions / deletions so a reindex lands without an app restart.
  // Started after the startup scan begins; best-effort (Linux recursive watch /
  // missing dir degrade to the startup scan + manual rebuild IPC).
  startCraftKbWatcher();
  registerAllIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Release the SQLite handle on quit. In WAL mode an open handle keeps a file
// lock that, on Windows, blocks deleting/reopening the DB file. Without this the
// connection only closed in tests, never on real app exit.
app.on('will-quit', (event) => {
  // Electron 37 typings：will-quit 的 event 可缺席——本守卫只在在场时拦默认退出
  //（CR-15 CLI quit grace；缺席 = 无从 preventDefault，按原同步路径退出）。
  const quitEvent = event ?? undefined;
  // Stop the craft KB watcher + clear its debounce timer so no fs watcher / timer
  // outlives the process (Story 2.1 CR-craft-kb-011).
  try {
    stopCraftKbWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopCraftKbWatcher on quit failed');
  }
  // Story 2.7: stop the asset_cards watcher too so no fs watcher / debounce timer
  // outlives the process (mirror stopCraftKbWatcher).
  try {
    stopAssetCardsWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopAssetCardsWatcher on quit failed');
  }
  // Story 2.3: stop the setting_md watcher too (same lifecycle as
  // assetCardsWatcher - mirror stopAssetCardsWatcher).
  try {
    stopSettingMdWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopSettingMdWatcher on quit failed');
  }
  // Story 8.3: stop the chapter chunk watcher too (same lifecycle - mirror
  // stopSettingMdWatcher).
  try {
    stopChapterChunkWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopChapterChunkWatcher on quit failed');
  }
  // Story 10.1: stop the global material watcher too (same lifecycle - mirror
  // stopCraftKbWatcher; 项目车道 watcher 随 project:unwatch 生命周期，这里兜底).
  try {
    stopGlobalMaterialWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopGlobalMaterialWatcher on quit failed');
  }
  // Story 10.1 CR-009：项目车道 material watcher 兜底停——其主生命周期在 project:unwatch
  // （projectIpc 切换/关闭），quit 时若项目仍看守中（直接退出未切项目）这里兜住句柄与
  // debounce 定时器（mirror stopGlobalMaterialWatcher / materialWatcher 文件头声明）。
  try {
    stopProjectMaterialWatcher();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'stopProjectMaterialWatcher on quit failed');
  }
  // 09-12 agy provider W4：关停 CLI 驱动器单例会话池——优雅关停全部长驻 agy 进程
  //（close stdin，5s 硬杀兜底在池内）+ 停 idle 清扫定时器。
  try {
    disposeAntigravityCliDriver();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'disposeAntigravityCliDriver on quit failed');
  }
  // 子4 agy MCP 工具桥（W4）：桥池 + 注册表关停——disposeAgyBridgeRuntime 关停桥专属
  // AgySessionPool（长驻桥 agy 进程优雅退出 + 假宿删除），registry.disposeAll 关管道
  // server + abort 在途工具 + 停 idle 清扫器。fire-and-forget 异步——有界等待窗在下方。
  try {
    disposeAgyBridgeRuntime();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'disposeAgyBridgeRuntime on quit failed');
  }
  try {
    getProductionAgyBridgeRegistry()?.disposeAll();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'agy-bridge registry disposeAll on quit failed');
  }
  // CR-15（09-12 agy provider CR 批）shell 半：上面的关停是异步 fire-and-forget——
  // will-quit 同步走完会让主进程先死，Windows 下子进程不随父进程消亡，agy.exe 活过
  // app（在途 turn 跑完为止，belt 硬杀来不及发）。本会话用过 CLI 生成或桥 turn 时
  // preventDefault + 有界等待（池内 belt 5s + 余量），窗口到点 closeDb + app.exit(0)
  // 强退（app.exit 不重发 will-quit，无死循环）；两者都没用过的会话保持原同步退出路径
  //（零新增退出延迟）。
  if ((wasAntigravityCliUsed() || wasAgyBridgeUsed()) && quitEvent !== undefined) {
    quitEvent.preventDefault();
    // 刻意不持句柄也不 unref：本 timer 是 quit 的唯一出口（preventDefault 后 Electron
    // 不再自行退出），unref 会让事件循环在 timer 到点前排干 → 进程无出口悬挂。
    setTimeout(() => {
      try {
        closeDb();
      } catch (err) {
        getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'closeDb on quit failed');
      }
      getLogger().info('antigravity-cli quit grace elapsed — forcing app exit');
      app.exit(0);
    }, ANTIGRAVITY_CLI_QUIT_GRACE_MS);
    return;
  }
  try {
    closeDb();
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, 'closeDb on quit failed');
  }
});
