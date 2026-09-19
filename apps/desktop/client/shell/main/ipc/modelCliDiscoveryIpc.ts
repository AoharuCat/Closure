import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import type {
  CliModelDiscoveryResult,
  ListCliModelsRequest,
  RemoteModel,
} from '@orison/shared-contracts';
import { resolveModelInfo } from '@orison/shared-contracts';
import { isAuthError } from '@orison/model-protocols';
import { getLogger } from '../logger';

// ── Antigravity CLI 模型发现（09-12 agy provider W4，design §4）──
//
// `model:list-cli-models`：spawn `<cliExecutable> models` 解析两列 TSV
// （`slug<TAB>显示名`——装机实测形态），产出与 HTTP 发现同形的 RemoteModel 列表。
// 收在本独立文件而非 modelProviderIpc——后者的发现走 HTTP listModels，CLI 形态的
// 子进程生命周期/错误分类是完全不同的机制（且避免与并行改动碰文件面）。
//
// 错误契约 = 模式 A 类型化结果（预期内用户可见失败不抛到 renderer）：
//   - 未登录（stderr 命中短语族）→ `not-logged-in`（UI 出「先在终端运行 agy 登录」引导）
//   - 可执行缺失（ENOENT）→ `executable-not-found`（UI 提示检查路径）
//   - 其余 → `discovery-failed` + stderr 摘要 detail
// 成功响应回带 `resolvedExecutable`（实际生效的可执行路径——空请求自动探测默认
// 候选时，UI 据此回填草稿：key schema 要求 cliExecutable 非空）。

/** 单次发现的子进程总时限（`agy models` 是即回命令，30s 足够含冷启动）。 */
const DISCOVERY_TIMEOUT_MS = 30_000;
/** 失败 detail 携带的 stderr 摘要上限（renderer 提示面，非日志面）。 */
const DETAIL_EXCERPT_LIMIT = 500;

type ExecFileFn = typeof execFile;

/**
 * DI seam（testing-discipline：单测注入 fake execFile + 受控 platform/env，零真进程
 * 零真环境）。`discoverCliModels` 接受 Partial——缺省项取本进程真实值。
 */
export interface ModelCliDiscoveryDeps {
  execFile: ExecFileFn;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

function defaultDiscoveryDeps(): ModelCliDiscoveryDeps {
  return { execFile, platform: process.platform, env: process.env };
}

interface ExecOutcome {
  err: (Error & { code?: unknown; killed?: boolean }) | null;
  stdout: string;
  stderr: string;
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_EXCERPT_LIMIT ? trimmed.slice(0, DETAIL_EXCERPT_LIMIT) : trimmed;
}

/**
 * 模型 id 合法字符白名单（CR-12，09-12 agy provider CR 批）：slug 族 = 字母数字 +
 * `. _ : + / -`。`agy models` 的横幅/提示行（含空格、中文、制表符以外的箱线字符等）
 * 不成假模型 id 被选中持久化——白名单外的首列整行跳过。
 */
const AGY_MODEL_ID_RE = /^[A-Za-z0-9._:+/-]+$/;

/**
 * `agy models` TSV 输出 → RemoteModel 列表。每行 `slug<TAB>显示名`；显示名缺席时
 * 回落 registry alias；capability 经 registry 推断（未知 slug 兜底 text——与 HTTP
 * 发现 listModels 同一映射源，盘上 healDerivedModelFields 读侧重算同源）。
 */
export function parseAgyModelsTsv(stdout: string): RemoteModel[] {
  const out: RemoteModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tabIdx = line.indexOf('\t');
    const id = (tabIdx >= 0 ? line.slice(0, tabIdx) : line).trim();
    // CR-12：噪声/横幅行（首列含白名单外字符——空格、提示文案等）不成假模型 id。
    if (!id || !AGY_MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const displayName = tabIdx >= 0 ? line.slice(tabIdx + 1).trim() : '';
    const info = resolveModelInfo(id);
    out.push({ id, capability: info.capability, alias: displayName || info.alias });
  }
  return out;
}

/**
 * 空请求时的默认可执行候选（探测序）：Windows 先试独立安装目录
 * `%LOCALAPPDATA%\agy\bin\agy.exe`（装机实证路径）再试 PATH 上的 `agy.exe`；macOS
 * 先枚举常见 bin 目录（多 OS R4：打包 app 经 Finder/launchpad 启动继承极简 PATH——
 * homebrew / 用户级安装目录不在其中，裸名探测必 ENOENT）再落 PATH 裸名兜底（终端
 * 开发场景）；Linux 同病同修（CR-8：GUI 菜单启动的桌面会话 PATH 同样极简，用户级
 * `~/.local/bin` 与系统级 `/usr/local/bin` 安装位不在其中）——先用户级安装惯例位、
 * 再系统级手动安装惯例位，最后 PATH 裸名兜底；其余平台直接 PATH 上的 `agy`。
 * 纯函数——platform/env 由调用方传入供单测。
 */
export function defaultAgyExecutableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      path.join(os.homedir(), '.local', 'bin', 'agy'),
      'agy',
    ];
  }
  if (platform === 'linux') {
    return [
      path.join(os.homedir(), '.local', 'bin', 'agy'),
      '/usr/local/bin/agy',
      'agy',
    ];
  }
  if (platform !== 'win32') return ['agy'];
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [path.join(localAppData, 'agy', 'bin', 'agy.exe'), 'agy.exe'];
}

