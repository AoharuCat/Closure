import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { handle, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
}));

// CR-10：resolver 非 current warn 单次旗断言面（logger 整体 mock）。
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import {
  CLOSURE_TEXT_AGENT,
  CLOSURE_TEXT_AGENT_LAYOUT,
  renderAgentMarkdown,
} from '@orison/model-protocols';
import {
  __resetTextAgentNonCurrentWarnForTest,
  agyTextAgentProductionDeps,
  createTextAgentResolverProduction,
  reconcileTextAgentAtStartupProduction,
  registerAgyTextAgentIpc,
} from '../main/ipc/agyTextAgentIpc';
import {
  createAgyTextAgentConsentStore,
  textAgentFilePath,
  type AgyTextAgentConsentStore,
} from '../main/ipc/agyTextAgentConsent';
import { rmBestEffort } from './rmBestEffort';

// ── 09-19 CLI 白名单 W3：文本 Agent IPC 三通道 + 生产实现（resolver / 启动对账）测试 ──
//
// 零真实 ~/.gemini / ~/.orison 写（realHome 与 consent store 全落 temp 根）。覆盖：
// status 默认开启形态、enable 写入/foreign 拒写/存储错误、disable 回收（外来绝不动）/
// 存储错误（不产生半态）、resolver 三道门、启动对账生产接线。

function tempConsentFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-ipc-consent-')), 'consent.json');
}

describe('IPC 三通道（registerAgyTextAgentIpc）', () => {
  // register-once（模块 registered 守卫 mirror 生产 app 生命周期注册）——store/realHome 经
  // holder 逐用例换件（getter 形态闭包在调用时读 holder）。handle 的注册记录只在 beforeAll
  // 留痕一次，不 reset（mirror 桥 IPC 测试形态）。
  const holder: { store: AgyTextAgentConsentStore; realHome: string } = {
    store: createAgyTextAgentConsentStore({ filePath: path.join(os.tmpdir(), 'agy-text-agent-ipc-once-consent.json') }),
    realHome: '',
  };

  const invoke = <T>(channel: string, ...args: unknown[]): T => {
    const call = handle.mock.calls.find(([c]) => c === channel);
    if (call === undefined) throw new Error(`channel ${channel} not registered`);
    return (call[1] as (...a: unknown[]) => T)(undefined, ...args);
  };

  beforeAll(() => {
    registerAgyTextAgentIpc({
      consentStore: () => holder.store,
      cliKeyPresent: () => true,
      realHome: () => holder.realHome,
    });
  });

  beforeEach(() => {
    holder.store = createAgyTextAgentConsentStore({ filePath: tempConsentFile() });
    holder.realHome = mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-ipc-home-'));
  });

  afterEach(() => {
    rmBestEffort(holder.realHome);
  });

  it('status：默认开启（无记录）+ missing 态 + 路径字段 + 零遮蔽', () => {
    const view = invoke<{
      enabled: boolean;
      cliKeyPresent: boolean;
      fileState: string;
      shadowedBy: string[];
      agentFilePath: string;
      consentFilePath: string;
    }>('agy-text-agent:status');
    expect(view.enabled).toBe(true);
    expect(view.cliKeyPresent).toBe(true);
    expect(view.fileState).toBe('missing');
    expect(view.shadowedBy).toEqual([]);
    expect(view.agentFilePath).toBe(textAgentFilePath(holder.realHome));
    expect(view.consentFilePath).toBe(holder.store.filePath());
  });

  it('enable：清 declined + 文件落盘（态转 current）+ 回显视图', () => {
    holder.store.markDeclined();
    const result = invoke<{ ok: boolean; view?: { fileState: string; enabled: boolean } }>('agy-text-agent:enable');
    expect(result.ok).toBe(true);
    expect(result.view!.fileState).toBe('current');
    expect(result.view!.enabled).toBe(true);
    expect(holder.store.read()).toBeUndefined();
    expect(readFileSync(textAgentFilePath(holder.realHome), 'utf8')).toBe(renderAgentMarkdown(CLOSURE_TEXT_AGENT));
  });

  it('enable：外来文件压住 → foreign-conflict 拒写不覆盖（declined 已清——开关维 honest）', () => {
    const file = textAgentFilePath(holder.realHome);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '用户自己的同名文件\n', 'utf8');
    const result = invoke<{ ok: boolean; error?: string }>('agy-text-agent:enable');
    expect(result).toEqual({ ok: false, error: 'foreign-conflict' });
    expect(readFileSync(file, 'utf8')).toBe('用户自己的同名文件\n');
    expect(holder.store.read()).toBeUndefined();
  });

  it('enable：consent 存储写失败 → operation-failed（不静默）', () => {
    holder.store = {
      read: () => undefined,
      markDeclined: () => {},
      clearDeclined: () => {
        throw new Error('EACCES: consent.json');
      },
      // stub 的 filePath 指向独立路径（测试零断言消费——不落宽路径）。
      filePath: () => path.join(os.tmpdir(), 'agy-text-agent-ipc-throw-consent.json'),
    };
    const result = invoke<{ ok: boolean; error?: string }>('agy-text-agent:enable');
    expect(result).toEqual({ ok: false, error: 'operation-failed' });
  });

  it('disable：declined 记住 + 自有文件回收；再 status → enabled false + missing', () => {
    invoke<{ ok: boolean }>('agy-text-agent:enable');
    expect(existsSync(textAgentFilePath(holder.realHome))).toBe(true);

    const result = invoke<{ ok: boolean; view?: { enabled: boolean; fileState: string } }>('agy-text-agent:disable');
    expect(result.ok).toBe(true);
    expect(result.view!.enabled).toBe(false);
    expect(result.view!.fileState).toBe('missing');
    expect(holder.store.read()).toBe('declined');
    expect(existsSync(textAgentFilePath(holder.realHome))).toBe(false);
  });

  it('disable：外来文件绝不动（declined 照记）；存储失败 → operation-failed（不产生半态）', () => {
    const file = textAgentFilePath(holder.realHome);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '外来文件\n', 'utf8');
    const result = invoke<{ ok: boolean; view?: { enabled: boolean; fileState: string } }>('agy-text-agent:disable');
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('外来文件\n');
    expect(result.view!.fileState).toBe('foreign');

    // 存储失败先于删文件——防「忘了 declined 却删了文件」半态。
    holder.store = {
      read: () => undefined,
      markDeclined: () => {
        throw new Error('EACCES: consent.json');
      },
      clearDeclined: () => {},
      filePath: () => path.join(os.tmpdir(), 'agy-text-agent-ipc-throw-consent.json'),
    };
    expect(invoke<{ ok: boolean; error?: string }>('agy-text-agent:disable')).toEqual({
      ok: false,
      error: 'operation-failed',
    });
  });
});

