import type {
  DeconChapterFacts,
  DeconEntity,
  DeconEntityType,
  DeconJob,
  Material,
} from '@orison/shared-contracts';
import { DECON_PASS_UNIT_ALL } from '@orison/shared-contracts';
import {
  getDeconPassState,
  listDeconChapterFacts,
  listDeconEntities,
  replaceDeconEntitiesWithPassState,
} from '../db/closure-decon';
import { getMaterialRow } from '../db/materialIndexer';
import { getLogger } from '../logger';
import {
  DECON_LLM_RETRY_ESCALATE,
  DECON_STALE_NOTE,
  capDeconUnit,
  deconErrMsg,
  estimateDeconCallTokens,
  failDeconUnit,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  resolveDeconActualTokens,
  sha256DeconContent,
  writeDeconCost,
} from './deconRun';
import { getDeconLlmCore, type DeconGenerateText } from './deconLlmCore';
import { accumulateDeconCost, wouldExceedDeconBudget } from './deconBudget';
import { decideDeconPassReentry, extractMaterialId, hashDeconEntitiesOutput, transitionDeconJob } from './deconJob';

// ── E10.3a（task 09-05）W5：P1c 跨章聚合消歧（parent design §2.1 P1c / §3 消歧三件套）──
//
// 三件套（范式判据 parent design §9 P1c 行——聚类/投票/存在性过滤纯代码，低置信合并裁决 LLM）：
//   1. **别名聚类**：纯代码候选对（包含关系「赵灵儿/灵儿」型 + 编辑距离 ≤1「赵灵儿/赵灵兒」异体
//      写法型）+ **桥接阻断**（parent design §3：相似名但归属类型冲突 / 集体引用词「众人/兄弟们」
//      / **高频同场共现**〔沙僧八戒式——真别名极少同场出现，常同场的相似名是两个实体〕不并）；
//      置信三档：高（自动并）/ 中（LLM 裁决——getDeconLlmCore review-judge 温 0.2，约束式候选对
//      输入：只许对给出编号对作 sameEntity 判定，禁自创编号）/ 低（不并留分离实体）。
//   2. **类型投票**：跨章出现类型多数票（按条目数加权，平票字典序——确定性）。
//   3. **幻觉过滤**：canonical 名 + 全部别名对派生 .md 全文字符串存在性检查——**零命中剔除并写
//      audit 行**（closure_decon_entity.audit_json.hallucinationFiltered=true——AI-Reader-V2 issue #30
//      存在性检查模式；行保留供观测，下游 canon 装配/消费按 audit 标记排除）。
//
// 断点：pass='p1c' unit='all' 单行（decideDeconPassReentry——done+hash 一致 skip 不重付 LLM）；
// capped 预算门前置（裁决调用前判，超限不烧 token）；产物+pass_state 同事务落库
// （replaceDeconEntitiesWithPassState）。stale：派生 .md 现值 hash ≠ job 快照 → job=stale。
//
// expected_downstream_consumers:
// - W5 p2Canon（character/relationship 域装配输入——按 audit.hallucinationFiltered!==true 过滤）。
// - child B P3 计量（实体出现统计）/金标实体抽样核对（产出形状可核对）。

// ── 常量（阈值推测值起步——dogfood 首本标定，mirror p1Dictionary 常量纪律）──

/**
 * 集体引用词封锁表（桥接阻断面）：泛称指代非实体——出现于 facts 实体名时整条观测丢弃
 * （「众人/兄弟们」不该成为 canon 角色）。P1a 停用词表外的补丁面（facts 由 LLM 产出，
 * 词典约束不能完全挡住泛称）。
 */
export const DECON_P1C_COLLECTIVE_REFS: ReadonlySet<string> = new Set([
  '众人',
  '大家',
  '兄弟们',
  '姐妹们',
  '诸人',
  '所有人',
  '两人',
  '三人',
  '几人',
  '众人等',
]);

/**
 * 同场共现复审阈（CR-11 修订：共现不再硬阻断——相似名常同场〔沙僧八戒式〕改走 **LLM 裁决**
 * medium 档〔prompt 上下文行含共现章，裁判自判〕；硬阻断只留类型冲突 + 集体引用）。
 * 推测值 dogfood 标定。
 */
export const DECON_P1C_COOCCUR_REVIEW_MIN_CHAPTERS = 2;
export const DECON_P1C_COOCCUR_REVIEW_RATIO = 0.5;

