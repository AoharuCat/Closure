import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { patchOperationSchema, projectDocumentSchema, transformForeshadowToPromise, markStaleFields } from '@orison/shared-contracts';
import type { ProjectFieldPatch, CreativeFieldKey, ForeshadowMigrationInput } from '@orison/shared-contracts';
import { acceptChapterCandidateCore, preserveChapterFrontmatter, type ChapterIntegrationProject } from '@orison/shared-contracts';
import { decodeFileToUtf8 } from '@orison/shared-contracts/fs/decodeText';
import {
  applyDecisionActions,
  storyDecisionActionSchema,
  type StoryDecision,
} from '@orison/shared-contracts';
import YAML from 'yaml';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { backupCorruptFile, salvageYamlPrefix } from './corruptRecovery';

type ProjectDocument = z.infer<typeof projectDocumentSchema>;
type PatchOperation = z.infer<typeof patchOperationSchema>;

// ── 旧接口（保持兼容） ──

export function createEmptyProjectDocument(
  name: string,
  type: 'novel' | 'script' = 'novel',
  extraMeta: Record<string, string> = {}
): ProjectDocument {
  const now = new Date().toISOString();
  return projectDocumentSchema.parse({
    meta: {
      id: crypto.randomUUID(),
      name,
      type,
      version: 1,
      created_at: now,
      updated_at: now,
      ...extraMeta
    },
    storyboard: {
      shots: []
    }
  });
}

export function applyPatchOperations(project: ProjectDocument, operations: PatchOperation[]) {
  const next = structuredClone(project) as Record<string, any>;

  for (const operation of operations) {
    if (operation.op !== 'replace') {
      continue;
    }
    // Legacy patch paths are no longer supported (outline.acts removed)
  }

  next.meta.version += 1;
  next.meta.updated_at = new Date().toISOString();
  return projectDocumentSchema.parse(next);
}

// ── Phase 2: 磁盘读写 ──

const PROJECT_FILE = 'project.yaml';

/**
 * dogfood R2 #77：saveProject 落盘广播订阅。盘上 project.yaml 是**单一真相源**，UI 必须
 * 收敛到它（纯时间序 last-write-wins，不按写入方身份分优先级——用户拍板）。saveProject
 * 是 project.yaml 的唯一生产写入口（侧路查证 2026-08-28：shell 全部 meta / lifecycle /
 * identity / field-sync / tool-handler 落盘路径均经本函数，直接 writeFileSync(project.yaml)
 * 仅存在于测试夹具），故在它成功写盘后同步广播，shell 主进程据此推 ToolEvent
 * `outline:changed`（契约既有孤儿类型接线，不新增事件类型），renderer 防抖重拉文档。
 * 刻意不走 projectWatcher 的 file:changed：其自写抑制（tab 冲突保护）语义留给编辑器
 * 文件，creative fields 收敛需要确定性事件。
 */
const projectSavedListeners = new Set<(projectPath: string) => void>();

/** 订阅 saveProject 成功落盘事件；返回退订函数。listener 抛错不影响落盘与其他订阅者。 */
export function subscribeProjectSaved(listener: (projectPath: string) => void): () => void {
  projectSavedListeners.add(listener);
  return () => {
    projectSavedListeners.delete(listener);
  };
}

/**
 * 将 ProjectDocument 保存到 `<projectPath>/project.yaml`
 */
export function saveProject(projectPath: string, document: ProjectDocument): void {
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath, { recursive: true });
  }
  const filePath = path.join(projectPath, PROJECT_FILE);
  const validated = projectDocumentSchema.parse(document);
  atomicWriteFileSync(filePath, YAML.stringify(validated), 'utf8');
  // dogfood R2 #77：写盘成功后同步广播（resolve 后的规范路径，watcher/守卫同口径）。
  // 单个 listener 失败不阻断广播循环、更不影响已完成的落盘。
  const resolved = path.resolve(projectPath);
  for (const listener of projectSavedListeners) {
    try {
      listener(resolved);
    } catch (err) {
      console.warn('[saveProject] project-saved listener failed', resolved, err);
    }
  }
}

/**
 * 判腐隔离事实（quarantine-notify，2026-08-27）：loadProject 判定 project.yaml 损坏并把
 * 原文件改名让位（`.corrupt-<timestamp>` 备份）。上层（shell IPC → renderer 通知中心）
 * 依赖它把隔离事件透明化给用户——此前判腐后静默空工程重建，用户零感知（08-27 真机事故：
 * 完好文件被误判腐，打开变空白且无任何提示）。
 */
export type ProjectQuarantineInfo = {
  /** `.corrupt-<timestamp>` 备份的绝对路径。null = 改名本身失败（文件被占用等），原文件原位保留。 */
  backupPath: string | null;
  /** 拒因摘要：schema reject / YAML 解析错误信息（与 loadProject 内 warn 日志同源）。 */
  reason: string;
  /** 隔离后是否仍抢救出了可用文档（YAML 前缀抢救且最终 schema 通过）。false = 上层以空工程/bootstrap 重建兜底。 */
  recovered: boolean;
};

