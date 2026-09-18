import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { getSessionProject } from '../../shared/store/agentEvents';
import { useI18n } from '../../shared/i18n/useI18n';
import { projectChainChips } from './chainTimelineView';

/**
 * 09-13 子3 W6（design §1.2/§6.1）：多会话条——本项目全部链 chip 观察器。
 *
 * chip 列表 = `chainRunBySession` 全键 × 项目归属过滤（模块级 sessionProjectPaths——
 * getSessionProject；chainRunAnchorByProject 每项目只存最新 sid 不能当全集）。四态点 +
 * 待审 badge（**判据 = `status==='paused'`**——escalate/stub 链无 pausedReview 也计，F5 连带
 * 修正）；当前观察链高亮；点 chip = `setSelectedChainSessionId` 切观察目标（paused 链被选中
 * → 相位进审阅由 W5 相位状态机沿效应器自动处理——WritingPage pausedEdge effect，本组件零
 * 相位写入）。主标签：pause 后章号（pausedReview.chapterId 查表），fallback「写章链」。
 *
 * 无 chip（本项目无链）→ 整条不渲染（无物可切，空态卡承载引导）。纯呈现 + 机械切换，
 * 零语义判断（ADR-3）。
 */
export function ChainSessionBar({ observedChainId }: { observedChainId: string | null }) {
  const {
    chainRunBySession,
    projectPath,
    pausedReviewBySession,
    novelChapters,
    setSelectedChainSessionId,
    resolvedLocale,
  } = useAppStore(useShallow((s) => ({
    chainRunBySession: s.chainRunBySession,
    projectPath: s.currentProject?.path,
    pausedReviewBySession: s.pausedReviewBySession,
    novelChapters: s.novelChapters,
    setSelectedChainSessionId: s.setSelectedChainSessionId,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);

  const chips = projectChainChips({
    chainRunBySession,
    sessionProjects: getSessionProject,
    projectPath,
    pausedReviewBySession,
    novelChapters,
  });
  if (chips.length === 0) return null;

  return (
    <div className="writing-chainbar" data-writing-chainbar data-chain-count={chips.length}>
      <span className="writing-chainbar-lbl">{t('writing.chains.label')}</span>
      {/* CR-15（09-18 CR 批 B）：tablist/tab 半实现降级为 group + aria-pressed——无键盘 tab
          导航/无 tabpanel 关联的 tablist 语义比没有更糟（误导读屏为标签页控件）；toggle 组
          的真实语义 = aria-pressed 按钮。 */}
      <div className="writing-chainbar-chips" role="group" aria-label={t('writing.chains.label')}>
        {chips.map((chip) => {
          const active = chip.sessionId === observedChainId;
          const label = chip.chapterNumber !== null
            ? t('writing.chip.chapter', { n: chip.chapterNumber })
            : t('writing.run.fallbackTitle');
          return (
            <button
              key={chip.sessionId}
              type="button"
              className="writing-chain-chip"
              data-chain-status={chip.status}
              data-chain-active={active ? 'true' : 'false'}
              aria-pressed={active}
              title={t(`writing.run.status.${chip.status}`)}
              onClick={() => { setSelectedChainSessionId(chip.sessionId); }}
            >
              <span className="writing-chain-chip-st" aria-hidden="true" />
              <span className="writing-chain-chip-label">{label}</span>
              {chip.awaitingReview ? (
                <span className="writing-chain-chip-badge">{t('writing.chip.badge')}</span>
              ) : chip.status !== 'running' ? (
                <span className="writing-chain-chip-state">{t(`writing.run.status.${chip.status}`)}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
