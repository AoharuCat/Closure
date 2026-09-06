/**
 * 「拆书」页纯视图 helpers（E10.3b W6，design §8）——零 React 零 IPC，可直测。
 *
 * - **状态横幅判定**（design §8 ③）：running/paused/闸门暂停（review 行 pending = 等审——
 *   与用户暂停在 job 行同态，区分靠 review 行）/capped（提示调预算）/stale（提示确认重跑）/
 *   failed（error 文案）/done/cancelled。
 * - **材料过滤（F-12）**：low-confidence 分章/零章材料不可拆（单伪章拆书无意义）——过滤 +
 *   提示先重摄取或校对。
 * - **档位 × 维度校验（客户端 mirror）**：coarse ⊆ {style} / fine 手艺维 1-3 + style 不计 /
 *   deep 全 12 手艺维必含 + style 可选（权威在 shell deconBudget——UI 侧预检省一次 IPC 往返）。
 * - **pass 摘要**：pass_state 千行（大书逐章）不整面灌——按 pass 聚合 done/total。
 * - **产物 payload 形态守卫**（spec/ui/state-management：unknown seam 须形态守卫）：
 *   product.payload 是 z.unknown()，p4 findings / p4:style 消费前过守卫。
 * - 耗时格式化复用 craftView.formatElapsedMs（跨 feature 导入先例：MaterialsPage 消费
 *   materialDistillBadge）。
 */
import { DECON_DIMENSIONS } from '@orison/shared-contracts';
import type {
  DeconJob,
  DeconJobStatus,
  DeconPassState,
  DeconReviewRow,
  DeconTier,
  MaterialSummary,
} from '@orison/shared-contracts';
import { formatElapsedMs } from '../craft/craftView';

export { formatElapsedMs };

// ── 状态徽章 / 横幅（design §8 ③ 运行相位可见纪律）──

/** job 状态 → materials-badge 色档（复用材料页徽章类族，decon.css 不另起配色）。 */
export function deconStatusBadgeClass(status: DeconJobStatus): string {
  switch (status) {
    case 'pending':
      return 'materials-badge--amber';
    case 'running':
      return 'materials-badge--ok';
    case 'paused':
      return 'materials-badge--amber';
    case 'capped':
      return 'materials-badge--amber';
    case 'stale':
      return 'materials-badge--warn';
    case 'failed':
      return 'materials-badge--danger';
    case 'done':
      return 'materials-badge--ok';
    case 'cancelled':
      return 'materials-badge--warn';
  }
}

export type DeconBannerKind =
  | 'pending'
  | 'running'
  | 'gate-paused'
  | 'paused'
  | 'capped'
  | 'stale'
  | 'failed'
  | 'done'
  | 'cancelled';

/**
 * 状态横幅判定：**闸门暂停优先**（job 行与用户暂停同态 paused——区分靠 review 行 pending =
 * 等审，design §6「UI 按 review 行区分等审」）。capped/stale/failed 各带提示语义（调预算/
 * 确认重跑/error 文案）。
 */
export function deconBannerKind(job: DeconJob, reviews: readonly DeconReviewRow[]): DeconBannerKind {
  if (job.status === 'paused' && deconPendingReview(reviews) !== null) return 'gate-paused';
  return job.status;
}

/** 首个 pending 闸门 checkpoint（null = 无等审闸门）。 */
export function deconPendingReview(
  reviews: readonly DeconReviewRow[] | undefined,
): DeconReviewRow | null {
  if (reviews === undefined) return null;
  return reviews.find((r) => r.status === 'pending') ?? null;
}

// ── i18n 键路由（单源——组件不散落硬编码）──

export function deconTierLabelKey(tier: DeconTier): string {
  return `decon.tier.${tier}`;
}

export function deconStatusKey(status: DeconJobStatus): string {
  return `decon.status.${status}`;
}