export type ProjectLoadResult = {
  document: ProjectDocument | null;
  /** 非 null = 本次加载发生了判腐隔离（原 project.yaml 已被改名让位）；null = 正常加载零隔离。 */
  quarantined: ProjectQuarantineInfo | null;
};

/**
 * 从 `<projectPath>/project.yaml` 读取 ProjectDocument，判腐路径携带隔离事实。
 * 文件不存在返回 `{ document: null, quarantined: null }`。
 */
export function loadProjectWithQuarantine(projectPath: string): ProjectLoadResult {
  const filePath = path.join(projectPath, PROJECT_FILE);
  if (!existsSync(filePath)) return { document: null, quarantined: null };

  const raw = readFileSync(filePath, 'utf8');

  let parsed: any;
  let quarantined: ProjectQuarantineInfo | null = null;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    // Corrupt YAML — legacy non-atomic-write damage leaves a valid prefix with a
    // stale tail. Throwing here would wedge EVERY save path (all start with a
    // load), so instead salvage the prefix, set the bad file aside, and either
    // recover the real data or let the caller's bootstrap rebuild a clean file.
    const recovery = recoverCorruptProject(filePath, raw);
    quarantined = {
      backupPath: recovery.backupPath,
      reason: e instanceof Error ? e.message : String(e),
      recovered: false, // 抢救出的文档能否过 schema 未知；最终 parse 成功时下方翻 true
    };
    if (!recovery.salvaged) return { document: null, quarantined };
    parsed = recovery.salvaged;
  }

  // Empty or corrupt YAML parses to null/non-object. Return null (rather than
  // throwing on the property access below) so callers' bootstrap/self-heal
  // fallback can kick in instead of silently losing the edit.
  if (!parsed || typeof parsed !== 'object') return { document: null, quarantined };

  // Migration: legacy outline -> outline_v2
  if (!parsed.outline_v2 && parsed.outline) {
    const legacyOutline = parsed.outline;
    const acts = Array.isArray(legacyOutline.acts) ? legacyOutline.acts : [];
    const actSummaries = acts
      .map((act: any) => [act.title, act.summary].filter(Boolean).join('：'))
      .filter(Boolean);
    const turningPoints = acts
      .map((act: any) => act.turning_point ?? act.title)
      .filter((x: any): x is string => typeof x === 'string' && x.trim() !== '')
      // Story 1.2: major_turning_points upgraded to typed anchors
      // {type,label,description?}. Legacy string → default core-anchor (LLM
      // refines type later). design §6 migration strategy. CR-005: typeof
      // guard — non-string truthy turning_point (object/number) would else
      // produce a non-string label and fail schema parse → corrupt project.
      .map((label: string) => ({ type: 'core-anchor', label }));

    // Move identity fields to meta
    if (!parsed.meta.logline && legacyOutline.logline) parsed.meta.logline = legacyOutline.logline;
    if (!parsed.meta.synopsis && (legacyOutline.synopsis || actSummaries.length > 0)) {
      parsed.meta.synopsis = legacyOutline.synopsis ?? actSummaries.join('\n');
    }
    if (!parsed.meta.theme && legacyOutline.theme) parsed.meta.theme = legacyOutline.theme;
    if (!parsed.meta.genre && legacyOutline.genre) parsed.meta.genre = legacyOutline.genre;

    parsed.outline_v2 = {
      central_conflict: legacyOutline.central_conflict,
      major_turning_points: turningPoints,
      ending_direction: legacyOutline.ending_direction,
      constraints: [],
    };
  }

  // Migration: remove deprecated outline/detailed_outline fields
  delete parsed.outline;
  delete parsed.detailed_outline;

  // Migration: old chapters without sections → wrap content_file into a single section
  if (parsed.novel?.chapters && Array.isArray(parsed.novel.chapters)) {
    for (const ch of parsed.novel.chapters) {
      if (!ch.sections && ch.content_file) {
        ch.sections = [{
          id: `${ch.id}_s1`,
          sort_order: 0,
          content_file: ch.content_file,
          word_count: ch.word_count,
        }];
        delete ch.content_file;
        delete ch.bridge_notes;
      }
      delete ch.act_id;
    }
  }

  // Migration: remove act_id from script scenes
  if (parsed.script?.scenes && Array.isArray(parsed.script.scenes)) {
    for (const sc of parsed.script.scenes) {
      delete sc.act_id;
    }
  }

  // Migration: assets.characters → asset_cards
  if (parsed.assets?.characters && !parsed.asset_cards) {
    parsed.asset_cards = parsed.assets.characters.map((c: any, i: number) => ({
      id: c.id ?? `imported_char_${i}`,
      type: 'character',
      name: c.name,
      summary: [c.appearance, c.personality].filter(Boolean).join('；') || undefined,
      tags: [],
      relationships: [],
      sourceRefs: [],
      status: 'active',
      locked: false
    }));
  }

  // Migration: move identity fields from outline_v2 to meta
  if (parsed.outline_v2) {
    if (!parsed.meta.logline && parsed.outline_v2.logline) parsed.meta.logline = parsed.outline_v2.logline;
    if (!parsed.meta.synopsis && parsed.outline_v2.synopsis) parsed.meta.synopsis = parsed.outline_v2.synopsis;
    if (!parsed.meta.theme && parsed.outline_v2.theme) parsed.meta.theme = parsed.outline_v2.theme;
    if (!parsed.meta.genre && parsed.outline_v2.genre) parsed.meta.genre = parsed.outline_v2.genre;
    delete parsed.outline_v2.title;
    delete parsed.outline_v2.logline;
    delete parsed.outline_v2.synopsis;
    delete parsed.outline_v2.theme;
    delete parsed.outline_v2.genre;
  }

  // Migration: remove acts from outline_v2
  if (parsed.outline_v2?.acts) {
    delete parsed.outline_v2.acts;
  }

  // Migration (Story 8.5, design §7 D3): outline_v2 假字段重命名——growth_curve→arc_design_notes /
  // pacing_curve_text→pacing_design_notes。两键是 OrisonSpace 遗物自由草稿位（自由文本），与顶层结构化
  // creative field growth_curve / pacing_curve 同名不同物（UI OutlineEditor 编辑的只是草稿，永远到不了
  // 4.4/8.2 消费端），改名消歧（interface-contracts 跨层命名规则1，mirror foreshadow-migration 就地
  // transform 先例）。旧键值存在且新键缺 → 写新键（保留草稿语义，零数据丢失）；旧键 delete（strip 之外
  // 的显式 belt，新 schema 不含旧键）。
  // CR-009（8.5 BMad CR）：新键守卫 falsy（`!ov.arc_design_notes`，对齐上方 meta 迁移 `!parsed.meta.logline`
  // 同函数先例）——`=== undefined` 会在「手编 yaml 新键空串 + 旧键有值」时跳过迁移、随后 delete 旧键，
  // 旧草稿零提示静默丢。空串 = 无内容，旧值承接。
  if (parsed.outline_v2) {
    const ov = parsed.outline_v2 as Record<string, unknown>;
    if (typeof ov.growth_curve === 'string' && !ov.arc_design_notes) {
      ov.arc_design_notes = ov.growth_curve;
    }
    if (typeof ov.pacing_curve_text === 'string' && !ov.pacing_design_notes) {
      ov.pacing_design_notes = ov.pacing_curve_text;
    }
    delete ov.growth_curve;
    delete ov.pacing_curve_text;
  }

  // Migration (Story 1.2, design §6): normalize already-persisted data to the
  // upgraded schemas so strict parse (below) doesn't fail and silently reset
  // the project (catch → backupCorruptFile → null → empty project).
  //   - major_turning_points: string[] → typed anchors (legacy outline.acts
  //     path handled above; this covers outline_v2 persisted as string[] by
  //     pre-1.2 story-planner / OutlineEditor). CR-003/CR-009.
  //   - lineVisibility: old enum literal → discriminated union. Old default
  //     was 'open'; 'hidden-until-X' was a placeholder never populated
  //     (scene_graph had no writer before 1.2). Normalize to open. CR-004/CR-010.
  if (Array.isArray(parsed.outline_v2?.major_turning_points)) {
    parsed.outline_v2!.major_turning_points = parsed.outline_v2!.major_turning_points.map(
      (tp: any) => (typeof tp === 'string' ? { type: 'core-anchor', label: tp } : tp)
    );
  }
  if (Array.isArray(parsed.scene_graph?.lines)) {
    for (const line of parsed.scene_graph!.lines) {
      if (typeof (line as any).visibility === 'string') {
        (line as any).visibility = { status: 'open' };
      }
    }
  }
  // Migration (Story 1.3, design §6 edge 收口): sceneEdgeTypeSchema 裁为
  // CAUSAL + SUSPENSE. pre-1.3 scene_graph persisted with FORESHADOW /
  // REVERSAL / SHARED-MOTIF / WORLD-COUPLING edges (1.1 schema allowed them;
  // 1.1/1.2 landed no real producer but a hand-edited yaml could carry them).
  // strict parse would throw -> the WHOLE project document is judged corrupt +
  // rebuilt empty (interface-contracts convention: 「schema 破坏性收紧须配
  // loadProject 就地迁移」, 1.2 visibility migration above is the precedent).
  // Drop non-CAUSAL/SUSPENSE edges (zero-consumer crop; mesh-cohesion edges
  // defer until mesh lines are actually built). CR-019/CR-009.
  if (Array.isArray(parsed.scene_graph?.edges)) {
    parsed.scene_graph!.edges = parsed.scene_graph!.edges.filter((e: any) =>
      e?.type === 'CAUSAL' || e?.type === 'SUSPENSE'
    );
  }

  // Migration (Story 6.5, design §6): foreshadow_registry → promise_registry.
  // foreshadow 已退役（creativeFieldKeys / projectDocument 不再注册 foreshadow_registry，Phase A）；
  // 旧 project.yaml 持久化的 foreshadow_registry 会被下方 strict parse 判 corrupt → 整项目重建空
  // （interface-contracts convention「schema 破坏性收紧须配 loadProject 就地迁移」, 1.2/1.3 先例 :96-224）。
  // 就地 transform（纯代码机械映射，Phase A transformForeshadowToPromise）+ delete 旧 key，parse 前完成。
  // 零删数据：全 status 组合映射 + tags/relations/notes 保留（详 packages/shared-contracts/.../foreshadow-migration.ts）。
  //
  // E5 fix（CR-E5）：传 **raw shape** 给 transform，非 registry-level safeParse gate——transform 内已做
  // per-element safeParse 容错（单个坏 foreshadow 条目 console.warn + 跳过，好条目正常迁移，mirror CR-4.1-07
  // story_decisions per-element 先例）。旧 registry-level foreshadowRegistrySchema.safeParse 会让 1 坏条目致
  // 整 registry safeParse 失败 → 不调 transform → 跳过 + delete（丢全 registry 好数据）。transform 输入 envelope
  // 容错（ForeshadowMigrationInput：items 非数组视作空，version/updatedBy 越界 fallback default），输出恒经
  // promiseRegistrySchema.parse 校验（合法 PromiseRegistry，Phase A 保证）。graceful：无 foreshadow_registry
  // 条件跳过；已有 promise_registry 不覆盖（保手填/已迁移，design §6）。
  if (parsed.foreshadow_registry) {
    if (!parsed.promise_registry) {
      parsed.promise_registry = transformForeshadowToPromise(
        parsed.foreshadow_registry as ForeshadowMigrationInput,
      );
    }
    // 无论如何 delete 已退役的 foreshadow_registry（留在 parsed 会被 strict parse 判 corrupt）。
    delete parsed.foreshadow_registry;
  }

  // Migration（C1 真机遍历修复批，2026-08-27）：meta.created_at/updated_at 时间戳格式归一化。
  // 外部工具离线手术（python PyYAML dump，见 Ra/Rb 数据恢复通道）产出的 YAML1.1 空格分隔
  // timestamp（如 `2026-08-27 13:25:37.123456+00:00`）不满足 schema 的 z.string().datetime()
  // （ISO-T + Z），strict parse 会拒收**整份文档** → backupCorruptFile 静默隔离 + 空项目重建
  // （真实事故：08-27 手术后冷启全项目被判腐）。interface-contracts convention「schema 收紧须配
  // loadProject 就地迁移」+ 上方 foreshadow / 1.2 visibility 迁移同款先例：仅对这两键做机械字符串
  // 归一（不走 new Date 往返——非标准格式的 Date 解析是实现定义行为且有信息损失风险）；已是合法
  // ISO-T 或其他无法识别的形态原样保留，交由 strict parse 判定。
  if (parsed.meta && typeof parsed.meta === 'object') {
    const meta = parsed.meta as Record<string, unknown>;
    for (const key of ['created_at', 'updated_at'] as const) {
      meta[key] = normalizeMetaTimestamp(meta[key]);
    }
  }

  try {
    const document = projectDocumentSchema.parse(parsed);
    // 判腐后仍救回文档（YAML 前缀抢救 + schema 通过）→ recovered 翻 true。
    return { document, quarantined: quarantined ? { ...quarantined, recovered: true } : null };
  } catch (e) {
    // Structurally invalid (e.g. a salvaged prefix we couldn't repair, or YAML
    // that parsed but doesn't match the schema). Set the bad file aside and let
    // the caller bootstrap rather than wedge every save path.
    // C1 遍历修复批：判腐前留诊断凭据（此前零 log，错误环空白无从定位拒因——本函数静默
    // 隔离比可见崩溃更难发现）。行为不变：仍 backupCorruptFile + null。
    console.warn(
      '[loadProject] schema reject — quarantining',
      e instanceof Error ? e.message : e,
      filePath,
    );
    // 抢救路径（YAML.parse catch）此前已改过名——这里 backupCorruptFile 对不存在路径返回
    // null，沿用先前的备份路径，避免通知里出现「已备份至 null」。
    const backupPath = backupCorruptFile(filePath) ?? quarantined?.backupPath ?? null;
    return {
      document: null,
      quarantined: {
        backupPath,
        reason: e instanceof Error ? e.message : String(e),
        recovered: false,
      },
    };
  }
}

