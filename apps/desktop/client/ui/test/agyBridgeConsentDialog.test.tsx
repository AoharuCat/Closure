/**
 * 子4 W6（design §4.3/§8 E2E 清单）：知情同意对话框——三态组件测试。
 *
 * - 征询态（missing-consent）：披露四件（拷贝内容含凭据 / 落点 + homeRoot 实显 /
 *   生命周期 / 全局零写入）+ ToS 备注（共享组件，文案单源 settings.cliTosRiskNote）
 *   + 「立即授权」/「暂不启用」两路。
 * - 「暂不启用」= 记住拒绝（declined 落盘 + 关闭）——dispatch 拍板：关闭路径不可绕过。
 * - 「立即授权」→ 写后视图 ok → 关闭；写后视图 conflict（用户 deny/ask 压制）→ 对话框
 *   翻冲突态（规则原文 + 指引，无授权钮）。
 * - 冲突 ask 态：规则列表 + 指引 + 仅「关闭」（纯收起——不持久化任何同意值）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgyBridgeConsentDialog, AGY_GEMINI_COPY_SIZE_HINT_MB } from '../src/features/agent-panel/AgyBridgeConsentDialog';
import { useAppStore } from '../src/shared/store/appStore';
import { __resetAgyBridgeStoreForTest, useAgyBridgeStore } from '../src/shared/store/agyBridgeStore';
import type { AgyBridgeConsentResult, AgyBridgeStatusView } from '@orison/shared-contracts';

const bridgeMocks = vi.hoisted(() => ({
  agyBridgeStatus: vi.fn(),
  agyBridgeSetConsent: vi.fn(),
  agyBridgeRevoke: vi.fn(),
}));

function view(overrides: Partial<AgyBridgeStatusView> = {}): AgyBridgeStatusView {
  return {
    state: 'ok',
    conflicts: [],
    consent: 'allowed',
    homeRoot: 'C:/Users/reader/.orison/agy-bridge/home',
    consentFilePath: 'C:/Users/reader/.orison/agy-bridge/consent.json',
    ...overrides,
  };
}

beforeEach(() => {
  __resetAgyBridgeStoreForTest();
  (window as unknown as { orisonDesktop: unknown }).orisonDesktop = bridgeMocks;
  bridgeMocks.agyBridgeStatus.mockReset().mockResolvedValue(view({ state: 'missing-consent', consent: undefined }));
  bridgeMocks.agyBridgeSetConsent.mockReset();
  useAppStore.setState({ resolvedLocale: 'zh-CN' } as ReturnType<typeof useAppStore.getState>);
});

afterEach(() => cleanup());

function openAsk(state: 'missing-consent' | 'conflict', conflicts: string[] = []): void {
  useAgyBridgeStore.getState().openAsk({ state, conflicts });
}

describe('知情同意对话框 - 征询态', () => {
  it('披露四件 + 副本根路径实显 + ToS 备注（单源键文案在场）', async () => {
    openAsk('missing-consent');
    render(<AgyBridgeConsentDialog />);
    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent!;
    expect(text).toContain('会复制什么');
    // CR-18：MB 数走探测常量插值（单源注明来源——测试锚同步引用常量，不手抄字面量）。
    expect(text).toContain(`${AGY_GEMINI_COPY_SIZE_HINT_MB}MB`);
    expect(text).toContain('登录凭据');
    expect(text).toContain('存放在哪里');
    // homeRoot 来自打开时的状态面拉取（异步）——等待到位。
    await waitFor(() => expect(dialog.textContent).toContain('C:/Users/reader/.orison/agy-bridge/home'));
    expect(dialog.textContent).toContain('何时清理');
    expect(dialog.textContent).toContain('不会被改动');
    // ToS 备注 = 共享组件消费 settings.cliTosRiskNote（zh 文案锚点）。
    expect(dialog.textContent).toContain('服务条款');
    // 两路：立即授权 / 暂不启用。
    expect(screen.getByRole('button', { name: '立即授权' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂不启用' })).toBeTruthy();
  });

  it('「立即授权」→ consent 写 allowed + 写后视图 ok → 对话框关闭', async () => {
    openAsk('missing-consent');
    render(<AgyBridgeConsentDialog />);
    bridgeMocks.agyBridgeSetConsent.mockResolvedValue({ ok: true, view: view() } as AgyBridgeConsentResult);

    fireEvent.click(screen.getByRole('button', { name: '立即授权' }));
    await waitFor(() => expect(bridgeMocks.agyBridgeSetConsent).toHaveBeenCalledWith({ consent: 'allowed' }));
    await waitFor(() => expect(useAgyBridgeStore.getState().ask).toBeNull());
    expect(useAgyBridgeStore.getState().status?.state).toBe('ok');
  });

  it('「立即授权」→ 写后视图 conflict（用户 deny/ask 压制）→ 对话框翻冲突态（规则原文 + 无授权钮）', async () => {
    openAsk('missing-consent');
    render(<AgyBridgeConsentDialog />);
    bridgeMocks.agyBridgeSetConsent.mockResolvedValue({
      ok: true,
      view: view({ state: 'conflict', consent: 'allowed', conflicts: ['mcp(novel-writing/*)'] }),
    } as AgyBridgeConsentResult);

    fireEvent.click(screen.getByRole('button', { name: '立即授权' }));
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain('权限规则冲突');
      expect(dialog.textContent).toContain('mcp(novel-writing/*)');
    });
    // 冲突态只有「关闭」（footer）——无授权路径。头部 X 钮同语义不另列。
    expect(screen.queryByRole('button', { name: '立即授权' })).toBeNull();
    expect(document.querySelector('.agybridge-consent-footer button')).toBeTruthy();
  });

  it('「暂不启用」→ consent 写 declined（记住选择）+ 关闭', async () => {
    openAsk('missing-consent');
    render(<AgyBridgeConsentDialog />);
    bridgeMocks.agyBridgeSetConsent.mockResolvedValue({
      ok: true,
      view: view({ state: 'declined', consent: 'declined' }),
    } as AgyBridgeConsentResult);

    fireEvent.click(screen.getByRole('button', { name: '暂不启用' }));
    await waitFor(() => expect(bridgeMocks.agyBridgeSetConsent).toHaveBeenCalledWith({ consent: 'declined' }));
    await waitFor(() => expect(useAgyBridgeStore.getState().ask).toBeNull());
  });

  it('CR-11：authorize 在途时 Esc/遮罩/X 全部不吃（不触发 declined 并发写）', async () => {
    openAsk('missing-consent');
    render(<AgyBridgeConsentDialog />);
    let release!: (value: AgyBridgeConsentResult) => void;
    bridgeMocks.agyBridgeSetConsent.mockImplementation(
      () => new Promise<AgyBridgeConsentResult>((resolve) => {
        release = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '立即授权' }));
    // 在途窗口：三个关闭出口（Esc / 遮罩 / 头部 X）都不得并发写 declined。
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.agybridge-consent-overlay') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(bridgeMocks.agyBridgeSetConsent).toHaveBeenCalledTimes(1); // 仅 authorize 那一次
    expect(bridgeMocks.agyBridgeSetConsent).not.toHaveBeenCalledWith({ consent: 'declined' });
    // authorize 完成：allowed 落定 + 对话框正常关闭（在途期间未被 dismiss 抢跑）。
    release({ ok: true, view: view() } as AgyBridgeConsentResult);
    await waitFor(() => expect(useAgyBridgeStore.getState().ask).toBeNull());
    expect(bridgeMocks.agyBridgeSetConsent).toHaveBeenCalledWith({ consent: 'allowed' });
  });
});

describe('知情同意对话框 - 冲突态', () => {
  it('规则原文 + 指引 + 仅「关闭」；关闭 = 纯收起（不持久化任何同意值）', async () => {
    openAsk('conflict', ['mcp(novel-writing/*)', 'mcp(*)']);
    render(<AgyBridgeConsentDialog />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('mcp(novel-writing/*)');
    expect(dialog.textContent).toContain('mcp(*)');
    expect(dialog.textContent).toContain('不会代你改动这些规则');
    expect(screen.queryByRole('button', { name: '立即授权' })).toBeNull();

    // footer 的「关闭」钮（头部 X 钮同名 aria-label——用容器定位唯一化）。
    const footerClose = document.querySelector('.agybridge-consent-footer button') as HTMLElement;
    fireEvent.click(footerClose);
    await waitFor(() => expect(useAgyBridgeStore.getState().ask).toBeNull());
    expect(bridgeMocks.agyBridgeSetConsent).not.toHaveBeenCalled();
  });
});

describe('知情同意对话框 - 挂载门', () => {
  it('无 ask → 不渲染', () => {
    const { container } = render(<AgyBridgeConsentDialog />);
    expect(container.querySelector('.agybridge-consent-overlay')).toBeNull();
  });
});
