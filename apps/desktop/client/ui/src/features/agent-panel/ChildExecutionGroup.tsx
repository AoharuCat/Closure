import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { AgentMessage } from '../../shared/store/agentSlice';
import { childTagPrefix } from '../../shared/store/agentStreamBuffer';
import { childGroupGraceRemainingMs, getChildSessionIdForTag, isChildGroupDispatchActive } from '../../shared/store/agentEvents';
import { AgentMessageItem } from './AgentMessageItem';
import { Collapsible } from '../../shared/components/Collapsible';
import { childGroupAction, hasLivePlaceholder } from './messageGrouping';
import { toolLabel, roleLabel } from './toolMeta';

type Props = {
  source: 'skill' | 'subagent';
  role: string;
  depth: number;
  messages: AgentMessage[];
  isLatestGroup?: boolean;
  /** dogfood R2 #9：全流已落地 toolCallId 集（AgentMessages 单源计算传入）——调用徽标去重。 */
  resolvedToolCallIds?: ReadonlySet<string>;
  /**
   * dogfood T1 CR-T1-046（§7.7 动画收敛）：多 live child 组并流时同类持续动画至多一处
   * ——AgentMessages 只给**首个** live 组传 true（其余活跃组静态 progress 图标承载语义，
   * 面板聚合徽标图标不旋转）。缺省 true（独立渲染/单组时照旧旋转）。
   */
  isForemost?: boolean;
};

/**
 * dogfood T1 Stage 5（design §6.4/§7.3，D5）：子 agent 执行组的活跃可见性。
 *
 * - 活跃判定（dogfood T1 CR-T1-036，**整次派发级**非 turn 级）：组内 live streaming 占位
 *   在，或 leader run 在途且该组在迟滞窗（CHILD_DISPATCH_GRACE_MS，agentEvents 按 tag
 *   维度记录每个 child 事件）内有事件。child 多 turn 循环每 turn 间隙占位被终帧替换——
 *   旧 live-only 判定会把工具执行窗误判成「组完成」（自动收起 + doneFlash 假完成绿闪 +
 *   旋转图标停转 + chip 消失 + 面板徽标 null，一轮 N 次）。leader run 终态时迟滞即失效
 *   （真完成立即收起，无延迟感）。
 * - 活跃 → Collapsible 自动展开；完成 → 自动收起。**用户手动展开/收起的所有权保留**
 *   （openRef/autoExpandedRef/userLastManualRef 跟踪）——用户手动展开的组完成后保持展开；
 *   CR-T1-039：用户手动收起后，后续再转活跃**不强制展开**（自动展开只在「从未手动操作」
 *   或「用户上次手动态是展开」时发生——旧实现只防收起方向，展开方向每次激活都抢）。
 * - 头部「当前动作」标签（活跃且展开时）：`第 N 步 · 工具名`（N = 组内 tool 消息计数，
 *   工具名 = 最新 tool 消息的最新 toolResult 名，经 toolMeta 映射翻译——dogfood #38 中文化）。
 * - 完成过渡：头部回中性色 + success 状态点一闪（1s 后淡出，--duration-slow 节奏）。
 * - 旋转图标（CR-T1-046）：仅 `active && isForemost` 旋转（同类至多一处）。
 */
