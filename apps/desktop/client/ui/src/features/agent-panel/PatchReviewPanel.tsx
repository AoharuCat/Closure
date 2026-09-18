import { useShallow } from 'zustand/react/shallow';
import { useState } from 'react';
import { creativeFieldKeys } from '@orison/shared-contracts';
import type { CreativeFieldKey } from '@orison/shared-contracts';
import type { FieldPatchEntry } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { useI18n } from '../../shared/i18n/useI18n';

// 键控选择器稳定空值（防 useShallow 每次新数组引用导致的全量重渲）。
const EMPTY_PATCH_SELECTIONS: Record<string, boolean> = {};
const EMPTY_PATCH_ISSUES: never[] = [];
// Story 3.7 #1：3.3 线 A 议题区 extract 成独立组件（PatchReviewIssues，per-issue 换 InsightCard）。
import { PatchReviewIssues } from './PatchReviewIssues';
// dogfood R2 批次 D1：outline / episode_outlines 的结构化 diff 卡（替裸 JSON）+ 纯模型
//（prettyPatchData 迁模型共用；firstAddedPhaseId 供落盘跳转目标）。
import { OutlinePatchDiff } from './OutlinePatchDiff';
import { isStructuredDiffable, firstAddedPhaseId, prettyPatchData, diffOutline } from './outlinePatchDiffModel';

/**
 * Story 1.5 Phase A (design §4 / §1.2): resurrected from OrisonSpace commit
 * f78c3ca (deleted in 94b40d7). The store API in creativeFieldsSlice stayed
 * intact — only the UI consumer was lost, so agent creative-field patches
 * (incl. scene_graph) had nowhere to land via review. Mounted in the AgentPanel
 * chat view; renders nothing when `pendingPatch` is null (double guard — the
 * mount site also conditionally renders).
 *
 * 09-13 子3 W4（design §5.2 / 拍板 D-g 切分）：props `sessionId?`（缺省兜底 = 视图会话——
 * 写作页产物区按链会话挂载 chapter_candidate 审阅时传目标会话）+ `excludeChapterCandidate`
 * （对话栏挂载过滤：链产物 chapter_candidate 不在对话栏渲染——轻量提示跳写作页；混合批只渲染
 * 非链行，apply 经 excludeFields 排除集不静默落盘隐藏 patch）。
 *
 * A4 enhancement (design §4 optional): scene_graph rows surface
 * `pendingPatchIssues` error/warning counts (the Story 1.3 data channel) so the
 * author sees validation status before Apply. Non-scene_graph patches produce
 * no issues (the slice only validates scene_graph); delete-action rows also
 * skip the badge (nothing to validate).
 *
 * Paradigm guard: this component only routes data through pure-code validation
 * (already computed by the slice) and persists author intent (accept/reject).
 * No semantic judgement here —选址/线型/情绪归 LLM agent.
 */