function runModelsCommand(execFn: ExecFileFn, executable: string): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    execFn(
      executable,
      ['models'],
      { timeout: DISCOVERY_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
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
 * 发现主体（handler 内核，导出供测试直调）：
 * 显式路径 = 单候选（缺失即 `executable-not-found`）；空请求 = 按默认候选序探测。
 * 「目标不可执行」族错误（CR-11：ENOENT 不存在 / EACCES 无执行权限 / EISDIR 路径
 * 是目录）续试下一候选；其余失败（auth/超时/非零退出）即时分类返回——候选存在但
 * 未登录时换候选无意义（凭据是全局的）。
 */
export async function discoverCliModels(
  cliExecutable: string | undefined,
  deps: Partial<ModelCliDiscoveryDeps> = {},
): Promise<CliModelDiscoveryResult> {
  const { execFile: execFn, platform, env } = { ...defaultDiscoveryDeps(), ...deps };
  const trimmed = (cliExecutable ?? '').trim();
  const candidates = trimmed.length > 0 ? [trimmed] : defaultAgyExecutableCandidates(platform, env);
  const notFound: string[] = [];
  for (const candidate of candidates) {
    const { err, stdout, stderr } = await runModelsCommand(execFn, candidate);
    if (err === null) {
      const models = parseAgyModelsTsv(stdout);
      if (models.length === 0) {
        // 退出码 0 但零可解析行（异常形态——非交互环境的空输出等）：不当成功
        //（UI 会展示 0 模型的伪成功面），如实按失败上报。
        getLogger().warn({ executable: candidate }, 'model:list-cli-models: empty TSV output');
        return {
          ok: false,
          error: 'discovery-failed',
          detail: `'${candidate} models' returned no parseable model rows`,
        };
      }
      return { ok: true, resolvedExecutable: candidate, models };
    }
    // CR-11（09-12 agy provider CR 批）：三码皆「本候选不可执行」——步行续试，PATH 兜底
    // 候选可达（首候选 EACCES/EISDIR 不再中断整条探测链）。
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EISDIR') {
      notFound.push(`${candidate} (${String(err.code)})`);
      continue;
    }
    const haystack = `${err.message}\n${stderr}\n${stdout}`;
    if (isAuthError(haystack)) {
      getLogger().warn({ executable: candidate }, 'model:list-cli-models: not logged in');
      return { ok: false, error: 'not-logged-in' };
    }
    getLogger().warn(
      { executable: candidate, code: String(err.code), killed: err.killed === true },
      'model:list-cli-models: discovery failed',
    );
    return { ok: false, error: 'discovery-failed', detail: excerpt(`${err.message}\n${stderr}`) };
  }
  return {
    ok: false,
    error: 'executable-not-found',
    detail: `tried: ${notFound.join(', ')}`,
  };
}

export function registerModelCliDiscoveryIpc() {
  ipcMain.handle(
    'model:list-cli-models',
    async (_event, request: ListCliModelsRequest): Promise<CliModelDiscoveryResult> => {
      if (request?.cliExecutable !== undefined && typeof request.cliExecutable !== 'string') {
        return { ok: false, error: 'discovery-failed', detail: 'cliExecutable must be a string' };
      }
      return discoverCliModels(request?.cliExecutable);
    },
  );
}
