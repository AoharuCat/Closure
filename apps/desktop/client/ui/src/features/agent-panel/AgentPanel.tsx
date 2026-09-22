import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { Tooltip } from '../../shared/components/Tooltip';
import { AgentMessages } from './AgentMessages';
import { AgentInput } from './AgentInput';
import { AgentHistory } from './AgentHistory';
import { AgentSettings } from './AgentSettings';
import { PatchReviewPanel } from './PatchReviewPanel';
// 09-13 子3 W4（design §5 / D2+D-g）：全尺寸审阅卡迁写作页——对话栏瘦身，挂载位换轻量提示。
import { ReviewPendingNotice } from './ReviewPendingNotice';
import { AuthorProfilePatchCard, pendingAuthorProfilePatchResults } from './AuthorProfilePatchCard';
import { SettingMdPatchCard, pendingSettingMdPatchResults } from './SettingMdPatchCard';
import { batchProgressFrom, findActiveBatch } from './batchMeta';
import { roleLabel } from './toolMeta';
import { GEAR_OPTIONS, gearLabelKey } from './gearMeta';
import { deriveChildActivity } from './messageGrouping';
// W4（09-21-subagent-bg-decouple §6.2 U5/U7）：后台任务条 + 子会话检视图头部（bg-update /
// child lane 事件驱动，不进消息流——mirror chainRunAnchorByProject 锚定先例的独立呈现面）。
import { BgTaskBar, ChildInspectHeader } from './BgTaskBar';
import type { ParticipationGear } from '@orison/shared-contracts';
import { deriveSessionBadge, getSessionProject, type SessionBadgeState } from '../../shared/store/agentEvents';
// 09-13 子3 CR-7（09-18 CR 批 B）：后台链待审卡的项目归属过滤（同 spec 路径比较单源纪律）。
import { sameProjectPath } from '../../shared/store/projectRunBusy';
import { compactAgentSession } from '../../shared/api/agent';
import { INBOX_UPLOAD_EXTENSIONS } from '../../shared/api/inboxAttachments';
// 09-01 B4（dogfood #45）：drop 图片分支接管——白名单与 canvas 预检压缩同源（单源常量）。
// CR-003a：识图转述进度订阅收口在 api 层（boundary rule——组件不直碰 window.orisonDesktop）。
import { CHAT_IMAGE_EXT_RE, subscribeImageRelayProgress } from '../../shared/api/chatImages';
// 09-12 子5 CR-13：余量条 title 原始 token 数千分位格式化（单源 numberFormat——与用量页同源）。
import { formatTokenCount } from '../../shared/utils/numberFormat';
import { useToastStore } from '../../shared/store/toastStore';
import { useEffect, useMemo, useRef, useState } from 'react';

type PanelView = 'chat' | 'history' | 'settings';

// 09-01 A4（R1.3/AC4）：拖拽分流正则——文档白名单单源 = A3 的 INBOX_UPLOAD_EXTENSIONS
//（shell 侧 importFiles 同表强制，renderer 只做分流不做安全闸）。
const INBOX_DOC_RE = new RegExp(
  `(${INBOX_UPLOAD_EXTENSIONS.map((ext) => ext.replace('.', '\\.')).join('|')})$`,
  'i',
);
// 图片白名单 = B4 预检压缩同表（CHAT_IMAGE_EXT_RE 单源——drop 分流与压缩拒收零漂移）。
const DROP_IMAGE_RE = CHAT_IMAGE_EXT_RE;

/**
 * CR-003a（决议 a）：识图转述进度条——shell generate 缝每图转述开始/完成各广播一次
 * `image-relay-progress`（{current, total}，全窗无会话定向），此处订阅显示「正在识图
 * 转述 i/N」。末帧（current===total）后 ~2s 自动消隐（简化实现：不区分「本轮结束」与
 * 「还有下一轮」——下一帧到达即续期）；直传 / 缓存全命中 / 无图场景 shell 不发事件，
 * 天然零显示。
 */
const IMAGE_RELAY_CLEAR_DELAY_MS = 2000;

