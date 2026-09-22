import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { logger } from '../logger';
import type { BgNotifyChannel, BgTaskHandle } from '../types';

// ── 09-21-subagent-bg-decouple W1（design §1.1 / §4.2）：后台子 agent 任务注册表 ──
//
// BgTaskRegistry 记录 leader 经 spawn_agent_bg 派发的后台子 agent（taskId / parent / child 会话 /
// role / 状态 / 结果 / 通知偏好 / AbortController），子会话不即弃（evict 豁免在 subagent.ts
// dispatchBackground——本模块只做记账，不碰会话生命周期）。职责边界（ADR-3 范式判据）：状态读写 /
// 容量记账 / 落盘镜像 / LRU 保留 = 纯代码；「任务怎么跑」归 child runLoop（subagent.ts），「结果
// 送达怎么通知 leader」归 W2（notifyLeaderEvent / 摘要段）。
//
// 落盘镜像：`{projectPath}/.orison/bg-tasks.json`（mirror 同目录同族的 batches.json——读写经
// shared-contracts fs/atomicWrite；BOM-strip / malformed → graceful null + warn；per-element
// safeParse filter 坏条目单独丢不全丢）。**运行中先写 running 行**（崩溃后 reconcileInterrupted
// 才有据可标——否则进程死则任务蒸发）；完成后回写含 result content 的终态行。
//
// 保留帽（CR 反哺 09-22 ② 定谳 + CR-2 修订）：终态记录 mirror batches.json BATCH_RECORD_CAP=10
// 先例——**内存 registry 与磁盘同帽（BG_TASK_RECORD_CAP=10 / 每项目）**。论证：终态记录是历史
// （UI 历史可检视 + leader 补查），无帽 = 纯慢泄漏（每任务一行 + result.content 常驻内存）；帽内
// 可检视、帽外随对账清理——「历史可检视」承诺随帽收敛。淘汰策略 = 终态迁移时间（updatedAt）LRU，
// 最老终态先出；**running 记录永不淘汰**（活跃状态非历史，且每项目 ≤ MAX_BG_PER_PROJECT，量有
// 界）。**claimed !== true（未领取）的终态记录同样永不淘汰**（CR-2：「结果不丢」破约防护——帽只
// 作用于已领池；全部未领超帽时仅 warn 不淘汰）。claim 不二次释放 content：帽已兜住总量，二次释放
// 会把「bg_task_result 再查拿不到」的回归面换进来（claim 语义只驱动 W2 摘要段 + CR-2 淘汰豁免，
// 不做内存记账开关）。

/** 每项目同时在跑的后台任务上限（design D5：常量非配置，V1；超帽 BgCapacityError 响亮拒绝不排队）。 */
export const MAX_BG_PER_PROJECT = 3;

/** 每项目保留的终态记录数（completed/failed/aborted/interrupted 合计；mirror batches.json cap 10）。 */
export const BG_TASK_RECORD_CAP = 10;

/**
 * 后台任务看门狗超时（CR-6，慷慨常量非配置）：running 态超过此时长无任何终态 → 强制 settle failed
 * 释放帽槽位。论证 30min：合法长活（深研究 / 拆书分析 / 弧审读）分钟级到十几分钟量级——30min 零
 * 终态几乎必然 = 子 runLoop 悬挂（LLM 调用无 abort 支持卡死等），保留槽位至重启的代价（帽 3 卡满
 * 不能再派）远大于误杀一个超长活的风险；且看门狗 settle 是 last-write-wins（迟到真终态照常覆写，
* 见 settleTask），误杀不丢真结果。
 */
export const BG_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';

/** 子 run 终态（dispatchBackground 的 outcome 承诺：永不 reject，终态经 status 表达）。 */
export interface BgTaskOutcome {
  status: 'completed' | 'failed' | 'aborted';
  content?: string;
  error?: string;
}