/**
 * 旧接口薄包装（既有调用方零改动）：只取 document。
 * 需要判腐事实的消费方（shell IPC → 通知中心）走 {@link loadProjectWithQuarantine}。
 */
export function loadProject(projectPath: string): ProjectDocument | null {
  return loadProjectWithQuarantine(projectPath).document;
}

// YAML1.1 / PyYAML dump 形态的空格分隔时间戳：`YYYY-MM-DD HH:MM:SS(.fraction)?(+00:00|Z)?`
// 归一到 ISO-T（毫秒截到 3 位、+00:00/Z→Z、无时区视为 UTC 补 Z）。非匹配值原样返回
// （交由 schema 判腐；真垃圾不该被这里洗白）。
const PYAML_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?: ?(?:\+00:00|Z))?$/;

function normalizeMetaTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = PYAML_TIMESTAMP_RE.exec(value);
  if (!m) return value;
  const [, date, time, frac] = m;
  const ms = frac === undefined ? '' : frac.padEnd(3, '0').slice(0, 3);
  return `${date}T${time}${ms ? `.${ms}` : ''}Z`;
}

/**
 * Recover a project document from corrupt YAML bytes: salvage the largest valid
 * prefix, move the bad file aside (preserved as a `.corrupt-*` backup), and
 * backfill any required meta fields the corruption truncated so the salvaged
 * data survives schema validation instead of being discarded.
 *
 * Returns the salvaged object (null when nothing parses — the caller's
 * bootstrap then rebuilds from project.json / directory name) plus the backup
 * path from the quarantine rename (quarantine-notify: 透出给上层通知)。
 */
