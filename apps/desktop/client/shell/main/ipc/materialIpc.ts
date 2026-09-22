/**
 * Story 10.1 Wave D（design §5.1）：材料库管理面 IPC——七 invoke 通道 + material:changed
 * 广播埋点（registerAllIpc 恰一次，spec/shell/ipc-handlers.md 注册纪律）。
 *
 * 通道与职责（载荷契约单源 packages/shared-contracts/src/ipc.ts「Story 10.1 Wave D」段）：
 * - `materials:list {scope, projectId?}` → MaterialSummary[]（listMaterialRows 裁剪投影——
 *   剥 chapters/chunkSpans 大数组，保留徽章/表单字段；模式 B 坏参 throw，mirror worldIpc）。
 * - `materials:get {materialId}` → MaterialDetail（全行 + 派生/原件绝对路径——打开派生 .md
 *   校对入口用）| null。
 * - `materials:delete {materialId}` → **D8 四清**：原件 + 派生 .md + 登记行（deleteMaterialRows
 *   = 登记行 + 双车道 chunk 行单事务）+ 删除前 `.orison/history` 快照兜底（localHistory 先例；
 *   全局车道快照落 materials 根下 `.orison/history/`——同「根下 .orison 安全网」形态，watcher
 *   对 dot 段路径由 ingest 路径守卫拒收、backfill walkMaterialSources 剪枝，无自触发环）。
 *   **二进制原件（docx/pdf/epub 等 TEXT_EXT_RE 外扩展）原字节直拷快照**（CR-024——确认弹窗
 *   承诺的快照兜底对二进制同样成立，localHistory 的文本闸由本文件补齐）。**确认弹窗归 UI，
 *   IPC 层不二次确认**（D8 拍板）。
 * - `materials:reingest {materialId}` → registerMaterial 完整管线（解析→质量诊断→两段式分章→
 *   派生 .md→登记→索引；内部已入 per-scope 串行队列防 watcher 风暴），回执 outcome。
 * - `materials:import {scope, projectId?, absolutePaths[]}` → 批量拖入：白名单/50MB/批量 250
 *   shell 侧强制（AC7 独立上限〔F-06〕，常量单源 materialIngest）+ uniquePath 重名序号
 *   （projectFileIpc 先例）+ **同 stem 异扩展拒收**（CR-001——派生 .md 镜像同路径互覆写，
 *   后到者拒 stem-conflict 档）+ **敏感源 realpath 解析后过门**（CR-023——path.resolve 不
 *   解析 symlink/junction）+ 逐份 registerMaterial + 逐份 material:changed 广播（UI 进度可见）；
 *   拒收分类六档回报（部分成功语义：CR-011 细化 sensitive/missing 真实原因可见）+ failed
 *   （拷入成功摄取失败——文件已在 materials/，watcher/backfill 自愈，非拒收档）。
 * - `materials:update-provenance {materialId, patch}` → F-05 五字段后补（medium/tier/author/
 *   lang/originDate + E10.2a description；缺省不动、nullable 字段显式 null = 清空；description
 *   ≤ MATERIAL_DESCRIPTION_MAX_CHARS〔CR-6：schema max + handler + UI maxLength 三处齐〕，超限
 *   → invalid-input，mirror update-name 超长档）。
 * - `materials:update-name {materialId, name}` → E10.2a 材料显示名（视频标题）编辑：name 是
 *   display 列（materialId 路径身份不变，design §3.1）——trim + 非空 + ≤
 *   MATERIAL_NAME_MAX_CHARS（shared-contracts 单源，UI maxlength 同源消费），落库后广播
 *   reason='name-updated'（列表名刷新既有事件面）。
 * - `materials:import-online {url, scope, category, projectId?}` / `materials:search-online
 *   {query, limit?}` → E10.4 在线解析生态（载荷契约单源 shared-contracts ipc.ts「E10.4」段）。
 *   **W2 实现**（design §1）：import-online = research session 拉取（onlineMaterial
 *   fetchOnlinePageAsMarkdown——MoeSkin 预解包 + htmlToMarkdown 抽取 + 2MB body cap）→
 *   materials/online/<stem>-<sha8(url)>.md 落盘（抽取文本即原件）→ registerMaterial 管线
 *   （P2 seam provenance 预填 medium/tier/url/via='web-fetch'）→ 失败分类六档模式 A 回报；
 *   search-online = web/wiki 既有核心并发合并去重（零 LLM，onlineMaterial
 *   searchOnlineSourcesCore），空 query 模式 B throw（mirror materials:list 坏参形态）。
 *
 * 🔑 update-provenance 为何**直写 UPDATE 而非 upsertMaterialRow**：upsert 的
 * preserveCuratedProvenance（F-05 COALESCE）以**既有行**值优先——重摄取不清用户策展值正是
 * 依赖该语义；但显式用户 patch 也走它会被「old ?? fresh」原值吞掉。故此处对 provenance_json
 * 做定点 UPDATE（同理此后任何重摄取经 COALESCE 保留新值——写路单向不冲突）。
 *
 * 广播（F-23）：materialNotify.sendMaterialChanged（mirror worldNotify 全窗 best-effort）。
 * 本文件埋点 = import（逐份）/ reingest / delete / update-provenance / update-name（E10.2a）；
 * watcher 触发点（materials/ 目录事件）归 Wave C materialWatcher——materialNotify 独立薄文件
 * 即为其预留接线面（不引整个 IPC 注册模块）。
 *
 * 错误模式（ipc-handlers spec）：读面（list/get）坏参 = 模式 B throw（不变量，mirror
 * worldIpc Zod-at-boundary 形态）；写面（delete/reingest/import/update-provenance）= 模式 A
 * 判别联合 + 稳定 error code。路径安全：project 车道 projectDir 经注册库解析后过
 * assertSafePath（模式 B）；导入源路径过敏感目录门（mirror projectFileIpc import-files）。
 *
 * expected_downstream_consumers:
 * - ui 材料页 + materialsSlice（本面唯一设计消费者）。
 * - 10.2/10.3 接入时经 materials:list/get 取材料清单与章界（管理面；检索消费走既有
 *   query_craft/query_story 天然含材料 chunk，design §7 消费缝——勿为此扩通道）。
 */
