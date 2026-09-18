import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  DeconBudget,
  DeconCanonEntry,
  DeconCost,
  DeconDictionary,
  DeconEntity,
  DeconFacts,
  DeconJob,
  DeconJobStatus,
  DeconP1Inheritance,
  DeconPassState,
  DeconTier,
} from '@orison/shared-contracts';
import { DECON_PASS_UNIT_ALL, deconMaterialRef } from '@orison/shared-contracts';
import { getProjectById } from '../db/projectRepository';
import {
  derivedRelPathForMaterial,
  getGlobalMaterialsRoot,
  getMaterialRow,
} from '../db/materialIndexer';
import {
  deleteDeconIllegalAllFailedPassStates,
  findInflightDeconJobByMaterial,
  getDeconDictionary,
  getDeconJob,
  listDeconChapterFacts,
  listDeconEntities,
  resetDeconRerunState,
  updateDeconJobBudget,
  updateDeconJobStatus,
  upsertDeconJob,
  upsertDeconPassState,
} from '../db/closure-decon';
import { getDb } from '../db/index';
import { getLogger } from '../logger';
import { isDeconPipelineInflight } from './deconInflight';
import { validateDeconDimensions } from './deconBudget';

// ── E10.3a（task 09-05）W2：拆解 job 状态机 + 断点重入底座（parent design §2.1/§4）──
//
// 职责（纯状态机 + 薄编排，范式判据「全局」行——断点/预算/指纹全纯代码）：
// - **转移矩阵**：start/pause/retry/cap/fail/finish/stale/cancel/confirm-rerun（纯函数
//   applyDeconJobTransition——db 编排面薄包）。
// - **done→start 幂等 no-op**（F-11）：返回既有结果不重跑；running→start 同 no-op。
// - **同材料在途守卫**（F-11，10.2 inflightDistills 先例）：并发 create 拒绝并指向在途 job。
// - **双指纹 stale 门控**（F-02）：create 时快照 material_content_hash + derived_hash；
//   start 重入时对 closure_material 现值 + 派生 .md 现值校验——失配 → job=stale（不静默
//   沿用漂移锚点，用户 confirm-rerun 后重跑）。
// - **断点重入**（台账式幂等）：pass_state done 且 output_hash 与产物现值一致 → 跳过
//   （decideDeconPassReentry——W3+ 管线每 unit 调用，不重付 LLM）。
// - **P1 材料级继承**（F-07）：create 时同指纹三表产物存在 → 预标 P1 pass done（零重算）。
//
// expected_downstream_consumers:
// - W3-W5 管线编排（decideDeconPassReentry + applyDeconJobTransition + pass_state 同事务写）。
// - W6 deconIpc（create/start/pause/cancel/get/list 通道的执行面）。
// - materials:delete 级联用 db/closure-decon.ts 的 deleteDeconProductsByMaterial（**不经本文件**
//   ——本文件在 materialIndexer 链上，db 级联不得反向进此层）。

// ── 转移矩阵（纯函数面）──

/** job 状态机动作（W2 dispatch 契约：start/pause/retry/capped/stale/cancel）。 */
export const DECON_JOB_ACTIONS = [
  'start',
  'pause',
  'retry',
  'cap',
  'fail',
  'finish',
  'stale',
  'cancel',
  'confirm-rerun',
] as const;
export type DeconJobAction = (typeof DECON_JOB_ACTIONS)[number];

/**
 * 转移矩阵（枚举面权威）：
 * - `start`：pending/paused → running（resume 续跑）。
 * - `retry`：failed/capped → running（调预算后 capped 续跑 / 失败重试）。
 * - `pause`：running → paused（优雅中断——state 行保留）。
 * - `cap`：running → capped（预算超限诚实挂起，不静默截断）。
 * - `fail`/`finish`：running → 终态。
 * - `stale`：非终态 + done → stale（F-02 双指纹失配——done 的产物锚定旧基面同样不可沿用）。
 * - `cancel`：pending/running/paused/capped → cancelled（终态；重拆走新 job）。
 * - `confirm-rerun`：stale → pending（用户确认——刷新双指纹为现值后重跑）。
 * done/running × start 的幂等 no-op 不在矩阵内（见 startDeconJob 特判——非转移，无副作用）。
 */
export const DECON_JOB_TRANSITIONS: Readonly<
  Record<DeconJobAction, { from: readonly DeconJobStatus[]; to: DeconJobStatus }>
