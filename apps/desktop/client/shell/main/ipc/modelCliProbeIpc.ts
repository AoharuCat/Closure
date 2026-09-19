import { execFile, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { ipcMain } from 'electron';
import type { CliProbeSnapshot, ModelConfig } from '@orison/shared-contracts';
import { isAuthError } from '@orison/model-protocols';
import { getLogger } from '../logger';
import { readModelConfigFromDisk } from './configIpc';
import { notifyUI, type ToolEvent } from './toolNotify';

// ── CLI 型 provider 凭据探针（09-19 dogfood R4）──
//
// 背景：用户经第三方工具切换 agy 账号后，本机凭据可能整体失效（refresh_token 被
// 转移），而 `agy models` 不验登录（未登录也能列模型）——模型发现面探不出凭据死活。
// 本模块对每个已配置的 antigravity-cli key 跑一次微型真生成（`<executable> -p "hi"`，
// 几十 token，成本知情可接受），开机自动探 + 设置页手动重测，结果存本进程内存
//（per keyId，含时间戳——刻意不落盘，重启即视为「未探测」）。
//
// 三态分类：
//   - `ok`：exit 0 且 stdout 非空且 stderr/err 无认证信号
//   - `auth-dead`：stderr/err.message 命中认证信号词表——**复用 model-protocols
//    isAuthError 单源**（driver 错误分类与 `agy models` 发现路径同一词表，两处判定
//    不得各自漂移）；stdout 不进词表（模型正文提「401」不是死票）
//   - `error`：其他（超时/崩溃/空输出），detail 带原始摘要（设置页 tooltip 面）
//
// 通知面：状态**转变**为 auth-dead 时（上一态 ok/error/未探测）推一次 renderer
// 通知（tool:event 既有通道，cli:auth-dead 事件，keys 载数组）——防骚扰的「只弹
// 转变」判定在 shell 单点做（启动自动探与手动重测同源），renderer 只管弹不二次去重；
// 启动自动扫的多 key 死票在扫完时合并成单条事件（keys 多元素），renderer 单 toast 列
// 全部 key 名不堆叠。

/** 单次探针的子进程总时限（微型生成的宽上限；`agy models` 发现同款 30s）。 */
const PROBE_TIMEOUT_MS = 30_000;
/** error 快照 detail 的原始摘要上限（renderer tooltip 面，非日志面）。 */
const DETAIL_EXCERPT_LIMIT = 500;
/** 探针 prompt：裸 "hi"——只验非空输出，不做更复杂的指令（指令越多 token 越多）。 */
const PROBE_ARGS = ['-p', 'hi'];

type ExecFileFn = typeof execFile;

/**
 * DI seam（testing-discipline：单测注入 fake execFile / 受控时钟 / 假通知面，
 * 零真进程零真环境）。`runCliProbeForKey` 等入口接受 Partial——缺省项取本进程真实值。
 */
export interface ModelCliProbeDeps {
  execFile: ExecFileFn;
  /** 探针子进程的工作目录（os.tmpdir()——agy 会话临时文件不落在用户目录）。 */
  tmpDir: string;
  now: () => Date;
  /** 读盘上模型配置（解析 keyId → cliExecutable）；缺省走 configIpc 单源读取。 */
  readConfig: () => Pick<ModelConfig, 'keys'>;
  /** renderer 通知面（缺省 tool:event 广播）；测试注入 spy 断言转变推送。 */
  notify: (event: ToolEvent) => void;
}

function defaultProbeDeps(): ModelCliProbeDeps {
  return {
    execFile,
    tmpDir: os.tmpdir(),
    now: () => new Date(),
    readConfig: readModelConfigFromDisk,
    notify: notifyUI,
  };
}

interface ExecOutcome {
  err: (Error & { code?: unknown; killed?: boolean }) | null;
  stdout: string;
  stderr: string;
}

export type CliProbeClassification =
  | { status: 'ok' }
  | { status: 'auth-dead' }
  | { status: 'error'; detail: string };

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_EXCERPT_LIMIT ? trimmed.slice(0, DETAIL_EXCERPT_LIMIT) : trimmed;
}