export interface BgTaskRecord {
  taskId: string;
  /** leader（派发方）会话 id。 */
  parentSessionId: string;
  /** 子会话 id（不即弃——检视图 / 结果引用 / 计量归因键）。 */
  childSessionId: string;
  role: string;
  projectPath: string;
  /** 派发 prompt 首 120 字（UI/日志/摘要段用，不存全量——防注册表膨胀）。 */
  promptDigest: string;
  status: BgTaskStatus;
  startedAt: number;
  updatedAt: number;
  /** 仅 completed 且未到淘汰线时在（SubagentResult.content——上下文隔离纪律：只 content）。 */
  result?: { content: string };
  error?: string;
  /** 结果送达通道（spawn 时 leader 选，缺省 toast——R3；消费面在 W2）。 */
  notify: BgNotifyChannel;
  /** toast 通道摘要段的领取标记（claim 语义 = bg_task_result 调用，纯代码记账不猜 LLM 是否看过）。 */
  claimed?: boolean;
}

const bgTaskRecordSchema = z.object({
  taskId: z.string().min(1),
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1),
  role: z.string(),
  projectPath: z.string().min(1),
  promptDigest: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'aborted', 'interrupted']),
  startedAt: z.number(),
  updatedAt: z.number(),
  result: z.object({ content: z.string() }).optional(),
  error: z.string().optional(),
  notify: z.enum(['toast', 'wake', 'silent']),
  claimed: z.boolean().optional(),
});

export class BgCapacityError extends Error {
  constructor(
    public readonly projectPath: string,
    public readonly runningCount: number,
    public readonly limit: number = MAX_BG_PER_PROJECT,
  ) {
    super(`background task capacity reached for project "${projectPath}": ${runningCount}/${limit} running`);
    this.name = 'BgCapacityError';
  }
}

// ── 落盘镜像（mirror batch-state.ts 形态：三态 graceful + per-element filter + 原子写）──

const BOM_CHAR_CODE = 0xfeff;

/**
 * 路径比较归一（CR-7）：win32 大小写不敏感 + 正斜杠归一——mirror shell pathGuard
 * normalizeProjectKey 词表 duck-type（agent 包零 import shell 纪律，spec module-boundaries；
 * 平台条件同款）。词法归一非 realpath（与 shell 同款论证：注册表/列表比较只需确定性，无安全
 * 语义）；path.resolve 段落归一省略——本项目路径恒为绝对规范形态（shell 侧传入前已 resolve），
 * 仅做比较面必要部分（分隔符 + 大小写 + 尾斜杠）。
 */
