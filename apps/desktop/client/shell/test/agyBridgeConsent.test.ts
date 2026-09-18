import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGY_BRIDGE_CONSENT_DISCLOSURE,
  AGY_GEMINI_COPY_SIZE_HINT_MB,
  agySettingsPath,
  bridgePreauthRule,
  createAgyBridgeConsentStore,
  defaultAgyBridgeConsentFilePath,
  detectPreauthConflicts,
  mergeAgySettingsWithPreauth,
  parseAgySettings,
  readAgySettingsFromDisk,
  readAgyBridgeStatusView,
  resolveAgyBridgeConsentState,
  revokeAgyBridgeConsent,
} from '../main/ipc/agyBridgeConsent';

// ── 子4 W3：预授权逻辑面（副本合并写 / 三表冲突 / 状态机 / 同意存储 / 回收）──

const SERVER = 'novel-writing';
const RULE = 'mcp(novel-writing/*)';

const TMP_ROOTS: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_ROOTS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_ROOTS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('agyBridgeConsent：settings 解析（容错读）', () => {
  it('缺失/空白 → empty（副本基 {}）；坏 JSON / 顶层非对象 → corrupt（阻断不覆写）', () => {
    expect(parseAgySettings(undefined)).toEqual({ ok: false, kind: 'empty' });
    expect(parseAgySettings('')).toEqual({ ok: false, kind: 'empty' });
    expect(parseAgySettings('   \n ')).toEqual({ ok: false, kind: 'empty' });
    const corrupt = parseAgySettings('{ not json');
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.kind).toBe('corrupt');
    expect(parseAgySettings('[1,2]').ok).toBe(false);
    expect(parseAgySettings('null').ok).toBe(false);
    expect(parseAgySettings('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('readAgySettingsFromDisk：缺席 → empty；在盘 → 解析值；路径 = antigravity-cli 子树（研究定谳）', () => {
    const home = tempDir('agy-consent-home-');
    expect(readAgySettingsFromDisk(home)).toEqual({ ok: false, kind: 'empty' });
    expect(agySettingsPath(home)).toBe(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'));
    mkdirSync(path.dirname(agySettingsPath(home)), { recursive: true });
    writeFileSync(agySettingsPath(home), JSON.stringify({ permissions: { allow: ['read_file(*)'] } }), 'utf8');
    const read = readAgySettingsFromDisk(home);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.permissions).toEqual({ allow: ['read_file(*)'] });
  });
});

describe('agyBridgeConsent：副本合并写（保序 + 幂等）', () => {
  it('permissions 缺席 → 建 {allow:[rule]}；既有键序原样、allow 追加尾部', () => {
    const merged = mergeAgySettingsWithPreauth({ theme: 'dark', permissions: { deny: ['run_command(*)'], allow: ['read_file(*)'] } }, SERVER);
    expect(merged).toEqual({
      theme: 'dark',
      permissions: { deny: ['run_command(*)'], allow: ['read_file(*)', RULE] },
    });
    // 键序保持：theme 仍在 permissions 前（JS 插入序——展开原对象）。
    expect(Object.keys(merged)).toEqual(['theme', 'permissions']);
    expect((merged.permissions as { allow: string[] }).allow.at(-1)).toBe(RULE);
  });

  it('幂等：已含精确条目 → 原对象 verbatim（引用相等，不重写）', () => {
    const settings = { permissions: { allow: [RULE, 'read_file(*)'] } };
    expect(mergeAgySettingsWithPreauth(settings, SERVER)).toBe(settings);
    expect(bridgePreauthRule(SERVER)).toBe(RULE);
  });

  it('garbage allow（非数组/非字符串项）在副本内归一，不抛', () => {
    const merged = mergeAgySettingsWithPreauth({ permissions: { allow: ['ok', 42, null] } }, SERVER);
    expect(merged.permissions).toEqual({ allow: ['ok', RULE] });
    const noPerms = mergeAgySettingsWithPreauth({}, SERVER);
    expect(noPerms.permissions).toEqual({ allow: [RULE] });
    const badPerms = mergeAgySettingsWithPreauth({ permissions: 'x' }, SERVER);
    expect(badPerms.permissions).toEqual({ allow: [RULE] });
  });
});

describe('agyBridgeConsent：三表冲突检测（宁误报不漏报）', () => {
  it('deny/ask 含 serverName 规则或 mcp(*) → 冲突；allow 表不参与', () => {
    const settings = {
      permissions: {
        allow: [RULE, 'read_file(*)'],
        deny: ['run_command(rm *)', 'mcp(*)'],
        ask: [`mcp(${SERVER}/*)`, `mcp(${SERVER}/write_chapter)`, `mcp(${SERVER}-backup/*)`],
      },
    };
    const conflicts = detectPreauthConflicts(settings, SERVER);
    expect(conflicts).toContain('mcp(*)');
    expect(conflicts).toContain(`mcp(${SERVER}/*)`);
    expect(conflicts).toContain(`mcp(${SERVER}/write_chapter)`);
    expect(conflicts).toContain(`mcp(${SERVER}-backup/*)`); // 前缀近似也列（宁误报）
    expect(conflicts).not.toContain('run_command(rm *)');
    // allow 表自身不参与：RULE 只在 allow 的 fixture → 零冲突。
    expect(detectPreauthConflicts({ permissions: { allow: [RULE] } }, SERVER)).toEqual([]);
    // 无冲突形态。
    expect(detectPreauthConflicts({ permissions: { deny: ['run_command(*)'], allow: [RULE] } }, SERVER)).toEqual([]);
    expect(detectPreauthConflicts({}, SERVER)).toEqual([]);
  });
});

describe('agyBridgeConsent：运行前状态机（declined > conflict > missing-consent > ok）', () => {
  it('四态优先序', () => {
    const conflictSettings = { permissions: { deny: [`mcp(${SERVER}/*)`] } };
    expect(resolveAgyBridgeConsentState({ consent: 'declined', settings: conflictSettings, serverName: SERVER })).toBe('declined');
    expect(resolveAgyBridgeConsentState({ consent: 'allowed', settings: conflictSettings, serverName: SERVER })).toBe('conflict');
    expect(resolveAgyBridgeConsentState({ consent: undefined, settings: {}, serverName: SERVER })).toBe('missing-consent');
    expect(resolveAgyBridgeConsentState({ consent: 'allowed', settings: undefined, serverName: SERVER })).toBe('ok');
  });
});

describe('agyBridgeConsent：同意存储（自包含状态文件）', () => {
  it('read/set/clear 落盘往返；坏文件容错读（视同未配置）；默认路径在 agy-bridge 树', () => {
    const dir = tempDir('agy-consent-store-');
    const file = path.join(dir, 'consent.json');
    const store = createAgyBridgeConsentStore({ filePath: file, now: () => new Date('2026-09-12T00:00:00Z') });
    expect(store.read()).toBeUndefined();
    store.set('allowed');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, consent: 'allowed', updatedAt: '2026-09-12T00:00:00.000Z' });
    expect(store.read()).toBe('allowed');
    store.clear();
    expect(store.read()).toBeUndefined(); // 翻转回未配置
    store.set('declined');
    expect(store.read()).toBe('declined');
    // 坏文件容错。
    writeFileSync(file, '{broken', 'utf8');
    expect(store.read()).toBeUndefined();
    expect(defaultAgyBridgeConsentFilePath('/home/u')).toBe(path.join('/home/u', '.orison', 'agy-bridge', 'consent.json'));
  });
});

