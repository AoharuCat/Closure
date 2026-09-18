import { ipcMain } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  DeconApproveReviewResult,
  DeconBudget,
  DeconConfirmRerunResult,
  DeconDeleteResult,
  DeconEntityIpc,
  DeconEstimateIpc,
  DeconExportStyleResult,
  DeconJob,
  DeconJobDetail,
  DeconProductsResult,
  DeconProgressEvent,
  DeconReportKind,
  DeconReportsResult,
  DeconReviewCheckpoint,
  DeconReviewRow,
  DeconTransitionResult,
  Material,
} from '@orison/shared-contracts';
import {
  DECON_REPORT_KINDS,
  DECON_REVIEW_CHECKPOINTS,
  DECON_TIERS,
  deconBudgetSchema,
  parseDeconMaterialRef,
  deconReportKindSchema,
  deconReviewCheckpointSchema,
  deconStylePayloadSchema,
  normalizeSettingMdContent,
} from '@orison/shared-contracts';
import type {
  DeconCreateInput,
  DeconCreateResult,
  DeconStartResult,
} from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { assignmentThinkingControl } from '@orison/desktop-agent';
import {
  deleteDeconJobCascade,
  getDeconDictionary,
  getDeconJob,
  getDeconProduct,
  getDeconReport,
  getDeconReview,
  listDeconEntities,
  listDeconJobs,
  listDeconJobsByMaterial,
  listDeconPassStates,
  listDeconProducts,
  listDeconReportMetas,
  listDeconReviews,
  upsertDeconReview,
} from '../db/closure-decon';
import { listDeconCanonEntries } from '../db/closure-canon';
import { buildChapterHeadings, chapterShortLabel } from '../db/chapterHeadings';
import { getMaterialRow } from '../db/materialIndexer';
import { getProjectById } from '../db/projectRepository';
import { getLogger } from '../logger';
import {
  checkDeconJobFreshness,
  confirmDeconRerun,
  createDeconJob,
  startDeconJob,
  transitionDeconJob,
  type DeconFingerprintPair,
  type DeconJobDeps,
} from '../decon/deconJob';
import {
  DECON_THINKING_TOKEN_FACTOR,
  estimateDeconCost,
  type DeconEstimateThinkingSlot,
} from '../decon/deconBudget';
import {
  cancelInflightDeconPipeline,
  DeconJobGoneError,
  deconErrMsg,
  readDeconDerivedTextFor,
  registerInflightDeconPipeline,
  type DeconPipelineHandle,
} from '../decon/deconRun';
import type { DeconGenerateText } from '../decon/deconLlmCore';
import { runDeconP1a } from '../decon/p1Dictionary';
import { runDeconP1b } from '../decon/p1Extract';
import { runDeconP1c } from '../decon/p1Aggregate';
import { runDeconP2 } from '../decon/p2Canon';
import { runDeconP3a } from '../decon/p3Label';
import { runDeconP3b } from '../decon/p3Metrics';
import { runDeconP4Craft } from '../decon/p4Craft';
import { runDeconP4Style } from '../decon/p4Style';
import { runDeconP5BookReading, runDeconP5ChapterReview, runDeconP5SceneAnnotation } from '../decon/p5Output';
import { runDeconP6 } from '../decon/p6Craft';
import { mergeDeconStyleCard } from '../decon/styleExport';
import { withProjectLock } from '../fs/projectWriteLock';
import { sendDeconProgress } from './deconNotify';
import { readTaskModelSlots } from './configIpc';
import { assertSafePath } from './pathGuard';

// ── E10.3a（task 09-05）W6：拆解管线 IPC——invoke 通道族 + 后台管线编排 ──
//
// - `decon:create {materialId, tier, dimensions?, budget?, reviewCheckpoints?}`（模式 A）：
//   createDeconJob 全门（材料就绪 F-12 / 在途守卫 F-11 / 双指纹快照 F-02 / P1 继承 F-07）+
//   成本预估回执（estimateDeconCost 纯函数，inheritedP1 时 P1 三 pass 打折）+ **闸门行初始化**
//   （E10.3b 拍板①：三 checkpoint pending；reviewCheckpoints:false → off；初始化失败回滚
//   job 行——CR-12 不留无闸门 job）。
// - `decon:start {jobId, budget?}`（capped-hold 重入面）：budget 在 start 前生效（upsert 后
//   retry→running）；startDeconJob 幂等（running/done no-op 不重跑——F-11）；启动后**后台
//   fire-and-forget** 跑 runDeconPassSequence（进度经 decon:progress 推送，pass_state/job 是
//   真相源——事件可丢，读侧 decon:get 兜底，mirror craft:distill-run）。
// - `decon:pause` / `decon:cancel`：状态机转移（pause = 章边界感知优雅停——runner 循环面）。
// - `decon:delete`：per-job 级联（job + pass_state + B 三表 + canon；事实层三表材料级保留 F-07）。
// - `decon:get`：人审取数面（断点行 + canon 六域 + 词典 + 实体）；读侧 freshness 校验
//   （F-02——失配翻 stale，产物面不供给）。
// - `decon:list`：清单（省略 materialId = 全部）。
// - `decon:approve-review {jobId, checkpoint}`（E10.3b W3b）：闸门确认即续跑（approved →
//   startDeconJob → 管线重入零重付——approve 与用户 resume 在 job 行同态，区分靠 review 行）。
//   **start 所有权单点（CR-3）**：闸门确认后的续跑 start 只归本 handler（壳面 = 唯一所有者，
//   design §6「确认即续跑」语义）；UI 消费面 approve 回执后不得再发第二个 decon:start。
// - `decon:products {jobId, pass?, passStem?, unit?}` / `decon:reports {jobId, kind?, unit?}`
//   （E10.3b W5 读面）：findings 投影 / 报告 meta 列表 + 单取——**读侧 freshness 门**（stale/
//   cancelled 不供给产物面，同 decon:get 纪律）；reports 列表只回 meta（大书章评数百行不整面
//   灌 renderer）；passStem = pass 前缀过滤（CR-8——'p4' 匹配全部 p4:<dim>，排除逻辑留 UI）；
//   坏 kind 串显式 invalid-input 拒收（CR-24）。
// - `decon:export-style {jobId, projectId}`（E10.3b W5）：p4:style 结构化 payload → merge 写
//   目标项目 `settings/style.md`（parseStyleSections 语义键替换/手写节保留/无卡新建；读→合并
//   →写全在 withProjectLock 锁内——CR-4 防陈旧快照丢更新 + atomicWrite——fs-layer 纪律；
//   pathGuard 路径校验）。
// - `decon:confirm-rerun {jobId}`（E10.3b W7 小补③）：stale 确认重跑——A 的 confirmDeconRerun
//   （刷新双指纹现值 + resetDeconRerunState 单事务复位派生产物/闸门）后**自动 start 续跑**
//   （mirror approve-review「确认即续跑」）；UI stale 横幅的「确认重跑」按钮消费（替代
//   「删除后重拆」引导）。
//
// runDeconPassSequence（管线编排面）：**phases 动态化**（E10.3b W3b/W5——design §9 序列：
// p1a→p1b→p1c→闸门dictionary→p2→闸门canon→p3a→p3b→p4:<dim>…→p4:style→闸门craft→p5:book_
// reading（coarse+）→p5:chapter_review（fine+）→p5:scene_annotation（deep）→p6（手艺维非空
// 时；运行面候选判定归 runner）），job.dimensions/tier 驱动步集构建；A 四 runner 调用与竞态
// 骨架（在途注册/逐 runner try/catch/DeconJobGoneError 静默/取消握手）原样继承。pass 边界发
// 进度事件；闸门步 pending → pause 返回；capped/failed/stale/paused 即停（断点底座兜重入）。
//
// expected_downstream_consumers:
// - child B 拆书页 UI（decon:* 通道族消费 + products/reports/export-style 增补归 W5/W6）。
// - main/index.ts registerAllIpc（registerDeconIpc 恰一次）。

