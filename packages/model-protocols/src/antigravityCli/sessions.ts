import { randomUUID } from 'node:crypto';

// ── Antigravity CLI 会话池（09-12 agy provider，design §3.1）──
//
// per (sessionKey, keyId, modelId) 键控一个长驻 stdin stream-json 进程：
//   - turn 串行（官方红线：等 result 再写下一行）——同键 busy + 排队；abort × 队列
//     （复核 M6）：排队中被 abort → 出队 + AbortError 上抛（不 spawn 不占位）；在途
//     turn 被 abort → kill + 作废会话；
//   - 同键 spawn 单飞（CR-4）：并发首获共享同一在途 spawn promise——mkdtemp 的 await
//     间隙不让第二路过「表未命中」检查（双 spawn = 孤儿 + 串行红线破）；
//   - 并发帽 + 逐出（复核 H1）：进程数上限（默认 3，在途 spawn 计入）；逐出候选
//     **限定 idle 进程**（busy 进程的 lastUsedAt 在 turn 开始时更新——LRU 全表选会
//     中长跑 turn 在途进程）；全表 busy 时新 spawn **排队**等任一进程转 idle——绝不
//     杀在途、绝不超帽；
//   - dispose 保证（CR-15 会话侧半）：dispose 后拒绝一切新占用；spawn 在途落定时
//     即弃（优雅关停，无孤儿）；
//   - 闲置清理：idle TTL（默认 10 min）后台定时器优雅关停（缓存上下文随进程消失，
//     下次冷启动重建——正确性永不依赖进程存活）；
//   - 优雅退出 = close stdin（当前 turn 完成后进程自退）+ 5s 硬杀兜底；硬退出 = kill；
//   - 会话作废：abort / CANCELED / INTERRUPTED / 进程意外退出 → 清表项（下次冷启动）。
//
// DI seam（mirror closureIndexer.ReindexDeps 先例）：spawn / mkdtemp / removeDir / now /
// setTimer / warn / info 全注入——单测零真进程（testing-discipline）。

/** 默认并发帽（design §3.1：小并发默认；「并发 spawn 治理」）。 */
export const DEFAULT_AGY_PROCESS_CAP = 3;
/** idle TTL：10 min 后台定时器优雅关停。 */
export const DEFAULT_AGY_IDLE_TTL_MS = 10 * 60_000;
/** 后台清扫间隔。 */
export const IDLE_SWEEP_INTERVAL_MS = 60_000;
/** 优雅关停（close stdin）后多久硬杀兜底。 */
export const GRACEFUL_EXIT_KILL_MS = 5_000;

/** dispose 后新占用的拒绝信息（CR-15：quit 竞态孤儿 spawn 防线——会话侧半）。 */
const AGY_POOL_DISPOSED_MESSAGE =
  'antigravity-cli session pool disposed (app shutting down) — request rejected';

/** 会话表键 = (逻辑会话键, provider key, 模型) 三元组——同会话换模型/换 key 各自独立进程。 */
export interface AgySessionKey {
  sessionKey: string;
  keyId: string;
  modelId: string;
}

export function agySessionKeyId(key: AgySessionKey): string {
  return `${key.sessionKey}::${key.keyId}::${key.modelId}`;
}

/** 假宿归属撞段（CR-10）：两逻辑会话（如两个 sessionId）sanitize 到同一 homeDir 段——typed error 即抛。 */
export class AgyFakeHomeCollisionError extends Error {
  constructor(homeDir: string, owner: string, attempted: string) {
    super(`agy fake home dir collision: ${homeDir} is owned by session ${owner}, refusing ${attempted}`);
    this.name = 'AgyFakeHomeCollisionError';
  }
}