import { ipcMain } from 'electron';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import type {
  Material,
  MaterialChangedEvent,
  MaterialDeleteResult,
  MaterialDetail,
  MaterialImportedItem,
  MaterialImportRejectedItem,
  MaterialReingestResult,
  MaterialSummary,
  MaterialsImportOnlineResult,
  MaterialsImportResult,
  MaterialProvenancePatchInput,
  MaterialProvenancePatchResult,
  MaterialUpdateNameResult,
  OnlineSourceHit,
} from '@orison/shared-contracts';
import { MATERIAL_DESCRIPTION_MAX_CHARS, MATERIAL_NAME_MAX_CHARS, MATERIAL_ONLINE_CATEGORIES, materialProvenanceSchema } from '@orison/shared-contracts';
import type { MaterialOnlineCategory } from '@orison/shared-contracts';
import { assertSafePath } from './pathGuard';
import { snapshotToLocalHistory } from '../fs/localHistory';
import { getLogger } from '../logger';
import { getDb } from '../db';
import { getProjectById } from '../db/projectRepository';
import {
  MATERIAL_ALLOWED_EXTENSIONS,
  MATERIAL_IMPORT_MAX_BATCH,
  MATERIAL_MAX_FILE_BYTES,
  materialIdFor,
  materialSourcePath,
} from './toolHandlers/materialIngest';
import {
  ONLINE_SOURCE_DIR,
  ONLINE_STEM_HASH_WIDTHS,
  categoryToProvenanceDefaults,
  fetchOnlinePageAsMarkdown,
  onlineFileNameFor,
  onlineStemForUrl,
  onlineTruncationNote,
  searchOnlineSourcesCore,
} from './toolHandlers/onlineMaterial';
import {
  deleteMaterialRows,
  derivedRelPathForMaterial,
  getGlobalMaterialsRoot,
  getMaterialRow,
  listMaterialRows,
  registerMaterial,
  relInMaterialsOfSourcePath,
  type MaterialLane,
} from '../db/materialIndexer';
import {
  deleteDeconProductsByMaterial,
  failDeconJobsByMaterialForCleanup,
  listDeconJobsByMaterial,
} from '../db/closure-decon';
import { cancelInflightDeconPipeline } from '../decon/deconInflight';
import { sendMaterialChanged } from './materialNotify';

// ── 入参宽容归一（mirror parseDocumentHandlers coerceInboxInput——renderer 传错形态是
//    预期输入而非攻击面；严校验在各 handler 内按字段判）──

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 在途拆解管线取消握手（CR-1）：材料的 running job 逐个经注册表置取消旗标（幂等——无在途 no-op）。 */
function cancelInflightDeconPipelinesForMaterial(materialId: string): void {
  try {
    for (const job of listDeconJobsByMaterial(materialId)) {
      if (job.status !== 'running') continue;
      cancelInflightDeconPipeline(job.jobId);
    }
  } catch (err) {
    getLogger().warn({ err: errMsg(err), materialId }, 'materials:delete decon inflight cancel failed - continuing (cost writeback sentinel is the backstop)');
  }
}

function coerceScopeInput(raw: unknown): { scope?: 'project' | 'global'; projectId?: string } {
  if (raw === null || typeof raw !== 'object') return {};
  const { scope, projectId } = raw as { scope?: unknown; projectId?: unknown };
  return {
    scope: scope === 'project' || scope === 'global' ? scope : undefined,
    projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : undefined,
  };
}

function coerceMaterialIdInput(raw: unknown): { materialId?: string } {
  if (raw === null || typeof raw !== 'object') return {};
  const { materialId } = raw as { materialId?: unknown };
  return { materialId: typeof materialId === 'string' && materialId.trim() ? materialId.trim() : undefined };
}

/** `materials:import-online` 入参归一（url/scope/category 三必填收窄；projectId 可选）。 */
function coerceOnlineImportInput(
  raw: unknown,
): { url: string; scope: 'project' | 'global'; category: MaterialOnlineCategory; projectId?: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const url = typeof source.url === 'string' && source.url.trim() ? source.url.trim() : null;
  if (url === null) return null;
  const scope = source.scope === 'project' || source.scope === 'global' ? source.scope : null;
  if (scope === null) return null;
  const category = (MATERIAL_ONLINE_CATEGORIES as readonly string[]).includes(source.category as string)
    ? (source.category as MaterialOnlineCategory)
    : null;
  if (category === null) return null;
  const projectId =
    typeof source.projectId === 'string' && source.projectId.trim() ? source.projectId.trim() : undefined;
  return { url, scope, category, ...(projectId !== undefined ? { projectId } : {}) };
}

// ── 车道解析（登记行/入参两入口共用）──

interface ResolvedLaneRoot {
  lane: MaterialLane;
  /** materials 根绝对路径（拷贝/删除/派生路径解析基）。 */
  materialsRoot: string;
  /** project 车道项目根（history 快照基）；global 车道 = materials 根自身（快照落根下 .orison/history）。 */
  historyRoot: string;
  projectId: string | null;
}

/**
 * project 车道 projectDir 解析（registry 权威）+ assertSafePath。解析不出（未注册/路径越界）
 * 返回 null——调用方按稳定 error code 回报（unregistered / operation-failed）。
 */
function resolveProjectLane(projectId: string): ResolvedLaneRoot | null {
  const record = getProjectById(projectId);
  const projectDir = record?.path;
  if (typeof projectDir !== 'string' || projectDir.length === 0) return null;
  try {
    assertSafePath(projectDir);
  } catch {
    return null;
  }
  return {
    lane: { scope: 'project', projectDir },
    materialsRoot: path.join(projectDir, 'materials'),
    historyRoot: projectDir,
    projectId,
  };
}

/** 全局车道（~/.orison/materials/——机器级，无项目根；history 快照落根下 .orison/history）。 */
function resolveGlobalLane(): ResolvedLaneRoot {
  return {
    lane: { scope: 'global' },
    materialsRoot: getGlobalMaterialsRoot(),
    historyRoot: getGlobalMaterialsRoot(),
    projectId: null,
  };
}

// ── MaterialSummary 投影（materials:list 裁剪——剥 chapters/chunkSpans 大数组）──

function toSummary(m: Material): MaterialSummary {
  return {
    materialId: m.materialId,
    scope: m.scope,
    projectId: m.projectId,
    kind: m.kind,
    name: m.name,
    format: m.format,
    medium: m.provenance.medium,
    tier: m.provenance.tier,
    author: m.provenance.author,
    lang: m.provenance.lang,
    originDate: m.provenance.originDate,
    sourcePath: m.provenance.sourcePath,
    status: m.status,
    charCount: m.quality.charCount,
    chapterCount: m.chapters.length,
    chapterMethod: m.quality.chapterDetection.method,
    chapterConfidence: m.quality.chapterDetection.confidence,
    scanned: m.quality.scanned,
    nonUtf8: m.quality.nonUtf8,
    parseNotes: m.quality.parseNotes,
    ingestedAt: m.provenance.ingestedAt,
  };
}

