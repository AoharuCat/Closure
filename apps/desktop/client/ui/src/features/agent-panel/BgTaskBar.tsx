import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { roleLabel } from './toolMeta';
import { sameProjectPath } from '../../shared/store/projectRunBusy';
import { abortAgentRun } from '../../shared/api/agent';
import type { AgentBgTaskStatus, AgentBgTaskView } from '../../shared/store/agentEvents';

// ── W4（09-21-subagent-bg-decouple §6.2 U5/U7 + §6.1 检视态标注）──
//
// 「后台任务」条 + 子会话检视图头部——两个消费 bgTasksByChildSession / agentRunStates 的新面。
// 任务条 mirror chainRunAnchorByProject 锚定先例：**不进消息流**（后台任务不是 leader 对话的
// 一部分——ChildExecutionGroup 数据源假设 = child 事件冒泡进 leader sid，bg 车道天然不满足），
// 独立条挂在 AgentPanel 消息区上方，bg-update / child lane 事件驱动，四态呈现 + running 取消
// （abort-run 既有通道，child sid 键控）+ 钻取（switchAgentSession 进检视图）。

/** 状态 → {i18nKey, icon}（未知 status 走兜底条目——wire 字符串不作封闭枚举假设）。 */
function bgTaskStatusPresentation(status: AgentBgTaskStatus | string): { key: string; icon: string; tone: string } {
  switch (status) {
    case 'running': return { key: 'agent.bgTaskRunning', icon: 'progress_activity', tone: 'running' };
    case 'completed': return { key: 'agent.bgTaskCompleted', icon: 'check_circle', tone: 'completed' };
    case 'failed': return { key: 'agent.bgTaskFailed', icon: 'error', tone: 'failed' };
    case 'aborted': return { key: 'agent.bgTaskCancelled', icon: 'cancel', tone: 'aborted' };
    case 'interrupted': return { key: 'agent.bgTaskInterrupted', icon: 'power_off', tone: 'interrupted' };
    default: return { key: 'agent.bgTaskUnknown', icon: 'help', tone: 'unknown' };
  }
}

/** 耗时粗粒度（相位可见纪律：运行中至少给出量级；<1s 归 0s 防负数）。 */
function formatElapsed(ms: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return t('agent.elapsedSeconds', { value: totalSec });
  const min = Math.floor(totalSec / 60);
  if (min < 60) return t('agent.elapsedMinutes', { value: min });
  return t('agent.elapsedHours', { value: Math.floor(min / 60), rest: min % 60 });
}

/** 当前项目可见的后台任务条目（projectPath 缺席 = 通配当前项目，mirror run 态 undefined 语义）。 */
export function bgTaskEntriesForProject(
  entries: Record<string, AgentBgTaskView>,
  projectPath: string | undefined,
): AgentBgTaskView[] {
  const out = Object.values(entries).filter(
    (e) => projectPath === undefined || e.projectPath === undefined || sameProjectPath(e.projectPath, projectPath),
  );
  // running 优先（活跃任务扫读第一眼），组内按最近更新倒序。
  out.sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return out;
}

/**
 * CR-20：任务条渲染帽——一次至多渲染 8 张卡（会话生命周期内终态卡会累积，无界堆积会吃满
 * 消息区上方空间）；超出部分以溢出注记呈现（最新 8 + 「还有 N 条较早记录」）。agent 侧
 * registry 终态帽 10 是持久化面，本帽是呈现面（二者独立：UI 条目随项目/删除清理，registry
 * 随对账清理）。running 卡永不因帽隐藏（排序置顶保证）。
 */
const BG_TASK_BAR_RENDER_CAP = 8;

