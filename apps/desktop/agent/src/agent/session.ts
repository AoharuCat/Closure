import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionState, SessionMessage, RetentionPriority } from '../types';
import type { SessionPermissionMode } from '../runtime/toolPolicy';
import type { AgentBehaviorMode, BalancedAskCategory, ParticipationGear } from '@orison/shared-contracts';
import {
  BALANCED_ASK_CATEGORIES_DEFAULT,
  PARTICIPATION_GEAR_DEFAULT,
  balancedAskCategorySchema,
  participationGearSchema,
  TRUST_ADJUDICATION_DEFAULT,
} from '@orison/shared-contracts';
import { persistSession, appendMessageToFile, loadMessagesFromFile, deletePersistedSession, loadSessionMeta, overwriteMessagesFile } from './persistence';

const MAX_CACHED_SESSIONS = 20;
const sessions = new Map<string, SessionState>();
const accessOrder: string[] = [];

function touchSession(id: string): void {
  const idx = accessOrder.indexOf(id);
  if (idx !== -1) accessOrder.splice(idx, 1);
  accessOrder.push(id);
  evictOldSessions();
}

function evictOldSessions(): void {
  while (sessions.size > MAX_CACHED_SESSIONS && accessOrder.length > 0) {
    const oldest = accessOrder[0];
    const session = sessions.get(oldest);
    if (session && session.status === 'running') {
      accessOrder.push(accessOrder.shift()!);
      if (accessOrder[0] === oldest) break;
      continue;
    }
    accessOrder.shift();
    sessions.delete(oldest);
  }
}

export function evictSession(id: string): void {
  sessions.delete(id);
  const idx = accessOrder.indexOf(id);
  if (idx !== -1) accessOrder.splice(idx, 1);
}

export interface CreateSessionOptions {
  id?: string;
  agentName: string;
  projectPath: string;
  permissionMode?: SessionPermissionMode;
  behaviorMode?: AgentBehaviorMode;
  /** Story 3.5: 参与档位（smart/steer/balanced/hands_off，缺省 'smart'；非枚举值防御性归一 'smart'）。 */
  participationGear?: ParticipationGear;
  messages?: SessionMessage[];
  parentId?: string;
  children?: string[];
  branchFromMessageId?: string;
  sessionRole?: 'primary' | 'child' | 'fork';
}

/** Story 3.5: 参与档位运行时校验（zod 单源；IPC 边界 + setter 共用——CR-003 教训：无校验=边界裸奔）。 */
export function isValidParticipationGear(value: unknown): value is ParticipationGear {
  return participationGearSchema.safeParse(value).success;
}

/**
 * Story 3.5 CR-011：balancedAskCategories 归一——safeParse 数组（每条 enum 校验，拒绝非 enum 垃圾）+
 * 拒空 `[]`（mirror zod .min(1)——空数组不属「未设」也非「圈定」任一状态，第三态致下游 every 恒真误判）。
 * 失败 → undefined（消费端回退 BALANCED_ASK_CATEGORIES_DEFAULT 三项全）。
 */
