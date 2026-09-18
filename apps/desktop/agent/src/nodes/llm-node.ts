import { randomUUID } from 'node:crypto';
import type { GenerateFallbackEntry, ReusableAgentNodeContract, ThinkingControl } from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';
import type { GenerateOptions, GenerateResult, GenerationDelta } from '../provider/ipc-provider';
import type { SessionMessage, ToolDefinition } from '../types';
import { loadAgentPrompt } from '../prompt/agentPrompt';
import { renderTemplate } from '../prompt/template';
import { logger } from '../logger';

// ── Story 4.0 写章战术链段：LLM 节点工厂（design §4.2 / implement.md 2.2）──
//
// 把「renderTemplate(yaml user 段) + loadAgentPrompt(yaml system 段) + 单次 generate + parseOutput」
// 封装成一个 AgentNode。每个具体节点（draft-writer / multi-review / route / targeted-revision，Step 3
// 实例化）只提供 {buildPrompt, parseOutput}，复用本工厂的「load yaml + 单次 LLM + 兜底重试」骨架。
//
// 为什么单次 generate（非 runSubagent/runLoop）：design §6 tradeoff + §4.2 verify-point——runSubagent/
// runChildAgent 加载的是 `.md` agent definition 的 systemPrompt（非 yaml system 段），取不到 yaml 契约；
// 且 4.0 节点不需工具（brief 已预编译，2.3 设定 prefix 注入 draft-writer 的 `{{projectContext}}` +
// scene_graph 注入 `{{storyPlan}}` + brief 注入 `{{chapterTask}}`）。故节点 = load yaml + renderTemplate
// + 单次 generate（**yaml 作 ADR-4 单契约源**：system+user 都从 yaml）。
//
// parseOutput 失败 → 重试一次（mirror runLoop 畸形 JSON 兜底精神：再 generate 一次可能给出可 parse 的
// JSON）→ 仍失败 → 兜底 error artifact（{stateKey, artifact:{error}} 不抛，链段不崩）。AbortError
// 例外——重抛（取消语义：让 runChain 感知中止，不吞成 error artifact）。
//
// 节点柔性升级路径（design §4.2 / ADR-17）：**Story 8.4（A2/A9）：draft-writer 已 agent 化**——
// 节点内两阶段工具循环（writer-node.ts createWriterNode + makeAgentLoop，design §1.1 形态 c），
// 本工厂保留作其降级直写引擎与其余单发节点（targeted-revision/route）骨架；multi-review 为 Reader-Audit
// composite（chapter-nodes.ts）。
//
// expected_downstream_consumers:
// - Story 4.0 Step 3：draft-writer / multi-review / route / targeted-revision 节点（各自 buildPrompt
//   + parseOutput + role）。
// - Story 4.0 Step 5：createChapterChainNodes 用 createLlmNode(deps={generate, modelRef}) 装配链段。

/** 与 provider generate 兼容的子集签名（去掉 cacheConfig——节点不用）。供 deps 注入 + mock 测试。 */
export type GenerateFn = (
  messages: SessionMessage[],
  system: string,
  tools: ToolDefinition[],
  abortSignal: AbortSignal,
  opts?: GenerateOptions,
) => Promise<GenerateResult>;

