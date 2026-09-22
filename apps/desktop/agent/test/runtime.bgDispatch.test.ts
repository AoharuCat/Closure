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
// 09-21-subagent-bg-decouple W1：dispatchBackground / runSubagentBackground 集成测试
//（design §1.2 / §2 / §5）。
//
// 覆盖：派发立返 + 子跑完 registry 终态 / evict 豁免（对照同步路径回归锚）/ child 消息双写落盘
//（D9：child 自身 jsonl）/ 事件泵（child 事件以自身 sid 上 onRuntimeEvent，不依赖 leader turn 装配）
// / abort 不透传（leader 侧信号中止 ≠ 后台子 agent 死）+ cancel 通道与 abort-run 通道皆可停 /
// 删除 leader 会话级联杀 / spawnDepth 深度闸后台路径照用 / spawn_agent_bg 工具立返 + 帽拒绝文案。
// 记账层（帽/LRU/对账/disk 三态）见 bgTasks.test.ts。
// ─────────────────────────────────────────────────────────────────────────────

type ProviderGenerate = typeof import('../src/provider/ipc-provider').generate;

/** 生成挂起直到 abort 的 generate（长任务模拟——cancel/abort 路径的驱动器）。 */
function hangingGenerate(): ReturnType<typeof vi.fn<ProviderGenerate>> {
  return vi.fn<ProviderGenerate>(async (_messages, _system, _tools, abortSignal) => {
    await new Promise<void>((_resolve, reject) => {
      if (abortSignal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
    return { content: 'unreachable', finishReason: 'stop' };
  });
}

describe('background dispatch（09-21-subagent-bg-decouple W1）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-bg-dispatch-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('派发立返 + 子跑完 registry 终态 + evict 豁免 + child 双写落盘 + 事件泵 + leader 隔离', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const { loadMessagesFromFile } = await import('../src/agent/persistence');

    const generate = vi.fn<ProviderGenerate>(async (_messages, _system, _tools, _abortSignal, opts) => {
      opts?.onDelta?.({ type: 'text', delta: '后台产出' });
      return { content: '后台产出', finishReason: 'stop' };
    });
    const runtimeEvents: Array<{ sessionId: string; event: RuntimeStreamEvent }> = [];
    const runtime = createWorkflowRuntime({
      generate,
      onRuntimeEvent: (sessionId, event) => runtimeEvents.push({ sessionId, event }),
    });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const parentMessagesBefore = runtime.getSession(parent.id)!.messages.length;

    // 立返：同步拿到句柄（不等首 LLM 帧——AC「工具 <1s 返句柄」的运行时面）。
    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '查证某设定的出处');
    expect(handle.taskId).toMatch(/^bg_/);
    expect(handle).toMatchObject({ childSessionId: expect.any(String), role: 'researcher', status: 'running' });

    const registry = getBgTaskRegistry();
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('completed');
    });

    // registry 终态：结果 content（上下文隔离——只 content）+ 归因字段。
    expect(registry.get(handle.taskId)).toMatchObject({
      parentSessionId: parent.id,
      childSessionId: handle.childSessionId,
      role: 'researcher',
      promptDigest: '查证某设定的出处',
      notify: 'toast',
    });
    expect(registry.get(handle.taskId)?.result?.content).toBe('后台产出');

    // D2：子 run 生命周期走自身 sessionId（runState 快照终态）。
    expect(runtime.getRunState(handle.childSessionId)?.status).toBe('completed');

    // evict 豁免：完成后子会话仍可从内存解析（检视/结果引用前提）。
    expect(runtime.getSession(handle.childSessionId)).toBeDefined();
    expect(runtime.getSession(handle.childSessionId)?.sessionRole).toBe('child');

    // D9 双写：child 自身 jsonl 有 user prompt + assistant 终帧（重启可追 / 检视 fetch 对账前提）。
    const childMessages = loadMessagesFromFile(projectPath, handle.childSessionId);
    expect(childMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(childMessages[0].content).toContain('查证某设定的出处');
    expect(childMessages[1].content).toBe('后台产出');

    // 事件泵（design §5）：child 事件以自身 child sid 上 onRuntimeEvent（shell 广播补 projectPath）；
    // started 起点信号 + assistant 终帧 + delta 增量全在。
    const childEnvelopes = runtimeEvents.filter((e) => e.sessionId === handle.childSessionId);
    expect(childEnvelopes.length).toBeGreaterThan(0);
    const childEvents = childEnvelopes.filter((e) => e.event.type === 'child');
    expect(
      childEvents.some((e) => e.event.type === 'child' && e.event.data.event.type === 'started'),
    ).toBe(true);
    expect(
      childEvents.some((e) => e.event.type === 'child' && e.event.data.event.type === 'delta'),
    ).toBe(true);
    expect(
      childEvents.some((e) => e.event.type === 'child' && e.event.data.event.type === 'assistant'),
    ).toBe(true);

    // leader 隔离：父会话消息流零污染。
    const parentSession = runtime.getSession(parent.id)!;
    expect(parentSession.messages.length).toBe(parentMessagesBefore);
    expect(parentSession.messages.some((m) => m.content === '后台产出')).toBe(false);
  });

  it('abort 不透传：外部（leader 侧）信号中止 ≠ 后台子 agent 死；cancel / abort-run 双通道可停', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    const runtime = createWorkflowRuntime({ generate: hangingGenerate() });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '长时间任务');

    // 「leader turn 中止」模拟：与本派发无关的外部信号 abort——后台子 agent 照跑（状态不被动）。
    const leaderLikeAbort = new AbortController();
    leaderLikeAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registry.get(handle.taskId)?.status).toBe('running');

    // 通道 ①：bg_task_cancel 机械面（registry.cancel——外部链）。
    expect(registry.cancel(handle.taskId)).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('aborted');
    });
    expect(runtime.getRunState(handle.childSessionId)?.status).toBe('aborted');
    expect(runtime.getSession(handle.childSessionId)?.status).toBe('aborted');
    expect(registry.cancel(handle.taskId)).toEqual({ ok: false, reason: 'already-terminal' });

    // 通道 ②：agent:abort-run 既有通道（store 链——runState.abortRun(childSid)）。
    const handle2 = runtime.runSubagentBackground(parent.id, 'researcher', '第二个长任务');
    expect(runtime.abortRun(handle2.childSessionId)).toBe(true);
    await vi.waitFor(() => {
      expect(registry.get(handle2.taskId)?.status).toBe('aborted');
    });
  });

  it('删除 leader 会话级联杀：deleteSession → 其后台子 agent 全部 abort（design §2）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    const runtime = createWorkflowRuntime({ generate: hangingGenerate() });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '长任务');
    expect(registry.get(handle.taskId)?.status).toBe('running');

    runtime.deleteSession(parent.id);
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('aborted');
    });
  });

  it('CR-5：直删子会话（agent:delete-session 指向 child sid）→ 其后台任务按 childSessionId 匹配 abort', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    const runtime = createWorkflowRuntime({ generate: hangingGenerate() });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '子会话被直删的任务');
    expect(registry.get(handle.taskId)?.status).toBe('running');

    // 删除目标 = 子会话自身（parentSessionId 匹配不到——childSessionId 匹配面覆盖）。
    runtime.deleteSession(handle.childSessionId);
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('aborted');
    });
  });

  it('AC3 计量归因：3 个并行 bg 子 agent 的 generate 调用各带自身 child sessionId（C3.1 wire request.sessionId 归因行）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();

    // stub generate：三路并行栅栏（全到齐再放行）+ 记录每次调用的 opts.sessionId——C3.1 计量
    // 台账的第二跳（ipc-provider 把 opts.sessionId 落 wire request.sessionId → shell sink 按它
    // 逐行落账），此处断言的就是台账归因键的数据源。
    const seenSessionIds: Array<string | undefined> = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn<ProviderGenerate>(async (_m, _s, _t, _abort, opts) => {
      seenSessionIds.push(opts?.sessionId);
      if (seenSessionIds.length === 3) release();
      await barrier;
      return { content: '并行产出', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const handles = [1, 2, 3].map((i) => runtime.runSubagentBackground(parent.id, 'researcher', `并行任务 ${i}`));
    await vi.waitFor(() => {
      expect(seenSessionIds.length).toBe(3);
    });

    // 三行各自归因：sessionId 互异且与派发句柄的 childSessionId 一一对应（无串号无缺省）。
    expect(new Set(seenSessionIds)).toEqual(new Set(handles.map((h) => h.childSessionId)));

    // 放行收尾（防悬挂 promise 拖尾），等终态。
    release();
    await vi.waitFor(() => {
      expect(handles.every((h) => registry.get(h.taskId)?.status === 'completed')).toBe(true);
    });
  });

  it('spawnDepth 深度闸后台路径照用：超限 → 子 run failed + registry 如实记 error', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const { MAX_SPAWN_DEPTH } = await import('../src/types');
    const registry = getBgTaskRegistry();
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: 'x', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '嵌套超限', {
      spawnDepth: MAX_SPAWN_DEPTH,
    });
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('failed');
    });
    expect(registry.get(handle.taskId)?.error).toContain('Spawn depth');
    expect(runtime.getRunState(handle.childSessionId)?.status).toBe('error');
    // 深度闸在 runChildAgent 入口短路——generate 不应被触达。
    expect(generate).not.toHaveBeenCalled();
  });

  it('同步 dispatch 回归锚：完成即 evict 子会话 + 结果冒泡（bg 的对照面，同步路径零改动）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { createSubagentRuntime } = await import('../src/runtime/subagent');
    const { createPermissionService } = await import('../src/runtime/permission');
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: 'x', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const subagents = createSubagentRuntime({
      runtime,
      narrowPermission: () => createPermissionService(),
    });
    const dispatched = await subagents.dispatch({
      parentSessionId: parent.id,
      role: 'outline-expander',
      prompt: '同步任务',
      complete: async () => ({ content: '同步产出' }),
    });
    expect(dispatched.result).toMatchObject({
      childSessionId: dispatched.session.id,
      role: 'outline-expander',
      content: '同步产出',
      status: 'completed',
    });
    // 同步路径完成即 evict（CR-12 清理语义保留）——与 bg 豁免形成对照钉。
    expect(runtime.getSession(dispatched.session.id)).toBeUndefined();
  });

  it('spawn_agent_bg 工具：立返句柄文案 + 帽拒绝响亮文案（走真 runtime 执行器）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const { spawnAgentBgTool } = await import('../src/tool/spawn_agent_bg');
    const registry = getBgTaskRegistry();
    const runtime = createWorkflowRuntime({ generate: hangingGenerate() });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const ctx = {
      sessionId: parent.id,
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: runtime,
    };

    const handles = [];
    for (let i = 0; i < 3; i++) {
      const result = await spawnAgentBgTool.execute(
        { agentType: 'researcher', prompt: `任务 ${i}` },
        ctx,
      );
      expect(result.metadata).toMatchObject({ status: 'running', role: 'researcher' });
      expect(String(result.output)).toContain('taskId:');
      expect(String(result.output)).toContain('bg_task_result');
      handles.push(result.metadata!.taskId as string);
    }

    // 第 4 个：帽拒绝（响亮 + 指路，不排队）。
    const rejected = await spawnAgentBgTool.execute(
      { agentType: 'researcher', prompt: '超帽任务' },
      ctx,
    );
    expect(rejected.metadata).toMatchObject({ ok: false, reason: 'bg-capacity' });
    expect(String(rejected.output)).toContain('上限');

    // 清场：取消三个挂起任务（防 afterEach 后悬挂 promise 拖尾）。
    for (const taskId of handles) {
      expect(registry.cancel(taskId).ok).toBe(true);
    }
  });

  it('bg_task_result / bg_task_cancel 工具：claim 语义 + 作用域收窄（他会话任务不可见）', async () => {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const { bgTaskResultTool, bgTaskCancelTool, bgTasksStatusTool } = await import('../src/tool/bg-task-tools');
    const registry = getBgTaskRegistry();
    const generate = vi.fn<ProviderGenerate>(async () => ({ content: '后台产出', finishReason: 'stop' }));
    const runtime = createWorkflowRuntime({ generate });
    const parent = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });
    const other = runtime.createSession({ agentName: 'writer', projectPath, permissionMode: 'auto' });

    const handle = runtime.runSubagentBackground(parent.id, 'researcher', '查证任务');
    const ctx = { sessionId: parent.id, projectPath, abort: new AbortController().signal };
    const otherCtx = { sessionId: other.id, projectPath, abort: new AbortController().signal };

    // 作用域收窄：他 leader 会话按「找不到」处理（不泄露不误动）。
    await expect(bgTaskResultTool.execute({ taskId: handle.taskId }, otherCtx)).resolves.toMatchObject({
      metadata: { ok: false, reason: 'not-found' },
    });
    await expect(bgTaskCancelTool.execute({ taskId: handle.taskId }, otherCtx)).resolves.toMatchObject({
      metadata: { ok: false, reason: 'not-found' },
    });

    // running 态领取 → 如实告知仍在跑（不假结果）。
    await expect(bgTaskResultTool.execute({ taskId: handle.taskId }, ctx)).resolves.toMatchObject({
      metadata: { ok: false, reason: 'running' },
    });

    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('completed');
    });
    const claimed = await bgTaskResultTool.execute({ taskId: handle.taskId }, ctx);
    expect(String(claimed.output)).toContain('后台产出');
    expect(registry.get(handle.taskId)?.claimed).toBe(true);

    // bg_tasks_status：列出本会话名下任务（含 claimed 标记）。
    const status = await bgTasksStatusTool.execute({}, ctx);
    expect(String(status.output)).toContain(handle.taskId);
    expect(String(status.output)).toContain('已完成');
    // 其他会话视角：空列表。
    const otherStatus = await bgTasksStatusTool.execute({}, otherCtx);
    expect(String(otherStatus.output)).toContain('没有后台任务');

    // cancel 工具：已完成任务 → 类型化 already-terminal 文案。
    await expect(bgTaskCancelTool.execute({ taskId: handle.taskId }, ctx)).resolves.toMatchObject({
      metadata: { ok: false, reason: 'already-terminal' },
    });
  });
});