/** 错误消息归一（mirror craftIpc errMsg）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 入参归一（模式 B 坏参 throw 面 mirror materialIpc 的 coerceXxx；变更大面走模式 A 判别联合）──

function coerceJobId(rawInput: unknown): string | undefined {
  if (rawInput === null || typeof rawInput !== 'object') return undefined;
  const jobId = (rawInput as Record<string, unknown>).jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : undefined;
}

function coerceBudget(raw: unknown): { ok: true; budget: DeconBudget } | { ok: false } {
  if (raw === null || typeof raw !== 'object') return { ok: false };
  const input = raw as Record<string, unknown>;
  const candidate = {
    totalTokens: input.totalTokens === null ? null : input.totalTokens,
    ...(typeof input.perPass === 'object' && input.perPass !== null ? { perPass: input.perPass } : {}),
  };
  const parsed = deconBudgetSchema.safeParse(candidate);
  return parsed.success ? { ok: true, budget: parsed.data } : { ok: false };
}

function coerceCreateInput(
  rawInput: unknown,
): { ok: true; input: Omit<DeconCreateInput, 'budget'>; budget?: DeconBudget } | { ok: false; message: string } {
  if (rawInput === null || typeof rawInput !== 'object') return { ok: false, message: 'decon:create 需要 {materialId, tier}' };
  const raw = rawInput as Record<string, unknown>;
  if (typeof raw.materialId !== 'string' || raw.materialId.length === 0) {
    return { ok: false, message: 'decon:create 需要 materialId' };
  }
  if (typeof raw.tier !== 'string' || !(DECON_TIERS as readonly string[]).includes(raw.tier)) {
    return { ok: false, message: `decon:create tier 须为 ${DECON_TIERS.join('|')} 之一` };
  }
  let dimensions: string[] | undefined;
  if (raw.dimensions !== undefined && raw.dimensions !== null) {
    if (!Array.isArray(raw.dimensions) || raw.dimensions.some((d) => typeof d !== 'string' || d.length === 0)) {
      return { ok: false, message: 'decon:create dimensions 须为非空字符串数组' };
    }
    dimensions = raw.dimensions as string[];
  }
  let reviewCheckpoints: boolean | undefined;
  if (raw.reviewCheckpoints !== undefined && raw.reviewCheckpoints !== null) {
    if (typeof raw.reviewCheckpoints !== 'boolean') {
      return { ok: false, message: 'decon:create reviewCheckpoints 须为布尔（缺省 = 闸门默认开）' };
    }
    reviewCheckpoints = raw.reviewCheckpoints;
  }
  let budget: DeconBudget | undefined;
  if (raw.budget !== undefined && raw.budget !== null) {
    const coerced = coerceBudget(raw.budget);
    if (!coerced.ok) return { ok: false, message: 'decon:create budget 形态坏（totalTokens 须为正整数或 null；perPass 须为正整数表）' };
    budget = coerced.budget;
  }
  return {
    ok: true,
    input: {
      materialId: raw.materialId,
      tier: raw.tier as DeconCreateInput['tier'],
      dimensions,
      ...(reviewCheckpoints !== undefined ? { reviewCheckpoints } : {}),
    },
    budget,
  };
}

// ── entities mentions 截断投影（CR-9——首 N + 末 N 章 + 总数）──

/** 截断首/末章数（全量走 db 消费面——IPC 面千章 mentions 不整面灌 renderer）。 */
export const DECON_GET_MENTIONS_HEAD = 8;
export const DECON_GET_MENTIONS_TAIL = 8;

/**
 * CR-1（拍板 B）章引用标签单制：章 index → 真实章标短标签（chapterHeadings 单源——
 * chapterShortLabel：章号可解析「第 N 章」/章标行原词/语义回落，零序号算术）。材料缺/
 * 派生读失败 → 空表（UI 回落「材料第 N 章」）；stale 态仍构建（章序展示面不受产物门约束）。
 */
function buildDeconChapterLabels(
  materialRef: string,
  readDerived: (material: Material) => string | null,
): Record<number, string> {
  const parsed = parseDeconMaterialRef(materialRef);
  if (parsed === null) return {};
  const material = getMaterialRow(parsed.materialId);
  if (material === null || material.chapters.length === 0) return {};
  const derived = readDerived(material);
  if (derived === null) return {};
  const headings = buildChapterHeadings(derived, material.chapters);
  const labels: Record<number, string> = {};
  for (const chapter of material.chapters) {
    labels[chapter.index] = chapterShortLabel(headings.get(chapter.index), chapter.index);
  }
  return labels;
}

function projectDeconEntityForIpc(entity: DeconEntityRow): DeconEntityIpc {
  const mentionsTotal = entity.mentions.length;
  if (mentionsTotal <= DECON_GET_MENTIONS_HEAD + DECON_GET_MENTIONS_TAIL) {
    return { ...entity, mentionsTotal, mentionsTruncated: false };
  }
  const sorted = [...entity.mentions].sort((x, y) => x.chapterIndex - y.chapterIndex);
  return {
    ...entity,
    mentions: [...sorted.slice(0, DECON_GET_MENTIONS_HEAD), ...sorted.slice(-DECON_GET_MENTIONS_TAIL)],
    mentionsTotal,
    mentionsTruncated: true,
  };
}

type DeconEntityRow = ReturnType<typeof listDeconEntities>[number];

// ── 管线编排（design §9 phases 序列——job 驱动动态构建 + 三闸门插点；A 四 runner 竞态骨架不动）──

/** 管线 deps（各 pass 运行器共用注入面——generateText/readDerivedText/notify/now 结构同形，直接透传）。 */
export interface DeconPipelineDeps {
  generateText?: DeconGenerateText;
  readDerivedText?: (material: Material) => string | null;
  /** 进度事件注入（runDeconPassSequence 包 elapsedMs 后转发给 runner——P1b 逐章 running 面）。 */
  notify?: (event: DeconProgressEvent) => void;
  now?: () => Date;
}