/**
 * 探针结果三态分类（纯函数，导出供单测）。词表判定先于 exit 码——exit 0 但 **stderr**
 * 带认证信号仍是 auth-dead；认证信号只采 stderr + err.message，**stdout 不进词表**
 * （stdout 是模型正文，回复里出现「401」字样的解释性内容不是死票，喂进词表会把好
 * 凭据误判死）——stdout 只用于非空判定（exit 0 且有正文 = 生成成立）。exit 0 且
 * stdout 空白 = error（无生成即无凭据证据，不当成功——mirror 发现面「零行不当成功」
 * 纪律）。超时（execFile killed）归 error，detail 注明时限。
 */
export function classifyCliProbeOutcome(
  err: (Error & { code?: unknown; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
): CliProbeClassification {
  if (isAuthError(`${err?.message ?? ''}\n${stderr}`)) return { status: 'auth-dead' };
  if (err === null) {
    if (!stdout.trim()) {
      return { status: 'error', detail: 'agy exited 0 with empty output — nothing proves the credentials work' };
    }
    return { status: 'ok' };
  }
  const reason = err.killed === true
    ? `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`
    : (err.message || `probe exited with code ${String(err.code)}`);
  const tail = stderr.trim() || stdout.trim();
  return { status: 'error', detail: excerpt(tail ? `${reason}\n${tail}` : reason) };
}

/** 探针结果内存态（per keyId）。进程内共享——启动自动探与手动重测读写同一份。 */
const probeStore = new Map<string, CliProbeSnapshot>();

/** 在途探针（per keyId）——同 key 并发触发（手动点按钮撞上启动扫）共享同一次生成。 */
const inflight = new Map<string, Promise<CliProbeSnapshot>>();

/** 测试缝：清空内存结果与在途表（module-level state 不得跨测试泄漏）。 */
export function _resetModelCliProbeStoreForTest(): void {
  probeStore.clear();
  inflight.clear();
}

/**
 * 把新快照写进内存并做转变判定：仅在「上一态非 auth-dead → 新态 auth-dead」时推一次
 * renderer 通知（未探测 = 无上一态，同样算转变）。连续 auth-dead（重测两次都红、
 * 连续启动探都红——以内存上次结果为准）不重复推。事件 keys 恒单元素数组；启动扫的
 * 多 key 合并在扫层面做（见 probeConfiguredCliKeysOnStartup）。
 */
function applySnapshot(
  snapshot: CliProbeSnapshot,
  keyName: string | undefined,
  deps: ModelCliProbeDeps,
): void {
  const prev = probeStore.get(snapshot.keyId);
  probeStore.set(snapshot.keyId, snapshot);
  if (snapshot.status === 'auth-dead' && prev?.status !== 'auth-dead') {
    deps.notify({
      type: 'cli:auth-dead',
      keys: [{ keyId: snapshot.keyId, keyName: keyName ?? snapshot.keyId }],
    });
  }
}

/**
 * 超时路径的进程树补杀：execFile 的 timeout 只 SIGTERM 直系子进程——agy 会拉起
 * MCP server 等孙进程，直杀留孤儿树。树杀纪律（mirror antigravityCli/driver +
 * ci-smoke killTree）：杀前查已退（exitCode/signalCode 已落值就不再发信号——OS 可能
 * 已回收 pid，对复用 pid 树杀是误杀无关进程的高危面）；win 走 `taskkill /PID <pid>
 * /T /F`（异步 fire-and-forget，进程已死时报「找不到进程」是幂等杀的常态；真启动级
 * 失败在回调内回落 child.kill）；posix 未 detached 建组，回落 SIGKILL 直杀（孙进程由
 * stdio EOF 自退兜底）。仅超时路径调用（killed = Node 已收走直系进程，孙进程待清）。
 */
function killProbeProcessTree(deps: ModelCliProbeDeps, child: ChildProcess | undefined): void {
  if (child === undefined || child.pid == null) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    deps.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err === null || err === undefined) return;
      try {
        child.kill();
      } catch {
        // 已退出——零害
      }
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出——零害
  }
}

