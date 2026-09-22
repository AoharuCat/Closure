import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ResolvedModel } from '@orison/shared-contracts';
import {
  MATERIAL_CHUNK_STRATEGIES,
  MATERIAL_FORMATS,
  MATERIAL_STATUSES,
  buildChunkIndexText,
  chapterChunkSchema,
  materialProvenanceSchema,
  materialQualitySchema,
  materialSchema,
  parseChapterMarkers,
  splitChapters,
} from '@orison/shared-contracts';
import type {
  ChapterChunk,
  Material,
  MaterialChapterSpan,
  MaterialChunkSpan,
  MaterialFormat,
  MaterialStatus,
  SplitChapterSpan,
} from '@orison/shared-contracts';
import { generateEmbeddings } from '@orison/model-protocols';
import { getDb } from './index';
import { isSqliteVecAvailable } from './sqliteVecLoader';
import { getCurrentCraftVecDim } from './closureCraftIndexer';
import { buildChapterHeadings, chapterShortLabel, type ChapterHeadingInfo } from './chapterHeadings';
import {
  floatArrayToBuffer,
  getCurrentVecDim,
  shouldSkipForModelMismatch,
} from './closureIndexer';
import { getProject, getProjectById } from './projectRepository';
import { markCraftTeachingsStaleByMaterial } from './closureCraftCardRepository';
import { getCraftDistillLedger, upsertCraftDistillLedger } from './closureCraftDistillRepository';
import { resolveEmbeddingModel } from '../ipc/modelGatewayIpc';
import {
  MATERIAL_ALLOWED_EXTENSIONS,
  derivedRelPathFor,
  ingestMaterial,
  isSubtitleFormat,
  mapParagraphRanges,
  materialIdFor,
  materialSourcePath,
  normalizeMaterialRelPath,
  rebuildChaptersFromMarkers,
  type MaterialIngestDeps,
  type MaterialIngestScope,
} from '../ipc/toolHandlers/materialIngest';
import { getLogger } from '../logger';

// ── Story 10.1 Wave C：材料登记层 + 双车道 chunk 索引器（design §3.1/§3.2/§3.4）──
//
// 索引器家族 pattern 全套（mirror chapterChunkIndexer 宪法形态）：
// - hash-skip：组料 hash 含**章标题集**（F-14——只改派生 .md 章标记标题也触发重索引）+
//   chunk texts；hash 只在整材料向量落齐时写（pending_embed = content_hash NULL，重试粒度
//   = 材料级 all-or-nothing）。
// - crash-consistency（G3 同款）：embed 批量调用（网络）跑在事务**外**；单 WAL 事务内
//   DELETE 旧行（双车道 chunk 行 + vec 行）+ INSERT 新行 + closure_material 回填
//   （🔑 F-02：chunk_spans_json 回填与 chunk 行写入同一事务，掉电不产「有 chunk 行无
//   span」的断链态）。embed 失败 → FTS-only（pending_embed）——下次 reindex 重试补嵌。
// - 章结构真相源 = 派生 .md 章标记（design「closure-* 派生纪律」）：reindexMaterial 重新
//   parseChapterMarkers + rebuildChaptersFromMarkers 取权威章界（AC4 校对闭环——人工改标记/
//   移边界/改标题在重索引路径生效，不依赖登记行缓存），chapters_json / chapterDetection /
//   status 随重索引同步刷新（F-18 两处同值纪律：method 唯一源在 quality.chapterDetection）。
// - 策略 seam（D6 预留③）：MATERIAL_CHUNK_STRATEGIES[kind] 取策略——取不到 = 该 kind 未实施
//   （V1 仅 prose），诚实跳过**不硬编码 prose**（event_stream 等未来值 schema 不拒、索引不跑）。
// - 零章材料 = 全文单伪章照索引（F-09——章界挂起但检索照常，10.2 原料层兜底不断线）。
// - orphan 清理：materials/ 无原件 → 删登记 + 双车道 chunk 行（deleteMaterialRows 单事务）。
// - per-scope 串行队列（enqueueLaneWork——200 件批量 watcher 风暴防线，mirror rebuild
//   in-flight 链 B1 形态：chained promise .then(run,run)，禁 .finally〔unhandled rejection〕；
//   ⚠️ 队列内的 run* 直接调内部 runner，公共入口再 enqueue 会自等死锁）。
// - DI seam（resolveModel/embedBatch/parse/now 注入——测试零网络）。
//
// 双车道 INSERT 取值表（design §3.2〔F-15〕，materialIndexer.test.ts 钉死）：
// - 项目车道 closure_entry：entry_type='material' / source_kind='material' /
//   chapter_id=`${materialId}.ch${i}` / chapter_index=i（材料内章号）/ 章源七列照填（全局
//   span 基面 = 派生 .md 文本）/ visibility='known' / status=NULL（材料无卡状态）/
//   index_text=buildChunkIndexText(chunk.text)（无梗概退化不编造）；entry_id =
//   `${projectId}:${chapter_id}#c${n}`（projectId 前缀防跨项目 PK 碰撞，mirror setting_md）；
//   vec 行 vector_id=entry_id / vector_kind='chunk' / status='' sentinel（vec0 TEXT 拒 NULL）。
// - 全局车道 closure_craft_entry：source_kind='material_chunk' / craft_type='material' /
//   craft_id=`mat:${materialId}.ch${i}#c${n}`（`mat:` 前缀 = 命中渲染器识别材料行的锚）/
//   tags=NULL / source=材料名 / name 追 `·c${n}` 段号；craft_vec 行 vector_id=craft_id /
//   vector_kind='chunk'。searchCraft/query_craft 管线零改动天然含它（无 source_kind 过滤）
//   ——span 经 craft_id 解码回查 closure_material.chunk_spans_json（F-02 全局车道 span
//   唯一落点）。
//
// 范式判据（ADR-3）：分块（chunkChapter 纯函数经策略 seam）+ 标记重建 + 哈希 + 落表 = 全纯
// 代码机械；零语义判断（章界语义判断在 Wave B 两段式分章 + LLM 兜底，本层只消费其存档）。
//
// BMad CR 2026-09-02 修复批（本文件相关）：
// - CR-006：章标记全删 → 回自动分章（design §2.3）——零标记且 regex 重跑 high/medium 可复现
//   章界时刷新登记（消「登记行旧 span（标记基面）vs 伪章 chunk 行（裸文本基面）」分歧）；
//   skip 判定加登记收敛 belt（chapters 漂移不 hash-skip）。
// - CR-007：FTS-only 稳态（无模型 / prevailing mismatch）下既有 pending 行文本面一致 → 跳过
//   重写（消每次启动全量 DELETE+INSERT 空转）；pending_embed 保留，模型恢复照常补嵌。
// - CR-008：listMaterialRows('project') 无 projectId → throw（防跨项目全量静默泄漏）。
// - CR-014：walkMaterialSources 跟随 symlink/junction 常规文件链接（statSync）；坏链 warn 跳过。
// - CR-018：backfill 循环 per-item try/catch（单材料失败不中断车道）。
// - CR-019：resolveLaneForMaterial 空 path 项目记录（''）镜像 null 守卫（防 cwd/materials
//   误 orphan 删活材料）。
// - CR-030：durable 结构化失败（parse-failed/scanned/empty/too-large 且原件仍在）→ status=
//   'failed' 登记行落库；backfill 见 failed 行跳过不重解析（显式 reingest 才重试）。
// - CR-033：MaterialSummaryRow 摘要投影（SQL 不取 chapters_json/chunk_spans_json 大数组）
//   ——listMaterialRowsForLane（watcher/backfill 枚举面）用之；详情面 getMaterialRow 全列。
//
// expected_downstream_consumers:
// - Wave C materialWatcher（materials/ 双车道 watcher → registerMaterial / reindex 路由）。
// - Wave D materialIpc（materials:reingest → registerMaterial；materials:delete 四清 →
//   deleteMaterialRows〔只清 db 不动文件——文件四清归 Wave D delete IPC，D8，本函数即其
//   db 清理复用点〕）+ materials:list → listMaterialRows / getMaterialRow。
// - 10.2 经验文档管线：query_craft 命中 + craft_id 解码回查 chunk_spans（锚定四元组取数面）。
// - 10.3 小说拆解：章可寻址经 chapters_json（章号→span）+ read_file 读派生 .md。

/** 项目车道 chunk 行的 source_kind（与 chapter/setting_md 等同表共存，共享检索面）。 */
export const MATERIAL_SOURCE_KIND = 'material';

/** 全局车道 chunk 行的 source_kind（closure_craft_entry——craft orphan 清扫收窄谓词锚）。 */
export const MATERIAL_CHUNK_SOURCE_KIND = 'material_chunk';

/** 全局车道材料根目录（~/.orison/materials/——craft-kb 同级惯例，机器级非项目内）。 */
export function getGlobalMaterialsRoot(): string {
  return path.join(homedir(), '.orison', 'materials');
}

/** embed 批量尺寸（design §3.2：32 chunks/调用——事务外 best-effort）。 */
export const MATERIAL_EMBED_BATCH_SIZE = 32;

/** 材料车道描述（watcher / backfill / Wave D IPC 的公共入参形态）。 */
export type MaterialLane = { scope: 'project'; projectDir: string } | { scope: 'global' };

interface ResolvedLane {
  scope: 'project' | 'global';
  materialsRoot: string;
  /** registry 5 位 projectId（project 车道；global 车道 null）。 */
  projectId: string | null;
}