function recoverCorruptProject(filePath: string, raw: string): {
  salvaged: Record<string, any> | null;
  backupPath: string | null;
} {
  const salvaged = salvageYamlPrefix(raw);
  const backupPath = backupCorruptFile(filePath);
  if (!salvaged) return { salvaged: null, backupPath };
  repairMetaDefaults(salvaged);
  return { salvaged, backupPath };
}

/**
 * Backfill the required meta/storyboard fields a corrupt-tail split may have
 * dropped from an otherwise-valid prefix. Only fills what's missing — real
 * salvaged values (name, ids, version) are never overwritten.
 */
function repairMetaDefaults(doc: Record<string, any>): void {
  const now = new Date().toISOString();
  if (!doc.meta || typeof doc.meta !== 'object') doc.meta = {};
  const m = doc.meta;
  if (typeof m.id !== 'string' || !m.id) m.id = crypto.randomUUID();
  if (typeof m.name !== 'string' || !m.name) m.name = 'Untitled';
  if (m.type !== 'script' && m.type !== 'novel') m.type = 'novel';
  if (typeof m.version !== 'number') m.version = 0;
  if (typeof m.created_at !== 'string') m.created_at = now;
  if (typeof m.updated_at !== 'string') m.updated_at = now;
  if (!doc.storyboard || typeof doc.storyboard !== 'object') doc.storyboard = { shots: [] };
  if (!Array.isArray(doc.storyboard.shots)) doc.storyboard.shots = [];
}

