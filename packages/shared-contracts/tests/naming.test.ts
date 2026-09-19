import { describe, expect, it } from 'vitest';
import {
  assertSafeDiskName,
  DEFAULT_DISK_NAME_MAX_LENGTH,
  DiskNameViolationError,
  type DiskNameViolationReason,
  findDiskNameViolation,
  PROJECT_NAME_MAX_LENGTH,
  sanitizeDiskName,
  WINDOWS_RESERVED_NAMES,
} from '../src/fs/naming';

// 控制字符经 String.fromCharCode 构造，源码零控制字节（字面控制字节会让 git
// 把文件当二进制）。
const NUL = String.fromCharCode(0);
const CTRL_01 = String.fromCharCode(1);
const DEL = String.fromCharCode(0x7f);

describe('WINDOWS_RESERVED_NAMES', () => {
  it('matches the Windows device-name full set (CON/PRN/AUX/NUL + COM1-9 + LPT1-9)', () => {
    expect([...WINDOWS_RESERVED_NAMES].sort()).toEqual([
      'aux',
      'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
      'con',
      'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
      'nul',
      'prn',
    ]);
  });
});

describe('findDiskNameViolation', () => {
  it('flags every reserved name case-insensitively', () => {
    for (const reserved of WINDOWS_RESERVED_NAMES) {
      expect(findDiskNameViolation(reserved)).toBe('reserved');
      expect(findDiskNameViolation(reserved.toUpperCase())).toBe('reserved');
      expect(findDiskNameViolation(reserved[0].toUpperCase() + reserved.slice(1))).toBe('reserved');
    }
  });

  it('compares the stem before the first dot (Windows device-name semantics)', () => {
    expect(findDiskNameViolation('con.md')).toBe('reserved');
    expect(findDiskNameViolation('Nul.TXT')).toBe('reserved');
    expect(findDiskNameViolation('report.con')).toBeNull();
    expect(findDiskNameViolation('second')).toBeNull();
    expect(findDiskNameViolation('cone')).toBeNull();
  });

  it('flags Windows-illegal characters', () => {
    for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(findDiskNameViolation(`a${ch}b`)).toBe('illegal-char');
    }
  });

  it('flags trailing dots and spaces', () => {
    expect(findDiskNameViolation('报告.')).toBe('trailing-dot-space');
    expect(findDiskNameViolation('笔记 .')).toBe('trailing-dot-space');
    expect(findDiskNameViolation('x..')).toBe('trailing-dot-space');
    expect(findDiskNameViolation('name ')).toBe('trailing-dot-space');
  });

  it('flags control characters including NUL, newlines, tab and DEL', () => {
    expect(findDiskNameViolation(`a${NUL}b`)).toBe('control-char');
    expect(findDiskNameViolation(`a${CTRL_01}b`)).toBe('control-char');
    expect(findDiskNameViolation('第一\n章')).toBe('control-char');
    expect(findDiskNameViolation('tab\there')).toBe('control-char');
    expect(findDiskNameViolation(`del${DEL}ete`)).toBe('control-char');
  });

  it('enforces the length cap (default 80, project 60 via opts)', () => {
    expect(findDiskNameViolation('a'.repeat(DEFAULT_DISK_NAME_MAX_LENGTH))).toBeNull();
    expect(findDiskNameViolation('a'.repeat(DEFAULT_DISK_NAME_MAX_LENGTH + 1))).toBe('too-long');
    expect(
      findDiskNameViolation('a'.repeat(PROJECT_NAME_MAX_LENGTH), { maxLength: PROJECT_NAME_MAX_LENGTH }),
    ).toBeNull();
    expect(
      findDiskNameViolation('a'.repeat(PROJECT_NAME_MAX_LENGTH + 1), { maxLength: PROJECT_NAME_MAX_LENGTH }),
    ).toBe('too-long');
  });

  it('reports violations in a fixed order (reserved wins over trailing-dot-space / too-long)', () => {
    // 「CON:」的主名段是「con:」不属保留名，illegal-char 正确先行；真正的重叠态：
    expect(findDiskNameViolation('CON.')).toBe('reserved');
    expect(findDiskNameViolation('con', { maxLength: 2 })).toBe('reserved');
    expect(findDiskNameViolation(': ')).toBe('illegal-char');
  });

  it('passes legal names including Chinese and dotted names', () => {
    expect(findDiskNameViolation('第一章 你好世界')).toBeNull();
    expect(findDiskNameViolation('notes.md')).toBeNull();
    expect(findDiskNameViolation('my-file_v2.txt')).toBeNull();
    expect(findDiskNameViolation('数据 2026 汇总')).toBeNull();
    expect(findDiskNameViolation('第01章-破境.md')).toBeNull();
  });

  it('leaves the empty-name decision to the caller (not one of the five reasons)', () => {
    expect(findDiskNameViolation('')).toBeNull();
  });
});

