/**
 * ImageReferenceThumb 两态 + 历史加载映射（task 09-01 B4 / dogfood #45，R2.6 / AC12 后半）。
 *
 * 覆盖：dataUrl 直显（乐观消息，零盘读）/ 无 dataUrl → readFileBinary 盘读还原
 *（ProjectTree.tsx:231-245 同款 IPC + 路径拼接）+ 加载中占位 / 读失败占位不炸 /
 * fetchAgentSession 的 SessionMessage.images（B2 载荷 `Array<{path,b64hash,name}>`）→
 * references image 附件映射（重启 jsonl 读回形态）/ switchAgentSession 重映射 references
 * 透传（Blind-002 手抄重映射漏字段家族）。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 模块加载序关键：api/agent.ts 在 import 期捕获 `const api = window.orisonDesktop`——
// hoisted 先装空桥对象，后续 installBridge **原地改写**（替换引用会断掉已捕获的引用）。
vi.hoisted(() => {
  const w = globalThis as unknown as { window?: unknown };
  const win = (w.window ??= globalThis) as Record<string, unknown>;
  win.orisonDesktop = {};
});

import { AgentMessageItem } from '../src/features/agent-panel/AgentMessageItem';
import { fetchAgentSession } from '../src/shared/api/agent';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/api/agent';

const PROJECT_PATH = 'I:\\echo\\project'; // 反斜杠形态——chatImageAbsolutePath 归一为 /

type Bridge = Record<string, any>;

function installBridge(overrides: Bridge = {}): Bridge {
  // 原地改写（vi.hoisted 装的桥对象被 api/agent.ts 模块级捕获——替换引用即断链）。
  const bridge = (window as any).orisonDesktop as Bridge;
  for (const key of Object.keys(bridge)) delete bridge[key];
  Object.assign(bridge, {
    readFileBinary: vi.fn(async () => ({ base64: 'QUJD', mimeType: 'image/jpeg' })),
    getAgentSession: vi.fn(async () => null),
    abortAgentRun: vi.fn(),
    ...overrides,
  });
  return bridge;
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: PROJECT_PATH, type: 'novel' },
  } as any);
  useAppStore.setState({
    resolvedLocale: 'en-US',
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    ...overrides,
  } as any);
}

function userMessage(references: unknown): AgentMessage {
  return {
    id: 'm1',
    role: 'user',
    content: '看这张图',
    references: references as AgentMessage['references'],
    createdAt: Date.now(),
  };
}

function imageRef(over: Record<string, unknown> = {}) {
  return {
    type: 'image',
    id: 'inbox/images/a.jpg',
    label: 'a.jpg',
    path: 'inbox/images/a.jpg',
    b64hash: 'hash-1',
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ImageReferenceThumb 两态（R2.6）', () => {
  it('attachment 带 dataUrl（乐观消息）→ 直接渲染，零盘读', () => {
    seedStore();
    const bridge = installBridge();
    render(<AgentMessageItem message={userMessage([imageRef({ dataUrl: 'data:image/png;base64,AAA' })])} />);

    const img = document.querySelector('.agent-msg-image-thumb img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(img.getAttribute('alt')).toBe('a.jpg');
    expect(bridge.readFileBinary).not.toHaveBeenCalled();
  });

  it('无 dataUrl（重载会话）→ readFileBinary 盘读转 dataUrl 渲染（路径拼接 + 归一）', async () => {
    seedStore();
    const bridge = installBridge();
    render(<AgentMessageItem message={userMessage([imageRef()])} />);

    // 加载中占位框。
    expect(screen.getByText('Loading image…')).toBeDefined();
    // 项目相对指针 → 归一绝对路径（反斜杠已归一，ProjectTree.tsx:230 同款拼接）。
    expect(bridge.readFileBinary).toHaveBeenCalledWith('I:/echo/project/inbox/images/a.jpg');

    await waitFor(() => {
      const img = document.querySelector('.agent-msg-image-thumb img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,QUJD');
    });
  });

  it('盘读 null（文件被移走/删除）→ 失败占位不炸气泡', async () => {
    seedStore();
    installBridge({ readFileBinary: vi.fn(async () => null) });
    render(<AgentMessageItem message={userMessage([imageRef()])} />);

    await waitFor(() => {
      expect(screen.getByText(/could not be loaded/)).toBeDefined();
    });
    expect(document.querySelector('.agent-msg-image-thumb img')).toBeNull();
  });

  it('非 image 引用零变化（file/chapter 走原通用 chip，回归）', () => {
    seedStore();
    const bridge = installBridge();
    render(
      <AgentMessageItem
        message={userMessage([{ type: 'file', id: 'inbox/x.md', label: 'x.md' }])}
      />,
    );

    expect(document.querySelector('.agent-msg-image-thumb')).toBeNull();
    expect(document.querySelector('.agent-msg-references .agent-attachment-chip')?.textContent).toContain('x.md');
    expect(bridge.readFileBinary).not.toHaveBeenCalled();
  });
});

describe('历史加载映射（R2.6：SessionMessage.images → references，AC12 重启读回形态）', () => {
  it('fetchAgentSession 把 user 消息的 images 指针映射成 image 引用（label=name，缺名回落 basename）', async () => {
    seedStore();
    installBridge({
      getAgentSession: vi.fn(async () => ({
        id: 'session-1',
        status: 'idle',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '开场',
            createdAt: 1,
            images: [
              { path: 'inbox/images/shot.png', b64hash: 'h1', name: '截图.png' },
              { path: 'inbox/images/no-name.jpg', b64hash: 'h2' },
            ],
          },
          { id: 'm2', role: 'assistant', content: '收到', createdAt: 2 },
          { id: 'm3', role: 'user', content: '无图消息', createdAt: 3 },
        ],
      })),
    });

    const session = await fetchAgentSession('session-1', PROJECT_PATH);

    const refs = session!.messages[0].references;
    expect(refs).toHaveLength(2);
    expect(refs![0]).toEqual({
      type: 'image',
      id: 'inbox/images/shot.png',
      label: '截图.png',
      path: 'inbox/images/shot.png',
      b64hash: 'h1',
    });
    // 缺 name → 路径 basename 兜底。
    expect(refs![1]).toMatchObject({ label: 'no-name.jpg', b64hash: 'h2' });
    // 非 user / 无 images 消息原样零变化。
    expect(session!.messages[1].references).toBeUndefined();
    expect(session!.messages[2].references).toBeUndefined();
  });

  it('switchAgentSession 重映射透传 references（Blind-002 手抄重映射漏字段家族）', async () => {
    seedStore();
    installBridge({
      getAgentSession: vi.fn(async () => ({
        id: 'session-1',
        status: 'idle',
        permissionMode: 'suggest',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '开场',
            createdAt: 1,
            images: [{ path: 'inbox/images/shot.png', b64hash: 'h1', name: '截图.png' }],
          },
        ],
      })),
    });

    await useAppStore.getState().switchAgentSession('session-1');

    const messages = useAppStore.getState().agentMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0].references).toHaveLength(1);
    expect(messages[0].references![0]).toMatchObject({
      type: 'image',
      path: 'inbox/images/shot.png',
      label: '截图.png',
      b64hash: 'h1',
    });

    // 端到端：切完会话气泡经盘读还原缩略图。
    const bridge = (window as any).orisonDesktop as Bridge;
    render(<AgentMessageItem message={messages[0]} />);
    expect(bridge.readFileBinary).toHaveBeenCalledWith('I:/echo/project/inbox/images/shot.png');
  });
});
