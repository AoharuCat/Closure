/**
 * compressChatImage 压缩链单测（task 09-01 B4 / dogfood #45，R2.2 / AC8 前半）。
 *
 * 覆盖：白名单拒收（SVG / HEIC）· ≤10MB 原样放行（零重编码——canvas toDataURL 不被调）·
 * >10MB 两档 JPG（q0.85 → 仍超 q0.6 → 仍超拒收）· GIF 两态（≤10MB 保原样 / >10MB 首帧转
 * JPG）· 解码失败 · sha256Hex 形态钉死（与 shell B3 的 createHash('sha256').digest('hex')
 * 逐字一致——已知向量 + node:crypto 交叉验证）。
 *
 * jsdom mock 面（模块依赖 DOM API）：Image（解码/尺寸）+ HTMLCanvasElement.prototype
 * getContext/toDataURL（重编码画布）。File#arrayBuffer / FileReader 不经（模块用
 * arrayBuffer + btoa，jsdom 原生可用）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CHAT_IMAGE_ACCEPT,
  CHAT_IMAGE_MAX_BYTES,
  compressChatImage,
  isChatImageFile,
  sha256Hex,
} from '../src/shared/api/chatImages';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function imageFile(bytes: number[] | Uint8Array, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** b64 构造器：atob 解码后字节数**精确**等于 n（尾组按 rem 补 '=' padding）。 */
function b64OfLength(n: number): string {
  const full = Math.floor(n / 3);
  const rem = n % 3;
  let b64 = 'A'.repeat(full * 4);
  if (rem === 1) b64 += 'AA==';
  else if (rem === 2) b64 += 'AAA=';
  return b64;
}

/** FakeImage——模块经 `new Image()` + src setter 触发 onload/onerror（queueMicrotask 模拟异步解码）。 */
function installImageMock(opts: { width?: number; height?: number; fail?: boolean } = {}) {
  const width = opts.width ?? 640;
  const height = opts.height ?? 480;
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    width = width;
    height = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = '';
    decode = () => Promise.resolve();
    set src(v: string) {
      this._src = v;
      if (opts.fail) queueMicrotask(() => this.onerror?.());
      else queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src; }
  }
  vi.stubGlobal('Image', FakeImage as unknown as typeof Image);
}

/** canvas mock：按 (type|quality) 返回预设 dataURL；未预期组合抛错（防静默走错档）。 */
function installCanvasMock(dataUrls: Record<string, string>) {
  const ctxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const toDataUrlSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    ((type?: string, quality?: unknown) => {
      const key = `${type}|${typeof quality === 'number' ? quality : 1}`;
      const url = dataUrls[key];
      if (url === undefined) throw new Error(`unexpected toDataURL(${key})`);
      return url;
    }) as HTMLCanvasElement['toDataURL'],
  );
  return { ctxSpy, toDataUrlSpy };
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => { setTimeout(r, 0); });
  }
}

let restoreFns: Array<() => void> = [];

beforeEach(() => {
  restoreFns = [];
});

