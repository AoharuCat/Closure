import { assignmentFallbackChain, assignmentThinkingControl, resolveTaskModel } from '@orison/desktop-agent';
import type { GenerationFinishReason, ThinkingControl } from '@orison/shared-contracts';
import { handleGenerateText } from '../ipc/modelGatewayIpc';

// ── E10.3a（task 09-05）W2：拆解管线 LLM 缝（parent design §4——shell 直调 provider，
//    不进 agent runLoop，10.2 同款）──
//
// 本文件 = seam（类型 + installDeconLlmCore setter 防环 + 测试缝）+ 生产装配真身
// （materialLLMCore / craftDistillLlmCore 同型两半合一：W2 时管线 pass 模块〔W3+〕尚未
// 存在，seam 独立成文件供其 import，装配面与 seam 同文件收口）。
//
// ⚠️ 防环注记（spec ipc-handlers installXxxCore 模式）：本文件静态引 configIpc/
// modelGatewayIpc（既有环 configIpc→db indexers→modelGatewayIpc）——**db/ 层模块禁止
// import 本文件**（materials:delete 级联走 db/closure-decon.ts repository，不进此层）；
// 本文件只被 main/index.ts whenReady（进程根）与 decon/ 管线编排层（不在 configIpc 链上）
// 引用。
//
// 解析链（craftDistillLlmCore 同型）：
// - 档位随缝参数 `slot` 路由（C3.2 六档成员，**不加新档**——parent design §4）：
//   - `extraction`「提取·汇编」：P1a 候选分类 / P1b 逐章提取 / P3a 打标——温度 0（判别非创作）。
//   - `review-judge`「评审裁判」：P1c 别名归并裁决 / P4 问题单应答——温度 0.2（语义裁判面，
//     mirror craftDistill 冲突判定同档同温）。
//   - `writer-draft`：P5 读法/章评/细批生成——温度 **0.3（deconLlmCore 自钉，F-17）**：
//     分析性叙事报告非创作文本，不沿用创作温度；child B P5 消费（child A 仅建缝）。
//   - 档位写进 prompt 契约注释，**不写死模型**（resolveTaskModel 每调用现解析——档位/配置
//     即时生效，安装期不缓存）。
// - `resolveTaskModel(slot)` → 缺档/未注入 resolver → undefined → `{keyId:'default',
//   modelId:'default'}` 哨兵 → `resolveModel` 自动选择 → model-protocols `generateText`
//   单次调用。思考策略随档（assignmentThinkingControl）。
// - **maxTokens 由调用方按缝的输出量独立传入**（E10.2a CR-2 配套纪律）；缺省 belt 8192。
// - **finishReason 透传**（CR-2）：provider 停因是截断判定权威信号——'length' → 调用方
//   capped/失败挂起；缺省 = undefined 透传。
//
// never-throws 由调用方兜（W3+ 管线 fail 面）；resolveModel 抛（未配置模型）沿契约上抛同路。
//
// wiring 测试 deconLlmWiring.test.ts 钉死：档位 key、default 哨兵链、温度随档（含
// writer-draft 0.3 自钉）、finishReason 透传。

// ── seam（W3+ 管线模块 import 此半——零 db 依赖）──

/** 拆解 LLM 任务档（C3.2 六档成员；温度随档见装配半 TEMPERATURE_BY_SLOT 注释）。 */
export type DeconGenerateSlot = 'extraction' | 'review-judge' | 'writer-draft';

/**
 * 拆解单次文本生成 seam（never-throws 由调用方兜——失败 → pass failed / job 挂起）。
 * `finishReason` 透传 provider 停因（E10.2a CR-2——截断判定权威信号）；`usage` 透传 provider
 * 计量（CR-13——cost 记账真值优先，缺失回退字符近似并标 estimated）；`maxTokens` 由调用方
 * 按缝的输出量独立核算传入（缺省 = 装配侧常量 belt）。
 */
export type DeconGenerateText = (input: {
  slot: DeconGenerateSlot;
  system?: string;
  user: string;
  maxTokens?: number;
}) => Promise<{
  text: string;
  finishReason?: GenerationFinishReason;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}>;

export interface DeconLlmCore {
  generateText: DeconGenerateText;
}

let llmCore: DeconLlmCore | null = null;

