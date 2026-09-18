/**
 * 子4 W6（design §4.4/§8 E2E 清单）：设置页「MCP 工具桥」小节组件测试。
 *
 * - 状态机四态：ok（已授权 + 关闭钮）/ missing-consent（未配置 + 立即授权）/
 *   conflict（规则原文 + 指引 + 重新检测，无授权钮）/ declined（已拒绝 + 重新授权 +
 *   纯文本降级说明）。
 * - 「立即授权」→ agy-bridge:consent(allowed) 写；写后视图刷新。
 * - 「关闭工具桥」：confirm（danger）确认 → agy-bridge:revoke；active-sessions 拒绝 →
 *   活动会话提示（不静默失败）。
 * - 副本根目录路径实显（status.homeRoot）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgyBridgeSection } from '../src/features/model-settings/AgyBridgeSection';
import { translate } from '../src/shared/i18n/useI18n';
import { __resetAgyBridgeStoreForTest, useAgyBridgeStore } from '../src/shared/store/agyBridgeStore';
import { useConfirmStore } from '../src/shared/store/confirmStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type { AgyBridgeConsentResult, AgyBridgeRevokeResult, AgyBridgeStatusView } from '@orison/shared-contracts';

const bridgeMocks = vi.hoisted(() => ({
  agyBridgeStatus: vi.fn(),
  agyBridgeSetConsent: vi.fn(),
  agyBridgeRevoke: vi.fn(),
}));

const t = (key: string, vars?: Record<string, string | number>): string => translate('zh-CN', key, vars);

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
  useConfirmStore.getState().resolveConfirm(false);
  useToastStore.setState({ toasts: [] });
  (window as unknown as { orisonDesktop: unknown }).orisonDesktop = bridgeMocks;
  bridgeMocks.agyBridgeStatus.mockReset().mockResolvedValue(view());
  bridgeMocks.agyBridgeSetConsent.mockReset();
  bridgeMocks.agyBridgeRevoke.mockReset();
});

afterEach(() => cleanup());

describe('AgyBridgeSection 状态机四态', () => {
  it('ok → 「已授权」徽标 + 副本根路径 + 「关闭工具桥」', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(view());
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByText(t('agyBridge.stateOk'))).toBeTruthy());
    expect(screen.getByText('C:/Users/reader/.orison/agy-bridge/home')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('agyBridge.revoke') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('agyBridge.authorize') })).toBeNull();
  });

  it('missing-consent → 「未配置」徽标 + 「立即授权」', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(view({ state: 'missing-consent', consent: undefined }));
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByText(t('agyBridge.stateMissingConsent'))).toBeTruthy());
    expect(screen.getByRole('button', { name: t('agyBridge.authorize') })).toBeTruthy();
  });

  it('conflict → 规则原文 + 指引 + 「重新检测」，无授权钮', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(
      view({ state: 'conflict', consent: undefined, conflicts: ['mcp(novel-writing/*)', 'mcp(*)'] }),
    );
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByText(t('agyBridge.stateConflict'))).toBeTruthy());
    const section = document.querySelector('.agy-bridge-section')!;
    expect(section.textContent).toContain('mcp(novel-writing/*)');
    expect(section.textContent).toContain('mcp(*)');
    expect(section.textContent).toContain('不会代你改动这些规则');
    expect(screen.getByRole('button', { name: t('agyBridge.recheck') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('agyBridge.authorize') })).toBeNull();
  });

  // ── CR-19（子3 CR 批）：空 conflicts 如实展示「原因不可用」——不伪造 ['mcp(*)'] 清单 ──
  it('CR-19: conflict 且 conflicts 空 → 「冲突原因不可用」态，不伪造 mcp(*) 规则展示', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(
      view({ state: 'conflict', consent: undefined, conflicts: [] }),
    );
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByText(t('agyBridge.stateConflict'))).toBeTruthy());
    const section = document.querySelector('.agy-bridge-section')!;
    expect(section.textContent).toContain(t('agyBridge.conflictReasonUnavailable'));
    // 假清单防线：伪造的 mcp(*) 规则条目不得出现（真实规则存在与否是事实问题）。
    expect(section.querySelectorAll('.agy-bridge-conflict-rules li')).toHaveLength(0);
    expect(section.textContent).not.toContain('mcp(*)');
  });

  it('declined → 「已拒绝」徽标 + 纯文本降级说明 + 「重新授权」', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(view({ state: 'declined', consent: 'declined' }));
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByText(t('agyBridge.stateDeclined'))).toBeTruthy());
    expect(document.querySelector('.agy-bridge-section')!.textContent).toContain('纯文本模式');
    expect(screen.getByRole('button', { name: t('agyBridge.reauthorize') })).toBeTruthy();
  });
});

describe('AgyBridgeSection 操作', () => {
  it('missing-consent「立即授权」→ agy-bridge:consent(allowed) 写', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(view({ state: 'missing-consent', consent: undefined }));
    bridgeMocks.agyBridgeSetConsent.mockResolvedValue({ ok: true, view: view() } as AgyBridgeConsentResult);
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByRole('button', { name: t('agyBridge.authorize') })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: t('agyBridge.authorize') }));
    await waitFor(() => expect(bridgeMocks.agyBridgeSetConsent).toHaveBeenCalledWith({ consent: 'allowed' }));
    await waitFor(() => expect(useAgyBridgeStore.getState().status?.state).toBe('ok'));
  });

  it('ok「关闭工具桥」→ confirm 确认 → agy-bridge:revoke；成功后状态翻回未配置', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(view());
    bridgeMocks.agyBridgeStatus.mockResolvedValueOnce(view()).mockResolvedValue(view({ state: 'missing-consent', consent: undefined }));
    bridgeMocks.agyBridgeRevoke.mockResolvedValue({ ok: true } as AgyBridgeRevokeResult);
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByRole('button', { name: t('agyBridge.revoke') })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: t('agyBridge.revoke') }));
    // confirm 未决 → revoke IPC 未发。
    await Promise.resolve();
    expect(bridgeMocks.agyBridgeRevoke).not.toHaveBeenCalled();
    useConfirmStore.getState().resolveConfirm(true);
    await waitFor(() => expect(bridgeMocks.agyBridgeRevoke).toHaveBeenCalled());
    await waitFor(() => expect(useAgyBridgeStore.getState().status?.state).toBe('missing-consent'));
  });

  it('revoke 遇活动桥会话 → 活动会话提示（不静默失败）', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(view());
    bridgeMocks.agyBridgeRevoke.mockResolvedValue({
      ok: false,
      error: 'active-sessions',
      activeSessions: ['sess-1'],
    } as AgyBridgeRevokeResult);
    render(<AgyBridgeSection t={t} />);
    await waitFor(() => expect(screen.getByRole('button', { name: t('agyBridge.revoke') })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: t('agyBridge.revoke') }));
    useConfirmStore.getState().resolveConfirm(true);
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((toast) => toast.message.includes('正在进行的桥会话'))).toBe(true),
    );
    // 状态保持 ok（未翻转）。
    expect(useAgyBridgeStore.getState().status?.state).toBe('ok');
  });

  // ── CR-19（子3 CR 批）：busy 复位 finally 化——失败路径操作钮不钉死 ──
  it('CR-19: authorize 失败（IPC null）→ 错误提示后按钮恢复可用（busy 复位，可重试）', async () => {
    bridgeMocks.agyBridgeStatus.mockResolvedValue(view({ state: 'missing-consent', consent: undefined }));
    bridgeMocks.agyBridgeSetConsent.mockResolvedValue(null);
    render(<AgyBridgeSection t={t} />);
    const authorizeButton = await screen.findByRole('button', { name: t('agyBridge.authorize') });

    fireEvent.click(authorizeButton);
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((toast) => toast.message.includes('授权写入失败'))).toBe(true),
    );
    await waitFor(() => expect(authorizeButton.hasAttribute('disabled')).toBe(false));
    // 重试再发一次（busy 未死锁的最强证据）。
    fireEvent.click(authorizeButton);
    await waitFor(() => expect(bridgeMocks.agyBridgeSetConsent).toHaveBeenCalledTimes(2));
  });
});
