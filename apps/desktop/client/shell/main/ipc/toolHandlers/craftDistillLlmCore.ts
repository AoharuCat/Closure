/**
 * E10.2b（task 09-05）Wave 3：蒸馏管线 LLM 缝的生产装配真身。
 *
 * `installCraftDistillLlmCore` 的 seam 在 craftDistillPipeline.ts（mirror materialIngest 的
 * installMaterialLLMCore setter 防环先例——该模块位于 craftIpc/repository 链上不可静态引入
 * configIpc/modelGatewayIpc〔configIpc→db indexers→modelGatewayIpc 既有环〕）。本模块是装配侧：
 * 只被 main/index.ts whenReady 静态引入（进程根，不进环），把 seam 接到生产解析链。
 *
 * 解析链（materialLLMCore 同型 + lintIpc.ts:459 classify 先例）：
 * - 档位随缝参数 `slot` 路由（C3.2 六档成员）：
 *   - `extraction`「提取·汇编」：切条（完整主张判定=结构提取）+ 归类（受控词表内选=判别）——
 *     温度 0（判别非创作）。
 *   - `review-judge`「评审裁判」：冲突判定（语义相反）——温度 0.2（语义裁判面，mirror lintIpc
 *     classify 同档同温）。
 * - `resolveTaskModel(slot)` 每调用现解析（档位/配置即时生效——安装期不缓存）→ 缺档/未注入
 *   resolver → undefined → `{keyId:'default', modelId:'default'}` 哨兵 → `resolveModel` 自动
 *   选择 → model-protocols `generateText` 单次调用。思考策略随档（assignmentThinkingControl）。
 * - **maxTokens 由调用方按缝的输出量独立传入**（E10.2a CR-2 配套纪律——切条大 JSON 16384 /
 *   归类与冲突判定小 JSON；缺省 belt 8192，正常路径不触达）。
 * - **finishReason 透传**（CR-2）：provider 停因是截断判定的权威信号——'length' → 调用方
 *   材料级挂起；缺省（端点未回报）= undefined 透传。
 *
 * never-throws 由调用方兜（craftDistillPipeline 的 fail 面）；resolveModel 抛（未配置模型）
 * 沿契约上抛同路。
 *
 * wiring 测试 craftDistillLlmWiring.test.ts 钉死：档位 key、default 哨兵链、温度随档、
 * finishReason 透传。
 */
import { assignmentThinkingControl, resolveTaskModel } from '@orison/desktop-agent';
import type { ThinkingControl } from '@orison/shared-contracts';
import { generateText } from '@orison/model-protocols';
import { readModelConfigFromDisk } from '../configIpc';
import { resolveModel } from '../modelGatewayIpc';
import {
  installCraftDistillLlmCore,
  type CraftDistillGenerateSlot,
  type CraftDistillGenerateText,
} from './craftDistillPipeline';

/** 缺省 belt（正常路径调用方必传 maxTokens——切条 16384 / 归类与冲突 1024，见 pipeline 常量）。 */
export const CRAFT_DISTILL_DEFAULT_MAX_TOKENS = 8192;

/** 温度随档：判别面（切条/归类）0；语义裁判面（冲突判定）0.2（mirror lintIpc classify）。 */
const TEMPERATURE_BY_SLOT: Record<CraftDistillGenerateSlot, number> = {
  extraction: 0,
  'review-judge': 0.2,
};

/** 生产 generateText 包装：每调用现解析（档位/配置即时生效）。 */
const generateCraftDistill: CraftDistillGenerateText = async (input) => {
  const assignment = resolveTaskModel(input.slot);
  const ref = assignment
    ? { keyId: assignment.keyId, modelId: assignment.modelId }
    : { keyId: 'default', modelId: 'default' };
  const resolved = resolveModel(ref, readModelConfigFromDisk());
  const thinking: ThinkingControl | undefined = assignmentThinkingControl(assignment);
  const response = await generateText(resolved, {
    model: resolved.modelId,
    messages: [
      ...(input.system ? [{ role: 'system' as const, content: input.system }] : []),
      { role: 'user' as const, content: input.user },
    ],
    temperature: TEMPERATURE_BY_SLOT[input.slot],
    maxTokens: input.maxTokens ?? CRAFT_DISTILL_DEFAULT_MAX_TOKENS,
    ...(thinking ? { thinking } : {}),
  });
  // CR-2：透传 provider 停因（TextGenerationResponse.finishReason——GenerationFinishReason，
  // OpenAI/Anthropic 双协议路径均产出；undefined = 端点未回报）。切条截断判定的权威信号。
  return { text: response.text ?? '', finishReason: response.finishReason };
};

/**
 * 生产装配点（main/index.ts whenReady 调用，registerAllIpc 之前装好）。幂等（重复 install
 * 同一闭包，无害）。未装配时蒸馏一律 'llm-unavailable' 材料级挂起（诚实失败非静默）。
 */
export function installCraftDistillLlmCoreProduction(): void {
  installCraftDistillLlmCore({ generateText: generateCraftDistill });
}
