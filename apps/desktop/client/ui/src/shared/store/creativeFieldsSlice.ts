import type { StateCreator } from 'zustand';
import type { z } from 'zod';
import type {
  CreativeFieldKey,
  fieldMetadataSchema,
  projectFieldPatchSchema,
  projectDocumentSchema
} from '@orison/shared-contracts';
import {
  creativeFieldKeys,
  sceneGraphSchema,
  validateSceneGraph,
  type FieldPatchEntry,
  type SceneArtOverride,
  type SceneGraph,
  type SceneGraphIssue
} from '@orison/shared-contracts';
import type { ProjectMeta } from './types';
import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';
import { registerProjectReset } from './resetRegistry';
import { getSessionProject } from './agentEvents';
// CR-25：agent 落盘高亮的 diff 触发点移入本 slice。两个引用均为 features/structure
// 的纯叶子模块（零 store/react 依赖——同 chapterReviewSlice 引 features/editor 类型
// 的跨向先例），不构成环。
import { isSceneGraphLike } from '../../features/structure/layout';
import { diffAddedNodeIds } from '../../features/structure/sceneGraphEditModel';

/** Surface a field-sync failure instead of swallowing it (was `.catch(()=>{})`). */
function reportSyncFailure(locale: string, field: CreativeFieldKey, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  useToastStore.getState().showToast(translate(locale, 'creative.field.syncFailed', { field, reason }), 'error');
}

type FieldMetadata = z.infer<typeof fieldMetadataSchema>;
type ProjectFieldPatch = z.infer<typeof projectFieldPatchSchema>;
type ProjectDocument = z.infer<typeof projectDocumentSchema>;

/**
 * Story 1.3 art-mode override (design §5): build art_overrides additions for the
 * error-severity validation issues a user accepted despite (accept-with-error =
 * author override entry, minimal UI change). Dedupes against existing overrides
 * by `${check}:${target-signature}` so repeated accepts don't grow the array.
 *
 * CR-012: scope = 整 target 集合的稳定签名（sorted unique target ids join），非首个
 * target.id。applyArtOverrides 据此按 target 集合实例级匹配（issue.targets ⊆
 * override.scope 所标识集合），override 一个 issue 不再连带静音结构不同但共享某 node
 * 的同 code issue（如两个共享一个节点的不同因果环）。Warnings/info 不 block，只 error
 * 成 override。
 */
function issueTargetSignature(issue: SceneGraphIssue): string {
  return [...new Set(issue.targets.map((t) => t.id))].sort().join(',');
}

function buildArtOverridesForErrors(
  issues: SceneGraphIssue[],
  existing: SceneArtOverride[]
): SceneArtOverride[] {
  const have = new Set(existing.map((o) => `${o.check}:${o.scope ?? '*'}`));
  const additions: SceneArtOverride[] = [];
  for (const issue of issues) {
    if (issue.severity !== 'error') continue;
    const scope = issueTargetSignature(issue);
    const key = `${issue.code}:${scope || '*'}`;
    if (have.has(key)) continue;
    have.add(key);
    additions.push({
      check: issue.code,
      ...(scope ? { scope } : {}),
      reason: 'accept-with-error override'
    });
  }
  return additions;
}

/**
 * CR-4.1-05：same-run merge 的 patch dedup key。chapter_candidate patch 携带独立 `data.chapterId`
 * （chapterCandidatePatchSchema）——leader 同 run 连调两次 write_chapter（两章）产两条
 * field='chapter_candidate' patch，是**两份独立产出**非「同字段修订」；若按 field 名 dedup 后者会
 * 覆盖前者，第一章正文静默丢。故 chapter_candidate 按 `(field, chapterId)` 复合键各自保留；同
 * chapterId 重发仍后者覆盖（保持原「latest LLM intent 胜」语义）。其余 field 按 field 名 dedup
 * （CR-013 原语义）。chapter_candidate data 非法缺 chapterId 时退化为 field 名键（防御，不阻断流）。
 */
function patchDedupKey(entry: FieldPatchEntry): string {
  if ((entry.field as string) === 'chapter_candidate') {
    const chapterId = (entry.data as { chapterId?: unknown } | null)?.chapterId;
    return typeof chapterId === 'string' && chapterId
      ? `${entry.field}::${chapterId}`
      : entry.field;
  }
  return entry.field;
}

