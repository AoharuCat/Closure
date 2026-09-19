import { describe, expect, it, vi } from 'vitest';

const { appMock } = vi.hoisted(() => ({ appMock: { getVersion: () => '0.1.0', isPackaged: false } }));

vi.mock('electron', () => ({
  app: appMock,
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  default: { autoUpdater: { on: vi.fn() } },
}));

vi.mock('../main/logger', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { canSelfUpdate, checkForUpdate, compareSemver, isMajorBump } from '../main/ipc/updateIpc';

describe('canSelfUpdate', () => {
  it('is false when the app is not packaged (dev / portable)', () => {
    // The electron mock reports isPackaged: false, so self-update is disabled
    // and the portable GitHub-API fallback path is taken instead.
    expect(canSelfUpdate()).toBe(false);
  });
});

describe('checkForUpdate（portable 回退：GitHub API 直查，UPDATE_REPO 已回填）', () => {
  it('packaged 无 app-update.yml → 查 GitHub API，远端更新 → available + 手动下载', async () => {
    appMock.isPackaged = true;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tag_name: 'v0.2.0', body: 'release notes' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      // canSelfUpdate(): process.resourcesPath 在 node 测试环境未定义 → existsSync 守卫
      // 抛出被吞 → false → 走 checkViaGitHubApi → fetch api.github.com latest。
      const result = await checkForUpdate();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('api.github.com/repos/AoharuCat/Closure');
      expect(result.status).toBe('available');
      expect(result).toMatchObject({ currentVersion: '0.1.0', latestVersion: '0.2.0', manual: true });
    } finally {
      appMock.isPackaged = false;
      vi.unstubAllGlobals();
    }
  });

  it('远端不比当前新 → up-to-date', async () => {
    appMock.isPackaged = true;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tag_name: 'v0.1.0' }) }),
    );
    try {
      const result = await checkForUpdate();
      expect(result).toMatchObject({ status: 'up-to-date', currentVersion: '0.1.0', latestVersion: '0.1.0' });
    } finally {
      appMock.isPackaged = false;
      vi.unstubAllGlobals();
    }
  });

  it('GitHub API 非 2xx → error 状态', async () => {
    appMock.isPackaged = true;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    try {
      const result = await checkForUpdate();
      expect(result).toMatchObject({ status: 'error', message: 'GitHub API 403' });
    } finally {
      appMock.isPackaged = false;
      vi.unstubAllGlobals();
    }
  });
});

describe('compareSemver', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('0.2.0', '0.3.0')).toBeLessThan(0);
  });

  it('tolerates a leading v and pre-release suffix', () => {
    expect(compareSemver('v2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2.0-beta.1', '1.2.0')).toBe(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.1', '1.0.5')).toBeGreaterThan(0);
  });
});

describe('isMajorBump', () => {
  it('is true only when the major version increases', () => {
    expect(isMajorBump('1.4.0', '2.0.0')).toBe(true);
    expect(isMajorBump('0.9.0', '1.0.0')).toBe(true);
  });

  it('is false for minor/patch bumps and same major', () => {
    expect(isMajorBump('1.0.0', '1.5.0')).toBe(false);
    expect(isMajorBump('2.0.0', '2.0.1')).toBe(false);
  });

  it('is false when major does not increase', () => {
    expect(isMajorBump('2.0.0', '1.9.0')).toBe(false);
  });

  it('tolerates a leading v', () => {
    expect(isMajorBump('v1.0.0', 'v2.0.0')).toBe(true);
  });
});
