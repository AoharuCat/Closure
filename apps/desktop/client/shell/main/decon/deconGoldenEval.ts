import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { DeconEntityAudit, DeconEntityType, DeconFindings } from '@orison/shared-contracts';
import { DECON_CRAFT_DIMENSION_IDS, deconEntityTypeSchema, deconFindingsSchema } from '@orison/shared-contracts';
import { listDeconEntities, listDeconProducts } from '../db/closure-decon';
import { getLogger } from '../logger';

/** 场景 case 维度合法集（12 手艺维——style 无章级 findings 面不收）。 */
const CRAFT_DIM_SET: ReadonlySet<string> = new Set<string>(DECON_CRAFT_DIMENSION_IDS);

// ── E10.3b W7（task 09-05）：decon 金标 eval runner——对管线产物断言（parent design §8）──
//
// 金标 = 拆解产物的人工校准对（AC9）。**零语义裁判**（范式判据：金标内容〔哪些实体该在、
// 哪章哪维该有什么结论〕是语义判断归人/dogfood 校准；本文件纯代码只做 yaml 容错解析 +
// db 读回 + 确定性断言）。mirror 10.2 craftRetrievalEval.ts 的形态（容错解析 per-case +
// 结构化报告 + throwaway 目录可测），但断言面不同：craft 是检索打分（recall@k/MRR），decon
// 是**存在性断言**（实体/黑名单/场景命中）——无打分纯函数可复用，本文件自带。
//
// yaml 两段（B design §7）。**真金标回填注记**：本 runner 落地时的 fixtures 是合成种子
// （harness 机制面验证——mock LLM 全链跑通后对产物断言，见 test/deconGoldenEval.test.ts）；
// 真实语料的人工校准对（用书 dogfood 时）按此形状写进 `~/.orison/craft-kb/evals/decon/
// golden.yaml`（craft-kb/evals 旁挂子目录——不新增顶层约定；runner 不写死路径，evalDir 显式
// 入参，测试指向 throwaway 目录）。管线变更回归门 = 金标全过（阈值钉在金标测试断言里）。
//
// ```yaml
// entities:                       # 实体存在性/类型 + 幻觉黑名单（A fixture 用例产品化）
//   - id: li-xiaoyao              # 唯一 id（跨文件重复 first-wins）
//     name: 李逍遥                # 期望 canonicalName 存在
//     type: person                # 期望类型（可省 = 只查存在）
//   - id: ghost
//     name: 幻影真人
//     expect: filtered            # 幻觉黑名单：不得以未过滤形态在场（P1c 过滤或整条缺席）
// scenes:                         # 场景命中（章提示 → 期望维度/结论关键词）
//   - id: ch1-qidaigan
//     chapter: 1                  # 章 index（0 起——与 facts/产品 unit 同基）
//     dimension: qidaigan         # 期望命中的手艺维 id（p4:<dim> 产品面）
//     keywords: [期待感, 钩子]     # 结论关键词（any-of：insight/elaboration 命中任一即算；可省 = 只查有 findings）
// ```
//
// 断言语义（全部确定性）：
// - entities `exists`：canonicalName 精确命中 + type（如给）一致。
// - entities `filtered`：缺席 = 过（根本没立行）；在场须带 audit.hallucinationFiltered=true
//   （A 的 P1c 过滤留痕形态）；未过滤在场 = fail（幻觉实体漏网）。
// - scenes：p4:<dimension> 产品 unit=ch:<chapter> 行存在 ≥1 条 finding；keywords 非空时
//   insight+elaboration 命中任一关键词。
//
// DI：零 LLM 零网络——纯 db 读（listDeconEntities 材料级键控 + listDeconProducts job 级键控），
// materialRef/derivedHash/jobId 显式入参（调用方从 decon:get / decon:list 拿现值）。

/** 实体期望模式：`exists`（默认——存在性/类型）/ `filtered`（幻觉黑名单）。 */
export type DeconGoldenEntityMode = 'exists' | 'filtered';

