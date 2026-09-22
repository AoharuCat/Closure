import { z } from 'zod';
import { defineTool } from './define';
import { logger } from '../logger';
import { BgCapacityError, MAX_BG_PER_PROJECT } from '../runtime/bgTasks';

// ── 09-21-subagent-bg-decouple W1（design §1.2 / R1 / D1）：后台子 agent 派发工具 ──
//
// spawn_agent 的后台孪生：派发后**立即返句柄**（不等子 agent 跑完），leader turn 正常收尾、用户可
// 继续对话——长活（深研究/拆书分析/弧审读）不再阻塞对话。同步 spawn_agent 字节级零改动（D1：新工具
// 而非加参——prompt 契约稳定 + LLM 选择显式化）。
//
// 运行参数 mirror 同步版：agentType（role → .md 契约 systemPrompt + allowedTools frontmatter 收窄）+
// prompt；另加 notify（结果送达三通道 toast/wake/silent，缺省 toast——R3；消费面在 W2）。
//
// 说人话三件事（agent-tools.md 纪律）：做了什么（已启动、立即返回）/ 等用户做什么（无需等待）/
// 下一步（怎么查、怎么领结果、怎么取消）。

export const spawnAgentBgTool = defineTool({
  id: 'spawn_agent_bg',
  description:
    'Spawn a focused subagent that runs IN THE BACKGROUND: it returns a task handle immediately (does not wait for the subagent to finish), you can keep talking to the user or do other work while it runs. Use for long-running tasks (deep research, book analysis, long review passes) where blocking the conversation is not worth it. Use the regular spawn_agent when you need the result right now in this turn. The user is notified when it finishes (unless the user asked for quiet mode); you can check progress with bg_tasks_status, claim the result with bg_task_result, or stop it with bg_task_cancel.',
  parameters: z.object({
    agentType: z.string().describe('Role / type of the subagent (e.g. "story-architect", "narrative-writer", "consistency-checker") — same roles as spawn_agent'),
    prompt: z.string().describe('Task description and all relevant context for the subagent — it does not share your conversation history, so include everything it needs'),
    notify: z.enum(['toast', 'wake', 'silent']).optional().describe(
      'How to deliver the result when it finishes: "toast" (default — user gets a notification, and you get a summary of unclaimed results in your next turn), "wake" (you are woken up to report the result as soon as you are idle), "silent" (only record it — check bg_tasks_status when you want it). Only set this when the user asked for a specific behavior.',
    ),
  }),
  async execute(params, ctx) {
    if (!ctx.skillExecutor?.runSubagentBackground) {
      return {
        title: `spawn_agent_bg: ${params.agentType}`,
        output: '后台子代理派发通道不可用（当前运行环境未注入后台执行器）。可改用同步的 spawn_agent（会等它跑完再继续）。',
      };
    }
    try {
      const handle = ctx.skillExecutor.runSubagentBackground(ctx.sessionId, params.agentType, params.prompt, {
        ...(ctx.spawnDepth !== undefined ? { spawnDepth: ctx.spawnDepth } : {}),
        ...(params.notify ? { notify: params.notify } : {}),
      });
      // 送达措辞按通道如实分述（CR-18）：wake 通道的汇报对象是 leader（你）而非用户——旧文案
      // 「用户会收到通知」对 wake 不准确。
      const deliveryNote =
        params.notify === 'wake'
          ? '任务完成后会自动唤醒你（leader）汇报结果。'
          : params.notify === 'silent'
            ? '本任务选了静默：完成时不通知，你需要时用 bg_task_result / bg_tasks_status 查。'
            : '任务完成时用户会收到通知，未领取的结果也会在你下一轮的提示段里列出。';
      return {
        title: `spawn_agent_bg: ${params.agentType}`,
        output: [
          `后台任务已启动（不等它跑完，你现在可以继续对话或做其他事）：`,
          `- taskId: ${handle.taskId}`,
          `- 子代理: ${handle.role}`,
          `- 状态: ${handle.status}`,
          deliveryNote,
          `领取结果用 bg_task_result 传 taskId；中途想停它用 bg_task_cancel；查进度用 bg_tasks_status。`,
          `向用户提一句「已在后台启动 ${handle.role}」即可，无需等待。`,
        ].join('\n'),
        metadata: {
          taskId: handle.taskId,
          childSessionId: handle.childSessionId,
          role: handle.role,
          status: handle.status,
          notify: params.notify ?? 'toast',
        },
      };
    } catch (err) {
      if (err instanceof BgCapacityError) {
        return {
          title: `spawn_agent_bg: ${params.agentType}`,
          output: `派发失败：本项目已有 ${MAX_BG_PER_PROJECT} 个后台任务在跑，达到上限。等其中一个完成，或先用 bg_tasks_status 查看在跑任务、bg_task_cancel 取消不再需要的，然后再重试。`,
          metadata: { ok: false, reason: 'bg-capacity', limit: MAX_BG_PER_PROJECT },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { sessionId: ctx.sessionId, err: message },
        'spawn_agent_bg: dispatch failed → graceful degrade',
      );
      return {
        title: `spawn_agent_bg: ${params.agentType}`,
        output: `后台派发失败（${message}）。可改用同步的 spawn_agent，或稍后重试。`,
        metadata: { ok: false, reason: 'dispatch-failed' },
      };
    }
  },
});
