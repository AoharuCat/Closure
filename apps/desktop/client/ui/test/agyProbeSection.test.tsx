// 「反重力状态探测」卡片（AgyProbeSection）：四态徽标渲染（未探测/连接正常/登录失效/
// 探测失败）+ 行内「测试连接」触发与在途禁用 + 空 key 守卫 + 挂载读失败降级 +
// IPC 通道抛错的 toast/日志面。
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyEntry, CliProbeSnapshot } from '@orison/shared-contracts';
import { AgyProbeSection } from '../src/features/model-settings/AgyProbeSection';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

// 带变量的 t：把插值实参编码进文本，断言 {time} 等变量确实传给了翻译层。
const tVars = (key: string, vars?: Record<string, string | number>) =>
  vars && Object.keys(vars).length > 0 ? `${key}|${JSON.stringify(vars)}` : key;

const OK_AT = '2026-09-19T00:30:00.000Z';

function cliKey(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    id: 'agy1',
    name: 'Antigravity',
    protocol: 'antigravity-cli',
    cliExecutable: 'C:/agy/bin/agy.exe',
    models: [{ id: 'gemini-3.8-pro-high', alias: 'Gemini 3.8 Pro', capability: 'text', enabled: true }],
    ...overrides,
  };
}

type DesktopStub = {
  cliProbeStatus?: ReturnType<typeof vi.fn>;
  cliProbeRun?: ReturnType<typeof vi.fn>;
};

function renderSection(cliKeys: ApiKeyEntry[]) {
  return render(<AgyProbeSection cliKeys={cliKeys} t={tVars} />);
}

function stubDesktop(stub: DesktopStub) {
  (window as unknown as { orisonDesktop: unknown }).orisonDesktop = { ...stub };
}