function normalizeProjectPathForCompare(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * 终态保留帽策略（CR-2 单源纯函数——内存 registry 与磁盘镜像共用，防两处漂移）：
 * 按updatedAt 最新在前排序后，**claimed !== true（未领取）的终态记录永不淘汰**（「结果不丢」
 * 破约防护）；帽溢出只淘汰已领记录（最老优先）。已领全部淘汰仍超帽（全未领超帽族）→ 全保
 * 不淘汰（kept 超帽，caller 负责警告）。返 kept（帽内 + 未领豁免）与 evicted（被淘汰记录）。
 */
export function applyBgTaskRecordCap(terminal: BgTaskRecord[]): { kept: BgTaskRecord[]; evicted: BgTaskRecord[] } {
  const sorted = [...terminal].sort((a, b) => b.updatedAt - a.updatedAt);
  const overflow = sorted.length - BG_TASK_RECORD_CAP;
  if (overflow <= 0) return { kept: sorted, evicted: [] };
  // 已领池（可淘汰）：updatedAt 最老优先（池内 LRU 同序——sorted 已按最新在前，取池尾）。
  const evictable = sorted.filter((r) => r.claimed === true);
  const evictCount = Math.min(overflow, evictable.length);
  if (evictCount === 0) return { kept: sorted, evicted: [] };
  const toEvict = evictable.slice(evictable.length - evictCount);
  const evictIds = new Set(toEvict.map((r) => r.taskId));
  return { kept: sorted.filter((r) => !evictIds.has(r.taskId)), evicted: toEvict };
}

function bgTasksFilePath(projectPath: string): string {
  return path.join(projectPath, '.orison', 'bg-tasks.json');
}

/**
 * 读后台任务记录数组（per-element safeParse：坏条目 drop + warn，好条目保留）。
 *
 * graceful 三态（mirror loadBatchRuns CR-008 约定）：
 * - 文件不存在 → []（合法「从未派发过后台任务」）；
 * - 损坏（非 JSON / 非数组）→ null（caller 降级，不崩——删文件即清态）；
 * - 读错（EBUSY/EPERM 等瞬时 IO）→ null 同态。caller（reconcileInterrupted）对 null **不回写**，
 *   防瞬时不可读时热覆写丢全部记录（CR-008 教训：`?? []` 重建 = 静默丢账）。
 */
export function loadBgTaskRecords(projectPath: string): BgTaskRecord[] | null {
  const filePath = bgTasksFilePath(projectPath);
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'bg-tasks: bg-tasks.json unreadable (transient IO error) → null; caller must refuse overwrite',
    );
    return null;
  }
  const bomStripped = raw.charCodeAt(0) === BOM_CHAR_CODE ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bomStripped);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), projectPath },
      'bg-tasks: bg-tasks.json malformed JSON → null (delete file to reset)',
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    logger.warn({ projectPath }, 'bg-tasks: bg-tasks.json not an array → null (delete file to reset)');
    return null;
  }
  const records: BgTaskRecord[] = [];
  let dropped = 0;
  for (const entry of parsed) {
    const result = bgTaskRecordSchema.safeParse(entry);
    if (result.success) {
      records.push(result.data);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    logger.warn(
      { projectPath, dropped, total: parsed.length },
      'bg-tasks: dropped malformed bg task records (per-element parse)',
    );
  }
  return records;
}

/** 写后台任务记录数组（原子写 + 终态保留帽〔CR-2：未领永不淘汰，shared 纯函数单源〕；mkdir .orison 防御——mirror saveBatchRuns）。 */
export function saveBgTaskRecords(projectPath: string, records: BgTaskRecord[]): void {
  const running = records.filter((r) => r.status === 'running');
  const { kept } = applyBgTaskRecordCap(records.filter((r) => r.status !== 'running'));
  const dir = path.join(projectPath, '.orison');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(bgTasksFilePath(projectPath), JSON.stringify([...running, ...kept], null, 2), 'utf-8');
}

// ── 注册表（进程内单例——mirror getDefaultRunStateStore 姿态）──

