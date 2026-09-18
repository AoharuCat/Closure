import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import type {
  AgyBridgeConsentState,
  AgyBridgeConsentValue,
  AgyBridgeRevokeResult,
  AgyBridgeStatusView,
} from '@orison/shared-contracts';

// ── agy MCP 工具桥 F3：预授权逻辑面（子4 W3，design §4）──
//
// β HOME 覆盖通道下的预授权 = **假宿副本内** settings.json 合并写（用户真实全局零写入
// ——无备份对象、无条目移除面）；同意流后端（状态机 + 自包含持久化 + 披露文案常量占位）
// 暴露数据供 W6 UI / IPC 波次消费。
//
// 本模块 = 纯逻辑（parse/merge/conflict/state machine）+ 小型同意存储；fs 读写集中在
// 显式路径参数（默认真实路径，测试传 temp 根）。settings 路径 = 研究定谳的
// `<home>/.gemini/antigravity-cli/settings.json`（未随 config/ 迁移）。
//
// ⚠️ 同意持久化落点（CR-29，09-12 子4 CR 批）：原计划挂用户偏好 schema（configIpc）。
// configIpc/偏好 schema 面被并行 task（子3 参数面）占用冻结——先落自包含状态文件
// `~/.orison/agy-bridge/consent.json`（机器级、用户作用域，与假宿同树）；store 接口
// 保持 filePath 注入形态，**迁移 = 待 configIpc 收口后一行切换**（createAgyBridgeConsentStore
// 的 file 取值换成偏好文件读写闭包，调用方零改）。

/** 同意值（IPC 契约单源 shared-contracts AgyBridgeConsentValue；本侧历史名保留再导出）。 */
export type AgyBridgeConsent = AgyBridgeConsentValue;
export type { AgyBridgeConsentState, AgyBridgeStatusView, AgyBridgeRevokeResult };

export interface AgySettingsParseOk {
  ok: true;
  value: Record<string, unknown>;
}
export interface AgySettingsParseEmpty {
  ok: false;
  kind: 'empty';
}
export interface AgySettingsParseCorrupt {
  ok: false;
  kind: 'corrupt';
  message: string;
}
export type AgySettingsParseResult = AgySettingsParseOk | AgySettingsParseEmpty | AgySettingsParseCorrupt;

/**
 * 用户真实 settings 文本解析（容错读）：缺失/0 字节/纯空白 → empty（副本基 `{}`）；
 * JSON 解析失败/顶层非对象 → corrupt（**类型化阻断——副本将携带同款坏文件，agy 加载面
 * 不可赌，绝不覆写**，mirror schema 收紧防静默数据丢失纪律）。
 */
export function parseAgySettings(text: string | undefined | null): AgySettingsParseResult {
  if (text === undefined || text === null || text.trim().length === 0) {
    return { ok: false, kind: 'empty' };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, kind: 'corrupt', message: 'settings 顶层不是 JSON 对象' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    return { ok: false, kind: 'corrupt', message: err instanceof Error ? err.message : String(err) };
  }
}

/** 预授权精确条目（括号形态 `mcp(server/*)`——W0 §10 实测有效）。 */
export function bridgePreauthRule(serverName: string): string {
  return `mcp(${serverName}/*)`;
}

/**
 * settings 副本合并写（纯函数）：`permissions.allow` 追加精确条目——保序（JS 对象插入序，
 * 既有键序原样、新键追加）；幂等（已含精确条目 → 原对象 verbatim 返回，不重写）。
 * allow 表中的非字符串垃圾项在**副本**内丢弃（真实文件从未被写）。
 */
