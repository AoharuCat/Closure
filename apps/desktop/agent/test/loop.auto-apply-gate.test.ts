import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runLoop } from '../src/agent/loop';
import {
  AUTO_APPLY_SELF_REVIEW_MESSAGE,
  enforceAutoApplyTier,
  shouldGateAutoApply,
} from '../src/runtime/toolPolicy';
import type { SessionMessage, ToolDefinition } from '../src/types';

/**
 * CR-001（8.5 BMad CR，2026-08-18 用户拍板）：autoApply 自审闸门。
 *
 * LLM 首次带 autoApply:true 调 diff 工具 → runLoop 拦截不执行（无 IPC / 无 tool.execute），
 * 合成闸门消息（重读当前数据自审 → 带 selfReviewConfirmed:true 重发才落盘）。
 * seam = runLoop 工具派发段：链上节点程序化 registry.execute 直调（arc-emergence-node 调
 * arc_ledger_update、write_chapter 收尾调 story_sync_apply）不经 runLoop，天然免闸（本文件
 * 用「execute 未被调」锁 LLM 路径拦截；程序化路径在 arc-emergence.test.ts 既有真跑测试覆盖）。
 *
 * CR-002（8.6 BMad CR）：autoApply 档位强制——非 auto 档 autoApply 一律视为 false（strip 后派发）。
 * 闸门测试自此须跑 **auto 档**（suggest 档 autoApply 被 strip，闸门不再触发——那是 CR-002 的
 * 决断性设计非回归）；suggest 档行为由下方 CR-002 suite 锚定。
 */
