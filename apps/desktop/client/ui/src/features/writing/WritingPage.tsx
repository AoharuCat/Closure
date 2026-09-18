import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { getSessionProject } from '../../shared/store/agentEvents';
import type { NovelChapterMeta } from '../../shared/store/novelChapterSlice';
import { openWriting } from '../editor/openWriting';
// 09-13 子3 W4（design §5.2 / D-g 切分）：chapter_candidate（链产物终稿 envelope）落盘审阅
// 挂写作页——对话栏不渲染全尺寸卡（轻量提示跳转此处）。组件 home 不迁（全 app 通用
// field_patch 审阅面），props sessionId 按链会话键控。W6 迁位：挂载点进 ChainOutcome 槽
//（终态产物区顶部；链在跑窗口由 ChainOutcome --pending 槽承接，行为不变）。
import { PatchReviewPanel } from '../agent-panel/PatchReviewPanel';
// 09-13 子3 W3（design §1.2/§3）：运行摘要条 + 运行时间线（观察链数据面只读消费）。
import { ChainRunMetaBar, ChainTimelineFeed } from './ChainTimeline';
import {
  modelChipView,
  projectChapterCandidateEnvelopes,
  resolveObservedChainSession,
} from './chainTimelineView';
// 09-13 子3 W5（design §1.3/§4）：审阅相位（相位状态机 effect + ReviewPhaseView 容器）。
import { ReviewPhaseView } from './ReviewPhaseView';
import { resolveReviewPauseKind } from './reviewPhase';
// 09-13 子3 W6（design §1.2/§6）：多会话条（chip 切观察）+ 终态产物区（三态卡钉时间线底部）。
import { ChainSessionBar } from './ChainSessionBar';
import { ChainOutcome } from './ChainOutcome';

/**
 * 「写作」页（task 09-13-writing-page-ui）——写章链运行态专门面。
 *
 * 三区布局（design §1.2）：章节列（196px）｜主区（多会话条 + 运行摘要条 + 相位区）。
 * W3 落位：运行摘要条（章名 fallback「写章链」/状态与圈数/时长=首个 entry.at/模型 chip+
 * 回退标注；无余量条——context-usage 是 leader 车道专属事件，链车道无数据）+ 运行时间线
 * （段结构/圈分组/四档节点模板，ChainTimelineFeed）。W6 落位：多会话条（ChainSessionBar
 * ——chip 切观察目标）+ 终态产物区（ChainOutcome 三态卡钉时间线底部）。
 *
 * W5 主区双相位（design §1.3 相位状态机）：
 * - **自动进审阅**（上升沿：running→paused 或 回页挂载时已 paused）→ writingPhase='review'。
 *   三条件缺一不可：观察链 paused + 该链 = 当前观察链 + 用户在写作页（本组件挂载即「在页」
 *   ——相位是页内态非路由，不挂载 = 零 auto-jump）。
 * - **手动优先**：用户「收起审阅」后链仍 paused 不反复强切（上升沿效应器只在 paused 布尔
 *   翻转时触发一次；prevRef 挂载初值 null → 挂载即 paused 也算沿 = 回页自动进审阅）。
 * - **下降沿自动回 run**：审阅相位中链离 paused（resume 续跑事件到达 / 终态——aborted/error
 *   终态不进审阅，终态产物区是 W6 面）→ writingPhase='run'。
 *
 * 观察链解析：显式选择（selectedChainSessionId——W6 chip 切换 / ReviewPendingNotice 跳转写入）→
 * 项目锚（chainRunAnchorByProject——链事件每帧登记，单项目当前链）。章名弱承诺：仅 leader 路径
 * 暂停后可判（pausedReviewBySession[sid].chapterId → novelChapters 查表；stub 链/运行中
 * fallback「写章链」——完整链→章映射 seam defer 挂 dogfood）。
 *
 * 章节列：数据源 novelChapterSlice.novelChapters（store 已按 sortOrder 排序）；点章 =
 * openWriting(chapter) 开稿件文件 tab（进编辑器，与写作页互不干扰——design「读旧章
 * 不被打断」）。链状态点（W5 接通）：观察链 paused 且 pausedReview.chapterId 命中该章 →
 * paused 点亮（运行中不高亮具体章——链→章映射弱承诺）。
 *
 * 空态：无链引导卡（写章仍从对话栏发起 direction-first）；无 currentProject 守卫
 * （materials/setting 页先例——工作区常开项目，此处防御持久化 activePage 等边角路径）。
 */
