import { describe, expect, it } from 'vitest';

import { isStaleAgyTempEntry } from '../main/fs/agyTempSweep';

// ─────────────────────────────────────────────────────────────────────────────
// agy tmp 启动清扫的陈旧判定谓词（纯函数）测试钉，三道防线：
// 1. 名形精确匹配 mkdtemp('agy-') 产物（`agy-` + 6 位 [A-Za-z0-9]）——共享 tmpdir
//    里第三方 `agy-` 前缀条目一律不判陈旧。
// 2. 非目录条目不判陈旧（第三方同名前缀文件不删）。
// 3. 陈旧判据 = 目录自身 + 直接子项的最大 mtime——只看目录 mtime 会误删长活跃
//    会话（目录 mtime 不随子文件覆写刷新）；空目录视为陈旧可删。
// ─────────────────────────────────────────────────────────────────────────────

const CUTOFF = 1_000_000;
const OLD = CUTOFF - 1;
const FRESH = CUTOFF + 999_000;
const dir = (mtimeMs: number) => ({ isDirectory: true, mtimeMs });
const file = (mtimeMs: number) => ({ isDirectory: false, mtimeMs });

describe('isStaleAgyTempEntry（agy tmp 清扫陈旧判定谓词）', () => {
  it('名形 = `agy-` + 恰 6 位字母数字；其余一律不判陈旧', () => {
    const staleSelf = dir(OLD);
    expect(isStaleAgyTempEntry('agy-Ab12Xy', staleSelf, [], CUTOFF)).toBe(true);

    // 长度/字符集/大小写形态越界（生产 mkdtemp 前缀恒小写 'agy-'）
    expect(isStaleAgyTempEntry('agy-abc12', staleSelf, [], CUTOFF)).toBe(false);
    expect(isStaleAgyTempEntry('agy-abcdefg', staleSelf, [], CUTOFF)).toBe(false);
    expect(isStaleAgyTempEntry('agy-abc12!', staleSelf, [], CUTOFF)).toBe(false);
    expect(isStaleAgyTempEntry('agy-', staleSelf, [], CUTOFF)).toBe(false);
    expect(isStaleAgyTempEntry('AGY-ABC123', staleSelf, [], CUTOFF)).toBe(false);
    // 旧 startsWith('agy-') 口径会误中的形态——精确名形拒之
    expect(isStaleAgyTempEntry('agy-abc123xyz', staleSelf, [], CUTOFF)).toBe(false);
    expect(isStaleAgyTempEntry('agy-user-profile', staleSelf, [], CUTOFF)).toBe(false);
  });

  it('非目录条目（第三方同名前缀文件）不判陈旧——绝不删', () => {
    expect(isStaleAgyTempEntry('agy-Ab12Xy', file(OLD), [], CUTOFF)).toBe(false);
  });

  it('空目录视为陈旧可删（与 mtime 无关）', () => {
    expect(isStaleAgyTempEntry('agy-Ab12Xy', dir(FRESH), [], CUTOFF)).toBe(true);
  });

  it('陈旧 = 目录与直接子项最大 mtime < cutoff——任一子项活跃即保留', () => {
    // 目录 mtime 老，但子文件覆写刷新（长活跃会话被目录 mtime 口径误删的场景）
    expect(isStaleAgyTempEntry('agy-Ab12Xy', dir(OLD), [OLD, FRESH], CUTOFF)).toBe(false);
    // 全部沉寂
    expect(isStaleAgyTempEntry('agy-Ab12Xy', dir(OLD), [OLD, OLD], CUTOFF)).toBe(true);
    // 目录自身仍新
    expect(isStaleAgyTempEntry('agy-Ab12Xy', dir(FRESH), [OLD], CUTOFF)).toBe(false);
  });

  it('不可读子项（保守 Infinity 形态）按活跃处理——宁可漏删', () => {
    expect(
      isStaleAgyTempEntry('agy-Ab12Xy', dir(OLD), [OLD, Number.POSITIVE_INFINITY], CUTOFF),
    ).toBe(false);
  });
});
