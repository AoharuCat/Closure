import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  EVAL_DEFAULT_K,
  evalSetFromCases,
  scoreEvalCases,
  type CraftHit,
  type EntryHit,
  type EvalCase,
  type EvalCaseScore,
} from '@orison/shared-contracts';
import { searchCraft } from './closureCraftRetrieval';
import type { RetrievalDeps } from './closureRetrieval';
import { getLogger } from '../logger';

// ── E10.2b W6.2（task 09-05）：craft 金标 eval runner——复用 8.3 EvalCase/scoreEvalCases
//    契约（F-21，design §4）──
//
// 金标 = 20-30 个「写作情境→期望命中卡」对（prd R8）。**shared 层契约零修改复用**：
// EvalCase（id/query/expected/note——retrieval-eval.ts）+ evalSetFromCases（per-element
// 容错单源）+ scoreEvalCases（recall@k / MRR 纯函数，检索无关）。本文件只做 craft 适配三件：
//
// 1. **per-case 检索参数（craft 侧 yaml 扩展）**：手艺卡检索带 tags/craft_type 过滤面
//    （R10 / W4.2），EvalCase schema 没有（也不该有——那是 fiction 检索的形状）这两个字段。
//    扩展方式 = yaml 条目上多写 `craft_type` / `tags` 键，本 runner 从 **raw yaml 对象**提取
//    （evalCaseSchema 的 zod 默认 strip 行为会静默剥掉未知键——cases 本身照常经容错解析，
//    互不干扰）。**不碰 shared 契约**（W6.2 纪律：发现不够用先报告不擅改）。
// 2. **searchCraft 适配**：EvalCase 查询 → searchCraft({query, craftType, tags, k}, deps)。
// 3. **hit 映射**：CraftHit → EntryHit（entryId = craftId；手艺卡期望 entryId = `card:<cardId>`
//    ——cardCraftId 形态；doc 行期望 = doc craft_id；材料 chunk 行期望 = `mat:...` 前缀行）。
//    score 透传 RRF 融合分（rerankScore 在场时为 rerank 后排序）。
//
// yaml 写法（完整可照抄——存 `<evalDir>/golden.yaml`；目录惯例 `~/.orison/craft-kb/evals/`
// 〔craft KB 全局库的随库金标——craftKbWatcher/listCraftMdFiles 只认 .md，yaml 不扰文档索引〕；
// runner 不写死路径，evalDir 显式入参——测试指向 throwaway 目录，未来 IPC/脚本一行接上）：
//
// ```yaml
// cases:
//   - id: qingxu-xianyihouyang           # 唯一 id
//     query: 先抑后扬的回报节奏怎么安排      # 写作情境（作者口吻）
//     craft_type: qingxu                  # ← craft 侧扩展：大类过滤（可省）
//     tags:                                # ← craft 侧扩展：自由标签过滤（可省，OR 召回）
//       - 都市
//     expected:                            # 期望命中（any-of，命中任一即算）
//       - entryId: "card:card-0123456789ab"
//     note: 情绪回报模式的代表查询
// ```
//
// **真金标回填（W6.1 注记）**：本 runner 落地时的 fixtures 是**合成种子卡**（harness 机制面
// 验证 + 结构模板，见 test/craftRetrievalEvalGolden.test.ts）；真实语料蒸馏卡的人工校准对
// （D 样例篇目）在 W6.1 用户主审后按上述 yaml 形状回填——同一 runner 同一打分，替换语料即可。
// 管线变更回归门 = 金标 recall@k 不低于已冻结基线（基线钉在金标测试断言里，CI/手动跑均可）。
//
// 范式判据（ADR-3）：金标**内容**（哪些情境、哪张卡算命中）是语义判断归人/W6.1 校准；本文件
// 纯代码只做 yaml 容错解析 + 参数提取 + 检索调用 + 确定性打分（零语义裁判）。
//
// DI seam（mirror retrievalEval.ts 透传 RetrievalDeps）：测试注入 stub embed/rerank → 零网络
// 真跑 ABI；生产 omit deps → 真实云端端点（dogfood/真金标跑分）。测试也可 vi.mock
// closureCraftRetrieval 模块整替 searchCraft（runner 映射正确性的纯单测形态）。