export type ChapterChainDot = 'running' | 'paused' | 'done';

/** 章行衍生状态（W6 章卡）：undefined = 无查询行（查询在途 / 章不在 project.yaml）→ 无徽标无按钮。 */
export type ChapterDerivationView = { stale: boolean; busy: boolean };

type ChapterRowProps = {
  chapterId: string;
  ordinal: string;
  label: string;
  /** 观察链 paused 且 pausedReview.chapterId 命中该章 → paused 点亮（运行中不高亮——映射弱承诺）。 */
  chainDot?: ChapterChainDot;
  /** W6：stale 徽标（stale 字段单消费——synopsisStale || !summaryPresent 契约侧派生）。 */
  derivation?: ChapterDerivationView;
  /** stale 徽标文案（i18n 由 parent 传——行内组件无 hook）。 */
  staleLabel?: string;
  /** 重提取按钮文案（stale 时可用；busy 态换文案）。 */
  reExtractLabel?: string;
  onOpen: () => void;
  onReExtract?: () => void;
};

function ChapterRow({ chapterId, ordinal, label, chainDot, derivation, staleLabel, reExtractLabel, onOpen, onReExtract }: ChapterRowProps) {
  // CR-15（09-18 CR 批 B）：交互不嵌套——行容器去 role="button" 改 li 语义，「开稿件」与
  // 「重提取」为两个平级独立 button（嵌套可交互元素屏幕阅读器/键盘路径双坏：外层 role=button
  // 吞内层按钮语义，Enter 双触发源）。键盘 Activate 由原生 button 承载（去手写 keydown）。
  return (
    <li
      className="writing-chapter"
      data-writing-chapter-id={chapterId}
      data-chain-dot={chainDot ?? 'none'}
      data-derivation-stale={derivation?.stale === true ? 'true' : 'false'}
    >
      <button type="button" className="writing-chapter-open" onClick={onOpen}>
        <span className="writing-chapter-num">{ordinal}</span>
        <span className="writing-chapter-title">{label}</span>
      </button>
      {derivation?.stale === true && staleLabel !== undefined ? (
        <span className="writing-chapter-stale">{staleLabel}</span>
      ) : null}
      {derivation !== undefined && onReExtract !== undefined && reExtractLabel !== undefined ? (
        <button
          type="button"
          className="writing-chapter-reextract"
          data-reextract-busy={derivation.busy ? 'true' : 'false'}
          disabled={derivation.busy || !derivation.stale}
          onClick={() => {
            if (!derivation.busy && derivation.stale) onReExtract();
          }}
        >
          {derivation.busy ? <span className="writing-chapter-reextract-spin" aria-hidden="true" /> : null}
          <span>{reExtractLabel}</span>
        </button>
      ) : null}
      <span className="writing-chapter-dot" aria-hidden="true" />
    </li>
  );
}