export function createCliAbortError(): Error {
  const err = new Error('antigravity-cli generation aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createCliAbortError();
}

/**
 * 子进程最小缝（真实适配 spawnRealCli 包 node:child_process；测试 fake 直投本接口）。
 * stdout 行 = NDJSON 事件流；stderr = 诊断（错误分类输入）。
 */
export interface CliChild {
  kill(): void;
  /** 优雅退出：close stdin——agy 完成当前 turn 后自退。 */
  endStdin(): void;
  /** 写一行（追加换行）；背压时等 drain；写失败（EPIPE）reject。 */
  writeLine(line: string): Promise<void>;
  onStdoutLine(cb: (line: string) => void): void;
  onStderrData(cb: (chunk: string) => void): void;
  /** 退出通知（恰好一次；已死则立即回调）。 */
  onExit(cb: (code: number | null) => void): void;
  hasExited(): boolean;
}

export type SpawnCliFn = (
  executable: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => CliChild;

export interface CliSpawnSpec {
  executable: string;
  args: string[];
  /**
   * 附加/覆盖子进程 env（子4 E1 β 通道：USERPROFILE/HOME 双变量同指假宿——W0 §10 实测
   * 双设生效）。缺省 = 不改 env（纯文本路径逐字节现行为）。
   */
  env?: Record<string, string>;
  /**
   * 假宿目录（子4 E1）。提供即表示池接管该目录生命周期：首个占用进程 spawn 前经
   * `prepareHome` 准备（若给），**最后一个关联进程退出后 best-effort 删除**（与临时 cwd
   * removeDir 同批语义）。restart 换柄期间引用计数保持 ≥1（假宿不删——新旧进程交接）。
   */
  homeDir?: string;
  /**
   * 假宿归属身份（CR-10，如桥 sessionId）：同 homeDir 的并发占用必须同 owner。不同
   * owner 即 sanitize 撞段（两逻辑会话净化到同一路径）——池侧 typed 拒绝，绝不静默
   * 共用（引用计数跳过 prepareHome 的窗口里会读错首会话 mcp_config/管道 token）。
   */
  homeOwner?: string;
  /**
   * mkdtemp 后、spawn 前调（仅该 homeDir 的首个占用进程——引用计数 0→1 时；restart 复用
   * 在世假宿不重拷）。失败 = spawn 失败（调用方收拒绝，不留半启动进程）。实现经调用方
   * 闭包注入（bridgeTurn → shell installShellAgyBridgeCore 四件套写入）——本模块零 fs。
   */
  prepareHome?(homeDir: string): Promise<void>;
}

export interface AgyPoolDeps {
  spawn: SpawnCliFn;
  mkdtemp: (prefix: string) => Promise<string>;
  /** 进程退出后的临时目录清理（best-effort）。 */
  removeDir: (dir: string) => Promise<void>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { clear(): void };
  /** 观测 warn（缺省静默——单测免噪音；defaultAgyPoolDeps 提供生产实现 = console.warn）。 */
  warn?: (message: string) => void;
  /** 观测 info（低频仪表类；defaultAgyPoolDeps 门控 ORISON_PROTOCOL_DEBUG，mirror generate.ts 每请求仪表先例）。 */
  info?: (message: string) => void;
  /**
   * 观测缝：`commitSeenHashes` 实收序列（镜像记账断言用——R7 纠正续跑的记账断言需要看
   * 「本 cycle 全序列 + 纠正段」这一形态，生产缺省不挂）。
   */
  onCommitSeenHashes?: (hashes: readonly string[]) => void;
}

/**
 * 单个已 spawn 进程的簿记。turn 级 tap（stdout/stderr/exit observer）挂在本体上——
 * restart 换新 handle 时旧 handle 的 tap 与观察者被显式卸除（CR-7：优雅关停期间旧进程
 * 的晚到输出不得喂旧 turn），旧 handle 只剩目录清理职责。
 */
interface ProcHandle {
  proc: CliChild;
  cwd: string;
  exited: boolean;
  exitCode: number | null;
  exitPromise: Promise<number | null>;
  /** 池级退出观察（表项清理等——注册即一次性）。 */
  poolExitObservers: Array<(code: number | null) => void>;
  /** 当前 turn 的退出观察（单槽，turn 结束卸下）。 */
  turnExitObserver: ((code: number | null) => void) | undefined;
  lineTap: ((line: string) => void) | undefined;
  stderrTap: ((chunk: string) => void) | undefined;
  resolveExit: (code: number | null) => void;
}

/** 会话表项。 */
interface SessionEntry {
  id: string;
  handle: ProcHandle;
  /** mirror：已发段 hash 序列（design §3.2——记录「已发」，与 turn 成败无关）。 */
  seenHashes: string[];
  lastUsedAt: number;
  busy: boolean;
}

/** 一次 turn 期间暴露给调用方的会话句柄（busy 持有中）。 */
export interface AgyTurnSession {
  /** 当前进程已见段 hash（拷贝）。 */
  readonly seenHashes: readonly string[];
  readonly exited: boolean;
  /** 分歧冷重启：原位换新进程 + 镜像清空（表项不动、busy 保持——不给出偷位窗口）。 */
  restart(): Promise<void>;
  writeLine(line: string): Promise<void>;
  setLineTap(cb: ((line: string) => void) | undefined): void;
  setStderrTap(cb: ((chunk: string) => void) | undefined): void;
  /** 当前进程退出观察（单槽；turn 结束传 undefined 卸下）。 */
  setExitObserver(cb: ((code: number | null) => void) | undefined): void;
  /** 记录已发段 hash（writeLine 成功后即提交——镜像语义是「已发」）。 */
  commitSeenHashes(hashes: string[]): void;
  /** 作废会话：kill + 清表项（下次冷启动）。 */
  invalidate(reason: string): void;
}

interface PoolWaiter {
  wake: () => void;
  signal: AbortSignal | undefined;
}

export interface AgyPoolOptions {
  cap?: number;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
}

export class AgySessionPool {
  private readonly entries = new Map<string, SessionEntry>();
  /** 同键在途 spawn 单飞表（CR-4）：并发首获共享同一 promise，杜绝双 spawn。 */
  private readonly pendingSpawns = new Map<string, Promise<SessionEntry>>();
  /**
   * 假宿占用登记（子4 E1 + CR-10）：homeDir → { 在世关联进程数, 归属 owner }。0→1 时
   * prepareHome（若给）；归零时 best-effort removeDir。restart 新旧交接期保持 ≥1，
   * 假宿不误删。owner 不符（sanitize 撞段）= typed 拒绝。
   */
  private readonly homeClaims = new Map<string, { refs: number; owner?: string }>();
  private readonly waiters = new Set<PoolWaiter>();
  private readonly cap: number;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private sweeper: { clear(): void } | undefined;
  private disposed = false;

  constructor(
    private readonly deps: AgyPoolDeps,
    opts: AgyPoolOptions = {},
  ) {
    this.cap = opts.cap ?? DEFAULT_AGY_PROCESS_CAP;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_AGY_IDLE_TTL_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;
  }

  /** 会话键路径：同键 turn 串行；表未命中/被逐出 → spawn（帽感知）。 */
  async runTurn<T>(
    key: AgySessionKey,
    spec: CliSpawnSpec,
    signal: AbortSignal | undefined,
    fn: (session: AgyTurnSession) => Promise<T>,
  ): Promise<T> {
    const entry = await this.acquire(agySessionKeyId(key), spec, signal);
    return this.executeTurn(entry, spec, signal, fn, { oneshot: false });
  }

  /** 单发冷路径（无 sessionKey）：唯一瞬态键 + turn 毕即弃（优雅关停 + 清理）。 */
  async runOneshot<T>(
    spec: CliSpawnSpec,
    signal: AbortSignal | undefined,
    fn: (session: AgyTurnSession) => Promise<T>,
  ): Promise<T> {
    const entry = await this.acquire(`oneshot:${randomUUID()}`, spec, signal);
    return this.executeTurn(entry, spec, signal, fn, { oneshot: true });
  }

  /** 全量关停（app 退出 / 测试清理）。 */
  dispose(): void {
    this.disposed = true;
    this.sweeper?.clear();
    this.sweeper = undefined;
    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.id);
      void this.gracefulStop(entry.handle);
    }
    this.wakeAll();
  }

  // ── 内部 ──

  private async executeTurn<T>(
    entry: SessionEntry,
    spec: CliSpawnSpec,
    signal: AbortSignal | undefined,
    fn: (session: AgyTurnSession) => Promise<T>,
    mode: { oneshot: boolean },
  ): Promise<T> {
    try {
      return await fn(this.makeSession(entry, spec));
    } catch (err) {
      // abort 或进程已死 → 作废会话（kill + 清表项）——会话态不可信，下次冷启动。
      const abortLike = (err instanceof Error && err.name === 'AbortError') || signal?.aborted === true;
      if (abortLike || entry.handle.exited) {
        this.invalidateEntry(entry, abortLike ? 'abort' : 'process-exited');
      }
      throw err;
    } finally {
      if (mode.oneshot) {
        this.entries.delete(entry.id);
        void this.gracefulStop(entry.handle);
      } else if (this.entries.get(entry.id) === entry && !entry.handle.exited) {
        entry.busy = false;
        entry.lastUsedAt = this.deps.now();
      }
      this.wakeAll();
    }
  }

  private async acquire(id: string, spec: CliSpawnSpec, signal: AbortSignal | undefined): Promise<SessionEntry> {
    for (;;) {
      throwIfAborted(signal);
      // CR-15：dispose 后拒绝一切新占用（quit 竞态孤儿 spawn 防线——会话侧半；
      // shell will-quit 接线在批 B）。含等待后重查：被 dispose 唤醒的排队者在此退出。
      if (this.disposed) throw new Error(AGY_POOL_DISPOSED_MESSAGE);
      const existing = this.entries.get(id);
      if (existing !== undefined) {
        if (existing.busy) {
          await this.waitChange(signal); // 同键 turn 串行
          continue;
        }
        existing.busy = true;
        existing.lastUsedAt = this.deps.now();
        this.ensureSweeper();
        return existing;
      }
      // 同键在途 spawn：直接共享等待（不进帽等待——spawn 失败时两侧同收拒绝，
      // 绝无「一方收错、另一方悬等永不唤醒」的死锁形态）。
      const inFlight = this.pendingSpawns.get(id);
      if (inFlight !== undefined) {
        await inFlight;
        continue;
      }
      // 在途 spawn 计入帽（防并发 spawn 期间的帽超发：检查与 entries.set 之间有 await 间隙）。
      if (this.entries.size + this.pendingSpawns.size >= this.cap) {
        const idle = [...this.entries.values()].filter((e) => !e.busy);
        if (idle.length === 0) {
          await this.waitChange(signal); // 全表 busy：排队等任一转 idle——绝不杀在途、绝不超帽
          continue;
        }
        // 逐出候选限定 idle（复核 H1）；LRU 取最旧。detach 即出表（槽位立释）。
        idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        const victim = idle[0]!;
        this.entries.delete(victim.id);
        void this.gracefulStop(victim.handle);
        continue;
      }
      // CR-4 单飞：同键并发首获共享同一 spawn promise——直接 spawn 会让第二路也过
      // 「表未命中」检查（mkdtemp 的 await 间隙）→ 双进程（孤儿 + 同键串行红线破）。
      await this.spawnEntryOnce(id, spec);
      continue; // 表项就位后重查：命中即标 busy 返回（并发首获方在此排队——串行保持）
    }
  }

  /** 同键 spawn 单飞（CR-4）：并发首获共享同一 promise；完成时池已 dispose → 即弃。 */
  private spawnEntryOnce(id: string, spec: CliSpawnSpec): Promise<SessionEntry> {
    const inFlight = this.pendingSpawns.get(id);
    if (inFlight !== undefined) return inFlight;
    const guarded: Promise<SessionEntry> = this.spawnEntry(id, spec).then((entry) => {
      if (this.disposed) {
        // CR-15：spawn 在途时 dispose——新柄即刻优雅关停（不留孤儿），调用方收 disposed 错。
        this.entries.delete(entry.id);
        void this.gracefulStop(entry.handle);
        throw new Error(AGY_POOL_DISPOSED_MESSAGE);
      }
      return entry;
    }).finally(() => {
      if (this.pendingSpawns.get(id) === guarded) this.pendingSpawns.delete(id);
      // spawn 落定必唤醒：失败时帽压力解除（在途计数归零、无新表项），帽等待者须重查。
      this.wakeAll();
    });
    this.pendingSpawns.set(id, guarded);
    return guarded;
  }

  private async spawnEntry(id: string, spec: CliSpawnSpec): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id,
      handle: {} as ProcHandle,
      seenHashes: [],
      lastUsedAt: this.deps.now(),
      busy: false,
    };
    await this.attachFreshProc(entry, spec);
    this.entries.set(id, entry);
    // 表项就位即武清扫器——spawn 完成但调用方在途中被 abort/dispose 拒绝时，遗留的
    // idle 表项（未污染、可复用）仍受 idle TTL 治理，不靠下一次调用才被覆盖。
    this.ensureSweeper();
    return entry;
  }

  /** spawn 新进程挂到 entry（初生 + restart 共用）：镜像清空 + 意外退出清表观察。 */
  private async attachFreshProc(entry: SessionEntry, spec: CliSpawnSpec): Promise<void> {
    const handle = await this.spawnProc(spec);
    entry.handle = handle;
    entry.seenHashes = [];
    // 进程意外退出（且仍是本表项的现役 handle）→ 清表项 + 唤醒等待者（在途 turn 经
    // turnExitObserver 察觉）。restart 换下的旧 handle 因 handle 身份不符不触发。
    handle.poolExitObservers.push(() => {
      if (entry.handle === handle && this.entries.get(entry.id) === entry) {
        this.entries.delete(entry.id);
        this.wakeAll();
      }
    });
  }

  private async spawnProc(spec: CliSpawnSpec): Promise<ProcHandle> {
    const cwd = await this.deps.mkdtemp('agy-');
    if (spec.homeDir !== undefined) {
      // 子4 E1 + CR-10：假宿占用登记——首占（0→1）先准备（失败 = spawn 失败，计数不加）；
      // 不同 owner 落同 homeDir（sanitize 撞段）= typed 拒绝（绝不静默共用）；此后引用
      // 归零才删（restart 交接期 / 同假宿多进程期不误删）。
      const claim = this.homeClaims.get(spec.homeDir);
      if (
        claim !== undefined && claim.owner !== undefined
        && spec.homeOwner !== undefined && claim.owner !== spec.homeOwner
      ) {
        throw new AgyFakeHomeCollisionError(spec.homeDir, claim.owner, spec.homeOwner);
      }
      const refs = claim?.refs ?? 0;
      if (refs === 0 && spec.prepareHome !== undefined) {
        await spec.prepareHome(spec.homeDir);
      }
      this.homeClaims.set(spec.homeDir, { refs: refs + 1, owner: spec.homeOwner ?? claim?.owner });
    }
    let proc: CliChild;
    try {
      proc = this.deps.spawn(spec.executable, spec.args, {
        cwd,
        ...(spec.env !== undefined ? { env: spec.env } : {}),
      });
    } catch (err) {
      // 同步 spawn 抛出（罕见——真实适配以 'error' 事件归一）：立即归还假宿引用。
      if (spec.homeDir !== undefined) this.releaseHome(spec.homeDir);
      throw err;
    }
    const homeDir = spec.homeDir;
    let resolveExit!: (code: number | null) => void;
    const handle: ProcHandle = {
      proc,
      cwd,
      exited: false,
      exitCode: null,
      exitPromise: new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      }),
      poolExitObservers: [],
      turnExitObserver: undefined,
      lineTap: undefined,
      stderrTap: undefined,
      resolveExit,
    };
    // 流桥：spawn 时注册一次，转发到当前 tap（tap 挂在 handle 上，换 handle 即换流）。
    proc.onStdoutLine((line) => {
      handle.lineTap?.(line);
    });
    proc.onStderrData((chunk) => {
      handle.stderrTap?.(chunk);
    });
    proc.onExit((code) => {
      handle.exited = true;
      handle.exitCode = code;
      handle.resolveExit(code);
      handle.turnExitObserver?.(code);
      for (const observer of handle.poolExitObservers.splice(0)) observer(code);
      void this.deps.removeDir(cwd).catch(() => {}); // best-effort 临时目录清理
      if (homeDir !== undefined) this.releaseHome(homeDir); // 子4 E1：假宿引用归还（归零即删）
    });
    return handle;
  }

  /** 假宿引用归还：归零 → best-effort 删除（lazy——不阻塞退出路径，失败静默由启动清扫守卫兜底）。 */
  private releaseHome(homeDir: string): void {
    const claim = this.homeClaims.get(homeDir);
    const refs = (claim?.refs ?? 0) - 1;
    if (refs > 0) {
      this.homeClaims.set(homeDir, { refs, owner: claim?.owner });
      return;
    }
    this.homeClaims.delete(homeDir);
    void this.deps.removeDir(homeDir).catch(() => {});
  }

  private makeSession(entry: SessionEntry, spec: CliSpawnSpec): AgyTurnSession {
    // 对象字面量内以箭头属性捕获本池实例（this）——方法简写在字面量 this 上，勿改。
    const session: AgyTurnSession = {
      get seenHashes(): readonly string[] {
        return [...entry.seenHashes];
      },
      get exited(): boolean {
        return entry.handle.exited;
      },
      restart: async (): Promise<void> => {
        // 先挂新再关旧：表项全程在表 + busy 保持（无偷位窗口）；旧 handle 换下后其
        // 退出观察因 handle 身份不符不再清表。换新期间的瞬时双进程（旧 dying + 新）
        // 由 5s 硬杀兜底收口。
        const old = entry.handle;
        await this.attachFreshProc(entry, spec);
        // CR-7：换柄即卸旧柄的 turn 级 tap/观察者——旧进程优雅关停期间的晚到行/退出
        // 不得喂进旧 turn 的消费者（读错流），也不得触发其退出观察。
        old.lineTap = undefined;
        old.stderrTap = undefined;
        old.turnExitObserver = undefined;
        await this.gracefulStop(old);
      },
      writeLine: async (line): Promise<void> => {
        // CR-7：绑定发起时的柄——写在途换柄（restart 竞争写）意味着内容落进了被换下
        // 的旧柄（新柄无此上下文），turn 的增量假设已破：响亮报错（driver 包成 502 +
        // 作废），绝不静默当作写成功。
        const handle = entry.handle;
        await handle.proc.writeLine(line);
        if (entry.handle !== handle) {
          throw new Error('antigravity-cli session handle swapped during writeLine (restart raced the write)');
        }
      },
      setLineTap: (cb) => {
        entry.handle.lineTap = cb;
      },
      setStderrTap: (cb) => {
        entry.handle.stderrTap = cb;
      },
      setExitObserver: (cb) => {
        const handle = entry.handle;
        if (cb === undefined) {
          handle.turnExitObserver = undefined;
          return;
        }
        if (handle.exited) {
          cb(handle.exitCode);
          return;
        }
        handle.turnExitObserver = cb;
      },
      commitSeenHashes: (hashes) => {
        // CR-9：观察缝绝不侵入控制流——`onCommitSeenHashes` 是观测缝（镜像记账断言用），
        // 观察者 throw 曾沿调用方 async 体上抛：首行路径 = 未处理 rejection；纠正路径 =
        // 被误报成「写失败」+ 502 作废会话（观测面问题改写 turn 结果）。记账本体照常推进
        // （镜像语义是「已发」，与观察者无关），观察者失败降级为 warn（不静默）。
        try {
          this.deps.onCommitSeenHashes?.(hashes);
        } catch (err) {
          this.deps.warn?.(
            `[antigravity-cli] onCommitSeenHashes observer threw (ignored; mirror bookkeeping continues): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        entry.seenHashes = [...hashes];
      },
      invalidate: (reason) => {
        this.invalidateEntry(entry, reason);
      },
    };
    return session;
  }

  private invalidateEntry(entry: SessionEntry, reason: string): void {
    this.entries.delete(entry.id);
    const handle = entry.handle;
    if (!handle.exited) {
      handle.proc.kill();
    }
    this.deps.warn?.(`[antigravity-cli] session invalidated (${reason}) key=${entry.id}`);
    this.wakeAll();
  }

  /** 优雅关停：close stdin + 5s 硬杀兜底；等真实退出（目录清理由 exit watcher 收）。 */
  private async gracefulStop(handle: ProcHandle): Promise<void> {
    if (handle.exited) return;
    const belt = this.deps.setTimer(() => {
      if (!handle.exited) handle.proc.kill();
    }, GRACEFUL_EXIT_KILL_MS);
    try {
      handle.proc.endStdin();
      await handle.exitPromise;
    } finally {
      belt.clear();
    }
  }

  private waitChange(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      throwIfAborted(signal);
      const waiter: PoolWaiter = {
        signal,
        wake: () => {
          cleanup();
          resolve();
        },
      };
      const onAbort = () => {
        cleanup();
        reject(createCliAbortError());
      };
      const cleanup = () => {
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  private wakeAll(): void {
    for (const waiter of [...this.waiters]) {
      waiter.wake();
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper !== undefined || this.disposed) return;
    const arm = (): void => {
      this.sweeper = this.deps.setTimer(() => {
        this.sweeper = undefined;
        this.sweepIdle();
        if (this.entries.size > 0 && !this.disposed) arm();
      }, this.sweepIntervalMs);
    };
    arm();
  }

  /** idle TTL 清扫：idle 且超时 → 优雅关停出表（busy 永不清扫）。 */
  private sweepIdle(): void {
    const now = this.deps.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.busy) continue;
      if (now - entry.lastUsedAt <= this.idleTtlMs) continue;
      this.entries.delete(entry.id);
      void this.gracefulStop(entry.handle);
      this.deps.warn?.(`[antigravity-cli] idle session swept after ${this.idleTtlMs}ms key=${entry.id}`);
    }
  }
}