/** craft 金标评估集目录惯例名（`~/.orison/craft-kb/evals/` 的尾段；runner 显式收目录路径）。 */
export const CRAFT_EVAL_DIR_NAME = 'evals';

/**
 * 目录递归深度帽（CR-2b-30）：evalDir = 第 0 层，子目录下探至多 4 层——第 4 层子目录内的
 * yaml 仍收录，第 5 层不再下探。病态深目录（误把整棵树当评估集投进来）枚举成本有界。
 */
const CRAFT_EVAL_MAX_DEPTH = 4;

// ── per-case 检索参数（craft 侧 yaml 扩展——raw 对象提取，见头注 1）──

/** 单 case 的 craft 检索参数（yaml `craft_type` / `tags` 键；两者皆可省）。 */
export interface CraftEvalRetrievalParams {
  craftType?: string;
  tags?: readonly string[];
}

/**
 * 从 **raw yaml 根对象**提取 per-case craft 检索参数（id → {craftType, tags}）。
 *
 * 容错语义（mirror evalSetFromCases 的 per-element 精神）：坏形状（id 非 string / craft_type
 * 非 string / tags 非字符串数组）静默跳过该参数——case 本身照常参与评估（无参数 = 纯 query
 * 检索，检索面最宽，不会假失败）。跨文件/文件内重复 id **first-wins**（与 runner 的 case
 * 去重同向——重复 id 的后到份整条被丢，参数也无从生效）。
 */
export function craftEvalParamsFromRaw(raw: unknown): Map<string, CraftEvalRetrievalParams> {
  const out = new Map<string, CraftEvalRetrievalParams>();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rawCases = (raw as { cases?: unknown }).cases;
  if (!Array.isArray(rawCases)) return out;
  for (const element of rawCases) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) continue;
    const o = element as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    const id = o.id.trim();
    if (!id || out.has(id)) continue;
    const params: CraftEvalRetrievalParams = {};
    if (typeof o.craft_type === 'string' && o.craft_type.trim()) {
      params.craftType = o.craft_type.trim();
    }
    if (Array.isArray(o.tags)) {
      const tags = o.tags.filter(
        (t): t is string => typeof t === 'string' && t.trim().length > 0,
      );
      if (tags.length > 0) params.tags = tags;
    }
    if (params.craftType !== undefined || params.tags !== undefined) {
      out.set(id, params);
    }
  }
  return out;
}

/** 一个评估文件的容错解析产物：cases（shared 容错单源）+ craft 参数（raw 提取）。 */
export interface ParsedCraftEvalFile {
  cases: EvalCase[];
  params: Map<string, CraftEvalRetrievalParams>;
  skipped: number;
}

/**
 * 解析一个 craft 评估集 yaml 文本：BOM 剥离（Windows 编辑器，mirror evalSetFromYaml）+
 * js-yaml load → cases 走 shared `evalSetFromCases`（per-element 容错单源——坏条目 warn +
 * skipped 计数，不丢全集）+ 参数走 `craftEvalParamsFromRaw`。
 *
 * 整文件级坏（yaml 语法错）→ null，caller 连文件路径 warn + 计入 skippedFiles。
 */
export function parseCraftEvalYaml(text: string): ParsedCraftEvalFile | null {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = yaml.load(stripped);
  } catch {
    return null;
  }
  const { cases, skipped } = evalSetFromCases(raw);
  return { cases, params: craftEvalParamsFromRaw(raw), skipped };
}

