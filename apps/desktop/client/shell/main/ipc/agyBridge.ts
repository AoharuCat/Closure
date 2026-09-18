import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import {
  defaultAgyPoolDeps,
  installAgyBridgeCore as installBridgeCoreIntoProtocols,
  type BridgePermissionMode,
  type BridgeSessionOpenInput,
  type BridgeToolFaceEntry,
} from '@orison/model-protocols';
import {
  AUTO_APPLY_SELF_REVIEW_MESSAGE,
  assertToolAllowed,
  enforceAutoApplyTier,
  shouldGateAutoApply,
} from '@orison/desktop-agent';
import { handleToolExecute } from './toolExecution';
import {
  createAgyBridgeConsentStore,
  mergeAgySettingsWithPreauth,
  parseAgySettings,
  type AgyBridgeConsentStore,
} from './agyBridgeConsent';
import { getLogger } from '../logger';

// ── agy MCP 工具桥基座（子4 W2，design §0/§3/§5.2/§6）──
//
// shell 主进程侧owns：
//   - 桥会话注册表 {sessionId → record(token/管道/权限档/工具面/AbortController/调用记录)}
//     （CR-7 idle 回收：无帧活动超 TTL 关管道 + 出表，长跑不无界累积；CR-6 同 sessionId
//     配置变更 revoke 重建）；
//   - 命名管道 server（每桥会话一条，行分隔 JSON-RPC + hello/token 握手——projectDir/
//     sessionId 永不上线，shell 侧由 token 解析，路径信任边界不外泄；管道名不含 token
//     ——CR-2，认证只经 hello 帧）；
//   - 工具调用路径 = §5.2 三道闸重建（**同一 agent toolPolicy 模块**——面外拒 /
//     autoApply 档位强制 / 自审闸拦截文案回工具结果）→ handleToolExecute（统一工具通道，
//     pathGuard/日志照常）→ 结果双投（管道回程 + 会话调用记录）；
//   - 假宿准备实现（四件套 + marker；真实 ~/.gemini 只读——**零写入红线**）；
//   - 启动清扫守卫（marker pid 判活矩阵）+ 可选版本探测（已验版本带外禁用）；
//   - installShellAgyBridgeCore：装配 model-protocols bridgeTurn 内核（防环注入，
//     mirror installAgentImagePartsCore；wiring 测试钉死漏装配）。
//
// 深导入 toolPolicy 说明（W4 已切换）：agent 包 index 本批起将三道闸函数上根导出——本文件
// 由 W2 的 `@orison/desktop-agent/runtime/toolPolicy` 深导入切换为根导入（语义零变化，
// W2 文件头预告的收口；shell vitest 的对应 alias 一并移除）。

const logger = getLogger();

/** 调用记录上限（会话调用记录供流事件富化与事后核验——防长会话无界增长）。 */
const MAX_CALL_RECORDS = 200;

// ── 假宿路径守卫（红线第一道：全部写操作必须落在假宿内）──

export class AgyBridgeHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgyBridgeHomeError';
  }
}

/** 假宿根：`<home>/.orison/agy-bridge/home`（用户拍板——不用系统 Temp：ACL 同级 + 不进清理软件视野）。 */
export function defaultAgyBridgeHomeRoot(home: string = os.homedir()): string {
  return path.join(home, '.orison', 'agy-bridge', 'home');
}

/**
 * 假宿路径断言：homeDir 必须严格位于 homeRoot 之内，且与真实用户目录/.gemini 零重叠
 * （含反向包含——realHome/.gemini 不得落在假宿树内）。违例 = 阻断（宁可响亮失败）。
 */
export function assertFakeHomePath(homeDir: string, homeRoot: string, realHome: string): void {
  const root = path.resolve(homeRoot);
  const home = path.resolve(homeDir);
  const rel = path.relative(root, home);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new AgyBridgeHomeError(`假宿目录必须位于 ${root} 之内（收到 ${homeDir}）`);
  }
  const real = path.resolve(realHome);
  const realGemini = path.join(real, '.gemini');
  const overlaps = (a: string, b: string): boolean => {
    const oneWay = (x: string, y: string): boolean => {
      const r = path.relative(x, y);
      return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
    };
    // 双向：任一目录含于另一方（假宿在真实目录树内 / 真实目录树在假宿内都算重叠）。
    return oneWay(a, b) || oneWay(b, a);
  };
  if (overlaps(home, real) || overlaps(home, realGemini)) {
    throw new AgyBridgeHomeError(`假宿目录不得与真实用户目录重叠（${home} vs ${realHome}）`);
  }
}

