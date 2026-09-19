import { ipcMain } from 'electron';
import os from 'node:os';
import {
  CLOSURE_TEXT_AGENT_LAYOUT,
  type ResolveTextAgentFn,
} from '@orison/model-protocols';
import type {
  AgyTextAgentDisableResult,
  AgyTextAgentEnableResult,
  AgyTextAgentFileState,
  AgyTextAgentStatusView,
} from '@orison/shared-contracts';
import { readModelConfigFromDisk } from './configIpc';
import { getLogger } from '../logger';
import {
  buildTextAgentStatusView,
  getProductionAgyTextAgentConsentStore,
  reconcileTextAgentAtStartup,
  removeTextAgentFileIfOurs,
  resolveTextAgentFileState,
  textAgentFilePath,
  textAgentMarkdownCached,
  textAgentConsentEnabled,
  writeTextAgentFile,
  type AgyTextAgentConsentStore,
} from './agyTextAgentConsent';

// ── Closure 文本 Agent α 生命周期 IPC + 生产实现（09-19 CLI 白名单 W3，design §1.2）──
//
// 本文件 owns：
//   - `createTextAgentResolverProduction`：agentIpc 注入 model-protocols 驱动器的零工具
//     agent 解析器（mirror createAgyBridgeLaneModeResolver 注入形态——agent 运行时不读
//     盘，shell 注入现读闭包）。启用前提两半（无 declined 记录 + 存在 agy CLI key）+
//     文件 current 才返回布局常量激活值；否则 undefined（γ 反工具硬化兜底路径）。
//   - `reconcileTextAgentAtStartupProduction`：whenReady 启动对账（注入/更新/一致/冲突
//     各一行日志——运行阶段可见性）。
//   - `registerAgyTextAgentIpc`：status / enable / disable 三通道（四处同步：ipc.ts enum
//     + 接口 + preload + 本 handler + registerAllIpc 行）。
//
// 测试缝：deps（consentStore / cliKeyPresent / realHome）全注入——单测零真实 ~/.gemini
// 写（consent store 与 agent 文件全落 temp 根）。

const logger = getLogger();

export interface AgyTextAgentProductionDeps {
  consentStore: () => AgyTextAgentConsentStore;
  /**
   * 任一 antigravity-cli provider key 存在（启用前提第二半；生产 = readModelConfigFromDisk
   * 现读——key 配置变更即时反映）。测试注入替身。
   */
  cliKeyPresent: () => boolean;
  /**
   * 真实用户 home（agent 文件/consent 落点；测试传 temp 根）。getter 形态供 register-once
   * 场景逐用例换根（mirror agyBridgeIpc depsRealHome 先例）。
   */
  realHome?: string | (() => string);
}

function depsRealHome(deps: AgyTextAgentProductionDeps): string {
  const v = deps.realHome;
  if (typeof v === 'function') return v();
  return v ?? os.homedir();
}

/** 我方 agent.md 落点（日志行/呈报用——与写入口同一布局常量拼接）。 */
function writeTargetPath(deps: AgyTextAgentProductionDeps): string {
  return textAgentFilePath(depsRealHome(deps));
}

/** 磁盘现读：存在任一 antigravity-cli provider key（读失败视同无 key——γ 兜底方向）。 */
export function hasConfiguredCliKeyFromDisk(): boolean {
  try {
    return readModelConfigFromDisk().keys.some((k) => k.protocol === 'antigravity-cli');
  } catch {
    return false;
  }
}

/** 生产 deps（懒建 store + 磁盘现读 key 前提；测试注入替身）。 */
export function agyTextAgentProductionDeps(
  overrides: Partial<AgyTextAgentProductionDeps> = {},
): AgyTextAgentProductionDeps {
  return {
    consentStore: getProductionAgyTextAgentConsentStore,
    cliKeyPresent: hasConfiguredCliKeyFromDisk,
    ...overrides,
  };
}

// CR-10：resolver 非 current 态 warn 进程级一次（模块级旗）——长蒸馏链逐 spawn 的
// 「手删/陈旧/外来」exceptional 态不再刷屏（自愈挂启动对账；warn 只负责把存在性钉进日志）。
let resolverNonCurrentWarned = false;

/** 测试缝：复位 resolver 非 current warn 单次旗（module-level state 不得跨测试泄漏）。 */
export function __resetTextAgentNonCurrentWarnForTest(): void {
  resolverNonCurrentWarned = false;
}

