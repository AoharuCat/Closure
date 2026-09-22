import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BgTaskOutcome } from '../src/runtime/bgTasks';

// ─────────────────────────────────────────────────────────────────────────────
// 09-21-subagent-bg-decouple W1：BgTaskRegistry 单元测试（design §1.1 / §4.2）。
//
// 覆盖：dispatch 立返 + 终态回写 + running 行先落盘 / 容量帽（响亮拒绝不排队）/ cancel 语义
// （类型化 already-terminal）/ 删除级联（parent / project）/ 终态保留帽 LRU 淘汰（CR 反哺 09-22 ②）
// / reconcileInterrupted 重启对账（running → interrupted + hydrate）/ 落盘三态 graceful。
// 纯记账层测试（launch 由测试桩提供，不涉 runLoop / LLM）——执行面见 runtime.bgDispatch.test.ts。
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 受控 outcome：测试桩 start 返回它，测试在时机成熟时 resolve 终态。 */
function deferredOutcome(): { promise: Promise<BgTaskOutcome>; resolve: (outcome: BgTaskOutcome) => void } {
  let resolve!: (outcome: BgTaskOutcome) => void;
  const promise = new Promise<BgTaskOutcome>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('bgTasks registry（09-21-subagent-bg-decouple W1）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-bg-tasks-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function diskRecords(): Array<Record<string, unknown>> {
    return JSON.parse(readFileSync(path.join(projectPath, '.orison', 'bg-tasks.json'), 'utf-8')) as Array<
      Record<string, unknown>
    >;
  }

  it('dispatchBg 立返句柄：running 行先落盘；终态回写 result + 磁盘镜像', async () => {
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    const outcome = deferredOutcome();

    const handle = registry.dispatchBg({
      parentSessionId: 'leader-1',
      projectPath,
      role: 'researcher',
      prompt: '查证某设定的出处',
      notify: 'toast',
      start: () => ({ childSessionId: 'child-1', outcome: outcome.promise }),
    });

    // 立返（<1s 契约的记账面）：taskId 形态 + running 同步可见。
    expect(handle.taskId).toMatch(/^bg_/);
    expect(handle).toMatchObject({ childSessionId: 'child-1', role: 'researcher', status: 'running' });
    expect(registry.get(handle.taskId)?.status).toBe('running');

    // 运行中先写 running 行（design §4.2——崩溃后 reconcile 才有据可标 interrupted）。
    expect(diskRecords()).toHaveLength(1);
    expect(diskRecords()[0]).toMatchObject({ taskId: handle.taskId, status: 'running' });

    // 终态回写：record 更新 + 磁盘镜像同步。
    outcome.resolve({ status: 'completed', content: '蒸馏报告' });
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('completed');
    });
    expect(registry.get(handle.taskId)?.result?.content).toBe('蒸馏报告');
    expect(diskRecords()[0]).toMatchObject({ status: 'completed' });
    expect((diskRecords()[0].result as { content: string }).content).toBe('蒸馏报告');
    // prompt digest：首 120 字截断（全量 prompt 不入注册表）。
    expect(registry.get(handle.taskId)?.promptDigest).toBe('查证某设定的出处');
  });

  it('容量帽 MAX_BG_PER_PROJECT：第 4 个响亮拒绝（BgCapacityError），一个终态后放行', async () => {
    const { getBgTaskRegistry, BgCapacityError, MAX_BG_PER_PROJECT } = await import('../src/runtime/bgTasks');
    expect(MAX_BG_PER_PROJECT).toBe(3);
    const registry = getBgTaskRegistry();
    const outcomes = [deferredOutcome(), deferredOutcome(), deferredOutcome()];
    const startBy = (outcome: Promise<BgTaskOutcome>) => () => ({
      childSessionId: `child-${Math.random()}`,
      outcome,
    });

    for (const o of outcomes) {
      registry.dispatchBg({
        parentSessionId: 'leader-1',
        projectPath,
        role: 'researcher',
        prompt: '任务',
        notify: 'toast',
        start: startBy(o.promise),
      });
    }

    // 第 4 个：类型化拒绝（不排队，V1）。
    expect(() =>
      registry.dispatchBg({
        parentSessionId: 'leader-1',
        projectPath,
        role: 'researcher',
        prompt: '任务',
        notify: 'toast',
        start: startBy(Promise.resolve({ status: 'completed', content: '' })),
      }),
    ).toThrow(BgCapacityError);

    // 一个终态 → 放行。
    outcomes[0].resolve({ status: 'completed', content: 'ok' });
    await vi.waitFor(() => {
      expect(registry.listByProject(projectPath).filter((r) => r.status === 'running')).toHaveLength(2);
    });
    const handle = registry.dispatchBg({
      parentSessionId: 'leader-1',
      projectPath,
      role: 'researcher',
      prompt: '任务',
      notify: 'toast',
      start: startBy(Promise.resolve({ status: 'completed', content: 'ok' })),
    });
    expect(handle.status).toBe('running');
  });

  it('cancel 语义：running 可取消（信号触发 + 终态回写）；终态/未知任务类型化错误', async () => {
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    const outcome = deferredOutcome();
    let startSignal: AbortSignal | undefined;
    const handle = registry.dispatchBg({
      parentSessionId: 'leader-1',
      projectPath,
      role: 'researcher',
      prompt: '长任务',
      notify: 'toast',
      start: ({ signal }) => {
        startSignal = signal;
        return { childSessionId: 'child-1', outcome: outcome.promise };
      },
    });

    expect(registry.cancel('bg_unknown')).toEqual({ ok: false, reason: 'not-found' });

    expect(registry.cancel(handle.taskId)).toEqual({ ok: true });
    // 取消通道 = registry 持有的 AbortController（dispatchBackground 经 beginRun 链入 store）。
    expect(startSignal?.aborted).toBe(true);

    // 终态由 outcome 链回写（cancel 本身不改状态——避免与 runLoop 真实终态竞态双写）。
    expect(registry.get(handle.taskId)?.status).toBe('running');
    outcome.resolve({ status: 'aborted' });
    await vi.waitFor(() => {
      expect(registry.get(handle.taskId)?.status).toBe('aborted');
    });

    // 已终态任务再取消 → 类型化 already-terminal（AC：响亮不做 no-op）。
    expect(registry.cancel(handle.taskId)).toEqual({ ok: false, reason: 'already-terminal' });
  });

  it('级联杀：cancelBgTasksForParent 只杀该 leader 名下；cancelBgTasksForProject 兜项目全杀', async () => {
    const { getBgTaskRegistry, cancelBgTasksForParent, cancelBgTasksForProject } = await import(
      '../src/runtime/bgTasks'
    );
    const registry = getBgTaskRegistry();
    // 桩 launch：cancel 后需 resolve aborted（真系统里由 child runLoop 的 abort 终态走这条）。
    const hanging = () => {
      const d = deferredOutcome();
      return {
        resolve: d.resolve,
        start: () => ({ childSessionId: `child-${Math.random()}`, outcome: d.promise }),
      };
    };
    const a1 = hanging();
    const a2 = hanging();
    const b1 = hanging();
    registry.dispatchBg({ parentSessionId: 'A', projectPath, role: 'r', prompt: 'x', notify: 'toast', start: a1.start });
    registry.dispatchBg({ parentSessionId: 'A', projectPath, role: 'r', prompt: 'x', notify: 'toast', start: a2.start });
    registry.dispatchBg({ parentSessionId: 'B', projectPath, role: 'r', prompt: 'x', notify: 'toast', start: b1.start });

    expect(cancelBgTasksForParent('A')).toBe(2);
    a1.resolve({ status: 'aborted' });
    a2.resolve({ status: 'aborted' });
    await vi.waitFor(() => {
      expect(registry.listByParent('A').every((r) => r.status !== 'running')).toBe(true);
    });
    // 他会话名下不受波及。
    expect(registry.listByParent('B')[0]?.status).toBe('running');

    // 项目级（W3 shell 项目关闭钩子消费的能力面）。
    expect(cancelBgTasksForProject(projectPath)).toBe(1);
    b1.resolve({ status: 'aborted' });
    await vi.waitFor(() => {
      expect(registry.listByProject(projectPath).every((r) => r.status !== 'running')).toBe(true);
    });
  });

  it('终态保留帽 LRU 淘汰（CR 反哺 ② + CR-2 修订）：未领永不淘汰；已领池内 LRU；全未领超帽全保', async () => {
    const { getBgTaskRegistry, BG_TASK_RECORD_CAP } = await import('../src/runtime/bgTasks');
    expect(BG_TASK_RECORD_CAP).toBe(10);
    const registry = getBgTaskRegistry();

    // 一个长跑 running 先行——验证保留帽不波及活跃记录。
    const runningOutcome = deferredOutcome();
    const runningHandle = registry.dispatchBg({
      parentSessionId: 'leader-1',
      projectPath,
      role: 'runner',
      prompt: '还在跑',
      notify: 'toast',
      start: () => ({ childSessionId: 'child-running', outcome: runningOutcome.promise }),
    });

    // 12 个终态，间隔 60ms 保证 updatedAt 单调可判（CR-17：5ms 间距在并行负载下同毫秒塌缩
    // ——淘汰序不稳；60ms ≥ 50ms 阈值）。
    const allIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const handle = registry.dispatchBg({
        parentSessionId: 'leader-1',
        projectPath,
        role: 'worker',
        prompt: `任务 ${i}`,
        notify: 'toast',
        start: () => ({
          childSessionId: `child-${i}`,
          outcome: Promise.resolve({ status: 'completed' as const, content: `结果 ${i}` }),
        }),
      });
      allIds.push(handle.taskId);
      await sleep(60);
    }
    await vi.waitFor(() => {
      expect(registry.get(allIds[11])?.status).toBe('completed');
    });

    // CR-2：全部未领取 → 溢出 2 条**不淘汰**（「结果不丢」优先于帽），仅超帽保留。
    let kept = registry.listByProject(projectPath);
    expect(kept).toHaveLength(13); // 12 completed（全保）+ 1 running
    expect(allIds.every((id) => registry.get(id) !== undefined)).toBe(true);
    expect(registry.get(runningHandle.taskId)?.status).toBe('running');

    // claim 最早的 3 条（claim 时序 = updatedAt 刷新序，淘汰池内 LRU 可判）→ 每次 persist
    // 淘汰已领池中最老者直至帽内：claim 第 1 条淘汰它自身（唯一已领），claim 第 2 条同理，
    // 第 3 条入帽内不再淘汰。未领取的 9 条全程保留。
    for (const id of allIds.slice(0, 3)) {
      expect(registry.markClaimed(id).ok).toBe(true);
      // claim 是同步记账 + 同步 persist——断言直接跟在后面（waitFor 防未来异步化）。
      expect(registry.listByProject(projectPath).length).toBeLessThanOrEqual(12);
    }
    kept = registry.listByProject(projectPath);
    expect(kept).toHaveLength(11); // 10 帽内 + 1 running
    expect(kept.some((r) => r.taskId === runningHandle.taskId && r.status === 'running')).toBe(true);
    // 未领取的 9 条全数保留（claimed !== true 永不淘汰）。
    expect(allIds.slice(3).every((id) => registry.get(id) !== undefined)).toBe(true);
    // 已领的前 2 条被淘汰（已领池内最老先出），第 3 条（最新已领）保留。
    expect(registry.get(allIds[0])).toBeUndefined();
    expect(registry.get(allIds[1])).toBeUndefined();
    expect(registry.get(allIds[2])).toBeDefined();

    // 磁盘与内存同帽不漂移。
    const disk = diskRecords();
    expect(disk).toHaveLength(11);
    expect(disk.some((r) => r.taskId === runningHandle.taskId)).toBe(true);
  });

  it('看门狗（CR-6）：超时无终态 → settle failed 释放槽位；迟到真终态 last-write-wins 覆写', async () => {
    const { getBgTaskRegistry, MAX_BG_PER_PROJECT, BG_TASK_TIMEOUT_MS } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    vi.useFakeTimers();
    try {
      const d = deferredOutcome();
      const handle = registry.dispatchBg({
        parentSessionId: 'leader-1',
        projectPath,
        role: 'stuck-runner',
        prompt: '悬挂任务',
        notify: 'toast',
        start: () => ({ childSessionId: 'child-wd', outcome: d.promise }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.get(handle.taskId)?.status).toBe('running');

      // 推进到看门狗线：强制 settle failed（槽位释放——容量帽检查放行新任务）。
      await vi.advanceTimersByTimeAsync(BG_TASK_TIMEOUT_MS + 1);
      expect(registry.get(handle.taskId)?.status).toBe('failed');
      expect(registry.get(handle.taskId)?.error).toContain('超时');
      // 槽位已释放：再派 MAX_BG_PER_PROJECT 个不撞帽。
      for (let i = 0; i < MAX_BG_PER_PROJECT; i++) {
        expect(() =>
          registry.dispatchBg({
            parentSessionId: 'leader-1',
            projectPath,
            role: 'r',
            prompt: '新任务',
            notify: 'toast',
            start: () => ({ childSessionId: `child-wd-new-${i}`, outcome: Promise.resolve({ status: 'completed' as const }) }),
          }),
        ).not.toThrow();
      }

      // 迟到真终态（看门狗 abort 后 runLoop 收敛 aborted）→ last-write-wins 如实覆写。
      d.resolve({ status: 'aborted' });
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.get(handle.taskId)?.status).toBe('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('CR-7 路径归一：大小写/分隔符漂移的项目路径 listByProject / cancelBgTasksForProject 同样命中', async () => {
    const { getBgTaskRegistry, cancelBgTasksForProject } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    const d = deferredOutcome();
    // 登记用「漂移形态」（win32 大写 + 正斜杠；posix 尾斜杠）——查询用原始 tmpdir 形态。
    const drifted =
      process.platform === 'win32'
        ? `${projectPath.toUpperCase().replace(/\\/g, '/')}`
        : `${projectPath}/`;
    registry.dispatchBg({
      parentSessionId: 'leader-7',
      projectPath: drifted,
      role: 'r',
      prompt: 'x',
      notify: 'silent',
      start: () => ({ childSessionId: 'child-7', outcome: d.promise }),
    });
    expect(registry.listByProject(projectPath)).toHaveLength(1);
    expect(cancelBgTasksForProject(projectPath)).toBe(1);
    d.resolve({ status: 'aborted' });
  });

  it('reconcileInterrupted：磁盘 running 行改 interrupted 回写 + 全量 hydrate；读失败不热覆写', async () => {
    const { getBgTaskRegistry, saveBgTaskRecords } = await import('../src/runtime/bgTasks');
    saveBgTaskRecords(projectPath, [
      {
        taskId: 'bg_old-running',
        parentSessionId: 'leader-1',
        childSessionId: 'child-1',
        role: 'researcher',
        projectPath,
        promptDigest: '重启时还在跑',
        status: 'running',
        startedAt: 1,
        updatedAt: 2,
        notify: 'toast',
      },
      {
        taskId: 'bg_old-done',
        parentSessionId: 'leader-1',
        childSessionId: 'child-2',
        role: 'researcher',
        projectPath,
        promptDigest: '重启前已完成',
        status: 'completed',
        startedAt: 1,
        updatedAt: 2,
        notify: 'silent',
        result: { content: '历史结果' },
      },
    ]);

    const registry = getBgTaskRegistry();
    const interrupted = registry.reconcileInterrupted(projectPath);

    // in-flight 标 interrupted（不复活不谎报 running），终态照常可读（hydrate 进内存）。
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ taskId: 'bg_old-running', status: 'interrupted' });
    expect(interrupted[0].error).toContain('应用重启');
    expect(registry.get('bg_old-running')?.status).toBe('interrupted');
    expect(registry.get('bg_old-done')).toMatchObject({ status: 'completed', result: { content: '历史结果' } });
    // 磁盘回写同步翻转。
    expect(diskRecords().find((r) => r.taskId === 'bg_old-running')?.status).toBe('interrupted');

    // 幂等：二次对账零新增。
    expect(registry.reconcileInterrupted(projectPath)).toHaveLength(0);

    // 读失败（损坏文件）→ 不回写不动文件（CR-008：瞬时不可读不热覆写丢账）。
    writeFileSync(path.join(projectPath, '.orison', 'bg-tasks.json'), '{broken', 'utf-8');
    expect(registry.reconcileInterrupted(projectPath)).toHaveLength(0);
    expect(readFileSync(path.join(projectPath, '.orison', 'bg-tasks.json'), 'utf-8')).toBe('{broken');
  });

  it('markClaimed：completed 可领（幂等）；running/未知类型化错误', async () => {
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    const done = deferredOutcome();
    const doneHandle = registry.dispatchBg({
      parentSessionId: 'leader-1',
      projectPath,
      role: 'researcher',
      prompt: 'x',
      notify: 'toast',
      start: () => ({ childSessionId: 'child-1', outcome: done.promise }),
    });
    done.resolve({ status: 'completed', content: '结果' });
    await vi.waitFor(() => {
      expect(registry.get(doneHandle.taskId)?.status).toBe('completed');
    });

    expect(registry.markClaimed(doneHandle.taskId)).toMatchObject({ ok: true, alreadyClaimed: false });
    // 幂等：重复领取不报错（bg_task_result 重复查询面友好）。
    expect(registry.markClaimed(doneHandle.taskId)).toMatchObject({ ok: true, alreadyClaimed: true });
    expect(registry.get(doneHandle.taskId)?.claimed).toBe(true);

    expect(registry.markClaimed('bg_unknown')).toEqual({ ok: false, reason: 'not-found' });

    const runningOutcome = deferredOutcome();
    const runningHandle = registry.dispatchBg({
      parentSessionId: 'leader-1',
      projectPath,
      role: 'researcher',
      prompt: 'y',
      notify: 'toast',
      start: () => ({ childSessionId: 'child-2', outcome: runningOutcome.promise }),
    });
    expect(registry.markClaimed(runningHandle.taskId)).toEqual({ ok: false, reason: 'not-completed' });
  });

  it('落盘三态 graceful：无文件 [] / 损坏 null / 坏条目单独丢', async () => {
    const { loadBgTaskRecords } = await import('../src/runtime/bgTasks');
    const { mkdirSync } = await import('node:fs');
    const filePath = path.join(projectPath, '.orison', 'bg-tasks.json');
    mkdirSync(path.join(projectPath, '.orison'), { recursive: true });

    // 无文件 → []（合法「从未派发」）。
    expect(loadBgTaskRecords(projectPath)).toEqual([]);

    // 损坏 → null（caller 拒绝覆写）。
    writeFileSync(filePath, 'not-json', 'utf-8');
    expect(loadBgTaskRecords(projectPath)).toBeNull();

    // 坏条目单独丢不全丢（per-element filter，mirror batch-state）。
    writeFileSync(
      filePath,
      JSON.stringify([
        { taskId: 'bg_good', parentSessionId: 'p', childSessionId: 'c', role: 'r', projectPath, promptDigest: 'd', status: 'completed', startedAt: 1, updatedAt: 2, notify: 'toast' },
        { totally: 'malformed' },
      ]),
      'utf-8',
    );
    const records = loadBgTaskRecords(projectPath);
    expect(records).toHaveLength(1);
    expect(records![0].taskId).toBe('bg_good');
  });

  it('existsSync 防御：未派发过 → 磁盘无文件（惰性建）', async () => {
    const { getBgTaskRegistry } = await import('../src/runtime/bgTasks');
    const registry = getBgTaskRegistry();
    expect(registry.listByProject(projectPath)).toEqual([]);
    expect(existsSync(path.join(projectPath, '.orison', 'bg-tasks.json'))).toBe(false);
  });
});