export class BgTaskRegistry {
  private readonly records = new Map<string, BgTaskRecord>();
  /** taskId → 取消句柄（仅 running 存在；终态即删——controller 是取消通道非状态真相源）。 */
  private readonly controllers = new Map<string, AbortController>();
  /** taskId → 看门狗定时器（CR-6；仅 running 存在，settleTask 清——unref 不驻留事件循环）。 */
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 登记并启动一个后台任务。`input.start` 同步调用（内部建 child session + beginRun + 起飞
   * promise 不 await），返 childSessionId 与终态 outcome promise（**约定永不 reject**——终态经
   * BgTaskOutcome.status 表达，dispatchBackground 保证）。start 同步抛错（如父会话缺失）不登记
   * 直接上抛，不留僵尸 running 行。
   *
   * 容量：同项目 running ≥ MAX_BG_PER_PROJECT → 抛 BgCapacityError（响亮拒绝不排队，V1）。
   * 帽检查与登记同在一个同步段（单线程无 interleaving），不会超发。
   */
  dispatchBg(input: {
    parentSessionId: string;
    projectPath: string;
    role: string;
    prompt: string;
    notify: BgNotifyChannel;
    start: (args: { taskId: string; signal: AbortSignal }) => {
      childSessionId: string;
      outcome: Promise<BgTaskOutcome>;
    };
  }): BgTaskHandle {
    const runningCount = this.listByProject(input.projectPath).filter((r) => r.status === 'running').length;
    if (runningCount >= MAX_BG_PER_PROJECT) {
      throw new BgCapacityError(input.projectPath, runningCount);
    }

    const taskId = `bg_${randomUUID()}`;
    const controller = new AbortController();
    // start 同步段：建 child session + beginRun + promise 起飞。同步抛错 → 无登记无残留（上面）。
    const started = input.start({ taskId, signal: controller.signal });

    const now = Date.now();
    const record: BgTaskRecord = {
      taskId,
      parentSessionId: input.parentSessionId,
      childSessionId: started.childSessionId,
      role: input.role,
      projectPath: input.projectPath,
      promptDigest: input.prompt.slice(0, 120),
      status: 'running',
      startedAt: now,
      updatedAt: now,
      notify: input.notify,
    };
    this.records.set(taskId, record);
    this.controllers.set(taskId, controller);
    // CR-6 看门狗：running 超 BG_TASK_TIMEOUT_MS 无终态 → 强制 settle failed（释放帽槽位，
    // 防「子 runLoop 悬挂 → 槽位卡死至重启」）。unref：定时器不驻留事件循环（测试 pending-forever
    // 桩不挂进程退出；生产进程本就常驻无差）。settleTask 统一清（正常终态先到先清）。
    const watchdog = setTimeout(() => {
      logger.warn(
        { taskId, role: input.role, projectPath: input.projectPath, timeoutMs: BG_TASK_TIMEOUT_MS },
        'bg-tasks: task exceeded watchdog timeout → settle failed (stuck slot protection, CR-6)',
      );
      // 尽力顺带停 runLoop（abort 走既有取消链）；若 runLoop 迟后仍给出真终态，settle 以
      // last-write-wins 覆写（如实呈现，看门狗行不掩盖真结果）。
      this.controllers.get(taskId)?.abort(new DOMException('Aborted', 'AbortError'));
      this.settleTask(taskId, {
        status: 'failed',
        error: `后台任务超过 ${Math.round(BG_TASK_TIMEOUT_MS / 60000)} 分钟无终态，已按超时收尾（看门狗强制结算）`,
      });
    }, BG_TASK_TIMEOUT_MS);
    watchdog.unref?.();
    this.watchdogs.set(taskId, watchdog);
    // 运行中先落盘 running 行——崩溃后 reconcileInterrupted 才有据可标 interrupted（design §4.2）。
    // 写盘失败 graceful（记账面故障不破子 run 本体）。
    this.persistProject(input.projectPath);

    // outcome 永不 reject（dispatchBackground 契约）；防御性 catch 兜协议破坏，不挂 unhandled。
    started.outcome.then(
      (outcome) => this.settleTask(taskId, outcome),
      (err) => this.settleTask(taskId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    return { taskId, childSessionId: started.childSessionId, role: input.role, status: 'running' };
  }

  get(taskId: string): BgTaskRecord | undefined {
    return this.records.get(taskId);
  }

  /** 某 leader 会话名下的全部任务（登记序——派发顺序）。 */
  listByParent(parentSessionId: string): BgTaskRecord[] {
    return [...this.records.values()].filter((r) => r.parentSessionId === parentSessionId);
  }

  /** 某项目的全部任务（含内存中 hydrated 的重启前历史；登记序）。**比较面归一（CR-7）**：
   * shell agent:bg-tasks handler / cancelBgTasksForProject / 容量帽检查全经本方法——win32
   * 大小写/分隔符漂移路径不再漏匹配（normalizeProjectPathForCompare 词表 mirror shell）。 */
  listByProject(projectPath: string): BgTaskRecord[] {
    const key = normalizeProjectPathForCompare(projectPath);
    return [...this.records.values()].filter((r) => normalizeProjectPathForCompare(r.projectPath) === key);
  }

  /** 全部任务（CR-5：childSessionId 反查面——被删会话可能本身是某后台任务的子会话）。 */
  listAll(): BgTaskRecord[] {
    return [...this.records.values()];
  }

  /**
   * 取消一个后台任务：abort 取消句柄（经 beginRun 链入 runState store controller → child runLoop
   * 既有 abort 路径）。终态由 outcome 链回写（settleTask）——此处**不改状态**，避免与 runLoop 真实
   * 终态竞态双写。已完成/失败/已取消任务取消 → 类型化 already-terminal（AC：响亮不做 no-op）。
   */
  cancel(taskId: string): { ok: true } | { ok: false; reason: 'not-found' | 'already-terminal' } {
    const record = this.records.get(taskId);
    if (!record) return { ok: false, reason: 'not-found' };
    if (record.status !== 'running') return { ok: false, reason: 'already-terminal' };
    this.controllers.get(taskId)?.abort(new DOMException('Aborted', 'AbortError'));
    return { ok: true };
  }

  /**
   * 标记结果已领取（claim 语义 = bg_task_result 调用；幂等——重复领取返 alreadyClaimed:true 不报错，
   * leader 重复查询结果面更友好）。仅 completed 可领（running 未有结果 / 失败取消无「领取」语义）。
   */
  markClaimed(
    taskId: string,
  ): { ok: true; alreadyClaimed: boolean; record: BgTaskRecord } | { ok: false; reason: 'not-found' | 'not-completed' } {
    const record = this.records.get(taskId);
    if (!record) return { ok: false, reason: 'not-found' };
    if (record.status !== 'completed') return { ok: false, reason: 'not-completed' };
    const alreadyClaimed = record.claimed === true;
    record.claimed = true;
    record.updatedAt = Date.now();
    this.persistProject(record.projectPath);
    return { ok: true, alreadyClaimed, record };
  }

  /**
   * 启动对账（app 重启后 shell 侧逐项目调，W3 接线；形态 mirror reconcileStaleProjectRuns 时序）：
   * 磁盘 running 行改 interrupted 回写（不复活不谎报 running——design D6/R7）+ 全部记录 hydrate 进
   * 内存（completed/failed/aborted 行照常可查——「历史可检视」）。读失败（null）→ 不回写不动文件
   * （CR-008：瞬时不可读不热覆写）。返被标 interrupted 的记录。
   */
  reconcileInterrupted(projectPath: string): BgTaskRecord[] {
    const disk = loadBgTaskRecords(projectPath);
    if (disk === null) return [];
    const interrupted: BgTaskRecord[] = [];
    for (const record of disk) {
      if (record.status === 'running') {
        record.status = 'interrupted';
        record.updatedAt = Date.now();
        record.error = record.error ?? '应用重启时后台任务仍在运行——后台任务不跨重启续跑';
        interrupted.push(record);
      }
      // 全量 hydrate（幂等覆盖——重启后内存从空到有；同 taskId 二次对账 Map set 天然幂等）。
      this.records.set(record.taskId, record);
    }
    if (interrupted.length > 0) {
      this.persistProject(projectPath);
      logger.info(
        { projectPath, count: interrupted.length },
        'bg-tasks: reconciled in-flight bg tasks to interrupted after restart',
      );
    }
    return interrupted;
  }

  /** 终态回写（outcome 链 / 看门狗唯一调用点）：清看门狗 + 更新记录 + 释放取消句柄 + 落盘。
   * 后到 settle 覆写先到（last-write-wins——看门狗先行 settle 后真终态迟到时如实覆写）。 */
  private settleTask(taskId: string, outcome: BgTaskOutcome): void {
    const record = this.records.get(taskId);
    if (!record) return;
    const watchdog = this.watchdogs.get(taskId);
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      this.watchdogs.delete(taskId);
    }
    this.controllers.delete(taskId);
    record.status = outcome.status;
    record.updatedAt = Date.now();
    if (outcome.status === 'completed') {
      record.result = { content: outcome.content ?? '' };
    }
    if (outcome.status === 'failed') {
      record.error = outcome.error;
    }
    this.persistProject(record.projectPath);
  }

  /** 落盘本项目的内存记录切片（终态超帽先裁内存再写盘——内存/磁盘同帽不漂移）。写失败 graceful。 */
  private persistProject(projectPath: string): void {
    const all = this.listByProject(projectPath);
    const running = all.filter((r) => r.status === 'running');
    // CR-2：淘汰策略单源 applyBgTaskRecordCap——未领取（claimed !== true）终态永不淘汰；
    // 已领池内 updatedAt LRU；全未领超帽 → 全保 + warn（「结果不丢」优先于帽）。
    const { kept, evicted } = applyBgTaskRecordCap(all.filter((r) => r.status !== 'running'));
    for (const record of evicted) {
      this.records.delete(record.taskId);
      logger.warn(
        { taskId: record.taskId, role: record.role, projectPath },
        'bg-tasks: evicted claimed terminal record (LRU cap) — unclaimed records are never evicted (CR-2)',
      );
    }
    if (kept.length > BG_TASK_RECORD_CAP) {
      logger.warn(
        { projectPath, kept: kept.length, cap: BG_TASK_RECORD_CAP },
        'bg-tasks: unclaimed terminal records exceed cap — kept all (results must not be lost, CR-2)',
      );
    }
    try {
      saveBgTaskRecords(projectPath, [...running, ...kept]);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), projectPath },
        'bg-tasks: failed to persist bg-tasks.json (in-memory registry unaffected)',
      );
    }
  }

  /** Test-only reset（mirror tool/registry __clearForTest——单测隔离模块单例状态）。 */
  __clearForTest(): void {
    for (const watchdog of this.watchdogs.values()) clearTimeout(watchdog);
    this.watchdogs.clear();
    this.records.clear();
    this.controllers.clear();
  }
}

