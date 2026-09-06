import type { SessionImagePointer, SessionMessage, ToolCall, ToolDefinition } from '../types';
import type { CacheConfig } from '../context/contextManager';
import type { GenerationLane, ThinkingControl } from '@orison/shared-contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface GenerateOptions {
  modelRef?: { keyId: string; modelId: string };
  temperature?: number;
  maxTokens?: number;
  /**
   * S4b（task 08-25 design §1.2/§2）：档位思考策略（assignment 归一后的统一档位）。
   * undefined = auto——请求不带 thinking 字段 = 厂商默认（字节级零变化）；协议层按
   * (protocol, thinkingKind) 翻译注入（S2 applyThinkingControls 单源）。
   */
  thinking?: ThinkingControl;
  /**
   * dogfood R2 #7：派发车道。`background`（child agent / 写章链——顶配思考任务首字节
   * 可合法迟到数分钟）→ 协议层 240s 首事件窗 + 有界（600s cap）单次非流式回退；
   * undefined = dialogue 语义（leader 对话 60s 窗，超时直抛——T1 D2 红线原样）。
   * 序列化进 request.lane，由 shell 网关透传到 ProtocolCallContext。
   */
  lane?: GenerationLane;
  /**
   * Streaming chunk callback (dogfood T1 Stage 1): when present the request
   * takes the streaming path at the shell seam and each incremental chunk is
   * forwarded here. All existing call sites (runLoop / chain nodes /
   * summarizer) omit it — byte-identical to the pre-streaming behaviour.
   */
  onDelta?: (d: GenerationDelta) => void;
  /**
   * CR-44（dogfood R2）：会话 id——messagesToPayload 合成悬空 toolCall 中断 stub 时打一行
   * console.debug 溯源（wire fiction vs disk truth 双源可追；只带 id 不打内容）。additive
   * optional：装配点逐个接线（leader 两车道 + 子 agent 派发族），未接的调用日志降级 'unknown'。
   */
  sessionId?: string;
}

export interface GenerateResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  /**
   * Aggregated reasoning text when the provider surfaces one (#27②, dogfood T1
   * Stage 2): runLoop writes it onto the terminal assistant message. Undefined
   * on the non-reasoning path — additive.
   */
  reasoning?: string;
  /**
   * Anthropic thinking-block signature (S4b, design §5.1/§5.2): must round-trip
   * verbatim in tool loops. runLoop writes it onto the terminal assistant
   * message next to `reasoning`; messagesToPayload re-attaches it on the next
   * request. Undefined everywhere else — additive.
   */
  reasoningSignature?: string;
  /**
   * S4b（task 08-25 design §4.2）：usage 从 seam 返回透出——S4a 校准环
   * （loop.ts updateCalibrationRatio）的生产激活开关；此前 seam 类型有字段但
   * generate() 映射时丢弃。无 usage 的 provider 照旧 undefined（零行为变化）。
   */
  usage?: GenerateTextUsage;
}

export interface GenerateTextRequest {
  ref: { keyId: string; modelId: string };
  request: {
    model: string;
    messages: unknown[];
    temperature?: number;
    maxTokens?: number;
    /** S4b：档位思考策略透传（thinkingControlSchema 同形；undefined 不占位）。 */
    thinking?: ThinkingControl;
    /** dogfood R2 #7：派发车道透传（undefined = dialogue 语义，不占位）。 */
    lane?: GenerationLane;
    tools?: unknown[];
  };
}

/**
 * Incremental streaming chunk (dogfood T1 #50 / #27②). Structurally identical
 * to model-protocols' `GenerationDelta` — the agent package stays
 * provider-agnostic (the seam is injected, no @orison/model-protocols
 * dependency), so the shape is declared locally here.
 */
export interface GenerationDelta {
  type: 'text' | 'reasoning' | 'tool';
  delta: string;
  /** `tool` 通道：调用首块携带的工具名（R2 #30 UI「正在准备工具调用」指示源）。 */
  toolName?: string;
}

/**
 * Optional callbacks on the generate seam (dogfood T1 Stage 1). The presence of
 * `onDelta` selects the streaming path at the shell dispatch point; callers
 * that omit it stay on the non-streaming path unchanged.
 */