/**
 * dogfood T1 Stage 3（design §5.3 / r8）：pendingPatch 三件套（patch + selections + issues）
 * per-session 键控——per-session state 对象包一层（同 slice 既有风格：三字段一体生灭，
 * 键控后不合不自洽）。PatchReviewPanel 只渲染当前视图会话的键；后台会话的 patch 留存
 * = 徽标 awaiting_review 数据源 + 切回再现。
 */
export type PendingPatchEntry = {
  patch: ProjectFieldPatch;
  selections: Record<string, boolean>;
  issues: SceneGraphIssue[];
};

/**
 * dogfood R2 批次 D1（详设 OE-5）：大纲页 one-shot 跳转定位目标。发起方 = PatchReviewPanel
 * 接受落盘后 toast「到大纲面板查看」；消费者 = OutlineEditor（scrollIntoView + 2s pulse 后
 * clear）。mirror focusIssueTargets（structureSlice）/ FileRevealRequest（fileTabsSlice）双
 * one-shot 先例。project-scoped（跨项目跳转无意义），随 registerProjectReset 清空。
 */
export type OutlineFocusTarget = {
  section: 'phase' | 'turningPoints' | 'core';
  /** section='phase' 时的目标卷 id（对应 outline_v2.phases[].id，锚点 outline-anchor-phase-{id}）。 */
  id?: string;
};

/**
 * dogfood R2 批次 D2（CR-25）：applySelectedPatches 接受 scene_graph patch 时 diff
 * 改前/改后 node id 集存下的**待消费新增节点高亮集**。消费者 = StructurePage（挂载/
 * 更新时 consume → structureSlice.highlightNodeIds 绿框脉冲，TTL 3s 在彼处）。写方在
 * 本 slice 是因为用户常在他页（chat PatchReviewPanel）接受 patch——触发点挂在结构页
 * 挂载域 effect 时，等切回结构页 diff 恒空，绿脉冲主流程不可达。mirror outlineFocusTarget
 * one-shot 先例；project-scoped（跨项目高亮无意义），随 registerProjectReset 清空。
 */
export type PendingStructureHighlight = string[];

export type CreativeFieldsSlice = {
  creativeFields: Partial<Record<CreativeFieldKey, unknown>>;
  fieldMetadata: Partial<Record<CreativeFieldKey, FieldMetadata>>;
  activeCreativeTab: CreativeFieldKey;
  pendingPatchBySession: Record<string, PendingPatchEntry | undefined>;
  fieldUndoStack: Array<{ field: CreativeFieldKey; data: unknown }>;
  fieldRedoStack: Array<{ field: CreativeFieldKey; data: unknown }>;
  outlineFocusTarget: OutlineFocusTarget | null;
  pendingStructureHighlight: PendingStructureHighlight;

  setActiveCreativeTab: (tab: CreativeFieldKey) => void;
  loadCreativeFields: (doc: ProjectDocument) => void;
  updateField: (field: CreativeFieldKey, data: unknown) => void;
  undoField: () => void;
  redoField: () => void;
  canUndoField: () => boolean;
  canRedoField: () => boolean;
  toggleFieldLock: (field: CreativeFieldKey) => void;
  /** sessionId = 挂起 patch 的属主会话（事件路由层 / resume 路由传入）。null = 清该会话。 */
  setPendingPatch: (sessionId: string, patch: ProjectFieldPatch | null) => void;
  /** 清某会话的挂起 patch 键（deleteAgentSession 用）。 */
  clearPendingPatchFor: (sessionId: string) => void;
  /** W4（D-g 切分）：尾参 sessionId?——写作页产物区按链会话挂载 chapter_candidate 审阅时传目标会话（缺省 = 视图会话）。 */
  togglePatchSelection: (field: string, sessionId?: string) => void;
  /**
   * W4（D-g 切分）：尾参 sessionId?（同上）+ excludeFields?——对话栏过滤挂载（chapter_candidate
   * 不渲染全尺寸卡）传排除集：隐藏的 chapter_candidate 不随「Apply Selected」静默落盘（把关面
   * 看不到内容不应用），且**继续挂起**（重 stage 进原键——写作页产物区审阅落盘，不清丢）。
   */
  applySelectedPatches: (sessionId?: string, excludeFields?: string[]) => ProjectFieldPatch | null;
  /** 写入 one-shot 跳转目标（null 等价清空）。 */
  setOutlineFocusTarget: (target: OutlineFocusTarget | null) => void;
  /** 消费后清空（幂等——OutlineEditor effect 清费，StrictMode 双跑无害）。 */
  clearOutlineFocusTarget: () => void;
  /**
   * 原子消费待消费结构高亮集：取走当前集并清空（CR-25）。空集调用为 no-op——
   * StrictMode 双跑/重复 effect 第二次拿到 []，天然幂等。
   */
  consumePendingStructureHighlight: () => string[];
};

