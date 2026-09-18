import type { StateCreator } from 'zustand';
import type { ChapterDerivationStatusEntry, ProjectFieldPatch } from '@orison/shared-contracts';
import { chapterDerivationStatus, reExtractChapter } from '../api/agent';
import { registerProjectReset } from './resetRegistry';
import { useToastStore } from './toastStore';
import { parseChainBusyError, showChainRunBusyToast, showRunBusyToast } from './projectRunBusy';
import { translate } from '../i18n/useI18n';

// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子3 W6（design §6.3 / 子1 交接项 O1）：章卡衍生状态 slice。
//
// 数据源 `closure:chapter-derivation-status` IPC（shell handler 在位、preload 本波暴露）——
// 注册章的衍生状态新鲜度（`ChapterDerivationStatusEntry.stale/synopsisStale/summaryPresent`
// 字段消费；`stale` 是契约侧派生单字段 = synopsisStale || !summaryPresent，按钮态单字段消费）。
//
// 生命周期：
// - 查询时机 = 写作页挂载 / 章节列变化（WritingPage effect）+ 重提取成功后（本 slice 内刷新）。
// - 重提取（`closure:re-extract-chapter`）：busy 守卫（per-chapter 单飞）+ 同项目活动链守卫的
//   busy 拒绝走 projectRunBusy 单源解析 toast（reason 机器串 `project_run_active|heldBy=…`）+
//   其余失败 reason 直出。成功 → 重查衍生状态 + story-sync 反哺档位分流（storySyncReview 人审
//   envelope → setPendingPatch 进对话栏 PatchReview，mirror chapterReviewSlice runResume 终态
//   消费；storySyncLanded → toast 告知非静默）。
// - 项目切换 reset：两 Record 清空（章 id 是项目内命名空间——跨项目 chapterId 撞名会串章卡态）。
//
// 项目隔离 + 竞态守卫 mirror runResume：await 期间切项目丢弃结果（stale 异步 resolve 不灌
// 新项目）。范式判据（ADR-3）：查询/派发/记账 = 纯代码机械；重提取语义归链段（shell E 段）。
// ─────────────────────────────────────────────────────────────────────────────

export type ChapterDerivationSlice = {
  /** chapterId → 衍生状态行（最新一次全量查询结果；章卡 stale 徽标 / 按钮态数据源）。 */
  chapterDerivationByChapter: Record<string, ChapterDerivationStatusEntry>;
  /** chapterId → 重提取在途（busy 守卫 + 按钮态；键缺席 = false）。 */
  chapterReExtracting: Record<string, boolean>;
  /** 全量查询（projectPath 取 currentProject；无项目 = 清空态）。 */
  loadChapterDerivationStatus: () => Promise<void>;
  /** 链外重提取该章提取段（busy 单飞守卫；结果分流见文件头）。 */
  reExtractChapterDerivation: (chapterId: string) => Promise<void>;
};

type Deps = ChapterDerivationSlice & {
  currentProject: { path?: string } | null;
  resolvedLocale: string;
  /** story-sync 人审 envelope 组路由进 PatchReview（creativeFieldsSlice 实现）。 */
  setPendingPatch: (sessionId: string, patch: ProjectFieldPatch | null) => void;
  /** envelope 组挂载键（重提取无自然链会话——落视图会话，对话栏 PatchReview 承载）。 */
  agentSessionId: string | null;
  /**
   * CR-6：envelope 组挂载键读面（staging 前查既有批 runId——异 runId 待审批不覆写）。
   * 可选——最小测试 store 缺省 = 视为空键。
   */
  pendingPatchBySession?: Record<string, { patch: { runId: string } } | undefined>;
  /** busy 拒绝 toast 的一键跳转（project_run_active 占用者会话——projectRunBusy 单源）。 */
  switchAgentSession: (sessionId: string) => Promise<void>;
};

function localeOf(get: () => Deps): string {
  return get().resolvedLocale ?? 'zh-CN';
}

