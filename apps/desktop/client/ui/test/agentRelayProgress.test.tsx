/**
 * CR-003a（决议 a）：AgentPanel 识图转述进度条（image-relay-progress 全窗广播消费）。
 *
 * 覆盖：事件驱动显示「正在识图转述 i/N」+ 帧序更新 / 末帧（current===total）~2s 后
 * 自动消隐（期间持续显示） / 畸形载荷（total≤0）零显示 / 桥无该方法（旧环境/测试
 * mock 桥）静默不炸 / 卸载退订（preload 订阅纪律——只移除本监听器）。
 *
 * 直传 / 缓存全命中 / 无图场景 shell 不发事件 → 天然零显示（无需用例，事件即数据源）。
 * seedStore 模式照 agentPanelDropzone.test.tsx 先例。
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { useAppStore } from '../src/shared/store/appStore';

type RelayCallback = (progress: { current: number; total: number }) => void;

let relayListeners: RelayCallback[];
let offRelay: ReturnType<typeof vi.fn>;

function seedStore(): void {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'en-US',
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    agentMessages: [],
    agentSkills: [],
    agentSkillError: null,
    loadAgentSkills: vi.fn().mockResolvedValue(undefined),
    skillPackages: [],
    skillPackagesLoading: false,
    loadSkillPackages: vi.fn().mockResolvedValue(undefined),
    toggleSkillPackage: vi.fn(),
    toggleSkill: vi.fn(),
    agentParticipationGear: 'smart',
    pendingAttachments: [],
    attachmentUploadStates: {},
    uploadInboxFiles: vi.fn().mockResolvedValue(undefined),
    uploadChatImages: vi.fn().mockResolvedValue(undefined),
  } as any);
}

function emitRelay(progress: unknown): void {
  for (const cb of relayListeners) cb(progress as { current: number; total: number });
}

beforeEach(() => {
  relayListeners = [];
  offRelay = vi.fn();
  (window as any).orisonDesktop = {
    abortAgentRun: vi.fn(),
    onImageRelayProgress: vi.fn((cb: RelayCallback) => {
      relayListeners.push(cb);
      return offRelay;
    }),
  };
  seedStore();
});

afterEach(() => cleanup());

describe('AgentPanel 识图转述进度条（CR-003a）', () => {
  it('多图转述事件 → 显示「正在识图转述 i/N」，帧序随事件更新', () => {
    render(<AgentPanel />);

    act(() => { emitRelay({ current: 1, total: 3 }); });
    let bar = document.querySelector('.agent-relay-progress') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('1/3');

    act(() => { emitRelay({ current: 2, total: 3 }); });
    bar = document.querySelector('.agent-relay-progress') as HTMLElement | null;
    expect(bar!.textContent).toContain('2/3');
    expect(bar!.getAttribute('role')).toBe('status');
  });

  it('末帧（current===total）~2s 后自动消隐；驻留期内持续显示', () => {
    vi.useFakeTimers();
    try {
      render(<AgentPanel />);

      act(() => { emitRelay({ current: 2, total: 2 }); });
      expect(document.querySelector('.agent-relay-progress')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1999); });
      expect(document.querySelector('.agent-relay-progress')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(document.querySelector('.agent-relay-progress')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('非末帧事件刷新驻留计时（中途帧不打断显示、不提前消隐）', () => {
    vi.useFakeTimers();
    try {
      render(<AgentPanel />);

      act(() => { emitRelay({ current: 1, total: 2 }); });
      act(() => { vi.advanceTimersByTime(1500); });
      // 中途帧到达：无清除计时（只有末帧设置）——中途帧后仍显示。
      act(() => { emitRelay({ current: 2, total: 2 }); });
      act(() => { vi.advanceTimersByTime(1500); });
      expect(document.querySelector('.agent-relay-progress')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(500); });
      expect(document.querySelector('.agent-relay-progress')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('畸形载荷（total≤0 / 非数字）零显示', () => {
    render(<AgentPanel />);

    act(() => { emitRelay({ current: 0, total: 0 }); });
    act(() => { emitRelay({ current: 1 }); });
    act(() => { emitRelay(null); });
    expect(document.querySelector('.agent-relay-progress')).toBeNull();
  });

  it('桥无 onImageRelayProgress（旧 mock 桥/测试环境）→ 静默不炸，零显示', () => {
    (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
    render(<AgentPanel />);

    expect(document.querySelector('.agent-relay-progress')).toBeNull();
  });

  it('卸载退订（preload 订阅纪律——返回的 off 被调用）', () => {
    render(<AgentPanel />);
    cleanup();
    expect(offRelay).toHaveBeenCalledTimes(1);
  });
});
