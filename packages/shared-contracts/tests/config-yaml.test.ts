import { describe, expect, it } from 'vitest';
import { flatQuoted, parseFlatYaml, stringifyFlatYaml } from '../src';

describe('parseFlatYaml scalar coercion', () => {
  it('coerces strict decimal literals to numbers', () => {
    const cfg = parseFlatYaml('temperature: 0.7\nmaxTokens: 4096\nnegative: -3');
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxTokens).toBe(4096);
    expect(cfg.negative).toBe(-3);
  });

  it('keeps numeric-looking identifiers as strings (no precision loss / no normalization)', () => {
    const cfg = parseFlatYaml([
      'orgId: 1234567890123456789', // 19-digit ID would lose precision as a number
      'pin: 007',                    // leading zeros must survive
      'hex: 0x1f',                   // hex must not become 31
      'version: 1.0',                // must not normalize to 1
    ].join('\n'));
    expect(cfg.orgId).toBe('1234567890123456789');
    expect(cfg.pin).toBe('007');
    expect(cfg.hex).toBe('0x1f');
    expect(cfg.version).toBe('1.0');
  });

  it('parses booleans, null, and quoted strings', () => {
    const cfg = parseFlatYaml('a: true\nb: false\nc: null\nd:\ne: "quoted: value"');
    expect(cfg.a).toBe(true);
    expect(cfg.b).toBe(false);
    expect(cfg.c).toBeNull();
    expect(cfg.d).toBeNull();
    expect(cfg.e).toBe('quoted: value');
  });

  it('round-trips through stringifyFlatYaml without coercing keys', () => {
    const original = { apiKey: 'sk-007', model: 'gpt-4o', temperature: 0.5 };
    const reparsed = parseFlatYaml(stringifyFlatYaml(original));
    expect(reparsed.apiKey).toBe('sk-007');
    expect(reparsed.model).toBe('gpt-4o');
    expect(reparsed.temperature).toBe(0.5);
  });

  it('round-trips backslash-carrying values (Windows paths) without doubling per cycle', () => {
    // formatScalar 对含反斜杠的值 JSON.stringify（写侧转 `\\`）；parseScalar 必须
    // 对称反转义——否则每轮 save/load 反斜杠翻倍累积（09-12 agy cliExecutable 首个
    // 含反斜杠的持久化值触发）。双轮往返钉死不膨胀。
    const original = { cliExecutable: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe' };
    const once = parseFlatYaml(stringifyFlatYaml(original));
    expect(once.cliExecutable).toBe('C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe');
    const twice = parseFlatYaml(stringifyFlatYaml(once));
    expect(twice.cliExecutable).toBe('C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe');

    // 引号与控制符转义同族对称（写侧 JSON.stringify 全谱）。
    expect(parseFlatYaml('k: "say \\"hi\\""').k).toBe('say "hi"');
  });
});

describe('flatQuoted marker (CR-6 09-12 子3 CR 批)', () => {
  it('drift 家族字符串经 flatQuoted 写出后逐字读回（null/true/false/yes/no/on/off/精确数值）', () => {
    const driftFamily = ['null', 'true', 'false', 'yes', 'no', 'on', 'off', '12345', '0.7', '-3'];
    for (const value of driftFamily) {
      const written = stringifyFlatYaml({ 'headers.X-Tag': flatQuoted(value) });
      // 落盘形态是双引号 JSON 串（裸形态会被 parseScalar 重释成 null/布尔/数值）。
      expect(written).toContain(`headers.X-Tag: ${JSON.stringify(value)}`);
      expect(parseFlatYaml(written)['headers.X-Tag']).toBe(value);
    }
  });

  it('普通字符串 flatQuoted 同样保真（charset 通过的值也无害）；含引号/反斜杠值转义对称', () => {
    expect(parseFlatYaml(stringifyFlatYaml({ h: flatQuoted('closure') })).h).toBe('closure');
    expect(parseFlatYaml(stringifyFlatYaml({ h: flatQuoted('say "hi" \\ ok') })).h).toBe('say "hi" \\ ok');
  });

  it('未标记的字符串保持既有裸形态（其它写盘面字节不变——零回归门）', () => {
    expect(stringifyFlatYaml({ apiKey: 'sk-007', n: 12345, b: true })).toBe('apiKey: sk-007\nn: 12345\nb: true\n');
  });
});
