/**
 * uploadChatImages slice action 全链单测（task 09-01 B4 / dogfood #45，R2.1-R2.6）。
 *
 * 覆盖：uploading→ready 状态机流转 + 条目键迁移（临时 upload-<uuid> → 附件 id=落盘
 * 相对路径）/ save-base64-image 参数（directory='inbox/images' + notify=true + 文件名
 * 基干剥扩展名）/ **b64hash 形态与 shell B3 逐字对齐（node:crypto createHash 同式交叉
 * 验证）** / ImageAttachment 指针形态（id=path, label=原名）/ 压缩拒收三档 errorKind /
 * 落盘失败 error / 在途移除守卫 / 复查 M3 切项目守卫 / removeAttachment 连带清条目 /
 * 发送时刻乐观消息引用携带 dataUrl（IPC attachments 保持纯指针）。
 *
 * mock 面：仅 compressChatImage（canvas 不进 jsdom）；saveChatImage/sha256Hex 走真实
 * 模块（→ bridge.saveBase64Image / node webcrypto）——参数与 hash 形态断言在真链上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { waitFor } from '@testing-library/react';

const compressMock = vi.fn();
vi.mock('../src/shared/api/chatImages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api/chatImages')>();
  return {
    ...actual,
    compressChatImage: (file: File) => compressMock(file),
  };
});

// 模块加载序关键：api/agent.ts 在 import 期捕获 `const api = window.orisonDesktop`——
// hoisted 先装空桥对象，后续 installBridge **原地改写**（替换引用会断掉已捕获的引用）。
vi.hoisted(() => {
  const w = globalThis as unknown as { window?: unknown };
  const win = (w.window ??= globalThis) as Record<string, unknown>;
  win.orisonDesktop = {};
});

import { useAppStore } from '../src/shared/store/appStore';

const PROJECT_PATH = 'I:/echo/project';

// ── 固定字节夹具：hash 期望值用 B3 同式（agentImageParts.ts:169）在测试侧现算 ——
//    slice 产出的 b64hash 必须与之逐字符一致（跨 WebCrypto/Node crypto 的确定性证明）。
const BYTES = new Uint8Array(300);
for (let i = 0; i < BYTES.length; i += 1) BYTES[i] = (i * 7 + 13) % 256;
let BINARY = '';
for (let i = 0; i < BYTES.length; i += 1) BINARY += String.fromCharCode(BYTES[i]);
const B64 = btoa(BINARY);
const DATA_URL = `data:image/jpeg;base64,${B64}`;
const EXPECTED_HASH = createHash('sha256').update(Buffer.from(BYTES)).digest('hex');

function compressOk(over: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    bytes: BYTES,
    b64: B64,
    mimeType: 'image/jpeg',
    dataUrl: DATA_URL,
    width: 640,
    height: 480,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Bridge = Record<string, any>;

function installBridge(overrides: Bridge = {}): Bridge {
  // 原地改写（vi.hoisted 装的桥对象被 api/agent.ts 模块级捕获——替换引用即断链）。
  const bridge = (window as any).orisonDesktop as Bridge;
  for (const key of Object.keys(bridge)) delete bridge[key];
  Object.assign(bridge, {
    abortAgentRun: vi.fn(),
    saveBase64Image: vi.fn(async () => ({
      relativePath: 'inbox/images/photo.jpg',
      fullPath: `${PROJECT_PATH}/inbox/images/photo.jpg`,
      fileName: 'photo.jpg',
    })),
    streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
    getAgentSession: vi.fn(async () => null),
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
    pendingAttachments: [],
    attachmentUploadStates: {},
    ...overrides,
  } as any);
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
  vi.clearAllMocks();
});

describe('uploadChatImages 全链（uploading → ready + 指针挂载）', () => {
  it('压缩 → 落盘 → ImageAttachment 挂载：save-base64-image 参数钉死 + b64hash 与 B3 逐字一致', async () => {
    seedStore();
    const bridge = installBridge();
    const gate = deferred<ReturnType<typeof compressOk>>();
    compressMock.mockReturnValueOnce(gate.promise);

    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    const run = useAppStore.getState().uploadChatImages([file]);

    // 进件即有 chip：uploading 态 + variant=image（同步 set，先于首个 await）。
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().attachmentUploadStates)).toHaveLength(1);
    });
    const [uploadId, entry] = Object.entries(useAppStore.getState().attachmentUploadStates)[0];
    expect(entry).toMatchObject({ state: 'uploading', label: 'photo.png', variant: 'image' });
    expect(compressMock).toHaveBeenCalledWith(file);

    gate.resolve(compressOk());
    await run;
    await flushAsync();

    // 落盘参数（design §2.1 / R2.3）：directory='inbox/images' + notify=true（复查 M4——
    // 落盘后显式 file:changed）；fileName = 原名剥扩展名基干（createImageFileName 按落盘
    // mime 追加正确扩展，直传原名会产出 photo.png.jpg）。
    expect(bridge.saveBase64Image).toHaveBeenCalledTimes(1);
    expect(bridge.saveBase64Image).toHaveBeenCalledWith(PROJECT_PATH, {
      b64Json: B64,
      mimeType: 'image/jpeg',
      directory: 'inbox/images',
      notify: true,
      fileName: 'photo',
    });

    // 指针形态（R2.3）：id=path=落盘相对路径，label=原文件名；b64hash = sha256(bytes)
    // 小写 hex 无前缀 —— 与 shell createHash('sha256').update(落盘字节).digest('hex')
    // 同式（agentImageParts.ts:169，resolveImageBytes 指纹比对侧）。
    const atts = useAppStore.getState().pendingAttachments;
    expect(atts).toHaveLength(1);
    expect(atts[0]).toEqual({
      type: 'image',
      id: 'inbox/images/photo.jpg',
      label: 'photo.png',
      path: 'inbox/images/photo.jpg',
      b64hash: EXPECTED_HASH,
    });

    // 条目迁移 ready（键 = 附件 id；thumbDataUrl 随迁移保留供 chip 直显）。
    const states = useAppStore.getState().attachmentUploadStates;
    expect(states['inbox/images/photo.jpg']).toEqual({
      state: 'ready',
      label: 'photo.png',
      variant: 'image',
      thumbDataUrl: DATA_URL,
    });
    expect(states[uploadId]).toBeUndefined();
  });

  it('多文件逐图串行（API 并发纪律）：按序全挂', async () => {
    seedStore();
    const bridge = installBridge({
      saveBase64Image: vi.fn()
        .mockResolvedValueOnce({ relativePath: 'inbox/images/a.jpg', fullPath: 'x', fileName: 'a.jpg' })
        .mockResolvedValueOnce({ relativePath: 'inbox/images/b.jpg', fullPath: 'x', fileName: 'b.jpg' }),
    });
    compressMock
      .mockResolvedValueOnce(compressOk({ dataUrl: 'data:image/jpeg;base64,QQ==' }))
      .mockResolvedValueOnce(compressOk({ dataUrl: 'data:image/jpeg;base64,WQ==' }));

    await useAppStore.getState().uploadChatImages([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);

    expect(bridge.saveBase64Image).toHaveBeenCalledTimes(2);
    const atts = useAppStore.getState().pendingAttachments;
    expect(atts.map((a) => (a as any).path)).toEqual(['inbox/images/a.jpg', 'inbox/images/b.jpg']);
  });
});

describe('拒收与失败面', () => {
  it('压缩拒收 not-image → error 条目带 errorKind，无附件、零落盘（SVG/HEIC，AC8）', async () => {
    seedStore();
    const bridge = installBridge();
    compressMock.mockResolvedValueOnce({ ok: false, reason: 'not-image' });

    await useAppStore.getState().uploadChatImages([new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' })]);

    const states = useAppStore.getState().attachmentUploadStates;
    expect(Object.values(states)[0]).toMatchObject({
      state: 'error',
      errorKind: 'not-image',
      variant: 'image',
      label: 'icon.svg',
    });
    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
    expect(bridge.saveBase64Image).not.toHaveBeenCalled();
  });

  it('两档压不动 too-large → error 条目（AC8「压不动拒收」）', async () => {
    seedStore();
    compressMock.mockResolvedValueOnce({ ok: false, reason: 'too-large' });

    await useAppStore.getState().uploadChatImages([new File(['x'], 'huge.png', { type: 'image/png' })]);

    expect(Object.values(useAppStore.getState().attachmentUploadStates)[0]).toMatchObject({
      state: 'error',
      errorKind: 'too-large',
    });
  });

  it('落盘 IPC 失败 → error 条目（可移除重试），无附件', async () => {
    seedStore();
    installBridge({
      saveBase64Image: vi.fn(async () => { throw new Error('disk full'); }),
    });
    compressMock.mockResolvedValueOnce(compressOk());

    await useAppStore.getState().uploadChatImages([new File(['x'], 'p.png', { type: 'image/png' })]);

    expect(Object.values(useAppStore.getState().attachmentUploadStates)[0]).toMatchObject({
      state: 'error',
      variant: 'image',
    });
    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
  });
});

describe('在途移除与项目隔离（mirror A3 范式 / 复查 M3）', () => {
  it('压缩在途移除 chip → 完成回调弃挂（无附件、条目整体清空）', async () => {
    seedStore();
    installBridge();
    const gate = deferred<ReturnType<typeof compressOk>>();
    compressMock.mockReturnValueOnce(gate.promise);

    const run = useAppStore.getState().uploadChatImages([new File(['x'], 'p.png', { type: 'image/png' })]);
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().attachmentUploadStates)).toHaveLength(1);
    });
    const uploadId = Object.keys(useAppStore.getState().attachmentUploadStates)[0];
    useAppStore.getState().removeAttachmentUpload(uploadId);

    gate.resolve(compressOk());
    await run;
    await flushAsync();

    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
  });

  it('在途切项目 → 守卫拦下，旧项目产物不泄漏进新项目视图（M3/AC6b）', async () => {
    seedStore();
    installBridge();
    const gate = deferred<ReturnType<typeof compressOk>>();
    compressMock.mockReturnValueOnce(gate.promise);

    const run = useAppStore.getState().uploadChatImages([new File(['x'], 'p.png', { type: 'image/png' })]);
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().attachmentUploadStates)).toHaveLength(1);
    });

    useAppStore.setState({
      currentProject: { projectId: 'p2', name: 'Other', path: 'I:/other/project', type: 'novel' },
    } as any);

    gate.resolve(compressOk());
    await run;
    await flushAsync();

    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
  });

  it('removeAttachment(附件 id) 连带清 ready 条目（A3 范式沿用）', async () => {
    seedStore();
    installBridge();
    compressMock.mockResolvedValueOnce(compressOk());

    await useAppStore.getState().uploadChatImages([new File(['x'], 'photo.png', { type: 'image/png' })]);
    expect(useAppStore.getState().attachmentUploadStates['inbox/images/photo.jpg']).toMatchObject({ state: 'ready' });

    useAppStore.getState().removeAttachment('inbox/images/photo.jpg');

    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
  });
});

describe('发送时刻引用富化（R2.6：IPC 纯指针，乐观消息带 dataUrl）', () => {
  it('sendAgentMessage：references[0].dataUrl = 压缩后 dataUrl；IPC attachments 无 dataUrl；状态机整体清场', async () => {
    seedStore();
    const bridge = installBridge();
    compressMock.mockResolvedValueOnce(compressOk());
    await useAppStore.getState().uploadChatImages([new File(['x'], 'photo.png', { type: 'image/png' })]);
    expect(useAppStore.getState().pendingAttachments).toHaveLength(1);

    const dispatched = useAppStore.getState().sendAgentMessage('看这张图');
    expect(await dispatched).toBe(true);
    await flushAsync();

    // 乐观 userMsg 引用携带 dataUrl（bubble 缩略图直显，重载会话才走盘读）。
    const messages = useAppStore.getState().agentMessages;
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.references).toHaveLength(1);
    expect((userMsg!.references![0] as any).dataUrl).toBe(DATA_URL);
    expect((userMsg!.references![0] as any).path).toBe('inbox/images/photo.jpg');

    // IPC 载荷保持纯指针（不夹带 MB 级 b64 跨进程）。
    expect(bridge.streamAgentMessage).toHaveBeenCalledTimes(1);
    const payload = bridge.streamAgentMessage.mock.calls[0][0];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].dataUrl).toBeUndefined();
    expect(payload.attachments[0]).toMatchObject({
      type: 'image',
      path: 'inbox/images/photo.jpg',
      b64hash: EXPECTED_HASH,
    });

    // 发送消费清场（A3 语义沿用）。
    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
  });
});