> = {
  start: { from: ['pending', 'paused'], to: 'running' },
  retry: { from: ['failed', 'capped'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  cap: { from: ['running'], to: 'capped' },
  fail: { from: ['running'], to: 'failed' },
  finish: { from: ['running'], to: 'done' },
  stale: { from: ['pending', 'running', 'paused', 'capped', 'done'], to: 'stale' },
  cancel: { from: ['pending', 'running', 'paused', 'capped'], to: 'cancelled' },
  'confirm-rerun': { from: ['stale'], to: 'pending' },
};

export type DeconTransitionResult =
  | { ok: true; status: DeconJobStatus }
  | { ok: false; error: 'invalid-transition'; from: DeconJobStatus; action: DeconJobAction };

/** 纯转移判定（零 IO——转移矩阵查表）。 */
export function applyDeconJobTransition(from: DeconJobStatus, action: DeconJobAction): DeconTransitionResult {
  const rule = DECON_JOB_TRANSITIONS[action];
  if (rule.from.includes(from)) return { ok: true, status: rule.to };
  return { ok: false, error: 'invalid-transition', from, action };
}

// ── 双指纹校验（F-02——纯函数面 + IO 读取面）──

/** 材料双指纹现值（contentHash = closure_material 现行 content_hash；derivedHash = 派生 .md 现值 hash）。 */
export interface DeconFingerprintPair {
  materialContentHash: string;
  derivedHash: string;
}

/** 双指纹失配判定（纯函数——任一不等即失配：原件重摄取或派生校对均触发 stale）。 */
export function deconFingerprintMismatch(
  job: Pick<DeconJob, 'materialContentHash' | 'derivedHash'>,
  current: DeconFingerprintPair,
): boolean {
  return job.materialContentHash !== current.materialContentHash || job.derivedHash !== current.derivedHash;
}

function sha256Content(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

function projectMaterialsRootDir(projectId: string): string | null {
  const record = getProjectById(projectId);
  const projectPath = record?.path;
  if (typeof projectPath !== 'string' || projectPath.length === 0) return null;
  return path.join(path.resolve(projectPath), 'materials');
}

// 派生 .md 文本读取归一面在 deconRun.readDeconDerivedTextFor（W3+ 单源——本文件指纹缓存
// 自带同式归一，改归一逻辑四处同步注记见彼处）。

// ── 派生 .md 指纹驱逐缓存（CR-9：decon:get 轮询兜底的热点下压）──
//
// freshness 校验每次读派生 .md 全文 + sha256——多 MB 材料在 UI 轮询下成主进程热点。stat
// 快路（path + mtime + size 命中 → 复用 hash，零读零 hash；mirror 10.1 材料车道 mtime 快路
// 先例）。上限驱逐：超限整清（简单 LRU 近似——活跃材料集小）。

const DERIVED_HASH_CACHE_LIMIT = 32;
const derivedHashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

function readDerivedHashCached(absPath: string): string | null {
  let stats: { mtimeMs: number; size: number };
  try {
    const st = statSync(absPath);
    stats = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    derivedHashCache.delete(absPath);
    return null;
  }
  const cached = derivedHashCache.get(absPath);
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.hash;
  }
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const hash = sha256Content(stripped.replace(/\r\n?/g, '\n'));
  if (derivedHashCache.size >= DERIVED_HASH_CACHE_LIMIT) derivedHashCache.clear();
  derivedHashCache.set(absPath, { ...stats, hash });
  return hash;
}

/**
 * 读材料双指纹现值（IO 面——closure_material 登记行 + 派生 .md 现值；派生 hash 走 stat 快路
 * 缓存）。材料无登记或派生不可读 → null（调用方按 not-found/derived-unreadable 拒绝）。
 */
export function readDeconCurrentFingerprints(materialId: string): DeconFingerprintPair | null {
  const material = getMaterialRow(materialId);
  if (material === null) return null;
  const derivedRel = derivedRelPathForMaterial(material);
  if (derivedRel === null) return null;
  const root =
    material.scope === 'global'
      ? getGlobalMaterialsRoot()
      : material.projectId !== null
        ? projectMaterialsRootDir(material.projectId)
        : null;
  if (root === null) return null;
  const derivedHash = readDerivedHashCached(path.join(root, derivedRel));
  if (derivedHash === null) return null;
  return { materialContentHash: material.contentHash, derivedHash };
}

// ── 产物 hash 单源（W3+ 管线写 output_hash 时必须用本组——继承校验与重入跳过同基）──

/** 词典产物 hash（entries 契约形状序列化单源）。 */
export function hashDeconDictionaryOutput(dict: DeconDictionary): string {
  return sha256Content(JSON.stringify(dict.entries));
}

/** 逐章 facts 产物 hash（单章 facts 契约形状——p1b unit 粒度）。 */
export function hashDeconFactsOutput(facts: DeconFacts): string {
  return sha256Content(JSON.stringify(facts));
}

/** 聚合实体产物 hash（全组实体按 canonical_name 序——p1c 单行 unit 粒度）。 */
export function hashDeconEntitiesOutput(entities: readonly DeconEntity[]): string {
  const ordered = [...entities].sort((a, b) => (a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0));
  return sha256Content(JSON.stringify(ordered.map((e) => ({ name: e.canonicalName, type: e.type, aliases: e.aliases }))));
}

/** canon 域产物 hash（条目按 name 序——p2 unit=domain 粒度；W5 p2Canon 落库/重入校验单源）。 */
export function hashDeconCanonOutput(entries: readonly DeconCanonEntry[]): string {
  const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Content(JSON.stringify(ordered.map((e) => ({ name: e.name, payload: e.payload, anchors: e.anchors }))));
}

// ── 断点重入判定（纯函数——W3+ 每 unit 调用）──

export type DeconPassReentryDecision = 'skip' | 'rerun' | 'capped-hold';

/**
 * pass×unit 断点重入判定（台账式幂等）：
 * - 无状态行（首次）→ rerun。
 * - `done` + output_hash 与产物现值一致 → **skip**（不重付 LLM——AC8 断点生效的判定面）。
 * - `done` + 产物现值漂移（hash 不一致/产物缺失）→ rerun（stale 产物不静默沿用）。
 * - `capped` → **capped-hold**（保留挂起态等预算调整后续跑——不静默截断）。
 * - pending/running（崩溃残留）/failed → rerun（幂等重入重做该 unit）。
 */
export function decideDeconPassReentry(
  state: DeconPassState | null,
  currentOutputHash: string | null,
): DeconPassReentryDecision {
  if (state === null) return 'rerun';
  if (state.status === 'capped') return 'capped-hold';
  if (state.status === 'done') {
    return currentOutputHash !== null && state.outputHash === currentOutputHash ? 'skip' : 'rerun';
  }
  return 'rerun';
}

// ── 编排面（db 读写——sync 纪律）──

/** 测试缝：指纹读取/时钟注入（生产读 closure_material + 派生 .md；测试零 fs/db-material 依赖）。 */
export interface DeconJobDeps {
  readCurrentFingerprints?: (materialId: string) => DeconFingerprintPair | null;
  now?: () => Date;
}

const STALE_NOTE = '材料双指纹失配（原件或派生 .md 已变更）——锚点整体漂移，须确认重跑';

export type DeconJobCreateResult =
  | { ok: true; job: DeconJob; inheritedP1: DeconP1Inheritance }
  | {
      ok: false;
      error: 'material-not-found' | 'material-not-ready' | 'derived-unreadable' | 'inflight-exists' | 'invalid-dimensions';
      inflightJobId?: string;
      message: string;
    };

function emptyCost(): DeconCost {
  // estimated: true——空 cost 无 usage 真值，预估对照面按近似起步（首笔 usage 后刷新）。
  return { totalTokens: 0, calls: 0, byPass: {}, estimated: true };
}

function newJobId(): string {
  return `decon-${randomBytes(6).toString('hex')}`;
}

function passState(jobId: string, pass: string, unit: string, outputRef: string, outputHash: string, updatedAt: string): DeconPassState {
  return { jobId, pass, unit, status: 'done', outputRef, outputHash, updatedAt };
}

/**
 * 创建拆解会话（P0 落库）：
 * 1. 材料就绪门（F-12）：仅 status='ready' 且 ≥1 章可拆——low-confidence/零章材料拒绝并提示
 *    先重摄取或校对（单伪章拆书无意义）。
 * 2. 在途守卫（F-11）：同材料 pending/running/paused/capped job 存在 → 拒绝并返回在途 job id。
 * 3. 双指纹快照（F-02）：现值落 job 行（stale 门控基准）。
 * 4. P1 材料级继承（F-07）：同指纹三表产物存在 → 预标对应 pass_state done（AC12 零重算机制面）。
 */
export function createDeconJob(
  input: { materialId: string; tier: DeconTier; dimensions?: string[]; budget?: DeconBudget },
  deps: DeconJobDeps = {},
): DeconJobCreateResult {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const dimensions = input.dimensions ?? [];

  const dimError = validateDeconDimensions(input.tier, dimensions);
  if (dimError !== null) return { ok: false, error: 'invalid-dimensions', message: dimError };

  const material = getMaterialRow(input.materialId);
  if (material === null) {
    return { ok: false, error: 'material-not-found', message: `材料 ${input.materialId} 不存在（或已删除）` };
  }
  if (material.status !== 'ready' || material.chapters.length === 0) {
    return {
      ok: false,
      error: 'material-not-ready',
      message: `材料 ${material.name} 状态 ${material.status}、章数 ${material.chapters.length}——low-confidence/零章材料不可拆解，请先重摄取或人工校对章界`,
    };
  }

  const inflight = findInflightDeconJobByMaterial(input.materialId);
  if (inflight !== null) {
    return {
      ok: false,
      error: 'inflight-exists',
      inflightJobId: inflight.jobId,
      message: `同材料已有在途拆解会话 ${inflight.jobId}（状态 ${inflight.status}）`,
    };
  }

  const readFingerprints = deps.readCurrentFingerprints ?? readDeconCurrentFingerprints;
  const fingerprints = readFingerprints(input.materialId);
  if (fingerprints === null) {
    return {
      ok: false,
      error: 'derived-unreadable',
      message: '材料派生 .md 不可读（或登记行损坏）——无法锚定拆解基面',
    };
  }

  const materialRef = deconMaterialRef(material);
  const job: DeconJob = {
    jobId: newJobId(),
    materialRef,
    tier: input.tier,
    dimensions,
    status: 'pending',
    budget: input.budget ?? { totalTokens: null, perPass: {} },
    cost: emptyCost(),
    materialContentHash: fingerprints.materialContentHash,
    derivedHash: fingerprints.derivedHash,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  upsertDeconJob(job);

  // P1 继承（F-07）：同指纹三表产物 → 预标 pass done。**per-pass 旗标**（CR-17：部分继承合法
  // ——仅词典在时 p1b 不打折；p1b 旗标 = facts 章齐全才算继承，部分章继承不折扣预估——保守）。
  const inheritedP1: DeconP1Inheritance = { p1a: false, p1b: false, p1c: false };
  const dictionary = getDeconDictionary(materialRef, fingerprints.derivedHash);
  if (dictionary !== null) {
    upsertDeconPassState(
      passState(job.jobId, 'p1a', DECON_PASS_UNIT_ALL, 'dictionary:all', hashDeconDictionaryOutput(dictionary), now),
    );
    inheritedP1.p1a = true;
  }
  const factsRows = listDeconChapterFacts(materialRef, fingerprints.derivedHash);
  for (const row of factsRows) {
    upsertDeconPassState(passState(job.jobId, 'p1b', String(row.chapterIndex), `facts:${row.chapterIndex}`, hashDeconFactsOutput(row.facts), now));
  }
  if (factsRows.length >= material.chapters.length && material.chapters.length > 0) inheritedP1.p1b = true;
  const entities = listDeconEntities(materialRef, fingerprints.derivedHash);
  if (entities.length > 0) {
    upsertDeconPassState(
      passState(job.jobId, 'p1c', DECON_PASS_UNIT_ALL, 'entity:all', hashDeconEntitiesOutput(entities), now),
    );
    inheritedP1.p1c = true;
  }

  return { ok: true, job, inheritedP1 };
}

export type DeconJobStartResult =
  | { ok: true; job: DeconJob; noop: boolean }
  | { ok: false; error: 'not-found' | 'stale-fingerprints' | 'invalid-state'; job?: DeconJob; message: string };

/**
 * 启动/续跑拆解会话（CR-1 重构——在途竞态族防线）：
 * - **running × 在途管线（注册表有项）→ 幂等 no-op**：后台管线是权威，不重派（防双管线并发
 *   重复烧 LLM）；budget 参数此时忽略（不改活管线的预算）。
 * - **running × 无在途（假 running——kill/崩溃/异常吞掉的残留旗标）→ 对账翻 paused 后按
 *   paused 路径续跑**（AC2 的 IPC 路径：断点续跑不依赖进程存活）。启动期批量对账 =
 *   reconcileStaleDeconJobsOnStartup（进程重启时注册表恒空）。
 * - **双指纹门控**（F-02「重入时校验」）：其余路径先对现值校验——失配 → job=stale + 拒绝
 *   （含 done：**done→start 的幂等 no-op 也在指纹门内**——材料已变更时返回旧结果即静默沿用
 *   漂移锚点，违反 F-02；指纹一致才 no-op 返回既有结果，F-11 两全）。
 * - **budget（CR-1）**：状态判定**之后**、转移之前落（updateDeconJobBudget 窄 UPDATE——只对
 *   非 running 态生效，不整行重写不覆写活 cost/不复活已删行）。capped-hold 调预算重入面。
 * - pending/paused → start；failed/capped → retry；stale/cancelled → invalid-state（前者须
 *   confirm-rerun，后者重拆走新 job）。
 * pass 实际执行归 W3+ 管线（本函数只做状态面转移；管线派发在 deconIpc）。
 */
export function startDeconJob(jobId: string, deps: DeconJobDeps = {}, budget?: DeconBudget): DeconJobStartResult {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let job = getDeconJob(jobId);
  if (job === null) return { ok: false, error: 'not-found', message: `拆解会话 ${jobId} 不存在` };

  if (job.status === 'running') {
    if (isDeconPipelineInflight(jobId)) {
      return { ok: true, job, noop: true };
    }
    // 假 running（崩溃残留——注册表无项）→ 对账翻 paused 转 resumable 路径。
    updateDeconJobStatus(job.jobId, 'paused', null, now);
    job = { ...job, status: 'paused', error: null, updatedAt: now };
  }

  const readFingerprints = deps.readCurrentFingerprints ?? readDeconCurrentFingerprints;
  const current = readFingerprints(extractMaterialId(job.materialRef));
  if (current === null) {
    return { ok: false, error: 'not-found', job, message: '材料已不存在（或派生不可读）——无法校验双指纹' };
  }
  if (deconFingerprintMismatch(job, current)) {
    updateDeconJobStatus(job.jobId, 'stale', STALE_NOTE, now);
    return {
      ok: false,
      error: 'stale-fingerprints',
      job: { ...job, status: 'stale', error: STALE_NOTE, updatedAt: now },
      message: STALE_NOTE,
    };
  }

  if (job.status === 'done') {
    return { ok: true, job, noop: true };
  }

  // budget 只对非 running 态写（此处恒非 running——running 已在上面分流）。
  if (budget !== undefined) updateDeconJobBudget(job.jobId, budget, now);

  const action: DeconJobAction = job.status === 'failed' || job.status === 'capped' ? 'retry' : 'start';
  const decision = applyDeconJobTransition(job.status, action);
  if (!decision.ok) {
    return { ok: false, error: 'invalid-state', job, message: `状态 ${job.status} 不允许 ${action}` };
  }
  updateDeconJobStatus(job.jobId, decision.status, null, now);
  if (action === 'retry') {
    // F16 清理侧：retry 续跑时收口 (pass,'all','failed') 化石行（多 unit pass 的非法形态——
    // 见 db 侧谓词注释）。best-effort：清理失败不阻续跑（化石只影响 UI 聚合观感，重入语义不受）。
    try {
      deleteDeconIllegalAllFailedPassStates(job.jobId);
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), jobId: job.jobId },
        'decon: illegal (pass,all,failed) pass_state cleanup failed on retry (resume continues)',
      );
    }
  }
  return { ok: true, job: { ...job, status: decision.status, error: null, updatedAt: now }, noop: false };
}

