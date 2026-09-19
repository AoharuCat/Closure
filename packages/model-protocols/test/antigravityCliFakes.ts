import type { AgyPoolDeps, CliChild } from '../src/antigravityCli/sessions';

// ── Antigravity CLI 驱动器测试 fakes（09-12 agy provider W2）──
//
// 零真进程纪律（task 约束：绝不运行真 agy——消耗用户 Google Pro 配额）：fake 子进程
// 可脚本化事件流（stdout NDJSON 行 / stderr / 退出），捕获 stdin 写行 + kill/stdin
// 关停动作；pool deps 的 now/timer 全手动驱动（无墙钟依赖）。

export interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  clear(): void;
}

export class FakeAgyProcess implements CliChild {
  readonly spawnArgs: { executable: string; args: string[]; cwd: string; env?: Record<string, string> };
  writtenLines: string[] = [];
  killed = false;
  stdinEnded = false;
  exited = false;
  exitCode: number | null = null;
  /**
   * 注入式写失败次数（0 = 恒成功）：置 1 即下一次写入失败并消耗掉（此后写入恢复成功）。
   * 覆盖面 = 「纠正在途写失败」这类一次性故障（失败即作废会话，不存在重试面）。
   */
  writeFailureBudget = 0;
  /** writeLine 的模拟延迟（背压观测用；默认 0 = 立即）。 */
  writeDelayMs = 0;
  /** 每条写入行的响应钩子（测试脚本化事件流——按写入回放 stdout）。 */
  responder?: (line: string, index: number) => void;
  private readonly lineCbs = new Set<(line: string) => void>();
  private readonly stderrCbs = new Set<(chunk: string) => void>();
  private readonly exitCbs = new Set<(code: number | null) => void>();

  constructor(spawnArgs: { executable: string; args: string[]; cwd: string; env?: Record<string, string> }) {
    this.spawnArgs = spawnArgs;
  }

  kill(): void {
    this.killed = true;
    this.exit(1);
  }

  endStdin(): void {
    this.stdinEnded = true;
    // 优雅关停语义：close stdin → 进程自退（fake 立即兑现）。
    this.exit(0);
  }

  async writeLine(line: string): Promise<void> {
    if (this.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    }
    if (this.exited) {
      throw new Error('write EPIPE (fake: process already exited)');
    }
    if (this.writeFailureBudget > 0) {
      this.writeFailureBudget -= 1;
      throw new Error('write EPIPE (fake: injected write failure)');
    }
    this.writtenLines.push(line);
    if (this.responder !== undefined) {
      // 真 agy 的响应经 stdout 异步回流（write 返回时事件尚未产生）——fake 以
      // macrotask 模拟该时序：驱动器 await writeLine 后先注册流 tap，事件随后到。
      const responder = this.responder;
      const index = this.writtenLines.length;
      setTimeout(() => responder(line, index), 0);
    }
  }

  onStdoutLine(cb: (line: string) => void): void {
    this.lineCbs.add(cb);
  }

  onStderrData(cb: (chunk: string) => void): void {
    this.stderrCbs.add(cb);
  }

  onExit(cb: (code: number | null) => void): void {
    if (this.exited) cb(this.exitCode);
    else this.exitCbs.add(cb);
  }

  hasExited(): boolean {
    return this.exited;
  }

  // ── 脚本化 API ──

  emitLine(line: string): void {
    for (const cb of this.lineCbs) cb(line);
  }

  emitEvent(event: Record<string, unknown>): void {
    this.emitLine(JSON.stringify(event));
  }

  emitStderr(chunk: string): void {
    for (const cb of this.stderrCbs) cb(chunk);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    for (const cb of this.exitCbs) cb(code);
  }