function execProbe(deps: ModelCliProbeDeps, executable: string): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    // 经 holder 传子进程：execFile 若同步回调（spawn 即败形态/测试 fake），此刻 child
    // 尚未赋值——闭包读到 undefined，树杀守卫自然跳过；真异步回调时必已赋值（const
    // 直挂会让同步回调踩 TDZ，let 直挂则踩 prefer-const——holder 两面都避开）。
    const proc: { child?: ChildProcess } = {};
    proc.child = deps.execFile(
      executable,
      PROBE_ARGS,
      { timeout: PROBE_TIMEOUT_MS, cwd: deps.tmpDir, windowsHide: true },
      (err, stdout, stderr) => {
        // 超时路径补树杀：killed = Node 已 SIGTERM 直系进程，孙进程树另行收尾。
        if (err?.killed === true) killProbeProcessTree(deps, proc.child);
        resolve({
          err: err as ExecOutcome['err'],
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

/**
 * 对一个已解析的 CLI key 跑一次探针（启动扫与手动重测的共同内核）。同 keyId 在途时
 * 返回既有 promise（不并发起第二次生成）。结果写内存 + 转变推送，永不 throw（模式 A
 * ——预期内失败落 error 快照）。
 */
async function probeResolvedCliKey(
  keyId: string,
  executable: string,
  keyName: string | undefined,
  deps: ModelCliProbeDeps,
): Promise<CliProbeSnapshot> {
  const pending = inflight.get(keyId);
  if (pending) return pending;
  const run = (async (): Promise<CliProbeSnapshot> => {
    const outcome = await execProbe(deps, executable);
    const classified = classifyCliProbeOutcome(outcome.err, outcome.stdout, outcome.stderr);
    const snapshot: CliProbeSnapshot = {
      keyId,
      status: classified.status,
      probedAt: deps.now().toISOString(),
      ...(classified.status === 'error' ? { detail: classified.detail } : {}),
    };
    getLogger().info(
      { keyId, executable, status: snapshot.status },
      'cli probe: credential probe finished',
    );
    applySnapshot(snapshot, keyName, deps);
    return snapshot;
  })();
  const tracked = run.finally(() => {
    inflight.delete(keyId);
  });
  inflight.set(keyId, tracked);
  return tracked;
}

/**
 * 手动重测入口（设置页「测试连接」按钮）：按 keyId 从盘上配置解析 CLI key 再探。
 * key 不存在 / 非 CLI 形态 / 缺 cliExecutable = error 快照（可诊断，不 throw）。
 */
export async function runCliProbeForKey(
  keyId: string,
  depsPartial: Partial<ModelCliProbeDeps> = {},
): Promise<CliProbeSnapshot> {
  const deps = { ...defaultProbeDeps(), ...depsPartial };
  // 读盘配置失败（盘被占用/手编坏文件等）也不向上抛——落该 key 的 error 快照（模式 A）。
  let keys: ModelConfig['keys'];
  try {
    keys = deps.readConfig().keys;
  } catch (error) {
    const snapshot: CliProbeSnapshot = {
      keyId,
      status: 'error',
      probedAt: deps.now().toISOString(),
      detail: `reading model config failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    applySnapshot(snapshot, undefined, deps);
    return snapshot;
  }
  const key = keys.find((k) => k.id === keyId);
  if (!key || key.protocol !== 'antigravity-cli' || !key.cliExecutable) {
    const snapshot: CliProbeSnapshot = {
      keyId,
      status: 'error',
      probedAt: deps.now().toISOString(),
      detail: `no configured antigravity-cli key with a cliExecutable for id '${keyId}'`,
    };
    applySnapshot(snapshot, key?.name, deps);
    return snapshot;
  }
  return probeResolvedCliKey(keyId, key.cliExecutable, key.name, deps);
}

/**
 * 启动自动探（main whenReady 调用，fire-and-forget）：存在任一 CLI key 才探；逐 key
 * 串行（不并发拉起多个 agy 进程）；探完 log 一行摘要。绝不 throw——调用方兜底 catch。
 *
 * 死票合并：扫期间的 per-key 转变通知先攒不推（逐 key 串行，两条死票可能隔一次完整
 * 探针的时长，renderer 侧窗口合并等不到）；扫完若确有死票，一次性推单条合并事件
 * （keys 多元素）——renderer 弹一条 toast 列全部 key 名，不堆叠。
 */
export async function probeConfiguredCliKeysOnStartup(
  depsPartial: Partial<ModelCliProbeDeps> = {},
): Promise<CliProbeSnapshot[]> {
  const deps = { ...defaultProbeDeps(), ...depsPartial };
  const cliKeys = deps
    .readConfig()
    .keys.filter((k) => k.protocol === 'antigravity-cli' && typeof k.id === 'string' && k.id);
  if (cliKeys.length === 0) return [];
  const deadDuringSweep: Array<{ keyId: string; keyName: string }> = [];
  const sweepDeps: ModelCliProbeDeps = {
    ...deps,
    notify: (event) => {
      if (event.type === 'cli:auth-dead') deadDuringSweep.push(...event.keys);
    },
  };
  const results: CliProbeSnapshot[] = [];
  for (const key of cliKeys) {
    if (!key.cliExecutable) {
      // 键缺判别载荷（盘上手编坏配置）：error 快照如实入库，不中断其余 key 的探测。
      const snapshot: CliProbeSnapshot = {
        keyId: key.id,
        status: 'error',
        probedAt: deps.now().toISOString(),
        detail: `key '${key.id}' has no cliExecutable on disk`,
      };
      applySnapshot(snapshot, key.name, sweepDeps);
      results.push(snapshot);
      continue;
    }
    try {
      results.push(await probeResolvedCliKey(key.id, key.cliExecutable, key.name, sweepDeps));
    } catch (error) {
      // 单 key 探测抛错（预期外路径）只 warn + error 快照入库，不中断其余 key 的探测。
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn({ keyId: key.id, err: message }, 'cli probe: per-key probe threw unexpectedly');
      const snapshot: CliProbeSnapshot = {
        keyId: key.id,
        status: 'error',
        probedAt: deps.now().toISOString(),
        detail: `probe threw unexpectedly: ${message}`,
      };
      applySnapshot(snapshot, key.name, sweepDeps);
      results.push(snapshot);
    }
  }
  if (deadDuringSweep.length > 0) {
    deps.notify({ type: 'cli:auth-dead', keys: deadDuringSweep });
  }
  getLogger().info(
    { results: results.map((r) => `${r.keyId}:${r.status}`) },
    'cli probe: startup sweep done',
  );
  return results;
}

/**
 * 读最近探针结果（IPC 面）：只回当前盘上配置仍存在的 key 的快照（已删 key 的残留
 * 内存条目不外泄）。无结果的 key 缺席——renderer 渲染「未探测」态。
 */
function latestProbeStatus(
  readConfig: ModelCliProbeDeps['readConfig'],
): Record<string, CliProbeSnapshot> {
  const live = new Set(readConfig().keys.map((k) => k.id));
  const out: Record<string, CliProbeSnapshot> = {};
  for (const [keyId, snapshot] of probeStore) {
    if (live.has(keyId)) out[keyId] = snapshot;
  }
  return out;
}

/**
 * 注册两通道（main/index.ts registerAllIpc 调用，mirror registerModelCliDiscoveryIpc）：
 *   - `model:cli-probe-status`：读最近结果（无结果 key 缺席 = 未探测态）。
 *   - `model:cli-probe-run`：触发重测（返回即时快照；载荷契约单源 shared-contracts）。
 */
export function registerModelCliProbeIpc() {
  ipcMain.handle(
    'model:cli-probe-status',
    (): Record<string, CliProbeSnapshot> => latestProbeStatus(readModelConfigFromDisk),
  );
  ipcMain.handle(
    'model:cli-probe-run',
    async (_event, input: { keyId?: unknown }): Promise<CliProbeSnapshot> => {
      // 模式 A：renderer 载荷病态（缺 keyId / 非字符串）落 error 快照，不 throw。
      const keyId = typeof input?.keyId === 'string' && input.keyId.trim()
        ? input.keyId.trim()
        : '';
      if (!keyId) {
        return {
          keyId: '',
          status: 'error',
          probedAt: new Date().toISOString(),
          detail: 'keyId must be a non-empty string',
        };
      }
      return runCliProbeForKey(keyId);
    },
  );
}