/** 单实体 case（yaml `entities:` 条目解析产物）。 */
export interface DeconGoldenEntityCase {
  id: string;
  name: string;
  mode: DeconGoldenEntityMode;
  expectedType: DeconEntityType | null;
}

/** 单场景 case（yaml `scenes:` 条目解析产物）。 */
export interface DeconGoldenSceneCase {
  id: string;
  chapterIndex: number;
  dimensionId: string;
  keywords: string[];
}

/** 一个金标文件的容错解析产物（坏条目 warn + skipped 计数，不丢全集——mirror evalSetFromCases）。 */
export interface ParsedDeconGoldenFile {
  entityCases: DeconGoldenEntityCase[];
  sceneCases: DeconGoldenSceneCase[];
  skipped: number;
}

/**
 * 解析一个金标 yaml 文本：BOM 剥离（Windows 编辑器）+ js-yaml load → per-element 容错
 * （坏形状静默跳过该条 + skipped 计数——case 集保真）。整文件级坏（yaml 语法错）→ null，
 * caller 连文件路径 warn + 计入 skippedFiles。
 *
 * 条目校验（手工判别——两段条目数少形状稳定，不值当引 zod schema 依赖面）：
 * - entities：id/name 非空字符串；type 省略或 ∈ DECON_ENTITY_TYPES；expect 省略或 'filtered'
 *   （其余值按坏条目跳过——黑名单词形唯一，不存在第三态）。
 * - scenes：id 非空；chapter 非负整数；dimension ∈ 12 手艺维（**style 除外**——风格维无章
 *   级 findings 面，unit='all'，章提示的 case 对它必假失败）；keywords 省略或非空字符串
 *   数组（空数组按省略处理）。
 */
export function parseDeconGoldenYaml(text: string): ParsedDeconGoldenFile | null {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = yaml.load(stripped);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  const out: ParsedDeconGoldenFile = { entityCases: [], sceneCases: [], skipped: 0 };

  if (root.entities !== undefined && root.entities !== null) {
    if (!Array.isArray(root.entities)) {
      out.skipped += 1;
      getLogger().warn('decon golden eval: entities 段非数组——整段跳过');
    } else {
      for (const element of root.entities) {
        if (element === null || typeof element !== 'object' || Array.isArray(element)) {
          out.skipped += 1;
          continue;
        }
        const o = element as Record<string, unknown>;
        if (typeof o.id !== 'string' || o.id.trim().length === 0 || typeof o.name !== 'string' || o.name.trim().length === 0) {
          out.skipped += 1;
          continue;
        }
        let expectedType: DeconEntityType | null = null;
        if (o.type !== undefined && o.type !== null) {
          if (typeof o.type !== 'string' || !deconEntityTypeSchema.safeParse(o.type).success) {
            out.skipped += 1;
            continue;
          }
          expectedType = o.type as DeconEntityType;
        }
        let mode: DeconGoldenEntityMode = 'exists';
        if (o.expect !== undefined && o.expect !== null) {
          if (o.expect !== 'filtered') {
            out.skipped += 1;
            continue;
          }
          mode = 'filtered';
        }
        out.entityCases.push({ id: o.id.trim(), name: o.name.trim(), mode, expectedType });
      }
    }
  }

  if (root.scenes !== undefined && root.scenes !== null) {
    if (!Array.isArray(root.scenes)) {
      out.skipped += 1;
      getLogger().warn('decon golden eval: scenes 段非数组——整段跳过');
    } else {
      for (const element of root.scenes) {
        if (element === null || typeof element !== 'object' || Array.isArray(element)) {
          out.skipped += 1;
          continue;
        }
        const o = element as Record<string, unknown>;
        if (typeof o.id !== 'string' || o.id.trim().length === 0) {
          out.skipped += 1;
          continue;
        }
        if (typeof o.chapter !== 'number' || !Number.isInteger(o.chapter) || o.chapter < 0) {
          out.skipped += 1;
          continue;
        }
        if (typeof o.dimension !== 'string' || !CRAFT_DIM_SET.has(o.dimension)) {
          out.skipped += 1;
          continue;
        }
        let keywords: string[] = [];
        if (o.keywords !== undefined && o.keywords !== null) {
          if (!Array.isArray(o.keywords)) {
            out.skipped += 1;
            continue;
          }
          keywords = o.keywords.filter(
            (k): k is string => typeof k === 'string' && k.trim().length > 0,
          );
        }
        out.sceneCases.push({ id: o.id.trim(), chapterIndex: o.chapter, dimensionId: o.dimension, keywords });
      }
    }
  }
  return out;
}

