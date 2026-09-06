import { create } from 'zustand';
import { createProjectSlice, type ProjectSlice } from './projectSlice';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';
import { createPanelsSlice, type PanelsSlice } from './panelsSlice';
import { createTasksSlice, type TasksSlice } from './tasksSlice';
import { createCreativeFieldsSlice, type CreativeFieldsSlice } from './creativeFieldsSlice';
import { createStructureSlice, type StructureSlice } from './structureSlice';
import { createFileTabsSlice, type FileTabsSlice } from './fileTabsSlice';
import { createNovelChapterSlice, type NovelChapterSlice } from './novelChapterSlice';
import { createOutputSlice, type OutputSlice } from './outputSlice';
import { createRecentProjectsSlice, type RecentProjectsSlice } from './recentProjectsSlice';
import { createImageGenSlice, type ImageGenSlice } from './imageGenSlice';
import { createBackgroundTasksSlice, type BackgroundTasksSlice } from './backgroundTasksSlice';
import { createUpdateSlice, type UpdateSlice } from './updateSlice';
import { createCommandPaletteSlice, type CommandPaletteSlice } from './commandPaletteSlice';
import { createAgentSessionSlice, type AgentSessionSlice } from './agentSessionSlice';
import { createAgentSkillSlice, type AgentSkillSlice } from './agentSkillSlice';
import { createAgentDiffSlice, type AgentDiffSlice } from './agentDiffSlice';
import { createChapterReviewSlice, type ChapterReviewSlice } from './chapterReviewSlice';
import { createNotificationSlice, type NotificationSlice } from './notificationSlice';
import { createAgentSettingsSlice, type AgentSettingsSlice } from './agentSettingsSlice';
import { createAutoSaveSlice, type AutoSaveSlice } from './autoSaveSlice';
import { createEditorCommandSlice, type EditorCommandSlice } from './editorCommandSlice';
import { createKbIndexSlice, type KbIndexSlice } from './kbIndexSlice';
import { createInsightInteractionSlice, type InsightInteractionSlice } from './insightInteractionSlice';
import { createSettingMdPatchSlice, type SettingMdPatchSlice } from './settingMdPatchSlice';
import { createAuthorProfilePatchSlice, type AuthorProfilePatchSlice } from './authorProfilePatchSlice';
import { createLintSlice, type LintSlice } from './lintSlice';
import { createStyleInputSlice, type StyleInputSlice } from './styleInputSlice';
import { createWorldStateSlice, type WorldStateSlice } from './worldStateSlice';
import { createSettingSlice, type SettingSlice } from './settingSlice';
import { createMaterialsSlice, type MaterialsSlice } from './materialsSlice';
import { createCraftSlice, type CraftSlice } from './craftSlice';
import { createDeconSlice, type DeconSlice } from './deconSlice';
import { installProjectSubscription } from './projectSubscription';
import { initAgentEvents } from './agentEvents';

export type { WorkspaceModule, WorkspacePanel, ActivePage, SidebarPanel, BottomPanelTab, ThemeSetting, LocaleSetting, ProjectMeta, TaskAdapter, AgentMode } from './types';
export type { MainView } from './panelsSlice';

type AppState = ProjectSlice &
  SettingsSlice &
  PanelsSlice &
  TasksSlice &
  CreativeFieldsSlice &
  StructureSlice &
  FileTabsSlice &
  NovelChapterSlice &
  OutputSlice &
  RecentProjectsSlice &
  ImageGenSlice &
  BackgroundTasksSlice &
  UpdateSlice &
  CommandPaletteSlice &
  AgentSessionSlice &
  AgentSkillSlice &
  AgentDiffSlice &
  ChapterReviewSlice &
  AgentSettingsSlice &
  AutoSaveSlice &
  EditorCommandSlice &
  NotificationSlice &
  KbIndexSlice &
  InsightInteractionSlice &
  SettingMdPatchSlice &
  AuthorProfilePatchSlice &
  LintSlice &
  StyleInputSlice &
  WorldStateSlice &
  SettingSlice &
  MaterialsSlice &
  CraftSlice &
  DeconSlice;

export const useAppStore = create<AppState>()((...a) => ({
  ...createProjectSlice(...a),
  ...createSettingsSlice(...a),
  ...createPanelsSlice(...a),
  ...createTasksSlice(...a),
  ...createCreativeFieldsSlice(...a),
  ...createStructureSlice(...a),
  ...createFileTabsSlice(...a),
  ...createNovelChapterSlice(...a),
  ...createOutputSlice(...a),
  ...createRecentProjectsSlice(...a),
  ...createImageGenSlice(...a),
  ...createBackgroundTasksSlice(...a),
  ...createUpdateSlice(...a),
  ...createCommandPaletteSlice(...a),
  ...createAgentSessionSlice(...a),
  ...createAgentSkillSlice(...a),
  ...createAgentDiffSlice(...a),
  ...createChapterReviewSlice(...a),
  ...createAgentSettingsSlice(...a),
  ...createAutoSaveSlice(...a),
  ...createEditorCommandSlice(...a),
  ...createNotificationSlice(...a),
  ...createKbIndexSlice(...a),
  ...createInsightInteractionSlice(...a),
  ...createSettingMdPatchSlice(...a),
  ...createAuthorProfilePatchSlice(...a),
  ...createLintSlice(...a),
  ...createStyleInputSlice(...a),
  ...createWorldStateSlice(...a),
  ...createSettingSlice(...a),
  ...createMaterialsSlice(...a),
  ...createCraftSlice(...a),
  ...createDeconSlice(...a),
}));

installProjectSubscription(useAppStore);

// dogfood T1 Stage 3（r7）：store 级全局流事件监听——一次注册永不清退（WeakSet 按 store
// 实例幂等，StrictMode 双挂载 / HMR 重执行免疫），按 sessionId+projectPath 分发活跃视图 /
// 后台态。必须在 store 组装完成后挂（分发器经 getState 读全量 state）。
initAgentEvents(useAppStore);
