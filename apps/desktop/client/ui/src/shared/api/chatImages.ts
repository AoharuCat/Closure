import type { SavedImageFile } from '@orison/shared-contracts';
import { normalizePath } from '../utils/paths';

/**
 * 09-01 B4（task 09-01-agent-chat-attachments B 波 / dogfood #45，design §2.1/§2.2）：
 * Agent 对话框 chat 图片附件的 UI api 层——渲染层 canvas 预检压缩（纯代码：尺寸/字节
 * 阈值不理解意义，范式判据归纯代码侧）+ 落盘字节 sha256 指纹 + `project:save-base64-image`
 * 包装（directory='inbox/images' + notify）。mirror A 波 inboxAttachments.ts 的「IPC 包装 +
 * 纯 helper 同文件」形态。
 *
 * b64hash 形态对齐（🔴 与 B3 逐字一致是硬约束）：shell 侧
 * `agentImageParts.resolveImageBytes`（apps/desktop/client/shell/main/ipc/agentImageParts.ts）
 * 以 `createHash('sha256').update(bytes).digest('hex')` 算落盘字节指纹、比对侧
 * `b64hash.trim().toLowerCase()`——即**落盘原始字节的 sha256、小写 hex、无前缀**。
 * 本层 {@link sha256Hex} 用 WebCrypto 对同一批字节产出完全相同的 digest（sha256 是确定
 * 性算法，Node crypto 与 WebCrypto 同结果）；字节源 = 与 `b64Json` 载荷严格同源
 * （同一 base64 串：FileReader 读出 / canvas toDataURL 产出，atob 解码即 shell
 * `Buffer.from(b64Json,'base64')` 的同批字节），保证指纹与落盘内容一致。
 */

/** 惰性取桥（勿模块级捕获——测试在 beforeEach 里装 `(window as any).orisonDesktop`，晚于模块加载）。 */
const api = () => window.orisonDesktop;

/** 进件白名单（R2.2）：png/jpg/jpeg/webp/gif——SVG/HEIC 等拒收提示。 */
export const CHAT_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

const CHAT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 隐藏 file input 的 accept 面（选择器只给白名单格式）。 */
export const CHAT_IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif';

/** 进件预检闸（R2.2/#45 拍板「两档再拒」）：>10MB 触发 canvas 重编码。 */
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 两档 JPG 重编码质量（#45 规格：q0.85 → 仍超 q0.6 → 仍超拒收）。 */
export const CHAT_IMAGE_JPEG_QUALITIES = [0.85, 0.6] as const;

export type ChatImageCompressResult =
  | {
      ok: true;
      /** 与 b64Json 载荷严格同源的字节（hash 输入；shell 侧解出的即这批字节）。 */
      bytes: Uint8Array;
      /** 落盘载荷（save-base64-image 的 b64Json）。 */
      b64: string;
      /** 落盘 mime（passthrough = 原文件 mime；压缩后 = 'image/jpeg'）。 */
      mimeType: string;
      /** chip 缩略图直显用（R2.6 pending 态即显——压缩后的 dataUrl / 原样文件的 dataUrl）。 */
      dataUrl: string;
      width: number;
      height: number;
    }
  | { ok: false; reason: 'not-image' | 'too-large' | 'decode-failed' };

/** 白名单判定：mime 或扩展名任一命中（粘贴 File 常带标准 mime、选择器 File 常只有名）。 */
export function isChatImageFile(file: File): boolean {
  return CHAT_IMAGE_MIME.has(file.type) || CHAT_IMAGE_EXT_RE.test(file.name);
}

// ── base64 → 字节（atob 解码 = Node Buffer.from(b64,'base64') 的精确逆，见文件头）──

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function extMime(name: string): string {
  const m = CHAT_IMAGE_EXT_RE.exec(name);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * File → dataURL（FileReader 通用路径：Chromium 与 jsdom 均全实现——File#arrayBuffer 在
 * jsdom 缺席，不走）。失败 reject（读盘/File 撤销等）。
 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('file read failed'));
    reader.onabort = () => reject(new Error('file read aborted'));
    reader.readAsDataURL(file);
  });
}