/**
 * 启动期对账（CR-1）：kill/崩溃残留的 status='running' job → paused（可续跑态——pass_state
 * 台账在，startDeconJob 即重入）。进程重启时在途注册表恒空，running 必为残留。mirror
 * reconcileStaleProjectRuns（D4）先例。返回对账行数。
 */
export function reconcileStaleDeconJobsOnStartup(): number {
  const result = getDb()
    .prepare("UPDATE closure_decon_job SET status='paused', error=NULL, updated_at=datetime('now') WHERE status='running'")
    .run();
  return result.changes;
}

export type DeconJobTransitionDbResult =
  | { ok: true; job: DeconJob }
  | { ok: false; error: 'not-found' | 'invalid-transition'; job?: DeconJob; message: string };

/** 通用转移编排（pause/cap/fail/finish/cancel——薄包纯转移 + 落库；start/retry/confirm 走专用函数）。 */
export function transitionDeconJob(jobId: string, action: DeconJobAction, note?: string, deps: DeconJobDeps = {}): DeconJobTransitionDbResult {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const job = getDeconJob(jobId);
  if (job === null) return { ok: false, error: 'not-found', message: `拆解会话 ${jobId} 不存在` };
  const decision = applyDeconJobTransition(job.status, action);
  if (!decision.ok) {
    return { ok: false, error: 'invalid-transition', job, message: `状态 ${job.status} 不允许 ${action}` };
  }
  const error = decision.status === 'capped' || decision.status === 'failed' ? (note ?? null) : null;
  updateDeconJobStatus(job.jobId, decision.status, error, now);
  return { ok: true, job: { ...job, status: decision.status, error, updatedAt: now } };
}

