import { z } from 'zod';
import { defineTool } from './define';
import { getBgTaskRegistry, type BgTaskRecord } from '../runtime/bgTasks';

// ── 09-21-subagent-bg-decouple W1（design §1.2 / R4）：后台任务配套三工具 ──
//
// bg_tasks_status / bg_task_result / bg_task_cancel —— leader 查询 / 领取 / 取消自己名下的后台子
// agent 任务。直接读模块级 BgTaskRegistry（mirror batch_status 直读 batch-state 的先例，不经
// skillExecutor）。作用域按派发方（ctx.sessionId = parentSessionId）收窄：看不到也动不了别的
// leader 会话的后台任务。
//
// 说人话三件事（agent-tools.md 纪律）：做了什么 / 等用户做什么 / 下一步。claim 语义 = bg_task_result
// 调用（纯代码记账，W2 摘要段据此去重——不猜 LLM 是否「看过」）。

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

const STATUS_LABELS: Record<BgTaskRecord['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已取消',
  interrupted: '已中断（应用重启）',
};

function describeRecord(record: BgTaskRecord, now: number): string {
  const parts = [
    `- [${STATUS_LABELS[record.status]}] ${record.role}（taskId: ${record.taskId}）`,
    `  任务: ${record.promptDigest}${record.promptDigest.length >= 120 ? '…' : ''}`,
  ];
  if (record.status === 'running') {
    parts.push(`  已运行 ${formatDuration(now - record.startedAt)}`);
  } else {
    parts.push(`  用时 ${formatDuration(record.updatedAt - record.startedAt)}`);
  }
  if (record.status === 'failed' && record.error) {
    parts.push(`  失败原因: ${record.error}`);
  }
  if (record.status === 'completed' && record.claimed) {
    parts.push('  （结果已领取）');
  }
  return parts.join('\n');
}

// ── bg_tasks_status：枚举本会话名下的后台任务 ──

export const bgTasksStatusTool = defineTool({
  id: 'bg_tasks_status',
  description:
    '查看你派发的后台任务列表（运行中/已完成/失败/已取消），每个任务带 taskId、角色、耗时和任务摘要。想在结果送达前主动查进度、或派发被上限拦住想看看在跑哪些任务时，用它。',
  parameters: z.object({}),
  async execute(_params, ctx) {
    const records = getBgTaskRegistry().listByParent(ctx.sessionId);
    if (records.length === 0) {
      return {
        title: 'bg_tasks_status',
        output: '当前没有后台任务。需要长活并行时用 spawn_agent_bg 派发（立即返回，不阻塞对话）。',
      };
    }
    const now = Date.now();
    const lines = [
      `共 ${records.length} 个后台任务（运行中 ${records.filter((r) => r.status === 'running').length} 个）：`,
      ...records.map((record) => describeRecord(record, now)),
    ];
    const claimable = records.filter((r) => r.status === 'completed' && !r.claimed);
    if (claimable.length > 0) {
      lines.push(`有 ${claimable.length} 个已完成任务待领取结果——调 bg_task_result 传对应 taskId。`);
    }
    return {
      title: 'bg_tasks_status',
      output: lines.join('\n'),
      metadata: {
        tasks: records.map((r) => ({
          taskId: r.taskId,
          childSessionId: r.childSessionId,
          role: r.role,
          status: r.status,
          startedAt: r.startedAt,
          notify: r.notify,
          claimed: r.claimed ?? false,
        })),
      },
    };
  },
});

// ── bg_task_result：领取完整结果（completed → content + markClaimed）──

