// jsdom localStorage polyfill — 确保模块级代码能正常访问
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  } as Storage;
}

import '@testing-library/jest-dom/vitest';

// 09-01 B4（chat 图片附件）：jsdom 的 crypto 无 subtle（sha256Hex 用 WebCrypto）——
// 缺时补 node webcrypto（superset：getRandomValues 面保留，既有测试零影响）。
if (typeof (globalThis.crypto as { subtle?: unknown } | undefined)?.subtle === 'undefined') {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto.crypto,
    configurable: true,
    writable: true,
  });
}

if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}