// ── 导入源敏感目录门（mirror projectFileIpc.isSensitiveImportSource——降「renderer 被攻破
//    借导入-再读批量外泄」爆炸半径；本文件独立持有因彼处未导出）──

function isSensitiveImportSource(resolved: string): boolean {
  const lower = resolved.replace(/\\/g, '/').toLowerCase();
  const home = path.resolve(os.homedir()).replace(/\\/g, '/').toLowerCase();
  const denyExact = [
    `${home}/.ssh`,
    `${home}/.gnupg`,
    `${home}/.aws`,
    `${home}/.orison/model/keys`,
    `${home}/.orison/model`,
  ];
  for (const d of denyExact) {
    if (lower === d || lower.startsWith(`${d}/`)) return true;
  }
  if (process.platform === 'win32') {
    return lower.startsWith('c:/windows') || lower.startsWith('c:/program files');
  }
  return ['/etc/', '/usr/', '/bin/', '/sbin/', '/root/'].some((p) => lower.startsWith(p));
}

/** 重名序号避让（mirror projectFileIpc.uniquePath——`foo.txt` → `foo-1.txt`）。 */
function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

// ── 删除快照：二进制原件补齐（CR-024）──

/**
 * mirror `localHistory.TEXT_EXT_RE`（模块私有未导出——两处须同步维护）：localHistory 对
 * 此正则不匹配的扩展（docx/pdf/epub/markdown 等）静默跳过快照，二进制补拷面即「非此正则」。
 */
const LOCAL_HISTORY_TEXT_EXT_RE = /\.(md|txt|text|ya?ml)$/i;

/** 快照环容量（mirror localHistory.KEEP_PER_FILE——二进制快照同环纪律）。 */
const HISTORY_KEEP_PER_FILE = 20;

/**
 * 二进制原件删除快照：**原字节拷贝**进 `<root>/.orison/history/<rel>/<stamp>.<ext>`
 * （mirror snapshotToLocalHistory 布局 + 环清理 + .gitignore 安全网）。D8 删除确认弹窗对
 * 二进制原件同样承诺「快照兜底」，但 localHistory 的文本闸把它们静默排除——本函数补齐承诺。
 * best-effort 全吞错（绝不阻删除，mirror snapshotToLocalHistory 吞错纪律）；上限随导入闸
 * 50MB（超限件本就非合法材料）。
 */