describe('assertSafeDiskName', () => {
  it('throws a typed error carrying the reason and the offending name', () => {
    let reserved: unknown;
    try {
      assertSafeDiskName('con');
    } catch (err) {
      reserved = err;
    }
    expect(reserved).toBeInstanceOf(DiskNameViolationError);
    expect((reserved as DiskNameViolationError).reason).toBe('reserved');

    let illegal: unknown;
    try {
      assertSafeDiskName('报告:卷一', { maxLength: PROJECT_NAME_MAX_LENGTH });
    } catch (err) {
      illegal = err;
    }
    expect(illegal).toBeInstanceOf(DiskNameViolationError);
    expect((illegal as DiskNameViolationError).reason).toBe('illegal-char');
    expect((illegal as DiskNameViolationError).diskName).toBe('报告:卷一');
  });

  it('passes legal names through untouched', () => {
    expect(() => assertSafeDiskName('合法 名.md')).not.toThrow();
    expect(() => assertSafeDiskName('我的项目', { maxLength: PROJECT_NAME_MAX_LENGTH })).not.toThrow();
  });

  // CR-7b：message = 中文文案 + 原名 + reason 代码三者并存——renderer 直接透成
  // toast 可读，按 reason 子串匹配的程序化消费不破。
  it('message carries the Chinese copy, the original name and the reason code together (CR-7b)', () => {
    const cases: Array<[string, DiskNameViolationReason, string]> = [
      ['con', 'reserved', '保留'],
      ['报告:卷一', 'illegal-char', '非法字符'],
      ['笔记.', 'trailing-dot-space', '结尾'],
      [`a${NUL}b`, 'control-char', '控制字符'],
      ['a'.repeat(81), 'too-long', '长度'],
    ];
    for (const [name, reason, zhKeyword] of cases) {
      let err: unknown;
      try {
        assertSafeDiskName(name);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DiskNameViolationError);
      const violation = err as DiskNameViolationError;
      expect(violation.reason).toBe(reason);
      expect(violation.diskName).toBe(name);
      expect(violation.message).toContain(zhKeyword);
      expect(violation.message).toContain(name);
      expect(violation.message).toContain(reason);
    }
  });
});