/**
 * 枚举 evalDir 顶层的 `*.yaml` / `*.yml`（**非递归**——decon/ 子目录是单 golden.yaml 惯例，
 * 不 mirror craft evals/ 的多文件递归面）。目录缺失/不可读 → []（never throw——「未建评估集」
 * 是 graceful 分支）；全路径排序，确定性。
 */
export function listDeconGoldenFiles(evalDir: string): string[] {
  if (!existsSync(evalDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(evalDir);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), dir: evalDir },
      'decon golden eval: cannot read eval directory - skipping',
    );
    return [];
  }
  return entries
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => path.join(evalDir, entry))
    .sort();
}

// ── 单 case 断言（纯函数——db 行已由 runner 读回传入）──

/** 实体 case 断言明细。 */
export interface DeconGoldenEntityResult {
  caseId: string;
  mode: DeconGoldenEntityMode;
  pass: boolean;
  /** 失败原因（pass 时 null）——人审/回归定位面。 */
  message: string | null;
}

/** 场景 case 断言明细。 */
export interface DeconGoldenSceneResult {
  caseId: string;
  pass: boolean;
  message: string | null;
}

/**
 * 断言一个实体 case（纯函数）：exists = canonicalName 精确命中 + type 一致；filtered =
 * 缺席或带 hallucinationFiltered 留痕。entities 是 (materialRef, derivedHash) 键控的全量行。
 */
export function assertDeconGoldenEntity(
  entityCase: DeconGoldenEntityCase,
  entities: ReadonlyArray<{
    canonicalName: string;
    type: DeconEntityType;
    audit: DeconEntityAudit;
  }>,
): DeconGoldenEntityResult {
  const hit = entities.find((e) => e.canonicalName === entityCase.name) ?? null;
  if (entityCase.mode === 'filtered') {
    if (hit === null) {
      return { caseId: entityCase.id, mode: entityCase.mode, pass: true, message: null };
    }
    if (hit.audit.hallucinationFiltered === true) {
      return { caseId: entityCase.id, mode: entityCase.mode, pass: true, message: null };
    }
    return {
      caseId: entityCase.id,
      mode: entityCase.mode,
      pass: false,
      message: `幻觉实体「${entityCase.name}」以未过滤形态在场（audit.hallucinationFiltered 缺失）——P1c 过滤漏网`,
    };
  }
  if (hit === null) {
    return {
      caseId: entityCase.id,
      mode: entityCase.mode,
      pass: false,
      message: `期望实体「${entityCase.name}」不在聚合产物中（materialRef+derivedHash 键控现值）`,
    };
  }
  if (entityCase.expectedType !== null && hit.type !== entityCase.expectedType) {
    return {
      caseId: entityCase.id,
      mode: entityCase.mode,
      pass: false,
      message: `实体「${entityCase.name}」类型 ${hit.type} ≠ 期望 ${entityCase.expectedType}`,
    };
  }
  return { caseId: entityCase.id, mode: entityCase.mode, pass: true, message: null };
}

/**
 * 断言一个场景 case（纯函数）：p4:<dimension> 产品 unit=ch:<chapter> 行 ≥1 条 finding；
 * keywords 非空时 insight+elaboration 命中任一（any-of——mirror craft eval expected 语义）。
 * products 是 listDeconProducts(jobId, `p4:<dim>`) 的原行（payload 可选 unknown——本函数内
 * zod 容错，缺省/坏形按零 findings 计）。
 */