/**
 * 解析车道物理参数。project 车道 materialsRoot = `<project>/materials`、projectId 经注册库
 * （mirror 2.7 as-built：registry 5 位 id，非 meta.id UUID）；未注册 → null（调用方跳过
// ——chapterChunk backfill 同语义：watcher 在项目注册后的事件里自愈）。
 */
export function resolveMaterialLane(lane: MaterialLane): ResolvedLane | null {
  if (lane.scope === 'global') {
    return { scope: 'global', materialsRoot: getGlobalMaterialsRoot(), projectId: null };
  }
  const projectDir = path.resolve(lane.projectDir);
  const projectId = getProject(projectDir)?.projectId ?? null;
  if (projectId === null) return null;
  return { scope: 'project', materialsRoot: path.join(projectDir, 'materials'), projectId };
}

/** 登记行为锚的车道解析（reindexMaterial 用：projectId 取自登记行，registry 反查项目路径）。 */
function resolveLaneForMaterial(material: Material): ResolvedLane | null {
  if (material.scope === 'global') {
    return { scope: 'global', materialsRoot: getGlobalMaterialsRoot(), projectId: null };
  }
  const projectId = material.projectId;
  if (projectId === null) return null;
  const projectPath = getProjectById(projectId)?.path;
  // CR-019：空串 path 镜像 undefined/null 守卫——path.resolve('') = cwd 会让 materialsRoot 落
  // 到 cwd/materials，reindex 的 orphan 判定随即误删活材料（坏登记行防御，mirror 模式 B）。
  if (projectPath === undefined || projectPath === null || projectPath === '') return null;
  return { scope: 'project', materialsRoot: path.join(path.resolve(projectPath), 'materials'), projectId };
}

// ── 车道内相对路径 ↔ source_path（schema 约定：project 带 materials/ 前缀，global 恒等）──

/**
 * 登记行 source_path → materials 根内相对路径；形态不符（防御）→ null。
 * 入参结构性收窄（CR-033：摘要行 MaterialSummaryRow 也走本映射——scope + provenance 足矣）。
 */
export function relInMaterialsOfSourcePath(
  material: Pick<Material, 'scope' | 'provenance'>,
): string | null {
  const rel =
    material.scope === 'project'
      ? material.provenance.sourcePath.startsWith('materials/')
        ? material.provenance.sourcePath.slice('materials/'.length)
        : null
      : material.provenance.sourcePath;
  if (rel === null) return null;
  return normalizeMaterialRelPath(rel);
}

/** 登记行 → 派生 .md 相对 materials 根路径（Wave B derivedRelPathFor 复用）；不可解析 → null。 */
export function derivedRelPathForMaterial(
  material: Pick<Material, 'scope' | 'provenance'>,
): string | null {
  const rel = relInMaterialsOfSourcePath(material);
  return rel === null ? null : derivedRelPathFor(rel);
}

// ── id 帮助函数（craft_id 解码回查的编码侧；测试与 Wave D 复用）──

/** 材料章寻址 id（closure_entry.chapter_id / craft_id 的章段）。 */
export function materialChapterRef(materialId: string, chapterIndex: number): string {
  return `${materialId}.ch${chapterIndex}`;
}

/** 项目车道 chunk 行 entry_id（= entry_vec vector_id）。 */
export function materialEntryId(
  projectId: string,
  materialId: string,
  chapterIndex: number,
  chunkIndex: number,
): string {
  return `${projectId}:${materialChapterRef(materialId, chapterIndex)}#c${chunkIndex}`;
}

/** 全局车道 chunk 行 craft_id（= craft_vec vector_id；`mat:` 前缀 = 命中渲染器识别材料行）。 */
export function materialChunkCraftId(
  materialId: string,
  chapterIndex: number,
  chunkIndex: number,
): string {
  return `mat:${materialChapterRef(materialId, chapterIndex)}#c${chunkIndex}`;
}

/**
 * craft_id 解码（F-02 回查缝解码侧，materialChunkCraftId 的逆）：`mat:<materialId>.ch<i>#c<n>`
 * → 组成三元组；非材料行（无 `mat:` 前缀）/ 形态不符 → null。供命中渲染器与测试复用。
 */
export function decodeMaterialChunkCraftId(
  craftId: string,
): { materialId: string; chapterIndex: number; chunkIndex: number } | null {
  const m = /^mat:(mat-[0-9a-f]{12})\.ch(\d+)#c(\d+)$/.exec(craftId);
  if (m === null) return null;
  return {
    materialId: m[1]!,
    chapterIndex: Number.parseInt(m[2]!, 10),
    chunkIndex: Number.parseInt(m[3]!, 10),
  };
}

/**
 * F-02 全局车道消费缝（design §3.2「命中渲染器按 craft_id 前缀 `mat:` 识别材料行,附 span
 * 脚注」）：craft_id 集 → `craftId → chunk span` 映射。每 materialId **一次** SELECT（整材料
 * chunk_spans 一次读出在内存对拍，非每命中全文读）；非材料行 / 登记行缺失 → 该行缺席
 * （best-effort 脚注——回查失败不阻命中渲染，调用方兜底）。
 */
export function lookupMaterialChunkSpans(craftIds: readonly string[]): Map<string, MaterialChunkSpan> {
  const out = new Map<string, MaterialChunkSpan>();
  const seenMaterials = new Set<string>();
  for (const craftId of craftIds) {
    const decoded = decodeMaterialChunkCraftId(craftId);
    if (decoded === null || seenMaterials.has(decoded.materialId)) continue;
    seenMaterials.add(decoded.materialId);
    const material = getMaterialRow(decoded.materialId);
    if (material === null) continue;
    for (const span of material.chunkSpans) {
      out.set(materialChunkCraftId(decoded.materialId, span.chapterIndex, span.chunkIndex), span);
    }
  }
  return out;
}

// ── 登记层 repository（纯函数，mirror assetRepository 惯例；同步保持同步）──

interface MaterialRow {
  material_id: string;
  scope: string;
  project_id: string | null;
  kind: string;
  name: string;
  source_path: string;
  format: string;
  provenance_json: string;
  quality_json: string;
  chapters_json: string;
  chunk_spans_json: string;
  content_hash: string;
  char_count: number;
  status: string;
}

function rowToMaterial(r: MaterialRow): Material | null {
  // tolerant（mirror CR-E6）：坏 JSON/坏行跳过不崩调用方——登记层是 DERIVED 可重建面。
  try {
    return materialSchema.parse({
      materialId: r.material_id,
      scope: r.scope,
      projectId: r.project_id,
      kind: r.kind,
      name: r.name,
      format: r.format,
      provenance: JSON.parse(r.provenance_json),
      quality: JSON.parse(r.quality_json),
      chapters: JSON.parse(r.chapters_json),
      chunkSpans: JSON.parse(r.chunk_spans_json),
      contentHash: r.content_hash,
      status: r.status,
    });
  } catch {
    return null;
  }
}

const MATERIAL_COLS =
  'material_id, scope, project_id, kind, name, source_path, format, provenance_json, quality_json, chapters_json, chunk_spans_json, content_hash, char_count, status';

export function getMaterialRow(materialId: string): Material | null {
  const row = getDb()
    .prepare(`SELECT ${MATERIAL_COLS} FROM closure_material WHERE material_id=?`)
    .get(materialId) as MaterialRow | undefined;
  return row === undefined ? null : rowToMaterial(row);
}

// ── 摘要投影（CR-033）──

/**
 * 登记行摘要投影（CR-033）：**不含 chapters / chunkSpans**——列表/枚举面（watcher derived
 * 路由 / backfill 孤儿清扫 / materials:list）消费不到两个大数组，SQL 层就不取不 parse
 * （两百份语料 × 每份数百 chunk span 的 JSON 解析是纯浪费）。详情面用 getMaterialRow 全列。
 */
export interface MaterialSummaryRow {
  materialId: string;
  scope: 'project' | 'global';
  projectId: string | null;
  kind: string;
  name: string;
  format: MaterialFormat;
  provenance: Material['provenance'];
  quality: Material['quality'];
  charCount: number;
  status: MaterialStatus;
  contentHash: string;
}

const MATERIAL_SUMMARY_COLS =
  'material_id, scope, project_id, kind, name, format, provenance_json, quality_json, content_hash, char_count, status';

interface MaterialSummarySqlRow {
  material_id: string;
  scope: string;
  project_id: string | null;
  kind: string;
  name: string;
  format: string;
  provenance_json: string;
  quality_json: string;
  content_hash: string;
  char_count: number;
  status: string;
}

function rowToSummaryRow(r: MaterialSummarySqlRow): MaterialSummaryRow | null {
  // tolerant（mirror rowToMaterial）：坏 JSON/坏行跳过不崩调用方——登记层是 DERIVED 可重建面。
  try {
    if (r.scope !== 'project' && r.scope !== 'global') return null;
    if (!MATERIAL_FORMATS.includes(r.format as MaterialFormat)) return null;
    if (!MATERIAL_STATUSES.includes(r.status as MaterialStatus)) return null;
    return {
      materialId: r.material_id,
      scope: r.scope,
      projectId: r.project_id,
      kind: r.kind,
      name: r.name,
      format: r.format as MaterialFormat,
      provenance: materialProvenanceSchema.parse(JSON.parse(r.provenance_json)),
      quality: materialQualitySchema.parse(JSON.parse(r.quality_json)),
      charCount: r.char_count,
      status: r.status as MaterialStatus,
      contentHash: r.content_hash,
    };
  } catch {
    return null;
  }
}

