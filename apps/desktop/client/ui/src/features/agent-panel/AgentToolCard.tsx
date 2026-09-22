import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { Collapsible } from '../../shared/components/Collapsible';
import { toolPresentation, toolLabel, toolSummary, isToolErrorOutput } from './toolMeta';

type Props = {
  result: { toolId?: string; toolName?: string; output?: string; metadata?: unknown };
  /**
   * 子4 W6（design §8）：「桥」徽标——本次工具调用经 MCP 工具桥（agy 侧循环）执行的
   * 会话级标注（caller 用 useAgyBridgeLaneActive 派生 + childTag 排除传入）。缺省
   * undefined = 普通车道零变化。
   */
  bridge?: boolean;
};

export function AgentToolCard({ result, bridge }: Props) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const imagePaths: string[] =
    result.metadata && typeof result.metadata === 'object' && 'paths' in result.metadata
      ? (result.metadata as { paths: string[] }).paths
      : [];

  // A failed tool surfaces its error as a result whose output starts with
  // "Error:" (lane-shared convention — see isToolErrorOutput). Reflect that
  // instead of always showing a green check, so a failure isn't mistaken for
  // success.
  const isError = isToolErrorOutput(result.output);

  const toolId = result.toolName ?? result.toolId ?? '';
  const { icon } = toolPresentation(toolId);
  const label = toolLabel(toolId, t);
  const summary = toolSummary(result);

  // Story 3.5 Step 7: the hand-rolled expand/collapse idiom moved into the
  // shared <Collapsible> — same DOM (the Collapsible IS the card wrapper),
  // same default-collapsed state.
  return (
    <Collapsible
      className={`agent-tool-card${isError ? ' agent-tool-card--error' : ''}`}
      headerClassName="agent-tool-card-header"
      bodyClassName="agent-tool-card-body"
      chevron="end"
      chevronIcons={{ open: 'expand_less', closed: 'expand_more' }}
      chevronClassName="agent-tool-card-chevron"
      header={
        <>
          <span className="material-symbols-outlined agent-tool-card-icon" aria-hidden="true">{icon}</span>
          <span className="agent-tool-card-name">{label}</span>
          {bridge && (
            <span className="agent-tool-card-bridge-badge" title={t('agent.bridgeToolBadgeTitle')}>
              {t('agent.bridgeToolBadge')}
            </span>
          )}
          {summary && <span className="agent-tool-card-summary" title={summary}>{summary}</span>}
          <span className={`agent-tool-card-status${isError ? ' agent-tool-card-status--error' : ''}`}>
            {isError ? '⚠' : '✓'}
          </span>
        </>
      }
    >
      {imagePaths.map((p) => (
        <img key={p} src={`orison-file:///${p}`} className="agent-tool-card-image" alt="" />
      ))}
      {result.output && <pre className="agent-tool-card-output">{result.output}</pre>}
    </Collapsible>
  );
}
