import { describe, expect, it, vi } from 'vitest';
import {
  generate,
  setGenerateTextFn,
  type GenerateTextFn,
} from '../src/provider/ipc-provider';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 findings #4（B 层·组货防御）：messagesToPayload 悬空 toolCall 兜底
// stub——盘上存在 assistant(toolCalls) 而历史中无对应 tool 结果（abort 窗遗留的会话疤 /
// 崩溃窗等其他病源）时，出站 payload 为缺失的 call id 合成 role:'tool' 中断 stub（紧后
// 插入——OpenAI 线格式要求 tool 结果跟在 tool_call 消息后），防 ai-sdk 客户端校验
// AI_MissingToolResultsError 每请求必炸（请求不出门，会话不可用）。正常配对零影响
//（零 stub）；只补出站 payload 不动盘上历史。stub 形态与真实 tool 分支逐字段一致。
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL = new AbortController().signal;
const STUB_CONTENT = 'Tool call interrupted — no result was recorded.';

async function payloadOf(messages: SessionMessage[]): Promise<Array<Record<string, unknown>>> {
  const seam = vi.fn<GenerateTextFn>(async () => ({ text: 'ok', finishReason: 'stop' }));
  setGenerateTextFn(seam);
  await generate(messages, 'SYS', [], SIGNAL);
  return seam.mock.calls[0][0].request.messages as Array<Record<string, unknown>>;
}