// ── 假宿四件套 + marker（design §2.3/§2.4）──

export interface PrepareBridgeHomeInput {
  homeDir: string;
  homeRoot: string;
  /** 真实用户 home（只读源——.gemini 整拷 + settings 读取；测试传 temp 根）。 */
  realHome: string;
  serverName: string;
  pipeName: string;
  token: string;
  tools: BridgeToolFaceEntry[];
  /** mcpServer.js 静态资产绝对路径（bundle: dist/agy-bridge/；测试显式传）。 */
  mcpServerPath: string;
  /** server 进程载体（生产 process.execPath + ELECTRON_RUN_AS_NODE）。 */
  execPath: string;
  /** marker 记录的 pid（本 Closure 进程——清扫守卫判活用）。 */
  pid: number;
  sessionId: string;
}

/**
 * 假宿准备（spawn 前一次性；bridgeTurn prepareHome 闭包的目标实现）：
 *   1. 真实 settings 容错读 + corrupt 预检（**先于一切拷贝**——半成品凭据副本不留盘）；
 *   2. marker 撞段预检：homeDir 已归属其他 sessionId → typed 阻断（CR-10——两 sessionId
 *      sanitize 到同段时绝不静默读错首会话配置，他人假宿不误删）；
 *   3. `.gemini` 整体拷贝（~17MB，含缓存登录凭据——知情拍板记录在 design §2.5）；
 *   4. `antigravity-cli/settings.json` = 用户真实 settings verbatim 副本 + permissions.allow
 *      追加精确预授权条目（用户真实 deny/ask 随副本保全——安全边界不被旁路）；
 *   5. `config/mcp_config.json` **全新写**（不合并用户既有——隔离原则：用户自有 server
 *      不进 Closure 驱动的会话）；
 *   6. `bridge/tools.json`（本桥会话工具面）；
 *   7. `marker.json` {pid, sessionId, createdAt}（清扫守卫判活）。
 * 步骤 3 起任何失败 → catch 内 best-effort 清理已拷内容再抛（凭据副本零滞留——启动
 * 清扫只是兜底）。真实 `~/.gemini` 全程只读（源拷贝 + settings 读）——红线：零写入。
 */