export interface GenerateTextCallbacks {
  onDelta?: (d: GenerationDelta) => void;
}

/**
 * Usage counters surfaced by the protocol layer on the terminal frame. TYPE
 * SEAM ONLY for now — zero agent-side consumption (the C3.1 metering
 * interface position; not wired in this task).
 */
export interface GenerateTextUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type GenerateTextFn = (
  body: GenerateTextRequest,
  abort: AbortSignal,
  callbacks?: GenerateTextCallbacks,
) => Promise<{
  text?: string;
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  /** Aggregated reasoning text when the provider surfaces one (#27②). */
  reasoning?: string;
  /** Anthropic thinking-block signature (S4b B block, design §5.1) — round-trips verbatim. */
  reasoningSignature?: string;
  usage?: GenerateTextUsage;
}>;

let _generateText: GenerateTextFn | undefined;

export function setGenerateTextFn(fn: GenerateTextFn) {
  _generateText = fn;
}

/**
 * 带图 user 消息的 content parts 组装（task 09-01 B 波 R2.3 / dogfood #45，纯函数
 * 测试锚点）。首位恒为 text part（正文含指针块文本），其后逐图一枚 image part。
 *
 * 线上是**指针形态**（path 项目相对 + b64hash 指纹）而非 b64：agent 是纯编排层
 * 零 FS（ADR-2），指针→字节的读盘/归一/vision 路由/转述统一收在 shell generate 缝
 *（design §2.3，B3 的 resolveImageParts 按 {path, b64hash} 改写为 b64 或转述文本）。
 *
 * CR-001 决议 b（BMad CR 2026-09-01）：线上 part 形态**钉死**
 * `{ type:'image', image: { path, b64hash, projectPath? } }`——projectPath（指针所在
 * 项目根，session.projectPath 透传）有则带，shell 据它精确定位读盘根；无字段的旧
 * 消息 part 形态与既有逐字节一致（键缺席非 undefined——条件展开，ABSENT 语义）。
 * shell 侧（agentImageParts）与 agent 侧同形态消费，勿改字段名。
 */
export function buildImagesParts(
  content: string,
  images: SessionImagePointer[],
): Array<
  | { type: 'text'; text: string }
  | { type: 'image'; image: { path: string; b64hash: string; projectPath?: string } }
> {
  return [
    { type: 'text' as const, text: content },
    ...images.map((img) => ({
      type: 'image' as const,
      image: {
        path: img.path,
        b64hash: img.b64hash,
        ...(img.projectPath ? { projectPath: img.projectPath } : {}),
      },
    })),
  ];
}

