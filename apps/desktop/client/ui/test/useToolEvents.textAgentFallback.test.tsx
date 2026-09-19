import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToolEvents } from '../src/shared/hooks/useToolEvents';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import { translate } from '../src/shared/i18n/useI18n';

function ToolEventsHarness() {
  useToolEvents();
  return null;
}

// ── 09-19 CLI 白名单 W4：文本 Agent 降级 toast 接线 ──
//
// shell 事件面（agentIpc console.warn 拦截 → cli:text-agent-fallback 推一次）→ renderer
// 一次性 toast。机器级事件（无 projectPath）——必须先于 projectPath 守卫处理（连
// currentProject 为 null 时也要能弹：冷启动后台蒸馏即可触发降级，无任何工程打开）。

describe('useToolEvents cli:text-agent-fallback', () => {
  let emitToolEvent: ((event: { type: string; [key: string]: unknown }) => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    emitToolEvent = null;
    // 刻意不设 currentProject：降级是机器级事实，无工程打开也必须可见（auth-dead 同族）。
    useAppStore.setState({ currentProject: null, resolvedLocale: 'zh-CN' } as any);
    useToastStore.setState({ toasts: [] });
    (window as any).orisonDesktop = {
      onToolEvent: vi.fn((callback) => {
        emitToolEvent = callback;
        return vi.fn();
      }),
      wordCount: vi.fn(async () => 0),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('降级事件（无 projectPath）→ 一次性 warning toast，文案按拍板措辞', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({ type: 'cli:text-agent-fallback' });
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('warning');
    expect(toasts[0].message).toBe(translate('zh-CN', 'notifications.cliTextAgentFallback'));
    expect(toasts[0].message).toContain('文本 Agent');
    // 15s 知情窗（默认 warning 4s 读不完一句中文——mirror cliAuthDead 自定义时限先例）。
    expect(toasts[0].duration).toBe(15_000);
  });

  it('projectPath 守卫之前处理：带任意 projectPath 也照弹（不进工程匹配漏斗）', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({ type: 'cli:text-agent-fallback', projectPath: '/some/project' });
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('其他未知机器级事件不弹 toast', () => {
    render(<ToolEventsHarness />);
    act(() => {
      emitToolEvent?.({ type: 'cli:something-else' });
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