export function AgentPanel() {
  const {
    agentMessages, activeSessionRunning, agentError,
    newAgentSession, loadAgentSessions, loadAgentSkills,
    agentSessionId,
    hasNonChainPatch, hasChapterCandidatePatch, resolvedLocale,
    agentExpanded, toggleAgentExpanded,
    hasPausedReview,
    agentParticipationGear, setAgentParticipationGear,
    agentSessions,
    resolvedAuthorProfilePatches, resolvedSettingMdPatches,
    uploadInboxFiles, uploadChatImages,
    contextUsageBySession,
    loadAgentBgTasks,
  } = useAppStore(useShallow((s) => {
    // dogfood T1 Stage 3（r8 键控）：挂载门只看当前视图会话的键（后台挂起卡不顶前台面板）。
    // 09-13 子3 W4（D-g 切分）：patch 挂载门按「是否含链产物 chapter_candidate」拆两判定——
    // 含非链 patch（outline/世界/信息释放/情绪/决策——对话指挥产物）→ 渲染过滤后的 PatchReviewPanel；
    // 含 chapter_candidate（链产物）→ ReviewPendingNotice 轻量提示跳写作页（混合批两者并存）。
    const viewPending = s.agentSessionId ? s.pendingPatchBySession[s.agentSessionId]?.patch : undefined;
    return {
    agentMessages: s.agentMessages,
    activeSessionRunning: s.activeSessionRunning,
    agentError: s.agentError,
    newAgentSession: s.newAgentSession,
    loadAgentSessions: s.loadAgentSessions,
    loadAgentSkills: s.loadAgentSkills,
    agentSessionId: s.agentSessionId,
    hasNonChainPatch: viewPending !== undefined && viewPending.patches.some((p) => (p.field as string) !== 'chapter_candidate'),
    hasChapterCandidatePatch: viewPending !== undefined && viewPending.patches.some((p) => (p.field as string) === 'chapter_candidate'),
    resolvedLocale: s.resolvedLocale,
    hasPausedReview: s.agentSessionId ? s.pausedReviewBySession[s.agentSessionId] !== undefined : false,
    agentExpanded: s.agentExpanded,
    toggleAgentExpanded: s.toggleAgentExpanded,
    agentParticipationGear: s.agentParticipationGear,
    setAgentParticipationGear: s.setAgentParticipationGear,
    agentSessions: s.agentSessions,
    // dogfood R2 #25：suggest 档审阅卡钉底收集的 resolved 侧输入。
    resolvedAuthorProfilePatches: s.resolvedAuthorProfilePatches,
    resolvedSettingMdPatches: s.resolvedSettingMdPatches,
    uploadInboxFiles: s.uploadInboxFiles,
    uploadChatImages: s.uploadChatImages,
    // 09-12 子5 R6：leader 上下文占用 last 值（context-usage 事件源；本会话条数据源）。
    contextUsageBySession: s.contextUsageBySession,
    // W4：后台任务注册表 hydrate（`agent:bg-tasks`——项目打开/面板挂载时拉全量）。
    loadAgentBgTasks: s.loadAgentBgTasks,
    };
  }));

  const { t } = useI18n(resolvedLocale);
  const showToast = useToastStore((s) => s.showToast);
  const [view, setView] = useState<PanelView>('chat');
  // 全屏态的历史细栏（dogfood 2026-08-21）：expanded 时历史钮开/关左侧 rail 快速切换
  // 会话（聊天不被顶掉）；docked 态维持整面视图切换。
  const [historyRailOpen, setHistoryRailOpen] = useState(false);
  // 09-01 A4（R1.3/AC4）：拖入悬停视觉反馈态（dragleave 抖动处理 mirror AssetsPanel——
  // dragging 态 + onDragLeave 无条件清，子元素间穿行由高频 dragover 重新置位兜住）。
  const [dropzoneDragging, setDropzoneDragging] = useState(false);

  // ── CR-003a（决议 a）：识图转述进度条订阅（image-relay-progress 全窗广播消费）──
  const [imageRelayProgress, setImageRelayProgress] = useState<{ current: number; total: number } | null>(null);
  const relayClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // 桥缺席/旧 mock 桥无此方法（测试环境）→ null = 无订阅无显示。
    const off = subscribeImageRelayProgress((p) => {
      if (
        !p || typeof p.current !== 'number' || typeof p.total !== 'number'
        || !Number.isFinite(p.current) || !Number.isFinite(p.total) || p.total <= 0
      ) return;
      if (relayClearTimerRef.current !== null) {
        clearTimeout(relayClearTimerRef.current);
        relayClearTimerRef.current = null;
      }
      setImageRelayProgress({ current: p.current, total: p.total });
      if (p.current >= p.total) {
        // 末帧短驻留后自动消隐（~2s；下一帧到达时上方 clearTimeout 续期）。
        relayClearTimerRef.current = setTimeout(() => {
          relayClearTimerRef.current = null;
          setImageRelayProgress(null);
        }, IMAGE_RELAY_CLEAR_DELAY_MS);
      }
    });
    return () => {
      if (relayClearTimerRef.current !== null) {
        clearTimeout(relayClearTimerRef.current);
        relayClearTimerRef.current = null;
      }
      off?.();
    };
  }, []);
  // dogfood T1 Stage 3 D3：新建会话**不再中断**在途 run（弹窗退役——切走后 run 进后台，
  // 徽标 + 停止钮接岗）。新建只重置视图。

  // Story 3.5: active-batch banner — mechanically derived from the most recent
  // batch tool-result metadata (running/paused only; terminal or absent → hidden).
  const activeBatch = useMemo(() => findActiveBatch(agentMessages), [agentMessages]);
  const activeBatchProgress = useMemo(
    () => (activeBatch ? batchProgressFrom(activeBatch) : null),
    [activeBatch],
  );

  // dogfood T1 Stage 3（design §5.5 徽标状态机）：面板头部聚合徽标——当前项目**其他**会话
  // 的非 idle 态计数（当前视图会话的状态在输入区/消息流已可见，不重复计）。无后台活动
  // 不占位（design §7.4）。完整视觉打磨在 S4/S5，此处为基础呈现（token 化样式）。
  const backgroundBadges = useAppStore(useShallow((s) => {
    const counts: Record<'running' | 'awaiting_confirm' | 'awaiting_review', number> = {
      running: 0, awaiting_confirm: 0, awaiting_review: 0,
    };
    for (const sess of s.agentSessions) {
      if (sess.id === s.agentSessionId) continue;
      const badge = deriveSessionBadge(s, sess.id);
      if (badge !== 'idle') counts[badge] += 1;
    }
    return counts;
  }));

  // ── 09-13 子3 CR-7（09-18 CR 批 B）：后台链待审卡 ──
  // 本项目内**非视图会话**的 paused 链（chainRunBySession × 项目归属过滤 × sid !== agentSessionId）
  // → ReviewPendingNotice 轻量卡（跳写作页 + 选链 + 进审阅——W5 接口已在）。design §1.3「暂停的
  // 是后台链：不抢——chip badge「待审」+ 对话栏提示卡」的后半承诺在此补全（此前只有写作页
  // chip 徽标，对话栏零提示）。与既有视图会话卡的去重 = sid 排除（视图会话的挂起卡走
  // hasPausedReview 位，同链不在本列表二次渲染）；链车道 stub sid ≠ 视图会话 id，天然按此分线。
  const backgroundPausedChainSids = useAppStore(useShallow((s) => {
    const path = s.currentProject?.path;
    if (path === undefined) return [];
    const sids: string[] = [];
    for (const [sid, run] of Object.entries(s.chainRunBySession)) {
      if (sid === s.agentSessionId) continue;
      if (run?.status !== 'paused') continue;
      if (!sameProjectPath(getSessionProject(sid), path)) continue;
      sids.push(sid);
    }
    return sids;
  }));

  // dogfood T1 Stage 5（design §6.4/§7.4，D5）：当前会话活跃 child 组聚合徽标——
  // progress_activity 图标 + 角色 chip 组 + 「第 N 步」摘要（最活跃组）。空闲不占位。
  // dogfood T1 CR-T1-036：活跃判定升级为整次派发级（deriveChildActivity 透传
  // activeSessionRunning——turn 间隙迟滞窗内不把徽标打 null）。
  const childActivity = useMemo(
    () => deriveChildActivity(agentMessages, activeSessionRunning),
    [agentMessages, activeSessionRunning],
  );

  // dogfood R2 #25：suggest 档审阅卡（author_profile / setting_md）**未决时钉底**——
  // 卡若只在消息流内联位置，run 继续就被后续消息顶出视野，用户错过待决审核点。
  // resolved map 一写：钉底卡消失、内联原位出现存档态（store 驱动双端切换，无 DOM 搬运）。
  const pendingAuthorProfileCards = useMemo(
    () => pendingAuthorProfilePatchResults(agentMessages, resolvedAuthorProfilePatches),
    [agentMessages, resolvedAuthorProfilePatches],
  );
  const pendingSettingMdCards = useMemo(
    () => pendingSettingMdPatchResults(agentMessages, resolvedSettingMdPatches),
    [agentMessages, resolvedSettingMdPatches],
  );

  // ── 09-12 子5 R6（design §11）：leader 上下文余量条 ──
  // 当前会话的 context-usage last 值 → 占用百分比条。三态：无快照（会话重载后事件未到）
  // 或 windowTokens null（注入原值无窗口信息——不显示假数）→ 条隐藏；percent ≥
  // redlinePercent → 变色（把「到红线自动压缩」语义前置可视化）。估算口径与压缩触发同源
  // （prepareContext loadTokens × 校准比——agent 侧同一次计算），UI 只渲染不重算。
  const contextUsage = agentSessionId ? contextUsageBySession[agentSessionId] : undefined;
  const contextUsageView = useMemo(() => {
    if (!contextUsage || contextUsage.windowTokens === null || contextUsage.windowTokens <= 0) {
      return null;
    }
    const percent = Math.max(
      0,
      Math.min(100, Math.round((contextUsage.usedTokens / contextUsage.windowTokens) * 100)),
    );
    return {
      percent,
      atRedline: percent >= contextUsage.redlinePercent,
      title: `${formatTokenCount(contextUsage.usedTokens)} / ${formatTokenCount(contextUsage.windowTokens)} tokens`,
    };
  }, [contextUsage]);

  const expandLabel = agentExpanded
    ? t('workspace.collapseWorkbench')
    : t('workspace.expandWorkbench');

  useEffect(() => {
    void loadAgentSkills();
  }, [loadAgentSkills]);

  // W4：后台任务注册表 hydrate（项目打开/切换时一次；运行期增量走 bg-update / child lane
  // 事件，此处只补盘面权威行——含重启后 interrupted）。失败静默（loadAgentBgTasks 自容错）。
  const bgHydrateProjectPath = useAppStore((s) => s.currentProject?.path);
  useEffect(() => {
    if (!bgHydrateProjectPath) return;
    void loadAgentBgTasks();
  }, [bgHydrateProjectPath, loadAgentBgTasks]);

  const handleShowHistory = () => {
    loadAgentSessions();
    if (agentExpanded) {
      // docked→expanded 切换时 view 可能残留 'history'——先清回 chat 再开 rail，
      // 否则整面历史与细栏同时渲染（dogfood 2026-08-21 复现：docked 点历史→展开→再点历史）。
      setView('chat');
      setHistoryRailOpen((v) => !v);
    } else {
      setView('history');
    }
  };

  // thinking adapters task（design §3.2 触发 ①）：手动压缩。run 进行中禁用（压缩会
  // 重排在途 run 的消息面，与档位切换同款 mid-run 门）。false 是布尔契约通道，不可
  // 分辨具体原因（会话不在 / 无可压缩 / D4 同项目他 run 占用 / 运行时未接线）——文案
  // 并列列出，不再断言单一原因（CR-017）；成功路径的 toast 由 compaction 流事件统一弹。
  const handleCompactContext = async () => {
    if (!agentSessionId) return;
    try {
      const ok = await compactAgentSession(agentSessionId);
      if (!ok) showToast(t('agent.compactNotExecuted'), 'info', 3000);
    } catch {
      showToast(t('agent.compactFailed'), 'error', 3000);
    }
  };

  // 展开进入全屏时若正停在整面历史视图，回落聊天（全屏语义 = 工作台；历史走右侧细栏）。
  useEffect(() => {
    if (agentExpanded && view === 'history') setView('chat');
  }, [agentExpanded, view]);

  // ── 09-01 A4（R1.3/AC4）：对话框拖拽进件（文档分支）──
  // 判据 = dataTransfer.files 非空才处理——内部拖拽（章卡/大纲条目/结构槽位等）的
  // files 恒空，天然过滤；preventDefault/stopPropagation 只在 files 非空时做，不碰
  // 既有拖拽交互（不 preventDefault 的 dragover 在真浏览器本就不触发 drop）。
  const hasDropFiles = (e: React.DragEvent<HTMLDivElement>): boolean =>
    (e.dataTransfer?.files?.length ?? 0) > 0;

  const handleDropzoneDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDropFiles(e)) return;
    e.preventDefault(); // 允许 drop（否则 Electron 窗口内默认行为是打开文件）
    e.stopPropagation();
    setDropzoneDragging(true);
  };

  const handleDropzoneDragLeave = () => setDropzoneDragging(false);

  const handleDropzoneDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDropFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropzoneDragging(false);
    // 扩展名三分流（design §1.1）：文档白名单 → 与按钮上传同路径同结果（AC4）——
    // pathForFile 换绝对路径 + importFiles 白名单 + resolve 挂载全在 A3 action 内。
    const files = Array.from(e.dataTransfer.files);
    const docs = files.filter((f) => INBOX_DOC_RE.test(f.name));
    const images = files.filter((f) => DROP_IMAGE_RE.test(f.name));
    const rejected = files.filter((f) => !INBOX_DOC_RE.test(f.name) && !DROP_IMAGE_RE.test(f.name));
    if (rejected.length > 0) {
      showToast(
        t('agent.dropzoneRejected', { names: rejected.slice(0, 5).map((f) => f.name).join('、') }),
        'warning',
        5000,
      );
    }
    if (images.length > 0) {
      // 09-01 B4（R2.1 / dogfood #45）：图片分支接管——与选择器按钮/粘贴同一 action
      //（canvas 预检压缩 → inbox/images/ 落盘 → image 附件指针挂载）。
      void uploadChatImages(images);
    }
    if (docs.length > 0) void uploadInboxFiles(docs);
  };

  const badgeText = (badge: SessionBadgeState): string =>
    badge === 'running' ? t('agent.badgeRunning')
      : badge === 'awaiting_confirm' ? t('agent.badgeAwaitingConfirm')
        : badge === 'awaiting_review' ? t('agent.badgeAwaitingReview')
          : '';

  return (
    <div className="agent-panel">
      <div className="agent-panel-header">
        <span className="agent-panel-title">{t('agent.title')}</span>
        {/* dogfood T1 Stage 5（D5）：当前会话活跃 child 聚合徽标（design §7.4——图标 +
            角色 chip 组 + 「第 N 步」摘要，样式同 7.3 动作标签；空闲不占位）。
            dogfood T1 CR-T1-046：chip 补 source 维度（`sourceLabel · role`，与
            ChildBadge/组头一致）；图标**静态**（progress 图形承载语义）——同类旋转
            动画收敛至组图标一处（§7.7「同屏同时最多各一处」）。 */}
        {childActivity && (
          <div className="agent-panel-child-activity" role="status" title={t('agent.badgeRunning')}>
            <span className="material-symbols-outlined agent-child-activity-icon" aria-hidden="true">progress_activity</span>
            {childActivity.roles.map((r) => (
              <span
                key={`${r.source}:${r.role}`}
                className="agent-child-activity-chip"
                title={`${r.source}:${r.role}`}
              >
                {(r.source === 'skill' ? t('agent.childSkill') : t('agent.childSubagent'))} · {roleLabel(r.role, t)}
              </span>
            ))}
            {childActivity.step > 0 && (
              <span className="agent-child-activity-step">{t('agent.childStep', { step: childActivity.step })}</span>
            )}
          </div>
        )}
        {(backgroundBadges.running > 0 || backgroundBadges.awaiting_confirm > 0 || backgroundBadges.awaiting_review > 0) && (
          <div className="agent-panel-badges" role="status">
            {backgroundBadges.running > 0 && (
              <span className="agent-badge agent-badge--running" title={badgeText('running')}>
                <span className="material-symbols-outlined" aria-hidden="true">progress_activity</span>
                {backgroundBadges.running}
              </span>
            )}
            {backgroundBadges.awaiting_confirm > 0 && (
              <span className="agent-badge agent-badge--confirm" title={badgeText('awaiting_confirm')}>
                <span className="material-symbols-outlined" aria-hidden="true">pending_actions</span>
                {backgroundBadges.awaiting_confirm}
              </span>
            )}
            {backgroundBadges.awaiting_review > 0 && (
              <span className="agent-badge agent-badge--review" title={badgeText('awaiting_review')}>
                <span className="material-symbols-outlined" aria-hidden="true">rate_review</span>
                {backgroundBadges.awaiting_review}
              </span>
            )}
          </div>
        )}
        <div className="agent-panel-header-actions">
          {/* Story 3.5: gear quick switch (design §2.1 三入口之一 — header 快捷).
              Disabled mid-run like the other selects; mid-run switching goes
              through the chat command (leader's set_participation_gear tool). */}
          <select
            className="agent-panel-gear-select"
            value={agentParticipationGear}
            onChange={(e) => setAgentParticipationGear(e.target.value as ParticipationGear)}
            disabled={activeSessionRunning}
            title={t('agent.gearTitle')}
            aria-label={t('agent.gearTitle')}
          >
            {GEAR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.i18nKey)}</option>
            ))}
          </select>
          {/* dogfood 2026-08-21：档位光看名字看不懂——info 悬停解释。 */}
          <Tooltip label={t('agent.gearHelp')} placement="bottom" multiline>
            <span className="agent-mode-help material-symbols-outlined" aria-hidden="true">info</span>
          </Tooltip>
          {/* thinking adapters task：手动压缩上下文（红线/顶满自动触发在 runtime 内部）。 */}
          <button
            type="button"
            className="agent-panel-icon-btn"
            onClick={() => { void handleCompactContext(); }}
            disabled={!agentSessionId || activeSessionRunning}
            title={t('agent.compactContext')}
            aria-label={t('agent.compactContext')}
          >
            <span className="material-symbols-outlined" aria-hidden="true">compress</span>
          </button>
          <button
            type="button"
            className={`agent-panel-icon-btn${agentExpanded ? ' is-active' : ''}`}
            onClick={toggleAgentExpanded}
            title={expandLabel}
            aria-label={expandLabel}
            aria-pressed={agentExpanded}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {agentExpanded ? 'close_fullscreen' : 'open_in_full'}
            </span>
          </button>
          <button
            type="button"
            className={`agent-panel-icon-btn${view === 'settings' ? ' is-active' : ''}`}
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
            title={t('agent.settings')}
            aria-label={t('agent.settings')}
          >
            <span className="material-symbols-outlined" aria-hidden="true">settings</span>
          </button>
          <button
            type="button"
            className="agent-panel-icon-btn"
            // dogfood T1 Stage 3 D3：新建会话不中断在途 run（二次确认弹窗退役，徽标接岗）。
            onClick={() => newAgentSession()}
            title={t('agent.newConversation')}
            aria-label={t('agent.newConversation')}
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
          </button>
          <button
            type="button"
            className={`agent-panel-icon-btn${view === 'history' || (agentExpanded && historyRailOpen) ? ' is-active' : ''}`}
            onClick={handleShowHistory}
            title={t('agent.history')}
            aria-label={t('agent.history')}
          >
            <span className="material-symbols-outlined" aria-hidden="true">history</span>
          </button>
        </div>
      </div>

      {/* 09-12 子5 R6（design §11）：leader 上下文余量条（header 与 body 之间的细条）。
          隐藏三态：无快照 / windowTokens null（无窗口信息不显示假数）/ 无会话；
          ≥红线变色（is-redline）——压缩红线语义前置可视化；「估算」小标 + title 原始
          token 数。仅 leader 会话（child/链事件不含本变体，天然不在作用面）。 */}
      {contextUsageView && (
        <div
          className={`agent-context-usage${contextUsageView.atRedline ? ' is-redline' : ''}`}
          role="status"
          title={contextUsageView.title}
        >
          <span className="agent-context-usage-label">{t('usagePanel.contextBarLabel')}</span>
          <div className="agent-context-usage-track" aria-hidden="true">
            <div
              className="agent-context-usage-fill"
              style={{ width: `${contextUsageView.percent}%` }}
            />
          </div>
          <span className="agent-context-usage-percent">{contextUsageView.percent}%</span>
          <span className="agent-context-usage-est">{t('usagePanel.contextBarEstimated')}</span>
        </div>
      )}

      <div className="agent-panel-body">
        {view === 'history' ? (
          <AgentHistory onClose={() => setView('chat')} />
        ) : view === 'settings' ? (
          <AgentSettings onClose={() => setView('chat')} />
        ) : (
          // 09-01 A4/B4（R1.3/AC4 + R2.1）：消息+输入容器层 = 拖拽 drop zone——文档与
          // 图片双分支同 zone 分流（images 分流已由 B4 落地，见 handleDropzoneDrop）。
          <div
            className={`agent-panel-main${dropzoneDragging ? ' agent-panel-main--dragging' : ''}`}
            onDragOver={handleDropzoneDragOver}
            onDragLeave={handleDropzoneDragLeave}
            onDrop={handleDropzoneDrop}
          >
            {/* W4（§6.1）：子会话检视图头部（role/状态/耗时 + 返回键）——仅 bg 子会话视图挂载。 */}
            <ChildInspectHeader />
            {/* W4（§6.2 U5）：后台任务条——独立呈现面不进消息流；四态卡 + running 取消 + 钻取。 */}
            <BgTaskBar />
            {/* Story 3.5: active batch strip — gear + scene progress, straight from
                the latest batch metadata. No active batch → nothing rendered. */}
            {activeBatch && activeBatchProgress && (
              <div className="agent-batch-banner">
                <span className="material-symbols-outlined" aria-hidden="true">stacks</span>
                <span className="agent-batch-banner-text">
                  {t('agent.batchBannerActive')}
                  {' · '}
                  {t('agent.batchProgressScenes', { done: activeBatchProgress.done, total: activeBatchProgress.total })}
                  {' · '}
                  {t(gearLabelKey(activeBatchProgress.gear))}
                </span>
              </div>
            )}
            {/* CR-003a（决议 a）：识图转述进度条——多图串行转述的运行相位可见性（直传/
                缓存全命中不发事件，天然零显示）；末帧 ~2s 自动消隐。 */}
            {imageRelayProgress && (
              <div className="agent-relay-progress" role="status">
                <span className="material-symbols-outlined agent-relay-progress-icon" aria-hidden="true">
                  progress_activity
                </span>
                <span className="agent-relay-progress-text">
                  {t('agent.imageRelayProgress', {
                    current: imageRelayProgress.current,
                    total: imageRelayProgress.total,
                  })}
                </span>
              </div>
            )}
            <AgentMessages messages={agentMessages} loading={activeSessionRunning} error={agentError} />
            {/* 09-13 子3 W4（D-g 切分）：chapter_candidate（链产物）不在对话栏渲染全尺寸卡——
                轻量提示跳写作页产物区审阅落盘；非链 patch（对话指挥产物）照常全尺寸渲染（过滤后）。 */}
            {hasChapterCandidatePatch && <ReviewPendingNotice kind="chapter-patch" sessionId={agentSessionId} />}
            {hasNonChainPatch && <PatchReviewPanel excludeChapterCandidate />}
            {/* R2 #25：suggest 档审阅卡未决钉底（mirror PatchReviewPanel 位——滚动区外
                恒可见）；resolved 后自动回消息流内联原位。 */}
            {pendingSettingMdCards.map((r, i) => (
              <SettingMdPatchCard key={`pinned-setting-md-${i}`} result={r} />
            ))}
            {pendingAuthorProfileCards.map((r, i) => (
              <AuthorProfilePatchCard key={`pinned-author-profile-${i}`} result={r} />
            ))}
            {/* 09-13 子3 W4/W5（design §5.3）：ChapterReviewPanel 迁写作页（features/writing）——
                对话栏挂载位换 ReviewPendingNotice 轻量提示（跳转 = 切写作页 + 选中该链 + 进审阅相位
                ——sessionId = 视图会话，与挂载判定同键）。 */}
            {hasPausedReview && <ReviewPendingNotice kind="chapter-review" sessionId={agentSessionId} />}
            {/* 09-13 子3 CR-7（09-18 CR 批 B）：后台链待审卡（本项目非视图会话 paused 链——
                每链一张；跳转带各自 sessionId 写显式选择）。 */}
            {backgroundPausedChainSids.map((sid) => (
              <ReviewPendingNotice key={`bg-chain-${sid}`} kind="chapter-review" sessionId={sid} />
            ))}
            <AgentInput />
          </div>
        )}
        {/* 全屏态历史细栏：挂右侧（历史钮在头部右侧，就近原则），聊天不被顶掉 */}
        {agentExpanded && historyRailOpen && (
          <aside className="agent-history-rail">
            <AgentHistory onClose={() => setHistoryRailOpen(false)} />
          </aside>
        )}
      </div>
    </div>
  );
}
