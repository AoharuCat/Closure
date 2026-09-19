import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgyTextAgentStatusView } from '@orison/shared-contracts';
import { AgyTextAgentSection } from '../src/features/model-settings/AgyTextAgentSection';
import { useToastStore } from '../src/shared/store/toastStore';
import { translate } from '../src/shared/i18n/useI18n';

// ── 09-19 CLI 白名单 W4：「Closure 文本 Agent」卡片行为测试 ──
//
// 消费面 = shell agyTextAgentIpc 三通道（W3 已落地，本包只消费）：status / enable /
// disable。测试经 mock `window.orisonDesktop` 注入（ui 测试纪律：不触碰真实 IPC/FS）。
// t 用真 zh-CN 词表（translate）——披露文案/四态文案按「真实中文呈现」断言，不测键名。

const t = (key: string, vars?: Record<string, string | number>): string =>
  translate('zh-CN', key, vars);

const OUR_PATH = 'C:/Users/u/.gemini/config/agents/closure-text/agent.md';

function viewOf(overrides: Partial<AgyTextAgentStatusView>): AgyTextAgentStatusView {
  return {
    enabled: true,
    cliKeyPresent: true,
    fileState: 'current',
    shadowedBy: [],
    agentFilePath: OUR_PATH,
    consentFilePath: 'C:/Users/u/.orison/agy-text-agent/consent.json',
    ...overrides,
  };
}

const CURRENT_VIEW = viewOf({});

