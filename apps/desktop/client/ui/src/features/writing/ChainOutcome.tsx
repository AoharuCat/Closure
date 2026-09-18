import { useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { getSessionProject } from '../../shared/store/agentEvents';
import { useI18n } from '../../shared/i18n/useI18n';
import type { ChainRunState } from '../../shared/store/chainStreamBuffer';
import type { ChainTimelineState } from '../../shared/store/chainTimeline';
import { openWriting } from '../editor/openWriting';
import {
  formatElapsed,
  nodeDisplayName,
  projectChapterCandidateEnvelopes,
  projectOutcomeErrorLines,
  projectOutcomeRows,
  projectTimelineFeedMeta,
} from './chainTimelineView';

/**
 * 09-13 子3 W6（design §1.3/§6.2）：终态产物区——钉在运行相位时间线底部，卡随 run 终态三选。
 *
 * - **completed**：落盘清单卡（正文路径 + 世界事件/伏笔计数 + 章摘要/弧节拍/反哺/反馈台账行——
 *   E 段 artifact 帧投影，**按实际获得字段投影缺不造数**）+ 跳转（打开稿件 openWriting /
 *   世界面板 setActiveSidebarPanel / 设定卡审阅→对话栏）+ children 槽（W4 的 chapter_candidate
 *   待落盘审阅挂载——产物区顶部，行为不变仅迁位）。
 * - **error**：失败卡（errorNodeId 定位 + 通用终态行明细 + 复制诊断 navigator.clipboard）+
 *   回对话栏重发起引导。**无断点重跑承诺**（链 error 后 snapshot 存活性未核实——恢复主通道 =
 *   章卡重提取〔正文已落时〕/ 对话栏重发起）。
 * - **aborted**：中断卡（用户放弃/被动中断**无可靠数据面区分**——neutral 文案如实覆盖两态，
 *   不造判定）+ 已产出保留说明 + 重发起引导。
 *
 * 非终态（running/paused）：只渲染 children 槽（待落盘审阅在链仍在跑的窗口也可见——W4
 * 挂载位行为保全）；无 children → null。
 */
export function ChainOutcome({ sessionId, run, timeline, children }: {
  sessionId: string;
  run: ChainRunState;
  timeline: ChainTimelineState | undefined;
  /** W4 组件挂载槽（chapter_candidate 待落盘审阅——产物区顶部）。 */
  children?: ReactNode;
}) {
  const {
    pausedReviewBySession,
    pendingPatchBySession,
    novelChapters,
    projectPath,
    resolvedLocale,
    setActiveSidebarPanel,
    setAgentPanelOpen,
  } = useAppStore(useShallow((s) => ({
    pausedReviewBySession: s.pausedReviewBySession,
    pendingPatchBySession: s.pendingPatchBySession,
    novelChapters: s.novelChapters,
    projectPath: s.currentProject?.path,
    resolvedLocale: s.resolvedLocale,
    setActiveSidebarPanel: s.setActiveSidebarPanel,
    setAgentPanelOpen: s.setAgentPanelOpen,
  })));
  const { t } = useI18n(resolvedLocale);
  const [copied, setCopied] = useState(false);

  // 稳定引用（timeline?.entries ?? [] 字面量每次渲染换 identity——entries 依赖的 useMemo 族防线，
  // ChainTimelineFeed EMPTY_TIMELINE_ENTRIES 同款问题）。
  const entries = useMemo(() => timeline?.entries ?? [], [timeline]);
  const terminal = run.status === 'completed' || run.status === 'error' || run.status === 'aborted';

  // 正文行 chapterId 源：chapter_accept envelope（pendingPatch 链产物，accept completed 后典型
  // 在场）优先 → pausedReview（leader 路径 pause 记录，accept 后被清——次选）。
  // CR-2（09-18 CR 批 B）：扫描加项目归属过滤 + 观察链关联优先——他项目/他链 envelope 的
  // chapterId 不得串进本链产物区（关联可判 = 挂载键/patch.runId = 观察链 sid；否则项目内唯一）。
  const pendingChapterCandidateChapterId = useMemo(() => {
    const envelopes = projectChapterCandidateEnvelopes({
      pendingPatchBySession,
      sessionProjects: getSessionProject,
      projectPath,
      observedSessionId: sessionId,
    });
    return envelopes[0]?.chapterId ?? null;
  }, [pendingPatchBySession, projectPath, sessionId]);

  const rows = useMemo(
    () => projectOutcomeRows({
      entries,
      pendingChapterCandidateChapterId,
      pausedChapterId: pausedReviewBySession[sessionId]?.chapterId,
      novelChapters,
    }),
    [entries, pendingChapterCandidateChapterId, pausedReviewBySession, sessionId, novelChapters],
  );

  const errorLines = useMemo(
    () => (run.status === 'error' ? projectOutcomeErrorLines(entries) : []),
    [run.status, entries],
  );

  if (!terminal) {
    return children !== undefined ? <div className="writing-outcome writing-outcome--pending">{children}</div> : null;
  }

  const meta = projectTimelineFeedMeta(entries);
  const durationLabel = meta.startedAt !== null ? formatElapsed(Math.max(0, run.updatedAt - meta.startedAt)) : null;
  const proseChapter = rows.prose !== null ? novelChapters.find((ch) => ch.id === rows.prose!.chapterId) : undefined;

  const handleCopyDiagnostics = () => {
    const errorNodeId = run.errorNodeId ?? run.currentNodeId;
    const diagnostic = [
      `chain session: ${sessionId}`,
      `status: ${run.status}`,
      `errorNode: ${errorNodeId ?? 'unknown'}`,
      `completedNodes: ${run.completedNodes.join(', ') || '(none)'}`,
      ...errorLines.map((line) => `error: ${line}`),
    ].join('\n');
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard?.writeText === undefined) {
      useToastStore.getState().showToast(t('writing.outcome.copyFailed'), 'error');
      return;
    }
    void clipboard
      .writeText(diagnostic)
      .then(() => {
        setCopied(true);
        useToastStore.getState().showToast(t('writing.outcome.copied'), 'success', 4000);
      })
      .catch(() => {
        useToastStore.getState().showToast(t('writing.outcome.copyFailed'), 'error');
      });
  };

  if (run.status === 'completed') {
    return (
      <section className="writing-outcome writing-outcome--completed" data-outcome-kind="completed" aria-label={t('writing.outcome.completedTitle')}>
        {children}
        <h4 className="writing-outcome-title">
          <span className="writing-outcome-ic" aria-hidden="true">✓</span>
          {t('writing.outcome.completedTitle')}
          {durationLabel ? <span className="writing-outcome-dur">{t('writing.outcome.duration', { d: durationLabel })}</span> : null}
        </h4>
        <p className="writing-outcome-sub">{t('writing.outcome.completedSub')}</p>
        {rows.prose || rows.counts.length > 0 || rows.notes.length > 0 ? (
          <ul className="writing-disk-list">
            {rows.prose ? (
              <li className="writing-disk-item" data-disk-metric="prose">
                <span className="writing-disk-ic" aria-hidden="true">📄</span>
                <span className="writing-disk-name">{rows.prose.path}</span>
                <span className="writing-disk-grow" />
                {proseChapter ? (
                  <button
                    type="button"
                    className="writing-disk-link"
                    onClick={() => { void openWriting(proseChapter); }}
                  >
                    {t('writing.outcome.openProse')}
                  </button>
                ) : null}
              </li>
            ) : null}
            {rows.counts.map((row) => (
              <li className="writing-disk-item" key={row.metric} data-disk-metric={row.metric}>
                <span className="writing-disk-ic" aria-hidden="true">{row.metric === 'worldEvents' ? '🌍' : '🧵'}</span>
                <span className="writing-disk-name">{t(`writing.outcome.${row.metric}`)}</span>
                <span className="writing-disk-grow" />
                <span className="writing-disk-cnt">
                  <b>{row.count}</b> {t(row.metric === 'worldEvents' ? 'writing.outcome.unitEvents' : 'writing.outcome.unitItems')}
                  {row.metric === 'worldEvents' ? (
                    <button
                      type="button"
                      className="writing-disk-link"
                      onClick={() => { setActiveSidebarPanel('world'); }}
                    >
                      {t('writing.outcome.openWorld')}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
            {rows.notes.map((row) => (
              <li className="writing-disk-item writing-disk-item--note" key={row.metric} data-disk-metric={row.metric}>
                <span className="writing-disk-ic" aria-hidden="true">◈</span>
                <span className="writing-disk-note-line">{row.line}</span>
                {row.metric === 'storySync' ? (
                  <button
                    type="button"
                    className="writing-disk-link"
                    onClick={() => { setAgentPanelOpen(true); }}
                  >
                    {t('writing.outcome.openChat')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="writing-outcome-norows">{t('writing.outcome.noRows')}</p>
        )}
      </section>
    );
  }

  if (run.status === 'error') {
    const errorNodeId = run.errorNodeId ?? run.currentNodeId;
    const errorNodeLabel = errorNodeId !== null ? nodeDisplayName(errorNodeId, t) : null;
    return (
      <section className="writing-outcome writing-outcome--error" data-outcome-kind="error" aria-label={t('writing.outcome.errorTitle')}>
        {children}
        <h4 className="writing-outcome-title">
          <span className="writing-outcome-ic writing-outcome-ic--error" aria-hidden="true">✗</span>
          {t('writing.outcome.errorTitle')}
        </h4>
        <p className="writing-outcome-sub">
          {errorNodeLabel !== null
            ? t('writing.outcome.errorAt', { node: errorNodeLabel })
            : t('writing.outcome.errorAtUnknown')}
        </p>
        {errorLines.length > 0 ? (
          <ul className="writing-outcome-errors">
            {errorLines.map((line, i) => (
              <li className="writing-outcome-errline" key={`${i}-${line.slice(0, 24)}`}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="writing-outcome-norows">{t('writing.outcome.noErrorDetail')}</p>
        )}
        <p className="writing-outcome-hint">{t('writing.outcome.retryHint')}</p>
        <div className="writing-outcome-actions">
          <button type="button" className="writing-final-btn" onClick={handleCopyDiagnostics}>
            {copied ? t('writing.outcome.copied') : t('writing.outcome.copyDiagnostics')}
          </button>
          <button type="button" className="writing-final-btn writing-final-btn--primary" onClick={() => { setAgentPanelOpen(true); }}>
            {t('writing.outcome.backToChat')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="writing-outcome writing-outcome--aborted" data-outcome-kind="aborted" aria-label={t('writing.outcome.abortedTitle')}>
      {children}
      <h4 className="writing-outcome-title">
        <span className="writing-outcome-ic writing-outcome-ic--muted" aria-hidden="true">⏸</span>
        {t('writing.outcome.abortedTitle')}
        {durationLabel ? <span className="writing-outcome-dur">{t('writing.outcome.duration', { d: durationLabel })}</span> : null}
      </h4>
      <p className="writing-outcome-sub">{t('writing.outcome.abortedBody')}</p>
      <p className="writing-outcome-hint">{t('writing.outcome.abortedKept')}</p>
      <p className="writing-outcome-hint">{t('writing.outcome.retryHint')}</p>
      <div className="writing-outcome-actions">
        <button type="button" className="writing-final-btn writing-final-btn--primary" onClick={() => { setAgentPanelOpen(true); }}>
          {t('writing.outcome.backToChat')}
        </button>
      </div>
    </section>
  );
}