const defaultBgTaskRegistry = new BgTaskRegistry();

export function getBgTaskRegistry(): BgTaskRegistry {
  return defaultBgTaskRegistry;
}

// ── 级联杀（design §2）：删 leader 会话 / 项目关闭 → 其后台子 agent 全部 abort ──

/** 删 leader 会话级联：abort 该会话名下全部 running 后台任务，返取消数（终态回写走 outcome 链）。 */
export function cancelBgTasksForParent(parentSessionId: string): number {
  const registry = getBgTaskRegistry();
  let cancelled = 0;
  for (const record of registry.listByParent(parentSessionId)) {
    if (registry.cancel(record.taskId).ok) cancelled++;
  }
  return cancelled;
}

/**
 * 删会话级联补面（CR-5）：被删会话可能本身是某后台任务的「子会话」（agent:delete-session 直指
 * child sid——UI 检视图删除入口）——按 childSessionId 匹配 cancel，防「删了子会话其后台 run 仍跑」。
 * listAll 全扫（记录量有界：running ≤ 3/项目 + 终态帽 10，线性扫无性能面）。
 */
export function cancelBgTasksForChildSession(childSessionId: string): number {
  const registry = getBgTaskRegistry();
  let cancelled = 0;
  for (const record of registry.listAll()) {
    if (record.childSessionId === childSessionId && registry.cancel(record.taskId).ok) cancelled++;
  }
  return cancelled;
}

/**
 * 项目关闭/删除级联：abort 该项目全部 running 后台任务，返取消数。生产挂接点在 shell 项目
 * 生命周期（W3 接线——agent 包无项目关闭钩子可挂，能力面先行 + 测试钉语义）。比较面归一
 * （CR-7：经 listByProject 的 normalizeProjectPathForCompare——shell 传大小写/分隔符漂移路径
 * 同样命中）。
 */
export function cancelBgTasksForProject(projectPath: string): number {
  const registry = getBgTaskRegistry();
  let cancelled = 0;
  for (const record of registry.listByProject(projectPath)) {
    if (registry.cancel(record.taskId).ok) cancelled++;
  }
  return cancelled;
}