/**
 * 同位语（apposition）通道候选对上限（CR-11：不相似名对〔「二郎神/杨戬」型——containment/
 * lev-1 均不命中〕原先无任何裁决通道；按共现强度 top-K 进裁决，O(n²) 候选空间的预算常量）。
 */
export const DECON_P1C_APPOSITION_MAX_PAIRS = 20;

/** 同位语通道双方最少出现章数（单章实体共现 = 弱信号 + 候选空间爆炸——剪枝）。 */
export const DECON_P1C_APPOSITION_MIN_CHAPTERS = 2;

/**
 * 裁决输出 token 预算（**每批独立核算**——CR-12：裁决对 O(n²) 无上界 vs 4096；每批 ≤30 对
 * × 每条 {"pairId","sameEntity"} ≈ 10 tokens ≈ 300）。
 *
 * 2048 → 8192（dogfood R3 F13 实证）：2048 帽下 deepseek-v4-flash（thinking off）别名裁决
 * 连续两次 finishReason=length 确定性截断——flash 系输出带 ~2-4K 固定对话性包袱，帽须按
 * 「模型最低输出开销 + JSON 体」核算而非纯 JSON 体；对齐 seam 缺省 belt 8192。
 */
export const DECON_P1C_ADJUDICATE_MAX_TOKENS = 8192;

/** 裁决分批大小（CR-12——批间独立预算门/纠偏重试/记账）。 */
export const DECON_P1C_ADJUDICATE_BATCH_SIZE = 30;

// ── 观测构建（纯代码——facts 行 → 名字级观测聚合）──

/** 单名观测：章出现（章 → 条目数）+ 类型票仓（类型 → 条目数）。 */
export interface DeconEntityObservation {
  name: string;
  chapters: Map<number, number>;
  typeVotes: Record<string, number>;
}

/**
 * facts 行 → 观测聚合（纯代码）：同名跨章合并条目数与类型票。集体引用词观测整条丢弃
 * （droppedCollective 计数诚实回报——泛称不是实体）。
 */
export function buildDeconEntityObservations(
  factsRows: readonly DeconChapterFacts[],
): { observations: DeconEntityObservation[]; droppedCollective: number } {
  const byName = new Map<string, DeconEntityObservation>();
  let droppedCollective = 0;
  for (const row of factsRows) {
    for (const e of row.facts.entities) {
      if (DECON_P1C_COLLECTIVE_REFS.has(e.name)) {
        droppedCollective += 1;
        continue;
      }
      const obs = byName.get(e.name) ?? { name: e.name, chapters: new Map<number, number>(), typeVotes: {} };
      obs.chapters.set(row.chapterIndex, (obs.chapters.get(row.chapterIndex) ?? 0) + 1);
      obs.typeVotes[e.type] = (obs.typeVotes[e.type] ?? 0) + 1;
      byName.set(e.name, obs);
    }
  }
  const observations = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { observations, droppedCollective };
}

/** 多数票类型（平票字典序最小——确定性；零票 → null）。 */
export function majorityDeconObservationType(obs: DeconEntityObservation): DeconEntityType | null {
  const entries = Object.entries(obs.typeVotes);
  if (entries.length === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [type, count] of entries) {
    if (count > bestCount || (count === bestCount && best !== null && type < best)) {
      best = type;
      bestCount = count;
    }
  }
  return best as DeconEntityType | null;
}

/** 编辑距离 ≤1 判定（短名专用——异体写法/错字；O(n) 双指针）。 */
export function isDeconEditDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return true;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}

// ── 别名聚类候选（纯代码——三档置信 + 同位语通道）──

export type DeconAliasTier = 'high' | 'medium' | 'low';

/** 候选对判定（观测面留痕——audit/统计消费）。 */
export interface DeconAliasPairDecision {
  a: string;
  b: string;
  tier: DeconAliasTier;
  reason: 'containment' | 'edit-distance-1' | 'type-conflict' | 'co-occurrence-review' | 'apposition';
}

/** 聚类候选产出：自动并对（high）+ 待裁决对（medium）+ 全部判定审计。 */
export interface DeconAliasCandidates {
  autoPairs: Array<{ a: string; b: string }>;
  pendingAdjudication: Array<{ pairId: string; a: string; b: string }>;
  decisions: DeconAliasPairDecision[];
}