/** 后台管线终态（invoke 回执之外的真相 = pass_state/job 行——本类型只作日志/事件面）。 */
export type DeconPassSequenceResult =
  | { status: 'done' }
  | { status: 'capped'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'stale'; message: string }
  | { status: 'cancelled'; message?: string }
  | { status: 'paused' };

/** runner 结果面（各 pass 结果联合的公共子集——编排层只消费 status/message）。 */
type DeconRunnerResult = { status: 'done' | 'paused' | 'cancelled' } | { status: 'capped' | 'failed' | 'stale'; message: string };

/** runner 签名（A 四 runner 与 B runner 同形——结果联合窄化经调用点 cast，mirror A phases）。 */
type DeconPhaseRunner = (jobId: string, deps: DeconPipelineDeps) => Promise<unknown>;

/** 管线步（pass 相位 / 人审闸门插点——B design §6 拍板①）。 */
export type DeconPhaseStep =
  | { kind: 'pass'; pass: string; runner: DeconPhaseRunner }
  | { kind: 'gate'; checkpoint: DeconReviewCheckpoint };

/**
 * 闸门暂停注记（进度事件 **note 面**——CR-10 软提示通道：「待人工确认」的可辨识文案；error 只留给真失败）。
 * F14：不泄漏内部 IPC 通道名（decon:approve-review）——用户面只说「确认后自动继续拆解」。
 */
const DECON_GATE_NOTES: Readonly<Record<DeconReviewCheckpoint, string>> = {
  dictionary: '待人工确认：词典与实体（P1c 产物）——在下方闸门卡确认后自动继续拆解',
  canon: '待人工确认：正典六域（P2 产物）——在下方闸门卡确认后自动继续拆解',
  craft: '待人工确认：手艺层发现（P4 各维 findings）——在下方闸门卡确认后自动继续拆解',
};

/**
 * **craft 闸门前置**（B design §6——与 p6 同款）：手艺维非空**且** P4 有 findings 才触发。
 * coarse / coarse+style 档零 findings 不空停；fine/deep 但 findings 全被锚定核验丢弃时同样
 * 不空停（无产物可审）。风格维产物（p4:style）不算 findings——风格不落 craft 卡。
 */
export function deconCraftGateTriggered(job: Pick<DeconJob, 'dimensions'>, jobId: string): boolean {
  if (!job.dimensions.some((d) => d !== 'style')) return false;
  for (const row of listDeconProducts(jobId)) {
    if (row.pass === 'p4:style' || !row.pass.startsWith('p4:')) continue;
    const findings = (row.payload as { findings?: unknown } | null)?.findings;
    if (Array.isArray(findings) && findings.length > 0) return true;
  }
  return false;
}

/**
 * phases 序列构建（**job 驱动动态化**——B design §9 权威序）：
 * `p1a→p1b→p1c→闸门dictionary→p2→闸门canon→p3a→p3b→p4:<dim>…（dimensions 序）→p4:style（dims
 * 含 style 时排末）→闸门craft→p5:book_reading（coarse+）→p5:chapter_review（fine+）→
 * p5:scene_annotation（deep）→p6（手艺维非空时）`。
 * - P4 手艺维逐维一步（per-dim runner 调用——细粒度相位事件/断点/失败隔离）；
 * - 闸门步到点查 review 行（pending → pause 返回；off/approved/缺行 → 照跑——legacy job 无行
 *   不拦）；
 * - craft 闸门经 deconCraftGateTriggered 前置判定（无 findings 不空停）。
 * - **P5 分相位挂三子 runner（非 runDeconP5 伞面单步）**：细粒度相位事件（运行可见纪律——
 *   coarse 用户看到 book_reading 相位而非泛 p5）+ 逐 kind 断点/失败隔离（capped 在章评时
 *   读法已 done 不重付）。tier 过滤在编排面（tier 缺省 = 删行竞态——只挂 coarse 下限
 *   book_reading，首 runner 运行门如实 cancelled）；三子 runner 自带 tier belt（接线错配
 *   跳过不空烧）。
 * - **p6 静态前置 = 手艺维非空**（coarse / coarse+style 不排程——风格维不落 craft 卡）；
 *   运行面候选判定（craftHint≠null findings 存在）归 runDeconP6（产物在管线启动时还不存在）。
 */
export function buildDeconPhaseSteps(dimensions: readonly string[], tier?: DeconJob['tier']): DeconPhaseStep[] {
  const steps: DeconPhaseStep[] = [
    { kind: 'pass', pass: 'p1a', runner: runDeconP1a as DeconPhaseRunner },
    { kind: 'pass', pass: 'p1b', runner: runDeconP1b as DeconPhaseRunner },
    { kind: 'pass', pass: 'p1c', runner: runDeconP1c as DeconPhaseRunner },
    { kind: 'gate', checkpoint: 'dictionary' },
    { kind: 'pass', pass: 'p2', runner: runDeconP2 as DeconPhaseRunner },
    { kind: 'gate', checkpoint: 'canon' },
    { kind: 'pass', pass: 'p3a', runner: runDeconP3a as DeconPhaseRunner },
    { kind: 'pass', pass: 'p3b', runner: runDeconP3b as DeconPhaseRunner },
  ];
  const craftDims = dimensions.filter((d) => d !== 'style');
  for (const dim of craftDims) {
    steps.push({ kind: 'pass', pass: `p4:${dim}`, runner: ((jobId: string, deps: DeconPipelineDeps) => runDeconP4Craft(jobId, deps, dim as Parameters<typeof runDeconP4Craft>[2])) as DeconPhaseRunner });
  }
  if (dimensions.includes('style')) {
    steps.push({ kind: 'pass', pass: 'p4:style', runner: runDeconP4Style as DeconPhaseRunner });
  }
  steps.push({ kind: 'gate', checkpoint: 'craft' });
  // P5 按 tier 分相位（design §9——book_reading coarse+ / chapter_review fine+ / scene_annotation
  // deep；tier 缺省 = 删行竞态 → coarse 下限，首 runner 运行门如实 cancelled）。
  steps.push({ kind: 'pass', pass: 'p5:book_reading', runner: runDeconP5BookReading as DeconPhaseRunner });
  if (tier === 'fine' || tier === 'deep') {
    steps.push({ kind: 'pass', pass: 'p5:chapter_review', runner: runDeconP5ChapterReview as DeconPhaseRunner });
  }
  if (tier === 'deep') {
    steps.push({ kind: 'pass', pass: 'p5:scene_annotation', runner: runDeconP5SceneAnnotation as DeconPhaseRunner });
  }
  // p6 craft 落卡（静态前置 = 手艺维非空；零候选/无内核等运行面判定归 runner——不空停）。
  if (craftDims.length > 0) {
    steps.push({ kind: 'pass', pass: 'p6', runner: runDeconP6 as DeconPhaseRunner });
  }
  return steps;
}

