import { useCallback, useRef, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { useConfirmStore } from '../../shared/store/confirmStore';
import { useToastStore } from '../../shared/store/toastStore';
import type { AgentMessage } from '../../shared/store/agentSlice';
// dogfood T1 CR-T1-048：链卡 paused resume 入口走结构化 IPC（mirror ChapterReviewPanel 三动作）；
// busy 拒绝解析 + 项目锚归一单源。
import { resumeChapterChain } from '../../shared/api/agent';
import { normalizeProjectPathForCompare, parseChainBusyError, showRunBusyToast, showChainRunBusyToast } from '../../shared/store/projectRunBusy';
import { AgentMessageItem } from './AgentMessageItem';
import { ChildExecutionGroup } from './ChildExecutionGroup';
import { BatchGroup } from './BatchGroup';
import { BatchReportCard } from './BatchReportCard';
// dogfood T1 Stage 6（design §4/§7.5）：写章链运行卡——当前会话有活跃（含中断/失败保留、
// paused 精简）链 run 时挂载；completed 卸载（审阅/落盘流程接管）。
import { ChainRunCard } from './ChainRunCard';
// 09-12 子2 fallback chains（design §8②⑤）：运行期模型可见性——当前模型 chip + 回退通知条。
import { fallbackKindLabelKey, modelDisplayName } from '../../shared/model/modelDisplay';
import type { ModelConfig } from '@orison/shared-contracts';
import type { ModelFallbackNotice, BridgeNotice } from '../../shared/store/agentEvents';
import {
  groupMessages,
  hasLivePlaceholder,
  lastReportMessageByBatch,
  lastRetryableUserContent,
} from './messageGrouping';

type Props = {
  messages: AgentMessage[];
  loading: boolean;
  error: string | null;
};

// CR-22：稳定空数组引用（selector 的 ?? 兜底）——模块级常量。组件体内声明会在每次
// render 重建引用，恰好击穿「避免 useSyncExternalStore 快照抖动」的注释意图（selector
// 闭包引用模块级常量没有障碍，原先「不可行」的注释是错的）。
const EMPTY_NOTICES: ModelFallbackNotice[] = [];
const EMPTY_BRIDGE_NOTICES: BridgeNotice[] = [];

export function AgentMessages({ messages, loading, error }: Props) {
  const { resolvedLocale } = useAppStore(useShallow((s) => ({ resolvedLocale: s.resolvedLocale })));
  const { t } = useI18n(resolvedLocale);
  const sendAgentMessage = useAppStore((s) => s.sendAgentMessage);
  const truncateAgentMessages = useAppStore((s) => s.truncateAgentMessages);
  const requestConfirm = useConfirmStore((s) => s.requestConfirm);
  const showToast = useToastStore((s) => s.showToast);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 从此截断亲和性（dogfood 2026-08-21）：从尾往前的累计「纯对话」判定——该条可截 ⇔
  // 它及其后全部无工具痕迹（role 'tool' / toolCalls / toolResults）。含只读工具也禁
  // （UI 无可靠读写分类，宁严勿漏；runtime 二次同款把关）。批量/子代理组不接按钮
  // （组内即工具执行，闸门必然拒）。
  const canTruncateFrom = useMemo(() => {
    const map = new Map<string, boolean>();
    let tailPure = true;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const pure = m.role !== 'tool' && !(m.toolCalls?.length) && !(m.toolResults?.length);
      tailPure = tailPure && pure;
      map.set(m.id, tailPure);
    }
    return map;
  }, [messages]);

  // dogfood R2 #16：intent-confirm 快捷按钮删除（用户拍板——与输入框冲突、quick reply 价值薄）。
  // 「确认执行/改意图」改由作者直接在输入框打字回应；present_result 收尾契约（loop 校验）不受影响。

  // CR-T1-042：useCallback 按 messageId 参数化——旧 inline 闭包 `() => void handleTruncateFrom(id)`
  // 每 render 新建，memo 的 AgentMessageItem 全部击穿（250ms flush 全量重渲）。t 随 locale
  // 稳定、store 动作引用稳定，loading 罕变 → 回调引用跨 flush 稳定。
  const handleTruncateFrom = useCallback(async (messageId: string) => {
    if (loading) return;
    const list = useAppStore.getState().agentMessages;
    const index = list.findIndex((m) => m.id === messageId);
    if (index === -1) return;
    const count = list.length - index;
    const confirmed = await requestConfirm({
      title: t('agent.truncateConfirmTitle'),
      message: t('agent.truncateConfirmDesc', { count }),
      confirmLabel: t('agent.truncateConfirmLabel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    const result = await truncateAgentMessages(messageId);
    if (!result.ok) showToast(t('agent.truncateBlocked'), 'error');
  }, [loading, t, truncateAgentMessages, requestConfirm, showToast]);

  // system 稳定化（09-12）：session_state_note = turn 开始追加的 interaction 状态注记
  //（user-role 系统消息，给 LLM 的状态广播）——UI 静默不渲染（jsonl 落盘保留审计）。
  // 在分组上游过滤，连 BatchGroup/single 分组逻辑都不进。
  const grouped = useMemo(
    () => groupMessages(messages.filter((m) => m.kind !== 'session_state_note')),
    [messages],
  );
  // dogfood R2 #9：全流已落地的 toolCallId 集（结果卡已渲染的调用）——传给各消息项隐去
  // 对应调用徽标（一次动作不再「徽标 + 结果卡」双打；徽标退为执行中指示）。
  // useMemo 保持引用稳定（AgentMessageItem 是 memo 的，每 render 新 Set 会击穿）。
  const resolvedToolCallIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      for (const tr of m.toolResults ?? []) {
        if (tr.toolCallId) set.add(tr.toolCallId);
      }
    }
    return set;
  }, [messages]);
  // dogfood T1 CR-T1-046（§7.7 动画收敛）：多 live child 组并流时同类旋转至多一处——
  // 只把**首个**（列表序最前，读序确定）live 组标为 foremost。
  const foremostLiveChildGroupIndex = useMemo(() => {
    for (let i = 0; i < grouped.length; i++) {
      const g = grouped[i];
      if (g.type === 'child-group' && hasLivePlaceholder(g.messages)) return i;
    }
    return -1;
  }, [grouped]);
  // CR-P8（09-13 稳定化 CR 批）：isLatest 判定基线取**渲染流**末条——原始 messages 末条在
  // 注记垫尾窗口恒指隐藏的 session_state_note，isLatest/isLastOverall 恒不命中任何渲染组。
  // 与 grouped 同口径过滤（单一 truth：kind ≠ session_state_note）。
  const renderableMessages = messages.filter((m) => m.kind !== 'session_state_note');
  const lastMessage = renderableMessages[renderableMessages.length - 1];
  // dogfood T1 Stage 4（design §6.2 尾坑 / r4 必踩坑）：流式 delta 更新**同一条**消息的
  // content（messages.length 不变）——旧依赖数组不触发跟随滚动，用户看流式正文时面板不跟。
  // dogfood T1 CR-T1-044：口径统一为**全表扫** streaming 游标——并行 spawn_agent 双占位时
  // 非末条增长同样触发跟随（旧「最后一条 content 长度」口径漏非末条）。+1 计数让空占位
  // （content 空串）的出现/消失本身也是跟随事件。
  // dogfood R2 #11（findings #11② 外层）：reasoning 增长同样计数——思考折叠块默认展开后，
  // 其增长会把正文顶出视口，面板必须跟随（reasoning 常先于正文到达且可独立增长）。
  const streamingCursor = useMemo(() => {
    let cursor = 0;
    for (const m of messages) {
      if (m.streaming === true) cursor += m.content.length + (m.reasoning?.length ?? 0) + 1;
    }
    return cursor;
  }, [messages]);
  // 全局三点 loading 与流式占位内的三点让位（同屏双指示冗余，design §7.1 无空窗闪跳——
  // 占位自带同款 loading 态）。
  const hasStreamingMessage = useMemo(() => messages.some((m) => m.streaming === true), [messages]);
  // Story 3.5：每批量唯一的 BatchReportCard 挂卡点 = 该批量最后一条 report assistant 消息
  // （L0 全景文本本身）。end_batch 翻章后同 turn 的工具结果/中间 assistant 文本也带 report
  // 标记——每条都挂卡会重复渲染（lastReportMessageByBatch 语义详见其 docstring）。
  const lastReportByBatch = useMemo(() => lastReportMessageByBatch(messages), [messages]);
  // 重试钮载荷：末条**真人** user 消息（error 呈现时 run 已终态，sendAgentMessage 可重入）。
  // dogfood T1 CR-T1-041：跳过 runtime 合成 user 消息（length 续写注入的
  // 'Continue from where you left off...' 经对账入 store——重发内部指令用户答非所问）。
  const retryContent = useMemo(() => lastRetryableUserContent(messages), [messages]);

  // dogfood T1 Stage 6：链运行卡——当前会话的链 run 非 completed 时挂载（r1：AgentMessages
  // 尾部统一挂载，leader/dogfood 两入口事件同 sessionId 广播天然统一）。completed 卸载
  //（ChapterReviewPanel / PatchReviewPanel / ReviewFindingsCard 接管审阅面）。
  // dogfood T1 CR-T1-048（decision 2A「项目级虚拟锚」）：dogfood 链车道每 run 新建 stub 会话
  //（≠ 视图会话）→ chainRunBySession[stubId] 永不被本门命中（卡片结构性不可见 + suggest 档
  // pause 零可见面无 resume 入口）。本会话无活跃卡时查项目锚（chainRunAnchorByProject，
  // agentEvents 链事件登记）兜底——一链只归一张卡（own 优先）；跨项目隔离靠归一 projectPath
  // 键；与 D4 单 run 一致（同项目同时至多一条链，批2 链守卫保证）。
  const chainRun = useAppStore(useShallow((s) => {
    const sid = s.agentSessionId;
    const own = sid !== null ? s.chainRunBySession[sid] : undefined;
    if (own && own.status !== 'completed') return { run: own, ownerSid: sid as string };
    const projectKey = s.currentProject?.path !== undefined
      ? normalizeProjectPathForCompare(s.currentProject.path)
      : null;
    const anchorSid = projectKey !== null ? s.chainRunAnchorByProject?.[projectKey] : undefined;
    const anchored = anchorSid !== undefined && anchorSid !== sid ? s.chainRunBySession[anchorSid] : undefined;
    if (anchored && anchored.status !== 'completed') return { run: anchored, ownerSid: anchorSid };
    return { run: null, ownerSid: null };
  }));
  // 链卡流式正文同样触发 stick-to-bottom（mirror S4 lastContentLength 补丁——卡片不在
  // messages 里，长度游标单独进依赖）。
  const chainStreamLength = chainRun.run?.streamText.length ?? 0;

  // ── 09-12 子2 fallback chains（design §8②⑤）：运行期模型可见性 ──
  // 通知条 = 本会话「本次 run」的切换记录（send 重置 / 会话删除清）；当前模型 chip 的
  // 初值 = UI 派生（dialogue 档 assignment——dialogueModelRefFromConfig 同款读法；无指派
  // 显示「自动」），model-fallback 事件到达时翻为接管模型（activeModelBySession）。
  const { fallbackNotices, activeModel, modelConfigForChip, bridgeNotices } = useAppStore(useShallow((s) => {
    const sid = s.agentSessionId;
    return {
      fallbackNotices: sid !== null ? s.modelFallbackNotices[sid] ?? EMPTY_NOTICES : EMPTY_NOTICES,
      activeModel: sid !== null ? s.activeModelBySession[sid] : undefined,
      modelConfigForChip: s.modelConfig as ModelConfig | undefined,
      // 子4 W6：桥运行期通知（本次 run 的记录；send 重置 / 会话删除清）。
      bridgeNotices: sid !== null ? s.bridgeNoticesBySession[sid] ?? EMPTY_BRIDGE_NOTICES : EMPTY_BRIDGE_NOTICES,
    };
  }));
  const generating = loading || hasStreamingMessage;
  const dialogueAssignment = modelConfigForChip?.taskModels?.dialogue;
  const chipModelRef = activeModel
    ?? (dialogueAssignment && dialogueAssignment.keyId && dialogueAssignment.modelId
      ? { keyId: dialogueAssignment.keyId, modelId: dialogueAssignment.modelId }
      : undefined);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    // CR-T1-044：streamingCursor（全表扫）替代旧「末条 content 长度 + 末条 streaming」
    // 双口径——任一 streaming 占位增长（含非末条）都触发跟随。
  }, [messages.length, loading, streamingCursor, chainStreamLength]);

  // dogfood 2026-08-21：切历史会话后直接落到底部（最新消息）。上面 stick-to-bottom
  // 闸门只在「离底 <120px」时跟随——新载入的长历史离底很远，被当成「用户主动离开
  // 底部」不再滚动；docked 视图切换重挂容器还会把 scrollTop 归零，于是停在对话开头。
  // 会话切换是视图置换不是增量追加：直接跳（非 smooth），用 scrollTop 赋值而非
  // scrollIntoView（后者可能连带滚动外层滚动容器）。挂 [agentSessionId]：切换才触发，
  // 重挂载时的首轮也让同会话重选落底；新会话/清空时 scrollHeight≈0 自然归顶。
  const agentSessionId = useAppStore((s) => s.agentSessionId);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // dogfood R2 #50：重开项目/刷新时跳底首帧布局可能晚 settle（末条全量 MD 高度、
    // 子组件异步提交——settle 本身是多帧过程，旧单帧复位追不上，落点偏短停在半途，
    // 用户实录：停在末条思考块上）。改**有限帧** rAF 循环（≤15 帧 ≈ ~250ms）：每帧
    // 把 scrollTop 拉回 scrollHeight；连续两帧 scrollHeight 不再变化即提前收工。
    // 仍不启常驻观察者（一次性会话切换；流内增长由上方 stick-to-bottom 跟随），
    // 帧数上限兜底防异常布局下的无限循环。
    const MAX_JUMP_FRAMES = 15;
    let frames = 0;
    // 基线 = 同步首跳当时的 scrollHeight——静态布局下首帧即判 settle
    // （赋值次数与旧「下一帧复位一次」实现一致，老用例契约不破）；动态布局随后
    // 每帧变化时进入多帧追底。
    let lastHeight = el.scrollHeight;
    let raf = 0;
    const tick = () => {
      const el2 = containerRef.current;
      if (!el2) return;
      el2.scrollTop = el2.scrollHeight;
      const settled = lastHeight === el2.scrollHeight;
      lastHeight = el2.scrollHeight;
      if (settled || ++frames >= MAX_JUMP_FRAMES) return;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [agentSessionId]);

  // ── dogfood T1 CR-T1-048：链卡 paused 态 resume 入口 ──
  // dogfood 链车道 pause 无 ChapterReviewPanel 承载（stub 会话无 chapter_review 事件面）——
  // 链卡是唯一可见面，paused 且视图会话无 pausedReview 时给 resume 钮（resume IPC 既有；
  // sessionId 用链持有会话 = ownerSid，chainSnapshot 按它键）。leader 路径 pausedReview 在
  // 时不给（面板承载三动作，design §7.5「不叠加」）。
  const pausedReviewForView = useAppStore((s) => (
    s.agentSessionId !== null ? s.pausedReviewBySession[s.agentSessionId] : undefined
  ));
  const chainResumeAvailable = chainRun.run?.status === 'paused' && !pausedReviewForView && chainRun.ownerSid !== null;
  const handleChainResume = () => {
    const ownerSid = chainRun.ownerSid;
    const projectPath = useAppStore.getState().currentProject?.path;
    if (!ownerSid || !projectPath) return;
    void resumeChapterChain({ projectPath, sessionId: ownerSid, action: 'continue' })
      .then((summary) => {
        if (summary.status !== 'error') return;
        // busy 拒绝（D4 闸 / 链守卫）→ 单源 toast（projectRunBusy）；其余 error → 告知不静默。
        const busy = parseChainBusyError(summary.errors);
        const locale = useAppStore.getState().resolvedLocale ?? 'zh-CN';
        if (busy) {
          if (busy.kind === 'chain_run_active') showChainRunBusyToast(locale);
          else {
            showRunBusyToast({
              heldBySessionId: busy.heldBySessionId,
              projectPath: busy.projectPath,
              locale,
              onJump: (sid) => { void useAppStore.getState().switchAgentSession(sid); },
            });
          }
          return;
        }
        useToastStore.getState().showToast(`链段续跑失败: ${summary.errors.join('; ')}`, 'error');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        useToastStore.getState().showToast(`链段续跑失败: ${msg}`, 'error');
      });
  };

  return (
    <div className="agent-messages" ref={containerRef}>
      {messages.length === 0 && !loading && (
        <div className="agent-messages-empty">
          <span className="material-symbols-outlined">smart_toy</span>
          {/* Story 8.6 D13：空态邀请卡——升级既有呈现位非新容器（对话即主入口）。示例 chip 点击
              即 sendAgentMessage(预填)——预填是普通用户消息走正常 send 链路，leader 侧靠雷达
              no 态识别冷启动（零识别特例）。有消息后不再显示（既有条件不变）。 */}
          <p className="agent-messages-empty-title">{t('agent.emptyTitle')}</p>
          <p>{t('agent.emptyHint')}</p>
          <div className="agent-messages-empty-chips">
            {[t('agent.emptyChipPerson'), t('agent.emptyChipWorld'), t('agent.emptyChipHook')].map((chip) => (
              <button key={chip} type="button" className="agent-empty-chip" onClick={() => sendAgentMessage(chip)}>
                {chip}
              </button>
            ))}
          </div>
        </div>
      )}
      {grouped.map((group, gi) => {
        if (group.type === 'batch') {
          // Story 3.5：连续同 batchId 契约字段分组（非文本正则），默认折叠。
          return (
            <BatchGroup
              key={`batch-${group.batchId}-${gi}`}
              batchId={group.batchId}
              messages={group.messages}
              isLastOverall={group.messages[group.messages.length - 1] === lastMessage}
              agentLoading={loading}
            />
          );
        }
        if (group.type === 'single') {
          const isLatest = group.message === lastMessage;
          // Story 3.5：report（锚点收尾 L0 全景）消息正文照常渲染，其下挂
          // BatchReportCard（L1 每章一行 → L2 输出摘要 → L3 全文）。消息本身
          // 不进折叠组——组默认折叠而 L0 必须可见（design §5.2）。卡只挂该批量
          // **最后一条** report assistant 消息（同 turn 早前的 report 标记消息
          // 只渲染正文，不重复挂卡）。
          if (
            group.message.role === 'assistant' &&
            group.message.batchKind === 'report' &&
            group.message.batchId &&
            lastReportByBatch.get(group.message.batchId) === group.message.id
          ) {
            return (
              <div key={`report-${group.message.id}`} className="agent-batch-report-slot">
                <AgentMessageItem message={group.message} isLatest={isLatest} resolvedToolCallIds={resolvedToolCallIds} />
                <BatchReportCard batchId={group.message.batchId} messages={messages} />
              </div>
            );
          }
          return (
            <AgentMessageItem
              key={group.message.id}
              message={group.message}
              isLatest={isLatest}
              resolvedToolCallIds={resolvedToolCallIds}
              canTruncateFrom={!loading && canTruncateFrom.get(group.message.id) === true}
              onTruncateFrom={handleTruncateFrom}
            />
          );
        }
        return (
          <ChildExecutionGroup
            key={`child-${gi}-${group.source}-${group.role}`}
            source={group.source}
            role={group.role}
            depth={group.depth}
            messages={group.messages}
            resolvedToolCallIds={resolvedToolCallIds}
            isLatestGroup={group.messages[group.messages.length - 1] === lastMessage}
            isForemost={gi === foremostLiveChildGroupIndex}
          />
        );
      })}
      {chainRun.run && (
        <ChainRunCard
          run={chainRun.run}
          onRetry={retryContent ? () => { void sendAgentMessage(retryContent); } : undefined}
          onResume={chainResumeAvailable ? handleChainResume : undefined}
        />
      )}
      {/* 09-12 子2：回退通知条（mirror stream-stalled 警示条形态——细条 role=status，非弹窗
          打扰）；本次 run 发生过切换才渲染。当前模型 chip 仅生成中显示（运行阶段可见性）。 */}
      {fallbackNotices.length > 0 && (
        <div className="agent-fallback-notices">
          {fallbackNotices.map((notice) => (
            <ModelFallbackNoticeStrip key={notice.id} notice={notice} t={t} modelConfig={modelConfigForChip} />
          ))}
        </div>
      )}
      {/* 子4 W6（design §8）：桥运行期通知（打回/二次未调/软拒）——运行阶段可见性纪律：
          不静默。mirror 回退通知条形态；soft-denied 带 warning 强度（AC7 指向授权机制）。 */}
      {bridgeNotices.length > 0 && (
        <div className="agent-bridge-notices">
          {bridgeNotices.map((notice) => (
            <BridgeNoticeStrip key={notice.id} notice={notice.notice} t={t} />
          ))}
        </div>
      )}
      {generating && (
        <div className="agent-current-model-chip" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">neurology</span>
          <span className="agent-current-model-label">{t('agent.currentModel')}</span>
          <span className="agent-current-model-value">
            {chipModelRef
              ? modelDisplayName(modelConfigForChip, chipModelRef)
              : t('agent.modelAuto')}
          </span>
        </div>
      )}
      {loading && !hasStreamingMessage && (
        <div className="agent-message-loading">
          <span className="agent-loading-dot" />
          <span className="agent-loading-dot" />
          <span className="agent-loading-dot" />
        </div>
      )}
      {error && (
        <div className="agent-message-error">
          <span className="material-symbols-outlined" aria-hidden="true">error</span>
          <span className="agent-message-error-text">{renderError(error, t)}</span>
          {/* dogfood T1 Stage 4（design §6.5/§7.6，D2）：重试钮 = 重发该会话末条 user 消息
              （sendAgentMessage 复用——D4 闸/防重入内建）。末条非 user（理论不达）不显钮。 */}
          {retryContent && (
            <button
              type="button"
              className="agent-message-error-retry"
              onClick={() => { void sendAgentMessage(retryContent); }}
            >
              {t('agent.retry')}
            </button>
          )}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// agentError holds either a raw backend message or an i18n key. Keys may carry a
// trailing detail as `agent.someKey: detail`; translate the key part and keep
// the detail. Anything not prefixed `agent.` is shown verbatim (backend text).
function renderError(error: string, t: (key: string) => string): string {
  if (!error.startsWith('agent.')) return error;
  const sep = error.indexOf(': ');
  if (sep === -1) return t(error);
  const key = error.slice(0, sep);
  const detail = error.slice(sep + 2);
  return `${t(key)}: ${detail}`;
}

/**
 * 09-12 子2：单条回退通知（「A 失败（配额或限流）→ 已切换 B」+ 链节点/子代理范围标注）。
 * 失败原因取 classifyGenerationFailure 的 kind 前缀映射短标签（未知 kind 回显原文前缀）。
 */
function ModelFallbackNoticeStrip({
  notice,
  t,
  modelConfig,
}: {
  notice: ModelFallbackNotice;
  t: (key: string, vars?: Record<string, string | number>) => string;
  modelConfig: ModelConfig | undefined;
}) {
  const kindKey = fallbackKindLabelKey(notice.reason);
  const reasonLabel = kindKey
    ? t(kindKey)
    : (notice.reason.split(':')[0]?.trim() || notice.reason);
  return (
    <div className="agent-fallback-notice" role="status">
      <span className="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
      <span>
        {t('agent.modelFallbackNotice', {
          from: modelDisplayName(modelConfig, notice.from),
          to: modelDisplayName(modelConfig, notice.to),
          reason: reasonLabel,
        })}
        {notice.scopeLabel ? (
          <span className="agent-fallback-notice-scope"> · {notice.scopeLabel}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * 子4 W6：单条桥运行期通知（三信号各有可见形态——运行阶段可见性纪律：不静默）：
 * - sendback（中性）：present_result 未按协议收尾 → 已打回重跑一次；
 * - sendback-missed（警示）：重跑后仍未收尾 → 接受结果并记录；
 * - soft-denied（警示）：工具调用被预授权策略拦下 → 指向设置页授权入口（AC7）。
 */
function BridgeNoticeStrip({
  notice,
  t,
}: {
  notice: BridgeNotice['notice'];
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const meta = BRIDGE_NOTICE_PRESENTATION[notice];
  return (
    <div className={`agent-bridge-notice agent-bridge-notice--${meta.tone}`} role="status">
      <span className="material-symbols-outlined" aria-hidden="true">{meta.icon}</span>
      <span>{t(meta.key)}</span>
    </div>
  );
}

const BRIDGE_NOTICE_PRESENTATION: Record<
  BridgeNotice['notice'],
  { icon: string; key: string; tone: 'neutral' | 'warn' }
> = {
  sendback: { icon: 'replay', key: 'agent.bridgeNoticeSendback', tone: 'neutral' },
  'sendback-missed': { icon: 'warning', key: 'agent.bridgeNoticeSendbackMissed', tone: 'warn' },
  'soft-denied': { icon: 'gpp_maybe', key: 'agent.bridgeNoticeSoftDenied', tone: 'warn' },
};
