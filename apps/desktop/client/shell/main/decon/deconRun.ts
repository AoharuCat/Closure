import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DeconBudget, DeconCost, DeconJob, DeconProgressEvent, Material } from '@orison/shared-contracts';
import { getDeconJob, upsertDeconJob, upsertDeconPassState } from '../db/closure-decon';
import {
  DECON_CHARS_PER_TOKEN,
  accumulateDeconCost,
  wouldExceedDeconBudget,
} from './deconBudget';
import { transitionDeconJob } from './deconJob';
import { derivedRelPathForMaterial, getGlobalMaterialsRoot, getMaterialRow } from '../db/materialIndexer';
import { getProjectById } from '../db/projectRepository';
import type { DeconGenerateSlot, DeconGenerateText } from './deconLlmCore';

// ── E10.3a（task 09-05）W3/W4：拆解管线 pass 模块共用运行面 ──
//
// child A design「管线本体」清单外的实施细节文件：p1Dictionary / p1Extract（W5 的 p1Aggregate /
// p2Canon 同面可复用）共用的——派生 .md 读取、token 估算、job 运行门、pass 落库小助手。
// 不改 W2 已落地的 deconJob.ts 状态面（其私有 readDerivedTextFor / STALE_NOTE 不动——本文件
// 第四处 mirror，lineage 见 readDeconDerivedTextFor 注记）。
//
// 范式判据（parent design §9「全局」行）：本文件全部纯代码（fs 读 / 算数 / 状态查询），零语义判断。
//
// expected_downstream_consumers:
// - W3 p1Dictionary / W4 p1Extract（LLM 调用前预算估算 + 派生基面读取 + pass 落库）。
// - W5 p1Aggregate / p2Canon（同面复用）。
// - W6 deconIpc（runDeconPassSequence 在途注册 + cost 回写单源）+ materialIpc
//   （materials:delete 在途管线取消握手）。

// 在途管线注册表住叶子模块 deconInflight.ts（本文件与 deconJob 双向消费——住任一侧成环）；
// 此处 re-export 保消费面导入路径稳定。
export {
  cancelInflightDeconPipeline,
  isDeconPipelineInflight,
  registerInflightDeconPipeline,
  type DeconPipelineHandle,
} from './deconInflight';

/** 错误消息归一（mirror craftDistillPipeline errMsg——三处 lineage）。 */
export function deconErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 内容 sha256 指纹（`sha256:<64hex>`——deconJob.sha256Content 同式，第四处 mirror）。 */
export function sha256DeconContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/** stale 挂起 note（deconJob.STALE_NOTE 同文 mirror——W2 私有常量不动，W3+ 用本单源）。 */
export const DECON_STALE_NOTE = '材料双指纹失配（原件或派生 .md 已变更）——锚点整体漂移，须确认重跑';

function projectMaterialsRootDir(projectId: string): string | null {
  const record = getProjectById(projectId);
  const projectPath = record?.path;
  if (typeof projectPath !== 'string' || projectPath.length === 0) return null;
  return path.join(path.resolve(projectPath), 'materials');
}

/**
 * 派生 .md 读取（BOM strip + CRLF→LF 归一）。lineage：craftDistillPipeline.readDerivedTextForMaterial
 * → deconJob.readDerivedTextFor → 本函数（同式第四处 mirror——锚定基面归一单源，改归一逻辑四处同步）。
 * 测试经 deps.readDerivedText 注入绕过 fs（零文件依赖）。
 */