export function PatchReviewPanel({
  sessionId: propsSessionId,
  excludeChapterCandidate = false,
}: {
  sessionId?: string;
  /** D-g 切分：对话栏挂载过滤 chapter_candidate（链产物归写作页产物区审阅落盘）。缺省渲染全部。 */
  excludeChapterCandidate?: boolean;
}) {
  const {
    sessionId,
    pendingPatch,
    patchSelections,
    pendingPatchIssues,
    togglePatchSelection,
    applySelectedPatches,
    setPendingPatch,
    fieldMetadata,
    toggleFieldLock,
    creativeFields,
    resolvedLocale,
    // dogfood R2 批次 D1：接受落盘后的跳转闭环（toast 行内动作 → 切大纲页 + one-shot 焦点）。
    setActivePage,
    setOutlineFocusTarget,
  } = useAppStore(useShallow((s) => {
    // dogfood T1 Stage 3（r8 键控）：只渲染当前视图会话的挂起 patch；dismiss 也按该会话清键。
    // W4（D-g 切分）：props.sessionId 优先（写作页产物区按链会话挂载），兜底视图会话。
    const sid = propsSessionId ?? s.agentSessionId;
    const entry = sid ? s.pendingPatchBySession[sid] : undefined;
    return {
      sessionId: sid,
      pendingPatch: entry?.patch,
      patchSelections: entry?.selections ?? EMPTY_PATCH_SELECTIONS,
      pendingPatchIssues: entry?.issues ?? EMPTY_PATCH_ISSUES,
      togglePatchSelection: s.togglePatchSelection,
      applySelectedPatches: s.applySelectedPatches,
      setPendingPatch: s.setPendingPatch,
      fieldMetadata: s.fieldMetadata,
      toggleFieldLock: s.toggleFieldLock,
      creativeFields: s.creativeFields,
      resolvedLocale: s.resolvedLocale,
      setActivePage: s.setActivePage,
      setOutlineFocusTarget: s.setOutlineFocusTarget,
    };
  }));

  const { t } = useI18n(resolvedLocale);

  // dogfood 2026-08-21 实录：审阅卡只显字段名+动作，看不到写了什么——把关面看不到
  // 内容等于形同虚设。每行可展开：现值（store creativeFields）→ 新值（entry.data）
  // 对照，结构化 pretty 打印、限高滚动。key 同 CR-009 姿态（field+action+idx）。
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const toggleExpanded = (key: string) =>
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));

  // ── dogfood R2 批次 D1（详设第三节）：接受成功后的跳转闭环。落盘**前**抓改前值做机械
  // diff（apply 后 store 已翻新、改前值消失）：首个新增卷 id → outlineFocusTarget（无新增
  // 卷回退 core 区）。toast 复用既有 toast 基建 useToastStore（T1 Stage 3 起支持行内
  // action 钮——Toast.tsx 渲染 toast-action-btn，无新提示组件）；「到大纲面板查看 →」=
  // setActivePage('outline') + one-shot 焦点（OutlineEditor 消费后清）。仅选中且将落盘的
  // outline patch 触发；episode_outlines 不带跳转（集纲挂在卷卡内、无卷 id 无从定位——V1
  // 边界，详 design 不做项）。
  // CR-16（dogfood R2 BMad CR）：多 outline entry（同批 set+set / set+merge）时后 entry
  // supersede 前（slice 的 apply 循环按序覆盖、末个生效）——跳转目标/摘要计数取**最后
  // 一个**选中且非 delete 的 entry，与实际落盘结果一致。
  // CR-5（dogfood R2 BMad CR）：locked 字段的 sync 被 shell 拒（fieldSyncBridge
  // onFieldEdited 对 locked throw）——落盘不成立，「已落盘」toast+跳转不出（假阳性破除；
  // 失败信号由 slice reportSyncFailure 的 error toast 承担）。版本号从**应用后 store** 读
  //（fieldMetadata.outline.version，slice 落盘时写的真值），非 patch envelope（staging 期
  // 快照，可能与实际落盘值漂移）。
  // CR-24（dogfood R2 BMad CR）：scene_graph 接受落盘 → toast「到时间线查看 →」→
  // setActivePage('structure')。绿脉冲不在此做——W1-A 已在 applySelectedPatches 落
  // pendingStructureHighlight stash（diff 新增 node id），StructurePage 挂载时
  // consumePendingStructureHighlight() 原子消费，跳过去自然点闪。
  // CR-31（dogfood R2 BMad CR）：落盘 toast 摘要计数（设计「v3 · 卷3 · 转折点5」）——
  // diffOutline().stats 已算（volumes/turningPoints），接进 toast 文案。
  const handleApply = () => {
    const patches = pendingPatch?.patches ?? [];
    let outlineEntry: FieldPatchEntry | undefined;
    let sceneGraphEntry: FieldPatchEntry | undefined;
    for (let i = patches.length - 1; i >= 0; i--) {
      const p = patches[i];
      if (patchSelections[p.field] !== true) continue;
      if (outlineEntry === undefined && p.field === 'outline' && p.action !== 'delete') outlineEntry = p;
      if (sceneGraphEntry === undefined && p.field === 'scene_graph' && p.action !== 'delete') sceneGraphEntry = p;
      if (outlineEntry !== undefined && sceneGraphEntry !== undefined) break;
    }
    const outlineLocked = fieldMetadata.outline?.locked === true;
    const sceneGraphLocked = fieldMetadata.scene_graph?.locked === true;
    // 落盘前抓改前值 diff（focus 目标 + toast 计数——apply 后改前值消失）。
    const focusPhaseId = outlineEntry && !outlineLocked
      ? firstAddedPhaseId(creativeFields.outline, outlineEntry.data)
      : null;
    const outlineStats = outlineEntry && !outlineLocked
      ? diffOutline(creativeFields.outline, outlineEntry.data).stats
      : null;
    // W4（D-g 切分）：对话栏过滤挂载时传排除集——隐藏的 chapter_candidate 不随「Apply Selected」
    // 静默落盘（slice 侧重 stage 供写作页产物区审阅）；sid 尾参按目标会话键控 apply。
    const applied = applySelectedPatches(
      sessionId ?? undefined,
      excludeChapterCandidate ? ['chapter_candidate'] : undefined,
    );
    if (!applied) return;
    if (outlineEntry && !outlineLocked) {
      const outlineVersion = useAppStore.getState().fieldMetadata.outline?.version ?? 0;
      const statsParts: string[] = [];
      if ((outlineStats?.addedPhases ?? 0) > 0) {
        statsParts.push(t('agent.patchStatsPhases', { count: outlineStats!.addedPhases }));
      }
      if ((outlineStats?.addedTurningPoints ?? 0) > 0) {
        statsParts.push(t('agent.patchStatsTurningPoints', { count: outlineStats!.addedTurningPoints }));
      }
      const message = statsParts.length > 0
        ? `${t('agent.patchAppliedOutline', { version: outlineVersion })} · ${statsParts.join(' · ')}`
        : t('agent.patchAppliedOutline', { version: outlineVersion });
      useToastStore.getState().showToast(
        message,
        'success',
        6000,
        {
          label: t('agent.patchGoToOutline'),
          onClick: () => {
            setOutlineFocusTarget(focusPhaseId ? { section: 'phase', id: focusPhaseId } : { section: 'core' });
            setActivePage('outline');
          },
        },
      );
    }
    if (sceneGraphEntry && !sceneGraphLocked) {
      useToastStore.getState().showToast(
        t('agent.patchAppliedSceneGraph'),
        'success',
        6000,
        {
          label: t('agent.patchGoToStructure'),
          onClick: () => setActivePage('structure'),
        },
      );
    }
  };

  // CR-1：Reject All 在对话栏过滤挂载（excludeChapterCandidate）且本批含被隐藏的
  // chapter_candidate 时，整键 setPendingPatch(sid, null) 会把隐藏的链产物 envelope 一并静默
  // 丢弃（apply 路径已有重 stage 保护，reject 路径此前漏）——mirror applySelectedPatches
  // settlePending 的 re-stage 语义：先清键再重 stage 被排除集（经 setPendingPatch 新批语义
  // selections 默认选中 + issues 清空；runId/createdAt 保持原批）。纯链挂载（无排除/无隐藏批）
  // 维持整键清场不变。
  const handleRejectAll = () => {
    if (!sessionId || !pendingPatch) return;
    const hiddenChapterCandidates = excludeChapterCandidate
      ? pendingPatch.patches.filter((entry) => (entry.field as string) === 'chapter_candidate')
      : [];
    setPendingPatch(sessionId, null);
    if (hiddenChapterCandidates.length > 0) {
      setPendingPatch(sessionId, {
        runId: pendingPatch.runId,
        createdAt: pendingPatch.createdAt,
        patches: hiddenChapterCandidates,
      });
    }
  };

  if (!pendingPatch) return null;

  // W4（D-g 切分）：对话栏过滤挂载——chapter_candidate（链产物）不渲染行；全批被滤空 → 整卡
  // 不渲染（AgentPanel 挂载位换 ReviewPendingNotice 轻量提示跳写作页）。
  const visiblePatches = excludeChapterCandidate
    ? pendingPatch.patches.filter((entry) => (entry.field as string) !== 'chapter_candidate')
    : pendingPatch.patches;
  if (visiblePatches.length === 0) return null;

  const actionLabels: Record<string, string> = {
    set: t('creative.patch.set'),
    merge: t('creative.patch.merge'),
    delete: t('creative.patch.delete'),
  };

  // Story 1.3 data channel: issues are scene_graph-scoped (slice validates only
  // scene_graph patches). Counts are shown on every scene_graph non-delete row
  // since the channel doesn't split issues per-entry when multiple scene_graph
  // batches merge (CR-013) — they reflect the staged graph as a whole.
  const errorCount = pendingPatchIssues.filter((i) => i.severity === 'error').length;
  const warningCount = pendingPatchIssues.filter((i) => i.severity === 'warning').length;
  const showIssueBadges = errorCount > 0 || warningCount > 0;

  return (
    <div className="patch-review" aria-label={t('creative.patch.title')}>
      <h4 className="patch-review-title">{t('creative.patch.title')}</h4>
      <p className="patch-review-meta">Run: {pendingPatch.runId}</p>
      <div className="patch-review-list">
        {visiblePatches.map((entry, idx) => {
          const canShowIssues = entry.field === 'scene_graph' && entry.action !== 'delete';
          // Story 3.1 WP5: lock toggle only for real creative fields. chapter_candidate
          // is a transient chapter draft (not a CreativeFieldKey), locking it is meaningless.
          const fieldKey = entry.field as string;
          const isLockable = creativeFieldKeys.includes(fieldKey as CreativeFieldKey);
          const locked = isLockable
            ? (fieldMetadata[fieldKey as CreativeFieldKey]?.locked ?? false)
            : false;
          const expandKey = `${entry.field}-${entry.action}-${idx}`;
          const expanded = expandedKeys[expandKey] === true;
          const currentValue = isLockable
            ? (creativeFields as Partial<Record<CreativeFieldKey, unknown>>)[fieldKey as CreativeFieldKey]
            : undefined;
          // dogfood R2 批次 D1：outline / episode_outlines 命中 → 结构化 diff 卡替换该 field
          // 的裸 JSON 区（拦截先例形态 mirror SettingMdPatchCard/ReviewFindingsCard 的「专用卡
          // 替换默认呈现位」，但落位在展开区）。CR-6（dogfood R2 BMad CR）：action 门收紧为
          // `=== 'set'`——merge 载荷是部分形态（未提及字段非全量），diff 会把未提及的
          // phase/episode 渲染成整片红删，故 merge 与 delete / envelope 形态不完整（防御，
          // shell zod 已校验）一样照旧裸 JSON 回退（零回归）。组件内含「diff 无可见变化 → 裸
          // JSON 回退」路径，信息不丢。
          const structuredDiff =
            entry.action === 'set'
            && (entry.field === 'outline' || entry.field === 'episode_outlines')
            && isStructuredDiffable(entry.field, entry.data);
          return (
            // CR-009 defense: key on field+action+index so two patches sharing a
            // field (e.g. a set + a merge on scene_graph after an upstream merge)
            // can't collide on React key or share checkbox state. Index is the
            // final tiebreaker — patch identity is positional within the batch.
            <div key={expandKey} className="patch-review-item-wrap">
              <label className="patch-review-item">
                <input
                  type="checkbox"
                  checked={patchSelections[entry.field] ?? false}
                  onChange={() => togglePatchSelection(entry.field, sessionId ?? undefined)}
                />
                <span className="patch-review-field">{t(`creative.tabs.${entry.field}`)}</span>
                <span className="patch-review-action">{actionLabels[entry.action] ?? entry.action}</span>
                <span className="patch-review-agent">{entry.generatedBy}</span>
                {isLockable && (
                  <button
                    type="button"
                    className={`patch-review-lock-btn${locked ? ' is-locked' : ''}`}
                    // The button sits inside a <label>; without preventDefault the
                    // click would also toggle the row's checkbox.
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleFieldLock(fieldKey as CreativeFieldKey);
                    }}
                    title={t(locked ? 'creative.field.unlock' : 'creative.field.lock')}
                    aria-label={t(locked ? 'creative.field.unlock' : 'creative.field.lock')}
                    aria-pressed={locked}
                  >
                    <span className="material-symbols-outlined">{locked ? 'lock' : 'lock_open'}</span>
                  </button>
                )}
              {canShowIssues && showIssueBadges && (
                <span className="patch-review-issues">
                  {errorCount > 0 && (
                    <span
                      className="patch-review-badge patch-review-badge--error"
                      title={t('creative.patch.errorCount', { count: errorCount })}
                    >
                      {errorCount}
                    </span>
                  )}
                  {warningCount > 0 && (
                    <span
                      className="patch-review-badge patch-review-badge--warning"
                      title={t('creative.patch.warningCount', { count: warningCount })}
                    >
                      {warningCount}
                    </span>
                  )}
                </span>
              )}
                {/* dogfood 2026-08-21：展开看「到底写了什么」——现值 → 新值对照。 */}
                <button
                  type="button"
                  className="patch-review-expand-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleExpanded(expandKey);
                  }}
                  aria-expanded={expanded}
                  title={t('creative.patch.toggleDetail')}
                  aria-label={t('creative.patch.toggleDetail')}
                >
                  <span className="material-symbols-outlined">{expanded ? 'expand_less' : 'expand_more'}</span>
                </button>
              </label>
              {expanded && (
                <div className="patch-review-detail">
                  {structuredDiff ? (
                    <OutlinePatchDiff
                      field={entry.field as 'outline' | 'episode_outlines'}
                      before={currentValue}
                      after={entry.data}
                      t={t}
                    />
                  ) : (
                    <>
                      {currentValue !== undefined && (
                        <div className="patch-review-detail-block">
                          <span className="patch-review-detail-label">{t('creative.patch.currentValue')}</span>
                          <pre>{prettyPatchData(currentValue)}</pre>
                        </div>
                      )}
                      <div className="patch-review-detail-block">
                        <span className="patch-review-detail-label">
                          {entry.action === 'delete'
                            ? t('creative.patch.deleteValue')
                            : t('creative.patch.newValue')}
                        </span>
                        <pre>{entry.action === 'delete' ? '—' : prettyPatchData(entry.data)}</pre>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="patch-review-actions">
        <button
          type="button"
          className="patch-review-apply-btn"
          onClick={handleApply}
        >
          {t('creative.patch.applySelected')}
        </button>
        <button
          type="button"
          className="patch-review-reject-btn"
          onClick={handleRejectAll}
        >
          {t('creative.patch.rejectAll')}
        </button>
      </div>

      {/* Story 3.3 线 A → Story 3.7 #1：本次改动引入的结构问题议题区（pendingPatchIssues 非空时）。
          1.3 数据通道（creativeFieldsSlice setPendingPatch 时跑 validateSceneGraph 产 issues，
          注释明确「为 Epic 3 工作台 chat consumption 预留」）首次进 chat 呈现；3.7 extract 成
          独立组件 PatchReviewIssues（per-issue 换 InsightCard 统一卡 + 应用/忽略/应用并补充）。
          外层 gate 结构保留（BMad CR Blind-003：含 info），组件内再自守卫（全忽略 → null）。
          error 级提示但不阻断 accept（art-mode override 既有，creativeFieldsSlice）不在此组件。 */}
      {pendingPatchIssues.length > 0 && <PatchReviewIssues />}
    </div>
  );
}