describe('零工具 agent 解析器生产实现（createTextAgentResolverProduction）', () => {
  beforeEach(() => {
    warn.mockClear();
    __resetTextAgentNonCurrentWarnForTest();
  });

  it('三道门：无 CLI key → undefined（零 store/文件读）；missing → undefined；current → 布局常量激活值；declined → undefined', () => {
    const realHome = mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-resolver-home-'));
    try {
      let keyPresent = true;
      const store = createAgyTextAgentConsentStore({ filePath: tempConsentFile() });
      const resolver = createTextAgentResolverProduction(
        agyTextAgentProductionDeps({
          consentStore: () => store,
          cliKeyPresent: () => keyPresent,
          realHome,
        }),
      );

      keyPresent = false;
      expect(resolver()).toBeUndefined(); // 无 key 门先决（文件不存在也零影响）
      keyPresent = true;
      expect(resolver()).toBeUndefined(); // 文件 missing → undefined + warn（γ 兜底方向）

      mkdirSync(path.dirname(textAgentFilePath(realHome)), { recursive: true });
      writeFileSync(textAgentFilePath(realHome), renderAgentMarkdown(CLOSURE_TEXT_AGENT), 'utf8');
      expect(resolver()).toBe(CLOSURE_TEXT_AGENT_LAYOUT.agentName);

      store.markDeclined();
      expect(resolver()).toBeUndefined(); // declined 用户选择压一切
    } finally {
      rmBestEffort(realHome);
    }
  });

  it('CR-10：非 current 态 warn 进程级一次（长蒸馏链逐 spawn 不刷屏）；current 恢复零 warn', () => {
    const realHome = mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-resolver-warn-'));
    try {
      const store = createAgyTextAgentConsentStore({ filePath: tempConsentFile() });
      const resolver = createTextAgentResolverProduction(
        agyTextAgentProductionDeps({ consentStore: () => store, cliKeyPresent: () => true, realHome }),
      );
      expect(resolver()).toBeUndefined(); // 第 1 次 missing → warn
      expect(resolver()).toBeUndefined(); // 第 2/3 次 spawn → 静默（旗已耗）
      expect(resolver()).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({ component: 'agy-text-agent', state: 'missing' });

      mkdirSync(path.dirname(textAgentFilePath(realHome)), { recursive: true });
      writeFileSync(textAgentFilePath(realHome), renderAgentMarkdown(CLOSURE_TEXT_AGENT), 'utf8');
      expect(resolver()).toBe(CLOSURE_TEXT_AGENT_LAYOUT.agentName);
      expect(warn).toHaveBeenCalledTimes(1); // current 路径零 warn
    } finally {
      rmBestEffort(realHome);
    }
  });

  it('CR-5：corrupt（坏 consent 文件）视同 declined → undefined 且静默（不触文件读）', () => {
    const realHome = mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-resolver-corrupt-'));
    try {
      const file = tempConsentFile();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{broken', 'utf8');
      const store = createAgyTextAgentConsentStore({ filePath: file });
      const resolver = createTextAgentResolverProduction(
        agyTextAgentProductionDeps({ consentStore: () => store, cliKeyPresent: () => true, realHome }),
      );
      expect(resolver()).toBeUndefined();
    } finally {
      rmBestEffort(realHome);
    }
  });
});

describe('启动对账生产实现（reconcileTextAgentAtStartupProduction）', () => {
  it('enabled → 文件落盘 current；declined → 不写（disabled 不补写）', () => {
    const realHome = mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-reconcile-home-'));
    try {
      const store = createAgyTextAgentConsentStore({ filePath: tempConsentFile() });
      const deps = () =>
        agyTextAgentProductionDeps({ consentStore: () => store, cliKeyPresent: () => true, realHome });

      reconcileTextAgentAtStartupProduction(deps());
      expect(readFileSync(textAgentFilePath(realHome), 'utf8')).toBe(renderAgentMarkdown(CLOSURE_TEXT_AGENT));

      store.markDeclined();
      rmBestEffort(textAgentFilePath(realHome));
      reconcileTextAgentAtStartupProduction(deps());
      expect(existsSync(textAgentFilePath(realHome))).toBe(false);
    } finally {
      rmBestEffort(realHome);
    }
  });
});