export function readDeconDerivedTextFor(material: Material): string | null {
  const derivedRel = derivedRelPathForMaterial(material);
  if (derivedRel === null) return null;
  const root =
    material.scope === 'global'
      ? getGlobalMaterialsRoot()
      : material.projectId !== null
        ? projectMaterialsRootDir(material.projectId)
        : null;
  if (root === null) return null;
  try {
    const raw = readFileSync(path.join(root, derivedRel), 'utf-8');
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return stripped.replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

// ── token 估算（预算门 / cost 累计两用——DECON_CHARS_PER_TOKEN 中文推测值单源）──

/**
 * LLM 调用**前**预算估算（wouldExceedDeconBudget 的 nextCallTokens）：输入按字符折算 + 输出按
 * maxTokens 上界（保守——宁早 cap 不漏烧）。与 actualDeconCallTokens 分离：估算用于门，实际用于记账。
 */
export function estimateDeconCallTokens(system: string | undefined, user: string, maxTokens: number): number {
  return Math.ceil(((system ?? '').length + user.length) / DECON_CHARS_PER_TOKEN) + maxTokens;
}

/** LLM 调用**后**实际记账估算（seam 不回 usage——按输入+输出字符折算，诚实近似）。 */
export function actualDeconCallTokens(system: string | undefined, user: string, outText: string): number {
  return Math.ceil(((system ?? '').length + user.length + outText.length) / DECON_CHARS_PER_TOKEN);
}

/** provider usage 透传面（seam 返回——CR-13：GenerationUsage 形状，缺省字段全可选）。 */
export interface DeconUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * 实际记账 tokens 解析（CR-13）：provider usage 有真值用真值（estimated=false）；缺失回退字符
 * 近似（estimated=true——cost_json 诚实标注近似笔）。usage.totalTokens 优先，否则
 * prompt+completion 合计（全缺回退近似）。
 */
export function resolveDeconActualTokens(
  system: string | undefined,
  user: string,
  outText: string,
  usage?: DeconUsageLike,
): { tokens: number; estimated: boolean } {
  const total =
    usage?.totalTokens ??
    (typeof usage?.promptTokens === 'number' && typeof usage?.completionTokens === 'number'
      ? usage.promptTokens + usage.completionTokens
      : undefined);
  if (typeof total === 'number' && total > 0) return { tokens: Math.round(total), estimated: false };
  return { tokens: actualDeconCallTokens(system, user, outText), estimated: true };
}

// ── cost 回写单源（CR-1：杀 `?? job` 复活路径——四处调用面共用）──

/** cost 回写中止哨兵：job 行已删（在途 delete/materials:delete 级联）——调用链静默退出不复活。 */
export class DeconJobGoneError extends Error {
  constructor(jobId: string) {
    super(`拆解会话 ${jobId} 已删除——cost 回写中止（不复活行）`);
    this.name = 'DeconJobGoneError';
  }
}

/**
 * cost 回写单源：**重读现值行**拍平写入（await 窗口内翻态不被旧快照复活）；行不存在（已删）
 * → 抛 DeconJobGoneError（runDeconPassSequence catch 静默退出）——**不做 upsert**（`?? job`
 * 兜底会把已删 job 整行复活，CR-1 红线）。
 */
export function writeDeconCost(jobId: string, fallbackJob: DeconJob, cost: DeconCost, updatedAt: string): void {
  const current = getDeconJob(jobId);
  if (current === null) throw new DeconJobGoneError(jobId);
  upsertDeconJob({ ...current, cost, updatedAt });
}

// ── job 运行门 + 边界判别（CR-7：paused/cancelled 显式三态）+ pass 落库小助手 ──

/** 运行门/边界停走判别（显式停因——runner 映射各自结果态，progress 事件如实报）。 */
export type DeconRunGateStop = 'paused' | 'cancelled' | 'stale' | 'not-found' | 'invalid-status';

export type DeconRunGate =
  | { ok: true; job: DeconJob }
  | { ok: false; stop: DeconRunGateStop; message: string };

/**
 * pass 执行面 job 门：存在 + running（start/resume 后获得）。停因显式判别（CR-7）：
 * - `paused`：用户暂停（映射 'paused' 结果——事件面不误报 failed）。
 * - `cancelled`：终态取消。
 * - `not-found`：job 已删（在途 delete 级联——映射 'cancelled' 静默停，不复活不转移）。
 * - `stale`：双指纹失配已被翻态。
 * - `invalid-status`：capped/failed/pending 等（须先 start/retry/调预算）。
 */
export function loadRunningDeconJob(jobId: string): DeconRunGate {
  const job = getDeconJob(jobId);
  if (job === null) return { ok: false, stop: 'not-found', message: `拆解会话 ${jobId} 不存在（或已删除）` };
  if (job.status === 'running') return { ok: true, job };
  if (job.status === 'paused') {
    return { ok: false, stop: 'paused', message: '会话已暂停——须先 start/resume 再执行 pass' };
  }
  if (job.status === 'cancelled') {
    return { ok: false, stop: 'cancelled', message: '会话已取消（终态）——重拆走新 job' };
  }
  if (job.status === 'stale') {
    return { ok: false, stop: 'stale', message: DECON_STALE_NOTE };
  }
  return {
    ok: false,
    stop: 'invalid-status',
    message: `会话状态 ${job.status} 非 running——pass 执行面须先 start/resume（capped 先调预算）`,
  };
}

/** 章域边界停走判别结果（各 runner 的中断韧性面——CR-7 如实映射）。 */
export type DeconBoundaryStop =
  | { status: 'paused' }
  | { status: 'cancelled' }
  | { status: 'stale'; message: string }
  | { status: 'failed'; message: string };

/**
 * 边界停走判别（章/域边界调用——job 状态被外部翻态即停）：
 * - null = running 照跑。
 * - paused / cancelled / stale：如实映射（旧实现一律误报 'paused'——CR-7 修正）。
 * - 行已删（在途 delete 级联）→ cancelled **静默停**（不转移不复活——转移会在已删行上报错）。
 * - 其余翻态（capped/failed/done 等）→ failed 如实停（状态已非 running，不再二次转移）。
 */
export function checkDeconRunBoundary(jobId: string): DeconBoundaryStop | null {
  const live = getDeconJob(jobId);
  if (live === null) return { status: 'cancelled' };
  if (live.status === 'running') return null;
  if (live.status === 'paused') return { status: 'paused' };
  if (live.status === 'cancelled') return { status: 'cancelled' };
  if (live.status === 'stale') return { status: 'stale', message: DECON_STALE_NOTE };
  return { status: 'failed', message: `会话状态被外部翻为 ${live.status}——pass 序列停止` };
}

/** pass 状态行写入（status/outputRef/outputHash 组装单源——调用方只给差异字段）。 */
export function writeDeconPassState(
  jobId: string,
  pass: string,
  unit: string,
  status: 'running' | 'done' | 'failed' | 'capped',
  output: { outputRef: string; outputHash: string } | null,
  updatedAt: string,
): void {
  upsertDeconPassState({
    jobId,
    pass,
    unit,
    status,
    outputRef: output === null ? null : output.outputRef,
    outputHash: output === null ? null : output.outputHash,
    updatedAt,
  });
}

/**
 * unit 失败落库（pass_state failed + job fail 转移——两写同面，W6/编排重入按 failed unit 重做）。
 * belt（CR-1）：job 行已删（在途 delete 竞态）→ 双写均跳过（不复活行/不留孤儿 pass_state）。
 */
export function failDeconUnit(jobId: string, pass: string, unit: string, message: string, updatedAt: string): void {
  if (getDeconJob(jobId) === null) return;
  writeDeconPassState(jobId, pass, unit, 'failed', null, updatedAt);
  transitionDeconJob(jobId, 'fail', message);
}

/** unit 预算挂起落库（pass_state capped + job cap 转移——诚实挂起家族纪律，不烧 token）。同上 belt。 */
export function capDeconUnit(jobId: string, pass: string, unit: string, note: string, updatedAt: string): void {
  if (getDeconJob(jobId) === null) return;
  writeDeconPassState(jobId, pass, unit, 'capped', null, updatedAt);
  transitionDeconJob(jobId, 'cap', note);
}

// ── C3（dogfood R3 修复批）：截断自动重试升帽的 per-pass LLM 调用脚手架 ──
//
// 缝位裁决：不放 deconLlmCore 统一缝（会绕 wouldExceedDeconBudget 预算门且少记 actual——
// CR-13 记账纪律）；per-pass 调用脚手架收口「预算门 → 调用 → 记账 → length 判定 → 升帽重试
// 一次 → 仍截断交调用方按本 pass 语义挂起」。thinking 配置零改动（用户主权，task-models.yaml）。

/** 升帽倍率（截断重试 attempt 的 maxTokens = 首发帽 × 此值；推测值起步，dogfood 标定）。 */
export const DECON_LLM_RETRY_ESCALATE = 2;

export interface RunDeconLlmCallInput {
  jobId: string;
  pass: string;
  unit: string;
  slot: DeconGenerateSlot;
  system?: string;
  user: string;
  maxTokens: number;
  budget: DeconBudget;
  cost: DeconCost;
  /** writeDeconCost 的 fallback job（重读现值行单源——行已删抛 DeconJobGoneError 沿调用链上抛）。 */
  job: DeconJob;
  generate: DeconGenerateText;
  /** 重试相位 UI 可见（F13——走既有 note 软提示面；缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
  nowIso: () => string;
  /** note 组装语境前缀（如「p1b 第 2 章提取」「p4:jiegou arc:0 问题单」）。 */
  label: string;
}

/**
 * 单次 LLM 调用结果：ok = 文本 + 累计后的 cost；!ok = 调用方按 kind 落对应挂起态
 * （budget-capped → capDeconUnit；length → 本 pass 语义 capped/failed；error/empty → failed，
 * p6 的 empty 例外走候选丢弃不挂 pass）。每次 attempt 独立过预算门（按当次帽）且 actual
 * 各记各的（CR-13——重试不绕门不少记）。
 */
export type DeconLlmCallResult =
  | { ok: true; text: string; cost: DeconCost }
  | { ok: false; kind: 'budget-capped' | 'length' | 'error' | 'empty'; note: string; cost: DeconCost };

/**
 * LLM 调用脚手架（C3）：est 预算门（按当次帽）→ 调用 → actual 记账（provider usage 真值
 * 优先 + writeDeconCost 单源落行）→ finishReason='length' 判定（CR-2 权威停因）→ 升帽 ×2
 * 重试一次（重试 est 同样过门、actual 各记各的、notify note 相位可见）→ 仍截断返回
 * kind='length' 交调用方裁决（capped/failed 语义是 per-pass 的，本函数不替调用方落状态）。
 */
export async function runDeconLlmCall(input: RunDeconLlmCallInput): Promise<DeconLlmCallResult> {
  let cost = input.cost;
  let cap = input.maxTokens;
  for (let attempt = 0; ; attempt++) {
    const est = estimateDeconCallTokens(input.system, input.user, cap);
    if (wouldExceedDeconBudget(input.budget, cost, input.pass, est)) {
      return {
        ok: false,
        kind: 'budget-capped',
        note:
          attempt === 0
            ? `${input.label}预算超限（本次预估 ${est} tokens，已累计 ${cost.totalTokens}）——已诚实挂起（不烧 token），调整预算后续跑`
            : `${input.label}输出截断后升帽重试预算超限（重试预估 ${est} tokens，已累计 ${cost.totalTokens}）——已诚实挂起（不烧 token），调整预算后续跑`,
        cost,
      };
    }
    let text = '';
    let finishReason: string | undefined;
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    try {
      const response = await input.generate({ slot: input.slot, system: input.system, user: input.user, maxTokens: cap });
      text = (response?.text ?? '').trim();
      finishReason = response?.finishReason;
      usage = response?.usage;
    } catch (err) {
      return { ok: false, kind: 'error', note: `${input.label}调用失败：${deconErrMsg(err)}`, cost };
    }
    // 实际记账（调用已发生——provider usage 真值优先 CR-13）并落 job 行——writeDeconCost 单源
    // 重读现值行（await 窗口翻态不被旧快照复活；行已删抛 DeconJobGoneError 由编排层静默中止）。
    const actual = resolveDeconActualTokens(input.system, input.user, text, usage);
    cost = accumulateDeconCost(cost, input.pass, actual.tokens, 1, actual.estimated);
    writeDeconCost(input.jobId, input.job, cost, input.nowIso());
    if (finishReason === 'length') {
      if (attempt === 0) {
        // 升帽重试一次（每 attempt 过门 + 各记各的）；相位可见走 note 软提示面（CR-10）。
        const escalated = input.maxTokens * DECON_LLM_RETRY_ESCALATE;
        input.notify?.({
          jobId: input.jobId,
          status: 'running',
          pass: input.pass,
          unit: input.unit,
          note: `${input.label}输出因 token 上限截断，升帽重试 1/1（输出上限 ${cap} → ${escalated}）`,
        });
        cap = escalated;
        continue;
      }
      return {
        ok: false,
        kind: 'length',
        note: `${input.label}输出因 token 上限截断（finishReason=length，已升帽重试一次仍截断）`,
        cost,
      };
    }
    if (!text) return { ok: false, kind: 'empty', note: `${input.label}返回空回复——已挂起`, cost };
    return { ok: true, text, cost };
  }
}

// ── C4-F12（dogfood R3 修复批）：材料读点有限重试 ──
//
// 竞态：deconStart 的后台管线读材料行 × 并行在途的 materials:reingest / watcher register
// 的中间已提交行态（相 A upsert 零章中间行 → 相 B reindex 事务回填真值，分钟级 embed 窗口）。
// 读侧有限重试等收敛；真删除 / 终局零章（ready/low-confidence）仍诚实失败。

/** 重试轮询间隔（~1s；推测值——覆盖 reingest 相 A→B 的典型收敛窗口）。 */
export const DECON_MATERIAL_LOAD_RETRY_INTERVAL_MS = 1_000;
/** 重试次数（~1s × 10 = 最长约 10s 等待窗口）。 */
export const DECON_MATERIAL_LOAD_RETRY_ATTEMPTS = 10;

/**
 * durable failed 快败阈值（CR-5）：status='failed' 且零章的行快照（指纹+章数+状态）连续
 * 此数探针一致 → 提前诚实失败。'pending' 不适用（重登记真在途，快照会动——仍走全窗口）。
 */
export const DECON_MATERIAL_FAILED_STREAK = 3;

/** 中间态（注册/重索引在途——行可能被相 B 回填）——行在而零章时重试等待收敛。 */
const DECON_MATERIAL_TRANSIENT_STATUSES: ReadonlySet<string> = new Set(['pending', 'failed']);

export interface DeconMaterialLoadDeps {
  getMaterialRow?: (materialId: string) => Material | null;
  waitMs?: (ms: number) => Promise<void>;
  intervalMs?: number;
  attempts?: number;
}

/**
 * 可提取材料读取（C4-F12）：行在且 ≥1 章 → ok；行缺 / 中间态（pending/failed）零章 → 有限
 * 重试窗口（默认 ~1s×10）；终局零章（ready/low-confidence——需人工校对或重摄取）与真删除
 * → 诚实失败。durable failed 快败（CR-5）：status='failed' 且零章且行快照（contentHash+
 * 章数+状态）连续 {@link DECON_MATERIAL_FAILED_STREAK} 次相同 → 提前诚实失败（摄取已失败且
 * 无变化，重登记不在途——省每 pass ~10s×每重试白等）；'pending' 仍走全窗口。纯读面零写库
 * （失败落态归调用方——材料级前置失败只 transitionDeconJob，不写 (pass,'all',failed) 化石
 * 行，F16 写侧）。
 */
export async function loadExtractableMaterial(
  materialId: string,
  deps: DeconMaterialLoadDeps = {},
): Promise<{ ok: true; material: Material } | { ok: false; message: string }> {
  const readRow = deps.getMaterialRow ?? getMaterialRow;
  const wait = deps.waitMs ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const interval = deps.intervalMs ?? DECON_MATERIAL_LOAD_RETRY_INTERVAL_MS;
  const attempts = deps.attempts ?? DECON_MATERIAL_LOAD_RETRY_ATTEMPTS;
  let failedStreakSig: string | null = null;
  let failedStreak = 0;
  for (let i = 0; i < attempts; i++) {
    const material = readRow(materialId);
    if (material !== null && material.chapters.length > 0) return { ok: true, material };
    if (material !== null && !DECON_MATERIAL_TRANSIENT_STATUSES.has(material.status)) {
      return {
        ok: false,
        message: `材料 ${material.name}（${materialId}）状态 ${material.status} 且零章——无可提取章，请先重摄取或人工校对章界`,
      };
    }
    if (material !== null && material.status === 'failed') {
      const sig = `${material.contentHash}|${material.chapters.length}|${material.status}`;
      if (sig === failedStreakSig) {
        failedStreak += 1;
        if (failedStreak >= DECON_MATERIAL_FAILED_STREAK) {
          return {
            ok: false,
            message: `材料 ${material.name}（${materialId}）摄取已失败且无变化（连续 ${failedStreak} 次探针快照一致）——请先重摄取或人工校对章界后再拆解`,
          };
        }
      } else {
        failedStreakSig = sig;
        failedStreak = 1;
      }
    }
    // 行缺（在途重登记窗口）或中间态零章——轮询等待收敛（末次不再等）。
    if (i < attempts - 1) await wait(interval);
  }
  // 终读复查（CR-3）：收敛恰落在末次探针与终读之间时按新行态如实返回，不假报「仍为空」。
  const final = readRow(materialId);
  if (final !== null && final.chapters.length > 0) return { ok: true, material: final };
  if (final === null) return { ok: false, message: `材料 ${materialId} 不存在（或已删除）——无可提取基面` };
  return {
    ok: false,
    message: `材料 ${final.name}（${materialId}）重试 ${attempts} 次后章列表仍为空（摄取/重索引未收敛）——请稍后重试或人工校对章界`,
  };
}
