/**
 * Story 10.1 Wave C（Wave B 移交项）：材料分章 LLM 兜底的生产装配真身。
 *
 * `installMaterialLLMCore` 的 seam 在 materialIngest.ts（Wave B，setter 防环先例——该模块
 * 位于 watcher/IPC 链上不可静态引入 configIpc/modelGatewayIpc）。本模块是装配侧：只被
 * main/index.ts whenReady 静态引入（进程根，不进 configIpc→db indexers→modelGatewayIpc
 * 既有环），把 seam 接到生产解析链。
 *
 * 解析链（materialIngest.ts JSDoc 指定 + lintIpc.ts:459 classify 同型）：
 * `resolveTaskModel('extraction')`（C3.2 六档——grep 核实：writer-selfcheck / writer-draft
 * / review-judge / **extraction** / dispatch / dialogue；「提取·汇编」档与分章候选行判别
 * 〔结构提取任务〕语义对齐，workflow.ts:1669 实证该档已有消费者）→ 缺档/未注入 resolver →
 * undefined → `{keyId:'default', modelId:'default'}` 哨兵 → `resolveModel` 自动选择（首个
 * 启用模型）→ model-protocols `generateText` 单次调用。思考策略随档
 * （assignmentThinkingControl，mirror lintIpc S4c 同链同源；未配 → undefined = auto）。
 *
 * never-throws 由调用方兜（MaterialGenerateText 契约——失败 → 分章挂起，runLlmChapterFallback
 * 的 catch 面）；resolveModel 抛（未配置模型）沿契约上抛同路。
 *
 * wiring 测试 materialLLMWiring.test.ts 钉死：档位 key、default 哨兵链、装配后 ingest
 * 低置信材料真走 generateText。
 */
import { assignmentThinkingControl, resolveTaskModel } from '@orison/desktop-agent';
import type { ThinkingControl } from '@orison/shared-contracts';
import { generateText } from '@orison/model-protocols';
import { readModelConfigFromDisk } from '../configIpc';
import { resolveModel } from '../modelGatewayIpc';
import { installMaterialLLMCore, type MaterialGenerateText } from './materialIngest';

/** 兜底输出是 `{"selected":[行号...]}` 小 JSON——4096 上限宽裕（防畸形端点无限吐）。 */
export const MATERIAL_FALLBACK_MAX_TOKENS = 4096;

/** 生产 generateText 包装：每调用现解析（档位/配置即时生效——安装期不缓存模型）。 */
const generateChapterFallback: MaterialGenerateText = async (input) => {
  const assignment = resolveTaskModel('extraction');
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
    // 结构提取任务：温度 0（候选行选择是判别不是创作）；lintIpc classify 用 0.2 是语义
    // 裁判面，此处更窄一档。
    temperature: 0,
    // 调用方指定预算优先（E10.2a 整理档 POLISH_MAX_TOKENS=8000——生成式保义改写不能吃
    // 4096 小 JSON 预算，否则长段静默截断〔复审 F-02〕）；未指定 = 分章兜底小 JSON 默认。
    maxTokens: input.maxTokens ?? MATERIAL_FALLBACK_MAX_TOKENS,
    ...(thinking ? { thinking } : {}),
  });
  // CR-2：透传 provider 停因（model-protocols TextGenerationResponse.finishReason——
  // GenerationFinishReason，OpenAI/Anthropic 双协议路径均产出；undefined = 端点未回报）。
  // 整理档截断判定的权威信号：'length' → 降级，非 'length' → 通过，缺省 → 回退比值法。
  return { text: response.text ?? '', finishReason: response.finishReason };
};

/**
 * 生产装配点（main/index.ts whenReady 调用，registerAllIpc 之前装好——启动扫描的全局
 * 材料 watcher 事件链上即可用）。幂等（重复 install 同一闭包，无害）。
 */
export function installMaterialLLMCoreProduction(): void {
  installMaterialLLMCore({ generateText: generateChapterFallback });
}