export interface LlmNodeConfig {
  nodeId: string;
  role: string;
  contract: ReusableAgentNodeContract | null;
  /** 从 run.artifacts 抽 vars（如 chapterTask/storyPlan/projectContext）注入 yaml user 段。 */
  buildPrompt: (run: RunSnapshot) => Record<string, string>;
  /**
   * 解析 generate 返回的 content（JSON.parse + Zod 校验）→ NodeResult（含 stateKey + artifact）。
   * 抛错（parse/Zod 失败）时工厂会重试一次，再失败兜底 error artifact。
   */
  parseOutput: (content: string, run: RunSnapshot) => NodeResult;
  /**
   * 可选：跳过 LLM 调用（design §4 实现决断 / implement.md 5.1b）。
   *
   * 用于回环首圈：revision-optimizer（链流程重排 C1）在链序上位于 multi-review 前，首圈时
   * review.latest 缺。若不跳过，requiredArtifactKeys 放 review.latest 会首圈 blocked；放 required
   * 外又得在 run 里判。故用 shouldSkip(run) 判「无 review.latest」→ 走 skipResult（首圈 no-op 标记
   * / 外部预置意图透传，不调 generate），否则走正常 generate+parse。
   * （历史：Story 4.0 targeted-revision 首跑 pass-through 同款机制——该节点已随 09-13 W1d 退役，
   * dormant 工厂仍在用。）
   */
  shouldSkip?: (run: RunSnapshot) => boolean;
  /** shouldSkip 返 true 时的产出（如 pass-through draft.initial）。缺省 → {stateKey:nodeId, artifact:{skipped:true}}。 */
  skipResult?: (run: RunSnapshot) => NodeResult;
}

export interface LlmNodeDeps {
  generate: GenerateFn;
  modelRef?: { keyId: string; modelId: string };
  /**
   * S4b（task 08-25 design §1.2/§2）：档位思考策略——与 modelRef 同源（chapter-chain
   * llmDepsFor 从 assignment 归一）。undefined = auto（请求不带字段，字节级零变化）。
   */
  thinking?: ThinkingControl;
  /** 链段 abort 信号（runChain 注入）；缺省新建一个永不 abort 的 controller。 */
  signal?: AbortSignal;
  // 09-12 agy provider CR-23：会话键**刻意不声明**——单发 llm-node 族结构性忽略它
  //（缺省 = 单发冷路径）；真正的消费者是循环位（WriterNodeDeps.sessionKey /
  // ResearchVerifierDeps.sessionKey → makeAgentLoop → generate opts），在那里声明。
  /**
   * 09-12 子2 fallback chains（H2 透传面）：slot 回退链随 deps 进 generate opts——
   * brief-compiler / revision-guard / targeted-revision / route / 5 轴 extractor 等
   * 单发 JSON 节点同样受链保护。**onFallback 刻意不声明**（design §7：可见性由网关
   * logger.warn 兜底 + 无终态注记消费面，如实接受）。
   */
  fallbacks?: GenerateFallbackEntry[];
  /**
   * 09-12 usage-panel：任务档位/流程标签（chapter-chain llmDepsFor 按 slot 注入；透传
   * generate opts → wire request.taskType → ledger task_type 列）。undefined = 未标注。
   */
  taskType?: string;
  /**
   * 09-13 子2 W1（design §1 思考流）：节点流回调——generate opts 透传 provider onDelta
   * （每次尝试**预分配轮 messageId**，mirror makeAgentLoop 每轮预分配模式——重试轮换 id，
   * UI 侧按轮分段）；tool 通道滤除（同 makeAgentLoop R2 #30——链卡正文只有文本）。
   * 装配侧由 chapter-chain `withNodeStreaming` 注入（补 nodeId/role → workflow onNodeDelta）。
   * 主消费者 = reasoning 思考流；text 同样透传（单发 JSON 节点的裸 text 由 caller 决定
   * 消费与否）。缺省不开（零回归——opts 无 onDelta 键走非流式路径）。
   */
  onDelta?: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => void;
}

const MAX_ATTEMPTS = 2; // 初试 + 重试一次（design §4.2 / implement.md 2.2）

/**
 * generate 重试上限（初试 + 重试一次）。
 *
 * Story 4.2：导出供 createReaderAuditNode composite 节点复用同一重试语义（design §3 generate+retry
 * 骨架——抽 shared 常量避免漂移）。两个节点（createLlmNode + createReaderAuditNode）的 fallback 不同
 * （前者 error artifact，后者 R6① escalate fallback），但重试次数一致。
 */
export { MAX_ATTEMPTS };

/**
 * 构造一个 LLM 节点：run(input) = buildPrompt(run) → loadAgentPrompt(role) → renderTemplate →
 * 单次 generate → parseOutput（失败重试一次→兜底 error artifact）。
 */