const DEFAULT_METADATA: FieldMetadata = {
  version: 0,
  source: 'user',
  locked: false,
  dependsOn: [],
  stale: false
};

export const createCreativeFieldsSlice: StateCreator<
  CreativeFieldsSlice & {
    currentProject: ProjectMeta | null;
    saveProject: () => Promise<void>;
    agentSessionId: string | null;
  },
  [],
  [],
  CreativeFieldsSlice
> = (set, get) => {
  // Creative fields + their metadata belong to the current project. Clear them
  // on switch; projectSubscription re-hydrates from the new project's
  // project.yaml. dogfood T1 Stage 3：pendingPatch 键控后按会话归属过滤（agentEvents
  // sessionId→projectPath 映射）——只清不属于当前（新）项目的键。
  registerProjectReset(() => {
    // dogfood T1 CR-T1-025：pendingPatchBySession 是「等待用户」挂起键——按定义不再产事件，
    // 项目重置销毁 = 切回后 PatchReviewPanel 永久丢（run 产 patch 后死等人）。改「按 owner
    // 归属保留」（有归属跨项目存活，mirror agentRunStates；渲染面按 sessionId 键控隔离），
    // 仅清无归属残键。creativeFields/fieldMetadata/undo-redo 是**当前项目加载态**照旧全清。
    const nextPending: Record<string, PendingPatchEntry | undefined> = {};
    for (const sid of Object.keys(get().pendingPatchBySession)) {
      if (getSessionProject(sid) !== undefined) nextPending[sid] = get().pendingPatchBySession[sid];
    }
    set({ creativeFields: {}, fieldMetadata: {}, pendingPatchBySession: nextPending, fieldUndoStack: [], fieldRedoStack: [], outlineFocusTarget: null, pendingStructureHighlight: [] });
  });

  return {
  creativeFields: {},
  fieldMetadata: {},
  activeCreativeTab: 'world_setting',
  pendingPatchBySession: {},
  fieldUndoStack: [],
  fieldRedoStack: [],
  outlineFocusTarget: null,
  pendingStructureHighlight: [],

  setActiveCreativeTab: (tab) => set({ activeCreativeTab: tab }),

  loadCreativeFields: (doc) => {
    const fields: Partial<Record<CreativeFieldKey, unknown>> = {};
    for (const key of creativeFieldKeys) {
      // Map creative field key 'outline' → document key 'outline_v2'.
      // The old 'outline' schema in projectDocumentSchema is deprecated;
      // all new data uses outline_v2. See project.ts for details.
      const docKey = key === 'outline' ? 'outline_v2' : key;
      const value = (doc as Record<string, unknown>)[docKey];
      if (value !== undefined) {
        fields[key] = value;
      }
    }
    set({
      creativeFields: fields,
      fieldMetadata: doc.field_metadata ?? {}
    });
  },

  updateField: (field, data) => {
    const { creativeFields, fieldMetadata, fieldUndoStack, currentProject } = get();
    const previousData = creativeFields[field];
    const meta = fieldMetadata[field] ?? { ...DEFAULT_METADATA };
    set({
      creativeFields: { ...creativeFields, [field]: data },
      fieldMetadata: {
        ...fieldMetadata,
        [field]: { ...meta, version: meta.version + 1, source: 'user', stale: false }
      },
      fieldUndoStack: [...fieldUndoStack.slice(-29), { field, data: previousData }],
      fieldRedoStack: [],
    });
    if (currentProject?.path && window.orisonDesktop?.syncField) {
      const locale = (get() as any).resolvedLocale ?? 'en-US';
      window.orisonDesktop.syncField(currentProject.path, field, data).catch((err) => reportSyncFailure(locale, field, err));
    }
  },

  undoField: () => {
    const { fieldUndoStack, fieldRedoStack, creativeFields, fieldMetadata, currentProject } = get();
    if (fieldUndoStack.length === 0) return;
    const entry = fieldUndoStack[fieldUndoStack.length - 1];
    const currentData = creativeFields[entry.field];
    const meta = fieldMetadata[entry.field] ?? { ...DEFAULT_METADATA };
    set({
      creativeFields: { ...creativeFields, [entry.field]: entry.data },
      fieldMetadata: {
        ...fieldMetadata,
        [entry.field]: { ...meta, version: meta.version + 1, source: 'user', stale: false }
      },
      fieldUndoStack: fieldUndoStack.slice(0, -1),
      fieldRedoStack: [...fieldRedoStack, { field: entry.field, data: currentData }],
    });
    if (currentProject?.path && window.orisonDesktop?.syncField) {
      const locale = (get() as any).resolvedLocale ?? 'en-US';
      window.orisonDesktop.syncField(currentProject.path, entry.field, entry.data).catch((err) => reportSyncFailure(locale, entry.field, err));
    }
  },

  redoField: () => {
    const { fieldUndoStack, fieldRedoStack, creativeFields, fieldMetadata, currentProject } = get();
    if (fieldRedoStack.length === 0) return;
    const entry = fieldRedoStack[fieldRedoStack.length - 1];
    const currentData = creativeFields[entry.field];
    const meta = fieldMetadata[entry.field] ?? { ...DEFAULT_METADATA };
    set({
      creativeFields: { ...creativeFields, [entry.field]: entry.data },
      fieldMetadata: {
        ...fieldMetadata,
        [entry.field]: { ...meta, version: meta.version + 1, source: 'user', stale: false }
      },
      fieldUndoStack: [...fieldUndoStack, { field: entry.field, data: currentData }],
      fieldRedoStack: fieldRedoStack.slice(0, -1),
    });
    if (currentProject?.path && window.orisonDesktop?.syncField) {
      const locale = (get() as any).resolvedLocale ?? 'en-US';
      window.orisonDesktop.syncField(currentProject.path, entry.field, entry.data).catch((err) => reportSyncFailure(locale, entry.field, err));
    }
  },

  canUndoField: () => get().fieldUndoStack.length > 0,
  canRedoField: () => get().fieldRedoStack.length > 0,

  toggleFieldLock: (field) => {
    // Story 3.1 WP5: optimistic store flip + persist via the lock-toggle IPC.
    // (no version bump / no stale — fieldSyncBridge.toggleFieldLock only flips
    // field_metadata[field].locked.)
    // CR-workbench-interaction-core-001: rollback the optimistic flip on IPC
    // failure, and DON'T flip when no preload/project means nothing persists —
    // otherwise store shows locked while disk stays unlocked, and the next agent
    // patch overwrites the field the author believes is locked (defeats WP5).
    const { fieldMetadata, currentProject } = get();
    if (!currentProject?.path || !window.orisonDesktop?.toggleFieldLock) {
      return; // nothing persists — flipping the store would desync from disk.
    }
    const meta = fieldMetadata[field] ?? { ...DEFAULT_METADATA };
    const prevLocked = meta.locked;
    set({
      fieldMetadata: {
        ...fieldMetadata,
        [field]: { ...meta, locked: !prevLocked }
      }
    });
    const locale = (get() as any).resolvedLocale ?? 'en-US';
    window.orisonDesktop.toggleFieldLock(currentProject.path, field).catch((err) => {
      // Rollback the optimistic flip so the store matches disk.
      const cur = get().fieldMetadata[field] ?? { ...DEFAULT_METADATA };
      set({
        fieldMetadata: {
          ...get().fieldMetadata,
          [field]: { ...cur, locked: prevLocked }
        }
      });
      reportSyncFailure(locale, field, err);
    });
  },

  setPendingPatch: (sessionId, patch) => {
    if (!patch) {
      set((s) => {
        if (!(sessionId in s.pendingPatchBySession)) return s;
        const next = { ...s.pendingPatchBySession };
        delete next[sessionId];
        return { pendingPatchBySession: next };
      });
      return;
    }
    const existingEntry = get().pendingPatchBySession[sessionId];
    const existing = existingEntry?.patch;
    const sameRun = existing?.runId === patch.runId;
    // CR-013: merge by field with any pending patch from the same run so a
    // multi-turn / multi-batch LLM run (e.g. outline_update then scene_graph_update
    // in two tool-result batches) doesn't drop the prior batch's patch. Same field
    // -> new entry wins (latest LLM intent); different field -> both kept. A
    // different run supersedes (replace). Honors the agentSessionSlice comment
    // "merge with any pending patch from a prior batch in this run" (the old code
    // claimed merge but replaced, dropping outline when scene_graph arrived after).
    //
    // CR-4.1-05：dedup key 经 `patchDedupKey` 计算——chapter_candidate 按 `(field, chapterId)` 复合键，
    // 使同 run 内多条不同 chapterId 的 chapter_candidate patch 各自保留（leader 连写两章不让第一章
    // 正文静默丢）。同 chapterId 重发仍后者覆盖（latest LLM intent），其余 field 按 field 名 dedup。
    const byField = new Map<string, FieldPatchEntry>();
    if (sameRun && existing) {
      for (const e of existing.patches) byField.set(patchDedupKey(e), e);
    }
    for (const e of patch.patches) byField.set(patchDedupKey(e), e);
    const mergedPatches = [...byField.values()];
    const mergedPatch: ProjectFieldPatch = {
      runId: sameRun && existing ? existing.runId : patch.runId,
      createdAt: sameRun && existing ? existing.createdAt : patch.createdAt,
      patches: mergedPatches,
    };

    // Preserve user toggles for fields still present when merging same-run; new
    // fields (and a brand-new run) default to selected.
    const prevSelections = sameRun ? existingEntry?.selections ?? {} : {};
    const selections: Record<string, boolean> = {};
    for (const entry of mergedPatches) {
      selections[entry.field] = prevSelections[entry.field] ?? true;
    }

    // Story 1.3 validation data channel (design §4): run validateSceneGraph on
    // the staged scene_graph patch. Re-validate on merge so a new scene_graph
    // batch updates issues against the latest staged graph. The shell handler
    // already projected the bounded actions onto the current graph, so entry.data
    // IS the staged graph. Issues are stored for 1.5 Timeline flag / Epic 3 工作台
    // chat consumption; this story does NOT surface them in UI (data channel only).
    // Malformed graph data falls back to no issues (patch-review still applies the data).
    const issues: SceneGraphIssue[] = [];
    for (const entry of mergedPatches) {
      if (entry.field !== 'scene_graph') continue;
      if (entry.action === 'delete') continue;
      try {
        issues.push(...validateSceneGraph(sceneGraphSchema.parse(entry.data)));
      } catch (err) {
        // Defense-in-depth (shell handler validates projection, so this should
        // never fire): a malformed staged graph can't be validated - log so the
        // silent-data-loss trap (invalid patch -> persist -> loadProject corrupt)
        // is observable, not swallowed. Data channel stays empty for this entry.
        console.warn('[creativeFields] scene_graph patch failed schema parse; validation skipped', err);
      }
    }
    set({
      pendingPatchBySession: {
        ...get().pendingPatchBySession,
        [sessionId]: { patch: mergedPatch, selections, issues },
      },
    });
  },

  clearPendingPatchFor: (sessionId) => set((s) => {
    if (!(sessionId in s.pendingPatchBySession)) return s;
    const next = { ...s.pendingPatchBySession };
    delete next[sessionId];
    return { pendingPatchBySession: next };
  }),

  togglePatchSelection: (field, sessionId) => {
    // 视图会话作用域（PatchReviewPanel 只渲染视图会话的键，toggle 从面板发出）。
    // W4（D-g 切分）：尾参 sessionId?——写作页产物区挂载时按目标会话键控 toggle。
    const sid = sessionId ?? get().agentSessionId;
    if (!sid) return;
    const entry = get().pendingPatchBySession[sid];
    if (!entry) return;
    set({
      pendingPatchBySession: {
        ...get().pendingPatchBySession,
        [sid]: {
          ...entry,
          selections: { ...entry.selections, [field]: !entry.selections[field] },
        },
      },
    });
  },

  // ── dogfood R2 批次 D1（OE-5）：one-shot 跳转定位通道（纯 additive，不碰 undo/apply 区；
  // mirror focusIssueTargets 先例：写方 set，消费方 OutlineEditor 用后 clear）。──
  setOutlineFocusTarget: (target) => set({ outlineFocusTarget: target }),

  clearOutlineFocusTarget: () => set((s) => (s.outlineFocusTarget === null ? s : { outlineFocusTarget: null })),

  // ── dogfood R2 批次 D2（CR-25）：待消费结构高亮集（写方在下方 applySelectedPatches）──
  consumePendingStructureHighlight: () => {
    const cur = get().pendingStructureHighlight;
    if (cur.length === 0) return [];
    set({ pendingStructureHighlight: [] });
    return cur;
  },

  applySelectedPatches: (sessionIdParam, excludeFields) => {
    // 视图会话作用域（PatchReviewPanel accept 从面板发出，owner 恒 = agentSessionId）。
    // W4（D-g 切分）：尾参 sessionId?（写作页产物区按链会话挂载）+ excludeFields?（对话栏
    // 过滤挂载排除 chapter_candidate——隐藏 patch 不静默落盘且继续挂起供写作页审阅）。
    const sessionId = sessionIdParam ?? get().agentSessionId;
    const entry = sessionId ? get().pendingPatchBySession[sessionId] : undefined;
    if (!entry || !sessionId) return null;
    const { patch: pendingPatch, selections: patchSelections, issues: pendingPatchIssues } = entry;
    const { creativeFields, fieldMetadata, fieldUndoStack, currentProject } = get();

    const clearPending = () => set((s) => {
      if (!(sessionId in s.pendingPatchBySession)) return s;
      const next = { ...s.pendingPatchBySession };
      delete next[sessionId];
      return { pendingPatchBySession: next };
    });

    // W4（D-g 切分）：被排除的 patch（对话栏过滤隐藏的 chapter_candidate——链产物）不随本批
    // 落盘清场——重 stage 进原键继续挂起（写作页产物区审阅落盘，防静默清丢），selections
    // 重置默认选中；排除集空 = 全批语义照旧清键。
    const excludedPatches = excludeFields
      ? pendingPatch.patches.filter((p) => excludeFields.includes(p.field as string))
      : [];
    const settlePending = () => {
      if (excludedPatches.length === 0) {
        clearPending();
        return;
      }
      const restagedSelections: Record<string, boolean> = {};
      for (const p of excludedPatches) restagedSelections[p.field] = true;
      set({
        pendingPatchBySession: {
          ...get().pendingPatchBySession,
          [sessionId]: {
            patch: { ...pendingPatch, patches: excludedPatches },
            selections: restagedSelections,
            issues: [],
          },
        },
      });
    };

    const selectedPatches = pendingPatch.patches.filter(
      (p) => patchSelections[p.field] && !(excludeFields ?? []).includes(p.field as string),
    );
    if (selectedPatches.length === 0) {
      settlePending();
      return null;
    }

    // Story 1.3 art-mode override (design §5 / §4): accepting a scene_graph
    // patch despite error-severity issues = author override. Merge the
    // corresponding art_overrides into the graph data before persisting so
    // subsequent validations downgrade them to info. The existing accept button
    // is the override entry — minimal UI change. Non-scene_graph patches and
    // error-free scene_graph patches pass through unchanged.
    const errorIssues = pendingPatchIssues.filter((i) => i.severity === 'error');
    const sceneGraphEntry = selectedPatches.find((p) => p.field === 'scene_graph' && p.action !== 'delete');
    let sceneGraphData: unknown = sceneGraphEntry?.data;
    if (sceneGraphEntry && errorIssues.length > 0) {
      try {
        const graph: SceneGraph = sceneGraphSchema.parse(sceneGraphEntry.data);
        const additions = buildArtOverridesForErrors(errorIssues, graph.art_overrides ?? []);
        if (additions.length > 0) {
          sceneGraphData = { ...graph, art_overrides: [...(graph.art_overrides ?? []), ...additions] };
        }
      } catch (err) {
        // Defense-in-depth: malformed staged graph persists as-is (the shell
        // handler validates projection, so this should never fire). Log so the
        // silent-data-loss path stays observable per data-flow spec.
        console.warn('[creativeFields] scene_graph patch failed schema parse on apply; persisting as-is', err);
      }
    }

    const nextFields = { ...creativeFields };
    const nextMeta = { ...fieldMetadata };
    let overviewData: Record<string, unknown> | null = null;

    // CR-25（dogfood R2 批次 D2）：接受 scene_graph patch 时 diff 改前/改后 node id 集
    // → 存待消费高亮集 pendingStructureHighlight（StructurePage 挂载/更新时消费 →
    // highlightNodeIds 绿框脉冲，TTL 3s 在彼处）。触发点在本处而非结构页挂载域 effect：
    // 用户常在他页接受 patch，切回结构页时 diff 恒空，原主流程不可达。delete patch 无
    // 新图可比不产高亮；改前图缺形（首图/部分 hydration）按 diffAddedNodeIds 语义返
    // 空；残缺形状静默跳过（写通道永不因读态崩溃）。多次接受未消费时并集去重（先存
    // 留集后新增集，顺序稳定）。
    let nextPendingHighlight: string[] | null = null;
    if (sceneGraphEntry && isSceneGraphLike(sceneGraphData)) {
      const prevGraph = creativeFields.scene_graph;
      const added = isSceneGraphLike(prevGraph)
        ? diffAddedNodeIds(prevGraph, sceneGraphData)
        : [];
      if (added.length > 0) {
        const existing = get().pendingStructureHighlight;
        nextPendingHighlight = existing.length === 0 ? added : [...new Set([...existing, ...added])];
      }
    }

    // Story 4.1 Step 5：chapter_candidate patches 单独路由。它们不是 creative field
    // （patchFieldSchema 不含 chapter_candidate），不能走 syncField（field:sync 会
    // creativeFieldKeySchema.parse('chapter_candidate') 抛错），也不该污染 creativeFields
    // 状态。分流到 chapterCandidatePatches —— 经 applyAgentFieldPatch IPC（→ applyFieldPatches
    // → acceptChapterCandidateCore）写 chapters/*.md + chapter 元数据 + story_decisions。
    const chapterCandidatePatches = selectedPatches.filter(
      (p) => (p.field as string) === 'chapter_candidate',
    );
    // Story 2.6：story_decisions patch（创作决策 ADR，register/supersede/drop）——非 creative field
    // （novel 段），走 applyAgentFieldPatch IPC 独立分支（applyFieldPatches story_decisions 分支重放
    // actions 落 novel.story_decisions），mirror chapter_candidate 路由模式。
    const storyDecisionPatches = selectedPatches.filter(
      (p) => (p.field as string) === 'story_decisions',
    );

    for (const patch of selectedPatches) {
      // chapter_candidate：跳过 creative-field mutation + syncField（下方单独持久化）。
      if ((patch.field as string) === 'chapter_candidate') continue;
      // Story 2.6：story_decisions 同 chapter_candidate——非 creative field，跳过 mutation + syncField
      // （parse 会抛：syncField 收窄 CreativeFieldKey），下方单独 IPC 持久化。
      if ((patch.field as string) === 'story_decisions') continue;
      // 'overview' targets project meta (name/logline/synopsis…), not a
      // creative field — persisted separately via saveProject below.
      if (patch.field === 'overview') {
        if (patch.action !== 'delete' && patch.data && typeof patch.data === 'object') {
          overviewData = patch.data as Record<string, unknown>;
        }
        continue;
      }
      const key = patch.field as CreativeFieldKey;
      if (patch.action === 'delete') {
        delete nextFields[key];
      } else {
        nextFields[key] = patch === sceneGraphEntry ? sceneGraphData : patch.data;
      }
      const existing = nextMeta[key] ?? { ...DEFAULT_METADATA };
      nextMeta[key] = {
        ...existing,
        version: patch.fieldVersion,
        source: 'agent',
        stale: false
      };
    }

    // dogfood R2 批次0（缺口4）：AI 落盘与手动编辑 undo 对称——本次被改的每个 creative field
    // 把改前值压 fieldUndoStack（改前值在 get() 留存的 creativeFields 里取；nextFields 是从它
    // 拷贝开始改的，不能作来源）+ 清 fieldRedoStack（mirror updateField 栈语义）。chapter_candidate/
    // story_decisions/overview 不压栈——与 updateField 的 CreativeFieldKey 收窄一致（前两者走独立
    // IPC 分流，overview 合并进 currentProject，均无对应 undo 语义）。批量压多 entry 后整体
    // slice(-30)，与 updateField 逐条压（slice(-29)+1）保持同一栈上限 30。无 creative 改动时
    // （如仅 chapter_candidate）不触栈——不清别人的 redo。
    const undoEntries: Array<{ field: CreativeFieldKey; data: unknown }> = [];
    const undoSeen = new Set<string>();
    for (const patch of selectedPatches) {
      if ((patch.field as string) === 'chapter_candidate') continue;
      if ((patch.field as string) === 'story_decisions') continue;
      if (patch.field === 'overview') continue;
      if (undoSeen.has(patch.field)) continue; // 防御：同 field 多 entry（dedup 后不应出现）
      undoSeen.add(patch.field);
      undoEntries.push({ field: patch.field as CreativeFieldKey, data: creativeFields[patch.field as CreativeFieldKey] });
    }

    const appliedPatch: ProjectFieldPatch = {
      runId: pendingPatch.runId,
      createdAt: pendingPatch.createdAt,
      patches: selectedPatches
    };

    set({
      creativeFields: nextFields,
      fieldMetadata: nextMeta,
      ...(nextPendingHighlight ? { pendingStructureHighlight: nextPendingHighlight } : {}),
      ...(undoEntries.length > 0 ? {
        fieldUndoStack: [...fieldUndoStack, ...undoEntries].slice(-30),
        fieldRedoStack: [],
      } : {}),
      ...(overviewData && currentProject
        ? { currentProject: mergeOverviewIntoProject(currentProject, overviewData) }
        : {})
    });
    settlePending();

    // Persist to disk. Creative fields → fieldSyncBridge (project.yaml, with
    // version/lock checks). Overview → saveProject (project.json + .yaml).
    const path = currentProject?.path;
    if (path && window.orisonDesktop?.syncField) {
      const locale = (get() as any).resolvedLocale ?? 'en-US';
      for (const patch of selectedPatches) {
        // chapter_candidate：跳过 syncField（非 creative field，parse 会抛）—— 下方单独路由。
        if ((patch.field as string) === 'chapter_candidate') continue;
        // Story 2.6：story_decisions 同 skip（下方 applyAgentFieldPatch 单独路由）。
        if ((patch.field as string) === 'story_decisions') continue;
        if (patch.field === 'overview' || patch.action === 'delete') continue;
        const data = patch === sceneGraphEntry ? sceneGraphData : patch.data;
        window.orisonDesktop.syncField(path, patch.field as CreativeFieldKey, data).catch((err) => reportSyncFailure(locale, patch.field as CreativeFieldKey, err));
      }
    }
    // Story 4.1 Step 5：chapter_candidate patches → applyAgentFieldPatch IPC（→ applyFieldPatches
    // → acceptChapterCandidateCore 写 chapters/*.md + chapter 元数据 + story_decisions）。这是
    // chapter 正文落地的唯一 UI 持久化路径（write_chapter accept_as_truth → field_patch →
    // PatchReviewPanel accept → 此处）。整批一次调用（applyFieldPatches 内 loop 处理多 candidate
    // + 单次 meta.version bump）。
    if (path && chapterCandidatePatches.length > 0 && window.orisonDesktop?.applyAgentFieldPatch) {
      const locale = (get() as any).resolvedLocale ?? 'en-US';
      const chapterPatch: ProjectFieldPatch = {
        runId: pendingPatch.runId,
        createdAt: pendingPatch.createdAt,
        patches: chapterCandidatePatches,
      };
      window.orisonDesktop.applyAgentFieldPatch(path, chapterPatch).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        useToastStore.getState().showToast(translate(locale, 'creative.field.syncFailed', { field: 'chapter_candidate', reason }), 'error');
      });
    }
    // Story 2.6：story_decisions patches -> 同 applyAgentFieldPatch IPC（applyFieldPatches story_decisions
    // 分支：load fresh + applyDecisionActions 重放守卫 + 写 novel.story_decisions + meta bump）。整批一次
    // 调用（mirror chapter_candidate 块）。
    if (path && storyDecisionPatches.length > 0 && window.orisonDesktop?.applyAgentFieldPatch) {
      const locale = (get() as any).resolvedLocale ?? 'en-US';
      const decisionPatch: ProjectFieldPatch = {
        runId: pendingPatch.runId,
        createdAt: pendingPatch.createdAt,
        patches: storyDecisionPatches,
      };
      window.orisonDesktop.applyAgentFieldPatch(path, decisionPatch).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        useToastStore.getState().showToast(translate(locale, 'creative.field.syncFailed', { field: 'story_decisions', reason }), 'error');
      });
    }
    if (overviewData) {
      const locale = (get() as any).resolvedLocale ?? 'en-US';
      get().saveProject().catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        useToastStore.getState().showToast(translate(locale, 'creative.field.syncFailed', { field: 'overview', reason }), 'error');
      });
    }

    return appliedPatch;
  }
  };
};

/**
 * Map an agent overview patch (snake_case meta subset) onto the camelCased
 * ProjectMeta the store holds. Only known fields are copied; unknown keys are
 * ignored so a stray field can't corrupt project state.
 */
function mergeOverviewIntoProject(
  project: ProjectMeta,
  data: Record<string, unknown>
): ProjectMeta {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    ...project,
    name: str(data.name) ?? project.name,
    logline: str(data.logline) ?? project.logline,
    synopsis: str(data.synopsis) ?? project.synopsis,
    genre: str(data.genre) ?? project.genre,
    theme: str(data.theme) ?? project.theme,
    writingStyle: str(data.writing_style) ?? project.writingStyle,
    tone: str(data.tone) ?? project.tone
  };
}
