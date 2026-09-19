import { z } from 'zod';
import { defineTool } from './define';
import { logger } from '../logger';

// ── Story 3.6 WP8（R4 / design D12）：researcher 深研究派发 leader tool ──
//
// leader 深研究（多源 / 多跳 / 需综合）经此派发 researcher 子 agent：隔离上下文里自主调研究
// 工具查证 → 蒸馏报告（简要理解开头 + 来源分层 + 交叉验证 + canon 冲突列候选）回传 leader，
// 不灌 leader 对话史（context isolation，ADR-17）。快查（单点事实：某词条/某页面）leader 直调
// wiki_*/web_* 工具，不经此 tool（判据在 DEFAULT_CLOSURE_PROMPT Research 段）。
//
// 🔑 挂载路线 = b（design D12 fallback，mirror 3.4 diagnose_impacts）：shell 侧
// `createWorkflowRuntime()` 空参调用（agentIpc.ts:69）无 externalSkillRoots，且
// `loadAgentDefinition` 的搜索根只有项目级 `.orison/agents/` / `.claude/agents/`——
// 无 app 级 agents root 可挂 researcher.md。故 researcher 契约落 `prompts/researcher-agent.yaml`
// （ADR-4 单契约源 system + userTemplate），经 `ctx.skillExecutor.runAgentWithExplicitSystem`
// 派发（mirror ripple-diagnosis-agent / retrieval-agent / adjudicator-agent 先例）。
//
// 🔑 工具面白名单（硬约束，spec agent-tools.md / orchestration-pattern.md §leader 侧工具子
// agent「caller 必传 allowedTools」）：researcher 只拿只读研究 + 项目查询工具，无写工具、
// 无派发工具（叶子执行者）。runChildAgentWithExplicitSystem 在调用处过滤 registry.all()。
//
// 🔑 不进 CONTRACTS[]（leader 侧子 agent + tool，mirror write_chapter / diagnose_impacts /
// retrieval）。spawn depth：leader→researcher（depth+1）兄弟于 leader→chain。
//
// graceful（mirror diagnose_impacts）：skillExecutor 缺（旧 runtime / mock）/ dispatch 抛错 /
// 空报告 → 友善降级（告知 leader 可改直调研究工具），绝不假报告。
//
// expected_downstream_consumers:
// - DEFAULT_CLOSURE_PROMPT Research 段（WP8.2）：直查 vs 派发判据 + 五段 brief 模板。
// - 多轮派发常态（leader 持线 child 无状态，R4）——每轮独立 brief，无 mid-run 双向（不建通道）。

/**
 * researcher 子 agent 可见工具白名单（design D12）。只读研究 + 项目查询；写工具 / 派发工具
 * 一律不在列。导出供注册对齐测试断言（agent 侧 registry ⊇ 白名单）。
 */
export const RESEARCHER_ALLOWED_TOOLS: readonly string[] = [
  'wiki_search',
  'wiki_read',
  'web_search',
  'web_fetch',
  'render_page',
  'parse_document',
  'analyze_image',
  'query_story',
  'query_craft',
  'project_meta',
];

/** researcher 契约文件（prompts/ 下，ADR-4 单契约源；runAgentWithExplicitSystem 按此名加载）。 */
export const RESEARCHER_ROLE = 'researcher-agent';

// ── 五段 brief 渲染（纯代码机械拼接，design D12 派发契约）──

export interface ResearchBriefInput {
  /** 研究问题（要澄清什么）——五段中唯一必填段。 */
  researchQuestion: string;
  /** 创作背景（服务什么决定）。 */
  creativeContext?: string;
  /** 已知与假设。 */
  knownAndHypotheses?: string;
  /** 约束（原则、采信偏好）。 */
  constraints?: string;
  /** 期望产出。 */
  expectedOutput?: string;
}

/**
 * 渲染五段 brief 为 researcher user 段 var。可选段缺省时跳过（不产空段标题）——
 * leader 只需填它真有的信息，schema 不强迫凑段。
 */