describe('runLoop autoApply self-review gate (CR-001)', () => {
  /** diff 类工具替身（id 必须真在 DIFF_TOOLS——闸门按 classifyTool 判类，非工具自述）。 */
  function makeDiffTool(execute = vi.fn(async () => ({ title: 'ok', output: 'applied-to-disk' }))): {
    tool: ToolDefinition;
    execute: ReturnType<typeof vi.fn>;
  } {
    return {
      tool: {
        id: 'growth_curve_update',
        description: 'test diff tool',
        parameters: z.object({ autoApply: z.boolean().optional(), selfReviewConfirmed: z.boolean().optional() }),
        execute,
      },
      execute,
    };
  }

  function toolCall(id: string, args: string) {
    return { id, name: 'growth_curve_update', arguments: args };
  }

  function userMsg(): SessionMessage {
    return { id: 'u1', role: 'user', content: 'go', createdAt: Date.now() };
  }

  it('shouldGateAutoApply 判定：diff+autoApply+未自审 → true；重发已自审 / 非 autoApply / 非 diff 工具 / params null → false', () => {
    expect(shouldGateAutoApply('growth_curve_update', { autoApply: true })).toBe(true);
    expect(shouldGateAutoApply('growth_curve_update', { autoApply: true, selfReviewConfirmed: false })).toBe(true);
    // 重发自证已自审 → 放行。
    expect(shouldGateAutoApply('growth_curve_update', { autoApply: true, selfReviewConfirmed: true })).toBe(false);
    // 非 autoApply（人审 envelope 路径）→ 不拦。
    expect(shouldGateAutoApply('growth_curve_update', { autoApply: false })).toBe(false);
    expect(shouldGateAutoApply('growth_curve_update', {})).toBe(false);
    // 非 diff 工具（read/write 类）带 autoApply 字段也不拦（闸门只管 diff 家族）。
    expect(shouldGateAutoApply('query_story', { autoApply: true })).toBe(false);
    expect(shouldGateAutoApply('write_file', { autoApply: true })).toBe(false);
    // params 非对象（null/字符串）→ 安全不拦（非 autoApply 语义无从谈起）。
    expect(shouldGateAutoApply('growth_curve_update', null)).toBe(false);
    expect(shouldGateAutoApply('growth_curve_update', 'oops')).toBe(false);
    // 09-12 子4 W6 遗留②：桥 Tier 2 两写工具归 diff 家族——此前缺省 'read' 让闸门
    // 不覆盖（autoApply:true 绕自审直落）+ readonly 档可直调。重发自审同放行。
    expect(shouldGateAutoApply('info_release_map_update', { autoApply: true })).toBe(true);
    expect(shouldGateAutoApply('promise_ledger_update', { autoApply: true })).toBe(true);
    expect(
      shouldGateAutoApply('info_release_map_update', { autoApply: true, selfReviewConfirmed: true }),
    ).toBe(false);
  });

  it('首次 autoApply:true 调用被拦：不执行工具（无 IPC），返闸门消息；重发 selfReviewConfirmed:true 才真执行', async () => {
    const { tool, execute } = makeDiffTool();
    const collected: SessionMessage[] = [];
    let calls = 0;
    const args1 = JSON.stringify({ actions: [{ op: 'add_curve', curve: { character_id: 'c1', start_state: 's' } }], autoApply: true });
    const args2 = JSON.stringify({ actions: [{ op: 'add_curve', curve: { character_id: 'c1', start_state: 's' } }], autoApply: true, selfReviewConfirmed: true });

    await runLoop({
      sessionId: 's1',
      projectPath: '.',
      messages: [userMsg()],
      systemPrompt: 'sys',
      tools: [tool],
      maxSteps: 6,
      // CR-002：闸门语义测试跑 auto 档——suggest 档 autoApply 被 strip 成 false，闸门不触发
      // （决断性设计；suggest 档行为见下方 CR-002 suite）。
      permissionMode: 'auto',
      generate: async () => {
        calls++;
        if (calls === 1) return { content: '首次直落', toolCalls: [toolCall('call_1', args1)], finishReason: 'tool_calls' };
        if (calls === 2) return { content: '自审后重发', toolCalls: [toolCall('call_2', args2)], finishReason: 'tool_calls' };
        return { content: '完成', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
    });

    // 首次被拦（execute 零调用），重发才执行——且只执行一次。
    expect(execute).toHaveBeenCalledTimes(1);
    // 重发 params 原样到达 execute（含 selfReviewConfirmed，autoApply 语义不变）。
    expect(execute.mock.calls[0][0]).toMatchObject({ autoApply: true, selfReviewConfirmed: true });

    const toolMessages = collected.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    // 第一条 = 闸门消息（合成，非 Error 前缀——不进连续 tool 错误计数）。
    expect(toolMessages[0].content).toBe(AUTO_APPLY_SELF_REVIEW_MESSAGE);
    expect(toolMessages[0].content.startsWith('Error:')).toBe(false);
    expect(toolMessages[0].toolResults?.[0]).toMatchObject({ toolCallId: 'call_1', toolName: 'growth_curve_update' });
    expect(toolMessages[0].toolResults?.[0]?.output).toContain('selfReviewConfirmed');
    // 第二条 = 工具真实输出（落盘成功路径）。
    expect(toolMessages[1].content).toBe('applied-to-disk');
  });

  it('非 autoApply 调用（缺省人审路径）零影响：直接执行，不进闸', async () => {
    const { tool, execute } = makeDiffTool();
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's2',
      projectPath: '.',
      messages: [userMsg()],
      systemPrompt: 'sys',
      tools: [tool],
      maxSteps: 4,
      generate: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '产 patch 人审',
            toolCalls: [toolCall('call_1', JSON.stringify({ actions: [{ op: 'add_curve', curve: { character_id: 'c1', start_state: 's' } }] }))],
            finishReason: 'tool_calls',
          };
        }
        return { content: '完成', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const toolMessages = collected.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toBe('applied-to-disk');
    expect(toolMessages[0].content).not.toContain('selfReviewConfirmed');
  });

  it('readonly 照旧拦：diff 工具在 readonly 模式被 assertToolAllowed 拒（闸门之前，行为不变）', async () => {
    const { tool, execute } = makeDiffTool();
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 's3',
      projectPath: '.',
      messages: [userMsg()],
      systemPrompt: 'sys',
      tools: [tool],
      maxSteps: 4,
      permissionMode: 'readonly',
      generate: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '尝试写',
            toolCalls: [toolCall('call_1', JSON.stringify({ autoApply: true }))],
            finishReason: 'tool_calls',
          };
        }
        return { content: '被拒', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
    });

    // readonly 模式 diff 工具不可见——assertToolAllowed 在闸门之前拒（既有行为，非闸门产物）。
    expect(execute).not.toHaveBeenCalled();
    const toolMessages = collected.filter((m) => m.role === 'tool');
    expect(toolMessages[0].content).toContain('not allowed in readonly mode');
    expect(toolMessages[0].content).not.toContain('selfReviewConfirmed');
  });
});