export function mergeAgySettingsWithPreauth(
  settings: Record<string, unknown>,
  serverName: string,
): Record<string, unknown> {
  const rule = bridgePreauthRule(serverName);
  const permissionsRaw = settings.permissions;
  const permissions = permissionsRaw !== null && typeof permissionsRaw === 'object' && !Array.isArray(permissionsRaw)
    ? (permissionsRaw as Record<string, unknown>)
    : {};
  const allowRaw = permissions.allow;
  const allow = Array.isArray(allowRaw) ? allowRaw.filter((x): x is string => typeof x === 'string') : [];
  if (allow.includes(rule)) return settings; // 幂等：verbatim（用户已自配过精确条目）
  return {
    ...settings,
    permissions: {
      ...permissions,
      allow: [...allow, rule],
    },
  };
}

/**
 * 三表冲突检测（design §4.2，只读预检）：读用户真实 deny/ask 表——任何含 serverName
 * 的规则（精确 `mcp(server/*)`、逐工具 `mcp(server/<tool>)`、宽松近似）或全 MCP 压制
 * `mcp(*)` → 列为冲突（**宁误报不漏报**：deny/ask 是用户安全边界，预检 fail-fast 与
 * 运行时压制语义一致）。allow 表不参与（追加的条目就在 allow）。
 */
export function detectPreauthConflicts(settings: Record<string, unknown>, serverName: string): string[] {
  const conflicts = new Set<string>();
  const permissionsRaw = settings.permissions;
  const permissions = permissionsRaw !== null && typeof permissionsRaw === 'object' && !Array.isArray(permissionsRaw)
    ? (permissionsRaw as Record<string, unknown>)
    : {};
  for (const table of ['deny', 'ask'] as const) {
    const raw = permissions[table];
    if (!Array.isArray(raw)) continue;
    for (const rule of raw) {
      if (typeof rule !== 'string') continue;
      if (rule.includes(serverName) || rule === 'mcp(*)') conflicts.add(rule);
    }
  }
  return [...conflicts];
}

/**
 * 运行前状态机：declined（显式拒绝压一切）→ conflict（deny/ask 压制）→ missing-consent
 * （未同意）→ ok。settings 缺席（agy 从未配置）视同无冲突表。
 */
export function resolveAgyBridgeConsentState(input: {
  consent: AgyBridgeConsent | undefined;
  settings: Record<string, unknown> | undefined;
  serverName: string;
}): AgyBridgeConsentState {
  if (input.consent === 'declined') return 'declined';
  const conflicts = input.settings !== undefined ? detectPreauthConflicts(input.settings, input.serverName) : [];
  if (conflicts.length > 0) return 'conflict';
  if (input.consent !== 'allowed') return 'missing-consent';
  return 'ok';
}

// ── 真实 settings 只读 ──

/** 用户真实 settings.json 路径（研究定谳：antigravity-cli 子树，未随 config/ 迁移）。 */
export function agySettingsPath(realHome: string): string {
  return path.join(realHome, '.gemini', 'antigravity-cli', 'settings.json');
}

export function readAgySettingsFromDisk(realHome: string): AgySettingsParseResult & { path?: string } {
  const file = agySettingsPath(realHome);
  if (!existsSync(file)) return { ok: false, kind: 'empty' };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, kind: 'corrupt', message: err instanceof Error ? err.message : String(err), path: file };
  }
  const parsed = parseAgySettings(text);
  return parsed.ok ? parsed : { ...parsed, path: file };
}

// ── 同意存储（自包含状态文件；后续波次可迁偏好 schema——接口不变）──

export interface AgyBridgeConsentFile {
  version: 1;
  consent?: AgyBridgeConsent;
  updatedAt?: string;
}

export interface AgyBridgeConsentStore {
  read(): AgyBridgeConsent | undefined;
  /** 设置同意（allowed/declined——拒绝也记住，AC6）。 */
  set(consent: AgyBridgeConsent): void;
  /** 关闭回收 = 状态翻转回未配置（真实全局零写入——无条目移除面）。 */
  clear(): void;
  filePath(): string;
}

export function defaultAgyBridgeConsentFilePath(home: string = os.homedir()): string {
  return path.join(home, '.orison', 'agy-bridge', 'consent.json');
}

