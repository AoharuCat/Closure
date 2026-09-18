// ── Antigravity CLI stream-json 事件流 reducer（09-12 agy provider，design §3.5）──
//
// agy `--output-format stream-json` 的 NDJSON 事件（官方文档 + 装机实测逐字段核对）：
//   init（一次）    : cwd / tools 名单 / permission_mode / model / agent / json_schema
//   step_update（多次）: step_index / state(ACTIVE|DONE|ERROR) /
//                        step_type(user_input|agent_response|tool|checkpoint) /
//                        text_delta（ACTIVE 与 DONE 均可携带）/ usage / tool_name / tool_info
//   result（一次）  : conversation_id / status / response / duration / num_turns /
//                        usage（⚠️ 会话累计）/ denied_actions / structured_output
//
// **事件行形态归一（子4 W0 §2/§5 实测，CR-24 收紧）**：装机逐字样本存在两种已实测形态——
//   flat：  {"type":"step_update","step_index":4,"state":"ERROR",...}（子1 fixture 钉死）
//   nested：{"event":"step_update","step_update":{"step_index":4,...}}（W0 装机逐字样本）
// applyCliLine 入口按**方言标记**归一：嵌套解包只发生在 `event` 标记（nested 方言）且
// 事件键在已实测嵌套键集合内且同名载荷为 plain object 时；flat 方言（`type` 标记）一律
// flat——同名列不是嵌套载荷（误判解包 = 静默读错 payload 面）。nested 方言已知键缺同名
// 载荷 = 上游形态漂移——显式呛死（unknownEvent 观测可见），不静默按 flat 吞行。上游再
// 变形时 fixture 先红（不静默吞新形态）。
//
// usage 口径（四组实验实测，研究文件「四组驱动经济性实验」节）：step_update DONE 携带
// **单 turn** usage；result.usage 是**会话累计**——per-call 记账必须取 step 求和值
//（design 复核 M3：多 step turn 取单 DONE 会漏计，工具不裁剪就按步求和）。
//
// 纯 reducer：逐行喂入（CRLF 与坏行容忍——坏行忽略不炸流），副作用以 effect 返回
//（init / 未知 event 的观测也走 effect——reducer 自身零 console，driver 统一发声）。

/**
 * agy per-step usage 形态（input/output/thinking/cache_read/total）。缺席字段保持
 * undefined（CR-18：pick 兜 0 会把「未上报」伪造成 0——0 与未知不可分，条件展开保缺席）。
 */
export interface CliUsageCounters {
  input?: number;
  output?: number;
  thinking?: number;
  cacheRead?: number;
  total?: number;
}

/**
 * tool step 的 tool_info 结构化透出（子4 E2——W0 §2/§3 实测形态）。loose 透传：上游
 * 字段形态演进（error 增删键等）不炸流；语义消费（软拒 matcher / MCP 派发解析）在
 * bridgeTurn 侧按需防御读取。
 */
export interface CliToolStepInfo {
  /** tool_info.name（与顶层 tool_name 通常一致）。 */
  name?: string;
  /** 调用参数原样透传——MCP 派发时为 {ServerName, ToolName, Arguments}（大写键，W0 §3）。 */
  parameters?: unknown;
  /** 步产物（DONE 步携带——工具输出原文，W0 §10）。 */
  output?: unknown;
  /** 步错误（ERROR 步携带——{type, message} 形态，loose 透传，W0 §2 软拒样本）。 */
  error?: unknown;
}

function readToolStepInfo(payload: Record<string, unknown>): CliToolStepInfo | undefined {
  const raw = payload.tool_info;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const info = raw as Record<string, unknown>;
  const name = typeof info.name === 'string' && info.name.length > 0 ? info.name : undefined;
  const hasParameters = 'parameters' in info;
  const hasOutput = 'output' in info;
  const hasError = 'error' in info;
  if (name === undefined && !hasParameters && !hasOutput && !hasError) return undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(hasParameters ? { parameters: info.parameters } : {}),
    ...(hasOutput ? { output: info.output } : {}),
    ...(hasError ? { error: info.error } : {}),
  };
}

function readToolStepName(payload: Record<string, unknown>, info: CliToolStepInfo | undefined): string | undefined {
  if (typeof payload.tool_name === 'string' && payload.tool_name.length > 0) return payload.tool_name;
  return info?.name;
}

/** result.denied_actions → action 名数组（W0 §2 形态：[{action:'mcp',display_name}]）。 */
function readDeniedActions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item !== null && typeof item === 'object' && typeof (item as { action?: unknown }).action === 'string') {
      out.push((item as { action: string }).action);
    }
  }
  return out;
}

export function emptyCliUsage(): CliUsageCounters {
  return { input: undefined, output: undefined, thinking: undefined, cacheRead: undefined, total: undefined };
}

/** 逐字段求和：两侧均缺席 → 保持缺席；仅一侧缺席 → 该侧贡献 0（求和语义下的合法零）。 */
export function addCliUsage(a: CliUsageCounters, b: CliUsageCounters): CliUsageCounters {
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    input: sum(a.input, b.input),
    output: sum(a.output, b.output),
    thinking: sum(a.thinking, b.thinking),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    total: sum(a.total, b.total),
  };
}