function snapshotBinaryToLocalHistory(historyRoot: string, abs: string): void {
  try {
    const resolved = path.resolve(abs);
    const rel = path.relative(path.resolve(historyRoot), resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > MATERIAL_MAX_FILE_BYTES) return;
    const orisonDir = path.join(historyRoot, '.orison');
    // mirror localHistory.ensureHistoryBase：history 树不进版本快照（iso-git .gitignore=*）。
    const ignorePath = path.join(orisonDir, '.gitignore');
    if (!existsSync(ignorePath)) atomicWriteFileSync(ignorePath, '*\n', 'utf-8');
    const destDir = path.join(orisonDir, 'history', rel);
    mkdirSync(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // Windows-safe 文件名
    copyFileSync(resolved, path.join(destDir, `${stamp}${path.extname(resolved)}`));
    // 环清理（ISO 戳字典序即时间序——mirror localHistory）。
    const all = readdirSync(destDir).sort();
    for (const name of all.slice(0, Math.max(0, all.length - HISTORY_KEEP_PER_FILE))) {
      try {
        rmSync(path.join(destDir, name), { force: true });
      } catch {
        // best effort
      }
    }
  } catch {
    // best-effort 保险：绝不阻删除路径。
  }
}

// ── 导入 stem 冲突拒收（CR-001 import 面；reuse/hash 判定半归 materialIngest）──

/**
 * 同 stem 异扩展冲突判定。派生 .md 镜像规则（materialIngest.derivedRelPathForMaterial）：
 * `materials/<dir>/<stem>.<ext>` → `.derived/<dir>/<stem>.md`——同 stem 异扩展互覆写
 * （materialIngest 内已知边界注记在案）。导入落点恒在 materials/ 根，冲突基线取**磁盘现实**：
 * - 同批已落件（batchStems：stem → 实际落盘扩展名——uniquePath 重命名后按落盘名记账）；
 * - 既有 `<stem>.<异扩展>` 原件在盘（覆盖「拷入成功但登记失败/watcher 待自愈」窗口与手工
 *   放入件——比登记行读取更稳；登记行/派生残留的库内深防线归 materialIngest 协同）。
 * stem 归一小写：Windows/macOS 文件系统大小写不敏感，大小写异形同 stem 同样覆写（宁拒勿覆）。
 * 同 stem **同**扩展不冲突（走 uniquePath 重名序号，非本档）。
 */
function stemConflictsInLane(
  materialsRoot: string,
  stemLower: string,
  ext: string,
  batchStems: ReadonlyMap<string, string>,
): boolean {
  const prior = batchStems.get(stemLower);
  if (prior !== undefined && prior !== ext) return true;
  for (const other of MATERIAL_ALLOWED_EXTENSIONS) {
    if (other !== ext && existsSync(path.join(materialsRoot, `${stemLower}${other}`))) return true;
  }
  return false;
}

// ── IPC 工厂（deps 注入，零网络可测——mirror createInboxAttachmentIpc）──

export interface MaterialIpcHandlers {
  listMaterials(rawInput: unknown): Promise<MaterialSummary[]>;
  getMaterial(rawInput: unknown): Promise<MaterialDetail | null>;
  deleteMaterial(rawInput: unknown): Promise<MaterialDeleteResult>;
  reingestMaterial(rawInput: unknown): Promise<MaterialReingestResult>;
  importMaterials(rawInput: unknown): Promise<MaterialsImportResult>;
  updateProvenance(rawInput: unknown): Promise<MaterialProvenancePatchResult>;
  updateName(rawInput: unknown): Promise<MaterialUpdateNameResult>;
  /** E10.4 W2：在线拉取导入（拉取/落盘/登记 + 失败分类六档，design §1.1）。 */
  importOnlineMaterial(rawInput: unknown): Promise<MaterialsImportOnlineResult>;
  /** E10.4 W2：关键词发现（web+wiki 并发合并去重，零 LLM，design §1.2）。 */
  searchOnlineSources(rawInput: unknown): Promise<OnlineSourceHit[]>;
}

export interface MaterialIpcDeps {
  /** 广播面（默认 sendMaterialChanged；测试 spy 注入）。 */
  notify?: (event: MaterialChangedEvent) => void;
}

export function createMaterialIpcHandlers(deps: MaterialIpcDeps = {}): MaterialIpcHandlers {
  const notify = deps.notify ?? sendMaterialChanged;

  return {
    /** `materials:list`——scope 车道登记行枚举 → 摘要投影。坏参 throw（模式 B，mirror worldIpc）。 */
    async listMaterials(rawInput: unknown): Promise<MaterialSummary[]> {
      const input = coerceScopeInput(rawInput);
      if (input.scope === undefined) throw new Error('materials:list 需要 scope（project|global）');
      if (input.scope === 'project') {
        if (input.projectId === undefined) throw new Error('materials:list 项目车道需要 projectId');
        return listMaterialRows('project', input.projectId).map(toSummary);
      }
      return listMaterialRows('global').map(toSummary);
    },

    /** `materials:get`——全行 + 派生/原件绝对路径（打开派生 .md / reveal 用）。 */
    async getMaterial(rawInput: unknown): Promise<MaterialDetail | null> {
      const { materialId } = coerceMaterialIdInput(rawInput);
      if (materialId === undefined) throw new Error('materials:get 需要 materialId');
      const material = getMaterialRow(materialId);
      if (material === null) return null;
      const resolved =
        material.scope === 'global'
          ? resolveGlobalLane()
          : material.projectId !== null
            ? resolveProjectLane(material.projectId)
            : null;
      if (resolved === null) return { material, derivedAbsPath: null, sourceAbsPath: null };
      const rel = relInMaterialsOfSourcePath(material);
      const derivedRel = derivedRelPathForMaterial(material);
      return {
        material,
        derivedAbsPath: derivedRel === null ? null : path.join(resolved.materialsRoot, derivedRel),
        sourceAbsPath: rel === null ? null : path.join(resolved.materialsRoot, rel),
      };
    },

    /**
     * `materials:delete`——D8 四清（原件 + 派生 .md + 登记行 + 双车道 chunk 行），删除前
     * .orison/history 快照兜底（localHistory 先例；二进制原件 docx/pdf/epub 等 TEXT_EXT_RE
     * 外扩展由本文件原字节直拷补齐——CR-024，确认弹窗承诺的快照对二进制同样成立）。IPC 层
     * 不二次确认（确认弹窗归 UI）。
     */
    async deleteMaterial(rawInput: unknown): Promise<MaterialDeleteResult> {
      const { materialId } = coerceMaterialIdInput(rawInput);
      if (materialId === undefined) {
        return { ok: false, error: 'invalid-input', message: '需要 materialId' };
      }
      const material = getMaterialRow(materialId);
      if (material === null) return { ok: false, error: 'not-found' };
      const resolved =
        material.scope === 'global'
          ? resolveGlobalLane()
          : material.projectId !== null
            ? resolveProjectLane(material.projectId)
            : null;

      let removedSourceFile = false;
      let removedDerivedFile = false;
      if (resolved !== null) {
        const rel = relInMaterialsOfSourcePath(material);
        const derivedRel = derivedRelPathForMaterial(material);
        const sourceAbs = rel === null ? null : path.join(resolved.materialsRoot, rel);
        const derivedAbs = derivedRel === null ? null : path.join(resolved.materialsRoot, derivedRel);
        // 快照兜底（best-effort——localHistory 内部全吞错，绝不阻删除）。CR-024：二进制
        // 原件（TEXT_EXT_RE 外扩展）被 localHistory 静默排除——原字节直拷补齐承诺。
        for (const target of [sourceAbs, derivedAbs]) {
          if (target !== null && existsSync(target)) {
            snapshotToLocalHistory(resolved.historyRoot, target);
            if (!LOCAL_HISTORY_TEXT_EXT_RE.test(target)) {
              snapshotBinaryToLocalHistory(resolved.historyRoot, target);
            }
          }
        }
        // rmBestEffort 语义（rmSync force：缺席不抛）；单文件失败不阻 db 清理（登记行
        // 清掉后 watcher orphan 路径不再复活，遗留文件由用户在文件树自删——warn 可见）。
        if (sourceAbs !== null) {
          try {
            rmSync(sourceAbs, { force: true });
            removedSourceFile = true;
          } catch (err) {
            getLogger().warn({ err: errMsg(err), materialId, sourceAbs }, 'materials:delete source unlink failed - continuing');
          }
        }
        if (derivedAbs !== null) {
          try {
            rmSync(derivedAbs, { force: true });
            removedDerivedFile = true;
          } catch (err) {
            getLogger().warn({ err: errMsg(err), materialId, derivedAbs }, 'materials:delete derived unlink failed - continuing');
          }
        }
      }

      // 登记行 + 双车道 chunk 行（单事务——Wave C deleteMaterialRows 即本面 db 清理复用点）。
      try {
        deleteMaterialRows(materialId);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), materialId }, 'materials:delete rows cleanup failed');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
      // E10.3a W6 + CR-1/CR-2 + E10.3b W1：拆解产物级联四清扩展（F-02——本族八表 + canon 单
      // 事务：job/pass_state/facts/entity/dictionary + child B 三表 product/report/review〔job
      // 键控，经 job 集反查〕；材料是事实层三表的唯一键源，随材料走）。
      // - **在途管线取消握手**（CR-1）：在途拆解管线先经注册表置取消旗标——管线在下一章/域
      //   边界停（job 行级联删除后 cost 回写抛哨兵静默退出，不复活行）。
      // - **失败补偿**（CR-2）：级联失败时材料登记行已删——重删材料不可再触发本清理（旧注释
      //   失实）。补偿 = 受影响 job 翻 failed + 指引 note（用户经 decon:delete per-job 级联
      //   重入清理 job/pass_state/B 三表/canon 残留；canon 谓词含 job_id 反查兜底 malformed 行）。
      cancelInflightDeconPipelinesForMaterial(materialId);
      try {
        deleteDeconProductsByMaterial(materialId);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), materialId }, 'materials:delete decon products cleanup failed - compensating');
        try {
          const flipped = failDeconJobsByMaterialForCleanup(
            materialId,
            '材料删除级联清理失败（残留拆书产物）——请逐个删除本拆解会话以完成清理',
            new Date().toISOString(),
          );
          if (flipped > 0) {
            getLogger().warn({ materialId, flipped }, 'materials:delete decon cleanup compensation flipped jobs to failed');
          }
        } catch (compErr) {
          getLogger().warn({ err: errMsg(compErr), materialId }, 'materials:delete decon cleanup compensation failed (orphans remain - see decon:list)');
        }
      }
      notify({ scope: material.scope, projectId: material.projectId, materialId, reason: 'deleted' });
      return { ok: true, removedSourceFile, removedDerivedFile };
    },

    /**
     * `materials:reingest`——registerMaterial 完整管线（解析→质量诊断→两段式分章→派生 .md→
     * 登记→索引；幂等：原件未变沿用存档章界/人工标记，内容变更 shingle 差分重分章——AC4/AC6）。
     * 内部 per-scope 串行队列（enqueueLaneWork）天然防批量并发风暴；本 await 即队列执行完毕回执。
     */
    async reingestMaterial(rawInput: unknown): Promise<MaterialReingestResult> {
      const { materialId } = coerceMaterialIdInput(rawInput);
      if (materialId === undefined) {
        return { ok: false, error: 'invalid-input', message: '需要 materialId' };
      }
      const material = getMaterialRow(materialId);
      if (material === null) return { ok: false, error: 'not-found' };
      const rel = relInMaterialsOfSourcePath(material);
      if (rel === null) {
        return { ok: false, error: 'operation-failed', message: `登记行 source_path 形态异常：${material.provenance.sourcePath}` };
      }
      const resolved =
        material.scope === 'global'
          ? resolveGlobalLane()
          : material.projectId !== null
            ? resolveProjectLane(material.projectId)
            : null;
      if (resolved === null) {
        return { ok: false, error: 'unregistered', message: '项目车道材料的项目未在注册库（重开项目后自愈）' };
      }
      let result;
      try {
        result = await registerMaterial(resolved.lane, rel);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), materialId }, 'materials:reingest register threw');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
      if (result.outcome === 'unregistered') {
        return { ok: false, error: 'unregistered' };
      }
      if (result.outcome === 'rejected') {
        return { ok: false, error: 'operation-failed', message: `摄取失败：${result.reason ?? 'unknown'}` };
      }
      notify({
        scope: material.scope,
        projectId: material.projectId,
        materialId,
        // orphaned = 原件不在（外部已删）→ 登记行已清——按删除语义广播。
        reason: result.outcome === 'orphaned' ? 'deleted' : 'reingested',
      });
      return { ok: true, outcome: result.outcome, materialId };
    },

    /**
     * `materials:import`——批量拖入：白名单/50MB/批量 250 shell 侧强制（三档拒收分类回报）
     * + uniquePath 重名避让 + 逐份 registerMaterial + 逐份 material:changed 广播（进度可见）。
     * 部分成功语义：拒收项回报文件名 + 分类；拷入成功但摄取失败入 failed（watcher/backfill
     * 自愈，非拒收档）。
     */
    async importMaterials(rawInput: unknown): Promise<MaterialsImportResult> {
      const input = (() => {
        const coerced = coerceScopeInput(rawInput);
        const paths = (rawInput as { absolutePaths?: unknown } | null)?.absolutePaths;
        return {
          scope: coerced.scope,
          projectId: coerced.projectId,
          absolutePaths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [],
        };
      })();
      if (input.scope === undefined || input.absolutePaths.length === 0) {
        return { ok: false, error: 'invalid-input', message: '需要 scope 与非空 absolutePaths' };
      }
      const resolved =
        input.scope === 'global'
          ? resolveGlobalLane()
          : input.projectId !== undefined
            ? resolveProjectLane(input.projectId)
            : null;
      if (resolved === null) {
        return { ok: false, error: 'unregistered', message: '项目车道需要有效 projectId（注册库可解析）' };
      }

      const imported: MaterialImportedItem[] = [];
      const rejected: MaterialImportRejectedItem[] = [];
      const failed: Array<{ name: string; relPath: string; reason: string }> = [];
      // CR-001 stem 查重账（stem → 实际落盘扩展名——uniquePath 重命名后按落盘名记账）。
      const batchStems = new Map<string, string>();

      // 批量闸（250 独立上限，F-06）：溢出整批回报 batch-overflow。
      const batch = input.absolutePaths.slice(0, MATERIAL_IMPORT_MAX_BATCH);
      for (const src of input.absolutePaths.slice(MATERIAL_IMPORT_MAX_BATCH)) {
        const name = path.basename(src);
        rejected.push({ name: name || src, kind: 'batch-overflow' });
      }

      try {
        if (!existsSync(resolved.materialsRoot)) mkdirSync(resolved.materialsRoot, { recursive: true });
      } catch (err) {
        return { ok: false, error: 'operation-failed', message: `materials 目录创建失败：${errMsg(err)}` };
      }

      for (const src of batch) {
        const name = path.basename(src);
        // 单文件闸链（先廉价后贵）：绝对路径 → 敏感源 → 扩展名白名单 → 大小。
        if (!path.isAbsolute(src) || name.startsWith('.') || name === 'node_modules') {
          rejected.push({ name: name || src, kind: 'unsupported-format' });
          continue;
        }
        let size: number;
        try {
          const stats = statSync(src);
          if (!stats.isFile()) {
            rejected.push({ name, kind: 'unsupported-format' });
            continue;
          }
          size = stats.size;
        } catch {
          // 不可访问/不存在（拖拽列表与拷入间的 TOCTOU）——CR-011 独立档：真实原因可见。
          rejected.push({ name, kind: 'missing' });
          continue;
        }
        // CR-023：敏感检查先 realpath——path.resolve 不解析 symlink/junction，链接指向敏感
        // 目录的源不得凭「链接自身路径不在清单」绕过门。
        let realSrc: string;
        try {
          realSrc = realpathSync(src);
        } catch {
          rejected.push({ name, kind: 'missing' }); // stat 已过但 realpath 失败（TOCTOU 消失）
          continue;
        }
        if (isSensitiveImportSource(realSrc)) {
          rejected.push({ name, kind: 'sensitive' });
          continue;
        }
        const ext = path.extname(name).toLowerCase();
        if (!(MATERIAL_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
          rejected.push({ name, kind: 'unsupported-format' });
          continue;
        }
        if (size > MATERIAL_MAX_FILE_BYTES) {
          rejected.push({ name, kind: 'too-large' });
          continue;
        }
        // CR-001（stem 拒收半）：同 stem 异扩展 → 派生 .md 镜像同路径互覆写——后到者拒收
        //（同 stem 同扩展走下方 uniquePath 重名序号，非本档）。
        const stemLower = (ext ? name.slice(0, -ext.length) : name).toLowerCase();
        if (stemConflictsInLane(resolved.materialsRoot, stemLower, ext, batchStems)) {
          rejected.push({ name, kind: 'stem-conflict' });
          continue;
        }

        // 拷入（uniquePath 重名序号）。
        const dest = uniquePath(resolved.materialsRoot, name);
        try {
          copyFileSync(src, dest);
        } catch (err) {
          getLogger().warn({ err: errMsg(err), src }, 'materials:import copy failed');
          failed.push({ name, relPath: '', reason: `拷入失败：${errMsg(err)}` });
          continue;
        }
        // stem 账按**落盘名**记（uniquePath 重命名后 stem 变——foo-1.txt 的 stem 是 foo-1）：
        // 后续同批 foo-1.<异扩展> 才是覆写风险。拷入即记（register 失败件也在盘，watcher
        // 自愈后同样占派生路径）。
        const destName = path.basename(dest);
        const destExt = path.extname(destName).toLowerCase();
        batchStems.set((destExt ? destName.slice(0, -destExt.length) : destName).toLowerCase(), destExt);
        const relPath = path.relative(resolved.materialsRoot, dest).split(path.sep).join('/');

        // 逐份登记（registerMaterial 内部 per-scope 串行队列；watcher 同步收事件被
        // hash-skip/登记 UNIQUE 吸收——F-12 三道闸）。
        let registerOutcome;
        try {
          registerOutcome = await registerMaterial(resolved.lane, relPath);
        } catch (err) {
          getLogger().warn({ err: errMsg(err), relPath }, 'materials:import register threw');
          failed.push({ name, relPath, reason: `登记失败：${errMsg(err)}` });
          continue;
        }
        if (registerOutcome.outcome === 'rejected') {
          failed.push({ name, relPath, reason: `摄取失败：${registerOutcome.reason ?? 'unknown'}` });
          continue;
        }
        if (registerOutcome.outcome === 'unregistered') {
          failed.push({ name, relPath, reason: '项目未注册（重开项目后 watcher 自愈登记）' });
          continue;
        }
        imported.push({
          name,
          relPath,
          materialId: registerOutcome.materialId ?? null,
          outcome: registerOutcome.outcome === 'orphaned' ? 'orphaned' : registerOutcome.outcome,
        });
        // 进度可见：逐份广播（UI materialsSlice 事件刷新三件套——debounce 聚合窗吸收批量风暴）。
        notify({
          scope: input.scope,
          projectId: resolved.projectId,
          materialId: registerOutcome.materialId,
          reason: 'imported',
        });
      }
      return { ok: true, imported, rejected, failed };
    },

    /**
     * `materials:update-provenance`——F-05 五字段 + E10.2a description 后补。patch 字段缺省
     * = 不动；author/lang/originDate/description 显式 null = 清空（空串归一为 null）；medium
     * 须非空串；tier 四值枚举。直写 UPDATE 的理由见文件头（upsertMaterialRow 的 COALESCE 以
     * 既有值优先，显式 patch 无法经它落地）；写后任何重摄取经 preserveCuratedProvenance 保留
     * 新值——防清闭环（description 同列，F-03）。
     */
    async updateProvenance(rawInput: unknown): Promise<MaterialProvenancePatchResult> {
      const coerced = coerceMaterialIdInput(rawInput);
      const rawPatch = (rawInput as { patch?: unknown } | null)?.patch;
      if (coerced.materialId === undefined || rawPatch === null || typeof rawPatch !== 'object') {
        return { ok: false, error: 'invalid-input', message: '需要 materialId 与 patch 对象' };
      }
      const materialId = coerced.materialId;

      // patch 归一（区分「缺省不动」与「null 清空」——in 判定是关键）。
      const source = rawPatch as Record<string, unknown>;
      const patch: MaterialProvenancePatchInput['patch'] = {};
      if ('medium' in source) {
        if (typeof source.medium !== 'string' || source.medium.trim().length === 0) {
          return { ok: false, error: 'invalid-patch', message: 'medium 须为非空字符串' };
        }
        patch.medium = source.medium.trim();
      }
      if ('tier' in source) {
        const tier = source.tier;
        if (tier !== 'original' && tier !== 'community' && tier !== 'criticism' && tier !== 'unspecified') {
          return { ok: false, error: 'invalid-patch', message: 'tier 须为 original|community|criticism|unspecified' };
        }
        patch.tier = tier;
      }
      for (const field of ['author', 'lang', 'originDate', 'description'] as const) {
        if (!(field in source)) continue;
        const value = source[field];
        let normalized: string | null;
        if (value === null || value === '') {
          normalized = null; // 显式清空（空串归一 null——表单空输入语义）。
        } else if (typeof value === 'string') {
          normalized = value.trim() || null;
        } else {
          return { ok: false, error: 'invalid-patch', message: `${field} 须为字符串或 null` };
        }
        // CR-6：简介长度上限（schema max + handler 校验 + UI maxLength 三处齐，单源常量
        // shared-contracts）。超限 → invalid-input（mirror update-name 超长档——textarea
        // maxLength 是 UX 面，paste/程序调用仍可超，handler 是权威闸）。
        if (field === 'description' && normalized !== null && normalized.length > MATERIAL_DESCRIPTION_MAX_CHARS) {
          return {
            ok: false,
            error: 'invalid-input',
            message: `简介长度超上限（>${MATERIAL_DESCRIPTION_MAX_CHARS} 字）`,
          };
        }
        patch[field] = normalized;
      }

      const material = getMaterialRow(materialId);
      if (material === null) return { ok: false, error: 'not-found' };
      const nextProvenance = { ...material.provenance, ...patch };
      // schema 守形（medium 词表开放性/字段类型——IPC 边界校验后再落库）。
      const parsed = materialProvenanceSchema.safeParse(nextProvenance);
      if (!parsed.success) {
        return { ok: false, error: 'invalid-patch', message: parsed.error.issues.map((i) => i.message).join('; ') };
      }

      try {
        getDb()
          .prepare(
            `UPDATE closure_material
               SET provenance_json=?, updated_at=datetime('now')
             WHERE material_id=?`,
          )
          .run(JSON.stringify(parsed.data), materialId);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), materialId }, 'materials:update-provenance UPDATE failed');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
      notify({ scope: material.scope, projectId: material.projectId, materialId, reason: 'provenance-updated' });
      const refreshed = getMaterialRow(materialId);
      if (refreshed === null) {
        return { ok: false, error: 'operation-failed', message: '回读登记行失败（并发删除？）' };
      }
      return { ok: true, material: refreshed };
    },

    /**
     * `materials:update-name`——E10.2a 材料显示名（视频标题）编辑（design §3.1）。name 是
     * display 列：materialId 路径身份不受影响（重命名不影响幂等/锚定）。校验 trim + 非空 +
     * ≤ MATERIAL_NAME_MAX_CHARS（shared-contracts 单源，越界/空白 → invalid-input，模式 A）。
     * 与 update-provenance 同理直写 UPDATE（name 非 provenance 域，语义分离——design §3.1
     * 「不并入 provenance patch」）。
     */
    async updateName(rawInput: unknown): Promise<MaterialUpdateNameResult> {
      const coerced = coerceMaterialIdInput(rawInput);
      const rawName = (rawInput as { name?: unknown } | null)?.name;
      if (coerced.materialId === undefined || typeof rawName !== 'string') {
        return { ok: false, error: 'invalid-input', message: '需要 materialId 与 name 字符串' };
      }
      const materialId = coerced.materialId;
      const name = rawName.trim();
      if (name.length === 0) {
        return { ok: false, error: 'invalid-input', message: '标题不能为空' };
      }
      if (name.length > MATERIAL_NAME_MAX_CHARS) {
        return {
          ok: false,
          error: 'invalid-input',
          message: `标题长度超上限（>${MATERIAL_NAME_MAX_CHARS} 字）`,
        };
      }
      const material = getMaterialRow(materialId);
      if (material === null) return { ok: false, error: 'not-found' };
      try {
        getDb()
          .prepare(
            `UPDATE closure_material
               SET name=?, updated_at=datetime('now')
             WHERE material_id=?`,
          )
          .run(name, materialId);
      } catch (err) {
        getLogger().warn({ err: errMsg(err), materialId }, 'materials:update-name UPDATE failed');
        return { ok: false, error: 'operation-failed', message: errMsg(err) };
      }
      notify({ scope: material.scope, projectId: material.projectId, materialId, reason: 'name-updated' });
      const refreshed = getMaterialRow(materialId);
      if (refreshed === null) {
        return { ok: false, error: 'operation-failed', message: '回读登记行失败（并发删除？）' };
      }
      return { ok: true, material: refreshed };
    },

    /**
     * `materials:import-online`——E10.4 W2（design §1.1）：research session 拉取 + MoeSkin
     * template 预解包 + htmlToMarkdown 抽取（onlineMaterial.fetchOnlinePageAsMarkdown——
     * bad-url/fetch-failed/empty-content/oversize 四档拉取半分类）→ 类别→medium/tier 映射 →
     * `materials/online/<stem>-<sha-n(url)>.md` 落盘（抽取文本即原件，P3 stem 规则；sha 宽度
     * 8→12→16 撞库加宽见下）→ registerMaterial 管线（P2 seam provenanceOverrides：medium/
     * tier/url/via='web-fetch'/author/originDate 预填 + nameOverride 页面标题 + 截断
     * extraParseNotes）→ 模式 A 六档失败分类回报 + 同 URL 幂等（stem 稳定 = 路径身份；
     * content 未变 reused / 变更 reingest，AC4）。失败分类 stem-conflict/ingest-failed 两档
     * 属登记半。批量面注记（CR-12）：本通道单 URL 逐条，批量 ≤ MATERIAL_ONLINE_IMPORT_MAX_BATCH
     * （20）由 UI 以 shared 常量执行拦截。
     */
    async importOnlineMaterial(rawInput: unknown): Promise<MaterialsImportOnlineResult> {
      const input = coerceOnlineImportInput(rawInput);
      if (input === null) {
        return { ok: false, error: 'invalid-input', message: '需要 url、scope（project|global）与 category（四档类别）' };
      }
      if (input.scope === 'project' && input.projectId === undefined) {
        return { ok: false, error: 'invalid-input', message: '项目车道需要 projectId' };
      }
      const resolved =
        input.scope === 'global'
          ? resolveGlobalLane()
          : input.projectId !== undefined
            ? resolveProjectLane(input.projectId)
            : null;
      if (resolved === null) {
        return { ok: false, error: 'unregistered', message: '项目车道需要有效 projectId（注册库可解析）' };
      }
      const onlineDir = path.join(resolved.materialsRoot, ONLINE_SOURCE_DIR);

      // P3 stem 规则：`<URL 末段 sanitize 截 64>-<sha-n(归一 url)>`——同 URL stem 稳定（幂等
      // 路径身份），异 URL 同标题词条不派生同 stem（同 stem 第二条会以 reingest 语义静默覆写
      // 第一条）。stem-conflict：online/ 目录内同 stem 异扩展（派生 .md 镜像同路径互覆写——
      // CR-001 同族；同 stem 同扩展 .md = 幂等/reingest 路径，不落冲突档）。stem 只依赖 URL——
      // 先于拉取判，冲突早退不烧网络。
      if (stemConflictsInLane(onlineDir, onlineStemForUrl(input.url).toLowerCase(), '.md', new Map())) {
        return {
          ok: false,
          error: 'stem-conflict',
          message: `同名异扩展材料已存在（${ONLINE_SOURCE_DIR}/${onlineStemForUrl(input.url)}.*）——派生 .md 路径冲突`,
        };
      }

      // 拉取半（SSRF 守卫/2MB cap/MoeSkin 解包/抽取/截断——onlineMaterial 单源）。
      const extraction = await fetchOnlinePageAsMarkdown(input.url);
      if (!extraction.ok) {
        return { ok: false, error: extraction.error, message: extraction.message };
      }

      // CR-4/CR-5：落盘名解析（拉取后、写盘前——TOCTOU 复查）。宽度阶梯 8→12→16：目标
      // `.md` 在且登记行 provenance.url 异源（真 sha 撞库/同 stem 异页）→ 加宽重试；url 同源
      // （入参 URL 或重定向终址）→ 沿用该 stem（幂等/reingest 路径）。选定的 stem 再复查异扩
      // 展冲突（拉取窗口内新出现的占位件在本步接住）。
      const sameSource = (rowUrl: string | null): boolean =>
        rowUrl === input.url || (extraction.finalUrl !== '' && rowUrl === extraction.finalUrl);
      let fileName: string | null = null;
      for (const width of ONLINE_STEM_HASH_WIDTHS) {
        const candidate = onlineFileNameFor(input.url, width);
        if (!existsSync(path.join(onlineDir, candidate))) {
          fileName = candidate;
          break;
        }
        const row = getMaterialRow(
          materialIdFor(input.scope, materialSourcePath(input.scope, `${ONLINE_SOURCE_DIR}/${candidate}`)),
        );
        if (row !== null && sameSource(row.provenance.url)) {
          fileName = candidate;
          break;
        }
        // 占位件异源（或登记行已删）→ 加宽重试。
      }
      const chosenStem = fileName !== null ? path.basename(fileName, '.md') : null;
      if (fileName === null || chosenStem === null) {
        return {
          ok: false,
          error: 'stem-conflict',
          message: `在线材料路径占位冲突（sha 宽度阶梯用尽）——请检查 ${ONLINE_SOURCE_DIR}/ 内同源文件`,
        };
      }
      if (stemConflictsInLane(onlineDir, chosenStem.toLowerCase(), '.md', new Map())) {
        return {
          ok: false,
          error: 'stem-conflict',
          message: `同名异扩展材料已存在（${ONLINE_SOURCE_DIR}/${chosenStem}.*）——派生 .md 路径冲突`,
        };
      }
      const relPath = `${ONLINE_SOURCE_DIR}/${fileName}`;

      // 落盘（抽取文本即原件——D4 拍板；md 直读管线零新 parser）。
      try {
        mkdirSync(onlineDir, { recursive: true });
        atomicWriteFileSync(path.join(onlineDir, fileName), extraction.content, 'utf-8');
      } catch (err) {
        return { ok: false, error: 'ingest-failed', message: `在线材料落盘失败：${errMsg(err)}` };
      }

      // P2 竞态防护（落盘 → 登记零 await）：写盘与 registerMaterial 入队之间无挂起点，本注册
      // 恒先于 watcher 对该文件的 500ms debounce flush 进 per-scope 串行队列；watcher 随后的
      // 默认 provenance 重登记经 preserveCuratedProvenance COALESCE 保留预填值——「登记先于
      // watcher 可见」+「COALESCE 保预填」两半合起来闭环（restart 后 backfill 抢登记的残窗口
      // 接受：用户经 UI 后补通道修复）。
      const mapped = categoryToProvenanceDefaults(input.category);
      let registerResult;
      try {
        registerResult = await registerMaterial(resolved.lane, relPath, {
          provenanceOverrides: {
            medium: mapped.medium,
            tier: mapped.tier,
            via: 'web-fetch',
            url: extraction.finalUrl,
            ...(extraction.author !== null ? { author: extraction.author } : {}),
            ...(extraction.originDate !== null ? { originDate: extraction.originDate } : {}),
          },
          ...(extraction.truncated ? { extraParseNotes: [onlineTruncationNote(extraction.originalChars)] } : {}),
          nameOverride: extraction.title,
        });
      } catch (err) {
        getLogger().warn({ err: errMsg(err), url: input.url }, 'materials:import-online register threw');
        return { ok: false, error: 'ingest-failed', message: `登记失败：${errMsg(err)}（文件已保留，watcher/backfill 稍后自愈登记）` };
      }
      if (registerResult.outcome === 'unregistered') {
        return { ok: false, error: 'unregistered', message: '项目未注册（重开项目后 watcher 自愈登记）' };
      }
      if (registerResult.outcome === 'rejected') {
        // 文件已落盘——watcher/backfill 自愈登记（mirror importMaterials failed 语义，非拒收档）。
        return {
          ok: false,
          error: 'ingest-failed',
          message: `摄取失败：${registerResult.reason ?? 'unknown'}（文件已保留，watcher/backfill 稍后自愈登记）`,
        };
      }
      const materialId = registerResult.materialId;
      if (materialId === undefined) {
        return { ok: false, error: 'ingest-failed', message: '登记回执缺 materialId' };
      }
      notify({
        scope: input.scope,
        projectId: resolved.projectId,
        materialId,
        // CR-15：reused（幂等 skip）如实广播——'reingested' 对未变内容语义误导（additive
        // enum，UI refresh-only 消费面零分支）。
        reason: registerResult.outcome === 'reused' ? 'reused' : 'imported',
      });
      return {
        ok: true,
        materialId,
        outcome: registerResult.outcome,
        name: extraction.title,
        sourcePath: materialSourcePath(input.scope, relPath),
        truncated: extraction.truncated,
      };
    },

    /**
     * `materials:search-online`——E10.4 W2（design §1.2）：web_search + wiki_search 既有核心
     * 并发合并去重（onlineMaterial.searchOnlineSourcesCore，零 LLM）；读面坏参 = 模式 B throw
     * （mirror materials:list）。
     */
    async searchOnlineSources(rawInput: unknown): Promise<OnlineSourceHit[]> {
      const source = rawInput as { query?: unknown; limit?: unknown } | null;
      const query = typeof source?.query === 'string' ? source.query.trim() : '';
      if (!query) throw new Error('materials:search-online 需要 query（关键词）');
      const limit = typeof source?.limit === 'number' && Number.isFinite(source.limit) ? source.limit : undefined;
      return searchOnlineSourcesCore({ query, ...(limit !== undefined ? { limit } : {}) });
    },
  };
}