export type DeconConfirmRerunResult =
  | { ok: true; job: DeconJob }
  | { ok: false; error: 'not-found' | 'invalid-state' | 'material-not-found'; job?: DeconJob; message: string };

/**
 * stale 确认重跑（F-02 的用户确认面）：刷新双指纹为**现值** + status → pending（startDeconJob
 * 再启动）。**CR-5 + E10.3b M2**：同时复位 p2+ 的 pass_state 行 + canon 行 + **B 两产物表**
 * （product/report——旧指纹 findings/报告不滞留 UI）+ 闸门行 approved → pending（不清则旧
 * canon hash 照样匹配 → 六域 skip → 旧材料锚点的 canon 终态 done 脏路径；材料级 P1 行由新
 * derived_hash 键控自然重算——resetDeconRerunState 单事务；off 闸门常设配置保留）。材料已删
 * → material-not-found（该 job 只剩 delete 出路）。
 */
export function confirmDeconRerun(jobId: string, deps: DeconJobDeps = {}): DeconConfirmRerunResult {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const job = getDeconJob(jobId);
  if (job === null) return { ok: false, error: 'not-found', message: `拆解会话 ${jobId} 不存在` };
  const decision = applyDeconJobTransition(job.status, 'confirm-rerun');
  if (!decision.ok) {
    return { ok: false, error: 'invalid-state', job, message: `状态 ${job.status} 不允许确认重跑（仅 stale 态）` };
  }
  const readFingerprints = deps.readCurrentFingerprints ?? readDeconCurrentFingerprints;
  const current = readFingerprints(extractMaterialId(job.materialRef));
  if (current === null) {
    return { ok: false, error: 'material-not-found', job, message: '材料已不存在——确认重跑无基面，请删除本会话' };
  }
  const refreshed: DeconJob = {
    ...job,
    status: 'pending',
    materialContentHash: current.materialContentHash,
    derivedHash: current.derivedHash,
    error: null,
    updatedAt: now,
  };
  upsertDeconJob(refreshed);
  resetDeconRerunState(jobId, now);
  return { ok: true, job: refreshed };
}