/** project 车道枚举的 projectId 必备守卫（CR-008——防跨项目全量静默泄漏）。 */
function requireProjectIdForScope(projectId?: string): string {
  if (projectId === undefined || projectId === null) {
    // 镜像坏参模式 B（invariant 违反即抛）：'project' 车道无 projectId 的枚举会静默退化成
    // 跨项目全量（WHERE 只按 scope）——调用方拿到的脏结果无法在下游察觉。
    throw new Error(
      'listMaterialRows/listMaterialSummaries: project 车道必须携带 registry projectId（CR-008）',
    );
  }
  return projectId;
}

/**
 * 车道登记行全列枚举（详情/回查面）。⚠️ CR-008：project 车道无 projectId → throw。
 * 列表/枚举面请用 listMaterialSummaries（CR-033 摘要投影，不取大数组两列）。
 */
export function listMaterialRows(scope: 'project' | 'global', projectId?: string): Material[] {
  const db = getDb();
  const rows: MaterialRow[] =
    scope === 'project'
      ? (db
          .prepare(`SELECT ${MATERIAL_COLS} FROM closure_material WHERE scope=? AND project_id=?`)
          .all(scope, requireProjectIdForScope(projectId)) as MaterialRow[])
      : (db
          .prepare(`SELECT ${MATERIAL_COLS} FROM closure_material WHERE scope=?`)
          .all(scope) as MaterialRow[]);
  return rows.flatMap((r) => {
    const m = rowToMaterial(r);
    return m === null ? [] : [m];
  });
}

/**
 * 车道登记行摘要枚举（CR-033：SQL 不取 chapters_json / chunk_spans_json——materials:list /
 * watcher / backfill 等列表面专用）。project 车道无 projectId → throw（CR-008 同守卫）。
 */
export function listMaterialSummaries(
  scope: 'project' | 'global',
  projectId?: string,
): MaterialSummaryRow[] {
  const db = getDb();
  const rows: MaterialSummarySqlRow[] =
    scope === 'project'
      ? (db
          .prepare(
            `SELECT ${MATERIAL_SUMMARY_COLS} FROM closure_material WHERE scope=? AND project_id=?`,
          )
          .all(scope, requireProjectIdForScope(projectId)) as MaterialSummarySqlRow[])
      : (db
          .prepare(`SELECT ${MATERIAL_SUMMARY_COLS} FROM closure_material WHERE scope=?`)
          .all(scope) as MaterialSummarySqlRow[]);
  return rows.flatMap((r) => {
    const s = rowToSummaryRow(r);
    return s === null ? [] : [s];
  });
}

/**
 * 车道登记行摘要枚举（lane 形态便捷面——project 车道内部解析 registry projectId）。
 * CR-033：返回摘要投影（watcher derived 路由 / backfill 取数面——大数组零消费）。
 */
export function listMaterialRowsForLane(lane: MaterialLane): MaterialSummaryRow[] {
  const resolved = resolveMaterialLane(lane);
  if (resolved === null) return [];
  return resolved.scope === 'project'
    ? resolved.projectId !== null
      ? listMaterialSummaries('project', resolved.projectId)
      : []
    : listMaterialSummaries('global');
}

/**
 * F-05 防清 COALESCE：provenance 的 UI 可后补字段（medium/tier/author/lang/originDate/
 * description——摄取管线恒写缺省 'other'/'unspecified'/null，任何既有非空值都来自用户策展
 * 〔Wave D 单行表单 / E10.2a 简介多行 + 标题〕）在重摄取时保留不清（mirror
 * worldStateRepository subject COALESCE CR-E2 + attachmentMeta derivedOf 不盲覆 CR-017）。
 * E10.2a〔F-03〕description 入列——不加则重摄取静默清掉用户后补的简介，正是该函数当年要防
 * 的事。E10.4〔P2〕url 第七字段入列——在线通道 reingest/重导入不清溯源 URL（漏加则 watcher
 * 默认 provenance 重登记即清掉预填 url，正是该函数要防的事；本地文件材料两侧恒 null 无行为差）。
 * 管线事实字段（sourcePath/via/extractor/ingestedAt）恒取新值。
 */
function preserveCuratedProvenance(
  fresh: Material['provenance'],
  existing: Material | null,
): Material['provenance'] {
  if (existing === null) return fresh;
  const old = existing.provenance;
  return {
    ...fresh,
    medium: old.medium ?? fresh.medium,
    tier: old.tier ?? fresh.tier,
    author: old.author ?? fresh.author,
    lang: old.lang ?? fresh.lang,
    originDate: old.originDate ?? fresh.originDate,
    description: old.description ?? fresh.description,
    url: old.url ?? fresh.url,
  };
}

/**
 * 登记 upsert（materialSchema 全字段 JSON 列）。冲突键 = material_id（路径身份，F-19——
 * 同路径换内容 = 同 ID 重摄取幂等）；UNIQUE(scope, source_path) 是双保险。
 * ⚠️ chunk_spans_json **不在 UPDATE 集**——它是索引器事务的回填面（F-02），登记 upsert
 * 只在首插时写 []（Wave B 成功路径恒 []），重索引事务独占后续写。
 */
export function upsertMaterialRow(material: Material): void {
  const db = getDb();
  const existing = getMaterialRow(material.materialId);
  const provenance = preserveCuratedProvenance(material.provenance, existing);
  // E10.2a 标题防清（mirror preserveCuratedProvenance 哲学）：materialId 是路径身份、同路径
  // stem 恒定，故既有行 name ≠ 摄取产物 name（stem）必是用户经 materials:update-name 策展的
  // 标题——重摄取保留不清。要改回 stem 走表单改名（update-name 收任意非空值）。
  const name = existing !== null ? existing.name : material.name;
  db.prepare(
    `INSERT INTO closure_material
       (material_id, scope, project_id, kind, name, source_path, format,
        provenance_json, quality_json, chapters_json, chunk_spans_json,
        content_hash, char_count, status, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(material_id) DO UPDATE SET
       kind=excluded.kind,
       name=excluded.name,
       source_path=excluded.source_path,
       format=excluded.format,
       provenance_json=excluded.provenance_json,
       quality_json=excluded.quality_json,
       chapters_json=excluded.chapters_json,
       content_hash=excluded.content_hash,
       char_count=excluded.char_count,
       status=excluded.status,
       updated_at=datetime('now')`,
  ).run(
    material.materialId,
    material.scope,
    material.projectId,
    material.kind,
    name,
    material.provenance.sourcePath,
    material.format,
    JSON.stringify(provenance),
    JSON.stringify(material.quality),
    JSON.stringify(material.chapters),
    JSON.stringify(material.chunkSpans), // 仅 INSERT 分支消费（见上方 ⚠️；冲突分支不读它）
    material.contentHash,
    material.quality.charCount,
    material.status,
  );
}

// ── 双车道 chunk 行删除（orphan / 重索引前清场共用；单事务）──