/**
 * 闸门检查（编排层步进到 gate 步时调用）：pending → `transitionDeconJob(jobId,'pause')` +
 * 进度事件注记 → 返回 true（管线停 paused——「等审暂停」与用户暂停在 job 行同态，区分靠
 * review 行）；off/approved/缺行（legacy）→ false 照跑。craft 闸门先过前置判定。转移失败
 * （await 窗口内被外部翻态，如 cancel）→ false 照跑——后续 runner 的边界判别如实停走。
 */
function deconReviewGatePauses(
  jobId: string,
  checkpoint: DeconReviewCheckpoint,
  job: DeconJob | null,
  emit: (event: DeconProgressEvent) => void,
  nowIso: () => string,
): boolean {
  const row = getDeconReview(jobId, checkpoint);
  if (row === null || row.status !== 'pending') return false;
  if (checkpoint === 'craft' && (job === null || !deconCraftGateTriggered(job, jobId))) return false;
  const paused = transitionDeconJob(jobId, 'pause', undefined, { now: () => new Date(nowIso()) });
  if (!paused.ok) return false;
  // CR-10：闸门暂停是常规预期态——注记走 note 软提示通道（error 留给 capped/failed 真失败，
  // 不污染诊断面）。
  emit({ jobId, status: 'paused', pass: null, note: DECON_GATE_NOTES[checkpoint] });
  return true;
}

/**
 * 跑全序列（A 骨架原样继承 + B phases 动态化）：
 * - **在途注册**（CR-1）：registerInflightDeconPipeline——同 job 已有在途管线即拒绝派第二条
 *   （双管线并发重复烧 LLM 防线）；finally 释放。start 的「真在途」判别靠本注册表。
 * - **逐 runner try/catch**（CR-1）：runner 异常 → fail 转移 + 如实上报；DeconJobGoneError
 *   （job 已删，cost 回写中止）→ cancelled 静默退出（不复活不转移）。
 * - pass 边界发 decon:progress（带 elapsedMs CR-8；逐 unit running 由 runner 经 deps.notify
 *   发——同样过 elapsedMs 包装）；**闸门步**到点 pending → pause 返回（review 行驱动）；
 *   任一 pass 非 done 即停（断点底座兜重入——capped 调预算续跑 / failed retry / paused
 *   resume 均经 startDeconJob 再入——approve-review 同路）。全 done → job finish 转移。
 * - cancel 握手（CR-1）：registry 取消旗标在步边界自查。
 */
export async function runDeconPassSequence(
  jobId: string,
  deps: DeconPipelineDeps,
  notify: (event: DeconProgressEvent) => void = sendDeconProgress,
): Promise<DeconPassSequenceResult> {
  let cancelledByRegistry = false;
  const handle: DeconPipelineHandle = { cancel: () => { cancelledByRegistry = true; } };
  const release = registerInflightDeconPipeline(jobId, handle);
  if (release === null) {
    const message = `拆解会话 ${jobId} 已有在途管线——双管线并发被拒（等待当前管线终态后再 start）`;
    getLogger().warn({ jobId }, `decon pipeline: ${message}`);
    return { status: 'failed', message };
  }
  try {
    const now = deps.now ?? (() => new Date());
    const nowIso = (): string => now().toISOString();
    const startedAtMs = now().getTime();
    const emit = (event: DeconProgressEvent): void => {
      notify({ ...event, elapsedMs: Math.max(0, now().getTime() - startedAtMs) });
    };
    const runnerDeps = { ...deps, notify: emit };
    // phases 动态化（job 驱动——dims + tier）：删行竞态下按空维度集构建——首 runner 的运行门如实报 cancelled。
    const job = getDeconJob(jobId);
    const steps = buildDeconPhaseSteps(job?.dimensions ?? [], job?.tier);
    for (const step of steps) {
      if (cancelledByRegistry) return { status: 'cancelled', message: '拆解会话被取消（在途 delete/materials:delete 握手）' };
      if (step.kind === 'gate') {
        if (deconReviewGatePauses(jobId, step.checkpoint, job, emit, nowIso)) return { status: 'paused' };
        continue;
      }
      const { pass, runner } = step;
      emit({ jobId, status: 'running', pass, unit: null });
      let result: DeconRunnerResult;
      try {
        result = (await runner(jobId, runnerDeps)) as DeconRunnerResult;
      } catch (err) {
        if (err instanceof DeconJobGoneError) {
          // job 已删（在途 delete 级联的 cost 回写中止哨兵）——静默退出，不复活不转移。
          getLogger().warn({ jobId }, 'decon pipeline: job deleted mid-run - exiting silently');
          return { status: 'cancelled', message: err.message };
        }
        const message = `拆解 ${pass} 相位异常：${deconErrMsg(err)}`;
        getLogger().warn({ err: message, jobId }, 'decon pipeline: runner threw (failing job - was silently stuck running before CR-1)');
        transitionDeconJob(jobId, 'fail', message); // belt：行已删/已翻态时无效——无害
        emit({ jobId, status: 'failed', pass: null, error: message });
        return { status: 'failed', message };
      }
      if (result.status === 'done') continue;
      const hasMessage = result.status === 'capped' || result.status === 'failed' || result.status === 'stale';
      emit({
        jobId,
        status: result.status,
        pass: null,
        ...(hasMessage ? { error: (result as { message: string }).message } : {}),
      });
      return result;
    }
    const finish = transitionDeconJob(jobId, 'finish');
    if (!finish.ok) {
      // belt：pass 全 done 后转移失败（外部翻态竞态）——如实上报当前行，不静默。
      const message = `拆解 pass 已全部完成但 job 终态转移被拒（状态 ${finish.job?.status ?? 'unknown'}）`;
      getLogger().warn({ jobId }, `decon pipeline: ${message}`);
      emit({ jobId, status: 'failed', pass: null, error: message });
      return { status: 'failed', message };
    }
    emit({ jobId, status: 'done', pass: null });
    return { status: 'done' };
  } finally {
    release();
  }
}

/**
 * C6：拆解三缝档（extraction/review-judge/writer-draft）的 thinking 开启解析 → 预估系数表。
 * 开启判据 = assignmentThinkingControl 归一后 level 非 'off'（thinkingCustom 有值 / thinking
 * 非 auto 档）；readTaskModelSlots 读 task-models sidecar（mtime 缓存零热点）。读失败 /
 * 缺档 → 空表（零思考假设即旧行为——诚实降级不阻创建）。
 */