export function createAgyBridgeConsentStore(opts: {
  filePath?: string;
  now?: () => Date;
} = {}): AgyBridgeConsentStore {
  const file = opts.filePath ?? defaultAgyBridgeConsentFilePath();
  const now = opts.now ?? (() => new Date());
  const write = (next: AgyBridgeConsentFile): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  };
  return {
    read() {
      if (!existsSync(file)) return undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed === null || typeof parsed !== 'object') return undefined;
        const consent = (parsed as { consent?: unknown }).consent;
        return consent === 'allowed' || consent === 'declined' ? consent : undefined;
      } catch {
        return undefined; // 容错读：坏状态文件视同未配置（重新征询），不阻断
      }
    },
    set(consent) {
      write({ version: 1, consent, updatedAt: now().toISOString() });
    },
    clear() {
      write({ version: 1 });
    },
    filePath: () => file,
  };
}

// ── 关闭回收（§4.4：状态翻转 + 活动会话提示；无条目移除面）──
// （AgyBridgeRevokeResult 形态单源 = shared-contracts IPC 契约，文件头 re-export。）

export function revokeAgyBridgeConsent(input: {
  store: AgyBridgeConsentStore;
  activeSessionIds: () => string[];
}): AgyBridgeRevokeResult {
  const active = input.activeSessionIds();
  if (active.length > 0) {
    return { ok: false, error: 'active-sessions', activeSessions: active };
  }
  input.store.clear();
  return { ok: true };
}

// ── 状态面（W6 UI / IPC 波次消费的数据形状；形态单源 = shared-contracts IPC 契约）──

export function readAgyBridgeStatusView(input: {
  consent: AgyBridgeConsent | undefined;
  settings: Record<string, unknown> | undefined;
  serverName: string;
  homeRoot: string;
  consentFilePath: string;
}): AgyBridgeStatusView {
  return {
    state: resolveAgyBridgeConsentState({
      consent: input.consent,
      settings: input.settings,
      serverName: input.serverName,
    }),
    conflicts: input.settings !== undefined ? detectPreauthConflicts(input.settings, input.serverName) : [],
    consent: input.consent,
    homeRoot: input.homeRoot,
    consentFilePath: input.consentFilePath,
  };
}

// ── 知情同意披露文案（占位——终案文案常量归子5 统一，此处先以中文基线供 W6 接线）──

/**
 * 披露「约 17MB」的尺度来源（CR-18，子4 CR 批）：W0 装机实测快照（2026-09-12，
 * agy 1.2.2 的 `~/.gemini` 体积）——探测常量单源（UI 侧 AgyBridgeConsentDialog 的
 * AGY_GEMINI_COPY_SIZE_HINT_MB 同注同源），agy 升级后体积漂移须两处同步校准，不在
 * 文案里手抄数字。
 */
export const AGY_GEMINI_COPY_SIZE_HINT_MB = 17;

export const AGY_BRIDGE_CONSENT_DISCLOSURE = {
  /** 拷贝什么。 */
  copies: `将整体复制你的 agy 配置目录（约 ${AGY_GEMINI_COPY_SIZE_HINT_MB}MB，其中包含已缓存的登录凭据副本）。`,
  /** 放哪里。 */
  where: '副本存放在本机用户目录下的 Closure 数据目录（agy-bridge/home/会话），访问权限与原目录同级。',
  /** 生命周期。 */
  lifecycle: '每次会话结束即删除副本；应用启动时自动清扫异常退出残留的副本。',
  /** 全局零写入。 */
  noGlobalWrite: '你的真实 agy 配置与凭据库全程不被改动（零写入）。',
  /** ToS 风险备注（占位——终案归子5）。 */
  tosNote: '（占位：凭据副本涉及服务条款风险的说明一行——终案文案归子5 统一。）',
} as const;