/**
 * 别名候选对生成（纯代码，确定性；CR-11 修订版）：
 * - **相似名对**（包含关系 / 编辑距离 ≤1）：类型冲突 → low 硬阻断（仅存的硬阻断之一）；高频
 *   同场共现（≥2 章 且 比率 ≥0.5）→ medium「co-occurrence-review」（沙僧八戒式**改走裁决**，
 *   不再硬阻断——prompt 上下文行含共现章供裁判判别）；否则 containment=高（自动并）、
 *   edit-distance-1=中（裁决）。
 * - **同位语通道**（CR-11 新增）：不相似名对（「二郎神/杨戬」型——原先无任何通道）双方同型
 *   （多数票）且各 ≥2 章出现且确有共现——按共现强度（cooc / min 章数）降序取 top-K
 *   （DECON_P1C_APPOSITION_MAX_PAIRS 预算常量）进 medium 裁决。apposition 名对常同场出现
 *   （「杨戬，人称二郎神」），共现强度即通道信号。
 * - 集体引用词在观测面已丢弃（对级仅防御跳过）。
 */
export function clusterDeconAliasCandidates(observations: readonly DeconEntityObservation[]): DeconAliasCandidates {
  const obsByName = new Map(observations.map((o) => [o.name, o]));
  const names = [...observations.map((o) => o.name)].sort(); // 字典序——对枚举序确定性
  const autoPairs: DeconAliasCandidates['autoPairs'] = [];
  const pendingAdjudication: DeconAliasCandidates['pendingAdjudication'] = [];
  const decisions: DeconAliasPairDecision[] = [];
  const coocChapters = (a: string, b: string): number => {
    const chaptersB = obsByName.get(b)!.chapters;
    let cooc = 0;
    for (const ch of obsByName.get(a)!.chapters.keys()) if (chaptersB.has(ch)) cooc += 1;
    return cooc;
  };
  const appositionPool: Array<{ a: string; b: string; strength: number }> = [];
  const pushPending = (a: string, b: string): void => {
    pendingAdjudication.push({ pairId: String(pendingAdjudication.length), a, b });
  };

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      if (DECON_P1C_COLLECTIVE_REFS.has(a) || DECON_P1C_COLLECTIVE_REFS.has(b)) continue; // 观测面已丢弃（防御）
      const containment = (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 2;
      const lev1 = isDeconEditDistanceAtMostOne(a, b);
      if (containment && lev1 && a === b) continue; // 同名不构成对（防御）
      const obsA = obsByName.get(a)!;
      const obsB = obsByName.get(b)!;
      const typeA = majorityDeconObservationType(obsA);
      const typeB = majorityDeconObservationType(obsB);
      const cooc = coocChapters(a, b);
      if (containment || lev1) {
        // 相似名对：类型冲突硬阻断；高频共现复审；其余 containment 自动并 / lev-1 裁决。
        if (typeA !== null && typeB !== null && typeA !== typeB) {
          decisions.push({ a, b, tier: 'low', reason: 'type-conflict' });
          continue;
        }
        const minChapters = Math.min(obsA.chapters.size, obsB.chapters.size);
        if (
          minChapters > 0 &&
          cooc >= DECON_P1C_COOCCUR_REVIEW_MIN_CHAPTERS &&
          cooc / minChapters >= DECON_P1C_COOCCUR_REVIEW_RATIO
        ) {
          decisions.push({ a, b, tier: 'medium', reason: 'co-occurrence-review' });
          pushPending(a, b);
          continue;
        }
        if (containment) {
          decisions.push({ a, b, tier: 'high', reason: 'containment' });
          autoPairs.push({ a, b });
        } else {
          decisions.push({ a, b, tier: 'medium', reason: 'edit-distance-1' });
          pushPending(a, b);
        }
        continue;
      }
      // 不相似名对：同位语通道候选（同型 + 双方多章 + 确有共现）——top-K 强度排序后进裁决。
      if (typeA === null || typeB === null || typeA !== typeB) continue;
      if (obsA.chapters.size < DECON_P1C_APPOSITION_MIN_CHAPTERS || obsB.chapters.size < DECON_P1C_APPOSITION_MIN_CHAPTERS) continue;
      if (cooc < 1) continue;
      const strength = cooc / Math.min(obsA.chapters.size, obsB.chapters.size);
      appositionPool.push({ a, b, strength });
    }
  }
  appositionPool.sort((x, y) =>
    y.strength - x.strength !== 0 ? y.strength - x.strength : x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1,
  );
  for (const { a, b } of appositionPool.slice(0, DECON_P1C_APPOSITION_MAX_PAIRS)) {
    decisions.push({ a, b, tier: 'medium', reason: 'apposition' });
    pushPending(a, b);
  }
  return { autoPairs, pendingAdjudication, decisions };
}

