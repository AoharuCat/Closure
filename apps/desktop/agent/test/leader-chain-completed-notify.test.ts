import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #93 追加拍板（2026-08-28）：resume 续链完成 → leader 对话总结。
// notifyLeaderChainCompleted：向 leader 会话追加 chain_completed_event 系统事件消息
// （jsonl 落盘带 kind 可审计）并以该事件为 user 侧输入触发一轮 leader LLM 调用；
// 守卫矩阵（无会话 / child 会话 / 同 runId 幂等 / running 丢弃）+ 报告轮失败不抛。
// ─────────────────────────────────────────────────────────────────────────────

describe('dogfood R2 #93 — notifyLeaderChainCompleted（链完成事件回注 leader）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-chain-notify-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  const PAYLOAD = {
    runId: 'run-93-1',
    chapterTitle: '第二章 B 城',
    chapterId: 'ch_001',
    wordCount: 2800,
    routeDecision: 'accept_as_truth',
    routeReason: '正文升级',
    reviewVerdict: 'pass',
    acceptPendingReview: true,
  };

  it('追加 chain_completed_event 消息（jsonl 带 kind）+ 触发一轮 leader LLM 调用（事件即 user 侧输入）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async () => ({ content: '本章已完成，向你汇报……', finishReason: 'stop' }));
    const onRuntimeEvent = vi.fn();
    const runtime = createWorkflowRuntime({ generate, onRuntimeEvent });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'suggest' });

    const ok = await runtime.notifyLeaderChainCompleted(session.id, PAYLOAD);
    expect(ok).toBe(true);

    // 消息面：user 事件消息（kind 盖章 + 指令/事实段）+ assistant 回复。
    const messages = runtime.getSession(session.id)!.messages;
    const eventMsg = messages.find((m) => m.role === 'user' && m.kind === 'chain_completed_event');
    expect(eventMsg).toBeDefined();
    expect(eventMsg!.content).toContain('[链完成事件 · 系统回注]');
    expect(eventMsg!.content).toContain('第二章 B 城');
    expect(eventMsg!.content).toContain('2800');
    expect(eventMsg!.content).toContain('accept_as_truth');
    expect(eventMsg!.content).toContain('待作者在审核卡确认');
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('向你汇报'))).toBe(true);

    // 触发一轮：generate 收到的最后一条 user 侧输入即事件正文（system 稳定化后 turn 尾
    // 还有状态注记——同为 user role，按 kind 排除后取真正的作者侧输入）。
    expect(generate).toHaveBeenCalledTimes(1);
    const llmMessages = generate.mock.calls[0][0] as Array<{ role: string; kind?: string; content: string }>;
    const lastUser = [...llmMessages].reverse().find((m) => m.role === 'user' && m.kind !== 'session_state_note');
    expect(lastUser!.content).toContain('[链完成事件 · 系统回注]');

    // jsonl 落盘带 kind（可审计——非伪造用户消息）。
    const { loadMessagesFromFile } = await import('../src/agent/persistence');
    const persisted = loadMessagesFromFile(projectPath, session.id);
    expect(persisted.find((m) => m.role === 'user')?.kind).toBe('chain_completed_event');

    // 事件流经 onRuntimeEvent 广播（shell 接线 agent:stream-event 的 seam——UI 零改呈现）。
    const types = onRuntimeEvent.mock.calls.map(([, ev]) => (ev as { type: string }).type);
    expect(types).toContain('assistant');
    expect(types).toContain('done');
  });

  it('幂等：同 runId 二次回注 no-op；不同 runId（新一章）再回注照常', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async () => ({ content: '汇报', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'suggest' });

    expect(await runtime.notifyLeaderChainCompleted(session.id, PAYLOAD)).toBe(true);
    const afterFirst = runtime.getSession(session.id)!.messages.length;
    expect(generate).toHaveBeenCalledTimes(1);

    // 同 runId → no-op（无新消息、无新 LLM 调用）。
    expect(await runtime.notifyLeaderChainCompleted(session.id, { ...PAYLOAD })).toBe(false);
    expect(runtime.getSession(session.id)!.messages.length).toBe(afterFirst);
    expect(generate).toHaveBeenCalledTimes(1);

    // 不同 runId（新一章完成）→ 新一轮回注。
    expect(await runtime.notifyLeaderChainCompleted(session.id, { ...PAYLOAD, runId: 'run-93-2' })).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    const eventMsgs = runtime.getSession(session.id)!.messages.filter((m) => m.kind === 'chain_completed_event');
    expect(eventMsgs.length).toBe(2);
  });

  it('会话不存在 → 静默 no-op（不抛）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async () => ({ content: 'x', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });

    await expect(runtime.notifyLeaderChainCompleted('no-such-session', PAYLOAD)).resolves.toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it('sessionRole=child（子代理会话非 leader 对话）→ no-op', async () => {
    const { createSession } = await import('../src/agent/session');
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async () => ({ content: 'x', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const child = createSession({ agentName: 'sub-role', projectPath, sessionRole: 'child' });

    await expect(runtime.notifyLeaderChainCompleted(child.id, PAYLOAD)).resolves.toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it('leader 正在跑（running）→ 丢弃（设计拍板：不排队）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { updateStatus } = await import('../src/agent/session');
    const generate = vi.fn(async () => ({ content: 'x', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'suggest' });
    updateStatus(session.id, 'running');

    await expect(runtime.notifyLeaderChainCompleted(session.id, PAYLOAD)).resolves.toBe(false);
    expect(generate).not.toHaveBeenCalled();
    // 丢弃不占用幂等标记——leader 空闲后同 runId 重发（如用户再触发）仍可回注。
    updateStatus(session.id, 'idle');
    expect(await runtime.notifyLeaderChainCompleted(session.id, PAYLOAD)).toBe(true);
  });

  it('报告轮失败（LLM 抛错）→ 返 false 不抛；至多一次（同 runId 不重试）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async () => {
      throw new Error('llm down');
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'suggest' });

    await expect(runtime.notifyLeaderChainCompleted(session.id, PAYLOAD)).resolves.toBe(false);
    // 事件消息已回注（落历史可读），报告轮失败由 session 状态记录。
    expect(runtime.getSession(session.id)!.messages.some((m) => m.kind === 'chain_completed_event')).toBe(true);
    expect(runtime.getSession(session.id)!.status).toBe('error');
    // 同 runId 重发 → 幂等 no-op（标记在尝试前置）。
    await expect(runtime.notifyLeaderChainCompleted(session.id, PAYLOAD)).resolves.toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('renderChainCompletedEventMessage：全量事实逐行投影 / 最小 payload 省略可选行 / errors 如实转达', async () => {
    const { renderChainCompletedEventMessage } = await import('../src/runtime/workflow');

    const full = renderChainCompletedEventMessage({
      runId: 'r1',
      chapterTitle: '第二章 B 城',
      chapterId: 'ch_001',
      wordCount: 2800,
      routeDecision: 'accept_as_truth',
      routeReason: '正文升级',
      reviewVerdict: 'pass',
      chapterPersisted: true,
      storySyncPatchCount: 3,
      storySyncLandedFields: ['asset_cards', 'world_setting'],
      errors: ['minor drift'],
    });
    expect(full).toContain('第二章 B 城（ch_001）');
    expect(full).toContain('字数：2800');
    expect(full).toContain('accept_as_truth——正文升级');
    expect(full).toContain('审读结论：pass');
    expect(full).toContain('已落盘 chapters/');
    expect(full).toContain('3 条设定补丁已自动落盘（asset_cards、world_setting）');
    expect(full).toContain('minor drift');
    expect(full).toContain('present_result');

    // 最小 payload（无可选字段）→ 事实段只有章节行缺省也成立（仅指令段 + 空事实段不炸）。
    const minimal = renderChainCompletedEventMessage({ runId: 'r2' });
    expect(minimal).toContain('[链完成事件 · 系统回注]');
    expect(minimal).not.toContain('字数：');
    expect(minimal).not.toContain('路由判定：');
  });

  it('W2 完成事实扩展：arcBeatCount 提取统计 / derivationStale 重提取指路 / loopUnconverged 环未收敛上报', async () => {
    const { renderChainCompletedEventMessage } = await import('../src/runtime/workflow');

    const text = renderChainCompletedEventMessage({
      runId: 'r3',
      arcBeatCount: 2,
      derivationStale: true,
      loopUnconverged: true,
    });
    expect(text).toContain('弧节拍：本章声明 2 条');
    expect(text).toContain('衍生状态待重提取');
    expect(text).toContain('re-extract');
    expect(text).toContain('环未收敛');

    // 缺省不添行（零噪音）。终弃（chapterAbandoned）不设 payload 字段——终弃链非 completed
    // 终态（清快照），leader 侧经 write_chapter 工具结果行同步上报，完成事件车道结构性不可达。
    const clean = renderChainCompletedEventMessage({ runId: 'r4' });
    expect(clean).not.toContain('弧节拍');
    expect(clean).not.toContain('衍生状态');
    expect(clean).not.toContain('环未收敛');
  });
});