function resolveDeconThinkingFactors(): Partial<Record<DeconEstimateThinkingSlot, number>> {
  const factors: Partial<Record<DeconEstimateThinkingSlot, number>> = {};
  try {
    const slots = readTaskModelSlots() ?? {};
    for (const slot of ['extraction', 'review-judge', 'writer-draft'] as const) {
      const control = assignmentThinkingControl(slots[slot]);
      if (control !== undefined && control.level !== 'off') factors[slot] = DECON_THINKING_TOKEN_FACTOR;
    }
  } catch (err) {
    // CR-15：静默吞错会让 F9③ 的思考口径悄然失效（预估回零思考假设且无人知晓）——warn 落
    // 日志再诚实降级（零思考假设即旧行为，不阻创建）。
    getLogger().warn(
      { err: errMsg(err) },
      'decon:create thinking factor resolution failed (estimate falls back to zero-thinking basis)',
    );
    return {};
  }
  return factors;
}

// ── IPC 工厂（deps 注入，零网络可测——mirror createMaterialIpcHandlers / createCraftIpcHandlers）──

export interface DeconIpcHandlers {
  createDecon(rawInput: unknown): Promise<DeconCreateResult>;
  startDecon(rawInput: unknown): Promise<DeconStartResult>;
  pauseDecon(rawInput: unknown): Promise<DeconTransitionResult>;
  cancelDecon(rawInput: unknown): Promise<DeconTransitionResult>;
  deleteDecon(rawInput: unknown): Promise<DeconDeleteResult>;
  getDecon(rawInput: unknown): Promise<DeconJobDetail | null>;
  listDecon(rawInput: unknown): Promise<DeconJob[]>;
  approveDeconReview(rawInput: unknown): Promise<DeconApproveReviewResult>;
  confirmRerunDecon(rawInput: unknown): Promise<DeconConfirmRerunResult>;
  productsDecon(rawInput: unknown): Promise<DeconProductsResult>;
  reportsDecon(rawInput: unknown): Promise<DeconReportsResult>;
  exportStyleDecon(rawInput: unknown): Promise<DeconExportStyleResult>;
}

export interface DeconIpcDeps {
  /** 后台管线执行面（生产 = runDeconPassSequence + 生产 LLM 内核；测试注入 mock LLM 版）。 */
  runPipeline?: (jobId: string) => Promise<DeconPassSequenceResult>;
  now?: () => Date;
  /** 双指纹读取注入（缺省生产 readDeconCurrentFingerprints；测试零 fs/db-material 依赖）。 */
  readCurrentFingerprints?: (materialId: string) => DeconFingerprintPair | null;
  /** 章 label 装配的派生文本读取（缺省生产 readDeconDerivedTextFor；测试零 fs 依赖——CR-1）。 */
  readMaterialDerivedText?: (material: Material) => string | null;
  /** 进度广播注入（缺省 sendDeconProgress；测试 spy）。 */
  notify?: (event: DeconProgressEvent) => void;
}

