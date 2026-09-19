// CLI 凭据探针配套 UI——shell 推送 cli:auth-dead 事件时弹 warning toast（时限 30s）。
// 防骚扰去重在 shell 单点（转变判定），renderer 只弹不二次判。
// 探针状态卡片（AgyProbeSection）自身的四态渲染/按钮/守卫测试见 agyProbeSection.test.tsx。
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToolEvents } from '../src/shared/hooks/useToolEvents';
import { useToastStore } from '../src/shared/store/toastStore';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  // 带变量的 translate：把插值实参编码进文本，断言 {keyName} 确实传给了翻译层。
  translate: (locale: string, key: string, vars?: Record<string, string | number>) =>
    vars && Object.keys(vars).length > 0 ? `${key}|${JSON.stringify(vars)}` : key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

/** useToolEvents 挂载壳：把 onToolEvent 注册的 callback 捕出来手工派发事件。 */
let dispatchToolEvent: ((event: { type: string; [key: string]: unknown }) => void) | null = null;

function ToolEventsHarness() {
  useToolEvents();
  return null;
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  dispatchToolEvent = null;
  (window as unknown as { orisonDesktop: unknown }).orisonDesktop = {
    onToolEvent: vi.fn((cb: (event: { type: string }) => void) => {
      dispatchToolEvent = cb;
      return () => {};
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
});

describe('useToolEvents：cli:auth-dead 推送弹 toast', () => {
  it('cli:auth-dead 事件 → warning toast，时限 30s，keyName 经 {keyName} 插值传入', () => {
    render(<ToolEventsHarness />);
    expect(dispatchToolEvent).not.toBeNull();

    act(() => {
      dispatchToolEvent!({
        type: 'cli:auth-dead',
        keys: [{ keyId: 'agy1', keyName: 'Antigravity' }],
      });
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.level).toBe('warning');
    expect(toasts[0]!.message).toBe('notifications.cliAuthDead|{"keyName":"Antigravity"}');
    expect(toasts[0]!.duration).toBe(30_000);
  });

  it('启动扫合并事件（keys 多元素）→ 单条 toast 列全部 key 名，不堆叠', () => {
    render(<ToolEventsHarness />);
    act(() => {
      dispatchToolEvent!({
        type: 'cli:auth-dead',
        keys: [
          { keyId: 'agy1', keyName: 'A1' },
          { keyId: 'agy2', keyName: 'A2' },
        ],
      });
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toContain('A1');
    expect(toasts[0]!.message).toContain('A2');
  });

  it('无 projectPath 的 cli:auth-dead 不被 current-project 守卫吞掉（机器级事件先于守卫）', () => {
    render(<ToolEventsHarness />);
    act(() => {
      // 事件刻意不带 projectPath——若走到既有 projectPath 守卫分支会被 return 吞掉。
      dispatchToolEvent!({
        type: 'cli:auth-dead',
        keys: [{ keyId: 'agy1', keyName: 'Antigravity' }],
      });
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