/** 并查集合并（纯代码——approved 对并组；组按字典序输出确定性）。 */
export function mergeDeconAliasGroups(names: readonly string[], pairs: ReadonlyArray<{ a: string; b: string }>): string[][] {
  const parent = new Map<string, string>(names.map((n) => [n, n]));
  const find = (n: string): string => {
    let root = n;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = n;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const p of pairs) {
    if (!parent.has(p.a) || !parent.has(p.b)) continue;
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const root = find(n);
    const group = groups.get(root) ?? [];
    group.push(n);
    groups.set(root, group);
  }
  return [...groups.values()].map((g) => [...g].sort()).sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0));
}

// ── 约束式 LLM 裁决（spec core/creative-vs-mechanical.md Pattern——候选行约束式镜像）──

export const DECON_P1C_ADJUDICATE_SYSTEM_PROMPT = [
  '你是小说实体消歧的裁判。下面给你若干对名字（来自同一本小说的实体提取结果——可能是同一实体的不同写法/别名，也可能是两个不同实体）。',
  '判断线索：',
  '- 同一实体：同一对象的本名/昵称/别名/异体字写法（如「赵灵儿/灵儿」「赵灵儿/赵灵兒」），通常不会在同一场景里两种写法同时出现；',
  '- 不同实体：相似但实际是两个角色/两个地点（常一同出场互动），或一个是人名一个是地名/物名。',
  '规则：只能对给出的编号对作判断，禁止自创编号或改写名字。每条输出 {"pairId":"编号","sameEntity":true} 或 {"pairId":"编号","sameEntity":false}。',
  '输出纯 JSON 数组，不要任何解释或前后缀。',
].join('\n');

/** 裁决 user prompt（纯函数，导出供直测/断言——候选对 + 上下文行）。 */
export function buildDeconAdjudicationUserPrompt(
  pairs: ReadonlyArray<{ pairId: string; a: string; b: string }>,
  observations: readonly DeconEntityObservation[],
  corrective = false,
): string {
  const obsByName = new Map(observations.map((o) => [o.name, o]));
  const contextRow = (name: string): string => {
    const obs = obsByName.get(name);
    if (obs === undefined) return `${name} | 无观测`;
    const chapters = [...obs.chapters.keys()].sort((x, y) => x - y).join(',');
    const type = majorityDeconObservationType(obs) ?? '未知';
    const total = [...obs.chapters.values()].reduce((s, v) => s + v, 0);
    return `${name} | ${type} | ${total} 次 | 章 ${chapters}`;
  };
  return [
    '【待判定的名字对（编号 | 名字A | 名字B——各自的类型/出现次数/出现章）】',
    ...pairs.map((p) => `${p.pairId} | ${contextRow(p.a)} | ${contextRow(p.b)}`),
    '',
    `共 ${pairs.length} 对。对每一对判定是否为同一实体，输出 JSON 数组。`,
    ...(corrective ? ['', '注意：上一次输出包含未知编号或坏形状条目，已被整体拒收。只能对给出的编号作判定。'] : []),
  ].join('\n');
}

/**
 * 解析裁决响应（约束校验）：坏 JSON / 非数组 / 条目缺 pairId/sameEntity 非布尔 / pairId 不在
 * 候选集 / **pairId 重复**（CR-11：重复即自相矛盾信号——静默 last-wins 会掩蔽裁判错乱）→
 * null **整体拒收**（不部分采纳）；LLM 漏答的对 → sameEntity=false（保守不并）。
 */