/** 维度 label 键（契约 DECON_DIMENSIONS 的 label 是 zh 单语——en 侧走 i18n 键）。 */
export function deconDimensionLabelKey(id: string): string {
  return `decon.dim.${id}`;
}

export function deconReviewCheckpointKey(checkpoint: string): string {
  return `decon.review.${checkpoint}`;
}

/**
 * pass 标签路由：茎（p1a/p1b/p3a…）走 `decon.pass.<茎>`；带后缀的 p4:<dim> / p5:<kind> 走
 * `decon.pass.p4` / `decon.pass.p5` + 后缀键（维度/报告 kind 的 label 由调用方 t() 拼）。
 */
export function deconPassLabel(pass: string): { stemKey: string; suffixKeys: string[] } {
  if (pass.startsWith('p4:')) {
    return { stemKey: 'decon.pass.p4', suffixKeys: [deconDimensionLabelKey(pass.slice(3))] };
  }
  if (pass.startsWith('p5:')) {
    return { stemKey: 'decon.pass.p5', suffixKeys: [`decon.reportKind.${pass.slice(3)}`] };
  }
  return { stemKey: `decon.pass.${pass}`, suffixKeys: [] };
}

/**
 * pass_state unit 友好形：数字形态（'3' / 'ch:12' / 'arc:2' / 'scene:5'）的 N 是 **0 基索引**
 * （chapterIndex / arc index / scene rank——契约单源），呈现统一 **1 基**（「第 N+1 章」——CR-2
 * 与壳面 prompt/报告渲染同面，同一章跨面同号）。'all'/'arcs'/'stats' 单行哨兵走专项键
 * （progress 路径与 report 路径共用——CR-17）；其余字面 unit（如 p2 域名 'world'）返回 null
 * 由调用方回落原样。
 */
export function deconUnitLabelKey(unit: string): { key: string; index?: number } | null {
  if (/^[0-9]+$/.test(unit)) return { key: 'decon.unit.chapter', index: Number(unit) + 1 };
  if (unit.startsWith('ch:')) return { key: 'decon.unit.chapter', index: Number(unit.slice(3)) + 1 };
  if (unit.startsWith('arc:')) return { key: 'decon.unit.arc', index: Number(unit.slice(4)) + 1 };
  if (unit.startsWith('scene:')) return { key: 'decon.unit.scene', index: Number(unit.slice(6)) + 1 };
  if (unit === 'all') return { key: 'decon.unit.all' };
  if (unit === 'arcs') return { key: 'decon.unit.arcs' };
  if (unit === 'stats') return { key: 'decon.unit.stats' };
  return null;
}

// ── pass_state 摘要（千行不整面灌——按 pass 聚合 done/total）──

export type DeconPassSummary = {
  pass: string;
  total: number;
  done: number;
  running: number;
  failed: number;
  capped: number;
  pending: number;
};

/** 按 pass 全值聚合 unit 行（p1b 的 300 章行 → 一行 done 217/300）。保持首现序。 */
export function summarizeDeconPassStates(
  passStates: readonly DeconPassState[],
): DeconPassSummary[] {
  const order: string[] = [];
  const byPass = new Map<string, DeconPassSummary>();
  for (const row of passStates) {
    let summary = byPass.get(row.pass);
    if (summary === undefined) {
      summary = { pass: row.pass, total: 0, done: 0, running: 0, failed: 0, capped: 0, pending: 0 };
      byPass.set(row.pass, summary);
      order.push(row.pass);
    }
    summary.total += 1;
    summary[row.status] += 1;
  }
  return order.map((pass) => byPass.get(pass)!);
}

// ── 材料过滤（F-12——low-confidence 分章/零章不可拆）──

export type DeconMaterialPool = {
  /** 可拆材料（ready + 有章 + 分章置信非 low）。 */
  eligible: MaterialSummary[];
  /** 被过滤材料（列表呈现提示——先重摄取或校对）。 */
  excluded: MaterialSummary[];
};