export function renderResearchBrief(input: ResearchBriefInput): string {
  const lines: string[] = [`研究问题（要澄清什么）：${input.researchQuestion.trim()}`];
  if (input.creativeContext?.trim()) lines.push(`创作背景（服务什么决定）：${input.creativeContext.trim()}`);
  if (input.knownAndHypotheses?.trim()) lines.push(`已知与假设：${input.knownAndHypotheses.trim()}`);
  if (input.constraints?.trim()) lines.push(`约束（原则、采信偏好）：${input.constraints.trim()}`);
  if (input.expectedOutput?.trim()) lines.push(`期望产出：${input.expectedOutput.trim()}`);
  return lines.join('\n');
}

// ── dispatch_researcher tool（defineTool，mirror diagnoseImpactsTool）──

const dispatchResearcherParams = z.object({
  researchQuestion: z.string().min(1).describe('研究问题（要澄清什么）——一段话说清'),
  creativeContext: z.string().optional().describe('创作背景（这次研究服务什么创作决定，如「主角金手指选型」「OOC 判定基准」）'),
  knownAndHypotheses: z.string().optional().describe('已知与假设（项目已有设定/你已知道的前提，避免 researcher 重查）'),
  constraints: z.string().optional().describe('约束（原则、采信偏好，如「只认官方设定集」「二创设定仅参考」）'),
  expectedOutput: z.string().optional().describe('期望产出（报告侧重什么，如「能力对照表」「时间线梳理」）'),
});

export const dispatchResearcherTool = defineTool({
  id: 'dispatch_researcher',
  description:
    '派发研究员（researcher 子 agent）做深研究：多源交叉查证外部世界（原作设定/wiki/web/文档/图片），'
    + '返回带出处的蒸馏报告（开头含「简要理解」供判偏、结论带置信度、canon 多版本冲突列候选留给作者采信）。'
    + '适用：多源/多步/需要综合的研究（如「阿米娅的能力设定在不同版本有什么差异」）。'
    + '单点快查（查某词条/抓某页面）请直接调 wiki_search/web_fetch 等工具，不必派发。'
    + 'brief 有歧义时 researcher 会返回「需要澄清」——转告用户补足后再派。'
    + '研究报告有留存价值时，主动建议用户策展（save_craft_doc 写作技法 / asset_cards_update 设定卡）。',
  parameters: dispatchResearcherParams,
  async execute(params, ctx) {
    if (!ctx.skillExecutor?.runAgentWithExplicitSystem) {
      logger.warn(
        { sessionId: ctx.sessionId },
        'dispatch_researcher: runAgentWithExplicitSystem unavailable → graceful degrade',
      );
      return {
        title: 'dispatch_researcher',
        output: '研究员派发通道不可用（当前 runtime 未注入子 agent 执行器）。可改直接调研究工具（wiki_search / web_search / web_fetch 等）完成这次查询。',
      };
    }

    const brief = renderResearchBrief(params);
    try {
      const result = await ctx.skillExecutor.runAgentWithExplicitSystem(
        ctx.sessionId,
        RESEARCHER_ROLE,
        { brief },
        {
          ...(ctx.abort ? { abort: ctx.abort } : {}),
          ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
          ...(ctx.emitChildEvent ? { emitChildEvent: ctx.emitChildEvent } : {}), // R2 #3 二段：child 事件透传
          allowedTools: [...RESEARCHER_ALLOWED_TOOLS],
        },
      );
      if (!result.content || !result.content.trim()) {
        return {
          title: 'dispatch_researcher',
          output: '研究员返回了空报告（可能被中断或超时）。请重试，或改直接调研究工具完成这次查询。',
          metadata: { ok: false, reason: 'empty-report' },
        };
      }
      return {
        title: 'dispatch_researcher',
        output: result.content,
        metadata: { ok: true, researchQuestion: params.researchQuestion },
      };
    } catch (err) {
      logger.warn(
        { sessionId: ctx.sessionId, err: err instanceof Error ? err.message : String(err) },
        'dispatch_researcher: dispatch failed → graceful degrade',
      );
      return {
        title: 'dispatch_researcher',
        output: `研究员派发失败（${err instanceof Error ? err.message : String(err)}）。请重试，或改直接调研究工具（wiki_search / web_search / web_fetch 等）完成这次查询。`,
        metadata: { ok: false, reason: 'dispatch-failed' },
      };
    }
  },
});