export const createChapterDerivationSlice: StateCreator<Deps, [], [], ChapterDerivationSlice> = (set, get) => {
  registerProjectReset(() => {
    set({ chapterDerivationByChapter: {}, chapterReExtracting: {} });
  });

  const applyStatusRows = (rows: ChapterDerivationStatusEntry[]): void => {
    const next: Record<string, ChapterDerivationStatusEntry> = {};
    for (const row of rows) {
      if (row && typeof row.chapterId === 'string') next[row.chapterId] = row;
    }
    set({ chapterDerivationByChapter: next });
  };

  const setBusy = (chapterId: string, value: boolean): void => {
    set((s) => {
      if (value) {
        if (s.chapterReExtracting[chapterId] === true) return s;
        return { chapterReExtracting: { ...s.chapterReExtracting, [chapterId]: true } };
      }
      if (!(chapterId in s.chapterReExtracting)) return s;
      const next = { ...s.chapterReExtracting };
      delete next[chapterId];
      return { chapterReExtracting: next };
    });
  };

  /** 查询（stale 守卫：await 期间切项目丢弃——不灌新项目章卡态）。失败静默清空（best-effort 查询面）。 */
  const queryStatus = async (): Promise<void> => {
    const project = get().currentProject;
    const projectPath = project?.path;
    if (!projectPath) {
      applyStatusRows([]);
      return;
    }
    try {
      const result = await chapterDerivationStatus({ projectPath });
      if (get().currentProject?.path !== projectPath) return; // stale resolve 丢弃
      applyStatusRows(Array.isArray(result?.chapters) ? result.chapters : []);
    } catch {
      if (get().currentProject?.path !== projectPath) return;
      applyStatusRows([]);
    }
  };

  return {
    chapterDerivationByChapter: {},
    chapterReExtracting: {},

    loadChapterDerivationStatus: () => queryStatus(),

    async reExtractChapterDerivation(chapterId) {
      if (get().chapterReExtracting[chapterId] === true) return; // busy 单飞守卫
      const project = get().currentProject;
      const projectPath = project?.path;
      if (!projectPath) return;
      setBusy(chapterId, true);
      try {
        const result = await reExtractChapter({ projectPath, chapterId });
        // await 期间切项目：busy 归零即可（reset 已清记录，结果不灌新项目）。
        if (get().currentProject?.path !== projectPath) return;
        if (!result.ok) {
          const locale = localeOf(get);
          // 同项目活动链/重提取租约拒绝（reason 机器串）→ projectRunBusy 单源 busy toast
          //（mirror chapterReviewSlice runResume busy 分支——链租约 id 换文案无跳转）。
          const busy = parseChainBusyError([result.reason ?? '']);
          if (busy) {
            if (busy.kind === 'chain_run_active') showChainRunBusyToast(locale);
            else {
              showRunBusyToast({
                heldBySessionId: busy.heldBySessionId,
                projectPath: busy.projectPath,
                locale,
                onJump: (sid) => { void get().switchAgentSession(sid); },
              });
            }
          } else {
            useToastStore
              .getState()
              .showToast(translate(locale, 'writing.derivation.failed', { reason: result.reason ?? 'unknown' }), 'error', 7000);
          }
          return;
        }
        // 成功：story-sync 反哺档位分流（mirror runResume 终态消费——review envelope 进对话栏
        // PatchReview / landed 直落 toast 告知非静默），再重查衍生状态（stale 徽标摘除）。
        const locale = localeOf(get);
        if (result.storySyncReview && result.storySyncReview.patches.length > 0) {
          const sid = get().agentSessionId;
          // CR-6①：staging 前查目标键——已有异 runId 待审批批不覆写（setPendingPatch 跨 run
          // replace 语义会静默丢既有待审补丁）；空键或同 runId（setPendingPatch 同 run 合并
          // 语义）才写。冲突不 stage 须告知（不静默丢反哺补丁）。
          const existingRunId = sid ? get().pendingPatchBySession?.[sid]?.patch.runId : undefined;
          if (sid && existingRunId !== undefined && existingRunId !== sid) {
            useToastStore.getState().showToast(
              translate(locale, 'writing.derivation.pendingConflict'),
              'warning',
              7000,
            );
          } else if (sid) {
            get().setPendingPatch(sid, {
              runId: sid,
              createdAt: new Date().toISOString(),
              patches: result.storySyncReview.patches,
            });
            useToastStore.getState().showToast(
              translate(locale, 'writing.derivation.reviewStaged', { n: result.storySyncReview.patches.length }),
              'info',
              7000,
            );
          } else {
            // CR-6②：无活跃会话承载审阅——补丁未 stage，警示告知（不假「待审」成功态）。
            useToastStore.getState().showToast(
              translate(locale, 'writing.derivation.noSession'),
              'warning',
              7000,
            );
          }
        } else if (result.storySyncLanded && result.storySyncLanded.fields.length > 0) {
          useToastStore.getState().showToast(
            translate(locale, 'writing.derivation.landed', { fields: result.storySyncLanded.fields.join('、') }),
            'success',
            6000,
          );
        } else {
          useToastStore.getState().showToast(translate(locale, 'writing.derivation.done'), 'success', 5000);
        }
        await queryStatus();
      } catch (err) {
        if (get().currentProject?.path !== projectPath) return;
        const msg = err instanceof Error ? err.message : String(err);
        useToastStore
          .getState()
          .showToast(translate(localeOf(get), 'writing.derivation.failed', { reason: msg }), 'error', 7000);
      } finally {
        setBusy(chapterId, false);
      }
    },
  };
};
