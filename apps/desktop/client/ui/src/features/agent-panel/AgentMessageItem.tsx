import { memo, useMemo, useRef, useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { AgentMessage } from '../../shared/store/agentSlice';
import type { ImageAttachment } from '@orison/shared-contracts';
import { WRITE_TOOLS } from '../../shared/store/agentDiffSlice';
import type { Attachment, SelectionAttachment } from '../../shared/types/attachment';
// 09-01 B4（R2.6）：气泡 image 缩略图的盘读路径拼接 + 绝对路径归一（ProjectTree.tsx:230 同款）。
import { chatImageAbsolutePath } from '../../shared/api/chatImages';
// 09-12 子2（design §8③）：终态徽标的模型显示名单源（与通知条/chip 同一查表）。
import { modelDisplayName } from '../../shared/model/modelDisplay';
import { AgentToolCard } from './AgentToolCard';
import { DiffCard } from './DiffCard';
// dogfood R2 #12：三派发工具的成功产出（大纲/分集草案、调研报告）专用产出卡——
// 草案是核心交付物，默认展开 + MD 渲染（mirror findings/settingMd 拦截先例）。
import { DispatchDraftCard, dispatchDraftBadgeKey } from './DispatchDraftCard';
// dogfood R2 #81：child 链内结构化指令 JSON（导演五段产出）折叠卡——机器产出不裸奔
// 正文通道（mirror #12 拦截先例；拦截面在 UI 渲染层，agent 数据零改动）。
import { ChainDirectiveCard, parseChainDirectiveJson } from './ChainDirectiveCard';
// Story 3.7 #2：write_chapter tool result 的 reader-audit findings 结构化卡组（D5/D5b）。
import { ReviewFindingsCard, extractReaderAuditFindings } from './ReviewFindingsCard';
// Story 2.2 WP-B：setting_md_update 的专用审阅卡（setting_md_patch envelope 专用分流）。
import { SettingMdPatchCard, extractSettingMdPatch, isSettingMdPatchResolved } from './SettingMdPatchCard';
// Story 8.6 R4：author_profile_update 的专用审阅卡（author_profile_patch envelope 专用分流，
// mirror setting_md 先例——机器级档案文件非 creative field，不进 WRITE_TOOLS/PatchReview）。
import { AuthorProfilePatchCard, extractAuthorProfilePatch, isAuthorProfilePatchResolved } from './AuthorProfilePatchCard';
import { Collapsible } from '../../shared/components/Collapsible';
import { toolPresentation, toolLabel, roleLabel, parseChildTag } from './toolMeta';
// 子4 W6：「桥」徽标——本会话对话车道经桥运行（childTag 消费侧排除——桥只接 leader）。
import { useAgyBridgeLaneActive } from './useAgyBridgeLane';
import { useTypewriter } from './useTypewriter';
// dogfood R2 #11（findings #11④）：MD 渲染单源（R2 #12 提出供 DispatchDraftCard 复用）。
import { renderMarkdown } from './markdown';
// dogfood R2 #11（findings #11④）：流式出字平滑过渡的 displayLen 动画轨（grow-only）。
import { useSmoothReveal } from './useSmoothReveal';

type Props = {
  message: AgentMessage;
  isLatest?: boolean;
  /** 从此截断亲和性（dogfood 2026-08-21）：仅纯对话尾巴的消息为 true（AgentMessages 尾扫计算）。 */
  canTruncateFrom?: boolean;
  /** CR-T1-042：按 messageId 参数化——AgentMessages 传 useCallback 稳定引用（旧 `() => void`
   * 每 render 新闭包，顶层 single 分支全部 memo 失效，250ms flush 全量重渲）。 */
  onTruncateFrom?: (messageId: string) => void;
  /** dogfood R2 #9（2026-08-25）：已有结果卡的 toolCallId 集——对应调用徽标隐去（一次动作
   * 不再「徽标 + 结果卡」双打）。徽标由此只承载「执行中」语义：结果未到时可见（进行时
   * 指示，#3 的可见性诉求顺带落地），结果卡落地即退场。缺省 undefined = 全显示（旧渲染）。 */
  resolvedToolCallIds?: ReadonlySet<string>;
};

/** 从此截断按钮——悬停显现，剪刀图标，挂在消息气泡右上角。回调按 messageId 参数化
 * （CR-T1-042：caller 传稳定引用，memo 不被每渲染新闭包击穿）。 */
function TruncateFromHereButton({ onClick, t }: { onClick: () => void; t: (k: string) => string }) {
  return (
    <button
      type="button"
      className="agent-msg-truncate"
      onClick={onClick}
      title={t('agent.truncateFromHere')}
      aria-label={t('agent.truncateFromHere')}
    >
      <span className="material-symbols-outlined">content_cut</span>
    </button>
  );
}

function attachmentIcon(type: Attachment['type']): string {
  if (type === 'chapter') return 'description';
  return 'insert_drive_file';
}

/**
 * 09-01 B4（R2.6 / dogfood #45）：user 气泡 references 的 image 分支缩略图。两态：
 * - attachment 带 `dataUrl`（发送时刻 uploadStates 里的压缩后 dataUrl，乐观消息直显）→ 直接渲染；
 * - 无（重载会话 / 重启 jsonl 读回——references 是 UI 内存态从不落盘）→ useEffect 经
 *   `readFileBinary`（ProjectTree.tsx:231-245 同款 IPC）按项目相对指针读盘转 dataUrl 渲染，
 *   加载中占位框；读失败保持占位（文件被移动/删除不炸气泡）。效果 cleanup 的 cancelled
 *   旗防在途读盘落到已卸载/已切项目的消息上。
 */
function ImageReferenceThumb({
  image,
  dataUrl,
  t,
}: {
  image: ImageAttachment;
  dataUrl?: string;
  t: (k: string) => string;
}) {
  const projectPath = useAppStore((s) => s.currentProject?.path);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(dataUrl ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (dataUrl) {
      setLoadedUrl(dataUrl);
      return;
    }
    setLoadedUrl(null);
    if (!projectPath) return;
    let cancelled = false;
    const fullPath = chatImageAbsolutePath(projectPath, image.path);
    void (async () => {
      try {
        const payload = await window.orisonDesktop?.readFileBinary?.(fullPath);
        if (cancelled) return;
        if (payload?.base64) {
          setLoadedUrl(`data:${payload.mimeType};base64,${payload.base64}`);
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [dataUrl, projectPath, image.path]);

  return (
    <span className="agent-msg-image-thumb" title={image.label} role="img" aria-label={image.label}>
      {loadedUrl ? (
        <img src={loadedUrl} alt={image.label} />
      ) : failed ? (
        <span className="agent-msg-image-thumb-fallback">
          <span className="material-symbols-outlined" aria-hidden="true">broken_image</span>
          {t('agent.imageThumbLoadFailed')}
        </span>
      ) : (
        <span className="agent-msg-image-thumb-loading">
          <span className="material-symbols-outlined agent-upload-spin" aria-hidden="true">progress_activity</span>
          {t('agent.imageThumbLoading')}
        </span>
      )}
    </span>
  );
}

/**
 * Compact citation chip for a pinned selection — a pointer to what the message
 * referenced, not a re-display of the full passage (the full text already went
 * to the model via the runtime). The quote marks are component-owned and the
 * inner text is truncated, so they stay balanced; the old chip showed the
 * `format_quote` glyph (a lone opening-quote icon) which read as an unbalanced
 * quote. Full text is available on hover.
 */
function SelectionReferenceChip({ ref }: { ref: SelectionAttachment }) {
  const raw = (ref.text ?? ref.label).replace(/\s+/g, ' ').trim();
  const preview = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
  return (
    <span
      className="agent-attachment-chip agent-attachment-chip-quote"
      title={ref.text ?? ref.label}
    >
      <span className="agent-attachment-quote-text">“{preview}”</span>
    </span>
  );
}

/** Small leading badge for a nested skill / subagent execution step. */
function ChildBadge({ source, role, depth, t }: { source: 'skill' | 'subagent'; role: string; depth: number; t: (k: string) => string }) {
  const icon = source === 'skill' ? 'extension' : 'smart_toy';
  const sourceLabel = source === 'skill' ? t('agent.childSkill') : t('agent.childSubagent');
  return (
    <span className="agent-child-badge">
      <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
      {sourceLabel} · {roleLabel(role, t)}{depth > 1 ? ` · d${depth}` : ''}
    </span>
  );
}

/**
 * dogfood T1 Stage 4（design §6.3 / §7.2，#27②）：深度思考折叠块。
 * dogfood R2 #11（findings #11①②，2026-08-25）：**默认展开**（收起态让思考流不可见，
 * 用户否决了原默认收起）；流式期展开态下 body 内滚贴底跟随（reasoning 增长即 scrollTop
 * 拉底），但用户上翻（距底 >40px）即暂停跟随、滚回底部自动恢复——不抢用户的滚动。
 * 字体跟随全局（R2 #11③：等宽渲染中文丑，CSS 侧改 inherit）；流式收起态仍有 shimmer
 * 活动指示。透传链三处（AgentStreamEvent 类型 / assistant 事件 append / switch 重映射）
 * 保证重载会话仍在（AC）。
 * CR-2（dogfood R2 BMad CR，用户拍板 A 方案：默认展开 + 懒渲染）：默认展开语义不动
 *（#11①），懒的是**正文挂载**——reasoning 流可到 MB 级 + 项目切换自动接续拉全量历史，
 * 装载即挂几百 KB 文本节点会卡。视口外历史消息只保留摘要头（reasoningSummary 摘要不
 * 变），进入视口（IntersectionObserver，rootMargin 预挂）才挂正文；流式中的当前消息
 * 豁免（必须即时渲染）。inView 单向闩锁——见过即保持挂载（settle 后不闪卸）。
 * dogfood R2 #23（2026-08-26）：展开语义精化——**只有正在流式的自动展开**；settle
 *（streaming true→false）自动收起；历史块装载即收起（摘要头在，点开可查）。用户手动
 * 开关过的豁免自动收起（显式选择优先）。「思考流可见」（#11① 拍板核心）不回退——
 * 流式期照旧展开 + 贴底跟随。
 */
function ReasoningFold({ reasoning, streaming, revealed, t }: { reasoning: string; streaming: boolean; revealed?: boolean; t: (key: string, vars?: Record<string, string | number>) => string }) {
  // #23：open 初值 = streaming——正在进行的展开（思考流可见），历史/已收尾的装载即收起。
  const [open, setOpen] = useState(streaming);
  // #23：settle 自动收起——仅当用户从未手动开关过（显式选择优先于默认策略）。
  const userToggledRef = useRef(false);
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming && !userToggledRef.current) setOpen(false);
    wasStreamingRef.current = streaming;
  }, [streaming]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // CR-2：视口闩锁——历史消息进视口前不挂正文；streaming 消息豁免（初始即 true）。
  const [inView, setInView] = useState(streaming);
  useEffect(() => {
    if (streaming) setInView(true);
  }, [streaming]);
  useEffect(() => {
    if (streaming || inView) return;
    if (typeof IntersectionObserver === 'undefined') {
      // 环境无 IO（jsdom 等）——退化为直接挂载，行为不劣于旧实现。
      setInView(true);
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [streaming, inView]);
  // R2 #11② 内层：贴底跟随开关——onScroll 按距底距离维护（>40px 暂停，≤40px 恢复）。
  const followRef = useRef(true);
  // R2 #11④ 追加（用户复测：平滑出字在思考过程里没生效）：思考体接同一 displayLen 动画轨。
  // body 是纯文本（pre-wrap）无需 MD 头尾两层——直接 slice 即逐字生长；终帧/直出/
  // reduced-motion 由 useSmoothReveal 的拉满路径收敛（与正文轨同语义）。
  const displayLen = useSmoothReveal(reasoning, { active: streaming, revealed });
  const visibleReasoning = streaming ? reasoning.slice(0, displayLen) : reasoning;
  useEffect(() => {
    if (!streaming || !open || !followRef.current) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // 依赖 visibleReasoning（非原文）——平滑轨每步生长都贴底，不然 250ms flush 粒度跟不上帧级生长。
  }, [visibleReasoning, streaming, open]);
  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  };
  const showBody = open && (streaming || inView);
  return (
    <div
      ref={hostRef}
      className={[
        'agent-reasoning',
        streaming ? 'agent-reasoning--streaming' : '',
        open ? 'agent-reasoning--open' : '',
      ].filter(Boolean).join(' ')}
    >
      <button
        type="button"
        className="agent-reasoning-header"
        onClick={() => {
          // #23：手动开关即显式选择——settle 不再自动收起。
          userToggledRef.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span className="material-symbols-outlined" aria-hidden="true">psychology</span>
        <span className="agent-reasoning-title">{t('agent.reasoningSummary', { count: reasoning.length })}</span>
        {streaming && <span className="agent-reasoning-shimmer" aria-hidden="true" />}
        <span className="material-symbols-outlined agent-reasoning-chevron" aria-hidden="true">
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {showBody && (
        <div ref={bodyRef} className="agent-reasoning-body" onScroll={handleBodyScroll}>{visibleReasoning}</div>
      )}
    </div>
  );
}

function AgentMessageItemImpl({ message, isLatest, canTruncateFrom, onTruncateFrom, resolvedToolCallIds }: Props) {
  const { resolvedLocale, resolvedAuthorProfilePatches, resolvedSettingMdPatches, modelConfigForBadge } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    // dogfood R2 #25：suggest 档审阅卡未决时不内联（run 继续会被后续消息顶出视野）——
    // 钉底渲染在 AgentPanel（mirror PatchReviewPanel 位）；resolved 后回内联原位存档。
    resolvedAuthorProfilePatches: s.resolvedAuthorProfilePatches,
    resolvedSettingMdPatches: s.resolvedSettingMdPatches,
    // 09-12 子2（design §8③）：终态徽标「实际模型 B · 回退自 A」的显示名查表源。
    modelConfigForBadge: s.modelConfig as import('@orison/shared-contracts').ModelConfig | undefined,
  })));
  const { t } = useI18n(resolvedLocale);
  const mountedAtRef = useRef(Date.now());
  // 子4 W6：桥车道派生（徽标用；childTag 消息在下方各消费点排除）。
  const bridgeLaneActive = useAgyBridgeLaneActive();

  // Strip a child-execution tag (e.g. `[skill:story:d1] ...`) off assistant
  // content so it renders as an indented, labelled step instead of leaking the
  // raw tag into prose. The slice keeps injecting the tag; we only parse it here.
  const childTag = message.role === 'assistant' ? parseChildTag(message.content ?? '') : null;
  const assistantContent = childTag ? childTag.rest : (message.content ?? '');

  // dogfood R2 #81：child 正文整体形态为链内结构化指令 JSON（导演五段键族，纯形态判断
  // 见 parseChainDirectiveJson）→ 折叠小卡替代正文通道。仅 child 消息（childTag 在）——
  // leader 引用 JSON 讲解等场景不受影响（零误伤）。流式期不完整 JSON 判不过，照旧正文
  // 流式；完整（含终帧）即收敛成卡。
  const chainDirective = childTag ? parseChainDirectiveJson(assistantContent) : null;

  // Typewriter: only animate the latest assistant message that arrived recently.
  // dogfood T1 Stage 4（design §6.2 / r4 方案 a）：streaming 消息**绝不**走 typewriter——
  // growing content 会触发 targetText 变化 = index 归零全量重放（r4 实证必炸）；改走下方
  // 250ms MD 快照轨（animatedHtml 路径原样复用——本就是为渐进文本设计的节流解析器）。
  // aborted_partial（abort 部分落盘终帧）直出跳过动画（design §3.3）。typewriter 保留给
  // 历史回放 / 对账补齐（500ms 窗 + isLatest 门不动）。
  // dogfood T1 CR-T1-040：`{ enabled: shouldAnimate }` 真禁 hook（旧死三元两臂同值，streaming
  // 全程 rAF 空转 + 终帧后按 15ms/字追平全文的废弃时钟）；快照轨启动条件同步显式化
  //（snapshotActive，不依赖 hook 的 isAnimating——hook 禁用不断流）。
  // dogfood R2 #50：settledHistory（autoResume 重开项目/刷新的已落定历史）不进打字机——
  // 重开是回到现场非主动浏览，末条重播是噪音；且回放空泡首帧会打断 [agentSessionId]
  // 跳底量高（AgentMessages 落底时末条内容还是空的）。手动切会话不盖章，回放保留。
  const isStreaming = message.role === 'assistant' && message.streaming === true;
  // CR-T1-040 收尾：本组件生命周期内流式过的消息**终帧不进打字机**（latch）——否则 settle
  // 时 enabled false→true 翻转会 index 归零全量重放（用户刚看完流式又重播一遍）；终帧直接
  // renderedHtml 收敛（r4「streaming 绕过 typewriter」的完整语义）。
  const everStreamedRef = useRef(isStreaming);
  if (isStreaming) everStreamedRef.current = true;
  const shouldAnimate = !everStreamedRef.current
    && !isStreaming
    && message.kind !== 'aborted_partial'
    && message.settledHistory !== true
    && isLatest
    && message.role === 'assistant'
    && (Date.now() - mountedAtRef.current) < 500;
  const { displayedText, isAnimating, skip } = useTypewriter(
    assistantContent,
    15,
    { enabled: shouldAnimate },
  );
  const textToRender = shouldAnimate ? displayedText : assistantContent;

  /** CR-T1-040：MD 快照轨独立启动条件——streaming（绕过 hook 的增量轨）或打字机动画在途
   *（历史回放）。此前快照轨寄生在 hook 的 isAnimating 上，hook 真禁后 streaming 会断流。 */
  const snapshotActive = isStreaming || isAnimating;

  // Parse markdown once, when NOT animating. Running marked+DOMPurify over the
  // whole (growing) message on every typewriter rAF tick was a CPU sink during
  // streaming; instead show the in-progress text as plain text and render the
  // sanitized markdown only after the animation settles.
  const renderedHtml = useMemo(() => {
    if (message.role === 'assistant' && !snapshotActive && assistantContent) {
      return renderMarkdown(assistantContent);
    }
    return null;
  }, [message.role, snapshotActive, assistantContent]);

  // dogfood 2026-08-21 实录修正：动画期间纯文本、结束才弹 MD——观感割裂（「MD 样式
  // 几秒后才生效」）。改为节流增量解析：每 250ms 快照一次部分文本过 marked+DOMPurify
  // （非每 rAF tick，CPU 坑不回潮）；未闭合的 markdown 语法在补全前按原文渲染，流式
  // 聊天 UI 的通行形态。动画结束 renderedHtml 接管收敛到全量。
  // dogfood R2 #11（findings #11④，2026-08-25）：250ms 整段跳变升级为**两层渐进渲染**——
  // 头部 = 250ms 节流的已定型 MD 块（CPU 不变量：解析频率 ≤ 旧整段快照），尾部 = 头部
  // 边界到 displayLen 之间逐字生长的纯文本轨（每 rAF 更新，零解析开销）。**不回潮
  // useTypewriter**——displayLen grow-only，target 变化绝不重置/回退（r4 不变式）。
  const liveTextRef = useRef(textToRender);
  liveTextRef.current = textToRender;
  // CR-T1-043：「直出」激活标记——激活期间 displayLen 恒贴 target（useSmoothReveal 渲染期
  // 覆写）+ 头部快照不再等 250ms interval tick，每次 content 变化（flush）立即对齐。
  const revealRef = useRef(false);
  // R2 #11④：displayLen 动画轨（自适应速率向 target 收敛；终帧/reveal/reduced-motion 拉满）。
  const displayLen = useSmoothReveal(textToRender, { active: snapshotActive, revealed: revealRef.current });
  const displayLenRef = useRef(displayLen);
  displayLenRef.current = displayLen;

  // 头部 MD 快照：250ms 节流捕获 target.slice(0, 当次 displayLen)——边界取动画轨当前位置，
  // 尾轨从该边界起逐字生长（渐进 MD 的通行形态：头为已定型块、尾为生长中的当前行）。
  const [mdHead, setMdHead] = useState<{ text: string; len: number } | null>(null);
  useEffect(() => {
    if (!snapshotActive) {
      setMdHead(null);
      revealRef.current = false;
      return;
    }
    const capture = () => {
      const len = Math.min(displayLenRef.current, liveTextRef.current.length);
      setMdHead({ text: liveTextRef.current.slice(0, len), len });
    };
    capture();
    const id = setInterval(capture, 250);
    return () => clearInterval(id);
  }, [snapshotActive]);
  // CR-T1-043：直出激活后随每次 flush 即时对齐（store 本身 250ms 节流——直出的最大
  // 即时度 = flush 落地即渲，不再叠加 interval 相位差）。
  useEffect(() => {
    if (snapshotActive && revealRef.current) {
      const text = liveTextRef.current;
      setMdHead({ text, len: text.length });
    }
  }, [snapshotActive, textToRender]);
  const animatedHtml = useMemo(
    () => (mdHead !== null && message.role === 'assistant' ? renderMarkdown(mdHead.text) : null),
    [mdHead, message.role],
  );
  // R2 #11④ 尾轨：头部边界 → displayLen 的纯文本生长段（流式 caret 经 CSS 落在本轨末尾）。
  const tailText = snapshotActive
    ? textToRender.slice(mdHead?.len ?? 0, displayLen)
    : '';

  // R2 #11⑤（findings #11⑤，E4）：跨组件直出信号——直出钮挪到输入行（AgentInput）后经
  // store 的 streamRevealTick 通知本组件拉满（CR-T1-043 reveal 语义的按钮搬家版）。
  // 初始值跳过（挂载不误触发）；只对正在流式的消息生效（历史/终帧消息无轨可拉）。
  const streamRevealTick = useAppStore((s) => s.streamRevealTick);
  const lastRevealTickRef = useRef(streamRevealTick);
  useEffect(() => {
    if (streamRevealTick === lastRevealTickRef.current) return;
    lastRevealTickRef.current = streamRevealTick;
    if (!isStreaming) return;
    revealRef.current = true;
    const text = liveTextRef.current;
    setMdHead({ text, len: text.length });
  }, [streamRevealTick, isStreaming]);

  // dogfood R2 #16：intent-confirm 快捷按钮删除（用户拍板——与输入框冲突、quick reply 价值薄；
  // 「改意图」字面消息是哑弹，leader 还得反问一轮）。作者直接在输入框打字回应。kind:'intent_restate'
  // 停止产生（agent 侧盖章已删），类型字面量保留读旧会话 jsonl。

  if (message.role === 'user') {
    return (
      <div className="agent-msg agent-msg-user">
        <div className="agent-msg-label">{t('agent.you')}</div>
        {canTruncateFrom && onTruncateFrom && <TruncateFromHereButton onClick={() => onTruncateFrom(message.id)} t={t} />}
        <div className="agent-msg-content">{message.content}</div>
        {message.references && message.references.length > 0 && (
          <div className="agent-msg-references">
            {message.references.map((ref) =>
              ref.type === 'selection' ? (
                <SelectionReferenceChip key={`selection-${ref.id}`} ref={ref} />
              ) : ref.type === 'image' ? (
                // 09-01 B4（R2.6）：image 引用缩略图——dataUrl 直显（乐观消息）或盘读还原
                //（重载会话）。`dataUrl` 是 UI 内存态扩展（AgentMessageReference），非契约字段。
                <ImageReferenceThumb
                  key={`image-${ref.id}`}
                  image={ref}
                  dataUrl={(ref as ImageAttachment & { dataUrl?: string }).dataUrl}
                  t={t}
                />
              ) : (
                <span key={`${ref.type}-${ref.id}`} className="agent-attachment-chip">
                  <span className="material-symbols-outlined" style={{ fontSize: '0.7rem' }}>
                    {attachmentIcon(ref.type)}
                  </span>
                  {ref.label}
                </span>
              ),
            )}
          </div>
        )}
      </div>
    );
  }

  if (message.role === 'tool') {
    const results = message.toolResults ?? [];
    // Story 3.7 #2（design D5 + CR-001 修正）：findings 档最先判——write_chapter 的 reader-audit findings
    // metadata（items 非空）平铺替换该 result 的默认呈现位。⚠ write_chapter 在 WRITE_TOOLS
    // （agentDiffSlice.ts 注释：chapter_accept → field_patch 路由），故 findings 档在 WRITE_TOOLS
    // 判定之前拦截。替换语义：findings 路径本就无 pending diff（field_patch 走 PatchReviewPanel），
    // 且 result.output（裁决依据/警示/指引，CR-001）由 ReviewFindingsCard 卡组尾逐字呈现——
    // 卡片是结构化摘要非双源；无 findings 的 write_chapter（accept 落盘路径）行为零变更（仍走 DiffCard）。
    const findingsResults: typeof results = [];
    // dogfood R2 #12：三派发工具的成功产出（整段草案/调研报告）——专用产出卡拦截档。
    const draftResults: typeof results = [];
    const settingMdResults: typeof results = [];
    const authorProfileResults: typeof results = [];
    const diffResults: typeof results = [];
    const stepResults: typeof results = [];
    for (const r of results) {
      // dogfood R2 #13：present_result 结果卡抑制——收尾声明的可见产物是 assistant 正文本身
      //（#8 契约「呈现正文与调用同一条消息」），结果卡只复述 summary 纯冗余（用户：「末尾这里
      // 多了」）。工具的信号职能（loop plan/discuss 校验 + intent_restate 盖章）不经 UI，不受影响。
      // CR-42（dogfood R2 BMad CR）：仅**成功形**抑制——`ok !== false` 才 continue（mirror 相邻
      // DispatchDraftCard 拦截对 ok:false 的穿透先例，极性相反：present_result 成功的 metadata
      // 无 ok 键，非 false 即成功形）；错误形（metadata.ok === false）穿透落 AgentToolCard
      // 结果卡，工具失败 UI 不再零痕迹。
      if (
        (r.toolName ?? r.toolId ?? '') === 'present_result'
        && (r.metadata as { ok?: unknown } | undefined)?.ok !== false
      ) continue;
      // R2 #12：派发产出**最先**拦截（mirror findings 档次序）——草案是核心交付物，
      // 默认展开 + MD 渲染；ok:false 不拦（错误/降级提示照走 AgentToolCard，不被误当草案）。
      if (dispatchDraftBadgeKey(r) !== null) draftResults.push(r);
      else if ((extractReaderAuditFindings(r.metadata)?.items.length ?? 0) > 0) findingsResults.push(r);
      // Story 2.2：setting_md_patch 在 WRITE_TOOLS 判定之前拦截（mirror findings 档）——
      // 该 envelope 无 pending diff / field_patch，落 DiffCard 会渲染成误导性的「已处理」壳。
      else if (extractSettingMdPatch(r.metadata)) settingMdResults.push(r);
      // setting_md_update 的非 envelope 结果（autoApply 档已直落）同样不走 DiffCard
      // （无 pending diff 可匹配 → 误导壳）——落普通 AgentToolCard 呈现 output 摘要。
      else if ((r.toolName ?? r.toolId ?? '') === 'setting_md_update') stepResults.push(r);
      // CR-003（8.6 BMad CR HIGH）：creative_brief/preferences 两工具 autoApply 直落结果（非
      // envelope，metadata {ok, applied}）同 mirror setting_md 理由不落 DiffCard（WRITE_TOOLS
      // fallthrough 会渲染「已处理」误导壳——无 pending diff 可匹配）。与 setting_md 不同处：
      // 这两工具的 envelope 是 field_patch（走 WRITE_TOOLS diff 路径进 DiffCard 呈现人审卡），
      // 故条件必须是「非 field_patch 结果」才拦截——envelope 照旧走 DiffCard。
      else if (
        ((r.toolName ?? r.toolId ?? '') === 'creative_brief_update'
          || (r.toolName ?? r.toolId ?? '') === 'creative_preferences_update')
        && (r.metadata as { type?: unknown } | undefined)?.type !== 'field_patch'
      ) stepResults.push(r);
      // Story 8.6：author_profile_patch 同位拦截（mirror setting_md 档）。author_profile_update
      // 不在 WRITE_TOOLS（专用分流），非 envelope 结果（autoApply 档已直落）天然落 stepResults
      // 呈现 output 摘要，无需专门分支。
      else if (extractAuthorProfilePatch(r.metadata)) authorProfileResults.push(r);
      else if (WRITE_TOOLS.includes(r.toolName ?? r.toolId ?? '')) diffResults.push(r);
      else stepResults.push(r);
    }
    const childTagOnTool = parseChildTag(message.content ?? '');
    // 子4 W6：桥徽标 = 本会话 leader 车道经桥运行（子代理工具卡不标——桥只接 dialogue）。
    const bridgeOnTool = bridgeLaneActive && !childTagOnTool;

    return (
      <div className="agent-msg agent-msg-tool">
        {childTagOnTool && (
          <ChildBadge source={childTagOnTool.source} role={childTagOnTool.role} depth={childTagOnTool.depth} t={t} />
        )}
        {/* R2 #12：派发产出卡置顶（拦截档 = 最先呈现）——子代理组完成即收起后，
            草案仍有独立可见落点。 */}
        {draftResults.map((r, i) => (
          <DispatchDraftCard key={`draft-${i}`} result={r} />
        ))}
        {findingsResults.map((r, i) => (
          <ReviewFindingsCard key={`findings-${i}`} result={r} messageId={message.id} />
        ))}
        {settingMdResults.map((r, i) =>
          // R2 #25：未决卡钉底不内联（run 继续会被后续消息顶出视野——AgentPanel 在
          // 消息滚动区外钉底）；resolved 后在此存档展示。
          isSettingMdPatchResolved(r, resolvedSettingMdPatches) ? (
            <SettingMdPatchCard key={`setting-md-${i}`} result={r} />
          ) : null,
        )}
        {authorProfileResults.map((r, i) =>
          // R2 #25：同上——未决钉底，resolved 回内联。
          isAuthorProfilePatchResolved(r, resolvedAuthorProfilePatches) ? (
            <AuthorProfilePatchCard key={`author-profile-${i}`} result={r} />
          ) : null,
        )}
        {diffResults.map((r, i) => <DiffCard key={`diff-${i}`} result={r} />)}
        {stepResults.length > 0 && (
          // Story 3.5 Step 7: the work-steps header idiom moved into the shared
          // <Collapsible> (the Collapsible IS the .agent-work-steps wrapper in
          // the multi-step branch). Default stays OPEN — these are the current
          // turn's visible steps, unlike the collapsed-by-default batch groups.
          stepResults.length > 1 ? (
            <Collapsible
              defaultOpen
              className="agent-work-steps"
              headerClassName="agent-work-steps-header"
              bodyClassName="agent-work-steps-body"
              chevron="start"
              chevronIcons={{ open: 'expand_more', closed: 'chevron_right' }}
              header={
                <>
                  <span className="agent-work-steps-title">{t('agent.workSteps')}</span>
                  <span className="agent-work-steps-count">{t('agent.workStepsCount', { count: stepResults.length })}</span>
                </>
              }
            >
              {stepResults.map((r, i) => <AgentToolCard key={`step-${i}`} result={r} bridge={bridgeOnTool} />)}
            </Collapsible>
          ) : (
            <div className="agent-work-steps">
              {stepResults.map((r, i) => <AgentToolCard key={`step-${i}`} result={r} bridge={bridgeOnTool} />)}
            </div>
          )
        )}
      </div>
    );
  }

  return (
    <div className="agent-msg agent-msg-assistant">
      {/* dogfood R2 #29：说话者标签分化——leader 显「Leader」，子代理显
          「Sub Agent · 具体名称」（名称随 locale 翻译，roleLabel 词表外回落原文）。
          旧态全员「Agent」+ 子代理再叠一枚 ChildBadge——身份重复且无法区分谁在说话。 */}
      <div className={`agent-msg-label${childTag ? ' agent-msg-label--child' : ''}`}>
        {childTag ? (
          <>
            <span className="material-symbols-outlined" aria-hidden="true">
              {childTag.source === 'skill' ? 'extension' : 'smart_toy'}
            </span>
            {childTag.source === 'skill' ? t('agent.childSkill') : t('agent.subAgent')}
            {' · '}
            {roleLabel(childTag.role, t)}
            {childTag.depth > 1 ? ` · d${childTag.depth}` : ''}
          </>
        ) : (
          t('agent.leader')
        )}
      </div>
      {/* 09-12 子2（design §8③）：终态标注实际模型（成本/质量预期不错位）。只在
          generatedBy 在场（档位配了链 + fetch 对账/历史装载路径）时渲染——旧消息零变化；
          回退发生时追加「回退自 A、B」（CR-24：逐家失败全列，不只 [0]——链上每家都
          烧过一次 attempt，漏显会让用户误判失败面）。 */}
      {message.role === 'assistant' && message.generatedBy ? (
        <span className="agent-msg-generated-by">
          <span className="material-symbols-outlined" aria-hidden="true">neurology</span>
          {t('agent.messageGeneratedBy', { model: modelDisplayName(modelConfigForBadge, message.generatedBy) })}
          {message.generatedBy.fallbackFrom?.length ? (
            <span className="agent-msg-generated-by-from">
              {' · '}
              {t('agent.messageGeneratedByFallback', {
                from: message.generatedBy.fallbackFrom
                  .map((failed) => modelDisplayName(modelConfigForBadge, failed))
                  .join(resolvedLocale === 'zh-CN' ? '、' : ', '),
              })}
            </span>
          ) : null}
        </span>
      ) : null}
      {canTruncateFrom && onTruncateFrom && <TruncateFromHereButton onClick={() => onTruncateFrom(message.id)} t={t} />}
      {message.reasoning ? (
        <ReasoningFold reasoning={message.reasoning} streaming={isStreaming} revealed={revealRef.current} t={t} />
      ) : null}
      {/* R2 #81：链指令 JSON 整体命中 → 折叠卡替代正文通道（不进 MD/打字机/流式轨）。 */}
      {chainDirective ? (
        <ChainDirectiveCard payload={chainDirective} />
      ) : (renderedHtml ?? animatedHtml) ? (
        <div
          className={`agent-msg-content agent-msg-md${isStreaming ? ' agent-msg-md--streaming' : ''}`}
        >
          {/* R2 #11④ 头部：250ms 节流的已定型 MD 块 */}
          <div className="agent-msg-md-head" dangerouslySetInnerHTML={{ __html: (renderedHtml ?? animatedHtml)! }} />
          {/* R2 #11④ 尾轨：逐字生长的纯文本（当前行）——零解析开销，每 rAF 更新 */}
          {tailText.length > 0 && <span className="agent-stream-tail">{tailText}</span>}
        </div>
      ) : (
        // While the snapshot track is active (pre-first-snapshot window), show the
        // in-progress text as plain text (no per-tick markdown parse).
        snapshotActive && textToRender && (
          <div className={`agent-msg-content agent-msg-md${isStreaming ? ' agent-msg-md--streaming' : ''}`}>
            {textToRender.slice(0, displayLen)}
          </div>
        )
      )}
      {isStreaming && !assistantContent && (
        // dogfood T1 Stage 4（design §7.1 生成中容器态）：首条正文 delta 前的三点 loading
        //（复用既有样式）——占位建立（首 delta 建位，reasoning 常先于正文到达）到正文出现
        // 之间无空窗闪跳。
        <div className="agent-message-loading" aria-label={t('agent.generating')}>
          <span className="agent-loading-dot" />
          <span className="agent-loading-dot" />
          <span className="agent-loading-dot" />
        </div>
      )}
      {isStreaming && message.stalled && (
        // dogfood T1 CR-T1-038a：60s 无新 delta 的停滞提示（agentStreamBuffer 看门狗置标）——
        // 静默断流下 caret 永闪是假活，标停滞让用户知道「卡了/在等」；非终态，新 delta 到达
        // 下一 flush 窗自动摘标。
        <div className="agent-stream-stalled" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">hourglass_top</span>
          <span>{t('agent.streamStalled')}</span>
        </div>
      )}
      {/* R2 #11⑤（findings #11⑤）：流式期直出钮挪到输入行（AgentInput，经 store
          streamRevealTick 跨组件信号）——不再悬在消息正文底部、不可按时不残影；
          历史回放 skip 钮（跳打字机动画）原位原样保留。R2 #81：拦截成折叠卡的消息
          无正文轨可跳，skip 钮不挂。 */}
      {shouldAnimate && isAnimating && !chainDirective && (
        <button type="button" className="agent-typewriter-skip" onClick={skip}>
          {t('agent.skipAnimation')}
        </button>
      )}
      {/* R2 #30：工具参数流指示——正文输出毕、tool-call JSON 参数仍在流的静默窗
          （该窗口流式标志压着全局三点 loading，旧态完全无信号，用户分不清卡死/网络）。
          终帧替换整条消息即消失（streamingToolName 不再带上）。 */}
      {isStreaming && message.streamingToolName && (
        <div className="agent-tool-call-badge agent-tool-call-badge--live" role="status">
          <span className="material-symbols-outlined agent-tool-call-live-icon" aria-hidden="true">
            progress_activity
          </span>
          {t('agent.toolCalling', { name: toolLabel(message.streamingToolName, t) })}
          {bridgeLaneActive && !childTag ? (
            <span className="agent-tool-call-bridge-chip" title={t('agent.bridgeToolBadgeTitle')}>
              {t('agent.bridgeToolBadge')}
            </span>
          ) : null}
        </div>
      )}
      {/* R2 #9：结果卡已落地的调用徽标隐去（徽标 = 执行中指示，卡片 = 完成态）。 */}
      {message.toolCalls
        ?.filter((tc) => !resolvedToolCallIds?.has(tc.id))
        .map((tc) => {
        const { icon } = toolPresentation(tc.name);
        return (
          <div key={tc.id} className="agent-tool-call-badge">
            <span className="material-symbols-outlined">{icon}</span>
            {toolLabel(tc.name, t)}
          </div>
        );
      })}
    </div>
  );
}

// Memoized: a streaming reply appends new messages frequently; without this
// every already-rendered message re-renders on each new event in the list.
export const AgentMessageItem = memo(AgentMessageItemImpl);
