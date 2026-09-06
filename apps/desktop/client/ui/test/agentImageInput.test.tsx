/**
 * AgentInput 图片进件三入口组件测试（task 09-01 B4 / dogfood #45，R2.1 / AC7 前半）。
 *
 * 覆盖：attach 菜单「上传图片…」项 + 隐藏 input accept 面 / 选择器上传走 uploadChatImages
 * 全链（经真实 saveChatImage → bridge.saveBase64-image 参数）/ **粘贴截图（DataTransfer
 * items 构造）+ 纯文本粘贴零影响（preventDefault 语义回归锁死）** / image chip 缩略图
 * 两态（uploading spinner / ready 缩略图直显）/ 拒收 chip 文案 / 图片在途 Send 门控。
 *
 * mock 面：仅 compressChatImage（canvas 不进 jsdom）——paste/upload 经真实 slice action
 * + 真实 saveChatImage/sha256Hex 落到 bridge，端到端断言。seedStore 模式照
 * agentInboxAttachments.test.tsx 先例。
 */
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const compressMock = vi.fn();
vi.mock('../src/shared/api/chatImages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api/chatImages')>();
  return {
    ...actual,
    compressChatImage: (file: File) => compressMock(file),
  };
});

import { AgentInput } from '../src/features/agent-panel/AgentInput';
import { CHAT_IMAGE_ACCEPT } from '../src/shared/api/chatImages';
import { useAppStore } from '../src/shared/store/appStore';

const PROJECT_PATH = 'I:/echo/project';

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
let BINARY = '';
for (let i = 0; i < BYTES.length; i += 1) BINARY += String.fromCharCode(BYTES[i]);
const B64 = btoa(BINARY);
const DATA_URL = `data:image/png;base64,${B64}`;
const HASH = createHash('sha256').update(Buffer.from(BYTES)).digest('hex');

function compressOk() {
  return { ok: true as const, bytes: BYTES, b64: B64, mimeType: 'image/png', dataUrl: DATA_URL, width: 8, height: 8 };
}

function installBridge() {
  const bridge = {
    saveBase64Image: vi.fn(async () => ({
      relativePath: 'inbox/images/shot.png',
      fullPath: `${PROJECT_PATH}/inbox/images/shot.png`,
      fileName: 'shot.png',
    })),
    abortAgentRun: vi.fn(),
    pathForFile: vi.fn(),
    importFiles: vi.fn(async () => ({ imported: [], rejected: [] })),
    resolveInboxAttachment: vi.fn(async () => ({ ok: false, error: 'x' })),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => null),
  };
  (window as any).orisonDesktop = bridge;
  return bridge;
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: PROJECT_PATH, type: 'novel' },
  } as any);
  useAppStore.setState({
    resolvedLocale: 'en-US',
    modelConfig: { keys: [] },
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    sessionSwitching: false,
    agentRunStates: {},
    agentError: null,
    novelChapters: [],
    openFiles: [],
    pendingAttachments: [],
    attachmentUploadStates: {},
    pendingToolConfirmBySession: {},
    pendingPassageResolveBySession: {},
    draftPreset: null,
    ...overrides,
  } as any);
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Ask the agent/) as HTMLTextAreaElement;
}

/** 隐藏图片 input（DOM 顺序第二个 file input——第一个是 A3 文档上传）。 */
function imageInput(): HTMLInputElement {
  const inputs = document.querySelectorAll('input[type="file"]');
  expect(inputs.length).toBe(2);
  return inputs[1] as HTMLInputElement;
}

async function flushAsync(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => { setTimeout(r, 0); });
  }
}