function messagesToPayload(messages: SessionMessage[], system: string, tools: ToolDefinition[], cacheConfig?: CacheConfig, sessionId?: string) {
  // NOTE: Prompt caching (e.g. Anthropic's cache_control) is not currently
  // supported by the ai-sdk generateText path. The cacheConfig is retained in
  // the interface for future provider-level integration.
  const formatted: unknown[] = [{
    role: 'system',
    content: system,
  }];

  // Inject pinned context as a stable prefix (benefits from prompt caching when supported)
  if (cacheConfig?.pinnedContent) {
    formatted.push({
      role: 'user',
      content: `[Pinned Context]\n${cacheConfig.pinnedContent}`,
    });
    formatted.push({
      role: 'assistant',
      content: 'Acknowledged.',
    });
  }

  // Inject compacted summary of earlier conversation
  if (cacheConfig?.compactedSummary) {
    formatted.push({
      role: 'user',
      content: `<history_summary readonly="true">\n${cacheConfig.compactedSummary}\n</history_summary>`,
    });
    formatted.push({
      role: 'assistant',
      content: 'Understood. I will continue based on the context above.',
    });
  }

  // dogfood R2 findings #4（B 层·组货防御）：悬空 toolCall 兜底 stub。病灶：盘上存在
  // assistant(toolCalls) 而历史中无对应 tool 结果（loop abort 窗遗留的会话疤 / 崩溃窗等其他病源）
  // 时，该会话后续每条请求都在 ai-sdk 客户端校验点炸 AI_MissingToolResultsError——硬失败（流式
  // 回落非流式同炸），请求不出门，会话不可用。三遍扫描：第一遍收集声明集（assistant toolCalls，
  // CR-39②）+ 按消息位置登记声明/结果索引；第二遍一对一配对（CR-39①——每个 tool result 配
  // 「它之前最近的一条」同 id 声明，同 toolCallId 出现在两条 assistant 时靠后的吃真结果、靠前的
  // 由 stub 兜底）；第三遍组货——每条带 toolCalls 的 assistant 消息发出后，对其**未配对**的 call
  // id **紧后**插入 role:'tool' stub（OpenAI 线格式要求 tool 结果跟在 tool_call 消息后；stub 形态
  // 与下方 tool 分支逐字段一致，OpenAI/Anthropic 双协议切换层同读），孤儿 tool result（无任何
  // assistant 声明过该 id——声明被压缩/改写丢）从 wire 过滤（CR-39②——无 tool_call 前值的 tool
  // 消息厂商必 400），空/缺 id 的损坏记录跳过（CR-39③——stub 出 toolCallId:undefined 是垃圾帧）。
  // ⚠️ 只补出站 payload，不动盘上历史（真实记录不篡改）；上方 pinned/compacted 前言注入区不涉及
  // （无 toolCalls 语义）。正常配对零影响（全配对 → 零 stub、真结果照发）。
  const declaredToolCallIds = new Set<string>();
  const declarationIndexById = new Map<string, number[]>();
  const resultIndexById = new Map<string, number[]>();
  const indexById = (map: Map<string, number[]>, id: string, messageIndex: number) => {
    const list = map.get(id);
    if (list) list.push(messageIndex);
    else map.set(id, [messageIndex]);
  };
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) {
        if (typeof tc.id !== 'string' || tc.id === '') continue; // ③：损坏记录不参与声明/配对
        declaredToolCallIds.add(tc.id);
        indexById(declarationIndexById, tc.id, i);
      }
    } else if (m.role === 'tool') {
      for (const tr of m.toolResults ?? []) {
        if (typeof tr.toolCallId !== 'string' || tr.toolCallId === '') continue; // ③
        indexById(resultIndexById, tr.toolCallId, i);
      }
    }
  });
  // CR-39①：一对一配对——每个结果（位置升序）配它之前最近的未配对声明（同 id）。
  const pairedDeclarations = new Set<string>(); // key: `${toolCallId}@${messageIndex}`
  for (const [id, resultPositions] of resultIndexById) {
    const declarations = declarationIndexById.get(id) ?? [];
    let di = 0;
    for (const rp of resultPositions) {
      while (di + 1 < declarations.length && declarations[di + 1]! < rp) di += 1;
      if (di < declarations.length && declarations[di]! < rp) {
        pairedDeclarations.add(`${id}@${declarations[di]}`);
        di += 1;
      }
      // else：该结果无前置声明（孤儿）——组货时按声明集过滤（②），不在此消费。
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant') {
      formatted.push({
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length && {
          toolCalls: m.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        }),
        // S4b（design §5.2 多轮回传）：一律回传存量 reasoning（无开关字段——「不压=保留 /
        // 压=可丢」由压缩机制天然达成：被压掉的历史消息本身已不在 messages 里）。
        // OpenAI 生态消费 `reasoning_content`（DeepSeek+tools / Kimi K3/k2.7 硬义务；
        // GLM 标准 API 回传被忽略——无害）；Anthropic 侧协议层消费两者组 thinking 块
        //（signature 缺失时跳过该块——buildAnthropicBody 判定）。压缩后 preserveRecent
        //（保尾 6）区段的消息原样保留 → required 档硬义务天然满足（被压中段以摘要形态
        // 替换，厂商只见最近原文）。
        ...(m.reasoning !== undefined && m.reasoning !== '' ? { reasoning_content: m.reasoning } : {}),
        ...(m.reasoningSignature ? { reasoningSignature: m.reasoningSignature } : {}),
      });
      // findings #4：悬空 toolCall → 紧后合成中断 stub（仅出站 payload，盘上历史不动）。
      // CR-39 加固：只对**未配对**且 id 非空的声明补 stub。
      for (const tc of m.toolCalls ?? []) {
        if (typeof tc.id !== 'string' || tc.id === '') continue; // ③
        if (pairedDeclarations.has(`${tc.id}@${i}`)) continue;
        // CR-44：stub 注入留一行 debug 日志——wire fiction（合成结果）vs disk truth（盘上
        // 无记录）双源可溯；带 session id + toolCallId，不打内容。
        console.debug(
          '[ipc-provider] dangling toolCall stub injected (wire fiction — no result on disk) session=%s toolCallId=%s',
          sessionId ?? 'unknown',
          tc.id,
        );
        formatted.push({
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          content: 'Tool call interrupted — no result was recorded.',
        });
      }
    } else if (m.role === 'tool' && m.toolResults?.length) {
      for (const tr of m.toolResults) {
        // CR-39②：孤儿 tool result（无任何 assistant 声明过该 id）从 wire 过滤——
        // 无 tool_call 前值的 tool 消息厂商必 400。空 id 同滤（③）。
        if (typeof tr.toolCallId !== 'string' || tr.toolCallId === '' || !declaredToolCallIds.has(tr.toolCallId)) continue;
        formatted.push({
          role: 'tool',
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          content: tr.output,
        });
      }
    } else if (m.role === 'tool') {
      // Skip tool messages without results
    } else if (m.role === 'user' && m.images && m.images.length > 0) {
      // task 09-01 B 波（R2.3）：带图 user 消息 → content 组 text + image parts
      //（指针形态，见 buildImagesParts 注释）。空 images 数组走下方原 else（与无字段
      // 消息字节一致）。历史重放每轮全量重发时 shell 侧转述缓存按 b64hash 去重。
      formatted.push({
        role: 'user',
        content: buildImagesParts(m.content, m.images),
      });
    } else {
      formatted.push({ role: m.role, content: m.content });
    }
  }

  const toolDefs = tools.map(t => {
    const { $schema: _$schema, ...schema } = zodToJsonSchema(t.parameters, { target: 'jsonSchema7' }) as Record<string, unknown>;
    return {
      type: 'function' as const,
      function: {
        name: t.id,
        description: t.description,
        parameters: schema,
      },
    };
  });

  return { messages: formatted, tools: toolDefs.length > 0 ? toolDefs : undefined };
}

