import { defaultAgyPoolDeps, createAntigravityCliDriver } from '@orison/model-protocols';
import type { ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// agy CLI driver 测试夹具（shell 侧跨包交叉校验专用）
//
// 用途：shell 侧有两处「按文案匹配协议层产物」的跨包耦合（`agyCliLog.ts` 的
// `EMPTY_TURN_MESSAGE_NEEDLE` / `BUILTIN_TOOL_DENY_MESSAGE_NEEDLE` 与 `agentIpc.ts` 的
// 降级 warn 签名前缀/标记）——协议层常量不对 shell 导出（依赖方向 shell → 协议层单向），
// 无法共享常量。守门方式 = **跑真 driver** 产出真实错误 / 真实 warn，断言 shell 侧的匹配
// 针命中：协议层改文案而 shell 未同步 = 用例红，不是静默失效。
//
// 纪律：deps.spawn / mkdtemp / removeDir 全替换为 fake——**绝不 spawn 真 agy**
//（消耗用户 Google Pro 配额，红线）。warn/info 保留生产实现（console.warn 门控）
// ——正是「生产拦截面所见即此处产出」的成立前提。
// ─────────────────────────────────────────────────────────────────────────────

/** 极简 CliChild 假体（结构匹配协议层 `CliChild`；只实现驱动实际消费的七个成员）。 */
export interface FakeAgyProc {
  spawnArgs: { executable: string; args: string[]; cwd: string; env?: Record<string, string> };
  writtenLines: string[];
  killed: boolean;
  stdinEnded: boolean;
  exited: boolean;
  exitCode: number | null;
  /** 每条写入行的响应脚本（测试经 onSpawn 钩子注入；真 agy 的响应经 stdout 异步回流）。 */
  responder?: (line: string, index: number) => void;
  kill(): void;
  endStdin(): void;
  writeLine(line: string): Promise<void>;
  onStdoutLine(cb: (line: string) => void): void;
  onStderrData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  hasExited(): boolean;
  /** 脚本化：发一条 stdout 行（NDJSON 事件或裸行）。 */
  emitLine(line: string): void;
  emitEvent(event: Record<string, unknown>): void;
  emitStderr(chunk: string): void;
}

export interface FakeDriverEnv {
  /** 直接喂 `createAntigravityCliDriver` 的池依赖（仅 spawn/mkdtemp/removeDir/now/setTimer 被替换）。 */
  deps: Parameters<typeof createAntigravityCliDriver>[0];
  /** 按 spawn 序产出的 fake 进程（每个 = 一次真 spawn 的代次）。 */
  spawns: FakeAgyProc[];
}

/**
 * fake 池依赖 + 进程账。`onSpawn` 在每次 spawn 后即时调用（注入该代次的 responder 脚本）。
 * warn/info 取 `defaultAgyPoolDeps()` 的生产实现——shell agentIpc 的 console.warn 拦截层
 * 才能看到真 warn（跨包交叉校验的另一半）。
 */
export function fakeDriverEnv(onSpawn?: (proc: FakeAgyProc) => void): FakeDriverEnv {
  const spawns: FakeAgyProc[] = [];
  const deps: FakeDriverEnv['deps'] = {
    ...defaultAgyPoolDeps(),
    spawn: (executable: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) => {
      const proc = createFakeAgyProc({
        executable,
        args,
        cwd: opts.cwd,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
      spawns.push(proc);
      onSpawn?.(proc);
      return proc;
    },
    mkdtemp: async (prefix: string) => `${prefix}fake-${spawns.length}-${Math.random().toString(36).slice(2, 8)}`,
    removeDir: async () => {},
    now: () => Date.now(),
    setTimer: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      (timer as { unref?: () => void }).unref?.();
      return { clear: () => clearTimeout(timer) };
    },
  };
  return { deps, spawns };
}

function createFakeAgyProc(spawnArgs: FakeAgyProc['spawnArgs']): FakeAgyProc {
  const lineCbs = new Set<(line: string) => void>();
  const stderrCbs = new Set<(chunk: string) => void>();
  const exitCbs = new Set<(code: number | null) => void>();

  const proc: FakeAgyProc = {
    spawnArgs,
    writtenLines: [],
    killed: false,
    stdinEnded: false,
    exited: false,
    exitCode: null,
    responder: undefined,
    kill(): void {
      proc.killed = true;
      exit(1);
    },
    endStdin(): void {
      proc.stdinEnded = true;
      exit(0); // 优雅关停语义：close stdin → 进程自退（fake 立即兑现）
    },
    async writeLine(line: string): Promise<void> {
      if (proc.exited) throw new Error('write EPIPE (fake: process already exited)');
      proc.writtenLines.push(line);
      const responder = proc.responder;
      if (responder !== undefined) {
        const index = proc.writtenLines.length;
        // macrotask 模拟真 agy 的异步回流（写返回时事件尚未产生）。
        setTimeout(() => responder(line, index), 0);
      }
    },
    onStdoutLine(cb: (line: string) => void): void {
      lineCbs.add(cb);
    },
    onStderrData(cb: (chunk: string) => void): void {
      stderrCbs.add(cb);
    },
    onExit(cb: (code: number | null) => void): void {
      if (proc.exited) cb(proc.exitCode);
      else exitCbs.add(cb);
    },
    hasExited(): boolean {
      return proc.exited;
    },
    emitLine(line: string): void {
      for (const cb of lineCbs) cb(line);
    },
    emitEvent(event: Record<string, unknown>): void {
      proc.emitLine(JSON.stringify(event));
    },
    emitStderr(chunk: string): void {
      for (const cb of stderrCbs) cb(chunk);
    },
  };

  function exit(code: number | null): void {
    if (proc.exited) return;
    proc.exited = true;
    proc.exitCode = code;
    for (const cb of exitCbs) cb(code);
  }

  return proc;
}

/** CLI 形态最小可用模型（driver 只消费 cliExecutable / keyId / modelId）。 */
export function cliTestModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'test-key',
    modelId: 'gemini-test',
    protocol: 'antigravity-cli',
    baseUrl: '',
    apiKey: '',
    capability: 'text',
    cliExecutable: 'C:\\agy\\bin\\agy.exe',
    ...overrides,
  } as ResolvedModel;
}

export function cliTestRequest(overrides: Partial<TextGenerationRequest> = {}): TextGenerationRequest {
  return {
    model: 'gemini-test',
    messages: [{ role: 'user', content: 'x' }],
    ...overrides,
  };
}