/** LIKE 前缀转义（mirror chapterChunkIndexer escapeVecPrefix——`_`/`%` 通配符纪律）。 */
function escapeLikePrefix(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 删一个材料的全部派生行：登记行 + 该车道 chunk 行（entry/craft entry 行删除触发器同步清
 * FTS）+ vec 行（前缀删——孤儿 vec 行一并清，防同 PK 重索引死循环，mirror E5）。**不动
 * 文件**（原件/派生 .md 四清归 Wave D materials:delete IPC，D8——本函数是它的 db 清理复用点）。
 *
 * E10.2b W3.4 尾部钩子（材料删除联动，F-07 触发③）：db 清理后 best-effort 把该材料的手艺卡
 * 讲法标 stale + 台账 status='material-deleted'（经单卡 repository——卡保留快照仍在，防孤儿
 * 卡失锚不知情）。钩子失败只 warn 绝不阻删除（mirror notifyRegistered 吞错纪律）。
 */
export function deleteMaterialRows(materialId: string): void {
  const db = getDb();
  const material = getMaterialRow(materialId);
  if (material === null) {
    // 登记行已不在（或坏行）：projectId-agnostic 双车道兜底扫一遍 chunk 行（半删/登记行损坏
    // 形态；materialId 路径身份全局唯一，前缀删不依赖登记行反解 projectId）。
    db.transaction(() => {
      if (isSqliteVecAvailable()) {
        db.prepare("DELETE FROM entry_vec WHERE vector_id LIKE ? ESCAPE '\\'").run(
          `%:${escapeLikePrefix(materialId)}.ch%`,
        );
      }
      db.prepare(
        "DELETE FROM closure_entry WHERE source_kind='material' AND chapter_id LIKE ? ESCAPE '\\'",
      ).run(`${escapeLikePrefix(materialId)}.ch%`);
      deleteChunkRows('global', materialId, null);
      db.prepare('DELETE FROM closure_material WHERE material_id=?').run(materialId);
    })();
  } else {
    db.transaction(() => {
      deleteChunkRows(material.scope, materialId, material.projectId);
      db.prepare('DELETE FROM closure_material WHERE material_id=?').run(materialId);
    })();
  }
  notifyCraftDistillMaterialDeleted(materialId);
}

/** E10.2b W3.4：材料删除 → 手艺卡讲法 stale + 台账 material-deleted（best-effort 尾钩，NEVER throws）。 */
function notifyCraftDistillMaterialDeleted(materialId: string): void {
  try {
    markCraftTeachingsStaleByMaterial(materialId);
    const ledger = getCraftDistillLedger(materialId);
    if (ledger !== null) {
      upsertCraftDistillLedger({ ...ledger, status: 'material-deleted', phase: null });
    }
  } catch (err) {
    getLogger().warn(
      { err: errMsg(err), materialId },
      'material delete: craft card stale hook failed - continuing (cards keep quote snapshots)',
    );
  }
}

function deleteChunkRows(
  scope: 'project' | 'global',
  materialId: string,
  projectId: string | null,
): void {
  const db = getDb();
  if (scope === 'project' && projectId !== null) {
    if (isSqliteVecAvailable()) {
      db.prepare("DELETE FROM entry_vec WHERE vector_id LIKE ? ESCAPE '\\'").run(
        `${escapeLikePrefix(projectId)}:${escapeLikePrefix(materialId)}.ch%`,
      );
    }
    db.prepare(
      "DELETE FROM closure_entry WHERE project_id=? AND source_kind='material' AND chapter_id LIKE ? ESCAPE '\\'",
    ).run(projectId, `${escapeLikePrefix(materialId)}.ch%`);
    return;
  }
  if (scope === 'project') {
    // 防御带（mirror 下方 null-material 兜底扫）：project 车道登记行但 projectId 缺失——
    // 坏行形态（正常管线 registerMaterial 恒经 registry 解析，不写此形态；坏行多来自手改
    // db）。projectId 无关前缀扫，不让 chunk 行在登记行删除后成为永久孤儿。
    if (isSqliteVecAvailable()) {
      db.prepare("DELETE FROM entry_vec WHERE vector_id LIKE ? ESCAPE '\\'").run(
        `%:${escapeLikePrefix(materialId)}.ch%`,
      );
    }
    db.prepare(
      "DELETE FROM closure_entry WHERE source_kind='material' AND chapter_id LIKE ? ESCAPE '\\'",
    ).run(`${escapeLikePrefix(materialId)}.ch%`);
    return;
  }
  if (scope === 'global') {
    if (isSqliteVecAvailable()) {
      db.prepare("DELETE FROM closure_craft_vec WHERE vector_id LIKE ? ESCAPE '\\'").run(
        `${escapeLikePrefix(`mat:${materialId}`)}.ch%`,
      );
    }
    db.prepare(
      "DELETE FROM closure_craft_entry WHERE source_kind='material_chunk' AND craft_id LIKE ? ESCAPE '\\'",
    ).run(`${escapeLikePrefix(`mat:${materialId}`)}.ch%`);
  }
}

// ── per-scope 串行队列（B1 形态：chained promise .then(run,run)；禁 .finally）──

const inflightLaneWork = new Map<string, Promise<unknown>>();

function laneKeyOf(scope: 'project' | 'global', projectId: string | null): string {
  return scope === 'global' ? 'global' : `project:${projectId ?? 'unresolved'}`;
}

function enqueueLaneWork<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = inflightLaneWork.get(key);
  const chained = prior ? prior.then(fn, fn) : fn();
  inflightLaneWork.set(key, chained);
  const clear = () => {
    if (inflightLaneWork.get(key) === chained) inflightLaneWork.delete(key);
  };
  chained.then(clear, clear);
  return chained;
}

// ── DI seam（mirror ChapterReindexDeps / CraftReindexDeps）──

export interface MaterialIndexerDeps {
  /** 解析 embed 模型；null → FTS-only（pending_embed）。缺省 resolveEmbeddingModel。 */
  resolveModel?: () => ResolvedModel | null;
  /** 批量 embed（32/调用聚合形态）；缺省 generateEmbeddings 包装（60s 超时，mirror CR-06 批量档）。 */
  embedBatch?: (model: ResolvedModel, texts: string[]) => Promise<number[][]>;
  /** 解析内核注入（registerMaterial → ingestMaterial 透传；测试 stub 零解析可测）。 */
  parse?: MaterialIngestDeps['parse'];
  /** 时钟注入（ingestedAt 可测）。 */
  now?: () => Date;
  /** 绕过 content-hash skip（模型/维度迁移的 rebuild 授权路径）。 */
  force?: boolean;
  /**
   * E10.4 W2（P2 seam）：在线通道 provenance 预填——ingest 产物的 provenance 组装恒走缺省
   * （medium='other'/tier='unspecified'/url=null，materialIngest 不查调用方意图），登记 upsert
   * 前由本缝叠加（medium/tier/url/via/author/originDate）。与 preserveCuratedProvenance 的
   * 分工：本缝改「本轮摄取产物」，COALESCE 守「既有行非空值」——重摄取时旧值（用户经 UI 后补
   * 的策展值，或上次预填）优先于本缝预填，刻意（UI 后补 > 重导入预填）。
   */
  provenanceOverrides?: Partial<Material['provenance']>;
  /** E10.4 W2：附加 parseNotes（截断标注等摄取后事实——best-effort，后续重摄取按解析面重建会冲掉；持久面 = 文件尾注 + IPC 回报行）。 */
  extraParseNotes?: string[];
  /** E10.4 W2：显示名覆写（页面标题——stem 是 URL 派生缺省名，标题作展示名）；既有行名策展防清照常（upsertMaterialRow name 规则）。 */
  nameOverride?: string;
}