export function normalizeBalancedAskCategories(
  value: unknown,
): BalancedAskCategory[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = z.array(balancedAskCategorySchema).min(1).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Story 3.5 CR-010：trustAdjudication 归一——仅 true（受信任）原样保留；非 boolean（含 truthy 垃圾如
 * 'true' 字符串 / 1）一律 → undefined（消费端回退 false）。防 truthy 垃圾把 trust 翻成**不安全向**。
 */
export function normalizeTrustAdjudication(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function createSession(
  agentNameOrOptions: string | CreateSessionOptions,
  projectPathArg?: string,
): SessionState {
  const options = typeof agentNameOrOptions === 'string'
    ? {
        agentName: agentNameOrOptions,
        projectPath: projectPathArg as string,
      }
    : agentNameOrOptions;
  const session: SessionState = {
    id: options.id ?? randomUUID(),
    agentName: options.agentName,
    projectPath: options.projectPath,
    status: 'idle',
    permissionMode: options.permissionMode ?? 'suggest',
    behaviorMode: options.behaviorMode ?? 'normal',
    // Story 3.5: 非枚举垃圾值防御性归一 'smart'（loadSession 只对 undefined 缺省，junk 不落盘——mirror IPC 边界校验意图）。
    participationGear: isValidParticipationGear(options.participationGear)
      ? options.participationGear
      : PARTICIPATION_GEAR_DEFAULT,
    messages: options.messages ?? [],
    parentId: options.parentId,
    children: options.children ?? [],
    branchFromMessageId: options.branchFromMessageId,
    sessionRole: options.sessionRole,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    skillRunState: undefined,
  };
  sessions.set(session.id, session);
  persistSession(session);
  if (session.messages.length > 0) {
    overwriteMessagesFile(session.projectPath, session.id, session.messages);
  }
  return session;
}

export function getSession(id: string): SessionState | undefined {
  const s = sessions.get(id);
  if (s) touchSession(id);
  return s;
}

export function loadSession(id: string, projectPath: string): SessionState | undefined {
  if (sessions.has(id)) return sessions.get(id);
  const meta = loadSessionMeta(projectPath, id);
  const messages = loadMessagesFromFile(projectPath, id);
  if (messages.length === 0 && !meta) return undefined;
  const session: SessionState = {
    id,
    agentName: meta?.agentName ?? 'writer',
    projectPath,
    status: meta?.status ?? 'idle',
    permissionMode: meta?.permissionMode ?? 'suggest',
    behaviorMode: meta?.behaviorMode ?? 'normal',
    // Story 3.5: 旧会话无字段 → 缺省 'smart'；磁盘垃圾值防御性归一（同 createSession）。
    participationGear: isValidParticipationGear(meta?.participationGear)
      ? meta.participationGear
      : PARTICIPATION_GEAR_DEFAULT,
    // CR-010 / CR-011：balancedAskCategories / trustAdjudication 归一（safeParse/typeof——
    // 垃圾值（非 enum 类别 / 非布尔 truthy）→ undefined → 消费端回退契约默认三项全 / false，
    // 防每 turn TypeError 或 trust 翻成不安全向；空 `[]` 第三态亦拒（mirror zod .min(1)）。
    balancedAskCategories: normalizeBalancedAskCategories(meta?.balancedAskCategories),
    trustAdjudication: normalizeTrustAdjudication(meta?.trustAdjudication),
    // 链流程重排 W2：hardEscalatePolicy 归一（'auto' 才原样保留——垃圾值 → undefined → 消费端回退
    // 'ask' 安全默认，mirror normalizeTrustAdjudication 的安全向归一哲学）。
    hardEscalatePolicy: meta?.hardEscalatePolicy === 'auto' ? 'auto' : undefined,
    messages,
    parentId: meta?.parentId,
    children: meta?.children ?? [],
    branchFromMessageId: meta?.branchFromMessageId,
    sessionRole: meta?.sessionRole,
    createdAt: meta?.createdAt ?? messages[0]?.createdAt ?? Date.now(),
    updatedAt: meta?.updatedAt ?? messages[messages.length - 1]?.createdAt ?? Date.now(),
    error: meta?.error,
    skillRunState: meta?.skillRunState,
    contextState: meta?.contextState,
    pinnedContext: meta?.pinnedContext,
  };
  sessions.set(id, session);
  touchSession(id);
  return session;
}

export function deleteSession(id: string): boolean {
  const session = sessions.get(id);
  if (session) {
    deletePersistedSession(session.projectPath, id);
  }
  return sessions.delete(id);
}

export type TruncateSessionResult =
  | { ok: true; removed: number }
  | { ok: false; reason: 'not-found' | 'running' | 'tool-activity' };

/**
 * 从此截断（dogfood 2026-08-21 用户拍板）：丢弃 messageId 及其后的全部消息——内存
 * SessionState（下一轮上下文重放的来源）+ JSONL 原子重写 + SQLite message_count/meta
 * 三处一致。截掉的只是尾巴，保留前缀原样 → 上下文重放只可能变短，无历史分叉。
 *
 * **纯对话尾巴闸门**：被截区间含任何工具痕迹（role 'tool' / toolCalls / toolResults）
 * 一律拒绝——含只读工具也拒（UI 侧无可靠读写分类元数据，宁严勿漏；runtime 暴露分类
 * 后可放宽）。工具/子代理的副作用留在世上而历史忘了它 = 分叉 bug 源（用户点名：
 * SubAgent 下派过的段不可回退）。运行中会话同样拒绝。
 */
export function truncateSessionFromMessage(id: string, messageId: string): TruncateSessionResult {
  const session = sessions.get(id);
  if (!session) return { ok: false, reason: 'not-found' };
  if (session.status === 'running') return { ok: false, reason: 'running' };
  const index = session.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return { ok: false, reason: 'not-found' };
  const tail = session.messages.slice(index);
  const hasToolActivity = tail.some(
    (m) => m.role === 'tool' || (m.toolCalls?.length ?? 0) > 0 || (m.toolResults?.length ?? 0) > 0,
  );
  if (hasToolActivity) return { ok: false, reason: 'tool-activity' };
  session.messages = session.messages.slice(0, index);
  session.updatedAt = Date.now();
  // contextState/skillRunState 快照为 advisory（contextManager 按 messages 重建），随保留前缀语义不变。
  overwriteMessagesFile(session.projectPath, id, session.messages);
  persistSession(session);
  return { ok: true, removed: tail.length };
}

/**
 * Story 3.5 CR-007：会话在内存或磁盘上是否还存在（内存 LRU / meta.json / jsonl 任一命中）。
 * 供批量单活跃守卫区分「他 会话 活跃（保护不可操作）」vs「孤儿批量（属主会话已删——本会话可接管/收口）」。
 * 只做存在性探测，不 load 进 LRU（loadSessionMeta 轻读单文件；messages 文件缺席时 fallback）。
 */
export function sessionExistsOnDisk(projectPath: string, id: string): boolean {
  if (sessions.has(id)) return true;
  if (loadSessionMeta(projectPath, id) !== undefined) return true;
  return loadMessagesFromFile(projectPath, id).length > 0;
}

export function addMessage(sessionId: string, message: SessionMessage): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!message.retention) {
    message.retention = classifyRetention(message);
  }
  session.messages.push(message);
  session.updatedAt = Date.now();
  appendMessageToFile(session.projectPath, sessionId, message);
}

