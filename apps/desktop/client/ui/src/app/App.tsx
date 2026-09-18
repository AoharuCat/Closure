import { useEffect } from 'react';
import { useAppStore } from '../shared/store/appStore';
import { TopBar } from '../features/top-bar/TopBar';
import { ProjectsPage } from '../pages/projects/ProjectsPage';
import { WorkspacePage } from '../pages/workspace/WorkspacePage';
import { CommandPalette } from '../features/command-palette/CommandPalette';
import { Toast } from '../shared/components/Toast';
import { ConfirmDialog } from '../shared/components/ConfirmDialog';
import { useToolEvents } from '../shared/hooks/useToolEvents';
import { useCloseGuard } from '../shared/hooks/useCloseGuard';
import { StyleInputDialog } from '../features/agent-panel/StyleInputDialog';
// 子4 W6：agy MCP 工具桥知情同意对话框——agent 对话流 `agy_bridge_consent|` 前缀错误
// 转模块级 ask 态，App 层条件挂载（mirror StyleInputDialog；对话流可能在任何视图触发）。
import { AgyBridgeConsentDialog } from '../features/agent-panel/AgyBridgeConsentDialog';
import { useAgyBridgeStore } from '../shared/store/agyBridgeStore';

export function App() {
  const currentProject = useAppStore((s) => s.currentProject);
  const loadUserPreferences = useAppStore((s) => s.loadUserPreferences);
  const loadModelConfig = useAppStore((s) => s.loadModelConfig);
  const loadAppVersion = useAppStore((s) => s.loadAppVersion);
  const subscribeUpdateEvents = useAppStore((s) => s.subscribeUpdateEvents);
  // 世界状态面板（#92）：world:changed 事件订阅与 update 事件同组织——App 引导期一次挂。
  const subscribeWorldEvents = useAppStore((s) => s.subscribeWorldEvents);
  // 「材料」页（Story 10.1 Wave D）：material:changed 事件订阅同组织——App 引导期一次挂。
  const subscribeMaterialEvents = useAppStore((s) => s.subscribeMaterialEvents);
  // 「手艺」页（E10.2b W5）：craft:distill-progress 事件订阅同组织——手艺页 + 材料页蒸馏
  // 徽章两消费面共享（全局库跨项目，事件刷新三件套见 craftSlice）。
  const subscribeCraftEvents = useAppStore((s) => s.subscribeCraftEvents);
  // 「拆书」页（E10.3b W6）：decon:progress 事件订阅同组织——拆书页单消费面（事件刷新
  // 三件套见 deconSlice；机器级 job 不随项目切换清）。
  const subscribeDeconEvents = useAppStore((s) => s.subscribeDeconEvents);
  const restoreLastProject = useAppStore((s) => s.restoreLastProject);
  // #92 事件门控配套：面板可见性通知——worldStateSlice 的事件响应以 activeSidebarPanel
  // === 'world' 门控（面板关闭不重拉），关→开边沿由 onWorldPanelVisibility force 重拉
  // 当前视图作读侧补偿（面板关闭期间被门控丢弃的 world:changed 事件兜底）。
  const activeSidebarPanel = useAppStore((s) => s.activeSidebarPanel);
  const onWorldPanelVisibility = useAppStore((s) => s.onWorldPanelVisibility);
  const worldPanelVisible = activeSidebarPanel === 'world';
  // 材料页同款门控配套（Story 10.1 Wave D）：activePage === 'materials' 门控 + 关→开
  // force 补偿（material:changed 事件刷新三件套的读侧兜底）。
  const activePage = useAppStore((s) => s.activePage);
  const onMaterialsPageVisibility = useAppStore((s) => s.onMaterialsPageVisibility);
  const materialsPageVisible = activePage === 'materials';
  // 手艺面同款门控配套（E10.2b W5）：craft:distill-progress 的两消费面 = 手艺页 + 材料页
  // （材料页蒸馏徽章在跑）——任一可见即接收；关→开 force 补偿。
  const onCraftSurfacesVisibility = useAppStore((s) => s.onCraftSurfacesVisibility);
  const craftSurfacesVisible = activePage === 'craft' || activePage === 'materials';
  // 拆书面同款门控配套（E10.3b W6）：activePage === 'decon' 门控 + 关→开 force 补偿
  // （decon:progress 事件刷新三件套的读侧兜底）。
  const onDeconPageVisibility = useAppStore((s) => s.onDeconPageVisibility);
  const deconPageVisible = activePage === 'decon';
  // 08-25 全窗口壁纸（唯一背景层，不分区）：url 空不渲染。08-29 滑杆化：可调磨砂
  // （wallpaperFrostBlur 0–50px 打壁纸层自身；0 = 关，层不带 filter/transform）。
  const wallpaperUrl = useAppStore((s) => s.wallpaperUrl);
  const wallpaperOpacity = useAppStore((s) => s.wallpaperOpacity);
  const wallpaperFrostBlur = useAppStore((s) => s.wallpaperFrostBlur);
  // 风格卡片 MVP（08-28 C 路）：leader request_style_input → 风格片段对话框（App 级 modal
  // overlay，与 ConfirmDialog 同层；勿挂 AgentMessageItem——它随消息流滚动/被顶出视野）。
  const pendingStyleInput = useAppStore((s) => s.pendingStyleInput);
  // 子4 W6：桥知情同意对话框待答态（agentEvents 错误分发器写入）。
  const agyBridgeAsk = useAgyBridgeStore((s) => s.ask);

  useToolEvents();
  useCloseGuard();

  useEffect(() => {
    void loadUserPreferences();
    void loadModelConfig();
    void loadAppVersion();
    restoreLastProject();
    subscribeUpdateEvents();
    subscribeWorldEvents();
    subscribeMaterialEvents();
    subscribeCraftEvents();
    subscribeDeconEvents();
    // 子4 W6：桥状态面启动拉取（「桥」徽标派生 + 设置页/对话框快照基线；无 CLI key
    // 时也拉——一次 invoke 的代价换状态面常新）。
    void useAgyBridgeStore.getState().refreshStatus();
  }, [loadUserPreferences, loadModelConfig, loadAppVersion, restoreLastProject, subscribeUpdateEvents, subscribeWorldEvents, subscribeMaterialEvents, subscribeCraftEvents, subscribeDeconEvents]);

  useEffect(() => {
    onWorldPanelVisibility(worldPanelVisible);
  }, [worldPanelVisible, onWorldPanelVisibility]);

  useEffect(() => {
    onMaterialsPageVisibility(materialsPageVisible);
  }, [materialsPageVisible, onMaterialsPageVisibility]);

  useEffect(() => {
    onCraftSurfacesVisibility(craftSurfacesVisible);
  }, [craftSurfacesVisible, onCraftSurfacesVisibility]);

  useEffect(() => {
    onDeconPageVisibility(deconPageVisible);
  }, [deconPageVisible, onDeconPageVisibility]);

  return (
    <>
      {wallpaperUrl && (
        <div
          className="app-wallpaper"
          aria-hidden="true"
          style={{
            backgroundImage: `url("${wallpaperUrl}")`,
            opacity: wallpaperOpacity,
            // 08-29 磨砂滑杆化：>0 时内联施加（旧 --frost 固定类退役——强度连续
            // 可调，类切换无法表达）；过扫随 blur 联动 scale(1 + N/400)，N=20 时
            // =1.05 与旧固定磨砂严格一致（不过扫 blur 会把层外虚空采样进边缘，
            // 四周出一圈发虚的暗边）。=0 时不带 filter/transform。
            ...(wallpaperFrostBlur > 0
              ? {
                  filter: `blur(${wallpaperFrostBlur}px)`,
                  transform: `scale(${1 + wallpaperFrostBlur / 400})`,
                }
              : null),
          }}
        />
      )}
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <TopBar />
      {!currentProject ? <ProjectsPage /> : <WorkspacePage />}
      <CommandPalette />
      <Toast />
      <ConfirmDialog />
      {pendingStyleInput !== null && <StyleInputDialog />}
      {agyBridgeAsk !== null && <AgyBridgeConsentDialog />}
    </>
  );
}
