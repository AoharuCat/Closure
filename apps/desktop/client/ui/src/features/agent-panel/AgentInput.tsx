import { useState, useCallback, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { Tooltip } from '../../shared/components/Tooltip';
import { storage } from '../../shared/store/storage';
import type { AgentMode, AgentBehaviorMode } from '../../shared/store/types';
import type { StructurePattern } from '@orison/shared-contracts';
import type { Attachment } from '../../shared/types/attachment';
import { readAssetsDirectory, type DirEntry } from '../../shared/api/assets';
import { INBOX_UPLOAD_ACCEPT, listInboxFiles } from '../../shared/api/inboxAttachments';
// 09-01 B4（dogfood #45）：chat 图片进件三入口（选择器按钮 / 剪贴板粘贴 / AgentPanel
// drop zone 后接线）统一走 uploadChatImages；accept 面与压缩白名单同源。
import { CHAT_IMAGE_ACCEPT } from '../../shared/api/chatImages';
import { AgentConfirmCard } from './AgentConfirmCard';
import { AgentPassageResolveCard } from './AgentPassageResolveCard';

// Story 3.1 WP2: the existing permission mode (readonly/suggest/auto) is
// relabeled to the autonomy axis (微操/半自动/全权). Values are UNCHANGED for
// back-compat — only the i18n key each option points at changes.
const MODE_KEYS: { value: AgentMode; i18nKey: string }[] = [
  { value: 'readonly', i18nKey: 'agent.modeMicro' },
  { value: 'suggest', i18nKey: 'agent.modeHalfAuto' },
  { value: 'auto', i18nKey: 'agent.modeFull' },
];

// Story 3.1 WP1: behavior mode (normal/discuss/plan) is a SECOND, orthogonal
// axis to the permission mode above. It governs how the leader acts per turn,
// not which tools it may call — hence a separate select.
const BEHAVIOR_MODE_KEYS: { value: AgentBehaviorMode; i18nKey: string }[] = [
  { value: 'normal', i18nKey: 'agent.modeNormal' },
  { value: 'discuss', i18nKey: 'agent.modeDiscuss' },
  { value: 'plan', i18nKey: 'agent.modePlan' },
];

// Story 3.1 WP4: direction-first "结构 pattern" affordance. The 6 precast
// structural skeletons + blank from structurePatternSchema (Story 1.4).
// Selecting one injects it as a file-style reference through the existing
// attachment channel (renderAttachmentsIntoContent renders a pointer block) —
// an OPTIONAL accelerator, natural language stays the primary input.
const PATTERN_OPTIONS: { value: StructurePattern; i18nKey: string }[] = [
  { value: 'anchor-single', i18nKey: 'agent.patternAnchorSingle' },
  { value: 'lotus-converging', i18nKey: 'agent.patternLotusConverging' },
  { value: 'main-sub-dual', i18nKey: 'agent.patternMainSubDual' },
  { value: 'progressive-jigsaw', i18nKey: 'agent.patternProgressiveJigsaw' },
  { value: 'parallel-weak', i18nKey: 'agent.patternParallelWeak' },
  { value: 'triple-interactive', i18nKey: 'agent.patternTripleInteractive' },
  { value: 'blank', i18nKey: 'agent.patternBlank' },
];

const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i;

/** Flatten the (possibly nested) assets/images tree into relative image paths. */
function flattenAssetImages(entries: DirEntry[]): { name: string; rel: string }[] {
  const out: { name: string; rel: string }[] = [];
  const walk = (items: DirEntry[]) => {
    for (const e of items) {
      if (e.isDir) {
        if (Array.isArray(e.children)) walk(e.children);
        continue;
      }
      if (!IMAGE_RE.test(e.name)) continue;
      const sub = (e.path ?? `/${e.name}`).replace(/^\//, '');
      out.push({ name: e.name, rel: `assets/images/${sub}` });
    }
  };
  walk(entries);
  return out;
}

export function AgentInput() {
  const {
    sendAgentMessage, cancelAgent, activeSessionRunning, sessionSwitching,
    agentMode, setAgentMode,
    agentBehaviorMode, setAgentBehaviorMode,
    resolvedLocale,
    hasToolConfirm, hasPassageResolve,
    chapters, openFiles,
    pendingAttachments, addAttachment, removeAttachment,
    attachmentUploadStates, uploadInboxFiles, uploadChatImages, attachInboxMaterial, removeAttachmentUpload,
    projectPath,
    draftPreset,
    consumeDraft,
    // W4（09-21-subagent-bg-decouple §6.1/F3）：检视态只读标记——bg 子会话视图锁输入面
    //（只读横幅替代输入框；确认卡例外照挂，F3/D8）。
    agentViewReadonly,
    returnToParentSession,
    // dogfood R2 #11⑤（findings #11⑤）+ CR-38（dogfood R2 BMad CR）：输入行直出钮——存在
    // streaming 且 content **或 reasoning** 非空的消息时可按（think-first 纯思考期恰是最想
    // 直出的窗口；不可按即不渲染，无 disabled 残影）；点击发跨组件信号拉满流式渐进轨。
    streamRevealAvailable,
    requestStreamReveal,
  } = useAppStore(useShallow((s) => ({
    sendAgentMessage: s.sendAgentMessage,
    cancelAgent: s.cancelAgent,
    // dogfood T1 Stage 3（r8 三分）：输入区是视图语义——视图运行态 + 切换加载态共同禁用。
    activeSessionRunning: s.activeSessionRunning,
    sessionSwitching: s.sessionSwitching,
    agentMode: s.agentMode,
    setAgentMode: s.setAgentMode,
    agentBehaviorMode: s.agentBehaviorMode,
    setAgentBehaviorMode: s.setAgentBehaviorMode,
    // r8 键控：挂载门只看当前视图会话的键（后台会话的卡不漏进前台输入区）。
    hasToolConfirm: s.agentSessionId ? s.pendingToolConfirmBySession[s.agentSessionId] !== undefined : false,
    hasPassageResolve: s.agentSessionId ? s.pendingPassageResolveBySession[s.agentSessionId] !== undefined : false,
    resolvedLocale: s.resolvedLocale,
    chapters: s.novelChapters,
    openFiles: s.openFiles,
    pendingAttachments: s.pendingAttachments,
    addAttachment: s.addAttachment,
    removeAttachment: s.removeAttachment,
    attachmentUploadStates: s.attachmentUploadStates,
    uploadInboxFiles: s.uploadInboxFiles,
    uploadChatImages: s.uploadChatImages,
    attachInboxMaterial: s.attachInboxMaterial,
    removeAttachmentUpload: s.removeAttachmentUpload,
    projectPath: s.currentProject?.path,
    draftPreset: s.draftPreset,
    consumeDraft: s.consumeDraft,
    agentViewReadonly: s.agentViewReadonly,
    returnToParentSession: s.returnToParentSession,
    streamRevealAvailable: s.agentMessages.some(
      (m) => m.streaming === true && ((m.content ?? '').length > 0 || (m.reasoning ?? '').length > 0),
    ),
    requestStreamReveal: s.requestStreamReveal,
  })));

  const inputBusy = activeSessionRunning || sessionSwitching;

  const { t } = useI18n(resolvedLocale);
  const [text, setText] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [assetImages, setAssetImages] = useState<{ name: string; rel: string }[]>([]);
  // 09-01 A3（R1.8）：attach 菜单「inbox 材料」段数据（懒加载，mirror 资产图片段）。
  const [inboxFiles, setInboxFiles] = useState<{ name: string; rel: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  // 09-01 B4：图片上传隐藏 input（与 A3 文档 input 并列，accept 面取白名单）。
  const imageUploadInputRef = useRef<HTMLInputElement>(null);

  // 09-01 A3：上传/解析在途 → Send 禁用（design §1.2——parsing 转圈可见，大 PDF 走
  // 端点最长 120s 属可接受等待；description 异步生成不参与门控，preview 兜底）。
  const uploadChips = Object.entries(attachmentUploadStates).filter(([, entry]) => entry.state !== 'ready');
  const uploadsInFlight = uploadChips.some(
    ([, entry]) => entry.state === 'uploading' || entry.state === 'parsing',
  );

  // 用户拖拽放大的输入框高度（dogfood 2026-08-21：原 auto-grow 硬顶 160px 无放大选项；
  // 次日改顶边拖拽条——原生右下角 resize 在底部停靠布局里底边被钉死，拖下反而向上长，
  // 直觉相反）。0 = 未手动设过（维持原 auto-grow 行为）；设过后成为 auto-grow 的下限，
  // 且跨会话持久（storage）。
  const [userInputHeight, setUserInputHeight] = useState<number>(() =>
    storage.get<number>('agentInputHeight', 0),
  );
  const userInputHeightRef = useRef(userInputHeight);
  userInputHeightRef.current = userInputHeight;
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Load asset images lazily when the attach menu opens, so a user can pin a
  // generated/imported image as a `file` reference for the agent. Reuses the
  // file attachment channel — no new IPC/runtime shape needed.
  useEffect(() => {
    if (!showAttachMenu || !projectPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await readAssetsDirectory(`${projectPath}/assets/images`);
        if (!cancelled) setAssetImages(flattenAssetImages(entries));
      } catch {
        if (!cancelled) setAssetImages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [showAttachMenu, projectPath]);

  // 09-01 A3（R1.8/AC6i）：inbox 材料懒加载——已上传材料列出可再次挂附件（新会话
  // 复用长寿命材料的主入口；哈希命中路径零 LLM 调用）。
  useEffect(() => {
    if (!showAttachMenu || !projectPath) return;
    let cancelled = false;
    void (async () => {
      const files = await listInboxFiles(projectPath);
      if (!cancelled) setInboxFiles(files);
    })();
    return () => { cancelled = true; };
  }, [showAttachMenu, projectPath]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // auto-grow 上限 160px（原行为），用户手动高度作为下限，绝对顶 40vh。
    const maxVh = Math.round(window.innerHeight * 0.4);
    const grown = Math.min(el.scrollHeight, 160);
    const target = Math.min(Math.max(grown, userInputHeight), maxVh);
    el.style.height = `${target}px`;
  }, [text, userInputHeight]);

  // 顶边拖拽条（替原生 resize）：往上拖变大、往下拖变小——底部停靠组件的方向直觉。
  const INPUT_HEIGHT_MIN = 40;
  const onResizeHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = textareaRef.current;
    if (!el || inputBusy) return;
    dragStateRef.current = {
      startY: e.clientY,
      startHeight: Math.round(el.getBoundingClientRect().height),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current;
    if (!st) return;
    const maxVh = Math.round(window.innerHeight * 0.4);
    const dy = e.clientY - st.startY; // 向下为正 → 高度减小
    const next = Math.max(INPUT_HEIGHT_MIN, Math.min(st.startHeight - dy, maxVh));
    // dogfood #44：ref 同步在渲染期——pointermove 是连续事件（React 18 异步批处理），
    // pointerup 若先于重渲染到达会持久化过期 ref（重启丢高度实录）。这里同步写 ref，
    // 且拖拽中直接落 storage（小值高频写无害），pointerup 再写一次兜底。
    userInputHeightRef.current = next;
    storage.set('agentInputHeight', next);
    setUserInputHeight(next);
  };
  const onResizeHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    storage.set('agentInputHeight', userInputHeightRef.current);
  };

  useEffect(() => {
    if (!showAttachMenu) return;
    const handler = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAttachMenu]);

  // Story 3.7：「应用并补充」预填（insightInteractionSlice.draftPreset）——InsightCard 展开态
  // 把 apply 模板预填进输入框（单击直发的补充形态：用户补完自己发，发送时受既有 agentLoading
  // 门管，预填本身不受限，D11）。消费即清空（consumeDraft）避免重复注入；已有输入时追加
  // 不覆盖（保留用户打到一半的话）。聚焦输入框方便直接续写补充。
  useEffect(() => {
    if (draftPreset === null) return;
    setText((prev) => (prev.trim().length > 0 ? `${prev}\n${draftPreset}` : draftPreset));
    consumeDraft();
    textareaRef.current?.focus();
  }, [draftPreset, consumeDraft]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    // 09-01 A3：上传/解析在途禁发（chip 转圈可见；error 态不拦——错误 chip 非附件，
    // 可移除，发送时随状态机整体清场）。
    if (!trimmed || inputBusy || uploadsInFlight) return;

    // Attachments are passed structurally by sendAgentMessage; no text flattening.
    setText('');
    sendAgentMessage(trimmed);
  }, [text, inputBusy, uploadsInFlight, sendAgentMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAddAttachment = (att: Attachment) => {
    addAttachment(att);
    setShowAttachMenu(false);
  };

  // ── 09-01 A3：上传入口（R1.1，design D-A 隐藏 input[type=file]）──

  const handleUploadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // 允许重复选同一文件（value 复位——否则二次选同名文件不触发 onChange）。
    e.target.value = '';
    if (files.length === 0) return;
    setShowAttachMenu(false);
    void uploadInboxFiles(files);
  };

  const handleAttachInboxMaterial = (rel: string, name: string) => {
    setShowAttachMenu(false);
    void attachInboxMaterial(rel, name);
  };

  // ── 09-01 B4（R2.1 / dogfood #45）：图片进件——选择器按钮 + 剪贴板粘贴两入口 ──
  //（AgentPanel drop zone 图片分支同走 uploadChatImages，由 drop handler 接线。）

  const handleImageUploadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // 允许重复选同一文件（value 复位——否则二次选同名文件不触发 onChange）。
    e.target.value = '';
    if (files.length === 0) return;
    setShowAttachMenu(false);
    void uploadChatImages(files);
  };

  /**
   * 剪贴板粘贴（截图流，唯一净新增通道）：`clipboardData.items` 过
   * `kind==='file' && type image/*` → getAsFile 进件；**纯文本粘贴路径零影响**（无图
   * file 项时不 preventDefault，原生文本粘贴照旧——回归锁死）。同一截图部分系统会以
   * 多 item 形态重复列出——按 name|type|size 去重。
   *
   * CR-021：图片项存在时**也不再 preventDefault**——放行浏览器默认文本粘贴（图文混排
   * 源的 text/plain 表示照常落入输入框，图片照旧进附件）。纯截图（无 text/plain）默认
   * 粘贴本就不插入任何内容，零重复表示。
   */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageFiles: File[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile?.();
      if (!file) continue;
      const key = `${file.name}|${file.type}|${file.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imageFiles.push(file);
    }
    if (imageFiles.length === 0) return;
    void uploadChatImages(imageFiles);
  };

  // ── W4（09-21-subagent-bg-decouple §6.1/F3）：检视态只读分支 ──
  // bg 子会话视图 = 自治执行单元，V1 不支持插话——输入框/档位钮整体替换为只读横幅 +
  // 返回键（回父会话）。hooks 全在上方无条件执行（分支只裁 JSX）。确认卡例外照挂
  //（F3：只读检视 ≠ 不能处置确认；D8 定案 V1 自动放行下通常无卡，接线保留）。
  if (agentViewReadonly) {
    return (
      <div className="agent-input-area agent-input-area--readonly">
        {hasToolConfirm && <AgentConfirmCard />}
        {hasPassageResolve && <AgentPassageResolveCard />}
        <div className="agent-input-readonly-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">visibility</span>
          <span className="agent-input-readonly-text">{t('agent.childViewReadonlyBanner')}</span>
          <button
            type="button"
            className="agent-input-readonly-back"
            onClick={returnToParentSession}
            title={t('agent.childViewBack')}
          >
            <span className="material-symbols-outlined" aria-hidden="true">undo</span>
            {t('agent.childViewBack')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-input-area">
      {hasToolConfirm && <AgentConfirmCard />}
      {hasPassageResolve && <AgentPassageResolveCard />}

      {(pendingAttachments.length > 0 || uploadChips.length > 0) && (
        <div className="agent-input-attachments">
          {uploadChips.map(([uploadId, entry]) => {
            // 09-01 A3：上传/解析/错误态 chip（in-flight 附件对象尚不存在，chip 由
            // attachmentUploadStates 渲染；error 显指引 + 可移除，AC3；ready 条目在
            // pendingAttachments 侧渲染，不双份）。
            // 09-01 B4：variant=image 分支——缩略图直显（压缩完成即挂 thumbDataUrl）+
            // 图专用状态/拒收文案（非白名单 / 压不动超限 / 解码失败三档）。
            if (entry.variant === 'image') {
              const imgError = entry.state === 'error';
              const imgTitle = imgError
                ? entry.errorKind === 'too-large'
                  ? t('agent.uploadImageStateErrorTooLarge')
                  : entry.errorKind === 'not-image'
                    ? t('agent.uploadImageStateErrorType')
                    : t('agent.uploadImageStateError')
                : t('agent.uploadImageStateUploading');
              return (
                <span
                  key={`img-${uploadId}`}
                  className={`agent-attachment-chip agent-attachment-chip-image${imgError ? ' is-error' : ''}`}
                  title={imgTitle}
                >
                  {entry.thumbDataUrl ? (
                    <img className="agent-attachment-chip-thumb" src={entry.thumbDataUrl} alt={entry.label} />
                  ) : (
                    <span
                      className={`material-symbols-outlined${!imgError ? ' agent-upload-spin' : ''}`}
                      style={{ fontSize: '0.7rem' }}
                    >
                      {imgError ? 'error' : 'progress_activity'}
                    </span>
                  )}
                  {entry.label}
                  {!imgError && <span className="agent-upload-state-text">{t('agent.uploadImageStateUploading')}</span>}
                  <button type="button" className="agent-attachment-remove" onClick={() => removeAttachmentUpload(uploadId)}>
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </span>
              );
            }
            const isError = entry.state === 'error';
            const stateLabel = isError
              ? t('agent.uploadStateError')
              : entry.state === 'uploading'
                ? t('agent.uploadStateUploading')
                : t('agent.uploadStateParsing');
            // CR-018：error tooltip 按 errorKind 分流——scanned 扫描件指引 / 拒收三档
            //（扩展名 / 超 50MB / 超单批，与 toast 同 tier 文案域）/ 其余通用解析失败。
            const errorTitle = entry.errorKind === 'scanned'
              ? t('agent.uploadStateErrorScanned')
              : entry.errorKind === 'rejected-format'
                ? t('agent.uploadStateErrorRejectedFormat')
                : entry.errorKind === 'rejected-size'
                  ? t('agent.uploadStateErrorRejectedSize')
                  : entry.errorKind === 'rejected-batch'
                    ? t('agent.uploadStateErrorRejectedBatch')
                    : t('agent.uploadStateError');
            return (
              <span
                key={`inbox-${uploadId}`}
                className={`agent-attachment-chip agent-attachment-chip-upload${isError ? ' is-error' : ''}`}
                title={isError ? errorTitle : stateLabel}
              >
                <span
                  className={`material-symbols-outlined${!isError ? ' agent-upload-spin' : ''}`}
                  style={{ fontSize: '0.7rem' }}
                >
                  {isError ? 'error' : entry.state === 'uploading' ? 'upload' : 'progress_activity'}
                </span>
                {entry.label}
                <span className="agent-upload-state-text">{isError ? '' : stateLabel}</span>
                <button type="button" className="agent-attachment-remove" onClick={() => removeAttachmentUpload(uploadId)}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </span>
            );
          })}
          {pendingAttachments.map((att) => {
            if (att.type === 'selection') {
              // Render selections as a quoted preview. The quote marks are added
              // by the component and the inner text is what gets truncated, so the
              // opening + closing quotes are always balanced — unlike the old
              // `slice(0,20)` label, which cut dialogue mid-quote.
              const raw = (att.text ?? att.label).replace(/\s+/g, ' ').trim();
              const preview = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
              return (
                <span
                  key={`selection-${att.id}`}
                  className="agent-attachment-chip agent-attachment-chip-quote"
                  title={att.text ?? att.label}
                >
                  <span className="agent-attachment-quote-text">“{preview}”</span>
                  <button type="button" className="agent-attachment-remove" onClick={() => removeAttachment(att.id)}>
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </span>
              );
            }
            // 09-01 B4（R2.6）：ready 图片附件 chip——缩略图直显（ready 条目随迁移保留
            // thumbDataUrl，经 attachmentUploadStates 查；发送时随状态机整体清场）。
            if (att.type === 'image') {
              const thumb = attachmentUploadStates[att.id]?.thumbDataUrl;
              return (
                <span key={`image-${att.id}`} className="agent-attachment-chip agent-attachment-chip-image" title={att.label}>
                  {thumb ? (
                    <img className="agent-attachment-chip-thumb" src={thumb} alt={att.label} />
                  ) : (
                    <span className="material-symbols-outlined" style={{ fontSize: '0.7rem' }}>image</span>
                  )}
                  {att.label}
                  <button type="button" className="agent-attachment-remove" onClick={() => removeAttachment(att.id)}>
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </span>
              );
            }
            // CR-010②：resolve 解析备注（非 UTF-8 转换提示 / 端点降级备注等）随 ready
            // 条目携带——chip tooltip 消费；无备注（既有 file 附件/章/选段）无 title，
            // 渲染零变化。
            const resolveNote = att.type === 'file' ? attachmentUploadStates[att.id]?.note : undefined;
            return (
              <span key={`${att.type}-${att.id}`} className="agent-attachment-chip" title={resolveNote}>
                <span className="material-symbols-outlined" style={{ fontSize: '0.7rem' }}>
                  {att.type === 'chapter' ? 'description' : 'insert_drive_file'}
                </span>
                {att.label}
                <button type="button" className="agent-attachment-remove" onClick={() => removeAttachment(att.id)}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="agent-input-toolbar">
        <div className="agent-input-toolbar-left">
          <button
            type="button"
            className="agent-panel-icon-btn"
            onClick={() => setShowAttachMenu(!showAttachMenu)}
            title={t('agent.attach')}
          >
            <span className="material-symbols-outlined">attach_file</span>
          </button>
          {showAttachMenu && (
            <div className="agent-attach-menu" ref={attachMenuRef}>
              {/* 09-01 A3（R1.1）：上传 section——外部文案大纲拷入 inbox/ 后挂附件
                  （docx/pdf 预解析派生 .md；扫描件 chip error 态给指引）。 */}
              <div className="agent-attach-section-title">{t('agent.attachUpload')}</div>
              <button
                type="button"
                className="agent-attach-item"
                onClick={() => uploadInputRef.current?.click()}
              >
                <span className="material-symbols-outlined">upload</span>
                {t('agent.attachUploadFile')}
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                accept={INBOX_UPLOAD_ACCEPT}
                className="agent-upload-file-input"
                onChange={handleUploadChange}
              />
              {/* 09-01 B4（R2.1 / dogfood #45）：图片上传入口——canvas 预检压缩（>10MB 两档
                  JPG）后落 inbox/images/ 挂 image 附件（指针 + b64hash）。粘贴截图走
                  textarea onPaste 同一 action。 */}
              <button
                type="button"
                className="agent-attach-item"
                onClick={() => imageUploadInputRef.current?.click()}
              >
                <span className="material-symbols-outlined">image</span>
                {t('agent.attachUploadImage')}
              </button>
              <input
                ref={imageUploadInputRef}
                type="file"
                multiple
                accept={CHAT_IMAGE_ACCEPT}
                className="agent-upload-file-input"
                onChange={handleImageUploadChange}
              />
              {/* 09-01 A3（R1.8/AC6i）：inbox 材料段——已上传材料再次挂附件（哈希命中
                  零 LLM；新会话复用长寿命材料的主入口）。 */}
              {inboxFiles.length > 0 && (
                <>
                  <div className="agent-attach-section-title">{t('agent.attachInbox')}</div>
                  {inboxFiles.map((f) => (
                    <button
                      key={f.rel}
                      type="button"
                      className="agent-attach-item"
                      onClick={() => handleAttachInboxMaterial(f.rel, f.name)}
                    >
                      <span className="material-symbols-outlined">markdown</span>
                      {f.name}
                    </button>
                  ))}
                </>
              )}
              <div className="agent-attach-section-title">{t('agent.attachChapter')}</div>
              {chapters.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  className="agent-attach-item"
                  onClick={() => handleAddAttachment({ type: 'chapter', id: ch.id, label: ch.title || ch.id })}
                >
                  <span className="material-symbols-outlined">description</span>
                  {ch.title || ch.id}
                </button>
              ))}
              {openFiles.length > 0 && (
                <>
                  <div className="agent-attach-section-title">{t('agent.attachFile')}</div>
                  {openFiles.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      className="agent-attach-item"
                      onClick={() => handleAddAttachment({ type: 'file', id: f.path, label: f.name })}
                    >
                      <span className="material-symbols-outlined">insert_drive_file</span>
                      {f.name}
                    </button>
                  ))}
                </>
              )}
              {assetImages.length > 0 && (
                <>
                  <div className="agent-attach-section-title">{t('agent.attachAsset')}</div>
                  {assetImages.map((a) => (
                    <button
                      key={a.rel}
                      type="button"
                      className="agent-attach-item"
                      onClick={() => handleAddAttachment({ type: 'file', id: a.rel, label: a.name })}
                    >
                      <span className="material-symbols-outlined">image</span>
                      {a.name}
                    </button>
                  ))}
                </>
              )}
              {/* Story 3.1 WP4: direction-first pattern affordance. Injects a
                  file-style reference chip; backend renders a pointer block. */}
              <div className="agent-attach-section-title">{t('agent.attachPattern')}</div>
              {PATTERN_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className="agent-attach-item"
                  onClick={() => handleAddAttachment({
                    type: 'file',
                    id: `pattern:${p.value}`,
                    label: `${t('agent.attachPatternLabel')}: ${t(p.i18nKey)}`,
                  })}
                >
                  <span className="material-symbols-outlined">account_tree</span>
                  {t(p.i18nKey)}
                </button>
              ))}
              {/* TODO(Story 3.x): @anchor / clue affordances — defer until a
                  dedicated attachment type (or reuse selection) is wired, to
                  avoid perturbing the existing attachment channel. Natural
                  language remains the primary direction input. */}
            </div>
          )}
        </div>
        <select
          className="agent-input-select"
          value={agentMode}
          onChange={(e) => setAgentMode(e.target.value as AgentMode)}
          disabled={inputBusy}
        >
          {MODE_KEYS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.i18nKey)}</option>
          ))}
        </select>
        {/* dogfood 2026-08-21：档位/模式光看名字看不懂——info 悬停解释。 */}
        <Tooltip label={t('agent.permissionModeHelp')} placement="top" multiline>
          <span className="agent-mode-help material-symbols-outlined" aria-hidden="true">info</span>
        </Tooltip>
        {/* Story 3.1 WP1: behavior mode (normal/discuss/plan), orthogonal to the
            autonomy mode above. Disabled mid-run like the other selects. */}
        <select
          className="agent-input-select"
          value={agentBehaviorMode}
          onChange={(e) => setAgentBehaviorMode(e.target.value as AgentBehaviorMode)}
          disabled={inputBusy}
          title={t('agent.behaviorModeTitle')}
        >
          {BEHAVIOR_MODE_KEYS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.i18nKey)}</option>
          ))}
        </select>
        <Tooltip label={t('agent.behaviorModeHelp')} placement="top" multiline>
          <span className="agent-mode-help material-symbols-outlined" aria-hidden="true">info</span>
        </Tooltip>
      </div>
      <div
        className="agent-input-resize"
        onPointerDown={onResizeHandlePointerDown}
        onPointerMove={onResizeHandlePointerMove}
        onPointerUp={onResizeHandlePointerUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('agent.inputResize')}
      />
      <div className="agent-input-row">
        <textarea
          ref={textareaRef}
          className="agent-input-textarea"
          placeholder={t('agent.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={inputBusy}
        />
        {/* dogfood R2 #11⑤（findings #11⑤）+ CR-38：直出小钮——stop 钮左侧，点击拉满流式
            渐进轨（不终止流，与 stop 语义区分）。仅存在 streaming 且 content 或 reasoning
            非空的消息时渲染（不可按即消失，无 disabled 残影）。 */}
        {streamRevealAvailable && (
          <button
            type="button"
            className="agent-input-btn"
            onClick={requestStreamReveal}
            title={t('agent.streamReveal')}
            aria-label={t('agent.streamReveal')}
          >
            <span className="material-symbols-outlined">fast_forward</span>
          </button>
        )}
        {activeSessionRunning ? (
          <button type="button" className="agent-input-btn" onClick={cancelAgent} title={t('agent.stop')}>
            <span className="material-symbols-outlined">stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="agent-input-btn"
            onClick={handleSend}
            title={t('agent.send')}
            disabled={!text.trim() || uploadsInFlight}
          >
            <span className="material-symbols-outlined">send</span>
          </button>
        )}
      </div>
    </div>
  );
}
