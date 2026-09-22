/**
 * 09-20 F17 W4（design §5 / AC4 / G3=F18）：失败工具调用的如实呈现。
 * 真机实证：桥车道 write_chapter 抛 `Unknown tool`、零产出，对话流卡片却显
 * 「✓ 已应用」（DiffCard auto 分支 + edit_document 图标）——失败与成功呈现无差别。
 *
 * 修复面（链路约定不新增通道）：两车道失败合成同形 `Error: <message>` 前缀
 * tool 结果（HTTP runLoop loop.ts 三处 / 桥 persistToolCallPair bridgeExecutor.ts），
 * UI 判据单源化 isToolErrorOutput；AgentMessageItem 的 WRITE_TOOLS 渲染路由拒失败
 * 结果进 DiffCard（防「✓ 已应用/已处理」误导壳），落 stepResults → AgentToolCard
 * 失败态（⚠ + 错误类 + 展开可读错误原文——HTTP 车道工具卡失败先例同构）。
 *
 * 覆盖三层：纯谓词 / AgentToolCard 两态 / AgentMessages 全链路由（真实拦截位，
 * mirror agentChainDirectiveCard.test 先例）。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { AgentToolCard } from '../src/features/agent-panel/AgentToolCard';
import { isToolErrorOutput } from '../src/features/agent-panel/toolMeta';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

/** 桥车道失败 write_chapter 的实拍形态（persistToolCallPair 失败分支）：Error 前缀、无 metadata。 */
const BRIDGE_FAILED_WRITE_CHAPTER: AgentMessage = msg({
  id: 't-fail',
  role: 'tool',
  toolResults: [
    { toolCallId: 'tc-fail', toolName: 'write_chapter', output: 'Error: Unknown tool: write_chapter' },
  ],
});

beforeEach(() => {
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    activeSessionRunning: false,
    agentRunStates: {},
    agentSessionId: 'session-1',
    sendAgentMessage: vi.fn(),
    truncateAgentMessages: vi.fn(),
    agentMode: 'auto',
    pendingDiffsBySession: {},
  } as any);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('isToolErrorOutput（失败判据单源谓词）', () => {
  it('两车道失败合成形态 Error 前缀 → true', () => {
    expect(isToolErrorOutput('Error: Unknown tool: write_chapter')).toBe(true);
    expect(isToolErrorOutput('Error: 工具执行失败：路径越界')).toBe(true);
  });

  it('大小写与前导空白容忍 → true', () => {
    expect(isToolErrorOutput('error: boom')).toBe(true);
    expect(isToolErrorOutput('  Error: boom')).toBe(true);
  });

  it('非失败形态 → false（词边界防「Errors」等前缀近邻误判）', () => {
    expect(isToolErrorOutput('Errors were found in 3 places')).toBe(false);
    expect(isToolErrorOutput('第一章草稿完成，字数 2800')).toBe(false);
    expect(isToolErrorOutput('主角失败了，但伏笔已埋下')).toBe(false);
    expect(isToolErrorOutput('')).toBe(false);
  });

  it('非字符串入参 → false（unknown seam 形态守卫）', () => {
    expect(isToolErrorOutput(undefined)).toBe(false);
    expect(isToolErrorOutput(null)).toBe(false);
    expect(isToolErrorOutput(42)).toBe(false);
  });
});

