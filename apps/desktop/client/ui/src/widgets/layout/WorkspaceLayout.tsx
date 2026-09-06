import { lazy, Suspense, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SideNav } from '../../features/side-nav/SideNav';
import { AgentPanel } from '../../features/agent-panel/AgentPanel';
import { BottomPanel } from '../../features/bottom-panel/BottomPanel';
import { ResizeHandle } from '../../shared/components/ResizeHandle';
import { PageSkeleton } from '../../shared/components/PageSkeleton';
import { ErrorBoundary } from '../../shared/components/ErrorBoundary';
import { Tooltip } from '../../shared/components/Tooltip';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { useProjectTreeResize, useAgentPanelResize } from '../../shared/hooks/usePanelResize';
import { useAutoSave } from '../../shared/hooks/useAutoSave';
import { ICON_RAIL_WIDTH } from '../../shared/constants';
import { StatusBar } from '../../features/status-bar/StatusBar';

const ProjectTree = lazy(() => import('../../features/project-tree/ProjectTree').then((m) => ({ default: m.ProjectTree })));
const SearchPanel = lazy(() => import('../../features/search-panel/SearchPanel').then((m) => ({ default: m.SearchPanel })));
const TimelinePanel = lazy(() => import('../../features/timeline/TimelinePanel').then((m) => ({ default: m.TimelinePanel })));
// 世界状态面板（#92）：左槽同族（timeline 分支照抄），与 explorer/search/timeline 互斥。
const WorldStatePanel = lazy(() => import('../../features/world-state/WorldStatePanel').then((m) => ({ default: m.WorldStatePanel })));
const OverviewPage = lazy(() => import('../../features/overview/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const OutlineEditor = lazy(() => import('../../features/editor/OutlineEditor').then((m) => ({ default: m.OutlineEditor })));
const ImageGenEditor = lazy(() => import('../../features/editor/ImageGenEditor').then((m) => ({ default: m.ImageGenEditor })));
const AssetsPanel = lazy(() => import('../../features/assets/AssetsPanel').then((m) => ({ default: m.AssetsPanel })));
const StructurePage = lazy(() => import('../../features/structure/StructurePage').then((m) => ({ default: m.StructurePage })));
// 「设定」页（task 08-30-asset-cards-visualization A1）：asset_cards 设定卡浏览/编辑。
const SettingPage = lazy(() => import('../../features/setting/SettingPage').then((m) => ({ default: m.SettingPage })));
// 「材料」页（Story 10.1 Wave D，D7）：摄取基座材料库管理面（scope 切换/列表/删除四清/
// 重摄取/批量拖入/provenance 后补）。
const MaterialsPage = lazy(() => import('../../features/materials/MaterialsPage').then((m) => ({ default: m.MaterialsPage })));
// 「手艺」页（E10.2b W5）：经验文档蒸馏人审面——队列/卡编辑/并排对比/废弃区/词表管理。
const CraftPage = lazy(() => import('../../features/craft/CraftPage').then((m) => ({ default: m.CraftPage })));
// 「拆书」页（E10.3b W6）：小说拆解管线面——新建拆解/进度 + 人审闸门/产出阅读/风格导出。
const DeconPage = lazy(() => import('../../features/decon/DeconPage').then((m) => ({ default: m.DeconPage })));
const FileTabBar = lazy(() => import('../../features/editor/FileTabBar').then((m) => ({ default: m.FileTabBar })));
const FileEditor = lazy(() => import('../../features/editor/FileEditor').then((m) => ({ default: m.FileEditor })));
const SplitFileEditor = lazy(() => import('../../features/editor/SplitFileEditor').then((m) => ({ default: m.SplitFileEditor })));

export function WorkspaceLayout() {
  const {
    activePage,
    projectTreeOpen, projectTreeWidth,
    activeSidebarPanel,
    agentPanelOpen, agentPanelWidth,
    agentExpanded,
    toggleAgentPanel,
    hasOpenFiles,
    mainView,
    splitDirection, splitFilePath,
    activeFilePath, setSplit,
    bottomPanelOpen,
    resolvedLocale,
    projectPath,
  } = useAppStore(useShallow((s) => ({
    activePage: s.activePage,
    projectTreeOpen: s.projectTreeOpen,
    projectTreeWidth: s.projectTreeWidth,
    activeSidebarPanel: s.activeSidebarPanel,
    agentPanelOpen: s.agentPanelOpen,
    agentPanelWidth: s.agentPanelWidth,
    agentExpanded: s.agentExpanded,
    toggleAgentPanel: s.toggleAgentPanel,
    hasOpenFiles: s.openFiles.length > 0,
    mainView: s.mainView,
    splitDirection: s.splitDirection,
    splitFilePath: s.splitFilePath,
    activeFilePath: s.activeFilePath,
    setSplit: s.setSplit,
    bottomPanelOpen: s.bottomPanelOpen,
    resolvedLocale: s.resolvedLocale,
    projectPath: s.currentProject?.path,
  })));

  const { t } = useI18n(resolvedLocale);
  const handleTreeResize = useProjectTreeResize();
  const handleAgentResize = useAgentPanelResize();
  useAutoSave();

  // Fullscreen workbench mode (dogfood 2026-08-21 拍板：放大 = 占满主区直到项目文件
  // 侧栏旁，非原「主区/工作台分屏」)。Expanded mounts only when the panel is open;
  // when closed the layout falls back to docked proportions even if agentExpanded
  // stays true in store, so reopen restores the expanded state.
  const isExpanded = agentExpanded && agentPanelOpen;

  // Same-file dual panes overwrite each other (independent editor instances,
  // no shared doc model) — when any tab activation lands the split's file in
  // the main pane, collapse the split so the document is only mounted once.
  // setSplit already prevents this at creation; this catches every later
  // activation path (tab click, cycle, close-fallback, reopen).
  const splitCollides = (splitDirection === 'horizontal' || splitDirection === 'vertical')
    && splitFilePath !== null && splitFilePath === activeFilePath;
  useEffect(() => {
    if (splitCollides) setSplit('none');
  }, [splitCollides, setSplit]);

  // dogfood R2 #19：project:watch（shell 侧 projectWatcher + assetCardsWatcher +
  // settingMdWatcher + chapterChunkWatcher + reindexAssetCards backfill）原先挂在
  // ProjectTree 组件上——切侧栏面板/收起文件树即三 watcher 全停重启 + backfill 重跑
  // （磁盘重复 IO、切换空窗内外部变更丢失）。watcher 服务全 app，不随页面组件生灭，
  // 改挂本项目级常驻组件：项目打开期间恰好一个 watcher；path 变化（切项目）时换向；
  // 项目关闭时本组件随 App 切回 ProjectsPage 卸载、走 cleanup unwatch。ProjectTree
  // 只消费 file:changed 事件（orison:tool-event 监听），不再负责 watch 生命周期。
  // 注：dev 下 StrictMode 会双调此 effect（watch→unwatch→watch，见 renderer/main.tsx），
  // shell 侧 single-active-watch 幂等收敛无泄漏，启动日志 watcher ×2 轮属预期
  // dev-only 现象，非缺陷（dogfood #1 08-25 定谳）。
  useEffect(() => {
    if (!projectPath) return;
    void window.orisonDesktop?.watchProject?.(projectPath);
    return () => { void window.orisonDesktop?.unwatchProject?.(); };
  }, [projectPath]);

  const treeCols = projectTreeOpen
    ? `${projectTreeWidth}px 4px `
    : '';

  const gridColumns = `${ICON_RAIL_WIDTH}px ${treeCols}1fr`;

  const renderMainContent = () => {
    // File tabs take priority when mainView is 'files'
    if (mainView === 'files' && hasOpenFiles) {
      const hasSplit = splitDirection !== 'none' && splitFilePath && !splitCollides;
      return (
        <>
          <FileTabBar />
          <div className={`workspace-content workspace-content--flush workspace-split--${hasSplit ? splitDirection : 'none'}`} style={{ flex: 1, minWidth: 0 }}>
            <FileEditor />
            {hasSplit && <SplitFileEditor filePath={splitFilePath} />}
          </div>
        </>
      );
    }

    // Page view
    switch (activePage) {
      case 'overview': return <div className="workspace-content workspace-content--flush"><OverviewPage /></div>;
      case 'outline': return <div className="workspace-content workspace-content--flush"><OutlineEditor /></div>;
      // 'novel'/'script' are legacy page routes; the manuscript is now edited as
      // .md file tabs (opened from the overview / project tree). Fall through to
      // the overview so a stale persisted activePage can't render a dead editor.
      case 'novel':
      case 'script':
        return <div className="workspace-content workspace-content--flush"><OverviewPage /></div>;
      case 'image_gen': return <div className="workspace-panel-content"><ImageGenEditor /></div>;
      case 'assets': return <div className="workspace-panel-content"><AssetsPanel /></div>;
      case 'structure': return <div className="workspace-panel-content"><StructurePage /></div>;
      case 'setting': return <div className="workspace-panel-content"><SettingPage /></div>;
      case 'materials': return <div className="workspace-panel-content"><MaterialsPage /></div>;
      case 'craft': return <div className="workspace-panel-content"><CraftPage /></div>;
      case 'decon': return <div className="workspace-panel-content"><DeconPage /></div>;
      default: return <div className="workspace-panel-content"><OverviewPage /></div>;
    }
  };

  return (
    <div className="workspace-shell">
      <div className="workspace-body" style={{ gridTemplateColumns: gridColumns }}>
        <SideNav />
        {projectTreeOpen && (
          <>
            <ErrorBoundary>
              <Suspense fallback={<PageSkeleton variant="sidebar" />}>
                {activeSidebarPanel === 'timeline' ? <TimelinePanel /> : activeSidebarPanel === 'world' ? <WorldStatePanel /> : activeSidebarPanel === 'search' ? <SearchPanel /> : <ProjectTree />}
              </Suspense>
            </ErrorBoundary>
            <ResizeHandle onResize={handleTreeResize} />
          </>
        )}
        <div className={`workspace-row${isExpanded ? ' workspace-row--expanded' : ''}`}>
          {isExpanded ? null : (
            <div
              id="main-content"
              tabIndex={-1}
              className="workspace-main"
              style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, position: 'relative' }}
            >
              <ErrorBoundary>
                <Suspense fallback={<PageSkeleton variant="page" />}>
                  {renderMainContent()}
                </Suspense>
              </ErrorBoundary>
              {/* Expanded workbench is a focus mode — output/tasks aren't
                  co-rendered with the dominant workbench. Docked mode keeps them. */}
              {bottomPanelOpen && <BottomPanel />}
            </div>
          )}
          {/* 全屏工作台态隐藏侧栏 chevron（dogfood 2026-08-21）：面板显然开着，
              细标签无意义且怪；退出全屏走面板头部的收起钮。 */}
          {!isExpanded && (
            <Tooltip label={t('workspace.agentPanel')} placement="left">
              <button
                type="button"
                className={`agent-side-tab${agentPanelOpen ? ' is-open' : ''}`}
                onClick={toggleAgentPanel}
                aria-label={t('workspace.agentPanel')}
              >
                <span className="material-symbols-outlined">
                  {agentPanelOpen ? 'chevron_right' : 'chevron_left'}
                </span>
              </button>
            </Tooltip>
          )}
          {agentPanelOpen && (
            <>
              {!isExpanded && <ResizeHandle onResize={handleAgentResize} />}
              <div
                className={isExpanded ? 'workspace-workbench-dominant' : undefined}
                style={
                  isExpanded
                    ? { flex: '1 1 0', minWidth: 0 }
                    : { width: agentPanelWidth, flexShrink: 0 }
                }
              >
                <AgentPanel />
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
