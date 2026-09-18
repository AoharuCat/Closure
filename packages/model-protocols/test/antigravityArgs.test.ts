import { describe, expect, it } from 'vitest';
import {
  buildCliArgs,
  effortArgForThinking,
  printTimeoutForLane,
  PRINT_TIMEOUT_GRACE_MS,
  BRIDGE_PRINT_TIMEOUT,
  BRIDGE_PRINT_TIMEOUT_GRACE_MS,
} from '../src/antigravityCli/args';

describe('antigravityCli args', () => {
  it('snapshot: background lane + thinking low → full arg array (no -p ever)', () => {
    expect(
      buildCliArgs({ model: 'gemini-3.8-pro-high', lane: 'background', thinking: { level: 'low' } }),
    ).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--model', 'gemini-3.8-pro-high',
      '--print-timeout', '12m',
      '--effort', 'low',
    ]);
  });

  it('snapshot: dialogue lane + thinking medium', () => {
    expect(
      buildCliArgs({ model: 'claude-sonnet-4-6', lane: 'dialogue', thinking: { level: 'medium' } }),
    ).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--model', 'claude-sonnet-4-6',
      '--print-timeout', '3m',
      '--effort', 'medium',
    ]);
  });

  it('snapshot: lane absent → default 5m print-timeout', () => {
    expect(buildCliArgs({ model: 'gpt-oss-120b-medium' })).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--model', 'gpt-oss-120b-medium',
      '--print-timeout', '5m',
    ]);
  });

  it('thinking map: low/medium/high → 同名；auto/off/max/custom/缺席 → 不传', () => {
    expect(effortArgForThinking({ level: 'low' })).toBe('low');
    expect(effortArgForThinking({ level: 'medium' })).toBe('medium');
    expect(effortArgForThinking({ level: 'high' })).toBe('high');
    expect(effortArgForThinking({ level: 'auto' })).toBeUndefined();
    expect(effortArgForThinking({ level: 'off' })).toBeUndefined();
    expect(effortArgForThinking({ level: 'max' })).toBeUndefined();
    expect(effortArgForThinking({ level: 'custom', custom: 'bogus' })).toBeUndefined();
    expect(effortArgForThinking(undefined)).toBeUndefined();
  });

  it('thinking absent/auto produce no --effort flag anywhere in the array', () => {
    const args = buildCliArgs({ model: 'm', lane: 'background', thinking: { level: 'max' } });
    expect(args).not.toContain('--effort');
    expect(args).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--model', 'm',
      '--print-timeout', '12m',
    ]);
  });

  it('print-timeout map（lane → arg/ms）+ 外层兜底宽限常量', () => {
    expect(printTimeoutForLane('dialogue')).toEqual({ arg: '3m', ms: 180_000 });
    expect(printTimeoutForLane('background')).toEqual({ arg: '12m', ms: 720_000 });
    expect(printTimeoutForLane(undefined)).toEqual({ arg: '5m', ms: 300_000 });
    // 外层兜底 = print-timeout + 60s（design §3.3 纯文本档）。
    expect(PRINT_TIMEOUT_GRACE_MS).toBe(60_000);
  });

  it('桥档外层兜底（CR-20）：30m print-timeout + 5m 专属 grace——与纯文本 60s 分档', () => {
    expect(BRIDGE_PRINT_TIMEOUT).toEqual({ arg: '30m', ms: 30 * 60_000 });
    // design §5.5 桥档宽限 +5m（勿复用纯文本 60s——30m 档下余量不足）。
    expect(BRIDGE_PRINT_TIMEOUT_GRACE_MS).toBe(5 * 60_000);
    expect(BRIDGE_PRINT_TIMEOUT_GRACE_MS).not.toBe(PRINT_TIMEOUT_GRACE_MS);
  });

  it('枚举外 lane 安全回落默认 5m（agent 缝 as any 直调豁免 parse——CR-35 垃圾 lane 防崩）', () => {
    // 裸查表会返 undefined，调用方 printTimeout.arg 即 TypeError——本用例钉回落不崩。
    expect(printTimeoutForLane('backgroundx' as never)).toEqual({ arg: '5m', ms: 300_000 });
    expect(buildCliArgs({ model: 'm', lane: 'backgroundx' as never })).toContain('--print-timeout');
  });
});