// ── 读侧 freshness 校验（产物读取面共用——W5/P2 产物消费前调）──

/** freshness 判别结果（CR-9：fresh=false 带原因——stale〔双指纹失配〕/ cancelled〔终态〕）。 */
export type DeconFreshnessCheck = { fresh: true } | { fresh: false; reason: 'stale' | 'cancelled' };

/**
 * 读侧双指纹校验（F-02「重入/产物读取时」的读取半边）：失配 → job 落 stale 并返回
 * `{fresh: false, reason: 'stale'}`；cancelled 终态产物面同样不供给（reason: 'cancelled'——
 * CR-9 对齐契约注释）。产物读取方（canon/facts 消费、IPC get）先调本函数——stale 产物不
 * 静默供给下游。材料已删/派生不可读按 stale 语义（无法证明锚点仍有效）。
 */
export function checkDeconJobFreshness(job: DeconJob, deps: DeconJobDeps = {}): DeconFreshnessCheck {
  if (job.status === 'cancelled') return { fresh: false, reason: 'cancelled' };
  if (job.status === 'stale') return { fresh: false, reason: 'stale' };
  const readFingerprints = deps.readCurrentFingerprints ?? readDeconCurrentFingerprints;
  const current = readFingerprints(extractMaterialId(job.materialRef));
  if (current === null) return { fresh: false, reason: 'stale' };
  if (!deconFingerprintMismatch(job, current)) return { fresh: true };
  const now = (deps.now ?? (() => new Date()))().toISOString();
  updateDeconJobStatus(job.jobId, 'stale', STALE_NOTE, now);
  return { fresh: false, reason: 'stale' };
}

/** material_ref → materialId（尾缀 16 字符——与 repository 级联谓词同基）。 */
export function extractMaterialId(materialRef: string): string {
  return materialRef.slice(-16);
}
