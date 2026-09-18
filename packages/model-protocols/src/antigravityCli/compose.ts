import type { GenerationMessage } from '@orison/shared-contracts';

// ── Antigravity CLI turn 组装（09-12 agy provider，design §3.4）──
//
// 纯函数：把 (system, messages) 确定性映射为文本段序列（每条消息一段，system 指令块
// 恒为第 0 段）。段是 mirror.ts 内容锚定的单位——同消息同文本必同段。
//
// 冷启动 turn = 全部段拼接；增量 turn = 仅新增尾段拼接（进程已持有旧上下文——缓存读
// 的前提）。stdin 行形态（官方文档 + 实机验证）：
//   {"event":"user","message":{"content":"<turn 文本>"}}
// 未知 event 跳过并警告；缺 event 字段/坏 JSON/非 text 块 → agy 退出码 1/2 结束会话
// （本侧只产合法行）。

/**
 * 输出框架声明（防工具乱动底线三件套之一，研究文件「冒烟实测」节）：CLI 形态剥离了
 * Closure 工具协议，且 agy 自带 ~58 个内置工具——指令块末尾钉一段「直接输出文本」
 * 声明，压住模型把 turn 浪费在自带工具上的倾向。
 */
export const CLI_OUTPUT_DIRECTIVE =
  '请直接以纯文本回应对话中的最后一条消息。不要调用任何工具，不要输出与回应无关的说明。';

/**
 * 本侧生成的角色/注记标记 token 前缀族（真实边界语法）。转写内容（书文 / 工具结果 /
 * 模型历史输出）中出现同形 token 会伪造角色边界——一个以「【用户】」开头的书文段在
 * 扁平化的单流 transcript 里冒充新消息，工具结果可冒充系统指令（prompt injection）。
 */
const CONTENT_MARKER_PREFIXES = [
  '【系统指令】',
  '【输出要求】',
  '【用户】',
  '【助手】',
  '【工具结果',
  '[助手工具调用 ',
  '[图片 ',
] as const;

/**
 * 内容侧标记防伪（CR-16）：把内容里出现的标记 token 前缀做不可复原替换（首括号 →
 * 全角方括号 ［）——标记语法本身只在真实边界由本模块生成，转写内容永远无法再现真形。
 * 仅作用于不可信内容（user/assistant/tool 消息体）；system 指令是 Closure 自产（可信），不转。
 */
export function escapeCliMarkers(text: string): string {
  let out = text;
  for (const marker of CONTENT_MARKER_PREFIXES) {
    if (out.includes(marker)) {
      out = out.split(marker).join(`［${marker.slice(1)}`);
    }
  }
  return out;
}

/** 指令块输出要求覆盖项：缺省 = CLI_OUTPUT_DIRECTIVE；null = 不附输出要求块；string = 覆盖文案。 */
export interface InstructionBlockOptions {
  outputDirective?: string | null;
}

/** 指令块（恒为第 0 段；system 缺席时仍保留输出要求块——段位不变式）。 */
export function composeInstructionBlock(system: string, opts?: InstructionBlockOptions): string {
  const directive = opts?.outputDirective === undefined ? CLI_OUTPUT_DIRECTIVE : opts.outputDirective;
  const trimmed = system.trim();
  const directiveBlock = directive !== null ? `\n\n【输出要求】\n${directive}` : '';
  return trimmed
    ? `【系统指令】\n${trimmed}${directiveBlock}`
    : (directiveBlock !== '' ? `【输出要求】\n${directive}` : '');
}

/**
 * 单条消息 → 一个文本段（确定性转写）。tool 消息按【工具结果】注记段呈现（CLI 形态
 * 工具面已剥离——历史中的工具往返以注记形态保留语义）；assistant 的 toolCalls 同理
 * 注记。带图 user 消息（经 visionModel 转述后通常已无 image part）若仍有漏网图片
 * part，以占位标注呈现——不丢消息形状、不伪造内容。不可信内容（用户书文 / 工具结果 /
 * 模型历史输出）经 escapeCliMarkers 防伪——内容里的标记 token 不得再现真形（CR-16）。
 */
export function composeMessageSegment(message: GenerationMessage): string {
  switch (message.role) {
    case 'system':
      // 系统消息在段序列里通常已被抽走（splitSystemMessages）；若仍出现在消息流中，
      // 以指令段形态呈现（确定性兜底，不丢内容）。
      return composeInstructionBlock(message.content);
    case 'user': {
      if (typeof message.content === 'string') {
        return `【用户】\n${escapeCliMarkers(message.content)}`;
      }
      const parts = message.content.map((part) =>
        part.type === 'text'
          ? escapeCliMarkers(part.text)
          : `[图片 ${part.image.mimeType}：本通道不支持图片输入，已省略]`,
      );
      return `【用户】\n${parts.join('\n')}`;
    }
    case 'assistant': {
      const callNotes = (message.toolCalls ?? []).map(
        (tc) => `\n[助手工具调用 ${tc.name}] ${escapeCliMarkers(tc.arguments)}`,
      );
      return `【助手】\n${escapeCliMarkers(message.content)}${callNotes.join('')}`;
    }
    case 'tool':
      return `【工具结果 ${message.toolCallId}】\n${escapeCliMarkers(message.content)}`;
  }
}

/** 从消息流抽出 system 消息（mirror buildOpenAiArgs / buildAnthropicBody 的抽离口径）。 */
export function splitSystemMessages(messages: GenerationMessage[]): {
  system: string;
  rest: GenerationMessage[];
} {
  const systemParts: string[] = [];
  const rest: GenerationMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
    } else {
      rest.push(message);
    }
  }
  return { system: systemParts.join('\n\n'), rest };
}

/**
 * 完整段序列：[指令块, ...消息段]。冷启动 turn 文本 = join 全部段；增量 turn 文本 =
 * join 尾段切片（调用方切）。段间以空行分隔（可读性 + 段边界稳定）。opts 透传指令块
 * 输出要求覆盖（桥 turn 用——工具调用是预期行为，不附「不要调用任何工具」声明）。
 */
export function buildTurnSegments(
  system: string,
  messages: GenerationMessage[],
  opts?: InstructionBlockOptions,
): string[] {
  return [composeInstructionBlock(system, opts), ...messages.map(composeMessageSegment)];
}

/** 段序列 → turn 文本。 */
export function composeTurnText(segments: string[]): string {
  return segments.join('\n\n');
}

/** turn 文本 → stdin 单行 JSON（不含换行——写入方追加）。 */
export function buildStdinLine(turnText: string): string {
  return JSON.stringify({ event: 'user', message: { content: turnText } });
}