  /** 一轮完整成功事件流（init → agent_response ACTIVE/DONE（delta×2，含 DONE 步 usage）→ result）。 */
  scriptSuccessTurn(response: string, stepUsage: { input: number; output: number; thinking?: number; cache_read?: number }, resultUsage = stepUsage): void {
    this.emitEvent({ type: 'init', cwd: this.spawnArgs.cwd, tools: [], permission_mode: 'request-review', model: 'gemini-test' });
    this.emitEvent({ type: 'step_update', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: response.slice(0, Math.ceil(response.length / 2)) });
    this.emitEvent({
      type: 'step_update', step_index: 1, state: 'DONE', step_type: 'agent_response',
      text_delta: response.slice(Math.ceil(response.length / 2)),
      usage: { input: stepUsage.input, output: stepUsage.output, thinking: stepUsage.thinking ?? 0, cache_read: stepUsage.cache_read ?? 0, total: stepUsage.input + stepUsage.output },
    });
    this.emitEvent({ type: 'result', conversation_id: 'conv-1', status: 'SUCCESS', response, duration_ms: 1000, num_turns: 1, usage: resultUsage });
  }

  /** 终态为 ERROR 的 result（错误分类表素材）。 */
  scriptErrorTurn(status: string, response: string): void {
    this.emitEvent({ type: 'result', conversation_id: 'conv-1', status, response });
  }
}

export interface FakePoolEnv {
  deps: AgyPoolDeps;
  /** 每次 spawn 产出的 fake 进程（按 spawn 序）。 */
  spawns: FakeAgyProcess[];
  removedDirs: string[];
  createdDirs: string[];
  timers: FakeTimer[];
  /** deps.warn 收集的观测消息（CR-24 单缝——测试断言零 console 侦听）。 */
  warns: string[];
  /** deps.info 收集的观测消息。 */
  infos: string[];
  /** commitSeenHashes 实收序列（镜像记账断言面——R7 纠正行记账用；副本取存防后续覆写）。 */
  commitCalls: string[][];
  nowValue: number;
  advanceNow(ms: number): void;
  /** 触发全部未清定时器（按创建序；新定时器照常追加，可再次触发）。 */
  fireTimers(): void;
  pendingTimers(): FakeTimer[];
}

export function fakePoolEnv(spawnImpl?: (proc: FakeAgyProcess) => void): FakePoolEnv {
  const spawns: FakeAgyProcess[] = [];
  const removedDirs: string[] = [];
  const createdDirs: string[] = [];
  const timers: FakeTimer[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const commitCalls: string[][] = [];
  let nowValue = 1_000_000;

  const deps: AgyPoolDeps = {
    spawn: (executable, args, opts) => {
      const proc = new FakeAgyProcess({
        executable,
        args,
        cwd: opts.cwd,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
      spawnImpl?.(proc);
      spawns.push(proc);
      return proc;
    },
    mkdtemp: async (prefix) => {
      const dir = `${prefix}${createdDirs.length}`;
      createdDirs.push(dir);
      return dir;
    },
    removeDir: async (dir) => {
      removedDirs.push(dir);
    },
    now: () => nowValue,
    setTimer: (fn, ms) => {
      const timer: FakeTimer = {
        fn,
        ms,
        cleared: false,
        clear() {
          this.cleared = true;
        },
      };
      timers.push(timer);
      return timer;
    },
    warn: (message) => {
      warns.push(message);
    },
    info: (message) => {
      infos.push(message);
    },
    onCommitSeenHashes: (hashes) => {
      commitCalls.push([...hashes]);
    },
  };

  const fireTimers = (): void => {
    for (const timer of [...timers]) {
      if (!timer.cleared) timer.fn();
    }
  };

  return {
    deps,
    spawns,
    removedDirs,
    createdDirs,
    timers,
    warns,
    infos,
    commitCalls,
    get nowValue() {
      return nowValue;
    },
    advanceNow(ms: number) {
      nowValue += ms;
    },
    fireTimers,
    pendingTimers: () => timers.filter((t) => !t.cleared),
  };
}