export const bgTaskResultTool = defineTool({
  id: 'bg_task_result',
  description:
    '领取一个已完成后台任务的完整结果（传 taskId）。任务还在跑会告诉你仍在运行；失败/已取消的任务会说明状态与原因。领取过的结果可以重复查看。',
  parameters: z.object({
    taskId: z.string().min(1).describe('后台任务 id（来自 spawn_agent_bg 的返回或 bg_tasks_status 列表）'),
  }),
  async execute(params, ctx) {
    const registry = getBgTaskRegistry();
    const record = registry.get(params.taskId);
    // 他会话名下的任务按「找不到」处理（作用域收窄——不泄露也不误动别的 leader 的任务）。
    if (!record || record.parentSessionId !== ctx.sessionId) {
      return {
        title: 'bg_task_result',
        output: '找不到这个后台任务。用 bg_tasks_status 查看你名下任务的 taskId 后重试。',
        metadata: { ok: false, reason: 'not-found' },
      };
    }
    if (record.status === 'running') {
      return {
        title: 'bg_task_result',
        output: `后台任务（${record.role}）仍在运行，已运行 ${formatDuration(Date.now() - record.startedAt)}。等它完成后再来领取；期间你可以继续其他工作。`,
        metadata: { ok: false, reason: 'running', taskId: record.taskId },
      };
    }
    if (record.status === 'failed') {
      return {
        title: 'bg_task_result',
        output: `后台任务（${record.role}）失败了：${record.error ?? '未知原因'}。可重派（spawn_agent_bg）或改同步 spawn_agent。`,
        metadata: { ok: false, reason: 'failed', taskId: record.taskId },
      };
    }
    if (record.status === 'aborted') {
      return {
        title: 'bg_task_result',
        output: `后台任务（${record.role}）已被取消，没有结果。需要的话重新派发。`,
        metadata: { ok: false, reason: 'aborted', taskId: record.taskId },
      };
    }
    if (record.status === 'interrupted') {
      return {
        title: 'bg_task_result',
        output: `后台任务（${record.role}）因应用重启中断，没有产出结果（后台任务不跨重启续跑）。需要的话重新派发。`,
        metadata: { ok: false, reason: 'interrupted', taskId: record.taskId },
      };
    }
    const claim = registry.markClaimed(record.taskId);
    const already = claim.ok && claim.alreadyClaimed;
    const content = record.result?.content ?? '';
    return {
      title: 'bg_task_result',
      output: [
        already ? `后台任务（${record.role}）的结果（此前已领取过，再次给出）：` : `后台任务（${record.role}）已完成，完整结果如下：`,
        '',
        content || '（子代理没有返回内容。）',
      ].join('\n'),
      metadata: {
        taskId: record.taskId,
        childSessionId: record.childSessionId,
        role: record.role,
        status: record.status,
        claimed: true,
      },
    };
  },
});

// ── bg_task_cancel：取消一个在跑的后台任务 ──

export const bgTaskCancelTool = defineTool({
  id: 'bg_task_cancel',
  description:
    '取消一个还在运行的后台任务（传 taskId）。已完成/已取消的任务不能重复取消，会如实告诉你当前状态。用户说「不用查了」「把那个后台任务停掉」时用它。',
  parameters: z.object({
    taskId: z.string().min(1).describe('要取消的后台任务 id（来自 spawn_agent_bg 的返回或 bg_tasks_status 列表）'),
  }),
  async execute(params, ctx) {
    const registry = getBgTaskRegistry();
    const record = registry.get(params.taskId);
    if (!record || record.parentSessionId !== ctx.sessionId) {
      return {
        title: 'bg_task_cancel',
        output: '找不到这个后台任务。用 bg_tasks_status 查看你名下任务的 taskId 后重试。',
        metadata: { ok: false, reason: 'not-found' },
      };
    }
    const result = registry.cancel(record.taskId);
    if (!result.ok) {
      return {
        title: 'bg_task_cancel',
        output: `后台任务（${record.role}）当前状态是「${STATUS_LABELS[record.status]}」，无需取消。`,
        metadata: { ok: false, reason: result.reason, taskId: record.taskId, status: record.status },
      };
    }
    return {
      title: 'bg_task_cancel',
      output: `已发出取消指令，后台任务（${record.role}）正在停止。它已跑出的部分进度会保留在它的会话里，但不会有最终结果。`,
      metadata: { ok: true, taskId: record.taskId, role: record.role },
    };
  },
});