export function parseDeconAdjudicationResponse(
  raw: string,
  pairIds: ReadonlySet<string>,
): Map<string, boolean> | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const verdicts = new Map<string, boolean>();
  for (const el of arr) {
    if (el === null || typeof el !== 'object') return null;
    const r = el as Record<string, unknown>;
    if (typeof r.pairId !== 'string' || typeof r.sameEntity !== 'boolean') return null;
    if (!pairIds.has(r.pairId)) return null; // 集外编号 = 幻觉 → 整体拒收
    if (verdicts.has(r.pairId)) return null; // 重复编号 = 裁判错乱 → 整体拒收（CR-11）
    verdicts.set(r.pairId, r.sameEntity);
  }
  return verdicts;
}

// ── P1c 编排（job 门 → 指纹校验 → 断点重入 → 观测/聚类/裁决/过滤 → 同事务落库）──

export interface DeconP1cStats {
  observedNames: number;
  droppedCollective: number;
  clusters: number;
  mergedClusters: number;
  adjudicationAttempts: number;
  adjudicationApproved: number;
  entities: number;
  hallucinationFiltered: number;
  droppedAliases: number;
}

export type DeconP1cResult =
  | { status: 'done'; skipped: boolean; entities: DeconEntity[]; stats: DeconP1cStats }
  | { status: 'capped'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'stale'; message: string }
  | { status: 'paused' }
  | { status: 'cancelled' };

export interface DeconP1cDeps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  now?: () => Date;
}

/** 运行门停因 → runner 结果映射（CR-7——cancelled/not-found 静默停）。 */
function gateStopToP1cResult(gate: { stop: string; message: string }): DeconP1cResult {
  switch (gate.stop) {
    case 'paused':
      return { status: 'paused' };
    case 'cancelled':
    case 'not-found':
      return { status: 'cancelled' };
    case 'stale':
      return { status: 'stale', message: gate.message };
    default:
      return { status: 'failed', message: gate.message };
  }
}

/**
 * 跑 P1c（pass='p1c'，unit='all' 单行）。断点语义（W2 decideDeconPassReentry）：
 * done + 实体组 hash 一致 → skip（跨 job 继承/重入零重算）；capped-hold → 本次尝试
 * （预算门决定放行或再 cap）。裁决调用（如有 medium 对，**分批串行** CR-12：每批 ≤
 * DECON_P1C_ADJUDICATE_BATCH_SIZE 对，批间独立预算门/纠偏重试/记账）——超限 capped 不烧
 * token。产物（closure_decon_entity 整组替换）+ pass_state done 同事务落库。
 */