/**
 * 拆书材料资格（F-12）：`status==='ready'`（pending/failed 不可拆——craft 蒸馏同门）+
 * `chapterCount > 0`（零章 = 伪单章，拆书无意义）+ `chapterConfidence !== 'low'`
 * （low-confidence 分章先重摄取或校对）。两车道合并去重归调用方（mirror craft 池）。
 */
export function deconEligibleMaterials(materials: readonly MaterialSummary[]): DeconMaterialPool {
  const eligible: MaterialSummary[] = [];
  const excluded: MaterialSummary[] = [];
  for (const m of materials) {
    if (m.status !== 'ready' || m.chapterCount <= 0 || m.chapterConfidence === 'low') {
      excluded.push(m);
    } else {
      eligible.push(m);
    }
  }
  return { eligible, excluded };
}

// ── 档位 × 维度选择（客户端 mirror——权威在 shell validateDeconDimensions）──

/** 档位可见维度目录（design §3.1：coarse 只显风格维）。 */
export function deconDimensionsForTier(tier: DeconTier): typeof DECON_DIMENSIONS {
  if (tier === 'coarse') return DECON_DIMENSIONS.filter((d) => d.id === 'style');
  return DECON_DIMENSIONS;
}

/** deep 预填集（全 12 手艺维；style 可选不预选）。 */
export function deconDeepPrefilledDimensions(): string[] {
  return DECON_DIMENSIONS.filter((d) => d.id !== 'style').map((d) => d.id);
}

/**
 * 维度选择合法性（客户端预检）：coarse ⊆ {style} / fine 手艺维 1-3（style 可选不计入）/
 * deep 全 12 手艺维必含（style 可选）。
 */
export function deconDimensionSelectionIsValid(tier: DeconTier, selected: readonly string[]): boolean {
  const craftSelected = selected.filter((id) => id !== 'style');
  const known = new Set(DECON_DIMENSIONS.map((d) => d.id));
  if (selected.some((id) => !known.has(id))) return false;
  switch (tier) {
    case 'coarse':
      return craftSelected.length === 0;
    case 'fine':
      return craftSelected.length >= 1 && craftSelected.length <= 3;
    case 'deep':
      return craftSelected.length === 12;
  }
}

// ── 成本预估卡（design §8 ②——create 回执呈现）──

/**
 * 预估行：byPass 键 = pass 全值。**P1 复用打折标记改由 `inherited` 旗标驱动**（CR-18）——
 * 真实数据下继承 pass **不在 byPass**（shell estimateDeconCost 对 p1Reusable 直接省略该行），
 * 故按旗标合成注记行（tokens=0——零重付是事实，徽章文案解释）；byPass 恰含同茎行时（防御）
 * 就标在该行。
 */
export function deconEstimateRows(
  estimate: { totalTokens: number; byPass: Record<string, number> },
  inherited: { p1a: boolean; p1b: boolean; p1c: boolean },
): Array<{ pass: string; tokens: number; inherited: boolean }> {
  const inheritedStems = new Set(
    (['p1a', 'p1b', 'p1c'] as const).filter((stem) => inherited[stem]),
  );
  const rows = Object.entries(estimate.byPass).map(([pass, tokens]) => ({
    pass,
    tokens,
    inherited: inheritedStems.has(pass.split(':')[0] as 'p1a' | 'p1b' | 'p1c'),
  }));
  // 继承注记行合成（CR-18：不依赖 byPass 行存在——estimate 对继承 pass 省行）。
  for (const stem of ['p1a', 'p1b', 'p1c'] as const) {
    if (!inherited[stem]) continue;
    if (estimate.byPass[stem] !== undefined) continue; // 已有行——徽章标在行上
    rows.push({ pass: stem, tokens: 0, inherited: true });
  }
  return rows.sort((a, b) => a.pass.localeCompare(b.pass));
}