export function WritingPage() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const currentProject = useAppStore((s) => s.currentProject);
  const novelChapters = useAppStore((s) => s.novelChapters);
  // W3：观察链数据面（全部只读消费——chainRun/chainTimeline 写入方是 agentEvents 面）。
  const chainRunBySession = useAppStore((s) => s.chainRunBySession);
  const chainTimelineBySession = useAppStore((s) => s.chainTimelineBySession);
  const chainRunAnchorByProject = useAppStore((s) => s.chainRunAnchorByProject);
  const selectedChainSessionId = useAppStore((s) => s.selectedChainSessionId);
  const pausedReviewBySession = useAppStore((s) => s.pausedReviewBySession);
  const escalateFindingsBySession = useAppStore((s) => s.escalateFindingsBySession);
  const writingPhase = useAppStore((s) => s.writingPhase);
  const modelConfig = useAppStore((s) => s.modelConfig);
  // W6：章卡衍生状态面（slice 查询/重提取；本页只读消费 + 挂载期/章列变化触发拉取）。
  const chapterDerivationByChapter = useAppStore((s) => s.chapterDerivationByChapter);
  const chapterReExtracting = useAppStore((s) => s.chapterReExtracting);
  const loadChapterDerivationStatus = useAppStore((s) => s.loadChapterDerivationStatus);
  const reExtractChapterDerivation = useAppStore((s) => s.reExtractChapterDerivation);
  const { t } = useI18n(resolvedLocale);

  // ── W5 相位状态机（design §1.3）──
  // observedChainId / run 在守卫早退后派生（下方），但效应器依赖 paused 布尔——先在 hook 层
  // 派生同款解析（纯函数，廉价查表）。
  const observedChainId = currentProject
    ? resolveObservedChainSession({
        selectedChainSessionId,
        chainRunBySession,
        chainRunAnchorByProject,
        projectPath: currentProject.path,
      })
    : null;
  const run = observedChainId !== null ? chainRunBySession[observedChainId] : undefined;
  const observedPaused = observedChainId !== null && run?.status === 'paused';

  // 上升沿：running→paused（哨兵 paused 帧沿）或挂载即 paused（回页自动进审阅）→ 自动切审阅。
  // prevRef 守「手动收起审阅后链仍 paused」不反复强切；StrictMode 双调幂等（ref 跨 effect 重跑
  // 持续，二次运行为 prev=true → no-op）。
  // CR-4①（09-18 CR 批 B）：观察目标切换 = 新沿机会——重置沿记忆，使新 paused 链被观察即触发
  // 上升沿（原实现只看 paused 布尔：A 链 paused 下切到 B 链 paused，布尔不翻转 → 永不进审阅）。
  const pausedEdgeRef = useRef<boolean | null>(null);
  const observedChainRef = useRef<string | null>(null);
  useEffect(() => {
    if (observedChainRef.current !== observedChainId) {
      observedChainRef.current = observedChainId;
      pausedEdgeRef.current = null;
    }
    const prev = pausedEdgeRef.current;
    pausedEdgeRef.current = observedPaused;
    if (!observedPaused) return;
    if (prev === false || prev === null) {
      useAppStore.getState().setWritingPhase('review');
    }
  }, [observedChainId, observedPaused]);

  // 下降沿：审阅相位中链离 paused（resume 续跑 / 终态）→ 自动回运行相位（审阅目标已不存在，
  // 非手动覆盖冲突——ReviewPhaseView 未 paused 防御性 null 同源）。
  useEffect(() => {
    if (writingPhase === 'review' && observedChainId !== null && !observedPaused) {
      useAppStore.getState().setWritingPhase('run');
    }
  }, [writingPhase, observedChainId, observedPaused]);

  // 09-13 子3 W4（design §5.2）：chapter_candidate 待落盘审阅挂载——pendingPatchBySession 中
  // 含链产物 envelope 的会话逐个挂 PatchReviewPanel（键 = 写入方 setPendingPatch 的会话 id；
  // per-project 活动链守卫下典型 0-1 个）。W6 迁位：挂载点进 ChainOutcome 槽（产物区顶部）。
  // CR-2（09-18 CR 批 B）：扫描加项目归属过滤——他项目 envelope 不再串进本页挂载面。
  const chapterCandidateSids = useAppStore(useShallow((s) => {
    return projectChapterCandidateEnvelopes({
      pendingPatchBySession: s.pendingPatchBySession,
      sessionProjects: getSessionProject,
      projectPath: s.currentProject?.path,
      observedSessionId: null,
    }).map((env) => env.sessionId);
  }));

  // W6：衍生状态拉取时机 = 挂载（进页面）+ 章列变化（新建/删除章改变衍生面）+ 切项目（projectPath
  // 换 key）。slice 内含 stale resolve 丢弃守卫；重提取成功后 slice 自刷新（双覆盖）。无项目跳过。
  const derivationProjectPath = currentProject?.path;
  useEffect(() => {
    if (derivationProjectPath === undefined) return;
    void loadChapterDerivationStatus();
  }, [derivationProjectPath, novelChapters, loadChapterDerivationStatus]);

  // 无 currentProject 守卫：工作区常开项目，此分支只防持久化 activePage 等边角路径。
  if (!currentProject) {
    return (
      <div className="writing-page writing-page--guarded">
        <div className="writing-empty" data-writing-guard="no-project">
          <span className="material-symbols-outlined writing-empty-icon" aria-hidden="true">edit_note</span>
          <h3 className="writing-empty-title">{t('writing.noProject.title')}</h3>
          <p className="writing-empty-body">{t('writing.noProject.body')}</p>
        </div>
      </div>
    );
  }

  const timeline = observedChainId !== null ? chainTimelineBySession[observedChainId] : undefined;

  // 章名派生（leader 路径 pause 后可判；stub 链/运行中 → null → fallback「写章链」）。
  let chapterTitle: string | null = null;
  let pausedChapterId: string | undefined;
  if (observedChainId !== null) {
    pausedChapterId = pausedReviewBySession[observedChainId]?.chapterId;
    const chapter = pausedChapterId !== undefined ? novelChapters.find((ch) => ch.id === pausedChapterId) : undefined;
    if (chapter) {
      chapterTitle = t('writing.run.chapter', {
        n: Number.isFinite(chapter.sortOrder) ? chapter.sortOrder + 1 : chapter.id,
        title: chapter.title || t('novelChapter.unnamed', { id: chapter.id }),
      });
    }
  }

  const modelChip = modelChipView(run, modelConfig);
  const inReview =
    writingPhase === 'review'
    && observedChainId !== null
    && resolveReviewPauseKind({
        paused: observedPaused,
        pausedReview: pausedReviewBySession[observedChainId],
        escalateFindings: escalateFindingsBySession[observedChainId],
      }) !== null;

  return (
    <div className="writing-page">
      <aside className="writing-chapters">
        <div className="writing-chapters-title">{t('writing.chapters.title')}</div>
        {novelChapters.length === 0 ? (
          <p className="writing-chapters-empty">{t('writing.chapters.empty')}</p>
        ) : (
          <ul className="writing-chapters-list">
            {novelChapters.map((ch: NovelChapterMeta) => {
              const derivationEntry = chapterDerivationByChapter[ch.id];
              return (
                <ChapterRow
                  key={ch.id}
                  chapterId={ch.id}
                  ordinal={Number.isFinite(ch.sortOrder) ? String(ch.sortOrder + 1) : '?'}
                  label={ch.title || t('novelChapter.unnamed', { id: ch.id })}
                  chainDot={observedPaused && pausedChapterId === ch.id ? 'paused' : undefined}
                  derivation={derivationEntry !== undefined
                    ? { stale: derivationEntry.stale === true, busy: chapterReExtracting[ch.id] === true }
                    : undefined}
                  staleLabel={t('writing.chapters.staleBadge')}
                  reExtractLabel={
                    chapterReExtracting[ch.id] === true
                      ? t('writing.chapters.reExtractBusy')
                      : t('writing.chapters.reExtract')
                  }
                  onOpen={() => { void openWriting(ch); }}
                  onReExtract={() => { void reExtractChapterDerivation(ch.id); }}
                />
              );
            })}
          </ul>
        )}
        <p className="writing-chapters-hint">{t('writing.chapters.hint')}</p>
      </aside>
      <div className="writing-main">
        {/* W6：多会话条（chip 列表 = chainRunBySession × sessionProjectPaths 项目过滤；无 chip 不渲染）。 */}
        <ChainSessionBar observedChainId={observedChainId} />
        {/* W3：运行摘要条（无观察链不渲染——无物可汇总，空态卡承载引导）。
            CR-4②（09-18 CR 批 B）：观察链 paused 但相位在 run（手动收起审阅后的场景）→ 摘要条
            显「进审阅」入口钮——单链收起后页内保持手动再入口（手动优先语义的对称出口）。 */}
        {observedChainId !== null ? (
          <ChainRunMetaBar
            run={run}
            timeline={timeline}
            chapterTitle={chapterTitle}
            modelChip={modelChip}
            enterReview={observedPaused && writingPhase !== 'review'
              ? { label: t('writing.run.enterReview'), onClick: () => { useAppStore.getState().setWritingPhase('review'); } }
              : null}
          />
        ) : null}
        {/* W5：主区双相位——审阅相位（暂停卡随 pauseKind 切换）/ 运行相位（时间线；无链空态卡）。 */}
        <div className="writing-phase" data-writing-phase={inReview ? 'review' : 'run'}>
          {inReview && observedChainId !== null ? (
            <ReviewPhaseView
              sessionId={observedChainId}
              run={run}
              timeline={timeline}
              chapterTitle={chapterTitle}
            />
          ) : observedChainId !== null && run !== undefined ? (
            <>
              <ChainTimelineFeed timeline={timeline} run={run} />
              {/* W6：终态产物区（completed/error/aborted 三态卡钉时间线底部；children = W4 的
                  chapter_candidate 待落盘审阅——产物区顶部，链在跑窗口由 --pending 槽承接）。 */}
              <ChainOutcome sessionId={observedChainId} run={run} timeline={timeline}>
                {chapterCandidateSids.map((sid) => (
                  <PatchReviewPanel key={sid} sessionId={sid} />
                ))}
              </ChainOutcome>
            </>
          ) : (
            <div className="writing-empty" data-writing-empty="no-chain">
              <span className="material-symbols-outlined writing-empty-icon" aria-hidden="true">monitoring</span>
              <h3 className="writing-empty-title">{t('writing.empty.title')}</h3>
              <p className="writing-empty-body">{t('writing.empty.body')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