function readUsage(raw: unknown): CliUsageCounters | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const field = (key: string): number | undefined => {
    const v = u[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const input = field('input');
  const output = field('output');
  const thinking = field('thinking');
  const cacheRead = field('cache_read');
  const total = field('total');
  if (
    input === undefined && output === undefined && thinking === undefined
    && cacheRead === undefined && total === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

/** 单 turn 聚合器（不可变更新——喂入 applyCliLine 逐行推进）。 */
export interface CliTurnAccumulator {
  /** 累积 text_delta（agent_response 步，ACTIVE + DONE 均计）。 */
  textParts: string[];
  /** 该 turn 全部 step DONE usage 之和（per-call 记账源；缺席字段保持缺席）。 */
  stepUsageSum: CliUsageCounters;
  sawStepUsage: boolean;
  /** result 事件（终态锚）。result.usage 是会话累计口径、无 per-call 消费者——不进聚合器。 */
  result: {
    status: string;
    response: string | undefined;
    conversationId: string | undefined;
    /** result.denied_actions 的 action 名（W0 §2——软拒兜底信号）。 */
    deniedActions: string[];
  } | undefined;
}

export function createCliTurnAccumulator(): CliTurnAccumulator {
  return {
    textParts: [],
    stepUsageSum: emptyCliUsage(),
    sawStepUsage: false,
    result: undefined,
  };
}

/** 喂一行后可能外发的副作用。 */
export interface CliStreamEffect {
  /** agent_response 步的增量正文 → onDelta({type:'text'})。 */
  textDelta?: string;
  /** step_type==='tool' 步进入（ACTIVE）——观测 warn 用；toolName/toolInfo 为子4 E2 结构化扩展。 */
  toolStepStarted?: { stepIndex: number; toolName?: string; toolInfo?: CliToolStepInfo };
  /** step_type==='tool' 步 DONE 且携带 tool_info（产物观测面——output 原文，W0 §10）。 */
  toolStepResult?: { stepIndex: number; toolName?: string; toolInfo: CliToolStepInfo };
  /** step_type==='tool' 步 ERROR（子4 软拒诊断主信号源——W0 §2 样本）。 */
  toolStepError?: { stepIndex: number; toolName?: string; toolInfo?: CliToolStepInfo };
  /** init 事件观测（CR-17：tools 数 / permission_mode / model——经 effect 落日志，reducer 保持纯）。 */
  init?: { toolsCount?: number; permissionMode?: string; model?: string };
  /** 未知 event 类型（官方约定「跳过并警告」——经 effect 外发 warn）。 */
  unknownEvent?: { type: string };
}

/** 已实测嵌套事件键（W0 §2/§10 样本：`event` 标记 + 同名 plain object 载荷）。 */
const NESTED_EVENT_KEYS: ReadonlySet<string> = new Set(['init', 'step_update', 'result']);

/**
 * 行形态归一（文件头「事件行形态归一」节，CR-24 收紧）：方言标记判别 + 限定键嵌套解包。
 * flat 行（`type` 标记）一律 flat——同名列不误判嵌套；nested 行（`event` 标记）仅已知
 * 嵌套键解包；已知键缺同名载荷 → drift 标记（调用方显式呛死，不静默按 flat 吞）。
 */
function readStreamEvent(parsed: Record<string, unknown>): {
  type: string | undefined;
  payload: Record<string, unknown>;
  /** nested 方言已知键缺同名载荷 = 上游形态漂移（呛死观测，不静默吸收）。 */
  drift: boolean;
} {
  const eventType = typeof parsed.event === 'string' && parsed.event.length > 0 ? parsed.event : undefined;
  if (eventType !== undefined) {
    if (NESTED_EVENT_KEYS.has(eventType)) {
      const nested = parsed[eventType];
      if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
        return { type: eventType, payload: nested as Record<string, unknown>, drift: false };
      }
      return { type: eventType, payload: parsed, drift: true };
    }
    return { type: eventType, payload: parsed, drift: false }; // 未知嵌套键保持 flat（unknownEvent 观测）
  }
  const flatType = typeof parsed.type === 'string' && parsed.type.length > 0 ? parsed.type : undefined;
  return { type: flatType, payload: parsed, drift: false };
}

/** 坏 JSON / 非 JSON 行 → 原样返回（忽略）；CRLF 在此剥除。 */
export function applyCliLine(
  acc: CliTurnAccumulator,
  rawLine: string,
): { acc: CliTurnAccumulator; effect?: CliStreamEffect } {
  const line = rawLine.replace(/\r$/, '');
  if (!line.trim()) return { acc };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { acc }; // 坏行容忍：忽略不炸流
  }
  if (parsed === null || typeof parsed !== 'object') return { acc };
  const { type, payload: event, drift } = readStreamEvent(parsed as Record<string, unknown>);

  if (drift) {
    // CR-24 收紧：nested 方言（event 标记）已知键缺同名载荷 = 上游形态漂移——显式呛死
    //（unknownEvent 观测可见），不静默按 flat 处理（否则会造出垃圾 result 或无效果吞行）。
    return { acc, effect: { unknownEvent: { type: `${type} (nested payload missing)` } } };
  }

  if (type === 'init') {
    return {
      acc,
      effect: {
        init: {
          ...(Array.isArray(event.tools) ? { toolsCount: event.tools.length } : {}),
          ...(typeof event.permission_mode === 'string' ? { permissionMode: event.permission_mode } : {}),
          ...(typeof event.model === 'string' ? { model: event.model } : {}),
        },
      },
    };
  }

  if (type === 'step_update') {
    const stepType = event.step_type;
    const state = event.state;
    let next = acc;
    let effect: CliStreamEffect | undefined;

    if (stepType === 'agent_response' && typeof event.text_delta === 'string' && event.text_delta.length > 0) {
      next = { ...next, textParts: [...next.textParts, event.text_delta] };
      effect = { textDelta: event.text_delta };
    }
    if (stepType === 'tool') {
      const stepIndex = typeof event.step_index === 'number' ? event.step_index : -1;
      const toolInfo = readToolStepInfo(event);
      const toolName = readToolStepName(event, toolInfo);
      const stepEffect = (): CliStreamEffect | undefined => {
        if (state === 'ACTIVE') {
          return {
            toolStepStarted: {
              stepIndex,
              ...(toolName !== undefined ? { toolName } : {}),
              ...(toolInfo !== undefined ? { toolInfo } : {}),
            },
          };
        }
        if (state === 'ERROR') {
          // 无名无 info 的裸 ERROR 步 = 纯噪音，不透出。
          if (toolName === undefined && toolInfo === undefined) return undefined;
          return {
            toolStepError: {
              stepIndex,
              ...(toolName !== undefined ? { toolName } : {}),
              ...(toolInfo !== undefined ? { toolInfo } : {}),
            },
          };
        }
        if (state === 'DONE' && toolInfo !== undefined) {
          return {
            toolStepResult: {
              stepIndex,
              ...(toolName !== undefined ? { toolName } : {}),
              toolInfo,
            },
          };
        }
        return undefined;
      };
      const toolEffect = stepEffect();
      if (toolEffect !== undefined) {
        effect = effect ? { ...effect, ...toolEffect } : toolEffect;
      }
    }
    if (state === 'DONE') {
      const usage = readUsage(event.usage);
      if (usage !== undefined) {
        next = {
          ...next,
          stepUsageSum: addCliUsage(next.stepUsageSum, usage),
          sawStepUsage: true,
        };
      }
    }
    return { acc: next, effect };
  }

  if (type === 'result') {
    const next: CliTurnAccumulator = {
      ...acc,
      result: {
        status: typeof event.status === 'string' ? event.status : 'UNKNOWN',
        response: typeof event.response === 'string' ? event.response : undefined,
        conversationId: typeof event.conversation_id === 'string' ? event.conversation_id : undefined,
        deniedActions: readDeniedActions(event.denied_actions),
      },
    };
    return { acc: next };
  }

  // 未知 event（未来新增等）——跳过不炸流，观测经 effect 外发（官方：未知 event 跳过并警告）。
  const unknownType = type !== undefined ? type : '(untyped)';
  return { acc, effect: { unknownEvent: { type: unknownType } } };
}

/** 终态判定（result 已到 / 流断）。 */
export type CliTurnOutcome =
  | { kind: 'success'; text: string; usage: CliUsageCounters; sawStepUsage: boolean }
  | { kind: 'error'; status: string; message: string }
  | { kind: 'canceled' }
  | { kind: 'no-result' };

/**
 * 收尾归约：result.status →
 *   SUCCESS → success（正文取 result.response 权威全文，缺席回落累积 delta；空响应 +
 *             零 delta → error EMPTY 形态——空白生成必须可检，不静默空成功）；
 *   ERROR   → error（喂 driver 错误分类表）；
 *   CANCELED / INTERRUPTED → canceled（abort 语义 + 作废会话，design §3.5）；
 *   INVALID / WAITING / RUNNING → error（driver 映射 502 + 作废会话）；
 *   无 result（进程退出/流断）→ no-result（driver 映射 502 + stderr 摘要 + 作废）。
 */
export function finishCliTurn(acc: CliTurnAccumulator): CliTurnOutcome {
  const result = acc.result;
  if (result === undefined) return { kind: 'no-result' };
  if (result.status === 'SUCCESS') {
    const text = result.response !== undefined && result.response.trim().length > 0
      ? result.response
      : acc.textParts.join('');
    if (text.trim().length === 0) {
      return {
        kind: 'error',
        status: 'EMPTY',
        message: 'antigravity-cli turn ended with SUCCESS but produced no response text (empty response and zero text deltas)',
      };
    }
    return {
      kind: 'success',
      text,
      usage: acc.stepUsageSum,
      sawStepUsage: acc.sawStepUsage,
    };
  }
  if (result.status === 'CANCELED' || result.status === 'INTERRUPTED') {
    return { kind: 'canceled' };
  }
  return {
    kind: 'error',
    status: result.status,
    message: result.response ?? `antigravity-cli turn ended with status ${result.status}`,
  };
}