export async function generate(
  messages: SessionMessage[],
  system: string,
  tools: ToolDefinition[],
  abortSignal: AbortSignal,
  opts: GenerateOptions = {},
  cacheConfig?: CacheConfig,
): Promise<GenerateResult> {
  if (!_generateText) throw new Error('generateText not initialized — call setGenerateTextFn first');

  const payload = messagesToPayload(messages, system, tools, cacheConfig, opts.sessionId);

  const body: GenerateTextRequest = {
    ref: opts.modelRef ?? { keyId: 'default', modelId: 'default' },
    request: {
      model: opts.modelRef?.modelId ?? 'default',
      messages: payload.messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      // S4b：思考策略透传（undefined 序列化时自然缺席 = auto 零行为变化）。
      thinking: opts.thinking,
      // dogfood R2 #7：车道透传（undefined 自然缺席 = dialogue 零行为变化）。
      lane: opts.lane,
      tools: payload.tools,
    },
  };

  // Dogfood T1 Stage 1: only onDelta-bearing calls pass a third argument — the
  // no-callback path invokes the seam with exactly the same two arguments as
  // before the streaming upgrade (zero-regression call shape).
  const data = opts.onDelta
    ? await _generateText(body, abortSignal, { onDelta: opts.onDelta })
    : await _generateText(body, abortSignal);

  const toolCalls: ToolCall[] | undefined = data.toolCalls?.map(tc => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  }));

  return {
    content: data.text ?? data.content ?? '',
    toolCalls,
    finishReason: data.finishReason ?? 'stop',
    reasoning: data.reasoning,
    reasoningSignature: data.reasoningSignature,
    // S4b（design §4.2）：usage 透出——S4a runLoop 校准环的生产激活开关。
    usage: data.usage,
  };
}