export function BgTaskBar() {
  // selector 只取稳定引用（store 记录对象/字符串）——派生数组在 useMemo 算（useShallow 只做
  // 一层浅比较，selector 内新建数组 = 每次不等 = 无限重渲，React getSnapshot 环）。
  const {
    tasks, projectPath, agentSessionId, switchAgentSession,
  } = useAppStore(useShallow((s) => ({
    tasks: s.bgTasksByChildSession,
    projectPath: s.currentProject?.path,
    agentSessionId: s.agentSessionId,
    switchAgentSession: s.switchAgentSession,
  })));
  const entries = useMemo(
    () => bgTaskEntriesForProject(tasks, projectPath),
    [tasks, projectPath],
  );
  const { resolvedLocale } = useAppStore(useShallow((s) => ({ resolvedLocale: s.resolvedLocale })));
  const { t } = useI18n(resolvedLocale);

  // running 条目耗时跳动（30s 粗粒度复核——相位可见；终态条目静止零开销）。
  const [, tick] = useState(0);
  const hasRunning = entries.some((e) => e.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (entries.length === 0) return null;

  // CR-20：渲染帽——最新 8 张 + 溢出注记（running 排序置顶永不隐藏）。
  const visible = entries.slice(0, BG_TASK_BAR_RENDER_CAP);
  const overflowCount = entries.length - visible.length;

  return (
    <div className="agent-bg-task-bar" role="status" aria-label={t('agent.bgTaskBarLabel')}>
      {visible.map((entry) => {
        const meta = bgTaskStatusPresentation(entry.status);
        const isRunning = entry.status === 'running';
        const elapsed = formatElapsed(
          (entry.status === 'running' ? Date.now() : entry.updatedAt) - entry.startedAt,
          t,
        );
        return (
          <div
            key={entry.childSessionId}
            className={`agent-bg-task-card agent-bg-task-card--${meta.tone}${entry.childSessionId === agentSessionId ? ' is-current-view' : ''}`}
          >
            <span
              className={`material-symbols-outlined agent-bg-task-icon${isRunning ? ' agent-bg-task-icon--spin' : ''}`}
              aria-hidden="true"
            >
              {meta.icon}
            </span>
            <span className="agent-bg-task-role" title={entry.digest ?? undefined}>
              {roleLabel(entry.role, t)}
            </span>
            <span className="agent-bg-task-status">{t(meta.key)}</span>
            <span className="agent-bg-task-elapsed">{elapsed}</span>
            {isRunning && (
              <button
                type="button"
                className="agent-bg-task-cancel"
                onClick={() => { void abortAgentRun(entry.childSessionId); }}
                title={t('agent.bgTaskCancel')}
                aria-label={t('agent.bgTaskCancel')}
              >
                <span className="material-symbols-outlined" aria-hidden="true">stop</span>
              </button>
            )}
            {entry.childSessionId !== agentSessionId && (
              <button
                type="button"
                className="agent-bg-task-inspect"
                onClick={() => { void switchAgentSession(entry.childSessionId); }}
                title={t('agent.childInspect')}
                aria-label={t('agent.childInspect')}
              >
                <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
              </button>
            )}
          </div>
        );
      })}
      {overflowCount > 0 && (
        <span className="agent-bg-task-overflow">{t('agent.bgTaskOverflow', { count: overflowCount })}</span>
      )}
    </div>
  );
}

/**
 * 子会话检视图头部（§6.1 标注条——相位可见纪律）：role / 状态 / 耗时 + 返回键（child →
 * parent；栈深 1，孙代 V1 不开）。仅在 agentViewReadonly（bg 子会话视图）挂载。
 */
export function ChildInspectHeader() {
  const {
    agentSessionId, agentViewSessionRole, runPhase, bgTask,
    returnToParentSession,
  } = useAppStore(useShallow((s) => ({
    agentSessionId: s.agentSessionId,
    agentViewSessionRole: s.agentViewSessionRole,
    // CR-11：返回导航统一走 slice 的 returnToParentSession（父已删 tombstone → 回落新会话草稿，
    // 不切进死会话）——本组件不再自行 switchAgentSession(parent)。
    runPhase: s.agentSessionId ? s.agentRunStates[s.agentSessionId]?.phase : undefined,
    bgTask: s.agentSessionId ? s.bgTasksByChildSession[s.agentSessionId] : undefined,
    returnToParentSession: s.returnToParentSession,
  })));
  const { resolvedLocale } = useAppStore(useShallow((s) => ({ resolvedLocale: s.resolvedLocale })));
  const { t } = useI18n(resolvedLocale);

  // 状态优先取后台任务条目（五态全）；无条目（如同步子会话被钻入）回落 run 态相位。
  const status: AgentBgTaskStatus | undefined = bgTask?.status
    ?? (runPhase === 'running' ? 'running' : runPhase === 'error' ? 'failed' : undefined);
  const meta = status ? bgTaskStatusPresentation(status) : null;
  const isRunning = status === 'running';
  // hooks 须先于早返（rules of hooks）——非 child 视图时下方 return null 只裁 JSX。
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(timer);
  }, [isRunning]);

  if (!agentViewSessionRole || agentViewSessionRole !== 'child' || !agentSessionId) return null;

  return (
    <div className="agent-child-inspect-header" role="status">
      <span className="material-symbols-outlined" aria-hidden="true">smart_toy</span>
      <span className="agent-child-inspect-label">{t('agent.childViewReadonlyBadge')}</span>
      <span className="agent-child-inspect-role">
        {bgTask ? roleLabel(bgTask.role, t) : t('agent.subAgent')}
      </span>
      {meta && (
        <>
          <span className={`agent-child-inspect-status agent-bg-task-card--${meta.tone}`}>{t(meta.key)}</span>
          {bgTask && (
            <span className="agent-child-inspect-elapsed">
              {formatElapsed(
                (status === 'running' ? Date.now() : bgTask.updatedAt) - bgTask.startedAt,
                t,
              )}
            </span>
          )}
        </>
      )}
      <button
        type="button"
        className="agent-child-inspect-back"
        onClick={() => returnToParentSession()}
        title={t('agent.childViewBack')}
      >
        <span className="material-symbols-outlined" aria-hidden="true">undo</span>
        {t('agent.childViewBack')}
      </button>
    </div>
  );
}