export function ChildExecutionGroup({ source, role, depth, messages, isLatestGroup, resolvedToolCallIds, isForemost = true }: Props) {
  const { resolvedLocale, activeSessionRunning } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    activeSessionRunning: s.activeSessionRunning,
  })));
  const { t } = useI18n(resolvedLocale);

  // CR-T1-036：组级活跃 = live 占位 ∨（leader run 在途 ∧ 迟滞窗内有 child 事件）。
  const tag = childTagPrefix({ source, role, depth });
  // W4（09-21-subagent-bg-decouple）：tag → childSessionId 映射（dispatcher child 分支登记）
  // ——组卡钻取入口；无记录（该组尚未收到 child 事件）不显钮。
  const childSessionId = getChildSessionIdForTag(tag);
  const liveActive = useMemo(() => hasLivePlaceholder(messages), [messages]);
  const dispatchActive = isChildGroupDispatchActive(tag, liveActive, activeSessionRunning);
  const active = dispatchActive;
  const action = useMemo(
    () => (active ? childGroupAction(messages) : null),
    [active, messages],
  );

  const icon = source === 'skill' ? 'extension' : 'smart_toy';
  const sourceLabel = source === 'skill' ? t('agent.childSkill') : t('agent.childSubagent');

  // 受控开合 + 自动展开所有权跟踪（见组件 docstring）。
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const autoExpandedRef = useRef(false);
  /** CR-T1-039：用户最近一次手动开合的落点（null = 从未手动操作）——自动展开方向的所有权。 */
  const userLastManualRef = useRef<'open' | 'closed' | null>(null);
  const wasActiveRef = useRef(false);
  const [doneFlash, setDoneFlash] = useState(false);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CR-T1-036：迟滞到期复核——live 消失但 leader 在途期间，到窗尾定时强制重渲一次
  //（无事件流动时 Map 的衰老不会触发重渲）；复核后仍活跃则重排下一次（事件刷新过窗）。
  const [, forceTick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (!dispatchActive || liveActive || !activeSessionRunning) return;
    const timer = setTimeout(forceTick, childGroupGraceRemainingMs(tag) + 1);
    return () => clearTimeout(timer);
  }, [dispatchActive, liveActive, activeSessionRunning, tag, messages.length, forceTick]);

  const applyOpen = (next: boolean, byAuto: boolean) => {
    openRef.current = next;
    autoExpandedRef.current = next ? byAuto : false;
    if (!byAuto) userLastManualRef.current = next ? 'open' : 'closed';
    setOpen(next);
  };

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active === wasActive) return;
    if (active) {
      // 转活跃：用户未展开过且未被用户手动收起 → 自动展开（automation 拿所有权）；
      // CR-T1-039：用户上次手动收起过 → 不抢展开方向（所有权归用户）。
      if (!openRef.current && userLastManualRef.current !== 'closed') applyOpen(true, true);
      return;
    }
    // 活跃 → 完成：只在 automation 持有所有权时收起（用户手动展开过的组不改）；
    // 头部 success 状态点一闪（design §7.3 组完成过渡）。
    if (autoExpandedRef.current) applyOpen(false, false);
    setDoneFlash(true);
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    doneTimerRef.current = setTimeout(() => setDoneFlash(false), 1000);
  }, [active]);

  useEffect(() => () => {
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
  }, []);

  // Story 3.5 Step 7: the hand-rolled open/close idiom moved into the shared
  // <Collapsible> — same DOM (incl. the --depth custom property), same
  // default-collapsed state. dogfood T1 Stage 5: controlled open for the
  // auto expand/collapse lifecycle above (default-collapsed zero regression
  // for history groups — mount inactive takes no transition).
  return (
    <Collapsible
      className={`agent-child-group${active ? ' agent-child-group--active' : ''}`}
      style={{ '--depth': depth } as React.CSSProperties}
      headerClassName="agent-child-group-header"
      bodyClassName="agent-child-group-body"
      chevron="end"
      chevronIcons={{ open: 'expand_more', closed: 'chevron_right' }}
      chevronClassName="agent-child-group-chevron"
      open={open}
      onToggle={(next) => applyOpen(next, false)}
      header={
        <>
          {/* CR-T1-046：仅 foremost 活跃组旋转（同类至多一处）；其余活跃组静态
              progress_activity 图标（reduced-motion 同款降级形态）承载活跃语义。 */}
          <span
            className={`material-symbols-outlined agent-child-group-icon${active && isForemost ? ' agent-child-group-icon--spin' : ''}`}
            aria-hidden="true"
          >
            {active ? 'progress_activity' : icon}
          </span>
          <span className="agent-child-group-label">{sourceLabel} · {roleLabel(role, t)}</span>
          {/* 「当前动作」chip（design §7.3）：活跃且展开时显示——dogfood 第二轮 findings #3 起
              步期（组尚无 tool 消息，含 started 占位空窗）回落「启动中…」；N 步 ≥1 走既有
              「第 N 步 · 工具名」。工具名经 toolMeta 映射翻译（dogfood #38），无映射 id 回落原文。 */}
          {active && open && action && (
            <span className="agent-child-group-action">
              {action.step > 0
                ? <>{t('agent.childStep', { step: action.step })} · {action.toolName ? toolLabel(action.toolName, t) : ''}</>
                : t('agent.childStarting')}
            </span>
          )}
          {depth > 1 && <span className="agent-child-group-depth">d{depth}</span>}
          {/* W4：钻取钮（切进该子会话检视图——childSessionId 已知才显；stopPropagation 防触发
              组折叠）。CR-19：同步子会话 jsonl 恒空（消息只进父流）→ 钻取是空会话死胡同——
              禁用 + title 说明；后台子会话不受影响（走 BgTaskBar 任务条钻取，其自身 jsonl 落盘）。
              检视只读语义由目标视图自身承载（agentViewReadonly → 输入面横幅）。 */}
          {childSessionId && (
            <button
              type="button"
              className="agent-child-group-inspect"
              disabled
              onClick={(e) => e.stopPropagation()}
              title={t('agent.childInspectDisabled')}
              aria-label={t('agent.childInspectDisabled')}
            >
              <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            </button>
          )}
          {/* 活动状态点（design §7.3）：收起态活跃时留在头部右侧；完成时转 success 一闪。 */}
          {active && !open && <span className="agent-child-group-dot" aria-hidden="true" />}
          {doneFlash && <span className="agent-child-group-dot agent-child-group-dot--done" aria-hidden="true" />}
          <span className="agent-child-group-count">{messages.length}</span>
        </>
      }
    >
      {messages.map((msg, i) => (
        <AgentMessageItem
          key={msg.id}
          message={msg}
          isLatest={isLatestGroup && i === messages.length - 1}
          resolvedToolCallIds={resolvedToolCallIds}
        />
      ))}
    </Collapsible>
  );
}