describe('AgentToolCard 失败/成功两态（HTTP 先例呈现）', () => {
  it('失败输出 → 错误卡（⚠ + 错误类），展开可见错误原文', () => {
    const { container } = render(
      <AgentToolCard result={{ toolName: 'write_chapter', output: 'Error: Unknown tool: write_chapter' }} />,
    );
    expect(container.querySelector('.agent-tool-card--error')).not.toBeNull();
    expect(container.querySelector('.agent-tool-card-status--error')?.textContent).toBe('⚠');
    // 默认折叠——展开后错误原文可读（失败可见性）。
    expect(container.querySelector('.agent-tool-card-output')).toBeNull();
    fireEvent.click(container.querySelector('.agent-tool-card-header') as HTMLElement);
    expect(container.querySelector('.agent-tool-card-output')?.textContent).toContain('Unknown tool: write_chapter');
  });

  it('成功输出 → 正常态（✓ 无错误类）', () => {
    const { container } = render(
      <AgentToolCard result={{ toolName: 'write_chapter', output: '第一章草稿完成，字数 2800' }} />,
    );
    expect(container.querySelector('.agent-tool-card--error')).toBeNull();
    expect(container.querySelector('.agent-tool-card-status')?.textContent).toBe('✓');
  });
});

describe('渲染路由（AgentMessageItem WRITE_TOOLS 分支，F18 修复位）', () => {
  it('auto 档失败 write_chapter → 工具卡失败态，不再「✓ 已应用」误导壳', () => {
    const { container } = render(
      <AgentMessages messages={[BRIDGE_FAILED_WRITE_CHAPTER]} loading={false} error={null} />,
    );
    // 失败态：AgentToolCard 错误卡在场。
    expect(container.querySelector('.agent-tool-card--error')).not.toBeNull();
    expect(container.querySelector('.agent-tool-card-status--error')?.textContent).toBe('⚠');
    // 不再成功壳：DiffCard 整卡缺席，「已应用」文案全树不出现。
    expect(container.querySelector('.agent-diff-card')).toBeNull();
    expect(container.textContent).not.toContain('已应用');
  });

  it('suggest 档失败 rewrite_passage → 工具卡失败态，不再「✓ 已处理」误导壳', () => {
    useAppStore.setState({ agentMode: 'suggest' } as any);
    const failedPassage = msg({
      id: 't-passage-fail',
      role: 'tool',
      toolResults: [
        { toolCallId: 'tc-pf', toolName: 'rewrite_passage', output: 'Error: 定位失败：quote 未命中' },
      ],
    });
    const { container } = render(
      <AgentMessages messages={[failedPassage]} loading={false} error={null} />,
    );
    expect(container.querySelector('.agent-tool-card--error')).not.toBeNull();
    expect(container.querySelector('.agent-diff-card')).toBeNull();
    expect(container.textContent).not.toContain('已处理');
  });

  it('auto 档成功 write_chapter（field_patch）→ 照旧 DiffCard「✓ 已应用」（零回归）', () => {
    const success = msg({
      id: 't-ok',
      role: 'tool',
      toolResults: [
        {
          toolCallId: 'tc-ok',
          toolName: 'write_chapter',
          output: '第一章已完成',
          metadata: { type: 'field_patch', field: 'chapter_candidate', action: 'set', data: {} },
        },
      ],
    });
    const { container } = render(
      <AgentMessages messages={[success]} loading={false} error={null} />,
    );
    expect(container.querySelector('.agent-diff-card')).not.toBeNull();
    expect(container.querySelector('.agent-diff-card-status')?.textContent).toContain('已应用');
    expect(container.querySelector('.agent-tool-card--error')).toBeNull();
  });

  it('正文含「失败」词的成功写作产出不误判（前缀判据收窄的防误路由面）', () => {
    const proseSuccess = msg({
      id: 't-prose',
      role: 'tool',
      toolResults: [
        {
          toolCallId: 'tc-prose',
          toolName: 'write_chapter',
          output: '本章完成：主角计划失败了，但读者预期已反转',
          metadata: { type: 'field_patch', field: 'chapter_candidate', action: 'set', data: {} },
        },
      ],
    });
    const { container } = render(
      <AgentMessages messages={[proseSuccess]} loading={false} error={null} />,
    );
    // 中缀「失败」不触发失败路由——成功形照旧 DiffCard（suggest 审阅流不受词面污染）。
    expect(container.querySelector('.agent-tool-card--error')).toBeNull();
    expect(container.querySelector('.agent-diff-card')).not.toBeNull();
  });
});