/** dataURL → { b64, bytes }（base64 段解出；与 shell `Buffer.from(b64Json,'base64')` 同源）。 */
function splitDataUrl(dataUrl: string): { b64: string; bytes: Uint8Array } | null {
  const match = /^data:[^;,]*(?:;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const b64 = match[1];
  return { b64, bytes: base64ToBytes(b64) };
}

// ── 解码（尺寸 + 压缩画布源；GIF 解码即首帧——canvas drawImage 只绘首帧）──

type DecodableImage = HTMLImageElement & { decode?: () => Promise<void> };

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image() as DecodableImage;
    img.onload = () => {
      const dec = img.decode;
      if (typeof dec === 'function') {
        // decode() 惰性解码（大图首绘不卡）；失败不致命——onload 已保证可绘。
        dec.call(img).then(() => resolve(img), () => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/** canvas 重编码为 JPG（透明底填白——JPG 无 alpha，防透明 PNG 转出黑底）。 */
function reencodeJpeg(img: HTMLImageElement, width: number, height: number, quality: number): { b64: string; bytes: Uint8Array } | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const marker = 'base64,';
  const idx = dataUrl.indexOf(marker);
  if (idx === -1 || !dataUrl.startsWith('data:image/jpeg')) return null;
  const b64 = dataUrl.slice(idx + marker.length);
  return { b64, bytes: base64ToBytes(b64) };
}

/**
 * 进件预检压缩（R2.2，纯函数 + DOM 依赖可 mock）：
 * - 非白名单（SVG/HEIC 等）→ `not-image` 拒收；
 * - ≤10MB 原样放行（零重编码质量损失；GIF 保动图）；
 * - >10MB → canvas 重编码 JPG q0.85 → 仍超 q0.6 → 仍超 `too-large` 拒收（#45 两档拍板）。
 *   GIF >10MB 走同路径 = 取首帧转 JPG（动图本就不在 vision 有效输入面）。
 * 解码失败（损坏文件）→ `decode-failed`。
 */
export async function compressChatImage(file: File): Promise<ChatImageCompressResult> {
  if (!isChatImageFile(file)) return { ok: false, reason: 'not-image' };
  let bytes: Uint8Array;
  let fileB64: string;
  try {
    const read = await readFileAsDataUrl(file);
    const split = splitDataUrl(read);
    if (!split) return { ok: false, reason: 'decode-failed' };
    ({ b64: fileB64, bytes } = split);
  } catch {
    return { ok: false, reason: 'decode-failed' };
  }
  const mimeType = file.type || extMime(file.name) || 'image/png';
  let img: HTMLImageElement;
  try {
    img = await loadImageElement(`data:${mimeType};base64,${fileB64}`);
  } catch {
    return { ok: false, reason: 'decode-failed' };
  }
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (bytes.length <= CHAT_IMAGE_MAX_BYTES) {
    return {
      ok: true,
      bytes,
      b64: fileB64,
      mimeType,
      dataUrl: `data:${mimeType};base64,${fileB64}`,
      width,
      height,
    };
  }
  for (const quality of CHAT_IMAGE_JPEG_QUALITIES) {
    const reencoded = reencodeJpeg(img, width, height, quality);
    if (reencoded && reencoded.bytes.length <= CHAT_IMAGE_MAX_BYTES) {
      return {
        ok: true,
        bytes: reencoded.bytes,
        b64: reencoded.b64,
        mimeType: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${reencoded.b64}`,
        width,
        height,
      };
    }
  }
  return { ok: false, reason: 'too-large' };
}

// ── 指纹（🔴 形态与 B3 逐字一致，见文件头注释）──

/**
 * sha256(字节) → **小写 hex、无前缀**。与 shell `createHash('sha256').update(bytes)
 * .digest('hex')`（agentImageParts.ts:169）对同一批字节产出逐字符相同的 digest——
 * sha256 确定性，WebCrypto 与 Node crypto 同结果；比对侧 `.trim().toLowerCase()`
 * 天然兼容。输入必须是「即将作为 b64Json 落盘的那批字节」（见 compressChatImage 契约）。
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('crypto.subtle unavailable');
  const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── 落盘（inbox/images + 显式 file:changed）──

/**
 * 传 shell 的文件名基干（剥扩展名）：createImageFileName 会按落盘 mime 追加正确扩展
 * （png→.png / jpeg→.jpg）——直传原名会在格式转换时产出 `photo.png.jpg` 这类双扩展名。
 */
export function imageFileStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim();
  return stem || `image-${Date.now()}`;
}

/**
 * 压缩后字节落 `<project>/inbox/images/`（R2.3）。directory/notify 参数形态见
 * SaveBase64ImageInput 契约注释（notify=true → 落盘后 file:changed，文件树即时可见）。
 */
export function saveChatImage(
  projectPath: string,
  b64Json: string,
  mimeType: string,
  fileNameStem: string,
): Promise<SavedImageFile> {
  return api()!.saveBase64Image(projectPath, {
    b64Json,
    mimeType,
    directory: 'inbox/images',
    notify: true,
    fileName: fileNameStem,
  });
}

/** 气泡缩略图的盘读绝对路径（ImageReferenceThumb 用，ProjectTree.tsx:230 同款拼接）。 */
export function chatImageAbsolutePath(projectPath: string, imageRelPath: string): string {
  return normalizePath(`${projectPath}/${imageRelPath.replace(/^\/+/, '')}`);
}

/**
 * CR-003a（决议 a）：识图转述进度订阅（channel `image-relay-progress`，shell generate 缝
 * 全窗广播 {current, total}）。收口经 api 层（boundary rule——features/store 不直碰
 * window.orisonDesktop）；形态 mirror preload onUpdateEvent / onToolEvent（返回退订函数，
 * 只移除本监听器）。桥缺席/旧 mock 桥无此方法（测试环境）→ 返回 null = 无订阅无显示。
 */
export function subscribeImageRelayProgress(
  onProgress: (progress: { current: number; total: number }) => void,
): (() => void) | null {
  const off = window.orisonDesktop?.onImageRelayProgress?.(onProgress);
  return typeof off === 'function' ? off : null;
}
