import { z } from 'zod';
import { defineTool } from './define';

/**
 * Story 3.3 线 D：leader 收尾工具——plan/discuss 模式下 leader 停下来向用户呈现结果前**必须**调，
 * 声明「这次停是否在等用户确认意图」。loop.ts（runLoop）在 break 分支（leader 无 toolCalls 停下）校验：
 * plan/discuss 模式下若没调过本工具 → 打回重跑（inject 提醒 + continue，限 1 次防无限）。
 *
 * 设计原理（用户 2026-08-13 定）：
 * - **判断只在 leader 停下来时做**（runLoop break 分支），中途思考/调工具不判断 → 不误伤多步对话。
 * - **用工具标记，不污染文本**：awaiting_intent_confirmation 经 toolResult.metadata 透出，loop 检测。
 * - **停下来却没声明 = 格式错 → 打回**：LLM 漏标/没按格式 → retry，不放过去。
 *
 * 范式判据：本工具无副作用纯标记（execute 只返 ack + metadata），不碰 fs/db/语义——把 leader 的
 * 「这次停是不是 restate」语义判断显式编码进工具调用（LLM 决定），loop 机械校验「调没调」。
 *
 * normal/auto 模式**不强制**（非 restate 软门场景，避免每轮都烦）——loop 仅 plan/discuss 校验。
 *
 * dogfood R2 #16（2026-08-26）：intent_restate 盖章与 UI 确认按钮删除——本工具的收尾契约职能
 * （loop 校验 + 终局语义）保留，awaiting 参数继续声明「这次停的性质」（作者以自然语言回应，
 * 不再有快捷按钮）。
 */
export const presentResultTool = defineTool({
  id: 'present_result',
  description:
    'Closure 工作台收尾声明（plan/discuss 模式必用）。每次你向用户呈现结果、停下来等回应前，必须调用此工具声明这次停下的性质。' +
    // 「呈现性回复文字」限定（09-20 R12 残留措辞统一，F16 同族）：旧承重词「正文」可被模型
    // 后向推导出「章节正文写在对话里」的授权（与写章工具的分工拆台）。措辞家族四处同步：
    // agents.ts 桥 agent body / bridgeExecutor.ts present_result 覆写 / 本描述（HTTP 车道
    // 工具面——桥车道有覆写不读此处）/ workflow.ts interaction 能力段（两车道 system 基座）。
    '**呈现给用户看的呈现性回复文字（讨论/说明/评审等，不含章节正文/改稿产物）必须写在调用本工具的同一条消息里**——本工具是终局调用，调用后本次运行立即结束，没有机会再补一条消息。' +
    'awaiting_intent_confirmation=true 表示你在复述理解/方案等用户回应；' +
    'false 表示你已完成本轮（如回答了问题、执行了任务），正常停下不等确认。',
  parameters: z.object({
    awaiting_intent_confirmation: z.boolean().describe(
      'true=你在等用户确认意图（复述了理解/方案，等用户回应）；false=本轮已完成，正常停下。',
    ),
    summary: z.string().optional().describe('可选：一句话总结这次呈现的内容（便于用户快速理解你停下时说了什么）。'),
  }),
  async execute(params) {
    return {
      title: 'present_result',
      output: params.summary
        ? `已呈现（${params.awaiting_intent_confirmation ? '等用户确认意图' : '本轮完成'}）：${params.summary}`
        : `已呈现（${params.awaiting_intent_confirmation ? '等用户确认意图' : '本轮完成'}）。`,
      // dogfood R2 #8（2026-08-25）：收尾声明即终局——terminal 让 runLoop 在本工具结果落盘后
      // 直接结束本次运行。此前未标记：工具结果后 loop 再跑一轮模型，复读出一条多余的
      // 「等你选…」消息（用户实测两次呈现各多一行，先前的修复只处理了呈现双卡未触及此根因）。
      terminal: true,
      // metadata 经 loop.ts 循环检测——awaitingIntentConfirmation 透出供打回门（calledPresentResult）
      // 与工具结果文案区分停的性质。
      metadata: {
        presentResult: {
          awaitingIntentConfirmation: params.awaiting_intent_confirmation,
        },
      },
    };
  },
});