/** 生产装配点（main/index.ts whenReady 调用；未装配时管线 fail 面 'llm-unavailable' 挂起）。 */
export function installDeconLlmCore(next: DeconLlmCore): void {
  llmCore = next;
}

/** seam 取用（W3+ 管线经此取内核——null = 未装配，诚实挂起不静默）。 */
export function getDeconLlmCore(): DeconLlmCore | null {
  return llmCore;
}

/** 测试缝：清装配内核（用例间隔离）。 */
export function __clearDeconLlmCoreForTest(): void {
  llmCore = null;
}

// ── 生产装配真身（只被 main/index.ts whenReady 引入——进程根，不进环）──

/** 缺省 belt（正常路径调用方必传 maxTokens——P1b facts JSON / P2 域条目 / P4 问题单应答）。 */
export const DECON_DEFAULT_MAX_TOKENS = 8192;

/**
 * 温度随档（契约注释写明，不写死模型）：
 * - extraction 0：候选分类/逐章提取/打标 = 判别面。
 * - review-judge 0.2：别名裁决/问题单应答 = 语义裁判面。
 * - writer-draft 0.3：**自钉非创作温度**（F-17——分析性叙事报告〔读法/章评/细批〕，不沿用
 *   创作文温度；parent design §4）。
 */
const TEMPERATURE_BY_SLOT: Record<DeconGenerateSlot, number> = {
  extraction: 0,
  'review-judge': 0.2,
  'writer-draft': 0.3,
};

/** 生产 generateText 包装：每调用现解析（档位/配置即时生效——安装期不缓存模型）。 */
const generateDecon: DeconGenerateText = async (input) => {
  const assignment = resolveTaskModel(input.slot);
  const ref = assignment
    ? { keyId: assignment.keyId, modelId: assignment.modelId }
    : { keyId: 'default', modelId: 'default' };
  const thinking: ThinkingControl | undefined = assignmentThinkingControl(assignment);
  // CR-14（09-12 子2 CR 批）：链投影单次求值再 spread（spread 条件+取值双写 = TOCTOU
  // + 复制粘贴面；materialLLMCore / craftDistillLlmCore 同改）。
  const fallbacks = assignmentFallbackChain(assignment);
  // 09-12 子2（复核 H1 重接）：直调面改经网关环入口（in-process handleGenerateText）——
  // 无链快径字节级现行为；档位配链时生效（resolveModel 上移进环 per-attempt 解析）。
  // 防环注记同文件头：modelGatewayIpc 静态引用既有，db/ 层禁 import 本文件的约束不变。
  const response = await handleGenerateText({
    ref,
    request: {
      model: ref.modelId,
      messages: [
        ...(input.system ? [{ role: 'system' as const, content: input.system }] : []),
        { role: 'user' as const, content: input.user },
      ],
      temperature: TEMPERATURE_BY_SLOT[input.slot],
      maxTokens: input.maxTokens ?? DECON_DEFAULT_MAX_TOKENS,
      // 09-12 usage-panel：taskType = 拆解档位名（extraction / review-judge / writer-draft
      // ——与路由同 slot 单源，ledger byTask 分解词面）。
      taskType: input.slot,
      ...(thinking ? { thinking } : {}),
    },
    ...(fallbacks?.length ? { fallbacks } : {}),
  });
  // CR-2：透传 provider 停因（TextGenerationResponse.finishReason——GenerationFinishReason，
  // OpenAI/Anthropic 双协议路径均产出；undefined = 端点未回报）。截断判定权威信号。
  // CR-13：透传 provider usage（cost 记账真值优先——缺失时调用方按字符近似 + estimated 标注）。
  return { text: response.text ?? '', finishReason: response.finishReason, usage: response.usage };
};

/** 生产内核单例（重复 install 同一闭包——幂等字面成立，wiring 测试钉引用相等）。 */
const PRODUCTION_CORE: DeconLlmCore = { generateText: generateDecon };

/**
 * 生产装配点（main/index.ts whenReady 调用，registerAllIpc 之前装好）。幂等（重复 install
 * 同一闭包，无害）。未装配时拆解管线一律 LLM 不可用挂起（诚实失败非静默）。
 */
export function installDeconLlmCoreProduction(): void {
  installDeconLlmCore(PRODUCTION_CORE);
}
