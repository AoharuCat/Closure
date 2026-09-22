import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStreamEvent } from '../src/types';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 09-21-subagent-bg-decouple W2：结果送达三通道（design §3）。
//
// 覆盖：wake 空闲即唤醒（合成事件触发 leader 汇报轮）/ 在跑排队 + run 终态 flush 串行（排队期间
// 不打断在途轮）/ 溢出 coalesce（CR 反哺 09-22 ①：不降级最旧——最久等待者最先被服务，零牺牲）/
// 幂等 dedupeKey（即时 + 排队两路标记前置）/ chain drop 语义经泛化入口字节级保持 / 摘要段三态防御
// + claim 消失 + 溢出行 / bg-update 载荷形态（silent/aborted 不唤醒但事件照发）。
// chain 形态全量回归锚 = leader-chain-completed-notify.test.ts（零改动零红即锚）。
// ─────────────────────────────────────────────────────────────────────────────

type ProviderGenerate = typeof import('../src/provider/ipc-provider').generate;

describe('bg 结果送达（09-21-subagent-bg-decouple W2）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-bg-notify-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('renderBgCompletedEventMessage / 聚合渲染：指令段 + 事实段逐条投影（纯函数锚点）', async () => {
    const { renderBgCompletedEventMessage, renderBgCompletedAggregateEventMessage } = await import(
      '../src/runtime/workflow'
    );

    const ok = renderBgCompletedEventMessage({
      taskId: 'bg_t1',
      role: 'researcher',
      childSessionId: 'child-1',
      digest: '查证某设定的出处',
    });
    expect(ok).toContain('[后台任务完成事件 · 系统回注]');
    expect(ok).toContain('bg_task_result(taskId="bg_t1")');
    expect(ok).toContain('researcher（taskId: bg_t1）');
    expect(ok).toContain('查证某设定的出处');
    expect(ok).not.toContain('结果状态');
    expect(ok).toContain('present_result');

    const failed = renderBgCompletedEventMessage({
      taskId: 'bg_t2',
      role: 'researcher',
      childSessionId: 'child-2',
      digest: '拆书分析',
      error: '模型超时',
    });
    expect(failed).toContain('失败——模型超时');

    // 折行规整：换行折叠单行。无 200 字截断（CR-18 死码删除——源头 promptDigest 已 120 帽），
    // 长 digest 全量保留不省略。
    const messy = renderBgCompletedEventMessage({
      taskId: 'bg_t3',
      role: 'r',
      childSessionId: 'c',
      digest: `${'很'.repeat(150)}\n\n${'长'.repeat(150)}`,
    });
    expect(messy).not.toContain('很\n');
    expect(messy).toContain(`${'很'.repeat(150)} ${'长'.repeat(150)}`);

    const aggregate = renderBgCompletedAggregateEventMessage([
      { taskId: 'bg_a1', role: 'researcher', childSessionId: 'c1', digest: '任务一' },
      { taskId: 'bg_a2', role: 'writer', childSessionId: 'c2', digest: '任务二', error: '超时' },
    ]);
    expect(aggregate).toContain('共 2 条合并');
    expect(aggregate).toContain('bg_a1');
    expect(aggregate).toContain('bg_a2');
    expect(aggregate).toContain('（失败——超时）');
    expect(aggregate).toContain('bg_tasks_status');
  });

  it('wake 空闲即唤醒：子完成即合成事件触发 leader 汇报轮（kind 盖章 + 事件即 user 侧输入）+ bg-update 载荷', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      opts?.onDelta?.({ type: 'text', delta: 'x' });
      return { content: '汇报：后台研究完成了', finishReason: 'stop' };
    });
    const runtimeEvents: Array<{ sessionId: string; event: RuntimeStreamEvent }> = [];
    const runtime = createWorkflowRuntime({
      generate,
      onRuntimeEvent: (sessionId, event) => runtimeEvents.push({ sessionId, event }),
    });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    runtime.runSubagentBackground(parent.id, 'researcher', '查证某设定的出处', { notify: 'wake' });

    // 子（1 次）+ wake 回注轮（第 2 次）。
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(2);
    });

    // bg_completed_event 消息落 leader 会话流（kind 盖章可审计——供检视图/历史）。
    const messages = runtime.getSession(parent.id)!.messages;
    const eventMsg = messages.find((m) => m.role === 'user' && m.kind === 'bg_completed_event');
    expect(eventMsg).toBeDefined();
    expect(eventMsg!.content).toContain('[后台任务完成事件 · 系统回注]');
    expect(eventMsg!.content).toContain('查证某设定的出处');

    // wake 轮 LLM 输入：最后一条非注记 user 侧输入即事件正文。
    const llmMessages = generate.mock.calls[1][0] as Array<{ role: string; kind?: string; content: string }>;
    const lastUser = [...llmMessages].reverse().find((m) => m.role === 'user' && m.kind !== 'session_state_note');
    expect(lastUser!.content).toContain('[后台任务完成事件 · 系统回注]');

    // jsonl 落盘带 kind。
    const { loadMessagesFromFile } = await import('../src/agent/persistence');
    const persisted = loadMessagesFromFile(projectPath, parent.id);
    expect(persisted.find((m) => m.kind === 'bg_completed_event')).toBeDefined();

    // bg-update 事件（终态一次，parent sid 载荷自描述）。
    const bgUpdates = runtimeEvents.filter((e) => e.sessionId === parent.id && e.event.type === 'bg-update');
    expect(bgUpdates).toHaveLength(1);
    const bgUpdateEvent = bgUpdates[0].event;
    if (bgUpdateEvent.type !== 'bg-update') {
      throw new Error('expected bg-update event');
    }
    const registry = getBgTaskRegistry();
    expect(bgUpdateEvent.data).toMatchObject({
      taskId: registry.listByParent(parent.id)[0].taskId,
      role: 'researcher',
      status: 'completed',
      notify: 'wake',
      digest: '查证某设定的出处',
    });
  });

  it('在跑排队 + run 终态 flush：排队期间不打断在途轮；终态后串行唤醒（前一轮 done 再下一轮）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();

    let releaseLeader: () => void = () => {};
    const leaderGate = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    // 挂起判别器 = 消息内容（leader 在途轮的 user 侧输入含「作者消息」）——不用调用序（leader 与子
    // 的 generate 到达序竞态不确定：leader turn 前有多段异步磁盘读，子可能先到）。
    const generate = vi.fn<ProviderGenerate>(async (messages) => {
      const isLeaderTurn = (messages as Array<{ content: string }>).some((m) => m.content.includes('作者消息'));
      if (isLeaderTurn) {
        await leaderGate;
      }
      return { content: '后续轮输出', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    // 在途轮（挂起）：sendMessage 同步段已置 running。
    const leaderTurn = runtime.sendMessage({
      sessionId: parent.id,
      content: '作者消息',
      abortSignal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(runtime.getSession(parent.id)!.status).toBe('running');
    });

    // 在途期间子任务完成（wake）→ 只入队，不唤醒（generate = leader 在途 + 子任务两次，无 wake 轮）。
    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '排队任务', { notify: 'wake' });
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('completed');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(runtime.getSession(parent.id)!.messages.some((m) => m.kind === 'bg_completed_event')).toBe(false);

    // 放行 → leader 轮终态 → flush → wake 轮。
    releaseLeader();
    await leaderTurn;
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(3);
    });

    const messages = runtime.getSession(parent.id)!.messages;
    const eventMsg = messages.find((m) => m.kind === 'bg_completed_event');
    expect(eventMsg).toBeDefined();
    expect(eventMsg!.content).toContain('排队任务');
    // 顺序：事件消息落在 leader 在途轮的 assistant 之后（终态 flush 才回注）。
    const leaderAssistantIdx = messages.findIndex((m) => m.role === 'assistant' && m.content === '后续轮输出');
    const eventIdx = messages.findIndex((m) => m.kind === 'bg_completed_event');
    expect(leaderAssistantIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdx).toBeGreaterThan(leaderAssistantIdx);
  });

  it('溢出 coalesce（CR 反哺 ①）：不降级最旧——最久等待者并入聚合唤醒最先被服务，零牺牲', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();

    let releaseLeader: () => void = () => {};
    const leaderGate = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    // 挂起判别器 = 消息内容（同「在跑排队」测试——调用序竞态不确定）。
    const generate = vi.fn<ProviderGenerate>(async (messages) => {
      const isLeaderTurn = (messages as Array<{ content: string }>).some((m) => m.content.includes('作者消息'));
      if (isLeaderTurn) {
        await leaderGate;
      }
      return { content: 'x', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const leaderTurn = runtime.sendMessage({
      sessionId: parent.id,
      content: '作者消息',
      abortSignal: new AbortController().signal,
    });

    // 依序派 6 个 wake 任务（逐个等完成 → 入队序确定 t1..t6）。队满 5 时第 6 个触发 coalesce：
    // [agg(t1-t4), t5] + t6 → flush 序 = 聚合（含最老的 t1-t4）→ t5 → t6。
    const taskIds: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const handle = runtime.runSubagentBackground(parent.id, 'researcher', `批量任务 ${i}`, { notify: 'wake' });
      taskIds.push(handle.taskId);
      await vi.waitFor(() => {
        expect(registry.get(handle.taskId)?.status).toBe('completed');
      });
    }

    releaseLeader();
    await leaderTurn;

    // 3 轮唤醒：聚合（4 条合并）+ t5 + t6。
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1 + 6 + 3);
    });

    const eventMsgs = runtime.getSession(parent.id)!.messages.filter((m) => m.kind === 'bg_completed_event');
    expect(eventMsgs).toHaveLength(3);

    const first = eventMsgs[0].content;
    expect(first).toContain('共 4 条合并');
    for (const taskId of taskIds.slice(0, 4)) {
      expect(first).toContain(taskId); // 最久的 4 条都在唤醒面（零牺牲——合并而非降级丢弃）
    }
    expect(eventMsgs[1].content).toContain(taskIds[4]);
    expect(eventMsgs[2].content).toContain(taskIds[5]);

    // 全量守恒：6 条结果的 taskId 都出现在唤醒消息里。
    const all = eventMsgs.map((m) => m.content).join('\n');
    for (const taskId of taskIds) {
      expect(all).toContain(taskId);
    }
  });

  it('幂等 dedupeKey：即时路（标记前置，重复 no-op）+ 排队路（入队即标记，flush 恰一轮）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { updateStatus } = await import('../src/agent/session');
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: 'x', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const info = {
      taskId: 'bg_idem-1',
      role: 'researcher',
      childSessionId: 'child-idem',
      digest: '幂等任务',
    };

    // 即时路：空闲即时回注；同 dedupeKey 二次 → no-op（generate 不再调用）。
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'bg_completed_event',
        userContent: `[后台任务完成事件] ${info.taskId}`,
        dedupeKey: info.taskId,
        bgInfo: info,
      }),
    ).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
    });
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'bg_completed_event',
        userContent: `[后台任务完成事件] ${info.taskId}`,
        dedupeKey: info.taskId,
        bgInfo: info,
      }),
    ).resolves.toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);

    // 排队路：running 时入队（返 true 已接受）；同 key 二次入队被幂等拦；终态 flush 恰一轮。
    updateStatus(parent.id, 'running');
    const info2 = { ...info, taskId: 'bg_idem-2', childSessionId: 'child-idem-2' };
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'bg_completed_event',
        userContent: `[后台任务完成事件] ${info2.taskId}`,
        dedupeKey: info2.taskId,
        bgInfo: info2,
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'bg_completed_event',
        userContent: `[后台任务完成事件] ${info2.taskId}`,
        dedupeKey: info2.taskId,
        bgInfo: info2,
      }),
    ).resolves.toBe(false);
    updateStatus(parent.id, 'idle');
    await runtime.sendMessage({ sessionId: parent.id, content: 'hi', abortSignal: new AbortController().signal });
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(2);
    });
    const eventMsgs = runtime.getSession(parent.id)!.messages.filter((m) => m.kind === 'bg_completed_event');
    expect(eventMsgs).toHaveLength(2); // bg_idem-1（即时）+ bg_idem-2（排队 flush 恰一次）
    expect(eventMsgs.filter((m) => m.content.includes('bg_idem-2'))).toHaveLength(1);
  });

  it('chain drop 语义经泛化入口字节级保持：running → 丢弃不排队；空闲后同 runId 可回注', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { updateStatus } = await import('../src/agent/session');
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: 'x', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    updateStatus(parent.id, 'running');
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'chain_completed_event',
        userContent: '[链完成事件 · 系统回注] 测试',
        dedupeKey: 'run-drop-1',
      }),
    ).resolves.toBe(false);
    expect(generate).not.toHaveBeenCalled();
    // 丢弃不占幂等标记——空闲后同 runId 仍可回注（旧语义逐条保持）。
    updateStatus(parent.id, 'idle');
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'chain_completed_event',
        userContent: '[链完成事件 · 系统回注] 测试',
        dedupeKey: 'run-drop-1',
      }),
    ).resolves.toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('摘要段：三态防御（零待取段缺省）+ 完成后列出 + claim 消失 + 溢出行「最早 3 条 / 共 N」', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const { bgTaskResultTool } = await import('../src/tool/bg-task-tools');
    const registry = getBgTaskRegistry();
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: '回复', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const ctx = { sessionId: parent.id, projectPath, abort: new AbortController().signal };
    const send = () => runtime.sendMessage({ sessionId: parent.id, content: '继续', abortSignal: new AbortController().signal });
    const lastNote = () => {
      const messages = runtime.getSession(parent.id)!.messages;
      return [...messages].reverse().find((m) => m.kind === 'session_state_note')!;
    };

    // 三态①：零待取 → 段缺省。
    await send();
    expect(lastNote().content).not.toContain('后台任务待领取');

    // toast 任务完成 → 下一 turn 注入段列出。
    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '查证某设定的出处');
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('completed');
    });
    await send();
    let note = lastNote().content;
    expect(note).toContain('后台任务待领取');
    expect(note).toContain(handle.taskId);
    expect(note).toContain('bg_task_result');

    // claim（bg_task_result 调用 = 领取记账）→ 再下 turn 该结果从段内消失。
    await bgTaskResultTool.execute({ taskId: handle.taskId }, ctx);
    expect(registry.get(handle.taskId)?.claimed).toBe(true);
    await send();
    note = lastNote().content;
    expect(note).not.toContain(handle.taskId);
    expect(note).not.toContain('后台任务待领取');

    // 溢出行：4 条待取 → 列最早 3 条 + 「共 4 条」，第 4 条不占段（bg_tasks_status 指路）。
    const overflowIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const h = runtime.runSubagentBackground(parent.id, 'researcher', `溢出任务 ${i}`);
      overflowIds.push(h.taskId);
      await vi.waitFor(() => {
        expect(registry.get(h.taskId)?.status).toBe('completed');
      });
    }
    await send();
    note = lastNote().content;
    expect(note).toContain('后台任务待领取');
    expect(note).toContain('共 4 条');
    expect(note).toContain('bg_tasks_status');
    for (const taskId of overflowIds.slice(0, 3)) {
      expect(note).toContain(taskId);
    }
    expect(note).not.toContain(overflowIds[3]);
  });

  it('silent / aborted：不唤醒 leader（无 bg_completed_event 轮），bg-update 事件照发且 notify/status 如实', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();

    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, abortSignal) => {
      // 第 1 次（silent 子任务）立即完成；第 2 次（wake 子任务）挂起直到 abort。
      if (generate.mock.calls.length === 1) {
        return { content: '后台产出', finishReason: 'stop' };
      }
      await new Promise<never>((_resolve, reject) => {
        if (abortSignal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return { content: 'unreachable', finishReason: 'stop' };
    });
    const runtimeEvents: Array<{ sessionId: string; event: RuntimeStreamEvent }> = [];
    const runtime = createWorkflowRuntime({
      generate,
      onRuntimeEvent: (sessionId, event) => runtimeEvents.push({ sessionId, event }),
    });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    // silent：完成但零唤醒（generate 只有子任务 1 次）。
    const silent = runtime.runSubagentBackground(parent.id, 'researcher', '静默任务', { notify: 'silent' });
    await vi.waitFor(() => {
      expect(registry.get(silent.taskId)?.status).toBe('completed');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(runtime.getSession(parent.id)!.messages.some((m) => m.kind === 'bg_completed_event')).toBe(false);

    // aborted：子已进入 generate（挂起中）再取消 → abort 打断挂调用 → 终态如实，无唤醒。
    // （取消先于 generate 会命中 runLoop 入口 abort 短路——那也是合法 abort 路径，但不覆盖
    // 「挂调用被打断」面，故先等子到 generate。）
    const cancellable = runtime.runSubagentBackground(parent.id, 'researcher', '取消任务', { notify: 'wake' });
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(2);
    });
    expect(registry.cancel(cancellable.taskId)).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(registry.get(cancellable.taskId)?.status).toBe('aborted');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(generate).toHaveBeenCalledTimes(2); // 两个子任务各自一次，无 wake 回注轮

    // bg-update 两态都在（parent sid）：silentcompleted + wake-aborted，notify/status 如实。
    const bgUpdates = runtimeEvents.filter((e) => e.sessionId === parent.id && e.event.type === 'bg-update');
    expect(bgUpdates).toHaveLength(2);
    const shapes = bgUpdates.map((e) => (e.event.type === 'bg-update' ? e.event.data : null));
    expect(shapes).toContainEqual(expect.objectContaining({ taskId: silent.taskId, status: 'completed', notify: 'silent' }));
    expect(shapes).toContainEqual(
      expect.objectContaining({ taskId: cancellable.taskId, status: 'aborted', notify: 'wake' }),
    );
    expect(runtime.getSession(parent.id)!.messages.some((m) => m.kind === 'bg_completed_event')).toBe(false);
  });

  it('CR-1 drain at-least-once：回抱失败重入队尾不丢，成功才出队确认（FIFO 服务序保持）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();

    let releaseLeader: () => void = () => {};
    const leaderGate = new Promise<void>((resolve) => {
      releaseLeader = resolve;
    });
    let wakeAttempts = 0;
    const generate = vi.fn<ProviderGenerate>(async (messages) => {
      const contents = (messages as Array<{ content: string }>).map((m) => m.content);
      // 判别序：先「系统回注」（wake 轮——其历史也含早前作者消息，序错会误判 leader 轮），
      // 再「作者消息」（真实 leader 在途轮），其余 = 子任务轮。
      if (contents.some((c) => c.includes('系统回注'))) {
        wakeAttempts++;
        // 首个 wake 尝试（队头 t1）瞬时失败 → 回队尾；其后各尝试成功。
        if (wakeAttempts === 1) throw new Error('transient wake failure');
        return { content: '汇报', finishReason: 'stop' };
      }
      if (contents.some((c) => c.includes('作者消息'))) {
        await leaderGate; // leader 在途轮挂起
        return { content: '后续轮输出', finishReason: 'stop' };
      }
      return { content: '子产出', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const leaderTurn = runtime.sendMessage({
      sessionId: parent.id,
      content: '作者消息',
      abortSignal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(runtime.getSession(parent.id)!.status).toBe('running');
    });

    // 在途期间两个 wake 任务依序完成 → 排队 [t1, t2]。
    const t1 = runtime.runSubagentBackground(parent.id, 'researcher', '排队任务 甲', { notify: 'wake' });
    await vi.waitFor(() => expect(registry.get(t1.taskId)?.status).toBe('completed'));
    const t2 = runtime.runSubagentBackground(parent.id, 'researcher', '排队任务 乙', { notify: 'wake' });
    await vi.waitFor(() => expect(registry.get(t2.taskId)?.status).toBe('completed'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakeAttempts).toBe(0); // 排队期间零打断

    // 放行 → flush：t1 尝试失败（重入队尾）→ t2 先服务 → t1 重试成功。
    releaseLeader();
    await leaderTurn;
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1 + 2 + 3); // leader 轮 + 两子 + wake 尝试 3 次
    });

    const eventMsgs = runtime.getSession(parent.id)!.messages.filter((m) => m.kind === 'bg_completed_event');
    // 两条任务结果都不丢（at-least-once）。失败尝试的合成事件消息已入流（streamMessage 先
    // append 后跑），重试再 append 一次——同任务事件消息出现两次是 at-least-once 重试的既定
    // 代价（第二条 assistant 汇报对已领取结果幂等，无丢失面；持久层无「撤回已 append 消息」
    // 面，删重属过度设计）。
    expect(eventMsgs).toHaveLength(3);
    expect(eventMsgs[0]!.content).toContain(t1.taskId); // 首次尝试（失败——事件消息已 append）
    expect(eventMsgs[1]!.content).toContain(t2.taskId); // 失败重入队尾 → t2 先被服务
    expect(eventMsgs[2]!.content).toContain(t1.taskId); // t1 重试成功（成功才出队确认）
    expect(wakeAttempts).toBe(3);
  });

  it('CR-1 空闲竞窗：报告轮撞 SessionRunAlreadyActiveError → 认事件回队（幂等标记防双发），下次 flush 消化', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { RunStateStore, SessionRunAlreadyActiveError } = await import('../src/runtime/runState');
    const store = new RunStateStore();
    const origBeginRun = store.beginRun.bind(store);
    let busyRace = true;
    // 模拟竞窗：守卫检查后、streamMessage beginRun 前另一轮抢跑（快照无 running → 守卫放行，
    // beginRun 撞 active）。
    (store as unknown as { beginRun: typeof store.beginRun }).beginRun = (sessionId: string, signal?: AbortSignal) => {
      if (busyRace) throw new SessionRunAlreadyActiveError(sessionId);
      return origBeginRun(sessionId, signal);
    };
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: '汇报', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate, runState: store });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const info = { taskId: 'bg_race-1', role: 'researcher', childSessionId: 'child-race', digest: '竞窗任务' };

    // 空闲路撞 busy：返回 false（报告轮未成），事件回队（不丢）。
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'bg_completed_event',
        userContent: '[后台任务完成事件 · 系统回注] 竞窗',
        dedupeKey: info.taskId,
        bgInfo: info,
      }),
    ).resolves.toBe(false);
    // 回队后补的 flush：仍 busy → 单轮尝试全败即停（条目留队），generate 未被触达。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(generate).not.toHaveBeenCalled();

    // 同 dedupeKey 二次 notifyLeaderEvent → 幂等标记拦截（无双发面——回队走直入不经标记检查）。
    await expect(
      runtime.notifyLeaderEvent(parent.id, {
        kind: 'bg_completed_event',
        userContent: '[后台任务完成事件 · 系统回注] 竞窗',
        dedupeKey: info.taskId,
        bgInfo: info,
      }),
    ).resolves.toBe(false);

    // 解除 busy → 下一次 run 终态 flush 消化队列 → 唤醒轮跑成（at-least-once 兑现）。
    busyRace = false;
    await runtime.sendMessage({ sessionId: parent.id, content: '触发 flush', abortSignal: new AbortController().signal });
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(2); // 触发轮 + wake 唤醒轮
    });
    expect(runtime.getSession(parent.id)!.messages.some((m) => m.kind === 'bg_completed_event')).toBe(true);
  });
});