export function createDeconIpcHandlers(deps: DeconIpcDeps = {}): DeconIpcHandlers {
  const now = deps.now ?? (() => new Date());
  const notify = deps.notify ?? sendDeconProgress;
  const readMaterialDerivedText = deps.readMaterialDerivedText ?? readDeconDerivedTextFor;
  const jobDeps: DeconJobDeps = {
    ...(deps.readCurrentFingerprints !== undefined ? { readCurrentFingerprints: deps.readCurrentFingerprints } : {}),
    now,
  };
  const runPipeline =
    deps.runPipeline ??
    ((jobId: string) => runDeconPassSequence(jobId, { notify }, notify));

  return {
    /**
     * `decon:create`——P0 会话建立：createDeconJob 全门 + 成本预估回执（材料登记行的
     * 章数/字数 stats；P1 继承时 p1Reusable 打折呈现 F-07）+ **人审闸门行初始化**
     * （E10.3b 拍板①：三 checkpoint 行 status=pending；`reviewCheckpoints:false` → 'off'
     * ——配置即行零改 A job 表）。闸门行初始化失败 → 回滚 job 行 + operation-failed
     * （CR-12——不留无闸门 job，缺行会被闸门检查当 legacy 照跑）。
     */
    async createDecon(rawInput: unknown): Promise<DeconCreateResult> {
      const coerced = coerceCreateInput(rawInput);
      if (!coerced.ok) return { ok: false, error: 'invalid-input', message: coerced.message };
      const input = coerced.input;
      const created = createDeconJob(
        {
          materialId: input.materialId,
          tier: input.tier,
          ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
          ...(coerced.budget !== undefined ? { budget: coerced.budget } : {}),
        },
        jobDeps,
      );
      if (!created.ok) {
        return {
          ok: false,
          error: created.error,
          ...(created.inflightJobId !== undefined ? { inflightJobId: created.inflightJobId } : {}),
          message: created.message,
        };
      }
      const reviewStatus: DeconReviewRow['status'] = input.reviewCheckpoints === false ? 'off' : 'pending';
      // CR-12：闸门行初始化与 job 创建的原子性——中途失败回滚 job 行（deleteDeconJobCascade
      // per-job 级联含 review 行）+ 如实 operation-failed。不回滚 = 留无闸门 job：闸门检查把
      // 缺行当 legacy 照跑，用户开的闸门静默失效。
      try {
        for (const checkpoint of DECON_REVIEW_CHECKPOINTS) {
          upsertDeconReview({ jobId: created.job.jobId, checkpoint, status: reviewStatus, note: null, updatedAt: now().toISOString() });
        }
      } catch (err) {
        const message = `闸门行初始化失败：${errMsg(err)}`;
        getLogger().warn({ err: message, materialId: input.materialId }, 'decon:create review init failed (rolling back job)');
        try {
          deleteDeconJobCascade(created.job.jobId);
        } catch (rollbackErr) {
          getLogger().warn(
            { err: errMsg(rollbackErr), jobId: created.job.jobId },
            'decon:create review init rollback failed (job row may linger gateless)',
          );
        }
        return { ok: false, error: 'operation-failed', message };
      }
      const material = getMaterialRow(input.materialId);
      const stats = {
        chapterCount: material?.chapters.length ?? 0,
        charCount: material?.quality.charCount ?? 0,
      };
      const estimate = estimateDeconCost({
        tier: created.job.tier,
        dimensions: created.job.dimensions,
        stats,
        p1Reusable: created.inheritedP1,
        thinkingBySlot: resolveDeconThinkingFactors(),
      });
      const estimateIpc: DeconEstimateIpc = { totalTokens: estimate.totalTokens, byPass: estimate.byPass };
      return { ok: true, job: created.job, inheritedP1: created.inheritedP1, estimate: estimateIpc };
    },

    /**
     * `decon:start`——启动/续跑（CR-1 重构）：budget 经 startDeconJob 的状态判定**之后**窄落
     * （updateDeconJobBudget 只对非 running 态生效——capped-hold 调预算重入面，不覆写活 cost/
     * 不复活已删行）；startDeconJob 幂等（running×在途管线 no-op 不重派 / done+指纹一致 no-op /
     * 假 running 对账翻 paused 续跑）；启动成功后台 fire-and-forget 跑管线（belt catch）。
     */
    async startDecon(rawInput: unknown): Promise<DeconStartResult> {
      const jobId = coerceJobId(rawInput);
      if (jobId === undefined) return { ok: false, error: 'invalid-input', message: 'decon:start 需要 jobId' };
      let budget: DeconBudget | undefined;
      const rawBudget =
        rawInput !== null && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>).budget : undefined;
      if (rawBudget !== undefined && rawBudget !== null) {
        const coerced = coerceBudget(rawBudget);
        if (!coerced.ok) {
          return { ok: false, error: 'invalid-input', message: 'decon:start budget 形态坏（totalTokens 须为正整数或 null；perPass 须为正整数表）' };
        }
        budget = coerced.budget;
      }
      const started = startDeconJob(jobId, jobDeps, budget);
      if (!started.ok) {
        return {
          ok: false,
          error: started.error,
          ...(started.job !== undefined ? { job: started.job } : {}),
          message: started.message,
        };
      }
      if (!started.noop) {
        void runPipeline(jobId).catch((err) => {
          getLogger().warn(
            { err: errMsg(err), jobId },
            'decon:start background pipeline threw (belt - per-pass failures already landed in pass_state/job rows)',
          );
        });
      }
      return { ok: true, job: started.job, noop: started.noop };
    },

    /** `decon:pause`——优雅中断（p1b 章边界感知停；state 行保留）。 */
    async pauseDecon(rawInput: unknown): Promise<DeconTransitionResult> {
      const jobId = coerceJobId(rawInput);
      if (jobId === undefined) return { ok: false, error: 'invalid-input', message: 'decon:pause 需要 jobId' };
      const result = transitionDeconJob(jobId, 'pause', undefined, jobDeps);
      if (!result.ok) return { ok: false, error: result.error === 'invalid-transition' ? 'invalid-state' : result.error, message: result.message };
      notify({ jobId, status: 'paused', pass: null });
      return { ok: true, job: result.job };
    },

    /** `decon:cancel`——终态取消（重拆走新 job）。 */
    async cancelDecon(rawInput: unknown): Promise<DeconTransitionResult> {
      const jobId = coerceJobId(rawInput);
      if (jobId === undefined) return { ok: false, error: 'invalid-input', message: 'decon:cancel 需要 jobId' };
      const result = transitionDeconJob(jobId, 'cancel', undefined, jobDeps);
      if (!result.ok) return { ok: false, error: result.error === 'invalid-transition' ? 'invalid-state' : result.error, message: result.message };
      notify({ jobId, status: 'cancelled', pass: null });
      return { ok: true, job: result.job };
    },

    /**
     * `decon:delete`——per-job 级联（job + pass_state + canon；事实层三表材料级保留 F-07）。
     * **在途握手**（CR-1）：在途管线先经注册表置取消旗标（管线在下一章/域边界停；cost 回写
     * 遇行已删抛 DeconJobGoneError 静默退出——不复活行）。
     */
    async deleteDecon(rawInput: unknown): Promise<DeconDeleteResult> {
      const jobId = coerceJobId(rawInput);
      if (jobId === undefined) return { ok: false, error: 'invalid-input', message: 'decon:delete 需要 jobId' };
      if (getDeconJob(jobId) === null) return { ok: false, error: 'not-found', message: `拆解会话 ${jobId} 不存在` };
      cancelInflightDeconPipeline(jobId);
      try {
        deleteDeconJobCascade(jobId);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), jobId }, 'decon:delete cascade failed');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
      return { ok: true };
    },

    /**
     * `decon:get`——会话详情（人审取数面）：断点行 + canon 六域 + 词典 + 实体 + **闸门行 +
     * 报告计数 + 章标标签表**（E10.3b additive + CR-1 拍板 B）。读侧 freshness 校验（F-02——
     * 双指纹失配 → job 翻 stale + fresh=false + freshReason；cancelled 终态产物面同为空——
     * CR-9 对齐契约注释）。**entities mentions 截断投影**（CR-9：首 N + 末 N 章 + 总数——千章级
     * mentions 不整面灌 renderer）。闸门行 stale/cancelled 态仍回（off 是用户常设配置、UI 区分
     * 「等审暂停」与「用户暂停」靠 review 行——pending = 等审）；reportCounts 产物面随 fresh；
     * chapterLabels 恒回（材料现值构建，章序展示面）。
     */
    async getDecon(rawInput: unknown): Promise<DeconJobDetail | null> {
      const jobId = coerceJobId(rawInput);
      if (jobId === undefined) return null;
      const job = getDeconJob(jobId);
      if (job === null) return null;
      const reviews = listDeconReviews(jobId);
      const chapterLabels = buildDeconChapterLabels(job.materialRef, readMaterialDerivedText);
      const freshness = checkDeconJobFreshness(job, jobDeps);
      const liveJob = getDeconJob(jobId) ?? job; // freshness 翻 stale 后重读现值行
      if (!freshness.fresh) {
        return {
          job: liveJob,
          passStates: listDeconPassStates(jobId),
          chapterLabels,
          fresh: false,
          freshReason: freshness.reason,
          canon: [],
          dictionary: null,
          entities: [],
          reviews,
          reportCounts: {},
        };
      }
      const entities = listDeconEntities(job.materialRef, job.derivedHash).map(projectDeconEntityForIpc);
      const reportCounts: Record<string, number> = {};
      for (const meta of listDeconReportMetas(jobId)) {
        reportCounts[meta.kind] = (reportCounts[meta.kind] ?? 0) + 1;
      }
      return {
        job: liveJob,
        passStates: listDeconPassStates(jobId),
        chapterLabels,
        fresh: true,
        canon: listDeconCanonEntries(jobId),
        dictionary: getDeconDictionary(job.materialRef, job.derivedHash),
        entities,
        reviews,
        reportCounts,
      };
    },

    /** `decon:list`——清单（省略 materialId = 全部 job）。 */
    async listDecon(rawInput: unknown): Promise<DeconJob[]> {
      const materialId =
        rawInput !== null && typeof rawInput === 'object' && typeof (rawInput as Record<string, unknown>).materialId === 'string'
          ? ((rawInput as Record<string, unknown>).materialId as string)
          : undefined;
      return materialId !== undefined ? listDeconJobsByMaterial(materialId) : listDeconJobs();
    },

    /**
     * `decon:approve-review`——闸门确认（拍板①「确认即续跑」）：review 行 pending → approved
     * → startDeconJob 续跑（**复用既有 start 路径**——paused→running + 后台管线重入；台账
     * skip 已 done pass，零重付）。非 pending（已确认/已关/缺行 legacy）→ invalid-state；
     * start 面失败（如 stale 指纹）→ invalid-state 如实带 message（approve 已落，续跑受阻）。
     *
     * **start 所有权单点（CR-3）**：闸门确认后的续跑 start **只归本 handler**——壳侧
     * approve → startDeconJob → spawn 管线是唯一所有者（design §6「确认即续跑」语义）。
     * UI 消费面拿到 approve 回执后**不得再发第二个 `decon:start`**（双 start 是冗余路径，
     * 正确性不得依赖 startDeconJob 幂等 no-op 兜底）。
     */
    async approveDeconReview(rawInput: unknown): Promise<DeconApproveReviewResult> {
      const raw = rawInput !== null && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : null;
      const jobId = raw !== null && typeof raw.jobId === 'string' && raw.jobId.length > 0 ? raw.jobId : null;
      const checkpointParsed =
        raw !== null && typeof raw.checkpoint === 'string' ? deconReviewCheckpointSchema.safeParse(raw.checkpoint) : null;
      if (jobId === null || checkpointParsed === null || !checkpointParsed.success) {
        return { ok: false, error: 'invalid-input', message: 'decon:approve-review 需要 {jobId, checkpoint（dictionary|canon|craft）}' };
      }
      const checkpoint = checkpointParsed.data;
      if (getDeconJob(jobId) === null) {
        return { ok: false, error: 'not-found', message: `拆解会话 ${jobId} 不存在` };
      }
      const row = getDeconReview(jobId, checkpoint);
      if (row === null) {
        return { ok: false, error: 'invalid-state', message: `闸门行 ${checkpoint} 不存在（会话创建早于闸门机制——本会话不设闸）` };
      }
      if (row.status !== 'pending') {
        return { ok: false, error: 'invalid-state', message: `闸门 ${checkpoint} 状态为 ${row.status}（仅 pending 可确认）` };
      }
      const approved: DeconReviewRow = { ...row, status: 'approved', updatedAt: now().toISOString() };
      upsertDeconReview(approved);
      const started = startDeconJob(jobId, jobDeps);
      if (!started.ok) {
        return { ok: false, error: 'invalid-state', message: `闸门已确认但续跑被拒：${started.message}` };
      }
      if (!started.noop) {
        void runPipeline(jobId).catch((err) => {
          getLogger().warn(
            { err: errMsg(err), jobId },
            'decon:approve-review background pipeline threw (belt - per-pass failures already landed in pass_state/job rows)',
          );
        });
      }
      return { ok: true, review: approved };
    },

    /**
     * `decon:confirm-rerun`——stale 确认重跑（F-02 用户确认面，W7 小补③）：A 的
     * confirmDeconRerun 零改动消费（刷新双指纹为材料现值 + resetDeconRerunState 单事务复位
     * p2+ 台账/canon/B 产物表 + approved 闸门复位 pending）后**自动 start 续跑**（pending→
     * running + 后台管线重入——材料级 P1 按新指纹键控，同指纹产物命中零重付）。材料已删 →
     * material-not-found（无重跑基面，只剩 delete 出路）；非 stale 态 → invalid-state。
     */
    async confirmRerunDecon(rawInput: unknown): Promise<DeconConfirmRerunResult> {
      const jobId = coerceJobId(rawInput);
      if (jobId === undefined) return { ok: false, error: 'invalid-input', message: 'decon:confirm-rerun 需要 jobId' };
      const confirmed = confirmDeconRerun(jobId, jobDeps);
      if (!confirmed.ok) {
        return {
          ok: false,
          error: confirmed.error,
          ...(confirmed.job !== undefined ? { job: confirmed.job } : {}),
          message: confirmed.message,
        };
      }
      const started = startDeconJob(jobId, jobDeps);
      if (!started.ok) {
        return { ok: false, error: 'invalid-state', job: started.job, message: `已确认重跑但续跑被拒：${started.message}` };
      }
      if (!started.noop) {
        void runPipeline(jobId).catch((err) => {
          getLogger().warn(
            { err: errMsg(err), jobId },
            'decon:confirm-rerun background pipeline threw (belt - per-pass failures already landed in pass_state/job rows)',
          );
        });
      }
      return { ok: true, job: started.job };
    },

    /**
     * `decon:products`——product 读面（craft 闸门卡 / 产出阅读的 findings 取数通道，按
     * pass/passStem/unit 过滤控体量）。**passStem = pass 前缀过滤**（CR-8——'p4' 匹配全部
     * `p4:<dim>` **含 p4:style**，风格维排除逻辑留在 UI 消费面；'p3' 匹配 p3a/p3b；与 pass
     * 精确匹配同传时叠加 AND）。前缀过滤在 handler 面做内存过滤（db 读函数不在 B 壳边界内
     * ——主进程行量级千行级，IPC 载荷已被过滤控住——CR-8 主诉面）。**读侧 freshness 门**
     * （F-02 读侧半边——stale/cancelled 不供给产物面，空集 + freshReason）。job 行已删/坏参
     * → fresh=true + 空集（stale/cancelled 语义均不适用；调用方下次 decon:list 自然不见该
     * job——契约无 error 通道的诚实空态）。
     */
    async productsDecon(rawInput: unknown): Promise<DeconProductsResult> {
      const raw = rawInput !== null && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : null;
      const jobId = raw !== null && typeof raw.jobId === 'string' && raw.jobId.length > 0 ? raw.jobId : null;
      const pass = raw !== null && typeof raw.pass === 'string' && raw.pass.length > 0 ? raw.pass : undefined;
      const passStem = raw !== null && typeof raw.passStem === 'string' && raw.passStem.length > 0 ? raw.passStem : undefined;
      const unit = raw !== null && typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : undefined;
      if (jobId === null) return { fresh: true, products: [] };
      const job = getDeconJob(jobId);
      if (job === null) return { fresh: true, products: [] };
      const freshness = checkDeconJobFreshness(job, jobDeps);
      if (!freshness.fresh) {
        return { fresh: false, freshReason: freshness.reason, products: [] };
      }
      const products =
        passStem === undefined
          ? listDeconProducts(jobId, pass, unit)
          : listDeconProducts(jobId, pass, unit).filter((p) => p.pass.startsWith(passStem));
      return { fresh: true, products };
    },

    /**
     * `decon:reports`——报告读面双形态：省略 unit = **列表**（只回 meta——kind/unit/dimension/
     * 更新时间，大书章评数百行不整面灌 renderer；kind 可选过滤）；带 kind + unit = **单取**
     * （回全文行，未命中 report=null）。freshness 门同 decon:products。**坏 kind 串显式拒收**
     * （CR-24）：kind 存在但不在 deconReportKind 枚举内 → `error='invalid-input'` + 双空 +
     * message——不静默降级全列表（additive 可选字段，契约无独立 error 联合以保旧消费者兼容）。
     */
    async reportsDecon(rawInput: unknown): Promise<DeconReportsResult> {
      const raw = rawInput !== null && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : null;
      const jobId = raw !== null && typeof raw.jobId === 'string' && raw.jobId.length > 0 ? raw.jobId : null;
      const kindRaw = raw !== null && typeof raw.kind === 'string' ? raw.kind : null;
      const unit = raw !== null && typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : undefined;
      // CR-24：入参校验先行（job 存在性/freshness 之前——坏输入无需查库）。
      let kind: DeconReportKind | undefined;
      if (kindRaw !== null) {
        const parsed = deconReportKindSchema.safeParse(kindRaw);
        if (!parsed.success) {
          return {
            fresh: true,
            error: 'invalid-input',
            message: `decon:reports kind 串坏（${kindRaw}）——须为 ${DECON_REPORT_KINDS.join('|')} 之一`,
            list: [],
            report: null,
          };
        }
        kind = parsed.data;
      }
      if (jobId === null) return { fresh: true, list: [], report: null };
      const job = getDeconJob(jobId);
      if (job === null) return { fresh: true, list: [], report: null };
      const freshness = checkDeconJobFreshness(job, jobDeps);
      if (!freshness.fresh) {
        return { fresh: false, freshReason: freshness.reason, list: [], report: null };
      }
      if (kind !== undefined && unit !== undefined) {
        return { fresh: true, list: [], report: getDeconReport(jobId, kind, unit) };
      }
      return { fresh: true, list: listDeconReportMetas(jobId, kind), report: null };
    },

    /**
     * `decon:export-style`——风格维导出（4.7 落点）：读 product('p4:style','all') 结构化
     * payload → merge 写目标项目 `settings/style.md`（parseStyleSections 语义键替换/未识别与
     * 手写节及卡头保留/无卡标准 14 节新建）→ **withProjectLock + atomicWrite** 落盘（fs-layer
     * 纪律；CR-4——**读→合并→写同锁**，锁外读=陈旧快照覆写并发写者的更新）+ pathGuard 路径
     * 校验。freshness 门同产物读面（stale 风格锚点不导出）。目标绑定 = 操作时项目上下文
     * （projectId——全局车道材料自身无项目归属）；写前确认与无项目禁用提示归 UI（W6）。
     * writtenSections = 实际写入的节语义键列表。
     */
    async exportStyleDecon(rawInput: unknown): Promise<DeconExportStyleResult> {
      const raw = rawInput !== null && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : null;
      const jobId = raw !== null && typeof raw.jobId === 'string' && raw.jobId.length > 0 ? raw.jobId : null;
      const projectId = raw !== null && typeof raw.projectId === 'string' && raw.projectId.length > 0 ? raw.projectId : null;
      if (jobId === null || projectId === null) {
        return { ok: false, error: 'invalid-input', message: 'decon:export-style 需要 {jobId, projectId}' };
      }
      const job = getDeconJob(jobId);
      if (job === null) {
        return { ok: false, error: 'not-found', message: `拆解会话 ${jobId} 不存在` };
      }
      const freshness = checkDeconJobFreshness(job, jobDeps);
      if (!freshness.fresh) {
        return {
          ok: false,
          error: 'operation-failed',
          message: `材料双指纹失配（${freshness.reason}）——风格产物基面已漂移，导出被拒（确认重跑后再导出）`,
        };
      }
      const product = getDeconProduct(jobId, 'p4:style', 'all');
      const payloadParsed = product === null ? null : deconStylePayloadSchema.safeParse(product.payload);
      if (payloadParsed === null || !payloadParsed.success) {
        return {
          ok: false,
          error: 'style-payload-missing',
          message: '风格维产物缺失（或形状坏）——先跑完 p4:style（档位维度含 style）再导出',
        };
      }
      const payload = payloadParsed.data;
      const record = getProjectById(projectId);
      const projectPath = typeof record?.path === 'string' && record.path.length > 0 ? record.path : null;
      if (projectPath === null) {
        return { ok: false, error: 'project-not-found', message: `项目 ${projectId} 不存在（或无路径）——目标绑定取操作时项目上下文` };
      }
      const target = path.join(path.resolve(projectPath), 'settings', 'style.md');
      try {
        assertSafePath(target); // 注册库路径面（pick-directory allowPath / 项目根内）——逃逸即拒
        // CR-4：读→归一→合并→写**全部在 withProjectLock 回调内**（同锁串行）——锁外读 =
        // 陈旧快照覆写并发写者已落的更新（丢更新面）。既有卡读取带 BOM/CRLF 归一（与 agent
        // readStyleCardBody 同基）；ENOENT = 无卡新建路径。
        const merged = await withProjectLock(projectPath, () => {
          let existingBody: string | null = null;
          try {
            existingBody = normalizeSettingMdContent(readFileSync(target, 'utf-8')) ?? null;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          const result = mergeDeconStyleCard(existingBody, payload, payload.bookTitle ?? '未命名材料');
          // 写串行化（与项目侧风格卡写者互斥）+ 原子落盘（fs-layer 纪律）。
          mkdirSync(path.dirname(target), { recursive: true });
          atomicWriteFileSync(target, result.content, 'utf-8');
          return result;
        });
        return { ok: true, writtenSections: merged.writtenSections };
      } catch (err) {
        getLogger().warn({ err: errMsg(err), jobId, projectId }, 'decon:export-style write failed');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
    },
  };
}