const LEGACY_META_FILE = 'project.json';

/** 旧 project.json 里可收敛到 project.yaml meta 的字段（与 projectMetaSchema 对齐）。 */
const META_STRING_FIELDS = ['logline', 'synopsis', 'genre', 'theme', 'writing_style', 'tone'] as const;

/** 从旧 project.json 读出可收敛进 yaml meta 的字段（含 coverImage→cover_image、projectId→project_id）。 */
function readLegacyMeta(projectPath: string): { name?: string; type?: 'novel' | 'script'; extra: Record<string, string> } {
  const result: { name?: string; type?: 'novel' | 'script'; extra: Record<string, string> } = { extra: {} };
  try {
    const metaPath = path.join(projectPath, LEGACY_META_FILE);
    if (!existsSync(metaPath)) return result;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    if (typeof meta.name === 'string' && meta.name.trim()) result.name = meta.name;
    if (meta.type === 'script' || meta.type === 'novel') result.type = meta.type;
    for (const key of META_STRING_FIELDS) {
      const v = meta[key];
      if (typeof v === 'string' && v.trim()) result.extra[key] = v;
    }
    if (typeof meta.coverImage === 'string' && meta.coverImage.trim()) result.extra.cover_image = meta.coverImage;
    if (typeof meta.projectId === 'string' && meta.projectId.trim()) result.extra.project_id = meta.projectId;
  } catch {
    // 读不出/损坏的 project.json 当作不存在处理，用目录名兜底。
  }
  return result;
}

/**
 * 内存构造一个 project.yaml 文档：优先读旧 project.json 的全部 meta 字段，缺失则目录名兜底。
 * 不落盘、不删 json——是否落盘/迁移由调用方决定（迁移走 {@link migrateLegacyProjectJson}）。
 */
export function bootstrapProjectFromMeta(projectPath: string): ProjectDocument {
  const legacy = readLegacyMeta(projectPath);
  const name = legacy.name ?? path.basename(projectPath);
  const type = legacy.type ?? 'novel';
  return createEmptyProjectDocument(name, type, legacy.extra);
}

/**
 * 把旧 project.json 一次性迁移进 project.yaml，然后删除 json。
 *
 * - 已有合法 project.yaml：仅在 yaml 缺少 json 携带的 meta 字段时回填补齐，随后删 json。
 * - 无 project.yaml：从 json（或目录名兜底）重建一个完整文档写盘，随后删 json。
 * - 无 project.json：直接返回现有 yaml（可能为 null），不做任何写删。
 *
 * 删除前确保 yaml 已成功 atomicWrite 落盘；写失败则不删，避免数据丢失。
 * 返回迁移后的文档（无 json 且无 yaml 时返回 null）。
 */