beforeEach(() => {
  localStorage.clear();
  compressMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('attach 菜单「上传图片…」入口（R2.1 按钮）', () => {
  it('菜单渲染图片上传项 + 隐藏 input 携带白名单 accept 面', async () => {
    seedStore();
    installBridge();
    render(<AgentInput />);

    await userEvent.click(screen.getByTitle('Attach'));

    expect(screen.getByText('Upload image…')).toBeDefined();
    const input = imageInput();
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(CHAT_IMAGE_ACCEPT);
  });

  it('选择器上传走 uploadChatImages 全链：落盘参数 + image 附件挂载 + ready chip 缩略图', async () => {
    seedStore();
    const bridge = installBridge();
    compressMock.mockResolvedValueOnce(compressOk());
    render(<AgentInput />);

    await userEvent.click(screen.getByTitle('Attach'));
    await userEvent.upload(imageInput(), new File(['x'], 'shot.png', { type: 'image/png' }));

    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    expect(bridge.saveBase64Image).toHaveBeenCalledWith(PROJECT_PATH, {
      b64Json: B64,
      mimeType: 'image/png',
      directory: 'inbox/images',
      notify: true,
      fileName: 'shot',
    });
    expect(useAppStore.getState().pendingAttachments[0]).toMatchObject({
      type: 'image',
      path: 'inbox/images/shot.png',
      b64hash: HASH,
    });
    // ready chip 缩略图直显（img src = 压缩后 dataUrl）。
    await waitFor(() => {
      expect(document.querySelector('.agent-attachment-chip-image img')?.getAttribute('src')).toBe(DATA_URL);
    });
  });
});

describe('粘贴入口（R2.1 截图流 / AC7「纯文本粘贴行为与现状一致」/ CR-021）', () => {
  // CR-021：图片项存在时**不再 preventDefault**——放行浏览器默认文本粘贴（图文混排源
  // 的 text/plain 表示照常落入输入框）。jsdom 无默认粘贴实现，可锁语义 = 「未被拦截」
  //（真浏览器文本落框的唯一通道）+ 我方不清/不写输入框 + 附件照旧进图。
  it('粘贴截图（纯图）→ image file 项进件 + 不 preventDefault；输入框零变化（CR-021）', async () => {
    seedStore();
    const bridge = installBridge();
    compressMock.mockResolvedValueOnce(compressOk());
    render(<AgentInput />);

    const png = new File(['x'], 'image.png', { type: 'image/png' });
    let defaultPrevented = false;
    const observer = (e: Event) => { defaultPrevented = e.defaultPrevented; };
    document.addEventListener('paste', observer);
    fireEvent.paste(textarea(), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
      },
    });
    document.removeEventListener('paste', observer);
    await flushAsync();

    // 纯截图无 text/plain——默认粘贴本就不插入内容；放行默认（false）+ 我们不写输入框。
    expect(defaultPrevented).toBe(false);
    expect(textarea().value).toBe('');
    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    expect(bridge.saveBase64Image).toHaveBeenCalledTimes(1);
  });

  it('图文混排粘贴 → 不 preventDefault（默认文本粘贴放行）+ 附件有图 + 已有草稿不被清（CR-021）', async () => {
    seedStore();
    const bridge = installBridge();
    compressMock.mockResolvedValueOnce(compressOk());
    render(<AgentInput />);
    await userEvent.type(textarea(), 'draft ');

    const png = new File(['x'], 'image.png', { type: 'image/png' });
    let defaultPrevented = true; // 初始假设被拦——断言它没被
    const observer = (e: Event) => { defaultPrevented = e.defaultPrevented; };
    document.addEventListener('paste', observer);
    fireEvent.paste(textarea(), {
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsString: vi.fn() },
          { kind: 'file', type: 'image/png', getAsFile: () => png },
        ],
      },
    });
    document.removeEventListener('paste', observer);
    await flushAsync();

    // 默认文本粘贴路径保持放行（真浏览器里 text/plain 落入输入框）；jsdom 锁两个可测
    // 语义：未被拦截 + 草稿原样保留。
    expect(defaultPrevented).toBe(false);
    expect(textarea().value).toBe('draft ');
    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    expect(bridge.saveBase64Image).toHaveBeenCalledTimes(1);
  });

  it('纯文本粘贴零影响：不 preventDefault、零进件、输入照常', async () => {
    seedStore();
    const bridge = installBridge();
    render(<AgentInput />);

    let defaultPrevented = 'unset';
    const observer = (e: Event) => { defaultPrevented = e.defaultPrevented; };
    document.addEventListener('paste', observer);
    fireEvent.paste(textarea(), {
      clipboardData: {
        items: [{ kind: 'string', type: 'text/plain', getAsString: vi.fn() }],
      },
    });
    document.removeEventListener('paste', observer);
    await flushAsync();

    // 未被 preventDefault（false = 原生文本粘贴路径原样放行）+ 零进件调用。
    expect(defaultPrevented).toBe(false);
    expect(bridge.saveBase64Image).not.toHaveBeenCalled();
    expect(compressMock).not.toHaveBeenCalled();
    // 输入未受影响（typing 照常工作）。
    await userEvent.type(textarea(), 'hello');
    expect(textarea().value).toBe('hello');
  });

  it('同一截图重复 item 去重（name|type|size）——只进件一次', async () => {
    seedStore();
    const bridge = installBridge();
    compressMock.mockResolvedValueOnce(compressOk());
    render(<AgentInput />);

    const shot = new File(['x'], 'image.png', { type: 'image/png' });
    fireEvent.paste(textarea(), {
      clipboardData: {
        items: [
          { kind: 'file', type: 'image/png', getAsFile: () => shot },
          { kind: 'file', type: 'image/png', getAsFile: () => shot },
        ],
      },
    });
    await flushAsync();

    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    expect(bridge.saveBase64Image).toHaveBeenCalledTimes(1);
  });
});