// ── 向导预算输入解析（CR-23——NaN 不静默吞）──

/**
 * 预算输入解析：空串/纯空白 → 无预算（null）；非数字（`Number.isNaN`）→ 拒收 `nan`；
 * 非正数/非有限（Infinity 等）→ 拒收 `invalid`。注：`<input type="number">` 的 IDL value 对
 * 非法输入恒回落空串（浏览器/jsdom 同为）——NaN 分支是防御面（程序设值/未来输入形态），
 * 纯函数直测覆盖（组件 fireEvent 造不出非空非数字值）。
 */
export function parseDeconBudgetInput(
  raw: string,
): { ok: true; budget: number | null } | { ok: false; reason: 'nan' | 'invalid' } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, budget: null };
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) return { ok: false, reason: 'nan' };
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, reason: 'invalid' };
  return { ok: true, budget: parsed };
}

// ── 产物 payload 形态守卫（unknown seam——spec/ui/state-management）──

/** p4:<dim> findings payload 守卫（product.payload 是 z.unknown()——渲染前形态核验防 TypeError 白屏）。 */
export function isDeconFindingsLike(
  value: unknown,
): value is {
  findings: Array<{
    insight: string;
    elaboration: string;
    evidence: Array<{ paraRange: { start: number; end: number }; quote: string }>;
    craftHint: { category?: string; termHint?: string; tags?: string[] } | null;
  }>;
  synthesis: string;
} {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.findings) || typeof v.synthesis !== 'string') return false;
  for (const f of v.findings) {
    if (f === null || typeof f !== 'object') return false;
    const finding = f as Record<string, unknown>;
    if (typeof finding.insight !== 'string' || typeof finding.elaboration !== 'string') return false;
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) return false;
    for (const e of finding.evidence) {
      if (e === null || typeof e !== 'object') return false;
      const ev = e as Record<string, unknown>;
      const range = ev.paraRange as Record<string, unknown> | undefined;
      if (
        range === null ||
        typeof range !== 'object' ||
        typeof range.start !== 'number' ||
        typeof range.end !== 'number' ||
        typeof ev.quote !== 'string'
      ) {
        return false;
      }
    }
    if (
      finding.craftHint !== null &&
      finding.craftHint !== undefined &&
      typeof finding.craftHint !== 'object'
    ) {
      return false; // craftHint 形状只影响落卡路由——守卫放宽为「null 或对象」由消费侧再读
    }
  }
  return true;
}

/** p4:style 14 节 payload 守卫（sections 值皆字符串 + 纯代码三节必出——mirror 契约 refine）。 */
export function isDeconStylePayloadLike(
  value: unknown,
): value is { sections: Record<string, string>; bookTitle: string | null; materialId: string } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const sections = v.sections;
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) return false;
  const record = sections as Record<string, unknown>;
  for (const val of Object.values(record)) {
    if (typeof val !== 'string' || val.length === 0) return false;
  }
  // 契约 refine：stats/excerpt/appendix 纯代码三节必出。
  return (
    typeof record.stats === 'string' &&
    typeof record.excerpt === 'string' &&
    typeof record.appendix === 'string' &&
    (v.bookTitle === null || typeof v.bookTitle === 'string') &&
    typeof v.materialId === 'string'
  );
}

// ── 报告 unit / kind 展示 ──

/**
 * report unit 友好形（'ch:12' → 第 13 章〔0 基 +1——CR-2〕；'scene:3' → 名场面 4；'all'/
 * 'arcs'/'stats' → 专项键；其余字面回落 literal 键）。完全委托 deconUnitLabelKey——progress
 * 与 report 两路径同一单源（CR-17）。
 */
export function deconReportUnitLabelKey(unit: string): { key: string; index?: number } {
  const parsed = deconUnitLabelKey(unit);
  if (parsed !== null) return parsed;
  return { key: 'decon.unit.literal' };
}
