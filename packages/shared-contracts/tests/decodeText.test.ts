import { describe, expect, it } from 'vitest';
import { decodeFileToUtf8 } from '../src/fs/decodeText';

// 下沉直测：完整行为面由 shell 套件覆盖（apps/desktop/client/shell/test/decodeText.test.ts），
// 这里只锚 GBK 兜底与 CRLF 归一两条关键路径，防下沉面在包内静默漂移。

describe('decodeFileToUtf8', () => {
  it('falls back to GBK when bytes are not valid UTF-8', () => {
    // "中文" in GBK: D6 D0 CE C4 — an illegal UTF-8 sequence.
    const buffer = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeFileToUtf8(buffer)).toBe('中文');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    const buffer = Buffer.from('a\r\nb\rc\nd', 'utf-8');
    expect(decodeFileToUtf8(buffer)).toBe('a\nb\nc\nd');
  });
});
