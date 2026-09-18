import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { CHAIN_NODE_ORDER, chainNodeLabel, type ChainRunState } from '../../shared/store/chainStreamBuffer';
// 09-12 子2：模型切换行的显示名单源（与通知条/终态徽标同一查表）。
import { modelDisplayName } from '../../shared/model/modelDisplay';
// dogfood T1 CR-T1-047（decision 1A）：draft-writer 阶段二产物是 JSON 信封
//（{"title":"…","text":"…正文…"} + 尾部 wordCount/<DRAFT_READY>）——渲染层纯函数解出
// text 增量，用户全程看可读章稿而非裸 JSON 转义字面。畸形 fallback 原样（不比现状差）。
import { extractChainDraftView } from './chainEnvelope';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 6（design §4 / §7.5，r1）：写章链运行卡。
//
// AgentMessages 尾部统一挂载（leader write_chapter / dogfood 链 IPC 两入口的事件都在
// parentSessionId 会话下广播——卡片对当前视图会话挂载即两入口统一，r1 备选「tool 消息内
// 嵌卡」因 dogfood 路径无 tool 消息不取）。数据源 chainRunBySession[currentSessionId]
//（chainStreamBuffer 维护）：
// - 头部：节点步进条（实心 success / 当前 accent 呼吸 / 未来 outline-variant 空心三态点；
//   chain-node-done 驱动推进）。
// - 正文：draft-writer 阶段二流式正文（store 每 250/500ms flush 一次 streamText——本组件按
//   flush 节流渲染 marked+DOMPurify，复用 leader 流式 MD 双轨的产物形态 + caret）；JSON
//   节点期间显示当前节点名 + 三点 loading（不流裸 JSON，r1 甄别）。
// - paused：降级为仅步进条（checkpoint pause 让位 ChapterReviewPanel，design §7.5「不叠加
//   两卡」）；aborted / error：warning「已中断」/ error「失败」标 + 已累积文本保留 + 重试钮
//   （mirror S4 重试钮样式——重发末条 user 消息）。
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  run: ChainRunState;
  onRetry?: () => void;
  /**
   * dogfood T1 CR-T1-048（decision 2A）：paused 态的 resume 入口——dogfood 链车道 pause 无
   * ChapterReviewPanel 承载（stub 会话无 chapter_review 事件面），链卡是唯一可见面。leader
   * 路径 pausedReview 在时 caller 不传（面板承载三动作，design §7.5「不叠加」）。
   */
  onResume?: () => void;
};