function classifyRetention(msg: SessionMessage): RetentionPriority {
  if (msg.role === 'user') return 'critical';
  if (msg.role === 'tool') {
    const totalOutput = msg.toolResults?.reduce((sum, r) => sum + r.output.length, 0) ?? 0;
    return totalOutput > 2000 ? 'compressible' : 'normal';
  }
  return 'normal';
}

export function updateStatus(sessionId: string, status: SessionState['status'], error?: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.status = status;
  if (error) session.error = error;
  session.updatedAt = Date.now();
  persistSession(session);
}

export function updateSessionPermissionMode(
  sessionId: string,
  permissionMode: SessionPermissionMode,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.permissionMode = permissionMode;
  session.updatedAt = Date.now();
  persistSession(session);
}

export function updateSessionBehaviorMode(
  sessionId: string,
  behaviorMode: AgentBehaviorMode,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.behaviorMode = behaviorMode;
  session.updatedAt = Date.now();
  persistSession(session);
}

/**
 * Story 3.5: 更新会话参与档位（含 balanced 圈类别 / hands_off trustAdjudication，additive optional
 * 只更新显式提供的键）。mirror updateSessionBehaviorMode——field 写入 + persistSession。
 *
 * ⚠️ 调用方负责运行时 enum 校验（isValidParticipationGear / balancedAskCategorySchema）——
 * 本函数信任 caller（workflow setter 校验后调；chat 的 set_participation_gear 工具经 zod tool
 * schema 校验后调）。
 */
export function updateSessionParticipationGear(
  sessionId: string,
  gear: ParticipationGear,
  options?: { balancedAskCategories?: BalancedAskCategory[]; trustAdjudication?: boolean },
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.participationGear = gear;
  if (options?.balancedAskCategories !== undefined) {
    session.balancedAskCategories = options.balancedAskCategories;
  }
  if (options?.trustAdjudication !== undefined) {
    session.trustAdjudication = options.trustAdjudication;
  }
  session.updatedAt = Date.now();
  persistSession(session);
}