export function migrateLegacyProjectJsonWithQuarantine(projectPath: string): ProjectLoadResult {
  const legacyPath = path.join(projectPath, LEGACY_META_FILE);
  if (!existsSync(legacyPath)) return loadProjectWithQuarantine(projectPath);

  const legacy = readLegacyMeta(projectPath);
  const loaded = loadProjectWithQuarantine(projectPath);

  const doc = (loaded.document
    ? structuredClone(loaded.document)
    : createEmptyProjectDocument(legacy.name ?? path.basename(projectPath), legacy.type ?? 'novel')) as Record<string, any>;

  // 只补缺：yaml 已有的字段不被 json 覆盖（yaml 是新真相源）。
  if (!doc.meta.name && legacy.name) doc.meta.name = legacy.name;
  if (legacy.type && loaded.document == null) doc.meta.type = legacy.type;
  for (const [key, value] of Object.entries(legacy.extra)) {
    if (doc.meta[key] === undefined) doc.meta[key] = value;
  }

  const validated = projectDocumentSchema.parse(doc);
  saveProject(projectPath, validated); // atomicWrite：成功后才删 json
  try {
    unlinkSync(legacyPath);
  } catch {
    // 删不掉（占用/权限）不阻断：yaml 已是真相源，残留 json 下次再试。
  }
  // 隔离事实原样透传：json 重建出的文档不是 yaml 自身数据救回，recovered 不翻 true。
  return { document: validated, quarantined: loaded.quarantined };
}

/**
 * 旧接口薄包装（既有调用方零改动）：只取 document。
 * 需要判腐事实的消费方走 {@link migrateLegacyProjectJsonWithQuarantine}。
 */
export function migrateLegacyProjectJson(projectPath: string): ProjectDocument | null {
  return migrateLegacyProjectJsonWithQuarantine(projectPath).document;
}

export type FieldSkip = { field: string; reason: string };