function renderMarkdown(content: string): string {
  // Sanitize（mirror AgentMessageItem.renderMarkdown——链正文是模型原始输出，renderer 持 IPC 面）。
  const html = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

export function ChainRunCard({ run, onRetry, onResume }: Props) {
  const { resolvedLocale, modelConfigForCard } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    // 09-12 子2：模型切换行的显示名查表源。
    modelConfigForCard: s.modelConfig as import('@orison/shared-contracts').ModelConfig | undefined,
  })));
  const { t } = useI18n(resolvedLocale);

  const compact = run.status === 'paused';
  const interrupted = run.status === 'aborted';
  const failed = run.status === 'error';

  // 步进条：已知节点 = CHAIN_NODE_ORDER 权威序；事件里出现但不在序表中的节点（未来加节点 /
  // 哨兵除外）追加在尾部防丢步。
  const orderedNodes = useMemo(() => {
    const known = new Set(CHAIN_NODE_ORDER);
    const extra = [...run.completedNodes, run.currentNodeId, run.errorNodeId]
      .filter((id): id is string => id !== null && !known.has(id));
    return [...CHAIN_NODE_ORDER, ...extra];
  }, [run.completedNodes, run.currentNodeId, run.errorNodeId]);

  // 正文 MD 快照：store flush 即节流（250/500ms），此处只按 flush 节奏解析（mirror
  // AgentMessageItem streaming 轨——本组件无 typewriter，直出终态与流式同路径零跳变）。
  // dogfood T1 CR-T1-047：streamText 是**原始累积**（含 JSON 信封/转义/尾部标记）——先经
  // extractChainDraftView 解出 text 值（锚点前与 text 闭合后的 wordCount/<DRAFT_READY>
  // 一概不渲；转义流前 unescape；非信封形态 fallback 原样）再渲染。
  const draftText = useMemo(
    () => (run.streamText ? extractChainDraftView(run.streamText).text : ''),
    [run.streamText],
  );
  const bodyHtml = useMemo(
    () => (draftText ? renderMarkdown(draftText) : null),
    [draftText],
  );

  const currentLabel = run.currentNodeId ? chainNodeLabel(run.currentNodeId) : null;
  const streamLabel = run.streamNodeId ? chainNodeLabel(run.streamNodeId) : null;

  // dogfood R2 #105 缝③（2026-08-30）：终态占位符节点——aborted/error 兜底 errorNodeId（失败
  // 定位节点；哨兵前最后一帧 node-done 未必到达，currentNodeId 可为 null）。
  const terminalNode = run.currentNodeId ?? run.errorNodeId;
  const terminalLabel = terminalNode ? chainNodeLabel(terminalNode) : null;
  // 占位符文案按 run.status 分流（loading 三点 :151 已分 status，文案漏了同款门——中断/失败
  // 态显「正在进行：{node}」与头部「已中断/失败」tag 同卡矛盾）。paused 不渲染正文区（compact
  // 现状）、completed 不渲染卡（挂载门现状），均不进此分流。
  const placeholderText =
    interrupted && terminalLabel
      ? t('agent.chainInterruptedAt', { node: terminalLabel })
      : failed && terminalLabel
        ? t('agent.chainFailedAt', { node: terminalLabel })
        : currentLabel
          ? t('agent.chainWorking', { node: currentLabel })
          : t('agent.chainPreparing');

  return (
    <div
      className={[
        'chain-run-card',
        compact ? 'chain-run-card--compact' : '',
        interrupted ? 'chain-run-card--interrupted' : '',
        failed ? 'chain-run-card--failed' : '',
      ].filter(Boolean).join(' ')}
      data-status={run.status}
    >
      <div className="chain-run-card-header">
        <span className="material-symbols-outlined chain-run-card-icon" aria-hidden="true">
          account_tree
        </span>
        <span className="chain-run-card-title">{t('agent.chainRunTitle')}</span>
        {interrupted && <span className="chain-run-card-tag chain-run-card-tag--warning">{t('agent.chainInterrupted')}</span>}
        {failed && <span className="chain-run-card-tag chain-run-card-tag--error">{t('agent.chainFailed')}</span>}
        {run.status === 'running' && (
          <span className="chain-run-card-running" aria-label={t('agent.generating')}>
            <span className="agent-loading-dot" />
            <span className="agent-loading-dot" />
            <span className="agent-loading-dot" />
          </span>
        )}
      </div>
      <div className="chain-run-card-steps" role="list">
        {orderedNodes.map((nodeId) => {
          const done = run.completedNodes.includes(nodeId);
          const current = !done && nodeId === run.currentNodeId;
          const errored = nodeId === run.errorNodeId;
          return (
            <span key={nodeId} className="chain-run-card-step" role="listitem">
              <span
                className={[
                  'chain-run-card-step-dot',
                  errored ? 'chain-run-card-step-dot--error' : '',
                  done ? 'chain-run-card-step-dot--done' : '',
                  current ? 'chain-run-card-step-dot--current' : '',
                ].filter(Boolean).join(' ')}
              />
              <span
                className={[
                  'chain-run-card-step-label',
                  current || errored ? 'chain-run-card-step-label--current' : '',
                ].filter(Boolean).join(' ')}
              >
                {chainNodeLabel(nodeId)}
              </span>
            </span>
          );
        })}
      </div>
      {/* 09-12 子2（design §8⑤）：链内模型切换行——writer 循环/核实子循环回退时
          （model-fallback 事件带 nodeId）呈现「{节点}：{from} 失败 → 已切换 {to}」；
          未发生回退不渲染（主指派模型在跑，配置面已可见）。 */}
      {run.modelSwitch ? (
        <div className="chain-run-card-model-switch" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
          <span>
            {t('agent.chainModelSwitch', {
              node: run.modelSwitch.nodeLabel,
              from: modelDisplayName(modelConfigForCard, run.modelSwitch.from),
              to: modelDisplayName(modelConfigForCard, run.modelSwitch.to),
            })}
          </span>
        </div>
      ) : null}
      {!compact && (
        <div className="chain-run-card-body">
          {/* dogfood T1 CR-T1-050：正文区只在「流仍在途」或「中断/失败保留态」显已流出的文本
              （streaming 由 node-done 收口——此前 draft-writer done 后整个 JSON 节点尾期正文区
              恒流式假活 + caret 残留，且 bodyHtml 非空自洽令「节点名 + 三点」占位永不可见，
              SEAM-2 弱变体）。running 非流式 = JSON 节点期 → 占位（design §7.5「JSON 节点期间
              正文区显示节点名 + 三点 loading，不流 JSON」）。 */}
          {bodyHtml && (run.streaming || interrupted || failed) ? (
            <div
              className={`agent-msg-md${run.streaming ? ' agent-msg-md--streaming' : ''}`}
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          ) : (
            // JSON 节点期间：正文区显示当前节点名 + 三点 loading（不流 JSON——design §7.5）。
            // R2.3 #105 缝③：终态（aborted/error）改「已中断于/失败于 {node}」——不再残留
            //「正在进行」假活文案。
            <div className="chain-run-card-placeholder">
              <span className="chain-run-card-placeholder-label">{placeholderText}</span>
              {run.status === 'running' && (
                <span className="chain-run-card-running" aria-hidden="true">
                  <span className="agent-loading-dot" />
                  <span className="agent-loading-dot" />
                  <span className="agent-loading-dot" />
                </span>
              )}
            </div>
          )}
          {streamLabel && bodyHtml && run.streaming && (
            <div className="chain-run-card-stream-meta">{t('agent.chainStreaming', { node: streamLabel })}</div>
          )}
          {(interrupted || failed) && onRetry && (
            <div className="chain-run-card-actions">
              <button type="button" className="agent-message-error-retry" onClick={onRetry}>
                {t('agent.retry')}
              </button>
            </div>
          )}
        </div>
      )}
      {/* dogfood T1 CR-T1-048：paused 精简态的动作行——resume 入口（compact 让位的是正文区非
          动作面；leader 路径 pausedReview 在时 caller 不传 onResume）。 */}
      {compact && onResume && (
        <div className="chain-run-card-actions">
          <button type="button" className="agent-message-error-retry" onClick={onResume}>
            {t('agent.chainResume')}
          </button>
        </div>
      )}
    </div>
  );
}