/**
 * 注册拆解管线通道（registerAllIpc 恰调一次；同 channel 二次 ipcMain.handle 会抛错——
 * spec/shell/ipc-handlers.md 注册纪律）。E10.3b W3b：+ decon:approve-review（闸门确认）；
 * W5：+ decon:products / decon:reports（读面）/ decon:export-style（风格导出）；W7 小补③：
 * + decon:confirm-rerun（stale 确认重跑）。
 */
export function registerDeconIpc(): void {
  const handlers = createDeconIpcHandlers();
  ipcMain.handle('decon:create', (_e, input: unknown) => handlers.createDecon(input));
  ipcMain.handle('decon:start', (_e, input: unknown) => handlers.startDecon(input));
  ipcMain.handle('decon:pause', (_e, input: unknown) => handlers.pauseDecon(input));
  ipcMain.handle('decon:cancel', (_e, input: unknown) => handlers.cancelDecon(input));
  ipcMain.handle('decon:delete', (_e, input: unknown) => handlers.deleteDecon(input));
  ipcMain.handle('decon:get', (_e, input: unknown) => handlers.getDecon(input));
  ipcMain.handle('decon:list', (_e, input: unknown) => handlers.listDecon(input));
  ipcMain.handle('decon:approve-review', (_e, input: unknown) => handlers.approveDeconReview(input));
  ipcMain.handle('decon:confirm-rerun', (_e, input: unknown) => handlers.confirmRerunDecon(input));
  ipcMain.handle('decon:products', (_e, input: unknown) => handlers.productsDecon(input));
  ipcMain.handle('decon:reports', (_e, input: unknown) => handlers.reportsDecon(input));
  ipcMain.handle('decon:export-style', (_e, input: unknown) => handlers.exportStyleDecon(input));
}