export function applyFieldPatchesWithSkipped(
  projectPath: string,
  fieldPatch: ProjectFieldPatch
): { applied: ProjectDocument; skipped: FieldSkip[] } {
  const project = loadProject(projectPath);
  if (!project) {
    throw new Error(`Project not found at ${projectPath}`);
  }

  const next = structuredClone(project) as Record<string, any>;

  // CR-4.1-04：收集 chapter_candidate core null 错误（章未注册 / 无 section）。原姿态 `continue` 静默
  // skip + loop-end 仍 meta.version bump + saveProject，使 applyAgentFieldPatch IPC 正常 resolve →
  // UI creativeFieldsSlice.applySelectedPatches 的 .catch 不触发 → **无 toast 丢稿**（与 standalone
  // acceptChapterCandidate throw 不一致）。现收集错误 loop-end throw：applyAgentFieldPatch IPC reject
  // → creativeFieldsSlice .catch → useToastStore.showToast「chapter_candidate：章未注册或无 section」。
  // 同 batch 内有效 candidate 仍照常落盘（md + novel meta），仅失败项报错（多 candidate batch 不互丢）。
  const chapterCandidateErrors: string[] = [];
  // Story 2.6：收集 story_decisions 重放失败（守卫拒 / schema 拒）--mirror chapterCandidateErrors：
  // loop-end throw 使 applyAgentFieldPatch IPC reject -> UI creativeFieldsSlice .catch -> toast。
  const storyDecisionErrors: string[] = [];
  // Story 3.1: collect locked-field skips (was a silent `continue`). Surfaced via
  // the return so the caller (IPC → leader) can tell the author/agent which
  // proposed patches were dropped due to locks (design WP5 asymmetry fix).
  const skipped: FieldSkip[] = [];
  // Story 3.4（C-A5 footgun 修）：跟踪本 batch 成功 apply 的 creative field，loop 后对称标下游
  // stale（mirror fieldSyncBridge.onFieldEdited 的 markStaleFields 用法）。此前本函数 creative 分支
  // 写字段 + 清自身 stale（stale:false）但不标下游 → propagation 断（field:apply-agent-patch 路径
  // 与 field:sync 路径行为不对称）。收集成功 apply 的 field，loop 后统一算 affected 下游标 stale。
  const appliedCreativeFields: CreativeFieldKey[] = [];

  const FIELD_TO_KEY: Record<CreativeFieldKey, string> = {
    creative_brief: 'creative_brief',
    world_setting: 'world_setting',
    outline: 'outline_v2',
    episode_outlines: 'episode_outlines',
    growth_curve: 'growth_curve',
    pacing_curve: 'pacing_curve',
    emotion_curve: 'emotion_curve',
    asset_cards: 'asset_cards',
    relationship_graph: 'relationship_graph',
    promise_registry: 'promise_registry',
    info_release_map: 'info_release_map',
    scene_graph: 'scene_graph',
    // Story 8.2：写手弧节拍 creative field（strict Record typecheck 强制同步，interface-contracts 3b）。
    arc_registry: 'arc_registry',
    // Story 8.6：创作深度偏好（strict Record typecheck 强制同步，interface-contracts 3b）。
    creative_preferences: 'creative_preferences'
  };

  for (const patch of fieldPatch.patches) {
    // 'overview' patches target project meta (json + yaml), persisted by the
    // UI via syncProjectMeta — not a creative field in the project document.
    if ((patch.field as string) === 'overview') continue;

    // 特殊处理：chapter_candidate 补丁需要写入 markdown + 更新章节元数据
    // 4.1 Step 4：经 shared `acceptChapterCandidateCore`（DRY，与 acceptChapterCandidate standalone API 共用
    // 纯逻辑）。CR-4.1-04：core 返 null（章缺 / 无 sections[0]）不再静默 continue——收集结构化错误，
    // loop-end throw（applyAgentFieldPatch IPC reject → UI creativeFieldsSlice .catch → toast）。meta.version
    // bump 留给 loop-end（整批 patch 单次 bump，避免 double-count）。core 不 bump meta。
    if ((patch.field as string) === 'chapter_candidate') {
      const data = patch.data as any;
      if (data?.chapterId && data?.candidate) {
        const nowISO = new Date().toISOString();
        const result = acceptChapterCandidateCore({
          project: next as unknown as ChapterIntegrationProject,
          chapterId: data.chapterId,
          runId: data.runId ?? fieldPatch.runId,
          candidate: data.candidate,
          nowISO,
          storyDecisions: data.storyDecisions,
        });
        if (result) {
          // 写入 markdown 文件
          const mdPath = path.join(projectPath, result.mdPath);
          const mdDir = path.dirname(mdPath);
          if (!existsSync(mdDir)) {
            mkdirSync(mdDir, { recursive: true });
          }
          // #107 check 批补缝：candidate.content 是 draft 正文（无 frontmatter）——整体覆盖会把
          // 已注册章文件的 frontmatter `order:`（登记载体）物理抹掉 → 派生重排错位（CR-4.1-06
          // 族）。旧文件有 frontmatter 且新内容无 → 原样回拼（body-only 旧文件零行为变化）。
          // 规则单源见 shared-contracts preserveChapterFrontmatter（mirror novelProjectRepository
          // acceptChapterCandidate 同款）。
          const existingMd = existsSync(mdPath) ? decodeFileToUtf8(readFileSync(mdPath)) : null;
          atomicWriteFileSync(mdPath, preserveChapterFrontmatter(existingMd, result.mdContent), 'utf8');

          // core structuredClone 了 next 并 mutate；把 novel（含 chapter meta + story_decisions）投回 working doc。
          // meta 不抄（core 不 bump；loop-end 统一 bump），避免覆盖 next 其他 patch 的 meta 状态。
          (next as Record<string, any>).novel = (result.updatedProject as any).novel;
        } else {
          // CR-4.1-04：core null = 章未注册或无 section。收集错误（非静默 skip），loop-end throw 使
          // applyAgentFieldPatch IPC reject → UI creativeFieldsSlice .catch → toast。文案对齐 standalone
          // acceptChapterCandidate 的 throw 文案，保持两条路径错误语义一致。
          chapterCandidateErrors.push(
            `Chapter ${data.chapterId} not found or has no sections in project at ${projectPath}`,
          );
        }
      }
      continue;
    }

    // Story 2.6：story_decisions patch（创作决策 ADR 更新，register/supersede/drop）--data =
    // {actions:[...], force?} **重放语义**：对 fresh 列表应用（非 stale after 全量替换，2.2 CR-201
    // 教训），守卫单源 applyDecisionActions（与 auto 档 storyDecisionHandlers 直写共用同一套校验：
    // assertTransition 转换矩阵 / id 唯一 / user-source force 保护）。失败收集 loop-end throw
    // （mirror chapterCandidateErrors）；dangling warnings 在工具产 envelope 时已回 tool output，
    // accept 重放处不重复报（同数据同警告）。meta.version bump 留给 loop-end（整批单次 bump）。
    if ((patch.field as string) === 'story_decisions') {
      const data = patch.data as { actions?: unknown; force?: unknown } | undefined;
      if (Array.isArray(data?.actions) && data.actions.length > 0) {
        const parsedActions = storyDecisionActionSchema.array().safeParse(data.actions);
        if (!parsedActions.success) {
          storyDecisionErrors.push(`story_decisions actions schema 校验失败: ${parsedActions.error.message}`);
        } else {
          const novelRef = (next as Record<string, any>).novel;
          const current = (novelRef?.story_decisions ?? []) as StoryDecision[];
          const result = applyDecisionActions(current, parsedActions.data, {
            nowISO: new Date().toISOString(),
            force: data?.force === true,
          });
          if (!result.ok) {
            storyDecisionErrors.push(result.error);
          } else {
            const novel = novelRef ?? { chapters: [] };
            novel.story_decisions = result.next;
            (next as Record<string, any>).novel = novel;
          }
        }
      }
      continue;
    }

    const docKey = FIELD_TO_KEY[patch.field as CreativeFieldKey];
    if (!docKey) continue;

    // 跳过 locked 字段（Story 3.1：收集而非静默，回传调用方）
    if (next.field_metadata?.[patch.field as CreativeFieldKey]?.locked) {
      skipped.push({ field: String(patch.field), reason: 'locked' });
      continue;
    }

    // 跳过过期补丁：补丁基于的 fieldVersion 早于当前已记录版本，说明
    // 该字段在补丁生成后被更新过，应用它会覆盖更新的内容。对齐 story-sync
    // 的 enforcePatchSafety 语义。
    const currentVersion = next.field_metadata?.[patch.field as CreativeFieldKey]?.version;
    if (typeof currentVersion === 'number' && typeof patch.fieldVersion === 'number' && patch.fieldVersion < currentVersion) {
      continue;
    }

    switch (patch.action) {
      case 'set':
        next[docKey] = patch.data;
        break;
      case 'merge':
        if (Array.isArray(next[docKey]) && Array.isArray(patch.data)) {
          next[docKey] = [...next[docKey], ...patch.data];
        } else if (typeof next[docKey] === 'object' && typeof patch.data === 'object') {
          next[docKey] = { ...next[docKey], ...(patch.data as object) };
        } else {
          next[docKey] = patch.data;
        }
        break;
      case 'delete':
        delete next[docKey];
        break;
    }

    // 更新 field_metadata
    if (!next.field_metadata) next.field_metadata = {};
    next.field_metadata[patch.field as CreativeFieldKey] = {
      version: patch.fieldVersion,
      source: 'agent',
      locked: next.field_metadata[patch.field as CreativeFieldKey]?.locked ?? false,
      dependsOn: next.field_metadata[patch.field as CreativeFieldKey]?.dependsOn ?? [],
      stale: false
    };
    // Story 3.4（C-A5）：记录成功 apply 的 creative field，loop 后标下游 stale。
    appliedCreativeFields.push(patch.field as CreativeFieldKey);
  }

  // Story 3.4（C-A5 footgun 修）：对每个成功 apply 的 creative field 算 affected 下游并标 stale，
  // mirror fieldSyncBridge.onFieldEdited 的 markStaleFields 对称用法（onFieldEdited 对单字段编辑标
  // 下游 stale；本函数是 batch 版，对 batch 内每个 apply 的 field 都标）。此前 creative 分支只写
  // stale:false 不标下游 → agent patch 路径（field:apply-agent-patch IPC → applyFieldPatchesWithSkipped）
  // 与用户编辑路径（field:sync IPC → onFieldEdited）传播行为不对称，改 asset_cards 后 scene_graph
  // 等下游不被标 stale，消费端无候选。
  // 跳过同 batch 内也 apply 的下游 field（它们刚被写 stale:false，不应被上游的传播覆盖回 true）。
  const appliedSet = new Set(appliedCreativeFields);
  for (const appliedField of appliedCreativeFields) {
    const staleFields = markStaleFields([], appliedField);
    for (const sf of staleFields) {
      if (appliedSet.has(sf)) continue; // 同 batch 内刚 apply 的 field，不重标 stale
      if (!next.field_metadata) next.field_metadata = {};
      if (!next.field_metadata[sf]) {
        next.field_metadata[sf] = {
          version: 0,
          source: 'agent',
          locked: false,
          dependsOn: [],
          stale: true
        };
      } else {
        next.field_metadata[sf].stale = true;
      }
    }
  }

  next.meta.version += 1;
  next.meta.updated_at = new Date().toISOString();

  const validated = projectDocumentSchema.parse(next);
  saveProject(projectPath, validated);

  // CR-4.1-04：batch 内有 chapter_candidate 失败（core null）→ throw 使 applyAgentFieldPatch IPC reject
  // → UI creativeFieldsSlice.applySelectedPatches 的 .catch 开 toast（落地公理：正文静默丢 = bug）。
  // 此时有效 candidate（若有）的 md + novel meta 已上方落盘，仅失败项不被静默吞掉。standalone
  // acceptChapterCandidate（单 candidate throw）语义不变；本 batch 路径与其对齐到「显式失败」。
  if (chapterCandidateErrors.length > 0) {
    throw new Error(chapterCandidateErrors.join('; '));
  }

  // Story 2.6：story_decisions 重放失败（守卫拒 / schema 拒）-> throw（mirror 上方 chapterCandidate
  // 语义：IPC reject -> UI toast，决策不静默丢）。失败 batch 内其他有效 patch 已上方落盘。
  if (storyDecisionErrors.length > 0) {
    throw new Error(storyDecisionErrors.join('; '));
  }

  return { applied: validated, skipped };
}

/**
 * Story 3.1: back-compat wrapper. Existing callers (tests, UI creativeFieldsSlice
 * via the field:sync path) keep getting the applied ProjectDocument. The IPC
 * handler (field:apply-agent-patch) uses applyFieldPatchesWithSkipped to also
 * surface locked-field skips so the UI can tell the author a proposed patch was
 * dropped (design WP5 asymmetry fix).
 */
export function applyFieldPatches(
  projectPath: string,
  fieldPatch: ProjectFieldPatch,
): ProjectDocument {
  return applyFieldPatchesWithSkipped(projectPath, fieldPatch).applied;
}