describe('sanitizeDiskName', () => {
  it('replaces illegal/control characters and strips trailing dots/spaces', () => {
    expect(sanitizeDiskName('报告:卷一')).toBe('报告-卷一');
    expect(sanitizeDiskName('a*b?c')).toBe('a-b-c');
    expect(sanitizeDiskName(`a${NUL}b`)).toBe('a-b');
    expect(sanitizeDiskName('title...')).toBe('title');
    expect(sanitizeDiskName('name ')).toBe('name');
  });

  it('dodges reserved names with a -doc suffix before the extension', () => {
    expect(sanitizeDiskName('con')).toBe('con-doc');
    expect(sanitizeDiskName('CON')).toBe('CON-doc');
    expect(sanitizeDiskName('CON.md')).toBe('CON-doc.md');
    expect(sanitizeDiskName('con.')).toBe('con-doc');
    expect(sanitizeDiskName('aux')).toBe('aux-doc');
  });

  it('caps length and repairs the trailing shape after capping', () => {
    expect(sanitizeDiskName('x'.repeat(120))).toBe('x'.repeat(DEFAULT_DISK_NAME_MAX_LENGTH));
    expect(sanitizeDiskName('y'.repeat(100), { maxLength: PROJECT_NAME_MAX_LENGTH })).toBe(
      'y'.repeat(PROJECT_NAME_MAX_LENGTH),
    );
    // 截断把内部点/空格暴露成结尾形态——截断后要再修一次结尾。
    expect(sanitizeDiskName('a'.repeat(78) + ' .' + 'b'.repeat(50))).toBe('a'.repeat(78));
  });

  it('is idempotent and its output always passes the check', () => {
    const corpus = [
      '报告:卷一',
      'con',
      'CON.md',
      'title...',
      'a*b?c',
      'x'.repeat(120),
      'normal-name.md',
      '第一章 你好',
      'aux',
      'a'.repeat(78) + ' .' + 'b'.repeat(50),
      '',
      '   ',
      '...',
      '.md',
    ];
    for (const name of corpus) {
      const once = sanitizeDiskName(name);
      expect(sanitizeDiskName(once)).toBe(once);
      expect(findDiskNameViolation(once)).toBeNull();
    }
  });

  // ── CR-2a：截断后的保留名复检——截断会把非保留名削成保留名，也会把 '-doc'
  // 闪避后缀削掉让保留名主名段重新裸露。输出必过 findDiskNameViolation 的承诺
  // 对任意帽长真实成立。──

  it('re-dodges when truncation carves a non-reserved name into a reserved one (CR-2a)', () => {
    // 'const' 帽 3 → 'con'（保留）→ 重闪避振荡出口 → 末字符换 '-' → 'co-'。
    expect(sanitizeDiskName('const', { maxLength: 3 })).toBe('co-');
    expect(findDiskNameViolation('co-')).toBeNull();
    // 保留名带扩展名、截断把主名段重新裸露：'com5.txt' 帽 4 → 'com5'（保留）→ 振荡 → 'com-'。
    expect(sanitizeDiskName('com5.txt', { maxLength: 4 })).toBe('com-');
    // '-doc' 后缀部分入帽的形态不需兜底：'CON.md' 帽 4 → 闪避 'CON-doc.md' → 截断
    // 'CON-' → 尾修 → 主名段 'CON-' 非保留，契约直接成立。
    expect(sanitizeDiskName('CON.md', { maxLength: 4 })).toBe('CON-');
  });

  it('output passes the check and stays idempotent across every reserved name at tiny caps (CR-2a)', () => {
    for (const reserved of WINDOWS_RESERVED_NAMES) {
      for (const cap of [3, 4, 5, 6, 7]) {
        const out = sanitizeDiskName(reserved, { maxLength: cap });
        expect(out.length).toBeLessThanOrEqual(cap);
        expect(findDiskNameViolation(out, { maxLength: cap })).toBeNull();
        expect(sanitizeDiskName(out, { maxLength: cap })).toBe(out);
      }
    }
  });

  // ── CR-2b：截断的代理对边界——截断点落在高位代理（0xD800-0xDBFF）上再削一位，
  // 输出不得含孤立代理（无效 UTF-16 码点）。代理经 String.fromCharCode 构造，
  // 源码零代理字节面。──

  it('strips a dangling high surrogate left at the truncation boundary (CR-2b)', () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    // 'a'×79 + 一对代理 = 81 code units；帽 80 的截断点恰落在高位代理上。
    const out = sanitizeDiskName('a'.repeat(79) + high + low);
    expect(out.length).toBe(79);
    expect(out.charCodeAt(out.length - 1)).not.toBe(0xd83d);
    expect(findDiskNameViolation(out)).toBeNull();
    expect(sanitizeDiskName(out)).toBe(out);
  });
});