/** 缺省批量 embed：32 texts/批一次 generateEmbeddings 调用，结果按 input 序拼接。 */
async function defaultEmbedBatch(model: ResolvedModel, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MATERIAL_EMBED_BATCH_SIZE) {
    const slice = texts.slice(i, i + MATERIAL_EMBED_BATCH_SIZE);
    // C3.1 计量台账：拆书材料索引重嵌标签（每批 = 一行如实）。
    const res = await generateEmbeddings(model, { input: slice }, { signal: AbortSignal.timeout(60_000), taskType: 'material-embed' });
    out.push(...res.embeddings);
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 摄取登记（registerMaterial：ingestMaterial 真身钩子装配点，F-24）──

/**
 * CR-030 durable 摄取失败原因集：原件**结构性**坏（不换文件不会自愈——坏档/扫描件/空文本/
 * 超限），失败登记在案即 backfill 退避。transient（read-failed 瞬时 IO / missing / invalid-path）
 * 不落库——backfill 每次照常重试（瞬时错误自愈语义）。
 */
const DURABLE_INGEST_FAILURES: ReadonlySet<string> = new Set([
  'parse-failed',
  'scanned',
  'empty',
  'too-large',
]);

/** durable 失败均来自白名单扩展（walk/watcher 预滤）——防御性兜底 txt（实际不可达）。E10.2a += 字幕三扩展（〔F-13〕本表在 materialIndexer 非 materialIngest——白名单分派表归彼处并行扩展）。 */
const FAILED_FORMAT_BY_EXT: Readonly<Record<string, MaterialFormat>> = {
  '.txt': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.srt': 'srt',
  '.ass': 'ass',
  '.vtt': 'vtt',
};

/**
 * failed 登记行装配（CR-030）：provenance/quality 尽量填（via 哨兵 'unparsed'——失败早于解析
 * provenance 装配，诚实标注而非编造）；reason + error 进 quality.parseNotes（UI 徽章 tooltip
 * 消费面）；contentHash = 失败指纹（sha256 形态满足 schema；路径+reason 派生，成功重摄取时被
 * 真内容 hash 覆盖）。chapters/chunkSpans 空、status='failed'（schema 已预留）。
 */
function assembleFailedMaterial(
  scope: 'project' | 'global',
  projectId: string | null,
  rel: string,
  reason: string,
  error: string,
  now: () => Date,
): Material {
  const ext = path.posix.extname(rel).toLowerCase();
  const format = FAILED_FORMAT_BY_EXT[ext] ?? 'txt';
  const sourcePath = materialSourcePath(scope, rel);
  return {
    materialId: materialIdFor(scope, sourcePath),
    scope,
    projectId,
    kind: 'prose',
    name: path.posix.basename(rel, path.posix.extname(rel)),
    format,
    provenance: {
      // CR-17：medium 默认镜像 assembleMaterial 的 per-format 面（字幕三格式 → 'video'）——
      // failed 行徽章与成功行同型呈现，不因失败降格 'other'（AC1 只测成功路径的原缺口）。
      medium: isSubtitleFormat(format) ? 'video' : 'other',
      tier: 'unspecified',
      sourcePath,
      via: 'unparsed',
      extractor: 'builtin-text',
      ingestedAt: now().toISOString(),
      author: null,
      lang: null,
      originDate: null,
      // E10.2a：schema description 输出类型必含（default(null) 只豁免输入）——摄取期恒 null，
      // 与 author 三字段同型（UI 后补 + preserveCuratedProvenance 防清）。
      description: null,
      // E10.4：url 同型（输出类型必含）——在线拉取通道经 provenanceOverrides 预填（W2），
      // 本地文件/失败行恒 null。
      url: null,
    },
    quality: {
      ok: false,
      scanned: reason === 'scanned',
      nonUtf8: false,
      parseNotes: [`摄取失败（${reason}）：${error}`],
      charCount: 0,
      chapterDetection: { method: 'none', confidence: 'low', matchedFormats: [] },
    },
    chapters: [],
    chunkSpans: [],
    contentHash: `sha256:${createHash('sha256')
      .update(`failed\0${sourcePath}\0${reason}`, 'utf-8')
      .digest('hex')}`,
    status: 'failed',
  };
}

export type RegisterMaterialOutcome =
  | 'registered' // fresh / reingested / reingest-skipped-manual（登记行写入 + 索引触发——含 CR-001 派生人工编辑保留态，Material 已带人工内容落库）
  | 'reused' // 原件未变沿用存档章界（登记行幂等刷新 + 索引 hash-skip）
  | 'orphaned' // 原件已不存在 → 清登记 + chunk 行（watcher 删除事件的清扫路径）
  | 'unregistered' // project 车道项目未注册（无 registry projectId——entry 命名空间必需）
  | 'rejected'; // ingest 结构化失败（三档拒收/坏档/扫描件等——reason 透传，Wave D 拼装分类）

export interface RegisterMaterialResult {
  outcome: RegisterMaterialOutcome;
  materialId?: string;
  /** outcome='rejected' 时的 ingest 失败 reason（三档拒收分类由 Wave D 拼装）。 */
  reason?: string;
}

/**
 * 登记一份材料（watcher / 重摄取 / 批量导入的公共入口）：ingestMaterial（Wave B 管线——
 * 解析→质量诊断→两段式分章→派生 .md 落盘）→ 本模块写 closure_material 登记行 → 触发
 * reindexMaterial（双车道 chunk 索引 + chunk_spans 回填）。per-scope 串行队列内执行
 * （200 件批量防 watcher 风暴）。never-throws 由调用方兜（per-item warn 归 watcher flush）。
 */
export async function registerMaterial(
  lane: MaterialLane,
  sourceRelPath: string,
  deps: MaterialIndexerDeps = {},
): Promise<RegisterMaterialResult> {
  const resolvedLane = resolveMaterialLane(lane);
  if (resolvedLane === null) {
    return { outcome: 'unregistered' };
  }
  const scopeInput: MaterialIngestScope = {
    scope: resolvedLane.scope,
    materialsRoot: resolvedLane.materialsRoot,
    projectId: resolvedLane.projectId,
  };
  return enqueueLaneWork(laneKeyOf(resolvedLane.scope, resolvedLane.projectId), () =>
    runRegisterMaterial(scopeInput, sourceRelPath, resolvedLane, deps),
  );
}

async function runRegisterMaterial(
  scopeInput: MaterialIngestScope,
  sourceRelPath: string,
  lane: ResolvedLane,
  deps: MaterialIndexerDeps,
): Promise<RegisterMaterialResult> {
  const result = await ingestMaterial(scopeInput, sourceRelPath, {
    ...(deps.parse !== undefined ? { parse: deps.parse } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    // CR-001 生产装配（组1 转达接线）：登记 content hash 查询闭包——「原件未变而派生被
    // 人工编辑」的跳过覆写判定生产激活（materialIngest 侧 never-throws 包壳 + 幂等语义
    // 注记见 materialIngest.ts 模块头）。缺行/抛错 → null → 退回既有自动路径（无回归）。
    getRegisteredContentHash: (materialId) => getMaterialRow(materialId)?.contentHash ?? null,
    // C2 防清 belt 生产装配（mirror 上缝接线形态）：markers=0 重摄取（CR-001 路径）时既有
    // 章界非空则保留——0 章中间行不落库（F1 假态/F12 cleared 窗口根因；materialIngest 不查
    // db——依赖边界）。零章/缺行由 ingest 侧缝读取包壳判空，belt 不触发。
    getRegisteredMaterial: (materialId) => getMaterialRow(materialId),
  });
  if (!result.ok) {
    if (result.reason === 'missing') {
      // 原件不在（watcher 删除事件 / 外部删除）→ orphan 清扫（登记 + 双车道 chunk 行）。
      const rel = normalizeMaterialRelPath(sourceRelPath);
      if (rel === null) return { outcome: 'rejected', reason: 'invalid-path' };
      const materialId = materialIdFor(lane.scope, materialSourcePath(lane.scope, rel));
      deleteMaterialRows(materialId);
      return { outcome: 'orphaned', materialId };
    }
    // CR-030：durable 结构化失败且原件仍在 → failed 登记行落库（UI 可见 + backfill 退避——
    // 坏档不再每次启动重解析；显式 reingest / 删文件重拖才重试）。transient 不落库。
    if (DURABLE_INGEST_FAILURES.has(result.reason)) {
      const rel = normalizeMaterialRelPath(sourceRelPath);
      if (rel !== null && existsSync(path.join(lane.materialsRoot, rel))) {
        const materialId = materialIdFor(lane.scope, materialSourcePath(lane.scope, rel));
        upsertMaterialRow(
          assembleFailedMaterial(
            lane.scope,
            lane.projectId,
            rel,
            result.reason,
            result.error,
            deps.now ?? (() => new Date()),
          ),
        );
        return { outcome: 'rejected', reason: result.reason, materialId };
      }
    }
    return { outcome: 'rejected', reason: result.reason };
  }
  // E10.4 W2（P2 seam）三面叠加（provenance 预填 / 显示名覆写 / 附加 notes）——都在 upsert
  // 之前改「本轮摄取产物」，preserveCuratedProvenance 的既有值优先语义不受影响。
  let material = result.material;
  if (deps.provenanceOverrides !== undefined) {
    // CR-11：显式 undefined 值过滤——spread 语义下 explicit undefined 会覆写已解析值落成
    // undefined（Partial<> 形参面允许显式 undefined 键，条件展开调用面约定 absent ≠ 覆写）。
    const overrides = Object.fromEntries(
      Object.entries(deps.provenanceOverrides).filter(([, v]) => v !== undefined),
    );
    material = { ...material, provenance: { ...material.provenance, ...overrides } };
  }
  if (deps.nameOverride !== undefined && deps.nameOverride.length > 0) {
    material = { ...material, name: deps.nameOverride };
  }
  if (deps.extraParseNotes !== undefined && deps.extraParseNotes.length > 0) {
    material = {
      ...material,
      quality: { ...material.quality, parseNotes: [...material.quality.parseNotes, ...deps.extraParseNotes] },
    };
  }
  upsertMaterialRow(material);
  await runReindexMaterial(material.materialId, lane, deps);
  return {
    outcome: result.outcome === 'reused' ? 'reused' : 'registered',
    materialId: material.materialId,
  };
}

// ── 重索引（reindexMaterial：章结构从派生 .md 标记重建 + 双车道 chunk 写入）──

export type ReindexMaterialOutcome =
  | 'written'
  | 'hash-skip'
  | 'orphan' // 原件不在 → 清行
  | 'unregistered' // 登记行不存在
  | 'unresolvable' // project 车道项目已不在注册库 / source_path 形态坏 → 跳过不动（warn）
  | 'missing-derived' // 派生 .md 缺失 → 跳过（下轮 register/backfill 重建派生后自愈）
  | 'no-strategy'; // kind 无分块策略（V1 仅 prose）→ 诚实跳过不硬编码（D6 seam）

export interface ReindexMaterialResult {
  outcome: ReindexMaterialOutcome;
  chunkCount: number;
}

/** 供索引循环消费的章单元（零章材料折叠为全文伪章，F-09）。 */
interface ChapterUnit {
  index: number;
  title: string | null;
  charStart: number;
  charEnd: number;
  paraStart: number;
  paraEnd: number;
  method: MaterialChapterSpan['method'];
  confidence: MaterialChapterSpan['confidence'];
  /** true = 零章伪章（展示名用「全文」，F-09 诚实标注）。 */
  pseudo: boolean;
}

/**
 * 全局 span 索引行。数组位序 = 唯一寻址键（chunks/indexTexts/vectors 按位 zip，mirror B5）；
 * `chunkNo` = 章内 chunk 序（该章 chunk 列表的枚举位——entry_id/craft_id 的 `#c${n}` 段与
 * chunk_spans.chunkIndex 同源，不消费分块器 chunk.index 字段防错位）。
 */
interface IndexedChunk {
  unit: ChapterUnit;
  chunk: ChapterChunk;
  chunkNo: number;
  /** 全局（派生文本基面）chunk span——章偏移平移后的 char/para。 */
  charStart: number;
  charEnd: number;
  paraStart: number;
  paraEnd: number;
}

/** 读派生 .md（BOM strip + CRLF→LF 归一——mirror readChapterSource 惯例）。 */
function readDerivedText(materialsRoot: string, relInMaterials: string): string | undefined {
  try {
    const raw = readFileSync(path.join(materialsRoot, derivedRelPathFor(relInMaterials)), 'utf-8');
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return stripped.replace(/\r\n?/g, '\n');
  } catch {
    return undefined;
  }
}

/** 段落块计数（零章伪章的 paraEnd——空行分块计数，与 splitParagraphBlocks 同基面）。 */
function countParagraphBlocks(text: string): number {
  let count = 0;
  let inRun = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      inRun = false;
    } else if (!inRun) {
      count += 1;
      inRun = true;
    }
  }
  return count;
}

/**
 * chunk 行展示名（章级基础名）：常规章 = 章标真值短标签（chapterHeadings 单源——C5/F19：
 * `第${index+1}章` 序号算术在简介伪章/漏检章形态下整体错位，展示一律真实章标行原词/语义回落
 * 标签，零序号算术）；零章伪章 `${材料名}·全文`（F-09 诚实标注）。全局车道在 INSERT 处追
 * `·c${n}` 段号消歧（design §3.2 取值表——项目车道不缀）。展示名**不进**组料 hash（hash =
 * 章标题集 + chunk texts，见步骤 6）——改展示名不 stale 既有 chunk，旧行按内容变更节律换新。
 */
function chunkDisplayName(
  materialName: string,
  headings: ReadonlyMap<number, ChapterHeadingInfo>,
  c: IndexedChunk,
): string {
  return `${materialName}·${c.unit.pseudo ? '全文' : chapterShortLabel(headings.get(c.unit.index), c.unit.index)}`;
}