describe('AgyTextAgentSection', () => {
  let statusMock: ReturnType<typeof vi.fn>;
  let enableMock: ReturnType<typeof vi.fn>;
  let disableMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    statusMock = vi.fn(async () => CURRENT_VIEW);
    enableMock = vi.fn(async () => ({ ok: true, view: CURRENT_VIEW }));
    disableMock = vi.fn(async () => ({
      ok: true,
      view: viewOf({ enabled: false, fileState: 'missing' }),
    }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('挂载拉一次 status（无轮询），渲染标题/行为披露/写入位置路径', async () => {
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(t('agyTextAgent.sectionTitle'))).toBeTruthy();
    // 行为披露四条常显（真实文案）。
    expect(screen.getByText(t('agyTextAgent.disclosureFile'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.disclosureReconcile'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.disclosureDisable'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.disclosureIndependent'))).toBeTruthy();
    // 写入位置路径取自 IPC status（不前端硬编码）。
    expect(screen.getByText(OUR_PATH)).toBeTruthy();
    // current 态附注 + 默认开启（无 declined 记录 = 开启）。
    expect(screen.getByText(t('agyTextAgent.stateEnabled'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.noteCurrent'))).toBeTruthy();
    // 稳定后不再有第二次 status 拉取（无轮询——启动对账 + 动作后刷新足够）。
    await new Promise((r) => setTimeout(r, 20));
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it('开启态点「关闭」→ 调 disable（无 confirm 直翻）+ 回显视图翻转 + info toast', async () => {
    const user = userEvent.setup();
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: t('agyTextAgent.disable') }));
    await waitFor(() => expect(disableMock).toHaveBeenCalledTimes(1));
    // 回显视图落地：开关翻为已关闭 + missing 态（disable 删自有文件）。
    await waitFor(() => expect(screen.getByText(t('agyTextAgent.stateDisabled'))).toBeTruthy());
    expect(screen.getByText(t('agyTextAgent.stateMissing'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.disabledNote'))).toBeTruthy();
    expect(screen.queryByText(t('agyTextAgent.noteCurrent'))).toBeNull();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('info');
    expect(toasts[0].message).toBe(t('agyTextAgent.disableDone'));
  });

  it('关闭态点「开启」→ 调 enable + success toast', async () => {
    const user = userEvent.setup();
    statusMock = vi.fn(async () => viewOf({ enabled: false, fileState: 'missing' }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: t('agyTextAgent.enable') }));
    await waitFor(() => expect(enableMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(t('agyTextAgent.stateEnabled'))).toBeTruthy());
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('success');
    expect(toasts[0].message).toBe(t('agyTextAgent.enableDone'));
  });

  it('四态渲染：stale 警示徽标 + 陈旧附注；missing 中性徽标 + 缺失附注', async () => {
    statusMock = vi.fn(async () => viewOf({ fileState: 'stale' }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    const { unmount } = render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.getByText(t('agyTextAgent.stateStale'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.noteStale'))).toBeTruthy();
    unmount();

    statusMock = vi.fn(async () => viewOf({ fileState: 'missing' }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.getByText(t('agyTextAgent.stateMissing'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.noteMissing'))).toBeTruthy();
  });

  it('foreign 冲突态：完整路径呈报 + 「不覆盖、不代删」指引（绝不代删）', async () => {
    statusMock = vi.fn(async () => viewOf({ fileState: 'foreign' }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.getByText(t('agyTextAgent.stateForeign'))).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.foreignTitle'))).toBeTruthy();
    // 路径出现在事实行 + 冲突块两处（完整路径原样展示）。
    expect(screen.getAllByText(OUR_PATH).length).toBeGreaterThanOrEqual(2);
    // 指引语义：不代删，用户自行处理。
    expect(screen.getByText(t('agyTextAgent.foreignHint'))).toBeTruthy();
    expect(t('agyTextAgent.foreignHint')).toContain('不覆盖、不代删');
  });

  it('shadowedBy 非空 → 同名遮蔽警示块列出全部路径（agy 静默覆盖加载风险）', async () => {
    const shadowA = 'C:/Users/u/.gemini/config/agents/closure-text-copy/agent.md';
    const shadowB = 'C:/Users/u/.gemini/config/agents/other/agent.md';
    statusMock = vi.fn(async () => viewOf({ shadowedBy: [shadowA, shadowB] }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.getByText(t('agyTextAgent.shadowTitle'))).toBeTruthy();
    expect(screen.getByText(shadowA)).toBeTruthy();
    expect(screen.getByText(shadowB)).toBeTruthy();
    expect(screen.getByText(t('agyTextAgent.shadowHint'))).toBeTruthy();
  });

  it('enable 撞外来冲突 → 错误面如实（error toast）+ 重拉状态让冲突块就地呈现', async () => {
    const user = userEvent.setup();
    // 计数式实现（第 1 次拉 = missing 关闭态；第 2 次拉 = foreign）——组件重拉发生在
    // 点击 promise 之后、本测试下一行断言之前，逐次 mockImplementation 有竞态。
    let statusCalls = 0;
    statusMock = vi.fn(async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? viewOf({ enabled: false, fileState: 'missing' })
        : viewOf({ enabled: true, fileState: 'foreign' });
    });
    enableMock = vi.fn(async () => ({ ok: false, error: 'foreign-conflict' }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: t('agyTextAgent.enable') }));
    await waitFor(() => expect(enableMock).toHaveBeenCalledTimes(1));
    // 错误 toast（外来冲突专属文案）。
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('error');
    expect(toasts[0].message).toBe(t('agyTextAgent.enableForeignConflict'));
    // enable 失败结果不带视图 → 组件重拉 status（第 2 次 = foreign）→ 冲突块就地呈现。
    await waitFor(() => expect(screen.getByText(t('agyTextAgent.foreignTitle'))).toBeTruthy());
    await waitFor(() => expect(screen.getByText(t('agyTextAgent.stateForeign'))).toBeTruthy());
  });

  it('status 读取失败 → 失败块 + 重新检测可恢复', async () => {
    const user = userEvent.setup();
    statusMock = vi.fn(async () => null);
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(t('agyTextAgent.statusFailed'))).toBeTruthy();
    statusMock.mockImplementation(async () => CURRENT_VIEW);
    await user.click(screen.getByRole('button', { name: t('agyTextAgent.recheck') }));
    await waitFor(() => expect(screen.getByText(t('agyTextAgent.stateEnabled'))).toBeTruthy());
  });

  // ── CR-9①：「立即写入」次级钮（enabled + missing/stale 态在位）──

  it('CR-9① missing 态「立即写入」：在位 → 点按调 enable → 回显 current + writeNowDone toast', async () => {
    const user = userEvent.setup();
    statusMock = vi.fn(async () => viewOf({ fileState: 'missing' }));
    enableMock = vi.fn(async () => ({ ok: true, view: CURRENT_VIEW }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    const writeNow = screen.getByRole('button', { name: t('agyTextAgent.writeNow') });
    expect(writeNow).toBeTruthy();
    // 文案指向新钮（CR-9③：不必先关再开 / 不必等下次启动）。
    expect(screen.getByText(t('agyTextAgent.noteMissing'))).toBeTruthy();
    await user.click(writeNow);
    await waitFor(() => expect(enableMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(t('agyTextAgent.stateCurrent'))).toBeTruthy());
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('success');
    expect(toasts[0].message).toBe(t('agyTextAgent.writeNowDone'));
  });

  it('CR-9① stale 态「立即写入」在位点按生效；current 态无该钮（无可补写面）', async () => {
    const user = userEvent.setup();
    statusMock = vi.fn(async () => viewOf({ fileState: 'stale' }));
    enableMock = vi.fn(async () => ({ ok: true, view: CURRENT_VIEW }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    const { unmount } = render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: t('agyTextAgent.writeNow') }));
    await waitFor(() => expect(enableMock).toHaveBeenCalledTimes(1));
    unmount();

    // current 态：无「立即写入」（版本已当前——无补写语义）。
    statusMock = vi.fn(async () => CURRENT_VIEW);
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: t('agyTextAgent.writeNow') })).toBeNull();
  });

  it('CR-9② turnOff 失败：错误 toast + 重拉状态（卡面收敛盘上真相，不留陈旧开关）', async () => {
    const user = userEvent.setup();
    let statusCalls = 0;
    statusMock = vi.fn(async () => {
      statusCalls += 1;
      // 第 2 次拉取 = 重拉结果（disable 失败后盘上仍为开启态）。
      return CURRENT_VIEW;
    });
    disableMock = vi.fn(async () => ({ ok: false, error: 'operation-failed' }));
    (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
      agyTextAgentStatus: statusMock,
      agyTextAgentEnable: enableMock,
      agyTextAgentDisable: disableMock,
    };
    render(<AgyTextAgentSection t={t} />);
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: t('agyTextAgent.disable') }));
    await waitFor(() => expect(disableMock).toHaveBeenCalledTimes(1));
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('error');
    expect(toasts[0].message).toBe(t('agyTextAgent.disableFailed'));
    // 失败不带视图 → 组件重拉 status（第 2 次）——卡面停在与盘上真相一致的开启态。
    await waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(t('agyTextAgent.stateEnabled'))).toBeTruthy();
  });
});
