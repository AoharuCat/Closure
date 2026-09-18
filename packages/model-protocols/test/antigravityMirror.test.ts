import { describe, expect, it } from 'vitest';
import { diffMirror, hashSegment, hashSegments } from '../src/antigravityCli/mirror';

describe('antigravityCli mirror（内容锚定，design §3.2）', () => {
  it('hashSegment: 确定性 + 段间可区分（sha256 hex）', () => {
    expect(hashSegment('A')).toBe(hashSegment('A'));
    expect(hashSegment('A')).not.toBe(hashSegment('B'));
    expect(hashSegment('A')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSegments(['A', 'B', 'A'])).toEqual([hashSegment('A'), hashSegment('B'), hashSegment('A')]);
  });

  it('分支 1 冷启动：mirror undefined / 空数组', () => {
    expect(diffMirror(undefined, ['a', 'b'])).toEqual({ kind: 'cold-start' });
    expect(diffMirror([], ['a', 'b'])).toEqual({ kind: 'cold-start' });
    expect(diffMirror([], [])).toEqual({ kind: 'cold-start' });
  });

  it('分支 2 追加：mirror 是新序列真前缀 → append + prefixLength', () => {
    expect(diffMirror(['a', 'b'], ['a', 'b', 'c'])).toEqual({ kind: 'append', prefixLength: 2 });
    expect(diffMirror(['a'], ['a', 'b', 'c'])).toEqual({ kind: 'append', prefixLength: 1 });
  });

  it('分支 3 分歧：前缀不一致 / 序列收缩', () => {
    expect(diffMirror(['a', 'x'], ['a', 'b', 'c'])).toEqual({ kind: 'diverge', reason: 'prefix-mismatch' });
    expect(diffMirror(['a', 'b', 'c'], ['a', 'b'])).toEqual({ kind: 'diverge', reason: 'shrunk' });
  });

  it('分支 4 零尾段（重复请求，复核 M5）：完全相等 → 视作分歧（保守冷重启，不发空 turn）', () => {
    expect(diffMirror(['a', 'b'], ['a', 'b'])).toEqual({ kind: 'diverge', reason: 'zero-tail' });
  });

  it('内容锚定：相同内容不同「消息」天然等价（hash 相等即匹配）', () => {
    const mirror = hashSegments(['【用户】\n你好', '【助手】\n在']);
    const incoming = hashSegments(['【用户】\n你好', '【助手】\n在', '【用户】\n继续']);
    expect(diffMirror(mirror, incoming)).toEqual({ kind: 'append', prefixLength: 2 });
  });

  it('system 变化（同消息前缀下第 0 段不同）→ 前缀失配判分歧', () => {
    const mirror = hashSegments(['指令块A', 'msg1']);
    const incoming = hashSegments(['指令块B', 'msg1']);
    expect(diffMirror(mirror, incoming)).toEqual({ kind: 'diverge', reason: 'prefix-mismatch' });
  });
});