/**
 * 重索引一份材料（watcher .derived 路由 / registerMaterial 内部触发 / 手动重建的公共入口）。
 * 幂等 + hash-skip（组料 = 章标题集 + chunk texts，F-14——只改标记标题也重索引）；per-scope
 * 串行队列内执行。
 */
export async function reindexMaterial(
  materialId: string,
  deps: MaterialIndexerDeps = {},
): Promise<ReindexMaterialResult> {
  const material = getMaterialRow(materialId);
  if (material === null) return { outcome: 'unregistered', chunkCount: 0 };
  const lane = resolveLaneForMaterial(material);
  if (lane === null) {
    getLogger().warn(
      { materialId, scope: material.scope, projectId: material.projectId },
      'material reindex: lane unresolvable (project unregistered / malformed row?) - skipping',
    );
    return { outcome: 'unresolvable', chunkCount: 0 };
  }
  return enqueueLaneWork(laneKeyOf(lane.scope, lane.projectId), () =>
    runReindexMaterial(materialId, lane, deps),
  );
}

async function runReindexMaterial(
  materialId: string,
  lane: ResolvedLane,
  deps: MaterialIndexerDeps,
): Promise<ReindexMaterialResult> {
  const db = getDb();
  const material = getMaterialRow(materialId);
  if (material === null) return { outcome: 'unregistered', chunkCount: 0 };

  const relInMaterials = relInMaterialsOfSourcePath(material);
  if (relInMaterials === null) {
    getLogger().warn(
      { materialId, sourcePath: material.provenance.sourcePath },
      'material reindex: malformed source_path - skipping',
    );
    return { outcome: 'unresolvable', chunkCount: 0 };
  }

  // 1. 原件 orphan 判定（materials/ 无原件 → 删登记 + 双车道 chunk 行）。
  if (!existsSync(path.join(lane.materialsRoot, relInMaterials))) {
    deleteMaterialRows(materialId);
    return { outcome: 'orphan', chunkCount: 0 };
  }

  // 2. 策略 seam（D6 预留③）：kind 无策略 = 未实施，诚实跳过（不硬编码 prose）——语义上
  //    先于派生文件检查（kind 不支持时无论文件在否都不跑分块）。
  const strategy = MATERIAL_CHUNK_STRATEGIES[material.kind];
  if (strategy === undefined) {
    getLogger().warn(
      { materialId, kind: material.kind },
      'material reindex: no chunk strategy for kind (V1 only prose) - skipping honestly',
    );
    return { outcome: 'no-strategy', chunkCount: 0 };
  }

  // 3. 派生 .md 读取 + 章结构重建（真相源 = 章标记，AC4 校对闭环）。
  const derived = readDerivedText(lane.materialsRoot, relInMaterials);
  if (derived === undefined) {
    getLogger().warn(
      { materialId },
      'material reindex: derived .md missing - skip (register/backfill will regenerate)',
    );
    return { outcome: 'missing-derived', chunkCount: 0 };
  }
  const markers = parseChapterMarkers(derived);
  const rebuilt = markers.length > 0 ? rebuildChaptersFromMarkers(derived, markers) : null;

  // 4. 章单元装配（两源）：
  //    a) 标记重建（行位置权威）——markers > 0。
  //    b) 🔑 CR-006：零标记 → **回自动分章**（design §2.3「注释全删→回自动分章」）——regex
  //       重跑 high/medium 可复现章界时以自动结果刷新登记（章 span 基面 = 当前裸文本），消
  //       「登记行旧 span（标记基面）vs 伪章 chunk 行（裸文本基面）」的永久分歧；regex 仍
  //       low（挂起态裸文本——F-09）→ 保持登记存档不刷新（不产 ready 假象；LLM 兜底只在
  //       摄取管线，重摄取自动路径自愈）。
  //    c) 零章（挂起）→ 全文单伪章（F-09——索引照常，章界与检索解耦）。
  //       伪章仅存在于索引路径，不落 chapters_json。
  let autoResplit: { chapters: SplitChapterSpan[]; confidence: 'high' | 'medium'; matchedFormats: string[] } | null =
    null;
  let autoParas: ReturnType<typeof mapParagraphRanges> | null = null;
  if (rebuilt === null) {
    const split = splitChapters(derived);
    const splitConfidence = split.confidence;
    if (splitConfidence !== 'low' && split.chapters.length > 0) {
      autoResplit = { chapters: split.chapters, confidence: splitConfidence, matchedFormats: split.matchedFormats };
      autoParas = mapParagraphRanges(
        derived,
        split.chapters.map((c) => ({ charStart: c.charStart, charEnd: c.charEnd })),
      );
    }
  }
  const refreshRegistration = rebuilt !== null || autoResplit !== null;
  const units: ChapterUnit[] = [];
  if (rebuilt !== null) {
    rebuilt.chapters.forEach((c, i) => {
      units.push({
        index: i,
        title: c.title,
        charStart: c.charStart,
        charEnd: c.charEnd,
        paraStart: c.paraStart,
        paraEnd: c.paraEnd,
        method: c.method,
        confidence: c.confidence,
        pseudo: false,
      });
    });
  } else if (autoResplit !== null && autoParas !== null) {
    autoResplit.chapters.forEach((c, i) => {
      units.push({
        index: i,
        title: c.title,
        charStart: c.charStart,
        charEnd: c.charEnd,
        paraStart: autoParas![i]!.paraStart,
        paraEnd: autoParas![i]!.paraEnd,
        method: 'regex',
        confidence: autoResplit!.confidence,
        pseudo: false,
      });
    });
  }
  const docMethod = rebuilt?.docMethod ?? (autoResplit !== null ? 'regex' : material.quality.chapterDetection.method);
  const docConfidence =
    rebuilt?.docConfidence ??
    (autoResplit !== null ? autoResplit.confidence : material.quality.chapterDetection.confidence);
  if (units.length === 0) {
    units.push({
      index: 0,
      title: null,
      charStart: 0,
      charEnd: derived.length,
      paraStart: 0,
      paraEnd: countParagraphBlocks(derived),
      method: 'none',
      confidence: 'low',
      pseudo: true,
    });
  }

  // 4b. C5：chunk 展示名 = 章标真值映射（buildChapterHeadings——章正文首行命中分章正则库/
  //      含章题即章标行；零序号算术）。伪章分支在 chunkDisplayName 内短路，不入映射消费。
  const headings = buildChapterHeadings(derived, units);

  // 5. 逐章分块 + 全局 span 平移 + schema 校验（fail-loud，mirror B5：分块器自产恒过是契约，
  //    静默丢弃会让 indexTexts/vectors 按位 zip 错位）。
  const indexed: IndexedChunk[] = [];
  for (const unit of units) {
    const chapterText = derived.slice(unit.charStart, unit.charEnd);
    const rawChunks = strategy(chapterText);
    rawChunks.forEach((raw, n) => {
      const parsed = chapterChunkSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `material reindex: chunker produced a schema-invalid chunk (material=${materialId}, chapter=${unit.index}, position=${n}): ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      indexed.push({
        unit,
        chunk: parsed.data,
        chunkNo: n,
        // 章切片局部偏移 → 派生全文基面平移（章界落段边界，局部段号是全局段号的平移——
        // Wave A 裁决：chunkChapter 段落基面与 splitParagraphBlocks 跨层对齐）。
        charStart: unit.charStart + parsed.data.charStart,
        charEnd: unit.charStart + parsed.data.charEnd,
        paraStart: unit.paraStart + parsed.data.paraStart,
        paraEnd: unit.paraStart + parsed.data.paraEnd,
      });
    });
  }

  // 6. 组料 hash（F-14：**章标题集入 hash**——只改 marker 标题也重索引）+ 登记刷新面预装配
  //    （skip 判定要用——见下）。
  const hash = createHash('sha256')
    .update(
      JSON.stringify({ titles: units.map((u) => u.title), chunks: indexed.map((c) => c.chunk.text) }),
    )
    .digest('hex');
  const existingHash = readMaterialIndexHash(lane, materialId);

  const refreshedChapters: MaterialChapterSpan[] = refreshRegistration
    ? units.map((u) => ({
        index: u.index,
        title: u.title,
        charStart: u.charStart,
        charEnd: u.charEnd,
        paraStart: u.paraStart,
        paraEnd: u.paraEnd,
        confidence: u.confidence,
        method: u.method,
      }))
    : material.chapters;
  const refreshedQuality: Material['quality'] = refreshRegistration
    ? {
        ...material.quality,
        chapterDetection: {
          ...material.quality.chapterDetection,
          method: docMethod,
          confidence: docConfidence,
          // CR-006 自动重分章路径持有 matchedFormats（标记重建路径不随标记存档，维持原值）。
          ...(autoResplit !== null ? { matchedFormats: autoResplit.matchedFormats } : {}),
        },
      }
    : material.quality;
  const refreshedStatus: Material['status'] = refreshRegistration
    ? docMethod === 'llm-fallback' && refreshedChapters.length === 0
      ? 'low-confidence'
      : 'ready'
    : material.status;
  // 🔑 CR-006 登记收敛 belt：chapters/status/分章判定任一漂移即不 skip——「删光标记 → 自动
  // 重分章」的章 span 基面切换即便 chunk texts 同文本（hash 相同）也必须落库刷新，否则登记
  // 行旧 span 永不收敛（原实现正是被同文本 hash-skip 吞掉刷新）。
  const registrationConverged =
    JSON.stringify(refreshedChapters) === JSON.stringify(material.chapters) &&
    refreshedStatus === material.status &&
    refreshedQuality.chapterDetection.method === material.quality.chapterDetection.method &&
    refreshedQuality.chapterDetection.confidence === material.quality.chapterDetection.confidence;
  // hash 只在整材料向量落齐时写 → pending（NULL）不 skip（模型恢复补嵌重试语义保留）。
  if (!deps.force && existingHash === hash && registrationConverged) {
    return { outcome: 'hash-skip', chunkCount: indexed.length };
  }

  // 7. embed 模型解析 + prevailing mismatch 门（先于 embed 决出——CR-007 的稳态 FTS-only 判定
  //    依赖 model/mismatch 结论）。
  const indexTexts = indexed.map((c) => buildChunkIndexText(c.chunk.text));
  const vecDim = lane.scope === 'project' ? getCurrentVecDim(db) : getCurrentCraftVecDim(db);
  let vectors: number[][] | null = null;
  let modelId: string | null = null;
  const resolveModel = deps.resolveModel ?? resolveEmbeddingModel;
  const embedBatch = deps.embedBatch ?? defaultEmbedBatch;
  const model = resolveModel();

  let modelMismatch = false;
  if (model && !deps.force) {
    const prevailingRow =
      lane.scope === 'project' && lane.projectId !== null
        ? (db
            .prepare('SELECT model FROM closure_entry WHERE project_id=? AND model IS NOT NULL LIMIT 1')
            .get(lane.projectId) as { model: string } | undefined)
        : (db
            .prepare('SELECT model FROM closure_craft_entry WHERE model IS NOT NULL LIMIT 1')
            .get() as { model: string } | undefined);
    const prevailingModel = prevailingRow?.model ?? null;
    if (shouldSkipForModelMismatch(prevailingModel, model.modelId)) {
      modelMismatch = true;
      getLogger().warn(
        { materialId, prevailingModel, resolvedModel: model.modelId },
        'material reindex: model mismatch (prevailing vs resolved) - FTS-only; run rebuild to migrate',
      );
    }
  }

  // 🔑 CR-007：FTS-only **稳态**（无模型 / prevailing mismatch——本轮注定不嵌）下，既有 pending
  // 行（content_hash NULL，hash-skip 永不成立）若文本面已一致则跳过重写——消「无 embed 模型
  // 时每次启动/开项目对全部 FTS-only 材料全量 DELETE+INSERT」空转（WAL churn + FTS trigger
  // 重建）。pending_embed 保留（模型恢复 / 显式 rebuild 时照常补嵌/重建）；文本面比对 = 既有
  // 行 body_text 序列 vs 本次 chunk texts 序列（位序 = 章序 × 章内 chunk 序）。登记漂移或文本
  // 变更不 skip；有模型且无 mismatch 不走此路（embed 重试语义）。
  if (
    !deps.force &&
    (model === null || modelMismatch) &&
    existingHash === null &&
    registrationConverged &&
    ftsChunkTextsEqual(lane, materialId, indexed)
  ) {
    return { outcome: 'hash-skip', chunkCount: indexed.length };
  }

  if (model && !modelMismatch && indexTexts.length > 0) {
    try {
      const arr = await embedBatch(model, indexTexts);
      if (arr.length === indexed.length && vecDim !== null && arr.every((v) => v.length === vecDim)) {
        vectors = arr;
        modelId = model.modelId;
      } else {
        getLogger().warn(
          { materialId, expected: vecDim, got: arr.length, model: model.modelId },
          'material reindex: embedding count/dim mismatch - FTS-only',
        );
      }
    } catch (err) {
      getLogger().warn({ err: errMsg(err), materialId }, 'material reindex: embed failed - FTS-only');
    }
  }

  // 8. 单 WAL 事务：DELETE 旧 chunk 行（entry/craft + vec）+ INSERT 新行 + closure_material
  //    回填（chapters_json / chunk_spans_json / quality.chapterDetection / status——F-02 同事务；
  //    刷新面在步骤 6 预装配）。
  const chunkSpans = indexed.map((c) => ({
    chapterIndex: c.unit.index,
    chunkIndex: c.chunkNo,
    charStart: c.charStart,
    charEnd: c.charEnd,
    paraStart: c.paraStart,
    paraEnd: c.paraEnd,
  }));

  db.transaction(() => {
    deleteChunkRows(lane.scope, materialId, lane.projectId);
    if (lane.scope === 'project' && lane.projectId !== null) {
      const projectId = lane.projectId;
      // 列序：entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status,
      // summary_text, content_hash, model, dim, chapter_id, chapter_index, char_start, char_end,
      // para_start, para_end, index_text（= 19 绑定 + updated_at——显式列清单点数，S10 纪律）。
      const insertEntry = db.prepare(
        `INSERT INTO closure_entry
           (entry_id, project_id, entry_type, source_kind, name, body_text, visibility, status,
            summary_text, content_hash, model, dim,
            chapter_id, chapter_index, char_start, char_end, para_start, para_end, index_text, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      );
      // 列序：vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status,
      // visibility, embedding（= 9 绑定）。status '' sentinel（vec0 TEXT 拒 NULL，S1 探针）。
      const insertVec = db.prepare(
        `INSERT INTO entry_vec
           (vector_id, project_id, entry_id, entry_type, source_kind, vector_kind, status, visibility, embedding)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const [i, c] of indexed.entries()) {
        const entryId = materialEntryId(projectId, materialId, c.unit.index, c.chunkNo);
        insertEntry.run(
          entryId,
          projectId,
          'material', // entry_type = 'material'（来源即类型惯例，F-15）
          MATERIAL_SOURCE_KIND,
          chunkDisplayName(material.name, headings, c),
          c.chunk.text,
          'known',
          null, // 材料无卡状态（mirror 章行 NULL；vec0 侧 '' sentinel）
          null, // 材料无简述层
          vectors ? hash : null, // pending_embed：向量未落不写 hash
          modelId,
          vectors && vectors[i] ? vectors[i]!.length : null,
          materialChapterRef(materialId, c.unit.index),
          c.unit.index,
          c.charStart,
          c.charEnd,
          c.paraStart,
          c.paraEnd,
          indexTexts[i]!,
        );
        if (vectors && isSqliteVecAvailable()) {
          insertVec.run(
            entryId, // vector_id = entry_id（`#c<n>` 即 kind 标记，mirror 章行）
            projectId,
            entryId,
            'material',
            MATERIAL_SOURCE_KIND,
            'chunk',
            '',
            'known',
            floatArrayToBuffer(vectors[i]!),
          );
        }
      }
    } else {
      // 列序：craft_id, craft_type, source_kind, name, body_text, tags, source, summary_text,
      // summary_source, summary_hash, content_hash, model, dim（= 13 绑定 + updated_at）。
      const insertCraft = db.prepare(
        `INSERT INTO closure_craft_entry
           (craft_id, craft_type, source_kind, name, body_text, tags, source,
            summary_text, summary_source, summary_hash, content_hash, model, dim, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      );
      const insertCraftVec = db.prepare(
        `INSERT INTO closure_craft_vec
           (vector_id, craft_id, craft_type, source_kind, vector_kind, embedding)
         VALUES (?,?,?,?,?,?)`,
      );
      for (const [i, c] of indexed.entries()) {
        const craftId = materialChunkCraftId(materialId, c.unit.index, c.chunkNo);
        insertCraft.run(
          craftId,
          'material', // craft_type = 'material'（design §3.2 取值表）
          MATERIAL_CHUNK_SOURCE_KIND,
          `${chunkDisplayName(material.name, headings, c)}·c${c.chunkNo}`, // 全局车道 name 追段号消歧
          c.chunk.text,
          null,
          material.name, // source = 材料名
          null,
          null,
          null,
          vectors ? hash : null,
          modelId,
          vectors && vectors[i] ? vectors[i]!.length : null,
        );
        if (vectors && isSqliteVecAvailable()) {
          insertCraftVec.run(
            craftId, // vector_id = craft_id（`#c<n>` 即 kind 标记）
            craftId,
            'material',
            MATERIAL_CHUNK_SOURCE_KIND,
            'chunk',
            floatArrayToBuffer(vectors[i]!),
          );
        }
      }
    }
    db.prepare(
      `UPDATE closure_material
         SET chapters_json=?, chunk_spans_json=?, quality_json=?, status=?, updated_at=datetime('now')
       WHERE material_id=?`,
    ).run(
      JSON.stringify(refreshedChapters),
      JSON.stringify(chunkSpans),
      JSON.stringify(refreshedQuality),
      refreshedStatus,
      materialId,
    );
  })();
  return { outcome: 'written', chunkCount: indexed.length };
}

