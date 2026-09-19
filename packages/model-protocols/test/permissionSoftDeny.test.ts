import { describe, expect, it } from 'vitest';
import {
  findPermissionSoftDenySubject,
  hasMcpPermissionSoftDeny,
  isMcpPermissionSubject,
  parsePermissionSoftDenyMessageSubject,
  parsePermissionSoftDenyStderrSubject,
} from '../src/antigravityCli/permissionSoftDeny';

// ── R6（F13 泛化 + F9 反向）权限软拒族主体判据单源（桥 / 纯文本两车道共用）──
//
// 样本取自 task 09-19-agy-toolface-fix-batch research/f8-builtin-tool-stream-signal.md：
// §2.1（内置工具软拒逐字——主体 read_file）+ 既有 W0 §2（mcp 主体三形态逐字）。
// 判据要点：主体名即分派维度（'mcp' vs 内置工具能力名）；解析不出 ≠ 内置工具（undefined
// 保持中性，消费者不得把没解析出当归族）。

describe('权限软拒族主体判据（R6/F13 泛化）', () => {
  it('主信号（tool_info.error.message 形态）：mcp / 内置工具主体均取名', () => {
    // W0 §2 样本②（mcp 主体——旧针逐字锚）。
    expect(parsePermissionSoftDenyMessageSubject(
      'permission check failed for mcp "novel-writing/write_chapter": user denied permission for mcp(novel-writing/write_chapter)',
    )).toBe('mcp');
    // F8 §2.1 L5（内置工具主体——旧针 `… for mcp "` 在此全打空，F13 的根因）。
    expect(parsePermissionSoftDenyMessageSubject(
      'permission check failed for read_file "C:\\Users\\x\\marker-f08ad4f9": user denied permission for read_file(C:\\Users\\x\\marker-f08ad4f9)',
    )).toBe('read_file');
    // 括号分隔形态（无引号）同吃：主体名到 '(' 为止。
    expect(parsePermissionSoftDenyMessageSubject('permission check failed for mcp(novel-writing/read_file)')).toBe('mcp');
  });

  it('主信号：缺席 / 无前缀 / 空前缀尾 → undefined（不属本族——防过度匹配）', () => {
    expect(parsePermissionSoftDenyMessageSubject(undefined)).toBeUndefined();
    expect(parsePermissionSoftDenyMessageSubject('unknown tool: "totally_fake_xyz" — check spelling')).toBeUndefined();
    expect(parsePermissionSoftDenyMessageSubject('permission check failed for ')).toBeUndefined();
    expect(parsePermissionSoftDenyMessageSubject('permission check failed for   ')).toBeUndefined();
  });

  it('兜底①（stderr 通知形态）：mcp / 内置工具主体均取名', () => {
    expect(parsePermissionSoftDenyStderrSubject(
      'jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.',
    )).toBe('mcp');
    expect(parsePermissionSoftDenyStderrSubject(
      'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_file(<target>)).',
    )).toBe('read_file');
  });

  it('兜底①：尾句缺失 / 无主体形态 → undefined（旧针的无主体子串形态不受影响）', () => {
    expect(parsePermissionSoftDenyStderrSubject('that headless mode cannot prompt for')).toBeUndefined();
    expect(parsePermissionSoftDenyStderrSubject('the "mcp" permission was granted')).toBeUndefined();
    expect(parsePermissionSoftDenyStderrSubject('some unrelated stderr chatter')).toBeUndefined();
  });

  it('findPermissionSoftDenySubject：haystack（终态 message + stderr 拼接）两形态任一命中', () => {
    expect(findPermissionSoftDenySubject(
      'antigravity-cli turn ended with SUCCESS but produced no response text\nthe "read_file" permission that headless mode cannot prompt for',
    )).toBe('read_file');
    expect(findPermissionSoftDenySubject('boilerplate\npermission check failed for mcp "x/y"')).toBe('mcp');
    expect(findPermissionSoftDenySubject('no soft-deny signal here')).toBeUndefined();
  });

  it('CR-3 去装饰归一：引号捕获带装饰（mcp(novel-writing/*)）→ 主体取主名', () => {
    // 不归一时字面等值判据打空 → MCP 主体被判成内置工具族（归因静默翻转）。引号内装饰
    // 是 agy 通知的可变形态；内置能力名同吃（截断后仍非 'mcp'，分类不变）。
    expect(parsePermissionSoftDenyStderrSubject(
      'jetski: no output produced — a tool required the "mcp(novel-writing/*)" permission that headless mode cannot prompt for, so it was auto-denied.',
    )).toBe('mcp');
    expect(parsePermissionSoftDenyStderrSubject(
      'jetski: a tool required the "read_file(C:/tmp/x)" permission that headless mode cannot prompt for',
    )).toBe('read_file');
  });

  it('CR-3 主体优先级：两形态各带一类主体 → MCP 主体优先（显式规则，与文本位置无关）', () => {
    // ① 内置主体在前（主信号形态）+ MCP 主体在后（stderr 形态）。
    expect(findPermissionSoftDenySubject([
      'permission check failed for read_file "C:/tmp/x": denied',
      'jetski: a tool required the "mcp" permission that headless mode cannot prompt for',
    ].join('\n'))).toBe('mcp');
    // ② 反向排布同取 mcp——判据不是「首次命中胜出」（否则归因随样本顺序静默翻转）。
    expect(findPermissionSoftDenySubject([
      'permission check failed for mcp "novel-writing/write_chapter": denied',
      'jetski: a tool required the "command" permission that headless mode cannot prompt for',
    ].join('\n'))).toBe('mcp');
    // ③ 只有内置主体时照旧取内置主体（优先级不吞非 mcp 形态——两向都断言）。
    expect(findPermissionSoftDenySubject('permission check failed for read_file "C:/tmp/x": denied')).toBe('read_file');
  });

  it('CR-3 两向派生：装饰形态进 MCP 支、且绝不落内置工具族判据', () => {
    const decorated = 'jetski: no output produced — a tool required the "mcp(novel-writing/*)" permission that headless mode cannot prompt for, so it was auto-denied.';
    expect(parsePermissionSoftDenyStderrSubject(decorated)).toBe('mcp');
    expect(hasMcpPermissionSoftDeny(decorated)).toBe(true);
    // 混合 haystack：MCP 优先 ⇒ driver 的两条 412 行互斥落 MCP 行（不烧链、出路指向预授权）。
    const mixed = 'permission check failed for read_file "C:/tmp/x": denied\njetski: a tool required the "mcp" permission that headless mode cannot prompt for';
    expect(hasMcpPermissionSoftDeny(mixed)).toBe(true);
  });

  it('isMcpPermissionSubject：仅字面 mcp 为真（大小写 / 近似名不误判）', () => {
    expect(isMcpPermissionSubject('mcp')).toBe(true);
    expect(isMcpPermissionSubject('MCP')).toBe(false);
    expect(isMcpPermissionSubject('read_file')).toBe(false);
    expect(isMcpPermissionSubject('mcp(extra)')).toBe(false);
  });

  it('hasMcpPermissionSoftDeny（driver 第二条合成 412 行的判据）：仅 mcp 主体为真', () => {
    expect(hasMcpPermissionSoftDeny('jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.')).toBe(true);
    expect(hasMcpPermissionSoftDeny('step 4: permission check failed for mcp "novel-writing/write_chapter": denied')).toBe(true);
    // 内置工具主体 / 无主体文本 → 假（两分支互补不重叠）。
    expect(hasMcpPermissionSoftDeny('the "read_file" permission that headless mode cannot prompt for')).toBe(false);
    expect(hasMcpPermissionSoftDeny('no output produced — auto-denied')).toBe(false);
    expect(hasMcpPermissionSoftDeny('some unrelated stderr chatter')).toBe(false);
  });
});