export function assertDeconGoldenScene(
  sceneCase: DeconGoldenSceneCase,
  products: ReadonlyArray<{ unit: string; payload?: unknown }>,
): DeconGoldenSceneResult {
  const chapterUnit = `ch:${sceneCase.chapterIndex}`;
  let findings: DeconFindings['findings'] = [];
  let rowFound = false;
  for (const row of products) {
    if (row.unit !== chapterUnit) continue;
    rowFound = true;
    const parsed = deconFindingsSchema.safeParse(row.payload);
    if (parsed.success) findings = [...findings, ...parsed.data.findings];
  }
  if (!rowFound) {
    return {
      caseId: sceneCase.id,
      pass: false,
      message: `p4:${sceneCase.dimensionId} 无 unit=${chapterUnit} 产品行（维度未跑或断点缺失）`,
    };
  }
  if (findings.length === 0) {
    return {
      caseId: sceneCase.id,
      pass: false,
      message: `p4:${sceneCase.dimensionId} ${chapterUnit} 零 findings（锚定核验全丢或空应答）`,
    };
  }
  if (sceneCase.keywords.length > 0) {
    const matched = findings.find((f) => {
      const text = `${f.insight}${f.elaboration}`;
      return sceneCase.keywords.some((kw) => text.includes(kw));
    });
    if (matched === undefined) {
      return {
        caseId: sceneCase.id,
        pass: false,
        message: `p4:${sceneCase.dimensionId} ${chapterUnit} 的 ${findings.length} 条 findings 无一命中关键词（${sceneCase.keywords.join('/')}）`,
      };
    }
  }
  return { caseId: sceneCase.id, pass: true, message: null };
}

// ── 报告形态（mirror CraftEvalReport 家族——decon 侧字段）──

/** 一次金标运行的结构化结果（caller 渲染用；日志摘要由 runner 自己打）。 */
export interface DeconGoldenEvalRunDetails {
  files: string[];
  entityCaseCount: number;
  sceneCaseCount: number;
  skippedCases: number;
  skippedFiles: number;
  passed: number;
  failed: number;
  entityResults: DeconGoldenEntityResult[];
  sceneResults: DeconGoldenSceneResult[];
}

/** 金标报告：跑过 / 「未建评估集」（graceful 非错误，明确告知怎么建）。 */
export type DeconGoldenEvalReport =
  | { ok: true; ran: true; run: DeconGoldenEvalRunDetails }
  | {
      ok: true;
      ran: false;
      reason: 'no-eval-set';
      filesFound: number;
      skippedCases: number;
      skippedFiles: number;
    };

/** 金标运行输入（db 键三件——调用方从 decon:get / decon:list 拿现值；测试直接构造）。 */
export interface DeconGoldenEvalInput {
  /** 金标目录（惯例 `~/.orison/craft-kb/evals/decon/`；测试指向 throwaway 目录）。 */
  evalDir: string;
  /** 实体断言键：材料级 material_ref（`global:mat-…`）。 */
  materialRef: string;
  /** 实体断言键：材料级 derived_hash（与 job 指纹同基）。 */
  derivedHash: string;
  /** 场景断言键：job 级 jobId（p4 产品行键）。 */
  jobId: string;
}

/**
 * 跑一次 decon 金标评估：扫 evalDir 顶层 yaml → 容错解析（跨文件重复 id first-wins）→
 * 读实体聚合（材料级键）+ p4 产品行（job 级键，按 case 维度分组取一次）→ 逐 case 确定性
 * 断言 → 结构化报告 + 日志摘要（VITEST 守卫静音；阈值断言归调用方——测试钉全过）。
 *
 * 全程 best-effort（单文件坏不阻整跑），无 error 态——mirror runCraftEval。
 */