/** 既有索引 hash 探测（skip 判定；无行 / pending → undefined / null）。 */
function readMaterialIndexHash(lane: ResolvedLane, materialId: string): string | null | undefined {
  const db = getDb();
  if (lane.scope === 'project' && lane.projectId !== null) {
    const row = db
      .prepare(
        "SELECT content_hash FROM closure_entry WHERE project_id=? AND source_kind='material' AND chapter_id LIKE ? ESCAPE '\\' LIMIT 1",
      )
      .get(lane.projectId, `${escapeLikePrefix(materialId)}.ch%`) as
      | { content_hash: string | null }
      | undefined;
    return row?.content_hash;
  }
  const row = db
    .prepare(
      "SELECT content_hash FROM closure_craft_entry WHERE source_kind='material_chunk' AND craft_id LIKE ? ESCAPE '\\' LIMIT 1",
    )
    .get(`${escapeLikePrefix(`mat:${materialId}`)}.ch%`) as { content_hash: string | null } | undefined;
  return row?.content_hash;
}

/**
 * CR-007 文本面比对：既有 FTS chunk 行的 body_text 序列与本次分块序列**逐位相等**（无行 →
 * false，首索引必须写）。位序 = 章序 × 章内 chunk 序——从 entry_id / craft_id 后缀解析排序
 * （⚠️ 不能 ORDER BY id 字典序：`#c10` < `#c2` 会错位）。pending 行（content_hash NULL 无
 * hash-skip 凭据）靠本比对在 FTS-only 稳态下免重写。
 */