beforeEach(() => {
  useAppStore.setState({ outputEntries: [], appendOutputEntry: vi.fn() } as never);
  useToastStore.setState({ toasts: [] });
  stubDesktop({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
});

describe('AgyProbeSection 守卫', () => {
  it('无 CLI key → 不渲染', () => {
    const { container } = renderSection([]);
    expect(container.querySelector('.agy-probe-section')).toBeNull();
  });
});

describe('AgyProbeSection 四态渲染', () => {
  it('挂载即拉最近探针结果；无快照的 key 显示「未探测」', async () => {
    stubDesktop({ cliProbeStatus: vi.fn().mockResolvedValue({}) });
    renderSection([cliKey()]);
    expect(await screen.findByText('settings.cliProbeUnprobed')).toBeTruthy();
    expect(window.orisonDesktop.cliProbeStatus).toHaveBeenCalledTimes(1);
  });

  it('ok 快照 → 连接正常徽标，探测时间经 {time} 插值传入', async () => {
    stubDesktop({
      cliProbeStatus: vi.fn().mockResolvedValue({
        agy1: { keyId: 'agy1', status: 'ok', probedAt: OK_AT } satisfies CliProbeSnapshot,
      }),
    });
    renderSection([cliKey()]);
    // 00:30 UTC = 本地时区展示面，断言只锁定键名与变量编码（时区无关）。
    expect(
      await screen.findByText(/settings\.cliProbeStatusOk\|\{"time":"\d{2}:\d{2}"\}/),
    ).toBeTruthy();
  });

  it('auth-dead 快照 → 「登录已失效」徽标 + 指引行（切换账号 / 终端重新登录）', async () => {
    stubDesktop({
      cliProbeStatus: vi.fn().mockResolvedValue({
        agy1: { keyId: 'agy1', status: 'auth-dead', probedAt: OK_AT } satisfies CliProbeSnapshot,
      }),
    });
    renderSection([cliKey()]);
    expect(await screen.findByText('settings.cliProbeAuthDead')).toBeTruthy();
    expect(screen.getByText('settings.cliProbeAuthDeadHint')).toBeTruthy();
  });

  it('error 快照 → 「探测失败」徽标，原始摘要在 tooltip（title）', async () => {
    stubDesktop({
      cliProbeStatus: vi.fn().mockResolvedValue({
        agy1: {
          keyId: 'agy1',
          status: 'error',
          probedAt: OK_AT,
          detail: 'probe timed out after 30s',
        } satisfies CliProbeSnapshot,
      }),
    });
    renderSection([cliKey()]);
    const chip = await screen.findByText('settings.cliProbeFailed');
    expect(chip.getAttribute('title')).toContain('probe timed out after 30s');
  });

  it('多 CLI key 逐行渲染，快照按 keyId 对号入座', async () => {
    stubDesktop({
      cliProbeStatus: vi.fn().mockResolvedValue({
        agy2: { keyId: 'agy2', status: 'ok', probedAt: OK_AT } satisfies CliProbeSnapshot,
      }),
    });
    renderSection([cliKey({ id: 'agy1', name: 'Antigravity A' }), cliKey({ id: 'agy2', name: 'Antigravity B' })]);
    expect(await screen.findByText('Antigravity A')).toBeTruthy();
    expect(screen.getByText('Antigravity B')).toBeTruthy();
    // 只有 agy2 有快照：恰好一处连接正常、一处未探测。
    expect(screen.getAllByText(/settings\.cliProbeStatusOk\|/)).toHaveLength(1);
    expect(screen.getAllByText('settings.cliProbeUnprobed')).toHaveLength(1);
  });

  it('初始读取失败 → 如实退到全行「未探测」，不崩', async () => {
    stubDesktop({ cliProbeStatus: vi.fn().mockRejectedValue(new Error('bridge gone')) });
    renderSection([cliKey()]);
    expect(await screen.findByText('settings.cliProbeUnprobed')).toBeTruthy();
  });
});

describe('AgyProbeSection 测试连接动作', () => {
  it('点击 → cliProbeRun({ keyId }) 按行触发；结算后徽标刷新为新快照', async () => {
    stubDesktop({
      cliProbeStatus: vi.fn().mockResolvedValue({}),
      cliProbeRun: vi
        .fn()
        .mockResolvedValue({ keyId: 'agy1', status: 'ok', probedAt: OK_AT } satisfies CliProbeSnapshot),
    });
    renderSection([cliKey()]);
    await screen.findByText('settings.cliProbeUnprobed');

    await userEvent.click(screen.getByRole('button', { name: 'settings.cliProbeButton' }));

    await waitFor(() => expect(window.orisonDesktop.cliProbeRun).toHaveBeenCalledWith({ keyId: 'agy1' }));
    expect(await screen.findByText(/settings\.cliProbeStatusOk\|/)).toBeTruthy();
  });

  it('在途 → 本行按钮 disabled + 转圈图标；他行不受影响', async () => {
    let resolveProbe!: (value: CliProbeSnapshot) => void;
    stubDesktop({
      cliProbeStatus: vi.fn().mockResolvedValue({}),
      cliProbeRun: vi.fn().mockImplementation(
        () => new Promise<CliProbeSnapshot>((res) => { resolveProbe = res; }),
      ),
    });
    renderSection([cliKey({ id: 'agy1', name: 'A' }), cliKey({ id: 'agy2', name: 'B' })]);
    await screen.findAllByText('settings.cliProbeUnprobed');

    const buttons = screen.getAllByRole('button', { name: 'settings.cliProbeButton' });
    await userEvent.click(buttons[0]!);

    // 第一行在途禁用 + 转圈；第二行仍可点。
    await waitFor(() => expect(buttons[0]!.hasAttribute('disabled')).toBe(true));
    expect(buttons[1]!.hasAttribute('disabled')).toBe(false);
    expect(document.querySelector('.material-symbols-outlined.is-spinning')).not.toBeNull();

    await act(async () => {
      resolveProbe({ keyId: 'agy1', status: 'auth-dead', probedAt: OK_AT });
    });
    await waitFor(() => expect(buttons[0]!.hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('settings.cliProbeAuthDead')).toBeTruthy();
    expect(screen.getByText('settings.cliProbeAuthDeadHint')).toBeTruthy();
  });

  it('IPC 通道抛错（预期失败走快照，抛错即桥不可用）→ toast + 输出日志，原状态保留', async () => {
    stubDesktop({
      cliProbeStatus: vi.fn().mockResolvedValue({
        agy1: { keyId: 'agy1', status: 'ok', probedAt: OK_AT } satisfies CliProbeSnapshot,
      }),
      cliProbeRun: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
    });
    renderSection([cliKey()]);
    await screen.findByText(/settings\.cliProbeStatusOk\|/);

    await userEvent.click(screen.getByRole('button', { name: 'settings.cliProbeButton' }));

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]!.level).toBe('error');
    expect(useToastStore.getState().toasts[0]!.message).toBe('settings.cliProbeRunFailed');
    // 诊断面：原始 detail 进输出日志（key 维度兜底——界面本地化、日志保真）。
    expect(useAppStore.getState().appendOutputEntry).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'gateway unavailable' }),
    );
    // 状态不被错误覆盖：仍显示上一次 ok 快照。
    expect(screen.getByText(/settings\.cliProbeStatusOk\|/)).toBeTruthy();
  });
});
