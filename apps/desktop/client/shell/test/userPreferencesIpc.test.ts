import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferencesConfig } from '@orison/shared-contracts';

const { handle, safeStorage, app } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  // registerConfigIpc 授权 orison-file 读 userData/wallpaper（08-25 背景）→ 需要 getPath。
  app: { getPath: vi.fn(() => `${process.cwd()}/test-tmp-user-prefs/userData`) },
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  app,
}));

const TEST_HOME = path.join(process.cwd(), 'test-tmp-user-prefs');

// User-preferences path derives from os.homedir(); point it at a temp dir.
vi.spyOn(os, 'homedir').mockReturnValue(TEST_HOME);

import { registerConfigIpc } from '../main/ipc/configIpc';

function getHandlers() {
  handle.mockReset();
  registerConfigIpc();
  const save = handle.mock.calls.find(([c]) => c === 'config:save-user-preferences')![1];
  const load = handle.mock.calls.find(([c]) => c === 'config:load-user-preferences')![1];
  return { save, load };
}

describe('user preferences IPC round-trip', () => {
  beforeEach(() => {
    rmBestEffort(TEST_HOME);
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    rmBestEffort(TEST_HOME);
  });

  it('persists all fields, including previously-dropped writing/appearance settings', async () => {
    const { save, load } = getHandlers();
    const written: UserPreferencesConfig = {
      theme: 'dark',
      locale: 'zh-CN',
      autoCheckUpdates: false,
      readingFontWeight: 500,
      readingFontScale: 1.15,
      paragraphIndent: false,
      showWordCount: false,
      autoSaveEnabled: false,
      autoSaveInterval: 5000,
      spellCheck: true,
      wordCountGoal: 8000,
      editorLineHeight: 2.0,
      wallpaperUrl: 'orison-file:///C:/Users/t/AppData/Roaming/Closure/wallpaper/bg.png',
      wallpaperOpacity: 0.6,
      wallpaperFrostBlur: 20,
      // R8 全局界面缩放。
      interfaceScale: 1.15,
      // 09-12 usage-panel R5 用量保留窗 roundtrip。
      usageRetentionDays: 30,
    };

    await save({}, written);
    const read = (await load({})) as UserPreferencesConfig;

    // The fields the old writeUserPreferences silently dropped are the regression focus.
    expect(read.paragraphIndent).toBe(false);
    expect(read.showWordCount).toBe(false);
    expect(read.editorLineHeight).toBe(2.0);
    // New creative settings round-trip too.
    expect(read.autoSaveEnabled).toBe(false);
    expect(read.autoSaveInterval).toBe(5000);
    expect(read.spellCheck).toBe(true);
    expect(read.wordCountGoal).toBe(8000);
    // Existing fields unchanged.（dogfood #43：autoApplyPatches 死配置已整链退役。）
    expect(read.theme).toBe('dark');
    expect(read.locale).toBe('zh-CN');
    expect(read.readingFontWeight).toBe(500);
    expect(read.readingFontScale).toBe(1.15);
    // 08-25 全窗口背景：URL + 透明度 roundtrip。08-29 磨砂滑杆化：强度数值同。
    expect(read.wallpaperUrl).toBe('orison-file:///C:/Users/t/AppData/Roaming/Closure/wallpaper/bg.png');
    expect(read.wallpaperOpacity).toBe(0.6);
    expect(read.wallpaperFrostBlur).toBe(20);
    // R8 界面缩放 roundtrip。
    expect(read.interfaceScale).toBe(1.15);
    // 09-12 usage-panel R5 用量保留窗 roundtrip。
    expect(read.usageRetentionDays).toBe(30);
  });

  it('wallpaper round-trip: clamps opacity into 0.1–1 and drops the url on clear', async () => {
    const { save, load } = getHandlers();

    // 手改盘文件越界（整文件覆盖写携带畸形值）→ 读路径钳回界内。
    await save({}, {
      theme: 'system',
      locale: 'system',
      wallpaperOpacity: 5,
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).wallpaperOpacity).toBe(1);

    await save({}, {
      theme: 'system',
      locale: 'system',
      wallpaperOpacity: 0.01,
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).wallpaperOpacity).toBe(0.1);

    // 恢复默认后再保存（无 wallpaperUrl）→ 盘上键随整文件覆盖写消失。
    await save({}, {
      theme: 'system',
      locale: 'system',
      wallpaperUrl: 'orison-file:///C:/w/a.png',
      wallpaperOpacity: 0.5,
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).wallpaperUrl).toBe('orison-file:///C:/w/a.png');
    await save({}, {
      theme: 'system',
      locale: 'system',
    } as UserPreferencesConfig);
    const cleared = (await load({})) as UserPreferencesConfig;
    expect(cleared.wallpaperUrl).toBeUndefined();
    // 无 wallpaperOpacity 键的存量文件 → 默认 1。
    expect(cleared.wallpaperOpacity).toBe(1);
    // 08-29 磨砂：无新键存量文件 → 默认 0（老配置零迁移；旧布尔键折算见 wallpaperIpc.test）。
    expect(cleared.wallpaperFrostBlur).toBe(0);
    // R8 界面缩放：无键存量文件 → 默认 1（不缩放）。
    expect(cleared.interfaceScale).toBe(1);
  });

  it('R8 界面缩放：越界值钳回合法带（0.85–1.3）；非法值回默认 1', async () => {
    const { save, load } = getHandlers();

    await save({}, {
      theme: 'system',
      locale: 'system',
      interfaceScale: 5,
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).interfaceScale).toBe(1.3);

    await save({}, {
      theme: 'system',
      locale: 'system',
      interfaceScale: 0.01,
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).interfaceScale).toBe(0.85);

    // NaN 不落盘（writeUserPreferences 的有限数值守卫）→ 盘上无键 → 读回默认 1。
    await save({}, {
      theme: 'system',
      locale: 'system',
      interfaceScale: Number.NaN,
    });
    expect(((await load({})) as UserPreferencesConfig).interfaceScale).toBe(1);
  });

  it('09-12 usage-panel R5 用量保留窗：写侧钳回 [7,730] 落盘；手改盘文件读侧归位；缺键回默认 90', async () => {
    const { save, load } = getHandlers();

    // 写侧 clamp-before-persist（防垃圾值入库）：越界值钳到边界后落盘，读回即边界值。
    await save({}, {
      theme: 'system',
      locale: 'system',
      usageRetentionDays: 6,
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).usageRetentionDays).toBe(7);

    await save({}, {
      theme: 'system',
      locale: 'system',
      usageRetentionDays: 731,
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).usageRetentionDays).toBe(730);

    // 读侧 lenient（flat YAML 可手改，interfaceScale 同款）：手写盘文件越界 → 读路径归位。
    mkdirSync(path.join(TEST_HOME, '.orison', 'user'), { recursive: true });
    writeFileSync(
      path.join(TEST_HOME, '.orison', 'user', 'preferences.yaml'),
      'theme: system\nlocale: system\nusageRetentionDays: 6\n',
      'utf-8',
    );
    expect(((await load({})) as UserPreferencesConfig).usageRetentionDays).toBe(7);

    // 缺键（存量文件零迁移）→ 默认 90。
    await save({}, {
      theme: 'system',
      locale: 'system',
    } as UserPreferencesConfig);
    expect(((await load({})) as UserPreferencesConfig).usageRetentionDays).toBe(90);
  });

  it('R8：保存偏好即时对发起方 webContents 施加界面缩放；非法值不施加也不抛', async () => {
    const { save, load } = getHandlers();
    const setZoomFactor = vi.fn();

    // 合法档：落盘后对 sender.setZoomFactor 即时施加（钳制后的值）。
    await save(
      { sender: { setZoomFactor } },
      { theme: 'system', locale: 'system', interfaceScale: 5 } as UserPreferencesConfig,
    );
    expect(setZoomFactor).toHaveBeenCalledWith(1.3);

    // 非法值（NaN）：不施加、不抛——盘面同样不收（见上一用例守卫）。
    setZoomFactor.mockClear();
    expect(() =>
      save(
        { sender: { setZoomFactor } },
        { theme: 'system', locale: 'system', interfaceScale: Number.NaN },
      ),
    ).not.toThrow();
    expect(setZoomFactor).not.toHaveBeenCalled();

    // 无 interfaceScale 键的普通偏好保存：完全不触碰 sender（旧调用面 save({}, …) 兼容）。
    await save({}, { theme: 'system', locale: 'system' } as UserPreferencesConfig);
    expect(setZoomFactor).not.toHaveBeenCalled();
  });

  it('falls back to defaults when the file is absent', async () => {
    const { load } = getHandlers();
    const read = (await load({})) as UserPreferencesConfig;
    expect(read.theme).toBe('system');
    expect(read.paragraphIndent).toBe(true);
    expect(read.editorLineHeight).toBe(1.75);
    expect(read.autoSaveInterval).toBe(1500);
  });
});