describe('ipc-provider 悬空 toolCall 兜底 stub（dogfood R2 findings #4）', () => {
  it('assistant 带 toolCall 无后续 tool 消息 → 紧后合成中断 stub', async () => {
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '调用工具',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
        createdAt: 2,
      },
      { id: 'u2', role: 'user', content: '继续', createdAt: 3 },
    ];

    const payload = await payloadOf(messages);

    // stub 必须紧跟悬空 assistant 消息（线格式要求 tool 结果跟在 tool_call 后）。
    const assistantIdx = payload.findIndex((m) => m.role === 'assistant');
    expect(payload[assistantIdx + 1]).toMatchObject({
      role: 'tool',
      toolCallId: 'c1',
      toolName: 'query_story',
      content: STUB_CONTENT,
    });
    // 悬空 assistant 消息本体形态不动（toolCalls 照旧透传）。
    expect(payload[assistantIdx]).toMatchObject({ role: 'assistant', content: '调用工具' });
    expect((payload[assistantIdx].toolCalls as Array<{ id: string }>).map((tc) => tc.id)).toEqual(['c1']);
  });

  it('正常配对 → 零 stub（payload 形态不变）', async () => {
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '调用工具',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{"q":"x"}' }],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        content: 'ran',
        toolResults: [{ toolCallId: 'c1', toolName: 'query_story', output: 'ran' }],
        createdAt: 3,
      },
      { id: 'u2', role: 'user', content: '继续', createdAt: 4 },
    ];

    const payload = await payloadOf(messages);

    const toolEntries = payload.filter((m) => m.role === 'tool');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]).toMatchObject({ toolCallId: 'c1', toolName: 'query_story', content: 'ran' });
  });

  it('多 toolCall 部分满足 → 只补缺失的（满足项走真实结果）', async () => {
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '并行调用',
        toolCalls: [
          { id: 'c1', name: 'query_story', arguments: '{}' },
          { id: 'c2', name: 'query_arc', arguments: '{}' },
        ],
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        content: 'ran',
        toolResults: [{ toolCallId: 'c1', toolName: 'query_story', output: 'ran' }],
        createdAt: 3,
      },
    ];

    const payload = await payloadOf(messages);

    const toolEntries = payload.filter((m) => m.role === 'tool');
    expect(toolEntries).toHaveLength(2);
    // c2 缺失 → stub 紧跟 assistant（第一条 tool 项）；c1 用真实结果（第二条）。
    expect(toolEntries[0]).toMatchObject({ toolCallId: 'c2', toolName: 'query_arc', content: STUB_CONTENT });
    expect(toolEntries[1]).toMatchObject({ toolCallId: 'c1', content: 'ran' });
  });

  it('只补出站 payload，盘上历史不被改写', async () => {
    const messages: SessionMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: '调用工具',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }],
        createdAt: 1,
      },
    ];

    const payload = await payloadOf(messages);

    // payload 侧有 stub，消息数组本体零新增（不篡改真实记录）。
    expect(payload.some((m) => m.role === 'tool')).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].toolResults).toBeUndefined();
  });

  // ── CR-39（dogfood R2 BMad CR）：悬空扫描三边界 ──────────────────────────────

  it('CR-39①：同 toolCallId 出现在两条 assistant——结果之前最近的一条吃真结果，更早的补 stub', async () => {
    // 形态 A（重放疤：重复 assistant 在结果之后）：A1 → 真结果 → A2（重复声明）→ A2 紧后 stub。
    const messages: SessionMessage[] = [
      {
        id: 'a1', role: 'assistant', content: '第一帧',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }], createdAt: 1,
      },
      {
        id: 't1', role: 'tool', content: 'ran',
        toolResults: [{ toolCallId: 'c1', toolName: 'query_story', output: 'ran' }], createdAt: 2,
      },
      {
        id: 'a2', role: 'assistant', content: '重复帧（会话疤）',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }], createdAt: 3,
      },
    ];

    const payload = await payloadOf(messages);

    const toolEntries = payload.filter((m) => m.role === 'tool');
    // 真结果（原位）+ A2 紧后的 stub——每条 assistant 的 tool_call 都有紧随的 tool 消息。
    //（payload[0] 是 system 前言——下方下标均从 A1=1 起算。）
    expect(toolEntries).toHaveLength(2);
    expect(payload[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'ran' });
    expect(payload[4]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: STUB_CONTENT });
  });

  it('CR-39①（反向形态）：重复声明都在结果之前——前一条补 stub，靠后的吃真结果', async () => {
    // 形态 B（双写疤：两条 assistant 都在结果前）：A1 → A2 → 结果 → A1 紧后 stub（A2 配真结果）。
    const messages: SessionMessage[] = [
      {
        id: 'a1', role: 'assistant', content: '第一帧',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }], createdAt: 1,
      },
      {
        id: 'a2', role: 'assistant', content: '第二帧（双写疤）',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }], createdAt: 2,
      },
      {
        id: 't1', role: 'tool', content: 'ran',
        toolResults: [{ toolCallId: 'c1', toolName: 'query_story', output: 'ran' }], createdAt: 3,
      },
    ];

    const payload = await payloadOf(messages);

    const toolEntries = payload.filter((m) => m.role === 'tool');
    expect(toolEntries).toHaveLength(2);
    // A1 紧后 stub（未配对），A2 后跟真结果（一对一配对）。（payload[0] 是 system 前言。）
    expect(payload[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: STUB_CONTENT });
    expect(payload[4]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'ran' });
  });

  it('CR-39②：孤儿 tool result（无任何 assistant 声明过该 id）从 wire 过滤', async () => {
    const messages: SessionMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a1', role: 'assistant', content: '正常调用',
        toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }], createdAt: 2,
      },
      {
        id: 't1', role: 'tool', content: '正常结果',
        toolResults: [{ toolCallId: 'c1', toolName: 'query_story', output: '正常结果' }], createdAt: 3,
      },
      {
        // 孤儿：声明被压缩/改写丢失的残余 tool 消息——wire 出去厂商必 400。
        id: 't2', role: 'tool', content: '孤儿结果',
        toolResults: [{ toolCallId: 'ghost', toolName: 'query_arc', output: '孤儿结果' }], createdAt: 4,
      },
    ];

    const payload = await payloadOf(messages);

    const toolEntries = payload.filter((m) => m.role === 'tool');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]).toMatchObject({ toolCallId: 'c1', content: '正常结果' });
    expect(payload.some((m) => m.toolCallId === 'ghost')).toBe(false);
  });

  it('CR-39③：toolCall id 空/缺（损坏记录）→ 跳过不 stub（不出 toolCallId:undefined 垃圾帧）', async () => {
    const messages: SessionMessage[] = [
      {
        id: 'a1', role: 'assistant', content: '损坏记录',
        toolCalls: [
          { id: '', name: 'query_story', arguments: '{}' },
          { id: 'c2', name: 'query_arc', arguments: '{}' },
        ],
        createdAt: 1,
      },
    ];

    const payload = await payloadOf(messages);

    const toolEntries = payload.filter((m) => m.role === 'tool');
    // 空 id 声明跳过（不 stub）；正常声明的 c2 照常 stub。
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]).toMatchObject({ role: 'tool', toolCallId: 'c2', content: STUB_CONTENT });
    expect(payload.some((m) => m.role === 'tool' && (!m.toolCallId || m.toolCallId === ''))).toBe(false);
  });

  it('CR-44：stub 注入打一行 console.debug（session id + toolCallId，不打内容）', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const messages: SessionMessage[] = [
        {
          id: 'a1', role: 'assistant', content: '调用工具',
          toolCalls: [{ id: 'c1', name: 'query_story', arguments: '{}' }], createdAt: 1,
        },
      ];
      const seam = vi.fn<GenerateTextFn>(async () => ({ text: 'ok', finishReason: 'stop' }));
      setGenerateTextFn(seam);
      await generate(messages, 'SYS', [], SIGNAL, { sessionId: 'sess-44' });

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [fmt, sessionId, toolCallId] = debugSpy.mock.calls[0]!;
      expect(String(fmt)).toContain('dangling toolCall stub injected');
      expect(sessionId).toBe('sess-44');
      expect(toolCallId).toBe('c1');

      // 正常配对零 stub → 零日志。
      debugSpy.mockClear();
      const paired: SessionMessage[] = [
        {
          id: 'a1', role: 'assistant', content: '调用工具',
          toolCalls: [{ id: 'c9', name: 'query_story', arguments: '{}' }], createdAt: 1,
        },
        {
          id: 't1', role: 'tool', content: 'ran',
          toolResults: [{ toolCallId: 'c9', toolName: 'query_story', output: 'ran' }], createdAt: 2,
        },
      ];
      await generate(paired, 'SYS', [], SIGNAL, { sessionId: 'sess-44' });
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });

  // task 09-01 B2（R2.3）组合核对：悬空扫描（只认 assistant/toolCalls 与 tool/toolResults）
  // 对 user.images 字段无感知——带图 user 消息在场时 stub 照常注入，user 消息形态不被触碰。
  it('B2 组合：带图 user 消息 + 悬空 assistant toolCall → stub 照常注入，image parts 消息形态不动', async () => {
    const messages: SessionMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '看图',
        images: [{ path: 'inbox/images/z.png', b64hash: 'hz', name: 'z' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '调用工具',
        toolCalls: [{ id: 'c1', name: 'analyze_image', arguments: '{"imagePath":"inbox/images/z.png"}' }],
        createdAt: 2,
      },
    ];

    const payload = await payloadOf(messages);

    // 悬空 toolCall 照常合成 stub（紧随 assistant）。
    const assistantIdx = payload.findIndex((m) => m.role === 'assistant');
    expect(payload[assistantIdx + 1]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: STUB_CONTENT });
    // user 消息仍为 text+image parts（未被扫描/组货路径改写）。
    expect(Array.isArray(payload[1].content)).toBe(true);
    expect((payload[1].content as Array<Record<string, unknown>>).some((p) => p.type === 'image')).toBe(true);
  });
});