/**
 * 零工具 agent 解析器生产实现（agentIpc setAntigravityCliTextAgentResolver 注入）。
 * 每 spawn 前现读三道门：无 CLI key → undefined（静默——无 CLI 车道本就无事可做）；
 * declined / corrupt（CR-5 坏状态文件视同 declined）→ undefined（静默——用户 deliberate
 * 态，不刷屏）；文件非 current → undefined + warn（exceptional 态——手删/陈旧/外来压住，
 * CR-10 进程级一次，下次启动对账自愈，γ 硬化兜底）。
 */
export function createTextAgentResolverProduction(
  deps: AgyTextAgentProductionDeps = agyTextAgentProductionDeps(),
): ResolveTextAgentFn {
  return (): string | undefined => {
    if (!deps.cliKeyPresent()) return undefined;
    if (!textAgentConsentEnabled(deps.consentStore().read())) return undefined;
    const realHome = depsRealHome(deps);
    const state = resolveTextAgentFileState({
      realHome,
      expectedMarkdown: textAgentMarkdownCached(),
    });
    if (state === 'current') return CLOSURE_TEXT_AGENT_LAYOUT.agentName;
    if (!resolverNonCurrentWarned) {
      resolverNonCurrentWarned = true;
      logger.warn(
        { component: 'agy-text-agent', state },
        'agy-text-agent: enabled but agent file not current — falling back to the no-agent lane (gamma hardening stays)',
      );
    }
    return undefined;
  };
}

/** whenReady 启动对账生产实现（main/index.ts 装配段调用；best-effort——失败不阻启动）。 */
export function reconcileTextAgentAtStartupProduction(
  deps: AgyTextAgentProductionDeps = agyTextAgentProductionDeps(),
): AgyTextAgentFileState {
  return reconcileTextAgentAtStartup({
    realHome: depsRealHome(deps),
    markdown: textAgentMarkdownCached(),
    enabled: textAgentConsentEnabled(deps.consentStore().read()) && deps.cliKeyPresent(),
    log: (message) => logger.info({ component: 'agy-text-agent' }, message),
  });
}

// ── IPC 三通道（registerAllIpc 恰一次；machine 级读写，无窗口面无 pathGuard 面）──

let registered = false;

export function registerAgyTextAgentIpc(deps: AgyTextAgentProductionDeps = agyTextAgentProductionDeps()): void {
  if (registered) return;
  registered = true;

  const statusView = (): AgyTextAgentStatusView => {
    const store = deps.consentStore();
    return buildTextAgentStatusView({
      // CR-5：corrupt（坏状态文件）视同 declined——状态面呈关闭态，卡片一键重开即自愈
      //（enable 的 clearDeclined 覆写新 store 文件）。
      declined: !textAgentConsentEnabled(store.read()),
      cliKeyPresent: deps.cliKeyPresent(),
      realHome: depsRealHome(deps),
      consentFilePath: store.filePath(),
    });
  };

  ipcMain.handle('agy-text-agent:status', (): AgyTextAgentStatusView => statusView());

  ipcMain.handle('agy-text-agent:enable', (): AgyTextAgentEnableResult => {
    // 先清 declined（用户意图 = 开）再写文件：外来冲突时开关维已开、文件态由 status 呈报
    // foreign-conflict（卡片可见、不代删）——语义 honest（design §4 失败模式）。
    try {
      deps.consentStore().clearDeclined();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agy-text-agent:enable consent store write failed',
      );
      return { ok: false, error: 'operation-failed' };
    }
    const written = writeTextAgentFile({
      realHome: depsRealHome(deps),
      markdown: textAgentMarkdownCached(),
    });
    if (!written.ok) {
      logger.warn(
        { component: 'agy-text-agent', error: written.error, detail: written.message },
        'agy-text-agent:enable agent file write failed',
      );
      return { ok: false, error: written.error };
    }
    logger.info(
      { component: 'agy-text-agent' },
      `文本 Agent 已开启并写入：${writeTargetPath(deps)}`,
    );
    return { ok: true, view: statusView() };
  });

  ipcMain.handle('agy-text-agent:disable', (): AgyTextAgentDisableResult => {
    // declined 记住（AC5——后续 spawn 恒走降级）；存储失败即整体失败（防「忘了 declined
    // 却删了文件」的半态，下次启动对账会重写）。
    try {
      deps.consentStore().markDeclined();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agy-text-agent:disable consent store write failed',
      );
      return { ok: false, error: 'operation-failed' };
    }
    try {
      // 验 Closure 尾标记才删；外来文件/缺失绝不动（removeIfOurs 返回 false 即无事可删）。
      removeTextAgentFileIfOurs(depsRealHome(deps));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'agy-text-agent:disable agent file removal failed',
      );
      return { ok: false, error: 'operation-failed' };
    }
    return { ok: true, view: statusView() };
  });
}