export async function runDeconP1c(jobId: string, deps: DeconP1cDeps = {}): Promise<DeconP1cResult> {
  const nowIso = () => (deps.now ?? (() => new Date()))().toISOString();

  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) return gateStopToP1cResult(gate);
  const job: DeconJob = gate.job;

  const material = getMaterialRow(extractMaterialId(job.materialRef));
  if (material === null) {
    const message = `材料 ${job.materialRef} 不存在（或已删除）`;
    failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
    return { status: 'failed', message };
  }
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    const message = '派生 .md 读取失败（缺失或车道不可解析）——无法锚定聚合基面';
    failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
    return { status: 'failed', message };
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }

  // 断点重入（done+hash 一致 skip；capped-hold 落到下方预算门再试）。
  const existingEntities = listDeconEntities(job.materialRef, job.derivedHash);
  const state = getDeconPassState(jobId, 'p1c', DECON_PASS_UNIT_ALL);
  const decision = decideDeconPassReentry(
    state,
    existingEntities.length > 0 ? hashDeconEntitiesOutput(existingEntities) : null,
  );
  if (decision === 'skip') {
    return {
      status: 'done',
      skipped: true,
      entities: existingEntities,
      stats: emptyStats(existingEntities.length),
    };
  }

  const factsRows = listDeconChapterFacts(job.materialRef, job.derivedHash);
  if (factsRows.length === 0) {
    const message = '逐章 facts 不存在（closure_decon_facts 无同指纹行）——先跑 P1b 再跑 P1c';
    failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
    return { status: 'failed', message };
  }

  const { observations, droppedCollective } = buildDeconEntityObservations(factsRows);
  const candidates = clusterDeconAliasCandidates(observations);

  // 中档裁决（约束式——CR-12 分批串行：每批独立预算门/纠偏重试/记账；两次整体拒收诚实挂起）。
  const approvedPairs: Array<{ a: string; b: string }> = [];
  let attempts = 0;
  let cost = job.cost;
  if (candidates.pendingAdjudication.length > 0) {
    const generate = deps.generateText ?? getDeconLlmCore()?.generateText;
    if (generate === undefined) {
      const message = '拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试';
      failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
      return { status: 'failed', message };
    }
    const verdicts = new Map<string, boolean>();
    for (let batchStart = 0; batchStart < candidates.pendingAdjudication.length; batchStart += DECON_P1C_ADJUDICATE_BATCH_SIZE) {
      const batch = candidates.pendingAdjudication.slice(batchStart, batchStart + DECON_P1C_ADJUDICATE_BATCH_SIZE);
      const pairIds = new Set(batch.map((p) => p.pairId));
      let batchVerdicts: Map<string, boolean> | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const user = buildDeconAdjudicationUserPrompt(batch, observations, attempt > 0);
        // C3：attempt>0 升帽 ×2（JSON 纠偏环语义保留——升帽给截断重试留输出余量；est 按当次帽过门）。
        const cap = attempt > 0 ? DECON_P1C_ADJUDICATE_MAX_TOKENS * DECON_LLM_RETRY_ESCALATE : DECON_P1C_ADJUDICATE_MAX_TOKENS;
        const est = estimateDeconCallTokens(DECON_P1C_ADJUDICATE_SYSTEM_PROMPT, user, cap);
        if (wouldExceedDeconBudget(job.budget, cost, 'p1c', est)) {
          const note = `p1c 别名裁决预算超限（本次预估 ${est} tokens，已累计 ${cost.totalTokens}）——已诚实挂起（不烧 token），调整预算后续跑`;
          capDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, note, nowIso());
          return { status: 'capped', message: note };
        }
        attempts += 1;
        let text = '';
        let finishReason: string | undefined;
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
        try {
          const response = await generate({
            slot: 'review-judge',
            system: DECON_P1C_ADJUDICATE_SYSTEM_PROMPT,
            user,
            maxTokens: cap,
          });
          text = (response?.text ?? '').trim();
          finishReason = response?.finishReason;
          usage = response?.usage;
        } catch (err) {
          if (attempt > 0) {
            const message = `别名裁决调用失败：${deconErrMsg(err)}`;
            failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
            return { status: 'failed', message };
          }
          continue;
        }
        // 实际记账（调用已发生——provider usage 真值优先 CR-13）并落 job 行（writeDeconCost
        // 单源：行已删抛 DeconJobGoneError 静默中止，不 `?? job` 复活）。
        const actual = resolveDeconActualTokens(DECON_P1C_ADJUDICATE_SYSTEM_PROMPT, user, text, usage);
        cost = accumulateDeconCost(cost, 'p1c', actual.tokens, 1, actual.estimated);
        writeDeconCost(jobId, job, cost, nowIso());
        if (finishReason === 'length') {
          if (attempt > 0) {
            const message = '别名裁决输出因 token 上限截断（finishReason=length）——已挂起';
            failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
            return { status: 'failed', message };
          }
          continue;
        }
        if (!text) {
          if (attempt > 0) {
            const message = '别名裁决返回空回复——已挂起';
            failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
            return { status: 'failed', message };
          }
          continue;
        }
        const parsed = parseDeconAdjudicationResponse(text, pairIds);
        if (parsed === null) {
          if (attempt > 0) {
            const message = '别名裁决两次整体拒收（集外/重复编号或坏形状——约束式校验失败），不硬给归并';
            failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
            return { status: 'failed', message };
          }
          getLogger().warn({ jobId }, 'decon p1c: adjudication response rejected (out-of-set, duplicate or malformed) - retrying once');
          continue;
        }
        batchVerdicts = parsed;
        break;
      }
      if (batchVerdicts === null) {
        // belt（循环内失败路径已全部 return——不可达防御）。
        const message = '别名裁决重试耗尽（不可达路径）';
        failDeconUnit(jobId, 'p1c', DECON_PASS_UNIT_ALL, message, nowIso());
        return { status: 'failed', message };
      }
      for (const [pairId, same] of batchVerdicts) verdicts.set(pairId, same);
    }
    for (const p of candidates.pendingAdjudication) {
      if (verdicts.get(p.pairId) === true) approvedPairs.push({ a: p.a, b: p.b });
    }
  }

  // 实体装配（纯代码——合并组 → canonical/类型投票/mentions/幻觉过滤）。
  const obsByName = new Map(observations.map((o) => [o.name, o]));
  const groups = mergeDeconAliasGroups(
    observations.map((o) => o.name),
    [...candidates.autoPairs, ...approvedPairs],
  );
  const entities: DeconEntity[] = [];
  let hallucinationFiltered = 0;
  let droppedAliases = 0;
  let mergedClusters = 0;
  for (const group of groups) {
    const totalMentions = (name: string): number => {
      const obs = obsByName.get(name);
      return obs === undefined ? 0 : [...obs.chapters.values()].reduce((s, v) => s + v, 0);
    };
    // canonical 选取：总出现次数降序 → 名长降序 → 字典序（确定性）。
    const canonical = [...group].sort((x, y) => {
      const mx = totalMentions(x);
      const my = totalMentions(y);
      if (mx !== my) return my - mx;
      if (x.length !== y.length) return y.length - x.length;
      return x < y ? -1 : x > y ? 1 : 0;
    })[0]!;
    const others = group.filter((n) => n !== canonical);
    // 别名幻觉下压：不见于原文的别名字符串无锚定价值——剔除（计数审计）。
    const aliases = others.filter((n) => derived.includes(n));
    droppedAliases += others.length - aliases.length;

    const mentions = new Map<number, number>();
    const typeVotes: Record<string, number> = {};
    for (const name of group) {
      const obs = obsByName.get(name);
      if (obs === undefined) continue;
      for (const [ch, count] of obs.chapters) mentions.set(ch, (mentions.get(ch) ?? 0) + count);
      for (const [type, count] of Object.entries(obs.typeVotes)) typeVotes[type] = (typeVotes[type] ?? 0) + count;
    }
    let type: DeconEntityType = 'concept'; // 零票防御（观测必带 type——不可达路径的确定值）
    let bestCount = -1;
    for (const [t, count] of Object.entries(typeVotes)) {
      if (count > bestCount || (count === bestCount && t < type)) {
        type = t as DeconEntityType;
        bestCount = count;
      }
    }

    // 幻觉过滤：canonical + 全部别名（剔除后）均不见于原文 → 行保留 + audit 标记（观测面），
    // 下游消费（canon 装配/实体抽样）按 audit.hallucinationFiltered 排除。
    const filtered = !derived.includes(canonical) && aliases.every((alias) => !derived.includes(alias));
    if (filtered) hallucinationFiltered += 1;
    if (others.length > 0) mergedClusters += 1;

    entities.push({
      materialRef: job.materialRef,
      derivedHash: job.derivedHash,
      canonicalName: canonical,
      type,
      aliases,
      mentions: [...mentions.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([chapterIndex, count]) => ({ chapterIndex, count })),
      audit: {
        ...(others.length > 0 ? { mergedFrom: others } : {}),
        typeVotes,
        ...(filtered ? { hallucinationFiltered: true } : {}),
      },
    });
  }
  entities.sort((a, b) => (a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0));

  const stats: DeconP1cStats = {
    observedNames: observations.length,
    droppedCollective,
    clusters: groups.length,
    mergedClusters,
    adjudicationAttempts: attempts,
    adjudicationApproved: approvedPairs.length,
    entities: entities.length,
    hallucinationFiltered,
    droppedAliases,
  };
  const outputHash = hashDeconEntitiesOutput(entities);
  replaceDeconEntitiesWithPassState(job.materialRef, job.derivedHash, entities, {
    jobId,
    pass: 'p1c',
    unit: DECON_PASS_UNIT_ALL,
    status: 'done',
    outputRef: 'entity:all',
    outputHash,
    updatedAt: nowIso(),
  });
  if (hallucinationFiltered > 0) {
    getLogger().warn(
      { jobId, hallucinationFiltered },
      'decon p1c: entities with zero text presence kept as audit rows (hallucinationFiltered) - excluded from downstream',
    );
  }
  if (droppedAliases > 0) {
    getLogger().warn({ jobId, droppedAliases }, 'decon p1c: aliases absent from text dropped');
  }
  return { status: 'done', skipped: false, entities, stats };
}

function emptyStats(entities: number): DeconP1cStats {
  return {
    observedNames: entities,
    droppedCollective: 0,
    clusters: entities,
    mergedClusters: 0,
    adjudicationAttempts: 0,
    adjudicationApproved: 0,
    entities,
    hallucinationFiltered: 0,
    droppedAliases: 0,
  };
}