export async function prepareBridgeHome(input: PrepareBridgeHomeInput): Promise<void> {
  assertFakeHomePath(input.homeDir, input.homeRoot, input.realHome);
  const realGemini = path.join(input.realHome, '.gemini');
  if (!existsSync(realGemini)) {
    throw new AgyBridgeHomeError(
      `agy 配置目录不存在（${realGemini}）——请先安装并登录 agy CLI 再使用工具桥`,
    );
  }

  // 1. settings 容错读 + corrupt 预检（读失败/坏文件阻断，绝不覆写语义见 agyBridgeConsent；
  //    预检先于拷贝——corrupt 抛出时零字节已写假宿）。
  const realSettingsPath = path.join(realGemini, 'antigravity-cli', 'settings.json');
  let settingsText: string | undefined;
  try {
    settingsText = await fsp.readFile(realSettingsPath, 'utf8');
  } catch {
    settingsText = undefined; // 缺失 → 副本基 {}
  }
  const parsed = parseAgySettings(settingsText);
  if (!parsed.ok && parsed.kind === 'corrupt') {
    throw new AgyBridgeHomeError(
      `无法读取你的 agy 设置文件（${realSettingsPath}）：${parsed.message}——已阻断，不会覆写。请先修复该文件或删除后由 agy 重建。`,
    );
  }
  const settingsCopy = mergeAgySettingsWithPreauth(parsed.ok ? parsed.value : {}, input.serverName);

  // 2. marker 撞段预检（CR-10）：已归属其他会话 → typed 阻断（预检段零写入，也不删他
  //    人假宿）；坏/缺 marker 按残留——force 拷贝 + marker 重写覆盖。
  const markerPath = path.join(input.homeDir, 'marker.json');
  if (existsSync(markerPath)) {
    try {
      const existing: unknown = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
      const sid = (existing as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sid === 'string' && sid !== input.sessionId) {
        throw new AgyBridgeHomeError(
          `假宿目录 ${input.homeDir} 已归属另一会话（marker sessionId=${sid}，本次=${input.sessionId}）——sessionId 净化撞段，拒绝复用`,
        );
      }
    } catch (err) {
      if (err instanceof AgyBridgeHomeError) throw err;
      // 坏 marker → 按残留继续（下方 force 覆盖）。
    }
  }

  await fsp.mkdir(input.homeDir, { recursive: true });
  try {
    // 3. .gemini 整拷（force 覆盖重拷残留；dereference 仿造符号链接源）。
    await fsp.cp(realGemini, path.join(input.homeDir, '.gemini'), {
      recursive: true,
      force: true,
      dereference: true,
    });

    // 4. settings 副本。
    const settingsCopyPath = path.join(input.homeDir, '.gemini', 'antigravity-cli', 'settings.json');
    await fsp.mkdir(path.dirname(settingsCopyPath), { recursive: true });
    atomicWriteFileSync(settingsCopyPath, JSON.stringify(settingsCopy, null, 2), 'utf8');

    // 5. mcp_config 全新写（覆盖拷贝来的用户 global——隔离原则）。
    const toolsJsonPath = path.join(input.homeDir, 'bridge', 'tools.json');
    const mcpConfig = {
      mcpServers: {
        [input.serverName]: {
          command: input.execPath,
          args: [input.mcpServerPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            ORISON_BRIDGE_PIPE: input.pipeName,
            ORISON_BRIDGE_TOKEN: input.token,
            ORISON_BRIDGE_TOOLS_JSON: toolsJsonPath,
          },
        },
      },
    };
    const mcpConfigPath = path.join(input.homeDir, '.gemini', 'config', 'mcp_config.json');
    await fsp.mkdir(path.dirname(mcpConfigPath), { recursive: true });
    atomicWriteFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    // 6. tools.json。
    await fsp.mkdir(path.dirname(toolsJsonPath), { recursive: true });
    atomicWriteFileSync(toolsJsonPath, JSON.stringify(input.tools, null, 2), 'utf8');

    // 7. marker（清扫守卫判活：pid 死/无 marker → 删；活且非本进程 → 跳过）。
    atomicWriteFileSync(
      markerPath,
      JSON.stringify({ pid: input.pid, sessionId: input.sessionId, createdAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (err) {
    // CR-3：失败路径清理已拷内容（best-effort）——半成品凭据副本不留盘到下次启动清扫。
    await fsp.rm(input.homeDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── 启动清扫守卫（design §2.4：异常退出残留的凭据副本不长存）──

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限探测（仍活）；ESRCH 等 = 已死。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepBridgeHomesResult {
  removed: string[];
  skipped: Array<{ dir: string; reason: 'live-foreign-pid' }>;
}

/**
 * live-foreign-pid 的 age 兜底（CR-4）：死 pid 被无关进程回收时 marker 判活永真——
 * foreign 假宿 marker/目录 mtime 超过本 age 照删（凭据副本不可无限滞留）。
 */
export const BRIDGE_HOME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 扫 `<homeRoot>/*`（**红线：仅应用启动序列调用**——此时本进程桥会话注册表恒空，
 * ownPid 分支删除不会命中自家活动桥假宿；运行期误接线时 `activeSessionIds` 守卫是
 * 第二道防线）：
 *   - 无 marker / marker 坏 / pid 非数 → 残留 → 删；
 *   - pid 已死 → 删；pid == 本进程 → 删（除非 marker sessionId 仍在活跃集——CR-4 运行期
 *     防护，防误删自家活动桥假宿）；
 *   - pid 存活且非本进程（另一 Closure 实例的活动桥会话）→ 跳过；**age 兜底**：marker/
 *     目录 mtime 超过 `BRIDGE_HOME_MAX_AGE_MS`（默认 7 天）照删——pid 回收形态下判活
 *     永真，凭据副本不可无限滞留；
 *   - 杂散文件（非目录）→ 删。
 */
export async function sweepStaleBridgeHomes(opts: {
  homeRoot: string;
  ownPid?: number;
  isPidAlive?: (pid: number) => boolean;
  warn?: (message: string) => void;
  /** 本进程仍活跃的桥会话 id 集（运行期误调用时的自删防护；启动调用不传）。 */
  activeSessionIds?: ReadonlySet<string>;
}): Promise<SweepBridgeHomesResult> {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const ownPid = opts.ownPid ?? process.pid;
  const nowMs = Date.now();
  const removed: string[] = [];
  const skipped: SweepBridgeHomesResult['skipped'] = [];
  const removeDir = async (dir: string): Promise<void> => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(dir);
    opts.warn?.(`[agy-bridge] 清扫残留假宿副本：${dir}`);
  };
  let entries: string[];
  try {
    entries = await fsp.readdir(opts.homeRoot);
  } catch {
    return { removed, skipped }; // 根不存在 = 无残留
  }
  for (const name of entries) {
    const dir = path.join(opts.homeRoot, name);
    let stat;
    try {
      stat = await fsp.stat(dir);
    } catch {
      continue; // 竞态消失——按已清理
    }
    if (!stat.isDirectory()) {
      await fsp.rm(dir, { force: true }).catch(() => {});
      removed.push(dir);
      continue;
    }
    let markerPid: number | undefined;
    let markerSessionId: string | undefined;
    let markerMtimeMs = 0;
    try {
      const markerPath = path.join(dir, 'marker.json');
      markerMtimeMs = (await fsp.stat(markerPath)).mtimeMs;
      const marker: unknown = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
      const pid = (marker as { pid?: unknown } | null)?.pid;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) markerPid = pid;
      const sid = (marker as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sid === 'string') markerSessionId = sid;
    } catch {
      markerPid = undefined; // 无 marker / 坏 marker → 按残留
    }
    if (markerPid === undefined || !isPidAlive(markerPid)) {
      await removeDir(dir);
    } else if (markerPid === ownPid) {
      // CR-4 运行期防护：ownPid 命中且会话注册表仍活跃 → 本进程活动桥假宿，跳过
      //（启动调用时活跃集恒空 → 正常按残留删）。
      if (markerSessionId !== undefined && opts.activeSessionIds?.has(markerSessionId)) {
        skipped.push({ dir, reason: 'live-foreign-pid' });
      } else {
        await removeDir(dir);
      }
    } else {
      // live foreign pid：另一实例活动桥——跳过；age 兜底（CR-4）：marker/目录 mtime
      // 超 7 天照删（死 pid 被无关进程回收的判活永真形态）。
      const ageMs = nowMs - Math.max(stat.mtimeMs, markerMtimeMs);
      if (ageMs > BRIDGE_HOME_MAX_AGE_MS) {
        await removeDir(dir);
      } else {
        skipped.push({ dir, reason: 'live-foreign-pid' });
      }
    }
  }
  return { removed, skipped };
}

// ── 可选版本探测（design §2.6：上游 home 解析漂移防线——不在已验带 → 桥禁用）──

/** 已装机验带的 agy 版本主次（W0 实测 1.2.2；1.2.x 线内兼容）。 */
export const VERIFIED_AGY_MAJOR_MINOR = '1.2';

/** 版本串是否落在已验带（`agy version 1.2.2` / `1.2.3` 等均可；非 1.2.x → false）。 */
export function isVerifiedAgyVersionBand(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(version.trim());
  if (match === null) return false;
  return `${match[1]}.${match[2]}` === VERIFIED_AGY_MAJOR_MINOR;
}

/** 运行 `<executable> --version` 取版本串（runner 注入——测试零真进程）；失败 → undefined。 */
export async function probeAgyCliVersion(
  executable: string,
  run: (executable: string, args: string[]) => Promise<string> = (exe, args) =>
    new Promise<string>((resolve, reject) => {
      execFile(exe, args, { timeout: 10_000 }, (err, stdout) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve(stdout);
      });
    }),
): Promise<string | undefined> {
  try {
    const out = await run(executable, ['--version']);
    const match = /\d+\.\d+(\.\d+)?/.exec(out);
    return match !== null ? match[0] : undefined;
  } catch {
    return undefined;
  }
}

// ── 桥会话注册表 + 命名管道 server（design §3.3）──

export interface BridgeCallRecord {
  id: number;
  toolId: string;
  arguments?: unknown;
  ok: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  /** 三道闸拦截标记（未被拦截的执行无此键）。 */
  gate?: 'face' | 'policy' | 'self-review';
  at: number;
}

export interface BridgeSessionRecord {
  sessionId: string;
  projectDir: string;
  permissionMode: BridgePermissionMode;
  face: BridgeToolFaceEntry[];
  faceNames: ReadonlySet<string>;
  pipeName: string;
  token: string;
  abortController: AbortController;
  callRecords: BridgeCallRecord[];
  /**
   * per-turn 调用记录 live 监听（W4：管道 result 回来即回调——executor 即刻持久化
   * SessionMessage 对，长链工具中途 UI 可见结果卡；turn 生产包装在 finally 清除）。
   * CR-9（子4 CR 批）：并发桥 turn 同 sessionId 的 last-writer-wins 互踩防护——
   * callOwner 记当前持有 turn 的 owner token，finally 只清理自己那份（见
   * agyBridgeIpc createAgyBridgeTurnProduction）。
   */
  callListener?: (record: BridgeCallRecord) => void;
  /** live 监听的当前持有 turn（owner token——与 callListener 同批读写）。 */
  callOwner?: string;
  presentResult: { called: boolean; awaiting: boolean | undefined; summary?: string; at?: number };
  createdAt: number;
  /** 最近帧活动（hello/call/present_result）——idle 回收判据（CR-7）。 */
  lastActivityAt: number;
  /** 注册表内部：管道 server 句柄（revoke/dispose 时关闭）。 */
  pipeServer?: net.Server;
}

/** mcpServer → shell 管道帧（行分隔 JSON；projectDir/sessionId 不上线——token 解析）。 */
export type BridgePipeFrame =
  | { op: 'hello'; token: string }
  | { op: 'call'; id: number; toolId: string; arguments?: unknown }
  | { op: 'present_result'; awaiting: boolean; summary?: string };

/**
 * 管道名派生（CR-2 安全形态）：入参是**不含 token 的不透明随机 id**——Windows 管道
 * 命名空间本机可枚举，token 绝不进管道名（枚举者只能拿到不可认证的管道端点，认证只经
 * hello 帧 token 比对）；mcpServer 侧管道名经 env 整串透传、零自派生，两侧天然同步。
 */
export function bridgePipeName(pipeId: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orison-agy-bridge-${pipeId}`
    : path.join(os.tmpdir(), `orison-agy-bridge-${pipeId}.sock`);
}

/**
 * 单个工具调用的三道闸执行路径（§5.2——与 runLoop 派发段同一 toolPolicy 模块等价重建）：
 *   闸1 面外（会话注册面）拒 → MCP 错误结果；
 *   闸1b assertToolAllowed（会话权限档）拒 → 错误结果（文案原样回给模型，同 runLoop 语义）；
 *   闸2 enforceAutoApplyTier：非 auto 档 diff 家族 autoApply 强制 false（suggest 恒走
 *       patch 人审的产品承诺在桥下不破）；
 *   闸3 shouldGateAutoApply：首发未自审 → **不执行**，闸门提示文案作为工具结果返回
 *       （模型读结果重发即放行——载体从合成消息变工具结果文本，语义同源）；
 *   通过 → handleToolExecute（统一通道）。
 */
export async function executeBridgeToolCall(
  record: BridgeSessionRecord,
  toolId: string,
  args: unknown,
): Promise<{ ok: true; output: string; metadata?: Record<string, unknown>; gate?: 'self-review' } | { ok: false; error: string; gate?: 'face' | 'policy' }> {
  if (!record.faceNames.has(toolId)) {
    return { ok: false, error: `工具 ${toolId} 不在本次会话可用的工具面内`, gate: 'face' };
  }
  try {
    assertToolAllowed({ toolName: toolId, sessionMode: record.permissionMode });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), gate: 'policy' };
  }
  const params = (args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args
    : {}) as Record<string, unknown>;
  const enforced = enforceAutoApplyTier(toolId, params, record.permissionMode) as Record<string, unknown>;
  if (shouldGateAutoApply(toolId, enforced)) {
    return { ok: true, output: AUTO_APPLY_SELF_REVIEW_MESSAGE, metadata: { bridgeGate: 'self-review' }, gate: 'self-review' };
  }
  try {
    const result = await handleToolExecute({
      toolId,
      params: enforced,
      projectDir: record.projectDir,
      sessionId: record.sessionId,
      abort: record.abortController.signal,
    });
    return { ok: true, output: result.output, metadata: result.metadata };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AgyBridgeRegistry {
  /**
   * 幂等 per sessionId：**完全相同**输入（projectDir/权限档/工具面）直接复用管道/token；
   * 任一变更（CR-6）→ revoke 旧会话重建（关旧管道 + 新 token——绝不静默沿用旧权限档/面）。
   */
  openSession(input: BridgeSessionOpenInput): { pipeName: string; token: string };
  getSession(sessionId: string): BridgeSessionRecord | undefined;
  getByToken(token: string): BridgeSessionRecord | undefined;
  activeSessions(): BridgeSessionRecord[];
  /** 记录 present_result（mcpServer 桥原生通知——流事件为 belt，双源以先到为准）。 */
  recordPresentResult(sessionId: string, awaiting: boolean, summary?: string): void;
  revokeSession(sessionId: string): boolean;
  disposeAll(): void;
}

/** 桥会话 idle 回收阈值（CR-7：无任何帧活动即关管道 + 出表；默认 30min）。 */
export const BRIDGE_SESSION_IDLE_TTL_MS = 30 * 60_000;
/** 桥会话 idle 清扫间隔（默认 60s）。 */
export const BRIDGE_SESSION_SWEEP_INTERVAL_MS = 60_000;

export interface AgyBridgeRegistryOptions {
  warn?: (message: string) => void;
  /** idle 回收 TTL / 清扫间隔（测试注入）。 */
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  /** 测试缝：替身执行路径（缺省真三道闸 executeBridgeToolCall——CR-8 reject 路径注入用）。 */
  executeCall?: typeof executeBridgeToolCall;
}

export function createAgyBridgeRegistry(opts: AgyBridgeRegistryOptions = {}): AgyBridgeRegistry {
  const warn = opts.warn ?? ((message: string) => logger.warn({ component: 'agy-bridge' }, message));
  const now = opts.now ?? ((): number => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return { clear: (): void => clearTimeout(t) };
  });
  const idleTtlMs = opts.idleTtlMs ?? BRIDGE_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = opts.sweepIntervalMs ?? BRIDGE_SESSION_SWEEP_INTERVAL_MS;
  const executeCall = opts.executeCall ?? executeBridgeToolCall;
  const bySessionId = new Map<string, BridgeSessionRecord>();
  const byToken = new Map<string, BridgeSessionRecord>();
  let callSeq = 0;
  let sweeper: { clear(): void } | undefined;

  const touchActivity = (record: BridgeSessionRecord): void => {
    record.lastActivityAt = now();
  };

  const startPipeServer = (record: BridgeSessionRecord): net.Server => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let greeted = false;
      const send = (frame: Record<string, unknown>): void => {
        socket.write(`${JSON.stringify(frame)}\n`);
      };
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let frame: BridgePipeFrame;
          try {
            frame = JSON.parse(line) as BridgePipeFrame;
          } catch {
            warn(`[agy-bridge] 坏管道帧忽略（session=${record.sessionId}）`);
            continue;
          }
          if (frame === null || typeof frame !== 'object' || typeof (frame as { op?: unknown }).op !== 'string') continue;
          if ((frame as { op: string }).op === 'hello') {
            if ((frame as { token?: unknown }).token !== record.token) {
              send({ op: 'welcome', ok: false, error: 'token mismatch' });
              socket.destroy();
              return;
            }
            touchActivity(record);
            greeted = true;
            send({ op: 'welcome', ok: true });
            return;
          }
          if (!greeted) {
            // 握手前的任何业务帧 = 未鉴权——拒绝并断连（token 不外泄路径）。
            socket.destroy();
            return;
          }
          if ((frame as { op: string }).op === 'present_result') {
            const f = frame as Extract<BridgePipeFrame, { op: 'present_result' }>;
            touchActivity(record);
            registry.recordPresentResult(record.sessionId, f.awaiting === true, typeof f.summary === 'string' ? f.summary : undefined);
            return; // 通知帧无回执（流事件 belt + 记录即达）
          }
          if ((frame as { op: string }).op === 'call') {
            const f = frame as Extract<BridgePipeFrame, { op: 'call' }>;
            const id = f.id;
            touchActivity(record);
            void executeCall(record, f.toolId, f.arguments).then((result) => {
              const rec: BridgeCallRecord = {
                id: ++callSeq,
                toolId: f.toolId,
                ...(f.arguments !== undefined ? { arguments: f.arguments } : {}),
                ok: result.ok,
                ...(result.ok ? { output: result.output } : { error: result.error }),
                ...(result.ok && result.metadata !== undefined ? { metadata: result.metadata } : {}),
                ...('gate' in result && result.gate !== undefined ? { gate: result.gate } : {}),
                at: Date.now(),
              };
              record.callRecords.push(rec);
              if (record.callRecords.length > MAX_CALL_RECORDS) {
                record.callRecords.splice(0, record.callRecords.length - MAX_CALL_RECORDS);
              }
              // W4 live 持久化钩子：管道 result 回来即通知 turn 生产包装（finally 清除）。
              record.callListener?.(rec);
              if (result.ok) {
                send({ op: 'result', id, ok: true, output: result.output, ...(result.metadata !== undefined ? { metadata: result.metadata } : {}) });
              } else {
                send({ op: 'result', id, ok: false, error: result.error });
              }
            }).catch((err: unknown) => {
              // CR-8：执行路径 reject 不得成未处理拒绝——回错误 result 帧（agy 工具调用
              // 不挂到管道关闭）+ 观测 warn。
              const detail = err instanceof Error ? err.message : String(err);
              warn(`[agy-bridge] 工具调用执行路径异常（session=${record.sessionId}, tool=${f.toolId}）：${detail}`);
              send({ op: 'result', id, ok: false, error: detail });
            });
            return;
          }
          // 未知 op：忽略（前瞻容忍——mcpServer 资产与 shell 版本错位不炸会话）。
          warn(`[agy-bridge] 未知管道 op 忽略（op=${(frame as { op: string }).op}）`);
        }
      });
      socket.on('error', () => {
        /* 断连由 mcpServer EOF 自退语义覆盖；此处吞 socket 错误防 uncaught */
      });
    });
    server.on('error', (err) => {
      warn(`[agy-bridge] 管道 server 错误（session=${record.sessionId}）：${err.message}`);
    });
    server.listen(record.pipeName);
    return server;
  };

  const closeRecord = (record: BridgeSessionRecord): void => {
    record.abortController.abort(new Error('agy bridge session revoked'));
    try {
      record.pipeServer?.close();
      // 在途 socket 强断（ typings 版本未含该方法——运行时 Node ≥18.2 恒有；可选调用）。
      (record.pipeServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* best-effort */
    }
  };

  // ── idle 回收（CR-7：注册表无生命周期即纯慢泄漏——长跑累积无界）──

  const sweepIdleSessions = (): void => {
    const nowMs = now();
    for (const record of [...bySessionId.values()]) {
      if (nowMs - record.lastActivityAt <= idleTtlMs) continue;
      warn(`[agy-bridge] 桥会话空闲超过 ${idleTtlMs}ms，回收（session=${record.sessionId}）`);
      registry.revokeSession(record.sessionId);
    }
  };

  const ensureSweeper = (): void => {
    if (sweeper !== undefined) return;
    const arm = (): void => {
      sweeper = setTimer(() => {
        sweeper = undefined;
        sweepIdleSessions();
        if (bySessionId.size > 0) arm(); // 无会话即停摆——下次 openSession 再武装
      }, sweepIntervalMs);
    };
    arm();
  };

  const registry: AgyBridgeRegistry = {
    openSession(input) {
      const existing = bySessionId.get(input.sessionId);
      if (existing !== undefined) {
        const configChanged = existing.projectDir !== input.projectDir
          || existing.permissionMode !== input.permissionMode
          || JSON.stringify(existing.face) !== JSON.stringify(input.face);
        if (!configChanged) {
          // 幂等：完全相同输入直接复用管道/token（同会话后续 turn）。
          touchActivity(existing);
          return { pipeName: existing.pipeName, token: existing.token };
        }
        // CR-6：同 sessionId 的权限档/工具面/项目目录变更 = 旧会话语义失效——revoke
        // 旧会话（关管道 + 吊销 token）后重建，绝不静默沿用旧态（用户中途收紧权限须生效）。
        warn(`[agy-bridge] 桥会话配置变更，重建会话（session=${input.sessionId}）`);
        bySessionId.delete(input.sessionId);
        byToken.delete(existing.token);
        closeRecord(existing);
      }
      // CR-2：管道名用独立随机 pipeId 派生（不含 token）；token 只经 hello 帧认证。
      const token = randomUUID();
      const pipeId = randomUUID();
      const record: BridgeSessionRecord = {
        sessionId: input.sessionId,
        projectDir: input.projectDir,
        permissionMode: input.permissionMode,
        face: input.face,
        faceNames: new Set(input.face.map((t) => t.name)),
        pipeName: bridgePipeName(pipeId),
        token,
        abortController: new AbortController(),
        callRecords: [],
        presentResult: { called: false, awaiting: undefined },
        createdAt: now(),
        lastActivityAt: now(),
      };
      record.pipeServer = startPipeServer(record);
      bySessionId.set(input.sessionId, record);
      byToken.set(token, record);
      ensureSweeper();
      return { pipeName: record.pipeName, token: record.token };
    },
    getSession: (sessionId) => bySessionId.get(sessionId),
    getByToken: (token) => byToken.get(token),
    activeSessions: () => [...bySessionId.values()],
    recordPresentResult(sessionId, awaiting, summary) {
      const record = bySessionId.get(sessionId);
      if (record === undefined) return;
      touchActivity(record);
      record.presentResult = {
        called: true,
        awaiting,
        ...(summary !== undefined ? { summary } : {}),
        at: Date.now(),
      };
    },
    revokeSession(sessionId) {
      const record = bySessionId.get(sessionId);
      if (record === undefined) return false;
      bySessionId.delete(sessionId);
      byToken.delete(record.token);
      closeRecord(record);
      return true;
    },
    disposeAll() {
      sweeper?.clear();
      sweeper = undefined;
      for (const record of [...bySessionId.values()]) {
        bySessionId.delete(record.sessionId);
        byToken.delete(record.token);
        closeRecord(record);
      }
    },
  };
  return registry;
}

// ── 装配（installShellAgyBridgeCore → model-protocols bridgeTurn 内核）──

/**
 * mcpServer.mjs 静态资产路径：bundle 形态 main chunk 在 dist/main → 资产在
 * dist/agy-bridge/（构建期拷贝，mirror lint rulesets 先例）；vitest（源码树）下解析
 * 到错误位置——测试必须显式注入 mcpServerPath。
 */
export function defaultMcpServerAssetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'agy-bridge', 'mcpServer.mjs');
}

export interface ShellAgyBridgeInstallOptions {
  homeRoot?: string;
  realHome?: string;
  mcpServerPath?: string;
  execPath?: string;
  registry?: AgyBridgeRegistry;
  warn?: (message: string) => void;
}

/**
 * 生产装配点（W4 波次在 agentIpc/main 启动序列调用；本函数纯装配无副作用外的全局态）：
 * 构造 AgyBridgeCore 注入 model-protocols bridgeTurn（installAgyBridgeCore），并返回
 * 注册表实例（调用方持有以 revoke/dispose）。
 */
export function installShellAgyBridgeCore(opts: ShellAgyBridgeInstallOptions = {}): AgyBridgeRegistry {
  const homeRoot = opts.homeRoot ?? defaultAgyBridgeHomeRoot();
  const realHome = opts.realHome ?? os.homedir();
  const mcpServerPath = opts.mcpServerPath ?? defaultMcpServerAssetPath();
  const registry = opts.registry ?? createAgyBridgeRegistry({ warn: opts.warn });
  installBridgeCoreIntoProtocols({
    homeRoot,
    poolDeps: defaultAgyPoolDeps(),
    writeHomePayload: (payload) =>
      prepareBridgeHome({
        homeDir: payload.homeDir,
        homeRoot,
        realHome,
        serverName: payload.serverName,
        pipeName: payload.pipeName,
        token: payload.token,
        tools: payload.tools,
        mcpServerPath,
        execPath: opts.execPath ?? process.execPath,
        pid: process.pid,
        sessionId: payload.sessionId,
      }),
    openBridgeSession: (input) => Promise.resolve(registry.openSession(input)),
    warn: opts.warn ?? ((message: string) => logger.warn({ component: 'agy-bridge' }, message)),
  });
  return registry;
}

// ── 生产运行时单例（main/index.ts whenReady 装配；agyBridgeIpc / agentIpc 注入消费）──
//
// registry 由 installShellAgyBridgeCore 产出的实例**显式登记**（install 本身不写单例——
// 测试直调 install 不污染生产面）；consent store 懒建（缺省真实路径 `~/.orison/agy-bridge/
// consent.json`，测试经 deps 注入显式 store 绕开）。

let productionRegistry: AgyBridgeRegistry | undefined;
let productionConsentStore: AgyBridgeConsentStore | undefined;

/** 生产装配登记（main/index.ts whenReady；测试传 undefined 复位）。 */
export function setProductionAgyBridgeRuntime(
  registry: AgyBridgeRegistry | undefined,
  store?: AgyBridgeConsentStore,
): void {
  productionRegistry = registry;
  if (store !== undefined) productionConsentStore = store;
}

/** 生产注册表（未装配 → undefined——调用方按未配置处理，不 throw）。 */
export function getProductionAgyBridgeRegistry(): AgyBridgeRegistry | undefined {
  return productionRegistry;
}

/** 生产同意存储（懒建；路径单源 defaultAgyBridgeConsentFilePath）。 */
export function getProductionAgyBridgeConsentStore(): AgyBridgeConsentStore {
  if (productionConsentStore === undefined) {
    productionConsentStore = createAgyBridgeConsentStore();
  }
  return productionConsentStore;
}