export function createLlmNode(config: LlmNodeConfig, deps: LlmNodeDeps): AgentNode {
  const { nodeId, role, contract, buildPrompt, parseOutput, shouldSkip, skipResult } = config;
  const { generate, modelRef, thinking, signal, fallbacks, taskType, onDelta } = deps;

  return {
    contract,
    async run(input: NodeRunInput): Promise<NodeResult> {
      // 跳过 LLM 调用（targeted-revision 首跑无 review.latest → pass-through draft.initial，design §4 决断）
      if (shouldSkip?.(input.run)) {
        return skipResult
          ? skipResult(input.run)
          : { stateKey: nodeId, artifact: { skipped: true, nodeId, role } };
      }

      const vars = buildPrompt(input.run);
      const { system, userTemplate } = await loadAgentPrompt(role);
      const userPrompt = renderTemplate(userTemplate, vars);
      const messages: SessionMessage[] = [{
        id: randomUUID(),
        role: 'user',
        content: userPrompt,
        createdAt: Date.now(),
      }];
      const abortSignal = signal ?? new AbortController().signal;

      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          // 09-12 子2（H2）：fallbacks 随 opts 透传（空链不占位）。
          // 09-12 usage-panel：taskType 随 opts 透传（未标注不占位）。
          // 09-13 子2 W1：onDelta 随 opts 透传——每次尝试预分配轮 messageId（mirror
          // makeAgentLoop 每轮预分配：重试轮换 id，UI 侧按轮分段防重试混流）；tool 通道
          // 滤除（R2 #30 同款——链卡正文只有文本）。缺省不占位（非流式路径零回归）。
          const attemptMessageId = randomUUID();
          const result = await generate(messages, system, [], abortSignal, {
            modelRef,
            thinking,
            taskType,
            ...(fallbacks?.length ? { fallbacks } : {}),
            ...(onDelta
              ? {
                  onDelta: (d: GenerationDelta) => {
                    if (d.type === 'tool') return;
                    onDelta({ messageId: attemptMessageId, channel: d.type, delta: d.delta });
                  },
                }
              : {}),
          });
          return parseOutput(result.content, input.run);
        } catch (err) {
          if (isAbortError(err)) throw err; // 取消语义：传播，不吞成 error artifact
          lastErr = err;
          logger.warn(
            { nodeId, role, attempt, err: err instanceof Error ? err.message : String(err) },
            'createLlmNode.run: attempt failed',
          );
          // CR-5：重试时把上次 parse/校验错误回灌成 user 消息（mirror runLoop 畸形 JSON 修复语义——
          // 非 blind-retry 同 prompt：明确告知 LLM 上次输出何处不合法，引导返纯 JSON。配合 extractJson
          // 的围栏/前导文字剥离，覆盖真实 LLM（尤 Qwen/DashScope）常见畸形输出）。
          if (attempt < MAX_ATTEMPTS) {
            const errMsg = err instanceof Error ? err.message : String(err);
            messages.push({
              id: randomUUID(),
              role: 'user',
              content: `你上次的输出无法解析为有效 JSON（错误：${errMsg}）。请只输出符合契约的纯 JSON 对象，不要包含任何解释文字、markdown 代码围栏或多余内容。`,
              createdAt: Date.now(),
            });
          }
          // attempt < MAX_ATTEMPTS → loop 继续（重试 + 错误反馈）；否则跳出 → 兜底 error artifact
        }
      }

      // 两次都失败（非 abort）→ 兜底 error artifact（design §4.2：不抛，链段不崩）
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
      logger.error({ nodeId, role, message }, 'createLlmNode.run: all attempts failed → error artifact');
      return {
        stateKey: nodeId,
        artifact: {
          error: true,
          nodeId,
          role,
          message: `LLM node "${nodeId}" failed after ${MAX_ATTEMPTS} attempts: ${message}`,
        },
      };
    },
  };
}

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // DOMException(AbortError) / 自定义 AbortError 都以 name 标识（runLoop 用 DOMException）
  return err.name === 'AbortError';
}