/**
 * 递归枚举 evalDir 下的 `*.yaml` / `*.yml`（深度优先 + 全路径排序，确定性；子目录下探至多
 * {@link CRAFT_EVAL_MAX_DEPTH} 层、symlink 不跟随——CR-2b-30）。
 *
 * 结构 mirror retrievalEval.listEvalFiles/listYamlFilesIn（该 helper 未导出且既有文件禁改
 * ——W6.2 纪律，此处复刻而非扩展他人模块）。目录缺失/不可读 → []（never throw——「未建评估
 * 集」是 graceful 分支）；子目录递归（evals/work/ 分档文件不静默忽略）。
 */
export function listCraftEvalFiles(evalDir: string): string[] {
  return listYamlFilesIn(evalDir).sort();
}

function listYamlFilesIn(dir: string, depth = 0): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      'craft eval: cannot read eval directory - skipping',
    );
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let isDir = false;
    let isFile = false;
    try {
      // CR-2b-30：lstat 不跟随符号链接——目录 symlink（含环）不递归（原 statSync 跟随，
      // 循环 symlink 会无限递归）；文件 symlink 同样跳过（eval 集是本机明文资产，链接形态
      // 不收录——要共享内容请放实体文件）。
      const st = lstatSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      // stat 失败（竞态/权限）——跳过该条目。
      continue;
    }
    if (isDir) {
      if (depth < CRAFT_EVAL_MAX_DEPTH) out.push(...listYamlFilesIn(full, depth + 1));
    } else if (isFile && /\.ya?ml$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// ── hit 映射（CraftHit → EntryHit——scoreEvalCases 消费形状）──

/**
 * 把一条 craft 检索命中映射成 scoreEvalCases 消费的 EntryHit（打分只用 entryId/chapterId/
 * charStart/charEnd——卡/doc/材料行无章锚，天然只走 entryId 判定）。
 *
 * - `entryId = craftId`：手艺卡 = `card:<cardId>`（cardCraftId 形态）、doc = frontmatter id、
 *   材料 chunk = `mat:<materialId>.ch<i>#c<n>`——与 yaml expected.entryId 对齐。
 * - `projectId: ''`：craft KB 全局无项目域（EntryHit 要求该键，空串 sentinel——打分不消费）。
 * - `visibility: 'known'`：craft 全公开（closureCraftRetrieval 无 visibility 过滤面）。
 * - 可选键**二态纪律**（无值键不出现）：ftsRank/vecDistance/rerankScore/summaryText/
 *   vectorKind 在场才写——mirror EntryHit 契约注释。
 */
export function craftHitToEntryHit(hit: CraftHit): EntryHit {
  return {
    entryId: hit.craftId,
    projectId: '',
    entryType: hit.craftType,
    sourceKind: hit.sourceKind,
    name: hit.name,
    bodyText: hit.bodyText,
    visibility: 'known',
    score: hit.score,
    ...(hit.ftsRank !== undefined ? { ftsRank: hit.ftsRank } : {}),
    ...(hit.vecDistance !== undefined ? { vecDistance: hit.vecDistance } : {}),
    ...(hit.rerankScore !== undefined ? { rerankScore: hit.rerankScore } : {}),
    ...(hit.summaryText !== undefined ? { summaryText: hit.summaryText } : {}),
    ...(hit.vectorKind !== undefined ? { vectorKind: hit.vectorKind } : {}),
  };
}

// ── 报告形态（mirror RetrievalEvalReport 家族——craft 侧字段换名）──

/** craft 检索命中轻量摘要（per-case 诊断——miss 时看最近返回的是什么）。 */
export interface CraftEvalHitDigest {
  craftId: string;
  name: string;
  craftType: string;
  sourceKind: string;
  score: number;
}

/** 单 case 报告明细（EvalCaseScore + 查询/参数回显 + top 命中摘要）。 */
export interface CraftEvalCaseDetail extends EvalCaseScore {
  query: string;
  note?: string;
  /** 该 case 的 craft 检索参数（yaml craft_type/tags——回显校对面）。 */
  craftType?: string;
  tags?: string[];
  topHits: CraftEvalHitDigest[];
}

/** 一次 craft 评估运行的结构化结果（caller 渲染用；日志摘要由 runner 自己打）。 */
export interface CraftEvalRunDetails {
  k: number;
  files: string[];
  caseCount: number;
  skippedCases: number;
  skippedFiles: number;
  recallAtK: number;
  mrr: number;
  perCase: CraftEvalCaseDetail[];
}

/** 评估报告：跑过 / 「未建评估集」（graceful 非错误，明确告知怎么建——mirror 8.3 形态）。 */
export type CraftEvalReport =
  | { ok: true; ran: true; run: CraftEvalRunDetails }
  | {
      ok: true;
      ran: false;
      reason: 'no-eval-set';
      filesFound: number;
      skippedCases: number;
      skippedFiles: number;
    };

function digest(hit: EntryHit): CraftEvalHitDigest {
  return {
    craftId: hit.entryId,
    name: hit.name,
    craftType: hit.entryType,
    sourceKind: hit.sourceKind,
    score: hit.score,
  };
}

/**
 * 跑一次 craft 金标评估：扫 evalDir 下 `*.yaml` → 逐 case `searchCraft`（query + 该 case 的
 * craft_type/tags 参数，DI seam 透传，串行——API 并发纪律）→ `craftHitToEntryHit` 映射 →
 * `scoreEvalCases` 打 recall@k / MRR → 报告（结构化返回 + 日志摘要/per-case 详情行）。
 *
 * runner 全程 best-effort（单文件坏不阻整跑），无 error 态——mirror runRetrievalEval。
 *
 * @param evalDir 评估集目录（惯例 `~/.orison/craft-kb/evals/`；测试指向 throwaway 目录）。
 * @param opts k（每 case 取前 k 条计分，缺省 5）/ topHitsShown（per-case 报告截取条数，缺省 3）。
 * @param deps searchCraft 的 DI seam：注入 stub embed/rerank → 零网络真跑 ABI（测试）；omit →
 *   真实云端端点（真金标跑分）。检索管线本体零改动。
 */
export async function runCraftEval(
  evalDir: string,
  opts: { k?: number; topHitsShown?: number } = {},
  deps?: RetrievalDeps,
): Promise<CraftEvalReport> {
  const k = opts.k ?? EVAL_DEFAULT_K;
  const topHitsShown = opts.topHitsShown ?? 3;

  // 1. 扫文件 + 容错解析（坏条目/坏文件计数反馈；跨文件重复 id 去重保先到不覆盖——mirror
  //    runRetrievalEval 同段）。
  const files = listCraftEvalFiles(evalDir);
  const cases: EvalCase[] = [];
  const paramsById = new Map<string, CraftEvalRetrievalParams>();
  const usedFiles: string[] = [];
  const seenIds = new Set<string>();
  let skippedCases = 0;
  let skippedFiles = 0;
  for (const filePath of files) {
    let text: string | null = null;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'craft eval: cannot read eval file - skipping file',
      );
    }
    const parsed = text === null ? null : parseCraftEvalYaml(text);
    if (parsed === null) {
      skippedFiles += 1;
      getLogger().warn({ filePath }, 'craft eval: eval file is not valid yaml - skipping file');
      continue;
    }
    skippedCases += parsed.skipped;
    let suppliedAny = false;
    for (const evalCase of parsed.cases) {
      if (seenIds.has(evalCase.id)) {
        skippedCases += 1;
        getLogger().warn(
          { caseId: evalCase.id, filePath },
          'craft eval: duplicate case id across files - keeping the first, skipping this one',
        );
        continue;
      }
      seenIds.add(evalCase.id);
      cases.push(evalCase);
      const p = parsed.params.get(evalCase.id);
      if (p !== undefined) paramsById.set(evalCase.id, p);
      if (!suppliedAny) {
        suppliedAny = true;
        usedFiles.push(path.relative(evalDir, filePath));
      }
    }
  }

  // 2. 空集 graceful：未建评估集是常态（新装机/金标未回填），明确告知怎么建，非错误。
  if (cases.length === 0) {
    getLogger().info(
      `[craft-eval] 未建评估集：${evalDir} 下没有可用 case（找到 ${files.length} 个文件，` +
        `坏条目 ${skippedCases}、坏文件 ${skippedFiles}）。建一个 golden.yaml` +
        `（写法照抄 craftRetrievalEval.ts 注释里的完整示例）再跑。`,
    );
    return {
      ok: true,
      ran: false,
      reason: 'no-eval-set',
      filesFound: files.length,
      skippedCases,
      skippedFiles,
    };
  }

  // 3. 逐 case 跑真实检索（串行——API 并发纪律；craft_type/tags 按 case 参数，缺省纯 query）。
  const hitsByQuery = new Map<string, EntryHit[]>();
  for (const evalCase of cases) {
    const p = paramsById.get(evalCase.id);
    const hits = await searchCraft(
      evalCase.query,
      {
        k,
        ...(p?.craftType !== undefined ? { craftType: p.craftType } : {}),
        ...(p?.tags !== undefined ? { tags: p.tags } : {}),
      },
      deps,
    );
    hitsByQuery.set(evalCase.id, hits.map(craftHitToEntryHit));
  }

  // 4. 打分（shared 纯函数——perCase 与 cases 同序契约，按下标对齐）。
  const summary = scoreEvalCases(cases, hitsByQuery, k);
  const perCase: CraftEvalCaseDetail[] = cases.map((evalCase, i) => {
    const score = summary.perCase[i]!;
    const p = paramsById.get(evalCase.id);
    return {
      ...score,
      query: evalCase.query,
      ...(evalCase.note !== undefined ? { note: evalCase.note } : {}),
      ...(p?.craftType !== undefined ? { craftType: p.craftType } : {}),
      ...(p?.tags !== undefined ? { tags: [...p.tags] } : {}),
      topHits: (hitsByQuery.get(evalCase.id) ?? []).slice(0, topHitsShown).map(digest),
    };
  });

  // 5. 摘要 + per-case 详情（CR-2b-27：走 getLogger——与模块其余 warn/info 同一纪律，
  //    测试环境由 logger 的 VITEST 守卫静音；结构化返回值供 caller 渲染，此处给跑分直读行）。
  getLogger().info(
    `[craft-eval] ${cases.length} cases（${usedFiles.length} 个文件，跳过坏条目 ${skippedCases}、` +
      `坏文件 ${skippedFiles}）：recall@${k}=${(summary.recallAtK * 100).toFixed(1)}%, ` +
      `MRR=${summary.mrr.toFixed(3)}`,
  );
  for (const detail of perCase) {
    const paramsEcho =
      detail.tags !== undefined || detail.craftType !== undefined
        ? `（${[detail.craftType, detail.tags?.join('/')].filter(Boolean).join(' · ')}）`
        : '';
    if (detail.hit) {
      getLogger().info(
        `[craft-eval]   [hit] rank ${detail.firstRank} · ${detail.caseId}「${detail.query}」${paramsEcho}`,
      );
    } else {
      const first = detail.topHits[0];
      const nearest =
        first === undefined ? '无任何结果' : `最近一条：${first.name}（${first.craftType}）`;
      getLogger().info(
        `[craft-eval]   [miss] ${detail.caseId}「${detail.query}」${paramsEcho} → ${nearest}`,
      );
    }
  }

  return {
    ok: true,
    ran: true,
    run: {
      k,
      files: usedFiles,
      caseCount: cases.length,
      skippedCases,
      skippedFiles,
      recallAtK: summary.recallAtK,
      mrr: summary.mrr,
      perCase,
    },
  };
}