describe('image chip 两态 + 拒收文案', () => {
  it('uploading 态（压缩中，无缩略图）：spinner + 标签 + 状态文案', () => {
    seedStore({
      attachmentUploadStates: {
        'upload-1': { state: 'uploading', label: 'shot.png', variant: 'image' },
      },
    });
    installBridge();
    render(<AgentInput />);

    const chip = document.querySelector('.agent-attachment-chip-image') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.querySelector('.agent-upload-spin')).not.toBeNull();
    expect(chip.textContent).toContain('shot.png');
    expect(chip.textContent).toContain('Processing…');
    expect(chip.querySelector('img')).toBeNull();
  });

  it('uploading 态已出缩略图（压缩完、落盘在途）直显；压缩后 dataUrl 不丢状态文案', () => {
    seedStore({
      attachmentUploadStates: {
        'upload-1': { state: 'uploading', label: 'shot.png', variant: 'image', thumbDataUrl: DATA_URL },
      },
    });
    installBridge();
    render(<AgentInput />);

    const chip = document.querySelector('.agent-attachment-chip-image') as HTMLElement;
    expect(chip.querySelector('img')?.getAttribute('src')).toBe(DATA_URL);
    expect(chip.textContent).toContain('Processing…');
  });

  it('not-image 拒收 chip：红边 + 图专用指引文案（title）', () => {
    seedStore({
      attachmentUploadStates: {
        'upload-1': { state: 'error', label: 'icon.svg', variant: 'image', errorKind: 'not-image' },
      },
    });
    installBridge();
    render(<AgentInput />);

    const chip = document.querySelector('.agent-attachment-chip-image') as HTMLElement;
    expect(chip.className).toContain('is-error');
    expect(chip.getAttribute('title')).toContain('PNG / JPG / WEBP / GIF');
  });
});

describe('图片在途 Send 门控（A3 同门——uploading 即拦）', () => {
  it('image uploading 态 Send 禁用，error 态放行', async () => {
    seedStore({
      attachmentUploadStates: {
        'upload-1': { state: 'uploading', label: 'shot.png', variant: 'image' },
      },
    });
    installBridge();
    render(<AgentInput />);
    await userEvent.type(textarea(), 'hi');

    expect((screen.getByTitle('Send') as HTMLButtonElement).disabled).toBe(true);

    useAppStore.setState({
      attachmentUploadStates: { 'upload-1': { state: 'error', label: 'shot.png', variant: 'image', errorKind: 'too-large' } },
    });
    await waitFor(() => {
      expect((screen.getByTitle('Send') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