describe('runLoop autoApply 档位强制 (CR-002, 8.6 BMad CR)', () => {
  /** diff 类工具替身（execute 返 applied-to-disk——直落路径的输出形态）。 */
  function makeDiffTool(execute = vi.fn(async () => ({ title: 'ok', output: 'applied-to-disk' }))): {
    tool: ToolDefinition;
    execute: ReturnType<typeof vi.fn>;
  } {
    return {
      tool: {
        id: 'growth_curve_update',
        description: 'test diff tool',
        parameters: z.object({ autoApply: z.boolean().optional(), selfReviewConfirmed: z.boolean().optional() }),
        execute,
      },
      execute,
    };
  }

  it('enforceAutoApplyTier 纯函数：suggest/readonly 档 strip 成 false；auto 档 / 非 diff / 非 true / 非对象原样', () => {
    const args = { actions: [{ op: 'add_curve' }], autoApply: true, selfReviewConfirmed: true };
    // suggest（含 undefined 默认档）/ readonly → autoApply 改写 false，其余字段保留，不 mutate 入参。
    for (const mode of ['suggest', 'readonly', undefined] as const) {
      const out = enforceAutoApplyTier('growth_curve_update', args, mode) as Record<string, unknown>;
      expect(out.autoApply).toBe(false);
      expect(out.selfReviewConfirmed).toBe(true);
      expect(out.actions).toEqual(args.actions);
      expect(args.autoApply).toBe(true); // 入参未被 mutate
    }
    // activeSkillPermission 更严时取严生效（session auto + skill suggest → strip）。
    const out2 = enforceAutoApplyTier('growth_curve_update', args, 'auto', 'suggest') as Record<string, unknown>;
    expect(out2.autoApply).toBe(false);
    // auto 档原样。
    const out3 = enforceAutoApplyTier('growth_curve_update', args, 'auto') as Record<string, unknown>;
    expect(out3).toBe(args);
    // 非 diff 工具 / autoApply 非 true / params 非对象 → 原样返回（同一引用）。
    expect(enforceAutoApplyTier('query_story', args, 'suggest')).toBe(args);
    const noApply = { actions: [] };
    expect(enforceAutoApplyTier('growth_curve_update', noApply, 'suggest')).toBe(noApply);
    expect(enforceAutoApplyTier('growth_curve_update', null, 'suggest')).toBe(null);
  });

  it('suggest 档首发 autoApply:true + selfReviewConfirmed:true 同发 → 不直落：handler 收到 autoApply=false，无闸门消息（人审 envelope 路径）', async () => {
    const { tool, execute } = makeDiffTool();
    const collected: SessionMessage[] = [];
    let calls = 0;

    await runLoop({
      sessionId: 'cr002-s1',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: 'go', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [tool],
      maxSteps: 4,
      permissionMode: 'suggest',
      generate: async () => {
        calls++;
        if (calls === 1) {
          // CR-002 实锤形态：闸门三条件只看参数不看档位——同发即可绕闸门，旧代码 handler 收 true 直写。
          return {
            content: '同发绕闸',
            toolCalls: [{
              id: 'call_1',
              name: 'growth_curve_update',
              arguments: JSON.stringify({ actions: [{ op: 'add_curve', curve: { character_id: 'c1', start_state: 's' } }], autoApply: true, selfReviewConfirmed: true }),
            }],
            finishReason: 'tool_calls',
          };
        }
        return { content: '完成', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
    });

    // 工具被执行（非闸门拦截），但 handler 收到的 autoApply 已被档位强制改写为 false
    // → 走人审 envelope 路径（suggest 档恒 patch 人审，2.2/8.5/8.6 全家族受保护）。
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({ autoApply: false, selfReviewConfirmed: true });
    const toolMessages = collected.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    // 无闸门消息（autoApply 已 false，闸门不触发）。
    expect(toolMessages[0].content).toBe('applied-to-disk');
    expect(toolMessages[0].content).not.toContain('selfReviewConfirmed');
  });

  it('suggest 档首发 autoApply:true（未自审）→ 档位强制先于闸门：autoApply strip 成 false 直接执行（人审路径），不出闸门消息', async () => {
    const { tool, execute } = makeDiffTool();
    let calls = 0;

    await runLoop({
      sessionId: 'cr002-s2',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: 'go', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [tool],
      maxSteps: 4,
      permissionMode: 'suggest',
      generate: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '首发未自审',
            toolCalls: [{
              id: 'call_1',
              name: 'growth_curve_update',
              arguments: JSON.stringify({ actions: [], autoApply: true }),
            }],
            finishReason: 'tool_calls',
          };
        }
        return { content: '完成', toolCalls: undefined, finishReason: 'stop' };
      },
      onMessage: () => {},
      abort: new AbortController().signal,
    });

    // strip 后 autoApply=false → 闸门不拦（suggest 档的 autoApply 语义已不存在），直接执行产人审 patch。
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({ autoApply: false });
  });
});