describe('agyBridgeConsent：关闭回收（状态翻转 + 活动会话提示；无条目移除面）', () => {
  it('活动桥会话 → 阻断 active-sessions；无活动 → 翻转未配置', () => {
    const dir = tempDir('agy-consent-revoke-');
    const store = createAgyBridgeConsentStore({ filePath: path.join(dir, 'consent.json') });
    store.set('allowed');
    const blocked = revokeAgyBridgeConsent({ store, activeSessionIds: () => ['session-a'] });
    expect(blocked).toEqual({ ok: false, error: 'active-sessions', activeSessions: ['session-a'] });
    expect(store.read()).toBe('allowed'); // 未翻转
    const okResult = revokeAgyBridgeConsent({ store, activeSessionIds: () => [] });
    expect(okResult).toEqual({ ok: true });
    expect(store.read()).toBeUndefined();
  });
});

describe('agyBridgeConsent：状态面 + 披露文案', () => {
  it('readAgyBridgeStatusView 聚合（W6 UI 消费形状）', () => {
    const view = readAgyBridgeStatusView({
      consent: undefined,
      settings: { permissions: { ask: [`mcp(${SERVER}/*)`] } },
      serverName: SERVER,
      homeRoot: '/home/u/.orison/agy-bridge/home',
      consentFilePath: '/home/u/.orison/agy-bridge/consent.json',
    });
    expect(view.state).toBe('conflict');
    expect(view.conflicts).toEqual([`mcp(${SERVER}/*)`]);
    expect(view.homeRoot).toBe('/home/u/.orison/agy-bridge/home');
  });

  it('披露文案四件 + ToS 占位在位（终案归子5——占位不得静默丢失）', () => {
    // CR-18：MB 数走探测常量插值（不手抄字面量——常量单源注明来源）。
    expect(AGY_BRIDGE_CONSENT_DISCLOSURE.copies).toContain(`${AGY_GEMINI_COPY_SIZE_HINT_MB}MB`);
    expect(AGY_BRIDGE_CONSENT_DISCLOSURE.copies).toContain('登录凭据');
    expect(AGY_BRIDGE_CONSENT_DISCLOSURE.where.length).toBeGreaterThan(0);
    expect(AGY_BRIDGE_CONSENT_DISCLOSURE.lifecycle).toContain('清扫');
    expect(AGY_BRIDGE_CONSENT_DISCLOSURE.noGlobalWrite).toContain('零写入');
    expect(AGY_BRIDGE_CONSENT_DISCLOSURE.tosNote).toContain('占位');
  });
});