/**
 * 注册材料库九通道（七既有 + E10.4 在线导入/搜索两通道；registerAllIpc 恰调一次；同 channel
 * 二次 ipcMain.handle 会抛错——spec/shell/ipc-handlers.md 注册纪律，mirror registerInboxAttachmentIpc）。
 */
export function registerMaterialIpc(): void {
  const handlers = createMaterialIpcHandlers();
  ipcMain.handle('materials:list', (_e, input: unknown) => handlers.listMaterials(input));
  ipcMain.handle('materials:get', (_e, input: unknown) => handlers.getMaterial(input));
  ipcMain.handle('materials:delete', (_e, input: unknown) => handlers.deleteMaterial(input));
  ipcMain.handle('materials:reingest', (_e, input: unknown) => handlers.reingestMaterial(input));
  ipcMain.handle('materials:import', (_e, input: unknown) => handlers.importMaterials(input));
  ipcMain.handle('materials:update-provenance', (_e, input: unknown) => handlers.updateProvenance(input));
  ipcMain.handle('materials:update-name', (_e, input: unknown) => handlers.updateName(input));
  ipcMain.handle('materials:import-online', (_e, input: unknown) => handlers.importOnlineMaterial(input));
  ipcMain.handle('materials:search-online', (_e, input: unknown) => handlers.searchOnlineSources(input));
}