function ftsChunkTextsEqual(
  lane: ResolvedLane,
  materialId: string,
  indexed: readonly IndexedChunk[],
): boolean {
  const db = getDb();
  let rows: Array<{ id: string; body_text: string }>;
  if (lane.scope === 'project' && lane.projectId !== null) {
    rows = db
      .prepare(
        "SELECT entry_id AS id, body_text FROM closure_entry WHERE project_id=? AND source_kind='material' AND chapter_id LIKE ? ESCAPE '\\'",
      )
      .all(lane.projectId, `${escapeLikePrefix(materialId)}.ch%`) as Array<{ id: string; body_text: string }>;
  } else {
    rows = db
      .prepare(
        "SELECT craft_id AS id, body_text FROM closure_craft_entry WHERE source_kind='material_chunk' AND craft_id LIKE ? ESCAPE '\\'",
      )
      .all(`${escapeLikePrefix(`mat:${materialId}`)}.ch%`) as Array<{ id: string; body_text: string }>;
  }
  if (rows.length !== indexed.length) return false;
  const keyOf = (id: string): [number, number] => {
    const m = /\.ch(\d+)#c(\d+)$/.exec(id);
    return m === null ? [-1, -1] : [Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10)];
  };
  const sorted = [...rows].sort((a, b) => {
    const [ac, an] = keyOf(a.id);
    const [bc, bn] = keyOf(b.id);
    return ac !== bc ? ac - bc : an - bn;
  });
  return sorted.every((r, i) => r.body_text === indexed[i]!.chunk.text);
}

// ── backfill（启动扫描 / 开项目场景——幂等，mtime 快路零解析跳过）──

export interface MaterialBackfillReport {
  registered: number;
  /** mtime 快路跳过 ingest 的份数（登记在 + 派生新鲜 → 零解析，仅重索引 hash-skip 级成本）。 */
  skipped: number;
  orphaned: number;
}

/**
 * 递归枚举 materials 根候选原件（白名单扩展；dot 段整支剪枝——.derived/ 等非进件面）。
 * CR-014：跟随 symlink/junction **常规文件链接**（readdir Dirent 不跟链——isFile() 对 symlink
 * 恒 false，链入的材料会被静默跳过）；statSync 跟链后非常规文件（目录链等）跳过——目录链递归
 * 会绕开 dot 段剪枝 + 环风险，有意不跟；坏链（stat 抛）warn 跳过可诊断。
 */
function* walkMaterialSources(root: string, prefix = ''): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      yield* walkMaterialSources(path.join(root, e.name), prefix === '' ? e.name : `${prefix}/${e.name}`);
      continue;
    }
    const child = path.join(root, e.name);
    if (e.isFile() || e.isSymbolicLink()) {
      if (e.isSymbolicLink()) {
        let statOk: ReturnType<typeof statSync> | null = null;
        try {
          statOk = statSync(child); // 跟链 stat（symlink/junction 目标形态）
        } catch (err) {
          getLogger().warn(
            { err: errMsg(err), entry: path.join(prefix, e.name) },
            'material walk: unfollowable symlink in materials - skipping',
          );
          continue;
        }
        if (!statOk.isFile()) continue; // 目录链/特殊文件链：有意不跟（环 + dot 剪枝绕行防线）
      }
      const ext = path.posix.extname(e.name).toLowerCase();
      if ((MATERIAL_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
        yield prefix === '' ? e.name : `${prefix}/${e.name}`;
      }
    }
  }
}

/** 车道登记行枚举（摘要投影，CR-033——backfill 只需身份/路径/状态面）。 */
function laneRows(lane: ResolvedLane): MaterialSummaryRow[] {
  if (lane.scope === 'global') return listMaterialSummaries('global');
  return lane.projectId !== null ? listMaterialSummaries('project', lane.projectId) : [];
}

/**
 * 车道 backfill（F-16）：orphan 清扫 + 候选逐份登记。**mtime 快路**：登记行在 + 派生 .md
 * 存在且 mtime ≥ 原件 → 原件自上次摄取起未动 → 跳过 ingest（零解析——txt 直读/mammoth/
 * pdfjs/端点解析全免），仅跑 reindexMaterial（hash-skip 让未变材料零 embed，且能补
 * pending_embed 与 drop 重建后的行；CR-007 让无模型 FTS-only 稳态同样免重写）。幂等：重复
 * 扫描零重复行（登记 UNIQUE + 索引 hash-skip）。**failed 退避**（CR-030）：failed 登记行在
 * 案 → 跳过不重解析（坏档每次启动重跑解析器是纯浪费；显式 reingest / 删文件重拖才重试）。
 * **per-item 容错**（CR-018）：单材料抛错（out-of-contract 解析崩溃等）warn + continue，
 * 不中断车道内其余材料。
 *
 * 已知边界（诚实注记）：「原件改 → 用户又手改派生 .md」的交错场景下快路会漏一次原件变更
 * 重摄取——由下一次原件事件 / 手动重摄取收敛（AC4 校对闭环本就限定「原件未变时」）。
 */
export async function backfillMaterials(
  lane: MaterialLane,
  deps: MaterialIndexerDeps = {},
): Promise<MaterialBackfillReport> {
  const resolvedLane = resolveMaterialLane(lane);
  if (resolvedLane === null) return { registered: 0, skipped: 0, orphaned: 0 };
  return enqueueLaneWork(laneKeyOf(resolvedLane.scope, resolvedLane.projectId), () =>
    runBackfillMaterials(resolvedLane, deps),
  );
}

async function runBackfillMaterials(
  lane: ResolvedLane,
  deps: MaterialIndexerDeps,
): Promise<MaterialBackfillReport> {
  const scopeInput: MaterialIngestScope = {
    scope: lane.scope,
    materialsRoot: lane.materialsRoot,
    projectId: lane.projectId,
  };

  // 1. orphan 清扫：车道登记行原件不在 → 删（含该车道 chunk 行）。
  let orphaned = 0;
  for (const material of laneRows(lane)) {
    const rel = relInMaterialsOfSourcePath(material);
    if (rel !== null && !existsSync(path.join(lane.materialsRoot, rel))) {
      try {
        deleteMaterialRows(material.materialId);
        orphaned += 1;
      } catch (err) {
        getLogger().warn(
          { err: errMsg(err), materialId: material.materialId },
          'material backfill: orphan delete failed - continuing',
        );
      }
    }
  }

  // 2. 候选逐份登记（mtime 快路跳过未变原件；failed 退避；per-item try/catch——CR-018）。
  const registeredByPath = new Map(laneRows(lane).map((m) => [m.provenance.sourcePath, m]));
  let registered = 0;
  let skipped = 0;
  for (const rel of walkMaterialSources(lane.materialsRoot)) {
    const sourcePath = materialSourcePath(lane.scope, rel);
    const existing = registeredByPath.get(sourcePath);
    // CR-030 退避：failed 登记行在案 → 跳过不重解析（计入 skipped）。
    if (existing !== undefined && existing.status === 'failed') {
      skipped += 1;
      continue;
    }
    try {
      if (existing !== undefined) {
        const derivedAbs = path.join(lane.materialsRoot, derivedRelPathFor(rel));
        const sourceAbs = path.join(lane.materialsRoot, rel);
        try {
          if (existsSync(derivedAbs) && statSync(derivedAbs).mtimeMs >= statSync(sourceAbs).mtimeMs) {
            await runReindexMaterial(existing.materialId, lane, deps);
            skipped += 1;
            continue;
          }
        } catch {
          // stat 失败（原件中途消失等）→ 落入完整登记路径，由其 missing 分支处理。
        }
      }
      const result = await runRegisterMaterial(scopeInput, rel, lane, deps);
      if (result.outcome === 'registered' || result.outcome === 'reused') registered += 1;
    } catch (err) {
      // CR-018：单材料失败（out-of-contract 抛错）不中断车道——warn + continue。
      getLogger().warn(
        { err: errMsg(err), rel },
        'material backfill: per-item register failed - continuing lane',
      );
    }
  }
  return { registered, skipped, orphaned };
}

/** 全局车道启动扫描入口（main/index.ts whenReady 挂点——mirror craft scanAndReindex 先例）。 */
export async function backfillGlobalMaterials(
  deps: MaterialIndexerDeps = {},
): Promise<MaterialBackfillReport> {
  return backfillMaterials({ scope: 'global' }, deps);
}

/** 项目车道开项目 backfill 入口（projectIpc project:watch 挂点——mirror chapterChunk 先例）。 */
export async function backfillProjectMaterials(
  projectDir: string,
  deps: MaterialIndexerDeps = {},
): Promise<MaterialBackfillReport> {
  return backfillMaterials({ scope: 'project', projectDir }, deps);
}
