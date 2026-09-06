import { useAppStore, type ActivePage } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { useShallow } from 'zustand/react/shallow';
import { Tooltip } from '../../shared/components/Tooltip';
import {
  overviewItem, outlineItem, structureItem, assetsItem, settingItem, materialsItem, craftItem, deconItem,
  productionItems, type PageNavItem,
} from './navItems';
import { openWriting } from '../editor/openWriting';

function NavButton({ item, active, onClick, t }: { item: PageNavItem; active: boolean; onClick: () => void; t: (k: string) => string }) {
  return (
    <Tooltip label={t(item.i18nKey)} placement="right">
      <button
        type="button"
        className={`icon-rail-btn${active ? ' icon-rail-btnActive' : ''}`}
        onClick={onClick}
        aria-label={t(item.i18nKey)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">{item.icon}</span>
      </button>
    </Tooltip>
  );
}

export function SideNav() {
  const {
    activePage, setActivePage,
    resolvedLocale,
    activeSidebarPanel, setActiveSidebarPanel,
    mainView,
    agentPanelOpen, toggleAgentPanel,
    showSettings, setShowSettings,
  } = useAppStore(useShallow((s) => ({
    activePage: s.activePage,
    setActivePage: s.setActivePage,
    resolvedLocale: s.resolvedLocale,
    activeSidebarPanel: s.activeSidebarPanel,
    setActiveSidebarPanel: s.setActiveSidebarPanel,
    mainView: s.mainView,
    agentPanelOpen: s.agentPanelOpen,
    toggleAgentPanel: s.toggleAgentPanel,
    showSettings: s.settingsDialogOpen,
    setShowSettings: s.setSettingsDialogOpen,
  })));

  const { t } = useI18n(resolvedLocale);

  const handlePage = (page: ActivePage) => setActivePage(page);

  const handleSearchClick = () => {
    setActiveSidebarPanel(activeSidebarPanel === 'search' ? 'explorer' : 'search');
  };

  const isPageActive = (page: ActivePage) => mainView === 'page' && activePage === page;

  return (
    <>
      <nav className="icon-rail" aria-label="Main Navigation">
        <div className="icon-rail-top">
          {/* --- Left panel switchers --- */}
          <Tooltip label={t('nav.explorer') || '资源管理器'} placement="right">
            <button
              type="button"
              className={`icon-rail-btn${activeSidebarPanel === 'explorer' ? ' icon-rail-btnActive' : ''}`}
              onClick={() => setActiveSidebarPanel('explorer')}
              aria-label={t('nav.explorer') || '资源管理器'}
            >
              <span className="material-symbols-outlined" aria-hidden="true">folder_open</span>
            </button>
          </Tooltip>

          <Tooltip label={t('nav.search') || '搜索'} placement="right">
            <button
              type="button"
              className={`icon-rail-btn${activeSidebarPanel === 'search' ? ' icon-rail-btnActive' : ''}`}
              onClick={handleSearchClick}
              aria-label={t('nav.search') || '搜索'}
            >
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
            </button>
          </Tooltip>

          <Tooltip label={t('nav.timeline') || '时间线'} placement="right">
            <button
              type="button"
              className={`icon-rail-btn${activeSidebarPanel === 'timeline' ? ' icon-rail-btnActive' : ''}`}
              onClick={() => setActiveSidebarPanel(activeSidebarPanel === 'timeline' ? 'explorer' : 'timeline')}
              aria-label={t('nav.timeline') || '时间线'}
            >
              <span className="material-symbols-outlined" aria-hidden="true">history</span>
            </button>
          </Tooltip>

          {/* 世界状态面板（dogfood R2 #92）：世界事件系统读面——L1 总览/L2 时点/L3 主体
              三级缩放。左槽与 explorer/search/timeline 同族互斥（prd「挂载与形态」），
              位置在时间线下方。 */}
          <Tooltip label={t('nav.world') || '世界'} placement="right">
            <button
              type="button"
              className={`icon-rail-btn${activeSidebarPanel === 'world' ? ' icon-rail-btnActive' : ''}`}
              onClick={() => setActiveSidebarPanel(activeSidebarPanel === 'world' ? 'explorer' : 'world')}
              aria-label={t('nav.world') || '世界'}
            >
              <span className="material-symbols-outlined" aria-hidden="true">public</span>
            </button>
          </Tooltip>

          <div className="side-nav-separator" />

          {/* --- Group 1: Overview / Outline / Structure / Writing / Assets --- */}
          <NavButton item={overviewItem} active={isPageActive('overview')} onClick={() => handlePage('overview')} t={t} />
          <NavButton item={outlineItem} active={isPageActive('outline')} onClick={() => handlePage('outline')} t={t} />
          {/* Story 1.5: structure page renders the multi-line narrative timeline
              derived from scene_graph (the first real UI consumer of the graph).
              Sibling to outline — both are structural views of the story. */}
          <NavButton item={structureItem} active={isPageActive('structure')} onClick={() => handlePage('structure')} t={t} />
          {/* Writing opens the manuscript as a file tab (the source of truth),
              not a page route — the legacy novel/script pages were retired. */}
          <Tooltip label={t('nav.writing')} placement="right">
            <button
              type="button"
              className="icon-rail-btn"
              onClick={() => { void openWriting(); }}
              aria-label={t('nav.writing')}
            >
              <span className="material-symbols-outlined" aria-hidden="true">edit_note</span>
            </button>
          </Tooltip>
          <NavButton item={assetsItem} active={isPageActive('assets')} onClick={() => handlePage('assets')} t={t} />
          {/* 「设定」页（task 08-30-asset-cards-visualization A1）：asset_cards 8 类
              设定卡浏览/编辑聚合页——master-detail（左列表右详情）。 */}
          <NavButton item={settingItem} active={isPageActive('setting')} onClick={() => handlePage('setting')} t={t} />
          {/* 「材料」页（Story 10.1 Wave D，D7）：摄取基座材料库管理面——scope 切换
              （本项目 ↔ 全局库）+ 列表/删除/重摄取/批量拖入。 */}
          <NavButton item={materialsItem} active={isPageActive('materials')} onClick={() => handlePage('materials')} t={t} />
          {/* 「手艺」页（E10.2b W5）：蒸馏人审面——队列/卡编辑/并排对比/废弃区/词表。 */}
          <NavButton item={craftItem} active={isPageActive('craft')} onClick={() => handlePage('craft')} t={t} />
          {/* 「拆书」页（E10.3b W6）：小说拆解管线面——进度/人审闸门/产出阅读/风格导出。 */}
          <NavButton item={deconItem} active={isPageActive('decon')} onClick={() => handlePage('decon')} t={t} />

          <div className="side-nav-separator" />

          {/* --- Group 2: Production tools --- */}
          {productionItems.map((item) => (
            <NavButton key={item.id} item={item} active={isPageActive(item.id)} onClick={() => handlePage(item.id)} t={t} />
          ))}

          <div className="side-nav-separator" />

          {/* --- Workbench (Agent panel) toggle --- */}
          {/* Story 3.2: reframe the agent panel as the workbench — the primary
              surface for directing the AI. Tooltip mirrors workspace.agentPanel. */}
          <Tooltip label={t('workspace.agentPanel')} placement="right">
            <button
              type="button"
              className={`icon-rail-btn${agentPanelOpen ? ' icon-rail-btnActive' : ''}`}
              onClick={toggleAgentPanel}
              aria-label={t('workspace.agentPanel')}
            >
              <span className="material-symbols-outlined" aria-hidden="true">assistant</span>
            </button>
          </Tooltip>
        </div>

        <div className="icon-rail-bottom">
          <Tooltip label={t('nav.settings')} placement="right">
            <button
              type="button"
              className={`icon-rail-btn${showSettings ? ' icon-rail-btnActive' : ''}`}
              onClick={() => setShowSettings(true)}
              aria-label={t('nav.settings')}
            >
              <span className="material-symbols-outlined" aria-hidden="true">settings</span>
            </button>
          </Tooltip>

        </div>
      </nav>
    </>
  );
}
