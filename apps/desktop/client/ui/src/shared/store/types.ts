import type { z } from 'zod';
import type { taskRequestSchema, taskResultSchema, patchOperationSchema, AgentBehaviorMode } from '@orison/shared-contracts';

export type WorkspaceModule = 'outline' | 'novel' | 'script';
export type WorkspacePanel = 'overview' | 'image_gen' | 'assets';
export type ActivePage = 'overview' | 'outline' | 'novel' | 'script' | 'image_gen' | 'assets' | 'structure' | 'setting' | 'materials' | 'craft' | 'decon' | 'writing';
export type SidebarPanel = 'explorer' | 'search' | 'timeline' | 'world';
export type BottomPanelTab = 'output' | 'tasks' | 'lint';
export type ThemeSetting = 'system' | 'light' | 'dark' | (string & {});
export type LocaleSetting = 'system' | (string & {});
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type PatchOperation = z.infer<typeof patchOperationSchema>;

export type UserInfo = {
  id: string;
  email: string;
  displayName?: string;
};

export type ProjectMeta = {
  projectId?: string;
  name: string;
  path: string;
  type: 'novel' | 'script';
  logline?: string;
  synopsis?: string;
  genre?: string;
  theme?: string;
  writingStyle?: string;
  tone?: string;
  coverImage?: string;
};

export type TaskAdapter = {
  submitTask: (request: TaskRequest) => Promise<{ taskId: string; status: string }>;
  getTaskResult: (taskId: string) => Promise<TaskResult>;
};

export type TaskEntry = {
  request: TaskRequest;
  result: TaskResult | null;
};

export type AgentMode = 'auto' | 'suggest' | 'readonly';

/**
 * Story 3.1: leader runLoop behavior mode, mirrored from the shared-contracts
 * IPC type. Orthogonal to AgentMode (which gates tool permission) — behaviorMode
 * governs *how* the leader acts per turn (execute / discuss / plan). Re-exported
 * here so UI code imports all agent-mode types from one place.
 */
export type { AgentBehaviorMode };