afterEach(() => {
  for (const fn of restoreFns) fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isChatImageFile（白名单判定）', () => {
  it('白名单四族命中（mime 或扩展名任一）', () => {
    expect(isChatImageFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBe(true);
    expect(isChatImageFile(new File(['x'], 'b.JPG', { type: '' }))).toBe(true); // 扩展名兜底（mime 缺席）
    expect(isChatImageFile(new File(['x'], 'image.png', { type: 'image/png' }))).toBe(true);
    expect(isChatImageFile(new File(['x'], 'c.webp', { type: 'image/webp' }))).toBe(true);
    expect(isChatImageFile(new File(['x'], 'd.gif', { type: 'image/gif' }))).toBe(true);
  });

  it('非白名单拒收：SVG / HEIC（R2.2 / AC8）', () => {
    expect(isChatImageFile(new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' }))).toBe(false);
    expect(isChatImageFile(new File(['x'], 'photo.heic', { type: 'image/heic' }))).toBe(false);
  });

  it('accept 面与白名单一致（选择器只给白名单格式）', () => {
    expect(CHAT_IMAGE_ACCEPT).toBe('.png,.jpg,.jpeg,.webp,.gif');
  });
});

describe('compressChatImage ≤10MB 原样放行（零重编码）', () => {
  it('png 原样：bytes 与原文件逐字节一致 + 原始 mime + 尺寸，canvas 不被调', async () => {
    installImageMock({ width: 1920, height: 1080 });
    const { toDataUrlSpy } = installCanvasMock({});
    restoreFns.push(() => toDataUrlSpy.mockRestore());
    const bytes = [...PNG_MAGIC, ...new Array<number>(1024).fill(7)];
    const file = imageFile(bytes, '图.png', 'image/png');

    const result = await compressChatImage(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.bytes)).toEqual(bytes);
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    // b64 载荷与字节严格同源（b64hash 输入 = shell 解码结果，见模块头契约）。
    expect(result.b64.length > 0).toBe(true);
    expect(toDataUrlSpy).not.toHaveBeenCalled();
  });

  it('gif ≤10MB 原样放行（动图保留——重编码会丢动画，design §2.1）', async () => {
    installImageMock({ width: 120, height: 90 });
    const { toDataUrlSpy } = installCanvasMock({});
    restoreFns.push(() => toDataUrlSpy.mockRestore());
    const bytes = new Array<number>(512).fill(3);
    const file = imageFile(bytes, '动图.gif', 'image/gif');

    const result = await compressChatImage(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/gif');
    expect(Array.from(result.bytes)).toEqual(bytes);
    expect(toDataUrlSpy).not.toHaveBeenCalled();
  });
});

describe('compressChatImage >10MB 两档 JPG 重编码（#45 拍板「两档再拒」）', () => {
  function bigPng(): File {
    return imageFile([...PNG_MAGIC, ...new Array<number>(CHAT_IMAGE_MAX_BYTES + 1024).fill(9)], 'big.png', 'image/png');
  }

  it('第一档 q0.85 过闸 → image/jpeg 出门，canvas 恰一档', async () => {
    installImageMock({ width: 8000, height: 6000 });
    const smallJpeg = `data:image/jpeg;base64,${b64OfLength(2048)}`;
    const { toDataUrlSpy } = installCanvasMock({ 'image/jpeg|0.85': smallJpeg });
    restoreFns.push(() => toDataUrlSpy.mockRestore());

    const result = await compressChatImage(bigPng());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.bytes.length).toBe(2048);
    expect(result.dataUrl).toBe(smallJpeg);
    expect(toDataUrlSpy).toHaveBeenCalledTimes(1);
    expect(toDataUrlSpy).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('q0.85 仍超 → q0.6 第二档过闸（两档序贯）', async () => {
    installImageMock({ width: 8000, height: 6000 });
    const tooBig = `data:image/jpeg;base64,${b64OfLength(CHAT_IMAGE_MAX_BYTES + 100)}`;
    const fits = `data:image/jpeg;base64,${b64OfLength(4096)}`;
    const { toDataUrlSpy } = installCanvasMock({
      'image/jpeg|0.85': tooBig,
      'image/jpeg|0.6': fits,
    });
    restoreFns.push(() => toDataUrlSpy.mockRestore());

    const result = await compressChatImage(bigPng());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.bytes.length).toBe(4096);
    expect(toDataUrlSpy).toHaveBeenCalledTimes(2);
  });

  it('两档都压不过 → too-large 拒收（AC8 前半「压不动拒收」）', async () => {
    installImageMock({ width: 8000, height: 6000 });
    const tooBig = `data:image/jpeg;base64,${b64OfLength(CHAT_IMAGE_MAX_BYTES + 100)}`;
    const { toDataUrlSpy } = installCanvasMock({
      'image/jpeg|0.85': tooBig,
      'image/jpeg|0.6': tooBig,
    });
    restoreFns.push(() => toDataUrlSpy.mockRestore());

    const result = await compressChatImage(bigPng());

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(toDataUrlSpy).toHaveBeenCalledTimes(2);
  });

  it('GIF >10MB → 首帧转 JPG（canvas 路径天然首帧，mime 收敛 image/jpeg）', async () => {
    installImageMock({ width: 640, height: 480 });
    const firstFrameJpeg = `data:image/jpeg;base64,${b64OfLength(1024)}`;
    const { toDataUrlSpy } = installCanvasMock({ 'image/jpeg|0.85': firstFrameJpeg });
    restoreFns.push(() => toDataUrlSpy.mockRestore());
    const file = imageFile(
      [...PNG_MAGIC, ...new Array<number>(CHAT_IMAGE_MAX_BYTES + 512).fill(1)],
      'huge.gif',
      'image/gif',
    );

    const result = await compressChatImage(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.bytes.length).toBe(1024);
  });
});

describe('compressChatImage 拒收/失败面', () => {
  it('非白名单（SVG / HEIC）→ not-image（不读字节不解码）', async () => {
    installImageMock();
    const svg = await compressChatImage(new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' }));
    expect(svg).toEqual({ ok: false, reason: 'not-image' });
    const heic = await compressChatImage(new File(['x'], 'photo.heic', { type: 'image/heic' }));
    expect(heic).toEqual({ ok: false, reason: 'not-image' });
    await flush();
  });

  it('解码失败（损坏文件）→ decode-failed', async () => {
    installImageMock({ fail: true });
    const file = imageFile([...PNG_MAGIC, 1, 2, 3], 'broken.png', 'image/png');
    const result = await compressChatImage(file);
    expect(result).toEqual({ ok: false, reason: 'decode-failed' });
    await flush();
  });
});

describe('sha256Hex（🔴 形态与 shell B3 逐字对齐）', () => {
  it('已知向量：sha256("abc") 小写 hex 无前缀', async () => {
    const digest = await sha256Hex(new TextEncoder().encode('abc'));
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it("与 node:crypto createHash('sha256').digest('hex')（B3 agentImageParts.ts:169 同式）逐字符一致", async () => {
    const bytes = new Uint8Array([...PNG_MAGIC, ...new Array<number>(300).fill(0xab), 0, 1, 2]);
    const mine = await sha256Hex(bytes);
    const shell = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    expect(mine).toBe(shell);
    // 形态钉死：64 位小写 hex（比对侧 .trim().toLowerCase() 天然兼容）。
    expect(mine).toMatch(/^[0-9a-f]{64}$/);
  });

  it('b64 载荷解出的字节 = hash 输入字节（同源不变式：shell Buffer.from(b64Json,"base64") 同结果）', async () => {
    // compressChatImage ok 分支的 bytes 与 b64 严格同源——这里锁 base64 往返本身。
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const shellDecoded = Buffer.from(b64, 'base64'); // shell 侧 save-base64-image 解码同式
    expect(await sha256Hex(bytes)).toBe(createHash('sha256').update(shellDecoded).digest('hex'));
  });
});