export function runDeconGoldenEval(input: DeconGoldenEvalInput): DeconGoldenEvalReport {
  const files = listDeconGoldenFiles(input.evalDir);
  const entityCases: DeconGoldenEntityCase[] = [];
  const sceneCases: DeconGoldenSceneCase[] = [];
  const seenIds = new Set<string>();
  const usedFiles: string[] = [];
  let skippedCases = 0;
  let skippedFiles = 0;
  for (const filePath of files) {
    let text: string | null = null;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'decon golden eval: cannot read eval file - skipping file',
      );
    }
    const parsed = text === null ? null : parseDeconGoldenYaml(text);
    if (parsed === null) {
      skippedFiles += 1;
      getLogger().warn({ filePath }, 'decon golden eval: eval file is not valid yaml - skipping file');
      continue;
    }
    skippedCases += parsed.skipped;
    let suppliedAny = false;
    for (const entityCase of parsed.entityCases) {
      if (seenIds.has(entityCase.id)) {
        skippedCases += 1;
        getLogger().warn(
          { caseId: entityCase.id, filePath },
          'decon golden eval: duplicate case id - keeping the first, skipping this one',
        );
        continue;
      }
      seenIds.add(entityCase.id);
      entityCases.push(entityCase);
      if (!suppliedAny) {
        suppliedAny = true;
        usedFiles.push(path.relative(input.evalDir, filePath));
      }
    }
    for (const sceneCase of parsed.sceneCases) {
      if (seenIds.has(sceneCase.id)) {
        skippedCases += 1;
        getLogger().warn(
          { caseId: sceneCase.id, filePath },
          'decon golden eval: duplicate case id - keeping the first, skipping this one',
        );
        continue;
      }
      seenIds.add(sceneCase.id);
      sceneCases.push(sceneCase);
      if (!suppliedAny) {
        suppliedAny = true;
        usedFiles.push(path.relative(input.evalDir, filePath));
      }
    }
  }

  // 空集 graceful：未建金标是常态（dogfood 前不回填），明确告知怎么建，非错误。
  if (entityCases.length === 0 && sceneCases.length === 0) {
    getLogger().info(
      `[decon-golden] 未建金标：${input.evalDir} 下没有可用 case（找到 ${files.length} 个文件，` +
        `坏条目 ${skippedCases}、坏文件 ${skippedFiles}）。按 deconGoldenEval.ts 注释里的 yaml` +
        ` 形状写一个 golden.yaml 再跑。`,
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

  const entities = listDeconEntities(input.materialRef, input.derivedHash);
  const entityResults = entityCases.map((entityCase) => assertDeconGoldenEntity(entityCase, entities));

  // 场景取数按维度分组（每维度一次 db 读——case 数通常小；同维度多章共享产品行）。
  const productsByDim = new Map<string, Array<{ unit: string; payload?: unknown }>>();
  const sceneResults = sceneCases.map((sceneCase) => {
    let products = productsByDim.get(sceneCase.dimensionId);
    if (products === undefined) {
      products = listDeconProducts(input.jobId, `p4:${sceneCase.dimensionId}`);
      productsByDim.set(sceneCase.dimensionId, products);
    }
    return assertDeconGoldenScene(sceneCase, products);
  });

  const allResults = [...entityResults, ...sceneResults];
  const passed = allResults.filter((r) => r.pass).length;
  const failed = allResults.length - passed;
  getLogger().info(
    `[decon-golden] ${allResults.length} cases（${usedFiles.length} 个文件，跳过坏条目 ${skippedCases}、` +
      `坏文件 ${skippedFiles}）：通过 ${passed} / 失败 ${failed}`,
  );
  for (const result of allResults) {
    if (result.pass) {
      getLogger().info(`[decon-golden]   [pass] ${result.caseId}`);
    } else {
      getLogger().info(`[decon-golden]   [fail] ${result.caseId} → ${result.message ?? '(无原因)'}`);
    }
  }

  return {
    ok: true,
    ran: true,
    run: {
      files: usedFiles,
      entityCaseCount: entityCases.length,
      sceneCaseCount: sceneCases.length,
      skippedCases,
      skippedFiles,
      passed,
      failed,
      entityResults,
      sceneResults,
    },
  };
}
